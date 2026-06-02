// test_envelope_voice_gain.cpp
// Unit tests for the EVC.6 per-voice gain application primitives — the first
// *audible* Envelope Controller phase.
//
// Audit: docs/dev/fxgraph-envelope-controller-architecture-audit.md (§7, §11)
// Model: engine/src/model/EnvelopeRuntime.h (envelopeVoiceGainSettings,
//        envelopeVoiceGainMultiplier, envelopeTriggerAffectsSource),
//        engine/src/model/EnvelopeAhdsr.h (evaluateEnvelopeAhdsr)
//
// These tests are pure and fast — they build EnvelopeControllerDefinition structs
// (and a little graphState JSON) directly and assert the per-voice gain MULTIPLIER
// the engine applies to note voices (Sampler) and clip voices (MixEngine). They do
// not render audio: the Sampler/MixEngine wiring multiplies exactly this factor
// into existing per-voice gain, so proving the factor proves the audible behavior.
//
// Build target: test_envelope_voice_gain (engine/CMakeLists.txt)
// Pure C++, model-only — links solely against XlethEngineModel.
// Pass: prints "ALL TESTS PASSED" and exits 0.

#include "model/EnvelopeRuntime.h"

#include <nlohmann/json.hpp>

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

static bool approx(double a, double b, double eps = 1e-6) {
    return (a - b <= eps) && (b - a <= eps);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Linear AHDSR helper. attack/decay/release ms, sustain, amount.
static EnvelopeAhdsrSettings settings(double attackMs, double decayMs,
                                      double sustain, double releaseMs,
                                      double amount = 1.0) {
    EnvelopeAhdsrSettings s;
    s.attackMs = attackMs; s.holdMs = 0; s.decayMs = decayMs;
    s.sustain = sustain; s.releaseMs = releaseMs;
    s.attackTension = 0; s.decayTension = 0; s.releaseTension = 0;
    s.amount = amount;
    return s;
}

static EnvelopeControllerDefinition makeDef(const std::string& id,
                                            EnvelopeTriggerEvents ev,
                                            EnvelopeAhdsrSettings s) {
    EnvelopeControllerDefinition d;
    d.nodeId = id;
    d.label = "Env";
    d.settings = s;
    d.voiceMode = EnvelopeVoiceMode::Poly;
    d.maxVoices = 32;
    d.triggerEvents = ev;
    d.target = EnvelopeTargetKind::VoiceGain;
    return d;
}

static constexpr auto kNote = EnvelopeVoiceSourceKind::PatternNote;
static constexpr auto kClip = EnvelopeVoiceSourceKind::TimelineClip;

// ─── No-op / transparency ──────────────────────────────────────────────────────

static void testNoDefinitionsIsTransparent() {
    std::vector<EnvelopeControllerDefinition> none;
    CHECK(approx(envelopeVoiceGainMultiplier(none, kNote, 50, 1000), 1.0),
          "no controllers → gain 1.0 (transparent no-op) for notes");
    CHECK(approx(envelopeVoiceGainMultiplier(none, kClip, 50, 1000), 1.0),
          "no controllers → gain 1.0 (transparent no-op) for clips");
}

// ─── Trigger-source filtering ──────────────────────────────────────────────────

static void testNotesTriggerAffectsNotesOnly() {
    // sustain 0.5, attack 0 → held level = 0.5 immediately.
    auto defs = std::vector<EnvelopeControllerDefinition>{
        makeDef("n", EnvelopeTriggerEvents::Notes, settings(0, 0, 0.5, 100)) };
    CHECK(approx(envelopeVoiceGainMultiplier(defs, kNote, 10, 1000), 0.5),
          "Notes controller shapes note voices");
    CHECK(approx(envelopeVoiceGainMultiplier(defs, kClip, 10, 1000), 1.0),
          "Notes controller leaves clip voices untouched");
}

static void testClipsTriggerAffectsClipsOnly() {
    auto defs = std::vector<EnvelopeControllerDefinition>{
        makeDef("c", EnvelopeTriggerEvents::Clips, settings(0, 0, 0.5, 100)) };
    CHECK(approx(envelopeVoiceGainMultiplier(defs, kClip, 10, 1000), 0.5),
          "Clips controller shapes clip voices");
    CHECK(approx(envelopeVoiceGainMultiplier(defs, kNote, 10, 1000), 1.0),
          "Clips controller leaves note voices untouched");
}

static void testNotesAndClipsAffectsBoth() {
    auto defs = std::vector<EnvelopeControllerDefinition>{
        makeDef("b", EnvelopeTriggerEvents::NotesAndClips, settings(0, 0, 0.5, 100)) };
    CHECK(approx(envelopeVoiceGainMultiplier(defs, kNote, 10, 1000), 0.5),
          "NotesAndClips shapes note voices");
    CHECK(approx(envelopeVoiceGainMultiplier(defs, kClip, 10, 1000), 0.5),
          "NotesAndClips shapes clip voices");
}

// ─── Multiple controllers multiply ─────────────────────────────────────────────

static void testMultipleControllersMultiply() {
    // Two controllers, both holding at 0.5 → product 0.25.
    auto defs = std::vector<EnvelopeControllerDefinition>{
        makeDef("a", EnvelopeTriggerEvents::Notes, settings(0, 0, 0.5, 100)),
        makeDef("b", EnvelopeTriggerEvents::Notes, settings(0, 0, 0.5, 100)) };
    CHECK(approx(envelopeVoiceGainMultiplier(defs, kNote, 10, 1000), 0.25),
          "two note controllers multiply (0.5 * 0.5)");
}

static void testMixedTriggerControllersFilterPerSource() {
    // One note-only (0.5) + one clip-only (0.25). Notes see 0.5, clips see 0.25.
    auto defs = std::vector<EnvelopeControllerDefinition>{
        makeDef("n", EnvelopeTriggerEvents::Notes, settings(0, 0, 0.5, 100)),
        makeDef("c", EnvelopeTriggerEvents::Clips, settings(0, 0, 0.25, 100)) };
    CHECK(approx(envelopeVoiceGainMultiplier(defs, kNote, 10, 1000), 0.5),
          "note voice only multiplies the Notes controller");
    CHECK(approx(envelopeVoiceGainMultiplier(defs, kClip, 10, 1000), 0.25),
          "clip voice only multiplies the Clips controller");
}

// ─── amount is included exactly once ───────────────────────────────────────────

static void testAmountAppliedOnceNotDoubled() {
    // sustain 1.0, amount 0.5, attack 0 → held level = 1.0 * 0.5 = 0.5.
    auto defs = std::vector<EnvelopeControllerDefinition>{
        makeDef("a", EnvelopeTriggerEvents::Notes, settings(0, 0, 1.0, 100, 0.5)) };
    const double g = envelopeVoiceGainMultiplier(defs, kNote, 10, 1000);
    CHECK(approx(g, 0.5), "amount scales the level exactly once (no double-apply)");

    // Equals the raw EVC.4b evaluator level (the single source of the curve).
    const auto st = evaluateEnvelopeAhdsr(settings(0, 0, 1.0, 100, 0.5), 10, 1000);
    CHECK(approx(g, st.normalizedLevel), "multiplier equals evaluateEnvelopeAhdsr level");
}

// ─── Per-voice independence (no cross-voice combination) ───────────────────────

static void testIndependentElapsedNoSharedState() {
    // 100ms linear attack, sustain 1. Two "voices" at different elapsed times get
    // independent levels — the helper holds no state, so nothing combines.
    auto defs = std::vector<EnvelopeControllerDefinition>{
        makeDef("a", EnvelopeTriggerEvents::Notes, settings(100, 0, 1.0, 100)) };
    const double gEarly = envelopeVoiceGainMultiplier(defs, kNote, 25, 1000);  // 0.25
    const double gLate  = envelopeVoiceGainMultiplier(defs, kNote, 75, 1000);  // 0.75
    CHECK(approx(gEarly, 0.25), "voice at 25ms attack → 0.25");
    CHECK(approx(gLate,  0.75), "voice at 75ms attack → 0.75");
    // Re-querying the earlier voice still returns its own value (no accumulation).
    CHECK(approx(envelopeVoiceGainMultiplier(defs, kNote, 25, 1000), 0.25),
          "re-query is stable — no shared/accumulated state across voices");
}

// ─── Gate / release behavior (mid-clip position-pure) ──────────────────────────

static void testHeldVsReleaseLevels() {
    // attack 0, sustain 0.8, release 100ms. gate = 200ms.
    auto defs = std::vector<EnvelopeControllerDefinition>{
        makeDef("a", EnvelopeTriggerEvents::Clips, settings(0, 0, 0.8, 100)) };
    // Inside the gate → sustained at 0.8.
    CHECK(approx(envelopeVoiceGainMultiplier(defs, kClip, 100, 200), 0.8),
          "mid-gate (held) level = sustain (position-pure, seek-correct)");
    // Half-way through release (elapsed 250, gate 200, release 100 → frac 0.5)
    // → 0.8 * (1 - 0.5) = 0.4.
    CHECK(approx(envelopeVoiceGainMultiplier(defs, kClip, 250, 200), 0.4),
          "half-way through release → half of the gate-end level");
    // After the release tail → 0 (voice fully faded).
    CHECK(approx(envelopeVoiceGainMultiplier(defs, kClip, 400, 200), 0.0),
          "after release tail → 0");
}

// ─── envelopeVoiceGainSettings filtering (the Sampler hand-off form) ───────────

static void testGainSettingsFilterBySource() {
    auto defs = std::vector<EnvelopeControllerDefinition>{
        makeDef("n",  EnvelopeTriggerEvents::Notes,         settings(0, 0, 0.5, 100)),
        makeDef("c",  EnvelopeTriggerEvents::Clips,         settings(0, 0, 0.5, 100)),
        makeDef("nc", EnvelopeTriggerEvents::NotesAndClips, settings(0, 0, 0.5, 100)) };
    CHECK(envelopeVoiceGainSettings(defs, kNote).size() == 2,
          "note settings = Notes + NotesAndClips");
    CHECK(envelopeVoiceGainSettings(defs, kClip).size() == 2,
          "clip settings = Clips + NotesAndClips");
}

// ─── Parse → apply integration (end-to-end from graphState) ────────────────────

static nlohmann::json envNode(const std::string& id, const std::string& events) {
    nlohmann::json data = {
        {"label", "Env"},
        {"attackMs", 0}, {"holdMs", 0}, {"decayMs", 0},
        {"sustain", 0.5}, {"releaseMs", 100},
        {"amount", 1},
        {"voiceMode", "poly"}, {"maxVoices", 32},
        {"triggerSource", {{"kind", "parentTrack"}, {"events", events}}},
        {"target", {{"kind", "voiceGain"}}},
    };
    nlohmann::json n;
    n["id"] = id; n["type"] = "envelope"; n["data"] = std::move(data);
    return n;
}

static void testParsedGraphStateDrivesGain() {
    nlohmann::json g;
    g["nodes"] = nlohmann::json::array();
    g["nodes"].push_back(envNode("env-notes", "notes"));

    auto defs = parseEnvelopeControllerDefinitions(g);
    CHECK(defs.size() == 1, "graphState parses one note envelope");
    // Notes envelope shapes notes (0.5), not clips (1.0) — proves the full path:
    // graphState → parse → filter → multiplier.
    CHECK(approx(envelopeVoiceGainMultiplier(defs, kNote, 10, 1000), 0.5),
          "parsed notes envelope shapes note voices");
    CHECK(approx(envelopeVoiceGainMultiplier(defs, kClip, 10, 1000), 1.0),
          "parsed notes envelope leaves clip voices untouched");
}

static void testUnsupportedTargetNeverApplies() {
    // A node whose target.kind is not voiceGain is dropped by the parser, so it
    // can never apply any gain (never a GraphParameterTarget / plugin parameter).
    nlohmann::json bad = envNode("env-bad", "notes");
    bad["data"]["target"]["kind"] = "pluginParameter";
    nlohmann::json g;
    g["nodes"] = nlohmann::json::array();
    g["nodes"].push_back(bad);
    auto defs = parseEnvelopeControllerDefinitions(g);
    CHECK(defs.empty(), "unsupported target.kind → no definition");
    CHECK(approx(envelopeVoiceGainMultiplier(defs, kNote, 10, 1000), 1.0),
          "unsupported target applies no gain");
}

// ─── main ───────────────────────────────────────────────────────────────────

int main() {
    std::cout << "Running EVC.6 per-voice gain tests...\n";

    testNoDefinitionsIsTransparent();
    testNotesTriggerAffectsNotesOnly();
    testClipsTriggerAffectsClipsOnly();
    testNotesAndClipsAffectsBoth();
    testMultipleControllersMultiply();
    testMixedTriggerControllersFilterPerSource();
    testAmountAppliedOnceNotDoubled();
    testIndependentElapsedNoSharedState();
    testHeldVsReleaseLevels();
    testGainSettingsFilterBySource();
    testParsedGraphStateDrivesGain();
    testUnsupportedTargetNeverApplies();

    std::cout << "\nPassed: " << g_passed << "   Failed: " << g_failed << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cerr << "TESTS FAILED\n";
    return 1;
}
