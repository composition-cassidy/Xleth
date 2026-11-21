#pragma once

#include "audio/SourceTransformCapability.h"

#include <algorithm>
#include <cstdint>
#include <memory>
#include <unordered_map>
#include <vector>

class EffectChainManager;
class XlethEffectBase;

// ─── TrackSourceTransformTable ──────────────────────────────────────────────
//
// trackId -> the SourceTransform that track's effect chain asks for.
//
// Built on the message thread by buildTrackSourceTransformTable() and published
// by MixEngine through one std::atomic<std::shared_ptr<const Table>> (the
// ChainSnapshot shape). Immutable once published. Consumed by MixEngine's
// audio-clip render path (ClipRenderCache fx lane + the clip-loop Mix blend)
// and by its pattern-block loop (Sampler voice-spawn transpose; Mix, method
// and formant are inert there).
//
// RULES (every one of these is pinned by test_source_transform_table):
//
//   * Only ACTIVE transforms enter the table. A track with no provider, an
//     inactive provider, or only bypassed providers has NO entry.
//
//   * Last provider wins. When several active providers sit on one chain, the
//     LAST one in chain order (AudioGraph::visitEffectsInChainOrder) is the
//     track's transform. Deterministic, and it matches signal flow: the node
//     nearest the output is the one whose render the listener would hear last.
//
//   * Bypassed providers are ignored. A bypassed Pitch Shifter must not
//     transpose its track. Bypass is not a parameter and does not move
//     sourceTransformEpoch(), so it is tracked in the stamp snapshot instead.
//
//   * Only TRACK chains. The input map is MixEngine::effectChains_, whose keys
//     are trackIds (>= 0). The master chain lives in a separate member and is
//     never passed in; the -1 "master" trackId convention is excluded here as
//     well, so a stray negative key can never produce an entry. A Clip-mode
//     shifter anywhere but a track chain is inert, not an error.

namespace xleth
{
    struct TrackSourceTransformEntry
    {
        int             trackId = -1;
        SourceTransform transform;

        // The chain node that provided `transform` (the last active provider in
        // chain order). Identity only, never render identity: it is how a
        // realtime consumer finds the node whose smoothed `mix` it blends at,
        // through the chain's GraphRealtimeView, without walking the chain.
        int             providerNodeId = -1;
    };

    struct TrackSourceTransformTable
    {
        std::uint64_t generation = 0;

        // Sorted by trackId, one entry per track, active transforms only.
        std::vector<TrackSourceTransformEntry> entries;

        // Any thread holding the table: binary search, no allocation.
        const TrackSourceTransformEntry* findEntry(int trackId) const noexcept
        {
            const auto it = std::lower_bound(
                entries.begin(), entries.end(), trackId,
                [](const TrackSourceTransformEntry& e, int id) { return e.trackId < id; });
            return (it != entries.end() && it->trackId == trackId) ? &*it : nullptr;
        }

        const SourceTransform* find(int trackId) const noexcept
        {
            const auto* e = findEntry(trackId);
            return e != nullptr ? &e->transform : nullptr;
        }
    };

    // One stamp per stock effect node on a track chain, in walk order (ascending
    // trackId, then chain order). The sequence as a whole is the change key:
    // an added/removed/replaced/reordered node, a bypass toggle, or an epoch
    // advance all make it differ.
    //
    // `effect` is an IDENTITY TOKEN ONLY and is never dereferenced from a
    // snapshot. nodeId restarts at 1 in every graph, so on its own it cannot
    // tell a rebuilt chain's effect from the old one's; graphSerial (one per
    // graph, never reused) does, so a new effect at a recycled address with the
    // same nodeId and epoch still differs.
    struct SourceTransformNodeStamp
    {
        int                    trackId  = -1;
        std::uint64_t          graphSerial = 0;
        int                    nodeId   = -1;
        const XlethEffectBase* effect   = nullptr;
        std::uint64_t          epoch    = 0;
        bool                   bypassed = false;

        bool operator==(const SourceTransformNodeStamp& o) const noexcept
        {
            return trackId == o.trackId && graphSerial == o.graphSerial && nodeId == o.nodeId && effect == o.effect
                && epoch == o.epoch && bypassed == o.bypassed;
        }
        bool operator!=(const SourceTransformNodeStamp& o) const noexcept { return !(*this == o); }
    };

    using SourceTransformEpochSnapshot = std::vector<SourceTransformNodeStamp>;

    using EffectChainMap = std::unordered_map<int, std::shared_ptr<EffectChainManager>>;

    struct SourceTransformBuildResult
    {
        TrackSourceTransformTable    table;      // generation left at 0 — the publisher stamps it
        SourceTransformEpochSnapshot snapshot;
    };

    // PURE (modulo reading the chains). Walk `chains`, ask every node for its
    // SourceTransform, and return the table plus the stamp snapshot that
    // describes exactly the state it was built from. Allocates. MESSAGE THREAD
    // (provideSourceTransform is message-thread only).
    SourceTransformBuildResult buildTrackSourceTransformTable(const EffectChainMap& chains);

    // True iff walking `chains` now would produce a stamp sequence different
    // from `previous`. ALLOCATION-FREE: walks the chains in place against a
    // cursor into `previous`, so the no-change poll costs no heap traffic.
    // MESSAGE THREAD.
    bool sourceTransformSnapshotChanged(const EffectChainMap& chains,
                                        const SourceTransformEpochSnapshot& previous) noexcept;
}
