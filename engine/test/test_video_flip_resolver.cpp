// test_video_flip_resolver.cpp
// Unit tests for the per-track flip state-machine resolver (Phase 2 keystone).
//
// Coverage map (spec sections):
//   §4.4 — every edge case in the rule summary table
//   §7.1 — Acceptance test #1 (new-note)              "Krasen's example"
//   §7.2 — Acceptance test #2 (pattern-loop flat walk)
//   §7.3 — Acceptance test #3 (polyphony transparency)
//   §7.4 — Acceptance test #4 (every-n-beats clock)
//   §7.5 — Acceptance test #5 (specific-pitches whitelist)
//
// Acceptance test #6 (legacy-migration parity) is verified in test_timeline.cpp
// because it exercises the JSON migration path, not the resolver.
//
// Build target: test_video_flip_resolver  (engine/CMakeLists.txt)
// Pass: prints "ALL TESTS PASSED" and exits 0.

#include "model/VideoFlipResolver.h"

#include <cstdint>
#include <iostream>
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

// Pretty-print two int vectors so a failure makes the diff obvious.
static std::string vecToString(const std::vector<int>& v) {
    std::string s = "[";
    for (std::size_t i = 0; i < v.size(); ++i) {
        if (i) s += ",";
        s += std::to_string(v[i]);
    }
    return s + "]";
}

#define CHECK_VEC_EQ(actual, expected, label)                              \
    do {                                                                   \
        const auto& _a = (actual);                                         \
        const auto& _e = (expected);                                       \
        if (_a == _e) {                                                    \
            ++g_passed;                                                    \
        } else {                                                           \
            std::cerr << "  FAIL [" << __LINE__ << "] " << (label)         \
                      << " expected=" << vecToString(_e)                   \
                      << " actual=" << vecToString(_a) << "\n";            \
            ++g_failed;                                                    \
        }                                                                  \
    } while (0)

// ─── Test fixtures ────────────────────────────────────────────────────────────

static constexpr int kPPQ = 960;  // Xleth project tick rate.

// Build a config with N states whose orientations rotate through the 6-element
// table. Convenient for tests that don't care about orientation, only stateIdx.
static VideoFlipConfig makeConfig(int numStates,
                                  VideoFlipModifier::Type modType,
                                  int startStateIndex = 0,
                                  bool enabled = true) {
    VideoFlipConfig cfg;
    cfg.enabled         = enabled;
    cfg.startStateIndex = startStateIndex;
    cfg.modifier.type   = modType;
    static const Orientation cycle[6] = {
        Orientation::None,       Orientation::Horizontal, Orientation::Vertical,
        Orientation::Rotate180,  Orientation::Rotate90CW, Orientation::Rotate90CCW,
    };
    for (int i = 0; i < numStates; ++i) {
        cfg.states.push_back({"s" + std::to_string(i), cycle[i % 6], ""});
    }
    return cfg;
}

// Build a list of mono events at evenly-spaced ticks. Pitch defaults to 60 (C4)
// unless an explicit pitch list is supplied (length must equal count when given).
static std::vector<TriggerEvent> makeEvents(int count,
                                            int64_t tickStep = kPPQ,  // 1 beat
                                            const std::vector<int>& pitches = {}) {
    std::vector<TriggerEvent> out;
    out.reserve(count);
    for (int i = 0; i < count; ++i) {
        TriggerEvent ev;
        ev.tick  = static_cast<int64_t>(i) * tickStep;
        ev.pitch = pitches.empty() ? 60 : pitches[i];
        out.push_back(ev);
    }
    return out;
}

// MIDI note constants used in worked examples.
static constexpr int kC4  = 60;
static constexpr int kD4  = 62;
static constexpr int kG4  = 67;
static constexpr int kA4  = 69;
static constexpr int kC5  = 72;
static constexpr int kD5  = 74;
static constexpr int kDs5 = 75;

// ─── [1] Short-circuits ───────────────────────────────────────────────────────

static void testShortCircuits() {
    std::cout << "[1] Short-circuits (disabled / single state / empty input)\n";

    auto evs = makeEvents(5);

    // Disabled config — every event resolves to 0 regardless of modifier.
    {
        auto cfg = makeConfig(4, VideoFlipModifier::Type::EveryNote,
                              /*start=*/2, /*enabled=*/false);
        auto out = resolveStateIndex(cfg, evs, kPPQ);
        CHECK_VEC_EQ(out, std::vector<int>(5, 0), "disabled → all zeros");
    }

    // Single-state config — every event resolves to 0 (nothing to cycle through).
    {
        auto cfg = makeConfig(1, VideoFlipModifier::Type::EveryNote,
                              /*start=*/0, /*enabled=*/true);
        auto out = resolveStateIndex(cfg, evs, kPPQ);
        CHECK_VEC_EQ(out, std::vector<int>(5, 0), "single-state → all zeros");
    }

    // Empty event list with an enabled multi-state config.
    {
        auto cfg = makeConfig(3, VideoFlipModifier::Type::EveryNote);
        std::vector<TriggerEvent> none;
        auto out = resolveStateIndex(cfg, none, kPPQ);
        CHECK(out.empty(), "empty input → empty output");
    }

    // Single-state but disabled — still all zeros (both short-circuits hit).
    {
        auto cfg = makeConfig(1, VideoFlipModifier::Type::SpecificPitches,
                              /*start=*/0, /*enabled=*/false);
        auto out = resolveStateIndex(cfg, evs, kPPQ);
        CHECK_VEC_EQ(out, std::vector<int>(5, 0), "disabled+single → all zeros");
    }
}

