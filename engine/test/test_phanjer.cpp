// test_phanjer.cpp — PhanjerEffect (parallel flanger + phaser with collision leveling)
// Build: cmake --build build --config Release --target test_phanjer
// Run:   build\engine\Release\test_phanjer.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [<line>] <message>" and exits 1
//
// Covers PHANJER_HANDOFF.md §7 items 1–6:
//   1. Param contract   — every id in the §2 table exists with its range/default,
//                         and set/get round-trips through the APVTS.
//   2. State round-trip — getStateInformation → mutate → setStateInformation.
//   3. Silence          — silence in / silence out, 3 modes × 5 LFO shapes, 2 s each.
//   4. Fuzz             — random extreme param jumps per block over noise at
//                         192 kHz with the delay sweep at its 20 ms / depth 100
//                         worst case: output stays finite and bounded.
//   5. Leveling         — the money test. Both sweeps parked (depth 0) on ranges
//                         where a flanger comb peak lands exactly on the phaser's
//                         feedback peak; SMART's magnitude at that frequency must
//                         sit at least 3 dB below WILD's.
//   6. resolveRateHz    — pure-function table at 140 BPM.
//   (+) collision metric — the pure function that drives test 5, checked directly
//                          at coincidence, at the guard-band edge, and detuned.

#include "audio/PhanjerEffect.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

// ─── Harness ─────────────────────────────────────────────────────────────────

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

namespace
{
constexpr double kSR = 48000.0;
constexpr int    kBS = 512;

// Deterministic xorshift32 — identical noise for every run and every mode.
struct Rng
{
    std::uint32_t s;
    explicit Rng(std::uint32_t seed) : s(seed ? seed : 1u) {}
    float next01()
    {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        return static_cast<float>(s & 0x00FFFFFFu) / 16777215.0f;
    }
    float bipolar() { return next01() * 2.0f - 1.0f; }
};

juce::RangedAudioParameter* findParam(juce::AudioProcessor& p, const char* id)
{
    for (auto* raw : p.getParameters())
        if (auto* rp = dynamic_cast<juce::RangedAudioParameter*>(raw))
            if (rp->paramID == juce::String(id))
                return rp;
    return nullptr;
}

bool bufferIsFinite(const juce::AudioBuffer<float>& buf)
{
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        const float* p = buf.getReadPointer(ch);
        for (int s = 0; s < buf.getNumSamples(); ++s)
            if (!std::isfinite(p[s])) return false;
    }
    return true;
}

float bufferMaxAbs(const juce::AudioBuffer<float>& buf)
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

// Single-frequency DFT magnitude (Hann-windowed) — the input and the output are
// analysed with the same window and the same noise realisation, so the ratio is
// the system's magnitude response at `freq`, not a noise estimate.
double magnitudeAt(const std::vector<float>& x, double freq, double sr)
{
    const size_t n = x.size();
    double re = 0.0, im = 0.0;
    const double w = 2.0 * juce::MathConstants<double>::pi * freq / sr;
    for (size_t i = 0; i < n; ++i)
    {
        const double hann = 0.5 - 0.5 * std::cos(2.0 * juce::MathConstants<double>::pi
                                                 * static_cast<double>(i)
                                                 / static_cast<double>(n));
        const double v = static_cast<double>(x[i]) * hann;
        const double ph = w * static_cast<double>(i);
        re += v * std::cos(ph);
        im -= v * std::sin(ph);
    }
    return std::sqrt(re * re + im * im) / static_cast<double>(n);
}

// ─── Test 1: parameter contract (§2 id table) ────────────────────────────────

struct ParamSpec { const char* id; float min; float max; float def; };

