// test_xlethfilter_analog.cpp — XlethFilterEffect analog & character slot types
// Build: cmake --build build --config Release --target test_xlethfilter_analog
// Run:   build\engine\Release\test_xlethfilter_analog.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [<line>] <message>" and exits 1
//
// Covers the seven types added on top of the Prompt-1 SVF core:
//   moog24 / acid303 / sk12 / sk24 / steiner{LP,BP,HP} / comb{FF,FB} /
//   formant / tilt
//
// The contract each one is held to:
//   • moog24   — measurably steeper than the 12 dB SVF at the same cutoff, and
//                bounded (no NaN, |peak| < 2) when k is driven to 4
//   • acid303  — a DIFFERENT filter from moog24 at identical settings (both in
//                harmonic content and in what resonance does to the low end,
//                which is the feedback high pass doing its job), and stable
//                through an envelope-speed cutoff slam at high resonance
//   • sk12     — a real resonant peak at fc, and a self-oscillation onset that
//                is gentler than the ladder's
//   • combFB   — spectral peaks at fs/M and its harmonics, with a decay time
//                that matches the T60 the resonance knob asked for
//   • formant  — an ah->ee morph actually moves F1 from the 730 Hz region to
//                the 270 Hz region, click-free across the whole sweep
//   • tilt     — +6 dB lifts 8 kHz, drops 80 Hz, and leaves the pivot alone
//   • steiner  — the injection algebra is EXACT: SteinerLP with no drive is
//                sample-for-sample the plain LP12 it is supposed to reduce to
//
// Plus a per-type CPU cost report against the lp12 baseline (printed, never
// asserted — wall-clock ratios are not a thing to gate a build on).

#include "audio/XlethFilterEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <iomanip>
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

using T = XlethFilterEffect::SlotType;
static constexpr int kLP12    = static_cast<int>(T::LP12);
static constexpr int kMoog    = static_cast<int>(T::Moog24);
static constexpr int kAcid    = static_cast<int>(T::Acid303);
static constexpr int kSK12    = static_cast<int>(T::SK12);
static constexpr int kSK24    = static_cast<int>(T::SK24);
static constexpr int kStLP    = static_cast<int>(T::SteinerLP);
static constexpr int kStBP    = static_cast<int>(T::SteinerBP);
static constexpr int kStHP    = static_cast<int>(T::SteinerHP);
static constexpr int kCombFF  = static_cast<int>(T::CombFF);
static constexpr int kCombFB  = static_cast<int>(T::CombFB);
static constexpr int kFormant = static_cast<int>(T::Formant);
static constexpr int kTilt    = static_cast<int>(T::Tilt);

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

// Configure a single-slot filter from scratch. Returns the slot index.
static int makeSingleSlot(XlethFilterEffect& fx, int type, float cutoff,
                          float q, int slope = 1)
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

// Feed `blocks` blocks of a continuous-phase sine and return the dB gain
// measured over the LAST FOUR blocks — same convention as test_xlethfilter, so
// numbers from the two files are directly comparable. Enough blocks must be
// requested for the 20 ms parameter smoothers to have settled first.
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

// One-shot gain measurement on a freshly built single-slot filter.
//
// The default amplitude is deliberately small. Two things in this effect are
// level-dependent and would corrupt a magnitude measurement taken at 0 dBFS:
// the per-slot output soft clip (which starts bending above 1.0, so any
// resonant peak reads low), and the ladders' per-stage saturation (which is the
// whole point of the nonlinear cores, but is not what a frequency response is).
// -26 dBFS keeps both out of the way; the tests that want the nonlinearity ask
// for it explicitly.
static constexpr float kLinearAmp = 0.05f;

static double gainOf(int type, float cutoff, float q, double freq,
                     int blocks = 16, float amp = kLinearAmp)
{
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);
    makeSingleSlot(fx, type, cutoff, q);
    return measureGainDb(fx, freq, blocks, amp);
}

// Goertzel magnitude at an exact-bin frequency (no window needed as long as the
// capture length holds a whole number of cycles — see kCapture below).
static double goertzelMag(const std::vector<float>& x, double freq, double sr)
{
    const int    n = static_cast<int>(x.size());
    const double w = 2.0 * juce::MathConstants<double>::pi * freq / sr;
    const double c = 2.0 * std::cos(w);
    double s1 = 0.0, s2 = 0.0;
    for (int i = 0; i < n; ++i)
    {
        const double s0 = static_cast<double>(x[i]) + c * s1 - s2;
        s2 = s1; s1 = s0;
    }
    const double re = s1 - s2 * std::cos(w);
    const double im = s2 * std::sin(w);
    return 2.0 * std::sqrt(re * re + im * im) / n;
}

// Drive a settled filter with a sine and capture `n` samples of its output.
static std::vector<float> captureSine(XlethFilterEffect& fx, double freq,
                                      float amp, int warmBlocks, int n)
{
    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    const double twoPi = 2.0 * juce::MathConstants<double>::pi;
    const double inc   = twoPi * freq / kSR;
    double phase = 0.0;

    std::vector<float> out;
    out.reserve(static_cast<size_t>(n));

    const int blocks = warmBlocks + (n + kBS - 1) / kBS;
    for (int b = 0; b < blocks; ++b)
    {
        for (int s = 0; s < kBS; ++s)
        {
            buf.setSample(0, s, amp * static_cast<float>(std::sin(phase)));
            buf.setSample(1, s, buf.getSample(0, s));
            phase += inc;
            if (phase >= twoPi) phase -= twoPi;
        }
        fx.processBlock(buf, midi);
        if (b >= warmBlocks)
        {
            const float* p = buf.getReadPointer(0);
            for (int s = 0; s < kBS && static_cast<int>(out.size()) < n; ++s)
                out.push_back(p[s]);
        }
    }
    return out;
}

