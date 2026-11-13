// test_key_curve.cpp — the shared keyframe curve engine (model/KeyCurve.h),
// Lens + Roam phase P7. Pure CPU, header-only under test, no JUCE.
//
//   [1] empty keys = base, on every curve kind, rule and note length
//   [2] Hold / Linear / EaseOut values, before/after the keys, same-time keys
//   [3] anchor mapping for every note length 30..3840 ticks, Squash and Cut
//   [4] Squash vs Cut evaluated on the "Punch + drift" preset
//   [5] keys exactly on zone boundaries (and clamped past them)
//   [6] canonical order is time order for every length (incl. fractional)
//   [7] compile/sort helpers: dropping, clamping, stability
//   [8] zone sanitizing
//   [9] the evaluators do not allocate
//
// Output prefix: [KeyCurve].

#include "model/KeyCurve.h"

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <new>
#include <random>
#include <vector>

using namespace xleth::keycurve;

// ─── allocation counter ([9]) ────────────────────────────────────────────────
static std::atomic<long long> g_allocs{ 0 };
void* operator new(std::size_t n) {
    ++g_allocs;
    if (void* p = std::malloc(n ? n : 1)) return p;
    throw std::bad_alloc();
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }

static int g_fail = 0;
static int g_pass = 0;

// Release-safe (NDEBUG is defined in the Release build): never assert().
#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (cond) { ++g_pass; }                                                \
        else {                                                                 \
            ++g_fail;                                                          \
            std::cout << "    FAIL: " << (msg) << "  (" #cond ")  line "       \
                      << __LINE__ << "\n";                                     \
        }                                                                      \
    } while (0)

static bool approx(double a, double b, double eps = 1e-9) { return std::fabs(a - b) <= eps; }

static Key key(double value, Interp interp, Position pos) {
    Key k;
    k.value = value; k.interp = interp; k.position = pos;
    return k;
}

static const NoteZones kSquash{ 120.0, 240.0, ShortNoteRule::Squash };
static const NoteZones kCut   { 120.0, 240.0, ShortNoteRule::Cut };

// "Punch + drift" (spec presets): Head 0 1.35 -> Head 120 1.08 -> Tail 240
// 1.20 -> Tail 0 1.00. The first segment eases out; the rest are linear.
static std::vector<Key> punchDrift() {
    std::vector<Key> k = {
        key(1.35, Interp::EaseOut, Position::head(0)),
        key(1.08, Interp::Linear,  Position::head(120)),
        key(1.20, Interp::Linear,  Position::tail(240)),
        key(1.00, Interp::Linear,  Position::tail(0)),
    };
    sortNoteKeys(k, kSquash);
    return k;
}

static double noteValue(const std::vector<Key>& k, double L, const NoteZones& z, double t,
                        double fallback = -1.0) {
    const NoteSpan s = noteSpan(L, z);
    return valueAtNote(k.data(), k.size(), s, t, fallback);
}

// ─── [1] ──────────────────────────────────────────────────────────────────────
static void test_empty_is_base() {
    std::cout << "[1] empty keys = base\n";
    CHECK(valueAt(nullptr, 0, 0.0, 7.25) == 7.25, "time curve, no keys -> base");
    CHECK(valueAt(nullptr, 0, 1e9, -3.5) == -3.5, "time curve, far tick -> base");
    bool ok = true;
    for (int L = 30; L <= 3840; L += 30)
        for (const NoteZones& z : { kSquash, kCut })
            for (double t : { 0.0, L * 0.5, double(L) })
                ok = ok && valueAtNote(nullptr, 0, noteSpan(L, z), t, 1.5) == 1.5;
    CHECK(ok, "note curve, no keys -> base, every length / rule / time");
}