// The §2 table verbatim. NOTE: the handoff's prose says "24 APVTS parameters
// total" but the table itself enumerates 23 ids — the table is the contract
// (it is what the UI writes), so 23 it is.
const ParamSpec kSpecs[] = {
    {"mode",        0.0f,    2.0f,      0.0f   },
    {"f_mix",       0.0f,    100.0f,    75.0f  },
    {"f_rate",      0.05f,   10.0f,     0.5f   },
    {"f_depth",     0.0f,    100.0f,    70.0f  },
    {"f_feedback",  -95.0f,  95.0f,     40.0f  },
    {"f_delay_min", 0.1f,    20.0f,     1.0f   },
    {"f_delay_max", 0.1f,    20.0f,     5.0f   },
    {"f_sync",      0.0f,    1.0f,      0.0f   },
    {"f_sync_div",  0.0f,    5.0f,      2.0f   },
    {"f_sync_feel", 0.0f,    2.0f,      0.0f   },
    {"p_mix",       0.0f,    100.0f,    75.0f  },
    {"p_rate",      0.05f,   10.0f,     0.35f  },
    {"p_depth",     0.0f,    100.0f,    80.0f  },
    {"p_feedback",  -95.0f,  95.0f,     40.0f  },
    {"p_stages",    1.0f,    6.0f,      6.0f   },
    {"p_freq_min",  20.0f,   2000.0f,   100.0f },
    {"p_freq_max",  200.0f,  16000.0f,  4000.0f},
    {"p_sync",      0.0f,    1.0f,      0.0f   },
    {"p_sync_div",  0.0f,    5.0f,      2.0f   },
    {"p_sync_feel", 0.0f,    2.0f,      0.0f   },
    {"global_mix",  0.0f,    100.0f,    50.0f  },
    {"lfo_shape",   0.0f,    4.0f,      0.0f   },
    {"chaos",       0.0f,    100.0f,    0.0f   },
};
constexpr int kNumSpecs = static_cast<int>(sizeof(kSpecs) / sizeof(kSpecs[0]));

void testParamContract()
{
    std::cout << "[1] parameter contract (" << kNumSpecs << " ids)\n";

    PhanjerEffect fx;

    CHECK(static_cast<int>(fx.getParameters().size()) == kNumSpecs,
          "parameter count is " << fx.getParameters().size()
          << ", expected " << kNumSpecs << " (no hidden params — DO NOT #1)");

    for (const auto& spec : kSpecs)
    {
        auto* p = findParam(fx, spec.id);
        CHECK(p != nullptr, "missing parameter id '" << spec.id << "'");
        if (!p) continue;

        const auto& range = p->getNormalisableRange();
        CHECK(std::abs(range.start - spec.min) < 1.0e-4f,
              spec.id << " min = " << range.start << ", expected " << spec.min);
        CHECK(std::abs(range.end - spec.max) < 1.0e-4f,
              spec.id << " max = " << range.end << ", expected " << spec.max);

        const float def = p->convertFrom0to1(p->getDefaultValue());
        CHECK(std::abs(def - spec.def) < 1.0e-3f * std::max(1.0f, std::abs(spec.def)),
              spec.id << " default = " << def << ", expected " << spec.def);

        // set/get round-trip at a legal, in-range value (snapped for the
        // interval-quantised discrete params).
        const float probe    = range.snapToLegalValue(spec.min + 0.25f * (spec.max - spec.min));
        const bool  accepted = fx.setParameterValue(spec.id, probe);
        CHECK(accepted, spec.id << " setParameterValue rejected");
        const float got = fx.getParameterValue(spec.id);
        CHECK(std::abs(got - probe) < 1.0e-3f * std::max(1.0f, std::abs(probe)),
              spec.id << " round-trip: set " << probe << ", got " << got);
    }
}

// ─── Test 2: state round-trip ────────────────────────────────────────────────

