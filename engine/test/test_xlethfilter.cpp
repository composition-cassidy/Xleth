// test_xlethfilter.cpp — XlethFilterEffect (TPT/Cytomic SVF multi-slot filter)
// Build: cmake --build build --config Release --target test_xlethfilter
// Run:   build\engine\Release\test_xlethfilter.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [<line>] <message>" and exits 1
//
// Covers the Prompt-1 DSP contract:
//   • LP12 / HP12 / notch responses measured against the closed-form digital
//     magnitudes of the prewarped TPT SVF (not the analog prototype — the
//     bilinear warp moves 10 kHz noticeably at 44.1 kHz)
//   • morph is click-free and bounded through the whole 0..1 sweep
//   • the 24 dB cascade is measurably steeper than the 12 dB single section
//   • self-oscillation rings, stays bounded, and never produces NaN/inf
//   • a 100 Hz -> 10 kHz cutoff slam at Q = 20 stays stable (the TB-303 case
//     that kills a direct-form biquad)
//   • add/remove slot mid-stream is glitch-free and the slot count survives a
//     state round-trip
//   • the response-curve RPC payload is finite and tracks the audio path

#include "audio/XlethFilterEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <cmath>
#include <iostream>
#include <string>
#include <vector>

// ─── Test harness ────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (cond) {                                                            \
            ++g_passed;                                                        \
        } else {                                                               \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";        \
            ++g_failed;                                                        \
        }                                                                      \
    } while (0)

// ─── Constants + utilities ───────────────────────────────────────────────────

static constexpr double kSR = 44100.0;
static constexpr int    kBS = 1024;

static bool isFiniteBuffer(const juce::AudioBuffer<float>& buf)
{
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        const float* p = buf.getReadPointer(ch);
        for (int s = 0; s < buf.getNumSamples(); ++s)
            if (!std::isfinite(p[s])) return false;
    }
    return true;
}

static float maxAbsBuffer(const juce::AudioBuffer<float>& buf)
{
    float m = 0.0f;
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        const float* p = buf.getReadPointer(ch);
        for (int s = 0; s < buf.getNumSamples(); ++s)
            m = std::max(m, std::abs(p[s]));
    }
    return m;
}

static double rmsOf(const juce::AudioBuffer<float>& buf, int ch)
{
    double sum = 0.0;
    const int n = buf.getNumSamples();
    const float* p = buf.getReadPointer(ch);
    for (int s = 0; s < n; ++s) sum += static_cast<double>(p[s]) * p[s];
    return n > 0 ? std::sqrt(sum / n) : 0.0;
}

// Feed `blocks` blocks of a continuous-phase sine and return the dB gain
// measured over the LAST FOUR blocks.  Averaging four blocks (93 ms) keeps the
// partial-period RMS error small even at 30 Hz, where a single 1024-sample
// block holds under one cycle.  Enough blocks must be requested for the 20 ms
// parameter smoothers to have settled first.
static double measureGainDb(XlethFilterEffect& fx, double freq, int blocks,
                            float amp = 1.0f)
{
    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    const double twoPi = 2.0 * juce::MathConstants<double>::pi;
    const double inc   = twoPi * freq / kSR;
    double phase = 0.0;

    const int measureFrom = std::max(0, blocks - 4);
    double inSum = 0.0, outSum = 0.0;
    long   count = 0;

    for (int b = 0; b < blocks; ++b)
    {
        for (int s = 0; s < kBS; ++s)
        {
            const float v = amp * static_cast<float>(std::sin(phase));
            phase += inc;
            if (phase >= twoPi) phase -= twoPi;
            buf.setSample(0, s, v);
            buf.setSample(1, s, v);
            if (b >= measureFrom) { inSum += static_cast<double>(v) * v; ++count; }
        }
        fx.processBlock(buf, midi);
        if (b >= measureFrom)
        {
            const float* p = buf.getReadPointer(0);
            for (int s = 0; s < kBS; ++s) outSum += static_cast<double>(p[s]) * p[s];
        }
    }

    if (count == 0 || inSum <= 0.0) return -999.0;
    return 10.0 * std::log10(std::max(outSum, 1e-30) / inSum);
}

