#pragma once
// LfoParameterModulation — pure engine-side evaluation of the FX Graph LFO
// Modulator as a graph-owned PARAMETER-MODULATION source.
//
// Sibling of EnvelopeParameterModulation.h/.cpp (read that file first — this one
// mirrors its PREPARE/EVALUATE split and its threading discipline exactly). The
// two differ in one structural way: an Envelope is TRIGGERED (it reads note/clip
// gates and is silent — value 0 — until something gates it open), while an LFO is
// FREE-RUNNING (it oscillates continuously from absolute transport position, with
// no concept of a gate/trigger at all). Consequently this file has NO
// GateTimeline, NO GateInterval, and NO resolveActiveGateAtSample equivalent —
// that machinery is deliberately absent, not forgotten. See the doc comment on
// LfoSnapshotEntry for the shape this takes in the published snapshot.
//
//   engine transport position (samples, absolute, never reset by loop/seek)
//     -> ONE bipolar [-1,1] LFO value per LFO node (evaluateLfoAtPosition)
//     -> rescaled to unipolar (v+1)/2
//     -> each Lfo->Parameter edge's MODULATION mapping (reused unchanged from
//        xleth::envmod), value = clamp(base + depth * shaped(unipolar))
//     -> the graph-owned effect parameter
//
// Everything in this header is PURE and deterministic, exactly like its Envelope
// sibling. Two halves, split by thread:
//
//   PREPARE (message thread, allocates freely) — parse the persisted opaque
//   graphState JSON into node definitions and resolved parameter edges.
//
//   EVALUATE (audio thread, NO allocation / NO locks / NO logging) —
//   lfoCycleHz, evaluateLfoWaveform, evaluateLfoAtPosition. These read only
//   caller-owned memory (a LfoShape by const-ref, plain numbers) and do fixed
//   arithmetic — no persisted phase, no static/member state, so the SAME
//   position can be evaluated concurrently from multiple callers (needed for the
//   epoch-RCU snapshot pattern the MixEngine integration stage adds on top of
//   this file) and evaluating an arbitrary position after a seek/loop-wrap is
//   just as correct as evaluating the very next sample after the previous call.
//
// ─── Tempo-sync formula: division/4.0, NOT 4.0/division ──────────────────────
// cycleHz = (bpm/60) * (division/4). This is the OPPOSITE shape from the
// Sampler's own Sampler::advanceLfo (engine/src/audio/Sampler.cpp), which
// computes `(bpm/60) * (4.0/config.tempoDivision)`. That existing formula is
// CONFIRMED BACKWARDS — it makes "1/8" oscillate slower than "1/4", which is
// wrong (a smaller note-value division should be a FASTER cycle). This is
// independently confirmed by two other places in this codebase that get it
// right: the Arpeggiator's period-based step duration and
// ClipModulationEvaluator's cyclesPerBeat (division/4 for every straight
// division). Do not "fix" this back to match the Sampler — the Sampler is the
// one that's wrong, and porting its formula here would silently reintroduce the
// same bug in a second place.
//
// ─── Why evaluateLfoAtPosition alone cannot produce "inert" behavior ─────────
// Envelope's rest state (env == 0) maps through evaluateModulationMapping to
// exactly `base` for any mapping, which is what makes a stopped/muted Envelope
// harmlessly settle at its authored base instead of doing something audible.
// An LFO has no rest state in the same sense: its neutral bipolar-0 sample
// rescales to unipolar 0.5, and evaluateModulationMapping(mapping, 0.5) does
// NOT generally equal `base` (it equals base + depth * shaped(0.5), which is
// base only when depth == 0 or the source window/curve happens to zero out at
// the midpoint). So this file's evaluateLfoAtPosition is NOT sufficient on its
// own to make a stopped/inaudible track's modulation settle back to `base` —
// that responsibility belongs to a LATER stage (the MixEngine integration),
// which must detect "at rest" / "track inaudible" and write mapping.base
// directly to the mailbox, bypassing evaluateModulationMapping entirely for
// that case. This file does not implement that bypass; it only evaluates the
// oscillator.

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "EnvelopeParameterModulation.h"
#include "TimelineTypes.h"

class Timeline;

