// test_lens_roam_verify.cpp — Lens + Roam P12 verification (docs/XLETH_LENS_ROAM_VERIFY.md).
//
// Part A: live preview == export, byte for byte, per feature:
//   static Lens, Roam Float, Roam Clip, hit curve (Squash), hit curve (Cut),
//   Nudge + Own notes, Sweep. The preview renders the LIVE timeline at 30 fps
//   through its collector call (allowProxy, layout override, preview mute);
//   the export renders a FROZEN copy (its own events + snapshot) at 60 fps from
//   a 1 s subrange start. Every 30 fps frame shares its project sample with an
//   export frame; each pair must composite to identical bytes. Each scenario
//   must also differ from the same timeline rendered with no snapshot
//   (identity), so a scenario that silently renders nothing cannot pass, and a
//   fresh collector that SEEKS straight to a mid-note frame must match too.
//
// Part B: allocation. collectRequests + compositeFrame on the stress project
//   with the snapshot vs without it: the Lens/Roam path must add 0 heap
//   allocations per frame.
//
// Part C: performance, 8x8 grid, 32 Pattern tracks, 2,000 notes, every track
//   with a keyed hit curve, Nudge/Own notes, Roam keys and Sweep keys.
//   Reports: snapshot build time (message thread, under syncEventsMutex),
//   collect time, compositeFrame CPU time and GPU completion time, with and
//   without Lens/Roam; and VRAM growth with animated vs constant Roam scale
//   (the Lens pass target is sized from the post-Roam rect).
//   Timing is REPORTED, not asserted (machine-dependent); allocation and
//   parity are asserted.

#include "render/AnimationManager.h"
#include "render/GridCompositor.h"
#include "render/MotionBlur.h"
#include "render/GpuDeviceManager.h"
#include "render/FrameCache.h"
#include "render/FrameCollector.h"
#include "render/RenderClock.h"
#include "render/VideoEventBuilder.h"
#include "model/LensRoam.h"
#include "model/Timeline.h"
#include "model/TimelineSnapshot.h"
#include "model/TimelineTypes.h"

#include <dxgi1_4.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <memory>
#include <new>
#include <string>
#include <unordered_map>
#include <vector>

#undef NDEBUG
#include <cassert>

// ── Heap allocation counter (whole process; read around single calls) ────────
static std::atomic<long long> g_allocs{ 0 };
void* operator new(std::size_t n) {
    g_allocs.fetch_add(1, std::memory_order_relaxed);
    if (void* p = std::malloc(n ? n : 1)) return p;
    throw std::bad_alloc();
}
void* operator new[](std::size_t n) {
    g_allocs.fetch_add(1, std::memory_order_relaxed);
    if (void* p = std::malloc(n ? n : 1)) return p;
    throw std::bad_alloc();
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete[](void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
void operator delete[](void* p, std::size_t) noexcept { std::free(p); }

static ID3D11Device*        g_device    = nullptr;
static ID3D11DeviceContext* g_deviceCtx = nullptr;
static int g_fail = 0;

#define CHECK(cond, msg) do { if (!(cond)) { ++g_fail; \
    std::fprintf(stderr, "[VERIFY] FAIL: %s  (%s:%d)\n", msg, __FILE__, __LINE__); } } while (0)

using xleth::keycurve::Interp;
using xleth::keycurve::ShortNoteRule;
using Clock = std::chrono::steady_clock;

static double msSince(Clock::time_point t0) {
    return std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
}

static FrameCacheEntry makeGradientTexture(int w, int h) {
    std::vector<uint8_t> pixels(static_cast<size_t>(w) * h * 4);
    for (int y = 0; y < h; ++y)
        for (int x = 0; x < w; ++x) {
            const size_t i = (static_cast<size_t>(y) * w + x) * 4;
            pixels[i + 0] = static_cast<uint8_t>((x * 255) / (w - 1));
            pixels[i + 1] = static_cast<uint8_t>((y * 255) / (h - 1));
            pixels[i + 2] = static_cast<uint8_t>(((x + y) * 255) / (w + h - 2));
            pixels[i + 3] = 255;
        }
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = static_cast<UINT>(w); desc.Height = static_cast<UINT>(h);
    desc.MipLevels = 1; desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA init = {};
    init.pSysMem = pixels.data();
    init.SysMemPitch = static_cast<UINT>(w * 4);
    FrameCacheEntry e;
    HRESULT hr = g_device->CreateTexture2D(&desc, &init, &e.texture);
    assert(SUCCEEDED(hr));
    hr = g_device->CreateShaderResourceView(e.texture.Get(), nullptr, &e.srv);
    assert(SUCCEEDED(hr));
    e.width = w; e.height = h;
    e.memorySizeBytes = 64;   // shared texture: keep the cache from evicting
    return e;
}

static LensKey lk(LensChannel ch, KeyAnchor a, double pos, double v, Interp i = Interp::Linear) {
    LensKey k; k.channel = ch; k.anchor = a; k.pos = pos; k.value = v; k.interp = i; return k;
}
static RoamKey rk(RoamChannel ch, double pos, double v, Interp i = Interp::Linear) {
    RoamKey k; k.channel = ch; k.pos = pos; k.value = v; k.interp = i; return k;
}
// Motion view (docs/XLETH_MOTION_VIEW_DESIGN.md): mask keys and masks.
static MaskKey mkk(MaskChannel ch, double pos, double v, Interp i = Interp::Linear) {
    MaskKey k; k.channel = ch; k.anchor = KeyAnchor::Origin; k.pos = pos; k.value = v; k.interp = i;
    return k;
}
// An ellipse whose feather and shape are keyed (radii morph between two shape
// keys), plus a small rectangle cut out of it.
static std::vector<RoamMask> animatedMasks(double t0, double t1) {
    RoamMask e;
    e.id = 1; e.name = "Mask 1"; e.kind = MaskKind::Ellipse;
    e.base.shape = lensroam::ellipseMaskShape(0.4, 0.35);
    e.keys = { mkk(MaskChannel::Feather, t0, 0.0), mkk(MaskChannel::Feather, t1, 0.15),
               mkk(MaskChannel::Expansion, t0, 0.05), mkk(MaskChannel::Expansion, t1, -0.05, Interp::EaseOut) };
    MaskShapeKey a; a.pos = t0; a.vertices = lensroam::ellipseMaskShape(0.4, 0.35).vertices;
    MaskShapeKey b; b.pos = t1; b.vertices = lensroam::ellipseMaskShape(0.22, 0.45).vertices;
    e.shapeKeys = { a, b };
    RoamMask r;
    r.id = 2; r.name = "Mask 2"; r.kind = MaskKind::Rectangle;
    r.base.shape = lensroam::rectangleMaskShape(0.1, 0.12);
    r.base.mode = MaskMode::Subtract;
    r.keys = { mkk(MaskChannel::Opacity, t0, 1.0), mkk(MaskChannel::Opacity, t1, 0.3) };
    return { e, r };
}
static LensNoteOverridePtr makeOverride(LensOverrideMode m, std::vector<LensKey> keys) {
    auto o = std::make_shared<LensNoteOverride>();
    o->mode = m; o->keys = std::move(keys);
    return o;
}
// Spec preset "Punch + drift" plus a body rotation, so Head, Body and Tail all move.
static std::vector<LensKey> punchDrift() {
    return { lk(LensChannel::Zoom, KeyAnchor::Head, 0, 1.35, Interp::EaseOut),
             lk(LensChannel::Zoom, KeyAnchor::Head, 120, 1.08),
             lk(LensChannel::Zoom, KeyAnchor::Tail, 240, 1.20),
             lk(LensChannel::Zoom, KeyAnchor::Tail, 0, 1.00),
             lk(LensChannel::RotationDeg, KeyAnchor::Body, 0.0, 0.0),
             lk(LensChannel::RotationDeg, KeyAnchor::Body, 1.0, 8.0) };
}

static unsigned long long fnv(const std::vector<uint8_t>& v) {
    uint64_t h = 1469598103934665603ull;
    for (uint8_t c : v) { h ^= c; h *= 1099511628211ull; }
    return static_cast<unsigned long long>(h);
}

// ── Shared fixture: one source/region, a Clip track and a Pattern track ──────
struct Fixture {
    Timeline tl{ 140.0, 48000.0 };
    int regId = -1, clipTrack = -1, patTrack = -1, patId = -1, clipId = -1;
    std::vector<int> noteIds;
};