// Configure a single-slot filter from scratch.  Returns the slot index.
static int makeSingleSlot(XlethFilterEffect& fx, int type, float cutoff,
                          float q, int slope)
{
    const int s = fx.addSlot();
    fx.setSlotParam(s, "type",    static_cast<float>(type));
    fx.setSlotParam(s, "cutoff",  cutoff);
    fx.setSlotParam(s, "q",       q);
    fx.setSlotParam(s, "slope",   static_cast<float>(slope));
    fx.setSlotParam(s, "mix",     1.0f);
    fx.setSlotParam(s, "enabled", 1.0f);
    return s;
}

// ─── (0) Parameter + slot surface ────────────────────────────────────────────

static void testParameterSurface()
{
    std::cout << "  [parameter surface]\n";
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);

    // kNumSlotParams declared params per slot x 8 slots. Asserted against the
    // constant rather than a literal so that adding a slot param has to touch
    // createLayout(), slotParamNames() and the constant together — the three
    // that must agree — instead of quietly breaking this test.
    CHECK(fx.getParameters().size()
              == XlethFilterEffect::kMaxSlots * XlethFilterEffect::kNumSlotParams,
          "layout declares " << XlethFilterEffect::kNumSlotParams
              << " params for each of 8 slots, got " << fx.getParameters().size());

    const std::string paramJson = fx.getParametersAsJSON();
    for (const char* id : { "s0_enabled", "s0_type", "s0_cutoff", "s0_q",
                            "s0_gain", "s0_morph", "s0_slope", "s0_drive",
                            "s0_mix", "s0_cut_min", "s0_cut_max",
                            "s0_dyn_depth", "s0_dyn_attack", "s0_dyn_release",
                            "s7_cutoff", "s7_dyn_release" })
    {
        CHECK(paramJson.find(std::string("\"") + id + "\"") != std::string::npos,
              "param " << id << " is declared in the layout");
    }

    CHECK(fx.getSlotCount() == 0, "a fresh filter starts with zero slots");
    CHECK(std::abs(fx.getTailLengthSeconds() - 0.2) < 1e-9,
          "tail length is 0.2 s");
}

static void testSlotAddRemoveSwap()
{
    std::cout << "  [slot add/remove]\n";
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);

    for (int i = 0; i < XlethFilterEffect::kMaxSlots; ++i)
        CHECK(fx.addSlot() == i, "addSlot returns sequential index " << i);
    CHECK(fx.addSlot() == -1, "addSlot returns -1 once all 8 slots are used");
    CHECK(fx.getSlotCount() == XlethFilterEffect::kMaxSlots, "count saturates at 8");

    // Distinct cutoffs so swap-with-last is observable.
    for (int i = 0; i < XlethFilterEffect::kMaxSlots; ++i)
        fx.setSlotParam(i, "cutoff", 200.0f + 100.0f * i);

    const float lastCutoff = 200.0f + 100.0f * (XlethFilterEffect::kMaxSlots - 1);
    CHECK(fx.removeSlot(2), "removeSlot(2) succeeds");
    CHECK(fx.getSlotCount() == XlethFilterEffect::kMaxSlots - 1, "count drops by one");

    // The last slot was swapped into index 2.
    const auto json = nlohmann::json::parse(fx.getSlotsAsJSON());
    CHECK(static_cast<int>(json.size()) == XlethFilterEffect::kMaxSlots - 1,
          "getSlotsAsJSON reports the live slots only");
    CHECK(std::abs(json[2]["cutoff"].get<float>() - lastCutoff) < 1.0f,
          "removeSlot swaps the last slot into the freed index (got "
              << json[2]["cutoff"].get<float>() << ", want " << lastCutoff << ")");

    CHECK(!fx.removeSlot(99), "removeSlot rejects an out-of-range index");
    CHECK(!fx.setSlotParam(99, "cutoff", 500.0f),
          "setSlotParam rejects an out-of-range index");
}

// ─── (a) LP12 attenuation ────────────────────────────────────────────────────

static void testLowpass12Attenuates()
{
    std::cout << "  [a: LP12 attenuation]\n";
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);
    makeSingleSlot(fx, 0 /*LP12*/, 500.0f, 0.7071f, 1 /*12 dB*/);

    // Prewarped TPT SVF at fs = 44100, fc = 500: the bilinear image of 10 kHz
    // sits at Omega = tan(pi*10000/fs) / tan(pi*500/fs) ~= 24.3, so the
    // 2-pole Butterworth magnitude there is ~ -55 dB (not the -52 dB the
    // analog prototype would predict).
    const double at10k = measureGainDb(fx, 10000.0, 12);
    const double at100 = measureGainDb(fx, 100.0, 12);

    CHECK(at10k < -45.0 && at10k > -75.0,
          "LP12 fc=500 attenuates 10 kHz to ~-55 dB, got " << at10k << " dB");
    CHECK(std::abs(at100) < 1.0,
          "LP12 fc=500 passes 100 Hz within 1 dB, got " << at100 << " dB");
}

