// test_mixer_bus_routing.cpp — Prompt 2B: audible output-route bus summing in
// MixEngine::processBlock. Verifies that a track routed to another track feeds
// that target as a bus, is NOT also summed directly to Master, that bus
// processing is independent of timeline track order, that buses with no clips
// of their own still process routed input, nested routes work, and route-aware
// mute/solo behaves per the Prompt 2B policy.
//
// Build: see engine/CMakeLists.txt target "test_mixer_bus_routing"
// Run:   test_mixer_bus_routing.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1
//
// NOTE: sizeof(MixEngine) is large, so each MixEngine is constructed inside the
// renderProject() helper — one per call frame — never two in a single test
// function's stack frame (that would overflow even an 8 MB stack in Debug).

#include "audio/MixEngine.h"
#include "model/Timeline.h"
#include "SampleBank.h"
#include "Transport.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <cmath>
#include <initializer_list>
#include <iostream>
#include <string>
#include <utility>

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

// ─── Synthetic sample generation ─────────────────────────────────────────────

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

// ─── Energy / windowed measurement ───────────────────────────────────────────

static double totalEnergy(const juce::AudioBuffer<float>& buf)
{
    double e = 0.0;
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
        for (int i = 0; i < buf.getNumSamples(); ++i)
        {
            const double s = buf.getSample(ch, i);
            e += s * s;
        }
    return e;
}

static float peakInWindow(const juce::AudioBuffer<float>& buf,
                          int startSample, int lenSamples)
{
    const int end = std::min(buf.getNumSamples(), startSample + lenSamples);
    float peak = 0.0f;
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
        for (int i = std::max(0, startSample); i < end; ++i)
            peak = std::max(peak, std::abs(buf.getSample(ch, i)));
    return peak;
}

// ─── Render config ───────────────────────────────────────────────────────────

static const double kBPM = 120.0;
// At 120 BPM / 44100, one beat = 22050 samples.
static constexpr int kBeatSamples = 22050;
static constexpr int kRenderSamples = kBeatSamples * 4; // 4 beats

// ─── Offline render ──────────────────────────────────────────────────────────

static juce::AudioBuffer<float> offlineRender(MixEngine& engine, Transport& transport,
                                              int totalSamples, int blockSize = 512)
{
    juce::AudioBuffer<float> output(2, totalSamples);
    output.clear();

    transport.seekToSample(0);
    transport.play();

    int pos = 0;
    while (pos < totalSamples)
    {
        const int n = std::min(blockSize, totalSamples - pos);
        juce::AudioBuffer<float> block(2, n);
        block.clear();
        engine.processBlock(block, n, transport);
        for (int ch = 0; ch < 2; ++ch)
            output.copyFrom(ch, pos, block, ch, 0, n);
        transport.advance(n);
        pos += n;
    }

    transport.pause();
    return output;
}

// Construct ONE MixEngine (heavy object) in this call's frame, wire it to the
// timeline/bank, snap fader smoothers, and render `totalSamples` offline.
static juce::AudioBuffer<float> renderProject(
    Timeline& tl, SampleBank& bank,
    std::initializer_list<std::pair<int,int>> regionToSample,
    double sampleRate, int totalSamples)
{
    MixEngine engine;
    engine.prepare(sampleRate, 512);
    engine.setTimeline(&tl);
    engine.setSampleBank(&bank);
    for (const auto& rs : regionToSample)
        engine.mapRegionToSample(rs.first, rs.second);
    engine.syncTrackSlotsFromTimeline(true);

    Transport t;
    t.setSampleRate(sampleRate);
    t.setBPM(kBPM);
    return offlineRender(engine, t, totalSamples);
}

// ─── Shared sample fixture ───────────────────────────────────────────────────
// Three distinct sine samples (kick @ 80 Hz, snare @ 300 Hz, lead @ 1000 Hz),
// each ~80 ms, generated once and shared across scenarios.

struct SampleSet
{
    juce::File dir;
    juce::File kickWav, snareWav, leadWav;
    double sampleRate = 44100.0;
    int    sampleLen  = 0;
};

