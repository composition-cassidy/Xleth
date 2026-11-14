// test_landing_render.cpp — Landing on a real D3D11 device
// (docs/XLETH_LANDING_SPEC.md §9, P3).
//
// Extends the snapshot-transition determinism test's approach: solid-colour
// source textures, no decoder, one FrameCollector / GridCompositor, and the
// SAME helpers the two render seams call (LandingRenderer,
// renderSnapshotTransition). renderSeamFrame below is the per-frame sequence of
// XlethEngineService's video tick and of OfflineRenderer's frame loops, with
// the framing (frame index, project start sample) as its only variable.
//
//   [1] perf floor       no landings -> the frame today's code produces
//   [2] carry geometry   in flight: drawn once, at the evaluated rect, on top
//   [3] seam             at p == 1 the carried frame IS snapshot B's frame
//   [4] determinism      preview framing == export framing, frame for frame,
//                        over a hard cut, a crossfade and a Push
//   [5] transitions      a carried track is never split by a Push nor dimmed
//                        by a crossfade
//   [6] hold last frame  survives the frame's extra collects (audit D2)
//   [7] degenerate rects Grow at p == 0 and Edge before its start draw nothing
//   [8] fromOpacity      fades in while moving
//   [9] seek             a frame does not depend on the frames before it
//   [10] target cap      a landing that changes size does not strand a render
//                        target per frame (RTPool::beginPass)

#include "render/GridCompositor.h"
#include "render/GpuDeviceManager.h"
#include "render/FrameCollector.h"
#include "render/FrameCache.h"
#include "render/GridRectMath.h"
#include "render/LandingMath.h"
#include "render/LandingRenderer.h"
#include "render/RenderClock.h"
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

struct Color {
    uint8_t r, g, b, a;
};

constexpr Color kChords{ 220, 40, 40, 255 };
constexpr Color kBass  { 40, 200, 60, 255 };
constexpr Color kLead  { 50, 80, 230, 255 };
constexpr Color kPerc1 { 230, 200, 40, 255 };
constexpr Color kPerc2 { 200, 60, 200, 255 };
constexpr Color kEmpty { 0, 0, 0, 0 };

Color pixelAt(const ReadbackBuffer& buffer, int x, int y)
{
    assert(buffer.valid);
    x = std::clamp(x, 0, buffer.width - 1);
    y = std::clamp(y, 0, buffer.height - 1);
    const uint8_t* bgra = buffer.pixels.data()
        + static_cast<size_t>(y) * buffer.stride
        + static_cast<size_t>(x) * 4;
    return { bgra[2], bgra[1], bgra[0], bgra[3] };
}

bool colorNear(const Color& a, const Color& b, int tol)
{
    return std::abs(int(a.r) - int(b.r)) <= tol && std::abs(int(a.g) - int(b.g)) <= tol
        && std::abs(int(a.b) - int(b.b)) <= tol && std::abs(int(a.a) - int(b.a)) <= tol;
}

// The pixel at a canvas-UV point.
Color pixelAtUV(const ReadbackBuffer& buffer, float u, float v)
{
    return pixelAt(buffer, static_cast<int>(u * kW), static_cast<int>(v * kH));
}

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

// How many pixels are (near) a colour: "is this track visible anywhere".
int countColor(const ReadbackBuffer& b, const Color& c, int tol)
{
    int n = 0;
    for (int y = 0; y < b.height; ++y)
        for (int x = 0; x < b.width; ++x)
            if (colorNear(pixelAt(b, x, y), c, tol)) ++n;
    return n;
}

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

GridSlot slotAt(int trackId, int gx, int gy, int sx, int sy)
{
    GridSlot s;
    s.trackId = trackId;
    s.gridX = gx; s.gridY = gy;
    s.spanX = sx; s.spanY = sy;
    return s;
}

TrackLanding makeLanding(int trackId, TrackLanding::From from, int64_t leadIn)
{
    TrackLanding l;
    l.trackId = trackId;
    l.from = from;
    l.leadInTicks = leadIn;
    return l;
}

// The spec's reference scenario (§1), with one solid-colour source per track.
//   Snapshot 1 (Base): 2x1, gap 0.1. Chords left half, bass right half.
//   Snapshot 2:        4x4, gap 0.05. Chords top-left, bass top-right, lead big
//                      in the centre, two percussion cells at the bottom.
//   Cue at bar 9 -> snapshot 2.
struct Rig {
    ID3D11Device*   device;
    GridCompositor& compositor;

    Timeline tl{ kBpm, static_cast<double>(kSR) };
    int chords = -1, bass = -1, lead = -1, perc1 = -1, perc2 = -1;
    std::string baseId, twoId;
    TickTime pin{ 8 * 4 * 960 };   // bar 9

    std::vector<VideoEvent>              evs;
    std::unordered_map<std::string, Color> colorByPath;

    FrameCollector          collector;
    xleth::LandingRenderer  landing;
    RenderFrameCache        cache;
    xleth::DecodeMissesFn   decode;

    Rig(ID3D11Device* dev, GridCompositor& comp) : device(dev), compositor(comp)
    {
        const auto add = [&](const char* name, const Color& c) {
            SourceMedia src;
            src.filePath = std::string(name) + ".mp4";
            src.hasVideo = true; src.fps = 30.0;
            src.duration = 120.0; src.totalFrames = 3600;
            src.width = 1920; src.height = 1080;
            const int sid = tl.addSource(src);
            colorByPath[src.filePath] = c;

            TrackInfo t;
            t.name = name;
            t.type = TrackInfo::Type::Pattern;
            const int tid = tl.addTrack(t);
            // Active across the whole test range unless a test replaces evs.
            evs.push_back(makeEvent(tid, sid, 0.0, 64.0));
            return tid;
        };
        chords = add("chords", kChords);
        bass   = add("bass",   kBass);
        lead   = add("lead",   kLead);
        perc1  = add("perc1",  kPerc1);
        perc2  = add("perc2",  kPerc2);

        baseId = tl.getActiveSnapshotId();
        GridLayout one = tl.getGridLayout();
        one.columns = 2; one.rows = 1; one.gapScale = 0.1f;
        one.slots = { slotAt(chords, 0, 0, 8, 8), slotAt(bass, 8, 0, 8, 8) };
        one.fullscreenLayers.clear();
        tl.setGridLayout(one);

        twoId = tl.createGridSnapshot(false, "Two");
        GridLayout two = tl.getGridLayout();
        two.columns = 4; two.rows = 4; two.gapScale = 0.05f;
        two.slots = {
            slotAt(chords, 0,  0,  8,  8),
            slotAt(bass,   24, 0,  8,  8),
            slotAt(lead,   8,  8,  16, 16),
            slotAt(perc1,  0,  24, 8,  8),
            slotAt(perc2,  24, 24, 8,  8),
        };
        two.fullscreenLayers.clear();
        tl.setGridLayout(two);

        tl.setActiveGridSnapshot(baseId);
        tl.addGridCue(pin, twoId);

        decode = [this](const std::vector<FrameCacheKey>& misses) {
            for (const auto& k : misses) {
                auto it = colorByPath.find(k.sourcePath.str());
                assert(it != colorByPath.end() && "unexpected source path");
                cache.put(k, makeSolidEntry(device, it->second, 16, 16));
            }
        };
    }

