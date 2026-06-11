// test_sidechain_runtime.cpp — Prompt 4C+4D: runtime silent sidechain key
// transport + SidechainSourceProcessor injection groundwork.
//
// Proves, end-to-end through MixEngine::processBlock:
//   • a source track's sidechain route fills a per-target key buffer that is
//     delivered into the target chain through a SidechainSourceProcessor and
//     received by a test-only sidechain-capable node — WITHOUT ever changing the
//     audible master output (silence guarantee);
//   • gain scales the key only; disabled / muted / visual-only / stale routes
//     produce no key; pre-fader vs post-fader tap points behave per policy;
//   • a target-soloed source is still processed sidechain-only (feedsSidechainOnly)
//     so its key keeps flowing while it is itself inaudible;
//   • the SidechainSourceProcessor outputs silence with no buffer and is
//     block-size safe (no stale reuse).
//
// Build: see engine/CMakeLists.txt target "test_sidechain_runtime"
// Run:   test_sidechain_runtime.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
//
// NOTE: MixEngine is heavy — each instance is heap-allocated (unique_ptr), never
// two on a single stack frame.

#include "audio/MixEngine.h"
#include "audio/SidechainSourceProcessor.h"
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
#include <iostream>
#include <memory>
#include <string>

// ─── Harness ──────────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                 \
    do {                                                                 \
        if (cond) { ++g_passed; }                                        \
        else { std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; ++g_failed; } \
    } while (0)

// ─── Test-only sidechain-capable receiver ────────────────────────────────────
// Declares an enabled second input bus ("Sidechain") so AudioGraph recognises it
// as a key consumer and wires the SidechainSourceProcessor to it. It records the
// peak of its sidechain input and passes its main input through unchanged. It
// NEVER adds the key into its output — proving the key reaches the chain node
// without leaking into the audible path. Test-only; never registered in
// production effect creation.
class SidechainReceiverProcessor : public juce::AudioProcessor
{
public:
    SidechainReceiverProcessor()
        : AudioProcessor(BusesProperties()
              .withInput ("Input",     juce::AudioChannelSet::stereo(), true)
              .withInput ("Sidechain", juce::AudioChannelSet::stereo(), true)
              .withOutput("Output",    juce::AudioChannelSet::stereo(), true)) {}

    const juce::String getName() const override { return "SCReceiver"; }
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

    bool isBusesLayoutSupported(const BusesLayout& layouts) const override
    {
        if (layouts.getMainOutputChannelSet() != juce::AudioChannelSet::stereo()) return false;
        if (layouts.getMainInputChannelSet()  != juce::AudioChannelSet::stereo()) return false;
        const auto sc = layouts.getChannelSet(true, 1);
        return sc == juce::AudioChannelSet::stereo() || sc == juce::AudioChannelSet::disabled();
    }

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
    {
        juce::ScopedNoDenormals noDenormals;
        blocks_.fetch_add(1, std::memory_order_relaxed);

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
        // Main passes through unchanged: output bus 0 shares channels 0/1 with
        // input bus 0, so leaving them untouched IS the passthrough.
    }

    float sidechainPeak() const { return sidechainPeak_.load(std::memory_order_relaxed); }
    float mainPeak()      const { return mainPeak_.load(std::memory_order_relaxed); }
    int   blocks()        const { return blocks_.load(std::memory_order_relaxed); }

private:
    static void atomicMax(std::atomic<float>& a, float v)
    {
        float cur = a.load(std::memory_order_relaxed);
        while (v > cur && !a.compare_exchange_weak(cur, v, std::memory_order_relaxed)) {}
    }
    std::atomic<float> sidechainPeak_{0.0f};
    std::atomic<float> mainPeak_{0.0f};
    std::atomic<int>   blocks_{0};
};

// ─── Sample fixtures ──────────────────────────────────────────────────────────

static const double kBPM = 120.0;
static const double kSR  = 44100.0;
static constexpr int kBeat = 22050;            // one beat @ 120 BPM / 44100
static constexpr int kRenderSamples = kBeat * 2;

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

struct SampleSet
{
    juce::File dir, kickWav, leadWav;
    int sampleLen = 0;
};

static SampleSet makeSamples()
{
    SampleSet ss;
    ss.dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                 .getChildFile("xleth_test_sc_runtime");
    ss.dir.createDirectory();
    ss.sampleLen = static_cast<int>(kSR * 0.20);   // 200 ms tones
    ss.kickWav = generateSineWav(ss.dir, "kick", ss.sampleLen,  80.0f, 0.5f);
    ss.leadWav = generateSineWav(ss.dir, "lead", ss.sampleLen, 600.0f, 0.5f);
    return ss;
}