// ─── (b) HP12 passband / stopband ────────────────────────────────────────────

static void testHighpass12PassesAndCuts()
{
    std::cout << "  [b: HP12 pass/cut]\n";
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);
    makeSingleSlot(fx, 1 /*HP12*/, 500.0f, 0.7071f, 1);

    const double at10k = measureGainDb(fx, 10000.0, 12);
    const double at50  = measureGainDb(fx, 50.0, 16);

    CHECK(std::abs(at10k) < 1.5,
          "HP12 fc=500 passes 10 kHz within 1.5 dB, got " << at10k << " dB");
    CHECK(at50 < -30.0,
          "HP12 fc=500 cuts 50 Hz by more than 30 dB, got " << at50 << " dB");
}

// ─── (c) Notch depth ─────────────────────────────────────────────────────────

static void testNotchDepth()
{
    std::cout << "  [c: notch depth]\n";
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);
    makeSingleSlot(fx, 3 /*Notch*/, 1000.0f, 0.7071f, 1);

    const double atFc  = measureGainDb(fx, 1000.0, 20);
    const double at100 = measureGainDb(fx, 100.0, 12);

    CHECK(atFc < -30.0,
          "notch at fc is at least 30 dB deep, got " << atFc << " dB");
    CHECK(std::abs(at100) < 1.0,
          "notch leaves 100 Hz within 1 dB, got " << at100 << " dB");
}

// ─── (d) Morph sweep ─────────────────────────────────────────────────────────

static void testMorphSweepIsClickFreeAndBounded()
{
    std::cout << "  [d: morph sweep]\n";
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);
    const int s = makeSingleSlot(fx, 8 /*Morph*/, 1000.0f, 2.0f, 1);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    const double twoPi = 2.0 * juce::MathConstants<double>::pi;
    const double inc   = twoPi * 200.0 / kSR;
    double phase = 0.0;

    float  maxOut   = 0.0f;
    float  maxDelta = 0.0f;
    float  prev     = 0.0f;
    bool   finite   = true;
    bool   sawMid   = false;

    constexpr int kSteps = 40;
    for (int step = 0; step <= kSteps; ++step)
    {
        const float morph = static_cast<float>(step) / kSteps;
        fx.setSlotParam(s, "morph", morph);

        for (int i = 0; i < kBS; ++i)
        {
            const float v = 0.5f * static_cast<float>(std::sin(phase));
            phase += inc;
            if (phase >= twoPi) phase -= twoPi;
            buf.setSample(0, i, v);
            buf.setSample(1, i, v);
        }
        fx.processBlock(buf, midi);

        if (!isFiniteBuffer(buf)) finite = false;
        maxOut = std::max(maxOut, maxAbsBuffer(buf));

        // Skip the very first block: the smoothers are still ramping from the
        // construction defaults, which is a legitimate discontinuity source.
        if (step > 0)
        {
            const float* p = buf.getReadPointer(0);
            for (int i = 0; i < kBS; ++i)
            {
                maxDelta = std::max(maxDelta, std::abs(p[i] - prev));
                prev = p[i];
            }
        }
        else
        {
            prev = buf.getSample(0, kBS - 1);
        }

        // Mid-morph (notch) must actually do something to a 200 Hz tone.
        if (std::abs(morph - 0.5f) < 1e-6f)
            sawMid = (rmsOf(buf, 0) > 0.0);
    }

    CHECK(finite, "morph sweep produces no NaN/inf");
    CHECK(maxOut < 2.0f, "morph sweep output stays below 2.0, got " << maxOut);
    CHECK(maxDelta < 0.25f,
          "morph sweep is click-free (max sample step " << maxDelta << ")");
    CHECK(sawMid, "mid-morph position produces signal");
}

// ─── (e) Slope staging ───────────────────────────────────────────────────────

