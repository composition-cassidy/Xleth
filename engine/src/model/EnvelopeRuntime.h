#pragma once
// EnvelopeRuntime — engine-side Envelope Controller definition parsing + per-voice
// runtime state binding (EVC.5).
//
// Audit: docs/dev/fxgraph-envelope-controller-architecture-audit.md (EVC.1 §3–§7).
//
// This is the engine-side *runtime binding* phase of the per-voice Envelope
// Controller. It sits on top of the pure EVC.4 occurrence enumeration and the
// EVC.4b closed-form AHDSR evaluator/reconstruction model, and adds:
//
//   1. graphState parsing — extract Envelope node *definitions* from a track's
//      opaque graphState JSON into engine-side EnvelopeControllerDefinition
//      structs (EnvelopeAhdsrSettings + voice/trigger/target descriptors).
//   2. per-voice runtime binding — bind EnvelopeVoiceEvent occurrences to
//      independent runtime voice states, evaluated through the EVC.4b evaluator,
//      with maxVoices enforcement and deterministic cleanup of finished voices.
//
// It is intentionally:
//
//   • Non-audible — it evaluates levels only. It applies NO per-voice gain, drives
//     NO Sampler voice, touches NO clip gain, and is never called from audio
//     rendering. EVC.6 adds the per-voice gain target application.
//   • Engine-internal — definitions/runtime voices are never exposed to the
//     renderer/IPC and are never serialized back into graphState. The engine
//     parses graphState read-only; it never mutates it.
//   • Reusing EVC.4b — all AHDSR math comes from the EVC.4b evaluator and the
//     *ForReconstruction enumerators; this layer duplicates none of it and does
//     NOT change the EVC.4 live-trigger enumeration semantics.
//
// graphState ownership rules (EVC.0/EVC.2): an Envelope node is a per-voice
// controller, NOT a GraphParameterTarget edge and NOT a plugin-parameter
// modulation source. v1 supports exactly one target (voiceGain) and one trigger
// source kind (parentTrack); the parent track id comes from the owning track
// context, never stored redundantly on the node. Definitions are only meaningful
// for tracks whose fxMode === graph — the caller gates on that (this layer does
// not read TrackInfo).

#include "EnvelopeAhdsr.h"
#include "EnvelopeVoiceEvents.h"
#include "TimelineTypes.h"

#include <nlohmann/json.hpp>

#include <cstdint>
#include <map>
#include <string>
#include <vector>

// ─── EnvelopeVoiceMode ────────────────────────────────────────────────────────
// Mirrors graphState `voiceMode` (EVC.2). Poly is the default and the only path
// exercised by the runtime; Mono is stored but inert (a later option that must
// not shape the architecture).

enum class EnvelopeVoiceMode : int {
    Poly = 0,
    Mono = 1,
};

inline std::string envelopeVoiceModeToString(EnvelopeVoiceMode m) {
    return m == EnvelopeVoiceMode::Mono ? "mono" : "poly";
}

// Repairs to poly unless exactly "mono" (matches graphState normalizeEnvelopeVoiceMode).
inline EnvelopeVoiceMode stringToEnvelopeVoiceMode(const std::string& s) {
    return s == "mono" ? EnvelopeVoiceMode::Mono : EnvelopeVoiceMode::Poly;
}

// ─── EnvelopeTargetKind ───────────────────────────────────────────────────────
// v1 supports exactly one target kind: voiceGain. This is NOT a
// GraphParameterTarget and never references a plugin parameter. Unknown target
// kinds cause the whole node to be ignored by the parser.

enum class EnvelopeTargetKind : int {
    VoiceGain = 0,
};

// ─── EnvelopeMonophonicSettings ───────────────────────────────────────────────
// Future-only knobs, parsed and stored but inert in v1 (poly is the default path).

struct EnvelopeMonophonicSettings {
    bool   legato  = false;
    double glideMs = 0.0;

    bool operator==(const EnvelopeMonophonicSettings& o) const {
        return legato == o.legato && glideMs == o.glideMs;
    }
    bool operator!=(const EnvelopeMonophonicSettings& o) const { return !(*this == o); }
};

