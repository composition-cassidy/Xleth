// test_envelope_modulation_engine.cpp
// MixEngine-level tests for the FX Graph Envelope Controller → parameter
// modulation path.
//
// The pure evaluator is covered by test_envelope_parameter_modulation. THIS file
// covers the parts that only exist once a real Timeline and a real MixEngine are
// involved, i.e. everything the retired renderer drive got wrong:
//
//   §1  authoritative gate derivation from the Timeline (the engine's own note
//       math, including the block-end note-off clamp the renderer lacked)
//   §2  loopEnabled / block offset / looped blocks
//   §3  slide notes (ignored by default, gated only on the schema's opt-in)
//   §4  clip gates + notes-vs-clips inference
//   §5  snapshot construction: graph mode only, master untouched, mute/solo
//   §6  PLAY-START — modulation is correct on the FIRST rendered sample
//   §7  LOOP WRAP — no over-run, phase continuity across the wrap
//   §8  SEEK into a held note — gate phase matches where the engine is playing
//   §9  STOP — every modulated parameter comes to rest at its authored base
//   §10 base + signed depth end-to-end through processBlock, incl. negative
//       depth and clamping
//   §11 definition refresh is picked up live, and the published snapshot swap is
//       safe while the audio thread is running
//
// Values are read from the snapshot's mailboxes, which is exactly what the audio
// thread publishes — so these assertions are on the real audio-path output, not
// on a re-implementation of it.
//
// Build target: test_envelope_modulation_engine  (engine/CMakeLists.txt)
// Pass: prints "ALL TESTS PASSED" and exits 0.

#include "audio/MixEngine.h"
#include "model/Timeline.h"
#include "model/EnvelopeParameterModulation.h"
#include "Transport.h"

#include <cmath>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

using namespace xleth::envmod;

// ─── Minimal harness ──────────────────────────────────────────────────────────

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

static bool nearly(double a, double b, double eps = 1e-6)
{
    return std::fabs(a - b) <= eps;
}

// Guarded size check: use before any CHECK that indexes a container, so a
// failure reports instead of reading out of bounds and killing the run.
#define CHECK_SIZE(container, expected, msg)                                    \
    do {                                                                       \
        const std::size_t got_ = (container).size();                           \
        const std::size_t exp_ = static_cast<std::size_t>(expected);           \
        if (got_ == exp_) {                                                    \
            ++g_passed;                                                        \
        } else {                                                               \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg                 \
                      << " (size " << got_ << ", want " << exp_ << ")\n";      \
            ++g_failed;                                                        \
            return;                                                            \
        }                                                                      \
    } while (0)

#define CHECK_NEAR(actual, expected, msg)                                      \
    do {                                                                       \
        const double a_ = (actual);                                            \
        const double e_ = (expected);                                          \
        if (nearly(a_, e_, 1e-5)) {                                            \
            ++g_passed;                                                        \
        } else {                                                               \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg                 \
                      << " (got " << a_ << ", want " << e_ << ")\n";           \
            ++g_failed;                                                        \
        }                                                                      \
    } while (0)

// 120 bpm / 48 kHz: one 960-PPQ tick is exactly 25 samples, one beat 24000.
static constexpr double  kSR             = 48000.0;
static constexpr double  kBPM            = 120.0;
static constexpr int64_t kSamplesPerTick = 25;
static constexpr int64_t kTicksPerBeat   = 960;

// ─── Timeline builders ────────────────────────────────────────────────────────

// A graph-mode pattern track carrying one envelope node wired to one exposed
// parameter of one graph-owned effect.
static nlohmann::json makeEnvelopeGraphState(int trackId,
                                             const nlohmann::json& envelopeData,
                                             double base,
                                             double depth)
{
    return nlohmann::json{
        {"version", 1},
        {"trackId", trackId},
        {"nodes", nlohmann::json::array({
            nlohmann::json{{"id", "env-1"}, {"type", "envelope"}, {"data", envelopeData}},
            nlohmann::json{{"id", "node-fx"}, {"type", "effect"}, {"data", {
                {"effectInstanceId", "fx-1"},
                {"exposedParameterPorts", nlohmann::json::array({
                    nlohmann::json{{"parameterId", "gain"}, {"automatable", true}},
                })},
            }}},
        })},
        {"edges", nlohmann::json::array({
            nlohmann::json{
                {"id", "edge-1"},
                {"type", "parameter"},
                {"sourceNodeId", "env-1"},
                {"sourcePort", "controlOut"},
                {"targetNodeId", "node-fx"},
                {"targetParameter", {
                    {"kind", "graph-parameter"},
                    {"graphNodeId", "node-fx"},
                    {"effectInstanceId", "fx-1"},
                    {"parameterId", "gain"},
                }},
                {"mapping", {
                    {"kind", "modulation"},
                    {"enabled", true},
                    {"base", base},
                    {"depth", depth},
                    {"sourceMin", 0.0},
                    {"sourceMax", 1.0},
                    {"curve", {{"type", "linear"}}},
                }},
            },
        })},
    };
}

// An envelope with an instant attack and a flat sustain, so the expected value at
// any in-gate position is simply the sustain level — which keeps the timing
// assertions below about GATES rather than about curve shape.
static nlohmann::json flatEnvelopeData(double sustain = 1.0, double releaseMs = 0.0)
{
    return nlohmann::json{
        {"attackMs", 0.0},
        {"holdMs", 0.0},
        {"decayMs", 0.0},
        {"sustain", sustain},
        {"releaseMs", releaseMs},
    };
}

