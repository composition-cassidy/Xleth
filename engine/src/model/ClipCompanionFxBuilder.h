#pragma once

// ClipCompanionFxBuilder — single shared producer of ClipCompanionFxSnapshot.
//
// FrameCollector feeds the snapshot to the GridCompositor per-pixel kernels on
// both the preview and the export pass. It was written as the single producer
// so those two could not drift apart, and it stays the single producer now that
// the separate OpenGL preview path is gone (Issue 10). It enforces the gating
// rules:
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
