#pragma once

// ---------------------------------------------------------------------------
// CanvasFit — pure geometry for fitting the project authoring canvas into an
// export/preview output of a different aspect ratio.
//
// The grid compositor draws every cell/layer as a rect in output-UV space
// [0,1]×[0,1]; the pixel shader discards anything outside the rect. So a single
// affine "canvas viewport" applied to each rect realizes all three fit modes
// with no shader changes and no intermediate render target:
//
//   Stretch — viewport = the whole output [0,1]. The canvas fills the frame,
//             distorting proportions when aspects differ (legacy behavior).
//   Bars    — viewport is the largest sub-rect of the output that preserves the
//             canvas aspect (letterbox / pillarbox). Uncovered output stays the
//             clear color (black), producing the bars.
//   Crop    — viewport is the smallest super-rect that covers the output while
//             preserving the canvas aspect. It extends past [0,1]; the
//             rasterizer clips the overflow, cropping canvas edges.
//
// Keeping this header-only and free of any GPU/D3D dependency lets it be unit
// tested on CPU (see test/test_canvas_fit.cpp).
// ---------------------------------------------------------------------------

namespace xleth {

enum class CanvasFitMode {
    Stretch,   // fill output, allow distortion
    Crop,      // fill output, preserve aspect, crop edges
    Bars       // fit inside output, preserve aspect, letterbox/pillarbox
};

// Placement of the canvas inside the output, in output-UV space. For Stretch and
// matching aspects this is the identity {0,0,1,1}. For Bars the rect is inside
// [0,1]; for Crop it can extend beyond [0,1].
struct CanvasFitViewport {
    float x = 0.0f;
    float y = 0.0f;
    float w = 1.0f;
    float h = 1.0f;

    bool isIdentity() const {
        return x == 0.0f && y == 0.0f && w == 1.0f && h == 1.0f;
    }
};

// Map a rect expressed in canvas-UV [0,1] into output-UV using this viewport.
inline void applyCanvasFit(const CanvasFitViewport& vp,
                           float& x, float& y, float& w, float& h) {
    x = vp.x + x * vp.w;
    y = vp.y + y * vp.h;
    w = w * vp.w;
    h = h * vp.h;
}

// Compute the canvas placement for the given source canvas and output sizes.
// Degenerate inputs (any dimension <= 0) and Stretch return identity. When the
// aspect ratios already match (within a pixel-scale epsilon) every mode returns
// identity, so an aspect-matched export is bit-for-bit the legacy fill path.
inline CanvasFitViewport computeCanvasFitViewport(int canvasW, int canvasH,
                                                  int outW, int outH,
                                                  CanvasFitMode mode) {
    CanvasFitViewport vp;  // identity
    if (canvasW <= 0 || canvasH <= 0 || outW <= 0 || outH <= 0) return vp;
    if (mode == CanvasFitMode::Stretch) return vp;

    const double canvasAspect = static_cast<double>(canvasW) / canvasH;
    const double outAspect    = static_cast<double>(outW)    / outH;
    const double ratio        = canvasAspect / outAspect;   // >1 canvas wider, <1 taller

    // Aspect already matches → no bars / no crop regardless of mode.
    if (ratio > 0.9995 && ratio < 1.0005) return vp;

    if (mode == CanvasFitMode::Bars) {
        if (ratio < 1.0) {            // canvas narrower than output → pillarbox
            vp.w = static_cast<float>(ratio);
            vp.h = 1.0f;
        } else {                      // canvas wider than output → letterbox
            vp.w = 1.0f;
            vp.h = static_cast<float>(1.0 / ratio);
        }
    } else {                          // Crop: cover the output, overflow one axis
        if (ratio > 1.0) {            // canvas wider → fill height, overflow width
            vp.w = static_cast<float>(ratio);
            vp.h = 1.0f;
        } else {                      // canvas taller → fill width, overflow height
            vp.w = 1.0f;
            vp.h = static_cast<float>(1.0 / ratio);
        }
    }
    vp.x = (1.0f - vp.w) * 0.5f;
    vp.y = (1.0f - vp.h) * 0.5f;
    return vp;
}

} // namespace xleth
