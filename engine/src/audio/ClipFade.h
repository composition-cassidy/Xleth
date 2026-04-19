#pragma once

#include <array>
#include <cmath>

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

            // Newton-Raphson: find t where B_x(t) = x
            float t = x; // initial guess
            for (int iter = 0; iter < 5; ++iter)
            {
                const float omt  = 1.0f - t;
                const float omt2 = omt * omt;
                const float t2   = t * t;

                // B_x(t) = 3(1-t)^2 * t * x1 + 3(1-t) * t^2 * x2 + t^3
                const float bx = 3.0f * omt2 * t * x1
                               + 3.0f * omt  * t2 * x2
                               + t2 * t;

                // B_x'(t) = 3(1-t)^2 * x1 + 6(1-t)*t*(x2 - x1) + 3*t^2*(1 - x2)
                const float dbx = 3.0f * omt2 * x1
                                + 6.0f * omt * t * (x2 - x1)
                                + 3.0f * t2 * (1.0f - x2);

                if (std::fabs(dbx) < 1e-7f) break;
                t -= (bx - x) / dbx;
                if (t < 0.0f) t = 0.0f;
                if (t > 1.0f) t = 1.0f;
            }

            // Evaluate B_y(t)
            const float omt  = 1.0f - t;
            const float omt2 = omt * omt;
            const float t2   = t * t;
            table[i] = 3.0f * omt2 * t * y1
                      + 3.0f * omt  * t2 * y2
                      + t2 * t;
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
