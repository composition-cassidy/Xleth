// test_envelope_runtime.cpp
// Unit tests for the engine-side Envelope Controller definition parser and the
// per-voice runtime state binding (EVC.5).
//
// Audit: docs/dev/fxgraph-envelope-controller-architecture-audit.md (§3–§7)
// Model: engine/src/model/EnvelopeRuntime.h, EnvelopeVoiceEvents.h, EnvelopeAhdsr.h
//
// These tests are pure and fast — they build minimal graphState JSON and minimal
// Clip / Pattern / PatternBlock model structs directly and assert deterministic
// definition parsing + per-voice runtime binding. No audio rendering, no transport,
// no Sampler, no per-voice gain application.
//
// Build target: test_envelope_runtime (engine/CMakeLists.txt)
// Pure C++, model-only — links solely against XlethEngineModel.
// Pass: prints "ALL TESTS PASSED" and exits 0.

#include "model/EnvelopeRuntime.h"

#include <nlohmann/json.hpp>

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

static bool approx(double a, double b, double eps = 1e-3) {
    return (a - b <= eps) && (b - a <= eps);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// 120 BPM, 960 PPQ: 192 ticks = 100 ms exactly.
static constexpr double kBpm = 120.0;
static constexpr double kSr  = 48000.0;

static TickTime tt(int64_t ticks) { return TickTime{ticks}; }

static Clip makeClip(int id, int trackId, int regionId,
                     int64_t posTicks, int64_t durTicks,
                     int pitchOffset = 0, float velocity = 1.0f) {
    Clip c;
    c.id = id; c.trackId = trackId; c.regionId = regionId;
    c.position = tt(posTicks); c.duration = tt(durTicks);
    c.pitchOffset = pitchOffset; c.velocity = velocity;
    return c;
}

static PatternNote makeNote(int id, int64_t posTicks, int64_t durTicks,
                            int pitch = 60, float velocity = 1.0f, bool isSlide = false) {
    PatternNote n;
    n.id = id; n.position = tt(posTicks); n.duration = tt(durTicks);
    n.pitch = pitch; n.velocity = velocity; n.isSlide = isSlide;
    return n;
}

static Pattern makePattern(int id, int regionId, int64_t lenTicks, std::vector<PatternNote> notes) {
    Pattern p;
    p.id = id; p.regionId = regionId; p.length = tt(lenTicks); p.notes = std::move(notes);
    return p;
}

static PatternBlock makeBlock(int id, int trackId, int patternId,
                              int64_t posTicks, int64_t durTicks,
                              int64_t offsetTicks = 0, bool loopEnabled = false) {
    PatternBlock b;
    b.id = id; b.trackId = trackId; b.patternId = patternId;
    b.position = tt(posTicks); b.duration = tt(durTicks);
    b.offset = tt(offsetTicks); b.loopEnabled = loopEnabled;
    return b;
}

// Shared envelope: 100 ms attack (192 ticks), no hold/decay, sustain 0.5, 200 ms
// release (384 ticks). Linear (tension 0).
static EnvelopeAhdsrSettings reconSettings() {
    EnvelopeAhdsrSettings s;
    s.attackMs = 100; s.holdMs = 0; s.decayMs = 0; s.sustain = 0.5; s.releaseMs = 200;
    s.attackTension = 0; s.decayTension = 0; s.releaseTension = 0; s.amount = 1.0;
    return s;
}

static EnvelopeControllerDefinition makeDef(EnvelopeTriggerEvents ev, int maxVoices = 32) {
    EnvelopeControllerDefinition d;
    d.nodeId = "env-1";
    d.label = "Env";
    d.settings = reconSettings();
    d.voiceMode = EnvelopeVoiceMode::Poly;
    d.maxVoices = maxVoices;
    d.triggerEvents = ev;
    d.target = EnvelopeTargetKind::VoiceGain;
    return d;
}

// ─── graphState JSON fixtures ─────────────────────────────────────────────────

static nlohmann::json validEnvData() {
    return {
        {"label", "Env"},
        {"attackMs", 10}, {"holdMs", 0}, {"decayMs", 120},
        {"sustain", 0.7}, {"releaseMs", 200},
        {"attackTension", 0}, {"decayTension", 0}, {"releaseTension", 0},
        {"amount", 1},
        {"voiceMode", "poly"}, {"maxVoices", 32},
        {"triggerSource", {{"kind", "parentTrack"}, {"events", "notesAndClips"}}},
        {"target", {{"kind", "voiceGain"}}},
        {"monophonic", {{"legato", false}, {"glideMs", 0}}},
    };
}

static nlohmann::json makeNode(const std::string& id, const std::string& type, nlohmann::json data) {
    nlohmann::json n;
    n["id"] = id; n["type"] = type; n["data"] = std::move(data);
    return n;
}

static nlohmann::json graphWith(std::vector<nlohmann::json> nodes) {
    nlohmann::json g;
    g["nodes"] = nlohmann::json::array();
    for (auto& n : nodes) g["nodes"].push_back(std::move(n));
    return g;
}

// ─── Parser tests ─────────────────────────────────────────────────────────────

static void testParsesOneValidNode() {
    auto g = graphWith({ makeNode("env-a", "envelope", validEnvData()) });
    auto defs = parseEnvelopeControllerDefinitions(g);
    CHECK(defs.size() == 1, "one valid envelope node → one definition");
    if (defs.size() == 1) {
        const auto& d = defs[0];
        CHECK(d.nodeId == "env-a", "definition keeps node id");
        CHECK(d.label == "Env", "definition label");
        CHECK(approx(d.settings.attackMs, 10.0), "attackMs parsed");
        CHECK(approx(d.settings.sustain, 0.7), "sustain parsed");
        CHECK(approx(d.settings.releaseMs, 200.0), "releaseMs parsed");
        CHECK(d.voiceMode == EnvelopeVoiceMode::Poly, "voiceMode poly");
        CHECK(d.maxVoices == 32, "maxVoices 32");
        CHECK(d.triggerEvents == EnvelopeTriggerEvents::NotesAndClips, "trigger notesAndClips");
        CHECK(d.target == EnvelopeTargetKind::VoiceGain, "target voiceGain");
    }
}

static void testIgnoresNonEnvelopeNodes() {
    auto g = graphWith({
        makeNode("fx-1", "effect", {{"effectInstanceId", "abc"}}),
        makeNode("macro-1", "macro", {{"label", "M"}}),
        makeNode("env-a", "envelope", validEnvData()),
        makeNode("unknown-1", "weirdType", {{"foo", 1}}),
    });
    auto defs = parseEnvelopeControllerDefinitions(g);
    CHECK(defs.size() == 1, "only the envelope node is parsed");
    if (defs.size() == 1) CHECK(defs[0].nodeId == "env-a", "envelope id selected");
}

static void testIgnoresMalformedNodesSafely() {
    nlohmann::json g;
    g["nodes"] = nlohmann::json::array();
    g["nodes"].push_back(42);                                   // not an object
    g["nodes"].push_back(nlohmann::json::object());             // no type/id
    g["nodes"].push_back(makeNode("", "envelope", validEnvData())); // empty id → skip
    nlohmann::json noData; noData["id"] = "env-x"; noData["type"] = "envelope"; // no data
    g["nodes"].push_back(noData);
    g["nodes"].push_back(makeNode("env-ok", "envelope", validEnvData()));

    auto defs = parseEnvelopeControllerDefinitions(g);
    // env-x (no data → defaults) and env-ok both valid; malformed entries skipped.
    CHECK(defs.size() == 2, "malformed nodes skipped; valid ones (incl. missing data) parsed");
    bool hasX = false, hasOk = false;
    for (const auto& d : defs) { if (d.nodeId == "env-x") hasX = true; if (d.nodeId == "env-ok") hasOk = true; }
    CHECK(hasX && hasOk, "missing-data node defaults; valid node parsed");

    // Completely non-object graphState and missing nodes array are safe.
    CHECK(parseEnvelopeControllerDefinitions(nlohmann::json(7)).empty(), "non-object graphState → empty");
    CHECK(parseEnvelopeControllerDefinitions(nlohmann::json::object()).empty(), "no nodes array → empty");
}

static void testRepairsMalformedAhdsr() {
    nlohmann::json data = validEnvData();
    data["attackMs"] = -5;                 // negative → 0
    data["decayMs"] = "oops";              // non-number → default 120
    data["sustain"] = 2.5;                 // > 1 → 1
    data["amount"] = -1;                   // < 0 → 0
    data["attackTension"] = 9;             // > 1 → 1
    data["releaseTension"] = -9;           // < -1 → -1
    auto g = graphWith({ makeNode("env-a", "envelope", data) });
    auto defs = parseEnvelopeControllerDefinitions(g);
    CHECK(defs.size() == 1, "malformed-AHDSR node still parses");
    if (defs.size() == 1) {
        const auto& s = defs[0].settings;
        CHECK(approx(s.attackMs, 0.0), "negative attack repaired to 0");
        CHECK(approx(s.decayMs, 120.0), "non-number decay repaired to default");
        CHECK(approx(s.sustain, 1.0), "sustain clamped to 1");
        CHECK(approx(s.amount, 0.0), "amount clamped to 0");
        CHECK(approx(s.attackTension, 1.0), "attack tension clamped to 1");
        CHECK(approx(s.releaseTension, -1.0), "release tension clamped to -1");
    }
}

static void testRepairsInvalidTriggerSourceEvents() {
    nlohmann::json data = validEnvData();
    data["triggerSource"] = {{"kind", "parentTrack"}, {"events", "bogus"}};
    auto g = graphWith({ makeNode("env-a", "envelope", data) });
    auto defs = parseEnvelopeControllerDefinitions(g);
    CHECK(defs.size() == 1 && defs[0].triggerEvents == EnvelopeTriggerEvents::NotesAndClips,
          "invalid trigger events repaired to notesAndClips");
}

static void testRepairsInvalidVoiceMode() {
    nlohmann::json data = validEnvData();
    data["voiceMode"] = "weird";
    auto g = graphWith({ makeNode("env-a", "envelope", data) });
    auto defs = parseEnvelopeControllerDefinitions(g);
    CHECK(defs.size() == 1 && defs[0].voiceMode == EnvelopeVoiceMode::Poly,
          "invalid voiceMode repaired to poly");

    nlohmann::json monoData = validEnvData();
    monoData["voiceMode"] = "mono";
    auto gm = graphWith({ makeNode("env-m", "envelope", monoData) });
    auto defsm = parseEnvelopeControllerDefinitions(gm);
    CHECK(defsm.size() == 1 && defsm[0].voiceMode == EnvelopeVoiceMode::Mono,
          "explicit mono preserved (inert)");
}

static void testClampsMaxVoices() {
    nlohmann::json low = validEnvData();  low["maxVoices"] = 0;     // → 1
    nlohmann::json high = validEnvData(); high["maxVoices"] = 9999; // → 32
    nlohmann::json frac = validEnvData(); frac["maxVoices"] = 4.6;  // → 5
    auto g = graphWith({
        makeNode("env-low", "envelope", low),
        makeNode("env-high", "envelope", high),
        makeNode("env-frac", "envelope", frac),
    });
    auto defs = parseEnvelopeControllerDefinitions(g);
    CHECK(defs.size() == 3, "all three maxVoices nodes parse");
    int lo = -1, hi = -1, fr = -1;
    for (const auto& d : defs) {
        if (d.nodeId == "env-low") lo = d.maxVoices;
        if (d.nodeId == "env-high") hi = d.maxVoices;
        if (d.nodeId == "env-frac") fr = d.maxVoices;
    }
    CHECK(lo == 1, "maxVoices 0 clamped to 1");
    CHECK(hi == 32, "maxVoices 9999 clamped to 32");
    CHECK(fr == 5, "maxVoices 4.6 rounds to 5");
}

static void testIgnoresUnsupportedTargetKind() {
    nlohmann::json data = validEnvData();
    data["target"] = {{"kind", "graphParameter"}, {"effectInstanceId", "x"}, {"parameterId", "gain"}};
    auto g = graphWith({
        makeNode("env-bad", "envelope", data),
        makeNode("env-ok", "envelope", validEnvData()),
    });
    auto defs = parseEnvelopeControllerDefinitions(g);
    CHECK(defs.size() == 1, "unsupported target kind node ignored");
    if (defs.size() == 1) CHECK(defs[0].nodeId == "env-ok", "voiceGain node retained");
}

static void testIgnoresUnsupportedTriggerSourceKind() {
    nlohmann::json data = validEnvData();
    data["triggerSource"] = {{"kind", "sidechain"}, {"events", "notes"}};
    auto g = graphWith({ makeNode("env-bad", "envelope", data) });
    auto defs = parseEnvelopeControllerDefinitions(g);
    CHECK(defs.empty(), "unsupported trigger source kind node ignored");
}

static void testDoesNotRequireEffectInstanceId() {
    // An envelope node intentionally has NO effectInstanceId; parsing must succeed.
    nlohmann::json data = validEnvData();
    CHECK(!data.contains("effectInstanceId"), "fixture has no effectInstanceId");
    auto g = graphWith({ makeNode("env-a", "envelope", data) });
    auto defs = parseEnvelopeControllerDefinitions(g);
    CHECK(defs.size() == 1, "envelope node parses without an effectInstanceId");
}

static void testDoesNotParseGraphParameterTarget() {
    // A parameter edge / GraphParameterTarget-style payload must never become a
    // controller. Modeled as an effect node carrying a parameter target — ignored
    // because only type === "envelope" is parsed.
    nlohmann::json paramEdgeNode = makeNode("fx-param", "effect", {
        {"effectInstanceId", "abc"},
        {"parameterTarget", {{"kind", "graphParameter"}, {"parameterId", "gain"}}},
    });
    auto g = graphWith({ paramEdgeNode });
    auto defs = parseEnvelopeControllerDefinitions(g);
    CHECK(defs.empty(), "GraphParameterTarget / parameter node is never parsed as a controller");
}

// ─── Runtime tests ────────────────────────────────────────────────────────────

static void testOneNoteCreatesOneVoice() {
    auto pat = makePattern(100, 9, 1920, { makeNote(1, 0, 960, 60) });  // note [0,960)
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(50, 4, 100, 0, 1920) };
    std::vector<Clip> clips;

    EnvelopeControllerRuntime rt(makeDef(EnvelopeTriggerEvents::Notes));
    rt.updateForQuery(clips, blocks, patterns, 4, /*queryTick*/0, kBpm, kSr);  // at onset
    CHECK(rt.voiceCount() == 1, "one note → one runtime voice");
    if (rt.voiceCount() == 1) {
        const auto& v = rt.voices().begin()->second;
        CHECK(v.sourceKind == EnvelopeVoiceSourceKind::PatternNote, "voice is a note");
        CHECK(v.onsetTick == 0 && v.gateEndTick == 960, "voice carries gate");
        CHECK(v.controllerNodeId == "env-1", "voice tagged with controller node id");
        CHECK(v.state == EnvelopeRuntimeVoiceState::Active, "onset voice active");
    }
}

