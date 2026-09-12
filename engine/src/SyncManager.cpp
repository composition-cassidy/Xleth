#include "SyncManager.h"

#include <algorithm>

// This translation unit used to carry the realtime OpenGL preview path:
// videoTick() walked every VideoEvent, decoded a frame per active event into
// FrameCache, uploaded it to a VideoCompositor and set a layerIndex-ordered
// layer. That compositor is gone (Issue 10 in VIDEO_PREVIEW_AUDIT.txt).
//
// Two things made it worth removing rather than keeping "just in case":
//
//  1. It was a second, divergent ordering model. VideoCompositor sorted
//     layers by VideoEvent::layerIndex; the shipping path (FrameCollector →
//     GridCompositor, shared by preview AND export) orders by zOrder. Two
//     models for one concept is how grid/fullscreen interleaving ends up
//     right in one place and wrong in another.
//
//  2. The whole compositor block sat behind #ifndef XLETH_CORE_ONLY, and
//     XLETH_CORE_ONLY was defined on XlethEngineCore — the only target that
//     ever compiled this file. The standalone XlethEngine executable linked
//     that same static library, so the GPU branch was unreachable in EVERY
//     build in the tree, including the one it was supposedly kept for. What
//     remained live was the scaffolding around it: a per-event modulation
//     timing evaluation, a region-proxy map lookup and a timeToFrame() call
//     per active event, every tick, whose results nothing read — run on the
//     frame-pacing thread while holding syncEventsMutex, the lock shared with
//     the event-rebuild path. Plus an unbounded push_back into driftSamples_
//     (a permanently-0.0 metric) that could realloc under that same lock.
//
// What is left is the honest job: hold the event list, and report the beat
// position of the audio the user is hearing. See SyncManager.h.

SyncManager::SyncManager(Transport& transport,
                         std::function<int64_t()> presentationPositionProvider)
    : transport_(transport)
    , presentationPositionProvider_(std::move(presentationPositionProvider))
{
}

void SyncManager::addEvent(const VideoEvent& event)
{
    events_.push_back(event);
}

void SyncManager::clearEvents()
{
    events_.clear();
    slideEvents_.clear();

    // Reset preview hold state (prevents stale holds across seek/stop/project switch)
    previewLastChorusFrame    = -1;
    previewLastChorusSourceId = -1;
    previewLastGridCellKey.clear();
}

double SyncManager::currentBeatPosition() const
{
    if (!transport_.isPlaying())
        return -1.0;

    const double sampleRate = transport_.getSampleRate();
    const double bpm        = transport_.getBPM();
    if (!(sampleRate > 0.0) || !(bpm > 0.0))
        return 0.0;

    // Prefer the position of the audio actually leaving the device over the
    // position already rendered — that is what the picture must line up with.
    const int64_t audioTimeSamples = std::max<int64_t>(
        0,
        presentationPositionProvider_
            ? presentationPositionProvider_()
            : transport_.getPositionSamples());

    return (static_cast<double>(audioTimeSamples) * bpm) / (60.0 * sampleRate);
}
