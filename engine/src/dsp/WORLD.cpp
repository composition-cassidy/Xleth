#include "dsp/WORLD.h"
#include "XlethDebug.h"

#include "world/cheaptrick.h"
#include "world/d4c.h"
#include "world/harvest.h"
#include "world/synthesis.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <vector>

namespace xleth::dsp {

namespace {

// WORLD frame period (ms). 5 ms is the library default and what every WORLD
// example uses. Smaller = more analysis frames = slower; larger = blurrier f0.
constexpr double kFramePeriod = 5.0;

// Wraps a double** spectrogram allocation so std::unique_ptr can free it.
struct Matrix2D {
    std::vector<std::vector<double>> rows;
    std::vector<double*> ptrs;

    Matrix2D(int numRows, int numCols)
        : rows(static_cast<size_t>(std::max(0, numRows)),
               std::vector<double>(static_cast<size_t>(std::max(0, numCols)), 0.0))
        , ptrs(static_cast<size_t>(std::max(0, numRows)), nullptr)
    {
        for (size_t i = 0; i < rows.size(); ++i)
            ptrs[i] = rows[i].data();
    }

    double**       data()       noexcept { return ptrs.data(); }
    double* const* data() const noexcept { return ptrs.data(); }
};

// Resample a 1-D array along the time axis. Linear interpolation between
// source frames; matches the approach in WORLD's example/test.cpp.
static void resampleAxis1D(const double* in, int inLen,
                           double* out, int outLen)
{
    if (outLen <= 0) return;
    if (inLen <= 0) {
        std::fill(out, out + outLen, 0.0);
        return;
    }
    if (outLen == 1) { out[0] = in[0]; return; }

    const double step = static_cast<double>(inLen - 1) / static_cast<double>(outLen - 1);
    for (int i = 0; i < outLen; ++i) {
        const double pos = static_cast<double>(i) * step;
        const int    i0  = static_cast<int>(pos);
        const int    i1  = std::min(i0 + 1, inLen - 1);
        const double t   = pos - static_cast<double>(i0);
        out[i] = (1.0 - t) * in[i0] + t * in[i1];
    }
}

// Resample a row-major 2-D array along its FIRST axis (rows = time frames).
// Inner-axis (cols) length is preserved.
static void resampleAxis2D(const Matrix2D& in, Matrix2D& out)
{
    const int inFrames  = static_cast<int>(in.rows.size());
    const int outFrames = static_cast<int>(out.rows.size());
    if (outFrames <= 0) return;
    if (inFrames <= 0) {
        for (auto& r : out.rows) std::fill(r.begin(), r.end(), 0.0);
        return;
    }
    const int cols = static_cast<int>(in.rows.front().size());
    if (outFrames == 1) {
        std::copy(in.rows[0].begin(), in.rows[0].end(), out.rows[0].begin());
        return;
    }

    const double step = static_cast<double>(inFrames - 1) / static_cast<double>(outFrames - 1);
    for (int i = 0; i < outFrames; ++i) {
        const double pos = static_cast<double>(i) * step;
        const int    i0  = static_cast<int>(pos);
        const int    i1  = std::min(i0 + 1, inFrames - 1);
        const double t   = pos - static_cast<double>(i0);
        const auto& a = in.rows[static_cast<size_t>(i0)];
        const auto& b = in.rows[static_cast<size_t>(i1)];
        auto&       o = out.rows[static_cast<size_t>(i)];
        for (int k = 0; k < cols; ++k)
            o[k] = (1.0 - t) * a[k] + t * b[k];
    }
}

// Per-channel WORLD pipeline. Returns float vector of length outLen.
static std::vector<float> processChannel(const float* inFloat,
                                         int inSamples,
                                         double sampleRate,
                                         double pitchShiftSemis,
                                         double stretchRatio)
{
    const int outLen = std::max(1, static_cast<int>(
        std::llround(static_cast<double>(inSamples) * stretchRatio)));

    if (inSamples <= 0)
        return std::vector<float>(static_cast<size_t>(outLen), 0.0f);

    const int fs = static_cast<int>(std::lround(sampleRate));

    // float → double
    std::vector<double> x(static_cast<size_t>(inSamples));
    for (int i = 0; i < inSamples; ++i) x[i] = static_cast<double>(inFloat[i]);

    // ── Harvest ──────────────────────────────────────────────────────────────
    HarvestOption hOpt;
    InitializeHarvestOption(&hOpt);
    hOpt.frame_period = kFramePeriod;
    hOpt.f0_floor     = 71.0;   // WORLD default

    const int f0Len = GetSamplesForHarvest(fs, inSamples, kFramePeriod);
    std::vector<double> tempPos(static_cast<size_t>(std::max(1, f0Len)), 0.0);
    std::vector<double> f0     (static_cast<size_t>(std::max(1, f0Len)), 0.0);

    if (f0Len > 0)
        Harvest(x.data(), inSamples, fs, &hOpt, tempPos.data(), f0.data());

    // ── CheapTrick ───────────────────────────────────────────────────────────
    CheapTrickOption ctOpt;
    InitializeCheapTrickOption(fs, &ctOpt);
    ctOpt.f0_floor = hOpt.f0_floor;
    const int fftSize = GetFFTSizeForCheapTrick(fs, &ctOpt);
    const int specCols = fftSize / 2 + 1;

    Matrix2D sp(std::max(1, f0Len), specCols);
    if (f0Len > 0) {
        CheapTrick(x.data(), inSamples, fs, tempPos.data(), f0.data(),
                   f0Len, &ctOpt, sp.data());
    }

    // ── D4C ──────────────────────────────────────────────────────────────────
    D4COption d4cOpt;
    InitializeD4COption(&d4cOpt);
    Matrix2D ap(std::max(1, f0Len), specCols);
    if (f0Len > 0) {
        D4C(x.data(), inSamples, fs, tempPos.data(), f0.data(),
            f0Len, fftSize, &d4cOpt, ap.data());
    }

    // ── Pitch shift: multiply f0 by 2^(semis/12) ────────────────────────────
    if (std::abs(pitchShiftSemis) > 1e-6) {
        const double mult = std::pow(2.0, pitchShiftSemis / 12.0);
        for (int i = 0; i < f0Len; ++i)
            if (f0[i] > 0.0) f0[i] *= mult;
    }

    // ── Time stretch: resample f0/sp/ap along time axis ─────────────────────
    const bool needsStretch = std::abs(stretchRatio - 1.0) > 1e-6;
    const int  outFrames    = needsStretch
        ? std::max(1, static_cast<int>(std::llround(
              static_cast<double>(f0Len) * stretchRatio)))
        : f0Len;

    std::vector<double> f0Out;
    Matrix2D            spOut(std::max(1, outFrames), specCols);
    Matrix2D            apOut(std::max(1, outFrames), specCols);
    const double*       f0SynPtr = nullptr;
    double* const*      spSynPtr = nullptr;
    double* const*      apSynPtr = nullptr;
    int                 synFrames = 0;

    if (needsStretch && f0Len > 0) {
        f0Out.assign(static_cast<size_t>(outFrames), 0.0);
        resampleAxis1D(f0.data(), f0Len, f0Out.data(), outFrames);
        resampleAxis2D(sp, spOut);
        resampleAxis2D(ap, apOut);
        f0SynPtr  = f0Out.data();
        spSynPtr  = spOut.data();
        apSynPtr  = apOut.data();
        synFrames = outFrames;
    } else {
        f0SynPtr  = f0.data();
        spSynPtr  = sp.data();
        apSynPtr  = ap.data();
        synFrames = f0Len;
    }

    // ── Synthesis ────────────────────────────────────────────────────────────
    std::vector<double> y(static_cast<size_t>(outLen), 0.0);
    if (synFrames > 0) {
        Synthesis(f0SynPtr, synFrames, spSynPtr, apSynPtr,
                  fftSize, kFramePeriod, fs, outLen, y.data());
    }

    // double → float
    std::vector<float> out(static_cast<size_t>(outLen));
    for (int i = 0; i < outLen; ++i) out[i] = static_cast<float>(y[i]);
    return out;
}

} // namespace

juce::AudioBuffer<float> processWORLD(const juce::AudioBuffer<float>& input,
                                      const WORLDParams& params)
{
    const int numCh   = std::max(1, input.getNumChannels());
    const int inSamp  = input.getNumSamples();
    const double ratio = params.stretchRatio > 0.0 ? params.stretchRatio : 1.0;
    const int outSamp = std::max(1, static_cast<int>(
        std::llround(static_cast<double>(inSamp) * ratio)));

    juce::AudioBuffer<float> out(numCh, outSamp);
    out.clear();

    if (inSamp <= 0) return out;

#ifdef XLETH_DEBUG
    fprintf(stderr, "[WORLD] processing ch=%d in=%d out=%d sr=%.0f pitch=%.3fst stretch=%.4f\n",
            numCh, inSamp, outSamp, params.sampleRate,
            params.pitchShiftSemitones, ratio);
    fflush(stderr);
#endif

    for (int ch = 0; ch < numCh; ++ch) {
        const float* src = input.getReadPointer(std::min(ch, input.getNumChannels() - 1));
        std::vector<float> y = processChannel(src, inSamp, params.sampleRate,
                                              params.pitchShiftSemitones, ratio);
        const int n = std::min(outSamp, static_cast<int>(y.size()));
        std::memcpy(out.getWritePointer(ch), y.data(),
                    sizeof(float) * static_cast<size_t>(n));
    }

    return out;
}

} // namespace xleth::dsp