struct PatternTrackSetup {
    int trackId   = 0;
    int patternId = 0;
    int blockId   = 0;
    int regionId  = -1;
};

// Timeline::addPattern validates that the pattern's regionId resolves, so every
// pattern in these tests needs a real region to bind to.
static int addDummyRegion(Timeline& timeline)
{
    SampleRegion region;
    region.name      = "env region";
    region.sourceId  = 0;
    region.startTime = 0.0;
    region.endTime   = 1.0;
    return timeline.addRegion(region);
}

// One musical bar in ticks. Timeline snaps a pattern's length UP to whole bars
// every time a note is added (recalcPatternLength), so a sub-bar pattern length
// is not reachable through the public API and every length below is a bar multiple.
static constexpr int64_t kBarTicks = 4 * kTicksPerBeat;   // 3840

// Creates the track + region + pattern. Deliberately does NOT create the block:
// recalcPatternLength cascades to every block whose duration EQUALS the old
// pattern length, so a block created before the notes can be silently resized
// out from under the test. Blocks are added by addBlock() after the notes exist.
static PatternTrackSetup addPatternTrack(Timeline& timeline, int64_t patternLenTicks)
{
    PatternTrackSetup setup;

    TrackInfo track;
    track.name = "env track";
    track.type = TrackInfo::Type::Pattern;
    setup.trackId = timeline.addTrack(track);

    setup.regionId = addDummyRegion(timeline);

    Pattern pattern;
    pattern.name     = "pat";
    pattern.regionId = setup.regionId;   // a bound region: the engine would play it
    pattern.length   = TickTime{patternLenTicks};
    setup.patternId  = timeline.addPattern(pattern);

    return setup;
}

static void addNote(Timeline& timeline, int patternId,
                   int64_t positionTicks, int64_t durationTicks,
                   bool isSlide = false, int pitch = 60)
{
    PatternNote note;
    note.position = TickTime{positionTicks};
    note.duration = TickTime{durationTicks};
    note.pitch    = pitch;
    note.isSlide  = isSlide;
    timeline.addNoteToPattern(patternId, note);
}

// Places the pattern on the timeline. Call AFTER the notes are in place.
static void addBlock(Timeline& timeline, PatternTrackSetup& setup,
                    int64_t blockPosTicks, int64_t blockDurTicks,
                    int64_t blockOffsetTicks, bool loopEnabled)
{
    PatternBlock block;
    block.trackId     = setup.trackId;
    block.patternId   = setup.patternId;
    block.position    = TickTime{blockPosTicks};
    block.duration    = TickTime{blockDurTicks};
    block.offset      = TickTime{blockOffsetTicks};
    block.loopEnabled = loopEnabled;
    setup.blockId     = timeline.addPatternBlock(block);
}

// The length recalcPatternLength will settle on for a pattern whose rightmost
// note edge is `rightmostTicks`. Lets a test assert against the real model
// instead of the length it happened to ask for.
static int64_t barSnapped(int64_t rightmostTicks)
{
    int64_t bars = (rightmostTicks + kBarTicks - 1) / kBarTicks;
    if (bars < 1) bars = 1;
    return bars * kBarTicks;
}

// ─── Snapshot / mailbox readers ───────────────────────────────────────────────

// The value the audio thread published for the first (and, in these tests, only)
// modulated parameter.
static double publishedValue(const MixEngine& engine)
{
    auto snapshot = engine.getEnvelopeModulationSnapshotForTesting();
    if (!snapshot || snapshot->mailboxCount <= 0 || snapshot->mailboxes == nullptr)
        return -1.0;
    return static_cast<double>(snapshot->mailboxes[0].value.load(std::memory_order_relaxed));
}

static std::uint32_t publishedSeq(const MixEngine& engine)
{
    auto snapshot = engine.getEnvelopeModulationSnapshotForTesting();
    if (!snapshot || snapshot->mailboxCount <= 0 || snapshot->mailboxes == nullptr)
        return 0;
    return snapshot->mailboxes[0].seq.load(std::memory_order_acquire);
}

// Renders one block at an explicit transport position and returns the value the
// audio thread published for it.
static double renderAt(MixEngine& engine, Transport& transport,
                      int64_t positionSamples, int blockSize = 512)
{
    transport.seekToSample(positionSamples);
    juce::AudioBuffer<float> buffer(2, blockSize);
    buffer.clear();
    engine.processBlock(buffer, blockSize, transport);
    return publishedValue(engine);
}

// ─── §1 authoritative gate derivation ─────────────────────────────────────────

