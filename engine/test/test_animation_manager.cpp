// test_animation_manager.cpp — Verifies the slide visual return system in
// AnimationManager / CellAnimation.
//
// Covers:
//   * ZPR slide latches at target instead of getting stuck (the bug fix)
//   * Captured pre-slide baseline (current* != identity)
//   * Instant return snaps current* to base*
//   * SmoothReverse return animates current* -> base* over the configured ms
//   * TV slide ramps UP 0 -> peak (the deliberate behaviour change), latches,
//     and returns per policy
//   * NextSlideNote toggle/consume: a slide while latched returns and does NOT
//     trigger a new slide in the same event
//   * NextNormalNote chain-while-latched: a slide while latched chains into a
//     new slide and preserves the original baseline
//   * Baseline-not-refreshed-while-latched
//   * resetTrack/resetAll clear all latch + return fields
//
// Pure CPU — no GPU, decoder, or JUCE needed beyond what XlethEngineCore links.

#include "render/AnimationManager.h"
#include "model/TimelineTypes.h"

#include <cmath>
#include <cstdio>
#include <iostream>

namespace {

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                             \
    do {                                                             \
        if (cond) {                                                  \
            ++g_passed;                                              \
        } else {                                                     \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; \
            ++g_failed;                                              \
        }                                                            \
    } while (0)

#define CHECK_NEAR(a, b, tol, msg) \
    CHECK(std::fabs((double)(a) - (double)(b)) < (tol), msg)

constexpr double kEps = 1e-3;

SlideNoteEffectSettings makeZprSlide(float startZ, float targetZ,
                                     SlideNoteEffectSettings::ReturnStyle rs,
                                     SlideNoteEffectSettings::ReturnTrigger rt,
                                     float returnMs = 200.0f)
{
    SlideNoteEffectSettings cfg;
    cfg.type = SlideNoteEffectSettings::EffectType::ZoomPanRot;
    cfg.durationMode = SlideNoteEffectSettings::DurationMode::Fixed;
    cfg.fixedDurationMs = 100.0f;
    cfg.returnStyle = rs;
    cfg.returnTrigger = rt;
    cfg.returnDurationMs = returnMs;
    cfg.zoomPanRot.startZoom = startZ;
    cfg.zoomPanRot.targetZoom = targetZ;
    cfg.zoomPanRot.zoomEasing = 0;  // linear so timing math is exact
    cfg.zoomPanRot.panEasing  = 0;
    cfg.zoomPanRot.rotEasing  = 0;
    return cfg;
}

SlideNoteEffectSettings makeTvSlide(float peak,
                                    SlideNoteEffectSettings::ReturnStyle rs,
                                    SlideNoteEffectSettings::ReturnTrigger rt,
                                    float returnMs = 200.0f)
{
    SlideNoteEffectSettings cfg;
    cfg.type = SlideNoteEffectSettings::EffectType::TVSimulator;
    cfg.durationMode = SlideNoteEffectSettings::DurationMode::Fixed;
    cfg.fixedDurationMs = 100.0f;
    cfg.returnStyle = rs;
    cfg.returnTrigger = rt;
    cfg.returnDurationMs = returnMs;
    cfg.tv.intensity = peak;
    return cfg;
}

void runTo(CellAnimation& a, float totalMs, float stepMs = 5.0f) {
    float remaining = totalMs;
    while (remaining > 0.0f) {
        const float step = (stepMs < remaining) ? stepMs : remaining;
        a.advance(step);
        remaining -= step;
    }
}

// ---------------------------------------------------------------------------

void test_zpr_latches_at_target() {
    std::cout << "[1] ZPR slide latches at target (no longer permanently stuck)\n";
    AnimationManager mgr;
    auto cfg = makeZprSlide(1.0f, 1.5f,
                            SlideNoteEffectSettings::ReturnStyle::Instant,
                            SlideNoteEffectSettings::ReturnTrigger::NextNormalNote);
    mgr.onSlideEvent(7, cfg.fixedDurationMs, cfg, 0.5f, 0.5f);
    const CellAnimation* aConst = mgr.getAnimation(7);
    CHECK(aConst != nullptr, "anim exists for trackId=7");
    if (!aConst) return;

    auto* a = const_cast<CellAnimation*>(aConst);
    CHECK(!a->zprSlideLatched, "not latched mid-animation");

    runTo(*a, 150.0f);
    CHECK(!a->zprActive, "zpr animation finished");
    CHECK(a->zprSlideLatched, "latched at target after duration");
    CHECK_NEAR(a->currentZoom, 1.5, kEps, "currentZoom held at slide target");
}

void test_instant_return_to_base() {
    std::cout << "[2] Instant return snaps to captured baseline\n";
    CellAnimation a;
    a.trackId = 1;

    a.currentZoom   = 1.2f;
    a.currentPanX   = 0.05f;
    a.currentPanY   = -0.03f;
    a.currentRotDeg = 4.0f;

    auto cfg = makeZprSlide(1.0f, 1.6f,
                            SlideNoteEffectSettings::ReturnStyle::Instant,
                            SlideNoteEffectSettings::ReturnTrigger::NextNormalNote);
    a.triggerSlide(cfg.fixedDurationMs, cfg, 0.5f, 0.5f);

    CHECK_NEAR(a.zprBaseZoom,   1.2,   kEps, "baseline zoom captured (not identity)");
    CHECK_NEAR(a.zprBasePanX,   0.05,  kEps, "baseline panX captured");
    CHECK_NEAR(a.zprBasePanY,  -0.03,  kEps, "baseline panY captured");
    CHECK_NEAR(a.zprBaseRotDeg, 4.0,   kEps, "baseline rotation captured");

    runTo(a, 150.0f);
    CHECK(a.zprSlideLatched, "latched after slide");
    CHECK_NEAR(a.currentZoom, 1.6, kEps, "currentZoom at target before return");

    a.runReturnNow();
    CHECK(!a.zprSlideLatched, "latch cleared after Instant return");
    CHECK(!a.zprReturnActive, "no return animation kicked off");
    CHECK_NEAR(a.currentZoom,   1.2,   kEps, "currentZoom snapped to base");
    CHECK_NEAR(a.currentPanX,   0.05,  kEps, "currentPanX snapped to base");
    CHECK_NEAR(a.currentPanY,  -0.03,  kEps, "currentPanY snapped to base");
    CHECK_NEAR(a.currentRotDeg, 4.0,   kEps, "currentRotDeg snapped to base");
}

void test_smooth_reverse_animates() {
    std::cout << "[3] SmoothReverse animates current -> base\n";
    CellAnimation a;
    a.trackId = 2;
    a.currentZoom = 1.0f;

    auto cfg = makeZprSlide(1.0f, 2.0f,
                            SlideNoteEffectSettings::ReturnStyle::SmoothReverse,
                            SlideNoteEffectSettings::ReturnTrigger::NextNormalNote,
                            /*returnMs=*/100.0f);
    a.triggerSlide(cfg.fixedDurationMs, cfg, 0.5f, 0.5f);
    runTo(a, 150.0f);
    CHECK_NEAR(a.currentZoom, 2.0, kEps, "currentZoom at target");
    CHECK(a.zprSlideLatched, "latched");

    a.runReturnNow();
    CHECK(a.zprReturnActive, "SmoothReverse return started");

    runTo(a, 50.0f, 1.0f);
    CHECK(a.currentZoom > 1.0 + kEps, "currentZoom moving back from target");
    CHECK(a.currentZoom < 2.0 - kEps, "currentZoom not yet at base");

    runTo(a, 60.0f, 1.0f);
    CHECK(!a.zprReturnActive, "return finished");
    CHECK(!a.zprSlideLatched, "latch cleared after return");
    CHECK_NEAR(a.currentZoom, 1.0, kEps, "currentZoom at base");
}

void test_tv_ramps_up_and_returns() {
    std::cout << "[4] TV slide ramps UP 0 -> peak, latches, returns\n";
    CellAnimation a;
    a.trackId = 3;

    auto cfg = makeTvSlide(0.8f,
                           SlideNoteEffectSettings::ReturnStyle::SmoothReverse,
                           SlideNoteEffectSettings::ReturnTrigger::NextNormalNote,
                           /*returnMs=*/50.0f);
    a.triggerSlide(cfg.fixedDurationMs, cfg, 0.5f, 0.5f);

    CHECK_NEAR(a.tvRampIntensity, 0.0, kEps, "TV intensity starts at 0 (ramp UP)");
    CHECK(a.tvRampActive, "TV ramp active");

    runTo(a, 50.0f, 1.0f);
    CHECK(a.tvRampIntensity > 0.3, "TV intensity climbing toward peak");
    CHECK(a.tvRampIntensity < 0.5, "TV intensity not yet at peak");

    runTo(a, 60.0f, 1.0f);
    CHECK(!a.tvRampActive, "TV ramp finished");
    CHECK(a.tvSlideLatched, "TV latched at peak");
    CHECK_NEAR(a.tvRampIntensity, 0.8, kEps, "TV held at peak");

    a.runReturnNow();
    CHECK(a.tvReturnActive, "TV return active");
    runTo(a, 60.0f, 1.0f);
    CHECK(!a.tvReturnActive, "TV return finished");
    CHECK(!a.tvSlideLatched, "TV latch cleared");
    CHECK_NEAR(a.tvRampIntensity, 0.0, kEps, "TV intensity returned to 0");
}

void test_next_slide_note_toggle_consumes() {
    std::cout << "[5] NextSlideNote toggle: slide-while-latched is consumed as return\n";
    AnimationManager mgr;
    auto cfg = makeZprSlide(1.0f, 1.4f,
                            SlideNoteEffectSettings::ReturnStyle::Instant,
                            SlideNoteEffectSettings::ReturnTrigger::NextSlideNote);

    mgr.onSlideEvent(11, cfg.fixedDurationMs, cfg, 0.5f, 0.5f);
    auto* anim = const_cast<CellAnimation*>(mgr.getAnimation(11));
    CHECK(anim != nullptr, "anim exists");
    if (!anim) return;
    runTo(*anim, 150.0f);
    CHECK(anim->zprSlideLatched, "slide 1 latched at target");
    CHECK_NEAR(anim->currentZoom, 1.4, kEps, "at slide 1 target");

    // Slide 2 must be CONSUMED — Instant snap to base, no new slide animation.
    mgr.onSlideEvent(11, cfg.fixedDurationMs, cfg, 0.5f, 0.5f);
    CHECK(!anim->zprSlideLatched, "slide 2 cleared the latch");
    CHECK(!anim->zprActive, "slide 2 did NOT trigger a new slide animation");
    CHECK_NEAR(anim->currentZoom, 1.0, kEps, "currentZoom snapped back to base");

    // Slide 3 should now trigger a fresh slide.
    mgr.onSlideEvent(11, cfg.fixedDurationMs, cfg, 0.5f, 0.5f);
    CHECK(anim->zprActive, "slide 3 triggered fresh slide (latch was clear)");
    runTo(*anim, 150.0f);
    CHECK(anim->zprSlideLatched, "slide 3 re-latched at target");
    CHECK_NEAR(anim->currentZoom, 1.4, kEps, "back at target");
}

void test_next_slide_note_ignores_normal_notes() {
    std::cout << "[6] NextSlideNote ignores normal notes\n";
    AnimationManager mgr;
    auto cfg = makeZprSlide(1.0f, 1.5f,
                            SlideNoteEffectSettings::ReturnStyle::SmoothReverse,
                            SlideNoteEffectSettings::ReturnTrigger::NextSlideNote,
                            100.0f);
    mgr.onSlideEvent(20, cfg.fixedDurationMs, cfg, 0.5f, 0.5f);
    auto* anim = const_cast<CellAnimation*>(mgr.getAnimation(20));
    CHECK(anim != nullptr, "anim exists");
    if (!anim) return;
    runTo(*anim, 150.0f);
    CHECK(anim->zprSlideLatched, "latched");

    mgr.onSlideReturnTrigger(20);
    CHECK(anim->zprSlideLatched, "latch survives normal-note trigger under NextSlideNote");
    CHECK(!anim->zprReturnActive, "no return started");
    CHECK_NEAR(anim->currentZoom, 1.5, kEps, "still at target");
}

void test_next_normal_note_chain_preserves_baseline() {
    std::cout << "[7] NextNormalNote chain-while-latched preserves baseline\n";
    AnimationManager mgr;
    auto cfg1 = makeZprSlide(1.0f, 1.5f,
                             SlideNoteEffectSettings::ReturnStyle::SmoothReverse,
                             SlideNoteEffectSettings::ReturnTrigger::NextNormalNote);
    auto cfg2 = makeZprSlide(1.0f, 1.8f,
                             SlideNoteEffectSettings::ReturnStyle::SmoothReverse,
                             SlideNoteEffectSettings::ReturnTrigger::NextNormalNote);

    // Pre-slide pose 1.1 — captured by triggerSlide.
    mgr.onSlideEvent(30, cfg1.fixedDurationMs, cfg1, 0.5f, 0.5f);
    auto* anim = const_cast<CellAnimation*>(mgr.getAnimation(30));
    CHECK(anim != nullptr, "anim exists");
    if (!anim) return;
    // The first triggerSlide already captured 1.0 (the default current).
    // To exercise the "preserve baseline across chain" property, we manually
    // ensure the latch and then chain a second slide.
    runTo(*anim, 150.0f);
    CHECK(anim->zprSlideLatched, "latched after slide 1");
    const float base1 = anim->zprBaseZoom;

    // Slide 2 in NextNormalNote mode while latched -> chain.
    mgr.onSlideEvent(30, cfg2.fixedDurationMs, cfg2, 0.5f, 0.5f);
    CHECK(anim->zprActive, "slide 2 chained (new slide started)");
    CHECK_NEAR(anim->zprBaseZoom, base1, kEps,
               "baseline preserved across chained slide");
}

void test_reset_clears_latch() {
    std::cout << "[8] resetAll clears all latch + return state\n";
    AnimationManager mgr;
    auto cfg = makeZprSlide(1.0f, 1.5f,
                            SlideNoteEffectSettings::ReturnStyle::Instant,
                            SlideNoteEffectSettings::ReturnTrigger::NextNormalNote);
    mgr.onSlideEvent(40, cfg.fixedDurationMs, cfg, 0.5f, 0.5f);
    auto* anim = const_cast<CellAnimation*>(mgr.getAnimation(40));
    CHECK(anim != nullptr, "anim exists");
    if (!anim) return;
    runTo(*anim, 150.0f);
    CHECK(anim->zprSlideLatched, "latched");

    mgr.resetAll();
    CHECK(!anim->zprSlideLatched, "ZPR latch cleared by resetAll");
    CHECK(!anim->zprReturnActive, "ZPR return cleared by resetAll");
    CHECK(!anim->tvSlideLatched, "TV latch cleared by resetAll");
    CHECK(!anim->tvReturnActive, "TV return cleared by resetAll");
    CHECK_NEAR(anim->currentZoom, 1.0, kEps, "currentZoom reset to identity");
}

void test_normal_note_zpr_overrides_in_flight_return() {
    std::cout << "[9] Note-ZPR cancels in-flight SmoothReverse return\n";
    CellAnimation a;
    a.trackId = 50;
    a.currentZoom = 1.0f;

    auto cfg = makeZprSlide(1.0f, 1.5f,
                            SlideNoteEffectSettings::ReturnStyle::SmoothReverse,
                            SlideNoteEffectSettings::ReturnTrigger::NextNormalNote,
                            200.0f);
    a.triggerSlide(cfg.fixedDurationMs, cfg, 0.5f, 0.5f);
    runTo(a, 150.0f);
    a.runReturnNow();
    CHECK(a.zprReturnActive, "return active");

    ZoomPanRotSettings noteZpr;
    noteZpr.enabled    = true;
    noteZpr.startZoom  = 0.9f;
    noteZpr.targetZoom = 1.3f;
    noteZpr.durationMs = 100.0f;
    BounceSettings noBounce;
    a.triggerNote(123, noteZpr, noBounce);

    CHECK(!a.zprReturnActive, "return cancelled by note-ZPR");
    CHECK(!a.zprSlideLatched, "latch cleared");
    CHECK(a.zprActive, "note-ZPR is now active");
    CHECK_NEAR(a.currentZoom, 0.9, kEps, "currentZoom seeded from note-ZPR start");
}

}  // namespace

int main() {
    std::cout << "[TEST:AnimationManager] Starting slide return tests...\n\n";
    test_zpr_latches_at_target();
    test_instant_return_to_base();
    test_smooth_reverse_animates();
    test_tv_ramps_up_and_returns();
    test_next_slide_note_toggle_consumes();
    test_next_slide_note_ignores_normal_notes();
    test_next_normal_note_chain_preserves_baseline();
    test_reset_clears_latch();
    test_normal_note_zpr_overrides_in_flight_return();

    std::cout << "\n[TEST:AnimationManager] " << g_passed << " passed, "
              << g_failed << " failed.\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cout << "FAILED\n";
    return 1;
}