// ─── [2] ──────────────────────────────────────────────────────────────────────
static void test_interp() {
    std::cout << "[2] Hold / Linear / EaseOut\n";
    auto two = [](Interp i) {
        return std::vector<Key>{ key(1.0, i, Position::eventTicks(0)),
                                 key(3.0, Interp::Hold, Position::eventTicks(100)) };
    };
    const auto hold = two(Interp::Hold), lin = two(Interp::Linear), ease = two(Interp::EaseOut);
    auto at = [](const std::vector<Key>& k, double t) { return valueAt(k.data(), k.size(), t, -1.0); };

    // On the keys: exactly the key values, whatever the interp.
    for (const auto* k : { &hold, &lin, &ease }) {
        CHECK(at(*k, 0.0) == 1.0, "t on the first key = its value");
        CHECK(at(*k, 100.0) == 3.0, "t on the last key = its value");
        CHECK(at(*k, -50.0) == 1.0, "before the first key = the first key's value");
        CHECK(at(*k, 1e6) == 3.0, "after the last key = the last key's value");
    }
    CHECK(at(hold, 25.0) == 1.0 && at(hold, 99.999) == 1.0, "Hold: stays until the next key");
    CHECK(at(lin, 25.0) == 1.5 && at(lin, 50.0) == 2.0 && at(lin, 75.0) == 2.5, "Linear: straight line");
    // EaseOut e(u) = 1 - (1-u)^2:  u=.25 -> .4375, u=.5 -> .75, u=.75 -> .9375
    CHECK(at(ease, 25.0) == 1.0 + 2.0 * 0.4375, "EaseOut u=0.25");
    CHECK(at(ease, 50.0) == 1.0 + 2.0 * 0.75,   "EaseOut u=0.5");
    CHECK(at(ease, 75.0) == 1.0 + 2.0 * 0.9375, "EaseOut u=0.75");
    CHECK(at(ease, 50.0) > at(lin, 50.0), "EaseOut runs ahead of Linear (decelerates)");
    CHECK(easeOut(0.0) == 0.0 && easeOut(1.0) == 1.0, "EaseOut ends");

    // Three keys: the interp of the key LEAVING the segment decides.
    std::vector<Key> mix = { key(0.0, Interp::Hold, Position::eventTicks(0)),
                             key(10.0, Interp::Linear, Position::eventTicks(10)),
                             key(20.0, Interp::EaseOut, Position::eventTicks(20)) };
    CHECK(at(mix, 5.0) == 0.0, "segment 0->1 holds (key 0 is Hold)");
    CHECK(at(mix, 15.0) == 15.0, "segment 1->2 is linear (key 1 is Linear)");
    CHECK(at(mix, 25.0) == 20.0, "the last key's interp is never read");

    // Same-time keys: right-continuous, the LAST in array order owns the tick.
    std::vector<Key> step = { key(0.0, Interp::Linear, Position::eventTicks(0)),
                              key(1.0, Interp::Linear, Position::eventTicks(100)),
                              key(5.0, Interp::Linear, Position::eventTicks(100)),
                              key(6.0, Interp::Linear, Position::eventTicks(200)) };
    CHECK(at(step, 100.0) == 5.0, "two keys at one tick: the later one wins at that tick");
    CHECK(approx(at(step, 99.999999), 0.99999999, 1e-6), "approaching from the left reaches the earlier one");
    CHECK(at(step, 150.0) == 5.5, "and the curve continues from the later one");

    // Timeline ticks evaluate the same way (only the caller's clock differs).
    std::vector<Key> tl = { key(0.0, Interp::Linear, Position::timelineTicks(960)),
                            key(1.0, Interp::Linear, Position::timelineTicks(1920)) };
    CHECK(at(tl, 1440.0) == 0.5 && at(tl, 0.0) == 0.0, "TimelineTicks keys");
}

