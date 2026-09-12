// test_chain_snapshot_lockfree.cpp — RENDER_PERF_AUDIT Finding 9.
//
// Build: see engine/CMakeLists.txt target "test_chain_snapshot_lockfree"
// Run:   test_chain_snapshot_lockfree.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAIL [<line>] <message>" and exits 1
//
// WHAT THIS GUARDS
//
// MixEngine::processBlock used to take chainsMutex_ with try_lock on the
// realtime path and, when the lock was contended, skip EVERY per-track and
// master effect chain for that block. That is not a dropped optimisation — it
// is a dry block and an audible level jump, and it happened on ~1.9% of blocks
// under ordinary 60 Hz mixer metering and on up to ~94% of blocks while effects
// were being added and removed.
//
// The realtime path now reads an immutable ChainSnapshot published through
// std::atomic<std::shared_ptr>. These tests pin the three properties that has
// to have:
//
//   T1  Under heavy message-thread contention, EVERY realtime block is still
//       processed by the effect chain (no dry blocks), and chainLockMissCount
//       stays at 0.
//   T2  The offline (nonRealtime_) path still blocks on chainsMutex_ and is
//       likewise never skipped — the branch the audit requires be preserved
//       exactly, because an export may never drop an effect chain.
//   T3  A chain destroyed on the message thread while blocks are in flight
//       does not take the audio thread's processors with it: the snapshot's
//       strong references keep them alive, and nothing is freed underneath a
//       block that is mid-render.
//
// The contention in T1/T3 is real: a second thread hammers the same mutators a
// user's mixer drives (parameter writes, chain add/remove, chain teardown)
// while blocks render.

#include "audio/MixEngine.h"
#include "audio/TestGainEffect.h"
#include "model/Timeline.h"
#include "SampleBank.h"
#include "Transport.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <atomic>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <memory>
#include <string>
#include <thread>
#include <vector>

