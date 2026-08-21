#include "AnimationManager.h"
#include "model/TimelineTypes.h"

#include <algorithm>
#include <cstdio>
#include <vector>

static constexpr float PI = 3.14159265f;

// ===========================================================================
// Easing functions
// ===========================================================================

float easeOutBack(float t, float overshoot) {
    float c3 = overshoot + 1.0f;
    return 1.0f + c3 * powf(t - 1.0f, 3) + overshoot * powf(t - 1.0f, 2);
}

float easeOutElastic(float t) {
    if (t <= 0.0f) return 0.0f;
    if (t >= 1.0f) return 1.0f;
    return powf(2.0f, -10.0f * t) * sinf((t * 10.0f - 0.75f) * (2.0f * PI / 3.0f)) + 1.0f;
}

float easeOutSpring(float t) {
    return 1.0f - powf(2.0f, -6.0f * t) * cosf(6.0f * PI * t);
}

float easeLinear(float t) {
    return t;
}

float easeOut(float t) {
    return 1.0f - (1.0f - t) * (1.0f - t);
}

float easeInOut(float t) {
    return t < 0.5f
        ? 2.0f * t * t
        : 1.0f - powf(-2.0f * t + 2.0f, 2) / 2.0f;
}

float applyEasing(float t, int easingType, float overshoot) {
    t = std::clamp(t, 0.0f, 1.0f);
    switch (easingType) {
        case 0: return easeLinear(t);
        case 1: return easeOut(t);
        case 2: return easeInOut(t);
        case 3: return easeOutBack(t, overshoot);
        case 4: return easeOutElastic(t);
        case 5: return easeOutSpring(t);
        default: return easeLinear(t);
    }
}

// bezierEase moved to engine/src/util/BezierEase.h (shared with audio thread).

// ===========================================================================
// [XformUI] invalid on-end / retrigger mode warning
// ===========================================================================
// All four OnEndMode values and all three RetriggerMode values are handled by
// the playback path below. This now only guards a value that isn't one of
// them at all — reachable solely from a hand-edited or corrupted project.json
// (an out-of-range int surviving the static_cast in Track.cpp's loader), never
// from the UI, whose dropdowns only ever write a valid enumerator.
static void warnUnknownOnEndRetrigger(int trackId, int onEndModeRaw, int retriggerModeRaw) {
    static std::vector<int> warnedTracks;
    if (std::find(warnedTracks.begin(), warnedTracks.end(), trackId) != warnedTracks.end())
        return;
    warnedTracks.push_back(trackId);
    std::fprintf(stderr,
        "[XformUI] track %d: onEndMode=%d / retriggerMode=%d is not a recognized value "
        "(project.json may be hand-edited or from a newer build) — falling back to "
        "Hold + Restart for this track.\n", trackId, onEndModeRaw, retriggerModeRaw);
}

// ===========================================================================
// Length-mode resolution
// ===========================================================================
// index -> beats. Kept in exact step with MUSICAL_DIVISIONS in
// ui/src/components/grid/zprTimeline/zprCurveMath.js (1 bar = 4 beats, 4/4
// assumed, matching the rest of the timeline's bar math) — the UI resolves the
// same table for the header's live "@ BPM = Xms" readout, and the two must
// never disagree about what "1/8" means.
static constexpr double kMusicalDivisionBeats[7] = {
    1.0 / 8.0,  // 1/32
    1.0 / 4.0,  // 1/16
    1.0 / 2.0,  // 1/8
    1.0,        // 1/4
    2.0,        // 1/2
    4.0,        // 1 bar
    8.0,        // 2 bars
};

static double musicalDivisionToMs(int index, double bpm) {
    const double safeBpm = bpm > 0.0 ? bpm : 120.0;
    const int idx = std::clamp(index, 0, 6);
    return (60000.0 / safeBpm) * kMusicalDivisionBeats[idx];
}

// Resolves ZoomPanRotSettings::lengthMode to a concrete window duration at
// trigger time. noteDurationMs < 0 means the gate length wasn't available at
// the call site (see FrameCollector.cpp) — Note mode then falls back to the
// Musical-mode value and logs [XformAnim] once per process, not per note (a
// held chord or a fast run would otherwise flood stderr).
static float resolveZprDurationMs(const ZoomPanRotSettings& zpr, double bpm,
                                   float noteDurationMs) {
    using LengthMode = ZoomPanRotSettings::LengthMode;
    switch (zpr.lengthMode) {
        case LengthMode::Fixed:
            return zpr.durationMs;
        case LengthMode::Musical:
            return static_cast<float>(musicalDivisionToMs(zpr.musicalDivision, bpm));
        case LengthMode::Note: {
            if (noteDurationMs >= 0.0f) {
                return noteDurationMs * (zpr.notePercentage / 100.0f);
            }
            static bool warnedNoteLengthFallback = false;
            if (!warnedNoteLengthFallback) {
                warnedNoteLengthFallback = true;
                std::fprintf(stderr,
                    "[XformAnim] Length mode is Note but the triggering note's gate length "
                    "was not available at trigger time — falling back to the Musical-mode "
                    "duration for this and all subsequent notes this session.\n");
            }
            return static_cast<float>(musicalDivisionToMs(zpr.musicalDivision, bpm));
        }
        default:
            return zpr.durationMs;
    }
}

// ===========================================================================
// CellAnimation
// ===========================================================================

