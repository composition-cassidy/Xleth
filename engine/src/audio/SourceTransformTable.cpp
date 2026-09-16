#include "audio/SourceTransformTable.h"

#include "audio/EffectChainManager.h"
#include "audio/XlethEffectBase.h"

namespace xleth
{
namespace
{
    // Visit every stock effect on every TRACK chain: ascending trackId, then
    // chain order. Negative keys (the -1 master convention) are skipped.
    // Allocation-free — the ascending walk is a repeated min-greater-than scan
    // over the map (bounded by MixEngine::kMaxTracks), not a sorted copy, and
    // the per-chain walk goes through a captureless trampoline.
    template <typename Fn>
    void walkTrackEffects(const EffectChainMap& chains, Fn& fn)
    {
        struct Context { Fn* fn; int trackId; };

        long long prev = -1;   // trackIds < 0 are never visited
        for (;;)
        {
            const EffectChainManager* best = nullptr;
            int bestId = 0;
            bool found = false;
            for (const auto& [trackId, chain] : chains)
            {
                if (static_cast<long long>(trackId) <= prev) continue;
                if (!found || trackId < bestId)
                {
                    bestId = trackId;
                    best   = chain.get();
                    found  = true;
                }
            }
            if (!found) break;
            prev = bestId;
            if (best == nullptr) continue;

            Context ctx{ &fn, bestId };
            best->visitEffectsInChainOrder(&ctx,
                [](void* c, int nodeId, XlethEffectBase* effect)
                {
                    auto* context = static_cast<Context*>(c);
                    (*context->fn)(context->trackId, nodeId, effect);
                });
        }
    }

    SourceTransformNodeStamp stampFor(int trackId, int nodeId, const XlethEffectBase* effect)
    {
        SourceTransformNodeStamp s;
        s.trackId  = trackId;
        s.nodeId   = nodeId;
        s.effect   = effect;
        s.epoch    = effect->sourceTransformEpoch();
        s.bypassed = effect->isBypassed();
        return s;
    }
} // namespace

SourceTransformBuildResult buildTrackSourceTransformTable(const EffectChainMap& chains)
{
    SourceTransformBuildResult result;

    auto collect = [&result](int trackId, int nodeId, XlethEffectBase* effect)
    {
        const auto stamp = stampFor(trackId, nodeId, effect);
        result.snapshot.push_back(stamp);

        if (stamp.bypassed) return;

        SourceTransform t;
        if (!effect->provideSourceTransform(t) || !t.active) return;

        // Walk order is ascending trackId, so this track's entry — if any — is
        // always the last one. Overwriting it is what makes the LAST provider
        // in chain order win.
        if (!result.table.entries.empty() && result.table.entries.back().trackId == trackId)
        {
            result.table.entries.back().transform      = t;
            result.table.entries.back().providerNodeId = nodeId;
        }
        else
        {
            result.table.entries.push_back({ trackId, t, nodeId });
        }
    };
    walkTrackEffects(chains, collect);

    return result;
}

bool sourceTransformSnapshotChanged(const EffectChainMap& chains,
                                    const SourceTransformEpochSnapshot& previous) noexcept
{
    std::size_t cursor  = 0;
    bool        changed = false;

    auto compare = [&](int trackId, int nodeId, XlethEffectBase* effect)
    {
        if (changed) return;
        if (cursor >= previous.size()
            || previous[cursor] != stampFor(trackId, nodeId, effect))
        {
            changed = true;
            return;
        }
        ++cursor;
    };
    walkTrackEffects(chains, compare);

    // Fewer nodes now than when the snapshot was taken: something was removed.
    return changed || cursor != previous.size();
}

} // namespace xleth
