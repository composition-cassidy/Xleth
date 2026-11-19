#pragma once

// EqSlopeDesign.h - Low Pass / High Pass slopes for the Parametric EQ.
//
// A slope index picks how steep a LowPass / HighPass band falls off:
//
//   0   6 dB/oct   1st order (bilinear one-pole; Q ignored)
//   1  12 dB/oct   2nd order RBJ biquad with Q. THE DEFAULT and exactly the
//                  filter the EQ had before slopes existed (see computeCoefficients)
//   2  18 dB/oct   Butterworth order 3
//   3  24 dB/oct   Butterworth order 4
//   4  36 dB/oct   Butterworth order 6
//   5  48 dB/oct   Butterworth order 8
//   6  72 dB/oct   Butterworth order 12
//   7  96 dB/oct   Butterworth order 16
//   8  Brickwall   Chebyshev Type II order 16, 100 dB stop band (~250 dB/oct
//                  between the -3 dB point and full stop band)
//
// Every slope puts the -3 dB point at the band's frequency (Butterworth and the
// Chebyshev II after rescaling), so switching slope pivots the filter around its
// cutoff and the shapes line up for any given freq: a steeper slope is the same
// corner with a sharper wall. The Q knob is the resonance at the corner: for the
// Butterworth cascades it scales the highest-Q section by Q / (1/sqrt(2)), so
// the default Q (0.707) is the plain maximally-flat response and the 12 dB slope
// is exactly the old biquad. The 6 dB slope and the Brickwall have no resonance.
//
// Everything here is pure double arithmetic on scalars: no allocation, no state,
// safe on the audio thread. Sections are returned normalised (a0 = 1) in the
// same direct-form coefficients the EQ's biquad uses.

#include <algorithm>
#include <cmath>