// ─── (a) moog24 ──────────────────────────────────────────────────────────────

static void testMoogSlopeAndSelfOsc()
{
    std::cout << "  [a: moog24 rolloff + bounded k=4 self-oscillation]\n";

    // 4 kHz is two octaves over fc: a 12 dB SVF loses ~24 dB there, a 4-pole
    // ladder ~48 dB. Both measured through the identical harness.
    const double g12  = gainOf(kLP12, 1000.0f, 0.7071f, 4000.0);
    const double gLad = gainOf(kMoog, 1000.0f, 0.7071f, 4000.0);

    std::cout << "      4 kHz over fc=1 kHz:  lp12=" << g12
              << "  moog24=" << gLad << " dB\n";

    CHECK(gLad < g12 - 15.0,
          "moog24 is >= 15 dB steeper than lp12 two octaves up ("
              << g12 << " -> " << gLad << ")");

    // The passband must survive: a ladder that is steeper because it is quieter
    // everywhere would also pass the check above.  (1 + 0.5k) leaves a deliberate
    // ~1 dB of droop at neutral Q — full compensation would be 1 + k, and the
    // residual droop is part of the sound.
    const double gPass = gainOf(kMoog, 1000.0f, 0.7071f, 100.0);
    CHECK(gPass > -2.5 && gPass < 1.0,
          "moog24 passband is near unity at 100 Hz, got " << gPass << " dB");

    // ...and the nonlinear core really is nonlinear: the same passband tone at
    // 0 dBFS is compressed by the per-stage saturation, which is exactly what a
    // transistor ladder does and what the linear quality flag turns off.
    const double gHot  = gainOf(kMoog, 1000.0f, 0.7071f, 100.0, 16, 1.0f);
    std::cout << "      100 Hz passband:  -26 dBFS " << gPass << " dB,  0 dBFS "
              << gHot << " dB\n";
    CHECK(gHot < gPass - 1.0,
          "moog24's per-stage saturation compresses a 0 dBFS passband tone ("
              << gPass << " -> " << gHot << ")");

    // Q at the maximum drives the global feedback to k = 4, the classic ladder
    // self-oscillation point. The tanh in the feedback path is the only thing
    // bounding it.
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);
    makeSingleSlot(fx, kMoog, 500.0f, 30.0f);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    const double twoPi = 2.0 * juce::MathConstants<double>::pi;
    const double inc   = twoPi * 500.0 / kSR;
    double phase = 0.0;

    float maxAll = 0.0f;
    bool  finite = true;

    for (int b = 0; b < 4; ++b)     // excite at fc
    {
        for (int i = 0; i < kBS; ++i)
        {
            buf.setSample(0, i, 0.5f * static_cast<float>(std::sin(phase)));
            buf.setSample(1, i, buf.getSample(0, i));
            phase += inc;
            if (phase >= twoPi) phase -= twoPi;
        }
        fx.processBlock(buf, midi);
        finite = finite && isFiniteBuffer(buf);
        maxAll = std::max(maxAll, maxAbsBuffer(buf));
    }

    float lastSilent = 0.0f;
    for (int b = 0; b < 40; ++b)    // then pure silence, for a long time
    {
        buf.clear();
        fx.processBlock(buf, midi);
        finite = finite && isFiniteBuffer(buf);
        const float pk = maxAbsBuffer(buf);
        maxAll     = std::max(maxAll, pk);
        lastSilent = pk;
    }

    CHECK(finite, "moog24 at k=4 produces no NaN/inf");
    CHECK(maxAll < 2.0f,
          "moog24 at k=4 stays bounded below 2.0, peak " << maxAll);
    CHECK(lastSilent < 2.0f,
          "moog24 self-oscillation does not grow without limit, last peak "
              << lastSilent);
    std::cout << "      k=4 peak " << maxAll << ", steady-state " << lastSilent << "\n";
}

// ─── (b) acid303 ─────────────────────────────────────────────────────────────