    int64_t pinSample() const { return RenderClock::ppqToSample(pin.ticks, kSR, kBpm); }
    int64_t tickSample(int64_t tick) const { return RenderClock::ppqToSample(tick, kSR, kBpm); }

    // The acceptance landings: chords and bass WhereItWas over 1 beat, lead
    // Edge from the bottom over half a beat, percussion none.
    void setReferenceLandings(float chordsBassFromOpacity = 1.0f)
    {
        TrackLanding c = makeLanding(chords, TrackLanding::From::WhereItWas, 960);
        TrackLanding b = makeLanding(bass,   TrackLanding::From::WhereItWas, 960);
        c.fromOpacity = chordsBassFromOpacity;
        b.fromOpacity = chordsBassFromOpacity;
        TrackLanding l = makeLanding(lead, TrackLanding::From::Edge, 480);
        l.edgeAngleDeg = 270.0f;
        tl.setCueLandings(pin, { c, b, l });
    }

    void setTransition(SnapshotTransition::Type type, int64_t startOffset, int64_t endOffset)
    {
        SnapshotTransition tr;
        tr.enabled = true;
        tr.type = type;
        tr.startOffsetTicks = startOffset;
        tr.endOffsetTicks = endOffset;
        tr.geomAngleDeg = 0.0f;
        tl.setCueTransition(pin, tr);
    }
};

xleth::SnapshotTransitionFrameCtx makeCtx(int64_t frameIdx, int64_t projStart)
{
    xleth::SnapshotTransitionFrameCtx c;
    c.sampleRate          = kSR;
    c.bpm                 = kBpm;
    c.fps                 = kFps;
    c.outputFrameIndex    = frameIdx;
    c.projectStartSample  = projStart;
    c.allowProxy          = false;
    c.posterMode          = false;
    c.renderProxyBySource = nullptr;
    return c;
}

using Tweak = std::function<void(std::vector<CellFrameRequest>&)>;

// ONE output frame, the way both render seams produce it. `frameIdx` and
// `projStart` are the framing: a stopped-preview scrub is (0, S); an export
// from the project origin is (f, 0). `tweak` edits the frame's request list
// before it is decoded and composited (used to give a track a Roam).
ReadbackBuffer renderSeamFrame(Rig& r, int64_t frameIdx, int64_t projStart,
                               const Tweak& tweak = {})
{
    const int64_t S    = projStart + RenderClock::videoFrameToSample(frameIdx, kSR, kFps);
    const int64_t tick = RenderClock::sampleToPPQ(S, kSR, kBpm);

    GridLayout layout = r.tl.gridLayoutAt(TickTime{ tick });
    Timeline::ResolvedTransition tx = r.tl.transitionAt(TickTime{ tick });
    Timeline::ResolvedLandings landings;
    if (r.tl.hasCueLandings()) landings = r.tl.landingsAt(TickTime{ tick });
    xleth::LandingRenderer::beginFrame(landings, r.collector);

    const xleth::SnapshotTransitionFrameCtx ctx = makeCtx(frameIdx, projStart);
    std::vector<CellFrameRequest>* requests = nullptr;
    if (landings.count > 0 && !tx.active) {
        requests = &r.landing.collectFrame(landings, layout, r.tl, r.evs, r.collector, ctx);
    } else {
        requests = &r.collector.collectRequests(
            frameIdx, r.tl, kSR, kFps, r.evs, /*allowProxy=*/false, projStart,
            /*posterMode=*/false, /*renderProxyBySource=*/nullptr, &layout);
    }
    if (tweak) tweak(*requests);

    auto deduplicated = FrameCollector::deduplicateRequests(*requests);
    auto misses       = FrameCollector::resolveFrames(deduplicated, r.cache);
    r.decode(misses);

    bool didTransition = false;
    if (tx.active) {
        if (landings.count > 0) {
            xleth::LandingRenderer::stripLandingTracks(landings, tx.layoutA);
            xleth::LandingRenderer::stripLandingTracks(landings, tx.layoutB);
        }
        didTransition = xleth::renderSnapshotTransition(
            tx, r.tl, r.evs, r.compositor, r.collector, r.cache, ctx, r.decode);
        if (didTransition && landings.count > 0) {
            r.landing.renderCarryOverlay(landings, r.tl, r.evs, r.compositor,
                                         r.collector, r.cache, ctx, r.decode);
        }
    }
    if (!didTransition) {
        const float currentTime = static_cast<float>(RenderClock::sampleToSeconds(S, kSR));
        r.compositor.compositeFrame(*requests, r.cache, layout.columns, layout.rows,
                                    currentTime, layout.gapScale);
    }
    return r.compositor.readback();
}

// The same frame as the seams produced it BEFORE landings existed: no landing
// call of any kind. The perf floor compares against this.
ReadbackBuffer renderLegacyFrame(Rig& r, int64_t frameIdx, int64_t projStart)
{
    const int64_t S    = projStart + RenderClock::videoFrameToSample(frameIdx, kSR, kFps);
    const int64_t tick = RenderClock::sampleToPPQ(S, kSR, kBpm);

    const GridLayout layout = r.tl.gridLayoutAt(TickTime{ tick });
    auto& requests = r.collector.collectRequests(
        frameIdx, r.tl, kSR, kFps, r.evs, /*allowProxy=*/false, projStart,
        /*posterMode=*/false, /*renderProxyBySource=*/nullptr, &layout);
    auto deduplicated = FrameCollector::deduplicateRequests(requests);
    auto misses       = FrameCollector::resolveFrames(deduplicated, r.cache);
    r.decode(misses);

    const Timeline::ResolvedTransition tx = r.tl.transitionAt(TickTime{ tick });
    bool didTransition = false;
    if (tx.active) {
        didTransition = xleth::renderSnapshotTransition(
            tx, r.tl, r.evs, r.compositor, r.collector, r.cache,
            makeCtx(frameIdx, projStart), r.decode);
    }
    if (!didTransition) {
        const float currentTime = static_cast<float>(RenderClock::sampleToSeconds(S, kSR));
        r.compositor.compositeFrame(requests, r.cache, layout.columns, layout.rows,
                                    currentTime, layout.gapScale);
    }
    return r.compositor.readback();
}

