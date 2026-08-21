// ===========================================================================
// test_param_track — ParamTrack keyframe core + Zoom/Pan/Rot migration.
// ===========================================================================
//
// Covers the contract that the ZPR migration rests on:
//   - bezier x -> t solve accuracy against known CSS values
//   - fast path (x(t) == t) agrees with the general solver
//   - overshoot preservation (p1y > 1 must NOT be clamped)
//   - rotation 350 -> 370 travels +20, not -340
//   - zoom 1x -> 8x midpoint is ~2.83x (log2), not 4.5x (linear)
//   - empty-track constantValue path
//   - v1 payload migration, including the exact legacy-easing mapping
//
// Pure CPU — no GPU, no decoder, no JUCE message loop.

#include "model/ParamTrack.h"
#include "model/Timeline.h"
#include "project/ProjectManager.h"
#include "model/TimelineTypes.h"
#include "model/Track.h"
#include "util/ParamTrackEase.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <string>

using namespace paramtrack;

static int g_failures = 0;

#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (!(cond)) {                                                         \
            std::cout << "    FAIL: " << (msg) << "\n";                        \
            ++g_failures;                                                      \
        } else {                                                               \
            std::cout << "    ok:   " << (msg) << "\n";                        \
        }                                                                      \
    } while (0)

static bool isNear(double a, double b, double eps) { return std::fabs(a - b) <= eps; }

#define CHECK_NEAR(a, b, eps, msg)                                             \
    do {                                                                       \
        const double va_ = (a), vb_ = (b);                                     \
        if (!isNear(va_, vb_, (eps))) {                                          \
            std::cout << "    FAIL: " << (msg) << "  (got " << va_             \
                      << ", want " << vb_ << ", eps " << (eps) << ")\n";       \
            ++g_failures;                                                      \
        } else {                                                               \
            std::cout << "    ok:   " << (msg) << "\n";                        \
        }                                                                      \
    } while (0)

// ---------------------------------------------------------------------------
// Reference implementations of the PRE-v2 easing curves, copied here so the
// migration is checked against the real legacy math rather than against the
// new code's own idea of it.
// ---------------------------------------------------------------------------
static double legacyEaseLinear(double t) { return t; }
static double legacyEaseOut(double t)    { return 1.0 - (1.0 - t) * (1.0 - t); }
static double legacyEaseInOut(double t) {
    return t < 0.5 ? 2.0 * t * t : 1.0 - std::pow(-2.0 * t + 2.0, 2) / 2.0;
}
static double legacyEaseOutBack(double t, double s) {
    const double c3 = s + 1.0;
    return 1.0 + c3 * std::pow(t - 1.0, 3) + s * std::pow(t - 1.0, 2);
}

// Independent bezier solver (pure bisection, 200 iterations) used to
// cross-check paramTrackEase without sharing any of its code.
static double referenceBezier(double p1x, double p1y, double p2x, double p2y, double x) {
    auto bx = [&](double t) {
        return 3 * (1 - t) * (1 - t) * t * p1x + 3 * (1 - t) * t * t * p2x + t * t * t;
    };
    auto by = [&](double t) {
        return 3 * (1 - t) * (1 - t) * t * p1y + 3 * (1 - t) * t * t * p2y + t * t * t;
    };
    double lo = 0.0, hi = 1.0;
    for (int i = 0; i < 200; ++i) {
        const double m = 0.5 * (lo + hi);
        if (bx(m) < x) lo = m; else hi = m;
    }
    return by(0.5 * (lo + hi));
}

// ---------------------------------------------------------------------------

static void test_bezier_solver_accuracy() {
    std::cout << "[1] bezier x->t solve accuracy vs known CSS values\n";

    // Canonical CSS keywords. Reference values come from the independent
    // bisection solver above, which is what browsers converge to.
    struct Case { const char* name; double p1x, p1y, p2x, p2y; };
    const Case cases[] = {
        { "ease",        0.25, 0.1,  0.25, 1.0  },
        { "ease-in",     0.42, 0.0,  1.0,  1.0  },
        { "ease-out",    0.0,  0.0,  0.58, 1.0  },
        { "ease-in-out", 0.42, 0.0,  0.58, 1.0  },
        { "linear",      0.0,  0.0,  1.0,  1.0  },
    };

    for (const auto& c : cases) {
        double worst = 0.0;
        for (int i = 0; i <= 1000; ++i) {
            const double x = i / 1000.0;
            const double got  = paramTrackEase(c.p1x, c.p1y, c.p2x, c.p2y, x);
            const double want = referenceBezier(c.p1x, c.p1y, c.p2x, c.p2y, x);
            worst = std::max(worst, std::fabs(got - want));
        }
        CHECK(worst < 1e-6,
              std::string("cubic-bezier ") + c.name + " within 1e-6 of reference solver");
    }

    // Endpoints are exact by contract, not by solve.
    CHECK_NEAR(paramTrackEase(0.42, 0.0, 0.58, 1.0, 0.0), 0.0, 0.0, "x=0 returns exactly 0");
    CHECK_NEAR(paramTrackEase(0.42, 0.0, 0.58, 1.0, 1.0), 1.0, 0.0, "x=1 returns exactly 1");

    // A well-known midpoint: cubic-bezier(0,0,0.58,1) at x=0.5 is ~0.6851.
    CHECK_NEAR(paramTrackEase(0.0, 0.0, 0.58, 1.0, 0.5), 0.6851, 1e-3,
               "CSS ease-out midpoint ~0.685");
}

