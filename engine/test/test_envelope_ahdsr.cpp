// test_envelope_ahdsr.cpp
// Unit tests for the pure AHDSR phase/value evaluator and the per-voice seek
// reconstruction model (EVC.4b).
//
// Audit: docs/dev/fxgraph-envelope-controller-architecture-audit.md (§5–§7)
// Model: engine/src/model/EnvelopeAhdsr.h, engine/src/model/EnvelopeVoiceEvents.h
//
// These tests are pure and fast — they build minimal AHDSR settings and minimal
// Clip / Pattern / PatternBlock model structs directly and assert closed-form
// envelope evaluation + deterministic reconstruction. No audio rendering, no
// transport, no graphState, no Sampler.
//
// Build target: test_envelope_ahdsr (engine/CMakeLists.txt)
// Pure C++, model-only — links solely against XlethEngineModel.
// Pass: prints "ALL TESTS PASSED" and exits 0.

#include "model/EnvelopeAhdsr.h"
#include "model/EnvelopeVoiceEvents.h"

#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

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

static bool approx(double a, double b, double eps = 1e-6) {
    return std::fabs(a - b) <= eps;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// 120 BPM, 960 PPQ: 1 beat = 500 ms = 960 ticks, so 192 ticks = 100 ms exactly.
static constexpr double kBpm = 120.0;
static constexpr double kSr  = 48000.0;
static constexpr double kGateInfinite = 1.0e9;  // ms — effectively held forever

static TickTime tt(int64_t ticks) { return TickTime{ticks}; }

static Clip makeClip(int id, int trackId, int regionId,
                     int64_t posTicks, int64_t durTicks,
                     int pitchOffset = 0, float velocity = 1.0f) {
    Clip c;
    c.id = id; c.trackId = trackId; c.regionId = regionId;
    c.position = tt(posTicks); c.duration = tt(durTicks);
    c.pitchOffset = pitchOffset; c.velocity = velocity;
    return c;
}

static PatternNote makeNote(int id, int64_t posTicks, int64_t durTicks,
                            int pitch = 60, float velocity = 1.0f, bool isSlide = false) {
    PatternNote n;
    n.id = id; n.position = tt(posTicks); n.duration = tt(durTicks);
    n.pitch = pitch; n.velocity = velocity; n.isSlide = isSlide;
    return n;
}

static Pattern makePattern(int id, int regionId, int64_t lenTicks, std::vector<PatternNote> notes) {
    Pattern p;
    p.id = id; p.regionId = regionId; p.length = tt(lenTicks); p.notes = std::move(notes);
    return p;
}

static PatternBlock makeBlock(int id, int trackId, int patternId,
                              int64_t posTicks, int64_t durTicks,
                              int64_t offsetTicks = 0, bool loopEnabled = false) {
    PatternBlock b;
    b.id = id; b.trackId = trackId; b.patternId = patternId;
    b.position = tt(posTicks); b.duration = tt(durTicks);
    b.offset = tt(offsetTicks); b.loopEnabled = loopEnabled;
    return b;
}

static EnvelopeQueryWindow win(int64_t start, int64_t end) {
    return EnvelopeQueryWindow{start, end};
}

// A point-query window [Q, Q+1) — what a single seek position uses.
static EnvelopeQueryWindow pointWin(int64_t q) { return EnvelopeQueryWindow{q, q + 1}; }

// ─── AHDSR evaluator tests ────────────────────────────────────────────────────

static void testDefaultNormalize() {
    EnvelopeAhdsrSettings s;                 // defaults
    EnvelopeAhdsrSettings n = s.normalized();
    CHECK(approx(n.attackMs,  10.0),  "default attackMs 10");
    CHECK(approx(n.holdMs,     0.0),  "default holdMs 0");
    CHECK(approx(n.decayMs,  120.0),  "default decayMs 120");
    CHECK(approx(n.sustain,    0.7),  "default sustain 0.7");
    CHECK(approx(n.releaseMs, 200.0), "default releaseMs 200");
    CHECK(approx(n.attackTension, 0.0)  && approx(n.decayTension, 0.0)
          && approx(n.releaseTension, 0.0), "default tensions 0");
    CHECK(approx(n.amount, 1.0), "default amount 1");
}

static void testAttackRises() {
    EnvelopeAhdsrSettings s; s.attackMs = 100; s.holdMs = 0; s.decayMs = 100; s.sustain = 0.5;
    auto a25 = evaluateEnvelopeAhdsr(s, 25, kGateInfinite);
    auto a50 = evaluateEnvelopeAhdsr(s, 50, kGateInfinite);
    auto a75 = evaluateEnvelopeAhdsr(s, 75, kGateInfinite);
    CHECK(a25.phase == EnvelopeAhdsrPhase::Attack, "attack phase at 25ms");
    CHECK(a25.active && a50.active && a75.active, "attack voices active");
    CHECK(a25.normalizedLevel < a50.normalizedLevel
          && a50.normalizedLevel < a75.normalizedLevel, "attack level strictly increasing");
    CHECK(approx(a50.normalizedLevel, 0.5), "linear attack reaches 0.5 at midpoint");
}

static void testHoldStaysOne() {
    EnvelopeAhdsrSettings s; s.attackMs = 10; s.holdMs = 100; s.decayMs = 100; s.sustain = 0.4;
    auto h = evaluateEnvelopeAhdsr(s, 50, kGateInfinite);  // inside [10, 110)
    CHECK(h.phase == EnvelopeAhdsrPhase::Hold, "hold phase");
    CHECK(approx(h.normalizedLevel, 1.0), "hold stays at 1");
}

static void testDecayReachesSustain() {
    EnvelopeAhdsrSettings s; s.attackMs = 0; s.holdMs = 0; s.decayMs = 100; s.sustain = 0.5;
    auto mid = evaluateEnvelopeAhdsr(s, 50, kGateInfinite);
    auto end = evaluateEnvelopeAhdsr(s, 99.999, kGateInfinite);
    CHECK(mid.phase == EnvelopeAhdsrPhase::Decay, "decay phase mid");
    CHECK(approx(mid.normalizedLevel, 0.75), "decay 1→0.5 linear is 0.75 at midpoint");
    CHECK(end.normalizedLevel < mid.normalizedLevel
          && end.normalizedLevel > 0.5 - 1e-3, "decay approaches sustain");
}

static void testSustainHolds() {
    EnvelopeAhdsrSettings s; s.attackMs = 0; s.holdMs = 0; s.decayMs = 10; s.sustain = 0.6;
    auto a = evaluateEnvelopeAhdsr(s, 500,  kGateInfinite);
    auto b = evaluateEnvelopeAhdsr(s, 1000, kGateInfinite);
    CHECK(a.phase == EnvelopeAhdsrPhase::Sustain && b.phase == EnvelopeAhdsrPhase::Sustain,
          "sustain phase while gate held");
    CHECK(approx(a.normalizedLevel, 0.6) && approx(b.normalizedLevel, 0.6),
          "sustain holds at sustain level over time");
}

static void testReleaseStartsAtGateEnd() {
    EnvelopeAhdsrSettings s; s.attackMs = 0; s.holdMs = 0; s.decayMs = 0; s.sustain = 0.5; s.releaseMs = 100;
    const double gate = 200.0;
    auto held = evaluateEnvelopeAhdsr(s, 199.0, gate);
    auto rel  = evaluateEnvelopeAhdsr(s, 200.0, gate);   // exactly at gate end
    CHECK(held.phase == EnvelopeAhdsrPhase::Sustain, "held just before gate end is sustain");
    CHECK(rel.phase == EnvelopeAhdsrPhase::Release, "release begins at gate end");
    CHECK(approx(rel.normalizedLevel, 0.5), "release starts from level at gate end (sustain)");
    CHECK(approx(rel.releaseStartLevel, 0.5), "releaseStartLevel captured");
}

static void testReleaseFromActualLevelShortNote() {
    // Gate ends mid-attack: release must start from the partial attack level.
    EnvelopeAhdsrSettings s; s.attackMs = 100; s.holdMs = 0; s.decayMs = 0; s.sustain = 0.2; s.releaseMs = 100;
    const double gate = 40.0;                     // ends at 40% up the attack ramp
    auto atEnd = evaluateEnvelopeAhdsr(s, 40.0, gate);
    auto half  = evaluateEnvelopeAhdsr(s, 90.0, gate);  // 50ms into release
    CHECK(atEnd.phase == EnvelopeAhdsrPhase::Release, "short note releases (not sustain)");
    CHECK(approx(atEnd.normalizedLevel, 0.4), "release starts from actual reached level 0.4");
    CHECK(approx(atEnd.releaseStartLevel, 0.4), "releaseStartLevel = actual gate-end level");
    CHECK(approx(half.normalizedLevel, 0.2), "release halfway from 0.4 → 0.2");
}

static void testReleaseReachesZeroAndOff() {
    EnvelopeAhdsrSettings s; s.attackMs = 0; s.holdMs = 0; s.decayMs = 0; s.sustain = 0.5; s.releaseMs = 100;
    const double gate = 200.0;
    auto done = evaluateEnvelopeAhdsr(s, 300.0, gate);   // exactly release end
    auto past = evaluateEnvelopeAhdsr(s, 350.0, gate);
    CHECK(done.phase == EnvelopeAhdsrPhase::Off && !done.active, "release completes → Off");
    CHECK(approx(done.normalizedLevel, 0.0), "release completion level 0");
    CHECK(past.phase == EnvelopeAhdsrPhase::Off && !past.active, "past release → Off");
}

static void testBeforeOnsetOff() {
    EnvelopeAhdsrSettings s;
    auto pre = evaluateEnvelopeAhdsr(s, -5.0, 1000.0);
    CHECK(pre.phase == EnvelopeAhdsrPhase::Off && !pre.active, "before onset → Off inactive");
    CHECK(approx(pre.normalizedLevel, 0.0), "before onset level 0");
}

static void testZeroAttackSafe() {
    EnvelopeAhdsrSettings s; s.attackMs = 0; s.holdMs = 0; s.decayMs = 120; s.sustain = 0.7;
    auto at0 = evaluateEnvelopeAhdsr(s, 0.0, kGateInfinite);
    CHECK(at0.active, "zero attack active at onset");
    CHECK(at0.phase != EnvelopeAhdsrPhase::Attack, "zero attack skips Attack phase");
    CHECK(approx(at0.normalizedLevel, 1.0), "zero attack → immediate 1 at onset");
}

static void testZeroReleaseSafe() {
    EnvelopeAhdsrSettings s; s.attackMs = 0; s.holdMs = 0; s.decayMs = 0; s.sustain = 0.5; s.releaseMs = 0;
    const double gate = 200.0;
    auto held = evaluateEnvelopeAhdsr(s, 199.0, gate);
    auto off  = evaluateEnvelopeAhdsr(s, 200.0, gate);   // gate end with zero release
    CHECK(held.active && held.phase == EnvelopeAhdsrPhase::Sustain, "held before gate end");
    CHECK(off.phase == EnvelopeAhdsrPhase::Off && !off.active, "zero release → immediate Off after gate end");
    CHECK(approx(off.normalizedLevel, 0.0), "zero release Off level 0");
}

static void testZeroDecaySafe() {
    EnvelopeAhdsrSettings s; s.attackMs = 0; s.holdMs = 0; s.decayMs = 0; s.sustain = 0.3;
    auto v = evaluateEnvelopeAhdsr(s, 10.0, kGateInfinite);
    CHECK(v.phase == EnvelopeAhdsrPhase::Sustain, "zero decay → straight to sustain");
    CHECK(approx(v.normalizedLevel, 0.3), "zero decay level = sustain, no divide-by-zero");
}

static void testAmountScales() {
    EnvelopeAhdsrSettings half; half.attackMs = 0; half.decayMs = 0; half.sustain = 0.8; half.amount = 0.5;
    EnvelopeAhdsrSettings zero = half; zero.amount = 0.0;
    auto h = evaluateEnvelopeAhdsr(half, 50.0, kGateInfinite);
    auto z = evaluateEnvelopeAhdsr(zero, 50.0, kGateInfinite);
    CHECK(approx(h.normalizedLevel, 0.4), "amount 0.5 scales sustain 0.8 → 0.4");
    CHECK(approx(z.normalizedLevel, 0.0), "amount 0 → level 0");
}

static void testMalformedNormalizes() {
    EnvelopeAhdsrSettings bad;
    bad.attackMs       = -5.0;                       // negative → 0
    bad.decayMs        = std::nan("");               // NaN → default 120
    bad.holdMs         = std::numeric_limits<double>::infinity();  // inf → default 0
    bad.sustain        = 2.0;                         // > 1 → 1
    bad.amount         = -1.0;                        // < 0 → 0
    bad.attackTension  = 5.0;                         // > 1 → 1
    bad.releaseTension = -9.0;                        // < -1 → -1
    EnvelopeAhdsrSettings n = bad.normalized();
    CHECK(approx(n.attackMs, 0.0),  "negative ms repaired to 0");
    CHECK(approx(n.decayMs, 120.0), "NaN ms repaired to default");
    CHECK(approx(n.holdMs, 0.0),    "inf ms repaired to default");
    CHECK(approx(n.sustain, 1.0),   "sustain clamped to 1");
    CHECK(approx(n.amount, 0.0),    "amount clamped to 0");
    CHECK(approx(n.attackTension, 1.0) && approx(n.releaseTension, -1.0),
          "tension clamped to [-1,1]");
    // Evaluation on malformed input must not crash / produce NaN.
    auto v = evaluateEnvelopeAhdsr(bad, 30.0, 500.0);
    CHECK(std::isfinite(v.normalizedLevel), "evaluation of malformed settings is finite");
}

// ─── Reconstruction tests ─────────────────────────────────────────────────────

// Shared envelope for reconstruction tests: 100 ms attack (192 ticks), no
// hold/decay, sustain 0.5, 200 ms release (384 ticks). Linear (tension 0).
static EnvelopeAhdsrSettings reconSettings() {
    EnvelopeAhdsrSettings s;
    s.attackMs = 100; s.holdMs = 0; s.decayMs = 0; s.sustain = 0.5; s.releaseMs = 200;
    s.attackTension = 0; s.decayTension = 0; s.releaseTension = 0; s.amount = 1.0;
    return s;
}

static void testReconMidClip() {
    auto s = reconSettings();
    std::vector<Clip> clips = { makeClip(5, 2, 0, 0, 960) };  // gate [0, 960) = 500 ms
    const int64_t Q = 480;                                    // 250 ms in → sustain
    const int64_t tail = envelopeReconstructionTailTicks(s, kBpm);

    auto events = enumerateEnvelopeClipOccurrencesForReconstruction(
        clips, 2, pointWin(Q), kBpm, kSr, tail);
    auto active = reconstructActiveEnvelopeVoiceStates(events, s, Q, kBpm);

    CHECK(active.size() == 1, "mid-clip reconstructs one active voice");
    if (active.size() == 1) {
        const auto& v = active[0];
        CHECK(v.sourceKind == EnvelopeVoiceSourceKind::TimelineClip, "mid-clip voice is a clip");
        CHECK(v.onsetTick == 0 && v.gateEndTick == 960, "mid-clip carries full gate");
        CHECK(v.env.phase == EnvelopeAhdsrPhase::Sustain, "mid-clip in sustain at 250ms");
        CHECK(approx(v.env.normalizedLevel, 0.5, 1e-3), "mid-clip sustain level 0.5");
    }
}

static void testReconAttackClip() {
    auto s = reconSettings();
    std::vector<Clip> clips = { makeClip(5, 2, 0, 0, 960) };
    const int64_t Q = 96;                                     // 50 ms in → mid-attack
    const int64_t tail = envelopeReconstructionTailTicks(s, kBpm);
    auto events = enumerateEnvelopeClipOccurrencesForReconstruction(clips, 2, pointWin(Q), kBpm, kSr, tail);
    auto active = reconstructActiveEnvelopeVoiceStates(events, s, Q, kBpm);
    CHECK(active.size() == 1, "attack-phase clip reconstructs one voice");
    if (active.size() == 1) {
        CHECK(active[0].env.phase == EnvelopeAhdsrPhase::Attack, "clip mid-attack");
        CHECK(approx(active[0].env.normalizedLevel, 0.5, 1e-3), "clip attack level 0.5 at 50ms");
    }
}

static void testReconMidNote() {
    auto s = reconSettings();
    auto pat = makePattern(100, 9, 1920, { makeNote(1, 480, 960, 64, 0.8f) });  // note [480,1440)
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(50, 4, 100, 0, 1920) };
    const int64_t tail = envelopeReconstructionTailTicks(s, kBpm);

    // 50 ms into the note (onset 480 + 96).
    const int64_t Qa = 576;
    auto eventsA = enumerateEnvelopePatternNoteOccurrencesForReconstruction(
        blocks, patterns, 4, pointWin(Qa), kBpm, kSr, tail);
    auto activeA = reconstructActiveEnvelopeVoiceStates(eventsA, s, Qa, kBpm);
    CHECK(activeA.size() == 1, "mid-note (attack) reconstructs one voice");
    if (activeA.size() == 1) {
        CHECK(activeA[0].sourceKind == EnvelopeVoiceSourceKind::PatternNote, "voice is a note");
        CHECK(activeA[0].onsetTick == 480 && activeA[0].gateEndTick == 1440, "note gate carried");
        CHECK(activeA[0].pitch == 64, "note pitch metadata preserved");
        CHECK(approx(activeA[0].velocity, 0.8f, 1e-6), "note velocity metadata preserved");
        CHECK(activeA[0].env.phase == EnvelopeAhdsrPhase::Attack, "note mid-attack");
        CHECK(approx(activeA[0].env.normalizedLevel, 0.5, 1e-3), "note attack level 0.5");
    }

    // 250 ms into the note → sustain.
    const int64_t Qb = 480 + 480;
    auto eventsB = enumerateEnvelopePatternNoteOccurrencesForReconstruction(
        blocks, patterns, 4, pointWin(Qb), kBpm, kSr, tail);
    auto activeB = reconstructActiveEnvelopeVoiceStates(eventsB, s, Qb, kBpm);
    CHECK(activeB.size() == 1 && activeB[0].env.phase == EnvelopeAhdsrPhase::Sustain,
          "mid-note (sustain) reconstructs sustaining voice");
}