static void testAcid303DiffersFromMoog()
{
    std::cout << "  [b1: acid303 harmonic content differs from moog24]\n";

    // 4410 samples at 44.1 kHz = exactly 11 cycles of 110 Hz, so 110 Hz and
    // every one of its harmonics lands on an exact Goertzel bin.
    constexpr int    kCapture = 4410;
    constexpr double kFund    = 110.0;

    auto profileOf = [](int type) {
        XlethFilterEffect fx;
        fx.prepareToPlay(kSR, kBS);
        const int s = makeSingleSlot(fx, type, 800.0f, 25.0f);
        fx.setSlotParam(s, "drive", 6.0f);
        const auto cap = captureSine(fx, kFund, 0.8f, 12, kCapture);

        std::vector<double> harmDb;
        const double fund = std::max(goertzelMag(cap, kFund, kSR), 1e-12);
        for (int h = 2; h <= 8; ++h)
            harmDb.push_back(20.0 * std::log10(
                std::max(goertzelMag(cap, kFund * h, kSR), 1e-12) / fund));
        return harmDb;
    };

    const auto moog = profileOf(kMoog);
    const auto acid = profileOf(kAcid);

    double maxDiff = 0.0;
    std::cout << "      harmonic (dB rel. fundamental)  moog24 / acid303\n";
    for (size_t i = 0; i < moog.size(); ++i)
    {
        maxDiff = std::max(maxDiff, std::abs(moog[i] - acid[i]));
        std::cout << "        h" << (i + 2) << "  " << std::setw(9) << moog[i]
                  << "  " << std::setw(9) << acid[i] << "\n";
    }
    CHECK(maxDiff > 1.5,
          "acid303 and moog24 produce different harmonic content at identical "
          "settings (largest difference " << maxDiff << " dB)");

    // The structural difference, isolated: the 303 puts a 150 Hz high pass in
    // the resonance feedback path, so winding resonance up does not gut its low
    // end the way it guts the transistor ladder's. Measured as a DELTA between
    // low and high resonance, which is immune to any overall level trim, and at
    // a level where neither ladder is saturating — this is a structural claim
    // about the feedback path, not about the nonlinearity.
    const double moogLo = gainOf(kMoog, 800.0f, 0.7071f, 50.0, 20);
    const double moogHi = gainOf(kMoog, 800.0f, 28.0f,   50.0, 20);
    const double acidLo = gainOf(kAcid, 800.0f, 0.7071f, 50.0, 20);
    const double acidHi = gainOf(kAcid, 800.0f, 28.0f,   50.0, 20);
    const double moogDelta = moogHi - moogLo;
    const double acidDelta = acidHi - acidLo;

    std::cout << "      50 Hz, low->high resonance:  moog24 " << moogDelta
              << " dB,  acid303 " << acidDelta << " dB\n";
    CHECK(acidDelta > moogDelta + 2.0,
          "acid303's feedback high pass keeps its low end under resonance where "
          "moog24 loses it (moog " << moogDelta << " dB vs acid " << acidDelta << " dB)");
}

static void testAcid303FastSweepIsStable()
{
    std::cout << "  [b2: acid303 envelope-speed cutoff slam at high resonance]\n";
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);
    const int s = makeSingleSlot(fx, kAcid, 150.0f, 28.0f);
    fx.setSlotParam(s, "drive", 9.0f);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    const double twoPi = 2.0 * juce::MathConstants<double>::pi;
    const double inc   = twoPi * 110.0 / kSR;
    double phase = 0.0;

    float maxOut = 0.0f;
    bool  finite = true;

    // 32 full slams between the extremes, one block each — the smoother covers
    // essentially the whole travel inside a single block, which is faster than
    // any real 303 envelope and is the case that kills a direct-form biquad.
    for (int rep = 0; rep < 32; ++rep)
    {
        fx.setSlotParam(s, "cutoff", (rep % 2 == 0) ? 6000.0f : 150.0f);
        for (int i = 0; i < kBS; ++i)
        {
            buf.setSample(0, i, 0.6f * static_cast<float>(std::sin(phase)));
            buf.setSample(1, i, buf.getSample(0, i));
            phase += inc;
            if (phase >= twoPi) phase -= twoPi;
        }
        fx.processBlock(buf, midi);
        finite = finite && isFiniteBuffer(buf);
        maxOut = std::max(maxOut, maxAbsBuffer(buf));
    }

    CHECK(finite, "acid303 cutoff slam at Q=28 produces no NaN/inf");
    CHECK(maxOut < 2.0f, "acid303 cutoff slam stays bounded, peak " << maxOut);

    // And it is still a working filter afterwards, not a locked-up state.
    fx.setSlotParam(s, "cutoff", 400.0f);
    fx.setSlotParam(s, "q", 0.7071f);
    fx.setSlotParam(s, "drive", 0.0f);
    const double at8k = measureGainDb(fx, 8000.0, 20, kLinearAmp);
    CHECK(at8k < -30.0,
          "acid303 still attenuates after the slam, got " << at8k << " dB");
}

static void testAcid303CutoffIsClampedByDynRange()
{
    std::cout << "  [b3: acid303 modulated cutoff respects cut_min/cut_max]\n";
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);
    const int s = makeSingleSlot(fx, kAcid, 320.0f, 20.0f);
    fx.setSlotParam(s, "cut_min",   300.0f);
    fx.setSlotParam(s, "cut_max",   1200.0f);
    fx.setSlotParam(s, "dyn_depth", 1.0f);
    fx.setSlotParam(s, "dyn_attack", 1.0f);
    fx.setSlotParam(s, "dyn_release", 40.0f);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    const double twoPi = 2.0 * juce::MathConstants<double>::pi;
    const double inc   = twoPi * 220.0 / kSR;
    double phase = 0.0;

    float loSeen = 1.0e9f, hiSeen = 0.0f;
    bool  finite = true;

    // Hard transient bursts, exactly the acid-envelope case: full scale for one
    // block, then four silent ones (93 ms — long enough for the 100 ms accent
    // lag to leak most of the way back down), so the follower slams both ways.
    for (int b = 0; b < 60; ++b)
    {
        const float amp = (b % 5 == 0) ? 0.95f : 0.0f;
        for (int i = 0; i < kBS; ++i)
        {
            buf.setSample(0, i, amp * static_cast<float>(std::sin(phase)));
            buf.setSample(1, i, buf.getSample(0, i));
            phase += inc;
            if (phase >= twoPi) phase -= twoPi;
        }
        fx.processBlock(buf, midi);
        finite = finite && isFiniteBuffer(buf);
        if (b > 6)
        {
            const float eff = fx.getSlotEffectiveCutoff(s);
            loSeen = std::min(loSeen, eff);
            hiSeen = std::max(hiSeen, eff);
        }
    }

    std::cout << "      effective cutoff swept " << loSeen << " .. " << hiSeen
              << " Hz inside [300, 1200]\n";
    CHECK(finite, "acid303 under dynamics modulation produces no NaN/inf");
    CHECK(loSeen >= 299.0f && hiSeen <= 1201.0f,
          "the modulated cutoff stays inside cut_min/cut_max, saw "
              << loSeen << " .. " << hiSeen);
    CHECK(hiSeen > loSeen * 1.5f,
          "the follower actually swept the cutoff (" << loSeen << " -> "
              << hiSeen << " Hz)");
}

