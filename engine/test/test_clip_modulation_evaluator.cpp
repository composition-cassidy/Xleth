// test_clip_modulation_evaluator.cpp — Phase B
//
// Self-verification for the pure deterministic ClipModulation evaluator.
// Build: see engine/CMakeLists.txt target "test_clip_modulation_evaluator"
// Run:   test_clip_modulation_evaluator(.exe)
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints failures and exits 1

#include "model/ClipModulationEvaluator.h"
#include "model/ClipModulationCompatibility.h"
#include "model/TimelineTypes.h"

#include <cmath>
#include <iostream>

using namespace xleth::clipmod;

// ─── Minimal test harness ─────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                        \
    do {                                                                        \
        if (cond) {                                                             \
            ++g_passed;                                                         \
        } else {                                                                \
            std::cerr << "  FAIL [line " << __LINE__ << "] " << (msg) << "\n"; \
            ++g_failed;                                                         \
        }                                                                       \
    } while (0)

#define CHECK_NEAR(a, b, tol, msg) \
    CHECK(std::abs((double)(a) - (double)(b)) < (tol), msg)

// ─── Helpers ──────────────────────────────────────────────────────────────────

static ClipModulationContext makeCtx(double bpm = 140.0) {
    ClipModulationContext ctx;
    ctx.bpm = bpm;
    ctx.sampleRate = 48000.0;
    return ctx;
}

// Build a vibrato that, when driven by clipLocalSeconds, produces phase01
// equal to clipLocalSeconds (rate = 1 Hz, FreeHz, phaseResetOnClipStart=true).
static ClipModulation::Vibrato makeUnitHzVibrato(
        ClipModulation::Vibrato::Shape shape) {
    ClipModulation::Vibrato v;
    v.enabled               = true;
    v.depthCents            = 100.0f; // arbitrary nonzero so evaluator runs
    v.rateMode              = ClipModulation::Vibrato::RateMode::FreeHz;
    v.rateHz                = 1.0f;
    v.shape                 = shape;
    v.phaseResetOnClipStart = true;
    v.phaseOffset           = 0.0f;
    return v;
}

static bool isNeutralVibrato(const VibratoEval& e) {
    return e.phase01 == 0.0f && e.lfo == 0.0f && e.cents == 0.0f
        && e.semis == 0.0f && e.pitchRatio == 1.0;
}