static void testSlope24IsSteeperThan12()
{
    std::cout << "  [e: 24 dB vs 12 dB slope]\n";

    XlethFilterEffect f12;
    f12.prepareToPlay(kSR, kBS);
    makeSingleSlot(f12, 0 /*LP12*/, 1000.0f, 0.7071f, 1 /*12 dB*/);
    const double g12 = measureGainDb(f12, 4000.0, 12);

    XlethFilterEffect f24;
    f24.prepareToPlay(kSR, kBS);
    makeSingleSlot(f24, 0 /*LP12*/, 1000.0f, 0.7071f, 2 /*24 dB*/);
    const double g24 = measureGainDb(f24, 4000.0, 12);

    XlethFilterEffect f48;
    f48.prepareToPlay(kSR, kBS);
    makeSingleSlot(f48, 0 /*LP12*/, 1000.0f, 0.7071f, 3 /*48 dB*/);
    const double g48 = measureGainDb(f48, 4000.0, 12);

    std::cout << "      4 kHz over fc=1 kHz:  12dB=" << g12
              << "  24dB=" << g24 << "  48dB=" << g48 << " dB\n";

    CHECK(g24 < g12 - 15.0,
          "24 dB slope is >= 15 dB steeper than 12 dB at 2 octaves ("
              << g12 << " -> " << g24 << ")");
    CHECK(g48 < g24 - 15.0,
          "48 dB slope is >= 15 dB steeper than 24 dB at 2 octaves ("
              << g24 << " -> " << g48 << ")");

    // Butterworth staging, not Q=0.7071 on every section: the cascade must be
    // maximally flat, i.e. -3 dB at fc for 24 dB just like for 12 dB. Sharing
    // 0.7071 across both sections would give -6 dB there.
    XlethFilterEffect fAtFc;
    fAtFc.prepareToPlay(kSR, kBS);
    makeSingleSlot(fAtFc, 0 /*LP12*/, 1000.0f, 0.7071f, 2 /*24 dB*/);
    const double atFc = measureGainDb(fAtFc, 1000.0, 16);
    CHECK(std::abs(atFc + 3.0) < 1.2,
          "24 dB cascade is -3 dB at fc (Butterworth staging), got "
              << atFc << " dB");

    // 6 dB is a genuine first-order section: much gentler than 12 dB.
    XlethFilterEffect f6;
    f6.prepareToPlay(kSR, kBS);
    makeSingleSlot(f6, 0 /*LP12*/, 1000.0f, 0.7071f, 0 /*6 dB*/);
    const double g6 = measureGainDb(f6, 4000.0, 12);
    CHECK(g6 > g12 + 5.0,
          "6 dB slope is gentler than 12 dB at 2 octaves (" << g6
              << " vs " << g12 << ")");
}

// ─── (f) Self-oscillation ────────────────────────────────────────────────────

static void testSelfOscillationIsBounded()
{
    std::cout << "  [f: self-oscillation]\n";
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);
    // Q at the maximum engages self-osc: k drops to 0.02 and the resonance
    // feedback integrator is tanh-clipped.
    const int s = makeSingleSlot(fx, 0 /*LP12*/, 500.0f, 30.0f, 1);
    fx.setSlotParam(s, "mix", 1.0f);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    const double twoPi = 2.0 * juce::MathConstants<double>::pi;
    const double inc   = twoPi * 500.0 / kSR;
    double phase = 0.0;

    float maxAll = 0.0f;
    bool  finite = true;

    // Excite at fc for two blocks (a linear filter cannot self-start from
    // exact silence — resonance rings, it does not spontaneously generate).
    for (int b = 0; b < 2; ++b)
    {
        for (int i = 0; i < kBS; ++i)
        {
            const float v = 0.01f * static_cast<float>(std::sin(phase));
            phase += inc;
            if (phase >= twoPi) phase -= twoPi;
            buf.setSample(0, i, v);
            buf.setSample(1, i, v);
        }
        fx.processBlock(buf, midi);
        if (!isFiniteBuffer(buf)) finite = false;
        maxAll = std::max(maxAll, maxAbsBuffer(buf));
    }

    // Now silence: the resonance must ring, stay bounded, and decay.
    float firstSilentPeak = 0.0f;
    float lastSilentPeak  = 0.0f;
    for (int b = 0; b < 12; ++b)
    {
        buf.clear();
        fx.processBlock(buf, midi);
        if (!isFiniteBuffer(buf)) finite = false;
        const float pk = maxAbsBuffer(buf);
        maxAll = std::max(maxAll, pk);
        if (b == 0)  firstSilentPeak = pk;
        if (b == 11) lastSilentPeak  = pk;
    }

    CHECK(finite, "self-osc produces no NaN/inf");
    CHECK(maxAll < 2.0f, "self-osc output stays below 2.0, got " << maxAll);
    CHECK(firstSilentPeak > 1e-4f,
          "self-osc rings into silence (first silent block peak "
              << firstSilentPeak << ")");
    CHECK(lastSilentPeak < firstSilentPeak,
          "self-osc ringing decays rather than growing ("
              << firstSilentPeak << " -> " << lastSilentPeak << ")");
}

