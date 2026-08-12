#pragma once
// EnvelopeParameterModulation — pure engine-side evaluation of the FX Graph
// Envelope Controller as a graph-owned PARAMETER-MODULATION source.
//
// Direction check (read this before touching anything here). EVC-R0 retired the
// per-voice `voiceGain` Envelope Controller (EnvelopeVoiceEvents / EnvelopeAhdsr /
// EnvelopeRuntime and the Sampler/MixEngine voice-gain hooks). The revert reason was
// that the TARGET was wrong — an Envelope is a modulator of exposed effect
// parameters, not a second per-voice gain stage. It was NOT "envelope evaluation
// does not belong in the engine": the audit's central finding (§1) is the opposite,
// that evaluation must live next to the authoritative clock. This module is the
// corrected direction evaluated in the right place:
//
//   engine note/clip gates (the events MixEngine::triggerPatternNotes acts on)
//     -> ONE normalized 0..1 ADSR value per Envelope node
//     -> each Envelope->Parameter edge's MODULATION mapping,
//        value = clamp(base + depth * shaped(env))
//     -> the graph-owned effect parameter
//
// There are NO per-voice envelopes here and none may be added: overlapping
// notes/clips collapse into gate REGIONS, never summed/averaged/maxed. Nothing in
// this file knows about Sampler voices, voiceGain, spawnCounter, or maxVoices.
//
// Everything in this header is PURE and deterministic. It reads no globals, no
// transport, no Timeline, and no audio state. Two halves, split by thread:
//
//   PREPARE (message thread, allocates freely) — parse the persisted opaque
//   graphState JSON into definitions, and merge trigger intervals into an
//   immutable gate timeline.
//
//   EVALUATE (audio thread, NO allocation / NO locks / NO logging) — everything
//   taking an EnvelopeGateView or an EnvelopeShapeSamples. These only read
//   caller-owned memory and do fixed arithmetic.
//
// Semantics are a 1:1 port of the renderer evaluator they replace
// (ui/src/fxgraph/envelopeModulation.js + the modulation mapping in
// ui/src/fxgraph/graphState.js), so behavior does not change with the clock.
// Where the two could disagree, the ENGINE's note math wins — see
// buildPatternNoteGateIntervals in MixEngine (block-end note-off clamp).
//
// Stage durations are authored in MILLISECONDS and stay milliseconds. They are
// converted straight to samples (envelopeShapeToSamples) so a tempo change never
// rescales an envelope. A future tempo-synced option would add a unit
// discriminant to EnvelopeShape and resolve it in envelopeShapeToSamples with the
// live bpm — that is the ONLY place the unit domain is decided. Do not smuggle a
// bpm into the evaluators.

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include <nlohmann/json.hpp>

class Timeline;

namespace xleth::envmod {

// PPQ of the tick domain (TickTime, 960 PPQ). Gate intervals are ticks.
constexpr double kTicksPerQuarter = 960.0;

// ─── Envelope shape ──────────────────────────────────────────────────────────

// The closed, normalized Envelope node schema (mirrors normalizeEnvelopeNodeData
// in ui/src/fxgraph/graphState.js). Tension fields are deliberately absent: the
// renderer runtime and the node's own preview curve both draw straight A/H/D/S/R
// segments and explicitly do not model tension, so importing it here would make
// the engine disagree with what the user sees.
struct EnvelopeShape {
    double attackMs  = 10.0;
    double holdMs    = 0.0;
    double decayMs   = 120.0;
    double sustain   = 0.7;   // 0..1
    double releaseMs = 200.0;

