#include "audio/TrackRouting.h"
#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include <algorithm>
#include <cmath>
#include <unordered_set>
#include <vector>

namespace xleth {

static_assert(RoutePlanSlotInput::kMaxSends == kMaxTrackSends,
              "RoutePlanSlotInput::kMaxSends must mirror kMaxTrackSends");

void fillRoutePlanSlotInput(RoutePlanSlotInput& in, const TrackInfo& t)
{
    in.trackId             = t.id;
    in.outputTargetTrackId = t.outputRoute.targetTrackId;
    in.muted               = t.muted;
    in.solo                = t.solo;
    in.visualOnly          = t.visualOnly;
    in.sendCount           = 0;
    for (const auto& send : t.sends) {
        if (in.sendCount >= RoutePlanSlotInput::kMaxSends) break;
        if (!send.enabled) continue;
        in.sendTargetTrackId[in.sendCount] = send.targetTrackId;
        in.sendGain[in.sendCount]          = send.gain;
        ++in.sendCount;
    }
}

// Every audible + key edge leaving `t` (primary output, sends, sidechain
// routes), Master excluded. Feeder -> consumer, so a consumer must be processed
// after its feeder; the union must stay acyclic.
template <typename Fn>
static void forEachRoutingEdge(const TrackInfo& t, Fn&& fn)
{
    if (t.outputRoute.targetTrackId != -1)
        fn(t.outputRoute.targetTrackId);
    for (const auto& send : t.sends)
        if (send.targetTrackId != -1)
            fn(send.targetTrackId);
    for (const auto& sc : t.sidechainRoutes)
        if (sc.targetTrackId != -1)
            fn(sc.targetTrackId);
}

// True if `from` can reach `sourceTrackId` over existing routing edges.
static bool reachesTrack(const Timeline& timeline, int from, int sourceTrackId)
{
    std::unordered_set<int> visited;
    std::vector<int> stack;
    stack.push_back(from);
    while (!stack.empty()) {
        const int current = stack.back();
        stack.pop_back();
        if (current == sourceTrackId) return true;
        if (current == -1 || visited.count(current)) continue;
        visited.insert(current);
        if (const TrackInfo* t = timeline.getTrack(current))
            forEachRoutingEdge(*t, [&](int next) { stack.push_back(next); });
    }
    return false;
}

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
        case RoutingValidationReason::sidechain_unsupported:   return "sidechain_unsupported";
        case RoutingValidationReason::duplicate_route:         return "duplicate_route";
        case RoutingValidationReason::invalid_gain:            return "invalid_gain";
        case RoutingValidationReason::unknown_route:           return "unknown_route";
        case RoutingValidationReason::duplicate_target:        return "duplicate_target";
        case RoutingValidationReason::too_many_sends:          return "too_many_sends";
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

    // Cycle check: DFS from proposedTargetId over every existing routing edge
    // (outputs, sends, sidechain keys). Reaching sourceTrackId means adding
    // source→proposed would close a cycle.
    if (reachesTrack(timeline, proposedTargetId, sourceTrackId))
        return { RoutingValidationReason::cycle };

    // The new primary must not duplicate one of the source's sends.
    if (const TrackInfo* source = timeline.getTrack(sourceTrackId))
        for (const auto& send : source->sends)
            if (send.targetTrackId == proposedTargetId)
                return { RoutingValidationReason::duplicate_target };

    return { RoutingValidationReason::ok };
}

