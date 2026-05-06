// test_undo.cpp — Self-verification for the Command-pattern undo/redo system.
// Build: see engine/CMakeLists.txt target "test_undo"
// Run:   test_undo.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1

#include "model/Timeline.h"
#include "model/Clip.h"
#include "commands/UndoManager.h"
#include "commands/TimelineCommands.h"
#include <iostream>
#include <string>
#include <cmath>
#include <nlohmann/json.hpp>

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

static void test8_clipModulationCommandUndoRedo() {
    std::cout << "\n[8] SetClipModulationCommand undo/redo on a fresh timeline\n";

    Timeline    tl2;
    UndoManager um2;

    SampleRegion region;
    region.name          = "ModSample";
    region.audioFilePath = "/test/mod.wav";
    int rid = tl2.addRegion(region);

    TrackInfo track;
    track.name = "ModTrack";
    um2.execute(std::make_unique<AddTrackCommand>(track), tl2);
    int tid = tl2.getAllTracks()[0]->id;

    um2.execute(std::make_unique<AddClipCommand>(makeClip(tid, rid, 0.0)), tl2);
    int cid = tl2.getAllClips()[0]->id;

    CHECK(tl2.getClip(cid)->modulation.enabled == false,
          "default clip.modulation.enabled is false");
    CHECK(tl2.getClip(cid)->modulation.vibrato.enabled == false,
          "default vibrato disabled");

    ClipModulation desired;
    desired.enabled = true;
    desired.vibrato.enabled      = true;
    desired.vibrato.depthCents   = 12.5f;
    desired.vibrato.rateMode     = ClipModulation::Vibrato::RateMode::TempoSync;
    desired.vibrato.syncDivision = ClipModulation::Vibrato::SyncDivision::Eighth;
    desired.vibrato.shape        = ClipModulation::Vibrato::Shape::Triangle;
    desired.scratch.enabled      = true;
    desired.scratch.timeMode     = ClipModulation::Scratch::CurveTimeMode::ClipPercent;
    desired.scratch.edgeMode     = ClipModulation::Scratch::EdgeMode::Wrap;
    desired.scratch.curve.push_back({0.0f, 1.0f, 0.0f});
    desired.scratch.curve.push_back({0.5f, 0.25f, 0.3f});
    desired.scratch.curve.push_back({1.0f, 1.5f, -0.2f});
    desired.video.vibratoSwirlEnabled = true;
    desired.video.scratchWaveEnabled  = true;
    desired.video.swirlAmount         = 0.7f;
    desired.video.waveFrequency       = 12.0f;

    um2.execute(std::make_unique<SetClipModulationCommand>(cid, desired, tl2), tl2);

    const ClipModulation& applied = tl2.getClip(cid)->modulation;
    CHECK(applied.enabled,                                      "modulation.enabled set");
    CHECK(applied.vibrato.enabled,                              "vibrato.enabled set");
    CHECK(std::abs(applied.vibrato.depthCents - 12.5f) < 1e-5f, "depthCents set");
    CHECK(applied.vibrato.rateMode == ClipModulation::Vibrato::RateMode::TempoSync,
          "rateMode TempoSync");
    CHECK(applied.vibrato.shape == ClipModulation::Vibrato::Shape::Triangle,
          "shape Triangle");
    CHECK(applied.scratch.enabled,                              "scratch.enabled set");
    CHECK(applied.scratch.curve.size() == 3,                    "scratch curve has 3 points");
    CHECK(applied.video.vibratoSwirlEnabled,                    "video swirl enabled");

    um2.undo(tl2);
    const ClipModulation& undone = tl2.getClip(cid)->modulation;
    CHECK(!undone.enabled,                  "undo: modulation.enabled cleared");
    CHECK(!undone.vibrato.enabled,          "undo: vibrato disabled");
    CHECK(!undone.scratch.enabled,          "undo: scratch disabled");
    CHECK(undone.scratch.curve.empty(),     "undo: scratch curve cleared");
    CHECK(!undone.video.vibratoSwirlEnabled,"undo: video swirl disabled");

    um2.redo(tl2);
    const ClipModulation& redone = tl2.getClip(cid)->modulation;
    CHECK(redone.enabled,                                       "redo: modulation.enabled set");
    CHECK(redone.vibrato.enabled,                               "redo: vibrato enabled");
    CHECK(redone.scratch.curve.size() == 3,                     "redo: scratch curve restored");
    CHECK(redone.video.scratchWaveEnabled,                      "redo: scratchWave enabled");
}

