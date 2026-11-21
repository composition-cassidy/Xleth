// test_undo.cpp — Self-verification for the Command-pattern undo/redo system.
// Build: see engine/CMakeLists.txt target "test_undo"
// Run:   test_undo.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1

#include "model/Timeline.h"
#include "model/Clip.h"
#include "commands/UndoManager.h"
#include "commands/TimelineCommands.h"
#include "commands/AddNotesBatchCommand.h"
#include "commands/ClipBatchCommands.h"
#include "model/ClipSplit.h"
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
    region.slot(0).rootNote = 36;
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
    const int    trackId = clips[0]->trackId;
    const TickTime origPos = clips[0]->position;
    const TickTime newPos  = TickTime::fromBeats(20.0);

    um.execute(std::make_unique<MoveClipCommand>(clipId, trackId, newPos, tl), tl);
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

static void test10_addNotesBatchUndoRedo() {
    std::cout << "\n[10] AddNotesBatchCommand: insert 3 notes, undo removes all, redo restores\n";

    Timeline    tl2;
    UndoManager um2;

    // A pattern to receive the notes (created directly — it's fixture data).
    Pattern pattern;
    pattern.name = "BatchPattern";
    const int patternId = tl2.addPattern(std::move(pattern));
    CHECK(patternId >= 0, "pattern created");
    CHECK(tl2.getPattern(patternId)->notes.empty(), "pattern starts with no notes");

    // Build 3 notes with UNASSIGNED ids (0) — the command must assign real ones.
    std::vector<PatternNote> notes;
    for (int i = 0; i < 3; ++i) {
        PatternNote n;
        n.id       = 0;
        n.position = TickTime::fromBeats(static_cast<double>(i));
        n.duration = TickTime::fromBeats(1.0);
        n.pitch    = 60 + i;
        n.velocity = 0.8f;
        notes.push_back(n);
    }

    auto cmd = std::make_unique<AddNotesBatchCommand>(patternId, std::move(notes));
    AddNotesBatchCommand* cmdPtr = cmd.get();
    um2.execute(std::move(cmd), tl2);

    // 3 distinct assigned IDs.
    const std::vector<int>& ids = cmdPtr->getAssignedIds();
    CHECK(ids.size() == 3, "3 IDs assigned");
    CHECK(ids[0] != ids[1] && ids[1] != ids[2] && ids[0] != ids[2], "assigned IDs are distinct");

    const Pattern* p = tl2.getPattern(patternId);
    CHECK(p->notes.size() == 3, "3 notes inserted into pattern");
    // Matches single-note add bookkeeping: nextNoteId advanced past every note.
    for (int id : ids)
        CHECK(id < p->nextNoteId, "nextNoteId advanced past assigned id");

    // Undo removes all 3 in one operation.
    um2.undo(tl2);
    CHECK(tl2.getPattern(patternId)->notes.empty(), "undo removed all 3 notes");

    // Redo restores all 3 with their original IDs.
    um2.redo(tl2);
    const Pattern* pr = tl2.getPattern(patternId);
    CHECK(pr->notes.size() == 3, "redo restored 3 notes");
    bool idsMatch = true;
    for (int id : ids) {
        bool found = false;
        for (const auto& n : pr->notes) if (n.id == id) { found = true; break; }
        if (!found) idsMatch = false;
    }
    CHECK(idsMatch, "redo restored notes keep their assigned IDs");
}

