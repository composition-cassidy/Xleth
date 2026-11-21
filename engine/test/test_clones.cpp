// test_clones.cpp — Clones (docs/XLETH_CLONE_SPEC.md, model/Clone.h).
//
// Voice assignment rules, persistence, event routing to Voice clones, the
// render snapshot's Trail entries, the collector (Voice cells, Idle, Trails at
// the delayed time, draw order, tint, opacity, mute independence) and the edit
// commands (add / remove cascade / pin rewrites / reorder / layout grouping).
//
// Output prefix: [Clones].

#include "model/Clone.h"
#include "model/LensRoam.h"
#include "model/Pattern.h"
#include "model/Timeline.h"
#include "model/Track.h"
#include "render/FrameCollector.h"
#include "render/VideoEventBuilder.h"
#include "commands/TimelineCommands.h"
#include "SyncManager.h"

#include <algorithm>
#include <cmath>
#include <iostream>
#include <string>
#include <vector>

using json = nlohmann::json;

static int g_fail = 0;
static int g_pass = 0;

#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (cond) { ++g_pass; }                                                \
        else {                                                                 \
            ++g_fail;                                                          \
            std::cout << "    FAIL: " << (msg) << "  (" #cond ")  line "       \
                      << __LINE__ << "\n";                                     \
        }                                                                      \
    } while (0)

using clones::VoiceNote;
using clones::assignVoices;

static VoiceNote vn(int64_t s, int64_t e, int pitch, int id, int pin = kVoicePinAuto) {
    VoiceNote n; n.start = s; n.end = e; n.pitch = pitch; n.id = id; n.pin = pin;
    return n;
}

// ─── [1] voice assignment rules ──────────────────────────────────────────────

static void test_assignment() {
    std::cout << "[1] voice assignment (spec 'How notes are assigned to voices')\n";
    // No clones: everything on the source, nothing overflows.
    {
        auto r = assignVoices({ vn(0, 960, 67, 1), vn(0, 960, 64, 2) }, 0);
        CHECK(r[0].voice == 0 && r[1].voice == 0 && !r[0].overflow && !r[1].overflow,
              "no Voice clones: every note on the source");
    }
    // A lead alone stays on the source; a harmony entering mid-note, however
    // late, goes to Clone 1.
    {
        auto r = assignVoices({ vn(0, 3840, 67, 1), vn(2000, 2100, 64, 2) }, 1);
        CHECK(r[0].voice == 0, "lead alone plays on the source");
        CHECK(r[1].voice == 1, "a late overlapping note goes to Clone 1");
    }
    // Same tick: highest pitch first (ruled 2026-11-16: G stays, E -> Clone 1).
    {
        auto r = assignVoices({ vn(0, 960, 64, 1), vn(0, 960, 67, 2) }, 1);
        CHECK(r[1].voice == 0 && r[0].voice == 1, "same tick: G (67) on the source, E (64) on Clone 1");
    }
    // A note ending exactly where the next starts does not overlap it.
    {
        auto r = assignVoices({ vn(0, 960, 60, 1), vn(960, 1920, 62, 2) }, 1);
        CHECK(r[0].voice == 0 && r[1].voice == 0, "touching notes share voice 0");
    }
    // Lowest free voice; a voice frees when its note ends.
    {
        auto r = assignVoices({ vn(0, 3840, 67, 1), vn(0, 1920, 64, 2), vn(960, 1920, 60, 3),
                                vn(2880, 3000, 62, 4) }, 2);
        CHECK(r[0].voice == 0 && r[1].voice == 1 && r[2].voice == 2, "chord + strum fill voices 0, 1, 2");
        CHECK(r[3].voice == 1, "a later note takes the lowest free voice (1 freed at 1920)");
    }
    // Overflow: more sounding notes than voices -> the source, flagged.
    {
        auto r = assignVoices({ vn(0, 960, 67, 1), vn(0, 960, 64, 2), vn(0, 960, 60, 3) }, 1);
        CHECK(r[0].voice == 0 && r[1].voice == 1, "two voices taken by the top two notes");
        CHECK(r[2].voice == 0 && r[2].overflow, "the third overflows onto the source");
        CHECK(!r[0].overflow && !r[1].overflow, "the placed notes do not overflow");
    }
    // Pins are placed first; Auto fills around them.
    {
        auto r = assignVoices({ vn(0, 960, 67, 1, 1), vn(0, 960, 64, 2) }, 1);
        CHECK(r[0].voice == 1, "pinned to Clone 1");
        CHECK(r[1].voice == 0, "Auto note fills the source around the pin");
    }
    // A pin to a voice that does not exist plays as Auto.
    {
        auto r = assignVoices({ vn(0, 960, 67, 1, 3) }, 1);
        CHECK(r[0].voice == 0 && !r[0].overflow, "pin to a missing voice -> Auto");
    }
    // Inert (slide) notes occupy nothing.
    {
        std::vector<VoiceNote> n = { vn(0, 960, 67, 1), vn(0, 960, 64, 2) };
        n[0].inert = true;
        auto r = assignVoices(n, 1);
        CHECK(r[0].voice == 0 && r[1].voice == 0, "a slide note spawns no cell and frees voice 0");
    }
    // Decided from the pattern alone: order of the input does not matter.
    {
        auto a = assignVoices({ vn(0, 960, 64, 2), vn(0, 960, 67, 1), vn(480, 600, 60, 3) }, 2);
        auto b = assignVoices({ vn(480, 600, 60, 3), vn(0, 960, 67, 1), vn(0, 960, 64, 2) }, 2);
        CHECK(a[0].voice == b[2].voice && a[1].voice == b[1].voice && a[2].voice == b[0].voice,
              "assignment does not depend on note list order");
    }
}