// ─── EnvelopeControllerDefinition ─────────────────────────────────────────────
// Engine-side parsed form of one graphState Envelope node. Carries the normalized
// AHDSR curve plus the voice/trigger/target descriptors. The parent track id is
// NOT stored here — track binding comes from the owning TrackInfo/MixEngine track
// context (single-source-of-truth, matching the renderer rule). No effectInstanceId,
// no GraphParameterTarget, no exposed plugin parameter.

struct EnvelopeControllerDefinition {
    std::string                nodeId;
    std::string                label = "Envelope";
    EnvelopeAhdsrSettings      settings;                 // already normalized
    EnvelopeVoiceMode          voiceMode    = EnvelopeVoiceMode::Poly;
    int                        maxVoices    = 32;          // clamped 1..32
    EnvelopeTriggerEvents      triggerEvents = EnvelopeTriggerEvents::NotesAndClips;
    EnvelopeTargetKind         target       = EnvelopeTargetKind::VoiceGain;
    EnvelopeMonophonicSettings monophonic;                 // inert in v1

    // Value equality used to detect a definition change (so the runtime can reset
    // stale voices when the graph is edited). nodeId is the identity, so it is not
    // part of this body comparison — callers compare by nodeId first.
    bool sameShape(const EnvelopeControllerDefinition& o) const {
        const EnvelopeAhdsrSettings a = settings.normalized();
        const EnvelopeAhdsrSettings b = o.settings.normalized();
        return label == o.label
            && a.attackMs == b.attackMs && a.holdMs == b.holdMs && a.decayMs == b.decayMs
            && a.sustain == b.sustain && a.releaseMs == b.releaseMs
            && a.attackTension == b.attackTension && a.decayTension == b.decayTension
            && a.releaseTension == b.releaseTension && a.amount == b.amount
            && voiceMode == o.voiceMode && maxVoices == o.maxVoices
            && triggerEvents == o.triggerEvents && target == o.target
            && monophonic == o.monophonic;
    }
};

// ─── Parsing ──────────────────────────────────────────────────────────────────
// Extract Envelope controller definitions from a track's opaque graphState JSON.
// Pure & read-only: it never mutates graphState, never throws on malformed input,
// and never reads anything but `nodes[]` entries whose type === "envelope".
//
// Repairs/ignores (mirroring EVC.2 normalizeEnvelopeNodeData + EVC.4b normalized()):
//   • non-object / typeless / non-"envelope" nodes are skipped.
//   • ms fields finite >= 0; sustain/amount clamp 0..1; tension clamp -1..+1
//     (delegated to EnvelopeAhdsrSettings::normalized()).
//   • voiceMode repairs to poly unless "mono".
//   • maxVoices clamps to 1..32 (rounded).
//   • triggerSource.events repairs to notesAndClips unless notes/clips.
//   • target.kind: a node whose target.kind is present and != "voiceGain" is
//     IGNORED (unsupported target — never a GraphParameterTarget). Missing target
//     defaults to voiceGain (the renderer always writes it).
//   • triggerSource.kind: a node whose triggerSource.kind is present and !=
//     "parentTrack" is IGNORED (unsupported source). Missing defaults to parentTrack.
//   • nodes without an id are skipped (the runtime keys controllers by node id).
//
// Does NOT parse GraphParameterTarget, exposed parameter ports, macro automation,
// or effectChains. Never exposed to renderer/IPC.
std::vector<EnvelopeControllerDefinition>
parseEnvelopeControllerDefinitions(const nlohmann::json& graphState);

// ─── EVC.6: per-voice gain application helpers ────────────────────────────────
// EVC.6 is the first *audible* Envelope phase: it applies the per-voice Envelope
// level as an additional per-voice gain multiplier on the v1 target (voiceGain).
// The helpers below are the pure, reusable core of that application. They are used
// by MixEngine (clip voices) and, in pre-filtered form, by Sampler (note voices).
// They duplicate no AHDSR math — every level comes from the EVC.4b
// evaluateEnvelopeAhdsr evaluator. Voices stay independent: each caller passes its
// own voice's elapsed/gate, so levels are never averaged/summed/combined across
// voices — only multiplied per occurrence (audit §7, §11).