static bool isNeutralScratch(const ScratchEval& e, double clipLocalSeconds) {
    return e.rateMultiplier == 1.0f && !e.reversed && e.intensity01 == 0.0f
        && std::abs(e.sourceOffsetSeconds - clipLocalSeconds) < 1e-12
        && e.phase01 == 0.0f;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

static void test01_topLevelDisabledReturnsNeutral() {
    std::cout << "\n[01] top-level disabled returns neutral\n";

    ClipModulation m;
    m.enabled       = false;
    m.vibrato       = makeUnitHzVibrato(ClipModulation::Vibrato::Shape::Sine);
    m.scratch.enabled = true;
    m.scratch.curve.push_back({0.0f, -2.0f, 0.0f});

    auto ctx = makeCtx();
    ctx.clipLocalSeconds = 0.25;
    ctx.clipLocalBeats   = 0.5833;

    auto e = evaluateClipModulation(m, ctx);
    CHECK(isNeutralVibrato(e.vibrato), "vibrato is neutral when top-level disabled");
    CHECK(isNeutralScratch(e.scratch, ctx.clipLocalSeconds),
          "scratch is neutral when top-level disabled");
}

static void test02_vibratoDisabledReturnsNeutral() {
    std::cout << "\n[02] nested vibrato disabled returns neutral\n";

    ClipModulation m;
    m.enabled         = true;
    m.vibrato         = makeUnitHzVibrato(ClipModulation::Vibrato::Shape::Sine);
    m.vibrato.enabled = false;

    auto ctx = makeCtx();
    ctx.clipLocalSeconds = 0.25;

    auto e = evaluateClipModulation(m, ctx);
    CHECK(isNeutralVibrato(e.vibrato), "vibrato is neutral when nested disabled");
}

static void test03_scratchDisabledReturnsNeutral() {
    std::cout << "\n[03] nested scratch disabled returns neutral\n";

    ClipModulation m;
    m.enabled = true;
    m.scratch.enabled = false;
    m.scratch.curve.push_back({0.0f, 0.5f, 0.0f}); // would normally make rate 0.5

    auto ctx = makeCtx();
    ctx.clipLocalSeconds = 1.0;

    auto e = evaluateClipModulation(m, ctx);
    CHECK(isNeutralScratch(e.scratch, ctx.clipLocalSeconds),
          "scratch is neutral when nested disabled");
}

static void test04_sineKeyPhases() {
    std::cout << "\n[04] sine key phases\n";

    auto v = makeUnitHzVibrato(ClipModulation::Vibrato::Shape::Sine);
    auto ctx = makeCtx();

    ctx.clipLocalSeconds = 0.0;
    auto e = evaluateVibrato(v, ctx, true);
    CHECK_NEAR(e.phase01, 0.0,  1e-5, "sine phase=0");
    CHECK_NEAR(e.lfo,     0.0,  1e-5, "sine lfo @ 0    = 0");

    ctx.clipLocalSeconds = 0.25;
    e = evaluateVibrato(v, ctx, true);
    CHECK_NEAR(e.phase01, 0.25, 1e-5, "sine phase=0.25");
    CHECK_NEAR(e.lfo,     1.0,  1e-5, "sine lfo @ 0.25 = +1");

    ctx.clipLocalSeconds = 0.5;
    e = evaluateVibrato(v, ctx, true);
    CHECK_NEAR(e.phase01, 0.5,  1e-5, "sine phase=0.5");
    CHECK_NEAR(e.lfo,     0.0,  1e-5, "sine lfo @ 0.5  = 0");

    ctx.clipLocalSeconds = 0.75;
    e = evaluateVibrato(v, ctx, true);
    CHECK_NEAR(e.phase01, 0.75, 1e-5, "sine phase=0.75");
    CHECK_NEAR(e.lfo,    -1.0,  1e-5, "sine lfo @ 0.75 = -1");
}

static void test05_triangleKeyPhases() {
    std::cout << "\n[05] triangle key phases\n";

    auto v = makeUnitHzVibrato(ClipModulation::Vibrato::Shape::Triangle);
    auto ctx = makeCtx();

    ctx.clipLocalSeconds = 0.0;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).lfo,  0.0, 1e-6, "tri @ 0    = 0");

    ctx.clipLocalSeconds = 0.25;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).lfo,  1.0, 1e-6, "tri @ 0.25 = +1");

    ctx.clipLocalSeconds = 0.5;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).lfo,  0.0, 1e-6, "tri @ 0.5  = 0");

    ctx.clipLocalSeconds = 0.75;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).lfo, -1.0, 1e-6, "tri @ 0.75 = -1");
}

static void test06_sawAndSquareValues() {
    std::cout << "\n[06] sawUp / sawDown / square values\n";

    auto ctx = makeCtx();

    auto vUp   = makeUnitHzVibrato(ClipModulation::Vibrato::Shape::SawUp);
    auto vDn   = makeUnitHzVibrato(ClipModulation::Vibrato::Shape::SawDown);
    auto vSq   = makeUnitHzVibrato(ClipModulation::Vibrato::Shape::Square);

    const float phases[]    = {0.0f, 0.25f, 0.5f, 0.75f};
    const float expUp[]     = {-1.0f, -0.5f, 0.0f, 0.5f};
    const float expDn[]     = { 1.0f,  0.5f, 0.0f, -0.5f};
    const float expSq[]     = { 1.0f,  1.0f, -1.0f, -1.0f};

    for (int i = 0; i < 4; ++i) {
        ctx.clipLocalSeconds = phases[i];
        CHECK_NEAR(evaluateVibrato(vUp, ctx, true).lfo, expUp[i], 1e-6, "sawUp value");
        CHECK_NEAR(evaluateVibrato(vDn, ctx, true).lfo, expDn[i], 1e-6, "sawDown value");
        CHECK_NEAR(evaluateVibrato(vSq, ctx, true).lfo, expSq[i], 1e-6, "square value");
    }
}

