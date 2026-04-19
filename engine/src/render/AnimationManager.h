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

// Forward declarations
struct ZoomPanRotSettings;
struct BounceSettings;

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
float bezierEase(float t, float cx, float cy);

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

    // TV Simulator ramp (slide-triggered)
    bool  tvRampActive    = false;
    float tvRampElapsedMs = 0.0f;
    float tvRampDurationMs = 0.0f;
    float tvRampIntensity = 0.0f;

    // Slide bezier curve (when slide triggers, use its curve for easing)
    bool  useSlideEasing  = false;
    float slideCurveCx    = 0.5f;
    float slideCurveCy    = 0.5f;

    int   activeNoteId    = -1;
    int   trackId         = -1;

    void triggerNote(int noteId, const ZoomPanRotSettings& zpr,
                     const BounceSettings& bounce);
    void triggerSlide(float durationMs, int effectType,
                      const ZoomPanRotSettings& zpr,
                      const BounceSettings& bounce,
                      float curveCx, float curveCy);
    void advance(float deltaMs);
    void reset();
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
    void onSlideEvent(int trackId, float durationMs, int effectType,
                      const ZoomPanRotSettings& zpr,
                      const BounceSettings& bounce,
                      float curveCx, float curveCy);

    /** Get current animation state for a track's cell. Returns nullptr if none. */
    const CellAnimation* getAnimation(int trackId) const;

    /** Reset a track's animation (cell deactivated). */
    void resetTrack(int trackId);

private:
    std::unordered_map<int, CellAnimation> animations_;
};
