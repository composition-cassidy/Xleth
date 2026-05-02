// test_video_flip_applier.cpp
// Unit tests for the VideoFlipApplier — Phase 3 single-call-site wrapper that
// runs per-track chord detection + the pure resolver + writes back
// monoOrdinal / stateIndex / orientation onto VideoEvents.
//
// Coverage map:
//   §4.4 row 1 — first mono trigger never advances           (testFirstMonoNoAdvance)
//   §4.4 row 2 — chord event renders prior mono state         (testChordInheritsState)
//   §4.4 row 3 — mono trigger between chords keeps memory     (testMonoBetweenChords)
//   §4.4 row 4 — pattern loop (no reset)                      (covered in resolver tests)
//   §3.1       — disabled config = identity                    (testDisabledShortCircuit)
//   §4.3       — chord ≥2 onsets at same tick → mono ord = -1  (testChordDetection)
//   §1         — startStateIndex inherited by chord-with-no-mono (testChordBeforeAnyMono)
//   misc       — multi-track applyAll grouping                  (testMultiTrackApplyAll)
//
// Build target: test_video_flip_applier (engine/CMakeLists.txt)

#include "render/VideoFlipApplier.h"
#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "SyncManager.h"   // VideoEvent

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

static constexpr int kPPQ = 960;

// Produce a minimal VideoEvent at the given beat + pitch. Other fields are
// irrelevant to the applier and left at their defaults.
static VideoEvent makeEvent(double beat, int pitch, int trackId = 1) {
    VideoEvent ev;
    ev.startBeat = beat;
    ev.pitch     = pitch;
    ev.trackId   = trackId;
    return ev;
}

// Build a 2-state HorizontalEven-style config: [none, horizontal], every-note,
// startStateIndex = 0 (so ordinal 0 → state 0, ordinal 1 → state 1, wrap).
static VideoFlipConfig configHorizontalEven() {
    VideoFlipConfig cfg;
    cfg.enabled         = true;
    cfg.startStateIndex = 0;
    cfg.states = {
        {"s0", Orientation::None,       ""},
        {"s1", Orientation::Horizontal, ""},
    };
    cfg.modifier.type = VideoFlipModifier::Type::EveryNote;
    return cfg;
}

// ─── [1] Disabled config short-circuits to identity ───────────────────────────

static void testDisabledShortCircuit() {
    std::cout << "[1] Disabled config -> identity, monoOrdinal = -1\n";

    auto cfg = configHorizontalEven();
    cfg.enabled = false;

    std::vector<VideoEvent> events = {
        makeEvent(0.0, 60), makeEvent(1.0, 62), makeEvent(2.0, 64),
    };
    std::vector<VideoEvent*> ptrs = { &events[0], &events[1], &events[2] };

    videoFlipApplier::applyTrack(ptrs, cfg, kPPQ);

    for (const auto& ev : events) {
        CHECK(ev.monoOrdinal == -1,                      "disabled: monoOrdinal=-1");
        CHECK(ev.stateIndex  == 0,                       "disabled: stateIndex=0");
        CHECK(ev.orientation == Orientation::None,       "disabled: orientation=None");
    }
}

// ─── [2] First mono trigger never advances (every-note) ──────────────────────

static void testFirstMonoNoAdvance() {
    std::cout << "[2] First mono trigger never advances\n";

    auto cfg = configHorizontalEven();
    std::vector<VideoEvent> events = {
        makeEvent(0.0, 60),
        makeEvent(1.0, 60),
        makeEvent(2.0, 60),
    };
    std::vector<VideoEvent*> ptrs = { &events[0], &events[1], &events[2] };

    videoFlipApplier::applyTrack(ptrs, cfg, kPPQ);

    CHECK(events[0].monoOrdinal == 0 && events[0].stateIndex == 0,
          "ord 0 -> state 0 (no advance on first)");
    CHECK(events[1].monoOrdinal == 1 && events[1].stateIndex == 1,
          "ord 1 -> state 1 (advance)");
    CHECK(events[2].monoOrdinal == 2 && events[2].stateIndex == 0,
          "ord 2 -> state 0 (advance, wrap)");
    CHECK(events[0].orientation == Orientation::None,        "ev0 orientation=none");
    CHECK(events[1].orientation == Orientation::Horizontal,  "ev1 orientation=horizontal");
    CHECK(events[2].orientation == Orientation::None,        "ev2 orientation=none (wrap)");
}