// Normalized progress within an animation window, from absolute times.
// Clamped at both ends: a backwards transport jump (seek, loop wrap) reads as
// the start pose rather than a negative time. resetAll() is still the correct
// response to a discontinuity — this only makes the interim frame safe.
static double normalizedProgress(double nowMs, double startMs, float durationMs) {
    if (durationMs <= 0.0f) return 1.0;
    const double elapsed = nowMs - startMs;
    if (elapsed <= 0.0) return 0.0;
    const double t = elapsed / static_cast<double>(durationMs);
    return t > 1.0 ? 1.0 : t;
}

void CellAnimation::triggerNote(int noteId, const ZoomPanRotSettings& zpr,
                                 const BounceSettings& bounce, double nowMs,
                                 double bpm, float noteDurationMs) {
    using OnEndMode     = ZoomPanRotSettings::OnEndMode;
    using RetriggerMode = ZoomPanRotSettings::RetriggerMode;

    activeNoteId = noteId;
    curNowMs     = nowMs;

    // Retrigger: Ignore. A window already in flight (Hold/Reset/Loop/PingPong
    // all read as zprActive) drops this trigger for the ZPR channel entirely —
    // no restart, no crossfade snapshot, nothing touched. Bounce is a separate
    // channel and is unaffected (falls through to the bounce block below).
    const bool ignoreRetrigger =
        zpr.enabled && zprActive
        && zpr.retriggerMode == RetriggerMode::Ignore;

    if (zpr.enabled && !ignoreRetrigger) {
        // Cancels only the NOTE channel's own return leg (OnEndMode::Reset) —
        // a new note re-animates this channel from its own start pose. The
        // slide delta layer is deliberately untouched: it is composed on top
        // of this channel, so a note firing under a held slide keeps the
        // slide's offset instead of wiping it.
        zprReturnActive = false;

        // Out-of-range enum values only reach here from a hand-edited or
        // future-build project.json (see the function's own doc comment) —
        // the UI dropdowns never write anything else.
        const bool onEndKnown =
            zpr.onEndMode == OnEndMode::Hold || zpr.onEndMode == OnEndMode::Reset
            || zpr.onEndMode == OnEndMode::Loop || zpr.onEndMode == OnEndMode::PingPong;
        const bool retriggerKnown =
            zpr.retriggerMode == RetriggerMode::Restart || zpr.retriggerMode == RetriggerMode::Ignore
            || zpr.retriggerMode == RetriggerMode::Crossfade;
        if (!onEndKnown || !retriggerKnown) {
            warnUnknownOnEndRetrigger(trackId, static_cast<int>(zpr.onEndMode),
                                      static_cast<int>(zpr.retriggerMode));
        }

        // Retrigger: Crossfade. Only meaningful when retriggering a window
        // already in flight — capture the outgoing pose (wherever the cell
        // visually is right now, which may itself be mid-blend from an
        // earlier crossfade) BEFORE it's overwritten below. All four fields
        // are preallocated scalars on CellAnimation, so this never allocates.
        if (zprActive && zpr.retriggerMode == RetriggerMode::Crossfade) {
            zprCrossfadeActive     = true;
            zprCrossfadeStartMs    = nowMs;
            zprCrossfadeDurationMs = zpr.retriggerCrossfadeMs;
            zprCrossfadeFromZoom   = zprNoteZoom;
            zprCrossfadeFromPanX   = zprNotePanX;
            zprCrossfadeFromPanY   = zprNotePanY;
            zprCrossfadeFromRotDeg = zprNoteRotDeg;
        } else {
            zprCrossfadeActive = false;
        }

        zprActive            = true;
        zprPingPongReversed  = false;   // always re-enter on the forward leg
        zprOnEndMode         = onEndKnown ? zpr.onEndMode : OnEndMode::Hold;
        zprRetriggerMode      = retriggerKnown ? zpr.retriggerMode : RetriggerMode::Restart;
        zprStartMs    = nowMs;
        zprElapsedMs  = 0.0f;
        zprDurationMs = resolveZprDurationMs(zpr, bpm, noteDurationMs);

        // Prefer the settings' own tracks when they carry an explicitly
        // authored (or already-migrated) curve set; otherwise derive them from
        // the legacy scalars. Deriving reuses the vector capacity, so this
        // allocates only on the first note-onset for a given cell.
        if (zprTracksAnimated(zpr.tracks))
            zprTracks = zpr.tracks;
        else
            buildZprTracks(zprTracks, zpr);

        startZoom     = zpr.startZoom;
        targetZoom    = zpr.targetZoom;
        startPanX     = zpr.startPanX;
        startPanY     = zpr.startPanY;
        targetPanX    = zpr.targetPanX;
        targetPanY    = zpr.targetPanY;
        startRotation = zpr.startRotation;
        targetRotation = zpr.targetRotation;
        zoomEasing    = zpr.zoomEasing;
        panEasing     = zpr.panEasing;
        rotEasing     = zpr.rotEasing;
        zprOvershoot  = zpr.overshoot;

        // Set initial values (note channel only — the slide delta layer keeps
        // whatever it currently holds and is re-composed below).
        zprNoteZoom   = startZoom;
        zprNotePanX   = startPanX;
        zprNotePanY   = startPanY;
        zprNoteRotDeg = startRotation;
    }

    // Bounce animation
    if (bounce.enabled) {
        bounceActive       = true;
        bounceStartMs      = nowMs;
        bounceElapsedMs    = 0.0f;
        bounceDurationMs   = bounce.durationMs * static_cast<float>(bounce.repeatCount > 0 ? bounce.repeatCount : 1);
        bounceDirectionDeg = bounce.directionDeg;
        bounceDistance      = bounce.distance;
        bounceSquashAmount  = bounce.squashAmount;
        bounceOvershoot     = bounce.overshoot;
        bounceRepeatCount   = bounce.repeatCount;
        bounceEasingType    = bounce.easingType;

        // Reset to neutral
        bounceOffsetX = 0.0f;
        bounceOffsetY = 0.0f;
        bounceScaleX  = 1.0f;
        bounceScaleY  = 1.0f;
    }

    useSlideEasing = false;

    composeOutputs();

#ifdef XLETH_DEBUG
    std::fprintf(stderr, "[AnimMgr] Track %d: note trigger, noteId=%d, zpr=%s, bounce=%s\n",
                 trackId, noteId, zpr.enabled ? "on" : "off", bounce.enabled ? "on" : "off");
#endif
}

