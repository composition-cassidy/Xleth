#include "audio/TrackRouting.h"
#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include <unordered_set>
#include <vector>

namespace xleth {

const char* RoutingValidationResult::reasonString() const {
    switch (reason) {
        case RoutingValidationReason::ok:               return "ok";
        case RoutingValidationReason::unknown_track:    return "unknown_track";
        case RoutingValidationReason::self_route:       return "self_route";
        case RoutingValidationReason::cycle:            return "cycle";
        case RoutingValidationReason::invalid_target:   return "invalid_target";
        case RoutingValidationReason::master_as_source: return "master_as_source";
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

} // namespace xleth