// ─── [3] Chord detection: ≥2 events at same tick → mono ord = -1 ─────────────

static void testChordDetection() {
    std::cout << "[3] Chord detection (>=2 events at same tick)\n";

    auto cfg = configHorizontalEven();
    // Three events at tick 0 (chord), then a mono event at tick 960.
    std::vector<VideoEvent> events = {
        makeEvent(0.0, 60),  // chord member
        makeEvent(0.0, 64),  // chord member
        makeEvent(0.0, 67),  // chord member
        makeEvent(1.0, 70),  // mono
    };
    std::vector<VideoEvent*> ptrs;
    for (auto& e : events) ptrs.push_back(&e);

    videoFlipApplier::applyTrack(ptrs, cfg, kPPQ);

    CHECK(events[0].monoOrdinal == -1, "chord member 0 -> monoOrdinal=-1");
    CHECK(events[1].monoOrdinal == -1, "chord member 1 -> monoOrdinal=-1");
    CHECK(events[2].monoOrdinal == -1, "chord member 2 -> monoOrdinal=-1");
    CHECK(events[3].monoOrdinal == 0,  "lone mono after chord -> monoOrdinal=0");
}

// ─── [4] Chord events inherit prior mono's stateIndex ────────────────────────

static void testChordInheritsState() {
    std::cout << "[4] Chord events render prior mono state, do not advance\n";

    auto cfg = configHorizontalEven();  // 2 states, every-note, startIdx=0
    // Sequence on one track:
    //   tick 0    : mono D5     (first → state 0, no advance)
    //   tick 960  : mono D#5    (advance → state 1)
    //   tick 1920 : chord [E5, G5]  (transparent: state 1 inherited, no advance)
    //   tick 2880 : mono A5     (advance → state 0 wrap)
    std::vector<VideoEvent> events = {
        makeEvent(0.0, 74),   // mono
        makeEvent(1.0, 75),   // mono
        makeEvent(2.0, 76),   // chord
        makeEvent(2.0, 79),   // chord
        makeEvent(3.0, 81),   // mono
    };
    std::vector<VideoEvent*> ptrs;
    for (auto& e : events) ptrs.push_back(&e);

    videoFlipApplier::applyTrack(ptrs, cfg, kPPQ);

    CHECK(events[0].stateIndex  == 0 && events[0].monoOrdinal == 0,
          "ev0 mono first -> state 0, ord 0");
    CHECK(events[1].stateIndex  == 1 && events[1].monoOrdinal == 1,
          "ev1 mono advance -> state 1, ord 1");
    CHECK(events[2].stateIndex  == 1 && events[2].monoOrdinal == -1,
          "ev2 chord inherits state 1, ord -1");
    CHECK(events[3].stateIndex  == 1 && events[3].monoOrdinal == -1,
          "ev3 chord inherits state 1, ord -1");
    CHECK(events[4].stateIndex  == 0 && events[4].monoOrdinal == 2,
          "ev4 mono advance after chord -> state 0 (wrap), ord 2");
}

// ─── [5] new-note across chord gap remembers last mono pitch ─────────────────

