// test_lens_roam.cpp — Lens + Roam phase P1 (model/LensRoam.h).
//
// Data, persistence and the render-request snapshot. Nothing here renders:
// P1 only has to (a) store Lens/Roam, (b) save and load them, (c) migrate a
// v7 project to identity (fit = Stretch, today's output), and (d) hand the
// resolved values to every cell request through an immutable snapshot.
//
// Output prefix: [LensRoam].

#include "model/LensRoam.h"
#include "model/Timeline.h"
#include "model/Clip.h"
#include "model/Track.h"
#include "project/ProjectManager.h"
#include "render/FrameCollector.h"
#include "render/LensRoamMath.h"
#include "SyncManager.h"
#include "commands/TimelineCommands.h"
#include "commands/AddNotesBatchCommand.h"
#include "commands/UndoManager.h"
#include "model/Pattern.h"
#include "model/TimelineSnapshot.h"
#include "render/VideoEventBuilder.h"
#include "model/LensHitPresets.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <new>
#include <unordered_map>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using json = nlohmann::json;

// Global allocation counter: [18] proves the render-thread lookups
// (lensForEventAt / roamAt) never allocate.
static std::atomic<long long> g_allocs{ 0 };
void* operator new(std::size_t n) {
    ++g_allocs;
    if (void* p = std::malloc(n ? n : 1)) return p;
    throw std::bad_alloc();
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }

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

// ─── fixtures ─────────────────────────────────────────────────────────────────

struct Fixture {
    Timeline tl{ 140.0, 48000.0 };
    int srcId = -1, regA = -1, regB = -1;
    int clipTrack = -1, patTrack = -1;
    int clip1 = -1, clip2 = -1;
    int patternA = -1, patternB = -1;
};

// A clip track with two clips, and a pattern track playing two sources
// (two patterns on two different regions), plus a grid placing both tracks.
static void buildFixture(Fixture& f) {
    SourceMedia src;
    src.filePath    = "lens_roam_fixture.mp4";
    src.hasVideo    = true;
    src.fps         = 30.0;
    src.duration    = 60.0;
    src.totalFrames = 1800;
    src.width = 1920; src.height = 1080;
    f.srcId = f.tl.addSource(src);

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
    c.trackId = f.clipTrack;
    c.regionId = f.regA;
    c.position = TickTime{ 0 };
    c.duration = TickTime::fromBeats(4);
    f.clip1 = f.tl.addClip(c);
    c.position = TickTime::fromBeats(4);
    c.regionId = f.regB;
    f.clip2 = f.tl.addClip(c);

    Pattern pa;
    pa.name = "A";
    pa.regionId = f.regA;
    pa.length = TickTime::fromBeats(4);
    f.patternA = f.tl.addPattern(pa);
    Pattern pb = pa;
    pb.name = "B";
    pb.regionId = f.regB;
    f.patternB = f.tl.addPattern(pb);

    PatternBlock blk;
    blk.trackId = f.patTrack;
    blk.patternId = f.patternA;
    blk.position = TickTime{ 0 };
    blk.duration = TickTime::fromBeats(4);
    f.tl.addPatternBlock(blk);
    blk.patternId = f.patternB;
    blk.position = TickTime::fromBeats(4);
    f.tl.addPatternBlock(blk);

    GridLayout layout;
    layout.columns = 2;
    layout.rows    = 1;
    layout.slots.push_back({ f.clipTrack, 0, 0, kGridSubUnitsPerColumn, kGridSubUnitsPerRow, 1.0f, 0 });
    layout.slots.push_back({ f.patTrack, kGridSubUnitsPerColumn, 0,
                             kGridSubUnitsPerColumn, kGridSubUnitsPerRow, 1.0f, 1 });
    f.tl.setGridLayout(layout);
}

static LensParams someLens() {
    LensParams p;
    p.fit = LensFit::Contain;
    p.centerX = 0.25f; p.centerY = 0.75f;
    p.zoom = 1.5f; p.rotationDeg = -12.5f;
    p.flip = LensFlip::Horizontal;
    return p;
}

static RoamParams someRoam() {
    RoamParams r;
    r.offsetX = 0.5f; r.offsetY = -1.0f;
    r.scale = 0.75f; r.rotationDeg = 30.0f;
    r.bounds = RoamBounds::Float;
    r.layer = RoamLayer::AboveNeighbours;
    return r;
}

static fs::path freshDir(const char* name) {
    fs::path d = fs::temp_directory_path() / "xleth_test_lens_roam" / name;
    std::error_code ec;
    fs::remove_all(d, ec);
    fs::create_directories(d, ec);
    return d;
}

// ─── [1] identity and new-content defaults ────────────────────────────────────

static void test_defaults() {
    std::cout << "[1] identity defaults; new content defaults to Cover\n";
    CHECK(LensParams{}.isIdentity(), "LensParams{} is identity");
    CHECK(LensParams{}.fit == LensFit::Stretch, "identity fit is Stretch (today's output)");
    CHECK(RoamParams{}.isIdentity(), "RoamParams{} is identity");

    const LensParams nc = LensParams::newContentDefault();
    CHECK(nc.fit == LensFit::Cover, "newContentDefault fit = Cover");
    CHECK(!nc.isIdentity(), "Cover is not identity");
    CHECK(nc.centerX == 0.5f && nc.centerY == 0.5f && nc.zoom == 1.0f
          && nc.rotationDeg == 0.0f && nc.flip == LensFlip::FollowTrack,
          "newContentDefault is neutral apart from fit");

    Clip c;
    CHECK(c.lens.base.fit == LensFit::Cover, "a new Clip starts at Cover");
    CHECK(c.lens.keys.empty(), "a new Clip has no lens keys");

    TrackInfo t;
    CHECK(t.roam.base.isIdentity() && t.roam.keys.empty(), "a new track has identity Roam, no keys");
    CHECK(t.trackLens.empty(), "a new track has no source lenses");
    t.type = TrackInfo::Type::Pattern;
    CHECK(lensroam::resolveSourceLens(t, 42).fit == LensFit::Cover,
          "a source with no entry (a new source) resolves to Cover");
    t.trackLens[42] = LensTrack{};
    CHECK(lensroam::resolveSourceLens(t, 42).isIdentity(),
          "a source with an explicit Stretch entry resolves to identity");

    // Each non-identity field breaks identity on its own.
    auto lensBreaks = [](auto mutate) { LensParams p; mutate(p); return !p.isIdentity(); };
    CHECK(lensBreaks([](LensParams& p) { p.centerX = 0.5001f; }), "centerX breaks identity");
    CHECK(lensBreaks([](LensParams& p) { p.centerY = 0.4f; }), "centerY breaks identity");
    CHECK(lensBreaks([](LensParams& p) { p.zoom = 1.0001f; }), "zoom breaks identity");
    CHECK(lensBreaks([](LensParams& p) { p.rotationDeg = 360.0f; }), "rotation breaks identity");
    CHECK(lensBreaks([](LensParams& p) { p.flip = LensFlip::None; }), "flip None breaks identity");
    CHECK(lensBreaks([](LensParams& p) { p.fit = LensFit::Contain; }), "Contain breaks identity");
    auto roamBreaks = [](auto mutate) { RoamParams p; mutate(p); return !p.isIdentity(); };
    CHECK(roamBreaks([](RoamParams& p) { p.offsetX = 1.0f; }), "offsetX breaks identity");
    CHECK(roamBreaks([](RoamParams& p) { p.offsetY = -0.5f; }), "offsetY breaks identity");
    CHECK(roamBreaks([](RoamParams& p) { p.scale = 2.0f; }), "scale breaks identity");
    CHECK(roamBreaks([](RoamParams& p) { p.rotationDeg = 1.0f; }), "rotation breaks identity");
    CHECK(roamBreaks([](RoamParams& p) { p.bounds = RoamBounds::Float; }), "Float breaks identity");
    CHECK(roamBreaks([](RoamParams& p) { p.layer = RoamLayer::Top; }), "Top breaks identity");
}

// ─── [2] JSON round trip (incl. stored keys) ─────────────────────────────────

static void test_round_trip() {
    std::cout << "[2] clip / track / source JSON round trip, keys included\n";

    Clip c;
    c.id = 7; c.trackId = 1; c.regionId = 2;
    c.duration = TickTime::fromBeats(1);
    c.lens.base = someLens();
    LensKey k;
    k.channel = LensChannel::Zoom; k.anchor = KeyAnchor::Origin;
    k.pos = 480.0; k.value = 1.25; k.interp = xleth::keycurve::Interp::EaseOut;
    c.lens.keys.push_back(k);

    json jc = c;
    CHECK(jc.contains("lens") && jc["lens"].contains("base") && jc["lens"].contains("keys"),
          "clip writes lens {base, keys}");
    CHECK(jc["lens"]["base"]["fit"] == "Contain", "fit written as a string");
    Clip c2 = jc.get<Clip>();
    CHECK(c2.lens.base == c.lens.base, "clip lens base round-trips");
    CHECK(c2.lens.keys.size() == 1, "clip lens key round-trips");
    if (c2.lens.keys.size() == 1) {
        const LensKey& r = c2.lens.keys[0];
        CHECK(r.channel == LensChannel::Zoom && r.anchor == KeyAnchor::Origin
              && r.pos == 480.0 && r.value == 1.25
              && r.interp == xleth::keycurve::Interp::EaseOut,
              "key fields survive exactly (interp included)");
    }
    CHECK(jc["lens"]["keys"][0]["interp"] == "EaseOut" && !jc["lens"]["keys"][0].contains("p1x"),
          "interp written as a string; no bezier handles (P7)");
    CHECK(!jc["lens"].contains("zones"), "a clip lens never saves note zones");

    TrackInfo t;
    t.id = 3; t.name = "T"; t.type = TrackInfo::Type::Pattern;
    t.roam.base = someRoam();
    RoamKey rk;
    rk.channel = RoamChannel::OffsetX; rk.pos = 1920.0; rk.value = 0.5;
    t.roam.keys.push_back(rk);
    LensTrack src;
    src.base = someLens();
    LensKey hk;
    hk.channel = LensChannel::Zoom; hk.anchor = KeyAnchor::Head; hk.pos = 0.0; hk.value = 1.35;
    src.keys.push_back(hk);
    hk.anchor = KeyAnchor::Body; hk.pos = 0.5; hk.value = 1.15;
    src.keys.push_back(hk);
    hk.anchor = KeyAnchor::Tail; hk.pos = 240.0; hk.value = 1.0;
    hk.interp = xleth::keycurve::Interp::Hold;
    src.keys.push_back(hk);
    src.zones = xleth::keycurve::NoteZones{ 60.0, 480.0, xleth::keycurve::ShortNoteRule::Cut };
    t.trackLens[9] = src;
    t.trackLens[4] = LensTrack{};

    json jt = t;
    CHECK(jt.contains("roam") && jt.contains("trackLens"), "track writes roam and trackLens");
    CHECK(jt["trackLens"].is_array() && jt["trackLens"].size() == 2, "trackLens is an array of entries");
    CHECK(jt["trackLens"][0]["regionId"] == 4 && jt["trackLens"][1]["regionId"] == 9,
          "trackLens entries in ascending regionId");
    CHECK(jt["trackLens"][1].contains("hitCurve") && !jt["trackLens"][1].contains("keys"),
          "a source lens names its keys hitCurve (spec Storage)");

    TrackInfo t2 = jt.get<TrackInfo>();
    CHECK(t2.roam.base == t.roam.base, "roam base round-trips");
    CHECK(t2.roam.keys.size() == 1 && t2.roam.keys[0].channel == RoamChannel::OffsetX
          && t2.roam.keys[0].pos == 1920.0 && t2.roam.keys[0].value == 0.5,
          "roam key round-trips");
    CHECK(t2.trackLens.size() == 2, "both source lenses round-trip");
    CHECK(t2.trackLens.count(9) && t2.trackLens[9].base == src.base, "source base round-trips");
    CHECK(t2.trackLens.count(9) && t2.trackLens[9].keys.size() == 3
          && t2.trackLens[9].keys[0].anchor == KeyAnchor::Head
          && t2.trackLens[9].keys[1].anchor == KeyAnchor::Body
          && t2.trackLens[9].keys[2].anchor == KeyAnchor::Tail,
          "hit curve anchors round-trip in order");
    CHECK(t2.trackLens.count(9) && t2.trackLens[9].keys.size() == 3
          && t2.trackLens[9].keys[2].interp == xleth::keycurve::Interp::Hold
          && t2.trackLens[9].keys[0].interp == xleth::keycurve::Interp::Linear,
          "hit curve interps round-trip");
    CHECK(t2.trackLens.count(9) && t2.trackLens[9].zones == src.zones,
          "hit curve zones round-trip (head, tail, Cut)");
    CHECK(jt["trackLens"][1]["zones"]["shortNote"] == "Cut"
          && jt["trackLens"][1]["zones"]["headTicks"] == 60.0,
          "zones written per trackLens entry");
    CHECK(t2.trackLens.count(4) && t2.trackLens[4].zones == xleth::keycurve::NoteZones{},
          "an entry without custom zones gets the spec default (120, 240, Squash)");
    CHECK(t2.trackLens.count(4) && t2.trackLens[4].base.isIdentity(), "Stretch entry stays identity");

    // Writing twice gives the same JSON: the format is stable.
    json jt2 = t2;
    CHECK(jt2["roam"] == jt["roam"] && jt2["trackLens"] == jt["trackLens"], "re-serialization is stable");
}

// ─── [3] tolerant loading ─────────────────────────────────────────────────────

static void test_tolerant_load() {
    std::cout << "[3] missing fields load as identity; malformed values are sanitized\n";

    Clip c;
    c.id = 1; c.trackId = 1; c.regionId = 1; c.duration = TickTime::fromBeats(1);
    json jc = c;
    jc.erase("lens");
    Clip old = jc.get<Clip>();
    CHECK(old.lens.base.isIdentity() && old.lens.keys.empty(),
          "a clip without \"lens\" (pre-v8) loads as identity = Stretch, not Cover");

    TrackInfo t;
    t.id = 2; t.name = "x";
    t.roam.base = someRoam();
    t.trackLens[5] = LensTrack{ someLens(), {} };
    json jt = t;
    jt.erase("roam");
    jt.erase("trackLens");
    TrackInfo ot = jt.get<TrackInfo>();
    CHECK(ot.roam.base.isIdentity() && ot.roam.keys.empty(), "a track without \"roam\" loads identity");
    CHECK(ot.trackLens.empty(), "a track without \"trackLens\" loads no source entries");

    json bad = {
        {"base", {{"fit", "Fisheye"}, {"centerX", "left"}, {"zoom", 0.0},
                  {"rotationDeg", 45.0}, {"flip", "Diagonal"}}},
        {"keys", json::array({
            {{"channel", "zoom"}, {"anchor", "Origin"}, {"pos", 0}, {"value", 2.0}},
            {{"channel", "warp"}, {"anchor", "Origin"}, {"pos", 0}, {"value", 2.0}},
            {{"channel", "zoom"}, {"anchor", "Middle"}, {"pos", 0}, {"value", 2.0}},
            {{"channel", "zoom"}, {"anchor", "Head"}, {"value", 2.0}},
            {{"channel", "zoom"}, {"anchor", "Head"}, {"pos", 0}, {"value", nullptr}},
            "not a key"
        })}
    };
    LensTrack lt = lensroam::lensTrackFromJson(bad);
    CHECK(lt.base.fit == LensFit::Stretch, "unknown fit -> Stretch");
    CHECK(lt.base.centerX == 0.5f, "non-number center -> 0.5");
    CHECK(lt.base.zoom == 1.0f, "zoom 0 -> 1 (a zero multiplier is a black cell)");
    CHECK(lt.base.rotationDeg == 45.0f, "valid fields survive next to bad ones");
    CHECK(lt.base.flip == LensFlip::FollowTrack, "unknown flip -> FollowTrack");
    CHECK(lt.keys.size() == 1, "only the one well-formed key is kept");

    json badRoam = { {"base", {{"scale", -2.0}, {"bounds", "Nope"}, {"layer", "Sky"}, {"offsetX", 0.25}}} };
    RoamTrack rt = lensroam::roamTrackFromJson(badRoam);
    CHECK(rt.base.scale == 1.0f, "negative scale -> 1");
    CHECK(rt.base.bounds == RoamBounds::Clip && rt.base.layer == RoamLayer::GridOrder,
          "unknown bounds/layer -> identity values");
    CHECK(rt.base.offsetX == 0.25f, "valid offset survives");

    json dupes = json::array({
        {{"regionId", 3}, {"base", lensroam::lensParamsToJson(someLens())}},
        {{"regionId", 3}, {"base", lensroam::lensParamsToJson(LensParams{})}},
        {{"regionId", -1}},
        {{"base", json::object()}},
        42
    });
    auto m = lensroam::trackLensFromJson(dupes);
    CHECK(m.size() == 1 && m.count(3) && m[3].base == someLens(),
          "duplicate regionId: first wins; negative / missing ids dropped");
    CHECK(lensroam::trackLensFromJson(json::object()).empty(), "non-array trackLens -> empty");

    // P7: interp and zones.
    json keysP7 = {
        {"base", json::object()},
        {"keys", json::array({
            // a P1-format key: bezier handles, no interp -> Linear, handles ignored
            {{"channel", "zoom"}, {"anchor", "Origin"}, {"pos", 0}, {"value", 2.0},
             {"p1x", 0.1}, {"p1y", 1.4}, {"p2x", 0.9}, {"p2y", 1.0}},
            {{"channel", "zoom"}, {"anchor", "Origin"}, {"pos", 10}, {"value", 2.0}, {"interp", "Bounce"}},
            {{"channel", "zoom"}, {"anchor", "Origin"}, {"pos", 20}, {"value", 2.0}, {"interp", "Hold"}},
        })}
    };
    LensTrack k7 = lensroam::lensTrackFromJson(keysP7);
    CHECK(k7.keys.size() == 3, "P7 keys load");
    CHECK(k7.keys.size() == 3 && k7.keys[0].interp == xleth::keycurve::Interp::Linear,
          "a key with P1 bezier handles and no interp loads as Linear");
    CHECK(k7.keys.size() == 3 && k7.keys[1].interp == xleth::keycurve::Interp::Linear,
          "unknown interp -> Linear");
    CHECK(k7.keys.size() == 3 && k7.keys[2].interp == xleth::keycurve::Interp::Hold, "Hold survives");

    json zonesBad = json::array({
        {{"regionId", 1}, {"zones", {{"headTicks", -5}, {"tailTicks", "long"}, {"shortNote", "Chop"}}}},
        {{"regionId", 2}, {"zones", {{"headTicks", 30}, {"tailTicks", 60}, {"shortNote", "Cut"}}}},
        {{"regionId", 3}},
    });
    auto zm = lensroam::trackLensFromJson(zonesBad);
    CHECK(zm.size() == 3 && zm[1].zones == xleth::keycurve::NoteZones{},
          "malformed zones -> spec defaults (120, 240, Squash)");
    CHECK(zm[2].zones == (xleth::keycurve::NoteZones{ 30.0, 60.0, xleth::keycurve::ShortNoteRule::Cut }),
          "valid zones survive");
    CHECK(zm[3].zones == xleth::keycurve::NoteZones{}, "missing zones -> spec defaults");
}

