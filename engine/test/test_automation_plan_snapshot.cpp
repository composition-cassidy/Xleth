// test_automation_plan_snapshot.cpp -- the envelope applier building the
// automation plan while the bridge thread edits the timeline.
//
// The applier thread rebuilds the plan (refreshAutomationPlanIfDirty ->
// refreshAutomationPlan) whenever a chain changed, holding only chainsMutex_.
// It read the LIVE Timeline's automation lanes, clips, envelopes and base
// values. The bridge thread edits those (commands, undo/redo), replaces the
// whole timeline on project load (`*g_timeline = std::move(*loaded)`) and
// points MixEngine at an export's frozen copy and back, none of it under
// chainsMutex_. A build overlapping any of that walked std::map nodes and point
// buffers being freed under it.
//
//   T1  The applier reads only what was published: an automation edit made on
//       the live timeline but not yet published (the bridge mid-command, before
//       its post-mutation hook runs) is invisible to an applier pass, and is
//       picked up once published.
//   T2  Project replace: chains destroyed and the timeline move-assigned, but
//       the new project not yet published (setTimeline) -> an applier pass
//       builds from the old project's published copy, never the half-swapped
//       live one. After the publish the next pass builds the new project.
//   T3  Export round trip: MixEngine on a frozen copy, back on the live
//       timeline, the copy freed -> the applier builds from the live one.
//   T4  Churn: the applier rebuilds in a tight loop on a second thread while
//       this thread edits lanes, clips, envelope points and base values through
//       UndoManager, undoes/redoes, changes chains, round-trips an export copy
//       and replaces the project. A watchdog fails a spinning map walk; every
//       plan must be well formed.
//   T5  Publish cost: ~5,000 clips, ~50,000 notes, with and without a full
//       automation load (printed).
//
// T4 is work-bound (fixed edit / replace / export / rebuild counts, ~3 s), not
// time-bound: with a fixed window the applier's rebuilds starved the editing
// thread of chainsMutex_ and the replace/export counts depended on scheduling.
//
// T1-T2 are deterministic and failed on the unfixed code (the plan followed
// the live timeline). T3 passed there too (it reads the frozen copy only while
// the copy is alive); it pins the export behaviour. T4 is the crash/hang net,
// including a copy freed under a running build.
//
// Uses the same-size LIFO allocator, so memory freed under a reader is handed
// straight to the next allocation of that size.
//
// Build: cmake --build build --target test_automation_plan_snapshot --config Release
// Run:   ctest --test-dir build -C Release -R "^test_automation_plan_snapshot$" -V

#include "audio/MixEngine.h"
#include "commands/TimelineCommands.h"
#include "commands/UndoManager.h"
#include "model/Timeline.h"
#include "model/TimelineSnapshot.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <random>
#include <string>
#include <thread>
#include <vector>

