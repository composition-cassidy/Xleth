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
#include "render/RenderClock.h"
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

// CellAnimation runs off an ABSOLUTE transport cursor, not accumulated deltas
// (that is what makes live preview and offline export agree). Step the cursor
// forward from wherever the animation currently is.
void runTo(CellAnimation& a, float totalMs, float stepMs = 5.0f) {
    const double target = a.curNowMs + static_cast<double>(totalMs);
    while (a.curNowMs + 1e-9 < target) {
        const double next = a.curNowMs + static_cast<double>(stepMs);
        a.advance(next < target ? next : target);
    }
}

// ---------------------------------------------------------------------------

void test_zpr_latches_at_target() {
    std::cout << "[1] ZPR slide latches its delta at target\n";
    AnimationManager mgr;
    auto cfg = makeZprSlide(1.0f, 1.5f,
                            SlideNoteEffectSettings::ReturnStyle::Instant,
                            SlideNoteEffectSettings::ReturnTrigger::NextNormalNote);
    mgr.onSlideEvent(7, cfg.fixedDurationMs, cfg, 0.5f, 0.5f);
    const CellAnimation* aConst = mgr.getAnimation(7);
    CHECK(aConst != nullptr, "anim exists for trackId=7");
    if (!aConst) return;

    auto* a = const_cast<CellAnimation*>(aConst);
    CHECK(!a->slideZprLatched, "not latched mid-animation");
    CHECK(!a->zprActive, "the slide never touches the note channel");

    runTo(*a, 150.0f);
    CHECK(!a->slideZprActive, "slide animation finished");
    CHECK(a->slideZprLatched, "latched at target after duration");
    CHECK_NEAR(a->slideDeltaZoom, 1.5, kEps, "delta held at slide target");
    CHECK_NEAR(a->currentZoom, 1.5, kEps,
               "composited output == delta alone when no note ZPR is running");
}

void test_slide_delta_composes_with_note_zpr() {
    std::cout << "[1b] Slide delta amplifies a live note ZPR instead of replacing it\n";
    CellAnimation a;
    a.trackId = 60;

    // Note ZPR: a constant 2.00x / panX +0.10 / rot 30deg pose, so the note
    // channel's contribution is unambiguous at every t.
    ZoomPanRotSettings noteZpr;
    noteZpr.enabled       = true;
    noteZpr.startZoom     = 2.0f;   noteZpr.targetZoom     = 2.0f;
    noteZpr.startPanX     = 0.10f;  noteZpr.targetPanX     = 0.10f;
    noteZpr.startRotation = 30.0f;  noteZpr.targetRotation = 30.0f;
    noteZpr.durationMs    = 400.0f;
    noteZpr.lengthMode    = ZoomPanRotSettings::LengthMode::Fixed;
    noteZpr.zoomEasing = noteZpr.panEasing = noteZpr.rotEasing = 0;
    buildZprTracks(noteZpr.tracks, noteZpr);
    BounceSettings noBounce;
    a.triggerNote(1, noteZpr, noBounce, a.curNowMs);
    CHECK_NEAR(a.currentZoom, 2.0, kEps, "note pose alone before the slide");

    // Slide delta: 1.00x -> 1.50x, panX 0 -> 0.20, rotation 0 -> 15deg.
    auto cfg = makeZprSlide(1.0f, 1.5f,
                            SlideNoteEffectSettings::ReturnStyle::SmoothReverse,
                            SlideNoteEffectSettings::ReturnTrigger::NextNormalNote,
                            /*returnMs=*/100.0f);
    cfg.zoomPanRot.targetPanX     = 0.20f;
    cfg.zoomPanRot.targetRotation = 15.0f;
    a.triggerSlide(cfg.fixedDurationMs, cfg, 0.5f, 0.5f, a.curNowMs);

    // At the slide's t=0 the delta is the identity, so the cell must look
    // EXACTLY as it did before the slide fired — no jump.
    CHECK_NEAR(a.currentZoom,   2.0,  kEps, "t=0 delta is identity: zoom unchanged");
    CHECK_NEAR(a.currentPanX,   0.10, kEps, "t=0 delta is identity: pan unchanged");
    CHECK_NEAR(a.currentRotDeg, 30.0, kEps, "t=0 delta is identity: rotation unchanged");

    runTo(a, 150.0f);
    CHECK(a.slideZprLatched, "slide delta latched");
    CHECK(a.zprActive, "note ZPR still running underneath the latched slide");
    CHECK_NEAR(a.currentZoom,   3.0,  kEps, "zoom MULTIPLIES: 2.00x * 1.50x");
    CHECK_NEAR(a.currentPanX,   0.30, kEps, "pan ADDS: 0.10 + 0.20");
    CHECK_NEAR(a.currentRotDeg, 45.0, kEps, "rotation ADDS: 30 + 15");

    // A subtractive slide reads as "less than what is already happening".
    auto shrink = makeZprSlide(1.0f, 0.5f,
                               SlideNoteEffectSettings::ReturnStyle::Instant,
                               SlideNoteEffectSettings::ReturnTrigger::NextNormalNote);
    a.triggerSlide(shrink.fixedDurationMs, shrink, 0.5f, 0.5f, a.curNowMs);
    runTo(a, 150.0f);
    CHECK_NEAR(a.currentZoom, 1.0, kEps, "0.50x delta halves the note's 2.00x");

    // ...and returning drops the delta out entirely, leaving the note pose.
    a.runReturnNow(a.curNowMs);
    CHECK_NEAR(a.currentZoom,   2.0,  kEps, "return restores the note pose, not identity");
    CHECK_NEAR(a.currentPanX,   0.10, kEps, "note pan survived the whole slide cycle");
    CHECK_NEAR(a.currentRotDeg, 30.0, kEps, "note rotation survived the whole slide cycle");
}

