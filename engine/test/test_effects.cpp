// test_effects.cpp — XlethEffectBase + TestGainEffect pipeline test
// Build: see engine/CMakeLists.txt target "test_effects"
// Run:   test_effects.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [<line>] <message>" and exits 1

#include "audio/TestGainEffect.h"
#include "audio/EffectChainManager.h"
#include "audio/MixEngine.h"
#include "audio/XlethEQEffect.h"
#include "audio/XlethDistortionEffect.h"
#include "audio/XlethResonanceSuppressorEffect.h"
#include "audio/XlethTransientProcEffect.h"
#include "audio/XlethDelayEffect.h"
#include "audio/viz/DynamicsVizFrame.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <iostream>
#include <limits>
#include <memory>
#include <string>
#include <utility>
#include <algorithm>
#include <vector>

// ─── Test harness ────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                      \
    do {                                                                      \
        if (cond) {                                                           \
            ++g_passed;                                                       \
        } else {                                                              \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";       \
            ++g_failed;                                                       \
        }                                                                     \
    } while (0)

#define CHECK_NEAR(a, b, tol, msg) \
    CHECK(std::abs(static_cast<double>(a) - static_cast<double>(b)) < (tol), msg)

// ─── Utilities ───────────────────────────────────────────────────────────────

// Fill every sample in buffer with `value`.
static void fillBuffer(juce::AudioBuffer<float>& buf, float value)
{
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
        for (int s = 0; s < buf.getNumSamples(); ++s)
            buf.setSample(ch, s, value);
}

// Returns the average absolute value across all samples in channel 0.
static float meanAbs(const juce::AudioBuffer<float>& buf)
{
    double sum = 0.0;
    const int ns = buf.getNumSamples();
    const float* p = buf.getReadPointer(0);
    for (int s = 0; s < ns; ++s)
        sum += std::abs(static_cast<double>(p[s]));
    return ns > 0 ? static_cast<float>(sum / ns) : 0.0f;
}

static float maxAbsBuffer(const juce::AudioBuffer<float>& buf)
{
    float maxAbs = 0.0f;
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        const float* p = buf.getReadPointer(ch);
        for (int s = 0; s < buf.getNumSamples(); ++s)
            maxAbs = std::max(maxAbs, std::abs(p[s]));
    }
    return maxAbs;
}

static float maxAbsInRange(const juce::AudioBuffer<float>& buf,
                           int startSample,
                           int endSample)
{
    float maxAbs = 0.0f;
    startSample = std::max(startSample, 0);
    endSample = std::min(endSample, buf.getNumSamples());

    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        const float* p = buf.getReadPointer(ch);
        for (int s = startSample; s < endSample; ++s)
            maxAbs = std::max(maxAbs, std::abs(p[s]));
    }

    return maxAbs;
}

static int findFirstSampleAbove(const juce::AudioBuffer<float>& buf,
                                int channel,
                                float threshold,
                                int startSample = 0)
{
    channel = std::clamp(channel, 0, std::max(buf.getNumChannels() - 1, 0));
    startSample = std::max(startSample, 0);
    const float* p = buf.getReadPointer(channel);
    for (int s = startSample; s < buf.getNumSamples(); ++s)
    {
        if (std::abs(p[s]) >= threshold)
            return s;
    }
    return -1;
}

static juce::AudioBuffer<float> renderEffectInBlocks(
    XlethResonanceSuppressorEffect& fx,
    const juce::AudioBuffer<float>& input,
    const std::vector<int>& blockSizes)
{
    juce::AudioBuffer<float> output(input.getNumChannels(), input.getNumSamples());
    output.clear();

    juce::MidiBuffer midi;
    int pos = 0;
    int blockIndex = 0;

    while (pos < input.getNumSamples())
    {
        const int requested = blockSizes[static_cast<std::size_t>(blockIndex % blockSizes.size())];
        const int n = std::min(requested, input.getNumSamples() - pos);

        juce::AudioBuffer<float> block(input.getNumChannels(), n);
        for (int ch = 0; ch < input.getNumChannels(); ++ch)
            block.copyFrom(ch, 0, input, ch, pos, n);

        fx.processBlock(block, midi);

        for (int ch = 0; ch < input.getNumChannels(); ++ch)
            output.copyFrom(ch, pos, block, ch, 0, n);

        pos += n;
        ++blockIndex;
    }

    return output;
}

struct RenderWithMeterResult
{
    juce::AudioBuffer<float> output;
    float peakMeter = 0.0f;
};

static RenderWithMeterResult renderEffectAndMeterInBlocks(
    XlethResonanceSuppressorEffect& fx,
    const juce::AudioBuffer<float>& input,
    const std::vector<int>& blockSizes)
{
    RenderWithMeterResult result;
    result.output.setSize(input.getNumChannels(), input.getNumSamples());
    result.output.clear();

    juce::MidiBuffer midi;
    int pos = 0;
    int blockIndex = 0;

    while (pos < input.getNumSamples())
    {
        const int requested = blockSizes[static_cast<std::size_t>(blockIndex % blockSizes.size())];
        const int n = std::min(requested, input.getNumSamples() - pos);

        juce::AudioBuffer<float> block(input.getNumChannels(), n);
        for (int ch = 0; ch < input.getNumChannels(); ++ch)
            block.copyFrom(ch, 0, input, ch, pos, n);

        fx.processBlock(block, midi);
        result.peakMeter = std::max(result.peakMeter, fx.readMeterValue(2));

        for (int ch = 0; ch < input.getNumChannels(); ++ch)
            result.output.copyFrom(ch, pos, block, ch, 0, n);

        pos += n;
        ++blockIndex;
    }

    return result;
}

static float renderEffectDetectorActivityInBlocks(
    XlethResonanceSuppressorEffect& fx,
    const juce::AudioBuffer<float>& input,
    const std::vector<int>& blockSizes)
{
    juce::MidiBuffer midi;
    int pos = 0;
    int blockIndex = 0;
    float peakActivity = 0.0f;

    while (pos < input.getNumSamples())
    {
        const int requested = blockSizes[static_cast<std::size_t>(blockIndex % blockSizes.size())];
        const int n = std::min(requested, input.getNumSamples() - pos);

        juce::AudioBuffer<float> block(input.getNumChannels(), n);
        for (int ch = 0; ch < input.getNumChannels(); ++ch)
            block.copyFrom(ch, 0, input, ch, pos, n);

        fx.processBlock(block, midi);
        peakActivity = std::max(peakActivity, fx.readMeterValue(2));

        pos += n;
        ++blockIndex;
    }

    return peakActivity;
}

static int maxBlockSizeOf(const std::vector<int>& blockSizes)
{
    int maxBlock = 1;
    for (int n : blockSizes)
        maxBlock = std::max(maxBlock, n);
    return maxBlock;
}

static void setResonanceHighQualityMode(XlethResonanceSuppressorEffect& fx)
{
    CHECK(fx.setParameterValue("processing_mode", 1.0f),
          "RS processing_mode should accept High Quality");
}

static void setResonanceLowLatencyMode(XlethResonanceSuppressorEffect& fx)
{
    CHECK(fx.setParameterValue("processing_mode", 0.0f),
          "RS processing_mode should accept Low Latency");
}

static int measureImpulseDelayForQuality(int quality, const std::vector<int>& blockSizes)
{
    constexpr double kSR = 44100.0;
    constexpr int kTotalSamples = 32768;
    constexpr int kImpulseIndex = 4096;

    XlethResonanceSuppressorEffect fx;
    setResonanceHighQualityMode(fx);
    CHECK(fx.setParameterValue("quality", static_cast<float>(quality)),
          "RS quality param should be settable before prepare");
    CHECK(fx.setParameterValue("depth", 0.0f),
          "RS depth 0 should be settable for identity latency measurement");
    fx.prepareToPlay(kSR, maxBlockSizeOf(blockSizes));

    juce::AudioBuffer<float> input(2, kTotalSamples);
    input.clear();
    input.setSample(0, kImpulseIndex, 1.0f);
    input.setSample(1, kImpulseIndex, -0.75f);

    auto output = renderEffectInBlocks(fx, input, blockSizes);

    int peakIndex = -1;
    float peak = 0.0f;
    for (int s = 0; s < output.getNumSamples(); ++s)
    {
        const float v = std::abs(output.getSample(0, s));
        if (v > peak)
        {
            peak = v;
            peakIndex = s;
        }
    }

    CHECK(peak > 0.5f, "RS impulse output peak should be present");
    return peakIndex >= 0 ? (peakIndex - kImpulseIndex) : -1;
}

struct ErrorStats
{
    double maxAbs = 0.0;
    double rms = 0.0;
};

static ErrorStats computeAlignedError(const juce::AudioBuffer<float>& input,
                                      const juce::AudioBuffer<float>& output,
                                      int delaySamples,
                                      int startInput,
                                      int endInput,
                                      int channelsToCheck)
{
    ErrorStats stats;
    double sumSq = 0.0;
    int count = 0;

    endInput = std::min(endInput, input.getNumSamples() - delaySamples);
    channelsToCheck = std::min(channelsToCheck, input.getNumChannels());

    for (int ch = 0; ch < channelsToCheck; ++ch)
    {
        for (int s = startInput; s < endInput; ++s)
        {
            const double d = static_cast<double>(output.getSample(ch, s + delaySamples))
                           - static_cast<double>(input.getSample(ch, s));
            stats.maxAbs = std::max(stats.maxAbs, std::abs(d));
            sumSq += d * d;
            ++count;
        }
    }

    stats.rms = count > 0 ? std::sqrt(sumSq / static_cast<double>(count)) : 0.0;
    return stats;
}

static double computeAlignedRmsGainError(const juce::AudioBuffer<float>& input,
                                         const juce::AudioBuffer<float>& output,
                                         int delaySamples,
                                         int startInput,
                                         int endInput,
                                         int channel)
{
    endInput = std::min(endInput, input.getNumSamples() - delaySamples);

    double inSq = 0.0;
    double outSq = 0.0;
    int count = 0;

    for (int s = startInput; s < endInput; ++s)
    {
        const double x = input.getSample(channel, s);
        const double y = output.getSample(channel, s + delaySamples);
        inSq += x * x;
        outSq += y * y;
        ++count;
    }

    if (count <= 0 || inSq <= 1.0e-30)
        return 0.0;

    const double inRms = std::sqrt(inSq / static_cast<double>(count));
    const double outRms = std::sqrt(outSq / static_cast<double>(count));
    return std::abs(outRms / inRms - 1.0);
}

static double computeAlignedRmsReductionDb(const juce::AudioBuffer<float>& input,
                                           const juce::AudioBuffer<float>& output,
                                           int delaySamples,
                                           int startInput,
                                           int endInput,
                                           int channel)
{
    endInput = std::min(endInput, input.getNumSamples() - delaySamples);

    double inSq = 0.0;
    double outSq = 0.0;
    int count = 0;

    for (int s = startInput; s < endInput; ++s)
    {
        const double x = input.getSample(channel, s);
        const double y = output.getSample(channel, s + delaySamples);
        inSq += x * x;
        outSq += y * y;
        ++count;
    }

    if (count <= 0 || inSq <= 1.0e-30)
        return 0.0;

    const double inRms = std::sqrt(inSq / static_cast<double>(count));
    const double outRms = std::sqrt(std::max(outSq / static_cast<double>(count), 1.0e-30));
    return 20.0 * std::log10(std::max(inRms, 1.0e-15) / std::max(outRms, 1.0e-15));
}

static double computeAlignedOutputRms(const juce::AudioBuffer<float>& output,
                                      int delaySamples,
                                      int startInput,
                                      int endInput,
                                      int channel)
{
    endInput = std::min(endInput, output.getNumSamples() - delaySamples);

    double outSq = 0.0;
    int count = 0;

    for (int s = startInput; s < endInput; ++s)
    {
        const double y = output.getSample(channel, s + delaySamples);
        outSq += y * y;
        ++count;
    }

    return count > 0 ? std::sqrt(outSq / static_cast<double>(count)) : 0.0;
}

static double computeAlignedToneReductionDb(const juce::AudioBuffer<float>& input,
                                            const juce::AudioBuffer<float>& output,
                                            int delaySamples,
                                            int startInput,
                                            int endInput,
                                            int channel,
                                            double sampleRate,
                                            double frequency)
{
    endInput = std::min(endInput, input.getNumSamples() - delaySamples);

    double inSin = 0.0;
    double inCos = 0.0;
    double outSin = 0.0;
    double outCos = 0.0;
    int count = 0;

    for (int s = startInput; s < endInput; ++s)
    {
        const double phase = 2.0 * juce::MathConstants<double>::pi
                           * frequency * static_cast<double>(s) / sampleRate;
        const double sn = std::sin(phase);
        const double cs = std::cos(phase);
        const double x = input.getSample(channel, s);
        const double y = output.getSample(channel, s + delaySamples);
        inSin += x * sn;
        inCos += x * cs;
        outSin += y * sn;
        outCos += y * cs;
        ++count;
    }

    if (count <= 0)
        return 0.0;

    const double inMag = std::sqrt(inSin * inSin + inCos * inCos);
    const double outMag = std::sqrt(outSin * outSin + outCos * outCos);
    return 20.0 * std::log10(std::max(inMag, 1.0e-15) / std::max(outMag, 1.0e-15));
}

static bool allSamplesFinite(const juce::AudioBuffer<float>& buf)
{
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        const float* p = buf.getReadPointer(ch);
        for (int s = 0; s < buf.getNumSamples(); ++s)
        {
            if (!std::isfinite(p[s]))
                return false;
        }
    }
    return true;
}

struct TransientRenderResult
{
    juce::AudioBuffer<float> output;
    float dominantSignedGainDb = 0.0f;
};

static void fillTransientHit(juce::AudioBuffer<float>& buf,
                             float rightScale = 1.0f,
                             float transientScale = 0.85f,
                             float transientDecaySamples = 3.0f,
                             float bodyScale = 0.40f,
                             float bodyDecaySamples = 900.0f)
{
    for (int s = 0; s < buf.getNumSamples(); ++s)
    {
        const float sampleIndex = static_cast<float>(s);
        const float transient = s < 24
            ? transientScale * std::exp(-sampleIndex / transientDecaySamples)
            : 0.0f;
        const float body = bodyScale * std::exp(-sampleIndex / bodyDecaySamples);
        const float left = juce::jlimit(-0.98f, 0.98f, transient + body);
        buf.setSample(0, s, left);
        if (buf.getNumChannels() > 1)
            buf.setSample(1, s, left * rightScale);
    }
}

static void fillSineBuffer(juce::AudioBuffer<float>& buf,
                           double sampleRate,
                           float amplitude,
                           float frequencyHz,
                           float rightScale = 1.0f)
{
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;
    for (int s = 0; s < buf.getNumSamples(); ++s)
    {
        const float phase = pi2 * frequencyHz * static_cast<float>(s)
                          / static_cast<float>(sampleRate);
        const float left = amplitude * std::sin(phase);
        buf.setSample(0, s, left);
        if (buf.getNumChannels() > 1)
            buf.setSample(1, s, left * rightScale);
    }
}

static float maxAbsDifference(const juce::AudioBuffer<float>& a,
                              const juce::AudioBuffer<float>& b)
{
    const int channels = std::min(a.getNumChannels(), b.getNumChannels());
    const int samples = std::min(a.getNumSamples(), b.getNumSamples());
    float maxDiff = 0.0f;
    for (int ch = 0; ch < channels; ++ch)
    {
        for (int s = 0; s < samples; ++s)
            maxDiff = std::max(maxDiff,
                               std::abs(a.getSample(ch, s) - b.getSample(ch, s)));
    }
    return maxDiff;
}

static float windowPeakAbs(const juce::AudioBuffer<float>& buf,
                           int channel,
                           int startSample,
                           int endSample)
{
    const int start = std::max(0, startSample);
    const int end = std::min(endSample, buf.getNumSamples());
    float peak = 0.0f;
    for (int s = start; s < end; ++s)
        peak = std::max(peak, std::abs(buf.getSample(channel, s)));
    return peak;
}

static double windowRms(const juce::AudioBuffer<float>& buf,
                        int channel,
                        int startSample,
                        int endSample)
{
    const int start = std::max(0, startSample);
    const int end = std::min(endSample, buf.getNumSamples());
    double sumSq = 0.0;
    int count = 0;
    for (int s = start; s < end; ++s)
    {
        const double v = buf.getSample(channel, s);
        sumSq += v * v;
        ++count;
    }
    return count > 0 ? std::sqrt(sumSq / static_cast<double>(count)) : 0.0;
}

static double maxStereoRatioError(const juce::AudioBuffer<float>& buf,
                                  float expectedRightScale)
{
    double maxErr = 0.0;
    const int samples = buf.getNumSamples();
    for (int s = 0; s < samples; ++s)
    {
        const double left = buf.getSample(0, s);
        const double right = buf.getSample(1, s);
        if (std::abs(left) < 1.0e-6 && std::abs(right) < 1.0e-6)
            continue;
        maxErr = std::max(maxErr, std::abs(right - expectedRightScale * left));
    }
    return maxErr;
}