static void testNoteGateDerivation()
{
    std::cout << "§1 note gate derivation (engine note math)\n";

    // One 1-beat note at the top of a 1-bar pattern in a 1-bar block.
    Timeline timeline(kBPM, kSR);
    auto setup = addPatternTrack(timeline, kBarTicks);
    addNote(timeline, setup.patternId, 0, kTicksPerBeat);
    addBlock(timeline, setup, 0, kBarTicks, 0, /*loopEnabled=*/false);

    const auto build = buildTrackGateIntervals(timeline, setup.trackId, false);
    CHECK(build.source == GateSourceKind::Notes, "a pattern track infers note triggers");
    CHECK_SIZE(build.intervals, 1, "one note yields one gate");
    CHECK(build.intervals[0].startTick == 0, "gate starts at the note onset");
    CHECK(build.intervals[0].endTick == kTicksPerBeat, "gate ends at the note end");

    // THE BLOCK-END CLAMP. A note whose duration overruns its block must release
    // at the block boundary, because that is where the engine's note-off fires
    // (absNoteOff = min(onset + duration, blockEnd)). The retired renderer
    // evaluator let this gate ring on past the block, releasing late.
    {
        Timeline t2(kBPM, kSR);
        auto s2 = addPatternTrack(t2, kBarTicks);
        addNote(t2, s2.patternId, 0, 8 * kTicksPerBeat);   // way past the block end
        addBlock(t2, s2, 0, 2 * kTicksPerBeat, 0, false);

        const auto b2 = buildTrackGateIntervals(t2, s2.trackId, false);
        CHECK_SIZE(b2.intervals, 1, "overrunning note yields one gate");
        CHECK(b2.intervals[0].endTick == 2 * kTicksPerBeat,
              "note gate is clamped to the block end, matching the engine note-off");
    }

    // A block offset shifts the pattern window: with offset = 1 beat, the note at
    // pattern tick 960 lands at timeline tick 0.
    {
        Timeline t3(kBPM, kSR);
        auto s3 = addPatternTrack(t3, kBarTicks);
        addNote(t3, s3.patternId, kTicksPerBeat, 240);
        addBlock(t3, s3, 0, 2 * kTicksPerBeat, kTicksPerBeat, false);

        const auto b3 = buildTrackGateIntervals(t3, s3.trackId, false);
        CHECK_SIZE(b3.intervals, 1, "offset block still emits its note");
        CHECK(b3.intervals[0].startTick == 0,
              "blockPos - blockOffset + notePos places the note at tick 0");
    }

    // A pattern with no bound region produces no audio in the engine, so no gates.
    {
        Timeline t4(kBPM, kSR);
        Pattern regionless;
        regionless.name     = "no region";
        regionless.regionId = -1;                 // never bound to a sample
        regionless.length   = TickTime{kBarTicks};
        const int regionlessId = t4.addPattern(regionless);
        addNote(t4, regionlessId, 0, 240);

        TrackInfo track2;
        track2.type = TrackInfo::Type::Pattern;
        const int trackId2 = t4.addTrack(track2);

        PatternBlock block;
        block.trackId   = trackId2;
        block.patternId = regionlessId;
        block.position  = TickTime{0};
        block.duration  = TickTime{kBarTicks};
        t4.addPatternBlock(block);

        const auto b4 = buildTrackGateIntervals(t4, trackId2, false);
        CHECK(b4.intervals.empty(), "a region-less pattern produces no gates");
        CHECK(b4.source == GateSourceKind::None, "and no inferred source");
    }

    // A chord (three notes on the same tick) collapses into ONE trigger, and is
    // never summed or averaged.
    {
        Timeline t5(kBPM, kSR);
        auto s5 = addPatternTrack(t5, kBarTicks);
        addNote(t5, s5.patternId, 0, kTicksPerBeat, false, 60);
        addNote(t5, s5.patternId, 0, kTicksPerBeat, false, 64);
        addNote(t5, s5.patternId, 0, kTicksPerBeat, false, 67);
        addBlock(t5, s5, 0, kBarTicks, 0, false);

        const auto b5 = buildTrackGateIntervals(t5, s5.trackId, false);
        CHECK_SIZE(b5.intervals, 3, "three chord notes yield three raw intervals");
        const auto merged = buildGateTimeline(b5.intervals);
        CHECK_SIZE(merged.regions, 1, "a chord is a single gate region");
        CHECK(merged.regions[0].startCount == 1, "a chord is a single trigger");
    }
}

// ─── §2 loop / block iteration ────────────────────────────────────────────────

static void testLoopedBlockGates()
{
    std::cout << "§2 looped blocks / loopEnabled\n";

    // A 1-BAR pattern in a 4-bar block with loop ENABLED: four note onsets, one per
    // iteration. Bar scale is not cosmetic — Timeline bar-snaps pattern length, so a
    // sub-bar pattern cannot exist.
    {
        Timeline timeline(kBPM, kSR);
        auto setup = addPatternTrack(timeline, kBarTicks);
        addNote(timeline, setup.patternId, 0, 240);
        CHECK(barSnapped(240) == kBarTicks, "a short note still gives a 1-bar pattern");
        addBlock(timeline, setup, 0, 4 * kBarTicks, 0, /*loopEnabled=*/true);

        const auto build = buildTrackGateIntervals(timeline, setup.trackId, false);
        CHECK_SIZE(build.intervals, 4, "a looped block repeats its notes per iteration");
        CHECK(build.intervals[0].startTick == 0, "iteration 0");
        CHECK(build.intervals[1].startTick == kBarTicks, "iteration 1");
        CHECK(build.intervals[3].startTick == 3 * kBarTicks, "iteration 3");
    }

    // The same block with loop DISABLED plays iteration 0 only; the rest of the
    // block is silence, so it must produce no further gates.
    {
        Timeline timeline(kBPM, kSR);
        auto setup = addPatternTrack(timeline, kBarTicks);
        addNote(timeline, setup.patternId, 0, 240);
        addBlock(timeline, setup, 0, 4 * kBarTicks, 0, /*loopEnabled=*/false);

        const auto build = buildTrackGateIntervals(timeline, setup.trackId, false);
        CHECK_SIZE(build.intervals, 1, "loop disabled plays iteration 0 only");
        CHECK(build.intervals[0].startTick == 0, "and it is iteration 0");
    }
}

// ─── §3 slide notes ───────────────────────────────────────────────────────────

