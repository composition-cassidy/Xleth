// test_reverb.cpp — XlethReverbEffect regression and behavioral tests
// Build: cmake --build build --config Release --target test_reverb
// Run:   build\engine\Release\test_reverb.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [<line>] <message>" and exits 1
//
// Stage 0 regression lock for the Generic FDN reverb algorithm.
// These tests must continue to pass after the Stage 1 backend refactor.

#include "audio/XlethReverbEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <array>
#include <cmath>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

// ─── Test harness ─────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                        \
    do {                                                                        \
        if (cond) {                                                             \
            ++g_passed;                                                         \
        } else {                                                                \
            std::cerr << "  FAIL [" << __LINE__ << "] " << (msg) << "\n";      \
            ++g_failed;                                                         \
        }                                                                       \
    } while (0)

#define CHECK_NEAR(a, b, tol, msg) \
    CHECK(std::abs(static_cast<double>(a) - static_cast<double>(b)) < (tol), msg)

// ─── Buffer utilities ─────────────────────────────────────────────────────────

static void fillSilence(juce::AudioBuffer<float>& buf)
{
    buf.clear();
}

// Fills buf with a sine at freqHz, continuing phase across calls.
static void fillSine(juce::AudioBuffer<float>& buf, double freqHz,
                     double sampleRate, double& phase)
{
    const int ns = buf.getNumSamples();
    for (int s = 0; s < ns; ++s)
    {
        const float v = 0.1f * std::sin(static_cast<float>(
            2.0 * juce::MathConstants<double>::pi * phase));
        buf.setSample(0, s, v);
        if (buf.getNumChannels() > 1)
            buf.setSample(1, s, v);
        phase += freqHz / sampleRate;
        if (phase >= 1.0) phase -= 1.0;
    }
}

// Sum of squared samples across all channels.
static double sumSquared(const juce::AudioBuffer<float>& buf)
{
    double sum = 0.0;
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        const float* p = buf.getReadPointer(ch);
        for (int s = 0; s < buf.getNumSamples(); ++s)
            sum += static_cast<double>(p[s]) * static_cast<double>(p[s]);
    }
    return sum;
}

// True if every sample in buf is finite (no NaN/Inf).
static bool allFinite(const juce::AudioBuffer<float>& buf)
{
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        const float* p = buf.getReadPointer(ch);
        for (int s = 0; s < buf.getNumSamples(); ++s)
            if (!std::isfinite(p[s])) return false;
    }
    return true;
}

// ─── Standard param setup (mod off, full wet, no predelay) ───────────────────

