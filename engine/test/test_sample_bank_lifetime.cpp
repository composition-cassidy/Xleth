// test_sample_bank_lifetime.cpp -- SampleBank buffers vs. the audio thread.
//
// The audio thread reads SampleBank buffers through raw pointers in two places:
// MixEngine's clip render (getSample per active clip, then a block of reads)
// and VoiceManager (getSample per voice, then a block of reads). The bridge
// thread loads and unloads samples (project load, audio swaps, undo of a bake).
// Nothing stood between the two: unloadSample freed a buffer a block was still
// reading, and a load's push_back could reallocate the slot vector under
// getSample. Samplers are not readers: Sampler::loadSlotSample copies the PCM
// when a sampler is built, so no sampler set points into the bank.
//
//   T1  Churn: the main thread renders blocks (24 overlapping audio clips, a
//       pattern track of samplers and VoiceManager voices, all on the regions'
//       current samples); the second thread loads a fresh sample, remaps a
//       region to it, rebuilds the stale samplers, retargets the voices and
//       unloads the old sample, as fast as it can. Every 16th pass it replaces
//       the whole bank the way project load does: a fresh copy of every sample,
//       remap, then unload every old id. A watchdog fails the test if the
//       callback stops making progress.
//   T2  Storage stays bounded: after thousands of loads with two samples live,
//       the bank holds a handful of slots, not thousands.
//   T3  Undo still finds its audio: an unloaded id reads as gone, restoreSample
//       brings exactly that id back, a live id is not replaced, and an id is
//       never handed out twice.
//
// Buffers are 4 s of stereo (1.5 MB): the Windows heap serves that from its
// own VirtualAlloc, so freeing it releases the pages and a block still reading
// them faults instead of reading leftovers. The same-size LIFO allocator puts
// the next sample's bookkeeping exactly where the freed one's was, so a stale
// pointer that survives reads a different sample rather than plausible data.
//
// Build: cmake --build build --target test_sample_bank_lifetime --config Release
// Run:   ctest --test-dir build -C Release -R "^test_sample_bank_lifetime$" -V

#include "audio/MixEngine.h"
#include "model/Timeline.h"
#include "SampleBank.h"
#include "Transport.h"
#include "VoiceManager.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <memory>
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

constexpr double kRate      = 48000.0;
constexpr double kBpm       = 120.0;
constexpr int    kBlock     = 2048;
constexpr int    kRoot      = 69;
constexpr double kLoopBeats = 8.0;                       // 4 s at 120 bpm
constexpr int    kSampleLen = static_cast<int>(kRate * 4.0);
constexpr int    kClips     = 24;
constexpr int    kPasses    = 3000;

// MixEngine and Timeline log edits to stdout; swallowed for the churn only.
struct QuietStdout
{
    std::streambuf* saved = std::cout.rdbuf();
    QuietStdout()  { std::cout.rdbuf(nullptr); }
    ~QuietStdout() { std::cout.rdbuf(saved); std::cout.clear(); }
};

// 4 s of stereo DC at `value`: distinct per sample, and nothing to interpolate.
juce::AudioBuffer<float> constantBuffer(float value)
{
    juce::AudioBuffer<float> b(2, kSampleLen);
    for (int ch = 0; ch < 2; ++ch)
        juce::FloatVectorOperations::fill(b.getWritePointer(ch), value, kSampleLen);
    return b;
}

struct Rig
{
    Timeline     timeline { kBpm, kRate, 4, 4 };
    SampleBank   bank;
    MixEngine    engine;
    Transport    transport;
    VoiceManager voices { 32 };

    int clipRegion = -1, patternRegion = -1;
    std::atomic<int> voiceTarget { -1 };   // the id new voices play; bridge-written