static void testSlideNotes()
{
    std::cout << "§3 slide notes (opt-in only)\n";

    Timeline timeline(kBPM, kSR);
    auto setup = addPatternTrack(timeline, kBarTicks);
    addNote(timeline, setup.patternId, 0, kTicksPerBeat, /*isSlide=*/false);
    addNote(timeline, setup.patternId, 2 * kTicksPerBeat, kTicksPerBeat, /*isSlide=*/true);
    addBlock(timeline, setup, 0, kBarTicks, 0, false);

    // Default: slide notes are ignored. The engine's audio path emits only a
    // SlideStart for them (no note-on / note-off), so no gate is the faithful
    // behavior as well as the schema default.
    {
        const auto build = buildTrackGateIntervals(timeline, setup.trackId, false);
        CHECK_SIZE(build.intervals, 1, "slide note is ignored by default");
        CHECK(build.intervals[0].startTick == 0, "only the normal note gates");
    }

    // Opt-in: the slide note's span becomes a modulation gate too.
    {
        const auto build = buildTrackGateIntervals(timeline, setup.trackId, true);
        CHECK_SIZE(build.intervals, 2, "includeSlideNotes adds the slide gate");
        CHECK(build.intervals[1].startTick == 2 * kTicksPerBeat, "slide gate onset");
        CHECK(build.intervals[1].endTick == 3 * kTicksPerBeat, "slide gate end");
    }

    // A track holding ONLY slide notes is still a NOTE track: with the opt-in off
    // it yields no gates, and must NOT fall through to clip gates.
    {
        Timeline slideOnly(kBPM, kSR);
        auto s = addPatternTrack(slideOnly, kBarTicks);
        addNote(slideOnly, s.patternId, 0, kTicksPerBeat, /*isSlide=*/true);
        addBlock(slideOnly, s, 0, kBarTicks, 0, false);

        Clip clip;
        clip.trackId  = s.trackId;
        clip.regionId = s.regionId;
        clip.position = TickTime{0};
        clip.duration = TickTime{4 * kTicksPerBeat};
        slideOnly.addClip(clip);

        const auto build = buildTrackGateIntervals(slideOnly, s.trackId, false);
        CHECK(build.source == GateSourceKind::Notes,
              "a slide-only track is still inferred as a note track");
        CHECK(build.intervals.empty(),
              "slide-only track with the opt-in off yields no gates (not clip gates)");
    }
}

// ─── §4 clip gates ────────────────────────────────────────────────────────────

static void testClipGates()
{
    std::cout << "§4 clip gates / source inference\n";

    Timeline timeline(kBPM, kSR);
    TrackInfo track;
    track.type = TrackInfo::Type::Clip;
    const int trackId = timeline.addTrack(track);
    const int regionId = addDummyRegion(timeline);

    Clip a;
    a.trackId  = trackId;
    a.regionId = regionId;
    a.position = TickTime{0};
    a.duration = TickTime{2 * kTicksPerBeat};
    timeline.addClip(a);

    Clip b;
    b.trackId  = trackId;
    b.regionId = regionId;
    b.position = TickTime{4 * kTicksPerBeat};
    b.duration = TickTime{kTicksPerBeat};
    timeline.addClip(b);

    const auto build = buildTrackGateIntervals(timeline, trackId, false);
    CHECK(build.source == GateSourceKind::Clips, "a clip track infers clip triggers");
    CHECK_SIZE(build.intervals, 2, "two clips yield two gates");
    CHECK(build.intervals[0].startTick == 0 && build.intervals[0].endTick == 2 * kTicksPerBeat,
          "clip gate spans the clip");

    // Overlapping clips keep the gate open until the LAST one ends.
    {
        Timeline overlap(kBPM, kSR);
        TrackInfo t;
        t.type = TrackInfo::Type::Clip;
        const int id = overlap.addTrack(t);
        const int rid = addDummyRegion(overlap);

        Clip first;
        first.trackId = id; first.regionId = rid;
        first.position = TickTime{0}; first.duration = TickTime{2 * kTicksPerBeat};
        overlap.addClip(first);

        Clip second;
        second.trackId = id; second.regionId = rid;
        second.position = TickTime{kTicksPerBeat}; second.duration = TickTime{4 * kTicksPerBeat};
        overlap.addClip(second);

        const auto merged = buildGateTimeline(
            buildTrackGateIntervals(overlap, id, false).intervals);
        CHECK_SIZE(merged.regions, 1, "overlapping clips merge into one region");
        CHECK(merged.regions[0].end == 5 * kTicksPerBeat,
              "the region stays open until the last clip ends");
    }

    // A track with neither notes nor clips yields nothing.
    {
        Timeline empty(kBPM, kSR);
        TrackInfo t;
        const int id = empty.addTrack(t);
        const auto build2 = buildTrackGateIntervals(empty, id, false);
        CHECK(build2.source == GateSourceKind::None, "an empty track has no trigger source");
        CHECK(build2.intervals.empty(), "and no gates");
    }
}

// ─── §5 snapshot construction ─────────────────────────────────────────────────

