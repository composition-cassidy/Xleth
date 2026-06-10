#pragma once
#include <functional>
#include <string>

class Timeline;
struct SidechainRoute;

namespace xleth {

// ─── RoutingValidationReason ──────────────────────────────────────────────────
// Stable reason codes returned by the routing validators. These strings are
// forwarded verbatim through the bridge to the renderer on validation failure.

enum class RoutingValidationReason {
    ok,
    unknown_track,    // source or target trackId not found in timeline
    self_route,       // source == target
    cycle,            // adding this edge creates a routing cycle
    invalid_target,   // target is a visualOnly track or otherwise ineligible
    master_as_source, // source trackId == -1 (master has no output route)

    // ── Sidechain-route specific (Prompt 4B) ──────────────────────────────────
    unknown_source_track,   // sidechain source trackId not found
    unknown_target_track,   // sidechain target trackId not found
    self_sidechain,         // sidechain source == target (deferred to a later prompt)
    master_as_target,       // sidechain target trackId == -1 (master SC deferred)
    empty_effect_instance,  // targetEffectInstanceId is empty (track-level SC deferred)
    unknown_effect_instance,// targetEffectInstanceId does not resolve on target track
    duplicate_route,        // routeId already exists on the source track
    invalid_gain,           // gain is not finite
    unknown_route,          // routeId not found on the source track (remove/setParams)
};

struct RoutingValidationResult {
    RoutingValidationReason reason = RoutingValidationReason::ok;

    bool ok() const { return reason == RoutingValidationReason::ok; }

    // Returns a stable lowercase string matching the reason enum name.
    // Used by the bridge to surface { ok: false, reason: "cycle" } to JS.
    const char* reasonString() const;
};

// ─── validateTrackOutputRoute ─────────────────────────────────────────────────
// Pure, side-effect-free validator. Returns ok if setting sourceTrackId's
// outputRoute.targetTrackId to proposedTargetId would be valid given the
// current routing state of timeline.
//
// proposedTargetId == -1 (Master) always returns ok as long as the source
// track exists. master_as_source is returned when sourceTrackId == -1.
RoutingValidationResult validateTrackOutputRoute(const Timeline& timeline,
                                                 int sourceTrackId,
                                                 int proposedTargetId);

// ─── Sidechain route validation (Prompt 4B) ───────────────────────────────────
// A SidechainEffectResolver answers "does this effect instance currently resolve
// on this target track?" — the only piece of engine state the pure Timeline model
// cannot see. The bridge builds it from MixEngine::getEffectNodeIdForInstance;
// pure-model tests supply a fake. When the resolver is empty (null std::function)
// effect-instance resolution is skipped (model-only validation: structure, self,
// duplicate, cycle, gain) — staleness is then reported at read time, not here.
using SidechainEffectResolver =
    std::function<bool(int targetTrackId, const std::string& effectInstanceId)>;

// Mutable subset of a SidechainRoute editable via setSidechainRouteParams. The
// route's target (track + effect instance) is immutable after creation.
struct SidechainRouteParams {
    float gain     = 1.0f;
    bool  preFader = false;
    bool  enabled  = true;
};

// ─── validateSidechainRoute ───────────────────────────────────────────────────
// Pure, side-effect-free validator for adding `route` to `sourceTrackId`. Checks,
// in order: master-as-source, unknown source, master-as-target, self-sidechain,
// unknown target, empty/unresolved effect instance, non-finite gain, duplicate
// routeId on the source, and cycle (over the union of output-route and existing
// sidechain-route edges — see §4.4 of the architecture audit). Gain is validated
// for finiteness only; the mutation layer clamps the finite value to [0, 2].
RoutingValidationResult validateSidechainRoute(const Timeline& timeline,
                                               int sourceTrackId,
                                               const SidechainRoute& route,
                                               const SidechainEffectResolver& resolver);

// Clamp a raw gain to the persisted/runtime-safe key-gain range [0, 2]. Non-
// finite input collapses to the 1.0 default. Shared by the mutation layer and
// deserialization so both agree on the safe range.
float clampSidechainGain(float gain);

// ─── RoutePlan (Prompt 2B audio-thread DSP route plan) ────────────────────────
// Pure, allocation-free description of how active track slots sum together for
// one processBlock. A "slot" is an index into the engine's active track list
// (getAllTracks() order), matching MixEngine::trackBuffers_ slot space. Covers
// output routing only — sends and sidechain edges are deferred (Prompt 4+).

struct RoutePlanSlotInput {
    int  trackId             = -1;
    int  outputTargetTrackId = -1;     // -1 = Master (default)
    bool muted               = false;
    bool solo                = false;
    bool visualOnly          = false;
};

struct RoutePlan {
    static constexpr int kMaxSlots = 64;

