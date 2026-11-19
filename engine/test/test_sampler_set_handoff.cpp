// test_sampler_set_handoff.cpp -- sampler lifetime and note events across the
// main-thread / audio-thread boundary.
//
// The bridge thread used to edit MixEngine's sampler maps in place and call
// noteOn/noteOff/allNotesOff directly, while the audio callback was rendering
// from the same maps and the same voices. A sampler knob during playback
// destroyed every sampler in the project under the callback.
//
// Now the samplers are one immutable snapshot (RtPublished) and everything the
// main thread wants done to a voice is a queued event (SpscRing). This covers:
//
//   T1  RtPublished: a superseded snapshot is parked while a reader holds it,
//       freed once it lets go, and drain() gives up at its deadline rather
//       than free it early.
//   T2  SpscRing: capacity, FIFO order, full/empty.
//   T3  Preview note events land at the next block, in order; a lost note-off
//       releases everything rather than leave a note stuck.
//   T4  A region-scoped rebuild leaves other regions' samplers (and voices)
//       alone, unless their audio was remapped since.
//   T5  Churn: one thread rebuilds, replaces and plays samplers as fast as it
//       can while the other renders blocks. Before the fix this is a
//       use-after-free on every iteration.
//
// Blocks render on the MAIN thread (it has the big stack processBlock wants);
// the second thread plays the bridge's role.
//
// Build: cmake --build build --target test_sampler_set_handoff --config Release
// Run:   ctest --test-dir build -C Release -R "^test_sampler_set_handoff$" -V

#include "audio/MixEngine.h"
#include "model/Timeline.h"
#include "SampleBank.h"
#include "Transport.h"
#include "util/RtPublished.h"
#include "util/SpscRing.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <iostream>
#include <memory>
#include <random>
#include <thread>

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

// ── T1 ───────────────────────────────────────────────────────────────────────

struct Tracked
{
    static inline int alive = 0;
    int value;
    explicit Tracked(int v) : value(v) { ++alive; }
    ~Tracked() { --alive; }
};

void testRtPublished()
{
    std::cout << "[T1] RtPublished parks, frees and never force-frees\n";
    {
        xleth::util::RtPublished<Tracked> pub { std::make_shared<const Tracked>(1) };

        auto held = pub.load();                              // a block in flight
        pub.publish(std::make_shared<const Tracked>(2));
        CHECK(held->value == 1 && pub.load()->value == 2, "reader keeps its snapshot, new readers get the new one");
        CHECK(pub.retiredCount() == 1 && Tracked::alive == 2, "superseded snapshot is parked, not freed");

        CHECK(!pub.drain(20), "drain gives up at its deadline while a reader holds on");
        CHECK(pub.retiredCount() == 1 && Tracked::alive == 2, "and frees nothing when it gives up");

        held.reset();
        CHECK(Tracked::alive == 2, "the reader letting go frees nothing (the retire list still owns it)");
        CHECK(pub.drain(20), "drain succeeds once the reader is done");
        CHECK(pub.retiredCount() == 0 && Tracked::alive == 1, "then the writer frees it");

        // No reader: a publish reclaims the old snapshot on the spot.
        pub.publish(std::make_shared<const Tracked>(3));
        CHECK(pub.retiredCount() == 0 && Tracked::alive == 1, "unheld snapshot is freed by the publish itself");
    }
    CHECK(Tracked::alive == 0, "nothing leaks");
}

// ── T2 ───────────────────────────────────────────────────────────────────────

void testSpscRing()
{
    std::cout << "[T2] SpscRing capacity and order\n";
    xleth::util::SpscRing<int> ring(8);
    int pushed = 0;
    while (ring.push(pushed)) ++pushed;
    CHECK(pushed == 7, "a ring of 8 holds 7 (got " << pushed << ")");

    bool ordered = true;
    int v = -1, popped = 0;
    while (ring.pop(v)) { ordered = ordered && (v == popped); ++popped; }
    CHECK(popped == 7 && ordered, "pops everything in push order");
    CHECK(!ring.pop(v), "empty ring pops nothing");
    CHECK(ring.push(42) && ring.pop(v) && v == 42, "usable again after wrapping");
}

// ── Rig: two pattern tracks, one region each, looping notes ─────────────────

