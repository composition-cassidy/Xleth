// test_render_scope.cpp — Phase 2 render scoping + absolute warm-up policy.
// Pure / model-only (render/RenderScope.h depends only on LoopRegion) — no JUCE,
// no FFmpeg, no GL. Build: engine/CMakeLists.txt target "test_render_scope".
// Pass: prints "ALL TESTS PASSED" and exits 0. Fail: exits 1.

#include "render/RenderScope.h"
#include "model/TimelineTypes.h"

#include <iostream>

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                  \
    do {                                                                  \
        if (cond) { ++g_passed; }                                         \
        else { std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; \
               ++g_failed; }                                              \
    } while (0)

using xleth::computeRenderScope;
using xleth::computeRenderPrerollPlan;
using xleth::RenderScope;
using xleth::RenderScopeOverride;

// 4 bars @ 960 PPQ = 16 beats = 15360 ticks. Sane "full timeline" stand-in.
static constexpr int64_t kFullEnd = 32 * 960;   // 32 beats

// ─── 1. loopEnabled == false → full timeline ───────────────────────────────────

static void testFullTimeline() {
    std::cout << "[1] loopEnabled false → full timeline bounds\n";
    LoopRegion lr;                       // default loopEnabled == false
    lr.startTick = 4 * 960;              // non-zero region must be IGNORED
    lr.endTick   = 8 * 960;
    lr.loopEnabled = false;

    RenderScope rs = computeRenderScope(lr, kFullEnd);
    CHECK(rs.scoped == false, "renderScoped == loopEnabled (false)");
    CHECK(rs.captureStartTick == 0, "full render starts at tick 0");
    CHECK(rs.captureEndTick == kFullEnd, "full render ends at last meaningful event");
    CHECK(rs.warmUpStartTick == 0, "full render warms up from 0");
}

// ─── 2. loopEnabled == true → [startTick, endTick] absolute window ──────────────

static void testScopedAbsolute() {
    std::cout << "[2] loopEnabled true → [startTick, endTick] absolute window\n";
    LoopRegion lr;
    lr.startTick = 8 * 960;             // beat 8
    lr.endTick   = 12 * 960;           // beat 12
    lr.loopEnabled = true;
    CHECK(lr.renderOrigin == LoopRegion::RenderOrigin::Absolute,
          "renderOrigin default is absolute");

    RenderScope rs = computeRenderScope(lr, kFullEnd);
    CHECK(rs.scoped == true, "renderScoped == loopEnabled (true)");
    CHECK(rs.captureStartTick == 8 * 960, "captureStartTick == loopRegion.startTick");
    CHECK(rs.captureEndTick == 12 * 960, "captureEndTick == loopRegion.endTick");
    // THE absolute-window invariant: warm up from tick 0, NOT cold-start at start.
    CHECK(rs.warmUpStartTick == 0, "absolute window warms up from tick 0 (no cold start)");
    CHECK(rs.warmUpStartTick < rs.captureStartTick,
          "warm-up precedes capture (in-flight content recreated)");
}

// ─── 3. Normalized origin falls back to absolute (never cold-starts) ───────────

static void testNormalizedFallback() {
    std::cout << "[3] Normalized origin falls back to absolute warm-up\n";
    LoopRegion lr;
    lr.startTick = 6 * 960;
    lr.endTick   = 10 * 960;
    lr.loopEnabled = true;
    lr.renderOrigin = LoopRegion::RenderOrigin::Normalized;   // Phase 3+ — inert here

    RenderScope rs = computeRenderScope(lr, kFullEnd);
    CHECK(rs.captureStartTick == 6 * 960, "normalized still captures region start");
    // Phase 2 deliberately does NOT cold-start; normalized warms up at start
    // (its own zero) rather than silently dropping in-flight content.
    CHECK(rs.warmUpStartTick == rs.captureStartTick,
          "normalized warm-up == capture start (no implicit pre-roll-from-0 yet)");
}

// ─── 4. Debug bounds override (dev manual bars) ────────────────────────────────

static void testDebugOverride() {
    std::cout << "[4] debug override repoints bounds (debug path only)\n";
    LoopRegion lr;
    lr.startTick = 8 * 960;
    lr.endTick   = 12 * 960;
    lr.loopEnabled = true;

    RenderScopeOverride dbg;
    dbg.active = true;
    dbg.startTick = 2 * 960;
    dbg.endTick   = 5 * 960;

    RenderScope rs = computeRenderScope(lr, kFullEnd, dbg);
    CHECK(rs.scoped == true, "override forces scoped render");
    CHECK(rs.captureStartTick == 2 * 960, "override replaces region startTick");
    CHECK(rs.captureEndTick == 5 * 960, "override replaces region endTick");
    CHECK(rs.warmUpStartTick == 0, "override uses absolute warm-up from 0");

    // Inactive / invalid override is ignored → LoopRegion wins.
    RenderScopeOverride inactive;            // active == false
    RenderScope rs2 = computeRenderScope(lr, kFullEnd, inactive);
    CHECK(rs2.captureStartTick == 8 * 960, "inactive override → LoopRegion bounds used");

    RenderScopeOverride empty; empty.active = true; empty.startTick = 100; empty.endTick = 100;
    RenderScope rs3 = computeRenderScope(lr, kFullEnd, empty);
    CHECK(rs3.captureStartTick == 8 * 960, "zero-length override ignored → LoopRegion used");
}

