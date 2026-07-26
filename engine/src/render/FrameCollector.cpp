#include "FrameCollector.h"
#include "AnimationManager.h"

#include "model/Timeline.h"
#include "model/ClipVideoModulationTiming.h"
#include "model/ClipCompanionFxBuilder.h"
#include "model/ClipModulationCompatibility.h"
#include "SyncManager.h"     // VideoEvent

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <unordered_set>

namespace {

bool isVideoModulationCompatible(const VideoEvent& event) noexcept
{
    return event.hasClipModulation
        && xleth::clipmod::isClipModulationCompatible(
               event.clipReversed,
               event.clipStretchRatio,
               event.clipFormantPreserve,
               event.modulation);
}

xleth::clipmod::VideoModulationTimingContext makeVideoTimingContext(
    const VideoEvent& event,
    double beatPos,
    double bpm,
    int sampleRate,
    double sourceFps) noexcept
{
    const double safeBpm = (bpm > 0.0 && std::isfinite(bpm)) ? bpm : 140.0;
    const double timelineSeconds = beatPos * (60.0 / safeBpm);
    const int64_t timelineSamples = sampleRate > 0
        ? static_cast<int64_t>(std::llround(timelineSeconds * sampleRate))
        : int64_t{0};
    const double beatsSinceStart = beatPos - event.startBeat;
    const double clipLocalSeconds = beatsSinceStart * (60.0 / safeBpm);
    const int64_t clipLocalSamples = clipLocalSeconds > 0.0 && sampleRate > 0
        ? static_cast<int64_t>(std::llround(clipLocalSeconds * sampleRate))
        : int64_t{0};

    xleth::clipmod::VideoModulationTimingContext ctx;
    ctx.bpm = safeBpm;
    ctx.sampleRate = sampleRate > 0 ? static_cast<double>(sampleRate) : 48000.0;
    ctx.timelineSeconds = timelineSeconds;
    ctx.timelineBeats = beatPos;
    ctx.timelineSamples = timelineSamples;
    ctx.clipLocalSeconds = clipLocalSeconds;
    ctx.clipLocalBeats = beatsSinceStart;
    ctx.clipLocalSamples = clipLocalSamples;
    ctx.clipDurationSeconds = event.durationBeats * (60.0 / safeBpm);
    ctx.clipDurationBeats = event.durationBeats;
    ctx.sourceStartTime = event.sourceStartTime;
    ctx.sourceClampStartTime = event.sourceClampStartTime;
    ctx.sourceEndTime = event.sourceEndTime;
    ctx.sourceFps = sourceFps;
    // F.1: mirror MixEngine + SyncManager post-cache routing so export-time video
    // source-time matches the audio readhead. Cache buffer bakes in static pitch
    // for time-stretched OR formant-preserved (with pitch/stretch) clips, so zero
    // the static pitch here. (Same global-formant caveat as SyncManager — the raw
    // clip flag is used; the project-global toggle is not yet in VideoEvent.)
    const bool clipCacheProcessed =
        event.clipPitchOffsetSemis != 0
        || event.clipPitchOffsetCents != 0
        || event.clipStretchRatio != 1.0
        || event.clipReversed;
    const bool postCacheStretchedModulation =
        !event.clipReversed
        && clipCacheProcessed
        && (event.clipStretchRatio != 1.0 || event.clipFormantPreserve);
    ctx.clipPitchOffsetSemis = postCacheStretchedModulation ? 0 : event.clipPitchOffsetSemis;
    ctx.clipPitchOffsetCents = postCacheStretchedModulation ? 0 : event.clipPitchOffsetCents;
    ctx.clipStartTimelineSamples = event.clipStartTimelineSamples;
    return ctx;
}

// Companion-FX snapshot construction has moved to
// model/ClipCompanionFxBuilder.cpp so the realtime OpenGL preview path
// (SyncManager) and this export path produce the same snapshot from the
// same evaluator outputs.

} // namespace

// ===========================================================================
// Step 1: Collect requests for one output frame
// ===========================================================================

