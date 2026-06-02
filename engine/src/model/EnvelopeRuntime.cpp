#include "EnvelopeRuntime.h"

#include <algorithm>
#include <cmath>
#include <utility>

// EnvelopeRuntime — engine-side Envelope definition parsing + per-voice runtime
// binding (EVC.5). See EnvelopeRuntime.h for the design contract. All AHDSR math
// is reused from EVC.4b (EnvelopeAhdsr / EnvelopeVoiceEvents) — nothing is
// duplicated here, and the EVC.4 live-trigger enumeration is untouched.

namespace {

// JSON access helpers — tolerant of missing/wrong-typed fields, never throw.

bool jsonIsObject(const nlohmann::json& j) { return j.is_object(); }

// Reads a finite number field; returns `dflt` when missing/non-numeric/non-finite.
double jsonNumber(const nlohmann::json& obj, const char* key, double dflt) {
    if (!obj.is_object()) return dflt;
    auto it = obj.find(key);
    if (it == obj.end() || !it->is_number()) return dflt;
    const double v = it->get<double>();
    return std::isfinite(v) ? v : dflt;
}

bool jsonBool(const nlohmann::json& obj, const char* key, bool dflt) {
    if (!obj.is_object()) return dflt;
    auto it = obj.find(key);
    if (it == obj.end() || !it->is_boolean()) return dflt;
    return it->get<bool>();
}

std::string jsonString(const nlohmann::json& obj, const char* key, const std::string& dflt) {
    if (!obj.is_object()) return dflt;
    auto it = obj.find(key);
    if (it == obj.end() || !it->is_string()) return dflt;
    return it->get<std::string>();
}

// Returns a const pointer to a nested object field, or nullptr when absent/non-object.
const nlohmann::json* jsonObjectField(const nlohmann::json& obj, const char* key) {
    if (!obj.is_object()) return nullptr;
    auto it = obj.find(key);
    if (it == obj.end() || !it->is_object()) return nullptr;
    return &(*it);
}

// Reads "kind" from a sub-object. Returns true with `out` set when the field is a
// present string; false when the sub-object or kind is absent (caller defaults).
bool jsonKind(const nlohmann::json* subObj, std::string& out) {
    if (subObj == nullptr || !subObj->is_object()) return false;
    auto it = subObj->find("kind");
    if (it == subObj->end() || !it->is_string()) return false;
    out = it->get<std::string>();
    return true;
}

}  // namespace

// ─── Parsing ──────────────────────────────────────────────────────────────────