static void testReconDuringRelease() {
    auto s = reconSettings();
    auto pat = makePattern(101, 9, 1920, { makeNote(1, 0, 960, 60) });  // note [0,960)
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(60, 4, 101, 0, 1920) };
    const int64_t tail = envelopeReconstructionTailTicks(s, kBpm);

    const int64_t Q = 960 + 192;   // 100 ms into the 200 ms release
    auto events = enumerateEnvelopePatternNoteOccurrencesForReconstruction(
        blocks, patterns, 4, pointWin(Q), kBpm, kSr, tail);
    auto active = reconstructActiveEnvelopeVoiceStates(events, s, Q, kBpm);
    CHECK(active.size() == 1, "query during release returns a releasing voice");
    if (active.size() == 1) {
        CHECK(active[0].env.phase == EnvelopeAhdsrPhase::Release, "voice is releasing");
        CHECK(approx(active[0].env.normalizedLevel, 0.25, 1e-3),
              "release halfway from sustain 0.5 → 0.25");
    }
}

static void testReconAfterReleaseOmitted() {
    auto s = reconSettings();
    auto pat = makePattern(102, 9, 1920, { makeNote(1, 0, 960, 60) });  // note [0,960), release 384 ticks
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(70, 4, 102, 0, 1920) };
    const int64_t tail = envelopeReconstructionTailTicks(s, kBpm);

    const int64_t Q = 960 + 384 + 20;   // past the end of the release tail
    auto events = enumerateEnvelopePatternNoteOccurrencesForReconstruction(
        blocks, patterns, 4, pointWin(Q), kBpm, kSr, tail);
    auto active = reconstructActiveEnvelopeVoiceStates(events, s, Q, kBpm);
    CHECK(active.empty(), "query after release completes omits the voice from active reconstruction");
}

