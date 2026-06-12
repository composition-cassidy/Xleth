// test_canvas_fit.cpp — Self-verification for the pure canvas-fit geometry that
// fits the project authoring canvas into an export of a different aspect ratio.
// Build: see engine/CMakeLists.txt target "test_canvas_fit"
// Run:   test_canvas_fit.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1

#include "render/CanvasFit.h"
#include <cmath>
#include <iostream>

using namespace xleth;

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                        \
    do {                                                                        \
        if (cond) { ++g_passed; }                                               \
        else { std::cerr << "  FAIL [line " << __LINE__ << "] " << msg << "\n"; \
               ++g_failed; }                                                    \
    } while (0)

static bool approx(float a, float b, float eps = 1e-3f) {
    return std::fabs(a - b) < eps;
}

int main() {
    // ── Stretch is always identity (legacy fill) ─────────────────────────────
    {
        auto vp = computeCanvasFitViewport(1080, 1920, 1920, 1080, CanvasFitMode::Stretch);
        CHECK(vp.isIdentity(), "Stretch returns identity even on aspect mismatch");
    }

    // ── Matching aspect → identity regardless of mode ────────────────────────
    for (CanvasFitMode m : { CanvasFitMode::Stretch, CanvasFitMode::Crop, CanvasFitMode::Bars }) {
        auto vp = computeCanvasFitViewport(1920, 1080, 1280, 720, m);  // both 16:9
        CHECK(vp.isIdentity(), "matching aspect returns identity for every mode");
    }

    // ── Bars: 9:16 canvas into 16:9 output → pillarbox (bars left/right) ──────
    {
        auto vp = computeCanvasFitViewport(1080, 1920, 1920, 1080, CanvasFitMode::Bars);
        CHECK(vp.h == 1.0f,                 "pillarbox fills height");
        CHECK(vp.w < 1.0f && vp.w > 0.0f,   "pillarbox narrows width");
        CHECK(vp.x > 0.0f,                  "pillarbox bars on left");
        CHECK(approx(vp.x + vp.w / 2.0f, 0.5f), "pillarbox content is centered horizontally");
        CHECK(vp.x >= 0.0f && vp.x + vp.w <= 1.0001f, "pillarbox stays within the frame");
        // canvasAspect/outAspect = (1080/1920)/(1920/1080) = 0.5625/1.7778 = 0.3164
        CHECK(approx(vp.w, 0.31640625f),    "pillarbox width = aspect ratio");
    }

    // ── Bars: 16:9 canvas into 9:16 output → letterbox (bars top/bottom) ──────
    {
        auto vp = computeCanvasFitViewport(1920, 1080, 1080, 1920, CanvasFitMode::Bars);
        CHECK(vp.w == 1.0f,                 "letterbox fills width");
        CHECK(vp.h < 1.0f && vp.h > 0.0f,   "letterbox shortens height");
        CHECK(vp.y > 0.0f,                  "letterbox bars on top");
        CHECK(approx(vp.y + vp.h / 2.0f, 0.5f), "letterbox content is centered vertically");
        CHECK(vp.y >= 0.0f && vp.y + vp.h <= 1.0001f, "letterbox stays within the frame");
    }

    // ── Crop: 16:9 canvas into 9:16 output → overflow width, crop sides ───────
    {
        auto vp = computeCanvasFitViewport(1920, 1080, 1080, 1920, CanvasFitMode::Crop);
        CHECK(vp.h == 1.0f,                 "crop fills height");
        CHECK(vp.w > 1.0f,                  "crop overflows width");
        CHECK(vp.x < 0.0f,                  "crop pushes left edge off-frame");
        CHECK(approx(vp.x + vp.w / 2.0f, 0.5f), "crop content stays centered");
        // covers the whole output
        CHECK(vp.x <= 0.0f && vp.x + vp.w >= 1.0f, "crop fully covers output width");
        CHECK(vp.y <= 0.0f + 1e-6f && vp.y + vp.h >= 1.0f - 1e-6f, "crop fully covers output height");
    }

    // ── Crop: 9:16 canvas into 16:9 output → overflow height, crop top/bottom ─
    {
        auto vp = computeCanvasFitViewport(1080, 1920, 1920, 1080, CanvasFitMode::Crop);
        CHECK(vp.w == 1.0f,                 "crop fills width");
        CHECK(vp.h > 1.0f,                  "crop overflows height");
        CHECK(vp.y < 0.0f,                  "crop pushes top edge off-frame");
        CHECK(vp.x <= 0.0f + 1e-6f && vp.x + vp.w >= 1.0f - 1e-6f, "crop covers output width");
        CHECK(vp.y <= 0.0f && vp.y + vp.h >= 1.0f, "crop covers output height");
    }

    // ── Degenerate inputs → identity (never divide by zero) ──────────────────
    {
        CHECK(computeCanvasFitViewport(0, 1080, 1920, 1080, CanvasFitMode::Bars).isIdentity(),
              "zero canvas width → identity");
        CHECK(computeCanvasFitViewport(1920, 1080, 1920, 0, CanvasFitMode::Crop).isIdentity(),
              "zero output height → identity");
    }

    // ── applyCanvasFit maps a rect into the viewport ─────────────────────────
    {
        CanvasFitViewport ident;  // {0,0,1,1}
        float x = 0.25f, y = 0.5f, w = 0.5f, h = 0.5f;
        applyCanvasFit(ident, x, y, w, h);
        CHECK(approx(x, 0.25f) && approx(y, 0.5f) && approx(w, 0.5f) && approx(h, 0.5f),
              "identity viewport leaves rects unchanged");

        CanvasFitViewport vp{ 0.25f, 0.0f, 0.5f, 1.0f };  // pillarbox-like
        float cx = 0.0f, cy = 0.0f, cw = 1.0f, ch = 1.0f;  // full-frame cell
        applyCanvasFit(vp, cx, cy, cw, ch);
        CHECK(approx(cx, 0.25f) && approx(cw, 0.5f),
              "full-frame cell maps onto the pillarbox sub-rect");
        CHECK(approx(cy, 0.0f) && approx(ch, 1.0f),
              "pillarbox preserves full height");
    }

    std::cout << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED (" << g_passed << " checks)\n";
        return 0;
    }
    std::cout << "FAILED: " << g_failed << " check(s) failed, " << g_passed << " passed\n";
    return 1;
}