void testStateRoundTrip()
{
    std::cout << "[2] state round-trip\n";

    PhanjerEffect fx;

    // Mutate every id away from its default.
    struct Mutation { const char* id; float value; };
    const Mutation kMutations[] = {
        {"mode", 2.0f}, {"f_mix", 33.0f}, {"f_rate", 3.25f}, {"f_depth", 12.0f},
        {"f_feedback", -71.0f}, {"f_delay_min", 0.4f}, {"f_delay_max", 17.5f},
        {"f_sync", 1.0f}, {"f_sync_div", 5.0f}, {"f_sync_feel", 2.0f},
        {"p_mix", 21.0f}, {"p_rate", 7.5f}, {"p_depth", 44.0f},
        {"p_feedback", 88.0f}, {"p_stages", 3.0f}, {"p_freq_min", 275.0f},
        {"p_freq_max", 9000.0f}, {"p_sync", 1.0f}, {"p_sync_div", 1.0f},
        {"p_sync_feel", 1.0f}, {"global_mix", 91.0f}, {"lfo_shape", 4.0f},
        {"chaos", 66.0f},
    };
    static_assert(sizeof(kMutations) / sizeof(kMutations[0]) == kNumSpecs,
                  "state round-trip must touch every parameter");

    for (const auto& m : kMutations)
        fx.setParameterValue(m.id, m.value);

    juce::MemoryBlock saved;
    fx.getStateInformation(saved);
    CHECK(saved.getSize() > 0, "getStateInformation produced an empty block");

    // Stomp everything back to something else.
    for (const auto& spec : kSpecs)
        fx.setParameterValue(spec.id, spec.min);

    fx.setStateInformation(saved.getData(), static_cast<int>(saved.getSize()));

    for (const auto& m : kMutations)
    {
        const float got = fx.getParameterValue(m.id);
        CHECK(std::abs(got - m.value) < 1.0e-3f * std::max(1.0f, std::abs(m.value)),
              m.id << " not restored: expected " << m.value << ", got " << got);
    }
}

// ─── Test 3: silence in → silence out ────────────────────────────────────────

void testSilence()
{
    std::cout << "[3] silence in / silence out (3 modes x 5 shapes, 2 s each)\n";

    const char* modeNames[]  = {"LINKED", "SMART", "WILD"};
    const char* shapeNames[] = {"Sine", "Triangle", "Saw", "Square", "Random"};

    for (int mode = 0; mode < PhanjerEffect::kNumModes; ++mode)
    {
        for (int shape = 0; shape < PhanjerEffect::kNumShapes; ++shape)
        {
            PhanjerEffect fx;
            fx.setParameterValue("mode",       static_cast<float>(mode));
            fx.setParameterValue("lfo_shape",  static_cast<float>(shape));
            fx.setParameterValue("chaos",      100.0f);      // exercised on Random
            fx.setParameterValue("f_mix",      100.0f);
            fx.setParameterValue("p_mix",      100.0f);
            fx.setParameterValue("global_mix", 100.0f);
            fx.setParameterValue("f_feedback", 95.0f);
            fx.setParameterValue("p_feedback", 95.0f);
            fx.prepareToPlay(kSR, kBS);

            juce::AudioBuffer<float> buf(2, kBS);
            juce::MidiBuffer midi;

            const int blocks = static_cast<int>(2.0 * kSR / kBS);
            float worst = 0.0f;
            for (int b = 0; b < blocks; ++b)
            {
                buf.clear();
                fx.processBlock(buf, midi);
                worst = std::max(worst, bufferMaxAbs(buf));
            }

            CHECK(worst == 0.0f,
                  "silence broke in mode " << modeNames[mode]
                  << " / shape " << shapeNames[shape] << " (peak " << worst << ")");
        }
    }
}

// ─── Test 4: fuzz — extreme param jumps at the 192 kHz worst case ────────────