static SampleSet makeSamples()
{
    SampleSet ss;
    ss.dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                 .getChildFile("xleth_test_bus_routing");
    ss.dir.createDirectory();
    ss.sampleLen = static_cast<int>(ss.sampleRate * 0.08);
    ss.kickWav  = generateSineWav(ss.dir, "kick",  ss.sampleRate, ss.sampleLen,   80.0f, 0.5f);
    ss.snareWav = generateSineWav(ss.dir, "snare", ss.sampleRate, ss.sampleLen,  300.0f, 0.5f);
    ss.leadWav  = generateSineWav(ss.dir, "lead",  ss.sampleRate, ss.sampleLen, 1000.0f, 0.5f);
    return ss;
}

// Add a one-beat clip at `beat` on `trackId` referencing `regionId`.
static void addBeatClip(Timeline& tl, int trackId, int regionId, double beat)
{
    Clip c;
    c.trackId = trackId;
    c.regionId = regionId;
    c.position = TickTime::fromBeats(beat);
    c.duration = TickTime::fromBeats(1.0);
    tl.addClip(c);
}

// ─── T1: single source routed through an empty bus is heard exactly once ─────

static void testHeardOnceNotTwice(const SampleSet& ss)
{
    std::cout << "[1] Kick → DrumBus → Master: heard once, no direct-to-Master duplicate\n";

    // Direct: Kick → Master (no routing).
    double eDirect = 0.0;
    {
        Timeline tl(kBPM, ss.sampleRate);
        TrackInfo kick; kick.name = "Kick";
        TrackInfo bus;  bus.name  = "DrumBus";
        int kickId = tl.addTrack(kick);
        (void)tl.addTrack(bus);
        SampleRegion kr; kr.name = "Kick"; kr.label = SampleLabel::Custom;
        int kickReg = tl.addRegion(kr);
        addBeatClip(tl, kickId, kickReg, 0.0);

        SampleBank bank;
        int sid = bank.loadSample(ss.kickWav, ss.sampleRate);
        auto out = renderProject(tl, bank, {{kickReg, sid}}, ss.sampleRate, kRenderSamples);
        eDirect = totalEnergy(out);
        CHECK(eDirect > 1.0, "direct Kick→Master is not silent");
    }

    // Bus: Kick → DrumBus → Master (bus has no clips of its own).
    double eBus = 0.0;
    {
        Timeline tl(kBPM, ss.sampleRate);
        TrackInfo kick; kick.name = "Kick";
        TrackInfo bus;  bus.name  = "DrumBus";
        int kickId = tl.addTrack(kick);
        int busId  = tl.addTrack(bus);
        SampleRegion kr; kr.name = "Kick"; kr.label = SampleLabel::Custom;
        int kickReg = tl.addRegion(kr);
        addBeatClip(tl, kickId, kickReg, 0.0);
        CHECK(tl.setTrackOutputRoute(kickId, busId).ok(), "Kick→DrumBus route valid");

        SampleBank bank;
        int sid = bank.loadSample(ss.kickWav, ss.sampleRate);
        auto out = renderProject(tl, bank, {{kickReg, sid}}, ss.sampleRate, kRenderSamples);
        eBus = totalEnergy(out);
        CHECK(eBus > 1.0, "bus-with-no-clips still passes routed input (not silent)");
    }

    // The routed path passes through the bus track's own center-pan stage
    // (constant-power, −3 dB ⇒ ×0.707 per channel), so its energy is ~0.5× the
    // direct path (which has a single center-pan stage). The point of this test
    // is the upper bound: if the source ALSO summed directly to Master (the bug
    // 2B forbids), the in-phase duplicate would push energy to ~2.9× direct.
    const double ratio = eBus / eDirect;
    std::cout << "    eDirect=" << eDirect << " eBus=" << eBus << " ratio=" << ratio << "\n";
    CHECK(ratio < 1.0, "no direct-to-Master duplicate (routed energy not inflated)");
    CHECK(ratio > 0.4 && ratio < 0.6,
          "routed path ≈ 0.5× direct (single bus pan stage, no duplicate)");
}

// ─── T2: bus processed after source regardless of timeline track order ───────

