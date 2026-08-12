// test_mangle.cpp — Self-verification for MANGLE, the per-note per-slot warp FX.
// Build: see engine/CMakeLists.txt target "test_mangle"
// Run:   test_mangle.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: ..." and exits 1
//
// Two layers of coverage:
//   1. The pure shapers and the read-head planner in MangleDsp.h, driven
//      directly. Deterministic, no sampler, no audio graph.
//   2. MANGLE through a real Sampler — which is the only place the feature's
//      actual claim can be tested: that the effect is PER NOTE. testChordIsSum
//      is that claim as an assertion.

#include "audio/Sampler.h"
#include "audio/MangleDsp.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <set>
#include <vector>

namespace mg = xleth::mangle;

// ─── Test harness ────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                 \
    do {                                                                 \
        if (cond) {                                                      \
            ++g_passed;                                                  \
        } else {                                                         \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";  \
            ++g_failed;                                                  \
        }                                                                \
    } while (0)

#define CHECK_NEAR(a, b, tol, msg) \
    CHECK(std::abs(static_cast<double>(a) - static_cast<double>(b)) < (tol), msg)

// ─── Utilities ───────────────────────────────────────────────────────────────

static constexpr double kEngineSR = 48000.0;

// Every mode id, so the "all modes" sweeps can never silently miss one that was
// appended to the enum without a test.
static std::vector<int> allModes()
{
    std::vector<int> v;
    for (int m = 1; m < static_cast<int>(mg::Mode::Count); ++m) v.push_back(m);
    return v;
}

static const char* modeName(int m)
{
    switch (static_cast<mg::Mode>(m)) {
        case mg::Mode::Off:        return "OFF";
        case mg::Mode::Sync:       return "SYNC";
        case mg::Mode::BendPlus:   return "BEND+";
        case mg::Mode::BendMinus:  return "BEND-";
        case mg::Mode::BendBoth:   return "BEND+/-";
        case mg::Mode::Pwm:        return "PWM";
        case mg::Mode::AsymPlus:   return "ASYM+";
        case mg::Mode::AsymMinus:  return "ASYM-";
        case mg::Mode::AsymBoth:   return "ASYM+/-";
        case mg::Mode::Flip:       return "FLIP";
        case mg::Mode::Mirror:     return "MIRROR";
        case mg::Mode::Quantize:   return "QUANTIZE";
        case mg::Mode::Even:       return "EVEN";
        case mg::Mode::Odd:        return "ODD";
        case mg::Mode::Lpf:        return "LPF";
        case mg::Mode::Hpf:        return "HPF";
        case mg::Mode::Bpf:        return "BPF";
        case mg::Mode::Notch:      return "NOTCH";
        case mg::Mode::Tube:       return "TUBE";
        case mg::Mode::SoftClip:   return "SOFT CLIP";
        case mg::Mode::HardClip:   return "HARD CLIP";
        case mg::Mode::Diode1:     return "DIODE 1";
        case mg::Mode::Diode2:     return "DIODE 2";
        case mg::Mode::LinearFold: return "LINEAR FOLD";
        case mg::Mode::SineFold:   return "SINE FOLD";
        case mg::Mode::ZeroSquare: return "ZERO-SQUARE";
        case mg::Mode::Asym:       return "ASYM";
        case mg::Mode::Rectify:    return "RECTIFY";
        case mg::Mode::SineShaper: return "SINE SHAPER";
        case mg::Mode::StompBox:   return "STOMP BOX";
        case mg::Mode::TapeSat:    return "TAPE SAT.";
        case mg::Mode::SoftSat:    return "SOFT SAT.";
        case mg::Mode::Fm:         return "FM";
        case mg::Mode::Pd:         return "PD";
        case mg::Mode::Am:         return "AM";
        case mg::Mode::Rm:         return "RM";
        default:                   return "?";
    }
}

static juce::AudioBuffer<float> makeSine(double sampleRate, double freqHz,
                                         int numSamples, float amplitude = 0.5f)
{
    juce::AudioBuffer<float> buf(2, numSamples);
    const double w = 2.0 * juce::MathConstants<double>::pi * freqHz / sampleRate;
    for (int i = 0; i < numSamples; ++i)
    {
        const float s = static_cast<float>(amplitude * std::sin(w * i));
        buf.setSample(0, i, s);
        buf.setSample(1, i, s);
    }
    return buf;
}

static float peakAbs(const juce::AudioBuffer<float>& b)
{
    float p = 0.0f;
    for (int ch = 0; ch < b.getNumChannels(); ++ch)
        for (int i = 0; i < b.getNumSamples(); ++i)
            p = std::max(p, std::abs(b.getSample(ch, i)));
    return p;
}

static double rms(const juce::AudioBuffer<float>& b, int start, int len)
{
    const int end = std::min(start + len, b.getNumSamples());
    double acc = 0.0; int n = 0;
    for (int i = start; i < end; ++i) { const double s = b.getSample(0, i); acc += s * s; ++n; }
    return n > 0 ? std::sqrt(acc / n) : 0.0;
}

static bool allFinite(const juce::AudioBuffer<float>& b)
{
    for (int ch = 0; ch < b.getNumChannels(); ++ch)
        for (int i = 0; i < b.getNumSamples(); ++i)
            if (!std::isfinite(b.getSample(ch, i))) return false;
    return true;
}

// One sampler holding one slot of `srcHz` sine, sustained so notes hold.
static void configureSampler(Sampler& s, const juce::AudioBuffer<float>& pcm,
                             int rootNote = 60)
{
    s.setSlotCount(1);
    s.loadSlotSample(0, pcm, kEngineSR, rootNote);
    s.setSlotRootNote(0, rootNote);
    // Flat, instant envelope so the render is the raw stream, not an envelope
    // shape — every level assertion below would otherwise be measuring ADSR.
    s.setADSR(0.0f, 0.0f, 1.0f, 5.0f);
    s.setCrossfadeMode(true);
    s.setSlotTrim(0, 0, 0, 0.0f, 0.0f, 0.0f);   // no declick: keep it bit-exact
}

// Render `numSamples` of the given notes held from sample 0.
static juce::AudioBuffer<float> render(Sampler& s, const std::vector<int>& notes,
                                       int numSamples)
{
    for (int n : notes) s.noteOn(n, 1.0f, 0);
    juce::AudioBuffer<float> out(2, numSamples);
    out.clear();
    s.processBlock(out, numSamples, kEngineSR);
    return out;
}

// ─── 1. Pure shapers ─────────────────────────────────────────────────────────

static void testHardClipBounds()
{
    std::cout << "TEST: HARD CLIP bounds\n";

    // The bound is the whole effect, so it is asserted directly rather than via
    // an RMS proxy: no output may exceed the threshold A defines, for ANY input
    // including grossly over-unity ones.
    for (float a = 0.0f; a <= 1.0f; a += 0.1f)
    {
        const float t = mg::hardClipThreshold(a);
        bool bounded = true;
        bool reached = false;
        for (float x = -8.0f; x <= 8.0f; x += 0.01f)
        {
            const float y = mg::shapeHardClip(x, a);
            if (std::abs(y) > t + 1.0e-6f) bounded = false;
            if (std::abs(y) > t - 1.0e-6f) reached = true;
        }
        CHECK(bounded, "HARD CLIP output exceeded its threshold at A=" << a);
        CHECK(reached, "HARD CLIP never reached its threshold at A=" << a);
    }

    // A lowers the threshold, monotonically.
    CHECK_NEAR(mg::hardClipThreshold(0.0f), 1.0f, 1e-6, "A=0 threshold should be unity");
    CHECK(mg::hardClipThreshold(1.0f) < mg::hardClipThreshold(0.5f),
          "raising A must lower the clip threshold");
    CHECK(mg::hardClipThreshold(0.5f) < mg::hardClipThreshold(0.0f),
          "raising A must lower the clip threshold");

    // At A=0 the curve is transparent inside +/-1.
    for (float x = -0.99f; x <= 0.99f; x += 0.05f)
        CHECK_NEAR(mg::shapeHardClip(x, 0.0f), x, 1e-6, "A=0 must pass |x|<1 unchanged");
}

static void testRectifyPolarity()
{
    std::cout << "TEST: RECTIFY polarity\n";

    // A=0 is half-wave: every negative input is removed, every positive one
    // passes untouched.
    for (float x = -2.0f; x <= 2.0f; x += 0.01f)
    {
        const float y = mg::shapeRectify(x, 0.0f);
        CHECK(y >= 0.0f, "half-wave rectify emitted a negative sample");
        if (x > 0.0f) CHECK_NEAR(y, x, 1e-6, "half-wave must pass positives unchanged");
        else          CHECK_NEAR(y, 0.0f, 1e-6, "half-wave must zero negatives");
    }

    // A=1 is full-wave: |x|.
    for (float x = -2.0f; x <= 2.0f; x += 0.01f)
        CHECK_NEAR(mg::shapeRectify(x, 1.0f), std::abs(x), 1e-6,
                   "full-wave rectify must equal |x|");

    // Between the two, a negative input folds up proportionally to A and the
    // output is never negative anywhere on the sweep.
    CHECK_NEAR(mg::shapeRectify(-1.0f, 0.5f), 0.5f, 1e-6, "A=0.5 should half-fold negatives");
    for (float a = 0.0f; a <= 1.0f; a += 0.05f)
        for (float x = -2.0f; x <= 2.0f; x += 0.05f)
            CHECK(mg::shapeRectify(x, a) >= 0.0f, "rectify emitted a negative sample");
}

static void testQuantizeBitDepth()
{
    std::cout << "TEST: QUANTIZE bit depth\n";

    // Sweep a full-scale ramp through the quantiser and count the distinct
    // output levels. That count IS the realised bit depth, so it is what the
    // test measures rather than trusting the parameter mapping.
    auto distinctLevels = [](float a) {
        mg::Runtime rt = mg::makeRuntime(static_cast<int>(mg::Mode::Quantize),
                                         a, 1.0f, 440.0, 100.0, 0.0, 1000.0, kEngineSR);
        mg::State st;
        std::set<float> levels;
        for (int i = 0; i <= 20000; ++i) {
            const float x = -1.0f + 2.0f * (static_cast<float>(i) / 20000.0f);
            levels.insert(mg::shapeSample(rt, st, x, 0));
        }
        return static_cast<int>(levels.size());
    };

    // A=1 is 1 bit: round(x * 2^0) over [-1,1] can only produce -1, 0, +1.
    const int oneBit = distinctLevels(1.0f);
    CHECK(oneBit <= 3, "A=1 should be 1-bit (<=3 levels), got " << oneBit);

    // A=0 is 16 bit: 2^15 quantisation steps means the ramp resolves into far
    // more levels than any coarse setting.
    const int sixteenBit = distinctLevels(0.0f);
    CHECK(sixteenBit > 2000, "A=0 should be ~16-bit, got " << sixteenBit << " levels");

    // Monotone: more amount is never more resolution.
    const int mid = distinctLevels(0.5f);
    CHECK(sixteenBit > mid && mid > oneBit,
          "level count must fall monotonically with amount: "
          << sixteenBit << " > " << mid << " > " << oneBit);

    // 4 bits (A = 12/15) must land on exactly 2^3 = 8 steps over [-1,1], i.e.
    // 17 reachable levels counting both rails and zero.
    const int fourBit = distinctLevels(12.0f / 15.0f);
    CHECK(fourBit == 17, "4-bit should resolve 17 levels, got " << fourBit);
}

static void testShapersAreSilenceSafe()
{
    std::cout << "TEST: silence in / silence out (all modes, shaper level)\n";

    // A shaper that emits anything from a zero input adds a DC or a tone to
    // every silent slot in the project. None may.
    for (int m : allModes())
    {
        for (float a : { 0.0f, 0.5f, 1.0f })
        {
            mg::Runtime rt = mg::makeRuntime(m, a, 1.0f, 440.0, 128.0, 0.0, 4096.0, kEngineSR);
            mg::State st;
            float worst = 0.0f;
            for (int i = 0; i < 4096; ++i) {
                const float y = mg::shapeSample(rt, st, 0.0f, i & 1);
                worst = std::max(worst, std::abs(y));
            }
            CHECK(worst < 1.0e-9f,
                  "mode " << modeName(m) << " A=" << a
                  << " produced " << worst << " from silence");
        }
    }
}

static void testShapersAreBounded()
{
    std::cout << "TEST: no blow-up / no denormal trap (all modes, shaper level)\n";

    // Worst case for a recursive shaper: a resonant filter or DC blocker fed
    // full-scale noise, then fed silence (the classic denormal decay trap).
    juce::Random rng(20260812);
    for (int m : allModes())
    {
        for (float a : { 0.0f, 0.25f, 0.75f, 1.0f })
        {
            mg::Runtime rt = mg::makeRuntime(m, a, 1.0f, 55.0, 872.0, 0.0, 96000.0, kEngineSR);
            mg::State st;
            float worst = 0.0f;
            bool finite = true;
            for (int i = 0; i < 48000; ++i) {
                const float x = (i < 24000) ? (rng.nextFloat() * 2.0f - 1.0f) : 0.0f;
                const float y = mg::shapeSample(rt, st, x, 0);
                if (!std::isfinite(y)) finite = false;
                worst = std::max(worst, std::abs(y));
            }
            CHECK(finite, "mode " << modeName(m) << " A=" << a << " produced a non-finite sample");
            // Nothing may run away. 8x full scale is a generous ceiling that
            // still catches a genuinely unstable filter or a runaway fold.
            CHECK(worst < 8.0f,
                  "mode " << modeName(m) << " A=" << a << " peaked at " << worst);
            // The decay tail must actually reach zero, not idle on denormals.
            CHECK(std::abs(mg::shapeSample(rt, st, 0.0f, 0)) < 1.0e-9f,
                  "mode " << modeName(m) << " A=" << a << " left a non-zero tail");
        }
    }
}

static void testDistortionKeepsUsableRange()
{
    std::cout << "TEST: distortion curves keep a usable range at every drive\n";

    // A drive law that walks the operating point onto the rail crushes one half
    // of the waveform to nothing while the other saturates — the signal is
    // still "bounded" and still "silent from silence", so the other tests miss
    // it entirely. This one measures the transfer curve directly: sweep the
    // input and require both polarities to still produce real output.
    //
    // (This is exactly the defect the original TUBE bias had: biasing before
    // the drive collapsed x=+1 to +0.001 at A=1 while x=-1 swung to -2.)
    struct Curve { int mode; float (*fn)(float, float); };
    const Curve curves[] = {
        { static_cast<int>(mg::Mode::Tube),       mg::shapeTube },
        { static_cast<int>(mg::Mode::SoftClip),   mg::shapeSoftClip },
        { static_cast<int>(mg::Mode::HardClip),   mg::shapeHardClip },
        { static_cast<int>(mg::Mode::Diode1),     mg::shapeDiode1 },
        { static_cast<int>(mg::Mode::Diode2),     mg::shapeDiode2 },
        { static_cast<int>(mg::Mode::LinearFold), mg::shapeLinearFold },
        { static_cast<int>(mg::Mode::SineFold),   mg::shapeSineFold },
        { static_cast<int>(mg::Mode::ZeroSquare), mg::shapeZeroSquare },
        { static_cast<int>(mg::Mode::Asym),       mg::shapeAsym },
        { static_cast<int>(mg::Mode::SineShaper), mg::shapeSineShaper },
        { static_cast<int>(mg::Mode::StompBox),   mg::shapeStompBox },
        { static_cast<int>(mg::Mode::SoftSat),    mg::shapeSoftSat },
    };

    for (const auto& c : curves)
    {
        for (float a : { 0.0f, 0.5f, 1.0f })
        {
            float maxPos = 0.0f, maxNeg = 0.0f;
            for (float x = -1.0f; x <= 1.0f; x += 0.005f) {
                const float y = c.fn(x, a);
                maxPos = std::max(maxPos, y);
                maxNeg = std::min(maxNeg, y);
            }
            // HARD CLIP legitimately shrinks BOTH halves together as A rises,
            // so it is measured against its own threshold rather than a fixed
            // floor. Everything else must keep both halves alive.
            const float floorLevel = (c.mode == static_cast<int>(mg::Mode::HardClip))
                                   ? mg::hardClipThreshold(a) * 0.9f : 0.1f;
            CHECK(maxPos >= floorLevel,
                  "mode " << modeName(c.mode) << " A=" << a
                  << ": positive half collapsed to " << maxPos);
            CHECK(-maxNeg >= floorLevel,
                  "mode " << modeName(c.mode) << " A=" << a
                  << ": negative half collapsed to " << maxNeg);

            // Asymmetry is a feature, but a 6:1 imbalance means the curve has
            // walked its operating point rather than shaped the signal.
            const float ratio = std::max(maxPos, -maxNeg) / std::max(1.0e-6f, std::min(maxPos, -maxNeg));
            CHECK(ratio < 6.0f,
                  "mode " << modeName(c.mode) << " A=" << a
                  << ": halves are lopsided by " << ratio << ":1");
        }
    }

    // TUBE specifically must stay asymmetric — that is the whole point of it —
    // without either half dying. Pin the documented shape.
    for (float a : { 0.5f, 1.0f }) {
        const float pos = mg::shapeTube(1.0f, a);
        const float neg = mg::shapeTube(-1.0f, a);
        CHECK(pos > 0.5f, "TUBE positive rail collapsed at A=" << a << " (" << pos << ")");
        CHECK(neg < -1.0f, "TUBE lost its negative-side asymmetry at A=" << a << " (" << neg << ")");
        CHECK_NEAR(mg::shapeTube(0.0f, a), 0.0f, 1e-6, "TUBE must cross the origin exactly");
    }
}

// ─── 2. Read-head planner ────────────────────────────────────────────────────

static void testSyncResetPeriodicity()
{
    std::cout << "TEST: SYNC reset periodicity\n";

    constexpr double L = 100.0;     // source samples per note cycle
    constexpr double stride = 1.0;
    constexpr int    N = 401;

    // A > 0: the head sweeps faster than the note and snaps back to the anchor
    // once per cycle. The snap is the effect, so the test counts snaps.
    {
        mg::Runtime rt = mg::makeRuntime(static_cast<int>(mg::Mode::Sync),
                                         0.5f, 1.0f, 440.0, L, 0.0, 1.0e6, kEngineSR);
        mg::State st;
        std::vector<double> pos;
        pos.reserve(N);
        for (int i = 0; i < N; ++i) {
            const double readPos = static_cast<double>(i);
            pos.push_back(readPos + mg::tick(rt, st, readPos, stride).posOffset);
        }
        int resets = 0;
        std::vector<int> resetAt;
        for (int i = 1; i < N; ++i)
            if (pos[i] < pos[i - 1]) { ++resets; resetAt.push_back(i); }

        CHECK(resets == 4, "SYNC should reset once per cycle (4 in 401 samples), got " << resets);
        for (size_t k = 0; k < resetAt.size(); ++k)
            CHECK(resetAt[k] == static_cast<int>((k + 1) * L),
                  "SYNC reset " << k << " landed at " << resetAt[k]
                  << ", expected " << ((k + 1) * static_cast<int>(L)));

        // Between resets the head travels (1 + 7A) = 4.5x its natural rate.
        CHECK_NEAR(pos[50] - pos[49], 4.5, 1e-6, "SYNC sweep rate at A=0.5 should be 4.5x");
    }

    // A = 0 must be an EXACT identity — no reset, no drift. This is the free-
    // bypass guarantee for the whole cycle-locked group.
    {
        mg::Runtime rt = mg::makeRuntime(static_cast<int>(mg::Mode::Sync),
                                         0.0f, 1.0f, 440.0, L, 0.0, 1.0e6, kEngineSR);
        mg::State st;
        double worst = 0.0;
        for (int i = 0; i < N; ++i) {
            const double readPos = static_cast<double>(i);
            worst = std::max(worst, std::abs(mg::tick(rt, st, readPos, stride).posOffset));
        }
        CHECK(worst < 1.0e-9, "SYNC at A=0 must be an exact identity, drifted " << worst);
    }
}

static void testPositionModesIdentityAtZero()
{
    std::cout << "TEST: position modes are identity at A=0\n";

    // Every read-head mode is defined so that A=0 leaves the head alone. That
    // makes "amount at minimum" a true neutral for the whole ALT group and is
    // what a user reaches for when backing an effect out.
    //
    // The FILTER group is deliberately excluded: A there is a cutoff sweep
    // around a key-tracked base, so A=0 is "3 octaves down", not "off".
    constexpr double L = 128.0;
    for (int m : allModes())
    {
        if (!mg::isPositionMode(static_cast<mg::Mode>(m))) continue;
        mg::Runtime rt = mg::makeRuntime(m, 0.0f, 1.0f, 440.0, L, 0.0, 1.0e6, kEngineSR);
        mg::State st;
        double worst = 0.0;
        for (int i = 0; i < 512; ++i) {
            const double readPos = static_cast<double>(i);
            worst = std::max(worst, std::abs(mg::tick(rt, st, readPos, 1.0).posOffset));
        }
        CHECK(worst < 1.0e-6,
              "mode " << modeName(m) << " moved the head by " << worst << " at A=0");
    }
}

static void testBypassGate()
{
    std::cout << "TEST: bypass gate is free\n";

    // Mode Off is inert whatever the other two knobs say.
    for (float a : { 0.0f, 1.0f })
        for (float mix : { 0.0f, 1.0f }) {
            mg::Runtime rt = mg::makeRuntime(0, a, mix, 440.0, 100.0, 0.0, 1000.0, kEngineSR);
            CHECK(!rt.active, "mode Off must never be active");
        }

    // Mix 0 is inert whatever the mode says — this is the gate the render loop
    // branches on, so every mode has to honour it.
    for (int m : allModes()) {
        mg::Runtime rt = mg::makeRuntime(m, 1.0f, 0.0f, 440.0, 100.0, 0.0, 1000.0, kEngineSR);
        CHECK(!rt.active, "mode " << modeName(m) << " must be inert at mix=0");
    }

    // An out-of-range id is treated as Off rather than indexing off the enum.
    mg::Runtime bad = mg::makeRuntime(9999, 1.0f, 1.0f, 440.0, 100.0, 0.0, 1000.0, kEngineSR);
    CHECK(!bad.active && bad.mode == mg::Mode::Off, "unknown mode id must fall back to Off");
    CHECK(!mg::isValidMode(-1) && !mg::isValidMode(static_cast<int>(mg::Mode::Count)),
          "isValidMode must reject out-of-range ids");
}

// ─── 3. Through the Sampler ──────────────────────────────────────────────────

static void testMixZeroIsPassthrough()
{
    std::cout << "TEST: mix=0 is bit-identical passthrough\n";

    const auto pcm = makeSine(kEngineSR, 220.0, 48000, 0.5f);
    constexpr int N = 4096;

    Sampler dry;   configureSampler(dry, pcm);
    // A mode that would be violently audible if it ran at all.
    Sampler wet;   configureSampler(wet, pcm);
    wet.setSlotMangle(0, static_cast<int>(mg::Mode::StompBox), 1.0f, 0.0f);

    auto a = render(dry, { 60 }, N);
    auto b = render(wet, { 60 }, N);

    double worst = 0.0;
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < N; ++i)
            worst = std::max<double>(worst,
                std::abs(a.getSample(ch, i) - b.getSample(ch, i)));
    CHECK(worst == 0.0, "mix=0 must be bit-identical to no MANGLE, differed by " << worst);

    // Anti-vacuity: the SAME mode at mix=1 must change the signal materially.
    // Without this, a MANGLE that silently never ran would pass the assertion
    // above with flying colours.
    Sampler full; configureSampler(full, pcm);
    full.setSlotMangle(0, static_cast<int>(mg::Mode::StompBox), 1.0f, 1.0f);
    auto f = render(full, { 60 }, N);
    double diff = 0.0;
    for (int i = 0; i < N; ++i)
        diff = std::max<double>(diff, std::abs(a.getSample(0, i) - f.getSample(0, i)));
    CHECK(diff > 0.05,
          "STOMP BOX at mix=1 barely changed the signal (" << diff
          << ") — the mix=0 assertion would be vacuous");

    // Same for mode Off at full mix and full amount.
    Sampler off; configureSampler(off, pcm);
    off.setSlotMangle(0, 0, 1.0f, 1.0f);
    auto c = render(off, { 60 }, N);
    worst = 0.0;
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < N; ++i)
            worst = std::max<double>(worst,
                std::abs(a.getSample(ch, i) - c.getSample(ch, i)));
    CHECK(worst == 0.0, "mode Off must be bit-identical to no MANGLE, differed by " << worst);
}

