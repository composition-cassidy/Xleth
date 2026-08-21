#pragma once

// ===========================================================================
// ParamTrack — generic keyframe animation core.
// ===========================================================================
//
// A ParamTrack is a sorted list of keyframes over a NORMALIZED 0..1 window,
// plus a constant fallback for the non-animated case. It carries no notion of
// duration, tempo, or wall time: mapping real time into 0..1 is the caller's
// job. That is what lets the same track drive the live preview and the offline
// export from two different clocks without the two being able to drift.
//
// Segment easing is CSS cubic-bezier semantics with fixed (0,0)/(1,1)
// endpoints — see util/ParamTrackEase.h, which is the ONLY easing evaluator
// ParamTrack uses.
//
// Evaluation is allocation-free and lock-free. Track construction is not
// (std::vector), but it runs on the video thread at note-trigger time, never
// on the audio callback.

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "../util/ParamTrackEase.h"

namespace paramtrack {

// ---------------------------------------------------------------------------
// Keyframe
// ---------------------------------------------------------------------------
struct Keyframe {
    // Normalized position within the animation window, 0..1.
    double t = 0.0;

    // Unwrapped, un-normalized channel value. See the note on the canonical
    // interpolation space in TimelineTypes.h (ZprTracks) — for zoom this is
    // log2 of the linear factor, for rotation it is unwrapped degrees.
    double value = 0.0;

    // Cubic-bezier control points for the segment STARTING at this keyframe.
    // Meaningless on the last keyframe. Defaults describe y = x.
    double p1x = 1.0 / 3.0;
    double p1y = 1.0 / 3.0;
    double p2x = 2.0 / 3.0;
    double p2y = 2.0 / 3.0;
};

// ---------------------------------------------------------------------------
// ParamTrack
// ---------------------------------------------------------------------------
struct ParamTrack {
    // Sorted ascending by t. The invariant is enforced on insert, not assumed.
    std::vector<Keyframe> keys;

    // Used when keys is empty — a parameter that is set but not animated.
    double constantValue = 0.0;

