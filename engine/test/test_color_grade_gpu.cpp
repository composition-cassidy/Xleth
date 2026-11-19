// test_color_grade_gpu.cpp — Color Grade on a real D3D11 device.
//
// Draws through GridCompositor exactly as the preview and the export do, reads
// the frame back, and compares pixels. The CPU reference is
// xleth::grade::applyBakedGrade: the shader has to produce the same picture,
// to within one 8-bit step.
//
// Spec acceptance criteria proven here:
//   A1  neutral = bit-identical output, no pass run
//   A3  Source -> Clip -> Layer -> Master order
//   A5  Master covers the whole frame, empty areas included
//   A6  two compositors (preview / export) produce the same bytes
//   A7  bypass restores the exact prior picture
//   A10 a steep curve on a smooth gradient never reverses
//
// Output prefix: [TEST:ColorGradeGPU].

#include "render/GridCompositor.h"
#include "render/GpuDeviceManager.h"
#include "render/FrameCache.h"
#include "render/FrameCollector.h"
#include "model/ColorGrade.h"
#include "model/TimelineTypes.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

using namespace xleth::grade;

static ID3D11Device*        g_device    = nullptr;
static ID3D11DeviceContext* g_deviceCtx = nullptr;
static int g_fail = 0;
static int g_pass = 0;

#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (cond) { ++g_pass; }                                                \
        else {                                                                 \
            ++g_fail;                                                          \
            std::fprintf(stderr, "    FAIL: %s  (%s)  line %d\n", (msg), #cond, __LINE__); \
        }                                                                      \
    } while (0)

static const int kW = 256;
static const int kH = 64;

// BGRA pixels -> a texture the frame cache can serve.
static FrameCacheEntry makeTexture(const std::vector<uint8_t>& bgra, int w, int h)
{
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width            = static_cast<UINT>(w);
    desc.Height           = static_cast<UINT>(h);
    desc.MipLevels        = 1;
    desc.ArraySize        = 1;
    desc.Format           = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage            = D3D11_USAGE_DEFAULT;
    desc.BindFlags        = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA init = {};
    init.pSysMem     = bgra.data();
    init.SysMemPitch = static_cast<UINT>(w * 4);

    FrameCacheEntry entry;
    if (FAILED(g_device->CreateTexture2D(&desc, &init, &entry.texture))
        || FAILED(g_device->CreateShaderResourceView(entry.texture.Get(), nullptr, &entry.srv))) {
        std::fprintf(stderr, "[TEST:ColorGradeGPU] texture creation failed\n");
        std::exit(1);
    }
    entry.width           = w;
    entry.height          = h;
    entry.memorySizeBytes = static_cast<size_t>(w) * h * 4;
    return entry;
}

// A picture that exercises every channel independently: x is a 0..255 ramp,
// and each band of rows mixes the channels differently (grey, red-led,
// green-led, blue-led, saturated).
static std::vector<uint8_t> makeRamp(int w, int h, uint8_t alpha = 255)
{
    std::vector<uint8_t> px(static_cast<size_t>(w) * h * 4);
    for (int y = 0; y < h; ++y) {
        const int band = (y * 5) / h;
        for (int x = 0; x < w; ++x) {
            const int v = (x * 255) / (w - 1);
            int r = v, g = v, b = v;
            switch (band) {
                case 1: g = v / 2;        b = v / 3;        break;
                case 2: r = v / 3;        b = v / 2;        break;
                case 3: r = v / 2;        g = v / 3;        break;
                case 4: r = v; g = 255 - v; b = (v * 3) % 256; break;
                default: break;
            }
            const size_t i = (static_cast<size_t>(y) * w + x) * 4;
            px[i + 0] = static_cast<uint8_t>(b);
            px[i + 1] = static_cast<uint8_t>(g);
            px[i + 2] = static_cast<uint8_t>(r);
            px[i + 3] = alpha;
        }
    }
    return px;
}

static std::vector<uint8_t> makeSolid(int w, int h, uint8_t r, uint8_t g, uint8_t b, uint8_t a)
{
    std::vector<uint8_t> px(static_cast<size_t>(w) * h * 4);
    for (size_t i = 0; i < px.size(); i += 4) { px[i] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = a; }
    return px;
}