std::vector<EnvelopeControllerDefinition>
parseEnvelopeControllerDefinitions(const nlohmann::json& graphState) {
    std::vector<EnvelopeControllerDefinition> out;
    if (!jsonIsObject(graphState)) return out;

    auto nodesIt = graphState.find("nodes");
    if (nodesIt == graphState.end() || !nodesIt->is_array()) return out;

    for (const nlohmann::json& node : *nodesIt) {
        if (!node.is_object()) continue;  // malformed node — skip safely

        // type === "envelope" gate.
        auto typeIt = node.find("type");
        if (typeIt == node.end() || !typeIt->is_string()) continue;
        if (typeIt->get<std::string>() != "envelope") continue;

        // node id is the controller identity; skip nodes without a usable id.
        auto idIt = node.find("id");
        if (idIt == node.end() || !idIt->is_string() || idIt->get<std::string>().empty())
            continue;

        const nlohmann::json* data = jsonObjectField(node, "data");
        // A typeless/missing data object → defaults (the renderer always writes data,
        // but tolerate omission). Use an empty object so the helpers return defaults.
        const nlohmann::json emptyObj = nlohmann::json::object();
        const nlohmann::json& d = data ? *data : emptyObj;

        // target.kind: ignore the node entirely if an explicit unsupported kind is
        // present (never a GraphParameterTarget). Missing → voiceGain default.
        {
            std::string kind;
            if (jsonKind(jsonObjectField(d, "target"), kind) && kind != "voiceGain")
                continue;  // unsupported target — ignore this node
        }

        // triggerSource.kind: ignore the node if an explicit unsupported kind is
        // present. Missing → parentTrack default.
        const nlohmann::json* trigger = jsonObjectField(d, "triggerSource");
        {
            std::string kind;
            if (jsonKind(trigger, kind) && kind != "parentTrack")
                continue;  // unsupported trigger source — ignore this node
        }

        EnvelopeControllerDefinition def;
        def.nodeId = idIt->get<std::string>();

        const std::string label = jsonString(d, "label", "Envelope");
        // label trim/empty repair (matches normalizeEnvelopeLabel).
        std::string trimmed = label;
        const auto first = trimmed.find_first_not_of(" \t\r\n");
        const auto last  = trimmed.find_last_not_of(" \t\r\n");
        trimmed = (first == std::string::npos) ? std::string() : trimmed.substr(first, last - first + 1);
        def.label = trimmed.empty() ? "Envelope" : trimmed;

        // AHDSR — read raw, then defensively normalize via EVC.4b normalized().
        EnvelopeAhdsrSettings raw;
        raw.attackMs       = jsonNumber(d, "attackMs",       10.0);
        raw.holdMs         = jsonNumber(d, "holdMs",          0.0);
        raw.decayMs        = jsonNumber(d, "decayMs",       120.0);
        raw.sustain        = jsonNumber(d, "sustain",         0.7);
        raw.releaseMs      = jsonNumber(d, "releaseMs",     200.0);
        raw.attackTension  = jsonNumber(d, "attackTension",   0.0);
        raw.decayTension   = jsonNumber(d, "decayTension",    0.0);
        raw.releaseTension = jsonNumber(d, "releaseTension",  0.0);
        raw.amount         = jsonNumber(d, "amount",          1.0);
        def.settings = raw.normalized();

        def.voiceMode = stringToEnvelopeVoiceMode(jsonString(d, "voiceMode", "poly"));

        // maxVoices: round + clamp 1..32 (matches normalizeEnvelopeMaxVoices).
        {
            const double rawMax = jsonNumber(d, "maxVoices", 32.0);
            long rounded = std::lround(rawMax);
            if (rounded < 1)  rounded = 1;
            if (rounded > 32) rounded = 32;
            def.maxVoices = static_cast<int>(rounded);
        }

        // triggerSource.events: repairs to notesAndClips unless notes/clips.
        {
            const std::string events = trigger ? jsonString(*trigger, "events", "notesAndClips")
                                               : "notesAndClips";
            def.triggerEvents = stringToEnvelopeTriggerEvents(events);
        }

        def.target = EnvelopeTargetKind::VoiceGain;

        // monophonic (inert): legato bool, glideMs finite >= 0.
        if (const nlohmann::json* mono = jsonObjectField(d, "monophonic")) {
            def.monophonic.legato  = jsonBool(*mono, "legato", false);
            const double glide = jsonNumber(*mono, "glideMs", 0.0);
            def.monophonic.glideMs = glide < 0.0 ? 0.0 : glide;
        }

        out.push_back(std::move(def));
    }

    return out;
}

// ─── Per-controller runtime binding ───────────────────────────────────────────

namespace {

// Builds a runtime voice from a reconstructed EVC.4b voice state.
EnvelopeRuntimeVoice makeRuntimeVoice(const std::string&                 nodeId,
                                      const EnvelopeReconstructedVoice&  rv) {
    EnvelopeRuntimeVoice v;
    v.controllerNodeId = nodeId;
    v.key              = rv.key;
    v.sourceKind       = rv.sourceKind;
    v.onsetTick        = rv.onsetTick;
    v.gateEndTick      = rv.gateEndTick;
    v.currentPhase     = rv.env.phase;
    v.currentLevel     = rv.env.normalizedLevel;
    v.state            = envelopeRuntimeStateForPhase(rv.env.phase);
    v.pitch            = rv.pitch;
    v.velocity         = rv.velocity;
    return v;
}

}  // namespace