int64_t frameOfSample(int64_t S) { return RenderClock::sampleToVideoFrame(S, kSR, kFps); }
int64_t sampleOfFrame(int64_t f) { return RenderClock::videoFrameToSample(f, kSR, kFps); }

// A landing track's evaluated pose at absolute sample S (resolved the way the
// renderer resolves it).
xleth::landing::Pose poseAt(Rig& r, int trackId, int64_t S)
{
    const int64_t tick = RenderClock::sampleToPPQ(S, kSR, kBpm);
    const Timeline::ResolvedLandings set = r.tl.landingsAt(TickTime{ tick });
    for (int i = 0; i < set.count; ++i) {
        if (set.items[i].trackId != trackId) continue;
        return xleth::landing::evaluateLanding(
            set.items[i], S, r.tickSample(set.items[i].startTick.ticks),
            r.tickSample(set.pinTick.ticks));
    }
    assert(false && "track has no resolved landing at this sample");
    return {};
}

void note(const char* msg) { std::fprintf(stderr, "[TEST:Landing] %s\n", msg); }

// ─── [1] perf floor ──────────────────────────────────────────────────────────

void testPerfFloor(ID3D11Device* device, GridCompositor& compositor)
{
    note("--- [1] perf floor: no landings -> today's frame ---");

    // Cues and a Push transition, no landings at all.
    Rig r(device, compositor);
    r.setTransition(SnapshotTransition::Type::Push, 960, 960);
    assert(!r.tl.hasCueLandings());

    const int64_t fPin = frameOfSample(r.pinSample());
    int compared = 0;
    for (int64_t f = fPin - 40; f <= fPin + 40; ++f) {
        const uint64_t seam   = hashBuffer(renderSeamFrame(r, f, 0));
        const uint64_t legacy = hashBuffer(renderLegacyFrame(r, f, 0));
        assert(seam == legacy && "a project without landings must render as before");
        assert(r.collector.holdKeepTrackCount() == 0 && r.collector.holdGcEnabled()
               && "no landing state may be left on the collector");
        ++compared;
    }
    assert(compared == 81);

    // Landings authored, but every frame OUTSIDE their window is still today's.
    r.setReferenceLandings();
    assert(r.tl.hasCueLandings());
    int outside = 0;
    for (int64_t f = fPin - 80; f <= fPin + 80; ++f) {
        const int64_t tick = RenderClock::sampleToPPQ(sampleOfFrame(f), kSR, kBpm);
        if (r.tl.landingsAt(TickTime{ tick }).count != 0) continue;
        const uint64_t seam   = hashBuffer(renderSeamFrame(r, f, 0));
        const uint64_t legacy = hashBuffer(renderLegacyFrame(r, f, 0));
        assert(seam == legacy && "outside a landing window the frame must be today's");
        ++outside;
    }
    assert(outside > 40 && "frames on both sides of the window were compared");
    note("[1] PASSED");
}

// ─── [2] carry geometry ──────────────────────────────────────────────────────

void testCarryGeometry(ID3D11Device* device, GridCompositor& compositor)
{
    note("--- [2] carry geometry (hard cut) ---");

    Rig r(device, compositor);
    r.setReferenceLandings();

    const int64_t pinS      = r.pinSample();
    const int64_t chordsS0  = r.tickSample(r.pin.ticks - 960);   // chords / bass start
    const int64_t leadS0    = r.tickSample(r.pin.ticks - 480);   // lead starts later

    // Before the window: snapshot A as it always was.
    {
        const ReadbackBuffer rb = renderSeamFrame(r, 0, chordsS0 - 4800);
        assert(colorNear(pixelAtUV(rb, 0.25f, 0.5f), kChords, 2) && "A: chords fill the left half");
        assert(colorNear(pixelAtUV(rb, 0.75f, 0.5f), kBass, 2) && "A: bass fills the right half");
        assert(countColor(rb, kLead, 2) == 0 && "A: the lead is not on screen");
    }

    // Chords / bass in flight, the lead not started yet (still off-canvas).
    {
        const int64_t S = chordsS0 + (leadS0 - chordsS0) / 2;
        const ReadbackBuffer rb = renderSeamFrame(r, 0, S);
        const auto pc = poseAt(r, r.chords, S);
        const auto pb = poseAt(r, r.bass, S);
        assert(pc.w > 0.0f && pc.h > 0.0f);
        assert(colorNear(pixelAtUV(rb, pc.x + pc.w * 0.5f, pc.y + pc.h * 0.5f), kChords, 2)
               && "chords are drawn at their in-flight rect");
        assert(colorNear(pixelAtUV(rb, pb.x + pb.w * 0.5f, pb.y + pb.h * 0.5f), kBass, 2)
               && "bass is drawn at its in-flight rect");
        // The in-flight rect is strictly between A's and B's.
        float ax, ay, aw, ah, bx, by, bw, bh;
        xleth::slotCanvasRect(0, 0, 8, 8, 2, 1, 0.1f, ax, ay, aw, ah);
        xleth::slotCanvasRect(0, 0, 8, 8, 4, 4, 0.05f, bx, by, bw, bh);
        assert(pc.w < aw && pc.w > bw && pc.h < ah && pc.h > bh
               && "chords are between where they were and where they land");
        // Drawn ONCE: the part of A's chords cell the move has left is empty.
        assert(colorNear(pixelAtUV(rb, ax + aw * 0.05f, ay + ah * 0.95f), kEmpty, 2)
               && "chords were removed from snapshot A's composite");
        assert(colorNear(pixelAtUV(rb, 0.95f, 0.9f), kEmpty, 2)
               && "bass was removed from snapshot A's composite");
        assert(countColor(rb, kLead, 2) == 0
               && "a landing that has not started is carried off-canvas (Edge)");
        assert(countColor(rb, kPerc1, 2) == 0 && countColor(rb, kPerc2, 2) == 0
               && "percussion has no landing and is not drawn before the cut");
    }

    // The lead rising from below.
    {
        const int64_t S = leadS0 + (pinS - leadS0) / 6;     // early in its (ease-out) move
        const ReadbackBuffer rb = renderSeamFrame(r, 0, S);
        const auto pl = poseAt(r, r.lead, S);
        float lx, ly, lw, lh;
        xleth::slotCanvasRect(8, 8, 16, 16, 4, 4, 0.05f, lx, ly, lw, lh);
        assert(pl.y > ly && pl.y < 1.0f && "the lead is below its slot, on its way up");
        assert(pl.x == lx && pl.w == lw && pl.h == lh && "Edge 270 is a pure vertical move");
        const float visibleMidV = (pl.y + std::min(1.0f, pl.y + pl.h)) * 0.5f;
        assert(colorNear(pixelAtUV(rb, pl.x + pl.w * 0.5f, visibleMidV), kLead, 2)
               && "the lead is drawn at its in-flight rect");
        assert(!colorNear(pixelAtUV(rb, pl.x + pl.w * 0.5f, pl.y - 0.03f), kLead, 2)
               && "nothing of the lead is drawn above its in-flight rect");
    }

    // The frame at the pin is plain snapshot B, percussion included.
    {
        const ReadbackBuffer rb = renderSeamFrame(r, 0, pinS);
        assert(r.tl.landingsAt(r.pin).count == 0);
        assert(colorNear(pixelAtUV(rb, 0.5f, 0.5f), kLead, 2) && "B: lead in the centre");
        assert(colorNear(pixelAtUV(rb, 0.125f, 0.125f), kChords, 2) && "B: chords top-left");
        assert(colorNear(pixelAtUV(rb, 0.875f, 0.125f), kBass, 2) && "B: bass top-right");
        assert(colorNear(pixelAtUV(rb, 0.125f, 0.875f), kPerc1, 2) && "B: perc 1 appears on the downbeat");
        assert(colorNear(pixelAtUV(rb, 0.875f, 0.875f), kPerc2, 2) && "B: perc 2 appears on the downbeat");
    }
    note("[2] PASSED");
}

