#include "dsp/RubberBandWrapper.h"
#include "XlethDebug.h"
#include <rubberband/RubberBandStretcher.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <iostream>
#include <vector>

namespace xleth::dsp {

juce::AudioBuffer<float> processRubberBand(
    const juce::AudioBuffer<float>& input,
    const RubberBandParams& params)
{
    juce::ScopedNoDenormals noDenormals;

    const int N     = input.getNumSamples();
    const int numCh = input.getNumChannels();
    if (N == 0 || numCh == 0) return juce::AudioBuffer<float>();

    const double pitchScale =
        std::pow(2.0, params.pitchShiftSemitones / 12.0);
    const double sratio = std::max(0.1, params.stretchRatio);

    // Near-identity early exit
    if (std::abs(pitchScale - 1.0) < 0.001
        && std::abs(sratio - 1.0) < 0.001
        && !params.formantPreserve)
    {
#ifdef XLETH_DEBUG
        fprintf(stderr, "[RubberBand] skip: near-identity params, returning copy\n");
#endif
        juce::AudioBuffer<float> out(numCh, N);
        for (int ch = 0; ch < numCh; ++ch)
            out.copyFrom(ch, 0, input, ch, 0, N);
        return out;
    }

#ifdef XLETH_DEBUG
    fprintf(stderr, "[RubberBand] input: %d samples, pitch=%.2f st, stretch=%.3f, formant=%d\n",
            N, params.pitchShiftSemitones, sratio, (int)params.formantPreserve);
    const auto rbStart = std::chrono::steady_clock::now();
#endif

    using RubberBand::RubberBandStretcher;

    const RubberBandStretcher::Options options =
        RubberBandStretcher::OptionProcessOffline      |
        RubberBandStretcher::OptionEngineFiner         |
        RubberBandStretcher::OptionPitchHighConsistency |
        RubberBandStretcher::OptionWindowLong          |
        (params.formantPreserve
            ? RubberBandStretcher::OptionFormantPreserved
            : RubberBandStretcher::OptionFormantShifted);

    RubberBandStretcher stretcher(
        static_cast<size_t>(params.sampleRate),
        static_cast<size_t>(numCh),
        options);

    stretcher.setTimeRatio(sratio);
    stretcher.setPitchScale(pitchScale);

    // Build channel-pointer arrays for the RubberBand API (float** interface)
    std::vector<const float*> inPtrs(numCh);
    for (int ch = 0; ch < numCh; ++ch)
        inPtrs[ch] = input.getReadPointer(ch);

    // ── Offline study pass ────────────────────────────────────────────────────
    stretcher.study(inPtrs.data(), static_cast<size_t>(N), /*final=*/true);

    // ── Offline process pass ──────────────────────────────────────────────────
    stretcher.process(inPtrs.data(), static_cast<size_t>(N), /*final=*/true);

    // ── Collect output ────────────────────────────────────────────────────────
    const int expectedOut = std::max(1, (int)std::round(N * sratio));
    juce::AudioBuffer<float> out(numCh, expectedOut);
    out.clear();

    int written = 0;
    while (written < expectedOut) {
        const int avail = stretcher.available();
        if (avail <= 0) break;

        const int toRead = std::min(avail, expectedOut - written);
        std::vector<float*> outPtrs(numCh);
        for (int ch = 0; ch < numCh; ++ch)
            outPtrs[ch] = out.getWritePointer(ch) + written;

        const size_t got = stretcher.retrieve(outPtrs.data(),
                                              static_cast<size_t>(toRead));
        if (got == 0) break;   // no progress — stretcher exhausted
        written += static_cast<int>(got);
    }

#ifdef XLETH_DEBUG
    {
        const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - rbStart).count();
        fprintf(stderr, "[RubberBand] output: %d samples in %lldms\n", written, (long long)ms);
    }
#endif

    // Trim output buffer to actual written samples (may differ from expected)
    if (written != expectedOut) {
        juce::AudioBuffer<float> trimmed(numCh, written);
        for (int ch = 0; ch < numCh; ++ch)
            trimmed.copyFrom(ch, 0, out, ch, 0, written);
        return trimmed;
    }
    return out;
}

} // namespace xleth::dsp
