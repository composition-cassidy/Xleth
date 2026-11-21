// test_landing_floor.cpp — the Landing perf floor, as a cross-build probe
// (docs/XLETH_LANDING_SPEC.md ruling 9 and §9 "Perf floor").
//
// Ruling 9: a project with cues but NO landings must produce byte-identical
// frames to the build before Landings existed. test_landing_render checks that
// inside one build (the seam sequence with the landing calls in it against the
// same sequence without them). This file is the other half: a fixed project
// rendered through the ordinary frame path, one hash per frame, written so the
// SAME SOURCE FILE compiles on the pre-feature commit (af40dee) too. Build it
// there, build it here, run both on one machine, and the two digests have to
// match. docs/XLETH_LANDING_VERIFY.md records that comparison.
//
// It therefore uses ONLY what existed before the feature: Timeline cues and
// transitions, FrameCollector::collectRequests, GridCompositor::compositeFrame
// and renderSnapshotTransition. Do not add a Landing call here.
//
// The project is chosen to walk every piece of code the feature touched:
//   • grid cells at full, half and quarter spans, three grid sizes, three
//     layout gaps and a per-track gap override   (GridRectMath promotion)
//   • a fullscreen layer and corner radii         (the per-cell path)
//   • a hard cut, a crossfade and a Push          (transition + collect order)
//   • notes with gaps on a Hold Last Frame track  (the collector's hold GC)
//
// As a ctest it checks that the run is deterministic (two passes, one digest)
// and prints the digest. Usage: test_landing_floor [hashes.txt]

#include "render/GridCompositor.h"
#include "render/GpuDeviceManager.h"
#include "render/FrameCollector.h"
#include "render/FrameCache.h"
#include "render/RenderClock.h"
#include "render/SnapshotTransitionRenderer.h"
#include "model/Timeline.h"
#include "SyncManager.h"   // VideoEvent

// Force assert even in Release builds (NDEBUG is defined).
#undef NDEBUG
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <string>
#include <unordered_map>
#include <vector>

namespace {

constexpr int        kW   = 320;
constexpr int        kH   = 180;
constexpr int        kSR  = 48000;
constexpr double     kBpm = 140.0;
constexpr AVRational kFps = { 30, 1 };

struct Color { uint8_t r, g, b, a; };

uint64_t fnv(uint64_t h, const uint8_t* data, size_t n)
{
    for (size_t i = 0; i < n; ++i) { h ^= data[i]; h *= 1099511628211ULL; }
    return h;
}

uint64_t hashBuffer(const ReadbackBuffer& b)
{
    assert(b.valid);
    uint64_t h = 1469598103934665603ULL;
    for (int y = 0; y < b.height; ++y)
        h = fnv(h, b.pixels.data() + static_cast<size_t>(y) * b.stride,
                static_cast<size_t>(b.width) * 4);
    return h;
}

// A source texture with structure (a four-band gradient), so a rect that moved
// by a pixel or a flipped UV changes the hash where a solid colour would not.
FrameCacheEntry makeBandedEntry(ID3D11Device* device, const Color& c, int w, int h)
{
    std::vector<uint8_t> pixels(static_cast<size_t>(w) * h * 4);
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            const int band = x * 4 / w;                 // 0..3 left to right
            const int lift = (y * 2 / h) * 24;          // darker top half
            const size_t i = (static_cast<size_t>(y) * w + x) * 4;
            pixels[i + 0] = static_cast<uint8_t>((c.b * (band + 2)) / 5 + lift / 3);
            pixels[i + 1] = static_cast<uint8_t>((c.g * (band + 2)) / 5 + lift / 3);
            pixels[i + 2] = static_cast<uint8_t>((c.r * (band + 2)) / 5 + lift / 3);
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
    HRESULT hr = device->CreateTexture2D(&desc, &init, &entry.texture);
    assert(SUCCEEDED(hr));
    hr = device->CreateShaderResourceView(entry.texture.Get(), nullptr, &entry.srv);
    assert(SUCCEEDED(hr));
    entry.width = w; entry.height = h;
    entry.memorySizeBytes = static_cast<size_t>(w) * h * 4;
    return entry;
}

VideoEvent makeEvent(int trackId, int sourceId, double startBeat, double durationBeats)
{
    VideoEvent ev{};
    ev.trackId         = trackId;
    ev.sourceId        = sourceId;
    ev.startBeat       = startBeat;
    ev.durationBeats   = durationBeats;
    ev.sourceStartTime = 0.0;
    ev.layerIndex      = 0;
    ev.x = 0; ev.y = 0; ev.width = 1; ev.height = 1;
    ev.opacity         = 1.0f;
    ev.globalNoteIndex = 0;
    return ev;
}

GridSlot slotAt(int trackId, int gx, int gy, int sx, int sy, float opacity = 1.0f, int z = 0)
{
    GridSlot s;
    s.trackId = trackId;
    s.gridX = gx; s.gridY = gy;
    s.spanX = sx; s.spanY = sy;
    s.opacity = opacity;
    s.zOrder = z;
    return s;
}

struct Project {
    Timeline tl{ kBpm, static_cast<double>(kSR) };
    std::vector<VideoEvent> evs;
    std::unordered_map<std::string, Color> colorByPath;
    int tracks[6] = {};

