#include "FrameCollector.h"

#include "model/Timeline.h"
#include "SyncManager.h"     // VideoEvent

#include <algorithm>
#include <cmath>
#include <cstdio>

// ===========================================================================
// Step 1: Collect requests for one output frame
// ===========================================================================

std::vector<CellFrameRequest> FrameCollector::collectRequests(
    int64_t                        outputFrameIndex,
    const Timeline&                timeline,
    int                            sampleRate,
    AVRational                     fps,
    const std::vector<VideoEvent>& events)
{
    const double bpm = timeline.getBPM();
    const GridLayout& layout = timeline.getGridLayout();

    // Convert output frame index → sample position → beat position.
    // Use RenderClock integer arithmetic for sample derivation, then convert
    // to beats for VideoEvent lookup (events use beat-based time).
    const int64_t samplePos = RenderClock::videoFrameToSample(outputFrameIndex, sampleRate, fps);
    const double  seconds   = RenderClock::sampleToSeconds(samplePos, sampleRate);
    const double  beatPos   = seconds * (bpm / 60.0);

    std::vector<CellFrameRequest> requests;
    int gapsSkipped = 0;

    // Helper lambda to build a CellFrameRequest from an active event
    auto buildRequest = [&](const VideoEvent* ev, int trackId,
                            int cellCol, int cellRow, int spanX, int spanY,
                            float slotOpacity, int zOrder,
                            bool isChorus, bool isCrash) -> bool
    {
        if (!ev) return false;

        // Look up source to get file path and fps
        const SourceMedia* src = timeline.getSource(ev->sourceId);
        if (!src || !src->hasVideo || src->filePath.empty()) return false;

        int64_t srcFrame = computeSourceFrame(*ev, beatPos, bpm, src->fps);

        // Hold-last-frame: if the computed source time exceeds the trim end,
        // always clamp to the last frame so active notes never go black.
        if (ev->sourceEndTime > 0.0) {
            const double beatsSince = beatPos - ev->startBeat;
            const double secsSince  = beatsSince * (60.0 / bpm);
            const double sourceTime = ev->sourceStartTime + secsSince;
            if (sourceTime >= ev->sourceEndTime) {
                srcFrame = computeSourceFrameFromTime(ev->sourceEndTime - 0.001, src->fps);
                std::fprintf(stderr, "[FrameCollector] Track %d: frame clamped to last frame %lld "
                             "(source time %.3fs >= trim end %.3fs)\n",
                             trackId, (long long)srcFrame, sourceTime, ev->sourceEndTime);
            }
        }

        CellFrameRequest req;
        req.cellCol          = cellCol;
        req.cellRow          = cellRow;
        req.spanX            = spanX;
        req.spanY            = spanY;
        // Prefer proxy (DNxHR, intra-only — fast frame-accurate seek)
        req.sourcePath       = (src->proxyReady && !src->proxyPath.empty())
                               ? src->proxyPath : src->filePath;
        req.sourceId         = ev->sourceId;
        req.sourceFrameIndex = srcFrame;
        req.opacity          = std::min(1.0f, std::max(0.0f, slotOpacity * ev->opacity));
        req.globalNoteIndex  = ev->globalNoteIndex;
        {
            const TrackInfo* trk = timeline.getTrack(trackId);
            req.flipMode = trk ? static_cast<int>(trk->videoFlipMode) : 0;
        }
        req.trackId          = trackId;
        req.isChorus         = isChorus;
        req.isCrash          = isCrash;
        req.zOrder           = zOrder;

        if (isChorus) {
            std::fprintf(stderr, "[FrameCollector] Chorus cell: '%s' frame=%lld opacity=%.2f\n",
                         req.sourcePath.c_str(), (long long)req.sourceFrameIndex, req.opacity);
        }
        if (isCrash) {
            std::fprintf(stderr, "[FrameCollector] Crash cell: '%s' frame=%lld opacity=%.2f\n",
                         req.sourcePath.c_str(), (long long)req.sourceFrameIndex, req.opacity);
        }

        requests.push_back(std::move(req));
        return true;
    };

    // a) CHORUS LAYER — fullscreen background (holds last frame during gaps)
    if (layout.chorusTrackId >= 0) {
        const VideoEvent* ev = findActiveEvent(events, timeline, layout.chorusTrackId, beatPos);
        if (buildRequest(ev, layout.chorusTrackId,
                          0, 0, layout.columns * 2, layout.rows * 2,
                          1.0f, -1, /*isChorus=*/true, false)) {
            // Active chorus — save frame for hold-through-gap
            const auto& chorusReq = requests.back();
            lastChorusSourceFrame_ = chorusReq.sourceFrameIndex;
            lastChorusSourcePath_  = chorusReq.sourcePath;
        } else if (lastChorusSourceFrame_ >= 0) {
            // Chorus gap — hold only if videoHoldLastFrame is enabled on the chorus track
            const TrackInfo* chorusTrack = timeline.getTrack(layout.chorusTrackId);
            if (chorusTrack && chorusTrack->videoHoldLastFrame) {
                std::fprintf(stderr, "[FrameCollector] Chorus gap: hold=ON frame=%lld\n",
                             (long long)lastChorusSourceFrame_);
                CellFrameRequest req;
                req.cellCol          = 0;
                req.cellRow          = 0;
                req.spanX            = layout.columns * 2;
                req.spanY            = layout.rows * 2;
                req.sourcePath       = lastChorusSourcePath_;
                req.sourceFrameIndex = lastChorusSourceFrame_;
                req.opacity          = 1.0f;
                req.isChorus         = true;
                req.zOrder           = -1;
                requests.push_back(std::move(req));
            } else {
                std::fprintf(stderr, "[FrameCollector] Chorus gap: hold=OFF\n");
                ++gapsSkipped;
            }
        } else {
            ++gapsSkipped;
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
                          slot.opacity, slot.zOrder, false, false)) {
            ++gapsSkipped;
        }
    }

    // c) CRASH OVERLAY — fullscreen on top
    if (layout.crashEnabled && layout.crashTrackId >= 0) {
        const VideoEvent* ev = findActiveEvent(events, timeline, layout.crashTrackId, beatPos);
        if (!buildRequest(ev, layout.crashTrackId,
                          0, 0, layout.columns * 2, layout.rows * 2,
                          layout.crashOpacity, 999, false, /*isCrash=*/true)) {
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

    // Find the latest-starting active event on this track
    const VideoEvent* best = nullptr;
    for (const auto& ev : events) {
        if (ev.trackId != trackId) continue;
        if (beatPos < ev.startBeat) continue;
        if (beatPos >= ev.startBeat + ev.durationBeats) continue;
        if (!best || ev.startBeat > best->startBeat) best = &ev;
    }
    return best;
}

int64_t FrameCollector::computeSourceFrame(
    const VideoEvent& ev,
    double            beatPos,
    double            bpm,
    double            sourceFps)
{
    // How far into this event are we (in seconds)?
    const double beatsSince = beatPos - ev.startBeat;
    const double secsSince  = beatsSince * (60.0 / bpm);
    const double sourceTime = ev.sourceStartTime + secsSince;

    return computeSourceFrameFromTime(sourceTime, sourceFps);
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