static CellFrameRequest fullscreen(const char* path)
{
    CellFrameRequest r{};
    r.sourcePath = path;
    r.sourceFrameIndex = 0;
    r.opacity = 1.0f;
    r.layerKind = CellLayerKind::FullscreenBehind;
    r.zOrder = 0;
    return r;
}

static std::vector<uint8_t> render(GridCompositor& c, const std::vector<CellFrameRequest>& reqs,
                                   RenderFrameCache& cache, int cols = 1, int rows = 1)
{
    c.compositeFrame(reqs, cache, cols, rows);
    const ReadbackBuffer& buf = c.readback();
    if (!buf.valid) {
        std::fprintf(stderr, "[TEST:ColorGradeGPU] readback failed\n");
        std::exit(1);
    }
    return buf.pixels;
}

// Worst per-channel difference (8-bit steps) between a rendered BGRA frame and
// the CPU reference applied to the source picture.
static int worstDiff(const std::vector<uint8_t>& rendered, const std::vector<uint8_t>& source,
                     const std::vector<const BakedGrade*>& chain)
{
    int worst = 0;
    for (size_t i = 0; i + 3 < rendered.size(); i += 4) {
        float c[3] = { source[i + 2] / 255.0f, source[i + 1] / 255.0f, source[i] / 255.0f };
        for (const BakedGrade* g : chain) applyBakedGrade(*g, c);
        const int want[3] = { static_cast<int>(std::lround(c[2] * 255.0f)),
                              static_cast<int>(std::lround(c[1] * 255.0f)),
                              static_cast<int>(std::lround(c[0] * 255.0f)) };
        for (int k = 0; k < 3; ++k)
            worst = std::max(worst, std::abs(static_cast<int>(rendered[i + k]) - want[k]));
    }
    return worst;
}

static ColorGrade richGrade()
{
    ColorGrade g;
    g.exposure = 0.4f;
    g.contrast = 0.25f;
    g.saturation = -0.2f;
    g.vibrance = 0.3f;
    g.temperature = 0.3f;
    g.tint = -0.15f;
    g.hue = 20.0f;
    g.lift  = Wheel{ 0.2f, -0.1f, -0.2f };
    g.gamma = Wheel{ -0.1f, 0.15f, 0.15f };
    g.gain  = Wheel{ 0.1f, 0.2f, 0.1f };
    g.curveMaster.points = { {0.0f, 0.0f}, {0.3f, 0.22f}, {0.7f, 0.8f}, {1.0f, 1.0f} };
    g.curveB.points = { {0.0f, 0.04f}, {0.5f, 0.55f}, {1.0f, 0.97f} };
    return g;
}