void testFuzz()
{
    std::cout << "[4] fuzz: random extreme param jumps, 192 kHz, dMax 20 ms, depth 100\n";

    constexpr double sr = 192000.0;
    constexpr int    bs = 512;
    constexpr int    blocks = 400;
    constexpr float  inputAmp = 0.25f;

    PhanjerEffect fx;
    fx.prepareToPlay(sr, bs);

    juce::AudioBuffer<float> buf(2, bs);
    juce::MidiBuffer midi;
    Rng noise(0xC0FFEEu);
    Rng jitter(0x5EED1234u);

    bool   allFinite = true;
    float  worst     = 0.0f;

    for (int b = 0; b < blocks; ++b)
    {
        // Jump every parameter to a random legal value, every block.
        for (const auto& spec : kSpecs)
        {
            auto* p = findParam(fx, spec.id);
            if (!p) continue;
            const float v = p->getNormalisableRange().snapToLegalValue(
                spec.min + jitter.next01() * (spec.max - spec.min));
            fx.setParameterValue(spec.id, v);
        }
        // ...then force the delay-line worst case on top of the random draw.
        fx.setParameterValue("f_delay_min", 0.1f);
        fx.setParameterValue("f_delay_max", 20.0f);
        fx.setParameterValue("f_depth",     100.0f);
        fx.setParameterValue("p_depth",     100.0f);

        for (int s = 0; s < bs; ++s)
        {
            const float v = inputAmp * noise.bipolar();
            buf.setSample(0, s, v);
            buf.setSample(1, s, inputAmp * noise.bipolar());
        }

        fx.processBlock(buf, midi);

        allFinite = allFinite && bufferIsFinite(buf);
        worst = std::max(worst, bufferMaxAbs(buf));
        if (!allFinite) break;
    }

    std::cout << "    worst |out| = " << worst << " (input amp " << inputAmp << ")\n";
    CHECK(allFinite, "fuzz produced a non-finite sample");
    CHECK(worst < 4.0f, "fuzz output exceeded the |out| < 4 bound (" << worst << ")");
}

// ─── Test 5: the money test — SMART levels a collision, WILD does not ────────
//
// Both sweeps are parked (depth 0), so each engine sits at the geometric centre
// of its range and the collision is static and exactly computable:
//
//   phaser, 2 stages, 100 Hz .. 4000 Hz
//     c        = sqrt(100 * 4000)                = 632.4555 Hz
//     f_0, f_1 = c * exp(-+0.25 * ln(4000/c))
//     PP       = { sqrt(f_0 * f_1) }             = c exactly
//
//   flanger, delay bounds 1.0 ms .. 2.5 ms, parked at sqrt(1.0 * 2.5)
//     dF       = 1.5811 ms  ⇒  FP[0] = 1/dF     = 632.4555 Hz
//
// so the first flanger comb peak lands on the phaser's feedback peak: C = 1,
// L = 0.5 (−6 dB). WILD runs the same comb with the guard off.

constexpr float kCollisionDelayMinMs = 1.0f;
constexpr float kCollisionDelayMaxMs = 2.5f;
constexpr float kCollisionFreqMin    = 100.0f;
constexpr float kCollisionFreqMax    = 4000.0f;

void configureCollisionCase(PhanjerEffect& fx, int mode)
{
    fx.setParameterValue("mode",        static_cast<float>(mode));
    fx.setParameterValue("lfo_shape",   static_cast<float>(PhanjerEffect::kSine));
    fx.setParameterValue("chaos",       0.0f);
    fx.setParameterValue("f_mix",       100.0f);
    fx.setParameterValue("f_rate",      0.5f);
    fx.setParameterValue("f_depth",     0.0f);     // park the sweep
    fx.setParameterValue("f_feedback",  40.0f);    // positive → no role swap
    fx.setParameterValue("f_delay_min", kCollisionDelayMinMs);
    fx.setParameterValue("f_delay_max", kCollisionDelayMaxMs);
    fx.setParameterValue("p_mix",       100.0f);
    fx.setParameterValue("p_rate",      0.35f);
    fx.setParameterValue("p_depth",     0.0f);     // park the sweep
    fx.setParameterValue("p_feedback",  40.0f);
    fx.setParameterValue("p_stages",    2.0f);     // PP = { geometric centre }
    fx.setParameterValue("p_freq_min",  kCollisionFreqMin);
    fx.setParameterValue("p_freq_max",  kCollisionFreqMax);
    fx.setParameterValue("global_mix",  100.0f);
}