// ─── [2] persistence ─────────────────────────────────────────────────────────

static void test_json() {
    std::cout << "[2] JSON: clone fields and voicePin are written only when used\n";
    TrackInfo plain;
    plain.id = 3; plain.name = "Lead";
    json jp = plain;
    CHECK(!jp.contains("cloneOf") && !jp.contains("cloneKind"), "an ordinary track writes no clone keys");
    TrackInfo back = jp.get<TrackInfo>();
    CHECK(back.cloneOf == -1, "an ordinary track loads as one");

    TrackInfo v;
    v.id = 7; v.name = "Lead \xC2\xB7 Clone 1";
    v.cloneOf = 3; v.cloneKind = CloneKind::Voice; v.cloneLensMode = CloneLensMode::Own;
    json jv = v;
    CHECK(jv.value("cloneOf", -1) == 3 && jv.value("cloneKind", std::string()) == "Voice"
          && jv.value("lensMode", std::string()) == "Own", "voice clone keys written");
    CHECK(!jv.contains("delayTicks"), "a voice clone writes no Trail keys");
    TrackInfo v2 = jv.get<TrackInfo>();
    CHECK(v2.isVoiceClone() && v2.cloneOf == 3 && v2.cloneLensMode == CloneLensMode::Own,
          "voice clone round trip");

    TrackInfo t;
    t.id = 8; t.name = "Lead \xC2\xB7 Trail 1";
    t.cloneOf = 3; t.cloneKind = CloneKind::Trail;
    t.trail.delayTicks = 720; t.trail.tintRgb = 0xF07A2A; t.trail.opacity = 0.75;
    xleth::keycurve::Key k;
    k.position = xleth::keycurve::Position::timelineTicks(960); k.value = 0.5;
    k.interp = xleth::keycurve::Interp::Bezier; k.bez = { 0.1, 0.2, 0.3, 1.4 };
    t.trail.opacityKeys.push_back(k);
    json jt = t;
    CHECK(jt.value("tint", std::string()) == "#F07A2A", "tint written as #RRGGBB");
    TrackInfo t2 = jt.get<TrackInfo>();
    CHECK(t2.isTrailClone() && t2.trail == t.trail, "trail clone round trip (keys + bezier)");

    // Tolerant: unknown kind (a newer build) / bad cloneOf -> ordinary track.
    json bad = jt; bad["cloneKind"] = "Hologram";
    CHECK(bad.get<TrackInfo>().cloneOf == -1, "unknown kind loads as an ordinary track");
    json self = jt; self["cloneOf"] = 8;
    CHECK(self.get<TrackInfo>().cloneOf == -1, "a clone of itself loads as an ordinary track");
    json clampD = jt; clampD["delayTicks"] = -5; clampD["opacity"] = 7;
    TrackInfo t3 = clampD.get<TrackInfo>();
    CHECK(t3.trail.delayTicks >= clones::kMinTrailDelayTicks && t3.trail.opacity == 1.0,
          "out-of-range trail values are clamped on load");

    PatternNote n;
    n.id = 4;
    json jn = n;
    CHECK(!jn.contains("voicePin"), "an Auto note writes no voicePin");
    n.voicePin = 2;
    jn = n;
    CHECK(jn.value("voicePin", -1) == 2 && jn.get<PatternNote>().voicePin == 2, "voicePin round trip");
    jn["voicePin"] = -3;
    CHECK(jn.get<PatternNote>().voicePin == kVoicePinAuto, "a negative pin loads as Auto");
}

