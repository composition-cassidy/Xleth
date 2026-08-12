// test_project.cpp — Self-verification for ProjectManager persistence.
// Build: see engine/CMakeLists.txt target "test_project"
// Run:   test_project.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1

#include "project/ProjectManager.h"
#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "model/SampleRegion.h"
#include <cmath>
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
    region.slot(0).rootNote = 36;
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

    // ── Test 5.5: project video canvas round-trips + back-compat defaults ──────
    std::cout << "\n[5.5] gridLayout canvas — save/load + legacy defaults\n";
    {
        // Round-trip a non-default canvas (9:16 vertical, 24 fps) through the
        // exact persistence layer.
        Timeline canvasTl(120.0, 48000.0);
        GridLayout gl = canvasTl.getGridLayout();
        gl.canvasWidth       = 1080;
        gl.canvasHeight      = 1920;
        gl.canvasAspectRatio = "9:16";
        gl.previewFps        = 24;
        canvasTl.setGridLayout(gl);

        json saved = canvasTl.toJSON();
        CHECK(saved["gridLayout"]["canvasWidth"]       == 1080,  "toJSON writes canvasWidth");
        CHECK(saved["gridLayout"]["canvasHeight"]      == 1920,  "toJSON writes canvasHeight");
        CHECK(saved["gridLayout"]["canvasAspectRatio"] == "9:16","toJSON writes canvasAspectRatio");

        Timeline reloaded(140.0, 48000.0);
        REQUIRE(reloaded.fromJSON(saved), "fromJSON of canvas project");
        const GridLayout& rgl = reloaded.getGridLayout();
        CHECK(rgl.canvasWidth       == 1080,  "canvasWidth survives round-trip");
        CHECK(rgl.canvasHeight      == 1920,  "canvasHeight survives round-trip");
        CHECK(rgl.canvasAspectRatio == "9:16","canvasAspectRatio survives round-trip");
        CHECK(rgl.previewFps        == 24,    "previewFps (project frame rate) survives round-trip");

        // Legacy project: a gridLayout WITHOUT canvas fields must default to
        // 1920x1080 / "16:9" so old projects keep loading unchanged.
        json legacy = saved;
        legacy["gridLayout"].erase("canvasWidth");
        legacy["gridLayout"].erase("canvasHeight");
        legacy["gridLayout"].erase("canvasAspectRatio");
        Timeline legacyTl(140.0, 48000.0);
        REQUIRE(legacyTl.fromJSON(legacy), "fromJSON of legacy project");
        const GridLayout& lgl = legacyTl.getGridLayout();
        CHECK(lgl.canvasWidth       == 1920,  "legacy project defaults canvasWidth to 1920");
        CHECK(lgl.canvasHeight      == 1080,  "legacy project defaults canvasHeight to 1080");
        CHECK(lgl.canvasAspectRatio == "16:9","legacy project defaults aspect to 16:9");

        // Odd / out-of-range dimensions normalize to even, in-range values so a
        // hand-edited project can't reach the encoder with a bad size.
        json weird = saved;
        weird["gridLayout"]["canvasWidth"]  = 1921;    // odd  → 1920
        weird["gridLayout"]["canvasHeight"] = 99999;   // huge → clamped
        Timeline weirdTl(140.0, 48000.0);
        REQUIRE(weirdTl.fromJSON(weird), "fromJSON of out-of-range canvas");
        const GridLayout& wgl = weirdTl.getGridLayout();
        CHECK((wgl.canvasWidth % 2) == 0,                 "odd canvasWidth normalized to even");
        CHECK(wgl.canvasHeight <= kCanvasMaxHeight,       "oversize canvasHeight clamped to range");
    }

    // ── Test 5.75: track folders round-trip through saveProject/loadProject ───
    // Regression for the bug where ProjectManager::saveProject/loadProject
    // translated project.json fields but silently dropped "trackLayout", so
    // folders vanished (tracks reverted to flat order) on the very next load
    // even though Timeline::toJSON/fromJSON already round-tripped it fine.
    std::cout << "\n[5.75] track folders round-trip through the project file\n";
    {
        const int folderId = tl.createTrackFolder("Drums", {trkId, patternTrackId}, 0);
        REQUIRE(folderId >= 0, "createTrackFolder returned a valid id");

        ProjectManager pm6;
        REQUIRE(pm6.createProject(tempDir, "TrackLayoutRoundTrip"),
                "createProject for track-layout round-trip returned false");
        REQUIRE(pm6.saveProject(tl), "saveProject with track folder returned false");

        // The folder must actually be present on disk, not just in memory.
        std::ifstream f(tempDir + "/project.json");
        json onDisk; f >> onDisk;
        CHECK(onDisk.contains("trackLayout"), "project.json contains a trackLayout key");
        CHECK(onDisk.value("trackLayout", json::object()).value("folders", json::array()).size() == 1,
              "project.json trackLayout has the saved folder");

        ProjectManager pm7;
        auto loaded = pm7.loadProject(tempDir);
        REQUIRE(loaded.has_value(), "loadProject with track folder returned nullopt");
        const TrackLayout loadedLayout = loaded->getTrackLayout();
        CHECK(loadedLayout.folders.size() == 1,
              "loaded timeline still has the folder (not flattened)");
        if (!loadedLayout.folders.empty()) {
            CHECK(loadedLayout.folders[0].name == "Drums",
                  "loaded folder keeps its name");
            CHECK(loadedLayout.folders[0].trackIds.size() == 2,
                  "loaded folder keeps both member tracks");
        }
    }

    // ── Test 5.9: master volume round-trips and defaults for legacy projects ──
    // Master volume lives only in MixEngine (no Timeline field), so it was never
    // written to project.json at all — every load silently inherited whatever
    // the previously-open project had left in the engine.
    std::cout << "\n[5.9] master volume — round-trip + legacy default\n";
    {
        ProjectManager pm8;
        REQUIRE(pm8.createProject(tempDir, "MasterVolumeRoundTrip"),
                "createProject for master-volume round-trip returned false");
        REQUIRE(pm8.saveProject(tl, json::object(), json(), 0.35f),
                "saveProject with master volume returned false");

        ProjectManager pm9;
        auto loaded = pm9.loadProject(tempDir);
        REQUIRE(loaded.has_value(), "loadProject with master volume returned nullopt");
        CHECK(std::abs(pm9.getLoadedMasterVolume() - 0.35f) < 1e-6f,
              "master volume survives the save/load round trip");

        // A project saved before masterVolume existed must load at unity gain,
        // not inherit the 0.35 from the load above.
        std::ifstream in(tempDir + "/project.json");
        json legacy; in >> legacy; in.close();
        legacy.erase("masterVolume");
        std::ofstream out(tempDir + "/project.json");
        out << legacy.dump(4); out.close();

        auto legacyLoaded = pm9.loadProject(tempDir);
        REQUIRE(legacyLoaded.has_value(), "loadProject of legacy project returned nullopt");
        CHECK(std::abs(pm9.getLoadedMasterVolume() - 1.0f) < 1e-6f,
              "legacy project without masterVolume defaults to unity, not the stale value");
    }

    // ── Test 5.95: BehindGrid hold-last-frame survives save/load round trip ──
    // Regression for the bug where a user turning "Hold Last Frame" off for a
    // BehindGrid backdrop track would see it silently turn back on every time
    // the project was reopened. Root cause: Timeline::fromJSON's post-load
    // migration step force-set videoHoldLastFrame=true for every BehindGrid
    // track unconditionally, discarding whatever was actually saved.
    std::cout << "\n[5.95] BehindGrid track's hold-last-frame survives project reload\n";
    {
        FullscreenLayer backdrop;
        backdrop.trackId   = trkId;
        backdrop.placement = FullscreenLayerPlacement::BehindGrid;
        tl.setFullscreenLayers({backdrop});
        REQUIRE(tl.getTrackMutable(trkId) != nullptr, "backdrop track exists");
        CHECK(tl.getTrackMutable(trkId)->videoHoldLastFrame,
              "assigning a track as BehindGrid auto-enables hold-last-frame");

        // User explicitly turns it off.
        REQUIRE(tl.setTrackVideoHoldLastFrame(trkId, false),
                "setTrackVideoHoldLastFrame(false) returned false");
        CHECK(!tl.getTrackMutable(trkId)->videoHoldLastFrame,
              "hold-last-frame is off before saving");

        ProjectManager pmHold;
        REQUIRE(pmHold.createProject(tempDir, "HoldLastFrameRoundTrip"),
                "createProject for hold-last-frame round-trip returned false");
        REQUIRE(pmHold.saveProject(tl), "saveProject with hold-last-frame off returned false");

        ProjectManager pmHoldReload;
        auto loaded = pmHoldReload.loadProject(tempDir);
        REQUIRE(loaded.has_value(), "loadProject with hold-last-frame off returned nullopt");
        const TrackInfo* loadedTrack = loaded->getTrack(trkId);
        REQUIRE(loadedTrack != nullptr, "backdrop track survives the reload");
        CHECK(!loadedTrack->videoHoldLastFrame,
              "hold-last-frame stays off after reopening the project (was clobbered back to true)");

        // Re-applying the same fullscreen layer set within a session (any
        // unrelated grid edit does this) must not clobber it either.
        loaded->setFullscreenLayers({backdrop});
        CHECK(!loaded->getTrack(trkId)->videoHoldLastFrame,
              "hold-last-frame survives an unrelated setFullscreenLayers call on the same layer set");
    }

    // ── Test 7: sample-slot migration + roundtrip ────────────────────────────
    // Schema 1 stored one sample per region as top-level scalars. Schema 2
    // moves that state onto SampleRegion::slots. A v1 project must load with
    // its sample in slot 0 and EVERY value preserved, or legacy projects
    // change how they sound.
    std::cout << "\n[7] sample slots — legacy migration + save/load roundtrip\n";
    {
        // A hand-built schema-1 region: no "slots" key, per-sample state flat.
        nlohmann::json legacy = {
            {"id", 7}, {"sourceId", 1}, {"name", "LegacyKick"},
            {"label", "Kick"}, {"customLabelName", ""},
            {"startTime", 0.0}, {"endTime", 0.5},
            {"startFrame", 0},  {"endFrame", 12},
            {"audioFilePath", "/fake/legacy.wav"},
            {"swappedAudioPath", ""}, {"hasSwappedAudio", false},
            {"syllables", nlohmann::json::array()},
            // per-sample state that must land on slot 0
            {"rootNote", 42},
            {"smpStart", 1234}, {"smpLength", 5678},
            {"declickMs", 2.5}, {"fadeInMs", 7.5}, {"fadeOutMs", 9.5},
            {"loopEnabled", true}, {"loopStart", 100}, {"loopEnd", 900},
            {"crossfadeSamples", 64},
            {"dcOffsetRemoved", true}, {"normalized", true},
            {"polarityReversed", true}, {"reversed", true},
            // sampler-level state that must stay on the region
            {"crossfadeEnabled", true}, {"attackMs", 12.0}, {"releaseMs", 34.0}
        };

        SampleRegion migrated = legacy.get<SampleRegion>();

        CHECK(migrated.slotCount() == 1, "migration: legacy region yields exactly 1 slot");
        const SampleSlot& m = migrated.slot(0);
        CHECK(m.rootNote == 42,            "migration: rootNote -> slot 0");
        CHECK(m.smpStart == 1234,          "migration: smpStart -> slot 0");
        CHECK(m.smpLength == 5678,         "migration: smpLength -> slot 0");
        CHECK(std::abs(m.declickMs - 2.5f) < 1e-6, "migration: declickMs -> slot 0");
        CHECK(std::abs(m.fadeInMs  - 7.5f) < 1e-6, "migration: fadeInMs -> slot 0");
        CHECK(std::abs(m.fadeOutMs - 9.5f) < 1e-6, "migration: fadeOutMs -> slot 0");
        CHECK(m.loopEnabled,               "migration: loopEnabled -> slot 0");
        CHECK(m.loopStart == 100,          "migration: loopStart -> slot 0");
        CHECK(m.loopEnd   == 900,          "migration: loopEnd -> slot 0");
        CHECK(m.crossfadeSamples == 64,    "migration: crossfadeSamples -> slot 0");
        CHECK(m.dcOffsetRemoved,           "migration: dcOffsetRemoved -> slot 0");
        CHECK(m.normalized,                "migration: normalized -> slot 0");
        CHECK(m.polarityReversed,          "migration: polarityReversed -> slot 0");
        CHECK(m.reversed,                  "migration: reversed -> slot 0");
        // Sampler-level fields stay on the region.
        CHECK(migrated.crossfadeEnabled,   "migration: crossfadeEnabled stays sampler-level");
        CHECK(std::abs(migrated.attackMs - 12.0f) < 1e-6, "migration: attackMs stays sampler-level");

        // Neutral tuning/level: a migrated legacy slot must be a no-op layer,
        // otherwise the project would not sound identical.
        CHECK(std::abs(m.tuningSemitones()) < 1e-12, "migration: tuning is neutral (0 semitones)");
        CHECK(std::abs(m.volume - 1.0f) < 1e-6, "migration: volume is unity");
        CHECK(std::abs(m.pan) < 1e-6,           "migration: pan is centred");
        CHECK(!m.mute && !m.solo,               "migration: not muted or solo'd");

        // ── Multi-slot save → load roundtrip ─────────────────────────────────
        SampleRegion multi = migrated;
        SampleSlot layer;
        layer.audioFilePath = "/fake/slots/layer2.wav";
        layer.name     = "Layer2";
        layer.rootNote = 60;
        layer.octave   = -2;  layer.semitone = 5;
        layer.fine     = -33.5f; layer.coarse = 7;
        layer.volume   = 0.375f; layer.pan = -0.75f;
        layer.mute     = true;   layer.solo = false;
        layer.smpStart = 11; layer.smpLength = 22;
        layer.declickMs = 3.5f; layer.fadeInMs = 1.5f; layer.fadeOutMs = 2.5f;
        layer.loopEnabled = true; layer.loopStart = 5; layer.loopEnd = 500;
        layer.crossfadeSamples = 32;
        layer.reversed = true;
        multi.slots.push_back(layer);

        nlohmann::json saved = multi;
        CHECK(saved.contains("slots") && saved["slots"].is_array(),
              "roundtrip: region serialises a slots array");
        CHECK(saved["slots"].size() == 2, "roundtrip: both slots written");

        SampleRegion reloaded = saved.get<SampleRegion>();
        CHECK(reloaded.slotCount() == 2, "roundtrip: 2 slots restored");

        const SampleSlot& a = reloaded.slot(0);
        CHECK(a.rootNote == 42 && a.smpStart == 1234 && a.smpLength == 5678,
              "roundtrip: slot 0 trim/root preserved");
        CHECK(a.loopEnabled && a.loopStart == 100 && a.loopEnd == 900
              && a.crossfadeSamples == 64, "roundtrip: slot 0 loop preserved");
        CHECK(a.dcOffsetRemoved && a.normalized && a.polarityReversed && a.reversed,
              "roundtrip: slot 0 destructive flags preserved");

        const SampleSlot& b = reloaded.slot(1);
        CHECK(b.audioFilePath == "/fake/slots/layer2.wav",
              "roundtrip: slot 1 audio path preserved");
        CHECK(b.name == "Layer2",         "roundtrip: slot 1 name preserved");
        CHECK(b.rootNote == 60,           "roundtrip: slot 1 rootNote preserved");
        CHECK(b.octave == -2 && b.semitone == 5 && b.coarse == 7,
              "roundtrip: slot 1 integer tuning preserved");
        CHECK(std::abs(b.fine + 33.5f) < 1e-6, "roundtrip: slot 1 fine preserved");
        CHECK(std::abs(b.volume - 0.375f) < 1e-6, "roundtrip: slot 1 volume preserved");
        CHECK(std::abs(b.pan + 0.75f) < 1e-6,     "roundtrip: slot 1 pan preserved");
        CHECK(b.mute && !b.solo,          "roundtrip: slot 1 mute/solo preserved");
        CHECK(b.smpStart == 11 && b.smpLength == 22,
              "roundtrip: slot 1 trim preserved");
        CHECK(b.loopEnabled && b.loopStart == 5 && b.loopEnd == 500
              && b.crossfadeSamples == 32, "roundtrip: slot 1 loop preserved");
        CHECK(b.reversed, "roundtrip: slot 1 reversed preserved");
        CHECK(std::abs(b.tuningSemitones() - (-24.0 + 5.0 + 7.0 - 0.335)) < 1e-6,
              "roundtrip: slot 1 combined tuning survives the trip");

        // Re-serialising the reloaded region must be byte-identical: proves the
        // roundtrip has no lossy field.
        nlohmann::json resaved = reloaded;
        CHECK(resaved["slots"] == saved["slots"],
              "roundtrip: save -> load -> save is stable");

        // A malformed region with an empty slots array must still yield one slot.
        nlohmann::json broken = saved;
        broken["slots"] = nlohmann::json::array();
        SampleRegion repaired = broken.get<SampleRegion>();
        CHECK(repaired.slotCount() == 1, "roundtrip: empty slots array repaired to 1 slot");

        // Schema version is written and is the current one.
        CHECK(XLETH_PROJECT_SCHEMA_VERSION >= 2,
              "schema: project schema version bumped for slots");
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