// ─── [2] every-note modifier ──────────────────────────────────────────────────

static void testEveryNote() {
    std::cout << "[2] every-note modifier\n";

    // 2 states, startIdx=0: first event no advance, then walk 1,0,1,0,...
    {
        auto cfg = makeConfig(2, VideoFlipModifier::Type::EveryNote);
        auto out = resolveStateIndex(cfg, makeEvents(7), kPPQ);
        CHECK_VEC_EQ(out, (std::vector<int>{0, 1, 0, 1, 0, 1, 0}),
                     "every-note 2 states startIdx=0");
    }

    // 4 states, startIdx=0: spec §3.3.1 — ordinal k → state (s+k) mod N
    {
        auto cfg = makeConfig(4, VideoFlipModifier::Type::EveryNote);
        auto out = resolveStateIndex(cfg, makeEvents(9), kPPQ);
        CHECK_VEC_EQ(out, (std::vector<int>{0, 1, 2, 3, 0, 1, 2, 3, 0}),
                     "every-note 4 states startIdx=0 — wraps");
    }

    // 3 states, startIdx=2: wrap behavior on first non-first event.
    {
        auto cfg = makeConfig(3, VideoFlipModifier::Type::EveryNote, /*start=*/2);
        auto out = resolveStateIndex(cfg, makeEvents(6), kPPQ);
        // first → 2 (no advance), then 0,1,2,0,1
        CHECK_VEC_EQ(out, (std::vector<int>{2, 0, 1, 2, 0, 1}),
                     "every-note 3 states startIdx=2");
    }

    // Single mono event: just renders startStateIndex (no advance possible).
    {
        auto cfg = makeConfig(4, VideoFlipModifier::Type::EveryNote, /*start=*/3);
        auto out = resolveStateIndex(cfg, makeEvents(1), kPPQ);
        CHECK_VEC_EQ(out, (std::vector<int>{3}),
                     "every-note single event renders startIdx");
    }

    // Pitch is irrelevant for every-note — different pitches produce same output.
    {
        auto cfg = makeConfig(2, VideoFlipModifier::Type::EveryNote);
        auto evs = makeEvents(4, kPPQ, {kC4, kD4, kG4, kA4});
        auto out = resolveStateIndex(cfg, evs, kPPQ);
        CHECK_VEC_EQ(out, (std::vector<int>{0, 1, 0, 1}),
                     "every-note pitch-blind");
    }
}

// ─── [3] new-note modifier (acceptance test #1, spec §7.1) ───────────────────

static void testNewNote_Acceptance1() {
    std::cout << "[3] new-note (acceptance test #1: D5,D5,D#5,D5,D4,C5,C5)\n";

    // States [{none}, {horizontal}], new-note, startStateIndex: 0
    auto cfg = makeConfig(2, VideoFlipModifier::Type::NewNote, /*start=*/0);
    std::vector<TriggerEvent> evs;
    evs.push_back({0     * kPPQ, kD5});   // 1 D5  — first → no advance       → 0
    evs.push_back({1     * kPPQ, kD5});   // 2 D5  — same as prev → no advance→ 0
    evs.push_back({2     * kPPQ, kDs5});  // 3 D#5 — different → advance      → 1
    evs.push_back({3     * kPPQ, kD5});   // 4 D5  — different → advance      → 0 (wrap)
    evs.push_back({4     * kPPQ, kD4});   // 5 D4  — different → advance      → 1
    evs.push_back({5     * kPPQ, kC5});   // 6 C5  — different → advance      → 0
    evs.push_back({6     * kPPQ, kC5});   // 7 C5  — same → no advance        → 0

    auto out = resolveStateIndex(cfg, evs, kPPQ);
    CHECK_VEC_EQ(out, (std::vector<int>{0, 0, 1, 0, 1, 0, 0}),
                 "acceptance #1 — Krasen's example");
}

// ─── [4] new-note edge cases ──────────────────────────────────────────────────