    Project()
    {
        const Color colors[6] = {
            {220, 40, 40, 255}, {40, 200, 60, 255}, {50, 80, 230, 255},
            {230, 200, 40, 255}, {200, 60, 200, 255}, {60, 210, 210, 255},
        };
        int sources[6] = {};
        for (int i = 0; i < 6; ++i) {
            SourceMedia src;
            src.filePath = "floor" + std::to_string(i) + ".mp4";
            src.hasVideo = true; src.fps = 30.0;
            src.duration = 120.0; src.totalFrames = 3600;
            src.width = 1920; src.height = 1080;
            sources[i] = tl.addSource(src);
            colorByPath[src.filePath] = colors[i];

            TrackInfo t;
            t.name = "T" + std::to_string(i);
            t.type = TrackInfo::Type::Pattern;
            tracks[i] = tl.addTrack(t);
        }

        // Per-track look the per-cell path reads.
        tl.getTrackMutable(tracks[1])->gapScaleOverride = 0.3f;
        tl.getTrackMutable(tracks[2])->cornerRadius = 0.2f;
        tl.getTrackMutable(tracks[3])->gapScaleOverride = 0.0f;
        tl.getTrackMutable(tracks[4])->videoHoldLastFrame = true;
        tl.getTrackMutable(tracks[4])->cornerRadius = 0.5f;

        // Base: 2x1, gap 0.1.
        const std::string baseId = tl.getActiveSnapshotId();
        GridLayout one = tl.getGridLayout();
        one.columns = 2; one.rows = 1; one.gapScale = 0.1f;
        one.slots = { slotAt(tracks[0], 0, 0, 8, 8), slotAt(tracks[1], 8, 0, 8, 8) };
        one.fullscreenLayers.clear();
        tl.setGridLayout(one);

        // Two: 4x4, gap 0.05, half- and quarter-cell spans, overlap by zOrder,
        // and a fullscreen layer behind the grid.
        const std::string twoId = tl.createGridSnapshot(false, "Two");
        GridLayout two = tl.getGridLayout();
        two.columns = 4; two.rows = 4; two.gapScale = 0.05f;
        two.slots = {
            slotAt(tracks[0], 0,  0,  8,  8),
            slotAt(tracks[1], 24, 0,  8,  8),
            slotAt(tracks[2], 8,  8,  16, 16, 0.9f, 1),
            slotAt(tracks[3], 0,  24, 4,  4),            // half a cell each way
            slotAt(tracks[4], 26, 26, 2,  6, 1.0f, 2),   // quarter-wide sliver
            slotAt(tracks[1], 12, 20, 8,  4, 0.6f, 3),   // a second cell for one track
        };
        two.fullscreenLayers.clear();
        tl.setGridLayout(two);
        FullscreenLayer backdrop;
        backdrop.trackId = tracks[5];
        backdrop.opacity = 0.5f;
        tl.setFullscreenLayers({ backdrop });

        // Three: 3x2, gap 0.5.
        const std::string threeId = tl.createGridSnapshot(false, "Three");
        GridLayout three = tl.getGridLayout();
        three.columns = 3; three.rows = 2; three.gapScale = 0.5f;
        three.slots = {
            slotAt(tracks[4], 0,  0, 8,  16),
            slotAt(tracks[2], 8,  0, 16, 8),
            slotAt(tracks[0], 8,  8, 8,  8),
            slotAt(tracks[3], 16, 8, 8,  8),
        };
        three.fullscreenLayers.clear();
        tl.setGridLayout(three);

        tl.setActiveGridSnapshot(baseId);

        // Cues: a Push into Two, a hard cut into Three, a crossfade back to Base.
        const TickTime cue1 = TickTime::fromBeats(4.0);
        const TickTime cue2 = TickTime::fromBeats(8.0);
        const TickTime cue3 = TickTime::fromBeats(12.0);
        tl.addGridCue(cue1, twoId);
        tl.addGridCue(cue2, threeId);
        tl.addGridCue(cue3, baseId);

        SnapshotTransition push;
        push.enabled = true;
        push.type = SnapshotTransition::Type::Push;
        push.startOffsetTicks = 960;
        push.endOffsetTicks = 480;
        push.geomAngleDeg = 90.0f;
        tl.setCueTransition(cue1, push);

        SnapshotTransition fade;
        fade.enabled = true;
        fade.type = SnapshotTransition::Type::Crossfade;
        fade.startOffsetTicks = 480;
        fade.endOffsetTicks = 960;
        fade.startToPinEasing = { 0.42f, 0.0f, 1.0f, 1.0f };
        tl.setCueTransition(cue3, fade);

        // Events: most tracks play throughout; track 3 plays short notes with
        // gaps; track 4 (Hold Last Frame) stops at beat 6 and holds through the
        // hard cut and into Three.
        for (int i = 0; i < 6; ++i) {
            if (i == 3) {
                for (int n = 0; n < 16; ++n)
                    evs.push_back(makeEvent(tracks[i], sources[i], n * 1.0, 0.5));
            } else if (i == 4) {
                evs.push_back(makeEvent(tracks[i], sources[i], 0.0, 6.0));
                evs.push_back(makeEvent(tracks[i], sources[i], 13.0, 3.0));
            } else {
                evs.push_back(makeEvent(tracks[i], sources[i], 0.0, 16.0));
            }
        }
    }
};

// One pass over the project: frames 0 .. just past beat 16, the ordinary
// per-frame sequence of both render seams as it was before Landings.
std::vector<uint64_t> renderPass(ID3D11Device* device, GridCompositor& compositor)
{
    Project p;
    FrameCollector collector;
    RenderFrameCache cache;
    const xleth::DecodeMissesFn decode = [&](const std::vector<FrameCacheKey>& misses) {
        for (const auto& k : misses) {
            auto it = p.colorByPath.find(k.sourcePath.str());
            assert(it != p.colorByPath.end());
            cache.put(k, makeBandedEntry(device, it->second, 32, 16));
        }
    };

    const int64_t endSample = RenderClock::ppqToSample(TickTime::fromBeats(16.5).ticks, kSR, kBpm);
    const int64_t lastFrame = RenderClock::sampleToVideoFrame(endSample, kSR, kFps);

    std::vector<uint64_t> hashes;
    for (int64_t f = 0; f <= lastFrame; ++f) {
        const int64_t S    = RenderClock::videoFrameToSample(f, kSR, kFps);
        const int64_t tick = RenderClock::sampleToPPQ(S, kSR, kBpm);

        const GridLayout layout = p.tl.gridLayoutAt(TickTime{ tick });
        auto& requests = collector.collectRequests(
            f, p.tl, kSR, kFps, p.evs, /*allowProxy=*/false, /*projectStartSample=*/0,
            /*posterMode=*/false, /*renderProxyBySource=*/nullptr, &layout);
        auto deduplicated = FrameCollector::deduplicateRequests(requests);
        auto misses       = FrameCollector::resolveFrames(deduplicated, cache);
        decode(misses);

        const Timeline::ResolvedTransition tx = p.tl.transitionAt(TickTime{ tick });
        bool didTransition = false;
        if (tx.active) {
            xleth::SnapshotTransitionFrameCtx ctx;
            ctx.sampleRate          = kSR;
            ctx.bpm                 = kBpm;
            ctx.fps                 = kFps;
            ctx.outputFrameIndex    = f;
            ctx.projectStartSample  = 0;
            ctx.allowProxy          = false;
            ctx.posterMode          = false;
            ctx.renderProxyBySource = nullptr;
            didTransition = xleth::renderSnapshotTransition(
                tx, p.tl, p.evs, compositor, collector, cache, ctx, decode);
        }
        if (!didTransition) {
            const float currentTime = static_cast<float>(RenderClock::sampleToSeconds(S, kSR));
            compositor.compositeFrame(requests, cache, layout.columns, layout.rows,
                                      currentTime, layout.gapScale);
        }
        hashes.push_back(hashBuffer(compositor.readback()));
    }
    return hashes;
}

} // namespace

