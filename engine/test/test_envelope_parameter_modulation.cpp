// test_envelope_parameter_modulation.cpp
// Unit tests for the pure engine-side Envelope Controller evaluator
// (model/EnvelopeParameterModulation.h).
//
// This is the evaluator that REPLACED the renderer-side one
// (ui/src/fxgraph/envelopeModulation.js). Every semantic assertion below is
// therefore also a parity assertion against the behavior the renderer shipped:
// gate-region merge, restart-only retrigger, release-from-actual-level, the
// EVC-R4 base + signed-depth mapping, and the skip semantics of
// collectEnvelopeParameterWrites.
//
// Coverage map:
//   §1  shape normalization (clamps, closed schema, retired fields dropped)
//   §2  ms -> samples (the authored unit domain is preserved)
//   §3  levelWhileHeld / evaluateEnvelopeAdsr (all stages, zero-duration safety)
//   §4  gate-interval merge + chord collapse + restart retrigger
//   §5  gate resolution in the sample domain (play-start, mid-gate, release tail)
//   §6  the modulation mapping (base+depth, negative depth, clamping, curve)
//   §7  graphState parse + skip semantics + the legacy range-mapping migration
//
// Build target: test_envelope_parameter_modulation  (engine/CMakeLists.txt)
// Pass: prints "ALL TESTS PASSED" and exits 0.

#include "model/EnvelopeParameterModulation.h"

#include <cmath>
#include <iostream>
#include <string>
#include <vector>

using namespace xleth::envmod;

// ─── Minimal harness ──────────────────────────────────────────────────────────

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

// A round sample rate and tempo so tick<->sample math is exact in the tests:
// at 120 bpm a quarter note is 0.5 s, so 1 tick = 0.5/960 s = 25 samples at 48000.
static constexpr double kSR  = 48000.0;
static constexpr double kBPM = 120.0;
static constexpr int64_t kSamplesPerTick = 25;

// ─── §1 shape normalization ───────────────────────────────────────────────────

static void testShapeNormalization()
{
    std::cout << "§1 shape normalization\n";

    // Defaults for a completely absent / non-object data blob.
    const EnvelopeShape fromNull = normalizeEnvelopeShape(nlohmann::json());
    CHECK_NEAR(fromNull.attackMs, 10.0, "default attackMs");
    CHECK_NEAR(fromNull.holdMs, 0.0, "default holdMs");
    CHECK_NEAR(fromNull.decayMs, 120.0, "default decayMs");
    CHECK_NEAR(fromNull.sustain, 0.7, "default sustain");
    CHECK_NEAR(fromNull.releaseMs, 200.0, "default releaseMs");
    CHECK(!fromNull.includeSlideNotes, "default includeSlideNotes is false");

    // Provided values survive.
    const EnvelopeShape ok = normalizeEnvelopeShape(nlohmann::json{
        {"attackMs", 5.0}, {"holdMs", 12.0}, {"decayMs", 30.0},
        {"sustain", 0.25}, {"releaseMs", 400.0}, {"includeSlideNotes", true}});
    CHECK_NEAR(ok.attackMs, 5.0, "attackMs kept");
    CHECK_NEAR(ok.holdMs, 12.0, "holdMs kept");
    CHECK_NEAR(ok.decayMs, 30.0, "decayMs kept");
    CHECK_NEAR(ok.sustain, 0.25, "sustain kept");
    CHECK_NEAR(ok.releaseMs, 400.0, "releaseMs kept");
    CHECK(ok.includeSlideNotes, "includeSlideNotes opt-in honored");

    // Negative / wrong-typed ms repairs to the default; sustain clamps.
    const EnvelopeShape repaired = normalizeEnvelopeShape(nlohmann::json{
        {"attackMs", -4.0}, {"decayMs", "nope"}, {"sustain", 3.5},
        {"releaseMs", nullptr}});
    CHECK_NEAR(repaired.attackMs, 10.0, "negative attackMs repairs to default");
    CHECK_NEAR(repaired.decayMs, 120.0, "non-numeric decayMs repairs to default");
    CHECK_NEAR(repaired.sustain, 1.0, "sustain clamps to 1");
    CHECK_NEAR(repaired.releaseMs, 200.0, "null releaseMs repairs to default");

    const EnvelopeShape negSustain = normalizeEnvelopeShape(nlohmann::json{{"sustain", -2.0}});
    CHECK_NEAR(negSustain.sustain, 0.0, "sustain clamps to 0");

    // includeSlideNotes is only a literal boolean true (mirrors `=== true`).
    CHECK(!normalizeEnvelopeShape(nlohmann::json{{"includeSlideNotes", 1}}).includeSlideNotes,
          "includeSlideNotes: 1 is not true");
    CHECK(!normalizeEnvelopeShape(nlohmann::json{{"includeSlideNotes", "true"}}).includeSlideNotes,
          "includeSlideNotes: \"true\" is not true");

    // Zero is a legal ms value (instant stage), not a missing one.
    CHECK_NEAR(normalizeEnvelopeShape(nlohmann::json{{"attackMs", 0.0}}).attackMs, 0.0,
               "attackMs 0 is legal");
}