    // EVC-R2-r3 — slide notes are ignored unless the node opts in.
    bool includeSlideNotes = false;
};

// The same shape with stage durations in SAMPLES. Built once per block on the
// audio thread from a live sample rate; trivially copyable, no allocation.
struct EnvelopeShapeSamples {
    double attack  = 0.0;
    double hold    = 0.0;
    double decay   = 0.0;
    double release = 0.0;
    double sustain = 0.0;
};

// Converts the authored millisecond domain to samples. This is the single place
// the unit domain is interpreted (see the header note on tempo sync).
EnvelopeShapeSamples envelopeShapeToSamples(const EnvelopeShape& shape, double sampleRate);

// Normalizes raw envelope node data. Mirrors normalizeEnvelopeNodeData exactly:
// ms fields must be finite and >= 0 (else the default), sustain clamps to 0..1
// (non-finite -> default), includeSlideNotes is true only for a literal boolean
// true. Every other field on the input — including the retired triggerSource /
// retriggerMode / voiceMode / maxVoices / monophonic / target / amount — is
// dropped by virtue of not being read.
EnvelopeShape normalizeEnvelopeShape(const nlohmann::json& rawData);

// ─── Modulation mapping (the Envelope->Parameter edge) ───────────────────────

enum class MappingCurve { Linear, Bezier };

// EVC-R4 base + signed-depth modulation mapping. `depth` is BIPOLAR (-1..+1) so a
// negative depth inverts the envelope; env == 0 yields exactly `base`, which is
// what makes a stopped or idle envelope inert instead of destructive.
// sourceMin/sourceMax window the INPUT (which part of the envelope's travel is
// used); they are not redundant with depth.
struct ModulationMapping {
    bool   enabled   = true;
    double base      = 0.0;   // 0..1
    double depth     = 1.0;   // -1..+1
    double sourceMin = 0.0;   // 0..1
    double sourceMax = 1.0;   // 0..1

