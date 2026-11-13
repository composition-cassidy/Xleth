// test_compositor.cpp — Verifies GridCompositor with real D3D11 GPU rendering.
// Creates solid-color textures, composites them, reads back pixels to verify
// compositing order and alpha blending.

#include "render/GridCompositor.h"
#include "render/GpuDeviceManager.h"
#include "render/FrameCache.h"
#include "render/FrameCollector.h"
#include "model/TimelineTypes.h"  // kGridSubUnitsPerColumn / Row
#include "model/Timeline.h"       // Test 18: preview/export parity timeline
#include "model/TimelineSnapshot.h"  // Test 19: the export's frozen timeline copy
#include "render/RenderClock.h"
#include "render/VideoEventBuilder.h"

#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

// Force assert even in Release builds (NDEBUG is defined)
#undef NDEBUG
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

static ID3D11Device*        g_device    = nullptr;
static ID3D11DeviceContext* g_deviceCtx = nullptr;

// ---------------------------------------------------------------------------
// Helper: create a solid-color BGRA texture + SRV
// ---------------------------------------------------------------------------
static FrameCacheEntry makeSolidTexture(uint8_t b, uint8_t g, uint8_t r, uint8_t a,
                                         int w = 64, int h = 64)
{
    // Fill BGRA pixel data
    std::vector<uint8_t> pixels(static_cast<size_t>(w) * h * 4);
    for (int i = 0; i < w * h; ++i) {
        pixels[i * 4 + 0] = b;
        pixels[i * 4 + 1] = g;
        pixels[i * 4 + 2] = r;
        pixels[i * 4 + 3] = a;
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
    assert(SUCCEEDED(hr) && "CreateTexture2D failed");

    hr = g_device->CreateShaderResourceView(entry.texture.Get(), nullptr, &entry.srv);
    assert(SUCCEEDED(hr) && "CreateSRV failed");

    entry.width          = w;
    entry.height         = h;
    entry.memorySizeBytes = static_cast<size_t>(w) * h * 4;
    return entry;
}

static FrameCacheEntry makeGradientTexture(int w = 64, int h = 64)
{
    std::vector<uint8_t> pixels(static_cast<size_t>(w) * h * 4);
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            const size_t i = (static_cast<size_t>(y) * w + x) * 4;
            pixels[i + 0] = static_cast<uint8_t>((x * 255) / (w - 1));
            pixels[i + 1] = static_cast<uint8_t>((y * 255) / (h - 1));
            pixels[i + 2] = static_cast<uint8_t>(((x + y) * 255) / (w + h - 2));
            pixels[i + 3] = 255;
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
    assert(SUCCEEDED(hr) && "CreateTexture2D failed");

    hr = g_device->CreateShaderResourceView(entry.texture.Get(), nullptr, &entry.srv);
    assert(SUCCEEDED(hr) && "CreateSRV failed");

    entry.width           = w;
    entry.height          = h;
    entry.memorySizeBytes = static_cast<size_t>(w) * h * 4;
    return entry;
}

// ---------------------------------------------------------------------------
// Helper: sample a pixel from the readback buffer (returns BGRA as uint32_t)
// ---------------------------------------------------------------------------
static uint32_t samplePixel(const ReadbackBuffer& buf, int x, int y)
{
    assert(buf.valid && x >= 0 && x < buf.width && y >= 0 && y < buf.height);
    const uint8_t* p = buf.pixels.data() + y * buf.stride + x * 4;
    return *reinterpret_cast<const uint32_t*>(p);
}

static void extractBGRA(uint32_t px, uint8_t& b, uint8_t& g, uint8_t& r, uint8_t& a)
{
    b = static_cast<uint8_t>(px & 0xFF);
    g = static_cast<uint8_t>((px >> 8) & 0xFF);
    r = static_cast<uint8_t>((px >> 16) & 0xFF);
    a = static_cast<uint8_t>((px >> 24) & 0xFF);
}

// ===========================================================================

int main()
{
    std::fprintf(stderr, "\n[TEST:Compositor] Starting compositor tests...\n");

    // ── GPU setup ────────────────────────────────────────────────────────────
    GpuDeviceManager gpu;
    if (!gpu.detectAdapters()) {
        std::fprintf(stderr, "[TEST:Compositor] SKIP: no DXGI adapters\n");
        return 0;
    }
    if (!gpu.createDevice()) {
        std::fprintf(stderr, "[TEST:Compositor] SKIP: D3D11 device creation failed\n");
        return 0;
    }
    g_device    = gpu.getDevice();
    g_deviceCtx = gpu.getContext();
    assert(g_device && g_deviceCtx);
    std::fprintf(stderr, "[TEST:Compositor] GPU device ready\n");

    // ── Create solid-color textures ──────────────────────────────────────────
    // BGRA format: (Blue, Green, Red, Alpha)
    FrameCacheEntry blueTexture  = makeSolidTexture(255, 0, 0, 255);     // Blue
    FrameCacheEntry redTexture   = makeSolidTexture(0, 0, 255, 255);     // Red
    FrameCacheEntry greenTexture = makeSolidTexture(0, 255, 0, 255);     // Green
    FrameCacheEntry yellowTexture = makeSolidTexture(0, 255, 255, 255);  // Yellow
    // Semi-transparent magenta for opacity testing
    FrameCacheEntry magentaTexture = makeSolidTexture(255, 0, 255, 128); // Magenta, 50% alpha in texture
    FrameCacheEntry gradientTexture = makeGradientTexture();

    std::fprintf(stderr, "[TEST:Compositor] Created test textures\n");

    // ── Set up frame cache with test textures ────────────────────────────────
    RenderFrameCache cache;
    cache.setMemoryLimit(100 * 1024 * 1024);

    cache.put({"blue.mp4", 0},    std::move(blueTexture));
    cache.put({"red.mp4", 0},     std::move(redTexture));
    cache.put({"green.mp4", 0},   std::move(greenTexture));
    cache.put({"yellow.mp4", 0},  std::move(yellowTexture));
    cache.put({"magenta.mp4", 0}, std::move(magentaTexture));
    cache.put({"gradient.mp4", 0}, std::move(gradientTexture));

    // ── Test 1: Basic compositing — chorus + grid cells ─────────────────────
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 1: Basic compositing ---\n");

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 240));

        // Build requests: 2x2 grid
        // Chorus: full-screen blue
        // Cell [0,0]: red (top-left)
        // Cell [1,0]: green (top-right — col 1, row 0)
        std::vector<CellFrameRequest> requests;

        // Chorus
        CellFrameRequest chorus{};
        chorus.cellCol          = 0;
        chorus.cellRow          = 0;
        chorus.spanX            = 2 * kGridSubUnitsPerColumn;  // 2 cols
        chorus.spanY            = 2 * kGridSubUnitsPerRow;     // 2 rows
        chorus.sourcePath       = "blue.mp4";
        chorus.sourceFrameIndex = 0;
        chorus.opacity          = 1.0f;
        chorus.layerKind        = CellLayerKind::FullscreenBehind;
        chorus.zOrder           = -1;
        requests.push_back(chorus);

        // Grid cell [0,0] — top-left: red
        CellFrameRequest cell0{};
        cell0.cellCol          = 0;                        // fine-grid X
        cell0.cellRow          = 0;                        // fine-grid Y
        cell0.spanX            = kGridSubUnitsPerColumn;   // 1 full column
        cell0.spanY            = kGridSubUnitsPerRow;      // 1 full row
        cell0.sourcePath       = "red.mp4";
        cell0.sourceFrameIndex = 0;
        cell0.opacity          = 1.0f;
        cell0.layerKind        = CellLayerKind::Grid;
        cell0.zOrder           = 0;
        requests.push_back(cell0);

        // Grid cell [1,0] — top-right: green (col 1 in 2-col grid)
        CellFrameRequest cell1{};
        cell1.cellCol          = kGridSubUnitsPerColumn;   // start of col 1
        cell1.cellRow          = 0;
        cell1.spanX            = kGridSubUnitsPerColumn;
        cell1.spanY            = kGridSubUnitsPerRow;
        cell1.sourcePath       = "green.mp4";
        cell1.sourceFrameIndex = 0;
        cell1.opacity          = 1.0f;
        cell1.layerKind        = CellLayerKind::Grid;
        cell1.zOrder           = 1;
        requests.push_back(cell1);

        compositor.compositeFrame(requests, cache, 2, 2);

        ReadbackBuffer buf = compositor.readback();
        assert(buf.valid);
        assert(buf.width == 320 && buf.height == 240);

        // Sample pixel at center of cell [0,0]: should be RED
        // Cell [0,0] in 2x2 grid = top-left quarter: X=[0,160), Y=[0,120)
        // Center = (80, 60)
        {
            uint8_t b, g, r, a;
            extractBGRA(samplePixel(buf, 80, 60), b, g, r, a);
            std::fprintf(stderr, "[TEST:Compositor] Cell [0,0] center: R=%d G=%d B=%d A=%d\n", r, g, b, a);
            assert(r > 200 && g < 50 && b < 50 && "Cell [0,0] should be red");
        }

        // Sample pixel at center of cell [1,0]: should be GREEN
        // Cell [1,0] = top-right quarter: X=[160,320), Y=[0,120)
        // Center = (240, 60)
        {
            uint8_t b, g, r, a;
            extractBGRA(samplePixel(buf, 240, 60), b, g, r, a);
            std::fprintf(stderr, "[TEST:Compositor] Cell [1,0] center: R=%d G=%d B=%d A=%d\n", r, g, b, a);
            assert(g > 200 && r < 50 && b < 50 && "Cell [1,0] should be green");
        }

        // Sample pixel at center of cell [1,1] (empty): should be BLUE (chorus)
        // Cell [1,1] = bottom-right quarter: X=[160,320), Y=[120,240)
        // Center = (240, 180)
        {
            uint8_t b, g, r, a;
            extractBGRA(samplePixel(buf, 240, 180), b, g, r, a);
            std::fprintf(stderr, "[TEST:Compositor] Cell [1,1] (gap) center: R=%d G=%d B=%d A=%d\n", r, g, b, a);
            assert(b > 200 && r < 50 && g < 50 && "Gap should show blue chorus");
        }

        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 1: PASSED\n");
    }

    // ── Test 2: Opacity blending ────────────────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 2: Opacity blending ---\n");

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 240));

        // Chorus: blue (full-screen)
        // One grid cell at [0,0]: red, opacity=0.5
        std::vector<CellFrameRequest> requests;

        CellFrameRequest chorus{};
        chorus.cellCol = 0; chorus.cellRow = 0;
        chorus.spanX = 2 * kGridSubUnitsPerColumn; chorus.spanY = 2 * kGridSubUnitsPerRow;
        chorus.sourcePath = "blue.mp4";
        chorus.sourceFrameIndex = 0;
        chorus.opacity = 1.0f;
        chorus.layerKind = CellLayerKind::FullscreenBehind;
        requests.push_back(chorus);

        CellFrameRequest cell{};
        cell.cellCol = 0; cell.cellRow = 0;
        cell.spanX = kGridSubUnitsPerColumn; cell.spanY = kGridSubUnitsPerRow;
        cell.sourcePath = "red.mp4";
        cell.sourceFrameIndex = 0;
        cell.opacity = 0.5f;
        requests.push_back(cell);

        compositor.compositeFrame(requests, cache, 2, 2);
        ReadbackBuffer buf = compositor.readback();
        assert(buf.valid);

        // Cell [0,0] center at (80,60): should be blend of red (50%) over blue
        // Red BGRA = (0,0,255,255), at opacity 0.5 → alpha = 0.5
        // Blend: out = src * src_alpha + dst * (1 - src_alpha)
        // R: 255*0.5 + 0*0.5 = 127.5 ≈ 128
        // B: 0*0.5 + 255*0.5 = 127.5 ≈ 128
        {
            uint8_t b, g, r, a;
            extractBGRA(samplePixel(buf, 80, 60), b, g, r, a);
            std::fprintf(stderr, "[TEST:Compositor] Blended pixel: R=%d G=%d B=%d A=%d (expect ~128, ~0, ~128)\n",
                         r, g, b, a);
            assert(r > 100 && r < 180 && "Red channel should be ~128 (50% blend)");
            assert(b > 100 && b < 180 && "Blue channel should be ~128 (50% blend)");
            assert(g < 50 && "Green channel should be near 0");
        }

        // Cell [1,1] (gap): should still be pure blue
        {
            uint8_t b, g, r, a;
            extractBGRA(samplePixel(buf, 240, 180), b, g, r, a);
            assert(b > 200 && r < 50 && "Gap should be pure blue chorus");
        }

        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 2: PASSED\n");
    }

    // ── Test 3: Crash overlay ───────────────────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 3: Crash overlay ---\n");

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 240));

        // Grid cell: red at [0,0]
        // Crash: yellow at full opacity on top
        std::vector<CellFrameRequest> requests;

        CellFrameRequest cell{};
        cell.cellCol = 0; cell.cellRow = 0;
        cell.spanX = 2 * kGridSubUnitsPerColumn; cell.spanY = 2 * kGridSubUnitsPerRow;  // full screen
        cell.sourcePath = "red.mp4";
        cell.sourceFrameIndex = 0;
        cell.opacity = 1.0f;
        requests.push_back(cell);

        CellFrameRequest crash{};
        crash.cellCol = 0; crash.cellRow = 0;
        crash.spanX = 2 * kGridSubUnitsPerColumn; crash.spanY = 2 * kGridSubUnitsPerRow;
        crash.sourcePath = "yellow.mp4";
        crash.sourceFrameIndex = 0;
        crash.opacity = 1.0f;
        crash.layerKind = CellLayerKind::FullscreenInFront;
        crash.zOrder = 999;
        requests.push_back(crash);

        compositor.compositeFrame(requests, cache, 2, 2);
        ReadbackBuffer buf = compositor.readback();
        assert(buf.valid);

        // Center pixel should be YELLOW (crash on top with full opacity)
        // Yellow BGRA = (0, 255, 255, 255)
        {
            uint8_t b, g, r, a;
            extractBGRA(samplePixel(buf, 160, 120), b, g, r, a);
            std::fprintf(stderr, "[TEST:Compositor] Crash pixel: R=%d G=%d B=%d A=%d\n", r, g, b, a);
            assert(r > 200 && g > 200 && b < 50 && "Should be yellow (crash on top)");
        }

        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 3: PASSED\n");
    }

    // ── Test 4: Empty frame (no requests) → black ───────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 4: Empty frame ---\n");

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 240));

        std::vector<CellFrameRequest> empty;
        compositor.compositeFrame(empty, cache, 2, 2);
        ReadbackBuffer buf = compositor.readback();
        assert(buf.valid);

        // Should be black
        {
            uint8_t b, g, r, a;
            extractBGRA(samplePixel(buf, 160, 120), b, g, r, a);
            std::fprintf(stderr, "[TEST:Compositor] Black pixel: R=%d G=%d B=%d A=%d\n", r, g, b, a);
            assert(r == 0 && g == 0 && b == 0 && "Empty frame should be black");
        }

        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 4: PASSED\n");
    }

    // ── Test 5: Null texture (cache miss) → skip cell gracefully ────────────
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 5: Cache miss ---\n");

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 240));

        std::vector<CellFrameRequest> requests;

        CellFrameRequest cell{};
        cell.cellCol = 0; cell.cellRow = 0;
        cell.spanX = 2 * kGridSubUnitsPerColumn; cell.spanY = 2 * kGridSubUnitsPerRow;
        cell.sourcePath = "nonexistent.mp4";   // Not in cache
        cell.sourceFrameIndex = 999;
        cell.opacity = 1.0f;
        requests.push_back(cell);

        // Should not crash
        compositor.compositeFrame(requests, cache, 2, 2);
        ReadbackBuffer buf = compositor.readback();
        assert(buf.valid);

        // Should still be black (skipped cell)
        {
            uint8_t b, g, r, a;
            extractBGRA(samplePixel(buf, 160, 120), b, g, r, a);
            assert(r == 0 && g == 0 && b == 0 && "Cache miss should result in black");
        }

        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 5: PASSED\n");
    }

    // ── Test 6: Render target dimensions ────────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 6: Dimensions ---\n");

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 1920, 1080));
        assert(compositor.isInitialized());
        assert(compositor.getWidth() == 1920);
        assert(compositor.getHeight() == 1080);
        assert(compositor.getRenderTarget() != nullptr);
        assert(compositor.getRenderTargetSRV() != nullptr);

        compositor.shutdown();
        assert(!compositor.isInitialized());

        std::fprintf(stderr, "[TEST:Compositor] Test 6: PASSED\n");
    }

    // ── Test 7: Compositing order — grid draws OVER chorus ──────────────────
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 7: Compositing order ---\n");

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 240));

        // Chorus: blue (full-screen)
        // Grid cell: red (full-screen, on top)
        // Expected: red everywhere (grid draws OVER chorus)
        std::vector<CellFrameRequest> requests;

        CellFrameRequest chorus{};
        chorus.cellCol = 0; chorus.cellRow = 0;
        chorus.spanX = 2 * kGridSubUnitsPerColumn; chorus.spanY = 2 * kGridSubUnitsPerRow;
        chorus.sourcePath = "blue.mp4";
        chorus.sourceFrameIndex = 0;
        chorus.opacity = 1.0f;
        chorus.layerKind = CellLayerKind::FullscreenBehind;
        requests.push_back(chorus);

        CellFrameRequest cell{};
        cell.cellCol = 0; cell.cellRow = 0;
        cell.spanX = 2 * kGridSubUnitsPerColumn; cell.spanY = 2 * kGridSubUnitsPerRow;
        cell.sourcePath = "red.mp4";
        cell.sourceFrameIndex = 0;
        cell.opacity = 1.0f;
        requests.push_back(cell);

        compositor.compositeFrame(requests, cache, 2, 2);
        ReadbackBuffer buf = compositor.readback();
        assert(buf.valid);

        {
            uint8_t b, g, r, a;
            extractBGRA(samplePixel(buf, 160, 120), b, g, r, a);
            std::fprintf(stderr, "[TEST:Compositor] Order pixel: R=%d G=%d B=%d A=%d\n", r, g, b, a);
            assert(r > 200 && g < 50 && b < 50 && "Grid should draw OVER chorus");
        }

        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 7: PASSED\n");
    }

    // ── Test 8: Shutdown and reinit ─────────────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 8: Companion FX bypass identity ---\n");

        GridCompositor bypassCompositor;
        assert(bypassCompositor.init(g_device, g_deviceCtx, 320, 240));

        std::vector<CellFrameRequest> baselineRequests;
        CellFrameRequest baseline{};
        baseline.cellCol = 0; baseline.cellRow = 0;
        baseline.spanX = 2 * kGridSubUnitsPerColumn;
        baseline.spanY = 2 * kGridSubUnitsPerRow;
        baseline.sourcePath = "gradient.mp4";
        baseline.sourceFrameIndex = 0;
        baseline.opacity = 1.0f;
        baselineRequests.push_back(baseline);

        bypassCompositor.compositeFrame(baselineRequests, cache, 2, 2);
        ReadbackBuffer baseBuf = bypassCompositor.readback();
        assert(baseBuf.valid);
        const uint32_t baseA = samplePixel(baseBuf, 80, 60);
        const uint32_t baseB = samplePixel(baseBuf, 240, 180);

        CellFrameRequest companion = baseline;
        companion.companionFx.vibratoSwirlEnabled = true;
        companion.companionFx.scratchWaveEnabled = true;
        companion.companionFx.vibratoLfo = 1.0f;
        companion.companionFx.swirlAmount = 0.8f;
        companion.companionFx.swirlRadius = 0.6f;
        companion.companionFx.scratchRateMultiplier = -1.0f;
        companion.companionFx.scratchPhase01 = 0.25f;
        companion.companionFx.scratchIntensity01 = 1.0f;
        companion.companionFx.waveAmount = 0.12f;
        companion.companionFx.waveFrequency = 8.0f;
        companion.companionFx.smearAmount = 0.4f;
        companion.companionFx.reverseWaveWithScratch = true;

        bypassCompositor.setEffectsBypass(true);
        bypassCompositor.compositeFrame(std::vector<CellFrameRequest>{companion}, cache, 2, 2);
        ReadbackBuffer bypassBuf = bypassCompositor.readback();
        assert(bypassBuf.valid);
        assert(samplePixel(bypassBuf, 80, 60) == baseA);
        assert(samplePixel(bypassBuf, 240, 180) == baseB);

        bypassCompositor.setEffectsBypass(false);
        bypassCompositor.compositeFrame(std::vector<CellFrameRequest>{companion}, cache, 2, 2);
        ReadbackBuffer activeBuf = bypassCompositor.readback();
        assert(activeBuf.valid);
        const bool activeChanged =
            samplePixel(activeBuf, 80, 60) != baseA ||
            samplePixel(activeBuf, 240, 180) != baseB;
        assert(activeChanged && "Active companion FX should alter the gradient texture");

        auto sampleCompanion = [&](const ClipCompanionFxSnapshot& fx, int x, int y) {
            CellFrameRequest req = baseline;
            req.companionFx = fx;
            bypassCompositor.compositeFrame(std::vector<CellFrameRequest>{req}, cache, 2, 2);
            ReadbackBuffer buf = bypassCompositor.readback();
            assert(buf.valid);
            return samplePixel(buf, x, y);
        };

        ClipCompanionFxSnapshot positiveSwirl{};
        positiveSwirl.vibratoSwirlEnabled = true;
        positiveSwirl.vibratoLfo = 1.0f;
        positiveSwirl.swirlAmount = 0.35f;
        positiveSwirl.swirlRadius = 0.8f;
        const uint32_t positiveSwirlPixel = sampleCompanion(positiveSwirl, 200, 80);

        ClipCompanionFxSnapshot negativeSwirl = positiveSwirl;
        negativeSwirl.swirlAmount = -0.35f;
        const uint32_t negativeSwirlPixel = sampleCompanion(negativeSwirl, 200, 80);
        assert(positiveSwirlPixel != negativeSwirlPixel &&
               "Signed swirlAmount should invert swirl direction");

        ClipCompanionFxSnapshot negativeLfoSwirl = positiveSwirl;
        negativeLfoSwirl.vibratoLfo = -1.0f;
        const uint32_t negativeLfoSwirlPixel = sampleCompanion(negativeLfoSwirl, 200, 80);
        assert(negativeLfoSwirlPixel == negativeSwirlPixel &&
               "Signed vibratoLfo should follow pitch direction");

        ClipCompanionFxSnapshot positiveWave{};
        positiveWave.scratchWaveEnabled = true;
        positiveWave.waveAmount = 0.2f;
        positiveWave.waveFrequency = 1.0f;
        positiveWave.smearAmount = 0.0f;
        positiveWave.scratchRateMultiplier = 1.0f;
        positiveWave.scratchIntensity01 = 1.0f;
        positiveWave.reverseWaveWithScratch = true;
        const uint32_t positiveWavePixel = sampleCompanion(positiveWave, 160, 60);

        ClipCompanionFxSnapshot negativeWave = positiveWave;
        negativeWave.waveAmount = -0.2f;
        const uint32_t negativeWavePixel = sampleCompanion(negativeWave, 160, 60);
        assert(positiveWavePixel != negativeWavePixel &&
               "Signed waveAmount should invert wave displacement");

        ClipCompanionFxSnapshot reverseScratchWave = positiveWave;
        reverseScratchWave.scratchRateMultiplier = -1.0f;
        const uint32_t reverseScratchWavePixel = sampleCompanion(reverseScratchWave, 160, 60);
        assert(reverseScratchWavePixel == negativeWavePixel &&
               "reverseWaveWithScratch should flip direction for negative scratch rate");

        bypassCompositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 8: PASSED\n");

        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 9: Shutdown + reinit ---\n");

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 240));
        compositor.shutdown();
        assert(!compositor.isInitialized());

        // Reinit at different resolution
        assert(compositor.init(g_device, g_deviceCtx, 640, 480));
        assert(compositor.getWidth() == 640);
        assert(compositor.getHeight() == 480);

        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 9: PASSED\n");
    }

    // ── Test 10: fullscreen layer interleaved BETWEEN two grid cells ────────
    // The core new behavior: a fullscreen layer is no longer forced fully behind
    // or fully in front. Drawn in request order (grid red z0, fullscreen blue z5,
    // grid green z10), the blue full-canvas layer must occlude the red left cell
    // (blue is above red) yet be occluded by the green right cell (blue is below
    // green) — i.e. it composites strictly between them.
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 10: interleaved fullscreen layer ---\n");

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 240));

        std::vector<CellFrameRequest> requests;

        // Grid red — left half, zOrder 0 (drawn first).
        CellFrameRequest red{};
        red.cellCol = 0; red.cellRow = 0;
        red.spanX = kGridSubUnitsPerColumn; red.spanY = kGridSubUnitsPerRow;
        red.sourcePath = "red.mp4"; red.sourceFrameIndex = 0;
        red.opacity = 1.0f; red.layerKind = CellLayerKind::Grid; red.zOrder = 0;
        requests.push_back(red);

        // Fullscreen blue — zOrder 5, BETWEEN the two grid cells.
        CellFrameRequest blue{};
        blue.sourcePath = "blue.mp4"; blue.sourceFrameIndex = 0;
        blue.opacity = 1.0f; blue.layerKind = CellLayerKind::FullscreenBehind; blue.zOrder = 5;
        requests.push_back(blue);

        // Grid green — right half, zOrder 10 (drawn last).
        CellFrameRequest green{};
        green.cellCol = kGridSubUnitsPerColumn; green.cellRow = 0;
        green.spanX = kGridSubUnitsPerColumn; green.spanY = kGridSubUnitsPerRow;
        green.sourcePath = "green.mp4"; green.sourceFrameIndex = 0;
        green.opacity = 1.0f; green.layerKind = CellLayerKind::Grid; green.zOrder = 10;
        requests.push_back(green);

        compositor.compositeFrame(requests, cache, 2, 1);
        ReadbackBuffer buf = compositor.readback();
        assert(buf.valid);

        // Left half (80,120): blue drew over red → BLUE.
        {
            uint8_t b, g, r, a;
            extractBGRA(samplePixel(buf, 80, 120), b, g, r, a);
            std::fprintf(stderr, "[TEST:Compositor] Left (over red): R=%d G=%d B=%d (expect blue)\n", r, g, b);
            assert(b > 200 && r < 50 && g < 50 && "Fullscreen layer must occlude the lower-z grid cell");
        }
        // Right half (240,120): green drew over blue → GREEN.
        {
            uint8_t b, g, r, a;
            extractBGRA(samplePixel(buf, 240, 120), b, g, r, a);
            std::fprintf(stderr, "[TEST:Compositor] Right (over blue): R=%d G=%d B=%d (expect green)\n", r, g, b);
            assert(g > 200 && b < 50 && r < 50 && "Higher-z grid cell must occlude the fullscreen layer");
        }

        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 10: PASSED\n");
    }

    // ── Test 11: fullscreen rect == the canvas-fit rect, exactly ────────────
    // The unified per-cell path starts a fullscreen layer from the canvas-UV
    // rect (0,0,1,1) and lets the shared canvas-fit mapping place it, instead
    // of drawing (canvasFitX_..canvasFitH_) directly the way the old dedicated
    // fullscreen branch did. This is the frame-identity guard for that swap:
    // under a deliberately NON-identity (pillarboxed) fit the layer must land
    // on exactly the fitted rect and not one pixel outside it.
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 11: fullscreen honours canvas fit ---\n");

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 240));
        // Pillarbox: content occupies x in [80, 240) of a 320-wide output.
        compositor.setCanvasFit(0.25f, 0.0f, 0.5f, 1.0f);

        CellFrameRequest fs{};
        fs.sourcePath = "blue.mp4"; fs.sourceFrameIndex = 0;
        fs.opacity = 1.0f; fs.layerKind = CellLayerKind::FullscreenBehind; fs.zOrder = 0;
        std::vector<CellFrameRequest> requests{ fs };

        compositor.compositeFrame(requests, cache, 2, 1);
        ReadbackBuffer buf = compositor.readback();
        assert(buf.valid);

        uint8_t b, g, r, a;
        extractBGRA(samplePixel(buf, 160, 120), b, g, r, a);   // inside the fit
        std::fprintf(stderr, "[TEST:Compositor] inside fit  (160,120): B=%d A=%d\n", b, a);
        assert(b > 200 && a > 200 && "Fullscreen layer must fill the canvas-fit rect");

        extractBGRA(samplePixel(buf, 85, 120), b, g, r, a);    // just inside the left edge
        assert(b > 200 && a > 200 && "Fullscreen layer must reach the left edge of the fit");

        extractBGRA(samplePixel(buf, 20, 120), b, g, r, a);    // left pillar
        std::fprintf(stderr, "[TEST:Compositor] left pillar  (20,120): B=%d A=%d\n", b, a);
        assert(a < 16 && "Fullscreen layer must NOT spill into the left pillar");

        extractBGRA(samplePixel(buf, 300, 120), b, g, r, a);   // right pillar
        assert(a < 16 && "Fullscreen layer must NOT spill into the right pillar");

        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 11: PASSED\n");
    }

    // ── Test 12: fullscreen layer runs the track visual effect chain ────────
    // Previously the fullscreen branch never touched visualChain at all, so a
    // backdrop silently lost the track's look. Full Desaturation on a pure-blue
    // source is the cheapest unambiguous proof: the result must come back grey.
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 12: fullscreen visual effect chain ---\n");

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 240));

        VisualEffect desat;
        desat.type      = VisualEffect::Type::Desaturation;
        desat.bypassed  = false;
        desat.params[0] = 1.0f;   // full

        CellFrameRequest fs{};
        fs.sourcePath = "blue.mp4"; fs.sourceFrameIndex = 0;
        fs.opacity = 1.0f; fs.layerKind = CellLayerKind::FullscreenBehind; fs.zOrder = 0;
        fs.visualChain = { desat };
        std::vector<CellFrameRequest> requests{ fs };

        compositor.compositeFrame(requests, cache, 1, 1);
        ReadbackBuffer buf = compositor.readback();
        assert(buf.valid);

        uint8_t b, g, r, a;
        extractBGRA(samplePixel(buf, 160, 120), b, g, r, a);
        std::fprintf(stderr, "[TEST:Compositor] desaturated FS: R=%d G=%d B=%d A=%d (expect grey)\n",
                     r, g, b, a);
        assert(a > 200 && "Desaturated fullscreen layer must still be opaque");
        assert(std::abs((int)r - (int)g) <= 3 && std::abs((int)g - (int)b) <= 3
               && "Fullscreen layer must run the visual effect chain (channels must converge)");
        assert(b < 128 && "Pure blue fully desaturated must darken well below 255");

        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 12: PASSED\n");
    }

    // ── Test 13: fullscreen layer honours corner radius ─────────────────────
    // The old fullscreen branch passed a hardcoded 0.0f radius to drawCell.
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 13: fullscreen corner radius ---\n");

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 240));

        CellFrameRequest fs{};
        fs.sourcePath = "blue.mp4"; fs.sourceFrameIndex = 0;
        fs.opacity = 1.0f; fs.layerKind = CellLayerKind::FullscreenInFront; fs.zOrder = 0;
        fs.cornerRadius = 0.5f;   // radiusPx = 0.5 * min(320,240) = 120
        std::vector<CellFrameRequest> requests{ fs };

        compositor.compositeFrame(requests, cache, 1, 1);
        ReadbackBuffer buf = compositor.readback();
        assert(buf.valid);

        uint8_t b, g, r, a;
        extractBGRA(samplePixel(buf, 160, 120), b, g, r, a);
        assert(b > 200 && a > 200 && "Rounded fullscreen layer must still fill its centre");

        extractBGRA(samplePixel(buf, 1, 1), b, g, r, a);
        std::fprintf(stderr, "[TEST:Compositor] rounded FS corner (1,1): A=%d (expect ~0)\n", a);
        assert(a < 16 && "Fullscreen layer must honour cornerRadius (corner must be cut)");

        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 13: PASSED\n");
    }

    // ── Test 14: fullscreen layer honours the ping-pong crossfade ───────────
    // The crossfade block used to be gated on layerKind == Grid, so a
    // ping-ponging track went un-blended the moment it was made fullscreen.
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 14: fullscreen ping-pong crossfade ---\n");

        // Same path, two frame indices: primary blue, secondary red.
        cache.put({"pp.mp4", 0},  makeSolidTexture(255, 0, 0, 255));   // blue
        cache.put({"pp.mp4", 10}, makeSolidTexture(0, 0, 255, 255));   // red

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 240));

        CellFrameRequest fs{};
        fs.sourcePath = "pp.mp4"; fs.sourceFrameIndex = 0;
        fs.opacity = 1.0f; fs.layerKind = CellLayerKind::FullscreenBehind; fs.zOrder = 0;
        fs.pingPongSecondaryFrame = 10;
        fs.pingPongBlendFactor    = 0.5f;
        std::vector<CellFrameRequest> requests{ fs };

        compositor.compositeFrame(requests, cache, 1, 1);
        ReadbackBuffer buf = compositor.readback();
        assert(buf.valid);

        uint8_t b, g, r, a;
        extractBGRA(samplePixel(buf, 160, 120), b, g, r, a);
        std::fprintf(stderr, "[TEST:Compositor] FS ping-pong 50%%: R=%d G=%d B=%d A=%d (expect ~half/half)\n",
                     r, g, b, a);
        assert(a > 200 && "Crossfaded fullscreen layer must stay opaque");
        assert(r > 90 && r < 165 && "Secondary frame must be blended into the fullscreen layer");
        assert(b > 90 && b < 165 && "Primary frame must survive the fullscreen crossfade");

        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 14: PASSED\n");
    }

    // ── Test 15: gap and bounce stay GRID-ONLY ──────────────────────────────
    // Both are authored as fractions of a grid CELL, so they are deliberately
    // not applied to a full-canvas rect. A fullscreen request carrying both
    // (the collector takes one animation snapshot per track, bounce included)
    // must still cover the canvas edge-to-edge.
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 15: gap/bounce stay grid-only ---\n");

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 240));

        CellFrameRequest fs{};
        fs.sourcePath = "blue.mp4"; fs.sourceFrameIndex = 0;
        fs.opacity = 1.0f; fs.layerKind = CellLayerKind::FullscreenBehind; fs.zOrder = 0;
        fs.gapScaleOverride = 0.5f;    // would inset the rect by 25% per side
        fs.bounceOffsetX    = 0.5f;    // would shove it half a rect to the right
        fs.bounceScaleX     = 0.5f;
        fs.bounceScaleY     = 0.5f;
        std::vector<CellFrameRequest> requests{ fs };

        compositor.compositeFrame(requests, cache, 1, 1, /*time=*/0.0f, /*gapScale=*/0.5f);
        ReadbackBuffer buf = compositor.readback();
        assert(buf.valid);

        const int probes[4][2] = { {2, 2}, {317, 2}, {2, 237}, {317, 237} };
        for (const auto& p : probes) {
            uint8_t b, g, r, a;
            extractBGRA(samplePixel(buf, p[0], p[1]), b, g, r, a);
            std::fprintf(stderr, "[TEST:Compositor] corner (%d,%d): B=%d A=%d\n", p[0], p[1], b, a);
            assert(b > 200 && a > 200
                   && "Gap/bounce must NOT be applied to a fullscreen layer");
        }

        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 15: PASSED\n");
    }

    // ── Test 16: readback into a caller-owned destination ───────────────────
    // The live preview hands readback() the shared-memory back buffer so the
    // frame is not copied into the compositor's own vector first. That is only
    // legitimate if the bytes come out identical either way, and if a
    // destination that does not fit is refused rather than half-filled.
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 16: readback into caller destination ---\n");

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 240));

        // Two cells, so a row-order or stride fault cannot hide behind a
        // uniformly coloured frame.
        std::vector<CellFrameRequest> requests;
        CellFrameRequest left{};
        left.cellCol = 0; left.cellRow = 0;
        left.spanX = kGridSubUnitsPerColumn; left.spanY = kGridSubUnitsPerRow;
        left.sourcePath = "red.mp4"; left.sourceFrameIndex = 0;
        left.opacity = 1.0f; left.layerKind = CellLayerKind::Grid; left.zOrder = 0;
        requests.push_back(left);

        CellFrameRequest right{};
        right.cellCol = kGridSubUnitsPerColumn; right.cellRow = 0;
        right.spanX = kGridSubUnitsPerColumn; right.spanY = kGridSubUnitsPerRow;
        right.sourcePath = "green.mp4"; right.sourceFrameIndex = 0;
        right.opacity = 1.0f; right.layerKind = CellLayerKind::Grid; right.zOrder = 1;
        requests.push_back(right);

        // Reference: the ordinary owning-vector path.
        compositor.compositeFrame(requests, cache, 2, 2);
        const ReadbackBuffer reference = compositor.readback();
        assert(reference.valid);
        assert(!reference.intoDestination
               && "a readback with no destination must fill its own vector");
        const size_t frameBytes =
            static_cast<size_t>(reference.stride) * reference.height;
        assert(reference.pixels.size() == frameBytes);
        const std::vector<uint8_t> expected = reference.pixels;

        // Same scene, straight into a caller-owned buffer.
        std::vector<uint8_t> dest(frameBytes, 0xAB);
        compositor.compositeFrame(requests, cache, 2, 2);
        const ReadbackBuffer& direct =
            compositor.readback(ReadbackMode::Immediate, dest.data(), dest.size());
        assert(direct.valid);
        assert(direct.intoDestination && "a fitting destination must be used");
        assert(direct.width == reference.width && direct.height == reference.height);
        assert(direct.stride == reference.stride);
        assert(std::memcmp(dest.data(), expected.data(), frameBytes) == 0
               && "direct readback must be byte-identical to the vector path");
        std::fprintf(stderr,
                     "[TEST:Compositor] direct destination matches vector path (%llu bytes)\n",
                     static_cast<unsigned long long>(frameBytes));

        // A destination whose size does not match the frame is refused outright:
        // the frame goes to the vector and the caller's buffer is left alone.
        std::vector<uint8_t> misSized(frameBytes, 0xAB);
        compositor.compositeFrame(requests, cache, 2, 2);
        const ReadbackBuffer& refused =
            compositor.readback(ReadbackMode::Immediate, misSized.data(), frameBytes - 4);
        assert(refused.valid);
        assert(!refused.intoDestination && "a mis-sized destination must be refused");
        assert(refused.pixels.size() == frameBytes);
        assert(std::memcmp(refused.pixels.data(), expected.data(), frameBytes) == 0
               && "the refused path must still produce the same frame");
        for (size_t i = 0; i < misSized.size(); ++i) {
            assert(misSized[i] == 0xAB
                   && "a refused destination must not be written to at all");
        }
        std::fprintf(stderr, "[TEST:Compositor] mis-sized destination refused, buffer untouched\n");

        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 16: PASSED\n");
    }

    // ── Test 17: Lens + Roam (P2) ───────────────────────────────────────────
    // Lens frames the source inside the cell (fit, centre, zoom; flip mirrors
    // the FRAMED result). Roam moves the cell (offset in cell units, scale,
    // rotation), Bounds Clip scissors to the home rect, Float does not. Half
    // grid placements and the fullscreen (Chorus) layer take both.
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 17: Lens + Roam ---\n");

        auto makeTex = [](int w, int h, auto colorAt) {
            std::vector<uint8_t> px(static_cast<size_t>(w) * h * 4);
            for (int y = 0; y < h; ++y)
                for (int x = 0; x < w; ++x) {
                    uint8_t b, g, r;
                    colorAt(x, y, b, g, r);
                    const size_t i = (static_cast<size_t>(y) * w + x) * 4;
                    px[i + 0] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = 255;
                }
            D3D11_TEXTURE2D_DESC desc = {};
            desc.Width = static_cast<UINT>(w); desc.Height = static_cast<UINT>(h);
            desc.MipLevels = 1; desc.ArraySize = 1;
            desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
            desc.SampleDesc.Count = 1;
            desc.Usage = D3D11_USAGE_DEFAULT;
            desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
            D3D11_SUBRESOURCE_DATA init = {};
            init.pSysMem = px.data();
            init.SysMemPitch = static_cast<UINT>(w * 4);
            FrameCacheEntry e;
            HRESULT hr = g_device->CreateTexture2D(&desc, &init, &e.texture);
            assert(SUCCEEDED(hr));
            hr = g_device->CreateShaderResourceView(e.texture.Get(), nullptr, &e.srv);
            assert(SUCCEEDED(hr));
            e.width = w; e.height = h;
            e.memorySizeBytes = static_cast<size_t>(w) * h * 4;
            return e;
        };
        // 64x64 quadrants: TL red, TR green, BL blue, BR yellow.
        cache.put({"quad.mp4", 0}, makeTex(64, 64, [](int x, int y, uint8_t& b, uint8_t& g, uint8_t& r) {
            const bool right = x >= 32, bottom = y >= 32;
            b = (!right && bottom) ? 255 : 0;
            g = right ? 255 : 0;
            r = (!right && !bottom) || (right && bottom) ? 255 : 0;
        }));
        // 128x64 (2:1): a blue band on the left eighth, green elsewhere.
        cache.put({"band.mp4", 0}, makeTex(128, 64, [](int x, int, uint8_t& b, uint8_t& g, uint8_t& r) {
            b = x < 16 ? 255 : 0; g = x < 16 ? 0 : 255; r = 0;
        }));

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 240));

        struct Px { int r, g, b, a; };
        auto at = [](const ReadbackBuffer& buf, int x, int y) {
            uint8_t b, g, r, a;
            extractBGRA(samplePixel(buf, x, y), b, g, r, a);
            return Px{ r, g, b, a };
        };
        auto isEmpty = [](Px p) { return p.r == 0 && p.g == 0 && p.b == 0 && p.a == 0; };
        auto isRed   = [](Px p) { return p.r > 200 && p.g < 50 && p.b < 50 && p.a > 200; };
        auto isGreen = [](Px p) { return p.g > 200 && p.r < 50 && p.b < 50 && p.a > 200; };
        auto isBlue  = [](Px p) { return p.b > 200 && p.r < 50 && p.g < 50 && p.a > 200; };
        auto fullCell = [](const char* path) {
            CellFrameRequest c{};
            c.cellCol = 0; c.cellRow = 0;
            c.spanX = kGridSubUnitsPerColumn; c.spanY = kGridSubUnitsPerRow;
            c.sourcePath = path; c.sourceFrameIndex = 0; c.opacity = 1.0f;
            return c;
        };
        auto render = [&](const std::vector<CellFrameRequest>& reqs, int cols, int rows) {
            compositor.compositeFrame(reqs, cache, cols, rows);
            ReadbackBuffer b = compositor.readback();
            assert(b.valid);
            return b;
        };

        // 17a: fit. A 2:1 source in a 4:3 cell (1x1 grid, 320x240).
        {
            CellFrameRequest c = fullCell("band.mp4");
            ReadbackBuffer s = render({ c }, 1, 1);                 // identity = Stretch
            assert(isBlue(at(s, 5, 120)) && isBlue(at(s, 30, 120)) && "stretch shows the band at the edge");

            c.lens.fit = LensFit::Cover;                            // 480x240, 80 px cropped each side
            ReadbackBuffer cv = render({ c }, 1, 1);
            assert(isGreen(at(cv, 30, 120)) && "cover crops the band away");
            assert(isGreen(at(cv, 160, 5)) && "cover fills the full height");

            c.lens.fit = LensFit::Contain;                          // 320x160, 40 px bars top/bottom
            ReadbackBuffer cn = render({ c }, 1, 1);
            assert(isEmpty(at(cn, 160, 20)) && isEmpty(at(cn, 160, 220)) && "contain letterboxes with the empty cell background");
            assert(isGreen(at(cn, 160, 120)) && isBlue(at(cn, 5, 120)) && "contain keeps the whole width");
            std::fprintf(stderr, "[TEST:Compositor] 17a fit Stretch/Cover/Contain OK\n");
        }

        // 17b: centre + zoom. Zoom 2 about the red quadrant's centre fills the
        // cell with red.
        {
            CellFrameRequest c = fullCell("quad.mp4");
            c.lens.centerX = 0.25f; c.lens.centerY = 0.25f; c.lens.zoom = 2.0f;
            ReadbackBuffer b = render({ c }, 1, 1);
            assert(isRed(at(b, 10, 10)) && isRed(at(b, 310, 230)) && isRed(at(b, 160, 120)));
            std::fprintf(stderr, "[TEST:Compositor] 17b centre + zoom OK\n");
        }

        // 17c: flip mirrors the FRAMED result. Centre moved left by a quarter:
        // the cell's left quarter falls outside the source (empty). A
        // horizontal flip of the framed cell puts that empty strip on the
        // RIGHT (flipping the source first would have kept it on the left).
        {
            CellFrameRequest c = fullCell("quad.mp4");
            c.lens.centerX = 0.25f;
            ReadbackBuffer n = render({ c }, 1, 1);
            assert(isEmpty(at(n, 20, 120)) && !isEmpty(at(n, 300, 120)));
            c.orientation = 1;                                      // the track's flip
            ReadbackBuffer f = render({ c }, 1, 1);
            assert(isEmpty(at(f, 300, 120)) && !isEmpty(at(f, 20, 120)) && "flip mirrors the framed cell");
            c.lens.flip = LensFlip::None;                           // Lens override beats the track
            ReadbackBuffer o = render({ c }, 1, 1);
            assert(isEmpty(at(o, 20, 120)) && !isEmpty(at(o, 300, 120)) && "Lens flip None overrides the track flip");
            std::fprintf(stderr, "[TEST:Compositor] 17c flip after Lens OK\n");
        }

        // 17d: Roam offset, Clip vs Float. 2x2 grid: the red cell's home is
        // the top-left quadrant (0..160 x 0..120).
        {
            CellFrameRequest c = fullCell("red.mp4");
            c.roam.offsetX = 1.0f;                                  // one cell right
            c.roam.bounds = RoamBounds::Float;
            ReadbackBuffer fl = render({ c }, 2, 2);
            assert(isRed(at(fl, 240, 60)) && isEmpty(at(fl, 80, 60)) && "Float: moved one cell right, unclipped");
            c.roam.bounds = RoamBounds::Clip;
            ReadbackBuffer cl = render({ c }, 2, 2);
            assert(isEmpty(at(cl, 240, 60)) && isEmpty(at(cl, 80, 60)) && "Clip: moved fully out of its home -> gone");
            c.roam.offsetX = 0.5f;
            ReadbackBuffer half = render({ c }, 2, 2);
            assert(isRed(at(half, 120, 60)) && isEmpty(at(half, 40, 60)) && isEmpty(at(half, 200, 60))
                   && "Clip: half a cell right shows only the part still inside home");
            c.roam.bounds = RoamBounds::Float;
            ReadbackBuffer halfF = render({ c }, 2, 2);
            assert(isRed(at(halfF, 200, 60)) && "Float: the overhang is drawn");
            std::fprintf(stderr, "[TEST:Compositor] 17d offset Clip/Float OK\n");
        }

        // 17e: scale and rotation about the cell centre (80, 60).
        {
            CellFrameRequest c = fullCell("red.mp4");
            c.roam.scale = 0.5f;
            ReadbackBuffer s = render({ c }, 2, 2);
            assert(isRed(at(s, 80, 60)) && isEmpty(at(s, 10, 10)) && "scale 0.5 shrinks about the centre");

            CellFrameRequest r = fullCell("red.mp4");
            r.roam.rotationDeg = 90.0f;                             // 160x120 -> 120x160 upright
            r.roam.bounds = RoamBounds::Float;
            ReadbackBuffer rf = render({ r }, 2, 2);
            assert(isRed(at(rf, 80, 130)) && isEmpty(at(rf, 10, 60)) && "rotation 90: the cell stands up");
            r.roam.bounds = RoamBounds::Clip;
            ReadbackBuffer rc = render({ r }, 2, 2);
            assert(isEmpty(at(rc, 80, 130)) && isRed(at(rc, 80, 60)) && "Clip scissors the rotated cell to home");
            std::fprintf(stderr, "[TEST:Compositor] 17e scale + rotation OK\n");
        }

        // 17f: half-grid placement (span 4 = half a column): offset 1.0 moves
        // ONE PLACEMENT, not one full column.
        {
            CellFrameRequest c = fullCell("red.mp4");
            c.spanX = kGridSubUnitsPerColumn / 2; c.spanY = kGridSubUnitsPerRow / 2;   // 80x60 px
            c.roam.offsetX = 1.0f;
            c.roam.bounds = RoamBounds::Float;
            ReadbackBuffer b = render({ c }, 2, 2);
            assert(isRed(at(b, 120, 30)) && isEmpty(at(b, 40, 30)) && isEmpty(at(b, 200, 30)));
            std::fprintf(stderr, "[TEST:Compositor] 17f half-grid offset OK\n");
        }

        // 17g: the fullscreen (Chorus) behind-layer. Its unit and home are the
        // canvas; Clip keeps it inside the canvas, and Lens frames it too.
        {
            CellFrameRequest ch = fullCell("blue.mp4");
            ch.layerKind = CellLayerKind::FullscreenBehind;
            ch.roam.offsetX = 0.5f;
            ReadbackBuffer b = render({ ch }, 2, 2);
            assert(isEmpty(at(b, 80, 120)) && isBlue(at(b, 240, 120)) && "chorus: half a canvas right");

            CellFrameRequest q = fullCell("quad.mp4");
            q.layerKind = CellLayerKind::FullscreenBehind;
            q.lens.centerX = 0.25f; q.lens.centerY = 0.25f; q.lens.zoom = 2.0f;
            ReadbackBuffer l = render({ q }, 2, 2);
            assert(isRed(at(l, 10, 10)) && isRed(at(l, 310, 230)) && "chorus: Lens zoom");
            std::fprintf(stderr, "[TEST:Compositor] 17g Chorus layer OK\n");
        }

        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 17: PASSED\n");
    }

    // ── Test 18: live preview == export, with the dev Lens/Roam hook on ──────
    // The preview and the export each have their own FrameCollector call (the
    // preview passes allowProxy, a resolved layout override and the preview
    // effect mute; the export passes its own flags) but must produce the SAME
    // picture: Lens/Roam is resolved by one snapshot builder and evaluated by
    // one compositor. A timeline with a full cell, a half-grid cell and a
    // fullscreen (Chorus) behind-layer; the hook (zoom 1.5, rotation 10 deg,
    // Roam offset (0.5,-0.3) Float, layer Top) on the full cell.
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 18: preview/export parity (dev hook) ---\n");

        Timeline tl{ 140.0, 48000.0 };
        SourceMedia src;
        src.filePath = "parity_src.mp4"; src.hasVideo = true;
        src.fps = 30.0; src.duration = 60.0; src.totalFrames = 1800;
        src.width = 1920; src.height = 1080;
        const int srcId = tl.addSource(src);
        SampleRegion reg;
        reg.sourceId = srcId; reg.startTime = 0.0; reg.endTime = 10.0;
        reg.startFrame = 0; reg.endFrame = 299;
        const int regId = tl.addRegion(reg);

        int trk[3];
        for (int i = 0; i < 3; ++i) {
            TrackInfo t;
            t.name = "T" + std::to_string(i);
            t.type = TrackInfo::Type::Clip;
            trk[i] = tl.addTrack(t);
            Clip c;
            c.trackId = trk[i]; c.regionId = regId;
            c.position = TickTime{ 0 }; c.duration = TickTime::fromBeats(4);
            c.lens = LensTrack{};             // old-project Stretch
            tl.addClip(c);
        }
        GridLayout layout;
        layout.columns = 2; layout.rows = 2;
        layout.slots.push_back({ trk[0], 0, 0, kGridSubUnitsPerColumn, kGridSubUnitsPerRow, 1.0f, 2 });
        layout.slots.push_back({ trk[1], kGridSubUnitsPerColumn, kGridSubUnitsPerRow,
                                 kGridSubUnitsPerColumn / 2, kGridSubUnitsPerRow / 2, 1.0f, 3 });
        FullscreenLayer chorus;
        chorus.trackId = trk[2]; chorus.placement = FullscreenLayerPlacement::BehindGrid;
        chorus.opacity = 1.0f; chorus.zOrder = 1;
        layout.fullscreenLayers.push_back(chorus);
        tl.setGridLayout(layout);

        const auto built = xleth::videoevents::build(tl, 140.0, 48000.0);
        assert(built.events.size() == 3);
        const AVRational fps{ 30, 1 };
        const int64_t frame = 15;

        // A 16:9 gradient for every frame either collector asks for.
        auto fill = [&](const std::vector<CellFrameRequest>& reqs) {
            for (const auto& r : reqs) {
                FrameCacheKey k; k.sourcePath = r.sourcePath; k.frameIndex = r.sourceFrameIndex;
                if (!cache.get(k)) cache.put(k, makeGradientTexture(64, 36));
            }
        };

        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 240));
        auto renderBoth = [&](std::vector<uint8_t>& preview, std::vector<uint8_t>& exportPx) {
            auto snap = buildLensRoamSnapshot(tl);

            FrameCollector live;                                     // XlethEngineService video tick
            live.setLensRoamSnapshot(snap);
            const GridLayout liveLayout = tl.gridLayoutAt(TickTime{ 0 });
            auto& lr = live.collectRequests(frame, tl, 48000, fps, built.events,
                                            /*allowProxy=*/true, /*projectStartSample=*/0,
                                            /*posterMode=*/false, /*renderProxyBySource=*/nullptr,
                                            /*layoutOverride=*/&liveLayout,
                                            /*applyPreviewEffectMute=*/true);
            assert(lr.size() == 3);
            fill(lr);
            compositor.compositeFrame(lr, cache, liveLayout.columns, liveLayout.rows, 0.0f, liveLayout.gapScale);
            ReadbackBuffer a = compositor.readback();
            assert(a.valid);
            preview = a.pixels;

            FrameCollector exp;                                      // OfflineRenderer
            exp.setLensRoamSnapshot(buildLensRoamSnapshot(tl));
            auto& er = exp.collectRequests(frame, tl, 48000, fps, built.events,
                                           /*allowProxy=*/false, /*projectStartSample=*/0,
                                           /*posterMode=*/false, /*renderProxyBySource=*/nullptr);
            assert(er.size() == 3);
            fill(er);
            const GridLayout& el = tl.getGridLayout();
            compositor.compositeFrame(er, cache, el.columns, el.rows, 0.0f, el.gapScale);
            ReadbackBuffer b = compositor.readback();
            assert(b.valid);
            exportPx = b.pixels;
            return std::make_pair(lr.back().trackId, er.back().trackId);
        };

        std::vector<uint8_t> offLive, offExport, onLive, onExport;
        renderBoth(offLive, offExport);
        assert(offLive == offExport && "identity: preview == export");

        _putenv_s("XLETH_DEV_LENS_ROAM_TRACK", std::to_string(trk[0]).c_str());
        _putenv_s("XLETH_DEV_LENS_ROAM_LAYER", "top");
        const auto lastDrawn = renderBoth(onLive, onExport);
        _putenv_s("XLETH_DEV_LENS_ROAM_TRACK", "");
        _putenv_s("XLETH_DEV_LENS_ROAM_LAYER", "");

        assert(lastDrawn.first == trk[0] && lastDrawn.second == trk[0] && "Float + Top draws the hooked track last");
        assert(onLive != offLive && "the hook changed the picture");
        assert(onLive == onExport && "dev hook: preview == export, byte for byte");

        // FNV-1a of each frame, for the report.
        auto fnv = [](const std::vector<uint8_t>& v) {
            uint64_t h = 1469598103934665603ull;
            for (uint8_t c : v) { h ^= c; h *= 1099511628211ull; }
            return static_cast<unsigned long long>(h);
        };
        std::fprintf(stderr, "[TEST:Compositor] hook off: preview %016llx export %016llx\n",
                     fnv(offLive), fnv(offExport));
        std::fprintf(stderr, "[TEST:Compositor] hook on : preview %016llx export %016llx\n",
                     fnv(onLive), fnv(onExport));

        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 18: PASSED\n");
    }

    // ── Test 19: P7 keys, live preview == export, pixel for pixel ────────────
    // Roam keys (timeline ticks) on both tracks, a hit curve (note anchors) on
    // the Pattern Track source, clip lens keys (event ticks). The preview
    // renders the LIVE timeline at 30 fps through its collector call; the
    // export renders a FROZEN copy (its own events and snapshot) at 60 fps
    // from a 1 s subrange start. Every 30 fps frame shares its project sample
    // with an export frame; each pair must composite to identical bytes, and a
    // fresh collector that SEEKS straight to a mid-note frame must too.
    {
        std::fprintf(stderr, "\n[TEST:Compositor] --- Test 19: P7 keys, preview/export parity ---\n");

        Timeline tl{ 140.0, 48000.0 };
        SourceMedia src;
        src.filePath = "p7_parity_src.mp4"; src.hasVideo = true;
        src.fps = 30.0; src.duration = 60.0; src.totalFrames = 1800;
        src.width = 1920; src.height = 1080;
        const int srcId = tl.addSource(src);
        SampleRegion reg;
        reg.sourceId = srcId; reg.startTime = 0.0; reg.endTime = 10.0;
        reg.startFrame = 0; reg.endFrame = 299;
        const int regId = tl.addRegion(reg);

        TrackInfo ct; ct.name = "Clips"; ct.type = TrackInfo::Type::Clip;
        const int clipTrack = tl.addTrack(ct);
        TrackInfo pt; pt.name = "Pattern"; pt.type = TrackInfo::Type::Pattern;
        const int patTrack = tl.addTrack(pt);

        auto lk = [](LensChannel ch, KeyAnchor a, double pos, double v,
                     xleth::keycurve::Interp i = xleth::keycurve::Interp::Linear) {
            LensKey k; k.channel = ch; k.anchor = a; k.pos = pos; k.value = v; k.interp = i; return k;
        };
        auto rk = [](RoamChannel ch, double pos, double v) {
            RoamKey k; k.channel = ch; k.pos = pos; k.value = v; return k;
        };

        Clip c;
        c.trackId = clipTrack; c.regionId = regId;
        c.position = TickTime{ 0 }; c.duration = TickTime::fromBeats(8);
        c.lens = LensTrack{};
        c.lens.keys = { lk(LensChannel::Zoom, KeyAnchor::Origin, 0, 1.0),
                        lk(LensChannel::Zoom, KeyAnchor::Origin, 7680, 2.0) };
        tl.addClip(c);

        Pattern pat;
        pat.name = "P"; pat.regionId = regId; pat.length = TickTime::fromBeats(8);
        const int patId = tl.addPattern(pat);
        const int64_t notePos[] = { 2400, 3600, 4800 };      // long, short (Squash), long
        const int64_t noteDur[] = { 960, 180, 1440 };
        for (int i = 0; i < 3; ++i) {
            PatternNote n;
            n.position = TickTime{ notePos[i] }; n.duration = TickTime{ noteDur[i] };
            tl.addNoteToPattern(patId, n);
        }
        PatternBlock blk;
        blk.trackId = patTrack; blk.patternId = patId;
        blk.position = TickTime{ 0 }; blk.duration = TickTime::fromBeats(8);
        tl.addPatternBlock(blk);

        TrackInfo* ptm = tl.getTrackMutable(patTrack);
        LensTrack hit;                                       // Stretch base + Punch + drift
        hit.keys = { lk(LensChannel::Zoom, KeyAnchor::Head, 0, 1.35, xleth::keycurve::Interp::EaseOut),
                     lk(LensChannel::Zoom, KeyAnchor::Head, 120, 1.08),
                     lk(LensChannel::Zoom, KeyAnchor::Tail, 240, 1.20),
                     lk(LensChannel::Zoom, KeyAnchor::Tail, 0, 1.00),
                     lk(LensChannel::RotationDeg, KeyAnchor::Body, 0.0, 0.0),
                     lk(LensChannel::RotationDeg, KeyAnchor::Body, 1.0, 8.0) };
        ptm->trackLens[regId] = hit;
        ptm->roam.keys = { rk(RoamChannel::OffsetX, 0, -0.25), rk(RoamChannel::OffsetX, 7680, 0.25),
                           rk(RoamChannel::Scale, 0, 0.8),     rk(RoamChannel::Scale, 7680, 1.1) };
        tl.getTrackMutable(clipTrack)->roam.keys = { rk(RoamChannel::RotationDeg, 0, 0.0),
                                                     rk(RoamChannel::RotationDeg, 7680, 20.0) };

        GridLayout layout;
        layout.columns = 2; layout.rows = 1;
        layout.slots.push_back({ clipTrack, 0, 0, kGridSubUnitsPerColumn, kGridSubUnitsPerRow, 1.0f, 0 });
        layout.slots.push_back({ patTrack, kGridSubUnitsPerColumn, 0,
                                 kGridSubUnitsPerColumn, kGridSubUnitsPerRow, 1.0f, 1 });
        tl.setGridLayout(layout);

        const auto liveEvents = xleth::videoevents::build(tl, 140.0, 48000.0);
        const auto liveSnap   = buildLensRoamSnapshot(tl);
        const FrozenTimelineCopy frozen = makeFrozenTimelineCopy(tl);
        const Timeline& ex = *frozen.timeline;
        const auto exEvents = xleth::videoevents::build(ex, 140.0, 48000.0);
        const auto exSnap   = buildLensRoamSnapshot(ex);
        const std::unordered_map<int, std::string> plan;   // export: originals

        auto fill = [&](const std::vector<CellFrameRequest>& reqs) {
            for (const auto& r : reqs) {
                FrameCacheKey k; k.sourcePath = r.sourcePath; k.frameIndex = r.sourceFrameIndex;
                if (!cache.get(k)) cache.put(k, makeGradientTexture(64, 36));
            }
        };
        GridCompositor compositor;
        assert(compositor.init(g_device, g_deviceCtx, 320, 160));
        const GridLayout liveLayout = tl.gridLayoutAt(TickTime{ 0 });
        auto composite = [&](const std::vector<CellFrameRequest>& reqs, const GridLayout& l) {
            fill(reqs);
            compositor.compositeFrame(reqs, cache, l.columns, l.rows, 0.0f, l.gapScale);
            ReadbackBuffer b = compositor.readback();
            assert(b.valid);
            return b.pixels;
        };

        FrameCollector preview, exporter;
        preview.setLensRoamSnapshot(liveSnap);
        exporter.setLensRoamSnapshot(exSnap);
        const AVRational previewFps{ 30, 1 }, exportFps{ 60, 1 };
        const int64_t exportStart = 48000;                   // 1 s subrange
        int frames = 0, differing = 0, withHit = 0;
        std::vector<uint8_t> prevPx;
        for (int64_t p = 30; p <= 110; ++p) {                // beats 2.33 .. 8.0
            const std::vector<CellFrameRequest> lr = preview.collectRequests(
                p, tl, 48000, previewFps, liveEvents.events,
                /*allowProxy=*/true, /*projectStartSample=*/0, /*posterMode=*/false,
                /*renderProxyBySource=*/nullptr, &liveLayout, /*applyPreviewEffectMute=*/true);
            const std::vector<uint8_t> a = composite(lr, liveLayout);

            const std::vector<CellFrameRequest> er = exporter.collectRequests(
                2 * (p - 30), ex, 48000, exportFps, exEvents.events,
                /*allowProxy=*/false, exportStart, /*posterMode=*/false, &plan);
            const std::vector<uint8_t> b = composite(er, ex.getGridLayout());

            assert(a == b && "P7: preview == export, byte for byte, at every shared sample");
            if (!prevPx.empty() && a != prevPx) ++differing;
            for (const auto& r : lr) if (r.trackId == patTrack) ++withHit;
            prevPx = a;
            ++frames;
        }
        assert(withHit >= 20 && "the pattern cell was on screen across the notes");
        assert(differing >= 60 && "the keys visibly moved the picture between frames");

        // Seek: a fresh collector jumps straight to the first preview frame
        // inside the last note's head (note-on 4800, head 120 ticks).
        int64_t seekFrame = -1;
        for (int64_t p = 30; p <= 110 && seekFrame < 0; ++p) {
            const int64_t tick = RenderClock::sampleToPPQ(p * 1600, 48000, 140.0);
            if (tick > 4800 + 20 && tick < 4800 + 120) seekFrame = p;
        }
        assert(seekFrame >= 0);
        FrameCollector seeker;
        seeker.setLensRoamSnapshot(liveSnap);
        const std::vector<CellFrameRequest> sr = seeker.collectRequests(
            seekFrame, tl, 48000, previewFps, liveEvents.events,
            true, 0, false, nullptr, &liveLayout, true);
        const std::vector<uint8_t> seekPx = composite(sr, liveLayout);
        FrameCollector exportSeek;
        exportSeek.setLensRoamSnapshot(exSnap);
        const std::vector<CellFrameRequest> esr = exportSeek.collectRequests(
            2 * (seekFrame - 30), ex, 48000, exportFps, exEvents.events,
            false, exportStart, false, &plan);
        assert(seekPx == composite(esr, ex.getGridLayout()) && "seek mid-note: preview == export");
        float seekZoom = 0.0f;
        for (const auto& r : sr) if (r.trackId == patTrack) seekZoom = r.lens.zoom;
        assert(seekZoom > 1.08f && seekZoom < 1.35f && "the seek lands mid-punch");

        auto fnv = [](const std::vector<uint8_t>& v) {
            uint64_t h = 1469598103934665603ull;
            for (uint8_t ch : v) { h ^= ch; h *= 1099511628211ull; }
            return static_cast<unsigned long long>(h);
        };
        std::fprintf(stderr, "[TEST:Compositor] 19: %d frame pairs identical, %d pattern cells, "
                     "picture changed on %d frames; seek frame %lld zoom %.4f, hash %016llx\n",
                     frames, withHit, differing, (long long)seekFrame, seekZoom, fnv(seekPx));
        compositor.shutdown();
        std::fprintf(stderr, "[TEST:Compositor] Test 19: PASSED\n");
    }

    std::fprintf(stderr, "\n[TEST:Compositor] ALL TESTS PASSED\n");
    std::_Exit(0);
}
