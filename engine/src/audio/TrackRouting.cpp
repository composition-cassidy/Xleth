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

} // namespace xleth