    int  slotCount = 0;
    int  outputTargetSlot[kMaxSlots]; // resolved target slot; -1 = Master sum
    int  topoOrder[kMaxSlots];        // slot indices in processing order (sources before targets)
    bool audible[kMaxSlots];          // mute/solo closure result per slot

    // Defensive diagnostics — both should be false for any project that passed
    // the Prompt 2A mutation-layer validation. When set, the builder has already
    // failed closed (offending edges forced to Master).
    bool cycleDetected    = false;    // topo sort could not place every slot
    bool targetCorrected  = false;    // ≥1 output target was missing/invalid → Master
    int  correctedFromSlot  = -1;     // first slot whose target was corrected (diag)
    int  correctedToTrackId = -1;     // the missing/invalid target trackId (diag)
};

// Build a RoutePlan from up to kMaxSlots slot inputs. Pure and audio-thread
// safe: no heap allocation, no locks. `out` is fully overwritten.
//
// Topological order guarantees a source slot is processed (and summed into its
// bus) before the bus slot runs its own chain. Each slot has at most one output
// edge, so the route graph is a forest of in-trees pointing toward Master.
//
// Fail-closed contract (cycles are rejected at the mutation layer, so reaching
// these paths is a programming error, not user input):
//   • Missing / self / visual-only target → that slot is forced to Master.
//   • Cycle (topo cannot place all slots) → ALL slots forced to Master, identity
//     processing order, cycleDetected = true.
// For an unrouted project (every outputTargetTrackId == -1) the plan reduces to
// identity order with audible[s] == (anySolo ? solo[s] : !muted[s]).
void buildRoutePlan(const RoutePlanSlotInput* slots, int count, RoutePlan& out);

// ─── RoutePdcPlan (Prompt 2C junction latency compensation) ───────────────────
// Route-aware PDC metadata derived from a built RoutePlan plus per-slot insert-
// chain latencies. A summing junction is either a bus track's input (routed
// sources summing into that track's pre-chain buffer) or the Master input.
// Each contributing branch is delay-compensated immediately before it sums into
// its destination junction so all immediate inputs of a junction arrive aligned.
// Output routes only — sends and sidechain are deferred (Prompt 4+).

struct RoutePdcPlan {
    static constexpr int kMaxSlots = RoutePlan::kMaxSlots;

    // Delay (samples) applied to this slot's processed buffer immediately before
    // summing it into its destination junction. 0 for non-contributing slots.
    int branchCompensationSamples[kMaxSlots];

    // Aligned latency of the routed input already summed into this slot's buffer
    // when its own chain runs (= max raw branch arrival over contributing
    // sources; 0 when nothing routes into the slot). NOTE: a bus's OWN clips
    // enter its buffer at latency 0 and are not delayed to meet routed input —
    // same skew as the pre-2C flat model (no pre-chain delay stage exists).
    int junctionInputLatencySamples[kMaxSlots];

    // Raw latency of this slot's branch as it arrives at its destination
    // junction BEFORE branch compensation:
    //   junctionInputLatencySamples[slot] + chainLatencySamples[slot].
    int branchArrivalLatencySamples[kMaxSlots];

    // True when this slot's signal reaches the Master sum: the slot and every
    // hop downstream are audible (RoutePlan mute/solo closure) and not
    // visual-only. Only contributing slots take part in junction maxima.
    bool contributesToMaster[kMaxSlots];

    // Aligned latency at the Master input junction = the deepest contributing
    // route path latency (insert chains + branch compensation up to, but not
    // including, the master insert chain). Export pre-roll consumes this; for
    // an unrouted project it equals the old max audible track latency.
    int maxPathLatencySamples = 0;
};

// Build junction-PDC metadata for a RoutePlan. `slots`/`count` must be the same
// inputs `plan` was built from; `chainLatencySamples[s]` is slot s's insert-
// chain output latency (EffectChainManager::getOutputLatencySamples). Pure and
// audio-thread safe: fixed arrays, no heap allocation, no locks. `out` is fully
// overwritten.
//
// Alignment contract (per junction, over contributing branches only):
//   compensation[s] = junctionLatency(target(s)) − branchArrival(s)
// where junctionLatency(Master) == maxPathLatencySamples. Compensation aligns a
// slot at its OWN destination junction exactly once — latency is never counted
// twice, and muted/solo-silenced/visual-only branches never inflate any
// junction. For an unrouted project this reduces exactly to the flat model:
//   compensation[s] = maxAudibleTrackLatency − chainLatency[s].
void buildRoutePdcPlan(const RoutePlanSlotInput* slots, int count,
                       const RoutePlan& plan,
                       const int* chainLatencySamples,
                       RoutePdcPlan& out);

} // namespace xleth
