// ParentMath.cpp: the Timeline glue of model/ParentMath.h (message thread).
// See the header for the geometry; docs/XLETH_MOTION_VIEW_DESIGN.md R6-R8.

#include "model/ParentMath.h"

#include "model/Timeline.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace parentmath {

const char* parentRejectToString(ParentReject r) {
    switch (r) {
        case ParentReject::UnknownTrack: return "unknown_track";
        case ParentReject::Self:         return "self";
        case ParentReject::Cycle:        return "cycle";
        case ParentReject::TooDeep:      return "too_deep";
        default:                         return "";
    }
}

int ancestorCount(const Timeline& tl, int trackId) {
    std::vector<int> seen{ trackId };
    const std::size_t cap = tl.getAllTracks().size() + 1;
    const TrackInfo* t = tl.getTrack(trackId);
    int n = 0;
    while (t && t->parentTrackId >= 0 && seen.size() <= cap) {
        const int p = t->parentTrackId;
        if (std::find(seen.begin(), seen.end(), p) != seen.end()) break;   // damaged data: a loop
        const TrackInfo* pt = tl.getTrack(p);
        if (!pt) break;                                                      // dangling: no parent
        seen.push_back(p);
        ++n;
        t = pt;
    }
    return n;
}

namespace {

// Height of the subtree below `id`. `path` holds the ids on the way down so a
// loop in damaged data cannot recurse forever.
int heightBelow(const std::vector<const TrackInfo*>& all, int id, std::vector<int>& path) {
    int best = 0;
    path.push_back(id);
    for (const TrackInfo* t : all) {
        if (t->parentTrackId != id || t->id == id) continue;
        if (std::find(path.begin(), path.end(), t->id) != path.end()) continue;
        best = std::max(best, 1 + heightBelow(all, t->id, path));
    }
    path.pop_back();
    return best;
}

} // namespace

int descendantHeight(const Timeline& tl, int trackId) {
    const std::vector<const TrackInfo*> all = tl.getAllTracks();
    std::vector<int> path;
    return heightBelow(all, trackId, path);
}

ParentReject validateParent(const Timeline& tl, int childId, int newParentId) {
    if (!tl.getTrack(childId)) return ParentReject::UnknownTrack;
    if (newParentId < 0) return ParentReject::None;                    // detach
    if (newParentId == childId) return ParentReject::Self;
    if (!tl.getTrack(newParentId)) return ParentReject::UnknownTrack;
    // Loop: the new parent's chain (as stored) already reaches the child.
    {
        std::vector<int> seen{ newParentId };
        const TrackInfo* t = tl.getTrack(newParentId);
        while (t && t->parentTrackId >= 0) {
            const int p = t->parentTrackId;
            if (p == childId) return ParentReject::Cycle;
            if (std::find(seen.begin(), seen.end(), p) != seen.end()) break;
            seen.push_back(p);
            t = tl.getTrack(p);
        }
    }
    // Depth: the child would sit under (1 + the parent's ancestors) tracks,
    // and its deepest descendant that many levels further down.
    const int depth = 1 + ancestorCount(tl, newParentId) + descendantHeight(tl, childId);
    if (depth > kMaxParentDepth) return ParentReject::TooDeep;
    return ParentReject::None;
}

Similarity chainAt(const Timeline& tl, const GridLayout& layout, int childId, int firstParent,
                   double tick, double pxW, double pxH) {
    Similarity sims[kMaxParentDepth];
    int n = 0;
    int seen[kMaxParentDepth + 1] = { childId };
    int seenCount = 1;
    int cur = firstParent;
    while (cur >= 0 && n < kMaxParentDepth) {
        bool loop = false;
        for (int i = 0; i < seenCount; ++i) loop = loop || seen[i] == cur;
        if (loop) break;
        const TrackInfo* t = tl.getTrack(cur);
        if (!t) break;                                     // dangling: the chain ends
        seen[seenCount++] = cur;
        HomeUv h;
        if (homeRectUv(layout, findPlacement(layout, cur), t->gapScaleOverride, h)) {
            sims[n] = parentSimilarity(toPixels(h, pxW, pxH), lensroam::roamAtTick(t->roam, tick));
        } else {
            sims[n] = Similarity{};                        // not placed: identity, keep climbing
        }
        ++n;
        cur = t->parentTrackId;
    }
    return composeChain(sims, n);
}

KeepOnScreen keepOnScreen(const Timeline& tl, int childId, int newParentId, double tick) {
    KeepOnScreen out;
    const TrackInfo* child = tl.getTrack(childId);
    if (!child) return out;
    out.solve.base = child->roam.base;
    // Clamped to [0, 2^53] before the int64 cast (out of range is UB); the
    // bridge parsers reject larger ticks, this guards every other caller.
    constexpr double kMaxTick = 9007199254740992.0;
    const double t = std::isfinite(tick) && tick > 0.0 ? std::min(tick, kMaxTick) : 0.0;
    const GridLayout layout = tl.gridLayoutAt(TickTime{ static_cast<int64_t>(std::floor(t)) });
    HomeUv hu;
    if (!homeRectUv(layout, findPlacement(layout, childId), child->gapScaleOverride, hu)) return out;
    out.placed = true;
    const double pxW = layout.canvasWidth  > 0 ? layout.canvasWidth  : 1920;
    const double pxH = layout.canvasHeight > 0 ? layout.canvasHeight : 1080;
    const Home home = toPixels(hu, pxW, pxH);
    const Similarity oldChain = chainAt(tl, layout, childId, child->parentTrackId, t, pxW, pxH);
    const Similarity newChain = chainAt(tl, layout, childId, newParentId, t, pxW, pxH);
    bool keyed[kLensRoamChannels];
    for (int c = 0; c < kLensRoamChannels; ++c)
        keyed[c] = lensroam::roamChannelKeyed(child->roam, static_cast<RoamChannel>(c));
    out.solve = solveKeepOnScreen(home, lensroam::roamAtTick(child->roam, t), child->roam.base,
                                  keyed, oldChain, newChain);
    return out;
}

} // namespace parentmath
