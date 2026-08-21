#pragma once

// ── NOT the same function as util/ParamTrackEase.h ─────────────────────────
// These two headers are intentionally separate and must NOT be merged.
// This one is a 1-D bezier evaluated directly in t: it ignores cx, forces the
// second control point to (1 - cy), and is frozen byte-for-byte because the
// Sampler group-slide (realtime audio path) and the slide-curve visual goldens
// depend on its exact output. ParamTrackEase is a parametric 2-D curve that
// solves x -> t with unclamped y control points, per CSS cubic-bezier
// semantics. Unifying them would change Sampler audio output.
// See the header comment in util/ParamTrackEase.h for the full comparison.
//
// Cubic bezier easing. Preserved byte-for-byte from the original definition
// in AnimationManager.cpp so visual animation goldens stay stable. The cx
// parameter is intentionally unused — the legacy formula reads cy alone and
// treats the second control point symmetrically by using (1 - cy). Shared
// by the visual animation pipeline (AnimationManager) and the audio pipeline
// (Sampler group-slide). Pure, stateless, header-only — safe for the
// realtime audio thread (no allocation, no JUCE/OpenGL deps).
inline float bezierEase(float t, [[maybe_unused]] float cx, float cy) {
    const float u = 1.0f - t;
    const float tt = t * t;
    const float uu = u * u;
    return 3.0f * uu * t * cy + 3.0f * u * tt * (1.0f - cy) + tt * t;
}