static void test_fast_path_matches_solver() {
    std::cout << "[2] fast path (x(t)==t) agrees with the Newton/bisection solver\n";

    CHECK(isIdentityInX(1.0 / 3.0, 2.0 / 3.0), "p1x=1/3,p2x=2/3 recognised as identity in x");
    CHECK(!isIdentityInX(0.42, 0.58), "a non-identity curve is not misdetected");

    // A curve that satisfies the fast-path condition, with a non-trivial y
    // (including overshoot) so agreement is not vacuous.
    const double p1x = 1.0 / 3.0, p2x = 2.0 / 3.0;
    const double p1y = 1.4,       p2y = 0.2;

    double worst = 0.0;
    for (int i = 0; i <= 1000; ++i) {
        const double x = i / 1000.0;
        const double fast = paramTrackEase(p1x, p1y, p2x, p2y, x);       // takes fast path
        const double slow = referenceBezier(p1x, p1y, p2x, p2y, x);      // full solve
        worst = std::max(worst, std::fabs(fast - slow));
    }
    CHECK(worst < 1e-9, "fast path and solver agree to 1e-9");

    // And the fast path really is just the Bernstein cubic in x.
    for (int i = 0; i <= 10; ++i) {
        const double x = i / 10.0;
        if (x <= 0.0 || x >= 1.0) continue;
        CHECK_NEAR(paramTrackEase(p1x, p1y, p2x, p2y, x),
                   bernsteinCubic(p1y, p2y, x), 1e-12,
                   "fast path == Bernstein cubic at x=" + std::to_string(x));
    }
}

static void test_overshoot_preserved() {
    std::cout << "[3] overshoot preservation — p1y > 1 must not be clamped\n";

    // Ease-Out-Back with the default overshoot maps to p1y = (s+3)/3 = 1.567…
    EaseCurve c;
    CHECK(legacyEasingToBezier(3, 1.70158, c), "EaseOutBack maps to a bezier");
    CHECK(c.p1y > 1.0, "EaseOutBack p1y exceeds 1 (overshoot survives the mapping)");
    CHECK_NEAR(c.p1y, (1.70158 + 3.0) / 3.0, 1e-12, "p1y == (s+3)/3");

    // The evaluated curve must actually exceed 1 somewhere.
    double peak = 0.0;
    for (int i = 0; i <= 1000; ++i)
        peak = std::max(peak, paramTrackEase(c, i / 1000.0));
    CHECK(peak > 1.0, "evaluated EaseOutBack overshoots past 1.0");

    // A track built from it must carry the overshoot through to its values:
    // travelling 0 -> 100 should exceed 100 mid-flight.
    ParamTrack tr;
    buildLegacyTrack(tr, 0.0, 100.0, /*EaseOutBack*/3, 1.70158);
    double vpeak = 0.0;
    for (int i = 0; i <= 1000; ++i)
        vpeak = std::max(vpeak, evaluate(tr, i / 1000.0));
    CHECK(vpeak > 100.0, "track value overshoots past its target keyframe");

    // Explicit anticipation (undershoot below 0) must survive too.
    CHECK(paramTrackEase(1.0 / 3.0, -0.5, 2.0 / 3.0, 1.0, 0.2) < 0.0,
          "negative p1y produces anticipation below 0");
}

