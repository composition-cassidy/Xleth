// test_video_flip_applier.cpp
// Unit tests for the VideoFlipApplier — Phase 3 single-call-site wrapper that
// runs per-track trigger grouping + the pure resolver + writes back
// monoOrdinal / stateIndex / orientation onto VideoEvents.
//
// Coverage map:
//   §4.4 row 1 — first mono trigger never advances           (testFirstMonoNoAdvance)
//   all modifiers — same-tick note stack collapses to ONE flip
//               trigger; every member shares one group ordinal
//               and one resolved state                        (testEveryNoteChordTriggers)
//   §4.4 row 3 — new-note "previous pitch" memory is updated by
//               a chord's identity (lowest) pitch, same as any
//               other trigger                                 (testMonoBetweenChords)
//   §4.4 row 4 — pattern loop (no reset)                      (covered in resolver tests)
//   §3.1       — disabled config = identity                    (testDisabledShortCircuit)
//   §1         — startStateIndex honored for first chord note  (testChordBeforeAnyMono)
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

static VideoFlipConfig configEveryNoteStates(int count) {
    VideoFlipConfig cfg;
    cfg.enabled = true;
    cfg.startStateIndex = 0;
    cfg.modifier.type = VideoFlipModifier::Type::EveryNote;
    static const Orientation cycle[6] = {
        Orientation::None,
        Orientation::Horizontal,
        Orientation::Vertical,
        Orientation::Rotate180,
        Orientation::Rotate90CW,
        Orientation::Rotate90CCW,
    };
    for (int i = 0; i < count; ++i) {
        cfg.states.push_back({"s" + std::to_string(i), cycle[i % 6], ""});
    }
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

// ─── [3] Same-tick chord collapses to ONE flip trigger ──────────────────────

static void testEveryNoteChordTriggers() {
    std::cout << "[3] EveryNote same-tick chord collapses to ONE trigger\n";

    auto cfg = configHorizontalEven();
    // Three events at tick 0 (chord), then a single event at tick 960.
    std::vector<VideoEvent> events = {
        makeEvent(0.0, 60),  // chord member
        makeEvent(0.0, 64),  // chord member
        makeEvent(0.0, 67),  // chord member
        makeEvent(1.0, 70),  // mono
    };
    std::vector<VideoEvent*> ptrs;
    for (auto& e : events) ptrs.push_back(&e);

    videoFlipApplier::applyTrack(ptrs, cfg, kPPQ);

    // All three chord members share ONE group (ordinal 0) and ONE state — the
    // chord is a single trigger, so it does not advance past the first-trigger
    // rule any more than a single mono note would.
    CHECK(events[0].monoOrdinal == 0 && events[0].stateIndex == 0,
          "chord member 0 -> group 0, state 0 (first trigger, no advance)");
    CHECK(events[1].monoOrdinal == 0 && events[1].stateIndex == 0,
          "chord member 1 -> group 0, state 0 (same group as member 0)");
    CHECK(events[2].monoOrdinal == 0 && events[2].stateIndex == 0,
          "chord member 2 -> group 0, state 0 (same group as member 0)");
    CHECK(events[3].monoOrdinal == 1 && events[3].stateIndex == 1,
          "single after chord -> group 1, state 1 (advance)");
}

static void testEveryNoteFourNoteStackTriggersEveryMember() {
    std::cout << "[3b] EveryNote 4-note stack collapses to ONE trigger\n";

    auto cfg = configEveryNoteStates(4);
    std::vector<VideoEvent> events = {
        makeEvent(0.0, 72),  // source order 20
        makeEvent(0.0, 60),  // source order 21
        makeEvent(0.0, 64),  // source order 22
        makeEvent(0.0, 67),  // source order 23
        makeEvent(1.0, 76),  // immediately after the stack
    };

    for (int i = 0; i < 4; ++i) {
        events[static_cast<std::size_t>(i)].hasSourceTriggerOrder = true;
        events[static_cast<std::size_t>(i)].sourceTriggerOrder = 20 + i;
        events[static_cast<std::size_t>(i)].originalEmissionOrder = i;
    }
    events[4].hasSourceTriggerOrder = true;
    events[4].sourceTriggerOrder = 24;
    events[4].originalEmissionOrder = 4;

    std::vector<VideoEvent*> ptrs;
    for (auto& e : events) ptrs.push_back(&e);

    videoFlipApplier::applyTrack(ptrs, cfg, kPPQ);

    // All four stack members are ONE group (ordinal 0) — a same-tick note
    // stack is a single flip trigger regardless of size.
    for (int i = 0; i < 4; ++i) {
        const auto& ev = events[static_cast<std::size_t>(i)];
        CHECK(ev.monoOrdinal == 0,
              "4-note stack: every member shares group 0");
        CHECK(ev.stateIndex == 0,
              "4-note stack: every member shares state 0 (first trigger, no advance)");
        CHECK(ev.orientation == cfg.states[0].orientation,
              "4-note stack: every member shares the group's orientation");
    }
    CHECK(events[4].monoOrdinal == 1 && events[4].stateIndex == 1,
          "next note after the stack advances to group 1, state 1");
}

// ─── [4] Chord followed by single advances immediately ──────────────────────

static void testSameTickUsesSourceOrderBeforePitch() {
    std::cout << "[3a] Same-tick chord collapse is order- and pitch-independent (EveryNote)\n";

    // A same-tick note stack is a single flip trigger regardless of its
    // members' source order or pitch order — EveryNote doesn't consult either
    // when deciding whether/how much to advance.
    auto cfg = configEveryNoteStates(6);
    std::vector<VideoEvent> events = {
        makeEvent(0.0, 72),  // source order 10, pitch highest
        makeEvent(0.0, 60),  // source order 11, pitch lowest
        makeEvent(0.0, 67),  // source order 12
    };
    events[0].hasSourceTriggerOrder = true;
    events[0].sourceTriggerOrder = 10;
    events[0].originalEmissionOrder = 0;
    events[1].hasSourceTriggerOrder = true;
    events[1].sourceTriggerOrder = 11;
    events[1].originalEmissionOrder = 1;
    events[2].hasSourceTriggerOrder = true;
    events[2].sourceTriggerOrder = 12;
    events[2].originalEmissionOrder = 2;

    std::vector<VideoEvent*> ptrs;
    for (auto& e : events) ptrs.push_back(&e);

    videoFlipApplier::applyTrack(ptrs, cfg, kPPQ);

    CHECK(events[0].monoOrdinal == 0 && events[0].orientation == Orientation::None,
          "chord member (source order 10) -> group 0, first trigger no advance");
    CHECK(events[1].monoOrdinal == 0 && events[1].orientation == Orientation::None,
          "chord member (source order 11) -> group 0, same as member above");
    CHECK(events[2].monoOrdinal == 0 && events[2].orientation == Orientation::None,
          "chord member (source order 12) -> group 0, same as member above");
}

static void testChordFollowedBySingle() {
    std::cout << "[4] EveryNote chord (one trigger) followed by single advances\n";

    auto cfg = configHorizontalEven();  // 2 states, every-note, startIdx=0
    // Sequence on one track:
    //   tick 0    : mono D5        (first → state 0, no advance)
    //   tick 960  : mono D#5       (advance → state 1)
    //   tick 1920 : chord [E5, G5] (ONE trigger → advance → state 0 wrap;
    //                                both members share group 2 / state 0)
    //   tick 2880 : mono A5        (advance → state 1)
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
    CHECK(events[2].stateIndex  == 0 && events[2].monoOrdinal == 2,
          "ev2 chord group advances -> state 0, ord 2");
    CHECK(events[3].stateIndex  == 0 && events[3].monoOrdinal == 2,
          "ev3 chord member shares ev2's group -> state 0, ord 2");
    CHECK(events[4].stateIndex  == 1 && events[4].monoOrdinal == 3,
          "ev4 single after chord advances -> state 1, ord 3");
}

// ─── [5] new-note: a chord's identity pitch feeds "previous pitch" memory ────

static void testMonoBetweenChords() {
    std::cout << "[5] new-note: chord (one trigger) updates last-pitch memory via its identity pitch\n";

    VideoFlipConfig cfg;
    cfg.enabled         = true;
    cfg.startStateIndex = 0;
    cfg.states = {
        {"s0", Orientation::None,       ""},
        {"s1", Orientation::Horizontal, ""},
        {"s2", Orientation::Vertical,   ""},
    };
    cfg.modifier.type = VideoFlipModifier::Type::NewNote;

    // tick 0    : mono D5        (first → state 0)
    // tick 1920 : chord [G5, C6] (ONE trigger; identity pitch = lowest = G5.
    //                              G5 != previous pitch D5 → advance → state 1)
    // tick 2880 : mono D5        (D5 != previous pitch G5 (the chord's
    //                              identity) → advance → state 2)
    // tick 3840 : mono D#5       (D#5 != previous pitch D5 → advance →
    //                              state 0, wrap)
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

    CHECK(events[0].stateIndex  == 0 && events[0].monoOrdinal == 0,
          "ev0 first mono D5 -> group 0, state 0");
    CHECK(events[1].stateIndex  == 1 && events[1].monoOrdinal == 1,
          "ev1 chord (identity G5 != D5) -> group 1, state 1 (advance)");
    CHECK(events[2].stateIndex  == 1 && events[2].monoOrdinal == 1,
          "ev2 chord member shares ev1's group -> state 1");
    CHECK(events[3].stateIndex  == 2,                "ev3 D5 (!= chord's identity G5) -> state 2");
    CHECK(events[3].monoOrdinal == 2,                "ev3 monoOrdinal = 2");
    CHECK(events[4].stateIndex  == 0,                "ev4 D#5 (!= D5) -> state 0 (wrap)");
    CHECK(events[4].monoOrdinal == 3,                "ev4 monoOrdinal = 3");
}

// ─── [6] Chord before any single starts from startStateIndex ─────────────────

static void testChordBeforeAnyMono() {
    std::cout << "[6] EveryNote chord starts from startStateIndex\n";

    auto cfg = configHorizontalEven();
    cfg.startStateIndex = 1;   // start cycle on state 1

    // First two events form a chord at tick 0.
    std::vector<VideoEvent> events = {
        makeEvent(0.0, 60),   // chord
        makeEvent(0.0, 64),   // chord
        makeEvent(1.0, 67),   // mono after chord
    };
    std::vector<VideoEvent*> ptrs;
    for (auto& e : events) ptrs.push_back(&e);

    videoFlipApplier::applyTrack(ptrs, cfg, kPPQ);

    CHECK(events[0].stateIndex  == 1 && events[0].monoOrdinal == 0,
          "first chord member -> startStateIndex=1, group 0 (first trigger, no advance)");
    CHECK(events[1].stateIndex  == 1 && events[1].monoOrdinal == 0,
          "second chord member shares group 0 -> state 1");
    CHECK(events[2].stateIndex  == 0 && events[2].monoOrdinal == 1,
          "single after opening chord advances and wraps -> state 0, group 1");
}

// ─── [7] applyAll groups by trackId and routes to per-track config ───────────

// Repro: first chord, two singles, later chord. Each chord is ONE trigger
// (one group ordinal, one state, shared by every member); the singles that
// follow advance from the chord's group, not from an individual member.
static void testEveryNoteChordReproSequence() {
    std::cout << "[7] EveryNote repro sequence: chord, singles, later chord\n";

    auto cfg = configEveryNoteStates(4);
    std::vector<VideoEvent> events = {
        makeEvent(0.0, 60),
        makeEvent(0.0, 64),
        makeEvent(0.0, 67),
        makeEvent(0.5, 72),
        makeEvent(0.75, 74),
        makeEvent(1.5, 76),
        makeEvent(1.5, 79),
        makeEvent(1.5, 83),
    };
    std::vector<VideoEvent*> ptrs;
    for (auto& e : events) ptrs.push_back(&e);

    videoFlipApplier::applyTrack(ptrs, cfg, kPPQ);

    // Groups: [0]=beat0 chord (3 members), [1]=beat0.5 single,
    //         [2]=beat0.75 single, [3]=beat1.5 chord (3 members).
    const int expectedGroup[8] = { 0, 0, 0, 1, 2, 3, 3, 3 };
    for (int i = 0; i < static_cast<int>(events.size()); ++i) {
        const auto& ev = events[static_cast<size_t>(i)];
        const int g = expectedGroup[i];
        CHECK(ev.monoOrdinal == g,
              "every event's group ordinal matches its same-tick cluster");
        CHECK(ev.stateIndex == (g % 4),
              "stateIndex follows the group ordinal modulo state count");
        CHECK(ev.orientation == cfg.states[static_cast<size_t>(g % 4)].orientation,
              "orientation follows the group's resolved state");
    }
    CHECK(events[2].stateIndex == 0, "first chord (group 0) -> state 0 (first trigger, no advance)");
    CHECK(events[3].stateIndex == 1, "single immediately after chord (group 1) -> state 1");
    CHECK(events[4].stateIndex == 2, "next single (group 2) advances again -> state 2");
    CHECK(events[7].stateIndex == 3, "later chord (group 3) -> state 3");
}

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
    testEveryNoteChordTriggers();
    testSameTickUsesSourceOrderBeforePitch();
    testEveryNoteFourNoteStackTriggersEveryMember();
    testChordFollowedBySingle();
    testMonoBetweenChords();
    testChordBeforeAnyMono();
    testEveryNoteChordReproSequence();
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