int main()
{
    std::fprintf(stderr, "\n[TEST:ColorGradeGPU] Starting...\n");

    GpuDeviceManager gpu;
    if (!gpu.detectAdapters() || !gpu.createDevice()) {
        std::fprintf(stderr, "[TEST:ColorGradeGPU] SKIP: no D3D11 device\n");
        return 0;
    }
    g_device    = gpu.getDevice();
    g_deviceCtx = gpu.getContext();

    const std::vector<uint8_t> ramp = makeRamp(kW, kH);
    RenderFrameCache cache;
    cache.setMemoryLimit(100 * 1024 * 1024);
    cache.put({"ramp.mp4", 0},   makeTexture(ramp, kW, kH));
    cache.put({"ramp.mp4", 1},   makeTexture(makeRamp(kW, kH), kW, kH));   // ping-pong secondary
    cache.put({"red.mp4", 0},    makeTexture(makeSolid(64, 64, 255, 0, 0, 255), 64, 64));
    cache.put({"half.mp4", 0},   makeTexture(makeRamp(kW, kH, 128), kW, kH));
    cache.put({"clear.mp4", 0},  makeTexture(makeSolid(64, 64, 200, 100, 50, 0), 64, 64));

    // ── 1. Neutral: no grade, no pass, the same bytes ───────────────────────
    std::vector<uint8_t> baseline;
    {
        std::fprintf(stderr, "[TEST:ColorGradeGPU] 1: neutral is bit-identical (A1)\n");
        GridCompositor c;
        CHECK(c.init(g_device, g_deviceCtx, kW, kH), "compositor init");
        baseline = render(c, { fullscreen("ramp.mp4") }, cache);
        CHECK(c.lastGradePassCount() == 0, "no grade -> no grade pass");
        CHECK(!c.hasMasterGrade(), "no master grade by default");
        // The source reaches the output untouched (1:1, opaque).
        bool same = baseline.size() == ramp.size();
        for (size_t i = 0; same && i < ramp.size(); i += 4)
            same = baseline[i] == ramp[i] && baseline[i + 1] == ramp[i + 1] && baseline[i + 2] == ramp[i + 2];
        CHECK(same, "ungraded frame is the source, pixel for pixel");

        // Neutral grades at every level bake to nothing, so a request built
        // from them is the same request.
        CellFrameRequest r = fullscreen("ramp.mp4");
        r.gradeSource = bakeColorGrade(ColorGrade{}, nullptr);
        r.gradeClip   = bakeColorGrade(ColorGrade{}, nullptr);
        r.gradeLayer  = bakeColorGrade(ColorGrade{}, nullptr);
        c.setMasterGrade(bakeColorGrade(ColorGrade{}, nullptr));
        const std::vector<uint8_t> neutral = render(c, { r }, cache);
        CHECK(neutral == baseline, "neutral at all four levels: output identical, pixel for pixel");
        CHECK(c.lastGradePassCount() == 0, "neutral at all levels still runs no pass");
        c.shutdown();
    }

    // ── 2. The shader is the CPU reference ──────────────────────────────────
    const ColorGrade rich = richGrade();
    const auto bakedRich = bakeColorGrade(rich, nullptr);
    {
        std::fprintf(stderr, "[TEST:ColorGradeGPU] 2: shader matches the CPU reference\n");
        GridCompositor c;
        CHECK(c.init(g_device, g_deviceCtx, kW, kH), "compositor init");
        CHECK(bakedRich != nullptr, "the grade bakes");

        CellFrameRequest r = fullscreen("ramp.mp4");
        r.gradeSource = bakedRich;
        const std::vector<uint8_t> out = render(c, { r }, cache);
        CHECK(c.lastGradePassCount() == 1, "one cell with a grade -> one pass");
        const int d = worstDiff(out, ramp, { bakedRich.get() });
        std::fprintf(stderr, "    worst difference vs CPU: %d / 255\n", d);
        CHECK(d <= 1, "every pixel within one 8-bit step of the CPU reference");
        CHECK(out != baseline, "and it is not the ungraded picture");

        // Each kind of step on its own.
        struct Case { const char* name; ColorGrade g; };
        std::vector<Case> cases;
        { ColorGrade g; g.exposure = -1.0f; cases.push_back({ "exposure", g }); }
        { ColorGrade g; g.contrast = 0.8f; cases.push_back({ "contrast", g }); }
        { ColorGrade g; g.saturation = 1.0f; cases.push_back({ "saturation", g }); }
        { ColorGrade g; g.saturation = -1.0f; cases.push_back({ "greyscale", g }); }
        { ColorGrade g; g.vibrance = 1.0f; cases.push_back({ "vibrance", g }); }
        { ColorGrade g; g.hue = 90.0f; cases.push_back({ "hue", g }); }
        { ColorGrade g; g.temperature = -0.8f; g.tint = 0.5f; cases.push_back({ "white balance", g }); }
        { ColorGrade g; g.lift = Wheel{ -0.5f, 0.5f, 0.3f }; cases.push_back({ "lift", g }); }
        { ColorGrade g; g.gamma = Wheel{ 0.4f, 0.4f, -0.5f }; cases.push_back({ "gamma", g }); }
        { ColorGrade g; g.gain = Wheel{ 0.6f, -0.3f, -0.4f }; cases.push_back({ "gain", g }); }
        { ColorGrade g; g.curveG.points = { {0.0f, 0.2f}, {0.4f, 0.3f}, {1.0f, 0.8f} }; cases.push_back({ "curve", g }); }
        for (const auto& k : cases) {
            const auto b = bakeColorGrade(k.g, nullptr);
            CellFrameRequest q = fullscreen("ramp.mp4");
            q.gradeLayer = b;
            const std::vector<uint8_t> o = render(c, { q }, cache);
            const int dd = b ? worstDiff(o, ramp, { b.get() }) : 255;
            if (dd > 1) std::fprintf(stderr, "    %s: worst %d\n", k.name, dd);
            CHECK(dd <= 1, k.name);
        }
        c.shutdown();
    }

    // ── 3. Order of the per-cell levels ─────────────────────────────────────
    ColorGrade crush;
    crush.curveMaster.points = { {0.0f, 0.0f}, {0.5f, 0.18f}, {1.0f, 1.0f} };
    ColorGrade wash;
    wash.saturation = -0.6f;
    wash.lift.lum = 0.6f;
    ColorGrade warm;
    warm.temperature = 0.7f;
    warm.gain.lum = -0.3f;
    const auto bCrush = bakeColorGrade(crush, nullptr);
    const auto bWash  = bakeColorGrade(wash, nullptr);
    const auto bWarm  = bakeColorGrade(warm, nullptr);
    {
        std::fprintf(stderr, "[TEST:ColorGradeGPU] 3: Source -> Clip -> Layer, in that order (A3)\n");
        GridCompositor c;
        CHECK(c.init(g_device, g_deviceCtx, kW, kH), "compositor init");

        CellFrameRequest r = fullscreen("ramp.mp4");
        r.gradeSource = bCrush;
        r.gradeClip   = bWash;
        r.gradeLayer  = bWarm;
        const std::vector<uint8_t> ordered = render(c, { r }, cache);
        CHECK(c.lastGradePassCount() == 1, "three levels cost one pass");
        const int d = worstDiff(ordered, ramp, { bCrush.get(), bWash.get(), bWarm.get() });
        std::fprintf(stderr, "    three levels, worst difference vs CPU chain: %d / 255\n", d);
        CHECK(d <= 1, "three levels match the CPU chain applied in order");

        // Swap any two: a different picture, and the one the swapped order predicts.
        CellFrameRequest s = fullscreen("ramp.mp4");
        s.gradeSource = bWash;
        s.gradeClip   = bCrush;
        s.gradeLayer  = bWarm;
        const std::vector<uint8_t> swapped = render(c, { s }, cache);
        CHECK(swapped != ordered, "swapping Source and Clip changes the picture");
        CHECK(worstDiff(swapped, ramp, { bWash.get(), bCrush.get(), bWarm.get() }) <= 1,
              "and the swapped picture is the swapped order's");
        CellFrameRequest t = fullscreen("ramp.mp4");
        t.gradeSource = bCrush;
        t.gradeClip   = bWarm;
        t.gradeLayer  = bWash;
        CHECK(render(c, { t }, cache) != ordered, "swapping Clip and Layer changes the picture");

        // Two levels (a missing middle level leaves no gap in the chain).
        CellFrameRequest u = fullscreen("ramp.mp4");
        u.gradeSource = bCrush;
        u.gradeLayer  = bWarm;
        CHECK(worstDiff(render(c, { u }, cache), ramp, { bCrush.get(), bWarm.get() }) <= 1,
              "Source + Layer with no Clip grade");
        c.shutdown();
    }

    // ── 4. Master: after everything, over the whole frame ───────────────────
    {
        std::fprintf(stderr, "[TEST:ColorGradeGPU] 4: Master grades the whole frame (A3, A5)\n");
        GridCompositor c;
        CHECK(c.init(g_device, g_deviceCtx, kW, kH), "compositor init");

        // Master after the per-cell levels.
        CellFrameRequest r = fullscreen("ramp.mp4");
        r.gradeSource = bCrush;
        c.setMasterGrade(bWash);
        const std::vector<uint8_t> both = render(c, { r }, cache);
        CHECK(worstDiff(both, ramp, { bCrush.get(), bWash.get() }) <= 2,
              "Master is applied to the result of the per-cell levels");
        CellFrameRequest r2 = fullscreen("ramp.mp4");
        r2.gradeSource = bWash;
        c.setMasterGrade(bCrush);
        CHECK(render(c, { r2 }, cache) != both, "swapping Source and Master changes the picture");

        // Empty areas: one red cell in a 2x2 grid, the rest of the frame empty.
        CellFrameRequest cell{};
        cell.cellCol = 0; cell.cellRow = 0;
        cell.spanX = kGridSubUnitsPerColumn; cell.spanY = kGridSubUnitsPerRow;
        cell.sourcePath = "red.mp4"; cell.sourceFrameIndex = 0;
        cell.opacity = 1.0f; cell.layerKind = CellLayerKind::Grid; cell.zOrder = 0;

        c.setMasterGrade(nullptr);
        const std::vector<uint8_t> plain = render(c, { cell }, cache, 2, 2);
        const size_t emptyPx = (static_cast<size_t>(kH - 8) * kW + (kW - 8)) * 4;   // bottom-right
        const size_t cellPx  = (static_cast<size_t>(8) * kW + 8) * 4;               // top-left
        CHECK(plain[emptyPx] == 0 && plain[emptyPx + 1] == 0 && plain[emptyPx + 2] == 0,
              "without a master grade an empty area is black");

        ColorGrade lifted;
        lifted.lift.lum = 0.6f;      // lifts black to a visible grey
        const auto bLift = bakeColorGrade(lifted, nullptr);
        c.setMasterGrade(bLift);
        const std::vector<uint8_t> graded = render(c, { cell }, cache, 2, 2);
        float black[3] = { 0.0f, 0.0f, 0.0f };
        applyBakedGrade(*bLift, black);
        const int wantGrey = static_cast<int>(std::lround(black[0] * 255.0f));
        std::fprintf(stderr, "    empty area under a lifting master grade: %d %d %d (expect %d), alpha %d\n",
                     graded[emptyPx + 2], graded[emptyPx + 1], graded[emptyPx], wantGrey, graded[emptyPx + 3]);
        CHECK(wantGrey > 20, "the test grade really lifts black");
        CHECK(std::abs(graded[emptyPx] - wantGrey) <= 1 && std::abs(graded[emptyPx + 1] - wantGrey) <= 1
              && std::abs(graded[emptyPx + 2] - wantGrey) <= 1,
              "the Master grade reaches the empty area of the frame");
        CHECK(graded[emptyPx + 3] == 255 && graded[cellPx + 3] == 255, "a master-graded frame is opaque everywhere");
        CHECK(graded[cellPx + 2] > plain[cellPx + 2] - 2 && graded[cellPx + 1] > plain[cellPx + 1],
              "and the cell is graded too");

        // Reading the same picture back twice must not grade it twice (the
        // export does this for a held tail frame).
        const ReadbackBuffer& again = c.readback();
        CHECK(again.valid && again.pixels == graded, "a second readback returns the same graded frame");

        // Removing the master grade restores the exact prior frame.
        c.setMasterGrade(nullptr);
        CHECK(render(c, { cell }, cache, 2, 2) == plain, "master bypass restores the prior picture exactly (A7)");

        // Survives a resize (shutdown + init), as the preview does on a
        // resolution change.
        c.setMasterGrade(bLift);
        c.shutdown();
        CHECK(c.init(g_device, g_deviceCtx, kW, kH), "re-init after a resize");
        CHECK(c.hasMasterGrade(), "the master grade is a setting: a resize keeps it");
        CHECK(render(c, { cell }, cache, 2, 2) == graded, "and it renders the same after the resize");
        c.shutdown();
    }

    // ── 5. Bypass restores the exact picture ────────────────────────────────
    {
        std::fprintf(stderr, "[TEST:ColorGradeGPU] 5: bypass at any level restores the prior look (A7)\n");
        GridCompositor c;
        CHECK(c.init(g_device, g_deviceCtx, kW, kH), "compositor init");
        CellFrameRequest r = fullscreen("ramp.mp4");
        r.gradeSource = bCrush; r.gradeClip = bWash; r.gradeLayer = bWarm;
        const std::vector<uint8_t> all = render(c, { r }, cache);

        CellFrameRequest noClip = r;
        noClip.gradeClip = nullptr;          // what a bypassed Clip grade resolves to
        const std::vector<uint8_t> withoutClip = render(c, { noClip }, cache);
        CHECK(withoutClip != all, "bypassing one level changes the picture");
        CHECK(render(c, { r }, cache) == all, "un-bypassing brings back the exact graded picture");

        CellFrameRequest none = fullscreen("ramp.mp4");
        CHECK(render(c, { none }, cache) == baseline, "bypassing every level is the original picture, exactly");
        c.shutdown();
    }

    // ── 6. Preview and export agree ─────────────────────────────────────────
    {
        std::fprintf(stderr, "[TEST:ColorGradeGPU] 6: two compositors produce the same bytes (A6)\n");
        GridCompositor preview, exporter;
        CHECK(preview.init(g_device, g_deviceCtx, kW, kH) && exporter.init(g_device, g_deviceCtx, kW, kH),
              "two compositors");
        CellFrameRequest r = fullscreen("ramp.mp4");
        r.gradeSource = bakedRich; r.gradeClip = bWash; r.gradeLayer = bWarm;
        preview.setMasterGrade(bCrush);
        exporter.setMasterGrade(bCrush);

        preview.compositeFrame({ r }, cache, 1, 1);
        const std::vector<uint8_t> p = preview.readback(ReadbackMode::PreviewRing).pixels;
        // The export reads straight into the encoder's buffer.
        std::vector<uint8_t> dst(static_cast<size_t>(kW) * kH * 4);
        exporter.compositeFrame({ r }, cache, 1, 1);
        const ReadbackBuffer& e = exporter.readback(ReadbackMode::Immediate, dst.data(), dst.size());
        CHECK(e.valid && e.intoDestination, "export readback into its own buffer");
        CHECK(p == dst, "preview frame == export frame, byte for byte, with all four levels");

        // Straight after a grade change (a drag release): still the same.
        ColorGrade next = richGrade();
        next.exposure = -0.3f;
        const auto bNext = bakeColorGrade(next, nullptr);
        r.gradeSource = bNext;
        preview.compositeFrame({ r }, cache, 1, 1);
        const std::vector<uint8_t> p2 = preview.readback(ReadbackMode::PreviewRing).pixels;
        exporter.compositeFrame({ r }, cache, 1, 1);
        exporter.readback(ReadbackMode::Immediate, dst.data(), dst.size());
        CHECK(p2 == dst && p2 != p, "and again after the grade changes");
        preview.shutdown();
        exporter.shutdown();
    }

    // ── 7. Curves on the GPU never reverse ──────────────────────────────────
    {
        std::fprintf(stderr, "[TEST:ColorGradeGPU] 7: a steep curve on a gradient never reverses (A10)\n");
        GridCompositor c;
        CHECK(c.init(g_device, g_deviceCtx, kW, kH), "compositor init");
        ColorGrade steep;
        steep.curveMaster.points = { {0.0f, 0.0f}, {0.47f, 0.03f}, {0.53f, 0.97f}, {1.0f, 1.0f} };
        CellFrameRequest r = fullscreen("ramp.mp4");
        r.gradeSource = bakeColorGrade(steep, nullptr);
        const std::vector<uint8_t> out = render(c, { r }, cache);
        bool monotone = true;
        const int y = 2;   // the grey band
        for (int x = 1; x < kW; ++x) {
            const size_t a = (static_cast<size_t>(y) * kW + x - 1) * 4, b = (static_cast<size_t>(y) * kW + x) * 4;
            for (int k = 0; k < 3; ++k) if (out[b + k] < out[a + k]) monotone = false;
        }
        CHECK(monotone, "left to right, the graded gradient never steps down");
        const size_t first = (static_cast<size_t>(y) * kW) * 4, last = (static_cast<size_t>(y) * kW + kW - 1) * 4;
        CHECK(out[first] == 0 && out[last] == 255, "and it still runs from black to white");

        // Per-channel curves stay per-channel on the GPU.
        ColorGrade redOnly;
        redOnly.curveR.points = { {0.0f, 0.0f}, {0.5f, 0.9f}, {1.0f, 1.0f} };
        CellFrameRequest q = fullscreen("ramp.mp4");
        q.gradeSource = bakeColorGrade(redOnly, nullptr);
        const std::vector<uint8_t> ro = render(c, { q }, cache);
        const size_t mid = (static_cast<size_t>(y) * kW + kW / 2) * 4;
        CHECK(ro[mid + 2] > baseline[mid + 2] + 60 && ro[mid + 1] == baseline[mid + 1] && ro[mid] == baseline[mid],
              "the red curve moves red and leaves green and blue exactly alone");
        c.shutdown();
    }

    // ── 8. Imported 3D LUT ──────────────────────────────────────────────────
    {
        std::fprintf(stderr, "[TEST:ColorGradeGPU] 8: imported LUT\n");
        std::string cube = "LUT_3D_SIZE 2\n";
        for (int b = 0; b < 2; ++b) for (int g = 0; g < 2; ++g) for (int r = 0; r < 2; ++r)
            cube += std::to_string(b) + " " + std::to_string(g) + " " + std::to_string(r) + "\n";   // swap R and B
        std::string err;
        const auto lut = parseCubeLut(cube, err);
        CHECK(lut != nullptr, "the LUT parses");
        auto baked = std::make_shared<BakedGrade>();
        baked->serial = 0xC0FFEEull;
        baked->lut3d = lut;
        baked->lutAmount = 1.0f;

        GridCompositor c;
        CHECK(c.init(g_device, g_deviceCtx, kW, kH), "compositor init");
        CellFrameRequest r = fullscreen("ramp.mp4");
        r.gradeSource = baked;
        const std::vector<uint8_t> out = render(c, { r }, cache);
        const int d = worstDiff(out, ramp, { baked.get() });
        std::fprintf(stderr, "    LUT, worst difference vs CPU: %d / 255\n", d);
        CHECK(d <= 1, "the 3D LUT matches the CPU trilinear lookup");
        bool swapped = true;
        for (size_t i = 0; i < out.size(); i += 4)
            if (std::abs(out[i] - ramp[i + 2]) > 1 || std::abs(out[i + 2] - ramp[i]) > 1) swapped = false;
        CHECK(swapped, "red and blue are swapped across the whole picture (axis order)");

        auto half = std::make_shared<BakedGrade>(*baked);
        half->serial = 0xC0FFEFull;
        half->lutAmount = 0.5f;
        r.gradeSource = half;
        CHECK(worstDiff(render(c, { r }, cache), ramp, { half.get() }) <= 1, "the LUT amount blends");
        c.shutdown();
    }

    // ── 9. Alpha is carried through ─────────────────────────────────────────
    {
        std::fprintf(stderr, "[TEST:ColorGradeGPU] 9: alpha is untouched\n");
        GridCompositor c;
        CHECK(c.init(g_device, g_deviceCtx, kW, kH), "compositor init");
        CellFrameRequest r = fullscreen("half.mp4");
        const std::vector<uint8_t> plain = render(c, { r }, cache);
        r.gradeSource = bWash;
        const std::vector<uint8_t> graded = render(c, { r }, cache);
        bool alphaSame = plain.size() == graded.size();
        for (size_t i = 3; alphaSame && i < plain.size(); i += 4) alphaSame = plain[i] == graded[i];
        CHECK(alphaSame, "a half-transparent picture keeps its alpha under a grade");
        CHECK(plain != graded, "and its colour is graded");

        // A fully transparent source draws nothing, grade or no grade (the
        // lift in this grade must not make the invisible visible).
        CellFrameRequest t = fullscreen("clear.mp4");
        const std::vector<uint8_t> clearPlain = render(c, { t }, cache);
        t.gradeSource = bWash;
        CHECK(render(c, { t }, cache) == clearPlain, "a transparent picture stays invisible under a lifting grade");
        c.shutdown();
    }

    // ── 10. Ping-pong crossfade: the secondary frame is graded too ──────────
    {
        std::fprintf(stderr, "[TEST:ColorGradeGPU] 10: both frames of a crossfade are graded\n");
        GridCompositor c;
        CHECK(c.init(g_device, g_deviceCtx, kW, kH), "compositor init");
        CellFrameRequest r = fullscreen("ramp.mp4");
        r.gradeSource = bCrush;
        const std::vector<uint8_t> single = render(c, { r }, cache);
        // Frame 1 is the same picture as frame 0, so a 50/50 blend of two
        // GRADED frames is the graded frame; an ungraded secondary would pull
        // every pixel halfway back to the source.
        r.pingPongSecondaryFrame = 1;
        r.pingPongBlendFactor    = 0.5f;
        const std::vector<uint8_t> blended = render(c, { r }, cache);
        CHECK(c.lastGradePassCount() == 2, "primary and secondary are each graded");
        int worst = 0;
        for (size_t i = 0; i < single.size(); ++i)
            worst = std::max(worst, std::abs(static_cast<int>(single[i]) - static_cast<int>(blended[i])));
        std::fprintf(stderr, "    crossfade of two graded frames vs one: worst %d / 255\n", worst);
        CHECK(worst <= 1, "the crossfade does not blend an ungraded frame in");
        c.shutdown();
    }

    // ── 11. Texture cache: one upload per grade, then eviction ──────────────
    {
        std::fprintf(stderr, "[TEST:ColorGradeGPU] 11: grade textures are reused, then evicted\n");
        GridCompositor c;
        CHECK(c.init(g_device, g_deviceCtx, kW, kH), "compositor init");
        CellFrameRequest r = fullscreen("ramp.mp4");
        r.gradeSource = bCrush;
        r.gradeLayer  = bWarm;
        for (int i = 0; i < 5; ++i) render(c, { r }, cache);
        CHECK(c.gradeTextureCount() == 2, "two grades in use -> two transfer textures, however many frames");

        // A drag: a new baked grade per change. The ones left behind go away.
        for (int i = 0; i < 20; ++i) {
            ColorGrade g;
            g.exposure = 0.05f * (i + 1);
            CellFrameRequest q = fullscreen("ramp.mp4");
            q.gradeSource = bakeColorGrade(g, nullptr);
            render(c, { q }, cache);
        }
        CHECK(c.gradeTextureCount() > 2, "a drag uploads as it goes");
        CellFrameRequest plain = fullscreen("ramp.mp4");
        for (uint64_t i = 0; i < GradeGpuCache::kKeepPasses + 4; ++i)
            c.compositeFrame({ plain }, cache, 1, 1);
        CHECK(c.gradeTextureCount() == 0, "unused grade textures are evicted");
        c.shutdown();
    }

    // ── 12. Cost (informational) ────────────────────────────────────────────
    {
        std::fprintf(stderr, "[TEST:ColorGradeGPU] 12: cost of four levels on a 4x4 grid at 1080p\n");
        const int W = 1920, H = 1080;
        cache.put({"big.mp4", 0}, makeTexture(makeRamp(960, 540), 960, 540));
        GridCompositor c;
        CHECK(c.init(g_device, g_deviceCtx, W, H), "1080p compositor");
        std::vector<CellFrameRequest> plain, graded;
        for (int row = 0; row < 4; ++row) {
            for (int col = 0; col < 4; ++col) {
                CellFrameRequest q{};
                q.cellCol = col * kGridSubUnitsPerColumn; q.cellRow = row * kGridSubUnitsPerRow;
                q.spanX = kGridSubUnitsPerColumn; q.spanY = kGridSubUnitsPerRow;
                q.sourcePath = "big.mp4"; q.sourceFrameIndex = 0;
                q.opacity = 1.0f; q.layerKind = CellLayerKind::Grid; q.zOrder = row * 4 + col;
                plain.push_back(q);
                q.gradeSource = bakedRich; q.gradeClip = bWash; q.gradeLayer = bWarm;
                graded.push_back(q);
            }
        }
        auto timeIt = [&](const std::vector<CellFrameRequest>& reqs, bool master) {
            c.setMasterGrade(master ? bCrush : nullptr);
            for (int i = 0; i < 5; ++i) { c.compositeFrame(reqs, cache, 4, 4); c.readback(); }   // settle
            const auto t0 = std::chrono::high_resolution_clock::now();
            const int n = 40;
            for (int i = 0; i < n; ++i) { c.compositeFrame(reqs, cache, 4, 4); c.readback(); }
            const double ms = std::chrono::duration<double, std::milli>(
                std::chrono::high_resolution_clock::now() - t0).count();
            return ms / n;
        };
        // Alternate the two and keep each one's best run: a single ordered pair
        // mostly measures the GPU waking up, not the grade.
        for (int i = 0; i < 20; ++i) { c.compositeFrame(plain, cache, 4, 4); c.readback(); }
        double msPlain = 1e9, msGraded = 1e9;
        for (int round = 0; round < 4; ++round) {
            msPlain  = std::min(msPlain,  timeIt(plain, false));
            msGraded = std::min(msGraded, timeIt(graded, true));
        }
        std::fprintf(stderr,
            "    composite + readback per frame (best of 4): %.2f ms ungraded, %.2f ms with\n"
            "    Source+Clip+Layer on 16 cells and a Master grade (%+.2f ms). THIS machine's GPU only;\n"
            "    it says nothing about the low-end laptop.\n",
            msPlain, msGraded, msGraded - msPlain);
        c.compositeFrame(graded, cache, 4, 4);
        CHECK(c.lastGradePassCount() == 16, "sixteen graded cells -> sixteen passes (one each, three levels)");
        c.shutdown();
    }

    std::fprintf(stderr, "[TEST:ColorGradeGPU] %d passed, %d failed\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
