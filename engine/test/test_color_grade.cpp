// test_color_grade.cpp — Color Grade (model/ColorGrade.h), CPU side.
//
// The grade model, its math, its persistence, its undo command and the
// snapshot the render path reads. Nothing here needs a GPU: the shader is
// checked against applyBakedGrade (the CPU reference used below) by
// test_compositor.
//
// Maps to the spec's acceptance criteria where it can be proven on the CPU:
//   A1 neutral   A2 source inheritance   A3 order of levels   A4 independence
//   A8 undo      A9 save/load            A10 curves           A11 duplication
//   A12 bulk apply                       A13 Auto helper
//
// Output prefix: [ColorGrade].

#include "model/ColorGrade.h"
#include "model/Timeline.h"
#include "model/Clip.h"
#include "model/Track.h"
#include "model/TimelineSnapshot.h"
#include "project/ProjectManager.h"
#include "render/FrameCollector.h"
#include "SyncManager.h"
#include "commands/ColorGradeCommands.h"
#include "commands/UndoManager.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using json = nlohmann::json;
using namespace xleth::grade;

static int g_fail = 0;
static int g_pass = 0;

// Release-safe (NDEBUG is defined in the Release build): never assert().
#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (cond) { ++g_pass; }                                                \
        else {                                                                 \
            ++g_fail;                                                          \
            std::cout << "    FAIL: " << (msg) << "  (" #cond ")  line "       \
                      << __LINE__ << "\n";                                     \
        }                                                                      \
    } while (0)

static bool approx(float a, float b, float tol) { return std::fabs(a - b) <= tol; }

// ─── fixtures ─────────────────────────────────────────────────────────────────

struct Fixture {
    Timeline tl{ 140.0, 48000.0 };
    int srcId = -1, src2Id = -1, src3Id = -1;
    int regA = -1, regB = -1;
    int clipTrack = -1, patTrack = -1;
    int clip1 = -1, clip2 = -1;
};

// One source cut two ways: a clip track holding two clips of region A, and a
// pattern track playing region B. Plus two more sources for bulk apply.
static void buildFixture(Fixture& f) {
    auto makeSource = [](const char* path) {
        SourceMedia src;
        src.filePath    = path;
        src.fileName    = path;
        src.hasVideo    = true;
        src.fps         = 30.0;
        src.duration    = 60.0;
        src.totalFrames = 1800;
        src.width = 1920; src.height = 1080;
        return src;
    };
    f.srcId  = f.tl.addSource(makeSource("grade_fixture_a.mp4"));
    f.src2Id = f.tl.addSource(makeSource("grade_fixture_b.mp4"));
    f.src3Id = f.tl.addSource(makeSource("grade_fixture_c.mp4"));

    SampleRegion ra;
    ra.sourceId = f.srcId; ra.startTime = 0.0; ra.endTime = 10.0;
    ra.startFrame = 0; ra.endFrame = 299;
    f.regA = f.tl.addRegion(ra);
    SampleRegion rb = ra;
    rb.startTime = 10.0; rb.endTime = 20.0; rb.startFrame = 300; rb.endFrame = 599;
    f.regB = f.tl.addRegion(rb);

    TrackInfo ct;
    ct.name = "Clips";
    ct.type = TrackInfo::Type::Clip;
    f.clipTrack = f.tl.addTrack(ct);
    TrackInfo pt;
    pt.name = "Pattern";
    pt.type = TrackInfo::Type::Pattern;
    f.patTrack = f.tl.addTrack(pt);

    Clip c;
    c.trackId  = f.clipTrack;
    c.regionId = f.regA;
    c.position = TickTime{ 0 };
    c.duration = TickTime::fromBeats(4);
    f.clip1 = f.tl.addClip(c);
    c.position = TickTime::fromBeats(4);
    f.clip2 = f.tl.addClip(c);

    Pattern pa;
    pa.name = "B";
    pa.regionId = f.regB;
    pa.length = TickTime::fromBeats(4);
    const int patternId = f.tl.addPattern(pa);
    PatternBlock blk;
    blk.trackId = f.patTrack;
    blk.patternId = patternId;
    blk.position = TickTime{ 0 };
    blk.duration = TickTime::fromBeats(4);
    f.tl.addPatternBlock(blk);

    GridLayout layout;
    layout.columns = 2;
    layout.rows    = 1;
    layout.slots.push_back({ f.clipTrack, 0, 0, kGridSubUnitsPerColumn, kGridSubUnitsPerRow, 1.0f, 0 });
    layout.slots.push_back({ f.patTrack, kGridSubUnitsPerColumn, 0,
                             kGridSubUnitsPerColumn, kGridSubUnitsPerRow, 1.0f, 1 });
    f.tl.setGridLayout(layout);
}

static ColorGrade someGrade() {
    ColorGrade g;
    g.exposure = 0.5f;
    g.contrast = 0.2f;
    g.saturation = -0.3f;
    g.vibrance = 0.25f;
    g.temperature = 0.4f;
    g.tint = -0.1f;
    g.hue = 12.0f;
    g.lift  = Wheel{ 0.1f, -0.2f, -0.15f };
    g.gamma = Wheel{ -0.05f, 0.1f, 0.2f };
    g.gain  = Wheel{ 0.2f, 0.15f, 0.1f };
    g.curveMaster.points = { {0.0f, 0.0f}, {0.25f, 0.18f}, {0.75f, 0.85f}, {1.0f, 1.0f} };
    g.curveR.points = { {0.0f, 0.05f}, {1.0f, 0.95f} };
    g.curveB.points = { {0.0f, 0.0f}, {0.5f, 0.6f}, {1.0f, 1.0f} };
    return g;
}

static fs::path freshDir(const char* name) {
    fs::path d = fs::temp_directory_path() / "xleth_test_color_grade" / name;
    std::error_code ec;
    fs::remove_all(d, ec);
    fs::create_directories(d, ec);
    return d;
}

static json readJson(const fs::path& p) {
    std::ifstream f(p);
    json j;
    f >> j;
    return j;
}

static VideoEvent makeEvent(int trackId, int sourceId, int clipId, int regionId) {
    VideoEvent ev{};
    ev.trackId = trackId;
    ev.sourceId = sourceId;
    ev.clipId = clipId;
    ev.regionId = regionId;
    ev.startBeat = 0.0;
    ev.durationBeats = 4.0;
    ev.sourceStartTime = 0.0;
    ev.layerIndex = 0;
    ev.x = 0; ev.y = 0; ev.width = 1; ev.height = 1;
    ev.opacity = 1.0f;
    return ev;
}

static const CellFrameRequest* reqFor(const std::vector<CellFrameRequest>& reqs, int trackId) {
    for (const auto& r : reqs) if (r.trackId == trackId) return &r;
    return nullptr;
}

// ─── [1] neutral ──────────────────────────────────────────────────────────────

