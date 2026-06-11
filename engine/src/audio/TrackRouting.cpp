#include "audio/TrackRouting.h"
#include "audio/SidechainDiagnostics.h"
#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include <algorithm>
#include <cmath>
#include <unordered_set>
#include <vector>

namespace xleth {

const char* RoutingValidationResult::reasonString() const {
    switch (reason) {
        case RoutingValidationReason::ok:                      return "ok";
        case RoutingValidationReason::unknown_track:           return "unknown_track";
        case RoutingValidationReason::self_route:              return "self_route";
        case RoutingValidationReason::cycle:                   return "cycle";
        case RoutingValidationReason::invalid_target:          return "invalid_target";
        case RoutingValidationReason::master_as_source:        return "master_as_source";
        case RoutingValidationReason::unknown_source_track:    return "unknown_source_track";
        case RoutingValidationReason::unknown_target_track:    return "unknown_target_track";
        case RoutingValidationReason::self_sidechain:          return "self_sidechain";
        case RoutingValidationReason::master_as_target:        return "master_as_target";
        case RoutingValidationReason::empty_effect_instance:   return "empty_effect_instance";
        case RoutingValidationReason::unknown_effect_instance: return "unknown_effect_instance";
        case RoutingValidationReason::duplicate_route:         return "duplicate_route";
        case RoutingValidationReason::invalid_gain:            return "invalid_gain";
        case RoutingValidationReason::unknown_route:           return "unknown_route";
    }
    return "unknown";
}

RoutingValidationResult validateTrackOutputRoute(const Timeline& timeline,
                                                 int sourceTrackId,
                                                 int proposedTargetId)
{
    if (sourceTrackId == -1)
        return { RoutingValidationReason::master_as_source };

    if (proposedTargetId == -1)
        return { RoutingValidationReason::ok };

    if (proposedTargetId == sourceTrackId)
        return { RoutingValidationReason::self_route };

    if (!timeline.getTrack(sourceTrackId))
        return { RoutingValidationReason::unknown_track };

    const TrackInfo* target = timeline.getTrack(proposedTargetId);
    if (!target)
        return { RoutingValidationReason::unknown_track };

    if (target->visualOnly)
        return { RoutingValidationReason::invalid_target };

    // Cycle check: DFS from proposedTargetId following existing output routes.
    // If we reach sourceTrackId, adding source→proposed would create a cycle.
    std::unordered_set<int> visited;
    std::vector<int> stack;
    stack.push_back(proposedTargetId);

    while (!stack.empty()) {
        int current = stack.back();
        stack.pop_back();

        if (current == sourceTrackId)
            return { RoutingValidationReason::cycle };

        if (visited.count(current))
            continue;
        visited.insert(current);

        const TrackInfo* t = timeline.getTrack(current);
        if (t) {
            int next = t->outputRoute.targetTrackId;
            if (next != -1)
                stack.push_back(next);
        }
    }

    return { RoutingValidationReason::ok };
}

// ─── validateSidechainRoute ───────────────────────────────────────────────────

float clampSidechainGain(float gain)
{
    if (!std::isfinite(gain)) return 1.0f;
    return std::clamp(gain, 0.0f, 2.0f);
}

// Returns true if adding the directed dependency edge source→target would close
// a cycle in the union graph of output-route + sidechain-route edges. Both edge
// kinds point "feeder → consumer" (the consumer must be processed after the
// feeder in a block). A cycle exists iff `target` can already reach `source`
// through existing edges. DFS over output route (one per track) + every existing
// sidechain route's target; master (-1) has no outgoing edges.
static bool wouldCreateSidechainCycle(const Timeline& timeline,
                                      int sourceTrackId, int targetTrackId)
{
    std::unordered_set<int> visited;
    std::vector<int> stack;
    stack.push_back(targetTrackId);

    while (!stack.empty()) {
        int current = stack.back();
        stack.pop_back();

        if (current == sourceTrackId)
            return true;
        if (current == -1 || visited.count(current))
            continue;
        visited.insert(current);

        const TrackInfo* t = timeline.getTrack(current);
        if (!t) continue;

        if (t->outputRoute.targetTrackId != -1)
            stack.push_back(t->outputRoute.targetTrackId);
        for (const auto& sc : t->sidechainRoutes)
            if (sc.targetTrackId != -1)
                stack.push_back(sc.targetTrackId);
    }
    return false;
}

RoutingValidationResult validateSidechainRoute(const Timeline& timeline,
                                               int sourceTrackId,
                                               const SidechainRoute& route,
                                               const SidechainEffectResolver& resolver)
{
    if (sourceTrackId == -1)
        return { RoutingValidationReason::master_as_source };
    if (!timeline.getTrack(sourceTrackId))
        return { RoutingValidationReason::unknown_source_track };

    const int targetId = route.targetTrackId;
    if (targetId == -1)
        return { RoutingValidationReason::master_as_target };
    if (targetId == sourceTrackId)
        return { RoutingValidationReason::self_sidechain };

    const TrackInfo* source = timeline.getTrack(sourceTrackId);
    const TrackInfo* target = timeline.getTrack(targetId);
    if (!target)
        return { RoutingValidationReason::unknown_target_track };

    // Track-level / FX-Graph Sidechain-Input targets (empty effect id) are
    // deferred to a later prompt — reject for 4B.
    if (route.targetEffectInstanceId.empty())
        return { RoutingValidationReason::empty_effect_instance };

    if (!std::isfinite(route.gain))
        return { RoutingValidationReason::invalid_gain };

    // routeId must be unique within the source track.
    for (const auto& existing : source->sidechainRoutes)
        if (existing.routeId == route.routeId)
            return { RoutingValidationReason::duplicate_route };

    // Effect-instance resolution (Prompt 4A lookup, supplied by the engine). When
    // no resolver is supplied (pure-model context) the check is skipped.
    if (resolver && !resolver(targetId, route.targetEffectInstanceId))
        return { RoutingValidationReason::unknown_effect_instance };

    if (wouldCreateSidechainCycle(timeline, sourceTrackId, targetId))
        return { RoutingValidationReason::cycle };

    return { RoutingValidationReason::ok };
}

// ─── buildRoutePlan ───────────────────────────────────────────────────────────

void buildRoutePlan(const RoutePlanSlotInput* slots, int count, RoutePlan& out)
{
    if (slots == nullptr || count < 0) count = 0;
    if (count > RoutePlan::kMaxSlots) count = RoutePlan::kMaxSlots;

    out.slotCount        = count;
    out.cycleDetected    = false;
    out.targetCorrected  = false;
    out.correctedFromSlot  = -1;
    out.correctedToTrackId = -1;

    // ── Resolve output target trackId → slot index ────────────────────────────
    // -1 stays Master. Missing / self / visual-only targets fail closed to
    // Master (defensive — these are rejected at the 2A mutation layer).
    for (int s = 0; s < count; ++s) {
        out.outputTargetSlot[s] = -1;
        out.audible[s]          = false;
        out.topoOrder[s]        = s;

        const int targetId = slots[s].outputTargetTrackId;
        if (targetId == -1) continue;

        int targetSlot = -1;
        for (int t = 0; t < count; ++t) {
            if (slots[t].trackId == targetId) { targetSlot = t; break; }
        }

        if (targetSlot < 0 || targetSlot == s || slots[targetSlot].visualOnly) {
            // Forced to Master.
            if (!out.targetCorrected) {
                out.targetCorrected    = true;
                out.correctedFromSlot  = s;
                out.correctedToTrackId = targetId;
            }
            continue;
        }
        out.outputTargetSlot[s] = targetSlot;
    }

    // ── Topological order (Kahn): source before target ────────────────────────
    // Edge s → outputTargetSlot[s]; a target's in-degree counts its sources.
    int inDegree[RoutePlan::kMaxSlots] = {};
    for (int s = 0; s < count; ++s) {
        const int t = out.outputTargetSlot[s];
        if (t >= 0) ++inDegree[t];
    }

    int queue[RoutePlan::kMaxSlots];
    int qHead = 0, qTail = 0;
    for (int s = 0; s < count; ++s)
        if (inDegree[s] == 0) queue[qTail++] = s;

    int placed = 0;
    while (qHead < qTail) {
        const int s = queue[qHead++];
        out.topoOrder[placed++] = s;
        const int t = out.outputTargetSlot[s];
        if (t >= 0 && --inDegree[t] == 0)
            queue[qTail++] = t;
    }

    if (placed != count) {
        // Cycle — impossible after 2A validation. Fail closed: all-to-Master,
        // identity processing order.
        out.cycleDetected = true;
        for (int s = 0; s < count; ++s) {
            out.outputTargetSlot[s] = -1;
            out.topoOrder[s]        = s;
        }
    }

    // ── Mute / solo closure over output-route edges ───────────────────────────
    bool anySolo = false;
    for (int s = 0; s < count; ++s)
        if (slots[s].solo) { anySolo = true; break; }

    if (!anySolo) {
        // No solo: a track is audible unless muted. A muted bus silences its
        // whole subtree implicitly — its sources still sum into the bus buffer,
        // but the muted bus never forwards it (audible[bus] == false).
        for (int s = 0; s < count; ++s)
            out.audible[s] = !slots[s].muted;
    } else {
        // Solo closure: audible = ⋃ over soloed s of
        //   upstream(s) ∪ {s} ∪ downstreamPath(s).
        // Upstream + self: a slot whose output path reaches a soloed slot.
        for (int u = 0; u < count; ++u) {
            int cur = u, guard = 0;
            while (cur >= 0 && guard++ <= count) {
                if (slots[cur].solo) { out.audible[u] = true; break; }
                cur = out.outputTargetSlot[cur];
            }
        }
        // Downstream path: the route chain from each soloed slot to Master.
        for (int s = 0; s < count; ++s) {
            if (!slots[s].solo) continue;
            int cur = s, guard = 0;
            while (cur >= 0 && guard++ <= count) {
                out.audible[cur] = true;
                cur = out.outputTargetSlot[cur];
            }
        }
    }
}

// ─── buildRoutePdcPlan ────────────────────────────────────────────────────────

void buildRoutePdcPlan(const RoutePlanSlotInput* slots, int count,
                       const RoutePlan& plan,
                       const int* chainLatencySamples,
                       RoutePdcPlan& out)
{
    if (slots == nullptr || chainLatencySamples == nullptr || count < 0) count = 0;
    if (count > RoutePdcPlan::kMaxSlots) count = RoutePdcPlan::kMaxSlots;
    if (count > plan.slotCount) count = plan.slotCount;

    for (int s = 0; s < count; ++s) {
        out.branchCompensationSamples[s]   = 0;
        out.junctionInputLatencySamples[s] = 0;
        out.branchArrivalLatencySamples[s] = 0;
        out.contributesToMaster[s]         = false;
    }
    out.maxPathLatencySamples = 0;

    // Pass 1 — reverse topo (targets before sources): a slot contributes to the
    // Master sum only when itself and every hop downstream is audible and not
    // visual-only. An audible source dead-ended into a muted bus contributes
    // nothing, so it can never inflate a junction or the max path latency.
    for (int oi = count - 1; oi >= 0; --oi) {
        const int s = plan.topoOrder[oi];
        const bool eligible = plan.audible[s] && !slots[s].visualOnly;
        const int  t = plan.outputTargetSlot[s];
        out.contributesToMaster[s] = eligible && (t < 0 || out.contributesToMaster[t]);
    }

    // Pass 2 — forward topo (sources before targets): a branch's raw arrival at
    // its destination is the aligned routed input it carries plus its own chain
    // latency. Each junction's input latency is the max raw arrival over its
    // contributing branches; the Master junction's max is the max path latency.
    for (int oi = 0; oi < count; ++oi) {
        const int s = plan.topoOrder[oi];
        const int chainLat = chainLatencySamples[s] > 0 ? chainLatencySamples[s] : 0;
        out.branchArrivalLatencySamples[s] = out.junctionInputLatencySamples[s] + chainLat;

        if (!out.contributesToMaster[s]) continue;

        const int t = plan.outputTargetSlot[s];
        if (t < 0) {
            if (out.branchArrivalLatencySamples[s] > out.maxPathLatencySamples)
                out.maxPathLatencySamples = out.branchArrivalLatencySamples[s];
        } else if (out.branchArrivalLatencySamples[s] > out.junctionInputLatencySamples[t]) {
            out.junctionInputLatencySamples[t] = out.branchArrivalLatencySamples[s];
        }
    }

    // Pass 3 — branch compensation: align every contributing branch to its own
    // destination junction's input latency (≥ 0 by construction of the maxima).
    for (int s = 0; s < count; ++s) {
        if (!out.contributesToMaster[s]) continue;
        const int t = plan.outputTargetSlot[s];
        const int junctionLatency = (t < 0) ? out.maxPathLatencySamples
                                            : out.junctionInputLatencySamples[t];
        const int comp = junctionLatency - out.branchArrivalLatencySamples[s];
        out.branchCompensationSamples[s] = comp > 0 ? comp : 0;
    }
}

// ─── buildSidechainPlan ───────────────────────────────────────────────────────

void buildSidechainPlan(const RoutePlanSlotInput* slots, int count,
                        const RoutePlan& plan,
                        const SidechainTapInput* taps, int tapCount,
                        SidechainPlan& out)
{
    if (slots == nullptr || count < 0) count = 0;
    if (count > SidechainPlan::kMaxSlots) count = SidechainPlan::kMaxSlots;
    if (count > plan.slotCount) count = plan.slotCount;
    if (taps == nullptr || tapCount < 0) tapCount = 0;

    // Default: identical to the output-only path (processOrder == plan.topoOrder).
    out.processCount  = count;
    out.tapCount      = 0;
    out.anyActive     = false;
    out.cycleDetected = false;
    for (int s = 0; s < count; ++s) {
        out.processOrder[s]        = plan.topoOrder[s];
        out.feedsSidechainOnly[s]  = false;
        out.hasIncomingKey[s]      = false;
    }

    if (count == 0 || tapCount == 0) return;

    // ── Resolve + filter taps to the active set ───────────────────────────────
    // A tap is active iff it carries a real key this block. Mute/visual-only on
    // the source kill the key; the target must be audible and not visual-only.
    for (int k = 0; k < tapCount && out.tapCount < SidechainPlan::kMaxTaps; ++k) {
        const SidechainTapInput& tp = taps[k];

        if (!tp.enabled || !tp.effectResolved) {
            if (xleth::sidechain_diag::audioBlockActive())
                xleth::sidechain_diag::appendf("TrackRouting", "buildSidechainPlanSkipped",
                    "sourceSlot=%d targetTrackId=%d enabled=%d gain=%.6f preFader=%d reason=%s",
                    tp.sourceSlot, tp.targetTrackId, tp.enabled ? 1 : 0, tp.gain,
                    tp.preFader ? 1 : 0, !tp.enabled ? "disabled" : "effect_unresolved");
            continue;
        }

        const int s = tp.sourceSlot;
        if (s < 0 || s >= count) {
            if (xleth::sidechain_diag::audioBlockActive())
                xleth::sidechain_diag::appendf("TrackRouting", "buildSidechainPlanSkipped",
                    "sourceSlot=%d targetTrackId=%d enabled=%d gain=%.6f preFader=%d reason=stale_source_slot",
                    s, tp.targetTrackId, tp.enabled ? 1 : 0, tp.gain, tp.preFader ? 1 : 0);
            continue;
        }
        if (slots[s].muted || slots[s].visualOnly) {
            if (xleth::sidechain_diag::audioBlockActive())
                xleth::sidechain_diag::appendf("TrackRouting", "buildSidechainPlanSkipped",
                    "sourceSlot=%d sourceTrackId=%d targetTrackId=%d enabled=%d gain=%.6f preFader=%d muted=%d visualOnly=%d reason=source_inactive",
                    s, slots[s].trackId, tp.targetTrackId, tp.enabled ? 1 : 0,
                    tp.gain, tp.preFader ? 1 : 0, slots[s].muted ? 1 : 0,
                    slots[s].visualOnly ? 1 : 0);
            continue;
        }   // key dies with source

        // Resolve target trackId → slot.
        int targetSlot = -1;
        for (int t = 0; t < count; ++t)
            if (slots[t].trackId == tp.targetTrackId) { targetSlot = t; break; }
        if (targetSlot < 0 || targetSlot == s) {
            if (xleth::sidechain_diag::audioBlockActive())
                xleth::sidechain_diag::appendf("TrackRouting", "buildSidechainPlanSkipped",
                    "sourceSlot=%d sourceTrackId=%d targetTrackId=%d targetSlot=%d enabled=%d gain=%.6f preFader=%d reason=%s",
                    s, slots[s].trackId, tp.targetTrackId, targetSlot,
                    tp.enabled ? 1 : 0, tp.gain, tp.preFader ? 1 : 0,
                    targetSlot < 0 ? "stale_target_track" : "self_sidechain");
            continue;
        }       // stale / self
        if (!plan.audible[targetSlot] || slots[targetSlot].visualOnly) {
            if (xleth::sidechain_diag::audioBlockActive())
                xleth::sidechain_diag::appendf("TrackRouting", "buildSidechainPlanSkipped",
                    "sourceSlot=%d sourceTrackId=%d targetTrackId=%d targetSlot=%d enabled=%d gain=%.6f preFader=%d targetAudible=%d targetVisualOnly=%d reason=target_inactive",
                    s, slots[s].trackId, tp.targetTrackId, targetSlot,
                    tp.enabled ? 1 : 0, tp.gain, tp.preFader ? 1 : 0,
                    plan.audible[targetSlot] ? 1 : 0,
                    slots[targetSlot].visualOnly ? 1 : 0);
            continue;
        }

        const int idx = out.tapCount++;
        out.tapSourceSlot[idx] = s;
        out.tapTargetSlot[idx] = targetSlot;
        out.tapGain[idx]       = tp.gain;
        out.tapPreFader[idx]   = tp.preFader;
        out.hasIncomingKey[targetSlot] = true;

        // Source silenced only by solo closure (not by its own mute/visual-only,
        // already excluded above) must still be rendered to produce the key.
        if (!plan.audible[s])
            out.feedsSidechainOnly[s] = true;
    }

    if (out.tapCount == 0) return;   // nothing survived filtering
    out.anyActive = true;

    // ── Combined topological order (output ∪ active sidechain edges) ──────────
    // Both edge kinds point feeder → consumer, so the source of a key must be
    // placed before its target. A cycle here is impossible after 4B validation
    // (sidechain edges already participate in cycle rejection); if a stale
    // impossible route slips through, fail closed to the output-only order so
    // audible bus routing is never disturbed — the offending key just may be
    // empty/one-block-stale this block.
    int inDegree[SidechainPlan::kMaxSlots] = {};
    for (int s = 0; s < count; ++s) {
        const int t = plan.outputTargetSlot[s];
        if (t >= 0) ++inDegree[t];
    }
    for (int k = 0; k < out.tapCount; ++k)
        ++inDegree[out.tapTargetSlot[k]];

    int queue[SidechainPlan::kMaxSlots];
    int qHead = 0, qTail = 0;
    for (int s = 0; s < count; ++s)
        if (inDegree[s] == 0) queue[qTail++] = s;

    int placed = 0;
    while (qHead < qTail) {
        const int s = queue[qHead++];
        out.processOrder[placed++] = s;

        const int t = plan.outputTargetSlot[s];
        if (t >= 0 && --inDegree[t] == 0)
            queue[qTail++] = t;

        for (int k = 0; k < out.tapCount; ++k)
            if (out.tapSourceSlot[k] == s && --inDegree[out.tapTargetSlot[k]] == 0)
                queue[qTail++] = out.tapTargetSlot[k];
    }

    if (placed != count) {
        // Combined cycle — keep the output-only order (already in processOrder).
        out.cycleDetected = true;
        for (int s = 0; s < count; ++s)
            out.processOrder[s] = plan.topoOrder[s];
    }
}

} // namespace xleth
