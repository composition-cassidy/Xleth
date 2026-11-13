#include "FrameCollector.h"
#include "AnimationManager.h"
#include "XlethDebug.h"
#include "FrameRateMath.h"

#include "audio/ClipFade.h"
#include "model/Timeline.h"
#include "model/ClipVideoModulationTiming.h"
#include "model/ClipCompanionFxBuilder.h"
#include "model/ClipModulationCompatibility.h"
#include "model/NoteFade.h"
#include "SyncManager.h"     // VideoEvent
#include "render/VisualEchoTypes.h"
#include "render/LensRoamMath.h"   // roamDrawKey (draw order), shared with GridCompositor

#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <unordered_set>

namespace {

// A request at or below this resolved opacity is provably invisible — no
// blend of pixels at this alpha can be distinguished from fully transparent
// once quantized to an 8-bit output. Never compare opacity to exact 0.0f:
// fadeGain is floating point and a fade curve can land arbitrarily close to
// (but not exactly at) zero without ever reaching it.
constexpr float kOpacityCullEpsilon = 1e-4f;

bool isVideoModulationCompatible(const VideoEvent& event) noexcept
{
    return event.hasClipModulation
        && xleth::clipmod::isClipModulationCompatible(
               event.clipReversed,
               event.clipStretchRatio,
               event.clipFormantPreserve,
               event.modulation);
}

float videoEventFadeGain(const VideoEvent& event, double beatPos) noexcept
{
    if (!(event.durationBeats > 0.0) || !std::isfinite(event.durationBeats))
        return 1.0f;
    const float progress = static_cast<float>(
        (beatPos - event.startBeat) / event.durationBeats);
    return evaluateClipFadeGain(
        progress,
        event.fadeInPercent, event.fadeOutPercent,
        event.fadeInX1, event.fadeInY1, event.fadeInX2, event.fadeInY2,
        event.fadeOutX1, event.fadeOutY1, event.fadeOutX2, event.fadeOutY2);
}

// Pattern-track automatic per-note fade (TrackInfo::noteFade).
//
// This is the ONE place the feature is applied. Preview (XlethEngineService's
// video tick), export (OfflineRenderer) and the snapshot-transition renderer all
// reach the compositor through collectRequests, so hooking the opacity here
// gives all three identical output with no second implementation to keep in
// sync — the same reason the user-authored clip fade above lives here.
//
// Gated on Type::Pattern: a Clip track's events are clips, whose fade envelope
// is hand-authored per clip and already evaluated by videoEventFadeGain.
//
// Returns a MULTIPLIER, composed with (not substituted for) the event's own
// fade. On a Pattern track the event fade is always identity — only clip-track
// events populate VideoEvent::fadeInPercent / fadeOutPercent — so today the
// product is the note fade alone; composing rather than replacing means a path
// that ever sets both cannot silently drop one.
float trackNoteFadeGain(const VideoEvent& event, const TrackInfo* trk,
                        double beatPos, double bpm) noexcept
{
    if (!trk || trk->type != TrackInfo::Type::Pattern || !trk->noteFade.enabled)
        return 1.0f;
    if (!(event.durationBeats > 0.0) || !std::isfinite(event.durationBeats))
        return 1.0f;

    // A pattern note's VideoEvent spans exactly the note, so progress through
    // the event IS progress through the note.
    const float progress = static_cast<float>(
        (beatPos - event.startBeat) / event.durationBeats);
    return xleth::notefade::gain(trk->noteFade, progress, event.durationBeats, bpm);
}

// Whether this note actually ends on a fade-out, for the fullscreen-behind
// hold-through-gap suppression below. Without it, a Pattern track used as a
// fullscreen backdrop with hold-last-frame on would fade a note out and then
// snap straight back to full opacity the instant the note ended.
bool trackNoteFadeHasFadeOut(const VideoEvent& event, const TrackInfo* trk,
                             double bpm) noexcept
{
    return trk && trk->type == TrackInfo::Type::Pattern
        && xleth::notefade::hasFadeOut(trk->noteFade, event.durationBeats, bpm);
}

// ── Visual Echo ─────────────────────────────────────────────────────────────
//
// Resolve the track's VisualEcho entry (if any) against the bound Delay FX's
// PUBLISHED repeat interval. This is the single graft point where the audio
// side's timing becomes video-side geometry, and it is deliberately the only
// place in the render path that touches xleth::echo at all besides the
// compositor stage that consumes the result.
//
// Note what is NOT here: no BPM, no beat division, no sync-mode branch. The
// Delay resolved all of that before publishing `delaySamples`; this function
// only converts samples to output frames, which is a unit change. If that
// distinction ever blurs, preview and export stop agreeing the moment one of
// them is driven at a different tempo than the other.
//
// A chain may legally contain more than one VisualEcho (nothing forbids it, and
// addVisualEffect does not dedupe). The FIRST non-bypassed one wins; the rest
// are ignored rather than stacked, because two rings on one cell would each
// push the other's output back into itself and compound without bound.
xleth::echo::EchoSettings resolveEchoSettings(
    const std::vector<VisualEffect>&                chain,
    const xleth::echo::IDelaySnapshotResolver*      resolver,
    int                                             trackId,
    int                                             sampleRate,
    AVRational                                      fps,
    uint64_t                                        ringKey) noexcept
{
    xleth::echo::EchoSettings out;
    if (!resolver || chain.empty() || sampleRate <= 0 || fps.den <= 0 || fps.num <= 0)
        return out;

    const VisualEffect* fx = nullptr;
    for (const auto& e : chain) {
        if (!e.bypassed && e.type == VisualEffect::Type::VisualEcho) { fx = &e; break; }
    }
    if (!fx) return out;

    const int nodeId = static_cast<int>(std::lround(fx->params[2]));
    if (nodeId < 0) return out;                       // unbound — inert by design

    const xleth::echo::DelaySnapshot snap = resolver->resolve(trackId, nodeId);
    if (!snap.valid || !(snap.delaySamples > 0.0f)) return out;

    // samples -> output frames. fps is rational (30000/1001 is a real case), so
    // the multiply is done in double and only rounded at the very end by the
    // ring-depth ceil; the tap offsets themselves stay fractional and are lerped.
    const double framesPerSample = static_cast<double>(fps.num)
                                 / (static_cast<double>(fps.den) * static_cast<double>(sampleRate));
    const double frameDelay = static_cast<double>(snap.delaySamples) * framesPerSample;

    // A repeat interval shorter than one output frame cannot be resolved by the
    // ring at all — every tap would land inside the same buffered frame. Rather
    // than draw N identical copies on top of each other (which just brightens
    // the cell and looks like a bug), the echo stays inactive below that floor.
    if (!(frameDelay >= 1.0) || !std::isfinite(frameDelay)) return out;

    const int taps = std::clamp(static_cast<int>(std::lround(fx->params[0])),
                                1, xleth::echo::kMaxTaps);

    const bool followFeedback = fx->params[7] >= 0.5f;
    const float decay = followFeedback ? snap.feedback01
                                       : std::clamp(fx->params[1], 0.0f, 1.0f);

    out.active     = true;
    out.taps       = taps;
    out.tapGain    = decay;
    out.frameDelay = static_cast<float>(frameDelay);
    out.scaleTrail = std::clamp(fx->params[3], 0.0f, 1.0f);
    out.flipMode   = std::clamp(static_cast<int>(std::lround(fx->params[4])),
                                0, xleth::echo::kFlipModeCount - 1);
    out.pingPong   = snap.pingPong;
    // Edge drift is a ping-pong TELL, not a free parameter: it exists so the
    // trail visibly alternates sides the way the audio alternates ears. On a
    // Single or Dual delay there is nothing to alternate, so the param is
    // ignored outright rather than applied as a generic sideways smear.
    out.drift      = snap.pingPong ? std::clamp(fx->params[5], 0.0f, 1.0f) : 0.0f;
    out.additive   = fx->params[6] >= 0.5f;
    out.ringKey    = ringKey;

    // Clamp the requested depth against the ring cap. When the delay is long
    // enough that taps * D would overrun kMaxRingFrames, drop taps rather than
    // truncate the oldest one to a wrong position: a missing tap reads as a
    // shorter trail, a mis-positioned one reads as broken sync.
    while (out.taps > 1
           && (static_cast<double>(out.taps) * frameDelay) + 2.0
              > static_cast<double>(xleth::echo::kMaxRingFrames)) {
        --out.taps;
    }

    return out;
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
    // Stretch and reverse move the picture with the audio — see
    // sourceTimeForCacheSeconds in model/ClipVideoModulationTiming.cpp.
    ctx.clipStretchRatio = event.clipStretchRatio;
    ctx.clipReversed     = event.clipReversed;
    return ctx;
}

// Companion-FX snapshot construction has moved to
// model/ClipCompanionFxBuilder.cpp so the realtime OpenGL preview path
// (SyncManager) and this export path produce the same snapshot from the
// same evaluator outputs.

} // namespace