// ─── (c) Sallen-Key ──────────────────────────────────────────────────────────

// Excite a filter at fc, then measure the peak of the first and last block of a
// long silent tail. Returns the ratio last/first — ~0 for a decaying resonator,
// ~1 for a sustaining oscillator.
static double ringSustainRatio(int type, float fc, float q, float& peakOut,
                               bool& finiteOut)
{
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);
    makeSingleSlot(fx, type, fc, q);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    const double twoPi = 2.0 * juce::MathConstants<double>::pi;
    const double inc   = twoPi * fc / kSR;
    double phase = 0.0;

    peakOut   = 0.0f;
    finiteOut = true;

    for (int b = 0; b < 6; ++b)
    {
        for (int i = 0; i < kBS; ++i)
        {
            buf.setSample(0, i, 0.2f * static_cast<float>(std::sin(phase)));
            buf.setSample(1, i, buf.getSample(0, i));
            phase += inc;
            if (phase >= twoPi) phase -= twoPi;
        }
        fx.processBlock(buf, midi);
        finiteOut = finiteOut && isFiniteBuffer(buf);
        peakOut   = std::max(peakOut, maxAbsBuffer(buf));
    }

    double first = 0.0, last = 0.0;
    for (int b = 0; b < 20; ++b)
    {
        buf.clear();
        fx.processBlock(buf, midi);
        finiteOut = finiteOut && isFiniteBuffer(buf);
        const float pk = maxAbsBuffer(buf);
        peakOut = std::max(peakOut, pk);
        if (b == 0)  first = pk;
        if (b == 19) last  = pk;
    }
    return (first > 1e-9) ? (last / first) : 0.0;
}

static void testSallenKeyResonanceAndOnset()
{
    std::cout << "  [c: sk12 resonant peak + gentler self-osc onset]\n";

    const double atFc  = gainOf(kSK12, 1000.0f, 8.0f, 1000.0, 20);
    const double below = gainOf(kSK12, 1000.0f, 8.0f, 250.0,  16);
    const double above = gainOf(kSK12, 1000.0f, 8.0f, 4000.0, 16);

    std::cout << "      sk12 Q=8:  250 Hz " << below << ",  fc " << atFc
              << ",  4 kHz " << above << " dB\n";

    CHECK(atFc > 10.0,
          "sk12 at Q=8 has a real resonant peak at fc, got " << atFc << " dB");
    CHECK(atFc > below + 10.0,
          "sk12's peak stands above its passband (" << below << " -> " << atFc << ")");
    CHECK(above < atFc - 20.0,
          "sk12 rolls off above fc (" << atFc << " -> " << above << ")");

    // sk24 is the same section twice: steeper, still stable.
    const double above24 = gainOf(kSK24, 1000.0f, 0.7071f, 4000.0);
    const double above12 = gainOf(kSK12, 1000.0f, 0.7071f, 4000.0);
    CHECK(above24 < above12 - 15.0,
          "sk24 is >= 15 dB steeper than sk12 two octaves up ("
              << above12 << " -> " << above24 << ")");

    // Onset: at the top of the Q range the Sallen-Key's resonance is LINEAR and
    // still decays, while the ladder at k=4 sustains. Same excitation, same
    // silent tail, so the two ratios are directly comparable.
    float skPeak = 0.0f, ladPeak = 0.0f;
    bool  skFin = true, ladFin = true;
    const double skRatio  = ringSustainRatio(kSK12, 500.0f, 30.0f, skPeak,  skFin);
    const double ladRatio = ringSustainRatio(kMoog, 500.0f, 30.0f, ladPeak, ladFin);

    std::cout << "      silent-tail sustain ratio:  sk12 " << skRatio
              << ",  moog24 " << ladRatio << "\n";

    CHECK(skFin && ladFin, "neither self-osc tail produces NaN/inf");
    CHECK(skPeak < 2.0f, "sk12 at max Q stays bounded, peak " << skPeak);
    CHECK(skRatio < ladRatio,
          "sk12's self-oscillation onset is gentler than the ladder's ("
              << skRatio << " vs " << ladRatio << ")");
}

// ─── Steiner-Parker ──────────────────────────────────────────────────────────

