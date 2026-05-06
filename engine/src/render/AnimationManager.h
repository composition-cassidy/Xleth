#pragma once

/**
 * AnimationManager — Per-track animation state for the visual compositor.
 *
 * Manages zoom/pan/rotation, bounce, and TV-ramp animations triggered by
 * note onsets and slide events. Updated once per frame before FrameCollector
 * reads the animation state into CellFrameRequests.
 *
 * Easing functions are free functions so the shader pipeline can also use them
 * in later prompts.
 */

#include <cmath>
#include <cstdio>
#include <unordered_map>

#include "../util/BezierEase.h"

// Forward declarations
struct ZoomPanRotSettings;
struct BounceSettings;
struct SlideNoteEffectSettings;

// ---------------------------------------------------------------------------
// Easing functions
// ---------------------------------------------------------------------------
float easeOutBack(float t, float overshoot = 1.70158f);
float easeOutElastic(float t);
float easeOutSpring(float t);
float easeLinear(float t);
float easeOut(float t);
float easeInOut(float t);
float applyEasing(float t, int easingType, float overshoot = 1.70158f);
// bezierEase is provided by util/BezierEase.h (shared with audio thread).

// ---------------------------------------------------------------------------
// CellAnimation — per-track animation state snapshot
// ---------------------------------------------------------------------------
struct CellAnimation {
    // Zoom/Pan/Rotation
    bool  zprActive       = false;
    float zprElapsedMs    = 0.0f;
    float zprDurationMs   = 0.0f;
    float currentZoom     = 1.0f;   // MUST default to 1.0 (0 = black frame)
    float currentPanX     = 0.0f;
    float currentPanY     = 0.0f;
    float currentRotDeg   = 0.0f;

    // ZPR start/target values (stored on trigger)
    float startZoom       = 1.0f;
    float targetZoom      = 1.0f;
    float startPanX       = 0.0f;
    float startPanY       = 0.0f;
    float targetPanX      = 0.0f;
    float targetPanY      = 0.0f;
    float startRotation   = 0.0f;
    float targetRotation  = 0.0f;
    int   zoomEasing      = 1;
    int   panEasing       = 1;
    int   rotEasing       = 1;
    float zprOvershoot    = 1.70158f;

    // Slide additive animation (additive on top of note-triggered ZPR)
    float slideStartZoom      = 1.0f;
    float slideTargetZoom     = 1.0f;
    float slideStartPanX      = 0.0f;
    float slideStartPanY      = 0.0f;
    float slideTargetPanX     = 0.0f;
    float slideTargetPanY     = 0.0f;
    float slideStartRotation  = 0.0f;
    float slideTargetRotation = 0.0f;

    // Bounce
    bool  bounceActive    = false;
    float bounceElapsedMs = 0.0f;
    float bounceDurationMs = 0.0f;
    float bounceOffsetX   = 0.0f;
    float bounceOffsetY   = 0.0f;
    float bounceScaleX    = 1.0f;   // MUST default to 1.0
    float bounceScaleY    = 1.0f;   // MUST default to 1.0

    // Bounce parameters (stored on trigger)
    float bounceDirectionDeg = 270.0f;
    float bounceDistance     = 0.15f;
    float bounceSquashAmount = 0.0f;
    float bounceOvershoot    = 1.70158f;
    int   bounceRepeatCount  = 1;
    int   bounceEasingType   = 0;

    // TV Simulator ramp (slide-triggered).
    // tvRampIntensity is the per-frame *animated* value (peak * (1 - t)); the
    // other 6 fields define the character of the distortion and stay constant
    // for the duration of the ramp. GridCompositor reads all 7 to drive an
    // independent slide TV pass that runs after the visual chain.
    bool  tvRampActive        = false;
    float tvRampElapsedMs     = 0.0f;
    float tvRampDurationMs    = 0.0f;
    float tvRampIntensity     = 0.0f;   // current ramped intensity (peak * (1 - t))
    float tvRampPeakIntensity = 0.5f;   // peak from SlideTVSettings.intensity
    float tvRampRollSpeed     = 1.0f;
    float tvRampScanlines     = 0.3f;
    float tvRampChroma        = 0.003f;
    float tvRampNoise         = 0.0f;
    float tvRampJitter        = 2.0f;
    float tvRampColorBleed    = 0.0f;

