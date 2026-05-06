#include "AnimationManager.h"
#include "model/TimelineTypes.h"

#include <algorithm>

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
// CellAnimation
// ===========================================================================

void CellAnimation::triggerNote(int noteId, const ZoomPanRotSettings& zpr,
                                 const BounceSettings& bounce) {
    activeNoteId = noteId;

    // A note's own ZPR (if enabled) wins over any in-flight slide return:
    // the user explicitly animated this cell on the new note, so cancel the
    // smooth-reverse return and clear the latch. The new note's start values
    // become the new baseline for any subsequent slide.
    if (zpr.enabled) {
        zprReturnActive = false;
        zprSlideLatched = false;
    }

    // ZPR animation
    if (zpr.enabled) {
        zprActive          = true;
        zprIsSlideTriggered = false;   // note-triggered ZPRs do NOT latch
        zprElapsedMs  = 0.0f;
        zprDurationMs = zpr.durationMs;
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

        // Set initial values
        currentZoom   = startZoom;
        currentPanX   = startPanX;
        currentPanY   = startPanY;
        currentRotDeg = startRotation;
    }

    // Bounce animation
    if (bounce.enabled) {
        bounceActive       = true;
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

#ifdef XLETH_DEBUG
    std::fprintf(stderr, "[AnimMgr] Track %d: note trigger, noteId=%d, zpr=%s, bounce=%s\n",
                 trackId, noteId, zpr.enabled ? "on" : "off", bounce.enabled ? "on" : "off");
#endif
}

void CellAnimation::triggerSlide(float durationMs,
                                  const SlideNoteEffectSettings& cfg,
                                  float curveCx, float curveCy) {
    using EffectType = SlideNoteEffectSettings::EffectType;

    // Snapshot the return policy that will govern this slide's lifetime.
    // The latched cell honors *this* policy on return, even if the user
    // changes it on the track later.
    slideReturnStyle      = static_cast<int>(cfg.returnStyle);
    slideReturnTrigger    = static_cast<int>(cfg.returnTrigger);
    slideReturnDurationMs = cfg.returnDurationMs;

    // Capture per-effect baseline only on a "fresh" slide — i.e., when no
    // slide is currently latched and no return is mid-flight. This preserves
    // the user's true pre-slide state across chained slides (NextNormalNote
    // chain-while-latched, or any back-to-back slides during a return).
    const bool zprFresh = !zprSlideLatched && !zprReturnActive;
    const bool tvFresh  = !tvSlideLatched  && !tvReturnActive;

    // useSlideEasing is set per-effect below: ZPR slide honors its own Easing
    // dropdown (bezier curve does NOT override it); Bounce slide still uses
    // the slide note's bezier curve to shape the arc.
    if (cfg.type == EffectType::ZoomPanRot) {
        const auto& z = cfg.zoomPanRot;

        // Capture pre-slide baseline BEFORE overwriting current* below.
        if (zprFresh) {
            zprBaseZoom   = currentZoom;
            zprBasePanX   = currentPanX;
            zprBasePanY   = currentPanY;
            zprBaseRotDeg = currentRotDeg;
        }

        // A fresh slide overrides any in-flight return on this effect.
        zprReturnActive    = false;
        zprSlideLatched    = false;
        zprIsSlideTriggered = true;

        zprActive       = true;
        zprElapsedMs    = 0.0f;
        zprDurationMs   = durationMs;

        // Absolute keyframes — matches the Visual FX ZPR module exactly.
        startZoom       = z.startZoom;
        targetZoom      = z.targetZoom;
        startPanX       = z.startPanX;     targetPanX     = z.targetPanX;
        startPanY       = z.startPanY;     targetPanY     = z.targetPanY;
        startRotation   = z.startRotation; targetRotation = z.targetRotation;
        zoomEasing      = z.zoomEasing;
        panEasing       = z.panEasing;
        rotEasing       = z.rotEasing;
        zprOvershoot    = z.overshoot;

        // Seed current values to the start keyframe so the first rendered
        // frame matches the start state instead of jumping from the cell's
        // pre-slide pose.
        currentZoom     = startZoom;
        currentPanX     = startPanX;
        currentPanY     = startPanY;
        currentRotDeg   = startRotation;

        useSlideEasing  = false;  // ZPR slide uses its own per-axis easing.
    }

    if (cfg.type == EffectType::Bounce) {
        const auto& b      = cfg.bounce;
        bounceActive       = true;
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

#ifdef XLETH_DEBUG
    std::fprintf(stderr, "[AnimMgr] Track %d: slide trigger, effectType=%d, duration=%.1fms, "
                 "curve=(%.2f,%.2f)\n",
                 trackId, static_cast<int>(cfg.type), durationMs, curveCx, curveCy);
#endif
}

void CellAnimation::advance(float deltaMs) {
    // Advance ZPR animation
    if (zprActive) {
        zprElapsedMs += deltaMs;
        if (zprDurationMs > 0.0f) {
            float t = std::min(zprElapsedMs / zprDurationMs, 1.0f);

            // Use slide bezier easing if triggered by a slide, otherwise preset easing
            float zt, pt, rt;
            if (useSlideEasing) {
                zt = bezierEase(t, slideCurveCx, slideCurveCy);
                pt = zt;
                rt = zt;
            } else {
                zt = applyEasing(t, zoomEasing, zprOvershoot);
                pt = applyEasing(t, panEasing, zprOvershoot);
                rt = applyEasing(t, rotEasing, zprOvershoot);
            }

            currentZoom   = startZoom + (targetZoom - startZoom) * zt;
            currentPanX   = startPanX + (targetPanX - startPanX) * pt;
            currentPanY   = startPanY + (targetPanY - startPanY) * pt;
            currentRotDeg = startRotation + (targetRotation - startRotation) * rt;

            if (t >= 1.0f) {
                zprActive = false;
                if (zprIsSlideTriggered) {
                    // Hold at target until a return trigger fires (the bug
                    // fix: previously the cell stayed at target *forever*).
                    zprSlideLatched = true;
                }
            }
        } else {
            zprActive = false;
        }
    }

    // Advance ZPR return animation (SmoothReverse). Runs current* back to
    // captured base* over zprReturnDurationMs.
    if (zprReturnActive) {
        zprReturnElapsedMs += deltaMs;
        if (zprReturnDurationMs > 0.0f) {
            float t  = std::min(zprReturnElapsedMs / zprReturnDurationMs, 1.0f);
            float et = applyEasing(t, zoomEasing, zprOvershoot);
            currentZoom   = zprReturnFromZoom   + (zprBaseZoom   - zprReturnFromZoom)   * et;
            currentPanX   = zprReturnFromPanX   + (zprBasePanX   - zprReturnFromPanX)   * et;
            currentPanY   = zprReturnFromPanY   + (zprBasePanY   - zprReturnFromPanY)   * et;
            currentRotDeg = zprReturnFromRotDeg + (zprBaseRotDeg - zprReturnFromRotDeg) * et;
            if (t >= 1.0f) {
                currentZoom     = zprBaseZoom;
                currentPanX     = zprBasePanX;
                currentPanY     = zprBasePanY;
                currentRotDeg   = zprBaseRotDeg;
                zprReturnActive = false;
                zprSlideLatched = false;       // baseline can be re-captured next slide
            }
        } else {
            currentZoom     = zprBaseZoom;
            currentPanX     = zprBasePanX;
            currentPanY     = zprBasePanY;
            currentRotDeg   = zprBaseRotDeg;
            zprReturnActive = false;
            zprSlideLatched = false;
        }
    }

    // Advance bounce animation (per-repeat with decay)
    if (bounceActive) {
        bounceElapsedMs += deltaMs;
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
        tvRampElapsedMs += deltaMs;
        if (tvRampDurationMs > 0.0f) {
            float t = std::min(tvRampElapsedMs / tvRampDurationMs, 1.0f);
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
        tvReturnElapsedMs += deltaMs;
        if (tvReturnDurationMs > 0.0f) {
            float t = std::min(tvReturnElapsedMs / tvReturnDurationMs, 1.0f);
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
}

void CellAnimation::reset() {
    zprActive       = false;
    zprElapsedMs    = 0.0f;
    currentZoom     = 1.0f;
    currentPanX     = 0.0f;
    currentPanY     = 0.0f;
    currentRotDeg   = 0.0f;

    bounceActive    = false;
    bounceElapsedMs = 0.0f;
    bounceOffsetX   = 0.0f;
    bounceOffsetY   = 0.0f;
    bounceScaleX    = 1.0f;
    bounceScaleY    = 1.0f;

    tvRampActive        = false;
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

    // Slide return system — clear latch, baseline, and any in-flight return
    // so seek-back / loop wraparound / explicit resetTrack starts clean.
    slideReturnStyle      = 1;
    slideReturnTrigger    = 0;
    slideReturnDurationMs = 200.0f;
    zprIsSlideTriggered   = false;
    zprSlideLatched       = false;
    zprBaseZoom           = 1.0f;
    zprBasePanX           = 0.0f;
    zprBasePanY           = 0.0f;
    zprBaseRotDeg         = 0.0f;
    zprReturnActive       = false;
    zprReturnElapsedMs    = 0.0f;
    zprReturnDurationMs   = 0.0f;
    zprReturnFromZoom     = 1.0f;
    zprReturnFromPanX     = 0.0f;
    zprReturnFromPanY     = 0.0f;
    zprReturnFromRotDeg   = 0.0f;
    tvSlideLatched        = false;
    tvReturnActive        = false;
    tvReturnElapsedMs     = 0.0f;
    tvReturnDurationMs    = 0.0f;
    tvReturnFromIntensity = 0.0f;
}

// Snap to base (Instant) or kick off the SmoothReverse animation. Bypasses
// the policy gate — callers are responsible for deciding whether the trigger
// applies (NextNormalNote vs NextSlideNote).
void CellAnimation::runReturnNow() {
    const bool latched = zprSlideLatched || tvSlideLatched
                      || zprReturnActive || tvReturnActive;
    if (!latched) return;

    const bool instant = (slideReturnStyle == 0);

    // A return supersedes any in-flight slide animation (we may be returning
    // mid-flight when a NextSlideNote event consumed a still-animating slide).
    if (zprIsSlideTriggered) zprActive = false;
    tvRampActive = false;

    if (instant) {
        if (zprSlideLatched || zprReturnActive) {
            currentZoom     = zprBaseZoom;
            currentPanX     = zprBasePanX;
            currentPanY     = zprBasePanY;
            currentRotDeg   = zprBaseRotDeg;
            zprSlideLatched = false;
            zprReturnActive = false;
        }
        if (tvSlideLatched || tvReturnActive) {
            tvRampIntensity = 0.0f;
            tvSlideLatched  = false;
            tvReturnActive  = false;
        }
    } else {
        // SmoothReverse — animate from current* back to base* over the
        // captured slideReturnDurationMs.
        const float dur = slideReturnDurationMs > 0.0f
            ? slideReturnDurationMs : 200.0f;
        if (zprSlideLatched || zprReturnActive) {
            zprReturnFromZoom   = currentZoom;
            zprReturnFromPanX   = currentPanX;
            zprReturnFromPanY   = currentPanY;
            zprReturnFromRotDeg = currentRotDeg;
            zprReturnActive     = true;
            zprReturnElapsedMs  = 0.0f;
            zprReturnDurationMs = dur;
        }
        if (tvSlideLatched || tvReturnActive) {
            tvReturnFromIntensity = tvRampIntensity;
            tvReturnActive        = true;
            tvReturnElapsedMs     = 0.0f;
            tvReturnDurationMs    = dur;
        }
    }
}

// Public entry from FrameCollector when a normal-note onset is detected.
// Gates on slideReturnTrigger == NextNormalNote — under NextSlideNote the
// return is fired from AnimationManager::onSlideEvent instead.
void CellAnimation::onSlideReturnTrigger() {
    if (slideReturnTrigger != 0 /* NextNormalNote */) return;
    runReturnNow();
}

// ===========================================================================
// AnimationManager
// ===========================================================================

void AnimationManager::advanceAll(float deltaMs) {
    for (auto& [trackId, anim] : animations_) {
        anim.advance(deltaMs);
    }
}

void AnimationManager::onNoteStart(int trackId, int noteId,
                                    const ZoomPanRotSettings& zpr,
                                    const BounceSettings& bounce) {
    auto& anim = animations_[trackId];
    anim.trackId = trackId;
    anim.triggerNote(noteId, zpr, bounce);
}

void AnimationManager::onSlideEvent(int trackId, float durationMs,
                                     const SlideNoteEffectSettings& cfg,
                                     float curveCx, float curveCy) {
    auto& anim = animations_[trackId];
    anim.trackId = trackId;

    const bool isLatched = anim.zprSlideLatched || anim.tvSlideLatched
                        || anim.zprReturnActive || anim.tvReturnActive;

    // NextSlideNote toggle/consume: when a slide visual state is already
    // latched and the latched policy is NextSlideNote, this slide note is
    // *consumed* as the return trigger and does NOT also apply a new slide
    // effect. Produces the back-and-forth toggle the user expects:
    //   slide -> target, slide -> base, slide -> target, slide -> base, ...
    if (isLatched && anim.slideReturnTrigger == 1 /* NextSlideNote */) {
        anim.runReturnNow();
        return;
    }

    // Otherwise: trigger the slide normally. NextNormalNote mode chains
    // back-to-back slides; baseline is preserved by triggerSlide because
    // the latch/return guards prevent a re-capture while latched.
    anim.triggerSlide(durationMs, cfg, curveCx, curveCy);
}

void AnimationManager::onSlideReturnTrigger(int trackId) {
    auto it = animations_.find(trackId);
    if (it != animations_.end()) {
        it->second.onSlideReturnTrigger();
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