// ─── (g) TB-303 stability: fast cutoff slam at high Q ────────────────────────

static void testFastCutoffSweepIsStable()
{
    std::cout << "  [g: fast cutoff sweep at Q=20]\n";
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);
    const int s = makeSingleSlot(fx, 0 /*LP12*/, 100.0f, 20.0f, 1);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    const double twoPi = 2.0 * juce::MathConstants<double>::pi;
    const double inc   = twoPi * 220.0 / kSR;
    double phase = 0.0;

    float maxOut = 0.0f;
    bool  finite = true;

    // 24 full slams between the extremes, one block each: the smoother covers
    // essentially the whole 100 Hz -> 10 kHz travel inside a single block.
    for (int rep = 0; rep < 24; ++rep)
    {
        fx.setSlotParam(s, "cutoff", (rep % 2 == 0) ? 10000.0f : 100.0f);

        for (int i = 0; i < kBS; ++i)
        {
            const float v = 0.5f * static_cast<float>(std::sin(phase));
            phase += inc;
            if (phase >= twoPi) phase -= twoPi;
            buf.setSample(0, i, v);
            buf.setSample(1, i, v);
        }
        fx.processBlock(buf, midi);

        if (!isFiniteBuffer(buf)) finite = false;
        maxOut = std::max(maxOut, maxAbsBuffer(buf));
    }

    CHECK(finite, "fast cutoff sweep at Q=20 produces no NaN/inf");
    CHECK(maxOut < 2.0f,
          "fast cutoff sweep at Q=20 stays bounded, peak " << maxOut);

    // And it is still a working filter afterwards, not a locked-up state.
    fx.setSlotParam(s, "cutoff", 500.0f);
    fx.setSlotParam(s, "q", 0.7071f);
    const double at10k = measureGainDb(fx, 10000.0, 16);
    CHECK(at10k < -40.0,
          "filter still attenuates after the sweep, got " << at10k << " dB");
}

// ─── (h) Live slot edits + state round-trip ──────────────────────────────────

static void testLiveSlotEditsAndSerialization()
{
    std::cout << "  [h: live slot edits + serialization]\n";
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);
    makeSingleSlot(fx, 0 /*LP12*/, 2000.0f, 0.7071f, 1);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    const double twoPi = 2.0 * juce::MathConstants<double>::pi;
    const double inc   = twoPi * 300.0 / kSR;
    double phase = 0.0;

    float maxOut   = 0.0f;
    float maxDelta = 0.0f;
    float prev     = 0.0f;
    bool  finite   = true;
    int   secondSlot = -1;

    for (int b = 0; b < 24; ++b)
    {
        if (b == 6)
        {
            secondSlot = fx.addSlot();
            fx.setSlotParam(secondSlot, "type",   1.0f);   // HP12
            fx.setSlotParam(secondSlot, "cutoff", 120.0f);
        }
        if (b == 16 && secondSlot >= 0)
            fx.removeSlot(secondSlot);

        for (int i = 0; i < kBS; ++i)
        {
            const float v = 0.5f * static_cast<float>(std::sin(phase));
            phase += inc;
            if (phase >= twoPi) phase -= twoPi;
            buf.setSample(0, i, v);
            buf.setSample(1, i, v);
        }
        fx.processBlock(buf, midi);

        if (!isFiniteBuffer(buf)) finite = false;
        maxOut = std::max(maxOut, maxAbsBuffer(buf));

        if (b > 0)
        {
            const float* p = buf.getReadPointer(0);
            for (int i = 0; i < kBS; ++i)
            {
                maxDelta = std::max(maxDelta, std::abs(p[i] - prev));
                prev = p[i];
            }
        }
        else
        {
            prev = buf.getSample(0, kBS - 1);
        }
    }

    CHECK(finite, "add/remove slot mid-stream produces no NaN/inf");
    CHECK(maxOut < 2.0f, "add/remove slot mid-stream stays bounded, peak " << maxOut);
    CHECK(maxDelta < 0.2f,
          "add/remove slot mid-stream is glitch-free (max sample step "
              << maxDelta << ")");
    CHECK(fx.getSlotCount() == 1, "slot count is back to 1 after the removal");

    // ── Slot count round-trips alongside the APVTS state ────────────────────
    XlethFilterEffect src;
    src.prepareToPlay(kSR, kBS);
    for (int i = 0; i < 3; ++i)
    {
        const int s = src.addSlot();
        src.setSlotParam(s, "cutoff", 400.0f + 250.0f * i);
        src.setSlotParam(s, "type",   static_cast<float>(i));
    }

    juce::MemoryBlock blob;
    src.getStateInformation(blob);

    XlethFilterEffect dst;
    dst.prepareToPlay(kSR, kBS);
    dst.setStateInformation(blob.getData(), static_cast<int>(blob.getSize()));

    CHECK(dst.getSlotCount() == 3, "slot count survives the state round-trip, got "
              << dst.getSlotCount());

    const auto a = nlohmann::json::parse(src.getSlotsAsJSON());
    const auto b = nlohmann::json::parse(dst.getSlotsAsJSON());
    CHECK(a.size() == b.size(), "slot JSON sizes match after round-trip");
    bool paramsMatch = (a.size() == b.size());
    for (size_t i = 0; paramsMatch && i < a.size(); ++i)
    {
        paramsMatch = std::abs(a[i]["cutoff"].get<float>()
                             - b[i]["cutoff"].get<float>()) < 1.0f
                   && a[i]["type"].get<int>() == b[i]["type"].get<int>();
    }
    CHECK(paramsMatch, "per-slot params survive the state round-trip");
}