static TransientRenderResult renderTransientEffectInBlocks(
    XlethTransientProcEffect& fx,
    const juce::AudioBuffer<float>& input,
    const std::vector<int>& blockSizes,
    bool sendMidiOnFirstBlock = false,
    float midiVelocity = 1.0f)
{
    TransientRenderResult result;
    result.output.setSize(input.getNumChannels(), input.getNumSamples());
    result.output.clear();

    juce::MidiBuffer ignoredMidi;
    int pos = 0;
    int blockIndex = 0;
    bool sentMidi = false;

    while (pos < input.getNumSamples())
    {
        const int requested = blockSizes[static_cast<std::size_t>(blockIndex % blockSizes.size())];
        const int n = std::min(requested, input.getNumSamples() - pos);

        juce::AudioBuffer<float> block(input.getNumChannels(), n);
        for (int ch = 0; ch < input.getNumChannels(); ++ch)
            block.copyFrom(ch, 0, input, ch, pos, n);

        juce::MidiBuffer blockMidi;
        if (sendMidiOnFirstBlock && !sentMidi)
        {
            const int velocityByte = juce::jlimit(1, 127,
                static_cast<int>(std::round(midiVelocity * 127.0f)));
            blockMidi.addEvent(
                juce::MidiMessage::noteOn(1, 60, static_cast<juce::uint8>(velocityByte)),
                0);
            sentMidi = true;
        }

        XlethEffectBase::setCurrentMidiBuffer(&blockMidi);
        fx.processBlock(block, ignoredMidi);
        XlethEffectBase::setCurrentMidiBuffer(nullptr);

        const float signedGainDb = fx.readMeterValue(2);
        if (std::abs(signedGainDb) > std::abs(result.dominantSignedGainDb))
            result.dominantSignedGainDb = signedGainDb;

        for (int ch = 0; ch < input.getNumChannels(); ++ch)
            result.output.copyFrom(ch, pos, block, ch, 0, n);

        pos += n;
        ++blockIndex;
    }

    XlethEffectBase::setCurrentMidiBuffer(nullptr);
    return result;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

static void fillResonanceRegressionSignal(juce::AudioBuffer<float>& input,
                                          double sampleRate)
{
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;
    for (int s = 0; s < input.getNumSamples(); ++s)
    {
        const float t = static_cast<float>(s) / static_cast<float>(sampleRate);
        const float l = 0.21f * std::sin(pi2 * 997.0f * t)
                      + 0.06f * std::sin(pi2 * 2711.0f * t + 0.37f)
                      + 0.025f * std::sin(pi2 * 113.0f * t);
        const float r = 0.19f * std::sin(pi2 * 701.0f * t + 0.19f)
                      + 0.05f * std::sin(pi2 * 3299.0f * t + 0.71f)
                      - 0.018f * std::sin(pi2 * 211.0f * t);
        input.setSample(0, s, l);
        input.setSample(1, s, r);
    }
}

static float maxAdjacentStepInRange(const juce::AudioBuffer<float>& buf,
                                    int startSample,
                                    int endSample)
{
    float maxStep = 0.0f;
    startSample = std::max(startSample, 1);
    endSample = std::min(endSample, buf.getNumSamples());

    for (int ch = 0; ch < std::min(buf.getNumChannels(), 2); ++ch)
    {
        for (int s = startSample; s < endSample; ++s)
        {
            const float step = std::abs(buf.getSample(ch, s)
                                      - buf.getSample(ch, s - 1));
            maxStep = std::max(maxStep, step);
        }
    }

    return maxStep;
}

static void testLayout()
{
    std::cout << "  [layout]\n";
    TestGainEffect fx;

    // Should have exactly one parameter
    const auto& params = fx.getParameters();
    CHECK(params.size() == 1, "expected exactly 1 parameter");

    auto* rp = dynamic_cast<juce::RangedAudioParameter*>(params[0]);
    CHECK(rp != nullptr, "param should be RangedAudioParameter");
    if (!rp) return;

    CHECK(rp->paramID == "gain", "param id should be 'gain'");

    const auto& range = rp->getNormalisableRange();
    CHECK_NEAR(range.start,  0.0f, 1e-5f, "min should be 0");
    CHECK_NEAR(range.end,    4.0f, 1e-5f, "max should be 4");

    const float defaultVal = rp->convertFrom0to1(rp->getDefaultValue());
    CHECK_NEAR(defaultVal, 1.0f, 1e-5f, "default value should be 1");
}

static void testSmoothedGain()
{
    std::cout << "  [smoothed gain]\n";
    constexpr double kSampleRate  = 44100.0;
    constexpr int    kBlockSize   = 512;
    constexpr float  kTargetGain  = 2.0f;
    // A 20 ms ramp at 44100 Hz ≈ 882 samples.
    // After 512 samples the smoother is partway through the ramp; the
    // output average should be between 1 and 2 (exclusive) and measurably
    // above 1.  We just check output > 1 and < 2.2 (allows overshoot margin).
    TestGainEffect fx;
    juce::MidiBuffer midi;
    fx.prepareToPlay(kSampleRate, kBlockSize);

    // Set gain to 2 via APVTS
    CHECK(fx.setParameterValue("gain", kTargetGain), "setParameterValue should succeed");

    juce::AudioBuffer<float> buf(2, kBlockSize);
    fillBuffer(buf, 1.0f);
    fx.processBlock(buf, midi);

    const float avg = meanAbs(buf);
    CHECK(avg > 1.0f,  "output mean should be above 1 (gain started ramping)");
    CHECK(avg < 2.2f,  "output mean should be below 2.2 (not past target)");

    // The 20ms ramp at 44100Hz spans 882 samples (> one 512-sample block).
    // Process a second block to finish the ramp, then a third to verify all
    // samples sit at exactly 2.0.
    fillBuffer(buf, 1.0f);
    fx.processBlock(buf, midi); // ramp finishes partway through this block

    fillBuffer(buf, 1.0f);
    fx.processBlock(buf, midi); // all samples now fully at 2.0
    const float avg3 = meanAbs(buf);
    CHECK_NEAR(avg3, 2.0f, 0.01f, "output should be ≈ 2 after ramp settles");
}

static void testMetering()
{
    std::cout << "  [metering]\n";
    constexpr double kSampleRate = 44100.0;
    constexpr int    kBlockSize  = 256;

    TestGainEffect fx;
    juce::MidiBuffer midi;
    fx.prepareToPlay(kSampleRate, kBlockSize);
    fx.setParameterValue("gain", 1.0f);

    juce::AudioBuffer<float> buf(2, kBlockSize);
    fillBuffer(buf, 0.5f);
    fx.processBlock(buf, midi);

    CHECK(fx.readMeterValue(0) > 0.0f, "meter slot 0 (L) should be > 0 after processing");
    CHECK(fx.readMeterValue(1) > 0.0f, "meter slot 1 (R) should be > 0 after processing");
    CHECK_NEAR(fx.readMeterValue(0), 0.5f, 0.05f, "meter slot 0 should be ≈ 0.5");
}

static void testSerializationRoundTrip()
{
    std::cout << "  [serialization round-trip]\n";
    constexpr double kSampleRate = 44100.0;
    constexpr int    kBlockSize  = 256;
    constexpr float  kGain       = 3.0f;

    // Source effect: set gain to 3 and serialise
    TestGainEffect src;
    src.prepareToPlay(kSampleRate, kBlockSize);
    src.setParameterValue("gain", kGain);

    juce::MemoryBlock state;
    src.getStateInformation(state);
    CHECK(state.getSize() > 0, "serialised state should be non-empty");

    // Restore into a fresh instance
    TestGainEffect dst;
    dst.prepareToPlay(kSampleRate, kBlockSize);
    dst.setStateInformation(state.getData(), static_cast<int>(state.getSize()));

    // Read the restored param value
    const auto& params = dst.getParameters();
    CHECK(params.size() == 1, "restored effect should have 1 param");
    auto* rp = dynamic_cast<juce::RangedAudioParameter*>(params[0]);
    CHECK(rp != nullptr, "restored param should be RangedAudioParameter");
    if (!rp) return;

    const float restored = rp->convertFrom0to1(rp->getValue());
    CHECK_NEAR(restored, kGain, 0.01f, "restored gain should be ≈ 3");
}

static void testGraphOwnedEffectHydration()
{
    std::cout << "  [graph-owned effect hydration]\n";

    EffectChainManager chain;
    chain.init(44100.0, 256);

    nlohmann::json payload = nlohmann::json::array({
        {
            {"effectInstanceId", "inst-reverb"},
            {"pluginId", "reverb"},
            {"graphNodeId", "fx-reverb"},
            {"displayName", "Reverb"},
        },
        {
            {"effectInstanceId", "inst-placeholder"},
            {"pluginId", "placeholder"},
            {"graphNodeId", "fx-placeholder"},
        },
        {
            {"effectInstanceId", ""},
            {"pluginId", "delay"},
            {"graphNodeId", "fx-invalid"},
        },
    });

    const auto hydrated = chain.hydrateGraphNodes(payload);
    CHECK(hydrated.value("ok", false), "graph-owned hydration should report ok for per-node failures");
    CHECK(hydrated["mapping"].contains("inst-reverb"),
          "graph-owned hydration should map real effectInstanceId");
    CHECK(hydrated["skipped"].size() == 1,
          "graph-owned hydration should skip placeholder plugins");
    CHECK(hydrated["failures"].size() == 1,
          "graph-owned hydration should report invalid effectInstanceId");

    const int firstNodeId = hydrated["mapping"]["inst-reverb"].get<int>();
    CHECK(firstNodeId >= 0, "graph-owned hydration should create an engine node");
    CHECK(chain.getGraphNodeEngineId("inst-reverb") == firstNodeId,
          "graph-owned hydration should rebuild the runtime lookup");

    const auto secondHydration = chain.hydrateGraphNodes(nlohmann::json::array({
        {{"effectInstanceId", "inst-reverb"}, {"pluginId", "reverb"}},
    }));
    CHECK(secondHydration["mapping"]["inst-reverb"].get<int>() == firstNodeId,
          "graph-owned hydration should be idempotent for duplicate effectInstanceId");

    const auto saved = chain.graphToJSON();
    CHECK(saved.contains("connections") && saved["connections"].empty(),
          "graph-owned hydration should not connect graph edges");

    bool serializedEffectInstanceId = false;
    for (const auto& node : saved["nodes"])
    {
        if (node.value("effectInstanceId", std::string{}) == "inst-reverb")
            serializedEffectInstanceId = true;
    }
    CHECK(serializedEffectInstanceId,
          "graph-owned serialization should persist effectInstanceId additively");

    EffectChainManager restored;
    restored.init(44100.0, 256);
    CHECK(restored.graphFromJSON(saved), "graphFromJSON should accept graph-owned effectInstanceId");
    const int restoredNodeId = restored.getGraphNodeEngineId("inst-reverb");
    CHECK(restoredNodeId >= 0,
          "graphFromJSON should rebuild graph-owned effectInstanceId lookup");
    CHECK(restored.addGraphNode("inst-reverb", "reverb") == restoredNodeId,
          "re-adding a restored effectInstanceId should return the existing engine node");
}

static void testLinearGraphTopologySync()
{
    std::cout << "  [linear graph topology sync]\n";

    constexpr double kSampleRate = 44100.0;
    constexpr int    kBlockSize  = 256;

    auto ioNode = [](const std::string& nodeId, const std::string& type) {
        return nlohmann::json{{"nodeId", nodeId}, {"type", type}};
    };
    auto effectNode = [](const std::string& nodeId,
                         const std::string& effectInstanceId,
                         const std::string& pluginId = "testgain",
                         bool missing = false) {
        return nlohmann::json{
            {"nodeId", nodeId},
            {"type", "effect"},
            {"effectInstanceId", effectInstanceId},
            {"pluginId", pluginId},
            {"missing", missing},
        };
    };
    auto edge = [](const std::string& id,
                   const std::string& source,
                   const std::string& dest) {
        return nlohmann::json{
            {"edgeId", id},
            {"sourceNodeId", source},
            {"targetNodeId", dest},
            {"sourcePort", source == "input" ? "audio" : "audioOut"},
            {"targetPort", dest == "output" ? "audio" : "audioIn"},
            {"type", "audio"},
        };
    };
    auto topology = [&](nlohmann::json nodes, nlohmann::json edges) {
        return nlohmann::json{
            {"phase", "FXG.3-c-b"},
            {"trackId", "7"},
            {"nodes", std::move(nodes)},
            {"edges", std::move(edges)},
        };
    };
    auto hasConnection = [](const nlohmann::json& saved, int source, int dest) {
        if (!saved.contains("connections") || !saved["connections"].is_array())
            return false;
        for (const auto& conn : saved["connections"])
        {
            if (conn.value("source", -1) == source && conn.value("dest", -1) == dest)
                return true;
        }
        return false;
    };

    EffectChainManager chain;
    chain.init(kSampleRate, kBlockSize);

    const auto direct = topology(
        nlohmann::json::array({
            ioNode("input", "trackInput"),
            ioNode("output", "trackOutput"),
        }),
        nlohmann::json::array({
            edge("direct", "input", "output"),
        }));
    const auto directResult = chain.syncLinearGraphTopology(direct);
    CHECK(directResult.value("ok", false),
          "Track Input -> Track Output should sync as passthrough");
    CHECK(directResult.value("pathEffectCount", -1) == 0,
          "direct passthrough should report zero active effects");
    CHECK(directResult.value("appliedConnectionCount", -1) == 1,
          "direct passthrough should report one applied logical edge");

    juce::AudioBuffer<float> buf(2, kBlockSize);
    juce::MidiBuffer midi;
    fillBuffer(buf, 0.25f);
    chain.processBlock(buf, kBlockSize, midi);
    CHECK_NEAR(meanAbs(buf), 0.25f, 0.001f,
               "direct graph topology should pass audio through");

    const int fxA = chain.addGraphNode("inst-a", "testgain");
    const int fxB = chain.addGraphNode("inst-b", "testgain");
    CHECK(fxA >= 0 && fxB >= 0 && fxA != fxB,
          "graph-owned testgain nodes should instantiate");
    CHECK(chain.setEffectParameter(fxA, "gain", 2.0f),
          "graph-owned effect A gain should be settable");
    CHECK(chain.setEffectParameter(fxB, "gain", 2.0f),
          "graph-owned effect B gain should be settable");

    const auto linearAB = topology(
        nlohmann::json::array({
            ioNode("input", "trackInput"),
            effectNode("fx-a", "inst-a"),
            effectNode("fx-b", "inst-b"),
            ioNode("output", "trackOutput"),
        }),
        nlohmann::json::array({
            edge("e1", "input", "fx-a"),
            edge("e2", "fx-a", "fx-b"),
            edge("e3", "fx-b", "output"),
        }));
    const auto linearResult = chain.syncLinearGraphTopology(linearAB);
    CHECK(linearResult.value("ok", false),
          "Track Input -> Effect A -> Effect B -> Track Output should sync");
    CHECK(linearResult.value("pathEffectCount", -1) == 2,
          "linear sync should report both active effects");
    CHECK(linearResult["pathEffectInstanceIds"] == nlohmann::json::array({"inst-a", "inst-b"}),
          "linear sync should preserve graph edge effect order");

    auto saved = chain.graphToJSON();
    CHECK(hasConnection(saved, fxA, fxB),
          "linear sync should wire Effect A before Effect B");

    for (int pass = 0; pass < 8; ++pass)
    {
        fillBuffer(buf, 0.10f);
        chain.processBlock(buf, kBlockSize, midi);
    }
    CHECK(meanAbs(buf) > 0.30f,
          "linear graph-owned effects should process the audio path");

    const auto linearBA = topology(
        nlohmann::json::array({
            ioNode("input", "trackInput"),
            effectNode("fx-a", "inst-a"),
            effectNode("fx-b", "inst-b"),
            ioNode("output", "trackOutput"),
        }),
        nlohmann::json::array({
            edge("e1", "input", "fx-b"),
            edge("e2", "fx-b", "fx-a"),
            edge("e3", "fx-a", "output"),
        }));
    const auto reversedResult = chain.syncLinearGraphTopology(linearBA);
    CHECK(reversedResult.value("ok", false),
          "rewiring a supported linear graph should resync successfully");
    saved = chain.graphToJSON();
    CHECK(hasConnection(saved, fxB, fxA) && !hasConnection(saved, fxA, fxB),
          "rewiring should replace the previous graph-owned execution order");

    const auto secondSync = chain.syncLinearGraphTopology(linearBA);
    CHECK(secondSync.value("ok", false),
          "linear graph sync should be idempotent");

    const auto missingMapping = topology(
        nlohmann::json::array({
            ioNode("input", "trackInput"),
            effectNode("fx-missing", "inst-missing"),
            ioNode("output", "trackOutput"),
        }),
        nlohmann::json::array({
            edge("e1", "input", "fx-missing"),
            edge("e2", "fx-missing", "output"),
        }));
    const auto missingResult = chain.syncLinearGraphTopology(missingMapping);
    CHECK(!missingResult.value("ok", true)
              && missingResult.value("reason", std::string{}) == "missing_effect_mapping",
          "active effect without graph-owned engine mapping should be rejected");
    CHECK(missingResult.value("fallbackApplied", false),
          "missing mapping should apply safe passthrough fallback");

    const auto placeholderActive = topology(
        nlohmann::json::array({
            ioNode("input", "trackInput"),
            effectNode("fx-placeholder", "inst-placeholder", "placeholder"),
            ioNode("output", "trackOutput"),
        }),
        nlohmann::json::array({
            edge("e1", "input", "fx-placeholder"),
            edge("e2", "fx-placeholder", "output"),
        }));
    const auto placeholderResult = chain.syncLinearGraphTopology(placeholderActive);
    CHECK(!placeholderResult.value("ok", true)
              && placeholderResult.value("reason", std::string{}) == "effect_not_active",
          "active placeholder/data-only effect should be rejected safely");

    CHECK(chain.syncLinearGraphTopology(linearAB).value("ok", false),
          "test should restore a supported route before the parallel sync");
    // FXG.3-d: fan-out from input + fan-in to output executes as a parallel DAG.
    const auto parallel = topology(
        nlohmann::json::array({
            ioNode("input", "trackInput"),
            effectNode("fx-a", "inst-a"),
            effectNode("fx-b", "inst-b"),
            ioNode("output", "trackOutput"),
        }),
        nlohmann::json::array({
            edge("e1", "input", "fx-a"),
            edge("e2", "input", "fx-b"),
            edge("e3", "fx-a", "output"),
            edge("e4", "fx-b", "output"),
        }));
    const auto parallelResult = chain.syncGraphTopology(parallel);
    CHECK(parallelResult.value("ok", false)
              && parallelResult.value("mode", std::string{}) == "parallel",
          "FXG.3-d: fan-out/fan-in should route as parallel, not be deferred");
    CHECK(parallelResult.value("reason", std::string{}) == "parallel_graph_routing_active",
          "parallel routing should report parallel_graph_routing_active");
    saved = chain.graphToJSON();
    CHECK(saved.contains("connections") && !saved["connections"].empty(),
          "parallel sync should wire both branches (not fall back to silence)");
    CHECK(chain.getGraphNodeEngineId("inst-a") == fxA
              && chain.getGraphNodeEngineId("inst-b") == fxB,
          "parallel routing should keep graph-owned processors alive");

    // Both branches carry gain 2.0, so 0.25 fans out to 0.5 + 0.5 and JUCE's
    // APG sums them to ~1.0 at Track Output (additive, no normalization).
    for (int pass = 0; pass < 12; ++pass)
    {
        fillBuffer(buf, 0.25f);
        chain.processBlock(buf, kBlockSize, midi);
    }
    CHECK(meanAbs(buf) > 0.85f && meanAbs(buf) < 1.15f,
          "parallel branches should sum additively at Track Output (~1.0)");

    auto mixer = std::make_unique<MixEngine>();
    const auto masterResult = mixer->syncLinearGraphTopology(-1, direct);
    CHECK(!masterResult.value("ok", true)
              && masterResult.value("reason", std::string{}) == "master_track",
          "MixEngine should reject master-track linear graph sync");
}

// FXG.3-d / FXG.3-c-b-r1: graph mode must OWN the runtime route — no stale
// chain leakage, adoption preserves processor state, disconnected nodes stay
// silent.
static void testGraphRuntimeOwnership()
{
    std::cout << "  [graph runtime ownership]\n";

    constexpr double kSampleRate = 44100.0;
    constexpr int    kBlockSize  = 256;

    auto ioNode = [](const std::string& nodeId, const std::string& type) {
        return nlohmann::json{{"nodeId", nodeId}, {"type", type}};
    };
    auto effectNode = [](const std::string& nodeId, const std::string& effectInstanceId,
                         const std::string& pluginId = "testgain") {
        return nlohmann::json{
            {"nodeId", nodeId}, {"type", "effect"},
            {"effectInstanceId", effectInstanceId}, {"pluginId", pluginId},
            {"missing", false},
        };
    };
    auto edge = [](const std::string& id, const std::string& source, const std::string& dest) {
        return nlohmann::json{
            {"edgeId", id}, {"sourceNodeId", source}, {"targetNodeId", dest},
            {"sourcePort", source == "input" ? "audio" : "audioOut"},
            {"targetPort", dest == "output" ? "audio" : "audioIn"},
            {"type", "audio"},
        };
    };
    auto topology = [&](nlohmann::json nodes, nlohmann::json edges) {
        return nlohmann::json{
            {"phase", "FXG.3-d"}, {"trackId", "7"},
            {"nodes", std::move(nodes)}, {"edges", std::move(edges)},
        };
    };

    juce::MidiBuffer midi;

    // ── 1. Stale chain routing must NOT leak once graph mode owns the track ──
    {
        EffectChainManager chain;
        chain.init(kSampleRate, kBlockSize);

        const int chainNode = chain.addEffect("testgain", 0);
        CHECK(chainNode >= 0, "chain effect should instantiate via addEffect");
        CHECK(chain.setEffectParameter(chainNode, "gain", 2.0f), "chain gain should be settable");

        juce::AudioBuffer<float> buf(2, kBlockSize);
        for (int pass = 0; pass < 8; ++pass)
        {
            fillBuffer(buf, 0.25f);
            chain.processBlock(buf, kBlockSize, midi);
        }
        CHECK(meanAbs(buf) > 0.40f, "chain route should be audible BEFORE graph mode takes over");

        // Graph mode syncs a topology with no Track Input -> Track Output path.
        const auto disconnected = topology(
            nlohmann::json::array({
                ioNode("input", "trackInput"),
                ioNode("output", "trackOutput"),
            }),
            nlohmann::json::array());
        const auto res = chain.syncGraphTopology(disconnected);
        CHECK(res.value("ok", false)
                  && res.value("mode", std::string{}) == "disconnected"
                  && res.value("reason", std::string{}) == "graph_output_disconnected",
              "empty graph should report disconnected output as valid silence");

        for (int pass = 0; pass < 8; ++pass)
        {
            fillBuffer(buf, 0.25f);
            chain.processBlock(buf, kBlockSize, midi);
        }
        CHECK_NEAR(meanAbs(buf), 0.0f, 0.001f,
                   "FXG.3-c-b-r1: stale chain route must be silent once graph mode owns routing");
    }

    // ── 2. Adoption registers chain processors as graph-owned, preserving state ──
    {
        EffectChainManager chain;
        chain.init(kSampleRate, kBlockSize);

        const int chainNode = chain.addEffect("testgain", 0);
        CHECK(chain.setEffectParameter(chainNode, "gain", 2.0f), "chain gain should be settable");

        // engineNodeId is sent as a JSON double on purpose: the bridge's
        // napiToJson encodes every JS number as a double, so adoptGraphNodes must
        // accept number_float (not just number_integer) or it skips everything.
        const nlohmann::json mapping = nlohmann::json::array({
            {{"effectInstanceId", "inst-adopt"}, {"engineNodeId", static_cast<double>(chainNode)}},
        });
        const auto adoptRes = chain.adoptGraphNodes(mapping);
        CHECK(adoptRes.value("ok", false), "adoptGraphNodes should succeed for a live node");
        CHECK(chain.getGraphNodeEngineId("inst-adopt") == chainNode,
              "adopted effectInstanceId should map to the EXISTING chain processor");

        const auto linear = topology(
            nlohmann::json::array({
                ioNode("input", "trackInput"),
                effectNode("fx", "inst-adopt"),
                ioNode("output", "trackOutput"),
            }),
            nlohmann::json::array({
                edge("e1", "input", "fx"),
                edge("e2", "fx", "output"),
            }));
        const auto res = chain.syncGraphTopology(linear);
        CHECK(res.value("ok", false) && res.value("mode", std::string{}) == "linear",
              "adopted effect should route linearly");

        juce::AudioBuffer<float> buf(2, kBlockSize);
        for (int pass = 0; pass < 8; ++pass)
        {
            fillBuffer(buf, 0.25f);
            chain.processBlock(buf, kBlockSize, midi);
        }
        CHECK_NEAR(meanAbs(buf), 0.5f, 0.03f,
                   "adopted effect should process with its PRESERVED gain (0.25 * 2.0)");

        const nlohmann::json bad = nlohmann::json::array({
            {{"effectInstanceId", "inst-bad"}, {"engineNodeId", 999999}},
        });
        const auto badRes = chain.adoptGraphNodes(bad);
        CHECK(badRes.value("ok", false) && badRes["adopted"].empty()
                  && !badRes["skipped"].empty(),
              "adoption should skip an unknown engine node id");
    }

    // ── 3. A disconnected effect node must not contribute to output ──────────
    {
        EffectChainManager chain;
        chain.init(kSampleRate, kBlockSize);

        const int fxA = chain.addGraphNode("inst-a", "testgain");
        const int fxB = chain.addGraphNode("inst-b", "testgain");
        CHECK(fxA >= 0 && fxB >= 0, "graph-owned nodes should instantiate");
        chain.setEffectParameter(fxA, "gain", 2.0f);
        chain.setEffectParameter(fxB, "gain", 2.0f);

        // input -> fx-a -> output ; fx-b is allocated but wired to nothing.
        const auto t = topology(
            nlohmann::json::array({
                ioNode("input", "trackInput"),
                effectNode("fx-a", "inst-a"),
                effectNode("fx-b", "inst-b"),
                ioNode("output", "trackOutput"),
            }),
            nlohmann::json::array({
                edge("e1", "input", "fx-a"),
                edge("e2", "fx-a", "output"),
            }));
        const auto res = chain.syncGraphTopology(t);
        CHECK(res.value("ok", false) && res.value("pathEffectCount", -1) == 1,
              "only the connected effect should be on the active path");

        juce::AudioBuffer<float> buf(2, kBlockSize);
        for (int pass = 0; pass < 8; ++pass)
        {
            fillBuffer(buf, 0.25f);
            chain.processBlock(buf, kBlockSize, midi);
        }
        CHECK_NEAR(meanAbs(buf), 0.5f, 0.03f,
                   "disconnected fx-b must not add to output (only 0.25 * 2.0)");
    }
}

static void testBypass()
{
    std::cout << "  [bypass]\n";
    constexpr double kSampleRate = 44100.0;
    constexpr int    kBlockSize  = 512;

    TestGainEffect fx;
    juce::MidiBuffer midi;
    fx.prepareToPlay(kSampleRate, kBlockSize);

    // Set gain to something very different from 1 so bypass is detectable
    fx.setParameterValue("gain", 4.0f);
    // Let the ramp settle
    {
        juce::AudioBuffer<float> buf(2, kBlockSize);
        fillBuffer(buf, 1.0f);
        fx.processBlock(buf, midi); // ramp starts
        fx.processBlock(buf, midi); // ramp settles
    }

    // Now bypass and let the bypass ramp settle (5 ms @ 44100 ≈ 221 samples;
    // one 512-sample block is enough to fully transition)
    fx.setBypassed(true);
    juce::AudioBuffer<float> buf(2, kBlockSize);
    fillBuffer(buf, 1.0f);
    fx.processBlock(buf, midi); // 5ms bypass crossfade (wet→dry over ~221 samples)

    // The crossfade block blends wet (gain=4) and dry (1.0).  Its average lies
    // between 1.0 (fully dry) and 4.0 (fully wet) — below 2.5 confirms bypass
    // is actively transitioning toward dry (not stuck at full gain).
    const float avg = meanAbs(buf);
    CHECK(avg < 2.5f, "bypass crossfade block should be below 2.5 (transitioning toward dry)");

    // One more block fully bypassed: should be exactly dry
    fillBuffer(buf, 1.0f);
    fx.processBlock(buf, midi);
    const float avg2 = meanAbs(buf);
    CHECK_NEAR(avg2, 1.0f, 0.01f, "fully bypassed output should equal dry signal");
}

static void testJSONHelpers()
{
    std::cout << "  [JSON helpers]\n";

    TestGainEffect fx;
    fx.prepareToPlay(44100.0, 256);
    fx.setParameterValue("gain", 1.5f);

    // getParametersAsJSON
    const std::string paramsJson = fx.getParametersAsJSON();
    CHECK(!paramsJson.empty(), "getParametersAsJSON should return non-empty string");

    auto j = nlohmann::json::parse(paramsJson, nullptr, false);
    CHECK(!j.is_discarded(), "getParametersAsJSON should be valid JSON");
    CHECK(j.is_array() && j.size() == 1, "should be JSON array with 1 element");
    if (j.is_array() && !j.empty())
    {
        CHECK(j[0].contains("id"),      "param entry should have 'id'");
        CHECK(j[0].contains("name"),    "param entry should have 'name'");
        CHECK(j[0].contains("min"),     "param entry should have 'min'");
        CHECK(j[0].contains("max"),     "param entry should have 'max'");
        CHECK(j[0].contains("default"), "param entry should have 'default'");
        CHECK(j[0].contains("value"),   "param entry should have 'value'");
        CHECK(j[0]["id"] == "gain",     "param id should be 'gain'");
        CHECK_NEAR(j[0]["value"].get<float>(), 1.5f, 0.05f,
                   "param value should be ≈ 1.5");
    }

    // getMeterAsJSON
    {
        juce::AudioBuffer<float> buf(2, 256);
        fillBuffer(buf, 0.8f);
        juce::MidiBuffer midi;
        fx.processBlock(buf, midi);
    }

    const std::string meterJson = fx.getMeterAsJSON();
    CHECK(!meterJson.empty(), "getMeterAsJSON should return non-empty string");

    auto m = nlohmann::json::parse(meterJson, nullptr, false);
    CHECK(!m.is_discarded(), "getMeterAsJSON should be valid JSON");
    CHECK(m.is_array() && m.size() == static_cast<std::size_t>(XlethEffectBase::kNumMeterSlots),
          "meter JSON should have kNumMeterSlots elements");
    if (m.is_array() && m.size() > 0)
        CHECK(m[0].get<float>() > 0.0f, "meter slot 0 should be > 0 after processing");
}

static void testDistortionModesDiffer()
{
    std::cout << "  [distortion mode separation]\n";
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 2048;
    constexpr int    kSkip = 128;
    constexpr float  kPi2 = 2.0f * juce::MathConstants<float>::pi;

    std::array<std::array<float, kBS>, 7> rendered {};

    for (int mode = 0; mode < 7; ++mode)
    {
        XlethDistortionEffect fx;
        CHECK(fx.setParameterValue("mode", static_cast<float>(mode)),
              "distortion mode param should be settable");
        // Crush-only params: pushed off their transparent defaults so mode 4 is
        // compared as the crusher it is, not as the clipper it degenerates to
        // at 16 bits / 1x.
        CHECK(fx.setParameterValue("bits", 6.0f),
              "distortion bits param should be settable");
        CHECK(fx.setParameterValue("downsample", 4.0f),
              "distortion downsample param should be settable");
        CHECK(fx.setParameterValue("drive", 12.0f),
              "distortion drive param should be settable");
        CHECK(fx.setParameterValue("tone", 20000.0f),
              "distortion tone param should be settable");
        CHECK(fx.setParameterValue("filter_pos", 1.0f),
              "distortion filter_pos param should be settable");
        CHECK(fx.setParameterValue("mix", 100.0f),
              "distortion mix param should be settable");

        fx.prepareToPlay(kSR, kBS);

        juce::AudioBuffer<float> buf(2, kBS);
        for (int s = 0; s < kBS; ++s)
        {
            const float t = static_cast<float>(s) / static_cast<float>(kBS - 1);
            const float sweep = -0.85f + 1.70f * t;
            const float sine = std::sin(kPi2 * 7.0f * static_cast<float>(s) / static_cast<float>(kBS));
            const float v = juce::jlimit(-0.95f, 0.95f, 0.62f * sine + 0.22f * sweep);
            buf.setSample(0, s, v);
            buf.setSample(1, s, v);
        }

        juce::MidiBuffer midi;
        fx.processBlock(buf, midi);

        for (int s = 0; s < kBS; ++s)
            rendered[static_cast<size_t>(mode)][static_cast<size_t>(s)] = buf.getSample(0, s);
    }

    float minRmsDiff = 999.0f;
    for (int a = 0; a < 7; ++a)
    {
        for (int b = a + 1; b < 7; ++b)
        {
            double sumSq = 0.0;
            for (int s = kSkip; s < kBS; ++s)
            {
                const double d = rendered[static_cast<size_t>(a)][static_cast<size_t>(s)]
                               - rendered[static_cast<size_t>(b)][static_cast<size_t>(s)];
                sumSq += d * d;
            }
            const float rms = static_cast<float>(std::sqrt(sumSq / static_cast<double>(kBS - kSkip)));
            minRmsDiff = std::min(minRmsDiff, rms);
        }
    }

    std::cout << "    min pairwise RMS diff: " << minRmsDiff << "\n";
    CHECK(minRmsDiff > 0.025f,
          "distortion modes should produce measurably different output for the same input");
}

// ─── Distortion legacy-render regression guard ───────────────────────────────
// Renders the four PRE-EXISTING distortion modes (0–3) with every other
// parameter left at its APVTS default and fingerprints the result. The golden
// numbers below were captured from the build immediately BEFORE the 7-mode
// expansion landed, so any change to the legacy shaping path — including a
// non-transparent default for the new symmetry / bits / downsample params —
// breaks this test. Exact float equality is intentional: "bit-identical" is the
// contract, not "close enough".
// APVTS is protected on XlethEffectBase, so reach parameters the way the engine
// itself does for stock effects — through the AudioProcessor parameter list.
static juce::RangedAudioParameter* findRangedParam(juce::AudioProcessor& proc,
                                                   const juce::String& paramId)
{
    for (auto* p : proc.getParameters())
        if (auto* rp = dynamic_cast<juce::RangedAudioParameter*>(p))
            if (rp->paramID == paramId)
                return rp;
    return nullptr;
}

struct DistortionFingerprint
{
    float  peak    = 0.0f;
    double sumAbs  = 0.0;
    double weighted = 0.0;
};

static DistortionFingerprint renderDistortionDefaults(int mode)
{
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 2048;
    constexpr float  kPi2 = 2.0f * juce::MathConstants<float>::pi;

    XlethDistortionEffect fx;
    // ONLY the mode is set — every other parameter must stay at its default so
    // this doubles as a default-value guard for the newly added params.
    CHECK(fx.setParameterValue("mode", static_cast<float>(mode)),
          "regression render: mode param should be settable");

    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    for (int s = 0; s < kBS; ++s)
    {
        const float t = static_cast<float>(s) / static_cast<float>(kBS - 1);
        const float sweep = -0.85f + 1.70f * t;
        const float sine = std::sin(kPi2 * 7.0f * static_cast<float>(s) / static_cast<float>(kBS));
        const float v = juce::jlimit(-0.95f, 0.95f, 0.62f * sine + 0.22f * sweep);
        buf.setSample(0, s, v);
        buf.setSample(1, s, v);
    }

    juce::MidiBuffer midi;
    fx.processBlock(buf, midi);

    DistortionFingerprint fp;
    for (int s = 0; s < kBS; ++s)
    {
        const float x = buf.getSample(0, s);
        fp.peak     = std::max(fp.peak, std::abs(x));
        fp.sumAbs  += std::abs(static_cast<double>(x));
        fp.weighted += static_cast<double>(x) * static_cast<double>(s % 97);
    }
    return fp;
}

static void testDistortionDefaultRenderUnchanged()
{
    std::cout << "  [distortion default-render regression]\n";

    // Golden fingerprints captured pre-expansion (see comment above).
    struct Golden { float peak; double sumAbs; double weighted; };
    static const Golden kGolden[4] = {
        { 0.9928135871887207f, 1260.4362006411293, 2713.0245958208216 }, // Tube
        { 1.1929118633270264f, 1722.3966890491010, 3797.8096109480311 }, // Soft Clip
        { 1.0747795104980469f, 1612.4634629828097, 4000.2805844426439 }, // Hard Clip
        { 1.0915191173553467f, 1517.3326005375500, 3806.9994734264010 }, // Analog
    };

    for (int mode = 0; mode < 4; ++mode)
    {
        const auto fp = renderDistortionDefaults(mode);
        std::cout.precision(17);
        std::cout << "    mode " << mode
                  << " peak=" << fp.peak
                  << " sumAbs=" << fp.sumAbs
                  << " weighted=" << fp.weighted << "\n";
        std::cout.precision(6);

        const auto& g = kGolden[mode];
        CHECK(fp.peak == g.peak,
              "legacy distortion mode peak must be bit-identical to the pre-expansion build");
        CHECK(fp.sumAbs == g.sumAbs,
              "legacy distortion mode sumAbs must be bit-identical to the pre-expansion build");
        CHECK(fp.weighted == g.weighted,
              "legacy distortion mode weighted sum must be bit-identical to the pre-expansion build");
    }

    // The guard above only means anything while the new params really do default
    // to their transparent values, so pin the defaults themselves.
    {
        XlethDistortionEffect fx;
        auto defaultOf = [&fx](const char* id) -> float
        {
            auto* p = findRangedParam(fx, id);
            return p ? p->convertFrom0to1(p->getDefaultValue()) : -1.0f;
        };

        CHECK(defaultOf("symmetry") == 100.0f,
              "symmetry must default to 100 % (the historical fixed Analog bias)");
        CHECK(defaultOf("bits") == 16.0f,
              "bits must default to 16 (transparent quantization)");
        CHECK(defaultOf("downsample") == 1.0f,
              "downsample must default to 1x (no sample-and-hold)");
    }
}

// ─── Distortion: new modes are bounded and finite ────────────────────────────
static void testDistortionNewModesSafety()
{
    std::cout << "  [distortion new-mode safety]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 1024;

    // Four hostile inputs: silence, full-scale DC, a full-scale impulse train,
    // and a loud low-frequency sine (the case that drives a sample-and-hold
    // hardest). All seven modes are run so the bound on the new ones can be
    // calibrated against what the shipped ones already do on the same input —
    // an absolute "must stay under 1.0" would be wrong here: the oversampler's
    // FIR rings on an impulse and the 10 Hz DC blocker overshoots on a step, so
    // even Hard Clip leaves this stress test well above unity.
    std::array<float, 7> worstPeak {};
    for (int mode = 0; mode <= 6; ++mode)
    {
        for (int shape = 0; shape < 4; ++shape)
        {
            XlethDistortionEffect fx;
            CHECK(fx.setParameterValue("mode", static_cast<float>(mode)), "mode settable");
            CHECK(fx.setParameterValue("drive", 48.0f), "drive settable");       // max
            CHECK(fx.setParameterValue("tone", 20000.0f), "tone settable");
            CHECK(fx.setParameterValue("mix", 100.0f), "mix settable");
            CHECK(fx.setParameterValue("bits", 2.0f), "bits settable");          // min
            CHECK(fx.setParameterValue("downsample", 40.0f), "downsample settable"); // max

            fx.prepareToPlay(kSR, kBS);

            juce::AudioBuffer<float> buf(2, kBS);
            for (int s = 0; s < kBS; ++s)
            {
                float v = 0.0f;
                switch (shape)
                {
                    case 0: v = 0.0f; break;
                    case 1: v = 1.0f; break;
                    case 2: v = (s % 64 == 0) ? 1.0f : 0.0f; break;
                    default:
                        v = std::sin(2.0f * juce::MathConstants<float>::pi
                                     * 55.0f * static_cast<float>(s)
                                     / static_cast<float>(kSR));
                        break;
                }
                buf.setSample(0, s, v);
                buf.setSample(1, s, -v);
            }

            juce::MidiBuffer midi;
            // Two blocks: the second one exercises state carried across blocks
            // (Crush's hold register, Fuzz's lowpass pole).
            fx.processBlock(buf, midi);
            fx.processBlock(buf, midi);

            float peak = 0.0f;
            bool  finite = true;
            for (int ch = 0; ch < 2; ++ch)
                for (int s = 0; s < kBS; ++s)
                {
                    const float v = buf.getSample(ch, s);
                    if (!std::isfinite(v)) finite = false;
                    peak = std::max(peak, std::abs(v));
                }

            CHECK(finite, "distortion modes must never emit NaN or Inf");
            worstPeak[static_cast<size_t>(mode)] =
                std::max(worstPeak[static_cast<size_t>(mode)], peak);
        }
    }

    float legacyWorst = 0.0f;
    for (int mode = 0; mode < 4; ++mode)
        legacyWorst = std::max(legacyWorst, worstPeak[static_cast<size_t>(mode)]);

    std::cout << "    worst peak per mode:";
    for (int mode = 0; mode <= 6; ++mode)
        std::cout << " " << mode << ":" << worstPeak[static_cast<size_t>(mode)];
    std::cout << "  (legacy worst " << legacyWorst << ")\n";

    for (int mode = 4; mode <= 6; ++mode)
        CHECK(worstPeak[static_cast<size_t>(mode)] <= legacyWorst,
              "new distortion modes must stay at or below the shipped modes' worst-case peak");
}

// ─── Distortion: Crush params actually do something ──────────────────────────
static void testDistortionCrushParams()
{
    std::cout << "  [distortion crush params]\n";
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 2048;

    auto renderCrush = [](float bits, float downsample)
    {
        XlethDistortionEffect fx;
        fx.setParameterValue("mode", 4.0f);
        fx.setParameterValue("drive", 6.0f);
        fx.setParameterValue("tone", 20000.0f);
        fx.setParameterValue("bits", bits);
        fx.setParameterValue("downsample", downsample);
        fx.prepareToPlay(kSR, kBS);

        juce::AudioBuffer<float> buf(2, kBS);
        for (int s = 0; s < kBS; ++s)
        {
            const float v = 0.5f * std::sin(2.0f * juce::MathConstants<float>::pi
                                            * 220.0f * static_cast<float>(s)
                                            / static_cast<float>(kSR));
            buf.setSample(0, s, v);
            buf.setSample(1, s, v);
        }
        juce::MidiBuffer midi;
        fx.processBlock(buf, midi);
        return buf;
    };

    auto rmsDiff = [](const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b)
    {
        double sumSq = 0.0;
        for (int s = 128; s < kBS; ++s)
        {
            const double d = static_cast<double>(a.getSample(0, s))
                           - static_cast<double>(b.getSample(0, s));
            sumSq += d * d;
        }
        return std::sqrt(sumSq / static_cast<double>(kBS - 128));
    };

    const auto transparent = renderCrush(16.0f, 1.0f);   // both params neutral
    const auto fewBits     = renderCrush(4.0f,  1.0f);   // quantizer only
    const auto decimated   = renderCrush(16.0f, 12.0f);  // sample-and-hold only

    const double bitsDelta = rmsDiff(transparent, fewBits);
    const double dsDelta   = rmsDiff(transparent, decimated);
    std::cout << "    bits delta RMS: " << bitsDelta
              << "   downsample delta RMS: " << dsDelta << "\n";

    // Each param is checked on its own so a param that is read but never used
    // cannot hide behind the other one.
    CHECK(bitsDelta > 0.01, "lowering bits must audibly change the Crush output");
    CHECK(dsDelta   > 0.01, "raising downsample must audibly change the Crush output");
}

// ─── Distortion: symmetry morph ──────────────────────────────────────────────
static void testDistortionSymmetry()
{
    std::cout << "  [distortion symmetry]\n";
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 2048;

    // symmetry = 0 must collapse Analog to a symmetric (odd) shaper: feeding
    // -x must produce exactly -f(x). At symmetry = 100 the diode bias is back
    // and that identity must NOT hold.
    auto asymmetryOf = [](float symmetry) -> float
    {
        std::array<juce::AudioBuffer<float>, 2> outs {
            juce::AudioBuffer<float>(2, kBS), juce::AudioBuffer<float>(2, kBS) };

        for (int polarity = 0; polarity < 2; ++polarity)
        {
            XlethDistortionEffect fx;
            fx.setParameterValue("mode", 3.0f);
            fx.setParameterValue("symmetry", symmetry);
            fx.setParameterValue("tone", 20000.0f);
            fx.prepareToPlay(kSR, kBS);

            const float sign = polarity == 0 ? 1.0f : -1.0f;
            for (int s = 0; s < kBS; ++s)
            {
                const float v = sign * 0.8f
                    * std::sin(2.0f * juce::MathConstants<float>::pi * 9.0f
                               * static_cast<float>(s) / static_cast<float>(kBS));
                outs[static_cast<size_t>(polarity)].setSample(0, s, v);
                outs[static_cast<size_t>(polarity)].setSample(1, s, v);
            }

            juce::MidiBuffer midi;
            fx.processBlock(outs[static_cast<size_t>(polarity)], midi);
        }

        double sumSq = 0.0;
        for (int s = 0; s < kBS; ++s)
        {
            const double d = static_cast<double>(outs[0].getSample(0, s))
                           + static_cast<double>(outs[1].getSample(0, s));
            sumSq += d * d;
        }
        return static_cast<float>(std::sqrt(sumSq / static_cast<double>(kBS)));
    };

    const float asymAt0   = asymmetryOf(0.0f);
    const float asymAt100 = asymmetryOf(100.0f);
    std::cout << "    odd-symmetry residual: symmetry=0 -> " << asymAt0
              << ", symmetry=100 -> " << asymAt100 << "\n";

    CHECK(asymAt0 < 1.0e-4f,
          "symmetry=0 must make Analog an odd (symmetric) shaper");
    CHECK(asymAt100 > 20.0f * std::max(asymAt0, 1.0e-6f),
          "symmetry=100 must retain the asymmetric diode bias");
}

// ─── Distortion: loudness honesty across all 7 modes ─────────────────────────
static void testDistortionModeLoudness()
{
    std::cout << "  [distortion mode loudness]\n";
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 4096;

    for (const float driveDb : { 6.0f, 12.0f, 24.0f })
    {
        std::array<double, 7> rms {};
        for (int mode = 0; mode < 7; ++mode)
        {
            XlethDistortionEffect fx;
            fx.setParameterValue("mode", static_cast<float>(mode));
            fx.setParameterValue("drive", driveDb);
            fx.setParameterValue("tone", 20000.0f);
            fx.setParameterValue("bits", 8.0f);
            fx.setParameterValue("downsample", 4.0f);
            fx.prepareToPlay(kSR, kBS);

            juce::AudioBuffer<float> buf(2, kBS);
            for (int s = 0; s < kBS; ++s)
            {
                const float ph = 2.0f * juce::MathConstants<float>::pi
                               * static_cast<float>(s) / static_cast<float>(kSR);
                const float v = 0.35f * (std::sin(110.0f * ph)
                                       + 0.6f * std::sin(277.0f * ph)
                                       + 0.3f * std::sin(660.0f * ph));
                buf.setSample(0, s, v);
                buf.setSample(1, s, v);
            }

            juce::MidiBuffer midi;
            fx.processBlock(buf, midi);

            double sumSq = 0.0;
            for (int s = 256; s < kBS; ++s)
            {
                const double v = buf.getSample(0, s);
                sumSq += v * v;
            }
            rms[static_cast<size_t>(mode)] = std::sqrt(sumSq / static_cast<double>(kBS - 256));
        }

        // Reference = mean RMS of the four shipped modes.
        const double ref = (rms[0] + rms[1] + rms[2] + rms[3]) / 4.0;
        std::cout << "    drive " << driveDb << " dB  ref=" << ref << "  ";
        for (int mode = 0; mode < 7; ++mode)
            std::cout << mode << ":" << (20.0 * std::log10(rms[static_cast<size_t>(mode)] / ref)) << "dB ";
        std::cout << "\n";

        for (int mode = 4; mode < 7; ++mode)
        {
            const double deltaDb = 20.0 * std::log10(rms[static_cast<size_t>(mode)] / ref);
            CHECK(std::abs(deltaDb) <= 2.5,
                  "new distortion modes must sit within 2.5 dB of the legacy modes' loudness");
        }
    }
}

// ─── Distortion: new params reach the graph/automation parameter surface ─────
static void testDistortionParameterSurface()
{
    std::cout << "  [distortion parameter surface]\n";
    XlethDistortionEffect fx;

    // Stock effects expose their parameters to the mixer graph and to automation
    // straight from the APVTS (buildGraphEffectParameterDescriptors walks
    // getParameters(); getParametersAsJSON mirrors it). Being in createLayout IS
    // the registration — so assert both surfaces actually see the new params.
    const std::string json = fx.getParametersAsJSON();
    for (const char* id : { "mode", "drive", "tone", "filter_pos", "mix",
                            "symmetry", "bits", "downsample" })
    {
        CHECK(json.find(std::string("\"id\":\"") + id + "\"") != std::string::npos,
              "distortion parameter JSON should expose every APVTS param");

        std::atomic<float>* raw = nullptr;
        juce::RangedAudioParameter* param = nullptr;
        CHECK(fx.resolveAutomationParameter(id, raw, param) && raw && param,
              "every distortion param should be automation-resolvable");
    }

    auto* modeParam = findRangedParam(fx, "mode");
    CHECK(modeParam != nullptr, "mode param should exist");
    if (modeParam)
    {
        CHECK(modeParam->getNormalisableRange().end == 6.0f,
              "mode range should be 0-6 after the append-only expansion");
        CHECK(modeParam->getNormalisableRange().start == 0.0f,
              "mode range should still start at 0");
    }
}

static void testTransientAttackShaping()
{
    std::cout << "  [transient attack]\n";
    constexpr double kSR = 44100.0;
    constexpr int kSamples = 4096;
    const std::vector<int> schedule = {37, 128, 255, 511};

    juce::AudioBuffer<float> input(2, kSamples);
    fillTransientHit(input, 1.0f, 0.86f, 3.0f, 0.38f, 820.0f);

    auto renderAttack = [&](float attackValue)
    {
        XlethTransientProcEffect fx;
        CHECK(fx.setParameterValue("attack", attackValue),
              "Transient attack param should be settable");
        CHECK(fx.setParameterValue("sustain", 0.0f),
              "Transient sustain param should be settable");
        CHECK(fx.setParameterValue("attack_speed", 4.0f),
              "Transient attack_speed param should be settable");
        CHECK(fx.setParameterValue("threshold", -60.0f),
              "Transient threshold param should be settable");
        CHECK(fx.setParameterValue("mix", 100.0f),
              "Transient mix param should be settable");
        CHECK(fx.setParameterValue("midi_detect", 0.0f),
              "Transient midi_detect param should be settable");
        fx.prepareToPlay(kSR, maxBlockSizeOf(schedule));
        return renderTransientEffectInBlocks(fx, input, schedule);
    };

    const auto neutral = renderAttack(0.0f);
    const auto boosted = renderAttack(100.0f);
    const auto softened = renderAttack(-100.0f);

    const double neutralPeak = windowPeakAbs(neutral.output, 0, 0, 96);
    const double boostedPeak = windowPeakAbs(boosted.output, 0, 0, 96);
    const double softenedPeak = windowPeakAbs(softened.output, 0, 0, 96);
    const double neutralEarlyRms = windowRms(neutral.output, 0, 0, 128);
    const double boostedEarlyRms = windowRms(boosted.output, 0, 0, 128);
    const double softenedEarlyRms = windowRms(softened.output, 0, 0, 128);

    CHECK(boostedPeak > neutralPeak * 1.05,
          "positive attack should increase early transient peak");
    CHECK(boostedEarlyRms > neutralEarlyRms * 1.08,
          "positive attack should increase early transient RMS");
    CHECK(softenedPeak < neutralPeak * 0.96,
          "negative attack should reduce early transient peak");
    CHECK(softenedEarlyRms < neutralEarlyRms * 0.96,
          "negative attack should reduce early transient RMS");
    CHECK(boosted.dominantSignedGainDb > 0.5f,
          "positive attack should report positive signed gain");
    CHECK(softened.dominantSignedGainDb < -0.5f,
          "negative attack should report negative signed gain");
}

static void testTransientSustainShaping()
{
    std::cout << "  [transient sustain]\n";
    constexpr double kSR = 44100.0;
    constexpr int kSamples = 8192;
    const std::vector<int> schedule = {64, 257, 511};

    juce::AudioBuffer<float> input(2, kSamples);
    fillTransientHit(input, 1.0f, 0.72f, 2.4f, 0.48f, 1800.0f);

    auto renderSustain = [&](float sustainValue)
    {
        XlethTransientProcEffect fx;
        CHECK(fx.setParameterValue("attack", 0.0f),
              "Transient attack param should be settable");
        CHECK(fx.setParameterValue("sustain", sustainValue),
              "Transient sustain param should be settable");
        CHECK(fx.setParameterValue("attack_speed", 5.0f),
              "Transient attack_speed param should be settable");
        CHECK(fx.setParameterValue("threshold", -60.0f),
              "Transient threshold param should be settable");
        CHECK(fx.setParameterValue("mix", 100.0f),
              "Transient mix param should be settable");
        CHECK(fx.setParameterValue("midi_detect", 0.0f),
              "Transient midi_detect param should be settable");
        fx.prepareToPlay(kSR, maxBlockSizeOf(schedule));
        return renderTransientEffectInBlocks(fx, input, schedule);
    };

    const auto neutral = renderSustain(0.0f);
    const auto boosted = renderSustain(100.0f);
    const auto tightened = renderSustain(-100.0f);

    const double neutralTailRms = windowRms(neutral.output, 0, 512, 4096);
    const double boostedTailRms = windowRms(boosted.output, 0, 512, 4096);
    const double tightenedTailRms = windowRms(tightened.output, 0, 512, 4096);

    CHECK(boostedTailRms > neutralTailRms * 1.10,
          "positive sustain should increase post-onset tail RMS");
    CHECK(tightenedTailRms < neutralTailRms * 0.90,
          "negative sustain should reduce post-onset tail RMS");
    CHECK(boosted.dominantSignedGainDb > 0.5f,
          "positive sustain should report positive signed gain");
    CHECK(tightened.dominantSignedGainDb < -0.5f,
          "negative sustain should report negative signed gain");
}

static void testTransientMixAndBypass()
{
    std::cout << "  [transient mix and bypass]\n";
    constexpr double kSR = 44100.0;
    constexpr int kSamples = 4096;
    const std::vector<int> schedule = {113, 256, 511};

    juce::AudioBuffer<float> input(2, kSamples);
    fillTransientHit(input, 1.0f, 0.84f, 3.2f, 0.42f, 1200.0f);

    XlethTransientProcEffect mixZero;
    CHECK(mixZero.setParameterValue("attack", 100.0f), "Transient attack should be settable");
    CHECK(mixZero.setParameterValue("sustain", 100.0f), "Transient sustain should be settable");
    CHECK(mixZero.setParameterValue("attack_speed", 4.0f), "Transient attack_speed should be settable");
    CHECK(mixZero.setParameterValue("threshold", -60.0f), "Transient threshold should be settable");
    CHECK(mixZero.setParameterValue("mix", 0.0f), "Transient mix should be settable");
    CHECK(mixZero.setParameterValue("midi_detect", 0.0f), "Transient midi_detect should be settable");
    mixZero.prepareToPlay(kSR, maxBlockSizeOf(schedule));
    const auto mixZeroRender = renderTransientEffectInBlocks(mixZero, input, schedule);
    CHECK(maxAbsDifference(mixZeroRender.output, input) < 1.0e-6f,
          "mix 0 should return the dry signal");

    XlethTransientProcEffect bypassed;
    CHECK(bypassed.setParameterValue("attack", 100.0f), "Transient attack should be settable");
    CHECK(bypassed.setParameterValue("sustain", -100.0f), "Transient sustain should be settable");
    CHECK(bypassed.setParameterValue("attack_speed", 4.0f), "Transient attack_speed should be settable");
    CHECK(bypassed.setParameterValue("threshold", -60.0f), "Transient threshold should be settable");
    CHECK(bypassed.setParameterValue("mix", 100.0f), "Transient mix should be settable");
    CHECK(bypassed.setParameterValue("midi_detect", 0.0f), "Transient midi_detect should be settable");
    bypassed.prepareToPlay(kSR, maxBlockSizeOf(schedule));
    bypassed.setBypassed(true);
    bypassed.reset();
    const auto bypassRender = renderTransientEffectInBlocks(bypassed, input, schedule);
    CHECK(maxAbsDifference(bypassRender.output, input) < 1.0e-6f,
          "bypassed transient processor should return the dry signal");
}

static void testTransientSafety()
{
    std::cout << "  [transient safety]\n";
    constexpr double kSR = 44100.0;
    constexpr int kSamples = 8192;
    const std::vector<int> schedule = {31, 97, 255, 640};

    juce::AudioBuffer<float> input(2, kSamples);
    for (int s = 0; s < kSamples; ++s)
    {
        const float left = (s % 2 == 0 ? 0.98f : -0.98f);
        const float right = (s % 3 == 0 ? 0.91f : -0.91f);
        input.setSample(0, s, left);
        input.setSample(1, s, right);
    }

    XlethTransientProcEffect fx;
    CHECK(fx.setParameterValue("attack", 100.0f), "Transient attack should be settable");
    CHECK(fx.setParameterValue("sustain", 100.0f), "Transient sustain should be settable");
    CHECK(fx.setParameterValue("attack_speed", 0.5f), "Transient attack_speed should be settable");
    CHECK(fx.setParameterValue("threshold", -60.0f), "Transient threshold should be settable");
    CHECK(fx.setParameterValue("mix", 100.0f), "Transient mix should be settable");
    CHECK(fx.setParameterValue("midi_detect", 0.0f), "Transient midi_detect should be settable");
    fx.prepareToPlay(kSR, maxBlockSizeOf(schedule));

    const auto rendered = renderTransientEffectInBlocks(fx, input, schedule);
    CHECK(allSamplesFinite(rendered.output),
          "transient output should remain finite under extreme settings");
    CHECK(maxAbsBuffer(rendered.output) <= 4.1f,
          "transient output should remain bounded under extreme settings");
    CHECK(std::isfinite(rendered.dominantSignedGainDb),
          "transient signed gain meter should remain finite");
}

static void testTransientStereoLinking()
{
    std::cout << "  [transient stereo link]\n";
    constexpr double kSR = 44100.0;
    constexpr int kSamples = 4096;
    constexpr float kRightScale = 0.5f;
    const std::vector<int> schedule = {53, 149, 337};

    juce::AudioBuffer<float> input(2, kSamples);
    fillTransientHit(input, kRightScale, 0.82f, 2.8f, 0.44f, 1000.0f);

    XlethTransientProcEffect fx;
    CHECK(fx.setParameterValue("attack", 80.0f), "Transient attack should be settable");
    CHECK(fx.setParameterValue("sustain", -65.0f), "Transient sustain should be settable");
    CHECK(fx.setParameterValue("attack_speed", 4.5f), "Transient attack_speed should be settable");
    CHECK(fx.setParameterValue("threshold", -60.0f), "Transient threshold should be settable");
    CHECK(fx.setParameterValue("mix", 100.0f), "Transient mix should be settable");
    CHECK(fx.setParameterValue("midi_detect", 0.0f), "Transient midi_detect should be settable");
    fx.prepareToPlay(kSR, maxBlockSizeOf(schedule));

    const auto rendered = renderTransientEffectInBlocks(fx, input, schedule);
    CHECK(maxStereoRatioError(rendered.output, kRightScale) < 1.0e-5,
          "stereo-linked gain should preserve left/right balance");
}

static void testTransientMidiAttackMode()
{
    std::cout << "  [transient MIDI mode]\n";
    constexpr double kSR = 44100.0;
    constexpr int kSamples = 4096;
    const std::vector<int> schedule = {128, 256, 512};

    juce::AudioBuffer<float> input(2, kSamples);
    fillSineBuffer(input, kSR, 0.35f, 220.0f);

    auto renderMidi = [&](float sustainValue, bool triggerMidi)
    {
        XlethTransientProcEffect fx;
        CHECK(fx.setParameterValue("attack", 100.0f),
              "Transient attack should be settable");
        CHECK(fx.setParameterValue("sustain", sustainValue),
              "Transient sustain should be settable");
        CHECK(fx.setParameterValue("attack_speed", 8.0f),
              "Transient attack_speed should be settable");
        CHECK(fx.setParameterValue("threshold", -12.0f),
              "Transient threshold should be settable");
        CHECK(fx.setParameterValue("mix", 100.0f),
              "Transient mix should be settable");
        CHECK(fx.setParameterValue("midi_detect", 1.0f),
              "Transient midi_detect should be settable");
        fx.prepareToPlay(kSR, maxBlockSizeOf(schedule));
        return renderTransientEffectInBlocks(fx, input, schedule, triggerMidi, 1.0f);
    };

    const auto noOnset = renderMidi(0.0f, false);
    const auto onsetSustainZero = renderMidi(0.0f, true);
    const auto onsetSustainBoosted = renderMidi(100.0f, true);
    const auto onsetSustainCut = renderMidi(-100.0f, true);

    const double dryEarlyRms = windowRms(noOnset.output, 0, 0, 256);
    const double onsetEarlyRms = windowRms(onsetSustainZero.output, 0, 0, 256);

    CHECK(onsetEarlyRms > dryEarlyRms * 1.08,
          "MIDI mode note-on should make attack shaping audible");
    CHECK(onsetSustainZero.dominantSignedGainDb > 0.5f,
          "MIDI mode note-on should report positive signed gain");

    // attack_speed=8ms @ 44.1kHz -> attack window is ~353 samples. The
    // attack window itself must stay identical regardless of sustain, since
    // the two phases are exclusive (attack owns the window fully).
    const double boostedEarlyRms = windowRms(onsetSustainBoosted.output, 0, 0, 256);
    const double cutEarlyRms = windowRms(onsetSustainCut.output, 0, 0, 256);
    CHECK(std::abs(boostedEarlyRms - onsetEarlyRms) < onsetEarlyRms * 0.02,
          "sustain must not affect the MIDI attack window itself");
    CHECK(std::abs(cutEarlyRms - onsetEarlyRms) < onsetEarlyRms * 0.02,
          "sustain must not affect the MIDI attack window itself");

    // Past the attack window, sustain should duck (or lift) the held note
    // until the next note-on, instead of being a no-op.
    const double zeroTailRms = windowRms(onsetSustainZero.output, 0, 600, 4096);
    const double boostedTailRms = windowRms(onsetSustainBoosted.output, 0, 600, 4096);
    const double cutTailRms = windowRms(onsetSustainCut.output, 0, 600, 4096);

    CHECK(boostedTailRms > zeroTailRms * 1.08,
          "positive sustain should raise the post-attack tail level in MIDI mode");
    CHECK(cutTailRms < zeroTailRms * 0.92,
          "negative sustain should duck the post-attack tail level in MIDI mode");
}

static void testResonanceSuppressorWolaIdentity()
{
    std::cout << "  [resonance suppressor WOLA identity]\n";

    constexpr double kSR = 44100.0;
    constexpr int kTotalSamples = 32768;
    constexpr int kImpulseIndex = 4096;

    const std::vector<std::vector<int>> schedules = {
        {1},
        {37},
        {128},
        {255},
        {511},
        {1024},
        {1, 37, 128, 255, 511, 1024, 37}
    };
    const std::vector<int> mixedSchedule = schedules.back();

    std::array<int, 3> measuredDelay {};
    for (int quality = 0; quality < 3; ++quality)
    {
        measuredDelay[static_cast<std::size_t>(quality)] =
            measureImpulseDelayForQuality(quality, mixedSchedule);

        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", static_cast<float>(quality));
        fx.setParameterValue("depth", 0.0f);
        fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));

        std::cout << "    quality " << quality
                  << " measured impulse delay: "
                  << measuredDelay[static_cast<std::size_t>(quality)]
                  << " samples, reported latency: "
                  << fx.getLatencySamples() << " samples\n";

        CHECK(measuredDelay[static_cast<std::size_t>(quality)] > 0,
              "RS measured impulse delay should be positive");
        CHECK(fx.getLatencySamples() == measuredDelay[static_cast<std::size_t>(quality)],
              "RS reported latency should match measured impulse delay");
    }

    for (const auto& schedule : schedules)
    {
        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", 0.0f);
        fx.prepareToPlay(kSR, maxBlockSizeOf(schedule));

        juce::AudioBuffer<float> silence(2, kTotalSamples);
        silence.clear();
        auto out = renderEffectInBlocks(fx, silence, schedule);

        CHECK(maxAbsBuffer(out) < 1.0e-7f,
              "RS silence should remain silent for awkward block schedules");
        CHECK_NEAR(fx.readMeterValue(0), 0.0f, 1.0e-7f,
                   "RS silence meter L should be zero");
        CHECK_NEAR(fx.readMeterValue(1), 0.0f, 1.0e-7f,
                   "RS silence meter R should be zero");
        CHECK_NEAR(fx.readMeterValue(2), 0.0f, 1.0e-7f,
                   "RS gain-reduction meter should stay zero for silence");
    }

    {
        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", 0.0f);
        fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));

        juce::AudioBuffer<float> input(2, kTotalSamples);
        input.clear();
        input.setSample(0, kImpulseIndex, 1.0f);
        input.setSample(1, kImpulseIndex, -0.75f);

        auto output = renderEffectInBlocks(fx, input, mixedSchedule);
        const int delay = measuredDelay[1];
        const ErrorStats impulseError =
            computeAlignedError(input, output, delay, kImpulseIndex - 8, kImpulseIndex + 9, 2);

        std::cout << "    impulse aligned max error: " << impulseError.maxAbs
                  << ", RMS error: " << impulseError.rms << "\n";

        CHECK(impulseError.maxAbs < 2.0e-4,
              "RS impulse aligned max error should be near null");
        CHECK(impulseError.rms < 5.0e-5,
              "RS impulse aligned RMS error should be near null");
    }

    {
        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", 0.0f);
        fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));

        juce::AudioBuffer<float> input(2, kTotalSamples);
        const float pi2 = 2.0f * juce::MathConstants<float>::pi;
        for (int s = 0; s < kTotalSamples; ++s)
        {
            const float t = static_cast<float>(s) / static_cast<float>(kSR);
            input.setSample(0, s, 0.42f * std::sin(pi2 * 997.0f * t));
            input.setSample(1, s, 0.27f * std::sin(pi2 * 1731.0f * t + 0.31f));
        }

        auto output = renderEffectInBlocks(fx, input, mixedSchedule);
        const int delay = measuredDelay[1];
        const int start = 4096;
        const int end = kTotalSamples - 4096;
        const ErrorStats sineError = computeAlignedError(input, output, delay, start, end, 2);
        const double gainErrL = computeAlignedRmsGainError(input, output, delay, start, end, 0);
        const double gainErrR = computeAlignedRmsGainError(input, output, delay, start, end, 1);

        std::cout << "    sine aligned max error: " << sineError.maxAbs
                  << ", RMS error: " << sineError.rms
                  << ", RMS gain error L/R: " << gainErrL
                  << " / " << gainErrR << "\n";

        CHECK(sineError.maxAbs < 2.0e-4,
              "RS sine aligned max error should be near null");
        CHECK(sineError.rms < 5.0e-5,
              "RS sine aligned RMS error should be near null");
        CHECK(gainErrL < 1.0e-4 && gainErrR < 1.0e-4,
              "RS sine RMS gain error should be very small after delay compensation");
    }

    {
        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", 0.0f);
        fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));

        juce::AudioBuffer<float> input(3, kTotalSamples);
        const float pi2 = 2.0f * juce::MathConstants<float>::pi;
        for (int s = 0; s < kTotalSamples; ++s)
        {
            const float t = static_cast<float>(s) / static_cast<float>(kSR);
            input.setSample(0, s, 0.36f * std::sin(pi2 * 331.0f * t));
            input.setSample(1, s, 0.25f * std::sin(pi2 * 883.0f * t + 1.7f));
            input.setSample(2, s, (s % 97) < 48 ? 0.125f : -0.125f);
        }

        auto output = renderEffectInBlocks(fx, input, mixedSchedule);
        const int delay = measuredDelay[1];
        const ErrorStats stereoError =
            computeAlignedError(input, output, delay, 4096, kTotalSamples - 4096, 2);

        float ch2MaxDiff = 0.0f;
        for (int s = 0; s < kTotalSamples; ++s)
            ch2MaxDiff = std::max(ch2MaxDiff,
                std::abs(output.getSample(2, s) - input.getSample(2, s)));

        std::cout << "    stereo non-identical RMS error: " << stereoError.rms
                  << ", channel 2 passthrough max diff: " << ch2MaxDiff << "\n";

        CHECK(stereoError.maxAbs < 2.0e-4 && stereoError.rms < 5.0e-5,
              "RS stereo non-identical signal should reconstruct after delay compensation");
        CHECK(ch2MaxDiff < 1.0e-7f,
              "RS channels above stereo should pass through unchanged");
    }

    {
        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 0.0f);
        fx.setParameterValue("depth", 0.0f);
        fx.prepareToPlay(kSR, 512);
        const int preparedLatency = fx.getLatencySamples();
        CHECK(fx.setParameterValue("quality", 2.0f),
              "RS runtime quality change should be accepted");
        CHECK(fx.getLatencySamples() != preparedLatency,
              "RS runtime quality change should refresh reported latency immediately");
        CHECK(fx.getLatencySamples() == 2048,
              "RS High Quality quality=2 should report 2048 samples after runtime change");

        juce::AudioBuffer<float> buf(2, 512);
        fillBuffer(buf, 0.0f);
        juce::MidiBuffer midi;
        fx.processBlock(buf, midi);

        CHECK(fx.getLatencySamples() == 2048,
              "RS runtime quality change should keep the refreshed latency through processEffect");
    }
}