// Runs the collision case and returns the magnitude response at `probeHz`.
// `meterOut` receives the final leveling gain (meter slot 2).
double runCollisionCase(int mode, double probeHz, float& meterOut,
                        float delayMinMs = kCollisionDelayMinMs,
                        float delayMaxMs = kCollisionDelayMaxMs)
{
    constexpr int   warmupBlocks   = 128;    // > 1 s: 50 ms delay glide + 60 ms release
    constexpr int   analysisBlocks = 64;     // 32768 samples
    constexpr float amp            = 0.05f;  // low enough that WILD's tanh stays ~linear

    PhanjerEffect fx;
    configureCollisionCase(fx, mode);
    fx.setParameterValue("f_delay_min", delayMinMs);
    fx.setParameterValue("f_delay_max", delayMaxMs);
    fx.prepareToPlay(kSR, kBS);

    juce::AudioBuffer<float> buf(2, kBS);
    juce::MidiBuffer midi;
    Rng noise(0xABCD01u);   // identical realisation for every mode

    std::vector<float> in, out;
    in.reserve(static_cast<size_t>(analysisBlocks * kBS));
    out.reserve(static_cast<size_t>(analysisBlocks * kBS));

    for (int b = 0; b < warmupBlocks + analysisBlocks; ++b)
    {
        for (int s = 0; s < kBS; ++s)
        {
            const float v = amp * noise.bipolar();
            buf.setSample(0, s, v);
            buf.setSample(1, s, v);
            if (b >= warmupBlocks) in.push_back(v);
        }

        fx.processBlock(buf, midi);

        if (b >= warmupBlocks)
        {
            const float* p = buf.getReadPointer(0);
            for (int s = 0; s < kBS; ++s) out.push_back(p[s]);
        }
    }

    meterOut = fx.readMeterValue(2);

    const double magIn  = magnitudeAt(in,  probeHz, kSR);
    const double magOut = magnitudeAt(out, probeHz, kSR);
    return magIn > 1.0e-12 ? magOut / magIn : 0.0;
}

void testLeveling()
{
    std::cout << "[5] collision leveling (the money test)\n";

    // Derive the collision frequency from the §5 formulas, not from a literal.
    float stageF[PhanjerEffect::kMaxStages] = {};
    PhanjerEffect::computeStageFreqs(0.0f, kCollisionFreqMin, kCollisionFreqMax,
                                     2, static_cast<float>(kSR), stageF);
    const float phaserPeakHz = std::sqrt(stageF[0] * stageF[1]);

    const float parkedDelayMs = PhanjerEffect::computeDelayMs(
        0.5f, kCollisionDelayMinMs, kCollisionDelayMaxMs);
    const float flangerPeakHz = 1.0f / (parkedDelayMs * 0.001f);

    std::cout << "    phaser stages   = " << stageF[0] << " Hz, " << stageF[1] << " Hz\n";
    std::cout << "    phaser fb peak  = " << phaserPeakHz << " Hz\n";
    std::cout << "    flanger delay   = " << parkedDelayMs << " ms -> peak "
              << flangerPeakHz << " Hz\n";

    CHECK(std::abs(std::log2(flangerPeakHz / phaserPeakHz)) < 0.01f,
          "test setup is wrong: flanger peak " << flangerPeakHz
          << " Hz does not coincide with phaser peak " << phaserPeakHz << " Hz");

    const double probeHz = 0.5 * (static_cast<double>(phaserPeakHz)
                                + static_cast<double>(flangerPeakHz));

    float meterSmart = 0.0f, meterWild = 0.0f, meterLinked = 0.0f;
    const double gainSmart  = runCollisionCase(PhanjerEffect::kSmart,  probeHz, meterSmart);
    const double gainWild   = runCollisionCase(PhanjerEffect::kWild,   probeHz, meterWild);
    const double gainLinked = runCollisionCase(PhanjerEffect::kLinked, probeHz, meterLinked);

    const double dbSmart  = 20.0 * std::log10(std::max(gainSmart,  1.0e-12));
    const double dbWild   = 20.0 * std::log10(std::max(gainWild,   1.0e-12));
    const double dbLinked = 20.0 * std::log10(std::max(gainLinked, 1.0e-12));

    std::cout << "    |H(" << probeHz << " Hz)|  SMART = " << dbSmart << " dB"
              << "  WILD = " << dbWild << " dB"
              << "  LINKED = " << dbLinked << " dB\n";
    std::cout << "    leveling gain (meter slot 2)  SMART = " << meterSmart
              << "  WILD = " << meterWild << "  LINKED = " << meterLinked << "\n";

    CHECK(dbSmart < dbWild - 3.0,
          "SMART must be >= 3 dB below WILD at the collision frequency (SMART "
          << dbSmart << " dB, WILD " << dbWild << " dB)");
    CHECK(dbLinked < dbWild - 3.0,
          "LINKED must also be >= 3 dB below WILD at the collision frequency");

    // The guard must actually be what is doing the work, not just the absence
    // of WILD's saturator: slot 2 should be sitting at the -6 dB floor.
    CHECK(meterSmart < 0.55f && meterSmart > 0.45f,
          "SMART leveling gain should have settled near 0.5, got " << meterSmart);
    CHECK(meterWild == 1.0f,
          "WILD must report a leveling gain of exactly 1 (guard off), got " << meterWild);

    // Control: move the flanger comb to a spacing that is non-harmonically
    // related to the phaser features (parked dF = 0.690 ms → 1449 Hz spacing;
    // nearest peak-peak pair 1.20 octaves apart, nearest notch-notch pair 0.47
    // octaves — both well outside the ⅓-octave guard band). The guard must let
    // go entirely.
    float meterClear = 0.0f;
    (void) runCollisionCase(PhanjerEffect::kSmart, probeHz, meterClear, 0.4f, 1.19f);
    std::cout << "    detuned (non-harmonic comb) leveling gain = " << meterClear << "\n";
    CHECK(meterClear > 0.99f,
          "with no collision the guard must be fully open, got " << meterClear);
}

