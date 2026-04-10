#include "dsp/WSOLA.h"
#include "XlethDebug.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

// ─── Internal helpers ────────────────────────────────────────────────────────

namespace {

static constexpr int    kWindowSize = 1024;
static constexpr int    kSynthHop   = 512;    // 50% overlap
static constexpr int    kTolerance  = 512;
static constexpr float  kSilenceRMS = 1.0e-3f; // ≈ −60 dB
static constexpr double kPi         = 3.14159265358979323846;

// Symmetric Hann window. At 50% overlap (kSynthHop == kWindowSize/2),
// two adjacent shifted windows sum to approximately 1.0, giving flat OLA.
static std::vector<float> buildHannWindow()
{
    std::vector<float> w(kWindowSize);
    for (int i = 0; i < kWindowSize; ++i)
        w[i] = 0.5f * (1.0f - (float)std::cos(2.0 * kPi * i / (kWindowSize - 1)));
    return w;
}

static float computeRMS(const float* x, int N)
{
    if (N <= 0) return 0.0f;
    double sum = 0.0;
    for (int i = 0; i < N; ++i) sum += (double)x[i] * x[i];
    return (float)std::sqrt(sum / N);
}

// Maps outLen samples linearly across the N-sample input.
// Output[0] = input[0], output[outLen-1] = input[N-1] exactly.
static std::vector<float> linearResample(const float* in, int N, int outLen)
{
    std::vector<float> out(outLen, 0.0f);
    if (N <= 0 || outLen <= 0) return out;
    if (outLen == 1) { out[0] = in[0]; return out; }

    const double step = (double)(N - 1) / (double)(outLen - 1);
    for (int i = 0; i < outLen; ++i) {
        const double srcPos = (double)i * step;
        const int    si     = (int)srcPos;
        const float  frac   = (float)(srcPos - si);
        const float  va     = in[si];
        const float  vb     = (si + 1 < N) ? in[si + 1] : in[si];
        out[i] = va + frac * (vb - va);
    }
    return out;
}

// ─── WSOLA core ──────────────────────────────────────────────────────────────
//
// Time-stretches `input` (N samples) to `outN` samples.
// analysisHopF = kSynthHop / stretchRatio ensures the correct duration:
//   stretchRatio=2.0 → hop=256 → reads input at half speed → output is 2× long ✓
//   stretchRatio=0.5 → hop=1024 → reads at double speed → output is 0.5× long ✓
//
static std::vector<float> wsolaStretch(
    const float*              input,
    int                       N,
    int                       outN,
    double                    stretchRatio,
    const std::vector<float>& hannWindow)
{
    std::vector<float> output(outN, 0.0f);
    std::vector<float> wsum  (outN, 0.0f);

    const double analysisHopF = (double)kSynthHop / stretchRatio;

    double analysisPos = 0.0;
    int    synthPos    = 0;

    while (synthPos < outN) {
        const int expectedPos = (int)std::round(analysisPos);

        // ── Find best analysis offset via NCC ────────────────────────────
        // First-frame guard: no output tail yet → skip search, use nominal pos.
        int bestOffset = 0;

        if (synthPos >= kSynthHop) {
            float  bestNCC   = -2.0f;
            const int tailStart = synthPos - kSynthHop; // always >= 0 here

            for (int d = -kTolerance; d <= kTolerance; ++d) {
                const int candidateStart = expectedPos + d;
                if (candidateStart < 0 || candidateStart + kSynthHop > N)
                    continue;

                // NCC over the overlap zone (kSynthHop samples).
                // Compares the already-synthesized tail against the candidate.
                double corr = 0.0, normA = 0.0, normB = 0.0;
                for (int n = 0; n < kSynthHop; ++n) {
                    const float a = output[tailStart + n];
                    const float b = input[candidateStart + n];
                    corr  += (double)a * b;
                    normA += (double)a * a;
                    normB += (double)b * b;
                }
                const double denom = std::sqrt(normA * normB);
                const float  ncc   = (denom > 1e-10) ? (float)(corr / denom) : 0.0f;

                if (ncc > bestNCC) {
                    bestNCC    = ncc;
                    bestOffset = d;
                }
            }
        }

        // ── Overlap-add the selected grain ───────────────────────────────
        const int analysisStart = expectedPos + bestOffset;

        for (int n = 0; n < kWindowSize; ++n) {
            const int outIdx = synthPos + n;
            const int inIdx  = analysisStart + n;
            if (outIdx >= outN) break;
            if (inIdx  <  0 || inIdx >= N) continue;
            output[outIdx] += input[inIdx] * hannWindow[n];
            wsum  [outIdx] += hannWindow[n];
        }

        // ── Advance — ALWAYS by nominal hop, never carry bestOffset ──────
        analysisPos += analysisHopF;
        synthPos    += kSynthHop;
    }

    // Normalize by accumulated Hann weights.
    for (int i = 0; i < outN; ++i)
        if (wsum[i] > 1.0e-6f) output[i] /= wsum[i];

    return output;
}

} // anonymous namespace