// ─── [3] the seam ────────────────────────────────────────────────────────────

// Render the frame at the pin sample with the landing tracks CARRIED at p == 1
// (the landings resolved a tick before the pin, evaluated at the pin), next to
// the frame snapshot B draws there by itself. They must be the same picture.
void assertSeam(Rig& r, const Tweak& tweak, const char* what)
{
    const int64_t pinS = r.pinSample();

    const ReadbackBuffer normal = renderSeamFrame(r, 0, pinS, tweak);
    const uint64_t hashB = hashBuffer(normal);

    const Timeline::ResolvedLandings landings =
        r.tl.landingsAt(TickTime{ r.pin.ticks - 1 });
    assert(landings.count > 0);
    const GridLayout layoutB = r.tl.gridLayoutAt(r.pin);
    xleth::LandingRenderer::beginFrame(landings, r.collector);
    auto& requests = r.landing.collectFrame(landings, layoutB, r.tl, r.evs, r.collector,
                                            makeCtx(0, pinS));
    int carried = 0;
    for (const auto& q : requests) {
        if (!q.hasCanvasRect) continue;
        ++carried;
        // The override rect is B's drawn rect for that slot, bit for bit.
        const GridSlot* slot = nullptr;
        for (const auto& s : layoutB.slots) if (s.trackId == q.trackId) slot = &s;
        assert(slot);
        float bx, by, bw, bh;
        xleth::slotCanvasRect(slot->gridX, slot->gridY, slot->spanX, slot->spanY,
                              layoutB.columns, layoutB.rows,
                              xleth::effectiveSlotGap(layoutB.gapScale, q.gapScaleOverride),
                              bx, by, bw, bh);
        assert(q.canvasRect[0] == bx && q.canvasRect[1] == by
               && q.canvasRect[2] == bw && q.canvasRect[3] == bh
               && "at p == 1 the carried rect equals B's drawn rect exactly");
    }
    assert(carried == landings.count && "every landing track is carried");
    if (tweak) tweak(requests);
    auto deduplicated = FrameCollector::deduplicateRequests(requests);
    auto misses       = FrameCollector::resolveFrames(deduplicated, r.cache);
    r.decode(misses);
    r.compositor.compositeFrame(requests, r.cache, layoutB.columns, layoutB.rows,
                                static_cast<float>(RenderClock::sampleToSeconds(pinS, kSR)),
                                layoutB.gapScale);
    const uint64_t hashCarried = hashBuffer(r.compositor.readback());
    xleth::LandingRenderer::beginFrame(Timeline::ResolvedLandings{}, r.collector);

    if (hashCarried != hashB) {
        std::fprintf(stderr, "[TEST:Landing] seam mismatch (%s): carried %llu != B %llu\n",
                     what, (unsigned long long)hashCarried, (unsigned long long)hashB);
        assert(false && "the last landing frame must be pixel-identical to snapshot B");
    }
    std::fprintf(stderr, "[TEST:Landing] seam pixel-identical: %s\n", what);
}

void testSeam(ID3D11Device* device, GridCompositor& compositor)
{
    note("--- [3] seam: carried at p == 1 == snapshot B ---");

    {
        Rig r(device, compositor);
        r.setReferenceLandings();
        assertSeam(r, {}, "reference scenario");
    }
    {
        // Every track landing, one with its own gap, from every kind of start.
        Rig r(device, compositor);
        r.tl.getTrackMutable(r.bass)->gapScaleOverride = 0.3f;
        r.tl.getTrackMutable(r.perc2)->gapScaleOverride = 0.0f;
        TrackLanding custom = makeLanding(r.perc1, TrackLanding::From::Custom, 1440);
        custom.customX = 0.4f; custom.customY = 0.1f; custom.customW = 0.33f; custom.customH = 0.27f;
        r.tl.setCueLandings(r.pin, {
            makeLanding(r.chords, TrackLanding::From::WhereItWas, 960),
            makeLanding(r.bass, TrackLanding::From::WhereItWas, 960),
            makeLanding(r.lead, TrackLanding::From::Grow, 480),
            custom,
            makeLanding(r.perc2, TrackLanding::From::Edge, 240),
        });
        assertSeam(r, {}, "all five tracks, per-track gap overrides");
    }
    {
        // A track that also roams: its offset is measured in the placement
        // BEFORE the gap, so the carried request must carry that unit (D3).
        Rig r(device, compositor);
        r.setReferenceLandings();
        const int chords = r.chords, lead = r.lead;
        const Tweak roam = [chords, lead](std::vector<CellFrameRequest>& reqs) {
            for (auto& q : reqs) {
                if (q.trackId == chords) {
                    // Small enough that the floated cell overlaps no other.
                    q.roam.offsetX = 0.3f;
                    q.roam.offsetY = 0.05f;
                    q.roam.bounds  = RoamBounds::Float;
                }
                if (q.trackId == lead) {
                    q.roam.offsetX = -0.2f;
                    q.roam.bounds  = RoamBounds::Clip;     // scissor to the home rect
                }
            }
        };
        assertSeam(r, roam, "Roam offset (Float) and Roam Bounds Clip on carried tracks");

        // Sensitivity: the Roam really moved pixels.
        const uint64_t withRoam    = hashBuffer(renderSeamFrame(r, 0, r.pinSample(), roam));
        const uint64_t withoutRoam = hashBuffer(renderSeamFrame(r, 0, r.pinSample()));
        assert(withRoam != withoutRoam && "the Roam tweak must be visible");
    }
    {
        // Per-note bounce applies after the home rect, as for any grid cell.
        Rig r(device, compositor);
        r.setReferenceLandings();
        const int bass = r.bass;
        const Tweak bounce = [bass](std::vector<CellFrameRequest>& reqs) {
            for (auto& q : reqs) {
                if (q.trackId != bass) continue;
                q.bounceOffsetY = -0.1f;
                q.bounceScaleX  = 0.8f;
                q.cornerRadius  = 0.2f;
            }
        };
        assertSeam(r, bounce, "bounce and corner radius on a carried track");
    }
    note("[3] PASSED");
}

