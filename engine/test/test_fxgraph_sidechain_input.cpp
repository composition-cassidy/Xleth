// test_fxgraph_sidechain_input.cpp — Prompt 6C: FX Graph Sidechain Input drives the
// EXISTING silent sidechain route/key transport into a GRAPH-OWNED stock compressor.
//
// 6B made the FX Graph Sidechain Input a renderer/graphState contract only. 6C binds
// that intent to the proven native sidechain stack — no second sidechain engine. This
// test proves, end-to-end through MixEngine::processBlock, that a compressor created
// as a GRAPH-OWNED node (MixEngine::addGraphEffectNode + syncGraphTopology, NOT the
// linear chain) ducks under a source-track key when:
//   • the sidechain route targets the compressor by its stable effectInstanceId
//     (the SAME id graphState persists — never a raw APG node id), and
//   • sc_external=1 is set through the graph parameter API
//     (MixEngine::setGraphEffectParameterNormalized).
//
// Asserted:
//   • [duck]   sc_external=1 + route targeting the graph compressor instance → the
//              Bass ducks while the Kick key is active (early RMS << late RMS), and
//              the Kick never leaks audibly (target soloed → Master is Bass-only, and
//              ducking REMOVES energy; a leak would ADD it).
//   • [noroute] same graph compressor, no route → no duck (external key is silence).
//   • [wrong]  route targets a DIFFERENT graph effect instance on the same track →
//              the measured compressor does not duck (effectInstanceId is honored).
//   • [internal] sc_external=0 → route has no effect (legacy internal detector).
//   • [unsupported] a route targeting a NON-compressor graph effect instance enables
//              no sidechain bus and never ducks/crashes (VST/other-effect sidechain
//              stays a no-op; only supportsExternalSidechain() effects are keyed).
//
// Build: see engine/CMakeLists.txt target "test_fxgraph_sidechain_input"
// Pass:  prints "ALL TESTS PASSED" and exits 0
//
// NOTE: MixEngine is heavy — heap-allocated (unique_ptr), never two on a stack.

#include "audio/MixEngine.h"
#include "audio/XlethCompressorEffect.h"
#include "model/Timeline.h"
#include "SampleBank.h"
#include "Transport.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <cmath>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

// ─── Harness ──────────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                 \
    do {                                                                 \
        if (cond) { ++g_passed; }                                        \
        else { std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; ++g_failed; } \
    } while (0)

// ─── Sample fixtures (mirrors test_stock_compressor_sidechain) ──────────────────

static const double kBPM = 120.0;
static const double kSR  = 44100.0;
static constexpr int kBeat = 22050;
static constexpr int kRenderSamples = kBeat * 2;    // 1.0 s

static juce::File generateSineWav(const juce::File& dir, const juce::String& name,
                                  int numSamples, float freq, float amplitude)
{
    juce::AudioBuffer<float> buf(1, numSamples);
    float* data = buf.getWritePointer(0);
    for (int i = 0; i < numSamples; ++i)
    {
        const double t = static_cast<double>(i) / kSR;
        data[i] = amplitude * static_cast<float>(
            std::sin(2.0 * juce::MathConstants<double>::pi * freq * t));
    }
    juce::File file = dir.getChildFile(name + ".wav");
    file.deleteFile();
    auto outStream = std::unique_ptr<juce::FileOutputStream>(file.createOutputStream());
    if (outStream == nullptr) return {};
    juce::WavAudioFormat wavFmt;
    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFmt.createWriterFor(outStream.get(), kSR, 1, 16, {}, 0));
    if (writer == nullptr) return {};
    outStream.release();
    writer->writeFromAudioSampleBuffer(buf, 0, numSamples);
    writer.reset();
    return file;
}

struct SampleSet { juce::File dir, kickWav, bassWav; int kickLen = 0, bassLen = 0; };

