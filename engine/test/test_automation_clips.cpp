// ===========================================================================
// test_automation_clips — automation clip engine + model (Phase A).
// ===========================================================================
//
// Covers the locked semantics from docs/plans/automation-clips-system-spec.docx:
//
//   §3 data model      sorted-point invariant, duplicate-tick replace,
//                      make-unique splitting a shared envelope
//   §4 evaluation      inside a clip, hold in the gap, instant take-over at a
//                      new clip's first point, base value before anything has
//                      played, same-lane overlap rejection, topmost-lane-wins
//   §4 determinism     the same tick evaluated from independently built plans
//                      returns bit-identical values
//   §6 deletion        effectInstanceId -> bound clips, and the one-step
//                      removal command that undoes cleanly
//   §9 serialization   round-trip through Timeline JSON and through a real
//                      project.json, including the dead-clip rule
//
// Pure CPU — no JUCE, no audio device, no GPU. Links XlethEngineModel only.

#include "audio/AutomationPlan.h"
#include "commands/TimelineCommands.h"
#include "commands/UndoManager.h"
#include "model/AutomationEnvelope.h"
#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "project/ProjectManager.h"

#include <cmath>
#include <cstdio>
#include <filesystem>
#include <memory>
#include <iostream>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using namespace xleth::automation;

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
        if (!isNear(va_, vb_, (eps))) {                                        \
            std::cout << "    FAIL: " << (msg) << "  (got " << va_             \
                      << ", want " << vb_ << ", eps " << (eps) << ")\n";       \
            ++g_failures;                                                      \
        } else {                                                               \
            std::cout << "    ok:   " << (msg) << "\n";                        \
        }                                                                      \
    } while (0)

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

static AutomationBinding makeBinding(int trackId, const char* fx, const char* param) {
    AutomationBinding b;
    b.ownerTrackId     = trackId;
    b.effectInstanceId = fx;
    b.parameterId      = param;
    return b;
}

static AutomationPoint pt(int64_t tick, double value) {
    AutomationPoint p;
    p.tick.ticks = tick;
    p.value      = value;
    return p;
}

// Adds a track so a non-master lane has a legitimate owner.
static int addTestTrack(Timeline& tl, const char* name) {
    TrackInfo t;
    t.name = name;
    return tl.addTrack(t);
}

// Builds a plan with everything resolvable (model-only: no live chains).
// AutomationPlan is a ~400 KB fixed-capacity struct. Every plan in this file is
// heap-allocated for the same reason MixEngine holds it behind a shared_ptr: two
// of them as stack locals overflow Windows' 1 MB default thread stack.
static void buildAll(const Timeline& tl, AutomationPlan& plan) {
    buildAutomationPlan(tl, {}, {}, plan);
}

// Index of the target for `binding` in `plan`, or -1.
static int findTarget(const AutomationPlan& plan, const AutomationBinding& b) {
    for (int i = 0; i < plan.targetCount; ++i) {
        const auto& t = plan.targets[i];
        if (t.ownerTrackId == b.ownerTrackId && t.effectInstanceId == b.effectInstanceId
            && t.parameterId == b.parameterId)
            return i;
    }
    return -1;
}

// ---------------------------------------------------------------------------
// 1. Sorted-point invariant + duplicate-tick replace
// ---------------------------------------------------------------------------

static void testPointInvariant() {
    std::cout << "\n[1] point list invariant\n";

    std::vector<AutomationPoint> pts;
    insertPoint(pts, pt(1920, 0.9));
    insertPoint(pts, pt(0,    0.1));
    insertPoint(pts, pt(960,  0.5));

    CHECK(pts.size() == 3, "three points inserted out of order");
    CHECK(pts[0].tick.ticks == 0 && pts[1].tick.ticks == 960 && pts[2].tick.ticks == 1920,
          "points are sorted ascending by tick regardless of insert order");

    // Duplicate tick REPLACES, never stacks — mirrors paramtrack::insertKeyframe.
    const std::size_t idx = insertPoint(pts, pt(960, 0.75));
    CHECK(pts.size() == 3, "inserting at an existing tick does not grow the list");
    CHECK(idx == 1, "the replacement lands at the existing index");
    CHECK_NEAR(pts[1].value, 0.75, 1e-12, "duplicate tick replaced the value");

    // Values are clamped into [0,1] on the way in.
    insertPoint(pts, pt(2880, 4.2));
    CHECK_NEAR(pts[3].value, 1.0, 1e-12, "out-of-range value clamps to 1.0");
    insertPoint(pts, pt(3840, -7.0));
    CHECK_NEAR(pts[4].value, 0.0, 1e-12, "negative value clamps to 0.0");

    // movePoint re-sorts, and merges onto a point it lands exactly on.
    std::vector<AutomationPoint> m;
    insertPoint(m, pt(0, 0.0));
    insertPoint(m, pt(480, 0.5));
    insertPoint(m, pt(960, 1.0));
    const std::size_t landed = movePoint(m, 1, 1440, 0.25);
    CHECK(m.size() == 3, "moving a point does not change the count");
    CHECK(landed == 2, "moved point re-sorted to the end");
    CHECK(m[2].tick.ticks == 1440, "moved point carries its new tick");

    movePoint(m, 2, 960, 0.3);   // onto the existing 960 point
    CHECK(m.size() == 2, "moving a point onto another merges them");

    // Curve fields are per segment and independent of the value.
    setPointCurve(m, 0, AutomationCurveType::Tension, 0.4);
    CHECK(m[0].curveType == AutomationCurveType::Tension, "curve type stored per point");
    CHECK_NEAR(m[0].tension, 0.4, 1e-12, "tension stored per point");

    // normalizePoints heals a hand-built / hand-edited list.
    std::vector<AutomationPoint> raw = { pt(960, 0.2), pt(0, 0.4), pt(960, 0.8) };
    normalizePoints(raw);
    CHECK(raw.size() == 2, "normalize collapses duplicate ticks");
    CHECK(raw[0].tick.ticks == 0 && raw[1].tick.ticks == 960, "normalize sorts by tick");
    CHECK_NEAR(raw[1].value, 0.8, 1e-12, "duplicate collapse keeps the last one");
}

// ---------------------------------------------------------------------------
// 2. Envelope evaluation core
// ---------------------------------------------------------------------------

