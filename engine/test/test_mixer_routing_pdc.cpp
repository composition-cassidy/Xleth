// test_mixer_routing_pdc.cpp — Prompt 2C: route-aware junction PDC and export
// pre-roll max path latency. Impulse-coincidence tests that FAIL under the old
// flat "delay every audible track to max track latency at Master" model:
// latent bus chains, sibling sources into one bus, nested buses, mute/solo
// closure, route reset, and AudioExporter pre-roll / realtime parity.
//
// Build: see engine/CMakeLists.txt target "test_mixer_routing_pdc"
// Run:   test_mixer_routing_pdc.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1
//
// NOTE: sizeof(MixEngine) is large — engines are heap-allocated (one per render
// helper call) and the target links with /STACK:8388608 like its siblings.

#include "audio/MixEngine.h"
#include "export/AudioExporter.h"
#include "model/Timeline.h"
#include "SampleBank.h"
#include "Transport.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <atomic>
#include <cmath>
#include <cstring>
#include <initializer_list>
#include <iostream>
#include <memory>
#include <string>
#include <utility>
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

// ─── TestLatencyProcessor ────────────────────────────────────────────────────
// Test-only deterministic latency insert: reports N samples of latency AND
// actually delays the signal by exactly N samples (per-channel ring buffer).
// The deterministic delay is what makes impulse-coincidence assertions exact —
// the fake plugin in test_pdc_stage1 only *reports* latency without delaying.

class TestLatencyProcessor : public juce::AudioProcessor
{
public:
    explicit TestLatencyProcessor(int delaySamples)
        : juce::AudioProcessor(
              BusesProperties()
                  .withInput ("Input",  juce::AudioChannelSet::stereo(), true)
                  .withOutput("Output", juce::AudioChannelSet::stereo(), true))
        , delay_(delaySamples < 0 ? 0 : delaySamples)
    {
        setLatencySamples(delay_);
    }

    const juce::String getName() const override { return "TestLatency"; }

    void prepareToPlay(double, int) override
    {
        for (auto& line : lines_)
            line.assign(static_cast<size_t>(delay_), 0.0f);
        writePos_ = 0;
    }

    void releaseResources() override {}

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
    {
        if (delay_ == 0)
            return;

        const int numCh = std::min(2, buffer.getNumChannels());
        int wpAfter = writePos_;
        for (int ch = 0; ch < numCh; ++ch)
        {
            float* data = buffer.getWritePointer(ch);
            auto& line = lines_[ch];
            int wp = writePos_;
            for (int i = 0; i < buffer.getNumSamples(); ++i)
            {
                const float in = data[i];
                data[i] = line[static_cast<size_t>(wp)];
                line[static_cast<size_t>(wp)] = in;
                if (++wp >= delay_) wp = 0;
            }
            wpAfter = wp;
        }
        writePos_ = wpAfter;
    }

    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }
    bool hasEditor() const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return "Default"; }
    void changeProgramName(int, const juce::String&) override {}
    void getStateInformation(juce::MemoryBlock&) override {}
    void setStateInformation(const void*, int) override {}

private:
    int delay_ = 0;
    int writePos_ = 0;
    std::vector<float> lines_[2];
};

// ─── Impulse fixture ─────────────────────────────────────────────────────────

static constexpr double kSampleRate     = 44100.0;
static constexpr double kBPM            = 120.0;
static constexpr int    kBeatSamples    = 22050;   // 1 beat @ 120 BPM / 44100
static constexpr int    kImpulseIndex   = 1000;    // impulse offset inside the region
static constexpr int    kImpulseWavLen  = 4096;
static constexpr int    kRenderSamples  = kBeatSamples;

static juce::File generateImpulseWav(const juce::File& dir, const juce::String& name)
{
    juce::AudioBuffer<float> buf(1, kImpulseWavLen);
    buf.clear();
    buf.setSample(0, kImpulseIndex, 0.5f);

    juce::File file = dir.getChildFile(name + ".wav");
    file.deleteFile();

    auto outStream = std::unique_ptr<juce::FileOutputStream>(file.createOutputStream());
    if (outStream == nullptr) return {};

    juce::WavAudioFormat wavFmt;
    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFmt.createWriterFor(outStream.get(), kSampleRate, 1, 16, {}, 0));
    if (writer == nullptr) return {};
    outStream.release();

    writer->writeFromAudioSampleBuffer(buf, 0, kImpulseWavLen);
    writer.reset();
    return file;
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

