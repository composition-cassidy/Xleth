#include "dsp/VarispeedResample.h"

#include <algorithm>
#include <cmath>

namespace xleth::dsp {

namespace {

// Kernel half-width in OUTPUT-rate terms. 16 (a 32-tap sinc at unity ratio)
// is the usual "good offline resampler" figure — enough taps for the Blackman
// window to bury the stopband well below the noise floor of anything that
// reaches this code, and cheap enough that even a 16× decimation's widened
// kernel (512 taps) is a handful of seconds on a long file, once, per edit.
constexpr int kHalfTaps = 16;

double sinc(double x) noexcept {
    if (std::abs(x) < 1e-9) return 1.0;
    const double px = 3.14159265358979323846 * x;
    return std::sin(px) / px;
}

// Blackman window over t ∈ [-1, 1], zero at both ends.
double blackman(double t) noexcept {
    const double a = 3.14159265358979323846 * (t + 1.0);   // 0..2π
    return 0.42 - 0.5 * std::cos(a) + 0.08 * std::cos(2.0 * a);
}

} // namespace

double varispeedRatio(double cents) noexcept {
    if (!std::isfinite(cents)) cents = 0.0;
    cents = std::clamp(cents, -kVarispeedMaxCents, kVarispeedMaxCents);
    return std::pow(2.0, cents / 1200.0);
}

int64_t varispeedOutputLength(int64_t inputLength, double cents) noexcept {
    if (inputLength <= 0) return 0;
    const double ratio = varispeedRatio(cents);
    const double len   = static_cast<double>(inputLength) / ratio;
    // llround, not truncation: a 2-cent move on a short buffer must not lose a
    // sample to the floor every time it is re-applied.
    return std::max<int64_t>(1, static_cast<int64_t>(std::llround(len)));
}

void resampleVarispeed(const float* in, int64_t inLen,
                       float* out, int64_t outLen,
                       double ratio) noexcept {
    if (!out || outLen <= 0) return;
    if (!in || inLen <= 0 || !std::isfinite(ratio) || ratio <= 0.0) {
        std::fill(out, out + outLen, 0.0f);
        return;
    }

    // cutoff is a fraction of the INPUT Nyquist. Decimating (ratio > 1) has to
    // band-limit to the OUTPUT Nyquist before it throws samples away, which is
    // exactly 1/ratio of the input's; interpolating needs no band-limiting at
    // all, so the kernel stays at full width.
    const double cutoff = std::min(1.0, 1.0 / ratio);
    const double radius = static_cast<double>(kHalfTaps) / cutoff;
    const auto   halfW  = static_cast<int64_t>(std::ceil(radius));

    for (int64_t n = 0; n < outLen; ++n) {
        const double pos = static_cast<double>(n) * ratio;
        const auto   mid = static_cast<int64_t>(std::floor(pos));

        double acc = 0.0;
        double wsum = 0.0;
        const int64_t first = std::max<int64_t>(0, mid - halfW + 1);
        const int64_t last  = std::min<int64_t>(inLen - 1, mid + halfW);

        for (int64_t j = first; j <= last; ++j) {
            const double d = static_cast<double>(j) - pos;
            const double t = d / radius;
            if (t <= -1.0 || t >= 1.0) continue;      // outside the window
            const double w = sinc(d * cutoff) * blackman(t);
            acc  += static_cast<double>(in[j]) * w;
            wsum += w;
        }

        // Normalizing by the weight actually summed gives unity DC gain for
        // free — at any ratio, at any fractional phase, and at the buffer edges
        // where part of the kernel hangs off the end. A fixed `* cutoff` scale
        // would be right only in the interior and only on average.
        out[n] = (std::abs(wsum) > 1e-12)
            ? static_cast<float>(acc / wsum)
            : 0.0f;
    }
}

} // namespace xleth::dsp