static void testLpfAttenuatesHighs()
{
    std::cout << "TEST: LPF attenuates highs\n";

    // A bright source one root octave up, so the note frequency is well below
    // the content the filter has to remove.
    const auto bright = makeSine(kEngineSR, 6000.0, 48000, 0.5f);
    constexpr int N = 8192;

    Sampler dry; configureSampler(dry, bright);
    auto dryOut = render(dry, { 60 }, N);

    Sampler lp; configureSampler(lp, bright);
    // A=0 puts the cutoff 3 octaves below the key-tracked base (4x the note),
    // i.e. deep under 6 kHz — the content should be gutted.
    lp.setSlotMangle(0, static_cast<int>(mg::Mode::Lpf), 0.0f, 1.0f);
    auto lpOut = render(lp, { 60 }, N);

    // Skip the filter's settling transient.
    const double dryRms = rms(dryOut, 2048, 4096);
    const double lpRms  = rms(lpOut,  2048, 4096);
    CHECK(dryRms > 0.05, "dry reference should be a healthy level, got " << dryRms);
    CHECK(lpRms < dryRms * 0.25,
          "LPF should cut 6 kHz well below -12 dB: dry=" << dryRms << " lp=" << lpRms);

    // The mirror case: HPF at the same setting must NOT gut it (the content is
    // far above the cutoff), which proves the cut above is the filter and not
    // some incidental gain loss in the wet path.
    Sampler hp; configureSampler(hp, bright);
    hp.setSlotMangle(0, static_cast<int>(mg::Mode::Hpf), 0.0f, 1.0f);
    auto hpOut = render(hp, { 60 }, N);
    const double hpRms = rms(hpOut, 2048, 4096);
    CHECK(hpRms > dryRms * 0.5,
          "HPF should pass 6 kHz largely intact: dry=" << dryRms << " hp=" << hpRms);
}

