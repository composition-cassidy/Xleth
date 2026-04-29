// test_timeline.cpp — Phase 1 self-verification for the Timeline data model.
// Build: see engine/CMakeLists.txt target "test_timeline"
// Run:   test_timeline.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1

#include "model/Timeline.h"
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
    nlohmann::json j = tl.toJSON();

    // Top-level keys present
    CHECK(j.contains("bpm"),        "JSON has bpm");
    CHECK(j.contains("sampleRate"), "JSON has sampleRate");
    CHECK(j.contains("timeSigNum"), "JSON has timeSigNum");
    CHECK(j.contains("sources"),    "JSON has sources");
    CHECK(j.contains("regions"),    "JSON has regions");
    CHECK(j.contains("tracks"),     "JSON has tracks");
    CHECK(j.contains("clips"),      "JSON has clips");

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

    // ── [15] VideoFlipConfig migration round-trip ─────────────────────────────
    testVideoFlipConfigMigration();

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