static void testReconChordIndependent() {
    auto s = reconSettings();
    auto pat = makePattern(103, 9, 1920, {
        makeNote(1, 0, 960, 60),
        makeNote(2, 0, 960, 64),
        makeNote(3, 0, 960, 67),
    });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(80, 4, 103, 0, 1920) };
    const int64_t tail = envelopeReconstructionTailTicks(s, kBpm);
    const int64_t Q = 480;   // mid-note → sustain

    auto events = enumerateEnvelopePatternNoteOccurrencesForReconstruction(
        blocks, patterns, 4, pointWin(Q), kBpm, kSr, tail);
    auto active = reconstructActiveEnvelopeVoiceStates(events, s, Q, kBpm);
    CHECK(active.size() == 3, "chord reconstructs 3 independent voices (never combined)");
    if (active.size() == 3) {
        CHECK(active[0].key != active[1].key && active[1].key != active[2].key
              && active[0].key != active[2].key, "chord voice keys all distinct");
        CHECK(approx(active[0].env.normalizedLevel, 0.5, 1e-3)
              && approx(active[1].env.normalizedLevel, 0.5, 1e-3)
              && approx(active[2].env.normalizedLevel, 0.5, 1e-3),
              "chord voices share identical shape (same level), not summed");
    }
}

static void testReconLoopIterationsDistinct() {
    auto s = reconSettings();
    s.releaseMs = 0;  // no release tail so iteration 0 is fully gone by iteration 1
    auto pat = makePattern(104, 9, 1920, { makeNote(1, 0, 240, 60) });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(90, 4, 104, 0, 3840, /*offset*/0, /*loop*/true) };
    const int64_t tail = envelopeReconstructionTailTicks(s, kBpm);

    const int64_t Q0 = 96;          // inside iteration 0's note
    const int64_t Q1 = 1920 + 96;   // inside iteration 1's note
    auto a0 = reconstructActiveEnvelopeVoiceStates(
        enumerateEnvelopePatternNoteOccurrencesForReconstruction(
            blocks, patterns, 4, pointWin(Q0), kBpm, kSr, tail), s, Q0, kBpm);
    auto a1 = reconstructActiveEnvelopeVoiceStates(
        enumerateEnvelopePatternNoteOccurrencesForReconstruction(
            blocks, patterns, 4, pointWin(Q1), kBpm, kSr, tail), s, Q1, kBpm);

    CHECK(a0.size() == 1 && a1.size() == 1, "each loop iteration reconstructs one voice");
    if (a0.size() == 1 && a1.size() == 1) {
        CHECK(a0[0].onsetTick == 0 && a0[0].key.loopIteration == 0, "iteration 0 voice");
        CHECK(a1[0].onsetTick == 1920 && a1[0].key.loopIteration == 1, "iteration 1 voice");
        CHECK(a0[0].key != a1[0].key, "loop iteration keys distinct");
        CHECK(a0[0].key.sourceId == a1[0].key.sourceId, "same note id across iterations");
    }
}