static void testEnvelopeEvaluation() {
    std::cout << "\n[2] envelope evaluation\n";

    std::vector<AutomationPoint> pts;
    insertPoint(pts, pt(0,    0.0));
    insertPoint(pts, pt(960,  1.0));

    CHECK_NEAR(evaluatePoints(pts, -100, 0.7), 0.0, 1e-12,
               "before the first point yields the first point's value");
    CHECK_NEAR(evaluatePoints(pts, 0, 0.7), 0.0, 1e-12, "at the first point");
    CHECK_NEAR(evaluatePoints(pts, 480, 0.7), 0.5, 1e-12, "midpoint of a linear segment");
    CHECK_NEAR(evaluatePoints(pts, 960, 0.7), 1.0, 1e-12, "at the last point");
    CHECK_NEAR(evaluatePoints(pts, 5000, 0.7), 1.0, 1e-12,
               "after the last point holds the last point's value");

    std::vector<AutomationPoint> empty;
    CHECK_NEAR(evaluatePoints(empty, 480, 0.42), 0.42, 1e-12,
               "an empty point list yields the supplied fallback");

    // A Tension segment evaluates linearly in v1 — stored, not yet honoured.
    std::vector<AutomationPoint> t;
    insertPoint(t, pt(0, 0.0));
    insertPoint(t, pt(960, 1.0));
    setPointCurve(t, 0, AutomationCurveType::Tension, 0.9);
    CHECK_NEAR(evaluatePoints(t, 480, 0.0), 0.5, 1e-12,
               "v1 evaluates a Tension segment linearly (field is carried, not applied)");

    // Many points: the binary search must agree with a hand-computed value.
    std::vector<AutomationPoint> many;
    for (int i = 0; i <= 64; ++i) insertPoint(many, pt(i * 100, i / 64.0));
    CHECK_NEAR(evaluatePoints(many, 3250, 0.0), (32.5 / 64.0), 1e-12,
               "binary search finds the right segment in a dense envelope");
}

// ---------------------------------------------------------------------------
// 3. Same-lane overlap rejection (mutation layer)
// ---------------------------------------------------------------------------

static void testSameLaneOverlapRejected() {
    std::cout << "\n[3] same-lane overlap rejection\n";

    Timeline tl;
    const int trackId = addTestTrack(tl, "Lead");

    AutomationLane lane; lane.ownerTrackId = trackId; lane.index = 0;
    const int laneId = tl.addAutomationLane(lane);
    CHECK(laneId > 0, "lane created");

    AutomationEnvelope env;
    env.binding = makeBinding(trackId, "fx-1", "mix");
    env.points  = { pt(0, 0.0), pt(960, 1.0) };
    const int envId = tl.addAutomationEnvelope(env);

    AutomationClip c;
    c.laneId = laneId; c.envelopeId = envId;
    c.position.ticks = 960; c.duration.ticks = 1920;
    const int firstId = tl.addAutomationClip(c);
    CHECK(firstId > 0, "first clip accepted");

    AutomationClip overlapping = c;
    overlapping.position.ticks = 1920;   // starts inside [960, 2880)
    CHECK(tl.addAutomationClip(overlapping) < 0, "overlapping clip on the same lane is rejected");

    AutomationClip abutting = c;
    abutting.position.ticks = 2880;      // exactly at the first clip's end
    const int abuttingId = tl.addAutomationClip(abutting);
    CHECK(abuttingId > 0, "an abutting clip (half-open intervals) is accepted");

    // Move into an overlap is rejected too, and leaves the clip where it was.
    CHECK(!tl.moveAutomationClip(abuttingId, laneId, TickTime{1000}),
          "moving a clip into an overlap is rejected");
    CHECK(tl.getAutomationClip(abuttingId)->position.ticks == 2880,
          "a rejected move leaves the clip untouched");

    // Resizing into the neighbour is rejected.
    CHECK(!tl.resizeAutomationClip(firstId, TickTime{4000}),
          "resizing a clip over its neighbour is rejected");
    CHECK(tl.getAutomationClip(firstId)->duration.ticks == 1920,
          "a rejected resize leaves the duration untouched");

    // The same placement on a DIFFERENT lane is fine — cross-lane overlap is
    // resolved at evaluation time, not forbidden.
    AutomationLane lane2; lane2.ownerTrackId = trackId; lane2.index = 1;
    const int laneId2 = tl.addAutomationLane(lane2);
    AutomationClip other = c;
    other.laneId = laneId2;
    CHECK(tl.addAutomationClip(other) > 0, "the same span on another lane is accepted");

    // A rejected command must not enter the undo stack.
    UndoManager undo;
    AutomationClip dupe = c;
    auto cmd = std::make_unique<AddAutomationClipCommand>(dupe);
    AddAutomationClipCommand* cmdRaw = cmd.get();
    undo.execute(std::move(cmd), tl);
    CHECK(!undo.canUndo(), "a rejected AddAutomationClipCommand records no undo step");
    // The id IS the RPC's return value, so a rejection has to report -1 rather
    // than echoing back whatever id the incoming payload happened to carry.
    CHECK(cmdRaw->clipId() == -1, "a rejected AddAutomationClipCommand reports clipId() == -1");
}

// ---------------------------------------------------------------------------
// 4. Plan semantics: cover / hold / instant take-over / base
// ---------------------------------------------------------------------------

