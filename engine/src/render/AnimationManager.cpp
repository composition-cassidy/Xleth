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

float bezierEase(float t, float cx, float cy) {
    // Cubic bezier with control points (0,0), (cx,cy), (1-cx,1-cy), (1,1)
    float u = 1.0f - t;
    float tt = t * t;
    float uu = u * u;
    float y = 3.0f * uu * t * cy + 3.0f * u * tt * (1.0f - cy) + tt * t;
    return y;
}

// ===========================================================================
// CellAnimation
// ===========================================================================

void CellAnimation::triggerNote(int noteId, const ZoomPanRotSettings& zpr,
                                 const BounceSettings& bounce) {
    activeNoteId = noteId;

    // ZPR animation
    if (zpr.enabled) {
        zprActive     = true;
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

void CellAnimation::triggerSlide(float durationMs, int effectType,
                                  const ZoomPanRotSettings& zpr,
                                  const BounceSettings& bounce,
                                  float curveCx, float curveCy) {
    useSlideEasing = true;
    slideCurveCx   = curveCx;
    slideCurveCy   = curveCy;

    // effectType: 1=ZoomPanRot, 2=Bounce, 3=TVSimulator
    if (effectType == 1 && zpr.enabled) {
        zprActive     = true;
        zprElapsedMs  = 0.0f;
        zprDurationMs = durationMs;

        // Slide animation is additive — store in slide fields
        slideStartZoom      = zpr.startZoom;
        slideTargetZoom     = zpr.targetZoom;
        slideStartPanX      = zpr.startPanX;
        slideStartPanY      = zpr.startPanY;
        slideTargetPanX     = zpr.targetPanX;
        slideTargetPanY     = zpr.targetPanY;
        slideStartRotation  = zpr.startRotation;
        slideTargetRotation = zpr.targetRotation;
        zoomEasing   = zpr.zoomEasing;
        panEasing    = zpr.panEasing;
        rotEasing    = zpr.rotEasing;
        zprOvershoot = zpr.overshoot;
    }

    if (effectType == 2 && bounce.enabled) {
        bounceActive       = true;
        bounceElapsedMs    = 0.0f;
        bounceDurationMs   = durationMs;
        bounceDirectionDeg = bounce.directionDeg;
        bounceDistance      = bounce.distance;
        bounceSquashAmount  = bounce.squashAmount;
        bounceOvershoot     = bounce.overshoot;
        bounceRepeatCount   = bounce.repeatCount;
        bounceEasingType    = bounce.easingType;
    }

    if (effectType == 3) {
        tvRampActive     = true;
        tvRampElapsedMs  = 0.0f;
        tvRampDurationMs = durationMs;
        tvRampIntensity  = 1.0f;
    }

#ifdef XLETH_DEBUG
    std::fprintf(stderr, "[AnimMgr] Track %d: slide trigger, effectType=%d, duration=%.1fms, "
                 "curve=(%.2f,%.2f)\n",
                 trackId, effectType, durationMs, curveCx, curveCy);
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
            }
        } else {
            zprActive = false;
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

    // Advance TV ramp
    if (tvRampActive) {
        tvRampElapsedMs += deltaMs;
        if (tvRampDurationMs > 0.0f) {
            float t = std::min(tvRampElapsedMs / tvRampDurationMs, 1.0f);
            // Ramp down from 1.0 to 0.0
            tvRampIntensity = 1.0f - t;
            if (t >= 1.0f) {
                tvRampActive    = false;
                tvRampIntensity = 0.0f;
            }
        } else {
            tvRampActive = false;
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

    tvRampActive    = false;
    tvRampElapsedMs = 0.0f;
    tvRampIntensity = 0.0f;

    useSlideEasing  = false;
    activeNoteId    = -1;
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

void AnimationManager::onSlideEvent(int trackId, float durationMs, int effectType,
                                     const ZoomPanRotSettings& zpr,
                                     const BounceSettings& bounce,
                                     float curveCx, float curveCy) {
    auto& anim = animations_[trackId];
    anim.trackId = trackId;
    anim.triggerSlide(durationMs, effectType, zpr, bounce, curveCx, curveCy);
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