namespace xleth::lfomod {

// ─── LFO shape ─────────────────────────────────────────────────────────────

enum class RateMode { Free, Sync };

// The closed, normalized LFO node schema (mirrors normalizeLfoNodeData in
// ui/src/fxgraph/graphState.js). The waveform breakpoint type is NOT
// reinvented here: SampleRegion::LfoBreakpoint ({float time; float value;},
// engine/src/model/TimelineTypes.h) is already a generic, engine-wide
// breakpoint shape used by the Sampler's own per-voice LFOs and by
// ClipModulation::Vibrato's customShape — reusing it keeps this file
// consistent with the rest of the engine and needs no new JSON codec shape.
struct LfoShape {
    RateMode rateMode = RateMode::Free;
    double   rateMs    = 250.0; // free-mode PERIOD in ms (not Hz); hz = 1000/rateMs
    // Note-division DENOMINATOR: cycle period is (4 / syncDivision) beats, so a
    // larger number is a faster LFO. Values BELOW 1 are the multi-bar rates
    // (0.5 = 2/1 = two whole notes = 8 beats, 0.25 = 4/1, 0.125 = 8/1), which is
    // why this is a double rather than an int — truncating 0.5 to 0 would collapse
    // every multi-bar rate onto the clamp floor.
    double   syncDivision = 4.0;
    double   phaseOffset  = 0.0; // 0..1, added into the phase before wrapping

    std::vector<SampleRegion::LfoBreakpoint> waveform; // {time,value}; JSON keys "t"/"v"
};

// Normalizes raw LFO node data. Mirrors normalizeLfoNodeData: rateMs must be
// finite and >= 0 (else the default), syncDivision is clamped to
// >= kMinSyncDivision (else the default), phaseOffset clamps to 0..1
// (non-finite -> default), rateMode
// is 'sync' only for the literal string "sync" (anything else, including
// missing, is 'free'). The waveform array is read from "waveform": [{t,v},...];
// each point's t/v default to 0.0 when missing/non-numeric/non-finite (matching
// the existing "t"/"v" breakpoint codec convention in XlethEngineService.cpp's
// parseLfoWaveform, rather than dropping the point). A wholly missing/non-array
// waveform yields an empty vector (the caller-facing sine fallback).
LfoShape normalizeLfoShape(const nlohmann::json& rawData);

// ─── Tempo-sync / rate ───────────────────────────────────────────────────────

// See the header-top note: Sync mode is INTENTIONALLY division/4.0, not the
// Sampler's inverted 4.0/division.
//   Free: 1000.0 / max(shape.rateMs, epsilon)
//   Sync: (bpm/60.0) * (max(kMinSyncDivision, shape.syncDivision) / 4.0)

// Floor for syncDivision. 1/128 is two octaves slower than the slowest rate the
// UI offers (0.125 = 8/1), so it only ever catches garbage/zero input rather
// than clipping a legitimate musical division.
inline constexpr double kMinSyncDivision = 1.0 / 128.0;

double lfoCycleHz(const LfoShape& shape, double bpm);

// ─── Waveform evaluation ──────────────────────────────────────────────────────

// phase01 is wrapped to [0,1) defensively (callers already wrap, but this stays
// safe to call directly, e.g. from tests). Empty waveform -> std::sin(phase01 *
// 2*PI), matching both the Sampler's and ClipModulationEvaluator's existing
// empty-waveform sine fallback convention. A single-point waveform returns that
// point's value everywhere. >=2 points: linear-scan the breakpoints for the
// pair straddling phase01 and lerp between them (same scan/lerp shape as
// Sampler::evaluateLfoWaveform, Sampler.cpp:169-189 — same algorithm, an
// independent copy, never calls into Sampler.cpp).
// AUDIO THREAD. No allocation, no locks, fixed-shape scan over caller-owned data.
double evaluateLfoWaveform(const std::vector<SampleRegion::LfoBreakpoint>& waveform,
                           double phase01);

// STATELESS: a pure function of absolute sample position, exactly like
// evaluateEnvelopeAtSample's purity property (no persisted phase, no
// static/member state anywhere), so it is correct across seek/loop-wrap and
// safe to call concurrently from multiple threads with different
// positionSamples. Returns a value in [-1,1].
//   hz        = lfoCycleHz(shape, bpm)
//   cyclePos  = (positionSamples / sampleRate) * hz + shape.phaseOffset
//   phase01   = cyclePos - floor(cyclePos)
//   return evaluateLfoWaveform(shape.waveform, phase01)
// AUDIO THREAD. No allocation, no locks, no logging.
double evaluateLfoAtPosition(const LfoShape& shape,
                             int64_t         positionSamples,
                             double          bpm,
                             double          sampleRate);

// ─── graphState parse ────────────────────────────────────────────────────────
//
// Skip reasons and the resolved-edge shape are REUSED unchanged from envmod
// (xleth::envmod::EdgeSkipReason, xleth::envmod::SkippedEdge,
// xleth::envmod::ModulationTargetEdge): all three are already generic over
// "some graph node's outgoing parameter edge" and carry no envelope-specific
// concept (no gate/trigger field anywhere on them), so duplicating them here
// would just be drift risk with no benefit. ModulationMapping/MappingCurve/
// evaluateModulationMapping/evaluateBezierCurve are reused the same way.

struct LfoNodeDefinition {
    std::string                                    nodeId;
    LfoShape                                        shape;
    std::vector<xleth::envmod::ModulationTargetEdge> edges;
};

struct ParsedGraphLfoNodes {
    std::vector<LfoNodeDefinition>          lfos;
    std::vector<xleth::envmod::SkippedEdge> skipped;
};

// PREPARE. Reads the persisted opaque graphState and extracts every
// `type: "lfo"` node with its resolvable outgoing parameter edges. Mirrors
// parseGraphStateEnvelopes's structure (node scan -> per-node edge scan ->
// target resolution -> mapping normalization) but targets `type == "lfo"` and
// reads LfoShape instead of EnvelopeShape. Target resolution is this file's
// OWN local copy of the same ~60-line resolveTarget block envmod uses
// internally (that helper is TU-local / anonymous-namespace in
// EnvelopeParameterModulation.cpp and is not exported, so it cannot be called
// from here — consistent with this codebase's existing "mirror, don't
// generalize" convention for Macro/Envelope). No legacy-mapping migration is
// needed or performed: LFO is a brand-new feature with nothing to migrate
// from, so every edge's mapping is read via the modulation-kind reader only.
// Malformed input yields an empty result rather than throwing.
ParsedGraphLfoNodes parseGraphStateLfoNodes(const nlohmann::json& graphState);

// ─── Published snapshot ──────────────────────────────────────────────────────
//
// Built entirely on the message thread and published as an immutable object,
// exactly like EnvelopeModulationSnapshot. The audio thread only ever READS the
// structural members and WRITES the mailbox atomics; it never allocates,
// locks, frees, or logs.

// One published modulation value. The audio thread stores; the applier drains.
struct LfoMailbox {
    std::atomic<float>    value{0.0f};
    std::atomic<uint32_t> seq{0};
};

// Applier-side identity of a mailbox slot. NEVER read on the audio thread. The
// target is addressed by the stable effectInstanceId — never by a graphState
// node id and never by an engine node id (same rule as envmod).
struct LfoMailboxTarget {
    int         trackId = -1;
    std::string effectInstanceId;
    std::string parameterId;
};

struct LfoSnapshotEdge {
    xleth::envmod::ModulationMapping mapping;
    int                              mailboxIndex = -1;
};

// NOTE: deliberately no GateTimeline field here (compare
// envmod::SnapshotEnvelope, which carries `GateTimeline gates`). An LFO
// free-runs continuously from transport position — it has no trigger/gate
// concept to derive or store, so there is nothing gate-shaped in this struct.
struct LfoSnapshotEntry {
    LfoShape shape;
    int      edgeOffset = 0; // into LfoModulationSnapshot::edges
    int      edgeCount  = 0;
};

struct LfoModulationSnapshot {
    std::vector<LfoSnapshotEntry> lfos;
    std::vector<LfoSnapshotEdge>  edges;