void test_pan_only_curves_survive_trigger() {
    std::cout << "[1c] Pan-only authored curves are not thrown away at trigger time\n";

    // The keyframe editor writes keys ONLY to the channels a gesture moved, so
    // a pan drag leaves zoomLog2 with zero keys. Gating the "are these authored
    // curves?" test on zoom alone read that as "nothing authored" and rebuilt
    // the animation from the (identity) scalars — the authored pan silently
    // vanished on playback while still showing in the editor.
    ZprTracks panOnly;
    panOnly.authored = true;
    { paramtrack::Keyframe k; k.t = 0.0; k.value = 0.0; panOnly.panX.keys.push_back(k); }
    { paramtrack::Keyframe k; k.t = 1.0; k.value = 0.4; panOnly.panX.keys.push_back(k); }
    CHECK(!panOnly.zoomLog2.animated(), "zoomLog2 deliberately carries no keys");
    CHECK(zprTracksAnimated(panOnly), "ANY-channel test sees the pan curve");

    // Slide layer.
    {
        CellAnimation a;
        a.trackId = 80;
        auto cfg = makeZprSlide(1.0f, 1.0f,
                                SlideNoteEffectSettings::ReturnStyle::Instant,
                                SlideNoteEffectSettings::ReturnTrigger::NextNormalNote);
        cfg.zoomPanRot.tracks = panOnly;
        a.triggerSlide(cfg.fixedDurationMs, cfg, 0.5f, 0.5f, a.curNowMs);
        runTo(a, 150.0f);
        CHECK_NEAR(a.slideDeltaPanX, 0.4, kEps, "slide played the authored pan curve");
        CHECK_NEAR(a.slideDeltaZoom, 1.0, kEps, "unkeyed zoom channel stays at identity");
    }

    // Note layer — same gate, same bug, same fix.
    {
        CellAnimation a;
        a.trackId = 81;
        ZoomPanRotSettings z;
        z.enabled    = true;
        z.lengthMode = ZoomPanRotSettings::LengthMode::Fixed;
        z.durationMs = 100.0f;
        z.tracks     = panOnly;
        BounceSettings noBounce;
        a.triggerNote(1, z, noBounce, a.curNowMs);
        runTo(a, 150.0f);
        CHECK_NEAR(a.zprNotePanX, 0.4, kEps, "note played the authored pan curve");
        CHECK_NEAR(a.zprNoteZoom, 1.0, kEps, "unkeyed zoom channel stays at identity");
    }
}

void test_instant_return_to_base() {
    std::cout << "[2] Instant return drops the delta, leaving the note pose\n";
    CellAnimation a;
    a.trackId = 1;

    // Note pose stands in for "whatever the cell was already doing".
    a.zprNotePanX   = 0.05f;
    a.zprNotePanY   = -0.03f;
    a.zprNoteZoom   = 1.2f;
    a.zprNoteRotDeg = 4.0f;

    auto cfg = makeZprSlide(1.0f, 1.6f,
                            SlideNoteEffectSettings::ReturnStyle::Instant,
                            SlideNoteEffectSettings::ReturnTrigger::NextNormalNote);
    a.triggerSlide(cfg.fixedDurationMs, cfg, 0.5f, 0.5f, a.curNowMs);

    CHECK_NEAR(a.slideDeltaZoom,   1.0, kEps, "delta starts at identity zoom");
    CHECK_NEAR(a.slideDeltaPanX,   0.0, kEps, "delta starts at identity panX");
    CHECK_NEAR(a.slideDeltaRotDeg, 0.0, kEps, "delta starts at identity rotation");

    runTo(a, 150.0f);
    CHECK(a.slideZprLatched, "latched after slide");
    CHECK_NEAR(a.currentZoom, 1.2 * 1.6, kEps, "composite at target before return");

    a.runReturnNow(a.curNowMs);
    CHECK(!a.slideZprLatched, "latch cleared after Instant return");
    CHECK(!a.slideZprReturnActive, "no return animation kicked off");
    CHECK_NEAR(a.currentZoom,   1.2,   kEps, "zoom back to the note pose");
    CHECK_NEAR(a.currentPanX,   0.05,  kEps, "panX back to the note pose");
    CHECK_NEAR(a.currentPanY,  -0.03,  kEps, "panY back to the note pose");
    CHECK_NEAR(a.currentRotDeg, 4.0,   kEps, "rotation back to the note pose");
}