static void testSnapshotConstruction()
{
    std::cout << "§5 snapshot construction (graph mode, mute/solo)\n";

    // Chain mode: the envelope must be completely inert.
    {
        Timeline timeline(kBPM, kSR);
        auto setup = addPatternTrack(timeline, kBarTicks);
        addNote(timeline, setup.patternId, 0, kTicksPerBeat);
        addBlock(timeline, setup, 0, kBarTicks, 0, false);
        timeline.setTrackGraphState(setup.trackId,
            makeEnvelopeGraphState(setup.trackId, flatEnvelopeData(), 0.0, 1.0));
        // fxMode left at the default (Chain).

        const auto snapshot = buildEnvelopeModulationSnapshot(timeline);
        CHECK(snapshot->envelopes.empty(), "a chain-mode track contributes no envelopes");
        CHECK(snapshot->empty(), "and the snapshot is empty");
    }

    // Graph mode: the envelope is picked up, with one mailbox per resolved edge.
    {
        Timeline timeline(kBPM, kSR);
        auto setup = addPatternTrack(timeline, kBarTicks);
        addNote(timeline, setup.patternId, 0, kTicksPerBeat);
        addBlock(timeline, setup, 0, kBarTicks, 0, false);
        timeline.setTrackFxMode(setup.trackId, TrackFxMode::Graph);
        timeline.setTrackGraphState(setup.trackId,
            makeEnvelopeGraphState(setup.trackId, flatEnvelopeData(), 0.25, 0.5));

        const auto snapshot = buildEnvelopeModulationSnapshot(timeline);
        CHECK_SIZE(snapshot->envelopes, 1, "graph mode contributes one envelope");
        CHECK_SIZE(snapshot->edges, 1, "with one resolved edge");
        CHECK(snapshot->mailboxCount == 1, "and one mailbox");
        CHECK(snapshot->mailboxes != nullptr, "mailboxes are allocated with the snapshot");
        CHECK_SIZE(snapshot->mailboxTargets, 1, "one applier target");
        CHECK(snapshot->mailboxTargets[0].trackId == setup.trackId, "target carries the trackId");
        CHECK(snapshot->mailboxTargets[0].effectInstanceId == "fx-1",
              "target is addressed by the stable effectInstanceId");
        CHECK(snapshot->mailboxTargets[0].parameterId == "gain", "target carries the parameterId");
        CHECK(snapshot->envelopes[0].gates.regions.size() == 1, "gates were derived");

        // MUTE: an inaudible track gets NO gates, so the envelope reads 0 and each
        // edge maps that to exactly its authored base — muting RELEASES the
        // modulation rather than freezing it at whatever it last was.
        auto muted = timeline;
        {
            TrackInfo* t = const_cast<TrackInfo*>(muted.getTrack(setup.trackId));
            CHECK(t != nullptr, "track is reachable for the mute test");
            if (t) t->muted = true;
        }
        const auto mutedSnapshot = buildEnvelopeModulationSnapshot(muted);
        CHECK_SIZE(mutedSnapshot->envelopes, 1, "a muted track still has its envelope");
        CHECK(mutedSnapshot->envelopes[0].gates.regions.empty(),
              "but a muted track has no gates");
        {
            const auto shape = envelopeShapeToSamples(mutedSnapshot->envelopes[0].shape, kSR);
            const auto gates = makeGateView(mutedSnapshot->envelopes[0].gates);
            const double env = evaluateEnvelopeAtSample(shape, gates, 0, kBPM, kSR);
            CHECK_NEAR(env, 0.0, "a muted track's envelope reads 0");
            CHECK_NEAR(evaluateModulationMapping(mutedSnapshot->edges[0].mapping, env), 0.25,
                       "a muted track's parameter rests at its authored base");
        }

        // SOLO elsewhere silences this track by the same closure.
        auto soloed = timeline;
        {
            TrackInfo other;
            other.name = "soloed other";
            const int otherId = soloed.addTrack(other);
            TrackInfo* t = const_cast<TrackInfo*>(soloed.getTrack(otherId));
            if (t) t->solo = true;
        }
        const auto soloSnapshot = buildEnvelopeModulationSnapshot(soloed);
        CHECK_SIZE(soloSnapshot->envelopes, 1, "solo elsewhere keeps the envelope entry");
        CHECK(soloSnapshot->envelopes[0].gates.regions.empty(),
              "a track silenced by another track's solo has no gates");

        // The soloed track itself keeps its gates.
        auto selfSolo = timeline;
        {
            TrackInfo* t = const_cast<TrackInfo*>(selfSolo.getTrack(setup.trackId));
            if (t) t->solo = true;
        }
        const auto selfSoloSnapshot = buildEnvelopeModulationSnapshot(selfSolo);
        CHECK(!selfSoloSnapshot->envelopes.empty()
              && !selfSoloSnapshot->envelopes[0].gates.regions.empty(),
              "the soloed track keeps its gates");
    }

    // A graph-mode track whose envelope has no resolvable edge contributes nothing
    // (no mailbox is wasted on an inert envelope).
    {
        Timeline timeline(kBPM, kSR);
        auto setup = addPatternTrack(timeline, kBarTicks);
        addNote(timeline, setup.patternId, 0, kTicksPerBeat);
        addBlock(timeline, setup, 0, kBarTicks, 0, false);
        timeline.setTrackFxMode(setup.trackId, TrackFxMode::Graph);
        auto graphState = makeEnvelopeGraphState(setup.trackId, flatEnvelopeData(), 0.0, 1.0);
        graphState["edges"][0]["mapping"]["enabled"] = false;
        timeline.setTrackGraphState(setup.trackId, graphState);

        const auto snapshot = buildEnvelopeModulationSnapshot(timeline);
        CHECK(snapshot->envelopes.empty(), "an envelope with only disabled edges is dropped");
        CHECK(snapshot->mailboxCount == 0, "and claims no mailbox");
    }
}

// ─── MixEngine fixture ────────────────────────────────────────────────────────

// A prepared-but-deviceless MixEngine over a graph-mode pattern track carrying a
// single note gate, ready for processBlock.
struct EngineFixture {
    Timeline  timeline{kBPM, kSR};
    MixEngine engine;
    Transport transport;
    PatternTrackSetup setup;

