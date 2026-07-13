// test_timeline.cpp — Phase 1 self-verification for the Timeline data model.
// Build: see engine/CMakeLists.txt target "test_timeline"
// Run:   test_timeline.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1

#include "model/Timeline.h"
#include "commands/TimelineCommands.h"
#include "render/SnapshotTransitionTiming.h"
#include <cassert>
#include <cmath>
#include <iostream>
#include <string>

// ─── Minimal test harness ─────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                             \
    do {                                                             \
        if (cond) {                                                  \
            ++g_passed;                                              \
        } else {                                                     \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; \
            ++g_failed;                                              \
        }                                                            \
    } while (0)

#define CHECK_NEAR(a, b, tol, msg) \
    CHECK(std::abs((double)(a) - (double)(b)) < (tol), msg)

// ─── Test sections ────────────────────────────────────────────────────────────

static void testTickTimeMath() {
    std::cout << "[1] TickTime math\n";

    // fromBeats(4).toSeconds(140) ≈ 1.714s  (4 beats * 60/140 s/beat)
    CHECK_NEAR(TickTime::fromBeats(4).toSeconds(140.0), 1.7142857, 0.001,
               "fromBeats(4).toSeconds(140) ≈ 1.714s");

    // from16th(1).ticks == 240  (960 PPQ / 4 = 240 per 16th)
    CHECK(TickTime::from16th(1).ticks == 240,
          "from16th(1).ticks == 240");

    // fromBars(1).toBeats() == 4.0  (default 4/4)
    CHECK_NEAR(TickTime::fromBars(1).toBeats(), 4.0, 1e-9,
               "fromBars(1).toBeats() == 4.0");

    // fromBars(2, 3) — 3/4 time bar
    CHECK(TickTime::fromBars(2, 3).ticks == 2 * 3 * 960,
          "fromBars(2, 3).ticks == 5760");

    // toSamples round-trip
    auto t = TickTime::fromBeats(1.0);
    int64_t samples = t.toSamples(140.0, 44100.0);
    CHECK(samples > 18000 && samples < 19000,
          "fromBeats(1).toSamples(140, 44100) in [18000, 19000)");

    // arithmetic
    CHECK((TickTime::from16th(3) + TickTime::from16th(1)).ticks == 960,
          "from16th(3) + from16th(1) == 960 ticks (1 beat)");
    CHECK((TickTime::fromBeats(4) - TickTime::fromBeats(1)).ticks == 3 * 960,
          "fromBeats(4) - fromBeats(1) == 3 beats");

    // comparisons
    CHECK(TickTime::from16th(1) < TickTime::from16th(2),  "240 < 480");
    CHECK(TickTime::from16th(2) == TickTime::from16th(2), "480 == 480");
    CHECK(TickTime::from16th(2) <= TickTime::from16th(2), "480 <= 480");
    CHECK(TickTime::from16th(2) >= TickTime::from16th(1), "480 >= 240");
    CHECK(TickTime::from16th(2) > TickTime::from16th(1),  "480 > 240");
}

static void testSampleLabelConversion() {
    std::cout << "[2] SampleLabel string conversion\n";
    CHECK(sampleLabelToString(SampleLabel::Kick)   == "Kick",   "Kick");
    CHECK(sampleLabelToString(SampleLabel::Snare)  == "Snare",  "Snare");
    CHECK(sampleLabelToString(SampleLabel::HiHat)  == "HiHat",  "HiHat");
    CHECK(sampleLabelToString(SampleLabel::Crash)  == "Crash",  "Crash");
    CHECK(sampleLabelToString(SampleLabel::Pitch)  == "Pitch",  "Pitch");
    CHECK(sampleLabelToString(SampleLabel::Quote)  == "Quote",  "Quote");
    CHECK(sampleLabelToString(SampleLabel::Custom) == "Custom", "Custom");
    CHECK(stringToSampleLabel("Kick")   == SampleLabel::Kick,   "str→Kick");
    CHECK(stringToSampleLabel("Quote")  == SampleLabel::Quote,  "str→Quote");
    CHECK(stringToSampleLabel("??")     == SampleLabel::Custom, "unknown→Custom");
}

// ─── Main test ────────────────────────────────────────────────────────────────

static nlohmann::json makeMinimalClipJson() {
    return nlohmann::json{
        {"id", 1},
        {"trackId", 2},
        {"regionId", 3},
        {"positionTicks", 0},
        {"durationTicks", 1000},
        {"regionOffsetTicks", 0},
        {"syllableIndex", -1},
        {"velocity", 1.0f},
        {"pitchOffset", 0}
    };
}

static void testClipFadePercentConversion() {
    std::cout << "[2b] Clip fade percentage conversion\n";

    Clip c{};
    c.id = 1;
    c.trackId = 2;
    c.regionId = 3;
    c.duration.ticks = 1000;
    c.syllableIndex = -1;
    c.velocity = 1.0f;
    c.fadeInPercent = 80.0f;
    c.fadeOutPercent = 80.0f;

    nlohmann::json saved = c;
    CHECK(saved.contains("fadeInPercent"), "new JSON writes fadeInPercent");
    CHECK(saved.contains("fadeOutPercent"), "new JSON writes fadeOutPercent");
    CHECK(!saved.contains("fadeInTicks"), "new JSON omits legacy fadeInTicks");
    CHECK(!saved.contains("fadeOutTicks"), "new JSON omits legacy fadeOutTicks");
    CHECK_NEAR(saved["fadeInPercent"].get<float>(), 50.0f, 1e-4,
               "80/80 fade auto-balances fade-in to 50%");
    CHECK_NEAR(saved["fadeOutPercent"].get<float>(), 50.0f, 1e-4,
               "80/80 fade auto-balances fade-out to 50%");

    nlohmann::json legacy = makeMinimalClipJson();
    legacy["fadeInTicks"] = 500.0f;
    legacy["fadeOutTicks"] = 250.0f;
    Clip migrated = legacy.get<Clip>();
    CHECK_NEAR(migrated.fadeInPercent, 50.0f, 1e-4,
               "legacy fadeInTicks migrates to clip-length percent");
    CHECK_NEAR(migrated.fadeOutPercent, 25.0f, 1e-4,
               "legacy fadeOutTicks migrates to clip-length percent");

    nlohmann::json legacyOverlap = makeMinimalClipJson();
    legacyOverlap["fadeInTicks"] = 800.0f;
    legacyOverlap["fadeOutTicks"] = 800.0f;
    Clip overlap = legacyOverlap.get<Clip>();
    CHECK_NEAR(overlap.fadeInPercent, 50.0f, 1e-4,
               "legacy overlapping fades auto-balance fade-in");
    CHECK_NEAR(overlap.fadeOutPercent, 50.0f, 1e-4,
               "legacy overlapping fades auto-balance fade-out");

    nlohmann::json clamped = makeMinimalClipJson();
    clamped["fadeInPercent"] = 120.0f;
    clamped["fadeOutPercent"] = -10.0f;
    Clip clampTest = clamped.get<Clip>();
    CHECK_NEAR(clampTest.fadeInPercent, 100.0f, 1e-4,
               "fade-in percent clamps to 100");
    CHECK_NEAR(clampTest.fadeOutPercent, 0.0f, 1e-4,
               "fade-out percent clamps to 0");

    CHECK(clipFadePercentToSamples(48000, 50.0f) == 24000,
          "50% fade resolves to half the rendered clip length");
    CHECK(clipFadePercentToSamples(48000, 100.0f) == 48000,
          "100% fade resolves to the full rendered clip length");
}

// ─── [15] VideoFlipConfig migration round-trip ────────────────────────────────
// Loads a minimal track JSON carrying a legacy videoFlipMode string, verifies
// the resulting VideoFlipConfig matches spec §3.5, then saves and reloads to
// confirm the new schema survives a round-trip and the old field is gone.

static nlohmann::json makeMinimalTrackJson(const std::string& videoFlipMode) {
    return nlohmann::json{
        {"id",                1},
        {"name",              "TestTrack"},
        {"volume",            1.0f},
        {"pan",               0.0f},
        {"stereoSpread",      1.0f},
        {"muted",             false},
        {"solo",              false},
        {"visualOnly",        false},
        {"order",             0},
        {"videoX",            0.0f},
        {"videoY",            0.0f},
        {"videoW",            1920.0f},
        {"videoH",            1080.0f},
        {"videoOpacity",      1.0f},
        {"videoZOrder",       0},
        {"type",              "Clip"},
        {"videoFlipMode",     videoFlipMode},
        {"videoHoldLastFrame", false}
    };
}