static void addBeatClip(Timeline& tl, int trackId, int regionId, double beat)
{
    Clip c;
    c.trackId  = trackId;
    c.regionId = regionId;
    c.position = TickTime::fromBeats(beat);
    c.duration = TickTime::fromBeats(1.0);
    tl.addClip(c);
}

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

static double totalEnergy(const juce::AudioBuffer<float>& buf)
{
    double e = 0.0;
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
        for (int i = 0; i < buf.getNumSamples(); ++i)
        { const double s = buf.getSample(ch, i); e += s * s; }
    return e;
}

// ─── Scenario runner ──────────────────────────────────────────────────────────

struct Scenario
{
    bool   addReceiver   = true;   // add the test SC receiver to the target chain
    bool   addRoute      = true;   // create the source→target sidechain route
    bool   routeEnabled  = true;
    bool   preFader      = false;
    float  gain          = 1.0f;
    bool   mutedSource   = false;
    bool   visualOnlySrc = false;
    bool   soloTarget    = false;
    bool   staleRoute    = false;  // route targets a bogus effectInstanceId
    float  sourceVolume  = 1.0f;
};

struct Result
{
    juce::AudioBuffer<float> master{2, kRenderSamples};
    float scPeak    = 0.0f;
    float mainPeak  = 0.0f;
    int   recvBlocks = 0;
    bool  routeAccepted = true;
};

static Result runScenario(const SampleSet& ss, const Scenario& sc)
{
    Result r;
    r.master.clear();

    Timeline tl(kBPM, kSR);
    TrackInfo source; source.name = "Source";
    source.muted = sc.mutedSource;
    source.visualOnly = sc.visualOnlySrc;
    source.volume = sc.sourceVolume;
    TrackInfo target; target.name = "Target";
    target.solo = sc.soloTarget;
    const int sourceId = tl.addTrack(source);
    const int targetId = tl.addTrack(target);

    SampleRegion kr; kr.name = "Kick"; kr.label = SampleLabel::Custom;
    SampleRegion lr; lr.name = "Lead"; lr.label = SampleLabel::Custom;
    const int kickReg = tl.addRegion(kr);
    const int leadReg = tl.addRegion(lr);
    addBeatClip(tl, sourceId, kickReg, 0.0);   // source key material
    addBeatClip(tl, targetId, leadReg, 0.0);   // target audio so its chain runs

    SampleBank bank;
    const int kid = bank.loadSample(ss.kickWav, kSR);
    const int lid = bank.loadSample(ss.leadWav, kSR);

    auto engine = std::make_unique<MixEngine>();
    engine->prepare(kSR, 512);
    engine->setTimeline(&tl);
    engine->setSampleBank(&bank);
    engine->mapRegionToSample(kickReg, kid);
    engine->mapRegionToSample(leadReg, lid);

    SidechainReceiverProcessor* recvPtr = nullptr;
    std::string realEid;
    if (sc.addReceiver)
    {
        auto recv = std::make_unique<SidechainReceiverProcessor>();
        recvPtr = recv.get();
        const int nodeId = engine->addProcessorForTesting(targetId, "test.scReceiver",
                                                          std::move(recv), 0);
        if (nodeId >= 0)
            realEid = engine->getEffectInstanceIdForNode(targetId, nodeId);
    }

    if (sc.addRoute)
    {
        SidechainRoute route;
        route.routeId = "sc-test-route";
        route.targetTrackId = targetId;
        route.targetEffectInstanceId = sc.staleRoute ? std::string("stale-nonexistent-eid")
                                                     : realEid;
        route.gain = sc.gain;
        route.preFader = sc.preFader;
        route.enabled = sc.routeEnabled;

        // Permissive resolver: for the stale case the eid does NOT exist on the
        // chain, so validation would normally reject it — pass a resolver that
        // accepts it so the route is stored and we can prove DSP skips it.
        xleth::SidechainEffectResolver resolver =
            [&](int tid, const std::string& eid) -> bool
            {
                if (sc.staleRoute) return true;       // simulate "was valid at add time"
                return engine->getEffectNodeIdForInstance(tid, eid) >= 0;
            };
        const auto vr = tl.addSidechainRoute(sourceId, route, resolver);
        r.routeAccepted = vr.ok();
    }

    engine->syncTrackSlotsFromTimeline(true);
    engine->setNonRealtime(true);   // blocking chain lock + synchronous APG build

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

    if (recvPtr != nullptr)
    {
        r.scPeak     = recvPtr->sidechainPeak();
        r.mainPeak   = recvPtr->mainPeak();
        r.recvBlocks = recvPtr->blocks();
    }
    return r;
}