static void test07_centsToRatio() {
    std::cout << "\n[07] cents to pitch ratio precision\n";

    // Sine at phase 0.25 has lfo=+1, so cents = depthCents * 1.
    auto v = makeUnitHzVibrato(ClipModulation::Vibrato::Shape::Sine);
    auto ctx = makeCtx();
    ctx.clipLocalSeconds = 0.25;

    v.depthCents = 1200.0f;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).pitchRatio, 2.0, 1e-9,
               "1200 cents -> ratio 2.0");

    v.depthCents = -1200.0f;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).pitchRatio, 0.5, 1e-9,
               "-1200 cents -> ratio 0.5");

    // depthCents=0 triggers neutral early-exit -> ratio 1.0
    v.depthCents = 0.0f;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).pitchRatio, 1.0, 1e-12,
               "0 cents -> ratio 1.0");
}

static void test08_freeHzUsesClipLocalWhenReset() {
    std::cout << "\n[08] FreeHz uses clip-local when phaseResetOnClipStart=true\n";

    auto v = makeUnitHzVibrato(ClipModulation::Vibrato::Shape::Sine);
    v.phaseResetOnClipStart = true;

    auto ctx = makeCtx();
    ctx.timelineSeconds = 10.0;

    ctx.clipLocalSeconds = 0.0;
    float p1 = evaluateVibrato(v, ctx, true).phase01;
    ctx.clipLocalSeconds = 0.25;
    float p2 = evaluateVibrato(v, ctx, true).phase01;

    CHECK_NEAR(p1, 0.0,  1e-5, "phase = 0 with clipLocal=0");
    CHECK_NEAR(p2, 0.25, 1e-5, "phase = 0.25 with clipLocal=0.25");
    CHECK(p1 != p2, "differing clipLocal -> differing phase");
}

static void test09_freeHzUsesTimelineWhenNoReset() {
    std::cout << "\n[09] FreeHz uses timeline when phaseResetOnClipStart=false\n";

    auto v = makeUnitHzVibrato(ClipModulation::Vibrato::Shape::Sine);
    v.phaseResetOnClipStart = false;

    auto ctx = makeCtx();
    ctx.clipLocalSeconds = 99.0; // ignored

    ctx.timelineSeconds = 0.0;
    float p1 = evaluateVibrato(v, ctx, true).phase01;
    ctx.timelineSeconds = 0.25;
    float p2 = evaluateVibrato(v, ctx, true).phase01;

    CHECK_NEAR(p1, 0.0,  1e-5, "phase = 0 with timeline=0");
    CHECK_NEAR(p2, 0.25, 1e-5, "phase = 0.25 with timeline=0.25");
    CHECK(p1 != p2, "differing timeline -> differing phase");
}

static void test10_tempoSync140Bpm() {
    std::cout << "\n[10] TempoSync at 140 BPM, key divisions\n";

    using D = ClipModulation::Vibrato::SyncDivision;

    auto v = makeUnitHzVibrato(ClipModulation::Vibrato::Shape::Sine);
    v.rateMode = ClipModulation::Vibrato::RateMode::TempoSync;
    auto ctx = makeCtx(140.0);

    // Quarter: 1 cycle/beat. At 1 beat -> phase wraps to 0.
    v.syncDivision = D::Quarter;
    ctx.clipLocalBeats = 1.0;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).phase01, 0.0, 1e-6,
               "Quarter @ 1 beat wraps to 0");

    // Quarter: at 0.5 beat -> phase = 0.5.
    ctx.clipLocalBeats = 0.5;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).phase01, 0.5, 1e-6,
               "Quarter @ 0.5 beat -> phase 0.5");

    // Eighth: 2 cycles/beat. At 0.25 beat -> 0.5 cycle -> phase 0.5.
    v.syncDivision = D::Eighth;
    ctx.clipLocalBeats = 0.25;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).phase01, 0.5, 1e-6,
               "Eighth @ 0.25 beat -> phase 0.5");

    // Sixteenth: 4 cycles/beat. At 0.125 beat -> 0.5 cycle -> phase 0.5.
    v.syncDivision = D::Sixteenth;
    ctx.clipLocalBeats = 0.125;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).phase01, 0.5, 1e-6,
               "Sixteenth @ 0.125 beat -> phase 0.5");
}