static void testResonanceSuppressorLowLatencyMode()
{
    std::cout << "  [resonance suppressor low-latency mode]\n";

    constexpr double kSR = 44100.0;
    constexpr int kTotalSamples = 65536;
    constexpr int kImpulseIndex = 4096;
    const std::vector<int> mixedSchedule = {1, 37, 128, 255, 511, 1024, 37};
    const int start = 8192;
    const int end = kTotalSamples - 4096;
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;

    juce::AudioBuffer<float> impulse(2, kTotalSamples);
    impulse.clear();
    impulse.setSample(0, kImpulseIndex, 1.0f);
    impulse.setSample(1, kImpulseIndex, -0.75f);

    juce::AudioBuffer<float> resonance(2, kTotalSamples);
    for (int s = 0; s < kTotalSamples; ++s)
    {
        const float t = static_cast<float>(s) / static_cast<float>(kSR);
        const float v = 0.12f * std::sin(pi2 * 997.0f * t)
                      + 0.10f * std::sin(pi2 * 1009.0f * t)
                      + 0.02f * std::sin(pi2 * 311.0f * t);
        resonance.setSample(0, s, v);
        resonance.setSample(1, s, 0.85f * v);
    }

    auto renderLowLatency = [&](const juce::AudioBuffer<float>& input, float depth) {
        XlethResonanceSuppressorEffect fx;
        setResonanceLowLatencyMode(fx);
        fx.setParameterValue("depth", depth);
        fx.setParameterValue("sharpness", 80.0f);
        fx.setParameterValue("selectivity", 35.0f);
        fx.setParameterValue("attack", 5.0f);
        fx.setParameterValue("release", 180.0f);
        fx.setParameterValue("mode", 0.0f);
        fx.setParameterValue("stereo_link", 100.0f);
        fx.setParameterValue("mix", 100.0f);
        fx.setParameterValue("trim", 0.0f);
        fx.setParameterValue("delta", 0.0f);
        fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));

        RenderWithMeterResult result = renderEffectAndMeterInBlocks(fx, input, mixedSchedule);
        CHECK(fx.getLatencySamples() == 0,
              "RS Low Latency mode should report zero latency");
        return std::make_pair(std::move(result), fx.readMeterValue(2));
    };

    {
        auto [impulseResult, impulseMeter] = renderLowLatency(impulse, 100.0f);
        const float preImpulseMax = maxAbsInRange(impulseResult.output, 0, kImpulseIndex);
        const int firstStrongSample =
            findFirstSampleAbove(impulseResult.output, 0, 0.05f, kImpulseIndex - 2);

        std::cout << "    LL impulse first sample / pre-max / meter: "
                  << firstStrongSample << " / " << preImpulseMax
                  << " / " << impulseMeter << "\n";

        CHECK(allSamplesFinite(impulseResult.output),
              "RS Low Latency impulse output should stay finite");
        CHECK(preImpulseMax < 1.0e-6f,
              "RS Low Latency impulse should not appear before the input sample");
        CHECK(firstStrongSample == kImpulseIndex,
              "RS Low Latency impulse should begin on the original sample index");
    }

    {
        auto [depth0, depth0Meter] = renderLowLatency(resonance, 0.0f);
        auto [depth100, depth100Meter] = renderLowLatency(resonance, 100.0f);

        const double depth0Db =
            computeAlignedToneReductionDb(resonance, depth0.output, 0, start, end, 0, kSR, 997.0);
        const double depth100Db =
            computeAlignedToneReductionDb(resonance, depth100.output, 0, start, end, 0, kSR, 997.0);

        std::cout << "    LL tone reduction depth0/depth100 and meter: "
                  << depth0Db << " / " << depth100Db
                  << " ; " << depth0Meter << " / " << depth100Meter << "\n";

        CHECK(allSamplesFinite(depth0.output) && allSamplesFinite(depth100.output),
              "RS Low Latency tonal renders should stay finite");
        CHECK(std::abs(depth0Db) < 0.1,
              "RS Low Latency depth 0 should stay near identity");
        CHECK(depth100Db > depth0Db + 0.5,
              "RS Low Latency depth 100 should audibly suppress the resonant tone");
        CHECK(depth100Meter > depth0Meter + 0.02f,
              "RS Low Latency meter should rise when suppression engages");
        CHECK(maxAbsBuffer(depth100.output) < 4.0f,
              "RS Low Latency extreme suppression should stay bounded");
    }
}

static void testResonanceSuppressorLatencySafeBypass()
{
    std::cout << "  [resonance suppressor dry/bypass latency]\n";

    constexpr double kSR = 44100.0;
    constexpr int kTotalSamples = 65536;
    const std::vector<int> mixedSchedule = {1, 37, 128, 255, 511, 1024, 37};
    const std::array<int, 3> expectedLatency {512, 1024, 2048};

    juce::AudioBuffer<float> input(2, kTotalSamples);
    fillResonanceRegressionSignal(input, kSR);

    {
        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", 100.0f);
        fx.setParameterValue("sharpness", 80.0f);
        fx.setParameterValue("selectivity", 40.0f);
        fx.setParameterValue("mix", 0.0f);
        fx.setParameterValue("trim", 12.0f);
        fx.setParameterValue("delta", 0.0f);
        fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));

        CHECK(fx.getLatencySamples() == 0,
              "RS mix 0 with delta off should report zero latency in High Quality mode");

        juce::AudioBuffer<float> impulse(2, kTotalSamples);
        impulse.clear();
        constexpr int kImpulseIndex = 4096;
        impulse.setSample(0, kImpulseIndex, 1.0f);
        impulse.setSample(1, kImpulseIndex, -0.75f);

        auto impulseOut = renderEffectInBlocks(fx, impulse, mixedSchedule);
        const ErrorStats impulseError =
            computeAlignedError(impulse, impulseOut, 0, kImpulseIndex - 8, kImpulseIndex + 16, 2);
        const int impulsePeakIndex = findFirstSampleAbove(impulseOut, 0, 0.5f, kImpulseIndex - 4);

        auto audioOut = renderEffectInBlocks(fx, input, mixedSchedule);
        const ErrorStats audioError =
            computeAlignedError(input, audioOut, 0, 0, kTotalSamples - 1, 2);

        std::cout << "    HQ mix 0 impulse/audio max error: "
                  << impulseError.maxAbs << " / " << audioError.maxAbs
                  << ", impulse peak index: " << impulsePeakIndex << "\n";

        CHECK(impulseError.maxAbs < 1.0e-6f && impulseError.rms < 1.0e-7f,
              "RS mix 0 impulse should stay sample-aligned with live dry");
        CHECK(audioError.maxAbs < 1.0e-6f && audioError.rms < 1.0e-7f,
              "RS mix 0 should output true live dry even in High Quality mode");
        CHECK(impulsePeakIndex == kImpulseIndex,
              "RS mix 0 impulse peak should stay at the original sample index");
        CHECK_NEAR(fx.readMeterValue(2), 0.0f, 1.0e-6f,
                   "RS mix 0 should not keep gain-reduction metering active");
    }

    for (int quality = 0; quality < 3; ++quality)
    {
        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", static_cast<float>(quality));
        fx.setParameterValue("depth", 100.0f);
        fx.setParameterValue("sharpness", 80.0f);
        fx.setParameterValue("selectivity", 40.0f);
        fx.setParameterValue("mix", 100.0f);
        fx.setParameterValue("trim", 12.0f);
        fx.setParameterValue("delta", 1.0f);
        fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));

        const int latency = fx.getLatencySamples();
        CHECK(latency == expectedLatency[static_cast<std::size_t>(quality)],
              "RS bypass test should see expected quality latency");
        CHECK_NEAR(fx.getTailLengthSeconds() * kSR,
                   static_cast<double>(latency),
                   0.5,
                   "RS tail length should report exactly one WOLA latency");

        fx.setBypassed(true);
        fx.reset();
        CHECK(fx.getLatencySamples() == 0,
              "RS bypass should report zero latency");
        auto output = renderEffectInBlocks(fx, input, mixedSchedule);
        const ErrorStats bypassError =
            computeAlignedError(input, output, 0, 0, kTotalSamples - 1, 2);

        std::cout << "    quality " << quality
                  << " bypass dry max/RMS error: "
                  << bypassError.maxAbs << " / " << bypassError.rms
                  << ", meter L/R: " << fx.readMeterValue(0)
                  << " / " << fx.readMeterValue(1) << "\n";

        CHECK(bypassError.maxAbs < 1.0e-6 && bypassError.rms < 1.0e-7,
              "RS fully bypassed output should equal true live dry");
        CHECK_NEAR(fx.readMeterValue(2), 0.0f, 1.0e-6f,
                   "RS fully bypassed gain-reduction meter should stay idle");
    }

    {
        EffectChainManager chain;
        chain.init(kSR, 1024);
        const int nodeId = chain.addEffect("resonancesuppressor", 0);
        CHECK(nodeId >= 0, "RS should be addable to an EffectChainManager");
        CHECK_NEAR(chain.getMaxTailLengthSeconds() * kSR, 0.0, 0.5,
                   "RS chain tail should report zero latency for a new Low Latency instance");
        CHECK(chain.setEffectParameter(nodeId, "processing_mode", 1.0f),
              "RS chain processing_mode should be settable");
        CHECK_NEAR(chain.getMaxTailLengthSeconds() * kSR, 1024.0, 0.5,
                   "RS chain tail should refresh immediately when switching to High Quality mode");
        CHECK(chain.setEffectParameter(nodeId, "mix", 0.0f),
              "RS chain mix should be settable");
        CHECK_NEAR(chain.getMaxTailLengthSeconds() * kSR, 0.0, 0.5,
                   "RS chain tail should return to zero when mix is 0");
        CHECK(chain.setEffectParameter(nodeId, "mix", 100.0f),
              "RS chain mix should return to wet");
        CHECK_NEAR(chain.getMaxTailLengthSeconds() * kSR, 1024.0, 0.5,
                   "RS chain tail should restore when High Quality wet processing is active");
        CHECK(chain.setBypass(nodeId, true),
              "RS chain bypass should be settable");
        CHECK_NEAR(chain.getMaxTailLengthSeconds() * kSR, 0.0, 0.5,
                   "RS chain tail should return to zero while bypassed");
        CHECK(chain.setBypass(nodeId, false),
              "RS chain bypass should be clearable");
        CHECK_NEAR(chain.getMaxTailLengthSeconds() * kSR, 1024.0, 0.5,
                   "RS chain tail should restore after bypass is lifted");
        CHECK(chain.setEffectParameter(nodeId, "quality", 2.0f),
              "RS chain quality param should be settable");
        chain.reprepare(kSR, 1024);
        CHECK_NEAR(chain.getMaxTailLengthSeconds() * kSR, 2048.0, 0.5,
                   "RS chain tail should update after High-quality reprepare");
        chain.destroy();
    }

    {
        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", 100.0f);
        fx.setParameterValue("sharpness", 70.0f);
        fx.setParameterValue("selectivity", 35.0f);
        fx.setParameterValue("mix", 100.0f);
        fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));

        juce::AudioBuffer<float> output(2, kTotalSamples);
        output.clear();
        juce::MidiBuffer midi;

        const int toggleOn = 16384;
        const int toggleOff = 36096;
        bool bypassOnSet = false;
        bool bypassOffSet = false;
        int pos = 0;
        int blockIndex = 0;
        while (pos < kTotalSamples)
        {
            if (!bypassOnSet && pos >= toggleOn)
            {
                fx.setBypassed(true);
                bypassOnSet = true;
            }
            if (!bypassOffSet && pos >= toggleOff)
            {
                fx.setBypassed(false);
                bypassOffSet = true;
            }

            const int n = std::min(mixedSchedule[static_cast<std::size_t>(blockIndex % mixedSchedule.size())],
                                   kTotalSamples - pos);
            juce::AudioBuffer<float> block(2, n);
            for (int ch = 0; ch < 2; ++ch)
                block.copyFrom(ch, 0, input, ch, pos, n);

            fx.processBlock(block, midi);

            for (int ch = 0; ch < 2; ++ch)
                output.copyFrom(ch, pos, block, ch, 0, n);

            pos += n;
            ++blockIndex;
        }

        const float stepOn = maxAdjacentStepInRange(output, toggleOn - 512, toggleOn + 4096);
        const float stepOff = maxAdjacentStepInRange(output, toggleOff - 512, toggleOff + 4096);

        std::cout << "    bypass toggle max adjacent step on/off: "
                  << stepOn << " / " << stepOff << "\n";

        CHECK(allSamplesFinite(output),
              "RS bypass toggle output should remain finite");
        CHECK(stepOn < 0.65f && stepOff < 0.65f,
              "RS bypass toggles on steady audio should not create huge discontinuity spikes");
    }

    {
        constexpr int blockSize = 128;
        constexpr int total = 8192;
        constexpr int toggleAt = 4096;
        constexpr int impulseIndex = toggleAt + 1024;

        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", 0.0f);
        fx.setParameterValue("mix", 100.0f);
        fx.prepareToPlay(kSR, blockSize);

        juce::AudioBuffer<float> impulse(2, total);
        impulse.clear();
        impulse.setSample(0, impulseIndex, 1.0f);
        impulse.setSample(1, impulseIndex, -0.75f);

        juce::AudioBuffer<float> output(2, total);
        output.clear();
        juce::MidiBuffer midi;
        bool bypassSet = false;
        for (int pos = 0; pos < total; pos += blockSize)
        {
            if (!bypassSet && pos >= toggleAt)
            {
                fx.setBypassed(true);
                bypassSet = true;
            }

            const int n = std::min(blockSize, total - pos);
            juce::AudioBuffer<float> block(2, n);
            for (int ch = 0; ch < 2; ++ch)
                block.copyFrom(ch, 0, impulse, ch, pos, n);
            fx.processBlock(block, midi);
            for (int ch = 0; ch < 2; ++ch)
                output.copyFrom(ch, pos, block, ch, 0, n);
        }

        int largePeakCount = 0;
        int peakIndex = -1;
        float peak = 0.0f;
        float earlyMax = 0.0f;
        float delayedEchoMax = 0.0f;
        for (int s = 0; s < total; ++s)
        {
            const float v = std::abs(output.getSample(0, s));
            if (v > 0.2f)
                ++largePeakCount;
            if (v > peak)
            {
                peak = v;
                peakIndex = s;
            }
            if (s < impulseIndex - 8)
                earlyMax = std::max(earlyMax, v);
            if (s > impulseIndex + 256)
                delayedEchoMax = std::max(delayedEchoMax, v);
        }

        std::cout << "    bypass-ramp impulse peak count/index/earlyMax/delayedEcho: "
                  << largePeakCount << " / " << peakIndex
                  << " / " << earlyMax << " / " << delayedEchoMax << "\n";

        CHECK(largePeakCount == 1,
              "RS bypass ramp should not emit a delayed duplicate impulse");
        CHECK(std::abs(peakIndex - impulseIndex) <= 1 && peak > 0.8f,
              "RS bypass-ramp impulse should land at the live dry sample once bypass settles");
        CHECK(earlyMax < 0.05f,
              "RS bypass-ramp impulse should stay quiet before the live impulse");
        CHECK(delayedEchoMax < 0.05f,
              "RS bypass-ramp impulse should not leave a stale delayed echo after bypass");
    }

    {
        constexpr int burstEnd = 4096;
        juce::AudioBuffer<float> burst(2, 32768);
        burst.clear();
        const float pi2 = 2.0f * juce::MathConstants<float>::pi;
        for (int s = 0; s < burstEnd; ++s)
        {
            const float t = static_cast<float>(s) / static_cast<float>(kSR);
            const float v = 0.25f * std::sin(pi2 * 997.0f * t);
            burst.setSample(0, s, v);
            burst.setSample(1, s, -0.8f * v);
        }

        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", 0.0f);
        fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));
        const int latency = fx.getLatencySamples();
        auto output = renderEffectInBlocks(fx, burst, mixedSchedule);

        float staleTailMax = 0.0f;
        for (int ch = 0; ch < 2; ++ch)
            for (int s = burstEnd + latency + 2048; s < output.getNumSamples(); ++s)
                staleTailMax = std::max(staleTailMax, std::abs(output.getSample(ch, s)));

        std::cout << "    stale tail max after burst+latency: "
                  << staleTailMax << "\n";

        CHECK(staleTailMax < 1.0e-5f,
              "RS should drain delayed WOLA/dry output and then stay silent");
    }

    {
        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", 0.0f);
        fx.prepareToPlay(kSR, 1024);
        const int latency = fx.getLatencySamples();

        juce::MidiBuffer midi;
        juce::AudioBuffer<float> loud(2, 1024);
        fillResonanceRegressionSignal(loud, kSR);
        fx.processBlock(loud, midi);

        fx.reset();
        juce::AudioBuffer<float> silence(2, latency * 3);
        silence.clear();
        auto silenceOut = renderEffectInBlocks(fx, silence, {37, 128, 511});
        CHECK(maxAbsBuffer(silenceOut) < 1.0e-7f,
              "RS reset should clear stale WOLA and dry-delay output");

        fx.reset();
        juce::AudioBuffer<float> impulse(2, latency * 3);
        impulse.clear();
        impulse.setSample(0, 0, 1.0f);
        impulse.setSample(1, 0, -1.0f);
        auto impulseOut = renderEffectInBlocks(fx, impulse, {1, 37, 128, 255, 511, 1024});

        float preLatencyMax = 0.0f;
        float peak = 0.0f;
        int peakIndex = -1;
        for (int s = 0; s < impulseOut.getNumSamples(); ++s)
        {
            const float v = std::abs(impulseOut.getSample(0, s));
            if (s < latency)
                preLatencyMax = std::max(preLatencyMax, v);
            if (v > peak)
            {
                peak = v;
                peakIndex = s;
            }
        }

        CHECK(preLatencyMax < 1.0e-7f,
              "RS reset should prevent stale pre-latency output at clip start");
        CHECK(std::abs(peakIndex - latency) <= 1 && peak > 0.8f,
              "RS reset clip-start impulse should appear once at the declared latency");
    }
}

