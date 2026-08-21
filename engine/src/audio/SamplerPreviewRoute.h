#pragma once

#include <algorithm>
#include <vector>

namespace xleth {

// ─── Sampler preview routing ────────────────────────────────────────────────
// When the transport is stopped and the user auditions a sample — from the
// Sampler panel's keyboard or from the Piano Roll — the preview sampler is
// rendered outside the track pipeline, so it is heard completely dry. That is
// wrong whenever the sample "belongs" to a track: the user has already built an
// effect rack for it and expects to hear it.
//
// This resolves WHICH track's effect rack a preview should be pushed through.
//
// The mode is a user setting:
//   Dedicated — follow the sample's own track (the default; see below).
//   Selected  — always use whatever track is currently selected.
//   Off       — no chain; audition raw, the historical behavior.
//
// In Dedicated mode a sample is "dedicated" to a track when every pattern track
// that plays it is the same track. If it is spread across several tracks that
// all feed the SAME bus, the bus is used instead — that bus is the one place
// their processing is guaranteed to be shared. If they fan out to different
// destinations there is no single correct rack, so the preview stays dry rather
// than inventing an answer.

enum class SamplerPreviewRouteMode
{
    Dedicated = 0,
    Selected  = 1,
    Off       = 2,
};

// A pattern track that plays some region, paired with where its output goes.
// outputTargetTrackId is -1 for Master.
struct PreviewRouteTrack
{
    int trackId             = -1;
    int outputTargetTrackId = -1;
};

// Sentinel for "no chain — play the preview dry".
inline constexpr int kPreviewRouteNone = -1;

// Core resolution for Dedicated mode. `tracks` is every pattern track that
// hosts a block referencing the region (duplicates tolerated). Returns the
// track id whose effect chain should process the preview, or kPreviewRouteNone.
inline int resolveDedicatedPreviewTrack(const std::vector<PreviewRouteTrack>& tracks)
{
    if (tracks.empty()) return kPreviewRouteNone;

    // One distinct track plays it — the simple, overwhelmingly common case.
    const int firstTrack = tracks.front().trackId;
    const bool singleTrack = std::all_of(
        tracks.begin(), tracks.end(),
        [firstTrack](const PreviewRouteTrack& t) { return t.trackId == firstTrack; });
    if (singleTrack) return firstTrack;

    // Several tracks: fall back to their shared bus, if they truly share one.
    // Master (-1) does not count — everything reaches Master eventually, so
    // treating it as "the shared bus" would route every scattered sample
    // through the master chain, which is not a per-sample rack at all.
    const int firstTarget = tracks.front().outputTargetTrackId;
    if (firstTarget < 0) return kPreviewRouteNone;

    const bool sharedBus = std::all_of(
        tracks.begin(), tracks.end(),
        [firstTarget](const PreviewRouteTrack& t) { return t.outputTargetTrackId == firstTarget; });
    return sharedBus ? firstTarget : kPreviewRouteNone;
}

// Full resolution across all three modes. `selectedTrackId` is only consulted in
// Selected mode; `tracks` only in Dedicated mode.
inline int resolvePreviewRoute(SamplerPreviewRouteMode mode,
                               const std::vector<PreviewRouteTrack>& tracks,
                               int selectedTrackId)
{
    switch (mode)
    {
        case SamplerPreviewRouteMode::Off:       return kPreviewRouteNone;
        case SamplerPreviewRouteMode::Selected:  return selectedTrackId;
        case SamplerPreviewRouteMode::Dedicated: return resolveDedicatedPreviewTrack(tracks);
    }
    return kPreviewRouteNone;
}

} // namespace xleth