static SampleSet makeSamples()
{
    SampleSet ss;
    ss.dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                 .getChildFile("xleth_test_fxgraph_sc");
    ss.dir.createDirectory();
    ss.kickLen = static_cast<int>(kSR * 0.20);
    ss.bassLen = static_cast<int>(kSR * 1.00);
    ss.kickWav = generateSineWav(ss.dir, "kick", ss.kickLen,  80.0f, 0.70f);
    ss.bassWav = generateSineWav(ss.dir, "bass", ss.bassLen, 300.0f, 0.10f);
    return ss;
}

static void addBeatClip(Timeline& tl, int trackId, int regionId, double beat, double durBeats)
{
    Clip c;
    c.trackId  = trackId;
    c.regionId = regionId;
    c.position = TickTime::fromBeats(beat);
    c.duration = TickTime::fromBeats(durBeats);
    tl.addClip(c);
}

static double rmsWindow(const juce::AudioBuffer<float>& buf, int start, int end)
{
    start = std::max(0, start);
    end   = std::min(buf.getNumSamples(), end);
    if (end <= start) return 0.0;
    double e = 0.0; int n = 0;
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
        for (int i = start; i < end; ++i)
        { const double s = buf.getSample(ch, i); e += s * s; ++n; }
    return n > 0 ? std::sqrt(e / n) : 0.0;
}
static double rmsEarly(const juce::AudioBuffer<float>& m) { return rmsWindow(m, 3000, 8000); }
static double rmsLate (const juce::AudioBuffer<float>& m) { return rmsWindow(m, 26000, 42000); }

// ─── Graph topology JSON helpers ────────────────────────────────────────────────

static nlohmann::json ioNode(const std::string& id, const std::string& type)
{
    return nlohmann::json{{"nodeId", id}, {"type", type}};
}
static nlohmann::json effectNode(const std::string& nodeId, const std::string& effectInstanceId,
                                 const std::string& pluginId)
{
    return nlohmann::json{
        {"nodeId", nodeId}, {"type", "effect"},
        {"effectInstanceId", effectInstanceId}, {"pluginId", pluginId}, {"missing", false},
    };
}
static nlohmann::json audioEdge(const std::string& id, const std::string& src, const std::string& dst)
{
    return nlohmann::json{
        {"edgeId", id}, {"sourceNodeId", src}, {"targetNodeId", dst},
        {"sourcePort", src == "input" ? "audio" : "audioOut"},
        {"targetPort", dst == "output" ? "audio" : "audioIn"},
        {"type", "audio"},
    };
}

// ─── Scenario runner ──────────────────────────────────────────────────────────

struct Scenario
{
    bool scExternal      = true;   // sc_external on the MEASURED graph compressor
    bool addRoute        = true;   // create a sidechain route from Kick → Bass
    bool routeToWrong    = false;  // route targets the decoy compressor instance
    bool routeToReverb   = false;  // route targets a non-compressor graph effect
    bool addDecoy        = false;  // add a 2nd graph compressor instance
    bool addReverb       = false;  // add a graph reverb (non-sidechain-capable)
};

struct Result
{
    juce::AudioBuffer<float> master{2, kRenderSamples};
    bool routeAccepted = true;
    bool externalApplied = false;
    Result() { master.clear(); }
};