struct Rig
{
    Timeline   timeline { kBpm, kRate, 4, 4 };
    SampleBank bank;
    std::unique_ptr<MixEngine> engine;
    Transport  transport;
    int trackA = -1, trackB = -1, regionA = -1, regionB = -1;
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

        addInstrument("A", trackA, regionA);
        addInstrument("B", trackB, regionB);

        engine->rebuildAllSamplers();
        engine->prepare(kRate, kBlock);

        transport.setSampleRate(kRate);
        transport.setBPM(kBpm);
    }

    void addInstrument(const char* name, int& trackId, int& regionId)
    {
        SampleRegion region{};
        region.name = name;
        region.slot(0).rootNote = kRoot;
        region.crossfadeEnabled = true;                    // sustained: note-off releases
        region.modulation.envs[0].release.ms = 5.0f;
        regionId = timeline.addRegion(region);

        TrackInfo t{};
        t.name = name;
        t.type = TrackInfo::Type::Pattern;
        t.volume = 1.0f;
        trackId = timeline.addTrack(t);

        // One bar, a held note on every beat, looping for a very long block.
        Pattern p{};
        p.name = name;
        p.regionId = regionId;
        p.length = TickTime::fromBeats(4.0);
        int id = 1;
        for (int beat = 0; beat < 4; ++beat)
        {
            PatternNote note{};
            note.id = id++;
            note.position = TickTime::fromBeats(beat);
            note.duration = TickTime::fromBeats(0.9);
            note.pitch = kRoot + beat;
            note.velocity = 1.0f;
            p.notes.push_back(note);
        }
        p.nextNoteId = id;
        const int patternId = timeline.addPattern(p);

        PatternBlock b{};
        b.trackId = trackId;
        b.patternId = patternId;
        b.position = TickTime{0};
        b.duration = TickTime::fromBeats(400000.0);
        b.loopEnabled = true;
        timeline.addPatternBlock(b);

        engine->mapRegionToSample(regionId, bank.addSampleFromBuffer(sine, kRate, name));
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
};

// ── T3 ───────────────────────────────────────────────────────────────────────

void testPreviewEvents()
{
    std::cout << "[T3] preview note events land at the next block\n";
    Rig rig;                                   // transport stopped: audition path
    MixEngine& e = *rig.engine;

    e.ensurePreviewSampler(rig.regionA);
    Sampler* pv = e.getPreviewSamplerPtr(rig.regionA);
    CHECK(pv != nullptr, "preview sampler exists");
    if (pv == nullptr) return;

    e.previewNoteOn(rig.regionA, kRoot, 1.0f);
    CHECK(pv->countHeldVoices() == 0, "note-on is queued, not applied on the calling thread");
    CHECK(rig.block() > 1.0e-3f, "the next block plays it");
    CHECK(pv->countHeldVoices() == 1, "one held voice after the block");

    e.previewNoteOff(rig.regionA, kRoot);
    rig.block();
    CHECK(pv->countHeldVoices() == 0, "note-off releases it at the next block");

    e.previewNoteOn(rig.regionA, kRoot, 1.0f);
    rig.block();
    e.silenceAllSamplers();
    CHECK(pv->countHeldVoices() == 1, "silenceAllSamplers is queued too");
    rig.block();
    CHECK(pv->countHeldVoices() == 0, "and releases everything at the next block");

    // Stop, then a key, inside one block: the key must survive the stop.
    e.silenceAllSamplers();
    e.previewNoteOn(rig.regionA, kRoot + 2, 1.0f);
    rig.block();
    CHECK(pv->countHeldVoices() == 1, "events apply in arrival order");

    e.previewNoteOn(987654, kRoot, 1.0f);      // no such region
    CHECK(rig.block() >= 0.0f, "an event for a missing preview sampler is dropped");

    // A sampler published and then played in the same breath is found.
    e.ensurePreviewSampler(rig.regionB);
    e.previewNoteOn(rig.regionB, kRoot, 1.0f);
    rig.block();
    Sampler* pvB = e.getPreviewSamplerPtr(rig.regionB);
    CHECK(pvB != nullptr && pvB->countHeldVoices() == 1, "note for a just-published sampler plays");

    // Overflow: far more note-offs (for a pitch nobody holds) than the ring
    // takes. The ones that do not fit must still end in "release everything".
    CHECK(pv->countHeldVoices() == 1, "a note is still held before the flood");
    for (int i = 0; i < 600; ++i) e.previewNoteOff(rig.regionA, 1);
    rig.block();
    CHECK(pv->countHeldVoices() == 0 && pvB->countHeldVoices() == 0,
          "a lost note-off releases every voice instead of sticking");
}

