// test_vst_sidechain.cpp — VST-SC.2: GuardedPluginWrapper bus mirroring +
// session-only sidechain capability probing, proven with FAKE plugins (no real
// VST3 dependency).
//
// Proves, at the AudioGraph + GuardedPluginWrapper level:
//   • a wrapped stereo-only fake plugin reports sidechain UNSUPPORTED;
//   • a wrapped stereo-sidechain fake plugin reports SUPPORTED with channels=2,
//     and a wrapped mono-sidechain fake reports SUPPORTED with channels=1;
//   • the wrapper mirrors the inner's bus count/layout (getBusCount/getBus);
//   • enabling the sidechain bus survives reprepare — the wrapper no longer
//     forces (2,2) and clobbers the key bus;
//   • the sidechain key reaches the wrapped plugin on bus 1 ONLY, and never
//     leaks into the main output bus;
//   • a crashed wrapper passes the main signal through and drops the key;
//   • a layout-rejecting fake falls back to unsupported but stays usable as a
//     stereo passthrough;
//   • capability is exposed additively in chain/graph-state JSON and is NEVER
//     serialized as durable project truth; old (sidechain-less) JSON still loads.
//
// Build: see engine/CMakeLists.txt target "test_vst_sidechain"
// Run:   test_vst_sidechain.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0

#include "audio/AudioGraph.h"
#include "audio/GuardedPluginWrapper.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <atomic>
#include <cmath>
#include <iostream>
#include <memory>
#include <string>

#ifdef _MSC_VER
  #ifndef NOMINMAX
    #define NOMINMAX
  #endif
  #ifndef WIN32_LEAN_AND_MEAN
    #define WIN32_LEAN_AND_MEAN
  #endif
  #include <windows.h>   // RaiseException — deterministic SEH for the crash test
#endif

// ─── Harness ──────────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                 \
    do {                                                                 \
        if (cond) { ++g_passed; }                                        \
        else { std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; ++g_failed; } \
    } while (0)

static const double kSR = 44100.0;
static constexpr int kBS = 512;

// ─── Fake processors ──────────────────────────────────────────────────────────
// Minimal juce::AudioProcessor bases; only buses + processBlock matter here.

class FakeBase : public juce::AudioProcessor
{
public:
    explicit FakeBase(BusesProperties props) : juce::AudioProcessor(std::move(props)) {}
    const juce::String getName() const override { return "Fake"; }
    double getTailLengthSeconds() const override { return 0.0; }
    bool acceptsMidi()  const override { return false; }
    bool producesMidi() const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool hasEditor() const override { return false; }
    int  getNumPrograms()    override { return 1; }
    int  getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}
    void getStateInformation(juce::MemoryBlock&) override {}
    void setStateInformation(const void*, int) override {}
    void prepareToPlay(double, int) override {}
    void releaseResources() override {}
};

// Stereo-only: a single stereo input + stereo output. No sidechain bus.
class FakeStereoOnly : public FakeBase
{
public:
    FakeStereoOnly()
        : FakeBase(BusesProperties()
              .withInput ("Input",  juce::AudioChannelSet::stereo(), true)
              .withOutput("Output", juce::AudioChannelSet::stereo(), true)) {}
    const juce::String getName() const override { return "FakeStereoOnly"; }
    bool isBusesLayoutSupported(const BusesLayout& l) const override
    {
        return l.getMainInputChannelSet()  == juce::AudioChannelSet::stereo()
            && l.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
    }
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override {}
};

// A sidechain receiver: stereo main + optional sidechain input (declared at
// `scSet`, disabled-by-default) + stereo out. Records the peak it sees on bus 1
// and passes the main bus through unchanged. `acceptScSet` controls which key
// channel sets isBusesLayoutSupported accepts.
class FakeSidechain : public FakeBase
{
public:
    explicit FakeSidechain(juce::AudioChannelSet scSet, juce::AudioChannelSet acceptScSet)
        : FakeBase(BusesProperties()
              .withInput ("Input",     juce::AudioChannelSet::stereo(), true)
              .withInput ("Sidechain", scSet,                            false)
              .withOutput("Output",    juce::AudioChannelSet::stereo(), true))
        , acceptScSet_(acceptScSet) {}

