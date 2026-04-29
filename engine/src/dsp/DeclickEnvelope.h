#pragma once
#include <array>
#include <cmath>

namespace xleth::dsp {

// Lookup-table-backed Hann window for click-free clip boundary fades.
// Call initialize() once at engine boot (idempotent). Hot-path methods are
// header-inlined so the compiler can elide the call entirely when clipFadeN == 0.
class DeclickEnvelope {
public:
    static constexpr int kLutSize = 1024;

    // Call once at engine boot. Safe to call multiple times (no-op after first).
    static void initialize();

    // Hann fade-in gain. posInRamp = distance from clip start (0 = first sample).
    // Returns 0 at posInRamp=0, 1 when posInRamp >= rampLen, smooth Hann in between.
    static inline float fadeIn(int posInRamp, int rampLen) noexcept
    {
        if (rampLen <= 0 || posInRamp >= rampLen) return 1.0f;
        if (posInRamp <= 0) return 0.0f;
        const int idx = posInRamp * (kLutSize - 1) / rampLen;
        return sLut[idx];
    }

    // Hann fade-out gain. posFromEnd = samples remaining until clip end (0 = last sample).
    // Returns 0 at posFromEnd=0, 1 when posFromEnd >= rampLen, smooth Hann in between.
    static inline float fadeOut(int posFromEnd, int rampLen) noexcept
    {
        if (rampLen <= 0 || posFromEnd >= rampLen) return 1.0f;
        if (posFromEnd <= 0) return 0.0f;
        const int idx = posFromEnd * (kLutSize - 1) / rampLen;
        return sLut[idx];
    }

    // Convert milliseconds to samples. Clamped to >= 0.
    static inline int msToSamples(double ms, double sampleRate) noexcept
    {
        const int n = static_cast<int>(ms * sampleRate * 0.001 + 0.5);
        return n < 0 ? 0 : n;
    }

private:
    static std::array<float, kLutSize> sLut;
    static bool sInitialized;
};

} // namespace xleth::dsp