// ─── [3] ──────────────────────────────────────────────────────────────────────
static void test_anchor_mapping() {
    std::cout << "[3] anchor mapping, note lengths 30..3840, Squash and Cut\n";
    std::vector<double> lengths;
    for (int L = 30; L <= 3840; L += 30) lengths.push_back(L);
    for (double L : { 1.0, 119.0, 121.0, 239.0, 241.0, 359.0, 361.0 }) lengths.push_back(L);

    const double heads[] = { 0, 30, 60, 119, 120 };
    const double bodies[] = { 0.0, 0.25, 0.5, 1.0 };
    const double tails[] = { 0, 1, 120, 239, 240 };
    int checked = 0;
    bool normalOk = true, squashOk = true, cutOk = true, spanOk = true, reachOk = true;

    for (double L : lengths) {
        const NoteSpan sq = noteSpan(L, kSquash);
        const NoteSpan ct = noteSpan(L, kCut);
        if (L >= 360.0) {
            // No conflict: both rules are the plain mapping.
            for (const NoteSpan* s : { &sq, &ct }) {
                spanOk = spanOk && !s->cut && s->scale == 1.0
                      && s->headEnd == 120.0 && s->tailStart == L - 240.0;
                for (double v : heads)  normalOk = normalOk && anchorOffset(*s, Position::head(v)) == v;
                for (double f : bodies) normalOk = normalOk && approx(anchorOffset(*s, Position::body(f)), 120.0 + f * (L - 360.0));
                for (double v : tails)  normalOk = normalOk && anchorOffset(*s, Position::tail(v)) == L - v;
                for (double v : heads)  reachOk = reachOk && anchorReached(*s, Position::head(v));
                checked += 14;
            }
        } else {
            // Squash: head and tail scaled by L / 360, body length 0.
            const double s = L / 360.0;
            spanOk = spanOk && !sq.cut && approx(sq.scale, s) && approx(sq.headEnd, 120.0 * s)
                  && approx(sq.tailStart, 120.0 * s);
            for (double v : heads)  squashOk = squashOk && approx(anchorOffset(sq, Position::head(v)), v * s);
            for (double f : bodies) squashOk = squashOk && approx(anchorOffset(sq, Position::body(f)), 120.0 * s);
            for (double v : tails)  squashOk = squashOk && approx(anchorOffset(sq, Position::tail(v)), L - v * s);
            for (double v : heads)  reachOk = reachOk && anchorReached(sq, Position::head(v));

            // Cut: tail keeps 240 and starts at max(0, L - 240); head truncated there.
            const double tailStart = std::max(0.0, L - 240.0);
            spanOk = spanOk && ct.cut && ct.tailStart == tailStart && ct.headEnd == tailStart;
            for (double v : heads) {
                cutOk = cutOk && anchorOffset(ct, Position::head(v)) == v;
                reachOk = reachOk && anchorReached(ct, Position::head(v)) == (v < tailStart);
            }
            for (double f : bodies) {
                cutOk = cutOk && anchorOffset(ct, Position::body(f)) == 120.0;
                reachOk = reachOk && !anchorReached(ct, Position::body(f));
            }
            for (double v : tails) {
                cutOk = cutOk && anchorOffset(ct, Position::tail(v)) == L - v;
                reachOk = reachOk && anchorReached(ct, Position::tail(v)) == (L - v >= 0.0);
            }
            checked += 28;
        }
    }
    CHECK(spanOk,   "zone geometry (headEnd, tailStart, scale, cut) for every length");
    CHECK(normalOk, "L >= 360: Head v -> v, Body f -> 120 + f(L-360), Tail v -> L - v");
    CHECK(squashOk, "Squash: Head v -> v*s, Body -> 120*s, Tail v -> L - v*s  (s = L/360)");
    CHECK(cutOk,    "Cut: Head v -> v, Body -> 120 (past the cut), Tail v -> L - v");
    CHECK(reachOk,  "reached: all under Squash; under Cut head < tailStart, tail >= note-on");
    std::cout << "    " << lengths.size() << " lengths, " << checked << " anchor mappings\n";

    // A note shorter than the tail: Cut enters the tail part-way through.
    const NoteSpan c90 = noteSpan(90.0, kCut);
    CHECK(c90.tailStart == 0.0 && noteTimeToCurveTime(c90, 0.0) == 360.0 - 90.0,
          "Cut, L=90 < tail: note-on is 150 ticks into the tail");
    CHECK(noteTimeToCurveTime(c90, 90.0) == 360.0, "Cut, L=90: the note end is Tail 0");
}