static void testTrackOrderIndependence(const SampleSet& ss)
{
    std::cout << "[2] Bus declared before its source still receives/processes it\n";

    Timeline tl(kBPM, ss.sampleRate);
    // DrumBus added FIRST (earlier slot), Kick added SECOND.
    TrackInfo bus;  bus.name  = "DrumBus";
    TrackInfo kick; kick.name = "Kick";
    int busId  = tl.addTrack(bus);
    int kickId = tl.addTrack(kick);

    SampleRegion kr; kr.name = "Kick"; kr.label = SampleLabel::Custom;
    int kickReg = tl.addRegion(kr);
    addBeatClip(tl, kickId, kickReg, 0.0);
    CHECK(tl.setTrackOutputRoute(kickId, busId).ok(), "Kick→DrumBus route valid (bus earlier slot)");

    SampleBank bank;
    int sid = bank.loadSample(ss.kickWav, ss.sampleRate);
    auto out = renderProject(tl, bank, {{kickReg, sid}}, ss.sampleRate, kRenderSamples);
    CHECK(totalEnergy(out) > 1.0, "routed input audible despite bus-before-source order");
}

// ─── T3: bus with its own clips + routed source both pass through the bus ────

static void testBusWithOwnAudio(const SampleSet& ss)
{
    std::cout << "[3] Bus own audio + routed source both audible\n";

    Timeline tl(kBPM, ss.sampleRate);
    TrackInfo kick; kick.name = "Kick";
    TrackInfo bus;  bus.name  = "DrumBus";
    int kickId = tl.addTrack(kick);
    int busId  = tl.addTrack(bus);

    SampleRegion kr; kr.name = "Kick";  kr.label = SampleLabel::Custom;
    SampleRegion sr; sr.name = "Snare"; sr.label = SampleLabel::Custom;
    int kickReg  = tl.addRegion(kr);
    int snareReg = tl.addRegion(sr);

    // Kick at beat 0 (routed into bus); bus's own snare clip at beat 2.
    addBeatClip(tl, kickId, kickReg, 0.0);
    addBeatClip(tl, busId, snareReg, 2.0);
    CHECK(tl.setTrackOutputRoute(kickId, busId).ok(), "Kick→DrumBus route valid");

    SampleBank bank;
    int kid  = bank.loadSample(ss.kickWav,  ss.sampleRate);
    int snid = bank.loadSample(ss.snareWav, ss.sampleRate);
    auto out = renderProject(tl, bank, {{kickReg, kid}, {snareReg, snid}},
                             ss.sampleRate, kRenderSamples);

    const float kickWindow  = peakInWindow(out, 0,               kBeatSamples);
    const float snareWindow = peakInWindow(out, kBeatSamples * 2, kBeatSamples);
    std::cout << "    kickPeak=" << kickWindow << " snarePeak=" << snareWindow << "\n";
    CHECK(kickWindow  > 0.01f, "routed Kick audible through bus (beat 0)");
    CHECK(snareWindow > 0.01f, "bus's own Snare audible (beat 2)");
}

// ─── T4: nested A → Bus1 → Bus2 → Master ─────────────────────────────────────

static void testNestedRoute(const SampleSet& ss)
{
    std::cout << "[4] Nested A → Bus1 → Bus2 → Master\n";

    Timeline tl(kBPM, ss.sampleRate);
    TrackInfo a;  a.name  = "A";
    TrackInfo b1; b1.name = "Bus1";
    TrackInfo b2; b2.name = "Bus2";
    int aId  = tl.addTrack(a);
    int b1Id = tl.addTrack(b1);
    int b2Id = tl.addTrack(b2);

    SampleRegion kr; kr.name = "A"; kr.label = SampleLabel::Custom;
    int reg = tl.addRegion(kr);
    addBeatClip(tl, aId, reg, 0.0);
    CHECK(tl.setTrackOutputRoute(aId,  b1Id).ok(), "A→Bus1 valid");
    CHECK(tl.setTrackOutputRoute(b1Id, b2Id).ok(), "Bus1→Bus2 valid");

    SampleBank bank;
    int sid = bank.loadSample(ss.kickWav, ss.sampleRate);
    auto out = renderProject(tl, bank, {{reg, sid}}, ss.sampleRate, kRenderSamples);
    CHECK(totalEnergy(out) > 1.0, "nested A→Bus1→Bus2→Master reaches output");
}

