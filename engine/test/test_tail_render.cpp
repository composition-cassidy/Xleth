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

// ─── 3. wrap is NEVER silently treated as tailClamp ─────────────────────────────

static void testWrapNotTailClamp() {
    std::cout << "[3] wrap degrades to hardCut, never tailClamp (Phase 3B gated)\n";
    LoopRegion lr; lr.tailMode = LoopRegion::TailMode::Wrap;
    TailRenderPlan p = computeTailRenderPlan(lr, kSr);
    CHECK(p.mode != TailRenderMode::TailClamp, "wrap must NOT become tailClamp");
    CHECK(p.mode == TailRenderMode::HardCut, "wrap degrades to a plain hard cut");
    CHECK(p.maxTailSamples == 0, "wrap renders no faked tail");
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

int main() {
    std::cout << "── test_tail_render ──────────────────────────────────────\n";
    testDefaults();
    testHardCut();
    testWrapNotTailClamp();
    testSanitize();
    testDetectorCap();
    testDetectorThreshold();
    testDetectorResetOnLoud();
    testFullTimelineTail();
    testScopedWarmupIntact();
    testDurationEstimate();

    std::cout << "──────────────────────────────────────────────────────────\n";
    std::cout << "Passed: " << g_passed << "  Failed: " << g_failed << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cout << "FAILED: " << g_failed << " checks\n";
    return 1;
}