static void testReconOverlappingClips() {
    auto s = reconSettings();
    std::vector<Clip> clips = {
        makeClip(10, 1, 0, 0,   1920),   // [0, 1920)
        makeClip(11, 1, 0, 480, 1920),   // [480, 2400) — overlaps
    };
    const int64_t tail = envelopeReconstructionTailTicks(s, kBpm);
    const int64_t Q = 960;  // both clips active

    auto events = enumerateEnvelopeClipOccurrencesForReconstruction(clips, 1, pointWin(Q), kBpm, kSr, tail);
    auto active = reconstructActiveEnvelopeVoiceStates(events, s, Q, kBpm);
    CHECK(active.size() == 2, "overlapping clips reconstruct 2 separate voices");
    if (active.size() == 2) {
        CHECK(active[0].key != active[1].key, "overlapping clip keys distinct");
        CHECK(active[0].onsetTick != active[1].onsetTick, "overlapping clips have distinct onsets");
    }
}

static void testReconTriggerFiltering() {
    auto s = reconSettings();
    std::vector<Clip> clips = { makeClip(1, 4, 0, 0, 1920) };       // clip active mid
    auto pat = makePattern(110, 9, 1920, { makeNote(1, 0, 960, 60) });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(120, 4, 110, 0, 1920) };
    const int64_t tail = envelopeReconstructionTailTicks(s, kBpm);
    const int64_t Q = 480;

    auto both = reconstructActiveEnvelopeVoiceStates(
        enumerateEnvelopeVoiceOccurrencesForReconstruction(
            clips, blocks, patterns, 4, EnvelopeTriggerEvents::NotesAndClips, pointWin(Q), kBpm, kSr, tail),
        s, Q, kBpm);
    bool hasNote = false, hasClip = false;
    for (const auto& v : both) {
        if (v.sourceKind == EnvelopeVoiceSourceKind::PatternNote)  hasNote = true;
        if (v.sourceKind == EnvelopeVoiceSourceKind::TimelineClip) hasClip = true;
    }
    CHECK(both.size() == 2 && hasNote && hasClip, "NotesAndClips reconstruction returns both kinds");

    auto onlyNotes = reconstructActiveEnvelopeVoiceStates(
        enumerateEnvelopeVoiceOccurrencesForReconstruction(
            clips, blocks, patterns, 4, EnvelopeTriggerEvents::Notes, pointWin(Q), kBpm, kSr, tail),
        s, Q, kBpm);
    CHECK(onlyNotes.size() == 1 && onlyNotes[0].sourceKind == EnvelopeVoiceSourceKind::PatternNote,
          "Notes-only reconstruction returns only notes");

    auto onlyClips = reconstructActiveEnvelopeVoiceStates(
        enumerateEnvelopeVoiceOccurrencesForReconstruction(
            clips, blocks, patterns, 4, EnvelopeTriggerEvents::Clips, pointWin(Q), kBpm, kSr, tail),
        s, Q, kBpm);
    CHECK(onlyClips.size() == 1 && onlyClips[0].sourceKind == EnvelopeVoiceSourceKind::TimelineClip,
          "Clips-only reconstruction returns only clips");
}