static void testResonanceSuppressorTransitionSafety()
{
    std::cout << "  [resonance suppressor transition safety]\n";

    constexpr double kSR = 44100.0;
    constexpr int kTotalSamples = 65536;
    const std::vector<int> mixedSchedule = {1, 37, 128, 255, 511, 1024, 37};

    juce::AudioBuffer<float> input(2, kTotalSamples);
    fillResonanceRegressionSignal(input, kSR);

    XlethResonanceSuppressorEffect fx;
    setResonanceLowLatencyMode(fx);
    fx.setParameterValue("quality", 1.0f);
    fx.setParameterValue("depth", 100.0f);
    fx.setParameterValue("sharpness", 70.0f);
    fx.setParameterValue("selectivity", 35.0f);
    fx.setParameterValue("attack", 10.0f);
    fx.setParameterValue("release", 200.0f);
    fx.setParameterValue("mix", 0.0f);
    fx.setParameterValue("trim", 0.0f);
    fx.setParameterValue("delta", 0.0f);
    fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));

    juce::AudioBuffer<float> output(2, kTotalSamples);
    output.clear();
    juce::MidiBuffer midi;

    constexpr int kMixOn = 8192;
    constexpr int kModeToHQ = 16384;
    constexpr int kBypassOn = 28672;
    constexpr int kBypassOff = 36864;
    constexpr int kModeToLL = 45056;
    constexpr int kMixOff = 53248;

    bool mixOnSet = false;
    bool modeToHQSet = false;
    bool bypassOnSet = false;
    bool bypassOffSet = false;
    bool modeToLLSet = false;
    bool mixOffSet = false;

    int pos = 0;
    int blockIndex = 0;
    while (pos < kTotalSamples)
    {
        if (!mixOnSet && pos >= kMixOn)
        {
            fx.setParameterValue("mix", 100.0f);
            mixOnSet = true;
        }
        if (!modeToHQSet && pos >= kModeToHQ)
        {
            fx.setParameterValue("processing_mode", 1.0f);
            modeToHQSet = true;
        }
        if (!bypassOnSet && pos >= kBypassOn)
        {
            fx.setBypassed(true);
            bypassOnSet = true;
        }
        if (!bypassOffSet && pos >= kBypassOff)
        {
            fx.setBypassed(false);
            bypassOffSet = true;
        }
        if (!modeToLLSet && pos >= kModeToLL)
        {
            fx.setParameterValue("processing_mode", 0.0f);
            modeToLLSet = true;
        }
        if (!mixOffSet && pos >= kMixOff)
        {
            fx.setParameterValue("mix", 0.0f);
            mixOffSet = true;
        }

        const int requested = mixedSchedule[static_cast<std::size_t>(blockIndex % mixedSchedule.size())];
        const int n = std::min(requested, kTotalSamples - pos);

        juce::AudioBuffer<float> block(2, n);
        for (int ch = 0; ch < 2; ++ch)
            block.copyFrom(ch, 0, input, ch, pos, n);

        fx.processBlock(block, midi);

        for (int ch = 0; ch < 2; ++ch)
            output.copyFrom(ch, pos, block, ch, 0, n);

        pos += n;
        ++blockIndex;
    }

    const float stepMixOn = maxAdjacentStepInRange(output, kMixOn - 512, kMixOn + 4096);
    const float stepModeToHQ = maxAdjacentStepInRange(output, kModeToHQ - 512, kModeToHQ + 4096);
    const float stepBypassOn = maxAdjacentStepInRange(output, kBypassOn - 512, kBypassOn + 4096);
    const float stepBypassOff = maxAdjacentStepInRange(output, kBypassOff - 512, kBypassOff + 4096);
    const float stepModeToLL = maxAdjacentStepInRange(output, kModeToLL - 512, kModeToLL + 4096);
    const float stepMixOff = maxAdjacentStepInRange(output, kMixOff - 512, kMixOff + 4096);
    const ErrorStats finalDryError =
        computeAlignedError(input, output, 0, kMixOff + 2048, kTotalSamples - 1, 2);

    std::cout << "    transition max steps mixOn/HQ/on/off/LL/mixOff: "
              << stepMixOn << " / " << stepModeToHQ << " / "
              << stepBypassOn << " / " << stepBypassOff << " / "
              << stepModeToLL << " / " << stepMixOff << "\n";
    std::cout << "    final dry max/RMS error: "
              << finalDryError.maxAbs << " / " << finalDryError.rms << "\n";

    CHECK(allSamplesFinite(output),
          "RS mix/mode/bypass transitions should stay finite");
    CHECK(stepMixOn < 0.85f && stepModeToHQ < 0.85f
          && stepBypassOn < 0.85f && stepBypassOff < 0.85f
          && stepModeToLL < 0.85f && stepMixOff < 0.85f,
          "RS mix/mode/bypass transitions should not create explosive discontinuities");
    CHECK(fx.getLatencySamples() == 0,
          "RS final Low Latency dry state should report zero latency");
    CHECK(finalDryError.maxAbs < 1.0e-5f && finalDryError.rms < 1.0e-6f,
          "RS should return cleanly to live dry after wet/mode/bypass transitions");
}

static void testResonanceSuppressorDetector()
{
    std::cout << "  [resonance suppressor detector]\n";

    constexpr double kSR = 44100.0;
    constexpr int kTotalSamples = 32768;
    const std::vector<int> mixedSchedule = {1, 37, 128, 255, 511, 1024, 37};

    auto prepareDetectorFx = [&mixedSchedule](XlethResonanceSuppressorEffect& fx) {
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", 100.0f);
        fx.setParameterValue("sharpness", 70.0f);
        fx.setParameterValue("selectivity", 35.0f);
        fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));
    };

    juce::AudioBuffer<float> silence(2, kTotalSamples);
    silence.clear();

    juce::AudioBuffer<float> sine(2, kTotalSamples);
    juce::AudioBuffer<float> resonance(2, kTotalSamples);
    juce::AudioBuffer<float> noise(2, kTotalSamples);
    juce::AudioBuffer<float> pinkish(2, kTotalSamples);
    juce::AudioBuffer<float> denseHarmonic(2, kTotalSamples);

    const float pi2 = 2.0f * juce::MathConstants<float>::pi;
    unsigned int lcg = 0x12345678u;
    auto nextNoise = [&lcg]() {
        lcg = lcg * 1664525u + 1013904223u;
        return static_cast<float>((lcg >> 8) & 0x00ffffffu) / 8388608.0f - 1.0f;
    };
    float pinkL = 0.0f;
    float pinkR = 0.0f;

    for (int s = 0; s < kTotalSamples; ++s)
    {
        const float t = static_cast<float>(s) / static_cast<float>(kSR);
        const float sineSample = 0.18f * std::sin(pi2 * 997.0f * t);
        sine.setSample(0, s, sineSample);
        sine.setSample(1, s, sineSample);

        const float resonantSample =
            0.10f * std::sin(pi2 * 997.0f * t)
          + 0.10f * std::sin(pi2 * 1009.0f * t)
          + 0.02f * std::sin(pi2 * 311.0f * t);
        resonance.setSample(0, s, resonantSample);
        resonance.setSample(1, s, 0.75f * resonantSample);

        const float white0 = 0.105f * nextNoise();
        const float white1 = 0.105f * nextNoise();
        noise.setSample(0, s, white0);
        noise.setSample(1, s, white1);

        pinkL = 0.985f * pinkL + 0.015f * white0;
        pinkR = 0.985f * pinkR + 0.015f * white1;
        pinkish.setSample(0, s, pinkL * 6.0f);
        pinkish.setSample(1, s, pinkR * 6.0f);

        float dense = 0.0f;
        for (int h = 1; h <= 12; ++h)
            dense += (0.16f / static_cast<float>(h)) * std::sin(pi2 * 155.0f * static_cast<float>(h) * t);
        denseHarmonic.setSample(0, s, dense);
        denseHarmonic.setSample(1, s, 0.8f * dense);
    }

    XlethResonanceSuppressorEffect fxSilence;
    prepareDetectorFx(fxSilence);
    const float silenceActivity =
        renderEffectDetectorActivityInBlocks(fxSilence, silence, mixedSchedule);

    XlethResonanceSuppressorEffect fxSine;
    prepareDetectorFx(fxSine);
    const float sineActivity =
        renderEffectDetectorActivityInBlocks(fxSine, sine, mixedSchedule);

    XlethResonanceSuppressorEffect fxResonance;
    prepareDetectorFx(fxResonance);
    const float resonanceActivity =
        renderEffectDetectorActivityInBlocks(fxResonance, resonance, mixedSchedule);

    XlethResonanceSuppressorEffect fxNoise;
    prepareDetectorFx(fxNoise);
    const float noiseActivity =
        renderEffectDetectorActivityInBlocks(fxNoise, noise, mixedSchedule);

    XlethResonanceSuppressorEffect fxPinkish;
    prepareDetectorFx(fxPinkish);
    const float pinkishActivity =
        renderEffectDetectorActivityInBlocks(fxPinkish, pinkish, mixedSchedule);

    XlethResonanceSuppressorEffect fxDense;
    prepareDetectorFx(fxDense);
    const float denseActivity =
        renderEffectDetectorActivityInBlocks(fxDense, denseHarmonic, mixedSchedule);

    std::cout << "    detector activity silence/sine/resonance/noise/pinkish/dense: "
              << silenceActivity << " / " << sineActivity << " / "
              << resonanceActivity << " / " << noiseActivity << " / "
              << pinkishActivity << " / " << denseActivity << "\n";

    CHECK(std::isfinite(silenceActivity) && std::isfinite(sineActivity)
          && std::isfinite(resonanceActivity) && std::isfinite(noiseActivity)
          && std::isfinite(pinkishActivity) && std::isfinite(denseActivity),
          "RS detector activity values should be finite");
    CHECK(silenceActivity >= 0.0f && silenceActivity <= 1.0f
          && sineActivity >= 0.0f && sineActivity <= 1.0f
          && resonanceActivity >= 0.0f && resonanceActivity <= 1.0f
          && noiseActivity >= 0.0f && noiseActivity <= 1.0f
          && pinkishActivity >= 0.0f && pinkishActivity <= 1.0f
          && denseActivity >= 0.0f && denseActivity <= 1.0f,
          "RS detector activity values should stay in [0,1]");
    CHECK(silenceActivity < 0.001f,
          "RS detector silence activity should be near zero");
    CHECK(sineActivity > silenceActivity + 0.05f,
          "RS detector sine activity should exceed silence");
    CHECK(sineActivity > noiseActivity * 2.0f,
          "RS detector sine activity should exceed broadband noise by at least 2x");
    CHECK(resonanceActivity > noiseActivity * 2.0f,
          "RS detector narrow resonance should exceed broadband noise by at least 2x");
    CHECK(resonanceActivity > noiseActivity + 0.20f,
          "RS gain-reduction activity for narrow resonance should exceed broadband noise by a meaningful margin");
    CHECK(noiseActivity < 0.40f && pinkishActivity < 0.40f,
          "RS detector broadband noise activity should not run away");
    CHECK(denseActivity < std::max(sineActivity, resonanceActivity),
          "RS detector dense harmonic activity should be moderated by sparse-density scoring");

    {
        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", 25.0f);
        fx.setParameterValue("sharpness", 70.0f);
        fx.setParameterValue("selectivity", 35.0f);
        fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));

        const float lowDepthActivity =
            renderEffectDetectorActivityInBlocks(fx, resonance, mixedSchedule);

        std::cout << "    detector low-depth resonance activity: "
                  << lowDepthActivity << "\n";
        CHECK(lowDepthActivity < resonanceActivity,
              "RS gain-reduction meter should scale downward at low depth");
    }
}

// ─── EQ Tests ───────────────────────────────────────────────────────────────

static void testResonanceSuppressorSuppression()
{
    std::cout << "  [resonance suppressor suppression]\n";

    constexpr double kSR = 44100.0;
    constexpr int kTotalSamples = 65536;
    const std::vector<int> mixedSchedule = {1, 37, 128, 255, 511, 1024, 37};
    const int delay = measureImpulseDelayForQuality(1, mixedSchedule);
    const int start = 8192;
    const int end = kTotalSamples - 4096;

    juce::AudioBuffer<float> resonance(2, kTotalSamples);
    juce::AudioBuffer<float> noise(2, kTotalSamples);
    juce::AudioBuffer<float> linkedStereo(2, kTotalSamples);
    juce::AudioBuffer<float> independentStereo(2, kTotalSamples);

    const float pi2 = 2.0f * juce::MathConstants<float>::pi;
    unsigned int lcg = 0x2468ace0u;
    auto nextNoise = [&lcg]() {
        lcg = lcg * 1664525u + 1013904223u;
        return static_cast<float>((lcg >> 8) & 0x00ffffffu) / 8388608.0f - 1.0f;
    };

    for (int s = 0; s < kTotalSamples; ++s)
    {
        const float t = static_cast<float>(s) / static_cast<float>(kSR);
        const float resonantSample =
            0.12f * std::sin(pi2 * 997.0f * t)
          + 0.10f * std::sin(pi2 * 1009.0f * t)
          + 0.02f * std::sin(pi2 * 311.0f * t);
        resonance.setSample(0, s, resonantSample);
        resonance.setSample(1, s, 0.85f * resonantSample);

        noise.setSample(0, s, 0.105f * nextNoise());
        noise.setSample(1, s, 0.105f * nextNoise());

        linkedStereo.setSample(0, s, 0.18f * std::sin(pi2 * 997.0f * t));
        linkedStereo.setSample(1, s, 0.18f * std::sin(pi2 * 1731.0f * t + 0.37f));

        independentStereo.setSample(0, s, 0.18f * std::sin(pi2 * 997.0f * t));
        independentStereo.setSample(1, s, 0.105f * nextNoise());
    }

    auto renderConfigured = [&mixedSchedule](const juce::AudioBuffer<float>& input,
                                             float depth,
                                             int mode,
                                             float stereoLink,
                                             float attackMs = 15.0f,
                                             float releaseMs = 200.0f) {
        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", depth);
        fx.setParameterValue("sharpness", 70.0f);
        fx.setParameterValue("selectivity", 35.0f);
        fx.setParameterValue("attack", attackMs);
        fx.setParameterValue("release", releaseMs);
        fx.setParameterValue("mode", static_cast<float>(mode));
        fx.setParameterValue("stereo_link", stereoLink);
        fx.setParameterValue("mix", 100.0f);
        fx.setParameterValue("trim", 0.0f);
        fx.setParameterValue("delta", 0.0f);
        fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));
        return renderEffectAndMeterInBlocks(fx, input, mixedSchedule);
    };

    auto depth0 = renderConfigured(resonance, 0.0f, 0, 100.0f);
    auto depth50 = renderConfigured(resonance, 50.0f, 0, 100.0f);
    auto depth100Soft = renderConfigured(resonance, 100.0f, 0, 100.0f);
    auto depth100Hard = renderConfigured(resonance, 100.0f, 1, 100.0f);
    auto noiseSoft = renderConfigured(noise, 100.0f, 0, 100.0f);

    const double depth0ToneDb =
        computeAlignedToneReductionDb(resonance, depth0.output, delay, start, end, 0, kSR, 997.0);
    const double depth50ToneDb =
        computeAlignedToneReductionDb(resonance, depth50.output, delay, start, end, 0, kSR, 997.0);
    const double softToneDb =
        computeAlignedToneReductionDb(resonance, depth100Soft.output, delay, start, end, 0, kSR, 997.0);
    const double hardToneDb =
        computeAlignedToneReductionDb(resonance, depth100Hard.output, delay, start, end, 0, kSR, 997.0);
    const double noiseRmsDb =
        computeAlignedRmsReductionDb(noise, noiseSoft.output, delay, start, end, 0);

    std::cout << "    tone reduction dB depth0/depth50/soft100/hard100/noiseRMS: "
              << depth0ToneDb << " / " << depth50ToneDb << " / "
              << softToneDb << " / " << hardToneDb << " / "
              << noiseRmsDb << "\n";
    std::cout << "    GR meter depth0/depth50/soft100/hard100/noise: "
              << depth0.peakMeter << " / " << depth50.peakMeter << " / "
              << depth100Soft.peakMeter << " / " << depth100Hard.peakMeter
              << " / " << noiseSoft.peakMeter << "\n";

    CHECK(allSamplesFinite(depth0.output) && allSamplesFinite(depth50.output)
          && allSamplesFinite(depth100Soft.output) && allSamplesFinite(depth100Hard.output)
          && allSamplesFinite(noiseSoft.output),
          "RS suppression outputs should stay finite");
    CHECK(std::abs(depth0ToneDb) < 0.05 && depth0.peakMeter < 0.001f,
          "RS depth 0 should remain effectively identity with no GR meter activity");
    CHECK(depth50ToneDb > depth0ToneDb + 0.25,
          "RS depth 50 should measurably reduce the resonant tone");
    CHECK(softToneDb > depth50ToneDb + 0.5,
          "RS depth 100 should suppress more than depth 50");
    CHECK(hardToneDb > softToneDb + 0.5,
          "RS hard mode should suppress more aggressively than soft mode");
    CHECK(softToneDb > noiseRmsDb + 1.0,
          "RS narrow resonance suppression should exceed broadband noise reduction");
    CHECK(depth100Soft.peakMeter > depth0.peakMeter + 0.05f,
          "RS slot 2 should increase when suppression happens");

    auto linked = renderConfigured(linkedStereo, 100.0f, 0, 100.0f);
    const double linkedLDb =
        computeAlignedToneReductionDb(linkedStereo, linked.output, delay, start, end, 0, kSR, 997.0);
    const double linkedRDb =
        computeAlignedToneReductionDb(linkedStereo, linked.output, delay, start, end, 1, kSR, 1731.0);

    auto independent = renderConfigured(independentStereo, 100.0f, 0, 0.0f);
    const double independentLDb =
        computeAlignedToneReductionDb(independentStereo, independent.output, delay, start, end, 0, kSR, 997.0);
    const double independentRDb =
        computeAlignedRmsReductionDb(independentStereo, independent.output, delay, start, end, 1);

    std::cout << "    stereo linked L/R tone reduction dB: "
              << linkedLDb << " / " << linkedRDb << "\n";
    std::cout << "    stereo unlinked L tone / R noise reduction dB: "
              << independentLDb << " / " << independentRDb << "\n";

    CHECK(std::abs(linkedLDb - linkedRDb) < 1.5,
          "RS stereo_link 100 should apply matching L/R tonal reduction");
    CHECK(independentLDb > independentRDb + 1.0,
          "RS stereo_link 0 should allow independent L/R reduction");
}

static void testResonanceSuppressorOutputStage()
{
    std::cout << "  [resonance suppressor output stage]\n";

    constexpr double kSR = 44100.0;
    constexpr int kTotalSamples = 65536;
    const std::vector<int> mixedSchedule = {1, 37, 128, 255, 511, 1024, 37};
    const int delay = measureImpulseDelayForQuality(1, mixedSchedule);
    const int start = 8192;
    const int end = kTotalSamples - 4096;

    juce::AudioBuffer<float> resonance(2, kTotalSamples);
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;
    for (int s = 0; s < kTotalSamples; ++s)
    {
        const float t = static_cast<float>(s) / static_cast<float>(kSR);
        const float v = 0.12f * std::sin(pi2 * 997.0f * t)
                      + 0.10f * std::sin(pi2 * 1009.0f * t)
                      + 0.02f * std::sin(pi2 * 311.0f * t);
        resonance.setSample(0, s, v);
        resonance.setSample(1, s, 0.85f * v);
    }

    auto renderOutput = [&mixedSchedule](const juce::AudioBuffer<float>& input,
                                         float depth,
                                         float mix,
                                         float trim,
                                         bool delta) {
        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", depth);
        fx.setParameterValue("sharpness", 70.0f);
        fx.setParameterValue("selectivity", 35.0f);
        fx.setParameterValue("attack", 15.0f);
        fx.setParameterValue("release", 200.0f);
        fx.setParameterValue("mode", 0.0f);
        fx.setParameterValue("stereo_link", 100.0f);
        fx.setParameterValue("mix", mix);
        fx.setParameterValue("trim", trim);
        fx.setParameterValue("delta", delta ? 1.0f : 0.0f);
        fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));
        return renderEffectAndMeterInBlocks(fx, input, mixedSchedule);
    };

    auto identityWet = renderOutput(resonance, 0.0f, 100.0f, 0.0f, false);
    const ErrorStats identityWetError =
        computeAlignedError(resonance, identityWet.output, delay, start, end, 2);

    auto dryOnly = renderOutput(resonance, 100.0f, 0.0f, 0.0f, false);
    const ErrorStats dryOnlyError =
        computeAlignedError(resonance, dryOnly.output, 0, start, end, 2);

    auto wetSuppressed = renderOutput(resonance, 100.0f, 100.0f, 0.0f, false);
    auto halfMix = renderOutput(resonance, 100.0f, 50.0f, 0.0f, false);

    const double dryRmsReduction =
        computeAlignedRmsReductionDb(resonance, dryOnly.output, 0, start, end, 0);
    const double halfRmsReduction =
        computeAlignedRmsReductionDb(resonance, halfMix.output, delay, start, end, 0);
    const double wetRmsReduction =
        computeAlignedRmsReductionDb(resonance, wetSuppressed.output, delay, start, end, 0);

    auto trim0 = renderOutput(resonance, 0.0f, 100.0f, 0.0f, false);
    auto trimPlus6 = renderOutput(resonance, 0.0f, 100.0f, 6.0f, false);
    auto trimMinus6 = renderOutput(resonance, 0.0f, 100.0f, -6.0f, false);
    const double trim0Rms = computeAlignedOutputRms(trim0.output, delay, start, end, 0);
    const double trimPlus6Rms = computeAlignedOutputRms(trimPlus6.output, delay, start, end, 0);
    const double trimMinus6Rms = computeAlignedOutputRms(trimMinus6.output, delay, start, end, 0);
    const double trimPlusDb = 20.0 * std::log10(trimPlus6Rms / std::max(trim0Rms, 1.0e-15));
    const double trimMinusDb = 20.0 * std::log10(trimMinus6Rms / std::max(trim0Rms, 1.0e-15));

    auto deltaDepth0 = renderOutput(resonance, 0.0f, 100.0f, 0.0f, true);
    auto deltaDepth100 = renderOutput(resonance, 100.0f, 100.0f, 0.0f, true);
    const double delta0Rms = computeAlignedOutputRms(deltaDepth0.output, delay, start, end, 0);
    const double delta100Rms = computeAlignedOutputRms(deltaDepth100.output, delay, start, end, 0);

    auto meterNormal = renderOutput(resonance, 100.0f, 100.0f, 0.0f, false);
    auto meterDryTrimmed = renderOutput(resonance, 100.0f, 0.0f, 6.0f, false);

    std::cout << "    output identity wet/dry-only max error: "
              << identityWetError.maxAbs << " / " << dryOnlyError.maxAbs << "\n";
    std::cout << "    RMS reduction dry/mix50/wet: "
              << dryRmsReduction << " / " << halfRmsReduction
              << " / " << wetRmsReduction << "\n";
    std::cout << "    trim gain dB +6/-6: "
              << trimPlusDb << " / " << trimMinusDb << "\n";
    std::cout << "    delta RMS depth0/depth100: "
              << delta0Rms << " / " << delta100Rms << "\n";
    std::cout << "    GR meter normal vs dry+trim: "
              << meterNormal.peakMeter << " / " << meterDryTrimmed.peakMeter << "\n";

    CHECK(identityWetError.maxAbs < 2.0e-4 && identityWetError.rms < 5.0e-5,
          "RS mix 100 depth 0 should preserve WOLA identity");
    CHECK(dryOnlyError.maxAbs < 1.0e-6 && dryOnlyError.rms < 1.0e-7,
          "RS mix 0 should output true live dry");
    CHECK(halfRmsReduction > dryRmsReduction + 0.2 && halfRmsReduction < wetRmsReduction - 0.2,
          "RS mix 50 RMS reduction should sit between dry and fully wet");
    CHECK(trimPlusDb > 5.8 && trimPlusDb < 6.2 && trimMinusDb < -5.8 && trimMinusDb > -6.2,
          "RS trim should apply post-output gain in dB");
    CHECK(delta0Rms < 1.0e-5,
          "RS delta depth 0 should be near silence after latency compensation");
    CHECK(delta100Rms > delta0Rms + 0.01,
          "RS delta depth 100 should expose measurable removed material");
    CHECK(meterNormal.peakMeter > meterDryTrimmed.peakMeter + 0.05f,
          "RS mix 0 should stop wet gain-reduction metering");

    {
        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", 100.0f);
        fx.setParameterValue("sharpness", 70.0f);
        fx.setParameterValue("selectivity", 35.0f);
        fx.setParameterValue("mix", 100.0f);
        fx.setParameterValue("trim", 0.0f);
        fx.setParameterValue("delta", 0.0f);
        fx.prepareToPlay(kSR, 512);

        juce::MidiBuffer midi;
        juce::AudioBuffer<float> block(2, 512);
        for (int s = 0; s < block.getNumSamples(); ++s)
        {
            const float t = static_cast<float>(s) / static_cast<float>(kSR);
            const float v = 0.18f * std::sin(pi2 * 997.0f * t);
            block.setSample(0, s, v);
            block.setSample(1, s, v);
        }

        fx.processBlock(block, midi);
        fx.setParameterValue("delta", 1.0f);
        fx.processBlock(block, midi);

        CHECK(allSamplesFinite(block) && maxAbsBuffer(block) < 1.0f,
              "RS delta toggle crossfade should stay finite without a huge discontinuity");
    }
}

static void testResonanceSuppressorWeightingCurve()
{
    std::cout << "  [resonance suppressor weighting curve]\n";

    constexpr double kSR = 44100.0;
    constexpr int kTotalSamples = 65536;
    const std::vector<int> mixedSchedule = {1, 37, 128, 255, 511, 1024, 37};
    const int delay = measureImpulseDelayForQuality(1, mixedSchedule);
    const int start = 8192;
    const int end = kTotalSamples - 4096;
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;

    auto makeResonance = [pi2](float frequency) {
        juce::AudioBuffer<float> input(2, kTotalSamples);
        for (int s = 0; s < kTotalSamples; ++s)
        {
            const float t = static_cast<float>(s) / static_cast<float>(kSR);
            const float v = 0.18f * std::sin(pi2 * frequency * t)
                          + 0.025f * std::sin(pi2 * 311.0f * t);
            input.setSample(0, s, v);
            input.setSample(1, s, 0.9f * v);
        }
        return input;
    };

    const auto centered = makeResonance(997.0f);
    const auto lowTone = makeResonance(155.0f);
    const auto highTone = makeResonance(6000.0f);

    auto renderWeighted = [&mixedSchedule](const juce::AudioBuffer<float>& input,
                                           float b2Freq,
                                           float b2Gain,
                                           float hp,
                                           float lp,
                                           bool delta = false,
                                           float mix = 100.0f) {
        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", 100.0f);
        fx.setParameterValue("sharpness", 70.0f);
        fx.setParameterValue("selectivity", 35.0f);
        fx.setParameterValue("attack", 15.0f);
        fx.setParameterValue("release", 200.0f);
        fx.setParameterValue("mode", 0.0f);
        fx.setParameterValue("stereo_link", 100.0f);
        fx.setParameterValue("mix", mix);
        fx.setParameterValue("trim", 0.0f);
        fx.setParameterValue("delta", delta ? 1.0f : 0.0f);
        fx.setParameterValue("wc_hp", hp);
        fx.setParameterValue("wc_lp", lp);
        fx.setParameterValue("wc_b1_gain", 0.0f);
        fx.setParameterValue("wc_b2_freq", b2Freq);
        fx.setParameterValue("wc_b2_gain", b2Gain);
        fx.setParameterValue("wc_b3_gain", 0.0f);
        fx.setParameterValue("wc_b4_gain", 0.0f);
        fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));
        return renderEffectAndMeterInBlocks(fx, input, mixedSchedule);
    };

    auto defaultCurve = renderWeighted(centered, 997.0f, 0.0f, 80.0f, 16000.0f);
    auto boosted = renderWeighted(centered, 997.0f, 12.0f, 80.0f, 16000.0f);
    auto cut = renderWeighted(centered, 997.0f, -12.0f, 80.0f, 16000.0f);
    auto offTargetBoost = renderWeighted(centered, 8000.0f, 12.0f, 80.0f, 16000.0f);

    const double defaultDb =
        computeAlignedToneReductionDb(centered, defaultCurve.output, delay, start, end, 0, kSR, 997.0);
    const double boostDb =
        computeAlignedToneReductionDb(centered, boosted.output, delay, start, end, 0, kSR, 997.0);
    const double cutDb =
        computeAlignedToneReductionDb(centered, cut.output, delay, start, end, 0, kSR, 997.0);
    const double offTargetDb =
        computeAlignedToneReductionDb(centered, offTargetBoost.output, delay, start, end, 0, kSR, 997.0);

    auto lowDefault = renderWeighted(lowTone, 997.0f, 0.0f, 80.0f, 16000.0f);
    auto lowHpBlocked = renderWeighted(lowTone, 997.0f, 0.0f, 500.0f, 16000.0f);
    auto lowHpDry = renderWeighted(lowTone, 997.0f, 0.0f, 500.0f, 16000.0f, false, 0.0f);
    const double lowDefaultDb =
        computeAlignedToneReductionDb(lowTone, lowDefault.output, delay, start, end, 0, kSR, 155.0);
    const double lowHpDb =
        computeAlignedToneReductionDb(lowTone, lowHpBlocked.output, delay, start, end, 0, kSR, 155.0);
    const ErrorStats lowDryError =
        computeAlignedError(lowTone, lowHpDry.output, 0, start, end, 2);

    auto highDefault = renderWeighted(highTone, 997.0f, 0.0f, 80.0f, 16000.0f);
    auto highLpBlocked = renderWeighted(highTone, 997.0f, 0.0f, 80.0f, 3000.0f);
    auto highLpDry = renderWeighted(highTone, 997.0f, 0.0f, 80.0f, 3000.0f, false, 0.0f);
    const double highDefaultDb =
        computeAlignedToneReductionDb(highTone, highDefault.output, delay, start, end, 0, kSR, 6000.0);
    const double highLpDb =
        computeAlignedToneReductionDb(highTone, highLpBlocked.output, delay, start, end, 0, kSR, 6000.0);
    const ErrorStats highDryError =
        computeAlignedError(highTone, highLpDry.output, 0, start, end, 2);

    auto deltaDefault = renderWeighted(centered, 997.0f, 0.0f, 80.0f, 16000.0f, true);
    auto deltaBoost = renderWeighted(centered, 997.0f, 12.0f, 80.0f, 16000.0f, true);
    auto deltaCut = renderWeighted(centered, 997.0f, -12.0f, 80.0f, 16000.0f, true);
    const double deltaDefaultRms = computeAlignedOutputRms(deltaDefault.output, delay, start, end, 0);
    const double deltaBoostRms = computeAlignedOutputRms(deltaBoost.output, delay, start, end, 0);
    const double deltaCutRms = computeAlignedOutputRms(deltaCut.output, delay, start, end, 0);

    std::cout << "    weighting centered tone reduction default/boost/cut/offtarget: "
              << defaultDb << " / " << boostDb << " / "
              << cutDb << " / " << offTargetDb << "\n";
    std::cout << "    weighting low HP default/blocked and high LP default/blocked: "
              << lowDefaultDb << " / " << lowHpDb << " ; "
              << highDefaultDb << " / " << highLpDb << "\n";
    std::cout << "    weighting delta RMS cut/default/boost: "
              << deltaCutRms << " / " << deltaDefaultRms << " / "
              << deltaBoostRms << "\n";
    std::cout << "    weighting meter cut/default/boost: "
              << cut.peakMeter << " / " << defaultCurve.peakMeter
              << " / " << boosted.peakMeter << "\n";

    CHECK(allSamplesFinite(defaultCurve.output) && allSamplesFinite(boosted.output)
          && allSamplesFinite(cut.output) && allSamplesFinite(offTargetBoost.output)
          && allSamplesFinite(lowHpBlocked.output) && allSamplesFinite(highLpBlocked.output),
          "RS weighting outputs should stay finite");
    CHECK(boostDb > defaultDb + 0.5,
          "RS centered positive weighting node should increase suppression");
    CHECK(defaultDb > cutDb + 3.0,
          "RS centered negative weighting node should strongly reduce suppression");
    CHECK(std::abs(offTargetDb - defaultDb) < std::abs(boostDb - defaultDb) * 0.5,
          "RS off-target weighting node should have much less effect than centered boost");
    CHECK(lowDefaultDb > lowHpDb + 3.0,
          "RS HP sensitivity boundary should reduce low-frequency suppression");
    CHECK(highDefaultDb > highLpDb + 3.0,
          "RS LP sensitivity boundary should reduce high-frequency suppression");
    CHECK(lowDryError.maxAbs < 2.0e-4 && highDryError.maxAbs < 2.0e-4,
          "RS HP/LP weighting gates should not filter latency-aligned dry audio");
    CHECK(boosted.peakMeter > defaultCurve.peakMeter && defaultCurve.peakMeter > cut.peakMeter,
          "RS slot 2 should follow weighting-driven gain-reduction amount");
    CHECK(deltaBoostRms > deltaDefaultRms && deltaDefaultRms > deltaCutRms,
          "RS delta listen should expose more or less removed material according to weighting");
}