// Gates the two per-frame hot fprintf sites below (hold-last-frame clamp and
// fullscreen-cell composite logging). Evaluated once — this runs on the video
// thread inside a forked worker whose stderr is a pipe, so unconditional
// per-frame writes are a backpressure/stall hazard, not just noise.
static const bool kRenderLog = std::getenv("XLETH_RENDER_LOG") != nullptr;

// ===========================================================================
// Step 1: Collect requests for one output frame
// ===========================================================================

std::vector<CellFrameRequest>& FrameCollector::collectRequests(
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
    // The frame's timeline tick, the clock every Lens/Roam key is evaluated on.
    const double frameTick = static_cast<double>(projectFramePpq);

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

    // Reused across calls rather than a fresh vector per frame — see
    // requestBuffer_'s doc comment in FrameCollector.h. clear() retains
    // capacity, so a session's steady-state cell count settles into zero
    // reallocation after the first few frames.
    requestBuffer_.clear();
    std::vector<CellFrameRequest>& requests = requestBuffer_;
    int gapsSkipped = 0;

    // One scan of the event list for every placement below (see
    // activeByTrack_ in FrameCollector.h).
    resolveActiveEvents(events, beatPos);

    // Helper lambda to build a CellFrameRequest from an active event
    auto buildRequest = [&](const VideoEvent* ev, int trackId,
                            int cellCol, int cellRow, int spanX, int spanY,
                            float slotOpacity, int zOrder,
                            CellLayerKind kind) -> bool
    {
        if (!ev) {
            if (kRenderLog) clampLoggedTracks_.erase(trackId);
            return false;
        }

        // Look up source to get file path and fps
        const SourceMedia* src = timeline.getSource(ev->sourceId);
        if (!src || !src->hasVideo || src->filePath.empty()) return false;

        // The source's EXACT frame rate — the single authority for every
        // time → frame conversion below. RenderVideoDecoder converts the frame
        // indices we produce back into stream timestamps with this same
        // rational, so the round trip is symmetric. Projects saved before
        // fpsNum/fpsDen existed fall back to reconstructing it from the legacy
        // double. See engine/src/render/FrameRateMath.h.
        const AVRational srcRate = xleth::frametiming::rateFromSource(
            src->fpsNum, src->fpsDen, src->fps);
        const double srcFps = av_q2d(srcRate);

        const auto timingCtx = makeVideoTimingContext(
            *ev, beatPos, bpm, sampleRate, srcFps);
        const auto timing = xleth::clipmod::evaluateVideoClipModulationTiming(
            ev->modulation, timingCtx, isVideoModulationCompatible(*ev));

        double sourceTime = timing.sourceTimeSeconds;
        int64_t srcFrame = computeSourceFrameFromTime(sourceTime, srcRate);

        // Fetch TrackInfo early — needed to check pingPong.enabled before the clamp.
        const TrackInfo* trk = timeline.getTrack(trackId);
        const bool isFullscreen = (kind != CellLayerKind::Grid);

        CellFrameRequest req;
        if (companionFxEnabled_)
            req.companionFx = xleth::clipmod::buildClipCompanionFxSnapshot(ev->modulation, timing);

        // Ping-pong overrides the hold-last-frame clamp for enabled tracks.
        // Not gated on placement: compositeFrame runs the crossfade on every
        // layer kind, so a fullscreen backdrop ping-pongs like any other track.
        if (trk && trk->pingPong.enabled) {
            int64_t secondaryFrame = -1;
            float   blendFactor    = 0.0f;
            srcFrame = computePingPongFrame(*ev, beatPos, bpm, sampleRate, srcRate,
                                            trk->pingPong, secondaryFrame, blendFactor);
            req.pingPongSecondaryFrame = secondaryFrame;
            req.pingPongBlendFactor    = blendFactor;
            // Ping-pong owns boundary handling — skip the hold-last-frame clamp below.
        } else {
            // Hold-last-frame: if the computed source time exceeds the trim end,
            // always clamp to the last frame so active notes never go black.
            if (ev->sourceEndTime > 0.0) {
                if (sourceTime >= ev->sourceEndTime) {
                    srcFrame = computeSourceFrameFromTime(sourceTime, srcRate);
                    // Edge-triggered: log once when the note enters the held
                    // state, not every frame of its sustain (a normal
                    // authoring state, not an error).
                    if (kRenderLog && clampLoggedTracks_.insert(trackId).second) {
                        std::fprintf(stderr, "[FrameCollector] Track %d: frame clamped to last frame %lld "
                                     "(source time %.3fs >= trim end %.3fs)\n",
                                     trackId, (long long)srcFrame, sourceTime, ev->sourceEndTime);
                    }
                } else if (kRenderLog) {
                    clampLoggedTracks_.erase(trackId);
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
            ? computeSourceFrameFromTime(sourceTime - pickRegion->startTime, srcRate)
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
            if (allowProxy && ev->regionId > 0) {
                const SampleRegion* r = pickRegion;
                if (r && r->proxyReady && !r->proxyPath.empty()) {
                    if (sourceTime >= r->proxyStartTime &&
                        sourceTime <  r->proxyEndTime) {
                        pickedPath  = r->proxyPath;
                        pickedFrame = computeSourceFrameFromTime(
                                          sourceTime - r->proxyStartTime, srcRate);
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
            //
            // Why the region proxy is NOT preferred, even though it would make a
            // note retrigger cheap (its first frame is a keyframe, where the same
            // moment in the GOP-48 whole-source file costs a ~31-frame walk —
            // measured ~27 ms per uncached note-on on a desktop GPU): the region
            // proxy is not frame-exact. ProxyTranscoder keeps the frames whose
            // PTS is >= the region start, so its frame 0 is the first frame
            // AFTER the one the region start falls in, and the encoder can leave
            // it a frame short at the end. The whole-source proxy maps 1:1 onto
            // source frame indices. Preferring the region proxy was tried and
            // measured (worst tick 31 ms -> 6 ms) and backed out for that reason;
            // making it exact means aligning the transcode start to a frame
            // boundary and versioning the files, not a pick-order change.
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
        req.sourcePixelW     = src->width;
        req.sourcePixelH     = src->height;
        const float fadeGain = videoEventFadeGain(*ev, beatPos)
                             * trackNoteFadeGain(*ev, trk, beatPos, bpm);
        req.opacity          = std::clamp(slotOpacity * ev->opacity * fadeGain, 0.0f, 1.0f);
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
                    // Copied for fullscreen layers too: compositeFrame runs
                    // one per-cell path for every layer kind, so the chain
                    // (and the Outline / Drop Shadow stages it drives) is
                    // live for a fullscreen backdrop, not dead weight.
                    req.visualChain = trk->visualEffectChain;

                    // Visual Echo: resolved from the chain we just copied, so a
                    // preview-muted or bypassed chain yields no echo for free.
                    //
                    // The ring identity is (track, cell, layer kind), NOT the
                    // track alone: one track can occupy several cells, and each
                    // needs its own history because each shows different pixels.
                    // Moving a track to a different cell therefore starts a
                    // fresh ring — correct, since the old cell's history is of
                    // a different rectangle; the abandoned ring is swept by
                    // pruneIdleEchoRings a few seconds later.
                    const uint64_t ringKey =
                          (static_cast<uint64_t>(static_cast<uint32_t>(trackId)) << 32)
                        | (static_cast<uint64_t>(static_cast<uint16_t>(cellCol)) << 16)
                        | (static_cast<uint64_t>(static_cast<uint8_t>(cellRow))  << 8)
                        |  static_cast<uint64_t>(static_cast<uint8_t>(kind));
                    req.echo = resolveEchoSettings(req.visualChain, echoResolver_,
                                                   trackId, sampleRate, fps, ringKey);
                }
                // Note trigger detection: fire onNoteStart when globalNoteIndex
                // changes. Runs for fullscreen layers too — their ZPR is drawn
                // by the same per-cell path now, and an animation that is never
                // triggered simply sits at its defaults (zoom 1, pan/rot 0),
                // which is what made a fullscreen backdrop static before.
                // Bounce is still computed here but ignored at composite time
                // for non-grid layers; see the bounce block in compositeFrame.
                // VideoEvents are emitted only by
                // *normal* (non-slide) PatternNotes (slide notes flow through
                // SlideAnimationEvent and are skipped at note-build time), so
                // this is the right place to hook the NextNormalNote slide
                // visual return trigger — it covers both realtime preview and
                // offline render via the shared FrameCollector path.
                if (animationMgr_) {
                    const CellAnimation* anim = animationMgr_->getAnimation(trackId);
                    if (!anim || ev->globalNoteIndex != anim->activeNoteId) {
                        animationMgr_->onSlideReturnTrigger(trackId);
                        // Gate length for LengthMode::Note: ev->durationBeats is
                        // this note's own duration, already in scope here (read
                        // above for fade-gain) — converted to ms via the same
                        // bpm used for every other time->beat conversion in this
                        // function.
                        const float noteDurationMs =
                            static_cast<float>(ev->durationBeats * (60000.0 / bpm));
                        animationMgr_->onNoteStart(trackId, ev->globalNoteIndex,
                                                   trk->zoomPanRot, trk->bounce,
                                                   bpm, noteDurationMs);
                    }
                }
            }
        }

        // Populate animation state from AnimationManager. Taken for fullscreen
        // layers too — compositeFrame's single per-cell path reads ZPR and the
        // slide TV ramp for every layer kind. Only the bounce fields go unused
        // on a fullscreen layer (grid-geometry; see compositeFrame).
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

        // Lens/Roam at THIS frame's tick: binary searches over the published
        // snapshot's precompiled keys plus one interpolation per keyed
        // channel, POD copies out. No allocation, no lock, no state (see
        // setLensRoamSnapshot). Stateless on purpose: clip keys run from the
        // clip start, the hit curve from the note's START TICK (Ruling 5, the
        // way Note Fade runs), Roam on the timeline tick, so a seek into a
        // note lands mid-animation and the export, sampling the same tick,
        // gets the same value.
        if (const LensRoamSnapshot* lr = lensRoam_.get()) {
            LensRoamSnapshot::EventClock clock;
            clock.frameTick      = frameTick;
            clock.eventStartTick = videoEventStartTick(*ev);
            clock.eventLenTicks  = videoEventLengthTicks(*ev);
            req.lens = lr->lensForEventAt(trackId, ev->clipId, ev->regionId, clock);
            req.roam = lr->roamAt(trackId, frameTick);
        }

        if (isFullscreen && kRenderLog) {
            std::fprintf(stderr, "[FrameCollector] FS-%s cell: '%s' frame=%lld opacity=%.2f\n",
                         kind == CellLayerKind::FullscreenBehind ? "behind" : "front",
                         req.sourcePath.c_str(), (long long)req.sourceFrameIndex, req.opacity);
        }

        // Hold-through-gap bookkeeping runs regardless of the opacity cull
        // below: it must keep recording the last ACTIVE frame (even one that
        // resolves invisible, e.g. mid fade-out) so a genuine gap afterward
        // still holds the same frame it always did. This used to happen in
        // the BehindGrid caller reading requests.back(); moved here because
        // the opacity-culled path never pushes to `requests`.
        //
        // Grid cells hold exactly like a BehindGrid layer (same state, same
        // fade-out suppression, same threshold). Only FullscreenInFront is
        // transient. A track placed in several cells writes the same values
        // once per cell — they all show the same event — so the shared
        // per-track entry stays consistent.
        if (kind == CellLayerKind::FullscreenBehind || kind == CellLayerKind::Grid) {
            auto& s = holdByTrack_[trackId];
            s.lastFrame            = req.sourceFrameIndex;
            s.lastPath             = req.sourcePath;
            s.lastOrientation      = req.orientation;
            s.lastLens             = req.lens;
            s.lastSourcePixelW     = req.sourcePixelW;
            s.lastSourcePixelH     = req.sourcePixelH;
            s.suppressAfterFadeOut = ev->fadeOutPercent > 0.0f
                                  || trackNoteFadeHasFadeOut(*ev, trk, bpm);
            s.lastClipEndBeat      = ev->startBeat + ev->durationBeats;
        }

        // Opacity cull: a request that provably cannot appear is dropped
        // before it ever reaches dedup/decode/upload/draw. The caller still
        // sees `true` — an event WAS active here, this is not a timeline gap
        // — so BehindGrid hold-fill and the gap-skipped counters are not
        // triggered by an invisible-but-active frame.
        if (req.opacity <= kOpacityCullEpsilon)
            return true;

        requests.push_back(std::move(req));
        return true;
    };

    // Hold-through-gap fill, shared by BehindGrid layers and grid cells. Called
    // where a placement has NO request this frame (a real gap, not an opacity
    // cull — buildRequest reports those as handled). Pushes the track's last
    // served frame and returns true, or returns false to leave it a gap.
    auto buildHeldRequest = [&](int trackId, int cellCol, int cellRow,
                                int spanX, int spanY,
                                float slotOpacity, int zOrder,
                                CellLayerKind kind) -> bool
    {
        auto it = holdByTrack_.find(trackId);
        const TrackInfo* trk = timeline.getTrack(trackId);
        if (it == holdByTrack_.end() || !trk) return false;
        const HoldState& hold = it->second;

        if (!trk->videoHoldLastFrame || hold.lastFrame < 0
            || hold.suppressAfterFadeOut)
            return false;

        // A muted track has no active event by construction (findActiveEvent),
        // which is indistinguishable from a gap here — without this a muted
        // track would keep showing its last frame and mute would look broken.
        if (trk->muted) return false;

        // Hold-expiry threshold. The stored value is already in BEATS and
        // beatPos is in beats, so this is a direct comparison — no PPQ
        // round-trip and no tempo lookup. Negative threshold = unlimited,
        // which short-circuits to the pre-threshold behavior untouched.
        //
        // Only reached once the clip has actually ended, so the hold always
        // fills a gap shorter than the threshold exactly as it did before.
        if (trk->videoHoldLastFrameThresholdBeats >= 0.0
            && (beatPos - hold.lastClipEndBeat) > trk->videoHoldLastFrameThresholdBeats)
            return false;

        if (kRenderLog) {
            std::fprintf(stderr, "[FrameCollector] %s gap (track %d): hold=ON frame=%lld\n",
                         kind == CellLayerKind::Grid ? "grid" : "FS-behind",
                         trackId, (long long)hold.lastFrame);
        }

        CellFrameRequest req;
        req.cellCol          = cellCol;
        req.cellRow          = cellRow;
        req.spanX            = spanX;
        req.spanY            = spanY;
        req.sourcePath       = hold.lastPath;
        req.sourceFrameIndex = hold.lastFrame;
        req.opacity          = std::min(1.0f, std::max(0.0f, slotOpacity));
        req.layerKind        = kind;
        req.zOrder           = zOrder;
        req.orientation      = hold.lastOrientation;
        req.trackId          = trackId;
        req.lens             = hold.lastLens;   // the picture as last drawn
        req.sourcePixelW     = hold.lastSourcePixelW;
        req.sourcePixelH     = hold.lastSourcePixelH;
        // Roam belongs to the track, not the event: its keys keep running on
        // the timeline tick through a held gap.
        if (const LensRoamSnapshot* lr = lensRoam_.get())
            req.roam = lr->roamAt(trackId, frameTick);

        // A held frame is the SAME picture the live path was drawing an
        // instant ago, so it has to carry the same look. The compositor runs
        // the full per-cell path on every layer kind, so leaving these at
        // their defaults would strip the chain, the corner radius and ZPR the
        // moment the clip ended — a visible pop at every gap boundary. Mirrors
        // buildRequest's population; ping-pong is deliberately absent (a hold
        // has no motion).
        req.cornerRadius     = trk->cornerRadius;
        req.gapScaleOverride = trk->gapScaleOverride;
        if (!(applyPreviewEffectMute
              && timeline.isVisualEffectChainPreviewMuted(trk->id)))
            req.visualChain = trk->visualEffectChain;
        if (animationMgr_) {
            if (const CellAnimation* anim = animationMgr_->getAnimation(trackId)) {
                req.currentZoom      = anim->currentZoom;
                req.currentPanX      = anim->currentPanX;
                req.currentPanY      = anim->currentPanY;
                req.currentRotDeg    = anim->currentRotDeg;
                req.tvRampIntensity  = anim->tvRampIntensity;
                req.tvRampRollSpeed  = anim->tvRampRollSpeed;
                req.tvRampScanlines  = anim->tvRampScanlines;
                req.tvRampChroma     = anim->tvRampChroma;
                req.tvRampNoise      = anim->tvRampNoise;
                req.tvRampJitter     = anim->tvRampJitter;
                req.tvRampColorBleed = anim->tvRampColorBleed;
                // Bounce is grid geometry: the compositor ignores it on a
                // fullscreen layer, so only a grid cell needs it carried.
                if (kind == CellLayerKind::Grid) {
                    req.bounceOffsetX = anim->bounceOffsetX;
                    req.bounceOffsetY = anim->bounceOffsetY;
                    req.bounceScaleX  = anim->bounceScaleX;
                    req.bounceScaleY  = anim->bounceScaleY;
                }
            }
        }

        requests.push_back(std::move(req));
        return true;
    };

    // GC the hold-state map: keep entries only for tracks still placed as a
    // BehindGrid layer or a grid slot. Bounds the map size to the live layout
    // rather than every track ever assigned.
    {
        std::unordered_set<int> holdableTrackIds;
        for (const auto& fl : layout.fullscreenLayers) {
            if (fl.placement == FullscreenLayerPlacement::BehindGrid && fl.trackId >= 0)
                holdableTrackIds.insert(fl.trackId);
        }
        for (const GridSlot& slot : layout.slots) {
            if (slot.trackId >= 0) holdableTrackIds.insert(slot.trackId);
        }
        for (auto it = holdByTrack_.begin(); it != holdByTrack_.end(); ) {
            if (!holdableTrackIds.count(it->first)) it = holdByTrack_.erase(it);
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

        const VideoEvent* ev = activeEventFor(timeline, fl.trackId);
        if (buildRequest(ev, fl.trackId, 0, 0, fullW, fullH,
                         fl.opacity, fl.zOrder,
                         CellLayerKind::FullscreenBehind)) {
            // Active layer — hold-through-gap state already recorded inside
            // buildRequest (it runs regardless of the opacity cull, so a
            // frame invisible only because of a fade still updates the hold).
        } else if (!buildHeldRequest(fl.trackId, 0, 0, fullW, fullH,
                                     fl.opacity, fl.zOrder,
                                     CellLayerKind::FullscreenBehind)) {
            ++gapsSkipped;
        }
    }

    // b) GRID CELLS. Appended in layout.slots array order; the final stable_sort
    // orders them by zOrder while preserving array order for equal keys (exactly
    // the behavior of the old per-slot pre-sort, now folded into the one global
    // sort below).
    for (const GridSlot& slot : layout.slots) {
        if (slot.trackId < 0) { ++gapsSkipped; continue; }

        // A gap (no active event, or buildRequest could not resolve one) is
        // filled with the track's held frame when it has Hold Last Frame on,
        // exactly like a BehindGrid layer; otherwise the cell stays empty.
        const VideoEvent* ev = activeEventFor(timeline, slot.trackId);
        if (!ev || !buildRequest(ev, slot.trackId,
                                 slot.gridX, slot.gridY, slot.spanX, slot.spanY,
                                 slot.opacity, slot.zOrder, CellLayerKind::Grid)) {
            if (!buildHeldRequest(slot.trackId,
                                  slot.gridX, slot.gridY, slot.spanX, slot.spanY,
                                  slot.opacity, slot.zOrder, CellLayerKind::Grid))
                ++gapsSkipped;
        }
    }

    // c) FULLSCREEN IN-FRONT LAYERS. Transient; no hold-through-gap. zOrder is
    // the layer's own global key.
    for (const auto& fl : layout.fullscreenLayers) {
        if (fl.placement != FullscreenLayerPlacement::InFrontOfGrid) continue;
        if (fl.trackId < 0) continue;

        const VideoEvent* ev = activeEventFor(timeline, fl.trackId);
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
    //
    // Roam layers (spec: Bounds Float draws per layer) are a secondary key in
    // this same sort, so draw order is still decided in exactly one place. The
    // key is lensroam::roamDrawKey; when no request floats on a non-grid layer
    // (every project before Roam, and most after), the original zOrder-only
    // comparator runs untouched, so today's order cannot move.
    bool anyRoamLayer = false;
    int  maxGridZOrder = INT_MIN;
    for (const CellFrameRequest& r : requests) {
        if (r.layerKind == CellLayerKind::Grid) maxGridZOrder = std::max(maxGridZOrder, r.zOrder);
        if (lensroam::effectiveRoamLayer(r.roam) != RoamLayer::GridOrder) anyRoamLayer = true;
    }
    if (!anyRoamLayer) {
        std::stable_sort(requests.begin(), requests.end(),
            [](const CellFrameRequest& a, const CellFrameRequest& b) {
                return a.zOrder < b.zOrder;
            });
    } else {
        std::stable_sort(requests.begin(), requests.end(),
            [maxGridZOrder](const CellFrameRequest& a, const CellFrameRequest& b) {
                return lensroam::roamDrawKey(a.roam, a.zOrder, maxGridZOrder)
                     < lensroam::roamDrawKey(b.roam, b.zOrder, maxGridZOrder);
            });
    }

    XLETH_RENDER_LOG(std::fprintf(stderr,
                 "[FrameCollector] Collecting for output frame %lld: %d active cells, %d gaps skipped\n",
                 (long long)outputFrameIndex,
                 static_cast<int>(requests.size()),
                 gapsSkipped));

    return requests;
}

// ===========================================================================
// Step 2: Deduplicate
// ===========================================================================

std::unordered_map<FrameCacheKey, std::vector<CellFrameRequest*>, FrameCacheKeyHash>
FrameCollector::deduplicateRequests(std::vector<CellFrameRequest>& requests)
{
    std::unordered_map<FrameCacheKey, std::vector<CellFrameRequest*>, FrameCacheKeyHash> result;

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

    XLETH_RENDER_LOG(std::fprintf(stderr,
                 "[FrameCollector] Dedup: %d cell requests -> %d unique frames to decode\n",
                 static_cast<int>(requests.size()),
                 static_cast<int>(result.size())));

    return result;
}

// ===========================================================================
// Step 3: Resolve (cache check)
// ===========================================================================

std::vector<FrameCacheKey> FrameCollector::resolveFrames(
    const std::unordered_map<FrameCacheKey, std::vector<CellFrameRequest*>, FrameCacheKeyHash>& deduplicated,
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

    XLETH_RENDER_LOG(std::fprintf(stderr, "[FrameCollector] Resolve: %d cache hits, %d decodes needed\n",
                 hits, static_cast<int>(misses.size())));

    // Detect sequential access patterns for the decoder hint.
    // If multiple misses are from the same source and their frame indices
    // form a contiguous run, flag it. Log-only (the decoder derives the
    // sequential case itself), so it only runs when render logging is on —
    // otherwise it built a string-keyed map per multi-miss frame for nothing.
    if (xlethRenderLogEnabled() && misses.size() > 1) {
        std::unordered_map<std::string, std::vector<int64_t>> missFramesBySource;
        for (const auto& k : misses) {
            missFramesBySource[k.sourcePath.str()].push_back(k.frameIndex);
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

namespace {

// The one ordering both event lookups use: the latest-starting active event
// wins; on an exact start tie the lowest pitch, then the lowest emission
// order. Same-tick note-ons (a chord) all carry the same resolved flip state,
// so any member draws an identical orientation — the tie-break only has to be
// deterministic. Strict, so the first event seen keeps an exact tie.
bool activeEventBeats(const VideoEvent& ev, const VideoEvent& best) noexcept
{
    return ev.startBeat > best.startBeat
        || (ev.startBeat == best.startBeat
            && (ev.pitch < best.pitch
                || (ev.pitch == best.pitch
                    && ev.originalEmissionOrder < best.originalEmissionOrder)));
}

} // namespace

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

    const VideoEvent* best = nullptr;
    for (const auto& ev : events) {
        if (ev.trackId != trackId) continue;
        if (beatPos < ev.startBeat) continue;
        if (beatPos >= ev.startBeat + ev.durationBeats) continue;
        if (!best || activeEventBeats(ev, *best)) best = &ev;
    }
    return best;
}

void FrameCollector::resolveActiveEvents(const std::vector<VideoEvent>& events,
                                         double beatPos)
{
    activeByTrack_.clear();
    for (const auto& ev : events) {
        // Window test first: it rejects nearly every event with no lookup.
        if (beatPos < ev.startBeat) continue;
        if (beatPos >= ev.startBeat + ev.durationBeats) continue;
        if (ev.trackId < 0) continue;
        auto [it, inserted] = activeByTrack_.try_emplace(ev.trackId, &ev);
        if (!inserted && activeEventBeats(ev, *it->second)) it->second = &ev;
    }
}

const VideoEvent* FrameCollector::activeEventFor(const Timeline& timeline, int trackId) const
{
    if (trackId < 0) return nullptr;
    const TrackInfo* track = timeline.getTrack(trackId);
    if (track && track->muted) return nullptr;
    auto it = activeByTrack_.find(trackId);
    return it == activeByTrack_.end() ? nullptr : it->second;
}

int64_t FrameCollector::computeSourceFrame(
    const VideoEvent& ev,
    double            beatPos,
    double            bpm,
    int               sampleRate,
    AVRational        sourceRate)
{
    return computeSourceFrameFromTime(
        computeSourceTime(ev, beatPos, bpm, sampleRate, av_q2d(sourceRate)),
        sourceRate);
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

int64_t FrameCollector::computeSourceFrameFromTime(double sourceTimeSec, AVRational sourceRate)
{
    // Source time (seconds) → source frame index, FLOOR semantics: frame N is the
    // frame whose interval [N/fps, (N+1)/fps) contains t.
    //
    // Two things were wrong here before:
    //
    //  1. The rate was reconstructed as round(fps*1000)/1000, so 24000/1001
    //     became 23976/1000 — close, but not the same rate RenderVideoDecoder
    //     converts back with, which is exactly what makes a round trip drift.
    //     It now takes the source's exact rational, the same one the decoder
    //     uses, so both directions are bit-identical.
    //
    //  2. av_rescale defaults to AV_ROUND_NEAR_INF, i.e. round-to-nearest, so
    //     any time past the midpoint of a frame returned the NEXT frame. The
    //     region picker in the UI is a Chromium <video> element and uses floor
    //     semantics, so the engine disagreed with the picker by one frame for
    //     roughly half of all pick positions. Concretely, at t = 916.7734480660205
    //     in a 24000/1001 source the picker shows frame 21980 and this function
    //     used to request 21981.
    //
    // See engine/src/render/FrameRateMath.h. Negative times clamp to 0.
    return xleth::frametiming::timeToFrameFloor(sourceTimeSec, sourceRate);
}

// ===========================================================================
// Ping-Pong frame computation
// ===========================================================================

int64_t FrameCollector::computePingPongFrame(
    const VideoEvent&       ev,
    double                  beatPos,
    double                  bpm,
    int                     sampleRate,
    AVRational              sourceRate,
    const PingPongSettings& pp,
    int64_t&                outSecondaryFrame,
    float&                  outBlendFactor)
{
    outSecondaryFrame = -1;
    outBlendFactor    = 0.0f;

    // Frame-index conversion below goes through sourceRate (exact); the plain
    // double is only used for the sub-frame crossfade/clamp arithmetic, where a
    // rational buys nothing.
    const double sourceFps = av_q2d(sourceRate);

    double sourceTime = computeSourceTime(ev, beatPos, bpm, sampleRate, sourceFps);

    const double clipLen = ev.sourceEndTime - ev.sourceStartTime;
    if (clipLen <= 0.0)
        return computeSourceFrameFromTime(sourceTime, sourceRate);

    const double regionStart = ev.sourceStartTime + clipLen * pp.regionStartPct;
    const double regionLen   = clipLen * (pp.regionEndPct - pp.regionStartPct);
    if (regionLen <= 0.0)
        return computeSourceFrameFromTime(sourceTime, sourceRate);

    // Before bounce region: play forward normally
    if (sourceTime < regionStart)
        return computeSourceFrameFromTime(sourceTime, sourceRate);

    double posInRegion = sourceTime - regionStart;

    const double fwdLen   = regionLen;
    const double revLen   = regionLen / std::max(static_cast<double>(pp.reverseSpeed), 0.001);
    const double cycleLen = fwdLen + revLen;

    int loopCount = (cycleLen > 0.0) ? static_cast<int>(posInRegion / cycleLen) : 0;

    // maxLoops > 0: hold at boundary after exhausting loops
    if (pp.maxLoops > 0 && loopCount >= pp.maxLoops) {
        bool   holdAtEnd = ((pp.maxLoops % 2) == 0);
        double holdTime  = holdAtEnd ? (regionStart + regionLen) : regionStart;
        return computeSourceFrameFromTime(holdTime, sourceRate);
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
            outSecondaryFrame = computeSourceFrameFromTime(secondaryTime, sourceRate);
            outBlendFactor    = 1.0f - blend; // 1=full secondary at boundary, 0=full primary away
        }
    }

    return computeSourceFrameFromTime(primaryTime, sourceRate);
}