std::vector<CellFrameRequest> FrameCollector::collectRequests(
    int64_t                        outputFrameIndex,
    const Timeline&                timeline,
    int                            sampleRate,
    AVRational                     fps,
    const std::vector<VideoEvent>& events,
    bool                           allowProxy,
    int64_t                        projectStartSample,
    bool                           posterMode,
    const std::unordered_map<int, std::string>* renderProxyBySource,
    const GridLayout*              layoutOverride,
    bool                           applyPreviewEffectMute)
{
    const double bpm = timeline.getBPM();

    // Output frame indices stay local to the export / preview starting at 0.
    // Project sampling must instead happen at the matching absolute timeline
    // sample so subrange exports look up the same visual state as audio.
    const int64_t localFrameSample = RenderClock::videoFrameToSample(
        outputFrameIndex, sampleRate, fps);
    const int64_t projectFrameSample = projectStartSample + localFrameSample;
    const int64_t projectFramePpq = RenderClock::sampleToPPQ(
        projectFrameSample, sampleRate, bpm);
    const double ticksPerBeat = static_cast<double>(TickTime::fromBeats(1).ticks);
    const double beatPos = static_cast<double>(projectFramePpq) / ticksPerBeat;

    // Time-based snapshot resolution — RENDER PATH ONLY. Editing reads stay on the
    // active snapshot (Timeline::getGridLayout); the render/export path instead
    // resolves the grid arrangement for THIS frame's absolute project tick, so a
    // cue timeline can switch snapshots over time. Returned BY VALUE: a self-
    // contained GridLayout this thread owns, never an alias into the editor's
    // active-snapshot cache. Global canvas/previewFps fields are identical to the
    // active layout regardless of tick.
    //
    // Snapshot-transition override: when layoutOverride is non-null the caller
    // forces a SPECIFIC snapshot's arrangement (outgoing A or incoming B) for this
    // frame while event timing above still follows the frame's absolute tick. Copy
    // by value so this thread owns the arrangement outright, exactly like the
    // gridLayoutAt result — never an alias into a live GridCue/GridSnapshot the
    // caller might mutate between the two transition composites.
    const GridLayout layout = layoutOverride
        ? *layoutOverride
        : timeline.gridLayoutAt(TickTime{ projectFramePpq });

    std::vector<CellFrameRequest> requests;
    int gapsSkipped = 0;

    // Helper lambda to build a CellFrameRequest from an active event
    auto buildRequest = [&](const VideoEvent* ev, int trackId,
                            int cellCol, int cellRow, int spanX, int spanY,
                            float slotOpacity, int zOrder,
                            CellLayerKind kind) -> bool
    {
        if (!ev) return false;

        // Look up source to get file path and fps
        const SourceMedia* src = timeline.getSource(ev->sourceId);
        if (!src || !src->hasVideo || src->filePath.empty()) return false;

        const auto timingCtx = makeVideoTimingContext(
            *ev, beatPos, bpm, sampleRate, src->fps);
        const auto timing = xleth::clipmod::evaluateVideoClipModulationTiming(
            ev->modulation, timingCtx, isVideoModulationCompatible(*ev));

        double sourceTime = timing.sourceTimeSeconds;
        int64_t srcFrame = computeSourceFrameFromTime(sourceTime, src->fps);

        // Fetch TrackInfo early — needed to check pingPong.enabled before the clamp.
        const TrackInfo* trk = timeline.getTrack(trackId);
        const bool isFullscreen = (kind != CellLayerKind::Grid);

        CellFrameRequest req;
        if (companionFxEnabled_)
            req.companionFx = xleth::clipmod::buildClipCompanionFxSnapshot(ev->modulation, timing);

        // Ping-pong overrides the hold-last-frame clamp for enabled tracks.
        if (trk && trk->pingPong.enabled && !isFullscreen) {
            int64_t secondaryFrame = -1;
            float   blendFactor    = 0.0f;
            srcFrame = computePingPongFrame(*ev, beatPos, bpm, sampleRate, src->fps,
                                            trk->pingPong, secondaryFrame, blendFactor);
            req.pingPongSecondaryFrame = secondaryFrame;
            req.pingPongBlendFactor    = blendFactor;
            // Ping-pong owns boundary handling — skip the hold-last-frame clamp below.
        } else {
            // Hold-last-frame: if the computed source time exceeds the trim end,
            // always clamp to the last frame so active notes never go black.
            if (ev->sourceEndTime > 0.0) {
                if (sourceTime >= ev->sourceEndTime) {
                    srcFrame = computeSourceFrameFromTime(sourceTime, src->fps);
                    std::fprintf(stderr, "[FrameCollector] Track %d: frame clamped to last frame %lld "
                                 "(source time %.3fs >= trim end %.3fs)\n",
                                 trackId, (long long)srcFrame, sourceTime, ev->sourceEndTime);
                }
            }
        }

        req.cellCol          = cellCol;
        req.cellRow          = cellRow;
        req.spanX            = spanX;
        req.spanY            = spanY;

        // Proxy selection priority:
        //   1. Per-region (quote) proxy when one is ready and the current
        //      source time lands inside [proxyStartTime, proxyEndTime).
        //      Frame index must be recomputed against the proxy's time 0.
        //   2. Legacy source-wide proxy (kept for projects that still have
        //      one on disk; new sessions stop generating them).
        //   3. Original source file.
        // Chorus/Crash paths skip the region-proxy lookup entirely — those
        // cells intentionally stream the original for longer reads.
        //
        // Proxy substitution is intentionally PREVIEW-ONLY (allowProxy=true).
        // Editor seeking depends on the half-res DNxHR LB proxy to hit
        // interactive frame rates (Phase 0 perf floor). For final export the
        // caller passes allowProxy=false so the encoder receives original-
        // source pixels — anything less makes CRF/bitrate settings operate on
        // already-degraded input and the user cannot recover quality.
        // ── Swapped-video regions ────────────────────────────────────────────
        // A region whose video stream was rebound by video_swapRegionVideo
        // renders its REPLACEMENT file — src->filePath is no longer the pixels
        // this cell should show. Every substitute below that is derived from the
        // source (whole-source preview proxy, legacy source-wide proxy, poster /
        // per-cell thumbnails, render-plan proxy) is a proxy OF THE ORIGINAL and
        // is therefore invalid for such a region: engaging one silently renders
        // the pre-swap video. Only the per-region proxy carries the replacement's
        // pixels, so for a swapped region it is the ONLY legal substitution.
        //
        // The replacement file itself is the base pick (not src->filePath) so a
        // region whose proxy has not landed yet — or whose proxy failed — still
        // shows the right video instead of silently falling back to the original.
        // Its time base matches the region proxy's: file time 0 == the region's
        // startTime (see the swapped-video re-anchor in drainProxyResults).
        const SampleRegion* pickRegion =
            ev->regionId > 0 ? timeline.getRegion(ev->regionId) : nullptr;
        const bool regionSwapped = pickRegion && pickRegion->hasSwappedVideo
                                   && !pickRegion->swappedVideoPath.empty();

        std::string pickedPath  = regionSwapped ? pickRegion->swappedVideoPath
                                                : src->filePath;
        int64_t     pickedFrame = regionSwapped
            ? computeSourceFrameFromTime(sourceTime - pickRegion->startTime, src->fps)
            : srcFrame;

        // ── RENDER PATH: resolution-aware proxy plan (authoritative) ──────────
        // When a render plan is supplied it fully owns the source-vs-proxy choice
        // for every element (grid + fullscreen). A non-empty mapped path is a
        // footprint-sized whole-source proxy (frame index 1:1); a missing/empty
        // entry means decode the ORIGINAL. This deliberately bypasses ALL the
        // preview substitution below (region/legacy/preview proxy, poster). Gated
        // by allowProxy so the full-quality override (allowProxy=false) still
        // delivers bit-exact original pixels to the encoder.
        if (renderProxyBySource) {
            // Authoritative render plan — no preview substitution. The plan is
            // keyed by sourceId, so its proxy is a proxy of the ORIGINAL file and
            // must not be engaged for a swapped-video region (see above).
            if (allowProxy && !regionSwapped) {
                auto it = renderProxyBySource->find(ev->sourceId);
                if (it != renderProxyBySource->end() && !it->second.empty()) {
                    pickedPath  = it->second;
                    pickedFrame = srcFrame;   // whole-source proxy: 1:1 frame map
                }
                // else: leave pickedPath = original source.
            }
        } else {
            // ── PREVIEW PATH substitution ladder ──────────────────────────────
            if (allowProxy && ev->regionId > 0 && !isFullscreen) {
                const SampleRegion* r = pickRegion;
                if (r && r->proxyReady && !r->proxyPath.empty()) {
                    if (sourceTime >= r->proxyStartTime &&
                        sourceTime <  r->proxyEndTime) {
                        pickedPath  = r->proxyPath;
                        pickedFrame = computeSourceFrameFromTime(
                                          sourceTime - r->proxyStartTime, src->fps);
                    }
                }
            }

            // Legacy source-wide proxy fallback
            if (allowProxy && pickedPath == src->filePath &&
                src->proxyReady && !src->proxyPath.empty()) {
                pickedPath = src->proxyPath;
            }

            // ── Whole-source preview proxy (PREVIEW-ONLY) ─────────────────────
            // The primary preview path: ONE small all-intra proxy of the ENTIRE
            // source, used for ALL cells — grid AND fullscreen/backdrop. Every
            // source frame is kept at the source fps, so the frame index maps 1:1
            // (no time-base remap like the region proxy). Random access into the
            // small intra proxy is a cheap exact seek, so LIVE preview stays smooth
            // even when scrubbing into previously-unvisited regions. This
            // supersedes the region/legacy proxy pick above.
            // ── Poster fast-preview pick (PREVIEW-ONLY) ───────────────────────
            // When the user explicitly selects Poster mode, a cached static frame
            // is the AUTHORITATIVE pick and must WIN over the whole-source preview
            // proxy. Binding one resident single-frame texture per cell is what
            // makes poster mode faster than live: requests dedupe per distinct
            // (source,bucket) and the decode-miss loop stays empty after warm-up.
            //
            // PER-CELL semantics (Fix 2): each cell prefers its OWN thumbnail
            // decoded at this cell's source time-offset — keyed by the 1-second
            // bucket floor(sourceStartTime) — so a source reused across many cells
            // at different offsets shows a DIFFERENT frame per cell. The per-source
            // base poster (src->posterPath) is only a FALLBACK, shown until this
            // cell's own thumbnail is ready (or if its generation failed).
            //
            // ROOT CAUSE history: the poster used to be gated behind
            // `!previewProxyEngaged`, but the whole-source preview-proxy self-heal
            // runs even in poster mode, so as soon as a proxy existed it silently
            // superseded the poster and poster mode did NO poster work. Making
            // `previewProxyEngaged` yield to `posterEngaged` restores the intended
            // static-frame behaviour. The proxy remains the live fallback ONLY while
            // neither this cell's thumbnail nor the base poster is ready yet.
            // Posters and per-cell thumbnails are extracted from the ORIGINAL
            // source, so a swapped region must not bind one — it would show the
            // pre-swap frame. Such a cell stays on its region proxy / the
            // replacement file, which is live but always the correct video.
            std::string posterPick;
            if (posterMode && !regionSwapped) {
                const int bucket = static_cast<int>(
                    std::floor(std::max(0.0, ev->sourceStartTime)));
                auto it = src->thumbnailPaths.find(bucket);
                if (it != src->thumbnailPaths.end() && !it->second.empty())
                    posterPick = it->second;                 // this cell's own frame
                else if (src->posterReady && !src->posterPath.empty())
                    posterPick = src->posterPath;            // per-source fallback
            }
            const bool posterEngaged = !posterPick.empty();

            // The whole-source preview proxy is a proxy of src->filePath. It
            // supersedes the region proxy for ordinary regions (both hold the
            // same pixels, and the intra proxy scrubs faster) — but for a
            // swapped region it holds the PRE-SWAP video, so it must yield to
            // the region proxy exactly as it already yields to posterEngaged.
            const bool previewProxyEngaged =
                allowProxy && !posterEngaged && !regionSwapped
                && src->previewProxyReady && !src->previewProxyPath.empty();
            if (previewProxyEngaged) {
                pickedPath  = src->previewProxyPath;
                pickedFrame = srcFrame;
            }

            if (posterEngaged) {
                pickedPath  = posterPick;
                pickedFrame = 0;   // single-frame texture; index is irrelevant
            }
        }

        req.sourcePath       = pickedPath;
        req.sourceId         = ev->sourceId;
        req.sourceFrameIndex = pickedFrame;
        req.opacity          = std::min(1.0f, std::max(0.0f, slotOpacity * ev->opacity));
        // Flip v2: VideoFlipApplier already resolved stateIndex/orientation per
        // event during the build pass. The shader consumes `orientation` directly;
        // stateIndex is propagated for analytics/debug only.
        req.stateIndex  = ev->stateIndex;
        req.orientation = static_cast<int>(ev->orientation);
        {
            if (trk) {
                req.cornerRadius     = trk->cornerRadius;
                req.gapScaleOverride = trk->gapScaleOverride;
                // Preview-only eyedropper mute (see applyPreviewEffectMute doc):
                // export/transition callers never pass true, so this can never
                // suppress the chain during a render.
                const bool previewMuted = applyPreviewEffectMute
                    && timeline.isVisualEffectChainPreviewMuted(trk->id);
                if (!previewMuted && !trk->visualEffectChain.empty()) {
                    // Copy, not address-of — see the comment on
                    // CellFrameRequest::visualChain in FrameCollector.h
                    // (Bug 1 fix). Safe here specifically because this
                    // whole call runs under syncEventsMutex (eLock) in
                    // the caller's video-tick loop, which the visual-
                    // effect-chain mutation handlers now also acquire.
                    req.visualChain = trk->visualEffectChain;
                }
                // Note trigger detection: fire onNoteStart when globalNoteIndex
                // changes (grid cells only). VideoEvents are emitted only by
                // *normal* (non-slide) PatternNotes (slide notes flow through
                // SlideAnimationEvent and are skipped at note-build time), so
                // this is the right place to hook the NextNormalNote slide
                // visual return trigger — it covers both realtime preview and
                // offline render via the shared FrameCollector path.
                if (animationMgr_ && !isFullscreen) {
                    const CellAnimation* anim = animationMgr_->getAnimation(trackId);
                    if (!anim || ev->globalNoteIndex != anim->activeNoteId) {
                        animationMgr_->onSlideReturnTrigger(trackId);
                        animationMgr_->onNoteStart(trackId, ev->globalNoteIndex,
                                                   trk->zoomPanRot, trk->bounce);
                    }
                }
            }
        }

        // Populate animation state from AnimationManager
        if (animationMgr_) {
            const CellAnimation* anim = animationMgr_->getAnimation(trackId);
            if (anim) {
                req.currentZoom     = anim->currentZoom;
                req.currentPanX     = anim->currentPanX;
                req.currentPanY     = anim->currentPanY;
                req.currentRotDeg   = anim->currentRotDeg;
                req.bounceOffsetX   = anim->bounceOffsetX;
                req.bounceOffsetY   = anim->bounceOffsetY;
                req.bounceScaleX    = anim->bounceScaleX;
                req.bounceScaleY    = anim->bounceScaleY;
                req.tvRampIntensity = anim->tvRampIntensity;
                req.tvRampRollSpeed  = anim->tvRampRollSpeed;
                req.tvRampScanlines  = anim->tvRampScanlines;
                req.tvRampChroma     = anim->tvRampChroma;
                req.tvRampNoise      = anim->tvRampNoise;
                req.tvRampJitter     = anim->tvRampJitter;
                req.tvRampColorBleed = anim->tvRampColorBleed;
            }
        }

        req.trackId          = trackId;
        req.layerKind        = kind;
        req.zOrder           = zOrder;

        if (isFullscreen) {
            std::fprintf(stderr, "[FrameCollector] FS-%s cell: '%s' frame=%lld opacity=%.2f\n",
                         kind == CellLayerKind::FullscreenBehind ? "behind" : "front",
                         req.sourcePath.c_str(), (long long)req.sourceFrameIndex, req.opacity);
        }

        requests.push_back(std::move(req));
        return true;
    };

    // GC fullscreen hold-state map: keep entries only for tracks still
    // referenced by a BehindGrid layer. Bounds the map size to the live layer
    // count rather than every track ever assigned.
    {
        std::unordered_set<int> behindTrackIds;
        for (const auto& fl : layout.fullscreenLayers) {
            if (fl.placement == FullscreenLayerPlacement::BehindGrid && fl.trackId >= 0)
                behindTrackIds.insert(fl.trackId);
        }
        for (auto it = fullscreenHoldByTrack_.begin(); it != fullscreenHoldByTrack_.end(); ) {
            if (!behindTrackIds.count(it->first)) it = fullscreenHoldByTrack_.erase(it);
            else ++it;
        }
    }

    const int fullW = layout.columns * kGridSubUnitsPerColumn;
    const int fullH = layout.rows    * kGridSubUnitsPerRow;

    // ── Unified assembly ─────────────────────────────────────────────────────
    // Every video placement (grid cell AND fullscreen layer) is appended below
    // tagged with its own real, globally-comparable zOrder. The three sub-loops
    // exist only to gather the placements and preserve deterministic tie-break
    // order; the ACTUAL draw order is decided by the SINGLE stable_sort by zOrder
    // performed once at the end. There are no hardcoded sentinel zOrders anymore,
    // so a fullscreen layer whose zOrder sits between two grid cells' zOrders
    // sorts — and therefore renders — interleaved between them.

    // a) FULLSCREEN BEHIND LAYERS. Holds last frame during gaps when the track
    // has videoHoldLastFrame. zOrder is the layer's own global key.
    for (const auto& fl : layout.fullscreenLayers) {
        if (fl.placement != FullscreenLayerPlacement::BehindGrid) continue;
        if (fl.trackId < 0) continue;

        const VideoEvent* ev = findActiveEvent(events, timeline, fl.trackId, beatPos);
        if (buildRequest(ev, fl.trackId, 0, 0, fullW, fullH,
                         fl.opacity, fl.zOrder,
                         CellLayerKind::FullscreenBehind)) {
            // Active layer — record last frame for hold-through-gap
            const auto& r = requests.back();
            auto& s = fullscreenHoldByTrack_[fl.trackId];
            s.lastFrame       = r.sourceFrameIndex;
            s.lastPath        = r.sourcePath;
            s.lastOrientation = r.orientation;
            s.lastClipEndBeat = ev->startBeat + ev->durationBeats;
        } else {
            auto it = fullscreenHoldByTrack_.find(fl.trackId);
            const TrackInfo* trk = timeline.getTrack(fl.trackId);

            // Hold-expiry threshold. The stored value is already in BEATS and
            // beatPos is in beats, so this is a direct comparison — no PPQ
            // round-trip and no tempo lookup. Negative threshold = unlimited,
            // which short-circuits to the pre-threshold behavior untouched.
            //
            // Only reached once the clip has actually ended, so the hold still
            // fills a gap shorter than the threshold exactly as it did before.
            bool holdExpired = false;
            if (it != fullscreenHoldByTrack_.end() && trk
                && trk->videoHoldLastFrameThresholdBeats >= 0.0) {
                holdExpired = (beatPos - it->second.lastClipEndBeat)
                            > trk->videoHoldLastFrameThresholdBeats;
            }
            if (it != fullscreenHoldByTrack_.end() && it->second.lastFrame >= 0
                && trk && trk->videoHoldLastFrame
                && !holdExpired) {
                std::fprintf(stderr, "[FrameCollector] FS-behind gap (track %d): hold=ON frame=%lld\n",
                             fl.trackId, (long long)it->second.lastFrame);
                CellFrameRequest req;
                req.cellCol          = 0;
                req.cellRow          = 0;
                req.spanX            = fullW;
                req.spanY            = fullH;
                req.sourcePath       = it->second.lastPath;
                req.sourceFrameIndex = it->second.lastFrame;
                req.opacity          = std::min(1.0f, std::max(0.0f, fl.opacity));
                req.layerKind        = CellLayerKind::FullscreenBehind;
                req.zOrder           = fl.zOrder;
                req.orientation      = it->second.lastOrientation;
                req.trackId          = fl.trackId;
                requests.push_back(std::move(req));
            } else {
                ++gapsSkipped;
            }
        }
    }

    // b) GRID CELLS. Appended in layout.slots array order; the final stable_sort
    // orders them by zOrder while preserving array order for equal keys (exactly
    // the behavior of the old per-slot pre-sort, now folded into the one global
    // sort below).
    for (const GridSlot& slot : layout.slots) {
        if (slot.trackId < 0) { ++gapsSkipped; continue; }

        const VideoEvent* ev = findActiveEvent(events, timeline, slot.trackId, beatPos);
        if (!ev) { ++gapsSkipped; continue; }

        if (!buildRequest(ev, slot.trackId,
                          slot.gridX, slot.gridY, slot.spanX, slot.spanY,
                          slot.opacity, slot.zOrder, CellLayerKind::Grid)) {
            ++gapsSkipped;
        }
    }

    // c) FULLSCREEN IN-FRONT LAYERS. Transient; no hold-through-gap. zOrder is
    // the layer's own global key.
    for (const auto& fl : layout.fullscreenLayers) {
        if (fl.placement != FullscreenLayerPlacement::InFrontOfGrid) continue;
        if (fl.trackId < 0) continue;

        const VideoEvent* ev = findActiveEvent(events, timeline, fl.trackId, beatPos);
        if (!buildRequest(ev, fl.trackId, 0, 0, fullW, fullH,
                          fl.opacity, fl.zOrder,
                          CellLayerKind::FullscreenInFront)) {
            ++gapsSkipped;
        }
    }

    // ── THE single global compositing sort ───────────────────────────────────
    // One stable_sort over the complete request list (grid cells AND fullscreen
    // layers together) by their shared zOrder. stable_sort keeps assembly order
    // for equal keys, so: behind-vs-behind and front-vs-front keep array order,
    // grid-vs-grid keep slot array order, and on an exact tie between a fullscreen
    // layer and a grid cell the assembly order (behind < grid < front) breaks it
    // deterministically. The compositor then draws requests in this exact order.
    std::stable_sort(requests.begin(), requests.end(),
        [](const CellFrameRequest& a, const CellFrameRequest& b) {
            return a.zOrder < b.zOrder;
        });

    std::fprintf(stderr, "[FrameCollector] Collecting for output frame %lld: %d active cells, %d gaps skipped\n",
                 (long long)outputFrameIndex,
                 static_cast<int>(requests.size()),
                 gapsSkipped);

    return requests;
}