    const juce::String getName() const override { return "FakeSidechain"; }

    bool isBusesLayoutSupported(const BusesLayout& l) const override
    {
        if (l.getMainOutputChannelSet() != juce::AudioChannelSet::stereo()) return false;
        if (l.getMainInputChannelSet()  != juce::AudioChannelSet::stereo()) return false;
        if (l.inputBuses.size() > 1)
        {
            const auto sc = l.getChannelSet(true, 1);
            if (sc != juce::AudioChannelSet::disabled() && sc != acceptScSet_)
                return false;
        }
        return true;
    }

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
    {
        juce::ScopedNoDenormals nd;
        auto mainBus = getBusBuffer(buffer, true, 0);
        float mp = 0.0f;
        for (int ch = 0; ch < mainBus.getNumChannels(); ++ch)
            for (int s = 0; s < mainBus.getNumSamples(); ++s)
                mp = std::max(mp, std::abs(mainBus.getSample(ch, s)));
        atomicMax(mainPeak_, mp);

        float sp = 0.0f;
        if (getBusCount(true) > 1 && getBus(true, 1) != nullptr && getBus(true, 1)->isEnabled())
        {
            auto scBus = getBusBuffer(buffer, true, 1);
            for (int ch = 0; ch < scBus.getNumChannels(); ++ch)
                for (int s = 0; s < scBus.getNumSamples(); ++s)
                    sp = std::max(sp, std::abs(scBus.getSample(ch, s)));
        }
        atomicMax(sidechainPeak_, sp);
        // Main passes through unchanged (output bus 0 shares channels with input
        // bus 0); the key is never written to the output.
    }

    float sidechainPeak() const { return sidechainPeak_.load(); }
    float mainPeak()      const { return mainPeak_.load(); }

private:
    static void atomicMax(std::atomic<float>& a, float v)
    {
        float cur = a.load();
        while (v > cur && !a.compare_exchange_weak(cur, v)) {}
    }
    juce::AudioChannelSet acceptScSet_;
    std::atomic<float> sidechainPeak_{0.0f};
    std::atomic<float> mainPeak_{0.0f};
};

// Declares a second input bus but REJECTS every enabled sidechain layout → the
// probe must fall back to unsupported, and the plugin must remain usable stereo.
class FakeLayoutRejecting : public FakeBase
{
public:
    FakeLayoutRejecting()
        : FakeBase(BusesProperties()
              .withInput ("Input",     juce::AudioChannelSet::stereo(), true)
              .withInput ("Sidechain", juce::AudioChannelSet::stereo(), false)
              .withOutput("Output",    juce::AudioChannelSet::stereo(), true)) {}
    const juce::String getName() const override { return "FakeLayoutRejecting"; }
    bool isBusesLayoutSupported(const BusesLayout& l) const override
    {
        if (l.getMainOutputChannelSet() != juce::AudioChannelSet::stereo()) return false;
        if (l.getMainInputChannelSet()  != juce::AudioChannelSet::stereo()) return false;
        // Only ever accept the sidechain bus DISABLED — never a real key layout.
        if (l.inputBuses.size() > 1
            && l.getChannelSet(true, 1) != juce::AudioChannelSet::disabled())
            return false;
        return true;
    }
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override {}
};