static void test_neutral() {
    std::cout << "[1] a fresh grade is neutral and is not rendered (A1)\n";
    ColorGrade g;
    CHECK(g.isNeutral() && g.isDefault() && !g.isActive(), "default grade: neutral, default, inactive");
    CHECK(bakeColorGrade(g, nullptr) == nullptr, "a neutral grade bakes to nothing (no pass at all)");

    g.bypassed = true;
    CHECK(g.isNeutral() && !g.isDefault() && !g.isActive(), "bypassed neutral: not default, still inactive");

    ColorGrade h = someGrade();
    CHECK(!h.isNeutral() && h.isActive(), "a real grade is active");
    h.bypassed = true;
    CHECK(!h.isActive() && bakeColorGrade(h, nullptr) == nullptr, "a bypassed grade is not rendered");

    // An explicit diagonal is the same "no change" as no points.
    ColorGrade d;
    d.curveMaster.points = { {0.0f, 0.0f}, {1.0f, 1.0f} };
    CHECK(d.isNeutral(), "an explicit diagonal curve is neutral");
    // A LUT at amount 0 changes nothing.
    ColorGrade l;
    l.lutPath = "does_not_matter.cube";
    l.lutAmount = 0.0f;
    CHECK(l.isNeutral(), "a LUT at amount 0 is neutral");

    // Every control on its own makes the grade non-neutral.
    auto oneOff = [](void (*set)(ColorGrade&)) { ColorGrade x; set(x); return !x.isNeutral(); };
    CHECK(oneOff([](ColorGrade& x) { x.exposure = 0.1f; }), "exposure counts");
    CHECK(oneOff([](ColorGrade& x) { x.contrast = 0.1f; }), "contrast counts");
    CHECK(oneOff([](ColorGrade& x) { x.saturation = 0.1f; }), "saturation counts");
    CHECK(oneOff([](ColorGrade& x) { x.vibrance = 0.1f; }), "vibrance counts");
    CHECK(oneOff([](ColorGrade& x) { x.temperature = 0.1f; }), "temperature counts");
    CHECK(oneOff([](ColorGrade& x) { x.tint = 0.1f; }), "tint counts");
    CHECK(oneOff([](ColorGrade& x) { x.hue = 1.0f; }), "hue counts");
    CHECK(oneOff([](ColorGrade& x) { x.lift.lum = 0.1f; }), "lift counts");
    CHECK(oneOff([](ColorGrade& x) { x.gamma.x = 0.1f; }), "gamma counts");
    CHECK(oneOff([](ColorGrade& x) { x.gain.y = 0.1f; }), "gain counts");
    CHECK(oneOff([](ColorGrade& x) { x.curveG.points = { {0.0f, 0.1f}, {1.0f, 1.0f} }; }), "a channel curve counts");
}

// ─── [2] curves ───────────────────────────────────────────────────────────────

static void test_curves() {
    std::cout << "[2] curves pass through their points, never overshoot, never reverse (A10)\n";
    Curve id;
    for (int i = 0; i <= 10; ++i)
        CHECK(evaluateCurve(id, i / 10.0f) == i / 10.0f, "empty curve is the diagonal");

    Curve c;
    c.points = { {0.0f, 0.0f}, {0.2f, 0.05f}, {0.5f, 0.5f}, {0.8f, 0.95f}, {1.0f, 1.0f} };
    for (const auto& p : c.points)
        CHECK(approx(evaluateCurve(c, p.x), p.y, 1e-5f), "the curve passes through every point");
    bool monotone = true;
    float prev = -1.0f;
    for (int i = 0; i <= 2000; ++i) {
        const float y = evaluateCurve(c, i / 2000.0f);
        if (y < prev - 1e-6f) monotone = false;
        prev = y;
    }
    CHECK(monotone, "an S-curve through rising points never reverses");

    // Sloppy placement: two points almost on top of each other with a big
    // jump, the case that makes a plain cubic spline ring.
    Curve steep;
    steep.points = { {0.0f, 0.0f}, {0.48f, 0.02f}, {0.52f, 0.98f}, {1.0f, 1.0f} };
    monotone = true; prev = -1.0f;
    float lo = 1.0f, hi = 0.0f;
    for (int i = 0; i <= 4000; ++i) {
        const float y = evaluateCurve(steep, i / 4000.0f);
        if (y < prev - 1e-6f) monotone = false;
        prev = y;
        lo = std::min(lo, y); hi = std::max(hi, y);
    }
    CHECK(monotone, "a steep curve is still monotone on a smooth gradient (no reversal)");
    CHECK(lo >= 0.0f && hi <= 1.0f, "a steep curve never leaves [0,1] (no overshoot)");

    // A deliberately non-monotone curve: it may go down, but only between the
    // points that say so, and never past them.
    Curve bump;
    bump.points = { {0.0f, 0.0f}, {0.5f, 0.9f}, {1.0f, 0.2f} };
    float peak = 0.0f;
    for (int i = 0; i <= 1000; ++i) peak = std::max(peak, evaluateCurve(bump, i / 1000.0f));
    CHECK(peak <= 0.9f + 1e-5f, "a peak is never exceeded between points");

    // Golden values, shared with ui/src/colorGrade/curveMath.test.js: the line
    // the curves editor draws (JavaScript) and the curve the engine bakes (this
    // function) must be the same curve. Change one side and both tests fail.
    {
        const float xs[7] = { 0.1f, 0.3f, 0.4f, 0.5f, 0.6f, 0.7f, 0.9f };
        const float goldS[7]     = { 0.021023f, 0.151515f, 0.325758f, 0.500000f, 0.674242f, 0.848485f, 0.978977f };
        const float goldSteep[7] = { 0.002945f, 0.007294f, 0.012553f, 0.500000f, 0.987447f, 0.992706f, 0.997055f };
        const float goldBump[7]  = { 0.208800f, 0.669600f, 0.835200f, 0.900000f, 0.849600f, 0.720800f, 0.362400f };
        bool same = true;
        for (int i = 0; i < 7; ++i) {
            same = same && approx(evaluateCurve(c, xs[i]), goldS[i], 2e-6f);
            same = same && approx(evaluateCurve(steep, xs[i]), goldSteep[i], 2e-6f);
            same = same && approx(evaluateCurve(bump, xs[i]), goldBump[i], 2e-6f);
        }
        CHECK(same, "the engine's curve matches the editor's curve at the shared golden points");
    }

    // Flat outside the first and last point.
    Curve inset;
    inset.points = { {0.2f, 0.1f}, {0.8f, 0.9f} };
    CHECK(evaluateCurve(inset, 0.0f) == 0.1f && evaluateCurve(inset, 1.0f) == 0.9f,
          "flat outside the end points");

    // Sanitize: unsorted, duplicate, out of range, too many.
    Curve messy;
    messy.points = { {0.9f, 0.9f}, {0.1f, 0.2f}, {0.1f, 0.7f}, {1.5f, 2.0f}, {-1.0f, -1.0f} };
    sanitizeCurve(messy);
    bool sorted = true;
    for (size_t i = 1; i < messy.points.size(); ++i)
        if (messy.points[i].x - messy.points[i - 1].x < kMinCurvePointGap) sorted = false;
    CHECK(sorted && messy.points.size() == 4, "sanitize sorts and removes the stacked point");
    CHECK(messy.points.front().x == 0.0f && messy.points.back().x == 1.0f
          && messy.points.back().y == 1.0f, "sanitize clamps into [0,1]");
    Curve many;
    for (int i = 0; i < 40; ++i) many.points.push_back({ i / 39.0f, i / 39.0f });
    sanitizeCurve(many);
    CHECK(static_cast<int>(many.points.size()) <= kMaxCurvePoints, "sanitize caps the point count");

    // The four curves work independently and together.
    ColorGrade g;
    g.curveR.points = { {0.0f, 0.0f}, {0.5f, 0.8f}, {1.0f, 1.0f} };
    CHECK(evaluateTransfer(g, 0, 0.5f) > 0.79f, "red curve lifts red");
    CHECK(evaluateTransfer(g, 1, 0.5f) == 0.5f && evaluateTransfer(g, 2, 0.5f) == 0.5f,
          "red curve leaves green and blue alone");
    g.curveMaster.points = { {0.0f, 0.0f}, {0.5f, 0.25f}, {1.0f, 1.0f} };
    CHECK(approx(evaluateTransfer(g, 1, 0.5f), 0.25f, 1e-5f), "master curve moves every channel");
    CHECK(approx(evaluateTransfer(g, 0, 0.5f), evaluateCurve(g.curveR, 0.25f), 1e-5f),
          "channel curve runs on the master curve's result");
}

// ─── [3] the transfer and the baked table ─────────────────────────────────────