// ===========================================================================
// Step 2: Deduplicate
// ===========================================================================

std::map<FrameCacheKey, std::vector<CellFrameRequest*>>
FrameCollector::deduplicateRequests(std::vector<CellFrameRequest>& requests)
{
    std::map<FrameCacheKey, std::vector<CellFrameRequest*>> result;

    for (auto& req : requests) {
        FrameCacheKey key;
        key.sourcePath = req.sourcePath;
        key.frameIndex = req.sourceFrameIndex;
        result[key].push_back(&req);
    }

    // Also register secondary ping-pong frames so they are decoded alongside primary frames.
    // We insert with an empty pointer list — the compositor looks them up directly by key.
    for (auto& req : requests) {
        if (req.pingPongSecondaryFrame >= 0) {
            FrameCacheKey key2;
            key2.sourcePath = req.sourcePath;
            key2.frameIndex = req.pingPongSecondaryFrame;
            result[key2]; // default-construct empty vector if key is new
        }
    }

    std::fprintf(stderr, "[FrameCollector] Dedup: %d cell requests -> %d unique frames to decode\n",
                 static_cast<int>(requests.size()),
                 static_cast<int>(result.size()));

    return result;
}

// ===========================================================================
// Step 3: Resolve (cache check)
// ===========================================================================

