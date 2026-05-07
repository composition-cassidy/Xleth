// test_compositor.cpp — Verifies GridCompositor with real D3D11 GPU rendering.
// Creates solid-color textures, composites them, reads back pixels to verify
// compositing order and alpha blending.

#include "render/GridCompositor.h"
#include "render/GpuDeviceManager.h"
#include "render/FrameCache.h"
#include "render/FrameCollector.h"
#include "model/TimelineTypes.h"  // kGridSubUnitsPerColumn / Row

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

    std::fprintf(stderr, "\n[TEST:Compositor] ALL TESTS PASSED\n");
    std::_Exit(0);
}