static void testChordCreatesMultipleVoices() {
    auto pat = makePattern(101, 9, 1920, {
        makeNote(1, 0, 960, 60), makeNote(2, 0, 960, 64), makeNote(3, 0, 960, 67),
    });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(60, 4, 101, 0, 1920) };
    std::vector<Clip> clips;

    EnvelopeControllerRuntime rt(makeDef(EnvelopeTriggerEvents::Notes));
    rt.updateForQuery(clips, blocks, patterns, 4, /*queryTick*/480, kBpm, kSr);  // mid-note (sustain)
    CHECK(rt.voiceCount() == 3, "chord → 3 independent runtime voices (never collapsed)");
}

static void testOverlappingClipsMultipleVoices() {
    std::vector<Clip> clips = {
        makeClip(10, 1, 0, 0,   1920),   // [0, 1920)
        makeClip(11, 1, 0, 480, 1920),   // [480, 2400) — overlaps
    };
    std::vector<Pattern> patterns;
    std::vector<PatternBlock> blocks;

    EnvelopeControllerRuntime rt(makeDef(EnvelopeTriggerEvents::Clips));
    rt.updateForQuery(clips, blocks, patterns, 1, /*queryTick*/960, kBpm, kSr);  // both active
    CHECK(rt.voiceCount() == 2, "overlapping clips → 2 independent runtime voices");
    if (rt.voiceCount() == 2) {
        auto it = rt.voices().begin();
        const auto& a = (it++)->second;
        const auto& b = it->second;
        CHECK(a.onsetTick != b.onsetTick, "overlapping clip voices have distinct onsets");
    }
}

