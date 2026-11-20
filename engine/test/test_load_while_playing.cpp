// test_load_while_playing.cpp -- a clip whose region is mapped AFTER the
// timeline that holds it was published must still play.
//
// project_load (XlethEngineService) publishes the loaded timeline first
// (setTimeline), then clears the region -> sample map and decodes every
// region, mapping each one as it lands. With the transport rolling, the first
// block after the publish rescans every clip, finds the region unmapped, skips
// the clip and moves the scan cursor past it. From then on only clips already
// active or newly crossing the cursor were retried, so the loaded project
// stayed silent until a seek (Stop + Play) forced a rescan.
//
//   T1  Load while playing: replace the timeline, clear the map, render a few
//       "decoding" blocks, map the region -> audio within a few blocks.
//   T2  The same race on one edit: a clip added under the playhead whose
//       region is decoded a moment later plays once it is mapped.
//
// Build: cmake --build build --target test_load_while_playing --config Release
// Run:   ctest --test-dir build -C Release -R "^test_load_while_playing$" -V

#include "audio/MixEngine.h"
#include "model/Timeline.h"
#include "SampleBank.h"
#include "Transport.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <cmath>
#include <iostream>
#include <memory>

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

juce::AudioBuffer<float> makeSine(double hz)
{
    const int n = static_cast<int>(kRate * 20.0);
    juce::AudioBuffer<float> b(1, n);
    for (int i = 0; i < n; ++i)
        b.setSample(0, i, static_cast<float>(
            0.1 * std::sin(2.0 * juce::MathConstants<double>::pi * hz * i / kRate)));
    return b;
}

// One clip track, one region, one clip from beat 0 to beat 32 (16 s).
struct Project
{
    int track = -1, region = -1;
};

Project fill(Timeline& tl)
{
    Project p;
    SampleRegion r{};
    r.name = "tone";
    p.region = tl.addRegion(r);

    TrackInfo t{};
    t.name = "T";
    t.type = TrackInfo::Type::Clip;
    t.volume = 1.0f;
    p.track = tl.addTrack(t);

    Clip c{};
    c.trackId = p.track;
    c.regionId = p.region;
    c.position = TickTime::fromBeats(0.0);
    c.duration = TickTime::fromBeats(32.0);
    c.velocity = 1.0f;
    tl.addClip(c);
    return p;
}

struct Rig
{
    Timeline   timeline { kBpm, kRate, 4, 4 };
    SampleBank bank;
    std::unique_ptr<MixEngine> engine;
    Transport  transport;
    juce::AudioBuffer<float> sine = makeSine(440.0);

    Rig()
    {
        engine = std::make_unique<MixEngine>();
        engine->setTimeline(&timeline);
        engine->setSampleBank(&bank);
        engine->prepare(kRate, kBlock);
        transport.setSampleRate(kRate);
        transport.setBPM(kBpm);
    }

    float block()
    {
        juce::AudioBuffer<float> buf(2, kBlock);
        buf.clear();
        engine->processBlock(buf, kBlock, transport);
        transport.advance(kBlock);
        return std::max(buf.getMagnitude(0, 0, kBlock), buf.getMagnitude(1, 0, kBlock));
    }

    float loudest(int blocks)
    {
        float peak = 0.0f;
        for (int i = 0; i < blocks; ++i) peak = std::max(peak, block());
        return peak;
    }
};

void testLoadWhilePlaying()
{
    std::cout << "[T1] project load while playing\n";
    Rig rig;
    const Project before = fill(rig.timeline);
    rig.engine->mapRegionToSample(before.region, rig.bank.addSampleFromBuffer(rig.sine, kRate, "a"));
    rig.engine->refreshTimelineSnapshot();
    rig.transport.play();

    const float playing = rig.loudest(20);
    CHECK(playing > 0.05f, "the first project plays (peak " << playing << ")");

    // What Project_Load does, in its order.
    Timeline loaded { kBpm, kRate, 4, 4 };
    const Project after = fill(loaded);
    rig.timeline = std::move(loaded);
    rig.engine->setTimeline(&rig.timeline);
    rig.engine->clearRegionToSampleMap();
    // The ordering that causes the bug, forced rather than raced: these blocks
    // are the audio thread's full scan of the PUBLISHED timeline while its region
    // has no audio. Silence proves the scan ran and skipped the clip; only then
    // does the region get its sample.
    const float decoding = rig.loudest(4);
    CHECK(decoding == 0.0f, "the new timeline was scanned while its region was unmapped (peak " << decoding << ")");
    rig.engine->mapRegionToSample(after.region, rig.bank.addSampleFromBuffer(rig.sine, kRate, "b"));

    const float afterLoad = rig.loudest(4);
    CHECK(rig.transport.isPlaying(), "the transport is still playing");
    CHECK(afterLoad > 0.05f, "the loaded project is heard within 4 blocks of its region being mapped (peak "
                             << afterLoad << ")");
}

void testClipMappedAfterAdd()
{
    std::cout << "[T2] clip added under the playhead, region mapped later\n";
    Rig rig;
    rig.transport.play();
    rig.loudest(20);                                  // the playhead is past the clip's start

    const Project p = fill(rig.timeline);
    rig.engine->refreshTimelineSnapshot();            // the add command's publish
    const float unmapped = rig.loudest(4);
    CHECK(unmapped == 0.0f, "nothing plays before the region has audio (peak " << unmapped << ")");

    rig.engine->mapRegionToSample(p.region, rig.bank.addSampleFromBuffer(rig.sine, kRate, "c"));
    const float mapped = rig.loudest(4);
    CHECK(mapped > 0.05f, "the clip is heard within 4 blocks of its region being mapped (peak " << mapped << ")");
}

} // namespace

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << std::unitbuf;
    std::cout << "test_load_while_playing\n";

    testLoadWhilePlaying();
    testClipMappedAfterAdd();

    std::cout << (g_failed == 0 ? "PASS" : "FAIL")
              << " (" << g_passed << " passed, " << g_failed << " failed)\n";
    return g_failed == 0 ? 0 : 1;
}