static void testSteinerInjectionModes()
{
    std::cout << "  [steiner: injection modes + exact reduction to lp12]\n";

    // The three injection points give three responses out of ONE core.
    const double lpLow  = gainOf(kStLP, 1000.0f, 0.7071f, 200.0);
    const double lpHigh = gainOf(kStLP, 1000.0f, 0.7071f, 8000.0);
    CHECK(std::abs(lpLow) < 1.5 && lpHigh < -25.0,
          "steinerLP passes 200 Hz (" << lpLow << ") and cuts 8 kHz (" << lpHigh << ")");

    const double bpLow  = gainOf(kStBP, 1000.0f, 4.0f, 100.0);
    const double bpMid  = gainOf(kStBP, 1000.0f, 4.0f, 1000.0, 20);
    const double bpHigh = gainOf(kStBP, 1000.0f, 4.0f, 10000.0);
    CHECK(bpMid > bpLow + 15.0 && bpMid > bpHigh + 15.0,
          "steinerBP peaks at fc (" << bpLow << " / " << bpMid << " / " << bpHigh << ")");

    const double hpLow  = gainOf(kStHP, 1000.0f, 0.7071f, 100.0);
    const double hpHigh = gainOf(kStHP, 1000.0f, 0.7071f, 8000.0);
    CHECK(hpHigh > hpLow + 15.0,
          "steinerHP passes highs over lows (" << hpLow << " -> " << hpHigh << ")");

    // The strong one: with drive at 0, injecting at the HP node IS the standard
    // SVF input, so steinerLP must be sample-for-sample identical to lp12. If
    // the injection algebra (the "+ub / -ub" in the state update) were wrong,
    // this is where it would show.
    XlethFilterEffect a, b;
    a.prepareToPlay(kSR, kBS);
    b.prepareToPlay(kSR, kBS);
    makeSingleSlot(a, kLP12, 900.0f, 3.0f);
    makeSingleSlot(b, kStLP, 900.0f, 3.0f);

    juce::AudioBuffer<float> ba(2, kBS), bb(2, kBS);
    juce::MidiBuffer midi;
    juce::Random rng(20260811);
    float maxDelta = 0.0f;

    for (int blk = 0; blk < 12; ++blk)
    {
        for (int i = 0; i < kBS; ++i)
        {
            const float v = rng.nextFloat() * 1.2f - 0.6f;
            ba.setSample(0, i, v); ba.setSample(1, i, v);
            bb.setSample(0, i, v); bb.setSample(1, i, v);
        }
        a.processBlock(ba, midi);
        b.processBlock(bb, midi);
        for (int i = 0; i < kBS; ++i)
            maxDelta = std::max(maxDelta,
                                std::abs(ba.getSample(0, i) - bb.getSample(0, i)));
    }

    CHECK(maxDelta < 1.0e-6f,
          "steinerLP with no drive reduces EXACTLY to lp12 (max sample delta "
              << maxDelta << ")");
}

// ─── (d) comb ────────────────────────────────────────────────────────────────

static void testCombFeedbackPeaksAndDecay()
{
    std::cout << "  [d: combFB spectral peaks at fs/M + T60 decay]\n";

    // 441 Hz at 44.1 kHz is a delay of exactly M = 100 samples, so the peaks sit
    // on 441, 882, ... and the anti-peaks halfway between them.
    constexpr float kCombHz = 441.0f;
    constexpr float kQ      = 5.0f;

    const double peak1 = gainOf(kCombFB, kCombHz, kQ, 441.0,  24, 0.02f);
    const double peak2 = gainOf(kCombFB, kCombHz, kQ, 882.0,  24, 0.02f);
    const double null1 = gainOf(kCombFB, kCombHz, kQ, 661.5,  24, 0.02f);

    std::cout << "      combFB fs/M=441:  441 Hz " << peak1 << ",  882 Hz "
              << peak2 << ",  661.5 Hz (between) " << null1 << " dB\n";

    CHECK(peak1 > null1 + 15.0,
          "combFB peaks at fs/M relative to the frequency between peaks ("
              << null1 << " -> " << peak1 << ")");
    CHECK(peak2 > null1 + 15.0,
          "combFB peaks at the 2nd harmonic of fs/M too (" << null1 << " -> "
              << peak2 << ")");

    // Feedforward is the complementary shape: a NOTCH between the peaks.
    const double ffPeak = gainOf(kCombFF, kCombHz, 20.0f, 441.0, 24, 0.2f);
    const double ffNull = gainOf(kCombFF, kCombHz, 20.0f, 661.5, 24, 0.2f);
    CHECK(ffPeak > ffNull + 10.0,
          "combFF notches between its peaks (" << ffNull << " -> " << ffPeak << ")");

    // T60: impulse in, measure how long the resonator takes to fall 60 dB, and
    // compare it to the T60 the resonance knob asked for. The mapping is
    // t60 = kCombMinT60 * (kCombMaxT60/kCombMinT60)^qNorm(Q), and the loop gain
    // is derived from it as g = 10^(-3M/(t60*fs)) — so this measures whether the
    // derivation and the delay line agree.
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);
    const int s = makeSingleSlot(fx, kCombFB, kCombHz, kQ);
    fx.setSlotParam(s, "morph", 0.0f);   // no damping in the loop

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;

    for (int b = 0; b < 6; ++b) { buf.clear(); fx.processBlock(buf, midi); }  // settle the gate

    buf.clear();
    buf.setSample(0, 0, 0.5f);
    buf.setSample(1, 0, 0.5f);
    fx.processBlock(buf, midi);

    const float first = maxAbsBuffer(buf);
    double measuredT60 = -1.0;
    bool   finite = isFiniteBuffer(buf);

    for (int b = 1; b < 120; ++b)
    {
        buf.clear();
        fx.processBlock(buf, midi);
        finite = finite && isFiniteBuffer(buf);
        if (measuredT60 < 0.0 && maxAbsBuffer(buf) < first * 1.0e-3f)
            measuredT60 = static_cast<double>(b) * kBS / kSR;
    }

    // The expected T60, recomputed here from the same published mapping so the
    // test is checking the DSP rather than echoing a magic number.
    const double qN = std::log(kQ / XlethFilterEffect::kMinQ)
                    / std::log(XlethFilterEffect::kMaxQ / XlethFilterEffect::kMinQ);
    const double wantT60 = XlethFilterEffect::kCombMinT60
        * std::pow(XlethFilterEffect::kCombMaxT60 / XlethFilterEffect::kCombMinT60, qN);

    std::cout << "      T60 wanted " << wantT60 << " s, measured "
              << measuredT60 << " s\n";

    CHECK(finite, "combFB impulse response produces no NaN/inf");
    CHECK(measuredT60 > 0.0, "combFB actually decays by 60 dB within 2.8 s");
    CHECK(measuredT60 > wantT60 * 0.6 && measuredT60 < wantT60 * 1.45,
          "combFB T60 matches the spec within +/-45% (wanted " << wantT60
              << " s, measured " << measuredT60 << " s)");
}

