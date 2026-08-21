#pragma once

// ===========================================================================
// AutomationEnvelope — point-list invariant + intra-clip evaluation.
// ===========================================================================
//
// The tick-absolute sibling of paramtrack::ParamTrack (model/ParamTrack.h).
// Same discipline, different domain:
//
//   ParamTrack            AutomationEnvelope
//   ----------            ------------------
//   normalized 0..1 t     960-PPQ intra-clip TickTime
//   cubic-bezier easing   AutomationCurveType (+ tension, reserved)
//   clamp at both ends    clamp at both ends (the caller supplies gap/hold
//                         semantics — see audio/AutomationPlan.h)
//
// ParamTrack is not reused because its whole contract is "the caller maps real
// time into 0..1"; automation clips are placements whose points are musical
// ticks, so mapping them through a 0..1 window would either lose tick precision
// or force every caller to re-derive the window. The invariant rules, however,
// are copied deliberately so a reader of one file already knows the other:
//
//   • points stay sorted ascending by tick — enforced on insert, never assumed;
//   • inserting at an existing tick REPLACES that point rather than creating a
//     zero-width segment evaluation would have to special-case;
//   • evaluating before the first point yields the first point's value, after
//     the last point yields the last point's value (the "hold" behaviour the
//     spec requires both inside a clip and in the gap after it).
//
// Everything here is pure and deterministic: evaluate() is a function of the
// point list and the tick alone, with no state, no clock, and no allocation, so
// live playback and OfflineRenderer export cannot produce different values for
// the same tick. Mutation allocates (std::vector) and is main-thread only.

#include <cstdint>
#include <vector>

#include "TimelineTypes.h"

namespace xleth::automation {

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

// Value of `points` at intra-clip tick `tick`.
//   empty points      -> `fallback` (the parameter's base value)
//   before first tick -> first point's value
//   after  last tick  -> last point's value  (hold)
//   otherwise         -> the segment interpolated per its own curve
//
// v1 evaluates every segment linearly. AutomationCurveType::Tension is stored
// and round-tripped but deliberately falls through to the linear branch — see
// the enum's comment; when the tension UI ships, this is the ONE function that
// grows a branch, and no persisted file changes shape.
//
// AUDIO THREAD SAFE: no allocation, no locks, no logging, reads only the
// caller-owned vector.
double evaluatePoints(const std::vector<AutomationPoint>& points,
                      int64_t tick,
                      double  fallback) noexcept;

// Same, over a raw contiguous range — the form the flattened AutomationPlan
// uses so the audio thread never touches a std::vector.
double evaluatePointRange(const AutomationPoint* points,
                          int count,
                          int64_t tick,
                          double  fallback) noexcept;

// ---------------------------------------------------------------------------
// Mutation — maintains the sorted-by-tick invariant. Main thread only.
// ---------------------------------------------------------------------------

// Inserts at the position that keeps points sorted ascending by tick. A point
// at an existing tick REPLACES it (mirrors paramtrack::insertKeyframe). The
// value is clamped to [0,1]. Returns the index it landed at.
std::size_t insertPoint(std::vector<AutomationPoint>& points, AutomationPoint p);

// Returns false when index is out of range.
bool removePoint(std::vector<AutomationPoint>& points, std::size_t index);

// Moves the point at `index` to (newTick, newValue), re-sorting. Returns the new
// index, or npos when index is out of range. Collides-and-replaces exactly like
// insertPoint, so dragging one point onto another merges rather than stacking.
std::size_t movePoint(std::vector<AutomationPoint>& points,
                      std::size_t index, int64_t newTick, double newValue);

// Returns false when index is out of range.
bool setPointCurve(std::vector<AutomationPoint>& points, std::size_t index,
                   AutomationCurveType curveType, double tension);

// Restores the sorted invariant on a list built by hand or read from a
// hand-edited project file. Also collapses duplicate ticks (last one wins) and
// clamps values into [0,1]. Called on every load path.
void normalizePoints(std::vector<AutomationPoint>& points);

} // namespace xleth::automation