#include "lifo_same_size_allocator.h"   // replaces global new/delete for this binary

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                      \
    do {                                                                      \
        if (cond) {                                                           \
            ++g_passed;                                                       \
        } else {                                                              \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";       \
            ++g_failed;                                                       \
        }                                                                     \
    } while (0)

namespace {

constexpr double kRate  = 48000.0;
constexpr int    kBlock = 512;
constexpr int    kPoints = 64;            // per envelope
constexpr int64_t kClipTicks = 3840;      // one bar
const std::string kFx = "fx-plan-snapshot";
const char* const kParams[] = { "feedback", "filter_lo", "filter_hi", "mod_rate",
                                "mod_depth", "stereo_width", "duck_amount", "mix" };
constexpr int kParamCount = static_cast<int>(sizeof(kParams) / sizeof(kParams[0]));

// UndoManager and Timeline log every edit to stdout; swallowed for the churn.
struct QuietStdout
{
    std::streambuf* saved = std::cout.rdbuf();
    QuietStdout()  { std::cout.rdbuf(nullptr); }
    ~QuietStdout() { std::cout.rdbuf(saved); std::cout.clear(); }
};

std::vector<AutomationPoint> flatPoints(double value, int count = kPoints)
{
    std::vector<AutomationPoint> pts(static_cast<std::size_t>(count));
    for (int i = 0; i < count; ++i)
    {
        pts[static_cast<std::size_t>(i)].tick.ticks = i * (kClipTicks / kPoints);
        pts[static_cast<std::size_t>(i)].value = value;
    }
    return pts;
}

// One track; per Delay parameter one lane, one envelope at `value` and
// `clipsPerParam` back-to-back one-bar clips. Returns the track id.
int populate(Timeline& tl, int clipsPerParam, double value)
{
    TrackInfo t; t.name = "fx";
    const int track = tl.addTrack(t);
    for (int p = 0; p < kParamCount; ++p)
    {
        AutomationLane lane; lane.ownerTrackId = track; lane.index = p;
        const int laneId = tl.addAutomationLane(lane);
        AutomationEnvelope env;
        env.binding.ownerTrackId = track;
        env.binding.effectInstanceId = kFx;
        env.binding.parameterId = kParams[p];
        env.points = flatPoints(value);
        const int envId = tl.addAutomationEnvelope(env);
        for (int c = 0; c < clipsPerParam; ++c)
        {
            AutomationClip clip;
            clip.laneId = laneId;
            clip.envelopeId = envId;
            clip.position.ticks = c * kClipTicks;
            clip.duration.ticks = kClipTicks;
            tl.addAutomationClip(clip);
        }
    }
    return track;
}

int envelopeFor(const Timeline& tl, const char* param)
{
    for (const AutomationEnvelope* e : tl.getAllAutomationEnvelopes())
        if (e->binding.parameterId == param) return e->id;
    return -1;
}

struct Rig
{
    Timeline    timeline;
    MixEngine   engine;
    UndoManager undo { 64 };
    int track = -1;

    explicit Rig(int clipsPerParam = 1, double value = 0.9)
    {
        track = populate(timeline, clipsPerParam, value);
        engine.setTimeline(&timeline);   // publishes
        engine.prepare(kRate, kBlock);
        // Every applier pass below is run by hand, so it lands exactly where
        // the scenario needs it.
        engine.stopEnvelopeApplierForTesting();
        // What the bridge's UndoManager post-mutation hook does after every
        // edit, undo and redo (XlethEngineService.cpp).
        undo.setPostMutationHook([this] {
            engine.refreshTimelineSnapshot();
            engine.refreshAutomationPlan();
        });
        addEffect();
        engine.refreshAutomationPlan();
    }

    void addEffect() { engine.addGraphEffectNode(track, kFx, "delay"); }

    // The automated value of `param` at `tick`, or -1 when the plan has no target.
    double value(const char* param, int64_t tick = kClipTicks / 2)
    {
        bool found = false;
        const double v = engine.evaluateAutomationAtTick(track, kFx, param, tick, found);
        return found ? v : -1.0;
    }

    int diag(const char* key) { return engine.getAutomationPlanDiagnostics().value(key, -1); }
};

bool near(double a, double b) { return std::fabs(a - b) < 1e-9; }

// ── T1 ───────────────────────────────────────────────────────────────────────

void testUnpublishedEditInvisible()
{
    std::cout << "[T1] an unpublished live edit is invisible to an applier pass\n";
    Rig r(1, 0.9);
    CHECK(near(r.value("mix"), 0.9), "the published plan drives mix at 0.9 (got " << r.value("mix") << ")");
    CHECK(r.diag("windowCount") == kParamCount, "one window per parameter");

    // The bridge thread mid-edit: the live model has changed, the hook that
    // publishes it has not run yet.
    r.timeline.setAutomationEnvelopePoints(envelopeFor(r.timeline, "mix"), flatPoints(0.2));
    {
        AutomationLane lane; lane.ownerTrackId = r.track; lane.index = kParamCount;
        const int laneId = r.timeline.addAutomationLane(lane);
        AutomationClip clip;
        clip.laneId = laneId;
        clip.envelopeId = envelopeFor(r.timeline, "feedback");
        clip.position.ticks = 4 * kClipTicks;
        clip.duration.ticks = kClipTicks;
        r.timeline.addAutomationClip(clip);
    }

    // A chain change makes the applier rebuild.
    r.engine.destroyEffectChain(r.track);
    r.addEffect();
    CHECK(r.engine.refreshAutomationPlanIfDirty() == 1, "the chain change makes the applier rebuild");
    CHECK(near(r.value("mix"), 0.9),
          "the applier built from the published timeline, not the unpublished edit (mix="
              << r.value("mix") << ", 0.2 = it read the live timeline)");
    CHECK(r.diag("windowCount") == kParamCount,
          "the unpublished clip is not in the plan (windows=" << r.diag("windowCount") << ")");
    CHECK(r.diag("resolvedTargets") == kParamCount, "every target resolved against the new chain");

    // The hook's publish makes the edit reach the plan.
    r.engine.refreshTimelineSnapshot();
    r.engine.refreshAutomationPlan();
    CHECK(near(r.value("mix"), 0.2), "once published, the edit reaches the plan (mix=" << r.value("mix") << ")");
    CHECK(r.diag("windowCount") == kParamCount + 1, "... and so does the new clip");
}

// ── T2 ───────────────────────────────────────────────────────────────────────

void testProjectReplace()
{
    std::cout << "[T2] project replace: the applier never builds from the half-swapped timeline\n";
    Rig r(1, 0.9);
    CHECK(r.diag("windowCount") == kParamCount, "project A planned");

    // project_load: chains destroyed, then the timeline move-assigned, then
    // setTimeline publishes it. The applier can run between any two.
    r.engine.destroyAllEffectChains();
    {
        Timeline loaded;
        const int t = populate(loaded, 3, 0.3);
        CHECK(t == r.track, "the loaded project's track has the same id");
        r.timeline = std::move(loaded);
    }
    r.undo.clear();
    CHECK(r.engine.refreshAutomationPlanIfDirty() == 1, "destroying the chains makes the applier rebuild");
    CHECK(r.diag("unresolvedClips") == kParamCount,
          "the pass between the swap and the publish planned project A's published copy ("
              << r.diag("unresolvedClips") << " dead clips; " << 3 * kParamCount
              << " = it read the half-loaded live timeline)");

    r.engine.setTimeline(&r.timeline);   // publishes project B
    r.addEffect();                       // the load restores the chain
    CHECK(r.engine.refreshAutomationPlanIfDirty() == 1, "the restored chain makes the applier rebuild");
    CHECK(r.diag("windowCount") == 3 * kParamCount, "project B planned (windows=" << r.diag("windowCount") << ")");
    CHECK(r.diag("unresolvedClips") == 0, "every project B clip resolves");
    CHECK(near(r.value("mix", 2 * kClipTicks + 10), 0.3), "project B drives mix at 0.3 (got "
          << r.value("mix", 2 * kClipTicks + 10) << ")");
}

// ── T3 ───────────────────────────────────────────────────────────────────────

void testExportRoundTrip()
{
    std::cout << "[T3] export start/end: the applier never reads the frozen copy after it is freed\n";
    Rig r(1, 0.9);

    // video_exportStart: MixEngine on the frozen copy (published by setTimeline).
    FrozenTimelineCopy frozen = makeFrozenTimelineCopy(r.timeline);
    r.engine.setTimeline(frozen.timeline.get());
    r.engine.destroyEffectChain(r.track);
    r.addEffect();
    CHECK(r.engine.refreshAutomationPlanIfDirty() == 1, "a chain change during the export rebuilds");
    CHECK(near(r.value("mix"), 0.9), "... from the frozen copy");

    // An edit during the export changes only the live timeline (the bridge
    // hook does not publish while an export owns MixEngine).
    r.timeline.setAutomationEnvelopePoints(envelopeFor(r.timeline, "mix"), flatPoints(0.5));

    // restoreLiveTimelineAfterExport, then the copy dies (the next export
    // start frees it; here it is freed at once, harsher).
    r.engine.setTimeline(&r.timeline);
    r.engine.refreshAutomationPlan();
    frozen.timeline.reset();
    r.engine.destroyEffectChain(r.track);
    r.addEffect();
    CHECK(r.engine.refreshAutomationPlanIfDirty() == 1, "a chain change after the export rebuilds");
    CHECK(near(r.value("mix"), 0.5), "... from the live timeline, with the edit made during the export (mix="
          << r.value("mix") << ")");
}

// ── T4 ───────────────────────────────────────────────────────────────────────

void testChurn()
{
    std::cout << "[T4] churn: the applier rebuilds while the bridge edits, undoes and replaces\n";
    // Work-bound, not time-bound: the churn runs until it has done this much,
    // so how many edits fit does not depend on how the OS schedules the two
    // threads. kHangGuard only catches a test that never gets there.
    constexpr int      kMinEdits = 4096;     // 64 full cycles of the 64-edit pattern
    constexpr int      kMinReplaces = 64;
    constexpr int      kMinExports = 64;
    constexpr uint64_t kMinPasses = 10000;
    constexpr auto     kHangGuard = std::chrono::seconds(60);
    Rig r(2, 0.5);

    std::atomic<bool>     stop { false };
    std::atomic<uint64_t> passes { 0 };
    std::atomic<int>      malformed { 0 };

    // The applier: one rebuild per pass (what it runs whenever the plan is
    // stale), forced every pass so each one overlaps an edit.
    std::thread applier([&] {
        constexpr unsigned kBurst = 16;
        unsigned burst = 0;
        while (!stop.load(std::memory_order_acquire))
        {
            r.engine.refreshAutomationPlan();
            const nlohmann::json d = r.engine.getAutomationPlanDiagnostics();
            if (d.value("overflowed", true) || d.value("targetCount", -1) < 0
                || d.value("targetCount", 0) > kParamCount || d.value("droppedWindows", -1) != 0)
                malformed.fetch_add(1, std::memory_order_relaxed);
            passes.fetch_add(1, std::memory_order_release);
            // Rate limit: a bare yield left the applier holding chainsMutex_ almost
            // continuously (~57k rebuilds/s), starving the editing thread of the
            // lock its undo hook needs. A real sleep hands the lock over; it is
            // taken every kBurst passes so the applier stays busy while the
            // editor is mid-edit (a sleep every pass hid the race).
            if ((++burst % kBurst) == 0)
                std::this_thread::sleep_for(std::chrono::microseconds(200));
            else
                std::this_thread::yield();
        }
    });

    std::unique_ptr<QuietStdout> quiet = std::make_unique<QuietStdout>();
    std::mt19937 rng(4242);
    auto pick = [&](int n) { return n <= 0 ? 0 : std::uniform_int_distribution<int>(0, n - 1)(rng); };
    auto exec = [&](std::unique_ptr<Command> c) { r.undo.execute(std::move(c), r.timeline); };

    int edits = 0, replaces = 0, exports = 0;
    uint64_t lastSeen = 0;
    const auto start = std::chrono::steady_clock::now();
    auto lastProgress = start;
    bool timedOut = false;
    while (edits < kMinEdits || replaces < kMinReplaces || exports < kMinExports
           || passes.load(std::memory_order_acquire) < kMinPasses)
    {
        if (std::chrono::steady_clock::now() - start > kHangGuard)
        {
            timedOut = true;
            break;
        }
        Timeline& tl = r.timeline;
        const auto lanes = tl.getAllAutomationLanes();
        const auto clips = tl.getAllAutomationClips();
        const auto envs  = tl.getAllAutomationEnvelopes();
        switch (edits % 16)
        {
            case 0: case 1: {
                if (lanes.empty() || envs.empty()) break;
                AutomationClip c;
                c.laneId = lanes[static_cast<std::size_t>(pick(static_cast<int>(lanes.size())))]->id;
                c.envelopeId = envs[static_cast<std::size_t>(pick(static_cast<int>(envs.size())))]->id;
                c.position.ticks = pick(16) * kClipTicks;
                c.duration.ticks = kClipTicks;
                exec(std::make_unique<AddAutomationClipCommand>(c));   // an overlap is refused
                break;
            }
            case 2:
                if (!clips.empty())
                    exec(std::make_unique<RemoveAutomationClipCommand>(
                        clips[static_cast<std::size_t>(pick(static_cast<int>(clips.size())))]->id, tl));
                break;
            case 3:
                if (!clips.empty())
                {
                    const AutomationClip* c = clips[static_cast<std::size_t>(pick(static_cast<int>(clips.size())))];
                    exec(std::make_unique<MoveAutomationClipCommand>(
                        c->id, c->laneId, TickTime{ pick(16) * kClipTicks }, tl));
                }
                break;
            case 4: case 5:
                // Whole point-list swap: frees the old buffer in one go.
                if (!envs.empty())
                    exec(AutomationPointEditCommand::replaceAll(
                        envs[static_cast<std::size_t>(pick(static_cast<int>(envs.size())))]->id,
                        flatPoints(0.01 * pick(100), 2 + pick(2 * kPoints)), tl));
                break;
            case 6:
                if (!envs.empty())
                {
                    AutomationPoint p;
                    p.tick.ticks = pick(static_cast<int>(kClipTicks));
                    p.value = 0.01 * pick(100);
                    exec(AutomationPointEditCommand::add(
                        envs[static_cast<std::size_t>(pick(static_cast<int>(envs.size())))]->id, p, tl));
                }
                break;
            case 7:
                exec(std::make_unique<AddAutomationLaneCommand>(r.track, -1));
                break;
            case 8:
                if (lanes.size() > 2)
                    exec(std::make_unique<RemoveAutomationLaneCommand>(
                        lanes[static_cast<std::size_t>(pick(static_cast<int>(lanes.size())))]->id, tl));
                break;
            case 9: {
                AutomationBinding b;
                b.ownerTrackId = r.track;
                b.effectInstanceId = kFx;
                b.parameterId = kParams[pick(kParamCount)];
                exec(std::make_unique<SetAutomationBaseValueCommand>(b, 0.01 * pick(100), tl));
                break;
            }
            case 10: case 11: for (int k = 0, n = 1 + pick(6); k < n; ++k) r.undo.undo(tl); break;
            case 12: case 13: for (int k = 0, n = 1 + pick(6); k < n; ++k) r.undo.redo(tl); break;
            case 14:
                // A chain change (effect removed and re-added) between edits.
                r.engine.destroyEffectChain(r.track);
                r.addEffect();
                break;
            case 15:
                if (edits % 64 == 15)
                {
                    // Project replace, the project_load order.
                    r.engine.destroyAllEffectChains();
                    {
                        Timeline loaded;
                        populate(loaded, 1 + pick(4), 0.01 * pick(100));
                        r.timeline = std::move(loaded);
                    }
                    r.undo.clear();
                    r.engine.setTimeline(&r.timeline);
                    r.addEffect();
                    ++replaces;
                }
                else if (edits % 64 == 47)
                {
                    // Export start/end; the copy is freed at once.
                    FrozenTimelineCopy frozen = makeFrozenTimelineCopy(r.timeline);
                    r.engine.setTimeline(frozen.timeline.get());
                    std::this_thread::yield();
                    r.engine.setTimeline(&r.timeline);
                    r.engine.refreshAutomationPlan();
                    ++exports;
                }
                break;
        }
        ++edits;

        // Keep the populations bounded so the run stays dense, not huge.
        if (r.timeline.getAllAutomationClips().size() > 96)
            exec(std::make_unique<RemoveAutomationClipCommand>(
                r.timeline.getAllAutomationClips().front()->id, r.timeline));

        // Watchdog: an applier walking a freed std::map can spin forever.
        const uint64_t seen = passes.load(std::memory_order_acquire);
        const auto now = std::chrono::steady_clock::now();
        if (seen != lastSeen) { lastSeen = seen; lastProgress = now; }
        else if (now - lastProgress > std::chrono::seconds(5))
        {
            quiet.reset();
            std::cerr << "  FAIL the applier made no progress for 5 s after " << seen
                      << " passes (" << edits << " edits): it is stuck inside the plan build\n";
            std::_Exit(3);
        }
    }
    stop.store(true, std::memory_order_release);
    applier.join();
    quiet.reset();

    std::cerr << "  " << edits << " edits (" << replaces << " project replaces, " << exports
              << " export round trips), " << passes.load() << " applier rebuilds\n";
    CHECK(!timedOut, "the churn did not finish its work within " << kHangGuard.count() << " s (edits=" << edits
          << "/" << kMinEdits << ", replaces=" << replaces << "/" << kMinReplaces << ", exports=" << exports
          << "/" << kMinExports << ", passes=" << passes.load() << "/" << kMinPasses << ")");
    CHECK(passes.load() > 1000, "the applier rebuilt throughout the churn (" << passes.load() << ")");
    CHECK(replaces > 3 && exports > 3, "the churn replaced the project and round-tripped exports");
    CHECK(malformed.load() == 0, "every plan the applier built was well formed (" << malformed.load() << " not)");

    // The churn ends with the plan matching the published timeline.
    r.engine.refreshTimelineSnapshot();
    r.engine.refreshAutomationPlan();
    CHECK(r.engine.verifyTimelineSnapshot().empty(), "the published snapshot matches the timeline: "
          << r.engine.verifyTimelineSnapshot());
}

// ── T5 ───────────────────────────────────────────────────────────────────────

double medianPublishMs(MixEngine& engine, int runs = 25)
{
    std::vector<double> ms;
    for (int i = 0; i < runs; ++i)
    {
        const auto t0 = std::chrono::steady_clock::now();
        engine.refreshTimelineSnapshot();
        ms.push_back(std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count());
    }
    std::sort(ms.begin(), ms.end());
    return ms[ms.size() / 2];
}

void testPublishCost()
{
    std::cout << "[T5] publish cost: ~5,000 clips, ~50,000 notes\n";
    QuietStdout quiet;
    auto build = [](Timeline& tl, bool automation) {
        Timeline::ScopedBulkEdit bulk(tl);
        SampleRegion reg{};
        reg.name = "r";
        const int region = tl.addRegion(reg);
        for (int ti = 0; ti < 50; ++ti)
        {
            TrackInfo t{};
            t.name = "T" + std::to_string(ti);
            t.type = ti < 25 ? TrackInfo::Type::Clip : TrackInfo::Type::Pattern;
            const int track = tl.addTrack(t);
            if (t.type == TrackInfo::Type::Clip)
            {
                for (int i = 0; i < 200; ++i)
                {
                    Clip c{};
                    c.trackId = track;
                    c.regionId = region;
                    c.position = TickTime::fromBeats(i);
                    c.duration = TickTime::fromBeats(0.5);
                    tl.addClip(c);
                }
                continue;
            }
            for (int pi = 0; pi < 4; ++pi)
            {
                Pattern p{};
                p.regionId = region;
                p.length = TickTime::fromBeats(16.0);
                for (int n = 0; n < 500; ++n)
                {
                    PatternNote note{};
                    note.id = n + 1;
                    note.position = TickTime::fromBeats(n * 0.03125);
                    note.duration = TickTime::fromBeats(0.03);
                    note.pitch = 48 + n % 24;
                    p.notes.push_back(note);
                }
                p.nextNoteId = 501;
                const int pid = tl.addPattern(p);
                for (int b = 0; b < 4; ++b)
                {
                    PatternBlock blk{};
                    blk.trackId = track;
                    blk.patternId = pid;
                    blk.position = TickTime::fromBeats(64.0 * b + 16.0 * pi);
                    blk.duration = TickTime::fromBeats(16.0);
                    tl.addPatternBlock(blk);
                }
            }
        }
        // A full automation load: 128 envelopes x 64 points (the plan's 8,192
        // point capacity), 256 clips on 128 lanes.
        if (automation)
            for (int e = 0; e < 128; ++e)
            {
                AutomationLane lane;
                lane.ownerTrackId = tl.getAllTracks()[static_cast<std::size_t>(e % 50)]->id;
                lane.index = e;
                const int laneId = tl.addAutomationLane(lane);
                AutomationEnvelope env;
                env.binding.ownerTrackId = lane.ownerTrackId;
                env.binding.effectInstanceId = "fx-" + std::to_string(e);
                env.binding.parameterId = "mix";
                env.points = flatPoints(0.5);
                const int envId = tl.addAutomationEnvelope(env);
                for (int c = 0; c < 2; ++c)
                {
                    AutomationClip clip;
                    clip.laneId = laneId;
                    clip.envelopeId = envId;
                    clip.position.ticks = c * kClipTicks;
                    clip.duration.ticks = kClipTicks;
                    tl.addAutomationClip(clip);
                }
            }
    };

    Timeline plain, automated;
    build(plain, false);
    build(automated, true);
    // Heap: two MixEngines overflow even this binary's 8 MB stack.
    auto a = std::make_unique<MixEngine>();
    auto b = std::make_unique<MixEngine>();
    a->setTimeline(&plain);
    b->setTimeline(&automated);
    const double plainMs = medianPublishMs(*a);
    const double automatedMs = medianPublishMs(*b);
    std::cerr << "  " << plain.getAllClips().size() << " clips, 50,000 notes: publish median "
              << plainMs << " ms; with " << automated.getAllAutomationClips().size()
              << " automation clips / " << automated.getAllAutomationEnvelopes().size()
              << " envelopes x " << kPoints << " points: " << automatedMs << " ms\n";
    CHECK(b->verifyTimelineSnapshot().empty(), "the automated snapshot matches the timeline: "
          << b->verifyTimelineSnapshot());
}

} // namespace

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << std::unitbuf;
    std::cout << "test_automation_plan_snapshot\n";

    testUnpublishedEditInvisible();
    testProjectReplace();
    testExportRoundTrip();
    testChurn();
    testPublishCost();

    std::cout << (g_failed == 0 ? "PASS" : "FAIL")
              << " (" << g_passed << " passed, " << g_failed << " failed)\n";
    return g_failed == 0 ? 0 : 1;
}
