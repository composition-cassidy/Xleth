#include "dsp/DryWetAlign.h"

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <cmath>
#include <vector>

namespace xleth::dsp
{
namespace
{
    static constexpr int kMaxAnalysisSamples = 1 << 18;

    std::vector<float> monoSum(const juce::AudioBuffer<float>& b, int len)
    {
        len = std::clamp(len, 0, b.getNumSamples());
        std::vector<float> m(static_cast<std::size_t>(len), 0.0f);
        const int ch = b.getNumChannels();
        if (ch <= 0) return m;
        const float scale = 1.0f / static_cast<float>(ch);
        for (int c = 0; c < ch; ++c)
        {
            const float* p = b.getReadPointer(c);
            for (int i = 0; i < len; ++i) m[static_cast<std::size_t>(i)] += p[i] * scale;
        }
        return m;
    }

    // Rectify, smooth (one-pole, ~2 ms), remove the mean.
    std::vector<float> envelope(const std::vector<float>& x, double sampleRate)
    {
        std::vector<float> e(x.size());
        const double tau   = 0.002 * std::max(1.0, sampleRate);
        const float  alpha = static_cast<float>(1.0 - std::exp(-1.0 / tau));
        float state = 0.0f;
        double sum = 0.0;
        for (std::size_t i = 0; i < x.size(); ++i)
        {
            state += alpha * (std::abs(x[i]) - state);
            e[i] = state;
            sum += state;
        }
        const float mean = x.empty() ? 0.0f : static_cast<float>(sum / static_cast<double>(x.size()));
        for (auto& v : e) v -= mean;
        return e;
    }
} // namespace

LagEstimate correlationPeak(const float* dry, int dryLen,
                            const float* wet, int wetLen, int maxLag)
{
    LagEstimate out;
    dryLen = std::clamp(dryLen, 0, kMaxAnalysisSamples);
    wetLen = std::clamp(wetLen, 0, kMaxAnalysisSamples);
    maxLag = std::max(0, maxLag);
    if (dryLen <= 0 || wetLen <= 0) return out;

    double ed = 0.0, ew = 0.0;
    for (int i = 0; i < dryLen; ++i) ed += static_cast<double>(dry[i]) * dry[i];
    for (int i = 0; i < wetLen; ++i) ew += static_cast<double>(wet[i]) * wet[i];
    if (ed <= 1e-12 || ew <= 1e-12) return out;

    // r[k] = sum_i dry[i] * wet[i + k], computed circularly. Both signals are
    // zero past their lengths, so with N >= max(len) + maxLag a wrapped term
    // for |k| <= maxLag always multiplies a zero: no circular aliasing.
    const int need = std::max(dryLen, wetLen) + maxLag + 1;
    int order = 1;
    while ((1 << order) < need) ++order;
    const int N = 1 << order;

    juce::dsp::FFT fft(order);
    using C = juce::dsp::Complex<float>;
    std::vector<C> a(static_cast<std::size_t>(N)), b(static_cast<std::size_t>(N)),
                   fa(static_cast<std::size_t>(N)), fb(static_cast<std::size_t>(N));
    for (int i = 0; i < dryLen; ++i) a[static_cast<std::size_t>(i)] = C(dry[i], 0.0f);
    for (int i = 0; i < wetLen; ++i) b[static_cast<std::size_t>(i)] = C(wet[i], 0.0f);
    fft.perform(a.data(), fa.data(), false);
    fft.perform(b.data(), fb.data(), false);
    for (int i = 0; i < N; ++i)
        fa[static_cast<std::size_t>(i)] = std::conj(fa[static_cast<std::size_t>(i)])
                                        * fb[static_cast<std::size_t>(i)];
    // JUCE's inverse transform is normalised by 1/N already.
    fft.perform(fa.data(), a.data(), true);

    const double norm = std::sqrt(ed * ew);
    double best = -2.0;
    int bestLag = 0;
    const int limit = std::min(maxLag, N / 2 - 1);
    for (int k = -limit; k <= limit; ++k)
    {
        const int idx = k >= 0 ? k : N + k;
        const double v = static_cast<double>(a[static_cast<std::size_t>(idx)].real()) / norm;
        // Ties go to the smaller |lag|: a periodic signal peaks every period,
        // and the nearest peak is the least surprising compensation.
        if (v > best + 1e-9 || (std::abs(v - best) <= 1e-9 && std::abs(k) < std::abs(bestLag)))
        {
            best = v;
            bestLag = k;
        }
    }
    out.lagSamples = bestLag;
    out.peak       = best;
    return out;
}

LagEstimate estimateWetLag(const juce::AudioBuffer<float>& dry, int dryLen,
                           const juce::AudioBuffer<float>& wet, int wetLen,
                           int maxLag, bool samePitch, double sampleRate)
{
    const int n = std::min({ dryLen, wetLen, kMaxAnalysisSamples });
    const auto d = monoSum(dry, n);
    const auto w = monoSum(wet, n);

    if (samePitch)
    {
        LagEstimate waveform = correlationPeak(d.data(), static_cast<int>(d.size()),
                                               w.data(), static_cast<int>(w.size()), maxLag);
        waveform.basis     = LagEstimate::Basis::Waveform;
        waveform.confident = waveform.peak >= kWaveformConfidence;
        return waveform;
    }

    const auto de = envelope(d, sampleRate);
    const auto we = envelope(w, sampleRate);
    LagEstimate env = correlationPeak(de.data(), static_cast<int>(de.size()),
                                      we.data(), static_cast<int>(we.size()), maxLag);
    env.basis     = LagEstimate::Basis::Envelope;
    env.confident = env.peak >= kEnvelopeConfidence;
    return env;
}

} // namespace xleth::dsp
