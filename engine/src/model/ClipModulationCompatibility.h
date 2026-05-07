#pragma once

// Shared compatibility predicate for Clip Modulation FX (vibrato + scratch).
//
// Three call sites historically held byte-identical copies of this rule:
//   - engine/src/audio/MixEngine.cpp        (selects ClipModulatedReader vs cache path)
//   - engine/src/SyncManager.cpp            (realtime preview video timing)
//   - engine/src/render/FrameCollector.cpp  (export-time video timing + companion FX)
//
// The helper lives in the model layer so audio, realtime video, and export
// render can all consume it without crossing layer boundaries. Pure / header-
// only / noexcept — safe to call from the audio render path.
//
// Compatibility rule: a clip is modulation-compatible iff the modulation root
// is enabled, at least one curve (vibrato or scratch) is enabled, and the clip
// is not using reverse or formant-preserve processing. Stretched clips are
// compatible as of F.1 because MixEngine routes them through ClipRenderCache's
// clip-local post-stretch buffer before applying modulation.
//
// Static pitch (pitchOffset semis + pitchOffsetCents) is INTENTIONALLY NOT in
// the bypass list — both the audio reader and the video timing helper apply
// it correctly inside the modulation path.

#include "TimelineTypes.h"

namespace xleth::clipmod {

inline bool isClipModulationCompatible(
    bool clipReversed,
    double clipStretchRatio,
    bool clipFormantPreserve,
    const ClipModulation& mod) noexcept
{
    (void)clipStretchRatio;
    return mod.enabled
        && (mod.vibrato.enabled || mod.scratch.enabled)
        && !clipReversed
        && !clipFormantPreserve;
}

// Precise reason a clip's modulation was bypassed. Pure helper for tests and
// future UI/bridge code; NOT called from the audio render path in F.0.
enum class ClipModulationBypassReason {
    None,             // compatible (no bypass)
    Disabled,         // modulation root disabled
    NoActiveCurve,    // root enabled but neither vibrato nor scratch enabled
    Reversed,         // clip plays in reverse
    Stretched,        // legacy / reserved; stretch is supported in F.1
    FormantPreserve,  // formant-preserve processing on
};

inline ClipModulationBypassReason classifyClipModulationBypass(
    bool clipReversed,
    double clipStretchRatio,
    bool clipFormantPreserve,
    const ClipModulation& mod) noexcept
{
    (void)clipStretchRatio;
    if (!mod.enabled) return ClipModulationBypassReason::Disabled;
    if (!mod.vibrato.enabled && !mod.scratch.enabled)
        return ClipModulationBypassReason::NoActiveCurve;
    if (clipReversed)            return ClipModulationBypassReason::Reversed;
    if (clipFormantPreserve)     return ClipModulationBypassReason::FormantPreserve;
    return ClipModulationBypassReason::None;
}

} // namespace xleth::clipmod