static void testLoopIterationsDistinctVoices() {
    // Note fills the pattern; release tail makes iteration 0 still releasing while
    // iteration 1 is in attack → both present as distinct runtime voices.
    auto pat = makePattern(104, 9, 1920, { makeNote(1, 0, 1920, 60) });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(90, 4, 104, 0, 3840, /*offset*/0, /*loop*/true) };
    std::vector<Clip> clips;

    EnvelopeControllerRuntime rt(makeDef(EnvelopeTriggerEvents::Notes));
    rt.updateForQuery(clips, blocks, patterns, 4, /*queryTick*/2000, kBpm, kSr);
    CHECK(rt.voiceCount() == 2, "two loop iterations → two distinct runtime voices");
    if (rt.voiceCount() == 2) {
        auto it = rt.voices().begin();
        const auto& a = (it++)->second;
        const auto& b = it->second;
        CHECK(a.key != b.key, "loop iteration voice keys distinct");
        CHECK(a.key.loopIteration != b.key.loopIteration, "distinct loop iteration values");
        CHECK(a.key.sourceId == b.key.sourceId, "same note id across iterations");
    }
}

static void testNotesOnlyIgnoresClips() {
    std::vector<Clip> clips = { makeClip(1, 4, 0, 0, 1920) };
    auto pat = makePattern(110, 9, 1920, { makeNote(1, 0, 960, 60) });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(120, 4, 110, 0, 1920) };

    EnvelopeControllerRuntime rt(makeDef(EnvelopeTriggerEvents::Notes));
    rt.updateForQuery(clips, blocks, patterns, 4, /*queryTick*/480, kBpm, kSr);
    CHECK(rt.voiceCount() == 1, "notes-only → only the note voice");
    if (rt.voiceCount() == 1)
        CHECK(rt.voices().begin()->second.sourceKind == EnvelopeVoiceSourceKind::PatternNote,
              "notes-only voice is a note");
}

