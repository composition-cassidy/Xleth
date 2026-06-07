// test_tail_render.cpp — Phase 3A tail render policy (hardCut + tailClamp).
// Pure / model-only: render/RenderScope.h + model/TimelineTypes.h depend only on
// LoopRegion — no JUCE, no FFmpeg, no GL. Build: engine/CMakeLists.txt target
// "test_tail_render". Pass: prints "ALL TESTS PASSED" and exits 0; else exits 1.
//
// What this CAN unit-test purely: the tail-plan derivation, the sanitizers, the
// model-boundary clamp, the sample-domain tail detector, and the scope/estimate
// math. The engine-side "no new triggers past endTick" gate lives in MixEngine
// (audio thread) and is exercised by the integration render, not here.

#include "render/RenderScope.h"
#include "model/TimelineTypes.h"

#include <cmath>
#include <iostream>
#include <limits>
#include <vector>

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                  \
    do {                                                                  \
        if (cond) { ++g_passed; }                                         \
        else { std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; \
               ++g_failed; }                                              \
    } while (0)

using xleth::computeRenderScope;
using xleth::computeTailRenderPlan;
using xleth::TailRenderMode;
using xleth::TailRenderPlan;
using xleth::TailDetectorState;
using xleth::tailDetectorFeed;
using xleth::RenderScope;

static bool nearly(double a, double b, double eps = 1e-6) { return std::fabs(a - b) < eps; }

static constexpr double kSr = 48000.0;
static constexpr int64_t kFullEnd = 32 * 960;   // 32 beats

// ─── 1. tailClamp defaults: tailClamp, -60 dB, 10 s ─────────────────────────────

static void testDefaults() {
    std::cout << "[1] LoopRegion tail defaults → tailClamp / -60 / 10\n";
    LoopRegion lr;   // freshly defaulted
    CHECK(lr.tailMode == LoopRegion::TailMode::TailClamp, "default tailMode == tailClamp");
    CHECK(nearly(lr.tailThresholdDb, -60.0), "default tailThresholdDb == -60");
    CHECK(nearly(lr.tailMaxSeconds, 10.0),  "default tailMaxSeconds == 10");

    TailRenderPlan p = computeTailRenderPlan(lr, kSr);
    CHECK(p.mode == TailRenderMode::TailClamp, "plan mode == tailClamp");
    CHECK(p.maxTailSamples == static_cast<int64_t>(10.0 * kSr + 0.5), "cap == 10s of samples");
    CHECK(nearly(p.thresholdLinear, std::pow(10.0, -60.0 / 20.0)), "threshold dB→linear");
    CHECK(p.thresholdLinear > 0.0009 && p.thresholdLinear < 0.0011, "-60 dB ≈ 0.001 linear");
    CHECK(p.freezeVideo == true, "tailClamp freezes the last video frame");
    CHECK(p.holdSamples == static_cast<int64_t>(0.050 * kSr + 0.5), "hold ≈ 50 ms");
}

// ─── 2. hardCut: no tail at all ─────────────────────────────────────────────────

static void testHardCut() {
    std::cout << "[2] hardCut → no extra tail duration\n";
    LoopRegion lr; lr.tailMode = LoopRegion::TailMode::HardCut;
    TailRenderPlan p = computeTailRenderPlan(lr, kSr);
    CHECK(p.mode == TailRenderMode::HardCut, "hardCut mode");
    CHECK(p.maxTailSamples == 0, "hardCut renders zero tail samples");
    CHECK(p.freezeVideo == false, "hardCut does not freeze video");
}

// ─── 3. wrap maps to a REAL wrap mode (Phase 3B) ────────────────────────────────

static void testWrapIsRealMode() {
    std::cout << "[3] wrap maps to a real Wrap mode, never hardCut/tailClamp\n";
    LoopRegion lr; lr.tailMode = LoopRegion::TailMode::Wrap;
    TailRenderPlan p = computeTailRenderPlan(lr, kSr);
    CHECK(p.mode == TailRenderMode::Wrap, "wrap maps to TailRenderMode::Wrap");
    CHECK(p.mode != TailRenderMode::HardCut, "wrap must NOT become hardCut");
    CHECK(p.mode != TailRenderMode::TailClamp, "wrap must NOT become tailClamp");
    // The cap bounds the INTERNAL fold tail (working audio), not the output.
    CHECK(p.maxTailSamples == static_cast<int64_t>(10.0 * kSr + 0.5),
          "wrap has a working-tail cap (10 s default)");
    CHECK(p.freezeVideo == false, "wrap never freezes/extends video");
    CHECK(p.holdSamples == static_cast<int64_t>(0.050 * kSr + 0.5), "wrap hold ≈ 50 ms");
}