// ─── Measurement helpers ─────────────────────────────────────────────────────

static int findPeakIndex(const juce::AudioBuffer<float>& buf, int channel = 0)
{
    int peakIndex = -1;
    float peak = 0.0f;
    for (int s = 0; s < buf.getNumSamples(); ++s)
    {
        const float v = std::abs(buf.getSample(channel, s));
        if (v > peak) { peak = v; peakIndex = s; }
    }
    return peakIndex;
}

// Max abs outside a ± guard window around `index` (proves a SINGLE impulse —
// no second misaligned spike anywhere else in the render).
static float maxAbsOutsideWindow(const juce::AudioBuffer<float>& buf,
                                 int index, int guard)
{
    float peak = 0.0f;
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
        for (int s = 0; s < buf.getNumSamples(); ++s)
        {
            if (s >= index - guard && s <= index + guard) continue;
            peak = std::max(peak, std::abs(buf.getSample(ch, s)));
        }
    return peak;
}

// ─── Render helpers ──────────────────────────────────────────────────────────

struct LatencyInsert { int trackId; int delaySamples; };

// Build a configured engine (heap — MixEngine is too big for repeated stack
// frames), wire timeline/bank/inserts, and report route-aware latency getters.
static std::unique_ptr<MixEngine> makeEngine(
    Timeline& tl, SampleBank& bank,
    std::initializer_list<std::pair<int,int>> regionToSample,
    const std::vector<LatencyInsert>& inserts)
{
    auto engine = std::make_unique<MixEngine>();
    engine->prepare(kSampleRate, 512);
    engine->setNonRealtime(true);          // blocking chain lock — never skip inserts
    engine->setTimeline(&tl);
    engine->setSampleBank(&bank);
    for (const auto& rs : regionToSample)
        engine->mapRegionToSample(rs.first, rs.second);

    for (const auto& ins : inserts)
    {
        const int nodeId = engine->addProcessorForTesting(
            ins.trackId, "testlatency",
            std::make_unique<TestLatencyProcessor>(ins.delaySamples), 0);
        CHECK(nodeId >= 0, "test latency insert added to track "
                               + std::to_string(ins.trackId));
    }

    engine->syncTrackSlotsFromTimeline(true);
    engine->refreshLatencyDiagnostics();
    return engine;
}

static juce::AudioBuffer<float> renderEngine(MixEngine& engine, int totalSamples,
                                             int blockSize = 512)
{
    juce::AudioBuffer<float> output(2, totalSamples);
    output.clear();

    Transport t;
    t.setSampleRate(kSampleRate);
    t.setBPM(kBPM);
    t.seekToSample(0);
    t.play();

    int pos = 0;
    while (pos < totalSamples)
    {
        const int n = std::min(blockSize, totalSamples - pos);
        juce::AudioBuffer<float> block(2, n);
        block.clear();
        engine.processBlock(block, n, t);
        for (int ch = 0; ch < 2; ++ch)
            output.copyFrom(ch, pos, block, ch, 0, n);
        t.advance(n);
        pos += n;
    }

    t.pause();
    return output;
}

static juce::AudioBuffer<float> renderProject(
    Timeline& tl, SampleBank& bank,
    std::initializer_list<std::pair<int,int>> regionToSample,
    const std::vector<LatencyInsert>& inserts,
    int* outMaxPathLatency = nullptr)
{
    auto engine = makeEngine(tl, bank, regionToSample, inserts);
    if (outMaxPathLatency != nullptr)
        *outMaxPathLatency = engine->getMaxPathLatencySamples();
    return renderEngine(*engine, kRenderSamples);
}

static juce::AudioBuffer<float> readWavBuffer(const juce::File& file,
                                              int* outLength = nullptr)
{
    if (outLength != nullptr) *outLength = 0;

    juce::AudioFormatManager manager;
    manager.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader(manager.createReaderFor(file));
    CHECK(reader != nullptr, "exported WAV should be readable");
    if (reader == nullptr) return {};

    const int length = static_cast<int>(reader->lengthInSamples);
    juce::AudioBuffer<float> buffer(2, length);
    buffer.clear();
    reader->read(&buffer, 0, length, 0, true, true);
    if (outLength != nullptr) *outLength = length;
    return buffer;
}