// ─── [4] v7 -> v8 migration through ProjectManager ───────────────────────────

static json readJson(const fs::path& p) {
    std::ifstream f(p);
    json j;
    f >> j;
    return j;
}

static void writeJson(const fs::path& p, const json& j) {
    std::ofstream f(p);
    f << j.dump(4);
}

static void test_migration() {
    std::cout << "[4] a v7 project loads as identity (Stretch); new content is Cover\n";

    Fixture f;
    buildFixture(f);
    // Give the fixture non-identity values so the test can tell migration
    // (identity) from a load that kept whatever was in memory.
    f.tl.getClipMutable(f.clip1)->lens.base = someLens();
    f.tl.getTrackMutable(f.patTrack)->roam.base = someRoam();

    const fs::path dir = freshDir("v7");
    ProjectManager pm;
    CHECK(pm.createProject(dir.string(), "lens_roam_v7"), "createProject");
    CHECK(pm.saveProject(f.tl), "saveProject");

    // Turn the saved v8 file into the v7 file an older build would have
    // written: schema 7 and no Lens/Roam keys anywhere.
    const fs::path file = dir / "project.json";
    json j = readJson(file);
    CHECK(j.value("schema_version", 0) == XLETH_PROJECT_SCHEMA_VERSION && XLETH_PROJECT_SCHEMA_VERSION == 8,
          "the current schema is v8");
    j["schema_version"] = 7;
    for (auto& c : j["clips"]) c.erase("lens");
    for (auto& t : j["tracks"]) { t.erase("roam"); t.erase("trackLens"); }
    writeJson(file, j);

    ProjectManager pm2;
    auto loaded = pm2.loadProject(dir.string());
    CHECK(loaded.has_value(), "v7 project loads");
    if (!loaded) return;
    CHECK(pm2.loadedSchemaVersion() == 7, "reports v7");
    Timeline tl = std::move(*loaded);

    for (const Clip* c : tl.getAllClips())
        CHECK(c->lens.base.isIdentity() && c->lens.keys.empty(), "every v7 clip loads fit=Stretch identity");
    for (const TrackInfo* t : tl.getAllTracks())
        CHECK(t->roam.base.isIdentity() && t->roam.keys.empty(), "every v7 track loads identity Roam");

    const TrackInfo* pt = tl.getTrack(f.patTrack);
    CHECK(pt && pt->trackLens.size() == 2, "both sources the pattern track plays are materialized");
    if (pt) {
        CHECK(pt->trackLens.count(f.regA) && pt->trackLens.at(f.regA).base.isIdentity(),
              "source A = Stretch identity");
        CHECK(pt->trackLens.count(f.regB) && pt->trackLens.at(f.regB).base.isIdentity(),
              "source B = Stretch identity");
    }
    const TrackInfo* ct = tl.getTrack(f.clipTrack);
    CHECK(ct && ct->trackLens.empty(), "a clip track gets no source entries");

    // The identity snapshot for every track — the P1 acceptance check.
    auto snap = buildLensRoamSnapshot(tl);
    CHECK(snap->tracks.size() == tl.getAllTracks().size(), "snapshot has every track");
    for (const auto& e : snap->tracks) CHECK(e.roam.isIdentity(), "every track's Roam is identity");
    for (const auto& e : snap->clips)  CHECK(e.lens.isIdentity(), "every clip's Lens is identity");
    for (const auto& e : snap->sources) CHECK(e.lens.isIdentity(), "every source's Lens is identity");
    CHECK(snap->lensForSource(f.patTrack, f.regA).isIdentity()
          && snap->lensForSource(f.patTrack, f.regB).isIdentity(),
          "pattern events of a migrated project resolve to identity");
    const auto cnt = snap->counts();
    CHECK(cnt.roamNonIdentity == 0 && cnt.clipLensNonIdentity == 0 && cnt.sourceLensNonIdentity == 0,
          "no non-identity value anywhere");

    // Content created AFTER the load is new: Cover.
    Clip nc;
    nc.trackId = f.clipTrack; nc.regionId = f.regA;
    nc.position = TickTime::fromBeats(8); nc.duration = TickTime::fromBeats(1);
    const int newClip = tl.addClip(nc);
    CHECK(newClip > 0 && tl.getClip(newClip)->lens.base.fit == LensFit::Cover, "a new clip is Cover");
    SampleRegion rc;
    rc.sourceId = f.srcId; rc.startTime = 20.0; rc.endTime = 30.0; rc.startFrame = 600; rc.endFrame = 899;
    const int regC = tl.addRegion(rc);
    CHECK(lensroam::resolveSourceLens(*tl.getTrack(f.patTrack), regC).fit == LensFit::Cover,
          "a new source on an old track is Cover");
    auto snap2 = buildLensRoamSnapshot(tl);
    CHECK(snap2->lensForClip(newClip).fit == LensFit::Cover, "snapshot: new clip Cover");
    CHECK(snap2->lensForSource(f.patTrack, regC).fit == LensFit::Cover,
          "snapshot: an unmaterialized pattern source falls back to Cover");
    CHECK(snap2->lensForSource(f.patTrack, f.regA).isIdentity(), "snapshot: migrated source stays Stretch");

    // Save -> v8 with explicit identity fields; reload -> no second migration.
    ProjectManager pm3;
    CHECK(pm3.saveProjectAs((dir.parent_path() / "v8").string(), "lens_roam_v8", tl), "saveProjectAs v8");
    const json j8 = readJson(dir.parent_path() / "v8" / "project.json");
    CHECK(j8.value("schema_version", 0) == 8, "re-saved at schema v8");
    bool allLens = true, allRoam = true;
    for (const auto& c : j8["clips"])  allLens = allLens && c.contains("lens");
    for (const auto& t : j8["tracks"]) allRoam = allRoam && t.contains("roam") && t.contains("trackLens");
    CHECK(allLens && allRoam, "every clip/track now states its Lens/Roam");

    ProjectManager pm4;
    auto re = pm4.loadProject((dir.parent_path() / "v8").string());
    CHECK(re.has_value() && pm4.loadedSchemaVersion() == 8, "v8 reload");
    if (re) {
        CHECK(re->getClip(newClip) && re->getClip(newClip)->lens.base.fit == LensFit::Cover,
              "the new clip stays Cover across save/load");
        const TrackInfo* rpt = re->getTrack(f.patTrack);
        CHECK(rpt && rpt->trackLens.size() == 2 && !rpt->trackLens.count(regC),
              "v8 load does not re-run the migration (the new source stays unmaterialized = Cover)");
    }
}

// ─── [5] snapshot lookups ─────────────────────────────────────────────────────

static void test_snapshot_lookup() {
    std::cout << "[5] snapshot resolves per event; misses are identity\n";
    Fixture f;
    buildFixture(f);
    f.tl.getClipMutable(f.clip2)->lens.base = someLens();
    f.tl.getTrackMutable(f.clipTrack)->roam.base = someRoam();
    f.tl.getTrackMutable(f.patTrack)->trackLens[f.regB] = LensTrack{ someLens(), {} };
    // The BASE lookups ignore keys (P7 evaluates them in lensForEventAt).
    LensKey k; k.channel = LensChannel::Zoom; k.value = 9.0;
    f.tl.getClipMutable(f.clip2)->lens.keys.push_back(k);

    auto s = buildLensRoamSnapshot(f.tl);
    CHECK(s->lensForEvent(f.clipTrack, f.clip2, f.regB) == someLens(),
          "clip event -> that clip's lens (base lookup: keys ignored)");
    CHECK(s->lensForEvent(f.clipTrack, f.clip1, f.regA).fit == LensFit::Cover,
          "a fresh clip event -> Cover");
    CHECK(s->lensForEvent(f.patTrack, -1, f.regB) == someLens(),
          "pattern event -> the {trackId, regionId} source lens");
    CHECK(s->lensForEvent(f.patTrack, -1, f.regA).fit == LensFit::Cover,
          "pattern event, source with no entry -> Cover");
    CHECK(s->roamFor(f.clipTrack) == someRoam(), "track roam");
    CHECK(s->roamFor(f.patTrack).isIdentity(), "untouched track roam is identity");
    CHECK(s->roamFor(99999).isIdentity(), "unknown track -> identity Roam");
    CHECK(s->lensForClip(99999).isIdentity(), "unknown clip -> identity Lens");
    CHECK(s->lensForSource(99999, f.regA).isIdentity(), "unknown track's source -> identity Lens");

    // Immutable: editing the timeline afterwards does not change a snapshot.
    f.tl.getTrackMutable(f.clipTrack)->roam.base = RoamParams{};
    CHECK(s->roamFor(f.clipTrack) == someRoam(), "a published snapshot never changes");
}

// ─── [6] FrameCollector copies the values into each request ──────────────────

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

static void test_collector_copy() {
    std::cout << "[6] every cell request carries the resolved Lens/Roam\n";
    Fixture f;
    buildFixture(f);
    std::vector<VideoEvent> events = {
        makeEvent(f.clipTrack, f.srcId, f.clip1, f.regA),
        makeEvent(f.patTrack, f.srcId, -1, f.regB),
    };
    const AVRational fps{ 30, 1 };

    {
        FrameCollector col;
        auto& reqs = col.collectRequests(0, f.tl, 48000, fps, events);
        CHECK(reqs.size() == 2, "two cells");
        for (const auto& r : reqs)
            CHECK(r.lens.isIdentity() && r.roam.isIdentity(),
                  "no snapshot installed -> identity (today's rendering)");
    }

    // An old project: identity everywhere -> identity in every request.
    {
        Fixture g;
        buildFixture(g);
        g.tl.getClipMutable(g.clip1)->lens = LensTrack{};
        g.tl.getClipMutable(g.clip2)->lens = LensTrack{};
        lensroam::migratePreLensProject(g.tl);
        FrameCollector col;
        col.setLensRoamSnapshot(buildLensRoamSnapshot(g.tl));
        std::vector<VideoEvent> ev2 = {
            makeEvent(g.clipTrack, g.srcId, g.clip1, g.regA),
            makeEvent(g.patTrack, g.srcId, -1, g.regB),
        };
        auto& reqs = col.collectRequests(0, g.tl, 48000, fps, ev2);
        CHECK(reqs.size() == 2, "two cells (identity case)");
        for (const auto& r : reqs)
            CHECK(r.lens.isIdentity() && r.roam.isIdentity(), "identity params -> identity request");
    }

    f.tl.getClipMutable(f.clip1)->lens.base = someLens();
    f.tl.getTrackMutable(f.clipTrack)->roam.base = someRoam();
    LensParams srcLens; srcLens.zoom = 2.0f;
    f.tl.getTrackMutable(f.patTrack)->trackLens[f.regB] = LensTrack{ srcLens, {} };

    FrameCollector col;
    col.setLensRoamSnapshot(buildLensRoamSnapshot(f.tl));
    auto& reqs = col.collectRequests(0, f.tl, 48000, fps, events);
    CHECK(reqs.size() == 2, "two cells (values case)");
    for (const auto& r : reqs) {
        if (r.trackId == f.clipTrack) {
            CHECK(r.lens == someLens(), "clip cell carries its clip lens");
            CHECK(r.roam == someRoam(), "clip cell carries its track roam");
        } else if (r.trackId == f.patTrack) {
            CHECK(r.lens == srcLens, "pattern cell carries its source lens");
            CHECK(r.roam.isIdentity(), "pattern cell carries its (identity) roam");
        }
        // Lens/Roam ride alongside; nothing existing changed.
        CHECK(r.orientation == 0 && r.opacity == 1.0f, "flip/opacity untouched");
    }
}

// ─── [7] optional: a real project on disk ─────────────────────────────────────
// Set XLETH_LENS_ROAM_PROJECT to a project DIRECTORY (use a copy). It is
// loaded and re-saved next to itself as "<dir>_resaved", for a by-hand diff of
// the two project.json files. Skipped when unset, so this is not
// machine-specific. Never writes into the source directory.
static void test_real_project_resave() {
    const char* dir = std::getenv("XLETH_LENS_ROAM_PROJECT");
    if (!dir || !*dir) {
        std::cout << "[7] real project re-save: skip (XLETH_LENS_ROAM_PROJECT unset)\n";
        return;
    }
    std::cout << "[7] real project re-save: " << dir << "\n";
    ProjectManager pm;
    auto loaded = pm.loadProject(dir);
    CHECK(loaded.has_value(), "real project loads");
    if (!loaded) return;
    const std::string out = std::string(dir) + "_resaved";
    CHECK(pm.saveProjectAs(out, "resaved", *loaded, pm.getLoadedEffectChains(),
                           pm.getLoadedMasterEffectChain(), pm.getLoadedMasterVolume(),
                           pm.getLoadedSandboxWorkspace()),
          "real project re-saves");
    auto snap = buildLensRoamSnapshot(*loaded);
    const auto c = snap->counts();
    std::cout << "    snapshot: " << c.tracks << " tracks, " << c.clips << " clips, "
              << c.sources << " sources; non-identity roam/clip/source = "
              << c.roamNonIdentity << "/" << c.clipLensNonIdentity << "/"
              << c.sourceLensNonIdentity << "\n";
    if (pm.loadedSchemaVersion() < 8)
        CHECK(c.roamNonIdentity == 0 && c.clipLensNonIdentity == 0 && c.sourceLensNonIdentity == 0,
              "an old real project is identity for every track, clip and source");
}

// ─── [8] P2: the shared Lens/Roam evaluator (render/LensRoamMath.h) ──────────
// The compositor's ONLY geometry source for both preview and export. Pure CPU
// checks of the maps the shader applies.

static bool approxEq(float a, float b, float eps = 1e-4f) { return std::fabs(a - b) <= eps; }