static void testPlanSemantics() {
    std::cout << "\n[4] plan evaluation semantics\n";

    Timeline tl;
    const int trackId = addTestTrack(tl, "Lead");
    const AutomationBinding binding = makeBinding(trackId, "fx-1", "mix");
    tl.setAutomationBaseValue(binding, 0.25);

    AutomationLane lane; lane.ownerTrackId = trackId; lane.index = 0;
    const int laneId = tl.addAutomationLane(lane);

    // Clip A: [960, 1920), ramps 0 -> 1 over its first 480 ticks then holds 1.
    AutomationEnvelope envA;
    envA.binding = binding;
    envA.points  = { pt(0, 0.0), pt(480, 1.0) };
    const int envAId = tl.addAutomationEnvelope(envA);

    AutomationClip a;
    a.laneId = laneId; a.envelopeId = envAId;
    a.position.ticks = 960; a.duration.ticks = 960;
    CHECK(tl.addAutomationClip(a) > 0, "clip A placed");

    // Clip B: [3840, 4800), flat at 0.2 from its very first point.
    AutomationEnvelope envB;
    envB.binding = binding;
    envB.points  = { pt(0, 0.2) };
    const int envBId = tl.addAutomationEnvelope(envB);

    AutomationClip b;
    b.laneId = laneId; b.envelopeId = envBId;
    b.position.ticks = 3840; b.duration.ticks = 960;
    CHECK(tl.addAutomationClip(b) > 0, "clip B placed");

    auto plan_ = std::make_unique<AutomationPlan>();
    AutomationPlan& plan = *plan_;
    buildAll(tl, plan);
    CHECK(plan.targetCount == 1, "both clips collapse onto ONE target (same binding)");
    const int ti = findTarget(plan, binding);
    CHECK(ti == 0, "target found");
    CHECK(plan.targets[ti].windowCount == 2, "two non-overlapping windows");

    // Before any clip: the parameter's manual (base) value.
    CHECK_NEAR(evaluateTarget(plan, ti, 0),   0.25, 1e-12, "tick 0 -> base value");
    CHECK_NEAR(evaluateTarget(plan, ti, 959), 0.25, 1e-12, "one tick before clip A -> base");

    // Inside clip A.
    CHECK_NEAR(evaluateTarget(plan, ti, 960),  0.0, 1e-12, "clip A start -> its first point");
    CHECK_NEAR(evaluateTarget(plan, ti, 1200), 0.5, 1e-12, "midway through clip A's ramp");
    CHECK_NEAR(evaluateTarget(plan, ti, 1440), 1.0, 1e-12, "clip A's last point");
    CHECK_NEAR(evaluateTarget(plan, ti, 1800), 1.0, 1e-12,
               "past clip A's last point but still inside it -> hold");

    // Gap between A and B: hold A's last point value.
    CHECK_NEAR(evaluateTarget(plan, ti, 1920), 1.0, 1e-12, "first tick of the gap -> hold");
    CHECK_NEAR(evaluateTarget(plan, ti, 3000), 1.0, 1e-12, "deep in the gap -> still holding");
    CHECK_NEAR(evaluateTarget(plan, ti, 3839), 1.0, 1e-12, "last tick of the gap -> still holding");

    // Clip B takes over INSTANTLY at its first point — no ramp out of the hold.
    CHECK_NEAR(evaluateTarget(plan, ti, 3840), 0.2, 1e-12,
               "a newly starting clip takes over instantly at its first point");
    CHECK_NEAR(evaluateTarget(plan, ti, 4799), 0.2, 1e-12, "clip B holds its flat value");
    CHECK_NEAR(evaluateTarget(plan, ti, 4800), 0.2, 1e-12, "after clip B -> hold its last value");

    // A binding with no persisted base and no live resolver falls back to 0.
    Timeline tl2;
    const int t2 = addTestTrack(tl2, "T2");
    AutomationLane l2; l2.ownerTrackId = t2; l2.index = 0;
    const int l2Id = tl2.addAutomationLane(l2);
    AutomationEnvelope e2;
    e2.binding = makeBinding(t2, "fx-x", "gain");
    e2.points  = { pt(0, 0.9) };
    const int e2Id = tl2.addAutomationEnvelope(e2);
    AutomationClip c2; c2.laneId = l2Id; c2.envelopeId = e2Id;
    c2.position.ticks = 1920; c2.duration.ticks = 480;
    tl2.addAutomationClip(c2);

    auto plan2_ = std::make_unique<AutomationPlan>();
    AutomationPlan& plan2 = *plan2_;
    buildAll(tl2, plan2);
    const int ti2 = findTarget(plan2, e2.binding);
    CHECK_NEAR(evaluateTarget(plan2, ti2, 0), 0.0, 1e-12,
               "no persisted base and no live value -> 0.0");

    // ...and with a live resolver it picks up the knob's current position.
    auto plan3_ = std::make_unique<AutomationPlan>();
    AutomationPlan& plan3 = *plan3_;
    buildAutomationPlan(tl2, {},
        [](const AutomationBinding&, double& out) { out = 0.6; return true; }, plan3);
    const int ti3 = findTarget(plan3, e2.binding);
    CHECK_NEAR(evaluateTarget(plan3, ti3, 0), 0.6, 1e-12,
               "no persisted base -> the parameter's live value is used");

    // A persisted base always beats the live value (it IS the manual setting).
    tl2.setAutomationBaseValue(e2.binding, 0.15);
    auto plan4_ = std::make_unique<AutomationPlan>();
    AutomationPlan& plan4 = *plan4_;
    buildAutomationPlan(tl2, {},
        [](const AutomationBinding&, double& out) { out = 0.6; return true; }, plan4);
    const int ti4 = findTarget(plan4, e2.binding);
    CHECK_NEAR(evaluateTarget(plan4, ti4, 0), 0.15, 1e-12,
               "a persisted base value wins over the live parameter value");

    // Left-trim: offset moves the envelope origin, not the points.
    Timeline tl5;
    const int t5 = addTestTrack(tl5, "T5");
    AutomationLane l5; l5.ownerTrackId = t5; l5.index = 0;
    const int l5Id = tl5.addAutomationLane(l5);
    AutomationEnvelope e5;
    e5.binding = makeBinding(t5, "fx-5", "mix");
    e5.points  = { pt(0, 0.0), pt(960, 1.0) };
    const int e5Id = tl5.addAutomationEnvelope(e5);
    AutomationClip c5;
    c5.laneId = l5Id; c5.envelopeId = e5Id;
    c5.position.ticks = 1920; c5.duration.ticks = 480; c5.offset.ticks = 480;
    tl5.addAutomationClip(c5);
    auto plan5_ = std::make_unique<AutomationPlan>();
    AutomationPlan& plan5 = *plan5_;
    buildAll(tl5, plan5);
    const int ti5 = findTarget(plan5, e5.binding);
    CHECK_NEAR(evaluateTarget(plan5, ti5, 1920), 0.5, 1e-12,
               "a left-trimmed clip starts at the envelope value under its new left edge");
}

// ---------------------------------------------------------------------------
// 5. Topmost lane wins across lanes
// ---------------------------------------------------------------------------

static void testTopmostLaneWins() {
    std::cout << "\n[5] cross-lane overlap: topmost lane wins\n";

    Timeline tl;
    const int trackId = addTestTrack(tl, "Lead");
    const AutomationBinding binding = makeBinding(trackId, "fx-1", "mix");

    AutomationLane top;    top.ownerTrackId = trackId;    top.index = 0;
    AutomationLane bottom; bottom.ownerTrackId = trackId; bottom.index = 1;
    const int topId    = tl.addAutomationLane(top);
    const int bottomId = tl.addAutomationLane(bottom);

    // Bottom lane: flat 0.9 over [0, 3840).
    AutomationEnvelope envLow;  envLow.binding  = binding; envLow.points  = { pt(0, 0.9) };
    // Top lane:    flat 0.1 over [960, 1920).
    AutomationEnvelope envHigh; envHigh.binding = binding; envHigh.points = { pt(0, 0.1) };
    const int lowId  = tl.addAutomationEnvelope(envLow);
    const int highId = tl.addAutomationEnvelope(envHigh);

    AutomationClip low;
    low.laneId = bottomId; low.envelopeId = lowId;
    low.position.ticks = 0; low.duration.ticks = 3840;
    tl.addAutomationClip(low);

    AutomationClip high;
    high.laneId = topId; high.envelopeId = highId;
    high.position.ticks = 960; high.duration.ticks = 960;
    tl.addAutomationClip(high);

    auto plan_ = std::make_unique<AutomationPlan>();
    AutomationPlan& plan = *plan_;
    buildAll(tl, plan);
    const int ti = findTarget(plan, binding);
    CHECK(ti >= 0, "target found");
    CHECK(plan.targets[ti].windowCount == 3,
          "overlap splits the bottom clip into two windows around the top one");

    CHECK_NEAR(evaluateTarget(plan, ti, 500),  0.9, 1e-12, "before the overlap: bottom lane");
    CHECK_NEAR(evaluateTarget(plan, ti, 960),  0.1, 1e-12, "overlap start: topmost lane wins");
    CHECK_NEAR(evaluateTarget(plan, ti, 1500), 0.1, 1e-12, "inside the overlap: topmost lane");
    CHECK_NEAR(evaluateTarget(plan, ti, 1920), 0.9, 1e-12,
               "after the overlap the bottom clip resumes at its own value");
    CHECK_NEAR(evaluateTarget(plan, ti, 3839), 0.9, 1e-12, "bottom clip runs to its end");
    CHECK_NEAR(evaluateTarget(plan, ti, 4000), 0.9, 1e-12, "past everything: hold");

    // The rule is lane INDEX, not insertion order: swapping the indices swaps
    // the winner without touching a single clip.
    tl.setAutomationLaneIndex(topId, 5);
    auto plan2_ = std::make_unique<AutomationPlan>();
    AutomationPlan& plan2 = *plan2_;
    buildAll(tl, plan2);
    const int ti2 = findTarget(plan2, binding);
    CHECK_NEAR(evaluateTarget(plan2, ti2, 1500), 0.9, 1e-12,
               "raising the other lane's index flips which lane wins the overlap");
}

