#pragma once

#include <algorithm>
#include <array>
#include <cmath>

// Evaluate one CSS-style cubic-bezier sample. P0=(0,0) and P3=(1,1) are
// fixed; x is the normalized timeline position. This is shared by the audio
// LUT builder and video opacity evaluation so both domains follow exactly the
// same curve without building a full LUT for every video frame.
inline float evaluateClipFadeBezier(float x,
                                    float x1, float y1,
                                    float x2, float y2) noexcept
{
    if (x <= 0.0f) return 0.0f;
    if (x >= 1.0f) return 1.0f;

    // Newton-Raphson: find t where B_x(t) = x.
    float t = x;
    for (int iter = 0; iter < 5; ++iter)
    {
        const float omt  = 1.0f - t;
        const float omt2 = omt * omt;
        const float t2   = t * t;

        const float bx = 3.0f * omt2 * t * x1
                       + 3.0f * omt  * t2 * x2
                       + t2 * t;
        const float dbx = 3.0f * omt2 * x1
                        + 6.0f * omt * t * (x2 - x1)
                        + 3.0f * t2 * (1.0f - x2);

        if (std::fabs(dbx) < 1e-7f) break;
        t -= (bx - x) / dbx;
        t = std::clamp(t, 0.0f, 1.0f);
    }

    const float omt  = 1.0f - t;
    const float omt2 = omt * omt;
    const float t2   = t * t;
    return 3.0f * omt2 * t * y1
         + 3.0f * omt  * t2 * y2
         + t2 * t;
}

// Evaluate the user-authored clip fade envelope at a normalized clip position.
// Percentages are defensively clamped/normalized here because VideoEvent is an
// internal transport contract and may also be constructed directly by tests or
// bridge callers. Invisible boundary-declick fades are intentionally excluded.
inline float evaluateClipFadeGain(float clipProgress,
                                  float fadeInPercent,
                                  float fadeOutPercent,
                                  float fadeInX1, float fadeInY1,
                                  float fadeInX2, float fadeInY2,
                                  float fadeOutX1, float fadeOutY1,
                                  float fadeOutX2, float fadeOutY2) noexcept
{
    const float progress = std::clamp(clipProgress, 0.0f, 1.0f);
    float fadeInRatio = std::isfinite(fadeInPercent)
        ? std::clamp(fadeInPercent * 0.01f, 0.0f, 1.0f) : 0.0f;
    float fadeOutRatio = std::isfinite(fadeOutPercent)
        ? std::clamp(fadeOutPercent * 0.01f, 0.0f, 1.0f) : 0.0f;
    const float total = fadeInRatio + fadeOutRatio;
    if (total > 1.0f) {
        fadeInRatio /= total;
        fadeOutRatio /= total;
    }

    float gain = 1.0f;
    if (fadeInRatio > 0.0f && progress < fadeInRatio) {
        gain *= evaluateClipFadeBezier(
            progress / fadeInRatio,
            fadeInX1, fadeInY1, fadeInX2, fadeInY2);
    }

    const float remaining = 1.0f - progress;
    if (fadeOutRatio > 0.0f && remaining < fadeOutRatio) {
        gain *= evaluateClipFadeBezier(
            remaining / fadeOutRatio,
            fadeOutX1, fadeOutY1, fadeOutX2, fadeOutY2);
    }
    return gain;
}

// ─── ClipFadeLUT ─────────────────────────────────────────────────────────────
// Precomputed lookup table for CSS cubic-bezier fade curves.
// P0 = (0,0), P3 = (1,1) are fixed; caller supplies P1 = (x1,y1), P2 = (x2,y2).
//
// Usage (audio thread safe — stack-allocated, no heap, no locks):
//
//   ClipFadeLUT lut;
//   lut.build(x1, y1, x2, y2);          // once per clip per block
//   float gain = lut.sample(t);          // per sample, t in [0,1]

struct ClipFadeLUT
{
    static constexpr int kResolution = 256;

    std::array<float, kResolution + 1> table{};

    // Build the LUT from cubic-bezier control points.
    // Uses Newton-Raphson to invert B_x(t) for each uniformly-spaced x value,
    // then evaluates B_y(t) to get the gain.
    void build(float x1, float y1, float x2, float y2) noexcept
    {
        table[0] = 0.0f;
        table[kResolution] = 1.0f;

        for (int i = 1; i < kResolution; ++i)
        {
            const float x = static_cast<float>(i) / static_cast<float>(kResolution);
            table[i] = evaluateClipFadeBezier(x, x1, y1, x2, y2);
        }
    }

    // Sample the LUT with linear interpolation. t in [0,1].
    float sample(float t) const noexcept
    {
        if (t <= 0.0f) return 0.0f;
        if (t >= 1.0f) return 1.0f;

        const float pos = t * static_cast<float>(kResolution);
        const int   idx = static_cast<int>(pos);
        const float frac = pos - static_cast<float>(idx);

        return table[idx] + frac * (table[idx + 1] - table[idx]);
    }
};