    MappingCurve curve = MappingCurve::Linear;
    // Bezier control points. P0=(0,0) and P3=(1,1) are forced, so only the two
    // interior points are stored (matching normalizeBezierPoints).
    double cp1x = 0.4, cp1y = 0.0;
    double cp2x = 0.6, cp2y = 1.0;
};

// Cubic bezier with P0=(0,0), P3=(1,1), solved by 32-step binary subdivision.
// Bit-faithful port of evaluateBezierCurve. Audio-thread safe: fixed iteration
// count, no allocation, no branching on data size.
double evaluateBezierCurve(const ModulationMapping& mapping, double xTarget);

// value = clamp(base + depth * shaped(sourceWindow(env))). Returns `base` exactly
// when the shaped input is 0. A degenerate source span (sourceMin >= sourceMax)
// steps rather than dividing by zero. Audio-thread safe.
double evaluateModulationMapping(const ModulationMapping& mapping, double sourceValue);

// ─── Gate timeline ───────────────────────────────────────────────────────────

// One raw trigger gate, in absolute timeline ticks. endTick is exclusive; a
// missing/short end is a zero-length gate (endTick == startTick).
struct GateInterval {
    int64_t startTick = 0;
    int64_t endTick   = 0;
};

// A merged continuous gate region. `starts` indexes into GateTimeline::starts:
// the sorted, de-duplicated trigger onsets inside this region, so a same-tick
// chord collapses into one trigger and the latest onset before the query can be
// found for restart retriggering.
struct GateRegion {
    int64_t start       = 0;
    int64_t end         = 0;
    int     startOffset = 0;
    int     startCount  = 0;
};

// Immutable merged gate timeline for one track. Regions are sorted by start and
// non-overlapping (a gate that opens exactly when another closes begins a NEW
// region — a momentary close + reopen), which is what lets the audio thread
// binary-search it.
struct GateTimeline {
    std::vector<GateRegion> regions;
    std::vector<int64_t>    starts;
};

// PREPARE. Sorts and merges raw intervals. Two intervals join the same region
// when next.start < current.end. Intervals with a negative or unordered start
// are dropped by the caller, not here.
GateTimeline buildGateTimeline(std::vector<GateInterval> intervals);

// Non-owning audio-thread view over a prepared GateTimeline.
struct EnvelopeGateView {
    const GateRegion* regions     = nullptr;
    int               regionCount = 0;
    const int64_t*    starts      = nullptr;
    int               startCount  = 0;
};

EnvelopeGateView makeGateView(const GateTimeline& timeline);

// The gate window governing a query position, resolved in the SAMPLE domain so it
// lines up exactly with the note events the Sampler receives (tick boundaries are
// converted with the same formula as TickTime::toSamples).
//
// The governing region either contains the query, or is the most recent region
// that ended at/before it (its release tail may still be sounding).
// gateStartSample is the latest onset at/before the query within that region
// (restart-only: a new trigger always restarts the attack).
struct ResolvedGate {
    bool    valid           = false;
    int64_t gateStartSample = 0;
    int64_t gateEndSample   = 0;
};

// AUDIO THREAD. O(log n) over regions, O(k) over the governing region's onsets.
// No allocation, no locks.
ResolvedGate resolveActiveGateAtSample(const EnvelopeGateView& gates,
                                       int64_t querySample,
                                       double  bpm,
                                       double  sampleRate);

// Tick -> absolute sample, identical to TickTime::toSamples(bpm, sampleRate).
// Exposed so callers and tests convert exactly the way playback does.
int64_t tickToSample(int64_t tick, double bpm, double sampleRate);

// ─── ADSR ────────────────────────────────────────────────────────────────────

// Raw level while the gate is held, using straight A/H/D/S segments. heldSamples
// <= 0 yields the level at the gate's very start (0 unless attack is instant).
// Zero-duration stages are safe. AUDIO THREAD.
double levelWhileHeld(const EnvelopeShapeSamples& shape, double heldSamples);

// The 0..1 ADSR value at querySample for an explicit gate. Release falls from the
// ACTUAL level reached at gate end (not an assumed sustain), so a gate shorter
// than attack+hold+decay releases from wherever it got to. AUDIO THREAD.
double evaluateEnvelopeAdsr(const EnvelopeShapeSamples& shape,
                            const ResolvedGate&         gate,
                            int64_t                     querySample);

// Resolve + evaluate in one call: the whole audio-thread envelope read.
// Returns 0 when no gate has begun, which every modulation edge maps to exactly
// its authored `base`. AUDIO THREAD.
double evaluateEnvelopeAtSample(const EnvelopeShapeSamples& shape,
                                const EnvelopeGateView&     gates,
                                int64_t                     querySample,
                                double                      bpm,
                                double                      sampleRate);

// ─── graphState parse ────────────────────────────────────────────────────────

// Why an outgoing edge produced no write. Mirrors the `skipped` reasons of
// collectEnvelopeParameterWrites so engine and renderer agree on what is inert.
enum class EdgeSkipReason {
    Disabled,              // mapping.enabled === false
    InvalidTarget,         // targetParameter fails normalizeGraphParameterTarget
    MissingNode,           // target graph node is gone
    MissingEffectInstance, // node's effectInstanceId absent or mismatched
    MissingExposedPort,    // parameterId is not an exposed parameter port
    ReadOnly,              // exposed port readOnly === true or automatable === false
};

const char* toString(EdgeSkipReason reason);

struct SkippedEdge {
    std::string    edgeId;
    EdgeSkipReason reason = EdgeSkipReason::Disabled;
};

// One resolved Envelope->Parameter link. The engine addresses the target by the
// stable effectInstanceId, never by a graphState node id and never by an engine
// node id (same rule as the FXG.4-a write path).
struct ModulationTargetEdge {
    std::string       edgeId;
    std::string       effectInstanceId;
    std::string       parameterId;
    ModulationMapping mapping;
};

struct EnvelopeNodeDefinition {
    std::string                       nodeId;
    EnvelopeShape                     shape;
    std::vector<ModulationTargetEdge> edges;
};

struct ParsedGraphEnvelopes {
    std::vector<EnvelopeNodeDefinition> envelopes;
    std::vector<SkippedEdge>            skipped;
};

// PREPARE. Reads the persisted opaque graphState (the engine stores it verbatim
// in TrackInfo::graphState — no new bridge surface exists or is needed) and
// extracts every `type: "envelope"` node with its enabled, resolvable outgoing
// parameter edges. Malformed input yields an empty result rather than throwing.
//
// A pre-EVC-R4 envelope edge that still carries an absolute range mapping is
// migrated in place to base + signed depth, folding in the envelope node's retired
// `amount` exactly once — the same conversion the renderer's load path applies, so
// the engine agrees with the UI on a project that has not been re-saved yet. The
// fold is idempotent: a normalized node has no `amount`, so a second pass scales
// by 1.
ParsedGraphEnvelopes parseGraphStateEnvelopes(const nlohmann::json& graphState);

// ─── Authoritative gate derivation from the Timeline ─────────────────────────

// Which kind of trigger a track contributes. EVC-R2-r3 removed the user-facing
// Trigger Source selector: a normal Xleth track is either a pattern/MIDI-note
// track or a clip track, so the source is INFERRED from the track's content.
// Notes win deterministically if both somehow appear.
enum class GateSourceKind { None, Notes, Clips };

struct TrackGateBuild {
    std::vector<GateInterval> intervals;
    GateSourceKind            source = GateSourceKind::None;
};

// PREPARE. Derives one track's trigger gates using the SAME arithmetic
// MixEngine::triggerPatternNotes uses, so the envelope can never disagree with
// what the engine actually plays:
//
//   absNoteOn  = blockPos - blockOffset + L * patternLength + note.position
//   absNoteOff = min(absNoteOn + note.duration, blockEnd)   <-- the block-end clamp
//
// The clamp matters and is the one place the retired renderer evaluator was
// WRONG: it let a note's gate ring past the end of its block, so the envelope
// released later than the note it was following.
//
// Loop iterations follow the block's own loopEnabled rule (iteration 0 only when
// disabled), and a note is emitted when its onset lies inside the block window,
// exactly as the trigger path filters. Blocks whose pattern is missing, has no
// length, or has no bound region are skipped, because such a block produces no
// audio in the engine either.
//
// Slide notes: the engine's audio path emits only a SlideStart for them (no
// note-on, no note-off), so a slide contributes NO note gate unless the Envelope
// node opts in via includeSlideNotes — in which case its [onset, clamped end)
// span becomes a modulation-only gate. That preserves the persisted schema's
// opt-in exactly; it does not change slide playback anywhere.
//
// The inferred source is decided BEFORE slide filtering (matching
// inferTriggerSourceKind, which sees slide events as note events), so a track
// holding only slide notes yields no gates rather than falling through to clips.
TrackGateBuild buildTrackGateIntervals(const Timeline& timeline,
                                      int             trackId,
                                      bool            includeSlideNotes);

// ─── Published snapshot ──────────────────────────────────────────────────────
//
// Built entirely on the message thread and published as an immutable object. The
// audio thread only ever READS the structural members and WRITES the mailbox
// atomics; it never allocates, locks, frees, or logs.

// One published modulation value. The audio thread stores; the applier drains.
// `seq` advancing is the applier's "the audio thread has evaluated this" signal,
// so a stopped transport (which never evaluates) causes no writes at all.
struct EnvelopeMailbox {
    std::atomic<float>    value{0.0f};
    std::atomic<uint32_t> seq{0};
};

// Applier-side identity of a mailbox slot. NEVER read on the audio thread. The
// target is addressed by the stable effectInstanceId — never by a graphState node
// id and never by an engine node id.
struct EnvelopeMailboxTarget {
    int         trackId = -1;
    std::string effectInstanceId;
    std::string parameterId;
};

struct SnapshotEdge {
    ModulationMapping mapping;
    int               mailboxIndex = -1;
};

struct SnapshotEnvelope {
    EnvelopeShape shape;
    GateTimeline  gates;           // empty for an inaudible track (mute/solo)
    int           edgeOffset = 0;  // into EnvelopeModulationSnapshot::edges
    int           edgeCount  = 0;
};

struct EnvelopeModulationSnapshot {
    std::vector<SnapshotEnvelope> envelopes;
    std::vector<SnapshotEdge>     edges;