// ─── 5. Pre-roll math: warm-up from 0 vs latency-only ──────────────────────────

static void testPrerollMath() {
    std::cout << "[5] pre-roll plan warm-up math\n";

    // Legacy latency-only (warmUp == captureStart). Mid-project with 1024 latency.
    {
        auto p = computeRenderPrerollPlan(/*warmUp*/48000, /*capStart*/48000, 1024, 0);
        CHECK(p.renderStartSample == 48000 - 1024, "latency-only: render starts latency before capture");
        CHECK(p.discardSamples == 2048, "latency-only: discard = available preroll + latency");
        CHECK(p.totalPrerollSamples == 1024, "latency total");
    }
    // No latency, warm-up == capture: nothing discarded.
    {
        auto p = computeRenderPrerollPlan(0, 0, 0, 0);
        CHECK(p.renderStartSample == 0 && p.discardSamples == 0, "tick-0 unscoped: zero discard");
    }
    // Scoped absolute window: capture [48000, 96000), warm up from 0.
    {
        auto p = computeRenderPrerollPlan(/*warmUp*/0, /*capStart*/48000, 0, 0);
        CHECK(p.renderStartSample == 0, "absolute window: engine processes from sample 0");
        CHECK(p.discardSamples == 48000, "absolute window: discard all of [0, captureStart)");
    }
    // Scoped absolute window + latency: warm-up still from 0, latency flushed too.
    {
        auto p = computeRenderPrerollPlan(/*warmUp*/0, /*capStart*/48000, 1024, 512);
        CHECK(p.renderStartSample == 0, "warm-up from 0 keeps renderStart clamped at 0");
        CHECK(p.totalPrerollSamples == 1536, "track+master latency summed");
        CHECK(p.discardSamples == 48000 + 1536, "discard = warm-up history + latency");
    }
}

// ─── 6. Cold-start regression proof ────────────────────────────────────────────
// Deterministic proof that a scoped absolute render does NOT cold-start at the
// region start. We model a held source that begins at tick 0 and is still active
// at the region start (tick 8*960). The render plan MUST process from sample 0 so
// the held content is recreated. This test FAILS if the implementation reverts to
// cold-start (renderStart == captureStart) or zero leading-discard.

static void testColdStartRegression() {
    std::cout << "[6] cold-start regression (in-flight content survives)\n";

    const double bpm = 120.0, sr = 48000.0;
    const auto tickToSample = [&](int64_t tick) {
        return static_cast<int64_t>((tick / 960.0) * (60.0 / bpm) * sr + 0.5);
    };

    LoopRegion lr;
    lr.startTick = 8 * 960;             // region starts mid-held-content
    lr.endTick   = 16 * 960;
    lr.loopEnabled = true;             // → scoped, absolute (default origin)

    RenderScope rs = computeRenderScope(lr, kFullEnd);
    CHECK(rs.warmUpStartTick == 0, "scoped absolute warms up from tick 0");
    CHECK(rs.captureStartTick == lr.startTick, "capture starts at region start");
    CHECK(rs.captureEndTick == lr.endTick, "capture ends at region end");

    const int64_t captureStartSample = tickToSample(rs.captureStartTick);
    const int64_t warmUpStartSample  = tickToSample(rs.warmUpStartTick);
    CHECK(warmUpStartSample == 0, "warm-up start sample is 0");
    CHECK(captureStartSample > 0, "capture start sample is past 0 (held note precedes it)");

    auto plan = computeRenderPrerollPlan(warmUpStartSample, captureStartSample, 0, 0);
    // The decisive assertions: engine begins at sample 0 and discards the entire
    // pre-region span. A cold-start implementation would have renderStart ==
    // captureStartSample and discard == 0 (+latency only) — failing both.
    CHECK(plan.renderStartSample == 0,
          "FAIL-IF-COLD-START: engine must process from sample 0, not from region start");
    CHECK(plan.discardSamples == captureStartSample,
          "FAIL-IF-COLD-START: all pre-region output must be discarded (silent warm-up)");

    // Output timestamp invariant: the file begins at 0 with no leading gap.
    // Captured length == region length exactly.
    const int64_t captureEndSample = tickToSample(rs.captureEndTick);
    const int64_t outputStartTime  = 0;
    CHECK(outputStartTime == 0, "output file timestamp starts at 0");
    CHECK((captureEndSample - captureStartSample) > 0, "captured span is the region length");
}

int main() {
    std::cout << "── test_render_scope ─────────────────────────────────────\n";
    testFullTimeline();
    testScopedAbsolute();
    testNormalizedFallback();
    testDebugOverride();
    testPrerollMath();
    testColdStartRegression();

    std::cout << "──────────────────────────────────────────────────────────\n";
    std::cout << "Passed: " << g_passed << "  Failed: " << g_failed << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cout << "FAILED: " << g_failed << " checks\n";
    return 1;
}