// ─── Shared fixture ──────────────────────────────────────────────────────────

struct Fixture
{
    juce::File dir;
    juce::File impulseWav;
};

static Fixture makeFixture()
{
    Fixture f;
    f.dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                .getChildFile("xleth_test_mixer_routing_pdc");
    f.dir.createDirectory();
    f.impulseWav = generateImpulseWav(f.dir, "impulse");
    return f;
}

// Project skeleton shared by the impulse tests: builds tracks, optionally
// places the impulse clip on exactly one source so each branch's arrival can
// be measured in isolation (same topology + chains ⇒ identical compensation).
struct TrackSpec
{
    const char* name;
    int routeTargetIndex = -1;  // index into the spec array; -1 = Master
    bool muted = false;
    bool solo  = false;
    int insertLatency = 0;      // 0 = no insert
    bool hasClip = false;
};

// Render the project described by `specs`; returns output + route latency.
static juce::AudioBuffer<float> renderSpec(const Fixture& f,
                                           const std::vector<TrackSpec>& specs,
                                           int* outMaxPathLatency = nullptr)
{
    Timeline tl(kBPM, kSampleRate);

    std::vector<int> trackIds;
    for (const auto& s : specs)
    {
        TrackInfo t;
        t.name  = s.name;
        t.muted = s.muted;
        t.solo  = s.solo;
        trackIds.push_back(tl.addTrack(t));
    }
    for (size_t i = 0; i < specs.size(); ++i)
    {
        if (specs[i].routeTargetIndex >= 0)
            CHECK(tl.setTrackOutputRoute(trackIds[i],
                                         trackIds[static_cast<size_t>(specs[i].routeTargetIndex)]).ok(),
                  std::string(specs[i].name) + " route valid");
    }

    SampleRegion region; region.name = "Impulse"; region.label = SampleLabel::Custom;
    const int regionId = tl.addRegion(region);
    for (size_t i = 0; i < specs.size(); ++i)
        if (specs[i].hasClip)
            addBeatClip(tl, trackIds[i], regionId, 0.0);

    SampleBank bank;
    const int sampleId = bank.loadSample(f.impulseWav, kSampleRate);
    CHECK(sampleId >= 0, "impulse sample loads");

    std::vector<LatencyInsert> inserts;
    for (size_t i = 0; i < specs.size(); ++i)
        if (specs[i].insertLatency > 0)
            inserts.push_back({ trackIds[i], specs[i].insertLatency });

    return renderProject(tl, bank, {{regionId, sampleId}}, inserts, outMaxPathLatency);
}

// Assert a render contains exactly one impulse, at `expectedIndex`.
static void checkSingleImpulseAt(const juce::AudioBuffer<float>& out,
                                 int expectedIndex, const char* label)
{
    const int peak = findPeakIndex(out);
    CHECK(peak == expectedIndex,
          std::string(label) + ": impulse at " + std::to_string(peak)
              + ", expected " + std::to_string(expectedIndex));
    CHECK(maxAbsOutsideWindow(out, peak, 1) < 1.0e-4f,
          std::string(label) + ": single impulse (no misaligned duplicate)");
}

// ─── T1: Unrouted baseline — flat PDC behavior unchanged ─────────────────────

static void testUnroutedBaseline(const Fixture& f)
{
    std::cout << "[1] Unrouted baseline: flat PDC behavior unchanged\n";
    constexpr int kLat = 512;

    // A carries the latent insert; B is dry. Both direct to Master.
    int maxPathA = -1, maxPathB = -1;
    auto outA = renderSpec(f, { {"A", -1, false, false, kLat, /*clip*/true},
                                {"B", -1, false, false, 0,    false} }, &maxPathA);
    auto outB = renderSpec(f, { {"A", -1, false, false, kLat, false},
                                {"B", -1, false, false, 0,    /*clip*/true} }, &maxPathB);

    CHECK(maxPathA == kLat, "unrouted maxPath == flat max audible track latency");
    CHECK(maxPathA == maxPathB, "maxPath independent of clip placement");
    checkSingleImpulseAt(outA, kImpulseIndex + kLat, "latent A");
    checkSingleImpulseAt(outB, kImpulseIndex + kLat, "dry B (compensated)");
}