static void testMonoBetweenChords() {
    std::cout << "[5] new-note remembers last mono pitch across chord events\n";

    VideoFlipConfig cfg;
    cfg.enabled         = true;
    cfg.startStateIndex = 0;
    cfg.states = {
        {"s0", Orientation::None,       ""},
        {"s1", Orientation::Horizontal, ""},
        {"s2", Orientation::Vertical,   ""},
    };
    cfg.modifier.type = VideoFlipModifier::Type::NewNote;

    // tick 0    : mono D5  (first → state 0)
    // tick 1920 : chord [G5, C6]  (inherits state 0)
    // tick 2880 : mono D5  (same pitch as last mono → no advance, state 0)
    // tick 3840 : mono D#5 (different from last mono D5 → advance → state 1)
    std::vector<VideoEvent> events = {
        makeEvent(0.0, 74),
        makeEvent(2.0, 79),    // chord
        makeEvent(2.0, 84),    // chord
        makeEvent(3.0, 74),    // mono D5 again
        makeEvent(4.0, 75),    // mono D#5
    };
    std::vector<VideoEvent*> ptrs;
    for (auto& e : events) ptrs.push_back(&e);

    videoFlipApplier::applyTrack(ptrs, cfg, kPPQ);

    CHECK(events[0].stateIndex  == 0,                "ev0 first mono D5 -> state 0");
    CHECK(events[1].stateIndex  == 0 && events[1].monoOrdinal == -1,
          "ev1 chord inherits state 0");
    CHECK(events[2].stateIndex  == 0 && events[2].monoOrdinal == -1,
          "ev2 chord inherits state 0");
    CHECK(events[3].stateIndex  == 0,                "ev3 D5 again (same as last mono) -> state 0");
    CHECK(events[3].monoOrdinal == 1,                "ev3 monoOrdinal = 1");
    CHECK(events[4].stateIndex  == 1,                "ev4 D#5 (different) -> state 1");
    CHECK(events[4].monoOrdinal == 2,                "ev4 monoOrdinal = 2");
}

// ─── [6] Chord before any mono inherits startStateIndex ──────────────────────

static void testChordBeforeAnyMono() {
    std::cout << "[6] Chord with no prior mono -> startStateIndex\n";

    auto cfg = configHorizontalEven();
    cfg.startStateIndex = 1;   // start cycle on state 1

    // First two events form a chord at tick 0; no prior mono.
    std::vector<VideoEvent> events = {
        makeEvent(0.0, 60),   // chord
        makeEvent(0.0, 64),   // chord
        makeEvent(1.0, 67),   // mono after chord
    };
    std::vector<VideoEvent*> ptrs;
    for (auto& e : events) ptrs.push_back(&e);

    videoFlipApplier::applyTrack(ptrs, cfg, kPPQ);

    CHECK(events[0].stateIndex  == 1 && events[0].monoOrdinal == -1,
          "chord-before-mono -> startStateIndex=1");
    CHECK(events[1].stateIndex  == 1 && events[1].monoOrdinal == -1,
          "chord-before-mono (2nd) -> startStateIndex=1");
    // First mono trigger after the chord: every-note, startIdx=1, no advance on first
    // → state 1.
    CHECK(events[2].stateIndex  == 1 && events[2].monoOrdinal == 0,
          "first mono after chord-only opening -> state 1, ord 0");
}

// ─── [7] applyAll groups by trackId and routes to per-track config ───────────