// ─── [4] ──────────────────────────────────────────────────────────────────────
static void test_squash_vs_cut() {
    std::cout << "[4] Squash vs Cut on Punch + drift\n";
    const auto k = punchDrift();
    const double d = 1.08 - 1.35;   // first segment's span

    // Long note (960): no conflict, both rules identical.
    for (const NoteZones& z : { kSquash, kCut }) {
        CHECK(noteValue(k, 960, z, 0)   == 1.35, "960: Head 0");
        CHECK(noteValue(k, 960, z, 60)  == 1.35 + d * 0.75, "960: EaseOut at head 60");
        CHECK(noteValue(k, 960, z, 120) == 1.08, "960: Head 120");
        CHECK(approx(noteValue(k, 960, z, 420), 1.14), "960: body midpoint, linear 1.08 -> 1.20");
        CHECK(noteValue(k, 960, z, 720) == 1.20, "960: Tail 240");
        CHECK(noteValue(k, 960, z, 960) == 1.00, "960: Tail 0 at the clamped end");
    }

    // L = 180, Squash (s = 0.5): Head 0 @0, Head 120 @60, Tail 240 @60, Tail 0 @180.
    CHECK(noteValue(k, 180, kSquash, 0) == 1.35, "Squash 180: starts on Head 0");
    CHECK(approx(noteValue(k, 180, kSquash, 30), 1.35 + d * 0.75), "Squash 180: head squashed 2x");
    CHECK(noteValue(k, 180, kSquash, 60) == 1.20, "Squash 180: head end == tail start, the tail key owns it");
    CHECK(approx(noteValue(k, 180, kSquash, 120), 1.10), "Squash 180: tail halfway");
    CHECK(noteValue(k, 180, kSquash, 180) == 1.00, "Squash 180: Tail 0 at the end");

    // L = 180, Cut: tail starts at max(0, 180 - 240) = 0, part-way through.
    // The 360-tick reference note: Tail 240 @120 (1.20) -> Tail 0 @360 (1.00).
    CHECK(approx(noteValue(k, 180, kCut, 0), 1.15),  "Cut 180: note-on is mid-tail (no punch)");
    CHECK(approx(noteValue(k, 180, kCut, 90), 1.075), "Cut 180: tail continues");
    CHECK(noteValue(k, 180, kCut, 180) == 1.00, "Cut 180: Tail 0 at the end");

    // L = 300, Cut: tailStart = 60. The head plays its own shape up to 60,
    // then the tail (from Tail 240) takes over: a cut, not a squash.
    CHECK(approx(noteValue(k, 300, kCut, 30), 1.35 + d * 0.4375), "Cut 300: head at its real speed");
    CHECK(approx(noteValue(k, 300, kCut, 59.999), 1.35 + d * (1 - std::pow(1 - 59.999 / 120.0, 2)), 1e-9),
          "Cut 300: head right before the cut");
    CHECK(noteValue(k, 300, kCut, 60) == 1.20, "Cut 300: Tail 240 at tailStart (the cut)");
    CHECK(noteValue(k, 300, kCut, 300) == 1.00, "Cut 300: Tail 0 at the end");

    // ...whereas Squash keeps every key, compressed (s = 300/360).
    const double s = 300.0 / 360.0;
    const NoteSpan sq300 = noteSpan(300, kSquash);
    CHECK(approx(sq300.tailStart, 120 * s) && sq300.tailStart == sq300.headEnd,
          "Squash 300: head end == tail start == 100");
    CHECK(noteValue(k, 300, kSquash, sq300.tailStart) == 1.20, "Squash 300: Tail 240 owns the joint");
    CHECK(approx(noteValue(k, 300, kSquash, 60 * s), 1.35 + d * 0.75), "Squash 300: head scaled");

    // Continuity of the definitions: at L = 360 Squash == Cut == plain.
    bool same = true;
    for (int t = 0; t <= 360; t += 5)
        same = same && noteValue(k, 360, kSquash, t) == noteValue(k, 360, kCut, t);
    CHECK(same, "L = head + tail: Squash and Cut agree everywhere");

    // Squash is continuous in the note length across the boundary.
    CHECK(approx(noteValue(k, 359, kSquash, 100), noteValue(k, 361, kSquash, 100), 2e-3),
          "Squash 359 vs 361 nearly equal");
}

