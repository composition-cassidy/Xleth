// test_landing.cpp — Landing model + resolver (docs/XLETH_LANDING_SPEC.md, P1).
//
// CPU only: links XlethEngineModel, no GPU, no decoder. Covers
//   [N] TrackLanding::normalize and the list sanitizer
//   [J] JSON round-trip, defaults on load, and the byte-identical floor
//   [C] cue CRUD carrying landings
//   [W] landingsAt windows, latest-pin-wins, the lead-in clamp, and skips
//   [F] From rects: Edge, Grow, WhereItWas, Custom
//   [S] the seam: at p == 1 the pose is B's drawn rect, bit for bit
//   [R] Reflow
//
// Pass: prints "ALL TESTS PASSED" and exits 0.

#include "model/Timeline.h"
#include "render/GridRectMath.h"
#include "render/LandingMath.h"
#include "render/RenderClock.h"

#include <cmath>
#include <cstring>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                             \
    do {                                                             \
        if (cond) {                                                  \
            ++g_passed;                                              \
        } else {                                                     \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; \
            ++g_failed;                                              \
        }                                                            \
    } while (0)

#define CHECK_NEAR(a, b, tol, msg) \
    CHECK(std::abs((double)(a) - (double)(b)) < (tol), msg)

namespace {

using Landing  = TrackLanding;
using Resolved = Timeline::ResolvedLanding;

// Bitwise float equality: the seam must not be "close".
bool sameBits(float a, float b) {
    return std::memcmp(&a, &b, sizeof(float)) == 0;
}

// Field-wise, because the struct has padding a memcmp would also compare.
bool sameLanding(const TrackLanding& a, const TrackLanding& b) {
    return a.trackId == b.trackId && a.leadInTicks == b.leadInTicks && a.from == b.from
        && sameBits(a.edgeAngleDeg, b.edgeAngleDeg)
        && sameBits(a.customX, b.customX) && sameBits(a.customY, b.customY)
        && sameBits(a.customW, b.customW) && sameBits(a.customH, b.customH)
        && sameBits(a.fromOpacity, b.fromOpacity)
        && sameBits(a.easing.x1, b.easing.x1) && sameBits(a.easing.y1, b.easing.y1)
        && sameBits(a.easing.x2, b.easing.x2) && sameBits(a.easing.y2, b.easing.y2);
}

GridSlot slotAt(int trackId, int gx, int gy, int sx, int sy) {
    GridSlot s;
    s.trackId = trackId;
    s.gridX = gx; s.gridY = gy;
    s.spanX = sx; s.spanY = sy;
    return s;
}

const Resolved* findResolved(const Timeline::ResolvedLandings& set, int trackId) {
    for (int i = 0; i < set.count; ++i)
        if (set.items[i].trackId == trackId) return &set.items[i];
    return nullptr;
}

// The spec's reference scenario (§1).
//   Snapshot 1 (Base): 2x1. Chords on the left half, bass on the right half.
//   Snapshot 2:        4x4. Chords small top-left, bass small top-right, lead
//                      big in the centre, two percussion cells at the bottom.
//   Cue at bar 9 -> snapshot 2.
struct Scenario {
    Timeline    tl;
    int         chords = -1, bass = -1, lead = -1, perc1 = -1, perc2 = -1;
    std::string baseId, twoId;
    TickTime    pin{ 8 * 4 * 960 };   // bar 9

    Scenario() {
        const auto add = [&](const char* name) {
            TrackInfo t;
            t.name = name;
            return tl.addTrack(t);
        };
        chords = add("Chords");
        bass   = add("Bass");
        lead   = add("Lead");
        perc1  = add("Perc 1");
        perc2  = add("Perc 2");

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
    }