// ─── T2: Latent bus chain vs direct sibling (fails under flat PDC) ───────────

static void testLatentBusVsDirect(const Fixture& f)
{
    std::cout << "[2] A → Bus(latent) → Master vs direct B: align at Master\n";
    constexpr int kBusLat = 512;

    // Old flat model: A is compensated by 512 BEFORE the bus chain adds its own
    // 512 → A arrives at 1024 while direct B arrives at 512 (misaligned by 512).
    int maxPath = -1;
    auto outA = renderSpec(f, { {"A",   1, false, false, 0,       /*clip*/true},
                                {"Bus", -1, false, false, kBusLat, false},
                                {"B",   -1, false, false, 0,       false} }, &maxPath);
    auto outB = renderSpec(f, { {"A",   1, false, false, 0,       false},
                                {"Bus", -1, false, false, kBusLat, false},
                                {"B",   -1, false, false, 0,       /*clip*/true} });

    CHECK(maxPath == kBusLat, "maxPath == bus path latency (512)");
    checkSingleImpulseAt(outA, kImpulseIndex + kBusLat, "routed A through latent bus");
    checkSingleImpulseAt(outB, kImpulseIndex + kBusLat, "direct B aligned to bus path");
}

// ─── T3: Sibling sources into the same bus align at the bus input ────────────

static void testSiblingsIntoBus(const Fixture& f)
{
    std::cout << "[3] Siblings with different insert latencies align through one bus\n";
    constexpr int kLatA = 600;
    constexpr int kLatB = 120;

    // Old flat model aligns these too — but only by delaying the whole bus to
    // the global max AGAIN (arrival 1200). Junction PDC aligns at the bus input
    // with total path exactly 600, so the absolute index catches the old model.
    int maxPath = -1;
    auto outA = renderSpec(f, { {"A",   2, false, false, kLatA, /*clip*/true},
                                {"B",   2, false, false, kLatB, false},
                                {"Bus", -1, false, false, 0,     false} }, &maxPath);
    auto outB = renderSpec(f, { {"A",   2, false, false, kLatA, false},
                                {"B",   2, false, false, kLatB, /*clip*/true},
                                {"Bus", -1, false, false, 0,     false} });

    CHECK(maxPath == kLatA, "maxPath == deepest sibling (600), latency counted once");
    checkSingleImpulseAt(outA, kImpulseIndex + kLatA, "deep sibling A");
    checkSingleImpulseAt(outB, kImpulseIndex + kLatA, "shallow sibling B aligned at bus");
}

// ─── T4: Nested buses align at every junction (fails under flat PDC) ─────────

static void testNestedBuses(const Fixture& f)
{
    std::cout << "[4] Nested A → Bus1 → Bus2 ← B, C → Master: align everywhere\n";
    constexpr int kLat1 = 300;   // Bus1 chain
    constexpr int kLat2 = 200;   // Bus2 chain
    constexpr int kPath = kLat1 + kLat2;   // deepest path A → Bus1 → Bus2

    const std::vector<TrackSpec> base = {
        {"A",    1, false, false, 0,     false},   // → Bus1
        {"Bus1", 2, false, false, kLat1, false},   // → Bus2
        {"Bus2", -1, false, false, kLat2, false},  // → Master
        {"B",    2, false, false, 0,     false},   // → Bus2
        {"C",    -1, false, false, 0,    false},   // → Master
    };

    int maxPath = -1;
    auto specsA = base; specsA[0].hasClip = true;
    auto specsB = base; specsB[3].hasClip = true;
    auto specsC = base; specsC[4].hasClip = true;
    auto outA = renderSpec(f, specsA, &maxPath);
    auto outB = renderSpec(f, specsB);
    auto outC = renderSpec(f, specsC);

    CHECK(maxPath == kPath, "maxPath == deepest nested path (500)");
    checkSingleImpulseAt(outA, kImpulseIndex + kPath, "A through Bus1+Bus2");
    checkSingleImpulseAt(outB, kImpulseIndex + kPath, "B aligned at Bus2 junction");
    checkSingleImpulseAt(outC, kImpulseIndex + kPath, "C aligned at Master junction");
}