void test_smooth_reverse_animates() {
    std::cout << "[3] SmoothReverse animates the delta back to identity\n";
    CellAnimation a;
    a.trackId = 2;

    auto cfg = makeZprSlide(1.0f, 2.0f,
                            SlideNoteEffectSettings::ReturnStyle::SmoothReverse,
                            SlideNoteEffectSettings::ReturnTrigger::NextNormalNote,
                            /*returnMs=*/100.0f);
    a.triggerSlide(cfg.fixedDurationMs, cfg, 0.5f, 0.5f, a.curNowMs);
    runTo(a, 150.0f);
    CHECK_NEAR(a.slideDeltaZoom, 2.0, kEps, "delta at target");
    CHECK(a.slideZprLatched, "latched");

    a.runReturnNow(a.curNowMs);
    CHECK(a.slideZprReturnActive, "SmoothReverse return started");

    runTo(a, 50.0f, 1.0f);
    CHECK(a.slideDeltaZoom > 1.0 + kEps, "delta moving back from target");
    CHECK(a.slideDeltaZoom < 2.0 - kEps, "delta not yet at identity");

    runTo(a, 60.0f, 1.0f);
    CHECK(!a.slideZprReturnActive, "return finished");
    CHECK(!a.slideZprLatched, "latch cleared after return");
    CHECK_NEAR(a.slideDeltaZoom, 1.0, kEps, "delta back at identity");
}

void test_tv_ramps_up_and_returns() {
    std::cout << "[4] TV slide ramps UP 0 -> peak, latches, returns\n";
    CellAnimation a;
    a.trackId = 3;

    auto cfg = makeTvSlide(0.8f,
                           SlideNoteEffectSettings::ReturnStyle::SmoothReverse,
                           SlideNoteEffectSettings::ReturnTrigger::NextNormalNote,
                           /*returnMs=*/50.0f);
    a.triggerSlide(cfg.fixedDurationMs, cfg, 0.5f, 0.5f, a.curNowMs);

    CHECK_NEAR(a.tvRampIntensity, 0.0, kEps, "TV intensity starts at 0 (ramp UP)");
    CHECK(a.tvRampActive, "TV ramp active");

    runTo(a, 50.0f, 1.0f);
    CHECK(a.tvRampIntensity > 0.3, "TV intensity climbing toward peak");
    CHECK(a.tvRampIntensity < 0.5, "TV intensity not yet at peak");

    runTo(a, 60.0f, 1.0f);
    CHECK(!a.tvRampActive, "TV ramp finished");
    CHECK(a.tvSlideLatched, "TV latched at peak");
    CHECK_NEAR(a.tvRampIntensity, 0.8, kEps, "TV held at peak");

    a.runReturnNow(a.curNowMs);
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
    CHECK(anim->slideZprLatched, "slide 1 latched at target");
    CHECK_NEAR(anim->slideDeltaZoom, 1.4, kEps, "at slide 1 target");

    // Slide 2 must be CONSUMED — Instant snap to identity, no new slide.
    mgr.onSlideEvent(11, cfg.fixedDurationMs, cfg, 0.5f, 0.5f);
    CHECK(!anim->slideZprLatched, "slide 2 cleared the latch");
    CHECK(!anim->slideZprActive, "slide 2 did NOT trigger a new slide animation");
    CHECK_NEAR(anim->slideDeltaZoom, 1.0, kEps, "delta snapped back to identity");

    // Slide 3 should now trigger a fresh slide.
    mgr.onSlideEvent(11, cfg.fixedDurationMs, cfg, 0.5f, 0.5f);
    CHECK(anim->slideZprActive, "slide 3 triggered fresh slide (latch was clear)");
    runTo(*anim, 150.0f);
    CHECK(anim->slideZprLatched, "slide 3 re-latched at target");
    CHECK_NEAR(anim->slideDeltaZoom, 1.4, kEps, "back at target");
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
    CHECK(anim->slideZprLatched, "latched");

    mgr.onSlideReturnTrigger(20);
    CHECK(anim->slideZprLatched, "latch survives normal-note trigger under NextSlideNote");
    CHECK(!anim->slideZprReturnActive, "no return started");
    CHECK_NEAR(anim->slideDeltaZoom, 1.5, kEps, "still at target");
}