// ── T4 ───────────────────────────────────────────────────────────────────────

void testRegionScopedRebuild()
{
    std::cout << "[T4] a region-scoped rebuild leaves other regions playing\n";
    Rig rig;
    MixEngine& e = *rig.engine;

    rig.transport.play();
    for (int i = 0; i < 8; ++i) rig.block();

    Sampler* a0 = e.getSamplerPtr(rig.trackA, rig.regionA);
    Sampler* b0 = e.getSamplerPtr(rig.trackB, rig.regionB);
    CHECK(a0 != nullptr && b0 != nullptr, "both playback samplers exist");
    if (a0 == nullptr || b0 == nullptr) return;
    CHECK(a0->activeVoiceCount() > 0 && b0->activeVoiceCount() > 0, "both are sounding");

    e.rebuildAllSamplers(rig.regionA);
    Sampler* a1 = e.getSamplerPtr(rig.trackA, rig.regionA);
    Sampler* b1 = e.getSamplerPtr(rig.trackB, rig.regionB);
    CHECK(a1 != nullptr && a1 != a0, "the edited region's sampler is rebuilt");
    CHECK(b1 == b0 && b1->activeVoiceCount() > 0, "the other region's sampler and its voices carry over");

    // Remap B's audio without telling the samplers (what audio_loadRegionAudio does).
    e.mapRegionToSample(rig.regionB, rig.bank.addSampleFromBuffer(rig.sine, kRate, "B2"));
    e.rebuildAllSamplers(rig.regionA);
    Sampler* b2 = e.getSamplerPtr(rig.trackB, rig.regionB);
    CHECK(b2 != nullptr && b2 != b1, "a remapped region is rebuilt even by another region's edit");

    Sampler* a2 = e.getSamplerPtr(rig.trackA, rig.regionA);
    e.rebuildAllSamplers();
    CHECK(e.getSamplerPtr(rig.trackA, rig.regionA) != a2
          && e.getSamplerPtr(rig.trackB, rig.regionB) != b2, "an unscoped rebuild reloads every sampler");

    for (int i = 0; i < 60; ++i) rig.block();      // past the next beat's note-on
    CHECK(e.getSamplerPtr(rig.trackA, rig.regionA)->activeVoiceCount() > 0, "playback resumes on the new samplers");

    // ── Staleness: what each sampler was built from ──────────────────────────
    Sampler* a3 = e.getSamplerPtr(rig.trackA, rig.regionA);
    Sampler* b3 = e.getSamplerPtr(rig.trackB, rig.regionB);
    e.refreshStaleSamplers();
    CHECK(e.getSamplerPtr(rig.trackA, rig.regionA) == a3 && e.getSamplerPtr(rig.trackB, rig.regionB) == b3,
          "a stale-only refresh rebuilds nothing when nothing changed");

    // B's settings change behind the engine's back (a handler that forgot to
    // refresh). A's region-scoped rebuild must still pick B up.
    rig.timeline.getRegionMutable(rig.regionB)->voiceCount = 4;
    e.rebuildAllSamplers(rig.regionA);
    Sampler* b4 = e.getSamplerPtr(rig.trackB, rig.regionB);
    CHECK(b4 != nullptr && b4 != b3, "a region whose settings changed is rebuilt by another region's edit");
    {
        bool found = false, anyStale = false;
        const nlohmann::json described = e.describeSamplers();
        for (const auto& entry : described["playback"]) {
            anyStale = anyStale || entry["stale"].get<bool>();
            if (entry["regionId"] == rig.regionB) {
                found = true;
                CHECK(entry["builtFrom"]["voiceCount"] == 4, "the record shows the setting the sampler was built with");
            }
        }
        CHECK(found && !anyStale, "describeSamplers lists B and nothing is stale");
    }

    // A preview sampler goes stale the same way, and any rebuild replaces it.
    e.ensurePreviewSampler(rig.regionB);
    Sampler* pv0 = e.getPreviewSamplerPtr(rig.regionB);
    rig.timeline.getRegionMutable(rig.regionB)->monoEnabled = true;
    CHECK(e.describeSamplers()["preview"][0]["stale"] == true, "an out-of-date preview sampler reports stale");
    e.rebuildAllSamplers();                          // what undo / redo call
    CHECK(pv0 != nullptr && e.getPreviewSamplerPtr(rig.regionB) != nullptr
          && e.getPreviewSamplerPtr(rig.regionB) != pv0, "a full rebuild replaces a stale preview sampler");
    Sampler* pv1 = e.getPreviewSamplerPtr(rig.regionB);
    e.rebuildAllSamplers();
    CHECK(e.getPreviewSamplerPtr(rig.regionB) == pv1, "and leaves an up-to-date one alone");

    // A deleted region: its playback pair and its preview sampler both go.
    Sampler* a5 = e.getSamplerPtr(rig.trackA, rig.regionA);
    rig.timeline.removeRegion(rig.regionB);
    e.refreshStaleSamplers();
    CHECK(e.getSamplerPtr(rig.trackB, rig.regionB) == nullptr && !e.hasPreviewSampler(rig.regionB),
          "samplers of a deleted region are dropped");
    CHECK(e.getSamplerPtr(rig.trackA, rig.regionA) == a5, "and the other region is untouched");
    CHECK(rig.block() >= 0.0f, "rendering continues with the region gone");
}