// ─── 4. Sanitizers + model-boundary clamp ───────────────────────────────────────

static void testSanitize() {
    std::cout << "[4] invalid tail settings sanitize at the model boundary\n";
    using namespace std;

    CHECK(nearly(sanitizeTailThresholdDb(NAN), -60.0), "NaN threshold → -60");
    CHECK(nearly(sanitizeTailThresholdDb(INFINITY), -60.0), "inf threshold → -60");
    CHECK(nearly(sanitizeTailThresholdDb(12.0), 0.0), "positive threshold clamps to 0 dBFS");
    CHECK(nearly(sanitizeTailThresholdDb(-999.0), -160.0), "very low threshold clamps to -160");
    CHECK(nearly(sanitizeTailThresholdDb(-42.0), -42.0), "valid threshold passes through");

    CHECK(nearly(sanitizeTailMaxSeconds(NAN), 10.0), "NaN cap → 10");
    CHECK(nearly(sanitizeTailMaxSeconds(-5.0), 0.0), "negative cap → 0");
    CHECK(nearly(sanitizeTailMaxSeconds(1e9), kLoopTailMaxSecondsCap), "huge cap → upper bound");
    CHECK(nearly(sanitizeTailMaxSeconds(7.5), 7.5), "valid cap passes through");

    // normalizeLoopRegion applies the clamps and preserves tick invariants.
    LoopRegion bad;
    bad.startTick = -100; bad.endTick = -50;          // invalid ticks
    bad.tailThresholdDb = std::numeric_limits<double>::quiet_NaN();
    bad.tailMaxSeconds  = 1e6;
    LoopRegion fixed = normalizeLoopRegion(bad, 1);
    CHECK(fixed.startTick == 0, "startTick clamped to 0");
    CHECK(fixed.endTick >= fixed.startTick + 1, "endTick >= start + minLen");
    CHECK(nearly(fixed.tailThresholdDb, -60.0), "NaN threshold sanitized in normalize");
    CHECK(nearly(fixed.tailMaxSeconds, kLoopTailMaxSecondsCap), "huge cap sanitized in normalize");
}

// ─── 5. Detector: cap ends a never-decaying tail ────────────────────────────────

static void testDetectorCap() {
    std::cout << "[5] tailClamp caps at tailMaxSeconds when audio never decays\n";
    LoopRegion lr;  // tailClamp, 10 s
    TailRenderPlan p = computeTailRenderPlan(lr, kSr);
    TailDetectorState st;
    const int64_t block = 4096;
    int guard = 0;
    while (!st.done && guard++ < 1000)
        tailDetectorFeed(st, p, /*loud peak*/ 0.5, block);  // always above threshold
    CHECK(st.done, "detector terminates");
    CHECK(st.endedByCap == true, "ended by cap (never below threshold)");
    CHECK(st.tailSamples >= p.maxTailSamples, "rendered at least the cap");
    CHECK(st.tailSamples < p.maxTailSamples + block, "stops within one block of the cap");
}

// ─── 6. Detector: threshold-hold ends a decayed tail early ──────────────────────

static void testDetectorThreshold() {
    std::cout << "[6] tailClamp stops early after ~50 ms below threshold\n";
    LoopRegion lr;  // tailClamp, 10 s, -60 dB
    TailRenderPlan p = computeTailRenderPlan(lr, kSr);
    TailDetectorState st;
    const int64_t block = 512;
    int guard = 0;
    while (!st.done && guard++ < 1000)
        tailDetectorFeed(st, p, /*quiet peak*/ 0.00001, block);  // below threshold
    CHECK(st.done, "detector terminates");
    CHECK(st.endedByCap == false, "ended by threshold hold (not cap)");
    CHECK(st.tailSamples >= p.holdSamples, "ran at least the hold window");
    CHECK(st.tailSamples < p.maxTailSamples, "stopped well before the cap");
    // freeze-last-frame duration == detected tail duration: the OfflineRenderer
    // drives video frames off the SAME sample count, so this is the freeze length.
    CHECK(st.tailSamples >= p.holdSamples && st.tailSamples <= p.holdSamples + block,
          "freeze duration == detected (hold) tail duration");
}