static void test_p2_lens_math() {
    std::cout << "[8] P2 Lens UV map\n";
    using namespace lensroam;

    // Identity takes today's path: no framing pass at all.
    CHECK(!lensNeedsFraming(LensParams{}), "identity Lens needs no framing pass");
    LensParams flipOnly; flipOnly.flip = LensFlip::Horizontal;
    CHECK(!lensNeedsFraming(flipOnly), "a flip override alone is an orientation, not a framing pass");
    CHECK(lensNeedsFraming(LensParams::newContentDefault()), "Cover frames");

    // Stretch at zoom 1 maps local UV straight to source UV (16:9 source in a
    // 4:3 cell: aspect ignored, exactly today's stretch).
    {
        const LensUvMap m = computeLensUvMap(LensParams{}, 400.0f, 300.0f, 1920.0f, 1080.0f);
        float su, sv;
        applyLensUvMap(m, 0.0f, 0.0f, su, sv);   CHECK(approxEq(su, 0.0f) && approxEq(sv, 0.0f), "stretch (0,0)");
        applyLensUvMap(m, 1.0f, 1.0f, su, sv);   CHECK(approxEq(su, 1.0f) && approxEq(sv, 1.0f), "stretch (1,1)");
        applyLensUvMap(m, 0.3f, 0.7f, su, sv);   CHECK(approxEq(su, 0.3f) && approxEq(sv, 0.7f), "stretch (0.3,0.7)");
    }

    // Cover: 16:9 source in a square cell fills the height, crops the sides.
    // Visible source U span = (9/16) of the width, centred.
    {
        LensParams p; p.fit = LensFit::Cover;
        const LensUvMap m = computeLensUvMap(p, 300.0f, 300.0f, 1920.0f, 1080.0f);
        float su, sv;
        applyLensUvMap(m, 0.0f, 0.0f, su, sv);
        CHECK(approxEq(su, 0.5f - 0.5f * 1080.0f / 1920.0f) && approxEq(sv, 0.0f), "cover left/top edge");
        applyLensUvMap(m, 1.0f, 1.0f, su, sv);
        CHECK(approxEq(su, 0.5f + 0.5f * 1080.0f / 1920.0f) && approxEq(sv, 1.0f), "cover right/bottom edge");
    }

    // Contain: same pair letterboxes top/bottom: the cell's top edge is
    // OUTSIDE the source (v < 0 -> background).
    {
        LensParams p; p.fit = LensFit::Contain;
        const LensUvMap m = computeLensUvMap(p, 300.0f, 300.0f, 1920.0f, 1080.0f);
        float su, sv;
        applyLensUvMap(m, 0.5f, 0.0f, su, sv);
        CHECK(approxEq(su, 0.5f) && sv < 0.0f, "contain: top edge is letterbox");
        applyLensUvMap(m, 0.0f, 0.5f, su, sv);
        CHECK(approxEq(su, 0.0f) && approxEq(sv, 0.5f), "contain: left edge touches the source");
        const float barV = 0.5f - 0.5f * (1920.0f / 1080.0f);   // source v at the cell top
        CHECK(approxEq(sv, 0.5f) && approxEq(m.ty + m.m11 * 0.0f + m.m10 * 0.5f, barV, 1e-3f),
              "contain: letterbox height matches the aspect ratio");
    }

    // Zoom 2 about a moved centre shows half the source on each axis.
    {
        LensParams p; p.centerX = 0.25f; p.centerY = 0.75f; p.zoom = 2.0f;
        const LensUvMap m = computeLensUvMap(p, 640.0f, 360.0f, 1920.0f, 1080.0f);
        float su, sv;
        applyLensUvMap(m, 0.5f, 0.5f, su, sv);  CHECK(approxEq(su, 0.25f) && approxEq(sv, 0.75f), "centre lands at the cell centre");
        applyLensUvMap(m, 0.0f, 0.0f, su, sv);  CHECK(approxEq(su, 0.0f) && approxEq(sv, 0.5f), "zoom 2 halves the span");
        applyLensUvMap(m, 1.0f, 1.0f, su, sv);  CHECK(approxEq(su, 0.5f) && approxEq(sv, 1.0f), "zoom 2 far corner");
    }

    // Rotation is rigid in PIXELS: a 90 deg clockwise turn of a picture that
    // exactly covers a square cell sends the cell's top-right corner to the
    // source's top-left (the picture's top-left corner swung round to the
    // top-right).
    {
        LensParams p; p.fit = LensFit::Cover; p.rotationDeg = 90.0f;
        const LensUvMap m = computeLensUvMap(p, 200.0f, 200.0f, 1000.0f, 1000.0f);
        float su, sv;
        applyLensUvMap(m, 1.0f, 0.0f, su, sv);
        CHECK(approxEq(su, 0.0f) && approxEq(sv, 0.0f), "rot 90 cw: cell top-right samples source top-left");
        applyLensUvMap(m, 0.5f, 0.5f, su, sv);
        CHECK(approxEq(su, 0.5f) && approxEq(sv, 0.5f), "rotation is about the centre");
    }

    // Flip mapping: FollowTrack passes the state machine through.
    CHECK(effectiveOrientation(LensFlip::FollowTrack, 4) == 4, "FollowTrack keeps the track's orientation");
    CHECK(effectiveOrientation(LensFlip::None, 3) == 0, "None clears it");
    CHECK(effectiveOrientation(LensFlip::Horizontal, 2) == 1, "Horizontal overrides");
    CHECK(effectiveOrientation(LensFlip::Vertical, 1) == 2, "Vertical overrides");

    // Source size: a proxy within 2% of the source's aspect fits with the
    // SOURCE size (preview == export); another shape trusts the texture.
    float w, h;
    fitSourceSize(1920, 1080, 642, 360, w, h);
    CHECK(w == 1920.0f && h == 1080.0f, "proxy texture -> source size");
    fitSourceSize(1920, 1080, 480, 360, w, h);
    CHECK(w == 480.0f && h == 360.0f, "different-shape texture -> texture size");
    fitSourceSize(0, 0, 640, 360, w, h);
    CHECK(w == 640.0f && h == 360.0f, "unknown source -> texture size");
    fitSourceSize(1280, 720, 0, 0, w, h);
    CHECK(w == 1280.0f && h == 720.0f, "no texture size -> source size");
}

static void test_p2_roam_math() {
    std::cout << "[9] P2 Roam quad, inverse, scissor, draw order\n";
    using namespace lensroam;

    CHECK(!roamMovesCell(RoamParams{}) && !roamClipsToHome(RoamParams{}),
          "identity Roam moves nothing and clips nothing (bounce overshoot stays unclipped)");
    RoamParams layerOnly; layerOnly.layer = RoamLayer::Top;
    CHECK(!roamMovesCell(layerOnly) && !roamClipsToHome(layerOnly), "layer alone under Clip: today's draw");

    // Offset in cell units of the placement, then scale about the moved centre.
    {
        RoamParams r; r.offsetX = 0.5f; r.offsetY = -0.3f; r.scale = 2.0f; r.rotationDeg = 10.0f;
        const UvRect home{ 0.25f, 0.5f, 0.25f, 0.25f };
        float rot = 0.0f;
        const UvRect q = roamCellRect(r, home, 0.25f, 0.25f, rot);
        CHECK(approxEq(q.w, 0.5f) && approxEq(q.h, 0.5f), "scale 2 doubles the rect");
        CHECK(approxEq(q.x + q.w * 0.5f, 0.25f + 0.125f + 0.125f), "centre x moved by half a cell");
        CHECK(approxEq(q.y + q.h * 0.5f, 0.5f + 0.125f - 0.075f), "centre y moved by -0.3 cell");
        CHECK(approxEq(rot, 10.0f * 3.14159265f / 180.0f), "rotation returned in radians");
    }

    // Inverse affine: rect corners/centre map back to local 0..1, rigidly in
    // pixels on a non-square output.
    {
        const UvRect rect{ 0.25f, 0.25f, 0.5f, 0.5f };
        const RoamInverse i0 = computeRoamInverse(rect, 0.0f, 1920.0f, 1080.0f);
        auto loc = [](const RoamInverse& i, float u, float v, float& lu, float& lv) {
            lu = i.r00 * u + i.r01 * v + i.r02;
            lv = i.r10 * u + i.r11 * v + i.r12;
        };
        float lu, lv;
        loc(i0, 0.25f, 0.25f, lu, lv); CHECK(approxEq(lu, 0.0f) && approxEq(lv, 0.0f), "unrotated top-left");
        loc(i0, 0.75f, 0.75f, lu, lv); CHECK(approxEq(lu, 1.0f) && approxEq(lv, 1.0f), "unrotated bottom-right");

        const RoamInverse i90 = computeRoamInverse(rect, 3.14159265f * 0.5f, 1920.0f, 1080.0f);
        loc(i90, 0.5f, 0.5f, lu, lv);  CHECK(approxEq(lu, 0.5f) && approxEq(lv, 0.5f), "centre is fixed");
        // 90 deg clockwise on screen: the rect's local top-centre (0.5, 0)
        // swings to the right of the centre by half the rect HEIGHT in pixels.
        const float halfHpx = 0.5f * 0.5f * 1080.0f;
        loc(i90, 0.5f + halfHpx / 1920.0f, 0.5f, lu, lv);
        CHECK(approxEq(lu, 0.5f, 1e-3f) && approxEq(lv, 0.0f, 1e-3f), "rot 90 cw: top edge swings to the right, rigidly");
    }

    // Scissor rounds each edge to the nearest pixel and clamps to the frame.
    {
        const PixelRect p = homeScissor(UvRect{ 0.25f, 0.5f, 0.25f, 0.5f }, 1920, 1080);
        CHECK(p.left == 480 && p.top == 540 && p.right == 960 && p.bottom == 1080, "home scissor pixels");
        const PixelRect c = homeScissor(UvRect{ -0.5f, -0.5f, 2.0f, 2.0f }, 100, 50);
        CHECK(c.left == 0 && c.top == 0 && c.right == 100 && c.bottom == 50, "scissor clamps");
    }

    // Draw-order key: only Float honours the layer.
    {
        RoamParams fl; fl.bounds = RoamBounds::Float;
        fl.layer = RoamLayer::Top;             CHECK(effectiveRoamLayer(fl) == RoamLayer::Top, "float top");
        RoamParams cl = fl; cl.bounds = RoamBounds::Clip;
        CHECK(effectiveRoamLayer(cl) == RoamLayer::GridOrder, "clip ignores layer");
        RoamParams ab = fl; ab.layer = RoamLayer::AboveNeighbours;
        CHECK(roamDrawKey(RoamParams{}, 5, 9) < roamDrawKey(ab, 0, 9), "above-neighbours sorts after the top grid cell");
        CHECK(roamDrawKey(ab, 0, 9) < roamDrawKey(RoamParams{}, 10, 9), "...but under a layer stacked above the grid");
        CHECK(roamDrawKey(RoamParams{}, 1000, 9) < roamDrawKey(fl, -5, 9), "top sorts after everything");
    }
}

// The collector's single sort honours Float layers and leaves every other
// case in today's zOrder order.
static void test_p2_collector_order() {
    std::cout << "[10] P2 draw order through the collector\n";
    Fixture f;
    buildFixture(f);
    std::vector<VideoEvent> events = {
        makeEvent(f.clipTrack, f.srcId, f.clip1, f.regA),
        makeEvent(f.patTrack, f.srcId, -1, f.regB),
    };
    const AVRational fps{ 30, 1 };
    auto orderFor = [&](const RoamParams& clipRoam) {
        f.tl.getTrackMutable(f.clipTrack)->roam.base = clipRoam;
        FrameCollector col;
        col.setLensRoamSnapshot(buildLensRoamSnapshot(f.tl));
        auto& reqs = col.collectRequests(0, f.tl, 48000, fps, events);
        std::vector<int> ids;
        for (const auto& r : reqs) ids.push_back(r.trackId);
        return ids;
    };
    const std::vector<int> today = { f.clipTrack, f.patTrack };   // zOrder 0, 1
    const std::vector<int> raised = { f.patTrack, f.clipTrack };

    CHECK(orderFor(RoamParams{}) == today, "identity: zOrder order");
    RoamParams r; r.offsetX = 0.5f;
    r.layer = RoamLayer::Top;  r.bounds = RoamBounds::Clip;
    CHECK(orderFor(r) == today, "Clip ignores the layer");
    r.bounds = RoamBounds::Float; r.layer = RoamLayer::GridOrder;
    CHECK(orderFor(r) == today, "Float + GridOrder keeps zOrder order");
    r.layer = RoamLayer::AboveNeighbours;
    CHECK(orderFor(r) == raised, "Float + AboveNeighbours draws over the neighbour");
    r.layer = RoamLayer::Top;
    CHECK(orderFor(r) == raised, "Float + Top draws last");

    // Each request carries its source's own pixel size for the Lens fit.
    f.tl.getTrackMutable(f.clipTrack)->roam.base = RoamParams{};
    FrameCollector col;
    auto& reqs = col.collectRequests(0, f.tl, 48000, fps, events);
    for (const auto& q : reqs)
        CHECK(q.sourcePixelW == 1920 && q.sourcePixelH == 1080, "request carries the source pixel size");
}

// The dev verification hook forces values in the SNAPSHOT (the one builder
// preview and export share), never in the model.
static void test_p2_dev_hook() {
    std::cout << "[11] P2 dev hook (XLETH_DEV_LENS_ROAM_TRACK)\n";
    // The hook is compiled into XlethEngineModel (built with XLETH_DEBUG, as
    // every engine/bridge target is); this test target itself does not define
    // the macro, so no #ifdef here.
    Fixture f;
    buildFixture(f);
    _putenv_s("XLETH_DEV_LENS_ROAM_TRACK", std::to_string(f.clipTrack).c_str());
    _putenv_s("XLETH_DEV_LENS_ROAM_LAYER", "top");
    auto snap = buildLensRoamSnapshot(f.tl);
    _putenv_s("XLETH_DEV_LENS_ROAM_TRACK", "");
    _putenv_s("XLETH_DEV_LENS_ROAM_LAYER", "");

    const RoamParams r = snap->roamFor(f.clipTrack);
    CHECK(r.offsetX == 0.5f && r.offsetY == -0.3f && r.bounds == RoamBounds::Float
          && r.layer == RoamLayer::Top, "hooked track: roam offset (0.5,-0.3) Float");
    const LensParams l = snap->lensForClip(f.clip1);
    CHECK(l.zoom == 1.5f && l.rotationDeg == 10.0f, "hooked track: clip lens zoom 1.5, rot 10");
    CHECK(snap->roamFor(f.patTrack).isIdentity(), "other tracks untouched");
    CHECK(f.tl.getTrack(f.clipTrack)->roam.base.isIdentity(), "model untouched");
    auto plain = buildLensRoamSnapshot(f.tl);
    CHECK(plain->roamFor(f.clipTrack).isIdentity(), "hook off -> real values");
}

// P3: the three undo commands the bridge builds. Whole-base swaps; a source
// with no trackLens entry must come back ABSENT on undo (it then resolves to
// newContentDefault again), not as a materialised entry.
static void test_p3_commands() {
    std::cout << "[12] P3 undo commands\n";
    Fixture f;
    buildFixture(f);
    UndoManager um;

    // Clip Lens
    const LensParams clipBefore = f.tl.getClip(f.clip1)->lens.base;
    LensParams l = clipBefore;
    l.zoom = 1.5f; l.centerX = 0.25f; l.flip = LensFlip::Horizontal;
    um.execute(std::make_unique<SetClipLensCommand>(f.clip1, l, f.tl), f.tl);
    CHECK(f.tl.getClip(f.clip1)->lens.base == l, "setClipLens writes the base");
    CHECK(buildLensRoamSnapshot(f.tl)->lensForClip(f.clip1) == l, "snapshot sees the clip lens");
    CHECK(f.tl.getClip(f.clip2)->lens.base == clipBefore, "other clip untouched");
    um.undo(f.tl);
    CHECK(f.tl.getClip(f.clip1)->lens.base == clipBefore, "undo restores the clip lens");
    um.redo(f.tl);
    CHECK(f.tl.getClip(f.clip1)->lens.base == l, "redo re-applies the clip lens");

    // Track (source) Lens on a source with no entry
    const TrackInfo* pt = f.tl.getTrack(f.patTrack);
    CHECK(pt->trackLens.count(f.regA) == 0, "fixture source starts with no entry");
    LensParams s = lensroam::resolveSourceLens(*pt, f.regA);
    s.zoom = 2.0f; s.rotationDeg = 15.0f;
    um.execute(std::make_unique<SetTrackLensCommand>(f.patTrack, f.regA, s, f.tl), f.tl);
    pt = f.tl.getTrack(f.patTrack);
    CHECK(pt->trackLens.count(f.regA) == 1 && pt->trackLens.at(f.regA).base == s,
          "setTrackLens materialises the entry");
    CHECK(buildLensRoamSnapshot(f.tl)->lensForSource(f.patTrack, f.regA) == s,
          "snapshot sees the source lens");
    CHECK(lensroam::resolveSourceLens(*pt, f.regB) == LensParams::newContentDefault(),
          "other source untouched");
    um.undo(f.tl);
    pt = f.tl.getTrack(f.patTrack);
    CHECK(pt->trackLens.count(f.regA) == 0, "undo erases the entry it created");
    um.redo(f.tl);
    CHECK(f.tl.getTrack(f.patTrack)->trackLens.at(f.regA).base == s, "redo re-creates it");

    // Track Lens on an existing entry keeps its hit curve
    LensKey k; k.channel = LensChannel::Zoom; k.anchor = KeyAnchor::Head; k.pos = 0; k.value = 1.35;
    f.tl.getTrackMutable(f.patTrack)->trackLens[f.regB] = LensTrack{ LensParams{}, { k } };
    LensParams s2; s2.centerY = 0.75f;
    um.execute(std::make_unique<SetTrackLensCommand>(f.patTrack, f.regB, s2, f.tl), f.tl);
    CHECK(f.tl.getTrack(f.patTrack)->trackLens.at(f.regB).keys.size() == 1,
          "setTrackLens keeps an existing entry's hit curve");
    um.undo(f.tl);
    CHECK(f.tl.getTrack(f.patTrack)->trackLens.at(f.regB).base == LensParams{},
          "undo restores the existing entry");

    // Roam + reset
    RoamParams r; r.offsetX = 0.5f; r.scale = 0.8f; r.bounds = RoamBounds::Float;
    um.execute(std::make_unique<SetTrackRoamCommand>(f.clipTrack, r, f.tl), f.tl);
    CHECK(f.tl.getTrack(f.clipTrack)->roam.base == r, "setTrackRoam writes the base");
    CHECK(buildLensRoamSnapshot(f.tl)->roamFor(f.clipTrack) == r, "snapshot sees the roam");
    um.execute(std::make_unique<SetTrackRoamCommand>(f.clipTrack, RoamParams{}, f.tl, true), f.tl);
    CHECK(f.tl.getTrack(f.clipTrack)->roam.base.isIdentity(), "reset roam = identity");
    um.undo(f.tl);
    CHECK(f.tl.getTrack(f.clipTrack)->roam.base == r, "undo of reset restores the roam");
    um.undo(f.tl);
    CHECK(f.tl.getTrack(f.clipTrack)->roam.base.isIdentity(), "undo of set restores identity");
}