// The crux of EVC.4b: reconstruction enumeration must include held/releasing
// occurrences whose onset is in the past, WITHOUT changing the EVC.4 live
// onset-in-window semantics.
static void testLiveVsReconstructionNote() {
    auto s = reconSettings();
    auto pat = makePattern(130, 9, 1920, { makeNote(1, 0, 960, 60) });  // note [0,960)
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(140, 4, 130, 0, 1920) };
    const int64_t tail = envelopeReconstructionTailTicks(s, kBpm);

    // Window strictly inside the held note, after its onset.
    auto w = pointWin(480);

    auto live = enumerateEnvelopePatternNoteOccurrences(blocks, patterns, 4, w, kBpm, kSr);
    CHECK(live.empty(), "live enumeration: onset NOT in window → empty (EVC.4 semantics intact)");

    auto recon = enumerateEnvelopePatternNoteOccurrencesForReconstruction(
        blocks, patterns, 4, w, kBpm, kSr, tail);
    CHECK(recon.size() == 1, "reconstruction enumeration: held note IS returned");
    if (recon.size() == 1)
        CHECK(recon[0].onsetTick == 0 && recon[0].gateEndTick == 960, "held note carries its gate");

    // And at onset, live semantics still fire (onset in window).
    auto liveAtOnset = enumerateEnvelopePatternNoteOccurrences(blocks, patterns, 4, pointWin(0), kBpm, kSr);
    CHECK(liveAtOnset.size() == 1, "live enumeration still returns the note when onset is in window");
}