// ─── [4] determinism ─────────────────────────────────────────────────────────

void testDeterminism(ID3D11Device* device, GridCompositor& compositor)
{
    note("--- [4] determinism: preview framing == export framing ---");

    struct Config {
        const char*              name;
        bool                     transition;
        SnapshotTransition::Type type;
    };
    const Config configs[] = {
        { "hard cut",  false, SnapshotTransition::Type::Crossfade },
        { "crossfade", true,  SnapshotTransition::Type::Crossfade },
        { "push",      true,  SnapshotTransition::Type::Push },
    };

    for (const Config& cfg : configs) {
        Rig r(device, compositor);
        r.setReferenceLandings(0.7f);
        if (cfg.transition) r.setTransition(cfg.type, 960, 960);

        const int64_t pinS   = r.pinSample();
        const int64_t startS = r.tickSample(r.pin.ticks - 960);
        const int64_t endS   = r.tickSample(r.pin.ticks + (cfg.transition ? 960 : 0));

        // The frames the spec names, as frame indices.
        const int64_t named[] = {
            frameOfSample(startS),                           // startTick
            frameOfSample(startS + (pinS - startS) / 2),     // mid lead-in
            frameOfSample(pinS) - 1,                         // the last frame before the pin
            frameOfSample(pinS),                             // the pin
            frameOfSample(pinS + (endS - pinS) / 2),         // inside the transition window
        };

        int landingOnly = 0, landingInTransition = 0, compared = 0;
        const int64_t fLo = frameOfSample(startS) - 3;
        const int64_t fHi = frameOfSample(endS) + 3;
        for (int64_t f = fLo; f <= fHi; ++f) {
            const int64_t S    = sampleOfFrame(f);
            const int64_t tick = RenderClock::sampleToPPQ(S, kSR, kBpm);
            const bool hasLandings = r.tl.landingsAt(TickTime{ tick }).count > 0;
            const bool inTransition = r.tl.transitionAt(TickTime{ tick }).active;

            // PREVIEW framing: stopped scrub to absolute sample S.
            const uint64_t hP = hashBuffer(renderSeamFrame(r, /*frameIdx=*/0, /*projStart=*/S));
            // EXPORT framing: frame f of an export from the project origin.
            const uint64_t hE = hashBuffer(renderSeamFrame(r, /*frameIdx=*/f, /*projStart=*/0));
            if (hP != hE) {
                std::fprintf(stderr,
                    "[TEST:Landing] %s frame %lld: preview %llu != export %llu\n",
                    cfg.name, (long long)f, (unsigned long long)hP, (unsigned long long)hE);
                assert(false && "preview and export must be frame-exact");
            }
            ++compared;
            if (hasLandings && !inTransition) ++landingOnly;
            if (hasLandings && inTransition)  ++landingInTransition;
        }
        for (int64_t f : named)
            assert(f >= fLo && f <= fHi && "every named frame was inside the compared range");
        assert(landingOnly > 0 || cfg.transition);
        if (cfg.transition)
            assert(landingInTransition > 4 && "carried frames inside the transition window were compared");
        else
            assert(landingOnly > 8 && "carried frames in the lead-in were compared");
        std::fprintf(stderr,
            "[TEST:Landing] %s: preview==export over %d frames "
            "(%d landing-only, %d landing inside the transition)\n",
            cfg.name, compared, landingOnly, landingInTransition);
    }

    // A transition that starts AFTER the lead-in does, so one run crosses
    // landing-only frames, then landing + transition, then the carry phase.
    {
        Rig r(device, compositor);
        r.setReferenceLandings();
        r.setTransition(SnapshotTransition::Type::Push, 240, 480);
        const int64_t fLo = frameOfSample(r.tickSample(r.pin.ticks - 960)) - 2;
        const int64_t fHi = frameOfSample(r.tickSample(r.pin.ticks + 480)) + 2;
        int landingOnly = 0, landingInTransition = 0;
        for (int64_t f = fLo; f <= fHi; ++f) {
            const int64_t S    = sampleOfFrame(f);
            const int64_t tick = RenderClock::sampleToPPQ(S, kSR, kBpm);
            const bool hasLandings  = r.tl.landingsAt(TickTime{ tick }).count > 0;
            const bool inTransition = r.tl.transitionAt(TickTime{ tick }).active;
            const uint64_t hP = hashBuffer(renderSeamFrame(r, 0, S));
            const uint64_t hE = hashBuffer(renderSeamFrame(r, f, 0));
            assert(hP == hE && "preview and export must be frame-exact (asymmetric push)");
            if (hasLandings && !inTransition) ++landingOnly;
            if (hasLandings && inTransition)  ++landingInTransition;
        }
        assert(landingOnly > 2 && landingInTransition > 2);
    }
    note("[4] PASSED");
}

// ─── [5] carried through a transition ────────────────────────────────────────