// ─── §2 ms -> samples ─────────────────────────────────────────────────────────

static void testShapeToSamples()
{
    std::cout << "§2 ms -> samples\n";

    EnvelopeShape shape;
    shape.attackMs  = 10.0;
    shape.holdMs    = 0.0;
    shape.decayMs   = 120.0;
    shape.sustain   = 0.5;
    shape.releaseMs = 200.0;

    const EnvelopeShapeSamples at48k = envelopeShapeToSamples(shape, 48000.0);
    CHECK_NEAR(at48k.attack, 480.0, "10 ms @ 48k = 480 samples");
    CHECK_NEAR(at48k.decay, 5760.0, "120 ms @ 48k = 5760 samples");
    CHECK_NEAR(at48k.release, 9600.0, "200 ms @ 48k = 9600 samples");
    CHECK_NEAR(at48k.sustain, 0.5, "sustain passes through");

    // The authored domain is MILLISECONDS: the same shape at a different rate is
    // the same real time, and tempo is not an input at all (no bpm parameter).
    const EnvelopeShapeSamples at44k = envelopeShapeToSamples(shape, 44100.0);
    CHECK_NEAR(at44k.attack, 441.0, "10 ms @ 44.1k = 441 samples");
    CHECK_NEAR(at48k.attack / 48000.0, at44k.attack / 44100.0,
               "attack is the same real duration at both rates");

    // Degenerate sample rate must not produce NaN/Inf.
    const EnvelopeShapeSamples bad = envelopeShapeToSamples(shape, 0.0);
    CHECK_NEAR(bad.attack, 0.0, "zero sample rate yields zero-length stages");
    CHECK_NEAR(bad.sustain, 0.5, "zero sample rate still carries sustain");
}

// ─── §3 ADSR ──────────────────────────────────────────────────────────────────

static EnvelopeShapeSamples makeShape(double a, double h, double d, double s, double r)
{
    EnvelopeShapeSamples shape;
    shape.attack  = a;
    shape.hold    = h;
    shape.decay   = d;
    shape.sustain = s;
    shape.release = r;
    return shape;
}

static ResolvedGate gateAt(int64_t start, int64_t end)
{
    ResolvedGate gate;
    gate.valid           = true;
    gate.gateStartSample = start;
    gate.gateEndSample   = end;
    return gate;
}

static void testLevelWhileHeld()
{
    std::cout << "§3 levelWhileHeld / evaluateEnvelopeAdsr\n";

    // A=100, H=50, D=200, S=0.4, R=400
    const auto shape = makeShape(100, 50, 200, 0.4, 400);

    CHECK_NEAR(levelWhileHeld(shape, 0.0), 0.0, "held 0 with attack > 0 starts at 0");
    CHECK_NEAR(levelWhileHeld(shape, 50.0), 0.5, "mid-attack is linear");
    CHECK_NEAR(levelWhileHeld(shape, 100.0), 1.0, "attack end plateaus at 1 (hold)");
    CHECK_NEAR(levelWhileHeld(shape, 140.0), 1.0, "mid-hold stays at 1");
    CHECK_NEAR(levelWhileHeld(shape, 150.0), 1.0, "decay start is still 1");
    CHECK_NEAR(levelWhileHeld(shape, 250.0), 0.7, "mid-decay is halfway to sustain");
    CHECK_NEAR(levelWhileHeld(shape, 350.0), 0.4, "decay end reaches sustain");
    CHECK_NEAR(levelWhileHeld(shape, 10000.0), 0.4, "sustain plateaus");

    // Zero-duration stage safety (no divide-by-zero, no NaN).
    const auto instant = makeShape(0, 0, 0, 0.6, 0);
    CHECK_NEAR(levelWhileHeld(instant, 0.0), 0.6, "all-instant: held 0 is sustain");
    CHECK_NEAR(levelWhileHeld(instant, 500.0), 0.6, "all-instant: sustain thereafter");

    const auto instantAttackWithHold = makeShape(0, 100, 0, 0.3, 0);
    CHECK_NEAR(levelWhileHeld(instantAttackWithHold, 0.0), 1.0,
               "instant attack with hold: held 0 snaps to 1");

    const auto instantAttackNoHold = makeShape(0, 0, 100, 0.3, 0);
    CHECK_NEAR(levelWhileHeld(instantAttackNoHold, 0.0), 1.0,
               "instant attack with decay: held 0 snaps to 1");
    CHECK_NEAR(levelWhileHeld(instantAttackNoHold, 50.0), 0.65,
               "instant attack then decay is linear to sustain");

    // Release falls from the level ACTUALLY reached, not from sustain.
    // Gate [1000, 1050) is 50 samples long -> mid-attack, level 0.5 at gate end.
    const ResolvedGate shortGate = gateAt(1000, 1050);
    CHECK_NEAR(evaluateEnvelopeAdsr(shape, shortGate, 1050), 0.5,
               "release begins from the actual attack level");
    CHECK_NEAR(evaluateEnvelopeAdsr(shape, shortGate, 1250), 0.25,
               "release decays linearly from the actual level");
    CHECK_NEAR(evaluateEnvelopeAdsr(shape, shortGate, 1450), 0.0,
               "release completes to 0");
    CHECK_NEAR(evaluateEnvelopeAdsr(shape, shortGate, 5000), 0.0,
               "past release is 0");

    // Before the gate is 0; an invalid gate is 0.
    CHECK_NEAR(evaluateEnvelopeAdsr(shape, shortGate, 999), 0.0, "before gate start is 0");
    CHECK_NEAR(evaluateEnvelopeAdsr(shape, ResolvedGate{}, 1000), 0.0, "invalid gate is 0");

    // Zero release snaps to 0 the instant the gate closes.
    const auto noRelease = makeShape(100, 0, 0, 1.0, 0);
    CHECK_NEAR(evaluateEnvelopeAdsr(noRelease, gateAt(0, 200), 199), 1.0,
               "held level just before gate end");
    CHECK_NEAR(evaluateEnvelopeAdsr(noRelease, gateAt(0, 200), 200), 0.0,
               "zero release snaps to 0 at gate end");

    // A gate long enough to sustain, then release from sustain.
    const ResolvedGate longGate = gateAt(0, 1000);
    CHECK_NEAR(evaluateEnvelopeAdsr(shape, longGate, 999), 0.4, "long gate sustains");
    CHECK_NEAR(evaluateEnvelopeAdsr(shape, longGate, 1200), 0.2,
               "release from sustain is half-way at half the release");
}