// True when a controller's triggerEvents selector applies to a given source kind:
//   Notes         → pattern-note voices only
//   Clips         → timeline-clip voices only
//   NotesAndClips → both
inline bool envelopeTriggerAffectsSource(EnvelopeTriggerEvents ev,
                                         EnvelopeVoiceSourceKind kind) {
    switch (kind) {
        case EnvelopeVoiceSourceKind::PatternNote:
            return ev == EnvelopeTriggerEvents::Notes
                || ev == EnvelopeTriggerEvents::NotesAndClips;
        case EnvelopeVoiceSourceKind::TimelineClip:
            return ev == EnvelopeTriggerEvents::Clips
                || ev == EnvelopeTriggerEvents::NotesAndClips;
    }
    return false;
}

// Returns the normalized AHDSR settings of every controller whose triggerEvents
// includes `sourceKind` (and target voiceGain — the only kind the parser keeps).
// The per-voice gain for that source is the product of evaluateEnvelopeAhdsr over
// these settings. Used to hand the note-affecting envelopes to the Sampler in a
// graphState-free form (the Sampler never sees EnvelopeControllerDefinition).
std::vector<EnvelopeAhdsrSettings> envelopeVoiceGainSettings(
    const std::vector<EnvelopeControllerDefinition>& defs,
    EnvelopeVoiceSourceKind                          sourceKind);

// Combined per-voice gain multiplier at one elapsed/gate: the product of each
// applicable controller's amount-scaled level (evaluateEnvelopeAhdsr). Returns
// 1.0 when no controller applies, so multiplying it into an existing gain stage is
// a transparent no-op. `elapsedMs` is time since the voice onset; `gateLengthMs`
// is the note/clip duration (the gate — release begins at gate end). Each level is
// already 0..1 and amount-scaled, so the product stays in 0..1 and is never
// double-amount-scaled.
double envelopeVoiceGainMultiplier(
    const std::vector<EnvelopeControllerDefinition>& defs,
    EnvelopeVoiceSourceKind                          sourceKind,
    double                                           elapsedMs,
    double                                           gateLengthMs);

// ─── EnvelopeRuntimeVoiceState ────────────────────────────────────────────────
// Coarse lifecycle of a runtime voice, derived from its AHDSR phase. Off voices
// are cleaned up (never retained in the active map).

enum class EnvelopeRuntimeVoiceState : int {
    Off       = 0,  // before onset or after the release tail
    Active    = 1,  // attack/hold/decay/sustain (gate held)
    Releasing = 2,  // in the release segment (gate ended, tail not finished)
};

inline EnvelopeRuntimeVoiceState envelopeRuntimeStateForPhase(EnvelopeAhdsrPhase p) {
    if (p == EnvelopeAhdsrPhase::Off)     return EnvelopeRuntimeVoiceState::Off;
    if (p == EnvelopeAhdsrPhase::Release) return EnvelopeRuntimeVoiceState::Releasing;
    return EnvelopeRuntimeVoiceState::Active;
}

// ─── EnvelopeRuntimeVoice ─────────────────────────────────────────────────────
// One independent per-voice runtime state, bound to a single occurrence. Voices
// are NEVER combined — there is exactly one of these per live occurrence.
// `currentLevel` is the EVC.4b amount-scaled normalized level; it is exposed to
// tests but NOT applied to any audio signal in this phase.

struct EnvelopeRuntimeVoice {
    std::string                controllerNodeId;
    EnvelopeVoiceOccurrenceKey key;
    EnvelopeVoiceSourceKind    sourceKind = EnvelopeVoiceSourceKind::PatternNote;

    int64_t onsetTick   = 0;
    int64_t gateEndTick = 0;