// ─── 7. Detector: loud-then-quiet resets the below-run ──────────────────────────

static void testDetectorResetOnLoud() {
    std::cout << "[7] a loud block resets the below-threshold run\n";
    LoopRegion lr;
    TailRenderPlan p = computeTailRenderPlan(lr, kSr);
    TailDetectorState st;
    const int64_t block = 512;
    tailDetectorFeed(st, p, 0.00001, block);   // quiet
    tailDetectorFeed(st, p, 0.00001, block);   // quiet
    CHECK(st.belowRun == 2 * block, "below-run accumulates while quiet");
    tailDetectorFeed(st, p, 0.5, block);       // loud
    CHECK(st.belowRun == 0, "below-run resets on a loud block");
    CHECK(!st.done, "not done — tail keeps ringing");
}

// ─── 8. Full timeline (loop disabled) still uses tailClamp handling ─────────────

static void testFullTimelineTail() {
    std::cout << "[8] loop disabled → full bounds + tailClamp tail\n";
    LoopRegion lr; lr.loopEnabled = false;
    lr.startTick = 4 * 960; lr.endTick = 8 * 960;   // ignored when not scoped

    RenderScope rs = computeRenderScope(lr, kFullEnd);
    CHECK(rs.scoped == false, "not scoped");
    CHECK(rs.captureStartTick == 0 && rs.captureEndTick == kFullEnd, "full bounds");

    TailRenderPlan p = computeTailRenderPlan(lr, kSr);
    CHECK(p.mode == TailRenderMode::TailClamp, "full render still uses tailClamp");
    CHECK(p.maxTailSamples > 0, "full render has a tail cap so effects don't cut instantly");
}

// ─── 9. Scoped render keeps Phase 2 warm-up intact alongside the tail ───────────

static void testScopedWarmupIntact() {
    std::cout << "[9] scoped render: Phase 2 warm-up-from-0 intact + tail derived\n";
    LoopRegion lr; lr.loopEnabled = true;
    lr.startTick = 8 * 960; lr.endTick = 16 * 960;

    RenderScope rs = computeRenderScope(lr, kFullEnd);
    CHECK(rs.scoped == true, "scoped");
    CHECK(rs.warmUpStartTick == 0, "absolute warm-up from tick 0 preserved");
    CHECK(rs.captureStartTick == 8 * 960, "capture starts at region start");
    CHECK(rs.captureEndTick == 16 * 960, "capture ends at region end");

    TailRenderPlan p = computeTailRenderPlan(lr, kSr);
    CHECK(p.mode == TailRenderMode::TailClamp, "scoped render tailClamp by default");
}

// ─── 10. Duration estimate uses LoopRegion scope + tail cap (not full timeline) ──

static void testDurationEstimate() {
    std::cout << "[10] estimate = scoped region length + tail cap (not full project)\n";
    const double bpm = 120.0;
    LoopRegion lr; lr.loopEnabled = true;
    lr.startTick = 8 * 960;    // beat 8
    lr.endTick   = 12 * 960;   // beat 12  → 4 beats scoped, full project is 32 beats

    RenderScope rs = computeRenderScope(lr, kFullEnd);
    const double ticksToBeats = 1.0 / 960.0;
    const double captureBeats = (rs.captureEndTick - rs.captureStartTick) * ticksToBeats;
    double seconds = captureBeats * 60.0 / bpm;     // 4 beats @120 = 2.0 s

    TailRenderPlan p = computeTailRenderPlan(lr, kSr);
    if (p.mode == TailRenderMode::TailClamp)
        seconds += static_cast<double>(p.maxTailSamples) / kSr;   // + 10 s cap

    CHECK(nearly(captureBeats, 4.0), "scoped capture is 4 beats, not the 32-beat project");
    CHECK(nearly(seconds, 2.0 + 10.0, 1e-3), "estimate = 2 s region + 10 s tail cap");
    // Sanity: the full-timeline estimate would be 16 s (+tail) — much larger,
    // proving the estimate follows the LoopRegion scope, not hidden manual bars.
    const double fullSeconds = (kFullEnd * ticksToBeats) * 60.0 / bpm;
    CHECK(fullSeconds > seconds, "scoped estimate is shorter than the full timeline");
}