// ─── [13] P5: per-note Lens override plumbing ─────────────────────────────────
// The override lives on PatternNote, so the spec's {patternId, noteId} key is
// the note's own address. Every note path must carry it: the dummy override set
// on ONE note has to survive move, quantize, an edit of a DIFFERENT note,
// undo/redo, copy/paste, Make Unique Copy and save/load, on that note only.

static LensNoteOverridePtr dummyOverride() {
    auto o = std::make_shared<LensNoteOverride>();
    o->mode = LensOverrideMode::Own;
    LensKey k;
    k.channel = LensChannel::Zoom; k.anchor = KeyAnchor::Head; k.pos = 0.0; k.value = 1.35;
    o->keys.push_back(k);
    k.anchor = KeyAnchor::Tail; k.pos = 240.0; k.value = 1.0;
    o->keys.push_back(k);
    return o;
}

static bool isDummy(const LensNoteOverridePtr& o) {
    return o && o->mode == LensOverrideMode::Own && o->keys.size() == 2
        && o->keys[0].anchor == KeyAnchor::Head && o->keys[0].value == 1.35
        && o->keys[1].anchor == KeyAnchor::Tail && o->keys[1].pos == 240.0;
}

static const PatternNote* findNote(const Timeline& tl, int patternId, int noteId) {
    const Pattern* p = tl.getPattern(patternId);
    if (!p) return nullptr;
    for (const auto& n : p->notes) if (n.id == noteId) return &n;
    return nullptr;
}

// Count the notes of one pattern that carry an override.
static int overrideCount(const Timeline& tl, int patternId) {
    const Pattern* p = tl.getPattern(patternId);
    int c = 0;
    if (p) for (const auto& n : p->notes) if (n.lensOverride) ++c;
    return c;
}

// What the piano roll does for every compound edit: the WHOLE list after the
// edit, round-tripped through JSON (the UI never holds C++ notes), committed
// as one EditPatternNotesCommand.
static std::vector<PatternNote> viaJson(const std::vector<PatternNote>& notes) {
    json j = notes;
    return j.get<std::vector<PatternNote>>();
}

static void test_p5_note_override() {
    std::cout << "[13] P5 per-note Lens override plumbing\n";

    // JSON shape
    {
        PatternNote plain;
        plain.id = 3; plain.duration = TickTime{ 240 };
        json jp = plain;
        CHECK(!jp.contains("lensOverride"), "a Follow note writes no lensOverride key");
        CHECK(!jp.get<PatternNote>().lensOverride, "and loads back as Follow");

        PatternNote with = plain;
        with.lensOverride = dummyOverride();
        json jw = with;
        CHECK(jw.contains("lensOverride") && jw["lensOverride"]["mode"] == "Own"
              && jw["lensOverride"]["keys"].size() == 2, "override written {mode, keys}");
        CHECK(isDummy(jw.get<PatternNote>().lensOverride), "override round-trips exactly");

        json old = { {"id", 1}, {"positionTicks", 0}, {"durationTicks", 240},
                     {"pitch", 60}, {"velocity", 1.0} };
        CHECK(!old.get<PatternNote>().lensOverride, "pre-P5 note JSON loads with none");

        CHECK(!lensroam::lensNoteOverrideFromJson(json(nullptr)), "null -> Follow");
        CHECK(!lensroam::lensNoteOverrideFromJson(json::array()), "non-object -> Follow");
        CHECK(!lensroam::lensNoteOverrideFromJson(json{ {"keys", json::array()} }), "no mode -> Follow");
        CHECK(!lensroam::lensNoteOverrideFromJson(json{ {"mode", "Follow"} }), "unknown mode -> Follow");
        auto nudge = lensroam::lensNoteOverrideFromJson(json{ {"mode", "Nudge"} });
        CHECK(nudge && nudge->mode == LensOverrideMode::Nudge && nudge->keys.empty(),
              "Nudge with no keys is kept as stored");
    }

    Fixture f;
    buildFixture(f);
    UndoManager um;

    // Three notes in pattern A, three in pattern B: same ids 1..3 in both,
    // so the {patternId, noteId} key is what tells them apart.
    for (int pid : { f.patternA, f.patternB }) {
        for (int i = 0; i < 3; ++i) {
            PatternNote n;
            n.position = TickTime{ 960 * i + 13 };   // off-grid on purpose (quantize)
            n.duration = TickTime{ 240 };
            n.pitch = 60 + i;
            f.tl.addNoteToPattern(pid, n);
        }
    }
    const int target = f.tl.getPattern(f.patternA)->notes[1].id;
    const int other  = f.tl.getPattern(f.patternA)->notes[0].id;
    CHECK(target == f.tl.getPattern(f.patternB)->notes[1].id, "fixture: same note id in both patterns");

    // Dev-hook path: set it on ONE note with the whole-list edit.
    {
        auto notes = f.tl.getPattern(f.patternA)->notes;
        for (auto& n : notes) if (n.id == target) n.lensOverride = dummyOverride();
        um.execute(std::make_unique<EditPatternNotesCommand>(f.patternA, viaJson(notes), f.tl), f.tl);
    }
    CHECK(isDummy(findNote(f.tl, f.patternA, target)->lensOverride), "set on the target note");
    CHECK(overrideCount(f.tl, f.patternA) == 1, "only the target note has one");
    CHECK(overrideCount(f.tl, f.patternB) == 0, "same note id in pattern B untouched");

    // Move (drag path: per-id RPC) and batch move.
    um.execute(std::make_unique<MoveNoteCommand>(f.patternA, target, TickTime{ 2000 }, 72, f.tl), f.tl);
    CHECK(findNote(f.tl, f.patternA, target)->position.ticks == 2000
          && isDummy(findNote(f.tl, f.patternA, target)->lensOverride), "survives move");
    um.execute(std::make_unique<MoveNotesBatchCommand>(f.patternA,
        std::vector<MoveNotesBatchCommand::Move>{ { target, TickTime{ 2017 }, 71 }, { other, TickTime{ 5 }, 60 } },
        f.tl), f.tl);
    CHECK(isDummy(findNote(f.tl, f.patternA, target)->lensOverride), "survives batch move");

    // Quantize (piano roll: whole list, positions snapped, ids kept).
    {
        auto notes = f.tl.getPattern(f.patternA)->notes;
        for (auto& n : notes) n.position.ticks = (n.position.ticks + 120) / 240 * 240;
        um.execute(std::make_unique<EditPatternNotesCommand>(f.patternA, viaJson(notes), f.tl), f.tl);
    }
    CHECK(findNote(f.tl, f.patternA, target)->position.ticks == 1920
          && isDummy(findNote(f.tl, f.patternA, target)->lensOverride), "survives quantize");

    // Edit a DIFFERENT note (velocity of `other`).
    {
        auto notes = f.tl.getPattern(f.patternA)->notes;
        for (auto& n : notes) if (n.id == other) n.velocity = 0.25f;
        um.execute(std::make_unique<EditPatternNotesCommand>(f.patternA, viaJson(notes), f.tl), f.tl);
    }
    CHECK(findNote(f.tl, f.patternA, other)->velocity == 0.25f, "other note edited");
    CHECK(isDummy(findNote(f.tl, f.patternA, target)->lensOverride), "survives an edit of another note");
    CHECK(overrideCount(f.tl, f.patternA) == 1, "and did not spread to it");

    // Undo / redo across the whole chain (edit, quantize, batch move, move, set).
    um.undo(f.tl); um.undo(f.tl); um.undo(f.tl); um.undo(f.tl);
    CHECK(isDummy(findNote(f.tl, f.patternA, target)->lensOverride)
          && findNote(f.tl, f.patternA, target)->position.ticks == 973, "undo to just after the set: kept");
    um.undo(f.tl);
    CHECK(!findNote(f.tl, f.patternA, target)->lensOverride, "undo the set: Follow again");
    for (int i = 0; i < 5; ++i) um.redo(f.tl);
    CHECK(isDummy(findNote(f.tl, f.patternA, target)->lensOverride)
          && findNote(f.tl, f.patternA, target)->position.ticks == 1920
          && findNote(f.tl, f.patternA, other)->velocity == 0.25f, "redo all: back on the target");

    // Copy/paste and duplicate: copies are new notes (id 0) carrying the field.
    {
        auto notes = f.tl.getPattern(f.patternA)->notes;
        PatternNote copy = *findNote(f.tl, f.patternA, target);
        copy.id = 0;
        copy.position.ticks += 3840;
        notes.push_back(copy);
        um.execute(std::make_unique<EditPatternNotesCommand>(f.patternA, viaJson(notes), f.tl), f.tl);
    }
    {
        const auto& ns = f.tl.getPattern(f.patternA)->notes;
        const PatternNote& pasted = ns.back();
        CHECK(pasted.id != target && pasted.id > 0, "paste got a new id");
        CHECK(isDummy(pasted.lensOverride), "paste carries the override to the new id");
        CHECK(isDummy(findNote(f.tl, f.patternA, target)->lensOverride), "original keeps its own");
        CHECK(overrideCount(f.tl, f.patternA) == 2, "exactly original + copy");
    }

    // Delete drops it; undo brings it back with the note.
    um.execute(std::make_unique<RemoveNoteCommand>(f.patternA, target, f.tl), f.tl);
    CHECK(!findNote(f.tl, f.patternA, target) && overrideCount(f.tl, f.patternA) == 1,
          "delete drops the note and its override");
    um.undo(f.tl);
    CHECK(isDummy(findNote(f.tl, f.patternA, target)->lensOverride), "undo of delete restores it");
    um.undo(f.tl);  // un-paste
    CHECK(overrideCount(f.tl, f.patternA) == 1, "undo of paste removes the copy's");

    // Make Unique Copy: new pattern + addNotesBatch (fresh ids, list order).
    Pattern np;
    np.name = "A (copy)";
    np.regionId = f.regA;
    np.length = f.tl.getPattern(f.patternA)->length;
    const int uniqueId = f.tl.addPattern(np);
    std::vector<PatternNote> batch = f.tl.getPattern(f.patternA)->notes;
    for (auto& n : batch) n.id = 0;
    um.execute(std::make_unique<AddNotesBatchCommand>(uniqueId, viaJson(batch)), f.tl);
    {
        const auto& src = f.tl.getPattern(f.patternA)->notes;
        const auto& dst = f.tl.getPattern(uniqueId)->notes;
        bool sameOrder = src.size() == dst.size();
        for (size_t i = 0; sameOrder && i < src.size(); ++i)
            sameOrder = (src[i].lensOverride != nullptr) == (dst[i].lensOverride != nullptr)
                     && src[i].position.ticks == dst[i].position.ticks;
        CHECK(sameOrder, "unique copy: every override on the matching new note");
        CHECK(overrideCount(f.tl, uniqueId) == 1, "unique copy: exactly one override");
    }
    um.undo(f.tl);
    CHECK(f.tl.getPattern(uniqueId)->notes.empty(), "undo of the copy batch empties it");
    um.redo(f.tl);
    CHECK(overrideCount(f.tl, uniqueId) == 1, "redo of the copy batch keeps the override");

    // Save / load through ProjectManager.
    const fs::path dir = freshDir("p5_note_override");
    ProjectManager pm;
    CHECK(pm.createProject(dir.string(), "lens_note_override"), "createProject");
    CHECK(pm.saveProject(f.tl), "saveProject");
    ProjectManager pm2;
    auto loaded = pm2.loadProject(dir.string());
    CHECK(loaded.has_value(), "project loads");
    if (loaded) {
        const Timeline& tl = *loaded;
        CHECK(isDummy(findNote(tl, f.patternA, target)->lensOverride), "load: target keeps it");
        CHECK(overrideCount(tl, f.patternA) == 1, "load: pattern A has exactly one");
        CHECK(overrideCount(tl, f.patternB) == 0, "load: pattern B (same ids) has none");
        CHECK(overrideCount(tl, uniqueId) == 1, "load: unique copy keeps its one");
        CHECK(findNote(tl, f.patternA, other)->velocity == 0.25f, "load: other edits intact");
    }

    // An old project (no lensOverride keys anywhere) loads with none.
    {
        const fs::path file = dir / "project.json";
        json j = readJson(file);
        int stripped = 0;
        std::function<void(json&)> strip = [&](json& v) {
            if (v.is_object()) {
                if (v.erase("lensOverride")) ++stripped;
                for (auto& c : v) strip(c);
            } else if (v.is_array()) {
                for (auto& c : v) strip(c);
            }
        };
        strip(j);
        CHECK(stripped == 2, "saved file held exactly the two overrides");
        writeJson(file, j);
        ProjectManager pm3;
        auto old = pm3.loadProject(dir.string());
        CHECK(old.has_value(), "old-shape project loads");
        if (old) {
            int any = 0;
            for (const auto& [pid, p] : old->getAllPatterns())
                for (const auto& n : p.notes) if (n.lensOverride) ++any;
            CHECK(any == 0, "old project: no note has an override");
        }
    }
}

// ─── [14..18] P7: keys evaluated through the shared curve engine ─────────────
// model/KeyCurve.h is tested on its own (test_key_curve). Here: the snapshot
// compiles the stored keys correctly, the collector feeds every lookup the
// right clock (clip start, note-on + CLAMPED length, timeline tick), the
// values blend per the spec, and preview and export agree frame for frame.

using xleth::keycurve::Interp;
using xleth::keycurve::NoteZones;
using xleth::keycurve::ShortNoteRule;
using xleth::keycurve::TimeBase;

static LensKey lensKey(LensChannel ch, KeyAnchor a, double pos, double value,
                       Interp interp = Interp::Linear) {
    LensKey k;
    k.channel = ch; k.anchor = a; k.pos = pos; k.value = value; k.interp = interp;
    return k;
}

static RoamKey roamKey(RoamChannel ch, double pos, double value, Interp interp = Interp::Linear) {
    RoamKey k;
    k.channel = ch; k.anchor = KeyAnchor::Origin; k.pos = pos; k.value = value; k.interp = interp;
    return k;
}

// Spec preset "Punch + drift": Head 0 1.35 -> Head 120 1.08 -> Tail 240 1.20
// -> Tail 0 1.00, the punch easing out.
static std::vector<LensKey> punchDriftCurve() {
    return {
        lensKey(LensChannel::Zoom, KeyAnchor::Head, 0,   1.35, Interp::EaseOut),
        lensKey(LensChannel::Zoom, KeyAnchor::Head, 120, 1.08),
        lensKey(LensChannel::Zoom, KeyAnchor::Tail, 240, 1.20),
        lensKey(LensChannel::Zoom, KeyAnchor::Tail, 0,   1.00),
    };
}

// The generic engine's value for a hit-curve channel, as the reference.
static double hitLayer(const std::vector<LensKey>& stored, LensChannel ch, const NoteZones& z,
                       double noteLen, double t, double identity) {
    std::vector<xleth::keycurve::Key> k;
    for (const auto& s : stored)
        if (s.channel == ch) k.push_back(lensroam::toCurveKey(s, TimeBase::EventTicks));
    xleth::keycurve::compileNoteKeys(k, z);
    return xleth::keycurve::valueAtNote(k.data(), k.size(), xleth::keycurve::noteSpan(noteLen, z),
                                        t, identity);
}

// At 140 BPM / 960 PPQ the timeline runs 2240 ticks a second: at this frame
// rate frame N IS tick N, so tests can address ticks directly.
static const AVRational kTickFps{ 2240, 1 };

static const CellFrameRequest* reqFor(const std::vector<CellFrameRequest>& reqs, int trackId) {
    for (const auto& r : reqs) if (r.trackId == trackId) return &r;
    return nullptr;
}

static bool feq(float a, float b, float eps = 1e-5f) { return std::fabs(a - b) <= eps; }