// current* is a pure function of the two ZPR layers. Composition happens in
// the canonical ZPR space, which is the only space the two layers agree in:
// pan and rotation are additive there, and zoom is additive in log2 — i.e. a
// multiply on the linear zoom. Composing the built transform matrices instead
// would make a slide's pan depend on the note's rotation, which is not what
// "add 0.1 to the right" means to anyone authoring one.
void CellAnimation::composeOutputs() {
    currentZoom   = zprNoteZoom * slideDeltaZoom;
    currentPanX   = zprNotePanX + slideDeltaPanX;
    currentPanY   = zprNotePanY + slideDeltaPanY;
    currentRotDeg = zprNoteRotDeg + slideDeltaRotDeg;
}

void CellAnimation::triggerSlide(float durationMs,
                                  const SlideNoteEffectSettings& cfg,
                                  float curveCx, float curveCy, double nowMs) {
    using EffectType = SlideNoteEffectSettings::EffectType;

    curNowMs = nowMs;

    // Snapshot the return policy that will govern this slide's lifetime.
    // The latched cell honors *this* policy on return, even if the user
    // changes it on the track later.
    slideReturnStyle      = static_cast<int>(cfg.returnStyle);
    slideReturnTrigger    = static_cast<int>(cfg.returnTrigger);
    slideReturnDurationMs = cfg.returnDurationMs;

    // TV still captures nothing — its base intensity is always 0. The ZPR
    // slide no longer captures a baseline at all: as a delta layer its base
    // pose IS the identity (see AnimationManager.h), which is what lets a
    // chained slide re-trigger without ever having to remember the cell's
    // pre-slide state.
    const bool tvFresh  = !tvSlideLatched  && !tvReturnActive;

    // useSlideEasing is set per-effect below: ZPR slide honors its own Easing
    // dropdown (bezier curve does NOT override it); Bounce slide still uses
    // the slide note's bezier curve to shape the arc.
    if (cfg.type == EffectType::ZoomPanRot) {
        const auto& z = cfg.zoomPanRot;

        // A fresh slide overrides any in-flight return on the delta layer.
        slideZprReturnActive = false;
        slideZprLatched      = false;

        slideZprActive     = true;
        slideZprStartMs    = nowMs;
        slideZprElapsedMs  = 0.0f;
        slideZprDurationMs = durationMs;

        // The authored curves ARE the delta: their identity (pan 0, zoom
        // 1.00x = log2 0, rotation 0) is the "no contribution" pose, so the
        // editor needs no separate relative/absolute mode — a curve sitting at
        // identity contributes nothing, and everything else amplifies or
        // subtracts from the note animation underneath.
        if (zprTracksAnimated(z.tracks))
            slideZprTracks = z.tracks;
        else
            buildZprTracks(slideZprTracks, z);

        slideZoomEasing = z.zoomEasing;
        slidePanEasing  = z.panEasing;
        slideRotEasing  = z.rotEasing;
        slideOvershoot  = z.overshoot;

        // Seed the delta to the curves' t=0 pose so the first rendered frame
        // matches the start keyframe rather than the previous slide's delta.
        slideDeltaZoom   = zprLog2ToZoom(paramtrack::evaluate(slideZprTracks.zoomLog2,    0.0f));
        slideDeltaPanX   = static_cast<float>(paramtrack::evaluate(slideZprTracks.panX,        0.0f));
        slideDeltaPanY   = static_cast<float>(paramtrack::evaluate(slideZprTracks.panY,        0.0f));
        slideDeltaRotDeg = static_cast<float>(paramtrack::evaluate(slideZprTracks.rotationDeg, 0.0f));

        useSlideEasing  = false;  // ZPR slide uses its own per-axis easing.
    }

    if (cfg.type == EffectType::Bounce) {
        const auto& b      = cfg.bounce;
        bounceActive       = true;
        bounceStartMs      = nowMs;
        bounceElapsedMs    = 0.0f;
        bounceDurationMs   = durationMs;
        bounceDirectionDeg = b.directionDeg;
        bounceDistance     = b.distance;
        bounceSquashAmount = b.squashAmount;
        bounceOvershoot    = b.overshoot;
        bounceRepeatCount  = b.repeatCount;
        bounceEasingType   = b.easingType;

        // Bezier curve from the slide note still shapes the bounce arc.
        useSlideEasing  = true;
        slideCurveCx    = curveCx;
        slideCurveCy    = curveCy;
    }

    if (cfg.type == EffectType::TVSimulator) {
        const auto& t       = cfg.tv;
        (void)tvFresh;                          // baseline is always 0 for TV
        tvReturnActive      = false;            // a fresh slide overrides return
        tvSlideLatched      = false;
        tvRampActive        = true;
        tvRampStartMs       = nowMs;
        tvRampElapsedMs     = 0.0f;
        tvRampDurationMs    = durationMs;
        tvRampPeakIntensity = t.intensity;
        tvRampIntensity     = 0.0f;             // ramp UP from 0 -> peak (advance())
        tvRampRollSpeed     = t.rollSpeed;
        tvRampScanlines     = t.scanlines;
        tvRampChroma        = t.chroma;
        tvRampNoise         = t.noise;
        tvRampJitter        = t.jitter;
        tvRampColorBleed    = t.colorBleed;
    }

    composeOutputs();

#ifdef XLETH_DEBUG
    std::fprintf(stderr, "[AnimMgr] Track %d: slide trigger, effectType=%d, duration=%.1fms, "
                 "curve=(%.2f,%.2f)\n",
                 trackId, static_cast<int>(cfg.type), durationMs, curveCx, curveCy);
#endif
}

