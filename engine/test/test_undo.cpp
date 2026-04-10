// test_undo.cpp — Self-verification for the Command-pattern undo/redo system.
// Build: see engine/CMakeLists.txt target "test_undo"
// Run:   test_undo.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1

#include "model/Timeline.h"
#include "commands/UndoManager.h"
#include "commands/TimelineCommands.h"
#include <iostream>
#include <string>

// ─── Minimal test harness ─────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                        \
    do {                                                                        \
        if (cond) {                                                             \
            ++g_passed;                                                         \
        } else {                                                                \
            std::cerr << "  FAIL [line " << __LINE__ << "] " << (msg) << "\n"; \
            ++g_failed;                                                         \
        }                                                                       \
    } while (0)

// ─── Shared state ─────────────────────────────────────────────────────────────

// Global timeline and undo manager shared across test sections
static Timeline  tl;
static UndoManager um;
static int regId = -1;
static int trkId = -1;

// ─── Helpers ──────────────────────────────────────────────────────────────────

static Clip makeClip(int trackId, int regionId, double beatPos) {
    Clip c;
    c.trackId       = trackId;
    c.regionId      = regionId;
    c.position      = TickTime::fromBeats(beatPos);
    c.duration      = TickTime::from16th(4); // 1 beat
    c.velocity      = 1.0f;
    c.pitchOffset   = 0;
    c.syllableIndex = -1;
    return c;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

static void test1_addTrackAndClips() {
    std::cout << "\n[1] Add track + 5 clips via commands\n";

    // Set up a region directly (not commanded — it's fixture data)
    SampleRegion region;
    region.name          = "TestSample";
    region.label         = SampleLabel::Kick;
    region.sourceId      = 0;
    region.startTime     = 0.0;
    region.endTime       = 0.1;
    region.startFrame    = 0;
    region.endFrame      = 3;
    region.audioFilePath = "/test/kick.wav";
    region.rootNote      = 36;
    regId = tl.addRegion(region); // id = 1

    TrackInfo track;
    track.name   = "TestTrack";
    track.order  = 0;
    track.volume = 1.0f;
    track.pan    = 0.0f;
    track.muted  = false;
    track.solo   = false;
    um.execute(std::make_unique<AddTrackCommand>(track), tl);

    // Capture the assigned track ID
    auto tracks = tl.getAllTracks();
    CHECK(tracks.size() == 1, "track was added");
    trkId = tracks[0]->id;

    for (int i = 0; i < 5; ++i)
        um.execute(std::make_unique<AddClipCommand>(makeClip(trkId, regId, i)), tl);

    CHECK(tl.getAllClips().size() == 5, "5 clips in timeline");
    CHECK(um.getUndoCount() == 6,       "undo stack depth == 6 (1 track + 5 clips)");
    CHECK(!um.canRedo(),                "redo stack is empty");
}

static void test2_undoRedoClearRedo() {
    std::cout << "\n[2] Undo 3 → verify 2 clips. Redo 2 → verify 4. New cmd clears redo.\n";

    um.undo(tl); // removes clip at beat 4
    um.undo(tl); // removes clip at beat 3
    um.undo(tl); // removes clip at beat 2
    CHECK(tl.getAllClips().size() == 2, "2 clips remain after 3 undos");
    CHECK(um.getRedoCount() == 3,       "3 items on redo stack");

    um.redo(tl); // re-adds clip at beat 2
    um.redo(tl); // re-adds clip at beat 3
    CHECK(tl.getAllClips().size() == 4, "4 clips after 2 redos");
    CHECK(um.getUndoCount() == 5,       "undo depth == 5 after 2 redos");

    // A new command must clear the redo stack
    um.execute(std::make_unique<AddClipCommand>(makeClip(trkId, regId, 10.0)), tl);
    CHECK(!um.canRedo(),                "redo stack cleared by new command");
    CHECK(tl.getAllClips().size() == 5, "5 clips after new add");
}

static void test3_moveClipUndo() {
    std::cout << "\n[3] MoveClip command, then undo → original position restored\n";

    auto clips = tl.getAllClips(); // sorted by id — [0] is first/oldest
    const int    clipId  = clips[0]->id;
    const TickTime origPos = clips[0]->position;
    const TickTime newPos  = TickTime::fromBeats(20.0);

    um.execute(std::make_unique<MoveClipCommand>(clipId, newPos, tl), tl);
    CHECK(tl.getClip(clipId)->position.ticks == newPos.ticks, "clip moved to new position");

    um.undo(tl);
    CHECK(tl.getClip(clipId)->position.ticks == origPos.ticks,
          "position restored after undo");
}

static void test4_resizeClipUndo() {
    std::cout << "\n[4] ResizeClip command, then undo → original duration restored\n";

    auto clips = tl.getAllClips();
    const int    clipId  = clips[0]->id;
    const TickTime origDur = clips[0]->duration;
    const TickTime newDur  = TickTime::fromBeats(2.0);

    um.execute(std::make_unique<ResizeClipCommand>(clipId, newDur, tl), tl);
    CHECK(tl.getClip(clipId)->duration.ticks == newDur.ticks, "clip resized");

    um.undo(tl);
    CHECK(tl.getClip(clipId)->duration.ticks == origDur.ticks,
          "duration restored after undo");
}

static void test5_removeTrackCascadeUndo() {
    std::cout << "\n[5] RemoveTrack cascades to clips, undo restores all\n";

    const int clipsBefore = static_cast<int>(tl.getAllClips().size());
    CHECK(clipsBefore > 0, "precondition: clips exist on track");

    um.execute(std::make_unique<RemoveTrackCommand>(trkId, tl), tl);
    CHECK(tl.getAllTracks().empty(),            "track removed");
    CHECK(tl.getAllClips().empty(),             "all clips cascade-removed");
    CHECK(tl.getClipsOnTrack(trkId).empty(),   "no clips on former track");

    um.undo(tl);
    CHECK(tl.getAllTracks().size() == 1,                  "track restored");
    CHECK(static_cast<int>(tl.getAllClips().size()) == clipsBefore,
          "all clips restored after undo");
    CHECK(tl.getTrack(trkId) != nullptr, "track accessible by original id");
}

static void test6_setBpmUndo() {
    std::cout << "\n[6] SetBPM command, then undo → original BPM restored\n";

    const double origBpm = tl.getBPM(); // 140.0
    um.execute(std::make_unique<SetBPMCommand>(160.0, tl), tl);
    CHECK(tl.getBPM() == 160.0,   "BPM changed to 160");

    um.undo(tl);
    CHECK(tl.getBPM() == origBpm, "BPM restored to original");
}

static void test7_stackOverflow() {
    std::cout << "\n[7] Execute 150 commands with maxHistory=100 → capped at 100\n";

    UndoManager um2(100);
    Timeline    tl2;

    for (int i = 0; i < 150; ++i)
        um2.execute(std::make_unique<SetBPMCommand>(100.0 + i, tl2), tl2);

    CHECK(um2.getUndoCount() == 100, "undo count capped at maxHistory=100");
    CHECK(!um2.canRedo(),            "redo stack still empty");
    // The timeline's BPM reflects the very last command regardless of cap
    CHECK(tl2.getBPM() == 249.0,    "timeline BPM reflects last SetBPM(249)");
}

// ─── Entry point ──────────────────────────────────────────────────────────────

int main() {
    test1_addTrackAndClips();
    test2_undoRedoClearRedo();
    test3_moveClipUndo();
    test4_resizeClipUndo();
    test5_removeTrackCascadeUndo();
    test6_setBpmUndo();
    test7_stackOverflow();

    std::cout << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED (" << g_passed << " checks)\n";
        return 0;
    }
    std::cout << "FAILED: " << g_failed << " check(s) failed, "
              << g_passed << " passed\n";
    return 1;
}