static void testResonanceSuppressorFocusCurveV11Bands()
{
    std::cout << "  [resonance suppressor focus curve v1.1 bands]\n";

    constexpr double kSR = 44100.0;
    constexpr int kTotalSamples = 65536;
    const std::vector<int> mixedSchedule = {1, 37, 128, 255, 511, 1024, 37};
    const int delay = measureImpulseDelayForQuality(1, mixedSchedule);
    const int start = 8192;
    const int end = kTotalSamples - 4096;
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;

    auto makeResonance = [pi2](float frequency) {
        juce::AudioBuffer<float> input(2, kTotalSamples);
        for (int s = 0; s < kTotalSamples; ++s)
        {
            const float t = static_cast<float>(s) / static_cast<float>(kSR);
            const float v = 0.18f * std::sin(pi2 * frequency * t)
                          + 0.02f * std::sin(pi2 * 311.0f * t);
            input.setSample(0, s, v);
            input.setSample(1, s, 0.9f * v);
        }
        return input;
    };

    const auto lowTone = makeResonance(250.0f);
    const auto centerTone = makeResonance(997.0f);
    const auto highTone = makeResonance(2000.0f);

    auto configureCommon = [](XlethResonanceSuppressorEffect& fx) {
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", 100.0f);
        fx.setParameterValue("sharpness", 70.0f);
        fx.setParameterValue("selectivity", 35.0f);
        fx.setParameterValue("attack", 15.0f);
        fx.setParameterValue("release", 200.0f);
        fx.setParameterValue("mode", 0.0f);
        fx.setParameterValue("stereo_link", 100.0f);
        fx.setParameterValue("mix", 100.0f);
        fx.setParameterValue("trim", 0.0f);
        fx.setParameterValue("delta", 0.0f);
        fx.setParameterValue("wc_hp", 80.0f);
        fx.setParameterValue("wc_lp", 16000.0f);
        for (int b = 1; b <= 8; ++b)
        {
            fx.setParameterValue("wc_b" + std::to_string(b) + "_gain", 0.0f);
            fx.setParameterValue("wc_b" + std::to_string(b) + "_type", 0.0f);
            fx.setParameterValue("wc_b" + std::to_string(b) + "_q", 1.0f);
        }
    };

    auto setBand = [](XlethResonanceSuppressorEffect& fx,
                      int band,
                      bool active,
                      int type,
                      float freq,
                      float gain,
                      float q) {
        const std::string prefix = "wc_b" + std::to_string(band) + "_";
        fx.setParameterValue(prefix + "active", active ? 1.0f : 0.0f);
        fx.setParameterValue(prefix + "type", static_cast<float>(type));
        fx.setParameterValue(prefix + "freq", freq);
        fx.setParameterValue(prefix + "gain", gain);
        fx.setParameterValue(prefix + "q", q);
    };

    auto renderWith = [&](const juce::AudioBuffer<float>& input, auto&& configure) {
        XlethResonanceSuppressorEffect fx;
        configureCommon(fx);
        configure(fx);
        fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));
        return renderEffectAndMeterInBlocks(fx, input, mixedSchedule);
    };

    auto reductionDb = [&](const juce::AudioBuffer<float>& input,
                           const RenderWithMeterResult& result,
                           double frequency) {
        return computeAlignedToneReductionDb(input, result.output, delay, start, end, 0, kSR, frequency);
    };

    const auto centerDefault = renderWith(centerTone, [](auto&) {});
    const double centerDefaultDb = reductionDb(centerTone, centerDefault, 997.0);

    const auto bellBand1 = renderWith(centerTone, [&](auto& fx) {
        setBand(fx, 1, true, 0, 997.0f, 12.0f, 1.0f);
    });
    const auto bellBand2 = renderWith(centerTone, [&](auto& fx) {
        setBand(fx, 2, true, 0, 997.0f, 12.0f, 1.0f);
    });
    const auto bellBand4 = renderWith(centerTone, [&](auto& fx) {
        setBand(fx, 4, true, 0, 997.0f, 12.0f, 1.0f);
    });
    const double bellBand1Db = reductionDb(centerTone, bellBand1, 997.0);
    const double bellBand2Db = reductionDb(centerTone, bellBand2, 997.0);
    const double bellBand4Db = reductionDb(centerTone, bellBand4, 997.0);

    const auto bellBroadOff = renderWith(highTone, [&](auto& fx) {
        setBand(fx, 1, true, 0, 997.0f, 12.0f, 0.25f);
    });
    const auto bellNarrowOff = renderWith(highTone, [&](auto& fx) {
        setBand(fx, 1, true, 0, 997.0f, 12.0f, 4.0f);
    });
    const double bellBroadOffDb = reductionDb(highTone, bellBroadOff, 2000.0);
    const double bellNarrowOffDb = reductionDb(highTone, bellNarrowOff, 2000.0);

    const auto lowDefault = renderWith(lowTone, [](auto&) {});
    const auto highDefault = renderWith(highTone, [](auto&) {});
    const double lowDefaultDb = reductionDb(lowTone, lowDefault, 250.0);
    const double highDefaultDb = reductionDb(highTone, highDefault, 2000.0);

    const auto lowShelfPosLow = renderWith(lowTone, [&](auto& fx) {
        setBand(fx, 1, true, 1, 500.0f, 12.0f, 1.0f);
    });
    const auto lowShelfPosHigh = renderWith(highTone, [&](auto& fx) {
        setBand(fx, 1, true, 1, 500.0f, 12.0f, 1.0f);
    });
    const auto lowShelfNegLow = renderWith(lowTone, [&](auto& fx) {
        setBand(fx, 1, true, 1, 500.0f, -12.0f, 1.0f);
    });
    const double lowShelfPosLowDb = reductionDb(lowTone, lowShelfPosLow, 250.0);
    const double lowShelfPosHighDb = reductionDb(highTone, lowShelfPosHigh, 2000.0);
    const double lowShelfNegLowDb = reductionDb(lowTone, lowShelfNegLow, 250.0);

    const auto highShelfPosLow = renderWith(lowTone, [&](auto& fx) {
        setBand(fx, 1, true, 2, 500.0f, 12.0f, 1.0f);
    });
    const auto highShelfPosHigh = renderWith(highTone, [&](auto& fx) {
        setBand(fx, 1, true, 2, 500.0f, 12.0f, 1.0f);
    });
    const auto highShelfNegHigh = renderWith(highTone, [&](auto& fx) {
        setBand(fx, 1, true, 2, 500.0f, -12.0f, 1.0f);
    });
    const double highShelfPosLowDb = reductionDb(lowTone, highShelfPosLow, 250.0);
    const double highShelfPosHighDb = reductionDb(highTone, highShelfPosHigh, 2000.0);
    const double highShelfNegHighDb = reductionDb(highTone, highShelfNegHigh, 2000.0);

    const auto rejectNeg = renderWith(centerTone, [&](auto& fx) {
        setBand(fx, 1, true, 3, 997.0f, -12.0f, 1.0f);
    });
    const auto rejectPos = renderWith(centerTone, [&](auto& fx) {
        setBand(fx, 1, true, 3, 997.0f, 12.0f, 1.0f);
    });
    const double rejectNegDb = reductionDb(centerTone, rejectNeg, 997.0);
    const double rejectPosDb = reductionDb(centerTone, rejectPos, 997.0);

    const auto tiltPosLow = renderWith(lowTone, [&](auto& fx) {
        setBand(fx, 1, true, 4, 500.0f, 12.0f, 1.0f);
    });
    const auto tiltPosHigh = renderWith(highTone, [&](auto& fx) {
        setBand(fx, 1, true, 4, 500.0f, 12.0f, 1.0f);
    });
    const auto tiltNegLow = renderWith(lowTone, [&](auto& fx) {
        setBand(fx, 1, true, 4, 500.0f, -12.0f, 1.0f);
    });
    const auto tiltNegHigh = renderWith(highTone, [&](auto& fx) {
        setBand(fx, 1, true, 4, 500.0f, -12.0f, 1.0f);
    });
    const double tiltPosLowDb = reductionDb(lowTone, tiltPosLow, 250.0);
    const double tiltPosHighDb = reductionDb(highTone, tiltPosHigh, 2000.0);
    const double tiltNegLowDb = reductionDb(lowTone, tiltNegLow, 250.0);
    const double tiltNegHighDb = reductionDb(highTone, tiltNegHigh, 2000.0);

    const auto inactiveBoost = renderWith(centerTone, [&](auto& fx) {
        setBand(fx, 1, false, 0, 997.0f, 12.0f, 1.0f);
    });
    const double inactiveBoostDb = reductionDb(centerTone, inactiveBoost, 997.0);

    const auto band5Boost = renderWith(centerTone, [&](auto& fx) {
        setBand(fx, 5, true, 0, 997.0f, 12.0f, 1.0f);
    });
    const double band5BoostDb = reductionDb(centerTone, band5Boost, 997.0);

    const auto allInactiveDefaultGain = renderWith(centerTone, [&](auto& fx) {
        for (int b = 1; b <= 8; ++b)
            setBand(fx, b, false, 0, 997.0f, 0.0f, 1.0f);
    });
    const double allInactiveDefaultGainDb = reductionDb(centerTone, allInactiveDefaultGain, 997.0);

    std::cout << "    bell q=1 band1/band2/band4/default: "
              << bellBand1Db << " / " << bellBand2Db << " / "
              << bellBand4Db << " / " << centerDefaultDb << "\n";
    std::cout << "    bell broad/narrow off-target: "
              << bellBroadOffDb << " / " << bellNarrowOffDb << "\n";
    std::cout << "    low shelf low/high pos, low neg/default: "
              << lowShelfPosLowDb << " / " << lowShelfPosHighDb << " ; "
              << lowShelfNegLowDb << " / " << lowDefaultDb << "\n";
    std::cout << "    high shelf low/high pos, high neg/default: "
              << highShelfPosLowDb << " / " << highShelfPosHighDb << " ; "
              << highShelfNegHighDb << " / " << highDefaultDb << "\n";
    std::cout << "    reject neg/pos/default, tilt pos low/high, tilt neg low/high: "
              << rejectNegDb << " / " << rejectPosDb << " / " << centerDefaultDb << " ; "
              << tiltPosLowDb << " / " << tiltPosHighDb << " ; "
              << tiltNegLowDb << " / " << tiltNegHighDb << "\n";
    std::cout << "    inactive/default/band5/all-inactive-default-gain: "
              << inactiveBoostDb << " / " << centerDefaultDb << " / "
              << band5BoostDb << " / " << allInactiveDefaultGainDb << "\n";

    CHECK(allSamplesFinite(bellBand1.output) && allSamplesFinite(bellBroadOff.output)
          && allSamplesFinite(lowShelfPosLow.output) && allSamplesFinite(highShelfPosHigh.output)
          && allSamplesFinite(rejectNeg.output) && allSamplesFinite(tiltPosHigh.output)
          && allSamplesFinite(band5Boost.output),
          "RS focus curve v1.1 outputs should stay finite");
    CHECK(std::abs(bellBand1Db - bellBand2Db) < 0.10
          && std::abs(bellBand1Db - bellBand4Db) < 0.10
          && bellBand1Db > centerDefaultDb + 0.5,
          "RS Bell q=1 should preserve old fixed-sigma behavior across legacy bands");
    CHECK(bellBroadOffDb > bellNarrowOffDb + 0.5,
          "RS Bell q=4 should be narrower than q=0.25");
    CHECK((lowShelfPosLowDb - lowDefaultDb) > (lowShelfPosHighDb - highDefaultDb) + 0.5
          && lowShelfNegLowDb < lowDefaultDb - 0.5,
          "RS Low Shelf should affect/protect lows more than highs");
    CHECK((highShelfPosHighDb - highDefaultDb) > (highShelfPosLowDb - lowDefaultDb) + 0.5
          && highShelfNegHighDb < highDefaultDb - 0.5,
          "RS High Shelf should affect/protect highs more than lows");
    CHECK(rejectNegDb < centerDefaultDb - 3.0 && rejectPosDb <= centerDefaultDb + 0.20,
          "RS Band Reject should reduce center sensitivity and never boost with positive gain");
    CHECK(tiltPosHighDb > highDefaultDb && tiltPosLowDb < lowDefaultDb
          && tiltNegLowDb > lowDefaultDb && tiltNegHighDb < highDefaultDb,
          "RS Tilt should follow gain sign around the pivot");
    CHECK(std::abs(inactiveBoostDb - centerDefaultDb) < 0.20,
          "RS inactive focus band should contribute nothing");
    CHECK(band5BoostDb > centerDefaultDb + 0.5,
          "RS band 5 should affect DSP like earlier bands when active");
    CHECK(std::abs(allInactiveDefaultGainDb - centerDefaultDb) < 0.20,
          "RS default zero-gain focus curve behavior should be preserved");
}

// Regression: focus-curve params edited *after* prepareToPlay must reach the
// DSP. Earlier the snapshot used getSmoothedValue() whose current() never
// advanced (the wc_* smoothers were registered but never advanced via
// getNextSmoothedValue) so it returned the prepareToPlay-time value forever.
// This test edits band 2 between renders on a single fx instance to prove
// live edits are picked up.
static void testResonanceSuppressorFocusCurveLiveEdits()
{
    std::cout << "  [resonance suppressor focus curve live edits]\n";

    constexpr double kSR = 44100.0;
    constexpr int kTotalSamples = 65536;
    const std::vector<int> mixedSchedule = {1, 37, 128, 255, 511, 1024, 37};
    const int delay = measureImpulseDelayForQuality(1, mixedSchedule);
    const int start = 8192;
    const int end = kTotalSamples - 4096;
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;

    auto makeTone = [pi2](float frequency) {
        juce::AudioBuffer<float> input(2, kTotalSamples);
        for (int s = 0; s < kTotalSamples; ++s)
        {
            const float t = static_cast<float>(s) / static_cast<float>(kSR);
            const float v = 0.18f * std::sin(pi2 * frequency * t)
                          + 0.02f * std::sin(pi2 * 311.0f * t);
            input.setSample(0, s, v);
            input.setSample(1, s, 0.9f * v);
        }
        return input;
    };

    const juce::AudioBuffer<float> centerTone = makeTone(997.0f);
    const juce::AudioBuffer<float> highTone   = makeTone(2000.0f);

    auto setBand = [](XlethResonanceSuppressorEffect& fx,
                      int band,
                      bool active,
                      int type,
                      float freq,
                      float gain,
                      float q) {
        const std::string p = "wc_b" + std::to_string(band) + "_";
        fx.setParameterValue(p + "active", active ? 1.0f : 0.0f);
        fx.setParameterValue(p + "type",   static_cast<float>(type));
        fx.setParameterValue(p + "freq",   freq);
        fx.setParameterValue(p + "gain",   gain);
        fx.setParameterValue(p + "q",      q);
    };

    XlethResonanceSuppressorEffect fx;
    setResonanceHighQualityMode(fx);
    fx.setParameterValue("quality",     1.0f);
    fx.setParameterValue("depth",       100.0f);
    fx.setParameterValue("sharpness",   70.0f);
    fx.setParameterValue("selectivity", 35.0f);
    fx.setParameterValue("attack",      15.0f);
    fx.setParameterValue("release",     200.0f);
    fx.setParameterValue("mode",        0.0f);
    fx.setParameterValue("stereo_link", 100.0f);
    fx.setParameterValue("mix",         100.0f);
    fx.setParameterValue("trim",        0.0f);
    fx.setParameterValue("delta",       0.0f);
    fx.setParameterValue("wc_hp",       80.0f);
    fx.setParameterValue("wc_lp",       16000.0f);
    // Leave bands 1..8 at APVTS defaults (zero gain) so the baseline render
    // measures the unweighted detector behaviour.

    fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));

    auto renderCenter = [&](XlethResonanceSuppressorEffect& fxRef) {
        fxRef.reset(); // flush WOLA / dry-delay state between renders
        return renderEffectAndMeterInBlocks(fxRef, centerTone, mixedSchedule);
    };
    auto renderHigh = [&](XlethResonanceSuppressorEffect& fxRef) {
        fxRef.reset();
        return renderEffectAndMeterInBlocks(fxRef, highTone, mixedSchedule);
    };

    auto centerDb = [&](const RenderWithMeterResult& result) {
        return computeAlignedToneReductionDb(centerTone, result.output, delay, start, end, 0, kSR, 997.0);
    };
    auto highDb = [&](const RenderWithMeterResult& result) {
        return computeAlignedToneReductionDb(highTone, result.output, delay, start, end, 0, kSR, 2000.0);
    };

    const auto baselineCenter = renderCenter(fx);
    const double baselineCenterDb = centerDb(baselineCenter);

    // 1) Bell +12 at 997 Hz — must increase suppression vs baseline.
    setBand(fx, 2, true, 0, 997.0f, 12.0f, 1.0f);
    const auto bellBoost = renderCenter(fx);
    const double bellBoostDb = centerDb(bellBoost);

    // 2) Bell -12 at 997 Hz — must reduce suppression / protect.
    setBand(fx, 2, true, 0, 997.0f, -12.0f, 1.0f);
    const auto bellProtect = renderCenter(fx);
    const double bellProtectDb = centerDb(bellProtect);

    // 3) Type=Protect (3) with positive gain must not boost suppression.
    //    Engine clamps to min(gain, 0) for type 3.
    setBand(fx, 2, true, 3, 997.0f, 12.0f, 1.0f);
    const auto protectPos = renderCenter(fx);
    const double protectPosDb = centerDb(protectPos);

    // 4) Q narrow vs wide measured *off-center* on a 2 kHz tone with band at
    //    997 Hz. At exact band center the Bell shape evaluates to 1.0 for any
    //    Q (a Gaussian peak), so the Q axis only shows up off-target.
    setBand(fx, 2, true, 0, 997.0f, 12.0f, 4.0f);
    const auto qNarrow = renderHigh(fx);
    const double qNarrowDb = highDb(qNarrow);

    setBand(fx, 2, true, 0, 997.0f, 12.0f, 0.25f);
    const auto qWide = renderHigh(fx);
    const double qWideDb = highDb(qWide);

    // 5) Type change effect — switch from Bell to Tilt at the pivot. Bell+12
    //    boosts at the pivot; Tilt at the pivot contributes ~0. Switching
    //    Bell → Tilt at the band freq should bring suppression back toward
    //    baseline.
    setBand(fx, 2, true, 0, 997.0f, 12.0f, 1.0f);
    const auto bellRef = renderCenter(fx);
    const double bellRefDb = centerDb(bellRef);
    setBand(fx, 2, true, 4, 997.0f, 12.0f, 1.0f);
    const auto tiltAtPivot = renderCenter(fx);
    const double tiltAtPivotDb = centerDb(tiltAtPivot);

    std::cout << "    baseline / bell+12 / bell-12 / protect+12: "
              << baselineCenterDb << " / " << bellBoostDb << " / "
              << bellProtectDb << " / " << protectPosDb << "\n";
    std::cout << "    q=4 (off) / q=0.25 (off) / bell+12 ref / tilt+12 at pivot: "
              << qNarrowDb << " / " << qWideDb << " / "
              << bellRefDb << " / " << tiltAtPivotDb << "\n";

    CHECK(allSamplesFinite(bellBoost.output)
          && allSamplesFinite(bellProtect.output)
          && allSamplesFinite(protectPos.output)
          && allSamplesFinite(qNarrow.output)
          && allSamplesFinite(qWide.output)
          && allSamplesFinite(tiltAtPivot.output),
          "RS focus curve live-edit outputs should stay finite");
    CHECK(bellBoostDb > baselineCenterDb + 0.5,
          "RS Bell +12 set after prepareToPlay must increase suppression at the band center");
    CHECK(bellProtectDb < baselineCenterDb - 0.5,
          "RS Bell -12 set after prepareToPlay must reduce suppression at the band center");
    CHECK(protectPosDb <= baselineCenterDb + 0.20,
          "RS Protect (type 3) with positive gain must never increase suppression");
    CHECK(qWideDb > qNarrowDb + 0.5,
          "RS wide Q (0.25) should reach further off-band than narrow Q (4) when edited live");
    CHECK(tiltAtPivotDb < bellRefDb - 0.5,
          "RS Type change (Bell -> Tilt at pivot) must visibly change suppression at the band center");
}

static void testResonanceSuppressorStereoModes()
{
    std::cout << "  [resonance suppressor stereo modes]\n";

    constexpr double kSR = 44100.0;
    constexpr int kTotalSamples = 65536;
    const std::vector<int> mixedSchedule = {1, 37, 128, 255, 511, 1024, 37};
    const int delay = measureImpulseDelayForQuality(1, mixedSchedule);
    const int start = 8192;
    const int end = kTotalSamples - 4096;
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;

    juce::AudioBuffer<float> centered(2, kTotalSamples);
    juce::AudioBuffer<float> sideOnly(2, kTotalSamples);
    juce::AudioBuffer<float> mono(1, kTotalSamples);

    for (int s = 0; s < kTotalSamples; ++s)
    {
        const float t = static_cast<float>(s) / static_cast<float>(kSR);
        const float v = 0.18f * std::sin(pi2 * 997.0f * t)
                      + 0.02f * std::sin(pi2 * 311.0f * t);

        centered.setSample(0, s, v);
        centered.setSample(1, s, v);
        sideOnly.setSample(0, s, v);
        sideOnly.setSample(1, s, -v);
        mono.setSample(0, s, v);
    }

    auto renderMode = [&mixedSchedule](const juce::AudioBuffer<float>& input,
                                       int stereoMode,
                                       bool delta = false) {
        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality", 1.0f);
        fx.setParameterValue("depth", 100.0f);
        fx.setParameterValue("sharpness", 70.0f);
        fx.setParameterValue("selectivity", 35.0f);
        fx.setParameterValue("attack", 15.0f);
        fx.setParameterValue("release", 200.0f);
        fx.setParameterValue("mode", 0.0f);
        fx.setParameterValue("stereo_link", 0.0f);
        fx.setParameterValue("stereo_mode", static_cast<float>(stereoMode));
        fx.setParameterValue("mix", 100.0f);
        fx.setParameterValue("trim", 0.0f);
        fx.setParameterValue("delta", delta ? 1.0f : 0.0f);
        fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));
        return renderEffectAndMeterInBlocks(fx, input, mixedSchedule);
    };

    auto centeredMid = renderMode(centered, 1);
    auto centeredSide = renderMode(centered, 2);
    auto sideMid = renderMode(sideOnly, 1);
    auto sideSide = renderMode(sideOnly, 2);

    const double centeredMidDb =
        computeAlignedToneReductionDb(centered, centeredMid.output, delay, start, end, 0, kSR, 997.0);
    const double centeredSideDb =
        computeAlignedToneReductionDb(centered, centeredSide.output, delay, start, end, 0, kSR, 997.0);
    const double sideMidDb =
        computeAlignedToneReductionDb(sideOnly, sideMid.output, delay, start, end, 0, kSR, 997.0);
    const double sideSideDb =
        computeAlignedToneReductionDb(sideOnly, sideSide.output, delay, start, end, 0, kSR, 997.0);

    const ErrorStats centeredSideDryError =
        computeAlignedError(centered, centeredSide.output, delay, start, end, 2);
    const ErrorStats sideMidDryError =
        computeAlignedError(sideOnly, sideMid.output, delay, start, end, 2);

    auto centeredMidDelta = renderMode(centered, 1, true);
    auto centeredSideDelta = renderMode(centered, 2, true);
    auto sideMidDelta = renderMode(sideOnly, 1, true);
    auto sideSideDelta = renderMode(sideOnly, 2, true);

    const double centeredMidDeltaRms = computeAlignedOutputRms(centeredMidDelta.output, delay, start, end, 0);
    const double centeredSideDeltaRms = computeAlignedOutputRms(centeredSideDelta.output, delay, start, end, 0);
    const double sideMidDeltaRms = computeAlignedOutputRms(sideMidDelta.output, delay, start, end, 0);
    const double sideSideDeltaRms = computeAlignedOutputRms(sideSideDelta.output, delay, start, end, 0);

    auto monoMid = renderMode(mono, 1);
    auto monoSide = renderMode(mono, 2);
    const double monoMidDb =
        computeAlignedToneReductionDb(mono, monoMid.output, delay, start, end, 0, kSR, 997.0);
    const ErrorStats monoSideDryError =
        computeAlignedError(mono, monoSide.output, delay, start, end, 1);

    std::cout << "    stereo mode centered Mid/Side reduction dB: "
              << centeredMidDb << " / " << centeredSideDb << "\n";
    std::cout << "    stereo mode side-only Mid/Side reduction dB: "
              << sideMidDb << " / " << sideSideDb << "\n";
    std::cout << "    stereo mode delta centered Mid/Side and side-only Mid/Side RMS: "
              << centeredMidDeltaRms << " / " << centeredSideDeltaRms
              << " ; " << sideMidDeltaRms << " / " << sideSideDeltaRms << "\n";
    std::cout << "    stereo mode meters centered Mid/Side and side-only Mid/Side: "
              << centeredMid.peakMeter << " / " << centeredSide.peakMeter
              << " ; " << sideMid.peakMeter << " / " << sideSide.peakMeter << "\n";
    std::cout << "    stereo mode mono Mid reduction / Side dry max error: "
              << monoMidDb << " / " << monoSideDryError.maxAbs << "\n";

    CHECK(allSamplesFinite(centeredMid.output) && allSamplesFinite(centeredSide.output)
          && allSamplesFinite(sideMid.output) && allSamplesFinite(sideSide.output)
          && allSamplesFinite(monoMid.output) && allSamplesFinite(monoSide.output),
          "RS stereo_mode outputs should stay finite");
    CHECK(centeredMidDb > centeredSideDb + 5.0,
          "RS Mid mode should suppress centered resonance much more than Side mode");
    CHECK(sideSideDb > sideMidDb + 5.0,
          "RS Side mode should suppress side-only resonance much more than Mid mode");
    CHECK(centeredSideDryError.maxAbs < 2.0e-4,
          "RS Side mode should preserve centered material when side content is zero");
    CHECK(sideMidDryError.maxAbs < 2.0e-4,
          "RS Mid mode should preserve side-only material when mid content is zero");
    CHECK(centeredMidDeltaRms > centeredSideDeltaRms + 0.01,
          "RS Mid delta should contain removed centered resonance");
    CHECK(sideSideDeltaRms > sideMidDeltaRms + 0.01,
          "RS Side delta should contain removed side-only resonance");
    CHECK(centeredMid.peakMeter > centeredSide.peakMeter + 0.05f,
          "RS slot 2 should rise for selected Mid content and stay low for absent Side content");
    CHECK(sideSide.peakMeter > sideMid.peakMeter + 0.05f,
          "RS slot 2 should rise for selected Side content and stay low for absent Mid content");
    CHECK(monoMidDb > 5.0,
          "RS mono Mid mode should behave like mono suppression");
    CHECK(monoSideDryError.maxAbs < 2.0e-4,
          "RS mono Side mode should produce no meaningful suppression or artifacts");
}

static void testResonanceSuppressorModeSwitching()
{
    std::cout << "  [resonance suppressor mode switching]\n";

    // Regression test for the WOLA channel-desync bug:
    // channels_[1] was frozen when processMono ran in Mid/Side mode, causing
    // silent/corrupted output on right channel after switching back to Stereo.

    constexpr double kSR = 44100.0;
    constexpr int kPhase = 4096;  // one WOLA latency window at Normal quality
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;

    // Asymmetric L/R so a one-ear mistake shows as zero RMS on one channel.
    juce::AudioBuffer<float> inputSrc(2, kPhase * 8);
    for (int s = 0; s < inputSrc.getNumSamples(); ++s)
    {
        const float t = static_cast<float>(s) / static_cast<float>(kSR);
        inputSrc.setSample(0, s, 0.40f * std::sin(pi2 * 997.0f * t));
        inputSrc.setSample(1, s, 0.25f * std::sin(pi2 * 997.0f * t + 1.2f));
    }

    // Render one phase of numSamples starting at inputSrc[srcOffset].
    auto renderPhase = [&](XlethResonanceSuppressorEffect& fx,
                           int srcOffset,
                           int numSamples) -> juce::AudioBuffer<float>
    {
        juce::AudioBuffer<float> out(2, numSamples);
        juce::MidiBuffer midi;
        int pos = 0;
        while (pos < numSamples)
        {
            const int n = std::min(512, numSamples - pos);
            juce::AudioBuffer<float> block(2, n);
            for (int ch = 0; ch < 2; ++ch)
                block.copyFrom(ch, 0, inputSrc, ch, srcOffset + pos, n);
            fx.processBlock(block, midi);
            for (int ch = 0; ch < 2; ++ch)
                out.copyFrom(ch, pos, block, ch, 0, n);
            pos += n;
        }
        return out;
    };

    // sequence: list of (stereo_mode, num_samples) pairs.
    // The last element must be a final Stereo phase large enough to cover recovery.
    // After the sequence, the final phase output is checked: both channels must
    // have non-zero RMS in the second half (past the WOLA recovery window).
    auto runSequence = [&](const std::vector<std::pair<int, int>>& seq, const char* desc)
    {
        XlethResonanceSuppressorEffect fx;
        setResonanceHighQualityMode(fx);
        fx.setParameterValue("quality",     1.0f);  // Normal: fftSize=1024
        fx.setParameterValue("depth",       0.0f);  // identity — no suppression
        fx.setParameterValue("mix",       100.0f);
        fx.setParameterValue("trim",        0.0f);
        fx.setParameterValue("delta",       0.0f);
        fx.setParameterValue("stereo_mode", 0.0f);
        fx.prepareToPlay(kSR, 512);

        juce::AudioBuffer<float> lastOut;
        int srcOffset = 0;
        for (const auto& [mode, nSamples] : seq)
        {
            fx.setParameterValue("stereo_mode", static_cast<float>(mode));
            lastOut = renderPhase(fx, srcOffset, nSamples);
            srcOffset += nSamples;
        }

        const int nFinal = lastOut.getNumSamples();
        const int checkStart = nFinal / 2;
        double rmsL = 0.0, rmsR = 0.0;
        bool allFinite = true;
        for (int s = checkStart; s < nFinal; ++s)
        {
            const float l = lastOut.getSample(0, s);
            const float r = lastOut.getSample(1, s);
            if (!std::isfinite(l) || !std::isfinite(r))
                allFinite = false;
            rmsL += static_cast<double>(l * l);
            rmsR += static_cast<double>(r * r);
        }
        const int n = nFinal - checkStart;
        rmsL = n > 0 ? std::sqrt(rmsL / n) : 0.0;
        rmsR = n > 0 ? std::sqrt(rmsR / n) : 0.0;

        std::cout << "    " << desc << ": rmsL=" << rmsL
                  << " rmsR=" << rmsR << " finite=" << allFinite << "\n";

        CHECK(allFinite,
              std::string("RS mode switch [") + desc + "] must stay finite");
        CHECK(rmsL > 0.05,
              std::string("RS mode switch [") + desc + "] L must be non-zero after recovery");
        CHECK(rmsR > 0.05,
              std::string("RS mode switch [") + desc + "] R must be non-zero after recovery");
    };

    // 0=Stereo 1=Mid 2=Side. All sequences end with kPhase*2 in Stereo so
    // there is a full WOLA recovery window before the check region starts.
    runSequence({{0, kPhase}, {1, kPhase}, {0, kPhase * 2}},          "Stereo->Mid->Stereo");
    runSequence({{0, kPhase}, {2, kPhase}, {0, kPhase * 2}},          "Stereo->Side->Stereo");
    runSequence({{0, kPhase}, {1, kPhase}, {2, kPhase}, {0, kPhase * 2}}, "Stereo->Mid->Side->Stereo");
    runSequence({{0, kPhase}, {2, kPhase}, {1, kPhase}, {0, kPhase * 2}}, "Stereo->Side->Mid->Stereo");
    runSequence({{0, kPhase / 2}, {1, kPhase / 2}, {0, kPhase / 2},
                 {2, kPhase / 2}, {0, kPhase * 2}},                   "rapid cycling->Stereo");
}