// ─── (e) formant ─────────────────────────────────────────────────────────────

static void testFormantMorph()
{
    std::cout << "  [e: formant ah->ee moves F1 from 730 Hz to 270 Hz]\n";

    using V = xleth_filter::Vowel;
    auto measure = [](float morph, double freq) {
        XlethFilterEffect fx;
        fx.prepareToPlay(kSR, kBS);
        const int s = makeSingleSlot(fx, kFormant, 1000.0f, 0.7071f);
        fx.setSlotParam(s, "vowel_a", static_cast<float>(V::Ah));
        fx.setSlotParam(s, "vowel_b", static_cast<float>(V::Ee));
        fx.setSlotParam(s, "head",    0.0f);
        fx.setSlotParam(s, "morph",   morph);
        return measureGainDb(fx, freq, 20, kLinearAmp);
    };

    const double ah270 = measure(0.0f, 270.0);
    const double ah730 = measure(0.0f, 730.0);
    const double ee270 = measure(1.0f, 270.0);
    const double ee730 = measure(1.0f, 730.0);

    std::cout << "      ah:  270 Hz " << ah270 << ",  730 Hz " << ah730 << " dB\n";
    std::cout << "      ee:  270 Hz " << ee270 << ",  730 Hz " << ee730 << " dB\n";

    CHECK(ah730 > ah270 + 10.0,
          "vowel ah puts F1 at 730 Hz, not 270 (" << ah270 << " -> " << ah730 << ")");
    CHECK(ee270 > ee730 + 10.0,
          "vowel ee puts F1 at 270 Hz, not 730 (" << ee730 << " -> " << ee270 << ")");
    CHECK(ee270 > ah270 + 10.0,
          "morphing ah->ee lifts the 270 Hz region (" << ah270 << " -> " << ee270 << ")");

    // ...and the whole way across is click-free and bounded, which is what
    // sliding the band frequencies (rather than crossfading two outputs) buys.
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);
    const int s = makeSingleSlot(fx, kFormant, 1000.0f, 0.7071f);
    fx.setSlotParam(s, "vowel_a", static_cast<float>(V::Ah));
    fx.setSlotParam(s, "vowel_b", static_cast<float>(V::Ee));

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    const double twoPi = 2.0 * juce::MathConstants<double>::pi;
    const double inc   = twoPi * 200.0 / kSR;
    double phase = 0.0;

    float maxOut = 0.0f, maxDelta = 0.0f, prev = 0.0f;
    bool  finite = true;

    constexpr int kSteps = 40;
    for (int step = 0; step <= kSteps; ++step)
    {
        fx.setSlotParam(s, "morph", static_cast<float>(step) / kSteps);
        for (int i = 0; i < kBS; ++i)
        {
            buf.setSample(0, i, 0.5f * static_cast<float>(std::sin(phase)));
            buf.setSample(1, i, buf.getSample(0, i));
            phase += inc;
            if (phase >= twoPi) phase -= twoPi;
        }
        fx.processBlock(buf, midi);
        finite = finite && isFiniteBuffer(buf);
        maxOut = std::max(maxOut, maxAbsBuffer(buf));

        const float* p = buf.getReadPointer(0);
        if (step > 0)
            for (int i = 0; i < kBS; ++i)
            {
                maxDelta = std::max(maxDelta, std::abs(p[i] - prev));
                prev = p[i];
            }
        else
            prev = buf.getSample(0, kBS - 1);
    }

    CHECK(finite, "formant morph produces no NaN/inf");
    CHECK(maxOut < 2.0f, "formant morph stays below 2.0, got " << maxOut);
    CHECK(maxDelta < 0.25f,
          "formant morph is click-free (max sample step " << maxDelta << ")");

    // Head size shifts the whole bank: +12 semitones doubles every formant, so
    // the ee peak moves from 270 Hz to about 540 Hz.
    XlethFilterEffect fh;
    fh.prepareToPlay(kSR, kBS);
    const int sh = makeSingleSlot(fh, kFormant, 1000.0f, 0.7071f);
    fh.setSlotParam(sh, "vowel_a", static_cast<float>(V::Ee));
    fh.setSlotParam(sh, "vowel_b", static_cast<float>(V::Ee));
    fh.setSlotParam(sh, "morph",   0.0f);
    fh.setSlotParam(sh, "head",    12.0f);
    const double shifted540 = measureGainDb(fh, 540.0, 24, kLinearAmp);
    const double shifted270 = measureGainDb(fh, 270.0, 24, kLinearAmp);
    std::cout << "      head +12 st:  270 Hz " << shifted270 << ",  540 Hz "
              << shifted540 << " dB\n";
    CHECK(shifted540 > shifted270 + 6.0,
          "head size +12 st moves the ee F1 from 270 Hz up to 540 Hz ("
              << shifted270 << " -> " << shifted540 << ")");
}