static void test12_trackFolderUndoRedo() {
    std::cout << "\n[12] Track folder undo/redo preserves exact placement\n";

    Timeline timeline;
    UndoManager history;
    TrackInfo seed;
    seed.name = "One";
    const int one = timeline.addTrack(seed);
    seed.name = "Two";
    const int two = timeline.addTrack(seed);
    seed.name = "Three";
    const int three = timeline.addTrack(seed);

    auto create = std::make_unique<CreateTrackFolderCommand>(
        "Group", std::vector<int>{one, two}, 0, timeline);
    auto* createPtr = create.get();
    history.execute(std::move(create), timeline);
    const int folderId = createPtr->folderId();
    CHECK(folderId > 0 && timeline.getTrackLayout().folders.size() == 1,
          "create command groups selected tracks");
    history.undo(timeline);
    CHECK(timeline.getTrackLayout().folders.empty()
          && timeline.getTrackLayout().rootOrder.size() == 3,
          "undo create restores flat placement");
    history.redo(timeline);
    CHECK(timeline.getTrackLayout().folders.size() == 1
          && timeline.getTrackLayout().folders[0].id == folderId,
          "redo create restores the same folder identity");

    history.execute(std::make_unique<RenameTrackFolderCommand>(
        folderId, "Renamed", timeline), timeline);
    history.execute(std::make_unique<SetTrackFolderCollapsedCommand>(
        folderId, true, timeline), timeline);
    CHECK(timeline.getTrackLayout().folders[0].name == "Renamed"
          && timeline.getTrackLayout().folders[0].collapsed,
          "rename and collapse are command-tracked");
    history.undo(timeline);
    history.undo(timeline);
    CHECK(timeline.getTrackLayout().folders[0].name == "Group"
          && !timeline.getTrackLayout().folders[0].collapsed,
          "rename and collapse undo exactly");

    history.execute(std::make_unique<RemoveTrackCommand>(two, timeline), timeline);
    CHECK(timeline.getTrackLayout().folders[0].trackIds == std::vector<int>({one}),
          "deleting a member removes only that member");
    history.undo(timeline);
    CHECK(timeline.getTrackLayout().folders[0].trackIds == std::vector<int>({one, two}),
          "undo member deletion restores exact folder placement");

    history.execute(std::make_unique<RemoveTrackFolderCommand>(folderId, timeline), timeline);
    TrackLayout ungrouped = timeline.getTrackLayout();
    CHECK(ungrouped.folders.empty() && ungrouped.rootOrder.size() == 3
          && ungrouped.rootOrder[0].id == one && ungrouped.rootOrder[1].id == two
          && ungrouped.rootOrder[2].id == three,
          "delete folder keeps member tracks in place");
    history.undo(timeline);
    CHECK(timeline.getTrackLayout().folders.size() == 1
          && timeline.getTrackLayout().folders[0].id == folderId,
          "undo folder deletion restores folder and membership");
    history.redo(timeline);
    CHECK(timeline.getTrackLayout().folders.empty(), "redo folder deletion ungroups again");
}

static void test11_visualEffectParamFailureDoesNotRecordHistory() {
    std::cout << "\n[11] SetVisualEffectParamCommand rejects stale indices without history\n";

    Timeline    tl2;
    UndoManager um2;

    TrackInfo track;
    track.name = "VisualEffectTrack";
    const int trackId = tl2.addTrack(track);

    um2.execute(std::make_unique<SetVisualEffectParamCommand>(trackId, 0, 0, 0.75f, tl2), tl2);
    CHECK(um2.getUndoCount() == 0, "failed visual-effect parameter write is not recorded");

    tl2.addVisualEffect(trackId, VisualEffect::Type::Desaturation);
    const float oldValue = tl2.getVisualEffectChain(trackId)->at(0).params[0];
    um2.execute(std::make_unique<SetVisualEffectParamCommand>(trackId, 0, 0, 0.75f, tl2), tl2);
    CHECK(um2.getUndoCount() == 1, "successful visual-effect parameter write is recorded");
    CHECK(std::fabs(tl2.getVisualEffectChain(trackId)->at(0).params[0] - 0.75f) < 0.0001f,
          "successful visual-effect parameter write updates the value");

    CHECK(um2.undo(tl2), "successful visual-effect parameter write undoes");
    CHECK(std::fabs(tl2.getVisualEffectChain(trackId)->at(0).params[0] - oldValue) < 0.0001f,
          "undo restores the previous visual-effect parameter value");
}

