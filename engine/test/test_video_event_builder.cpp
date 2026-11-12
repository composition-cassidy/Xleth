// test_video_event_builder.cpp
//
// xleth::videoevents::build is the one function that turns a timeline into the
// VideoEvent list, for the live preview AND for export. These tests pin the
// rules it shares with the audio engine (MixEngine::processPatternBlock), each
// of which the two old builders disagreed on:
//
//   [1] a note that overruns its block is cut at the block end
//   [2] with looping off only the first pass of the pattern exists — a
//       left-trimmed block extended past the pattern end must not wrap notes in
//   [3] with looping on, later passes do appear, in timeline order
//   [4] slide notes emit a SlideAnimationEvent, not a VideoEvent, unclamped
//   [5] clips: one event each, anchored through the shared source-anchor helper,
//       carrying stretch / reverse, in a deterministic order
//   [6] OfflineRenderer::buildVideoEvents is the same list (export == preview)

#include "model/ClipSourceAnchor.h"
#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "model/Track.h"
#include "render/OfflineRenderer.h"
#include "render/VideoEventBuilder.h"
#include "SyncManager.h"   // VideoEvent

#include <cmath>
#include <iostream>
#include <vector>

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                  \
    do {                                                                  \
        if (cond) {                                                       \
            ++g_passed;                                                   \
        } else {                                                          \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";   \
            ++g_failed;                                                   \
        }                                                                 \
    } while (0)

static bool near(double a, double b, double eps = 1e-9) { return std::abs(a - b) <= eps; }

static constexpr double kBpm = 120.0;
static constexpr double kSampleRate = 48000.0;

// One video source and one 2-second region starting 3 s into it.
static int addVideoRegion(Timeline& tl, double start = 3.0, double end = 5.0)
{
    SourceMedia src{};
    src.filePath    = "/fake/test.mp4";
    src.fileName    = "test.mp4";
    src.width       = 1920;
    src.height      = 1080;
    src.fps         = 30.0;
    src.duration    = 60.0;
    src.totalFrames = 1800;
    src.hasVideo    = true;
    const int srcId = tl.addSource(src);

    SampleRegion region{};
    region.sourceId      = srcId;
    region.name          = "Region";
    region.label         = SampleLabel::Pitch;
    region.startTime     = start;
    region.endTime       = end;
    region.audioFilePath = "/fake/test.wav";
    return tl.addRegion(region);
}

static int addTrack(Timeline& tl, TrackInfo::Type type)
{
    TrackInfo t{};
    t.name = "T";
    t.type = type;
    return tl.addTrack(t);
}

static PatternNote note(double posBeats, double durBeats, int pitch = 60, bool slide = false)
{
    PatternNote n{};
    n.position = TickTime::fromBeats(posBeats);
    n.duration = TickTime::fromBeats(durBeats);
    n.pitch    = pitch;
    n.velocity = 1.0f;
    n.isSlide  = slide;
    return n;
}

static int addPattern(Timeline& tl, int regionId, double lengthBeats,
                      const std::vector<PatternNote>& notes)
{
    Pattern p{};
    p.name     = "P";
    p.regionId = regionId;
    p.length   = TickTime::fromBeats(lengthBeats);
    p.notes    = notes;
    return tl.addPattern(p);
}

static void addBlock(Timeline& tl, int trackId, int patternId, double posBeats,
                     double durBeats, double offsetBeats, bool loop)
{
    PatternBlock b{};
    b.trackId     = trackId;
    b.patternId   = patternId;
    b.position    = TickTime::fromBeats(posBeats);
    b.duration    = TickTime::fromBeats(durBeats);
    b.offset      = TickTime::fromBeats(offsetBeats);
    b.loopEnabled = loop;
    tl.addPatternBlock(b);
}

// ── [1] ──────────────────────────────────────────────────────────────────────
static void noteIsCutAtBlockEnd()
{
    std::cout << "[1] a note that overruns its block is cut at the block end\n";
    Timeline tl(kBpm, kSampleRate);
    const int regionId = addVideoRegion(tl);
    const int trackId  = addTrack(tl, TrackInfo::Type::Pattern);
    // A 4-beat note starting on beat 3 of a 4-beat block: 3 beats hang over.
    const int patId = addPattern(tl, regionId, 4.0, { note(0.0, 1.0), note(3.0, 4.0) });
    addBlock(tl, trackId, patId, /*pos*/ 8.0, /*dur*/ 4.0, /*offset*/ 0.0, /*loop*/ false);

    const auto built = xleth::videoevents::build(tl, kBpm, kSampleRate);
    CHECK(built.events.size() == 2, "two notes -> two events (got " << built.events.size() << ")");
    if (built.events.size() == 2) {
        const VideoEvent& a = built.events[0];
        const VideoEvent& b = built.events[1];
        CHECK(near(a.startBeat, 8.0) && near(a.durationBeats, 1.0), "first note untouched");
        CHECK(near(b.startBeat, 11.0), "second note starts on block beat 3 (timeline 11)");
        CHECK(near(b.durationBeats, 1.0),
              "second note is cut at the block end: 1 beat, not 4 (got " << b.durationBeats << ")");
        CHECK(near(b.startBeat + b.durationBeats, 12.0), "and ends exactly at the block end");
        CHECK(near(a.sourceStartTime, 3.0) && near(a.sourceEndTime, 5.0),
              "notes retrigger from the region start and clamp at its end");
        CHECK(a.globalNoteIndex == 0 && b.globalNoteIndex == 1, "running per-track index");
    }
}

// ── [2] ──────────────────────────────────────────────────────────────────────
static void loopOffNeverWraps()
{
    std::cout << "[2] looping off: only the first pass of the pattern exists\n";
    Timeline tl(kBpm, kSampleRate);
    const int regionId = addVideoRegion(tl);
    const int trackId  = addTrack(tl, TrackInfo::Type::Pattern);
    const int patId = addPattern(tl, regionId, 4.0, { note(0.0, 0.5), note(2.0, 0.5) });
    // Left-trimmed by 1 beat (the beat-0 note is trimmed away), then extended
    // to 6 beats — 3 beats past where the first pass ends. With looping off
    // that tail is empty space. The old export builder wrapped the beat-0 note
    // of the SECOND pass into it: picture with no sound.
    addBlock(tl, trackId, patId, /*pos*/ 0.0, /*dur*/ 6.0, /*offset*/ 1.0, /*loop*/ false);

    const auto built = xleth::videoevents::build(tl, kBpm, kSampleRate);
    CHECK(built.events.size() == 1,
          "exactly one note survives (got " << built.events.size() << ")");
    if (!built.events.empty()) {
        // Pattern beat 2 minus the 1-beat trim -> timeline beat 1.
        CHECK(near(built.events[0].startBeat, 1.0),
              "the beat-2 note lands on timeline beat 1 (got " << built.events[0].startBeat << ")");
    }

    // An offset at or past the pattern length leaves nothing at all.
    Timeline tl2(kBpm, kSampleRate);
    const int regionId2 = addVideoRegion(tl2);
    const int trackId2  = addTrack(tl2, TrackInfo::Type::Pattern);
    const int patId2 = addPattern(tl2, regionId2, 4.0, { note(0.0, 0.5) });
    addBlock(tl2, trackId2, patId2, 0.0, 8.0, /*offset*/ 4.0, /*loop*/ false);
    CHECK(xleth::videoevents::build(tl2, kBpm, kSampleRate).events.empty(),
          "offset past the pattern end, looping off -> no events");
}

// ── [3] ──────────────────────────────────────────────────────────────────────
static void loopOnRepeatsInTimelineOrder()
{
    std::cout << "[3] looping on: later passes appear, in timeline order\n";
    Timeline tl(kBpm, kSampleRate);
    const int regionId = addVideoRegion(tl);
    const int trackId  = addTrack(tl, TrackInfo::Type::Pattern);
    const int patId = addPattern(tl, regionId, 2.0, { note(0.0, 0.5, 60), note(1.0, 0.5, 62) });
    // 2-beat pattern in a 5-beat looping block: passes at 0-2, 2-4, and half
    // of a third (only its beat-0 note fits).
    addBlock(tl, trackId, patId, /*pos*/ 4.0, /*dur*/ 5.0, /*offset*/ 0.0, /*loop*/ true);

    const auto built = xleth::videoevents::build(tl, kBpm, kSampleRate);
    const double expectStart[] = { 4.0, 5.0, 6.0, 7.0, 8.0 };
    CHECK(built.events.size() == 5, "five note-ons (got " << built.events.size() << ")");
    bool ordered = built.events.size() == 5;
    for (std::size_t i = 0; ordered && i < 5; ++i) {
        ordered = near(built.events[i].startBeat, expectStart[i])
               && built.events[i].globalNoteIndex == static_cast<int>(i);
    }
    CHECK(ordered, "events are emitted pass by pass, index rising with time");
}

// ── [4] ──────────────────────────────────────────────────────────────────────
static void slideNotesBecomeSlideEvents()
{
    std::cout << "[4] slide notes emit a SlideAnimationEvent, not a VideoEvent\n";
    Timeline tl(kBpm, kSampleRate);
    const int regionId = addVideoRegion(tl);
    const int trackId  = addTrack(tl, TrackInfo::Type::Pattern);
    const int patId = addPattern(tl, regionId, 4.0,
        { note(0.0, 1.0), note(3.0, 2.0, 64, /*slide*/ true) });
    addBlock(tl, trackId, patId, 0.0, 4.0, 0.0, false);

    const auto built = xleth::videoevents::build(tl, kBpm, kSampleRate);
    CHECK(built.events.size() == 1, "the slide note spawns no video cell");
    CHECK(built.slideEvents.size() == 1, "it emits one slide event");
    if (built.slideEvents.size() == 1) {
        const auto& se = built.slideEvents[0];
        CHECK(near(se.startBeat, 3.0) && se.trackId == trackId, "at the note's position, on its track");
        // The audio glide runs its full length (MixEngine emits SlideStart with
        // the whole note duration), so the visual does too.
        CHECK(near(se.durationBeats, 2.0), "with its full duration, not clamped to the block");
    }
    CHECK(built.stats.slideEvents == 1 && built.stats.noteEvents == 1, "stats agree");
}

// ── [5] ──────────────────────────────────────────────────────────────────────
static void clipEvents()
{
    std::cout << "[5] clips: anchored, carrying stretch/reverse, deterministic order\n";
    Timeline tl(kBpm, kSampleRate);
    const int regionId = addVideoRegion(tl, 3.0, 5.0);
    const int trackId  = addTrack(tl, TrackInfo::Type::Clip);

    Clip a{};
    a.trackId = trackId; a.regionId = regionId;
    a.position = TickTime::fromBeats(4.0); a.duration = TickTime::fromBeats(2.0);
    a.velocity = 1.0f;
    a.stretchRatio = 2.0; a.reversed = true;
    a.regionOffset = TickTime::fromBeats(1.0);   // 0.5 s at 120 BPM
    const int idA = tl.addClip(a);

    // Two clips on the SAME tick: order must come from the id, every build.
    Clip b{}; b.trackId = trackId; b.regionId = regionId;
    b.position = TickTime::fromBeats(0.0); b.duration = TickTime::fromBeats(1.0); b.velocity = 1.0f;
    const int idB = tl.addClip(b);
    Clip c = b;
    const int idC = tl.addClip(c);

    const auto built = xleth::videoevents::build(tl, kBpm, kSampleRate);
    CHECK(built.events.size() == 3, "three clips -> three events");
    if (built.events.size() == 3) {
        CHECK(built.events[0].clipId == std::min(idB, idC)
              && built.events[1].clipId == std::max(idB, idC),
              "same-tick clips are ordered by id");
        const VideoEvent& ev = built.events[2];
        CHECK(ev.clipId == idA && near(ev.startBeat, 4.0) && near(ev.durationBeats, 2.0),
              "the later clip comes last");
        CHECK(near(ev.sourceStartTime,
                   xleth::anchoring::clipSourceAnchorSeconds(3.0, a.regionOffset.ticks, kBpm, 0.0)),
              "source anchor comes from the shared helper");
        CHECK(near(ev.sourceStartTime, 3.5), "region start 3.0 s + 1 beat trim at 120 BPM = 3.5 s");
        CHECK(ev.clipReversed && near(ev.clipStretchRatio, 2.0), "stretch and reverse are carried");
        CHECK(ev.clipStartTimelineSamples == 96000, "4 beats at 120 BPM / 48 kHz = 96000 samples");
        CHECK(ev.globalNoteIndex == 2, "running per-track index");
    }

    // A clip whose source has no video produces nothing.
    Timeline tl2(kBpm, kSampleRate);
    SourceMedia audioOnly{}; audioOnly.filePath = "/fake/a.wav"; audioOnly.hasVideo = false;
    SampleRegion r{}; r.sourceId = tl2.addSource(audioOnly); r.startTime = 0.0; r.endTime = 1.0;
    Clip d{}; d.trackId = addTrack(tl2, TrackInfo::Type::Clip); d.regionId = tl2.addRegion(r);
    d.position = TickTime{0}; d.duration = TickTime::fromBeats(1.0);
    tl2.addClip(d);
    const auto built2 = xleth::videoevents::build(tl2, kBpm, kSampleRate);
    CHECK(built2.events.empty() && built2.stats.clipsSkipped == 1, "audio-only source is skipped");
}

// ── [6] ──────────────────────────────────────────────────────────────────────
static void exportUsesTheSameList()
{
    std::cout << "[6] OfflineRenderer::buildVideoEvents is the same list\n";
    Timeline tl(kBpm, kSampleRate);
    const int regionId = addVideoRegion(tl);
    const int patTrack = addTrack(tl, TrackInfo::Type::Pattern);
    const int clipTrack = addTrack(tl, TrackInfo::Type::Clip);
    const int patId = addPattern(tl, regionId, 4.0,
        { note(0.0, 0.5), note(1.0, 6.0), note(2.0, 1.0, 62, true) });
    addBlock(tl, patTrack, patId, 0.0, 6.0, 1.0, false);
    addBlock(tl, patTrack, patId, 8.0, 10.0, 0.0, true);
    Clip c{}; c.trackId = clipTrack; c.regionId = regionId;
    c.position = TickTime::fromBeats(2.0); c.duration = TickTime::fromBeats(3.0); c.velocity = 0.5f;
    tl.addClip(c);

    const auto built = xleth::videoevents::build(tl, tl.getBPM(), kSampleRate);
    std::vector<SlideAnimationEvent> slides;
    const auto exported = OfflineRenderer::buildVideoEvents(tl, &slides, kSampleRate);

    bool same = built.events.size() == exported.size();
    for (std::size_t i = 0; same && i < exported.size(); ++i) {
        const VideoEvent& x = built.events[i];
        const VideoEvent& y = exported[i];
        same = x.startBeat == y.startBeat && x.durationBeats == y.durationBeats
            && x.trackId == y.trackId && x.regionId == y.regionId
            && x.sourceStartTime == y.sourceStartTime && x.opacity == y.opacity
            && x.globalNoteIndex == y.globalNoteIndex && x.clipId == y.clipId
            && x.orientation == y.orientation && x.stateIndex == y.stateIndex;
    }
    CHECK(!exported.empty(), "the fixture produces events");
    CHECK(same, "export and preview build identical event lists");
    CHECK(slides.size() == built.slideEvents.size() && !slides.empty(),
          "and identical slide lists");
}

int main()
{
    std::cout << "=== test_video_event_builder ===\n";
    noteIsCutAtBlockEnd();
    loopOffNeverWraps();
    loopOnRepeatsInTimelineOrder();
    slideNotesBecomeSlideEvents();
    clipEvents();
    exportUsesTheSameList();
    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    return g_failed == 0 ? 0 : 1;
}