// ─── (i) Response curve ──────────────────────────────────────────────────────

static void testResponseCurve()
{
    std::cout << "  [i: response curve]\n";
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);

    std::vector<float> curve(XlethFilterEffect::kResponseSize, -999.0f);

    // Empty filter: flat 0 dB.
    fx.getResponseCurve(curve.data(), static_cast<int>(curve.size()));
    bool flat = true;
    for (float v : curve) flat = flat && std::isfinite(v) && std::abs(v) < 0.01f;
    CHECK(flat, "response curve of a slot-less filter is flat 0 dB");

    makeSingleSlot(fx, 0 /*LP12*/, 1000.0f, 0.7071f, 1);
    fx.getResponseCurve(curve.data(), static_cast<int>(curve.size()));

    bool finite = true;
    for (float v : curve) finite = finite && std::isfinite(v);
    CHECK(finite, "response curve values are all finite");

    // Index -> frequency is log-spaced over [20, 20000].
    const int n = static_cast<int>(curve.size());
    auto binFor = [n](double hz) {
        const double t = (std::log(hz) - std::log(20.0))
                       / (std::log(20000.0) - std::log(20.0));
        return std::clamp(static_cast<int>(std::lround(t * (n - 1))), 0, n - 1);
    };

    const float at20   = curve[binFor(20.0)];
    const float atFc   = curve[binFor(1000.0)];
    const float at10k  = curve[binFor(10000.0)];

    CHECK(std::abs(at20) < 0.5f,
          "LP12 curve is ~0 dB in the passband, got " << at20 << " dB");
    CHECK(std::abs(atFc + 3.0f) < 1.0f,
          "LP12 curve is ~-3 dB at fc, got " << atFc << " dB");
    CHECK(at10k < -35.0f,
          "LP12 curve is deep in the stopband at 10 kHz, got " << at10k << " dB");

    // Monotone decreasing above fc for a lowpass.
    bool monotone = true;
    for (int i = binFor(1500.0); i < n - 1; ++i)
        if (curve[i + 1] > curve[i] + 0.01f) { monotone = false; break; }
    CHECK(monotone, "LP12 curve falls monotonically above fc");

    // The curve must agree with what the audio path actually does.
    XlethFilterEffect audioFx;
    audioFx.prepareToPlay(kSR, kBS);
    makeSingleSlot(audioFx, 0 /*LP12*/, 1000.0f, 0.7071f, 1);
    const double measured = measureGainDb(audioFx, 4000.0, 16);
    const float  predicted = curve[binFor(4000.0)];
    CHECK(std::abs(measured - predicted) < 1.5,
          "response curve matches the measured audio path at 4 kHz (curve "
              << predicted << " dB vs measured " << measured << " dB)");
}