// ─── D3: SidechainSourceProcessor unit behaviour ──────────────────────────────

static void testSourceProcessorUnit()
{
    std::cout << "[D] SidechainSourceProcessor: silence/copy/block-size safety\n";

    SidechainSourceProcessor proc;
    proc.setPlayConfigDetails(0, 2, kSR, 512);
    proc.prepareToPlay(kSR, 512);

    // No buffer set → silence.
    {
        juce::AudioBuffer<float> out(2, 128);
        for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < 128; ++i) out.setSample(ch, i, 1.0f);
        juce::MidiBuffer midi;
        proc.processBlock(out, midi);
        float peak = 0.0f;
        for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < 128; ++i) peak = std::max(peak, std::abs(out.getSample(ch, i)));
        CHECK(peak == 0.0f, "no external buffer → silent output");
    }

    // External buffer set → copied to both outputs.
    {
        std::vector<float> keyL(128), keyR(128);
        for (int i = 0; i < 128; ++i) { keyL[i] = 0.7f; keyR[i] = -0.3f; }
        proc.setExternalBuffer(keyL.data(), keyR.data(), 128);
        juce::AudioBuffer<float> out(2, 128);
        out.clear();
        juce::MidiBuffer midi;
        proc.processBlock(out, midi);
        CHECK(std::abs(out.getSample(0, 64) - 0.7f) < 1e-6f, "left channel copied from external L");
        CHECK(std::abs(out.getSample(1, 64) + 0.3f) < 1e-6f, "right channel copied from external R");
    }

    // Block-size grows past the external length → tail zero-filled, no stale read.
    {
        std::vector<float> key(100, 0.9f);
        proc.setExternalBuffer(key.data(), key.data(), 100);
        juce::AudioBuffer<float> out(2, 200);
        for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < 200; ++i) out.setSample(ch, i, 5.0f);
        juce::MidiBuffer midi;
        proc.processBlock(out, midi);
        CHECK(std::abs(out.getSample(0, 50) - 0.9f) < 1e-6f, "in-range samples copied");
        bool tailSilent = true;
        for (int ch = 0; ch < 2; ++ch) for (int i = 100; i < 200; ++i) tailSilent &= (out.getSample(ch, i) == 0.0f);
        CHECK(tailSilent, "samples past external length zero-filled (no stale reuse)");
    }

    // Cleared → silent again.
    {
        proc.clearExternalBuffer();
        juce::AudioBuffer<float> out(2, 64);
        for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < 64; ++i) out.setSample(ch, i, 1.0f);
        juce::MidiBuffer midi;
        proc.processBlock(out, midi);
        float peak = 0.0f;
        for (int ch = 0; ch < 2; ++ch) for (int i = 0; i < 64; ++i) peak = std::max(peak, std::abs(out.getSample(ch, i)));
        CHECK(peak == 0.0f, "cleared external buffer → silent output");
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout << "=== test_sidechain_runtime (Prompt 4C+4D) ===\n";

    SampleSet ss = makeSamples();
    CHECK(ss.kickWav.existsAsFile(), "kick WAV generated");
    CHECK(ss.leadWav.existsAsFile(), "lead WAV generated");

    testSourceProcessorUnit();

    // ── A: delivery + silence guarantee ───────────────────────────────────────
    std::cout << "[A] Key delivered to chain; master unchanged by the route\n";
    Scenario base; // receiver + enabled post-fader route, gain 1
    Result withRoute = runScenario(ss, base);

    Scenario noRoute = base; noRoute.addRoute = false;
    Result without = runScenario(ss, noRoute);

    CHECK(withRoute.routeAccepted, "valid route accepted");
    CHECK(withRoute.recvBlocks > 0, "receiver actually processed (chain ran)");
    CHECK(withRoute.mainPeak > 0.01f, "receiver main bus carries the target signal");
    CHECK(withRoute.scPeak > 0.01f, "key delivered to receiver sidechain bus");
    CHECK(without.scPeak == 0.0f, "no route → no key on sidechain bus");
    const double dMaster = maxAbsDiff(withRoute.master, without.master);
    std::cout << "    scPeak(route)=" << withRoute.scPeak
              << " scPeak(none)=" << without.scPeak
              << " masterDiff=" << dMaster << "\n";
    CHECK(dMaster < 1e-6, "master output bit-identical with vs without the sidechain route");

    // ── B: stale route skipped silently ───────────────────────────────────────
    std::cout << "[B] Stale target effect → no key, master unchanged, no crash\n";
    Scenario stale = base; stale.staleRoute = true;
    Result staleRes = runScenario(ss, stale);
    CHECK(staleRes.scPeak == 0.0f, "stale effect instance → no key delivered");
    CHECK(maxAbsDiff(staleRes.master, without.master) < 1e-6, "stale route leaves master unchanged");

    // ── C: disabled route → no key ─────────────────────────────────────────────
    std::cout << "[C] Disabled route → no key\n";
    Scenario disabled = base; disabled.routeEnabled = false;
    Result disabledRes = runScenario(ss, disabled);
    CHECK(disabledRes.scPeak == 0.0f, "disabled route delivers no key");

    // ── D: muted / visual-only source → no key ─────────────────────────────────
    std::cout << "[E] Muted / visual-only source → no key\n";
    Scenario muted = base; muted.mutedSource = true;
    CHECK(runScenario(ss, muted).scPeak == 0.0f, "muted source produces no key");
    Scenario vis = base; vis.visualOnlySrc = true;
    CHECK(runScenario(ss, vis).scPeak == 0.0f, "visual-only source produces no key");

    // ── F: gain scales the key only ────────────────────────────────────────────
    std::cout << "[F] Gain scales key buffer\n";
    Scenario gHalf = base; gHalf.gain = 0.5f;
    Result gFull = withRoute;             // gain 1.0 already rendered above
    Result gHalfRes = runScenario(ss, gHalf);
    std::cout << "    scPeak(g=1)=" << gFull.scPeak << " scPeak(g=0.5)=" << gHalfRes.scPeak << "\n";
    CHECK(gHalfRes.scPeak > 0.0f, "gain 0.5 still delivers a key");
    CHECK(std::abs(gHalfRes.scPeak - 0.5f * gFull.scPeak) < 0.05f * gFull.scPeak,
          "key peak scales ~linearly with route gain");
    // Master is unaffected by gain (key is silent).
    CHECK(maxAbsDiff(gHalfRes.master, gFull.master) < 1e-6, "key gain does not change audible master");

    // ── G: pre-fader vs post-fader tap point ──────────────────────────────────
    std::cout << "[G] preFader ignores the source fader; postFader follows it\n";
    Scenario preLow;  preLow.preFader  = true;  preLow.sourceVolume = 0.25f;
    Scenario postLow; postLow.preFader = false; postLow.sourceVolume = 0.25f;
    Result preRes  = runScenario(ss, preLow);
    Result postRes = runScenario(ss, postLow);
    std::cout << "    scPeak(pre, vol .25)=" << preRes.scPeak
              << " scPeak(post, vol .25)=" << postRes.scPeak << "\n";
    CHECK(preRes.scPeak  > 0.0f, "pre-fader tap delivers a key");
    CHECK(postRes.scPeak > 0.0f, "post-fader tap delivers a key");
    CHECK(preRes.scPeak > postRes.scPeak * 1.5f,
          "pre-fader key ignores the low source fader; post-fader key is attenuated");

    // ── H: solo target keeps the source processed sidechain-only ──────────────
    std::cout << "[H] Solo target → source feeds key sidechain-only (inaudible)\n";
    Scenario soloT = base; soloT.soloTarget = true;
    Result soloRes = runScenario(ss, soloT);
    CHECK(soloRes.scPeak > 0.01f, "target-soloed source still feeds its key (feedsSidechainOnly)");
    CHECK(soloRes.recvBlocks > 0, "soloed target chain still runs");
    // The source (routed to Master, not the soloed target's path) is inaudible:
    // master holds only the target's own lead, so it is non-silent but the source
    // never sums in. (Energy sanity — exact separation is covered by 2B tests.)
    CHECK(totalEnergy(soloRes.master) > 1e-4, "soloed target is audible");

    ss.dir.deleteRecursively();

    std::cout << "\n=== Results: " << g_passed << " passed, " << g_failed << " failed ===\n";
    if (g_failed > 0) { std::cerr << "FAILED: " << g_failed << " test(s) failed\n"; return 1; }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