// ─── T5: Muted branch must not inflate max path latency ──────────────────────

static void testMutedBranchLatency(const Fixture& f)
{
    std::cout << "[5] Muted latent branch does not inflate path latency\n";

    int maxPath = -1;
    auto out = renderSpec(f, { {"A", -1, false, false, 0,    /*clip*/true},
                               {"M", -1, /*muted*/true, false, 2048, false} }, &maxPath);

    CHECK(maxPath == 0, "muted 2048-sample branch ignored → maxPath 0");
    checkSingleImpulseAt(out, kImpulseIndex, "A passes with zero added latency");
}

// ─── T6: Solo computes path latency over the audible closure ─────────────────

static void testSoloClosureLatency(const Fixture& f)
{
    std::cout << "[6] Solo source through latent bus: closure path, not all tracks\n";
    constexpr int kBusLat = 512;

    int maxPath = -1;
    auto out = renderSpec(f, { {"Kick", 1, false, /*solo*/true, 0,      /*clip*/true},
                               {"Bus",  -1, false, false,        kBusLat, false},
                               {"Lead", -1, false, false,        4096,    false} }, &maxPath);

    CHECK(maxPath == kBusLat,
          "solo closure path latency (512), silenced 4096 insert ignored");
    checkSingleImpulseAt(out, kImpulseIndex + kBusLat, "soloed Kick through latent bus");
}

// ─── T7: Route reset returns to direct-route PDC (identical output) ──────────

static void testRouteReset(const Fixture& f)
{
    std::cout << "[7] Route reset to Master: PDC identical to never-routed project\n";
    constexpr int kBusLat = 512;

    // Project that was routed, then reset to Master.
    juce::AudioBuffer<float> outReset;
    int maxPathReset = -1;
    {
        Timeline tl(kBPM, kSampleRate);
        TrackInfo kick; kick.name = "Kick";
        TrackInfo bus;  bus.name  = "Bus";
        const int kickId = tl.addTrack(kick);
        const int busId  = tl.addTrack(bus);

        SampleRegion region; region.name = "Impulse"; region.label = SampleLabel::Custom;
        const int regionId = tl.addRegion(region);
        addBeatClip(tl, kickId, regionId, 0.0);

        CHECK(tl.setTrackOutputRoute(kickId, busId).ok(), "route Kick→Bus valid");
        CHECK(tl.setTrackOutputRoute(kickId, -1).ok(),    "reset Kick→Master valid");

        SampleBank bank;
        const int sampleId = bank.loadSample(f.impulseWav, kSampleRate);
        outReset = renderProject(tl, bank, {{regionId, sampleId}},
                                 {{busId, kBusLat}}, &maxPathReset);
    }

    // Identical project that was never routed.
    auto outNever = renderSpec(f, { {"Kick", -1, false, false, 0,       /*clip*/true},
                                    {"Bus",  -1, false, false, kBusLat, false} });

    CHECK(maxPathReset == kBusLat,
          "after reset, audible latent bus still sets flat max (legacy behavior)");
    CHECK(outReset.getNumSamples() == outNever.getNumSamples(), "same render length");
    float maxDiff = 0.0f;
    for (int ch = 0; ch < 2; ++ch)
        for (int s = 0; s < outReset.getNumSamples(); ++s)
            maxDiff = std::max(maxDiff, std::abs(outReset.getSample(ch, s)
                                                 - outNever.getSample(ch, s)));
    CHECK(maxDiff < 1.0e-6f, "reset-route render identical to never-routed render");
}

// ─── T8: Export pre-roll covers nested bus path latency ──────────────────────

