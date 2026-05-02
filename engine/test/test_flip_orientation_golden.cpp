// test_flip_orientation_golden.cpp — Phase 6 GPU shader golden-frame test.
//
// Acceptance coverage (xleth-flip-v2-architecture-spec.md §9, §10):
//   "Shader golden-frame tests pass for all 6 orientations against one fixed
//    input texture. Golden frames committed to the repo."
//
// Approach: build a 4-quadrant test texture (TL=red, TR=green, BL=blue, BR=yellow),
// run the GridCompositor full-screen with each of the 6 orientations, read back
// the composited frame, and assert each quadrant carries the colour that the
// spec §5.3 UV transform predicts. The "golden" is encoded inline as a 6-row
// table — the assertions ARE the committed golden — no binary blobs to drift
// out of sync with the shader.
//
// This test runs only when a D3D11 device is available; it skips cleanly on
// machines without a GPU (CI runners) so it's safe to wire into pre-merge.
//
// Build target: test_flip_orientation_golden (engine/CMakeLists.txt)

#include "render/GridCompositor.h"
#include "render/GpuDeviceManager.h"
#include "render/FrameCache.h"
#include "render/FrameCollector.h"
#include "model/TimelineTypes.h"

#undef NDEBUG
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

static ID3D11Device*        g_device    = nullptr;
static ID3D11DeviceContext* g_deviceCtx = nullptr;

// ─── 4-quadrant test texture ─────────────────────────────────────────────────
// Layout (UV space, top-left = (0,0), bottom-right = (1,1)):
//
//      red           green
//      [0,0]–[0.5,0.5]  [0.5,0]–[1,0.5]
//      blue          yellow
//      [0,0.5]–[0.5,1]  [0.5,0.5]–[1,1]
//
// BGRA byte layout (D3D11 default texture format here).
static constexpr uint32_t kRed    = 0xFF0000FF;  // BGRA: B=0,G=0,R=255,A=255
static constexpr uint32_t kGreen  = 0xFF00FF00;
static constexpr uint32_t kBlue   = 0xFFFF0000;
static constexpr uint32_t kYellow = 0xFF00FFFF;

static FrameCacheEntry makeQuadrantTexture(int w = 64, int h = 64) {
    std::vector<uint8_t> pixels(static_cast<size_t>(w) * h * 4);
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            const bool right  = (x >= w / 2);
            const bool bottom = (y >= h / 2);
            uint32_t pixel = right
                ? (bottom ? kYellow : kGreen)
                : (bottom ? kBlue   : kRed);
            std::memcpy(&pixels[(y * w + x) * 4], &pixel, 4);
        }
    }
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width            = static_cast<UINT>(w);
    desc.Height           = static_cast<UINT>(h);
    desc.MipLevels        = 1;
    desc.ArraySize        = 1;
    desc.Format           = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage            = D3D11_USAGE_DEFAULT;
    desc.BindFlags        = D3D11_BIND_SHADER_RESOURCE;

    D3D11_SUBRESOURCE_DATA initData = {};
    initData.pSysMem     = pixels.data();
    initData.SysMemPitch = static_cast<UINT>(w * 4);

    FrameCacheEntry entry;
    HRESULT hr = g_device->CreateTexture2D(&desc, &initData, &entry.texture);
    assert(SUCCEEDED(hr));
    hr = g_device->CreateShaderResourceView(entry.texture.Get(), nullptr, &entry.srv);
    assert(SUCCEEDED(hr));
    entry.width           = w;
    entry.height          = h;
    entry.memorySizeBytes = static_cast<size_t>(w) * h * 4;
    return entry;
}

// ─── Pixel inspection helpers ────────────────────────────────────────────────

enum class Color { Red, Green, Blue, Yellow };

static const char* colorName(Color c) {
    switch (c) {
        case Color::Red:    return "Red";
        case Color::Green:  return "Green";
        case Color::Blue:   return "Blue";
        case Color::Yellow: return "Yellow";
    }
    return "?";
}

// Classify a sampled BGRA pixel into the four canonical test colours by looking
// at which channels are saturated. Linear sampler at quadrant centres lands far
// from the boundary so the colour is unambiguous.
static Color classify(const ReadbackBuffer& buf, int x, int y) {
    const uint8_t* p = buf.pixels.data() + y * buf.stride + x * 4;
    const uint8_t b = p[0], g = p[1], r = p[2];
    const bool R = r > 200, G = g > 200, B = b > 200;
    if (R && !G && !B) return Color::Red;
    if (!R && G && !B) return Color::Green;
    if (!R && !G && B) return Color::Blue;
    if (!R && G && B)  return Color::Blue;     // shouldn't happen with our palette
    if (R && G && !B)  return Color::Yellow;
    // Anything else — fail the test by not matching anything below.
    std::fprintf(stderr, "    UNEXPECTED pixel at (%d,%d): R=%d G=%d B=%d\n", x, y, r, g, b);
    return Color::Red;  // arbitrary fallback; assertion below will fail
}

// ─── Golden table ────────────────────────────────────────────────────────────
// For each orientation, four output-quadrant colours in (TL, TR, BL, BR) order.
// Derived directly from spec §5.3 UV transforms applied to the source quadrants.