static void testSilenceInSilenceOutThroughSampler()
{
    std::cout << "TEST: silence in / silence out (all modes, through Sampler)\n";

    // An all-zero sample: no mode may manufacture signal out of it, whatever
    // it does to the read head.
    juce::AudioBuffer<float> silent(2, 48000);
    silent.clear();
    constexpr int N = 4096;

    for (int m : allModes())
    {
        Sampler s; configureSampler(s, silent);
        s.setSlotMangle(0, m, 1.0f, 1.0f);
        auto out = render(s, { 60 }, N);
        CHECK(allFinite(out), "mode " << modeName(m) << " produced a non-finite sample");
        CHECK(peakAbs(out) < 1.0e-7f,
              "mode " << modeName(m) << " made " << peakAbs(out) << " out of silence");
    }
}

static void testChordIsSumOfNotes()
{
    std::cout << "TEST: chord == sum of independently mangled notes\n";

    // THE feature test. If MANGLE is genuinely per-note, a chord rendered
    // through it must equal the SUM of the same notes rendered one at a time —
    // because each note met its own private shaper and nothing ever saw the
    // sum. An insert effect cannot pass this: a shared non-linearity
    // intermodulates the notes, so chord != sum by a wide margin.
    //
    // Run for a hard non-linearity (TUBE at 100%, the manual smoke case) and a
    // read-head mode, so both domains are covered.
    const auto pcm = makeSine(kEngineSR, 220.0, 48000, 0.4f);
    constexpr int N = 8192;
    const std::vector<int> chord = { 60, 64, 67 };

    for (int mode : { static_cast<int>(mg::Mode::Tube),
                      static_cast<int>(mg::Mode::Sync) })
    {
        Sampler chordS; configureSampler(chordS, pcm);
        chordS.setSlotMangle(0, mode, 1.0f, 1.0f);
        auto together = render(chordS, chord, N);

        juce::AudioBuffer<float> apart(2, N);
        apart.clear();
        for (int n : chord) {
            Sampler one; configureSampler(one, pcm);
            one.setSlotMangle(0, mode, 1.0f, 1.0f);
            auto solo = render(one, { n }, N);
            for (int ch = 0; ch < 2; ++ch)
                apart.addFrom(ch, 0, solo, ch, 0, N);
        }

        double worst = 0.0;
        for (int ch = 0; ch < 2; ++ch)
            for (int i = 0; i < N; ++i)
                worst = std::max<double>(worst,
                    std::abs(together.getSample(ch, i) - apart.getSample(ch, i)));

        // Only float summation order differs between the two renders.
        CHECK(worst < 1.0e-5,
              "mode " << modeName(mode) << ": chord and sum-of-notes diverged by "
              << worst << " — MANGLE is not per-note");
        CHECK(peakAbs(together) > 0.05f,
              "mode " << modeName(mode) << ": chord render was silent, test is vacuous");
    }

    // Control: the same comparison is a FAILURE for a shared non-linearity.
    // Distorting the summed chord and distorting each note then summing give
    // materially different signals — which is what makes the assertion above
    // meaningful rather than trivially true.
    {
        Sampler clean; configureSampler(clean, pcm);
        auto sum = render(clean, chord, N);

        juce::AudioBuffer<float> sharedInsert(2, N);
        for (int ch = 0; ch < 2; ++ch)
            for (int i = 0; i < N; ++i)
                sharedInsert.setSample(ch, i, mg::shapeTube(sum.getSample(ch, i), 1.0f));

        Sampler perNote; configureSampler(perNote, pcm);
        perNote.setSlotMangle(0, static_cast<int>(mg::Mode::Tube), 1.0f, 1.0f);
        auto perNoteOut = render(perNote, chord, N);

        double worst = 0.0;
        for (int i = 0; i < N; ++i)
            worst = std::max<double>(worst,
                std::abs(sharedInsert.getSample(0, i) - perNoteOut.getSample(0, i)));
        CHECK(worst > 0.01,
              "per-note and shared-insert distortion should differ audibly, differed by "
              << worst << " — the per-note assertion may be vacuous");
    }
}