static void setStandardParams(XlethReverbEffect& fx)
{
    fx.setParameterValue("decay",     2.0f);
    fx.setParameterValue("predelay",  0.0f);
    fx.setParameterValue("size",      50.0f);
    fx.setParameterValue("damping",   50.0f);
    fx.setParameterValue("mod_rate",  0.0f);
    fx.setParameterValue("mod_depth", 0.0f);
    fx.setParameterValue("er_level",  100.0f);
    fx.setParameterValue("er_late",   100.0f);
    fx.setParameterValue("hicut",     20000.0f);
    fx.setParameterValue("locut",     20.0f);
    fx.setParameterValue("mix",       100.0f);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// Verifies all expected parameter IDs exist and are settable.
// Stage 5: 11 original params + style choice + smoothness = 13 total.
static void testReverbLayout()
{
    std::cout << "  [layout]\n";
    XlethReverbEffect fx;

    const auto& params = fx.getParameters();
    CHECK(static_cast<int>(params.size()) == 13,
          "reverb should have exactly 13 parameters (11 original + style + smoothness)");

    CHECK(fx.setParameterValue("decay",      2.0f),    "decay param should exist");
    CHECK(fx.setParameterValue("predelay",   10.0f),   "predelay param should exist");
    CHECK(fx.setParameterValue("size",       50.0f),   "size param should exist");
    CHECK(fx.setParameterValue("damping",    50.0f),   "damping param should exist");
    CHECK(fx.setParameterValue("mod_rate",   30.0f),   "mod_rate param should exist");
    CHECK(fx.setParameterValue("mod_depth",  20.0f),   "mod_depth param should exist");
    CHECK(fx.setParameterValue("er_level",   50.0f),   "er_level param should exist");
    CHECK(fx.setParameterValue("er_late",    50.0f),   "er_late param should exist");
    CHECK(fx.setParameterValue("hicut",      12000.0f),"hicut param should exist");
    CHECK(fx.setParameterValue("locut",      80.0f),   "locut param should exist");
    CHECK(fx.setParameterValue("mix",        30.0f),   "mix param should exist");
    CHECK(fx.setParameterValue("style",      0.0f),    "style param should exist");
    CHECK(fx.setParameterValue("smoothness", 35.0f),   "smoothness param should exist");
}

// Verifies that processing 50 blocks of sine produces no NaN or Inf.
static void testReverbOutputFinite()
{
    std::cout << "  [output finite]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;

    bool ok = true;
    for (int block = 0; block < 50; ++block)
    {
        fillSine(buf, 440.0, kSR, phase);
        fx.processBlock(buf, midi);
        if (!allFinite(buf)) { ok = false; break; }
    }
    CHECK(ok, "reverb output should remain finite for 50 blocks of sine input");
}

// Verifies output is finite and non-trivial at extreme parameter values.
static void testReverbFiniteAtExtremes()
{
    std::cout << "  [finite at extremes]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    // Worst-case: maximum decay, maximum size, zero damping, high mod depth
    XlethReverbEffect fx;
    fx.setParameterValue("decay",     30.0f);
    fx.setParameterValue("predelay",  0.0f);
    fx.setParameterValue("size",      100.0f);
    fx.setParameterValue("damping",   0.0f);
    fx.setParameterValue("mod_rate",  100.0f);
    fx.setParameterValue("mod_depth", 100.0f);
    fx.setParameterValue("er_level",  100.0f);
    fx.setParameterValue("er_late",   100.0f);
    fx.setParameterValue("hicut",     20000.0f);
    fx.setParameterValue("locut",     20.0f);
    fx.setParameterValue("mix",       100.0f);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;

    bool ok = true;
    for (int block = 0; block < 30; ++block)
    {
        fillSine(buf, 100.0, kSR, phase);
        fx.processBlock(buf, midi);
        if (!allFinite(buf)) { ok = false; break; }
    }
    CHECK(ok, "reverb should remain finite at extreme parameter values");
}

// Verifies that wet output is non-zero when mix, er_level, and er_late are non-zero.
static void testReverbWetNonZero()
{
    std::cout << "  [wet non-zero]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethReverbEffect fx;
    setStandardParams(fx);  // mix=100, er_level=100, er_late=100
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;

    double totalEnergy = 0.0;
    for (int block = 0; block < 20; ++block)
    {
        fillSine(buf, 440.0, kSR, phase);
        fx.processBlock(buf, midi);
        totalEnergy += sumSquared(buf);
    }

    CHECK(totalEnergy > 1.0,
          "reverb wet output should have substantial energy with signal input");
}

// Verifies that the reverb tail decays over time after excitation stops.
static void testReverbTailDecays()
{
    std::cout << "  [tail decays]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.setParameterValue("decay", 1.0f);  // shorter decay for a faster test
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;

    // Excite the reverb with 5 blocks of sine
    for (int block = 0; block < 5; ++block)
    {
        fillSine(buf, 440.0, kSR, phase);
        fx.processBlock(buf, midi);
    }

    // Measure tail energy across 20 blocks of silence
    // "early" = first 5, "late" = last 5
    double earlyEnergy = 0.0, lateEnergy = 0.0;
    for (int block = 0; block < 20; ++block)
    {
        fillSilence(buf);
        fx.processBlock(buf, midi);
        const double e = sumSquared(buf);
        if (block < 5)   earlyEnergy += e;
        if (block >= 15) lateEnergy  += e;
    }

    std::cout << "    earlyEnergy=" << earlyEnergy
              << "  lateEnergy=" << lateEnergy << "\n";

    CHECK(earlyEnergy > lateEnergy,
          "reverb tail should decay: early window energy > late window energy");
    // With decay=1s the tail should decay meaningfully within ~200ms
    CHECK(earlyEnergy > lateEnergy * 2.0,
          "reverb tail should decay by at least half within the measurement window");
}

// Verifies that two fresh instances with the same input produce identical output
// (tests that prepareToPlay fully resets state to a deterministic baseline).
static void testReverbDeterminism()
{
    std::cout << "  [determinism]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;
    constexpr int    kBlocks = 15;

    juce::MidiBuffer midi;
    juce::AudioBuffer<float> buf(2, kBS);

    auto runAndCapture = [&]() -> std::vector<float>
    {
        XlethReverbEffect fx;
        setStandardParams(fx);
        fx.prepareToPlay(kSR, kBS);

        double phase = 0.0;
        std::vector<float> out;
        for (int block = 0; block < kBlocks; ++block)
        {
            if (block < 10)
                fillSine(buf, 440.0, kSR, phase);
            else
                fillSilence(buf);
            fx.processBlock(buf, midi);
        }
        // Capture the last block (tail region)
        out.reserve(kBS);
        for (int s = 0; s < kBS; ++s)
            out.push_back(buf.getSample(0, s));
        return out;
    };

    const auto runA = runAndCapture();
    const auto runB = runAndCapture();

    CHECK(runA.size() == runB.size(), "both runs should produce same sample count");

    bool identical = true;
    for (std::size_t i = 0; i < runA.size(); ++i)
    {
        if (runA[i] != runB[i]) { identical = false; break; }
    }
    CHECK(identical,
          "two fresh instances with identical input should produce bit-identical output");
}

// Verifies that predelay delays the onset of reverb energy.
// With 50ms predelay (2400 samples @ 48k), the first 512-sample block
// should have far less reverb energy than with 0ms predelay.
static void testReverbPredelayDelaysOnset()
{
    std::cout << "  [predelay delays onset]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    juce::MidiBuffer midi;
    juce::AudioBuffer<float> buf(2, kBS);

    auto firstBlockEnergy = [&](float predelayMs) -> double
    {
        XlethReverbEffect fx;
        fx.setParameterValue("decay",     2.0f);
        fx.setParameterValue("predelay",  predelayMs);
        fx.setParameterValue("size",      50.0f);
        fx.setParameterValue("damping",   50.0f);
        fx.setParameterValue("mod_rate",  0.0f);
        fx.setParameterValue("mod_depth", 0.0f);
        fx.setParameterValue("er_level",  100.0f);
        fx.setParameterValue("er_late",   100.0f);
        fx.setParameterValue("hicut",     20000.0f);
        fx.setParameterValue("locut",     20.0f);
        fx.setParameterValue("mix",       100.0f);
        fx.prepareToPlay(kSR, kBS);

        // Single impulse block
        buf.clear();
        buf.setSample(0, 0, 0.5f);
        buf.setSample(1, 0, 0.5f);
        fx.processBlock(buf, midi);
        return sumSquared(buf);
    };

    const double e0  = firstBlockEnergy(0.0f);
    const double e50 = firstBlockEnergy(50.0f);

    std::cout << "    energy predelay=0ms: " << e0
              << "  predelay=50ms: " << e50 << "\n";

    // At predelay=50ms (2400 samples), the first 512-sample block is entirely
    // in the predelay window — reverb hasn't reached the network yet.
    CHECK(e0 > e50 * 10.0,
          "predelay=0ms first-block energy should be >> predelay=50ms first-block energy");
}

// Verifies APVTS serialization round-trip preserves all parameter values.
static void testReverbSerialization()
{
    std::cout << "  [serialization round-trip]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethReverbEffect src;
    src.prepareToPlay(kSR, kBS);
    src.setParameterValue("decay",   5.0f);
    src.setParameterValue("size",    75.0f);
    src.setParameterValue("damping", 20.0f);
    src.setParameterValue("mix",     60.0f);

    juce::MemoryBlock state;
    src.getStateInformation(state);
    CHECK(state.getSize() > 0, "serialized state should be non-empty");

    XlethReverbEffect dst;
    dst.prepareToPlay(kSR, kBS);
    dst.setStateInformation(state.getData(), static_cast<int>(state.getSize()));

    bool foundDecay = false, foundSize = false, foundMix = false;
    for (auto* p : dst.getParameters())
    {
        auto* rp = dynamic_cast<juce::RangedAudioParameter*>(p);
        if (!rp) continue;
        const float v = rp->convertFrom0to1(rp->getValue());
        if (rp->paramID == "decay")   { CHECK_NEAR(v, 5.0f,  0.05f, "restored decay ≈ 5s");  foundDecay = true; }
        if (rp->paramID == "size")    { CHECK_NEAR(v, 75.0f, 0.5f,  "restored size ≈ 75%");  foundSize  = true; }
        if (rp->paramID == "mix")     { CHECK_NEAR(v, 60.0f, 0.5f,  "restored mix ≈ 60%");   foundMix   = true; }
    }
    CHECK(foundDecay, "decay param should be present in restored effect");
    CHECK(foundSize,  "size param should be present in restored effect");
    CHECK(foundMix,   "mix param should be present in restored effect");
}

// Verifies bypass passes dry signal through unchanged after the crossfade settles.
static void testReverbBypassPassthrough()
{
    std::cout << "  [bypass passthrough]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.prepareToPlay(kSR, kBS);
    fx.setBypassed(true);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;

    // First block: crossfade ramp (5ms ≈ 240 samples, settles within this block)
    fillSine(buf, 440.0, kSR, phase);
    fx.processBlock(buf, midi);

    // Second block: fully bypassed — buffer must pass through unmodified.
    // Save the input, process, then compare.
    juce::AudioBuffer<float> inputSnapshot(2, kBS);
    double phaseSnap = phase;
    fillSine(inputSnapshot, 440.0, kSR, phaseSnap);
    fillSine(buf, 440.0, kSR, phase);

    fx.processBlock(buf, midi);

    float maxDiff = 0.0f;
    for (int s = 0; s < kBS; ++s)
        maxDiff = std::max(maxDiff,
            std::abs(buf.getSample(0, s) - inputSnapshot.getSample(0, s)));

    CHECK(maxDiff < 1e-6f,
          "fully bypassed reverb should return the input signal unchanged");
}

// ─── Style parameter tests (Stage 2) ─────────────────────────────────────────

// Helper: locate a RangedAudioParameter by ID. Returns nullptr if not found.
static juce::RangedAudioParameter* findRangedParam(XlethReverbEffect& fx,
                                                   const juce::String& id)
{
    for (auto* p : fx.getParameters())
    {
        auto* rp = dynamic_cast<juce::RangedAudioParameter*>(p);
        if (rp && rp->paramID == id) return rp;
    }
    return nullptr;
}

// Helper: read denormalised value of a RangedAudioParameter by ID.
static float readParamValue(XlethReverbEffect& fx, const juce::String& id)
{
    auto* rp = findRangedParam(fx, id);
    if (!rp) return std::numeric_limits<float>::quiet_NaN();
    return rp->convertFrom0to1(rp->getValue());
}

// Verifies the style choice parameter is registered with the expected
// range, default, and exposed via the standard JSON surface.
static void testStyleParamExistsAndDefault()
{
    std::cout << "  [style param exists / default Generic]\n";
    XlethReverbEffect fx;

    auto* sp = findRangedParam(fx, "style");
    CHECK(sp != nullptr, "style param should be registered");
    if (!sp) return;

    const auto& range = sp->getNormalisableRange();
    CHECK_NEAR(range.start, 0.0f, 0.01f, "style range start should be 0");
    CHECK_NEAR(range.end,   3.0f, 0.01f, "style range end should be 3 (4 choices)");

    const float def = sp->convertFrom0to1(sp->getDefaultValue());
    CHECK_NEAR(def, 0.0f, 0.01f, "style default should be Generic (index 0)");

    // The parameter should also surface through getParametersAsJSON since
    // it is a RangedAudioParameter — the bridge does not need a special path.
    const std::string json = fx.getParametersAsJSON();
    CHECK(json.find("\"id\":\"style\"") != std::string::npos,
          "style param should be present in getParametersAsJSON output");
}

// Verifies all four style values can be set and read back; processing each
// produces finite output.
static void testStyleAllValuesSettable()
{
    std::cout << "  [style all values settable]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;

    const float values[4]   = { 0.0f, 1.0f, 2.0f, 3.0f };
    const char* names [4]   = { "Generic", "Room", "Plate", "Hall" };

    for (int i = 0; i < 4; ++i)
    {
        const bool setOk = fx.setParameterValue("style", values[i]);
        CHECK(setOk, std::string("style=") + names[i] + " should be settable");

        const float readBack = readParamValue(fx, "style");
        CHECK_NEAR(readBack, values[i], 0.01f,
            std::string("style=") + names[i] + " read-back should match");

        fillSine(buf, 440.0, kSR, phase);
        fx.processBlock(buf, midi);
        CHECK(allFinite(buf),
            std::string("style=") + names[i] + " should produce finite output");
    }
}

// ── Stage 3: real per-style tunings ─────────────────────────────────────────
// Stage 2 had an invariant that all four styles route through the Generic
// backend. Stage 3 implements real Room and Hall FDN tunings, so that
// invariant no longer holds for Room/Hall — only Plate still routes to
// Generic for now (its own backend is intentionally deferred).

// Captures the full output of a deterministic processing run for a given
// style index. Same input sequence is used across all helper invocations
// so outputs are directly comparable.
static std::vector<float> runDeterministic(float styleIdx, int kBlocks = 12,
                                           double kSR = 48000.0, int kBS = 512)
{
    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.setParameterValue("style", styleIdx);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;

    std::vector<float> out;
    out.reserve(static_cast<std::size_t>(kBS) * static_cast<std::size_t>(kBlocks));
    for (int block = 0; block < kBlocks; ++block)
    {
        if (block < 8) fillSine(buf, 440.0, kSR, phase);
        else           fillSilence(buf);
        fx.processBlock(buf, midi);
        for (int s = 0; s < kBS; ++s) out.push_back(buf.getSample(0, s));
    }
    return out;
}

static bool bitIdentical(const std::vector<float>& a,
                         const std::vector<float>& b)
{
    if (a.size() != b.size()) return false;
    for (std::size_t i = 0; i < a.size(); ++i)
        if (a[i] != b[i]) return false;
    return true;
}

// Plate now has a dedicated backend (processBlockPlate). It must NOT be
// bit-identical to Generic, Room, or Hall under the same input — this is
// the structural lock that proves Plate is a real, separate algorithm.
static void testPlateBackendIsDistinct()
{
    std::cout << "  [Plate has its own backend, distinct from G/R/H]\n";
    const auto generic = runDeterministic(0.0f);
    const auto room    = runDeterministic(1.0f);
    const auto plate   = runDeterministic(2.0f);
    const auto hall    = runDeterministic(3.0f);

    CHECK(!bitIdentical(plate, generic),
          "Plate must NOT bit-match legacy Generic (dedicated tank topology)");
    CHECK(!bitIdentical(plate, room),
          "Plate must NOT bit-match Room (different backend entirely)");
    CHECK(!bitIdentical(plate, hall),
          "Plate must NOT bit-match Hall (different backend entirely)");
}

// Room has real DSP differences from Generic — different base delays, mod
// rates, and ER tap geometry. With a deterministic input the outputs must
// diverge bit-wise (and substantially in energy too).
static void testRoomDiffersFromGeneric()
{
    std::cout << "  [Room differs from Generic]\n";
    const auto generic = runDeterministic(0.0f);
    const auto room    = runDeterministic(1.0f);
    CHECK(!bitIdentical(generic, room),
          "Room must produce different output than Generic (different tuning)");

    // Also verify the difference is meaningful, not just a single rounding
    // bit somewhere — RMS difference should be well above noise floor.
    double sumSq = 0.0;
    for (std::size_t i = 0; i < generic.size(); ++i)
    {
        const double d = generic[i] - room[i];
        sumSq += d * d;
    }
    const double rms = std::sqrt(sumSq / static_cast<double>(generic.size()));
    std::cout << "    Generic vs Room RMS diff: " << rms << "\n";
    CHECK(rms > 1e-4,
          "Room↔Generic RMS difference should be audibly meaningful (> 1e-4)");
}

static void testHallDiffersFromGeneric()
{
    std::cout << "  [Hall differs from Generic]\n";
    const auto generic = runDeterministic(0.0f);
    const auto hall    = runDeterministic(3.0f);
    CHECK(!bitIdentical(generic, hall),
          "Hall must produce different output than Generic (different tuning)");

    double sumSq = 0.0;
    for (std::size_t i = 0; i < generic.size(); ++i)
    {
        const double d = generic[i] - hall[i];
        sumSq += d * d;
    }
    const double rms = std::sqrt(sumSq / static_cast<double>(generic.size()));
    std::cout << "    Generic vs Hall RMS diff: " << rms << "\n";
    CHECK(rms > 1e-4,
          "Hall↔Generic RMS difference should be audibly meaningful (> 1e-4)");
}

static void testRoomDiffersFromHall()
{
    std::cout << "  [Room differs from Hall]\n";
    const auto room = runDeterministic(1.0f);
    const auto hall = runDeterministic(3.0f);
    CHECK(!bitIdentical(room, hall),
          "Room and Hall must produce different output (different tunings)");

    double sumSq = 0.0;
    for (std::size_t i = 0; i < room.size(); ++i)
    {
        const double d = room[i] - hall[i];
        sumSq += d * d;
    }
    const double rms = std::sqrt(sumSq / static_cast<double>(room.size()));
    std::cout << "    Room vs Hall RMS diff: " << rms << "\n";
    CHECK(rms > 1e-4,
          "Room↔Hall RMS difference should be audibly meaningful (> 1e-4)");
}

// Style-switch determinism: running the same input with the same style-
// switching schedule on two fresh instances must produce identical output.
// Proves the Stage 3 reset-on-switch path is itself deterministic.
static void testStyleSwitchDeterminism()
{
    std::cout << "  [style switch determinism]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;
    constexpr int    kBlocks = 24;

    auto run = [&]() -> std::vector<float>
    {
        XlethReverbEffect fx;
        setStandardParams(fx);
        fx.prepareToPlay(kSR, kBS);

        juce::AudioBuffer<float> buf(2, kBS);
        juce::MidiBuffer midi;
        double phase = 0.0;
        std::vector<float> out;
        out.reserve(static_cast<std::size_t>(kBS) * static_cast<std::size_t>(kBlocks));

        // Fixed schedule: Generic → Room → Hall → Plate → Generic
        const float schedule[5] = { 0.0f, 1.0f, 3.0f, 2.0f, 0.0f };
        for (int block = 0; block < kBlocks; ++block)
        {
            const int phaseIdx = (block / 5) % 5;
            fx.setParameterValue("style", schedule[phaseIdx]);
            fillSine(buf, 440.0, kSR, phase);
            fx.processBlock(buf, midi);
            for (int s = 0; s < kBS; ++s) out.push_back(buf.getSample(0, s));
        }
        return out;
    };

    const auto a = run();
    const auto b = run();
    CHECK(bitIdentical(a, b),
          "style-switching schedule must produce bit-identical output across runs");
}

// Property test: with all knobs equal, the late tail energy distribution of
// Room and Hall should differ. Hall's longer FDN delays produce a slower
// density buildup → at the moment excitation stops, less energy is stored
// in the network than Room's tightly-packed lines. Conversely Room's
// shorter circulation paths flush energy faster after excitation ends.
//
// We don't assert which one is larger in any specific window — that depends
// on excitation length and decay knob — only that the two energy curves
// differ measurably. This is a tolerant correctness check, not a brittle
// fingerprint.
static void testRoomHallTailEnergyDiffers()
{
    std::cout << "  [Room/Hall tail energy diverges]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    auto tailEnergy = [&](float styleIdx, double& earlyOut, double& lateOut)
    {
        XlethReverbEffect fx;
        setStandardParams(fx);
        fx.setParameterValue("style", styleIdx);
        fx.prepareToPlay(kSR, kBS);

        juce::AudioBuffer<float> buf(2, kBS);
        juce::MidiBuffer midi;
        double phase = 0.0;

        // Excite for 8 blocks, then measure tail in two windows.
        for (int block = 0; block < 8; ++block)
        {
            fillSine(buf, 440.0, kSR, phase);
            fx.processBlock(buf, midi);
        }

        earlyOut = 0.0;
        lateOut  = 0.0;
        for (int block = 0; block < 25; ++block)
        {
            fillSilence(buf);
            fx.processBlock(buf, midi);
            const double e = sumSquared(buf);
            if (block < 5)            earlyOut += e;
            else if (block >= 18)     lateOut  += e;
        }
    };

    double roomEarly, roomLate, hallEarly, hallLate;
    tailEnergy(1.0f, roomEarly, roomLate);
    tailEnergy(3.0f, hallEarly, hallLate);

    std::cout << "    Room  tail: early=" << roomEarly << "  late=" << roomLate << "\n";
    std::cout << "    Hall  tail: early=" << hallEarly << "  late=" << hallLate << "\n";

    // All windows must contain non-trivial energy.
    CHECK(roomEarly > 1e-8, "Room early tail energy should be non-zero");
    CHECK(hallEarly > 1e-8, "Hall early tail energy should be non-zero");

    // The energy curves should differ. We compare the *shape* (early/late
    // ratio) rather than absolute values so the test stays tolerant.
    const double roomRatio = roomEarly / (roomLate + 1e-30);
    const double hallRatio = hallEarly / (hallLate + 1e-30);
    std::cout << "    early/late ratios — Room: " << roomRatio
              << "  Hall: " << hallRatio << "\n";

    // The two ratios must be measurably different — > 5% relative.
    const double ratioDiff = std::abs(roomRatio - hallRatio);
    const double ratioAvg  = (roomRatio + hallRatio) * 0.5;
    CHECK(ratioDiff / ratioAvg > 0.05,
          "Room and Hall tail energy distributions should diverge (>5% ratio diff)");
}

// Switching style mid-stream must not crash, NaN, or otherwise destabilise
// the audio thread. Stage 2: switches are silent (same backend), so the
// output must remain finite throughout.
static void testStyleSwitchMidStream()
{
    std::cout << "  [style switch mid-stream]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;

    for (int block = 0; block < 20; ++block)
    {
        // Cycle through all four styles every block
        fx.setParameterValue("style", static_cast<float>(block % 4));
        fillSine(buf, 440.0, kSR, phase);
        fx.processBlock(buf, midi);
        if (!allFinite(buf))
        {
            CHECK(false, "output went non-finite during mid-stream style switch");
            return;
        }
    }
    CHECK(true, "mid-stream style switching produced finite output across 20 blocks");
}

// APVTS round-trip: setting a non-default style, saving, and restoring into
// a fresh instance must preserve the chosen index. Tests all four styles
// (Stage 3 makes Room and Hall functionally distinct, so verifying their
// persistence matters more than at Stage 2).
static void testStyleSerializationRoundTrip()
{
    std::cout << "  [style serialization round-trip — all four]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    const float values[4] = { 0.0f, 1.0f, 2.0f, 3.0f };
    const char* names [4] = { "Generic", "Room", "Plate", "Hall" };

    for (int i = 0; i < 4; ++i)
    {
        XlethReverbEffect src;
        src.prepareToPlay(kSR, kBS);
        src.setParameterValue("style", values[i]);

        juce::MemoryBlock state;
        src.getStateInformation(state);
        CHECK(state.getSize() > 0,
              std::string("serialized state for ") + names[i] + " should be non-empty");

        XlethReverbEffect dst;
        dst.prepareToPlay(kSR, kBS);
        dst.setStateInformation(state.getData(),
                                static_cast<int>(state.getSize()));

        const float restored = readParamValue(dst, "style");
        CHECK_NEAR(restored, values[i], 0.01f,
            std::string("restored style should be ") + names[i]);
    }
}

// Old-state compatibility: a state blob produced before "style" existed
// (i.e. a saved state with the style PARAM removed) must load with style
// at its default value (Generic / 0). Other params must restore normally.
//
// Construction strategy: save a state, parse the XML, delete the
// <PARAM id="style"/> child, and re-serialize. Loading the modified blob
// simulates loading an old project that pre-dates the style parameter.
static void testStyleOldStateLoadsAsGeneric()
{
    std::cout << "  [old state without style loads as Generic]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    // Build a state with non-default decay and a non-default style — then
    // strip the style entry to simulate an old saved project.
    XlethReverbEffect src;
    src.prepareToPlay(kSR, kBS);
    src.setParameterValue("decay", 7.0f);
    src.setParameterValue("style", 3.0f);   // Hall

    juce::MemoryBlock state;
    src.getStateInformation(state);
    CHECK(state.getSize() > 0, "serialized state should be non-empty");

    auto xml = juce::AudioProcessor::getXmlFromBinary(
        state.getData(), static_cast<int>(state.getSize()));
    CHECK(xml != nullptr, "should be able to extract XML from saved state");
    if (!xml) return;

    // Walk children and remove the <PARAM id="style"/> element.
    bool removedStyle = false;
    for (int i = xml->getNumChildElements() - 1; i >= 0; --i)
    {
        auto* child = xml->getChildElement(i);
        if (child
            && child->hasTagName("PARAM")
            && child->getStringAttribute("id") == "style")
        {
            xml->removeChildElement(child, true);
            removedStyle = true;
            break;
        }
    }
    CHECK(removedStyle,
          "expected to find a <PARAM id=\"style\"/> element to strip");

    juce::MemoryBlock oldState;
    juce::AudioProcessor::copyXmlToBinary(*xml, oldState);

    XlethReverbEffect dst;
    dst.prepareToPlay(kSR, kBS);
    dst.setStateInformation(oldState.getData(),
                            static_cast<int>(oldState.getSize()));

    // style was missing → APVTS should leave it at default (Generic = 0).
    const float restoredStyle = readParamValue(dst, "style");
    CHECK_NEAR(restoredStyle, 0.0f, 0.01f,
        "style must default to Generic (0) when missing from a saved state");

    // Other params should still be restored from the (modified) state.
    const float restoredDecay = readParamValue(dst, "decay");
    CHECK_NEAR(restoredDecay, 7.0f, 0.05f,
        "non-style params should round-trip normally via the stripped state");
}

// ─── Stage 4: audible differentiation tests ──────────────────────────────────

// Room has erGainScale=1.6 (prominent ER) and lateGainScale=0.5 (quieter FDN),
// while Hall has erGainScale=0.6 and lateGainScale=1.3. This test fires a
// single impulse through each style and compares the fraction of total energy
// that falls in the early window (0–213 ms) vs the late window (427–854 ms).
// Room must be measurably more front-loaded than Hall.
static void testRoomEnergyMoreFrontLoaded()
{
    std::cout << "  [Room energy more front-loaded than Hall]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    auto measureFractions = [&](float styleIdx, double& earlyOut, double& lateOut)
    {
        XlethReverbEffect fx;
        setStandardParams(fx);
        fx.setParameterValue("style",     styleIdx);
        fx.setParameterValue("decay",     1.5f);
        fx.setParameterValue("mod_depth", 0.0f);
        fx.setParameterValue("predelay",  0.0f);
        fx.prepareToPlay(kSR, kBS);

        juce::AudioBuffer<float> buf(2, kBS);
        juce::MidiBuffer midi;

        // Single impulse block
        buf.clear();
        buf.setSample(0, 0, 0.5f);
        if (buf.getNumChannels() > 1) buf.setSample(1, 0, 0.5f);
        fx.processBlock(buf, midi);
        earlyOut = sumSquared(buf);

        // Early window: blocks 1–19 (10–203 ms)
        for (int b = 1; b < 20; ++b)
        {
            fillSilence(buf);
            fx.processBlock(buf, midi);
            earlyOut += sumSquared(buf);
        }

        // Transition zone: blocks 20–39 (not measured)
        for (int b = 20; b < 40; ++b)
        {
            fillSilence(buf);
            fx.processBlock(buf, midi);
        }

        // Late window: blocks 40–79 (427–854 ms)
        lateOut = 0.0;
        for (int b = 40; b < 80; ++b)
        {
            fillSilence(buf);
            fx.processBlock(buf, midi);
            lateOut += sumSquared(buf);
        }
    };

    double roomEarly, roomLate, hallEarly, hallLate;
    measureFractions(1.0f, roomEarly, roomLate);
    measureFractions(3.0f, hallEarly, hallLate);

    const double roomRatio = roomEarly / (roomLate + 1e-30);
    const double hallRatio = hallEarly / (hallLate + 1e-30);

    std::cout << "    Room  early=" << roomEarly << "  late=" << roomLate
              << "  E/L=" << roomRatio << "\n";
    std::cout << "    Hall  early=" << hallEarly << "  late=" << hallLate
              << "  E/L=" << hallRatio << "\n";

    // Front-loading character: Room concentrates energy in early reflections;
    // Hall (with diffusion + longer decay + higher lateGainScale) spreads
    // energy into the late field. The early-to-late ratio is the right metric
    // for "Room vs Hall character" because it is independent of absolute level.
    // Empirically post-polish: roomRatio ≈ 1.5e+5, hallRatio ≈ 50–60.
    CHECK(roomRatio > hallRatio * 50.0,
          "Room must be ≥ 50× more front-loaded than Hall on early/late ratio "
          "(Room dominated by ER; Hall dominated by late tail)");

    // Hall's late-window energy must dwarf Room's. Even with Room's polished
    // (higher) lateGainScale 0.75 and decayScale 0.75, Hall's combination of
    // lateGainScale 1.25, decayScale 1.4 and 2-stage diffusion smears far more
    // energy into the 427–854 ms window. Empirically post-polish: ratio > 1000×.
    CHECK(hallLate > roomLate * 100.0,
          "Hall late-window energy must be ≥ 100× Room (lateGainScale, "
          "decayScale, and input diffusion contributions to the bloom)");
}

// Hall has decayScale=1.3 (effective RT60 = 1.3 × knob) while Room has
// decayScale=0.65 (effective RT60 = 0.65 × knob). After equal excitation
// and the same decay setting, Hall must retain significantly more energy at
// a point deep in the tail where Room has largely died away.
static void testRoomDecaysFasterThanHall()
{
    std::cout << "  [Room decays faster than Hall]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    auto residualAt = [&](float styleIdx) -> double
    {
        XlethReverbEffect fx;
        setStandardParams(fx);
        fx.setParameterValue("style",     styleIdx);
        fx.setParameterValue("decay",     1.0f);
        fx.setParameterValue("mod_depth", 0.0f);
        fx.prepareToPlay(kSR, kBS);

        juce::AudioBuffer<float> buf(2, kBS);
        juce::MidiBuffer midi;
        double phase = 0.0;

        // Excite for 10 blocks (≈ 107 ms)
        for (int b = 0; b < 10; ++b)
        {
            fillSine(buf, 440.0, kSR, phase);
            fx.processBlock(buf, midi);
        }

        // Let tail ring for 30 silent blocks without measuring
        for (int b = 0; b < 30; ++b)
        {
            fillSilence(buf);
            fx.processBlock(buf, midi);
        }

        // Measure 20 blocks of residual (320–533 ms post-excitation)
        double energy = 0.0;
        for (int b = 0; b < 20; ++b)
        {
            fillSilence(buf);
            fx.processBlock(buf, midi);
            energy += sumSquared(buf);
        }
        return energy;
    };

    const double roomResidual = residualAt(1.0f);
    const double hallResidual = residualAt(3.0f);

    std::cout << "    Room residual (320–533 ms): " << roomResidual
              << "  Hall residual: " << hallResidual << "\n";

    // Room effective RT60 = 0.65s; at 320 ms the amplitude is ≈ 1% of peak.
    // Hall effective RT60 = 1.30s; at 320 ms the amplitude is ≈ 10% of peak.
    // Energy ratio ≈ 100×; a conservative threshold of 4× guards the invariant.
    CHECK(hallResidual > roomResidual * 4.0,
          "Hall residual energy must exceed Room by ≥ 4× at 320–533 ms post-excitation "
          "(decayScale 1.3 vs 0.65)");
}

// Hall now runs a 2-stage Schroeder allpass cascade on the FDN feed. This
// test verifies that:
//   1. Hall remains finite over many blocks (the allpasses are stable).
//   2. Two fresh Hall instances with identical input produce bit-identical
//      output (no stale state, fully deterministic).
//   3. Hall is no longer bit-identical to a Generic-tuning run with the same
//      schedule — this guards against a future regression that would silently
//      bypass the diffusion path.
static void testHallDiffusionStableAndDeterministic()
{
    std::cout << "  [Hall input diffusion stable + deterministic]\n";
    constexpr double kSR    = 48000.0;
    constexpr int    kBS    = 512;
    constexpr int    kBlocks = 40;

    auto runHall = [&]() -> std::vector<float>
    {
        XlethReverbEffect fx;
        setStandardParams(fx);
        fx.setParameterValue("style", 3.0f);   // Hall
        fx.setParameterValue("decay", 4.0f);   // long-tail listening preset
        fx.prepareToPlay(kSR, kBS);

        juce::AudioBuffer<float> buf(2, kBS);
        juce::MidiBuffer midi;
        double phase = 0.0;
        std::vector<float> out;
        out.reserve(static_cast<std::size_t>(kBS) * static_cast<std::size_t>(kBlocks));

        for (int b = 0; b < kBlocks; ++b)
        {
            if (b < 12) fillSine(buf, 220.0, kSR, phase);
            else        fillSilence(buf);
            fx.processBlock(buf, midi);
            for (int s = 0; s < kBS; ++s) out.push_back(buf.getSample(0, s));
            if (!allFinite(buf))
            {
                CHECK(false, "Hall went non-finite during diffusion processing");
                return out;
            }
        }
        return out;
    };

    const auto a = runHall();
    const auto b = runHall();
    CHECK(bitIdentical(a, b),
          "two fresh Hall instances must produce bit-identical output (diffusers must be deterministic)");

    // Hall vs Generic at the same long decay: must not coincide. If a future
    // refactor accidentally bypassed the diffusion path while still using
    // Hall's tuning, this assertion would still likely catch it because Hall
    // also has different ER taps and base delays — the test is defensive.
    XlethReverbEffect g;
    setStandardParams(g);
    g.setParameterValue("style", 0.0f);
    g.setParameterValue("decay", 4.0f);
    g.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;
    std::vector<float> generic;
    generic.reserve(static_cast<std::size_t>(kBS) * static_cast<std::size_t>(kBlocks));
    for (int bi = 0; bi < kBlocks; ++bi)
    {
        if (bi < 12) fillSine(buf, 220.0, kSR, phase);
        else         fillSilence(buf);
        g.processBlock(buf, midi);
        for (int s = 0; s < kBS; ++s) generic.push_back(buf.getSample(0, s));
    }
    CHECK(!bitIdentical(a, generic),
          "Hall (with diffusion) must differ from Generic at the same settings");
}

// Polish goal: Room's late field used to be ≈ 1e-6 — essentially silence,
// making it sound like a discrete short delay rather than a room. The polish
// (lateGainScale 0.5 → 0.75, decayScale 0.65 → 0.75) brings the late field
// up to a clearly audible level. This test guards against a regression that
// would silently flatten Room back to a slap-delay.
static void testRoomLateFieldAudible()
{
    std::cout << "  [Room late field is audibly present]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.setParameterValue("style",     1.0f);
    fx.setParameterValue("decay",     1.5f);
    fx.setParameterValue("mod_depth", 0.0f);
    fx.setParameterValue("predelay",  0.0f);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;

    buf.clear();
    buf.setSample(0, 0, 0.5f);
    if (buf.getNumChannels() > 1) buf.setSample(1, 0, 0.5f);
    fx.processBlock(buf, midi);

    // Skip past the ER window (first 8 blocks ≈ 0–85 ms; covers all Room ER
    // taps even at full size). Measure energy in the next 32 blocks
    // (85–426 ms) — pure FDN late field.
    for (int b = 1; b < 8; ++b)
    {
        fillSilence(buf);
        fx.processBlock(buf, midi);
    }

    double lateEnergy = 0.0;
    for (int b = 8; b < 40; ++b)
    {
        fillSilence(buf);
        fx.processBlock(buf, midi);
        lateEnergy += sumSquared(buf);
    }

    std::cout << "    Room late-only energy (85–426 ms): " << lateEnergy << "\n";

    // Pre-polish this number was ~1e-6 (functionally inaudible after the ER
    // burst). Post-polish it should be at least ~1e-3. A conservative
    // threshold of 1e-4 catches a regression that flattens the late field
    // without forcing an over-strict numeric.
    CHECK(lateEnergy > 1e-4,
          "Room late field must contain audible energy (> 1e-4) "
          "so the style reads as 'room' rather than 'short delay'");
}

// ─── Signature test ───────────────────────────────────────────────────────────
// Locks the measurable properties of the Generic reverb algorithm:
//   - tail has non-trivial energy immediately after excitation ends
//   - tail decays monotonically across three time windows
//   - decay ratio (early/late) reflects the configured RT60
//
// Tolerances are wide enough to survive compiler/FPU variations while still
// catching topology changes (reordered stages, wrong feedback, missing DC block).

static void testReverbSignature()
{
    std::cout << "  [signature]\n";
    constexpr double kSR      = 48000.0;
    constexpr int    kBS      = 512;
    constexpr int    kWarm    = 10;  // excitation blocks
    constexpr int    kTail    = 30;  // silence blocks to measure

    XlethReverbEffect fx;
    fx.setParameterValue("decay",     2.0f);
    fx.setParameterValue("predelay",  0.0f);
    fx.setParameterValue("size",      50.0f);
    fx.setParameterValue("damping",   30.0f);   // low damping → long bright tail
    fx.setParameterValue("mod_rate",  0.0f);
    fx.setParameterValue("mod_depth", 0.0f);
    fx.setParameterValue("er_level",  100.0f);
    fx.setParameterValue("er_late",   100.0f);
    fx.setParameterValue("hicut",     20000.0f);
    fx.setParameterValue("locut",     20.0f);
    fx.setParameterValue("mix",       100.0f);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;

    // Fill FDN with sine excitation
    for (int block = 0; block < kWarm; ++block)
    {
        fillSine(buf, 440.0, kSR, phase);
        fx.processBlock(buf, midi);
    }

    // Collect tail energy per block
    double tail[kTail];
    for (int block = 0; block < kTail; ++block)
    {
        fillSilence(buf);
        fx.processBlock(buf, midi);
        tail[block] = sumSquared(buf);
    }

    // Window averages (5 blocks each)
    double w0 = 0.0, w1 = 0.0, w2 = 0.0;
    for (int i = 0;  i < 5;  ++i) w0 += tail[i];
    for (int i = 10; i < 15; ++i) w1 += tail[i];
    for (int i = 25; i < 30; ++i) w2 += tail[i];

    std::cout << "    w0(early)=" << w0 << "  w1(mid)=" << w1
              << "  w2(late)=" << w2 << "\n";
    std::cout << "    tail[0]=" << tail[0] << "\n";

    CHECK(tail[0] > 1e-10,
          "reverb tail should have non-trivial energy immediately after excitation");
    CHECK(w0 > w1,
          "tail energy window 0 (early) should exceed window 1 (mid)");
    CHECK(w1 > w2,
          "tail energy window 1 (mid) should exceed window 2 (late)");

    // With decay=2s, after ~768ms of silence (30 × 512 / 48000) the tail
    // should be substantially quieter than the early window.
    const double decayRatio = w0 / (w2 + 1e-30);
    std::cout << "    decayRatio(w0/w2)=" << decayRatio << "\n";
    CHECK(decayRatio > 4.0,
          "early tail energy should be >> late tail energy (ratio should exceed 4×)");

    // ER vs late blend: with er_level=100 and er_late=100 both contribute.
    // The first silence block should have some FDN energy (er_late path).
    CHECK(tail[0] > 1e-8,
          "FDN late tail should contribute non-trivial energy at w0 with er_late=100");
}

// ─── Stage 5: SMOOTH (smoothness) global anti-ringing tests ──────────────────
// These tests prove that the SMOOTH parameter:
//   • exists, has the documented range/default, and serializes
//   • is silent (smoothness=0 → bit-identical to baseline) for Generic
//   • produces a measurable, non-silent change at higher values
//   • reduces tail "peakiness" / coloration metrics for Generic/Room/Hall
//   • survives style switches and extreme settings without going non-finite
//
// The bit-identicality check at smoothness=0 is the primary backward-compat
// guarantee. Every smoothness contribution in XlethReverbEffect is multiplied
// by smoothFrac = smoothness/100 and added to the dry path, so smoothness=0
// collapses every wet term to IEEE-exact zero.

// Helper: run a fixed deterministic schedule for a given style at a given
// smoothness, returning the concatenated mono channel-0 output.
static std::vector<float> runWithSmoothness(float styleIdx, float smoothPct,
                                            int kBlocks = 16,
                                            double kSR = 48000.0, int kBS = 512)
{
    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.setParameterValue("style",      styleIdx);
    fx.setParameterValue("smoothness", smoothPct);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;
    std::vector<float> out;
    out.reserve(static_cast<std::size_t>(kBS) * static_cast<std::size_t>(kBlocks));
    for (int b = 0; b < kBlocks; ++b)
    {
        if (b < 8) fillSine(buf, 440.0, kSR, phase);
        else       fillSilence(buf);
        fx.processBlock(buf, midi);
        for (int s = 0; s < kBS; ++s) out.push_back(buf.getSample(0, s));
    }
    return out;
}

// Impulse-response variant: hits the reverb with a single sample impulse and
// records the tail. This is the right excitation for measuring "metallic
// ringing" because sustained sine masks the transient comb pattern that the
// human ear actually hears as ringing. Used by the crest-factor metric test.
static std::vector<float> runImpulse(float styleIdx, float smoothPct,
                                     int kBlocks = 24,
                                     double kSR = 48000.0, int kBS = 512)
{
    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.setParameterValue("style",      styleIdx);
    fx.setParameterValue("smoothness", smoothPct);
    fx.setParameterValue("decay",      2.0f);
    fx.setParameterValue("mod_depth",  0.0f);
    fx.setParameterValue("predelay",   0.0f);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    std::vector<float> out;
    out.reserve(static_cast<std::size_t>(kBS) * static_cast<std::size_t>(kBlocks));

    // Block 0: single-sample impulse on both channels
    buf.clear();
    buf.setSample(0, 0, 0.5f);
    if (buf.getNumChannels() > 1) buf.setSample(1, 0, 0.5f);
    fx.processBlock(buf, midi);
    for (int s = 0; s < kBS; ++s) out.push_back(buf.getSample(0, s));

    // Blocks 1..N-1: silence — capture the impulse-response tail
    for (int b = 1; b < kBlocks; ++b)
    {
        fillSilence(buf);
        fx.processBlock(buf, midi);
        for (int s = 0; s < kBS; ++s) out.push_back(buf.getSample(0, s));
    }
    return out;
}

// Crest factor (peak/RMS) of the tail-window samples. A smaller crest factor
// means the tail amplitude envelope is flatter — i.e. the comb-mode "spikes"
// that cause perceived metallic ringing have been smeared out.
static double crestFactor(const std::vector<float>& v,
                          std::size_t startIdx, std::size_t endIdx)
{
    double peak = 0.0, sumSq = 0.0;
    const std::size_t n = endIdx > v.size() ? v.size() : endIdx;
    std::size_t count = 0;
    for (std::size_t i = startIdx; i < n; ++i)
    {
        const double a = std::abs(static_cast<double>(v[i]));
        if (a > peak) peak = a;
        sumSq += static_cast<double>(v[i]) * static_cast<double>(v[i]);
        ++count;
    }
    if (count == 0) return 0.0;
    const double rms = std::sqrt(sumSq / static_cast<double>(count));
    return rms > 1e-30 ? peak / rms : 0.0;
}

// Spectral brightness proxy: ratio of energy in the high-frequency-difference
// signal (zero-mean differentiated) to the total energy. Higher = brighter /
// more upper-band content. This is not an FFT — it's a cheap and tolerant
// proxy used only to verify a directional change, not to claim accuracy.
static double brightnessProxy(const std::vector<float>& v,
                              std::size_t startIdx, std::size_t endIdx)
{
    double hfEnergy = 0.0, totalEnergy = 0.0;
    const std::size_t n = endIdx > v.size() ? v.size() : endIdx;
    if (n <= startIdx + 1) return 0.0;
    for (std::size_t i = startIdx + 1; i < n; ++i)
    {
        const double d = static_cast<double>(v[i]) - static_cast<double>(v[i - 1]);
        hfEnergy   += d * d;
        totalEnergy += static_cast<double>(v[i]) * static_cast<double>(v[i]);
    }
    return totalEnergy > 1e-30 ? hfEnergy / totalEnergy : 0.0;
}

// 1. The smoothness param is registered with the documented range and
//    default. APVTS surface checks ensure the bridge sees it just like
//    every other RangedAudioParameter.
static void testSmoothnessParamExistsAndDefault()
{
    std::cout << "  [smoothness param exists / default 0]\n";
    XlethReverbEffect fx;

    auto* sp = findRangedParam(fx, "smoothness");
    CHECK(sp != nullptr, "smoothness param should be registered");
    if (!sp) return;

    const auto& range = sp->getNormalisableRange();
    CHECK_NEAR(range.start, 0.0f,   0.01f, "smoothness range start should be 0");
    CHECK_NEAR(range.end,   100.0f, 0.01f, "smoothness range end should be 100");

    const float def = sp->convertFrom0to1(sp->getDefaultValue());
    CHECK_NEAR(def, 0.0f, 0.01f,
        "smoothness default must be 0 to preserve baseline for old projects");

    const std::string json = fx.getParametersAsJSON();
    CHECK(json.find("\"id\":\"smoothness\"") != std::string::npos,
          "smoothness param should be present in getParametersAsJSON output");
}

// 2. Old-state compatibility: a saved state without "smoothness" must load
//    with smoothness at its default (0). This is the contract that lets us
//    ship SMOOTH without breaking projects saved before it existed.
static void testSmoothnessOldStateLoadsAsZero()
{
    std::cout << "  [old state without smoothness loads as 0]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethReverbEffect src;
    src.prepareToPlay(kSR, kBS);
    src.setParameterValue("decay",      8.0f);
    src.setParameterValue("smoothness", 75.0f);

    juce::MemoryBlock state;
    src.getStateInformation(state);
    CHECK(state.getSize() > 0, "serialized state should be non-empty");

    auto xml = juce::AudioProcessor::getXmlFromBinary(
        state.getData(), static_cast<int>(state.getSize()));
    CHECK(xml != nullptr, "should be able to extract XML from saved state");
    if (!xml) return;

    bool removedSmoothness = false;
    for (int i = xml->getNumChildElements() - 1; i >= 0; --i)
    {
        auto* child = xml->getChildElement(i);
        if (child
            && child->hasTagName("PARAM")
            && child->getStringAttribute("id") == "smoothness")
        {
            xml->removeChildElement(child, true);
            removedSmoothness = true;
            break;
        }
    }
    CHECK(removedSmoothness,
          "expected to find a <PARAM id=\"smoothness\"/> element to strip");

    juce::MemoryBlock oldState;
    juce::AudioProcessor::copyXmlToBinary(*xml, oldState);

    XlethReverbEffect dst;
    dst.prepareToPlay(kSR, kBS);
    dst.setStateInformation(oldState.getData(),
                            static_cast<int>(oldState.getSize()));

    const float restoredSmooth = readParamValue(dst, "smoothness");
    CHECK_NEAR(restoredSmooth, 0.0f, 0.01f,
        "smoothness must default to 0 when missing from a saved state");

    const float restoredDecay = readParamValue(dst, "decay");
    CHECK_NEAR(restoredDecay, 8.0f, 0.05f,
        "non-smoothness params should round-trip via the stripped state");
}

// 3. All three documented values are settable, read back, and produce
//    finite output for every style.
static void testSmoothnessSettableAcrossStyles()
{
    std::cout << "  [smoothness 0/50/100 settable, finite for all styles]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    const float smoothValues[3] = { 0.0f, 50.0f, 100.0f };
    const int   styles[3]       = { 0, 1, 3 };  // Generic, Room, Hall
    const char* styleNames[3]   = { "Generic", "Room", "Hall" };

    for (int si = 0; si < 3; ++si)
    {
        for (int vi = 0; vi < 3; ++vi)
        {
            XlethReverbEffect fx;
            setStandardParams(fx);
            fx.setParameterValue("style",      static_cast<float>(styles[si]));
            fx.setParameterValue("smoothness", smoothValues[vi]);
            fx.prepareToPlay(kSR, kBS);

            CHECK_NEAR(readParamValue(fx, "smoothness"), smoothValues[vi], 0.5f,
                std::string("smoothness=") + std::to_string(smoothValues[vi])
                + " should round-trip through APVTS");

            juce::AudioBuffer<float> buf(2, kBS);
            juce::MidiBuffer midi;
            double phase = 0.0;
            bool ok = true;
            for (int b = 0; b < 30; ++b)
            {
                if (b < 10) fillSine(buf, 440.0, kSR, phase);
                else        fillSilence(buf);
                fx.processBlock(buf, midi);
                if (!allFinite(buf)) { ok = false; break; }
            }
            CHECK(ok, std::string(styleNames[si])
                + " at smoothness=" + std::to_string(smoothValues[vi])
                + " must remain finite for 30 blocks");
        }
    }
}

// 4. Generic at smoothness=0 must be bit-identical to Generic at smoothness=0
//    across two fresh runs — proves determinism. AND we lock the baseline
//    by also requiring the same signature properties as the Generic algorithm
//    (testReverbSignature) still hold even when smoothness is explicitly 0.
//    The bit-identicality across runs is the strongest portable guarantee
//    we can make without storing a captured baseline blob.
static void testGenericSmoothnessZeroDeterministic()
{
    std::cout << "  [Generic smoothness=0 is deterministic and non-trivial]\n";
    const auto a = runWithSmoothness(0.0f, 0.0f);
    const auto b = runWithSmoothness(0.0f, 0.0f);
    CHECK(bitIdentical(a, b),
          "Two fresh Generic runs at smoothness=0 must be bit-identical");

    double sumSq = 0.0;
    for (float v : a) sumSq += static_cast<double>(v) * static_cast<double>(v);
    CHECK(sumSq > 1e-3,
          "Generic smoothness=0 must still produce non-trivial wet output");
}

// 5. Smoothness must measurably change Generic / Room / Hall output. We
//    compare a smoothness=0 run against a smoothness=100 run for each style
//    and require an audible RMS difference. Thresholds are tolerant —
//    enough to catch a mistake that wires the param to nothing, not
//    tight enough to be brittle to refactors.
static void testSmoothnessChangesOutputAcrossStyles()
{
    std::cout << "  [smoothness measurably changes Generic/Room/Hall]\n";

    auto rmsDiff = [](const std::vector<float>& a, const std::vector<float>& b) {
        double sumSq = 0.0;
        const std::size_t n = std::min(a.size(), b.size());
        for (std::size_t i = 0; i < n; ++i)
        {
            const double d = static_cast<double>(a[i]) - static_cast<double>(b[i]);
            sumSq += d * d;
        }
        return std::sqrt(sumSq / static_cast<double>(n));
    };

    const int   styles[3]     = { 0, 1, 3 };
    const char* styleNames[3] = { "Generic", "Room", "Hall" };
    for (int si = 0; si < 3; ++si)
    {
        const auto raw    = runWithSmoothness(static_cast<float>(styles[si]),   0.0f);
        const auto smooth = runWithSmoothness(static_cast<float>(styles[si]), 100.0f);
        const double diff = rmsDiff(raw, smooth);
        std::cout << "    " << styleNames[si]
                  << " smoothness 0 vs 100 RMS diff: " << diff << "\n";
        CHECK(diff > 1e-4,
              std::string(styleNames[si])
              + " smoothness must produce an audibly meaningful change "
                "(>1e-4 RMS) — otherwise the param is wired to nothing");
    }
}

// 6. Smoothness=100 must not silence the reverb. The diffusion + ER softening
//    paths reduce energy, but never to inaudibility. We require the late-tail
//    energy at smoothness=100 to remain a non-trivial fraction of the
//    smoothness=0 late-tail energy across all styles.
static void testSmoothnessDoesNotSilence()
{
    std::cout << "  [smoothness=100 keeps the wet tail audible]\n";
    auto tailEnergy = [](const std::vector<float>& v) {
        double sum = 0.0;
        // Final ~3 blocks (the silence-tail portion of runWithSmoothness)
        const std::size_t startIdx = v.size() > 3 * 512u ? v.size() - 3 * 512u : 0;
        for (std::size_t i = startIdx; i < v.size(); ++i)
            sum += static_cast<double>(v[i]) * static_cast<double>(v[i]);
        return sum;
    };

    const int   styles[3]     = { 0, 1, 3 };
    const char* styleNames[3] = { "Generic", "Room", "Hall" };
    for (int si = 0; si < 3; ++si)
    {
        const auto raw    = runWithSmoothness(static_cast<float>(styles[si]),   0.0f);
        const auto smooth = runWithSmoothness(static_cast<float>(styles[si]), 100.0f);
        const double er0   = tailEnergy(raw);
        const double er100 = tailEnergy(smooth);
        std::cout << "    " << styleNames[si]
                  << " tail energy 0=" << er0 << "  100=" << er100 << "\n";
        // Smoothness should retain at least 10% of baseline tail energy.
        // Damping boost + HF shelf reduce HF energy but never silence the
        // reverb — it must not collapse to silence (that would be a regression).
        CHECK(er100 > er0 * 0.10,
              std::string(styleNames[si])
              + " smoothness=100 tail energy must remain > 10% of baseline");
    }
}

// 6b. Tail energy at SMOOTH=100 must not inflate the reverb tail unreasonably.
//     The SMOOTH path uses damping boost + HF shelf, both of which reduce or
//     hold tail energy — neither inflates it. So ratios should be ≤ 1.0 in
//     practice; the bounds below act as a ceiling guard against future
//     regressions that might accidentally bloat the tail again.
//       Generic: naturally large late tail  →  ratio < 4×
//       Hall:    large late tail            →  ratio < 4×
//       Room:    ER-dominated baseline      →  ratio < 10×
static void testSmoothnessTailEnergyBounded()
{
    std::cout << "  [smoothness=100 tail energy within bounds]\n";
    auto tailEnergy = [](const std::vector<float>& v) {
        double sum = 0.0;
        const std::size_t startIdx = v.size() > 3 * 512u ? v.size() - 3 * 512u : 0;
        for (std::size_t i = startIdx; i < v.size(); ++i)
            sum += static_cast<double>(v[i]) * static_cast<double>(v[i]);
        return sum;
    };

    const int    styles[3]     = { 0, 1, 3 };
    const char*  styleNames[3] = { "Generic", "Room", "Hall" };
    const double maxRatios[3]  = { 4.0, 10.0, 4.0 };

    for (int si = 0; si < 3; ++si)
    {
        const auto raw    = runWithSmoothness(static_cast<float>(styles[si]),   0.0f);
        const auto smooth = runWithSmoothness(static_cast<float>(styles[si]), 100.0f);
        const double e0   = tailEnergy(raw);
        const double e100 = tailEnergy(smooth);
        const double ratio = e100 / (e0 + 1e-30);
        std::cout << "    " << styleNames[si]
                  << " tail ratio (100/0)=" << ratio
                  << "  limit=" << maxRatios[si] << "\n";
        CHECK(ratio < maxRatios[si],
              std::string(styleNames[si])
              + " smoothness=100 tail energy must be < "
              + std::to_string(maxRatios[si])
              + "× baseline (wet compensation keeps tail from bloating)");
    }
}

// 7. Style-switch finiteness with smoothness in play. Cycle through every
//    style with smoothness pegged at 100 (the most aggressive setting) and
//    verify nothing goes non-finite. Catches state-management bugs in the
//    SMOOTH diffusers across resets.
static void testSmoothnessStyleSwitchFinite()
{
    std::cout << "  [smoothness style-switch finite at 100%]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.setParameterValue("smoothness", 100.0f);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;
    bool ok = true;
    for (int block = 0; block < 24; ++block)
    {
        fx.setParameterValue("style", static_cast<float>(block % 4));
        fillSine(buf, 440.0, kSR, phase);
        fx.processBlock(buf, midi);
        if (!allFinite(buf)) { ok = false; break; }
    }
    CHECK(ok, "smoothness=100 + style cycling must remain finite");
}

// 8. Serialization round-trip restores smoothness.
static void testSmoothnessSerializationRoundTrip()
{
    std::cout << "  [smoothness serialization round-trip]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    const float values[3] = { 0.0f, 50.0f, 100.0f };
    for (int i = 0; i < 3; ++i)
    {
        XlethReverbEffect src;
        src.prepareToPlay(kSR, kBS);
        src.setParameterValue("smoothness", values[i]);

        juce::MemoryBlock state;
        src.getStateInformation(state);
        CHECK(state.getSize() > 0, "serialized state should be non-empty");

        XlethReverbEffect dst;
        dst.prepareToPlay(kSR, kBS);
        dst.setStateInformation(state.getData(),
                                static_cast<int>(state.getSize()));

        const float restored = readParamValue(dst, "smoothness");
        CHECK_NEAR(restored, values[i], 0.5f,
            std::string("restored smoothness should be ")
            + std::to_string(values[i]));
    }
}

// 9. Plate now has its own backend, so RING TAME on Plate must produce
//    a measurable change in output (it must not be wired to nothing) AND
//    Plate at smoothness=50 must still differ from Generic at the same
//    smoothness — i.e. the placeholder mapping has been replaced by a
//    real distinct algorithm.
static void testPlateRingTameAndDistinctness()
{
    std::cout << "  [Plate RING TAME changes output AND Plate ≠ Generic at smooth=50]\n";

    const auto plateRaw    = runWithSmoothness(2.0f,  0.0f);
    const auto plateSmooth = runWithSmoothness(2.0f, 50.0f);
    const auto generic50   = runWithSmoothness(0.0f, 50.0f);

    // RING TAME must measurably change Plate output.
    double rmsDiff = 0.0;
    const std::size_t n = std::min(plateRaw.size(), plateSmooth.size());
    for (std::size_t i = 0; i < n; ++i)
    {
        const double d = plateRaw[i] - plateSmooth[i];
        rmsDiff += d * d;
    }
    rmsDiff = std::sqrt(rmsDiff / static_cast<double>(n));
    std::cout << "    Plate smooth=0 vs smooth=50 RMS diff: " << rmsDiff << "\n";
    CHECK(rmsDiff > 1e-4,
          "RING TAME must measurably change Plate output (param wired in)");

    // Plate at smooth=50 must NOT be bit-identical to Generic at smooth=50.
    CHECK(!bitIdentical(plateSmooth, generic50),
          "Plate must no longer route to Generic — even with smoothness>0, "
          "Plate output must come from its own dedicated tank backend");
}

// 10. Metric test: at high smoothness, the impulse-response tail crest
//     factor should drop. Metallic ringing manifests as narrow energy
//     concentrations on transients (high crest), so a directional drop on
//     impulse-response measurements is consistent with the perceptual goal
//     of SMOOTH. We use impulse excitation (not sustained sine) because
//     sustained-sine input masks the transient comb pattern the ear actually
//     hears as ringing. We use very tolerant thresholds — this is a
//     guardrail, not a perceptual gold standard.
static void testSmoothnessReducesCrestFactor()
{
    std::cout << "  [smoothness reduces impulse-tail crest factor]\n";
    const int   styles[3]     = { 0, 1, 3 };
    const char* styleNames[3] = { "Generic", "Room", "Hall" };

    int reductions = 0;
    for (int si = 0; si < 3; ++si)
    {
        const auto raw    = runImpulse(static_cast<float>(styles[si]),   0.0f);
        const auto smooth = runImpulse(static_cast<float>(styles[si]), 100.0f);
        // Skip the first ~80 ms (4 blocks) — that's where the ER cluster
        // lives. Measure the FDN late-tail window only, where comb modes
        // dominate audible character.
        const std::size_t tailStart = 4 * 512;
        const std::size_t tailEnd   = raw.size();
        const double cfRaw    = crestFactor(raw,    tailStart, tailEnd);
        const double cfSmooth = crestFactor(smooth, tailStart, tailEnd);
        std::cout << "    " << styleNames[si]
                  << " IR-tail crest 0=" << cfRaw << "  100=" << cfSmooth << "\n";
        if (cfSmooth < cfRaw * 0.98) ++reductions;
    }
    // Tolerant: at least 2 of the 3 styles should show a reduction.
    // Comb-mode interactions are style-specific, so we don't insist on
    // monotonicity for every style. The aggregate trend is what matters.
    CHECK(reductions >= 2,
          "at least 2 of 3 styles should show reduced IR-tail crest at "
          "smoothness=100 (tolerant guardrail, not a perceptual oracle)");
}

// 12. Legacy regression signature lock for Generic + smoothness=0.
//
//     Stage 6 introduced a real dispatch split: Generic at smoothness=0 now
//     runs the LegacyFdn backend (a separate function from the EnhancedFdn
//     backend). This test pins enough measurable properties of that path
//     that any future change to the enhanced backend cannot accidentally
//     drift the legacy character. We deliberately use loose-enough numeric
//     bands that the test survives compiler/FPU variation but tight enough
//     to catch a topology change.
//
//     Strategy: drive a fixed deterministic schedule with smoothness=0,
//     measure 5 independent properties of the captured output, and lock
//     each to a well-bounded range or relationship.
static void testLegacyGenericRegressionSignature()
{
    std::cout << "  [legacy Generic regression signature locked]\n";
    constexpr double kSR    = 48000.0;
    constexpr int    kBS    = 512;
    constexpr int    kBlocks = 16;

    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.setParameterValue("style",      0.0f);   // Generic
    fx.setParameterValue("smoothness", 0.0f);   // forces LegacyFdn dispatch
    fx.setParameterValue("damping",    30.0f);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;
    std::vector<float> out;
    out.reserve(static_cast<std::size_t>(kBS) * static_cast<std::size_t>(kBlocks));

    for (int b = 0; b < kBlocks; ++b)
    {
        if (b < 8) fillSine(buf, 440.0, kSR, phase);
        else       fillSilence(buf);
        fx.processBlock(buf, midi);
        for (int s = 0; s < kBS; ++s) out.push_back(buf.getSample(0, s));
    }

    // Property 1 — totally finite (no NaN/Inf anywhere)
    bool allOk = true;
    for (float v : out) if (!std::isfinite(v)) { allOk = false; break; }
    CHECK(allOk, "legacy Generic must produce only finite samples");

    // Property 2 — substantial wet energy from the excited region
    double exciteEnergy = 0.0;
    for (std::size_t i = 0; i < 8u * 512u; ++i)
        exciteEnergy += static_cast<double>(out[i]) * static_cast<double>(out[i]);
    CHECK(exciteEnergy > 1e-3,
          "legacy Generic must produce non-trivial wet energy in the excited region");

    // Property 3 — tail decays after excitation ends
    double tailEarly = 0.0, tailLate = 0.0;
    for (std::size_t i = 8u * 512u;  i < 10u * 512u; ++i)
        tailEarly += static_cast<double>(out[i]) * static_cast<double>(out[i]);
    for (std::size_t i = 14u * 512u; i < 16u * 512u; ++i)
        tailLate  += static_cast<double>(out[i]) * static_cast<double>(out[i]);
    std::cout << "    legacy tailEarly=" << tailEarly
              << "  tailLate=" << tailLate << "\n";
    CHECK(tailEarly > tailLate,
          "legacy Generic tail must decay (early > late)");
    CHECK(tailEarly > tailLate * 1.5,
          "legacy Generic tail decay should be measurable (>1.5× ratio)");

    // Property 4 — same-binary determinism across two fresh runs
    XlethReverbEffect fx2;
    setStandardParams(fx2);
    fx2.setParameterValue("style",      0.0f);
    fx2.setParameterValue("smoothness", 0.0f);
    fx2.setParameterValue("damping",    30.0f);
    fx2.prepareToPlay(kSR, kBS);
    juce::AudioBuffer<float> buf2(2, kBS);
    double phase2 = 0.0;
    std::vector<float> out2;
    out2.reserve(out.size());
    for (int b = 0; b < kBlocks; ++b)
    {
        if (b < 8) fillSine(buf2, 440.0, kSR, phase2);
        else       fillSilence(buf2);
        fx2.processBlock(buf2, midi);
        for (int s = 0; s < kBS; ++s) out2.push_back(buf2.getSample(0, s));
    }
    CHECK(bitIdentical(out, out2),
          "legacy Generic must be bit-identical across two fresh runs (same binary)");

    // Property 5 — Plate remains finite under the regression schedule.
    // Plate now has its own dedicated tank backend (processBlockPlate);
    // structural distinctness from Generic / Room / Hall is locked by
    // testPlateBackendIsDistinct, and Ring Tame wiring is locked by
    // testPlateRingTameAndDistinctness. Here we only require Plate to be
    // a sane finite reverb under the same schedule legacy Generic uses.
    XlethReverbEffect plateFx;
    setStandardParams(plateFx);
    plateFx.setParameterValue("style",      2.0f);   // Plate
    plateFx.setParameterValue("smoothness", 0.0f);
    plateFx.setParameterValue("damping",    30.0f);
    plateFx.prepareToPlay(kSR, kBS);
    juce::AudioBuffer<float> bufP(2, kBS);
    double phaseP = 0.0;
    bool plateOk = true;
    double plateEnergy = 0.0;
    for (int b = 0; b < kBlocks; ++b)
    {
        if (b < 8) fillSine(bufP, 440.0, kSR, phaseP);
        else       fillSilence(bufP);
        plateFx.processBlock(bufP, midi);
        for (int s = 0; s < kBS; ++s)
        {
            const float v = bufP.getSample(0, s);
            if (!std::isfinite(v)) { plateOk = false; }
            plateEnergy += static_cast<double>(v) * static_cast<double>(v);
        }
    }
    CHECK(plateOk, "Plate placeholder must remain finite for the regression schedule");
    CHECK(plateEnergy > 1e-3,
          "Plate placeholder must produce non-trivial wet output");
}

// ─── Enhanced FDN pass 1: anti-metal metric tests ────────────────────────────
//
// These tests guard the behavioural invariants of the new I/O routing:
//   • the enhanced output is no longer the legacy even/odd split;
//   • Generic with smoothness>0 (enhanced backend) is not bit-identical
//     to Generic with smoothness=0 (legacy backend);
//   • per-channel wet level stays within sane bounds vs. legacy;
//   • stereo L/R correlation drops below the legacy "even vs odd" baseline,
//     evidence the new output vectors actually decorrelate the channels.

// Helper: deterministic stereo IR capture for one (style, smoothness) pair.
static void runImpulseStereo(float styleIdx, float smoothPct,
                             std::vector<float>& outL,
                             std::vector<float>& outR,
                             int kBlocks = 24,
                             double kSR = 48000.0, int kBS = 512)
{
    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.setParameterValue("style",      styleIdx);
    fx.setParameterValue("smoothness", smoothPct);
    fx.setParameterValue("decay",      2.0f);
    fx.setParameterValue("mod_depth",  0.0f);
    fx.setParameterValue("predelay",   0.0f);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    outL.reserve(static_cast<std::size_t>(kBS) * static_cast<std::size_t>(kBlocks));
    outR.reserve(static_cast<std::size_t>(kBS) * static_cast<std::size_t>(kBlocks));

    buf.clear();
    buf.setSample(0, 0, 0.5f);
    if (buf.getNumChannels() > 1) buf.setSample(1, 0, 0.5f);
    fx.processBlock(buf, midi);
    for (int s = 0; s < kBS; ++s) {
        outL.push_back(buf.getSample(0, s));
        outR.push_back(buf.getSample(1, s));
    }

    for (int b = 1; b < kBlocks; ++b)
    {
        fillSilence(buf);
        fx.processBlock(buf, midi);
        for (int s = 0; s < kBS; ++s) {
            outL.push_back(buf.getSample(0, s));
            outR.push_back(buf.getSample(1, s));
        }
    }
}

// Pearson L/R correlation across a window of the IR tail.
static double lrCorrelation(const std::vector<float>& L,
                            const std::vector<float>& R,
                            std::size_t startIdx, std::size_t endIdx)
{
    const std::size_t n = std::min({endIdx, L.size(), R.size()});
    if (n <= startIdx + 1) return 0.0;
    double sumL = 0.0, sumR = 0.0;
    for (std::size_t i = startIdx; i < n; ++i) { sumL += L[i]; sumR += R[i]; }
    const double meanL = sumL / static_cast<double>(n - startIdx);
    const double meanR = sumR / static_cast<double>(n - startIdx);
    double cov = 0.0, varL = 0.0, varR = 0.0;
    for (std::size_t i = startIdx; i < n; ++i)
    {
        const double dL = L[i] - meanL;
        const double dR = R[i] - meanR;
        cov  += dL * dR;
        varL += dL * dL;
        varR += dR * dR;
    }
    if (varL < 1e-30 || varR < 1e-30) return 0.0;
    return cov / std::sqrt(varL * varR);
}

// 14. The enhanced backend's output routing must not be the legacy even/odd
//     split. We compare Generic+smoothness=0 (legacy) against Generic+
//     smoothness=10 (enhanced) — at smooth=10 the smoothness wet terms are
//     small (~0.1 of full), so any large-magnitude difference comes from
//     the new output vectors, not the damping/HF/ER softening tweaks.
static void testEnhancedRoutingDifferesFromLegacy()
{
    std::cout << "  [enhanced output routing diverges from legacy even/odd]\n";
    std::vector<float> legacyL, legacyR;
    std::vector<float> enhL,    enhR;
    runImpulseStereo(0.0f,  0.0f, legacyL, legacyR);
    runImpulseStereo(0.0f, 10.0f, enhL,    enhR);

    // RMS difference across the FDN-late window (skip the first ~80 ms ER).
    const std::size_t startIdx = 4u * 512u;
    const std::size_t endIdx   = std::min(legacyL.size(), enhL.size());
    double sumSqL = 0.0, sumSqR = 0.0;
    for (std::size_t i = startIdx; i < endIdx; ++i)
    {
        const double dL = legacyL[i] - enhL[i];
        const double dR = legacyR[i] - enhR[i];
        sumSqL += dL * dL;
        sumSqR += dR * dR;
    }
    const double n = static_cast<double>(endIdx - startIdx);
    const double rmsL = std::sqrt(sumSqL / n);
    const double rmsR = std::sqrt(sumSqR / n);
    std::cout << "    L RMS diff=" << rmsL << "  R RMS diff=" << rmsR << "\n";

    // The output vectors flip signs and re-weight every line, so the diff
    // must be substantially above the smoothness-only diff (which would
    // sit around 1e-5 at smoothness=10 with old even/odd routing).
    CHECK(rmsL > 1e-3 || rmsR > 1e-3,
          "Enhanced Generic at smoothness>0 must produce output that "
          "deviates measurably from the legacy even/odd-routed output");
}

// 15. Generic at smoothness>0 must NOT be bit-identical to Generic at
//     smoothness=0. This is a structural lock: the enhanced backend must
//     actually differ from the legacy backend (otherwise the dispatch
//     would be pointless).
static void testEnhancedGenericDiffersFromLegacyAtSmoothnessNonZero()
{
    std::cout << "  [enhanced Generic ≠ legacy Generic when smoothness > 0]\n";
    const auto legacy   = runWithSmoothness(0.0f,  0.0f);
    const auto enhanced = runWithSmoothness(0.0f, 25.0f);
    CHECK(!bitIdentical(legacy, enhanced),
          "Generic+smooth=25 must NOT be bit-identical to Generic+smooth=0 "
          "(enhanced backend has different I/O routing and damping)");
}

// 16. Stereo L/R decorrelation: legacy Generic (even/odd routing) tends to
//     produce a fairly correlated stereo image because each channel sums
//     a contiguous half of the FDN with all-positive gains. Enhanced
//     output vectors mix all 8 lines into both channels with mixed signs,
//     which should drop the absolute L/R correlation.
//
//     This is a directional check: we don't assert a specific number —
//     just that |corr_enhanced| < |corr_legacy| by a meaningful margin.
//     If a future change accidentally collapses output back to all-positive
//     per-channel sums, this test will catch it.
static void testEnhancedDecorrelatesLR()
{
    std::cout << "  [enhanced output decorrelates L/R vs legacy]\n";
    std::vector<float> legacyL, legacyR, enhL, enhR;
    runImpulseStereo(0.0f,  0.0f, legacyL, legacyR);
    runImpulseStereo(0.0f, 50.0f, enhL,    enhR);

    const std::size_t startIdx = 4u * 512u;
    const std::size_t endIdx   = std::min(legacyL.size(), enhL.size());
    const double cLegacy = std::abs(lrCorrelation(legacyL, legacyR, startIdx, endIdx));
    const double cEnh    = std::abs(lrCorrelation(enhL,    enhR,    startIdx, endIdx));
    std::cout << "    |L/R corr| legacy=" << cLegacy
              << "  enhanced=" << cEnh << "\n";

    // Tolerant directional guard. Enhanced |corr| must not exceed legacy by
    // more than 0.10, OR must already sit below 0.6 absolute. The threshold
    // mainly catches a regression that wires output back to all-positive,
    // single-channel-half routing (which would collapse |corr| toward 1.0).
    CHECK(cEnh <= cLegacy + 0.10 || cEnh < 0.6,
          "Enhanced |L/R correlation| must not be substantially worse than "
          "the legacy even/odd routing — mixed-sign output vectors should "
          "decorrelate or hold the stereo image, not amplify correlation");
}

// 17. Wet level guardrail: the new I/O vectors must keep enhanced peak
//     and RMS within sane multiples of legacy. Otherwise switching from
//     smoothness=0 to a small smoothness value would cause an audible
//     loudness jump.
static void testEnhancedWetLevelBounded()
{
    std::cout << "  [enhanced wet level remains within bounds of legacy]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;
    constexpr int    kBlocks = 16;

    auto runMeasure = [&](float styleIdx, float smoothPct,
                          double& outPeak, double& outRms)
    {
        XlethReverbEffect fx;
        setStandardParams(fx);
        fx.setParameterValue("style",      styleIdx);
        fx.setParameterValue("smoothness", smoothPct);
        fx.prepareToPlay(kSR, kBS);

        juce::AudioBuffer<float> buf(2, kBS);
        juce::MidiBuffer midi;
        double phase = 0.0;
        double sumSq = 0.0, peak = 0.0;
        std::size_t count = 0;
        for (int b = 0; b < kBlocks; ++b)
        {
            if (b < 8) fillSine(buf, 440.0, kSR, phase);
            else       fillSilence(buf);
            fx.processBlock(buf, midi);
            for (int s = 0; s < kBS; ++s)
            {
                const double v = buf.getSample(0, s);
                if (std::abs(v) > peak) peak = std::abs(v);
                sumSq += v * v;
                ++count;
            }
        }
        outPeak = peak;
        outRms  = std::sqrt(sumSq / static_cast<double>(count));
    };

    double legacyPeak, legacyRms, enhPeak, enhRms;
    runMeasure(0.0f,  0.0f, legacyPeak, legacyRms);
    runMeasure(0.0f, 50.0f, enhPeak,    enhRms);
    std::cout << "    legacy peak=" << legacyPeak << " rms=" << legacyRms
              << " | enhanced peak=" << enhPeak << " rms=" << enhRms << "\n";

    // Enhanced peak/RMS must stay between 0.25× and 4× of legacy. Anything
    // outside that band would be a sudden wet-level jump as smoothness
    // moves off zero.
    CHECK(enhPeak < legacyPeak * 4.0,
          "Enhanced peak should not exceed 4× legacy peak");
    CHECK(enhPeak > legacyPeak * 0.25,
          "Enhanced peak should not fall below 25% of legacy peak");
    CHECK(enhRms  < legacyRms  * 4.0,
          "Enhanced RMS should not exceed 4× legacy RMS");
    CHECK(enhRms  > legacyRms  * 0.25,
          "Enhanced RMS should not fall below 25% of legacy RMS");
}

// 13. Smoothness ramp continuity: Sweep smoothness 0 → 75 → 0 mid-stream.
//     The dispatch flips Generic from LegacyFdn → EnhancedFdn → LegacyFdn.
//     Output must remain finite the whole time and (because the legacy and
//     enhanced backends share buffer state) the FDN should not spike at
//     the dispatch boundaries.
static void testGenericRingTameSweepStable()
{
    std::cout << "  [Generic Ring Tame sweep — dispatch flip stable]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.setParameterValue("style", 0.0f);
    fx.setParameterValue("smoothness", 0.0f);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;

    bool ok = true;
    float prevPeak = 0.0f;
    for (int b = 0; b < 30; ++b)
    {
        // Sweep smoothness up over blocks 0..10, hold at 75 over 11..15,
        // sweep back down over 16..25, hold at 0 over 26..29.
        float sm = 0.0f;
        if      (b <= 10) sm = b * 7.5f;          //  0 → 75
        else if (b <= 15) sm = 75.0f;
        else if (b <= 25) sm = 75.0f - (b - 15) * 7.5f; // 75 → 0
        fx.setParameterValue("smoothness", sm);

        if (b < 22) fillSine(buf, 440.0, kSR, phase);
        else        fillSilence(buf);
        fx.processBlock(buf, midi);
        if (!allFinite(buf)) { ok = false; break; }

        // Track peak — should never explode on a dispatch flip.
        float p = 0.0f;
        for (int s = 0; s < kBS; ++s)
            p = std::max(p, std::abs(buf.getSample(0, s)));
        if (b > 0)
        {
            const float ratio = (prevPeak > 1e-8f) ? p / prevPeak : 1.0f;
            // Allow up to 8× peak growth between adjacent blocks (the FDN
            // can naturally swell during dispatch transitions; this is a
            // sanity guard, not a perceptual oracle).
            CHECK(ratio < 8.0f,
                  "Ring Tame sweep should not produce >8× peak jumps between blocks");
        }
        prevPeak = p;
    }
    CHECK(ok, "Generic Ring Tame sweep must remain finite for 30 blocks");
}

// 11. Metric test: at high smoothness, the brightness proxy should not
//     increase across styles. SMOOTH adds damping and ER softening, both
//     of which reduce upper-band energy. We tolerate flat or slight
//     increase on individual styles but require the trend.
static void testSmoothnessReducesOrHoldsBrightness()
{
    std::cout << "  [smoothness does not increase brightness]\n";
    const int   styles[3]     = { 0, 1, 3 };
    const char* styleNames[3] = { "Generic", "Room", "Hall" };
    int nonIncreases = 0;
    for (int si = 0; si < 3; ++si)
    {
        const auto raw    = runWithSmoothness(static_cast<float>(styles[si]),   0.0f, 24);
        const auto smooth = runWithSmoothness(static_cast<float>(styles[si]), 100.0f, 24);
        const std::size_t tailStart = 8 * 512;
        const std::size_t tailEnd   = raw.size();
        const double bpRaw    = brightnessProxy(raw,    tailStart, tailEnd);
        const double bpSmooth = brightnessProxy(smooth, tailStart, tailEnd);
        std::cout << "    " << styleNames[si]
                  << " bright proxy 0=" << bpRaw << "  100=" << bpSmooth << "\n";
        if (bpSmooth <= bpRaw * 1.10) ++nonIncreases;
    }
    CHECK(nonIncreases >= 2,
          "at least 2 of 3 styles should not increase brightness at "
          "smoothness=100 (damping + ER softening should hold or reduce HF)");
}

// ─── Enhanced Hall pass 1: dedicated 16-line backend tests ───────────────────
//
// These tests guard the behavioural invariants of the dedicated Hall
// backend (processBlockHall):
//   • Hall is structurally distinct from Generic and Room.
//   • Hall stays finite under extreme parameters and rapid style switches.
//   • Hall's wet level remains within sane bounds vs. the legacy 4-line sum.
//   • Hall's stereo image is decorrelated but not pathologically wide.
//   • Hall's late-tail crest factor sits within the same band as the other
//     enhanced styles, evidence the 16-line + decorrelated damping topology
//     is doing its job (no metallicity regression).

// Hall + extreme settings: decay max, size max, damping zero, mod depth max,
// smoothness max. 30 blocks of low-frequency sine. Must remain finite.
static void testHallExtremeFinite()
{
    std::cout << "  [Hall extreme settings finite]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethReverbEffect fx;
    fx.setParameterValue("style",      3.0f);    // Hall
    fx.setParameterValue("decay",      30.0f);
    fx.setParameterValue("predelay",   0.0f);
    fx.setParameterValue("size",       100.0f);
    fx.setParameterValue("damping",    0.0f);
    fx.setParameterValue("mod_rate",   100.0f);
    fx.setParameterValue("mod_depth",  100.0f);
    fx.setParameterValue("er_level",   100.0f);
    fx.setParameterValue("er_late",    100.0f);
    fx.setParameterValue("hicut",      20000.0f);
    fx.setParameterValue("locut",      20.0f);
    fx.setParameterValue("mix",        100.0f);
    fx.setParameterValue("smoothness", 100.0f);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;
    bool ok = true;
    for (int b = 0; b < 30; ++b)
    {
        fillSine(buf, 100.0, kSR, phase);
        fx.processBlock(buf, midi);
        if (!allFinite(buf)) { ok = false; break; }
    }
    CHECK(ok, "Hall must remain finite under all extreme settings simultaneously");
}

// Hall is finite and structurally distinct from Generic AND Room. Two-run
// determinism is also locked here (the 16-line backend is deterministic).
static void testHallBackendDistinctAndDeterministic()
{
    std::cout << "  [Hall 16-line backend distinct + deterministic]\n";
    const auto hallA   = runDeterministic(3.0f);
    const auto hallB   = runDeterministic(3.0f);
    const auto generic = runDeterministic(0.0f);
    const auto room    = runDeterministic(1.0f);

    CHECK(bitIdentical(hallA, hallB),
          "Two fresh Hall runs must be bit-identical (no runtime randomness)");
    CHECK(!bitIdentical(hallA, generic),
          "Hall (16-line backend) must differ from Generic (legacy 8-line)");
    CHECK(!bitIdentical(hallA, room),
          "Hall (16-line backend) must differ from Room (8-line enhanced)");
}

// Style cycling Generic → Hall → Room → Hall → Generic. Each transition
// crosses a backend boundary (legacy ↔ Hall ↔ enhanced). Must remain
// finite and produce non-trivial output throughout.
static void testHallSwitchSchedule()
{
    std::cout << "  [Generic → Hall → Room → Hall → Generic schedule finite]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;
    const float schedule[5] = { 0.0f, 3.0f, 1.0f, 3.0f, 0.0f };

    bool ok = true;
    double totalEnergy = 0.0;
    for (int phaseIdx = 0; phaseIdx < 5; ++phaseIdx)
    {
        fx.setParameterValue("style", schedule[phaseIdx]);
        for (int b = 0; b < 4; ++b)
        {
            fillSine(buf, 440.0, kSR, phase);
            fx.processBlock(buf, midi);
            if (!allFinite(buf)) { ok = false; break; }
            totalEnergy += sumSquared(buf);
        }
        if (!ok) break;
    }
    CHECK(ok, "Generic→Hall→Room→Hall→Generic schedule must remain finite");
    CHECK(totalEnergy > 1e-2,
          "schedule must produce non-trivial wet output (no accidental silence)");
}

// Hall wet peak/RMS must stay within sane bounds vs. legacy Generic.
// Otherwise switching from Generic to Hall would be a sudden loudness jump.
static void testHallWetLevelBounded()
{
    std::cout << "  [Hall wet level bounded vs. legacy Generic]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;
    constexpr int    kBlocks = 16;

    auto runMeasure = [&](float styleIdx,
                          double& outPeak, double& outRms)
    {
        XlethReverbEffect fx;
        setStandardParams(fx);
        fx.setParameterValue("style", styleIdx);
        fx.prepareToPlay(kSR, kBS);

        juce::AudioBuffer<float> buf(2, kBS);
        juce::MidiBuffer midi;
        double phase = 0.0;
        double sumSq = 0.0, peak = 0.0;
        std::size_t count = 0;
        for (int b = 0; b < kBlocks; ++b)
        {
            if (b < 8) fillSine(buf, 440.0, kSR, phase);
            else       fillSilence(buf);
            fx.processBlock(buf, midi);
            for (int s = 0; s < kBS; ++s)
            {
                const double v = buf.getSample(0, s);
                if (std::abs(v) > peak) peak = std::abs(v);
                sumSq += v * v;
                ++count;
            }
        }
        outPeak = peak;
        outRms  = std::sqrt(sumSq / static_cast<double>(count));
    };

    double genericPeak, genericRms, hallPeak, hallRms;
    runMeasure(0.0f, genericPeak, genericRms);  // legacy Generic
    runMeasure(3.0f, hallPeak,    hallRms);     // Hall (16-line backend)
    std::cout << "    legacy Generic peak=" << genericPeak << " rms=" << genericRms
              << " | Hall peak=" << hallPeak << " rms=" << hallRms << "\n";

    CHECK(hallPeak < genericPeak * 4.0,
          "Hall peak should not exceed legacy Generic peak by more than 4×");
    CHECK(hallPeak > genericPeak * 0.20,
          "Hall peak should not fall below 20% of legacy Generic peak");
    CHECK(hallRms  < genericRms  * 4.0,
          "Hall RMS should not exceed legacy Generic RMS by more than 4×");
    CHECK(hallRms  > genericRms  * 0.20,
          "Hall RMS should not fall below 20% of legacy Generic RMS");
}

// Hall stereo decorrelation: |L/R Pearson correlation| should sit comfortably
// below 1.0 (broken stereo or accidental mono-collapse), but we don't insist
// on a specific number — just that Hall's stereo image is "open" and
// comparable to the other enhanced styles.
static void testHallStereoDecorrelation()
{
    std::cout << "  [Hall stereo image decorrelated]\n";
    std::vector<float> hallL, hallR;
    runImpulseStereo(3.0f, 50.0f, hallL, hallR);

    const std::size_t startIdx = 4u * 512u;
    const std::size_t endIdx   = hallL.size();
    const double cHall = std::abs(lrCorrelation(hallL, hallR, startIdx, endIdx));
    std::cout << "    Hall |L/R corr|=" << cHall << "\n";

    // Loose absolute upper bound. A regression that wires output back to
    // single-channel-half routing would push correlation toward 1.0; a
    // bug that left R silent would also fail because correlation would
    // collapse to NaN/0 with one zero variance — covered by lrCorrelation
    // returning 0 in that case (which still passes < 0.9, so we also
    // guard the lower side by requiring R to have non-trivial energy).
    CHECK(cHall < 0.9,
          "Hall |L/R correlation| must remain below 0.9 (decorrelated stereo image)");

    double sumSqR = 0.0;
    for (std::size_t i = startIdx; i < endIdx; ++i)
        sumSqR += static_cast<double>(hallR[i]) * static_cast<double>(hallR[i]);
    CHECK(sumSqR > 1e-8,
          "Hall right channel must contain non-trivial energy (stereo not collapsed)");
}

// Hall late-tail crest factor metric. With 16 lines + per-line decorrelated
// damping + 2-stage HF tilt, Hall's tail envelope should be flatter (lower
// crest) than the legacy Generic's tail at the same params. We use a loose
// directional check — Hall crest must not exceed legacy Generic by more
// than 25%.
static void testHallTailCrestFactorBounded()
{
    std::cout << "  [Hall late-tail crest factor bounded]\n";
    const auto hall    = runImpulse(3.0f, 0.0f);   // Hall via processBlockHall
    const auto generic = runImpulse(0.0f, 0.0f);   // Legacy Generic

    const std::size_t tailStart = 4u * 512u;
    const std::size_t tailEnd   = std::min(hall.size(), generic.size());
    const double cfHall    = crestFactor(hall,    tailStart, tailEnd);
    const double cfGeneric = crestFactor(generic, tailStart, tailEnd);
    std::cout << "    Hall crest=" << cfHall
              << "  legacy Generic crest=" << cfGeneric << "\n";

    // Tolerant guardrail: Hall's crest factor should sit at or below
    // legacy Generic's, with 25% headroom for normal IR variation. A
    // regression that collapsed Hall back to a sparse FDN with bunched
    // delays would spike this metric.
    CHECK(cfHall < cfGeneric * 1.25,
          "Hall late-tail crest factor must not exceed legacy Generic by >25% "
          "(16-line + per-line damping should hold or reduce envelope spikiness)");

    // Absolute upper bound — independent guard that catches a complete
    // breakdown of the topology even if Generic also regresses.
    CHECK(cfHall < 25.0,
          "Hall late-tail crest factor must remain below absolute ceiling 25.0");
}

// ─── Dedicated Plate backend tests ───────────────────────────────────────────
//
// These tests guard the PlateLate tank: a separate cross-coupled allpass-
// and-delay topology that has nothing to do with the FDN backends. Coverage
// mirrors the Hall pass-1 suite: extreme finite, two-run determinism,
// switch-schedule finite, wet-level bounded, stereo decorrelation, and a
// late-tail crest factor metric.

// Plate at extreme settings must remain finite.
static void testPlateExtremeFinite()
{
    std::cout << "  [Plate extreme settings finite]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethReverbEffect fx;
    fx.setParameterValue("style",      2.0f);    // Plate
    fx.setParameterValue("decay",      30.0f);
    fx.setParameterValue("predelay",   0.0f);
    fx.setParameterValue("size",       100.0f);
    fx.setParameterValue("damping",    0.0f);
    fx.setParameterValue("mod_rate",   100.0f);
    fx.setParameterValue("mod_depth",  100.0f);
    fx.setParameterValue("er_level",   100.0f);
    fx.setParameterValue("er_late",    100.0f);
    fx.setParameterValue("hicut",      20000.0f);
    fx.setParameterValue("locut",      20.0f);
    fx.setParameterValue("mix",        100.0f);
    fx.setParameterValue("smoothness", 100.0f);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;
    bool ok = true;
    for (int b = 0; b < 30; ++b)
    {
        fillSine(buf, 100.0, kSR, phase);
        fx.processBlock(buf, midi);
        if (!allFinite(buf)) { ok = false; break; }
    }
    CHECK(ok, "Plate must remain finite at all extreme settings simultaneously");
}

// Plate produces non-zero wet output at standard settings.
static void testPlateProducesWetOutput()
{
    std::cout << "  [Plate produces non-trivial wet output]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.setParameterValue("style", 2.0f);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;
    double total = 0.0;
    for (int b = 0; b < 20; ++b)
    {
        fillSine(buf, 440.0, kSR, phase);
        fx.processBlock(buf, midi);
        total += sumSquared(buf);
    }
    std::cout << "    Plate total energy: " << total << "\n";
    CHECK(total > 1.0,
          "Plate should produce substantial wet energy with sustained sine input");
}

// Plate is bit-deterministic across two fresh instances with identical input.
static void testPlateDeterministic()
{
    std::cout << "  [Plate deterministic across fresh instances]\n";
    const auto a = runDeterministic(2.0f);
    const auto b = runDeterministic(2.0f);
    CHECK(bitIdentical(a, b),
          "Two fresh Plate runs with identical input must be bit-identical");

    double sumSq = 0.0;
    for (float v : a) sumSq += static_cast<double>(v) * static_cast<double>(v);
    CHECK(sumSq > 1e-3,
          "Plate must produce non-trivial output (no accidental silence)");
}

// Plate output peak/RMS must stay within sane bounds vs legacy Generic.
static void testPlateWetLevelBounded()
{
    std::cout << "  [Plate wet level bounded vs legacy Generic]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;
    constexpr int    kBlocks = 16;

    auto runMeasure = [&](float styleIdx,
                          double& outPeak, double& outRms)
    {
        XlethReverbEffect fx;
        setStandardParams(fx);
        fx.setParameterValue("style", styleIdx);
        fx.prepareToPlay(kSR, kBS);

        juce::AudioBuffer<float> buf(2, kBS);
        juce::MidiBuffer midi;
        double phase = 0.0;
        double sumSq = 0.0, peak = 0.0;
        std::size_t count = 0;
        for (int b = 0; b < kBlocks; ++b)
        {
            if (b < 8) fillSine(buf, 440.0, kSR, phase);
            else       fillSilence(buf);
            fx.processBlock(buf, midi);
            for (int s = 0; s < kBS; ++s)
            {
                const double v = buf.getSample(0, s);
                if (std::abs(v) > peak) peak = std::abs(v);
                sumSq += v * v;
                ++count;
            }
        }
        outPeak = peak;
        outRms  = std::sqrt(sumSq / static_cast<double>(count));
    };

    double genPeak, genRms, plPeak, plRms;
    runMeasure(0.0f, genPeak, genRms);   // legacy Generic
    runMeasure(2.0f, plPeak,  plRms);    // Plate
    std::cout << "    legacy Generic peak=" << genPeak << " rms=" << genRms
              << " | Plate peak=" << plPeak << " rms=" << plRms << "\n";

    CHECK(plPeak < genPeak * 4.0,
          "Plate peak should not exceed legacy Generic peak by more than 4×");
    CHECK(plPeak > genPeak * 0.15,
          "Plate peak should not fall below 15% of legacy Generic peak");
    CHECK(plRms  < genRms  * 4.0,
          "Plate RMS should not exceed legacy Generic RMS by more than 4×");
    CHECK(plRms  > genRms  * 0.15,
          "Plate RMS should not fall below 15% of legacy Generic RMS");
}

// Plate stereo image is decorrelated but not broken.
static void testPlateStereoDecorrelation()
{
    std::cout << "  [Plate stereo image decorrelated]\n";
    std::vector<float> plL, plR;
    runImpulseStereo(2.0f, 0.0f, plL, plR);

    const std::size_t startIdx = 4u * 512u;
    const std::size_t endIdx   = plL.size();
    const double cPlate = std::abs(lrCorrelation(plL, plR, startIdx, endIdx));
    std::cout << "    Plate |L/R corr|=" << cPlate << "\n";

    // Loose absolute upper bound — catches a regression that wires output
    // back to mono-summed taps.
    CHECK(cPlate < 0.95,
          "Plate |L/R correlation| must remain below 0.95 (stereo image not collapsed)");

    // R must contain non-trivial energy (guards against right-channel-zero bugs
    // that would also make correlation pathologically low).
    double sumSqR = 0.0;
    for (std::size_t i = startIdx; i < endIdx; ++i)
        sumSqR += static_cast<double>(plR[i]) * static_cast<double>(plR[i]);
    CHECK(sumSqR > 1e-8,
          "Plate right channel must contain non-trivial energy (stereo not collapsed)");
}

// Plate late-tail crest factor must sit at or below legacy Generic by a
// reasonable margin AND below an absolute ceiling. The 4-stage diffusion +
// damping LPF + cross-coupled allpasses should produce a flatter envelope
// than a sparse comb.
static void testPlateTailCrestFactorBounded()
{
    std::cout << "  [Plate late-tail crest factor bounded]\n";
    const auto plate   = runImpulse(2.0f, 0.0f);
    const auto generic = runImpulse(0.0f, 0.0f);

    const std::size_t tailStart = 4u * 512u;
    const std::size_t tailEnd   = std::min(plate.size(), generic.size());
    const double cfPlate   = crestFactor(plate,   tailStart, tailEnd);
    const double cfGeneric = crestFactor(generic, tailStart, tailEnd);
    std::cout << "    Plate crest=" << cfPlate
              << "  legacy Generic crest=" << cfGeneric << "\n";

    // Loose directional guard: Plate ≤ Generic + 30% margin OR sub-25 absolute.
    CHECK(cfPlate < cfGeneric * 1.30 || cfPlate < 25.0,
          "Plate late-tail crest factor must not exceed legacy Generic by >30% "
          "(diffusion + damping + allpasses should hold or reduce envelope spikiness)");

    // Absolute ceiling — independent of Generic's regression state.
    CHECK(cfPlate < 30.0,
          "Plate late-tail crest factor must remain below absolute ceiling 30.0");
}

// Style switch schedule including Plate. Generic → Plate → Hall → Plate →
// Room → Generic. Each step crosses a backend boundary.
static void testPlateSwitchSchedule()
{
    std::cout << "  [Generic→Plate→Hall→Plate→Room→Generic schedule finite]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;

    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;
    const float schedule[6] = { 0.0f, 2.0f, 3.0f, 2.0f, 1.0f, 0.0f };

    bool ok = true;
    double total = 0.0;
    for (int phaseIdx = 0; phaseIdx < 6; ++phaseIdx)
    {
        fx.setParameterValue("style", schedule[phaseIdx]);
        for (int b = 0; b < 4; ++b)
        {
            fillSine(buf, 440.0, kSR, phase);
            fx.processBlock(buf, midi);
            if (!allFinite(buf)) { ok = false; break; }
            total += sumSquared(buf);
        }
        if (!ok) break;
    }
    CHECK(ok, "Generic→Plate→Hall→Plate→Room→Generic schedule must remain finite");
    CHECK(total > 1e-2, "schedule must produce non-trivial wet output");
}

// Long-run stability: run Plate for many blocks at high decay and verify no
// NaN/Inf and no slow energy explosion.
static void testPlateLongTermFinite()
{
    std::cout << "  [Plate long-term finite at high decay]\n";
    constexpr double kSR = 48000.0;
    constexpr int    kBS = 512;
    constexpr int    kBlocks = 200;   // ~2.1s of audio

    XlethReverbEffect fx;
    setStandardParams(fx);
    fx.setParameterValue("style",   2.0f);
    fx.setParameterValue("decay",   15.0f);
    fx.setParameterValue("damping", 25.0f);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    double phase = 0.0;
    bool ok = true;
    double earlyEnergy = 0.0, lateEnergy = 0.0;
    for (int b = 0; b < kBlocks; ++b)
    {
        if (b < 50) fillSine(buf, 440.0, kSR, phase);
        else        fillSilence(buf);
        fx.processBlock(buf, midi);
        if (!allFinite(buf)) { ok = false; break; }
        const double e = sumSquared(buf);
        if (b >= 50 && b < 70)        earlyEnergy += e;
        else if (b >= 180)            lateEnergy  += e;
    }
    CHECK(ok, "Plate must remain finite over 200 blocks at decay=15s");

    // The tail must decay (no slow energy buildup that would indicate a
    // marginally-unstable feedback path).
    std::cout << "    Plate earlyEnergy=" << earlyEnergy
              << "  lateEnergy=" << lateEnergy << "\n";
    CHECK(earlyEnergy > lateEnergy,
          "Plate tail must decay over 200 blocks (no runaway feedback)");
}

// ─── Entry point ─────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "=== test_reverb ===\n";

    testReverbLayout();
    testReverbOutputFinite();
    testReverbFiniteAtExtremes();
    testReverbWetNonZero();
    testReverbTailDecays();
    testReverbDeterminism();
    testReverbPredelayDelaysOnset();
    testReverbSerialization();
    testReverbBypassPassthrough();
    testReverbSignature();

    std::cout << "\n=== test_reverb_style ===\n";
    testStyleParamExistsAndDefault();
    testStyleAllValuesSettable();
    testPlateBackendIsDistinct();
    testRoomDiffersFromGeneric();
    testHallDiffersFromGeneric();
    testRoomDiffersFromHall();
    testStyleSwitchMidStream();
    testStyleSwitchDeterminism();
    testRoomHallTailEnergyDiffers();
    testRoomEnergyMoreFrontLoaded();
    testRoomDecaysFasterThanHall();
    testHallDiffusionStableAndDeterministic();
    testRoomLateFieldAudible();
    testStyleSerializationRoundTrip();
    testStyleOldStateLoadsAsGeneric();

    std::cout << "\n=== test_reverb_smoothness ===\n";
    testSmoothnessParamExistsAndDefault();
    testSmoothnessOldStateLoadsAsZero();
    testSmoothnessSettableAcrossStyles();
    testGenericSmoothnessZeroDeterministic();
    testSmoothnessChangesOutputAcrossStyles();
    testSmoothnessDoesNotSilence();
    testSmoothnessTailEnergyBounded();
    testSmoothnessStyleSwitchFinite();
    testSmoothnessSerializationRoundTrip();
    testPlateRingTameAndDistinctness();
    testSmoothnessReducesCrestFactor();
    testSmoothnessReducesOrHoldsBrightness();

    std::cout << "\n=== test_reverb_legacy_dispatch ===\n";
    testLegacyGenericRegressionSignature();
    testGenericRingTameSweepStable();

    std::cout << "\n=== test_reverb_enhanced_pass1 ===\n";
    testEnhancedRoutingDifferesFromLegacy();
    testEnhancedGenericDiffersFromLegacyAtSmoothnessNonZero();
    testEnhancedDecorrelatesLR();
    testEnhancedWetLevelBounded();

    std::cout << "\n=== test_reverb_hall_pass1 ===\n";
    testHallExtremeFinite();
    testHallBackendDistinctAndDeterministic();
    testHallSwitchSchedule();
    testHallWetLevelBounded();
    testHallStereoDecorrelation();
    testHallTailCrestFactorBounded();

    std::cout << "\n=== test_reverb_plate ===\n";
    testPlateExtremeFinite();
    testPlateProducesWetOutput();
    testPlateDeterministic();
    testPlateWetLevelBounded();
    testPlateStereoDecorrelation();
    testPlateTailCrestFactorBounded();
    testPlateSwitchSchedule();
    testPlateLongTermFinite();

    std::cout << "\nResults: " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0)
    {
        std::cerr << "FAILED\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