std::vector<FrameCacheKey> FrameCollector::resolveFrames(
    const std::map<FrameCacheKey, std::vector<CellFrameRequest*>>& deduplicated,
    RenderFrameCache& cache)
{
    std::vector<FrameCacheKey> misses;
    int hits = 0;

    for (const auto& [key, cells] : deduplicated) {
        if (cache.get(key) != nullptr) {
            ++hits;
        } else {
            misses.push_back(key);
        }
    }

    std::fprintf(stderr, "[FrameCollector] Resolve: %d cache hits, %d decodes needed\n",
                 hits, static_cast<int>(misses.size()));

    // Detect sequential access patterns for the decoder hint.
    // If multiple misses are from the same source and their frame indices
    // form a contiguous run, flag it.
    if (misses.size() > 1) {
        std::unordered_map<std::string, std::vector<int64_t>> missFramesBySource;
        for (const auto& k : misses) {
            missFramesBySource[k.sourcePath].push_back(k.frameIndex);
        }
        for (auto& [path, frames] : missFramesBySource) {
            std::sort(frames.begin(), frames.end());
            bool sequential = true;
            for (size_t i = 1; i < frames.size(); ++i) {
                if (frames[i] - frames[i - 1] != 1) {
                    sequential = false;
                    break;
                }
            }
            if (sequential && frames.size() >= 2) {
                std::fprintf(stderr, "[FrameCollector] Sequential hint set for source '%s'\n",
                             path.c_str());
            }
        }
    }

    return misses;
}