static void buildFixture(Fixture& f, const std::vector<std::pair<int64_t, int64_t>>& notes) {
    SourceMedia src;
    src.filePath = "verify_src.mp4"; src.hasVideo = true;
    src.fps = 30.0; src.duration = 60.0; src.totalFrames = 1800;
    src.width = 1920; src.height = 1080;
    const int srcId = f.tl.addSource(src);
    SampleRegion reg;
    reg.sourceId = srcId; reg.startTime = 0.0; reg.endTime = 10.0;
    reg.startFrame = 0; reg.endFrame = 299;
    f.regId = f.tl.addRegion(reg);

    TrackInfo ct; ct.name = "Clips"; ct.type = TrackInfo::Type::Clip;
    f.clipTrack = f.tl.addTrack(ct);
    TrackInfo pt; pt.name = "Pattern"; pt.type = TrackInfo::Type::Pattern;
    f.patTrack = f.tl.addTrack(pt);

    Clip c;
    c.trackId = f.clipTrack; c.regionId = f.regId;
    c.position = TickTime{ 0 }; c.duration = TickTime::fromBeats(8);
    c.lens = LensTrack{};                                   // Stretch (old-project identity)
    f.clipId = f.tl.addClip(c);

    Pattern pat;
    pat.name = "P"; pat.regionId = f.regId; pat.length = TickTime::fromBeats(8);
    f.patId = f.tl.addPattern(pat);
    for (const auto& n : notes) {
        PatternNote pn;
        pn.position = TickTime{ n.first }; pn.duration = TickTime{ n.second };
        f.noteIds.push_back(f.tl.addNoteToPattern(f.patId, pn));
    }
    PatternBlock blk;
    blk.trackId = f.patTrack; blk.patternId = f.patId;
    blk.position = TickTime{ 0 }; blk.duration = TickTime::fromBeats(8);
    f.tl.addPatternBlock(blk);
    f.tl.getTrackMutable(f.patTrack)->trackLens[f.regId] = LensTrack{};   // Stretch source

    GridLayout layout;
    layout.columns = 3; layout.rows = 2;
    layout.slots.push_back({ f.clipTrack, 0, 0, kGridSubUnitsPerColumn, kGridSubUnitsPerRow, 1.0f, 0 });
    layout.slots.push_back({ f.patTrack, kGridSubUnitsPerColumn, kGridSubUnitsPerRow / 2,
                             kGridSubUnitsPerColumn, kGridSubUnitsPerRow, 1.0f, 1 });
    f.tl.setGridLayout(layout);
}

static Clip* clipOf(Fixture& f) { return f.tl.getClipMutable(f.clipId); }

// ── Part A: one scenario's preview/export parity ─────────────────────────────
struct ParityResult { int frames = 0, changed = 0, vsIdentity = 0; bool seekOk = false; };

static ParityResult runParity(const char* name, Fixture& f, RenderFrameCache& cache,
                              const std::vector<int64_t>& seekTicks) {
    Timeline& tl = f.tl;
    const auto liveEvents = xleth::videoevents::build(tl, 140.0, 48000.0);
    const auto liveSnap   = buildLensRoamSnapshot(tl);
    const FrozenTimelineCopy frozen = makeFrozenTimelineCopy(tl);
    const Timeline& ex = *frozen.timeline;
    const auto exEvents = xleth::videoevents::build(ex, 140.0, 48000.0);
    const auto exSnap   = buildLensRoamSnapshot(ex);
    const std::unordered_map<int, std::string> plan;

    auto fill = [&](const std::vector<CellFrameRequest>& reqs) {
        for (const auto& r : reqs) {
            FrameCacheKey k; k.sourcePath = r.sourcePath; k.frameIndex = r.sourceFrameIndex;
            if (!cache.get(k)) cache.put(k, makeGradientTexture(64, 36));
        }
    };
    GridCompositor comp;
    assert(comp.init(g_device, g_deviceCtx, 384, 192));
    const GridLayout liveLayout = tl.gridLayoutAt(TickTime{ 0 });
    auto composite = [&](const std::vector<CellFrameRequest>& reqs, const GridLayout& l) {
        fill(reqs);
        comp.compositeFrame(reqs, cache, l.columns, l.rows, 0.0f, l.gapScale);
        ReadbackBuffer b = comp.readback();
        assert(b.valid);
        return b.pixels;
    };

    FrameCollector preview, exporter, identity;
    preview.setLensRoamSnapshot(liveSnap);
    exporter.setLensRoamSnapshot(exSnap);              // identity: no snapshot
    const AVRational pfps{ 30, 1 }, efps{ 60, 1 };
    const int64_t exportStart = 48000;
    ParityResult r;
    std::vector<uint8_t> prev;
    for (int64_t p = 30; p <= 110; ++p) {              // beats 2.33 .. 8.0
        const std::vector<CellFrameRequest> lr = preview.collectRequests(
            p, tl, 48000, pfps, liveEvents.events, true, 0, false, nullptr, &liveLayout, true);
        const std::vector<uint8_t> a = composite(lr, liveLayout);
        const std::vector<CellFrameRequest> er = exporter.collectRequests(
            2 * (p - 30), ex, 48000, efps, exEvents.events, false, exportStart, false, &plan);
        const std::vector<uint8_t> b = composite(er, ex.getGridLayout());
        CHECK(a == b, name);
        const std::vector<CellFrameRequest> ir = identity.collectRequests(
            p, tl, 48000, pfps, liveEvents.events, true, 0, false, nullptr, &liveLayout, true);
        if (composite(ir, liveLayout) != a) ++r.vsIdentity;
        if (!prev.empty() && prev != a) ++r.changed;
        prev = a;
        ++r.frames;
    }
    // Seek: fresh collectors land straight on a frame inside each listed tick.
    r.seekOk = true;
    for (int64_t want : seekTicks) {
        int64_t frame = -1;
        for (int64_t p = 30; p <= 110 && frame < 0; ++p)
            if (RenderClock::sampleToPPQ(p * 1600, 48000, 140.0) >= want) frame = p;
        assert(frame >= 0);
        FrameCollector s1, s2;
        s1.setLensRoamSnapshot(liveSnap);
        s2.setLensRoamSnapshot(exSnap);
        const std::vector<CellFrameRequest> sr = s1.collectRequests(
            frame, tl, 48000, pfps, liveEvents.events, true, 0, false, nullptr, &liveLayout, true);
        const std::vector<uint8_t> sp = composite(sr, liveLayout);
        const std::vector<CellFrameRequest> se = s2.collectRequests(
            2 * (frame - 30), ex, 48000, efps, exEvents.events, false, exportStart, false, &plan);
        if (sp != composite(se, ex.getGridLayout())) r.seekOk = false;
        // and the sequential preview at that frame
        FrameCollector seq;
        seq.setLensRoamSnapshot(liveSnap);
        std::vector<uint8_t> last;
        for (int64_t p = 30; p <= frame; ++p) {
            const std::vector<CellFrameRequest> q = seq.collectRequests(
                p, tl, 48000, pfps, liveEvents.events, true, 0, false, nullptr, &liveLayout, true);
            if (p == frame) last = composite(q, liveLayout);
        }
        if (last != sp) r.seekOk = false;
    }
    CHECK(r.seekOk, name);
    CHECK(r.vsIdentity > 0, name);
    std::fprintf(stderr, "[VERIFY] A %-22s frames=%d identical-to-export=%s changed=%d differs-from-identity=%d seek=%s\n",
                 name, r.frames, g_fail ? "?" : "yes", r.changed, r.vsIdentity, r.seekOk ? "ok" : "FAIL");
    comp.shutdown();
    return r;
}

static const std::vector<std::pair<int64_t, int64_t>> kNotes = {
    { 2400, 960 },    // long
    { 3600, 180 },    // shorter than head+tail (360): Squash / Cut differ
    { 4000, 60 },     // shorter than the tail alone
    { 4800, 1440 },   // long
    { 6600, 600 },    // after a gap
};