    // Always construct through makeFixture(): see the note there.
    EngineFixture(const nlohmann::json& envelopeData,
                  double base, double depth,
                  int64_t noteStartTicks, int64_t noteDurTicks,
                  int64_t blockDurTicks = 8 * kTicksPerBeat)
    {
        setup = addPatternTrack(timeline, kBarTicks);
        addNote(timeline, setup.patternId, noteStartTicks, noteDurTicks);
        addBlock(timeline, setup, 0, blockDurTicks, 0, false);
        timeline.setTrackFxMode(setup.trackId, TrackFxMode::Graph);
        timeline.setTrackGraphState(setup.trackId,
            makeEnvelopeGraphState(setup.trackId, envelopeData, base, depth));

        transport.setSampleRate(kSR);
        transport.setBPM(kBPM);
        // setTimeline resyncs slots, which is where the envelope snapshot is built.
        engine.setTimeline(&timeline);
        engine.refreshEnvelopeDefinitions();
    }
};

// MixEngine is a very large object (per-track compensation delays, track buffers,
// diagnostics state). MSVC reserves a function's whole frame on entry, so two
// stack-allocated fixtures in one test function overflow even an 8 MB stack
// before the body runs. Fixtures therefore always live on the heap.
using FixturePtr = std::unique_ptr<EngineFixture>;

static FixturePtr makeFixture(const nlohmann::json& envelopeData,
                             double base, double depth,
                             int64_t noteStartTicks, int64_t noteDurTicks,
                             int64_t blockDurTicks = 8 * kTicksPerBeat)
{
    return std::make_unique<EngineFixture>(envelopeData, base, depth,
                                           noteStartTicks, noteDurTicks, blockDurTicks);
}

// ─── §6 play-start ────────────────────────────────────────────────────────────

static void testPlayStart()
{
    std::cout << "§6 play-start (correct on the first rendered sample)\n";

    // Note gate [0, 1 beat). Instant attack, full sustain, no release, base 0,
    // depth 1 -> the expected published value inside the gate is exactly 1.
    auto fx_ = makeFixture(flatEnvelopeData(1.0, 0.0), 0.0, 1.0, 0, kTicksPerBeat);
auto& fx = *fx_;

    CHECK(publishedSeq(fx.engine) == 0, "nothing is published before the transport runs");

    fx.transport.play();
    const double first = renderAt(fx.engine, fx.transport, 0);

    // THE HEADLINE. The very first rendered block already carries the correct
    // modulation value. The retired renderer path could not do this: its position
    // came from a wall-clock estimate that a 250 ms transport poll had to anchor
    // first, so the envelope sat at 0 for up to a quarter second after every Play.
    CHECK_NEAR(first, 1.0, "the FIRST rendered sample already has the gate's value");
    CHECK(publishedSeq(fx.engine) > 0, "the audio thread published a value");

    // Still inside the gate.
    CHECK_NEAR(renderAt(fx.engine, fx.transport, 12000), 1.0, "mid-gate stays at the gate value");

    // Past the gate with zero release: back to base.
    CHECK_NEAR(renderAt(fx.engine, fx.transport, kTicksPerBeat * kSamplesPerTick + 1000), 0.0,
               "after the gate with no release the parameter is back at base");
}

// ─── §7 loop wrap ─────────────────────────────────────────────────────────────

static void testLoopWrap()
{
    std::cout << "§7 loop wrap (no over-run, phase continuity)\n";

    // Gate [0, 1 beat) inside a 4-beat loop. A long release would let a sloppy
    // evaluator ring past the wrap; here the release is short and the assertion is
    // that position purity makes the wrap exact.
    auto fx_ = makeFixture(flatEnvelopeData(1.0, 100.0), 0.0, 1.0, 0, kTicksPerBeat);
auto& fx = *fx_;
    fx.transport.play();

    const int64_t loopStart = 0;
    const int64_t loopEnd   = 4 * kTicksPerBeat * kSamplesPerTick;   // 96000
    fx.transport.setLoopBounds(loopStart, loopEnd, true);

    // First pass through the gate.
    const double pass1Start = renderAt(fx.engine, fx.transport, 0);
    const double pass1Mid   = renderAt(fx.engine, fx.transport, 6000);
    CHECK_NEAR(pass1Start, 1.0, "pass 1 gate start");
    CHECK_NEAR(pass1Mid, 1.0, "pass 1 mid-gate");

    // Just before the wrap the gate is long over and the release has finished, so
    // the parameter is back at base.
    CHECK_NEAR(renderAt(fx.engine, fx.transport, loopEnd - 512), 0.0,
               "at the end of the loop the envelope has released to base");

    // After the wrap the transport is back at loopStart. NO OVER-RUN: the envelope
    // does not carry the previous iteration's phase across the boundary, because it
    // has no phase to carry — it is a function of position.
    const double pass2Start = renderAt(fx.engine, fx.transport, loopStart);
    const double pass2Mid   = renderAt(fx.engine, fx.transport, 6000);
    CHECK_NEAR(pass2Start, pass1Start, "pass 2 gate start matches pass 1 exactly");
    CHECK_NEAR(pass2Mid, pass1Mid, "pass 2 mid-gate matches pass 1 exactly");

    // Phase continuity matches RETRIGGERED gates: every iteration reproduces the
    // same curve because each iteration re-enters the same gate.
    bool identical = true;
    for (int64_t offset = 0; offset < loopEnd; offset += 8192) {
        const double a = renderAt(fx.engine, fx.transport, offset);
        const double b = renderAt(fx.engine, fx.transport, offset);
        if (!nearly(a, b, 1e-5)) { identical = false; break; }
    }
    CHECK(identical, "every position reproduces its value on repeat passes");

    // And the release is genuinely shaped, not a step — mid-release is between the
    // rails, which is what proves the wrap test above is not passing trivially.
    const int64_t gateEnd = kTicksPerBeat * kSamplesPerTick;   // 24000
    const double midRelease = renderAt(fx.engine, fx.transport, gateEnd + 2400);
    CHECK(midRelease > 0.01 && midRelease < 0.99, "the release is a ramp, not a step");
}

