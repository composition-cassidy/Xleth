#pragma once

// ClipCompanionFxBuilder — single shared producer of ClipCompanionFxSnapshot.
//
// Both the export pipeline (FrameCollector) and the realtime OpenGL preview
// path (SyncManager → VideoCompositor) feed the snapshot to their respective
// per-pixel kernels. To avoid two truths drifting apart, both call this
// builder, which enforces the gating rules:
//
//   - timing must be active
//   - swirl populated only when vibrato is active AND vibratoSwirlEnabled
//   - wave populated only when scratch is active AND scratchWaveEnabled
//
// Compositor-agnostic: the inputs and the snapshot are plain model types.

#include "ClipCompanionFxSnapshot.h"
#include "ClipVideoModulationTiming.h"
#include "TimelineTypes.h"

namespace xleth::clipmod {

ClipCompanionFxSnapshot buildClipCompanionFxSnapshot(
    const ClipModulation& modulation,
    const VideoModulationTimingResult& timing) noexcept;

} // namespace xleth::clipmod