static void testVideoFlipConfigMigration() {
    std::cout << "[15] VideoFlipConfig migration round-trip\n";

    // ── 15a: None ──────────────────────────────────────────────────────────
    {
        TrackInfo t = makeMinimalTrackJson("None").get<TrackInfo>();
        CHECK(!t.videoFlipConfig.enabled,           "None → enabled=false");
        CHECK(t.videoFlipConfig.states.size() == 1, "None → 1 state");
        CHECK(t.videoFlipConfig.states[0].orientation == Orientation::None,
              "None → state[0]=none");
        CHECK(t.videoFlipConfig.modifier.type == VideoFlipModifier::Type::EveryNote,
              "None → modifier=every-note");
        CHECK(t.videoFlipConfig.startStateIndex == 0, "None → startStateIndex=0");
        // Round-trip: save → reload.
        nlohmann::json saved = t;
        CHECK(saved.contains("videoFlipConfig"),    "saved JSON has videoFlipConfig");
        CHECK(!saved.contains("videoFlipMode"),     "saved JSON has no legacy videoFlipMode");
        TrackInfo t2 = saved.get<TrackInfo>();
        CHECK(!t2.videoFlipConfig.enabled,          "None round-trip: enabled=false");
        CHECK(t2.videoFlipConfig.states.size() == 1,"None round-trip: 1 state");
    }

    // ── 15b: HorizontalEven ───────────────────────────────────────────────
    {
        TrackInfo t = makeMinimalTrackJson("HorizontalEven").get<TrackInfo>();
        CHECK(t.videoFlipConfig.enabled,            "HorizEven → enabled=true");
        CHECK(t.videoFlipConfig.states.size() == 2, "HorizEven → 2 states");
        CHECK(t.videoFlipConfig.states[0].orientation == Orientation::None,
              "HorizEven → state[0]=none");
        CHECK(t.videoFlipConfig.states[1].orientation == Orientation::Horizontal,
              "HorizEven → state[1]=horizontal");
        CHECK(t.videoFlipConfig.modifier.type == VideoFlipModifier::Type::EveryNote,
              "HorizEven → modifier=every-note");
        CHECK(t.videoFlipConfig.startStateIndex == 1, "HorizEven → startStateIndex=1");
        // Legacy-mode reverse lookup for UI compat.
        CHECK(videoFlipConfigToLegacyMode(t.videoFlipConfig) == "HorizontalEven",
              "HorizEven → reverse→HorizontalEven");
        // Round-trip.
        nlohmann::json saved = t;
        TrackInfo t3 = saved.get<TrackInfo>();
        CHECK(t3.videoFlipConfig.enabled,            "HorizEven round-trip: enabled");
        CHECK(t3.videoFlipConfig.startStateIndex == 1,"HorizEven round-trip: startIdx=1");
        CHECK(t3.videoFlipConfig.states[1].orientation == Orientation::Horizontal,
              "HorizEven round-trip: state[1]=horizontal");
    }

    // ── 15c: Clockwise ────────────────────────────────────────────────────
    {
        TrackInfo t = makeMinimalTrackJson("Clockwise").get<TrackInfo>();
        CHECK(t.videoFlipConfig.enabled,            "CW → enabled=true");
        CHECK(t.videoFlipConfig.states.size() == 4, "CW → 4 states");
        CHECK(t.videoFlipConfig.states[0].orientation == Orientation::None,     "CW s0=none");
        CHECK(t.videoFlipConfig.states[1].orientation == Orientation::Vertical, "CW s1=vertical");
        CHECK(t.videoFlipConfig.states[2].orientation == Orientation::Rotate180,"CW s2=rotate-180");
        CHECK(t.videoFlipConfig.states[3].orientation == Orientation::Horizontal,"CW s3=horizontal");
        CHECK(t.videoFlipConfig.startStateIndex == 0, "CW → startStateIndex=0");
        CHECK(videoFlipConfigToLegacyMode(t.videoFlipConfig) == "Clockwise",
              "CW → reverse→Clockwise");
        // Ordinal verification (spec §7.6): every-note, 4 states, startIdx=0
        // ordinal 0→state 0, ordinal 1→state 1, 2→2, 3→3, 4→0 (wrap)
        // Verify orientations match accepted table.
        const auto& st = t.videoFlipConfig.states;
        CHECK(st[0].orientation == Orientation::None,      "CW ord0 orientation=none");
        CHECK(st[1].orientation == Orientation::Vertical,  "CW ord1 orientation=vertical");
        CHECK(st[2].orientation == Orientation::Rotate180, "CW ord2 orientation=rotate-180");
        CHECK(st[3].orientation == Orientation::Horizontal,"CW ord3 orientation=horizontal");
    }

    // ── 15d: CounterClockwise ─────────────────────────────────────────────
    {
        TrackInfo t = makeMinimalTrackJson("CounterClockwise").get<TrackInfo>();
        CHECK(t.videoFlipConfig.enabled,            "CCW → enabled=true");
        CHECK(t.videoFlipConfig.states.size() == 4, "CCW → 4 states");
        CHECK(t.videoFlipConfig.states[0].orientation == Orientation::None,      "CCW s0=none");
        CHECK(t.videoFlipConfig.states[1].orientation == Orientation::Horizontal,"CCW s1=horizontal");
        CHECK(t.videoFlipConfig.states[2].orientation == Orientation::Rotate180, "CCW s2=rotate-180");
        CHECK(t.videoFlipConfig.states[3].orientation == Orientation::Vertical,  "CCW s3=vertical");
        CHECK(t.videoFlipConfig.startStateIndex == 0, "CCW → startStateIndex=0");
        CHECK(videoFlipConfigToLegacyMode(t.videoFlipConfig) == "CounterClockwise",
              "CCW → reverse→CounterClockwise");
    }

    // ── 15e: New v2 config round-trips losslessly (no legacy field) ───────
    {
        VideoFlipConfig cfg;
        cfg.enabled         = true;
        cfg.startStateIndex = 2;
        cfg.states = {
            {"a0", Orientation::None,       ""},
            {"a1", Orientation::Horizontal, "flip"},
            {"a2", Orientation::Rotate90CW, "spin"},
        };
        cfg.modifier.type        = VideoFlipModifier::Type::SpecificPitches;
        cfg.modifier.pitches     = {60, 67, 72};

        TrackInfo t;
        t.videoFlipConfig = cfg;
        nlohmann::json saved = t;
        CHECK(saved.contains("videoFlipConfig"),   "v2 config: JSON has videoFlipConfig");
        CHECK(!saved.contains("videoFlipMode"),    "v2 config: JSON has no legacy field");

        TrackInfo t2 = saved.get<TrackInfo>();
        const auto& r = t2.videoFlipConfig;
        CHECK(r.enabled,                           "v2 round-trip: enabled=true");
        CHECK(r.startStateIndex == 2,              "v2 round-trip: startIdx=2");
        CHECK(r.states.size() == 3,                "v2 round-trip: 3 states");
        CHECK(r.states[0].orientation == Orientation::None,      "v2 s0=none");
        CHECK(r.states[1].orientation == Orientation::Horizontal,"v2 s1=horizontal");
        CHECK(r.states[2].orientation == Orientation::Rotate90CW,"v2 s2=rotate-90-cw");
        CHECK(r.states[1].label == "flip",         "v2 state label preserved");
        CHECK(r.modifier.type == VideoFlipModifier::Type::SpecificPitches,
              "v2 modifier=specific-pitches");
        CHECK(r.modifier.pitches.size() == 3,      "v2 pitches count=3");
        CHECK(r.modifier.pitches[0] == 60,         "v2 pitch[0]=60");
        CHECK(r.modifier.pitches[1] == 67,         "v2 pitch[1]=67");
        CHECK(r.modifier.pitches[2] == 72,         "v2 pitch[2]=72");
    }

    // ── 15f: every-n-beats modifier round-trips ───────────────────────────
    {
        VideoFlipConfig cfg;
        cfg.enabled             = true;
        cfg.states              = { {"b0", Orientation::None, ""},
                                    {"b1", Orientation::Vertical, ""} };
        cfg.modifier.type        = VideoFlipModifier::Type::EveryNBeats;
        cfg.modifier.n           = 4;
        cfg.modifier.subdivision = VideoFlipModifier::Subdivision::Bar;
        cfg.startStateIndex      = 0;

        TrackInfo t;
        t.videoFlipConfig = cfg;
        nlohmann::json saved = t;
        TrackInfo t2 = saved.get<TrackInfo>();
        const auto& r = t2.videoFlipConfig;
        CHECK(r.modifier.type == VideoFlipModifier::Type::EveryNBeats,
              "every-n-beats round-trip: type");
        CHECK(r.modifier.n == 4,                    "every-n-beats: n=4");
        CHECK(r.modifier.subdivision == VideoFlipModifier::Subdivision::Bar,
              "every-n-beats: subdivision=bar");
    }

    // ── 15g: projectFileVersion bumped ────────────────────────────────────
    {
        Timeline tl;
        nlohmann::json j = tl.toJSON();
        CHECK(j.contains("projectFileVersion"),     "toJSON writes projectFileVersion");
        CHECK(j["projectFileVersion"].get<int>() == kProjectFileVersion,
              "projectFileVersion == kProjectFileVersion");
        // Legacy project (no version field) loads cleanly.
        j.erase("projectFileVersion");
        Timeline tl2;
        CHECK(tl2.fromJSON(j), "legacy project (no version) loads without error");
    }
}

static void testTrackFxModePersistence() {
    std::cout << "[16] Track fxMode persistence\n";

    CHECK(trackFxModeToString(TrackFxMode::Chain) == "chain",
          "TrackFxMode::Chain serializes to chain");
    CHECK(trackFxModeToString(TrackFxMode::Graph) == "graph",
          "TrackFxMode::Graph serializes to graph");
    CHECK(stringToTrackFxMode("chain") == TrackFxMode::Chain,
          "chain parses as TrackFxMode::Chain");
    CHECK(stringToTrackFxMode("graph") == TrackFxMode::Graph,
          "graph parses as TrackFxMode::Graph");
    CHECK(stringToTrackFxMode("Graph") == TrackFxMode::Chain,
          "non-exact Graph parses as chain");
    CHECK(stringToTrackFxMode("invalid") == TrackFxMode::Chain,
          "invalid fxMode parses as chain");

    {
        TrackInfo t;
        nlohmann::json saved = t;
        CHECK(saved.contains("fxMode"), "default track JSON writes fxMode");
        CHECK(saved["fxMode"].get<std::string>() == "chain",
              "default track JSON writes fxMode=chain");
    }

    {
        TrackInfo t;
        t.fxMode = TrackFxMode::Graph;
        nlohmann::json saved = t;
        CHECK(saved["fxMode"].get<std::string>() == "graph",
              "graph track JSON writes fxMode=graph");
        TrackInfo loaded = saved.get<TrackInfo>();
        CHECK(loaded.fxMode == TrackFxMode::Graph,
              "graph track JSON reloads as graph");
    }

    {
        nlohmann::json missing = makeMinimalTrackJson("None");
        missing.erase("fxMode");
        TrackInfo loaded = missing.get<TrackInfo>();
        CHECK(loaded.fxMode == TrackFxMode::Chain,
              "missing fxMode loads as chain");

        nlohmann::json invalid = makeMinimalTrackJson("None");
        invalid["fxMode"] = "invalid";
        TrackInfo invalidLoaded = invalid.get<TrackInfo>();
        CHECK(invalidLoaded.fxMode == TrackFxMode::Chain,
              "invalid fxMode loads as chain");

        nlohmann::json nullMode = makeMinimalTrackJson("None");
        nullMode["fxMode"] = nullptr;
        TrackInfo nullLoaded = nullMode.get<TrackInfo>();
        CHECK(nullLoaded.fxMode == TrackFxMode::Chain,
              "null fxMode loads as chain");
    }

    {
        Timeline tl;
        TrackInfo chainTrack;
        chainTrack.name = "Chain";
        chainTrack.order = 0;
        const int chainId = tl.addTrack(chainTrack);

        TrackInfo graphTrack;
        graphTrack.name = "Graph";
        graphTrack.order = 1;
        graphTrack.fxMode = TrackFxMode::Graph;
        const int graphId = tl.addTrack(graphTrack);

        nlohmann::json saved = tl.toJSON();
        CHECK(saved["tracks"].size() == 2, "mixed-mode project writes two tracks");
        CHECK(saved["tracks"][0]["fxMode"].get<std::string>() == "chain",
              "mixed-mode project writes chain track");
        CHECK(saved["tracks"][1]["fxMode"].get<std::string>() == "graph",
              "mixed-mode project writes graph track");

        Timeline loaded;
        CHECK(loaded.fromJSON(saved), "mixed-mode project reloads");
        CHECK(loaded.getTrack(chainId)->fxMode == TrackFxMode::Chain,
              "mixed-mode reload preserves chain");
        CHECK(loaded.getTrack(graphId)->fxMode == TrackFxMode::Graph,
              "mixed-mode reload preserves graph");

        for (auto& trackJson : saved["tracks"]) {
            trackJson.erase("fxMode");
        }

        Timeline oldProject;
        CHECK(oldProject.fromJSON(saved), "old project without fxMode fields reloads");
        CHECK(oldProject.getTrack(chainId)->fxMode == TrackFxMode::Chain,
              "old project chain track defaults to chain");
        CHECK(oldProject.getTrack(graphId)->fxMode == TrackFxMode::Chain,
              "old project graphless track defaults to chain");
    }
}

static nlohmann::json makeOpaqueGraphState(const std::string& trackId,
                                           int schemaVersion = 1) {
    return nlohmann::json{
        {"schemaVersion", schemaVersion},
        {"trackId", trackId},
        {"nodes", nlohmann::json::array({
            {{"id", "input"}, {"type", "trackInput"}},
            {{"id", "output"}, {"type", "trackOutput"}}
        })},
        {"edges", nlohmann::json::array({
            {
                {"id", "edge-1"},
                {"sourceNodeId", "input"},
                {"sourcePort", "audio"},
                {"targetNodeId", "output"},
                {"targetPort", "audio"},
                {"type", "audio"}
            }
        })},
        {"viewport", {{"x", 10.0}, {"y", 20.0}, {"zoom", 1.5}}}
    };
}

static void testGraphStateOpaquePersistence() {
    std::cout << "[17] Track graphState opaque persistence\n";

    {
        TrackInfo t;
        t.id = 7;
        t.fxMode = TrackFxMode::Graph;
        t.hasGraphState = true;
        t.graphState = makeOpaqueGraphState("7");

        nlohmann::json saved = t;
        CHECK(saved.contains("graphState"),
              "track JSON writes graphState when present");
        CHECK(saved["graphState"] == t.graphState,
              "track JSON writes graphState unchanged");

        TrackInfo loaded = saved.get<TrackInfo>();
        CHECK(loaded.hasGraphState,
              "track JSON reload marks graphState present");
        CHECK(loaded.graphState == t.graphState,
              "track JSON reload preserves graphState unchanged");
    }

    {
        TrackInfo t;
        nlohmann::json saved = t;
        CHECK(!saved.contains("graphState"),
              "absent graphState is not written as a fake document");

        TrackInfo loaded = saved.get<TrackInfo>();
        CHECK(!loaded.hasGraphState,
              "missing graphState reloads as absent");
        CHECK(loaded.graphState.is_null(),
              "missing graphState leaves opaque JSON null");
    }

    {
        nlohmann::json j = makeMinimalTrackJson("None");
        j["graphState"] = nullptr;

        TrackInfo loaded = j.get<TrackInfo>();
        CHECK(loaded.hasGraphState,
              "null graphState reloads as present opaque JSON");
        CHECK(loaded.graphState.is_null(),
              "null graphState stays null");

        nlohmann::json saved = loaded;
        CHECK(saved.contains("graphState") && saved["graphState"].is_null(),
              "null graphState saves without crashing");
    }

    {
        nlohmann::json invalidGraphState = {
            {"schemaVersion", 1},
            {"trackId", "7"},
            {"nodes", "invalid"},
            {"edges", nlohmann::json::array()}
        };
        nlohmann::json j = makeMinimalTrackJson("None");
        j["id"] = 7;
        j["graphState"] = invalidGraphState;

        TrackInfo loaded = j.get<TrackInfo>();
        nlohmann::json saved = loaded;
        CHECK(saved["graphState"] == invalidGraphState,
              "invalid graphState object round-trips opaquely");
    }

    {
        nlohmann::json futureGraphState = makeOpaqueGraphState("7", 99);
        futureGraphState["futureField"] = {{"kept", true}};
        nlohmann::json j = makeMinimalTrackJson("None");
        j["id"] = 7;
        j["graphState"] = futureGraphState;

        TrackInfo loaded = j.get<TrackInfo>();
        nlohmann::json saved = loaded;
        CHECK(saved["graphState"] == futureGraphState,
              "future graphState object round-trips opaquely");
    }

    {
        Timeline tl;
        TrackInfo track;
        track.name = "Graph";
        track.fxMode = TrackFxMode::Graph;
        const int trackId = tl.addTrack(track);
        TrackInfo* stored = tl.getTrackMutable(trackId);
        CHECK(stored != nullptr, "getTrackMutable returned graph test track");
        if (!stored) return;
        stored->hasGraphState = true;
        stored->graphState = makeOpaqueGraphState(std::to_string(trackId));

        nlohmann::json saved = tl.toJSON();
        CHECK(saved["tracks"][0]["graphState"] == stored->graphState,
              "timeline saves track graphState unchanged");

        Timeline loaded;
        CHECK(loaded.fromJSON(saved), "timeline reload with graphState succeeds");
        const TrackInfo* loadedTrack = loaded.getTrack(trackId);
        CHECK(loadedTrack != nullptr, "loaded graphState track exists");
        if (!loadedTrack) return;
        CHECK(loadedTrack->hasGraphState,
              "timeline reload preserves graphState presence");
        CHECK(loadedTrack->graphState == stored->graphState,
              "timeline reload preserves graphState JSON unchanged");
        CHECK(loadedTrack->fxMode == TrackFxMode::Graph,
              "timeline reload keeps fxMode engine-persisted");
    }
}

