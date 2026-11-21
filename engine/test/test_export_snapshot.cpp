// test_export_snapshot.cpp — the frozen timeline copy export reads (spec
// Ruling 7, model/TimelineSnapshot.h).
//
//   [1] the copy is complete: it serializes byte-identically to the live one
//   [2] the copy is independent: edits to the live timeline (move clip, edit
//       notes, add track, retime) never show up in it, and vice versa
//   [3] the copy never calls back into MixEngine (invalidator cleared)
//   [4] the export event builder gives the same events from the copy as from
//       the live timeline (one evaluation path, e2c2826)
//   [5] optional: time the copy on a real project (XLETH_EXPORT_SNAPSHOT_PROJECT
//       = project DIRECTORY). The budget is 200 ms.
//
// Output prefix: [ExportSnapshot].

#include "model/TimelineSnapshot.h"
#include "model/Timeline.h"
#include "project/ProjectManager.h"
#include "render/VideoEventBuilder.h"
#include "SyncManager.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

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

struct Fixture {
    Timeline tl{ 140.0, 48000.0 };
    int src = -1, reg = -1, clipTrack = -1, patTrack = -1, clip = -1, pattern = -1, note = -1;
};

static void build(Fixture& f) {
    SourceMedia s;
    s.filePath = "snapshot_fixture.mp4";
    s.hasVideo = true; s.fps = 30.0; s.duration = 60.0; s.totalFrames = 1800;
    s.width = 1280; s.height = 720;
    f.src = f.tl.addSource(s);
    SampleRegion r;
    r.sourceId = f.src; r.startTime = 0.0; r.endTime = 10.0; r.startFrame = 0; r.endFrame = 299;
    f.reg = f.tl.addRegion(r);
    TrackInfo ct; ct.name = "Clips"; ct.type = TrackInfo::Type::Clip;
    f.clipTrack = f.tl.addTrack(ct);
    TrackInfo pt; pt.name = "Pattern"; pt.type = TrackInfo::Type::Pattern;
    f.patTrack = f.tl.addTrack(pt);
    Clip c; c.trackId = f.clipTrack; c.regionId = f.reg;
    c.position = TickTime{ 0 }; c.duration = TickTime::fromBeats(2);
    f.clip = f.tl.addClip(c);
    Pattern p; p.name = "P"; p.regionId = f.reg; p.length = TickTime::fromBeats(4);
    f.pattern = f.tl.addPattern(p);
    PatternNote n; n.position = TickTime{ 0 }; n.duration = TickTime::fromBeats(1); n.pitch = 60;
    f.note = f.tl.addNoteToPattern(f.pattern, n);
    PatternBlock b; b.trackId = f.patTrack; b.patternId = f.pattern;
    b.position = TickTime::fromBeats(4); b.duration = TickTime::fromBeats(4);
    f.tl.addPatternBlock(b);
    GridLayout layout; layout.columns = 2; layout.rows = 1;
    layout.slots.push_back({ f.clipTrack, 0, 0, kGridSubUnitsPerColumn, kGridSubUnitsPerRow, 1.0f, 0 });
    layout.slots.push_back({ f.patTrack, kGridSubUnitsPerColumn, 0,
                             kGridSubUnitsPerColumn, kGridSubUnitsPerRow, 1.0f, 1 });
    f.tl.setGridLayout(layout);
}

static void test_complete() {
    std::cout << "[1] the copy serializes identically to the live timeline\n";
    Fixture f; build(f);
    const auto frozen = makeFrozenTimelineCopy(f.tl);
    CHECK(frozen.timeline != nullptr, "copy exists");
    CHECK(frozen.timeline->toJSON().dump() == f.tl.toJSON().dump(), "toJSON identical");
    CHECK(frozen.timeline->getBPM() == f.tl.getBPM(), "BPM");
    CHECK(frozen.timeline->getAllClips().size() == f.tl.getAllClips().size(), "clip count");
    CHECK(frozen.copyMs >= 0.0, "copy time measured");
}

