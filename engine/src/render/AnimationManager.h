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

// ZprTracks is held BY VALUE below, so the full definition is required — the
// forward declarations that used to be enough here no longer are.
#include "../model/TimelineTypes.h"
#include "../util/BezierEase.h"

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
    // ── Absolute time cursor ──────────────────────────────────────────────
    // Every sub-animation stores the transport time it was TRIGGERED at, and
    // derives its elapsed time as (now - trigger). Nothing accumulates a delta.
    //
    // This is what gives live preview and offline export bit-identical results:
    // both feed the same absolute transport position for a given frame. The old
    // accumulator was fed a steady_clock delta on the preview path and an exact
    // per-frame delta offline, so the two could not agree, and any frame hitch
    // silently lost animation time on the preview side.
    double curNowMs       = 0.0;    // last value passed to advance()

    // Zoom/Pan/Rotation
    bool  zprActive       = false;
    double zprStartMs     = 0.0;    // absolute trigger time
    float zprElapsedMs    = 0.0f;   // derived: curNowMs - zprStartMs
    float zprDurationMs   = 0.0f;

    // ── Composited output — what FrameCollector/GridCompositor read ────────
    // NOT a channel of its own. These are recomputed from scratch by
    // composeOutputs() at the end of every advance()/trigger, as
    //
    //     current = noteZpr  (*)  slideDelta
    //
    // in the canonical ZPR space: pan adds, rotation adds, zoom MULTIPLIES
    // (log2 zoom adds). Never write to them expecting the value to survive —
    // write the channel that owns the value instead.
    float currentZoom     = 1.0f;   // MUST default to 1.0 (0 = black frame)
    float currentPanX     = 0.0f;
    float currentPanY     = 0.0f;
    float currentRotDeg   = 0.0f;

    // ── Note-triggered ZPR channel pose ───────────────────────────────────
    // The pose the note-triggered animation (and its Reset/return leg and
    // retrigger crossfade) evaluates to. This is the layer the whole
    // zprTracks / zprOnEndMode / zprCrossfade* machinery below drives; the
    // slide delta layer is composed on top of it, not into it.
    float zprNoteZoom     = 1.0f;
    float zprNotePanX     = 0.0f;
    float zprNotePanY     = 0.0f;
    float zprNoteRotDeg   = 0.0f;

    // ZPR animation curves, in the canonical space (see ZprTracks). These are
    // the authoritative description of the animation; the start/target scalars
    // below are kept only because the slide-latch machinery and the offline
    // resolution bucketing still read them.
    ZprTracks zprTracks;

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

    // ── Slide-triggered ZPR: an ADDITIVE DELTA LAYER ──────────────────────
    // Its identity is pan 0.00, 0.00 / zoom 1.00x / rotation 0.0deg, and it is
    // composed on top of whatever the note-triggered ZPR is doing rather than
    // replacing it (see composeOutputs). A slide that animates to zoom 1.5x
    // therefore means "1.5x MORE than the cell is already doing", and one that
    // animates to 0.8x means "20% less" — the two coexist on one layer.
    //
    // This is why the layer needs no baseline capture the way the old
    // absolute slide did: its base pose IS the identity, so the return leg
    // always animates the delta back to identity and the note channel
    // underneath is never disturbed. (The note channel's own zprBase*/
    // zprReturn* block below is still used, but only by OnEndMode::Reset.)
    bool      slideZprActive     = false;
    double    slideZprStartMs    = 0.0;   // absolute trigger time
    float     slideZprElapsedMs  = 0.0f;  // derived
    float     slideZprDurationMs = 0.0f;
    ZprTracks slideZprTracks;

    // Current delta, in the same canonical units as the note pose above.
    float slideDeltaZoom   = 1.0f;   // MULTIPLIES the note pose's zoom
    float slideDeltaPanX   = 0.0f;   // ADDS to the note pose's pan
    float slideDeltaPanY   = 0.0f;
    float slideDeltaRotDeg = 0.0f;   // ADDS to the note pose's rotation

    // Easing snapshot for the delta layer's return leg (the forward leg runs
    // off slideZprTracks). Kept separate from the note channel's zoomEasing/
    // zprOvershoot so a note trigger can't reshape a slide return in flight.
    int   slideZoomEasing = 1;
    int   slidePanEasing  = 1;
    int   slideRotEasing  = 1;
    float slideOvershoot  = 1.70158f;

    // Latch + return for the delta layer. Mirrors the TV ramp's model exactly
    // (latch at target, return to a known-zero base), which is what the delta
    // formulation buys.
    bool      slideZprLatched          = false;
    bool      slideZprReturnActive     = false;
    double    slideZprReturnStartMs    = 0.0;
    float     slideZprReturnElapsedMs  = 0.0f;
    float     slideZprReturnDurationMs = 0.0f;
    ZprTracks slideZprReturnTracks;

    // Bounce
    bool  bounceActive    = false;
    double bounceStartMs  = 0.0;    // absolute trigger time
    float bounceElapsedMs = 0.0f;   // derived
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
    double tvRampStartMs      = 0.0;   // absolute trigger time
    float tvRampElapsedMs     = 0.0f;  // derived
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

    // ── On-end / retrigger policy (note-triggered ZPR only) ─────────────────
    // Snapshotted from ZoomPanRotSettings at trigger time, same reasoning as
    // slideReturnStyle/slideReturnTrigger above: the latched cell honors the
    // policy that was current when it was triggered, not whatever the track
    // carries by the time the window elapses. The slide delta layer never
    // consults these — it has its own clamp-and-latch/return model.
    ZoomPanRotSettings::OnEndMode     zprOnEndMode     = ZoomPanRotSettings::OnEndMode::Hold;
    ZoomPanRotSettings::RetriggerMode zprRetriggerMode = ZoomPanRotSettings::RetriggerMode::Restart;

    // Ping-pong: which leg (forward/backward) the window is currently on, and
    // the lazily-built time-reversed track for the backward leg. Rebuilt only
    // on a direction flip (paramtrack::reverseInto reuses the vector's
    // capacity), never per frame.
    bool      zprPingPongReversed = false;
    ZprTracks zprPingPongTracks;

    // Retrigger: Crossfade. Preallocated scalars (no container, no allocation
    // possible) — captured from current* at the moment a retrigger arrives
    // while zprActive, then blended against the freshly-triggered animation's
    // own current* over retriggerCrossfadeMs, in the same canonical space
    // (panX/panY/zoomLog2/rotationDeg) the evaluator already works in. Never
    // blends composed transform matrices.
    bool   zprCrossfadeActive     = false;
    double zprCrossfadeStartMs    = 0.0;
    float  zprCrossfadeDurationMs = 0.0f;
    float  zprCrossfadeFromZoom   = 1.0f;
    float  zprCrossfadeFromPanX   = 0.0f;
    float  zprCrossfadeFromPanY   = 0.0f;
    float  zprCrossfadeFromRotDeg = 0.0f;

    // ── Slide visual return system ────────────────────────────────────────
    // Snapshotted from SlideNoteEffectSettings at slide-trigger time so the
    // return decision uses the policy that latched the cell, not whatever
    // policy is current on the track right now.
    int   slideReturnStyle      = 1;     // 0=Instant, 1=SmoothReverse
    int   slideReturnTrigger    = 0;     // 0=NextNormalNote, 1=NextSlideNote
    float slideReturnDurationMs = 200.0f;

    // Note-channel return baseline. Since the slide moved to its own delta
    // layer this is written by exactly one policy — OnEndMode::Reset, which
    // sets it to identity and runs the zprReturn* leg below with duration 0.
    float zprBaseZoom           = 1.0f;
    float zprBasePanX           = 0.0f;
    float zprBasePanY           = 0.0f;
    float zprBaseRotDeg         = 0.0f;

    // Note-channel return animation. Drives the note pose (zprNote*) back to
    // zprBase*, and is now reached only from OnEndMode::Reset.
    bool  zprReturnActive       = false;
    double zprReturnStartMs     = 0.0;   // absolute trigger time
    float zprReturnElapsedMs    = 0.0f;  // derived
    float zprReturnDurationMs   = 0.0f;
    float zprReturnFromZoom     = 1.0f;
    float zprReturnFromPanX     = 0.0f;
    float zprReturnFromPanY     = 0.0f;
    float zprReturnFromRotDeg   = 0.0f;
    // Curves for the return leg, built from the captured from -> base pose.
    ZprTracks zprReturnTracks;

    // TV slide latch + return animation. TV's "base" intensity is always 0,
    // so no baseline capture is needed — return animates intensity -> 0.
    bool  tvSlideLatched        = false;
    bool  tvReturnActive        = false;
    double tvReturnStartMs      = 0.0;   // absolute trigger time
    float tvReturnElapsedMs     = 0.0f;  // derived
    float tvReturnDurationMs    = 0.0f;
    float tvReturnFromIntensity = 0.0f;

    // nowMs is the ABSOLUTE transport position in milliseconds, not a delta.
    // Deliberately NOT defaulted: passing the wrong origin silently rewinds the
    // cell's cursor and every in-flight sub-animation jumps. Callers that do not
    // track time themselves should go through AnimationManager, which stamps
    // from its own clock.
    // bpm resolves LengthMode::Musical (and the Note-mode fallback). noteDurationMs
    // is the triggering note's gate length in ms, or < 0 when unavailable (Note
    // mode then falls back to the Musical-mode duration — see AnimationManager.cpp).
    // Defaulted so existing note-trigger call sites that don't care about length-
    // mode resolution (Fixed-duration callers, tests) keep compiling unchanged.
    void triggerNote(int noteId, const ZoomPanRotSettings& zpr,
                     const BounceSettings& bounce, double nowMs,
                     double bpm = 120.0, float noteDurationMs = -1.0f);
    void triggerSlide(float durationMs,
                      const SlideNoteEffectSettings& cfg,
                      float curveCx, float curveCy, double nowMs);
    void advance(double nowMs);
    void reset();

    // Public entry — called from FrameCollector when a normal note onset
    // is detected. Gates on slideReturnTrigger == NextNormalNote and only
    // fires return if a slide visual state is currently latched/animating.
    void onSlideReturnTrigger(double nowMs);

    // Internal — run the snap (Instant) or start the SmoothReverse animation
    // immediately, regardless of policy gate. Called from onSlideReturnTrigger
    // after the policy check passes, and directly from AnimationManager::
    // onSlideEvent when consuming a slide note under NextSlideNote policy.
    void runReturnNow(double nowMs);

    // Recomputes current* from the note pose and the slide delta layer.
    // Called at the end of advance() and of every trigger, so a caller that
    // reads current* immediately after dispatching an event (FrameCollector
    // does exactly that) sees a composed value, not a stale one.
    void composeOutputs();
};