    bool animated() const { return !keys.empty(); }
};

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
//
// normalizedTime is clamped to the track's own key range:
//   - empty keys      -> constantValue
//   - before first key -> first key's value
//   - after last key   -> last key's value  (this is the "hold at target"
//                         behaviour the compositor spec requires)
double evaluate(const ParamTrack& track, double normalizedTime);

// ---------------------------------------------------------------------------
// Mutation — maintains the sorted-by-t invariant
// ---------------------------------------------------------------------------

// Inserts at the position that keeps keys sorted ascending by t. A key at an
// existing t REPLACES it rather than creating a duplicate, so evaluation never
// sees a zero-width segment. Returns the index it landed at.
std::size_t insertKeyframe(ParamTrack& track, const Keyframe& k);

// Returns false when index is out of range.
bool removeKeyframe(ParamTrack& track, std::size_t index);

// Moves the key at index to a new t, re-sorting. Returns the new index, or
// npos when index is out of range.
std::size_t moveKeyframe(ParamTrack& track, std::size_t index, double newT);

// Returns false when index is out of range.
bool setKeyframeValue(ParamTrack& track, std::size_t index, double value);
bool setKeyframeCurve(ParamTrack& track, std::size_t index, const EaseCurve& c);

// Restores the sorted invariant on a track built by hand or loaded from a
// malformed payload. Also collapses duplicate t values (last one wins).
void normalize(ParamTrack& track);

// ---------------------------------------------------------------------------
// Time reversal — for On-end: Ping-pong
// ---------------------------------------------------------------------------
//
// Writes into `out` the track that satisfies evaluate(out, t) == evaluate(in, 1-t)
// for every t, INCLUDING the easing shape of each segment — not just a mirrored
// evaluation. Reflecting t alone (evaluate(in, 1-t) computed on the fly) would
// keep each segment's bezier control points as authored, which silently swaps
// ease-in for ease-out on the backward pass; the segment's own curve has to be
// time-reversed too. For a forward segment cubic-bezier(a,b,c,d), the reversed
// segment is cubic-bezier(1-c, 1-d, 1-a, 1-b) (standard bezier-reversal
// identity: g(x) = 1 - f(1-x) has control points (1-c,1-d,1-a,1-b) when f has
// (a,b,c,d)). Verified in test_animation_manager.cpp: forward eval at t=0.3
// equals reverse eval at t=0.7 for an asymmetric curve.
//
// `out`'s vector is resized, not reassigned — reuses existing capacity so a
// track rebuilt on every ping-pong direction flip allocates only once.
void reverseInto(ParamTrack& out, const ParamTrack& in);

// ---------------------------------------------------------------------------
// Legacy easing migration
// ---------------------------------------------------------------------------
//
// The pre-v2 named easings are POLYNOMIALS IN t, not parametric beziers, so
// they are not CSS easings and must not be mapped onto the CSS presets — that
// is off by up to 0.069. They ARE exactly representable, though: fixing
// p1x = 1/3, p2x = 2/3 collapses x(t) to the identity, at which point y is a
// plain cubic in x and any cubic curve can be matched exactly.
//
//   0 Linear        -> (1/3, 1/3,       2/3, 2/3)   exact
//   1 Ease Out      -> (1/3, 2/3,       2/3, 1)     exact  (max err 2.8e-16)
//   3 Ease Out Back -> (1/3, (s+3)/3,   2/3, 1)     exact  (max err 7.8e-16)
//                      where s is the overshoot param; continuous over the
//                      whole 0.5..3.0 slider range, so the existing overshoot
//                      value maps across without snapping to a preset.
//                      Note (s+3)/3 > 1 — this is why p1y must not be clamped.
//   2 Ease In-Out   -> NOT a single cubic (it is piecewise-quadratic). Split
//                      into TWO segments at t = 0.5; see buildLegacyTrack.
//   4 Elastic       -> transcendental, unrepresentable. Falls back to Linear.
//   5 Spring        -> transcendental, unrepresentable. Falls back to Linear.
//
// Easings 4 and 5 are unreachable for Zoom/Pan/Rot (its dropdown is 0..3) but
// can appear in a hand-edited project file.
enum class LegacyEasing : int {
    Linear      = 0,
    EaseOut     = 1,
    EaseInOut   = 2,
    EaseOutBack = 3,
    Elastic     = 4,
    Spring      = 5,
};

// Curves for the Ease In-Out split. Segment A is the normalized ease-in half,
// segment B the ease-out half; together they reproduce the legacy piecewise
// quadratic exactly.
inline constexpr EaseCurve kEaseInOutSegA{ 1.0 / 3.0, 0.0,       2.0 / 3.0, 1.0 / 3.0 };
inline constexpr EaseCurve kEaseInOutSegB{ 1.0 / 3.0, 2.0 / 3.0, 2.0 / 3.0, 1.0 };

// Maps a legacy easing index to its exact bezier. Returns false for indices
// that have no cubic representation (Elastic/Spring) or for EaseInOut, which
// needs two segments — callers wanting a whole track should use
// buildLegacyTrack, which handles both cases.
bool legacyEasingToBezier(int easingType, double overshoot, EaseCurve& out);

// Builds the 2- or 3-keyframe track that reproduces a legacy
// (from, to, easing, overshoot) animation.
//
// Ease In-Out produces THREE keys: t = 0, 0.5, 1 with the midpoint at exactly
// half the from->to span, which is where the legacy curve passes. Everything
// else produces two.
//
// Reuses the vector's existing capacity, so a track rebuilt every note-onset
// allocates only on the first call.
void buildLegacyTrack(ParamTrack& out, double from, double to,
                      int easingType, double overshoot);

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------
//
// Shape:
//   { "constantValue": <number>,
//     "keys": [ { "t":…, "v":…, "c":[p1x,p1y,p2x,p2y] }, … ] }
//
// "keys" is omitted when empty, so a non-animated track costs one number.
// The bezier array is omitted on a key whose curve is the default identity.
nlohmann::json toJson(const ParamTrack& track);
ParamTrack     fromJson(const nlohmann::json& j);

} // namespace paramtrack