static void test_legacy_easing_mapping_is_exact() {
    std::cout << "[4] legacy named easings map to their EXACT cubic bezier\n";

    // Linear
    {
        EaseCurve c; CHECK(legacyEasingToBezier(0, 0.0, c), "Linear maps");
        double worst = 0.0;
        for (int i = 0; i <= 1000; ++i) {
            const double x = i / 1000.0;
            worst = std::max(worst, std::fabs(paramTrackEase(c, x) - legacyEaseLinear(x)));
        }
        CHECK(worst < 1e-12, "Linear exact (< 1e-12)");
    }

    // Ease Out — the one the CSS preset table got wrong by 0.069.
    {
        EaseCurve c; CHECK(legacyEasingToBezier(1, 0.0, c), "EaseOut maps");
        double worst = 0.0;
        for (int i = 0; i <= 1000; ++i) {
            const double x = i / 1000.0;
            worst = std::max(worst, std::fabs(paramTrackEase(c, x) - legacyEaseOut(x)));
        }
        CHECK(worst < 1e-12, "EaseOut exact (< 1e-12)");

        // Guard the regression directly: the CSS preset is NOT equivalent.
        double cssWorst = 0.0;
        for (int i = 0; i <= 1000; ++i) {
            const double x = i / 1000.0;
            cssWorst = std::max(cssWorst,
                std::fabs(paramTrackEase(0.0, 0.0, 0.58, 1.0, x) - legacyEaseOut(x)));
        }
        CHECK(cssWorst > 0.05,
              "CSS (0,0,0.58,1) is NOT legacy EaseOut — do not substitute it");
    }

    // Ease Out Back, swept across the whole overshoot slider range.
    for (double s : { 0.5, 1.0, 1.70158, 2.5, 3.0 }) {
        EaseCurve c; legacyEasingToBezier(3, s, c);
        double worst = 0.0;
        for (int i = 0; i <= 1000; ++i) {
            const double x = i / 1000.0;
            worst = std::max(worst, std::fabs(paramTrackEase(c, x) - legacyEaseOutBack(x, s)));
        }
        CHECK(worst < 1e-12, "EaseOutBack exact at overshoot " + std::to_string(s));
    }

    // Ease In-Out needs the two-segment split; a single curve cannot do it.
    {
        EaseCurve c;
        CHECK(!legacyEasingToBezier(2, 0.0, c),
              "EaseInOut refuses a single-curve mapping (needs 3 keyframes)");

        ParamTrack tr;
        buildLegacyTrack(tr, 0.0, 1.0, /*EaseInOut*/2, 0.0);
        CHECK(tr.keys.size() == 3, "EaseInOut migrates to THREE keyframes");
        CHECK_NEAR(tr.keys[1].t, 0.5, 1e-12, "split point at t=0.5");
        CHECK_NEAR(tr.keys[1].value, 0.5, 1e-12, "midpoint value is half the span");

        double worst = 0.0;
        for (int i = 0; i <= 1000; ++i) {
            const double x = i / 1000.0;
            worst = std::max(worst, std::fabs(evaluate(tr, x) - legacyEaseInOut(x)));
        }
        CHECK(worst < 1e-9, "EaseInOut exact as a 3-key track (< 1e-9)");
    }

    // Elastic / Spring have no representation and must degrade to Linear.
    {
        EaseCurve c;
        CHECK(!legacyEasingToBezier(4, 0.0, c), "Elastic has no bezier representation");
        CHECK(!legacyEasingToBezier(5, 0.0, c), "Spring has no bezier representation");

        ParamTrack tr;
        buildLegacyTrack(tr, 0.0, 10.0, /*Elastic*/4, 0.0);
        CHECK(tr.keys.size() == 2, "Elastic falls back to a 2-key track");
        CHECK_NEAR(evaluate(tr, 0.5), 5.0, 1e-12, "Elastic fallback is linear");
    }
}

static void test_rotation_unwrapped() {
    std::cout << "[5] rotation 350 -> 370 travels +20 (never wrapped to -340)\n";

    ZoomPanRotSettings z;
    z.enabled = true;
    z.startRotation  = 350.0f;
    z.targetRotation = 370.0f;
    z.rotEasing = 0;   // linear, so the midpoint is unambiguous

    ZprTracks tr;
    buildZprTracks(tr, z);

    CHECK_NEAR(evaluate(tr.rotationDeg, 0.0),  350.0, 1e-9, "start is 350");
    CHECK_NEAR(evaluate(tr.rotationDeg, 0.5),  360.0, 1e-9,
               "midpoint is 360 (short way), not 180 (wrapped)");
    CHECK_NEAR(evaluate(tr.rotationDeg, 1.0),  370.0, 1e-9, "end is 370, not 10");

    // The whole sweep stays monotonically increasing — a wrap would dip.
    bool monotonic = true;
    double prev = evaluate(tr.rotationDeg, 0.0);
    for (int i = 1; i <= 200; ++i) {
        const double v = evaluate(tr.rotationDeg, i / 200.0);
        if (v < prev - 1e-9) monotonic = false;
        prev = v;
    }
    CHECK(monotonic, "rotation sweep is monotonic (no wrap discontinuity)");

    // Large unbounded values must survive untouched.
    ZoomPanRotSettings big;
    big.enabled = true;
    big.startRotation  = 0.0f;
    big.targetRotation = 1080.0f;    // three full turns
    big.rotEasing = 0;
    ZprTracks bt;
    buildZprTracks(bt, big);
    CHECK_NEAR(evaluate(bt.rotationDeg, 1.0), 1080.0, 1e-9, "1080 degrees stays 1080");
}