// ─── Test 6: resolveRateHz table ─────────────────────────────────────────────

void testResolveRateHz()
{
    std::cout << "[6] resolveRateHz table @ 140 BPM\n";

    // Sync off → the raw rate passes through untouched, whatever div/feel say.
    CHECK(PhanjerEffect::resolveRateHz(0.5f, false, 0, 0, 140.0) == 0.5f,
          "sync off must return the raw rate");
    CHECK(PhanjerEffect::resolveRateHz(7.25f, false, 5, 2, 140.0) == 7.25f,
          "sync off must ignore div/feel");

    // One LFO cycle per note value: rate = (bpm/60) / beatsPerCycle,
    // beatsPerCycle = (4/denominator) * feelLength.
    const double beat = 140.0 / 60.0;   // 2.3333 Hz
    struct Case { int div; int feel; double expected; const char* label; };
    const Case kCases[] = {
        {0, PhanjerEffect::kStraight, beat / 4.0,          "1/1 straight"},
        {1, PhanjerEffect::kStraight, beat / 2.0,          "1/2 straight"},
        {2, PhanjerEffect::kStraight, beat,                "1/4 straight"},
        {3, PhanjerEffect::kStraight, beat * 2.0,          "1/8 straight"},
        {4, PhanjerEffect::kStraight, beat * 4.0,          "1/16 straight"},
        {5, PhanjerEffect::kStraight, beat * 8.0,          "1/32 straight"},
        {2, PhanjerEffect::kTriplet,  beat * 1.5,          "1/4 triplet"},
        {2, PhanjerEffect::kDotted,   beat * (2.0 / 3.0),  "1/4 dotted"},
        {3, PhanjerEffect::kTriplet,  beat * 3.0,          "1/8 triplet"},
        {0, PhanjerEffect::kDotted,   beat / 6.0,          "1/1 dotted"},
    };

    for (const auto& c : kCases)
    {
        const float got = PhanjerEffect::resolveRateHz(0.5f, true, c.div, c.feel, 140.0);
        std::cout << "    " << c.label << " = " << got << " Hz\n";
        CHECK(std::abs(got - static_cast<float>(c.expected)) < 1.0e-3f,
              c.label << ": got " << got << " Hz, expected " << c.expected << " Hz");
    }

    // Out-of-range indices must clamp to the ends of their tables, not read
    // out of bounds: div -3 → 1/1, feel 9 → Dotted.
    CHECK(PhanjerEffect::resolveRateHz(0.5f, true, -3, 9, 140.0)
              == PhanjerEffect::resolveRateHz(0.5f, true, 0, PhanjerEffect::kDotted, 140.0),
          "div/feel indices must clamp to the top/bottom of their tables");
    CHECK(PhanjerEffect::resolveRateHz(0.5f, true, 99, -1, 140.0)
              == PhanjerEffect::resolveRateHz(0.5f, true, 5, PhanjerEffect::kStraight, 140.0),
          "div/feel indices must clamp to the top/bottom of their tables");
}