static Result runScenario(const SampleSet& ss, const Scenario& sc)
{
    Result r;
    Timeline tl(kBPM, kSR);

    TrackInfo source; source.name = "Kick";
    const int sourceId = tl.addTrack(source);
    TrackInfo target; target.name = "Bass"; target.solo = true;  // isolate Master to Bass
    const int targetId = tl.addTrack(target);

    SampleRegion kr; kr.name = "Kick"; kr.label = SampleLabel::Custom;
    SampleRegion br; br.name = "Bass"; br.label = SampleLabel::Custom;
    const int kickReg = tl.addRegion(kr);
    const int bassReg = tl.addRegion(br);
    addBeatClip(tl, sourceId, kickReg, 0.0, 1.0);
    addBeatClip(tl, targetId, bassReg, 0.0, 2.0);

    SampleBank bank;
    const int kid = bank.loadSample(ss.kickWav, kSR);
    const int bid = bank.loadSample(ss.bassWav, kSR);

    auto engine = std::make_unique<MixEngine>();
    engine->prepare(kSR, 512);
    engine->setTimeline(&tl);
    engine->setSampleBank(&bank);
    engine->mapRegionToSample(kickReg, kid);
    engine->mapRegionToSample(bassReg, bid);

    // ── Put the Bass track into FX GRAPH mode with a graph-owned compressor ─────
    // Stable instance ids are what graphState persists and what the route targets.
    const std::string measEid  = "graph-comp-meas";
    const std::string decoyEid = "graph-comp-decoy";
    const std::string revEid   = "graph-reverb";

    const int measNode = engine->addGraphEffectNode(targetId, measEid, "compressor");
    int decoyNode = -1, revNode = -1;
    if (sc.addDecoy)  decoyNode = engine->addGraphEffectNode(targetId, decoyEid, "compressor");
    if (sc.addReverb) revNode   = engine->addGraphEffectNode(targetId, revEid, "reverb");

    // Build the audible graph: Track Input → measured compressor → Track Output.
    // Decoy/reverb instances exist but stay OUT of the audible path (no edges), so
    // they only matter as sidechain TARGETS, never as audio processors here.
    nlohmann::json nodes = nlohmann::json::array({
        ioNode("input", "trackInput"),
        effectNode("fx-meas", measEid, "compressor"),
        ioNode("output", "trackOutput"),
    });
    if (sc.addDecoy)  nodes.push_back(effectNode("fx-decoy", decoyEid, "compressor"));
    if (sc.addReverb) nodes.push_back(effectNode("fx-rev", revEid, "reverb"));
    nlohmann::json edges = nlohmann::json::array({
        audioEdge("e-in",  "input",   "fx-meas"),
        audioEdge("e-out", "fx-meas", "output"),
    });
    const nlohmann::json topology = {
        {"phase", "FXG.3-d"}, {"trackId", std::to_string(targetId)},
        {"nodes", nodes}, {"edges", edges},
    };
    engine->syncGraphTopology(targetId, topology);

    // Configure the measured compressor for clean, deterministic ducking (raw values
    // by engine node id; the node lives in the same per-track AudioGraph).
    engine->setEffectParameter(targetId, measNode, "threshold", -16.0f);
    engine->setEffectParameter(targetId, measNode, "ratio",      10.0f);
    engine->setEffectParameter(targetId, measNode, "attack",      0.5f);
    engine->setEffectParameter(targetId, measNode, "release",   100.0f);
    engine->setEffectParameter(targetId, measNode, "knee",        0.0f);
    engine->setEffectParameter(targetId, measNode, "makeup",      0.0f);
    engine->setEffectParameter(targetId, measNode, "mix",       100.0f);

    // sc_external goes through the GRAPH parameter API by effectInstanceId — the 6C
    // path. Normalized 1.0 → external detector on.
    const std::string scRes = engine->setGraphEffectParameterNormalized(
        targetId, measEid, "sc_external", sc.scExternal ? 1.0 : 0.0);
    r.externalApplied = scRes.find("\"ok\":true") != std::string::npos;

    if (sc.addRoute)
    {
        SidechainRoute route;
        route.routeId = "fxg-sc-route";
        route.targetTrackId = targetId;
        route.targetEffectInstanceId =
            sc.routeToReverb ? revEid : (sc.routeToWrong ? decoyEid : measEid);
        route.gain = 1.0f;
        route.preFader = false;
        route.enabled = true;

        // The SAME resolver the bridge uses — it resolves graph-owned instances via
        // EffectChainManager::getNodeIdForEffectInstance (walks graph nodes too).
        xleth::SidechainEffectResolver resolver =
            [&](int tid, const std::string& eid) -> bool
            { return engine->getEffectNodeIdForInstance(tid, eid) >= 0; };

        const auto vr = tl.addSidechainRoute(sourceId, route, resolver);
        r.routeAccepted = vr.ok();
    }

    engine->syncTrackSlotsFromTimeline(true);
    engine->syncSidechainTargetBuses();
    engine->setNonRealtime(true);

    Transport t;
    t.setSampleRate(kSR);
    t.setBPM(kBPM);
    t.seekToSample(0);
    t.play();

    int pos = 0;
    while (pos < kRenderSamples)
    {
        const int n = std::min(512, kRenderSamples - pos);
        juce::AudioBuffer<float> block(2, n);
        block.clear();
        engine->processBlock(block, n, t);
        for (int ch = 0; ch < 2; ++ch)
            r.master.copyFrom(ch, pos, block, ch, 0, n);
        t.advance(n);
        pos += n;
    }
    t.pause();
    return r;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << "=== test_fxgraph_sidechain_input (Prompt 6C) ===\n";

    SampleSet ss = makeSamples();
    CHECK(ss.kickWav.existsAsFile(), "kick WAV generated");
    CHECK(ss.bassWav.existsAsFile(), "bass WAV generated");

    // [duck] graph-owned compressor ducks under the source key, no leak.
    {
        std::cout << "[1] graph compressor ducks via existing route transport\n";
        Scenario sc; // defaults: scExternal + addRoute, target = measured instance
        Result r = runScenario(ss, sc);
        CHECK(r.routeAccepted, "route to graph-owned effectInstanceId is accepted");
        CHECK(r.externalApplied, "sc_external=1 applied via graph parameter API");
        const double early = rmsEarly(r.master);
        const double late  = rmsLate(r.master);
        CHECK(late > 1e-4, "Bass is audible after the key releases");
        CHECK(early < 0.7 * late,
              "graph compressor ducks the Bass while the Kick key is active");
        // Key silence: Bass is the only audible track (soloed); ducking REMOVES
        // energy. If the Kick key leaked into output, early would EXCEED late.
        CHECK(early < late, "no key leakage — ducked window has LESS energy, not more");
    }

    // [noroute] no route → external key is silence → no duck.
    {
        std::cout << "[2] sc_external=1 but no route → no ducking (silent key)\n";
        Scenario sc; sc.addRoute = false;
        Result r = runScenario(ss, sc);
        const double early = rmsEarly(r.master);
        const double late  = rmsLate(r.master);
        CHECK(early > 0.85 * late, "without a route the graph compressor does not duck");
    }

    // [wrong] route targets a DIFFERENT graph instance → measured one untouched.
    {
        std::cout << "[3] route to a different graph instance does not duck this one\n";
        Scenario sc; sc.addDecoy = true; sc.routeToWrong = true;
        Result r = runScenario(ss, sc);
        CHECK(r.routeAccepted, "route to the decoy graph instance is accepted");
        const double early = rmsEarly(r.master);
        const double late  = rmsLate(r.master);
        CHECK(early > 0.85 * late,
              "a route targeting the WRONG effectInstanceId does not duck the measured one");
    }

    // [internal] sc_external=0 → route present but ignored.
    {
        std::cout << "[4] sc_external=0 → route has no effect (internal detector)\n";
        Scenario sc; sc.scExternal = false;
        Result r = runScenario(ss, sc);
        const double early = rmsEarly(r.master);
        const double late  = rmsLate(r.master);
        CHECK(early > 0.85 * late, "with sc_external=0 the external key is ignored");
    }

    // [unsupported] route targeting a non-compressor graph effect → no-op, no crash.
    {
        std::cout << "[5] route to a non-compressor graph effect is a safe no-op\n";
        Scenario sc; sc.addReverb = true; sc.routeToReverb = true;
        Result r = runScenario(ss, sc);
        const double early = rmsEarly(r.master);
        const double late  = rmsLate(r.master);
        // The reverb cannot consume an external key (no supportsExternalSidechain);
        // the measured compressor has no route, so the Bass never ducks.
        CHECK(early > 0.85 * late,
              "a non-compressor sidechain target enables no bus and never ducks");
        CHECK(late > 1e-4, "graph still renders audio with an unsupported sidechain target");
    }

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed == 0) { std::cout << "ALL TESTS PASSED\n"; return 0; }
    return 1;
}