void CellAnimation::advance(double nowMs) {
    curNowMs = nowMs;

    // Advance ZPR animation
    if (zprActive) {
        const double elapsed = std::max(0.0, nowMs - zprStartMs);
        zprElapsedMs = static_cast<float>(elapsed);
        if (zprDurationMs > 0.0f) {
            double t = 0.0;
            bool   useReversedTrack = false;
            bool   windowFinished   = false;

            using OnEndMode = ZoomPanRotSettings::OnEndMode;
            switch (zprOnEndMode) {
                case OnEndMode::Loop: {
                    // Restart from t=0 every window — no interpolated
                    // smoothing across the seam by design (see UI-side
                    // discontinuity warning icon for when this will pop).
                    double wrapped = std::fmod(elapsed, static_cast<double>(zprDurationMs));
                    if (wrapped < 0.0) wrapped = 0.0;
                    t = wrapped / zprDurationMs;
                    break;
                }
                case OnEndMode::PingPong: {
                    const double cycle = 2.0 * static_cast<double>(zprDurationMs);
                    double wrapped = std::fmod(elapsed, cycle);
                    if (wrapped < 0.0) wrapped = 0.0;
                    if (wrapped < zprDurationMs) {
                        t = wrapped / zprDurationMs;
                        useReversedTrack = false;
                    } else {
                        t = (wrapped - zprDurationMs) / zprDurationMs;
                        useReversedTrack = true;
                    }
                    break;
                }
                case OnEndMode::Hold:
                case OnEndMode::Reset:
                default: {
                    t = normalizedProgress(nowMs, zprStartMs, zprDurationMs);
                    windowFinished = (t >= 1.0);
                    break;
                }
            }
            const float tf = static_cast<float>(t);

            if (useSlideEasing) {
                // Legacy quirk, preserved: a Bounce slide firing while a
                // note-triggered ZPR is still in flight overrides the ZPR's own
                // per-axis easing with the slide note's bezier curve. The curve
                // is the slide note's, not the track's, so the ParamTracks are
                // bypassed and only their endpoints are used. bezierEase here is
                // the slide-curve function (util/BezierEase.h), deliberately a
                // different curve family from ParamTrackEase — see that header.
                const float e = bezierEase(tf, slideCurveCx, slideCurveCy);
                const double z0 = zprTracks.zoomLog2.keys.empty()
                    ? zprTracks.zoomLog2.constantValue : zprTracks.zoomLog2.keys.front().value;
                const double z1 = zprTracks.zoomLog2.keys.empty()
                    ? zprTracks.zoomLog2.constantValue : zprTracks.zoomLog2.keys.back().value;
                zprNoteZoom   = zprLog2ToZoom(z0 + (z1 - z0) * e);
                zprNotePanX   = startPanX + (targetPanX - startPanX) * e;
                zprNotePanY   = startPanY + (targetPanY - startPanY) * e;
                zprNoteRotDeg = startRotation + (targetRotation - startRotation) * e;
            } else {
                // Ping-pong's backward leg needs a time-reversed track (not
                // just a reflected t), and the whole point is preserving each
                // segment's easing shape — see paramtrack::reverseInto. Rebuilt
                // only on a direction flip: zprPingPongTracks' vectors keep
                // their capacity across flips (resize, not reassignment).
                if (useReversedTrack != zprPingPongReversed) {
                    zprPingPongReversed = useReversedTrack;
                    if (useReversedTrack) {
                        paramtrack::reverseInto(zprPingPongTracks.panX,       zprTracks.panX);
                        paramtrack::reverseInto(zprPingPongTracks.panY,       zprTracks.panY);
                        paramtrack::reverseInto(zprPingPongTracks.zoomLog2,   zprTracks.zoomLog2);
                        paramtrack::reverseInto(zprPingPongTracks.rotationDeg, zprTracks.rotationDeg);
                    }
                }
                const ZprTracks& evalTracks = useReversedTrack ? zprPingPongTracks : zprTracks;

                // Canonical path: four independent ParamTracks, one shared
                // evaluator. exp2 converts zoom out of log space here and
                // nowhere else. Rotation comes out unwrapped by construction.
                zprNoteZoom   = zprLog2ToZoom(paramtrack::evaluate(evalTracks.zoomLog2,    tf));
                zprNotePanX   = static_cast<float>(paramtrack::evaluate(evalTracks.panX,        tf));
                zprNotePanY   = static_cast<float>(paramtrack::evaluate(evalTracks.panY,        tf));
                zprNoteRotDeg = static_cast<float>(paramtrack::evaluate(evalTracks.rotationDeg, tf));
            }

            if (windowFinished) {
                zprActive = false;
                if (zprOnEndMode == ZoomPanRotSettings::OnEndMode::Reset) {
                    // Absorbed into the SAME zprReturnActive/zprBase* machinery
                    // the slide SmoothReverse/Instant return already uses (see
                    // the "planned convergence" note above zprReturnTracks) —
                    // duration 0 makes the "Advance ZPR return animation" block
                    // right below resolve it instantly, in this same advance()
                    // call, rather than a second snap-to-identity path sitting
                    // beside it.
                    zprBaseZoom   = 1.0f;
                    zprBasePanX   = 0.0f;
                    zprBasePanY   = 0.0f;
                    zprBaseRotDeg = 0.0f;
                    zprReturnActive     = true;
                    zprReturnStartMs    = nowMs;
                    zprReturnElapsedMs  = 0.0f;
                    zprReturnDurationMs = 0.0f;
                }
            }
        } else {
            zprActive = false;
        }
    }

    // Advance the NOTE channel's return animation (OnEndMode::Reset). Runs the
    // note pose back to captured base* over zprReturnDurationMs.
    if (zprReturnActive) {
        zprReturnElapsedMs = static_cast<float>(std::max(0.0, nowMs - zprReturnStartMs));
        if (zprReturnDurationMs > 0.0f) {
            const double td = normalizedProgress(nowMs, zprReturnStartMs, zprReturnDurationMs);
            const float  t  = static_cast<float>(td);
            // The return leg runs through the same evaluator and the same
            // canonical space as the forward leg, so its zoom is log2 too.
            zprNoteZoom   = zprLog2ToZoom(paramtrack::evaluate(zprReturnTracks.zoomLog2,    td));
            zprNotePanX   = static_cast<float>(paramtrack::evaluate(zprReturnTracks.panX,        td));
            zprNotePanY   = static_cast<float>(paramtrack::evaluate(zprReturnTracks.panY,        td));
            zprNoteRotDeg = static_cast<float>(paramtrack::evaluate(zprReturnTracks.rotationDeg, td));
            if (t >= 1.0f) {
                zprNoteZoom     = zprBaseZoom;
                zprNotePanX     = zprBasePanX;
                zprNotePanY     = zprBasePanY;
                zprNoteRotDeg   = zprBaseRotDeg;
                zprReturnActive = false;
            }
        } else {
            zprNoteZoom     = zprBaseZoom;
            zprNotePanX     = zprBasePanX;
            zprNotePanY     = zprBasePanY;
            zprNoteRotDeg   = zprBaseRotDeg;
            zprReturnActive = false;
        }
    }

    // Retrigger: Crossfade. Runs independently of zprActive (not nested inside
    // the block above) so a Hold/Reset window that finishes mid-crossfade still
    // settles into the frozen incoming target instead of leaving the blend
    // permanently short — once zprActive goes false, current* stops being
    // recomputed above and holds the incoming animation's final value, which is
    // exactly the right blend target. Blends in the canonical space
    // (panX/panY/zoomLog2/rotationDeg) that currentZoom/currentPanX/currentPanY/
    // currentRotDeg already ARE — never the composed transform matrix.
    if (zprCrossfadeActive) {
        const double cfElapsed = std::max(0.0, nowMs - zprCrossfadeStartMs);
        if (zprCrossfadeDurationMs > 0.0f) {
            const float blend = static_cast<float>(
                std::min(1.0, cfElapsed / static_cast<double>(zprCrossfadeDurationMs)));
            zprNoteZoom   = zprCrossfadeFromZoom   + (zprNoteZoom   - zprCrossfadeFromZoom)   * blend;
            zprNotePanX   = zprCrossfadeFromPanX   + (zprNotePanX   - zprCrossfadeFromPanX)   * blend;
            zprNotePanY   = zprCrossfadeFromPanY   + (zprNotePanY   - zprCrossfadeFromPanY)   * blend;
            zprNoteRotDeg = zprCrossfadeFromRotDeg + (zprNoteRotDeg - zprCrossfadeFromRotDeg) * blend;
            if (blend >= 1.0f) zprCrossfadeActive = false;
        } else {
            zprCrossfadeActive = false;
        }
    }

    // ── Slide ZPR delta layer ─────────────────────────────────────────────
    // Runs entirely beside the note channel above. Clamp-and-latch, exactly
    // the model the slide always had — what changed is that it latches a
    // DELTA at target instead of an absolute pose, so the note animation
    // underneath keeps playing through the latch.
    if (slideZprActive) {
        slideZprElapsedMs = static_cast<float>(std::max(0.0, nowMs - slideZprStartMs));
        if (slideZprDurationMs > 0.0f) {
            const double td = normalizedProgress(nowMs, slideZprStartMs, slideZprDurationMs);
            slideDeltaZoom   = zprLog2ToZoom(paramtrack::evaluate(slideZprTracks.zoomLog2,    td));
            slideDeltaPanX   = static_cast<float>(paramtrack::evaluate(slideZprTracks.panX,        td));
            slideDeltaPanY   = static_cast<float>(paramtrack::evaluate(slideZprTracks.panY,        td));
            slideDeltaRotDeg = static_cast<float>(paramtrack::evaluate(slideZprTracks.rotationDeg, td));
            if (td >= 1.0) {
                slideZprActive  = false;
                slideZprLatched = true;   // held until a return trigger fires
            }
        } else {
            slideZprActive = false;
        }
    }

    // Advance the delta layer's return leg. Always lands on the identity
    // delta — there is no captured baseline to restore, which is the whole
    // point of the delta formulation.
    if (slideZprReturnActive) {
        slideZprReturnElapsedMs =
            static_cast<float>(std::max(0.0, nowMs - slideZprReturnStartMs));
        if (slideZprReturnDurationMs > 0.0f) {
            const double td = normalizedProgress(nowMs, slideZprReturnStartMs,
                                                 slideZprReturnDurationMs);
            slideDeltaZoom   = zprLog2ToZoom(paramtrack::evaluate(slideZprReturnTracks.zoomLog2,    td));
            slideDeltaPanX   = static_cast<float>(paramtrack::evaluate(slideZprReturnTracks.panX,        td));
            slideDeltaPanY   = static_cast<float>(paramtrack::evaluate(slideZprReturnTracks.panY,        td));
            slideDeltaRotDeg = static_cast<float>(paramtrack::evaluate(slideZprReturnTracks.rotationDeg, td));
            if (td >= 1.0) {
                slideDeltaZoom       = 1.0f;
                slideDeltaPanX       = 0.0f;
                slideDeltaPanY       = 0.0f;
                slideDeltaRotDeg     = 0.0f;
                slideZprReturnActive = false;
                slideZprLatched      = false;
            }
        } else {
            slideDeltaZoom       = 1.0f;
            slideDeltaPanX       = 0.0f;
            slideDeltaPanY       = 0.0f;
            slideDeltaRotDeg     = 0.0f;
            slideZprReturnActive = false;
            slideZprLatched      = false;
        }
    }

    // Advance bounce animation (per-repeat with decay)
    if (bounceActive) {
        bounceElapsedMs = static_cast<float>(std::max(0.0, nowMs - bounceStartMs));
        if (bounceDurationMs > 0.0f) {
            int   rc             = bounceRepeatCount > 0 ? bounceRepeatCount : 1;
            float singleDuration = bounceDurationMs / static_cast<float>(rc);
            int   currentRepeat  = static_cast<int>(bounceElapsedMs / singleDuration);

            if (currentRepeat >= rc) {
                bounceActive  = false;
                bounceOffsetX = 0.0f;  bounceOffsetY = 0.0f;
                bounceScaleX  = 1.0f;  bounceScaleY  = 1.0f;
            } else {
                float localT = std::clamp(fmodf(bounceElapsedMs, singleDuration) / singleDuration,
                                          0.0f, 1.0f);
                float easedT;
                if (useSlideEasing) {
                    easedT = bezierEase(localT, slideCurveCx, slideCurveCy);
                } else {
                    switch (bounceEasingType) {
                        case 0: easedT = easeOutBack(localT, bounceOvershoot); break;
                        case 1: easedT = easeOutElastic(localT); break;
                        case 2: easedT = easeOutSpring(localT); break;
                        default: easedT = easeOutBack(localT, bounceOvershoot); break;
                    }
                }
                float decay     = powf(0.5f, static_cast<float>(currentRepeat));
                float remaining = (1.0f - easedT) * decay;
                float dirRad    = bounceDirectionDeg * (PI / 180.0f);
                bounceOffsetX   =  cosf(dirRad) * bounceDistance * remaining;
                bounceOffsetY   = -sinf(dirRad) * bounceDistance * remaining; // negate: screen-Y down

                if (bounceSquashAmount > 0.0f) {
                    float squash  = 1.0f + bounceSquashAmount * remaining;
                    float stretch = 1.0f / squash;
                    bounceScaleX  = 1.0f + (squash  - 1.0f) * fabsf(cosf(dirRad))
                                         + (stretch - 1.0f) * fabsf(sinf(dirRad));
                    bounceScaleY  = 1.0f + (squash  - 1.0f) * fabsf(sinf(dirRad))
                                         + (stretch - 1.0f) * fabsf(cosf(dirRad));
                } else {
                    bounceScaleX = 1.0f;
                    bounceScaleY = 1.0f;
                }
            }
        } else {
            bounceActive = false;
        }
    }

    // Advance TV ramp — ramps intensity from 0 -> peak over tvRampDurationMs
    // and latches at peak. The latched cell holds the configured TV effect
    // until a return trigger fires (NextNormalNote or NextSlideNote per the
    // SlideNoteEffectSettings.returnTrigger snapshot).
    if (tvRampActive) {
        tvRampElapsedMs = static_cast<float>(std::max(0.0, nowMs - tvRampStartMs));
        if (tvRampDurationMs > 0.0f) {
            float t = static_cast<float>(normalizedProgress(nowMs, tvRampStartMs, tvRampDurationMs));
            tvRampIntensity = tvRampPeakIntensity * t;
            if (t >= 1.0f) {
                tvRampActive    = false;
                tvSlideLatched  = true;
                tvRampIntensity = tvRampPeakIntensity;
            }
        } else {
            tvRampActive = false;
        }
    }

    // Advance TV return animation. Ramps intensity from captured peak (or
    // current value when interrupted) -> 0 over tvReturnDurationMs.
    if (tvReturnActive) {
        tvReturnElapsedMs = static_cast<float>(std::max(0.0, nowMs - tvReturnStartMs));
        if (tvReturnDurationMs > 0.0f) {
            float t = static_cast<float>(normalizedProgress(nowMs, tvReturnStartMs, tvReturnDurationMs));
            tvRampIntensity = tvReturnFromIntensity * (1.0f - t);
            if (t >= 1.0f) {
                tvRampIntensity = 0.0f;
                tvReturnActive  = false;
                tvSlideLatched  = false;
            }
        } else {
            tvRampIntensity = 0.0f;
            tvReturnActive  = false;
            tvSlideLatched  = false;
        }
    }

    composeOutputs();
}