static void test_zoom_log2_space() {
    std::cout << "[6] zoom 1x -> 8x midpoint is ~2.83x (log2), NOT 4.5x (linear)\n";

    ZoomPanRotSettings z;
    z.enabled    = true;
    z.startZoom  = 1.0f;
    z.targetZoom = 8.0f;
    z.zoomEasing = 0;   // linear progress, so only the SPACE is under test

    ZprTracks tr;
    buildZprTracks(tr, z);

    CHECK_NEAR(evaluate(tr.zoomLog2, 0.0), 0.0, 1e-12, "log2(1x) == 0");
    CHECK_NEAR(evaluate(tr.zoomLog2, 1.0), 3.0, 1e-12, "log2(8x) == 3");

    const double midLinearZoom = zprLog2ToZoom(evaluate(tr.zoomLog2, 0.5));
    CHECK_NEAR(midLinearZoom, 2.8284271247, 1e-6, "midpoint is 2**1.5 = 2.828x");
    CHECK(std::fabs(midLinearZoom - 4.5) > 1.0, "midpoint is NOT the linear 4.5x");

    // Endpoints must remain bit-exact through the log2 round trip — this is the
    // half of the acceptance criterion that v1 projects still hold to.
    CHECK_NEAR(zprLog2ToZoom(evaluate(tr.zoomLog2, 0.0)), 1.0, 0.0, "start zoom bit-exact 1.0");
    CHECK_NEAR(zprLog2ToZoom(evaluate(tr.zoomLog2, 1.0)), 8.0, 1e-12, "end zoom 8.0");

    // Equal steps of t are equal RATIOS of magnification — the property linear
    // interpolation lacks and the reason for the change. Stated on the log2
    // values, where it is an exact statement about equal DIFFERENCES; the
    // equivalent claim on linear zoom can only be checked to float precision,
    // because zprLog2ToZoom returns float.
    const double l1 = evaluate(tr.zoomLog2, 0.25);
    const double l2 = evaluate(tr.zoomLog2, 0.50);
    const double l3 = evaluate(tr.zoomLog2, 0.75);
    CHECK_NEAR(l2 - l1, l3 - l2, 1e-12, "equal t steps give equal log2 differences");

    const double q1 = zprLog2ToZoom(l1);
    const double q2 = zprLog2ToZoom(l2);
    const double q3 = zprLog2ToZoom(l3);
    CHECK_NEAR(q2 / q1, q3 / q2, 1e-6, "equal t steps give equal zoom ratios (float precision)");

    // Past the last key the value holds, which is the spec's "hold the final
    // keyframe for the rest of the note".
    CHECK_NEAR(zprLog2ToZoom(evaluate(tr.zoomLog2, 1.5)), 8.0, 1e-12, "holds at target past t=1");

    // A zero/negative zoom in a hand-edited project must not produce -inf.
    ZoomPanRotSettings bad;
    bad.enabled = true;
    bad.startZoom = 0.0f;
    bad.targetZoom = 2.0f;
    ZprTracks bt;
    buildZprTracks(bt, bad);
    CHECK(std::isfinite(evaluate(bt.zoomLog2, 0.0)), "zoom 0 clamps to a finite log2");
}

static void test_empty_track_constant_value() {
    std::cout << "[7] empty keys vector returns constantValue\n";

    ParamTrack tr;
    tr.constantValue = 0.375;
    CHECK(!tr.animated(), "a track with no keys reports not animated");
    CHECK_NEAR(evaluate(tr, 0.0),  0.375, 0.0, "t=0 returns constantValue");
    CHECK_NEAR(evaluate(tr, 0.5),  0.375, 0.0, "t=0.5 returns constantValue");
    CHECK_NEAR(evaluate(tr, 1.0),  0.375, 0.0, "t=1 returns constantValue");
    CHECK_NEAR(evaluate(tr, -5.0), 0.375, 0.0, "out-of-range t returns constantValue");

    // Single-key track clamps to that key at every time.
    ParamTrack one;
    Keyframe k; k.t = 0.4; k.value = 7.0;
    insertKeyframe(one, k);
    CHECK_NEAR(evaluate(one, 0.0), 7.0, 0.0, "before the only key -> its value");
    CHECK_NEAR(evaluate(one, 1.0), 7.0, 0.0, "after the only key -> its value");
}