// ─── [5] ──────────────────────────────────────────────────────────────────────
static void test_boundaries() {
    std::cout << "[5] keys exactly on zone boundaries\n";
    // One key on every boundary, each with a distinct value.
    std::vector<Key> k = {
        key(1.0, Interp::Linear, Position::head(0)),     // note-on
        key(2.0, Interp::Linear, Position::head(120)),   // head end
        key(3.0, Interp::Linear, Position::body(0.0)),   // body start (== head end)
        key(4.0, Interp::Linear, Position::body(1.0)),   // body end
        key(5.0, Interp::Linear, Position::tail(240)),   // tail start (== body end)
        key(6.0, Interp::Linear, Position::tail(0)),     // the clamped note end
    };
    sortNoteKeys(k, kSquash);

    // L = 960: head end and body start share t=120, body end and tail start t=720.
    CHECK(noteValue(k, 960, kSquash, 0)   == 1.0, "960: Head 0 at note-on");
    CHECK(noteValue(k, 960, kSquash, 120) == 3.0, "960: t=120 owned by Body 0 (after Head 120)");
    CHECK(noteValue(k, 960, kSquash, 119.5) > 1.99 && noteValue(k, 960, kSquash, 119.5) < 2.0,
          "960: approaching the head end reaches Head 120");
    CHECK(noteValue(k, 960, kSquash, 720) == 5.0, "960: t=720 owned by Tail 240 (after Body 1)");
    CHECK(noteValue(k, 960, kSquash, 420) == 3.5, "960: body midpoint");
    CHECK(noteValue(k, 960, kSquash, 960) == 6.0, "960: Tail 0 exactly at the end");
    CHECK(noteValue(k, 960, kSquash, 2000) == 6.0, "960: time past the note clamps to the end");
    CHECK(noteValue(k, 960, kSquash, -5) == 1.0, "960: time before note-on clamps to note-on");

    // L = 360 = head + tail: every inner boundary collapses to t=120; the LAST
    // key in canonical order (Tail 240) owns it.
    CHECK(noteValue(k, 360, kSquash, 120) == 5.0, "360: all inner boundaries at 120, Tail 240 wins");
    CHECK(noteValue(k, 360, kCut, 120)    == 5.0, "360 (Cut): same");
    CHECK(noteValue(k, 360, kSquash, 360) == 6.0, "360: Tail 0 at the end");

    // Squash, L = 90 (s = 0.25): boundaries at 30.
    CHECK(noteValue(k, 90, kSquash, 0)  == 1.0, "Squash 90: note-on");
    CHECK(noteValue(k, 90, kSquash, 30) == 5.0, "Squash 90: squashed boundary at 30");
    CHECK(noteValue(k, 90, kSquash, 90) == 6.0, "Squash 90: end");

    // Cut, L = 300: tailStart 60 is the cut; Head 120 is never reached.
    CHECK(noteValue(k, 300, kCut, 60)  == 5.0, "Cut 300: Tail 240 at the cut");
    CHECK(noteValue(k, 300, kCut, 30)  == 1.25, "Cut 300: head at real speed (1 -> 2 over 120)");
    CHECK(noteValue(k, 300, kCut, 300) == 6.0, "Cut 300: end");

    // Positions past their zone are clamped into it.
    std::vector<Key> c = { key(1.0, Interp::Linear, Position::head(500)),
                           key(2.0, Interp::Linear, Position::tail(9999)) };
    sortNoteKeys(c, kSquash);
    const NoteSpan s960 = noteSpan(960, kSquash);
    CHECK(anchorOffset(s960, Position::head(500)) == 120.0, "Head 500 clamps to the head end");
    CHECK(anchorOffset(s960, Position::tail(9999)) == 720.0, "Tail 9999 clamps to the tail start");
    CHECK(anchorOffset(s960, Position::body(-1)) == 120.0 && anchorOffset(s960, Position::body(7)) == 720.0,
          "Body fraction clamps to [0, 1]");
    CHECK(anchorOffset(s960, Position::head(-40)) == 0.0, "negative Head clamps to note-on");

    // Fractional (arp) note: the boundaries still coincide to the bit.
    const NoteSpan f = noteSpan(1234.5678, kSquash);
    CHECK(noteCurveTime(f, Position::head(120)) == noteCurveTime(f, Position::body(0)),
          "fractional L: Head end == Body 0 exactly");
    CHECK(noteCurveTime(f, Position::body(1)) == noteCurveTime(f, Position::tail(240)),
          "fractional L: Body 1 == Tail start exactly");
    CHECK(noteCurveTime(f, Position::tail(0)) == 1234.5678, "fractional L: Tail 0 == L exactly");
    const NoteSpan fs = noteSpan(200.3, kSquash);
    CHECK(noteCurveTime(fs, Position::head(120)) <= noteCurveTime(fs, Position::tail(240)),
          "fractional squash: head end never after tail start");
}