void test_next_normal_note_chain_restarts_delta() {
    std::cout << "[7] NextNormalNote chain-while-latched restarts the delta layer\n";
    AnimationManager mgr;
    auto cfg1 = makeZprSlide(1.0f, 1.5f,
                             SlideNoteEffectSettings::ReturnStyle::SmoothReverse,
                             SlideNoteEffectSettings::ReturnTrigger::NextNormalNote);
    auto cfg2 = makeZprSlide(1.0f, 1.8f,
                             SlideNoteEffectSettings::ReturnStyle::SmoothReverse,
                             SlideNoteEffectSettings::ReturnTrigger::NextNormalNote);

    mgr.onSlideEvent(30, cfg1.fixedDurationMs, cfg1, 0.5f, 0.5f);
    auto* anim = const_cast<CellAnimation*>(mgr.getAnimation(30));
    CHECK(anim != nullptr, "anim exists");
    if (!anim) return;
    runTo(*anim, 150.0f);
    CHECK(anim->slideZprLatched, "latched after slide 1");

    // Slide 2 in NextNormalNote mode while latched -> chain. The delta layer
    // restarts from ITS OWN identity, so a chain cannot accumulate drift the
    // way a captured baseline could.
    mgr.onSlideEvent(30, cfg2.fixedDurationMs, cfg2, 0.5f, 0.5f);
    CHECK(anim->slideZprActive, "slide 2 chained (new slide started)");
    CHECK(!anim->slideZprLatched, "slide 2 cleared the previous latch");
    CHECK_NEAR(anim->slideDeltaZoom, 1.0, kEps, "chained slide restarts at identity");
    runTo(*anim, 150.0f);
    CHECK_NEAR(anim->slideDeltaZoom, 1.8, kEps, "chained slide reaches its own target");
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
    CHECK(anim->slideZprLatched, "latched");

    mgr.resetAll();
    CHECK(!anim->slideZprLatched, "ZPR latch cleared by resetAll");
    CHECK(!anim->slideZprReturnActive, "ZPR return cleared by resetAll");
    CHECK(!anim->tvSlideLatched, "TV latch cleared by resetAll");
    CHECK(!anim->tvReturnActive, "TV return cleared by resetAll");
    CHECK_NEAR(anim->slideDeltaZoom, 1.0, kEps, "delta reset to identity");
    CHECK_NEAR(anim->currentZoom, 1.0, kEps, "currentZoom reset to identity");
}

void test_note_zpr_leaves_slide_return_alone() {
    std::cout << "[9] A note ZPR does NOT cancel an in-flight slide return\n";
    CellAnimation a;
    a.trackId = 50;

    auto cfg = makeZprSlide(1.0f, 1.5f,
                            SlideNoteEffectSettings::ReturnStyle::SmoothReverse,
                            SlideNoteEffectSettings::ReturnTrigger::NextNormalNote,
                            200.0f);
    a.triggerSlide(cfg.fixedDurationMs, cfg, 0.5f, 0.5f, a.curNowMs);
    runTo(a, 150.0f);
    a.runReturnNow(a.curNowMs);
    CHECK(a.slideZprReturnActive, "return active");

    ZoomPanRotSettings noteZpr;
    noteZpr.enabled    = true;
    noteZpr.startZoom  = 0.9f;
    noteZpr.targetZoom = 1.3f;
    noteZpr.durationMs = 100.0f;
    noteZpr.lengthMode = ZoomPanRotSettings::LengthMode::Fixed;
    BounceSettings noBounce;
    a.triggerNote(123, noteZpr, noBounce, a.curNowMs);

    // The two layers are independent now: the note starts its own animation
    // while the slide keeps unwinding underneath it.
    CHECK(a.slideZprReturnActive, "slide return still running after the note trigger");
    CHECK(a.zprActive, "note-ZPR is now active");
    CHECK_NEAR(a.zprNoteZoom, 0.9, kEps, "note pose seeded from note-ZPR start");
    CHECK_NEAR(a.currentZoom, 0.9 * a.slideDeltaZoom, kEps,
               "composite is the note start times the still-unwinding delta");

    // Once the return completes the delta is gone and the note owns the cell.
    runTo(a, 250.0f, 1.0f);
    CHECK(!a.slideZprReturnActive, "slide return completed");
    CHECK_NEAR(a.slideDeltaZoom, 1.0, kEps, "delta unwound to identity");
    CHECK_NEAR(a.currentZoom, a.zprNoteZoom, kEps, "composite == note pose alone");
}

// ---------------------------------------------------------------------------
// Live-preview / offline-export parity for AUTHORED ZprTracks.
//
// The spatial viewport writes hand-authored keyframes (including overshoot
// bezier segments and rotations past a full turn) straight into ZprTracks.
// Both render paths consume them through the same two steps:
//
//   preview  (XlethEngineService video thread):
//       samplePos       = collectorProjectStartSample + videoFrameToSample(localFrame)
//       animMgr.advanceTo(1000 * samplePos / sampleRate)
//   export   (OfflineRenderer):
//       projectFrameSample = startSample + videoFrameToSample(localFrame)
//       animMgr.advanceTo(1000 * projectFrameSample / sampleRate)
//
// The two differ only in how the absolute frame is split between a start
// sample and a local frame index — the preview's stopped-render path carries
// the whole position in projectStartSample with localFrame 0, the export walks
// localFrame from 0 over a range. This pins that the split cannot change the
// answer, and that the authored curve survives both intact.
// ---------------------------------------------------------------------------