static void test_keyframe_invariants() {
    std::cout << "[8] insert keeps keys sorted; edits/removes behave\n";

    ParamTrack tr;
    Keyframe a; a.t = 1.0; a.value = 10.0;
    Keyframe b; b.t = 0.0; b.value = 0.0;
    Keyframe c; c.t = 0.5; c.value = 5.0;
    insertKeyframe(tr, a);
    insertKeyframe(tr, b);
    insertKeyframe(tr, c);

    CHECK(tr.keys.size() == 3, "three keys inserted");
    bool sorted = true;
    for (std::size_t i = 1; i < tr.keys.size(); ++i)
        if (tr.keys[i - 1].t > tr.keys[i].t) sorted = false;
    CHECK(sorted, "keys are sorted ascending by t regardless of insert order");

    // Duplicate t replaces rather than creating a zero-width segment.
    Keyframe dup; dup.t = 0.5; dup.value = 99.0;
    insertKeyframe(tr, dup);
    CHECK(tr.keys.size() == 3, "inserting at an existing t replaces, not duplicates");
    CHECK_NEAR(evaluate(tr, 0.5), 99.0, 1e-12, "replacement value is live");

    CHECK(setKeyframeValue(tr, 1, 50.0), "setKeyframeValue in range");
    CHECK_NEAR(evaluate(tr, 0.5), 50.0, 1e-12, "edited value is live");
    CHECK(!setKeyframeValue(tr, 99, 0.0), "setKeyframeValue out of range rejected");

    const std::size_t moved = moveKeyframe(tr, 1, 0.9);
    CHECK(moved != static_cast<std::size_t>(-1), "moveKeyframe in range");
    sorted = true;
    for (std::size_t i = 1; i < tr.keys.size(); ++i)
        if (tr.keys[i - 1].t > tr.keys[i].t) sorted = false;
    CHECK(sorted, "still sorted after a move that reorders");

    CHECK(removeKeyframe(tr, 0), "removeKeyframe in range");
    CHECK(tr.keys.size() == 2, "key count drops after remove");
    CHECK(!removeKeyframe(tr, 99), "removeKeyframe out of range rejected");
}

static void test_v1_payload_migration() {
    std::cout << "[9] migration of a v1 payload (no tracks block)\n";

    // A v1 zoomPanRot object exactly as a pre-v2 project writes it.
    nlohmann::json jz = {
        {"enabled",        true},
        {"startZoom",      1.0},
        {"targetZoom",     4.0},
        {"startPanX",      0.0},
        {"startPanY",      0.0},
        {"targetPanX",     0.5},
        {"targetPanY",    -0.25},
        {"startRotation",  350.0},
        {"targetRotation", 370.0},
        {"durationMs",     300.0},
        {"zoomEasing",     1},        // Ease Out
        {"panEasing",      0},        // Linear
        {"rotEasing",      3},        // Ease Out Back
        {"overshoot",      1.70158},
    };
    CHECK(!jz.contains("tracks"), "v1 payload has no tracks block");

    ZoomPanRotSettings z;
    z.enabled        = jz.value("enabled", false);
    z.startZoom      = jz.value("startZoom", 1.0f);
    z.targetZoom     = jz.value("targetZoom", 1.0f);
    z.startPanX      = jz.value("startPanX", 0.0f);
    z.startPanY      = jz.value("startPanY", 0.0f);
    z.targetPanX     = jz.value("targetPanX", 0.0f);
    z.targetPanY     = jz.value("targetPanY", 0.0f);
    z.startRotation  = jz.value("startRotation", 0.0f);
    z.targetRotation = jz.value("targetRotation", 0.0f);
    z.durationMs     = jz.value("durationMs", 300.0f);
    z.zoomEasing     = jz.value("zoomEasing", 1);
    z.panEasing      = jz.value("panEasing", 1);
    z.rotEasing      = jz.value("rotEasing", 1);
    z.overshoot      = jz.value("overshoot", 1.70158f);

    loadOrMigrateZprTracks(jz, z);

    CHECK(z.tracks.zoomLog2.animated(), "migration produced an animated zoom track");
    CHECK(z.tracks.zoomLog2.keys.size() == 2, "EaseOut zoom -> 2 keyframes");
    CHECK(z.tracks.panX.keys.size() == 2,     "Linear panX -> 2 keyframes");
    CHECK(z.tracks.rotationDeg.keys.size() == 2, "EaseOutBack rotation -> 2 keyframes");

    // ── ENDPOINTS ARE BIT-EXACT ──────────────────────────────────────────
    // This is the surviving half of the acceptance criterion: v1 endpoints and
    // hold state are unchanged. Only the interior is reparameterized.
    CHECK_NEAR(zprLog2ToZoom(evaluate(z.tracks.zoomLog2, 0.0)), 1.0,   0.0,  "t=0 zoom bit-exact");
    CHECK_NEAR(zprLog2ToZoom(evaluate(z.tracks.zoomLog2, 1.0)), 4.0,   1e-12,"t=1 zoom exact");
    CHECK_NEAR(evaluate(z.tracks.panX, 0.0),        0.0,   0.0,  "t=0 panX bit-exact");
    CHECK_NEAR(evaluate(z.tracks.panX, 1.0),        0.5,   1e-12,"t=1 panX exact");
    CHECK_NEAR(evaluate(z.tracks.panY, 1.0),       -0.25,  1e-12,"t=1 panY exact");
    CHECK_NEAR(evaluate(z.tracks.rotationDeg, 0.0), 350.0, 0.0,  "t=0 rotation bit-exact");
    CHECK_NEAR(evaluate(z.tracks.rotationDeg, 1.0), 370.0, 1e-12,"t=1 rotation exact");

    // ── HOLD STATE IS BIT-EXACT ──────────────────────────────────────────
    CHECK_NEAR(zprLog2ToZoom(evaluate(z.tracks.zoomLog2, 2.0)), 4.0, 1e-12,
               "post-animation hold zoom unchanged");
    CHECK_NEAR(evaluate(z.tracks.rotationDeg, 2.0), 370.0, 1e-12,
               "post-animation hold rotation unchanged");

    // ── PROGRESS CURVE IS PRESERVED EXACTLY ──────────────────────────────
    // Pan is linear-eased, so its interior is unchanged from v1 too: the log2
    // change affects zoom only.
    for (int i = 0; i <= 100; ++i) {
        const double t = i / 100.0;
        const double want = 0.0 + (0.5 - 0.0) * legacyEaseLinear(t);
        if (!isNear(evaluate(z.tracks.panX, t), want, 1e-9)) {
            CHECK(false, "panX interior matches v1 exactly");
            break;
        }
        if (i == 100) CHECK(true, "panX interior matches v1 exactly (linear easing)");
    }

    // Rotation keeps its EaseOutBack curve exactly, overshoot included.
    //
    // The reference must use the FLOAT-rounded overshoot, because that is what
    // the engine actually curves with: ZoomPanRotSettings::overshoot is a float,
    // so the JSON's 1.70158 is stored as 1.70158004… before it reaches the
    // bezier. Comparing against the full-precision double would measure that
    // rounding, not the mapping.
    const double kOvershoot = static_cast<double>(static_cast<float>(1.70158));
    double rotWorst = 0.0;
    for (int i = 0; i <= 100; ++i) {
        const double t = i / 100.0;
        const double want = 350.0 + (370.0 - 350.0) * legacyEaseOutBack(t, kOvershoot);
        rotWorst = std::max(rotWorst, std::fabs(evaluate(z.tracks.rotationDeg, t) - want));
    }
    CHECK(rotWorst < 1e-9, "rotation interior matches v1 EaseOutBack exactly");

    // ── ZOOM INTERIOR IS THE DOCUMENTED, INTENTIONAL DIFFERENCE ──────────
    const double legacyMid = 1.0 + (4.0 - 1.0) * legacyEaseOut(0.5);          // 3.25
    const double newMid    = zprLog2ToZoom(evaluate(z.tracks.zoomLog2, 0.5));
    CHECK(std::fabs(newMid - legacyMid) > 0.1,
          "zoom interior intentionally differs from v1 (log2 reparameterization)");
    // Progress curve is still EaseOut — in log space. Tolerance is float-scale
    // because newMid came back through zprLog2ToZoom, which returns float.
    CHECK_NEAR(newMid, std::exp2(0.0 + (2.0 - 0.0) * legacyEaseOut(0.5)), 1e-6,
               "zoom interior is EaseOut applied in log2 space");
}

