#include "dsp/PhaseVocoder.h"
#include "XlethDebug.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <vector>

// ─── Internal helpers ─────────────────────────────────────────────────────────

namespace {

// STFT parameters — match the Python reference (autotune_stft_pitchshift v12)
static constexpr int    kWindowSize = 1024;   // Hann analysis window
static constexpr int    kFftSize    = 4096;   // zero-padded FFT (4× oversampling)
static constexpr int    kFftOrder   = 12;     // log2(4096)
static constexpr int    kHopSize    = 256;    // 75% overlap
static constexpr int    kNumBins    = kFftSize / 2 + 1;  // 2049 positive-freq bins
static constexpr float  kSilenceRMS = 1.0e-3f;           // ≈ −60 dB
static constexpr double kPi         = 3.14159265358979323846;
static constexpr float  kPif        = 3.14159265358979323846f;

static std::vector<float> buildHannWindow()
{
    std::vector<float> w(kWindowSize);
    for (int n = 0; n < kWindowSize; ++n)
        w[n] = 0.5f * (1.0f - std::cos(2.0f * kPif * n / (kWindowSize - 1)));
    return w;
}

static float computeRMS(const float* x, int N)
{
    if (N <= 0) return 0.0f;
    double s = 0.0;
    for (int i = 0; i < N; ++i) s += (double)x[i] * x[i];
    return (float)std::sqrt(s / N);
}

// Wrap phase to (−π, π].
static float wrapPhase(float p)
{
    return p - 2.0f * kPif * std::round(p / (2.0f * kPif));
}

// Lanczos-3 kernel: L(x) = 3·sin(πx)·sin(πx/3) / (π²x²), |x|<3, else 0; x→0 → 1.
static float lanczos3(float x)
{
    const float ax = std::abs(x);
    if (ax < 1e-6f) return 1.0f;
    if (ax >= 3.0f) return 0.0f;
    const float pi_x = kPif * x;
    const float pi_x3 = kPif * x / 3.0f;
    return 3.0f * std::sin(pi_x) * std::sin(pi_x3) / (kPif * kPif * x * x);
}

// ─── Lanczos-3 spectral resampling ───────────────────────────────────────────
// Resamples magnitude and instantaneous-frequency arrays along the frequency
// axis by pitchRatio. Output bin k maps to input position k/pitchRatio.
// IFs are scaled by pitchRatio after interpolation.
// Bins whose shifted IF falls outside (0, nyquist) are zeroed.
static void lanczos3PitchShift(
    const float* magIn,  const float* freqIn,
    float*       magOut, float*       freqOut,
    int numBins, float pitchRatio, float nyquist)
{
    for (int k = 0; k < numBins; ++k) {
        const float k_in = (float)k / pitchRatio;
        const int   kc   = (int)std::round(k_in);

        float magW = 0.0f, freqW = 0.0f, wSum = 0.0f;
        for (int tap = kc - 2; tap <= kc + 3; ++tap) {
            if (tap < 0 || tap >= numBins) continue;
            const float w = lanczos3(k_in - (float)tap);
            magW  += magIn [tap] * w;
            freqW += freqIn[tap] * w;
            wSum  += w;
        }

        if (wSum > 1e-10f) {
            magOut [k] = magW  / wSum;
            freqOut[k] = freqW / wSum * pitchRatio;
        } else {
            magOut [k] = 0.0f;
            freqOut[k] = 0.0f;
        }

        // Kill bins whose shifted frequency is outside the representable range.
        if (freqOut[k] <= 0.0f || freqOut[k] >= nyquist)
            magOut[k] = 0.0f;
    }
}

// ─── Per-channel phase vocoder ────────────────────────────────────────────────
//
// All stages (forward STFT, encode, optional formant, time-stretch, pitch-shift,
// decode, inverse STFT + OLA) are done here so the channel loop in the public
// API stays trivial.
//
static std::vector<float> processMonoPV(
    const float*              input,
    int                       N,
    int                       outN,
    double                    sratio,
    float                     pitchRatio,
    bool                      formantPreserve,
    float                     sampleRate,
    const std::vector<float>& hannWindow,
    juce::dsp::FFT&           fft)
{
    // Derived constants for this sample rate.
    const float freqInc     = sampleRate / (float)kFftSize;   // Hz per bin
    const float phaseInc    = 2.0f * kPif * (float)kHopSize / (float)kFftSize;
    const float invPhaseInc = 1.0f / phaseInc;
    // phaseOverFreq: converts instantaneous frequency (Hz) → phase advance per hop
    const float phaseOverFreq = phaseInc / freqInc;  // = 2π·hopSize/sampleRate
    const float nyquist       = sampleRate * 0.5f;
    // invFftSize removed — JUCE's performRealOnlyInverseTransform already divides by N.

    // Cepstral lifter quefrency cutoff: ~1 ms of "time" in the log-mag domain.
    const int lifterQ = formantPreserve
        ? std::max(4, std::min(kNumBins / 2, (int)std::round(0.001 * sampleRate)))
        : 0;

    // ─── Stage 1 + 2 (+ optional 5a): Forward STFT → encode + cepstral env ──

    const int n_analysis = (N + kHopSize - 1) / kHopSize + 1;

    std::vector<float> mags  (n_analysis * kNumBins, 0.0f);
    std::vector<float> ifreqs(n_analysis * kNumBins, 0.0f);
    std::vector<float> envs  ;
    if (formantPreserve)
        envs.assign(n_analysis * kNumBins, 1.0f);

    {
        std::vector<float> buf   (2 * kFftSize, 0.0f);
        std::vector<float> envBuf(formantPreserve ? 2 * kFftSize : 0, 0.0f);
        std::vector<float> prevPh(kNumBins, 0.0f);

        for (int m = 0; m < n_analysis; ++m) {

            // ── Stage 1: windowed, zero-padded frame → FFT ─────────────────
            std::fill(buf.begin(), buf.end(), 0.0f);
            const int fstart = m * kHopSize;
            for (int n = 0; n < kWindowSize; ++n) {
                const int idx = fstart + n;
                buf[n] = (idx < N) ? input[idx] * hannWindow[n] : 0.0f;
            }

            // Full-spectrum forward FFT.
            // After this: buf[2k], buf[2k+1] = re(k), im(k) for k=0..kFftSize-1.
            fft.performRealOnlyForwardTransform(buf.data(), false);

            float* row_mag   = mags  .data() + m * kNumBins;
            float* row_ifreq = ifreqs.data() + m * kNumBins;

            // ── Stage 2: complex → magnitude + instantaneous frequency ─────
            for (int k = 0; k < kNumBins; ++k) {
                const float re    = buf[2 * k    ];
                const float im    = buf[2 * k + 1];
                const float mag   = std::sqrt(re * re + im * im);

                row_mag[k] = mag;

                if (mag < 1e-6f) {
                    // Near-silent bin: don't update prevPh or compute IF from noise.
                    // Default to bin centre frequency so interpolation is smooth.
                    row_ifreq[k] = (float)k * freqInc;
                    continue;
                }

                const float phase = std::atan2(im, re);

                // Wrap phase deviation from expected advance, convert to Hz.
                const float wrapped = wrapPhase(phase - prevPh[k]
                                                - (float)k * phaseInc);
                prevPh[k] = phase;

                row_ifreq[k] = ((float)k + wrapped * invPhaseInc) * freqInc;
            }

            // ── Stage 5a: cepstral spectral envelope (formant preservation) ─
            if (formantPreserve) {
                float* env = envs.data() + m * kNumBins;

                // Treat log-magnitude as a "time-domain" signal; FFT it to get
                // the cepstrum. Low quefrency = smooth envelope.
                std::fill(envBuf.begin(), envBuf.end(), 0.0f);
                for (int k = 0; k < kNumBins; ++k)
                    envBuf[k] = std::log(std::max(row_mag[k], 1e-8f));

                fft.performRealOnlyForwardTransform(envBuf.data(), false);

                // Lifter: zero out quefrency indices [lifterQ+1, kFftSize-lifterQ).
                // The forward transform of a real signal is Hermitian, so zeroing
                // this symmetric band keeps the IFFT output real.
                for (int q = lifterQ + 1; q < kFftSize - lifterQ; ++q) {
                    envBuf[2 * q    ] = 0.0f;
                    envBuf[2 * q + 1] = 0.0f;
                }

                fft.performRealOnlyInverseTransform(envBuf.data());

                // exp(smoothed log-mag) → spectral envelope; divide mags.
                for (int k = 0; k < kNumBins; ++k) {
                    env[k] = std::exp(envBuf[k]);
                    if (env[k] > 1e-8f) row_mag[k] /= env[k];
                    else                row_mag[k]  = 0.0f;
                }
            }
        }
    } // buf, envBuf, prevPh released

    // ─── Stage 3 + 4 (+ optional 5b): Time-stretch → pitch-shift → env restore

    // Number of synthesis frames needed to generate outN samples via OLA.
    const int n_out = (outN + kHopSize - 1) / kHopSize + 2;

    std::vector<float> outMags  (n_out * kNumBins, 0.0f);
    std::vector<float> outIfreqs(n_out * kNumBins, 0.0f);

    const bool doPitch = (std::abs(pitchRatio - 1.0f) >= 0.001f);

    {
        std::vector<float> intMag (kNumBins);
        std::vector<float> intFreq(kNumBins);

        for (int j = 0; j < n_out; ++j) {

            // ── Stage 3: map output frame j to analysis frame position ─────
            const double ipos = (double)j / sratio;
            const int    m0   = std::min((int)ipos,     n_analysis - 1);
            const int    m1   = std::min(m0 + 1,        n_analysis - 1);
            const float  a    = (float)(ipos - (double)m0);

            const float* mag0  = mags  .data() + m0 * kNumBins;
            const float* mag1  = mags  .data() + m1 * kNumBins;
            const float* frq0  = ifreqs.data() + m0 * kNumBins;
            const float* frq1  = ifreqs.data() + m1 * kNumBins;

            // Linear interpolation between adjacent analysis frames.
            // Instantaneous frequencies interpolate correctly unlike raw phases.
            for (int k = 0; k < kNumBins; ++k) {
                intMag [k] = mag0[k] + a * (mag1[k] - mag0[k]);
                intFreq[k] = frq0[k] + a * (frq1[k] - frq0[k]);
            }

            float* outM = outMags  .data() + j * kNumBins;
            float* outF = outIfreqs.data() + j * kNumBins;

            // ── Stage 4: Lanczos-3 spectral resampling along frequency axis ─
            if (doPitch) {
                lanczos3PitchShift(intMag.data(), intFreq.data(),
                                   outM, outF, kNumBins, pitchRatio, nyquist);
            } else {
                std::copy(intMag .begin(), intMag .end(), outM);
                std::copy(intFreq.begin(), intFreq.end(), outF);
            }

            // ── Stage 5b: re-apply original spectral envelope ─────────────
            if (formantPreserve && !envs.empty()) {
                // Use the analysis-frame envelope (not the shifted one) so that
                // formant positions remain at their original frequencies.
                const float* env = envs.data() + m0 * kNumBins;
                for (int k = 0; k < kNumBins; ++k)
                    outM[k] *= env[k];
            }
        }
    }

    // ─── Stage 6 + 7: Decode (IF → complex) + inverse STFT + OLA ────────────

    const int outBufSize = outN + kWindowSize; // headroom for last frame's tail
    std::vector<float> output(outBufSize, 0.0f);
    std::vector<float> wsum  (outBufSize, 0.0f);

    {
        std::vector<float> buf    (2 * kFftSize, 0.0f);
        std::vector<float> accumPh(kNumBins, 0.0f);

        for (int j = 0; j < n_out; ++j) {
            const float* outM = outMags  .data() + j * kNumBins;
            const float* outF = outIfreqs.data() + j * kNumBins;

            // ── Stage 6: instantaneous frequency → phase accumulation ───────
            std::fill(buf.begin(), buf.end(), 0.0f);

            for (int k = 0; k < kNumBins; ++k) {
                // phaseOverFreq converts Hz → radians per hop.
                // Only accumulate phase when the bin has real content — letting
                // phase drift through silence produces click artifacts at onsets.
                if (outM[k] > 1e-6f)
                    accumPh[k] += outF[k] * phaseOverFreq;
                buf[2 * k    ] = outM[k] * std::cos(accumPh[k]);
                buf[2 * k + 1] = outM[k] * std::sin(accumPh[k]);
            }

            // Enforce zero imaginary for DC and Nyquist bins.
            buf[1]                      = 0.0f;
            buf[kFftSize + 1]           = 0.0f; // buf[2*(kFftSize/2)+1]

            // Fill conjugate-mirror bins so performRealOnlyInverseTransform
            // receives the full complex spectrum it expects.
            for (int k = 1; k < kFftSize / 2; ++k) {
                buf[2 * (kFftSize - k)    ] =  buf[2 * k    ];
                buf[2 * (kFftSize - k) + 1] = -buf[2 * k + 1];
            }

            // ── Stage 7: inverse FFT + windowed OLA ─────────────────────────
            fft.performRealOnlyInverseTransform(buf.data());
            // buf[0..kFftSize-1] now contains the real output, unscaled (×kFftSize).

            const int outBase = j * kHopSize;
            for (int n = 0; n < kWindowSize; ++n) {
                const int oi = outBase + n;
                if (oi >= outBufSize) break;
                // Apply synthesis Hann window. JUCE IFFT already divided by kFftSize.
                const float s = buf[n] * hannWindow[n];
                output[oi] += s;
                wsum  [oi] += hannWindow[n] * hannWindow[n];
            }
        }
    }

    // Normalize OLA accumulation.
    for (int i = 0; i < outBufSize; ++i)
        if (wsum[i] > 1.0e-6f) output[i] /= wsum[i];

    // Trim to the requested output length.
    if ((int)output.size() > outN) output.resize(outN);
    return output;
}

} // anonymous namespace