paramtrack::Keyframe kf(double t, double v,
                        double p1x = 1.0 / 3.0, double p1y = 1.0 / 3.0,
                        double p2x = 2.0 / 3.0, double p2y = 2.0 / 3.0) {
    paramtrack::Keyframe k;
    k.t = t; k.value = v;
    k.p1x = p1x; k.p1y = p1y; k.p2x = p2x; k.p2y = p2y;
    return k;
}

ZoomPanRotSettings makeAuthoredThreeKeyZpr() {
    ZoomPanRotSettings z;
    z.enabled    = true;
    z.durationMs = 500.0f;
    // Explicit Fixed: this test is about authored-curve preview/export parity
    // at a known 500ms window, independent of Musical/Note length resolution
    // (covered separately below). The struct default is Musical.
    z.lengthMode = ZoomPanRotSettings::LengthMode::Fixed;

    // Back-out overshoot on the first segment: p1y = (s + 3) / 3 > 1, which is
    // what makes the interpolated value leave the [from, to] interval.
    const double backOutP1y = (1.70158 + 3.0) / 3.0;

    z.tracks.panX.keys = { kf(0.0, 0.0, 1.0 / 3.0, backOutP1y, 2.0 / 3.0, 1.0),
                           kf(0.5, -0.25),
                           kf(1.0, 0.10) };
    z.tracks.panY.keys = { kf(0.0, 0.0), kf(0.5, 0.18), kf(1.0, -0.05) };
    z.tracks.zoomLog2.keys = { kf(0.0, 0.0, 1.0 / 3.0, backOutP1y, 2.0 / 3.0, 1.0),
                               kf(0.5, 1.0),
                               kf(1.0, 0.5) };
    // Rotation past a full turn — must travel +400 then -20, never wrap.
    z.tracks.rotationDeg.keys = { kf(0.0, 0.0), kf(0.5, 400.0), kf(1.0, 380.0) };
    z.tracks.authored = true;
    return z;
}

void test_authored_tracks_preview_export_parity() {
    std::cout << "[10] Authored 3-keyframe ZPR: live preview == offline export\n";

    const ZoomPanRotSettings z = makeAuthoredThreeKeyZpr();
    const int        sampleRate = 48000;
    const AVRational fps        = { 30, 1 };
    // Export renders a range that does not start at frame 0 — the case where a
    // start-sample offset could diverge from the preview's whole-position form.
    const int64_t    rangeStartFrame = 37;
    const int64_t    startSample =
        RenderClock::videoFrameToSample(rangeStartFrame, sampleRate, fps);

    AnimationManager preview, exporter;
    BounceSettings noBounce;

    // Both trigger the note at the same absolute project time.
    preview.advanceTo(1000.0 * static_cast<double>(startSample) / sampleRate);
    exporter.advanceTo(1000.0 * static_cast<double>(startSample) / sampleRate);
    preview.onNoteStart(/*trackId*/ 7, /*noteId*/ 1, z, noBounce);
    exporter.onNoteStart(/*trackId*/ 7, /*noteId*/ 1, z, noBounce);

    bool sawOvershoot = false;
    bool sawBeyond360 = false;
    int  compared     = 0;

    // 500 ms at 30 fps is 15 frames; walk a little past the end so the hold
    // behaviour is compared too.
    for (int64_t local = 0; local <= 20; ++local) {
        const int64_t localSample = RenderClock::videoFrameToSample(local, sampleRate, fps);

        // Export: range start + local frame.
        const int64_t exportSample = startSample + localSample;
        // Preview: the whole absolute position in projectStartSample, local frame 0.
        const int64_t previewSample =
            (startSample + localSample) + RenderClock::videoFrameToSample(0, sampleRate, fps);
        CHECK(previewSample == exportSample, "frame->sample split agrees");

        preview.advanceTo(1000.0 * static_cast<double>(previewSample) / sampleRate);
        exporter.advanceTo(1000.0 * static_cast<double>(exportSample) / sampleRate);

        const CellAnimation* p = preview.getAnimation(7);
        const CellAnimation* e = exporter.getAnimation(7);
        CHECK(p != nullptr && e != nullptr, "both paths have an animation");
        if (!p || !e) return;

        // Bit-identical, not merely close: the same evaluator on the same
        // absolute time base has no licence to differ at all.
        CHECK(p->currentZoom   == e->currentZoom,   "zoom parity");
        CHECK(p->currentPanX   == e->currentPanX,   "panX parity");
        CHECK(p->currentPanY   == e->currentPanY,   "panY parity");
        CHECK(p->currentRotDeg == e->currentRotDeg, "rotation parity");
        ++compared;

        // The overshoot has to be REAL in both, not clamped away: zoomLog2 runs
        // 0 -> 1 on the first segment, so a linear read can never exceed 2.0x.
        if (p->currentZoom > 2.0f + 1e-4f) sawOvershoot = true;
        if (p->currentRotDeg > 360.0f)     sawBeyond360 = true;
    }

    CHECK(compared == 21, "compared every frame in the window");
    CHECK(sawOvershoot, "back-out segment overshot past the 2.0x target");
    CHECK(sawBeyond360, "rotation travelled past 360 without wrapping");

    // Final pose holds the last keyframe, unwrapped.
    const CellAnimation* p = preview.getAnimation(7);
    CHECK_NEAR(p->currentRotDeg, 380.0, kEps, "holds 380deg, not 20deg");
}