static void test13_reorderVisualEffectUndoRedoExact() {
    std::cout << "\n[13] ReorderVisualEffectCommand undo/redo restores exact chain (+ save/load)\n";

    Timeline    tl3;
    UndoManager um3;

    TrackInfo track;
    track.name = "ReorderTrack";
    const int trackId = tl3.addTrack(track);

    tl3.addVisualEffect(trackId, VisualEffect::Type::Desaturation);
    tl3.addVisualEffect(trackId, VisualEffect::Type::Tint);

    auto typesOf = [&](Timeline& t) {
        std::vector<VisualEffect::Type> types;
        for (const auto& fx : *t.getVisualEffectChain(trackId)) types.push_back(fx.type);
        return types;
    };

    const auto original = typesOf(tl3);
    CHECK((original == std::vector<VisualEffect::Type>{
              VisualEffect::Type::Desaturation, VisualEffect::Type::Tint}),
          "fixture chain starts Desaturation, Tint");

    // Minimal repro from the bug report: a 2-effect chain swap.
    um3.execute(std::make_unique<ReorderVisualEffectCommand>(trackId, 1, 0), tl3);
    CHECK((typesOf(tl3) == std::vector<VisualEffect::Type>{
              VisualEffect::Type::Tint, VisualEffect::Type::Desaturation}),
          "reorder(1,0) moves Tint to front");

    CHECK(um3.undo(tl3), "reorder undo reports success");
    CHECK(typesOf(tl3) == original, "undo restores exact original chain order");

    CHECK(um3.redo(tl3), "reorder redo reports success");
    CHECK((typesOf(tl3) == std::vector<VisualEffect::Type>{
              VisualEffect::Type::Tint, VisualEffect::Type::Desaturation}),
          "redo re-applies the reorder exactly");

    CHECK(um3.undo(tl3), "second undo reports success");
    CHECK(typesOf(tl3) == original, "chain is back to fixture order for the next case");

    // Backward move off the LAST slot: reorderVisualEffect's toIndex can't target
    // "append" (must be < size), so an undo that tried to invert via a second
    // reorderVisualEffect() call could never restore this case even if the
    // erase-adjustment arithmetic were otherwise fixed.
    tl3.addVisualEffect(trackId, VisualEffect::Type::BrightnessContrast);
    const auto original3 = typesOf(tl3);
    CHECK((original3 == std::vector<VisualEffect::Type>{
              VisualEffect::Type::Desaturation, VisualEffect::Type::Tint,
              VisualEffect::Type::BrightnessContrast}),
          "3-effect fixture starts Desaturation, Tint, BrightnessContrast");

    um3.execute(std::make_unique<ReorderVisualEffectCommand>(trackId, 2, 0), tl3);
    CHECK((typesOf(tl3) == std::vector<VisualEffect::Type>{
              VisualEffect::Type::BrightnessContrast, VisualEffect::Type::Desaturation,
              VisualEffect::Type::Tint}),
          "reorder(2,0) moves the last effect to the front");

    CHECK(um3.undo(tl3), "backward-move-off-last-slot undo reports success");
    CHECK(typesOf(tl3) == original3, "undo restores the exact 3-effect chain, including the last slot");

    CHECK(um3.redo(tl3), "backward-move-off-last-slot redo reports success");
    CHECK((typesOf(tl3) == std::vector<VisualEffect::Type>{
              VisualEffect::Type::BrightnessContrast, VisualEffect::Type::Desaturation,
              VisualEffect::Type::Tint}),
          "redo re-applies the last-slot move exactly");

    // Persisted save/load must preserve chain order too (Track.cpp's hand-maintained
    // to_json/from_json pair is a separate place this can silently regress even if
    // in-memory undo/redo is correct).
    nlohmann::json j;
    to_json(j, *tl3.getTrack(trackId));
    TrackInfo loaded;
    from_json(j, loaded);
    std::vector<VisualEffect::Type> loadedTypes;
    for (const auto& fx : loaded.visualEffectChain) loadedTypes.push_back(fx.type);
    CHECK((loadedTypes == std::vector<VisualEffect::Type>{
              VisualEffect::Type::BrightnessContrast, VisualEffect::Type::Desaturation,
              VisualEffect::Type::Tint}),
          "save/load preserves reordered chain order exactly");

    CHECK(um3.undo(tl3), "undo after save/load round trip still works on the live timeline");
    CHECK(typesOf(tl3) == original3, "post-round-trip undo still restores the exact chain");
}

// ─── Entry point ──────────────────────────────────────────────────────────────

// ─── Groups, refused edits, split ─────────────────────────────────────────────
// Each of these builds its own timeline: the sections above share one, and
// their counts depend on the order they run in.

struct Fixture {
    Timeline    tl;
    UndoManager um;
    int track = -1;
    int region = -1;