void CellAnimation::reset() {
    zprActive       = false;
    zprStartMs      = 0.0;
    zprElapsedMs    = 0.0f;
    // clear() not a fresh ZprTracks: keeps the vectors' capacity so the next
    // note-onset after a seek rebuilds without allocating.
    zprTracks.panX.keys.clear();
    zprTracks.panY.keys.clear();
    zprTracks.zoomLog2.keys.clear();
    zprTracks.rotationDeg.keys.clear();
    zprReturnTracks.panX.keys.clear();
    zprReturnTracks.panY.keys.clear();
    zprReturnTracks.zoomLog2.keys.clear();
    zprReturnTracks.rotationDeg.keys.clear();
    zprNoteZoom     = 1.0f;
    zprNotePanX     = 0.0f;
    zprNotePanY     = 0.0f;
    zprNoteRotDeg   = 0.0f;

    // Slide delta layer back to its identity, curves cleared capacity-preserving
    // like the note channel's above.
    slideZprActive     = false;
    slideZprStartMs    = 0.0;
    slideZprElapsedMs  = 0.0f;
    slideZprDurationMs = 0.0f;
    slideZprTracks.panX.keys.clear();
    slideZprTracks.panY.keys.clear();
    slideZprTracks.zoomLog2.keys.clear();
    slideZprTracks.rotationDeg.keys.clear();
    slideZprReturnTracks.panX.keys.clear();
    slideZprReturnTracks.panY.keys.clear();
    slideZprReturnTracks.zoomLog2.keys.clear();
    slideZprReturnTracks.rotationDeg.keys.clear();
    slideDeltaZoom   = 1.0f;
    slideDeltaPanX   = 0.0f;
    slideDeltaPanY   = 0.0f;
    slideDeltaRotDeg = 0.0f;
    slideZoomEasing  = 1;
    slidePanEasing   = 1;
    slideRotEasing   = 1;
    slideOvershoot   = 1.70158f;
    slideZprLatched          = false;
    slideZprReturnActive     = false;
    slideZprReturnStartMs    = 0.0;
    slideZprReturnElapsedMs  = 0.0f;
    slideZprReturnDurationMs = 0.0f;

    bounceActive    = false;
    bounceStartMs   = 0.0;
    bounceElapsedMs = 0.0f;
    bounceOffsetX   = 0.0f;
    bounceOffsetY   = 0.0f;
    bounceScaleX    = 1.0f;
    bounceScaleY    = 1.0f;

    tvRampActive        = false;
    tvRampStartMs       = 0.0;
    tvRampElapsedMs     = 0.0f;
    tvRampIntensity     = 0.0f;
    tvRampPeakIntensity = 0.5f;
    tvRampRollSpeed     = 1.0f;
    tvRampScanlines     = 0.3f;
    tvRampChroma        = 0.003f;
    tvRampNoise         = 0.0f;
    tvRampJitter        = 2.0f;
    tvRampColorBleed    = 0.0f;

    useSlideEasing  = false;
    activeNoteId    = -1;

    zprOnEndMode         = ZoomPanRotSettings::OnEndMode::Hold;
    zprRetriggerMode     = ZoomPanRotSettings::RetriggerMode::Restart;
    zprPingPongReversed  = false;
    // clear() not a fresh ZprTracks: keeps the vectors' capacity, matching
    // zprTracks/zprReturnTracks above.
    zprPingPongTracks.panX.keys.clear();
    zprPingPongTracks.panY.keys.clear();
    zprPingPongTracks.zoomLog2.keys.clear();
    zprPingPongTracks.rotationDeg.keys.clear();

    zprCrossfadeActive     = false;
    zprCrossfadeStartMs    = 0.0;
    zprCrossfadeDurationMs = 0.0f;
    zprCrossfadeFromZoom   = 1.0f;
    zprCrossfadeFromPanX   = 0.0f;
    zprCrossfadeFromPanY   = 0.0f;
    zprCrossfadeFromRotDeg = 0.0f;

    // Slide return system — clear latch, baseline, and any in-flight return
    // so seek-back / loop wraparound / explicit resetTrack starts clean.
    slideReturnStyle      = 1;
    slideReturnTrigger    = 0;
    slideReturnDurationMs = 200.0f;
    zprBaseZoom           = 1.0f;
    zprBasePanX           = 0.0f;
    zprBasePanY           = 0.0f;
    zprBaseRotDeg         = 0.0f;
    zprReturnActive       = false;
    zprReturnStartMs      = 0.0;
    zprReturnElapsedMs    = 0.0f;
    zprReturnDurationMs   = 0.0f;
    zprReturnFromZoom     = 1.0f;
    zprReturnFromPanX     = 0.0f;
    zprReturnFromPanY     = 0.0f;
    zprReturnFromRotDeg   = 0.0f;
    tvSlideLatched        = false;
    tvReturnActive        = false;
    tvReturnStartMs       = 0.0;
    tvReturnElapsedMs     = 0.0f;
    tvReturnDurationMs    = 0.0f;
    tvReturnFromIntensity = 0.0f;

    composeOutputs();
}