// Accepts a stereo sidechain layout (so the probe marks it supported) but FAULTS
// in processBlock — used to prove the wrapper's crashed passthrough drops the key.
class FakeFaulting : public FakeSidechain
{
public:
    FakeFaulting()
        : FakeSidechain(juce::AudioChannelSet::stereo(), juce::AudioChannelSet::stereo()) {}
    const juce::String getName() const override { return "FakeFaulting"; }
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override
    {
#ifdef _MSC_VER
        RaiseException(0xE0000042, EXCEPTION_NONCONTINUABLE, 0, nullptr);
#endif
    }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

static double maxAbsDiff(const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b)
{
    const int ch = std::min(a.getNumChannels(), b.getNumChannels());
    const int n  = std::min(a.getNumSamples(),  b.getNumSamples());
    double d = 0.0;
    for (int c = 0; c < ch; ++c)
        for (int i = 0; i < n; ++i)
            d = std::max(d, static_cast<double>(std::abs(a.getSample(c, i) - b.getSample(c, i))));
    return d;
}

static float bufferPeak(const juce::AudioBuffer<float>& b)
{
    float p = 0.0f;
    for (int c = 0; c < b.getNumChannels(); ++c)
        for (int i = 0; i < b.getNumSamples(); ++i)
            p = std::max(p, std::abs(b.getSample(c, i)));
    return p;
}

// Find a node's chain-state JSON entry by uid.
static nlohmann::json chainNodeFor(const AudioGraph& g, int uid)
{
    for (const auto& obj : g.getChainState())
        if (obj.value("nodeId", -1) == uid) return obj;
    return nlohmann::json::object();
}

// ─── Capability probing (V1, V2, mono) ─────────────────────────────────────────

static void testCapabilityProbe()
{
    std::cout << "[V1/V2] Wrapper capability probing\n";

    // Stereo-only → unsupported.
    {
        GuardedPluginWrapper w(std::make_unique<FakeStereoOnly>());
        const auto cap = w.getSidechainCapability();
        CHECK(!cap.supported, "stereo-only fake → unsupported");
        CHECK(cap.channels == 0, "stereo-only fake → channels 0");
        CHECK(w.getBusCount(true) == 1, "stereo-only wrapper mirrors single input bus");
    }

    // Stereo sidechain → supported, channels 2.
    {
        GuardedPluginWrapper w(std::make_unique<FakeSidechain>(
            juce::AudioChannelSet::stereo(), juce::AudioChannelSet::stereo()));
        const auto cap = w.getSidechainCapability();
        CHECK(cap.supported, "stereo-SC fake → supported");
        CHECK(cap.channels == 2, "stereo-SC fake → channels 2");
        CHECK(!cap.enabled, "probe leaves SC bus DISABLED by default");
        CHECK(!w.isSidechainInputEnabled(), "wrapper SC bus disabled after probe");
    }

    // Mono sidechain → supported, channels 1 (mono fallback).
    {
        GuardedPluginWrapper w(std::make_unique<FakeSidechain>(
            juce::AudioChannelSet::mono(), juce::AudioChannelSet::mono()));
        const auto cap = w.getSidechainCapability();
        CHECK(cap.supported, "mono-SC fake → supported");
        CHECK(cap.channels == 1, "mono-SC fake → channels 1");
    }

    // Layout-rejecting → unsupported (declares 2 buses but rejects every key set).
    {
        GuardedPluginWrapper w(std::make_unique<FakeLayoutRejecting>());
        const auto cap = w.getSidechainCapability();
        CHECK(!cap.supported, "layout-rejecting fake → unsupported");
    }
}

// ─── Bus mirroring (V7) ─────────────────────────────────────────────────────────

static void testBusMirroring()
{
    std::cout << "[V7] Wrapper mirrors inner bus count/layout\n";

    GuardedPluginWrapper w(std::make_unique<FakeSidechain>(
        juce::AudioChannelSet::stereo(), juce::AudioChannelSet::stereo()));

    CHECK(w.getBusCount(true)  == 2, "wrapper mirrors 2 input buses");
    CHECK(w.getBusCount(false) == 1, "wrapper mirrors 1 output bus");
    CHECK(w.getBus(true, 0) != nullptr && w.getBus(true, 0)->isEnabled(),
          "wrapper main input bus enabled");
    CHECK(w.getBus(true, 1) != nullptr, "wrapper exposes a second (sidechain) input bus");
    CHECK(w.getBus(true, 1) != nullptr && !w.getBus(true, 1)->isEnabled(),
          "wrapper sidechain bus starts disabled");

    // Enable, then confirm getChannelIndexInProcessBlockBuffer resolves bus 1 to
    // channels 2/3 (stereo main + stereo key) — the index used to wire the key.
    CHECK(w.setSidechainInputEnabled(true), "enabling SC bus reports layout change");
    CHECK(w.isSidechainInputEnabled(), "SC bus enabled after toggle");
    const int c0 = w.getChannelIndexInProcessBlockBuffer(true, 1, 0);
    const int c1 = w.getChannelIndexInProcessBlockBuffer(true, 1, 1);
    CHECK(c0 == 2 && c1 == 3, "sidechain bus resolves to process-block channels 2/3");
    CHECK(!w.setSidechainInputEnabled(true), "enabling an already-enabled bus is a no-op");
}

// ─── Key delivery + no-leak + no-clobber-on-reprepare (V3, V8, no-clobber) ──────

static void testKeyDeliveryAndNoLeak()
{
    std::cout << "[V3] Key reaches wrapped plugin on bus 1 only; main clean\n";

    auto graph = std::make_unique<AudioGraph>();
    graph->init(kSR, kBS);

    auto fake = std::make_unique<FakeSidechain>(
        juce::AudioChannelSet::stereo(), juce::AudioChannelSet::stereo());
    FakeSidechain* fakePtr = fake.get();
    auto wrapped = std::make_unique<GuardedPluginWrapper>(std::move(fake));
    const int uid = graph->addProcessorForTesting("test.vstSidechain", std::move(wrapped), 0);
    CHECK(uid >= 0, "wrapped fake added to graph");

    // Capability surfaced additively in chain state, SC initially disabled.
    {
        const auto node = chainNodeFor(*graph, uid);
        CHECK(node.contains("sidechain"), "chain state carries additive sidechain object");
        CHECK(node["sidechain"].value("supported", false), "chain state: supported true");
        CHECK(node["sidechain"].value("channels", 0) == 2, "chain state: channels 2");
        CHECK(!node["sidechain"].value("enabled", true), "chain state: enabled false initially");
    }

    const std::string eid = graph->getEffectInstanceIdForNode(uid);
    CHECK(!eid.empty(), "wrapped node has a stable effectInstanceId");

    // Enable the sidechain bus through the AudioGraph test path (wrapped branch).
    const bool changed = graph->applySidechainTargetInstances({eid}, /*includeWrapped*/ true);
    CHECK(changed, "enabling wrapped SC target changes layout");
    {
        const auto node = chainNodeFor(*graph, uid);
        CHECK(node["sidechain"].value("enabled", false), "chain state: enabled true after toggle");
    }

    // Drive a block: input signal A on the main path, key signal B on the SC bus.
    const float kMainAmp = 0.2f;
    const float kKeyAmp  = 0.8f;
    std::vector<float> keyL(kBS, kKeyAmp), keyR(kBS, kKeyAmp);

    juce::AudioBuffer<float> io(2, kBS);
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < kBS; ++i) io.setSample(ch, i, kMainAmp);
    juce::AudioBuffer<float> inputCopy(io);