static void test_transfer() {
    std::cout << "[3] controls do what they say; the baked table matches the direct math\n";
    {
        ColorGrade g;
        g.exposure = 1.0f;
        // One stop doubles linear light. 0.2 sRGB -> linear -> x2 -> sRGB.
        const double lin = std::pow((0.2 + 0.055) / 1.055, 2.4) * 2.0;
        const double want = 1.055 * std::pow(lin, 1.0 / 2.4) - 0.055;
        CHECK(approx(evaluateTransfer(g, 1, 0.2f), static_cast<float>(want), 1e-4f),
              "exposure +1 doubles linear light");
        CHECK(evaluateTransfer(g, 0, 0.0f) == 0.0f, "exposure leaves black at black");
    }
    {
        ColorGrade g;
        g.contrast = 0.6f;
        CHECK(evaluateTransfer(g, 0, 0.0f) == 0.0f && evaluateTransfer(g, 0, 1.0f) == 1.0f,
              "contrast keeps black and white fixed");
        CHECK(approx(evaluateTransfer(g, 0, 0.5f), 0.5f, 1e-6f), "contrast pivots on mid grey");
        CHECK(evaluateTransfer(g, 0, 0.25f) < 0.25f && evaluateTransfer(g, 0, 0.75f) > 0.75f,
              "more contrast darkens shadows and brightens highlights");
        g.contrast = -0.6f;
        CHECK(evaluateTransfer(g, 0, 0.25f) > 0.25f && evaluateTransfer(g, 0, 0.75f) < 0.75f,
              "less contrast flattens toward mid grey");
    }
    {
        ColorGrade g;
        g.temperature = 0.5f;
        CHECK(evaluateTransfer(g, 0, 0.5f) > 0.5f && evaluateTransfer(g, 2, 0.5f) < 0.5f,
              "warmer: red up, blue down");
        ColorGrade t;
        t.tint = 0.5f;
        CHECK(evaluateTransfer(t, 1, 0.5f) < 0.5f, "tint towards magenta: green down");
    }
    {
        ColorGrade g;
        g.lift.lum = -0.5f;
        CHECK(evaluateTransfer(g, 0, 0.1f) < 0.1f && approx(evaluateTransfer(g, 0, 1.0f), 1.0f, 1e-6f),
              "lift moves shadows and pins white");
        ColorGrade h;
        h.gain.lum = 0.5f;
        CHECK(evaluateTransfer(h, 0, 0.0f) == 0.0f && evaluateTransfer(h, 0, 0.5f) > 0.5f,
              "gain pins black and scales the top");
        ColorGrade m;
        m.gamma.lum = 0.5f;
        CHECK(evaluateTransfer(m, 0, 0.0f) == 0.0f && approx(evaluateTransfer(m, 0, 1.0f), 1.0f, 1e-6f)
              && evaluateTransfer(m, 0, 0.5f) > 0.5f, "gamma moves the middle and pins both ends");
        // A wheel tints without changing brightness: luma-weighted sum of the
        // three channel lifts is the luminance lift alone.
        ColorGrade w;
        w.lift = Wheel{ 0.7f, -0.4f, 0.0f };
        const float r = evaluateTransfer(w, 0, 0.0f), gg = evaluateTransfer(w, 1, 0.0f),
                    b = evaluateTransfer(w, 2, 0.0f);
        CHECK(r != gg || gg != b, "a wheel offset tints the range");
    }

    // The baked table against the direct evaluation, at every 8-bit input.
    const ColorGrade g = someGrade();
    const auto baked = bakeColorGrade(g, nullptr);
    CHECK(baked && baked->hasTransfer && baked->hasMatrix && baked->vibrance == g.vibrance,
          "bake carries a transfer, a matrix and the vibrance");
    CHECK(baked && baked->transfer.size() == static_cast<size_t>(kTransferLutSize) * 4,
          "transfer table size");
    float worst = 0.0f;
    if (baked) {
        ColorGrade channelOnly = g;       // no cross-channel steps: isolates the table
        channelOnly.saturation = 0.0f;
        channelOnly.vibrance = 0.0f;
        channelOnly.hue = 0.0f;
        const auto b2 = bakeColorGrade(channelOnly, nullptr);
        for (int i = 0; i <= 255 && b2; ++i) {
            const float x = i / 255.0f;
            float rgb[3] = { x, x, x };
            applyBakedGrade(*b2, rgb);
            for (int c = 0; c < 3; ++c)
                worst = std::max(worst, std::fabs(rgb[c] - evaluateTransfer(channelOnly, c, x)));
        }
    }
    // Well under half an 8-bit step (0.00196): the table never changes the
    // 8-bit result the direct math would give.
    CHECK(worst < 0.0006f, "baked table is within a fraction of an 8-bit step of the direct math");

    // A grade with no per-channel step carries no table, so those pixels are
    // not resampled at all.
    ColorGrade satOnly;
    satOnly.saturation = 0.5f;
    const auto sb = bakeColorGrade(satOnly, nullptr);
    CHECK(sb && !sb->hasTransfer && sb->transfer.empty() && sb->hasMatrix, "saturation alone bakes no table");
    if (sb) {
        float grey[3] = { 0.4f, 0.4f, 0.4f };
        applyBakedGrade(*sb, grey);
        CHECK(approx(grey[0], 0.4f, 1e-6f) && approx(grey[1], 0.4f, 1e-6f) && approx(grey[2], 0.4f, 1e-6f),
              "saturation leaves a neutral grey exactly alone");
        float red[3] = { 0.8f, 0.2f, 0.2f };
        applyBakedGrade(*sb, red);
        CHECK(red[0] > 0.8f && red[1] < 0.2f, "saturation pushes colour away from grey");
    }
    ColorGrade desat;
    desat.saturation = -1.0f;
    if (const auto db = bakeColorGrade(desat, nullptr)) {
        float c[3] = { 0.9f, 0.3f, 0.1f };
        applyBakedGrade(*db, c);
        CHECK(approx(c[0], c[1], 1e-5f) && approx(c[1], c[2], 1e-5f), "saturation -1 is greyscale");
    }
    ColorGrade vib;
    vib.vibrance = 1.0f;
    if (const auto vb = bakeColorGrade(vib, nullptr)) {
        float muted[3] = { 0.5f, 0.45f, 0.45f }, strong[3] = { 0.9f, 0.1f, 0.1f };
        const float mutedBefore = muted[0] - muted[1], strongBefore = strong[0] - strong[1];
        applyBakedGrade(*vb, muted);
        applyBakedGrade(*vb, strong);
        const float mutedGain  = (muted[0] - muted[1]) / mutedBefore;
        const float strongGain = (strong[0] - strong[1]) / strongBefore;
        CHECK(mutedGain > strongGain && mutedGain > 1.5f, "vibrance boosts muted colour more than strong colour");
    }
    ColorGrade hue;
    hue.hue = 120.0f;
    if (const auto hb = bakeColorGrade(hue, nullptr)) {
        float c[3] = { 1.0f, 0.0f, 0.0f };
        applyBakedGrade(*hb, c);
        CHECK(c[1] > 0.9f && c[0] < 0.1f && c[2] < 0.1f, "hue +120 turns red into green");
    }
}

// ─── [4] order of levels ──────────────────────────────────────────────────────

static void test_level_order() {
    std::cout << "[4] levels apply in order; swapping two gives a different picture (A3)\n";
    ColorGrade a;                 // crush then...
    a.curveMaster.points = { {0.0f, 0.0f}, {0.5f, 0.2f}, {1.0f, 1.0f} };
    ColorGrade b;                 // ...desaturate and lift
    b.saturation = -0.6f;
    b.lift.lum = 0.5f;
    const auto ba = bakeColorGrade(a, nullptr), bb = bakeColorGrade(b, nullptr);
    CHECK(ba && bb, "both bake");
    if (!ba || !bb) return;
    float ab[3] = { 0.6f, 0.4f, 0.2f }, baOrder[3] = { 0.6f, 0.4f, 0.2f };
    applyBakedGrade(*ba, ab);      applyBakedGrade(*bb, ab);
    applyBakedGrade(*bb, baOrder); applyBakedGrade(*ba, baOrder);
    CHECK(!approx(ab[0], baOrder[0], 0.01f) || !approx(ab[1], baOrder[1], 0.01f)
          || !approx(ab[2], baOrder[2], 0.01f), "A then B differs from B then A");
}

// ─── [5] owners, independence, duplication ────────────────────────────────────