// ─── Fullscreen layer zOrder (unified compositing order) ──────────────────────
// Proves: (1) an old-format project — fullscreenLayers with NO per-layer zOrder —
// migrates on load to canonical zOrders that reproduce the legacy behind<grid<front
// banding exactly (lossless); (2) a new-format project with explicit (possibly
// interleaved) zOrders round-trips verbatim; (3) setPlacementZOrder is undo-tracked.
static void testFullscreenZOrderMigration() {
    std::cout << "[Z] Fullscreen zOrder migration + round-trip\n";

    Timeline tl(140.0, 48000.0);
    TrackInfo a;  a.name  = "A";  int tA  = tl.addTrack(a);
    TrackInfo b;  b.name  = "B";  int tB  = tl.addTrack(b);
    TrackInfo bg; bg.name = "BG"; int tBG = tl.addTrack(bg);
    TrackInfo fg; fg.name = "FG"; int tFG = tl.addTrack(fg);

    const int FCOL = kGridSubUnitsPerColumn;
    const int FROW = kGridSubUnitsPerRow;
    GridLayout gl; gl.columns = 2; gl.rows = 1;
    gl.slots.push_back({tA, 0,    0, FCOL, FROW, 1.0f, 0});    // grid zOrder 0
    gl.slots.push_back({tB, FCOL, 0, FCOL, FROW, 1.0f, 10});   // grid zOrder 10
    gl.fullscreenLayers.push_back({tBG, FullscreenLayerPlacement::BehindGrid,   1.0f, 0});
    gl.fullscreenLayers.push_back({tFG, FullscreenLayerPlacement::InFrontOfGrid, 0.7f, 0});
    tl.setGridLayout(gl);

    // (1) Simulate an OLD project file: serialize, then strip zOrder from every
    // fullscreen layer, then load into a fresh timeline. Since the persisted
    // arrangement now nests under the active snapshot, the layers live at
    // gridLayout.snapshots[0].fullscreenLayers (see Timeline::toJSON).
    nlohmann::json oldJson = tl.toJSON();
    for (auto& flj : oldJson["gridLayout"]["snapshots"][0]["fullscreenLayers"])
        flj.erase("zOrder");

    Timeline loadedOld(140.0, 48000.0);
    CHECK(loadedOld.fromJSON(oldJson), "load old-format project (no fullscreen zOrder)");
    const auto& oldFls = loadedOld.getFullscreenLayers();
    CHECK(oldFls.size() == 2, "old-format: 2 fullscreen layers survived load");
    // gridMin=0, gridMax=10. Behind must be < 0; front must be > 10.
    if (oldFls.size() == 2) {
        const FullscreenLayer& behind = oldFls[0].placement == FullscreenLayerPlacement::BehindGrid
                                        ? oldFls[0] : oldFls[1];
        const FullscreenLayer& front  = oldFls[0].placement == FullscreenLayerPlacement::InFrontOfGrid
                                        ? oldFls[0] : oldFls[1];
        CHECK(behind.zOrder < 0,  "migrated behind layer zOrder < min grid zOrder (0)");
        CHECK(front.zOrder  > 10, "migrated front layer zOrder > max grid zOrder (10)");
    }

    // (2) NEW-format round-trip with an INTERLEAVED fullscreen zOrder. Move the
    // behind layer between the two grid cells (0 < 5 < 10) via the undo-tracked
    // command, then serialize/reload and confirm it survives verbatim.
    int preCmdZ = 0;
    for (const auto& fl : tl.getFullscreenLayers())
        if (fl.trackId == tBG) preCmdZ = fl.zOrder;

    SetPlacementZOrderCommand cmd(tBG, 5, tl);
    cmd.execute(tl);
    bool foundInterleaved = false;
    for (const auto& fl : tl.getFullscreenLayers())
        if (fl.trackId == tBG) { CHECK(fl.zOrder == 5, "setPlacementZOrder set behind layer to 5"); foundInterleaved = true; }
    CHECK(foundInterleaved, "behind layer present after setPlacementZOrder");

    nlohmann::json newJson = tl.toJSON();
    Timeline loadedNew(140.0, 48000.0);
    CHECK(loadedNew.fromJSON(newJson), "reload new-format project (with zOrder)");
    bool interleavePreserved = false;
    for (const auto& fl : loadedNew.getFullscreenLayers())
        if (fl.trackId == tBG && fl.zOrder == 5) interleavePreserved = true;
    CHECK(interleavePreserved, "interleaved fullscreen zOrder (5) round-trips verbatim");

    // (3) Undo restores the exact pre-command zOrder.
    cmd.undo(tl);
    for (const auto& fl : tl.getFullscreenLayers())
        if (fl.trackId == tBG) CHECK(fl.zOrder == preCmdZ, "undo restored the pre-command zOrder");
}

// ─── Grid snapshot container migration + round-trip (Phase 1) ─────────────────
// Structural equality of two flat getGridLayout() DTOs — the exact object the
// IPC surface exchanges. Used to prove the snapshot refactor is invisible to
// callers (the flat DTO must survive a serialize/reload unchanged).
static bool gridLayoutDtoEqual(const GridLayout& a, const GridLayout& b) {
    if (a.columns != b.columns || a.rows != b.rows) return false;
    if (a.previewFps != b.previewFps) return false;
    if (a.canvasWidth != b.canvasWidth || a.canvasHeight != b.canvasHeight) return false;
    if (a.canvasAspectRatio != b.canvasAspectRatio) return false;
    if (std::abs(a.gapScale - b.gapScale) > 1e-6f) return false;
    if (a.slots.size() != b.slots.size()) return false;
    for (size_t i = 0; i < a.slots.size(); ++i) {
        const GridSlot& x = a.slots[i];
        const GridSlot& y = b.slots[i];
        if (x.trackId != y.trackId || x.gridX != y.gridX || x.gridY != y.gridY
            || x.spanX != y.spanX || x.spanY != y.spanY || x.zOrder != y.zOrder
            || std::abs(x.opacity - y.opacity) > 1e-6f) return false;
    }
    if (a.fullscreenLayers.size() != b.fullscreenLayers.size()) return false;
    for (size_t i = 0; i < a.fullscreenLayers.size(); ++i) {
        const FullscreenLayer& x = a.fullscreenLayers[i];
        const FullscreenLayer& y = b.fullscreenLayers[i];
        if (x.trackId != y.trackId || x.placement != y.placement || x.zOrder != y.zOrder
            || std::abs(x.opacity - y.opacity) > 1e-6f) return false;
    }
    return true;
}

// Proves the snapshot refactor is behavior-preserving at the persistence layer:
//   (A) the flat active layout serializes into a nested snapshot container
//       (canvas/fps global; columns/rows/gapScale/slots/fullscreenLayers under a
//       single "Base" snapshot; activeSnapshotId + cues reserved), and reloading
//       yields an identical flat getGridLayout() DTO;
//   (B) a LEGACY flat gridLayout (no `snapshots` key) migrates on load into the
//       "Base" snapshot and returns the identical flat DTO, and re-saving it
//       produces the nested container form.
static void testGridSnapshotContainerMigration() {
    std::cout << "[S] Grid snapshot container migration + round-trip\n";

    const int FCOL = kGridSubUnitsPerColumn;
    const int FROW = kGridSubUnitsPerRow;

    // Timeline with tracks + a known non-default flat grid layout.
    Timeline tl(120.0, 48000.0);
    TrackInfo a;  a.name  = "A";  int tA  = tl.addTrack(a);
    TrackInfo b;  b.name  = "B";  int tB  = tl.addTrack(b);
    TrackInfo bg; bg.name = "BG"; int tBG = tl.addTrack(bg);

    GridLayout gl = tl.getGridLayout();
    gl.columns = 2; gl.rows = 1; gl.gapScale = 0.25f;
    gl.canvasWidth = 1280; gl.canvasHeight = 720; gl.canvasAspectRatio = "16:9";
    gl.previewFps = 24;
    gl.slots.push_back({tA, 0,    0, FCOL, FROW, 1.0f, 0});
    gl.slots.push_back({tB, FCOL, 0, FCOL, FROW, 0.5f, 3});
    gl.fullscreenLayers.push_back({tBG, FullscreenLayerPlacement::BehindGrid, 0.8f, -1});
    tl.setGridLayout(gl);

    const GridLayout before = tl.getGridLayout();  // flat DTO baseline

    // ── (A) Nested serialization shape + round-trip ───────────────────────────
    nlohmann::json saved = tl.toJSON();
    const nlohmann::json& sgl = saved["gridLayout"];
    CHECK(sgl.contains("snapshots") && sgl["snapshots"].is_array()
          && sgl["snapshots"].size() == 1, "toJSON writes exactly one snapshot");
    CHECK(sgl.contains("activeSnapshotId"), "toJSON writes activeSnapshotId");
    CHECK(sgl.contains("cues") && sgl["cues"].is_array() && sgl["cues"].empty(),
          "toJSON writes an empty reserved cues array");
    CHECK(sgl["snapshots"][0]["name"] == "Base", "single snapshot is named Base");
    CHECK(sgl["snapshots"][0]["id"] == sgl["activeSnapshotId"],
          "activeSnapshotId points at the Base snapshot");
    // Global fields stay at the container level ...
    CHECK(sgl["canvasWidth"] == 1280 && sgl["canvasHeight"] == 720
          && sgl["canvasAspectRatio"] == "16:9" && sgl["previewFps"] == 24,
          "canvas + previewFps persist at the container level (not per-snapshot)");
    CHECK(!sgl["snapshots"][0].contains("canvasWidth")
          && !sgl["snapshots"][0].contains("previewFps"),
          "snapshot does not carry the global canvas/fps fields");
    // ... while the arrangement nests inside the snapshot.
    CHECK(sgl["snapshots"][0]["columns"] == 2 && sgl["snapshots"][0]["rows"] == 1,
          "snapshot carries the grid geometry");
    CHECK(sgl["snapshots"][0]["slots"].size() == 2
          && sgl["snapshots"][0]["fullscreenLayers"].size() == 1,
          "snapshot carries the slots + fullscreen layers");
    CHECK(sgl["snapshots"][0]["slots"][0].contains("eventActions")
          && sgl["snapshots"][0]["slots"][0]["eventActions"].is_array()
          && sgl["snapshots"][0]["slots"][0]["eventActions"].empty(),
          "slot reserves an empty eventActions array");
    CHECK(sgl["snapshots"][0]["fullscreenLayers"][0].contains("eventActions"),
          "fullscreen layer reserves an eventActions array");

    Timeline reloaded(140.0, 48000.0);
    CHECK(reloaded.fromJSON(saved), "reload nested-format project");
    CHECK(gridLayoutDtoEqual(reloaded.getGridLayout(), before),
          "nested round-trip returns an identical flat getGridLayout DTO");
    CHECK(reloaded.getActiveSnapshotName() == "Base",
          "reloaded active snapshot is named Base");
    CHECK(!reloaded.getActiveSnapshotId().empty(),
          "reloaded active snapshot id is non-empty");

    // ── (B) LEGACY flat gridLayout migrates → Base snapshot → identical DTO ────
    // Rewrite the persisted gridLayout to the pre-snapshot flat shape (arrangement
    // fields inline, no `snapshots` key), reusing the same track ids so no
    // fullscreen layer is dropped as a dangling reference.
    nlohmann::json legacy = saved;   // keep tracks[] so ids resolve on reload
    nlohmann::json flat;
    flat["gridLayoutVersion"] = kGridLayoutVersionFineUnits;  // fine-grid coords
    flat["columns"]           = 2;
    flat["rows"]              = 1;
    flat["gapScale"]          = before.gapScale;
    flat["previewFps"]        = 24;
    flat["canvasWidth"]       = 1280;
    flat["canvasHeight"]      = 720;
    flat["canvasAspectRatio"] = "16:9";
    flat["slots"]             = nlohmann::json::array();
    for (const GridSlot& s : before.slots) {
        nlohmann::json sj;
        sj["trackId"] = s.trackId; sj["gridX"] = s.gridX; sj["gridY"] = s.gridY;
        sj["spanX"] = s.spanX; sj["spanY"] = s.spanY;
        sj["opacity"] = s.opacity; sj["zOrder"] = s.zOrder;
        flat["slots"].push_back(sj);
    }
    flat["fullscreenLayers"] = nlohmann::json::array();
    for (const FullscreenLayer& fl : before.fullscreenLayers) {
        nlohmann::json flj;
        flj["trackId"]   = fl.trackId;
        flj["placement"] = (fl.placement == FullscreenLayerPlacement::BehindGrid)
                             ? "behind" : "front";
        flj["opacity"]   = fl.opacity;
        flj["zOrder"]    = fl.zOrder;
        flat["fullscreenLayers"].push_back(flj);
    }
    legacy["gridLayout"] = flat;

    Timeline legacyTl(140.0, 48000.0);
    CHECK(legacyTl.fromJSON(legacy), "legacy flat gridLayout loads");
    CHECK(legacyTl.getActiveSnapshotName() == "Base",
          "legacy flat layout is wrapped as the Base snapshot");
    CHECK(!legacyTl.getActiveSnapshotId().empty(),
          "legacy migration mints a Base snapshot id");
    CHECK(gridLayoutDtoEqual(legacyTl.getGridLayout(), before),
          "legacy flat layout migrates to an identical flat getGridLayout DTO");

    // Re-saving the migrated project produces the nested container form.
    nlohmann::json resaved = legacyTl.toJSON();
    CHECK(resaved["gridLayout"].contains("snapshots"),
          "re-saving a migrated legacy project produces the snapshot container");
    CHECK(resaved["gridLayout"]["snapshots"][0]["name"] == "Base",
          "re-saved snapshot retains the Base name");
}