void testTransitions(ID3D11Device* device, GridCompositor& compositor)
{
    note("--- [5] a carried track is not split by a Push nor dimmed by a crossfade ---");

    float lx, ly, lw, lh;
    xleth::slotCanvasRect(8, 8, 16, 16, 4, 4, 0.05f, lx, ly, lw, lh);
    // Points well inside the lead's B cell: the centre and near each corner.
    const float pts[5][2] = {
        { lx + lw * 0.5f,  ly + lh * 0.5f },
        { lx + lw * 0.08f, ly + lh * 0.08f }, { lx + lw * 0.92f, ly + lh * 0.08f },
        { lx + lw * 0.08f, ly + lh * 0.92f }, { lx + lw * 0.92f, ly + lh * 0.92f },
    };

    for (const auto type : { SnapshotTransition::Type::Push, SnapshotTransition::Type::Crossfade,
                             SnapshotTransition::Type::Slide }) {
        Rig carried(device, compositor);
        carried.setReferenceLandings();
        carried.setTransition(type, 960, 960);

        Rig plain(device, compositor);            // same project, no landings
        plain.setTransition(type, 960, 960);

        const int64_t pinS = carried.pinSample();
        const int64_t endS = carried.tickSample(carried.pin.ticks + 960);
        int checkedFrames = 0, plainDiffers = 0;
        // From the pin to the end of the window the lead has landed: it must
        // sit, whole and at full strength, exactly in its B cell.
        for (int64_t f = frameOfSample(pinS); sampleOfFrame(f) < endS; ++f) {
            const int64_t S = sampleOfFrame(f);
            if (S < pinS) continue;
            const ReadbackBuffer rb    = renderSeamFrame(carried, 0, S);
            const ReadbackBuffer plainRb = renderSeamFrame(plain, 0, S);
            for (const auto& p : pts) {
                const Color c = pixelAtUV(rb, p[0], p[1]);
                if (!colorNear(c, kLead, 2)) {
                    std::fprintf(stderr,
                        "[TEST:Landing] frame %lld: lead pixel (%.3f,%.3f) = (%u,%u,%u,%u)\n",
                        (long long)f, p[0], p[1], c.r, c.g, c.b, c.a);
                    assert(false && "the carried lead must be whole and undimmed");
                }
                if (!colorNear(pixelAtUV(plainRb, p[0], p[1]), kLead, 2)) ++plainDiffers;
            }
            // Chords and bass too: landed in their B cells, at full strength.
            assert(colorNear(pixelAtUV(rb, 0.125f, 0.125f), kChords, 2));
            assert(colorNear(pixelAtUV(rb, 0.875f, 0.125f), kBass, 2));
            // The blend is still underneath: the carry is drawn OVER the
            // transition's frame, it does not replace it. Percussion has no
            // landing, so any of its colour on screen came from the blend.
            // (Mid-crossfade it is at partial strength, so this counts any
            // drawn pixel that is not one of the three carried tracks.)
            int underneath = 0;
            for (int y = 0; y < rb.height; ++y) {
                for (int x = 0; x < rb.width; ++x) {
                    const Color c = pixelAt(rb, x, y);
                    if (c.a == 0) continue;
                    if (colorNear(c, kChords, 2) || colorNear(c, kBass, 2) || colorNear(c, kLead, 2))
                        continue;
                    ++underneath;
                }
            }
            assert(underneath > 200
                   && "the transition's own frame must survive under the carried tracks");
            ++checkedFrames;
        }
        assert(checkedFrames > 4);
        // Sensitivity: without landings the same pixels are NOT all the lead.
        assert(plainDiffers > 0 && "without a landing the transition splits or dims the lead");

        // Before the pin, inside the transition window: the lead is still on
        // its way, drawn once, over the blend.
        const int64_t S = carried.tickSample(carried.pin.ticks - 120);
        const ReadbackBuffer rb = renderSeamFrame(carried, 0, S);
        const auto pl = poseAt(carried, carried.lead, S);
        const float visibleMidV = (pl.y + std::min(1.0f, pl.y + pl.h)) * 0.5f;
        assert(colorNear(pixelAtUV(rb, pl.x + pl.w * 0.5f, visibleMidV), kLead, 2)
               && "inside the window, before the pin, the lead is carried at its in-flight rect");
    }

    // At carryEndTick the carry is released and the frame is plain B: the same
    // picture as the last carried frame's landed tracks.
    {
        Rig r(device, compositor);
        r.setReferenceLandings();
        r.setTransition(SnapshotTransition::Type::Crossfade, 960, 960);
        const int64_t endS = r.tickSample(r.pin.ticks + 960);
        const ReadbackBuffer rb = renderSeamFrame(r, 0, endS);
        assert(r.tl.landingsAt(TickTime{ r.pin.ticks + 960 }).count == 0);
        assert(colorNear(pixelAtUV(rb, 0.5f, 0.5f), kLead, 2));
        assert(colorNear(pixelAtUV(rb, 0.125f, 0.875f), kPerc1, 2));
        const ReadbackBuffer before = renderSeamFrame(r, 0, endS - 1600);
        assert(colorNear(pixelAtUV(before, 0.5f, 0.5f), kLead, 2)
               && "no pop where the carry is released");
    }
    note("[5] PASSED");
}

// ─── [6] hold last frame ─────────────────────────────────────────────────────

void testHoldLastFrame(ID3D11Device* device, GridCompositor& compositor)
{
    note("--- [6] hold last frame survives the carry's extra collects ---");

    // Bass lands (WhereItWas) and chords do not. Both have Hold Last Frame and
    // both stop playing two beats before the pin, so through the whole lead-in
    // each is a gap filled by its held frame.
    for (const bool withTransition : { false, true }) {
        Rig r(device, compositor);
        r.tl.getTrackMutable(r.bass)->videoHoldLastFrame = true;
        r.tl.getTrackMutable(r.chords)->videoHoldLastFrame = true;
        const double pinBeat = static_cast<double>(r.pin.ticks) / 960.0;
        for (auto& ev : r.evs) {
            if (ev.trackId == r.bass || ev.trackId == r.chords) {
                ev.startBeat = 0.0;
                ev.durationBeats = pinBeat - 2.0;
            }
        }
        r.tl.setCueLandings(r.pin, { makeLanding(r.bass, TrackLanding::From::WhereItWas, 960) });
        if (withTransition) r.setTransition(SnapshotTransition::Type::Crossfade, 1920, 0);

        // Play forward from before the notes end to the pin, like a transport.
        const int64_t fFrom = frameOfSample(r.tickSample(r.pin.ticks - 3 * 960));
        const int64_t fPin  = frameOfSample(r.pinSample());
        int heldLanding = 0, heldOther = 0;
        for (int64_t f = fFrom; f < fPin; ++f) {
            const int64_t S    = sampleOfFrame(f);
            const int64_t tick = RenderClock::sampleToPPQ(S, kSR, kBpm);
            const ReadbackBuffer rb = renderSeamFrame(r, f, 0);
            const bool inGap = tick > r.pin.ticks - 2 * 960 + 10;
            if (!inGap || r.tl.landingsAt(TickTime{ tick }).count == 0) continue;

            // The landing track: held frame, drawn at the in-flight rect.
            const auto pb = poseAt(r, r.bass, S);
            const Color atBass = pixelAtUV(rb, pb.x + pb.w * 0.5f, pb.y + pb.h * 0.5f);
            if (!colorNear(atBass, kBass, 2)) {
                std::fprintf(stderr,
                    "[TEST:Landing] frame %lld (transition=%d): bass pixel = (%u,%u,%u,%u)\n",
                    (long long)f, int(withTransition), atBass.r, atBass.g, atBass.b, atBass.a);
                assert(false && "a landing track must keep its held frame while it is carried");
            }
            ++heldLanding;

            // The other track: held frame, still in snapshot A's cell. The
            // probe is a point no cell of snapshot B covers. (With the
            // crossfade A is fading out — it is at 50% or more until the pin —
            // so there its strength is bounded rather than matched.)
            const Color atChords = pixelAtUV(rb, 0.1f, 0.5f);
            const bool chordsThere = withTransition
                ? (atChords.r > 90 && atChords.r > atChords.g + 60 && atChords.r > atChords.b + 60)
                : colorNear(atChords, kChords, 2);
            if (!chordsThere) {
                std::fprintf(stderr,
                    "[TEST:Landing] frame %lld (transition=%d): chords pixel = (%u,%u,%u,%u)\n",
                    (long long)f, int(withTransition), atChords.r, atChords.g, atChords.b, atChords.a);
                assert(false && "a track that is not landing must keep its held frame too");
            }
            ++heldOther;
        }
        assert(heldLanding > 6 && heldOther > 6 && "the lead-in was checked frame by frame");

        // After the window the guards are released on the next frame.
        renderSeamFrame(r, fPin + 40, 0);
        assert(r.collector.holdKeepTrackCount() == 0 && r.collector.holdGcEnabled()
               && "the collector's hold guards are released after the window");
    }
    note("[6] PASSED");
}