// ─── T5: reset route back to Master ──────────────────────────────────────────

static void testResetToMaster(const SampleSet& ss)
{
    std::cout << "[5] Reset route to Master: source goes directly to Master again\n";

    Timeline tl(kBPM, ss.sampleRate);
    TrackInfo kick; kick.name = "Kick";
    TrackInfo bus;  bus.name  = "DrumBus";
    int kickId = tl.addTrack(kick);
    int busId  = tl.addTrack(bus);

    SampleRegion kr; kr.name = "Kick"; kr.label = SampleLabel::Custom;
    int kickReg = tl.addRegion(kr);
    addBeatClip(tl, kickId, kickReg, 0.0);

    tl.setTrackOutputRoute(kickId, busId);
    CHECK(tl.setTrackOutputRoute(kickId, -1).ok(), "reset Kick→Master valid");
    CHECK(tl.getTrackOutputRoute(kickId).targetTrackId == -1, "route reset persisted");

    SampleBank bank;
    int sid = bank.loadSample(ss.kickWav, ss.sampleRate);
    auto out = renderProject(tl, bank, {{kickReg, sid}}, ss.sampleRate, kRenderSamples);
    CHECK(totalEnergy(out) > 1.0, "Kick audible directly to Master after reset");
}

// ─── T6: muted source does not feed its bus ──────────────────────────────────

static void testMutedSource(const SampleSet& ss)
{
    std::cout << "[6] Muted source does not feed bus\n";

    Timeline tl(kBPM, ss.sampleRate);
    TrackInfo kick; kick.name = "Kick"; kick.muted = true;
    TrackInfo bus;  bus.name  = "DrumBus";
    int kickId = tl.addTrack(kick);
    int busId  = tl.addTrack(bus);

    SampleRegion kr; kr.name = "Kick"; kr.label = SampleLabel::Custom;
    int kickReg = tl.addRegion(kr);
    addBeatClip(tl, kickId, kickReg, 0.0);
    tl.setTrackOutputRoute(kickId, busId);

    SampleBank bank;
    int sid = bank.loadSample(ss.kickWav, ss.sampleRate);
    auto out = renderProject(tl, bank, {{kickReg, sid}}, ss.sampleRate, kRenderSamples);
    CHECK(totalEnergy(out) < 1e-4, "muted source feeds neither bus nor Master (silent)");
}

// ─── T7: muted bus mutes its subtree (no direct-to-Master leak) ──────────────

static void testMutedBus(const SampleSet& ss)
{
    std::cout << "[7] Muted bus mutes its subtree output\n";

    Timeline tl(kBPM, ss.sampleRate);
    TrackInfo kick; kick.name = "Kick";
    TrackInfo bus;  bus.name  = "DrumBus"; bus.muted = true;
    int kickId = tl.addTrack(kick);
    int busId  = tl.addTrack(bus);

    SampleRegion kr; kr.name = "Kick"; kr.label = SampleLabel::Custom;
    int kickReg = tl.addRegion(kr);
    addBeatClip(tl, kickId, kickReg, 0.0);
    tl.setTrackOutputRoute(kickId, busId);

    SampleBank bank;
    int sid = bank.loadSample(ss.kickWav, ss.sampleRate);
    auto out = renderProject(tl, bank, {{kickReg, sid}}, ss.sampleRate, kRenderSamples);
    // If the routed source ALSO summed to Master, muting the bus would not
    // silence it — so this is the pan-law-independent proof of no duplicate.
    CHECK(totalEnergy(out) < 1e-4, "muted bus silences the whole routed subtree");
}

// ─── T8: solo source stays audible through its downstream bus path ───────────