static void testLiveGridSnapshotCrudAndRoundTrip() {
    std::cout << "[SN] Live grid snapshot CRUD + multi-snapshot round-trip\n";

    Timeline source(120.0, 48000.0);
    TrackInfo track; track.name = "Snapshot track";
    const int trackId = source.addTrack(track);
    TrackInfo backdrop; backdrop.name = "Snapshot backdrop";
    const int backdropId = source.addTrack(backdrop);
    GridLayout layout = source.getGridLayout();
    layout.columns = 4;
    layout.rows = 2;
    layout.gapScale = 0.2f;
    layout.canvasWidth = 1280;
    layout.canvasHeight = 720;
    layout.previewFps = 24;
    GridSlot slot;
    slot.trackId = trackId;
    slot.gridX = 2;
    slot.spanX = kGridSubUnitsPerColumn;
    slot.spanY = kGridSubUnitsPerRow;
    layout.slots.push_back(slot);
    FullscreenLayer layer;
    layer.trackId = backdropId;
    layer.placement = FullscreenLayerPlacement::BehindGrid;
    layer.zOrder = -1;
    layout.fullscreenLayers.push_back(layer);
    source.setGridLayout(layout);

    // Seed opaque future data through persistence because it is intentionally
    // absent from the flat GridLayout bridge DTO.
    nlohmann::json seededJson = source.toJSON();
    seededJson["gridLayout"]["snapshots"][0]["slots"][0]["eventActions"] =
        nlohmann::json::array({{{"type", "futureAction"}, {"amount", 0.75}}});
    seededJson["gridLayout"]["snapshots"][0]["fullscreenLayers"][0]["eventActions"] =
        nlohmann::json::array({{{"type", "futureLayerAction"}, {"enabled", true}}});
    Timeline tl;
    CHECK(tl.fromJSON(seededJson), "seed snapshot with opaque eventActions loads");

    const std::string baseId = tl.getActiveSnapshotId();
    CHECK(tl.getGridSnapshots().size() == 1, "new/live model starts with one Base");
    CHECK(!tl.deleteGridSnapshot(baseId), "deleting the last snapshot is blocked");

    GridLayout dtoMutation = tl.getGridLayout();
    dtoMutation.slots[0].eventActions.clear();
    dtoMutation.fullscreenLayers[0].eventActions.clear();
    dtoMutation.gapScale = 0.21f;
    tl.setGridLayout(dtoMutation);
    CHECK(tl.getGridSnapshots()[0].slots[0].eventActions.size() == 1
          && tl.getGridSnapshots()[0].fullscreenLayers[0].eventActions.size() == 1,
          "flat DTO mutation preserves opaque actions in the authoritative vector");

    const std::string cloneId = tl.createGridSnapshot(true, "Take");
    CHECK(cloneId != baseId && tl.getActiveSnapshotId() == cloneId,
          "create clone generates a unique id and activates it");
    CHECK(tl.getGridLayout().slots.size() == 1,
          "cloned snapshot materializes the active arrangement");
    CHECK(tl.getGridSnapshots().back().slots[0].eventActions.size() == 1,
          "clone deep-copies opaque slot eventActions");
    CHECK(tl.getGridSnapshots().back().fullscreenLayers[0].eventActions.size() == 1,
          "clone deep-copies opaque fullscreen eventActions");

    const std::string emptyId = tl.createGridSnapshot(false, "Blank");
    CHECK(tl.getGridLayout().slots.empty()
          && tl.getGridLayout().fullscreenLayers.empty(),
          "empty snapshot has no slots or fullscreen placements");
    CHECK(tl.getGridLayout().columns == 4 && tl.getGridLayout().rows == 2
          && std::abs(tl.getGridLayout().gapScale - 0.21f) < 1e-6f,
          "empty snapshot inherits active geometry");
    CHECK(tl.renameGridSnapshot(emptyId, "Take"),
          "rename succeeds and duplicate names are allowed");

    const std::string unknown = "snap-does-not-exist";
    const size_t beforeUnknown = tl.getGridSnapshots().size();
    CHECK(!tl.renameGridSnapshot(unknown, "Nope")
          && !tl.setActiveGridSnapshot(unknown)
          && !tl.deleteGridSnapshot(unknown)
          && tl.getGridSnapshots().size() == beforeUnknown,
          "unknown rename/activate/delete return false with zero mutation");

    CHECK(tl.setActiveGridSnapshot(cloneId), "setActive accepts an existing id");
    CHECK(tl.deleteGridSnapshot(cloneId), "deleting active snapshot succeeds");
    CHECK(tl.getActiveSnapshotId() == baseId && tl.getGridLayout().slots.size() == 1,
          "active deletion selects first survivor and rematerializes it");

    const std::string finalCloneId = tl.createGridSnapshot(true, "RoundTrip Clone");
    const GridLayout activeBefore = tl.getGridLayout();
    const auto snapshotsBefore = tl.getGridSnapshots();
    nlohmann::json saved = tl.toJSON();
    CHECK(saved["gridLayout"]["snapshots"].size() == snapshotsBefore.size(),
          "toJSON serializes every live snapshot");

    Timeline loaded;
    CHECK(loaded.fromJSON(saved), "multi-snapshot project reloads");
    CHECK(loaded.getGridSnapshots().size() == snapshotsBefore.size(),
          "multi-snapshot count round-trips");
    CHECK(loaded.getActiveSnapshotId() == finalCloneId
          && gridLayoutDtoEqual(loaded.getGridLayout(), activeBefore),
          "active id and flat active DTO round-trip unchanged");
    bool metadataAndActionsMatch = true;
    for (size_t i = 0; i < snapshotsBefore.size(); ++i) {
        const auto& a = snapshotsBefore[i];
        const auto& b = loaded.getGridSnapshots()[i];
        metadataAndActionsMatch = metadataAndActionsMatch
            && a.id == b.id && a.name == b.name
            && a.slots.size() == b.slots.size();
        for (size_t k = 0; metadataAndActionsMatch && k < a.slots.size(); ++k)
            metadataAndActionsMatch =
                a.slots[k].eventActions == b.slots[k].eventActions;
        metadataAndActionsMatch = metadataAndActionsMatch
            && a.fullscreenLayers.size() == b.fullscreenLayers.size();
        for (size_t k = 0; metadataAndActionsMatch
             && k < a.fullscreenLayers.size(); ++k)
            metadataAndActionsMatch = a.fullscreenLayers[k].eventActions
                                   == b.fullscreenLayers[k].eventActions;
    }
    CHECK(metadataAndActionsMatch,
          "ids, names, and opaque eventActions round-trip for N snapshots");

    nlohmann::json badActive = saved;
    badActive["gridLayout"]["activeSnapshotId"] = unknown;
    Timeline clamped;
    CHECK(clamped.fromJSON(badActive)
          && clamped.getActiveSnapshotId() == snapshotsBefore.front().id,
          "missing persisted activeSnapshotId clamps to first snapshot");

    tl.clear();
    CHECK(tl.getGridSnapshots().size() == 1
          && tl.getGridSnapshots()[0].name == "Base"
          && tl.getActiveSnapshotId() == tl.getGridSnapshots()[0].id,
          "clear remints exactly one active Base snapshot");
}

// ─── Grid cue time-based snapshot resolution + round-trip ─────────────────────
// Proves the render-path resolver (Timeline::gridLayoutAt) picks the right
// snapshot for a tick, that cue CRUD keeps the sorted-by-tick invariant, that a
// cue pointing at a deleted/absent snapshot is skipped (and pruned on delete),
// that the editing read (getGridLayout) is unaffected, and that cues +
// defaultSnapshotId round-trip through toJSON/fromJSON.
static void testGridCueResolutionAndRoundTrip() {
    std::cout << "[CUE] Grid cue resolution + CRUD + round-trip\n";

    auto firstSlotTrack = [](const GridLayout& gl) {
        return gl.slots.empty() ? -1 : gl.slots[0].trackId;
    };
    auto placeSingle = [](Timeline& t, int trackId) {
        GridLayout gl = t.getGridLayout();
        gl.slots.clear();
        GridSlot s;
        s.trackId = trackId;
        s.gridX = 0; s.gridY = 0;
        s.spanX = kGridSubUnitsPerColumn;
        s.spanY = kGridSubUnitsPerRow;
        gl.slots.push_back(s);
        t.setGridLayout(gl);
    };

    Timeline tl(140.0, 48000.0);
    TrackInfo a; a.name = "A"; const int tA = tl.addTrack(a);
    TrackInfo b; b.name = "B"; const int tB = tl.addTrack(b);
    TrackInfo c; c.name = "C"; const int tC = tl.addTrack(c);

    // Base snapshot shows track A. The default id must be the initial Base.
    placeSingle(tl, tA);
    const std::string baseId = tl.getActiveSnapshotId();
    CHECK(tl.getDefaultSnapshotId() == baseId,
          "default snapshot id is the initial Base snapshot");

    // Alt snapshot shows B; Mid snapshot shows C. Editing returns to Base.
    const std::string altId = tl.createGridSnapshot(false, "Alt");
    placeSingle(tl, tB);
    const std::string midId = tl.createGridSnapshot(false, "Mid");
    placeSingle(tl, tC);
    CHECK(tl.setActiveGridSnapshot(baseId), "editing returns to Base snapshot");

    // ── Resolution: Base before the first cue, exact switch at each cue tick ──
    tl.addGridCue(TickTime{1000}, altId);
    tl.addGridCue(TickTime{2000}, midId);
    CHECK(firstSlotTrack(tl.gridLayoutAt(TickTime{0}))    == tA, "t=0 → Base (A)");
    CHECK(firstSlotTrack(tl.gridLayoutAt(TickTime{999}))  == tA, "t<first cue → Base (A)");
    CHECK(firstSlotTrack(tl.gridLayoutAt(TickTime{1000})) == tB, "t=1000 switches to Alt (B)");
    CHECK(firstSlotTrack(tl.gridLayoutAt(TickTime{1500})) == tB, "t between cues → last cue (Alt)");
    CHECK(firstSlotTrack(tl.gridLayoutAt(TickTime{2000})) == tC, "t=2000 switches to Mid (C)");
    CHECK(firstSlotTrack(tl.gridLayoutAt(TickTime{9999})) == tC, "t past last cue → last cue (Mid)");

    // Editing read is unaffected — still the active (Base) arrangement.
    CHECK(firstSlotTrack(tl.getGridLayout()) == tA,
          "getGridLayout stays on the active (Base) snapshot regardless of cues");

    // Global canvas fields are identical regardless of tick (they live on the
    // container, not the snapshot).
    CHECK(tl.gridLayoutAt(TickTime{0}).canvasWidth == tl.getGridLayout().canvasWidth
          && tl.gridLayoutAt(TickTime{2000}).canvasWidth == tl.getGridLayout().canvasWidth
          && tl.gridLayoutAt(TickTime{2000}).previewFps == tl.getGridLayout().previewFps,
          "canvas/previewFps are tick-independent");

    // ── Dangling cue is skipped (addGridCue does not validate the id) ────────
    tl.addGridCue(TickTime{1500}, "snap-does-not-exist");
    CHECK(firstSlotTrack(tl.gridLayoutAt(TickTime{1600})) == tB,
          "cue at 1500 pointing at a missing snapshot is skipped → last valid (Alt)");
    CHECK(tl.removeGridCue(TickTime{1500}), "removeGridCue deletes the dangling cue");
    CHECK(tl.getGridCues().size() == 2, "cue count back to 2 after removal");

    // ── addGridCue replace-on-collision + move + remove semantics ────────────
    tl.addGridCue(TickTime{1000}, midId);   // replace Alt→Mid at the same tick
    CHECK(tl.getGridCues().size() == 2, "same-tick add replaces, does not insert");
    CHECK(firstSlotTrack(tl.gridLayoutAt(TickTime{1000})) == tC, "collision replaced target");
    tl.addGridCue(TickTime{1000}, altId);   // restore Alt at 1000
    CHECK(!tl.removeGridCue(TickTime{1234}), "removeGridCue on absent tick → false");
    CHECK(tl.moveGridCue(TickTime{2000}, TickTime{2500}), "moveGridCue relocates a cue");
    CHECK(!tl.moveGridCue(TickTime{2000}, TickTime{2600}), "moveGridCue on absent old tick → false");
    CHECK(tl.getGridCues().size() == 2 && tl.getGridCues()[0].tick.ticks == 1000
          && tl.getGridCues()[1].tick.ticks == 2500, "cues stay sorted after move");
    CHECK(firstSlotTrack(tl.gridLayoutAt(TickTime{2400})) == tB, "moved Mid cue no longer covers 2400");
    CHECK(firstSlotTrack(tl.gridLayoutAt(TickTime{2500})) == tC, "moved Mid cue covers 2500");
    CHECK(tl.moveGridCue(TickTime{2500}, TickTime{2000}), "restore Mid cue tick");

    // ── deleteGridSnapshot prunes referencing cues (no dangling refs) ─────────
    CHECK(tl.deleteGridSnapshot(midId), "delete the Mid snapshot");
    CHECK(tl.getGridCues().size() == 1 && tl.getGridCues()[0].snapshotId == altId,
          "cue referencing the deleted snapshot is pruned");
    CHECK(firstSlotTrack(tl.gridLayoutAt(TickTime{2000})) == tB,
          "after prune, t=2000 falls back to the last valid cue (Alt)");
    CHECK(tl.getDefaultSnapshotId() == baseId,
          "default snapshot id unchanged when a non-default snapshot is deleted");

    // ── Round-trip: cues + defaultSnapshotId survive toJSON/fromJSON ─────────
    nlohmann::json saved = tl.toJSON();
    CHECK(saved["gridLayout"]["cues"].is_array()
          && saved["gridLayout"]["cues"].size() == 1,
          "toJSON serializes the typed cue list");
    CHECK(saved["gridLayout"]["cues"][0]["tick"] == 1000
          && saved["gridLayout"]["cues"][0]["snapshotId"] == altId,
          "cue serializes as { tick, snapshotId }");
    CHECK(saved["gridLayout"].contains("defaultSnapshotId")
          && saved["gridLayout"]["defaultSnapshotId"] == baseId,
          "toJSON serializes defaultSnapshotId");

    Timeline loaded;
    CHECK(loaded.fromJSON(saved), "project with cues reloads");
    CHECK(loaded.getGridCues().size() == 1
          && loaded.getGridCues()[0].tick.ticks == 1000
          && loaded.getGridCues()[0].snapshotId == altId,
          "cues round-trip");
    CHECK(loaded.getDefaultSnapshotId() == baseId, "defaultSnapshotId round-trips");
    CHECK(firstSlotTrack(loaded.gridLayoutAt(TickTime{0}))    == tA
          && firstSlotTrack(loaded.gridLayoutAt(TickTime{1000})) == tB,
          "cue-driven resolution survives the round-trip");

    // A legacy empty cues array must load without error and leave no cues.
    nlohmann::json legacy = saved;
    legacy["gridLayout"]["cues"] = nlohmann::json::array();
    Timeline legacyTl;
    CHECK(legacyTl.fromJSON(legacy) && legacyTl.getGridCues().empty(),
          "empty/legacy cues array tolerated");
}