void EnvelopeControllerRuntime::updateForQuery(
    const std::vector<Clip>&         clips,
    const std::vector<PatternBlock>& blocks,
    const std::vector<Pattern>&      patterns,
    int                              parentTrackId,
    int64_t                          queryTick,
    double                           bpm,
    double                           sampleRate) {

    const EnvelopeAhdsrSettings settings = definition_.settings.normalized();
    const int64_t tail = envelopeReconstructionTailTicks(settings, bpm);

    // A point query window [queryTick, queryTick+1): the seek position. The
    // *ForReconstruction enumerators widen backward internally to admit
    // held/releasing occurrences whose onset is in the past.
    const EnvelopeQueryWindow window{queryTick, queryTick + 1};

    const std::vector<EnvelopeVoiceEvent> events =
        enumerateEnvelopeVoiceOccurrencesForReconstruction(
            clips, blocks, patterns, parentTrackId,
            definition_.triggerEvents, window, bpm, sampleRate, tail);

    // Reconstruct every occurrence (including Off) so we can both refresh live
    // voices and detect finished ones for cleanup.
    const std::vector<EnvelopeReconstructedVoice> reconstructed =
        reconstructEnvelopeVoiceStates(events, settings, queryTick, bpm);

    // Rebuild the live voice map: keep only active/releasing occurrences, each as
    // an independent voice (never combined). Off occurrences are cleaned up by
    // virtue of not being re-inserted.
    std::map<EnvelopeVoiceOccurrenceKey, EnvelopeRuntimeVoice> next;
    for (const EnvelopeReconstructedVoice& rv : reconstructed) {
        if (!rv.env.active) continue;  // Off → drop (cleanup)
        next.emplace(rv.key, makeRuntimeVoice(definition_.nodeId, rv));
    }

    // Enforce maxVoices with a deterministic steal policy:
    //   1. (Off voices are already excluded above.)
    //   2. Oldest releasing voice (smallest onsetTick, then key order).
    //   3. Oldest active voice (smallest onsetTick, then key order).
    const std::size_t cap =
        static_cast<std::size_t>(definition_.maxVoices < 1 ? 1 : definition_.maxVoices);
    while (next.size() > cap) {
        // Find a victim: prefer a releasing voice, else an active voice, choosing
        // the oldest (smallest onsetTick; std::map key order breaks ties).
        const EnvelopeVoiceOccurrenceKey* victim = nullptr;
        int64_t victimOnset = 0;
        bool    victimReleasing = false;

        for (const auto& kv : next) {
            const EnvelopeRuntimeVoice& v = kv.second;
            const bool releasing = v.state == EnvelopeRuntimeVoiceState::Releasing;
            if (victim == nullptr) {
                victim = &kv.first; victimOnset = v.onsetTick; victimReleasing = releasing;
                continue;
            }
            // Prefer releasing over active; within the same class, prefer older onset.
            if (releasing != victimReleasing) {
                if (releasing) { victim = &kv.first; victimOnset = v.onsetTick; victimReleasing = true; }
                continue;
            }
            if (v.onsetTick < victimOnset) {
                victim = &kv.first; victimOnset = v.onsetTick;
            }
            // Same onset → std::map iteration order (key <) already deterministic;
            // the first encountered (lowest key) is kept as victim.
        }
        if (victim == nullptr) break;
        next.erase(*victim);
    }

    voices_ = std::move(next);
}

// ─── Per-track runtime ────────────────────────────────────────────────────────

void EnvelopeTrackRuntime::updateDefinitions(
    const std::vector<EnvelopeControllerDefinition>& definitions) {

    // Build the incoming id set; add/replace controllers.
    std::map<std::string, EnvelopeControllerRuntime> next;
    for (const EnvelopeControllerDefinition& def : definitions) {
        auto existing = controllers_.find(def.nodeId);
        if (existing != controllers_.end()
            && existing->second.definition().sameShape(def)
            && existing->second.definition().nodeId == def.nodeId) {
            // Unchanged definition → carry forward existing runtime voices.
            next.emplace(def.nodeId, std::move(existing->second));
        } else {
            // New or changed definition → fresh controller (no stale voices).
            next.emplace(def.nodeId, EnvelopeControllerRuntime(def));
        }
    }
    // Controllers absent from `definitions` are dropped (their voices reset).
    controllers_ = std::move(next);
}

void EnvelopeTrackRuntime::evaluateAtPosition(
    const std::vector<Clip>&         clips,
    const std::vector<PatternBlock>& blocks,
    const std::vector<Pattern>&      patterns,
    int                              parentTrackId,
    int64_t                          queryTick,
    double                           bpm,
    double                           sampleRate) {
    for (auto& kv : controllers_) {
        kv.second.updateForQuery(clips, blocks, patterns, parentTrackId,
                                 queryTick, bpm, sampleRate);
    }
}
