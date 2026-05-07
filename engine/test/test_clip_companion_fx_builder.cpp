// test_clip_companion_fx_builder.cpp — Phase E.3
//
// Self-verification for the shared builder that produces the per-frame
// ClipCompanionFxSnapshot for both the export pipeline (FrameCollector →
// GridCompositor) and the realtime OpenGL preview path (SyncManager →
// VideoCompositor).
//
// Build: see engine/CMakeLists.txt target "test_clip_companion_fx_builder"
// Run:   test_clip_companion_fx_builder(.exe)
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints failures and exits 1

#include "model/ClipCompanionFxBuilder.h"
#include "model/ClipCompanionFxSnapshot.h"
#include "model/ClipVideoModulationTiming.h"
#include "model/TimelineTypes.h"

#include <cmath>
#include <iostream>

using namespace xleth::clipmod;

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

// ── Helpers ────────────────────────────────────────────────────────────────

static ClipModulation makeFullyEnabledModulation() {
    ClipModulation m;
    m.enabled = true;
    m.vibrato.enabled = true;
    m.scratch.enabled = true;
    m.video.vibratoSwirlEnabled = true;
    m.video.scratchWaveEnabled  = true;
    m.video.swirlAmount  = 0.5f;
    m.video.swirlRadius  = 0.4f;
    m.video.swirlCenterX = 0.5f;
    m.video.swirlCenterY = 0.5f;
    m.video.waveAmount    = 0.2f;
    m.video.waveFrequency = 12.0f;
    m.video.smearAmount   = 0.3f;
    m.video.reverseWaveWithScratch = true;
    return m;
}

static VideoModulationTimingResult makeActiveTiming() {
    VideoModulationTimingResult t;
    t.timingActive   = true;
    t.scratchActive  = true;
    t.vibratoActive  = true;
    t.vibratoLfo     = 0.7f;
    t.vibratoPhase01 = 0.25f;
    t.vibratoCents   = 30.0f;
    t.scratchRateMultiplier = 1.5f;
    t.scratchPhase01        = 0.4f;
    t.scratchIntensity01    = 0.8f;
    return t;
}

// ── Tests ──────────────────────────────────────────────────────────────────

static void test01_timingInactiveReturnsDefault() {
    std::cout << "\n[01] timing.timingActive=false → default snapshot\n";
    auto m = makeFullyEnabledModulation();
    VideoModulationTimingResult timing; // default: timingActive=false

    auto snap = buildClipCompanionFxSnapshot(m, timing);

    CHECK(!snap.vibratoSwirlEnabled, "swirl disabled when timing inactive");
    CHECK(!snap.scratchWaveEnabled,  "wave disabled when timing inactive");
    CHECK_NEAR(snap.vibratoLfo,     0.0f, 1e-6, "lfo cleared");
    CHECK_NEAR(snap.scratchRateMultiplier, 1.0f, 1e-6, "rate default 1.0");
    CHECK_NEAR(snap.swirlAmount,    0.0f, 1e-6, "swirlAmount default 0");
    CHECK_NEAR(snap.waveAmount,     0.0f, 1e-6, "waveAmount default 0");
}

static void test02_swirlPopulatesWhenAllActive() {
    std::cout << "\n[02] swirl populated when video flag, vibratoActive, timingActive all true\n";
    auto m = makeFullyEnabledModulation();
    auto t = makeActiveTiming();

    auto snap = buildClipCompanionFxSnapshot(m, t);

    CHECK(snap.vibratoSwirlEnabled, "swirl enabled");
    CHECK_NEAR(snap.vibratoLfo,     0.7f, 1e-6, "vibratoLfo propagated");
    CHECK_NEAR(snap.vibratoPhase01, 0.25f, 1e-6, "vibratoPhase01 propagated");
    CHECK_NEAR(snap.vibratoCents,   30.0f, 1e-6, "vibratoCents propagated");
    CHECK_NEAR(snap.swirlAmount,    0.5f, 1e-6, "swirlAmount propagated");
    CHECK_NEAR(snap.swirlRadius,    0.4f, 1e-6, "swirlRadius propagated");
    CHECK_NEAR(snap.swirlCenterX,   0.5f, 1e-6, "swirlCenterX propagated");
    CHECK_NEAR(snap.swirlCenterY,   0.5f, 1e-6, "swirlCenterY propagated");
}

static void test03_waveSmearPopulatesWhenAllActive() {
    std::cout << "\n[03] wave/smear populated when video flag, scratchActive, timingActive all true\n";
    auto m = makeFullyEnabledModulation();
    auto t = makeActiveTiming();

    auto snap = buildClipCompanionFxSnapshot(m, t);

    CHECK(snap.scratchWaveEnabled, "wave enabled");
    CHECK_NEAR(snap.scratchRateMultiplier, 1.5f, 1e-6, "rate propagated");
    CHECK_NEAR(snap.scratchPhase01,        0.4f, 1e-6, "phase propagated");
    CHECK_NEAR(snap.scratchIntensity01,    0.8f, 1e-6, "intensity propagated");
    CHECK_NEAR(snap.waveAmount,     0.2f, 1e-6, "waveAmount propagated");
    CHECK_NEAR(snap.waveFrequency, 12.0f, 1e-6, "waveFrequency propagated");
    CHECK_NEAR(snap.smearAmount,    0.3f, 1e-6, "smearAmount propagated");
    CHECK(snap.reverseWaveWithScratch, "reverseWaveWithScratch propagated");
}