// ─── §8 seek into a held note ─────────────────────────────────────────────────

static void testSeekIntoHeldNote()
{
    std::cout << "§8 seek into a held note\n";

    // A 4-beat note starting at beat 0: samples [0, 96000). Sustain 0.8.
    auto fx_ = makeFixture(flatEnvelopeData(0.8, 0.0), 0.0, 1.0, 0, 4 * kTicksPerBeat);
auto& fx = *fx_;
    fx.transport.play();

    // Land in the MIDDLE of the held note without having rendered the onset. The
    // gate is reconstructed from position, so the envelope is at the note's
    // sustain level — it does not read 0 and it does not restart the attack.
    const double mid = renderAt(fx.engine, fx.transport, 48000);
    CHECK_NEAR(mid, 0.8, "seeking into a held note lands on the held level");

    // Seeking backwards works the same way — there is no accumulated state to rewind.
    const double back = renderAt(fx.engine, fx.transport, 12000);
    CHECK_NEAR(back, 0.8, "seeking backwards into the same note is still held");

    // Seeking past the note (zero release) is base.
    CHECK_NEAR(renderAt(fx.engine, fx.transport, 4 * kTicksPerBeat * kSamplesPerTick + 4096), 0.0,
               "seeking past the note reads base");

    // Seeking before the note reads base too.
    // (Gate starts at 0, so use a later note to have a "before" region.)
    {
        auto later_ = makeFixture(flatEnvelopeData(0.8, 0.0), 0.0, 1.0,
                                 2 * kTicksPerBeat, 2 * kTicksPerBeat);
        auto& later = *later_;
        later.transport.play();
        CHECK_NEAR(renderAt(later.engine, later.transport, 0), 0.0,
                   "before the first gate the parameter is at base");
        CHECK_NEAR(renderAt(later.engine, later.transport, 2 * kTicksPerBeat * kSamplesPerTick),
                   0.8, "the gate engages exactly at its onset sample");
    }
}

// ─── §9 stop ──────────────────────────────────────────────────────────────────

static void testStopRestsAtBase()
{
    std::cout << "§9 stop (rests at base, nothing destroyed)\n";

    // base 0.42 is the user's AUTHORED parameter value. Whatever the envelope was
    // doing when the transport stopped, the parameter must come to rest here.
    const double authoredBase = 0.42;
    auto fx_ = makeFixture(flatEnvelopeData(1.0, 0.0), authoredBase, 0.5, 0, 4 * kTicksPerBeat);
auto& fx = *fx_;

    fx.transport.play();
    const double whilePlaying = renderAt(fx.engine, fx.transport, 12000);
    CHECK_NEAR(whilePlaying, authoredBase + 0.5, "mid-gate the parameter is base + depth");

    // Stop. The stop transition publishes the at-rest (env == 0) value, which the
    // modulation mapping turns into exactly `base`. The old renderer stop flush
    // wrote a literal 0 here, permanently destroying the user's setting with no
    // undo; that failure mode is structurally impossible now.
    fx.transport.stop();
    {
        juce::AudioBuffer<float> buffer(2, 512);
        buffer.clear();
        fx.engine.processBlock(buffer, 512, fx.transport);
    }
    CHECK_NEAR(publishedValue(fx.engine), authoredBase,
               "on stop the parameter rests at its AUTHORED base, not at 0");

    // Repeated stopped blocks do not drift it.
    for (int i = 0; i < 4; ++i) {
        juce::AudioBuffer<float> buffer(2, 512);
        buffer.clear();
        fx.engine.processBlock(buffer, 512, fx.transport);
    }
    CHECK_NEAR(publishedValue(fx.engine), authoredBase,
               "further stopped blocks leave it at base");

    // Sanity: base is not 0, so this test would fail if the release wrote 0.
    CHECK(!nearly(authoredBase, 0.0), "the authored base is deliberately non-zero");
}

// ─── §10 base + depth end to end ──────────────────────────────────────────────