RoutingValidationResult validateTrackRoutes(const Timeline& timeline,
                                            int sourceTrackId,
                                            int proposedTargetId,
                                            const std::vector<TrackSend>& sends)
{
    if (sourceTrackId == -1)
        return { RoutingValidationReason::master_as_source };
    if (!timeline.getTrack(sourceTrackId))
        return { RoutingValidationReason::unknown_track };
    if (static_cast<int>(sends.size()) > kMaxTrackSends)
        return { RoutingValidationReason::too_many_sends };

    std::vector<int> targets;
    if (proposedTargetId != -1)
        targets.push_back(proposedTargetId);
    for (const auto& send : sends) {
        if (send.targetTrackId == -1)
            return { RoutingValidationReason::invalid_target };
        if (!std::isfinite(send.gain))
            return { RoutingValidationReason::invalid_gain };
        if (std::find(targets.begin(), targets.end(), send.targetTrackId) != targets.end())
            return { RoutingValidationReason::duplicate_target };
        targets.push_back(send.targetTrackId);
    }

    for (const int targetId : targets) {
        if (targetId == sourceTrackId)
            return { RoutingValidationReason::self_route };
        const TrackInfo* target = timeline.getTrack(targetId);
        if (!target)
            return { RoutingValidationReason::unknown_track };
        if (target->visualOnly)
            return { RoutingValidationReason::invalid_target };
    }

    // Only the source's edges change, and the existing graph is acyclic, so a
    // new cycle must run through one of the proposed edges back to the source.
    for (const int targetId : targets)
        if (reachesTrack(timeline, targetId, sourceTrackId))
            return { RoutingValidationReason::cycle };

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
    return reachesTrack(timeline, targetTrackId, sourceTrackId);
}