    explicit Fixture(int maxHistory = 100) : um(maxHistory) {
        TrackInfo t;
        t.name = "T";
        track = tl.addTrack(t);
        SampleRegion r;
        r.name = "R";
        region = tl.addRegion(r);
    }

    int addClip(double beat, double beats = 1.0) {
        Clip c = makeClip(track, region, beat);
        c.duration = TickTime::fromBeats(beats);
        um.execute(std::make_unique<AddClipCommand>(c), tl);
        return tl.getAllClips().back()->id;
    }
};

static void test14_groupIsOneEntry() {
    std::cout << "\n[14] a group of commands is one undo entry\n";
    Fixture f;
    std::vector<int> ids;
    for (int i = 0; i < 5; ++i) ids.push_back(f.addClip(i * 2.0));
    const int before = f.um.getUndoCount();

    const int token = f.um.beginGroup("Pitch shift");
    CHECK(token > 0,             "beginGroup hands back a token");
    CHECK(f.um.isGroupOpen(),    "the group is open");
    for (int id : ids)
        f.um.execute(std::make_unique<PitchShiftClipCommand>(id, 3, 0, f.tl), f.tl);
    CHECK(f.um.getUndoCount() == before, "nothing reaches the stack while the group is open");
    CHECK(f.um.isDirty(),                "but the project already counts as changed");
    CHECK(f.um.endGroup(token),          "endGroup closes it");
    CHECK(!f.um.isGroupOpen(),           "the group is closed");
    CHECK(f.um.getUndoCount() == before + 1, "five commands became ONE entry");
    CHECK(f.um.getUndoDescription() == "Pitch shift (5 edits)", "the entry is labelled with the gesture");

    CHECK(f.um.undo(f.tl), "one undo");
    bool allBack = true;
    for (int id : ids) if (f.tl.getClip(id)->pitchOffset != 0) allBack = false;
    CHECK(allBack, "reverses every command in the group");

    CHECK(f.um.redo(f.tl), "one redo");
    bool allAgain = true;
    for (int id : ids) if (f.tl.getClip(id)->pitchOffset != 3) allAgain = false;
    CHECK(allAgain, "replays every command in the group");
    CHECK(f.um.getUndoCount() == before + 1, "and it is still one entry");
}

static void test15_groupSurvivesTheHistoryCap() {
    std::cout << "\n[15] a gesture larger than the history cap can be undone in full\n";
    Fixture f(/*maxHistory=*/10);
    std::vector<int> ids;
    {
        const int token = f.um.beginGroup("Add");
        for (int i = 0; i < 40; ++i) ids.push_back(f.addClip(i * 2.0));
        f.um.endGroup(token);
    }
    const int token = f.um.beginGroup("Pitch shift");
    for (int id : ids)
        f.um.execute(std::make_unique<PitchShiftClipCommand>(id, 1, 0, f.tl), f.tl);
    f.um.endGroup(token);
    CHECK(f.um.getUndoCount() == 2, "two gestures, two entries, well inside a cap of 10");

    f.um.undo(f.tl);
    int stillShifted = 0;
    for (int id : ids) if (f.tl.getClip(id)->pitchOffset != 0) ++stillShifted;
    CHECK(stillShifted == 0, "all 40 pitch shifts came back off (ungrouped, 30 would be stranded)");
}

