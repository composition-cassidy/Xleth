// test_project.cpp — Self-verification for ProjectManager persistence.
// Build: see engine/CMakeLists.txt target "test_project"
// Run:   test_project.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1

#include "project/ProjectManager.h"
#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>

namespace fs = std::filesystem;
using json   = nlohmann::json;

// ─── Minimal test harness ─────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (cond) {                                                            \
            ++g_passed;                                                        \
        } else {                                                               \
            std::cerr << "  FAIL [line " << __LINE__ << "] " << msg << "\n"; \
            ++g_failed;                                                        \
        }                                                                      \
    } while (0)

#define REQUIRE(cond, msg)                                                     \
    do {                                                                       \
        if (!(cond)) {                                                         \
            std::cerr << "FAILED: " << msg << "\n";                           \
            fs::remove_all(tempDir);                                           \
            return 1;                                                          \
        }                                                                      \
    } while (0)

int main() {
    const std::string tempDir =
        (fs::temp_directory_path() / "xleth_test_project").string();

    // Clean up any leftover from a previous run
    if (fs::exists(tempDir))
        fs::remove_all(tempDir);

    // ── Test 1: createProject builds directory structure ─────────────────────
    std::cout << "\n[1] createProject — directory structure\n";
    {
        ProjectManager pm;
        REQUIRE(pm.createProject(tempDir, "TestRemix"),
                "createProject returned false");

        CHECK(fs::is_directory(tempDir),
              "project root directory exists");
        CHECK(fs::is_directory(pm.getProxiesDir()),
              "proxies/ subdirectory exists");
        CHECK(fs::is_directory(pm.getExportsDir()),
              "exports/ subdirectory exists");
        CHECK(fs::is_directory(pm.getSwappedDir()),
              "swapped/ subdirectory exists");
        CHECK(fs::exists(tempDir + "/project.json"),
              "project.json created by createProject");
    }

    // ── Test 2: saveProject writes valid JSON ─────────────────────────────────
    std::cout << "\n[2] saveProject — write and inspect JSON\n";

    // Build a timeline with one source, region, clip track/clip, and two
    // pattern-track patterns (one unassigned, one assigned).
    Timeline tl(140.0, 48000.0, 4, 4);

    SourceMedia src;
    src.filePath    = "/fake/path/video.mp4";
    src.fileName    = "video.mp4";
    src.width       = 1920;
    src.height      = 1080;
    src.fps         = 30.0;
    src.duration    = 60.0;
    src.totalFrames = 1800;
    src.hasVideo    = true;
    src.proxyReady  = false;
    const int srcId = tl.addSource(src);

    SampleRegion region;
    region.sourceId     = srcId;
    region.name         = "Kick01";
    region.label        = SampleLabel::Kick;
    region.startTime    = 0.0;
    region.endTime      = 0.1;
    region.startFrame   = 0;
    region.endFrame     = 3;
    region.audioFilePath = "/fake/audio/kick.wav";
    region.rootNote     = 36;
    region.hasSwappedAudio = false;
    const int regId = tl.addRegion(region);

    TrackInfo track;
    track.name   = "Drums";
    track.order  = 0;
    track.volume = 1.0f;
    track.pan    = 0.0f;
    track.muted  = false;
    track.solo   = false;
    const int trkId = tl.addTrack(track);

    Clip clip;
    clip.trackId       = trkId;
    clip.regionId      = regId;
    clip.position      = TickTime::fromBeats(0.0);
    clip.duration      = TickTime::from16th(1);
    clip.velocity      = 1.0f;
    clip.pitchOffset   = 0;
    clip.syllableIndex = -1;
    tl.addClip(clip);

    TrackInfo patternTrack;
    patternTrack.name   = "Patterns";
    patternTrack.order  = 1;
    patternTrack.type   = TrackInfo::Type::Pattern;
    patternTrack.volume = 1.0f;
    patternTrack.pan    = 0.0f;
    patternTrack.muted  = false;
    patternTrack.solo   = false;
    const int patternTrackId = tl.addTrack(patternTrack);

    PatternNote unassignedNote;
    unassignedNote.id       = 1;
    unassignedNote.position = TickTime::fromBeats(0.0);
    unassignedNote.duration = TickTime::from16th(1);
    unassignedNote.pitch    = 60;
    unassignedNote.velocity = 0.75f;

    Pattern unassignedPattern;
    unassignedPattern.name       = "Imported Unassigned";
    unassignedPattern.regionId   = -1;
    unassignedPattern.length     = TickTime::fromBeats(1.0);
    unassignedPattern.notes      = { unassignedNote };
    unassignedPattern.nextNoteId = 2;
    const int unassignedPatternId = tl.addPattern(unassignedPattern);

    PatternBlock unassignedBlock;
    unassignedBlock.trackId   = patternTrackId;
    unassignedBlock.patternId = unassignedPatternId;
    unassignedBlock.position  = TickTime::fromBeats(0.0);
    unassignedBlock.duration  = unassignedPattern.length;
    const int unassignedBlockId = tl.addPatternBlock(unassignedBlock);

    PatternNote assignedNoteA;
    assignedNoteA.id       = 1;
    assignedNoteA.position = TickTime::fromBeats(0.0);
    assignedNoteA.duration = TickTime::from16th(2);
    assignedNoteA.pitch    = 67;
    assignedNoteA.velocity = 0.50f;

    PatternNote assignedNoteB;
    assignedNoteB.id       = 2;
    assignedNoteB.position = TickTime::from16th(2);
    assignedNoteB.duration = TickTime::from16th(1);
    assignedNoteB.pitch    = 71;
    assignedNoteB.velocity = 0.625f;

    Pattern assignedPattern;
    assignedPattern.name       = "Assigned Pattern";
    assignedPattern.regionId   = regId;
    assignedPattern.length     = TickTime::fromBeats(2.0);
    assignedPattern.notes      = { assignedNoteA, assignedNoteB };
    assignedPattern.nextNoteId = 3;
    const int assignedPatternId = tl.addPattern(assignedPattern);

    PatternBlock assignedBlock;
    assignedBlock.trackId   = patternTrackId;
    assignedBlock.patternId = assignedPatternId;
    assignedBlock.position  = TickTime::fromBeats(4.0);
    assignedBlock.duration  = assignedPattern.length;
    const int assignedBlockId = tl.addPatternBlock(assignedBlock);

    tl.setGlobalStretchMethod(static_cast<int>(StretchMethod::WORLD));

    {
        ProjectManager pm;
        REQUIRE(pm.createProject(tempDir, "TestRemix"),
                "createProject (2nd pass) returned false");
        REQUIRE(pm.saveProject(tl), "saveProject returned false");

        const std::string jsonPath = tempDir + "/project.json";
        REQUIRE(fs::exists(jsonPath), "project.json not found after save");

        std::ifstream f(jsonPath);
        json j;
        try { f >> j; }
        catch (...) {
            std::cerr << "FAILED: project.json is not valid JSON\n";
            fs::remove_all(tempDir);
            return 1;
        }

        CHECK(j.contains("xleth_version"),  "has xleth_version");
        CHECK(j.contains("project_name"),   "has project_name");
        CHECK(j.contains("created_at"),     "has created_at");
        CHECK(j.contains("modified_at"),    "has modified_at");
        CHECK(j.contains("bpm"),            "has bpm");
        CHECK(j.contains("sample_rate"),    "has sample_rate");
        CHECK(j.contains("time_signature"), "has time_signature");
        CHECK(j.contains("sources"),        "has sources");
        CHECK(j.contains("regions"),        "has regions");
        CHECK(j.contains("tracks"),         "has tracks");
        CHECK(j.contains("clips"),          "has clips");
        CHECK(j.contains("patterns"),       "has patterns");
        CHECK(j.contains("patternBlocks"),  "has patternBlocks");
        CHECK(j.contains("globalStretchMethod"), "has globalStretchMethod");
        CHECK(j.contains("custom_labels"),  "has custom_labels");

        CHECK(j["xleth_version"].get<std::string>() == "0.1.0",
              "xleth_version == 0.1.0");
        CHECK(j["project_name"].get<std::string>() == "TestRemix",
              "project_name == TestRemix");
        CHECK(j["bpm"].get<double>() == 140.0,
              "bpm == 140.0");
        CHECK(j["sample_rate"].get<double>() == 48000.0,
              "sample_rate == 48000.0");
        CHECK(j["time_signature"].is_array() && j["time_signature"].size() == 2,
              "time_signature is a 2-element array");
        CHECK(j["time_signature"][0].get<int>() == 4 &&
              j["time_signature"][1].get<int>() == 4,
              "time_signature == [4,4]");
        CHECK(j["sources"].size() == 1, "sources array has 1 entry");
        CHECK(j["regions"].size() == 1, "regions array has 1 entry");
        CHECK(j["tracks"].size()  == 2, "tracks array has 2 entries");
        CHECK(j["clips"].size()   == 1, "clips array has 1 entry");
        CHECK(j["patterns"].size() == 2, "patterns array has 2 entries");
        CHECK(j["patternBlocks"].size() == 2, "patternBlocks array has 2 entries");
        CHECK(j["globalStretchMethod"].get<int>() == static_cast<int>(StretchMethod::WORLD),
              "globalStretchMethod == WORLD");

        bool wroteUnassignedPattern = false;
        bool wroteAssignedPattern = false;
        for (const auto& patternJson : j["patterns"]) {
            const std::string name = patternJson.value("name", "");
            if (name == "Imported Unassigned") {
                wroteUnassignedPattern = true;
                CHECK(patternJson.value("regionId", 0) == -1,
                      "unassigned pattern writes regionId = -1");
                CHECK(patternJson["notes"].size() == 1,
                      "unassigned pattern writes its note data");
            } else if (name == "Assigned Pattern") {
                wroteAssignedPattern = true;
                CHECK(patternJson.value("regionId", -1) == regId,
                      "assigned pattern writes its regionId");
                CHECK(patternJson["notes"].size() == 2,
                      "assigned pattern writes both notes");
            }
        }
        CHECK(wroteUnassignedPattern, "project.json includes the unassigned pattern");
        CHECK(wroteAssignedPattern, "project.json includes the assigned pattern");
    }

    // ── Test 3: loadProject restores all data ─────────────────────────────────
    std::cout << "\n[3] loadProject — round-trip fidelity\n";
    {
        ProjectManager pm2;
        auto loaded = pm2.loadProject(tempDir);
        REQUIRE(loaded.has_value(), "loadProject returned nullopt");

        Timeline& tl2 = *loaded;

        CHECK(tl2.getBPM()        == 140.0,   "BPM round-trips correctly");
        CHECK(tl2.getSampleRate() == 48000.0, "SampleRate round-trips correctly");
        CHECK(tl2.getTimeSigNum() == 4,       "TimeSigNum round-trips correctly");
        CHECK(tl2.getTimeSigDen() == 4,       "TimeSigDen round-trips correctly");
        CHECK(tl2.getGlobalStretchMethod() == static_cast<int>(StretchMethod::WORLD),
              "GlobalStretchMethod round-trips correctly");

        CHECK(tl2.getAllSources().size() == 1, "1 source loaded");
        CHECK(tl2.getAllRegions().size() == 1, "1 region loaded");
        CHECK(tl2.getAllTracks().size()  == 2, "2 tracks loaded");
        CHECK(tl2.getAllClips().size()   == 1, "1 clip loaded");
        CHECK(tl2.getAllPatterns().size() == 2, "2 patterns loaded");
        CHECK(tl2.getAllPatternBlocks().size() == 2, "2 pattern blocks loaded");

        const SourceMedia* s = tl2.getSource(srcId);
        REQUIRE(s != nullptr, "getSource(srcId) returned null after load");
        CHECK(s->filePath == "/fake/path/video.mp4",
              "source filePath round-trips");
        CHECK(s->fileName == "video.mp4",
              "source fileName round-trips");
        CHECK(s->width  == 1920,  "source width round-trips");
        CHECK(s->height == 1080,  "source height round-trips");
        CHECK(s->fps    == 30.0,  "source fps round-trips");
        CHECK(s->totalFrames == 1800, "source totalFrames round-trips");

        const SampleRegion* r = tl2.getRegion(regId);
        REQUIRE(r != nullptr, "getRegion(regId) returned null after load");
        CHECK(r->name         == "Kick01",          "region name round-trips");
        CHECK(r->label        == SampleLabel::Kick, "region label round-trips");
        CHECK(r->audioFilePath == "/fake/audio/kick.wav",
              "region audioFilePath round-trips");

        const TrackInfo* t = tl2.getTrack(trkId);
        REQUIRE(t != nullptr, "getTrack(trkId) returned null after load");
        CHECK(t->name  == "Drums", "track name round-trips");
        CHECK(t->order == 0,       "track order round-trips");

        const TrackInfo* pt = tl2.getTrack(patternTrackId);
        REQUIRE(pt != nullptr, "getTrack(patternTrackId) returned null after load");
        CHECK(pt->name == "Patterns", "pattern track name round-trips");
        CHECK(pt->type == TrackInfo::Type::Pattern, "pattern track type round-trips");

        // Fallback: just verify via getAllClips
        auto clips = tl2.getAllClips();
        REQUIRE(clips.size() == 1, "getAllClips size == 1");
        CHECK(clips[0]->trackId        == trkId, "clip trackId round-trips");
        CHECK(clips[0]->regionId       == regId, "clip regionId round-trips");
        CHECK(clips[0]->position.ticks == 0,     "clip position round-trips");
        CHECK(clips[0]->duration.ticks == 240,   "clip duration round-trips (1 16th)");
        CHECK(clips[0]->velocity       == 1.0f,  "clip velocity round-trips");
        CHECK(clips[0]->syllableIndex  == -1,    "clip syllableIndex round-trips");

        const Pattern* loadedUnassignedPattern = tl2.getPattern(unassignedPatternId);
        REQUIRE(loadedUnassignedPattern != nullptr, "getPattern(unassignedPatternId) returned null after load");
        CHECK(loadedUnassignedPattern->regionId == -1,
              "unassigned pattern regionId round-trips as -1");
        CHECK(loadedUnassignedPattern->notes.size() == 1,
              "unassigned pattern note count round-trips");
        if (loadedUnassignedPattern->notes.size() == 1) {
            CHECK(loadedUnassignedPattern->notes[0].position.ticks == 0,
                  "unassigned pattern note position round-trips");
            CHECK(loadedUnassignedPattern->notes[0].duration.ticks == 240,
                  "unassigned pattern note duration round-trips");
            CHECK(loadedUnassignedPattern->notes[0].pitch == 60,
                  "unassigned pattern note pitch round-trips");
            CHECK(loadedUnassignedPattern->notes[0].velocity == 0.75f,
                  "unassigned pattern note velocity round-trips");
        }

        const Pattern* loadedAssignedPattern = tl2.getPattern(assignedPatternId);
        REQUIRE(loadedAssignedPattern != nullptr, "getPattern(assignedPatternId) returned null after load");
        CHECK(loadedAssignedPattern->regionId == regId,
              "assigned pattern regionId round-trips");
        CHECK(loadedAssignedPattern->notes.size() == 2,
              "assigned pattern note count round-trips");
        if (loadedAssignedPattern->notes.size() == 2) {
            CHECK(loadedAssignedPattern->notes[0].position.ticks == 0,
                  "assigned pattern first note position round-trips");
            CHECK(loadedAssignedPattern->notes[0].duration.ticks == 480,
                  "assigned pattern first note duration round-trips");
            CHECK(loadedAssignedPattern->notes[0].pitch == 67,
                  "assigned pattern first note pitch round-trips");
            CHECK(loadedAssignedPattern->notes[0].velocity == 0.50f,
                  "assigned pattern first note velocity round-trips");
            CHECK(loadedAssignedPattern->notes[1].position.ticks == 480,
                  "assigned pattern second note position round-trips");
            CHECK(loadedAssignedPattern->notes[1].duration.ticks == 240,
                  "assigned pattern second note duration round-trips");
            CHECK(loadedAssignedPattern->notes[1].pitch == 71,
                  "assigned pattern second note pitch round-trips");
            CHECK(loadedAssignedPattern->notes[1].velocity == 0.625f,
                  "assigned pattern second note velocity round-trips");
        }

        const PatternBlock* loadedUnassignedBlock = tl2.getPatternBlock(unassignedBlockId);
        REQUIRE(loadedUnassignedBlock != nullptr, "getPatternBlock(unassignedBlockId) returned null after load");
        CHECK(loadedUnassignedBlock->patternId == unassignedPatternId,
              "unassigned pattern block keeps its pattern id");
        CHECK(loadedUnassignedBlock->trackId == patternTrackId,
              "unassigned pattern block keeps its track id");

        const PatternBlock* loadedAssignedBlock = tl2.getPatternBlock(assignedBlockId);
        REQUIRE(loadedAssignedBlock != nullptr, "getPatternBlock(assignedBlockId) returned null after load");
        CHECK(loadedAssignedBlock->patternId == assignedPatternId,
              "assigned pattern block keeps its pattern id");
        CHECK(loadedAssignedBlock->trackId == patternTrackId,
              "assigned pattern block keeps its track id");
    }

    // ── Test 4: validateMedia with a missing source path ──────────────────────
    std::cout << "\n[4] validateMedia — missing source detection\n";
    {
        ProjectManager pm3;
        auto loaded = pm3.loadProject(tempDir);
        REQUIRE(loaded.has_value(), "loadProject (test 4) returned nullopt");

        auto statuses = pm3.validateMedia(*loaded);
        CHECK(statuses.size() == 1,
              "validateMedia returns one status per source");
        CHECK(!statuses[0].found,
              "fake path is correctly reported as not found");
        CHECK(statuses[0].sourceId == srcId,
              "status sourceId matches original source ID");
        CHECK(statuses[0].filePath == "/fake/path/video.mp4",
              "status filePath matches source filePath");
        CHECK(!statuses[0].error.empty(),
              "status.error is non-empty for missing file");
    }

    // Test 5: graphState/effectChains opaque co-existence.
    // graphState is renderer-owned track JSON. ProjectManager must persist it
    // alongside, but separate from, effectChains.
    std::cout << "\n[5] graphState and effectChains round-trip separately\n";
    {
        TrackInfo* graphTrack = tl.getTrackMutable(trkId);
        REQUIRE(graphTrack != nullptr, "graphState test track exists");
        graphTrack->fxMode = TrackFxMode::Graph;
        graphTrack->hasGraphState = true;
        graphTrack->graphState = {
            {"schemaVersion", 1},
            {"trackId", std::to_string(trkId)},
            {"nodes", json::array({
                {{"id", "input"}, {"type", "trackInput"}},
                {{"id", "output"}, {"type", "trackOutput"}}
            })},
            {"edges", json::array()},
            {"invalidRendererField", json::array({"kept", true})}
        };

        json effectChains = json::object({
            {
                std::to_string(trkId),
                {
                    {"nodes", json::array({
                        {{"nodeId", 11}, {"pluginId", "stock:eq"}, {"position", 0}}
                    })}
                }
            }
        });

        ProjectManager pm4;
        REQUIRE(pm4.createProject(tempDir, "GraphStateRoundTrip"),
                "createProject for graphState round-trip returned false");
        REQUIRE(pm4.saveProject(tl, effectChains),
                "saveProject with graphState returned false");

        ProjectManager pm5;
        auto loaded = pm5.loadProject(tempDir);
        REQUIRE(loaded.has_value(), "loadProject with graphState returned nullopt");
        const TrackInfo* loadedTrack = loaded->getTrack(trkId);
        REQUIRE(loadedTrack != nullptr, "loaded graphState track exists");
        CHECK(loadedTrack->hasGraphState,
              "project load preserves graphState presence");
        CHECK(loadedTrack->graphState == graphTrack->graphState,
              "project load preserves graphState unchanged");
        CHECK(pm5.getLoadedEffectChains() == effectChains,
              "effectChains round-trip unchanged with graphState present");
    }

    // Test 6: clean up temp directory.
    std::cout << "\n[6] cleanup\n";
    {
        fs::remove_all(tempDir);
        CHECK(!fs::exists(tempDir), "temp directory removed successfully");
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    std::cout << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED (" << g_passed << " checks)\n";
        return 0;
    } else {
        std::cout << "FAILED: " << g_failed << " check(s) failed, "
                  << g_passed << " passed\n";
        return 1;
    }
}