static void test11_tempoSyncDottedAndTriplet() {
    std::cout << "\n[11] TempoSync dotted and triplet divisions\n";

    using D = ClipModulation::Vibrato::SyncDivision;

    auto v = makeUnitHzVibrato(ClipModulation::Vibrato::Shape::Sine);
    v.rateMode = ClipModulation::Vibrato::RateMode::TempoSync;
    auto ctx = makeCtx(140.0);

    // QuarterTriplet: 1.5 cycles/beat. At 1 beat -> 1.5 cycles -> phase 0.5.
    v.syncDivision = D::QuarterTriplet;
    ctx.clipLocalBeats = 1.0;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).phase01, 0.5, 1e-6,
               "QuarterTriplet @ 1 beat -> phase 0.5");

    // EighthDotted: 4/3 cycles/beat. At 0.375 beat -> 0.5 cycle -> phase 0.5.
    // (Mid-cycle target avoids the wrap-boundary FP noise that would arise
    //  from landing exactly at an integer number of cycles via 4/3.)
    v.syncDivision = D::EighthDotted;
    ctx.clipLocalBeats = 0.375;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).phase01, 0.5, 1e-5,
               "EighthDotted @ 0.375 beat -> phase 0.5");

    // QuarterDotted: 2/3 cycles/beat. At 0.75 beat -> 0.5 cycle -> phase 0.5.
    v.syncDivision = D::QuarterDotted;
    ctx.clipLocalBeats = 0.75;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).phase01, 0.5, 1e-5,
               "QuarterDotted @ 0.75 beat -> phase 0.5");

    // EighthTriplet: 3 cycles/beat. At 1/6 beat -> 0.5 cycle -> phase 0.5.
    v.syncDivision = D::EighthTriplet;
    ctx.clipLocalBeats = 1.0 / 6.0;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).phase01, 0.5, 1e-5,
               "EighthTriplet @ 1/6 beat -> phase 0.5");
}

static void test12_phaseOffsetShifts() {
    std::cout << "\n[12] phase offset shifts phase deterministically\n";

    auto v = makeUnitHzVibrato(ClipModulation::Vibrato::Shape::Sine);
    auto ctx = makeCtx();
    ctx.clipLocalSeconds = 0.0;

    v.phaseOffset = 0.0f;
    float p0 = evaluateVibrato(v, ctx, true).phase01;
    v.phaseOffset = 0.25f;
    float p1 = evaluateVibrato(v, ctx, true).phase01;

    CHECK_NEAR(p0, 0.0,  1e-6, "phase=0 with offset=0");
    CHECK_NEAR(p1, 0.25, 1e-6, "phase=0.25 with offset=0.25");

    // Wrap-around: offset 0.75 + clip 0.5 -> 1.25 -> wraps to 0.25.
    ctx.clipLocalSeconds = 0.5;
    v.phaseOffset = 0.75f;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).phase01, 0.25, 1e-6,
               "wrap: 0.5 + 0.75 -> 0.25");
}

static void test13_customShapeEmptyReturnsZero() {
    std::cout << "\n[13] custom shape empty returns lfo=0\n";

    auto v = makeUnitHzVibrato(ClipModulation::Vibrato::Shape::Custom);
    // customShape left empty
    auto ctx = makeCtx();

    for (double t : {0.0, 0.25, 0.5, 0.75, 0.999}) {
        ctx.clipLocalSeconds = t;
        CHECK_NEAR(evaluateVibrato(v, ctx, true).lfo, 0.0, 1e-9,
                   "empty custom shape -> lfo=0");
    }
}