// ---------------------------------------------------------------------------
// On-end / retrigger policies + Note length mode.
// ---------------------------------------------------------------------------

void test_reverseInto_matches_bezier_reversal_identity() {
    std::cout << "[11] paramtrack::reverseInto: forward(0.3) == reverse(0.7) for an asymmetric curve\n";
    paramtrack::ParamTrack track;
    // Asymmetric curve, nowhere near identity-in-x or identity-in-y — exercises
    // the full Newton-Raphson solve on both sides, not just the fast path.
    track.keys = { kf(0.0, 10.0, 0.1, 0.9, 0.9, 0.2),
                  kf(1.0, 50.0) };

    paramtrack::ParamTrack reversed;
    paramtrack::reverseInto(reversed, track);

    CHECK_NEAR(paramtrack::evaluate(track, 0.3), paramtrack::evaluate(reversed, 0.7), 1e-6,
               "forward eval at t=0.3 equals reverse eval at t=0.7");
    // A second, off-midpoint point so a bug that only cancels at one t can't
    // slip through.
    CHECK_NEAR(paramtrack::evaluate(track, 0.65), paramtrack::evaluate(reversed, 0.35), 1e-6,
               "forward eval at t=0.65 equals reverse eval at t=0.35");
}

void test_onend_reset_snaps_to_identity() {
    std::cout << "[12] On-end: Reset snaps to identity when the window elapses\n";
    CellAnimation a;
    a.trackId = 60;

    ZoomPanRotSettings z;
    z.enabled     = true;
    z.lengthMode  = ZoomPanRotSettings::LengthMode::Fixed;
    z.durationMs  = 100.0f;
    z.onEndMode   = ZoomPanRotSettings::OnEndMode::Reset;
    z.startZoom   = 1.0f; z.targetZoom = 2.0f;
    z.startPanX   = 0.0f; z.targetPanX = 0.3f;
    z.zoomEasing = 0; z.panEasing = 0; z.rotEasing = 0;
    BounceSettings noBounce;

    a.triggerNote(1, z, noBounce, 0.0);
    runTo(a, 50.0f, 5.0f);
    CHECK(a.zprActive, "still active mid-window");
    CHECK(a.currentZoom > 1.0f + static_cast<float>(kEps), "zoom moved off identity mid-window");

    runTo(a, 60.0f, 5.0f);  // past the 100ms window
    CHECK(!a.zprActive, "window finished");
    CHECK_NEAR(a.currentZoom, 1.0, kEps, "Reset snapped zoom back to identity");
    CHECK_NEAR(a.currentPanX, 0.0, kEps, "Reset snapped panX back to identity");
    CHECK_NEAR(a.currentRotDeg, 0.0, kEps, "Reset snapped rotation back to identity");
    CHECK(!a.zprReturnActive, "the absorbed return resolves instantly within the same advance()");
}

void test_onend_loop_wraps_without_smoothing() {
    std::cout << "[13] On-end: Loop restarts from t=0 every window, no seam smoothing\n";
    CellAnimation a;
    a.trackId = 61;

    ZoomPanRotSettings z;
    z.enabled     = true;
    z.lengthMode  = ZoomPanRotSettings::LengthMode::Fixed;
    z.durationMs  = 100.0f;
    z.onEndMode   = ZoomPanRotSettings::OnEndMode::Loop;
    z.startZoom   = 1.0f; z.targetZoom = 4.0f;  // last != first -> a real pop, by design
    z.zoomEasing = 0; z.panEasing = 0; z.rotEasing = 0;
    BounceSettings noBounce;

    a.triggerNote(1, z, noBounce, 0.0);
    runTo(a, 99.0f, 3.0f);   // curNowMs == 99 (33 steps of 3ms)
    CHECK(a.zprActive, "Loop never deactivates zprActive");
    CHECK_NEAR(a.currentZoom, std::pow(2.0, 0.99 * 2.0), 0.02,
               "near the end of the first cycle (t=0.99)");

    runTo(a, 3.0f, 3.0f);    // curNowMs == 102 -> wrapped into a fresh cycle at t=0.02
    CHECK(a.zprActive, "still active after wrap");
    CHECK_NEAR(a.currentZoom, std::pow(2.0, 0.02 * 2.0), 0.02,
               "wrapped straight back to a fresh cycle's t=0.02 — the pop is real, not smoothed");
}