static void test_owners() {
    std::cout << "[5] each grade belongs to its owner (A4, A11)\n";
    Fixture f;
    buildFixture(f);
    const ColorGrade g = someGrade();

    CHECK(f.tl.getColorGrade(Level::Source, f.srcId)->isDefault()
          && f.tl.getColorGrade(Level::Clip, f.clip1)->isDefault()
          && f.tl.getColorGrade(Level::Region, f.regB)->isDefault()
          && f.tl.getColorGrade(Level::Layer, f.clipTrack)->isDefault()
          && f.tl.getColorGrade(Level::Master, 0)->isDefault(), "everything starts neutral");
    CHECK(f.tl.getColorGrade(Level::Source, 99999) == nullptr
          && !f.tl.setColorGrade(Level::Clip, 99999, g), "an unknown owner is refused");

    // Editing one level never changes another; editing a clip never changes
    // its sibling.
    ColorGrade clipGrade; clipGrade.exposure = 1.0f;
    CHECK(f.tl.setColorGrade(Level::Clip, f.clip1, clipGrade), "set a clip grade");
    CHECK(f.tl.getClip(f.clip1)->colorGrade == clipGrade, "the clip holds it");
    CHECK(f.tl.getClip(f.clip2)->colorGrade.isDefault(), "its sibling is untouched");
    CHECK(f.tl.getSource(f.srcId)->colorGrade.isDefault()
          && f.tl.getTrack(f.clipTrack)->colorGrade.isDefault()
          && f.tl.getRegion(f.regA)->colorGrade.isDefault()
          && f.tl.getMasterColorGrade().isDefault(), "no other level moved");

    CHECK(f.tl.setColorGrade(Level::Source, f.srcId, g), "set a source grade");
    CHECK(f.tl.getClip(f.clip1)->colorGrade == clipGrade, "the clip grade is as the user set it");
    ColorGrade layer; layer.saturation = -1.0f;
    ColorGrade master; master.contrast = 0.3f;
    ColorGrade region; region.hue = 30.0f;
    CHECK(f.tl.setColorGrade(Level::Layer, f.patTrack, layer)
          && f.tl.setColorGrade(Level::Master, 0, master)
          && f.tl.setColorGrade(Level::Region, f.regB, region), "set layer, master, region");
    CHECK(f.tl.getSource(f.srcId)->colorGrade == g
          && f.tl.getTrack(f.patTrack)->colorGrade == layer
          && f.tl.getMasterColorGrade() == master
          && f.tl.getRegion(f.regB)->colorGrade == region, "each level holds its own value");

    // Out-of-range values are clamped on the way in.
    ColorGrade wild; wild.exposure = 99.0f; wild.saturation = -5.0f; wild.lift = Wheel{ 3.0f, 4.0f, 9.0f };
    f.tl.setColorGrade(Level::Layer, f.clipTrack, wild);
    const ColorGrade& stored = f.tl.getTrack(f.clipTrack)->colorGrade;
    CHECK(stored.exposure == kExposureRange && stored.saturation == -1.0f && stored.lift.lum == 1.0f,
          "values are clamped into range");
    CHECK(approx(std::sqrt(stored.lift.x * stored.lift.x + stored.lift.y * stored.lift.y), 1.0f, 1e-5f),
          "a wheel is kept inside the unit disc");

    // Duplicating a clip carries its grade; the copy is then independent.
    Clip copy = *f.tl.getClip(f.clip1);
    copy.position = TickTime::fromBeats(8);
    const int copyId = f.tl.addClip(copy);
    CHECK(f.tl.getClip(copyId)->colorGrade == clipGrade, "a duplicated clip carries its grade");
    ColorGrade other; other.tint = 0.5f;
    f.tl.setColorGrade(Level::Clip, copyId, other);
    CHECK(f.tl.getClip(f.clip1)->colorGrade == clipGrade, "editing the copy leaves the original alone");

    // Deleting a clip never loses the source grade.
    f.tl.removeClip(f.clip1);
    CHECK(f.tl.getSource(f.srcId)->colorGrade == g, "the source grade outlives its clips");

    // The export's frozen copy carries every level.
    const FrozenTimelineCopy frozen = makeFrozenTimelineCopy(f.tl);
    const Timeline& ex = *frozen.timeline;
    CHECK(ex.getSource(f.srcId)->colorGrade == g && ex.getMasterColorGrade() == master
          && ex.getTrack(f.patTrack)->colorGrade == layer
          && ex.getRegion(f.regB)->colorGrade == region
          && ex.getClip(copyId)->colorGrade == other, "the export copy carries all four levels");
    f.tl.setColorGrade(Level::Master, 0, ColorGrade{});
    CHECK(ex.getMasterColorGrade() == master, "an edit after the copy does not reach the export");
}

// ─── [6] undo ─────────────────────────────────────────────────────────────────

static void test_undo() {
    std::cout << "[6] one action is one undo step (A8, A12)\n";
    Fixture f;
    buildFixture(f);
    UndoManager um;
    const ColorGrade g = someGrade();

    auto one = [](Level level, int id, const ColorGrade& grade) {
        std::vector<SetColorGradesCommand::Target> t;
        t.push_back(SetColorGradesCommand::Target{ level, id, grade });
        return t;
    };

    um.execute(std::make_unique<SetColorGradesCommand>(one(Level::Source, f.srcId, g), f.tl, ""), f.tl);
    CHECK(f.tl.getSource(f.srcId)->colorGrade == g && um.getUndoCount() == 1, "a source edit is one entry");
    um.undo(f.tl);
    CHECK(f.tl.getSource(f.srcId)->colorGrade.isDefault(), "undo restores the source (so every placement)");
    um.redo(f.tl);
    CHECK(f.tl.getSource(f.srcId)->colorGrade == g, "redo re-applies it");

    // Writing the value that is already there records nothing.
    const int before = um.getUndoCount();
    um.execute(std::make_unique<SetColorGradesCommand>(one(Level::Source, f.srcId, g), f.tl, ""), f.tl);
    CHECK(um.getUndoCount() == before, "an unchanged write leaves no undo entry");
    um.execute(std::make_unique<SetColorGradesCommand>(one(Level::Clip, 424242, g), f.tl, ""), f.tl);
    CHECK(um.getUndoCount() == before, "a write to a missing owner leaves no undo entry");

    // A drag: the timeline was previewed to several values, then committed.
    // Undo must return to the value from BEFORE the drag, in one step.
    {
        ColorGrade start; start.contrast = 0.1f;
        f.tl.setColorGrade(Level::Layer, f.clipTrack, start);
        ColorGrade mid = start;  mid.contrast = 0.4f;
        ColorGrade end = start;  end.contrast = 0.7f;
        f.tl.setColorGrade(Level::Layer, f.clipTrack, mid);   // preview
        f.tl.setColorGrade(Level::Layer, f.clipTrack, end);   // preview
        f.tl.setColorGrade(Level::Layer, f.clipTrack, start); // the commit rolls back first
        const int n = um.getUndoCount();
        um.execute(std::make_unique<SetColorGradesCommand>(one(Level::Layer, f.clipTrack, end), f.tl, ""), f.tl);
        CHECK(um.getUndoCount() == n + 1 && f.tl.getTrack(f.clipTrack)->colorGrade == end,
              "a drag commits as exactly one entry");
        um.undo(f.tl);
        CHECK(f.tl.getTrack(f.clipTrack)->colorGrade == start, "undoing a drag returns to the pre-drag value");
    }
    // The same, when the command is handed the baseline explicitly.
    {
        ColorGrade start; start.hue = 5.0f;
        ColorGrade end;   end.hue = 50.0f;
        f.tl.setColorGrade(Level::Master, 0, end);            // previewed, never rolled back
        const std::vector<ColorGrade> baselines = { start };
        um.execute(std::make_unique<SetColorGradesCommand>(one(Level::Master, 0, end), f.tl, "", &baselines), f.tl);
        um.undo(f.tl);
        CHECK(f.tl.getMasterColorGrade() == start, "an explicit baseline is what undo restores");
        um.redo(f.tl);
        CHECK(f.tl.getMasterColorGrade() == end, "and redo returns to the committed value");
    }

    // Bulk apply: three sources, one step.
    {
        ColorGrade bulk; bulk.saturation = 0.4f; bulk.lift.lum = -0.2f;
        std::vector<SetColorGradesCommand::Target> targets;
        for (int id : { f.srcId, f.src2Id, f.src3Id })
            targets.push_back(SetColorGradesCommand::Target{ Level::Source, id, bulk });
        auto cmd = std::make_unique<SetColorGradesCommand>(std::move(targets), f.tl, "Apply Color Grade to 3 sources");
        CHECK(cmd->changedCount() == 3 && cmd->describe() == "Apply Color Grade to 3 sources", "bulk command covers all three");
        const int n = um.getUndoCount();
        um.execute(std::move(cmd), f.tl);
        CHECK(um.getUndoCount() == n + 1, "bulk apply is one undo entry");
        CHECK(f.tl.getSource(f.srcId)->colorGrade == bulk && f.tl.getSource(f.src2Id)->colorGrade == bulk
              && f.tl.getSource(f.src3Id)->colorGrade == bulk, "every target got the grade");
        um.undo(f.tl);
        CHECK(f.tl.getSource(f.srcId)->colorGrade == g && f.tl.getSource(f.src2Id)->colorGrade.isDefault()
              && f.tl.getSource(f.src3Id)->colorGrade.isDefault(), "one undo reverts the whole batch");
    }
}