    static Landing make(int trackId, Landing::From from, int64_t leadIn) {
        Landing l;
        l.trackId = trackId;
        l.from = from;
        l.leadInTicks = leadIn;
        return l;
    }
};

// ─── [N] normalize ───────────────────────────────────────────────────────────

void testNormalize() {
    std::cout << "[N] TrackLanding::normalize + sanitizeTrackLandings\n";

    {
        Landing l;
        CHECK(l.trackId == -1, "default trackId is -1");
        CHECK(l.leadInTicks == 960, "default lead-in is one beat");
        CHECK(l.from == Landing::From::Edge, "default From is Edge");
        CHECK(l.edgeAngleDeg == 270.0f, "default edge angle is 270 (bottom)");
        CHECK(l.fromOpacity == 1.0f, "default fromOpacity is 1 (no fade)");
        CHECK(l.easing.x1 == 0.22f && l.easing.y1 == 1.0f
              && l.easing.x2 == 0.36f && l.easing.y2 == 1.0f,
              "default easing is Land (0.22, 1, 0.36, 1)");
        CHECK(Landing::kMaxLeadInTicks == 960 * 16, "max lead-in is 4 bars of 4/4");
        CHECK(Landing::kMaxLandingsPerCue == 16, "at most 16 landings per cue");
        const Landing before = l;
        l.normalize();
        CHECK(sameLanding(before, l),
              "normalize leaves a default landing untouched");
    }
    {
        Landing l;
        l.leadInTicks = -5;
        l.normalize();
        CHECK(l.leadInTicks == 0, "negative lead-in clamps to 0");
        l.leadInTicks = 999999999;
        l.normalize();
        CHECK(l.leadInTicks == Landing::kMaxLeadInTicks, "huge lead-in clamps to the max");
    }
    {
        Landing l;
        l.edgeAngleDeg = -90.0f;  l.normalize();
        CHECK_NEAR(l.edgeAngleDeg, 270.0, 1e-4, "-90 wraps to 270");
        l.edgeAngleDeg = 720.0f;  l.normalize();
        CHECK_NEAR(l.edgeAngleDeg, 0.0, 1e-4, "720 wraps to 0");
        l.edgeAngleDeg = 450.0f;  l.normalize();
        CHECK_NEAR(l.edgeAngleDeg, 90.0, 1e-4, "450 wraps to 90");
        l.edgeAngleDeg = -1e-9f;  l.normalize();
        CHECK(l.edgeAngleDeg >= 0.0f && l.edgeAngleDeg < 360.0f,
              "a tiny negative angle stays inside [0, 360)");
        l.edgeAngleDeg = std::numeric_limits<float>::quiet_NaN();  l.normalize();
        CHECK(l.edgeAngleDeg == 270.0f, "a non-finite angle resets to the default");
    }
    {
        Landing l;
        l.customX = -1.0f; l.customY = 2.0f; l.customW = -0.5f; l.customH = 3.0f;
        l.normalize();
        CHECK(l.customX == 0.0f && l.customY == 1.0f && l.customW == 0.0f && l.customH == 1.0f,
              "custom rect clamps to [0,1] with w,h >= 0");
        l.customX = std::numeric_limits<float>::infinity();
        l.customW = std::numeric_limits<float>::quiet_NaN();
        l.normalize();
        CHECK(l.customX == 0.0f && l.customW == 0.0f, "non-finite custom fields reset to 0");
    }
    {
        Landing l;
        l.fromOpacity = -0.2f;  l.normalize();
        CHECK(l.fromOpacity == 0.0f, "fromOpacity clamps at 0");
        l.fromOpacity = 1.7f;   l.normalize();
        CHECK(l.fromOpacity == 1.0f, "fromOpacity clamps at 1");
        l.fromOpacity = std::numeric_limits<float>::quiet_NaN();  l.normalize();
        CHECK(l.fromOpacity == 1.0f, "non-finite fromOpacity resets to 1");
    }
    {
        Landing l;
        l.easing.x1 = std::numeric_limits<float>::quiet_NaN();
        l.normalize();
        CHECK(l.easing.x1 == 0.22f && l.easing.y1 == 1.0f
              && l.easing.x2 == 0.36f && l.easing.y2 == 1.0f,
              "a non-finite easing resets to Land, not to linear");
        l.easing = SnapshotTransitionEasingCurve{ 1.5f, -0.5f, 0.5f, 2.0f };
        l.normalize();
        CHECK(l.easing.x1 == 1.0f && l.easing.y1 == 0.0f && l.easing.y2 == 1.0f,
              "easing control points clamp to [0,1]");
    }
    {
        Landing l;
        l.from = static_cast<Landing::From>(9);
        l.normalize();
        CHECK(l.from == Landing::From::Edge, "an out-of-range From resets to Edge");
    }
    {
        CHECK(stringToTrackLandingFrom("edge") == Landing::From::Edge, "from: edge");
        CHECK(stringToTrackLandingFrom("grow") == Landing::From::Grow, "from: grow");
        CHECK(stringToTrackLandingFrom("whereItWas") == Landing::From::WhereItWas, "from: whereItWas");
        CHECK(stringToTrackLandingFrom("custom") == Landing::From::Custom, "from: custom");
        CHECK(stringToTrackLandingFrom("magicMove") == Landing::From::Edge,
              "an unknown from string loads as edge");
        for (auto f : { Landing::From::Edge, Landing::From::Grow,
                        Landing::From::WhereItWas, Landing::From::Custom })
            CHECK(stringToTrackLandingFrom(trackLandingFromToString(f)) == f,
                  "from string round-trips");
    }
    {
        // De-duplicate: the later entry wins and keeps the earlier position.
        std::vector<Landing> list;
        list.push_back(Scenario::make(7, Landing::From::Edge, 100));
        list.push_back(Scenario::make(8, Landing::From::Grow, 200));
        list.push_back(Scenario::make(7, Landing::From::Custom, 300));
        list.push_back(Scenario::make(-1, Landing::From::Grow, 400));
        sanitizeTrackLandings(list);
        CHECK(list.size() == 2, "duplicate trackId and a missing trackId are removed");
        CHECK(list[0].trackId == 7 && list[0].from == Landing::From::Custom
              && list[0].leadInTicks == 300, "the later entry for a track wins");
        CHECK(list[1].trackId == 8, "list order is otherwise kept");
    }
    {
        std::vector<Landing> list;
        for (int i = 0; i < 20; ++i) list.push_back(Scenario::make(i, Landing::From::Edge, 960));
        list[3].leadInTicks = -99;
        sanitizeTrackLandings(list);
        CHECK(list.size() == 16, "entries past 16 are rejected");
        CHECK(list.back().trackId == 15, "the first 16 are the ones kept");
        CHECK(list[3].leadInTicks == 0, "sanitize normalizes every entry");
    }
}

// ─── [J] JSON ────────────────────────────────────────────────────────────────

nlohmann::json* findCueJson(nlohmann::json& project, int64_t tick) {
    for (auto& c : project["gridLayout"]["cues"])
        if (c.value("tick", int64_t{-1}) == tick) return &c;
    return nullptr;
}

void testJson() {
    std::cout << "[J] JSON round-trip + defaults + byte-identical floor\n";

    // The floor: cues, a transition, no landings. Captured BEFORE any landing
    // call so it is the pre-feature output.
    Scenario sc;
    SnapshotTransition tr;
    tr.enabled = true;
    tr.startOffsetTicks = 480;
    tr.endOffsetTicks = 480;
    tr.type = SnapshotTransition::Type::Push;
    sc.tl.setCueTransition(sc.pin, tr);
    const std::string floorDump = sc.tl.toJSON().dump();
    CHECK(floorDump.find("landings") == std::string::npos,
          "a project without landings writes no landings key");

    // Round-trip with every field off its default.
    Landing a = Scenario::make(sc.chords, Landing::From::WhereItWas, 960);
    a.fromOpacity = 0.7f;
    Landing b = Scenario::make(sc.lead, Landing::From::Edge, 480);
    b.edgeAngleDeg = 90.0f;
    b.easing = SnapshotTransitionEasingCurve{ 0.65f, 0.0f, 0.35f, 1.0f };
    Landing c = Scenario::make(sc.bass, Landing::From::Custom, 1920);
    c.customX = 0.25f; c.customY = 0.5f; c.customW = 0.125f; c.customH = 0.75f;
    c.fromOpacity = 0.0f;
    Landing d = Scenario::make(sc.perc1, Landing::From::Grow, 0);
    sc.tl.setCueLandings(sc.pin, { a, b, c, d });

    nlohmann::json saved = sc.tl.toJSON();
    nlohmann::json* cueJson = findCueJson(saved, sc.pin.ticks);
    CHECK(cueJson && cueJson->contains("landings") && (*cueJson)["landings"].size() == 4,
          "landings are written on the cue that owns them");
    if (cueJson && cueJson->contains("landings")) {
        const auto& l0 = (*cueJson)["landings"][0];
        CHECK(l0.value("from", "") == std::string("whereItWas"), "from is written as a string");
        CHECK(l0.contains("custom") && l0["custom"].contains("w"), "custom is a nested {x,y,w,h}");
        CHECK(l0.contains("easing") && l0["easing"].contains("x1"), "easing is a nested {x1,y1,x2,y2}");
        CHECK(l0.value("leadInTicks", int64_t{-1}) == 960, "leadInTicks is written in ticks");
    }

    Timeline loaded;
    CHECK(loaded.fromJSON(saved), "a project with landings loads");
    const auto& cues = loaded.getGridCues();
    CHECK(cues.size() == 1 && cues[0].landings.size() == 4, "all four landings load");
    if (cues.size() == 1 && cues[0].landings.size() == 4) {
        const auto& got = cues[0].landings;
        const Landing want[4] = { a, b, c, d };
        bool same = true;
        for (int i = 0; i < 4; ++i)
            same = same && sameLanding(got[i], want[i]);
        CHECK(same, "every landing field round-trips exactly");
        CHECK(cues[0].transition.enabled && cues[0].transition.endOffsetTicks == 480,
              "the cue's transition still round-trips beside its landings");
    }
    CHECK(loaded.toJSON()["gridLayout"]["cues"].dump() == saved["gridLayout"]["cues"].dump(),
          "load -> save writes the same cues");

    // Clearing the landings returns the project to the floor, byte for byte.
    sc.tl.setCueLandings(sc.pin, {});
    CHECK(sc.tl.toJSON().dump() == floorDump,
          "with its landings removed the project serializes byte-identically to before");

    // Defaults on load: an entry that names only its track, an unknown from
    // string, and wrong-typed fields.
    nlohmann::json sparse = sc.tl.toJSON();
    nlohmann::json* sparseCue = findCueJson(sparse, sc.pin.ticks);
    CHECK(sparseCue != nullptr, "cue present in the saved project");
    if (sparseCue) {
        (*sparseCue)["landings"] = nlohmann::json::array({
            { {"trackId", sc.chords} },
            { {"trackId", sc.bass}, {"from", "teleport"}, {"leadInTicks", "soon"},
              {"fromOpacity", 5.0}, {"edgeAngleDeg", -90.0} },
            { {"from", "grow"} },                       // no trackId: dropped
            "not an object",
            { {"trackId", sc.chords}, {"from", "grow"} } // duplicate: later wins
        });
        Timeline sparseLoaded;
        CHECK(sparseLoaded.fromJSON(sparse), "a sparse landings array loads");
        const auto& sc2 = sparseLoaded.getGridCues();
        CHECK(sc2.size() == 1 && sc2[0].landings.size() == 2,
              "entries without a track are dropped and duplicates collapse");
        if (sc2.size() == 1 && sc2[0].landings.size() == 2) {
            const Landing& first = sc2[0].landings[0];
            CHECK(first.trackId == sc.chords && first.from == Landing::From::Grow,
                  "the later duplicate wins on load");
            CHECK(first.leadInTicks == 960 && first.fromOpacity == 1.0f
                  && first.edgeAngleDeg == 270.0f && first.easing.x1 == 0.22f,
                  "omitted fields load as their defaults");
            const Landing& second = sc2[0].landings[1];
            CHECK(second.from == Landing::From::Edge, "an unknown from string loads as edge");
            CHECK(second.leadInTicks == 960, "a wrong-typed field falls back to its default");
            CHECK(second.fromOpacity == 1.0f, "an out-of-range value is normalized on load");
            CHECK_NEAR(second.edgeAngleDeg, 270.0, 1e-4, "the angle is wrapped on load");
        }
    }

    // A project saved before landings existed loads with none.
    nlohmann::json legacy = sc.tl.toJSON();
    Timeline legacyLoaded;
    CHECK(legacyLoaded.fromJSON(legacy) && legacyLoaded.getGridCues().size() == 1
          && legacyLoaded.getGridCues()[0].landings.empty()
          && !legacyLoaded.hasCueLandings(),
          "a project without a landings key loads with no landings");
}

// ─── [C] cue CRUD ────────────────────────────────────────────────────────────

void testCueCrud() {
    std::cout << "[C] Cue CRUD carries landings\n";

    Scenario sc;
    CHECK(!sc.tl.hasCueLandings(), "no landings yet");
    sc.tl.setCueLandings(TickTime{ 12345 }, { Scenario::make(sc.lead, Landing::From::Edge, 480) });
    CHECK(!sc.tl.hasCueLandings(), "setCueLandings is a no-op when there is no cue at the tick");

    SnapshotTransition tr;
    tr.enabled = true;
    tr.startOffsetTicks = 240;
    tr.endOffsetTicks = 720;
    sc.tl.setCueTransition(sc.pin, tr);
    sc.tl.setCueLandings(sc.pin, {
        Scenario::make(sc.chords, Landing::From::WhereItWas, 960),
        Scenario::make(sc.lead, Landing::From::Edge, 480),
    });
    CHECK(sc.tl.hasCueLandings(), "the cue now has landings");

    // addGridCue at an existing tick repoints the snapshot and keeps the rest.
    sc.tl.addGridCue(sc.pin, sc.baseId);
    CHECK(sc.tl.getGridCues().size() == 1 && sc.tl.getGridCues()[0].snapshotId == sc.baseId
          && sc.tl.getGridCues()[0].landings.size() == 2
          && sc.tl.getGridCues()[0].transition.enabled,
          "addGridCue at an existing tick keeps the landings and the transition");
    sc.tl.addGridCue(sc.pin, sc.twoId);

    // moveGridCue moves the whole cue.
    const TickTime moved{ sc.pin.ticks + 1920 };
    CHECK(sc.tl.moveGridCue(sc.pin, moved), "moveGridCue relocates the cue");
    const auto& cues = sc.tl.getGridCues();
    CHECK(cues.size() == 1 && cues[0].tick == moved, "the cue is at its new tick");
    CHECK(cues.size() == 1 && cues[0].landings.size() == 2
          && cues[0].landings[0].trackId == sc.chords
          && cues[0].landings[1].leadInTicks == 480,
          "moveGridCue carries the landings");
    CHECK(cues.size() == 1 && cues[0].transition.enabled
          && cues[0].transition.startOffsetTicks == 240
          && cues[0].transition.endOffsetTicks == 720,
          "moveGridCue carries the transition (audit D1)");
    CHECK(cues.size() == 1 && cues[0].snapshotId == sc.twoId, "moveGridCue carries the snapshot");

    // Moves across another cue stay sorted and keep each cue's own data.
    sc.tl.addGridCue(TickTime{ 960 }, sc.baseId);
    CHECK(sc.tl.moveGridCue(moved, TickTime{ 480 }), "move the landing cue before the other");
    CHECK(sc.tl.getGridCues().size() == 2
          && sc.tl.getGridCues()[0].tick.ticks == 480
          && sc.tl.getGridCues()[0].landings.size() == 2
          && sc.tl.getGridCues()[1].tick.ticks == 960
          && sc.tl.getGridCues()[1].landings.empty(),
          "cues stay sorted and landings stay with their own cue");

    // Replace, then clear.
    sc.tl.setCueLandings(TickTime{ 480 }, { Scenario::make(sc.bass, Landing::From::Grow, 240) });
    CHECK(sc.tl.getGridCues()[0].landings.size() == 1
          && sc.tl.getGridCues()[0].landings[0].trackId == sc.bass,
          "setCueLandings replaces the list");
    CHECK(sc.tl.removeGridCue(TickTime{ 480 }) && !sc.tl.hasCueLandings(),
          "removing the cue removes its landings");
}

// ─── [W] windows, winner, clamp, skips ───────────────────────────────────────

void testWindows() {
    std::cout << "[W] landingsAt windows, latest pin, lead-in clamp, skips\n";

    // Empty set.
    {
        Scenario sc;
        CHECK(sc.tl.landingsAt(sc.pin).count == 0, "no landings: count 0 at the pin");
        CHECK(sc.tl.landingsAt(TickTime{ sc.pin.ticks - 100 }).count == 0,
              "no landings: count 0 before the pin");
        Timeline blank;
        CHECK(blank.landingsAt(TickTime{ 0 }).count == 0, "no cues at all: count 0");
    }

    // Hard cut: the window is [start, pin).
    {
        Scenario sc;
        sc.tl.setCueLandings(sc.pin, {
            Scenario::make(sc.chords, Landing::From::WhereItWas, 960),
            Scenario::make(sc.lead, Landing::From::Edge, 480),
        });
        const int64_t pin = sc.pin.ticks;
        const int64_t start = pin - 960;
        CHECK(sc.tl.landingsAt(TickTime{ start - 1 }).count == 0, "before the window: nothing carried");
        const auto atStart = sc.tl.landingsAt(TickTime{ start });
        CHECK(atStart.count == 2, "at startTick: both landings are carried");
        CHECK(atStart.pinTick.ticks == pin && atStart.carryEndTick.ticks == pin,
              "hard cut: carryEndTick is the pin");
        CHECK(atStart.columns == 4 && atStart.rows == 4 && sameBits(atStart.gapScale, 0.05f),
              "the set carries snapshot B's geometry");
        CHECK(atStart.items[0].trackId == sc.chords && atStart.items[1].trackId == sc.lead,
              "items keep the cue's landing order");
        CHECK(atStart.items[0].startTick.ticks == start
              && atStart.items[1].startTick.ticks == pin - 480,
              "each landing has its own startTick");
        CHECK(sc.tl.landingsAt(TickTime{ pin - 1 }).count == 2, "at pin - 1: still carried");
        CHECK(sc.tl.landingsAt(TickTime{ pin }).count == 0,
              "hard cut: nothing is carried at the pin (B draws it)");
        CHECK(sc.tl.landingsAt(TickTime{ pin + 1 }).count == 0, "after the pin: nothing carried");

        // Enabled transition: the carry runs to pin + endOffset, exclusive.
        SnapshotTransition tr;
        tr.enabled = true;
        tr.type = SnapshotTransition::Type::Push;
        tr.startOffsetTicks = 960;
        tr.endOffsetTicks = 960;
        sc.tl.setCueTransition(sc.pin, tr);
        const auto atPin = sc.tl.landingsAt(TickTime{ pin });
        CHECK(atPin.count == 2 && atPin.carryEndTick.ticks == pin + 960,
              "with a transition the carry runs through its window");
        CHECK(sc.tl.landingsAt(TickTime{ pin + 959 }).count == 2, "at carryEndTick - 1: carried");
        CHECK(sc.tl.landingsAt(TickTime{ pin + 960 }).count == 0, "at carryEndTick: released");

        // A disabled transition's offsets do not extend the carry.
        tr.enabled = false;
        sc.tl.setCueTransition(sc.pin, tr);
        CHECK(sc.tl.landingsAt(TickTime{ pin }).count == 0,
              "a disabled transition leaves carryEndTick at the pin");
    }

    // The window opens with the longest RESOLVED lead-in.
    {
        Scenario sc;
        sc.tl.setCueLandings(sc.pin, {
            Scenario::make(9999, Landing::From::Edge, 3840),     // no such track
            Scenario::make(sc.lead, Landing::From::Edge, 480),
        });
        const int64_t pin = sc.pin.ticks;
        CHECK(sc.tl.landingsAt(TickTime{ pin - 3840 }).count == 0,
              "a skipped landing's lead-in does not open the window");
        CHECK(sc.tl.landingsAt(TickTime{ pin - 481 }).count == 0, "closed just before the real start");
        CHECK(sc.tl.landingsAt(TickTime{ pin - 480 }).count == 1, "open at the resolved start");
    }

    // Lead-in clamp at the previous cue, and at 0 for the first cue.
    {
        Scenario sc;
        const std::string threeId = sc.tl.createGridSnapshot(true, "Three");
        sc.tl.setActiveGridSnapshot(sc.baseId);
        const TickTime second{ sc.pin.ticks + 480 };
        sc.tl.addGridCue(second, threeId);                    // snapshot A here is Two
        sc.tl.setActiveGridSnapshot(threeId);
        GridLayout three = sc.tl.getGridLayout();
        three.columns = 2; three.rows = 2; three.gapScale = 0.0f;
        three.slots = { slotAt(sc.lead, 0, 0, 16, 16) };
        sc.tl.setGridLayout(three);
        sc.tl.setActiveGridSnapshot(sc.baseId);

        sc.tl.setCueLandings(second, { Scenario::make(sc.lead, Landing::From::WhereItWas, 1920) });
        const auto r = sc.tl.landingsAt(TickTime{ sc.pin.ticks });
        CHECK(r.count == 1 && r.items[0].startTick == sc.pin,
              "the lead-in is clamped at the previous cue's pin");
        CHECK(sc.tl.landingsAt(TickTime{ sc.pin.ticks - 1 }).count == 0,
              "nothing is carried before snapshot A exists");
        CHECK(sc.tl.getGridCues()[1].landings[0].leadInTicks == 1920,
              "the clamp is applied at resolve time; stored data is untouched");

        // A dangling cue in between is treated as absent.
        sc.tl.addGridCue(TickTime{ sc.pin.ticks + 240 }, "snap-does-not-exist");
        const auto r2 = sc.tl.landingsAt(TickTime{ sc.pin.ticks + 100 });
        CHECK(r2.count == 1 && r2.items[0].startTick == sc.pin,
              "a dangling cue does not move the clamp");
        sc.tl.removeGridCue(TickTime{ sc.pin.ticks + 240 });

        // First cue: clamp at 0.
        Scenario first;
        first.tl.moveGridCue(first.pin, TickTime{ 480 });
        first.tl.setCueLandings(TickTime{ 480 }, { Scenario::make(first.lead, Landing::From::Edge, 1920) });
        const auto r3 = first.tl.landingsAt(TickTime{ 0 });
        CHECK(r3.count == 1 && r3.items[0].startTick.ticks == 0,
              "with no previous cue the lead-in is clamped at tick 0");
    }

    // Latest pin wins when two windows hold t.
    {
        Scenario sc;
        sc.tl.setActiveGridSnapshot(sc.twoId);           // clone Two, so lead has a slot
        const std::string threeId = sc.tl.createGridSnapshot(true, "Three");
        sc.tl.setActiveGridSnapshot(sc.baseId);
        const int64_t pin1 = sc.pin.ticks;
        const int64_t pin2 = pin1 + 960;
        sc.tl.addGridCue(TickTime{ pin2 }, threeId);

        SnapshotTransition tr;
        tr.enabled = true;
        tr.endOffsetTicks = 1920;                 // cue 1 carries until pin1 + 1920
        sc.tl.setCueTransition(sc.pin, tr);
        sc.tl.setCueLandings(sc.pin, { Scenario::make(sc.chords, Landing::From::WhereItWas, 960) });
        sc.tl.setCueLandings(TickTime{ pin2 }, { Scenario::make(sc.lead, Landing::From::Grow, 480) });

        const auto early = sc.tl.landingsAt(TickTime{ pin1 + 100 });
        CHECK(early.count == 1 && early.pinTick.ticks == pin1,
              "before the later cue's lead-in the earlier cue is the only window");
        const auto both = sc.tl.landingsAt(TickTime{ pin2 - 100 });
        CHECK(both.count == 1 && both.pinTick.ticks == pin2 && both.items[0].trackId == sc.lead,
              "when two windows hold t the latest pin wins");
        const auto after = sc.tl.landingsAt(TickTime{ pin2 + 100 });
        CHECK(after.count == 1 && after.pinTick.ticks == pin1,
              "after the later pin (hard cut) the earlier cue's carry is what remains");
    }

    // Skips (ruling 11): never fatal, stored data untouched.
    {
        Scenario sc;
        const int ghost = 9999;
        TrackInfo extra;
        extra.name = "Backdrop";
        const int backdrop = sc.tl.addTrack(extra);
        sc.tl.setActiveGridSnapshot(sc.twoId);
        FullscreenLayer fl;
        fl.trackId = backdrop;
        sc.tl.setFullscreenLayers({ fl });        // backdrop is fullscreen-only in B
        sc.tl.setActiveGridSnapshot(sc.baseId);
        TrackInfo loose;
        loose.name = "Unplaced";
        const int unplaced = sc.tl.addTrack(loose);

        sc.tl.setCueLandings(sc.pin, {
            Scenario::make(ghost, Landing::From::Edge, 960),         // deleted track
            Scenario::make(unplaced, Landing::From::Edge, 960),      // no slot in B
            Scenario::make(backdrop, Landing::From::Edge, 960),      // fullscreen-only in B
            Scenario::make(sc.lead, Landing::From::Edge, 960),       // fine
        });
        const auto r = sc.tl.landingsAt(TickTime{ sc.pin.ticks - 10 });
        CHECK(r.count == 1 && r.items[0].trackId == sc.lead,
              "a deleted track, a track with no B slot and a fullscreen-only track are skipped");
        CHECK(sc.tl.getGridCues()[0].landings.size() == 4,
              "skipped landings stay in storage");

        // A real track deleted after the landing was authored.
        CHECK(sc.tl.removeTrack(sc.lead), "delete the last resolvable landing's track");
        CHECK(sc.tl.landingsAt(TickTime{ sc.pin.ticks - 10 }).count == 0,
              "with every landing skipped the caller takes today's path");
        CHECK(sc.tl.getGridCues()[0].landings.size() == 4, "storage is still untouched");

        // The cue's snapshot is gone (a dangling cue).
        Scenario dangling;
        dangling.tl.addGridCue(TickTime{ 4800 }, "snap-does-not-exist");
        dangling.tl.setCueLandings(TickTime{ 4800 },
            { Scenario::make(dangling.lead, Landing::From::Edge, 960) });
        CHECK(dangling.tl.landingsAt(TickTime{ 4700 }).count == 0,
              "a cue whose snapshot is gone resolves no landings");
        CHECK(dangling.tl.getGridCues()[0].landings.size() == 1,
              "and its stored landings are left alone");
    }
}

// ─── [F] From rects ──────────────────────────────────────────────────────────

void testFromRects() {
    std::cout << "[F] From rects: Edge, Grow, WhereItWas, Custom\n";

    Scenario sc;
    const TickTime inWindow{ sc.pin.ticks - 10 };

    // Lead's drawn rect in B, straight from the shared function.
    float lx, ly, lw, lh;
    xleth::slotCanvasRect(8, 8, 16, 16, 4, 4, 0.05f, lx, ly, lw, lh);

    const auto resolveLead = [&](Landing l) {
        l.trackId = sc.lead;
        sc.tl.setCueLandings(sc.pin, { l });
        const auto set = sc.tl.landingsAt(inWindow);
        return set.count == 1 ? set.items[0] : Resolved{};
    };

    // Edge, cardinal angles: exactly off-canvas, touching the edge.
    {
        Landing l = Scenario::make(sc.lead, Landing::From::Edge, 960);

        l.edgeAngleDeg = 0.0f;      // from the left
        Resolved r = resolveLead(l);
        CHECK(sameBits(r.toX, lx) && sameBits(r.toY, ly) && sameBits(r.toW, lw) && sameBits(r.toH, lh),
              "the destination is B's drawn rect");
        CHECK(r.fromX + r.fromW == 0.0f, "Edge 0: the right side touches the left edge exactly");
        CHECK(sameBits(r.fromY, ly) && sameBits(r.fromW, lw) && sameBits(r.fromH, lh),
              "Edge 0: a pure horizontal slide");

        l.edgeAngleDeg = 90.0f;     // from the top
        r = resolveLead(l);
        CHECK(r.fromY + r.fromH == 0.0f, "Edge 90: the bottom side touches the top edge exactly");
        CHECK(sameBits(r.fromX, lx) && sameBits(r.fromW, lw) && sameBits(r.fromH, lh),
              "Edge 90: a pure vertical slide");

        l.edgeAngleDeg = 180.0f;    // from the right
        r = resolveLead(l);
        CHECK(r.fromX == 1.0f, "Edge 180: the left side touches the right edge exactly");
        CHECK(sameBits(r.fromY, ly), "Edge 180: a pure horizontal slide");

        l.edgeAngleDeg = 270.0f;    // from the bottom
        r = resolveLead(l);
        CHECK(r.fromY == 1.0f, "Edge 270: the top side touches the bottom edge exactly");
        CHECK(sameBits(r.fromX, lx), "Edge 270: a pure vertical slide");
        CHECK(sameBits(r.fromUnitW, r.toUnitW) && sameBits(r.fromUnitH, r.toUnitH),
              "Edge keeps Roam's unit: the cell does not change size");
    }

    // Edge 45: slides along (-1,-1)/sqrt2 until the first edge is cleared.
    {
        Landing l = Scenario::make(sc.lead, Landing::From::Edge, 960);
        l.edgeAngleDeg = 45.0f;
        const Resolved r = resolveLead(l);
        const bool touchesLeft = (r.fromX + r.fromW == 0.0f);
        const bool touchesTop  = (r.fromY + r.fromH == 0.0f);
        CHECK(touchesLeft || touchesTop, "Edge 45: touches the left or the top edge exactly");
        const bool outside = (r.fromX + r.fromW <= 0.0f) || (r.fromY + r.fromH <= 0.0f)
                          || (r.fromX >= 1.0f) || (r.fromY >= 1.0f);
        CHECK(outside, "Edge 45: fully outside the canvas");
        const float dx = r.fromX - r.toX, dy = r.fromY - r.toY;
        CHECK(dx < 0.0f && dy < 0.0f, "Edge 45: moved up and to the left");
        CHECK_NEAR(dx, dy, 1e-6, "Edge 45: the slide is along the 45 degree diagonal");
        // The lead is centred, so both edges are equally far: k is the smaller
        // of the two and neither side overshoots.
        CHECK(r.fromX + r.fromW >= -1e-6 || r.fromY + r.fromH >= -1e-6,
              "Edge 45: no further out than it has to be");

        // An off-centre rect clears the nearer edge first.
        xleth::landing::Rect to{ 0.1f, 0.6f, 0.2f, 0.2f };      // near the left, low
        const xleth::landing::Rect from = xleth::landing::edgeFromRect(to, 45.0f);
        CHECK(from.x + from.w == 0.0f, "Edge 45 off-centre: leaves through the nearer (left) edge");
        CHECK(from.y + from.h > 0.0f, "Edge 45 off-centre: still inside vertically, as the spec's min allows");
        CHECK_NEAR(from.x - to.x, from.y - to.y, 1e-6, "Edge 45 off-centre: still a diagonal slide");
    }

    // Edge, the other diagonals and a wrap.
    {
        const xleth::landing::Rect to{ 0.25f, 0.25f, 0.5f, 0.5f };
        const auto a135 = xleth::landing::edgeFromRect(to, 135.0f);   // from the top-right
        CHECK((a135.x == 1.0f || a135.y + a135.h == 0.0f) && a135.x > to.x && a135.y < to.y,
              "Edge 135: enters from the top-right");
        const auto a225 = xleth::landing::edgeFromRect(to, 225.0f);   // from the bottom-right
        CHECK((a225.x == 1.0f || a225.y == 1.0f) && a225.x > to.x && a225.y > to.y,
              "Edge 225: enters from the bottom-right");
        const auto a315 = xleth::landing::edgeFromRect(to, 315.0f);   // from the bottom-left
        CHECK((a315.x + a315.w == 0.0f || a315.y == 1.0f) && a315.x < to.x && a315.y > to.y,
              "Edge 315: enters from the bottom-left");
        const auto a360 = xleth::landing::edgeFromRect(to, 360.0f);
        const auto a0   = xleth::landing::edgeFromRect(to, 0.0f);
        CHECK(sameBits(a360.x, a0.x) && sameBits(a360.y, a0.y), "Edge 360 is Edge 0");
    }

    // Grow: a zero-size rect at the destination centre.
    {
        const Resolved r = resolveLead(Scenario::make(sc.lead, Landing::From::Grow, 960));
        CHECK(r.fromW == 0.0f && r.fromH == 0.0f, "Grow starts at zero size");
        CHECK(sameBits(r.fromX, lx + lw * 0.5f) && sameBits(r.fromY, ly + lh * 0.5f),
              "Grow starts at the destination centre");
        CHECK(r.fromUnitW == 0.0f && r.fromUnitH == 0.0f, "Grow starts with a zero Roam unit");
    }

    // WhereItWas from a slot in A (different geometry and gap than B).
    {
        sc.tl.setCueLandings(sc.pin, {
            Scenario::make(sc.chords, Landing::From::WhereItWas, 960),
            Scenario::make(sc.bass, Landing::From::WhereItWas, 960),
        });
        const auto set = sc.tl.landingsAt(inWindow);
        CHECK(set.count == 2, "chords and bass both resolve");
        float ax, ay, aw, ah, bx, by, bw, bh;
        xleth::slotCanvasRect(0, 0, 8, 8, 2, 1, 0.1f, ax, ay, aw, ah);    // chords in A
        xleth::slotCanvasRect(8, 0, 8, 8, 2, 1, 0.1f, bx, by, bw, bh);    // bass in A
        const Resolved* c = findResolved(set, sc.chords);
        const Resolved* b = findResolved(set, sc.bass);
        CHECK(c && sameBits(c->fromX, ax) && sameBits(c->fromY, ay)
              && sameBits(c->fromW, aw) && sameBits(c->fromH, ah),
              "WhereItWas: chords start at their drawn rect in A");
        CHECK(b && sameBits(b->fromX, bx) && sameBits(b->fromY, by)
              && sameBits(b->fromW, bw) && sameBits(b->fromH, bh),
              "WhereItWas: bass starts at its drawn rect in A");
        float ux, uy, uw, uh;
        xleth::slotCellRect(0, 0, 8, 8, 2, 1, ux, uy, uw, uh);
        CHECK(c && sameBits(c->fromUnitW, uw) && sameBits(c->fromUnitH, uh),
              "WhereItWas: Roam's unit starts as A's pre-gap placement");
    }

    // WhereItWas honours the track's own gap override at both ends.
    {
        sc.tl.getTrackMutable(sc.chords)->gapScaleOverride = 0.3f;
        sc.tl.setCueLandings(sc.pin, { Scenario::make(sc.chords, Landing::From::WhereItWas, 960) });
        const auto set = sc.tl.landingsAt(inWindow);
        float ax, ay, aw, ah, tx, ty, tw, th;
        xleth::slotCanvasRect(0, 0, 8, 8, 2, 1, 0.3f, ax, ay, aw, ah);
        xleth::slotCanvasRect(0, 0, 8, 8, 4, 4, 0.3f, tx, ty, tw, th);
        CHECK(set.count == 1 && sameBits(set.items[0].fromX, ax) && sameBits(set.items[0].fromW, aw)
              && sameBits(set.items[0].toX, tx) && sameBits(set.items[0].toW, tw),
              "the per-track gap override is used for both rects");
        sc.tl.getTrackMutable(sc.chords)->gapScaleOverride = -1.0f;
    }

    // WhereItWas from a fullscreen layer in A: the full canvas.
    {
        sc.tl.setActiveGridSnapshot(sc.baseId);
        FullscreenLayer fl;
        fl.trackId = sc.lead;
        sc.tl.setFullscreenLayers({ fl });
        const Resolved r = resolveLead(Scenario::make(sc.lead, Landing::From::WhereItWas, 960));
        CHECK(r.fromX == 0.0f && r.fromY == 0.0f && r.fromW == 1.0f && r.fromH == 1.0f,
              "WhereItWas from a fullscreen layer starts at the full canvas");
        CHECK(r.fromUnitW == 1.0f && r.fromUnitH == 1.0f, "and its Roam unit is the canvas");
        sc.tl.setFullscreenLayers({});
    }

    // WhereItWas for a track that is not in A: falls back to Grow.
    {
        const Resolved r = resolveLead(Scenario::make(sc.lead, Landing::From::WhereItWas, 960));
        CHECK(r.fromW == 0.0f && r.fromH == 0.0f
              && sameBits(r.fromX, lx + lw * 0.5f) && sameBits(r.fromY, ly + lh * 0.5f),
              "WhereItWas falls back to Grow when the track is not in A");
        CHECK(sc.tl.getGridCues()[0].landings[0].from == Landing::From::WhereItWas,
              "the fallback is a resolve-time decision; the stored From is unchanged");
    }

    // Custom: the stored rect.
    {
        Landing l = Scenario::make(sc.lead, Landing::From::Custom, 960);
        l.customX = 0.1f; l.customY = 0.2f; l.customW = 0.3f; l.customH = 0.4f;
        l.fromOpacity = 0.25f;
        const Resolved r = resolveLead(l);
        CHECK(r.fromX == 0.1f && r.fromY == 0.2f && r.fromW == 0.3f && r.fromH == 0.4f,
              "Custom starts at the stored rect");
        CHECK(r.fromOpacity == 0.25f, "fromOpacity is carried through");
    }

    // The destination follows B's slot as it is NOW (ruling 2: nothing baked).
    {
        sc.tl.setCueLandings(sc.pin, { Scenario::make(sc.lead, Landing::From::Grow, 960) });
        sc.tl.setActiveGridSnapshot(sc.twoId);
        sc.tl.assignTrackToGrid(sc.lead, 0, 8, 8, 8);
        sc.tl.setActiveGridSnapshot(sc.baseId);
        const auto set = sc.tl.landingsAt(inWindow);
        float nx, ny, nw, nh;
        xleth::slotCanvasRect(0, 8, 8, 8, 4, 4, 0.05f, nx, ny, nw, nh);
        CHECK(set.count == 1 && sameBits(set.items[0].toX, nx) && sameBits(set.items[0].toY, ny)
              && sameBits(set.items[0].toW, nw) && sameBits(set.items[0].toH, nh),
              "editing B's slot moves the landing's destination");
        CHECK(set.count == 1 && set.items[0].slotGridX == 0 && set.items[0].slotGridY == 8
              && set.items[0].slotSpanX == 8 && set.items[0].slotSpanY == 8,
              "the resolved landing carries B's slot for the carry layout");
    }
}

// ─── [S] the seam + per-frame evaluation ─────────────────────────────────────

void testSeam() {
    std::cout << "[S] Seam: at p == 1 the pose is B's drawn rect, bit for bit\n";

    Scenario sc;
    sc.tl.getTrackMutable(sc.bass)->gapScaleOverride = 0.2f;    // one track with its own gap
    Landing custom = Scenario::make(sc.perc1, Landing::From::Custom, 1440);
    custom.customX = 0.4f; custom.customY = 0.1f; custom.customW = 0.33f; custom.customH = 0.27f;
    custom.fromOpacity = 0.3f;
    Landing chords = Scenario::make(sc.chords, Landing::From::WhereItWas, 960);
    chords.fromOpacity = 0.7f;
    Landing lead = Scenario::make(sc.lead, Landing::From::Edge, 480);
    lead.easing = SnapshotTransitionEasingCurve{ 0.65f, 0.0f, 0.35f, 1.0f };   // Glide
    Landing perc2 = Scenario::make(sc.perc2, Landing::From::Grow, 240);
    perc2.easing = SnapshotTransitionEasingCurve{};                             // Linear
    sc.tl.setCueLandings(sc.pin, {
        chords, Scenario::make(sc.bass, Landing::From::WhereItWas, 960), lead, custom, perc2,
    });

    const int    sampleRate = 48000;
    const double bpm        = 140.0;
    const auto   set        = sc.tl.landingsAt(TickTime{ sc.pin.ticks - 1 });
    CHECK(set.count == 5, "all five landings resolve");
    const int64_t pinS = RenderClock::ppqToSample(set.pinTick.ticks, sampleRate, bpm);

    const GridSnapshot* snapB = nullptr;
    for (const auto& s : sc.tl.getGridSnapshots())
        if (s.id == sc.twoId) snapB = &s;
    CHECK(snapB != nullptr, "snapshot B found");
    if (!snapB) return;

    for (int i = 0; i < set.count; ++i) {
        const Resolved& r = set.items[i];
        const GridSlot* slot = nullptr;
        for (const auto& s : snapB->slots)
            if (s.trackId == r.trackId) slot = &s;
        CHECK(slot != nullptr, "the landing track has a slot in B");
        if (!slot) continue;

        // What B draws: exactly the call the compositor makes for a grid cell.
        const float gap = xleth::effectiveSlotGap(
            snapB->gapScale, sc.tl.getTrack(r.trackId)->gapScaleOverride);
        float bx, by, bw, bh, ux, uy, uw, uh;
        xleth::slotCanvasRect(slot->gridX, slot->gridY, slot->spanX, slot->spanY,
                              snapB->columns, snapB->rows, gap, bx, by, bw, bh);
        xleth::slotCellRect(slot->gridX, slot->gridY, slot->spanX, slot->spanY,
                            snapB->columns, snapB->rows, ux, uy, uw, uh);

        const int64_t startS = RenderClock::ppqToSample(r.startTick.ticks, sampleRate, bpm);

        // At the pin, and through the carry phase.
        for (const int64_t S : { pinS, pinS + 1, pinS + 100000 }) {
            const auto pose = xleth::landing::evaluateLanding(r, S, startS, pinS);
            CHECK(sameBits(pose.x, bx) && sameBits(pose.y, by)
                  && sameBits(pose.w, bw) && sameBits(pose.h, bh),
                  "at and after the pin the rect is bitwise B's drawn rect");
            CHECK(sameBits(pose.unitW, uw) && sameBits(pose.unitH, uh),
                  "at and after the pin Roam's unit is bitwise B's pre-gap placement");
            CHECK(pose.opacity == 1.0f, "at and after the pin the landing opacity is exactly 1");
        }

        // At and before the start: the from rect, exactly.
        for (const int64_t S : { startS, startS - 1, startS - 100000 }) {
            const auto pose = xleth::landing::evaluateLanding(r, S, startS, pinS);
            CHECK(sameBits(pose.x, r.fromX) && sameBits(pose.y, r.fromY)
                  && sameBits(pose.w, r.fromW) && sameBits(pose.h, r.fromH),
                  "at and before its start a landing sits at its from rect");
            CHECK(sameBits(pose.opacity, r.fromOpacity),
                  "at and before its start a landing has its fromOpacity");
        }

        // In between: strictly inside, monotonic, and a pure function of S.
        float lastOpacity = r.fromOpacity;
        bool  monotonic = true;
        for (int step = 1; step < 16; ++step) {
            const int64_t S = startS + (pinS - startS) * step / 16;
            const auto a = xleth::landing::evaluateLanding(r, S, startS, pinS);
            const auto b = xleth::landing::evaluateLanding(r, S, startS, pinS);
            CHECK(sameBits(a.x, b.x) && sameBits(a.y, b.y) && sameBits(a.w, b.w)
                  && sameBits(a.h, b.h) && sameBits(a.opacity, b.opacity),
                  "the pose is a pure function of the sample");
            if (a.opacity + 1e-6f < lastOpacity) monotonic = false;
            lastOpacity = a.opacity;
            const float lo = std::min(r.fromW, r.toW) - 1e-6f;
            const float hi = std::max(r.fromW, r.toW) + 1e-6f;
            CHECK(a.w >= lo && a.w <= hi, "the in-flight width stays between from and to");
        }
        CHECK(monotonic, "opacity never falls on the way in");
    }

    // Linear easing at the midpoint is the midpoint.
    {
        const Resolved* p2 = findResolved(set, sc.perc2);
        CHECK(p2 != nullptr, "perc 2 resolved");
        if (p2) {
            const int64_t startS = RenderClock::ppqToSample(p2->startTick.ticks, sampleRate, bpm);
            const int64_t midS = startS + (pinS - startS) / 2;
            const auto pose = xleth::landing::evaluateLanding(*p2, midS, startS, pinS);
            const double p = xleth::landing::landingProgress(midS, startS, pinS);
            CHECK_NEAR(pose.w, p2->toW * p, 1e-6, "Linear: Grow is at p of its width at progress p");
        }
    }

    // Land (the default) is a strong ease-out: well past halfway by the midpoint.
    {
        const Resolved* c = findResolved(set, sc.chords);
        if (c) {
            const int64_t startS = RenderClock::ppqToSample(c->startTick.ticks, sampleRate, bpm);
            const auto pose = xleth::landing::evaluateLanding(*c, startS + (pinS - startS) / 2, startS, pinS);
            const float travelled = (pose.w - c->fromW) / (c->toW - c->fromW);
            CHECK(travelled > 0.8f && travelled < 1.0f, "Land has covered most of the move by halfway");
            CHECK(pose.opacity > 0.7f && pose.opacity < 1.0f, "fromOpacity 70% eases toward 1");
        }
    }

    // Progress edge cases.
    CHECK(xleth::landing::landingProgress(100, 100, 100) == 1.0,
          "zero-length lead-in: at the pin progress is 1");
    CHECK(xleth::landing::landingProgress(99, 100, 100) == 0.0,
          "zero-length lead-in: before the pin it has not started");
    CHECK(xleth::landing::landingProgress(50, 0, 100) == 0.5, "progress is linear in samples");
    CHECK(xleth::landing::landingProgress(-5, 0, 100) == 0.0, "before the start progress is 0");
    CHECK(xleth::landing::landingProgress(500, 0, 100) == 1.0, "after the pin progress is 1");
}

// ─── [R] Reflow ──────────────────────────────────────────────────────────────

void testReflow() {
    std::cout << "[R] Reflow\n";

    Scenario sc;
    CHECK(!sc.tl.reflowCueLandings(TickTime{ 111 }, 960), "reflow: no cue at the tick -> false");

    // An existing landing for a track Reflow does not touch must survive.
    Landing leadLanding = Scenario::make(sc.lead, Landing::From::Edge, 480);
    leadLanding.fromOpacity = 0.5f;
    sc.tl.setCueLandings(sc.pin, { leadLanding });

    CHECK(sc.tl.reflowCueLandings(sc.pin, 960), "reflow succeeds on a resolvable cue");
    const auto& landings = sc.tl.getGridCues()[0].landings;
    CHECK(landings.size() == 3, "reflow adds chords and bass and keeps lead");
    const auto find = [&](int trackId) -> const Landing* {
        for (const auto& l : landings) if (l.trackId == trackId) return &l;
        return nullptr;
    };
    const Landing* c = find(sc.chords);
    const Landing* b = find(sc.bass);
    const Landing* l = find(sc.lead);
    CHECK(c && c->from == Landing::From::WhereItWas && c->leadInTicks == 960,
          "chords: a WhereItWas landing with the given lead-in");
    CHECK(b && b->from == Landing::From::WhereItWas && b->leadInTicks == 960,
          "bass: a WhereItWas landing with the given lead-in");
    CHECK(l && l->from == Landing::From::Edge && l->leadInTicks == 480 && l->fromOpacity == 0.5f,
          "lead (in B, not in A) is left exactly as it was");
    CHECK(find(sc.perc1) == nullptr && find(sc.perc2) == nullptr,
          "tracks in B but not in A get no landing");
    CHECK(landings[0].trackId == sc.lead, "existing landings keep their place in the list");

    // Reflow again with a different lead-in: replaces, does not duplicate.
    CHECK(sc.tl.reflowCueLandings(sc.pin, 1920), "reflow again");
    CHECK(sc.tl.getGridCues()[0].landings.size() == 3, "a second reflow adds nothing new");
    CHECK(find(sc.chords) && find(sc.chords)->leadInTicks == 1920,
          "a second reflow replaces the landing it made");

    // A track at the same canvas rect in A and B does not move, so no landing.
    {
        Scenario same;
        same.tl.setActiveGridSnapshot(same.twoId);
        GridLayout two = same.tl.getGridLayout();
        two.columns = 2; two.rows = 1; two.gapScale = 0.1f;     // same geometry as A
        two.slots = { slotAt(same.chords, 0, 0, 8, 8), slotAt(same.bass, 8, 0, 4, 8) };
        same.tl.setGridLayout(two);
        same.tl.setActiveGridSnapshot(same.baseId);
        CHECK(same.tl.reflowCueLandings(same.pin, 960), "reflow with one unmoved track");
        const auto& ls = same.tl.getGridCues()[0].landings;
        CHECK(ls.size() == 1 && ls[0].trackId == same.bass,
              "only the track whose rect changed gets a landing");
    }

    // A track that is a fullscreen layer in A and a slot in B does move.
    {
        Scenario fs;
        fs.tl.setActiveGridSnapshot(fs.baseId);
        FullscreenLayer fl;
        fl.trackId = fs.lead;
        fs.tl.setFullscreenLayers({ fl });
        CHECK(fs.tl.reflowCueLandings(fs.pin, 960), "reflow with a fullscreen track in A");
        bool leadReflowed = false;
        for (const auto& x : fs.tl.getGridCues()[0].landings)
            if (x.trackId == fs.lead && x.from == Landing::From::WhereItWas) leadReflowed = true;
        CHECK(leadReflowed, "fullscreen in A, slot in B: reflow adds a landing");
    }

    // The cap holds, and existing landings are the ones kept.
    {
        Scenario cap;
        std::vector<Landing> full;
        for (int i = 0; i < 16; ++i)
            full.push_back(Scenario::make(1000 + i, Landing::From::Edge, 960));
        cap.tl.setCueLandings(cap.pin, full);
        CHECK(cap.tl.reflowCueLandings(cap.pin, 960), "reflow on a full cue");
        const auto& ls = cap.tl.getGridCues()[0].landings;
        CHECK(ls.size() == 16 && ls[0].trackId == 1000 && ls[15].trackId == 1015,
              "a full cue keeps its 16 landings; reflow's additions are turned away");
    }

    // A dangling cue cannot be reflowed.
    {
        Scenario d;
        d.tl.addGridCue(TickTime{ 4800 }, "snap-does-not-exist");
        CHECK(!d.tl.reflowCueLandings(TickTime{ 4800 }, 960),
              "reflow: the cue's snapshot is gone -> false, nothing changed");
    }
}

} // namespace

int main() {
    testNormalize();
    testJson();
    testCueCrud();
    testWindows();
    testFromRects();
    testSeam();
    testReflow();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cout << "FAILED\n";
    return 1;
}