static void test_v2_roundtrip() {
    std::cout << "[10] v2 payload round-trips and is loaded verbatim\n";

    ZoomPanRotSettings z;
    z.enabled = true;
    z.startZoom = 1.0f; z.targetZoom = 4.0f;
    z.zoomEasing = 3; z.panEasing = 2; z.rotEasing = 1;
    buildZprTracks(z.tracks, z);

    const nlohmann::json jt = zprTracksToJson(z.tracks);
    nlohmann::json jz = { {"tracks", jt} };

    ZoomPanRotSettings loaded;   // deliberately left at defaults
    loadOrMigrateZprTracks(jz, loaded);

    CHECK(loaded.tracks.zoomLog2.keys.size() == z.tracks.zoomLog2.keys.size(),
          "zoom keyframe count round-trips");
    CHECK(loaded.tracks.panX.keys.size() == 3,
          "EaseInOut pan track round-trips its 3 keyframes");

    double worst = 0.0;
    for (int i = 0; i <= 200; ++i) {
        const double t = i / 200.0;
        worst = std::max(worst, std::fabs(evaluate(loaded.tracks.zoomLog2, t)
                                        - evaluate(z.tracks.zoomLog2, t)));
    }
    CHECK(worst < 1e-12, "loaded track evaluates identically to the saved one");

    // Loaded verbatim means the DEFAULT scalars on `loaded` were NOT used.
    CHECK(loaded.tracks.zoomLog2.animated(),
          "tracks came from the payload, not from the (default) scalars");
    CHECK_NEAR(zprLog2ToZoom(evaluate(loaded.tracks.zoomLog2, 1.0)), 4.0, 1e-9,
               "target zoom 4.0 survived despite scalars defaulting to 1.0");

    // Unsorted keys in a hand-edited file get normalized on load.
    nlohmann::json scrambled = {
        {"zoomLog2", {
            {"constantValue", 0.0},
            {"keys", nlohmann::json::array({
                { {"t", 1.0}, {"v", 3.0} },
                { {"t", 0.0}, {"v", 0.0} },
                { {"t", 0.5}, {"v", 1.0} },
            })}
        }}
    };
    ZoomPanRotSettings sc;
    loadOrMigrateZprTracks(nlohmann::json{ {"tracks", scrambled} }, sc);
    bool sorted = true;
    for (std::size_t i = 1; i < sc.tracks.zoomLog2.keys.size(); ++i)
        if (sc.tracks.zoomLog2.keys[i - 1].t > sc.tracks.zoomLog2.keys[i].t) sorted = false;
    CHECK(sorted, "out-of-order keys in a loaded payload are sorted");
}