static void testResonanceSuppressorVisualization()
{
    std::cout << "  [resonance suppressor visualization]\n";

    constexpr double kSR = 44100.0;
    constexpr int kTotalSamples = 65536;
    const std::vector<int> mixedSchedule = {1, 37, 128, 255, 511, 1024, 37};
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;

    juce::AudioBuffer<float> input(2, kTotalSamples);
    for (int s = 0; s < kTotalSamples; ++s)
    {
        const float t = static_cast<float>(s) / static_cast<float>(kSR);
        const float v = 0.16f * std::sin(pi2 * 997.0f * t)
                      + 0.09f * std::sin(pi2 * 1009.0f * t)
                      + 0.02f * std::sin(pi2 * 311.0f * t);
        input.setSample(0, s, v);
        input.setSample(1, s, 0.8f * v);
    }

    XlethResonanceSuppressorEffect fx;
    setResonanceHighQualityMode(fx);
    fx.setParameterValue("quality", 1.0f);
    fx.setParameterValue("depth", 100.0f);
    fx.setParameterValue("sharpness", 70.0f);
    fx.setParameterValue("selectivity", 35.0f);
    fx.setParameterValue("mode", 0.0f);
    fx.setParameterValue("mix", 100.0f);
    fx.setParameterValue("trim", 0.0f);
    fx.setParameterValue("delta", 0.0f);
    fx.prepareToPlay(kSR, maxBlockSizeOf(mixedSchedule));

    CHECK(fx.getVisualizationType() == xleth::viz::kVizTypeResonance,
          "RS viz type should be resonance");
    CHECK(fx.getVisualizationSchemaVersion() == xleth::viz::kDynamicsVizSchemaVersion,
          "RS viz schema should match DynamicsVizFrame");

    std::vector<std::uint8_t> drainBuffer(sizeof(xleth::viz::ResonanceBucket) * 64);
    CHECK(fx.drainVizFrames(drainBuffer.data(), drainBuffer.size()) == 0,
          "RS disabled visualization should drain no frames");

    fx.setVisualizationEnabled(true);
    auto output = renderEffectInBlocks(fx, input, mixedSchedule);
    CHECK(allSamplesFinite(output),
          "RS visualization-enabled processing should keep audio finite");

    const std::size_t bytes = fx.drainVizFrames(drainBuffer.data(), drainBuffer.size());
    CHECK(bytes >= sizeof(xleth::viz::ResonanceBucket),
          "RS enabled visualization should emit at least one bucket");
    CHECK(bytes % sizeof(xleth::viz::ResonanceBucket) == 0,
          "RS viz drain should return complete buckets");

    xleth::viz::ResonanceBucket bucket {};
    if (bytes >= sizeof(bucket))
        std::memcpy(&bucket, drainBuffer.data(), sizeof(bucket));

    CHECK(bucket.hdr.bucketSamples > 0,
          "RS viz bucket should report a non-zero sample span");
    CHECK(static_cast<int>(bucket.bucketCount) == static_cast<int>(xleth::viz::kResonanceVizBucketCount),
          "RS viz bucket count should match the documented schema");
    CHECK(bucket.sampleRate > 40000.0f && bucket.sampleRate < 50000.0f,
          "RS viz bucket should include sample rate metadata");
    CHECK(bucket.fftSize == 1024.0f,
          "RS viz bucket should include active FFT size metadata");
    CHECK(bucket.qualityIndex == 1.0f,
          "RS viz bucket should include active quality metadata");
    CHECK(bucket.maxReductionDb > 0.0f && bucket.maxReductionDb <= 24.0f,
          "RS viz bucket should include max reduction metadata");
    CHECK(bucket.activity >= 0.0f && bucket.activity <= 1.0f,
          "RS viz bucket activity should stay in [0,1]");

    float spectrumPeak = 0.0f;
    float reductionPeak = 0.0f;
    float weightingPeak = 0.0f;
    bool arraysFinite = true;
    bool arraysInRange = true;
    for (std::size_t i = 0; i < xleth::viz::kResonanceVizBucketCount; ++i)
    {
        const float spectrum = bucket.spectrum[i];
        const float reduction = bucket.reduction[i];
        const float weighting = bucket.weighting[i];
        arraysFinite = arraysFinite
                    && std::isfinite(spectrum)
                    && std::isfinite(reduction)
                    && std::isfinite(weighting);
        arraysInRange = arraysInRange
                     && spectrum >= 0.0f && spectrum <= 1.0f
                     && reduction >= 0.0f && reduction <= 1.0f
                     && weighting >= 0.0f && weighting <= 2.5f;
        spectrumPeak = std::max(spectrumPeak, spectrum);
        reductionPeak = std::max(reductionPeak, reduction);
        weightingPeak = std::max(weightingPeak, weighting);
    }

    std::cout << "    viz activity / spectrum peak / reduction peak / weighting peak: "
              << bucket.activity << " / " << spectrumPeak << " / "
              << reductionPeak << " / " << weightingPeak << "\n";

    CHECK(arraysFinite,
          "RS viz spectrum/reduction/weighting arrays should be finite");
    CHECK(arraysInRange,
          "RS viz spectrum/reduction/weighting arrays should stay within documented ranges");
    CHECK(spectrumPeak > 0.1f,
          "RS viz spectrum should show non-silent input activity");
    CHECK(reductionPeak > 0.001f || bucket.activity > 0.001f,
          "RS viz reduction data should show suppression activity on resonant input");
    CHECK(weightingPeak > 0.5f,
          "RS viz weighting curve should contain active sensitivity values");

    while (fx.drainVizFrames(drainBuffer.data(), drainBuffer.size()) > 0) {}
    fx.setVisualizationEnabled(false);
    auto outputDisabled = renderEffectInBlocks(fx, input, mixedSchedule);
    CHECK(allSamplesFinite(outputDisabled),
          "RS visualization-disabled processing should keep audio finite");
    CHECK(fx.drainVizFrames(drainBuffer.data(), drainBuffer.size()) == 0,
          "RS disabled visualization should emit no new frames after drain");
}

// ─── Resonance Suppressor: New High Quality engine (ResonanceCore) ──────────
//
// [RSCore] The opt-in hq_engine = New path: latency (reported == measured ==
// Core::latencyFor, constant through bypass / mix 0), quality changes as live
// tier requests, Mid / Side through the core's aux channel, structural
// transitions (fade-out, reset, fade-in: bounded steps, no comb), state round
// trips for both engines, old states restoring as Classic, the viz tap.

namespace rsnew
{
using Core = xleth::dsp::resonance::Core;

static void configureNew(XlethResonanceSuppressorEffect& fx, int quality, float depth)
{
    fx.setCoreInstanceIndex(0);
    fx.setParameterValue("processing_mode", 1.0f);
    fx.setParameterValue("hq_engine", 1.0f);
    fx.setParameterValue("quality", static_cast<float>(quality));
    fx.setParameterValue("depth", depth);
    fx.setParameterValue("mode", 1.0f);
}

// Stereo pink noise (Kellet) through an RBJ +12 dB / Q 8 bell at bellHz.
static void fillPinkBell(juce::AudioBuffer<float>& buf, double sr, float bellHz, float gain, std::uint32_t seed)
{
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        std::uint32_t lcg = seed ^ static_cast<std::uint32_t>(ch * 7919 + 1);
        float b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        juce::dsp::IIR::Filter<float> peak;
        peak.coefficients = juce::dsp::IIR::Coefficients<float>::makePeakFilter(
            sr, bellHz, 8.0f, juce::Decibels::decibelsToGain(12.0f));
        float* d = buf.getWritePointer(ch);
        for (int s = 0; s < buf.getNumSamples(); ++s)
        {
            lcg = lcg * 1664525u + 1013904223u;
            const float white = static_cast<float>((lcg >> 8) & 0x00ffffffu) / 8388608.0f - 1.0f;
            b0 = 0.99886f * b0 + white * 0.0555179f;
            b1 = 0.99332f * b1 + white * 0.0750759f;
            b2 = 0.96900f * b2 + white * 0.1538520f;
            b3 = 0.86650f * b3 + white * 0.3104856f;
            b4 = 0.55000f * b4 + white * 0.5329522f;
            b5 = -0.7616f * b5 - white * 0.0168980f;
            const float pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362f;
            b6 = white * 0.115926f;
            d[s] = peak.processSample(pink * gain);
        }
    }
}

static void fillWhite(juce::AudioBuffer<float>& buf, float amp, std::uint32_t seed)
{
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        std::uint32_t lcg = seed ^ static_cast<std::uint32_t>(ch * 104729 + 7);
        float* d = buf.getWritePointer(ch);
        for (int s = 0; s < buf.getNumSamples(); ++s)
        {
            lcg = lcg * 1664525u + 1013904223u;
            d[s] = amp * (static_cast<float>((lcg >> 8) & 0x00ffffffu) / 8388608.0f - 1.0f);
        }
    }
}

// Renders `input` in fixed blocks; before(pos) runs before each block (the
// "message thread" in a single-threaded test).
static juce::AudioBuffer<float> render(XlethResonanceSuppressorEffect& fx,
                                       const juce::AudioBuffer<float>& input,
                                       int block,
                                       const std::function<void(int)>& before = {})
{
    juce::AudioBuffer<float> out(input.getNumChannels(), input.getNumSamples());
    juce::MidiBuffer midi;
    for (int pos = 0; pos < input.getNumSamples(); pos += block)
    {
        if (before) before(pos);
        const int n = std::min(block, input.getNumSamples() - pos);
        juce::AudioBuffer<float> b(input.getNumChannels(), n);
        for (int ch = 0; ch < input.getNumChannels(); ++ch)
            b.copyFrom(ch, 0, input, ch, pos, n);
        fx.processBlock(b, midi);
        for (int ch = 0; ch < input.getNumChannels(); ++ch)
            out.copyFrom(ch, pos, b, ch, 0, n);
    }
    return out;
}

static int peakIndex(const juce::AudioBuffer<float>& b, int ch, float* peakOut = nullptr)
{
    int idx = -1;
    float peak = 0.0f;
    for (int s = 0; s < b.getNumSamples(); ++s)
        if (std::abs(b.getSample(ch, s)) > peak) { peak = std::abs(b.getSample(ch, s)); idx = s; }
    if (peakOut) *peakOut = peak;
    return idx;
}

static bool bitIdentical(const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b, int from = 0)
{
    if (a.getNumChannels() != b.getNumChannels() || a.getNumSamples() != b.getNumSamples())
        return false;
    for (int ch = 0; ch < a.getNumChannels(); ++ch)
        if (std::memcmp(a.getReadPointer(ch) + from, b.getReadPointer(ch) + from,
                        sizeof(float) * static_cast<std::size_t>(a.getNumSamples() - from)) != 0)
            return false;
    return true;
}

static std::string stateWithoutParam(XlethResonanceSuppressorEffect& fx, const char* id, juce::MemoryBlock& out)
{
    juce::MemoryBlock state;
    fx.getStateInformation(state);
    auto xml = juce::AudioProcessor::getXmlFromBinary(state.getData(), static_cast<int>(state.getSize()));
    if (xml == nullptr) return "no xml";
    for (auto* child = xml->getFirstChildElement(); child != nullptr; child = child->getNextElement())
    {
        if (child->hasTagName("PARAM") && child->getStringAttribute("id") == id)
        {
            xml->removeChildElement(child, true);
            break;
        }
    }
    juce::AudioProcessor::copyXmlToBinary(*xml, out);
    return {};
}
} // namespace rsnew

static void testResonanceSuppressorNewEngineLatency()
{
    using namespace rsnew;
    std::cout << "  [RSCore] new engine latency, bypass / mix 0, quality changes\n";

    // Reported == Core::latencyFor == measured impulse delay, every tier, two rates.
    for (double sr : { 48000.0, 96000.0 })
    {
        for (int q = 0; q < 3; ++q)
        {
            XlethResonanceSuppressorEffect fx;
            configureNew(fx, q, 0.0f);
            fx.prepareToPlay(sr, 256);
            const int expected = Core::latencyFor(sr, static_cast<Core::FrameTier>(q));
            juce::AudioBuffer<float> in(2, expected * 3 + 8192);
            in.clear();
            in.setSample(0, 4096, 1.0f);
            in.setSample(1, 4096, -0.75f);
            const auto out = render(fx, in, 256);
            float peak = 0.0f;
            const int idx = peakIndex(out, 0, &peak);
            std::cout << "    [RSCore] sr " << sr << " quality " << q << ": reported " << fx.getLatencySamples()
                      << ", latencyFor " << expected << ", measured " << (idx - 4096) << " (peak " << peak << ")\n";
            CHECK(fx.getLatencySamples() == expected, "[RSCore] reported latency == Core::latencyFor");
            CHECK(idx - 4096 == expected && peak > 0.99f, "[RSCore] measured impulse latency == Core::latencyFor");
        }
    }

    // Bypass and mix 0 keep the latency constant, and the output stays on it.
    {
        constexpr double kSR = 48000.0;
        XlethResonanceSuppressorEffect fx;
        configureNew(fx, 1, 100.0f);
        fx.prepareToPlay(kSR, 128);
        const int lat = fx.getLatencySamples();
        const auto notify0 = fx.getLatencyChangeNotifyCount();
        fx.setBypassed(true);
        const int latBypassed = fx.getLatencySamples();
        fx.setBypassed(false);
        fx.setParameterValue("mix", 0.0f);
        const int latMix0 = fx.getLatencySamples();
        fx.setParameterValue("delta", 1.0f);
        fx.setParameterValue("delta", 0.0f);
        fx.setParameterValue("mix", 100.0f);
        std::cout << "    [RSCore] latency active / bypassed / mix 0: " << lat << " / " << latBypassed << " / " << latMix0
                  << ", latency notifications " << (fx.getLatencyChangeNotifyCount() - notify0) << "\n";
        CHECK(lat == 1024 && latBypassed == lat && latMix0 == lat, "[RSCore] bypass and mix 0 keep the New engine latency");
        CHECK(fx.getLatencyChangeNotifyCount() == notify0, "[RSCore] bypass / mix toggles never retarget PDC");

        // Bypassed and mix-0 outputs are the ALIGNED dry: an impulse lands at +latency.
        for (int variant = 0; variant < 2; ++variant)
        {
            XlethResonanceSuppressorEffect f;
            configureNew(f, 1, 100.0f);
            if (variant == 1) f.setParameterValue("mix", 0.0f);
            f.prepareToPlay(kSR, 128);
            if (variant == 0) f.setBypassed(true);
            juce::AudioBuffer<float> in(2, 16384);
            in.clear();
            in.setSample(0, 8192, 0.9f);
            in.setSample(1, 8192, -0.9f);
            const auto out = render(f, in, 128);
            float peak = 0.0f;
            const int idx = peakIndex(out, 0, &peak);
            int above = 0;
            for (int s = 0; s < out.getNumSamples(); ++s)
                if (std::abs(out.getSample(0, s)) > 1.0e-4f) ++above;
            std::cout << "    [RSCore] " << (variant == 0 ? "bypassed" : "mix 0") << " impulse at +" << (idx - 8192)
                      << " peak " << peak << ", samples above 1e-4: " << above << "\n";
            CHECK(idx - 8192 == 1024 && std::abs(peak - 0.9f) < 1.0e-5f && above == 1,
                  "[RSCore] bypassed / mix 0 New output is the dry aligned to the constant latency");
        }
    }

    // Quality change: latency published at the request (message thread), the
    // core reaches it within its hold + crossfade, no reprepare, no allocation.
    {
        constexpr double kSR = 48000.0;
        XlethResonanceSuppressorEffect fx;
        configureNew(fx, 1, 0.0f);
        fx.prepareToPlay(kSR, 64);
        juce::AudioBuffer<float> sil(2, 64);
        juce::MidiBuffer midi;
        for (int i = 0; i < 100; ++i) { sil.clear(); fx.processBlock(sil, midi); }

        const std::array<int, 4> seq { 2, 0, 1, 2 };
        for (int q : seq)
        {
            fx.setParameterValue("quality", static_cast<float>(q));
            const int published = fx.getLatencySamples();
            const int expected = Core::latencyFor(kSR, static_cast<Core::FrameTier>(q));
            int samples = 0;
            while (fx.getCoreForTest().currentLatency() != expected && samples < 48000)
            {
                sil.clear();
                fx.processBlock(sil, midi);
                samples += 64;
            }
            std::cout << "    [RSCore] quality -> " << q << ": published " << published << " at the request, core on it after "
                      << samples << " samples (" << (1000.0 * samples / kSR) << " ms)\n";
            CHECK(published == expected, "[RSCore] quality change publishes Core::latencyFor at the request");
            const int hop = expected / 4;
            CHECK(samples <= 3 * hop + 240 + 64 + 64, "[RSCore] core reaches the published latency within hold + crossfade");
        }
        CHECK(fx.getCoreForTest().tierSwitchCount() == 4, "[RSCore] quality changes are live tier requests (4 adopted)");
        CHECK(fx.getStructureSwitchCount() == 0, "[RSCore] a New-engine quality change is not a structural transition");

        juce::AudioBuffer<float> in(2, 8192);
        in.clear();
        in.setSample(0, 1000, 1.0f);
        const auto out = render(fx, in, 64);
        float peak = 0.0f;
        const int idx = peakIndex(out, 0, &peak);
        CHECK(idx - 1000 == 2048 && peak > 0.99f, "[RSCore] impulse after quality changes lands at the new latency");
    }
}

static void testResonanceSuppressorNewEngineMidSide()
{
    using namespace rsnew;
    std::cout << "  [RSCore] new engine Mid / Side: untouched component\n";
    constexpr double kSR = 48000.0;
    constexpr int kN = 48000;

    juce::AudioBuffer<float> base(1, kN);
    fillPinkBell(base, kSR, 2500.0f, 0.05f, 0x1234u);

    for (int mode = 1; mode <= 2; ++mode)
    {
        for (float depth : { 0.0f, 100.0f })
        {
            // Mid mode gets pure side content, Side mode pure mid content: the
            // processed component is exactly zero, the other one passes through
            // the core's aux channel delay-only.
            juce::AudioBuffer<float> in(2, kN);
            for (int s = 0; s < kN; ++s)
            {
                const float v = base.getSample(0, s);
                in.setSample(0, s, v);
                in.setSample(1, s, mode == 1 ? -v : v);
            }
            XlethResonanceSuppressorEffect fx;
            configureNew(fx, 1, depth);
            fx.setParameterValue("stereo_mode", static_cast<float>(mode));
            fx.prepareToPlay(kSR, 100);
            const auto out = render(fx, in, 100);
            const int lat = fx.getLatencySamples();
            bool exact = true;
            for (int ch = 0; ch < 2 && exact; ++ch)
                for (int s = lat; s < kN; ++s)
                    if (std::memcmp(out.getReadPointer(ch) + s, in.getReadPointer(ch) + (s - lat), sizeof(float)) != 0)
                    { exact = false; break; }
            std::cout << "    [RSCore] " << (mode == 1 ? "Mid" : "Side") << " mode, depth " << depth
                      << ": untouched component bit-identical: " << exact << "\n";
            CHECK(exact, "[RSCore] Mid / Side leave the untouched component bit-identical (delayed)");
        }
    }

    // General material at depth 0: the untouched component of the output vs the
    // delayed input's (rounding of the M +- S recombination only).
    for (int mode = 1; mode <= 2; ++mode)
    {
        juce::AudioBuffer<float> in(2, kN);
        fillPinkBell(in, kSR, 1800.0f, 0.06f, 0x777u);
        XlethResonanceSuppressorEffect fx;
        configureNew(fx, 1, 0.0f);
        fx.setParameterValue("stereo_mode", static_cast<float>(mode));
        fx.prepareToPlay(kSR, 100);
        const auto out = render(fx, in, 100);
        const int lat = fx.getLatencySamples();
        double maxDiff = 0.0;
        for (int s = lat; s < kN; ++s)
        {
            const float l = out.getSample(0, s), r = out.getSample(1, s);
            const float li = in.getSample(0, s - lat), ri = in.getSample(1, s - lat);
            const float outComp = mode == 1 ? 0.5f * (l - r) : 0.5f * (l + r);
            const float inComp  = mode == 1 ? 0.5f * (li - ri) : 0.5f * (li + ri);
            maxDiff = std::max(maxDiff, static_cast<double>(std::abs(outComp - inComp)));
        }
        std::cout << "    [RSCore] " << (mode == 1 ? "Mid" : "Side") << " mode, general input, depth 0: max |untouched diff| "
                  << maxDiff << "\n";
        CHECK(maxDiff < 1.0e-6, "[RSCore] untouched component within float rounding on general input");
    }
}

// Steps, dip and comb checks of structural transitions (engine, processing
// mode, stereo mode) and of a New-engine tier change.
static void testResonanceSuppressorNewEngineTransitions()
{
    using namespace rsnew;
    std::cout << "  [RSCore] structural transitions\n";
    constexpr double kSR = 48000.0;
    constexpr int kBlock = 100;
    constexpr int kN = 48000 * 3;
    constexpr int kChange = 48000;

    struct Case { const char* name; std::function<void(XlethResonanceSuppressorEffect&)> from, to; };
    auto setStruct = [](int mode, int engine, int stereo) {
        return [=](XlethResonanceSuppressorEffect& fx) {
            fx.setParameterValue("processing_mode", static_cast<float>(mode));
            fx.setParameterValue("hq_engine", static_cast<float>(engine));
            fx.setParameterValue("stereo_mode", static_cast<float>(stereo));
        };
    };
    const std::vector<Case> cases {
        { "Classic -> New",      setStruct(1, 0, 0), setStruct(1, 1, 0) },
        { "New -> Classic",      setStruct(1, 1, 0), setStruct(1, 0, 0) },
        { "New -> Low Latency",  setStruct(1, 1, 0), setStruct(0, 1, 0) },
        { "Low Latency -> New",  setStruct(0, 1, 0), setStruct(1, 1, 0) },
        { "New Stereo -> Mid",   setStruct(1, 1, 0), setStruct(1, 1, 1) },
        { "New Mid -> Side",     setStruct(1, 1, 1), setStruct(1, 1, 2) },
        { "New Side -> Stereo",  setStruct(1, 1, 2), setStruct(1, 1, 0) },
        { "New quality N -> H",  setStruct(1, 1, 0), [](XlethResonanceSuppressorEffect& fx) { fx.setParameterValue("quality", 2.0f); } },
    };

    juce::AudioBuffer<float> pink(2, kN);
    fillPinkBell(pink, kSR, 2500.0f, 0.06f, 0xBEEFu);
    juce::AudioBuffer<float> sine(2, kN);
    for (int s = 0; s < kN; ++s)
    {
        const float v = 0.3f * std::sin(2.0f * juce::MathConstants<float>::pi * 1000.0f * static_cast<float>(s) / static_cast<float>(kSR));
        sine.setSample(0, s, v);
        sine.setSample(1, s, 0.8f * v);
    }

    for (const auto& c : cases)
    {
        for (int sig = 0; sig < 2; ++sig)
        {
            const auto& in = sig == 0 ? pink : sine;
            auto run = [&](bool change) {
                XlethResonanceSuppressorEffect fx;
                fx.setCoreInstanceIndex(0);
                fx.setParameterValue("depth", 100.0f);
                fx.setParameterValue("mode", 1.0f);
                c.from(fx);
                fx.prepareToPlay(kSR, kBlock);
                bool done = false;
                return render(fx, in, kBlock, [&](int pos) { if (change && !done && pos >= kChange) { c.to(fx); done = true; } });
            };
            const auto steady = run(false);
            const auto changed = run(true);
            // Steady reference: the largest step of the UNCHANGED run over the same
            // window and of a run of the target structure (after its warm-up).
            const float stepSteady = maxAdjacentStepInRange(steady, kChange - 4800, kChange + 9600);
            const float stepChanged = maxAdjacentStepInRange(changed, kChange - 4800, kChange + 9600);
            const float stepTargetLate = maxAdjacentStepInRange(changed, kChange + 24000, kChange + 48000);
            // The target engine starts from reset state, so a held resonance passes
            // unsuppressed until its detector engages again (tens of ms): the output
            // may rise to the INPUT's level, never step beyond it. A click is a step
            // larger than the larger of the input's own steps and the steady outputs'.
            const float stepInput = maxAdjacentStepInRange(in, kChange - 4800, kChange + 9600);
            const float stepOut = std::max(stepSteady, stepTargetLate);
            const float ref = std::max(stepOut, stepInput);
            const float ratio = ref > 0.0f ? stepChanged / ref : 0.0f;
            std::cout << "    [RSCore] " << c.name << " (" << (sig == 0 ? "pink+bell" : "1 kHz sine")
                      << "): max step " << stepChanged << " | steady out " << stepOut
                      << " (x" << (stepOut > 0.0f ? stepChanged / stepOut : 0.0f) << ") | input " << stepInput
                      << " | bound ratio " << ratio << "\n";
            CHECK(allSamplesFinite(changed), "[RSCore] transition output finite");
            CHECK(ratio <= 1.25f, std::string("[RSCore] transition step bounded: ") + c.name);
        }
    }

    // Dip duration: DC 0.5 at depth 0 (every engine passes it at unit gain).
    {
        juce::AudioBuffer<float> dc(2, kN);
        for (int ch = 0; ch < 2; ++ch)
            for (int s = 0; s < kN; ++s)
                dc.setSample(ch, s, 0.5f);
        for (const auto& c : cases)
        {
            XlethResonanceSuppressorEffect fx;
            fx.setCoreInstanceIndex(0);
            fx.setParameterValue("depth", 0.0f);
            c.from(fx);
            fx.prepareToPlay(kSR, kBlock);
            bool done = false;
            const auto out = render(fx, dc, kBlock, [&](int pos) { if (!done && pos >= kChange) { c.to(fx); done = true; } });
            int first = -1, last = -1, silent = 0;
            for (int s = kChange; s < kN; ++s)
            {
                const float v = out.getSample(0, s);
                if (std::abs(v - 0.5f) > 1.0e-3f) { if (first < 0) first = s; last = s; }
                if (std::abs(v) < 1.0e-6f) ++silent;
            }
            const double dipMs = first >= 0 ? 1000.0 * (last - first + 1) / kSR : 0.0;
            std::cout << "    [RSCore] dip " << c.name << ": " << dipMs << " ms (starts " << (first >= 0 ? first - kChange : -1)
                      << " samples after the request, silent " << (1000.0 * silent / kSR) << " ms), latency now "
                      << fx.getLatencySamples() << "\n";
            CHECK(allSamplesFinite(out), "[RSCore] dip run finite");
            CHECK(dipMs < 60.0, "[RSCore] structural dip shorter than fade + latency + fade");
        }
    }

    // No comb: depth 0, mix 50 % on white noise across Low Latency -> New (0 ->
    // 1024 samples). In every 64-sample window the output is explained by ONE
    // delay of the input (least squares on x[n] and x[n - 1024]): the dip
    // never mixes the two timelines.
    {
        juce::AudioBuffer<float> wn(2, kN);
        fillWhite(wn, 0.25f, 0x5151u);

        // Joint least squares y ~ a x[n] + b x[n - 1024] per 128-sample window;
        // the score is the share of the window's output energy carried by the
        // WEAKER delay. One delay (even with a gain ramp inside the window): a
        // few %. Both delays at once (a comb): about 50 %.
        struct CombScore { double worst = 0.0; int at = 0; double rms = 0.0; };
        auto combScore = [](const juce::AudioBuffer<float>& y, const juce::AudioBuffer<float>& x, int from, int to)
        {
            CombScore r;
            for (int w = from; w + 128 < to; w += 128)
            {
                double s00 = 0, s11 = 0, s01 = 0, r0 = 0, r1 = 0, yy = 0;
                for (int s = w; s < w + 128; ++s)
                {
                    const double v = y.getSample(0, s), x0 = x.getSample(0, s), x1 = x.getSample(0, s - 1024);
                    s00 += x0 * x0; s11 += x1 * x1; s01 += x0 * x1; r0 += x0 * v; r1 += x1 * v; yy += v * v;
                }
                if (yy < 1.0e-4) continue;   // silent part of the dip
                const double det = s00 * s11 - s01 * s01;
                const double a = (r0 * s11 - r1 * s01) / det;
                const double b = (r1 * s00 - r0 * s01) / det;
                const double share = std::min(a * a * s00, b * b * s11) / yy;
                if (share > r.worst) { r.worst = share; r.at = w; r.rms = std::sqrt(yy / 128.0); }
            }
            return r;
        };

        // Negative control: an actual comb (the two timelines summed) must score high.
        juce::AudioBuffer<float> comb(2, kN);
        comb.clear();
        for (int s = 1024; s < kN; ++s)
            comb.setSample(0, s, 0.5f * (wn.getSample(0, s) + wn.getSample(0, s - 1024)));
        const double combControl = combScore(comb, wn, kChange - 4096, kChange + 8192).worst;
        std::cout << "    [RSCore] comb check negative control (x[n] + x[n-1024]) / 2: " << combControl << "\n";
        CHECK(combControl > 0.3, "[RSCore] comb metric detects a real two-delay mix");
        for (int dir = 0; dir < 2; ++dir)
        {
            XlethResonanceSuppressorEffect fx;
            fx.setCoreInstanceIndex(0);
            fx.setParameterValue("depth", 0.0f);
            fx.setParameterValue("mix", 50.0f);
            setStruct(dir == 0 ? 0 : 1, 1, 0)(fx);
            fx.prepareToPlay(kSR, kBlock);
            bool done = false;
            const auto out = render(fx, wn, kBlock, [&](int pos) {
                if (!done && pos >= kChange) { setStruct(dir == 0 ? 1 : 0, 1, 0)(fx); done = true; } });
            const auto score = combScore(out, wn, kChange - 4096, kChange + 8192);
            std::cout << "    [RSCore] comb check " << (dir == 0 ? "LL -> New" : "New -> LL")
                      << ": worst share of the weaker delay in a 128-sample window " << score.worst
                      << " (at " << (score.at - kChange) << " samples, output rms " << score.rms << ")\n";
            CHECK(score.worst < 0.1, "[RSCore] transition never mixes the two latencies (no comb)");
        }
    }
}

static void testResonanceSuppressorNewEngineState()
{
    using namespace rsnew;
    std::cout << "  [RSCore] state round trip and legacy restore\n";
    constexpr double kSR = 48000.0;
    juce::AudioBuffer<float> in(2, 48000);
    fillPinkBell(in, kSR, 2500.0f, 0.06f, 0x4242u);

    auto configureRich = [](XlethResonanceSuppressorEffect& fx, int engine) {
        fx.setCoreInstanceIndex(0);
        fx.setParameterValue("processing_mode", 1.0f);
        fx.setParameterValue("hq_engine", static_cast<float>(engine));
        fx.setParameterValue("quality", 2.0f);
        fx.setParameterValue("depth", 73.0f);
        fx.setParameterValue("selectivity", 41.0f);
        fx.setParameterValue("sharpness", 62.0f);
        fx.setParameterValue("attack", 22.0f);
        fx.setParameterValue("release", 333.0f);
        fx.setParameterValue("stereo_link", 55.0f);
        fx.setParameterValue("mode", 1.0f);
        fx.setParameterValue("wc_b2_gain", 5.0f);
        fx.setParameterValue("wc_hp", 120.0f);
        fx.setParameterValue("mix", 80.0f);
    };

    for (int engine = 0; engine < 2; ++engine)
    {
        XlethResonanceSuppressorEffect a;
        configureRich(a, engine);
        juce::MemoryBlock state;
        a.getStateInformation(state);

        XlethResonanceSuppressorEffect b;
        b.setCoreInstanceIndex(0);
        b.setStateInformation(state.getData(), static_cast<int>(state.getSize()));
        bool paramsEqual = true;
        for (auto* p : a.getParameters())
        {
            auto* rp = dynamic_cast<juce::RangedAudioParameter*>(p);
            if (rp == nullptr) continue;
            const auto id = rp->paramID.toStdString();
            if (std::abs(a.getParameterValue(id) - b.getParameterValue(id)) > 1.0e-6f) paramsEqual = false;
        }
        a.prepareToPlay(kSR, 256);
        b.prepareToPlay(kSR, 256);
        const auto outA = render(a, in, 256);
        const auto outB = render(b, in, 256);
        std::cout << "    [RSCore] " << (engine == 0 ? "Classic" : "New") << " round trip: params equal " << paramsEqual
                  << ", output bit-identical " << bitIdentical(outA, outB) << ", hq_engine " << b.getParameterValue("hq_engine") << "\n";
        CHECK(paramsEqual, "[RSCore] state round trip restores every parameter");
        CHECK(std::abs(b.getParameterValue("hq_engine") - static_cast<float>(engine)) < 1.0e-6f, "[RSCore] hq_engine round-trips");
        CHECK(bitIdentical(outA, outB), "[RSCore] state round trip output bit-identical");
    }

    // An old state (no hq_engine element) restores as Classic, even into an
    // instance currently set to New, and sounds identical to the legacy output.
    {
        XlethResonanceSuppressorEffect legacy;
        configureRich(legacy, 0);
        juce::MemoryBlock oldState;
        const auto err = stateWithoutParam(legacy, "hq_engine", oldState);
        CHECK(err.empty(), "[RSCore] old-state blob built");

        XlethResonanceSuppressorEffect restored;
        restored.setCoreInstanceIndex(0);
        restored.setParameterValue("hq_engine", 1.0f);
        restored.setStateInformation(oldState.getData(), static_cast<int>(oldState.getSize()));
        CHECK(restored.getParameterValue("hq_engine") == 0.0f, "[RSCore] a state without hq_engine restores as Classic");

        legacy.prepareToPlay(kSR, 256);
        restored.prepareToPlay(kSR, 256);
        const auto outLegacy = render(legacy, in, 256);
        const auto outRestored = render(restored, in, 256);
        std::cout << "    [RSCore] old state into a New instance: hq_engine " << restored.getParameterValue("hq_engine")
                  << ", output bit-identical to the legacy instance " << bitIdentical(outLegacy, outRestored) << "\n";
        CHECK(bitIdentical(outLegacy, outRestored), "[RSCore] old-state restore sounds identical to the legacy output");

        // The same restore while running on the New engine: adopted at the next
        // block without a fade, from cleared state (as the old reprepare did).
        XlethResonanceSuppressorEffect live;
        configureRich(live, 1);
        live.prepareToPlay(kSR, 256);
        (void) render(live, in, 256);
        live.setStateInformation(oldState.getData(), static_cast<int>(oldState.getSize()));
        XlethResonanceSuppressorEffect fresh;
        configureRich(fresh, 0);
        fresh.prepareToPlay(kSR, 256);
        const auto outLive = render(live, in, 256);
        const auto outFresh = render(fresh, in, 256);
        std::cout << "    [RSCore] old state restored while running New: bit-identical to a fresh Classic instance "
                  << bitIdentical(outLive, outFresh) << ", structural fades " << live.getStructureSwitchCount() << "\n";
        CHECK(bitIdentical(outLive, outFresh), "[RSCore] live restore of an old state = fresh Classic output");
        CHECK(live.getStructureSwitchCount() == 0, "[RSCore] a state restore snaps (no fade)");
    }
}