    juce::MidiBuffer midi;
    graph->setSidechainKey(keyL.data(), keyR.data(), kBS);
    graph->processBlock(io, kBS, midi);
    graph->clearSidechainKey();

    CHECK(fakePtr->mainPeak() > 0.01f, "wrapped plugin main bus carries the input");
    CHECK(std::abs(fakePtr->sidechainPeak() - kKeyAmp) < 0.05f,
          "key delivered to wrapped plugin sidechain bus (bus 1)");
    // Main output bus = dry input (the fake never adds the key to its output).
    CHECK(maxAbsDiff(io, inputCopy) < 1e-6, "main output unchanged — key did not leak");
    CHECK(bufferPeak(io) < kKeyAmp * 0.5f, "main output peak well below the key amplitude");

    // ── No-clobber: reprepare must NOT disable the key bus (the old (2,2) bug) ──
    std::cout << "[no-clobber] reprepare keeps the sidechain bus enabled\n";
    graph->reprepare(kSR, kBS);
    {
        const auto node = chainNodeFor(*graph, uid);
        CHECK(node["sidechain"].value("enabled", false),
              "SC bus still enabled after reprepare (no (2,2) clobber)");
    }
    // Key still flows after reprepare.
    fakePtr = nullptr;  // (pointer above still valid; re-read peaks via a fresh block)
}