// ─── (f) tilt ────────────────────────────────────────────────────────────────

static void testTiltEq()
{
    std::cout << "  [f: tilt +/-6 dB about a 1 kHz pivot]\n";

    auto tiltGain = [](float tiltDb, double freq) {
        XlethFilterEffect fx;
        fx.prepareToPlay(kSR, kBS);
        const int s = makeSingleSlot(fx, kTilt, 1000.0f, 0.7071f);
        fx.setSlotParam(s, "gain", tiltDb);
        return measureGainDb(fx, freq, 24, kLinearAmp);
    };

    const double hi   = tiltGain(6.0f, 8000.0);
    const double lo   = tiltGain(6.0f, 80.0);
    const double mid  = tiltGain(6.0f, 1000.0);

    std::cout << "      +6 dB tilt:  80 Hz " << lo << ",  1 kHz (pivot) " << mid
              << ",  8 kHz " << hi << " dB\n";

    CHECK(hi > 3.0,  "+6 dB tilt boosts 8 kHz, got " << hi << " dB");
    CHECK(lo < -3.0, "+6 dB tilt cuts 80 Hz, got " << lo << " dB");
    CHECK(std::abs(mid) < 1.5,
          "+6 dB tilt leaves the pivot alone, got " << mid << " dB");

    // Negative tilt is the mirror image.
    const double nHi = tiltGain(-6.0f, 8000.0);
    const double nLo = tiltGain(-6.0f, 80.0);
    CHECK(nHi < -3.0 && nLo > 3.0,
          "-6 dB tilt mirrors it (80 Hz " << nLo << ", 8 kHz " << nHi << ")");

    // Zero tilt is transparent.
    CHECK(std::abs(tiltGain(0.0f, 8000.0)) < 0.5 &&
          std::abs(tiltGain(0.0f, 80.0))   < 0.5,
          "0 dB tilt is transparent");
}

// ─── Quality flag + response curve + generic sanity ─────────────────────────

static void testQualityFlagAndCurve()
{
    std::cout << "  [quality flag + response curve for the new types]\n";

    // The linear core is a different (cheaper) filter, but it must still be a
    // filter: same cutoff, same poles, no saturation.
    XlethFilterEffect nl, lin;
    nl.prepareToPlay(kSR, kBS);
    lin.prepareToPlay(kSR, kBS);
    const int a = makeSingleSlot(nl,  kMoog, 800.0f, 20.0f);
    const int b = makeSingleSlot(lin, kMoog, 800.0f, 20.0f);
    nl.setSlotParam(a, "drive", 12.0f);
    lin.setSlotParam(b, "drive", 12.0f);
    CHECK(nl.getSlotNonlinear(a), "slots default to the nonlinear core");
    lin.setSlotNonlinear(b, false);
    CHECK(!lin.getSlotNonlinear(b), "setSlotNonlinear(false) takes effect");

    const double gNl  = measureGainDb(nl,  8000.0, 16, 0.8f);
    const double gLin = measureGainDb(lin, 8000.0, 16, 0.8f);
    CHECK(gNl < -25.0 && gLin < -25.0,
          "both moog24 cores still roll off (" << gNl << " / " << gLin << ")");

    // Every new type must produce a finite response curve that is not silence.
    for (int type : { kMoog, kAcid, kSK12, kSK24, kStLP, kStBP, kStHP,
                      kCombFF, kCombFB, kFormant, kTilt })
    {
        XlethFilterEffect fx;
        fx.prepareToPlay(kSR, kBS);
        const int s = makeSingleSlot(fx, type, 1000.0f, 4.0f);
        fx.setSlotParam(s, "gain", 6.0f);

        std::vector<float> curve(XlethFilterEffect::kResponseSize, 0.0f);
        fx.getResponseCurve(curve.data(), static_cast<int>(curve.size()));

        bool  allFinite = true;
        float lo = 1.0e9f, hi = -1.0e9f;
        for (float v : curve)
        {
            allFinite = allFinite && std::isfinite(v);
            lo = std::min(lo, v);
            hi = std::max(hi, v);
        }
        CHECK(allFinite, "response curve for type " << type << " is finite");
        CHECK(hi - lo > 1.0,
              "response curve for type " << type
                  << " is not flat (span " << (hi - lo) << " dB)");
        CHECK(hi < 80.0,
              "response curve for type " << type << " is not absurd, peak "
                  << hi << " dB");
    }
}