RoutingValidationResult validateSidechainRoute(const Timeline& timeline,
                                               int sourceTrackId,
                                               const SidechainRoute& route,
                                               const SidechainEffectResolver& resolver,
                                               const SidechainCapabilityResolver& capabilityResolver)
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

    // An empty effect id is a TRACK-LEVEL route (FL "Sidechain to this track"):
    // the key reaches every sidechain-capable effect on the target track, so
    // there is no effect instance to resolve or capability-check.
    const bool trackLevel = route.targetEffectInstanceId.empty();

    if (!std::isfinite(route.gain))
        return { RoutingValidationReason::invalid_gain };

    // routeId must be unique within the source track, and one source carries at
    // most one track-level route per target.
    for (const auto& existing : source->sidechainRoutes) {
        if (existing.routeId == route.routeId)
            return { RoutingValidationReason::duplicate_route };
        if (trackLevel && existing.targetEffectInstanceId.empty()
            && existing.targetTrackId == targetId)
            return { RoutingValidationReason::duplicate_route };
    }

    if (!trackLevel) {
        // Effect-instance resolution (Prompt 4A lookup, supplied by the engine).
        // When no resolver is supplied (pure-model context) the check is skipped.
        if (resolver && !resolver(targetId, route.targetEffectInstanceId))
            return { RoutingValidationReason::unknown_effect_instance };

        // Capability gate (VST-SC.3): a structurally-resolvable target that
        // exposes no usable sidechain input bus (e.g. a stereo-only VST) is
        // rejected up front, rather than silently storing a route that could
        // never deliver a key. Only consulted when both resolvers are supplied
        // and the existence check passed.
        if (capabilityResolver && !capabilityResolver(targetId, route.targetEffectInstanceId))
            return { RoutingValidationReason::sidechain_unsupported };
    }

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
    auto slotOf = [&](int trackId) -> int {
        for (int t = 0; t < count; ++t)
            if (slots[t].trackId == trackId) return t;
        return -1;
    };

    for (int s = 0; s < count; ++s) {
        out.outputTargetSlot[s] = -1;
        out.audible[s]          = false;
        out.topoOrder[s]        = s;
        out.sendCount[s]        = 0;

        const int targetId = slots[s].outputTargetTrackId;
        if (targetId == -1) continue;

        const int targetSlot = slotOf(targetId);

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

    // ── Resolve sends (FL multi-wiring) ───────────────────────────────────────
    // Missing / self / visual-only / Master / duplicate targets are dropped
    // silently (the mutation layer rejects them; this is the defensive path).
    for (int s = 0; s < count; ++s) {
        int n = slots[s].sendCount;
        if (n < 0) n = 0;
        if (n > RoutePlan::kMaxSends) n = RoutePlan::kMaxSends;
        for (int k = 0; k < n; ++k) {
            const int targetId = slots[s].sendTargetTrackId[k];
            if (targetId == -1) continue;
            const int t = slotOf(targetId);
            if (t < 0 || t == s || slots[t].visualOnly) continue;
            if (t == out.outputTargetSlot[s]) continue;
            bool dup = false;
            for (int j = 0; j < out.sendCount[s]; ++j)
                if (out.sendTargetSlot[s][j] == t) { dup = true; break; }
            if (dup) continue;
            const float g = slots[s].sendGain[k];
            const int idx = out.sendCount[s]++;
            out.sendTargetSlot[s][idx] = t;
            out.sendGain[s][idx] = std::isfinite(g) ? std::clamp(g, 0.0f, 2.0f) : 1.0f;
        }
    }

    // ── Topological order (Kahn): source before target ────────────────────────
    // Edges: s → outputTargetSlot[s] and s → every send target. A target's
    // in-degree counts its sources.
    int inDegree[RoutePlan::kMaxSlots] = {};
    for (int s = 0; s < count; ++s) {
        const int t = out.outputTargetSlot[s];
        if (t >= 0) ++inDegree[t];
        for (int k = 0; k < out.sendCount[s]; ++k)
            ++inDegree[out.sendTargetSlot[s][k]];
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
        for (int k = 0; k < out.sendCount[s]; ++k) {
            const int st = out.sendTargetSlot[s][k];
            if (--inDegree[st] == 0)
                queue[qTail++] = st;
        }
    }

    if (placed != count) {
        // Cycle — impossible after mutation-layer validation. Fail closed:
        // all-to-Master, no sends, identity processing order.
        out.cycleDetected = true;
        for (int s = 0; s < count; ++s) {
            out.outputTargetSlot[s] = -1;
            out.sendCount[s]        = 0;
            out.topoOrder[s]        = s;
        }
    }

    // ── Mute / solo closure over output + send edges ──────────────────────────
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
        //   upstream(s) ∪ {s} ∪ downstream(s), over every audible edge.
        // Upstream + self (reverse topo, targets first): a slot is audible when
        // any of its edges reaches a soloed slot.
        bool reachesSolo[RoutePlan::kMaxSlots] = {};
        for (int oi = count - 1; oi >= 0; --oi) {
            const int s = out.topoOrder[oi];
            bool r = slots[s].solo;
            const int t = out.outputTargetSlot[s];
            if (!r && t >= 0) r = reachesSolo[t];
            for (int k = 0; !r && k < out.sendCount[s]; ++k)
                r = reachesSolo[out.sendTargetSlot[s][k]];
            reachesSolo[s] = r;
        }
        // Downstream (forward topo): every destination of a soloed path.
        bool downstream[RoutePlan::kMaxSlots] = {};
        for (int oi = 0; oi < count; ++oi) {
            const int s = out.topoOrder[oi];
            if (slots[s].solo) downstream[s] = true;
            if (!downstream[s]) continue;
            const int t = out.outputTargetSlot[s];
            if (t >= 0) downstream[t] = true;
            for (int k = 0; k < out.sendCount[s]; ++k)
                downstream[out.sendTargetSlot[s][k]] = true;
        }
        for (int s = 0; s < count; ++s)
            out.audible[s] = reachesSolo[s] || downstream[s];
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
        for (int k = 0; k < RoutePlan::kMaxSends; ++k)
            out.sendCompensationSamples[s][k] = 0;
    }
    out.maxPathLatencySamples = 0;

    // An edge s → t (t < 0 = Master) carries audio to Master iff s contributes
    // and t is Master or itself contributes.
    auto edgeLive = [&](int s, int t) -> bool {
        return out.contributesToMaster[s] && (t < 0 || out.contributesToMaster[t]);
    };

    // Pass 1 — reverse topo (targets before sources): a slot contributes to the
    // Master sum only when it is audible and not visual-only AND at least one of
    // its edges (primary or send) reaches Master through contributing hops. An
    // audible source dead-ended into a muted bus contributes nothing, so it can
    // never inflate a junction or the max path latency.
    for (int oi = count - 1; oi >= 0; --oi) {
        const int s = plan.topoOrder[oi];
        const bool eligible = plan.audible[s] && !slots[s].visualOnly;
        const int  t = plan.outputTargetSlot[s];
        bool reaches = (t < 0 || out.contributesToMaster[t]);
        for (int k = 0; !reaches && k < plan.sendCount[s]; ++k)
            reaches = out.contributesToMaster[plan.sendTargetSlot[s][k]];
        out.contributesToMaster[s] = eligible && reaches;
    }

    // Pass 2 — forward topo (sources before targets): a branch's raw arrival at
    // its destination is the aligned routed input it carries plus its own chain
    // latency (the same for every edge leaving s). Each junction's input latency
    // is the max raw arrival over its live edges; the Master junction's max is
    // the max path latency.
    auto raiseJunction = [&](int s, int t) {
        if (!edgeLive(s, t)) return;
        const int arrival = out.branchArrivalLatencySamples[s];
        if (t < 0) {
            if (arrival > out.maxPathLatencySamples)
                out.maxPathLatencySamples = arrival;
        } else if (arrival > out.junctionInputLatencySamples[t]) {
            out.junctionInputLatencySamples[t] = arrival;
        }
    };
    for (int oi = 0; oi < count; ++oi) {
        const int s = plan.topoOrder[oi];
        const int chainLat = chainLatencySamples[s] > 0 ? chainLatencySamples[s] : 0;
        out.branchArrivalLatencySamples[s] = out.junctionInputLatencySamples[s] + chainLat;

        if (!out.contributesToMaster[s]) continue;
        raiseJunction(s, plan.outputTargetSlot[s]);
        for (int k = 0; k < plan.sendCount[s]; ++k)
            raiseJunction(s, plan.sendTargetSlot[s][k]);
    }

    // Pass 3 — edge compensation: align every live edge to its own destination
    // junction's input latency (≥ 0 by construction of the maxima).
    auto compFor = [&](int s, int t) -> int {
        if (!edgeLive(s, t)) return 0;
        const int junctionLatency = (t < 0) ? out.maxPathLatencySamples
                                            : out.junctionInputLatencySamples[t];
        const int comp = junctionLatency - out.branchArrivalLatencySamples[s];
        return comp > 0 ? comp : 0;
    };
    for (int s = 0; s < count; ++s) {
        out.branchCompensationSamples[s] = compFor(s, plan.outputTargetSlot[s]);
        for (int k = 0; k < plan.sendCount[s]; ++k)
            out.sendCompensationSamples[s][k] = compFor(s, plan.sendTargetSlot[s][k]);
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

        if (!tp.enabled || !tp.effectResolved) continue;

        const int s = tp.sourceSlot;
        if (s < 0 || s >= count) continue;
        if (slots[s].muted || slots[s].visualOnly) continue;   // key dies with source

        // Resolve target trackId → slot.
        int targetSlot = -1;
        for (int t = 0; t < count; ++t)
            if (slots[t].trackId == tp.targetTrackId) { targetSlot = t; break; }
        if (targetSlot < 0 || targetSlot == s) continue;       // stale / self
        if (!plan.audible[targetSlot] || slots[targetSlot].visualOnly) continue;

        // The key buffer is per TARGET TRACK: two routes carrying the same
        // source tap into the same target (a track-level route plus an
        // effect-level one, or two keyed compressors) must sum it ONCE, or the
        // key doubles (+6 dB).
        bool dup = false;
        for (int j = 0; j < out.tapCount; ++j)
            if (out.tapSourceSlot[j] == s && out.tapTargetSlot[j] == targetSlot
                && out.tapPreFader[j] == tp.preFader) { dup = true; break; }
        if (dup) continue;

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
        for (int k = 0; k < plan.sendCount[s]; ++k)
            ++inDegree[plan.sendTargetSlot[s][k]];
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
        for (int k = 0; k < plan.sendCount[s]; ++k) {
            const int st = plan.sendTargetSlot[s][k];
            if (--inDegree[st] == 0)
                queue[qTail++] = st;
        }

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