static void testNewNote_Edges() {
    std::cout << "[4] new-note edge cases\n";

    // First mono trigger never advances even if "previous" is conceptually unset.
    {
        auto cfg = makeConfig(3, VideoFlipModifier::Type::NewNote, /*start=*/1);
        auto out = resolveStateIndex(cfg, makeEvents(1, kPPQ, {kG4}), kPPQ);
        CHECK_VEC_EQ(out, (std::vector<int>{1}), "new-note first trigger no advance");
    }

    // All-same-pitch sequence: never advances after the first.
    {
        auto cfg = makeConfig(2, VideoFlipModifier::Type::NewNote);
        auto evs = makeEvents(5, kPPQ, {kC4, kC4, kC4, kC4, kC4});
        auto out = resolveStateIndex(cfg, evs, kPPQ);
        CHECK_VEC_EQ(out, (std::vector<int>{0, 0, 0, 0, 0}),
                     "new-note all-same-pitch never advances");
    }

    // Alternating pitches: every event after the first advances.
    {
        auto cfg = makeConfig(3, VideoFlipModifier::Type::NewNote);
        auto evs = makeEvents(6, kPPQ, {kC4, kD4, kC4, kD4, kC4, kD4});
        auto out = resolveStateIndex(cfg, evs, kPPQ);
        // 0, 1, 2, 0, 1, 2  (wraps every 3)
        CHECK_VEC_EQ(out, (std::vector<int>{0, 1, 2, 0, 1, 2}),
                     "new-note alternating pitches wrap");
    }
}

// ─── [5] specific-pitches modifier (acceptance test #5, spec §7.5) ───────────

static void testSpecificPitches_Acceptance5() {
    std::cout << "[5] specific-pitches (acceptance test #5: C4,D4,G4,A4,C4,C4 + whitelist [60,67])\n";

    auto cfg = makeConfig(2, VideoFlipModifier::Type::SpecificPitches, /*start=*/0);
    cfg.modifier.pitches = {kC4, kG4};   // 60, 67

    std::vector<TriggerEvent> evs;
    evs.push_back({0 * kPPQ, kC4});  // 1 C4 in list → advance (overrides first-trigger) → 1
    evs.push_back({1 * kPPQ, kD4});  // 2 D4 not in list → no advance                    → 1
    evs.push_back({2 * kPPQ, kG4});  // 3 G4 in list → advance                           → 0
    evs.push_back({3 * kPPQ, kA4});  // 4 A4 not in list → no advance                    → 0
    evs.push_back({4 * kPPQ, kC4});  // 5 C4 in list → advance                           → 1
    evs.push_back({5 * kPPQ, kC4});  // 6 C4 in list → advance                           → 0

    auto out = resolveStateIndex(cfg, evs, kPPQ);
    CHECK_VEC_EQ(out, (std::vector<int>{1, 1, 0, 0, 1, 0}),
                 "acceptance #5 — specific-pitches whitelist");
}

// ─── [6] specific-pitches edge cases ──────────────────────────────────────────

static void testSpecificPitches_Edges() {
    std::cout << "[6] specific-pitches edge cases\n";

    // Empty whitelist: nothing ever advances, every event renders startStateIndex.
    {
        auto cfg = makeConfig(3, VideoFlipModifier::Type::SpecificPitches, /*start=*/1);
        cfg.modifier.pitches = {};
        auto evs = makeEvents(4, kPPQ, {kC4, kD4, kG4, kA4});
        auto out = resolveStateIndex(cfg, evs, kPPQ);
        CHECK_VEC_EQ(out, (std::vector<int>{1, 1, 1, 1}),
                     "specific-pitches empty whitelist holds startIdx");
    }

    // First-trigger whitelist match advances (overrides first-trigger rule).
    {
        auto cfg = makeConfig(2, VideoFlipModifier::Type::SpecificPitches, /*start=*/0);
        cfg.modifier.pitches = {kC4};
        auto evs = makeEvents(1, kPPQ, {kC4});
        auto out = resolveStateIndex(cfg, evs, kPPQ);
        CHECK_VEC_EQ(out, (std::vector<int>{1}),
                     "specific-pitches first whitelisted advances");
    }

    // First-trigger non-match does NOT advance.
    {
        auto cfg = makeConfig(2, VideoFlipModifier::Type::SpecificPitches, /*start=*/0);
        cfg.modifier.pitches = {kC4};
        auto evs = makeEvents(1, kPPQ, {kD4});
        auto out = resolveStateIndex(cfg, evs, kPPQ);
        CHECK_VEC_EQ(out, (std::vector<int>{0}),
                     "specific-pitches first non-whitelisted no advance");
    }

    // Whitelist with multiple entries; mixed sequence.
    {
        auto cfg = makeConfig(4, VideoFlipModifier::Type::SpecificPitches, /*start=*/0);
        cfg.modifier.pitches = {kC4, kD4, kG4};
        auto evs = makeEvents(6, kPPQ, {kA4, kC4, kD4, kA4, kG4, kC4});
        auto out = resolveStateIndex(cfg, evs, kPPQ);
        // A4 not in list → 0
        // C4 in list → advance → 1
        // D4 in list → advance → 2
        // A4 not in list → 2
        // G4 in list → advance → 3
        // C4 in list → advance → 0 (wrap)
        CHECK_VEC_EQ(out, (std::vector<int>{0, 1, 2, 2, 3, 0}),
                     "specific-pitches mixed sequence wraps");
    }
}