// ─── §4 gate merge ────────────────────────────────────────────────────────────

static void testGateMerge()
{
    std::cout << "§4 gate merge / chord collapse / restart\n";

    // Two disjoint gates stay two regions.
    {
        const GateTimeline t = buildGateTimeline({{0, 100}, {200, 300}});
        CHECK(t.regions.size() == 2, "disjoint gates make 2 regions");
        CHECK(t.regions[0].start == 0 && t.regions[0].end == 100, "region 0 bounds");
        CHECK(t.regions[1].start == 200 && t.regions[1].end == 300, "region 1 bounds");
    }

    // Overlapping gates merge and the region stays open until the LAST one ends.
    {
        const GateTimeline t = buildGateTimeline({{0, 100}, {50, 400}, {80, 120}});
        CHECK(t.regions.size() == 1, "overlapping gates merge into 1 region");
        CHECK(t.regions[0].end == 400, "merged region ends with the last gate");
        CHECK(t.regions[0].startCount == 3, "all three onsets recorded");
    }

    // A gate that opens exactly when another closes begins a NEW region
    // (momentary close + reopen), matching the renderer's `start < end` rule.
    {
        const GateTimeline t = buildGateTimeline({{0, 100}, {100, 200}});
        CHECK(t.regions.size() == 2, "abutting gates do NOT merge");
    }

    // Same-tick chord starts collapse into ONE onset.
    {
        const GateTimeline t = buildGateTimeline({{480, 960}, {480, 960}, {480, 960}});
        CHECK(t.regions.size() == 1, "chord is one region");
        CHECK(t.regions[0].startCount == 1, "same-tick chord collapses to one trigger");
    }

    // Unsorted input is sorted first.
    {
        const GateTimeline t = buildGateTimeline({{500, 600}, {0, 100}, {200, 250}});
        CHECK(t.regions.size() == 3, "unsorted input still yields 3 regions");
        CHECK(t.regions[0].start == 0 && t.regions[2].start == 500, "regions are sorted");
    }

    // Zero-length gates are legal (a gate with no duration).
    {
        const GateTimeline t = buildGateTimeline({{100, 100}});
        CHECK(t.regions.size() == 1, "zero-length gate is a region");
        CHECK(t.regions[0].start == 100 && t.regions[0].end == 100, "zero-length bounds");
    }

    CHECK(buildGateTimeline({}).regions.empty(), "no intervals yields no regions");
}

// ─── §5 gate resolution in the sample domain ──────────────────────────────────