// ─── fixtures ─────────────────────────────────────────────────────────────────

struct Fx {
    Timeline tl{ 140.0, 48000.0 };
    int srcId = -1, reg = -1;
    int lead = -1, other = -1, c1 = -1, c2 = -1, trail = -1;
    int pattern = -1;
};

static PatternNote note(int id, double beat, double lenBeats, int pitch) {
    PatternNote n;
    n.id = id;
    n.position = TickTime::fromBeats(beat);
    n.duration = TickTime{ static_cast<int64_t>(std::llround(lenBeats * 960.0)) };
    n.pitch = pitch;
    n.velocity = 1.0f;
    return n;
}

static TrackInfo cloneTrack(int sourceId, CloneKind kind, const char* name) {
    TrackInfo c;
    c.name = name;
    c.type = TrackInfo::Type::Pattern;
    c.visualOnly = true;
    c.cloneOf = sourceId;
    c.cloneKind = kind;
    return c;
}

// Lead (Pattern track) playing one 4-beat pattern:
//   G  67  0 .. 4     (voice 0)
//   E  64  0 .. 2     (voice 1, same tick, lower)
//   C  60  1 .. 2     (voice 2, strum)
//   D  62  1.5..1.75  (overflow: 3 voices busy)
//   A  69  3 .. 3.5   (voice 1, free again)
static void buildFx(Fx& f, bool withClones) {
    SourceMedia src;
    src.filePath = "clones_fixture.mp4";
    src.hasVideo = true; src.fps = 30.0; src.fpsNum = 30; src.fpsDen = 1;
    src.duration = 60.0; src.totalFrames = 1800; src.width = 1920; src.height = 1080;
    f.srcId = f.tl.addSource(src);
    SampleRegion r;
    r.sourceId = f.srcId; r.startTime = 0.0; r.endTime = 30.0; r.startFrame = 0; r.endFrame = 899;
    f.reg = f.tl.addRegion(r);

    TrackInfo lead; lead.name = "Lead"; lead.type = TrackInfo::Type::Pattern;
    f.lead = f.tl.addTrack(lead);
    TrackInfo other; other.name = "Other"; other.type = TrackInfo::Type::Pattern;
    f.other = f.tl.addTrack(other);

    Pattern p;
    p.name = "P"; p.regionId = f.reg; p.length = TickTime::fromBeats(4);
    p.notes = { note(1, 0, 4, 67), note(2, 0, 2, 64), note(3, 1, 1, 60),
                note(4, 1.5, 0.25, 62), note(5, 3, 0.5, 69) };
    p.nextNoteId = 6;
    f.pattern = f.tl.addPattern(p);
    PatternBlock b;
    b.trackId = f.lead; b.patternId = f.pattern;
    b.position = TickTime{ 0 }; b.duration = TickTime::fromBeats(4);
    f.tl.addPatternBlock(b);

    if (withClones) {
        f.c1 = f.tl.addTrack(cloneTrack(f.lead, CloneKind::Voice, "Lead \xC2\xB7 Clone 1"));
        f.c2 = f.tl.addTrack(cloneTrack(f.lead, CloneKind::Voice, "Lead \xC2\xB7 Clone 2"));
        TrackInfo tr = cloneTrack(f.lead, CloneKind::Trail, "Lead \xC2\xB7 Trail 1");
        tr.trail.delayTicks = 960.0;           // one beat
        tr.trail.tintRgb    = 0xFF0000u;
        tr.trail.opacity    = 0.5;
        f.trail = f.tl.addTrack(tr);
        f.tl.getTrackMutable(f.c2)->cloneLensMode = CloneLensMode::Own;
    }

    GridLayout g;
    g.columns = 3; g.rows = 1;
    g.slots.push_back({ f.lead, 0, 0, kGridSubUnitsPerColumn, kGridSubUnitsPerRow, 1.0f, 0 });
    if (withClones) {
        g.slots.push_back({ f.c1, kGridSubUnitsPerColumn, 0, kGridSubUnitsPerColumn, kGridSubUnitsPerRow, 1.0f, 1 });
        g.slots.push_back({ f.c2, 2 * kGridSubUnitsPerColumn, 0, kGridSubUnitsPerColumn, kGridSubUnitsPerRow, 1.0f, 2 });
    }
    f.tl.setGridLayout(g);
}