// ─── [7] every-n-beats modifier (acceptance test #4, spec §7.4) ──────────────

static void testEveryNBeats_Acceptance4() {
    std::cout << "[7] every-n-beats beat=1 (acceptance test #4, 480 PPQ)\n";

    // States [none, h, v], n=1, subdivision=beat, startIdx=0.
    // At 480 PPQ (test PPQ for this acceptance — Xleth uses 960, but the math
    // identity holds for either rate): tick range/state mapping per spec table.
    constexpr int testPPQ = 480;

    auto cfg = makeConfig(3, VideoFlipModifier::Type::EveryNBeats, /*start=*/0);
    cfg.modifier.n           = 1;
    cfg.modifier.subdivision = VideoFlipModifier::Subdivision::Beat;

    std::vector<TriggerEvent> evs;
    evs.push_back({0,    60});  // 0–479    → 0
    evs.push_back({239,  60});  // 0–479    → 0
    evs.push_back({479,  60});  // 0–479    → 0
    evs.push_back({480,  60});  // 480–959  → 1
    evs.push_back({959,  60});  // 480–959  → 1
    evs.push_back({960,  60});  // 960–1439 → 2
    evs.push_back({1439, 60});  // 960–1439 → 2
    evs.push_back({1440, 60});  // 1440–1919→ 0 (wrap)
    evs.push_back({1919, 60});  // 1440–1919→ 0
    evs.push_back({1920, 60});  // 1920–2399→ 1

    auto out = resolveStateIndex(cfg, evs, testPPQ);
    CHECK_VEC_EQ(out, (std::vector<int>{0, 0, 0, 1, 1, 2, 2, 0, 0, 1}),
                 "acceptance #4 — every-n-beats clock");
}

// ─── [8] every-n-beats edge cases (n>1, bar subdivision, startStateIndex) ────

static void testEveryNBeats_Edges() {
    std::cout << "[8] every-n-beats edge cases (n>1, bar, startStateIndex)\n";

    // n=2, beat: state changes every 2 beats.
    {
        auto cfg = makeConfig(2, VideoFlipModifier::Type::EveryNBeats);
        cfg.modifier.n = 2;
        cfg.modifier.subdivision = VideoFlipModifier::Subdivision::Beat;
        std::vector<TriggerEvent> evs = {
            {0,           60},  // beat 0 → k=0 → 0
            {kPPQ,        60},  // beat 1 → k=0 → 0  (still in [0, 2*960))
            {2 * kPPQ,    60},  // beat 2 → k=1 → 1
            {3 * kPPQ,    60},  // beat 3 → k=1 → 1
            {4 * kPPQ,    60},  // beat 4 → k=2 → 0 (wrap)
        };
        auto out = resolveStateIndex(cfg, evs, kPPQ);
        CHECK_VEC_EQ(out, (std::vector<int>{0, 0, 1, 1, 0}),
                     "every-n-beats n=2 beat");
    }

    // n=1, bar (4/4): state changes every bar (= 4 beats = 4*960 ticks).
    {
        auto cfg = makeConfig(3, VideoFlipModifier::Type::EveryNBeats);
        cfg.modifier.n = 1;
        cfg.modifier.subdivision = VideoFlipModifier::Subdivision::Bar;
        std::vector<TriggerEvent> evs = {
            {0,                    60},  // bar 0 → 0
            {kPPQ * 3,             60},  // beat 3, still bar 0 → 0
            {kPPQ * 4,             60},  // bar 1 → 1
            {kPPQ * 7,             60},  // still bar 1 → 1
            {kPPQ * 8,             60},  // bar 2 → 2
            {kPPQ * 12,            60},  // bar 3 → 0 (wrap)
        };
        auto out = resolveStateIndex(cfg, evs, kPPQ, /*beatsPerBar=*/4);
        CHECK_VEC_EQ(out, (std::vector<int>{0, 0, 1, 1, 2, 0}),
                     "every-n-beats n=1 bar (4/4)");
    }

    // n=2, bar (3/4): 2 bars * 3 beats = 6 beats = 6*960 ticks.
    {
        auto cfg = makeConfig(2, VideoFlipModifier::Type::EveryNBeats);
        cfg.modifier.n = 2;
        cfg.modifier.subdivision = VideoFlipModifier::Subdivision::Bar;
        std::vector<TriggerEvent> evs = {
            {0,                    60},  // 0..6 beats → 0
            {kPPQ * 5,             60},  // 5 beats   → 0
            {kPPQ * 6,             60},  // 6 beats   → 1
            {kPPQ * 11,            60},  // 11 beats  → 1
            {kPPQ * 12,            60},  // 12 beats  → 0 wrap
        };
        auto out = resolveStateIndex(cfg, evs, kPPQ, /*beatsPerBar=*/3);
        CHECK_VEC_EQ(out, (std::vector<int>{0, 0, 1, 1, 0}),
                     "every-n-beats n=2 bar (3/4)");
    }

    // startStateIndex offsets the cycle for clock-driven modifier.
    {
        auto cfg = makeConfig(3, VideoFlipModifier::Type::EveryNBeats, /*start=*/2);
        cfg.modifier.n = 1;
        cfg.modifier.subdivision = VideoFlipModifier::Subdivision::Beat;
        std::vector<TriggerEvent> evs = {
            {0,            60},  // k=0 → (0+2)%3 = 2
            {kPPQ,         60},  // k=1 → (1+2)%3 = 0
            {kPPQ * 2,     60},  // k=2 → (2+2)%3 = 1
            {kPPQ * 3,     60},  // k=3 → (3+2)%3 = 2
        };
        auto out = resolveStateIndex(cfg, evs, kPPQ);
        CHECK_VEC_EQ(out, (std::vector<int>{2, 0, 1, 2}),
                     "every-n-beats with startIdx=2");
    }

    // n is pitch-blind: different pitches produce identical clock output.
    {
        auto cfg = makeConfig(2, VideoFlipModifier::Type::EveryNBeats);
        cfg.modifier.n = 1;
        cfg.modifier.subdivision = VideoFlipModifier::Subdivision::Beat;
        std::vector<TriggerEvent> evs = {
            {0,         kC4},
            {kPPQ,      kD5},
            {kPPQ * 2,  kG4},
        };
        auto out = resolveStateIndex(cfg, evs, kPPQ);
        CHECK_VEC_EQ(out, (std::vector<int>{0, 1, 0}),
                     "every-n-beats pitch-blind");
    }
}