static void testExportPrerollNested(const Fixture& f)
{
    std::cout << "[8] AudioExporter pre-roll uses route-aware max path latency\n";
    constexpr int kLat1 = 300;
    constexpr int kLat2 = 200;

    Timeline tl(kBPM, kSampleRate);
    TrackInfo a;  a.name  = "A";
    TrackInfo b1; b1.name = "Bus1";
    TrackInfo b2; b2.name = "Bus2";
    const int aId  = tl.addTrack(a);
    const int b1Id = tl.addTrack(b1);
    const int b2Id = tl.addTrack(b2);
    CHECK(tl.setTrackOutputRoute(aId,  b1Id).ok(), "A→Bus1 valid");
    CHECK(tl.setTrackOutputRoute(b1Id, b2Id).ok(), "Bus1→Bus2 valid");

    SampleRegion region; region.name = "Impulse"; region.label = SampleLabel::Custom;
    const int regionId = tl.addRegion(region);
    addBeatClip(tl, aId, regionId, 0.0);

    SampleBank bank;
    const int sampleId = bank.loadSample(f.impulseWav, kSampleRate);
    CHECK(sampleId >= 0, "impulse sample loads");

    auto engine = makeEngine(tl, bank, {{regionId, sampleId}},
                             { {b1Id, kLat1}, {b2Id, kLat2} });
    CHECK(engine->getMaxPathLatencySamples() == kLat1 + kLat2,
          "engine reports nested max path latency (500)");

    // Pre-roll plan must consume the path latency, not the flat track max (300).
    const auto plan = AudioExporter::computePrerollPlan(*engine, 0);
    CHECK(plan.totalPrerollSamples == kLat1 + kLat2,
          "export pre-roll == route path latency, not flat per-track max");

    AudioExporter exporter;
    AudioExporter::Config config;
    config.outputPath = f.dir.getChildFile("export_nested.wav")
                            .getFullPathName().toStdString();
    config.format     = AudioExporter::Format::WAV;
    config.sampleRate = static_cast<int>(kSampleRate);
    config.bitDepth   = 32;
    config.startBeat  = 0.0;
    config.endBeat    = 1.0;

    std::atomic<bool> cancel { false };
    CHECK(exporter.exportAudio(tl, bank, *engine, config, nullptr, cancel),
          "nested routed export completes");

    int length = 0;
    auto exported = readWavBuffer(juce::File(config.outputPath), &length);
    CHECK(length == kBeatSamples, "exported length == requested beat");
    const int peak = findPeakIndex(exported);
    CHECK(std::abs(peak - kImpulseIndex) <= 1,
          std::string("exported impulse lands at its timeline position; peak=")
              + std::to_string(peak));
    CHECK(maxAbsOutsideWindow(exported, peak, 1) < 1.0e-4f,
          "exported render contains a single impulse");
}

// ─── T9: Routed export matches realtime-equivalent render ────────────────────

static void testExportRealtimeParity(const Fixture& f)
{
    std::cout << "[9] Routed offline export == realtime render shifted by path latency\n";
    constexpr int kLat1 = 300;
    constexpr int kLat2 = 200;
    constexpr int kPath = kLat1 + kLat2;

    Timeline tl(kBPM, kSampleRate);
    TrackInfo a;  a.name  = "A";
    TrackInfo b1; b1.name = "Bus1";
    TrackInfo b2; b2.name = "Bus2";
    TrackInfo c;  c.name  = "C";
    const int aId  = tl.addTrack(a);
    const int b1Id = tl.addTrack(b1);
    const int b2Id = tl.addTrack(b2);
    const int cId  = tl.addTrack(c);
    CHECK(tl.setTrackOutputRoute(aId,  b1Id).ok(), "A→Bus1 valid");
    CHECK(tl.setTrackOutputRoute(b1Id, b2Id).ok(), "Bus1→Bus2 valid");

    SampleRegion region; region.name = "Impulse"; region.label = SampleLabel::Custom;
    const int regionId = tl.addRegion(region);
    addBeatClip(tl, aId, regionId, 0.0);   // deep nested branch
    addBeatClip(tl, cId, regionId, 0.5);   // direct branch, offset half a beat

    SampleBank bank;
    const int sampleId = bank.loadSample(f.impulseWav, kSampleRate);
    CHECK(sampleId >= 0, "impulse sample loads");

    const std::vector<LatencyInsert> inserts = { {b1Id, kLat1}, {b2Id, kLat2} };

    // Offline export (fresh engine).
    juce::AudioBuffer<float> exported;
    int exportedLen = 0;
    {
        auto engine = makeEngine(tl, bank, {{regionId, sampleId}}, inserts);

        AudioExporter exporter;
        AudioExporter::Config config;
        config.outputPath = f.dir.getChildFile("export_parity.wav")
                                .getFullPathName().toStdString();
        config.format     = AudioExporter::Format::WAV;
        config.sampleRate = static_cast<int>(kSampleRate);
        config.bitDepth   = 32;
        config.startBeat  = 0.0;
        config.endBeat    = 1.0;

        std::atomic<bool> cancel { false };
        CHECK(exporter.exportAudio(tl, bank, *engine, config, nullptr, cancel),
              "routed parity export completes");
        exported = readWavBuffer(juce::File(config.outputPath), &exportedLen);
    }
    CHECK(exportedLen == kBeatSamples, "parity export length == one beat");

    // Realtime-equivalent render (fresh identical engine): play from sample 0;
    // the user hears the timeline delayed by the master-input path latency, so
    // realtime[kPath + k] must equal export[k].
    juce::AudioBuffer<float> realtime;
    {
        auto engine = makeEngine(tl, bank, {{regionId, sampleId}}, inserts);
        CHECK(engine->getMaxPathLatencySamples() == kPath, "parity maxPath == 500");
        realtime = renderEngine(*engine, kBeatSamples + kPath);
    }

    float maxDiff = 0.0f;
    for (int ch = 0; ch < 2; ++ch)
        for (int s = 0; s < kBeatSamples; ++s)
            maxDiff = std::max(maxDiff, std::abs(exported.getSample(ch, s)
                                                 - realtime.getSample(ch, s + kPath)));
    std::cout << "    parity maxDiff=" << maxDiff << "\n";
    CHECK(maxDiff < 1.0e-5f,
          "routed offline export matches realtime render shifted by path latency");
}

