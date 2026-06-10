#pragma once
#include <string>

class Timeline;

namespace xleth {

// ─── RoutingValidationReason ──────────────────────────────────────────────────
// Stable reason codes returned by validateTrackOutputRoute. These strings are
// forwarded verbatim through the bridge to the renderer on validation failure.

enum class RoutingValidationReason {
    ok,
    unknown_track,    // source or target trackId not found in timeline
    self_route,       // source == target
    cycle,            // adding this edge creates a routing cycle
    invalid_target,   // target is a visualOnly track or otherwise ineligible
    master_as_source, // source trackId == -1 (master has no output route)
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

} // namespace xleth