void test_onend_pingpong_forward_then_backward() {
    std::cout << "[14] On-end: Ping-pong's backward leg reverses each segment's easing correctly\n";
    CellAnimation a;
    a.trackId = 62;

    ZoomPanRotSettings z;
    z.enabled     = true;
    z.lengthMode  = ZoomPanRotSettings::LengthMode::Fixed;
    z.durationMs  = 100.0f;
    z.onEndMode   = ZoomPanRotSettings::OnEndMode::PingPong;
    z.startZoom   = 1.0f; z.targetZoom = 4.0f;  // asymmetric easing exercises the reversal for real
    z.zoomEasing = 1;   // EaseOut
    z.panEasing = 0; z.rotEasing = 0;
    BounceSettings noBounce;

    a.triggerNote(1, z, noBounce, 0.0);

    runTo(a, 30.0f, 5.0f);   // elapsed 30ms = forward leg, t=0.3
    CHECK(!a.zprPingPongReversed, "still on the forward leg");
    const float forwardAt03 = a.currentZoom;

    runTo(a, 140.0f, 5.0f);  // elapsed 170ms = backward leg, t=0.7
    CHECK(a.zprPingPongReversed, "now on the backward leg");
    CHECK_NEAR(a.currentZoom, forwardAt03, 1e-3,
               "backward leg at t=0.7 matches forward leg at t=0.3 (bezier-reversal identity)");

    // Boundary continuity at the 100ms seam: ping-pong never pops (only Loop does).
    CellAnimation b;
    b.trackId = 63;
    b.triggerNote(1, z, noBounce, 0.0);
    b.advance(99.999);
    const float justBefore = b.currentZoom;
    b.advance(100.001);
    const float justAfter = b.currentZoom;
    CHECK_NEAR(justBefore, justAfter, 0.02f, "no pop across the ping-pong forward/backward seam");
}

void test_retrigger_ignore_drops_new_trigger() {
    std::cout << "[15] Retrigger: Ignore drops a new trigger while the window is in flight\n";
    CellAnimation a;
    a.trackId = 64;

    ZoomPanRotSettings z;
    z.enabled       = true;
    z.lengthMode    = ZoomPanRotSettings::LengthMode::Fixed;
    z.durationMs    = 200.0f;
    z.retriggerMode = ZoomPanRotSettings::RetriggerMode::Ignore;
    z.startZoom = 1.0f; z.targetZoom = 2.0f;
    z.zoomEasing = 0; z.panEasing = 0; z.rotEasing = 0;
    BounceSettings noBounce;

    a.triggerNote(1, z, noBounce, 0.0);
    runTo(a, 50.0f, 5.0f);
    const float midValue = a.currentZoom;
    const double midT = a.curNowMs;

    ZoomPanRotSettings z2 = z;
    z2.startZoom = 3.0f; z2.targetZoom = 5.0f;  // different target — must have zero effect
    a.triggerNote(2, z2, noBounce, midT);

    CHECK(a.activeNoteId == 2, "activeNoteId still tracks the note so onset-detection stops re-firing");
    CHECK_NEAR(a.currentZoom, midValue, 1e-4, "ignored retrigger left the animation untouched");
    CHECK(!a.zprCrossfadeActive, "no crossfade snapshot for an ignored retrigger");

    runTo(a, 5.0f, 5.0f);
    CHECK(a.currentZoom > midValue, "the ORIGINAL animation (note 1's 2x target) kept advancing");
}

void test_retrigger_crossfade_blends_canonical_space() {
    std::cout << "[16] Retrigger: Crossfade blends outgoing->incoming in canonical space over N ms\n";
    CellAnimation a;
    a.trackId = 65;

    ZoomPanRotSettings z1;
    z1.enabled            = true;
    z1.lengthMode         = ZoomPanRotSettings::LengthMode::Fixed;
    z1.durationMs         = 1000.0f;  // long, so it's clearly still in flight at retrigger time
    z1.retriggerMode      = ZoomPanRotSettings::RetriggerMode::Crossfade;
    z1.retriggerCrossfadeMs = 100.0f;
    z1.startZoom = 1.0f; z1.targetZoom = 2.0f;
    z1.zoomEasing = 0; z1.panEasing = 0; z1.rotEasing = 0;
    BounceSettings noBounce;

    a.triggerNote(1, z1, noBounce, 0.0);
    runTo(a, 500.0f, 5.0f);   // halfway through note 1's window
    const float outgoingZoom = a.currentZoom;
    CHECK_NEAR(outgoingZoom, std::pow(2.0, 0.5), 1e-3, "sanity: outgoing animation at its own t=0.5");

    ZoomPanRotSettings z2 = z1;
    z2.startZoom = 8.0f; z2.targetZoom = 8.0f;  // constant — isolates the crossfade's own contribution
    a.triggerNote(2, z2, noBounce, a.curNowMs);

    CHECK(a.zprCrossfadeActive, "crossfade armed");
    CHECK_NEAR(a.currentZoom, 8.0, kEps,
               "triggerNote seeds current* from the incoming start; advance() blends from there");

    a.advance(a.curNowMs + 1.0);
    CHECK(std::fabs(a.currentZoom - outgoingZoom) < 0.1f,
          "just after retrigger (blend~0.01), value is still close to the outgoing snapshot");

    a.advance(a.curNowMs + 49.0);  // cumulative 50ms of the 100ms crossfade window
    const float expectedHalfway = outgoingZoom + (8.0f - outgoingZoom) * 0.5f;
    CHECK_NEAR(a.currentZoom, expectedHalfway, 0.05f,
               "halfway through the crossfade, blend=0.5 in canonical space");

    a.advance(a.curNowMs + 60.0);  // past the crossfade window
    CHECK(!a.zprCrossfadeActive, "crossfade finished");
    CHECK_NEAR(a.currentZoom, 8.0, kEps, "fully crossfaded to the incoming animation's own value");
}