// ─── Snapshot transition — deterministic time→progress mapping ────────────────
// Exercises the ONLY sample-domain code in Slice 2 (SnapshotTransitionTiming.h):
// the piecewise progressForSample formula. The pin is always pinned to t=0.5;
// every divide is guarded; the result is clamped to [0,1].
static void testProgressForSample() {
    std::cout << "[TR1] progressForSample piecewise mapping\n";
    using xleth::progressForSample;
    const double eps = 1e-9;

    // ── Symmetric window [0, 100, 200] — 0.5 lands on the pin ────────────────
    CHECK_NEAR(progressForSample(-10, 0, 100, 200), 0.0,  eps, "sym: before start → 0");
    CHECK_NEAR(progressForSample(0,   0, 100, 200), 0.0,  eps, "sym: at start → 0");
    CHECK_NEAR(progressForSample(50,  0, 100, 200), 0.25, eps, "sym: quarter of left tail → 0.25");
    CHECK_NEAR(progressForSample(100, 0, 100, 200), 0.5,  eps, "sym: at pin → 0.5");
    CHECK_NEAR(progressForSample(150, 0, 100, 200), 0.75, eps, "sym: quarter of right tail → 0.75");
    CHECK_NEAR(progressForSample(200, 0, 100, 200), 1.0,  eps, "sym: at end → 1");
    CHECK_NEAR(progressForSample(999, 0, 100, 200), 1.0,  eps, "sym: past end → 1 (clamped)");

    // ── Asymmetric window: long left tail, short right tail. 0.5 MUST still land
    //    exactly on the pin, and each tail warps independently. ────────────────
    //    start=0, pin=800, end=900.
    CHECK_NEAR(progressForSample(800, 0, 800, 900), 0.5,   eps, "asym: 0.5 lands exactly on the pin");
    CHECK_NEAR(progressForSample(400, 0, 800, 900), 0.25,  eps, "asym: mid of the long left tail → 0.25");
    CHECK_NEAR(progressForSample(850, 0, 800, 900), 0.75,  eps, "asym: mid of the short right tail → 0.75");
    // The two tails advance at different real rates: 400 ticks buys 0.25 on the
    // left, only 50 ticks buys 0.25 on the right.
    CHECK(progressForSample(801, 0, 800, 900) > progressForSample(799, 0, 800, 900),
          "asym: right tail rises faster than left per tick");

    // ── Zero-length window (start==pin==end) — a hard-cut STEP. ───────────────
    CHECK_NEAR(progressForSample(99,  100, 100, 100), 0.0, eps, "hard cut: s<pin → 0");
    CHECK_NEAR(progressForSample(100, 100, 100, 100), 1.0, eps, "hard cut: s==pin → 1");
    CHECK_NEAR(progressForSample(101, 100, 100, 100), 1.0, eps, "hard cut: s>pin → 1");

    // ── Zero LEFT tail (start==pin, right tail present): 0 before, ≥0.5 at/after.
    CHECK_NEAR(progressForSample(99,  100, 100, 200), 0.0,  eps, "zero-left: s<pin → 0");
    CHECK_NEAR(progressForSample(100, 100, 100, 200), 0.5,  eps, "zero-left: at pin → 0.5");
    CHECK_NEAR(progressForSample(150, 100, 100, 200), 0.75, eps, "zero-left: fades in on the right");
    CHECK_NEAR(progressForSample(200, 100, 100, 200), 1.0,  eps, "zero-left: at end → 1");

    // ── Zero RIGHT tail (pin==end, left tail present): fades to pin, then 1. ───
    CHECK_NEAR(progressForSample(0,   0, 100, 100), 0.0,  eps, "zero-right: at start → 0");
    CHECK_NEAR(progressForSample(50,  0, 100, 100), 0.25, eps, "zero-right: fades on the left");
    CHECK_NEAR(progressForSample(100, 0, 100, 100), 1.0,  eps, "zero-right: at/after pin → 1");
    CHECK_NEAR(progressForSample(101, 0, 100, 100), 1.0,  eps, "zero-right: past pin → 1");

    // ── Clamping / degenerate ordering never yields <0 or >1, never divides by 0.
    const double p = progressForSample(-5, 0, 100, 200);
    CHECK(p >= 0.0 && p <= 1.0, "result clamped to [0,1] below range");
    const double q = progressForSample(9999, 0, 100, 200);
    CHECK(q >= 0.0 && q <= 1.0, "result clamped to [0,1] above range");
    // Out-of-order inputs (end < pin < start) fall back to degenerate tails, not junk.
    const double r = progressForSample(150, 200, 100, 50);
    CHECK(r >= 0.0 && r <= 1.0, "out-of-order window stays in [0,1]");
}

// ─── Snapshot transition — cue.transition persistence + hard-cut omission ─────
// setCueTransition round-trips every field; an enabled=false transition writes NO
// `transition` key (byte-compatible hard cut); a cue whose JSON lacks the key
// loads as a hard cut. Proves the additive/back-compat persistence contract.
static void testCueTransitionRoundTrip() {
    std::cout << "[TR2] cue transition persistence + hard-cut omission\n";

    Timeline tl(120.0, 48000.0);
    TrackInfo a; a.name = "A"; tl.addTrack(a);
    const std::string baseId = tl.getActiveSnapshotId();
    const std::string altId  = tl.createGridSnapshot(false, "Alt");
    CHECK(tl.setActiveGridSnapshot(baseId), "back to Base for cue setup");

    tl.addGridCue(TickTime{1920}, altId);

    // A cue with no transition set writes NO transition key (default = hard cut).
    {
        nlohmann::json saved = tl.toJSON();
        const auto& cue0 = saved["gridLayout"]["cues"][0];
        CHECK(!cue0.contains("transition"),
              "default (disabled) transition omits the key entirely");
        Timeline loaded;
        CHECK(loaded.fromJSON(saved), "project with a hard-cut cue reloads");
        CHECK(!loaded.getGridCues().empty()
              && loaded.getGridCues()[0].transition.enabled == false,
              "cue with no transition key loads as a hard cut");
    }

    // Set a fully-specified enabled transition and round-trip every field.
    SnapshotTransition tr;
    tr.enabled          = true;
    tr.startOffsetTicks = 480;
    tr.endOffsetTicks   = 240;
    tr.type             = SnapshotTransition::Type::LineSweep;
    tr.freezeOutgoing   = false;
    tr.geomAngleDeg     = 45.0f;
    tl.setCueTransition(TickTime{1920}, tr);

    // setCueTransition is a no-op when no cue exists at that tick.
    tl.setCueTransition(TickTime{99999}, tr);
    CHECK(tl.getGridCues().size() == 1, "setCueTransition on an absent tick is a no-op");

    nlohmann::json saved = tl.toJSON();
    const auto& cj = saved["gridLayout"]["cues"][0];
    CHECK(cj.contains("transition"), "enabled transition writes the key");
    const auto& tj = cj["transition"];
    CHECK(tj["enabled"] == true
          && tj["startOffsetTicks"] == 480
          && tj["endOffsetTicks"] == 240
          && tj["type"] == "lineSweep"
          && tj["freezeOutgoing"] == false
          && std::abs(tj["geomAngleDeg"].get<double>() - 45.0) < 1e-6,
          "transition serializes every field");

    Timeline loaded;
    CHECK(loaded.fromJSON(saved), "project with an enabled transition reloads");
    const SnapshotTransition& rt = loaded.getGridCues()[0].transition;
    CHECK(rt.enabled == true
          && rt.startOffsetTicks == 480
          && rt.endOffsetTicks == 240
          && rt.type == SnapshotTransition::Type::LineSweep
          && rt.freezeOutgoing == false
          && std::abs(rt.geomAngleDeg - 45.0f) < 1e-6f,
          "every transition field round-trips through fromJSON");

    // Toggling back to disabled must drop the key again (hard-cut omission holds
    // after a prior enable).
    SnapshotTransition off;  // default: disabled
    loaded.setCueTransition(TickTime{1920}, off);
    nlohmann::json resaved = loaded.toJSON();
    CHECK(!resaved["gridLayout"]["cues"][0].contains("transition"),
          "re-disabling a transition omits the key again");
}

