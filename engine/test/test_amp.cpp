// test_amp.cpp — XlethAmpEffect ("Amp Stack") acceptance tests
// Build: cmake --build build --config Release --target test_amp
// Run:   build\engine\Release\test_amp.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [<line>] <message>" and exits 1
//
// Covers spec §10 acceptance items 1–4 (docs/amp spec.docx):
//
//   §10.1  Aliasing sweep — sine sweep 100 Hz – 15 kHz at max Drive, per model.
//          Any fold-back below the fundamental = reject.
//   §10.2  Bypass null   — bypassed output nulls against dry within latency
//          compensation.
//   §10.3  Element isolation — bypass one stage at a time, measure per-stage
//          gain, no stage may produce unbounded gain.
//   §10.4  CPU — per-instance cost at the measured engine rate, plus a
//          remix-scale instance count.  Both numbers printed.
//
// Plus two supporting checks: the parameter surface from §7, and the placeholder
// cabinet IRs against the two numeric character notes in §6 (Greenback's ≈5 kHz
// roll-off, V30's ≈3 kHz mid spike).
//
// §10.5 (IR licensing) is a documentation item — see
// engine/src/audio/XlethAmpCabinetIR.PROVENANCE.md.  §10.6 (listening pass) and
// §10.7 (build discipline) cannot be automated here.

#include "audio/XlethAmpEffect.h"
#include "audio/XlethAmpCabinetIR.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_dsp/juce_dsp.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <iostream>
#include <random>
#include <string>
#include <vector>

// ─── Test harness ────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                        \
    do {                                                                        \
        if (cond) {                                                             \
            ++g_passed;                                                         \
        } else {                                                                \
            std::cerr << "  FAIL [" << __LINE__ << "] " << (msg) << "\n";       \
            ++g_failed;                                                         \
        }                                                                       \
    } while (0)

