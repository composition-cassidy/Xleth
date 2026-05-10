#include "SyncManager.h"
#include "model/Timeline.h"
#include "model/ClipVideoModulationTiming.h"
#include "model/ClipCompanionFxBuilder.h"
#include "model/ClipModulationCompatibility.h"

// GPU compositor calls are compiled-out when building XlethEngineCore
// (the static lib used by the Node.js bridge). The bridge target defines
// XLETH_CORE_ONLY so no GLFW/GLEW/OpenGL symbols appear in the .node DLL.
// When building the full engine (XlethEngine executable) this block is active.
#ifndef XLETH_CORE_ONLY
#  include "VideoCompositor.h"   // brings in VideoLayer.h + GL/GLFW headers
#endif

#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <numeric>
#include <utility>

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
    double timelineSeconds,
    double timelineBeats,
    int64_t timelineSamples,
    double bpm,
    double sampleRate,
    double sourceFps) noexcept
{
    const double safeBpm = (bpm > 0.0 && std::isfinite(bpm)) ? bpm : 140.0;
    const double beatsSinceStart = timelineBeats - event.startBeat;
    const double clipLocalSeconds = beatsSinceStart * (60.0 / safeBpm);
    const int64_t clipLocalSamples = clipLocalSeconds > 0.0 && sampleRate > 0.0
        ? static_cast<int64_t>(std::llround(clipLocalSeconds * sampleRate))
        : int64_t{0};

    xleth::clipmod::VideoModulationTimingContext ctx;
    ctx.bpm = safeBpm;
    ctx.sampleRate = sampleRate;
    ctx.timelineSeconds = timelineSeconds;
    ctx.timelineBeats = timelineBeats;
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

} // namespace

SyncManager::SyncManager(Transport& transport,
                         std::vector<VideoDecoder*>& decoders,
                         FrameCache& cache,
                         VideoCompositor* compositor,
                         std::function<int64_t()> presentationPositionProvider)
    : transport_(transport)
    , decoders_(decoders)
    , cache_(cache)
    , compositor_(compositor)
    , presentationPositionProvider_(std::move(presentationPositionProvider))
{
}

void SyncManager::setRegionProxySources(
    std::unordered_map<int, VideoDecoder*>* regionDecoderPtrs,
    const Timeline*                         timeline)
{
    regionDecoderPtrs_   = regionDecoderPtrs;
    timelineForRegions_  = timeline;
}

void SyncManager::addEvent(const VideoEvent& event)
{
    events_.push_back(event);
    if (event.layerIndex > maxLayerIndex_)
        maxLayerIndex_ = event.layerIndex;
}

void SyncManager::clearEvents()
{
    events_.clear();
    slideEvents_.clear();
    lastDisplayedFrame_.clear();
    maxLayerIndex_ = 0;

    // Reset preview hold state (prevents stale holds across seek/stop/project switch)
    previewLastChorusFrame    = -1;
    previewLastChorusSourceId = -1;
    previewLastGridCellKey.clear();
}