static void testClipsOnlyIgnoresNotes() {
    std::vector<Clip> clips = { makeClip(1, 4, 0, 0, 1920) };
    auto pat = makePattern(111, 9, 1920, { makeNote(1, 0, 960, 60) });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(121, 4, 111, 0, 1920) };

    EnvelopeControllerRuntime rt(makeDef(EnvelopeTriggerEvents::Clips));
    rt.updateForQuery(clips, blocks, patterns, 4, /*queryTick*/480, kBpm, kSr);
    CHECK(rt.voiceCount() == 1, "clips-only → only the clip voice");
    if (rt.voiceCount() == 1)
        CHECK(rt.voices().begin()->second.sourceKind == EnvelopeVoiceSourceKind::TimelineClip,
              "clips-only voice is a clip");
}

static void testNotesAndClipsIncludesBoth() {
    std::vector<Clip> clips = { makeClip(1, 4, 0, 0, 1920) };
    auto pat = makePattern(112, 9, 1920, { makeNote(1, 0, 960, 60) });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(122, 4, 112, 0, 1920) };

    EnvelopeControllerRuntime rt(makeDef(EnvelopeTriggerEvents::NotesAndClips));
    rt.updateForQuery(clips, blocks, patterns, 4, /*queryTick*/480, kBpm, kSr);
    CHECK(rt.voiceCount() == 2, "notesAndClips → both note and clip voices");
    bool hasNote = false, hasClip = false;
    for (const auto& kv : rt.voices()) {
        if (kv.second.sourceKind == EnvelopeVoiceSourceKind::PatternNote)  hasNote = true;
        if (kv.second.sourceKind == EnvelopeVoiceSourceKind::TimelineClip) hasClip = true;
    }
    CHECK(hasNote && hasClip, "both source kinds present");
}