static void test9_clipModulationJsonRoundTrip() {
    std::cout << "\n[9] Clip+ClipModulation JSON round-trip + old-project compat\n";

    // Build a clip with non-default modulation across all sub-objects.
    Clip c;
    c.id = 7; c.trackId = 3; c.regionId = 5;
    c.position    = TickTime::fromBeats(2.0);
    c.duration    = TickTime::fromBeats(1.0);
    c.regionOffset = TickTime{0};
    c.syllableIndex = -1;
    c.velocity = 0.8f;
    c.pitchOffset = 2;

    c.modulation.enabled = true;
    c.modulation.vibrato.enabled               = true;
    c.modulation.vibrato.depthCents            = 7.25f;
    c.modulation.vibrato.rateMode              = ClipModulation::Vibrato::RateMode::TempoSync;
    c.modulation.vibrato.rateHz                = 4.5f;
    c.modulation.vibrato.syncDivision          = ClipModulation::Vibrato::SyncDivision::SixteenthDotted;
    c.modulation.vibrato.shape                 = ClipModulation::Vibrato::Shape::SawDown;
    c.modulation.vibrato.phaseResetOnClipStart = false;
    c.modulation.vibrato.phaseOffset           = 0.25f;
    c.modulation.vibrato.customShape.push_back({0.0f, -1.0f});
    c.modulation.vibrato.customShape.push_back({0.5f,  1.0f});
    c.modulation.vibrato.customShape.push_back({1.0f, -1.0f});

    c.modulation.scratch.enabled            = true;
    c.modulation.scratch.timeMode           = ClipModulation::Scratch::CurveTimeMode::Beats;
    c.modulation.scratch.smoothingMs        = 4.0f;
    c.modulation.scratch.gainCompensationDb = -1.5f;
    c.modulation.scratch.edgeMode           = ClipModulation::Scratch::EdgeMode::PingPong;
    c.modulation.scratch.curve.push_back({0.0f, 1.0f,  0.0f});
    c.modulation.scratch.curve.push_back({0.5f, 0.5f,  0.2f});
    c.modulation.scratch.curve.push_back({1.0f, 1.5f, -0.3f});

    c.modulation.video.vibratoSwirlEnabled    = true;
    c.modulation.video.scratchWaveEnabled     = true;
    c.modulation.video.swirlAmount            = 0.42f;
    c.modulation.video.swirlRadius            = 0.31f;
    c.modulation.video.swirlCenterX           = 0.6f;
    c.modulation.video.swirlCenterY           = 0.4f;
    c.modulation.video.waveAmount             = 0.05f;
    c.modulation.video.waveFrequency          = 10.0f;
    c.modulation.video.smearAmount            = 0.2f;
    c.modulation.video.reverseWaveWithScratch = false;

    nlohmann::json j = c;
    Clip r = j.get<Clip>();

    CHECK(r.modulation.enabled,                                 "round-trip: enabled");
    CHECK(r.modulation.vibrato.enabled,                         "round-trip: vibrato.enabled");
    CHECK(std::abs(r.modulation.vibrato.depthCents - 7.25f) < 1e-5f, "round-trip: depthCents");
    CHECK(r.modulation.vibrato.rateMode == ClipModulation::Vibrato::RateMode::TempoSync,
          "round-trip: rateMode");
    CHECK(std::abs(r.modulation.vibrato.rateHz - 4.5f) < 1e-5f, "round-trip: rateHz");
    CHECK(r.modulation.vibrato.syncDivision == ClipModulation::Vibrato::SyncDivision::SixteenthDotted,
          "round-trip: syncDivision");
    CHECK(r.modulation.vibrato.shape == ClipModulation::Vibrato::Shape::SawDown,
          "round-trip: shape");
    CHECK(!r.modulation.vibrato.phaseResetOnClipStart,          "round-trip: phaseReset off");
    CHECK(std::abs(r.modulation.vibrato.phaseOffset - 0.25f) < 1e-5f, "round-trip: phaseOffset");
    CHECK(r.modulation.vibrato.customShape.size() == 3,         "round-trip: customShape size");
    CHECK(std::abs(r.modulation.vibrato.customShape[1].value - 1.0f) < 1e-5f,
          "round-trip: customShape value");

    CHECK(r.modulation.scratch.enabled,                         "round-trip: scratch.enabled");
    CHECK(r.modulation.scratch.timeMode == ClipModulation::Scratch::CurveTimeMode::Beats,
          "round-trip: scratch.timeMode");
    CHECK(r.modulation.scratch.edgeMode == ClipModulation::Scratch::EdgeMode::PingPong,
          "round-trip: scratch.edgeMode");
    CHECK(r.modulation.scratch.curve.size() == 3,               "round-trip: scratch.curve size");
    CHECK(std::abs(r.modulation.scratch.curve[1].rateMultiplier - 0.5f) < 1e-5f,
          "round-trip: scratch.curve rateMultiplier");
    CHECK(std::abs(r.modulation.scratch.curve[2].curve - (-0.3f)) < 1e-5f,
          "round-trip: scratch.curve curve");

    CHECK(r.modulation.video.vibratoSwirlEnabled,               "round-trip: video.swirl");
    CHECK(r.modulation.video.scratchWaveEnabled,                "round-trip: video.wave");
    CHECK(std::abs(r.modulation.video.swirlAmount - 0.42f) < 1e-5f, "round-trip: video.swirlAmount");
    CHECK(std::abs(r.modulation.video.waveFrequency - 10.0f) < 1e-5f, "round-trip: video.waveFreq");
    CHECK(!r.modulation.video.reverseWaveWithScratch,           "round-trip: video.reverseWave off");

    // Old-project compat: legacy clip JSON with no "modulation" key must load
    // with all-disabled defaults.
    nlohmann::json legacy = {
        {"id", 1}, {"trackId", 1}, {"regionId", 1},
        {"positionTicks", 0}, {"durationTicks", 960},
        {"syllableIndex", -1}, {"velocity", 1.0f}, {"pitchOffset", 0}
    };
    Clip legacyClip = legacy.get<Clip>();
    CHECK(!legacyClip.modulation.enabled,                "legacy: modulation disabled");
    CHECK(!legacyClip.modulation.vibrato.enabled,        "legacy: vibrato disabled");
    CHECK(!legacyClip.modulation.scratch.enabled,        "legacy: scratch disabled");
    CHECK(legacyClip.modulation.scratch.curve.empty(),   "legacy: scratch curve empty");
    CHECK(!legacyClip.modulation.video.vibratoSwirlEnabled, "legacy: video swirl off");
    CHECK(legacyClip.modulation.video.reverseWaveWithScratch, "legacy: reverseWave default true");
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
    test8_clipModulationCommandUndoRedo();
    test9_clipModulationJsonRoundTrip();

    std::cout << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED (" << g_passed << " checks)\n";
        return 0;
    }
    std::cout << "FAILED: " << g_failed << " check(s) failed, "
              << g_passed << " passed\n";
    return 1;
}