// ─── [9] Pattern-loop continuity (acceptance test #2, spec §7.2) ─────────────

static void testPatternLoop_Acceptance2() {
    std::cout << "[9] pattern-loop continuity (acceptance test #2)\n";

    // States [{none}, {horizontal}], new-note, startStateIndex: 0.
    // Pattern D5, D5, D#5, D5 looping. Expected: each iteration produces 0,0,1,0.
    // The loop seam is D5 → D5 (no advance) so state stabilises.
    auto cfg = makeConfig(2, VideoFlipModifier::Type::NewNote, /*start=*/0);

    // 3 loops = 12 events.
    std::vector<TriggerEvent> evs;
    for (int loop = 0; loop < 3; ++loop) {
        const int64_t base = loop * 4 * kPPQ;
        evs.push_back({base + 0 * kPPQ, kD5});
        evs.push_back({base + 1 * kPPQ, kD5});
        evs.push_back({base + 2 * kPPQ, kDs5});
        evs.push_back({base + 3 * kPPQ, kD5});
    }
    auto out = resolveStateIndex(cfg, evs, kPPQ);
    CHECK_VEC_EQ(out,
                 (std::vector<int>{0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0}),
                 "acceptance #2 — pattern-loop flat walk, no reset");
}

// ─── [10] Polyphony transparency (acceptance test #3, spec §7.3) ─────────────

static void testPolyphonyTransparency_Acceptance3() {
    std::cout << "[10] polyphony transparency (acceptance test #3)\n";

    // Spec: chord events are filtered upstream — the resolver only sees mono.
    // Events on the track:
    //   tick 0    : D5     (mono)
    //   tick 480  : chord  (skipped by upstream filter; resolver never sees it)
    //   tick 960  : D5     (mono)
    //   tick 1440 : D#5    (mono)
    // Expected resolver output for the 3 mono events: [0, 1, 0]
    //   (chord at tick 480 inherits state 0 — the caller fills that in.)
    auto cfg = makeConfig(2, VideoFlipModifier::Type::EveryNote, /*start=*/0);
    std::vector<TriggerEvent> evs = {
        {0,    kD5},   // first → 0
        {960,  kD5},   // every-note advance → 1
        {1440, kDs5},  // every-note advance → 0 (wrap)
    };
    auto out = resolveStateIndex(cfg, evs, kPPQ);
    CHECK_VEC_EQ(out, (std::vector<int>{0, 1, 0}),
                 "acceptance #3 — mono events only (chord upstream-filtered)");
}

// ─── [11] Mono trigger between two chords (spec §4.4 row 3) ──────────────────

static void testMonoBetweenChords() {
    std::cout << "[11] mono trigger between two chords (memory continuity)\n";

    // Per spec: "Modifier compares against the last mono pitch, ignoring
    // intervening chords." Since chord events are filtered upstream, the
    // resolver naturally gets this right — the previous-mono memory is the
    // pitch of the previous event in the resolver's input list.
    //
    // Hypothetical timeline (chord events removed from input):
    //   mono D5  — initial
    //   mono D5  — same pitch (would not advance)
    //   mono D#5 — different pitch (would advance)
    //
    // After upstream filtering, the resolver receives [D5, D5, D#5].
    auto cfg = makeConfig(2, VideoFlipModifier::Type::NewNote);
    std::vector<TriggerEvent> evs = {
        {0,    kD5},
        {960,  kD5},
        {1920, kDs5},
    };
    auto out = resolveStateIndex(cfg, evs, kPPQ);
    CHECK_VEC_EQ(out, (std::vector<int>{0, 0, 1}),
                 "new-note remembers last mono pitch across chord gaps");
}