static void testMidNoteReconstructsActiveVoice() {
    auto pat = makePattern(130, 9, 1920, { makeNote(1, 480, 960, 64, 0.8f) });  // [480,1440)
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(140, 4, 130, 0, 1920) };
    std::vector<Clip> clips;

    EnvelopeControllerRuntime rt(makeDef(EnvelopeTriggerEvents::Notes));
    rt.updateForQuery(clips, blocks, patterns, 4, /*queryTick*/576, kBpm, kSr);  // 50ms into attack
    CHECK(rt.voiceCount() == 1, "mid-note query reconstructs one active voice");
    if (rt.voiceCount() == 1) {
        const auto& v = rt.voices().begin()->second;
        CHECK(v.currentPhase == EnvelopeAhdsrPhase::Attack, "mid-note in attack");
        CHECK(approx(v.currentLevel, 0.5), "mid-note attack level 0.5 at 50ms");
        CHECK(v.pitch == 64, "voice pitch metadata preserved");
        CHECK(approx(v.velocity, 0.8f), "voice velocity metadata preserved");
    }
}

static void testMidClipReconstructsActiveVoice() {
    std::vector<Clip> clips = { makeClip(5, 2, 0, 0, 960) };  // [0,960) = 500 ms
    std::vector<Pattern> patterns;
    std::vector<PatternBlock> blocks;

    EnvelopeControllerRuntime rt(makeDef(EnvelopeTriggerEvents::Clips));
    rt.updateForQuery(clips, blocks, patterns, 2, /*queryTick*/480, kBpm, kSr);  // 250 ms in → sustain
    CHECK(rt.voiceCount() == 1, "mid-clip query reconstructs one active voice");
    if (rt.voiceCount() == 1) {
        const auto& v = rt.voices().begin()->second;
        CHECK(v.currentPhase == EnvelopeAhdsrPhase::Sustain, "mid-clip in sustain");
        CHECK(approx(v.currentLevel, 0.5), "mid-clip sustain level 0.5");
        CHECK(v.state == EnvelopeRuntimeVoiceState::Active, "sustaining voice is Active");
    }
}