// ─── Snapshot transition — transitionAt render-path resolver ──────────────────
// Proves transitionAt returns active only inside an enabled cue's
// [pin-startOffset, pin+endOffset] window, that the pin/start/end derive from the
// cue tick + offsets, and that layoutA/layoutB resolve to the OUTGOING (pin-1) and
// INCOMING (pin) snapshots respectively.
static void testTransitionResolver() {
    std::cout << "[TR3] transitionAt window + A/B layout resolution\n";

    auto firstSlotTrack = [](const GridLayout& gl) {
        return gl.slots.empty() ? -1 : gl.slots[0].trackId;
    };
    auto placeSingle = [](Timeline& t, int trackId) {
        GridLayout gl = t.getGridLayout();
        gl.slots.clear();
        GridSlot s;
        s.trackId = trackId;
        s.gridX = 0; s.gridY = 0;
        s.spanX = kGridSubUnitsPerColumn;
        s.spanY = kGridSubUnitsPerRow;
        gl.slots.push_back(s);
        t.setGridLayout(gl);
    };

    Timeline tl(120.0, 48000.0);
    TrackInfo a; a.name = "A"; const int tA = tl.addTrack(a);
    TrackInfo b; b.name = "B"; const int tB = tl.addTrack(b);

    // Base shows A; Alt shows B. A cue at tick 1000 switches Base→Alt (the pin).
    placeSingle(tl, tA);
    const std::string baseId = tl.getActiveSnapshotId();
    const std::string altId  = tl.createGridSnapshot(false, "Alt");
    placeSingle(tl, tB);
    CHECK(tl.setActiveGridSnapshot(baseId), "editing back to Base");
    tl.addGridCue(TickTime{1000}, altId);

    // No transition enabled yet → resolver inactive everywhere.
    CHECK(!tl.transitionAt(TickTime{1000}).active,
          "no enabled transition → transitionAt inactive at the pin");

    // Enable an ASYMMETRIC window: start 600 before, end 200 after the pin.
    SnapshotTransition tr;
    tr.enabled          = true;
    tr.startOffsetTicks = 600;   // window start = 400
    tr.endOffsetTicks   = 200;   // window end   = 1200
    tr.type             = SnapshotTransition::Type::Crossfade;
    tl.setCueTransition(TickTime{1000}, tr);

    // Outside the window (both sides) → inactive.
    CHECK(!tl.transitionAt(TickTime{399}).active,  "before window start → inactive");
    CHECK(!tl.transitionAt(TickTime{1201}).active, "after window end → inactive");

    // Inside / on the boundaries → active with the right pin/start/end.
    auto rt = tl.transitionAt(TickTime{1000});
    CHECK(rt.active, "at the pin → active");
    CHECK(rt.pinTick.ticks == 1000
          && rt.startTick.ticks == 400
          && rt.endTick.ticks == 1200,
          "pin/start/end derive from cue tick + asymmetric offsets");
    CHECK(rt.type == SnapshotTransition::Type::Crossfade && rt.freezeOutgoing == true,
          "resolved type + freezeOutgoing copied from the cue");
    CHECK(tl.transitionAt(TickTime{400}).active && tl.transitionAt(TickTime{1200}).active,
          "inclusive on both window boundaries");
    CHECK(tl.transitionAt(TickTime{700}).active,
          "a tick inside the window resolves active");

    // layoutA = outgoing (pin-1 → Base/A); layoutB = incoming (pin → Alt/B).
    CHECK(firstSlotTrack(rt.layoutA) == tA, "layoutA is the outgoing snapshot (Base/A)");
    CHECK(firstSlotTrack(rt.layoutB) == tB, "layoutB is the incoming snapshot (Alt/B)");
}

