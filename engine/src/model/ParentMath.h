#pragma once

// ─── ParentMath: Parent geometry (Motion view) ───────────────────────────────
// docs/XLETH_MOTION_VIEW_DESIGN.md R6, R7, R8, 3.2.
//
// A parent passes on ROAM only (offset, scale, rotation), as a similarity in
// PIXELS about the parent's HOME centre:
//
//     S_A(p) = c'_A + s_A * Rot(r_A) * (p - c_A)
//
//   c_A   centre of the parent's home rect (post-gap, WITHOUT its per-note
//         bounce; a fullscreen parent, Chorus behind-layer included: the canvas)
//   c'_A  centre of roamCellRect(R_A, home_A, unit_A) = c_A + offset * unit
//   s_A   the parent's Roam scale, r_A its rotation (degrees, clockwise on
//         screen with y down: computeRoamInverse's convention)
//
// The chain composes nearest parent first: final = S_root o ... o S_parent o
// T_child. The child's final pose: centre = S(child Roamed centre), size =
// child Roamed size x product of s, rotation = child rotation + sum of r.
//
// Two layers:
//   * PURE (header-only, no allocation, lock or log; safe on the render
//     thread): Similarity / compose / apply / inverse, the parent similarity
//     from a home rect + unit + RoamParams, a child's Roamed pose, carrying a
//     pose through a chain, the layout -> home-rect lookup (GridRectMath, the
//     compositor's own arithmetic) and the keep-on-screen SOLVE.
//   * TIMELINE glue (ParentMath.cpp, message thread; allocates): validation
//     for an attach (self / cycle / too deep / unknown track) and
//     keepOnScreen(), which evaluates the old and new chains at a tick with the
//     FULL layout at that tick (Timeline::gridLayoutAt), the authoring canvas
//     size and the model's own Roam evaluation, then solves.
//
// Pixels: any (W, H) that maps canvas-UV uniformly works. The compositor uses
// its output pixels (canvas fit included); keep-on-screen uses the AUTHORING
// canvas (GridLayout::canvasWidth x canvasHeight). Rotation must be rigid in
// pixels, which is why nothing here works in canvas-UV directly.

#include "model/LensRoam.h"
#include "model/MotionSchema.h"
#include "model/TimelineTypes.h"
#include "render/GridRectMath.h"

#include <algorithm>
#include <cmath>
#include <cstdint>

class Timeline;