// Pattern B (on regB) plays in block B at [3840, 7680). Four notes; the last
// overruns the block and is clamped to 240 ticks.
//   A  note-on 3840, 960    B  4800, 180 (short)   C  5760, 300 (short)
//   D  7440, 240 (raw 960, clamped at the block end)
static void addHitNotes(Fixture& f) {
    const int64_t pos[] = { 0, 960, 1920, 3600 };
    const int64_t dur[] = { 960, 180, 300, 960 };
    for (int i = 0; i < 4; ++i) {
        PatternNote n;
        n.position = TickTime{ pos[i] };
        n.duration = TickTime{ dur[i] };
        n.pitch = 60 + i;
        f.tl.addNoteToPattern(f.patternB, n);
    }
    // Adding D grew the pattern, and the block-length cascade stretched its
    // blocks with it. Pin block B back to [3840, 7680) so D overruns it.
    for (const PatternBlock* b : f.tl.getPatternBlocksOnTrack(f.patTrack))
        if (b->patternId == f.patternB) f.tl.resizePatternBlock(b->id, TickTime{ 3840 });
}

static void test_p7_snapshot_compile() {
    std::cout << "[14] P7 snapshot compiles sorted key runs\n";
    Fixture f;
    buildFixture(f);

    Clip* c1 = f.tl.getClipMutable(f.clip1);
    c1->lens.keys = {
        lensKey(LensChannel::Zoom,    KeyAnchor::Origin, 960, 2.0),
        lensKey(LensChannel::Zoom,    KeyAnchor::Origin, 0,   1.0),
        lensKey(LensChannel::Zoom,    KeyAnchor::Origin, 480, 0.0),  // zoom <= 0: dropped
        lensKey(LensChannel::Zoom,    KeyAnchor::Head,   0,   1.5),  // note anchor on a clip: dropped
        lensKey(LensChannel::CenterX, KeyAnchor::Origin, 0,   0.25),
    };
    TrackInfo* ct = f.tl.getTrackMutable(f.clipTrack);
    ct->roam.keys = {
        roamKey(RoamChannel::OffsetX, 1920, 1.0),
        roamKey(RoamChannel::OffsetX, 0,    0.0),
        roamKey(RoamChannel::Scale,   0,   -1.0),                    // scale <= 0: dropped
    };
    LensTrack src;
    src.keys = punchDriftCurve();
    std::reverse(src.keys.begin(), src.keys.end());                 // stored out of order
    src.keys.push_back(lensKey(LensChannel::Zoom, KeyAnchor::Origin, 0, 3.0));  // not a note anchor
    f.tl.getTrackMutable(f.patTrack)->trackLens[f.regB] = src;

    auto s = buildLensRoamSnapshot(f.tl);
    CHECK(s->counts().keys == 3 + 2 + 4, "9 keys compiled; 4 malformed or misplaced ones dropped");

    const LensRoamSnapshot::ClipEntry* c1e = nullptr;
    const LensRoamSnapshot::ClipEntry* c2e = nullptr;
    for (const auto& e : s->clips) {
        if (e.clipId == f.clip1) c1e = &e;
        if (e.clipId == f.clip2) c2e = &e;
    }
    CHECK(c1e && c1e->keyed && c2e && !c2e->keyed, "keyed flags per clip");
    if (c1e) {
        const auto& z = c1e->lensKeys[static_cast<int>(LensChannel::Zoom)];
        CHECK(z.count == 2 && s->keys[z.first].position.v == 0.0
              && s->keys[z.first + 1].position.v == 960.0
              && s->keys[z.first].position.base == TimeBase::EventTicks,
              "clip zoom run: sorted by event tick");
        CHECK(c1e->lensKeys[static_cast<int>(LensChannel::CenterX)].count == 1
              && c1e->lensKeys[static_cast<int>(LensChannel::CenterY)].count == 0
              && c1e->lensKeys[static_cast<int>(LensChannel::RotationDeg)].count == 0,
              "one run per channel");
    }

    const LensRoamSnapshot::TrackEntry* cte = nullptr;
    const LensRoamSnapshot::TrackEntry* pte = nullptr;
    for (const auto& e : s->tracks) {
        if (e.trackId == f.clipTrack) cte = &e;
        if (e.trackId == f.patTrack)  pte = &e;
    }
    CHECK(cte && cte->roamKeyed && pte && !pte->roamKeyed, "roamKeyed per track");
    if (cte) {
        const auto& x = cte->roamKeys[static_cast<int>(RoamChannel::OffsetX)];
        CHECK(x.count == 2 && s->keys[x.first].position.v == 0.0
              && s->keys[x.first + 1].position.v == 1920.0
              && s->keys[x.first].position.base == TimeBase::TimelineTicks,
              "roam offsetX run: sorted by timeline tick");
        CHECK(cte->roamKeys[static_cast<int>(RoamChannel::Scale)].count == 0,
              "the only scale key was <= 0 and was dropped");
    }

    const LensRoamSnapshot::SourceEntry* se = nullptr;
    for (const auto& e : s->sources)
        if (e.trackId == f.patTrack && e.regionId == f.regB) se = &e;
    CHECK(se && se->keyed && se->zones == NoteZones{}, "keyed source, default zones");
    if (se) {
        const auto& z = se->hitCurve[static_cast<int>(LensChannel::Zoom)];
        const double want[] = { 1.35, 1.08, 1.20, 1.00 };
        bool ok = z.count == 4;
        for (uint32_t i = 0; ok && i < 4; ++i) ok = s->keys[z.first + i].value == want[i];
        CHECK(ok, "hit curve run in canonical order: Head 0, Head 120, Tail 240, Tail 0");
        CHECK(z.count == 4 && s->keys[z.first].position.base == TimeBase::NoteHead
              && s->keys[z.first + 3].position.base == TimeBase::NoteTail,
              "hit curve keys carry their note anchors");
    }
    CHECK(s->lensForClip(f.clip1) == f.tl.getClip(f.clip1)->lens.base,
          "base lookups are unchanged by keys");
}

static void test_p7_clip_keys() {
    std::cout << "[15] P7 clip lens keys run on event ticks (absolute)\n";
    Fixture f;
    buildFixture(f);
    Clip* c2 = f.tl.getClipMutable(f.clip2);       // [3840, 7680)
    c2->lens.base = LensParams{};
    c2->lens.base.centerY = 0.3f;
    c2->lens.keys = {
        lensKey(LensChannel::Zoom,        KeyAnchor::Origin, 0,    1.0),
        lensKey(LensChannel::Zoom,        KeyAnchor::Origin, 960,  2.0),
        lensKey(LensChannel::RotationDeg, KeyAnchor::Origin, 480,  10.0, Interp::Hold),
        lensKey(LensChannel::RotationDeg, KeyAnchor::Origin, 1440, 20.0),
    };
    auto s = buildLensRoamSnapshot(f.tl);

    LensRoamSnapshot::EventClock c;
    c.eventStartTick = 3840; c.eventLenTicks = 3840;
    auto at = [&](double tick) { c.frameTick = tick; return s->lensForEventAt(f.clipTrack, f.clip2, f.regB, c); };
    LensParams p = at(3840 + 480);
    CHECK(p.zoom == 1.5f && p.rotationDeg == 10.0f, "event tick 480: zoom 1.5 (linear), rotation on its key");
    CHECK(p.centerY == 0.3f && p.centerX == 0.5f, "unkeyed channels hold the base");
    CHECK(at(3840 + 960).zoom == 2.0f && at(3840 + 1439).rotationDeg == 10.0f,
          "Hold keeps 10 until the next key");
    CHECK(at(3840 + 1440).rotationDeg == 20.0f, "next key reached");
    CHECK(at(3840).zoom == 1.0f && at(3840).rotationDeg == 10.0f, "clip start: first keys' values");

    c.eventStartTick = 7680;
    CHECK(at(7680 + 480).zoom == 1.5f, "keys move with the event (start 7680)");

    // Through the real builder and collector.
    auto built = xleth::videoevents::build(f.tl, 140.0, 48000.0);
    const VideoEvent* ev = nullptr;
    for (const auto& e : built.events) if (e.clipId == f.clip2) ev = &e;
    CHECK(ev && ev->hasTickSpan && ev->startTick == 3840.0 && ev->lengthTicks == 3840.0,
          "clip event carries its exact tick span");
    FrameCollector col;
    col.setLensRoamSnapshot(s);
    auto& reqs = col.collectRequests(3840 + 480, f.tl, 48000, kTickFps, built.events);
    const CellFrameRequest* r = reqFor(reqs, f.clipTrack);
    CHECK(r && r->lens.zoom == 1.5f && r->lens.rotationDeg == 10.0f && r->lens.centerY == 0.3f,
          "collector: the clip cell is keyed at its event tick");

    // Move the clip: same picture, 3840 ticks later.
    f.tl.getClipMutable(f.clip2)->position = TickTime{ 7680 };
    auto moved = xleth::videoevents::build(f.tl, 140.0, 48000.0);
    FrameCollector col2;
    col2.setLensRoamSnapshot(buildLensRoamSnapshot(f.tl));
    auto& reqs2 = col2.collectRequests(7680 + 480, f.tl, 48000, kTickFps, moved.events);
    const CellFrameRequest* r2 = reqFor(reqs2, f.clipTrack);
    CHECK(r2 && r2->lens.zoom == 1.5f, "collector: a moved clip carries its keys along");
}

static void test_p7_roam_keys() {
    std::cout << "[16] P7 Roam keys run on timeline ticks (absolute), through held gaps too\n";
    Fixture f;
    buildFixture(f);
    TrackInfo* ct = f.tl.getTrackMutable(f.clipTrack);
    ct->roam.base.offsetY = 0.25f;
    ct->roam.keys = {
        roamKey(RoamChannel::OffsetX, 0,    0.0),
        roamKey(RoamChannel::OffsetX, 7680, 2.0),
        roamKey(RoamChannel::Scale,   0,    1.0, Interp::Hold),
        roamKey(RoamChannel::Scale,   1920, 2.0),
    };
    auto s = buildLensRoamSnapshot(f.tl);
    RoamParams r = s->roamAt(f.clipTrack, 1920);
    CHECK(r.offsetX == 0.5f && r.scale == 2.0f && r.offsetY == 0.25f, "tick 1920: offsetX 0.5, scale 2");
    CHECK(s->roamAt(f.clipTrack, 1919).scale == 1.0f, "Hold: scale 1 until its next key");
    CHECK(s->roamAt(f.clipTrack, -100).offsetX == 0.0f && s->roamAt(f.clipTrack, 1e7).offsetX == 2.0f,
          "before / after the keys");
    CHECK(s->roamAt(f.patTrack, 1920).isIdentity() && s->roamAt(99999, 1920).isIdentity(),
          "unkeyed / unknown track");
    CHECK(s->roamFor(f.clipTrack) == ct->roam.base, "base lookup ignores keys");

    // A held gap: clip 1 ends at 3840, clip 2 now starts at 5760.
    ct->videoHoldLastFrame = true;
    ct->videoHoldLastFrameThresholdBeats = -1.0;
    f.tl.getClipMutable(f.clip2)->position = TickTime::fromBeats(6);
    s = buildLensRoamSnapshot(f.tl);
    auto built = xleth::videoevents::build(f.tl, 140.0, 48000.0);
    FrameCollector col;
    col.setLensRoamSnapshot(s);
    col.collectRequests(3800, f.tl, 48000, kTickFps, built.events);     // clip 1 on screen
    auto& reqs = col.collectRequests(4800, f.tl, 48000, kTickFps, built.events);
    const CellFrameRequest* h = reqFor(reqs, f.clipTrack);
    CHECK(h != nullptr, "the gap is filled by a held frame");
    CHECK(h && h->roam == s->roamAt(f.clipTrack, 4800) && h->roam.offsetX == 1.25f,
          "a held frame's Roam keeps moving on the timeline tick");
}

static void test_p7_hit_curve() {
    std::cout << "[17] P7 hit curve per active note (Follow), from note-on and the clamped length\n";
    Fixture f;
    buildFixture(f);
    addHitNotes(f);

    LensTrack src;
    src.base.fit = LensFit::Cover;
    src.base.zoom = 1.2f;
    src.base.centerX = 0.4f;
    src.keys = punchDriftCurve();
    src.keys.push_back(lensKey(LensChannel::CenterX, KeyAnchor::Head, 0,   0.1));
    src.keys.push_back(lensKey(LensChannel::CenterX, KeyAnchor::Head, 120, 0.0));
    f.tl.getTrackMutable(f.patTrack)->trackLens[f.regB] = src;

    auto built = xleth::videoevents::build(f.tl, 140.0, 48000.0);
    std::vector<const VideoEvent*> notes;
    for (const auto& e : built.events) if (e.trackId == f.patTrack) notes.push_back(&e);
    std::sort(notes.begin(), notes.end(),
              [](const VideoEvent* a, const VideoEvent* b) { return a->startTick < b->startTick; });
    const double wantStart[] = { 3840, 4800, 5760, 7440 };
    const double wantLen[]   = { 960, 180, 300, 240 };
    bool spans = notes.size() == 4;
    for (std::size_t i = 0; spans && i < 4; ++i)
        spans = notes[i]->hasTickSpan && notes[i]->startTick == wantStart[i]
             && notes[i]->lengthTicks == wantLen[i];
    CHECK(spans, "note events carry note-on and the CLAMPED length in exact ticks (D: 960 -> 240)");

    FrameCollector col;
    col.setLensRoamSnapshot(buildLensRoamSnapshot(f.tl));
    auto lensAt = [&](int64_t tick) -> LensParams {
        auto& reqs = col.collectRequests(tick, f.tl, 48000, kTickFps, built.events);
        const CellFrameRequest* r = reqFor(reqs, f.patTrack);
        return r ? r->lens : LensParams{};
    };
    auto zoomWant = [&](const NoteZones& z, double L, double t) {
        return static_cast<float>(1.2f * hitLayer(src.keys, LensChannel::Zoom, z, L, t, 1.0));
    };
    const NoteZones sq{}, cut{ 120.0, 240.0, ShortNoteRule::Cut };

    // Note A (960): the punch, blended on the base (zoom multiplies, centre adds).
    LensParams a0 = lensAt(3840);
    CHECK(feq(a0.zoom, 1.2f * 1.35f) && feq(a0.centerX, 0.5f), "A note-on: zoom 1.2 x 1.35, centerX 0.4 + 0.1");
    CHECK(a0.fit == LensFit::Cover && a0.rotationDeg == 0.0f, "fit and unkeyed channels from the base");
    LensParams a60 = lensAt(3840 + 60);
    CHECK(feq(a60.zoom, zoomWant(sq, 960, 60)) && feq(a60.centerX, 0.45f), "A +60: mid-punch, eased");
    CHECK(feq(lensAt(3840 + 120).zoom, 1.2f * 1.08f) && feq(lensAt(3840 + 120).centerX, 0.4f),
          "A +120: head end");
    CHECK(feq(lensAt(3840 + 720).zoom, 1.2f * 1.20f), "A +720: Tail 240");
    CHECK(feq(lensAt(3840 + 959).zoom, zoomWant(sq, 960, 959)) && lensAt(3840 + 959).zoom < 1.2f * 1.01f,
          "A last tick: almost Tail 0");

    // Note B (180 < 360): Squash by default.
    CHECK(feq(lensAt(4800 + 30).zoom, zoomWant(sq, 180, 30)), "B Squash +30");
    CHECK(feq(lensAt(4800 + 60).zoom, 1.2f * 1.20f), "B Squash +60: the squashed tail start");

    // Note D: tail anchors at the CLAMPED end (240), not the raw note-off (960).
    const float d120 = lensAt(7440 + 120).zoom;
    CHECK(feq(d120, zoomWant(sq, 240, 120)), "D: evaluated with the clamped length 240");
    CHECK(!feq(d120, zoomWant(sq, 960, 120)), "...which differs from the raw 960");

    // Same notes under Cut.
    f.tl.getTrackMutable(f.patTrack)->trackLens[f.regB].zones = cut;
    col.setLensRoamSnapshot(buildLensRoamSnapshot(f.tl));
    CHECK(feq(lensAt(4800).zoom, 1.2f * 1.15f), "B Cut: note-on lands part-way into the tail (no punch)");
    CHECK(feq(lensAt(5760 + 30).zoom, zoomWant(cut, 300, 30)), "C Cut +30: head at its real speed");
    CHECK(feq(lensAt(5760 + 60).zoom, 1.2f * 1.20f), "C Cut +60: the cut (Tail 240)");
    CHECK(feq(lensAt(3840 + 60).zoom, zoomWant(sq, 960, 60)), "A (long) is the same under either rule");
}