// ─── [6] ──────────────────────────────────────────────────────────────────────
static void test_monotone() {
    std::cout << "[6] canonical order is time order for every length\n";
    std::vector<Position> anchors;
    for (double v = 0; v <= 120; v += 7.5) anchors.push_back(Position::head(v));
    for (double f = 0; f <= 1.0; f += 0.0625) anchors.push_back(Position::body(f));
    for (double v = 240; v >= 0; v -= 7.5) anchors.push_back(Position::tail(v));

    std::mt19937_64 rng(0x7e57);
    std::uniform_real_distribution<double> frac(30.0, 3840.0);
    std::vector<double> lengths;
    for (int L = 30; L <= 3840; ++L) lengths.push_back(L);
    for (int i = 0; i < 4000; ++i) lengths.push_back(frac(rng));

    bool ok = true;
    for (double L : lengths)
        for (const NoteZones& z : { kSquash, kCut }) {
            const NoteSpan s = noteSpan(L, z);
            double prev = -1e300;
            for (const Position& p : anchors) {
                const double c = noteCurveTime(s, p);
                ok = ok && c >= prev;
                prev = c;
            }
            // Note time -> curve time is monotone too.
            double pu = -1e300;
            for (int i = 0; i <= 64; ++i) {
                const double u = noteTimeToCurveTime(s, L * i / 64.0);
                ok = ok && u >= pu;
                pu = u;
            }
        }
    CHECK(ok, "curve time non-decreasing in canonical order, every length (integer + 4000 fractional), both rules");
}

// ─── [7] ──────────────────────────────────────────────────────────────────────
static void test_compile() {
    std::cout << "[7] compile / sort helpers\n";
    std::vector<Key> k = {
        key(9.0, Interp::Linear, Position::tail(0)),
        key(1.0, Interp::Linear, Position::head(30)),
        key(8.0, Interp::Linear, Position::tail(100)),
        key(5.0, Interp::Linear, Position::body(0.5)),
        key(0.0, Interp::Linear, Position::head(0)),
        key(7.0, Interp::Linear, Position::eventTicks(10)),        // wrong time base
        key(NAN, Interp::Linear, Position::head(60)),              // non-finite
        key(2.0, Interp::Linear, Position::head(INFINITY)),        // non-finite position
        key(6.0, Interp::Linear, Position::tail(500)),             // clamped to 240
    };
    compileNoteKeys(k, kSquash);
    CHECK(k.size() == 6, "non-note and non-finite keys dropped");
    const double want[] = { 0.0, 1.0, 5.0, 6.0, 8.0, 9.0 };
    bool order = k.size() == 6;
    for (std::size_t i = 0; order && i < k.size(); ++i) order = k[i].value == want[i];
    CHECK(order, "canonical order: Head asc, Body asc, Tail desc ticks");
    CHECK(k.size() == 6 && k[3].position.v == 240.0, "Tail 500 clamped to the tail length");

    std::vector<Key> t = {
        key(3.0, Interp::Linear, Position::eventTicks(300)),
        key(1.0, Interp::Linear, Position::eventTicks(100)),
        key(2.0, Interp::Linear, Position::eventTicks(100)),   // same tick, stored after 1.0
        key(4.0, Interp::Linear, Position::head(0)),           // note anchor: dropped
    };
    compileTimeKeys(t);
    CHECK(t.size() == 3 && t[0].value == 1.0 && t[1].value == 2.0 && t[2].value == 3.0,
          "time keys sorted, stable for equal ticks, note anchors dropped");
    CHECK(valueAt(t.data(), t.size(), 100.0, 0.0) == 2.0, "the later stored key owns a shared tick");
}

