#pragma once

// ─── Lens + Roam evaluation (P2) ──────────────────────────────────────────────
// docs/XLETH_LENS_ROAM_SPEC.md (locked). The ONE place the compositor's Lens
// and Roam geometry is computed. GridCompositor is the only caller, and both
// the live preview and export composite through GridCompositor, so the two
// cannot disagree (audit 2: "never write a second evaluator").
//
// Pure arithmetic: no D3D, no allocation, no locks, no logging. Safe on the
// render thread. Every function is a stateless function of its arguments.
//
// Conventions
//   * Rotation: degrees, positive = CLOCKWISE on screen (output V grows down),
//     the same sense as the Drop Shadow angle. Rotations are done in true
//     pixel space, so a rotated picture is never sheared by a non-square
//     cell or output.
//   * Lens works in the cell's LOCAL UV (0..1 across the framed cell) and
//     produces a SOURCE UV. Roam works in canvas-UV / output-UV rects.
//   * "Identity" is decided by exact compares on purpose: identity must take
//     today's bit-exact path, so "nearly identity" is not identity.

#include <algorithm>
#include <climits>
#include <cmath>

#include "model/LensRoam.h"

namespace lensroam {

// ─── Lens ────────────────────────────────────────────────────────────────────

// Affine map from cell-local UV to source UV:
//   sampleU = m00 * localU + m01 * localV + tx
//   sampleV = m10 * localU + m11 * localV + ty
// A sample outside [0,1] is "no source here": the cell background shows (an
// empty cell today is transparent over whatever lies behind it).
struct LensUvMap {
    float m00 = 1.0f, m01 = 0.0f, tx = 0.0f;
    float m10 = 0.0f, m11 = 1.0f, ty = 0.0f;
};

// True when the Lens moves pixels at all. Flip is NOT part of this: a flip
// override is an orientation, applied by the final draw like the track's own
// flip (see effectiveOrientation), so it costs no framing pass.
inline bool lensNeedsFraming(const LensParams& p) {
    return !(p.fit == LensFit::Stretch
             && p.centerX == 0.5f && p.centerY == 0.5f
             && p.zoom == 1.0f && p.rotationDeg == 0.0f);
}

// The orientation the final draw applies. FollowTrack passes the track's flip
// state machine through untouched; the others replace it. The final draw
// mirrors the already-framed cell, so the flip mirrors the framed result.
// Values are the shader's orientation enum (0 none, 1 horizontal, 2 vertical).
inline int effectiveOrientation(LensFlip flip, int trackOrientation) {
    switch (flip) {
        case LensFlip::None:       return 0;
        case LensFlip::Horizontal: return 1;
        case LensFlip::Vertical:   return 2;
        case LensFlip::FollowTrack:
        default:                   return trackOrientation;
    }
}

// Source pixel size to fit with. The decoded texture is the pixels actually
// drawn, but the preview may decode an aspect-preserving PROXY whose size was
// rounded, which would frame a hair differently from the export's source. So:
// when the texture's aspect is within 2% of the source's own (a proxy of it),
// fit with the SOURCE size, which preview and export both see identically;
// otherwise (a replacement file of another shape) trust the texture.
inline void fitSourceSize(int sourceW, int sourceH, int textureW, int textureH,
                          float& outW, float& outH) {
    const bool haveSource = sourceW > 0 && sourceH > 0;
    if (textureW <= 0 || textureH <= 0) {
        outW = static_cast<float>(haveSource ? sourceW : 1);
        outH = static_cast<float>(haveSource ? sourceH : 1);
        return;
    }
    outW = static_cast<float>(textureW);
    outH = static_cast<float>(textureH);
    if (!haveSource) return;
    const double srcAspect = static_cast<double>(sourceW) / sourceH;
    const double texAspect = static_cast<double>(outW) / outH;
    if (std::fabs(texAspect / srcAspect - 1.0) <= 0.02) {
        outW = static_cast<float>(sourceW);
        outH = static_cast<float>(sourceH);
    }
}

// Lens -> UV map.
//   cellW/cellH  the framed cell's size in OUTPUT pixels (only the aspect
//                matters). The framing box keeps this aspect in every fit.
//   srcW/srcH    the source picture's pixel size (see fitSourceSize).
//
// At zoom 1 the whole source is drawn at size (Sw, Sh) in cell pixels:
//   Stretch  (cellW, cellH)            today's behaviour, aspect ignored
//   Cover    src * max(cellW/srcW, cellH/srcH)   fills, overflow cropped
//   Contain  src * min(cellW/srcW, cellH/srcH)   fits, rest letterboxed
// Source point (centerX, centerY) sits at the cell centre; zoom scales the
// picture about it; rotationDeg turns it clockwise. Inverting that for a cell
// pixel at offset d from the centre (cell pixels):
//   q      = R(-theta) * d / zoom               (zoom-1 picture pixels)
//   sample = center + q / (Sw, Sh)
inline LensUvMap computeLensUvMap(const LensParams& p,
                                  float cellW, float cellH,
                                  float srcW, float srcH) {
    LensUvMap m;
    if (!(cellW > 0.0f) || !(cellH > 0.0f)) return m;
    if (!(srcW > 0.0f) || !(srcH > 0.0f)) { srcW = cellW; srcH = cellH; }

    double sw = cellW, sh = cellH;                       // Stretch
    if (p.fit == LensFit::Cover || p.fit == LensFit::Contain) {
        const double kx = static_cast<double>(cellW) / srcW;
        const double ky = static_cast<double>(cellH) / srcH;
        const double k  = (p.fit == LensFit::Cover) ? std::max(kx, ky) : std::min(kx, ky);
        sw = srcW * k;
        sh = srcH * k;
    }

    // A zoom of 0 (or garbage) would divide by zero; the model already
    // rejects non-finite values, this only bounds the range.
    double z = std::isfinite(p.zoom) ? static_cast<double>(p.zoom) : 1.0;
    z = std::clamp(z, 1e-3, 1e3);
    const double rot = std::isfinite(p.rotationDeg) ? static_cast<double>(p.rotationDeg) : 0.0;
    const double th  = rot * 3.14159265358979323846 / 180.0;
    const double c = std::cos(th), s = std::sin(th);

    // M = diag(1/(z Sw), 1/(z Sh)) * [c s; -s c] * diag(cellW, cellH)
    const double a00 =  c * cellW / (z * sw);
    const double a01 =  s * cellH / (z * sw);
    const double a10 = -s * cellW / (z * sh);
    const double a11 =  c * cellH / (z * sh);

    const double cx = std::isfinite(p.centerX) ? p.centerX : 0.5;
    const double cy = std::isfinite(p.centerY) ? p.centerY : 0.5;

    // sample = center + M * (local - 0.5)  ->  fold the -0.5 into t.
    m.m00 = static_cast<float>(a00);
    m.m01 = static_cast<float>(a01);
    m.m10 = static_cast<float>(a10);
    m.m11 = static_cast<float>(a11);
    m.tx  = static_cast<float>(cx - 0.5 * (a00 + a01));
    m.ty  = static_cast<float>(cy - 0.5 * (a10 + a11));
    return m;
}

inline void applyLensUvMap(const LensUvMap& m, float u, float v, float& su, float& sv) {
    su = m.m00 * u + m.m01 * v + m.tx;
    sv = m.m10 * u + m.m11 * v + m.ty;
}

// ─── Roam ────────────────────────────────────────────────────────────────────

struct UvRect {
    float x = 0.0f, y = 0.0f, w = 1.0f, h = 1.0f;
};

// True when Roam changes the cell's geometry or its clipping. A Roam whose
// only non-default field is `layer` under Clip changes nothing (the layer is
// honoured only for Float), so it stays on today's path too.
inline bool roamMovesCell(const RoamParams& r) {
    return r.offsetX != 0.0f || r.offsetY != 0.0f
        || r.scale != 1.0f || r.scaleYEff() != 1.0f || r.rotationDeg != 0.0f;
}

// Bounds Clip scissors the moved cell to its home rect. Only when Roam is
// actually doing something: identity Roam (bounds = Clip by default) must keep
// today's unclipped draw, or a bounce overshoot would suddenly be cut off.
inline bool roamClipsToHome(const RoamParams& r) {
    return r.bounds == RoamBounds::Clip && roamMovesCell(r);
}

// Spec order: grid rect -> offset (cell units) -> scale -> rotation about the
// cell centre. `home` is the rect the cell occupies with no Roam (gap and the
// per-note bounce already applied); `unitW/unitH` is one cell — the track's
// own placement before the gap, so offset 1.0 lands exactly one placement
// over, half-grid spans included. A fullscreen layer's unit is the canvas.
// Rotation is returned, not applied: an axis-aligned rect cannot express it;
// the final draw rotates about the returned rect's centre.
inline UvRect roamCellRect(const RoamParams& r, const UvRect& home,
                           float unitW, float unitH, float& outRotationRad) {
    UvRect q = home;
    const float ox = std::isfinite(r.offsetX) ? r.offsetX : 0.0f;
    const float oy = std::isfinite(r.offsetY) ? r.offsetY : 0.0f;
    q.x += ox * unitW;
    q.y += oy * unitH;
    float sc = std::isfinite(r.scale) ? r.scale : 1.0f;
    sc = std::clamp(sc, 1e-3f, 1e3f);
    // Linked (the default) scaleYEff() == scale, so h takes the very same
    // multiply as before the split.
    float scY = std::isfinite(r.scaleYEff()) ? r.scaleYEff() : 1.0f;
    scY = std::clamp(scY, 1e-3f, 1e3f);
    if (sc != 1.0f || scY != 1.0f) {
        const float cx = q.x + q.w * 0.5f;
        const float cy = q.y + q.h * 0.5f;
        q.w *= sc;
        q.h *= scY;
        q.x = cx - q.w * 0.5f;
        q.y = cy - q.h * 0.5f;
    }
    const float deg = std::isfinite(r.rotationDeg) ? r.rotationDeg : 0.0f;
    outRotationRad = deg * 0.017453292519943295f;
    return q;
}

// Inverse of "rect rotated clockwise by rotRad about its centre", as an affine
// map from OUTPUT-UV to the rect's local UV (0..1 inside the unrotated rect):
//   localU = r00 * u + r01 * v + r02
//   localV = r10 * u + r11 * v + r12
// Done in output pixels (outW x outH) so the rotation is rigid on screen.
struct RoamInverse {
    float r00 = 1.0f, r01 = 0.0f, r02 = 0.0f;
    float r10 = 0.0f, r11 = 1.0f, r12 = 0.0f;
};

inline RoamInverse computeRoamInverse(const UvRect& rect, float rotRad,
                                      float outW, float outH) {
    RoamInverse inv;
    if (!(rect.w > 0.0f) || !(rect.h > 0.0f) || !(outW > 0.0f) || !(outH > 0.0f)) {
        return inv;
    }
    const double c = std::cos(static_cast<double>(rotRad));
    const double s = std::sin(static_cast<double>(rotRad));
    const double cx = rect.x + rect.w * 0.5;
    const double cy = rect.y + rect.h * 0.5;
    // e = R(-theta) * ((u - cx) W, (v - cy) H);  local = 0.5 + e / (w W, h H)
    const double a00 =  c / rect.w;
    const double a01 =  s * outH / (static_cast<double>(rect.w) * outW);
    const double a10 = -s * outW / (static_cast<double>(rect.h) * outH);
    const double a11 =  c / rect.h;
    inv.r00 = static_cast<float>(a00);
    inv.r01 = static_cast<float>(a01);
    inv.r02 = static_cast<float>(0.5 - a00 * cx - a01 * cy);
    inv.r10 = static_cast<float>(a10);
    inv.r11 = static_cast<float>(a11);
    inv.r12 = static_cast<float>(0.5 - a10 * cx - a11 * cy);
    return inv;
}

// Home-rect scissor in output pixels. A pixel is drawn when its centre lies
// inside the rect, matching the shader's own rect test, hence round-to-nearest
// on each edge rather than floor/ceil.
struct PixelRect {
    long left = 0, top = 0, right = 0, bottom = 0;
};

inline PixelRect homeScissor(const UvRect& homeOut, int outW, int outH) {
    PixelRect p;
    p.left   = std::lround(static_cast<double>(homeOut.x) * outW);
    p.top    = std::lround(static_cast<double>(homeOut.y) * outH);
    p.right  = std::lround(static_cast<double>(homeOut.x + homeOut.w) * outW);
    p.bottom = std::lround(static_cast<double>(homeOut.y + homeOut.h) * outH);
    p.left   = std::clamp(p.left,   0L, static_cast<long>(outW));
    p.right  = std::clamp(p.right,  0L, static_cast<long>(outW));
    p.top    = std::clamp(p.top,    0L, static_cast<long>(outH));
    p.bottom = std::clamp(p.bottom, 0L, static_cast<long>(outH));
    if (p.right < p.left)  p.right  = p.left;
    if (p.bottom < p.top)  p.bottom = p.top;
    return p;
}

// ─── Draw order ──────────────────────────────────────────────────────────────
// Spec: Bounds Float draws per layer (GridOrder | AboveNeighbours | Top). Clip
// ignores the layer: a cell clipped to its home rect cannot cover a neighbour.
// Sort key (primary, secondary), compared lexicographically by the collector's
// single stable_sort:
//   GridOrder        (zOrder, 0)          today's order
//   AboveNeighbours  (max(zOrder,         after every grid cell, still under a
//                     maxGridZOrder), 1)  fullscreen layer stacked above the grid
//   Top              (INT_MAX, 2)         after everything
// maxGridZOrder: the highest zOrder among this frame's GRID requests (INT_MIN
// when there are none).
inline RoamLayer effectiveRoamLayer(const RoamParams& r) {
    return r.bounds == RoamBounds::Float ? r.layer : RoamLayer::GridOrder;
}

struct DrawKey {
    int primary   = 0;
    int secondary = 0;
    bool operator<(const DrawKey& o) const {
        return primary != o.primary ? primary < o.primary : secondary < o.secondary;
    }
};

inline DrawKey drawKeyFor(RoamLayer layer, int zOrder, int maxGridZOrder) {
    switch (layer) {
        case RoamLayer::AboveNeighbours: return { std::max(zOrder, maxGridZOrder), 1 };
        case RoamLayer::Top:             return { INT_MAX, 2 };
        case RoamLayer::GridOrder:
        default:                         return { zOrder, 0 };
    }
}

inline DrawKey roamDrawKey(const RoamParams& r, int zOrder, int maxGridZOrder) {
    return drawKeyFor(effectiveRoamLayer(r), zOrder, maxGridZOrder);
}

// Motion view R10 (docs/XLETH_MOTION_VIEW_DESIGN.md): the layer a cell draws
// on. A PARENTED cell honours its Roam layer under Bounds Clip as it does under
// Float, because its parent can carry it over its neighbours. An unparented
// cell is effectiveRoamLayer, unchanged.
inline RoamLayer drawLayer(const RoamParams& r, bool parented) {
    return parented ? r.layer : effectiveRoamLayer(r);
}

} // namespace lensroam
