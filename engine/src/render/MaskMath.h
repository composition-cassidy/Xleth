#pragma once

// ─── Masks: CPU side of the Mask pass (Motion view) ──────────────────────────
// docs/XLETH_MOTION_VIEW_DESIGN.md R11, R12, R13, 3.4.
//
// A track's masks arrive on the request as a MaskFrame (LensRoamSnapshot::
// masksAt): closed bezier paths in normalized CELL space (origin at the drawn
// cell's centre, x in [-0.5, 0.5] across its width, y in [-0.5, 0.5] down its
// height), tangents relative to their vertex. The compositor turns each path
// into a polygon in CELL PIXELS (the drawn cell's size in output pixels, about
// its centre), flattening every curved edge into at most kMaskMaxSegments
// lines (adaptive on its on-screen length) into a fixed array, and uploads
// that to FX_Mask.hlsl, which evaluates the coverage per texel.
//
// maskCoverage() below is the CPU reference of the shader's per-texel
// arithmetic (same formulas, same order), used by the tests to check the GPU
// pass to an 8-bit step.
//
// Pure arithmetic: no D3D, no allocation, no locks, no logging. Safe on the
// render thread.

#include <algorithm>
#include <cmath>
#include <cstdint>

#include "model/LensRoam.h"   // MaskFrame, MaskVertexF, kMaxMasksPerTrack, MaskMode