// Snap to base (Instant) or kick off the SmoothReverse animation. Bypasses
// the policy gate — callers are responsible for deciding whether the trigger
// applies (NextNormalNote vs NextSlideNote).
void CellAnimation::runReturnNow(double nowMs) {
    const bool latched = slideZprLatched || tvSlideLatched
                      || slideZprReturnActive || tvReturnActive;
    if (!latched) return;

    curNowMs = nowMs;

    const bool instant = (slideReturnStyle == 0);

    // A return supersedes any in-flight slide animation (we may be returning
    // mid-flight when a NextSlideNote event consumed a still-animating slide).
    // Only the slide's own layers are touched — the note channel keeps playing.
    slideZprActive = false;
    tvRampActive   = false;

    if (instant) {
        if (slideZprLatched || slideZprReturnActive) {
            slideDeltaZoom       = 1.0f;
            slideDeltaPanX       = 0.0f;
            slideDeltaPanY       = 0.0f;
            slideDeltaRotDeg     = 0.0f;
            slideZprLatched      = false;
            slideZprReturnActive = false;
        }
        if (tvSlideLatched || tvReturnActive) {
            tvRampIntensity = 0.0f;
            tvSlideLatched  = false;
            tvReturnActive  = false;
        }
    } else {
        // SmoothReverse — animate the delta back to identity over the
        // captured slideReturnDurationMs.
        const float dur = slideReturnDurationMs > 0.0f
            ? slideReturnDurationMs : 200.0f;
        if (slideZprLatched || slideZprReturnActive) {
            // Return uses the slide ZPR's zoomEasing on all four channels,
            // matching the pre-v2 behaviour (it did not consult pan/rot
            // easing here).
            buildZprTracks(slideZprReturnTracks,
                           slideDeltaZoom,   1.0f,
                           slideDeltaPanX,   0.0f,
                           slideDeltaPanY,   0.0f,
                           slideDeltaRotDeg, 0.0f,
                           slideZoomEasing, slideZoomEasing, slideZoomEasing,
                           slideOvershoot);
            slideZprReturnActive     = true;
            slideZprReturnStartMs    = nowMs;
            slideZprReturnElapsedMs  = 0.0f;
            slideZprReturnDurationMs = dur;
        }
        if (tvSlideLatched || tvReturnActive) {
            tvReturnFromIntensity = tvRampIntensity;
            tvReturnActive        = true;
            tvReturnStartMs       = nowMs;
            tvReturnElapsedMs     = 0.0f;
            tvReturnDurationMs    = dur;
        }
    }

    composeOutputs();
}