static void testGateResolution()
{
    std::cout << "§5 gate resolution (sample domain)\n";

    // Gates at ticks [0,480) and [960,1440). At 120 bpm / 48 kHz one tick is 25
    // samples, so these are samples [0,12000) and [24000,36000).
    const GateTimeline timeline = buildGateTimeline({{0, 480}, {960, 1440}});
    const EnvelopeGateView gates = makeGateView(timeline);

    CHECK(tickToSample(480, kBPM, kSR) == 480 * kSamplesPerTick, "tickToSample is exact here");

    // PLAY-START: the very first rendered sample already resolves the gate that
    // starts there. This is the renderer's ~250 ms dead zone, gone by construction.
    {
        const ResolvedGate g = resolveActiveGateAtSample(gates, 0, kBPM, kSR);
        CHECK(g.valid, "sample 0 resolves the gate starting at tick 0");
        CHECK(g.gateStartSample == 0, "gate start is sample 0");
        CHECK(g.gateEndSample == 12000, "gate end is sample 12000");
    }

    // Mid-gate.
    {
        const ResolvedGate g = resolveActiveGateAtSample(gates, 6000, kBPM, kSR);
        CHECK(g.valid && g.gateStartSample == 0 && g.gateEndSample == 12000,
              "mid-gate resolves the containing region");
    }

    // In the release tail: the most recent ENDED region still governs, so the
    // tail is evaluated instead of being cut to 0.
    {
        const ResolvedGate g = resolveActiveGateAtSample(gates, 15000, kBPM, kSR);
        CHECK(g.valid && g.gateStartSample == 0 && g.gateEndSample == 12000,
              "between gates the previous region still governs its release tail");
    }

    // Second gate takes over the moment it starts.
    {
        const ResolvedGate g = resolveActiveGateAtSample(gates, 24000, kBPM, kSR);
        CHECK(g.valid && g.gateStartSample == 24000 && g.gateEndSample == 36000,
              "the second gate governs from its first sample");
    }

    // Before the first gate: nothing has begun.
    {
        const GateTimeline later = buildGateTimeline({{960, 1440}});
        const ResolvedGate g = resolveActiveGateAtSample(makeGateView(later), 0, kBPM, kSR);
        CHECK(!g.valid, "before any gate there is no active gate");
    }

    // RESTART-ONLY retrigger: inside a merged region, the latest onset at/before
    // the query is the attack origin. Gates [0,960) and [480,1440) merge into
    // [0,1440) with onsets {0, 480}.
    {
        const GateTimeline merged = buildGateTimeline({{0, 960}, {480, 1440}});
        const EnvelopeGateView view = makeGateView(merged);

        const ResolvedGate before = resolveActiveGateAtSample(view, 100, kBPM, kSR);
        CHECK(before.gateStartSample == 0, "before the second onset, attack origin is onset 0");

        const ResolvedGate after = resolveActiveGateAtSample(view, 480 * kSamplesPerTick, kBPM, kSR);
        CHECK(after.gateStartSample == 480 * kSamplesPerTick,
              "the second onset restarts the attack");
        CHECK(after.gateEndSample == 1440 * kSamplesPerTick,
              "the merged region stays open until the last gate ends");

        // Once the region has fully ended, the release falls from the LAST onset.
        const ResolvedGate ended = resolveActiveGateAtSample(view, 2000 * kSamplesPerTick, kBPM, kSR);
        CHECK(ended.gateStartSample == 480 * kSamplesPerTick,
              "after the region ends, the last onset is the attack origin");
    }

    // Empty timeline and a degenerate transport must not resolve or crash.
    CHECK(!resolveActiveGateAtSample(EnvelopeGateView{}, 0, kBPM, kSR).valid,
          "empty gate view resolves nothing");
    CHECK(!resolveActiveGateAtSample(gates, 0, 0.0, kSR).valid, "zero bpm resolves nothing");
    CHECK(!resolveActiveGateAtSample(gates, 0, kBPM, 0.0).valid, "zero rate resolves nothing");

    // Binary search must agree with a linear scan over many regions.
    {
        std::vector<GateInterval> many;
        for (int i = 0; i < 200; ++i)
            many.push_back({i * 960LL, i * 960LL + 480LL});
        const GateTimeline t = buildGateTimeline(many);
        const EnvelopeGateView view = makeGateView(t);
        CHECK(t.regions.size() == 200, "200 disjoint gates");

        bool allMatch = true;
        for (int i = 0; i < 200; ++i) {
            const int64_t query = tickToSample(i * 960LL + 100LL, kBPM, kSR);
            const ResolvedGate g = resolveActiveGateAtSample(view, query, kBPM, kSR);
            if (!g.valid || g.gateStartSample != tickToSample(i * 960LL, kBPM, kSR)) {
                allMatch = false;
                break;
            }
        }
        CHECK(allMatch, "binary search resolves every region correctly");
    }
}

// ─── §5b loop-wrap behavior ───────────────────────────────────────────────────

static void testLoopWrapIsPositionPure()
{
    std::cout << "§5b loop wrap / seek (position purity)\n";

    // One gate per loop iteration: [0,480) and [1920,2400) with the loop window
    // being ticks [0, 1920). The evaluator is a pure function of position, so a
    // wrap back to 0 evaluates exactly as the first pass did — the envelope
    // cannot over-run past the wrap, and it cannot lag into it either.
    const GateTimeline t = buildGateTimeline({{0, 480}, {1920, 2400}});
    const EnvelopeGateView gates = makeGateView(t);
    const auto shape = envelopeShapeToSamples(
        [] { EnvelopeShape s; s.attackMs = 10; s.holdMs = 0; s.decayMs = 0;
             s.sustain = 1.0; s.releaseMs = 50; return s; }(), kSR);

    const int64_t loopEnd = tickToSample(1920, kBPM, kSR);

    // Just before the wrap the previous gate's release is long finished.
    CHECK_NEAR(evaluateEnvelopeAtSample(shape, gates, loopEnd - 1, kBPM, kSR), 0.0,
               "envelope is at rest at the end of the loop");

    // After the wrap the transport position is back at 0, so the envelope is
    // back at the start of the first gate — the same value it had on pass 1.
    const double atZero  = evaluateEnvelopeAtSample(shape, gates, 0, kBPM, kSR);
    const double atAttack = evaluateEnvelopeAtSample(shape, gates, 240, kBPM, kSR);
    CHECK_NEAR(atZero, 0.0, "wrapped position 0 restarts the attack at 0");
    CHECK_NEAR(atAttack, 0.5, "wrapped position mid-attack matches pass 1");

    // Phase continuity: any position evaluates identically no matter how many
    // times the transport has wrapped through it (no accumulated state).
    bool stable = true;
    for (int64_t s = 0; s < loopEnd; s += 997) {
        const double first  = evaluateEnvelopeAtSample(shape, gates, s, kBPM, kSR);
        const double second = evaluateEnvelopeAtSample(shape, gates, s, kBPM, kSR);
        if (!nearly(first, second)) { stable = false; break; }
    }
    CHECK(stable, "evaluation is stateless: repeated reads at one position agree");

    // SEEK into a held gate: the phase is measured from the gate's real start,
    // not from the seek point, so landing mid-gate gives the mid-gate level.
    const GateTimeline held = buildGateTimeline({{0, 9600}});
    const auto sustainShape = envelopeShapeToSamples(
        [] { EnvelopeShape s; s.attackMs = 10; s.holdMs = 0; s.decayMs = 0;
             s.sustain = 0.8; s.releaseMs = 100; return s; }(), kSR);
    const double afterSeek =
        evaluateEnvelopeAtSample(sustainShape, makeGateView(held), 100000, kBPM, kSR);
    CHECK_NEAR(afterSeek, 0.8, "seeking into a held gate lands on its sustain level");
}