    Rig()
    {
        engine.setTimeline(&timeline);
        engine.setSampleBank(&bank);

        // Clip track: kClips clips over the whole loop, all on one region, so
        // every block reads that region's sample kClips times.
        SampleRegion cr{};
        cr.name = "clip";
        clipRegion = timeline.addRegion(cr);
        TrackInfo ct{};
        ct.name = "C";
        ct.type = TrackInfo::Type::Clip;
        ct.volume = 0.25f;
        const int clipTrack = timeline.addTrack(ct);
        for (int i = 0; i < kClips; ++i)
        {
            Clip c{};
            c.trackId  = clipTrack;
            c.regionId = clipRegion;
            c.position = TickTime::fromBeats(0.0);
            c.duration = TickTime::fromBeats(kLoopBeats);
            c.velocity = 1.0f;
            timeline.addClip(c);
        }

        // Pattern track: samplers built from the other region's sample.
        SampleRegion pr{};
        pr.name = "pat";
        pr.slot(0).rootNote = kRoot;
        patternRegion = timeline.addRegion(pr);
        TrackInfo pt{};
        pt.name = "P";
        pt.type = TrackInfo::Type::Pattern;
        pt.volume = 0.25f;
        const int patternTrack = timeline.addTrack(pt);
        Pattern p{};
        p.name = "p";
        p.regionId = patternRegion;
        p.length = TickTime::fromBeats(1.0);
        for (int i = 0; i < 4; ++i)
        {
            PatternNote n{};
            n.id = i + 1;
            n.position = TickTime::fromBeats(0.25 * i);
            n.duration = TickTime::fromBeats(0.2);
            n.pitch = kRoot + i;
            n.velocity = 1.0f;
            p.notes.push_back(n);
        }
        p.nextNoteId = 5;
        const int patternId = timeline.addPattern(p);
        for (int beat = 0; beat < static_cast<int>(kLoopBeats); ++beat)
        {
            PatternBlock b{};
            b.trackId = patternTrack;
            b.patternId = patternId;
            b.position = TickTime::fromBeats(beat);
            b.duration = TickTime::fromBeats(1.0);
            b.loopEnabled = true;
            timeline.addPatternBlock(b);
        }

        const int clipSample    = bank.addSampleFromBuffer(constantBuffer(0.05f), kRate, "c0");
        const int patternSample = bank.addSampleFromBuffer(constantBuffer(0.07f), kRate, "p0");
        engine.mapRegionToSample(clipRegion, clipSample);
        engine.mapRegionToSample(patternRegion, patternSample);
        voiceTarget.store(clipSample);

        engine.rebuildAllSamplers();
        engine.prepare(kRate, kBlock);
        engine.refreshTimelineSnapshot();

        transport.setSampleRate(kRate);
        transport.setBPM(kBpm);
        transport.setLoopBounds(0, static_cast<int64_t>(kLoopBeats * 60.0 / kBpm * kRate), true);
    }