static const VideoEvent* eventFor(const std::vector<VideoEvent>& evs, int noteId) {
    for (const auto& e : evs) if (e.lensNoteId == noteId) return &e;
    return nullptr;
}

// ─── [3] events are routed to Voice clones ───────────────────────────────────

static void test_routing() {
    std::cout << "[3] VideoEventBuilder routes notes to Voice clones\n";
    Fx plain; buildFx(plain, false);
    const auto r0 = xleth::videoevents::build(plain.tl, 140.0, 48000.0);
    CHECK(r0.events.size() == 5, "five note events");
    bool allSource = true;
    for (const auto& e : r0.events) allSource = allSource && e.trackId == plain.lead && e.lensTrackId == -1;
    CHECK(allSource, "no clones: every event on the source, lensTrackId unset (today's events)");
    CHECK(r0.stats.voiceCloneEvents == 0, "no routed events without clones");

    Fx f; buildFx(f, true);
    const auto r = xleth::videoevents::build(f.tl, 140.0, 48000.0);
    CHECK(r.events.size() == 5, "routing never drops or adds a note");
    const VideoEvent* g = eventFor(r.events, 1);
    const VideoEvent* e = eventFor(r.events, 2);
    const VideoEvent* c = eventFor(r.events, 3);
    const VideoEvent* d = eventFor(r.events, 4);
    const VideoEvent* a = eventFor(r.events, 5);
    CHECK(g && g->trackId == f.lead, "G (melody) stays in the source cell");
    CHECK(e && e->trackId == f.c1 && e->lensTrackId == f.lead, "E -> Clone 1, Lens Linked to the source");
    CHECK(c && c->trackId == f.c2 && c->lensTrackId == f.c2, "C (strum) -> Clone 2, Lens Own");
    CHECK(d && d->trackId == f.lead, "D overflows onto the source");
    CHECK(a && a->trackId == f.c1, "A -> Clone 1 again once E has ended");
    CHECK(r.stats.voiceCloneEvents == 3, "three routed events");
    CHECK(e && e->lensPatternId == f.pattern && e->lensNoteId == 2,
          "the note's override key travels with it to the clone");
}

// ─── [4] snapshot: trails + Own overrides ────────────────────────────────────

static void test_snapshot() {
    std::cout << "[4] LensRoamSnapshot: Trail entries, Own-clone overrides\n";
    Fx f; buildFx(f, true);
    TrackInfo t2 = cloneTrack(f.lead, CloneKind::Trail, "Lead \xC2\xB7 Trail 2");
    t2.trail.delayTicks = 1920.0;
    xleth::keycurve::Key k0, k1;
    k0.position = xleth::keycurve::Position::timelineTicks(0);    k0.value = 0.0;
    k1.position = xleth::keycurve::Position::timelineTicks(960);  k1.value = 1.0;
    t2.trail.opacityKeys = { k0, k1 };
    const int trail2 = f.tl.addTrack(t2);
    // An override on note 3 (played by the Own clone c2).
    for (auto& n : f.tl.getPatternMutable(f.pattern)->notes)
        if (n.id == 3) {
            auto o = std::make_shared<LensNoteOverride>();
            o->mode = LensOverrideMode::Nudge;
            n.lensOverride = o;
        }
    auto snap = buildLensRoamSnapshot(f.tl);
    std::size_t first = 0, count = 0;
    snap->trailsOf(f.lead, first, count);
    CHECK(count == 2, "two Trail clones of the source");
    CHECK(count == 2 && snap->trails[first].trackId == trail2 && snap->trails[first + 1].trackId == f.trail,
          "farthest delay first (draw order under the source)");
    CHECK(count == 2 && std::fabs(snap->trailOpacityAt(snap->trails[first], 480.0) - 0.5) < 1e-9,
          "opacity keys are evaluated (absolute, timeline ticks)");
    CHECK(count == 2 && snap->trailOpacityAt(snap->trails[first + 1], 480.0) == 0.5,
          "unkeyed trail opacity = its base");
    snap->trailsOf(f.other, first, count);
    CHECK(count == 0, "a track without trails has none");
    CHECK(snap->counts().trails == 2, "Counts.trails");
    CHECK(snap->overrideFor(f.c2, f.pattern, 3) != nullptr, "an Own clone gets the notes' overrides compiled");
    CHECK(snap->overrideFor(f.c1, f.pattern, 3) == nullptr, "a Linked clone reads the source's (none extra)");
    CHECK(snap->overrideFor(f.lead, f.pattern, 3) != nullptr, "the source keeps its own");
}