// ─── §6 modulation mapping ────────────────────────────────────────────────────

static void testModulationMapping()
{
    std::cout << "§6 modulation mapping (base + signed depth)\n";

    // Default: base 0, depth +1 -> identity.
    {
        ModulationMapping m;
        CHECK_NEAR(evaluateModulationMapping(m, 0.0), 0.0, "default at env 0");
        CHECK_NEAR(evaluateModulationMapping(m, 0.5), 0.5, "default at env 0.5");
        CHECK_NEAR(evaluateModulationMapping(m, 1.0), 1.0, "default at env 1");
    }

    // env == 0 returns EXACTLY base, whatever the depth. This is the property
    // that makes a stopped or idle envelope inert instead of destructive.
    {
        ModulationMapping m;
        m.base = 0.42;
        for (double depth : {-1.0, -0.5, 0.0, 0.3, 1.0}) {
            m.depth = depth;
            CHECK_NEAR(evaluateModulationMapping(m, 0.0), 0.42,
                       "env 0 is exactly base regardless of depth");
        }
    }

    // Positive depth offsets upward from base.
    {
        ModulationMapping m;
        m.base  = 0.2;
        m.depth = 0.5;
        CHECK_NEAR(evaluateModulationMapping(m, 0.5), 0.45, "base + depth*env");
        CHECK_NEAR(evaluateModulationMapping(m, 1.0), 0.7, "full travel");
    }

    // NEGATIVE depth inverts: the envelope pulls the parameter DOWN from base.
    {
        ModulationMapping m;
        m.base  = 0.8;
        m.depth = -0.6;
        CHECK_NEAR(evaluateModulationMapping(m, 0.0), 0.8, "negative depth at env 0 is base");
        CHECK_NEAR(evaluateModulationMapping(m, 0.5), 0.5, "negative depth pulls down");
        CHECK_NEAR(evaluateModulationMapping(m, 1.0), 0.2, "negative depth full travel");
    }

    // CLAMPING at both rails.
    {
        ModulationMapping m;
        m.base  = 0.9;
        m.depth = 1.0;
        CHECK_NEAR(evaluateModulationMapping(m, 1.0), 1.0, "clamps at the top rail");
        CHECK_NEAR(evaluateModulationMapping(m, 0.5), 1.0, "clamps mid-travel too");

        m.base  = 0.1;
        m.depth = -1.0;
        CHECK_NEAR(evaluateModulationMapping(m, 1.0), 0.0, "clamps at the bottom rail");
        CHECK_NEAR(evaluateModulationMapping(m, 0.5), 0.0, "clamps mid-travel at the bottom");
    }

    // A zero depth disconnects the modulation audibly without removing the edge.
    {
        ModulationMapping m;
        m.base  = 0.33;
        m.depth = 0.0;
        CHECK_NEAR(evaluateModulationMapping(m, 1.0), 0.33, "zero depth is a constant base");
    }

    // Source window shapes the INPUT, not the output.
    {
        ModulationMapping m;
        m.sourceMin = 0.5;
        m.sourceMax = 1.0;
        CHECK_NEAR(evaluateModulationMapping(m, 0.5), 0.0, "window start maps to 0");
        CHECK_NEAR(evaluateModulationMapping(m, 0.75), 0.5, "window mid maps to 0.5");
        CHECK_NEAR(evaluateModulationMapping(m, 1.0), 1.0, "window end maps to 1");
        CHECK_NEAR(evaluateModulationMapping(m, 0.25), 0.0, "below the window clamps to 0");
    }

    // A degenerate window steps instead of dividing by zero.
    {
        ModulationMapping m;
        m.sourceMin = 0.5;
        m.sourceMax = 0.5;
        CHECK_NEAR(evaluateModulationMapping(m, 0.4), 0.0, "below the step threshold");
        CHECK_NEAR(evaluateModulationMapping(m, 0.5), 1.0, "at/above the step threshold");
    }

    // Bezier curve: monotone, hits both endpoints, and is an S-curve in between.
    {
        ModulationMapping m;
        m.curve = MappingCurve::Bezier;
        m.cp1x = 0.4; m.cp1y = 0.0;
        m.cp2x = 0.6; m.cp2y = 1.0;
        CHECK_NEAR(evaluateBezierCurve(m, 0.0), 0.0, "bezier at 0");
        CHECK_NEAR(evaluateBezierCurve(m, 1.0), 1.0, "bezier at 1");
        CHECK(nearly(evaluateBezierCurve(m, 0.5), 0.5, 1e-6), "symmetric S-curve is 0.5 at 0.5");
        CHECK(evaluateBezierCurve(m, 0.25) < 0.25, "ease-in below the diagonal");
        CHECK(evaluateBezierCurve(m, 0.75) > 0.75, "ease-out above the diagonal");

        bool monotone = true;
        double prev = -1.0;
        for (int i = 0; i <= 100; ++i) {
            const double v = evaluateBezierCurve(m, i / 100.0);
            if (v < prev - 1e-9) { monotone = false; break; }
            prev = v;
        }
        CHECK(monotone, "bezier is monotone across the travel");

        // Applied through the mapping, env 0 must still be exactly base.
        m.base  = 0.25;
        m.depth = 0.5;
        CHECK_NEAR(evaluateModulationMapping(m, 0.0), 0.25, "bezier at env 0 is exactly base");
        CHECK_NEAR(evaluateModulationMapping(m, 1.0), 0.75, "bezier at env 1 is base + depth");
    }
}