static void test16_groupsCannotBeLeftOpen() {
    std::cout << "\n[16] an abandoned group cannot swallow later edits forever\n";
    Fixture f;
    const int a = f.addClip(0.0);
    const int b = f.addClip(4.0);
    const int base = f.um.getUndoCount();

    // beginGroup without endGroup, then an undo: the open group is committed first.
    const int stale = f.um.beginGroup("Abandoned");
    f.um.execute(std::make_unique<PitchShiftClipCommand>(a, 2, 0, f.tl), f.tl);
    f.um.execute(std::make_unique<PitchShiftClipCommand>(b, 2, 0, f.tl), f.tl);
    CHECK(f.um.undo(f.tl), "undo with a group still open");
    CHECK(f.tl.getClip(a)->pitchOffset == 0 && f.tl.getClip(b)->pitchOffset == 0,
          "undid the open group's commands together");
    CHECK(!f.um.isGroupOpen(), "and closed it");
    CHECK(!f.um.endGroup(stale), "the late endGroup for it is refused");
    f.um.redo(f.tl);

    // A second beginGroup commits the first: groups do not nest.
    const int first = f.um.beginGroup("First");
    f.um.execute(std::make_unique<PitchShiftClipCommand>(a, 5, 0, f.tl), f.tl);
    const int second = f.um.beginGroup("Second");
    f.um.execute(std::make_unique<PitchShiftClipCommand>(b, 5, 0, f.tl), f.tl);
    CHECK(!f.um.endGroup(first),  "the first group's token no longer closes anything");
    CHECK(f.um.endGroup(second),  "the second group closes normally");
    CHECK(f.um.getUndoCount() == base + 3, "three entries: the redone group and the two single commands");
    f.um.undo(f.tl);
    CHECK(f.tl.getClip(b)->pitchOffset == 2 && f.tl.getClip(a)->pitchOffset == 5,
          "each was its own entry");

    // An empty group leaves nothing behind; a one-command group is that command.
    const int empty = f.um.beginGroup("Empty");
    const int depth = f.um.getUndoCount();
    f.um.endGroup(empty);
    CHECK(f.um.getUndoCount() == depth, "an empty group leaves no entry");
    const int single = f.um.beginGroup("Single");
    f.um.execute(std::make_unique<PitchShiftClipCommand>(a, 7, 0, f.tl), f.tl);
    f.um.endGroup(single);
    CHECK(f.um.getUndoDescription().rfind("Pitch Shift Clip", 0) == 0,
          "a one-command group is recorded as the command itself");
}

static void test17_refusedAndEmptyEditsAreNotRecorded() {
    std::cout << "\n[17] refused and no-op edits leave no undo entry and keep the redo history\n";
    Fixture f;
    const int clip = f.addClip(0.0);
    f.um.execute(std::make_unique<MoveClipCommand>(clip, f.track, TickTime::fromBeats(8), f.tl), f.tl);
    f.um.undo(f.tl);                                  // one entry waiting on the redo stack
    const int depth = f.um.getUndoCount();
    CHECK(f.um.canRedo(), "precondition: something to redo");

    auto unchanged = [&](const char* what) {
        CHECK(f.um.getUndoCount() == depth, std::string(what) + ": no undo entry");
        CHECK(f.um.canRedo(),               std::string(what) + ": redo history kept");
    };

    const TickTime pos = f.tl.getClip(clip)->position;
    const TickTime dur = f.tl.getClip(clip)->duration;

    f.um.execute(std::make_unique<MoveClipCommand>(clip, f.track, pos, f.tl), f.tl);
    unchanged("move to the same place");
    f.um.execute(std::make_unique<MoveClipCommand>(999999, f.track, pos, f.tl), f.tl);
    unchanged("move of an unknown clip");
    f.um.execute(std::make_unique<MoveClipCommand>(clip, f.track, TickTime{-960}, f.tl), f.tl);
    unchanged("move to a negative position");
    CHECK(f.tl.getClip(clip)->position.ticks == pos.ticks, "and the clip did not move");

    f.um.execute(std::make_unique<ResizeClipCommand>(clip, dur, f.tl), f.tl);
    unchanged("resize to the same length");
    f.um.execute(std::make_unique<ResizeClipCommand>(clip, TickTime{0}, f.tl), f.tl);
    unchanged("resize to zero");
    f.um.execute(std::make_unique<ResizeClipCommand>(clip, TickTime{-480}, f.tl), f.tl);
    unchanged("resize to a negative length");
    CHECK(f.tl.getClip(clip)->duration.ticks == dur.ticks, "and the clip kept its length");

    f.um.execute(std::make_unique<ResizeClipLeftCommand>(clip, pos, dur, TickTime{-240}, f.tl), f.tl);
    unchanged("left-resize to a negative region offset");
    CHECK(f.tl.getClip(clip)->regionOffset.ticks == 0, "and the offset stayed at 0");

    f.um.execute(std::make_unique<StretchClipCommand>(clip, TickTime{0}, f.tl), f.tl);
    unchanged("stretch to zero");
    CHECK(f.tl.getClip(clip)->stretchRatio == 1.0, "and the stretch ratio was not touched");

    f.um.execute(std::make_unique<PitchShiftClipCommand>(clip, 0, 0, f.tl), f.tl);
    unchanged("pitch shift by nothing");
    f.um.execute(std::make_unique<RemoveClipCommand>(999999, f.tl), f.tl);
    unchanged("remove of an unknown clip");
    f.um.execute(std::make_unique<SetTrackNameCommand>(f.track, "T", f.tl), f.tl);
    unchanged("rename to the same name");
    f.um.execute(std::make_unique<SetBPMCommand>(f.tl.getBPM(), f.tl), f.tl);
    unchanged("tempo set to the current tempo");
    f.um.execute(std::make_unique<MoveClipsBatchCommand>(
        std::vector<MoveClipsBatchCommand::Move>{}, f.tl), f.tl);
    unchanged("an empty batch move");

    Clip bad = makeClip(f.track, f.region, 2.0);
    bad.duration = TickTime{0};
    f.um.execute(std::make_unique<AddClipCommand>(bad), f.tl);
    unchanged("add of a zero-length clip");
    CHECK(f.tl.getAllClips().size() == 1, "and no clip was created");

    // The command object must outlive execute() even when it is not recorded:
    // callers read results off it straight afterwards.
    auto cmd = std::make_unique<RemoveClipsBatchCommand>(std::vector<int>{999999}, f.tl);
    RemoveClipsBatchCommand* raw = cmd.get();
    f.um.execute(std::move(cmd), f.tl);
    CHECK(raw->getRemovedIds().empty(), "an unrecorded command is still readable after execute()");
    unchanged("a batch remove that matched nothing");

    // A real edit is still recorded, and still clears the redo history.
    f.um.execute(std::make_unique<PitchShiftClipCommand>(clip, 1, 0, f.tl), f.tl);
    CHECK(f.um.getUndoCount() == depth + 1 && !f.um.canRedo(), "a real edit is recorded as before");
}