static void test14_customShape3PointInterpolates() {
    std::cout << "\n[14] custom shape 3-point linear interpolation\n";

    auto v = makeUnitHzVibrato(ClipModulation::Vibrato::Shape::Custom);
    v.customShape.push_back({0.0f, 0.0f});
    v.customShape.push_back({0.5f, 1.0f});
    v.customShape.push_back({1.0f, 0.0f});

    auto ctx = makeCtx();

    ctx.clipLocalSeconds = 0.25;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).lfo, 0.5, 1e-5,
               "custom @ 0.25 -> 0.5");

    ctx.clipLocalSeconds = 0.5;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).lfo, 1.0, 1e-5,
               "custom @ 0.5 -> 1.0");

    ctx.clipLocalSeconds = 0.75;
    CHECK_NEAR(evaluateVibrato(v, ctx, true).lfo, 0.5, 1e-5,
               "custom @ 0.75 -> 0.5");
}

static void test15_scratchEmptyCurveNeutral() {
    std::cout << "\n[15] scratch with empty curve -> neutral\n";

    ClipModulation::Scratch s;
    s.enabled = true;

    auto ctx = makeCtx();
    ctx.clipLocalSeconds = 3.5;

    auto e = evaluateScratch(s, ctx, true);
    CHECK(isNeutralScratch(e, ctx.clipLocalSeconds),
          "empty curve neutral with sourceOffsetSeconds=clipLocalSeconds");
}

static void test16_scratchLinearInterpolation() {
    std::cout << "\n[16] scratch linear interpolation between rate points\n";

    ClipModulation::Scratch s;
    s.enabled  = true;
    s.timeMode = ClipModulation::Scratch::CurveTimeMode::ClipSeconds;
    s.curve.push_back({0.0f, 1.0f, 0.0f});
    s.curve.push_back({1.0f, 2.0f, 0.0f});

    auto ctx = makeCtx();
    ctx.clipLocalSeconds = 0.5;

    auto e = evaluateScratch(s, ctx, true);
    CHECK_NEAR(e.rateMultiplier, 1.5f, 1e-5, "rate at 0.5 -> 1.5");
    CHECK(!e.reversed, "rate 1.5 not reversed");
    CHECK_NEAR(e.intensity01, 0.5f, 1e-5, "|1.5-1| -> 0.5");
}

static void test17_scratchNegativeRateReversed() {
    std::cout << "\n[17] scratch negative rate -> reversed=true\n";

    ClipModulation::Scratch s;
    s.enabled  = true;
    s.timeMode = ClipModulation::Scratch::CurveTimeMode::ClipSeconds;
    s.curve.push_back({0.0f, -1.0f, 0.0f});

    auto ctx = makeCtx();
    ctx.clipLocalSeconds = 0.5;

    auto e = evaluateScratch(s, ctx, true);
    CHECK(e.reversed, "rate=-1 -> reversed");
    CHECK_NEAR(e.rateMultiplier, -1.0f, 1e-6, "rateMultiplier == -1");
    CHECK_NEAR(e.intensity01, 1.0f, 1e-5, "intensity = clamp(|-1-1|,0,1) = 1");
}

static void test18_scratchStopHighIntensityNoOffsetGrowth() {
    std::cout << "\n[18] scratch zero rate -> high intensity, no offset growth\n";

    ClipModulation::Scratch s;
    s.enabled  = true;
    s.timeMode = ClipModulation::Scratch::CurveTimeMode::ClipSeconds;
    s.curve.push_back({0.0f,  0.0f, 0.0f});
    s.curve.push_back({10.0f, 0.0f, 0.0f});

    auto ctx = makeCtx();

    ctx.clipLocalSeconds = 5.0;
    auto e1 = evaluateScratch(s, ctx, true);
    ctx.clipLocalSeconds = 8.0;
    auto e2 = evaluateScratch(s, ctx, true);

    CHECK_NEAR(e1.rateMultiplier, 0.0f, 1e-6, "rate at 5s = 0");
    CHECK_NEAR(e2.rateMultiplier, 0.0f, 1e-6, "rate at 8s = 0");
    CHECK_NEAR(e1.intensity01, 1.0f, 1e-5, "intensity = clamp(|0-1|,0,1) = 1");
    CHECK_NEAR(e1.sourceOffsetSeconds, 0.0, 1e-12, "offset stays 0 across stop");
    CHECK_NEAR(e2.sourceOffsetSeconds, 0.0, 1e-12, "offset stays 0 across stop");
    CHECK_NEAR(e1.sourceOffsetSeconds, e2.sourceOffsetSeconds, 1e-12,
               "offset identical at 5s and 8s under stopped segment");
}