namespace parentmath {

inline constexpr int kMaxParentDepth = motionschema::kMaxParentDepth;   // 4 ancestors

struct Vec2 {
    double x = 0.0, y = 0.0;
};

// p' = s * Rot(rotDeg) * p + t, Rot(a) = [[cos a, -sin a], [sin a, cos a]] in
// y-down pixels (a positive angle turns clockwise on screen). rotDeg is kept
// as a plain sum (never re-derived with atan2), so a chain's rotation is
// exactly child + sum of the parents'.
struct Similarity {
    double s      = 1.0;
    double rotDeg = 0.0;
    double tx     = 0.0;
    double ty     = 0.0;
    bool isIdentity() const { return s == 1.0 && rotDeg == 0.0 && tx == 0.0 && ty == 0.0; }
};

inline Vec2 rotate(double deg, Vec2 v) {
    if (deg == 0.0) return v;
    const double a = deg * 0.017453292519943295;
    const double c = std::cos(a), s = std::sin(a);
    return { c * v.x - s * v.y, s * v.x + c * v.y };
}

inline Vec2 apply(const Similarity& S, Vec2 p) {
    const Vec2 r = rotate(S.rotDeg, p);
    return { S.s * r.x + S.tx, S.s * r.y + S.ty };
}

// outer o inner: apply `inner` first.
inline Similarity compose(const Similarity& outer, const Similarity& inner) {
    const Vec2 t = rotate(outer.rotDeg, { inner.tx, inner.ty });
    Similarity o;
    o.s      = outer.s * inner.s;
    o.rotDeg = outer.rotDeg + inner.rotDeg;
    o.tx     = outer.s * t.x + outer.tx;
    o.ty     = outer.s * t.y + outer.ty;
    return o;
}

// S^-1 (S.s must be > 0; every Roam scale is held in [1e-3, 1e3]).
inline Similarity inverse(const Similarity& S) {
    const double is = 1.0 / S.s;
    const Vec2 t = rotate(-S.rotDeg, { -S.tx, -S.ty });
    Similarity o;
    o.s      = is;
    o.rotDeg = -S.rotDeg;
    o.tx     = is * t.x;
    o.ty     = is * t.y;
    return o;
}

// A chain given NEAREST FIRST: S[n-1] o ... o S[1] o S[0] (= root o ... o parent).
inline Similarity composeChain(const Similarity* nearestFirst, int n) {
    Similarity acc;
    for (int i = 0; i < n; ++i) acc = compose(nearestFirst[i], acc);
    return acc;
}

// ── Roam fields, sanitized exactly as lensroam::roamCellRect reads them ─────
inline double roamOffsetX(const RoamParams& r)     { return std::isfinite(r.offsetX) ? r.offsetX : 0.0f; }
inline double roamOffsetY(const RoamParams& r)     { return std::isfinite(r.offsetY) ? r.offsetY : 0.0f; }
inline double roamRotationDeg(const RoamParams& r) { return std::isfinite(r.rotationDeg) ? r.rotationDeg : 0.0f; }
inline double roamScaleX(const RoamParams& r) {
    const float sc = std::isfinite(r.scaleXEff()) ? r.scaleXEff() : 1.0f;
    return std::clamp(sc, 1e-3f, 1e3f);
}
inline double roamScaleY(const RoamParams& r) {
    const float sc = std::isfinite(r.scaleYEff()) ? r.scaleYEff() : 1.0f;
    return std::clamp(sc, 1e-3f, 1e3f);
}
// What a PARENT passes on. A parent hands its children a similarity (one
// uniform scale), so a cell with independent Scale X / Y passes the geometric
// mean of the two; a uniform cell (every linked one) passes its scale exactly.
inline double roamScale(const RoamParams& r) {
    const double sx = roamScaleX(r), sy = roamScaleY(r);
    return sx == sy ? sx : std::sqrt(sx * sy);
}

// A cell's home in PIXELS: the drawn rect (post-gap, no bounce) and one Roam
// cell unit (the placement before the gap; the canvas for a fullscreen layer).
struct Home {
    double x = 0.0, y = 0.0, w = 0.0, h = 0.0;
    double unitW = 0.0, unitH = 0.0;
    Vec2 centre() const { return { x + w * 0.5, y + h * 0.5 }; }
};

// The parent similarity S_A (R7).
inline Similarity parentSimilarity(const Home& home, const RoamParams& r) {
    const Vec2 c  = home.centre();
    const Vec2 c2 = { c.x + roamOffsetX(r) * home.unitW, c.y + roamOffsetY(r) * home.unitH };
    Similarity S;
    S.s      = roamScale(r);
    S.rotDeg = roamRotationDeg(r);
    const Vec2 rc = rotate(S.rotDeg, c);
    S.tx = c2.x - S.s * rc.x;
    S.ty = c2.y - S.s * rc.y;
    return S;
}

// A cell pose in pixels: centre, size, rotation (clockwise degrees) and the
// accumulated scale (Roam scale x every parent's).
struct Pose {
    Vec2   centre;
    double w = 0.0, h = 0.0;
    double rotDeg = 0.0;
    double scale  = 1.0;    // uniform (parent-facing) scale, accumulated
    double scaleX = 1.0;    // width multiplier, accumulated
    double scaleY = 1.0;    // height multiplier, accumulated
};

// The cell's own Roamed pose, no parent: offset moves the centre by whole
// units, scale and rotation act about the centre.
inline Pose roamedPose(const Home& home, const RoamParams& r) {
    Pose p;
    const Vec2 c = home.centre();
    p.centre = { c.x + roamOffsetX(r) * home.unitW, c.y + roamOffsetY(r) * home.unitH };
    p.scale  = roamScale(r);
    p.scaleX = roamScaleX(r);
    p.scaleY = roamScaleY(r);
    p.w      = home.w * p.scaleX;
    p.h      = home.h * p.scaleY;
    p.rotDeg = roamRotationDeg(r);
    return p;
}

// A pose carried by a (composed) chain: centre = S(centre), size and scale x s,
// rotation + r.
inline Pose carry(const Similarity& S, const Pose& p) {
    Pose o;
    o.centre = apply(S, p.centre);
    o.w      = p.w * S.s;
    o.h      = p.h * S.s;
    o.scale  = p.scale * S.s;
    o.scaleX = p.scaleX * S.s;
    o.scaleY = p.scaleY * S.s;
    o.rotDeg = p.rotDeg + S.rotDeg;
    return o;
}

// ── Layout -> home (the compositor's own float arithmetic) ──────────────────

struct Placement {
    bool placed     = false;
    bool fullscreen = false;   // a FullscreenLayer (BehindGrid "Chorus" or InFrontOfGrid)
    int  cellCol = 0, cellRow = 0, spanX = 0, spanY = 0;   // grid only (fine sub-units)
};

// Where `trackId` sits in `layout` (R7): the FIRST grid slot in layout.slots
// order, else the first fullscreen layer, else not placed.
inline Placement findPlacement(const GridLayout& layout, int trackId) {
    Placement p;
    for (const GridSlot& s : layout.slots) {
        if (s.trackId != trackId) continue;
        p.placed = true;
        p.cellCol = s.gridX; p.cellRow = s.gridY; p.spanX = s.spanX; p.spanY = s.spanY;
        return p;
    }
    for (const FullscreenLayer& f : layout.fullscreenLayers) {
        if (f.trackId != trackId) continue;
        p.placed = true;
        p.fullscreen = true;
        return p;
    }
    return p;
}

// Home rect and Roam unit in canvas-UV (0..1, y down), exactly as
// GridCompositor computes them before bounce: a grid slot's unit is its
// placement before the gap (slotCellRect) and its rect the drawn rect after the
// track's effective gap (slotCanvasRect); a fullscreen layer is the canvas.
// False when not placed.
struct HomeUv {
    float x = 0.0f, y = 0.0f, w = 1.0f, h = 1.0f;
    float unitW = 1.0f, unitH = 1.0f;
};

inline bool homeRectUv(const GridLayout& layout, const Placement& pl, float trackGapScaleOverride,
                       HomeUv& out) {
    if (!pl.placed) return false;
    if (pl.fullscreen) {
        out = HomeUv{};
        return true;
    }
    float ux, uy;
    xleth::slotCellRect(pl.cellCol, pl.cellRow, pl.spanX, pl.spanY,
                        layout.columns, layout.rows, ux, uy, out.unitW, out.unitH);
    xleth::slotCanvasRect(pl.cellCol, pl.cellRow, pl.spanX, pl.spanY, layout.columns, layout.rows,
                          xleth::effectiveSlotGap(layout.gapScale, trackGapScaleOverride),
                          out.x, out.y, out.w, out.h);
    return true;
}

inline Home toPixels(const HomeUv& h, double pxW, double pxH) {
    Home o;
    o.x = h.x * pxW;  o.y = h.y * pxH;
    o.w = h.w * pxW;  o.h = h.h * pxH;
    o.unitW = h.unitW * pxW;
    o.unitH = h.unitH * pxH;
    return o;
}

// ── Keep on screen: the solve (R6, 3.2) ─────────────────────────────────────
// Given the child's home, its Roam at the tick (`now`, keys applied), its
// stored base, which channels are keyed, and the composed OLD and NEW chains,
// returns the base that keeps the child's on-screen pose (centre, scale,
// rotation) under the new chain. Only UNKEYED channels change (a keyed channel
// ignores its base; keys are never rewritten):
//   scale'  = s_child_total_old / prod(s_new)
//   rot'    = r_child_total_old - sum(r_new)
//   offset' : S_new(homeCentre + o' * unit) = old final centre, solved as a
//             PAIR (if either offset channel is keyed, neither is changed).
// Bounds and layer are untouched. Index the flags with RoamChannel.
struct KeepOnScreenSolve {
    RoamParams base;
    bool compensated[kLensRoamChannels]   = {};
    bool uncompensated[kLensRoamChannels] = {};
};

inline KeepOnScreenSolve solveKeepOnScreen(const Home& childHome, const RoamParams& now,
                                           const RoamParams& base, const bool (&keyed)[kLensRoamChannels],
                                           const Similarity& oldChain, const Similarity& newChain) {
    constexpr int kX = static_cast<int>(RoamChannel::OffsetX);
    constexpr int kY = static_cast<int>(RoamChannel::OffsetY);
    constexpr int kS = static_cast<int>(RoamChannel::Scale);
    constexpr int kSY = static_cast<int>(RoamChannel::ScaleY);
    constexpr int kR = static_cast<int>(RoamChannel::RotationDeg);
    KeepOnScreenSolve out;
    out.base = base;
    const Pose oldFinal = carry(oldChain, roamedPose(childHome, now));

    if (!keyed[kS]) {
        const double s = oldFinal.scaleX / newChain.s;
        out.base.scale = static_cast<float>(std::clamp(s, 1e-3, 1e3));
        out.compensated[kS] = true;
    } else {
        out.uncompensated[kS] = true;
    }
    // Scale Y is its own channel only while unlinked; a linked cell's height IS
    // its scale, compensated above.
    if (!base.scaleLinked) {
        if (!keyed[kSY]) {
            const double s = oldFinal.scaleY / newChain.s;
            out.base.scaleY = static_cast<float>(std::clamp(s, 1e-3, 1e3));
            out.compensated[kSY] = true;
        } else {
            out.uncompensated[kSY] = true;
        }
    }
    if (!keyed[kR]) {
        out.base.rotationDeg = static_cast<float>(oldFinal.rotDeg - newChain.rotDeg);
        out.compensated[kR] = true;
    } else {
        out.uncompensated[kR] = true;
    }
    if (!keyed[kX] && !keyed[kY] && childHome.unitW > 0.0 && childHome.unitH > 0.0) {
        const Vec2 local = apply(inverse(newChain), oldFinal.centre);
        const Vec2 c = childHome.centre();
        out.base.offsetX = static_cast<float>((local.x - c.x) / childHome.unitW);
        out.base.offsetY = static_cast<float>((local.y - c.y) / childHome.unitH);
        out.compensated[kX] = out.compensated[kY] = true;
    } else {
        out.uncompensated[kX] = out.uncompensated[kY] = true;
    }
    return out;
}

// ── Timeline glue (ParentMath.cpp; message thread, allocates) ───────────────

// Why an attach is refused (design 3.1 `rejected`).
enum class ParentReject : uint8_t { None = 0, UnknownTrack, Self, Cycle, TooDeep };
const char* parentRejectToString(ParentReject r);   // "" | unknown_track | self | cycle | too_deep

// Can `childId` take `newParentId` (-1 = detach, always allowed for a known
// child)? Refuses an unknown child or parent, the track itself, a parent whose
// chain already reaches the child (loop), and a choice that leaves any track
// of the child's subtree with more than kMaxParentDepth ancestors.
ParentReject validateParent(const Timeline& tl, int childId, int newParentId);

// The track's ancestors as stored (nearest first), walking parentTrackId and
// stopping at none / a dangling id / an id already seen (the track included).
// Unbounded by depth (validation needs the real length); bounded by the
// track count.
int ancestorCount(const Timeline& tl, int trackId);
// The deepest level of tracks below `trackId` (0 = no children).
int descendantHeight(const Timeline& tl, int trackId);

// The composed similarity of the chain that STARTS at `firstParent` (the
// child's parent, nearest first), evaluated at `tick` on `layout`, in pixels
// of pxW x pxH. At most kMaxParentDepth ancestors; an unplaced ancestor
// contributes identity and the chain continues above it; the walk stops at a
// dangling id or an id already seen (`childId` included).
Similarity chainAt(const Timeline& tl, const GridLayout& layout, int childId, int firstParent,
                   double tick, double pxW, double pxH);

// Keep-on-screen for "set childId's parent to newParentId" at `tick`, using
// the FULL layout at that tick and the authoring canvas size. `placed` false
// (the child has no placement at that tick): nothing to keep, `solve.base` is
// the stored base and no channel is listed.
struct KeepOnScreen {
    bool              placed = false;
    KeepOnScreenSolve solve;
};
KeepOnScreen keepOnScreen(const Timeline& tl, int childId, int newParentId, double tick);

} // namespace parentmath
