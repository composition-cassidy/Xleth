#pragma once

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