// ─── Public API ───────────────────────────────────────────────────────────────

namespace xleth::dsp {

juce::AudioBuffer<float> processPhaseVocoder(
    const juce::AudioBuffer<float>& input,
    const PhaseVocoderParams& params)
{
    juce::ScopedNoDenormals noDenormals;

    const int N     = input.getNumSamples();
    const int numCh = input.getNumChannels();
    if (N == 0 || numCh == 0) return juce::AudioBuffer<float>();

    const double sratio = std::max(0.1, params.stretchRatio);

    float pitchRatio = 1.0f;
    if (std::abs(params.pitchShiftSemitones) >= 0.01) {
        pitchRatio = (float)std::pow(2.0, params.pitchShiftSemitones / 12.0);
        pitchRatio = std::max(0.1f, std::min(10.0f, pitchRatio));
    }

    // Near-identity early exit.
    if (std::abs(pitchRatio - 1.0f) < 0.001f && std::abs((float)sratio - 1.0f) < 0.001f) {
#ifdef XLETH_DEBUG
        fprintf(stderr, "[PhaseVocoder] skip: near-identity params, returning copy\n");
#endif
        juce::AudioBuffer<float> out(numCh, N);
        for (int ch = 0; ch < numCh; ++ch)
            out.copyFrom(ch, 0, input, ch, 0, N);
        return out;
    }

    const int outN = std::max(1, (int)std::round((double)N * sratio));

    // Short-signal fallback: can't form even one STFT frame → linear resample.
    if (N < kWindowSize) {
#ifdef XLETH_DEBUG
        fprintf(stderr, "[PhaseVocoder] fallback: input too short (%d < %d), using linear resample\n",
                N, kWindowSize);
#endif
        juce::AudioBuffer<float> out(numCh, outN);
        out.clear();
        for (int ch = 0; ch < numCh; ++ch) {
            const float* in = input.getReadPointer(ch);
            float*       op = out.getWritePointer(ch);
            for (int i = 0; i < outN; ++i) {
                const double srcPos = (outN > 1)
                    ? (double)i * (double)(N - 1) / (double)(outN - 1) : 0.0;
                const int   si   = (int)srcPos;
                const float frac = (float)(srcPos - si);
                const float va   = in[si];
                const float vb   = (si + 1 < N) ? in[si + 1] : in[si];
                op[i] = va + frac * (vb - va);
            }
        }
        return out;
    }

#ifdef XLETH_DEBUG
    const int n_af = (N + kHopSize - 1) / kHopSize + 1;
    const int n_sf = (outN + kHopSize - 1) / kHopSize + 2;
    fprintf(stderr, "[PhaseVocoder] input: %d samples, pitch=%.2f st, stretch=%.3f, "
            "formant=%d, frames %d→%d\n",
            N, params.pitchShiftSemitones, sratio, (int)params.formantPreserve, n_af, n_sf);
    const auto pvStart = std::chrono::steady_clock::now();
#endif

    // Build the Hann window and FFT object once; share across channels.
    const auto hannWindow = buildHannWindow();
    juce::dsp::FFT fft(kFftOrder);

    juce::AudioBuffer<float> out(numCh, outN);
    out.clear();

    for (int ch = 0; ch < numCh; ++ch) {
        const float* inPtr = input.getReadPointer(ch);
        if (computeRMS(inPtr, N) < kSilenceRMS) continue;

        auto result = processMonoPV(inPtr, N, outN, sratio, pitchRatio,
                                    params.formantPreserve, (float)params.sampleRate,
                                    hannWindow, fft);

        const int copyN = std::min((int)result.size(), outN);
        std::copy(result.begin(), result.begin() + copyN, out.getWritePointer(ch));
    }

#ifdef XLETH_DEBUG
    {
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - pvStart).count();
        fprintf(stderr, "[PhaseVocoder] output: %d samples in %lldms\n",
                outN, (long long)ms);
    }
#endif

    return out;
}

} // namespace xleth::dsp