// ─── [7] save / load ──────────────────────────────────────────────────────────

static void test_persistence() {
    std::cout << "[7] save and load keep every value at every level; old projects are untouched (A9)\n";
    {
        const ColorGrade g = someGrade();
        ColorGrade back = colorGradeFromJson(colorGradeToJson(g));
        CHECK(back == g, "JSON round trip keeps every value and every curve point");
        ColorGrade withLut = g;
        withLut.lutPath = "C:/looks/film \xC3\xA9mulsion.cube";
        withLut.lutAmount = 0.6f;
        withLut.bypassed = true;
        CHECK(colorGradeFromJson(colorGradeToJson(withLut)) == withLut, "LUT path, amount and bypass round trip");
        CHECK(colorGradeFromJson(json::object()).isDefault(), "an empty object is a neutral grade");
        CHECK(colorGradeFromJson(json("garbage")).isDefault(), "a non-object is a neutral grade");
        json bad = colorGradeToJson(g);
        bad["exposure"] = "loud";
        bad["curves"]["master"] = json::array({ json::array({ 0.2, 0.9 }), "x", json::array({ 0.1 }) });
        const ColorGrade tolerant = colorGradeFromJson(bad);
        CHECK(tolerant.exposure == 0.0f && tolerant.curveMaster.isIdentity(), "bad fields fall back, the rest loads");
        CHECK(tolerant.contrast == g.contrast, "a bad field does not lose the others");
    }

    Fixture f;
    buildFixture(f);
    const ColorGrade src = someGrade();
    ColorGrade clip;   clip.exposure = -0.75f; clip.curveG.points = { {0.0f, 0.1f}, {0.6f, 0.5f}, {1.0f, 0.9f} };
    ColorGrade region; region.hue = -40.0f; region.bypassed = true;
    ColorGrade layer;  layer.saturation = -1.0f; layer.gain = Wheel{ -0.3f, 0.2f, 0.4f };
    ColorGrade master; master.contrast = 0.35f; master.vibrance = 0.2f;
    f.tl.setColorGrade(Level::Source, f.srcId, src);
    f.tl.setColorGrade(Level::Clip, f.clip1, clip);
    f.tl.setColorGrade(Level::Region, f.regB, region);
    f.tl.setColorGrade(Level::Layer, f.patTrack, layer);
    f.tl.setColorGrade(Level::Master, 0, master);

    // Timeline JSON.
    {
        Timeline tl2{ 120.0, 48000.0 };
        tl2.fromJSON(f.tl.toJSON());
        CHECK(tl2.getSource(f.srcId)->colorGrade == src && tl2.getClip(f.clip1)->colorGrade == clip
              && tl2.getRegion(f.regB)->colorGrade == region && tl2.getTrack(f.patTrack)->colorGrade == layer
              && tl2.getMasterColorGrade() == master, "Timeline JSON round trip, all levels");
        CHECK(tl2.getClip(f.clip2)->colorGrade.isDefault() && tl2.getSource(f.src2Id)->colorGrade.isDefault(),
              "ungraded owners stay neutral");
    }

    // Through ProjectManager, which hand-copies a key whitelist: the file on
    // disk is what counts, not the Timeline round trip.
    const fs::path dir = freshDir("roundtrip");
    ProjectManager pm;
    CHECK(pm.createProject(dir.string(), "color_grade"), "createProject");
    CHECK(pm.saveProject(f.tl), "saveProject");
    const json onDisk = readJson(dir / "project.json");
    CHECK(onDisk.contains("masterColorGrade"), "the master grade is in project.json");
    bool sourceOnDisk = false, ungradedSourceClean = true, clipOnDisk = false, ungradedClipClean = true;
    for (const auto& s : onDisk["sources"]) {
        if (s.value("id", -1) == f.srcId) sourceOnDisk = s.contains("colorGrade");
        else if (s.contains("colorGrade")) ungradedSourceClean = false;
    }
    for (const auto& c : onDisk["clips"]) {
        if (c.value("id", -1) == f.clip1) clipOnDisk = c.contains("colorGrade");
        else if (c.contains("colorGrade")) ungradedClipClean = false;
    }
    CHECK(sourceOnDisk && clipOnDisk, "graded owners are written");
    CHECK(ungradedSourceClean && ungradedClipClean, "an ungraded owner writes no key (the file it always had)");

    ProjectManager pm2;
    auto loaded = pm2.loadProject(dir.string());
    CHECK(loaded.has_value(), "the project loads");
    if (loaded) {
        const Timeline& tl = *loaded;
        CHECK(tl.getSource(f.srcId) && tl.getSource(f.srcId)->colorGrade == src, "source grade survives save/load");
        CHECK(tl.getClip(f.clip1) && tl.getClip(f.clip1)->colorGrade == clip, "clip grade survives, every curve point");
        CHECK(tl.getRegion(f.regB) && tl.getRegion(f.regB)->colorGrade == region, "region grade survives, bypass included");
        CHECK(tl.getTrack(f.patTrack) && tl.getTrack(f.patTrack)->colorGrade == layer, "layer grade survives");
        CHECK(tl.getMasterColorGrade() == master, "master grade survives");
    }

    // A project from before the feature: no grade keys anywhere.
    {
        Fixture old;
        buildFixture(old);
        const fs::path oldDir = freshDir("pre_feature");
        ProjectManager pm3;
        CHECK(pm3.createProject(oldDir.string(), "old") && pm3.saveProject(old.tl), "save an ungraded project");
        const json j = readJson(oldDir / "project.json");
        const std::string text = j.dump();
        CHECK(text.find("colorGrade") == std::string::npos && text.find("masterColorGrade") == std::string::npos,
              "a project without grades has no grade key at all");
        ProjectManager pm4;
        auto re = pm4.loadProject(oldDir.string());
        CHECK(re.has_value(), "it loads");
        if (re) {
            bool allNeutral = re->getMasterColorGrade().isDefault();
            for (const SourceMedia* s : re->getAllSources()) allNeutral = allNeutral && s->colorGrade.isDefault();
            for (const Clip* c : re->getAllClips()) allNeutral = allNeutral && c->colorGrade.isDefault();
            for (const SampleRegion* r : re->getAllRegions()) allNeutral = allNeutral && r->colorGrade.isDefault();
            for (const TrackInfo* t : re->getAllTracks()) allNeutral = allNeutral && t->colorGrade.isDefault();
            CHECK(allNeutral, "an old project opens with every grade neutral");
            CHECK(buildColorGradeSnapshot(*re, nullptr, nullptr)->empty(), "and renders with no grade pass anywhere");
        }
    }
}