static void test19_scratchClipPercentMode() {
    std::cout << "\n[19] scratch ClipPercent mode\n";

    ClipModulation::Scratch s;
    s.enabled  = true;
    s.timeMode = ClipModulation::Scratch::CurveTimeMode::ClipPercent;
    // 0.0 -> 0s, 0.5 -> 2s, 1.0 -> 4s   (with clipDurationSeconds=4)
    s.curve.push_back({0.0f, 1.0f, 0.0f});
    s.curve.push_back({0.5f, 2.0f, 0.0f});
    s.curve.push_back({1.0f, 1.0f, 0.0f});

    auto ctx = makeCtx();
    ctx.clipDurationSeconds = 4.0;
    ctx.clipLocalSeconds    = 2.0; // exactly the midpoint

    auto e = evaluateScratch(s, ctx, true);
    CHECK_NEAR(e.rateMultiplier, 2.0f, 1e-5,
               "ClipPercent: rate at 50% (=2s of 4s) -> 2.0");
}

static void test20_scratchBeatsMode() {
    std::cout << "\n[20] scratch Beats mode\n";

    ClipModulation::Scratch s;
    s.enabled  = true;
    s.timeMode = ClipModulation::Scratch::CurveTimeMode::Beats;
    // bpm=120 -> 1 beat = 0.5s. point at beat=2 -> 1s.
    s.curve.push_back({0.0f, 1.0f, 0.0f});
    s.curve.push_back({2.0f, 3.0f, 0.0f});

    auto ctx = makeCtx(120.0);
    ctx.clipLocalSeconds = 1.0; // == 2 beats == last point

    auto e = evaluateScratch(s, ctx, true);
    CHECK_NEAR(e.rateMultiplier, 3.0f, 1e-5,
               "Beats: rate at 1s (=2 beats @120bpm) -> 3.0");
}

static void test21_scratchSourceOffsetIntegral() {
    std::cout << "\n[21] scratch sourceOffsetSeconds integrates correctly\n";

    ClipModulation::Scratch s;
    s.enabled  = true;
    s.timeMode = ClipModulation::Scratch::CurveTimeMode::ClipSeconds;
    s.curve.push_back({0.0f, 1.0f, 0.0f});
    s.curve.push_back({2.0f, 3.0f, 0.0f});

    auto ctx = makeCtx();

    // At t=2s: full trapezoid = 0.5 * (1+3) * 2 = 4.
    ctx.clipLocalSeconds = 2.0;
    auto e2 = evaluateScratch(s, ctx, true);
    CHECK_NEAR(e2.sourceOffsetSeconds, 4.0, 1e-9,
               "integral 0..2s of linear 1->3 = 4");

    // At t=1s: rate at 1s is lerp(0,1,2,3,1)=2. Trapezoid 0..1 with rates 1,2 = 1.5.
    ctx.clipLocalSeconds = 1.0;
    auto e1 = evaluateScratch(s, ctx, true);
    CHECK_NEAR(e1.rateMultiplier,      2.0f, 1e-5,
               "rate at 1s on linear 1->3 = 2");
    CHECK_NEAR(e1.sourceOffsetSeconds, 1.5,  1e-9,
               "integral 0..1s of linear 1->2 = 1.5");

    // Beyond last point: integral grows at last rate (3.0) per second.
    ctx.clipLocalSeconds = 3.0;
    auto e3 = evaluateScratch(s, ctx, true);
    CHECK_NEAR(e3.sourceOffsetSeconds, 4.0 + 3.0, 1e-9,
               "integral past last point grows at held rate");

    // Before any explicit point: rate=1, integral=elapsed seconds.
    {
        ClipModulation::Scratch s2;
        s2.enabled  = true;
        s2.timeMode = ClipModulation::Scratch::CurveTimeMode::ClipSeconds;
        s2.curve.push_back({2.0f, 5.0f, 0.0f}); // first point at 2s
        ctx.clipLocalSeconds = 1.0;
        auto pre = evaluateScratch(s2, ctx, true);
        CHECK_NEAR(pre.rateMultiplier,      1.0f, 1e-6,
                   "rate before first point = 1.0");
        CHECK_NEAR(pre.sourceOffsetSeconds, 1.0,  1e-9,
                   "offset before first point = elapsed seconds");
    }
}