    // Mailboxes live INSIDE the snapshot, so their lifetime is the snapshot's
    // lifetime. That removes the separate-array lifetime problem entirely: an
    // audio thread holding a snapshot pointer necessarily holds valid mailboxes.
    std::unique_ptr<EnvelopeMailbox[]>  mailboxes;
    int                                 mailboxCount = 0;
    std::vector<EnvelopeMailboxTarget>  mailboxTargets;

    // Per-track note/clip gate timelines for the Xleth Filter's IN-EFFECT
    // per-slot Envelope modulator (NOT the FX-graph envelopes above). Populated
    // by MixEngine after buildEnvelopeModulationSnapshot — only MixEngine knows
    // which live effect chains hold a filter with an active envelope — so this
    // field rides the envelope snapshot's existing epoch-RCU lifetime rather than
    // adding a second published structure. Keyed by trackId. The audio thread
    // resolves a ResolvedGate from these each block and pushes it into the
    // track's filter effects (XlethEffectBase::applyModulationGate). Independent
    // of `empty()` above, which only governs the graph-envelope mailbox path.
    std::unordered_map<int, GateTimeline> filterTrackGates;

    bool empty() const { return envelopes.empty() || edges.empty(); }
};

// PREPARE. Walks every graph-mode, non-master track, parses its graphState,
// derives its authoritative gates, and assigns one mailbox slot per resolved
// edge. Mute/solo is honored by giving an inaudible track NO gates — the
// envelope then reads 0, which every edge maps to exactly its authored base, so
// muting a track releases its modulation instead of freezing it. Audibility uses
// xleth::buildRoutePlan, the same route-aware closure the audio thread applies.
//
// Returns a snapshot even when nothing is found (empty() is true) so callers
// never have to special-case null.
std::shared_ptr<const EnvelopeModulationSnapshot>
buildEnvelopeModulationSnapshot(const Timeline& timeline);

} // namespace xleth::envmod