int main() {
    std::cout << "=== Xleth Timeline Test Suite (Phase 1) ===\n\n";

    // ── [1] TickTime math ─────────────────────────────────────────────────────
    testTickTimeMath();

    // ── [2] Label conversion ──────────────────────────────────────────────────
    testSampleLabelConversion();
    testClipFadePercentConversion();

    // ── [3] Create timeline ───────────────────────────────────────────────────
    std::cout << "[3] Create timeline\n";
    Timeline tl(140.0, 44100.0, 4, 4);
    CHECK_NEAR(tl.getBPM(),        140.0,   1e-9, "BPM == 140");
    CHECK_NEAR(tl.getSampleRate(), 44100.0, 1e-9, "SR == 44100");
    CHECK(tl.getTimeSigNum() == 4, "timeSigNum == 4");
    CHECK(tl.getTimeSigDen() == 4, "timeSigDen == 4");
    CHECK(tl.getAllSources().empty(), "no sources initially");
    CHECK(tl.getAllClips().empty(),   "no clips initially");

    // ── [4] Add 2 sources ─────────────────────────────────────────────────────
    std::cout << "[4] Add 2 sources\n";
    SourceMedia src1{};
    src1.filePath   = "/media/sparta_base.mp4";
    src1.fileName   = "sparta_base.mp4";
    src1.width      = 1920; src1.height = 1080;
    src1.fps        = 29.97; src1.duration = 120.0;
    src1.totalFrames = 3596; src1.hasVideo = true; src1.proxyReady = false;

    SourceMedia src2{};
    src2.filePath   = "/media/quotes.mp4";
    src2.fileName   = "quotes.mp4";
    src2.width      = 640; src2.height = 480;
    src2.fps        = 25.0; src2.duration = 60.0;
    src2.totalFrames = 1500; src2.hasVideo = true; src2.proxyReady = true;

    int srcId1 = tl.addSource(src1);
    int srcId2 = tl.addSource(src2);
    CHECK(srcId1 > 0,             "source 1 got valid id");
    CHECK(srcId2 > 0,             "source 2 got valid id");
    CHECK(srcId1 != srcId2,       "sources have different ids");
    CHECK(tl.getAllSources().size() == 2, "2 sources in timeline");
    CHECK(tl.getSource(srcId1) != nullptr, "source 1 retrievable");
    CHECK(tl.getSource(srcId1)->fileName == "sparta_base.mp4", "source 1 fileName");
    CHECK(tl.getSource(srcId2)->proxyReady == true, "source 2 proxyReady");
    CHECK(tl.getSource(999) == nullptr, "unknown source returns nullptr");

    // ── [5] Add 5 regions ─────────────────────────────────────────────────────
    std::cout << "[5] Add 5 regions (Kick, Snare, HiHat, Pitch, Quote+4 syllables)\n";

    SampleRegion kick{};
    kick.sourceId = srcId1; kick.name = "Kick01"; kick.label = SampleLabel::Kick;
    kick.startTime = 0.0; kick.endTime = 0.1; kick.startFrame = 0; kick.endFrame = 3;
    kick.audioFilePath = "/samples/kick01.wav"; kick.rootNote = 36;

    SampleRegion snare{};
    snare.sourceId = srcId1; snare.name = "Snare01"; snare.label = SampleLabel::Snare;
    snare.startTime = 1.0; snare.endTime = 1.15; snare.startFrame = 30; snare.endFrame = 34;
    snare.audioFilePath = "/samples/snare01.wav"; snare.rootNote = 38;

    SampleRegion hihat{};
    hihat.sourceId = srcId1; hihat.name = "HiHat01"; hihat.label = SampleLabel::HiHat;
    hihat.startTime = 2.0; hihat.endTime = 2.05; hihat.startFrame = 60; hihat.endFrame = 61;
    hihat.audioFilePath = "/samples/hihat01.wav"; hihat.rootNote = 42;

    SampleRegion pitch{};
    pitch.sourceId = srcId1; pitch.name = "Pitch01"; pitch.label = SampleLabel::Pitch;
    pitch.startTime = 3.0; pitch.endTime = 3.5; pitch.startFrame = 90; pitch.endFrame = 105;
    pitch.audioFilePath = "/samples/pitch01.wav"; pitch.rootNote = 60;

    SampleRegion quote{};
    quote.sourceId = srcId2; quote.name = "Quote_Sparta"; quote.label = SampleLabel::Quote;
    quote.startTime = 0.0; quote.endTime = 1.0; quote.startFrame = 0; quote.endFrame = 25;
    quote.audioFilePath = "/samples/sparta.wav"; quote.rootNote = 60;
    quote.syllables = {
        {0.0,  0.25, 0, "Spar"},
        {0.25, 0.5,  1, "ta"},
        {0.5,  0.75, 2, "Re"},
        {0.75, 1.0,  3, "mix"}
    };

    int kickId  = tl.addRegion(kick);
    int snareId = tl.addRegion(snare);
    int hihatId = tl.addRegion(hihat);
    int pitchId = tl.addRegion(pitch);
    int quoteId = tl.addRegion(quote);

    CHECK(kickId  > 0, "kick id valid");
    CHECK(snareId > 0, "snare id valid");
    CHECK(hihatId > 0, "hihat id valid");
    CHECK(pitchId > 0, "pitch id valid");
    CHECK(quoteId > 0, "quote id valid");
    CHECK(tl.getAllRegions().size() == 5, "5 regions in timeline");

    // Region helper methods
    CHECK(tl.getRegion(quoteId)->isQuote(),             "quote.isQuote() == true");
    CHECK(tl.getRegion(quoteId)->hasSyllables(),        "quote.hasSyllables() == true");
    CHECK(tl.getRegion(quoteId)->syllables.size() == 4, "quote has 4 syllables");
    CHECK(tl.getRegion(quoteId)->syllables[0].text == "Spar", "syllable[0].text == Spar");
    CHECK(tl.getRegion(quoteId)->syllables[3].text == "mix",  "syllable[3].text == mix");
    CHECK_NEAR(tl.getRegion(quoteId)->getDuration(), 1.0, 1e-9, "quote duration == 1.0s");
    CHECK(tl.getRegion(quoteId)->getFrameCount() == 26, "quote frameCount == 26");
    CHECK(!tl.getRegion(kickId)->isQuote(),             "kick.isQuote() == false");
    CHECK(!tl.getRegion(kickId)->hasSyllables(),        "kick.hasSyllables() == false");

    // getRegionsByLabel
    auto kicks  = tl.getRegionsByLabel(SampleLabel::Kick);
    auto snares = tl.getRegionsByLabel(SampleLabel::Snare);
    auto quotes = tl.getRegionsByLabel(SampleLabel::Quote);
    CHECK(kicks.size()  == 1,         "1 kick region");
    CHECK(kicks[0]->name == "Kick01", "kick region name");
    CHECK(snares.size() == 1,         "1 snare region");
    CHECK(quotes.size() == 1,         "1 quote region");
    CHECK(tl.getRegionsByLabel(SampleLabel::Custom).empty(), "0 custom regions");

    // ── [6] Add 3 tracks ──────────────────────────────────────────────────────
    std::cout << "[6] Add 3 tracks\n";

    TrackInfo track1{};
    track1.name = "Drums"; track1.volume = 1.0f; track1.pan = 0.0f;
    track1.order = 0; track1.videoW = 1920; track1.videoH = 1080; track1.videoOpacity = 1.0f;

    TrackInfo track2{};
    track2.name = "Pitch"; track2.volume = 0.8f; track2.pan = -0.2f;
    track2.order = 1; track2.videoW = 960; track2.videoH = 540; track2.videoOpacity = 0.8f;

    TrackInfo track3{};
    track3.name = "Quotes"; track3.volume = 0.9f; track3.pan = 0.1f;
    track3.order = 2;
    track3.videoX = 100; track3.videoY = 100;
    track3.videoW = 640; track3.videoH = 360; track3.videoOpacity = 1.0f; track3.videoZOrder = 2;

    int t1id = tl.addTrack(track1);
    int t2id = tl.addTrack(track2);
    int t3id = tl.addTrack(track3);

    CHECK(t1id > 0 && t2id > 0 && t3id > 0, "all tracks got valid ids");
    CHECK(tl.getAllTracks().size() == 3,      "3 tracks in timeline");
    CHECK(tl.getTrack(t1id)->name == "Drums", "track1 name == Drums");
    CHECK_NEAR(tl.getTrack(t2id)->volume, 0.8f, 1e-5f, "track2 volume == 0.8");

    // ── [7] Add 10 clips ──────────────────────────────────────────────────────
    std::cout << "[7] Add 10 clips\n";

    // Layout:
    //   Track1 (Drums):  4 clips — kick/snare alternating at 16th * (0,4,8,12)
    //                                   = ticks (0, 960, 1920, 2880)
    //   Track2 (Pitch):  3 clips — pitch at beats (0, 2, 4)
    //                                   = ticks (0, 1920, 3840)
    //   Track3 (Quotes): 3 clips — quote syllables at bars (0, 1, 2)
    //                                   = ticks (0, 3840, 7680)

    std::vector<int> clipIds;
    clipIds.reserve(10);

    for (int i = 0; i < 4; ++i) {
        Clip c{};
        c.trackId       = t1id;
        c.regionId      = (i % 2 == 0) ? kickId : snareId;
        c.position      = TickTime::from16th(i * 4);   // 0, 960, 1920, 2880
        c.duration      = TickTime::from16th(2);        // half-beat
        c.syllableIndex = -1;
        c.velocity      = 1.0f;
        clipIds.push_back(tl.addClip(c));
    }
    for (int i = 0; i < 3; ++i) {
        Clip c{};
        c.trackId       = t2id;
        c.regionId      = pitchId;
        c.position      = TickTime::fromBeats(i * 2.0); // 0, 1920, 3840
        c.duration      = TickTime::fromBeats(1.5);
        c.syllableIndex = -1;
        c.velocity      = 0.8f;
        c.pitchOffset   = i * 2;
        clipIds.push_back(tl.addClip(c));
    }
    for (int i = 0; i < 3; ++i) {
        Clip c{};
        c.trackId       = t3id;
        c.regionId      = quoteId;
        c.position      = TickTime::fromBars(i);   // 0, 3840, 7680
        c.duration      = TickTime::fromBeats(1.0);
        c.syllableIndex = i;                        // syllable clips
        c.velocity      = 0.9f;
        clipIds.push_back(tl.addClip(c));
    }

    CHECK(clipIds.size() == 10,            "10 clip ids returned");
    CHECK(tl.getAllClips().size() == 10,   "10 clips in timeline");
    for (int id : clipIds)
        CHECK(id > 0, "each clip got valid id");

    // isSyllableClip
    CHECK(!tl.getClip(clipIds[0])->isSyllableClip(), "drum clip is NOT syllable clip");
    CHECK( tl.getClip(clipIds[7])->isSyllableClip(), "quote clip IS syllable clip");
    CHECK(tl.getClip(clipIds[7])->syllableIndex == 0, "quote clip[7] syllableIndex == 0");
    CHECK(tl.getClip(clipIds[9])->syllableIndex == 2, "quote clip[9] syllableIndex == 2");

    // ── [8] getClipsOnTrack ───────────────────────────────────────────────────
    std::cout << "[8] getClipsOnTrack\n";
    CHECK(tl.getClipsOnTrack(t1id).size() == 4, "4 clips on Drums track");
    CHECK(tl.getClipsOnTrack(t2id).size() == 3, "3 clips on Pitch track");
    CHECK(tl.getClipsOnTrack(t3id).size() == 3, "3 clips on Quotes track");
    CHECK(tl.getClipsOnTrack(999).empty(),       "unknown track → empty");

    // ── [9] getClipsInRange ───────────────────────────────────────────────────
    std::cout << "[9] getClipsInRange\n";
    // Range [beat 1, beat 3)  =  ticks [960, 2880)
    //   Drums in range:  clipIds[1] @ 960, clipIds[2] @ 1920     → 2
    //   Pitch in range:  clipIds[5] @ 1920                        → 1
    //   Quotes in range: none                                      → 0
    //   Total: 3
    auto inRange = tl.getClipsInRange(TickTime::fromBeats(1.0),
                                      TickTime::fromBeats(3.0));
    CHECK(inRange.size() == 3, "3 clips in range [beat1, beat3)");

    // Nothing before tick 0
    CHECK(tl.getClipsInRange(TickTime{-100}, TickTime{0}).empty(),
          "no clips before tick 0");

    // All clips start before bar 4 (ticks < 15360)
    CHECK(tl.getClipsInRange(TickTime{0}, TickTime::fromBars(4)).size() == 10,
          "all 10 clips start before bar 4");

    // ── [10] removeClip ───────────────────────────────────────────────────────
    std::cout << "[10] removeClip\n";
    int removedId = clipIds[0];  // kick at tick 0
    CHECK( tl.removeClip(removedId),            "removeClip returns true");
    CHECK( tl.getAllClips().size() == 9,         "9 clips after removal");
    CHECK( tl.getClip(removedId) == nullptr,     "removed clip returns nullptr");
    CHECK(!tl.removeClip(removedId),             "double-remove returns false");
    CHECK( tl.getClipsOnTrack(t1id).size() == 3, "3 clips on Drums after removal");

    // ── [11] moveClip ─────────────────────────────────────────────────────────
    std::cout << "[11] moveClip\n";
    int movedId     = clipIds[1];   // was at tick 960
    TickTime newPos = TickTime::fromBars(8);
    CHECK( tl.moveClip(movedId, newPos),             "moveClip returns true");
    CHECK( tl.getClip(movedId)->position == newPos,  "clip at new position");
    CHECK(!tl.moveClip(999, newPos),                  "moveClip invalid id returns false");

    // ── [12] resizeClip ───────────────────────────────────────────────────────
    std::cout << "[12] resizeClip\n";
    int resizedId    = clipIds[2];
    TickTime newDur  = TickTime::fromBeats(3.0);
    CHECK( tl.resizeClip(resizedId, newDur),              "resizeClip returns true");
    CHECK( tl.getClip(resizedId)->duration == newDur,     "clip has new duration");
    CHECK(!tl.resizeClip(999, newDur),                    "resizeClip invalid id returns false");

    // ── [13] Transport setters ────────────────────────────────────────────────
    std::cout << "[13] Transport setters\n";
    tl.setBPM(160.0);
    CHECK_NEAR(tl.getBPM(), 160.0, 1e-9, "BPM updated to 160");
    tl.setSampleRate(48000.0);
    CHECK_NEAR(tl.getSampleRate(), 48000.0, 1e-9, "SR updated to 48000");
    tl.setTimeSignature(3, 4);
    CHECK(tl.getTimeSigNum() == 3 && tl.getTimeSigDen() == 4, "TimeSig set to 3/4");
    tl.setBPM(140.0);  // restore for TickTime comparisons below

    // ── [14] JSON round-trip ──────────────────────────────────────────────────
    std::cout << "[14] JSON serialization round-trip\n";
    tl.setGlobalStretchMethod(static_cast<int>(StretchMethod::WORLD));
    nlohmann::json j = tl.toJSON();

    // Top-level keys present
    CHECK(j.contains("bpm"),        "JSON has bpm");
    CHECK(j.contains("sampleRate"), "JSON has sampleRate");
    CHECK(j.contains("timeSigNum"), "JSON has timeSigNum");
    CHECK(j.contains("sources"),    "JSON has sources");
    CHECK(j.contains("regions"),    "JSON has regions");
    CHECK(j.contains("tracks"),     "JSON has tracks");
    CHECK(j.contains("clips"),      "JSON has clips");
    CHECK(j.contains("globalStretchMethod"), "JSON has globalStretchMethod");

    // Counts
    CHECK(j["sources"].size() == 2, "JSON: 2 sources");
    CHECK(j["regions"].size() == 5, "JSON: 5 regions");
    CHECK(j["tracks"].size()  == 3, "JSON: 3 tracks");
    CHECK(j["clips"].size()   == 9, "JSON: 9 clips (one was removed)");

    // Deserialize into fresh timeline
    Timeline tl2;
    CHECK(tl2.fromJSON(j), "fromJSON succeeds");

    CHECK_NEAR(tl2.getBPM(),        tl.getBPM(),        1e-9, "deserialized BPM matches");
    CHECK_NEAR(tl2.getSampleRate(), tl.getSampleRate(), 1e-9, "deserialized SR matches");
    CHECK(tl2.getTimeSigNum() == tl.getTimeSigNum(), "deserialized timeSigNum matches");
    CHECK(tl2.getGlobalStretchMethod() == static_cast<int>(StretchMethod::WORLD),
          "deserialized globalStretchMethod matches");
    CHECK(tl2.getAllSources().size() == 2, "deserialized 2 sources");
    CHECK(tl2.getAllRegions().size() == 5, "deserialized 5 regions");
    CHECK(tl2.getAllTracks().size()  == 3, "deserialized 3 tracks");
    CHECK(tl2.getAllClips().size()   == 9, "deserialized 9 clips");

    // Quote region survived round-trip
    const SampleRegion* quoteCopy = tl2.getRegion(quoteId);
    CHECK(quoteCopy != nullptr,                        "quote region found after deser");
    CHECK(quoteCopy->isQuote(),                        "quote.isQuote() after deser");
    CHECK(quoteCopy->syllables.size() == 4,            "4 syllables after deser");
    CHECK(quoteCopy->syllables[0].text == "Spar",      "syllable[0].text preserved");
    CHECK(quoteCopy->syllables[3].text == "mix",       "syllable[3].text preserved");
    CHECK_NEAR(quoteCopy->syllables[1].startTime, 0.25, 1e-9, "syllable[1].startTime preserved");

    // Source data survived
    const SourceMedia* src1Copy = tl2.getSource(srcId1);
    CHECK(src1Copy != nullptr,                         "source1 found after deser");
    CHECK(src1Copy->fileName == "sparta_base.mp4",     "source1 fileName preserved");
    CHECK_NEAR(src1Copy->fps, 29.97, 1e-9,             "source1 fps preserved");

    // Track data survived
    const TrackInfo* t1Copy = tl2.getTrack(t1id);
    CHECK(t1Copy != nullptr,                           "track1 found after deser");
    CHECK(t1Copy->name == "Drums",                     "track1 name preserved");
    CHECK_NEAR(t1Copy->videoOpacity, 1.0f, 1e-5f,     "track1 videoOpacity preserved");

    // Moved clip survived
    const Clip* movedCopy = tl2.getClip(movedId);
    CHECK(movedCopy != nullptr,                        "moved clip found after deser");
    CHECK(movedCopy->position == newPos,               "moved clip position preserved");

    // Resized clip survived
    const Clip* resizedCopy = tl2.getClip(resizedId);
    CHECK(resizedCopy != nullptr,                      "resized clip found after deser");
    CHECK(resizedCopy->duration == newDur,             "resized clip duration preserved");

    // Syllable clip flag survived
    const Clip* quoteclipCopy = tl2.getClip(clipIds[7]);
    CHECK(quoteclipCopy != nullptr,                    "quote clip found after deser");
    CHECK(quoteclipCopy->isSyllableClip(),             "isSyllableClip() preserved");

    // getClipsOnTrack works on deserialized timeline
    CHECK(tl2.getClipsOnTrack(t1id).size() == 3, "tl2: 3 clips on Drums");
    CHECK(tl2.getClipsOnTrack(t2id).size() == 3, "tl2: 3 clips on Pitch");
    CHECK(tl2.getClipsOnTrack(t3id).size() == 3, "tl2: 3 clips on Quotes");

    // Double round-trip (serialize tl2, deserialize into tl3)
    Timeline tl3;
    CHECK(tl3.fromJSON(tl2.toJSON()), "double round-trip fromJSON succeeds");
    CHECK(tl3.getAllClips().size() == 9, "double round-trip: 9 clips");

    {
        nlohmann::json legacy = j;
        legacy.erase("globalStretchMethod");
        Timeline legacyTl;
        CHECK(legacyTl.fromJSON(legacy), "legacy project without globalStretchMethod loads");
        CHECK(legacyTl.getGlobalStretchMethod() == static_cast<int>(StretchMethod::PSOLA),
              "missing globalStretchMethod falls back to PSOLA");

        nlohmann::json invalid = j;
        invalid["globalStretchMethod"] = 0;
        Timeline invalidTl;
        CHECK(invalidTl.fromJSON(invalid), "invalid globalStretchMethod project loads");
        CHECK(invalidTl.getGlobalStretchMethod() == static_cast<int>(StretchMethod::PSOLA),
              "invalid globalStretchMethod falls back to PSOLA");
    }

    // ── [15] VideoFlipConfig migration round-trip ─────────────────────────────
    testVideoFlipConfigMigration();
    testTrackFxModePersistence();
    testGraphStateOpaquePersistence();

    // ── [16] Track color metadata persistence (Pass 6D) ───────────────────────
    {
        std::cout << "[16] Track color metadata persistence (Pass 6D)\n";

        // 16a — defaults: new TrackInfo is Auto/0, JSON emits "auto" with no slot
        {
            TrackInfo t;
            CHECK(t.trackColorMode == TrackColorMode::Auto, "default mode is Auto");
            CHECK(t.trackColorSlot == 0, "default slot is 0");
            nlohmann::json j = t;
            CHECK(j.value("trackColorMode", std::string("")) == "auto",
                  "default JSON has trackColorMode=auto");
            CHECK(!j.contains("trackColorSlot"),
                  "default JSON omits trackColorSlot in Auto mode");
        }

        // 16b — paletteSlot round-trip preserves mode and slot
        {
            TrackInfo t;
            t.trackColorMode = TrackColorMode::PaletteSlot;
            t.trackColorSlot = 7;
            nlohmann::json j = t;
            CHECK(j.value("trackColorMode", std::string("")) == "paletteSlot",
                  "paletteSlot JSON has trackColorMode=paletteSlot");
            CHECK(j.value("trackColorSlot", -1) == 7,
                  "paletteSlot JSON carries trackColorSlot=7");
            TrackInfo t2 = j.get<TrackInfo>();
            CHECK(t2.trackColorMode == TrackColorMode::PaletteSlot,
                  "round-trip mode == PaletteSlot");
            CHECK(t2.trackColorSlot == 7, "round-trip slot == 7");
        }

        // 16c — old project (no fields) loads as Auto
        {
            nlohmann::json j = makeMinimalTrackJson("None");
            TrackInfo t = j.get<TrackInfo>();
            CHECK(t.trackColorMode == TrackColorMode::Auto,
                  "missing fields → Auto mode");
            CHECK(t.trackColorSlot == 0, "missing fields → slot=0");
        }

        // 16d — invalid mode string sanitizes to Auto
        {
            nlohmann::json j = makeMinimalTrackJson("None");
            j["trackColorMode"] = "rainbow";
            j["trackColorSlot"] = 5;
            TrackInfo t = j.get<TrackInfo>();
            CHECK(t.trackColorMode == TrackColorMode::Auto,
                  "invalid mode string → Auto");
            CHECK(t.trackColorSlot == 0, "invalid mode → slot dropped");
        }

        // 16e — paletteSlot with out-of-range slot collapses to Auto
        {
            nlohmann::json j = makeMinimalTrackJson("None");
            j["trackColorMode"] = "paletteSlot";
            j["trackColorSlot"] = 99;
            TrackInfo t = j.get<TrackInfo>();
            CHECK(t.trackColorMode == TrackColorMode::Auto,
                  "out-of-range slot → Auto");
            CHECK(t.trackColorSlot == 0, "out-of-range slot → 0");
        }

        // 16f — paletteSlot with slot=0 collapses to Auto
        {
            nlohmann::json j = makeMinimalTrackJson("None");
            j["trackColorMode"] = "paletteSlot";
            j["trackColorSlot"] = 0;
            TrackInfo t = j.get<TrackInfo>();
            CHECK(t.trackColorMode == TrackColorMode::Auto,
                  "slot=0 → Auto");
        }

        // 16g — Timeline::setTrackColor sanitizes invalid input
        {
            Timeline tlc;
            TrackInfo seed;
            seed.name = "Color";
            int id = tlc.addTrack(seed);
            // Valid PaletteSlot — accepted.
            CHECK(tlc.setTrackColor(id, TrackColorMode::PaletteSlot, 5),
                  "setTrackColor(PaletteSlot,5) returns true");
            CHECK(tlc.getTrack(id)->trackColorMode == TrackColorMode::PaletteSlot,
                  "mode stored as PaletteSlot");
            CHECK(tlc.getTrack(id)->trackColorSlot == 5, "slot stored as 5");
            // PaletteSlot with bad slot → engine collapses to Auto.
            tlc.setTrackColor(id, TrackColorMode::PaletteSlot, 99);
            CHECK(tlc.getTrack(id)->trackColorMode == TrackColorMode::Auto,
                  "bad slot collapses to Auto");
            CHECK(tlc.getTrack(id)->trackColorSlot == 0, "bad slot resets to 0");
            // Auto mode always clears slot.
            tlc.setTrackColor(id, TrackColorMode::Auto, 9);
            CHECK(tlc.getTrack(id)->trackColorSlot == 0,
                  "Auto mode forces slot=0 even with non-zero arg");
            // Unknown trackId → false.
            CHECK(!tlc.setTrackColor(99999, TrackColorMode::PaletteSlot, 1),
                  "unknown trackId returns false");
        }

        // ── Pass 6F: custom-hex track color metadata ──────────────────────────

        // 16h — defaults: new TrackInfo has empty trackColorCustom and JSON
        // omits the field in Auto mode.
        {
            TrackInfo t;
            CHECK(t.trackColorCustom.empty(),
                  "default trackColorCustom is empty");
            nlohmann::json j = t;
            CHECK(!j.contains("trackColorCustom"),
                  "default JSON omits trackColorCustom in Auto mode");
        }

        // 16i — validation helpers
        {
            CHECK(isValidTrackCustomColor("#4CC9F0"), "uppercase hex valid");
            CHECK(isValidTrackCustomColor("#4cc9f0"), "lowercase hex valid");
            CHECK(isValidTrackCustomColor("#FF00aa"), "mixed-case hex valid");
            CHECK(!isValidTrackCustomColor(""), "empty hex invalid");
            CHECK(!isValidTrackCustomColor("4CC9F0"), "missing # invalid");
            CHECK(!isValidTrackCustomColor("#FFF"), "short hex invalid");
            CHECK(!isValidTrackCustomColor("#GGGGGG"), "non-hex chars invalid");
            CHECK(!isValidTrackCustomColor("#1234567"), "too long invalid");
            CHECK(!isValidTrackCustomColor("rgb(0,0,0)"), "rgb() invalid");
            CHECK(normalizeTrackCustomColor("#4cc9f0") == "#4CC9F0",
                  "normalize uppercases");
            CHECK(normalizeTrackCustomColor("#4CC9F0") == "#4CC9F0",
                  "normalize preserves uppercase");
            CHECK(normalizeTrackCustomColor("rgb(0,0,0)").empty(),
                  "normalize invalid → empty");
        }

        // 16j — Timeline::setTrackColor stores normalized custom color
        {
            Timeline tlc;
            TrackInfo seed; seed.name = "Cust";
            int id = tlc.addTrack(seed);
            CHECK(tlc.setTrackColor(id, TrackColorMode::Custom, 0, "#4cc9f0"),
                  "setTrackColor(Custom, '#4cc9f0') returns true");
            CHECK(tlc.getTrack(id)->trackColorMode == TrackColorMode::Custom,
                  "mode stored as Custom");
            CHECK(tlc.getTrack(id)->trackColorSlot == 0,
                  "Custom clears slot to 0");
            CHECK(tlc.getTrack(id)->trackColorCustom == "#4CC9F0",
                  "custom hex normalized to uppercase");
        }

        // 16k — invalid custom color collapses to Auto with empty custom
        {
            Timeline tlc;
            TrackInfo seed; seed.name = "Cust";
            int id = tlc.addTrack(seed);
            tlc.setTrackColor(id, TrackColorMode::Custom, 0, "rgb(0,0,0)");
            CHECK(tlc.getTrack(id)->trackColorMode == TrackColorMode::Auto,
                  "invalid custom → Auto");
            CHECK(tlc.getTrack(id)->trackColorSlot == 0,
                  "invalid custom → slot=0");
            CHECK(tlc.getTrack(id)->trackColorCustom.empty(),
                  "invalid custom → trackColorCustom empty");
        }

        // 16l — switching Custom → PaletteSlot clears custom
        {
            Timeline tlc;
            TrackInfo seed; seed.name = "Cust";
            int id = tlc.addTrack(seed);
            tlc.setTrackColor(id, TrackColorMode::Custom, 0, "#FF00AA");
            tlc.setTrackColor(id, TrackColorMode::PaletteSlot, 3, "");
            CHECK(tlc.getTrack(id)->trackColorMode == TrackColorMode::PaletteSlot,
                  "switched to PaletteSlot");
            CHECK(tlc.getTrack(id)->trackColorSlot == 3,
                  "slot stored as 3");
            CHECK(tlc.getTrack(id)->trackColorCustom.empty(),
                  "PaletteSlot clears prior custom");
        }

        // 16m — switching Custom → Auto clears custom
        {
            Timeline tlc;
            TrackInfo seed; seed.name = "Cust";
            int id = tlc.addTrack(seed);
            tlc.setTrackColor(id, TrackColorMode::Custom, 0, "#FF00AA");
            tlc.setTrackColor(id, TrackColorMode::Auto, 0, "");
            CHECK(tlc.getTrack(id)->trackColorMode == TrackColorMode::Auto,
                  "switched to Auto");
            CHECK(tlc.getTrack(id)->trackColorCustom.empty(),
                  "Auto clears prior custom");
        }

        // 16n — Custom JSON round-trip preserves normalized hex
        {
            TrackInfo t;
            t.trackColorMode   = TrackColorMode::Custom;
            t.trackColorCustom = "#FF00AA";
            nlohmann::json j = t;
            CHECK(j.value("trackColorMode", std::string("")) == "custom",
                  "Custom JSON has trackColorMode=custom");
            CHECK(j.value("trackColorCustom", std::string("")) == "#FF00AA",
                  "Custom JSON carries trackColorCustom=#FF00AA");
            CHECK(!j.contains("trackColorSlot"),
                  "Custom JSON omits trackColorSlot");
            TrackInfo t2 = j.get<TrackInfo>();
            CHECK(t2.trackColorMode == TrackColorMode::Custom,
                  "round-trip mode == Custom");
            CHECK(t2.trackColorCustom == "#FF00AA",
                  "round-trip hex preserved");
            CHECK(t2.trackColorSlot == 0,
                  "round-trip slot stays 0");
        }

        // 16o — JSON load: mode=custom but invalid hex sanitizes to Auto
        {
            nlohmann::json j = makeMinimalTrackJson("None");
            j["trackColorMode"]   = "custom";
            j["trackColorCustom"] = "rgb(1,2,3)";
            TrackInfo t = j.get<TrackInfo>();
            CHECK(t.trackColorMode == TrackColorMode::Auto,
                  "invalid custom JSON → Auto");
            CHECK(t.trackColorCustom.empty(),
                  "invalid custom JSON → trackColorCustom empty");
        }

        // 16p — JSON load: mode=custom missing hex sanitizes to Auto
        {
            nlohmann::json j = makeMinimalTrackJson("None");
            j["trackColorMode"] = "custom";
            TrackInfo t = j.get<TrackInfo>();
            CHECK(t.trackColorMode == TrackColorMode::Auto,
                  "missing custom hex → Auto");
        }

        // 16q — SetTrackColorCommand: undo from Custom → Auto restores Custom
        {
            Timeline tlc;
            TrackInfo seed; seed.name = "Cust";
            int id = tlc.addTrack(seed);
            // First, set Custom directly so the command snapshots it as "old".
            tlc.setTrackColor(id, TrackColorMode::Custom, 0, "#123456");
            CHECK(tlc.getTrack(id)->trackColorCustom == "#123456",
                  "preset Custom hex");
            // Build a command that switches to Auto.
            SetTrackColorCommand cmd(id, TrackColorMode::Auto, 0, "", tlc);
            cmd.execute(tlc);
            CHECK(tlc.getTrack(id)->trackColorMode == TrackColorMode::Auto,
                  "after execute: Auto");
            CHECK(tlc.getTrack(id)->trackColorCustom.empty(),
                  "after execute: custom cleared");
            cmd.undo(tlc);
            CHECK(tlc.getTrack(id)->trackColorMode == TrackColorMode::Custom,
                  "after undo: Custom restored");
            CHECK(tlc.getTrack(id)->trackColorCustom == "#123456",
                  "after undo: custom hex restored exactly");
        }

        // 16r — SetTrackColorCommand: redo of custom assignment reapplies
        {
            Timeline tlc;
            TrackInfo seed; seed.name = "Cust";
            int id = tlc.addTrack(seed);
            // Start in Auto; command assigns Custom.
            SetTrackColorCommand cmd(id, TrackColorMode::Custom, 0, "#abcdef", tlc);
            cmd.execute(tlc);
            CHECK(tlc.getTrack(id)->trackColorMode == TrackColorMode::Custom,
                  "execute → Custom");
            CHECK(tlc.getTrack(id)->trackColorCustom == "#ABCDEF",
                  "execute stores normalized hex");
            cmd.undo(tlc);
            CHECK(tlc.getTrack(id)->trackColorMode == TrackColorMode::Auto,
                  "undo → Auto");
            cmd.execute(tlc);  // redo
            CHECK(tlc.getTrack(id)->trackColorMode == TrackColorMode::Custom,
                  "redo → Custom");
            CHECK(tlc.getTrack(id)->trackColorCustom == "#ABCDEF",
                  "redo restores normalized hex");
        }

        // 16s — SetTrackColorCommand: undo from PaletteSlot → Custom restores Custom
        {
            Timeline tlc;
            TrackInfo seed; seed.name = "Cust";
            int id = tlc.addTrack(seed);
            tlc.setTrackColor(id, TrackColorMode::Custom, 0, "#FF00AA");
            // Command snapshots Custom as the prior state.
            SetTrackColorCommand cmd(id, TrackColorMode::PaletteSlot, 5, "", tlc);
            cmd.execute(tlc);
            CHECK(tlc.getTrack(id)->trackColorMode == TrackColorMode::PaletteSlot,
                  "after execute: PaletteSlot");
            CHECK(tlc.getTrack(id)->trackColorCustom.empty(),
                  "after execute: custom cleared");
            cmd.undo(tlc);
            CHECK(tlc.getTrack(id)->trackColorMode == TrackColorMode::Custom,
                  "after undo: Custom restored");
            CHECK(tlc.getTrack(id)->trackColorCustom == "#FF00AA",
                  "after undo: custom hex restored");
            CHECK(tlc.getTrack(id)->trackColorSlot == 0,
                  "after undo: slot cleared back to 0");
        }
    }

    // ── [Z] Fullscreen zOrder migration + round-trip ──────────────────────────
    testFullscreenZOrderMigration();

    // ── [S] Grid snapshot container migration + round-trip ─────────────────────
    testGridSnapshotContainerMigration();
    testLiveGridSnapshotCrudAndRoundTrip();
    testGridCueResolutionAndRoundTrip();

    // ── [TR] Snapshot transition — timing + persistence + resolver ─────────────
    testProgressForSample();
    testCueTransitionRoundTrip();
    testTransitionResolver();

    // ── Results ───────────────────────────────────────────────────────────────
    std::cout << "\n=== Results: "
              << g_passed << " passed, "
              << g_failed << " failed ===\n";

    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    } else {
        std::cout << "FAILED: " << g_failed << " test(s) failed\n";
        return 1;
    }
}