// ---------------------------------------------------------------------------
// 6. Determinism
// ---------------------------------------------------------------------------

static void testDeterminism() {
    std::cout << "\n[6] determinism\n";

    Timeline tl;
    const int trackId = addTestTrack(tl, "Lead");
    const AutomationBinding binding = makeBinding(trackId, "fx-1", "mix");
    tl.setAutomationBaseValue(binding, 0.33);

    AutomationLane laneA; laneA.ownerTrackId = trackId; laneA.index = 0;
    AutomationLane laneB; laneB.ownerTrackId = trackId; laneB.index = 1;
    const int laneAId = tl.addAutomationLane(laneA);
    const int laneBId = tl.addAutomationLane(laneB);

    AutomationEnvelope e1; e1.binding = binding;
    e1.points = { pt(0, 0.1), pt(700, 0.85), pt(1500, 0.2) };
    AutomationEnvelope e2; e2.binding = binding;
    e2.points = { pt(0, 0.6), pt(333, 0.05), pt(1111, 0.95) };
    const int e1Id = tl.addAutomationEnvelope(e1);
    const int e2Id = tl.addAutomationEnvelope(e2);

    AutomationClip c1; c1.laneId = laneAId; c1.envelopeId = e1Id;
    c1.position.ticks = 480; c1.duration.ticks = 2000;
    tl.addAutomationClip(c1);
    AutomationClip c2; c2.laneId = laneBId; c2.envelopeId = e2Id;
    c2.position.ticks = 1000; c2.duration.ticks = 3000;
    tl.addAutomationClip(c2);

    // Two plans built independently from the same project state.
    auto p1_ = std::make_unique<AutomationPlan>();
    AutomationPlan& p1 = *p1_;
    auto p2_ = std::make_unique<AutomationPlan>();
    AutomationPlan& p2 = *p2_;
    buildAll(tl, p1);
    buildAll(tl, p2);
    const int i1 = findTarget(p1, binding);
    const int i2 = findTarget(p2, binding);
    CHECK(i1 >= 0 && i1 == i2, "independently built plans agree on target ordering");

    bool allEqual = true;
    // Sweep in a deliberately irregular stride so we do not only sample the
    // block boundaries a 512-sample buffer would land on.
    for (int64_t t = -500; t < 6000; t += 7) {
        const double a = evaluateTarget(p1, i1, t);
        const double b = evaluateTarget(p2, i2, t);
        if (a != b) { allEqual = false; break; }
    }
    CHECK(allEqual, "value(t) is bit-identical across independently built plans");

    // Evaluating the same tick repeatedly, and out of order, is stateless.
    const double forward  = evaluateTarget(p1, i1, 2345);
    (void)evaluateTarget(p1, i1, 10);
    (void)evaluateTarget(p1, i1, 5900);
    const double backward = evaluateTarget(p1, i1, 2345);
    CHECK(forward == backward,
          "evaluation is stateless: seeking away and back gives the same value");

    // The sample->tick mapping both live playback and export use is pure.
    const int64_t tick1 = tickAtSamplePosition(44100, 120.0, 44100.0);
    const int64_t tick2 = tickAtSamplePosition(44100, 120.0, 44100.0);
    CHECK(tick1 == tick2 && tick1 == 1920,
          "tickAtSamplePosition is pure and correct (1s @120bpm = 2 beats = 1920 ticks)");
    CHECK(tickAtSamplePosition(1000, 0.0, 44100.0) == 0, "zero bpm fails closed to tick 0");
}

// ---------------------------------------------------------------------------
// 7. Make-unique
// ---------------------------------------------------------------------------

static void testMakeUnique() {
    std::cout << "\n[7] make-unique\n";

    Timeline tl;
    UndoManager undo;
    const int trackId = addTestTrack(tl, "Lead");

    AutomationLane lane; lane.ownerTrackId = trackId; lane.index = 0;
    const int laneId = tl.addAutomationLane(lane);

    AutomationEnvelope env;
    env.binding = makeBinding(trackId, "fx-1", "mix");
    env.points  = { pt(0, 0.0), pt(960, 1.0) };
    const int envId = tl.addAutomationEnvelope(env);

    AutomationClip a; a.laneId = laneId; a.envelopeId = envId;
    a.position.ticks = 0; a.duration.ticks = 960;
    const int aId = tl.addAutomationClip(a);

    AutomationClip b = a;              // a copy: shares the envelope
    b.position.ticks = 1920;
    const int bId = tl.addAutomationClip(b);

    CHECK(tl.getAutomationClip(aId)->envelopeId == tl.getAutomationClip(bId)->envelopeId,
          "a copied clip shares its source's envelope");

    // Editing the shared envelope moves BOTH clips.
    tl.addAutomationPoint(envId, pt(480, 0.25));
    CHECK(tl.getAutomationEnvelope(tl.getAutomationClip(bId)->envelopeId)->points.size() == 3,
          "an edit through the shared envelope is visible from the copy");

    auto cmd = std::make_unique<MakeAutomationClipUniqueCommand>(bId, tl);
    MakeAutomationClipUniqueCommand* raw = cmd.get();
    undo.execute(std::move(cmd), tl);

    const int newEnvId = raw->newEnvelopeId();
    CHECK(newEnvId > 0 && newEnvId != envId, "make-unique minted a new envelope");
    CHECK(tl.getAutomationClip(bId)->envelopeId == newEnvId, "the clip now plays the copy");
    CHECK(tl.getAutomationClip(aId)->envelopeId == envId, "its sibling is untouched");
    CHECK(tl.getAutomationEnvelope(newEnvId)->points.size() == 3,
          "the duplicate carries the source's points");

    // Now the two diverge.
    tl.addAutomationPoint(newEnvId, pt(700, 0.9));
    CHECK(tl.getAutomationEnvelope(envId)->points.size() == 3,
          "editing the unique copy no longer touches the original");

    undo.undo(tl);
    CHECK(tl.getAutomationClip(bId)->envelopeId == envId, "undo re-points the clip at the shared envelope");
    CHECK(tl.getAutomationEnvelope(newEnvId) == nullptr, "undo removes the duplicate envelope");

    undo.redo(tl);
    CHECK(tl.getAutomationClip(bId)->envelopeId == newEnvId, "redo restores the SAME envelope id");
    CHECK(tl.getAutomationEnvelope(newEnvId) != nullptr, "redo restores the duplicate envelope");
}