static void partA(RenderFrameCache& cache) {
    std::fprintf(stderr, "\n[VERIFY] ── Part A: live vs export parity ──\n");
    const int failBefore = g_fail;

    {   // 1. static Lens (no keys): Cover/zoom/centre/rotation/flip on a clip, Contain on a source.
        Fixture f; buildFixture(f, kNotes);
        Clip* c = clipOf(f); assert(c);
        c->lens.base.fit = LensFit::Cover; c->lens.base.zoom = 1.4f;
        c->lens.base.centerX = 0.3f; c->lens.base.centerY = 0.6f;
        c->lens.base.rotationDeg = 12.0f; c->lens.base.flip = LensFlip::Horizontal;
        LensTrack& s = f.tl.getTrackMutable(f.patTrack)->trackLens[f.regId];
        s.base.fit = LensFit::Contain; s.base.zoom = 0.8f; s.base.rotationDeg = -20.0f;
        s.base.flip = LensFlip::Vertical;
        runParity("static Lens", f, cache, { 2500, 5000 });
    }
    {   // 2. Roam Float (keys on every channel, layer Top).
        Fixture f; buildFixture(f, kNotes);
        TrackInfo* t = f.tl.getTrackMutable(f.clipTrack);
        t->roam.base.bounds = RoamBounds::Float; t->roam.base.layer = RoamLayer::Top;
        t->roam.keys = { rk(RoamChannel::OffsetX, 0, -0.3), rk(RoamChannel::OffsetX, 7680, 0.8),
                         rk(RoamChannel::OffsetY, 1920, 0.0), rk(RoamChannel::OffsetY, 5760, 0.6, Interp::EaseOut),
                         rk(RoamChannel::Scale, 0, 0.7), rk(RoamChannel::Scale, 7680, 1.3),
                         rk(RoamChannel::RotationDeg, 0, 0.0), rk(RoamChannel::RotationDeg, 7680, 35.0) };
        runParity("Roam Float", f, cache, { 3000, 6000 });
    }
    {   // 3. Roam Clip (static move + rotation, clipped to the home rect).
        Fixture f; buildFixture(f, kNotes);
        TrackInfo* t = f.tl.getTrackMutable(f.patTrack);
        t->roam.base.bounds = RoamBounds::Clip;
        t->roam.base.offsetX = -0.4f; t->roam.base.scale = 1.25f; t->roam.base.rotationDeg = -10.0f;
        t->roam.keys = { rk(RoamChannel::OffsetY, 0, 0.3), rk(RoamChannel::OffsetY, 7680, -0.3, Interp::Hold) };
        runParity("Roam Clip", f, cache, { 2500, 5000 });
    }
    {   // 4. hit curve, Squash.
        Fixture f; buildFixture(f, kNotes);
        LensTrack& s = f.tl.getTrackMutable(f.patTrack)->trackLens[f.regId];
        s.keys = punchDrift(); s.zones.rule = ShortNoteRule::Squash;
        runParity("hit curve Squash", f, cache, { 2450, 3650, 4020, 4850 });
    }
    {   // 5. hit curve, Cut.
        Fixture f; buildFixture(f, kNotes);
        LensTrack& s = f.tl.getTrackMutable(f.patTrack)->trackLens[f.regId];
        s.keys = punchDrift(); s.zones.rule = ShortNoteRule::Cut;
        runParity("hit curve Cut", f, cache, { 2450, 3650, 4020, 4850 });
    }
    {   // 6. Nudge + Own notes (Follow, Nudge, Own, Nudge-without-keys, Own).
        Fixture f; buildFixture(f, kNotes);
        LensTrack& s = f.tl.getTrackMutable(f.patTrack)->trackLens[f.regId];
        s.base.fit = LensFit::Cover;
        s.keys = punchDrift();
        Pattern* p = f.tl.getPatternMutable(f.patId);
        const std::vector<LensKey> nudge = { lk(LensChannel::CenterX, KeyAnchor::Head, 0, 0.2),
                                             lk(LensChannel::CenterX, KeyAnchor::Tail, 0, -0.1) };
        const std::vector<LensKey> own = { lk(LensChannel::Zoom, KeyAnchor::Head, 0, 2.0),
                                           lk(LensChannel::Zoom, KeyAnchor::Body, 1.0, 1.1),
                                           lk(LensChannel::RotationDeg, KeyAnchor::Tail, 0, -15.0) };
        for (auto& n : p->notes) {
            if (n.id == f.noteIds[1]) n.lensOverride = makeOverride(LensOverrideMode::Nudge, nudge);
            if (n.id == f.noteIds[2]) n.lensOverride = makeOverride(LensOverrideMode::Own, own);
            if (n.id == f.noteIds[3]) n.lensOverride = makeOverride(LensOverrideMode::Nudge, nudge);
            if (n.id == f.noteIds[4]) n.lensOverride = makeOverride(LensOverrideMode::Own, own);
        }
        const auto c = buildLensRoamSnapshot(f.tl)->counts();
        CHECK(c.noteNudge == 2 && c.noteOwn == 2, "Nudge/Own: overrides compiled");
        runParity("Nudge + Own", f, cache, { 2450, 3650, 4010, 4900, 6700 });
    }
    {   // 7. Sweep across notes and the gap between them.
        Fixture f; buildFixture(f, kNotes);
        TrackInfo* t = f.tl.getTrackMutable(f.patTrack);
        t->trackLens[f.regId].keys = punchDrift();
        t->sweep.keys = { lk(LensChannel::Zoom, KeyAnchor::Origin, 2400, 1.0),
                          lk(LensChannel::Zoom, KeyAnchor::Origin, 4800, 1.6, Interp::EaseOut),
                          lk(LensChannel::Zoom, KeyAnchor::Origin, 7200, 1.0),
                          lk(LensChannel::CenterX, KeyAnchor::Origin, 2400, -0.2),
                          lk(LensChannel::CenterX, KeyAnchor::Origin, 7200, 0.2) };
        runParity("Sweep", f, cache, { 2500, 4900, 6700 });
    }
    {   // 8. Motion view: animated masks on a child whose parent moves, scales
        //    and turns; the child's own Roam is Clip, so its carried home is a
        //    turned rect clipped in the Mask pass (R9). The parent is masked too.
        Fixture f; buildFixture(f, kNotes);
        TrackInfo* p = f.tl.getTrackMutable(f.clipTrack);
        p->roam.base.bounds = RoamBounds::Float;
        p->roam.keys = { rk(RoamChannel::OffsetX, 0, 0.0), rk(RoamChannel::OffsetX, 7680, 0.6),
                         rk(RoamChannel::Scale, 0, 0.8), rk(RoamChannel::Scale, 7680, 1.2, Interp::EaseOut),
                         rk(RoamChannel::RotationDeg, 0, 0.0), rk(RoamChannel::RotationDeg, 7680, 25.0) };
        RoamMask pm; pm.id = 1; pm.name = "Mask 1"; pm.kind = MaskKind::Rectangle;
        pm.base.shape = lensroam::rectangleMaskShape(0.45, 0.4); pm.base.feather = 0.05;
        p->roam.masks = { pm };
        TrackInfo* c = f.tl.getTrackMutable(f.patTrack);
        c->parentTrackId = f.clipTrack;
        c->roam.base.bounds = RoamBounds::Clip;
        c->roam.base.offsetX = 0.2f;
        c->roam.keys = { rk(RoamChannel::OffsetY, 2400, -0.2), rk(RoamChannel::OffsetY, 6600, 0.2) };
        c->roam.masks = animatedMasks(2400, 6600);
        const auto counts = buildLensRoamSnapshot(f.tl)->counts();
        CHECK(counts.maskTracks == 2 && counts.masks == 3 && counts.parentedTracks == 1,
              "Masks + parent: compiled into the snapshot");
        runParity("Masks + moving parent", f, cache, { 2500, 4900, 6700 });
    }
    {   // 9. Motion view: a parent that only moves (no rotation): the child's
        //    Bounds Clip is the scissor on the carried home; the child Floats
        //    its masks over nothing else.
        Fixture f; buildFixture(f, kNotes);
        TrackInfo* p = f.tl.getTrackMutable(f.patTrack);
        p->roam.base.bounds = RoamBounds::Float;
        p->roam.keys = { rk(RoamChannel::OffsetX, 2400, -0.5), rk(RoamChannel::OffsetX, 7200, 0.3),
                         rk(RoamChannel::OffsetY, 2400, 0.2), rk(RoamChannel::OffsetY, 7200, -0.4, Interp::EaseOut) };
        TrackInfo* c = f.tl.getTrackMutable(f.clipTrack);
        c->parentTrackId = f.patTrack;
        c->roam.base.bounds = RoamBounds::Clip;
        c->roam.base.offsetX = 0.3f; c->roam.base.scale = 1.2f;
        c->roam.masks = animatedMasks(3000, 6000);
        runParity("Parent moves, child Clip", f, cache, { 2500, 4900, 6700 });
    }
    std::fprintf(stderr, "[VERIFY] Part A: %s\n", g_fail == failBefore ? "PASSED" : "FAILED");
}

// ── Stress project: 8x8, 32 Pattern tracks, 2,000 notes, everything keyed ───
struct Stress {
    Timeline tl{ 140.0, 48000.0 };
    std::vector<int> tracks;
};