namespace xleth::dsp::eqslope {

constexpr int kNumSlopes      = 9;
constexpr int kDefaultSlope   = 1;      // 12 dB/oct, the pre-slope behaviour
constexpr int kBrickwallSlope = 8;
constexpr int kMaxSections    = 8;      // order 16 -> 8 biquads (Butterworth 96, Brickwall)

constexpr double kPi        = 3.14159265358979323846;
constexpr double kButterQ   = 0.70710678118654752440;

struct Biquad
{
    double b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0;
};

struct Cascade
{
    int n = 0;
    Biquad s[kMaxSections];
};

inline int clampSlope(float value) noexcept
{
    const int v = static_cast<int>(std::lround(value));
    return std::clamp(v, 0, kNumSlopes - 1);
}

// Slopes that need more than one section (and therefore the double-precision
// cascade): 18 dB/oct and up. Slopes 0 and 1 stay single biquads.
inline bool isCascadeSlope(int slope) noexcept { return slope >= 2; }

// Filter order of a Butterworth slope (the Brickwall is its own design).
inline int butterworthOrder(int slope) noexcept
{
    static constexpr int kOrder[kNumSlopes] = { 1, 2, 3, 4, 6, 8, 12, 16, 16 };
    return kOrder[std::clamp(slope, 0, kNumSlopes - 1)];
}

inline const char* slopeLabel(int slope) noexcept
{
    static constexpr const char* kLabels[kNumSlopes] = {
        "6 dB/oct", "12 dB/oct", "18 dB/oct", "24 dB/oct", "36 dB/oct",
        "48 dB/oct", "72 dB/oct", "96 dB/oct", "Brickwall" };
    return kLabels[std::clamp(slope, 0, kNumSlopes - 1)];
}

// 1st-order bilinear section with K = tan(w0 / 2) (-3 dB at w0).
inline Biquad firstOrder(bool highPass, double K) noexcept
{
    Biquad q;
    const double inv = 1.0 / (1.0 + K);
    if (highPass) { q.b0 = inv;     q.b1 = -inv; }
    else          { q.b0 = K * inv; q.b1 =  K * inv; }
    q.b2 = 0.0;
    q.a1 = (K - 1.0) * inv;
    q.a2 = 0.0;
    return q;
}

// Bilinear transform (s = (1 - z^-1) / (1 + z^-1)) of an analog biquad
// (n2 s^2 + n1 s + n0) / (d2 s^2 + d1 s + d0), normalised so a0 = 1.
inline Biquad bilinear(double n2, double n1, double n0,
                       double d2, double d1, double d0) noexcept
{
    const double a0 = d2 + d1 + d0;
    const double inv = 1.0 / a0;
    Biquad q;
    q.b0 = (n2 + n1 + n0) * inv;
    q.b1 = 2.0 * (n0 - n2) * inv;
    q.b2 = (n2 - n1 + n0) * inv;
    q.a1 = 2.0 * (d0 - d2) * inv;
    q.a2 = (d2 - d1 + d0) * inv;
    return q;
}

// One analog 2nd-order prototype section (cutoff / reference frequency 1 rad/s)
// turned into a low-pass or high-pass at the pre-warped analog frequency
// `omega`: LP  s -> s / omega, HP  s -> omega / s.
inline Biquad sectionToDigital(bool highPass, double omega,
                               double n2, double n1, double n0,
                               double d2, double d1, double d0) noexcept
{
    if (!highPass)
        return bilinear(n2, n1 * omega, n0 * omega * omega,
                        d2, d1 * omega, d0 * omega * omega);
    return bilinear(n0, n1 * omega, n2 * omega * omega,
                    d0, d1 * omega, d2 * omega * omega);
}

// Chebyshev Type II low-pass prototype, even order N, stop band edge at 1 rad/s
// and `stopDb` of stop band attenuation. Sections have unity DC gain. `omegaC`
// is the analog frequency of its -3 dB point (< 1).
struct Cheby2Proto
{
    int    n = 0;
    double omegaC = 1.0;
    double n2[kMaxSections]{}, n0[kMaxSections]{}, d1[kMaxSections]{}, d0[kMaxSections]{};
};

inline Cheby2Proto makeCheby2Proto(int order, double stopDb) noexcept
{
    Cheby2Proto p;
    p.n = order / 2;
    const double inveps = std::sqrt(std::pow(10.0, stopDb / 10.0) - 1.0);
    const double v0 = std::asinh(inveps) / static_cast<double>(order);
    const double sh = std::sinh(v0), ch = std::cosh(v0);

    for (int k = 0; k < p.n; ++k)
    {
        // k = 0 holds the highest-Q poles (nearest the imaginary axis).
        const double theta = kPi * static_cast<double>(2 * (k + 1) - 1) / (2.0 * static_cast<double>(order));
        const double sig = -sh * std::sin(theta);
        const double om  =  ch * std::cos(theta);
        const double mag2 = sig * sig + om * om;       // |chebyshev-I pole|^2
        const double pm2  = 1.0 / mag2;                // |chebyshev-II pole|^2
        const double cosT = std::cos(theta);
        const double zk2  = 1.0 / (cosT * cosT);       // zero at +-j / cos(theta)

        p.d0[k] = pm2;
        p.d1[k] = -2.0 * (sig / mag2);                 // -2 Re(p), Re(p) = sig / mag2
        // Unity DC gain: (s^2 + zk2) * (pm2 / zk2)
        p.n2[k] = pm2 / zk2;
        p.n0[k] = pm2;
    }

    auto magSq = [&](double w) noexcept {
        double m = 1.0;
        for (int k = 0; k < p.n; ++k)
        {
            const double nr = p.n0[k] - p.n2[k] * w * w;
            const double dr = p.d0[k] - w * w;
            const double di = p.d1[k] * w;
            m *= (nr * nr) / (dr * dr + di * di);
        }
        return m;
    };

    // The -3 dB point sits in the monotonic pass band below the stop band edge.
    double lo = 1.0e-4, hi = 1.0;
    for (int i = 0; i < 80; ++i)
    {
        const double mid = 0.5 * (lo + hi);
        if (magSq(mid) > 0.5) lo = mid; else hi = mid;
    }
    p.omegaC = 0.5 * (lo + hi);
    return p;
}

// The slope's filter for a LowPass (highPass = false) or HighPass band.
// `q` is the band's Q knob (see the header note), `slope` is the index above
// (>= 2; lower slopes are single biquads, see firstOrder / the RBJ biquad).
inline void design(bool highPass, double freqHz, double q, int slope,
                   double sampleRate, Cascade& out) noexcept
{
    out.n = 0;
    const double f = std::clamp(freqHz, 1.0, 0.49 * sampleRate);
    const double w0 = 2.0 * kPi * f / sampleRate;
    const double K = std::tan(0.5 * w0);

    if (slope == kBrickwallSlope)
    {
        static const Cheby2Proto proto = makeCheby2Proto(16, 100.0);
        const double omega = highPass ? K * proto.omegaC : K / proto.omegaC;
        // Highest-Q poles last (they sit closest to the stop band edge).
        for (int k = proto.n - 1; k >= 0; --k)
            out.s[out.n++] = sectionToDigital(highPass, omega,
                                              proto.n2[k], 0.0, proto.n0[k],
                                              1.0, proto.d1[k], proto.d0[k]);
        return;
    }

    const int order = butterworthOrder(slope);
    const double qScale = std::max(q, 0.1) / kButterQ;

    if ((order & 1) != 0)
        out.s[out.n++] = firstOrder(highPass, K);

    // Ascending Q: k = 0 is the highest-Q (resonant) section and carries the knob.
    for (int k = order / 2 - 1; k >= 0; --k)
    {
        double qk = 1.0 / (2.0 * std::sin(kPi * static_cast<double>(2 * k + 1)
                                          / (2.0 * static_cast<double>(order))));
        if (k == 0) qk *= qScale;
        out.s[out.n++] = sectionToDigital(highPass, K, 0.0, 0.0, 1.0, 1.0, 1.0 / qk, 1.0);
    }
}

// |H(e^jw)|^2 of one section.
inline double magSq(const Biquad& c, double cosw, double sinw, double cos2w, double sin2w) noexcept
{
    const double nRe = c.b0 + c.b1 * cosw + c.b2 * cos2w;
    const double nIm =      - c.b1 * sinw - c.b2 * sin2w;
    const double dRe = 1.0 + c.a1 * cosw + c.a2 * cos2w;
    const double dIm =      - c.a1 * sinw - c.a2 * sin2w;
    const double d = dRe * dRe + dIm * dIm;
    return d > 1.0e-300 ? (nRe * nRe + nIm * nIm) / d : 1.0;
}

// |H|^2 of a whole cascade at digital frequency w (radians / sample).
inline double magSq(const Cascade& c, double w) noexcept
{
    const double cw = std::cos(w), sw = std::sin(w), c2 = std::cos(2.0 * w), s2 = std::sin(2.0 * w);
    double m = 1.0;
    for (int i = 0; i < c.n; ++i) m *= magSq(c.s[i], cw, sw, c2, s2);
    return m;
}

} // namespace xleth::dsp::eqslope