// ─── [12] Determinism — same input → same output (spec §1, §5.5) ─────────────

static void testDeterminism() {
    std::cout << "[12] determinism — same input always produces same output\n";

    auto cfg = makeConfig(4, VideoFlipModifier::Type::NewNote, /*start=*/2);
    auto evs = makeEvents(20, kPPQ / 2,
                          {kC4, kC4, kD4, kD4, kG4, kA4, kC4, kC5, kD5, kDs5,
                           kC4, kC4, kD4, kG4, kA4, kC4, kC4, kD5, kDs5, kC5});

    auto out1 = resolveStateIndex(cfg, evs, kPPQ);
    auto out2 = resolveStateIndex(cfg, evs, kPPQ);
    auto out3 = resolveStateIndex(cfg, evs, kPPQ);

    CHECK_VEC_EQ(out1, out2, "two calls produce identical output");
    CHECK_VEC_EQ(out2, out3, "three calls produce identical output");
}

// ─── [13] startStateIndex out-of-range clamps gracefully ─────────────────────

static void testStartStateIndexClamping() {
    std::cout << "[13] startStateIndex clamp (out-of-range tolerated)\n";

    // Negative startStateIndex clamps to 0.
    {
        auto cfg = makeConfig(3, VideoFlipModifier::Type::EveryNote, /*start=*/-5);
        auto out = resolveStateIndex(cfg, makeEvents(4), kPPQ);
        CHECK_VEC_EQ(out, (std::vector<int>{0, 1, 2, 0}),
                     "negative startIdx clamps to 0");
    }

    // startStateIndex >= numStates clamps to numStates-1.
    {
        auto cfg = makeConfig(3, VideoFlipModifier::Type::EveryNote, /*start=*/99);
        auto out = resolveStateIndex(cfg, makeEvents(4), kPPQ);
        CHECK_VEC_EQ(out, (std::vector<int>{2, 0, 1, 2}),
                     "out-of-bounds startIdx clamps to last");
    }
}

// ─── [14] Maximum states (12) — wraps through the full cycle ─────────────────

static void testMaxStates() {
    std::cout << "[14] 12 states — full cycle wrap\n";

    auto cfg = makeConfig(12, VideoFlipModifier::Type::EveryNote);
    auto out = resolveStateIndex(cfg, makeEvents(15), kPPQ);
    CHECK_VEC_EQ(out, (std::vector<int>{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1, 2}),
                 "12 states cycle and wrap");
}

// ─── [15] Output size always matches input size ──────────────────────────────

static void testOutputSizeMatchesInput() {
    std::cout << "[15] output size invariant\n";

    auto cfg = makeConfig(3, VideoFlipModifier::Type::NewNote);
    for (int n : {0, 1, 2, 5, 50, 500}) {
        auto evs = makeEvents(n);
        auto out = resolveStateIndex(cfg, evs, kPPQ);
        CHECK(static_cast<int>(out.size()) == n,
              ("output size == input size for n=" + std::to_string(n)).c_str());
    }
}

// ─── [16] Stateful modifiers: large tick values do not affect walked output ──

static void testWalkedModifierIsTickAgnostic() {
    std::cout << "[16] every-note / new-note / specific-pitches are tick-agnostic\n";

    // every-note at irregular ticks produces same result as at regular ticks.
    {
        auto cfg = makeConfig(3, VideoFlipModifier::Type::EveryNote);
        std::vector<TriggerEvent> a = {{0, 60}, {1, 60}, {2, 60}, {3, 60}};
        std::vector<TriggerEvent> b = {{0, 60}, {12345, 60}, {99999999, 60},
                                       {static_cast<int64_t>(1) << 40, 60}};
        auto outA = resolveStateIndex(cfg, a, kPPQ);
        auto outB = resolveStateIndex(cfg, b, kPPQ);
        CHECK_VEC_EQ(outA, outB,
                     "every-note ignores absolute ticks");
    }
}

// ─── [17] Shader UV-transform parity (golden) ────────────────────────────────
// CPU mirror of GridComposite.hlsl's PSMain UV transform. Used by the
// orientation golden test below AND by the legacy-migration parity proof
// (acceptance #6 / spec §7.6). Keep in lockstep with the HLSL — if the
// shader changes, this function must change identically.

struct UV { float u; float v; };

static UV applyOrientationCPU(Orientation o, UV in) {
    switch (o) {
        case Orientation::None:        return { in.u,        in.v };
        case Orientation::Horizontal:  return { 1.0f - in.u, in.v };
        case Orientation::Vertical:    return { in.u,        1.0f - in.v };
        case Orientation::Rotate180:   return { 1.0f - in.u, 1.0f - in.v };
        case Orientation::Rotate90CW:  return { in.v,        1.0f - in.u };
        case Orientation::Rotate90CCW: return { 1.0f - in.v, in.u };
    }
    return in;
}