// ─── [5] collector: Voice cells, Idle, Trails ────────────────────────────────

static const CellFrameRequest* reqFor(const std::vector<CellFrameRequest>& reqs, int trackId, int* index = nullptr) {
    for (size_t i = 0; i < reqs.size(); ++i)
        if (reqs[i].trackId == trackId) { if (index) *index = static_cast<int>(i); return &reqs[i]; }
    return nullptr;
}

// The output frame (30 fps, 140 bpm) nearest a beat.
static int64_t frameAtBeat(double beat) {
    return static_cast<int64_t>(std::llround(beat * 60.0 / 140.0 * 30.0));
}

static void test_collector() {
    std::cout << "[5] FrameCollector: Voice cells, Idle, Trails at the delayed time\n";
    Fx f; buildFx(f, true);
    const AVRational fps{ 30, 1 };
    auto events = xleth::videoevents::build(f.tl, 140.0, 48000.0).events;
    FrameCollector col;
    col.setLensRoamSnapshot(buildLensRoamSnapshot(f.tl));

    // Beat 0.5: G on the source, E on Clone 1; the trail (1 beat) is before
    // the timeline start -> nothing.
    {
        auto reqs = col.collectRequests(frameAtBeat(0.5), f.tl, 48000, fps, events);
        CHECK(reqFor(reqs, f.lead) && reqFor(reqs, f.c1), "source and Clone 1 cells drawn");
        CHECK(!reqFor(reqs, f.c2), "Clone 2 idle: no request");
        CHECK(!reqFor(reqs, f.trail), "a trail shows nothing before its delayed time reaches 0");
    }
    // Beat 1.6: G (source), E (Clone 1), C (Clone 2); trail replays beat 0.6.
    {
        auto reqs = col.collectRequests(frameAtBeat(1.6), f.tl, 48000, fps, events);
        int iS = -1, iT = -1;
        const CellFrameRequest* s = reqFor(reqs, f.lead, &iS);
        const CellFrameRequest* t = reqFor(reqs, f.trail, &iT);
        CHECK(s && reqFor(reqs, f.c1) && reqFor(reqs, f.c2), "three voices drawn while three notes sound");
        CHECK(t != nullptr, "the trail is drawn");
        CHECK(s && t && iT == iS - 1, "the trail draws directly under its source");
        CHECK(s && t && t->cellCol == s->cellCol && t->spanX == s->spanX, "the trail draws at the source's placement");
        // The overflow note D (1.5 .. 1.75) plays on the source the way a
        // Pattern Track always has: the latest note-on wins the source cell.
        CHECK(s && s->sourceFrameIndex <= 2, "overflow: the source cell shows D, the latest note-on");
    }
    // Beat 1.8 (D has ended): G on the source; the trail replays G at 0.8.
    {
        auto reqs = col.collectRequests(frameAtBeat(1.8), f.tl, 48000, fps, events);
        const CellFrameRequest* s = reqFor(reqs, f.lead);
        const CellFrameRequest* t = reqFor(reqs, f.trail);
        CHECK(s && t, "source and trail drawn at 1.8");
        if (s && t) {
            const int64_t dFrames = s->sourceFrameIndex - t->sourceFrameIndex;
            // Note G runs from beat 0 in both, so the gap is one beat of video
            // (60/140 s = 12.86 frames at 30 fps): the trail is the source,
            // one beat late.
            CHECK(dFrames >= 12 && dFrames <= 14, "trail frame = the source's frame one beat ago");
            if (!(dFrames >= 12 && dFrames <= 14))
                std::cout << "      source frame " << s->sourceFrameIndex << ", trail frame "
                          << t->sourceFrameIndex << "\n";
            CHECK(std::fabs(t->opacity - 0.5f * s->opacity) < 1e-6f, "trail opacity multiplies");
            CHECK(!t->visualChain.empty() && t->visualChain.back().type == VisualEffect::Type::Tint
                  && t->visualChain.back().params[0] == 1.0f && t->visualChain.back().params[1] == 0.0f,
                  "the tint is a multiply at the end of the trail's chain");
            CHECK(s->visualChain.empty(), "the source's own chain is untouched");
        }
    }
    // Added Roam offset: on top of the delayed source position.
    {
        f.tl.getTrackMutable(f.trail)->roam.base.offsetX = 0.25f;
        f.tl.getTrackMutable(f.lead)->roam.base.offsetY = 0.5f;
        col.setLensRoamSnapshot(buildLensRoamSnapshot(f.tl));
        auto reqs = col.collectRequests(frameAtBeat(1.6), f.tl, 48000, fps, events);
        const CellFrameRequest* t = reqFor(reqs, f.trail);
        CHECK(t && t->roam.offsetX == 0.25f && t->roam.offsetY == 0.5f,
              "trail roam = delayed source roam + its added offset");
        f.tl.getTrackMutable(f.trail)->roam.base.offsetX = 0.0f;
        f.tl.getTrackMutable(f.lead)->roam.base.offsetY = 0.0f;
        col.setLensRoamSnapshot(buildLensRoamSnapshot(f.tl));
    }
    // Muting the source hides its own cell only; the Clones keep theirs.
    {
        f.tl.getTrackMutable(f.lead)->muted = true;
        auto reqs = col.collectRequests(frameAtBeat(1.6), f.tl, 48000, fps, events);
        CHECK(!reqFor(reqs, f.lead), "muted source: its cell is hidden");
        CHECK(reqFor(reqs, f.c1) && reqFor(reqs, f.trail), "muted source: Voice and Trail clones still show");
        f.tl.getTrackMutable(f.lead)->muted = false;
    }
    // A Clone's own mute hides only it.
    {
        f.tl.getTrackMutable(f.trail)->muted = true;
        f.tl.getTrackMutable(f.c1)->muted = true;
        auto reqs = col.collectRequests(frameAtBeat(1.6), f.tl, 48000, fps, events);
        CHECK(reqFor(reqs, f.lead) && !reqFor(reqs, f.trail) && !reqFor(reqs, f.c1),
              "a muted Clone is hidden, the source is not");
        f.tl.getTrackMutable(f.trail)->muted = false;
        f.tl.getTrackMutable(f.c1)->muted = false;
    }
    // Idle draws nothing even with Hold Last Frame on.
    {
        f.tl.getTrackMutable(f.c1)->videoHoldLastFrame = true;
        auto reqs = col.collectRequests(frameAtBeat(2.5), f.tl, 48000, fps, events);
        CHECK(!reqFor(reqs, f.c1), "an idle Voice clone never holds a frame");
        f.tl.getTrackMutable(f.c1)->videoHoldLastFrame = false;
    }
    // A trail replays a held gap of its source (stateless): source holds over
    // its gap after the pattern's end, the trail one beat later still shows it.
    {
        f.tl.getTrackMutable(f.lead)->videoHoldLastFrame = true;
        // Beat 4.5: the block ended at 4 (source holds), the trail replays beat
        // 3.5 where G is still sounding (G runs to 4).
        auto reqs = col.collectRequests(frameAtBeat(4.5), f.tl, 48000, fps, events);
        CHECK(reqFor(reqs, f.trail) != nullptr, "trail replays the source's last beat");
        // Beat 5.5: the trail replays beat 4.5 = the source's held gap.
        auto reqs2 = col.collectRequests(frameAtBeat(5.5), f.tl, 48000, fps, events);
        CHECK(reqFor(reqs2, f.lead) != nullptr, "the source holds its gap");
        CHECK(reqFor(reqs2, f.trail) != nullptr, "the trail replays the held gap");
        f.tl.getTrackMutable(f.lead)->videoHoldLastFrame = false;
        auto reqs3 = col.collectRequests(frameAtBeat(5.5), f.tl, 48000, fps, events);
        CHECK(!reqFor(reqs3, f.trail), "no hold on the source -> the trail is empty in its gap");
    }
    // No clones: the collector output is exactly today's (one source cell).
    {
        Fx p; buildFx(p, false);
        auto ev = xleth::videoevents::build(p.tl, 140.0, 48000.0).events;
        FrameCollector c2;
        c2.setLensRoamSnapshot(buildLensRoamSnapshot(p.tl));
        auto reqs = c2.collectRequests(frameAtBeat(1.6), p.tl, 48000, fps, ev);
        CHECK(reqs.size() == 1 && reqs[0].trackId == p.lead, "no clones: one cell, the source");
    }
}

