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
#include "SyncManager.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>

namespace fs = std::filesystem;
using json = nlohmann::json;

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
    k.pos = 480.0; k.value = 1.25; k.p1x = 0.1f; k.p1y = 1.4f; k.p2x = 0.9f; k.p2y = 1.0f;
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
              && r.p1x == 0.1f && r.p1y == 1.4f && r.p2x == 0.9f && r.p2y == 1.0f,
              "key fields survive exactly (p1y > 1 not clamped)");
    }

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
    src.keys.push_back(hk);
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
    // Keys are stored but NOT evaluated in P1: a key must not move the base.
    LensKey k; k.channel = LensChannel::Zoom; k.value = 9.0;
    f.tl.getClipMutable(f.clip2)->lens.keys.push_back(k);

    auto s = buildLensRoamSnapshot(f.tl);
    CHECK(s->lensForEvent(f.clipTrack, f.clip2, f.regB) == someLens(),
          "clip event -> that clip's lens (base only; keys ignored)");
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

int main() {
    std::cout << "[LensRoam] Lens + Roam P1 tests\n";
    test_defaults();
    test_round_trip();
    test_tolerant_load();
    test_migration();
    test_snapshot_lookup();
    test_collector_copy();
    test_real_project_resave();
    std::cout << "[LensRoam] " << g_pass << " passed, " << g_fail << " failed\n";
    return g_fail == 0 ? 0 : 1;
}