    // One callback's worth: the timeline mix, then the manual voices, as
    // AudioEngine does. Returns the block's peak, or -1 for a non-finite sample.
    float block(int index)
    {
        juce::AudioBuffer<float> buf(2, kBlock);
        buf.clear();
        engine.processBlock(buf, kBlock, transport);
        if (index % 2 == 0) voices.triggerSample(voiceTarget.load(std::memory_order_acquire), 0.1f);
        voices.processBlock(buf, bank);
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
};

// Every id the bank still holds audio for. The bank has no listing of its own,
// and ids never exceed the count of ids handed out, so a probe over a range
// generous enough to cover them all finds every one.
std::vector<int> liveIds(const SampleBank& bank, int idsHandedOut)
{
    std::vector<int> out;
    for (int id = 0; id < idsHandedOut; ++id)
        if (bank.getSample(id) != nullptr) out.push_back(id);
    return out;
}

// ── T1 + T2 ──────────────────────────────────────────────────────────────────

void testChurn()
{
    std::cout << "[T1] load/remap/unload churn against a rendering thread\n";
    auto rigOwner = std::make_unique<Rig>();
    Rig& rig = *rigOwner;
    rig.transport.play();
    for (int i = 0; i < 4; ++i) rig.block(i);

    std::atomic<bool>     done { false };
    std::atomic<uint64_t> blocksRendered { 0 };
    std::atomic<int>      loads { 0 }, unloads { 0 }, bankRebuilds { 0 };
    std::atomic<int>      idsHandedOut { 2 };

    auto quiet = std::make_unique<QuietStdout>();
    std::thread bridge([&] {
        SampleBank& bank = rig.bank;
        MixEngine&  engine = rig.engine;
        int clipSample = engine.getSampleIdForRegion(rig.clipRegion);
        int patternSample = engine.getSampleIdForRegion(rig.patternRegion);

        uint64_t lastSeen = 0;
        auto lastProgress = std::chrono::steady_clock::now();

        for (int pass = 0; pass < kPasses; ++pass)
        {
            const float value = 0.02f + 0.01f * static_cast<float>(pass % 8);
            if (pass % 16 == 15)
            {
                // Project load: a fresh copy of everything, remap, then every old id goes.
                const std::vector<int> old = liveIds(bank, idsHandedOut.load() + 8);
                clipSample    = bank.addSampleFromBuffer(constantBuffer(value), kRate, "c");
                patternSample = bank.addSampleFromBuffer(constantBuffer(value + 0.005f), kRate, "p");
                idsHandedOut.fetch_add(2);
                loads.fetch_add(2);
                engine.mapRegionToSample(rig.clipRegion, clipSample);
                engine.mapRegionToSample(rig.patternRegion, patternSample);
                engine.refreshStaleSamplers();
                rig.voiceTarget.store(clipSample, std::memory_order_release);
                for (int id : old) { bank.unloadSample(id); unloads.fetch_add(1); }
                bankRebuilds.fetch_add(1);
            }
            else
            {
                // An audio swap: one region gets a new sample, the old one is
                // dropped. Mostly the clip region: the clips and voices read the
                // bank every block, the samplers only copy from it.
                const bool clipSide = (pass % 4) != 3;
                const int fresh = bank.addSampleFromBuffer(constantBuffer(value), kRate, "s");
                idsHandedOut.fetch_add(1);
                loads.fetch_add(1);
                const int old = clipSide ? clipSample : patternSample;
                engine.mapRegionToSample(clipSide ? rig.clipRegion : rig.patternRegion, fresh);
                engine.refreshStaleSamplers();
                if (clipSide) { clipSample = fresh; rig.voiceTarget.store(fresh, std::memory_order_release); }
                else          { patternSample = fresh; }
                bank.unloadSample(old);
                unloads.fetch_add(1);
            }

            // Watchdog: a callback reading a reallocated slot vector can spin.
            const uint64_t seen = blocksRendered.load(std::memory_order_acquire);
            const auto now = std::chrono::steady_clock::now();
            if (seen != lastSeen) { lastSeen = seen; lastProgress = now; }
            else if (now - lastProgress > std::chrono::seconds(5))
            {
                std::cerr << "  FAIL the rendering thread made no progress for 5 s after "
                          << seen << " blocks (" << pass << " passes): it is stuck inside a block\n";
                std::_Exit(3);
            }
        }
        done.store(true, std::memory_order_release);
    });

    uint64_t blocks = 0, audible = 0;
    int bad = 0;
    while (!done.load(std::memory_order_acquire))
    {
        const float peak = rig.block(static_cast<int>(blocks));
        if (peak < 0.0f || peak > 64.0f) ++bad;
        else if (peak > 1.0e-4f) ++audible;
        blocksRendered.store(++blocks, std::memory_order_release);
    }
    bridge.join();
    quiet.reset();

    CHECK(bad == 0, bad << " of " << blocks << " blocks held garbage");
    // A swap must not silence the clips for a block: the block's bank pin is
    // taken after its region map, and a swap publishes the sample before it
    // remaps (pinning first left a third of these blocks silent).
    CHECK(audible * 20 >= blocks * 19, "audio was rendered throughout the churn (" << audible << " of " << blocks << ")");
    CHECK(blocks > 200, "the callback ran throughout the churn (" << blocks << " blocks)");
    CHECK(loads.load() > kPasses, "every pass loaded a sample (" << loads.load() << ")");
    std::cout << "  blocks=" << blocks << " audible=" << audible << " loads=" << loads.load()
              << " unloads=" << unloads.load() << " bankRebuilds=" << bankRebuilds.load() << "\n";

    // Still playing what is mapped now, after all of that.
    float peak = 0.0f;
    for (int i = 0; i < 16; ++i) peak = std::max(peak, rig.block(i));
    CHECK(peak > 1.0e-3f && peak < 64.0f, "the last mapped samples play after the churn (peak " << peak << ")");

    std::cout << "[T2] slot storage stays bounded\n";
    const int live = static_cast<int>(liveIds(rig.bank, idsHandedOut.load() + 8).size());
    CHECK(live == 2, "two samples live after the churn (" << live << ")");
    CHECK(rig.bank.getNumSamples() <= 4,
          "the bank holds " << rig.bank.getNumSamples() << " slots for " << live
          << " live samples after " << loads.load() << " loads");
}

// ── T3 ───────────────────────────────────────────────────────────────────────

void testUndoRestore()
{
    std::cout << "[T3] unload / restore keeps ids stable\n";
    SampleBank bank;
    const auto a0 = constantBuffer(0.25f);
    const auto b0 = constantBuffer(0.5f);

    const int a = bank.addSampleFromBuffer(a0, kRate, "a");
    CHECK(a >= 0 && bank.getSample(a) != nullptr, "a loads");
    const SampleBank::SampleInfo info = bank.getSampleInfo(a);

    bank.unloadSample(a);
    CHECK(bank.getSample(a) == nullptr, "an unloaded id reads as gone");
    CHECK(bank.getSampleInfo(a).numSamples == 0, "an unloaded id has no info");
    bank.unloadSample(a);   // idempotent
    CHECK(bank.getSample(a) == nullptr, "unloading twice is a no-op");

    const int b = bank.addSampleFromBuffer(b0, kRate, "b");
    CHECK(b >= 0 && b != a, "a new sample never takes an unloaded id (a=" << a << " b=" << b << ")");

    CHECK(bank.restoreSample(a, a0, info), "restoreSample brings the unloaded id back");
    const auto* restored = bank.getSample(a);
    CHECK(restored != nullptr && restored->getSample(0, 100) == 0.25f, "the restored id holds its own audio");
    CHECK(bank.getSampleInfo(a).name == info.name, "the restored id keeps its info");
    const auto* bBuf = bank.getSample(b);
    CHECK(bBuf != nullptr && bBuf->getSample(1, 100) == 0.5f, "restoring a leaves b alone");

    CHECK(!bank.restoreSample(a, b0, info), "restoreSample refuses a live id");
    CHECK(bank.getSample(a)->getSample(0, 100) == 0.25f, "a refused restore changes nothing");
    CHECK(!bank.restoreSample(b + 1000, a0, info), "restoreSample refuses an id never handed out");
    CHECK(!bank.restoreSample(-1, a0, info), "restoreSample refuses a negative id");
}

} // namespace

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << std::unitbuf;
    std::cout << "test_sample_bank_lifetime\n";

    testChurn();
    testUndoRestore();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    return g_failed == 0 ? 0 : 1;
}