// ─── [6] commands ─────────────────────────────────────────────────────────────

static std::vector<int> flatOrder(const Timeline& tl) {
    std::vector<int> ids;
    for (const TrackInfo* t : tl.getAllTracks()) ids.push_back(t->id);
    return ids;
}

static int pinOf(const Timeline& tl, int patternId, int noteId) {
    for (const auto& n : tl.getPattern(patternId)->notes) if (n.id == noteId) return n.voicePin;
    return -99;
}

static void test_commands() {
    std::cout << "[6] commands: add, remove cascade, pin rewrites, reorder, layout grouping\n";
    Fx f; buildFx(f, false);
    // A third ordinary track after Other, so "directly under the source" is visible.
    TrackInfo third; third.name = "Third"; third.type = TrackInfo::Type::Pattern;
    const int t3 = f.tl.addTrack(third);

    AddCloneCommand add1(cloneTrack(f.lead, CloneKind::Voice, "Lead \xC2\xB7 Clone 1"), true, f.tl);
    add1.execute(f.tl);
    const int c1 = add1.trackId();
    CHECK(c1 > 0 && f.tl.getTrack(c1) && f.tl.getTrack(c1)->isVoiceClone(), "voice clone added");
    auto order = flatOrder(f.tl);
    CHECK(order.size() == 4 && order[0] == f.lead && order[1] == c1, "the clone sits directly under its source");
    CHECK(add1.placed(), "auto-placed into a free cell");
    bool slotted = false;
    for (const auto& s : f.tl.getGridLayout().slots) if (s.trackId == c1 && s.gridX == kGridSubUnitsPerColumn) slotted = true;
    CHECK(slotted, "placed in the first free cell (column 2)");

    AddCloneCommand add2(cloneTrack(f.lead, CloneKind::Voice, "Lead \xC2\xB7 Clone 2"), true, f.tl);
    add2.execute(f.tl);
    const int c2 = add2.trackId();
    AddCloneCommand addT(cloneTrack(f.lead, CloneKind::Trail, "Lead \xC2\xB7 Trail 1"), true, f.tl);
    addT.execute(f.tl);
    const int tr = addT.trackId();
    order = flatOrder(f.tl);
    CHECK(order.size() == 6 && order[1] == c1 && order[2] == c2 && order[3] == tr && order[4] == f.other,
          "clones stack under the source in creation order");
    CHECK(!addT.placed(), "a Trail clone takes no grid cell");
    CHECK(clones::voiceNumberOf(f.tl, *f.tl.getTrack(c2)) == 2, "Clone 2 is voice 2");

    // Undo / redo of an add.
    addT.undo(f.tl);
    CHECK(!f.tl.getTrack(tr) && flatOrder(f.tl).size() == 5, "undo removes the trail");
    addT.execute(f.tl);
    CHECK(f.tl.getTrack(tr) && flatOrder(f.tl)[3] == tr, "redo restores it in place, same id");

    // Moving the source carries its clones (setTrackOrder / setTrackLayout).
    {
        std::vector<int> req = { f.other, t3, f.lead, c1, c2, tr };
        // Ask for the clones somewhere else: they still follow the source.
        std::vector<int> scrambled = { c1, f.other, t3, c2, f.lead, tr };
        CHECK(f.tl.setTrackOrder(scrambled), "setTrackOrder accepted");
        order = flatOrder(f.tl);
        CHECK(order == std::vector<int>({ f.other, t3, f.lead, c1, c2, tr }),
              "clones regroup under the moved source");
        (void)req;
        TrackLayout l = f.tl.getTrackLayout();
        std::reverse(l.rootOrder.begin(), l.rootOrder.end());
        CHECK(f.tl.setTrackLayout(l), "setTrackLayout accepted");
        order = flatOrder(f.tl);
        const auto it = std::find(order.begin(), order.end(), f.lead);
        CHECK(it != order.end() && it + 1 != order.end() && *(it + 1) == c1 && *(it + 2) == c2 && *(it + 3) == tr,
              "clones keep their relative order under the source after any layout write");
    }

    // Pins: note 1 -> Clone 2, note 2 -> Clone 1.
    {
        SetNotesVoicePinCommand p1({ { f.pattern, 1 } }, 2, f.tl);
        CHECK(p1.changesAnything(), "pin changes something");
        p1.execute(f.tl);
        SetNotesVoicePinCommand p2({ { f.pattern, 2 } }, 1, f.tl);
        p2.execute(f.tl);
        CHECK(pinOf(f.tl, f.pattern, 1) == 2 && pinOf(f.tl, f.pattern, 2) == 1, "pins set");
        SetNotesVoicePinCommand same({ { f.pattern, 1 } }, 2, f.tl);
        CHECK(!same.changesAnything(), "re-pinning to the same voice is a no-op");
    }
    // Reorder: [c2, c1, tr] -> pins follow their clones (1 <-> 2).
    {
        ReorderClonesCommand ro(f.lead, { c2, c1, tr }, f.tl);
        CHECK(ro.isValid() && ro.changesAnything(), "reorder valid");
        ro.execute(f.tl);
        CHECK(clones::voiceNumberOf(f.tl, *f.tl.getTrack(c2)) == 1, "Clone 2 is now voice 1");
        CHECK(pinOf(f.tl, f.pattern, 1) == 1 && pinOf(f.tl, f.pattern, 2) == 2,
              "pinned notes stay with the Clone they were pinned to");
        ro.undo(f.tl);
        CHECK(clones::voiceNumberOf(f.tl, *f.tl.getTrack(c1)) == 1 && pinOf(f.tl, f.pattern, 1) == 2,
              "undo restores order and pins");
        ReorderClonesCommand bad(f.lead, { c1, tr }, f.tl);
        CHECK(!bad.isValid(), "a reorder that omits a clone is invalid");
    }
    // Removing Clone 1: its pins go Auto, Clone 2's pins move down to 1.
    {
        const auto ord0 = flatOrder(f.tl);
        RemoveTrackCommand rm(c1, f.tl);
        rm.execute(f.tl);
        CHECK(!f.tl.getTrack(c1), "Clone 1 removed");
        CHECK(pinOf(f.tl, f.pattern, 2) == kVoicePinAuto, "notes pinned to it fall back to Auto");
        CHECK(pinOf(f.tl, f.pattern, 1) == 1, "notes pinned to Clone 2 stay with it (now voice 1)");
        rm.undo(f.tl);
        CHECK(f.tl.getTrack(c1) && pinOf(f.tl, f.pattern, 2) == 1 && pinOf(f.tl, f.pattern, 1) == 2,
              "undo restores the clone and the pins");
        CHECK(flatOrder(f.tl) == ord0, "undo puts the clone back in its exact place (voice 1)");
    }
    // Removing the source removes its clones in the same step.
    {
        const auto before = flatOrder(f.tl);
        RemoveTrackCommand rm(f.lead, f.tl);
        CHECK(rm.removedCloneCount() == 3, "three clones go with the source");
        rm.execute(f.tl);
        CHECK(!f.tl.getTrack(f.lead) && !f.tl.getTrack(c1) && !f.tl.getTrack(c2) && !f.tl.getTrack(tr),
              "source and clones removed");
        CHECK(flatOrder(f.tl).size() == 2, "the other tracks remain");
        rm.undo(f.tl);
        CHECK(flatOrder(f.tl) == before, "undo restores every track in its place");
        CHECK(pinOf(f.tl, f.pattern, 1) == 2, "removing the source does not rewrite pins");
    }
}

int main() {
    std::cout << "=== test_clones ===\n";
    test_assignment();
    test_json();
    test_routing();
    test_snapshot();
    test_collector();
    test_commands();
    std::cout << "[Clones] " << g_pass << " passed, " << g_fail << " failed\n";
    return g_fail == 0 ? 0 : 1;
}