// ─── Extra coverage: types, drive, mix ───────────────────────────────────────

static void testRemainingSlotTypes()
{
    std::cout << "  [extra: bp / allpass / peak / shelves]\n";

    {   // Bandpass: unity at fc, rolls off both sides.
        XlethFilterEffect fx;
        fx.prepareToPlay(kSR, kBS);
        makeSingleSlot(fx, 2 /*BP*/, 1000.0f, 1.0f, 1);
        const double atFc  = measureGainDb(fx, 1000.0, 16);
        const double at100 = measureGainDb(fx, 100.0, 12);
        const double at10k = measureGainDb(fx, 10000.0, 12);
        CHECK(std::abs(atFc) < 1.0, "BP is ~unity at fc, got " << atFc << " dB");
        CHECK(at100 < -15.0, "BP rolls off below fc, got " << at100 << " dB");
        CHECK(at10k < -15.0, "BP rolls off above fc, got " << at10k << " dB");
    }

    {   // Allpass: magnitude flat everywhere.
        XlethFilterEffect fx;
        fx.prepareToPlay(kSR, kBS);
        makeSingleSlot(fx, 4 /*Allpass*/, 1000.0f, 0.7071f, 1);
        for (double f : { 100.0, 1000.0, 8000.0 })
        {
            const double g = measureGainDb(fx, f, 16);
            CHECK(std::abs(g) < 0.6,
                  "allpass is magnitude-flat at " << f << " Hz, got " << g << " dB");
        }
    }

    {   // Peak/bell: +12 dB at fc, transparent far away.
        XlethFilterEffect fx;
        fx.prepareToPlay(kSR, kBS);
        const int s = makeSingleSlot(fx, 5 /*Peak*/, 1000.0f, 2.0f, 1);
        fx.setSlotParam(s, "gain", 12.0f);
        const double atFc = measureGainDb(fx, 1000.0, 20, 0.2f);
        const double at60 = measureGainDb(fx, 60.0, 16, 0.2f);
        CHECK(std::abs(atFc - 12.0) < 1.0,
              "bell gives +12 dB at fc, got " << atFc << " dB");
        CHECK(std::abs(at60) < 1.0,
              "bell is transparent well below fc, got " << at60 << " dB");
    }

    {   // Low shelf: +12 dB at DC end, unity at the top.
        XlethFilterEffect fx;
        fx.prepareToPlay(kSR, kBS);
        const int s = makeSingleSlot(fx, 6 /*LowShelf*/, 1000.0f, 0.7071f, 1);
        fx.setSlotParam(s, "gain", 12.0f);
        const double lo = measureGainDb(fx, 60.0, 20, 0.2f);
        const double hi = measureGainDb(fx, 12000.0, 16, 0.2f);
        CHECK(std::abs(lo - 12.0) < 1.5, "low shelf boosts 60 Hz by ~12 dB, got " << lo);
        CHECK(std::abs(hi) < 1.0, "low shelf leaves 12 kHz alone, got " << hi);
    }

    {   // High shelf: +12 dB up top, unity at the bottom.
        XlethFilterEffect fx;
        fx.prepareToPlay(kSR, kBS);
        const int s = makeSingleSlot(fx, 7 /*HighShelf*/, 1000.0f, 0.7071f, 1);
        fx.setSlotParam(s, "gain", 12.0f);
        const double hi = measureGainDb(fx, 12000.0, 20, 0.2f);
        const double lo = measureGainDb(fx, 60.0, 16, 0.2f);
        CHECK(std::abs(hi - 12.0) < 1.5, "high shelf boosts 12 kHz by ~12 dB, got " << hi);
        CHECK(std::abs(lo) < 1.0, "high shelf leaves 60 Hz alone, got " << lo);
    }
}