    EnvelopeAhdsrPhase        currentPhase = EnvelopeAhdsrPhase::Off;
    double                    currentLevel = 0.0;   // amount-scaled, NOT applied to audio
    EnvelopeRuntimeVoiceState state        = EnvelopeRuntimeVoiceState::Off;

    int   pitch    = 60;
    float velocity = 1.0f;
};

// ─── EnvelopeControllerRuntime ────────────────────────────────────────────────
// Per-controller runtime state: one definition + the live runtime voices keyed by
// occurrence. `updateForQuery` reconstructs every active/releasing occurrence at a
// transport tick (using the EVC.4b *ForReconstruction enumerators + evaluator),
// binds each to an independent runtime voice, enforces maxVoices with a
// deterministic steal policy, and removes finished (Off / no-longer-enumerated)
// voices. Polyphonic is the only path here; mono is inert.

class EnvelopeControllerRuntime {
public:
    EnvelopeControllerRuntime() = default;
    explicit EnvelopeControllerRuntime(EnvelopeControllerDefinition def)
        : definition_(std::move(def)) {}

    const EnvelopeControllerDefinition& definition() const { return definition_; }

    // Replaces the definition and clears all runtime voices (a definition edit
    // invalidates in-flight reconstructed state).
    void setDefinition(EnvelopeControllerDefinition def) {
        definition_ = std::move(def);
        voices_.clear();
    }

    // Reconstructs and binds runtime voices at `queryTick` from the parent track's
    // timeline model. Pure w.r.t. audio — evaluates levels only. `parentTrackId` is
    // the owning track id (graphState.trackId in the renderer); only that track's
    // clips/notes spawn voices.
    void updateForQuery(const std::vector<Clip>&         clips,
                        const std::vector<PatternBlock>& blocks,
                        const std::vector<Pattern>&      patterns,
                        int                              parentTrackId,
                        int64_t                          queryTick,
                        double                           bpm,
                        double                           sampleRate);

    // Live runtime voices (active or releasing), keyed by occurrence. Stable order.
    const std::map<EnvelopeVoiceOccurrenceKey, EnvelopeRuntimeVoice>& voices() const {
        return voices_;
    }
    std::size_t voiceCount() const { return voices_.size(); }

    void reset() { voices_.clear(); }

private:
    EnvelopeControllerDefinition definition_;
    std::map<EnvelopeVoiceOccurrenceKey, EnvelopeRuntimeVoice> voices_;
};

// ─── EnvelopeTrackRuntime ─────────────────────────────────────────────────────
// All Envelope controller runtimes for one track. `updateDefinitions` syncs the
// controller set to a freshly parsed definition list (adding new controllers,
// resetting changed ones, dropping removed ones). `evaluateAtPosition` advances
// every controller's per-voice runtime to a transport tick.
//
// Only construct/feed this for tracks whose fxMode === graph — the caller gates on
// that. A chain-mode track or the master should never receive definitions, so it
// holds no controllers and produces no voices.

class EnvelopeTrackRuntime {
public:
    // Sync controllers to the parsed definitions. Existing controllers keep their
    // runtime voices when the definition is unchanged; a changed definition resets
    // that controller's voices; removed controllers are dropped.
    void updateDefinitions(const std::vector<EnvelopeControllerDefinition>& definitions);

    // Advance every controller's runtime voices at `queryTick`.
    void evaluateAtPosition(const std::vector<Clip>&         clips,
                            const std::vector<PatternBlock>& blocks,
                            const std::vector<Pattern>&      patterns,
                            int                              parentTrackId,
                            int64_t                          queryTick,
                            double                           bpm,
                            double                           sampleRate);

    bool empty() const { return controllers_.empty(); }
    std::size_t controllerCount() const { return controllers_.size(); }

    // Controllers keyed by node id (stable order). Exposed for tests / EVC.6.
    const std::map<std::string, EnvelopeControllerRuntime>& controllers() const {
        return controllers_;
    }

    void reset() { controllers_.clear(); }

private:
    std::map<std::string, EnvelopeControllerRuntime> controllers_;
};
