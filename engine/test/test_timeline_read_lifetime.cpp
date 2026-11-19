// test_timeline_read_lifetime.cpp -- the audio callback reading the timeline
// while the bridge thread edits it.
//
// processBlock walks the timeline's tracks, clips, pattern blocks and pattern
// notes every block. The bridge thread edits the same containers through
// UndoManager (add/remove/move, whole note-list swaps, undo/redo). Nothing
// stood between the two: the callback held raw pointers into std::map nodes
// and std::vector buffers that an edit could free under it.
//
//   T1  Churn: one thread renders blocks over a looping two-bar region; the
//       other adds, removes and moves pattern blocks and clips, adds and
//       removes notes, swaps whole note lists and undoes/redoes, as fast as it
//       can. A watchdog fails the test if the callback stops making progress
//       (a corrupted std::map walk spins instead of crashing).
//   T2  Edits still reach the audio: after the churn, a removal is silent, an
//       added clip or block plays, a muted track is silent, and undo/redo of
//       each is heard at the next block.
//
// Blocks render on the MAIN thread (it has the big stack processBlock wants);
// the second thread plays the bridge's role.
//
// Freed memory is poisoned. The Release heap hands a freed std::map node or
// note buffer straight back to the next allocation of that size, so a reader
// still holding it sees plausible data and a use-after-free passes silently
// (five clean runs on the unfixed code without this). This file replaces the
// global operator new/delete, for the whole executable, with one that fills a
// freed block with 0xFE and holds it back from reuse for the next 16K frees,
// as the debug CRT's 0xDD fill does: a stale pointer read from it faults.
//
// Build: cmake --build build --target test_timeline_read_lifetime --config Release
// Run:   ctest --test-dir build -C Release -R "^test_timeline_read_lifetime$" -V

#include "audio/MixEngine.h"
#include "commands/TimelineCommands.h"
#include "commands/UndoManager.h"
#include "model/Timeline.h"
#include "SampleBank.h"
#include "Transport.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <malloc.h>
#include <memory>
#include <mutex>
#include <new>
#include <random>
#include <thread>
#include <vector>

// ── Poisoning allocator (see the header comment) ─────────────────────────────

namespace poison {
constexpr std::size_t kQuarantine = 1u << 14;
std::mutex  mutex;
void*       ring[kQuarantine] = {};
std::size_t head = 0;
} // namespace poison

void* operator new(std::size_t n)
{
    if (void* p = std::malloc(n != 0 ? n : 1)) return p;
    throw std::bad_alloc();
}

void operator delete(void* p) noexcept
{
    if (p == nullptr) return;
    std::memset(p, 0xFE, _msize(p));
    void* evicted = nullptr;
    {
        std::lock_guard<std::mutex> lock(poison::mutex);
        evicted = poison::ring[poison::head];
        poison::ring[poison::head] = p;
        poison::head = (poison::head + 1) % poison::kQuarantine;
    }
    std::free(evicted);
}

void operator delete(void* p, std::size_t) noexcept { operator delete(p); }

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
constexpr double kBpm   = 120.0;
constexpr int    kBlock = 512;
constexpr int    kRoot  = 69;
constexpr double kLoopBeats = 8.0;   // two bars; every edit lands inside them

// UndoManager and Timeline log every edit to stdout; tens of thousands of
// edits would bury the test's own output. Swallowed for the churn only.
struct QuietStdout
{
    std::streambuf* saved = std::cout.rdbuf();
    QuietStdout()  { std::cout.rdbuf(nullptr); }
    ~QuietStdout() { std::cout.rdbuf(saved); std::cout.clear(); }
};

struct Rig
{
    Timeline    timeline { kBpm, kRate, 4, 4 };
    SampleBank  bank;
    UndoManager undo { 64 };
    std::unique_ptr<MixEngine> engine;
    Transport   transport;

    int patternTrack = -1, clipTrack = -1;
    int patternRegion = -1, clipRegion = -1;
    int patternId = -1;
    juce::AudioBuffer<float> sine;