// ---------------------------------------------------------------------------
// 8. Deletion contract
// ---------------------------------------------------------------------------

static void testDeletionContract() {
    std::cout << "\n[8] deletion contract\n";

    Timeline tl;
    UndoManager undo;
    const int trackId = addTestTrack(tl, "Lead");

    AutomationLane laneA; laneA.ownerTrackId = trackId; laneA.index = 0;
    AutomationLane laneB; laneB.ownerTrackId = trackId; laneB.index = 1;
    const int laneAId = tl.addAutomationLane(laneA);
    const int laneBId = tl.addAutomationLane(laneB);

    // Two parameters on the doomed effect, one on a survivor.
    AutomationEnvelope e1; e1.binding = makeBinding(trackId, "fx-doomed", "mix");
    AutomationEnvelope e2; e2.binding = makeBinding(trackId, "fx-doomed", "gain");
    AutomationEnvelope e3; e3.binding = makeBinding(trackId, "fx-survivor", "mix");
    e1.points = e2.points = e3.points = { pt(0, 0.5) };
    const int e1Id = tl.addAutomationEnvelope(e1);
    const int e2Id = tl.addAutomationEnvelope(e2);
    const int e3Id = tl.addAutomationEnvelope(e3);

    AutomationClip c1; c1.laneId = laneAId; c1.envelopeId = e1Id;
    c1.position.ticks = 0;    c1.duration.ticks = 960;
    AutomationClip c2; c2.laneId = laneAId; c2.envelopeId = e2Id;
    c2.position.ticks = 1920; c2.duration.ticks = 960;
    AutomationClip c3; c3.laneId = laneBId; c3.envelopeId = e3Id;
    c3.position.ticks = 0;    c3.duration.ticks = 960;
    AutomationClip c4; c4.laneId = laneBId; c4.envelopeId = e1Id;
    c4.position.ticks = 1920; c4.duration.ticks = 960;
    const int c1Id = tl.addAutomationClip(c1);
    const int c2Id = tl.addAutomationClip(c2);
    const int c3Id = tl.addAutomationClip(c3);
    const int c4Id = tl.addAutomationClip(c4);
    (void)c1Id; (void)c2Id; (void)c3Id;

    // The query the confirmation dialog uses.
    const auto bound = tl.getAutomationClipsForEffectInstance(trackId, "fx-doomed");
    CHECK(bound.size() == 3,
          "effectInstanceId -> bound clips finds every clip on every parameter of the effect");
    const auto boundEnvs = tl.getAutomationEnvelopeIdsForEffectInstance(trackId, "fx-doomed");
    CHECK(boundEnvs.size() == 2, "and the two envelopes behind them");
    CHECK(tl.getAutomationClipsForEffectInstance(trackId, "fx-missing").empty(),
          "an unknown effect instance has no bound clips");
    CHECK(tl.getAutomationClipsForEffectInstance(-1, "fx-doomed").empty(),
          "the same instance id under a different owner does not match");

    // One command, one undo step.
    auto cmd = std::make_unique<RemoveAutomationForEffectInstanceCommand>(trackId, "fx-doomed", tl);
    RemoveAutomationForEffectInstanceCommand* raw = cmd.get();
    undo.execute(std::move(cmd), tl);
    CHECK(raw->removedClipCount() == 3, "the command reports what it removed");
    CHECK(tl.getAutomationClipsForEffectInstance(trackId, "fx-doomed").empty(),
          "every bound clip is gone");
    CHECK(tl.getAutomationClip(c3Id) != nullptr, "a clip bound to another effect survives");
    CHECK(tl.getAutomationLane(laneAId) == nullptr,
          "a lane left with nothing on it is removed with the clips");
    CHECK(tl.getAutomationLane(laneBId) != nullptr,
          "a lane that still holds another effect's clip survives");
    CHECK(undo.getUndoCount() == 1, "the whole cascade is ONE undo step");

    undo.undo(tl);
    CHECK(tl.getAutomationClipsForEffectInstance(trackId, "fx-doomed").size() == 3,
          "undo restores every bound clip");
    CHECK(tl.getAutomationLane(laneAId) != nullptr, "undo restores the emptied lane");
    CHECK(tl.getAutomationClip(c4Id) != nullptr, "undo restores the clip on the surviving lane too");

    // Reordering effects must not touch bindings: bindings name instance ids,
    // which are exactly what a reorder does NOT change. Simulated here by
    // asserting the binding survives an unrelated model mutation.
    tl.setAutomationLaneIndex(laneBId, 0);
    CHECK(tl.getAutomationClipsForEffectInstance(trackId, "fx-doomed").size() == 3,
          "reordering lanes leaves bindings intact");

    // Removing the owning TRACK cascades lanes + clips in one step, undoably.
    UndoManager undo2;
    auto rt = std::make_unique<RemoveTrackCommand>(trackId, tl);
    undo2.execute(std::move(rt), tl);
    CHECK(tl.getAllAutomationLanes().empty(), "removing the track removes its automation lanes");
    CHECK(tl.getAllAutomationClips().empty(), "and their clips");
    undo2.undo(tl);
    CHECK(tl.getAllAutomationLanes().size() == 2, "undo restores the lanes");
    CHECK(tl.getAllAutomationClips().size() == 4, "undo restores the clips");
}

// ---------------------------------------------------------------------------
// 9. Dead clips
// ---------------------------------------------------------------------------