static void testResonanceSuppressorNewEngineVizAndMeters()
{
    using namespace rsnew;
    std::cout << "  [RSCore] new engine viz (schema v3) and meters\n";
    constexpr double kSR = 48000.0;
    XlethResonanceSuppressorEffect fx;
    configureNew(fx, 1, 100.0f);
    fx.prepareToPlay(kSR, 128);
    fx.setVisualizationEnabled(true);
    juce::AudioBuffer<float> in(2, 48000 * 2);
    fillPinkBell(in, kSR, 2500.0f, 0.06f, 0x9999u);
    juce::MidiBuffer midi;
    float meter2 = 0.0f, meter3 = 0.0f;
    std::vector<std::uint8_t> drain(sizeof(xleth::viz::ResonanceBucket) * 2048);
    std::size_t buckets = 0;
    xleth::viz::ResonanceBucket last {};
    for (int pos = 0; pos + 128 <= in.getNumSamples(); pos += 128)
    {
        juce::AudioBuffer<float> b(2, 128);
        for (int ch = 0; ch < 2; ++ch) b.copyFrom(ch, 0, in, ch, pos, 128);
        fx.processBlock(b, midi);
        meter2 = std::max(meter2, fx.readMeterValue(2));
        meter3 = std::max(meter3, fx.readMeterValue(3));
        const std::size_t bytes = fx.drainVizFrames(drain.data(), drain.size());
        if (bytes >= sizeof(last))
            std::memcpy(&last, drain.data() + bytes - sizeof(last), sizeof(last));
        buckets += bytes / sizeof(xleth::viz::ResonanceBucket);
    }
    const auto& core = fx.getCoreForTest();
    std::cout << "    [RSCore] buckets " << buckets << " (frames per channel " << core.framesProcessed() << "), fft "
              << last.fftSize << ", quality " << last.qualityIndex << ", activity " << last.activity
              << ", meter2 peak " << meter2 << ", meter3 (max band cut dB) peak " << meter3 << "\n";
    CHECK(fx.getVisualizationSchemaVersion() == 3, "[RSCore] viz schema stays v3");
    CHECK(static_cast<long long>(buckets) == 2 * core.framesProcessed(), "[RSCore] one bucket per hop and channel");
    CHECK(last.fftSize == 1024.0f && last.qualityIndex == 1.0f && last.hdr.bucketSamples == 256u, "[RSCore] bucket metadata = the tier in use");
    CHECK(static_cast<int>(last.bucketCount) == 128, "[RSCore] 128 buckets");

    // Bucket i is centred at 20 Hz x 1000^(i / 127).
    auto bucketAt = [](float hz) {
        return std::clamp(static_cast<int>(std::lround(127.0 * std::log(hz / 20.0) / std::log(1000.0))), 0, 127);
    };
    bool inRange = true;
    for (std::size_t i = 0; i < 128; ++i)
        inRange = inRange && last.spectrum[i] >= 0.0f && last.spectrum[i] <= 1.0f
               && last.reduction[i] >= 0.0f && last.reduction[i] <= 1.0f
               && last.weighting[i] >= 0.0f && last.weighting[i] <= 2.5f;
    const int b25 = bucketAt(25.0f), b1k = bucketAt(1000.0f), b2k5 = bucketAt(2500.0f), b20k = bucketAt(19500.0f), b300 = bucketAt(300.0f);
    std::cout << "    [RSCore] weighting 25 Hz / 1 kHz / 19.5 kHz: " << last.weighting[b25] << " / " << last.weighting[b1k]
              << " / " << last.weighting[b20k] << "; reduction 2.5 kHz / 300 Hz: " << last.reduction[b2k5] * 24.0f
              << " / " << last.reduction[b300] * 24.0f << " dB; spectrum 1 kHz " << last.spectrum[b1k] << "\n";
    CHECK(inRange, "[RSCore] bucket arrays in their documented ranges");
    CHECK(last.weighting[b25] == 0.0f && std::abs(last.weighting[b1k] - 1.0f) < 1.0e-6f && last.weighting[b20k] < 0.5f,
          "[RSCore] viz weighting is the RS default focus curve (0 below 40 Hz, 1 mid, ramp down above 16 kHz)");
    CHECK(last.reduction[b2k5] * 24.0f > 3.0f && last.reduction[b2k5] > last.reduction[b300], "[RSCore] viz reduction shows the cut at the bell");
    CHECK(last.spectrum[b1k] > 0.1f, "[RSCore] viz spectrum shows the input");
    CHECK(meter2 > 0.05f && meter3 > 3.0f, "[RSCore] meters: activity slot 2 and max band cut slot 3 rise");

    // The weight curve the core receives is the RS default on its band grid.
    const float* w = fx.getCoreWeightCurveForTest();
    int zeroLow = 0, unity = 0;
    float top = 1.0f;
    for (int b = 0; b < core.numBands(); ++b)
    {
        const float hz = core.bandCentreHz(b);
        if (hz < 40.0f && w[b] == 0.0f) ++zeroLow;
        if (hz > 200.0f && hz < 12000.0f && std::abs(w[b] - 1.0f) < 1.0e-6f) ++unity;
        if (hz > 18000.0f) top = std::min(top, w[b]);
    }
    int lowBands = 0, midBands = 0;
    for (int b = 0; b < core.numBands(); ++b)
    {
        if (core.bandCentreHz(b) < 40.0f) ++lowBands;
        if (core.bandCentreHz(b) > 200.0f && core.bandCentreHz(b) < 12000.0f) ++midBands;
    }
    std::cout << "    [RSCore] core weight curve: " << zeroLow << "/" << lowBands << " bands below 40 Hz at 0, "
              << unity << "/" << midBands << " bands 200 Hz-12 kHz at 1, min above 18 kHz " << top << "\n";
    CHECK(zeroLow == lowBands && unity == midBands && top < 0.5f, "[RSCore] the core gets the RS default (non-flat) focus curve");
    fx.setVisualizationEnabled(false);

    // Display calibration: white noise of RMS r reads 20 log10(r) dBFS in the
    // 1 kHz bucket, at every tier (averaged over the last second of buckets).
    const float amp = 0.2f;
    const double rmsDb = 20.0 * std::log10(amp / std::sqrt(3.0));
    for (int q = 0; q < 3; ++q)
    {
        XlethResonanceSuppressorEffect w;
        configureNew(w, q, 0.0f);
        w.prepareToPlay(kSR, 256);
        w.setVisualizationEnabled(true);
        juce::AudioBuffer<float> wn(2, 48000 * 2);
        fillWhite(wn, amp, 0xC0FFEEu + static_cast<std::uint32_t>(q));
        double sum = 0.0;
        int count = 0;
        std::vector<std::uint8_t> buf(sizeof(xleth::viz::ResonanceBucket) * 512);
        for (int pos = 0; pos + 256 <= wn.getNumSamples(); pos += 256)
        {
            juce::AudioBuffer<float> b(2, 256);
            for (int ch = 0; ch < 2; ++ch) b.copyFrom(ch, 0, wn, ch, pos, 256);
            w.processBlock(b, midi);
            const std::size_t bytes = w.drainVizFrames(buf.data(), buf.size());
            if (pos < 48000) continue;
            for (std::size_t off = 0; off + sizeof(xleth::viz::ResonanceBucket) <= bytes; off += sizeof(xleth::viz::ResonanceBucket))
            {
                xleth::viz::ResonanceBucket bk {};
                std::memcpy(&bk, buf.data() + off, sizeof(bk));
                sum += bk.spectrum[b1k] * 120.0 - 120.0;
                ++count;
            }
        }
        const double readDb = count > 0 ? sum / count : -999.0;
        std::cout << "    [RSCore] display calibration quality " << q << ": white noise RMS " << rmsDb
                  << " dBFS reads " << readDb << " dB in the 1 kHz bucket\n";
        CHECK(std::abs(readDb - rmsDb) < 1.5, "[RSCore] viz spectrum calibrated (white noise RMS in the 1 kHz bucket, every tier)");
    }
}

// ─── Delay stereo_mode Tests ────────────────────────────────────────────────
//
// stereo_mode (0=Single, 1=Dual, 2=PingPong) selects how the two delay lines
// relate. These tests drive an impulse through a fully-wet delay and assert
// WHERE the echoes land per mode, which is the observable contract the UI and
// existing projects depend on.

namespace delaytest {

constexpr double kSr    = 48000.0;
constexpr int    kBlock = 512;

// Configures a delay for impulse measurement: fully wet, no modulation, no
// ducking, filters wide open. Params are set BEFORE prepare so the cascaded
// delay-time smoother initialises at the right value.
static void configureDelay(XlethDelayEffect& fx, float stereoMode,
                           float timeL, float timeR, float widthPct)
{
    fx.setParameterValue("stereo_mode",  stereoMode);
    fx.setParameterValue("time_l",       timeL);
    fx.setParameterValue("time_r",       timeR);
    fx.setParameterValue("stereo_width", widthPct);
    fx.setParameterValue("sync",         0.0f);
    fx.setParameterValue("mix",          100.0f);
    fx.setParameterValue("feedback",     60.0f);
    fx.setParameterValue("mod_depth",    0.0f);
    fx.setParameterValue("duck_amount",  0.0f);
    fx.setParameterValue("filter_lo",    20.0f);
    fx.setParameterValue("filter_hi",    20000.0f);
}

// Runs `ms` of silence so every smoother (delay time, mix, width, feedback)
// reaches its target before the impulse is measured.
static void preRoll(XlethDelayEffect& fx, double ms)
{
    juce::AudioBuffer<float> buf(2, kBlock);
    juce::MidiBuffer midi;
    const int blocks = static_cast<int>((ms * 0.001 * kSr) / kBlock) + 1;
    for (int b = 0; b < blocks; ++b)
    {
        buf.clear();
        fx.processBlock(buf, midi);
    }
}

// Sends a single-sample impulse on both channels, then captures `ms` of the
// resulting tail into `outL` / `outR`.
static void captureImpulseResponse(XlethDelayEffect& fx, double ms,
                                   std::vector<float>& outL,
                                   std::vector<float>& outR)
{
    const int total = static_cast<int>(ms * 0.001 * kSr);
    outL.clear(); outR.clear();
    outL.reserve(static_cast<std::size_t>(total));
    outR.reserve(static_cast<std::size_t>(total));

    juce::AudioBuffer<float> buf(2, kBlock);
    juce::MidiBuffer midi;
    bool impulseSent = false;

    while (static_cast<int>(outL.size()) < total)
    {
        buf.clear();
        if (!impulseSent) { buf.setSample(0, 0, 1.0f); buf.setSample(1, 0, 1.0f); impulseSent = true; }
        fx.processBlock(buf, midi);
        for (int s = 0; s < kBlock && static_cast<int>(outL.size()) < total; ++s)
        {
            outL.push_back(buf.getSample(0, s));
            outR.push_back(buf.getSample(1, s));
        }
    }
}

// Peak |x| inside a millisecond window — the echo detector.
static float peakInWindow(const std::vector<float>& sig, double startMs, double endMs)
{
    const int a = std::max(0, static_cast<int>(startMs * 0.001 * kSr));
    const int b = std::min(static_cast<int>(sig.size()), static_cast<int>(endMs * 0.001 * kSr));
    float peak = 0.0f;
    for (int i = a; i < b; ++i) peak = std::max(peak, std::abs(sig[i]));
    return peak;
}

// Summed energy inside a millisecond window.
//
// Used instead of peak height when comparing the two lanes' LEVELS. The delay
// time smoother is a one-pole in float: it stops converging once c*(target-x)
// falls below the ULP of x, which at a 200 ms target parks a lane that started
// far away (time_r) a few samples off one that started on target (time_l).
// That is pre-existing engine behaviour; energy over a window is insensitive to
// it, whereas an interpolated impulse's peak height is not.
static double energyInWindow(const std::vector<float>& sig, double startMs, double endMs)
{
    const int a = std::max(0, static_cast<int>(startMs * 0.001 * kSr));
    const int b = std::min(static_cast<int>(sig.size()), static_cast<int>(endMs * 0.001 * kSr));
    double e = 0.0;
    for (int i = a; i < b; ++i) e += static_cast<double>(sig[i]) * sig[i];
    return e;
}

} // namespace delaytest

static void testDelayStereoModeParameter()
{
    std::cout << "  [Delay stereo_mode parameter]\n";
    XlethDelayEffect fx;

    const auto j = nlohmann::json::parse(fx.getParametersAsJSON());
    CHECK(j.is_array(), "Delay getParametersAsJSON should return an array");

    bool found = false;
    for (const auto& p : j)
    {
        if (p.value("id", std::string()) != "stereo_mode") continue;
        found = true;
        CHECK_NEAR(p.value("min", -1.0f),     0.0f, 1e-6, "stereo_mode min should be 0");
        CHECK_NEAR(p.value("max", -1.0f),     2.0f, 1e-6, "stereo_mode max should be 2");
        CHECK_NEAR(p.value("default", -1.0f), 1.0f, 1e-6, "stereo_mode default should be 1 (Dual)");
        CHECK_NEAR(p.value("value", -1.0f),   1.0f, 1e-6, "fresh Delay should read stereo_mode = Dual");
    }
    CHECK(found, "stereo_mode should surface through getParametersAsJSON");

    // Round-trip every legal value through the same setter the bridge calls.
    for (float mode : {0.0f, 2.0f, 1.0f})
    {
        CHECK(fx.setParameterValue("stereo_mode", mode),
              "setParameterValue(stereo_mode) should return true");
        CHECK_NEAR(fx.getParameterValue("stereo_mode"), mode, 1e-4,
                   "stereo_mode should round-trip through the param system");
    }

    // APVTS XML round-trip — the path project save/load uses.
    fx.setParameterValue("stereo_mode", 2.0f);
    juce::MemoryBlock state;
    fx.getStateInformation(state);
    XlethDelayEffect restored;
    restored.setStateInformation(state.getData(), static_cast<int>(state.getSize()));
    CHECK_NEAR(restored.getParameterValue("stereo_mode"), 2.0f, 1e-4,
               "stereo_mode should survive a getState/setState round-trip");
}

static void testDelayStereoModeDual()
{
    std::cout << "  [Delay stereo_mode: Dual keeps L/R independent]\n";
    using namespace delaytest;

    XlethDelayEffect fx;
    // width 0 => no cross-feed, so each lane is purely its own time.
    configureDelay(fx, 1.0f, 100.0f, 250.0f, 0.0f);
    fx.prepareToPlay(kSr, kBlock);
    preRoll(fx, 1200.0);

    std::vector<float> l, r;
    captureImpulseResponse(fx, 600.0, l, r);

    const float lAt100 = peakInWindow(l,  85.0, 115.0);
    const float rAt250 = peakInWindow(r, 235.0, 265.0);
    const float rAt100 = peakInWindow(r,  85.0, 115.0);
    const float lAt250 = peakInWindow(l, 235.0, 265.0);

    CHECK(lAt100 > 0.3f, "Dual: L echo should land at time_l (100 ms)");
    CHECK(rAt250 > 0.3f, "Dual: R echo should land at time_r (250 ms)");
    CHECK(rAt100 < 0.05f, "Dual with width=0: R should be silent at time_l");
    CHECK(lAt250 < 0.05f, "Dual with width=0: L should be silent at time_r");
}

static void testDelayStereoModeSingle()
{
    std::cout << "  [Delay stereo_mode: Single spreads one time]\n";
    using namespace delaytest;

    // width 50 % => spread 100 ms total => L = 150 ms, R = 250 ms around t=200.
    XlethDelayEffect fx;
    configureDelay(fx, 0.0f, 200.0f, 999.0f, 50.0f);
    fx.prepareToPlay(kSr, kBlock);
    preRoll(fx, 1500.0);

    std::vector<float> l, r;
    captureImpulseResponse(fx, 600.0, l, r);

    CHECK(peakInWindow(l, 135.0, 165.0) > 0.3f,
          "Single: L echo should sit half a spread EARLY (150 ms)");
    CHECK(peakInWindow(r, 235.0, 265.0) > 0.3f,
          "Single: R echo should sit half a spread LATE (250 ms)");
    CHECK(peakInWindow(l, 985.0, 1015.0) < 0.05f,
          "Single: time_r must be ignored (no echo at 999 ms)");

    // Zero spread collapses both lanes onto the same instant.
    XlethDelayEffect flat;
    configureDelay(flat, 0.0f, 200.0f, 999.0f, 0.0f);
    flat.prepareToPlay(kSr, kBlock);
    preRoll(flat, 1500.0);

    std::vector<float> fl, fr;
    captureImpulseResponse(flat, 600.0, fl, fr);
    CHECK(peakInWindow(fl, 185.0, 215.0) > 0.3f && peakInWindow(fr, 185.0, 215.0) > 0.3f,
          "Single at width=0: both lanes should echo at the single time (200 ms)");
    CHECK(peakInWindow(fl, 130.0, 175.0) < 0.05f && peakInWindow(fr, 225.0, 270.0) < 0.05f,
          "Single at width=0: the spread should collapse (nothing at 150 / 250 ms)");

    // Level match, measured as window energy — see energyInWindow() for why the
    // peak is the wrong statistic here.
    const double flE = energyInWindow(fl, 185.0, 215.0);
    const double frE = energyInWindow(fr, 185.0, 215.0);
    CHECK(flE > 0.0 && frE > 0.0 && std::max(flE, frE) / std::min(flE, frE) < 1.5,
          "Single at width=0: both lanes should carry comparable energy");
}

static void testDelayStereoModePingPong()
{
    std::cout << "  [Delay stereo_mode: PingPong alternates lanes]\n";
    using namespace delaytest;

    XlethDelayEffect fx;
    // width 50 => wet mid/side left unaltered, so the alternation is unmasked.
    configureDelay(fx, 2.0f, 120.0f, 999.0f, 50.0f);
    fx.prepareToPlay(kSr, kBlock);
    preRoll(fx, 1500.0);

    std::vector<float> l, r;
    captureImpulseResponse(fx, 700.0, l, r);

    const float lFirst  = peakInWindow(l, 105.0, 135.0);   // 1st repeat  → L
    const float rFirst  = peakInWindow(r, 105.0, 135.0);   // silent      → R
    const float rSecond = peakInWindow(r, 225.0, 255.0);   // 2nd repeat  → R
    const float lSecond = peakInWindow(l, 225.0, 255.0);   // silent      → L
    const float lThird  = peakInWindow(l, 345.0, 375.0);   // 3rd repeat  → L

    CHECK(lFirst  > 0.3f,  "PingPong: 1st repeat should be on L");
    CHECK(rFirst  < 0.05f, "PingPong: R should be silent on the 1st repeat");
    CHECK(rSecond > 0.1f,  "PingPong: 2nd repeat should hand off to R");
    CHECK(lSecond < 0.05f, "PingPong: L should be silent on the 2nd repeat");
    CHECK(lThird  > 0.03f, "PingPong: 3rd repeat should return to L");
    CHECK(peakInWindow(r, 985.0, 1015.0) < 0.05f,
          "PingPong: time_r must be ignored (no echo at 999 ms)");
}

static void testEQLayout()
{
    std::cout << "  [EQ layout]\n";
    XlethParametricEQ eq;

    CHECK(eq.getBandCount() == 0, "EQ should start with 0 bands");

    // 16 per band × 16 bands + 2 global.  Per band: freq, gain, q, type,
    // enabled, channel, mode, dyn_{thresh,ratio,attack,release,range},
    // spec_{sens,sel,attack,release}.  Spectral depth is the band's own gain
    // knob, so there is no spec_depth parameter.
    const auto& params = eq.getParameters();
    CHECK(static_cast<int>(params.size()) == 258, "EQ should have 258 APVTS params");
}

static void testEQAddRemove()
{
    std::cout << "  [EQ add/remove]\n";
    XlethParametricEQ eq;
    eq.prepareToPlay(44100.0, 512);

    int idx = eq.addBand();
    CHECK(idx == 0, "first band index should be 0");
    CHECK(eq.getBandCount() == 1, "band count should be 1 after add");

    int idx2 = eq.addBand();
    CHECK(idx2 == 1, "second band index should be 1");
    CHECK(eq.getBandCount() == 2, "band count should be 2");

    CHECK(eq.removeBand(0), "removeBand(0) should succeed");
    CHECK(eq.getBandCount() == 1, "band count should be 1 after remove");

    CHECK(eq.removeBand(0), "removeBand(0) should succeed again");
    CHECK(eq.getBandCount() == 0, "band count should be 0");

    CHECK(!eq.removeBand(0), "removeBand on empty should fail");
}

static void testEQBellFilter()
{
    std::cout << "  [EQ bell filter]\n";
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 1024;

    XlethParametricEQ eq;
    eq.prepareToPlay(kSR, kBS);

    int b = eq.addBand();
    eq.setBandParam(b, "freq",  1000.0f);
    eq.setBandParam(b, "gain",  12.0f);  // +12 dB boost
    eq.setBandParam(b, "q",     1.0f);
    eq.setBandParam(b, "type",  0.0f);   // Bell
    eq.setBandParam(b, "enabled", 1.0f);

    // Generate 1 kHz sine
    juce::AudioBuffer<float> buf(2, kBS);
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;
    for (int s = 0; s < kBS; ++s)
    {
        float v = std::sin(pi2 * 1000.0f * static_cast<float>(s) / static_cast<float>(kSR));
        buf.setSample(0, s, v);
        buf.setSample(1, s, v);
    }

    float inputPeak = buf.getMagnitude(0, 0, kBS);

    juce::MidiBuffer midi;
    // Process a few blocks to let smoothers settle
    eq.processBlock(buf, midi);
    // Refill and process again for settled coefficients
    for (int s = 0; s < kBS; ++s)
    {
        float v = std::sin(pi2 * 1000.0f * static_cast<float>(s) / static_cast<float>(kSR));
        buf.setSample(0, s, v);
        buf.setSample(1, s, v);
    }
    eq.processBlock(buf, midi);

    float outputPeak = buf.getMagnitude(0, 0, kBS);
    CHECK(outputPeak > inputPeak * 2.0f,
          "EQ +12dB bell at 1kHz should boost 1kHz signal significantly");
}

static void testEQResponseCurve()
{
    std::cout << "  [EQ response curve]\n";
    XlethParametricEQ eq;
    eq.prepareToPlay(44100.0, 512);

    int b = eq.addBand();
    eq.setBandParam(b, "freq",  1000.0f);
    eq.setBandParam(b, "gain",  12.0f);
    eq.setBandParam(b, "q",     1.0f);
    eq.setBandParam(b, "type",  0.0f);
    eq.setBandParam(b, "enabled", 1.0f);

    // Process several blocks so smoothers settle (20ms gain ramp @ 44100 = 882 samples)
    juce::AudioBuffer<float> buf(2, 512);
    juce::MidiBuffer midi;
    for (int i = 0; i < 4; ++i)
    {
        fillBuffer(buf, 0.0f);
        eq.processBlock(buf, midi);
    }

    float response[XlethParametricEQ::kResponseSize];
    eq.getResponseCurve(response, XlethParametricEQ::kResponseSize);

    // Find the peak in the response curve
    float maxDb = -999.0f;
    int maxBin = 0;
    for (int i = 0; i < XlethParametricEQ::kResponseSize; ++i)
    {
        if (response[i] > maxDb)
        {
            maxDb = response[i];
            maxBin = i;
        }
    }

    // Peak should be near +12 dB
    CHECK(maxDb > 10.0f, "response curve peak should be > 10 dB");
    CHECK(maxDb < 14.0f, "response curve peak should be < 14 dB");

    // 1 kHz at log scale in [20, 20000] → t = log(1000/20) / log(20000/20) ≈ 0.565
    // bin ≈ 0.565 * 511 ≈ 289
    CHECK(maxBin > 250 && maxBin < 330,
          "response curve peak should be near bin ~289 (1 kHz)");
}

static void testEQBypassBand()
{
    std::cout << "  [EQ bypass band]\n";
    XlethParametricEQ eq;
    eq.prepareToPlay(44100.0, 512);

    int b = eq.addBand();
    eq.setBandParam(b, "freq",    1000.0f);
    eq.setBandParam(b, "gain",    12.0f);
    eq.setBandParam(b, "enabled", 0.0f); // disabled

    // Process one block to set coefficients
    juce::AudioBuffer<float> buf(2, 512);
    juce::MidiBuffer midi;
    fillBuffer(buf, 0.0f);
    eq.processBlock(buf, midi);

    // Check response: disabled band should give flat response
    float response[XlethParametricEQ::kResponseSize];
    eq.getResponseCurve(response, XlethParametricEQ::kResponseSize);

    // All values should be ~0 dB (flat)
    float maxAbs = 0.0f;
    for (int i = 0; i < XlethParametricEQ::kResponseSize; ++i)
        maxAbs = std::max(maxAbs, std::abs(response[i]));

    CHECK(maxAbs < 0.1f, "disabled band should give flat response (< 0.1 dB deviation)");
}

static void testEQSerialization()
{
    std::cout << "  [EQ serialization]\n";
    XlethParametricEQ src;
    src.prepareToPlay(44100.0, 512);

    src.addBand();
    src.setBandParam(0, "freq", 2000.0f);
    src.setBandParam(0, "gain", 6.0f);
    src.setBandParam(0, "q",    2.0f);

    src.addBand();
    src.setBandParam(1, "freq", 500.0f);
    src.setBandParam(1, "gain", -3.0f);

    juce::MemoryBlock state;
    src.getStateInformation(state);
    CHECK(state.getSize() > 0, "EQ serialised state should be non-empty");

    // Restore into fresh instance
    XlethParametricEQ dst;
    dst.prepareToPlay(44100.0, 512);
    dst.setStateInformation(state.getData(), static_cast<int>(state.getSize()));

    // Verify params restored (APVTS params are always present for all 16 bands;
    // bandCount_ is not serialized — the caller reconstructs it from which
    // bands have non-default values. Here we just check param values.)
    auto* freqParam = dst.getParameters()[0]; // b0_freq
    auto* rp = dynamic_cast<juce::RangedAudioParameter*>(freqParam);
    CHECK(rp != nullptr, "restored param should be RangedAudioParameter");
    if (rp)
    {
        float restored = rp->convertFrom0to1(rp->getValue());
        CHECK_NEAR(restored, 2000.0f, 50.0f, "restored b0 freq should be ≈ 2000");
    }
}

// ─── EQ per-band channel routing (Stereo / Left / Right / Mid / Side) ───────

// Drives a 1 kHz sine through a single +12 dB bell band routed to `channel`
// and returns the settled (L, R) output magnitudes.
//
// `lGain`/`rGain` scale the sine fed to each channel so M/S routing can be
// exercised with genuinely correlated / anti-correlated content.
static void runEQRoutedBell(int channel, float lGain, float rGain,
                            float& outL, float& outR)
{
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 1024;
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;

    XlethParametricEQ eq;
    eq.prepareToPlay(kSR, kBS);

    int b = eq.addBand();
    eq.setBandParam(b, "freq",    1000.0f);
    eq.setBandParam(b, "gain",    12.0f);
    eq.setBandParam(b, "q",       1.0f);
    eq.setBandParam(b, "type",    0.0f);   // Bell
    eq.setBandParam(b, "enabled", 1.0f);
    eq.setBandParam(b, "channel", static_cast<float>(channel));

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;

    // Several blocks so the freq/gain/Q smoothers settle.
    for (int blk = 0; blk < 6; ++blk)
    {
        for (int s = 0; s < kBS; ++s)
        {
            const float v = std::sin(pi2 * 1000.0f
                * static_cast<float>(blk * kBS + s) / static_cast<float>(kSR));
            buf.setSample(0, s, v * lGain);
            buf.setSample(1, s, v * rGain);
        }
        eq.processBlock(buf, midi);
    }

    outL = buf.getMagnitude(0, 0, kBS);
    outR = buf.getMagnitude(1, 0, kBS);
}

static void testEQChannelRoutingDefault()
{
    std::cout << "  [EQ routing: default is Stereo]\n";
    XlethParametricEQ eq;
    eq.prepareToPlay(44100.0, 512);

    eq.addBand();
    auto bands = nlohmann::json::parse(eq.getBandsAsJSON());
    CHECK(bands.is_array() && bands.size() == 1, "getBandsAsJSON should report 1 band");
    CHECK(bands[0].contains("channel"), "band JSON should expose a channel field");
    CHECK(bands[0]["channel"].get<int>() == 0, "a new band should default to Stereo (0)");

    // Round-trips through the same generic path the N-API handler uses.
    CHECK(eq.setBandParam(0, "channel", 4.0f), "setBandParam(\"channel\", 4) should succeed");
    bands = nlohmann::json::parse(eq.getBandsAsJSON());
    CHECK(bands[0]["channel"].get<int>() == 4, "channel should read back as Side (4)");
}

static void testEQChannelRoutingLeftRight()
{
    std::cout << "  [EQ routing: Left / Right]\n";

    float refL = 0.0f, refR = 0.0f;
    runEQRoutedBell(0, 1.0f, 1.0f, refL, refR);   // Stereo baseline
    CHECK(refL > 1.5f && refR > 1.5f, "Stereo routing should boost both channels");
    CHECK_NEAR(refL, refR, 0.01f, "Stereo routing should treat L and R identically");

    float l = 0.0f, r = 0.0f;
    runEQRoutedBell(1, 1.0f, 1.0f, l, r);         // Left
    CHECK_NEAR(l, refL, 0.02f, "Left routing should boost L exactly like Stereo does");
    CHECK_NEAR(r, 1.0f, 0.02f, "Left routing must leave R untouched (unity)");

    runEQRoutedBell(2, 1.0f, 1.0f, l, r);         // Right
    CHECK_NEAR(l, 1.0f, 0.02f, "Right routing must leave L untouched (unity)");
    CHECK_NEAR(r, refR, 0.02f, "Right routing should boost R exactly like Stereo does");
}

static void testEQChannelRoutingMidSide()
{
    std::cout << "  [EQ routing: Mid / Side]\n";

    float refL = 0.0f, refR = 0.0f;
    runEQRoutedBell(0, 1.0f, 1.0f, refL, refR);   // Stereo baseline, boost factor

    // Fully correlated content: S == 0, so a Mid band sees the whole signal
    // (behaves like Stereo) and a Side band has nothing to work on.
    float l = 0.0f, r = 0.0f;
    runEQRoutedBell(3, 1.0f, 1.0f, l, r);         // Mid on mono-in-stereo
    CHECK_NEAR(l, refL, 0.02f, "Mid routing on correlated content should match Stereo (L)");
    CHECK_NEAR(r, refR, 0.02f, "Mid routing on correlated content should match Stereo (R)");

    runEQRoutedBell(4, 1.0f, 1.0f, l, r);         // Side on mono-in-stereo
    CHECK_NEAR(l, 1.0f, 0.02f, "Side routing on correlated content must pass L through");
    CHECK_NEAR(r, 1.0f, 0.02f, "Side routing on correlated content must pass R through");

    // Fully anti-correlated content: M == 0, so the roles swap.
    runEQRoutedBell(3, 1.0f, -1.0f, l, r);        // Mid on anti-correlated
    CHECK_NEAR(l, 1.0f, 0.02f, "Mid routing on anti-correlated content must pass L through");
    CHECK_NEAR(r, 1.0f, 0.02f, "Mid routing on anti-correlated content must pass R through");

    runEQRoutedBell(4, 1.0f, -1.0f, l, r);        // Side on anti-correlated
    CHECK_NEAR(l, refL, 0.02f, "Side routing on anti-correlated content should boost L");
    CHECK_NEAR(r, refR, 0.02f, "Side routing on anti-correlated content should boost R");
}

static void testEQChannelRoutingResponseCurve()
{
    std::cout << "  [EQ routing: per-group response curves]\n";
    constexpr int kN = XlethParametricEQ::kResponseSize;
    constexpr int kModes = XlethParametricEQ::kNumChannelModes;

    // One +12 dB bell at 1 kHz routed to `channel`; returns all five traces
    // (Stereo, Left, Right, Mid, Side) back to back.
    auto curvesFor = [](int channel, float* out)
    {
        XlethParametricEQ eq;
        eq.prepareToPlay(44100.0, 512);
        int b = eq.addBand();
        eq.setBandParam(b, "freq",    1000.0f);
        eq.setBandParam(b, "gain",    12.0f);
        eq.setBandParam(b, "q",       1.0f);
        eq.setBandParam(b, "type",    0.0f);
        eq.setBandParam(b, "enabled", 1.0f);
        eq.setBandParam(b, "channel", static_cast<float>(channel));
        eq.getChannelResponseCurves(out, kN);
    };

    auto peakOf = [](const float* trace)
    {
        float peak = -300.0f;
        for (int i = 0; i < kN; ++i) peak = std::max(peak, trace[i]);
        return peak;
    };
    auto isFlat = [](const float* trace)
    {
        for (int i = 0; i < kN; ++i)
            if (std::abs(trace[i]) > 0.01f) return false;
        return true;
    };

    // Each routing must land the full +12 dB bell on ITS trace and leave every
    // other trace flat — no averaging across channels.
    static const char* kNames[kModes] = { "Stereo", "Left", "Right", "Mid", "Side" };
    for (int channel = 0; channel < kModes; ++channel)
    {
        std::vector<float> curves(static_cast<size_t>(kModes) * kN);
        curvesFor(channel, curves.data());

        for (int k = 0; k < kModes; ++k)
        {
            const float* trace = curves.data() + static_cast<size_t>(k) * kN;
            if (k == channel)
            {
                CHECK_NEAR(peakOf(trace), 12.0f, 0.5f,
                           (std::string(kNames[channel]) + " band should peak at the full +12 dB on its own trace").c_str());
                CHECK_NEAR(trace[0], 0.0f, 0.2f,
                           (std::string(kNames[channel]) + " trace should be flat at 20 Hz").c_str());
            }
            else
            {
                CHECK(isFlat(trace),
                      (std::string(kNames[channel]) + " band must not bleed into the " + kNames[k] + " trace").c_str());
            }
        }
    }

    // getResponseCurve() is the Stereo trace of the same data.
    XlethParametricEQ eq;
    eq.prepareToPlay(44100.0, 512);
    int b = eq.addBand();
    eq.setBandParam(b, "freq",    1000.0f);
    eq.setBandParam(b, "gain",    12.0f);
    eq.setBandParam(b, "q",       1.0f);
    eq.setBandParam(b, "type",    0.0f);
    eq.setBandParam(b, "enabled", 1.0f);
    float stereoOnly[kN];
    std::vector<float> all(static_cast<size_t>(kModes) * kN);
    eq.getResponseCurve(stereoOnly, kN);
    eq.getChannelResponseCurves(all.data(), kN);
    for (int i = 0; i < kN; ++i)
        CHECK_NEAR(stereoOnly[i], all[i], 1e-4f, "getResponseCurve must equal the Stereo trace");

    // Two bands in the SAME group multiply (dB add); bands in different groups
    // stay on separate traces.
    int b2 = eq.addBand();
    eq.setBandParam(b2, "freq",    1000.0f);
    eq.setBandParam(b2, "gain",    6.0f);
    eq.setBandParam(b2, "q",       1.0f);
    eq.setBandParam(b2, "type",    0.0f);
    eq.setBandParam(b2, "enabled", 1.0f);
    eq.setBandParam(b2, "channel", 4.0f);   // Side
    eq.getChannelResponseCurves(all.data(), kN);
    CHECK_NEAR(peakOf(all.data()), 12.0f, 0.5f, "Stereo trace must ignore the Side band");
    CHECK_NEAR(peakOf(all.data() + 4 * kN), 6.0f, 0.5f, "Side trace must show only the Side band");
}