    Rig()
    {
        const int n = static_cast<int>(kRate * 4.0);
        sine.setSize(1, n);
        for (int i = 0; i < n; ++i)
            sine.setSample(0, i, static_cast<float>(
                0.05 * std::sin(2.0 * juce::MathConstants<double>::pi * 440.0 * i / kRate)));

        engine = std::make_unique<MixEngine>();
        engine->setTimeline(&timeline);
        engine->setSampleBank(&bank);

        // Pattern track: one region, one pattern, a block on every beat.
        SampleRegion pr{};
        pr.name = "pat";
        pr.slot(0).rootNote = kRoot;
        pr.crossfadeEnabled = true;                    // sustained: note-off releases
        pr.modulation.envs[0].release.ms = 5.0f;
        patternRegion = timeline.addRegion(pr);

        TrackInfo pt{};
        pt.name = "P";
        pt.type = TrackInfo::Type::Pattern;
        pt.volume = 1.0f;
        patternTrack = timeline.addTrack(pt);

        Pattern p{};
        p.name = "p";
        p.regionId = patternRegion;
        p.length = TickTime::fromBeats(1.0);
        int noteId = 1;
        for (int i = 0; i < 4; ++i)
        {
            PatternNote note{};
            note.id = noteId++;
            note.position = TickTime::fromBeats(0.25 * i);
            note.duration = TickTime::fromBeats(0.2);
            note.pitch = kRoot + i;
            note.velocity = 1.0f;
            p.notes.push_back(note);
        }
        p.nextNoteId = noteId;
        patternId = timeline.addPattern(p);

        for (int beat = 0; beat < static_cast<int>(kLoopBeats); ++beat)
            timeline.addPatternBlock(makeBlock(beat));

        // Clip track: one region, a clip on every beat.
        SampleRegion cr{};
        cr.name = "clip";
        clipRegion = timeline.addRegion(cr);

        TrackInfo ct{};
        ct.name = "C";
        ct.type = TrackInfo::Type::Clip;
        ct.volume = 1.0f;
        clipTrack = timeline.addTrack(ct);

        for (int beat = 0; beat < static_cast<int>(kLoopBeats); ++beat)
            timeline.addClip(makeClip(beat));

        const int sampleId = bank.addSampleFromBuffer(sine, kRate, "sine");
        engine->mapRegionToSample(patternRegion, sampleId);
        engine->mapRegionToSample(clipRegion, sampleId);

        engine->rebuildAllSamplers();
        engine->prepare(kRate, kBlock);

        // What the bridge does: every command, undo and redo republishes the
        // timeline the audio thread plays from. The setup above edited the
        // timeline directly, so publish once by hand.
        undo.setPostMutationHook([this] { engine->refreshTimelineSnapshot(); });
        engine->refreshTimelineSnapshot();

        transport.setSampleRate(kRate);
        transport.setBPM(kBpm);
        transport.setLoopBounds(0, beatsToSamples(kLoopBeats), true);
    }

    static int64_t beatsToSamples(double beats)
    {
        return static_cast<int64_t>(beats * 60.0 / kBpm * kRate);
    }

    PatternBlock makeBlock(double beat) const
    {
        PatternBlock b{};
        b.trackId = patternTrack;
        b.patternId = patternId;
        b.position = TickTime::fromBeats(beat);
        b.duration = TickTime::fromBeats(1.0);
        b.loopEnabled = true;
        return b;
    }

    Clip makeClip(double beat) const
    {
        Clip c{};
        c.trackId = clipTrack;
        c.regionId = clipRegion;
        c.position = TickTime::fromBeats(beat);
        c.duration = TickTime::fromBeats(0.5);
        c.velocity = 1.0f;
        return c;
    }

    // One block; returns its peak, or -1 if it holds a non-finite sample.
    float block()
    {
        juce::AudioBuffer<float> buf(2, kBlock);
        buf.clear();
        engine->processBlock(buf, kBlock, transport);
        transport.advance(kBlock);
        float peak = 0.0f;
        for (int ch = 0; ch < 2; ++ch)
        {
            const float* p = buf.getReadPointer(ch);
            for (int i = 0; i < kBlock; ++i)
            {
                if (!std::isfinite(p[i])) return -1.0f;
                peak = std::max(peak, std::abs(p[i]));
            }
        }
        return peak;
    }

    // Loudest block over `seconds` of playback.
    float loudest(double seconds)
    {
        float peak = 0.0f;
        const int blocks = static_cast<int>(seconds * kRate / kBlock) + 1;
        for (int i = 0; i < blocks; ++i) peak = std::max(peak, block());
        return peak;
    }

    void exec(std::unique_ptr<Command> cmd) { undo.execute(std::move(cmd), timeline); }
};