static void testDeadClips() {
    std::cout << "\n[9] dead clips (unresolved binding)\n";

    Timeline tl;
    const int trackId = addTestTrack(tl, "Lead");
    AutomationLane lane; lane.ownerTrackId = trackId; lane.index = 0;
    const int laneId = tl.addAutomationLane(lane);

    AutomationEnvelope live;  live.binding  = makeBinding(trackId, "fx-live", "mix");
    AutomationEnvelope dead;  dead.binding  = makeBinding(trackId, "fx-gone", "mix");
    live.points = dead.points = { pt(0, 0.75) };
    const int liveId = tl.addAutomationEnvelope(live);
    const int deadId = tl.addAutomationEnvelope(dead);

    AutomationClip a; a.laneId = laneId; a.envelopeId = liveId;
    a.position.ticks = 0;    a.duration.ticks = 960;
    AutomationClip b; b.laneId = laneId; b.envelopeId = deadId;
    b.position.ticks = 1920; b.duration.ticks = 960;
    const int aId = tl.addAutomationClip(a);
    const int bId = tl.addAutomationClip(b);

    // A resolver that only knows about fx-live — exactly what a project loaded
    // after its effect was deleted looks like.
    auto plan_ = std::make_unique<AutomationPlan>();
    AutomationPlan& plan = *plan_;
    buildAutomationPlan(tl,
        [](const AutomationBinding& bnd) { return bnd.effectInstanceId == "fx-live"; },
        {}, plan);

    CHECK(plan.targetCount == 1, "the unresolved binding contributes no plan target");
    CHECK(plan.unresolvedClipCount == 1, "and is counted as a dead clip");
    CHECK(findTarget(plan, live.binding) >= 0, "the live binding is still planned");
    CHECK(findTarget(plan, dead.binding) < 0, "the dead binding is absent from the plan");

    // The model keeps both — a dead clip is PRESERVED, never discarded.
    CHECK(tl.getAutomationClip(aId) != nullptr && tl.getAutomationClip(bId) != nullptr,
          "both clips remain in the timeline");
    CHECK(tl.getAutomationEnvelope(deadId) != nullptr, "the dead envelope remains too");

    // ...and it survives a save/load round-trip.
    nlohmann::json j = tl.toJSON();
    Timeline reloaded;
    CHECK(reloaded.fromJSON(j), "timeline JSON round-trip");
    CHECK(reloaded.getAllAutomationClips().size() == 2, "the dead clip survives serialization");
    CHECK(reloaded.getAutomationEnvelope(deadId) != nullptr,
          "the dead envelope survives serialization with its binding intact");
    CHECK(reloaded.getAutomationEnvelope(deadId)->binding.effectInstanceId == "fx-gone",
          "the dead binding is preserved verbatim so the effect coming back revives the clip");
}

// ---------------------------------------------------------------------------
// 10. Serialization round-trip
// ---------------------------------------------------------------------------

static void testSerialization() {
    std::cout << "\n[10] serialization\n";

    Timeline tl;
    const int trackId = addTestTrack(tl, "Lead");
    const AutomationBinding binding = makeBinding(trackId, "fx-1", "mix");
    tl.setAutomationBaseValue(binding, 0.4);

    AutomationLane lane; lane.ownerTrackId = trackId; lane.index = 2;
    const int laneId = tl.addAutomationLane(lane);
    AutomationLane masterLane; masterLane.ownerTrackId = -1; masterLane.index = 0;
    const int masterLaneId = tl.addAutomationLane(masterLane);
    CHECK(masterLaneId > 0, "a Master-owned lane (ownerTrackId -1) is accepted");

    AutomationEnvelope env;
    env.binding = binding;
    env.points  = { pt(0, 0.0), pt(480, 0.5), pt(960, 1.0) };
    env.points[1].curveType = AutomationCurveType::Tension;
    env.points[1].tension   = 0.35;
    const int envId = tl.addAutomationEnvelope(env);

    AutomationClip c; c.laneId = laneId; c.envelopeId = envId;
    c.position.ticks = 1920; c.duration.ticks = 960; c.offset.ticks = 240;
    const int clipId = tl.addAutomationClip(c);

    const nlohmann::json j = tl.toJSON();
    CHECK(j.contains("automationLanes") && j["automationLanes"].size() == 2, "lanes serialized");
    CHECK(j.contains("automationClips") && j["automationClips"].size() == 1, "clips serialized");
    CHECK(j.contains("automationEnvelopes") && j["automationEnvelopes"].size() == 1,
          "envelopes serialized");
    CHECK(j.contains("automationBaseValues") && j["automationBaseValues"].size() == 1,
          "base values serialized");

    // Compact shape: default curve fields are omitted, non-default ones are not.
    const auto& pointsJson = j["automationEnvelopes"][0]["points"];
    CHECK(pointsJson.size() == 3, "three points written");
    CHECK(!pointsJson[0].contains("c") && !pointsJson[0].contains("n"),
          "a default (linear, tension 0) point omits its curve fields");
    CHECK(pointsJson[1].contains("c") && pointsJson[1].contains("n"),
          "a non-default point writes both curve fields");
    CHECK(!j["automationClips"][0].contains("loopEnabled"), "no stray keys on a clip");

    Timeline reloaded;
    CHECK(reloaded.fromJSON(j), "fromJSON accepted the payload");

    const AutomationClip* rc = reloaded.getAutomationClip(clipId);
    CHECK(rc != nullptr, "clip restored by id");
    CHECK(rc->position.ticks == 1920 && rc->duration.ticks == 960 && rc->offset.ticks == 240,
          "placement round-trips exactly");

    const AutomationEnvelope* re = reloaded.getAutomationEnvelope(envId);
    CHECK(re != nullptr, "envelope restored by id");
    CHECK(re->binding == binding, "binding round-trips exactly");
    CHECK(re->points.size() == 3, "points round-trip");
    CHECK(re->points[1].curveType == AutomationCurveType::Tension,
          "curveType round-trips (schema carries it in v1)");
    CHECK_NEAR(re->points[1].tension, 0.35, 1e-12, "tension round-trips");

    bool found = false;
    CHECK_NEAR(reloaded.getAutomationBaseValue(binding, &found), 0.4, 1e-12,
               "base value round-trips");
    CHECK(found, "base value is present after reload");

    const AutomationLane* rl = reloaded.getAutomationLane(laneId);
    CHECK(rl != nullptr && rl->index == 2 && rl->ownerTrackId == trackId, "lane round-trips");
    CHECK(reloaded.getAutomationLane(masterLaneId)->ownerTrackId == -1,
          "the Master lane's owner round-trips as -1");

    // Evaluation agrees before and after the round-trip.
    auto before_ = std::make_unique<AutomationPlan>();
    AutomationPlan& before = *before_;
    auto after_ = std::make_unique<AutomationPlan>();
    AutomationPlan& after = *after_;
    buildAll(tl, before);
    buildAll(reloaded, after);
    const int bi = findTarget(before, binding);
    const int ai = findTarget(after, binding);
    bool same = bi >= 0 && ai >= 0;
    for (int64_t t = 0; same && t < 4000; t += 13)
        if (evaluateTarget(before, bi, t) != evaluateTarget(after, ai, t)) same = false;
    CHECK(same, "a reloaded project evaluates bit-identically to the one it was saved from");

    // A hand-edited file with unsorted / duplicate points is healed on load.
    nlohmann::json messy = j;
    messy["automationEnvelopes"][0]["points"] = nlohmann::json::array({
        nlohmann::json{{"t", 960}, {"v", 1.0}},
        nlohmann::json{{"t", 0},   {"v", 0.0}},
        nlohmann::json{{"t", 960}, {"v", 0.3}},
    });
    Timeline healed;
    CHECK(healed.fromJSON(messy), "a messy payload still loads");
    const auto* he = healed.getAutomationEnvelope(envId);
    CHECK(he != nullptr && he->points.size() == 2, "load collapses duplicate ticks");
    CHECK(he->points[0].tick.ticks == 0 && he->points[1].tick.ticks == 960,
          "load restores the sorted invariant");

    // A clip whose lane vanished is dropped rather than left dangling.
    nlohmann::json orphan = j;
    orphan["automationLanes"] = nlohmann::json::array();
    Timeline dropped;
    CHECK(dropped.fromJSON(orphan), "an orphaned-clip payload still loads");
    CHECK(dropped.getAllAutomationClips().empty(), "a clip with no lane is dropped on load");

    // Full project.json round-trip: the persistence whitelist has to name the
    // automation keys or they vanish silently between save and load.
    const fs::path dir = fs::temp_directory_path() / "_xleth_automation_project_test";
    std::error_code ec;
    fs::remove_all(dir, ec);
    ProjectManager pm;
    const bool saved = pm.saveProjectAs(dir.string(), "AutomationTest", tl,
                                        nlohmann::json::object(), nlohmann::json(), 1.0f);
    CHECK(saved, "project saved");

    ProjectManager pm2;
    auto loaded = pm2.loadProject(dir.string());
    CHECK(loaded.has_value(), "project loaded");
    if (loaded) {
        CHECK(loaded->getAllAutomationLanes().size() == 2, "lanes survive project.json");
        CHECK(loaded->getAllAutomationClips().size() == 1, "clips survive project.json");
        CHECK(loaded->getAllAutomationEnvelopes().size() == 1, "envelopes survive project.json");
        bool f2 = false;
        CHECK_NEAR(loaded->getAutomationBaseValue(binding, &f2), 0.4, 1e-12,
                   "base values survive project.json");

        // The id counter must clear every automation id, or the next add collides.
        AutomationLane extra; extra.ownerTrackId = -1; extra.index = 9;
        const int extraId = loaded->addAutomationLane(extra);
        CHECK(extraId > clipId && extraId > envId && extraId > laneId,
              "the reloaded id counter clears every automation id");
    }
    fs::remove_all(dir, ec);
}