// Public entry from FrameCollector when a normal-note onset is detected.
// Gates on slideReturnTrigger == NextNormalNote — under NextSlideNote the
// return is fired from AnimationManager::onSlideEvent instead.
void CellAnimation::onSlideReturnTrigger(double nowMs) {
    if (slideReturnTrigger != 0 /* NextNormalNote */) return;
    runReturnNow(nowMs);
}

// ===========================================================================
// AnimationManager
// ===========================================================================

void AnimationManager::advanceTo(double nowMs) {
    nowMs_ = nowMs;
    for (auto& [trackId, anim] : animations_) {
        anim.advance(nowMs);
    }
}

void AnimationManager::onNoteStart(int trackId, int noteId,
                                    const ZoomPanRotSettings& zpr,
                                    const BounceSettings& bounce,
                                    double bpm, float noteDurationMs) {
    auto& anim = animations_[trackId];
    anim.trackId = trackId;
    anim.triggerNote(noteId, zpr, bounce, nowMs_, bpm, noteDurationMs);
}

void AnimationManager::onSlideEvent(int trackId, float durationMs,
                                     const SlideNoteEffectSettings& cfg,
                                     float curveCx, float curveCy) {
    auto& anim = animations_[trackId];
    anim.trackId = trackId;

    const bool isLatched = anim.slideZprLatched || anim.tvSlideLatched
                        || anim.slideZprReturnActive || anim.tvReturnActive;

    // NextSlideNote toggle/consume: when a slide visual state is already
    // latched and the latched policy is NextSlideNote, this slide note is
    // *consumed* as the return trigger and does NOT also apply a new slide
    // effect. Produces the back-and-forth toggle the user expects:
    //   slide -> target, slide -> base, slide -> target, slide -> base, ...
    if (isLatched && anim.slideReturnTrigger == 1 /* NextSlideNote */) {
        anim.runReturnNow(nowMs_);
        return;
    }

    // Otherwise: trigger the slide normally. NextNormalNote mode chains
    // back-to-back slides — each one simply restarts the delta layer, which
    // has no baseline to preserve.
    anim.triggerSlide(durationMs, cfg, curveCx, curveCy, nowMs_);
}

void AnimationManager::onSlideReturnTrigger(int trackId) {
    auto it = animations_.find(trackId);
    if (it != animations_.end()) {
        it->second.onSlideReturnTrigger(nowMs_);
    }
}

const CellAnimation* AnimationManager::getAnimation(int trackId) const {
    auto it = animations_.find(trackId);
    if (it != animations_.end()) {
        return &it->second;
    }
    return nullptr;
}

void AnimationManager::resetTrack(int trackId) {
    auto it = animations_.find(trackId);
    if (it != animations_.end()) {
        it->second.reset();

#ifdef XLETH_DEBUG
        std::fprintf(stderr, "[AnimMgr] Track %d: reset\n", trackId);
#endif
    }
}

void AnimationManager::resetAll() {
    for (auto& [tid, anim] : animations_) {
        anim.reset();
    }
}