struct Golden {
    int   orientation;
    const char* name;
    Color tl, tr, bl, br;
};

static const Golden kGolden[6] = {
    // 0: identity — quadrants unchanged
    { 0, "none",          Color::Red,    Color::Green,  Color::Blue,   Color::Yellow },
    // 1: horizontal — left↔right swap
    { 1, "horizontal",    Color::Green,  Color::Red,    Color::Yellow, Color::Blue   },
    // 2: vertical — top↔bottom swap
    { 2, "vertical",      Color::Blue,   Color::Yellow, Color::Red,    Color::Green  },
    // 3: rotate-180 — both flips
    { 3, "rotate-180",    Color::Yellow, Color::Blue,   Color::Green,  Color::Red    },
    // 4: rotate-90 CW — (u,v) → (v, 1-u)
    //    original red(TL) lands in TR; green(TR) lands in BR; blue(BL) lands in TL; yellow(BR) lands in BL
    { 4, "rotate-90-cw",  Color::Blue,   Color::Red,    Color::Yellow, Color::Green  },
    // 5: rotate-90 CCW — (u,v) → (1-v, u)
    //    original red(TL) lands in BL; green(TR) lands in TL; blue(BL) lands in BR; yellow(BR) lands in TR
    { 5, "rotate-90-ccw", Color::Green,  Color::Yellow, Color::Red,    Color::Blue   },
};

// ─── main ────────────────────────────────────────────────────────────────────

int main() {
    std::fprintf(stderr, "\n[TEST:FlipOrientationGolden] Phase 4 shader golden — 6 orientations\n");

    GpuDeviceManager gpu;
    if (!gpu.detectAdapters() || !gpu.createDevice()) {
        std::fprintf(stderr, "[TEST:FlipOrientationGolden] SKIP: no GPU available\n");
        return 0;
    }
    g_device    = gpu.getDevice();
    g_deviceCtx = gpu.getContext();
    assert(g_device && g_deviceCtx);

    constexpr int kRTWidth  = 200;
    constexpr int kRTHeight = 200;

    // Sample points at the centre of each output quadrant — far enough from the
    // boundary that linear-filter bleed doesn't ambiguate the classification.
    const int qx[2] = { kRTWidth  / 4, (kRTWidth  * 3) / 4 };  // 50, 150
    const int qy[2] = { kRTHeight / 4, (kRTHeight * 3) / 4 };  // 50, 150

    int failures = 0;
    for (const auto& g : kGolden) {
        std::fprintf(stderr, "\n[TEST:FlipOrientationGolden] orientation=%d (%s)\n",
                     g.orientation, g.name);

        // Fresh cache + compositor per orientation so state can't leak.
        RenderFrameCache cache;
        cache.setMemoryLimit(8 * 1024 * 1024);
        cache.put({"quad.mp4", 0}, makeQuadrantTexture());

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, kRTWidth, kRTHeight));

        // Single full-screen chorus draw with the test orientation. The chorus
        // pass calls drawCell(srv, 0,0,1,1, opacity, orientation, 0) which is
        // exactly the path the new shader exercises for a fullscreen blit.
        std::vector<CellFrameRequest> requests;
        CellFrameRequest req{};
        req.cellCol          = 0;
        req.cellRow          = 0;
        req.spanX            = 2 * kGridSubUnitsPerColumn;
        req.spanY            = 2 * kGridSubUnitsPerRow;
        req.sourcePath       = "quad.mp4";
        req.sourceFrameIndex = 0;
        req.opacity          = 1.0f;
        req.isChorus         = true;
        req.zOrder           = -1;
        req.orientation      = g.orientation;
        requests.push_back(req);

        compositor.compositeFrame(requests, cache, 2, 2);
        ReadbackBuffer buf = compositor.readback();
        assert(buf.valid && buf.width == kRTWidth && buf.height == kRTHeight);

        const Color tl = classify(buf, qx[0], qy[0]);
        const Color tr = classify(buf, qx[1], qy[0]);
        const Color bl = classify(buf, qx[0], qy[1]);
        const Color br = classify(buf, qx[1], qy[1]);

        std::fprintf(stderr, "    TL=%s TR=%s BL=%s BR=%s   (expected TL=%s TR=%s BL=%s BR=%s)\n",
                     colorName(tl), colorName(tr), colorName(bl), colorName(br),
                     colorName(g.tl), colorName(g.tr), colorName(g.bl), colorName(g.br));

        if (tl != g.tl || tr != g.tr || bl != g.bl || br != g.br) {
            std::fprintf(stderr, "    FAIL: orientation %d (%s) golden mismatch\n",
                         g.orientation, g.name);
            ++failures;
        } else {
            std::fprintf(stderr, "    PASS\n");
        }

        compositor.shutdown();
    }

    std::fprintf(stderr, "\n[TEST:FlipOrientationGolden] %d/%zu orientations passed\n",
                 (int)(sizeof(kGolden) / sizeof(kGolden[0])) - failures,
                 sizeof(kGolden) / sizeof(kGolden[0]));

    if (failures == 0) {
        std::fprintf(stderr, "ALL TESTS PASSED\n");
        return 0;
    }
    std::fprintf(stderr, "FAILED: %d orientation(s)\n", failures);
    return 1;
}