static void testMultiTrackApplyAll() {
    std::cout << "[7] applyAll: per-track grouping uses each track's config\n";

    Timeline tl(120.0, 48000.0, 4, 4);

    // Track A: 2-state HorizontalEven cycle.
    TrackInfo ta;
    ta.name = "A";
    ta.videoFlipConfig = configHorizontalEven();
    int idA = tl.addTrack(ta);

    // Track B: disabled — every event identity.
    TrackInfo tb;
    tb.name = "B";
    tb.videoFlipConfig = configHorizontalEven();
    tb.videoFlipConfig.enabled = false;
    int idB = tl.addTrack(tb);

    // Interleave events across both tracks (out of trackId order on purpose).
    std::vector<VideoEvent> events = {
        makeEvent(0.0, 60, idA),
        makeEvent(0.0, 60, idB),
        makeEvent(1.0, 60, idA),
        makeEvent(1.0, 60, idB),
        makeEvent(2.0, 60, idA),
    };

    videoFlipApplier::applyAll(events, tl);

    // Track A walks 0,1,0
    CHECK(events[0].trackId == idA && events[0].stateIndex == 0,
          "A ev0 state=0 (first)");
    CHECK(events[2].trackId == idA && events[2].stateIndex == 1,
          "A ev2 state=1 (advance)");
    CHECK(events[4].trackId == idA && events[4].stateIndex == 0,
          "A ev4 state=0 (wrap)");

    // Track B is disabled — every event is identity, monoOrdinal=-1.
    CHECK(events[1].stateIndex  == 0 && events[1].monoOrdinal == -1,
          "B disabled ev1 stateIndex=0 monoOrdinal=-1");
    CHECK(events[3].stateIndex  == 0 && events[3].monoOrdinal == -1,
          "B disabled ev3 stateIndex=0 monoOrdinal=-1");
    CHECK(events[1].orientation == Orientation::None,  "B disabled ev1 orientation=None");
    CHECK(events[3].orientation == Orientation::None,  "B disabled ev3 orientation=None");
}

// ─── [8] Empty input is a no-op ──────────────────────────────────────────────

static void testEmptyInput() {
    std::cout << "[8] Empty inputs are no-ops\n";

    auto cfg = configHorizontalEven();
    std::vector<VideoEvent*> emptyPtrs;
    videoFlipApplier::applyTrack(emptyPtrs, cfg, kPPQ);  // must not crash
    CHECK(emptyPtrs.empty(), "applyTrack empty -> no change");

    Timeline tl(120.0, 48000.0, 4, 4);
    std::vector<VideoEvent> emptyEvents;
    videoFlipApplier::applyAll(emptyEvents, tl);  // must not crash
    CHECK(emptyEvents.empty(), "applyAll empty -> no change");
}

// ─── [9] Out-of-order input is sorted by tick before resolution ──────────────

static void testOutOfOrderSort() {
    std::cout << "[9] Out-of-order events are sorted by tick before resolution\n";

    auto cfg = configHorizontalEven();
    // Build events out of timeline order to confirm the applier sorts them.
    std::vector<VideoEvent> events = {
        makeEvent(2.0, 60),   // ord 2 after sort -> state 0 (wrap)
        makeEvent(0.0, 60),   // ord 0 after sort -> state 0
        makeEvent(1.0, 60),   // ord 1 after sort -> state 1
    };
    std::vector<VideoEvent*> ptrs = { &events[0], &events[1], &events[2] };

    videoFlipApplier::applyTrack(ptrs, cfg, kPPQ);

    // Lookup by original index (events[0] is at beat 2.0, events[1] at 0.0, events[2] at 1.0).
    CHECK(events[1].stateIndex == 0 && events[1].monoOrdinal == 0,
          "earliest event (beat 0) -> state 0, ord 0");
    CHECK(events[2].stateIndex == 1 && events[2].monoOrdinal == 1,
          "middle event (beat 1) -> state 1, ord 1");
    CHECK(events[0].stateIndex == 0 && events[0].monoOrdinal == 2,
          "latest event (beat 2) -> state 0 wrap, ord 2");
}

// ─── main ────────────────────────────────────────────────────────────────────

int main() {
    std::cout << "=== Xleth VideoFlipApplier Test Suite (Phase 3) ===\n\n";

    testDisabledShortCircuit();
    testFirstMonoNoAdvance();
    testChordDetection();
    testChordInheritsState();
    testMonoBetweenChords();
    testChordBeforeAnyMono();
    testMultiTrackApplyAll();
    testEmptyInput();
    testOutOfOrderSort();

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