static void testModeSwitchNeedsNoRealloc()
{
    std::cout << "TEST: mode switch mid-note is stable\n";

    // Modes are switched by an integer write on a preallocated state block. The
    // observable contract is that switching while notes sound neither crashes
    // nor produces anything non-finite.
    const auto pcm = makeSine(kEngineSR, 300.0, 48000, 0.5f);
    Sampler s; configureSampler(s, pcm);
    s.noteOn(60, 1.0f, 0);
    s.noteOn(67, 1.0f, 0);

    juce::AudioBuffer<float> out(2, 512);
    for (int m : allModes())
    {
        s.setSlotMangle(0, m, 0.8f, 1.0f);
        out.clear();
        s.processBlock(out, 512, kEngineSR);
        CHECK(allFinite(out), "switching to " << modeName(m) << " mid-note produced non-finite output");
        CHECK(peakAbs(out) < 8.0f, "switching to " << modeName(m) << " mid-note peaked at " << peakAbs(out));
    }
}

static void testPerfSmoke32Streams()
{
    std::cout << "TEST: perf smoke, 32 concurrent streams x worst-case modes\n";

    // MAX_STREAMS is 32 and the stream is the real cost centre, so the smoke
    // test saturates it: 8 slots x 4 notes. The worst-case modes are the ones
    // that pay for a second interpolated read (position domain), a third
    // (ODD/EVEN comb) or a transcendental per sample.
    const auto pcm = makeSine(kEngineSR, 220.0, 48000, 0.4f);

    const int worst[] = {
        static_cast<int>(mg::Mode::Odd),        // 3 reads/sample/channel
        static_cast<int>(mg::Mode::Mirror),     // 2 reads + fmod
        static_cast<int>(mg::Mode::Fm),         // 2 reads + sin
        static_cast<int>(mg::Mode::StompBox),   // tanh + cubic + DC block
        static_cast<int>(mg::Mode::Lpf),        // recursive SVF
        static_cast<int>(mg::Mode::ZeroSquare), // pow per sample
        static_cast<int>(mg::Mode::Quantize),
        static_cast<int>(mg::Mode::Tube),
    };

    Sampler s;
    s.setSlotCount(8);
    for (int i = 0; i < 8; ++i) {
        s.loadSlotSample(i, pcm, kEngineSR, 60);
        s.setSlotRootNote(i, 60);
        s.setSlotTrim(i, 0, 0, 0.0f, 0.0f, 0.0f);
        s.setSlotLevel(i, 0.25f, 0.0f);
        s.setSlotMangle(i, worst[i], 0.9f, 1.0f);
    }
    s.setADSR(0.0f, 0.0f, 1.0f, 5.0f);
    s.setCrossfadeMode(true);

    for (int n : { 48, 55, 60, 67 }) s.noteOn(n, 1.0f, 0);
    CHECK(s.activeStreamCount() == 32,
          "expected 32 streams, got " << s.activeStreamCount());

    constexpr int kBlock  = 512;
    constexpr int kBlocks = 200;      // ~2.1 s of audio
    juce::AudioBuffer<float> out(2, kBlock);

    const auto t0 = std::chrono::steady_clock::now();
    float worstPeak = 0.0f;
    bool finite = true;
    for (int b = 0; b < kBlocks; ++b) {
        out.clear();
        s.processBlock(out, kBlock, kEngineSR);
        if (!allFinite(out)) finite = false;
        worstPeak = std::max(worstPeak, peakAbs(out));
    }
    const auto t1 = std::chrono::steady_clock::now();
    const double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
    const double audioMs = (kBlocks * kBlock) / kEngineSR * 1000.0;
    const double realtimeFactor = audioMs / ms;

    std::cout << "        rendered " << audioMs << " ms of audio in " << ms
              << " ms  (" << realtimeFactor << "x realtime)\n";

    CHECK(finite, "32-stream worst-case render produced non-finite output");
    CHECK(worstPeak > 0.01f, "32-stream render was silent, perf number is meaningless");
    CHECK(worstPeak < 8.0f, "32-stream render peaked at " << worstPeak);
    // Generous: a Debug or heavily contended CI box is still nowhere near 1x.
    // The point is to catch an accidental order-of-magnitude regression (an
    // allocation, a pow moved into the per-sample path), not to grade the CPU.
    CHECK(realtimeFactor > 5.0,
          "32 worst-case streams ran at only " << realtimeFactor << "x realtime");
}

// ─── main ────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "Running MANGLE tests...\n\n";

    // Pure shapers
    testHardClipBounds();
    testRectifyPolarity();
    testQuantizeBitDepth();
    testShapersAreSilenceSafe();
    testShapersAreBounded();
    testDistortionKeepsUsableRange();

    // Read-head planner
    testSyncResetPeriodicity();
    testPositionModesIdentityAtZero();
    testBypassGate();

    // Through the Sampler
    testMixZeroIsPassthrough();
    testLpfAttenuatesHighs();
    testSilenceInSilenceOutThroughSampler();
    testChordIsSumOfNotes();
    testModeSwitchNeedsNoRealloc();
    testPerfSmoke32Streams();

    std::cout << "\n";
    if (g_failed == 0)
    {
        std::cout << "ALL TESTS PASSED (" << g_passed << " checks)\n";
        return 0;
    }
    std::cerr << "FAILED: " << g_failed << " / " << (g_passed + g_failed)
              << " checks\n";
    return 1;
}