namespace maskmath {

// Lines per curved edge, at most. A straight edge (both tangents zero) is one.
constexpr int kMaskMaxSegments = 16;
// Points one cell can upload: every vertex of the per-track cap flattened to
// the segment cap, the four straight corners of the Roam crop rectangle, plus
// the four corners of the R9 carried-home clip quad.
constexpr int kMaskMaxPathPoints = kMaxMaskVerticesPerTrack * kMaskMaxSegments + kCropMaskPoints;    // 1088
constexpr int kMaskMaxPoints     = kMaskMaxPathPoints + 4;                                            // 1092

struct Point { float x = 0.0f, y = 0.0f; };

// Lines a cubic edge is drawn with: ceil(sqrt(control polygon length in px)),
// clamped to [2, kMaskMaxSegments]; 1 for a straight edge. Sagitta stays well
// under a pixel for a quarter ellipse of up to ~500 px radius.
inline int bezierSegments(Point p0, Point p1, Point p2, Point p3, bool straight) {
    if (straight) return 1;
    auto len = [](Point a, Point b) {
        const double dx = static_cast<double>(b.x) - a.x, dy = static_cast<double>(b.y) - a.y;
        return std::sqrt(dx * dx + dy * dy);
    };
    const double L = len(p0, p1) + len(p1, p2) + len(p2, p3);
    if (!std::isfinite(L)) return 1;
    const double n = std::ceil(std::sqrt(L));
    return static_cast<int>(std::clamp(n, 2.0, static_cast<double>(kMaskMaxSegments)));
}

// A rounded rectangle as polygon points, clockwise on screen (y down) from the top left:
// corners (x0,y0)-(x1,y1) in cell pixels, corner radius `radius` (held to half the
// shorter side). A zero radius is the four corners. Used for the Roam crop, so the
// cell's corner rounding follows the cropped edges. Returns the points written.
inline int roundedRectPoints(float x0, float y0, float x1, float y1, float radius,
                             Point* out, int cap) {
    if (!out || cap <= 0 || !(x1 > x0) || !(y1 > y0)) return 0;
    const float r = std::clamp(radius, 0.0f, 0.5f * std::min(x1 - x0, y1 - y0));
    int n = 0;
    auto put = [&](float x, float y) { if (n < cap) out[n++] = Point{ x, y }; };
    if (!(r > 0.01f)) {
        put(x0, y0); put(x1, y0); put(x1, y1); put(x0, y1);
        return n;
    }
    const int segs = std::clamp(static_cast<int>(std::ceil(std::sqrt(static_cast<double>(r)) * 1.6)), 4, 14);
    constexpr double kPi = 3.14159265358979323846;
    struct Corner { float cx, cy; double a0; };
    const Corner corners[4] = {
        { x0 + r, y0 + r, kPi },           // top left: from left to top
        { x1 - r, y0 + r, 1.5 * kPi },     // top right
        { x1 - r, y1 - r, 0.0 },           // bottom right
        { x0 + r, y1 - r, 0.5 * kPi },     // bottom left
    };
    for (const Corner& c : corners) {
        for (int s = 0; s <= segs; ++s) {
            const double a = c.a0 + (0.5 * kPi) * static_cast<double>(s) / segs;
            put(c.cx + r * static_cast<float>(std::cos(a)), c.cy + r * static_cast<float>(std::sin(a)));
        }
    }
    return n;
}

// One closed path -> polygon points in cell pixels (about the cell centre).
// Every edge i -> i+1 (wrapping) emits its start vertex and then its interior
// subdivision points, so the polygon closes on the first point implicitly.
// Writes at most `cap` points and returns how many it wrote.
inline int flattenPath(const MaskVertexF* v, int count, float cellW, float cellH,
                       Point* out, int cap) {
    int n = 0;
    if (!v || count < 3 || cap <= 0) return 0;
    for (int i = 0; i < count && n < cap; ++i) {
        const MaskVertexF& a = v[i];
        const MaskVertexF& b = v[(i + 1) % count];
        const Point p0{ a.x * cellW, a.y * cellH };
        const Point p3{ b.x * cellW, b.y * cellH };
        const Point p1{ (a.x + a.outX) * cellW, (a.y + a.outY) * cellH };
        const Point p2{ (b.x + b.inX) * cellW, (b.y + b.inY) * cellH };
        const bool straight = a.outX == 0.0f && a.outY == 0.0f && b.inX == 0.0f && b.inY == 0.0f;
        const int segs = bezierSegments(p0, p1, p2, p3, straight);
        out[n++] = p0;
        for (int s = 1; s < segs && n < cap; ++s) {
            const float t  = static_cast<float>(s) / static_cast<float>(segs);
            const float u  = 1.0f - t;
            const float b0 = u * u * u, b1 = 3.0f * u * u * t, b2 = 3.0f * u * t * t, b3 = t * t * t;
            out[n++] = Point{ b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
                              b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y };
        }
    }
    return n;
}

// ── CPU reference of FX_Mask.hlsl ───────────────────────────────────────────

// Signed distance (pixels; negative inside) from p to a closed polygon,
// inside by the NONZERO winding rule.
inline float polygonSdf(Point p, const Point* pts, int count) {
    float d = 1e30f;
    int wind = 0;
    Point a = pts[count - 1];
    for (int i = 0; i < count; ++i) {
        const Point b = pts[i];
        const float ex = b.x - a.x, ey = b.y - a.y;
        const float wx = p.x - a.x, wy = p.y - a.y;
        const float ee = std::max(ex * ex + ey * ey, 1e-12f);
        const float t  = std::clamp((wx * ex + wy * ey) / ee, 0.0f, 1.0f);
        const float qx = wx - ex * t, qy = wy - ey * t;
        d = std::min(d, qx * qx + qy * qy);
        const float cross = ex * wy - ey * wx;
        if (a.y <= p.y) { if (b.y > p.y && cross > 0.0f) ++wind; }
        else            { if (b.y <= p.y && cross < 0.0f) --wind; }
        a = b;
    }
    const float s = std::sqrt(d);
    return wind != 0 ? -s : s;
}

inline float smoothstepf(float e0, float e1, float x) {
    const float t = std::clamp((x - e0) / (e1 - e0), 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
}

// Coverage of one shape edge at signed distance d: a smoothstep centred on the
// edge, as wide as the feather or (feather 0) one anti-aliasing pixel.
inline float edgeCoverage(float d, float featherPx, float aaPx) {
    const float w = std::max(featherPx, aaPx);
    return 1.0f - smoothstepf(-0.5f * w, 0.5f * w, d);
}

// One uploaded mask: where its polygon is and its resolved scalars.
struct MaskDraw {
    int   firstPoint = 0, pointCount = 0;
    int   mode = 0, invert = 0;
    float featherPx = 0.0f, expansionPx = 0.0f, opacity = 1.0f;
};

// R12 combination, top to bottom. Start 0 when the first mask that has any
// opacity adds, else 1.
//   Add       acc + o c - acc o c
//   Subtract  acc (1 - o c)
//   Intersect acc (1 - o (1 - c))
// then the R9 carried-home clip quad (clipFirst >= 0) as a hard intersect.
// R12 "Opacity 0 = the mask has no effect": a mask at opacity 0 leaves acc as
// it is in every mode, so it must not pick the start either (a sole Add mask
// at opacity 0 starting from 0 would hide the whole cell). Skipping it when
// choosing the start makes it exactly as if it were absent. FX_Mask.hlsl and
// ui/src/motion/maskModel.js coverageAt apply the same rule.
inline float maskStart(const MaskDraw* masks, int maskCount) {
    for (int m = 0; m < maskCount; ++m)
        if (masks[m].opacity > 0.0f)
            return masks[m].mode == static_cast<int>(MaskMode::Add) ? 0.0f : 1.0f;
    return 1.0f;
}

inline float maskCoverage(Point p, const MaskDraw* masks, int maskCount,
                          const Point* pts, int clipFirst, float aaPx) {
    float acc = maskStart(masks, maskCount);
    for (int m = 0; m < maskCount; ++m) {
        const MaskDraw& k = masks[m];
        float c = 0.0f;
        if (k.pointCount >= 3) {
            const float d = polygonSdf(p, pts + k.firstPoint, k.pointCount) - k.expansionPx;
            c = edgeCoverage(d, k.featherPx, aaPx);
        }
        if (k.invert) c = 1.0f - c;
        const float oc = k.opacity * c;
        if (k.mode == static_cast<int>(MaskMode::Subtract))       acc = acc * (1.0f - oc);
        else if (k.mode == static_cast<int>(MaskMode::Intersect)) acc = acc * (1.0f - k.opacity * (1.0f - c));
        else                                                       acc = acc + oc - acc * oc;
    }
    if (clipFirst >= 0) {
        const float d = polygonSdf(p, pts + clipFirst, 4);
        acc *= std::clamp(0.5f - d / aaPx, 0.0f, 1.0f);
    }
    return acc;
}

// Where the final draw shows texel `t` (0..1 of the cell texture): the inverse
// of its orientation (GridComposite.hlsl: sampleUV = orient(localUV)), so the
// mask stays put on screen while the content flips under it.
inline void inverseOrientation(int orientation, float tu, float tv, float& lu, float& lv) {
    switch (orientation) {
        case 1:  lu = 1.0f - tu; lv = tv;        break;
        case 2:  lu = tu;        lv = 1.0f - tv; break;
        case 3:  lu = 1.0f - tu; lv = 1.0f - tv; break;
        case 4:  lu = 1.0f - tv; lv = tu;        break;
        case 5:  lu = tv;        lv = 1.0f - tu; break;
        default: lu = tu;        lv = tv;        break;
    }
}

} // namespace maskmath