// ── T5 ───────────────────────────────────────────────────────────────────────

void testChurn()
{
    std::cout << "[T5] rebuild / replace / play churn against a rendering thread\n";
    Rig rig;
    MixEngine& e = *rig.engine;
    rig.transport.play();
    for (int i = 0; i < 4; ++i) rig.block();

    constexpr int kIterations = 12000;
    std::atomic<bool> done { false };

    std::thread bridge([&] {
        std::mt19937 rng(4321);
        std::uniform_int_distribution<int> jitterUs(0, 150);
        for (int it = 0; it < kIterations; ++it)
        {
            switch (it % 6)
            {
                case 0: e.rebuildAllSamplers(rig.regionA); break;      // a sampler knob
                case 1: e.ensurePreviewSampler(rig.regionA);
                        e.previewNoteOn(rig.regionA, kRoot + it % 12, 0.5f); break;
                case 2: e.rebuildAllSamplers(); break;                  // undo / redo
                case 3: e.previewNoteOff(rig.regionA, kRoot + (it - 2) % 12);
                        e.silenceAllSamplers(); break;                  // Stop
                case 4: e.unloadSamplersForTrack(rig.trackB);
                        e.loadSamplerForTrackRegion(rig.trackB, rig.regionB); break;
                case 5: e.unloadPreviewSampler(rig.regionA);
                        e.reclaimRetiredSamplers(); break;              // the bridge poll
            }
            const auto until = std::chrono::steady_clock::now()
                             + std::chrono::microseconds(jitterUs(rng));
            while (std::chrono::steady_clock::now() < until) {}
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
        ++blocks;
    }
    bridge.join();

    CHECK(bad == 0, bad << " of " << blocks << " blocks held garbage");
    CHECK(audible > 0, "audio was actually rendered during the churn");

    // Quiet down and confirm the engine is still sane afterwards.
    e.rebuildAllSamplers();
    Sampler* a = e.getSamplerPtr(rig.trackA, rig.regionA);
    bool sawVoices = false;
    for (int i = 0; i < 200 && a != nullptr; ++i)   // more than a bar: a note-on is certain
    {
        rig.block();
        sawVoices = sawVoices || a->activeVoiceCount() > 0;
    }
    CHECK(sawVoices, "playback survives the churn");

    std::cout << "  blocks=" << blocks << " audible=" << audible << "\n";
}

} // namespace

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << std::unitbuf;
    std::cout << "test_sampler_set_handoff\n";

    testRtPublished();
    testSpscRing();
    testPreviewEvents();
    testRegionScopedRebuild();
    testChurn();

    std::cout << (g_failed == 0 ? "PASS" : "FAIL")
              << " (" << g_passed << " passed, " << g_failed << " failed)\n";
    return g_failed == 0 ? 0 : 1;
}