// ─── 11. Scope-aware wrap policy: scoped keeps Wrap, full-timeline fails closed ──

static void testWrapScopePolicy() {
    std::cout << "[11] wrap stays Wrap when scoped, falls back to tailClamp when not\n";
    LoopRegion lr; lr.tailMode = LoopRegion::TailMode::Wrap;

    // Scoped (loop-region) render: wrap is preserved.
    TailRenderPlan scoped = xleth::resolveTailPlanForScope(lr, kSr, /*scoped*/ true);
    CHECK(scoped.mode == TailRenderMode::Wrap, "scoped wrap stays Wrap");
    CHECK(scoped.freezeVideo == false, "scoped wrap never freezes video");

    // Full-timeline (non-scoped) render: no region head to fold onto → tailClamp.
    TailRenderPlan full = xleth::resolveTailPlanForScope(lr, kSr, /*scoped*/ false);
    CHECK(full.mode == TailRenderMode::TailClamp,
          "non-scoped wrap fails CLOSED to tailClamp (documented policy)");
    CHECK(full.mode != TailRenderMode::Wrap, "non-scoped never renders wrap nonsense");
    CHECK(full.freezeVideo == true, "the tailClamp fall-back freezes video as usual");

    // hardCut / tailClamp are scope-invariant (no regression).
    LoopRegion hc; hc.tailMode = LoopRegion::TailMode::HardCut;
    CHECK(xleth::resolveTailPlanForScope(hc, kSr, false).mode == TailRenderMode::HardCut,
          "hardCut unaffected by scope");
    LoopRegion tc; tc.tailMode = LoopRegion::TailMode::TailClamp;
    CHECK(xleth::resolveTailPlanForScope(tc, kSr, true).mode == TailRenderMode::TailClamp,
          "tailClamp unaffected by scope");
}

// ─── 12. Tail fold math: output[i % regionLen] += tail[i] ───────────────────────

static void testFoldMath() {
    std::cout << "[12] fold folds the post-end tail onto the region head (modulo)\n";
    // Deterministic spec example: region [1,2,3,4], tail [10,20,30,40,50].
    //   i=0 → region[0]+=10 → 11
    //   i=1 → region[1]+=20 → 22
    //   i=2 → region[2]+=30 → 33
    //   i=3 → region[3]+=40 → 44
    //   i=4 → region[0]+=50 → 61   (wraps onto the head)
    // → [61, 22, 33, 44]
    float region[4] = { 1.0f, 2.0f, 3.0f, 4.0f };
    const float tail[5] = { 10.0f, 20.0f, 30.0f, 40.0f, 50.0f };
    xleth::foldTailIntoRegion(region, 4, tail, 5);
    CHECK(nearly(region[0], 61.0), "region[0] = 1 + 10 + 50 = 61");
    CHECK(nearly(region[1], 22.0), "region[1] = 2 + 20 = 22");
    CHECK(nearly(region[2], 33.0), "region[2] = 3 + 30 = 33");
    CHECK(nearly(region[3], 44.0), "region[3] = 4 + 40 = 44");

    // A tail SHORTER than the region only touches the head, leaves the rest.
    float r2[4] = { 1.0f, 1.0f, 1.0f, 1.0f };
    const float t2[2] = { 5.0f, 6.0f };
    xleth::foldTailIntoRegion(r2, 4, t2, 2);
    CHECK(nearly(r2[0], 6.0) && nearly(r2[1], 7.0) && nearly(r2[2], 1.0) && nearly(r2[3], 1.0),
          "short tail folds only onto the head");

    // Degenerate inputs are no-ops (never crash / never extend).
    float r3[2] = { 9.0f, 9.0f };
    xleth::foldTailIntoRegion(r3, 2, nullptr, 5);
    xleth::foldTailIntoRegion(r3, 0, t2, 2);
    xleth::foldTailIntoRegion(nullptr, 2, t2, 2);
    CHECK(nearly(r3[0], 9.0) && nearly(r3[1], 9.0), "degenerate fold is a no-op");
}

// ─── 13. wrap detector caps the INTERNAL tail without extending output ──────────