static void testSoloSource(const SampleSet& ss)
{
    std::cout << "[8] Solo source: audible through bus; sibling not\n";

    Timeline tl(kBPM, ss.sampleRate);
    TrackInfo kick;  kick.name  = "Kick"; kick.solo = true;
    TrackInfo bus;   bus.name   = "DrumBus";
    TrackInfo snare; snare.name = "Snare";
    int kickId  = tl.addTrack(kick);
    int busId   = tl.addTrack(bus);
    int snareId = tl.addTrack(snare);

    SampleRegion kr; kr.name = "Kick";  kr.label = SampleLabel::Custom;
    SampleRegion sr; sr.name = "Snare"; sr.label = SampleLabel::Custom;
    int kickReg  = tl.addRegion(kr);
    int snareReg = tl.addRegion(sr);

    // Kick at beat 0, sibling Snare at beat 2 (both routed into the bus).
    addBeatClip(tl, kickId,  kickReg,  0.0);
    addBeatClip(tl, snareId, snareReg, 2.0);
    tl.setTrackOutputRoute(kickId,  busId);
    tl.setTrackOutputRoute(snareId, busId);

    SampleBank bank;
    int kid  = bank.loadSample(ss.kickWav,  ss.sampleRate);
    int snid = bank.loadSample(ss.snareWav, ss.sampleRate);
    auto out = renderProject(tl, bank, {{kickReg, kid}, {snareReg, snid}},
                             ss.sampleRate, kRenderSamples);

    const float kickWindow  = peakInWindow(out, 0,               kBeatSamples);
    const float snareWindow = peakInWindow(out, kBeatSamples * 2, kBeatSamples);
    std::cout << "    kickPeak=" << kickWindow << " snarePeak=" << snareWindow << "\n";
    CHECK(kickWindow  > 0.01f, "soloed Kick audible through downstream bus path");
    CHECK(snareWindow < 0.01f, "non-soloed sibling Snare not audible");
}

// ─── T9: solo bus keeps upstream routed sources audible ──────────────────────

static void testSoloBus(const SampleSet& ss)
{
    std::cout << "[9] Solo bus: upstream sources audible; unrelated track not\n";

    Timeline tl(kBPM, ss.sampleRate);
    TrackInfo kick; kick.name = "Kick";
    TrackInfo bus;  bus.name  = "DrumBus"; bus.solo = true;
    TrackInfo lead; lead.name = "Lead"; // routes straight to Master
    int kickId = tl.addTrack(kick);
    int busId  = tl.addTrack(bus);
    int leadId = tl.addTrack(lead);

    SampleRegion kr; kr.name = "Kick"; kr.label = SampleLabel::Custom;
    SampleRegion lr; lr.name = "Lead"; lr.label = SampleLabel::Custom;
    int kickReg = tl.addRegion(kr);
    int leadReg = tl.addRegion(lr);

    addBeatClip(tl, kickId, kickReg, 0.0);
    addBeatClip(tl, leadId, leadReg, 2.0);
    tl.setTrackOutputRoute(kickId, busId);

    SampleBank bank;
    int kid = bank.loadSample(ss.kickWav, ss.sampleRate);
    int lid = bank.loadSample(ss.leadWav, ss.sampleRate);
    auto out = renderProject(tl, bank, {{kickReg, kid}, {leadReg, lid}},
                             ss.sampleRate, kRenderSamples);

    const float kickWindow = peakInWindow(out, 0,               kBeatSamples);
    const float leadWindow = peakInWindow(out, kBeatSamples * 2, kBeatSamples);
    std::cout << "    kickPeak=" << kickWindow << " leadPeak=" << leadWindow << "\n";
    CHECK(kickWindow > 0.01f, "upstream Kick audible through soloed bus");
    CHECK(leadWindow < 0.01f, "unrelated Lead not audible under bus solo");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << "=== test_mixer_bus_routing (Prompt 2B) ===\n";

    SampleSet ss = makeSamples();
    CHECK(ss.kickWav.existsAsFile(),  "kick WAV generated");
    CHECK(ss.snareWav.existsAsFile(), "snare WAV generated");
    CHECK(ss.leadWav.existsAsFile(),  "lead WAV generated");

    testHeardOnceNotTwice(ss);
    testTrackOrderIndependence(ss);
    testBusWithOwnAudio(ss);
    testNestedRoute(ss);
    testResetToMaster(ss);
    testMutedSource(ss);
    testMutedBus(ss);
    testSoloSource(ss);
    testSoloBus(ss);

    ss.dir.deleteRecursively();

    std::cout << "\n=== Results: " << g_passed << " passed, " << g_failed << " failed ===\n";
    if (g_failed > 0) {
        std::cerr << "FAILED: " << g_failed << " test(s) failed\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