// ─── §7 graphState parse ──────────────────────────────────────────────────────

// Builds a graphState with one envelope node driving one exposed parameter on one
// effect node. `overrides` are merged onto the edge's mapping.
static nlohmann::json makeGraphState(const nlohmann::json& mapping,
                                     const nlohmann::json& envelopeData = nlohmann::json::object(),
                                     bool readOnlyPort = false,
                                     bool automatable = true)
{
    nlohmann::json port = {
        {"parameterId", "gain"},
        {"automatable", automatable},
    };
    if (readOnlyPort) port["readOnly"] = true;

    nlohmann::json envelopeNode = {
        {"id", "env-1"},
        {"type", "envelope"},
        {"data", envelopeData},
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
        {"sourceNodeId", "env-1"},
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
        {"nodes", nlohmann::json::array({envelopeNode, effectNode})},
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
    std::cout << "§7 graphState parse + skip semantics\n";

    // Happy path.
    {
        const auto parsed = parseGraphStateEnvelopes(makeGraphState(modulationMapping(0.3, 0.5)));
        CHECK(parsed.envelopes.size() == 1, "one envelope node parsed");
        CHECK(parsed.envelopes[0].nodeId == "env-1", "node id captured");
        CHECK(parsed.envelopes[0].edges.size() == 1, "one resolved edge");
        CHECK(parsed.skipped.empty(), "nothing skipped");

        const auto& edge = parsed.envelopes[0].edges[0];
        CHECK(edge.effectInstanceId == "fx-abc", "addressed by stable effectInstanceId");
        CHECK(edge.parameterId == "gain", "parameterId captured");
        CHECK_NEAR(edge.mapping.base, 0.3, "base parsed");
        CHECK_NEAR(edge.mapping.depth, 0.5, "depth parsed");
        CHECK_NEAR(evaluateModulationMapping(edge.mapping, 1.0), 0.8, "edge evaluates end-to-end");
    }

    // Envelope shape comes from the node data.
    {
        const auto parsed = parseGraphStateEnvelopes(makeGraphState(
            modulationMapping(0.0, 1.0),
            nlohmann::json{{"attackMs", 3.0}, {"sustain", 0.1}, {"includeSlideNotes", true}}));
        CHECK(parsed.envelopes.size() == 1, "envelope parsed with data");
        CHECK_NEAR(parsed.envelopes[0].shape.attackMs, 3.0, "attackMs from node data");
        CHECK_NEAR(parsed.envelopes[0].shape.sustain, 0.1, "sustain from node data");
        CHECK(parsed.envelopes[0].shape.includeSlideNotes, "slide opt-in from node data");
    }

    // Negative depth round-trips through the parse.
    {
        const auto parsed = parseGraphStateEnvelopes(makeGraphState(modulationMapping(0.9, -0.7)));
        CHECK(parsed.envelopes[0].edges.size() == 1, "negative-depth edge resolves");
        CHECK_NEAR(parsed.envelopes[0].edges[0].mapping.depth, -0.7, "negative depth preserved");
        CHECK_NEAR(evaluateModulationMapping(parsed.envelopes[0].edges[0].mapping, 1.0), 0.2,
                   "negative depth applies downward");
    }

    // ── skip semantics ──
    // disabled
    {
        auto mapping = modulationMapping(0.5, 0.5);
        mapping["enabled"] = false;
        const auto parsed = parseGraphStateEnvelopes(makeGraphState(mapping));
        CHECK(parsed.envelopes[0].edges.empty(), "disabled edge produces no write");
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == EdgeSkipReason::Disabled, "reason: disabled");
    }

    // read_only
    {
        const auto parsed = parseGraphStateEnvelopes(
            makeGraphState(modulationMapping(0.5, 0.5), nlohmann::json::object(), true, true));
        CHECK(parsed.envelopes[0].edges.empty(), "read-only port produces no write");
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == EdgeSkipReason::ReadOnly, "reason: read_only");
    }

    // automatable === false is also read_only
    {
        const auto parsed = parseGraphStateEnvelopes(
            makeGraphState(modulationMapping(0.5, 0.5), nlohmann::json::object(), false, false));
        CHECK(parsed.envelopes[0].edges.empty(), "non-automatable port produces no write");
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == EdgeSkipReason::ReadOnly,
              "reason: read_only (automatable false)");
    }

    // invalid_target — wrong target kind
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["edges"][0]["targetParameter"]["kind"] = "not-a-graph-parameter";
        const auto parsed = parseGraphStateEnvelopes(gs);
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == EdgeSkipReason::InvalidTarget,
              "reason: invalid_target (bad kind)");
    }

    // invalid_target — missing targetParameter entirely
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["edges"][0].erase("targetParameter");
        const auto parsed = parseGraphStateEnvelopes(gs);
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == EdgeSkipReason::InvalidTarget,
              "reason: invalid_target (absent)");
    }

    // invalid_target — a fallback parameterId with no usable index
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["edges"][0]["targetParameter"]["parameterIdIsFallback"] = true;
        const auto parsed = parseGraphStateEnvelopes(gs);
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == EdgeSkipReason::InvalidTarget,
              "reason: invalid_target (fallback without index)");
    }

    // missing_node
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["edges"][0]["targetParameter"]["graphNodeId"] = "node-gone";
        const auto parsed = parseGraphStateEnvelopes(gs);
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == EdgeSkipReason::MissingNode, "reason: missing_node");
    }

    // missing_effect_instance — the node's instance id no longer matches
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["nodes"][1]["data"]["effectInstanceId"] = "fx-different";
        const auto parsed = parseGraphStateEnvelopes(gs);
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == EdgeSkipReason::MissingEffectInstance,
              "reason: missing_effect_instance");
    }

    // missing_exposed_port — the parameter is no longer exposed
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["nodes"][1]["data"]["exposedParameterPorts"] = nlohmann::json::array();
        const auto parsed = parseGraphStateEnvelopes(gs);
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == EdgeSkipReason::MissingExposedPort,
              "reason: missing_exposed_port");
    }

    // Non-envelope-sourced parameter edges (Macro edges) are never touched.
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["edges"][0]["sourceNodeId"] = "macro-1";
        const auto parsed = parseGraphStateEnvelopes(gs);
        CHECK(parsed.envelopes.size() == 1, "the envelope node is still found");
        CHECK(parsed.envelopes[0].edges.empty(), "a macro-sourced edge is not adopted");
        CHECK(parsed.skipped.empty(), "a macro-sourced edge is not even reported");
    }

    // Audio edges from the envelope node are ignored (envelopes carry no audio).
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["edges"][0]["type"] = "audio";
        const auto parsed = parseGraphStateEnvelopes(gs);
        CHECK(parsed.envelopes[0].edges.empty(), "audio edge is not a modulation edge");
        CHECK(parsed.skipped.empty(), "audio edge is not reported as skipped");
    }

    // Malformed input yields an empty result rather than throwing.
    CHECK(parseGraphStateEnvelopes(nlohmann::json()).envelopes.empty(), "null graphState");
    CHECK(parseGraphStateEnvelopes(nlohmann::json::array()).envelopes.empty(), "array graphState");
    CHECK(parseGraphStateEnvelopes(nlohmann::json{{"nodes", 5}}).envelopes.empty(),
          "non-array nodes");
    CHECK(parseGraphStateEnvelopes(
              nlohmann::json{{"nodes", nlohmann::json::array({nlohmann::json{{"id", "e"},
                                                                            {"type", "envelope"}}})}})
              .envelopes.size() == 1,
          "an envelope node with no data and no edges still parses");

    // A track with no envelope node yields nothing.
    {
        auto gs = makeGraphState(modulationMapping(0.5, 0.5));
        gs["nodes"][0]["type"] = "macro";
        const auto parsed = parseGraphStateEnvelopes(gs);
        CHECK(parsed.envelopes.empty(), "no envelope node, no definitions");
    }
}