    // Slide bezier curve (when slide triggers, use its curve for easing)
    bool  useSlideEasing  = false;
    float slideCurveCx    = 0.5f;
    float slideCurveCy    = 0.5f;

    int   activeNoteId    = -1;
    int   trackId         = -1;

    // ── Slide visual return system ────────────────────────────────────────
    // Snapshotted from SlideNoteEffectSettings at slide-trigger time so the
    // return decision uses the policy that latched the cell, not whatever
    // policy is current on the track right now.
    int   slideReturnStyle      = 1;     // 0=Instant, 1=SmoothReverse
    int   slideReturnTrigger    = 0;     // 0=NextNormalNote, 1=NextSlideNote
    float slideReturnDurationMs = 200.0f;

    // Distinguishes a slide-triggered ZPR from a note-triggered ZPR. Only
    // slide-triggered ZPRs latch at target; note-triggered ZPRs complete
    // and leave the cell at the note's target as before.
    bool  zprIsSlideTriggered   = false;

    // ZPR baseline (cell's pre-slide visual state) and latch flag.
    // Baseline is captured once per slide-trigger cycle, only when no slide
    // is currently latched and no return is mid-flight.
    bool  zprSlideLatched       = false;
    float zprBaseZoom           = 1.0f;
    float zprBasePanX           = 0.0f;
    float zprBasePanY           = 0.0f;
    float zprBaseRotDeg         = 0.0f;

    // ZPR return animation (used only when returnStyle == SmoothReverse).
    bool  zprReturnActive       = false;
    float zprReturnElapsedMs    = 0.0f;
    float zprReturnDurationMs   = 0.0f;
    float zprReturnFromZoom     = 1.0f;
    float zprReturnFromPanX     = 0.0f;
    float zprReturnFromPanY     = 0.0f;
    float zprReturnFromRotDeg   = 0.0f;

    // TV slide latch + return animation. TV's "base" intensity is always 0,
    // so no baseline capture is needed — return animates intensity -> 0.
    bool  tvSlideLatched        = false;
    bool  tvReturnActive        = false;
    float tvReturnElapsedMs     = 0.0f;
    float tvReturnDurationMs    = 0.0f;
    float tvReturnFromIntensity = 0.0f;

    void triggerNote(int noteId, const ZoomPanRotSettings& zpr,
                     const BounceSettings& bounce);
    void triggerSlide(float durationMs,
                      const SlideNoteEffectSettings& cfg,
                      float curveCx, float curveCy);
    void advance(float deltaMs);
    void reset();

    // Public entry — called from FrameCollector when a normal note onset
    // is detected. Gates on slideReturnTrigger == NextNormalNote and only
    // fires return if a slide visual state is currently latched/animating.
    void onSlideReturnTrigger();

    // Internal — run the snap (Instant) or start the SmoothReverse animation
    // immediately, regardless of policy gate. Called from onSlideReturnTrigger
    // after the policy check passes, and directly from AnimationManager::
    // onSlideEvent when consuming a slide note under NextSlideNote policy.
    void runReturnNow();
};

// ---------------------------------------------------------------------------
// AnimationManager — owns per-track CellAnimation instances
// ---------------------------------------------------------------------------
class AnimationManager {
public:
    /** Call once per frame before collectRequests. */
    void advanceAll(float deltaMs);

    /** Called when a note starts on a track. */
    void onNoteStart(int trackId, int noteId,
                     const ZoomPanRotSettings& zpr,
                     const BounceSettings& bounce);

    /** Called when a slide animation event is active. */
    void onSlideEvent(int trackId, float durationMs,
                      const SlideNoteEffectSettings& cfg,
                      float curveCx, float curveCy);

    /** Called from FrameCollector when a normal (non-slide) note onset is
     *  detected. Drives the NextNormalNote return policy — no-ops on tracks
     *  with no latched slide state, or whose policy is NextSlideNote. */
    void onSlideReturnTrigger(int trackId);

    /** Get current animation state for a track's cell. Returns nullptr if none. */
    const CellAnimation* getAnimation(int trackId) const;

    /** Reset a track's animation (cell deactivated). */
    void resetTrack(int trackId);

    /** Reset all tracks. Used by the realtime preview on seek-back / loop
     *  wraparound so latched slide visuals don't bleed across the discontinuity. */
    void resetAll();

private:
    std::unordered_map<int, CellAnimation> animations_;
};