// ─── [8] the snapshot and the collector ───────────────────────────────────────

static void test_snapshot_and_collector() {
    std::cout << "[8] every cell request carries its resolved grades (A2)\n";
    Fixture f;
    buildFixture(f);
    const AVRational fps{ 30, 1 };
    std::vector<VideoEvent> events = {
        makeEvent(f.clipTrack, f.srcId, f.clip1, f.regA),
        makeEvent(f.patTrack, f.srcId, -1, f.regB),
    };

    // No snapshot installed, and an all-neutral snapshot: no grade anywhere.
    {
        FrameCollector col;
        auto& reqs = col.collectRequests(0, f.tl, 48000, fps, events);
        CHECK(reqs.size() == 2, "two cells");
        for (const auto& r : reqs)
            CHECK(!r.gradeSource && !r.gradeClip && !r.gradeLayer, "no snapshot -> no grade (today's rendering)");
        CHECK(col.masterGrade() == nullptr, "no snapshot -> no master grade");

        col.setColorGradeSnapshot(buildColorGradeSnapshot(f.tl, nullptr, nullptr));
        auto& reqs2 = col.collectRequests(0, f.tl, 48000, fps, events);
        for (const auto& r : reqs2)
            CHECK(!r.gradeSource && !r.gradeClip && !r.gradeLayer, "all neutral -> no grade");
        CHECK(col.masterGrade() == nullptr, "all neutral -> no master grade");
    }

    const ColorGrade src = someGrade();
    ColorGrade clip;   clip.exposure = 0.5f;
    ColorGrade region; region.hue = 25.0f;
    ColorGrade layer;  layer.saturation = -0.5f;
    ColorGrade master; master.contrast = 0.3f;
    f.tl.setColorGrade(Level::Source, f.srcId, src);
    f.tl.setColorGrade(Level::Clip, f.clip1, clip);
    f.tl.setColorGrade(Level::Region, f.regB, region);
    f.tl.setColorGrade(Level::Layer, f.patTrack, layer);
    f.tl.setColorGrade(Level::Master, 0, master);

    const auto snap = buildColorGradeSnapshot(f.tl, nullptr, nullptr);
    CHECK(snap->sources.size() == 1 && snap->clips.size() == 1 && snap->regions.size() == 1
          && snap->tracks.size() == 1 && snap->master, "the snapshot holds exactly the active grades");

    FrameCollector col;
    col.setColorGradeSnapshot(snap);
    auto& reqs = col.collectRequests(0, f.tl, 48000, fps, events);
    const CellFrameRequest* clipCell = reqFor(reqs, f.clipTrack);
    const CellFrameRequest* patCell  = reqFor(reqs, f.patTrack);
    CHECK(clipCell && patCell, "both cells are there");
    if (clipCell && patCell) {
        // One source, cut into a clip on one track and a pattern on another:
        // both show the Source grade, with no extra step.
        CHECK(clipCell->gradeSource && clipCell->gradeSource->grade == src, "the clip-track cell inherits the source grade");
        CHECK(patCell->gradeSource && patCell->gradeSource->grade == src, "the pattern-track cell inherits the source grade");
        CHECK(clipCell->gradeSource == patCell->gradeSource, "and it is one shared baked grade, not a copy each");
        CHECK(clipCell->gradeClip && clipCell->gradeClip->grade == clip, "a clip event carries its clip's grade");
        CHECK(patCell->gradeClip && patCell->gradeClip->grade == region, "a pattern event carries its region's grade");
        CHECK(!clipCell->gradeLayer, "the ungraded track has no layer grade");
        CHECK(patCell->gradeLayer && patCell->gradeLayer->grade == layer, "the graded track carries its layer grade");
    }
    CHECK(col.masterGrade() && col.masterGrade()->grade == master, "the master grade is offered for the frame");

    // A region's grade is the Pattern Track's clip level: it does not leak
    // onto a Clip Track clip cut from the same region.
    {
        ColorGrade regA; regA.tint = 0.6f;
        f.tl.setColorGrade(Level::Region, f.regA, regA);
        FrameCollector c2;
        c2.setColorGradeSnapshot(buildColorGradeSnapshot(f.tl, nullptr, nullptr));
        std::vector<VideoEvent> ev = { makeEvent(f.clipTrack, f.srcId, f.clip2, f.regA) };
        auto& r = c2.collectRequests(0, f.tl, 48000, fps, ev);
        const CellFrameRequest* cell = reqFor(r, f.clipTrack);
        CHECK(cell && !cell->gradeClip, "an ungraded clip on a Clip Track has no clip-level grade");
        f.tl.setColorGrade(Level::Region, f.regA, ColorGrade{});
    }

    // Changing the source grade updates every placement at once, and only the
    // changed grade is baked again.
    {
        ColorGrade src2 = src;
        src2.exposure = -1.0f;
        f.tl.setColorGrade(Level::Source, f.srcId, src2);
        const auto next = buildColorGradeSnapshot(f.tl, snap.get(), nullptr);
        CHECK(next->source(f.srcId) && next->source(f.srcId)->grade == src2
              && next->source(f.srcId) != snap->source(f.srcId), "the edited grade is re-baked");
        CHECK(next->clip(f.clip1) == snap->clip(f.clip1) && next->region(f.regB) == snap->region(f.regB)
              && next->track(f.patTrack) == snap->track(f.patTrack) && next->master == snap->master,
              "every unchanged grade keeps its baked entry (nothing re-baked, nothing re-uploaded)");
        col.setColorGradeSnapshot(next);
        auto& again = col.collectRequests(0, f.tl, 48000, fps, events);
        const CellFrameRequest* a = reqFor(again, f.clipTrack);
        const CellFrameRequest* b = reqFor(again, f.patTrack);
        CHECK(a && b && a->gradeSource->grade == src2 && b->gradeSource->grade == src2,
              "both placements show the new source grade");
        // A published snapshot never changes underneath a reader.
        CHECK(snap->source(f.srcId)->grade == src, "the previous snapshot is untouched");
    }

    // Bypass at one level removes exactly that level.
    {
        ColorGrade off = layer;
        off.bypassed = true;
        f.tl.setColorGrade(Level::Layer, f.patTrack, off);
        FrameCollector c2;
        c2.setColorGradeSnapshot(buildColorGradeSnapshot(f.tl, nullptr, nullptr));
        auto& r = c2.collectRequests(0, f.tl, 48000, fps, events);
        const CellFrameRequest* cell = reqFor(r, f.patTrack);
        CHECK(cell && !cell->gradeLayer && cell->gradeSource && cell->gradeClip,
              "a bypassed layer grade is dropped; the other levels stay");
        CHECK(c2.masterGrade() != nullptr, "the master grade is unaffected by a layer bypass");
        f.tl.setColorGrade(Level::Layer, f.patTrack, layer);
    }

    // Hold to compare (preview only): no grade at any level.
    {
        FrameCollector c2;
        c2.setColorGradeSnapshot(buildColorGradeSnapshot(f.tl, nullptr, nullptr));
        c2.setColorGradeCompareBypass(true);
        auto& r = c2.collectRequests(0, f.tl, 48000, fps, events);
        for (const auto& q : r)
            CHECK(!q.gradeSource && !q.gradeClip && !q.gradeLayer, "compare: no per-cell grade");
        CHECK(c2.masterGrade() == nullptr, "compare: no master grade");
        c2.setColorGradeCompareBypass(false);
        auto& r2 = c2.collectRequests(0, f.tl, 48000, fps, events);
        CHECK(reqFor(r2, f.patTrack) && reqFor(r2, f.patTrack)->gradeSource, "releasing compare brings the grades back");
    }
}

// ─── [9] LUT import ───────────────────────────────────────────────────────────