// ─── T10: Unrouted export output unchanged ───────────────────────────────────

static void testUnroutedExportUnchanged(const Fixture& f)
{
    std::cout << "[10] Unrouted export: impulse at timeline position (legacy pre-roll)\n";
    constexpr int kLat = 512;

    Timeline tl(kBPM, kSampleRate);
    TrackInfo a; a.name = "A";
    TrackInfo b; b.name = "B";
    const int aId = tl.addTrack(a);
    (void)tl.addTrack(b);

    SampleRegion region; region.name = "Impulse"; region.label = SampleLabel::Custom;
    const int regionId = tl.addRegion(region);
    addBeatClip(tl, aId, regionId, 0.0);

    SampleBank bank;
    const int sampleId = bank.loadSample(f.impulseWav, kSampleRate);

    auto engine = makeEngine(tl, bank, {{regionId, sampleId}}, {{aId, kLat}});
    CHECK(engine->getMaxPathLatencySamples()
              == engine->getMaxAudibleTrackLatencySamples(),
          "unrouted: maxPath == flat max audible track latency");

    AudioExporter exporter;
    AudioExporter::Config config;
    config.outputPath = f.dir.getChildFile("export_unrouted.wav")
                            .getFullPathName().toStdString();
    config.format     = AudioExporter::Format::WAV;
    config.sampleRate = static_cast<int>(kSampleRate);
    config.bitDepth   = 32;
    config.startBeat  = 0.0;
    config.endBeat    = 1.0;

    std::atomic<bool> cancel { false };
    CHECK(exporter.exportAudio(tl, bank, *engine, config, nullptr, cancel),
          "unrouted export completes");

    int length = 0;
    auto exported = readWavBuffer(juce::File(config.outputPath), &length);
    CHECK(length == kBeatSamples, "unrouted export length == one beat");
    const int peak = findPeakIndex(exported);
    CHECK(std::abs(peak - kImpulseIndex) <= 1,
          std::string("unrouted exported impulse at timeline position; peak=")
              + std::to_string(peak));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << "=== test_mixer_routing_pdc (Prompt 2C) ===\n";

    Fixture f = makeFixture();
    CHECK(f.impulseWav.existsAsFile(), "impulse WAV generated");

    testUnroutedBaseline(f);
    testLatentBusVsDirect(f);
    testSiblingsIntoBus(f);
    testNestedBuses(f);
    testMutedBranchLatency(f);
    testSoloClosureLatency(f);
    testRouteReset(f);
    testExportPrerollNested(f);
    testExportRealtimeParity(f);
    testUnroutedExportUnchanged(f);

    f.dir.deleteRecursively();

    std::cout << "\n=== Results: " << g_passed << " passed, " << g_failed << " failed ===\n";
    if (g_failed > 0) {
        std::cerr << "FAILED: " << g_failed << " test(s) failed\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