// ─── [8] ──────────────────────────────────────────────────────────────────────
static void test_zones() {
    std::cout << "[8] zone sanitizing\n";
    const NoteSpan s = noteSpan(960, NoteZones{ -5.0, NAN, ShortNoteRule::Squash });
    CHECK(s.headTicks == 120.0 && s.tailTicks == 240.0, "negative / NaN zone lengths -> spec defaults");
    const NoteSpan z = noteSpan(960, NoteZones{ 0.0, 0.0, ShortNoteRule::Cut });
    CHECK(!z.cut && z.headEnd == 0.0 && z.tailStart == 960.0, "zero head and tail: all body, never short");
    const NoteSpan n = noteSpan(-10, kSquash);
    CHECK(n.noteLen == 0.0 && n.scale == 0.0, "a non-positive note length is 0 long");
    CHECK(valueAtNote(nullptr, 0, n, 0, 2.0) == 2.0, "...and evaluates safely");
    const NoteZones d;
    CHECK(d.headTicks == 120.0 && d.tailTicks == 240.0 && d.rule == ShortNoteRule::Squash,
          "defaults: head 120 (1/32), tail 240 (1/16), Squash");
}

// ─── [9] ──────────────────────────────────────────────────────────────────────
static void test_no_alloc() {
    std::cout << "[9] evaluators do not allocate\n";
    const auto k = punchDrift();
    std::vector<Key> t = { key(0.0, Interp::EaseOut, Position::timelineTicks(0)),
                           key(1.0, Interp::Hold, Position::timelineTicks(960)),
                           key(2.0, Interp::Linear, Position::timelineTicks(1920)) };
    double sink = 0.0;
    const long long before = g_allocs.load();
    for (int L = 30; L <= 3840; L += 7)
        for (const NoteZones& z : { kSquash, kCut }) {
            const NoteSpan s = noteSpan(L, z);
            for (int i = 0; i <= 16; ++i) {
                const double tt = L * i / 16.0;
                sink += valueAtNote(k.data(), k.size(), s, tt, 1.0);
                sink += anchorOffset(s, Position::tail(120)) + noteTimeToCurveTime(s, tt);
                sink += valueAt(t.data(), t.size(), tt * 2.0, 0.0);
            }
        }
    const long long after = g_allocs.load();
    CHECK(after == before, "zero allocations across ~18k evaluations");
    std::cout << "    allocations during evaluation: " << (after - before)
              << " (checksum " << sink << ")\n";
}

int main() {
    std::cout << "[KeyCurve] shared keyframe curve engine (model/KeyCurve.h)\n";
    test_empty_is_base();
    test_interp();
    test_anchor_mapping();
    test_squash_vs_cut();
    test_boundaries();
    test_monotone();
    test_compile();
    test_zones();
    test_no_alloc();
    std::cout << "[KeyCurve] " << g_pass << " passed, " << g_fail << " failed\n";
    return g_fail == 0 ? 0 : 1;
}
