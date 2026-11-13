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

#include <cmath>
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
    std::cout << "[LensRoam] " << g_pass << " passed, " << g_fail << " failed\n";
    return g_fail == 0 ? 0 : 1;
}