// ===========================================================================
// Helpers
// ===========================================================================

const VideoEvent* FrameCollector::findActiveEvent(
    const std::vector<VideoEvent>& events,
    const Timeline&                timeline,
    int                            trackId,
    double                         beatPos)
{
    if (trackId < 0) return nullptr;

    // Check muted
    const TrackInfo* track = timeline.getTrack(trackId);
    if (track && track->muted) return nullptr;

    // Find the latest-starting active event on this track. Same-tick note-ons
    // (a chord) now all carry the same resolved flip state, so any member draws
    // an identical orientation — the tie-break just needs to be deterministic:
    // lowest pitch, then lowest emission order.
    const VideoEvent* best = nullptr;
    for (const auto& ev : events) {
        if (ev.trackId != trackId) continue;
        if (beatPos < ev.startBeat) continue;
        if (beatPos >= ev.startBeat + ev.durationBeats) continue;
        if (!best
            || ev.startBeat > best->startBeat
            || (ev.startBeat == best->startBeat
                && (ev.pitch < best->pitch
                    || (ev.pitch == best->pitch
                        && ev.originalEmissionOrder < best->originalEmissionOrder)))) {
            best = &ev;
        }
    }
    return best;
}

int64_t FrameCollector::computeSourceFrame(
    const VideoEvent& ev,
    double            beatPos,
    double            bpm,
    int               sampleRate,
    double            sourceFps)
{
    return computeSourceFrameFromTime(
        computeSourceTime(ev, beatPos, bpm, sampleRate, sourceFps),
        sourceFps);
}

