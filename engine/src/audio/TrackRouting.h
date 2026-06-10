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

} // namespace xleth