static void testBaseDepthThroughEngine()
{
    std::cout << "§10 base + signed depth through processBlock\n";

    // Positive depth.
    {
        auto fx_ = makeFixture(flatEnvelopeData(1.0, 0.0), 0.2, 0.5, 0, 4 * kTicksPerBeat);
auto& fx = *fx_;
        fx.transport.play();
        CHECK_NEAR(renderAt(fx.engine, fx.transport, 12000), 0.7, "base 0.2 + depth 0.5");
    }

    // Half-open envelope: sustain 0.5 with depth 0.5 gives base + 0.25.
    {
        auto fx_ = makeFixture(flatEnvelopeData(0.5, 0.0), 0.2, 0.5, 0, 4 * kTicksPerBeat);
auto& fx = *fx_;
        fx.transport.play();
        CHECK_NEAR(renderAt(fx.engine, fx.transport, 12000), 0.45,
                   "depth scales the envelope's own level");
    }

    // NEGATIVE depth pulls the parameter DOWN from base.
    {
        auto fx_ = makeFixture(flatEnvelopeData(1.0, 0.0), 0.9, -0.6, 0, 4 * kTicksPerBeat);
auto& fx = *fx_;
        fx.transport.play();
        CHECK_NEAR(renderAt(fx.engine, fx.transport, 12000), 0.3,
                   "negative depth modulates downward");
        CHECK_NEAR(renderAt(fx.engine, fx.transport, 4 * kTicksPerBeat * kSamplesPerTick + 4096),
                   0.9, "and returns to base between gates");
    }

    // CLAMPING at the top rail.
    {
        auto fx_ = makeFixture(flatEnvelopeData(1.0, 0.0), 0.8, 1.0, 0, 4 * kTicksPerBeat);
auto& fx = *fx_;
        fx.transport.play();
        CHECK_NEAR(renderAt(fx.engine, fx.transport, 12000), 1.0, "clamps at 1.0");
    }

    // CLAMPING at the bottom rail.
    {
        auto fx_ = makeFixture(flatEnvelopeData(1.0, 0.0), 0.2, -1.0, 0, 4 * kTicksPerBeat);
auto& fx = *fx_;
        fx.transport.play();
        CHECK_NEAR(renderAt(fx.engine, fx.transport, 12000), 0.0, "clamps at 0.0");
    }

    // A shaped attack is genuinely traversed sample-accurately: 100 ms attack at
    // 48 kHz is 4800 samples, so 2400 samples in the value is half way.
    {
        auto data = flatEnvelopeData(1.0, 0.0);
        data["attackMs"] = 100.0;
        auto fx_ = makeFixture(data, 0.0, 1.0, 0, 4 * kTicksPerBeat);
auto& fx = *fx_;
        fx.transport.play();
        CHECK_NEAR(renderAt(fx.engine, fx.transport, 2400), 0.5,
                   "the attack is traversed at sample accuracy");
        CHECK_NEAR(renderAt(fx.engine, fx.transport, 4800), 1.0, "and completes on time");
    }
}

// ─── §11 live refresh + snapshot swap safety ──────────────────────────────────

static void testLiveRefreshAndSwap()
{
    std::cout << "§11 live definition refresh + snapshot swap\n";

    auto fx_ = makeFixture(flatEnvelopeData(1.0, 0.0), 0.0, 1.0, 0, 4 * kTicksPerBeat);
auto& fx = *fx_;
    fx.transport.play();
    CHECK_NEAR(renderAt(fx.engine, fx.transport, 12000), 1.0, "initial depth applies");

    // Edit the definition (a new base + depth) and refresh: the next block uses it.
    fx.timeline.setTrackGraphState(fx.setup.trackId,
        makeEnvelopeGraphState(fx.setup.trackId, flatEnvelopeData(1.0, 0.0), 0.3, 0.4));
    fx.engine.refreshEnvelopeDefinitions();
    CHECK_NEAR(renderAt(fx.engine, fx.transport, 12000), 0.7,
               "an edited definition is picked up on the next block");

    // Removing the envelope leaves nothing published (and no crash).
    fx.timeline.setTrackGraphState(fx.setup.trackId, nlohmann::json{
        {"version", 1}, {"trackId", fx.setup.trackId},
        {"nodes", nlohmann::json::array()}, {"edges", nlohmann::json::array()}});
    fx.engine.refreshEnvelopeDefinitions();
    {
        juce::AudioBuffer<float> buffer(2, 512);
        buffer.clear();
        fx.engine.processBlock(buffer, 512, fx.transport);
    }
    auto emptySnapshot = fx.engine.getEnvelopeModulationSnapshotForTesting();
    CHECK(emptySnapshot && emptySnapshot->empty(), "removing the envelope empties the snapshot");

    // Hammer the swap while blocks are rendering. This is the RCU path: the render
    // loop loads the live pointer once per block while the other thread republishes
    // and retires snapshots. A use-after-free here would surface as a crash or as
    // a garbage value outside 0..1.
    {
        auto stress_ = makeFixture(flatEnvelopeData(1.0, 0.0), 0.1, 0.8, 0, 4 * kTicksPerBeat);
auto& stress = *stress_;
        stress.transport.play();

        std::atomic<bool> stop{false};
        std::atomic<bool> sawBadValue{false};

        std::thread renderThread([&] {
            juce::AudioBuffer<float> buffer(2, 256);
            int64_t pos = 0;
            while (!stop.load(std::memory_order_acquire)) {
                buffer.clear();
                stress.transport.seekToSample(pos % 96000);
                stress.engine.processBlock(buffer, 256, stress.transport);
                const double v = publishedValue(stress.engine);
                if (v < -0.001 || v > 1.001) sawBadValue.store(true);
                pos += 256;
            }
        });

        for (int i = 0; i < 400; ++i) {
            stress.timeline.setTrackGraphState(stress.setup.trackId,
                makeEnvelopeGraphState(stress.setup.trackId, flatEnvelopeData(1.0, 0.0),
                                       0.1, (i % 2) ? 0.8 : 0.4));
            stress.engine.refreshEnvelopeDefinitions();
        }

        stop.store(true, std::memory_order_release);
        renderThread.join();

        CHECK(!sawBadValue.load(), "400 concurrent snapshot swaps never published a bad value");
    }
}

// ─── main ─────────────────────────────────────────────────────────────────────

int main()
{
    std::cout << "=== test_envelope_modulation_engine ===\n";

    testNoteGateDerivation();
    testLoopedBlockGates();
    testSlideNotes();
    testClipGates();
    testSnapshotConstruction();
    testPlayStart();
    testLoopWrap();
    testSeekIntoHeldNote();
    testStopRestsAtBase();
    testBaseDepthThroughEngine();
    testLiveRefreshAndSwap();

    std::cout << "\npassed: " << g_passed << "  failed: " << g_failed << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    return 1;
}