// ─── [7] degenerate rects ────────────────────────────────────────────────────

void testDegenerateRects(ID3D11Device* device, GridCompositor& compositor)
{
    note("--- [7] Grow at p == 0, Edge before its start ---");

    {
        Rig r(device, compositor);
        r.tl.setCueLandings(r.pin, { makeLanding(r.lead, TrackLanding::From::Grow, 960) });
        const int64_t startS = r.tickSample(r.pin.ticks - 960);
        const ReadbackBuffer rb = renderSeamFrame(r, 0, startS);
        const auto p = poseAt(r, r.lead, startS);
        assert(p.w == 0.0f && p.h == 0.0f && "Grow starts with no area");
        assert(countColor(rb, kLead, 2) == 0 && "a zero-size landing rect draws nothing");
        assert(colorNear(pixelAtUV(rb, 0.25f, 0.5f), kChords, 2) && "the rest of the frame is intact");

        // And grows from the destination centre.
        const int64_t S = startS + (r.pinSample() - startS) / 8;
        const ReadbackBuffer grown = renderSeamFrame(r, 0, S);
        assert(colorNear(pixelAtUV(grown, 0.5f, 0.5f), kLead, 2) && "Grow opens at the destination centre");
        assert(countColor(grown, kLead, 2) > 0);
    }
    {
        Rig r(device, compositor);
        for (const float angle : { 0.0f, 90.0f, 180.0f, 270.0f, 45.0f }) {
            TrackLanding l = makeLanding(r.lead, TrackLanding::From::Edge, 960);
            l.edgeAngleDeg = angle;
            r.tl.setCueLandings(r.pin, { l });
            const int64_t startS = r.tickSample(r.pin.ticks - 960);
            const ReadbackBuffer rb = renderSeamFrame(r, 0, startS);
            assert(countColor(rb, kLead, 2) == 0 && "Edge starts fully off the canvas");
            const ReadbackBuffer mid = renderSeamFrame(r, 0, startS + (r.pinSample() - startS) / 2);
            assert(countColor(mid, kLead, 2) > 0 && "and is on its way in by the middle of the lead-in");
        }
    }
    note("[7] PASSED");
}

// ─── [8] fromOpacity ─────────────────────────────────────────────────────────

void testFromOpacity(ID3D11Device* device, GridCompositor& compositor)
{
    note("--- [8] fromOpacity ---");

    Rig r(device, compositor);
    TrackLanding l = makeLanding(r.lead, TrackLanding::From::Custom, 960);
    l.customX = 0.3f; l.customY = 0.3f; l.customW = 0.4f; l.customH = 0.4f;
    l.fromOpacity = 0.5f;
    l.easing = SnapshotTransitionEasingCurve{};      // Linear
    r.tl.setCueLandings(r.pin, { l });
    // Empty the centre of snapshot A so the lead is blended over nothing.
    r.tl.setActiveGridSnapshot(r.baseId);
    GridLayout one = r.tl.getGridLayout();
    one.slots.clear();
    r.tl.setGridLayout(one);

    const int64_t startS = r.tickSample(r.pin.ticks - 960);
    const int64_t pinS   = r.pinSample();

    const Color atStart = pixelAtUV(renderSeamFrame(r, 0, startS), 0.5f, 0.5f);
    assert(std::abs(int(atStart.a) - 128) <= 3 && "at its start the landing is at fromOpacity");
    assert(std::abs(int(atStart.b) - kLead.b / 2) <= 3);

    const Color atMid = pixelAtUV(renderSeamFrame(r, 0, startS + (pinS - startS) / 2), 0.5f, 0.5f);
    assert(std::abs(int(atMid.a) - 191) <= 4 && "halfway (Linear) it is halfway to full");

    const Color nearEnd = pixelAtUV(renderSeamFrame(r, 0, pinS - 8), 0.5f, 0.5f);
    assert(nearEnd.a >= 250 && "it arrives at full opacity");

    // A landing that starts fully transparent is not drawn at all on that frame.
    l.fromOpacity = 0.0f;
    r.tl.setCueLandings(r.pin, { l });
    assert(pixelAtUV(renderSeamFrame(r, 0, startS), 0.5f, 0.5f).a == 0
           && "fromOpacity 0 starts invisible");
    note("[8] PASSED");
}

// ─── [9] seek ────────────────────────────────────────────────────────────────