static void test04_swirlGatedByVibratoActive() {
    std::cout << "\n[04] swirl stays disabled when vibratoActive=false even if video flag set\n";
    auto m = makeFullyEnabledModulation();
    auto t = makeActiveTiming();
    t.vibratoActive = false;

    auto snap = buildClipCompanionFxSnapshot(m, t);

    CHECK(!snap.vibratoSwirlEnabled, "swirl gated off by vibratoActive");
    CHECK_NEAR(snap.swirlAmount, 0.0f, 1e-6, "swirlAmount stays default");
    // wave should still come through because scratch is still active
    CHECK(snap.scratchWaveEnabled, "wave unaffected by vibratoActive");
}

static void test05_waveGatedByScratchActive() {
    std::cout << "\n[05] wave stays disabled when scratchActive=false even if video flag set\n";
    auto m = makeFullyEnabledModulation();
    auto t = makeActiveTiming();
    t.scratchActive = false;

    auto snap = buildClipCompanionFxSnapshot(m, t);

    CHECK(!snap.scratchWaveEnabled, "wave gated off by scratchActive");
    CHECK_NEAR(snap.waveAmount, 0.0f, 1e-6, "waveAmount stays default");
    // swirl should still come through because vibrato is still active
    CHECK(snap.vibratoSwirlEnabled, "swirl unaffected by scratchActive");
}

static void test06_videoFlagsRespected() {
    std::cout << "\n[06] video.*Enabled flags must be true for each side independently\n";
    auto m = makeFullyEnabledModulation();
    m.video.vibratoSwirlEnabled = false;
    m.video.scratchWaveEnabled  = true;
    auto t = makeActiveTiming();

    auto snap = buildClipCompanionFxSnapshot(m, t);

    CHECK(!snap.vibratoSwirlEnabled, "swirl off when video flag off");
    CHECK(snap.scratchWaveEnabled,   "wave still on when its flag is on");
}

static void test07_signedSwirlAmountAndLfo() {
    std::cout << "\n[07] signed swirlAmount and vibratoLfo propagate verbatim\n";
    auto m = makeFullyEnabledModulation();
    m.video.swirlAmount = -0.25f;
    auto t = makeActiveTiming();
    t.vibratoLfo = -0.42f;

    auto snap = buildClipCompanionFxSnapshot(m, t);

    CHECK(snap.vibratoSwirlEnabled, "swirl enabled");
    CHECK_NEAR(snap.swirlAmount, -0.25f, 1e-6, "negative swirlAmount preserved");
    CHECK_NEAR(snap.vibratoLfo,  -0.42f, 1e-6, "negative vibratoLfo preserved");
}

static void test08_signedWaveAndSmearAndRate() {
    std::cout << "\n[08] signed waveAmount/smearAmount and negative rate propagate\n";
    auto m = makeFullyEnabledModulation();
    m.video.waveAmount  = -0.1f;
    m.video.smearAmount = -0.2f;
    auto t = makeActiveTiming();
    t.scratchRateMultiplier = -1.0f; // reverse playback

    auto snap = buildClipCompanionFxSnapshot(m, t);

    CHECK(snap.scratchWaveEnabled, "wave enabled");
    CHECK_NEAR(snap.waveAmount,  -0.1f, 1e-6, "negative waveAmount preserved");
    CHECK_NEAR(snap.smearAmount, -0.2f, 1e-6, "negative smearAmount preserved");
    CHECK_NEAR(snap.scratchRateMultiplier, -1.0f, 1e-6, "negative rate preserved");
    CHECK(snap.reverseWaveWithScratch, "reverseWaveWithScratch flag preserved");
}

static void test09_zeroAmountsStayZero() {
    std::cout << "\n[09] amount=0 propagates as 0 (downstream identity behaviour)\n";
    auto m = makeFullyEnabledModulation();
    m.video.swirlAmount = 0.0f;
    m.video.waveAmount  = 0.0f;
    m.video.smearAmount = 0.0f;
    auto t = makeActiveTiming();

    auto snap = buildClipCompanionFxSnapshot(m, t);

    CHECK(snap.vibratoSwirlEnabled, "swirl enabled even at amount=0");
    CHECK(snap.scratchWaveEnabled,  "wave enabled even at amount=0");
    CHECK_NEAR(snap.swirlAmount, 0.0f, 1e-9, "swirlAmount==0");
    CHECK_NEAR(snap.waveAmount,  0.0f, 1e-9, "waveAmount==0");
    CHECK_NEAR(snap.smearAmount, 0.0f, 1e-9, "smearAmount==0");
}

static void test10_reverseFlagFalseAlsoPropagates() {
    std::cout << "\n[10] reverseWaveWithScratch=false propagates\n";
    auto m = makeFullyEnabledModulation();
    m.video.reverseWaveWithScratch = false;
    auto t = makeActiveTiming();

    auto snap = buildClipCompanionFxSnapshot(m, t);

    CHECK(snap.scratchWaveEnabled, "wave enabled");
    CHECK(!snap.reverseWaveWithScratch, "reverseWaveWithScratch=false preserved");
}

int main() {
    std::cout << "test_clip_companion_fx_builder — Phase E.3\n";

    test01_timingInactiveReturnsDefault();
    test02_swirlPopulatesWhenAllActive();
    test03_waveSmearPopulatesWhenAllActive();
    test04_swirlGatedByVibratoActive();
    test05_waveGatedByScratchActive();
    test06_videoFlagsRespected();
    test07_signedSwirlAmountAndLfo();
    test08_signedWaveAndSmearAndRate();
    test09_zeroAmountsStayZero();
    test10_reverseFlagFalseAlsoPropagates();

    std::cout << "\nPassed: " << g_passed << "  Failed: " << g_failed << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    return 1;
}