static void testQueryDuringReleaseKeepsVoice() {
    auto pat = makePattern(150, 9, 1920, { makeNote(1, 0, 960, 60) });  // [0,960), release 384
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(160, 4, 150, 0, 1920) };
    std::vector<Clip> clips;

    EnvelopeControllerRuntime rt(makeDef(EnvelopeTriggerEvents::Notes));
    rt.updateForQuery(clips, blocks, patterns, 4, /*queryTick*/960 + 192, kBpm, kSr);  // 100 ms into release
    CHECK(rt.voiceCount() == 1, "query during release keeps the voice");
    if (rt.voiceCount() == 1) {
        const auto& v = rt.voices().begin()->second;
        CHECK(v.currentPhase == EnvelopeAhdsrPhase::Release, "voice is releasing");
        CHECK(v.state == EnvelopeRuntimeVoiceState::Releasing, "voice state Releasing");
        CHECK(approx(v.currentLevel, 0.25), "release halfway from 0.5 → 0.25");
    }
}

static void testQueryAfterReleaseCleansUp() {
    auto pat = makePattern(151, 9, 1920, { makeNote(1, 0, 960, 60) });  // release ends 960+384
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(161, 4, 151, 0, 1920) };
    std::vector<Clip> clips;

    EnvelopeControllerRuntime rt(makeDef(EnvelopeTriggerEvents::Notes));
    // First an active query so the voice exists in the map…
    rt.updateForQuery(clips, blocks, patterns, 4, /*queryTick*/480, kBpm, kSr);
    CHECK(rt.voiceCount() == 1, "voice present mid-note");
    // …then a query past the release tail must clean it up.
    rt.updateForQuery(clips, blocks, patterns, 4, /*queryTick*/960 + 384 + 50, kBpm, kSr);
    CHECK(rt.voiceCount() == 0, "query after release cleans up the finished voice");
}

