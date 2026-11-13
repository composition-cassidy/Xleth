#pragma once

// ─── KeyCurve: XLETH's shared keyframe curve engine ──────────────────────────
//
// Parameter-agnostic. A curve is the keys of ONE scalar channel; it knows
// nothing about Lens, Roam or any other parameter. The caller decides what a
// value means and how it blends with other layers (model/LensRoam.h is the
// first user; the wider animation system is meant to sit on this too).
// Header-only, no JUCE, no allocation outside the message-thread helpers.
//
// ── Key ──────────────────────────────────────────────────────────────────────
//   Key { value, interp, position }
//
//   interp shapes the segment LEAVING the key, toward the next key:
//     Hold     the value stays at this key's value until the next key (a step)
//     Linear   a straight line to the next key's value
//     EaseOut  decelerating: fast off this key, settling into the next one.
//              e(u) = 1 - (1 - u)^2, the engine's existing EaseOut
//              (AnimationManager easeOut; the ParamTrack legacy EaseOut bezier
//              (1/3, 2/3, 2/3, 1) is the same polynomial).
//   The last key's interp is never read.
//
// ── Position (time; ticks at 960 PPQ) ────────────────────────────────────────
//   EventTicks      ticks from the event start (Clip Track event keys: they
//                   move with the event)
//   TimelineTicks   timeline-absolute ticks (Roam keys, later Sweep keys)
//   NoteAnchor      relative to one note (Pattern Track hit curve, overrides):
//     Head  ticks after note-on (fixed)
//     Body  fraction 0..1 of the span between head end and tail start
//           (stretches with the note)
//     Tail  ticks before the CLAMPED note end (fixed)
//
// ── Evaluation: the value at time t ──────────────────────────────────────────
//   no keys                     -> the caller's fallback ("empty keys = base")
//   t before the first key      -> the first key's value
//   t at or after the last key  -> the last key's value
//   otherwise                   -> segment [k(i), k(i+1)), shaped by k(i).interp
//   Several keys at the same time: the LAST one in array order owns that time
//   (right-continuous). The curve reaches the earlier key's value as t comes
//   in from the left, then steps. sortTimeKeys / sortNoteKeys are stable, so
//   "last in array order" is "last in stored order".
//
// ── Note-relative time (spec "Time bases", Rulings 4 and 5) ──────────────────
//   The clock is the note's START TICK, the way Note Fade is: t = frameTick -
//   noteStartTick. Never the first frame that sees the note, so a seek into
//   the middle of a note lands mid-animation, identically in preview and
//   export. noteLen is the CLAMPED length (the note-off clamped to its block
//   end: where the video actually stops).
//
//   NoteZones { head = 120 ticks (1/32), tail = 240 ticks (1/16), Squash }
//
//   noteLen >= head + tail (no conflict):
//     Head v -> v       Body f -> head + f * (noteLen - head - tail)
//     Tail v -> noteLen - v
//
//   noteLen < head + tail, Squash (the default): head and tail lengths scale
//   by s = noteLen / (head + tail); the body is 0 long.
//     Head v -> v * s   Body f -> head * s   Tail v -> noteLen - v * s
//
//   noteLen < head + tail, Cut: the tail keeps its real length and starts at
//   tailStart = max(0, noteLen - tail); the head is truncated where the tail
//   starts. When noteLen < tail the tail starts part-way through: note-on is
//   already (tail - noteLen) ticks into it.
//     Head v -> v       (cut off when v >= tailStart)
//     Body f -> head    (always past the cut: the body is never seen)
//     Tail v -> noteLen - v   (negative = before note-on, never seen)
//   It is evaluated as the shortest un-squashed note (length head + tail,
//   body 0) played with ONE jump: note time t < tailStart plays that note's
//   time t, t >= tailStart plays its time t + (head + tail - noteLen). Each
//   zone keeps its own shape; the cut is a cut (a step at tailStart).
//
//   Positions are clamped into their zone (Head v to [0, head], Tail v to
//   [0, tail], Body f to [0, 1]). With that, CANONICAL order (Head ascending,
//   Body ascending, Tail descending ticks) is time order for EVERY note
//   length and every rule, so a note curve is sorted once on the message
//   thread and evaluated per note with a binary search, never re-sorted.
//
// ── Threading ────────────────────────────────────────────────────────────────
//   sortTimeKeys / sortNoteKeys / compileNoteKeys take std::vector and may
//   allocate: MESSAGE THREAD ONLY (snapshot build). Everything else is a pure
//   function of its arguments over a const array: no allocation, no lock, no
//   logging, no state, safe on the audio and render threads. Same inputs give
//   the same bits on every call, which is what makes preview == export.

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace xleth::keycurve {

inline constexpr double kTicksPerBeat = 960.0;

enum class Interp : uint8_t {
    Hold    = 0,
    Linear  = 1,
    EaseOut = 2,
};

enum class TimeBase : uint8_t {
    EventTicks    = 0,  // ticks from the event start
    TimelineTicks = 1,  // timeline-absolute ticks
    NoteHead      = 2,  // NoteAnchor Head: ticks after note-on
    NoteBody      = 3,  // NoteAnchor Body: fraction 0..1 of the body
    NoteTail      = 4,  // NoteAnchor Tail: ticks before the clamped note end
};

inline constexpr bool isNoteAnchor(TimeBase b) {
    return b == TimeBase::NoteHead || b == TimeBase::NoteBody || b == TimeBase::NoteTail;
}

struct Position {
    TimeBase base = TimeBase::EventTicks;
    double   v    = 0.0;   // ticks, or the Body fraction

    static constexpr Position eventTicks(double ticks)    { return { TimeBase::EventTicks, ticks }; }
    static constexpr Position timelineTicks(double ticks) { return { TimeBase::TimelineTicks, ticks }; }
    static constexpr Position head(double ticks)          { return { TimeBase::NoteHead, ticks }; }
    static constexpr Position body(double fraction)       { return { TimeBase::NoteBody, fraction }; }
    static constexpr Position tail(double ticks)          { return { TimeBase::NoteTail, ticks }; }
};

struct Key {
    double   value  = 0.0;
    Interp   interp = Interp::Linear;
    Position position;
};

// ─── Interpolation ───────────────────────────────────────────────────────────

inline double easeOut(double u) { return 1.0 - (1.0 - u) * (1.0 - u); }

// Value on the segment a -> b at u in [0, 1) (u = 0 is exactly a.value).
inline double interpolate(const Key& a, const Key& b, double u) {
    switch (a.interp) {
        case Interp::Hold:    return a.value;
        case Interp::EaseOut: return a.value + (b.value - a.value) * easeOut(u);
        case Interp::Linear:
        default:              return a.value + (b.value - a.value) * u;
    }
}

// The one evaluator. `keys` must be in time order under `timeOf` (any
// monotone non-decreasing key -> time map). Binary search + interpolation.
template <typename TimeOf>
inline double evaluateSorted(const Key* keys, std::size_t n, double t,
                             double fallback, TimeOf timeOf) {
    if (n == 0 || keys == nullptr) return fallback;
    if (!(t >= timeOf(keys[0]))) return keys[0].value;   // before the first key (or NaN t)

    // upper_bound: the first key whose time is > t. keys[0] is <= t, so lo >= 1.
    std::size_t lo = 1, hi = n;
    while (lo < hi) {
        const std::size_t mid = lo + (hi - lo) / 2;
        if (timeOf(keys[mid]) <= t) lo = mid + 1;
        else                        hi = mid;
    }
    if (lo >= n) return keys[n - 1].value;               // at or after the last key

    const Key&   a  = keys[lo - 1];
    const Key&   b  = keys[lo];
    const double ta = timeOf(a);
    const double tb = timeOf(b);                         // tb > t >= ta, so tb > ta
    return interpolate(a, b, (t - ta) / (tb - ta));
}

// ─── EventTicks / TimelineTicks curves ───────────────────────────────────────
// The key's time is its position.v in the curve's own time base: ticks from
// the event start for an EventTicks curve, the timeline tick for a
// TimelineTicks curve. One curve holds one time base.

inline double valueAt(const Key* keys, std::size_t n, double t, double fallback) {
    return evaluateSorted(keys, n, t, fallback,
                          [](const Key& k) { return k.position.v; });
}

// Message thread. Stable: keys at the same time keep their stored order.
inline void sortTimeKeys(std::vector<Key>& keys) {
    std::stable_sort(keys.begin(), keys.end(),
        [](const Key& a, const Key& b) { return a.position.v < b.position.v; });
}

// ─── Note-anchored curves ────────────────────────────────────────────────────

enum class ShortNoteRule : uint8_t {
    Squash = 0,  // default: head and tail scale down, body 0
    Cut    = 1,  // tail keeps its length; head truncated where the tail starts
};

struct NoteZones {
    double        headTicks = 120.0;   // 1/32
    double        tailTicks = 240.0;   // 1/16
    ShortNoteRule rule      = ShortNoteRule::Squash;

    bool operator==(const NoteZones& o) const {
        return headTicks == o.headTicks && tailTicks == o.tailTicks && rule == o.rule;
    }
    bool operator!=(const NoteZones& o) const { return !(*this == o); }
};

// A zone length: finite and >= 0, else the default.
inline double sanitizeZoneTicks(double v, double fallback) {
    return (std::isfinite(v) && v >= 0.0) ? v : fallback;
}

// One note's resolved zone geometry. Built per note (cheap, no allocation).
//
// Two time axes. NOTE time is ticks since note-on, what the frame clock
// gives. CURVE time is where the keys sit and what the evaluator searches.
// They are the same axis except under Cut, where the tail portion of the
// note plays the curve of the shortest un-squashed note (head + tail long).
//
// Every curve-time boundary is computed ONCE and shared by both zones that
// meet there (Head end == Body 0, Body 1 == Tail `tail`, Tail 0 == the note
// end), so the map stays monotone to the last bit even for fractional (arp)
// note lengths, and a key exactly on a boundary lands exactly on it.
struct NoteSpan {
    // Inputs, sanitized.
    double noteLen   = 0.0;    // clamped note length, ticks
    double headTicks = 0.0;
    double tailTicks = 0.0;

    // NOTE time: where each zone plays (ticks after note-on).
    //   head [0, headEnd)   body [headEnd, tailStart)   tail [tailStart, noteLen]
    double headEnd   = 0.0;
    double tailStart = 0.0;

    // CURVE time.
    double scale          = 1.0;  // Squash factor on head and tail ticks (1 = unscaled)
    double curveHeadEnd   = 0.0;  // Head `headTicks` == Body 0
    double curveTailStart = 0.0;  // Body 1 == Tail `tailTicks`
    double curveEnd       = 0.0;  // Tail 0

    bool   cut = false;           // Cut rule in force (short note, rule Cut)
};

inline NoteSpan noteSpan(double noteLen, const NoteZones& zones) {
    const NoteZones d;
    NoteSpan s;
    const double H = sanitizeZoneTicks(zones.headTicks, d.headTicks);
    const double T = sanitizeZoneTicks(zones.tailTicks, d.tailTicks);
    const double L = (std::isfinite(noteLen) && noteLen > 0.0) ? noteLen : 0.0;
    s.noteLen = L;  s.headTicks = H;  s.tailTicks = T;

    if (L >= H + T) {                                   // room for every zone
        s.curveEnd  = L;
    } else if (zones.rule == ShortNoteRule::Cut) {
        s.cut       = true;
        s.curveEnd  = H + T;                            // the un-squashed note
    } else {                                            // Squash
        s.scale     = L / (H + T);                      // H + T > L >= 0, so H + T > 0
        s.curveEnd  = L;
    }
    s.curveTailStart = s.curveEnd - T * s.scale;
    // A short note's body is 0 long (Squash, and Cut's reference note), so the
    // head end IS the tail start: the same double, not two expressions that
    // could land an ulp apart.
    s.curveHeadEnd   = (L >= H + T) ? H : s.curveTailStart;

    if (s.cut) {
        s.tailStart = std::max(0.0, L - T);
        s.headEnd   = s.tailStart;                      // head truncated at the tail
    } else {
        s.headEnd   = s.curveHeadEnd;
        s.tailStart = s.curveTailStart;
    }
    return s;
}

// A note anchor's place on the CURVE time axis (what the evaluator
// searches). Clamped into its zone. A non-note position is read as Head ticks
// (a note curve should hold only note anchors; see compileNoteKeys).
// The zone ends map to the shared boundary values exactly (Head `head` ->
// curveHeadEnd, Body 1 / Tail `tail` -> curveTailStart, Tail 0 -> curveEnd);
// interior positions are clamped inside their zone, so the map is monotone.
inline double noteCurveTime(const NoteSpan& s, const Position& p) {
    switch (p.base) {
        case TimeBase::NoteBody: {
            const double f = std::clamp(p.v, 0.0, 1.0);
            if (f >= 1.0) return s.curveTailStart;
            return std::min(s.curveHeadEnd + f * (s.curveTailStart - s.curveHeadEnd),
                            s.curveTailStart);
        }
        case TimeBase::NoteTail: {
            const double v = std::clamp(p.v, 0.0, s.tailTicks);
            if (v >= s.tailTicks) return s.curveTailStart;
            if (v <= 0.0)         return s.curveEnd;
            return std::clamp(s.curveEnd - v * s.scale, s.curveTailStart, s.curveEnd);
        }
        case TimeBase::NoteHead:
        default: {
            const double v = std::clamp(p.v, 0.0, s.headTicks);
            if (v >= s.headTicks) return s.curveHeadEnd;
            return std::min(v * s.scale, s.curveHeadEnd);
        }
    }
}

// THE anchor mapping: a note anchor -> its offset from note-on, in ticks, for
// this note, Squash or Cut applied (see the header comment for the formulas).
// Under Cut a Head/Body key at an offset >= tailStart is cut off, and a Tail
// key at a negative offset lies before note-on; anchorReached says which.
inline double anchorOffset(const NoteSpan& s, const Position& p) {
    if (s.cut && p.base == TimeBase::NoteTail)
        return s.noteLen - std::clamp(p.v, 0.0, s.tailTicks);
    return noteCurveTime(s, p);
}

// Whether the note's playback passes through this anchor. Always true except
// under Cut (see anchorOffset).
inline bool anchorReached(const NoteSpan& s, const Position& p) {
    if (!s.cut) return true;
    const double off = anchorOffset(s, p);
    return p.base == TimeBase::NoteTail ? off >= 0.0 : off < s.tailStart;
}

// Note time (ticks since note-on, clamped to the note) -> curve time.
// Cut: before tailStart the head plays as is; from tailStart on, the tail
// plays counted back from the note end (so the note end is Tail 0 exactly,
// and a note shorter than the tail enters it part-way through).
inline double noteTimeToCurveTime(const NoteSpan& s, double tSinceNoteOn) {
    const double t = std::clamp(tSinceNoteOn, 0.0, s.noteLen);
    if (s.cut && t >= s.tailStart) return s.curveEnd - (s.noteLen - t);
    return t;
}

// Value of a note curve `tSinceNoteOn` ticks after note-on. `keys` in
// canonical note order (sortNoteKeys / compileNoteKeys with the SAME zones
// the span was built from).
inline double valueAtNote(const Key* keys, std::size_t n, const NoteSpan& s,
                          double tSinceNoteOn, double fallback) {
    if (n == 0) return fallback;
    const double u = noteTimeToCurveTime(s, tSinceNoteOn);
    return evaluateSorted(keys, n, u, fallback,
                          [&s](const Key& k) { return noteCurveTime(s, k.position); });
}

// Canonical rank of a note key: zone first, then position inside the zone
// (Tail descending in ticks = ascending in time). Clamped like noteCurveTime.
inline int noteZoneRank(TimeBase b) {
    switch (b) {
        case TimeBase::NoteBody: return 1;
        case TimeBase::NoteTail: return 2;
        default:                 return 0;
    }
}

inline double noteZoneOrder(const Key& k, const NoteZones& z) {
    const double H = sanitizeZoneTicks(z.headTicks, NoteZones{}.headTicks);
    const double T = sanitizeZoneTicks(z.tailTicks, NoteZones{}.tailTicks);
    switch (k.position.base) {
        case TimeBase::NoteBody: return  std::clamp(k.position.v, 0.0, 1.0);
        case TimeBase::NoteTail: return -std::clamp(k.position.v, 0.0, T);
        default:                 return  std::clamp(k.position.v, 0.0, H);
    }
}

// Message thread. Stable sort into canonical note order for `zones`.
inline void sortNoteKeys(std::vector<Key>& keys, const NoteZones& zones) {
    std::stable_sort(keys.begin(), keys.end(), [&zones](const Key& a, const Key& b) {
        const int ra = noteZoneRank(a.position.base), rb = noteZoneRank(b.position.base);
        if (ra != rb) return ra < rb;
        return noteZoneOrder(a, zones) < noteZoneOrder(b, zones);
    });
}

// Message thread. Drops non-note keys and non-finite values, clamps every
// position into its zone (so the render thread's clamps are no-ops) and sorts
// canonically. The result is ready for valueAtNote with any note length.
inline void compileNoteKeys(std::vector<Key>& keys, const NoteZones& zones) {
    const double H = sanitizeZoneTicks(zones.headTicks, NoteZones{}.headTicks);
    const double T = sanitizeZoneTicks(zones.tailTicks, NoteZones{}.tailTicks);
    keys.erase(std::remove_if(keys.begin(), keys.end(), [](const Key& k) {
        return !isNoteAnchor(k.position.base)
            || !std::isfinite(k.value) || !std::isfinite(k.position.v);
    }), keys.end());
    for (Key& k : keys) {
        switch (k.position.base) {
            case TimeBase::NoteBody: k.position.v = std::clamp(k.position.v, 0.0, 1.0); break;
            case TimeBase::NoteTail: k.position.v = std::clamp(k.position.v, 0.0, T);   break;
            default:                 k.position.v = std::clamp(k.position.v, 0.0, H);   break;
        }
    }
    sortNoteKeys(keys, zones);
}

// Message thread. Drops note anchors and non-finite keys, then sorts by time.
// For EventTicks and TimelineTicks curves.
inline void compileTimeKeys(std::vector<Key>& keys) {
    keys.erase(std::remove_if(keys.begin(), keys.end(), [](const Key& k) {
        return isNoteAnchor(k.position.base)
            || !std::isfinite(k.value) || !std::isfinite(k.position.v);
    }), keys.end());
    sortTimeKeys(keys);
}

} // namespace xleth::keycurve