static void testEQChannelRoutingFoldsForLinPhase()
{
    std::cout << "  [EQ routing: linPhase folds to Stereo]\n";
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 1024;
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;

    XlethParametricEQ eq;
    eq.prepareToPlay(kSR, kBS);

    int b = eq.addBand();
    eq.setBandParam(b, "freq",    1000.0f);
    eq.setBandParam(b, "gain",    12.0f);
    eq.setBandParam(b, "q",       1.0f);
    eq.setBandParam(b, "type",    0.0f);
    eq.setBandParam(b, "enabled", 1.0f);
    eq.setBandParam(b, "channel", 1.0f);   // Left
    eq.setParameterValue("linphase", 1.0f);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    for (int blk = 0; blk < 8; ++blk)
    {
        for (int s = 0; s < kBS; ++s)
        {
            const float v = std::sin(pi2 * 1000.0f
                * static_cast<float>(blk * kBS + s) / static_cast<float>(kSR));
            buf.setSample(0, s, v);
            buf.setSample(1, s, v);
        }
        eq.processBlock(buf, midi);
    }

    const float l = buf.getMagnitude(0, 0, kBS);
    const float r = buf.getMagnitude(1, 0, kBS);
    // Linear phase applies one shared kernel, so routing is ignored and R is
    // boosted right alongside L (see foldChannelForContext).
    CHECK(r > 1.3f, "linPhase should boost R too — routing folds to Stereo");
    CHECK_NEAR(l, r, 0.05f, "linPhase should treat L and R identically despite Left routing");

    // The displayed curve must agree with that fold.
    float curve[XlethParametricEQ::kResponseSize];
    eq.getResponseCurve(curve, XlethParametricEQ::kResponseSize);
    float peak = -300.0f;
    for (int i = 0; i < XlethParametricEQ::kResponseSize; ++i)
        peak = std::max(peak, curve[i]);
    CHECK_NEAR(peak, 12.0f, 0.5f,
               "under linPhase the curve should show the full +12 dB, not the routed mean");
}

static void testEQChannelRoutingMonoFoldsToStereo()
{
    std::cout << "  [EQ routing: mono folds to Stereo]\n";
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 1024;
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;

    // A Right-routed band on a mono buffer must not silently become a bypass.
    XlethParametricEQ eq;
    eq.prepareToPlay(kSR, kBS);

    int b = eq.addBand();
    eq.setBandParam(b, "freq",    1000.0f);
    eq.setBandParam(b, "gain",    12.0f);
    eq.setBandParam(b, "q",       1.0f);
    eq.setBandParam(b, "type",    0.0f);
    eq.setBandParam(b, "enabled", 1.0f);
    eq.setBandParam(b, "channel", 2.0f);   // Right — no such channel here

    juce::AudioBuffer<float> buf(1, kBS);
    juce::MidiBuffer midi;
    for (int blk = 0; blk < 6; ++blk)
    {
        for (int s = 0; s < kBS; ++s)
            buf.setSample(0, s, std::sin(pi2 * 1000.0f
                * static_cast<float>(blk * kBS + s) / static_cast<float>(kSR)));
        eq.processBlock(buf, midi);
    }

    CHECK(buf.getMagnitude(0, 0, kBS) > 1.5f,
          "mono input should fold Right routing to Stereo and still boost");
}

static void testEQChannelRoutingDynamicDetector()
{
    std::cout << "  [EQ routing: dynamic detector follows routing]\n";
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 512;
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;

    // A Right-routed Dynamic band fed loud content on L ONLY must not trigger:
    // the detector has to listen to R, not to the stereo sum.
    auto activationFor = [&](int channel, float lGain, float rGain)
    {
        XlethParametricEQ eq;
        eq.prepareToPlay(kSR, kBS);
        int b = eq.addBand();
        eq.setBandParam(b, "freq",        1000.0f);
        eq.setBandParam(b, "gain",        -12.0f);
        eq.setBandParam(b, "q",           1.0f);
        eq.setBandParam(b, "type",        0.0f);
        eq.setBandParam(b, "enabled",     1.0f);
        eq.setBandParam(b, "mode",        1.0f);   // Dynamic
        eq.setBandParam(b, "dyn_thresh",  -30.0f);
        eq.setBandParam(b, "dyn_ratio",   10.0f);
        eq.setBandParam(b, "dyn_attack",  1.0f);
        eq.setBandParam(b, "dyn_release", 200.0f);
        eq.setBandParam(b, "channel",     static_cast<float>(channel));

        juce::AudioBuffer<float> buf(2, kBS);
        juce::MidiBuffer midi;
        for (int blk = 0; blk < 40; ++blk)
        {
            for (int s = 0; s < kBS; ++s)
            {
                const float v = std::sin(pi2 * 1000.0f
                    * static_cast<float>(blk * kBS + s) / static_cast<float>(kSR));
                buf.setSample(0, s, v * lGain);
                buf.setSample(1, s, v * rGain);
            }
            eq.processBlock(buf, midi);
        }
        // getBandGR() == activation * dyn_range (default +12 dB, unset here).
        return std::abs(eq.getBandGR(0));
    };

    const float stereoBoth = activationFor(0, 1.0f, 1.0f);
    CHECK(stereoBoth > 1.0f, "Stereo dynamic band should trigger on loud stereo content");

    const float rightOnR = activationFor(2, 0.0f, 1.0f);
    CHECK(rightOnR > 1.0f, "Right-routed dynamic band should trigger on loud R content");

    const float rightOnL = activationFor(2, 1.0f, 0.0f);
    CHECK(rightOnL < 0.1f,
          "Right-routed dynamic band must NOT trigger on L-only content");
    CHECK(rightOnR > rightOnL * 10.0f,
          "routed detector should discriminate L-only from R-only content");
}

// ─── Advanced EQ Mode Tests ─────────────────────────────────────────────────

static void testDynamicEQ()
{
    std::cout << "  [EQ dynamic]\n";
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 512;

    XlethParametricEQ eq;
    eq.prepareToPlay(kSR, kBS);

    int b = eq.addBand();
    eq.setBandParam(b, "freq",    1000.0f);
    eq.setBandParam(b, "gain",    0.0f);    // baseline: flat until triggered
    eq.setBandParam(b, "q",       1.0f);
    eq.setBandParam(b, "type",    0.0f);    // Bell
    eq.setBandParam(b, "enabled", 1.0f);
    eq.setBandParam(b, "mode",    1.0f);    // Dynamic
    eq.setBandParam(b, "dyn_thresh", -20.0f);
    eq.setBandParam(b, "dyn_ratio",  4.0f);
    eq.setBandParam(b, "dyn_attack", 10.0f);
    eq.setBandParam(b, "dyn_release", 100.0f);
    eq.setBandParam(b, "dyn_range", -18.0f); // duck up to 18 dB when triggered

    // Feed 1 kHz sine at ~-10 dBFS (10 dB above threshold)
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;
    const float amp  = std::pow(10.0f, -10.0f / 20.0f); // ~0.316

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;

    // Process many blocks to let smoothers + envelope settle
    for (int iter = 0; iter < 40; ++iter)
    {
        for (int s = 0; s < kBS; ++s)
        {
            float v = amp * std::sin(pi2 * 1000.0f * static_cast<float>(iter * kBS + s) / static_cast<float>(kSR));
            buf.setSample(0, s, v);
            buf.setSample(1, s, v);
        }
        eq.processBlock(buf, midi);
    }

    float gr = eq.getBandGR(0);
    // RMS of a bandpassed sine at -10 dBFS through a bell filter will be
    // around threshold level. GR should be noticeably negative.
    CHECK(gr < -1.0f, "Dynamic EQ GR should be noticeably negative with signal above threshold");
    CHECK(gr > -40.0f, "Dynamic EQ GR should not be unreasonably large");

    // Feed silence → GR should release toward 0
    // Note: envelope uses per-sample coefficient applied once per block,
    // so release is slow. We just verify direction, not full recovery.
    for (int iter = 0; iter < 60; ++iter)
    {
        fillBuffer(buf, 0.0f);
        eq.processBlock(buf, midi);
    }

    float grAfterSilence = eq.getBandGR(0);
    CHECK(grAfterSilence > gr, "GR should release (get closer to 0) after silence");
}

static void testSpectralDynamics()
{
    std::cout << "  [EQ spectral]\n";
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 512;

    XlethParametricEQ eq;
    eq.prepareToPlay(kSR, kBS);

    int b = eq.addBand();
    eq.setBandParam(b, "freq",    1000.0f);
    // In Spectral mode the GAIN knob IS the signed depth — there is no
    // spec_depth parameter.  -20 dB = suppress detected resonances by 20 dB.
    eq.setBandParam(b, "gain",    -20.0f);
    eq.setBandParam(b, "q",       1.0f);
    eq.setBandParam(b, "type",    0.0f);
    eq.setBandParam(b, "enabled", 1.0f);
    eq.setBandParam(b, "mode",       2.0f);   // Spectral
    eq.setBandParam(b, "spec_sens",  1.0f);   // most sensitive
    eq.setBandParam(b, "spec_sel",   5.0f);

    // A loud 1 kHz sine on a very low noise floor is exactly the "resonance"
    // this mode targets: it sits far above its own half-octave local envelope,
    // so it should be pushed down by close to the full 20 dB.
    //
    // Phase has to run continuously across blocks — a per-block phase reset
    // would smear broadband clicks across the spectrum.
    const float pi2  = 2.0f * juce::MathConstants<float>::pi;
    const float amp  = 0.5f;                 // ~-6 dBFS
    const float step = pi2 * 1000.0f / static_cast<float>(kSR);
    float phase = 0.0f;
    std::uint32_t rng = 0x13572468u;         // deterministic dither/noise floor

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;

    // Latency is 2048 samples and the per-bin envelope needs a handful of STFT
    // frames (one frame = kSTFTHop = 2048 samples = 4 blocks) to settle.
    constexpr int kWarmBlocks    = 40;   // ~20 frames
    constexpr int kMeasureBlocks = 20;
    double inSumSq = 0.0, outSumSq = 0.0;
    int    measured = 0;

    for (int i = 0; i < kWarmBlocks + kMeasureBlocks; ++i)
    {
        double blockIn = 0.0;
        for (int s = 0; s < kBS; ++s)
        {
            rng = rng * 1664525u + 1013904223u;
            const float noise = (static_cast<float>(rng >> 8) / 8388608.0f - 1.0f)
                              * 0.0003f;     // ~-70 dBFS floor
            const float v = amp * std::sin(phase) + noise;
            phase += step;
            if (phase > pi2) phase -= pi2;
            buf.setSample(0, s, v);
            buf.setSample(1, s, v);
            blockIn += static_cast<double>(v) * v;
        }

        eq.processBlock(buf, midi);

        if (i >= kWarmBlocks)
        {
            double blockOut = 0.0;
            const float* p = buf.getReadPointer(0);
            for (int s = 0; s < kBS; ++s)
                blockOut += static_cast<double>(p[s]) * p[s];
            inSumSq  += blockIn;
            outSumSq += blockOut;
            ++measured;
        }
    }

    CHECK(measured == kMeasureBlocks, "spectral test should measure every tail block");

    const double inRms  = std::sqrt(inSumSq  / (measured * kBS));
    const double outRms = std::sqrt(outSumSq / (measured * kBS));
    const double dropDb = 20.0 * std::log10(inRms / std::max(outRms, 1e-12));
    std::cout << "    spectral drop = " << dropDb << " dB\n";
    CHECK(dropDb >= 6.0, "Spectral band at gain -20 dB should cut a loud 1 kHz "
                         "resonance by at least 6 dB");

    // GR metering must report the suppression (signed, negative = cut).
    const float gr = eq.getBandGR(b);
    CHECK(gr < -1.0f, "Spectral band should report negative GR while suppressing");

    // Correct WOLA reconstruction costs a full kSTFTSize of latency, not a
    // hop: a frame is only complete once its last sample has arrived.
    int lat = eq.getLatencySamples();
    CHECK(lat == XlethParametricEQ::kSTFTLatency,
          "Spectral mode latency should be kSTFTLatency (= kSTFTSize)");

    // Depth 0 must leave the band inert: once the envelope has released back
    // to unity the STFT path is a pass-through.
    //
    // The WOLA path reconstructs an unmodified spectrum exactly (sqrt-Hann on
    // both ends at 75% overlap, normalised by 1/sum(w^2)), so depth 0 is a
    // true bit-level pass-through and this tolerance can be tight.  It used to
    // sit at ~1.15 dB because analysis-only windowing at 50% overlap emitted
    // each output sample before its overlapping frames had all landed — the
    // same defect that made the path click once per hop.
    eq.setBandParam(b, "gain", 0.0f);
    double flatIn = 0.0, flatOut = 0.0;
    for (int i = 0; i < 60; ++i)   // ~15 frames: plenty for a 100 ms release
    {
        double blockIn = 0.0;
        for (int s = 0; s < kBS; ++s)
        {
            const float v = amp * std::sin(phase);
            phase += step;
            if (phase > pi2) phase -= pi2;
            buf.setSample(0, s, v);
            buf.setSample(1, s, v);
            blockIn += static_cast<double>(v) * v;
        }
        eq.processBlock(buf, midi);
        if (i >= 50)
        {
            const float* p = buf.getReadPointer(0);
            for (int s = 0; s < kBS; ++s)
                flatOut += static_cast<double>(p[s]) * p[s];
            flatIn += blockIn;
        }
    }
    const double inertDb = 20.0 * std::log10(std::sqrt(flatIn)
                                           / std::max(std::sqrt(flatOut), 1e-12));
    std::cout << "    spectral depth-0 delta = " << inertDb << " dB\n";
    CHECK(std::abs(inertDb) < 0.2,
          "Spectral band at gain 0 dB should be inert (WOLA reconstructs an "
          "unmodified spectrum exactly)");
    CHECK(dropDb - inertDb >= 15.0,
          "Suppression must come from the gain knob, not the STFT path");
}

// Regression guard for the click train the old analysis-only 50% OLA produced.
// A spectral band actively suppressing a resonance must not introduce any
// sample-to-sample discontinuity: the artefact was a step at every hop
// boundary, which shows up as a |diff| spike far above the signal's own median
// slew and — diagnostically — lands on an exact kSTFTHop grid at a fixed phase.
static void testSpectralNoClicks()
{
    std::cout << "  [EQ spectral: no frame-boundary clicks]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethParametricEQ eq;
    eq.prepareToPlay(kSR, kBS);

    int b = eq.addBand();
    eq.setBandParam(b, "freq",    1000.0f);
    eq.setBandParam(b, "gain",    -20.0f);  // depth: suppress hard
    eq.setBandParam(b, "q",       1.0f);
    eq.setBandParam(b, "type",    0.0f);
    eq.setBandParam(b, "enabled", 1.0f);
    eq.setBandParam(b, "mode",       2.0f);
    eq.setBandParam(b, "spec_sens",  1.0f);
    eq.setBandParam(b, "spec_sel",   5.0f);

    const float pi2  = 2.0f * juce::MathConstants<float>::pi;
    const float step = pi2 * 1000.0f / static_cast<float>(kSR);
    float phase = 0.0f;

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;

    // Collect the steady-state tail so the startup ramp is excluded.
    constexpr int kWarm    = 40;
    constexpr int kCollect = 40;
    std::vector<float> out;
    out.reserve(static_cast<std::size_t>(kCollect) * kBS);

    for (int i = 0; i < kWarm + kCollect; ++i)
    {
        for (int s = 0; s < kBS; ++s)
        {
            const float v = 0.5f * std::sin(phase);
            phase += step;
            if (phase > pi2) phase -= pi2;
            buf.setSample(0, s, v);
            buf.setSample(1, s, v);
        }
        eq.processBlock(buf, midi);
        if (i >= kWarm)
        {
            const float* p = buf.getReadPointer(0);
            for (int s = 0; s < kBS; ++s)
                out.push_back(p[s]);
        }
    }

    std::vector<float> diffs;
    diffs.reserve(out.size());
    for (std::size_t i = 1; i < out.size(); ++i)
        diffs.push_back(std::abs(out[i] - out[i - 1]));

    std::vector<float> sorted = diffs;
    std::sort(sorted.begin(), sorted.end());
    const float medianDiff = sorted[sorted.size() / 2];
    float maxDiff = 0.0f;
    std::size_t maxAt = 0;
    for (std::size_t i = 0; i < diffs.size(); ++i)
        if (diffs[i] > maxDiff) { maxDiff = diffs[i]; maxAt = i; }

    const float ratio = maxDiff / std::max(medianDiff, 1.0e-12f);
    std::cout << "    max|diff|/median|diff| = " << ratio
              << "  (max at +" << maxAt << ", hop grid phase "
              << (maxAt % static_cast<std::size_t>(XlethParametricEQ::kSTFTHop))
              << ")\n";

    // A clean 1 kHz sine at 48 kHz slews smoothly: the largest step can only be
    // a little above the median. The old path hit >20x here.
    CHECK(medianDiff > 1.0e-6f, "spectral click test should have real signal to measure");
    CHECK(ratio < 4.0f,
          "Spectral band must not step at frame boundaries (WOLA synthesis window)");
}

static void testLinearPhase()
{
    std::cout << "  [EQ linear phase]\n";
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 512;

    XlethParametricEQ eq;
    eq.prepareToPlay(kSR, kBS);

    int b = eq.addBand();
    eq.setBandParam(b, "freq",    1000.0f);
    eq.setBandParam(b, "gain",    12.0f);   // +12 dB boost
    eq.setBandParam(b, "q",       1.0f);
    eq.setBandParam(b, "type",    0.0f);    // Bell
    eq.setBandParam(b, "enabled", 1.0f);

    // Enable linear phase
    eq.setParameterValue("linphase", 1.0f);

    // Process blocks to let FIR build and smoothers settle
    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    for (int i = 0; i < 10; ++i)
    {
        fillBuffer(buf, 0.0f);
        eq.processBlock(buf, midi);
    }

    // Check response curve — peak should be near +12 dB at 1 kHz
    float response[XlethParametricEQ::kResponseSize];
    eq.getResponseCurve(response, XlethParametricEQ::kResponseSize);

    float maxDb = -999.0f;
    int maxBin = 0;
    for (int i = 0; i < XlethParametricEQ::kResponseSize; ++i)
    {
        if (response[i] > maxDb)
        {
            maxDb = response[i];
            maxBin = i;
        }
    }

    CHECK(maxDb > 10.0f, "LinPhase response curve peak should be > 10 dB");
    CHECK(maxDb < 14.0f, "LinPhase response curve peak should be < 14 dB");
    CHECK(maxBin > 250 && maxBin < 330,
          "LinPhase response peak should be near bin ~289 (1 kHz)");

    // Check latency = firLength / 2 (4096/2 = 2048 for sr <= 48k)
    int lat = eq.getLatencySamples();
    CHECK(lat == 2048, "LinPhase latency should be 2048 (firLength/2)");
}

static void testOversampling()
{
    std::cout << "  [EQ oversampling]\n";
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 512;

    XlethParametricEQ eq;
    eq.prepareToPlay(kSR, kBS);

    int b = eq.addBand();
    eq.setBandParam(b, "freq",    1000.0f);
    eq.setBandParam(b, "gain",    6.0f);
    eq.setBandParam(b, "q",       1.0f);
    eq.setBandParam(b, "type",    0.0f);
    eq.setBandParam(b, "enabled", 1.0f);

    // OS 2x
    eq.setParameterValue("oversample", 1.0f);
    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    fillBuffer(buf, 0.1f);
    eq.processBlock(buf, midi);

    int lat2x = eq.getLatencySamples();
    CHECK(lat2x > 0, "OS 2x latency should be > 0");

    // OS 4x
    eq.setParameterValue("oversample", 2.0f);
    fillBuffer(buf, 0.1f);
    eq.processBlock(buf, midi);

    int lat4x = eq.getLatencySamples();
    CHECK(lat4x > lat2x, "OS 4x latency should be > 2x latency");

    // OS off
    eq.setParameterValue("oversample", 0.0f);
    fillBuffer(buf, 0.1f);
    eq.processBlock(buf, midi);

    int lat0 = eq.getLatencySamples();
    CHECK(lat0 == 0, "OS off latency should be 0");
}

static void testLinPhaseDisablesDynamic()
{
    std::cout << "  [EQ linphase disables dynamic]\n";
    constexpr double kSR = 44100.0;
    constexpr int    kBS = 512;

    XlethParametricEQ eq;
    eq.prepareToPlay(kSR, kBS);

    int b = eq.addBand();
    eq.setBandParam(b, "freq",    1000.0f);
    eq.setBandParam(b, "gain",    12.0f);
    eq.setBandParam(b, "q",       1.0f);
    eq.setBandParam(b, "type",    0.0f);
    eq.setBandParam(b, "enabled", 1.0f);
    eq.setBandParam(b, "mode",    1.0f);    // Dynamic
    eq.setBandParam(b, "dyn_thresh", -20.0f);
    eq.setBandParam(b, "dyn_ratio",  4.0f);

    // Enable linPhase — should suppress dynamic processing
    eq.setParameterValue("linphase", 1.0f);

    // Feed loud 1 kHz sine
    const float pi2 = 2.0f * juce::MathConstants<float>::pi;
    const float amp  = 0.5f; // -6 dBFS, well above threshold
    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;

    for (int iter = 0; iter < 20; ++iter)
    {
        for (int s = 0; s < kBS; ++s)
        {
            float v = amp * std::sin(pi2 * 1000.0f * static_cast<float>(iter * kBS + s) / static_cast<float>(kSR));
            buf.setSample(0, s, v);
            buf.setSample(1, s, v);
        }
        eq.processBlock(buf, midi);
    }

    float gr = eq.getBandGR(0);
    CHECK(std::abs(gr) < 0.01f, "LinPhase should suppress Dynamic EQ — GR must stay at 0");
}

// ─── Entry point ─────────────────────────────────────────────────────────────

// ─── [EQCore] Legacy bit-identity guard ─────────────────────────────────────
// Every scenario below runs the EQ on its DEFAULT spectral engine (Legacy, the
// 4096 STFT path) through the public API only, and hashes (64-bit FNV-1a over
// the bit patterns) every output sample of both channels, every band's GR meter
// and the reported latency after every block. The expected hashes were recorded
// by building this very test against the EQ before the [EQCore] work (the
// locking fix, the spectral_engine / spectral_quality parameters and the core
// path): any change to what the default EQ outputs, meters or reports fails here.
namespace eqlegacy
{
struct Hash
{
    std::uint64_t h = 1469598103934665603ull;
    void bytes(const void* p, std::size_t n)
    {
        const auto* b = static_cast<const unsigned char*>(p);
        for (std::size_t i = 0; i < n; ++i) { h ^= b[i]; h *= 1099511628211ull; }
    }
    void f(float v) { bytes(&v, sizeof v); }
    void i(int v)   { bytes(&v, sizeof v); }
};

static const int kSchedule[] = { 1, 37, 128, 255, 511, 512, 37, 300, 64 };

static void band(XlethParametricEQ& eq, int b, float freq, float gain, float q, int type,
                 int mode, int channel, float sens = 0.5f, float sel = 5.0f,
                 float atk = 10.0f, float rel = 100.0f)
{
    eq.setBandParam(b, "freq", freq);
    eq.setBandParam(b, "gain", gain);
    eq.setBandParam(b, "q", q);
    eq.setBandParam(b, "type", static_cast<float>(type));
    eq.setBandParam(b, "channel", static_cast<float>(channel));
    eq.setBandParam(b, "spec_sens", sens);
    eq.setBandParam(b, "spec_sel", sel);
    eq.setBandParam(b, "spec_attack", atk);
    eq.setBandParam(b, "spec_release", rel);
    eq.setBandParam(b, "enabled", 1.0f);
    eq.setBandParam(b, "mode", static_cast<float>(mode));
}

// The mixed configuration: two Spectral bands (a cut and an upward band), a
// Left-routed bell, a Mid-routed bell, a Dynamic Side band.
static void configureMixed(XlethParametricEQ& eq)
{
    while (eq.getBandCount() < 5) eq.addBand();
    band(eq, 0, 2500.0f, -12.0f, 4.0f, 0, 2, 0);
    band(eq, 1,  400.0f,   4.0f, 1.0f, 0, 0, 1);
    band(eq, 2,  800.0f,   6.0f, 2.0f, 0, 2, 3, 0.8f, 4.0f, 5.0f, 300.0f);
    band(eq, 3, 6000.0f,  -3.0f, 0.7f, 0, 0, 3);
    band(eq, 4, 1200.0f,  -2.0f, 1.5f, 0, 1, 4);
    eq.setBandParam(4, "dyn_thresh", -40.0f);
}

using Event = std::function<void(XlethParametricEQ&)>;

static std::uint64_t run(double sr, int channels, int seconds10, const std::function<void(XlethParametricEQ&)>& setup,
                         const std::vector<std::pair<int, Event>>& events, std::uint32_t seed, bool prepareAfterSetup)
{
    XlethParametricEQ eq;
    eq.prepareToPlay(sr, 512);
    setup(eq);
    if (prepareAfterSetup) eq.prepareToPlay(sr, 512);

    const int total = static_cast<int>(sr) * seconds10 / 10;
    juce::AudioBuffer<float> in(channels, total);
    rsnew::fillPinkBell(in, sr, 2500.0f, 0.05f, seed);
    if (channels > 1)   // a right-only component so channel routing matters
    {
        float* r = in.getWritePointer(1);
        for (int s = 0; s < total; ++s)
            r[s] += 0.03f * std::sin(2.0f * juce::MathConstants<float>::pi * 1300.0f * static_cast<float>(s) / static_cast<float>(sr));
    }

    Hash h;
    juce::MidiBuffer midi;
    int pos = 0, blk = 0;
    std::size_t ev = 0;
    while (pos < total)
    {
        while (ev < events.size() && events[ev].first == blk) { events[ev].second(eq); ++ev; }
        const int n = std::min(kSchedule[blk % (sizeof kSchedule / sizeof kSchedule[0])], total - pos);
        juce::AudioBuffer<float> b(channels, n);
        for (int ch = 0; ch < channels; ++ch) b.copyFrom(ch, 0, in, ch, pos, n);
        eq.processBlock(b, midi);
        for (int ch = 0; ch < channels; ++ch)
            for (int s = 0; s < n; ++s) h.f(b.getSample(ch, s));
        for (int k = 0; k < XlethParametricEQ::kMaxBands; ++k) h.f(eq.getBandGR(k));
        h.i(eq.getReportedProcessorLatencySamples());
        h.i(eq.getLatencySamples());
        pos += n;
        ++blk;
    }
    return h.h;
}
} // namespace eqlegacy

static void testEQLegacyBitIdentity()
{
    std::cout << "  [EQCore] legacy (default engine) bit-identity hashes\n";
    using namespace eqlegacy;

    juce::MemoryBlock otherState;
    {
        XlethParametricEQ src;
        src.prepareToPlay(48000.0, 512);
        src.addBand(); src.addBand(); src.addBand();
        band(src, 0, 3100.0f, -18.0f, 6.0f, 0, 2, 0, 0.3f, 8.0f);
        band(src, 1,  150.0f,   3.0f, 0.9f, 1, 0, 0);
        band(src, 2, 9000.0f,  -6.0f, 2.0f, 0, 0, 2);
        src.getStateInformation(otherState);
    }

    struct Scenario { const char* name; std::uint64_t expected; std::function<std::uint64_t()> fn; };
    const std::vector<Scenario> scenarios = {
        { "mixed steady 48k stereo", 0x66f605bcccb4ab22ull, [] {
              return run(48000.0, 2, 30, configureMixed, {}, 0x1234u, true); } },
        { "single spectral band, no re-prepare (smoother ramps) 44.1k", 0x78aacd757cf00495ull, [] {
              return run(44100.0, 2, 25, [](XlethParametricEQ& eq) { eq.addBand(); band(eq, 0, 1000.0f, -20.0f, 1.0f, 0, 2, 0, 1.0f, 5.0f); },
                         {}, 0x77u, false); } },
        { "mixed with events (off->on, linphase, bypass, mode, restore, remove/add, reset)", 0xbc048d2cc15b9ce4ull, [&otherState] {
              std::vector<std::pair<int, Event>> ev = {
                  { 60,  [](XlethParametricEQ& eq) { eq.setBandParam(0, "enabled", 0.0f); } },
                  { 80,  [](XlethParametricEQ& eq) { eq.setBandParam(2, "enabled", 0.0f); } },
                  { 120, [](XlethParametricEQ& eq) { eq.setBandParam(0, "enabled", 1.0f); eq.setBandParam(2, "enabled", 1.0f); } },
                  { 170, [](XlethParametricEQ& eq) { eq.setParameterValue("linphase", 1.0f); } },
                  { 200, [](XlethParametricEQ& eq) { eq.setParameterValue("linphase", 0.0f); } },
                  { 240, [](XlethParametricEQ& eq) { eq.setBypassed(true); } },
                  { 280, [](XlethParametricEQ& eq) { eq.setBypassed(false); } },
                  { 320, [](XlethParametricEQ& eq) { eq.setBandParam(1, "mode", 1.0f); eq.setBandParam(0, "gain", 8.0f); } },
                  { 360, [&otherState](XlethParametricEQ& eq) { eq.setStateInformation(otherState.getData(), static_cast<int>(otherState.getSize())); } },
                  { 400, [](XlethParametricEQ& eq) { eq.removeBand(1); } },
                  { 430, [](XlethParametricEQ& eq) { const int b = eq.addBand(); band(eq, b, 700.0f, -9.0f, 3.0f, 0, 2, 0); } },
                  { 470, [](XlethParametricEQ& eq) { eq.reset(); } },
                  { 500, [](XlethParametricEQ& eq) { eq.setParameterValue("oversample", 1.0f); eq.setBandParam(0, "mode", 0.0f); eq.setBandParam(2, "mode", 0.0f); } },
                  { 540, [](XlethParametricEQ& eq) { eq.setBandParam(0, "mode", 2.0f); } },
              };
              return run(48000.0, 2, 60, configureMixed, ev, 0x9abcu, true); } },
        { "mono spectral 48k", 0xdc07ae225603b341ull, [] {
              return run(48000.0, 1, 20, [](XlethParametricEQ& eq) { eq.addBand(); band(eq, 0, 2500.0f, -15.0f, 3.0f, 0, 2, 3); },
                         {}, 0x55u, true); } },
        { "spectral 96k", 0x31f512480340db1bull, [] {
              return run(96000.0, 2, 15, [](XlethParametricEQ& eq) { eq.addBand(); eq.addBand(); band(eq, 0, 2500.0f, -24.0f, 4.0f, 0, 2, 0);
                                                                     band(eq, 1, 5000.0f, -6.0f, 8.0f, 0, 2, 2); },
                         {}, 0x99u, true); } },
    };

    for (const auto& s : scenarios)
    {
        const std::uint64_t got = s.fn();
        std::printf("    [EQCore] legacy hash %-80s 0x%016llx\n", s.name, static_cast<unsigned long long>(got));
        CHECK(got == s.expected,
              std::string("[EQCore] legacy EQ output / meters / latency must be bit-identical to the pre-[EQCore] EQ: ") + s.name);
    }
}

int main()
{
    // JUCE requires a ScopedJuceInitialiser_GUI to initialise internals
    // (juce_audio_processors uses the message thread for APVTS listeners).
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout.setf(std::ios::unitbuf);
    std::cerr.setf(std::ios::unitbuf);

    std::cout << "=== test_effects ===\n";

    testLayout();
    testSmoothedGain();
    testMetering();
    testSerializationRoundTrip();
    testLinearGraphTopologySync();
    testGraphRuntimeOwnership();
    testGraphOwnedEffectHydration();
    testBypass();
    testJSONHelpers();
    testDistortionModesDiffer();
    testDistortionDefaultRenderUnchanged();
    testDistortionNewModesSafety();
    testDistortionCrushParams();
    testDistortionSymmetry();
    testDistortionModeLoudness();
    testDistortionParameterSurface();
    testTransientAttackShaping();
    testTransientSustainShaping();
    testTransientMixAndBypass();
    testTransientSafety();
    testTransientStereoLinking();
    testTransientMidiAttackMode();
    testResonanceSuppressorWolaIdentity();
    testResonanceSuppressorLowLatencyMode();
    testResonanceSuppressorLatencySafeBypass();
    testResonanceSuppressorTransitionSafety();
    testResonanceSuppressorDetector();
    testResonanceSuppressorSuppression();
    testResonanceSuppressorOutputStage();
    testResonanceSuppressorWeightingCurve();
    testResonanceSuppressorFocusCurveV11Bands();
    testResonanceSuppressorFocusCurveLiveEdits();
    testResonanceSuppressorStereoModes();
    testResonanceSuppressorModeSwitching();
    testResonanceSuppressorVisualization();
    testResonanceSuppressorNewEngineLatency();
    testResonanceSuppressorNewEngineMidSide();
    testResonanceSuppressorNewEngineTransitions();
    testResonanceSuppressorNewEngineState();
    testResonanceSuppressorNewEngineVizAndMeters();

    testDelayStereoModeParameter();
    testDelayStereoModeDual();
    testDelayStereoModeSingle();
    testDelayStereoModePingPong();

    std::cout << "\n=== test_eq ===\n";
    testEQLayout();
    testEQAddRemove();
    testEQBellFilter();
    testEQResponseCurve();
    testEQBypassBand();
    testEQSerialization();

    std::cout << "\n=== test_eq_channel_routing ===\n";
    testEQChannelRoutingDefault();
    testEQChannelRoutingLeftRight();
    testEQChannelRoutingMidSide();
    testEQChannelRoutingResponseCurve();
    testEQChannelRoutingFoldsForLinPhase();
    testEQChannelRoutingMonoFoldsToStereo();
    testEQChannelRoutingDynamicDetector();

    std::cout << "\n=== test_eq_advanced ===\n";
    testDynamicEQ();
    testSpectralDynamics();
    testSpectralNoClicks();
    testLinearPhase();
    testOversampling();
    testLinPhaseDisablesDynamic();
    testEQLegacyBitIdentity();

    std::cout << "\nResults: " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0)
    {
        std::cerr << "FAILED\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