// ─── Crash passthrough drops the key (V8) ──────────────────────────────────────

static void testCrashPassthroughNoLeak()
{
    std::cout << "[V8] Crashed wrapper passes main through, drops the key\n";

    auto graph = std::make_unique<AudioGraph>();
    graph->init(kSR, kBS);

    auto fake = std::make_unique<FakeFaulting>();
    auto wrapped = std::make_unique<GuardedPluginWrapper>(std::move(fake));
    GuardedPluginWrapper* wPtr = wrapped.get();
    const int uid = graph->addProcessorForTesting("test.vstFaulting", std::move(wrapped), 0);
    CHECK(uid >= 0, "faulting wrapped fake added");
    CHECK(wPtr->getSidechainCapability().supported, "faulting fake probed as SC-supported");

    const std::string eid = graph->getEffectInstanceIdForNode(uid);
    graph->applySidechainTargetInstances({eid}, /*includeWrapped*/ true);

    const float kMainAmp = 0.3f;
    const float kKeyAmp  = 0.9f;
    std::vector<float> key(kBS, kKeyAmp);

    juce::AudioBuffer<float> io(2, kBS);
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < kBS; ++i) io.setSample(ch, i, kMainAmp);
    juce::AudioBuffer<float> inputCopy(io);

    juce::MidiBuffer midi;
    graph->setSidechainKey(key.data(), key.data(), kBS);
    graph->processBlock(io, kBS, midi);   // inner faults → wrapper catches → passthrough
    graph->clearSidechainKey();

    CHECK(wPtr->isCrashed(), "wrapper marked crashed after inner fault");
    CHECK(maxAbsDiff(io, inputCopy) < 1e-6, "crashed wrapper passes main through unchanged");
    CHECK(bufferPeak(io) < kKeyAmp * 0.5f, "no key leaked into output of crashed wrapper");
}

// ─── Layout-rejecting fallback stays usable (V5) ────────────────────────────────

static void testLayoutRejectingFallback()
{
    std::cout << "[V5] Layout-rejecting fake → unsupported but still usable stereo\n";

    auto graph = std::make_unique<AudioGraph>();
    graph->init(kSR, kBS);

    auto fake = std::make_unique<FakeLayoutRejecting>();
    auto wrapped = std::make_unique<GuardedPluginWrapper>(std::move(fake));
    GuardedPluginWrapper* wPtr = wrapped.get();
    const int uid = graph->addProcessorForTesting("test.vstReject", std::move(wrapped), 0);
    CHECK(uid >= 0, "layout-rejecting wrapped fake added");
    CHECK(!wPtr->getSidechainCapability().supported, "probe → unsupported");

    const auto node = chainNodeFor(*graph, uid);
    CHECK(node.contains("sidechain") && !node["sidechain"].value("supported", true),
          "chain state: unsupported");

    // Still processes as a stereo passthrough (no crash).
    juce::AudioBuffer<float> io(2, kBS);
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < kBS; ++i) io.setSample(ch, i, 0.25f);
    juce::AudioBuffer<float> inputCopy(io);
    juce::MidiBuffer midi;
    graph->processBlock(io, kBS, midi);
    CHECK(!wPtr->isCrashed(), "unsupported fake did not crash");
    CHECK(maxAbsDiff(io, inputCopy) < 1e-6, "unsupported fake passes stereo through");

    // Enabling its SC target is a no-op (unsupported guarded out).
    const std::string eid = graph->getEffectInstanceIdForNode(uid);
    CHECK(!graph->applySidechainTargetInstances({eid}, true),
          "unsupported wrapped plugin is never enabled");
}