// ── T1 ───────────────────────────────────────────────────────────────────────

void testChurn()
{
    std::cout << "[T1] add/remove/move/undo/redo churn against a rendering thread\n";
    Rig rig;
    rig.transport.play();
    for (int i = 0; i < 4; ++i) rig.block();

    constexpr int kIterations = 40000;
    std::atomic<bool>     done { false };
    std::atomic<uint64_t> blocksRendered { 0 };
    std::atomic<int>      edits { 0 };

    std::unique_ptr<QuietStdout> quiet = std::make_unique<QuietStdout>();
    std::thread bridge([&] {
        Timeline& tl = rig.timeline;
        Timeline::ScopedBulkEdit quietModel(tl);
        std::mt19937 rng(9876);
        auto pick = [&](int n) { return std::uniform_int_distribution<int>(0, n - 1)(rng); };
        auto beat = [&] { return std::uniform_int_distribution<int>(0, 31)(rng) * 0.25; };

        uint64_t lastSeen = 0;
        auto lastProgress = std::chrono::steady_clock::now();

        for (int it = 0; it < kIterations; ++it)
        {
            switch (it % 10)
            {
                case 0: {
                    // An exact {track, pattern, position} duplicate is refused (and logged).
                    const double b = beat();
                    bool taken = false;
                    for (const PatternBlock* x : tl.getAllPatternBlocks())
                        taken = taken || x->position.ticks == TickTime::fromBeats(b).ticks;
                    if (!taken) rig.exec(std::make_unique<AddPatternBlockCommand>(rig.makeBlock(b)));
                    break;
                }
                case 1: {
                    const auto blocks = tl.getAllPatternBlocks();
                    if (!blocks.empty())
                        rig.exec(std::make_unique<RemovePatternBlockCommand>(
                            blocks[static_cast<size_t>(pick(static_cast<int>(blocks.size())))]->id, tl));
                    break;
                }
                case 2: rig.exec(std::make_unique<AddClipCommand>(rig.makeClip(beat()))); break;
                case 3: {
                    const auto clips = tl.getAllClips();
                    if (!clips.empty())
                        rig.exec(std::make_unique<RemoveClipCommand>(
                            clips[static_cast<size_t>(pick(static_cast<int>(clips.size())))]->id, tl));
                    break;
                }
                case 4: {
                    PatternNote n{};
                    n.position = TickTime::fromBeats(0.0625 * pick(16));
                    n.duration = TickTime::fromBeats(0.1);
                    n.pitch = kRoot + pick(12);
                    n.velocity = 0.8f;
                    rig.exec(std::make_unique<AddNoteCommand>(rig.patternId, n));
                    break;
                }
                case 5: {
                    const Pattern* p = tl.getPattern(rig.patternId);
                    if (p != nullptr && p->notes.size() > 2)
                        rig.exec(std::make_unique<RemoveNoteCommand>(
                            rig.patternId, p->notes[static_cast<size_t>(pick(static_cast<int>(p->notes.size())))].id, tl));
                    break;
                }
                case 6: {
                    // Whole note-list swap: frees the old buffer in one go.
                    std::vector<PatternNote> notes;
                    const int count = 2 + pick(40);
                    for (int i = 0; i < count; ++i)
                    {
                        PatternNote n{};
                        n.position = TickTime::fromBeats(0.025 * i);
                        n.duration = TickTime::fromBeats(0.02);
                        n.pitch = kRoot + (i % 12);
                        n.velocity = 0.7f;
                        notes.push_back(n);
                    }
                    rig.exec(std::make_unique<EditPatternNotesCommand>(rig.patternId, std::move(notes), tl));
                    break;
                }
                case 7: {
                    const auto blocks = tl.getAllPatternBlocks();
                    if (!blocks.empty())
                        rig.exec(std::make_unique<MovePatternBlockCommand>(
                            blocks[static_cast<size_t>(pick(static_cast<int>(blocks.size())))]->id,
                            rig.patternTrack, TickTime::fromBeats(beat()), tl));
                    break;
                }
                case 8: for (int k = 0, n = 1 + pick(6); k < n; ++k) rig.undo.undo(tl); break;
                case 9: for (int k = 0, n = 1 + pick(6); k < n; ++k) rig.undo.redo(tl); break;
            }
            edits.fetch_add(1, std::memory_order_relaxed);

            // Keep the populations bounded so the run stays dense, not huge.
            if (tl.getAllPatternBlocks().size() > 48)
                rig.exec(std::make_unique<RemovePatternBlockCommand>(tl.getAllPatternBlocks().front()->id, tl));
            if (tl.getAllClips().size() > 48)
                rig.exec(std::make_unique<RemoveClipCommand>(tl.getAllClips().front()->id, tl));

            // Watchdog: a callback walking a freed std::map can spin forever.
            const uint64_t seen = blocksRendered.load(std::memory_order_acquire);
            const auto now = std::chrono::steady_clock::now();
            if (seen != lastSeen) { lastSeen = seen; lastProgress = now; }
            else if (now - lastProgress > std::chrono::seconds(5))
            {
                std::cerr << "  FAIL the rendering thread made no progress for 5 s after "
                          << seen << " blocks (" << it << " edits): it is stuck inside processBlock\n";
                std::_Exit(3);
            }
        }
        done.store(true, std::memory_order_release);
    });

    uint64_t blocks = 0, audible = 0;
    int bad = 0;
    while (!done.load(std::memory_order_acquire))
    {
        const float peak = rig.block();
        if (peak < 0.0f || peak > 8.0f) ++bad;
        else if (peak > 1.0e-4f) ++audible;
        blocksRendered.store(++blocks, std::memory_order_release);
    }
    bridge.join();
    quiet.reset();

    CHECK(bad == 0, bad << " of " << blocks << " blocks held garbage");
    CHECK(audible > 0, "audio was actually rendered during the churn");
    CHECK(blocks > 200, "the callback ran throughout the churn (" << blocks << " blocks)");
    std::cout << "  blocks=" << blocks << " audible=" << audible
              << " edits=" << edits.load() << "\n";
}