static void testMaxVoicesEnforced() {
    auto pat = makePattern(170, 9, 1920, {
        makeNote(1, 0, 960, 60), makeNote(2, 0, 960, 62), makeNote(3, 0, 960, 64),
        makeNote(4, 0, 960, 65), makeNote(5, 0, 960, 67),
    });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(180, 4, 170, 0, 1920) };
    std::vector<Clip> clips;

    EnvelopeControllerRuntime rt(makeDef(EnvelopeTriggerEvents::Notes, /*maxVoices*/2));
    rt.updateForQuery(clips, blocks, patterns, 4, /*queryTick*/480, kBpm, kSr);
    CHECK(rt.voiceCount() == 2, "maxVoices=2 caps a 5-note chord to 2 voices");

    // Deterministic: same inputs → identical surviving key set across runs.
    EnvelopeControllerRuntime rt2(makeDef(EnvelopeTriggerEvents::Notes, /*maxVoices*/2));
    rt2.updateForQuery(clips, blocks, patterns, 4, 480, kBpm, kSr);
    bool sameKeys = rt.voiceCount() == rt2.voiceCount();
    auto it1 = rt.voices().begin();
    auto it2 = rt2.voices().begin();
    for (; sameKeys && it1 != rt.voices().end(); ++it1, ++it2)
        sameKeys = (it1->first == it2->first);
    CHECK(sameKeys, "maxVoices steal policy is deterministic");
}

static void testNoVoiceCombination() {
    // Chord voices must each carry their OWN independent level — not a sum/avg.
    auto pat = makePattern(190, 9, 1920, {
        makeNote(1, 0, 960, 60), makeNote(2, 0, 960, 64), makeNote(3, 0, 960, 67),
    });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(200, 4, 190, 0, 1920) };
    std::vector<Clip> clips;

    EnvelopeControllerRuntime rt(makeDef(EnvelopeTriggerEvents::Notes));
    rt.updateForQuery(clips, blocks, patterns, 4, /*queryTick*/480, kBpm, kSr);  // sustain
    CHECK(rt.voiceCount() == 3, "three independent voices");
    for (const auto& kv : rt.voices()) {
        // Each voice is at sustain 0.5 — identical shape, NOT summed to 1.5.
        CHECK(approx(kv.second.currentLevel, 0.5), "each voice carries its own (uncombined) 0.5 level");
    }
}

// ─── EnvelopeTrackRuntime tests ───────────────────────────────────────────────

static void testTrackRuntimeNoEnvelopeNodesNoVoices() {
    // A track whose parsed graphState has no envelope nodes (e.g. a chain-mode
    // track the caller never feeds, or a graph with only effects) holds no
    // controllers and produces no voices.
    auto g = graphWith({ makeNode("fx-1", "effect", {{"effectInstanceId", "x"}}) });
    auto defs = parseEnvelopeControllerDefinitions(g);
    EnvelopeTrackRuntime track;
    track.updateDefinitions(defs);
    CHECK(track.empty(), "no envelope nodes → no controllers");

    std::vector<Clip> clips = { makeClip(1, 4, 0, 0, 1920) };
    std::vector<Pattern> patterns; std::vector<PatternBlock> blocks;
    track.evaluateAtPosition(clips, blocks, patterns, 4, 480, kBpm, kSr);
    CHECK(track.empty(), "evaluating an empty track runtime stays empty (no voices activated)");
}