static void testLiveVsReconstructionClip() {
    auto s = reconSettings();
    std::vector<Clip> clips = { makeClip(1, 4, 0, 0, 960) };  // clip [0,960), release tail 384
    const int64_t tail = envelopeReconstructionTailTicks(s, kBpm);

    // Window after the clip body ends but inside its release tail (960..1344).
    auto w = pointWin(1100);

    auto live = enumerateEnvelopeClipOccurrences(clips, 4, w, kBpm, kSr);
    CHECK(live.empty(), "live clip overlap: ended clip not returned past its body");

    auto recon = enumerateEnvelopeClipOccurrencesForReconstruction(clips, 4, w, kBpm, kSr, tail);
    CHECK(recon.size() == 1, "reconstruction clip overlap: releasing clip IS returned within tail");

    // Reconstructed state at 1100 ticks is in the release segment.
    auto active = reconstructActiveEnvelopeVoiceStates(recon, s, 1100, kBpm);
    CHECK(active.size() == 1 && active[0].env.phase == EnvelopeAhdsrPhase::Release,
          "releasing clip reconstructs a Release-phase voice");
}

static void testReconStatesIncludeOff() {
    // reconstructEnvelopeVoiceStates (unfiltered) returns Off voices too; the
    // active filter is what omits them.
    auto s = reconSettings();
    std::vector<Clip> clips = { makeClip(1, 4, 0, 0, 960) };
    const int64_t tail = envelopeReconstructionTailTicks(s, kBpm);
    // Enumerate at the clip body, then query far in the future (past release).
    auto events = enumerateEnvelopeClipOccurrencesForReconstruction(clips, 4, pointWin(480), kBpm, kSr, tail);
    const int64_t farQ = 100000;
    auto all = reconstructEnvelopeVoiceStates(events, s, farQ, kBpm);
    auto act = reconstructActiveEnvelopeVoiceStates(events, s, farQ, kBpm);
    CHECK(all.size() == 1, "unfiltered reconstruction keeps the occurrence");
    CHECK(all.size() == 1 && all[0].env.phase == EnvelopeAhdsrPhase::Off, "far-future state is Off");
    CHECK(act.empty(), "active filter omits the Off voice");
}

// ─── Main ──────────────────────────────────────────────────────────────────

int main() {
    std::cout << "Running EVC.4b envelope AHDSR + reconstruction tests...\n";

    // AHDSR evaluator
    testDefaultNormalize();
    testAttackRises();
    testHoldStaysOne();
    testDecayReachesSustain();
    testSustainHolds();
    testReleaseStartsAtGateEnd();
    testReleaseFromActualLevelShortNote();
    testReleaseReachesZeroAndOff();
    testBeforeOnsetOff();
    testZeroAttackSafe();
    testZeroReleaseSafe();
    testZeroDecaySafe();
    testAmountScales();
    testMalformedNormalizes();

    // Reconstruction
    testReconMidClip();
    testReconAttackClip();
    testReconMidNote();
    testReconDuringRelease();
    testReconAfterReleaseOmitted();
    testReconChordIndependent();
    testReconLoopIterationsDistinct();
    testReconOverlappingClips();
    testReconTriggerFiltering();
    testLiveVsReconstructionNote();
    testLiveVsReconstructionClip();
    testReconStatesIncludeOff();

    std::cout << "\nPassed: " << g_passed << "   Failed: " << g_failed << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cerr << "TESTS FAILED\n";
    return 1;
}