static std::string identityCube(int n) {
    std::string s = "# identity\nTITLE \"Identity\"\nLUT_3D_SIZE " + std::to_string(n) + "\n";
    for (int b = 0; b < n; ++b)
        for (int g = 0; g < n; ++g)
            for (int r = 0; r < n; ++r) {
                char line[96];
                std::snprintf(line, sizeof(line), "%.6f %.6f %.6f\n",
                              r / double(n - 1), g / double(n - 1), b / double(n - 1));
                s += line;
            }
    return s;
}

static void test_lut() {
    std::cout << "[9] .cube LUT import\n";
    std::string err;
    const auto id = parseCubeLut(identityCube(5), err);
    CHECK(id && id->size == 5 && id->title == "Identity" && err.empty(), "an identity cube parses");
    if (id) {
        float worst = 0.0f;
        for (int i = 0; i < 64; ++i) {
            const float in[3] = { (i % 4) / 3.0f, ((i / 4) % 4) / 3.0f, (i / 16) / 3.0f };
            float out[3];
            sampleLut3D(*id, in, out);
            for (int c = 0; c < 3; ++c) worst = std::max(worst, std::fabs(out[c] - in[c]));
        }
        CHECK(worst < 1e-5f, "an identity LUT returns its input");
    }

    // Red varies fastest: a LUT that swaps red and blue must do exactly that.
    {
        std::string s = "LUT_3D_SIZE 2\n";
        for (int b = 0; b < 2; ++b) for (int g = 0; g < 2; ++g) for (int r = 0; r < 2; ++r)
            s += std::to_string(b) + " " + std::to_string(g) + " " + std::to_string(r) + "\n";
        const auto swap = parseCubeLut(s, err);
        CHECK(swap != nullptr, "a 2-point LUT parses");
        if (swap) {
            const float in[3] = { 1.0f, 0.25f, 0.0f };
            float out[3];
            sampleLut3D(*swap, in, out);
            CHECK(approx(out[0], 0.0f, 1e-5f) && approx(out[1], 0.25f, 1e-5f) && approx(out[2], 1.0f, 1e-5f),
                  "axis order: red varies fastest");
        }
    }

    CHECK(!parseCubeLut("LUT_1D_SIZE 4\n0 0 0\n1 1 1\n", err) && !err.empty(), "a 1D LUT is refused, with a reason");
    CHECK(!parseCubeLut("LUT_3D_SIZE 2\n0 0 0\n1 1 1\n", err) && !err.empty(), "a truncated LUT is refused");
    CHECK(!parseCubeLut("LUT_3D_SIZE 999\n", err) && !err.empty(), "an oversized LUT is refused");
    CHECK(!parseCubeLut("hello world\n", err) && !err.empty(), "a file that is not a LUT is refused");
    CHECK(parseCubeLut("\xEF\xBB\xBF" + identityCube(2), err) != nullptr, "a BOM and CRLF are tolerated");

    // Through a file, a grade and the bake.
    const fs::path dir = freshDir("lut");
    const fs::path file = dir / "swap.cube";
    {
        std::ofstream f(file);
        f << "LUT_3D_SIZE 2\n";
        for (int b = 0; b < 2; ++b) for (int g = 0; g < 2; ++g) for (int r = 0; r < 2; ++r)
            f << b << " " << g << " " << r << "\n";
    }
    Lut3DLibrary lib;
    ColorGrade g;
    g.lutPath = file.string();
    g.lutAmount = 1.0f;
    CHECK(!g.isNeutral(), "a grade with a LUT is not neutral");
    const auto baked = bakeColorGrade(g, &lib);
    CHECK(baked && baked->lut3d && !baked->hasTransfer, "the bake carries the LUT");
    if (baked) {
        float c[3] = { 1.0f, 0.5f, 0.0f };
        applyBakedGrade(*baked, c);
        CHECK(approx(c[0], 0.0f, 1e-5f) && approx(c[2], 1.0f, 1e-5f), "the LUT is applied at full amount");
    }
    g.lutAmount = 0.5f;
    if (const auto half = bakeColorGrade(g, &lib)) {
        float c[3] = { 1.0f, 0.5f, 0.0f };
        applyBakedGrade(*half, c);
        CHECK(approx(c[0], 0.5f, 1e-5f) && approx(c[2], 0.5f, 1e-5f), "the amount blends the LUT in");
        CHECK(half->lut3d == baked->lut3d, "two grades on one file share one loaded table");
    }
    // A missing file: the grade is kept, the look is simply absent.
    ColorGrade missing;
    missing.lutPath = (dir / "nope.cube").string();
    CHECK(bakeColorGrade(missing, &lib) == nullptr, "a grade whose only content is a missing LUT renders as nothing");
    CHECK(!lib.errorFor(missing.lutPath).empty(), "and the library says why");
    missing.exposure = 0.5f;
    const auto partial = bakeColorGrade(missing, &lib);
    CHECK(partial && !partial->lut3d && partial->hasTransfer, "the rest of that grade still renders");
}

// ─── [10] Auto ────────────────────────────────────────────────────────────────

// A synthetic frame: a smooth ramp with coloured patches, then degraded the
// way aged footage is. `fade` squeezes the range and lifts black; `cast` tints
// the shadows; `desat` drains colour.
static std::vector<uint8_t> makeFrame(int w, int h, float blackAt, float whiteAt,
                                      const float castRGB[3], float colourAmount, unsigned seed) {
    std::vector<uint8_t> px(static_cast<size_t>(w) * h * 3);
    unsigned s = seed;
    auto rnd = [&]() { s = s * 1664525u + 1013904223u; return ((s >> 8) & 0xFFFF) / 65535.0f; };
    for (int y = 0; y < h; ++y) {
        for (int x = 0; x < w; ++x) {
            const float t = (x + rnd()) / w;                      // 0..1 ramp
            const float hueT = static_cast<float>(y) / h;
            float c[3] = { t, t, t };
            // Bands of colour across the height.
            const float amount = colourAmount * (0.4f + 0.6f * std::sin(hueT * 9.0f) * std::sin(hueT * 9.0f));
            c[0] += amount * std::sin(hueT * 6.283f) * 0.5f * t;
            c[1] += amount * std::sin(hueT * 6.283f + 2.094f) * 0.5f * t;
            c[2] += amount * std::sin(hueT * 6.283f + 4.188f) * 0.5f * t;
            for (int k = 0; k < 3; ++k) {
                float v = std::min(1.0f, std::max(0.0f, c[k]));
                v = blackAt + v * (whiteAt - blackAt);            // fade
                v += castRGB[k] * (1.0f - v);                     // cast, strongest in the shadows
                px[(static_cast<size_t>(y) * w + x) * 3 + k] =
                    static_cast<uint8_t>(std::lround(std::min(1.0f, std::max(0.0f, v)) * 255.0f));
            }
        }
    }
    return px;
}

static GradeAnalysis analyse(const std::vector<std::vector<uint8_t>>& frames, int w, int h,
                             const BakedGrade* through = nullptr) {
    GradeAnalysis a;
    for (const auto& f : frames) {
        if (!through) { a.addFrame(f.data(), w, h, w * 3, 3, 0, 1, 2); continue; }
        std::vector<uint8_t> g(f.size());
        for (size_t i = 0; i < f.size() / 3; ++i) {
            float c[3] = { f[i * 3] / 255.0f, f[i * 3 + 1] / 255.0f, f[i * 3 + 2] / 255.0f };
            applyBakedGrade(*through, c);
            for (int k = 0; k < 3; ++k) g[i * 3 + k] = static_cast<uint8_t>(std::lround(c[k] * 255.0f));
        }
        a.addFrame(g.data(), w, h, w * 3, 3, 0, 1, 2);
    }
    return a;
}

static float gradeDistance(const ColorGrade& g) {
    return std::fabs(g.lift.lum) + std::fabs(g.lift.x) + std::fabs(g.lift.y)
         + std::fabs(g.gamma.lum) + std::fabs(g.gain.lum) + std::fabs(g.gain.x) + std::fabs(g.gain.y)
         + std::fabs(g.saturation) + std::fabs(g.vibrance);
}