void testSeek(ID3D11Device* device, GridCompositor& compositor)
{
    note("--- [9] seeking into a lead-in lands mid-move ---");

    for (const bool withTransition : { false, true }) {
        const auto build = [&](Rig& r) {
            r.setReferenceLandings(0.7f);
            if (withTransition) r.setTransition(SnapshotTransition::Type::Push, 480, 960);
        };

        Rig fresh(device, compositor);
        build(fresh);
        const int64_t startS = fresh.tickSample(fresh.pin.ticks - 960);
        const int64_t endS   = fresh.tickSample(fresh.pin.ticks + (withTransition ? 960 : 0));

        std::vector<int64_t> samples;
        for (int i = 0; i <= 12; ++i) samples.push_back(startS + (endS - startS) * i / 12);

        // Each frame rendered FIRST on its own rig: a cold seek.
        std::vector<uint64_t> cold;
        for (int64_t S : samples) {
            Rig r(device, compositor);
            build(r);
            cold.push_back(hashBuffer(renderSeamFrame(r, 0, S)));
        }
        // The same frames on one rig, played backwards, then forwards.
        Rig played(device, compositor);
        build(played);
        for (size_t i = samples.size(); i-- > 0; )
            assert(hashBuffer(renderSeamFrame(played, 0, samples[i])) == cold[i]
                   && "a frame must not depend on the frames rendered before it (backwards)");
        for (size_t i = 0; i < samples.size(); ++i)
            assert(hashBuffer(renderSeamFrame(played, 0, samples[i])) == cold[i]
                   && "a frame must not depend on the frames rendered before it (forwards)");
        // And the move really is in progress across them.
        assert(cold.front() != cold[samples.size() / 2] && cold[samples.size() / 2] != cold.back());
    }
    note("[9] PASSED");
}

// ─── [10] render-target cap ──────────────────────────────────────────────────

void testTargetCap(ID3D11Device* device, GridCompositor& compositor)
{
    note("--- [10] a size-changing landing does not strand a render target per frame ---");

    // Lens fit Cover is the default for new content and runs a framing pass
    // into a target sized from the cell, so it is the stage every track pays.
    const Tweak cover = [](std::vector<CellFrameRequest>& reqs) {
        for (auto& q : reqs) q.lens.fit = LensFit::Cover;
    };

    for (const bool withTransition : { false, true }) {
        Rig r(device, compositor);
        // Chords and bass shrink from a half screen to a small cell over four
        // bars, Linear: a different pixel size on every frame.
        TrackLanding c = makeLanding(r.chords, TrackLanding::From::WhereItWas, 960 * 16);
        TrackLanding b = makeLanding(r.bass,   TrackLanding::From::WhereItWas, 960 * 16);
        c.easing = SnapshotTransitionEasingCurve{};
        b.easing = SnapshotTransitionEasingCurve{};
        r.tl.setCueLandings(r.pin, { c, b });
        if (withTransition) r.setTransition(SnapshotTransition::Type::Crossfade, 960 * 16, 960);
        // A track effect too: its chain target is sized from the cell as well,
        // and unlike the Lens tweak it also reaches the carry that is drawn
        // over a transition (those requests are collected inside the helper).
        for (const int trackId : { r.chords, r.bass }) {
            VisualEffect neutral;
            neutral.type = VisualEffect::Type::BrightnessContrast;
            neutral.params[0] = 0.0f;   // brightness
            neutral.params[1] = 1.0f;   // contrast
            r.tl.getTrackMutable(trackId)->visualEffectChain.push_back(neutral);
        }

        const int64_t fStart = frameOfSample(r.tickSample(r.pin.ticks - 960 * 16)) + 1;
        const int64_t fPin   = frameOfSample(r.pinSample());
        assert(fPin - fStart > 150 && "the lead-in spans a few hundred frames");

        // Settle: a few ordinary frames first, so the pool holds only what an
        // ordinary frame needs.
        for (int64_t f = fStart - 6; f < fStart - 1; ++f) renderSeamFrame(r, f, 0, cover);
        const size_t before = compositor.renderTargetPairCount();

        size_t peak = 0;
        int distinctSizes = 0, lastW = -1;
        for (int64_t f = fStart; f < fPin; ++f) {
            renderSeamFrame(r, f, 0, cover);
            peak = std::max(peak, compositor.renderTargetPairCount());
            const auto pose = poseAt(r, r.chords, sampleOfFrame(f));
            const int w = static_cast<int>(pose.w * kW);
            if (w != lastW) { ++distinctSizes; lastW = w; }
        }
        std::fprintf(stderr,
            "[TEST:Landing] transition=%d: %lld landing frames, %d distinct cell widths, "
            "pool %zu pairs before, peak %zu\n",
            int(withTransition), (long long)(fPin - fStart), distinctSizes, before, peak);
        assert(distinctSizes > 40 && "the move really passes through many sizes");
        // Two landing tracks x one stage x the few passes a transient pair is
        // kept, on top of what an ordinary frame holds. Without the cap the
        // pool would hold one pair per distinct size.
        assert(peak <= before + 24 && "passing sizes must be released after a few passes");
        assert(peak < static_cast<size_t>(distinctSizes) && "the pool must not grow with the move");

        // Still the right picture, and still B's picture at the pin.
        const ReadbackBuffer mid = renderSeamFrame(r, (fStart + fPin) / 2, 0, cover);
        const auto pc = poseAt(r, r.chords, sampleOfFrame((fStart + fPin) / 2));
        const Color midChords = pixelAtUV(mid, pc.x + pc.w * 0.5f, pc.y + pc.h * 0.5f);
        assert(midChords.r > 150 && midChords.g < 90 && midChords.b < 90
               && "chords are still drawn, through their effect, at the in-flight rect");
        if (!withTransition) assertSeam(r, cover, "Lens Cover on every track, after a long size-changing move");

        // After the window the pool returns to an ordinary frame's needs.
        for (int64_t f = fPin + 40; f < fPin + 50; ++f) renderSeamFrame(r, f, 0, cover);
        assert(compositor.renderTargetPairCount() <= before + 8
               && "nothing a landing passed through is left behind");
    }
    note("[10] PASSED");
}

} // namespace

int main()
{
    note("Starting GPU landing test");

    GpuDeviceManager gpu;
    if (!gpu.detectAdapters()) {
        note("UNAVAILABLE: no DXGI adapter");
        return EXIT_FAILURE;
    }
    if (!gpu.createDevice()) {
        note("UNAVAILABLE: D3D11 device creation failed");
        return EXIT_FAILURE;
    }
    ID3D11Device* device = gpu.getDevice();
    ID3D11DeviceContext* context = gpu.getContext();
    assert(device && context);

    GridCompositor compositor;
    assert(compositor.init(device, context, kW, kH));

    testPerfFloor(device, compositor);
    testCarryGeometry(device, compositor);
    testSeam(device, compositor);
    testDeterminism(device, compositor);
    testTransitions(device, compositor);
    testHoldLastFrame(device, compositor);
    testDegenerateRects(device, compositor);
    testFromOpacity(device, compositor);
    testSeek(device, compositor);
    testTargetCap(device, compositor);

    compositor.shutdown();
    note("ALL TESTS PASSED");
    return EXIT_SUCCESS;
}