    // Mailboxes live INSIDE the snapshot, so their lifetime is the snapshot's
    // lifetime (same rationale as EnvelopeModulationSnapshot).
    std::unique_ptr<LfoMailbox[]>  mailboxes;
    int                            mailboxCount = 0;
    std::vector<LfoMailboxTarget>  mailboxTargets;

    bool empty() const { return lfos.empty() || edges.empty(); }
};

// PREPARE. Walks every graph-mode, non-master track, parses its graphState via
// parseGraphStateLfoNodes, and assigns one mailbox slot per resolved edge.
//
// Unlike buildEnvelopeModulationSnapshot, this function does NOT consult
// mute/solo audibility at all — an inaudible track's LFO node still gets a
// full, normal snapshot entry here. That's intentional, not a missed mirror:
// "go inert when inaudible" for an LFO cannot be expressed by omitting
// structure the way Envelope omits gates (see the header-top note — an LFO's
// neutral sample does not rescale to `base`), so there is nothing correct for
// THIS function to special-case. Mute/solo audibility is a runtime concern
// applied per-block by the MixEngine integration stage (evaluateLfoModulation
// there checks audibility itself and bypasses evaluateModulationMapping to
// write `mapping.base` directly when inaudible/at-rest) — it is not baked into
// the snapshot's structure the way Envelope's gate timeline is.
//
// Returns a snapshot even when nothing is found (empty() is true) so callers
// never have to special-case null.
std::shared_ptr<const LfoModulationSnapshot>
buildLfoModulationSnapshot(const Timeline& timeline);

} // namespace xleth::lfomod