// ── T2 ───────────────────────────────────────────────────────────────────────

void testEditsReachAudio()
{
    std::cout << "[T2] every commit is heard at the next block\n";
    Rig rig;
    Timeline& tl = rig.timeline;
    QuietStdout quiet;
    rig.transport.play();

    CHECK(rig.loudest(kLoopBeats * 0.5) > 1.0e-3f, "the starting project plays");

    // Remove everything through commands: silence.
    for (const PatternBlock* b : tl.getAllPatternBlocks())
        rig.exec(std::make_unique<RemovePatternBlockCommand>(b->id, tl));
    for (const Clip* c : tl.getAllClips())
        rig.exec(std::make_unique<RemoveClipCommand>(c->id, tl));
    rig.loudest(0.2);                                            // release tails
    CHECK(rig.loudest(kLoopBeats * 0.5) < 1.0e-5f, "an empty timeline is silent");

    // A clip spanning the whole loop plays at once, and its undo/redo is heard.
    Clip whole = rig.makeClip(0.0);
    whole.duration = TickTime::fromBeats(kLoopBeats);
    rig.exec(std::make_unique<AddClipCommand>(whole));
    CHECK(rig.loudest(0.05) > 1.0e-3f, "an added clip plays at the next block");
    rig.undo.undo(tl);
    rig.loudest(0.05);
    CHECK(rig.loudest(0.2) < 1.0e-5f, "undoing it silences it");
    rig.undo.redo(tl);
    CHECK(rig.loudest(0.05) > 1.0e-3f, "redoing it plays again");

    // Mute is a track edit the callback reads every block.
    rig.exec(std::make_unique<SetTrackMutedCommand>(rig.clipTrack, true, tl));
    rig.loudest(0.05);
    CHECK(rig.loudest(0.2) < 1.0e-5f, "a muted track is silent");
    rig.undo.undo(tl);
    CHECK(rig.loudest(0.05) > 1.0e-3f, "unmuting it is heard");
    rig.undo.undo(tl);                                           // the clip goes again
    rig.loudest(0.05);
    CHECK(rig.loudest(0.2) < 1.0e-5f, "the clip is gone again");

    // Pattern notes. The pattern is emptied while nothing plays it (emptying a
    // SOUNDING pattern strands its held voices: their note-offs went with the
    // notes), then a block spanning the loop is added and the notes come back.
    const std::vector<PatternNote> notes = tl.getPattern(rig.patternId)->notes;
    rig.exec(std::make_unique<EditPatternNotesCommand>(rig.patternId, std::vector<PatternNote>{}, tl));
    PatternBlock wholeBlock = rig.makeBlock(0.0);
    wholeBlock.duration = TickTime::fromBeats(kLoopBeats);
    rig.exec(std::make_unique<AddPatternBlockCommand>(wholeBlock));
    CHECK(rig.loudest(0.6) < 1.0e-5f, "a block whose pattern has no notes is silent");
    rig.exec(std::make_unique<EditPatternNotesCommand>(rig.patternId, notes, tl));
    CHECK(rig.loudest(0.6) > 1.0e-3f, "notes added to a playing pattern are heard");
    rig.undo.undo(tl);                                           // notes gone again
    rig.undo.undo(tl);                                           // and the block
    rig.loudest(0.2);
    CHECK(rig.loudest(0.6) < 1.0e-5f, "undoing the block silences it");
    rig.undo.redo(tl);                                           // block, still no notes
    CHECK(rig.loudest(0.6) < 1.0e-5f, "redoing the block of an empty pattern is silent");
    rig.undo.redo(tl);                                           // the notes
    CHECK(rig.loudest(0.6) > 1.0e-3f, "redoing the note edit is heard");
}