// ─── Test harness ────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                 \
    do {                                                                 \
        if (cond) {                                                      \
            ++g_passed;                                                  \
        } else {                                                         \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";  \
            ++g_failed;                                                  \
        }                                                                \
    } while (0)

// ─── Fixture ─────────────────────────────────────────────────────────────────

static const double kBPM        = 120.0;
static const double kSampleRate = 44100.0;
static constexpr int kBlockSize = 512;

// A gain the chain applies and nothing else does, so "the chain ran" is
// measurable from the output alone. Far enough from 1.0 that no smoother ramp
// or fader could be mistaken for it.
static constexpr float kChainGain = 3.0f;

static juce::File generateSineWav(const juce::File& dir, const juce::String& name,
                                  double sampleRate, int numSamples,
                                  float freq, float amplitude)
{
    juce::AudioBuffer<float> buf(1, numSamples);
    float* data = buf.getWritePointer(0);
    for (int i = 0; i < numSamples; ++i)
    {
        const double t = static_cast<double>(i) / sampleRate;
        data[i] = amplitude * static_cast<float>(
            std::sin(2.0 * juce::MathConstants<double>::pi * freq * t));
    }

    juce::File file = dir.getChildFile(name + ".wav");
    file.deleteFile();

    auto outStream = std::unique_ptr<juce::FileOutputStream>(file.createOutputStream());
    if (outStream == nullptr) return {};

    juce::WavAudioFormat wavFmt;
    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFmt.createWriterFor(outStream.get(), sampleRate, 1, 16, {}, 0));
    if (writer == nullptr) return {};
    outStream.release();

    writer->writeFromAudioSampleBuffer(buf, 0, numSamples);
    writer.reset();
    return file;
}

static float peakOf(const juce::AudioBuffer<float>& buf, int numSamples)
{
    float peak = 0.0f;
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
        for (int i = 0; i < numSamples; ++i)
            peak = std::max(peak, std::abs(buf.getSample(ch, i)));
    return peak;
}

// One continuously-sounding track, so every block has audio to measure.
struct Fixture
{
    juce::File   dir;
    juce::File   wav;
    Timeline     timeline{kBPM, kSampleRate};
    SampleBank   bank;
    int          trackId  = -1;
    int          regionId = -1;
    int          sampleId = -1;
};

static bool buildFixture(Fixture& fx)
{
    fx.dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                 .getChildFile("xleth_test_chain_snapshot");
    fx.dir.createDirectory();

    // 2 s of tone, so a 1 s render never runs off the end of the sample.
    const int sampleLen = static_cast<int>(kSampleRate * 2.0);
    fx.wav = generateSineWav(fx.dir, "tone", kSampleRate, sampleLen, 220.0f, 0.25f);
    if (!fx.wav.existsAsFile()) return false;

    TrackInfo track;
    track.name = "T";
    fx.trackId = fx.timeline.addTrack(track);

    SampleRegion region;
    region.name  = "Tone";
    region.label = SampleLabel::Custom;
    fx.regionId  = fx.timeline.addRegion(region);

    // Back-to-back one-beat clips covering the whole render window.
    for (int beat = 0; beat < 16; ++beat)
    {
        Clip c;
        c.trackId  = fx.trackId;
        c.regionId = fx.regionId;
        c.position = TickTime::fromBeats(static_cast<double>(beat));
        c.duration = TickTime::fromBeats(1.0);
        fx.timeline.addClip(c);
    }

    fx.sampleId = fx.bank.loadSample(fx.wav, kSampleRate);
    return fx.sampleId >= 0;
}

// Wire an engine to the fixture and install the measurable gain on the track.
static bool wireEngine(MixEngine& engine, Fixture& fx)
{
    engine.prepare(kSampleRate, kBlockSize);
    engine.setTimeline(&fx.timeline);
    engine.setSampleBank(&fx.bank);
    engine.mapRegionToSample(fx.regionId, fx.sampleId);
    engine.syncTrackSlotsFromTimeline(true);

    auto gain = std::make_unique<TestGainEffect>();
    gain->setParameterValue("gain", kChainGain);
    const int nodeId = engine.addProcessorForTesting(
        fx.trackId, "testgain", std::move(gain), 0);
    return nodeId >= 0;
}

// ─── Contention: the message-thread traffic that used to steal the lock ──────
//
// Every one of these takes chainsMutex_. The old realtime try_lock lost to them
// often enough to drop ~1 block in 50 during plain metering.
struct Contender
{
    std::atomic<bool>     stop{false};
    std::atomic<uint64_t> ops{0};
    std::thread           thread;

    void start(MixEngine& engine, int trackId, bool includeTeardown)
    {
        thread = std::thread([this, &engine, trackId, includeTeardown]() {
            int spin = 0;
            while (!stop.load(std::memory_order_relaxed))
            {
                // Metering + parameter reads/writes: short holds, high rate.
                (void)engine.getEffectChainState(trackId);
                (void)engine.getEffectChainState(-1);

                // Chain edits: long holds, the ones that produced a 94% miss
                // rate on the old path.
                auto scratch = std::make_unique<TestGainEffect>();
                const int extra = engine.addProcessorForTesting(
                    trackId, "testgain", std::move(scratch), 0);
                if (extra >= 0)
                    (void)engine.removeEffect(trackId, extra);

                if (includeTeardown && (++spin % 8) == 0)
                {
                    // Full teardown/rebuild of a DIFFERENT track's chain, so the
                    // snapshot really does gain and lose chains mid-render.
                    auto other = std::make_unique<TestGainEffect>();
                    const int otherNode = engine.addProcessorForTesting(
                        9999, "testgain", std::move(other), 0);
                    if (otherNode >= 0)
                        engine.destroyEffectChain(9999);
                }

                ops.fetch_add(1, std::memory_order_relaxed);
            }
        });
    }

    void join()
    {
        stop.store(true, std::memory_order_relaxed);
        if (thread.joinable()) thread.join();
    }
};

// Render `blocks` blocks, returning the number that came out DRY — i.e. whose
// peak is consistent with the chain not having run. Silence is not counted
// either way; it is not evidence about the chain.
struct RenderResult
{
    int blocks     = 0;
    int wetBlocks  = 0;
    int dryBlocks  = 0;
    int silent     = 0;
};

static RenderResult renderAndClassify(MixEngine& engine, Transport& transport, int blocks)
{
    RenderResult r;

    // The dry peak is whatever the track produces without the chain; the wet
    // peak is that times kChainGain. Anything at or below the midpoint between
    // them counts as dry. The sample peaks at 0.25 and the chain triples it,
    // so the two populations are nowhere near each other.
    const float kDryCeiling = 0.25f * (1.0f + kChainGain) * 0.5f;
    const float kSilence    = 1.0e-4f;

    juce::AudioBuffer<float> block(2, kBlockSize);
    transport.seekToSample(0);
    transport.play();

    for (int b = 0; b < blocks; ++b)
    {
        block.clear();
        engine.processBlock(block, kBlockSize, transport);
        transport.advance(kBlockSize);

        const float peak = peakOf(block, kBlockSize);
        ++r.blocks;
        if (peak < kSilence)            ++r.silent;
        else if (peak <= kDryCeiling)   ++r.dryBlocks;
        else                            ++r.wetBlocks;
    }

    transport.pause();
    return r;
}

// ─── T1: realtime blocks are never dropped under contention ──────────────────

static void testRealtimeNeverSkipsUnderContention(Fixture& fx)
{
    std::cout << "[1] realtime: chain runs on every block while the message "
                 "thread hammers chainsMutex_\n";

    // sizeof(MixEngine) is large enough to blow the stack — see the same note
    // in test_mixer_bus_routing.cpp. Heap-allocate it.
    auto enginePtr = std::make_unique<MixEngine>();
    MixEngine& engine = *enginePtr;
    if (!wireEngine(engine, fx))
    {
        CHECK(false, "could not install the test gain on the track chain");
        return;
    }
    engine.setRealtimeDiagnosticsEnabled(true);
    engine.resetRealtimeDiagnostics();

    Transport transport;
    transport.setSampleRate(kSampleRate);
    transport.setBPM(kBPM);

    Contender contender;
    contender.start(engine, fx.trackId, /*includeTeardown=*/false);

    const RenderResult r = renderAndClassify(engine, transport, 400);

    contender.join();

    std::cout << "    blocks=" << r.blocks
              << " wet=" << r.wetBlocks
              << " dry=" << r.dryBlocks
              << " silent=" << r.silent
              << " contentionOps=" << contender.ops.load()
              << " chainLockMiss=" << engine.getChainLockMissCount() << "\n";

    // The contention has to have been real, or the test proves nothing.
    CHECK(contender.ops.load() > 50,
          "contention thread should have completed many mutator rounds "
          "(got " + std::to_string(contender.ops.load()) + ")");
    CHECK(r.wetBlocks > 0, "at least some blocks should carry audio");
    CHECK(r.dryBlocks == 0,
          "NO block may be dry: a skipped chain is an audible level jump "
          "(got " + std::to_string(r.dryBlocks) + " dry of "
          + std::to_string(r.blocks) + ")");
    CHECK(engine.getChainLockMissCount() == 0,
          "chainLockMissCount must stay 0 — the realtime path no longer takes "
          "chainsMutex_ (got "
          + std::to_string(engine.getChainLockMissCount()) + ")");
}

// ─── T2: the offline branch still blocks and still never skips ───────────────

static void testOfflineStillBlocksAndNeverSkips(Fixture& fx)
{
    std::cout << "[2] offline: nonRealtime_ path still blocks on chainsMutex_ "
                 "and drops nothing\n";

    // sizeof(MixEngine) is large enough to blow the stack — see the same note
    // in test_mixer_bus_routing.cpp. Heap-allocate it.
    auto enginePtr = std::make_unique<MixEngine>();
    MixEngine& engine = *enginePtr;
    if (!wireEngine(engine, fx))
    {
        CHECK(false, "could not install the test gain on the track chain");
        return;
    }
    engine.setRealtimeDiagnosticsEnabled(true);
    engine.resetRealtimeDiagnostics();
    engine.setNonRealtime(true);

    Transport transport;
    transport.setSampleRate(kSampleRate);
    transport.setBPM(kBPM);

    Contender contender;
    contender.start(engine, fx.trackId, /*includeTeardown=*/false);

    const RenderResult r = renderAndClassify(engine, transport, 200);

    contender.join();
    engine.setNonRealtime(false);

    std::cout << "    blocks=" << r.blocks
              << " wet=" << r.wetBlocks
              << " dry=" << r.dryBlocks
              << " silent=" << r.silent
              << " contentionOps=" << contender.ops.load() << "\n";

    CHECK(r.wetBlocks > 0, "offline render should carry audio");
    CHECK(r.dryBlocks == 0,
          "an offline render may NEVER skip an effect chain (got "
          + std::to_string(r.dryBlocks) + " dry of "
          + std::to_string(r.blocks) + ")");
}

// ─── T3: chains destroyed mid-render do not take the audio thread with them ──

static void testChainTeardownDuringRenderIsSafe(Fixture& fx)
{
    std::cout << "[3] chains created and destroyed mid-render stay alive for "
                 "the block that is using them\n";

    // sizeof(MixEngine) is large enough to blow the stack — see the same note
    // in test_mixer_bus_routing.cpp. Heap-allocate it.
    auto enginePtr = std::make_unique<MixEngine>();
    MixEngine& engine = *enginePtr;
    if (!wireEngine(engine, fx))
    {
        CHECK(false, "could not install the test gain on the track chain");
        return;
    }
    engine.setRealtimeDiagnosticsEnabled(true);
    engine.resetRealtimeDiagnostics();

    Transport transport;
    transport.setSampleRate(kSampleRate);
    transport.setBPM(kBPM);

    Contender contender;
    contender.start(engine, fx.trackId, /*includeTeardown=*/true);

    const RenderResult r = renderAndClassify(engine, transport, 400);

    contender.join();

    std::cout << "    blocks=" << r.blocks
              << " wet=" << r.wetBlocks
              << " dry=" << r.dryBlocks
              << " contentionOps=" << contender.ops.load()
              << " chainLockMiss=" << engine.getChainLockMissCount() << "\n";

    // Reaching here at all is most of the point: a use-after-free would have
    // crashed the process. The assertions below cover the rest.
    CHECK(contender.ops.load() > 50,
          "teardown thread should have completed many rounds");
    CHECK(r.blocks == 400, "every block should have completed");
    CHECK(r.dryBlocks == 0,
          "the measured track's chain must survive churn on other tracks (got "
          + std::to_string(r.dryBlocks) + " dry)");
    CHECK(engine.getChainLockMissCount() == 0,
          "chainLockMissCount must stay 0 even through chain teardown");
}

// ─── main ────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "\n=== Finding 9: lock-free effect-chain snapshot ===\n\n";

    Fixture fx;
    if (!buildFixture(fx))
    {
        std::cerr << "FAILED: could not build the audio fixture\n";
        return 1;
    }

    testRealtimeNeverSkipsUnderContention(fx);
    testOfflineStillBlocksAndNeverSkips(fx);
    testChainTeardownDuringRenderIsSafe(fx);

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0)
    {
        std::cerr << "FAILED: " << g_failed << " check(s)\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
