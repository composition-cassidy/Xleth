// test_snapshot_transition.cpp — direct D3D11 validation of whole-frame transitions.

#include "render/GridCompositor.h"
#include "render/GpuDeviceManager.h"
#include "render/FrameCollector.h"
#include "render/FrameCache.h"
#include "render/RenderClock.h"
#include "render/SnapshotTransitionTiming.h"
#include "render/SnapshotTransitionRenderer.h"
#include "model/Timeline.h"
#include "SyncManager.h"   // VideoEvent

// Force assert even in Release builds (NDEBUG is defined).
#undef NDEBUG
#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <set>
#include <string>
#include <vector>

namespace {

struct Color {
    uint8_t r;
    uint8_t g;
    uint8_t b;
    uint8_t a;
};

constexpr int kWidth = 64;
constexpr int kHeight = 32;

void fillTarget(ID3D11DeviceContext* context,
                ID3D11RenderTargetView* rtv,
                const Color& color)
{
    ID3D11RenderTargetView* target = rtv;
    context->OMSetRenderTargets(1, &target, nullptr);
    const float clear[4] = {
        static_cast<float>(color.r) / 255.0f,
        static_cast<float>(color.g) / 255.0f,
        static_cast<float>(color.b) / 255.0f,
        static_cast<float>(color.a) / 255.0f,
    };
    context->ClearRenderTargetView(rtv, clear);
}

Color pixelAt(const ReadbackBuffer& buffer, int x, int y)
{
    assert(buffer.valid);
    assert(x >= 0 && x < buffer.width);
    assert(y >= 0 && y < buffer.height);
    const uint8_t* bgra = buffer.pixels.data()
        + static_cast<size_t>(y) * buffer.stride
        + static_cast<size_t>(x) * 4;
    return { bgra[2], bgra[1], bgra[0], bgra[3] };
}

bool channelNear(uint8_t actual, uint8_t expected, int tolerance)
{
    return std::abs(static_cast<int>(actual) - static_cast<int>(expected)) <= tolerance;
}

bool colorNear(const Color& actual, const Color& expected, int tolerance)
{
    return channelNear(actual.r, expected.r, tolerance)
        && channelNear(actual.g, expected.g, tolerance)
        && channelNear(actual.b, expected.b, tolerance)
        && channelNear(actual.a, expected.a, tolerance);
}

void assertEveryPixel(const ReadbackBuffer& buffer,
                      const Color& expected,
                      int tolerance)
{
    assert(buffer.valid);
    assert(buffer.width == kWidth && buffer.height == kHeight);
    for (int y = 0; y < buffer.height; ++y) {
        for (int x = 0; x < buffer.width; ++x) {
            const Color actual = pixelAt(buffer, x, y);
            if (!colorNear(actual, expected, tolerance)) {
                std::fprintf(stderr,
                    "[TEST:SnapshotTransition] pixel (%d,%d) = (%u,%u,%u,%u), "
                    "expected (%u,%u,%u,%u) +/- %d\n",
                    x, y, actual.r, actual.g, actual.b, actual.a,
                    expected.r, expected.g, expected.b, expected.a, tolerance);
                assert(false && "transition output pixel mismatch");
            }
        }
    }
}

Color channelAverage(const Color& a, const Color& b)
{
    return {
        static_cast<uint8_t>((static_cast<int>(a.r) + b.r + 1) / 2),
        static_cast<uint8_t>((static_cast<int>(a.g) + b.g + 1) / 2),
        static_cast<uint8_t>((static_cast<int>(a.b) + b.b + 1) / 2),
        static_cast<uint8_t>((static_cast<int>(a.a) + b.a + 1) / 2),
    };
}

// ── Determinism-test helpers ────────────────────────────────────────────────

// Build a VideoEvent (minimal fields the collector needs).
VideoEvent makeEvent(int trackId, int sourceId, double startBeat,
                     double durationBeats, double sourceStartTime)
{
    VideoEvent ev{};
    ev.trackId         = trackId;
    ev.sourceId        = sourceId;
    ev.startBeat       = startBeat;
    ev.durationBeats   = durationBeats;
    ev.sourceStartTime = sourceStartTime;
    ev.layerIndex      = 0;
    ev.x = 0; ev.y = 0; ev.width = 1; ev.height = 1;
    ev.opacity         = 1.0f;
    ev.globalNoteIndex = 0;
    return ev;
}

// Create a solid-color BGRA texture entry (the determinism test synthesizes source
// frames instead of decoding a real video — every requested frame of "A.mp4" is
// colorA, every frame of "B.mp4" is colorB, so the two snapshots are DISTINCT).
FrameCacheEntry makeSolidEntry(ID3D11Device* device, const Color& c, int w, int h)
{
    std::vector<uint8_t> pixels(static_cast<size_t>(w) * h * 4);
    for (int i = 0; i < w * h; ++i) {
        pixels[i * 4 + 0] = c.b;
        pixels[i * 4 + 1] = c.g;
        pixels[i * 4 + 2] = c.r;
        pixels[i * 4 + 3] = c.a;
    }
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = (UINT)w; desc.Height = (UINT)h;
    desc.MipLevels = 1; desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA init = {};
    init.pSysMem = pixels.data();
    init.SysMemPitch = (UINT)(w * 4);

    FrameCacheEntry entry;
    HRESULT hr = device->CreateTexture2D(&desc, &init, &entry.texture);
    assert(SUCCEEDED(hr));
    hr = device->CreateShaderResourceView(entry.texture.Get(), nullptr, &entry.srv);
    assert(SUCCEEDED(hr));
    entry.width = w; entry.height = h;
    entry.memorySizeBytes = static_cast<size_t>(w) * h * 4;
    return entry;
}

FrameCacheEntry makePatternEntry(ID3D11Device* device, int w, int h)
{
    constexpr Color colors[] = {
        {240, 30, 30, 255}, {30, 220, 60, 255},
        {30, 80, 230, 255}, {230, 210, 30, 255},
    };
    std::vector<uint8_t> pixels(static_cast<size_t>(w) * h * 4);
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            const Color& c = colors[std::min(3, x * 4 / w)];
            const size_t i = (static_cast<size_t>(y) * w + x) * 4;
            pixels[i + 0] = c.b;
            pixels[i + 1] = c.g;
            pixels[i + 2] = c.r;
            pixels[i + 3] = c.a;
        }
    }
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = (UINT)w; desc.Height = (UINT)h;
    desc.MipLevels = 1; desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA init = {};
    init.pSysMem = pixels.data();
    init.SysMemPitch = (UINT)(w * 4);

    FrameCacheEntry entry;
    assert(SUCCEEDED(device->CreateTexture2D(&desc, &init, &entry.texture)));
    assert(SUCCEEDED(device->CreateShaderResourceView(entry.texture.Get(), nullptr, &entry.srv)));
    entry.width = w; entry.height = h;
    entry.memorySizeBytes = static_cast<size_t>(w) * h * 4;
    return entry;
}