double SyncManager::videoTick()
{
    // 1. If transport is not playing, nothing to do
    if (!transport_.isPlaying())
    {
#ifndef XLETH_CORE_ONLY
        if (compositor_) compositor_->renderComposite();
#endif
        return -1.0;
    }

    double sampleRate = transport_.getSampleRate();
    double bpm = transport_.getBPM();
    const int64_t audioTimeSamples = std::max<int64_t>(
        0,
        presentationPositionProvider_
            ? presentationPositionProvider_()
            : transport_.getPositionSamples());
    const double audioTimeSec = sampleRate > 0.0
        ? static_cast<double>(audioTimeSamples) / sampleRate
        : 0.0;
    const double audioTimeBeat = (sampleRate > 0.0 && bpm > 0.0)
        ? (static_cast<double>(audioTimeSamples) * bpm) / (60.0 * sampleRate)
        : 0.0;

    // Track which layers are active this tick
#ifndef XLETH_CORE_ONLY
    std::vector<bool> layerActive(static_cast<size_t>(maxLayerIndex_ + 1), false);
#endif

    // 3 & 4. Find active events and process them
    for (const auto& event : events_)
    {
        if (audioTimeBeat < event.startBeat ||
            audioTimeBeat >= event.startBeat + event.durationBeats)
            continue;

#ifndef XLETH_CORE_ONLY
        // This event is ACTIVE
        if (compositor_ &&
            event.layerIndex >= 0 &&
            event.layerIndex < static_cast<int>(layerActive.size()))
            layerActive[static_cast<size_t>(event.layerIndex)] = true;
#endif

        double sourceFps = 0.0;
        if (event.sourceId >= 0 && event.sourceId < static_cast<int>(decoders_.size()))
        {
            VideoDecoder* original = decoders_[static_cast<size_t>(event.sourceId)];
            if (original && original->isOpen())
                sourceFps = original->getFPS();
        }

        const auto timingCtx = makeVideoTimingContext(
            event, audioTimeSec, audioTimeBeat, audioTimeSamples,
            bpm, sampleRate, sourceFps);
        const auto timing = xleth::clipmod::evaluateVideoClipModulationTiming(
            event.modulation, timingCtx, isVideoModulationCompatible(event));
        double sourceTime = timing.sourceTimeSeconds;

        // Pick the best decoder for this event:
        //   1. If a per-region proxy is available and the current sourceTime
        //      lands inside the proxy's covered range, use it — seek time
        //      must be relative to the proxy's time 0.
        //   2. Otherwise fall back to the original source decoder.
        VideoDecoder* decoder       = nullptr;
        double        seekTime      = sourceTime;
        int           cacheRegionId = -1;

        if (event.regionId > 0 && regionDecoderPtrs_ && timelineForRegions_)
        {
            auto it = regionDecoderPtrs_->find(event.regionId);
            if (it != regionDecoderPtrs_->end() && it->second && it->second->isOpen())
            {
                const SampleRegion* r = timelineForRegions_->getRegion(event.regionId);
                if (r && r->proxyReady &&
                    sourceTime >= r->proxyStartTime &&
                    sourceTime <  r->proxyEndTime)
                {
                    decoder       = it->second;
                    seekTime      = sourceTime - r->proxyStartTime;
                    cacheRegionId = event.regionId;
                }
            }
        }

        if (!decoder)
        {
            // Bounds-check sourceId against decoders
            if (event.sourceId < 0 || event.sourceId >= static_cast<int>(decoders_.size()))
                continue;
            decoder = decoders_[static_cast<size_t>(event.sourceId)];
            if (!decoder || !decoder->isOpen())
                continue;
        }

        // 4b. Convert seekTime to frame number (on whichever decoder we picked)
        int targetFrame = decoder->timeToFrame(seekTime);

#ifndef XLETH_CORE_ONLY
        // 4c. Check if this frame was already displayed on this layer (GPU path)
        if (compositor_)
        {
            auto it = lastDisplayedFrame_.find(event.layerIndex);
            if (it != lastDisplayedFrame_.end() && it->second == targetFrame)
            {
                // Frame already displayed — just refresh layer properties.
                // Phase E.3: companionFx must still be refreshed even when
                // the source frame has not changed; otherwise preview FX
                // freeze whenever the source repeats (events run at audio
                // rate, source plays at video FPS).
                VideoLayer layer = {};
                layer.sourceTextureSet = event.sourceId;
                layer.x       = event.x;
                layer.y       = event.y;
                layer.width   = event.width;
                layer.height  = event.height;
                layer.opacity = event.opacity;
                layer.zOrder  = event.layerIndex;
                layer.visible = true;
                layer.companionFx = xleth::clipmod::buildClipCompanionFxSnapshot(
                    event.modulation, timing);
                compositor_->setLayer(event.layerIndex, layer);
                continue;
            }
        }
#endif

        // 4d. Try frame cache — regionId is part of the key because a region
        // proxy produces a different picture than the original at the same
        // (sourceId, targetFrame) pair.
        FrameKey key = { event.sourceId, targetFrame, cacheRegionId };
        const CachedFrame* cached = cache_.get(key);

        // 4e. If cache miss — decode
        if (!cached)
        {
            auto decodeStart = std::chrono::high_resolution_clock::now();

            VideoDecoder::DecodedFrame decodedFrame;
            bool ok = decoder->seekAndDecode(seekTime, decodedFrame);

            auto decodeEnd = std::chrono::high_resolution_clock::now();
            double decodeMs = std::chrono::duration<double, std::milli>(decodeEnd - decodeStart).count();

            decodeTimeSamples_.push_back(decodeMs);

            if (!ok)
                continue;

            // Track slow decodes (>50ms) but always cache the frame.
            // The old `continue` here caused black flicker at note boundaries
            // where the first frame after a seek was consistently >50ms.
            if (decodeMs > 50.0)
            {
                ++frameDrops_;
                std::fprintf(stderr, "[SyncManager] Slow decode: %.1f ms (source %d, frame %d), caching anyway\n",
                             decodeMs, event.sourceId, targetFrame);
            }

            // Create CachedFrame from decoded data
            CachedFrame cf;
            cf.yPlane  = std::move(decodedFrame.yPlane);
            cf.uPlane  = std::move(decodedFrame.uPlane);
            cf.vPlane  = std::move(decodedFrame.vPlane);
            cf.width   = decodedFrame.width;
            cf.height  = decodedFrame.height;
            cf.yStride = decodedFrame.yStride;
            cf.uStride = decodedFrame.uStride;
            cf.vStride = decodedFrame.vStride;

            cache_.put(key, std::move(cf));

            // Re-fetch from cache (we just inserted it)
            cached = cache_.get(key);
            if (!cached)
                continue;
        }

#ifndef XLETH_CORE_ONLY
        if (compositor_)
        {
            // 4f. Upload frame to compositor
            compositor_->uploadFrameToSet(event.sourceId,
                                          cached->yPlane.data(),
                                          cached->uPlane.data(),
                                          cached->vPlane.data(),
                                          cached->width, cached->height,
                                          cached->yStride, cached->uStride, cached->vStride);

            // 4g. Set layer properties
            VideoLayer layer = {};
            layer.sourceTextureSet = event.sourceId;
            layer.x       = event.x;
            layer.y       = event.y;
            layer.width   = event.width;
            layer.height  = event.height;
            layer.opacity = event.opacity;
            layer.zOrder  = event.layerIndex;
            layer.visible = true;
            layer.companionFx = xleth::clipmod::buildClipCompanionFxSnapshot(
                event.modulation, timing);
            compositor_->setLayer(event.layerIndex, layer);

            // 4h. Update lastDisplayedFrame
            lastDisplayedFrame_[event.layerIndex] = targetFrame;
        }
#endif
    }

#ifndef XLETH_CORE_ONLY
    if (compositor_)
    {
        // 5. Set any non-active layers to visible = false
        for (int i = 0; i <= maxLayerIndex_; ++i)
        {
            if (!layerActive[static_cast<size_t>(i)])
            {
                VideoLayer hidden = {};
                hidden.visible = false;
                compositor_->setLayer(i, hidden);
            }
        }

        // 6. Render composite
        compositor_->renderComposite();
    }
#endif

    // 7. Measure drift
    double renderTimeSec = audioTimeSec;
    double driftMs = std::abs((renderTimeSec - audioTimeSec) * 1000.0);

    driftSamples_.push_back(driftMs);
    if (driftMs > maxDrift_)
        maxDrift_ = driftMs;

    return audioTimeBeat;
}

// ── Performance stats ────────────────────────────────────────────────────────

double SyncManager::getLastDriftMs() const
{
    if (driftSamples_.empty()) return 0.0;
    return driftSamples_.back();
}

double SyncManager::getMaxDriftMs() const
{
    return maxDrift_;
}

double SyncManager::getAvgDriftMs() const
{
    if (driftSamples_.empty()) return 0.0;
    double sum = std::accumulate(driftSamples_.begin(), driftSamples_.end(), 0.0);
    return sum / static_cast<double>(driftSamples_.size());
}

double SyncManager::getAvgDecodeTimeMs() const
{
    if (decodeTimeSamples_.empty()) return 0.0;
    double sum = std::accumulate(decodeTimeSamples_.begin(), decodeTimeSamples_.end(), 0.0);
    return sum / static_cast<double>(decodeTimeSamples_.size());
}

int SyncManager::getFrameDropCount() const
{
    return frameDrops_;
}

double SyncManager::getCacheHitRate() const
{
    return cache_.hitRate();
}
