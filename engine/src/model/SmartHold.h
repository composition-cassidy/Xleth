#pragma once
// Smart Hold — decides, per track, which gaps between clips/notes are part of
// the rhythm (hold the picture through them) and which are deliberate blanks
// (let the cell go empty).
//
// The rule is the track's own natural break: sort its gap lengths and look for
// the biggest jump between neighbouring lengths. Short gaps inside a phrase
// cluster together (an eighth-note rest, a quarter rest); the rests between
// phrases are a different order of magnitude (a bar or two). The threshold is
// the geometric midpoint of the widest such jump, so a gap is held when it is
// on the "phrase" side of it.
//
// Pure arithmetic, no JUCE, no Timeline. The renderer mirrors this exactly in
// ui/src/components/timeline/holdLastFrame.js (smartHoldThresholdBeats) so the
// hold zones drawn on the timeline are the gaps the engine actually holds.

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>
#include <vector>

namespace xleth::smarthold {

// A gap shorter than one beat is rhythm, never a deliberate blank.
inline constexpr double kMinBlankGapBeats = 1.0;
// Two gap lengths are "different kinds" of gap only when one is at least this
// many times the other.
inline constexpr double kMinBreakRatio = 2.0;
// No clear break in the gap lengths: hold anything shorter than a bar.
inline constexpr double kFallbackThresholdBeats = 4.0;
// Ratio floor, so a one-tick sliver between two butted clips does not make
// every other gap look like a huge jump.
inline constexpr double kGapFloorBeats = 1.0 / 16.0;
// Shorter than this is not a gap at all (rounding between butted clips).
inline constexpr double kGapEpsilonBeats = 1e-6;

inline constexpr double kHoldAll = std::numeric_limits<double>::infinity();

// gaps: lengths in beats, any order; non-positive / tiny entries are ignored.
// Returns the threshold: a gap is held iff gapBeats <= threshold. Infinity
// means every gap is held.
inline double thresholdBeats(std::vector<double> gaps)
{
    gaps.erase(std::remove_if(gaps.begin(), gaps.end(),
                              [](double g) { return !(g > kGapEpsilonBeats) || !std::isfinite(g); }),
               gaps.end());
    if (gaps.empty()) return kHoldAll;
    std::sort(gaps.begin(), gaps.end());

    double bestRatio = 0.0;
    double bestThreshold = 0.0;
    for (size_t i = 0; i + 1 < gaps.size(); ++i) {
        const double hi = gaps[i + 1];
        if (hi < kMinBlankGapBeats) continue;            // both sides are rhythm
        const double lo = std::max(gaps[i], kGapFloorBeats);
        const double ratio = hi / lo;
        if (ratio >= kMinBreakRatio && ratio > bestRatio) {
            bestRatio = ratio;
            bestThreshold = std::sqrt(lo * hi);
        }
    }
    if (bestRatio > 0.0) return bestThreshold;

    // No break: every gap is the same kind. All short -> all rhythm.
    if (gaps.back() < kMinBlankGapBeats) return kHoldAll;
    return kFallbackThresholdBeats;
}

// intervals: [startBeat, endBeat) of every clip/note on ONE track, any order,
// overlaps allowed. Returns the gap lengths between the merged intervals
// (leading space before the first and trailing space after the last are not
// gaps: nothing comes before / after to hold to).
inline std::vector<double> gapsBetween(std::vector<std::pair<double, double>> intervals)
{
    std::vector<double> gaps;
    if (intervals.size() < 2) return gaps;
    std::sort(intervals.begin(), intervals.end());
    double end = intervals.front().second;
    for (size_t i = 1; i < intervals.size(); ++i) {
        const auto& iv = intervals[i];
        if (iv.first > end) gaps.push_back(iv.first - end);
        end = std::max(end, iv.second);
    }
    return gaps;
}

} // namespace xleth::smarthold