static void testEveryNewTypeIsBoundedAndFinite()
{
    std::cout << "  [all new types: bounded under a hostile signal]\n";

    for (int type : { kMoog, kAcid, kSK12, kSK24, kStLP, kStBP, kStHP,
                      kCombFF, kCombFB, kFormant, kTilt })
    {
        XlethFilterEffect fx;
        fx.prepareToPlay(kSR, kBS);
        const int s = makeSingleSlot(fx, type, 700.0f, 28.0f);
        fx.setSlotParam(s, "drive", 18.0f);
        fx.setSlotParam(s, "gain",  12.0f);

        juce::AudioBuffer<float> buf(2, kBS);
        juce::MidiBuffer midi;
        juce::Random rng(4242 + type);

        float maxOut = 0.0f;
        bool  finite = true;

        for (int blk = 0; blk < 24; ++blk)
        {
            // Full-scale noise, plus a cutoff slam every other block.
            fx.setSlotParam(s, "cutoff", (blk % 2 == 0) ? 60.0f : 9000.0f);
            for (int i = 0; i < kBS; ++i)
            {
                const float v = rng.nextFloat() * 2.0f - 1.0f;
                buf.setSample(0, i, v);
                buf.setSample(1, i, -v);
            }
            fx.processBlock(buf, midi);
            finite = finite && isFiniteBuffer(buf);
            maxOut = std::max(maxOut, maxAbsBuffer(buf));
        }

        CHECK(finite, "type " << type << " produces no NaN/inf under abuse");
        CHECK(maxOut < 2.0f,
              "type " << type << " stays below 2.0 under abuse, peak " << maxOut);
    }

    // A comb that gets bypassed must not still be holding 50 ms of audio when it
    // comes back — clearState has to flush the delay line.
    XlethFilterEffect fx;
    fx.prepareToPlay(kSR, kBS);
    const int s = makeSingleSlot(fx, kCombFB, 441.0f, 20.0f);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    for (int blk = 0; blk < 8; ++blk)   // charge the line up
    {
        for (int i = 0; i < kBS; ++i)
        {
            buf.setSample(0, i, 0.5f);
            buf.setSample(1, i, 0.5f);
        }
        fx.processBlock(buf, midi);
    }

    fx.setSlotParam(s, "enabled", 0.0f);
    for (int blk = 0; blk < 8; ++blk) { buf.clear(); fx.processBlock(buf, midi); }
    fx.setSlotParam(s, "enabled", 1.0f);

    buf.clear();
    fx.processBlock(buf, midi);
    CHECK(maxAbsBuffer(buf) < 1.0e-4f,
          "a re-enabled comb starts from a flushed delay line, saw "
              << maxAbsBuffer(buf));
}

// ─── CPU cost report (printed, not asserted) ────────────────────────────────

static void reportCpuCost()
{
    std::cout << "  [cpu: per-type block cost vs the lp12 SVF baseline]\n";

    struct Case { const char* name; int type; bool nonlinear; };
    const Case cases[] = {
        { "lp12   (baseline)", kLP12,    true  },
        { "lp12 x2 (24 dB)  ", kLP12,    true  },
        { "sk12             ", kSK12,    true  },
        { "sk24             ", kSK24,    true  },
        { "steinerLP        ", kStLP,    true  },
        { "tilt             ", kTilt,    true  },
        { "formant          ", kFormant, true  },
        { "combFB           ", kCombFB,  true  },
        { "moog24  nonlinear", kMoog,    true  },
        { "moog24  linear   ", kMoog,    false },
        { "acid303 nonlinear", kAcid,    true  },
        { "acid303 linear   ", kAcid,    false },
    };

    constexpr int kBlocks = 400;
    double baseline = 0.0;

    for (size_t c = 0; c < sizeof(cases) / sizeof(cases[0]); ++c)
    {
        XlethFilterEffect fx;
        fx.prepareToPlay(kSR, kBS);
        const int s = makeSingleSlot(fx, cases[c].type, 1000.0f, 6.0f,
                                     (c == 1) ? 2 : 1);
        fx.setSlotParam(s, "drive", 6.0f);
        fx.setSlotNonlinear(s, cases[c].nonlinear);

        juce::AudioBuffer<float> buf(2, kBS);
        juce::MidiBuffer midi;
        juce::Random rng(7);
        for (int i = 0; i < kBS; ++i)
        {
            const float v = rng.nextFloat() * 1.0f - 0.5f;
            buf.setSample(0, i, v);
            buf.setSample(1, i, v);
        }

        for (int b = 0; b < 20; ++b) fx.processBlock(buf, midi);   // warm

        const auto t0 = std::chrono::steady_clock::now();
        for (int b = 0; b < kBlocks; ++b) fx.processBlock(buf, midi);
        const auto t1 = std::chrono::steady_clock::now();

        const double us =
            std::chrono::duration<double, std::micro>(t1 - t0).count() / kBlocks;
        if (c == 0) baseline = us;

        std::cout << "      " << cases[c].name << "  " << std::fixed
                  << std::setprecision(2) << us << " us/block   x"
                  << (baseline > 0.0 ? us / baseline : 1.0) << "\n";
        std::cout.unsetf(std::ios::floatfield);
    }

    CHECK(baseline > 0.0, "the CPU baseline measured a non-zero time");
}

// ─── main ────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "=== test_xlethfilter_analog_ladders ===\n";
    testMoogSlopeAndSelfOsc();
    testAcid303DiffersFromMoog();
    testAcid303FastSweepIsStable();
    testAcid303CutoffIsClampedByDynRange();

    std::cout << "\n=== test_xlethfilter_analog_sk_steiner ===\n";
    testSallenKeyResonanceAndOnset();
    testSteinerInjectionModes();

    std::cout << "\n=== test_xlethfilter_analog_character ===\n";
    testCombFeedbackPeaksAndDecay();
    testFormantMorph();
    testTiltEq();

    std::cout << "\n=== test_xlethfilter_analog_engine ===\n";
    testQualityFlagAndCurve();
    testEveryNewTypeIsBoundedAndFinite();

    std::cout << "\n=== test_xlethfilter_analog_cpu ===\n";
    reportCpuCost();

    std::cout << "\nResults: " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0)
    {
        std::cerr << "FAILED\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