static void testChangingDefinitionsResetsStaleVoices() {
    auto pat = makePattern(210, 9, 1920, { makeNote(1, 0, 960, 60) });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(220, 4, 210, 0, 1920) };
    std::vector<Clip> clips;

    EnvelopeTrackRuntime track;
    track.updateDefinitions({ makeDef(EnvelopeTriggerEvents::Notes) });
    track.evaluateAtPosition(clips, blocks, patterns, 4, 480, kBpm, kSr);
    CHECK(track.controllerCount() == 1, "one controller present");
    CHECK(track.controllers().at("env-1").voiceCount() == 1, "controller has a live voice");

    // Change the definition shape for the same node id → controller resets, stale
    // voice dropped until re-evaluated.
    EnvelopeControllerDefinition changed = makeDef(EnvelopeTriggerEvents::Notes);
    changed.settings.attackMs = 5.0;   // different shape
    track.updateDefinitions({ changed });
    CHECK(track.controllers().at("env-1").voiceCount() == 0,
          "changed definition resets the controller's stale voices");

    // Removing the controller entirely drops it.
    track.updateDefinitions({});
    CHECK(track.empty(), "removed controller is dropped");
}

static void testUnchangedDefinitionKeepsVoices() {
    auto pat = makePattern(230, 9, 1920, { makeNote(1, 0, 960, 60) });
    std::vector<Pattern> patterns = { pat };
    std::vector<PatternBlock> blocks = { makeBlock(240, 4, 230, 0, 1920) };
    std::vector<Clip> clips;

    EnvelopeTrackRuntime track;
    track.updateDefinitions({ makeDef(EnvelopeTriggerEvents::Notes) });
    track.evaluateAtPosition(clips, blocks, patterns, 4, 480, kBpm, kSr);
    CHECK(track.controllers().at("env-1").voiceCount() == 1, "voice present");

    // Re-applying an identical definition must NOT reset live voices.
    track.updateDefinitions({ makeDef(EnvelopeTriggerEvents::Notes) });
    CHECK(track.controllers().at("env-1").voiceCount() == 1,
          "unchanged definition carries live voices forward");
}

// ─── Main ──────────────────────────────────────────────────────────────────

int main() {
    std::cout << "Running EVC.5 envelope runtime binding tests...\n";

    // Parser
    testParsesOneValidNode();
    testIgnoresNonEnvelopeNodes();
    testIgnoresMalformedNodesSafely();
    testRepairsMalformedAhdsr();
    testRepairsInvalidTriggerSourceEvents();
    testRepairsInvalidVoiceMode();
    testClampsMaxVoices();
    testIgnoresUnsupportedTargetKind();
    testIgnoresUnsupportedTriggerSourceKind();
    testDoesNotRequireEffectInstanceId();
    testDoesNotParseGraphParameterTarget();

    // Runtime voice binding
    testOneNoteCreatesOneVoice();
    testChordCreatesMultipleVoices();
    testOverlappingClipsMultipleVoices();
    testLoopIterationsDistinctVoices();
    testNotesOnlyIgnoresClips();
    testClipsOnlyIgnoresNotes();
    testNotesAndClipsIncludesBoth();
    testMidNoteReconstructsActiveVoice();
    testMidClipReconstructsActiveVoice();
    testQueryDuringReleaseKeepsVoice();
    testQueryAfterReleaseCleansUp();
    testMaxVoicesEnforced();
    testNoVoiceCombination();

    // Track runtime / definition sync
    testTrackRuntimeNoEnvelopeNodesNoVoices();
    testChangingDefinitionsResetsStaleVoices();
    testUnchangedDefinitionKeepsVoices();

    std::cout << "\nPassed: " << g_passed << "   Failed: " << g_failed << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cerr << "TESTS FAILED\n";
    return 1;
}