static void test18_splitKeepsWhatWasPlaying() {
    std::cout << "\n[18] splitting a clip changes nothing you can hear\n";
    using xleth::clipedit::splitClipAt;
    using xleth::clipedit::canSplitClipAt;

    Clip c;
    c.id = 7; c.trackId = 1; c.regionId = 2;
    c.position = TickTime{1920}; c.duration = TickTime{3840}; c.regionOffset = TickTime{100};
    c.stretchRatio = 1.5; c.pitchOffset = 4; c.velocity = 0.6f;
    c.fadeInPercent = 10.0f; c.fadeOutPercent = 20.0f;

    CHECK(!canSplitClipAt(c, 1920) && !canSplitClipAt(c, 1920 + 3840), "a cut on an edge is refused");
    CHECK(canSplitClipAt(c, 1921) && canSplitClipAt(c, 1920 + 3839),   "a cut strictly inside is allowed");

    const auto fwd = splitClipAt(c, 1920 + 960);
    CHECK(fwd.left.id == 0 && fwd.right.id == 0, "the pieces take new ids");
    CHECK(fwd.left.position.ticks == 1920 && fwd.left.duration.ticks == 960, "left piece spans [start, cut)");
    CHECK(fwd.right.position.ticks == 2880 && fwd.right.duration.ticks == 2880, "right piece spans [cut, end)");
    CHECK(fwd.left.regionOffset.ticks == 100, "forward: left reads from the original offset");
    CHECK(fwd.right.regionOffset.ticks == 100 + 640, "forward: right starts 960 / 1.5 source ticks later");
    CHECK(fwd.left.pitchOffset == 4 && fwd.right.pitchOffset == 4 && fwd.right.stretchRatio == 1.5,
          "everything else is carried to both pieces");

    // Fades keep their LENGTH and stay at the end they belong to.
    const double inTicks  = 0.10 * 3840, outTicks = 0.20 * 3840;
    CHECK(std::abs(fwd.left.fadeInPercent / 100.0 * 960 - inTicks) < 0.01, "the fade-in is as long as it was");
    CHECK(fwd.left.fadeOutPercent == 0.0f,  "the left piece does not fade out at the cut");
    CHECK(fwd.right.fadeInPercent == 0.0f,  "the right piece does not fade in at the cut");
    CHECK(std::abs(fwd.right.fadeOutPercent / 100.0 * 2880 - outTicks) < 0.01, "the fade-out is as long as it was");

    // A cut inside the fade-in: the left piece is all fade, nothing spills over.
    const auto early = splitClipAt(c, 1920 + 120);
    CHECK(early.left.fadeInPercent == 100.0f && early.right.fadeInPercent == 0.0f,
          "a fade longer than its piece is clamped to the piece");

    // Reversed: the window plays backwards, so the FIRST piece owns its END.
    Clip r = c;
    r.reversed = true;
    const auto rev = splitClipAt(r, 1920 + 960);
    CHECK(rev.right.regionOffset.ticks == 100, "reversed: the later piece reads the START of the window");
    CHECK(rev.left.regionOffset.ticks == 100 + 1920, "reversed: the earlier piece reads the END (2880 / 1.5 source ticks in)");
    // Together the two windows still tile the original one exactly.
    const int64_t window = 2560;   // 3840 / 1.5
    CHECK(rev.right.regionOffset.ticks + 1920 == rev.left.regionOffset.ticks
          && rev.left.regionOffset.ticks + 640 == 100 + window,
          "the two pieces tile the original source window");
}