double FrameCollector::computeSourceTime(
    const VideoEvent& ev,
    double            beatPos,
    double            bpm,
    int               sampleRate,
    double            sourceFps)
{
    const auto timingCtx = makeVideoTimingContext(
        ev, beatPos, bpm, sampleRate, sourceFps);
    const auto timing = xleth::clipmod::evaluateVideoClipModulationTiming(
        ev.modulation, timingCtx, isVideoModulationCompatible(ev));
    return timing.sourceTimeSeconds;
}

int64_t FrameCollector::computeSourceFrameFromTime(double sourceTimeSec, double sourceFps)
{
    // Convert source time to frame index using integer arithmetic via av_rescale.
    // sourceTime (seconds) → frame index = floor(sourceTime * fps)
    // We use av_rescale to stay in the integer domain:
    //   frame = av_rescale(sourceTimeUs, fps_num, fps_den * 1000000)
    // where sourceTimeUs = round(sourceTime * 1000000)
    const int64_t sourceTimeUs = static_cast<int64_t>(std::round(sourceTimeSec * 1000000.0));
    const int64_t fpsNum = static_cast<int64_t>(std::round(sourceFps * 1000.0));
    const int64_t fpsDen = 1000;

    // frame = sourceTimeUs * fpsNum / (fpsDen * 1000000)
    int64_t frame = av_rescale(sourceTimeUs, fpsNum, fpsDen * 1000000LL);
    if (frame < 0) frame = 0;

    return frame;
}