static void test_p7_seek_and_live_vs_export() {
    std::cout << "[18] P7 seek mid-note and live preview == export, Roam keys + hit curve\n";
    Fixture f;
    buildFixture(f);
    addHitNotes(f);
    LensTrack src;
    src.base.zoom = 1.2f;
    src.keys = punchDriftCurve();
    src.keys.push_back(lensKey(LensChannel::RotationDeg, KeyAnchor::Body, 0.0, 0.0));
    src.keys.push_back(lensKey(LensChannel::RotationDeg, KeyAnchor::Body, 1.0, 6.0));
    f.tl.getTrackMutable(f.patTrack)->trackLens[f.regB] = src;
    f.tl.getTrackMutable(f.patTrack)->roam.keys = {
        roamKey(RoamChannel::OffsetX, 0,    0.0, Interp::EaseOut),
        roamKey(RoamChannel::OffsetX, 7680, 1.0),
        roamKey(RoamChannel::RotationDeg, 3840, 0.0),
        roamKey(RoamChannel::RotationDeg, 7680, 45.0),
    };
    f.tl.getTrackMutable(f.clipTrack)->roam.keys = { roamKey(RoamChannel::Scale, 0, 0.5),
                                                     roamKey(RoamChannel::Scale, 7680, 1.5) };
    f.tl.getClipMutable(f.clip2)->lens.keys = {
        lensKey(LensChannel::CenterX, KeyAnchor::Origin, 0, 0.2),
        lensKey(LensChannel::CenterX, KeyAnchor::Origin, 3840, 0.8),
    };

    const auto liveEvents = xleth::videoevents::build(f.tl, 140.0, 48000.0);
    const auto liveSnap   = buildLensRoamSnapshot(f.tl);
    const FrozenTimelineCopy frozen = makeFrozenTimelineCopy(f.tl);
    const Timeline& ex = *frozen.timeline;
    const auto exEvents = xleth::videoevents::build(ex, 140.0, 48000.0);
    const std::unordered_map<int, std::string> plan;    // empty render plan: originals

    // Seek: a FRESH collector asked for one tick mid-note == one that played
    // every tick up to it == the export's collector at the same tick.
    const int64_t mid = 3840 + 60;                       // note A, mid-punch
    FrameCollector played;
    played.setLensRoamSnapshot(liveSnap);
    for (int64_t t = 3600; t < mid; ++t)
        played.collectRequests(t, f.tl, 48000, kTickFps, liveEvents.events);
    const std::vector<CellFrameRequest> playedReqs =
        played.collectRequests(mid, f.tl, 48000, kTickFps, liveEvents.events);
    FrameCollector seeker;
    seeker.setLensRoamSnapshot(liveSnap);
    const std::vector<CellFrameRequest> seekReqs =
        seeker.collectRequests(mid, f.tl, 48000, kTickFps, liveEvents.events);
    FrameCollector exportAtMid;
    exportAtMid.setLensRoamSnapshot(buildLensRoamSnapshot(ex));
    const std::vector<CellFrameRequest> exportReqs =
        exportAtMid.collectRequests(mid, ex, 48000, kTickFps, exEvents.events,
                                    /*allowProxy=*/false, /*projectStartSample=*/0,
                                    /*posterMode=*/false, &plan);
    const CellFrameRequest* ps = reqFor(playedReqs, f.patTrack);
    const CellFrameRequest* ss = reqFor(seekReqs, f.patTrack);
    const CellFrameRequest* es = reqFor(exportReqs, f.patTrack);
    CHECK(ps && ss && es, "the pattern cell is on screen at the seek tick");
    if (ps && ss && es) {
        CHECK(ss->lens == ps->lens && ss->roam == ps->roam, "seek == played-through, bit for bit");
        CHECK(es->lens == ss->lens && es->roam == ss->roam, "export == preview at the seek tick");
        CHECK(ss->lens.zoom > 1.2f * 1.08f && ss->lens.zoom < 1.2f * 1.35f,
              "the seek lands MID-animation (between the punch and its settle)");
    }

    // Live vs export over a whole stretch: the preview at 30 fps on the live
    // timeline (layout override, proxies allowed, preview effect mute), the
    // export at 60 fps on the frozen copy, a subrange starting at 1 s. Every
    // 30 fps frame p shares its project sample (1600 p) with export frame
    // 2 (p - 30). Compared from 1 s to 3.4 s (beats 2.3 .. 7.9): clip track
    // and pattern track, across notes A..D and a gap between them.
    const GridLayout layout = f.tl.gridLayoutAt(TickTime{ 0 });
    FrameCollector preview, exporter;
    preview.setLensRoamSnapshot(liveSnap);
    exporter.setLensRoamSnapshot(buildLensRoamSnapshot(ex));
    const int64_t exportStart = 48000;
    int frames = 0, cells = 0, hitCells = 0, changes = 0;
    bool same = true;
    std::unordered_map<int, std::pair<LensParams, RoamParams>> prev;
    for (int64_t p = 30; p <= 102; ++p) {
        const std::vector<CellFrameRequest> pr = preview.collectRequests(
            p, f.tl, 48000, AVRational{ 30, 1 }, liveEvents.events,
            /*allowProxy=*/true, /*projectStartSample=*/0, /*posterMode=*/false,
            /*renderProxyBySource=*/nullptr, &layout, /*applyPreviewEffectMute=*/true);
        const auto& er = exporter.collectRequests(
            2 * (p - 30), ex, 48000, AVRational{ 60, 1 }, exEvents.events,
            /*allowProxy=*/false, exportStart, /*posterMode=*/false, &plan);
        ++frames;
        same = same && pr.size() == er.size();
        for (const auto& a : pr) {
            const CellFrameRequest* b = reqFor(er, a.trackId);
            same = same && b && a.lens == b->lens && a.roam == b->roam
                && a.sourceFrameIndex == b->sourceFrameIndex;
            ++cells;
            if (a.trackId == f.patTrack) ++hitCells;
            auto it = prev.find(a.trackId);
            if (it != prev.end() && (!(it->second.first == a.lens) || !(it->second.second == a.roam)))
                ++changes;
            prev[a.trackId] = { a.lens, a.roam };
        }
    }
    CHECK(same, "preview == export: every cell's Lens and Roam, every shared frame");
    CHECK(hitCells >= 15, "...across every note of the hit curve");
    CHECK(changes > 60, "...while the hit curve and the Roam keys were moving");
    std::cout << "    " << frames << " frames, " << cells << " cells compared (" << hitCells
              << " pattern cells), values changed between frames " << changes << " times\n";

    // The render-thread lookups never allocate.
    LensRoamSnapshot::EventClock clk;
    double sink = 0.0;
    const long long before = g_allocs.load();
    for (int i = 0; i < 20000; ++i) {
        clk.frameTick      = 3840.0 + (i % 3840);
        clk.eventStartTick = 3840.0;
        clk.eventLenTicks  = (i % 7 == 0) ? 180.0 : 960.0;
        const LensParams a = liveSnap->lensForEventAt(f.patTrack, -1, f.regB, clk);
        const LensParams b = liveSnap->lensForEventAt(f.clipTrack, f.clip2, f.regB, clk);
        const RoamParams r = liveSnap->roamAt(f.patTrack, clk.frameTick);
        sink += a.zoom + b.centerX + r.offsetX;
    }
    const long long after = g_allocs.load();
    CHECK(after == before, "lensForEventAt / roamAt: zero allocations over 60k lookups");
    std::cout << "    lookup allocations: " << (after - before) << " (checksum " << sink << ")\n";
}


// ─── [19..22] P8: Follow / Nudge / Own, hit-curve edits, presets ─────────────
// The per-note override layers on the source's base exactly as the hit curve
// does (zoom multiplies; centre and rotation add): Follow = base x hit,
// Nudge = base x hit x note, Own = base x note. Every command is one undo
// step and round-trips through save/load.

using NoteRef = LensRoamSnapshot::NoteRef;

// Pattern B's notes A..D (addHitNotes) in time order: id, note-on, CLAMPED length.
struct HitNote { int id; double start; double len; };
static std::vector<HitNote> hitNotes(const Fixture& f) {
    std::vector<const PatternNote*> ns;
    for (const auto& n : f.tl.getPattern(f.patternB)->notes) ns.push_back(&n);
    std::sort(ns.begin(), ns.end(),
              [](const PatternNote* a, const PatternNote* b) { return a->position.ticks < b->position.ticks; });
    const double start[] = { 3840, 4800, 5760, 7440 };
    const double len[]   = { 960, 180, 300, 240 };
    std::vector<HitNote> out;
    for (std::size_t i = 0; i < ns.size() && i < 4; ++i) out.push_back({ ns[i]->id, start[i], len[i] });
    return out;
}

// A Nudge layer touching three channels in all three zones.
static std::vector<LensKey> nudgeKeys() {
    return {
        lensKey(LensChannel::CenterX,     KeyAnchor::Head, 0,   0.05),
        lensKey(LensChannel::CenterX,     KeyAnchor::Head, 120, 0.0),
        lensKey(LensChannel::RotationDeg, KeyAnchor::Body, 0.0, 0.0),
        lensKey(LensChannel::RotationDeg, KeyAnchor::Body, 1.0, 10.0),
        lensKey(LensChannel::Zoom,        KeyAnchor::Tail, 240, 1.10),
        lensKey(LensChannel::Zoom,        KeyAnchor::Tail, 0,   1.00),
    };
}

// An Own curve: its own punch, nothing from the hit curve.
static std::vector<LensKey> ownKeys() {
    return {
        lensKey(LensChannel::Zoom,    KeyAnchor::Head, 0,   2.0, Interp::EaseOut),
        lensKey(LensChannel::Zoom,    KeyAnchor::Head, 120, 1.5),
        lensKey(LensChannel::CenterY, KeyAnchor::Body, 0.5, -0.1),
    };
}

static LensNoteOverridePtr makeOverride(LensOverrideMode mode, std::vector<LensKey> keys) {
    auto o = std::make_shared<LensNoteOverride>();
    o->mode = mode;
    o->keys = std::move(keys);
    return o;
}

// The source Lens used by the P8 tests: base zoom 1.2 / centerX 0.4 (Cover),
// hit curve = Punch + drift on zoom plus a centerX nudge on the head.
static LensTrack p8Source() {
    LensTrack src;
    src.base.fit = LensFit::Cover;
    src.base.zoom = 1.2f;
    src.base.centerX = 0.4f;
    src.keys = punchDriftCurve();
    src.keys.push_back(lensKey(LensChannel::CenterX, KeyAnchor::Head, 0,   0.1));
    src.keys.push_back(lensKey(LensChannel::CenterX, KeyAnchor::Head, 120, 0.0));
    return src;
}

static LensParams evalNote(const LensRoamSnapshot& s, const Fixture& f, const HitNote& n, double t,
                           bool withRef = true) {
    LensRoamSnapshot::EventClock c;
    c.frameTick = n.start + t; c.eventStartTick = n.start; c.eventLenTicks = n.len;
    NoteRef r;
    if (withRef) { r.patternId = f.patternB; r.noteId = n.id; }
    return s.lensForEventAt(f.patTrack, -1, f.regB, c, r);
}

// The expected Lens, from the generic curve engine, combined in the evaluator's
// exact order (layer = hit (op) note, then base (op) layer, one rounding).
// Zones: the source's for Follow / Nudge, the spec defaults for Own.
static LensParams expectLens(const LensTrack& src, const std::vector<LensKey>* hit,
                             const std::vector<LensKey>* note, double L, double t) {
    const NoteZones z = hit ? src.zones : NoteZones{};
    auto lay = [&](const std::vector<LensKey>* k, LensChannel ch, double id) {
        return k ? hitLayer(*k, ch, z, L, t, id) : id;
    };
    LensParams p = src.base;
    p.zoom        = static_cast<float>(static_cast<double>(p.zoom)
                  * (lay(hit, LensChannel::Zoom, 1.0) * lay(note, LensChannel::Zoom, 1.0)));
    p.centerX     = static_cast<float>(static_cast<double>(p.centerX)
                  + (lay(hit, LensChannel::CenterX, 0.0) + lay(note, LensChannel::CenterX, 0.0)));
    p.centerY     = static_cast<float>(static_cast<double>(p.centerY)
                  + (lay(hit, LensChannel::CenterY, 0.0) + lay(note, LensChannel::CenterY, 0.0)));
    p.rotationDeg = static_cast<float>(static_cast<double>(p.rotationDeg)
                  + (lay(hit, LensChannel::RotationDeg, 0.0) + lay(note, LensChannel::RotationDeg, 0.0)));
    return p;
}

static void test_p8_blend_modes() {
    std::cout << "[19] P8 blend math: Follow = base x hit, Nudge = base x hit x note, Own = base x note\n";
    Fixture f;
    buildFixture(f);
    addHitNotes(f);
    const LensTrack src = p8Source();
    f.tl.getTrackMutable(f.patTrack)->trackLens[f.regB] = src;
    const std::vector<HitNote> hn = hitNotes(f);
    CHECK(hn.size() == 4, "fixture: four notes in pattern B");
    if (hn.size() != 4) return;

    const std::vector<LensKey> nk = nudgeKeys(), ok = ownKeys();
    // A: Follow (no override). B: Nudge. C: Own. D: Nudge with NO keys.
    Pattern* pb = f.tl.getPatternMutable(f.patternB);
    for (auto& n : pb->notes) {
        if (n.id == hn[1].id) n.lensOverride = makeOverride(LensOverrideMode::Nudge, nk);
        if (n.id == hn[2].id) n.lensOverride = makeOverride(LensOverrideMode::Own, ok);
        if (n.id == hn[3].id) n.lensOverride = makeOverride(LensOverrideMode::Nudge, {});
    }
    const auto snap = buildLensRoamSnapshot(f.tl);
    const auto c = snap->counts();
    CHECK(c.noteNudge == 2 && c.noteOwn == 1, "snapshot compiled 2 Nudge + 1 Own overrides");

    // Exact (bitwise) against the generic engine, at every tick of every note,
    // with each note evaluated under ALL three modes (the note's length drives
    // Squash for B and C, so every zone geometry is covered).
    bool follow = true, nudge = true, own = true, p7 = true;
    int samples = 0;
    for (const HitNote& n : hn) {
        for (double t = 0; t < n.len; t += 7) {
            ++samples;
            const LensParams wantF = expectLens(src, &src.keys, nullptr, n.len, t);
            const LensParams wantN = expectLens(src, &src.keys, &nk, n.len, t);
            const LensParams wantO = expectLens(src, nullptr, &ok, n.len, t);
            // P7 formula for Follow: base (op) hit, no note layer at all.
            LensParams p7Want = src.base;
            p7Want.zoom    = static_cast<float>(static_cast<double>(src.base.zoom)
                           * hitLayer(src.keys, LensChannel::Zoom, src.zones, n.len, t, 1.0));
            p7Want.centerX = static_cast<float>(static_cast<double>(src.base.centerX)
                           + hitLayer(src.keys, LensChannel::CenterX, src.zones, n.len, t, 0.0));

            const LensParams gotF = evalNote(*snap, f, n, t, /*withRef=*/false);
            follow = follow && gotF == wantF;
            p7 = p7 && gotF == p7Want;
            if (n.id == hn[0].id) follow = follow && evalNote(*snap, f, n, t) == wantF;
            if (n.id == hn[1].id) nudge = nudge && evalNote(*snap, f, n, t) == wantN;
            if (n.id == hn[2].id) own = own && evalNote(*snap, f, n, t) == wantO;
            if (n.id == hn[3].id) nudge = nudge && evalNote(*snap, f, n, t) == wantF;   // no keys = hit curve
        }
    }
    CHECK(follow, "Follow: base x hit curve, bit for bit (and a note with no override == no note ref)");
    CHECK(p7, "Follow is bit-identical to the P7 evaluator's formula");
    CHECK(nudge, "Nudge: base x hit curve x note keys, bit for bit; Nudge with no keys == Follow");
    CHECK(own, "Own: base x note keys only, bit for bit");
    std::cout << "    " << samples << " samples per mode compared\n";

    // Spot values, by hand, so the blend RULE is visible here.
    const LensParams b0 = evalNote(*snap, f, hn[1], 0);   // B (Nudge, 180, squashed) at note-on
    // Its zoom layer's first key is Tail 240 (1.10), held from note-on.
    CHECK(feq(b0.zoom, 1.2f * 1.35f * 1.10f) && feq(b0.centerX, 0.4f + 0.1f + 0.05f),
          "Nudge note-on: zoom 1.2 x 1.35 x 1.10 (multiplies), centerX 0.4 + 0.1 + 0.05 (adds)");
    const LensParams c0 = evalNote(*snap, f, hn[2], 0);   // C (Own) at note-on
    CHECK(feq(c0.zoom, 1.2f * 2.0f) && feq(c0.centerX, 0.4f),
          "Own note-on: zoom 1.2 x 2.0, the hit curve's punch and centre offset are NOT applied");
    CHECK(c0.fit == LensFit::Cover && c0.flip == LensFlip::FollowTrack, "Own keeps the base fit / flip");

    // Own with no keys holds the base exactly; an override on a NEW source
    // (no trackLens entry: no hit curve, default zones) still plays.
    {
        Pattern* p = f.tl.getPatternMutable(f.patternB);
        for (auto& n : p->notes) if (n.id == hn[2].id) n.lensOverride = makeOverride(LensOverrideMode::Own, {});
        const auto s2 = buildLensRoamSnapshot(f.tl);
        bool held = true;
        for (double t = 0; t < hn[2].len; t += 5) held = held && evalNote(*s2, f, hn[2], t) == src.base;
        CHECK(held, "Own with no keys == the base, at every tick");

        f.tl.getTrackMutable(f.patTrack)->trackLens.erase(f.regB);
        const auto s3 = buildLensRoamSnapshot(f.tl);
        const LensParams fb = LensParams::newContentDefault();
        CHECK(evalNote(*s3, f, hn[0], 0) == fb, "new source, Follow: the fallback base, no hit curve");
        const LensParams nb = evalNote(*s3, f, hn[1], 0);
        CHECK(feq(nb.centerX, 0.55f) && feq(nb.zoom, 1.10f),
              "new source, Nudge: the note keys still play on the fallback base");
    }

    // Through the real path: VideoEvent carries {patternId, noteId}, the
    // collector hands it to the evaluator.
    f.tl.getTrackMutable(f.patTrack)->trackLens[f.regB] = src;
    {
        Pattern* p = f.tl.getPatternMutable(f.patternB);
        for (auto& n : p->notes) if (n.id == hn[2].id) n.lensOverride = makeOverride(LensOverrideMode::Own, ok);
    }
    const auto built = xleth::videoevents::build(f.tl, 140.0, 48000.0);
    bool keyed = true;
    int noteEvents = 0;
    for (const auto& e : built.events) {
        if (e.trackId != f.patTrack) continue;
        ++noteEvents;
        keyed = keyed && e.lensPatternId == f.patternB && e.lensNoteId > 0;
    }
    for (const auto& e : built.events)
        if (e.trackId == f.clipTrack) keyed = keyed && e.lensPatternId == -1 && e.lensNoteId == -1;
    CHECK(keyed && noteEvents == 4, "note events carry {patternId, noteId}; clip events carry none");
    FrameCollector col;
    const auto s4 = buildLensRoamSnapshot(f.tl);
    col.setLensRoamSnapshot(s4);
    auto lensAt = [&](double tick) -> LensParams {
        auto& reqs = col.collectRequests(static_cast<int64_t>(tick), f.tl, 48000, kTickFps, built.events);
        const CellFrameRequest* r = reqFor(reqs, f.patTrack);
        return r ? r->lens : LensParams{};
    };
    CHECK(lensAt(hn[0].start + 30) == evalNote(*s4, f, hn[0], 30), "collector: Follow note");
    CHECK(lensAt(hn[1].start + 30) == evalNote(*s4, f, hn[1], 30)
          && !(lensAt(hn[1].start + 30) == evalNote(*s4, f, hn[1], 30, false)), "collector: Nudge note (differs from Follow)");
    CHECK(lensAt(hn[2].start + 30) == evalNote(*s4, f, hn[2], 30)
          && !(lensAt(hn[2].start + 30) == evalNote(*s4, f, hn[2], 30, false)), "collector: Own note (differs from Follow)");

    // Same pattern id + note id on ANOTHER pattern does not pick it up:
    // pattern A plays on the same track, its note ids collide with B's.
    {
        LensRoamSnapshot::EventClock clk;
        clk.frameTick = 30; clk.eventStartTick = 0; clk.eventLenTicks = 960;
        NoteRef ra; ra.patternId = f.patternA; ra.noteId = hn[2].id;
        CHECK(!s4->overrideFor(f.patTrack, f.patternA, hn[2].id), "no override entry for pattern A's same note id");
        CHECK(s4->lensForEventAt(f.patTrack, -1, f.regB, clk, ra) == s4->lensForEventAt(f.patTrack, -1, f.regB, clk),
              "a colliding note id in another pattern stays Follow");
    }

    // Lookups with overrides still never allocate.
    double sink = 0.0;
    const long long before = g_allocs.load();
    for (int i = 0; i < 20000; ++i) {
        const HitNote& n = hn[i % 4];
        sink += evalNote(*s4, f, n, i % static_cast<int>(n.len)).zoom;
    }
    CHECK(g_allocs.load() == before, "lensForEventAt with overrides: zero allocations over 20k lookups");
    std::cout << "    checksum " << sink << "\n";

    // Old data: a note with no real id (<= 0) has no address, so it plays
    // Follow even if it carries an override; a duplicated id resolves to the
    // FIRST note with it (the one the edit commands address).
    {
        Pattern* p = f.tl.getPatternMutable(f.patternB);
        for (auto& n : p->notes) {
            if (n.id == hn[2].id) n.id = 0;                      // C: Own override, id 0
            else if (n.id == hn[3].id) {                         // D: duplicate of B's id, Own
                n.id = hn[1].id;
                n.lensOverride = makeOverride(LensOverrideMode::Own, ownKeys());
            }
        }
        const auto s5 = buildLensRoamSnapshot(f.tl);
        const auto ev5 = xleth::videoevents::build(f.tl, 140.0, 48000.0);
        bool cZero = false;
        for (const auto& e : ev5.events)
            if (e.trackId == f.patTrack && e.startTick == hn[2].start) cZero = e.lensNoteId == -1;
        CHECK(cZero, "a note with id 0 carries no note key on its event");
        CHECK(s5->counts().noteOwn == 0 && s5->counts().noteNudge == 1,
              "id-0 note skipped; the duplicate id compiles once (B's Nudge, not D's Own)");
        const auto* dup = s5->overrideFor(f.patTrack, f.patternB, hn[1].id);
        CHECK(dup && dup->mode == LensOverrideMode::Nudge, "a duplicated id resolves to the first note (B, Nudge)");
    }
}