static void test19_tempoChangeKeepsTrimsOnTheSource() {
    std::cout << "\n[19] a tempo change does not move where a trimmed clip starts in its source\n";
    Fixture f;
    f.tl.setBPM(140.0);
    const int trimmed = f.addClip(0.0, 2.0);
    const int plain   = f.addClip(4.0, 2.0);
    f.tl.getClipMutable(trimmed)->regionOffset = TickTime{480};
    const int depth = f.um.getUndoCount();

    auto startSeconds = [&](int id) {
        return f.tl.getClip(id)->regionOffset.toSeconds(f.tl.getBPM());
    };
    const double before = startSeconds(trimmed);

    f.um.execute(std::make_unique<SetBPMCommand>(70.0, f.tl), f.tl);
    CHECK(f.tl.getBPM() == 70.0, "tempo halved");
    CHECK(f.tl.getClip(trimmed)->regionOffset.ticks == 240, "the trim is 240 ticks at the new tempo (was 480)");
    CHECK(std::abs(startSeconds(trimmed) - before) < 1e-9, "which is the same instant of the source");
    CHECK(f.tl.getClip(plain)->regionOffset.ticks == 0, "an untrimmed clip is untouched");
    CHECK(f.tl.getClip(trimmed)->position.ticks == 0 && f.tl.getClip(trimmed)->duration.ticks == 1920,
          "position and length stay musical");

    f.um.execute(std::make_unique<SetBPMCommand>(97.3, f.tl), f.tl);
    CHECK(std::abs(startSeconds(trimmed) - before) < 0.5 * (60.0 / 97.3) / 960.0 + 1e-12,
          "an odd tempo lands within half a tick of the same instant");

    f.um.undo(f.tl);
    f.um.undo(f.tl);
    CHECK(f.tl.getBPM() == 140.0 && f.tl.getClip(trimmed)->regionOffset.ticks == 480,
          "undo restores the exact original ticks");
    CHECK(f.um.getUndoCount() == depth, "and the history is back where it was");
    f.um.redo(f.tl);
    CHECK(f.tl.getClip(trimmed)->regionOffset.ticks == 240, "redo lands on the same number again");
}

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
    test10_addNotesBatchUndoRedo();
    test11_visualEffectParamFailureDoesNotRecordHistory();
    test12_trackFolderUndoRedo();
    test13_reorderVisualEffectUndoRedoExact();
    test14_groupIsOneEntry();
    test15_groupSurvivesTheHistoryCap();
    test16_groupsCannotBeLeftOpen();
    test17_refusedAndEmptyEditsAreNotRecorded();
    test18_splitKeepsWhatWasPlaying();
    test19_tempoChangeKeepsTrimsOnTheSource();

    std::cout << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED (" << g_passed << " checks)\n";
        return 0;
    }
    std::cout << "FAILED: " << g_failed << " check(s) failed, "
              << g_passed << " passed\n";
    return 1;
}