// motionView: every track also carries two animated masks, and tracks form
// Parent chains of up to 3 ancestors (i % 4 == 1..3 parented to track i - 1).
static void buildStress(Stress& s, bool animateRoamScale, bool motionView = false) {
    const int kTracks = 32, kTotalNotes = 2000;
    const int64_t bar = 3840, span = 32 * bar;        // 32 bars
    GridLayout layout;
    layout.columns = 8; layout.rows = 8;
    int notesLeft = kTotalNotes;
    for (int i = 0; i < kTracks; ++i) {
        SourceMedia src;
        src.filePath = "stress_src_" + std::to_string(i) + ".mp4"; src.hasVideo = true;
        src.fps = 30.0; src.duration = 120.0; src.totalFrames = 3600;
        src.width = 1920; src.height = 1080;
        const int srcId = s.tl.addSource(src);
        SampleRegion reg;
        reg.sourceId = srcId; reg.startTime = 0.0; reg.endTime = 60.0;
        reg.startFrame = 0; reg.endFrame = 1799;
        const int regId = s.tl.addRegion(reg);

        TrackInfo t; t.name = "S" + std::to_string(i); t.type = TrackInfo::Type::Pattern;
        const int trackId = s.tl.addTrack(t);
        s.tracks.push_back(trackId);

        Pattern pat; pat.name = "P" + std::to_string(i); pat.regionId = regId;
        pat.length = TickTime{ span };
        const int patId = s.tl.addPattern(pat);
        const int n = notesLeft / (kTracks - i);
        notesLeft -= n;
        const int64_t step = span / n;
        for (int k = 0; k < n; ++k) {
            PatternNote pn;
            pn.position = TickTime{ k * step + (i * 37) % 120 };
            // 60 .. ~2 steps: short notes (Squash/Cut) and overlaps.
            const int64_t lens[] = { 60, 180, 400, step, step + step / 2, 2 * step };
            pn.duration = TickTime{ lens[(k + i) % 6] };
            pn.velocity = 0.6f + 0.4f * ((k % 5) / 4.0f);
            if (k % 3 == 1)
                pn.lensOverride = makeOverride(LensOverrideMode::Nudge,
                    { lk(LensChannel::CenterX, KeyAnchor::Head, 0, 0.1),
                      lk(LensChannel::CenterX, KeyAnchor::Tail, 0, -0.1) });
            else if (k % 5 == 2)
                pn.lensOverride = makeOverride(LensOverrideMode::Own,
                    { lk(LensChannel::Zoom, KeyAnchor::Head, 0, 1.8),
                      lk(LensChannel::Zoom, KeyAnchor::Body, 1.0, 1.1),
                      lk(LensChannel::RotationDeg, KeyAnchor::Tail, 0, -10.0) });
            s.tl.addNoteToPattern(patId, pn);
        }
        PatternBlock blk;
        blk.trackId = trackId; blk.patternId = patId;
        blk.position = TickTime{ 0 }; blk.duration = TickTime{ span };
        s.tl.addPatternBlock(blk);

        TrackInfo* tm = s.tl.getTrackMutable(trackId);
        LensTrack src_lens;
        src_lens.base.fit = (i % 3 == 0) ? LensFit::Contain : LensFit::Cover;
        src_lens.base.zoom = 1.1f;
        src_lens.keys = punchDrift();
        src_lens.zones.rule = (i % 2) ? ShortNoteRule::Cut : ShortNoteRule::Squash;
        tm->trackLens[regId] = src_lens;

        tm->roam.base.bounds = (i % 4 == 0) ? RoamBounds::Float : RoamBounds::Clip;
        tm->roam.base.layer  = (i % 8 == 0) ? RoamLayer::Top
                             : (i % 4 == 0) ? RoamLayer::AboveNeighbours : RoamLayer::GridOrder;
        tm->roam.base.scale = 0.9f;
        for (int b = 0; b <= 32; b += 4) {
            const double ph = (b / 4 + i) % 2 ? 1.0 : -1.0;
            tm->roam.keys.push_back(rk(RoamChannel::OffsetX, b * bar, 0.15 * ph));
            tm->roam.keys.push_back(rk(RoamChannel::OffsetY, b * bar, -0.1 * ph, Interp::EaseOut));
            tm->roam.keys.push_back(rk(RoamChannel::RotationDeg, b * bar, 6.0 * ph));
            if (animateRoamScale)
                tm->roam.keys.push_back(rk(RoamChannel::Scale, b * bar, ph > 0 ? 1.1 : 0.8));
        }
        for (int b = 0; b <= 32; b += 2) {
            tm->sweep.keys.push_back(lk(LensChannel::Zoom, KeyAnchor::Origin, b * bar, (b / 2) % 2 ? 1.3 : 1.0));
            tm->sweep.keys.push_back(lk(LensChannel::CenterX, KeyAnchor::Origin, b * bar, (b / 2) % 2 ? 0.05 : -0.05));
        }
        if (motionView) {
            tm->roam.masks = animatedMasks(0.0, static_cast<double>(span));
            if (i % 4 != 0) tm->parentTrackId = s.tracks[static_cast<size_t>(i - 1)];
        }
        const int cx = i % 8, cy = (i / 8) * 2 + (i % 2);
        layout.slots.push_back({ trackId, cx * kGridSubUnitsPerColumn, cy * kGridSubUnitsPerRow,
                                 kGridSubUnitsPerColumn, kGridSubUnitsPerRow, 1.0f, i });
    }
    s.tl.setGridLayout(layout);
}

static uint64_t vramUsage() {
    Microsoft::WRL::ComPtr<IDXGIDevice> dxgiDev;
    if (FAILED(g_device->QueryInterface(IID_PPV_ARGS(&dxgiDev)))) return 0;
    Microsoft::WRL::ComPtr<IDXGIAdapter> ad;
    if (FAILED(dxgiDev->GetAdapter(&ad))) return 0;
    Microsoft::WRL::ComPtr<IDXGIAdapter3> ad3;
    if (FAILED(ad.As(&ad3))) return 0;
    DXGI_QUERY_VIDEO_MEMORY_INFO info{};
    if (FAILED(ad3->QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &info))) return 0;
    return info.CurrentUsage;
}

struct PerfStats {
    std::vector<double> collect, compCpu, gpuDone;
    long long allocsCollect = 0, allocsComposite = 0;
    int cellsMax = 0;
    long long cellsSum = 0;
    uint64_t vramStart = 0, vramEnd = 0, vramPeak = 0;
};

static double pct(std::vector<double> v, double p) {
    if (v.empty()) return 0.0;
    std::sort(v.begin(), v.end());
    const size_t i = std::min(v.size() - 1, static_cast<size_t>(p * (v.size() - 1) + 0.5));
    return v[i];
}

static PerfStats runPerf(Stress& s, std::shared_ptr<const LensRoamSnapshot> snap,
                         RenderFrameCache& cache, const FrameCacheEntry& tex,
                         int width, int height, int frames) {
    const auto events = xleth::videoevents::build(s.tl, 140.0, 48000.0);
    FrameCollector col;
    col.setLensRoamSnapshot(std::move(snap));
    GridCompositor comp;
    assert(comp.init(g_device, g_deviceCtx, width, height));
    D3D11_QUERY_DESC qd{ D3D11_QUERY_EVENT, 0 };
    Microsoft::WRL::ComPtr<ID3D11Query> q;
    g_device->CreateQuery(&qd, &q);
    const GridLayout layout = s.tl.gridLayoutAt(TickTime{ 0 });
    const AVRational fps{ 30, 1 };
    PerfStats st;
    st.vramStart = st.vramPeak = vramUsage();
    for (int f = 0; f < frames; ++f) {
        const int64_t frame = 30 + f;                   // from beat ~2.3, 30 fps
        const long long a0 = g_allocs.load();
        auto t0 = Clock::now();
        const std::vector<CellFrameRequest>& reqs = col.collectRequests(
            frame, s.tl, 48000, fps, events.events, true, 0, false, nullptr, &layout, true);
        const double tc = msSince(t0);
        const long long a1 = g_allocs.load();
        for (const auto& r : reqs) {
            FrameCacheKey k; k.sourcePath = r.sourcePath; k.frameIndex = r.sourceFrameIndex;
            if (!cache.get(k)) cache.put(k, tex);
        }
        const long long a2 = g_allocs.load();
        t0 = Clock::now();
        comp.compositeFrame(reqs, cache, layout.columns, layout.rows, 0.0f, layout.gapScale);
        const double tcomp = msSince(t0);
        const long long a3 = g_allocs.load();
        g_deviceCtx->End(q.Get());
        g_deviceCtx->Flush();
        while (g_deviceCtx->GetData(q.Get(), nullptr, 0, 0) == S_FALSE) {}
        const double tgpu = msSince(t0);
        if (f >= 10) {                                   // skip warm-up (pool fills)
            st.collect.push_back(tc); st.compCpu.push_back(tcomp); st.gpuDone.push_back(tgpu);
            st.allocsCollect += a1 - a0;
            st.allocsComposite += a3 - a2;
        }
        st.cellsMax = std::max(st.cellsMax, static_cast<int>(reqs.size()));
        st.cellsSum += static_cast<long long>(reqs.size());
        if (f % 30 == 0) st.vramPeak = std::max(st.vramPeak, vramUsage());
    }
    st.vramEnd = vramUsage();
    st.vramPeak = std::max(st.vramPeak, st.vramEnd);
    comp.shutdown();
    return st;
}