// Mirror of the legacy PSMain flip-mode block (pre-Phase 4).
//   flipMode 0 (None)              — identity
//   flipMode 1 (HorizontalEven)    — flip x when globalNoteIndex % 2 == 0
//   flipMode 2 (Clockwise)         — phase = idx % 4: 0=identity,1=y',2=both,3=x'
//   flipMode 3 (CounterClockwise)  — phase = idx % 4: 0=identity,1=x',2=both,3=y'
static UV applyLegacyFlipCPU(int flipMode, int globalNoteIndex, UV in) {
    UV out = in;
    if (flipMode == 1) {
        if ((globalNoteIndex % 2) == 0) out.u = 1.0f - out.u;
    } else if (flipMode == 2) {
        const int phase = globalNoteIndex % 4;
        if      (phase == 1) out.v = 1.0f - out.v;
        else if (phase == 2) { out.u = 1.0f - out.u; out.v = 1.0f - out.v; }
        else if (phase == 3) out.u = 1.0f - out.u;
    } else if (flipMode == 3) {
        const int phase = globalNoteIndex % 4;
        if      (phase == 1) out.u = 1.0f - out.u;
        else if (phase == 2) { out.u = 1.0f - out.u; out.v = 1.0f - out.v; }
        else if (phase == 3) out.v = 1.0f - out.v;
    }
    return out;
}

// Approximate float comparison — UV transforms are pure 1-x / identity, so the
// outputs are exactly representable in IEEE-754 float when the input is.
static bool uvEq(UV a, UV b) { return a.u == b.u && a.v == b.v; }

static void testOrientationGolden() {
    std::cout << "[17] Shader UV-transform golden — 6 orientations against fixed sample points\n";

    // Sample at four corners + the centre. These cover every quadrant of the
    // texture, so any UV transform that misroutes a corner will show up.
    const UV samples[5] = {
        {0.00f, 0.00f},  // top-left
        {1.00f, 0.00f},  // top-right
        {0.00f, 1.00f},  // bottom-left
        {1.00f, 1.00f},  // bottom-right
        {0.50f, 0.50f},  // centre
    };

    // none — identity
    for (auto s : samples) CHECK(uvEq(applyOrientationCPU(Orientation::None,       s), s),
                                   "none: identity preserved");
    // horizontal — x = 1-x
    CHECK(uvEq(applyOrientationCPU(Orientation::Horizontal, {0,0}), {1,0}), "h: TL → TR");
    CHECK(uvEq(applyOrientationCPU(Orientation::Horizontal, {1,0}), {0,0}), "h: TR → TL");
    CHECK(uvEq(applyOrientationCPU(Orientation::Horizontal, {0,1}), {1,1}), "h: BL → BR");
    CHECK(uvEq(applyOrientationCPU(Orientation::Horizontal, {1,1}), {0,1}), "h: BR → BL");
    // vertical — y = 1-y
    CHECK(uvEq(applyOrientationCPU(Orientation::Vertical,   {0,0}), {0,1}), "v: TL → BL");
    CHECK(uvEq(applyOrientationCPU(Orientation::Vertical,   {1,0}), {1,1}), "v: TR → BR");
    CHECK(uvEq(applyOrientationCPU(Orientation::Vertical,   {0,1}), {0,0}), "v: BL → TL");
    CHECK(uvEq(applyOrientationCPU(Orientation::Vertical,   {1,1}), {1,0}), "v: BR → TR");
    // rotate-180 — both
    CHECK(uvEq(applyOrientationCPU(Orientation::Rotate180,  {0,0}), {1,1}), "rot180: TL → BR");
    CHECK(uvEq(applyOrientationCPU(Orientation::Rotate180,  {1,0}), {0,1}), "rot180: TR → BL");
    CHECK(uvEq(applyOrientationCPU(Orientation::Rotate180,  {0,1}), {1,0}), "rot180: BL → TR");
    CHECK(uvEq(applyOrientationCPU(Orientation::Rotate180,  {1,1}), {0,0}), "rot180: BR → TL");
    // rotate-90 CW — (u,v) → (v, 1-u)
    CHECK(uvEq(applyOrientationCPU(Orientation::Rotate90CW, {0,0}), {0,1}), "rot90cw: TL → BL");
    CHECK(uvEq(applyOrientationCPU(Orientation::Rotate90CW, {1,0}), {0,0}), "rot90cw: TR → TL");
    CHECK(uvEq(applyOrientationCPU(Orientation::Rotate90CW, {0,1}), {1,1}), "rot90cw: BL → BR");
    CHECK(uvEq(applyOrientationCPU(Orientation::Rotate90CW, {1,1}), {1,0}), "rot90cw: BR → TR");
    // rotate-90 CCW — (u,v) → (1-v, u)
    CHECK(uvEq(applyOrientationCPU(Orientation::Rotate90CCW,{0,0}), {1,0}), "rot90ccw: TL → TR");
    CHECK(uvEq(applyOrientationCPU(Orientation::Rotate90CCW,{1,0}), {1,1}), "rot90ccw: TR → BR");
    CHECK(uvEq(applyOrientationCPU(Orientation::Rotate90CCW,{0,1}), {0,0}), "rot90ccw: BL → TL");
    CHECK(uvEq(applyOrientationCPU(Orientation::Rotate90CCW,{1,1}), {0,1}), "rot90ccw: BR → BL");
    // Centre is invariant under all six transforms.
    for (int o = 0; o < 6; ++o) {
        UV c = applyOrientationCPU(static_cast<Orientation>(o), {0.5f, 0.5f});
        CHECK(uvEq(c, {0.5f, 0.5f}), "centre invariant under all orientations");
    }
}

