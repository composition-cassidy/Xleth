#pragma once

// ─── Motion blur for transform animation ─────────────────────────────────────
// A virtual shutter, open for `shutterAngle / 360` of each output frame and
// centred on the frame's own time. Everything that MOVES a picture through an
// animation (Lens, Sweep, Roam, Zoom/pan/rot) is sampled at several instants
// inside that window and the compositor averages the moved picture over them,
// so a fast move smears along its path instead of strobing. Only the transform
// is integrated: the decoded video's own pixels are never blurred.
//
// Split of work (the same discipline as LensRoamMath.h, which this builds on):
//   * FrameCollector evaluates the animated parameters at kDenseSamples
//     sub-frame instants (Lens/Sweep/Roam are pure functions of the tick; ZPR
//     is sampled from a scratch copy of its animation state) and stores them
//     on the request as plain values, only when they actually change across
//     the shutter.
//   * GridCompositor turns those into affine maps, measures how far the
//     picture travels ON SCREEN, and picks a tap count from that (about one
//     tap per output pixel of travel, 2..kMaxTaps), resampling the dense
//     samples to that many taps. A cell that does not move takes today's
//     single-sample path, bit for bit.
//
// Pure arithmetic: no D3D, no allocation, no locks. Safe on the render thread.
// Preview and export composite through the same code, so they agree.

#include <algorithm>
#include <cmath>

#include "LensRoamMath.h"

