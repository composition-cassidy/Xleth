#include "TimelineSnapshot.h"

#include "Timeline.h"

#include <chrono>

FrozenTimelineCopy makeFrozenTimelineCopy(const Timeline& live) {
    FrozenTimelineCopy out;
    const auto t0 = std::chrono::steady_clock::now();
    auto copy = std::make_shared<Timeline>(live);   // member-wise deep copy
    const auto t1 = std::chrono::steady_clock::now();
    // The live timeline's invalidator points at MixEngine. The copy must never
    // call it: an export snapshot has nothing to invalidate.
    copy->setClipCacheInvalidator({});
    out.copyMs = std::chrono::duration<double, std::milli>(t1 - t0).count();
    out.timeline = std::move(copy);
    return out;
}