static void test_authored_tracks_are_not_clobbered() {
    std::cout << "[11] authored curves survive a scalar write (no silent clobber)\n";

    // A round trip through this build writes DERIVED tracks, so ordinary
    // scalar editing must keep working.
    {
        ZoomPanRotSettings z;
        z.enabled = true; z.startZoom = 1.0f; z.targetZoom = 2.0f; z.zoomEasing = 1;
        buildZprTracks(z.tracks, z);
        CHECK(!z.tracks.authored, "freshly derived tracks are not marked authored");

        nlohmann::json jz = { {"targetZoom", 2.0}, {"zoomEasing", 1},
                              {"tracks", zprTracksToJson(z.tracks)} };
        ZoomPanRotSettings rt;
        rt.enabled = true; rt.startZoom = 1.0f; rt.targetZoom = 2.0f; rt.zoomEasing = 1;
        loadOrMigrateZprTracks(jz, rt);
        CHECK(!rt.tracks.authored,
              "a round trip of derived tracks does NOT latch authored");
    }

    // Curves the scalars cannot reproduce DO latch, so a later scalar write
    // cannot flatten them.
    {
        nlohmann::json authored = {
            {"zoomLog2", {
                {"constantValue", 0.0},
                {"keys", nlohmann::json::array({
                    { {"t", 0.0},  {"v", 0.0} },
                    { {"t", 0.33}, {"v", 2.0} },   // a shape no 2-key ramp has
                    { {"t", 0.66}, {"v", 0.5} },
                    { {"t", 1.0},  {"v", 1.0} },
                })}
            }}
        };
        ZoomPanRotSettings z;
        z.enabled = true; z.startZoom = 1.0f; z.targetZoom = 2.0f;
        loadOrMigrateZprTracks(nlohmann::json{ {"tracks", authored} }, z);

        CHECK(z.tracks.authored, "hand-authored curves latch authored=true");
        CHECK(z.tracks.zoomLog2.keys.size() == 4, "all four keyframes loaded");
        CHECK_NEAR(zprLog2ToZoom(evaluate(z.tracks.zoomLog2, 0.33)), 4.0, 1e-6,
                   "authored interior keyframe is live");
    }

    // zprTracksEquivalent itself: same curves compare equal, a nudged one does not.
    {
        ZoomPanRotSettings z;
        z.enabled = true; z.targetZoom = 3.0f; z.zoomEasing = 3;
        ZprTracks a, b;
        buildZprTracks(a, z);
        buildZprTracks(b, z);
        CHECK(zprTracksEquivalent(a, b), "identical derived tracks compare equivalent");
        b.zoomLog2.keys.back().value += 0.01;
        CHECK(!zprTracksEquivalent(a, b), "a nudged keyframe compares non-equivalent");
    }
}