static void test_independent() {
    std::cout << "[2] live edits never reach the copy\n";
    Fixture f; build(f);
    const auto frozen = makeFrozenTimelineCopy(f.tl);
    const std::string before = frozen.timeline->toJSON().dump();

    CHECK(f.tl.moveClip(f.clip, f.clipTrack, TickTime::fromBeats(8)), "live: move clip");
    CHECK(f.tl.moveNote(f.pattern, f.note, TickTime::fromBeats(2), 67), "live: edit note");
    PatternNote extra; extra.position = TickTime::fromBeats(3); extra.duration = TickTime::fromBeats(1);
    CHECK(f.tl.addNoteToPattern(f.pattern, extra) > 0, "live: add note");
    TrackInfo t; t.name = "Late"; f.tl.addTrack(t);
    CHECK(f.tl.removeClip(f.clip), "live: delete clip");
    f.tl.setBPM(99.0);

    CHECK(frozen.timeline->toJSON().dump() == before, "copy unchanged after live edits");
    const Clip* c = frozen.timeline->getClip(f.clip);
    CHECK(c && c->position.ticks == 0, "copy still has the clip at its old position");
    const Pattern* p = frozen.timeline->getPattern(f.pattern);
    CHECK(p && p->notes.size() == 1 && p->notes[0].pitch == 60, "copy keeps the old notes");
    CHECK(frozen.timeline->getBPM() == 140.0, "copy keeps the old BPM");
}

static void test_no_callback() {
    std::cout << "[3] the copy cannot invalidate MixEngine caches\n";
    Fixture f; build(f);
    int calls = 0;
    f.tl.setClipCacheInvalidator([&calls](int, const char*) { ++calls; });
    const auto frozen = makeFrozenTimelineCopy(f.tl);
    // Only a test would ever write to the const copy; it proves the hook is gone.
    Timeline& w = const_cast<Timeline&>(*frozen.timeline);
    Clip c; c.trackId = f.clipTrack; c.regionId = f.reg; c.duration = TickTime::fromBeats(1);
    CHECK(w.addClip(c) > 0, "addClip on the copy");
    CHECK(calls == 0, "the copy's invalidator is cleared");
    Clip c2 = c; c2.position = TickTime::fromBeats(16);
    CHECK(f.tl.addClip(c2) > 0 && calls == 1, "the live invalidator still works");
}

static bool sameEvent(const VideoEvent& a, const VideoEvent& b) {
    return a.startBeat == b.startBeat && a.durationBeats == b.durationBeats
        && a.sourceId == b.sourceId && a.trackId == b.trackId
        && a.sourceStartTime == b.sourceStartTime && a.opacity == b.opacity
        && a.regionId == b.regionId && a.clipId == b.clipId
        && a.orientation == b.orientation && a.stateIndex == b.stateIndex
        && a.globalNoteIndex == b.globalNoteIndex;
}

static void test_same_events() {
    std::cout << "[4] one event builder: same events from copy and live\n";
    Fixture f; build(f);
    const auto frozen = makeFrozenTimelineCopy(f.tl);
    const auto live = xleth::videoevents::build(f.tl, 140.0, 48000.0);
    const auto copy = xleth::videoevents::build(*frozen.timeline, 140.0, 48000.0);
    CHECK(!live.events.empty(), "fixture produces events");
    bool same = live.events.size() == copy.events.size();
    for (size_t i = 0; same && i < live.events.size(); ++i)
        same = sameEvent(live.events[i], copy.events[i]);
    CHECK(same, "identical event lists");
}

static void test_real_project_timing() {
    const char* dir = std::getenv("XLETH_EXPORT_SNAPSHOT_PROJECT");
    if (!dir || !*dir) {
        std::cout << "[5] real project copy time: skip (XLETH_EXPORT_SNAPSHOT_PROJECT unset)\n";
        return;
    }
    std::cout << "[5] real project copy time: " << dir << "\n";
    ProjectManager pm;
    auto loaded = pm.loadProject(dir);
    CHECK(loaded.has_value(), "real project loads");
    if (!loaded) return;
    const Timeline& tl = *loaded;

    std::vector<double> ms;
    for (int i = 0; i < 9; ++i) {
        const auto frozen = makeFrozenTimelineCopy(tl);
        ms.push_back(frozen.copyMs);
        if (i == 0)
            CHECK(frozen.timeline->toJSON().dump() == tl.toJSON().dump(),
                  "real project: copy serializes identically");
    }
    const double first = ms.front();
    std::sort(ms.begin(), ms.end());
    std::printf("[ExportSnapshot] %zu clips, %zu tracks, %zu patterns, %zu blocks: "
                "first copy %.2f ms, median %.2f ms, max %.2f ms\n",
                tl.getAllClips().size(), tl.getAllTracks().size(),
                tl.getAllPatterns().size(), tl.getAllPatternBlocks().size(),
                first, ms[ms.size() / 2], ms.back());
    CHECK(ms.back() < 200.0, "copy stays under the 200 ms budget");
}

int main() {
    std::cout << "[ExportSnapshot] frozen timeline copy tests\n";
    test_complete();
    test_independent();
    test_no_callback();
    test_same_events();
    test_real_project_timing();
    std::cout << "[ExportSnapshot] " << g_pass << " passed, " << g_fail << " failed\n";
    return g_fail == 0 ? 0 : 1;
}