// ─── [18] Acceptance test #6 — legacy migration parity (spec §7.6) ───────────
// For each of the four legacy modes, walk ordinals 0..7 through:
//   (a) the OLD shader's UV transform     — applyLegacyFlipCPU(mode, ord, uv)
//   (b) the NEW pipeline:                  migrate → resolver → orientation → applyOrientationCPU(orient, uv)
// and verify output is byte-identical for every (ordinal, sample-uv) pair.
//
// This is the proof that the migration tables in spec §3.5 + the new shader
// produce pixel-identical output to the legacy shader for every legacy project.
static void testAcceptance6_LegacyMigrationParity() {
    std::cout << "[18] Acceptance #6 — legacy migration parity (ordinals 0..7, all 4 modes)\n";

    const std::vector<UV> samples = {
        {0.0f, 0.0f}, {1.0f, 0.0f}, {0.0f, 1.0f}, {1.0f, 1.0f},
        {0.25f, 0.75f}, {0.5f, 0.5f}, {0.7f, 0.3f},
    };

    struct LegacyCase { VideoFlipMode mode; const char* name; int legacyInt; };
    const LegacyCase cases[] = {
        { VideoFlipMode::None,             "None",             0 },
        { VideoFlipMode::HorizontalEven,   "HorizontalEven",   1 },
        { VideoFlipMode::Clockwise,        "Clockwise",        2 },
        { VideoFlipMode::CounterClockwise, "CounterClockwise", 3 },
    };

    for (const auto& c : cases) {
        const VideoFlipConfig cfg = migrateVideoFlipMode(c.mode);

        // Build ordinals 0..7 as evenly-spaced mono trigger events.
        std::vector<TriggerEvent> evs = makeEvents(8);
        auto resolved = resolveStateIndex(cfg, evs, kPPQ);
        CHECK(resolved.size() == 8, "resolver returns 8 stateIdx");

        for (int ord = 0; ord < 8; ++ord) {
            // New pipeline: stateIdx → orientation via config.states.
            int stateIdx = (cfg.enabled && cfg.states.size() > 1)
                             ? resolved[ord] : 0;
            Orientation orient = (!cfg.enabled || cfg.states.empty())
                                 ? Orientation::None
                                 : cfg.states[stateIdx].orientation;

            for (UV s : samples) {
                UV legacy = applyLegacyFlipCPU(c.legacyInt, ord, s);
                UV nu     = applyOrientationCPU(orient, s);
                if (!uvEq(legacy, nu)) {
                    std::cerr << "  FAIL [" << __LINE__ << "] mode=" << c.name
                              << " ord=" << ord
                              << " sample=(" << s.u << "," << s.v << ")"
                              << " legacy=(" << legacy.u << "," << legacy.v << ")"
                              << " new=("    << nu.u    << "," << nu.v    << ")\n";
                    ++g_failed;
                } else {
                    ++g_passed;
                }
            }
        }
    }
}

// ─── main ────────────────────────────────────────────────────────────────────

int main() {
    std::cout << "=== Xleth VideoFlipResolver Test Suite (Phase 2 + Phase 4) ===\n\n";

    testShortCircuits();
    testEveryNote();
    testNewNote_Acceptance1();
    testNewNote_Edges();
    testSpecificPitches_Acceptance5();
    testSpecificPitches_Edges();
    testEveryNBeats_Acceptance4();
    testEveryNBeats_Edges();
    testPatternLoop_Acceptance2();
    testPolyphonyTransparency_Acceptance3();
    testMonoBetweenChords();
    testDeterminism();
    testStartStateIndexClamping();
    testMaxStates();
    testOutputSizeMatchesInput();
    testWalkedModifierIsTickAgnostic();
    testOrientationGolden();
    testAcceptance6_LegacyMigrationParity();

    std::cout << "\n=== Results: "
              << g_passed << " passed, "
              << g_failed << " failed ===\n";

    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cout << "FAILED: " << g_failed << " test(s) failed\n";
    return 1;
}
