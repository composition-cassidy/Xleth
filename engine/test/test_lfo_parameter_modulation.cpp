// test_lfo_parameter_modulation.cpp
// Unit tests for the pure engine-side LFO Modulator evaluator
// (model/LfoParameterModulation.h).
//
// Sibling of test_envelope_parameter_modulation.cpp, same harness/style. The LFO
// is FREE-RUNNING (no gate/trigger), so there is no gate-merge/chord/restart
// section here — see LfoParameterModulation.h's header-top note for why that
// machinery is deliberately absent. Coverage map:
//
//   §1  tempo-sync direction regression (division/4, NOT the Sampler's 4/division)
//   §2  free-mode ms -> Hz conversion
//   §3  evaluateLfoWaveform at known phase points, incl. the empty-waveform sine
//       fallback
//   §4  position purity (identical inputs -> identical output, no hidden state)
//   §5  loop-wrap sanity (position vs position + N*cyclePeriod match)
//   §6  end-to-end tremolo mapping worked example (base 0.8, depth -0.6)
//   §7  parseGraphStateLfoNodes: happy path + skip-reason parity with Envelope
//
// Build target: test_lfo_parameter_modulation  (engine/CMakeLists.txt)
// Pass: prints "ALL TESTS PASSED" and exits 0.

#include "model/LfoParameterModulation.h"

#include <cmath>
#include <iostream>
#include <string>
#include <vector>

using namespace xleth::lfomod;