static void testMixAndBypassAndDrive()
{
    std::cout << "  [extra: mix / enabled / drive]\n";

    {   // mix = 0 is a true dry passthrough for an otherwise brutal filter.
        XlethFilterEffect fx;
        fx.prepareToPlay(kSR, kBS);
        const int s = makeSingleSlot(fx, 0 /*LP12*/, 100.0f, 0.7071f, 3 /*48 dB*/);
        fx.setSlotParam(s, "mix", 0.0f);
        const double g = measureGainDb(fx, 8000.0, 16);
        CHECK(std::abs(g) < 0.5, "mix=0 is dry passthrough, got " << g << " dB");
    }

    {   // enabled = 0 bypasses the slot entirely.
        XlethFilterEffect fx;
        fx.prepareToPlay(kSR, kBS);
        const int s = makeSingleSlot(fx, 0 /*LP12*/, 100.0f, 0.7071f, 3);
        fx.setSlotParam(s, "enabled", 0.0f);
        const double g = measureGainDb(fx, 8000.0, 16);
        CHECK(std::abs(g) < 0.5, "enabled=0 bypasses the slot, got " << g << " dB");
    }

    {   // Drive contract: 0 dB is transparent; small signals keep unity gain at
        // any drive; hot signals saturate instead of running away.
        XlethFilterEffect clean;
        clean.prepareToPlay(kSR, kBS);
        const int cs = makeSingleSlot(clean, 0 /*LP12*/, 18000.0f, 0.7071f, 1);
        clean.setSlotParam(cs, "drive", 0.0f);
        const double gClean = measureGainDb(clean, 1000.0, 16, 0.9f);
        CHECK(std::abs(gClean) < 0.5,
              "drive=0 dB is transparent, got " << gClean << " dB");

        XlethFilterEffect quiet;
        quiet.prepareToPlay(kSR, kBS);
        const int qs = makeSingleSlot(quiet, 0 /*LP12*/, 18000.0f, 0.7071f, 1);
        quiet.setSlotParam(qs, "drive", 18.0f);
        const double gQuiet = measureGainDb(quiet, 1000.0, 16, 0.01f);
        CHECK(std::abs(gQuiet) < 0.5,
              "drive keeps small-signal gain at unity, got " << gQuiet << " dB");

        XlethFilterEffect hot;
        hot.prepareToPlay(kSR, kBS);
        const int hs = makeSingleSlot(hot, 0 /*LP12*/, 18000.0f, 0.7071f, 1);
        hot.setSlotParam(hs, "drive", 18.0f);
        const double gHot = measureGainDb(hot, 1000.0, 16, 0.9f);
        CHECK(gHot < -6.0,
              "drive saturates a hot signal, got " << gHot << " dB");
        CHECK(gHot > -25.0,
              "drive saturation stays in a usable range, got " << gHot << " dB");
    }
}

static void testSerialSlotsCompose()
{
    std::cout << "  [extra: serial slot composition]\n";
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);

    // LP at 4 kHz followed by HP at 200 Hz = a bandpass shelf.
    const int a = fx.addSlot();
    fx.setSlotParam(a, "type", 0.0f);
    fx.setSlotParam(a, "cutoff", 4000.0f);
    const int b = fx.addSlot();
    fx.setSlotParam(b, "type", 1.0f);
    fx.setSlotParam(b, "cutoff", 200.0f);

    const double mid = measureGainDb(fx, 1000.0, 16);
    const double lo  = measureGainDb(fx, 30.0, 20);
    const double hi  = measureGainDb(fx, 16000.0, 16);

    CHECK(std::abs(mid) < 1.5, "two serial slots pass the band centre, got " << mid);
    CHECK(lo < -25.0, "serial HP slot cuts 30 Hz, got " << lo << " dB");
    CHECK(hi < -20.0, "serial LP slot cuts 16 kHz, got " << hi << " dB");
    CHECK(fx.getSlotCount() == 2, "both slots are live");
}

// ─── main ────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "=== test_xlethfilter_surface ===\n";
    testParameterSurface();
    testSlotAddRemoveSwap();

    std::cout << "\n=== test_xlethfilter_responses ===\n";
    testLowpass12Attenuates();
    testHighpass12PassesAndCuts();
    testNotchDepth();
    testRemainingSlotTypes();

    std::cout << "\n=== test_xlethfilter_morph_slopes ===\n";
    testMorphSweepIsClickFreeAndBounded();
    testSlope24IsSteeperThan12();

    std::cout << "\n=== test_xlethfilter_stability ===\n";
    testSelfOscillationIsBounded();
    testFastCutoffSweepIsStable();

    std::cout << "\n=== test_xlethfilter_engine ===\n";
    testLiveSlotEditsAndSerialization();
    testMixAndBypassAndDrive();
    testSerialSlotsCompose();
    testResponseCurve();

    std::cout << "\nResults: " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0)
    {
        std::cerr << "FAILED\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