// Every note's override, by id (for state comparisons).
static std::vector<std::pair<int, LensNoteOverridePtr>> overridesOf(const Timeline& tl, int patternId) {
    std::vector<std::pair<int, LensNoteOverridePtr>> out;
    if (const Pattern* p = tl.getPattern(patternId))
        for (const auto& n : p->notes) out.push_back({ n.id, n.lensOverride });
    std::sort(out.begin(), out.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
    return out;
}

static bool sameOverrides(const std::vector<std::pair<int, LensNoteOverridePtr>>& a,
                          const std::vector<std::pair<int, LensNoteOverridePtr>>& b) {
    if (a.size() != b.size()) return false;
    for (std::size_t i = 0; i < a.size(); ++i)
        if (a[i].first != b[i].first || !sameLensOverride(a[i].second, b[i].second)) return false;
    return true;
}

static bool sameSourceLens(const Timeline& a, const Timeline& b, int trackId, int regionId) {
    const TrackInfo* ta = a.getTrack(trackId);
    const TrackInfo* tb = b.getTrack(trackId);
    if (!ta || !tb) return false;
    const auto ia = ta->trackLens.find(regionId);
    const auto ib = tb->trackLens.find(regionId);
    if ((ia == ta->trackLens.end()) != (ib == tb->trackLens.end())) return false;
    if (ia == ta->trackLens.end()) return true;
    return ia->second.base == ib->second.base && ia->second.keys == ib->second.keys
        && ia->second.zones == ib->second.zones;
}

// Save through ProjectManager, load back, and compare everything P8 edits.
static bool roundTripsP8(const Fixture& f, const char* tag, int extraPattern = -1) {
    const fs::path dir = freshDir(tag);
    ProjectManager pm;
    if (!pm.createProject(dir.string(), tag) || !pm.saveProject(f.tl)) return false;
    ProjectManager pm2;
    auto loaded = pm2.loadProject(dir.string());
    if (!loaded) return false;
    if (extraPattern >= 0
        && !sameOverrides(overridesOf(f.tl, extraPattern), overridesOf(*loaded, extraPattern)))
        return false;
    return sameOverrides(overridesOf(f.tl, f.patternA), overridesOf(*loaded, f.patternA))
        && sameOverrides(overridesOf(f.tl, f.patternB), overridesOf(*loaded, f.patternB))
        && sameSourceLens(f.tl, *loaded, f.patTrack, f.regA)
        && sameSourceLens(f.tl, *loaded, f.patTrack, f.regB);
}

static void test_p8_note_commands() {
    std::cout << "[20] P8 note commands: setNoteLensMode / setNoteLensKeys / revertNotesToFollow, undo/redo, save/load\n";
    Fixture f;
    buildFixture(f);
    addHitNotes(f);
    f.tl.getTrackMutable(f.patTrack)->trackLens[f.regB] = p8Source();
    const std::vector<HitNote> hn = hitNotes(f);
    if (hn.size() != 4) { CHECK(false, "fixture"); return; }
    const NoteLensRef A{ f.patternB, hn[0].id }, B{ f.patternB, hn[1].id }, C{ f.patternB, hn[2].id };
    UndoManager um;
    auto state = [&]() { return overridesOf(f.tl, f.patternB); };

    // setNoteLensMode: B, C -> Nudge (one command, one undo step).
    const auto s0 = state();
    {
        auto cmd = std::make_unique<SetNoteLensModeCommand>(std::vector<NoteLensRef>{ B, C },
                                                            NoteLensMode::Nudge, f.tl);
        CHECK(cmd->changesAnything() && cmd->notes().size() == 2, "mode Nudge on 2 Follow notes is a change");
        um.execute(std::move(cmd), f.tl);
    }
    CHECK(noteLensOverrideOf(f.tl, B) && noteLensOverrideOf(f.tl, B)->mode == LensOverrideMode::Nudge
          && noteLensOverrideOf(f.tl, B)->keys.empty(), "B is Nudge, no keys");
    CHECK(noteLensOverrideOf(f.tl, C) && !noteLensOverrideOf(f.tl, A), "C is Nudge, A stays Follow");
    CHECK(roundTripsP8(f, "p8_cmd_mode"), "save/load after setNoteLensMode");
    const auto s1 = state();

    // No-ops build no change: Nudge again, an unknown note, a duplicate ref.
    CHECK(!SetNoteLensModeCommand({ B, C }, NoteLensMode::Nudge, f.tl).changesAnything(), "same mode again: no change");
    CHECK(SetNoteLensModeCommand({ NoteLensRef{ f.patternB, 9999 } }, NoteLensMode::Own, f.tl).notes().empty(),
          "unknown note id is skipped");
    CHECK(SetNoteLensModeCommand({ B, B }, NoteLensMode::Own, f.tl).notes().size() == 1, "duplicate ref counted once");
    CHECK(!RevertNotesToFollowCommand({ A }, f.tl).changesAnything(), "revert a Follow note: no change");

    // setNoteLensKeys on B (Nudge keeps Nudge) and on A (Follow becomes Nudge).
    um.execute(std::make_unique<SetNoteLensKeysCommand>(B, nudgeKeys(), f.tl), f.tl);
    CHECK(noteLensOverrideOf(f.tl, B)->mode == LensOverrideMode::Nudge
          && noteLensOverrideOf(f.tl, B)->keys == nudgeKeys(), "B keys set, still Nudge");
    CHECK(!SetNoteLensKeysCommand(B, nudgeKeys(), f.tl).changesAnything(), "same keys again: no change");
    CHECK(roundTripsP8(f, "p8_cmd_keys"), "save/load after setNoteLensKeys");
    const auto s2 = state();
    um.execute(std::make_unique<SetNoteLensKeysCommand>(A, ownKeys(), f.tl), f.tl);
    CHECK(noteLensOverrideOf(f.tl, A) && noteLensOverrideOf(f.tl, A)->mode == LensOverrideMode::Nudge,
          "keys on a Follow note make it Nudge");
    const auto s3 = state();

    // Nudge -> Own keeps the keys; Own -> Nudge too.
    um.execute(std::make_unique<SetNoteLensModeCommand>(std::vector<NoteLensRef>{ B }, NoteLensMode::Own, f.tl), f.tl);
    CHECK(noteLensOverrideOf(f.tl, B)->mode == LensOverrideMode::Own
          && noteLensOverrideOf(f.tl, B)->keys == nudgeKeys(), "Nudge -> Own keeps B's keys");
    CHECK(roundTripsP8(f, "p8_cmd_own"), "save/load after a Nudge -> Own switch");
    const auto s4 = state();

    // revertNotesToFollow drops overrides (keys too); undo brings the SAME object back.
    const LensNoteOverridePtr bBefore = noteLensOverrideOf(f.tl, B);
    um.execute(std::make_unique<RevertNotesToFollowCommand>(std::vector<NoteLensRef>{ A, B, C }, f.tl), f.tl);
    CHECK(!noteLensOverrideOf(f.tl, A) && !noteLensOverrideOf(f.tl, B) && !noteLensOverrideOf(f.tl, C),
          "revert: A, B, C all Follow");
    CHECK(roundTripsP8(f, "p8_cmd_revert"), "save/load after revertNotesToFollow");
    um.undo(f.tl);
    CHECK(noteLensOverrideOf(f.tl, B) == bBefore, "undo revert: B's override is back (same object, keys intact)");
    CHECK(sameOverrides(state(), s4), "undo revert == state before it");

    // Walk the whole history back and forward.
    um.undo(f.tl); CHECK(sameOverrides(state(), s3), "undo Own switch");
    um.undo(f.tl); CHECK(sameOverrides(state(), s2), "undo keys on A");
    um.undo(f.tl); CHECK(sameOverrides(state(), s1), "undo keys on B");
    um.undo(f.tl); CHECK(sameOverrides(state(), s0), "undo mode: all Follow again");
    CHECK(roundTripsP8(f, "p8_cmd_undone"), "save/load after undoing everything");
    um.redo(f.tl); CHECK(sameOverrides(state(), s1), "redo mode");
    um.redo(f.tl); CHECK(sameOverrides(state(), s2), "redo keys on B");
    um.redo(f.tl); CHECK(sameOverrides(state(), s3), "redo keys on A");
    um.redo(f.tl); CHECK(sameOverrides(state(), s4), "redo Own switch");
    um.redo(f.tl); CHECK(!noteLensOverrideOf(f.tl, B), "redo revert");
    CHECK(roundTripsP8(f, "p8_cmd_redone"), "save/load after redoing everything");

    // Commands touch exactly the addressed {patternId, noteId}: pattern A has
    // notes with the SAME ids and none of them changed.
    CHECK(overrideCount(f.tl, f.patternA) == 0, "pattern A (colliding ids) untouched throughout");
}

static void test_p8_hit_curve_edits() {
    std::cout << "[21] P8 hit-curve edits reach Follow and Nudge, never Own; presets; undo/redo, save/load\n";
    Fixture f;
    buildFixture(f);
    addHitNotes(f);
    LensTrack src = p8Source();
    src.zones.rule = ShortNoteRule::Cut;                      // a user's rule: presets keep it
    src.zones.headTicks = 60;
    f.tl.getTrackMutable(f.patTrack)->trackLens[f.regB] = src;
    const std::vector<HitNote> hn = hitNotes(f);
    if (hn.size() != 4) { CHECK(false, "fixture"); return; }
    UndoManager um;
    um.execute(std::make_unique<SetNoteLensKeysCommand>(NoteLensRef{ f.patternB, hn[1].id }, nudgeKeys(), f.tl), f.tl);
    um.execute(std::make_unique<SetNoteLensKeysCommand>(NoteLensRef{ f.patternB, hn[2].id }, ownKeys(), f.tl), f.tl);
    um.execute(std::make_unique<SetNoteLensModeCommand>(std::vector<NoteLensRef>{ NoteLensRef{ f.patternB, hn[2].id } },
                                                         NoteLensMode::Own, f.tl), f.tl);
    // A Follow (960), B Nudge (180), C Own (300). Sample each at several ticks.
    struct Probe { int note; double t; };
    const std::vector<Probe> probes = { {0, 0}, {0, 30}, {0, 500}, {0, 900}, {1, 0}, {1, 40}, {1, 150},
                                        {2, 0}, {2, 30}, {2, 200} };
    auto sample = [&]() {
        const auto s = buildLensRoamSnapshot(f.tl);
        std::vector<LensParams> v;
        for (const Probe& p : probes) v.push_back(evalNote(*s, f, hn[p.note], p.t));
        return v;
    };
    auto changedFor = [&](const std::vector<LensParams>& a, const std::vector<LensParams>& b, int note) {
        bool any = false;
        for (std::size_t i = 0; i < probes.size(); ++i)
            if (probes[i].note == note && !(a[i] == b[i])) any = true;
        return any;
    };
    auto sameFor = [&](const std::vector<LensParams>& a, const std::vector<LensParams>& b, int note) {
        bool same = true;
        for (std::size_t i = 0; i < probes.size(); ++i)
            if (probes[i].note == note) same = same && a[i] == b[i];
        return same;
    };
    const auto v0 = sample();

    // setHitCurve: a different curve (zoom pulse on rotation instead).
    std::vector<LensKey> pulse = {
        lensKey(LensChannel::Zoom,        KeyAnchor::Head, 0,   1.6, Interp::EaseOut),
        lensKey(LensChannel::Zoom,        KeyAnchor::Head, 60,  1.0),
        lensKey(LensChannel::RotationDeg, KeyAnchor::Body, 0.0, -5.0),
        lensKey(LensChannel::RotationDeg, KeyAnchor::Tail, 0,   5.0),
    };
    {
        auto cmd = std::make_unique<SetHitCurveCommand>(f.patTrack, f.regB, pulse, nullptr, f.tl, "Set hit curve");
        CHECK(cmd->changesAnything(), "a new curve is a change");
        um.execute(std::move(cmd), f.tl);
    }
    const auto v1 = sample();
    CHECK(changedFor(v0, v1, 0), "hit-curve edit changes the Follow note");
    CHECK(changedFor(v0, v1, 1), "hit-curve edit changes the Nudge note");
    CHECK(sameFor(v0, v1, 2), "hit-curve edit does NOT reach the Own note (bit for bit)");
    CHECK(f.tl.getTrack(f.patTrack)->trackLens.at(f.regB).base == src.base, "the base is untouched");
    CHECK(f.tl.getTrack(f.patTrack)->trackLens.at(f.regB).zones == src.zones, "zones untouched without a zones arg");
    CHECK(!SetHitCurveCommand(f.patTrack, f.regB, pulse, nullptr, f.tl, "x").changesAnything(),
          "the same curve again: no change");
    CHECK(roundTripsP8(f, "p8_hit_set"), "save/load after setHitCurve");

    // Zones patch.
    NoteZones z2 = src.zones; z2.tailTicks = 120;
    um.execute(std::make_unique<SetHitCurveCommand>(f.patTrack, f.regB, pulse, &z2, f.tl, "zones"), f.tl);
    CHECK(f.tl.getTrack(f.patTrack)->trackLens.at(f.regB).zones == z2, "zones set");
    const auto v2 = sample();
    CHECK(changedFor(v1, v2, 1), "a zones edit reaches the Nudge note (B is short: its tail moved)");
    CHECK(sameFor(v1, v2, 2), "a zones edit does NOT reach the Own note (it plays on the default zones)");
    CHECK(roundTripsP8(f, "p8_hit_zones"), "save/load after a zones edit");

    // Presets: the data file.
    CHECK(lensroam::kHitPresetCount == 4, "exactly four presets");
    const char* names[] = { "Still", "Punch", "Punch + drift", "Zoom pulse" };
    bool order = true;
    for (int i = 0; i < 4; ++i) order = order && std::string(lensroam::kHitPresets[i].name) == names[i];
    CHECK(order, "named and ordered as in the spec");
    CHECK(!lensroam::findHitPreset("punch") && !lensroam::findHitPreset("Pulse") && !lensroam::findHitPreset(nullptr),
          "names are exact");
    auto keysOf = [](const char* n) { return lensroam::hitPresetKeys(*lensroam::findHitPreset(n)); };
    CHECK(keysOf("Still").empty(), "Still: no keys");
    CHECK((keysOf("Punch") == std::vector<LensKey>{
              lensKey(LensChannel::Zoom, KeyAnchor::Head, 0,   1.35, Interp::EaseOut),
              lensKey(LensChannel::Zoom, KeyAnchor::Head, 120, 1.00) }),
          "Punch: Head 0 zoom 1.35 -> Head 120 zoom 1.00 (ease out)");
    CHECK(keysOf("Punch + drift") == punchDriftCurve(),
          "Punch + drift: Head 0 1.35 -> Head 120 1.08 -> Tail 240 1.20 -> Tail 0 1.00");
    CHECK((keysOf("Zoom pulse") == std::vector<LensKey>{
              lensKey(LensChannel::Zoom, KeyAnchor::Head, 0,   1.00),
              lensKey(LensChannel::Zoom, KeyAnchor::Body, 0.5, 1.15),
              lensKey(LensChannel::Zoom, KeyAnchor::Tail, 0,   1.00) }),
          "Zoom pulse: Head 0 1.00 -> Body 0.5 1.15 -> Tail 0 1.00");
    const NoteZones pz = lensroam::hitPresetZones(z2);
    CHECK(pz.headTicks == 120 && pz.tailTicks == 240 && pz.rule == ShortNoteRule::Cut,
          "preset zones: head 120, tail 240, the user's Cut rule kept");

    // Apply Punch (what timeline_applyHitPreset runs).
    um.execute(std::make_unique<SetHitCurveCommand>(f.patTrack, f.regB, keysOf("Punch"), &pz, f.tl,
                                                    "Apply hit preset 'Punch'"), f.tl);
    const auto v3 = sample();
    {
        const auto s = buildLensRoamSnapshot(f.tl);
        const LensParams a0 = evalNote(*s, f, hn[0], 0), a120 = evalNote(*s, f, hn[0], 120);
        CHECK(feq(a0.zoom, 1.2f * 1.35f) && feq(a120.zoom, 1.2f) && feq(a0.centerX, 0.4f),
              "Punch on the Follow note: 1.35x at note-on, back to the base at Head 120");
    }
    CHECK(changedFor(v2, v3, 0) && changedFor(v2, v3, 1) && sameFor(v2, v3, 2),
          "applying a preset: Follow and Nudge change, Own does not");
    CHECK(roundTripsP8(f, "p8_hit_preset"), "save/load after applyHitPreset");
    um.execute(std::make_unique<SetHitCurveCommand>(f.patTrack, f.regB, keysOf("Still"), &pz, f.tl,
                                                    "Apply hit preset 'Still'"), f.tl);
    {
        const auto s = buildLensRoamSnapshot(f.tl);
        CHECK(evalNote(*s, f, hn[0], 30) == src.base, "Still: a Follow note holds the base");
    }

    // Undo / redo the hit-curve history.
    um.undo(f.tl); CHECK(sample() == v3, "undo Still -> Punch values");
    um.undo(f.tl); CHECK(sample() == v2, "undo Punch -> zones edit values");
    um.undo(f.tl); CHECK(sample() == v1, "undo zones edit");
    um.undo(f.tl); CHECK(sample() == v0, "undo setHitCurve -> the original curve, every note");
    CHECK(f.tl.getTrack(f.patTrack)->trackLens.at(f.regB).keys == src.keys
          && f.tl.getTrack(f.patTrack)->trackLens.at(f.regB).zones == src.zones, "original keys and zones restored");
    um.redo(f.tl); um.redo(f.tl); um.redo(f.tl);
    CHECK(sample() == v3, "redo x3 -> Punch again");

    // A source with NO entry: the command materialises one at the base it
    // already rendered with (newContentDefault); undo erases it again.
    f.tl.getTrackMutable(f.patTrack)->trackLens.erase(f.regA);
    {
        const auto before = buildLensRoamSnapshot(f.tl);
        UndoManager um2;
        um2.execute(std::make_unique<SetHitCurveCommand>(f.patTrack, f.regA, keysOf("Punch"), &pz, f.tl, "p"), f.tl);
        const TrackInfo* t = f.tl.getTrack(f.patTrack);
        CHECK(t->trackLens.count(f.regA) && t->trackLens.at(f.regA).base == LensParams::newContentDefault(),
              "absent source: entry materialised at newContentDefault");
        const auto after = buildLensRoamSnapshot(f.tl);
        CHECK(after->lensForSource(f.patTrack, f.regA) == before->lensForSource(f.patTrack, f.regA),
              "...so its base Lens did not change");
        CHECK(roundTripsP8(f, "p8_hit_new_source"), "save/load of the materialised entry");
        um2.undo(f.tl);
        CHECK(!f.tl.getTrack(f.patTrack)->trackLens.count(f.regA), "undo erases it (absent again)");
    }
}

static void test_p8_survival_real_overrides() {
    std::cout << "[22] P5 survival re-run with REAL overrides (set by the P8 commands, evaluated)\n";
    Fixture f;
    buildFixture(f);
    addHitNotes(f);
    f.tl.getTrackMutable(f.patTrack)->trackLens[f.regB] = p8Source();
    const std::vector<HitNote> hn = hitNotes(f);
    if (hn.size() != 4) { CHECK(false, "fixture"); return; }
    const int nudgeId = hn[1].id, ownId = hn[2].id, otherId = hn[0].id;
    UndoManager um;
    um.execute(std::make_unique<SetNoteLensKeysCommand>(NoteLensRef{ f.patternB, nudgeId }, nudgeKeys(), f.tl), f.tl);
    um.execute(std::make_unique<SetNoteLensKeysCommand>(NoteLensRef{ f.patternB, ownId }, ownKeys(), f.tl), f.tl);
    um.execute(std::make_unique<SetNoteLensModeCommand>(std::vector<NoteLensRef>{ NoteLensRef{ f.patternB, ownId } },
                                                         NoteLensMode::Own, f.tl), f.tl);
    const LensNoteOverridePtr nudgeO = noteLensOverrideOf(f.tl, { f.patternB, nudgeId });
    const LensNoteOverridePtr ownO   = noteLensOverrideOf(f.tl, { f.patternB, ownId });

    // What each note looks like, through the real build + collector, at a tick
    // `t` after ITS OWN note-on (wherever the note currently sits).
    auto lookOf = [&](int patternId, int noteId, double t) -> std::pair<bool, LensParams> {
        const auto built = xleth::videoevents::build(f.tl, 140.0, 48000.0);
        const VideoEvent* ev = nullptr;
        for (const auto& e : built.events)
            if (e.trackId == f.patTrack && e.lensPatternId == patternId && e.lensNoteId == noteId) { ev = &e; break; }
        if (!ev) return { false, LensParams{} };
        FrameCollector col;
        col.setLensRoamSnapshot(buildLensRoamSnapshot(f.tl));
        auto& reqs = col.collectRequests(static_cast<int64_t>(ev->startTick + t), f.tl, 48000, kTickFps, built.events);
        const CellFrameRequest* r = reqFor(reqs, f.patTrack);
        return { r != nullptr, r ? r->lens : LensParams{} };
    };
    const auto nudgeLook = lookOf(f.patternB, nudgeId, 30);
    const auto ownLook   = lookOf(f.patternB, ownId, 30);
    CHECK(nudgeLook.first && ownLook.first, "both overridden notes are on screen");
    auto stillLooks = [&](int patternId, const char* what) {
        const auto n = lookOf(patternId, nudgeId, 30), o = lookOf(patternId, ownId, 30);
        CHECK(n.first && n.second == nudgeLook.second, (std::string(what) + ": Nudge note renders the same").c_str());
        CHECK(o.first && o.second == ownLook.second, (std::string(what) + ": Own note renders the same").c_str());
    };
    auto kept = [&](int patternId, const char* what) {
        CHECK(noteLensOverrideOf(f.tl, { patternId, nudgeId }) == nudgeO
              && noteLensOverrideOf(f.tl, { patternId, ownId }) == ownO,
              (std::string(what) + ": both overrides kept (same objects)").c_str());
    };

    // Piano roll: move (per-id), batch move, quantize, an edit of another note.
    // Note lengths stay put, so the animation at +30 must not change.
    um.execute(std::make_unique<MoveNoteCommand>(f.patternB, nudgeId, TickTime{ 1080 }, 70, f.tl), f.tl);
    kept(f.patternB, "move"); stillLooks(f.patternB, "move");
    um.execute(std::make_unique<MoveNotesBatchCommand>(f.patternB,
        std::vector<MoveNotesBatchCommand::Move>{ { nudgeId, TickTime{ 1100 }, 71 }, { ownId, TickTime{ 2000 }, 62 } },
        f.tl), f.tl);
    kept(f.patternB, "batch move"); stillLooks(f.patternB, "batch move");
    {
        auto notes = f.tl.getPattern(f.patternB)->notes;
        for (auto& n : notes) n.position.ticks = (n.position.ticks + 60) / 120 * 120;
        um.execute(std::make_unique<EditPatternNotesCommand>(f.patternB, viaJson(notes), f.tl), f.tl);
    }
    CHECK(sameLensOverride(noteLensOverrideOf(f.tl, { f.patternB, nudgeId }), nudgeO)
          && sameLensOverride(noteLensOverrideOf(f.tl, { f.patternB, ownId }), ownO),
          "quantize (whole-list edit through the JS converters): both overrides kept");
    stillLooks(f.patternB, "quantize");
    {
        auto notes = f.tl.getPattern(f.patternB)->notes;
        for (auto& n : notes) if (n.id == otherId) n.velocity = 0.5f;
        um.execute(std::make_unique<EditPatternNotesCommand>(f.patternB, viaJson(notes), f.tl), f.tl);
    }
    CHECK(!noteLensOverrideOf(f.tl, { f.patternB, otherId }), "the edited other note is still Follow");
    stillLooks(f.patternB, "edit of another note");

    // Copy / paste: the pasted copies get new ids and the SAME look.
    {
        auto notes = f.tl.getPattern(f.patternB)->notes;
        std::vector<PatternNote> copies;
        for (const auto& n : notes)
            if (n.id == nudgeId || n.id == ownId) { PatternNote c = n; c.id = 0; c.position.ticks += 480; copies.push_back(c); }
        for (auto& c : copies) notes.push_back(c);
        um.execute(std::make_unique<EditPatternNotesCommand>(f.patternB, viaJson(notes), f.tl), f.tl);
    }
    int pastedNudge = -1, pastedOwn = -1;
    for (const auto& n : f.tl.getPattern(f.patternB)->notes) {
        if (n.id == nudgeId || n.id == ownId || !n.lensOverride) continue;
        if (n.lensOverride->mode == LensOverrideMode::Own) pastedOwn = n.id; else pastedNudge = n.id;
    }
    CHECK(pastedNudge > 0 && pastedOwn > 0, "paste: both copies carry an override under new ids");
    {
        const auto pn = lookOf(f.patternB, pastedNudge, 30), po = lookOf(f.patternB, pastedOwn, 30);
        CHECK(pn.first && pn.second == nudgeLook.second, "paste: the Nudge copy renders like the original");
        CHECK(po.first && po.second == ownLook.second, "paste: the Own copy renders like the original");
    }
    um.undo(f.tl);

    // Delete drops the override with the note; undo brings both back.
    um.execute(std::make_unique<RemoveNoteCommand>(f.patternB, ownId, f.tl), f.tl);
    CHECK(!lookOf(f.patternB, ownId, 30).first, "delete: the Own note is gone");
    um.undo(f.tl);
    CHECK(sameLensOverride(noteLensOverrideOf(f.tl, { f.patternB, ownId }), ownO), "undo delete: override back");
    stillLooks(f.patternB, "undo delete");

    // Make Unique Copy: a new pattern, the notes batch-added under fresh ids
    // (list order), and the block re-pointed at it.
    Pattern np;
    np.name = "B (unique)";
    np.regionId = f.regB;
    np.length = f.tl.getPattern(f.patternB)->length;
    const int uniqueId = f.tl.addPattern(np);
    std::vector<PatternNote> batch = viaJson(f.tl.getPattern(f.patternB)->notes);
    std::vector<int> srcIds;
    for (auto& n : batch) { srcIds.push_back(n.id); n.id = 0; }
    um.execute(std::make_unique<AddNotesBatchCommand>(uniqueId, batch), f.tl);
    int uNudge = -1, uOwn = -1;
    {
        const auto& dst = f.tl.getPattern(uniqueId)->notes;
        for (std::size_t i = 0; i < dst.size() && i < srcIds.size(); ++i) {
            if (srcIds[i] == nudgeId) uNudge = dst[i].id;
            if (srcIds[i] == ownId)   uOwn   = dst[i].id;
        }
    }
    CHECK(uNudge > 0 && uOwn > 0, "unique copy: the overridden notes exist in the copy");
    CHECK(sameLensOverride(noteLensOverrideOf(f.tl, { uniqueId, uNudge }), nudgeO)
          && sameLensOverride(noteLensOverrideOf(f.tl, { uniqueId, uOwn }), ownO),
          "unique copy: each override on its matching new id");
    for (const PatternBlock* b : f.tl.getPatternBlocksOnTrack(f.patTrack)) {
        if (b->patternId != f.patternB) continue;
        PatternBlock nb = *b;
        f.tl.removePatternBlock(b->id);
        nb.patternId = uniqueId;
        f.tl.addPatternBlock(nb);
        break;
    }
    {
        const auto un = lookOf(uniqueId, uNudge, 30), uo = lookOf(uniqueId, uOwn, 30);
        CHECK(un.first && un.second == nudgeLook.second, "unique copy: the Nudge note renders the same on the new block");
        CHECK(uo.first && uo.second == ownLook.second, "unique copy: the Own note renders the same on the new block");
    }

    // Save / load keeps all of it.
    CHECK(overrideCount(f.tl, uniqueId) == 2, "unique copy: exactly the two overrides");
    CHECK(roundTripsP8(f, "p8_survival", uniqueId), "save/load: pattern B and the unique copy keep every override");
}

int main() {
    std::cout << "[LensRoam] Lens + Roam P1 tests\n";
    test_defaults();
    test_round_trip();
    test_tolerant_load();
    test_migration();
    test_snapshot_lookup();
    test_collector_copy();
    test_real_project_resave();
    test_p2_lens_math();
    test_p2_roam_math();
    test_p2_collector_order();
    test_p2_dev_hook();
    test_p3_commands();
    test_p5_note_override();
    test_p7_snapshot_compile();
    test_p7_clip_keys();
    test_p7_roam_keys();
    test_p7_hit_curve();
    test_p7_seek_and_live_vs_export();
    test_p8_blend_modes();
    test_p8_note_commands();
    test_p8_hit_curve_edits();
    test_p8_survival_real_overrides();
    std::cout << "[LensRoam] " << g_pass << " passed, " << g_fail << " failed\n";
    return g_fail == 0 ? 0 : 1;
}