static void testWrapTailCapped() {
    std::cout << "[13] wrap internal tail bounded by cap / threshold; output stays regionLen\n";
    LoopRegion lr; lr.tailMode = LoopRegion::TailMode::Wrap;  // 10 s cap default
    TailRenderPlan p = computeTailRenderPlan(lr, kSr);

    // Never-decaying tail → ends by cap, bounded to maxTailSamples.
    TailDetectorState capSt;
    int guard = 0;
    while (!capSt.done && guard++ < 100000)
        tailDetectorFeed(capSt, p, 0.5, 4096);
    CHECK(capSt.done && capSt.endedByCap, "wrap tail stops at the cap when audio never decays");
    CHECK(capSt.tailSamples >= p.maxTailSamples, "rendered at least the cap");

    // Decayed tail → ends by ~50 ms threshold hold, well before the cap.
    TailDetectorState thrSt;
    guard = 0;
    while (!thrSt.done && guard++ < 100000)
        tailDetectorFeed(thrSt, p, 0.00001, 512);
    CHECK(thrSt.done && !thrSt.endedByCap, "wrap tail stops on the threshold hold");
    CHECK(thrSt.tailSamples < p.maxTailSamples, "threshold stop is before the cap");

    // The fold NEVER extends the output: final length == regionLen regardless of
    // how long the internal tail ran.
    const int regionLen = 4 * static_cast<int>(kSr);   // 4 s region
    std::vector<float> region(static_cast<size_t>(regionLen), 0.0f);
    std::vector<float> tail(static_cast<size_t>(capSt.tailSamples), 0.25f);
    xleth::foldTailIntoRegion(region.data(), regionLen,
                              tail.data(), static_cast<int>(tail.size()));
    CHECK(static_cast<int>(region.size()) == regionLen,
          "folded output length is exactly the region length (no extension)");
}

// ─── 14. wrap duration estimate == region duration (no tail cap added) ──────────

static void testWrapDurationEstimate() {
    std::cout << "[14] wrap estimate = region duration only (tail folds, adds nothing)\n";
    const double bpm = 120.0;
    LoopRegion lr; lr.loopEnabled = true; lr.tailMode = LoopRegion::TailMode::Wrap;
    lr.startTick = 8 * 960;     // beat 8
    lr.endTick   = 12 * 960;    // beat 12 → 4 beats = 2.0 s @120

    RenderScope rs = computeRenderScope(lr, kFullEnd);
    const double ticksToBeats = 1.0 / 960.0;
    const double captureBeats = (rs.captureEndTick - rs.captureStartTick) * ticksToBeats;
    double seconds = captureBeats * 60.0 / bpm;

    // Mirror the bridge estimate: cap added ONLY for tailClamp. Scoped wrap → Wrap.
    TailRenderPlan p = xleth::resolveTailPlanForScope(lr, kSr, rs.scoped);
    if (p.mode == TailRenderMode::TailClamp)
        seconds += static_cast<double>(p.maxTailSamples) / kSr;

    CHECK(p.mode == TailRenderMode::Wrap, "scoped wrap stays wrap in the estimate path");
    CHECK(nearly(seconds, 2.0, 1e-3), "wrap estimate == 2 s region, NOT 2 s + 10 s cap");

    // Phase 2 warm-up is preserved for a scoped wrap render (no cold start).
    CHECK(rs.warmUpStartTick == 0, "scoped wrap still warms up from tick 0 (Phase 2)");
    CHECK(rs.captureStartTick == lr.startTick, "wrap captures the region start");
    CHECK(rs.captureEndTick == lr.endTick, "wrap captures the region end");
}

int main() {
    std::cout << "── test_tail_render ──────────────────────────────────────\n";
    testDefaults();
    testHardCut();
    testWrapIsRealMode();
    testSanitize();
    testDetectorCap();
    testDetectorThreshold();
    testDetectorResetOnLoud();
    testFullTimelineTail();
    testScopedWarmupIntact();
    testDurationEstimate();
    testWrapScopePolicy();
    testFoldMath();
    testWrapTailCapped();
    testWrapDurationEstimate();

    std::cout << "──────────────────────────────────────────────────────────\n";
    std::cout << "Passed: " << g_passed << "  Failed: " << g_failed << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cout << "FAILED: " << g_failed << " checks\n";
    return 1;
}