static void testLegacyMappingMigration()
{
    std::cout << "§7b legacy range-mapping migration\n";

    // A pre-EVC-R4 envelope edge carries an absolute range mapping (no `kind`).
    // It migrates to base = targetMin, depth = targetMax - targetMin.
    {
        nlohmann::json legacy = {
            {"enabled", true},
            {"sourceMin", 0.0}, {"sourceMax", 1.0},
            {"targetMin", 0.2}, {"targetMax", 0.8},
            {"curve", {{"type", "linear"}}},
        };
        const auto parsed = parseGraphStateEnvelopes(makeGraphState(legacy));
        CHECK(parsed.envelopes[0].edges.size() == 1, "legacy edge still resolves");
        const auto& m = parsed.envelopes[0].edges[0].mapping;
        CHECK_NEAR(m.base, 0.2, "base = targetMin");
        CHECK_NEAR(m.depth, 0.6, "depth = targetMax - targetMin");
        // Algebraically identical to the old evaluation at every point.
        CHECK_NEAR(evaluateModulationMapping(m, 0.0), 0.2, "legacy env 0 == old targetMin");
        CHECK_NEAR(evaluateModulationMapping(m, 0.5), 0.5, "legacy env 0.5 == old midpoint");
        CHECK_NEAR(evaluateModulationMapping(m, 1.0), 0.8, "legacy env 1 == old targetMax");
    }

    // An INVERTED legacy range (targetMin > targetMax) becomes a negative depth.
    {
        nlohmann::json legacy = {
            {"enabled", true}, {"targetMin", 0.9}, {"targetMax", 0.1},
        };
        const auto parsed = parseGraphStateEnvelopes(makeGraphState(legacy));
        const auto& m = parsed.envelopes[0].edges[0].mapping;
        CHECK_NEAR(m.base, 0.9, "inverted range: base = targetMin");
        CHECK_NEAR(m.depth, -0.8, "inverted range becomes negative depth");
        CHECK_NEAR(evaluateModulationMapping(m, 1.0), 0.1, "inverted range still ends at targetMax");
    }

    // The retired node-level `amount` folds into depth exactly once.
    {
        nlohmann::json legacy = {
            {"enabled", true}, {"targetMin", 0.0}, {"targetMax", 1.0},
        };
        const auto parsed = parseGraphStateEnvelopes(
            makeGraphState(legacy, nlohmann::json{{"amount", 0.5}}));
        const auto& m = parsed.envelopes[0].edges[0].mapping;
        CHECK_NEAR(m.depth, 0.5, "legacy amount folded into depth once");
        CHECK_NEAR(evaluateModulationMapping(m, 1.0), 0.5, "amount 0.5 halves the travel");
    }

    // Idempotence: a node that has already been normalized carries no `amount`,
    // so a modulation mapping is never scaled again.
    {
        const auto parsed = parseGraphStateEnvelopes(
            makeGraphState(modulationMapping(0.0, 0.5), nlohmann::json{{"attackMs", 10.0}}));
        CHECK_NEAR(parsed.envelopes[0].edges[0].mapping.depth, 0.5,
                   "already-migrated mapping is not re-scaled");
    }

    // A disabled legacy mapping is still reported as disabled, not migrated in.
    {
        nlohmann::json legacy = {{"enabled", false}, {"targetMin", 0.2}, {"targetMax", 0.8}};
        const auto parsed = parseGraphStateEnvelopes(makeGraphState(legacy));
        CHECK(parsed.envelopes[0].edges.empty(), "disabled legacy edge produces no write");
        CHECK(parsed.skipped.size() == 1
              && parsed.skipped[0].reason == EdgeSkipReason::Disabled,
              "disabled legacy edge reason");
    }
}