static void report(const char* label, const PerfStats& p, int frames) {
    const double n = static_cast<double>(p.collect.size());
    std::fprintf(stderr,
        "[VERIFY] C %-28s cells avg %.1f max %d | collect med %.3f p95 %.3f | "
        "composite CPU med %.3f p95 %.3f max %.3f | GPU done med %.3f p95 %.3f | "
        "allocs/frame collect %.1f composite %.1f | VRAM %+.1f MB (peak %+.1f)\n",
        label, double(p.cellsSum) / frames, p.cellsMax,
        pct(p.collect, 0.5), pct(p.collect, 0.95),
        pct(p.compCpu, 0.5), pct(p.compCpu, 0.95), pct(p.compCpu, 1.0),
        pct(p.gpuDone, 0.5), pct(p.gpuDone, 0.95),
        p.allocsCollect / n, p.allocsComposite / n,
        (double(p.vramEnd) - double(p.vramStart)) / (1024.0 * 1024.0),
        (double(p.vramPeak) - double(p.vramStart)) / (1024.0 * 1024.0));
}

static void partBC() {
    std::fprintf(stderr, "\n[VERIFY] ── Part B/C: stress project (8x8, 32 tracks, 2,000 notes) ──\n");
    Stress s; buildStress(s, /*animateRoamScale=*/true);
    int notes = 0;
    for (int t : s.tracks)
        for (const PatternBlock* b : s.tl.getPatternBlocksOnTrack(t))
            if (const Pattern* p = s.tl.getPattern(b->patternId)) notes += static_cast<int>(p->notes.size());
    CHECK(notes == 2000, "stress: 2,000 notes");

    // Message-thread costs (the snapshot is built under syncEventsMutex).
    std::vector<double> snapMs, evMs;
    std::shared_ptr<const LensRoamSnapshot> snap;
    for (int i = 0; i < 15; ++i) {
        auto t0 = Clock::now(); snap = buildLensRoamSnapshot(s.tl); snapMs.push_back(msSince(t0));
        t0 = Clock::now(); auto ev = xleth::videoevents::build(s.tl, 140.0, 48000.0); evMs.push_back(msSince(t0));
    }
    const auto c = snap->counts();
    std::fprintf(stderr, "[VERIFY] C snapshot: tracks %d sources %d keys %d nudge %d own %d sweep %d\n",
                 c.tracks, c.sources, c.keys, c.noteNudge, c.noteOwn, c.sweepTracks);
    std::fprintf(stderr, "[VERIFY] C buildLensRoamSnapshot med %.3f ms max %.3f ms (held under syncEventsMutex); "
                 "videoevents::build med %.3f ms (context)\n",
                 pct(snapMs, 0.5), pct(snapMs, 1.0), pct(evMs, 0.5));

    RenderFrameCache cache;
    cache.setMemoryLimit(size_t(1) << 34);
    const FrameCacheEntry tex = makeGradientTexture(640, 360);
    const int frames = 300;

    for (auto [w, h] : { std::pair<int, int>{ 960, 540 }, std::pair<int, int>{ 1920, 1080 } }) {
        std::fprintf(stderr, "[VERIFY] C canvas %dx%d, %d frames\n", w, h, frames);
        const PerfStats off = runPerf(s, nullptr, cache, tex, w, h, frames);
        const PerfStats on  = runPerf(s, snap, cache, tex, w, h, frames);
        report("no Lens/Roam (identity)", off, frames);
        report("Lens+Roam+Sweep, keyed", on, frames);
        std::fprintf(stderr, "[VERIFY] C delta: collect %+.3f ms, composite CPU %+.3f ms, GPU done %+.3f ms (median)\n",
                     pct(on.collect, 0.5) - pct(off.collect, 0.5),
                     pct(on.compCpu, 0.5) - pct(off.compCpu, 0.5),
                     pct(on.gpuDone, 0.5) - pct(off.gpuDone, 0.5));
        // Part B: the Lens/Roam path adds no heap allocation on the render path.
        // The identity run goes first and still warms the collector's maps, so
        // compare "not more than". Composite allocations come from RTPool
        // creating a Lens target for each NEW cell pixel size (animated Roam
        // scale); see Part D. Reported here, asserted with constant sizes below.
        CHECK(on.allocsCollect <= off.allocsCollect, "B: collectRequests allocations not increased by Lens/Roam");
        std::fprintf(stderr, "[VERIFY] B allocations over %d frames: collect %lld vs %lld, composite %lld vs %lld (Lens/Roam vs identity)\n",
                     frames - 10, on.allocsCollect, off.allocsCollect, on.allocsComposite, off.allocsComposite);
    }

    // RT churn: animated Roam scale resizes the Lens pass target every frame.
    {
        Stress fixed; buildStress(fixed, /*animateRoamScale=*/false);
        auto fsnap = buildLensRoamSnapshot(fixed.tl);
        const PerfStats st = runPerf(fixed, fsnap, cache, tex, 960, 540, 600);
        report("Roam scale constant (600f)", st, 600);
        const PerfStats an = runPerf(s, snap, cache, tex, 960, 540, 600);
        report("Roam scale animated (600f)", an, 600);
        CHECK(st.allocsComposite == 0, "B: constant cell sizes: Lens/Roam composite allocates nothing");
    }

    // Motion view: masks on every track and Parent chains (up to 3 deep),
    // project motion blur on (so the collector also samples every ancestor's
    // Roam inside the shutter). Collect must add nothing over the identity run
    // of the SAME timeline; with constant cell sizes the composite (incl. the
    // Mask pass and its target) allocates nothing once warm.
    {
        MotionBlurSettings blur; blur.enabled = true; blur.shutterAngleDeg = 180.0f;
        Stress mv; buildStress(mv, /*animateRoamScale=*/false, /*motionView=*/true);
        mv.tl.setMotionBlur(blur);
        auto mvSnap = buildLensRoamSnapshot(mv.tl);
        const auto mc = mvSnap->counts();
        CHECK(mc.maskTracks == 32 && mc.masks == 64 && mc.parentedTracks == 24,
              "B: Motion view stress compiled (32 masked tracks, 24 parented)");
        const PerfStats off = runPerf(mv, nullptr, cache, tex, 960, 540, 600);
        const PerfStats on  = runPerf(mv, mvSnap, cache, tex, 960, 540, 600);
        report("Motion view: identity", off, 600);
        report("Motion view: masks+parents+blur", on, 600);
        CHECK(on.allocsCollect <= off.allocsCollect,
              "B: masks + Parent chains add no collect allocations");
        CHECK(on.allocsComposite == 0, "B: masks + Parent chains: composite allocates nothing (constant sizes)");
        std::fprintf(stderr, "[VERIFY] B Motion view allocations over 590 frames: collect %lld vs %lld (identity), composite %lld\n",
                     on.allocsCollect, off.allocsCollect, on.allocsComposite);
    }
}

// ── Part D: worst case for the Lens target churn ─────────────────────────────
// One large Lens-active cell (a 2x2 grid with one placement spanning the whole
// canvas) with Roam scale keyed 0.6 -> 1.0 over 4 bars, 1080p, 30 fps. Every
// new pixel size of the cell makes RTPool create a new Lens target pair (two
// textures), kept until 10 s idle. Reports VRAM growth and frame-time spikes.
static void partD() {
    std::fprintf(stderr, "\n[VERIFY] ── Part D: Lens target churn, one large cell, animated Roam scale ──\n");
    for (int animate = 0; animate < 2; ++animate) {
        Stress s;
        SourceMedia src;
        src.filePath = "churn_src.mp4"; src.hasVideo = true;
        src.fps = 30.0; src.duration = 120.0; src.totalFrames = 3600;
        src.width = 1920; src.height = 1080;
        const int srcId = s.tl.addSource(src);
        SampleRegion reg; reg.sourceId = srcId; reg.startTime = 0.0; reg.endTime = 60.0;
        reg.startFrame = 0; reg.endFrame = 1799;
        const int regId = s.tl.addRegion(reg);
        TrackInfo t; t.name = "Big"; t.type = TrackInfo::Type::Clip;
        const int trackId = s.tl.addTrack(t);
        s.tracks.push_back(trackId);
        Clip c; c.trackId = trackId; c.regionId = regId;
        c.position = TickTime{ 0 }; c.duration = TickTime{ 8 * 3840 };
        c.lens = LensTrack{}; c.lens.base.fit = LensFit::Cover; c.lens.base.zoom = 1.2f;
        s.tl.addClip(c);
        TrackInfo* tm = s.tl.getTrackMutable(trackId);
        if (animate) tm->roam.keys = { rk(RoamChannel::Scale, 0, 0.6), rk(RoamChannel::Scale, 4 * 3840, 1.0) };
        else         tm->roam.base.scale = 0.8f;
        GridLayout layout; layout.columns = 2; layout.rows = 2;
        layout.slots.push_back({ trackId, 0, 0, 2 * kGridSubUnitsPerColumn, 2 * kGridSubUnitsPerRow, 1.0f, 0 });
        s.tl.setGridLayout(layout);

        RenderFrameCache cache; cache.setMemoryLimit(size_t(1) << 34);
        const FrameCacheEntry tex = makeGradientTexture(1920, 1080);
        const PerfStats p = runPerf(s, buildLensRoamSnapshot(s.tl), cache, tex, 1920, 1080, 210);
        report(animate ? "1 cell, scale keyed 0.6->1.0" : "1 cell, scale constant", p, 210);
    }
}