// ── T3 ───────────────────────────────────────────────────────────────────────

void testPublishCost()
{
    std::cout << "[T3] publish cost: ~5,000 clips, ~50,000 notes\n";
    QuietStdout quiet;
    Timeline tl { kBpm, kRate, 4, 4 };
    Timeline::ScopedBulkEdit bulk(tl);
    SampleRegion r{};
    r.name = "r";
    const int region = tl.addRegion(r);

    int clips = 0, notes = 0;
    for (int ti = 0; ti < 50; ++ti)
    {
        TrackInfo t{};
        t.name = "T" + std::to_string(ti);
        t.type = ti < 25 ? TrackInfo::Type::Clip : TrackInfo::Type::Pattern;
        const int track = tl.addTrack(t);
        if (t.type == TrackInfo::Type::Clip)
        {
            for (int i = 0; i < 200; ++i, ++clips)
            {
                Clip c{};
                c.trackId = track;
                c.regionId = region;
                c.position = TickTime::fromBeats(i);
                c.duration = TickTime::fromBeats(0.5);
                tl.addClip(c);
            }
        }
        else
        {
            for (int pi = 0; pi < 4; ++pi)
            {
                Pattern p{};
                p.regionId = region;
                p.length = TickTime::fromBeats(16.0);
                for (int n = 0; n < 500; ++n, ++notes)
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
    }

    MixEngine engine;
    engine.setTimeline(&tl);                     // publishes once
    std::vector<double> ms;
    for (int i = 0; i < 25; ++i)
    {
        const auto t0 = std::chrono::steady_clock::now();
        engine.refreshTimelineSnapshot();
        ms.push_back(std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - t0).count());
    }
    std::sort(ms.begin(), ms.end());
    std::cerr << "  " << clips << " clips, " << notes << " notes: publish median "
              << ms[ms.size() / 2] << " ms, max " << ms.back() << " ms\n";
    CHECK(engine.verifyTimelineSnapshot().empty(), "the published snapshot matches the timeline");

    // The clip gain/fade drag preview: one clip's gain per message.
    const int dragged = tl.getAllClips()[2500]->id;
    std::vector<double> dragMs;
    for (int i = 0; i < 25; ++i)
    {
        tl.getClipMutable(dragged)->velocity = 0.5f + 0.01f * static_cast<float>(i);
        const auto t0 = std::chrono::steady_clock::now();
        engine.refreshTimelineSnapshotForClip(dragged);
        dragMs.push_back(std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - t0).count());
    }
    std::sort(dragMs.begin(), dragMs.end());
    std::cerr << "  drag preview (one clip's gain): publish median "
              << dragMs[dragMs.size() / 2] << " ms, max " << dragMs.back() << " ms\n";
    const std::string diff = engine.verifyTimelineSnapshot();
    CHECK(diff.empty(), "a clip-only publish matches the timeline: " << diff);
}

} // namespace

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << std::unitbuf;
    std::cout << "test_timeline_read_lifetime\n";

    testChurn();
    testEditsReachAudio();
    testPublishCost();

    std::cout << (g_failed == 0 ? "PASS" : "FAIL")
              << " (" << g_passed << " passed, " << g_failed << " failed)\n";
    return g_failed == 0 ? 0 : 1;
}
