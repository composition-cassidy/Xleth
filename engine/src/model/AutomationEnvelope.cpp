#include "AutomationEnvelope.h"

#include <algorithm>
#include <cmath>

namespace xleth::automation {

// ===========================================================================
// Evaluation
// ===========================================================================

double evaluatePointRange(const AutomationPoint* points,
                          int count,
                          int64_t tick,
                          double  fallback) noexcept
{
    if (points == nullptr || count <= 0) return fallback;

    if (tick <= points[0].tick.ticks)          return points[0].value;
    if (tick >= points[count - 1].tick.ticks)  return points[count - 1].value;

    // Binary search for the last point at or before `tick`. Unlike ParamTrack
    // (2-3 keys after migration, where a linear scan wins), a hand-drawn
    // automation envelope routinely carries dozens to hundreds of points and is
    // evaluated once per parameter per audio block, so the log(n) form is the
    // one that keeps the audio callback's cost flat as a user draws.
    int lo = 0, hi = count - 1;
    while (lo + 1 < hi) {
        const int mid = lo + (hi - lo) / 2;
        if (points[mid].tick.ticks <= tick) lo = mid;
        else                                hi = mid;
    }

    const AutomationPoint& a = points[lo];
    const AutomationPoint& b = points[lo + 1];

    const int64_t span = b.tick.ticks - a.tick.ticks;
    if (span <= 0) return b.value;   // degenerate segment — snap to the far end

    const double x = static_cast<double>(tick - a.tick.ticks) / static_cast<double>(span);

    // v1: every curve type evaluates linearly. Tension is carried by the data
    // model and the file format so its UI can ship without a migration; this is
    // the single branch point it will grow into.
    return a.value + (b.value - a.value) * x;
}

double evaluatePoints(const std::vector<AutomationPoint>& points,
                      int64_t tick,
                      double  fallback) noexcept
{
    return evaluatePointRange(points.empty() ? nullptr : points.data(),
                              static_cast<int>(points.size()), tick, fallback);
}

// ===========================================================================
// Mutation
// ===========================================================================

namespace {

AutomationPoint sanitize(AutomationPoint p)
{
    if (!std::isfinite(p.value))   p.value = 0.0;
    if (!std::isfinite(p.tension)) p.tension = 0.0;
    p.value = std::clamp(p.value, 0.0, 1.0);
    return p;
}

} // namespace

std::size_t insertPoint(std::vector<AutomationPoint>& points, AutomationPoint p)
{
    p = sanitize(p);

    // Replace an existing point at the same tick rather than creating a
    // zero-width segment that evaluate would have to special-case.
    for (std::size_t i = 0; i < points.size(); ++i) {
        if (points[i].tick.ticks == p.tick.ticks) {
            points[i] = p;
            return i;
        }
    }

    auto pos = std::lower_bound(points.begin(), points.end(), p.tick.ticks,
                                [](const AutomationPoint& e, int64_t t) {
                                    return e.tick.ticks < t;
                                });
    const std::size_t idx = static_cast<std::size_t>(pos - points.begin());
    points.insert(pos, p);
    return idx;
}

bool removePoint(std::vector<AutomationPoint>& points, std::size_t index)
{
    if (index >= points.size()) return false;
    points.erase(points.begin() + static_cast<std::ptrdiff_t>(index));
    return true;
}

std::size_t movePoint(std::vector<AutomationPoint>& points,
                      std::size_t index, int64_t newTick, double newValue)
{
    if (index >= points.size()) return static_cast<std::size_t>(-1);
    AutomationPoint p = points[index];
    p.tick.ticks = newTick;
    p.value      = newValue;
    points.erase(points.begin() + static_cast<std::ptrdiff_t>(index));
    return insertPoint(points, p);
}

bool setPointCurve(std::vector<AutomationPoint>& points, std::size_t index,
                   AutomationCurveType curveType, double tension)
{
    if (index >= points.size()) return false;
    points[index].curveType = curveType;
    points[index].tension   = std::isfinite(tension) ? tension : 0.0;
    return true;
}

void normalizePoints(std::vector<AutomationPoint>& points)
{
    for (auto& p : points) p = sanitize(p);

    std::stable_sort(points.begin(), points.end(),
                     [](const AutomationPoint& a, const AutomationPoint& b) {
                         return a.tick.ticks < b.tick.ticks;
                     });

    // Collapse duplicate ticks, last one wins — matches insertPoint's
    // replace-in-place rule so a loaded file and a hand-built list agree.
    if (points.size() < 2) return;
    std::vector<AutomationPoint> out;
    out.reserve(points.size());
    for (const auto& p : points) {
        if (!out.empty() && out.back().tick.ticks == p.tick.ticks) out.back() = p;
        else                                                       out.push_back(p);
    }
    points.swap(out);
}

} // namespace xleth::automation