// FNV-1a over the tightly-packed pixel region (ignore stride padding so two
// readbacks from the same target hash identically iff their content matches).
uint64_t hashBuffer(const ReadbackBuffer& b)
{
    assert(b.valid);
    uint64_t h = 1469598103934665603ULL;
    for (int y = 0; y < b.height; ++y) {
        const uint8_t* row = b.pixels.data() + static_cast<size_t>(y) * b.stride;
        for (int x = 0; x < b.width * 4; ++x) {
            h ^= row[x];
            h *= 1099511628211ULL;
        }
    }
    return h;
}

} // namespace

int main()
{
    std::fprintf(stderr, "[TEST:SnapshotTransition] Starting GPU transition test\n");

    GpuDeviceManager gpu;
    if (!gpu.detectAdapters()) {
        std::fprintf(stderr, "[TEST:SnapshotTransition] UNAVAILABLE: no DXGI adapter\n");
        return EXIT_FAILURE;
    }
    if (!gpu.createDevice()) {
        std::fprintf(stderr, "[TEST:SnapshotTransition] UNAVAILABLE: D3D11 device creation failed\n");
        return EXIT_FAILURE;
    }

    ID3D11Device* device = gpu.getDevice();
    ID3D11DeviceContext* context = gpu.getContext();
    assert(device && context);

    GridCompositor compositor;
    assert(compositor.init(device, context, kWidth, kHeight));

    RTPool::RTPair& targets = compositor.acquireTransitionTargets();
    assert(targets.rtvA && targets.rtvB && targets.srvA && targets.srvB);
    assert(targets.width == kWidth && targets.height == kHeight);

    constexpr Color colorA{ 40, 80, 200, 255 };
    constexpr Color colorB{ 220, 160, 20, 255 };
    static_assert(colorA.r != colorB.r && colorA.g != colorB.g && colorA.b != colorB.b);

    fillTarget(context, targets.rtvA.Get(), colorA);
    fillTarget(context, targets.rtvB.Get(), colorB);

    compositor.transitionPass(targets.srvA.Get(), targets.srvB.Get(), 0, 0.0f, 0.0f, 0.0f, 0.12f, 1);
    assertEveryPixel(compositor.readback(), colorA, 0);

    compositor.transitionPass(targets.srvA.Get(), targets.srvB.Get(), 0, 1.0f, 0.0f, 0.0f, 0.12f, 1);
    assertEveryPixel(compositor.readback(), colorB, 0);

    compositor.transitionPass(targets.srvA.Get(), targets.srvB.Get(), 0, 0.5f, 0.0f, 0.0f, 0.12f, 1);
    assertEveryPixel(compositor.readback(), channelAverage(colorA, colorB), 1);

    compositor.transitionPass(targets.srvA.Get(), targets.srvB.Get(), 1, 0.5f, 0.0f, 0.0f, 0.12f, 1);
    const ReadbackBuffer sweep = compositor.readback();
    assert(sweep.valid);
    const Color left = pixelAt(sweep, kWidth / 4, kHeight / 2);
    const Color right = pixelAt(sweep, 3 * kWidth / 4, kHeight / 2);
    assert(colorNear(left, colorB, 0));
    assert(colorNear(right, colorA, 0));
    assert(!colorNear(left, right, 0));

    // Angle convention: 0° reveals B left→right, 180° right→left; 90°
    // reveals top→bottom and 270° bottom→top. These are the four cardinal
    // direction presets that the free-angle UI snaps to.
    constexpr float kPi = 3.14159265358979323846f;
    compositor.transitionPass(targets.srvA.Get(), targets.srvB.Get(), 1, 0.5f, kPi, 0.0f, 0.12f, 1);
    const ReadbackBuffer reverseHorizontal = compositor.readback();
    assert(colorNear(pixelAt(reverseHorizontal, kWidth / 4, kHeight / 2), colorA, 0));
    assert(colorNear(pixelAt(reverseHorizontal, 3 * kWidth / 4, kHeight / 2), colorB, 0));

    compositor.transitionPass(targets.srvA.Get(), targets.srvB.Get(), 1, 0.5f, kPi / 2.0f, 0.0f, 0.12f, 1);
    const ReadbackBuffer topDown = compositor.readback();
    assert(colorNear(pixelAt(topDown, kWidth / 2, kHeight / 4), colorB, 0));
    assert(colorNear(pixelAt(topDown, kWidth / 2, 3 * kHeight / 4), colorA, 0));

    compositor.transitionPass(targets.srvA.Get(), targets.srvB.Get(), 1, 0.5f, 3.0f * kPi / 2.0f, 0.0f, 0.12f, 1);
    const ReadbackBuffer bottomUp = compositor.readback();
    assert(colorNear(pixelAt(bottomUp, kWidth / 2, kHeight / 4), colorA, 0));
    assert(colorNear(pixelAt(bottomUp, kWidth / 2, 3 * kHeight / 4), colorB, 0));

    auto pass = [&](ID3D11ShaderResourceView* a, ID3D11ShaderResourceView* b,
                    int mode, float progress, float angle = 0.0f,
                    float softness = 0.0f, float zoom = 0.12f, int grain = 1,
                    float radialX = 0.5f, float radialY = 0.5f,
                    int pixelateBlock = 32, float glitch = 0.65f,
                    int glitchBlock = 24, float blur = 16.0f,
                    float displacement = 0.06f, float displacementScale = 6.0f,
                    int seed = 0) {
        compositor.transitionPass(a, b, mode, progress, angle, softness, zoom, grain,
                                  radialX, radialY, pixelateBlock, glitch, glitchBlock,
                                  blur, displacement, displacementScale, seed);
        return compositor.readback();
    };

    // Every mode has byte-exact shoulders, including mask/feather modes.
    for (int mode = 0; mode <= 11; ++mode) {
        assertEveryPixel(pass(targets.srvA.Get(), targets.srvB.Get(), mode, 0.0f), colorA, 0);
        assertEveryPixel(pass(targets.srvA.Get(), targets.srvB.Get(), mode, 1.0f), colorB, 0);
    }

    // Patterned inputs distinguish Push (A moves) from Slide Over (A stays put).
    FrameCacheEntry patternA = makePatternEntry(device, kWidth, kHeight);
    FrameCacheEntry patternB = makePatternEntry(device, kWidth, kHeight);
    const ReadbackBuffer pushed = pass(patternA.srv.Get(), patternB.srv.Get(), 2, 0.5f);
    const ReadbackBuffer slid = pass(patternA.srv.Get(), patternB.srv.Get(), 3, 0.5f);
    assert(!colorNear(pixelAt(pushed, 3 * kWidth / 4, kHeight / 2),
                      pixelAt(slid, 3 * kWidth / 4, kHeight / 2), 0)
           && "Push must translate outgoing A while Slide keeps A stationary");

    // Feathering produces a real blend band without changing the shoulders.
    const ReadbackBuffer feathered = pass(
        targets.srvA.Get(), targets.srvB.Get(), 1, 0.5f, 0.0f, 0.10f);
    const Color featherPixel = pixelAt(feathered, kWidth / 2 - 3, kHeight / 2);
    assert(!colorNear(featherPixel, colorA, 0) && !colorNear(featherPixel, colorB, 0));

    // Zoom amount changes geometry when the source contains spatial detail.
    const uint64_t nativeZoomHash = hashBuffer(pass(
        patternA.srv.Get(), patternA.srv.Get(), 4, 0.5f, 0.0f, 0.0f, 0.0f));
    const uint64_t strongZoomHash = hashBuffer(pass(
        patternA.srv.Get(), patternA.srv.Get(), 4, 0.5f, 0.0f, 0.0f, 0.30f));
    assert(nativeZoomHash != strongZoomHash && "Zoom amount must alter patterned geometry");

    // Dissolve is a stable spatial mask: repeatable at a fixed grain, with a
    // different distribution when grain size changes and roughly half B at t=.5.
    const ReadbackBuffer dissolve1 = pass(
        targets.srvA.Get(), targets.srvB.Get(), 5, 0.5f, 0.0f, 0.0f, 0.12f, 1);
    const uint64_t dissolveHash1 = hashBuffer(dissolve1);
    const uint64_t dissolveHash2 = hashBuffer(pass(
        targets.srvA.Get(), targets.srvB.Get(), 5, 0.5f, 0.0f, 0.0f, 0.12f, 1));
    assert(dissolveHash1 == dissolveHash2 && "Dissolve mask must not shimmer");
    int bPixels = 0;
    for (int y = 0; y < kHeight; ++y)
        for (int x = 0; x < kWidth; ++x)
            if (colorNear(pixelAt(dissolve1, x, y), colorB, 0)) ++bPixels;
    assert(bPixels > kWidth * kHeight / 3 && bPixels < 2 * kWidth * kHeight / 3);
    const uint64_t coarseDissolveHash = hashBuffer(pass(
        targets.srvA.Get(), targets.srvB.Get(), 5, 0.5f, 0.0f, 0.0f, 0.12f, 8));
    assert(coarseDissolveHash != dissolveHash1 && "Dissolve grain must alter the mask");

    // Out-Then-In lands on exact opaque black at the fixed pin.
    constexpr Color opaqueBlack{0, 0, 0, 255};
    assertEveryPixel(pass(targets.srvA.Get(), targets.srvB.Get(), 6, 0.5f), opaqueBlack, 0);

    // Radial reveal opens from the authored origin and retains A beyond the radius.
    const ReadbackBuffer radial = pass(
        targets.srvA.Get(), targets.srvB.Get(), 7, 0.35f,
        0.0f, 0.0f, 0.12f, 1, 0.5f, 0.5f);
    assert(colorNear(pixelAt(radial, kWidth / 2, kHeight / 2), colorB, 0));
    assert(colorNear(pixelAt(radial, 0, 0), colorA, 0));
    const uint64_t shiftedRadialHash = hashBuffer(pass(
        targets.srvA.Get(), targets.srvB.Get(), 7, 0.35f,
        0.0f, 0.0f, 0.12f, 1, 0.2f, 0.7f));
    assert(shiftedRadialHash != hashBuffer(radial) && "Radial origin must move the reveal");

    // Pixelate, blur, glitch, and displacement all alter patterned geometry.
    const uint64_t unmodifiedPatternHash = hashBuffer(pass(
        patternA.srv.Get(), patternA.srv.Get(), 0, 0.5f));
    const uint64_t pixelatedHash = hashBuffer(pass(
        patternA.srv.Get(), patternA.srv.Get(), 8, 0.5f,
        0.0f, 0.0f, 0.12f, 1, 0.5f, 0.5f, 48));
    assert(pixelatedHash != unmodifiedPatternHash && "Pixelate must quantize patterned UVs");

    const uint64_t glitchHash1 = hashBuffer(pass(
        patternA.srv.Get(), patternA.srv.Get(), 9, 0.5f,
        0.0f, 0.0f, 0.12f, 1, 0.5f, 0.5f, 32, 0.9f, 16, 16.0f,
        0.06f, 6.0f, 7));
    const uint64_t glitchHash2 = hashBuffer(pass(
        patternA.srv.Get(), patternA.srv.Get(), 9, 0.5f,
        0.0f, 0.0f, 0.12f, 1, 0.5f, 0.5f, 32, 0.9f, 16, 16.0f,
        0.06f, 6.0f, 7));
    const uint64_t alternateGlitchHash = hashBuffer(pass(
        patternA.srv.Get(), patternA.srv.Get(), 9, 0.5f,
        0.0f, 0.0f, 0.12f, 1, 0.5f, 0.5f, 32, 0.9f, 16, 16.0f,
        0.06f, 6.0f, 91));
    assert(glitchHash1 == glitchHash2 && "Glitch must be deterministic for a fixed seed");
    assert(glitchHash1 != alternateGlitchHash && "Glitch seed must change its pattern");

    const uint64_t blurredHash = hashBuffer(pass(
        patternA.srv.Get(), patternA.srv.Get(), 10, 0.5f,
        kPi / 4.0f, 0.0f, 0.12f, 1, 0.5f, 0.5f, 32, 0.65f, 24, 32.0f));
    assert(blurredHash != unmodifiedPatternHash && "Blur Through must blur spatial detail");

    const uint64_t displacementHash1 = hashBuffer(pass(
        patternA.srv.Get(), patternA.srv.Get(), 11, 0.5f,
        0.0f, 0.0f, 0.12f, 1, 0.5f, 0.5f, 32, 0.65f, 24, 16.0f,
        0.15f, 8.0f, 3));
    const uint64_t displacementHash2 = hashBuffer(pass(
        patternA.srv.Get(), patternA.srv.Get(), 11, 0.5f,
        0.0f, 0.0f, 0.12f, 1, 0.5f, 0.5f, 32, 0.65f, 24, 16.0f,
        0.15f, 8.0f, 3));
    assert(displacementHash1 == displacementHash2
           && displacementHash1 != unmodifiedPatternHash
           && "Displacement must be stable and alter patterned geometry");

    // ────────────────────────────────────────────────────────────────────────
    // Phase 3b: preview==export determinism across a real transition window.
    //
    // Drives renderSnapshotTransition — the SAME helper the preview seam
    // (XlethEngineService.cpp) and the export seam (OfflineRenderer.cpp) call —
    // over a cue's window, once with PREVIEW framing and once with EXPORT framing
    // for the SAME absolute project sample per frame. A subrange export starting at
    // the project origin (projectStartSample=0, frame=f) and a stopped-preview scrub
    // to that same absolute position (projectStartSample=S, frame=0) must produce
    // byte-identical pixels. Two DISTINCT snapshots (all-red A vs all-blue B) make a
    // hard cut or no-op fail the t=0.5 blend assertion.
    // ────────────────────────────────────────────────────────────────────────
    {
        std::fprintf(stderr, "\n[TEST:SnapshotTransition] --- Phase 3b: preview==export determinism ---\n");

        const int        sampleRate = 48000;
        const double     bpm        = 140.0;
        const AVRational fps        = { 30, 1 };

        Timeline tl(bpm, static_cast<double>(sampleRate));

        SourceMedia sA; sA.filePath = "A.mp4"; sA.hasVideo = true; sA.fps = 30.0;
        sA.duration = 60.0; sA.totalFrames = 1800; sA.width = 1920; sA.height = 1080;
        const int sidA = tl.addSource(sA);
        SourceMedia sB; sB.filePath = "B.mp4"; sB.hasVideo = true; sB.fps = 30.0;
        sB.duration = 60.0; sB.totalFrames = 1800; sB.width = 1920; sB.height = 1080;
        const int sidB = tl.addSource(sB);

        TrackInfo trkA; trkA.type = TrackInfo::Type::Pattern; const int tA = tl.addTrack(trkA);
        TrackInfo trkB; trkB.type = TrackInfo::Type::Pattern; const int tB = tl.addTrack(trkB);

        const int FCOL = kGridSubUnitsPerColumn;
        const int FROW = kGridSubUnitsPerRow;

        // Base snapshot: single full-frame cell showing track A (→ "A.mp4" → red).
        GridLayout base; base.columns = 1; base.rows = 1;
        base.slots.push_back({ tA, 0, 0, FCOL, FROW, 1.0f, 0 });
        tl.setGridLayout(base);
        const std::string baseId = tl.getActiveSnapshotId();

        // Alt snapshot: same cell showing track B (→ "B.mp4" → blue). DISTINCT look.
        const std::string altId = tl.createGridSnapshot(/*cloneActive=*/false, "Alt");
        GridLayout alt; alt.columns = 1; alt.rows = 1;
        alt.slots.push_back({ tB, 0, 0, FCOL, FROW, 1.0f, 0 });
        tl.setGridLayout(alt);
        tl.setActiveGridSnapshot(baseId);

        // Cue at beat 4 is the pin; a symmetric ±1-beat crossfade window.
        const TickTime pinTick = TickTime::fromBeats(4.0);
        tl.addGridCue(pinTick, altId);
        SnapshotTransition tr;
        tr.enabled          = true;
        tr.startOffsetTicks = TickTime::fromBeats(1.0).ticks;
        tr.endOffsetTicks   = TickTime::fromBeats(1.0).ticks;
        tr.type             = SnapshotTransition::Type::Crossfade;
        tr.startToPinEasing = {0.42f, 0.0f, 1.0f, 1.0f};
        tr.pinToEndEasing   = {0.0f, 0.0f, 0.58f, 1.0f};
        tl.setCueTransition(pinTick, tr);

        // Both tracks active across the whole window.
        std::vector<VideoEvent> evs = {
            makeEvent(tA, sidA, 0.0, 8.0, 0.0),
            makeEvent(tB, sidB, 0.0, 8.0, 0.0),
        };

        constexpr Color colorRed { 220, 30, 30, 255 };   // snapshot A
        constexpr Color colorBlue{ 30, 30, 220, 255 };   // snapshot B

        FrameCollector collector;
        RenderFrameCache cache;
        std::set<int64_t> decodedAFrames;
        std::set<int64_t> decodedBFrames;
        auto decodeMisses = [&](const std::vector<FrameCacheKey>& misses) {
            for (const auto& k : misses) {
                const Color c = (k.sourcePath == "A.mp4") ? colorRed : colorBlue;
                if (k.sourcePath == "A.mp4") decodedAFrames.insert(k.frameIndex);
                if (k.sourcePath == "B.mp4") decodedBFrames.insert(k.frameIndex);
                cache.put(k, makeSolidEntry(device, c, 64, 64));
            }
        };

        auto makeCtx = [&](int64_t frameIdx, int64_t projStart) {
            xleth::SnapshotTransitionFrameCtx c;
            c.sampleRate         = sampleRate;
            c.bpm                = bpm;
            c.fps                = fps;
            c.outputFrameIndex   = frameIdx;
            c.projectStartSample = projStart;
            c.allowProxy         = false;
            c.posterMode         = false;
            c.renderProxyBySource = nullptr;
            return c;
        };

        // Window bounds in samples, for the explicit t=0 / 0.5 / 1 checks.
        const Timeline::ResolvedTransition rtPin = tl.transitionAt(pinTick);
        assert(rtPin.active);
        const int64_t startSample = RenderClock::ppqToSample(rtPin.startTick.ticks, sampleRate, bpm);
        const int64_t pinSample   = RenderClock::ppqToSample(rtPin.pinTick.ticks,   sampleRate, bpm);
        const int64_t endSample   = RenderClock::ppqToSample(rtPin.endTick.ticks,   sampleRate, bpm);

        // Frame-by-frame preview==export equality across the window (+ a margin so
        // both the t≈0 and t≈1 shoulders are exercised).
        const int64_t fLo = RenderClock::sampleToVideoFrame(startSample, sampleRate, fps) - 2;
        const int64_t fHi = RenderClock::sampleToVideoFrame(endSample,   sampleRate, fps) + 2;

        int comparedFrames = 0;
        int blendFrames    = 0;
        for (int64_t f = fLo; f <= fHi; ++f) {
            const int64_t S = RenderClock::videoFrameToSample(f, sampleRate, fps);
            const int64_t tick = RenderClock::sampleToPPQ(S, sampleRate, bpm);
            const Timeline::ResolvedTransition rt = tl.transitionAt(TickTime{ tick });
            if (!rt.active) continue;  // outside window — the single-composite path

            // PREVIEW framing: stopped scrub to absolute sample S (frame 0 origin).
            const bool okP = xleth::renderSnapshotTransition(
                rt, tl, evs, compositor, collector, cache,
                makeCtx(/*frameIdx=*/0, /*projStart=*/S), decodeMisses);
            assert(okP && "preview transition must render inside the window");
            const uint64_t hP = hashBuffer(compositor.readback());

            // EXPORT framing: full-project export, frame index f from origin 0.
            const bool okE = xleth::renderSnapshotTransition(
                rt, tl, evs, compositor, collector, cache,
                makeCtx(/*frameIdx=*/f, /*projStart=*/0), decodeMisses);
            assert(okE && "export transition must render inside the window");
            const uint64_t hE = hashBuffer(compositor.readback());

            if (hP != hE) {
                std::fprintf(stderr,
                    "[TEST:SnapshotTransition] frame %lld: preview hash %llu != export hash %llu\n",
                    (long long)f, (unsigned long long)hP, (unsigned long long)hE);
                assert(false && "preview and export must be frame-exact");
            }
            ++comparedFrames;

            // Count frames strictly between the shoulders as genuine blends.
            if (S > startSample && S < endSample) ++blendFrames;
        }
        assert(comparedFrames > 4 && "window should span several frames");
        assert(blendFrames    > 0 && "window should contain interior blend frames");
        assert(decodedAFrames.size() > 2
               && "outgoing snapshot A must request multiple live source frames");
        assert(decodedBFrames.size() > 2
               && "incoming snapshot B must request multiple live source frames");
        assert(decodedAFrames == decodedBFrames
               && "A and B must advance from the same absolute project time");
        std::fprintf(stderr,
            "[TEST:SnapshotTransition] preview==export over %d frames (%d interior), "
            "%zu live frames per snapshot: PASSED\n",
            comparedFrames, blendFrames, decodedAFrames.size());

        // Sample all twelve shader modes at both shoulders and three interior
        // positions. Each pair uses different preview/export framing for the
        // same absolute project sample and must remain byte-identical.
        const SnapshotTransition::Type allTypes[] = {
            SnapshotTransition::Type::Crossfade, SnapshotTransition::Type::LineSweep,
            SnapshotTransition::Type::Push, SnapshotTransition::Type::Slide,
            SnapshotTransition::Type::Zoom, SnapshotTransition::Type::Dissolve,
            SnapshotTransition::Type::OutThenIn,
            SnapshotTransition::Type::RadialReveal, SnapshotTransition::Type::Pixelate,
            SnapshotTransition::Type::Glitch, SnapshotTransition::Type::BlurThrough,
            SnapshotTransition::Type::Displacement,
        };
        const int64_t samples[] = {
            startSample,
            startSample + (pinSample - startSample) / 2,
            pinSample,
            pinSample + (endSample - pinSample) / 2,
            endSample,
        };
        int modeComparisons = 0;
        for (const auto type : allTypes) {
            tr.type = type;
            tr.geomAngleDeg = 90.0f;
            tr.edgeSoftness = 0.025f;
            tr.zoomAmount = 0.2f;
            tr.dissolveGrainPx = 5;
            tr.radialOriginX = 0.3f;
            tr.radialOriginY = 0.7f;
            tr.pixelateMaxBlockPx = 40;
            tr.glitchIntensity = 0.8f;
            tr.glitchBlockPx = 18;
            tr.blurRadiusPx = 24.0f;
            tr.displacementAmount = 0.12f;
            tr.displacementScale = 9.0f;
            tr.effectSeed = 23;
            tl.setCueTransition(pinTick, tr);
            for (const int64_t S : samples) {
                const TickTime tick{ RenderClock::sampleToPPQ(S, sampleRate, bpm) };
                const Timeline::ResolvedTransition rt = tl.transitionAt(tick);
                assert(rt.active);
                assert(xleth::renderSnapshotTransition(
                    rt, tl, evs, compositor, collector, cache,
                    makeCtx(0, S), decodeMisses));
                const uint64_t previewHash = hashBuffer(compositor.readback());

                const int64_t frame = RenderClock::sampleToVideoFrame(S, sampleRate, fps);
                const int64_t frameSample = RenderClock::videoFrameToSample(frame, sampleRate, fps);
                assert(xleth::renderSnapshotTransition(
                    rt, tl, evs, compositor, collector, cache,
                    makeCtx(frame, S - frameSample), decodeMisses));
                const uint64_t exportHash = hashBuffer(compositor.readback());
                assert(previewHash == exportHash && "every transition mode must be preview/export exact");
                ++modeComparisons;
            }
        }
        assert(modeComparisons == 60);
        tr.type = SnapshotTransition::Type::Crossfade;
        tr.geomAngleDeg = 0.0f;
        tr.edgeSoftness = 0.0f;
        tl.setCueTransition(pinTick, tr);

        // Explicit t=0 / t=0.5 / t=1 checks at exact samples (preview framing).
        // t=0 at the Start shoulder → pure outgoing A (red).
        {
            const Timeline::ResolvedTransition rt = tl.transitionAt(
                TickTime{ RenderClock::sampleToPPQ(startSample, sampleRate, bpm) });
            assert(rt.active);
            assert(xleth::renderSnapshotTransition(
                rt, tl, evs, compositor, collector, cache,
                makeCtx(0, startSample), decodeMisses));
            const ReadbackBuffer rb = compositor.readback();
            const Color mid = pixelAt(rb, rb.width / 2, rb.height / 2);
            assert(colorNear(mid, colorRed, 4) && "t=0 must be the outgoing snapshot");
        }
        // t=1 at the End shoulder → pure incoming B (blue). Proves NOT a no-op: a
        // no-op would show the editor's active snapshot (Base=A) here.
        {
            const Timeline::ResolvedTransition rt = tl.transitionAt(
                TickTime{ RenderClock::sampleToPPQ(endSample, sampleRate, bpm) });
            assert(rt.active);
            assert(xleth::renderSnapshotTransition(
                rt, tl, evs, compositor, collector, cache,
                makeCtx(0, endSample), decodeMisses));
            const ReadbackBuffer rb = compositor.readback();
            const Color mid = pixelAt(rb, rb.width / 2, rb.height / 2);
            assert(colorNear(mid, colorBlue, 4) && "t=1 must be the incoming snapshot");
        }
        // t=0.5 at the pin → a REAL blend of two DISTINCT snapshots. A hard cut
        // would land on pure red or pure blue and fail this.
        {
            const Timeline::ResolvedTransition rt = tl.transitionAt(pinTick);
            assert(rt.active);
            assert(xleth::renderSnapshotTransition(
                rt, tl, evs, compositor, collector, cache,
                makeCtx(0, pinSample), decodeMisses));
            const ReadbackBuffer rb = compositor.readback();
            const Color mid = pixelAt(rb, rb.width / 2, rb.height / 2);
            const Color expected = channelAverage(colorRed, colorBlue);
            std::fprintf(stderr,
                "[TEST:SnapshotTransition] pin blend = (%u,%u,%u), expected ~(%u,%u,%u)\n",
                mid.r, mid.g, mid.b, expected.r, expected.g, expected.b);
            // Must be a genuine mix: both red and blue channels clearly present, and
            // distinctly different from either pure snapshot.
            assert(mid.r > 80 && mid.r < 170 && "pin red channel must be a blend");
            assert(mid.b > 80 && mid.b < 170 && "pin blue channel must be a blend");
            assert(!colorNear(mid, colorRed,  40) && "pin must not be pure A (hard cut?)");
            assert(!colorNear(mid, colorBlue, 40) && "pin must not be pure B (hard cut?)");
        }
        std::fprintf(stderr, "[TEST:SnapshotTransition] Phase 3b: PASSED\n");
    }

    compositor.shutdown();
    std::fprintf(stderr, "[TEST:SnapshotTransition] ALL TESTS PASSED\n");
    return EXIT_SUCCESS;
}
