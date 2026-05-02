// test_effects.cpp — XlethEffectBase + TestGainEffect pipeline test
// Build: see engine/CMakeLists.txt target "test_effects"
// Run:   test_effects.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [<line>] <message>" and exits 1

#include "audio/TestGainEffect.h"
#include "audio/EffectChainManager.h"
#include "audio/XlethEQEffect.h"
#include "audio/XlethDistortionEffect.h"
#include "audio/XlethResonanceSuppressorEffect.h"
#include "audio/viz/DynamicsVizFrame.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <array>
#include <cmath>
#include <cstring>
#include <iostream>
#include <limits>
#include <string>
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

static int measureImpulseDelayForQuality(int quality, const std::vector<int>& blockSizes)
{
    constexpr double kSR = 44100.0;
    constexpr int kTotalSamples = 32768;
    constexpr int kImpulseIndex = 4096;

    XlethResonanceSuppressorEffect fx;
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

    std::array<std::array<float, kBS>, 4> rendered {};

    for (int mode = 0; mode < 4; ++mode)
    {
        XlethDistortionEffect fx;
        CHECK(fx.setParameterValue("mode", static_cast<float>(mode)),
              "distortion mode param should be settable");
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
    for (int a = 0; a < 4; ++a)
    {
        for (int b = a + 1; b < 4; ++b)
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
        fx.setParameterValue("quality", 0.0f);
        fx.setParameterValue("depth", 0.0f);
        fx.prepareToPlay(kSR, 512);
        const int preparedLatency = fx.getLatencySamples();
        CHECK(fx.setParameterValue("quality", 2.0f),
              "RS runtime quality change should be accepted");

        juce::AudioBuffer<float> buf(2, 512);
        fillBuffer(buf, 0.0f);
        juce::MidiBuffer midi;
        fx.processBlock(buf, midi);

        CHECK(fx.getLatencySamples() == preparedLatency,
              "RS runtime quality change should not rebuild latency inside processEffect");
    }
}

static void testResonanceSuppressorLatencySafeBypass()
{
    std::cout << "  [resonance suppressor latency-safe bypass]\n";

    constexpr double kSR = 44100.0;
    constexpr int kTotalSamples = 65536;
    const std::vector<int> mixedSchedule = {1, 37, 128, 255, 511, 1024, 37};
    const std::array<int, 3> expectedLatency {512, 1024, 2048};

    juce::AudioBuffer<float> input(2, kTotalSamples);
    fillResonanceRegressionSignal(input, kSR);

    for (int quality = 0; quality < 3; ++quality)
    {
        XlethResonanceSuppressorEffect fx;
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
        auto output = renderEffectInBlocks(fx, input, mixedSchedule);
        const ErrorStats bypassError =
            computeAlignedError(input, output, latency, 0, kTotalSamples - 1, 2);

        std::cout << "    quality " << quality
                  << " bypass dry max/RMS error: "
                  << bypassError.maxAbs << " / " << bypassError.rms
                  << ", meter L/R: " << fx.readMeterValue(0)
                  << " / " << fx.readMeterValue(1) << "\n";

        CHECK(bypassError.maxAbs < 1.0e-6 && bypassError.rms < 1.0e-7,
              "RS fully bypassed output should equal latency-aligned dry");
        CHECK(fx.readMeterValue(0) > 0.05f && fx.readMeterValue(1) > 0.05f,
              "RS processEffect should still advance meters while fully bypassed");
    }

    {
        EffectChainManager chain;
        chain.init(kSR, 1024);
        const int nodeId = chain.addEffect("resonancesuppressor", 0);
        CHECK(nodeId >= 0, "RS should be addable to an EffectChainManager");
        CHECK_NEAR(chain.getMaxTailLengthSeconds() * kSR, 1024.0, 0.5,
                   "RS chain tail should report Normal latency by default");
        CHECK(chain.setEffectParameter(nodeId, "quality", 2.0f),
              "RS chain quality param should be settable");
        chain.reprepare(kSR, 1024);
        CHECK_NEAR(chain.getMaxTailLengthSeconds() * kSR, 2048.0, 0.5,
                   "RS chain tail should update after High-quality reprepare");
        chain.destroy();
    }

    {
        XlethResonanceSuppressorEffect fx;
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
        constexpr int impulseIndex = toggleAt + 50;

        XlethResonanceSuppressorEffect fx;
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

        const int expectedIndex = impulseIndex + fx.getLatencySamples();
        int largePeakCount = 0;
        int peakIndex = -1;
        float peak = 0.0f;
        float earlyMax = 0.0f;
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
            if (s < expectedIndex - 8)
                earlyMax = std::max(earlyMax, v);
        }

        std::cout << "    bypass-ramp impulse peak count/index/earlyMax: "
                  << largePeakCount << " / " << peakIndex
                  << " / " << earlyMax << "\n";

        CHECK(largePeakCount == 1,
              "RS bypass ramp should not emit an early live impulse plus delayed duplicate");
        CHECK(std::abs(peakIndex - expectedIndex) <= 1 && peak > 0.8f,
              "RS bypass-ramp impulse should appear once at the aligned latency");
        CHECK(earlyMax < 0.05f,
              "RS bypass-ramp impulse should not leak live dry before latency");
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

static void testResonanceSuppressorDetector()
{
    std::cout << "  [resonance suppressor detector]\n";

    constexpr double kSR = 44100.0;
    constexpr int kTotalSamples = 32768;
    const std::vector<int> mixedSchedule = {1, 37, 128, 255, 511, 1024, 37};

    auto prepareDetectorFx = [&mixedSchedule](XlethResonanceSuppressorEffect& fx) {
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
        computeAlignedError(resonance, dryOnly.output, delay, start, end, 2);

    auto wetSuppressed = renderOutput(resonance, 100.0f, 100.0f, 0.0f, false);
    auto halfMix = renderOutput(resonance, 100.0f, 50.0f, 0.0f, false);

    const double dryRmsReduction =
        computeAlignedRmsReductionDb(resonance, dryOnly.output, delay, start, end, 0);
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
    CHECK(dryOnlyError.maxAbs < 2.0e-4 && dryOnlyError.rms < 5.0e-5,
          "RS mix 0 should output latency-aligned dry");
    CHECK(halfRmsReduction > dryRmsReduction + 0.2 && halfRmsReduction < wetRmsReduction - 0.2,
          "RS mix 50 RMS reduction should sit between dry and fully wet");
    CHECK(trimPlusDb > 5.8 && trimPlusDb < 6.2 && trimMinusDb < -5.8 && trimMinusDb > -6.2,
          "RS trim should apply post-output gain in dB");
    CHECK(delta0Rms < 1.0e-5,
          "RS delta depth 0 should be near silence after latency compensation");
    CHECK(delta100Rms > delta0Rms + 0.01,
          "RS delta depth 100 should expose measurable removed material");
    CHECK(std::abs(meterNormal.peakMeter - meterDryTrimmed.peakMeter) < 1.0e-5f,
          "RS slot 2 should be independent from mix and trim");

    {
        XlethResonanceSuppressorEffect fx;
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
        computeAlignedError(lowTone, lowHpDry.output, delay, start, end, 2);

    auto highDefault = renderWeighted(highTone, 997.0f, 0.0f, 80.0f, 16000.0f);
    auto highLpBlocked = renderWeighted(highTone, 997.0f, 0.0f, 80.0f, 3000.0f);
    auto highLpDry = renderWeighted(highTone, 997.0f, 0.0f, 80.0f, 3000.0f, false, 0.0f);
    const double highDefaultDb =
        computeAlignedToneReductionDb(highTone, highDefault.output, delay, start, end, 0, kSR, 6000.0);
    const double highLpDb =
        computeAlignedToneReductionDb(highTone, highLpBlocked.output, delay, start, end, 0, kSR, 6000.0);
    const ErrorStats highDryError =
        computeAlignedError(highTone, highLpDry.output, delay, start, end, 2);

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

static void testEQLayout()
{
    std::cout << "  [EQ layout]\n";
    XlethParametricEQ eq;

    CHECK(eq.getBandCount() == 0, "EQ should start with 0 bands");

    // Should have 210 APVTS params (13 per band × 16 + 2 global)
    const auto& params = eq.getParameters();
    CHECK(static_cast<int>(params.size()) == 210, "EQ should have 210 APVTS params");
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
    eq.setBandParam(b, "gain",    12.0f);   // +12 dB boost
    eq.setBandParam(b, "q",       1.0f);
    eq.setBandParam(b, "type",    0.0f);    // Bell
    eq.setBandParam(b, "enabled", 1.0f);
    eq.setBandParam(b, "mode",    1.0f);    // Dynamic
    eq.setBandParam(b, "dyn_thresh", -20.0f);
    eq.setBandParam(b, "dyn_ratio",  4.0f);
    eq.setBandParam(b, "dyn_attack", 10.0f);
    eq.setBandParam(b, "dyn_release", 100.0f);

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
    eq.setBandParam(b, "gain",    0.0f);
    eq.setBandParam(b, "q",       1.0f);
    eq.setBandParam(b, "type",    0.0f);
    eq.setBandParam(b, "enabled", 1.0f);
    eq.setBandParam(b, "mode",       2.0f);   // Spectral
    eq.setBandParam(b, "spec_sens",  0.5f);
    eq.setBandParam(b, "spec_depth", -20.0f); // -20 dB attenuation
    eq.setBandParam(b, "spec_sel",   5.0f);

    // Process a few blocks to trigger STFT and latency update
    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    for (int i = 0; i < 10; ++i)
    {
        fillBuffer(buf, 0.1f);
        eq.processBlock(buf, midi);
    }

    // Check latency includes STFT hop (2048 samples)
    int lat = eq.getLatencySamples();
    CHECK(lat == 2048, "Spectral mode latency should be 2048 (kSTFTHop)");
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
    testBypass();
    testJSONHelpers();
    testDistortionModesDiffer();
    testResonanceSuppressorWolaIdentity();
    testResonanceSuppressorLatencySafeBypass();
    testResonanceSuppressorDetector();
    testResonanceSuppressorSuppression();
    testResonanceSuppressorOutputStage();
    testResonanceSuppressorWeightingCurve();
    testResonanceSuppressorFocusCurveV11Bands();
    testResonanceSuppressorFocusCurveLiveEdits();
    testResonanceSuppressorStereoModes();
    testResonanceSuppressorModeSwitching();
    testResonanceSuppressorVisualization();

    std::cout << "\n=== test_eq ===\n";
    testEQLayout();
    testEQAddRemove();
    testEQBellFilter();
    testEQResponseCurve();
    testEQBypassBand();
    testEQSerialization();

    std::cout << "\n=== test_eq_advanced ===\n";
    testDynamicEQ();
    testSpectralDynamics();
    testLinearPhase();
    testOversampling();
    testLinPhaseDisablesDynamic();

    std::cout << "\nResults: " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0)
    {
        std::cerr << "FAILED\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