// ─── Bonus: the pure collision metric ────────────────────────────────────────

void testCollisionMetric()
{
    std::cout << "[+] computeCollisionMetric\n";

    float stageF[PhanjerEffect::kMaxStages] = {};
    PhanjerEffect::computeStageFreqs(0.0f, kCollisionFreqMin, kCollisionFreqMax,
                                     2, static_cast<float>(kSR), stageF);
    const float centre = std::sqrt(stageF[0] * stageF[1]);

    // Exact coincidence: first comb peak on the phaser feedback peak.
    const float dSec = 1.0f / centre;
    const float exact = PhanjerEffect::computeCollisionMetric(dSec, false, stageF, 2, false);
    std::cout << "    C(exact coincidence) = " << exact << "\n";
    CHECK(exact > 0.99f, "exact coincidence must give C = 1, got " << exact);

    // Detuned by a full octave — well outside the ⅓-octave guard band.
    const float dOct = 1.0f / (centre * 2.0f);
    const float far = PhanjerEffect::computeCollisionMetric(dOct, false, stageF, 2, false);
    std::cout << "    C(1 octave away)     = " << far << "\n";
    CHECK(far < 1.0e-4f, "an octave of separation must give C = 0, got " << far);

    // Negative flanger feedback swaps FP <-> FN, so the same delay that was an
    // exact peak-peak hit becomes a half-spacing miss.
    const float swapped = PhanjerEffect::computeCollisionMetric(dSec, true, stageF, 2, false);
    std::cout << "    C(same delay, negative flanger feedback) = " << swapped << "\n";
    CHECK(swapped < exact,
          "negative feedback must change the pairing (got " << swapped
          << " vs " << exact << ")");

    // An empty phaser set cannot collide.
    CHECK(PhanjerEffect::computeCollisionMetric(dSec, false, stageF, 0, false) == 0.0f,
          "zero stages must give C = 0");

    // A single stage has notches but no feedback peak; the notch-notch class
    // still has to work.
    float one[PhanjerEffect::kMaxStages] = {};
    PhanjerEffect::computeStageFreqs(0.0f, kCollisionFreqMin, kCollisionFreqMax,
                                     1, static_cast<float>(kSR), one);
    const float notchHit = PhanjerEffect::computeCollisionMetric(
        0.5f / one[0], false, one, 1, false);   // first notch (0.5/dF) on the stage freq
    std::cout << "    C(notch-notch, 1 stage) = " << notchHit << "\n";
    CHECK(notchHit > 0.99f, "a notch-notch coincidence must give C = 1, got " << notchHit);
}

}  // namespace

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "=== test_phanjer ===\n";

    testParamContract();
    testStateRoundTrip();
    testSilence();
    testFuzz();
    testLeveling();
    testResolveRateHz();
    testCollisionMetric();

    std::cout << "\n" << g_passed << " checks passed, " << g_failed << " failed\n";

    if (g_failed > 0)
    {
        std::cerr << "TESTS FAILED\n";
        return 1;
    }

    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