// ---------------------------------------------------------------------------
// 11. Point-edit commands
// ---------------------------------------------------------------------------

static void testPointCommands() {
    std::cout << "\n[11] point-edit commands\n";

    Timeline tl;
    UndoManager undo;
    const int trackId = addTestTrack(tl, "Lead");

    AutomationEnvelope env;
    env.binding = makeBinding(trackId, "fx-1", "mix");
    env.points  = { pt(0, 0.0), pt(960, 1.0) };
    const int envId = tl.addAutomationEnvelope(env);

    undo.execute(AutomationPointEditCommand::add(envId, pt(480, 0.5), tl), tl);
    CHECK(tl.getAutomationEnvelope(envId)->points.size() == 3, "add point");
    undo.undo(tl);
    CHECK(tl.getAutomationEnvelope(envId)->points.size() == 2, "undo add point");
    undo.redo(tl);
    CHECK(tl.getAutomationEnvelope(envId)->points.size() == 3, "redo add point");

    undo.execute(AutomationPointEditCommand::move(envId, 1, TickTime{700}, 0.8, tl), tl);
    CHECK(tl.getAutomationEnvelope(envId)->points[1].tick.ticks == 700, "move point");
    undo.undo(tl);
    CHECK(tl.getAutomationEnvelope(envId)->points[1].tick.ticks == 480, "undo move point");

    undo.execute(AutomationPointEditCommand::setCurve(
                     envId, 0, AutomationCurveType::Tension, 0.6, tl), tl);
    CHECK(tl.getAutomationEnvelope(envId)->points[0].curveType == AutomationCurveType::Tension,
          "set curve");
    undo.undo(tl);
    CHECK(tl.getAutomationEnvelope(envId)->points[0].curveType == AutomationCurveType::Linear,
          "undo set curve");

    undo.execute(AutomationPointEditCommand::remove(envId, 1, tl), tl);
    CHECK(tl.getAutomationEnvelope(envId)->points.size() == 2, "remove point");
    undo.undo(tl);
    CHECK(tl.getAutomationEnvelope(envId)->points.size() == 3, "undo remove point");

    // The drag-then-mouseup path: one command for a whole reshaped list.
    std::vector<AutomationPoint> reshaped = { pt(0, 1.0), pt(240, 0.2), pt(960, 0.4) };
    undo.execute(AutomationPointEditCommand::replaceAll(envId, reshaped, tl), tl);
    CHECK(tl.getAutomationEnvelope(envId)->points.size() == 3, "replaceAll applied");
    CHECK_NEAR(tl.getAutomationEnvelope(envId)->points[0].value, 1.0, 1e-12,
               "replaceAll wrote the new list");
    undo.undo(tl);
    CHECK(tl.getAutomationEnvelope(envId)->points.size() == 3, "undo replaceAll restores the count");
    CHECK_NEAR(tl.getAutomationEnvelope(envId)->points[0].value, 0.0, 1e-12,
               "undo replaceAll restores the old values");

    // An edit against an unknown envelope records nothing.
    UndoManager undo2;
    undo2.execute(AutomationPointEditCommand::add(999999, pt(0, 0.5), tl), tl);
    CHECK(!undo2.canUndo(), "an edit on an unknown envelope records no undo step");
}

// ---------------------------------------------------------------------------
// 12. Placement commands (move / resize / lane)
// ---------------------------------------------------------------------------