namespace motionblur {

// Sub-frame samples the collector takes across the shutter.
constexpr int kDenseSamples = 32;
// Upper bound on GPU taps per pixel (the shader's array size; must match
// MAX_MOTION_TAPS in GridComposite.hlsl and FX_ZoomPanRotation.hlsl).
constexpr int kMaxTaps = 32;
// Travel, in output pixels, below which the move is not worth blurring.
constexpr double kMinBlurPx = 0.5;
// Output pixels of travel per tap. 1 = adjacent taps never sit more than a
// pixel apart, so the smear reads as continuous up to kMaxTaps px of travel.
constexpr double kPxPerTap = 1.0;

// Dense sample i of n, as an offset from the frame time in units of the
// shutter interval: stratified, centred, symmetric (-0.5..+0.5 exclusive).
inline double sampleOffset(int i, int n) {
    return (static_cast<double>(i) + 0.5) / static_cast<double>(n) - 0.5;
}

// How long the shutter is open, in seconds, at this output frame rate.
inline double shutterSeconds(float shutterAngleDeg, double fps) {
    if (!(fps > 0.0) || !(shutterAngleDeg > 0.0f)) return 0.0;
    return static_cast<double>(shutterAngleDeg) / 360.0 / fps;
}

// Tap count for a picture that travels `pathPx` output pixels while the
// shutter is open. 0 = no blur.
inline int tapsForPathPx(double pathPx) {
    if (!(pathPx >= kMinBlurPx)) return 0;
    const double n = std::ceil(pathPx / kPxPerTap);
    return static_cast<int>(std::clamp(n, 2.0, static_cast<double>(kMaxTaps)));
}

// ─── 2x3 affine maps ────────────────────────────────────────────────────────
//   x' = m00 * x + m01 * y + tx
//   y' = m10 * x + m11 * y + ty
struct Affine {
    double m00 = 1.0, m01 = 0.0, tx = 0.0;
    double m10 = 0.0, m11 = 1.0, ty = 0.0;
};

inline void apply(const Affine& a, double x, double y, double& ox, double& oy) {
    ox = a.m00 * x + a.m01 * y + a.tx;
    oy = a.m10 * x + a.m11 * y + a.ty;
}

// Inverse; a singular map returns identity (a degenerate pose: nothing to measure).
inline Affine invert(const Affine& a) {
    const double det = a.m00 * a.m11 - a.m01 * a.m10;
    Affine r;
    if (!(std::fabs(det) > 1e-12) || !std::isfinite(det)) return r;
    const double id = 1.0 / det;
    r.m00 =  a.m11 * id;
    r.m01 = -a.m01 * id;
    r.m10 = -a.m10 * id;
    r.m11 =  a.m00 * id;
    r.tx  = -(r.m00 * a.tx + r.m01 * a.ty);
    r.ty  = -(r.m10 * a.tx + r.m11 * a.ty);
    return r;
}

inline Affine lerp(const Affine& a, const Affine& b, double t) {
    Affine r;
    r.m00 = a.m00 + (b.m00 - a.m00) * t;
    r.m01 = a.m01 + (b.m01 - a.m01) * t;
    r.tx  = a.tx  + (b.tx  - a.tx)  * t;
    r.m10 = a.m10 + (b.m10 - a.m10) * t;
    r.m11 = a.m11 + (b.m11 - a.m11) * t;
    r.ty  = a.ty  + (b.ty  - a.ty)  * t;
    return r;
}

// Tap `tap` of `taps`, resampled from `n` dense maps taken at sampleOffset(i, n):
// the dense curve evaluated at the tap's own stratified instant, linearly
// interpolated between its two neighbours (held at the ends).
inline double denseIndexForTap(int tap, int taps, int n) {
    const double f = ((static_cast<double>(tap) + 0.5) / taps) * n - 0.5;
    return std::clamp(f, 0.0, static_cast<double>(n - 1));
}

inline Affine resampleAffine(const Affine* dense, int n, int tap, int taps) {
    const double f  = denseIndexForTap(tap, taps, n);
    const int    i0 = static_cast<int>(std::floor(f));
    const int    i1 = std::min(i0 + 1, n - 1);
    return lerp(dense[i0], dense[i1], f - i0);
}

// On-screen travel of a moving picture across the shutter, in pixels.
// `maps[i]` maps the drawn space to the space the picture lives in at dense
// instant i; `toCenter` brings that back into the drawn space at the frame
// time (the inverse of the frame-time map; identity when the maps already land
// in the drawn space). `probes` are points of the drawn space (unit-UV of
// whatever is drawn) and (sx, sy) its size in output pixels. Returns the
// longest polyline any probe traces.
inline double pathLengthPx(const Affine* maps, int n, const Affine& toCenter,
                           const double (*probes)[2], int probeCount,
                           double sx, double sy) {
    double longest = 0.0;
    for (int p = 0; p < probeCount; ++p) {
        double len = 0.0, px = 0.0, py = 0.0;
        for (int i = 0; i < n; ++i) {
            double ax, ay, cx, cy;
            apply(maps[i], probes[p][0], probes[p][1], ax, ay);
            apply(toCenter, ax, ay, cx, cy);
            if (i > 0) {
                const double dx = (cx - px) * sx;
                const double dy = (cy - py) * sy;
                len += std::sqrt(dx * dx + dy * dy);
            }
            px = cx; py = cy;
        }
        if (std::isfinite(len)) longest = std::max(longest, len);
    }
    return longest;
}

// The unit square's corners and centre: where a move is most visible.
inline const double (*unitProbes())[2] {
    static const double k[5][2] = { {0.0, 0.0}, {1.0, 0.0}, {0.0, 1.0}, {1.0, 1.0}, {0.5, 0.5} };
    return k;
}
constexpr int kUnitProbeCount = 5;

// ─── Lens ───────────────────────────────────────────────────────────────────

inline bool lensMoved(const LensParams& a, const LensParams& b) {
    return a.centerX != b.centerX || a.centerY != b.centerY
        || a.zoom != b.zoom || a.rotationDeg != b.rotationDeg;
}

inline Affine fromLensMap(const lensroam::LensUvMap& m) {
    Affine a;
    a.m00 = m.m00; a.m01 = m.m01; a.tx = m.tx;
    a.m10 = m.m10; a.m11 = m.m11; a.ty = m.ty;
    return a;
}

// ─── Roam ───────────────────────────────────────────────────────────────────

inline bool roamMoved(const RoamParams& a, const RoamParams& b) {
    return a.offsetX != b.offsetX || a.offsetY != b.offsetY
        || a.scale != b.scale || a.scaleYEff() != b.scaleYEff() || a.rotationDeg != b.rotationDeg;
}

// Screen-space motion of a Roamed cell, as the map from OUTPUT-UV at a
// sub-frame instant back to OUTPUT-UV at the frame time. With it, every final
// draw of the request (the cell, its echo taps, its drop shadow) moves as one
// object: a tap reads the frame-time picture at Dinv(uv), then runs the draw's
// own mapping as usual.
//   centre pose: rect `c`, rotation `cRot`;  sub pose: rect `s`, rotation `sRot`
// Both rects are output-UV. For a uniform scale they share the aspect Roam
// keeps, so the sub pose is the centre pose scaled by k = s.w / c.w about its centre,
// turned by (sRot - cRot) and moved to the sub centre. In output pixels:
//   P' = cc + (1/k) R(-(sRot - cRot)) (P - sc)
// with R(-d) = [cos d, sin d; -sin d, cos d] (positive = clockwise on screen,
// the convention of lensroam::computeRoamInverse).
inline Affine roamScreenDelta(const lensroam::UvRect& c, float cRot,
                              const lensroam::UvRect& s, float sRot,
                              double outW, double outH) {
    Affine a;
    if (!(c.w > 0.0f) || !(s.w > 0.0f) || !(outW > 0.0) || !(outH > 0.0)) return a;
    const double k  = static_cast<double>(s.w) / c.w;
    const double d  = static_cast<double>(sRot) - cRot;
    const double co = std::cos(d) / k, si = std::sin(d) / k;
    const double ccx = c.x + c.w * 0.5, ccy = c.y + c.h * 0.5;
    const double scx = s.x + s.w * 0.5, scy = s.y + s.h * 0.5;
    // Independent Scale X / Y: the pose is no longer a similarity, so the width
    // ratio alone is wrong. A uniform pair (every linked cell) keeps the exact
    // arithmetic below; only a real X != Y difference takes the general map
    //   P' = cc + R(cRot) diag(c.w/s.w, c.h/s.h) R(-sRot) (P - sc).
    if (c.h > 0.0f && s.h > 0.0f) {
        const double ky = static_cast<double>(s.h) / c.h;
        if (std::fabs(k - ky) > 1e-6 * std::max(k, ky)) {
            const double dx = 1.0 / k, dy = 1.0 / ky;
            const double cc = std::cos(static_cast<double>(cRot)), sc = std::sin(static_cast<double>(cRot));
            const double cs = std::cos(static_cast<double>(sRot)), ss = std::sin(static_cast<double>(sRot));
            const double A00 = cc * dx * cs + sc * dy * ss;
            const double A01 = cc * dx * ss - sc * dy * cs;
            const double A10 = sc * dx * cs - cc * dy * ss;
            const double A11 = sc * dx * ss + cc * dy * cs;
            a.m00 = A00;
            a.m01 = A01 * outH / outW;
            a.m10 = A10 * outW / outH;
            a.m11 = A11;
            a.tx  = ccx - a.m00 * scx - a.m01 * scy;
            a.ty  = ccy - a.m10 * scx - a.m11 * scy;
            return a;
        }
    }
    a.m00 =  co;
    a.m01 =  si * outH / outW;
    a.m10 = -si * outW / outH;
    a.m11 =  co;
    a.tx  = ccx - a.m00 * scx - a.m01 * scy;
    a.ty  = ccy - a.m10 * scx - a.m11 * scy;
    return a;
}

// ─── Zoom / pan / rot ───────────────────────────────────────────────────────

// One ZPR pose in the units FX_ZoomPanRotation.hlsl takes (rotation in
// degrees here, radians on the GPU).
struct ZprPose {
    float zoom   = 1.0f;
    float panX   = 0.0f;
    float panY   = 0.0f;
    float rotDeg = 0.0f;
    bool operator!=(const ZprPose& o) const {
        return zoom != o.zoom || panX != o.panX || panY != o.panY || rotDeg != o.rotDeg;
    }
};

// The shader's dst-UV -> src-UV map for one pose (before its edge clamp):
//   d = uv - 0.5;  d.x *= aspect;  d = R(rot) d;  d.x /= aspect;
//   src = d / zoom - pan + 0.5,   R(r) d = (x cos r - y sin r, x sin r + y cos r)
// `aspect` = target width / height (the shader reads it from its texture).
inline Affine zprUvMap(const ZprPose& p, double aspect) {
    const double z  = std::max(static_cast<double>(p.zoom), 0.001);
    const double r  = static_cast<double>(p.rotDeg) * 3.14159265358979323846 / 180.0;
    const double co = std::cos(r), si = std::sin(r);
    const double as = aspect > 0.0 ? aspect : 1.0;
    Affine a;
    a.m00 = co / z;
    a.m01 = -si / (as * z);
    a.m10 = as * si / z;
    a.m11 = co / z;
    a.tx  = -0.5 * (a.m00 + a.m01) - p.panX + 0.5;
    a.ty  = -0.5 * (a.m10 + a.m11) - p.panY + 0.5;
    return a;
}

inline ZprPose resamplePose(const ZprPose* dense, int n, int tap, int taps) {
    const double f  = denseIndexForTap(tap, taps, n);
    const int    i0 = static_cast<int>(std::floor(f));
    const int    i1 = std::min(i0 + 1, n - 1);
    const float  t  = static_cast<float>(f - i0);
    const ZprPose& a = dense[i0];
    const ZprPose& b = dense[i1];
    ZprPose r;
    r.zoom   = a.zoom   + (b.zoom   - a.zoom)   * t;
    r.panX   = a.panX   + (b.panX   - a.panX)   * t;
    r.panY   = a.panY   + (b.panY   - a.panY)   * t;
    r.rotDeg = a.rotDeg + (b.rotDeg - a.rotDeg) * t;
    return r;
}

} // namespace motionblur