void test_note_length_mode_uses_gate_and_falls_back() {
    std::cout << "[17] Note length mode: uses gate length when known, falls back to Musical otherwise\n";
    CellAnimation a;
    a.trackId = 66;

    ZoomPanRotSettings z;
    z.enabled         = true;
    z.lengthMode      = ZoomPanRotSettings::LengthMode::Note;
    z.notePercentage  = 50.0f;
    z.musicalDivision = 3;  // "1/4" — used only by the fallback path
    z.startZoom = 1.0f; z.targetZoom = 2.0f;
    z.zoomEasing = 0; z.panEasing = 0; z.rotEasing = 0;
    BounceSettings noBounce;

    // Gate length known: 400ms gate x 50% = 200ms window.
    a.triggerNote(1, z, noBounce, 0.0, /*bpm*/120.0, /*noteDurationMs*/400.0f);
    CHECK_NEAR(a.zprDurationMs, 200.0, 1e-3, "Note mode: gate length x percentage");

    // Gate length unknown (sentinel < 0): falls back to Musical at the same
    // bpm. musicalDivision=3 ("1/4") = 1 beat = 500ms at 120bpm.
    CellAnimation b;
    b.trackId = 67;
    b.triggerNote(1, z, noBounce, 0.0, /*bpm*/120.0, /*noteDurationMs*/-1.0f);
    CHECK_NEAR(b.zprDurationMs, 500.0, 1e-3,
               "Note mode falls back to the Musical-mode duration when gate length is unavailable");
}

void test_restart_retrigger_no_allocation_growth() {
    std::cout << "[18] Restart retrigger: no allocation growth under rapid re-triggering "
                 "(32nd notes @ 140 BPM proxy)\n";
    CellAnimation a;
    a.trackId = 70;

    ZoomPanRotSettings z;
    z.enabled       = true;
    z.lengthMode    = ZoomPanRotSettings::LengthMode::Fixed;
    z.durationMs    = 107.14f;   // ~ a 32nd note's own length at 140bpm
    z.retriggerMode = ZoomPanRotSettings::RetriggerMode::Restart;
    z.startZoom = 1.0f; z.targetZoom = 1.5f;
    BounceSettings noBounce;

    double t = 0.0;
    // Warm-up: the first few triggers may grow the tracks' vector capacity
    // from empty (buildZprTracks' first call per note-onset in real usage).
    for (int i = 0; i < 5; ++i) {
        a.triggerNote(i, z, noBounce, t);
        t += 10.0;
    }
    const size_t zoomCapBefore = a.zprTracks.zoomLog2.keys.capacity();
    const size_t panCapBefore  = a.zprTracks.panX.keys.capacity();

    // 2000 retriggers at the 32nd-note-@-140bpm period (~64.28ms) — well past
    // a 60s stress run's worth of onsets.
    for (int i = 0; i < 2000; ++i) {
        a.triggerNote(1000 + i, z, noBounce, t);
        t += 64.28;
    }

    CHECK(a.zprTracks.zoomLog2.keys.capacity() == zoomCapBefore,
          "zoomLog2 track capacity stable after warm-up — Restart never reallocates");
    CHECK(a.zprTracks.panX.keys.capacity() == panCapBefore,
          "panX track capacity stable after warm-up — Restart never reallocates");
}

}  // namespace

int main() {
    std::cout << "[TEST:AnimationManager] Starting slide return tests...\n\n";
    test_zpr_latches_at_target();
    test_slide_delta_composes_with_note_zpr();
    test_pan_only_curves_survive_trigger();
    test_instant_return_to_base();
    test_smooth_reverse_animates();
    test_tv_ramps_up_and_returns();
    test_next_slide_note_toggle_consumes();
    test_next_slide_note_ignores_normal_notes();
    test_next_normal_note_chain_restarts_delta();
    test_reset_clears_latch();
    test_note_zpr_leaves_slide_return_alone();
    test_authored_tracks_preview_export_parity();
    test_reverseInto_matches_bezier_reversal_identity();
    test_onend_reset_snaps_to_identity();
    test_onend_loop_wraps_without_smoothing();
    test_onend_pingpong_forward_then_backward();
    test_retrigger_ignore_drops_new_trigger();
    test_retrigger_crossfade_blends_canonical_space();
    test_note_length_mode_uses_gate_and_falls_back();
    test_restart_retrigger_no_allocation_growth();

    std::cout << "\n[TEST:AnimationManager] " << g_passed << " passed, "
              << g_failed << " failed.\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cout << "FAILED\n";
    return 1;
}