// ─── §8 stop semantics ────────────────────────────────────────────────────────

static void testStopRestsAtBase()
{
    std::cout << "§8 stop rests at base (nothing destroyed)\n";

    // On stop the engine stops publishing modulation, and the last value it
    // publishes for an idle envelope is env == 0 -> exactly `base`. There is no
    // value the runtime can write that discards the user's authored setting.
    ModulationMapping m;
    m.base  = 0.61;
    m.depth = 0.9;

    // No gate anywhere: the envelope reads 0 at every position.
    const GateTimeline none;
    const auto shape = envelopeShapeToSamples(EnvelopeShape{}, kSR);
    for (int64_t s : {int64_t(0), int64_t(1000), int64_t(1000000)}) {
        const double env = evaluateEnvelopeAtSample(shape, makeGateView(none), s, kBPM, kSR);
        CHECK_NEAR(env, 0.0, "no gate reads 0");
        CHECK_NEAR(evaluateModulationMapping(m, env), 0.61,
                   "an idle envelope leaves the parameter at its authored base");
    }

    // After a gate's release tail completes, the same holds.
    const GateTimeline t = buildGateTimeline({{0, 480}});
    const double envAfter =
        evaluateEnvelopeAtSample(shape, makeGateView(t), 10'000'000, kBPM, kSR);
    CHECK_NEAR(envAfter, 0.0, "long after the release the envelope is 0");
    CHECK_NEAR(evaluateModulationMapping(m, envAfter), 0.61,
               "the parameter rests at base after the tail");
}

// ─── main ─────────────────────────────────────────────────────────────────────

int main()
{
    std::cout << "=== test_envelope_parameter_modulation ===\n";

    testShapeNormalization();
    testShapeToSamples();
    testLevelWhileHeld();
    testGateMerge();
    testGateResolution();
    testLoopWrapIsPositionPure();
    testModulationMapping();
    testGraphStateParse();
    testLegacyMappingMigration();
    testStopRestsAtBase();

    std::cout << "\npassed: " << g_passed << "  failed: " << g_failed << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    return 1;
}