static void testPlacementCommands() {
    std::cout << "\n[12] placement commands\n";

    Timeline tl;
    UndoManager undo;
    const int trackId = addTestTrack(tl, "Lead");

    auto laneCmd = std::make_unique<AddAutomationLaneCommand>(trackId, -1);
    AddAutomationLaneCommand* laneRaw = laneCmd.get();
    undo.execute(std::move(laneCmd), tl);
    const int laneId = laneRaw->laneId();
    CHECK(laneId > 0, "AddAutomationLaneCommand created a lane");
    CHECK(tl.getAutomationLane(laneId)->index == 0, "index < 0 appended at 0 on an empty group");

    auto envCmd = std::make_unique<AddAutomationEnvelopeCommand>(
        makeBinding(trackId, "fx-1", "mix"), std::vector<AutomationPoint>{ pt(0, 0.5) });
    AddAutomationEnvelopeCommand* envRaw = envCmd.get();
    undo.execute(std::move(envCmd), tl);
    const int envId = envRaw->envelopeId();
    CHECK(envId > 0, "AddAutomationEnvelopeCommand created an envelope");

    AutomationClip c; c.laneId = laneId; c.envelopeId = envId;
    c.position.ticks = 960; c.duration.ticks = 960;
    auto addCmd = std::make_unique<AddAutomationClipCommand>(c);
    AddAutomationClipCommand* addRaw = addCmd.get();
    undo.execute(std::move(addCmd), tl);
    const int clipId = addRaw->clipId();
    CHECK(clipId > 0, "AddAutomationClipCommand created a clip");

    undo.execute(std::make_unique<MoveAutomationClipCommand>(clipId, laneId, TickTime{2880}, tl), tl);
    CHECK(tl.getAutomationClip(clipId)->position.ticks == 2880, "move applied");
    undo.undo(tl);
    CHECK(tl.getAutomationClip(clipId)->position.ticks == 960, "undo move");

    undo.execute(std::make_unique<ResizeAutomationClipCommand>(clipId, TickTime{1920}, tl), tl);
    CHECK(tl.getAutomationClip(clipId)->duration.ticks == 1920, "resize applied");
    undo.undo(tl);
    CHECK(tl.getAutomationClip(clipId)->duration.ticks == 960, "undo resize");

    undo.execute(std::make_unique<ResizeAutomationClipLeftCommand>(
                     clipId, TickTime{1440}, TickTime{480}, TickTime{480}, tl), tl);
    const AutomationClip* trimmed = tl.getAutomationClip(clipId);
    CHECK(trimmed->position.ticks == 1440 && trimmed->duration.ticks == 480
              && trimmed->offset.ticks == 480,
          "left trim moves position, duration and offset together");
    CHECK(trimmed->originTick().ticks == 960,
          "the envelope origin stays anchored where the clip originally started");
    undo.undo(tl);
    CHECK(tl.getAutomationClip(clipId)->offset.ticks == 0, "undo left trim");

    // Removing a lane cascades to its clips and undoes as one step.
    undo.execute(std::make_unique<RemoveAutomationLaneCommand>(laneId, tl), tl);
    CHECK(tl.getAutomationLane(laneId) == nullptr, "lane removed");
    CHECK(tl.getAutomationClip(clipId) == nullptr, "its clip went with it");
    CHECK(tl.getAutomationEnvelope(envId) != nullptr,
          "the envelope survives (a copy elsewhere may still share it)");
    undo.undo(tl);
    CHECK(tl.getAutomationLane(laneId) != nullptr && tl.getAutomationClip(clipId) != nullptr,
          "undo restores the lane and its clip together");

    // Base value command.
    const AutomationBinding binding = makeBinding(trackId, "fx-1", "mix");
    undo.execute(std::make_unique<SetAutomationBaseValueCommand>(binding, 0.8, tl), tl);
    bool found = false;
    CHECK_NEAR(tl.getAutomationBaseValue(binding, &found), 0.8, 1e-12, "base value set");
    undo.undo(tl);
    tl.getAutomationBaseValue(binding, &found);
    CHECK(!found, "undo clears a base value that did not exist before");
}

// ---------------------------------------------------------------------------
// 13. Plan capacity fail-closed
// ---------------------------------------------------------------------------

static void testPlanFailsClosed() {
    std::cout << "\n[13] plan fail-closed\n";

    Timeline tl;
    const int trackId = addTestTrack(tl, "Lead");
    AutomationLane lane; lane.ownerTrackId = trackId; lane.index = 0;
    const int laneId = tl.addAutomationLane(lane);

    // One target per parameter; overshoot the target capacity deliberately.
    const int over = kMaxAutomationTargets + 8;
    for (int i = 0; i < over; ++i) {
        AutomationEnvelope e;
        e.binding = makeBinding(trackId, "fx-1", ("p" + std::to_string(i)).c_str());
        e.points  = { pt(0, 0.5) };
        const int eid = tl.addAutomationEnvelope(e);
        AutomationClip c; c.laneId = laneId; c.envelopeId = eid;
        c.position.ticks = static_cast<int64_t>(i) * 960;
        c.duration.ticks = 480;
        tl.addAutomationClip(c);
    }

    auto plan_ = std::make_unique<AutomationPlan>();
    AutomationPlan& plan = *plan_;
    buildAll(tl, plan);
    CHECK(plan.targetCount == kMaxAutomationTargets, "target count is capped at the capacity");
    CHECK(plan.overflowed, "overflow is reported, not hidden");
    CHECK(plan.droppedTargetCount == 8, "the dropped count is exact");

    // Every target that DID fit is still fully valid — fail-closed means the
    // tail is dropped, never that a kept target is half-built.
    bool allValid = true;
    for (int i = 0; i < plan.targetCount; ++i) {
        const auto& t = plan.targets[i];
        if (t.windowOffset < 0 || t.windowOffset + t.windowCount > plan.windowCount)
            allValid = false;
        for (int w = 0; w < t.windowCount; ++w) {
            const auto& win = plan.windows[t.windowOffset + w];
            if (win.pointOffset < 0 || win.pointOffset + win.pointCount > plan.pointCount)
                allValid = false;
            if (win.endTick <= win.startTick) allValid = false;
        }
    }
    CHECK(allValid, "every target that fit is internally consistent");

    // An out-of-range target index is answered, not crashed on.
    CHECK_NEAR(evaluateTarget(plan, -1, 0), 0.0, 1e-12, "negative target index returns 0");
    CHECK_NEAR(evaluateTarget(plan, 99999, 0), 0.0, 1e-12, "past-the-end target index returns 0");

    // An empty project produces an empty, harmless plan.
    Timeline blank;
    auto blankPlan_ = std::make_unique<AutomationPlan>();
    AutomationPlan& blankPlan = *blankPlan_;
    buildAll(blank, blankPlan);
    CHECK(blankPlan.empty() && !blankPlan.overflowed, "an automation-free project plans to nothing");
}

// ---------------------------------------------------------------------------

int main() {
    std::cout << "=== test_automation_clips ===\n";

    testPointInvariant();
    testEnvelopeEvaluation();
    testSameLaneOverlapRejected();
    testPlanSemantics();
    testTopmostLaneWins();
    testDeterminism();
    testMakeUnique();
    testDeletionContract();
    testDeadClips();
    testSerialization();
    testPointCommands();
    testPlacementCommands();
    testPlanFailsClosed();

    std::cout << "\n";
    if (g_failures == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cout << g_failures << " TEST(S) FAILED\n";
    return 1;
}