// ─── Public API ───────────────────────────────────────────────────────────────

namespace xleth::dsp {

juce::AudioBuffer<float> processWSOLA(
    const juce::AudioBuffer<float>& input,
    const WSOLAParams& params)
{
    juce::ScopedNoDenormals noDenormals;

    const int N     = input.getNumSamples();
    const int numCh = input.getNumChannels();
    if (N == 0 || numCh == 0) return juce::AudioBuffer<float>();

    // ── Parameter preparation ────────────────────────────────────────────────
    const double sratio = std::max(0.1, params.stretchRatio);

    double pitchRatio = 1.0;
    if (std::abs(params.pitchShiftSemitones) >= 0.01) {
        pitchRatio = std::pow(2.0, params.pitchShiftSemitones / 12.0);
        pitchRatio = std::max(0.1, std::min(10.0, pitchRatio));
    }

    // Near-identity early exit
    if (std::abs(pitchRatio - 1.0) < 0.001 && std::abs(sratio - 1.0) < 0.001) {
#ifdef XLETH_DEBUG
        fprintf(stderr, "[WSOLA] skip: near-identity params, returning copy\n");
#endif
        juce::AudioBuffer<float> out(numCh, N);
        for (int ch = 0; ch < numCh; ++ch)
            out.copyFrom(ch, 0, input, ch, 0, N);
        return out;
    }

    // Formant preservation is not yet implemented for WSOLA.
    if (params.formantPreserve)
        fprintf(stderr, "[WSOLA] warn: formantPreserve not implemented for WSOLA, proceeding without\n");

    const int outN = std::max(1, (int)std::round((double)N * sratio));

#ifdef XLETH_DEBUG
    fprintf(stderr, "[WSOLA] input: %d samples, pitch=%.2f st, stretch=%.3f, formant=%d\n",
            N, params.pitchShiftSemitones, sratio, (int)params.formantPreserve);
    const auto wsolaStart = std::chrono::steady_clock::now();
#endif

    // Build Hann window once — shared across all channels.
    const auto hannWindow = buildHannWindow();

    juce::AudioBuffer<float> out(numCh, outN);
    out.clear();

    for (int ch = 0; ch < numCh; ++ch) {
        const float* inPtr = input.getReadPointer(ch);

        // Skip silent channels — output stays zeroed.
        if (computeRMS(inPtr, N) < kSilenceRMS) continue;

        // ── Pitch shift: resample to change pitch, correct duration via WSOLA ──
        const float* workPtr        = inPtr;
        int          workN          = N;
        double       correctedStretch = sratio;

        std::vector<float> resampled; // storage for pitch-shifted intermediate
        if (std::abs(pitchRatio - 1.0) >= 0.001) {
            // pitchRatio > 1: shorter output (pitch up); < 1: longer (pitch down)
            const int resampledLen = std::max(1, (int)std::round((double)N / pitchRatio));
            resampled = linearResample(inPtr, N, resampledLen);
            workPtr   = resampled.data();
            workN     = resampledLen;
            // WSOLA must compensate for the duration change introduced by resampling.
            correctedStretch = sratio * pitchRatio;
        }

        // ── Short-signal fallback (can't form even one WSOLA grain) ─────────
        if (workN < kWindowSize) {
            auto v = linearResample(workPtr, workN, outN);
            const int copyN = std::min((int)v.size(), outN);
            std::copy(v.begin(), v.begin() + copyN, out.getWritePointer(ch));
            continue;
        }

        // ── WSOLA stretch ────────────────────────────────────────────────────
        // workOutN is computed from workN to keep the internal loop consistent;
        // minor rounding differences vs outN are absorbed by the copyN clamp.
        const int workOutN = std::max(1, (int)std::round((double)workN * correctedStretch));
        const auto result  = wsolaStretch(workPtr, workN, workOutN,
                                          correctedStretch, hannWindow);

        const int copyN = std::min((int)result.size(), outN);
        std::copy(result.begin(), result.begin() + copyN, out.getWritePointer(ch));
    }

#ifdef XLETH_DEBUG
    {
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - wsolaStart).count();
        fprintf(stderr, "[WSOLA] output: %d samples in %lldms\n", outN, (long long)ms);
    }
#endif

    return out;
}

} // namespace xleth::dsp