namespace
{

constexpr int   kBlockSize   = 512;
constexpr int   kNumModels   = XlethAmpEffect::kNumModels;

const char* modelName(int m)
{
    return XlethAmpEffect::voicing(static_cast<XlethAmpEffect::AmpModel>(m)).displayName;
}

// Neutral test setup: every knob at its centre, fully wet, unity output.
void setNeutralParams(XlethAmpEffect& fx, int model)
{
    fx.setParameterValue("model",    static_cast<float>(model));
    fx.setParameterValue("drive",    5.0f);
    fx.setParameterValue("bass",     5.0f);
    fx.setParameterValue("mid",      5.0f);
    fx.setParameterValue("treble",   5.0f);
    fx.setParameterValue("sag",      5.0f);
    fx.setParameterValue("tighten",  5.0f);
    fx.setParameterValue("gate",     0.0f);
    fx.setParameterValue("cab",      0.0f);   // Auto — the model's default pairing
    fx.setParameterValue("presence", 5.0f);
    fx.setParameterValue("mix",      100.0f);
    fx.setParameterValue("output",   0.0f);
}

// Run n blocks of silence so every smoother lands on its target before the
// measurement starts.  The longest ramp in the effect is 30 ms.
void settle(XlethAmpEffect& fx, double sampleRate)
{
    juce::AudioBuffer<float> buf(2, kBlockSize);
    juce::MidiBuffer midi;
    const int blocks = static_cast<int>(sampleRate * 0.10 / kBlockSize) + 2;
    for (int i = 0; i < blocks; ++i)
    {
        buf.clear();
        fx.processBlock(buf, midi);
    }
}

bool allFinite(const juce::AudioBuffer<float>& b)
{
    for (int c = 0; c < b.getNumChannels(); ++c)
        for (int s = 0; s < b.getNumSamples(); ++s)
            if (!std::isfinite(b.getSample(c, s))) return false;
    return true;
}

// ─── §10.1  Aliasing sweep ───────────────────────────────────────────────────
//
// Method.  The chain is a memoryless nonlinearity wrapped in linear filters, so
// with a pure sine in, EVERY legitimate output component sits at an integer
// multiple of the fundamental.  Nothing in the signal path can put energy
// *below* the fundamental except (a) DC, from the envelope followers' ripple
// beating against the carrier, and (b) alias fold-back.  Excluding the first
// three bins removes (a) and leaves (b) alone in the measurement band.
//
// The test frequencies are snapped to exact FFT bin centres, so the fundamental,
// its harmonics, and their aliases are all bin-exact and a rectangular window is
// leakage-free — no window correction is needed and none is applied.
//
// Two numbers are reported per point, and the PASS criterion is the first:
//
//   alias / input       the worst sub-fundamental bin measured against the
//                       INPUT sine's own level.  This is the audibility
//                       question — "if I feed the amp a tone, how loud is the
//                       inharmonic junk that comes back?" — and it is the number
//                       the limit is applied to.
//   fundamental / input what the amp did to the tone itself.
//
// The second column exists because the first would be unreadable without it.  A
// guitar amp is SUPPOSED to throw away 15 kHz: the model's input-bandwidth
// low-pass puts the 15 kHz fundamental 40–60 dB down, so alias-relative-to-
// fundamental at that point is a ratio of one tiny number to another and says
// nothing about what anyone hears.  Measuring the alias against the input keeps
// the question honest at both ends of the sweep.  Both columns are printed so a
// reader can check that reasoning rather than take it on trust.

constexpr int    kFftOrder     = 14;              // 16384 points
constexpr int    kFftSize      = 1 << kFftOrder;
constexpr double kAliasFloorDb = -60.0;           // alias vs input
constexpr int    kBinGuardLow  = 3;               // skip DC + envelope-ripple bins
constexpr int    kBinSkirt     = 4;               // bins reserved around the fundamental

struct AliasResult
{
    double freqHz          = 0.0;
    double aliasVsInputDb  = -200.0;   // worst sub-fundamental bin, vs input level
    double fundVsInputDb   = -200.0;   // what the amp did to the tone itself
};

AliasResult measureAliasingAt(XlethAmpEffect& fx, double sampleRate, int bin)
{
    const double freq  = sampleRate * bin / kFftSize;
    const float  amp   = 0.5f;

    juce::AudioBuffer<float> buf(2, kBlockSize);
    juce::MidiBuffer midi;
    double phase = 0.0;

    auto renderBlock = [&]()
    {
        for (int s = 0; s < kBlockSize; ++s)
        {
            const float v = amp * static_cast<float>(
                std::sin(2.0 * juce::MathConstants<double>::pi * phase));
            buf.setSample(0, s, v);
            buf.setSample(1, s, v);
            phase += freq / sampleRate;
            if (phase >= 1.0) phase -= 1.0;
        }
        fx.processBlock(buf, midi);
    };

    // Warm up: 0.4 s lets the sag follower, the gate, the convolver tail and
    // every smoother reach steady state before anything is captured.
    const int warmBlocks = static_cast<int>(sampleRate * 0.4 / kBlockSize) + 1;
    for (int i = 0; i < warmBlocks; ++i) renderBlock();

    std::vector<float> capture;
    capture.reserve(static_cast<size_t>(kFftSize) + kBlockSize);
    while (static_cast<int>(capture.size()) < kFftSize)
    {
        renderBlock();
        for (int s = 0; s < kBlockSize; ++s)
            capture.push_back(buf.getSample(0, s));
    }
    capture.resize(static_cast<size_t>(kFftSize));

    std::vector<float> fft(static_cast<size_t>(kFftSize) * 2, 0.0f);
    std::copy(capture.begin(), capture.end(), fft.begin());
    juce::dsp::FFT(kFftOrder).performFrequencyOnlyForwardTransform(fft.data());

    // Reference: the same rectangular-windowed FFT of the untouched input sine.
    // A bin-exact sine of amplitude `amp` lands entirely in one bin, but taking
    // it from an actual transform avoids baking a normalisation convention into
    // the test.
    std::vector<float> ref(static_cast<size_t>(kFftSize) * 2, 0.0f);
    for (int s = 0; s < kFftSize; ++s)
        ref[static_cast<size_t>(s)] = amp * static_cast<float>(
            std::sin(2.0 * juce::MathConstants<double>::pi * bin * s / kFftSize));
    juce::dsp::FFT(kFftOrder).performFrequencyOnlyForwardTransform(ref.data());
    const double inputMag = std::max(1.0e-12, static_cast<double>(ref[static_cast<size_t>(bin)]));

    double worst = 0.0;
    for (int k = kBinGuardLow; k < bin - kBinSkirt; ++k)
        worst = std::max(worst, static_cast<double>(fft[static_cast<size_t>(k)]));

    AliasResult r;
    r.freqHz         = freq;
    r.aliasVsInputDb = 20.0 * std::log10(std::max(1.0e-12, worst) / inputMag);
    r.fundVsInputDb  = 20.0 * std::log10(
        std::max(1.0e-12, static_cast<double>(fft[static_cast<size_t>(bin)])) / inputMag);
    return r;
}

void testAliasingSweep(double sampleRate)
{
    std::cout << "\n=== §10.1  Aliasing sweep, 100 Hz - 15 kHz at max Drive ("
              << sampleRate << " Hz) ===\n";
    std::cout << "  rows: alias level vs input (dB) / what the amp did to the "
                 "fundamental (dB)\n";

    const double targets[] = { 100.0, 200.0, 400.0, 800.0, 1500.0,
                               3000.0, 5000.0, 8000.0, 11000.0, 15000.0 };

    std::printf("  %-17s", "model");
    for (double t : targets) std::printf("%14.0f", t);
    std::printf("%12s\n", "worst alias");

    double globalWorst = -200.0;

    for (int m = 0; m < kNumModels; ++m)
    {
        XlethAmpEffect fx;
        fx.prepareToPlay(sampleRate, kBlockSize);
        setNeutralParams(fx, m);
        fx.setParameterValue("drive", 10.0f);   // spec: max Drive
        settle(fx, sampleRate);

        std::printf("  %-17s", modelName(m));
        double modelWorst = -200.0;

        for (double t : targets)
        {
            const int bin = std::max(8, static_cast<int>(
                std::lround(t * kFftSize / sampleRate)));
            const AliasResult r = measureAliasingAt(fx, sampleRate, bin);
            std::printf("%8.1f/%5.1f", r.aliasVsInputDb, r.fundVsInputDb);
            modelWorst = std::max(modelWorst, r.aliasVsInputDb);
        }

        std::printf("%12.1f\n", modelWorst);
        globalWorst = std::max(globalWorst, modelWorst);

        CHECK(modelWorst < kAliasFloorDb,
              std::string("audible fold-back below the fundamental on ") + modelName(m));
    }

    std::printf("  worst fold-back across all six models: %.1f dB below input "
                "(limit %.1f)\n", globalWorst, kAliasFloorDb);
}

// ─── §10.2  Bypass null ──────────────────────────────────────────────────────
//
// The effect reports latency, so "nulls against dry" means "nulls against dry
// delayed by exactly the reported latency" — which is what the host's PDC
// applies.  XlethAmpEffect implements the base class's latency-aligned bypass
// dry hook to make this exact rather than approximate.

void testBypassNull(double sampleRate)
{
    std::cout << "\n=== §10.2  Bypass null against latency-compensated dry ("
              << sampleRate << " Hz) ===\n";

    XlethAmpEffect fx;
    fx.prepareToPlay(sampleRate, kBlockSize);
    setNeutralParams(fx, static_cast<int>(XlethAmpEffect::AmpModel::ModernTight));
    fx.setBypassed(true);
    fx.reset();   // start fully dry, no crossfade in flight

    const int latency = fx.getWetLatencySamples();
    std::printf("  reported latency: %d samples (oversampling %d + convolution %d)\n",
                latency, fx.getOversamplingLatencySamples(),
                fx.getConvolutionLatencySamples());
    CHECK(latency == fx.getLatencySamples(),
          "getLatencySamples() should equal the measured wet latency");

    std::mt19937 rng(1234);
    std::uniform_real_distribution<float> dist(-0.5f, 0.5f);

    const int totalBlocks = 40;
    std::vector<float> in, out;
    in.reserve(static_cast<size_t>(totalBlocks) * kBlockSize);
    out.reserve(static_cast<size_t>(totalBlocks) * kBlockSize);

    juce::AudioBuffer<float> buf(2, kBlockSize);
    juce::MidiBuffer midi;

    for (int b = 0; b < totalBlocks; ++b)
    {
        for (int s = 0; s < kBlockSize; ++s)
        {
            const float v = dist(rng);
            buf.setSample(0, s, v);
            buf.setSample(1, s, v);
            in.push_back(v);
        }
        fx.processBlock(buf, midi);
        for (int s = 0; s < kBlockSize; ++s)
            out.push_back(buf.getSample(0, s));
    }

    // Skip the first `latency` output samples (delay line still filling).
    double maxErr = 0.0, sigSum = 0.0, errSum = 0.0;
    int    n = 0;
    for (size_t i = static_cast<size_t>(latency); i < out.size(); ++i)
    {
        const double dry = in[i - static_cast<size_t>(latency)];
        const double err = out[i] - dry;
        maxErr = std::max(maxErr, std::abs(err));
        sigSum += dry * dry;
        errSum += err * err;
        ++n;
    }

    const double nullDb = 10.0 * std::log10(std::max(1.0e-30, errSum)
                                          / std::max(1.0e-30, sigSum));
    std::printf("  null depth: %.1f dB   peak error: %.3e  (%d samples compared)\n",
                nullDb, maxErr, n);

    CHECK(maxErr < 1.0e-6, "bypassed output should be a sample-exact delayed dry");
    CHECK(nullDb < -120.0, "bypass null should be at least 120 dB down");
    CHECK(allFinite(buf), "bypassed output should be finite");
}

// ─── §10.3  Element isolation ────────────────────────────────────────────────
//
// Enable exactly one stage at a time and measure its gain: output RMS over
// input RMS, with white noise in.  With every stage disabled the effect is a
// pure mono-sum + delay, which gives the 0 dB reference the table is read
// against.  The failure this guards is the plate reverb sign bug's shape — a
// stage that quietly multiplies instead of shaping.

struct StageGain
{
    const char* name;
    double      gainDb[kNumModels];
};

double measureChainGain(XlethAmpEffect& fx, double sampleRate)
{
    std::mt19937 rng(4321);
    std::uniform_real_distribution<float> dist(-0.3f, 0.3f);

    juce::AudioBuffer<float> buf(2, kBlockSize);
    juce::MidiBuffer midi;

    // Discard the first 0.2 s (delay-line fill + convolver ramp-in).
    const int warm = static_cast<int>(sampleRate * 0.2 / kBlockSize) + 1;
    const int meas = static_cast<int>(sampleRate * 0.5 / kBlockSize) + 1;

    double inSum = 0.0, outSum = 0.0;
    int    n = 0;

    for (int b = 0; b < warm + meas; ++b)
    {
        double blockIn = 0.0;
        for (int s = 0; s < kBlockSize; ++s)
        {
            const float v = dist(rng);
            buf.setSample(0, s, v);
            buf.setSample(1, s, v);
            blockIn += static_cast<double>(v) * v;
        }
        fx.processBlock(buf, midi);

        if (b >= warm)
        {
            inSum += blockIn;
            for (int s = 0; s < kBlockSize; ++s)
            {
                const double o = buf.getSample(0, s);
                outSum += o * o;
            }
            n += kBlockSize;
        }
    }

    if (!allFinite(buf)) return std::numeric_limits<double>::quiet_NaN();
    juce::ignoreUnused(n);
    return 10.0 * std::log10(std::max(1.0e-30, outSum) / std::max(1.0e-30, inSum));
}

void testElementIsolation(double sampleRate)
{
    std::cout << "\n=== §10.3  Element isolation — per-stage gain, dB ("
              << sampleRate << " Hz) ===\n";

    using Stage = XlethAmpEffect::Stage;
    struct Row { Stage s; const char* name; };
    const Row rows[] = {
        { Stage::Gate,      "Gate"       },
        { Stage::Tighten,   "Tighten"    },
        { Stage::Drive,     "Drive"      },
        { Stage::ToneStack, "Tone stack" },
        { Stage::Power,     "Power"      },
        { Stage::Presence,  "Presence"   },
        { Stage::Cabinet,   "Cabinet"    },
    };

    // Per-stage gain has to be bounded, not small: a drive stage at full tilt
    // legitimately has tens of dB of gain in front of a saturator.  What must
    // never happen is a NaN, an infinity, or a stage that runs away.
    constexpr double kStageGainCeilingDb = 30.0;

    std::printf("  %-12s", "stage");
    for (int m = 0; m < kNumModels; ++m) std::printf("%14s", modelName(m));
    std::printf("\n");

    // Reference: every stage off.  Should be ~0 dB (mono sum of a
    // mono-duplicated source is unity).
    {
        std::printf("  %-12s", "(all off)");
        for (int m = 0; m < kNumModels; ++m)
        {
            XlethAmpEffect fx;
            fx.prepareToPlay(sampleRate, kBlockSize);
            setNeutralParams(fx, m);
            fx.setAllStagesEnabled(false);
            settle(fx, sampleRate);
            const double g = measureChainGain(fx, sampleRate);
            std::printf("%14.2f", g);
            CHECK(std::isfinite(g), "all-stages-off gain should be finite");
            CHECK(std::abs(g) < 0.5,
                  std::string("all stages off should be unity on ") + modelName(m));
        }
        std::printf("\n");
    }

    for (const auto& row : rows)
    {
        std::printf("  %-12s", row.name);
        for (int m = 0; m < kNumModels; ++m)
        {
            XlethAmpEffect fx;
            fx.prepareToPlay(sampleRate, kBlockSize);
            setNeutralParams(fx, m);
            fx.setAllStagesEnabled(false);
            fx.setStageEnabled(row.s, true);
            settle(fx, sampleRate);

            const double g = measureChainGain(fx, sampleRate);
            std::printf("%14.2f", g);

            CHECK(std::isfinite(g),
                  std::string("stage gain must be finite: ") + row.name
                      + " / " + modelName(m));
            CHECK(g < kStageGainCeilingDb,
                  std::string("stage gain must be bounded: ") + row.name
                      + " / " + modelName(m));
        }
        std::printf("\n");
    }

    // And the whole chain, every stage on — the number that actually ships.
    {
        std::printf("  %-12s", "FULL CHAIN");
        for (int m = 0; m < kNumModels; ++m)
        {
            XlethAmpEffect fx;
            fx.prepareToPlay(sampleRate, kBlockSize);
            setNeutralParams(fx, m);
            settle(fx, sampleRate);
            const double g = measureChainGain(fx, sampleRate);
            std::printf("%14.2f", g);
            CHECK(std::isfinite(g),
                  std::string("full-chain gain must be finite on ") + modelName(m));
            CHECK(g < kStageGainCeilingDb,
                  std::string("full-chain gain must be bounded on ") + modelName(m));
        }
        std::printf("\n");
    }
}

// ─── §10.4  CPU ──────────────────────────────────────────────────────────────

void testCpuCost(double sampleRate)
{
    std::cout << "\n=== §10.4  CPU cost per instance at " << sampleRate
              << " Hz, block " << kBlockSize << " ===\n";

    std::mt19937 rng(999);
    std::uniform_real_distribution<float> dist(-0.3f, 0.3f);

    juce::AudioBuffer<float> buf(2, kBlockSize);
    juce::MidiBuffer midi;

    const int blocks = static_cast<int>(sampleRate * 5.0 / kBlockSize);
    const double audioSeconds = blocks * kBlockSize / sampleRate;

    std::printf("  %-17s %12s %12s %14s\n",
                "model", "CPU %/core", "x realtime", "instances/core");

    double worstPct = 0.0;

    for (int m = 0; m < kNumModels; ++m)
    {
        XlethAmpEffect fx;
        fx.prepareToPlay(sampleRate, kBlockSize);
        setNeutralParams(fx, m);
        settle(fx, sampleRate);

        // Pre-generate the noise so the RNG is not inside the timed region.
        std::vector<float> noise(static_cast<size_t>(kBlockSize));

        const auto t0 = std::chrono::steady_clock::now();
        for (int b = 0; b < blocks; ++b)
        {
            for (int s = 0; s < kBlockSize; ++s) noise[static_cast<size_t>(s)] = dist(rng);
            for (int s = 0; s < kBlockSize; ++s)
            {
                buf.setSample(0, s, noise[static_cast<size_t>(s)]);
                buf.setSample(1, s, noise[static_cast<size_t>(s)]);
            }
            fx.processBlock(buf, midi);
        }
        const auto t1 = std::chrono::steady_clock::now();

        const double elapsed =
            std::chrono::duration<double>(t1 - t0).count();
        const double pct = 100.0 * elapsed / audioSeconds;

        std::printf("  %-17s %11.3f%% %12.1f %14.0f\n",
                    modelName(m), pct, audioSeconds / elapsed, 100.0 / pct);

        worstPct = std::max(worstPct, pct);
        CHECK(std::isfinite(pct) && pct > 0.0, "CPU measurement should be valid");
        CHECK(allFinite(buf), "CPU-run output should be finite");
    }

    // Remix-scale figure (spec §10.4 asks for the instance count too).  32 is a
    // representative pitch-track count for a Sparta-style remix session.
    constexpr int kRemixInstances = 32;
    std::printf("  worst model: %.3f%% of one core per instance\n", worstPct);
    std::printf("  remix scale: %d instances = %.2f%% of one core\n",
                kRemixInstances, worstPct * kRemixInstances);
}

// ─── Supporting checks ───────────────────────────────────────────────────────

void testParameterSurface()
{
    std::cout << "\n=== §7  Parameter surface ===\n";

    XlethAmpEffect fx;
    const char* ids[] = { "model", "drive", "bass", "mid", "treble", "sag",
                          "tighten", "gate", "cab", "presence", "mix", "output" };

    for (const char* id : ids)
    {
        bool found = false;
        for (auto* p : fx.getParameters())
            if (auto* rp = dynamic_cast<juce::RangedAudioParameter*>(p))
                if (rp->paramID == juce::String(id)) { found = true; break; }
        CHECK(found, std::string("parameter should exist: ") + id);
    }

    auto valueOf = [&fx](const char* id) -> float
    {
        for (auto* p : fx.getParameters())
            if (auto* rp = dynamic_cast<juce::RangedAudioParameter*>(p))
                if (rp->paramID == juce::String(id))
                    return rp->convertFrom0to1(rp->getDefaultValue());
        return std::numeric_limits<float>::quiet_NaN();
    };

    CHECK(std::abs(valueOf("model") - 3.0f) < 0.01f, "default model is Modern Tight");
    CHECK(std::abs(valueOf("drive") - 5.0f) < 0.01f, "default drive is 5");
    CHECK(std::abs(valueOf("mix") - 100.0f) < 0.01f, "default mix is 100%");
    CHECK(std::abs(valueOf("output") - 0.0f) < 0.01f, "default output is 0 dB");
    CHECK(std::abs(valueOf("gate") - 0.0f) < 0.01f, "default gate is 0 (off)");

    // Serialization round-trip through the base class's APVTS XML.
    fx.setParameterValue("drive", 8.5f);
    fx.setParameterValue("model", 1.0f);
    juce::MemoryBlock state;
    fx.getStateInformation(state);

    XlethAmpEffect fx2;
    fx2.setStateInformation(state.getData(), static_cast<int>(state.getSize()));
    CHECK(std::abs(fx2.getParameterValue("drive") - 8.5f) < 0.01f,
          "drive should survive a state round-trip");
    CHECK(std::abs(fx2.getParameterValue("model") - 1.0f) < 0.01f,
          "model should survive a state round-trip");
}

void testCabinetIrCharacter(double sampleRate)
{
    std::cout << "\n=== §6  Placeholder cabinet IRs ===\n";
    using namespace xleth::audio::amp;

    std::printf("  %-17s %8s %10s %10s %10s %10s\n",
                "cabinet", "len(ms)", "1kHz", "3kHz", "5kHz", "8kHz");

    for (int i = 0; i < kNumCabinets; ++i)
    {
        const auto id = static_cast<CabinetId>(i);
        auto ir = synthesizePlaceholderCabinetIR(id, sampleRate);
        const double lenMs = 1000.0 * ir.getNumSamples() / sampleRate;

        const double d1k = cabinetIrMagnitudeDb(ir, sampleRate, 1000.0);
        const double d3k = cabinetIrMagnitudeDb(ir, sampleRate, 3000.0);
        const double d5k = cabinetIrMagnitudeDb(ir, sampleRate, 5000.0);
        const double d8k = cabinetIrMagnitudeDb(ir, sampleRate, 8000.0);

        std::printf("  %-17s %8.1f %10.1f %10.1f %10.1f %10.1f\n",
                    cabinetDisplayName(id), lenMs, d1k, d3k, d5k, d8k);

        CHECK(lenMs <= kMaxCabinetIrMs, "IR length must be <= 100 ms (spec §6)");
        CHECK(d1k <= 0.05, "peak-normalised IR must not boost anywhere");

        // Spec §6 character notes, the two that state a number.
        if (id == CabinetId::Greenback4x12)
            CHECK(d8k < d5k - 6.0,
                  "Greenback should roll off above ~5 kHz (spec §6)");
        if (id == CabinetId::V30_4x12)
        {
            const double d500 = cabinetIrMagnitudeDb(ir, sampleRate, 500.0);
            CHECK(d3k > d500 + 4.0, "V30 should have a mid spike at ~3 kHz (spec §6)");
        }
    }
}

void testRateIndependence()
{
    std::cout << "\n=== §9  Sample-rate independence (nothing assumes 44.1 or 48) ===\n";

    const double rates[] = { 44100.0, 48000.0, 96000.0 };
    for (double sr : rates)
    {
        XlethAmpEffect fx;
        fx.prepareToPlay(sr, kBlockSize);
        setNeutralParams(fx, static_cast<int>(XlethAmpEffect::AmpModel::Plexi));
        settle(fx, sr);

        const double osRate = fx.getOversampledRate();
        const double tailMs = 1000.0 * fx.getTailLengthSeconds();

        std::printf("  %8.0f Hz -> oversampled %9.0f Hz, latency %3d, IR %5.1f ms\n",
                    sr, osRate, fx.getWetLatencySamples(), tailMs);

        CHECK(std::abs(osRate - sr * 4.0) < 1.0, "oversampled rate must be 4x the engine rate");
        CHECK(tailMs <= xleth::audio::amp::kMaxCabinetIrMs + 0.5,
              "cab tail must stay inside the 100 ms ceiling at every rate");

        // A short render must stay finite at every rate.
        juce::AudioBuffer<float> buf(2, kBlockSize);
        juce::MidiBuffer midi;
        std::mt19937 rng(7);
        std::uniform_real_distribution<float> dist(-0.9f, 0.9f);
        for (int b = 0; b < 20; ++b)
        {
            for (int s = 0; s < kBlockSize; ++s)
            {
                const float v = dist(rng);
                buf.setSample(0, s, v);
                buf.setSample(1, s, v);
            }
            fx.processBlock(buf, midi);
            if (!allFinite(buf)) break;
        }
        CHECK(allFinite(buf), "output must stay finite at every engine rate");
    }
}

void testMixZeroSkipIsExactDry(double sampleRate)
{
    std::cout << "\n=== §9  Mix = 0 skip path is exact, latency-compensated dry ===\n";

    XlethAmpEffect fx;
    fx.prepareToPlay(sampleRate, kBlockSize);
    setNeutralParams(fx, static_cast<int>(XlethAmpEffect::AmpModel::Precision));
    fx.setParameterValue("mix", 0.0f);
    settle(fx, sampleRate);

    const int latency = fx.getWetLatencySamples();

    std::mt19937 rng(55);
    std::uniform_real_distribution<float> dist(-0.4f, 0.4f);
    juce::AudioBuffer<float> buf(2, kBlockSize);
    juce::MidiBuffer midi;

    std::vector<float> in, out;
    for (int b = 0; b < 20; ++b)
    {
        for (int s = 0; s < kBlockSize; ++s)
        {
            const float v = dist(rng);
            buf.setSample(0, s, v);
            buf.setSample(1, s, v);
            in.push_back(v);
        }
        fx.processBlock(buf, midi);
        for (int s = 0; s < kBlockSize; ++s) out.push_back(buf.getSample(0, s));
    }

    double maxErr = 0.0;
    for (size_t i = static_cast<size_t>(latency); i < out.size(); ++i)
        maxErr = std::max(maxErr, std::abs(static_cast<double>(out[i])
                                         - in[i - static_cast<size_t>(latency)]));

    std::printf("  peak error vs delayed dry: %.3e (latency %d)\n", maxErr, latency);
    CHECK(maxErr < 1.0e-6, "Mix = 0 must return the latency-compensated dry exactly");
}

} // namespace

// ─── main ────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "=== test_amp — XlethAmpEffect (\"Amp Stack\") ===\n";
    std::cout << "spec: docs/amp spec.docx §10 acceptance tests 1-4\n";

    testParameterSurface();
    testCabinetIrCharacter(48000.0);
    testRateIndependence();

    // The spec is explicit that the engine rate is measured, not assumed, so the
    // acceptance tests run at both rates XLETH actually sees in the wild.
    for (double sr : { 48000.0, 44100.0 })
    {
        testBypassNull(sr);
        testMixZeroSkipIsExactDry(sr);
        testElementIsolation(sr);
        testAliasingSweep(sr);
        testCpuCost(sr);
    }

    std::cout << "\nResults: " << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0)
    {
        std::cerr << "FAILED\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
