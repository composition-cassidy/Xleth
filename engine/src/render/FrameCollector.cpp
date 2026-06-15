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

int resolvedFlipOrdinal(const VideoEvent& event) noexcept
{
    return event.monoOrdinal >= 0 ? event.monoOrdinal : event.globalNoteIndex;
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
    const bool postCacheStretchedModulation =
        event.clipStretchRatio != 1.0
        && !event.clipReversed
        && !event.clipFormantPreserve;
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
    int64_t                        projectStartSample)
{
    const double bpm = timeline.getBPM();
    const GridLayout& layout = timeline.getGridLayout();

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
        std::string pickedPath  = src->filePath;
        int64_t     pickedFrame = srcFrame;

        if (allowProxy && ev->regionId > 0 && !isFullscreen) {
            const SampleRegion* r = timeline.getRegion(ev->regionId);
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
                if (!trk->visualEffectChain.empty()) {
                    req.visualChain = &trk->visualEffectChain;
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

    // a) FULLSCREEN BEHIND LAYERS — array order = bottom-to-top within the
    // back stack. Holds last frame during gaps when track has videoHoldLastFrame.
    for (const auto& fl : layout.fullscreenLayers) {
        if (fl.placement != FullscreenLayerPlacement::BehindGrid) continue;
        if (fl.trackId < 0) continue;

        const VideoEvent* ev = findActiveEvent(events, timeline, fl.trackId, beatPos);
        if (buildRequest(ev, fl.trackId, 0, 0, fullW, fullH,
                         fl.opacity, /*zOrder*/-1,
                         CellLayerKind::FullscreenBehind)) {
            // Active layer — record last frame for hold-through-gap
            const auto& r = requests.back();
            auto& s = fullscreenHoldByTrack_[fl.trackId];
            s.lastFrame       = r.sourceFrameIndex;
            s.lastPath        = r.sourcePath;
            s.lastOrientation = r.orientation;
        } else {
            auto it = fullscreenHoldByTrack_.find(fl.trackId);
            const TrackInfo* trk = timeline.getTrack(fl.trackId);
            if (it != fullscreenHoldByTrack_.end() && it->second.lastFrame >= 0
                && trk && trk->videoHoldLastFrame) {
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
                req.zOrder           = -1;
                req.orientation      = it->second.lastOrientation;
                req.trackId          = fl.trackId;
                requests.push_back(std::move(req));
            } else {
                ++gapsSkipped;
            }
        }
    }

    // b) GRID CELLS — sorted by zOrder
    std::vector<GridSlot> slots = layout.slots;
    std::stable_sort(slots.begin(), slots.end(),
        [](const GridSlot& a, const GridSlot& b) { return a.zOrder < b.zOrder; });

    for (const GridSlot& slot : slots) {
        if (slot.trackId < 0) { ++gapsSkipped; continue; }

        const VideoEvent* ev = findActiveEvent(events, timeline, slot.trackId, beatPos);
        if (!ev) { ++gapsSkipped; continue; }

        if (!buildRequest(ev, slot.trackId,
                          slot.gridX, slot.gridY, slot.spanX, slot.spanY,
                          slot.opacity, slot.zOrder, CellLayerKind::Grid)) {
            ++gapsSkipped;
        }
    }

    // c) FULLSCREEN IN-FRONT LAYERS — array order = bottom-to-top within the
    // front stack. Front layers are intentionally transient; no hold-through-gap.
    for (const auto& fl : layout.fullscreenLayers) {
        if (fl.placement != FullscreenLayerPlacement::InFrontOfGrid) continue;
        if (fl.trackId < 0) continue;

        const VideoEvent* ev = findActiveEvent(events, timeline, fl.trackId, beatPos);
        if (!buildRequest(ev, fl.trackId, 0, 0, fullW, fullH,
                          fl.opacity, /*zOrder*/999,
                          CellLayerKind::FullscreenInFront)) {
            ++gapsSkipped;
        }
    }

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

    // Find the latest-starting active event on this track. If multiple
    // same-tick note-ons are active, choose the highest resolved flip ordinal
    // so an EveryNote chord consumes every stacked note before drawing.
    const VideoEvent* best = nullptr;
    for (const auto& ev : events) {
        if (ev.trackId != trackId) continue;
        if (beatPos < ev.startBeat) continue;
        if (beatPos >= ev.startBeat + ev.durationBeats) continue;
        if (!best
            || ev.startBeat > best->startBeat
            || (ev.startBeat == best->startBeat
                && resolvedFlipOrdinal(ev) > resolvedFlipOrdinal(*best))) {
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
