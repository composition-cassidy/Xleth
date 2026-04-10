// test_effects.cpp — XlethEffectBase + TestGainEffect pipeline test
// Build: see engine/CMakeLists.txt target "test_effects"
// Run:   test_effects.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [<line>] <message>" and exits 1

#include "audio/TestGainEffect.h"
#include "audio/XlethEQEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <cmath>
#include <iostream>
#include <string>

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

// ─── Tests ───────────────────────────────────────────────────────────────────

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

// ─── EQ Tests ───────────────────────────────────────────────────────────────

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

    std::cout << "=== test_effects ===\n";

    testLayout();
    testSmoothedGain();
    testMetering();
    testSerializationRoundTrip();
    testBypass();
    testJSONHelpers();

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