static void test_auto() {
    std::cout << "[10] Auto fixes aged footage and leaves healthy footage alone (A13)\n";
    const int w = 96, h = 54;

    // Faded, blue-lifted blacks, dim highlights, drained colour.
    const float blueCast[3] = { 0.00f, 0.01f, 0.07f };
    std::vector<std::vector<uint8_t>> faded;
    for (unsigned i = 0; i < 6; ++i) faded.push_back(makeFrame(w, h, 0.20f, 0.74f, blueCast, 0.25f, 100 + i));
    const GradeAnalysis before = analyse(faded, w, h);
    const ColorGrade autoGrade = autoGradeFromAnalysis(before);
    CHECK(!autoGrade.isNeutral(), "faded footage gets a correction");
    CHECK(autoGrade.exposure == 0.0f && autoGrade.contrast == 0.0f && autoGrade.curveMaster.isIdentity()
          && autoGrade.lutPath.empty(), "Auto writes only the controls it owns (wheels, saturation, vibrance)");

    const auto baked = bakeColorGrade(autoGrade, nullptr);
    CHECK(baked != nullptr, "the Auto grade bakes");
    if (baked) {
        const GradeAnalysis after = analyse(faded, w, h, baked.get());
        const double loB = GradeAnalysis::percentile(before.histLuma, 0.005);
        const double hiB = GradeAnalysis::percentile(before.histLuma, 0.995);
        const double loA = GradeAnalysis::percentile(after.histLuma, 0.005);
        const double hiA = GradeAnalysis::percentile(after.histLuma, 0.995);
        std::printf("    faded: black %.3f -> %.3f, white %.3f -> %.3f\n", loB, loA, hiB, hiA);
        CHECK(loB > 0.15 && loA < 0.06, "black level: milky blacks come down to black");
        CHECK(hiA > hiB + 0.12 && hiA <= 1.0, "highlights: dim whites come up");
        CHECK((hiA - loA) > (hiB - loB) * 1.4, "contrast: the tonal range is measurably wider");

        // Cast: how far the channel black points sit from each other.
        auto castSpread = [](const GradeAnalysis& a) {
            const double r = GradeAnalysis::percentile(a.histR, 0.005);
            const double g = GradeAnalysis::percentile(a.histG, 0.005);
            const double b = GradeAnalysis::percentile(a.histB, 0.005);
            return std::max(r, std::max(g, b)) - std::min(r, std::min(g, b));
        };
        const double castB = castSpread(before), castA = castSpread(after);
        std::printf("    faded: shadow cast spread %.3f -> %.3f\n", castB, castA);
        CHECK(castB > 0.03 && castA < castB * 0.5, "cast: the tinted shadows are measurably more neutral");
        CHECK(GradeAnalysis::mean(after.histChroma) > GradeAnalysis::mean(before.histChroma),
              "saturation: faded colour comes back up");
    }

    // Deterministic: the same statistics give the same grade, every time.
    CHECK(autoGradeFromAnalysis(analyse(faded, w, h)) == autoGrade, "the same input gives the same result");

    // One grade for the whole source: analysing the frames in a different
    // order (a different "scene order") changes nothing.
    {
        std::vector<std::vector<uint8_t>> shuffled(faded.rbegin(), faded.rend());
        CHECK(autoGradeFromAnalysis(analyse(shuffled, w, h)) == autoGrade,
              "frame order does not matter: one steady grade, no flicker across cuts");
    }

    // Healthy footage: full range, no cast, ordinary colour.
    const float noCast[3] = { 0.0f, 0.0f, 0.0f };
    std::vector<std::vector<uint8_t>> healthy;
    for (unsigned i = 0; i < 6; ++i) healthy.push_back(makeFrame(w, h, 0.0f, 1.0f, noCast, 0.55f, 500 + i));
    const ColorGrade healthyGrade = autoGradeFromAnalysis(analyse(healthy, w, h));
    std::printf("    healthy: correction size %.3f (faded: %.3f)\n",
                gradeDistance(healthyGrade), gradeDistance(autoGrade));
    CHECK(gradeDistance(healthyGrade) < 0.06f, "healthy footage comes out essentially unchanged");
    if (const auto hb = bakeColorGrade(healthyGrade, nullptr)) {
        float worst = 0.0f;
        for (int i = 0; i <= 255; ++i) {
            float c[3] = { i / 255.0f, i / 255.0f, i / 255.0f };
            applyBakedGrade(*hb, c);
            worst = std::max(worst, std::fabs(c[1] - i / 255.0f));
        }
        CHECK(worst < 0.03f, "and its picture moves by under 3 percent anywhere");
    }

    // Nothing to work with: no frames, a flat frame.
    CHECK(autoGradeFromAnalysis(GradeAnalysis{}).isNeutral(), "no analysis -> neutral");
    {
        std::vector<uint8_t> flat(static_cast<size_t>(w) * h * 3, 90);
        GradeAnalysis a;
        a.addFrame(flat.data(), w, h, w * 3, 3, 0, 1, 2);
        CHECK(autoGradeFromAnalysis(a).isNeutral(), "a flat frame is left alone");
    }

    // Strength: 0 = none, 1 = full, smooth in between.
    {
        ColorGrade base;
        base.exposure = 0.4f;
        base.curveMaster.points = { {0.0f, 0.0f}, {0.5f, 0.55f}, {1.0f, 1.0f} };
        base.lift.lum = 0.9f;   // will be replaced: Auto owns the wheels
        const ColorGrade full = applyAutoGrade(base, autoGrade, 1.0f);
        const ColorGrade none = applyAutoGrade(base, autoGrade, 0.0f);
        CHECK(full.lift == autoGrade.lift && full.gain == autoGrade.gain && full.vibrance == autoGrade.vibrance,
              "strength 1 is the full correction");
        CHECK(none.lift.isNeutral() && none.gain.isNeutral() && none.vibrance == 0.0f, "strength 0 is none of it");
        CHECK(full.exposure == 0.4f && full.curveMaster == base.curveMaster && none.exposure == 0.4f,
              "Auto leaves the controls it does not own exactly as they were");
        float prev = 0.0f;
        bool smooth = true;
        for (int i = 0; i <= 20; ++i) {
            const ColorGrade g = applyAutoGrade(base, autoGrade, i / 20.0f);
            const float d = gradeDistance(g);
            if (d < prev - 1e-4f) smooth = false;
            if (d - prev > gradeDistance(autoGrade) * 0.12f) smooth = false;   // no jump
            prev = d;
        }
        CHECK(smooth, "the strength control scales smoothly, with no jump");
    }

    // Percentile sanity.
    {
        GradeAnalysis a;
        std::vector<uint8_t> ramp(256 * 3);
        for (int i = 0; i < 256; ++i) { ramp[i * 3] = ramp[i * 3 + 1] = ramp[i * 3 + 2] = static_cast<uint8_t>(i); }
        a.addFrame(ramp.data(), 256, 1, 256 * 3, 3, 0, 1, 2);
        CHECK(approx(static_cast<float>(GradeAnalysis::percentile(a.histLuma, 0.5)), 0.5f, 0.01f), "median of a ramp is the middle");
        CHECK(a.pixels == 256 && a.frames == 1, "pixel and frame counts");
        // BGRA input: offsets select the channels.
        GradeAnalysis b;
        const uint8_t bgra[4] = { 10, 20, 200, 255 };
        b.addFrame(bgra, 1, 1, 4, 4, 2, 1, 0);
        CHECK(b.histR[200] == 1 && b.histG[20] == 1 && b.histB[10] == 1, "channel offsets are honoured (BGRA)");
    }
}

// ─── main ─────────────────────────────────────────────────────────────────────

int main() {
    std::cout << "[ColorGrade] model, math, persistence, undo, snapshot, LUT, Auto\n";
    test_neutral();
    test_curves();
    test_transfer();
    test_level_order();
    test_owners();
    test_undo();
    test_persistence();
    test_snapshot_and_collector();
    test_lut();
    test_auto();
    std::cout << "[ColorGrade] " << g_pass << " passed, " << g_fail << " failed\n";
    return g_fail == 0 ? 0 : 1;
}