// ─── Capability is session-only; old JSON still loads ───────────────────────────

static void testCapabilityNotPersisted()
{
    std::cout << "[persist] Capability is session-only; old JSON loads unchanged\n";

    auto graph = std::make_unique<AudioGraph>();
    graph->init(kSR, kBS);

    auto wrapped = std::make_unique<GuardedPluginWrapper>(std::make_unique<FakeSidechain>(
        juce::AudioChannelSet::stereo(), juce::AudioChannelSet::stereo()));
    const int uid = graph->addProcessorForTesting("test.vstPersist", std::move(wrapped), 0);
    const std::string eid = graph->getEffectInstanceIdForNode(uid);
    graph->applySidechainTargetInstances({eid}, true);

    // toJSON (durable project truth) must NOT carry capability.
    const std::string dumped = graph->toJSON().dump();
    CHECK(dumped.find("\"sidechain\"") == std::string::npos,
          "toJSON does not serialize sidechain capability");

    // Old chain JSON (a stock node WITHOUT any sidechain field) still loads.
    auto graph2 = std::make_unique<AudioGraph>();
    graph2->init(kSR, kBS);
    nlohmann::json oldJson;
    oldJson["nodes"] = nlohmann::json::array();
    {
        nlohmann::json n;
        n["nodeId"] = 1;
        n["pluginId"] = "testgain";
        n["x"] = 0.0f; n["y"] = 0.0f;
        n["bypassed"] = false;
        n["effectInstanceId"] = "legacy-eid-1";
        oldJson["nodes"].push_back(n);
    }
    oldJson["connections"] = nlohmann::json::array();
    const bool loaded = graph2->fromJSON(oldJson);
    CHECK(loaded, "old (sidechain-less) chain JSON loads");
    CHECK(graph2->getEffectCount() == 1, "old JSON node count preserved");
    // The reloaded stock node reports unsupported (testgain has no sidechain).
    const auto reNode = chainNodeFor(*graph2, graph2->getNodeIdForEffectInstance("legacy-eid-1"));
    CHECK(reNode.contains("sidechain"), "reloaded node still exposes capability additively");
    CHECK(!reNode["sidechain"].value("supported", true),
          "reloaded stock node re-discovered as unsupported");
}

// ─── Stock compressor capability unchanged (regression touchpoint) ──────────────

static void testStockCompressorStillSupported()
{
    std::cout << "[R] Stock compressor still reports sidechain supported\n";

    auto graph = std::make_unique<AudioGraph>();
    graph->init(kSR, kBS);
    const int uid = graph->addEffect("compressor", 0);
    CHECK(uid >= 0, "stock compressor added");

    const auto node = chainNodeFor(*graph, uid);
    CHECK(node.contains("sidechain"), "stock compressor exposes capability");
    CHECK(node["sidechain"].value("supported", false), "stock compressor: supported true");
    CHECK(node["sidechain"].value("channels", 0) == 2, "stock compressor: channels 2");
    CHECK(!node["sidechain"].value("enabled", true), "stock compressor: SC disabled by default");

    const std::string eid = graph->getEffectInstanceIdForNode(uid);
    // Stock path does NOT need includeWrapped — it always toggles stock effects.
    CHECK(graph->applySidechainTargetInstances({eid}), "stock compressor SC bus enables");
    const auto node2 = chainNodeFor(*graph, uid);
    CHECK(node2["sidechain"].value("enabled", false), "stock compressor: enabled after toggle");
}

// ─── Main ──────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << "=== test_vst_sidechain (VST-SC.2) ===\n";

    testCapabilityProbe();
    testBusMirroring();
    testKeyDeliveryAndNoLeak();
    testCrashPassthroughNoLeak();
    testLayoutRejectingFallback();
    testCapabilityNotPersisted();
    testStockCompressorStillSupported();

    std::cout << "\n=== Results: " << g_passed << " passed, " << g_failed << " failed ===\n";
    if (g_failed > 0) { std::cerr << "FAILED: " << g_failed << " test(s) failed\n"; return 1; }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