// ---------------------------------------------------------------------------
// [12] ACCEPTANCE: load a REAL pre-v2 project off disk and verify the migration
// contract end to end.
//
// The contract (amended from "byte-identical", which log2 zoom makes
// impossible by construction):
//   v1-migrated project endpoints and post-animation hold state are bit-exact;
//   the interior differs ONLY by the documented log2 reparameterization.
//
// Skips cleanly when the fixture is absent so this does not become a
// machine-specific test.
// ---------------------------------------------------------------------------
static void test_real_v1_project_migration() {
    std::cout << "[12] ACCEPTANCE — real pre-v2 project on disk migrates correctly\n";

    const std::string dir =
        "C:\\Users\\Krasen\\Desktop\\XLETH\\diagnostics\\pdc-stage7a\\NO_MAIL_project_copy";
    std::ifstream probe(dir + "\\project.json");
    if (!probe.good()) {
        std::cout << "    skip:  fixture not present on this machine\n";
        return;
    }
    probe.close();

    ProjectManager pm;
    auto loaded = pm.loadProject(dir);
    CHECK(loaded.has_value(), "real v1 project loads");
    if (!loaded) return;

    CHECK(pm.loadedSchemaVersion() < XLETH_PROJECT_SCHEMA_VERSION,
          "fixture really is a pre-v6 project");

    Timeline tl = std::move(*loaded);

    const TrackInfo* zprTrack = nullptr;
    for (const auto* t : tl.getAllTracks())
        if (t && t->zoomPanRot.enabled) { zprTrack = t; break; }

    CHECK(zprTrack != nullptr, "found a track with an enabled Zoom/Pan/Rot");
    if (!zprTrack) return;

    const ZoomPanRotSettings& z = zprTrack->zoomPanRot;
    std::cout << "    info:  track " << zprTrack->id
              << "  zoom " << z.startZoom << " -> " << z.targetZoom
              << "  easing " << z.zoomEasing << "\n";

    CHECK(z.tracks.zoomLog2.animated(), "migration built curves on load");
    CHECK(!z.tracks.authored, "a v1 project is derived, never flagged authored");

    // ── Endpoints: bit-exact ─────────────────────────────────────────────
    CHECK_NEAR(zprLog2ToZoom(evaluate(z.tracks.zoomLog2, 0.0)), z.startZoom,  0.0,
               "start zoom BIT-EXACT vs the v1 scalar");
    CHECK_NEAR(zprLog2ToZoom(evaluate(z.tracks.zoomLog2, 1.0)), z.targetZoom, 1e-6,
               "target zoom matches the v1 scalar");
    CHECK_NEAR(evaluate(z.tracks.panX, 0.0), z.startPanX, 0.0, "start panX BIT-EXACT");
    CHECK_NEAR(evaluate(z.tracks.panX, 1.0), z.targetPanX, 1e-9, "target panX exact");
    CHECK_NEAR(evaluate(z.tracks.panY, 1.0), z.targetPanY, 1e-9, "target panY exact");
    CHECK_NEAR(evaluate(z.tracks.rotationDeg, 0.0), z.startRotation, 0.0,
               "start rotation BIT-EXACT");
    CHECK_NEAR(evaluate(z.tracks.rotationDeg, 1.0), z.targetRotation, 1e-9,
               "target rotation exact");

    // ── Post-animation hold: bit-exact ───────────────────────────────────
    CHECK_NEAR(zprLog2ToZoom(evaluate(z.tracks.zoomLog2, 3.0)),
               zprLog2ToZoom(evaluate(z.tracks.zoomLog2, 1.0)), 0.0,
               "hold state past t=1 is bit-exact with the target");

    // ── Pan / rotation interiors: unchanged from v1 ──────────────────────
    // Both are flat on this track, and a flat channel must stay flat.
    double panWorst = 0.0, rotWorst = 0.0;
    for (int i = 0; i <= 200; ++i) {
        const double t = i / 200.0;
        panWorst = std::max(panWorst, std::fabs(evaluate(z.tracks.panX, t) - z.startPanX));
        rotWorst = std::max(rotWorst,
                            std::fabs(evaluate(z.tracks.rotationDeg, t) - z.startRotation));
    }
    CHECK(panWorst < 1e-12, "pan interior unchanged (flat channel stays flat)");
    CHECK(rotWorst < 1e-12, "rotation interior unchanged");

    // ── Zoom interior: differs ONLY by the log2 reparameterization ───────
    // Reproduce both curves and quantify the divergence, so the report can
    // state the real magnitude rather than assert it is "small".
    double worstAbs = 0.0, worstAtT = 0.0;
    for (int i = 0; i <= 200; ++i) {
        const double t = i / 200.0;
        const double eased = legacyEaseOut(t);                       // this track's easing
        const double v1  = z.startZoom + (z.targetZoom - z.startZoom) * eased;
        const double v2  = zprLog2ToZoom(evaluate(z.tracks.zoomLog2, t));
        // v2 must be exactly the same easing applied in log2 space.
        const double predicted = std::exp2(zprZoomToLog2(z.startZoom)
            + (zprZoomToLog2(z.targetZoom) - zprZoomToLog2(z.startZoom)) * eased);
        if (std::fabs(v2 - predicted) > 1e-6) {
            CHECK(false, "zoom interior is NOT the documented log2 reparameterization");
            return;
        }
        if (std::fabs(v2 - v1) > worstAbs) { worstAbs = std::fabs(v2 - v1); worstAtT = t; }
    }
    CHECK(true, "zoom interior is exactly the documented log2 reparameterization");

    std::printf("    info:  max zoom divergence from v1 = %.6f x (%.4f%%) at t=%.2f\n",
                worstAbs, 100.0 * worstAbs / z.targetZoom, worstAtT);
}

int main() {
    std::cout << "=== test_param_track ===\n";
    test_bezier_solver_accuracy();
    test_fast_path_matches_solver();
    test_overshoot_preserved();
    test_legacy_easing_mapping_is_exact();
    test_rotation_unwrapped();
    test_zoom_log2_space();
    test_empty_track_constant_value();
    test_keyframe_invariants();
    test_v1_payload_migration();
    test_v2_roundtrip();
    test_authored_tracks_are_not_clobbered();
    test_real_v1_project_migration();

    if (g_failures == 0) {
        std::cout << "\nALL PASS\n";
        return 0;
    }
    std::cout << "\n" << g_failures << " FAILURE(S)\n";
    return 1;
}