// ===========================================================================
// Ping-Pong frame computation
// ===========================================================================

int64_t FrameCollector::computePingPongFrame(
    const VideoEvent&       ev,
    double                  beatPos,
    double                  bpm,
    int                     sampleRate,
    double                  sourceFps,
    const PingPongSettings& pp,
    int64_t&                outSecondaryFrame,
    float&                  outBlendFactor)
{
    outSecondaryFrame = -1;
    outBlendFactor    = 0.0f;

    double sourceTime = computeSourceTime(ev, beatPos, bpm, sampleRate, sourceFps);

    const double clipLen = ev.sourceEndTime - ev.sourceStartTime;
    if (clipLen <= 0.0)
        return computeSourceFrameFromTime(sourceTime, sourceFps);

    const double regionStart = ev.sourceStartTime + clipLen * pp.regionStartPct;
    const double regionLen   = clipLen * (pp.regionEndPct - pp.regionStartPct);
    if (regionLen <= 0.0)
        return computeSourceFrameFromTime(sourceTime, sourceFps);

    // Before bounce region: play forward normally
    if (sourceTime < regionStart)
        return computeSourceFrameFromTime(sourceTime, sourceFps);

    double posInRegion = sourceTime - regionStart;

    const double fwdLen   = regionLen;
    const double revLen   = regionLen / std::max(static_cast<double>(pp.reverseSpeed), 0.001);
    const double cycleLen = fwdLen + revLen;

    int loopCount = (cycleLen > 0.0) ? static_cast<int>(posInRegion / cycleLen) : 0;

    // maxLoops > 0: hold at boundary after exhausting loops
    if (pp.maxLoops > 0 && loopCount >= pp.maxLoops) {
        bool   holdAtEnd = ((pp.maxLoops % 2) == 0);
        double holdTime  = holdAtEnd ? (regionStart + regionLen) : regionStart;
        return computeSourceFrameFromTime(holdTime, sourceFps);
    }

    double posInCycle = std::fmod(posInRegion, cycleLen);
    bool   reversing  = (posInCycle >= fwdLen);
    double primaryTime;
    const double clampLo = std::isfinite(ev.sourceClampStartTime)
        ? ev.sourceClampStartTime : ev.sourceStartTime;
    const double clampHi = (sourceFps > 0.0 && ev.sourceEndTime > clampLo)
        ? std::max(clampLo, ev.sourceEndTime - 0.5 / sourceFps)
        : ev.sourceEndTime;

    if (!reversing) {
        primaryTime = regionStart + posInCycle;
    } else {
        double revPos = (posInCycle - fwdLen) / std::max(revLen, 0.001);
        primaryTime = regionStart + regionLen * (1.0 - revPos);
    }
    primaryTime = std::clamp(primaryTime, clampLo, clampHi);

    // Crossfade near direction-change boundaries
    if (pp.crossfadeFrames > 0 && sourceFps > 0.0) {
        const double cfSec     = pp.crossfadeFrames / sourceFps;
        double distStart       = std::abs(posInCycle);
        double distEnd         = std::abs(posInCycle - fwdLen);
        double distNearest     = std::min(distStart, distEnd);

        if (distNearest < cfSec) {
            float blend = static_cast<float>(distNearest / cfSec); // 0=at boundary, 1=away
            double secondaryTime;
            if (distEnd < distStart) {
                // Near regionEnd: secondary mirrors back into the forward pass
                secondaryTime = primaryTime - (cfSec - distNearest) * 2.0;
            } else {
                // Near regionStart: secondary mirrors forward past the boundary
                secondaryTime = primaryTime + (cfSec - distNearest) * 2.0;
            }
            secondaryTime = std::clamp(secondaryTime, clampLo, clampHi);
            outSecondaryFrame = computeSourceFrameFromTime(secondaryTime, sourceFps);
            outBlendFactor    = 1.0f - blend; // 1=full secondary at boundary, 0=full primary away
        }
    }

    return computeSourceFrameFromTime(primaryTime, sourceFps);
}