// ─── Phase F.1: shared compatibility helper matrix ────────────────────────────

static void test22_compatibilityHelperMatrix() {
    std::cout << "\n[22] Phase F.1 compatibility helper — static pitch and stretch compatible, "
                 "reverse/formant bypass with precise reason\n";

    using xleth::clipmod::isClipModulationCompatible;
    using xleth::clipmod::classifyClipModulationBypass;
    using xleth::clipmod::ClipModulationBypassReason;

    // Helper to build a vibrato-on / scratch-off modulation.
    auto vib = [] {
        ClipModulation m;
        m.enabled = true;
        m.vibrato.enabled = true;
        m.vibrato.depthCents = 50.0f;
        return m;
    };
    auto scr = [] {
        ClipModulation m;
        m.enabled = true;
        m.scratch.enabled = true;
        m.scratch.curve.push_back({0.0f, 1.5f, 0.0f});
        return m;
    };
    auto both = [&] {
        auto m = vib();
        m.scratch.enabled = true;
        m.scratch.curve.push_back({0.0f, 1.5f, 0.0f});
        return m;
    };

    // ── Plain clip ──────────────────────────────────────────────────────────
    {
        const auto m = vib();
        CHECK(isClipModulationCompatible(false, 1.0, false, m), "plain + vibrato compatible");
        CHECK(classifyClipModulationBypass(false, 1.0, false, m) == ClipModulationBypassReason::None,
              "plain + vibrato has no bypass reason");
    }
    {
        const auto m = scr();
        CHECK(isClipModulationCompatible(false, 1.0, false, m), "plain + scratch compatible");
    }
    {
        const auto m = both();
        CHECK(isClipModulationCompatible(false, 1.0, false, m), "plain + vibrato+scratch compatible");
    }

    // ── Static pitch clips MUST remain compatible ───────────────────────────
    // Helper does not see pitchOffset/pitchOffsetCents — that's exactly the
    // point: static pitch is composed inside the modulated reader, never
    // bypassed. These cases assert plain/static pitch parity.
    {
        const auto m = vib();
        CHECK(isClipModulationCompatible(false, 1.0, false, m),
              "static-pitch-equivalent (semis only) clip compatible "
              "(helper agnostic to pitchOffset)");
    }
    {
        const auto m = both();
        CHECK(isClipModulationCompatible(false, 1.0, false, m),
              "static-pitch-equivalent clip with vibrato + scratch compatible");
    }

    // ── Stretch-compatible and bypass cases with precise reason ─────────────
    {
        const auto m = vib();
        CHECK(!isClipModulationCompatible(true, 1.0, false, m),
              "reversed clip is NOT compatible");
        CHECK(classifyClipModulationBypass(true, 1.0, false, m) == ClipModulationBypassReason::Reversed,
              "reversed clip reports Reversed");
    }
    {
        const auto m = vib();
        CHECK(isClipModulationCompatible(false, 1.5, false, m),
              "stretched clip is compatible");
        CHECK(classifyClipModulationBypass(false, 1.5, false, m) == ClipModulationBypassReason::None,
              "stretched clip reports no bypass");
        CHECK(isClipModulationCompatible(false, 0.5, false, m),
              "stretched clip (0.5x) is compatible");
        CHECK(classifyClipModulationBypass(false, 0.5, false, m) == ClipModulationBypassReason::None,
              "stretched clip (0.5x) reports no bypass");
    }
    {
        const auto m = vib();
        CHECK(!isClipModulationCompatible(false, 1.0, true, m),
              "formant-preserve clip is NOT compatible");
        CHECK(classifyClipModulationBypass(false, 1.0, true, m) == ClipModulationBypassReason::FormantPreserve,
              "formant-preserve clip reports FormantPreserve");
    }

    // ── Modulation root / curve disabled ────────────────────────────────────
    {
        ClipModulation m;
        m.enabled = false;
        m.vibrato.enabled = true;
        CHECK(!isClipModulationCompatible(false, 1.0, false, m),
              "root-disabled clip is NOT compatible");
        CHECK(classifyClipModulationBypass(false, 1.0, false, m) == ClipModulationBypassReason::Disabled,
              "root-disabled clip reports Disabled");
    }
    {
        ClipModulation m;
        m.enabled = true;  // root on
        m.vibrato.enabled = false;
        m.scratch.enabled = false;
        CHECK(!isClipModulationCompatible(false, 1.0, false, m),
              "no-active-curve clip is NOT compatible");
        CHECK(classifyClipModulationBypass(false, 1.0, false, m) == ClipModulationBypassReason::NoActiveCurve,
              "no-active-curve clip reports NoActiveCurve");
    }

    // ── Reason precedence: Disabled > NoActiveCurve > Reversed > FormantPreserve ──
    // (matches the order in classifyClipModulationBypass; lock it in.)
    {
        ClipModulation m;  // disabled root + reversed + stretched + formant
        CHECK(classifyClipModulationBypass(true, 1.5, true, m) == ClipModulationBypassReason::Disabled,
              "Disabled wins over Reversed/FormantPreserve");
    }
    {
        ClipModulation m;
        m.enabled = true;
        // no curve enabled
        CHECK(classifyClipModulationBypass(true, 1.5, true, m) == ClipModulationBypassReason::NoActiveCurve,
              "NoActiveCurve wins over Reversed/FormantPreserve");
    }
    {
        const auto m = vib();
        CHECK(classifyClipModulationBypass(true, 1.5, true, m) == ClipModulationBypassReason::Reversed,
              "Reversed wins over FormantPreserve");
        CHECK(classifyClipModulationBypass(false, 1.5, true, m) == ClipModulationBypassReason::FormantPreserve,
              "FormantPreserve still bypasses stretched clips");
    }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

int main() {
    test01_topLevelDisabledReturnsNeutral();
    test02_vibratoDisabledReturnsNeutral();
    test03_scratchDisabledReturnsNeutral();
    test04_sineKeyPhases();
    test05_triangleKeyPhases();
    test06_sawAndSquareValues();
    test07_centsToRatio();
    test08_freeHzUsesClipLocalWhenReset();
    test09_freeHzUsesTimelineWhenNoReset();
    test10_tempoSync140Bpm();
    test11_tempoSyncDottedAndTriplet();
    test12_phaseOffsetShifts();
    test13_customShapeEmptyReturnsZero();
    test14_customShape3PointInterpolates();
    test15_scratchEmptyCurveNeutral();
    test16_scratchLinearInterpolation();
    test17_scratchNegativeRateReversed();
    test18_scratchStopHighIntensityNoOffsetGrowth();
    test19_scratchClipPercentMode();
    test20_scratchBeatsMode();
    test21_scratchSourceOffsetIntegral();
    test22_compatibilityHelperMatrix();

    std::cout << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED (" << g_passed << " checks)\n";
        return 0;
    }
    std::cout << "FAILED: " << g_failed << " check(s) failed, "
              << g_passed << " passed\n";
    return 1;
}