// ─── Minimal harness (mirrors test_envelope_parameter_modulation.cpp) ─────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                  \
    do {                                                                  \
        if (cond) {                                                       \
            ++g_passed;                                                   \
        } else {                                                          \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";   \
            ++g_failed;                                                   \
        }                                                                 \
    } while (0)

static bool nearly(double a, double b, double eps = 1e-9)
{
    return std::fabs(a - b) <= eps;
}

#define CHECK_NEAR(actual, expected, msg)                                      \
    do {                                                                       \
        const double a_ = (actual);                                            \
        const double e_ = (expected);                                          \
        if (nearly(a_, e_, 1e-9)) {                                            \
            ++g_passed;                                                        \
        } else {                                                               \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg                 \
                      << " (got " << a_ << ", want " << e_ << ")\n";           \
            ++g_failed;                                                        \
        }                                                                      \
    } while (0)

static constexpr double kSR  = 48000.0;
static constexpr double kBPM = 120.0;
static constexpr double kPi  = 3.14159265358979323846;

static LfoShape freeShape(double rateMs)
{
    LfoShape s;
    s.rateMode = RateMode::Free;
    s.rateMs   = rateMs;
    return s;
}

static LfoShape syncShape(double division)
{
    LfoShape s;
    s.rateMode     = RateMode::Sync;
    s.syncDivision = division;
    return s;
}

// ─── §1b multi-bar (sub-1) sync divisions ─────────────────────────────────────
//
// syncDivision is the note DENOMINATOR, so cycles slower than a single whole
// note (1/1) are expressed as fractions below 1: 0.5 = "2/1" (two whole notes,
// 8 beats), 0.25 = "4/1", 0.125 = "8/1". This only works because syncDivision is
// a double — it was originally an int, which floored every one of these to 0 and
// clamped them all onto the same minimum, collapsing all four slow rates into
// one. This test is the regression guard for that.

static void testMultiBarSyncDivisions()
{
    std::cout << "§1b multi-bar sync divisions (slower than 1/1)\n";

    const double hz1     = lfoCycleHz(syncShape(1.0),   kBPM);
    const double hz2bar  = lfoCycleHz(syncShape(0.5),   kBPM);
    const double hz4bar  = lfoCycleHz(syncShape(0.25),  kBPM);
    const double hz8bar  = lfoCycleHz(syncShape(0.125), kBPM);

    // (bpm/60) * (division/4) at 120bpm => 2.0 * division/4.
    CHECK_NEAR(hz2bar, 0.25,   "division=0.5 (2/1) at 120bpm is 0.25 Hz (4s cycle)");
    CHECK_NEAR(hz4bar, 0.125,  "division=0.25 (4/1) at 120bpm is 0.125 Hz (8s cycle)");
    CHECK_NEAR(hz8bar, 0.0625, "division=0.125 (8/1) at 120bpm is 0.0625 Hz (16s cycle)");

    // Each step down the list must be exactly half the rate of the one above it,
    // and every one of them must be slower than a whole note.
    CHECK_NEAR(hz2bar, hz1 * 0.5,    "2/1 is exactly half the rate of 1/1");
    CHECK_NEAR(hz4bar, hz2bar * 0.5, "4/1 is exactly half the rate of 2/1");
    CHECK_NEAR(hz8bar, hz4bar * 0.5, "8/1 is exactly half the rate of 4/1");
    CHECK(hz8bar < hz4bar && hz4bar < hz2bar && hz2bar < hz1,
          "multi-bar divisions are strictly slower than 1/1 and distinct from each other");

    // They must survive the JSON normalizer as fractions, not get truncated.
    const LfoShape parsed = normalizeLfoShape(
        nlohmann::json{{"rateMode", "sync"}, {"syncDivision", 0.125}});
    CHECK_NEAR(parsed.syncDivision, 0.125, "fractional syncDivision survives normalization");
    CHECK_NEAR(lfoCycleHz(parsed, kBPM), 0.0625, "normalized 8/1 still evaluates to 0.0625 Hz");

    // Garbage still lands on the floor rather than producing a zero/negative rate.
    const LfoShape zeroed = normalizeLfoShape(
        nlohmann::json{{"rateMode", "sync"}, {"syncDivision", 0.0}});
    CHECK(zeroed.syncDivision >= kMinSyncDivision, "zero syncDivision clamps to the floor");
    CHECK(lfoCycleHz(zeroed, kBPM) > 0.0, "clamped syncDivision still yields a positive rate");
}

// ─── §1c phase offset ─────────────────────────────────────────────────────────
//
// phaseOffset shifts where in the cycle the waveform sits at a given transport
// position. The UI exposes this in degrees (0..360); the model stores a 0..1
// cycle fraction. A quarter-turn (90deg = 0.25) on a sine must move the value at
// position 0 from the zero-crossing to the peak.

static void testPhaseOffset()
{
    std::cout << "§1c phase offset\n";

    LfoShape s;                       // empty waveform => sin(2*pi*phase) fallback
    s.rateMode = RateMode::Free;
    s.rateMs   = 1000.0;              // 1 Hz

    s.phaseOffset = 0.0;
    CHECK_NEAR(evaluateLfoAtPosition(s, 0, kBPM, kSR), 0.0, "phase 0: sine starts at zero-crossing");

    s.phaseOffset = 0.25;             // 90 degrees
    CHECK_NEAR(evaluateLfoAtPosition(s, 0, kBPM, kSR), 1.0, "phase 0.25 (90deg): sine starts at peak");

    s.phaseOffset = 0.5;              // 180 degrees
    CHECK_NEAR(evaluateLfoAtPosition(s, 0, kBPM, kSR), 0.0, "phase 0.5 (180deg): back to zero-crossing");

    s.phaseOffset = 0.75;             // 270 degrees
    CHECK_NEAR(evaluateLfoAtPosition(s, 0, kBPM, kSR), -1.0, "phase 0.75 (270deg): sine starts at trough");

    // A phase offset is a pure time shift: offsetting by q must equal sampling
    // the un-offset LFO q cycles later.
    LfoShape base;
    base.rateMode = RateMode::Free;
    base.rateMs   = 1000.0;           // 1 Hz => 1 cycle per kSR samples
    LfoShape shifted = base;
    shifted.phaseOffset = 0.25;
    const int64_t quarterCycle = static_cast<int64_t>(kSR / 4.0);
    CHECK_NEAR(evaluateLfoAtPosition(shifted, 0, kBPM, kSR),
               evaluateLfoAtPosition(base, quarterCycle, kBPM, kSR),
               "phase offset q equals sampling the unshifted LFO q cycles later");

    // 360 degrees is the same point in the cycle as 0. Note the two layers repair
    // out-of-range phase differently -- the renderer's normalizeLfoNodeData WRAPS
    // (1.0 -> 0.0) while this engine's clampUnitField CLAMPS (1.0 stays 1.0) --
    // but evaluation is frac()-based, so both must yield an identical value. The
    // renderer is the only writer and always emits [0,1), so the divergence is
    // unobservable; asserting on the evaluated value rather than the stored field
    // keeps this test true under either repair policy.
    LfoShape full = base;
    full.phaseOffset = 1.0;
    CHECK_NEAR(evaluateLfoAtPosition(full, 12345, kBPM, kSR),
               evaluateLfoAtPosition(base, 12345, kBPM, kSR),
               "phase 360deg evaluates identically to 0deg");
}

// ─── §1 tempo-sync direction regression ────────────────────────────────────────
//
// THE headline test. The Sampler's own advanceLfo computes (bpm/60)*(4/division),
// which makes "1/8" oscillate SLOWER than "1/4" — confirmed backwards. This
// implementation is (bpm/60)*(division/4): a smaller note-value division (a
// larger `syncDivision` number, e.g. 8 for "1/8") must be a FASTER cycle. So at a
// fixed bpm, syncDivision=8 must be exactly 2x the rate of syncDivision=4 (NOT
// half), and syncDivision=16 must be 2x syncDivision=8. syncDivision=1 is the
// slowest of the bunch.

static void testTempoSyncDirection()
{
    std::cout << "§1 tempo-sync direction regression\n";

    const double hz1  = lfoCycleHz(syncShape(1), kBPM);
    const double hz4  = lfoCycleHz(syncShape(4), kBPM);
    const double hz8  = lfoCycleHz(syncShape(8), kBPM);
    const double hz16 = lfoCycleHz(syncShape(16), kBPM);

    // Exact values from the documented formula: (bpm/60) * (division/4).
    // At 120bpm, bpm/60 = 2 (beats per second), so division=4 (one cycle per
    // beat) is 2 * (4/4) = 2.0 Hz — NOT 0.5. (0.5 Hz is division=1's rate.)
    CHECK_NEAR(hz4, 2.0, "division=4 at 120bpm is 2.0 Hz (one cycle per beat)");
    CHECK_NEAR(hz8, 4.0, "division=8 at 120bpm is 4.0 Hz");
    CHECK_NEAR(hz16, 8.0, "division=16 at 120bpm is 8.0 Hz");
    CHECK_NEAR(hz1, 0.5, "division=1 at 120bpm is 0.5 Hz");

    // THE regression assertion: division=8 is 2x division=4, not half.
    CHECK_NEAR(hz8, hz4 * 2.0, "division=8 is exactly 2x the rate of division=4");
    CHECK_NEAR(hz16, hz8 * 2.0, "division=16 is exactly 2x the rate of division=8");

    // division=1 is the slowest of the four.
    CHECK(hz1 < hz4 && hz4 < hz8 && hz8 < hz16,
          "cycle rate increases monotonically with syncDivision (1 is slowest)");

    // Explicitly NOT the Sampler's inverted formula: (bpm/60)*(4/division) would
    // give division=8 HALF the rate of division=4 — the opposite of what we just
    // asserted above, so this codepath does not reproduce that bug.
    const double invertedHz4 = (kBPM / 60.0) * (4.0 / 4.0);
    const double invertedHz8 = (kBPM / 60.0) * (4.0 / 8.0);
    CHECK(invertedHz8 < invertedHz4,
          "sanity: the INVERTED (Sampler) formula would make 1/8 slower than 1/4 (the bug)");
    CHECK(hz8 > hz4, "our formula does the opposite of the inverted one (the fix)");
}

// ─── §2 free-mode ms -> Hz ──────────────────────────────────────────────────────

static void testFreeModeRate()
{
    std::cout << "§2 free-mode ms -> Hz\n";

    // rateMs is a PERIOD. hz = 1000/rateMs.
    CHECK_NEAR(lfoCycleHz(freeShape(500.0), kBPM), 2.0, "500ms period -> 2 Hz");
    CHECK_NEAR(lfoCycleHz(freeShape(250.0), kBPM), 4.0, "250ms period -> 4 Hz");
    CHECK_NEAR(lfoCycleHz(freeShape(1000.0), kBPM), 1.0, "1000ms period -> 1 Hz");

    // bpm is irrelevant in free mode.
    CHECK_NEAR(lfoCycleHz(freeShape(500.0), 999.0), 2.0, "free mode ignores bpm");

    // Degenerate rateMs (<=0 / non-finite) does not divide by zero.
    LfoShape zero = freeShape(0.0);
    const double hzAtZero = lfoCycleHz(zero, kBPM);
    CHECK(std::isfinite(hzAtZero) && hzAtZero > 0.0, "rateMs=0 falls back to a finite, positive Hz");
}

// ─── §3 waveform evaluation ─────────────────────────────────────────────────────

static void testWaveformEvaluation()
{
    std::cout << "§3 evaluateLfoWaveform at known phase points\n";

    // Empty waveform -> sin(phase*2*PI) fallback, at 0/0.25/0.5/0.75.
    {
        const std::vector<SampleRegion::LfoBreakpoint> empty;
        CHECK_NEAR(evaluateLfoWaveform(empty, 0.0), 0.0, "empty waveform sin(0) = 0");
        CHECK_NEAR(evaluateLfoWaveform(empty, 0.25), 1.0, "empty waveform sin(pi/2) = 1");
        CHECK_NEAR(evaluateLfoWaveform(empty, 0.5), std::sin(kPi), "empty waveform sin(pi) ~ 0");
        CHECK_NEAR(evaluateLfoWaveform(empty, 0.75), -1.0, "empty waveform sin(3pi/2) = -1");
    }

    // Single-point waveform returns that value everywhere. The breakpoint's
    // value is stored as a float (SampleRegion::LfoBreakpoint::value), so the
    // widened double carries float rounding error relative to the double
    // literal 0.42 — compare with float-precision tolerance, not the
    // default 1e-9 double tolerance.
    {
        std::vector<SampleRegion::LfoBreakpoint> one(1);
        one[0].time = 0.0f;
        one[0].value = 0.42f;
        const double expected = static_cast<double>(0.42f);
        CHECK(nearly(evaluateLfoWaveform(one, 0.0), expected, 1e-6), "single point at phase 0");
        CHECK(nearly(evaluateLfoWaveform(one, 0.5), expected, 1e-6), "single point at phase 0.5");
        CHECK(nearly(evaluateLfoWaveform(one, 0.9999), expected, 1e-6), "single point at phase ~1");
    }

    // A simple ramp: (0,-1) -> (1,1). Linear scan + lerp, straight interpolation.
    {
        std::vector<SampleRegion::LfoBreakpoint> ramp(2);
        ramp[0].time = 0.0f;  ramp[0].value = -1.0f;
        ramp[1].time = 1.0f;  ramp[1].value = 1.0f;
        CHECK_NEAR(evaluateLfoWaveform(ramp, 0.0), -1.0, "ramp at 0");
        CHECK_NEAR(evaluateLfoWaveform(ramp, 0.5), 0.0, "ramp at midpoint");
        // phase01 is wrapped to [0,1) DEFENSIVELY (see the header comment): a
        // phase01 of exactly 1.0 wraps to 0.0 (floor(1.0) == 1.0), so it reads
        // the RAMP'S START, not its end — this is a real, intentional property
        // of the wrap, not an off-by-one. A near-but-not-quite-1 phase (0.999)
        // is what actually approaches the last point.
        CHECK_NEAR(evaluateLfoWaveform(ramp, 1.0), -1.0,
                   "phase01 == 1.0 wraps to 0.0 and reads the ramp's start, not its end");
        CHECK(evaluateLfoWaveform(ramp, 0.999) > 0.9,
              "phase01 just under 1.0 approaches the ramp's end value");
    }

    // A 3-point triangle-ish shape: (0,0) -> (0.5,1) -> (1,0).
    {
        std::vector<SampleRegion::LfoBreakpoint> tri(3);
        tri[0].time = 0.0f;  tri[0].value = 0.0f;
        tri[1].time = 0.5f;  tri[1].value = 1.0f;
        tri[2].time = 1.0f;  tri[2].value = 0.0f;
        CHECK_NEAR(evaluateLfoWaveform(tri, 0.0), 0.0, "triangle start");
        CHECK_NEAR(evaluateLfoWaveform(tri, 0.25), 0.5, "triangle rising half-way");
        CHECK_NEAR(evaluateLfoWaveform(tri, 0.5), 1.0, "triangle peak");
        CHECK_NEAR(evaluateLfoWaveform(tri, 0.75), 0.5, "triangle falling half-way");
        CHECK_NEAR(evaluateLfoWaveform(tri, 1.0), 0.0, "triangle end");
    }

    // phase01 is wrapped defensively even outside [0,1).
    {
        std::vector<SampleRegion::LfoBreakpoint> ramp(2);
        ramp[0].time = 0.0f;  ramp[0].value = -1.0f;
        ramp[1].time = 1.0f;  ramp[1].value = 1.0f;
        CHECK_NEAR(evaluateLfoWaveform(ramp, 1.5), evaluateLfoWaveform(ramp, 0.5),
                   "phase01 > 1 wraps the same as its fractional part");
    }
}

// ─── §4 position purity ─────────────────────────────────────────────────────────

static void testPositionPurity()
{
    std::cout << "§4 position purity (identical inputs -> identical output)\n";

    const LfoShape shape = syncShape(8);

    // Call "out of order" (as if from different points in time) to prove there is
    // no accumulation / hidden mutable state: the SAME position always gives the
    // SAME value no matter what was evaluated before it.
    const double posA = 123456;
    const double posB = 7;
    const double posC = 999999;

    const double a1 = evaluateLfoAtPosition(shape, static_cast<int64_t>(posA), kBPM, kSR);
    const double c1 = evaluateLfoAtPosition(shape, static_cast<int64_t>(posC), kBPM, kSR);
    const double b1 = evaluateLfoAtPosition(shape, static_cast<int64_t>(posB), kBPM, kSR);
    const double a2 = evaluateLfoAtPosition(shape, static_cast<int64_t>(posA), kBPM, kSR);
    const double b2 = evaluateLfoAtPosition(shape, static_cast<int64_t>(posB), kBPM, kSR);
    const double c2 = evaluateLfoAtPosition(shape, static_cast<int64_t>(posC), kBPM, kSR);

    CHECK_NEAR(a1, a2, "position A re-evaluated later gives the identical value");
    CHECK_NEAR(b1, b2, "position B re-evaluated later gives the identical value");
    CHECK_NEAR(c1, c2, "position C re-evaluated later gives the identical value");

    // Sweep many positions in a scrambled order and re-check each twice.
    bool stable = true;
    for (int64_t s = 0; s < 50000; s += 3733) {
        const double first  = evaluateLfoAtPosition(shape, s, kBPM, kSR);
        const double second = evaluateLfoAtPosition(shape, s, kBPM, kSR);
        if (!nearly(first, second)) { stable = false; break; }
    }
    CHECK(stable, "evaluation is stateless across a scrambled sweep of positions");
}

// ─── §5 loop-wrap sanity ────────────────────────────────────────────────────────

static void testLoopWrapSanity()
{
    std::cout << "§5 loop-wrap sanity (position vs position + N*cyclePeriod)\n";

    const LfoShape shape = freeShape(250.0); // 4 Hz -> period 0.25s -> 12000 samples @ 48k
    const double hz = lfoCycleHz(shape, kBPM);
    const int64_t cyclePeriodSamples = static_cast<int64_t>(kSR / hz);
    CHECK(cyclePeriodSamples == 12000, "sanity: 4 Hz period @ 48k is exactly 12000 samples");

    for (int64_t basePos : {int64_t(0), int64_t(1234), int64_t(6000), int64_t(11999)}) {
        const double base = evaluateLfoAtPosition(shape, basePos, kBPM, kSR);
        for (int n : {1, 2, 5, 100}) {
            const int64_t wrapped = basePos + static_cast<int64_t>(n) * cyclePeriodSamples;
            const double atWrapped = evaluateLfoAtPosition(shape, wrapped, kBPM, kSR);
            CHECK(nearly(base, atWrapped, 1e-6),
                  "an exact integer number of cycles later reproduces the same value");
        }
    }

    // Same idea for a tempo-synced shape (division=8, hz=4 at 120bpm -> period
    // 0.25s -> 12000 samples @ 48k; see §1's corrected bpm/60 math).
    {
        const LfoShape sync = syncShape(8);
        const double syncHz = lfoCycleHz(sync, kBPM);
        CHECK_NEAR(syncHz, 4.0, "sanity: division=8 @ 120bpm is 4 Hz");
        const int64_t syncPeriod = static_cast<int64_t>(kSR / syncHz);
        const double base = evaluateLfoAtPosition(sync, 4000, kBPM, kSR);
        const double wrapped = evaluateLfoAtPosition(sync, 4000 + 3 * syncPeriod, kBPM, kSR);
        CHECK(nearly(base, wrapped, 1e-6), "tempo-synced shape also wraps cleanly");
    }
}

// ─── §6 end-to-end tremolo mapping ──────────────────────────────────────────────

static void testTremoloMappingWorkedExample()
{
    std::cout << "§6 end-to-end tremolo mapping (base 0.8, depth -0.6)\n";

    // Per the plan's decision #4: the LFO's native output is bipolar [-1,1];
    // rescale to unipolar (v+1)/2 before evaluateModulationMapping. Positive
    // depth swells ABOVE base at the LFO's peak; negative depth dips BELOW base
    // at the peak. So with base=0.8, depth=-0.6:
    //   LFO peak    (bipolar +1 -> unipolar 1) -> base + depth*1 = 0.2
    //   LFO trough  (bipolar -1 -> unipolar 0) -> base + depth*0 = 0.8
    xleth::envmod::ModulationMapping m;
    m.base  = 0.8;
    m.depth = -0.6;

    const double peakBipolar   = 1.0;
    const double troughBipolar = -1.0;
    const double peakUnipolar   = (peakBipolar + 1.0) * 0.5;
    const double troughUnipolar = (troughBipolar + 1.0) * 0.5;
    CHECK_NEAR(peakUnipolar, 1.0, "bipolar +1 rescales to unipolar 1");
    CHECK_NEAR(troughUnipolar, 0.0, "bipolar -1 rescales to unipolar 0");

    const double atPeak   = xleth::envmod::evaluateModulationMapping(m, peakUnipolar);
    const double atTrough = xleth::envmod::evaluateModulationMapping(m, troughUnipolar);

    CHECK_NEAR(atPeak, 0.2, "at the LFO's peak the parameter dips to base + depth*1 = 0.2");
    CHECK_NEAR(atTrough, 0.8, "at the LFO's trough the parameter sits at base + depth*0 = 0.8 (base)");
    CHECK(atPeak < atTrough, "negative depth: the LFO's peak is the LOW point of the parameter swing");
}

// ─── §7 graphState parse ────────────────────────────────────────────────────────

static nlohmann::json makeGraphState(const nlohmann::json& mapping,
                                     const nlohmann::json& lfoData = nlohmann::json::object(),
                                     bool readOnlyPort = false,
                                     bool automatable = true)
{
    nlohmann::json port = {
        {"parameterId", "gain"},
        {"automatable", automatable},
    };
    if (readOnlyPort) port["readOnly"] = true;

    nlohmann::json lfoNode = {
        {"id", "lfo-1"},
        {"type", "lfo"},
        {"data", lfoData},
    };

    nlohmann::json effectNode = {
        {"id", "node-fx"},
        {"type", "effect"},
        {"data", {
            {"effectInstanceId", "fx-abc"},
            {"exposedParameterPorts", nlohmann::json::array({port})},
        }},
    };

    nlohmann::json edge = {
        {"id", "edge-1"},
        {"type", "parameter"},
        {"sourceNodeId", "lfo-1"},
        {"sourcePort", "controlOut"},
        {"targetNodeId", "node-fx"},
        {"targetParameter", {
            {"kind", "graph-parameter"},
            {"graphNodeId", "node-fx"},
            {"effectInstanceId", "fx-abc"},
            {"parameterId", "gain"},
        }},
        {"mapping", mapping},
    };

    return nlohmann::json{
        {"version", 1},
        {"trackId", 3},
        {"nodes", nlohmann::json::array({lfoNode, effectNode})},
        {"edges", nlohmann::json::array({edge})},
    };
}

static nlohmann::json modulationMapping(double base, double depth)
{
    return nlohmann::json{
        {"kind", "modulation"},
        {"enabled", true},
        {"base", base},
        {"depth", depth},
        {"sourceMin", 0.0},
        {"sourceMax", 1.0},
        {"curve", {{"type", "linear"}}},
    };
}

static void testGraphStateParse()
{
    std::cout << "§7 parseGraphStateLfoNodes: parse + skip semantics\n";

    // Happy path.
    {
        const auto parsed = parseGraphStateLfoNodes(makeGraphState(modulationMapping(0.3, 0.5)));
        CHECK(parsed.lfos.size() == 1, "one LFO node parsed");
        CHECK(parsed.lfos[0].nodeId == "lfo-1", "node id captured");
        CHECK(parsed.lfos[0].edges.size() == 1, "one resolved edge");
        CHECK(parsed.skipped.empty(), "nothing skipped");

        const auto& edge = parsed.lfos[0].edges[0];
        CHECK(edge.effectInstanceId == "fx-abc", "addressed by stable effectInstanceId");
        CHECK(edge.parameterId == "gain", "parameterId captured");
        CHECK_NEAR(edge.mapping.base, 0.3, "base parsed");
        CHECK_NEAR(edge.mapping.depth, 0.5, "depth parsed");
    }

    // LFO shape comes from the node data.
    {
        const auto parsed = parseGraphStateLfoNodes(makeGraphState(
            modulationMapping(0.0, 1.0),
            nlohmann::json{{"rateMode", "sync"}, {"syncDivision", 16}, {"phaseOffset", 0.25}}));
        CHECK(parsed.lfos.size() == 1, "LFO parsed with data");
        CHECK(parsed.lfos[0].shape.rateMode == RateMode::Sync, "rateMode from node data");
        CHECK(parsed.lfos[0].shape.syncDivision == 16, "syncDivision from node data");
        CHECK_NEAR(parsed.lfos[0].shape.phaseOffset, 0.25, "phaseOffset from node data");
    }

    // Malformed/missing fields fall back to defaults.
    {
        const LfoShape fromNull = normalizeLfoShape(nlohmann::json());
        CHECK(fromNull.rateMode == RateMode::Free, "default rateMode is Free");
        CHECK_NEAR(fromNull.rateMs, 250.0, "default rateMs");
        CHECK(fromNull.syncDivision == 4, "default syncDivision");
        CHECK_NEAR(fromNull.phaseOffset, 0.0, "default phaseOffset");
        CHECK(fromNull.waveform.empty(), "default waveform is empty (sine fallback)");

        const LfoShape repaired = normalizeLfoShape(nlohmann::json{
            {"rateMs", -5.0}, {"syncDivision", "nope"}, {"phaseOffset", 99.0}});
        CHECK_NEAR(repaired.rateMs, 250.0, "negative rateMs repairs to default");
        CHECK(repaired.syncDivision == 4, "non-numeric syncDivision repairs to default");
        CHECK_NEAR(repaired.phaseOffset, 1.0, "out-of-range phaseOffset clamps to 1");

        const LfoShape notSync = normalizeLfoShape(nlohmann::json{{"rateMode", "banana"}});
        CHECK(notSync.rateMode == RateMode::Free, "an unrecognized rateMode string is Free, not Sync");
    }

    // ── skip semantics (mirrors §7 of the envelope test) ──
    // disabled
    {
        auto mapping = modulationMapping(0.5, 0.5);
        mapping["enabled"] = false;
        const auto parsed = parseGraphStateLfoNodes(makeGraphState(mapping));
        CHECK(parsed.lfos[0].edges.empty(), "disabled edge produces no write");
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == xleth::envmod::EdgeSkipReason::Disabled,
              "reason: disabled");
    }

    // read_only
    {
        const auto parsed = parseGraphStateLfoNodes(
            makeGraphState(modulationMapping(0.5, 0.5), nlohmann::json::object(), true, true));
        CHECK(parsed.lfos[0].edges.empty(), "read-only port produces no write");
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == xleth::envmod::EdgeSkipReason::ReadOnly,
              "reason: read_only");
    }

    // automatable === false is also read_only
    {
        const auto parsed = parseGraphStateLfoNodes(
            makeGraphState(modulationMapping(0.5, 0.5), nlohmann::json::object(), false, false));
        CHECK(parsed.lfos[0].edges.empty(), "non-automatable port produces no write");
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == xleth::envmod::EdgeSkipReason::ReadOnly,
              "reason: read_only (automatable false)");
    }

    // invalid_target — wrong target kind
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["edges"][0]["targetParameter"]["kind"] = "not-a-graph-parameter";
        const auto parsed = parseGraphStateLfoNodes(gs);
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == xleth::envmod::EdgeSkipReason::InvalidTarget,
              "reason: invalid_target (bad kind)");
    }

    // invalid_target — a fallback parameterId with no usable index
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["edges"][0]["targetParameter"]["parameterIdIsFallback"] = true;
        const auto parsed = parseGraphStateLfoNodes(gs);
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == xleth::envmod::EdgeSkipReason::InvalidTarget,
              "reason: invalid_target (fallback without index)");
    }

    // missing_node
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["edges"][0]["targetParameter"]["graphNodeId"] = "node-gone";
        const auto parsed = parseGraphStateLfoNodes(gs);
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == xleth::envmod::EdgeSkipReason::MissingNode,
              "reason: missing_node");
    }

    // missing_effect_instance
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["nodes"][1]["data"]["effectInstanceId"] = "fx-different";
        const auto parsed = parseGraphStateLfoNodes(gs);
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == xleth::envmod::EdgeSkipReason::MissingEffectInstance,
              "reason: missing_effect_instance");
    }

    // missing_exposed_port
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["nodes"][1]["data"]["exposedParameterPorts"] = nlohmann::json::array();
        const auto parsed = parseGraphStateLfoNodes(gs);
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == xleth::envmod::EdgeSkipReason::MissingExposedPort,
              "reason: missing_exposed_port");
    }

    // A non-LFO-sourced parameter edge (e.g. a Macro or Envelope edge) is never
    // adopted or reported by this parser.
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["edges"][0]["sourceNodeId"] = "macro-1";
        const auto parsed = parseGraphStateLfoNodes(gs);
        CHECK(parsed.lfos.size() == 1, "the LFO node is still found");
        CHECK(parsed.lfos[0].edges.empty(), "a macro-sourced edge is not adopted");
        CHECK(parsed.skipped.empty(), "a macro-sourced edge is not even reported");
    }

    // Audio edges from the LFO node are ignored.
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["edges"][0]["type"] = "audio";
        const auto parsed = parseGraphStateLfoNodes(gs);
        CHECK(parsed.lfos[0].edges.empty(), "audio edge is not a modulation edge");
        CHECK(parsed.skipped.empty(), "audio edge is not reported as skipped");
    }

    // Malformed input yields an empty result rather than throwing.
    CHECK(parseGraphStateLfoNodes(nlohmann::json()).lfos.empty(), "null graphState");
    CHECK(parseGraphStateLfoNodes(nlohmann::json::array()).lfos.empty(), "array graphState");
    CHECK(parseGraphStateLfoNodes(nlohmann::json{{"nodes", 5}}).lfos.empty(), "non-array nodes");
    CHECK(parseGraphStateLfoNodes(
              nlohmann::json{{"nodes", nlohmann::json::array({nlohmann::json{{"id", "l"},
                                                                            {"type", "lfo"}}})}})
              .lfos.size() == 1,
          "an LFO node with no data and no edges still parses");

    // A track with no LFO node yields nothing.
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["nodes"][0]["type"] = "macro";
        const auto parsed = parseGraphStateLfoNodes(gs);
        CHECK(parsed.lfos.empty(), "no LFO node, no definitions");
    }
}

// ─── main ─────────────────────────────────────────────────────────────────────

int main()
{
    std::cout << "=== test_lfo_parameter_modulation ===\n";

    testTempoSyncDirection();
    testMultiBarSyncDivisions();
    testPhaseOffset();
    testFreeModeRate();
    testWaveformEvaluation();
    testPositionPurity();
    testLoopWrapSanity();
    testTremoloMappingWorkedExample();
    testGraphStateParse();

    std::cout << "\npassed: " << g_passed << "  failed: " << g_failed << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    return 1;
}