// ── Part E: motion blur ───────────────────────────────────────────────────────
// The project-wide setting blurs Lens / Sweep / Roam; each track's Zoom/pan/rot
// has its own, and neither switches the other. Checked at the collector (which
// stage gets sub-frame samples, and that they bracket the frame time) and at
// the compositor (blur changes a moving cell, leaves a still one bit-exact,
// and live == frozen export at the same frame rate).
static const CellFrameRequest* reqFor(const std::vector<CellFrameRequest>& reqs, int trackId) {
    for (const auto& r : reqs) if (r.trackId == trackId) return &r;
    return nullptr;
}

static void partE(RenderFrameCache& cache) {
    std::fprintf(stderr, "\n[VERIFY] ── Part E: motion blur ──\n");
    const int failBefore = g_fail;
    const AVRational fps60{ 60, 1 };
    const std::unordered_map<int, std::string> plan;
    // Frame 147 at 60 fps = 2.45 s = tick 5488 at 140 BPM: inside the note at 4800..6240.
    const int64_t kFrame = 147;

    auto fill = [&](const std::vector<CellFrameRequest>& reqs) {
        for (const auto& r : reqs) {
            FrameCacheKey k; k.sourcePath = r.sourcePath; k.frameIndex = r.sourceFrameIndex;
            if (!cache.get(k)) cache.put(k, makeGradientTexture(64, 36));
        }
    };
    GridCompositor comp;
    assert(comp.init(g_device, g_deviceCtx, 384, 192));
    auto composite = [&](const std::vector<CellFrameRequest>& reqs, const GridLayout& l) {
        fill(reqs);
        comp.compositeFrame(reqs, cache, l.columns, l.rows, 0.0f, l.gapScale);
        ReadbackBuffer b = comp.readback();
        assert(b.valid);
        return b.pixels;
    };
    auto setProjectBlur = [](Timeline& tl, bool on, float shutter = 180.0f) {
        MotionBlurSettings m; m.enabled = on; m.shutterAngleDeg = shutter;
        tl.setMotionBlur(m);
    };

    // E0. A move too slow to cover half a pixel inside the shutter (0 -> 1
    //     cell over 2 bars: ~0.3 px per frame on a 128 px cell) is sampled by
    //     the collector but drawn exactly as without blur.
    {
        Fixture f; buildFixture(f, kNotes);
        TrackInfo* t = f.tl.getTrackMutable(f.patTrack);
        t->roam.base.bounds = RoamBounds::Float;
        t->roam.keys = { rk(RoamChannel::OffsetX, 0, 0.0), rk(RoamChannel::OffsetX, 7680, 1.0) };
        const auto ev = xleth::videoevents::build(f.tl, 140.0, 48000.0);
        const auto snap = buildLensRoamSnapshot(f.tl);
        const GridLayout layout = f.tl.getGridLayout();
        setProjectBlur(f.tl, false);
        FrameCollector off; off.setLensRoamSnapshot(snap);
        const std::vector<uint8_t> a = composite(
            off.collectRequests(kFrame, f.tl, 48000, fps60, ev.events, false, 0, false, &plan), layout);
        setProjectBlur(f.tl, true);
        FrameCollector on; on.setLensRoamSnapshot(snap);
        const std::vector<CellFrameRequest> br =
            on.collectRequests(kFrame, f.tl, 48000, fps60, ev.events, false, 0, false, &plan);
        const CellFrameRequest* r = reqFor(br, f.patTrack);
        CHECK(r && r->roamMotionCount == motionblur::kDenseSamples, "E0: slow move is still sampled");
        CHECK(composite(br, layout) == a, "E0: sub-pixel travel draws bit-exact without blur");
    }

    // E1. Roam keys: offsetX 0 -> 1 cell across ticks 5400..5600 (fast:
    //     ~11 px inside a 180-degree shutter on a 128 px cell), Float.
    {
        Fixture f; buildFixture(f, kNotes);
        TrackInfo* t = f.tl.getTrackMutable(f.patTrack);
        t->roam.base.bounds = RoamBounds::Float;
        t->roam.keys = { rk(RoamChannel::OffsetX, 5400, 0.0), rk(RoamChannel::OffsetX, 5600, 1.0) };
        const auto ev = xleth::videoevents::build(f.tl, 140.0, 48000.0);
        const auto snap = buildLensRoamSnapshot(f.tl);
        const GridLayout layout = f.tl.getGridLayout();

        setProjectBlur(f.tl, false);
        FrameCollector off; off.setLensRoamSnapshot(snap);
        const std::vector<CellFrameRequest> sharpReqs =
            off.collectRequests(kFrame, f.tl, 48000, fps60, ev.events, false, 0, false, &plan);
        const CellFrameRequest* sharp = reqFor(sharpReqs, f.patTrack);
        CHECK(sharp && sharp->roamMotionCount == 0, "E1: blur off -> no Roam samples");
        const std::vector<uint8_t> sharpPx = composite(sharpReqs, layout);

        setProjectBlur(f.tl, true);
        FrameCollector on; on.setLensRoamSnapshot(snap);
        const std::vector<CellFrameRequest> blurReqs =
            on.collectRequests(kFrame, f.tl, 48000, fps60, ev.events, false, 0, false, &plan);
        const CellFrameRequest* blur = reqFor(blurReqs, f.patTrack);
        CHECK(blur && blur->roamMotionCount == motionblur::kDenseSamples, "E1: blur on -> 32 Roam samples");
        CHECK(blur && blur->lensMotionCount == 0, "E1: still Lens -> no Lens samples");
        CHECK(blur && blur->zprMotionCount == 0, "E1: project blur never samples ZPR");
        if (blur && blur->roamMotionCount > 0) {
            const float first = blur->roamMotion[0].offsetX;
            const float last  = blur->roamMotion[motionblur::kDenseSamples - 1].offsetX;
            CHECK(first < blur->roam.offsetX && blur->roam.offsetX < last, "E1: samples bracket the frame time");
            // 180 deg at 60 fps = 1/120 s = 18.67 ticks; the outer samples span 31/32 of it.
            const double want = (0.5 / 60.0) * (140.0 / 60.0) * 960.0 * (31.0 / 32.0) / 200.0;
            CHECK(std::fabs((last - first) - want) < want * 0.02, "E1: span = the shutter");
        }
        const CellFrameRequest* still = reqFor(blurReqs, f.clipTrack);
        CHECK(still && still->roamMotionCount == 0 && still->lensMotionCount == 0,
              "E1: a still track gets no samples with blur on");
        const std::vector<uint8_t> blurPx = composite(blurReqs, layout);
        CHECK(blurPx != sharpPx, "E1: blur changes the moving cell");

        // Shutter 0 is no blur at all.
        setProjectBlur(f.tl, true, 0.0f);
        FrameCollector closed; closed.setLensRoamSnapshot(snap);
        const std::vector<CellFrameRequest> closedReqs =
            closed.collectRequests(kFrame, f.tl, 48000, fps60, ev.events, false, 0, false, &plan);
        CHECK(composite(closedReqs, layout) == sharpPx, "E1: 0-degree shutter == blur off, bit-exact");

        // Live == frozen export copy, same frame rate, blur on.
        setProjectBlur(f.tl, true);
        const FrozenTimelineCopy frozen = makeFrozenTimelineCopy(f.tl);
        const Timeline& ex = *frozen.timeline;
        const auto exEv = xleth::videoevents::build(ex, 140.0, 48000.0);
        FrameCollector exporter; exporter.setLensRoamSnapshot(buildLensRoamSnapshot(ex));
        const std::vector<CellFrameRequest> exReqs = exporter.collectRequests(
            kFrame - 60, ex, 48000, fps60, exEv.events, false, 48000, false, &plan);
        CHECK(composite(exReqs, ex.getGridLayout()) == blurPx, "E1: live == export with blur on");
    }

    // E2. Sweep (timeline-absolute Lens): zoom 1 -> 2 across ticks
    //     5400..5600. A still Roam keeps today's draw; the Lens pass blurs.
    {
        Fixture f; buildFixture(f, kNotes);
        TrackInfo* t = f.tl.getTrackMutable(f.patTrack);
        t->sweep.keys = { lk(LensChannel::Zoom, KeyAnchor::Origin, 5400, 1.0),
                          lk(LensChannel::Zoom, KeyAnchor::Origin, 5600, 2.0) };
        const auto ev = xleth::videoevents::build(f.tl, 140.0, 48000.0);
        const auto snap = buildLensRoamSnapshot(f.tl);
        const GridLayout layout = f.tl.getGridLayout();

        setProjectBlur(f.tl, false);
        FrameCollector off; off.setLensRoamSnapshot(snap);
        const std::vector<CellFrameRequest> a =
            off.collectRequests(kFrame, f.tl, 48000, fps60, ev.events, false, 0, false, &plan);
        setProjectBlur(f.tl, true, 360.0f);
        FrameCollector on; on.setLensRoamSnapshot(snap);
        const std::vector<CellFrameRequest> b =
            on.collectRequests(kFrame, f.tl, 48000, fps60, ev.events, false, 0, false, &plan);
        const CellFrameRequest* rb = reqFor(b, f.patTrack);
        CHECK(rb && rb->lensMotionCount == motionblur::kDenseSamples, "E2: Sweep -> 32 Lens samples");
        CHECK(rb && rb->roamMotionCount == 0, "E2: still Roam -> no Roam samples");
        if (rb && rb->lensMotionCount > 0)
            CHECK(rb->lensMotion[0].zoom < rb->lens.zoom
                  && rb->lens.zoom < rb->lensMotion[motionblur::kDenseSamples - 1].zoom,
                  "E2: Lens samples bracket the frame time");
        CHECK(composite(a, layout) != composite(b, layout), "E2: Sweep blur changes the cell");
    }

    // E3. Zoom/pan/rot: its OWN setting, independent of the project one.
    {
        Fixture f; buildFixture(f, kNotes);
        ZoomPanRotSettings z;
        z.enabled = true;
        z.startZoom = 1.0f; z.targetZoom = 3.0f;
        z.zoomEasing = 0;
        z.lengthMode = ZoomPanRotSettings::LengthMode::Fixed;
        z.durationMs = 1000.0f;
        const auto ev = xleth::videoevents::build(f.tl, 140.0, 48000.0);
        const auto snap = buildLensRoamSnapshot(f.tl);
        const GridLayout layout = f.tl.getGridLayout();

        // Runs frames up to kFrame so the note at tick 4800 triggers the ZPR.
        auto run = [&](bool projectBlur, bool zprBlur) {
            ZoomPanRotSettings zz = z;
            zz.motionBlur.enabled = zprBlur;
            f.tl.setTrackZoomPanRotSettings(f.patTrack, zz);
            setProjectBlur(f.tl, projectBlur);
            AnimationManager mgr;
            FrameCollector col; col.setLensRoamSnapshot(snap); col.setAnimationManager(&mgr);
            std::vector<CellFrameRequest> last;
            for (int64_t p = 120; p <= kFrame; ++p) {
                mgr.advanceTo(1000.0 * static_cast<double>(p * 800) / 48000.0);
                last = col.collectRequests(p, f.tl, 48000, fps60, ev.events, false, 0, false, &plan);
            }
            return last;
        };
        const std::vector<CellFrameRequest> sharp = run(false, false);
        const std::vector<CellFrameRequest> projOnly = run(true, false);
        const std::vector<CellFrameRequest> zprOnly = run(false, true);
        const CellFrameRequest* s = reqFor(sharp, f.patTrack);
        const CellFrameRequest* p = reqFor(projOnly, f.patTrack);
        const CellFrameRequest* q = reqFor(zprOnly, f.patTrack);
        CHECK(s && s->currentZoom > 1.0f && s->currentZoom < 3.0f, "E3: the ZPR is mid-animation");
        CHECK(p && p->zprMotionCount == 0, "E3: project blur does not blur ZPR");
        CHECK(q && q->zprMotionCount == motionblur::kDenseSamples, "E3: ZPR blur -> 32 ZPR samples");
        CHECK(q && q->lensMotionCount == 0 && q->roamMotionCount == 0,
              "E3: ZPR blur does not turn Lens/Roam blur on");
        if (q && q->zprMotionCount > 0)
            CHECK(q->zprMotion[0].zoom < q->currentZoom
                  && q->currentZoom < q->zprMotion[motionblur::kDenseSamples - 1].zoom,
                  "E3: ZPR samples bracket the frame time");
        const std::vector<uint8_t> sharpPx = composite(sharp, layout);
        CHECK(composite(projOnly, layout) == sharpPx, "E3: project blur leaves the ZPR cell bit-exact");
        CHECK(composite(zprOnly, layout) != sharpPx, "E3: ZPR blur changes the cell");
    }

    // E4. Pure math: the screen delta of an unmoved pose is identity, and a
    //     moved one maps the sub-pose centre back onto the frame-time centre.
    {
        const lensroam::UvRect c{ 0.2f, 0.3f, 0.25f, 0.25f };
        const motionblur::Affine id = motionblur::roamScreenDelta(c, 0.3f, c, 0.3f, 1920, 1080);
        CHECK(std::fabs(id.m00 - 1) < 1e-9 && std::fabs(id.m11 - 1) < 1e-9
              && std::fabs(id.m01) < 1e-9 && std::fabs(id.m10) < 1e-9
              && std::fabs(id.tx) < 1e-7 && std::fabs(id.ty) < 1e-7, "E4: unmoved pose -> identity");
        const lensroam::UvRect s{ 0.30f, 0.25f, 0.375f, 0.375f };
        const motionblur::Affine d = motionblur::roamScreenDelta(c, 0.0f, s, 0.7f, 1920, 1080);
        double ox, oy;
        motionblur::apply(d, s.x + s.w * 0.5, s.y + s.h * 0.5, ox, oy);
        CHECK(std::fabs(ox - (c.x + c.w * 0.5)) < 1e-6 && std::fabs(oy - (c.y + c.h * 0.5)) < 1e-6,
              "E4: sub centre maps to frame-time centre");
        CHECK(motionblur::tapsForPathPx(0.2) == 0, "E4: sub-pixel travel is not blurred");
        CHECK(motionblur::tapsForPathPx(1.0) == 2, "E4: a short move gets the minimum 2 taps");
        CHECK(motionblur::tapsForPathPx(500.0) == motionblur::kMaxTaps, "E4: taps cap at kMaxTaps");
    }

    // E6. Motion view: a STILL child of a MOVING parent blurs (design 3.4).
    //     The parent (Clip track) sweeps one cell across ticks 5400..5600; the
    //     masked child (Pattern track) has no Roam keys of its own. Its request
    //     must carry the parent's Roam at the 32 sub-frame ticks and its own
    //     (still) Roam samples, and its pixels must smear with the parent's.
    {
        Fixture f; buildFixture(f, kNotes);
        TrackInfo* p = f.tl.getTrackMutable(f.clipTrack);
        p->roam.base.bounds = RoamBounds::Float;
        p->roam.keys = { rk(RoamChannel::OffsetX, 5400, 0.0), rk(RoamChannel::OffsetX, 5600, 1.0) };
        TrackInfo* c = f.tl.getTrackMutable(f.patTrack);
        c->parentTrackId = f.clipTrack;
        c->roam.base.bounds = RoamBounds::Float;
        RoamMask m; m.id = 1; m.name = "Mask 1"; m.kind = MaskKind::Ellipse;
        m.base.shape = lensroam::ellipseMaskShape(0.35, 0.35);
        c->roam.masks = { m };
        const auto ev = xleth::videoevents::build(f.tl, 140.0, 48000.0);
        const auto snap = buildLensRoamSnapshot(f.tl);
        const GridLayout layout = f.tl.getGridLayout();
        auto only = [](const std::vector<CellFrameRequest>& reqs, int trackId) {
            std::vector<CellFrameRequest> out;
            for (const auto& r : reqs) if (r.trackId == trackId) out.push_back(r);
            return out;
        };

        setProjectBlur(f.tl, false);
        FrameCollector off; off.setLensRoamSnapshot(snap);
        const std::vector<CellFrameRequest> sharpReqs =
            off.collectRequests(kFrame, f.tl, 48000, fps60, ev.events, false, 0, false, &plan);
        const CellFrameRequest* sharp = reqFor(sharpReqs, f.patTrack);
        CHECK(sharp && sharp->parent.depth == 1 && sharp->parent.motionCount == 0
              && sharp->roamMotionCount == 0 && sharp->masks.count == 1,
              "E6: blur off -> parent chain + mask, no samples");
        const std::vector<uint8_t> sharpChild = composite(only(sharpReqs, f.patTrack), layout);

        setProjectBlur(f.tl, true);
        FrameCollector on; on.setLensRoamSnapshot(snap);
        const std::vector<CellFrameRequest> blurReqs =
            on.collectRequests(kFrame, f.tl, 48000, fps60, ev.events, false, 0, false, &plan);
        const CellFrameRequest* blur = reqFor(blurReqs, f.patTrack);
        CHECK(blur && blur->parent.motionCount == motionblur::kDenseSamples,
              "E6: a moving parent -> 32 ancestor samples");
        CHECK(blur && blur->roamMotionCount == motionblur::kDenseSamples,
              "E6: the still child is sampled too");
        if (blur && blur->parent.motionCount > 0) {
            const float first = blur->parent.motion[0][0].offsetX;
            const float last  = blur->parent.motion[motionblur::kDenseSamples - 1][0].offsetX;
            const float mid   = blur->parent.ancestors[0].roam.offsetX;
            CHECK(first < mid && mid < last, "E6: ancestor samples bracket the frame time");
            CHECK(blur->roamMotion[0].offsetX == 0.0f
                  && blur->roamMotion[motionblur::kDenseSamples - 1].offsetX == 0.0f,
                  "E6: the child's own samples are its still pose");
        }
        const std::vector<uint8_t> blurChild = composite(only(blurReqs, f.patTrack), layout);
        CHECK(blurChild != sharpChild, "E6: the still child of a moving parent blurs");
        const std::vector<uint8_t> blurPx = composite(blurReqs, layout);

        // Live == frozen export, blur on.
        const FrozenTimelineCopy frozen = makeFrozenTimelineCopy(f.tl);
        const Timeline& ex = *frozen.timeline;
        const auto exEv = xleth::videoevents::build(ex, 140.0, 48000.0);
        FrameCollector exporter; exporter.setLensRoamSnapshot(buildLensRoamSnapshot(ex));
        const std::vector<CellFrameRequest> exReqs = exporter.collectRequests(
            kFrame - 60, ex, 48000, fps60, exEv.events, false, 48000, false, &plan);
        CHECK(composite(exReqs, ex.getGridLayout()) == blurPx, "E6: live == export (masks + moving parent, blur on)");

        // Before the parent's move (tick ~5227, shutter ~+-9 ticks): nothing moves.
        FrameCollector early; early.setLensRoamSnapshot(snap);
        const std::vector<CellFrameRequest> earlyReqs =
            early.collectRequests(140, f.tl, 48000, fps60, ev.events, false, 0, false, &plan);
        const CellFrameRequest* e = reqFor(earlyReqs, f.patTrack);
        CHECK(e && e->parent.depth == 1 && e->parent.motionCount == 0 && e->roamMotionCount == 0,
              "E6: a still parent -> no samples");
    }

    comp.shutdown();

    // E5. Visual dump (XLETH_MB_DUMP=<dir>): a checkerboard cell under a fast
    //     Roam move + turn and a fast Sweep zoom, 960x540, blur off / 180 / 360.
    if (const char* dir = std::getenv("XLETH_MB_DUMP")) {
        Fixture f; buildFixture(f, kNotes);
        TrackInfo* t = f.tl.getTrackMutable(f.patTrack);
        t->roam.base.bounds = RoamBounds::Float;
        t->roam.keys = { rk(RoamChannel::OffsetX, 5400, -0.6), rk(RoamChannel::OffsetX, 5600, 0.6),
                         rk(RoamChannel::RotationDeg, 5400, -20.0), rk(RoamChannel::RotationDeg, 5600, 20.0) };
        t->sweep.keys = { lk(LensChannel::Zoom, KeyAnchor::Origin, 5400, 1.0),
                          lk(LensChannel::Zoom, KeyAnchor::Origin, 5600, 1.8) };
        const auto ev = xleth::videoevents::build(f.tl, 140.0, 48000.0);
        const auto snap = buildLensRoamSnapshot(f.tl);
        const GridLayout layout = f.tl.getGridLayout();

        // Checkerboard source, so the smear is easy to see.
        const int W = 320, H = 180;
        std::vector<uint8_t> px(static_cast<size_t>(W) * H * 4);
        for (int y = 0; y < H; ++y)
            for (int x = 0; x < W; ++x) {
                const bool on = ((x / 20) + (y / 20)) % 2 == 0;
                uint8_t* p = &px[(static_cast<size_t>(y) * W + x) * 4];
                p[0] = on ? 40 : 230; p[1] = on ? 200 : 230; p[2] = on ? 250 : 230; p[3] = 255;
            }
        D3D11_TEXTURE2D_DESC desc = {};
        desc.Width = W; desc.Height = H; desc.MipLevels = 1; desc.ArraySize = 1;
        desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1;
        desc.Usage = D3D11_USAGE_DEFAULT; desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        D3D11_SUBRESOURCE_DATA init = {}; init.pSysMem = px.data(); init.SysMemPitch = W * 4;

        RenderFrameCache dumpCache; dumpCache.setMemoryLimit(size_t(1) << 28);
        GridCompositor big;
        assert(big.init(g_device, g_deviceCtx, 960, 540));
        const float shutters[3] = { 0.0f, 180.0f, 360.0f };
        for (float sh : shutters) {
            setProjectBlur(f.tl, sh > 0.0f, sh);
            FrameCollector col; col.setLensRoamSnapshot(snap);
            const std::vector<CellFrameRequest> reqs =
                col.collectRequests(kFrame, f.tl, 48000, fps60, ev.events, false, 0, false, &plan);
            for (const auto& r : reqs) {
                FrameCacheKey k; k.sourcePath = r.sourcePath; k.frameIndex = r.sourceFrameIndex;
                if (dumpCache.get(k)) continue;
                FrameCacheEntry e;
                g_device->CreateTexture2D(&desc, &init, &e.texture);
                g_device->CreateShaderResourceView(e.texture.Get(), nullptr, &e.srv);
                e.width = W; e.height = H; e.memorySizeBytes = 64;
                dumpCache.put(k, std::move(e));
            }
            big.compositeFrame(reqs, dumpCache, layout.columns, layout.rows, 0.0f, layout.gapScale);
            ReadbackBuffer b = big.readback();
            if (!b.valid) continue;
            const std::string path = std::string(dir) + "/motion_blur_" +
                                     std::to_string(static_cast<int>(sh)) + ".bmp";
            if (FILE* fp = std::fopen(path.c_str(), "wb")) {
                const int w = 960, h = 540, rowBytes = w * 4;
                const uint32_t fileSize = 54 + rowBytes * h;
                uint8_t hdr[54] = { 'B', 'M' };
                auto put32 = [&](int off, uint32_t v) { for (int i = 0; i < 4; ++i) hdr[off + i] = uint8_t(v >> (8 * i)); };
                put32(2, fileSize); put32(10, 54); put32(14, 40); put32(18, w);
                put32(22, static_cast<uint32_t>(-h)); hdr[26] = 1; hdr[28] = 32;
                std::fwrite(hdr, 1, 54, fp);
                for (int y = 0; y < h; ++y)
                    std::fwrite(b.pixels.data() + static_cast<size_t>(y) * b.stride, 1, rowBytes, fp);
                std::fclose(fp);
                std::fprintf(stderr, "[VERIFY] E dump: %s\n", path.c_str());
            }
        }
        big.shutdown();
    }

    std::fprintf(stderr, "[VERIFY] E motion blur: %s\n", g_fail == failBefore ? "ok" : "FAIL");
}

int main() {
    GpuDeviceManager gpu;
    if (!gpu.detectAdapters() || !gpu.createDevice()) {
        std::fprintf(stderr, "[VERIFY] SKIP: no D3D11 device\n");
        return 0;
    }
    g_device = gpu.getDevice();
    g_deviceCtx = gpu.getContext();

    RenderFrameCache cache;
    cache.setMemoryLimit(size_t(1) << 30);
    partA(cache);
    partBC();
    partD();
    partE(cache);

    std::fprintf(stderr, "\n[VERIFY] %s (%d failure(s))\n", g_fail ? "FAILED" : "ALL PASSED", g_fail);
    std::fflush(stderr);
    std::_Exit(g_fail ? 1 : 0);
}