int main(int argc, char** argv)
{
    GpuDeviceManager gpu;
    if (!gpu.detectAdapters() || !gpu.createDevice()) {
        std::fprintf(stderr, "[TEST:LandingFloor] UNAVAILABLE: no D3D11 device\n");
        return EXIT_FAILURE;
    }
    GridCompositor compositor;
    assert(compositor.init(gpu.getDevice(), gpu.getContext(), kW, kH));

    const std::vector<uint64_t> first  = renderPass(gpu.getDevice(), compositor);
    const std::vector<uint64_t> second = renderPass(gpu.getDevice(), compositor);
    assert(first.size() > 200 && "the pass covers the whole 16-beat project");
    assert(first == second && "the floor project must render the same twice");

    // Not every frame may be the same picture: the project has to exercise
    // something, or the digest proves nothing.
    size_t distinct = 0;
    for (size_t i = 1; i < first.size(); ++i)
        if (first[i] != first[i - 1]) ++distinct;
    assert(distinct > 40 && "the floor project must change from frame to frame");

    uint64_t digest = 1469598103934665603ULL;
    for (uint64_t h : first)
        digest = fnv(digest, reinterpret_cast<const uint8_t*>(&h), sizeof(h));

    if (argc > 1) {
        FILE* out = std::fopen(argv[1], "w");
        assert(out && "could not open the hash output file");
        for (size_t i = 0; i < first.size(); ++i)
            std::fprintf(out, "%zu %016llx\n", i, static_cast<unsigned long long>(first[i]));
        std::fclose(out);
    }

    compositor.shutdown();
    std::fprintf(stderr, "[TEST:LandingFloor] frames=%zu distinct-steps=%zu digest=%016llx\n",
                 first.size(), distinct, static_cast<unsigned long long>(digest));
    std::fprintf(stderr, "[TEST:LandingFloor] ALL TESTS PASSED\n");
    return EXIT_SUCCESS;
}