// ---------------------------------------------------------------------------
// AnimationManager — owns per-track CellAnimation instances
// ---------------------------------------------------------------------------
class AnimationManager {
public:
    /** Call once per frame before collectRequests, with the ABSOLUTE transport
     *  position of the frame in milliseconds.
     *
     *  Both callers must derive this from the same clock the audio engine uses:
     *  the offline renderer from the frame index, the live preview from the
     *  audio-master presentation position. Feeding it steady_clock — or any
     *  accumulated delta — reintroduces the live/export divergence this
     *  replaced. The value also becomes the trigger stamp for any note or slide
     *  dispatched for this frame, so call it BEFORE the event dispatch. */
    void advanceTo(double nowMs);

    /** Absolute transport position last passed to advanceTo. */
    double nowMs() const { return nowMs_; }

    /** Called when a note starts on a track. Stamped at nowMs(). bpm and
     *  noteDurationMs resolve LengthMode (see CellAnimation::triggerNote). */
    void onNoteStart(int trackId, int noteId,
                     const ZoomPanRotSettings& zpr,
                     const BounceSettings& bounce,
                     double bpm = 120.0, float noteDurationMs = -1.0f);

    /** Called when a slide animation event is active. Stamped at nowMs(). */
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
    double nowMs_ = 0.0;
};
