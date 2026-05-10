// test_pdc_stage1.cpp -- latency observability and PDC regression probes.
// Build: cmake --build build --target test_pdc_stage1 --config Debug
// Run:   build\engine\Debug\test_pdc_stage1.exe

#define XLETH_RESONANCE_SUPPRESSOR_TEST_HOOKS 1

#include "audio/AudioGraph.h"
#include "audio/MixEngine.h"
#include "audio/XlethCompressorEffect.h"
#include "audio/XlethDelayEffect.h"
#include "audio/XlethDistortionEffect.h"
#include "audio/XlethEQEffect.h"
#include "audio/GuardedPluginWrapper.h"
#include "audio/XlethLimiterEffect.h"
#include "audio/XlethOTTEffect.h"
#include "audio/XlethResonanceSuppressorEffect.h"
#include "audio/XlethReverbEffect.h"
#include "audio/XlethTransientProcEffect.h"
#include "audio/XlethWaveshaperEffect.h"
#include "AudioEngine.h"
#include "export/AudioExporter.h"
#include "FrameCache.h"
#include "model/Timeline.h"
#include "SampleBank.h"
#include "SyncManager.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <functional>
#include <memory>
#include <iostream>
#include <string>
#include <vector>

static int g_passed = 0;
static int g_failed = 0;
static int g_xfailed = 0;
static int g_xpassed = 0;

#define CHECK(cond, msg)                                                      \
    do {                                                                      \
        if (cond) {                                                           \
            ++g_passed;                                                       \
        } else {                                                              \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";       \
            ++g_failed;                                                       \
        }                                                                     \
    } while (0)

static std::vector<float> makeDetectorSpectrum(int numBins, float fillDb)
{
    std::vector<float> spectrum(static_cast<std::size_t>(numBins), fillDb);
    if (numBins > 0)
        spectrum.front() = -240.0f;
    if (numBins > 1)
        spectrum.back() = -240.0f;
    return spectrum;
}

static void assertDetectorBaselineEquivalent(const std::string& label,
                                             const std::vector<float>& spectrum,
                                             int centerGap,
                                             float toleranceDb)
{
    const auto result =
        XlethResonanceSuppressorEffect::computeDetectorBaselinesForTest(spectrum, centerGap);

    CHECK(result.reference.size() == spectrum.size(),
          label + " reference baseline size should match spectrum");
    CHECK(result.prefix.size() == spectrum.size(),
          label + " prefix baseline size should match spectrum");

    float maxDiff = 0.0f;
    int maxBin = 0;
    bool finite = true;
    for (int k = 1; k + 1 < static_cast<int>(spectrum.size()); ++k)
    {
        const float ref = result.reference[static_cast<std::size_t>(k)];
        const float opt = result.prefix[static_cast<std::size_t>(k)];
        finite = finite && std::isfinite(ref) && std::isfinite(opt);
        const float diff = std::abs(ref - opt);
        if (diff > maxDiff)
        {
            maxDiff = diff;
            maxBin = k;
        }
    }

    CHECK(finite, label + " detector baselines should be finite");
    CHECK(maxDiff <= toleranceDb,
          label + " prefix baseline should match slow range scan, max diff "
              + std::to_string(maxDiff) + " dB at bin " + std::to_string(maxBin));
}

static void configureSpectralBand(XlethParametricEQ& eq)
{
    if (eq.getBandCount() == 0)
    {
        const int band = eq.addBand();
        CHECK(band == 0, "EQ should add the first spectral test band at index 0");
    }

    CHECK(eq.setBandParam(0, "freq", 1000.0f), "spectral EQ freq should be settable");
    CHECK(eq.setBandParam(0, "gain", 0.0f), "spectral EQ gain should be settable");
    CHECK(eq.setBandParam(0, "q", 1.0f), "spectral EQ Q should be settable");
    CHECK(eq.setBandParam(0, "type", 0.0f), "spectral EQ type should be settable");
    CHECK(eq.setBandParam(0, "enabled", 1.0f), "spectral EQ band should be enabled");
    CHECK(eq.setBandParam(0, "mode", 2.0f), "spectral EQ mode should be Spectral");
    CHECK(eq.setBandParam(0, "spec_depth", 0.0f), "spectral EQ depth should be settable");
}

static void processEqDiagnosticBlock(XlethParametricEQ& eq,
                                     double sampleRate = 48000.0,
                                     int blockSize = 512)
{
    juce::AudioBuffer<float> buffer(2, blockSize);
    for (int s = 0; s < blockSize; ++s)
    {
        const float v = 0.05f * std::sin(2.0f * juce::MathConstants<float>::pi
            * 1000.0f * static_cast<float>(s) / static_cast<float>(sampleRate));
        buffer.setSample(0, s, v);
        buffer.setSample(1, s, v);
    }

    juce::MidiBuffer midi;
    eq.processBlock(buffer, midi);
}

static XlethParametricEQ* requireSpectralEq(XlethEffectBase* effect, const char* label)
{
    auto* eq = dynamic_cast<XlethParametricEQ*>(effect);
    CHECK(eq != nullptr, std::string(label) + " should be an XlethParametricEQ");
    if (eq != nullptr)
        configureSpectralBand(*eq);
    return eq;
}

static void testXlethEqSpectralLatency()
{
    std::cout << "[EQ] Spectral latency diagnostics\n";

    XlethParametricEQ eq;
    eq.prepareToPlay(48000.0, 512);

    CHECK(eq.getReportedProcessorLatencySamples() == 0,
          "EQ should report zero processor latency before Spectral is enabled");

    const auto processUpdatesBefore = eq.getProcessBlockLatencyUpdateCount();
    const auto nonRealtimeUpdatesBefore = eq.getNonRealtimeLatencyUpdateCount();
    configureSpectralBand(eq);

    CHECK(eq.getProcessBlockLatencyUpdateCount() == processUpdatesBefore,
          "Spectral EQ should not update reported latency from processBlock");
    CHECK(eq.getNonRealtimeLatencyUpdateCount() == nonRealtimeUpdatesBefore + 1,
          "Spectral EQ should update reported latency once from the parameter path");

    CHECK(eq.getLatencySamples() == XlethParametricEQ::kSTFTHop,
          "Spectral EQ getLatencySamples should equal kSTFTHop");
    CHECK(eq.getReportedProcessorLatencySamples() == XlethParametricEQ::kSTFTHop,
          "Spectral EQ AudioProcessor latency should be updated before processBlock");

    processEqDiagnosticBlock(eq);
    processEqDiagnosticBlock(eq);
    CHECK(eq.getProcessBlockLatencyUpdateCount() == processUpdatesBefore,
          "Spectral EQ processBlock should not call setLatencySamples on steady-state blocks");
    CHECK(eq.getNonRealtimeLatencyUpdateCount() == nonRealtimeUpdatesBefore + 1,
          "Spectral EQ should not double-count latency on steady-state processBlock calls");

    CHECK(eq.setBandParam(0, "mode", 0.0f), "spectral EQ mode should return to Normal");
    CHECK(eq.getReportedProcessorLatencySamples() == 0,
          "Spectral EQ should return reported processor latency to zero when disabled before processBlock");
    CHECK(eq.getProcessBlockLatencyUpdateCount() == processUpdatesBefore,
          "Spectral disable should not update reported latency from processBlock");
    CHECK(eq.getNonRealtimeLatencyUpdateCount() == nonRealtimeUpdatesBefore + 2,
          "Spectral EQ should call setLatencySamples once from the parameter path when disabled");
}

static void testXlethEqLatencyAffectingParameterPaths()
{
    std::cout << "[EQ] Latency-affecting parameter paths\n";

    {
        XlethParametricEQ eq;
        eq.prepareToPlay(48000.0, 512);

        const auto processUpdatesBefore = eq.getProcessBlockLatencyUpdateCount();
        const auto nonRealtimeUpdatesBefore = eq.getNonRealtimeLatencyUpdateCount();

        CHECK(eq.setParameterValue("linphase", 1.0f),
              "linear-phase parameter should be settable");
        CHECK(eq.getReportedProcessorLatencySamples() == XlethParametricEQ::kSTFTHop,
              "linear-phase enable should report FIR latency before processBlock");
        CHECK(eq.getNonRealtimeLatencyUpdateCount() == nonRealtimeUpdatesBefore + 1,
              "linear-phase enable should update latency once from the parameter path");

        processEqDiagnosticBlock(eq);
        CHECK(eq.getProcessBlockLatencyUpdateCount() == processUpdatesBefore,
              "linear-phase processBlock should not call setLatencySamples");

        CHECK(eq.setParameterValue("linphase", 0.0f),
              "linear-phase parameter should disable");
        CHECK(eq.getReportedProcessorLatencySamples() == 0,
              "linear-phase disable should drop reported latency before processBlock");
        CHECK(eq.getNonRealtimeLatencyUpdateCount() == nonRealtimeUpdatesBefore + 2,
              "linear-phase disable should update latency once from the parameter path");
    }

    {
        XlethParametricEQ eq;
        eq.prepareToPlay(48000.0, 512);

        const auto processUpdatesBefore = eq.getProcessBlockLatencyUpdateCount();
        const auto nonRealtimeUpdatesBefore = eq.getNonRealtimeLatencyUpdateCount();

        CHECK(eq.setParameterValue("oversample", 1.0f),
              "oversampling parameter should be settable");
        const int osLatency = eq.getReportedProcessorLatencySamples();
        CHECK(osLatency > 0,
              "oversampling enable should report nonzero oversampler latency before processBlock");
        CHECK(eq.getNonRealtimeLatencyUpdateCount() == nonRealtimeUpdatesBefore + 1,
              "oversampling enable should update latency once from the parameter path");

        processEqDiagnosticBlock(eq);
        CHECK(eq.getProcessBlockLatencyUpdateCount() == processUpdatesBefore,
              "oversampling processBlock should not call setLatencySamples");

        CHECK(eq.setParameterValue("oversample", 0.0f),
              "oversampling parameter should disable");
        CHECK(eq.getReportedProcessorLatencySamples() == 0,
              "oversampling disable should drop reported latency before processBlock");
        CHECK(eq.getNonRealtimeLatencyUpdateCount() == nonRealtimeUpdatesBefore + 2,
              "oversampling disable should update latency once from the parameter path");
    }
}

static void testXlethEqStateRestoreLatencyBeforeProcessBlock()
{
    std::cout << "[EQ] State restore latency before processBlock\n";

    XlethParametricEQ source;
    source.prepareToPlay(48000.0, 512);
    configureSpectralBand(source);

    juce::MemoryBlock spectralState;
    source.getStateInformation(spectralState);

    XlethParametricEQ restored;
    restored.prepareToPlay(48000.0, 512);
    restored.setStateInformation(spectralState.getData(),
                                 static_cast<int>(spectralState.getSize()));
    CHECK(restored.getReportedProcessorLatencySamples() == XlethParametricEQ::kSTFTHop,
          "restored spectral EQ should report latency before first processBlock");
    CHECK(restored.getProcessBlockLatencyUpdateCount() == 0,
          "restored spectral EQ should not need processBlock latency updates");

    XlethParametricEQ sourceLinearOs;
    sourceLinearOs.prepareToPlay(48000.0, 512);
    CHECK(sourceLinearOs.setParameterValue("linphase", 1.0f),
          "state source linear phase should enable");
    CHECK(sourceLinearOs.setParameterValue("oversample", 1.0f),
          "state source oversampling should enable");
    const int expectedLinearOsLatency =
        sourceLinearOs.getReportedProcessorLatencySamples();

    juce::MemoryBlock linearOsState;
    sourceLinearOs.getStateInformation(linearOsState);

    XlethParametricEQ restoredLinearOs;
    restoredLinearOs.prepareToPlay(48000.0, 512);
    restoredLinearOs.setStateInformation(
        linearOsState.getData(), static_cast<int>(linearOsState.getSize()));
    CHECK(restoredLinearOs.getReportedProcessorLatencySamples()
              == expectedLinearOsLatency,
          "restored linear-phase + oversampling EQ should report combined latency before first processBlock");
    CHECK(restoredLinearOs.getProcessBlockLatencyUpdateCount() == 0,
          "restored linear-phase + oversampling EQ should not need processBlock latency updates");
}

static void processProcessorDiagnosticBlocks(juce::AudioProcessor& processor,
                                             int numBlocks = 3,
                                             int blockSize = 512)
{
    juce::AudioBuffer<float> buffer(2, blockSize);
    juce::MidiBuffer midi;
    for (int block = 0; block < numBlocks; ++block)
    {
        buffer.clear();
        for (int s = 0; s < blockSize; ++s)
        {
            const float v = (s == 0 && block == 0) ? 0.25f : 0.0f;
            buffer.setSample(0, s, v);
            buffer.setSample(1, s, v);
        }
        processor.processBlock(buffer, midi);
    }
}

static bool processResonanceHighQualityDiagnosticBlocks(
    XlethResonanceSuppressorEffect& resonance,
    int numBlocks = 8,
    int blockSize = 512,
    double sampleRate = 48000.0)
{
    juce::AudioBuffer<float> buffer(2, blockSize);
    juce::MidiBuffer midi;
    double phase = 0.0;
    const double phaseDelta = 2.0 * juce::MathConstants<double>::pi * 440.0 / sampleRate;

    for (int block = 0; block < numBlocks; ++block)
    {
        for (int s = 0; s < blockSize; ++s)
        {
            const float v = static_cast<float>(0.15 * std::sin(phase));
            phase += phaseDelta;
            if (phase >= 2.0 * juce::MathConstants<double>::pi)
                phase -= 2.0 * juce::MathConstants<double>::pi;

            buffer.setSample(0, s, v);
            buffer.setSample(1, s, 0.75f * v);
        }

        resonance.processBlock(buffer, midi);

        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
            for (int s = 0; s < buffer.getNumSamples(); ++s)
                if (!std::isfinite(buffer.getSample(ch, s)))
                    return false;
    }

    return true;
}

static void testResonanceSuppressorDetectorBaselinePrefixEquivalence()
{
    std::cout << "[Builtins] RS High Quality detector prefix baseline equivalence\n";

    constexpr int numBins = 1025;
    constexpr float toleranceDb = 0.01f;

    auto flat = makeDetectorSpectrum(numBins, -96.0f);
    assertDetectorBaselineEquivalent("flat spectrum", flat, 3, toleranceDb);

    auto singleSpike = makeDetectorSpectrum(numBins, -118.0f);
    singleSpike[static_cast<std::size_t>(256)] = -18.0f;
    assertDetectorBaselineEquivalent("single-bin spike", singleSpike, 3, toleranceDb);

    auto harmonics = makeDetectorSpectrum(numBins, -125.0f);
    for (int bin : {48, 96, 144, 192, 240, 288})
        harmonics[static_cast<std::size_t>(bin)] = -32.0f + static_cast<float>(bin % 5);
    assertDetectorBaselineEquivalent("multiple harmonic spikes", harmonics, 5, toleranceDb);

    auto randomDeterministic = makeDetectorSpectrum(numBins, -140.0f);
    std::uint32_t seed = 0x6b8b4567u;
    for (int k = 1; k < numBins - 1; ++k)
    {
        seed = seed * 1664525u + 1013904223u;
        const float unit = static_cast<float>((seed >> 8) & 0xffffu) / 65535.0f;
        randomDeterministic[static_cast<std::size_t>(k)] =
            -145.0f + unit * 118.0f + static_cast<float>((k % 11) - 5) * 0.13f;
    }
    assertDetectorBaselineEquivalent("random deterministic spectrum",
                                     randomDeterministic,
                                     2,
                                     toleranceDb);

    auto lowEdge = makeDetectorSpectrum(numBins, -112.0f);
    lowEdge[1] = -24.0f;
    lowEdge[2] = -35.0f;
    lowEdge[7] = -42.0f;
    assertDetectorBaselineEquivalent("low-bin edge", lowEdge, 4, toleranceDb);

    auto highEdge = makeDetectorSpectrum(numBins, -112.0f);
    highEdge[static_cast<std::size_t>(numBins - 2)] = -24.0f;
    highEdge[static_cast<std::size_t>(numBins - 3)] = -35.0f;
    highEdge[static_cast<std::size_t>(numBins - 8)] = -42.0f;
    assertDetectorBaselineEquivalent("high-bin edge", highEdge, 4, toleranceDb);

    auto nearFloor = makeDetectorSpectrum(numBins, -240.0f);
    for (int k = 1; k < numBins - 1; ++k)
        nearFloor[static_cast<std::size_t>(k)] =
            -240.0f + static_cast<float>(k % 17) * 0.0002f;
    assertDetectorBaselineEquivalent("near floor magnitudes", nearFloor, 1, toleranceDb);

    auto shapedSource = makeDetectorSpectrum(numBins, -120.0f);
    for (int k = 1; k < numBins - 1; ++k)
    {
        const float norm = static_cast<float>(k) / static_cast<float>(numBins - 1);
        const float broadWeightShape = 18.0f * std::sin(norm * juce::MathConstants<float>::pi);
        shapedSource[static_cast<std::size_t>(k)] =
            -132.0f + broadWeightShape + static_cast<float>(k % 23) * 0.07f;
    }
    assertDetectorBaselineEquivalent("weighted-shaped spectrum", shapedSource, 3, toleranceDb);
}

class FakeThirdPartyLatencyPlugin : public juce::AudioProcessor
{
public:
    explicit FakeThirdPartyLatencyPlugin(int initialLatency = 0)
        : juce::AudioProcessor(
              BusesProperties()
                  .withInput ("Input",  juce::AudioChannelSet::stereo(), true)
                  .withOutput("Output", juce::AudioChannelSet::stereo(), true))
    {
        setReportedLatency(initialLatency);
        latencyParam_ = new OwnedParameter(
            "latency", "latency", [this](float)
            {
                if (parameterLatency_ >= 0)
                    setReportedLatency(parameterLatency_);
            });
        addParameter(latencyParam_);

        bypassParam_ = new OwnedParameter(
            "bypass", "bypass", [this](float value)
            {
                bypassed_ = value >= 0.5f;
                setLatencySamples(bypassed_ ? bypassReportedLatency_ : activeLatency_);
            });
        addParameter(bypassParam_);
    }

    const juce::String getName() const override { return "FakeThirdPartyLatency"; }
    void prepareToPlay(double, int) override
    {
        if (prepareLatency_ >= 0)
            setReportedLatency(prepareLatency_);
    }
    void releaseResources() override {}
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override
    {
        if (processLatency_ >= 0)
            setReportedLatency(processLatency_);
    }

    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }
    bool hasEditor() const override { return false; }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    int getNumPrograms() override { return 2; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int index) override
    {
        if (index == 1 && programLatency_ >= 0)
            setReportedLatency(programLatency_);
    }
    const juce::String getProgramName(int index) override
    {
        return index == 1 ? "Latent" : "Default";
    }
    void changeProgramName(int, const juce::String&) override {}
    juce::AudioProcessorParameter* getBypassParameter() const override
    {
        return bypassParam_;
    }
    void getStateInformation(juce::MemoryBlock& destData) override
    {
        const int latency = getLatencySamples();
        destData.replaceAll(&latency, sizeof(latency));
    }
    void setStateInformation(const void* data, int sizeInBytes) override
    {
        if (data == nullptr || sizeInBytes < static_cast<int>(sizeof(int)))
            return;
        int latency = 0;
        std::memcpy(&latency, data, sizeof(latency));
        setReportedLatency(latency);
    }

    void setReportedLatency(int samples)
    {
        activeLatency_ = juce::jmax(0, samples);
        setLatencySamples(bypassed_ ? bypassReportedLatency_ : activeLatency_);
    }

    void setPrepareLatency(int samples) { prepareLatency_ = samples; }
    void setProcessLatency(int samples) { processLatency_ = samples; }
    void setParameterLatency(int samples) { parameterLatency_ = samples; }
    void setProgramLatency(int samples) { programLatency_ = samples; }
    void setBypassReportedLatency(int samples) { bypassReportedLatency_ = juce::jmax(0, samples); }

private:
    class OwnedParameter : public juce::AudioProcessorParameterWithID
    {
    public:
        OwnedParameter(const juce::String& id,
                       const juce::String& name,
                       std::function<void(float)> onSet)
            : juce::AudioProcessorParameterWithID(id, name)
            , onSet_(std::move(onSet))
        {}

        float getValue() const override { return value_; }
        void setValue(float newValue) override
        {
            value_ = juce::jlimit(0.0f, 1.0f, newValue);
            if (onSet_)
                onSet_(value_);
        }
        float getDefaultValue() const override { return 0.0f; }
        juce::String getName(int) const override { return name; }
        juce::String getLabel() const override { return {}; }
        float getValueForText(const juce::String& text) const override
        {
            return text.getFloatValue();
        }

    private:
        float value_ = 0.0f;
        std::function<void(float)> onSet_;
    };

    int prepareLatency_ = -1;
    int processLatency_ = -1;
    int parameterLatency_ = -1;
    int programLatency_ = -1;
    int activeLatency_ = 0;
    int bypassReportedLatency_ = 0;
    bool bypassed_ = false;
    OwnedParameter* latencyParam_ = nullptr;
    OwnedParameter* bypassParam_ = nullptr;
};

static std::unique_ptr<GuardedPluginWrapper>
makeGuardedFake(FakeThirdPartyLatencyPlugin** outFake, int initialLatency)
{
    auto fake = std::make_unique<FakeThirdPartyLatencyPlugin>(initialLatency);
    if (outFake != nullptr)
        *outFake = fake.get();
    return std::make_unique<GuardedPluginWrapper>(std::move(fake));
}

static void testBuiltinLatencyAuditProcessBlockNoPublish()
{
    std::cout << "[Builtins] processBlock latency publish audit\n";

    XlethCompressorEffect compressor;
    compressor.prepareToPlay(48000.0, 512);
    CHECK(compressor.setParameterValue("lookahead", 5.0f),
          "compressor lookahead should be settable");
    const int compressorLatency = compressor.getReportedProcessorLatencySamples();
    processProcessorDiagnosticBlocks(compressor);
    CHECK(compressor.getReportedProcessorLatencySamples() == compressorLatency,
          "compressor processBlock should not change reported latency");
    CHECK(compressor.getProcessBlockLatencyUpdateCount() == 0,
          "compressor processBlock latency update counter should remain zero");

    XlethLimiterEffect limiter;
    limiter.prepareToPlay(48000.0, 512);
    CHECK(limiter.setParameterValue("style", 2.0f),
          "limiter style should be settable");
    const int limiterLatency = limiter.getReportedProcessorLatencySamples();
    processProcessorDiagnosticBlocks(limiter);
    CHECK(limiter.getReportedProcessorLatencySamples() == limiterLatency,
          "limiter processBlock should not change reported latency");
    CHECK(limiter.getProcessBlockLatencyUpdateCount() == 0,
          "limiter processBlock latency update counter should remain zero");

    XlethResonanceSuppressorEffect resonance;
    resonance.prepareToPlay(48000.0, 512);
    CHECK(resonance.setParameterValue("processing_mode", 1.0f),
          "resonance suppressor processing mode should be settable");
    CHECK(resonance.setParameterValue("quality", 2.0f),
          "resonance suppressor quality should be settable");
    const int resonanceLatency = resonance.getReportedProcessorLatencySamples();
    processProcessorDiagnosticBlocks(resonance);
    CHECK(resonance.getReportedProcessorLatencySamples() == resonanceLatency,
          "resonance suppressor processBlock should not change reported latency");
    CHECK(resonance.getProcessBlockLatencyUpdateCount() == 0,
          "resonance suppressor processBlock latency update counter should remain zero");

    XlethDistortionEffect distortion;
    distortion.prepareToPlay(48000.0, 512);
    const int distortionLatency = distortion.getLatencySamples();
    CHECK(distortionLatency > 0,
          "distortion should report static oversampling latency after prepare");
    processProcessorDiagnosticBlocks(distortion);
    CHECK(distortion.getLatencySamples() == distortionLatency,
          "distortion processBlock should keep static oversampling latency stable");

    XlethWaveshaperEffect waveshaper;
    waveshaper.prepareToPlay(48000.0, 512);
    const int waveshaperLatency = waveshaper.getLatencySamples();
    CHECK(waveshaperLatency > 0,
          "waveshaper should report static oversampling latency after prepare");
    processProcessorDiagnosticBlocks(waveshaper);
    CHECK(waveshaper.getLatencySamples() == waveshaperLatency,
          "waveshaper processBlock should keep static oversampling latency stable");

    XlethDelayEffect delay;
    delay.prepareToPlay(48000.0, 512);
    CHECK(delay.getLatencySamples() == 0,
          "delay tail should not be reported as plugin latency");
    CHECK(delay.getTailLengthSeconds() > 0.0,
          "delay should expose feedback tail separately from latency");

    XlethReverbEffect reverb;
    reverb.prepareToPlay(48000.0, 512);
    CHECK(reverb.getLatencySamples() == 0,
          "reverb tail should not be reported as plugin latency");
    CHECK(reverb.getTailLengthSeconds() > 0.0,
          "reverb should expose decay tail separately from latency");

    XlethOTTEffect ott;
    ott.prepareToPlay(48000.0, 512);
    processProcessorDiagnosticBlocks(ott);
    CHECK(ott.getLatencySamples() == 0,
          "OTT multiband dynamics should remain zero-latency");

    XlethTransientProcEffect transient;
    transient.prepareToPlay(48000.0, 512);
    processProcessorDiagnosticBlocks(transient);
    CHECK(transient.getLatencySamples() == 0,
          "transient processor should remain zero-latency");
}

static void testResonanceSuppressorHighQualityOutputStability()
{
    std::cout << "[Builtins] RS High Quality WOLA output stability\n";

    XlethResonanceSuppressorEffect resonance;
    resonance.prepareToPlay(48000.0, 512);
    CHECK(resonance.setParameterValue("processing_mode", 1.0f),
          "RS should switch to High Quality");
    CHECK(resonance.setParameterValue("quality", 2.0f),
          "RS High quality should be settable");
    CHECK(resonance.getReportedProcessorLatencySamples() == 2048,
          "RS High quality should keep reporting 2048 samples");

    const auto processUpdatesBefore = resonance.getProcessBlockLatencyUpdateCount();
    const int latencyBefore = resonance.getReportedProcessorLatencySamples();
    CHECK(processResonanceHighQualityDiagnosticBlocks(resonance),
          "RS High Quality WOLA output should remain finite");
    CHECK(resonance.getReportedProcessorLatencySamples() == latencyBefore,
          "RS High Quality WOLA processing should not change reported latency");
    CHECK(resonance.getProcessBlockLatencyUpdateCount() == processUpdatesBefore,
          "RS High Quality WOLA processing should not publish latency from processBlock");

    CHECK(resonance.setParameterValue("wc_b2_gain", 6.0f),
          "RS weighting curve parameter should be settable");
    CHECK(processResonanceHighQualityDiagnosticBlocks(resonance),
          "RS High Quality WOLA should remain finite after weighting-cache refresh");
    CHECK(resonance.getReportedProcessorLatencySamples() == 2048,
          "RS weighting changes should not alter High Quality latency");
}

static void testGuardedPluginWrapperLatencyRefreshContract()
{
    std::cout << "[GuardedPluginWrapper] Third-party latency refresh contract\n";

    FakeThirdPartyLatencyPlugin* fake = nullptr;
    auto wrapper = makeGuardedFake(&fake, 64);
    CHECK(wrapper->getReportedProcessorLatencySamples() == 64,
          "wrapper constructor should publish initial third-party latency");
    CHECK(wrapper->getLatencyChangePublishCount() == 1,
          "constructor publish should count as one latency change");

    fake->setPrepareLatency(128);
    wrapper->prepareToPlay(48000.0, 512);
    CHECK(wrapper->getReportedProcessorLatencySamples() == 128,
          "prepare should refresh third-party latency");
    CHECK(wrapper->getLatencyChangePublishCount() == 2,
          "prepare latency change should publish once");

    const auto refreshCountBefore = wrapper->getNonRealtimeLatencyRefreshCount();
    const auto publishCountBefore = wrapper->getLatencyChangePublishCount();
    fake->setParameterLatency(2048);
    CHECK(wrapper->setWrappedParameterValue("#0", 0.5f),
          "wrapper should apply third-party normalized parameter by index");
    CHECK(wrapper->hasPendingLatencyChangeFlag(),
          "parameter path should flag that latency may have changed");
    CHECK(wrapper->refreshReportedLatency(),
          "owner refresh should publish latency changed by parameter-like call");
    CHECK(wrapper->getReportedProcessorLatencySamples() == 2048,
          "parameter-owner refresh should publish the fake plugin latency");
    CHECK(wrapper->getNonRealtimeLatencyRefreshCount() == refreshCountBefore + 1,
          "explicit owner refresh should bump the non-realtime refresh counter");
    CHECK(wrapper->getLatencyChangePublishCount() == publishCountBefore + 1,
          "changed owner refresh should bump publish count once");
    CHECK(wrapper->getPendingLatencyChangeFlagCount() == 1,
          "parameter route should expose the pending latency flag counter");

    const auto noOpEpochPublish = wrapper->getLatencyChangePublishCount();
    CHECK(!wrapper->refreshReportedLatency(),
          "unchanged latency refresh should be a no-op");
    CHECK(wrapper->getLatencyChangePublishCount() == noOpEpochPublish,
          "unchanged refresh should not publish duplicate latency");

    int restoredLatency = 777;
    wrapper->setStateInformation(&restoredLatency, sizeof(restoredLatency));
    CHECK(wrapper->getReportedProcessorLatencySamples() == restoredLatency,
          "state restore should publish latency before first processBlock");

    fake->setProcessLatency(999);
    processProcessorDiagnosticBlocks(*wrapper, 4);
    CHECK(wrapper->getProcessBlockLatencyPublishCount() == 0,
          "wrapper processBlock should never publish latency");
    CHECK(wrapper->getReportedProcessorLatencySamples() == restoredLatency,
          "wrapper processBlock should not poll or publish inner latency changes");
}

static void testDynamicBuiltinLatencyParameterAndStateRestore()
{
    std::cout << "[Builtins] Dynamic latency parameter and state paths\n";

    XlethCompressorEffect compressor;
    compressor.prepareToPlay(48000.0, 512);
    const auto compressorUpdatesBefore = compressor.getNonRealtimeLatencyUpdateCount();
    CHECK(compressor.setParameterValue("lookahead", 5.0f),
          "compressor lookahead should update through parameter path");
    CHECK(compressor.getReportedProcessorLatencySamples() == 240,
          "compressor 5ms lookahead should report 240 samples at 48k before processBlock");
    CHECK(compressor.getNonRealtimeLatencyUpdateCount() == compressorUpdatesBefore + 1,
          "compressor lookahead should publish latency once from non-audio path");

    juce::MemoryBlock compressorState;
    compressor.getStateInformation(compressorState);
    XlethCompressorEffect restoredCompressor;
    restoredCompressor.prepareToPlay(48000.0, 512);
    restoredCompressor.setStateInformation(compressorState.getData(),
                                           static_cast<int>(compressorState.getSize()));
    CHECK(restoredCompressor.getReportedProcessorLatencySamples() == 240,
          "restored compressor lookahead latency should be visible before first processBlock");

    XlethLimiterEffect limiter;
    limiter.prepareToPlay(48000.0, 512);
    const int limiterDefaultLatency = limiter.getReportedProcessorLatencySamples();
    CHECK(limiter.setParameterValue("style", 2.0f),
          "limiter style should update through parameter path");
    const int limiterAggressiveLatency = limiter.getReportedProcessorLatencySamples();
    CHECK(limiterAggressiveLatency > 0
              && limiterAggressiveLatency != limiterDefaultLatency,
          "limiter style change should publish a deterministic latency change before processBlock");

    juce::MemoryBlock limiterState;
    limiter.getStateInformation(limiterState);
    XlethLimiterEffect restoredLimiter;
    restoredLimiter.prepareToPlay(48000.0, 512);
    restoredLimiter.setStateInformation(limiterState.getData(),
                                        static_cast<int>(limiterState.getSize()));
    CHECK(restoredLimiter.getReportedProcessorLatencySamples() == limiterAggressiveLatency,
          "restored limiter style latency should be visible before first processBlock");

    XlethResonanceSuppressorEffect resonance;
    resonance.prepareToPlay(48000.0, 512);
    CHECK(resonance.getReportedProcessorLatencySamples() == 0,
          "resonance suppressor low-latency mode should start at zero latency");
    CHECK(resonance.setParameterValue("processing_mode", 1.0f),
          "resonance suppressor should switch to high-quality mode");
    CHECK(resonance.getReportedProcessorLatencySamples() == 1024,
          "resonance suppressor high-quality normal mode should report 1024 samples");
    CHECK(resonance.setParameterValue("quality", 2.0f),
          "resonance suppressor high quality should be settable");
    CHECK(resonance.getReportedProcessorLatencySamples() == 2048,
          "resonance suppressor high-quality high mode should report 2048 samples before processBlock");
    juce::MemoryBlock resonanceHighLatencyState;
    resonance.getStateInformation(resonanceHighLatencyState);
    CHECK(resonance.setParameterValue("mix", 0.0f),
          "resonance suppressor dry mix should be settable");
    CHECK(resonance.getReportedProcessorLatencySamples() == 0,
          "resonance suppressor dry-only output should drop PDC latency before processBlock");

    XlethResonanceSuppressorEffect restoredResonance;
    restoredResonance.prepareToPlay(48000.0, 512);
    restoredResonance.setStateInformation(
        resonanceHighLatencyState.getData(),
        static_cast<int>(resonanceHighLatencyState.getSize()));
    CHECK(restoredResonance.getReportedProcessorLatencySamples() == 2048,
          "restored resonance suppressor high-quality latency should be visible before first processBlock");
}

static void testAudioGraphLatencyEpochAndTopology()
{
    std::cout << "[Graph] Output latency cache and epoch\n";

    AudioGraph graph;
    graph.init(48000.0, 512);

    const int nodeId = graph.addEffect("xletheq", 0);
    CHECK(nodeId >= 0, "AudioGraph should add XlethEQ");

    auto* eq = requireSpectralEq(graph.getEffect(nodeId), "graph effect");
    CHECK(eq != nullptr, "graph EQ should be available for diagnostics");

    const auto epochBefore = graph.getLatencyEpoch();
    graph.refreshLatencyDiagnostics();

    CHECK(graph.getOutputLatencySamples() == XlethParametricEQ::kSTFTHop,
          "AudioGraph output latency should expose the Spectral EQ chain latency");
    CHECK(graph.getLatencyEpoch() == epochBefore + 1,
          "AudioGraph latency epoch should increment on explicit PDC recompute");

    const auto topology = graph.getGraphTopology();
    bool sawOutputLatency = false;
    for (const auto& node : topology.value("nodes", nlohmann::json::array()))
    {
        if (node.value("pluginId", "") == "__output__")
            sawOutputLatency = (node.value("cumulativeLatency", -1)
                                == XlethParametricEQ::kSTFTHop);
    }
    CHECK(sawOutputLatency,
          "AudioGraph topology output node should report cached output latency");
}

static void testAudioGraphLatencyChangePropagation()
{
    std::cout << "[Graph] XlethEQ latency-change propagation\n";

    AudioGraph graph;
    graph.init(48000.0, 512);

    const int nodeId = graph.addEffect("xletheq", 0);
    CHECK(nodeId >= 0, "AudioGraph should add propagation XlethEQ");

    auto* eq = dynamic_cast<XlethParametricEQ*>(graph.getEffect(nodeId));
    CHECK(eq != nullptr, "AudioGraph propagation effect should be XlethEQ");
    if (eq == nullptr) return;

    CHECK(eq->addBand() == 0, "AudioGraph propagation EQ should add a band");
    graph.refreshLatencyDiagnostics();
    const auto epochBeforeSpectral = graph.getLatencyEpoch();

    CHECK(graph.setEffectParameter(nodeId, "b0_mode", 2.0f),
          "AudioGraph should set Spectral mode through the owner path");
    CHECK(eq->getReportedProcessorLatencySamples() == XlethParametricEQ::kSTFTHop,
          "AudioGraph owner path should update EQ reported latency on Spectral enable");
    CHECK(graph.getOutputLatencySamples() == XlethParametricEQ::kSTFTHop,
          "AudioGraph output latency should update on Spectral enable");
    CHECK(graph.getLatencyEpoch() == epochBeforeSpectral + 1,
          "AudioGraph Spectral enable should trigger one PDC recompute");
    CHECK(eq->getProcessBlockLatencyUpdateCount() == 0,
          "AudioGraph Spectral enable should not rely on processBlock latency updates");

    const auto epochBeforeNormal = graph.getLatencyEpoch();
    CHECK(graph.setEffectParameter(nodeId, "b0_mode", 0.0f),
          "AudioGraph should set Normal mode through the owner path");
    CHECK(eq->getReportedProcessorLatencySamples() == 0,
          "AudioGraph owner path should update EQ reported latency on Spectral disable");
    CHECK(graph.getOutputLatencySamples() == 0,
          "AudioGraph output latency should update on Spectral disable");
    CHECK(graph.getLatencyEpoch() == epochBeforeNormal + 1,
          "AudioGraph Spectral disable should trigger one PDC recompute");

    const auto epochBeforeLinear = graph.getLatencyEpoch();
    CHECK(graph.setEffectParameter(nodeId, "linphase", 1.0f),
          "AudioGraph should set linear phase through the owner path");
    CHECK(graph.getOutputLatencySamples() == XlethParametricEQ::kSTFTHop,
          "AudioGraph output latency should update on linear-phase enable");
    CHECK(graph.getLatencyEpoch() == epochBeforeLinear + 1,
          "AudioGraph linear-phase enable should trigger one PDC recompute");

    const auto epochBeforeLinearOff = graph.getLatencyEpoch();
    CHECK(graph.setEffectParameter(nodeId, "linphase", 0.0f),
          "AudioGraph should disable linear phase through the owner path");
    CHECK(graph.getOutputLatencySamples() == 0,
          "AudioGraph output latency should update on linear-phase disable");
    CHECK(graph.getLatencyEpoch() == epochBeforeLinearOff + 1,
          "AudioGraph linear-phase disable should trigger one PDC recompute");

    const auto epochBeforeOs = graph.getLatencyEpoch();
    CHECK(graph.setEffectParameter(nodeId, "oversample", 1.0f),
          "AudioGraph should set oversampling through the owner path");
    CHECK(graph.getOutputLatencySamples() > 0,
          "AudioGraph output latency should update on oversampling enable");
    CHECK(graph.getLatencyEpoch() == epochBeforeOs + 1,
          "AudioGraph oversampling enable should trigger one PDC recompute");
}

static void testAudioGraphThirdPartyLatencyRefreshPropagation()
{
    std::cout << "[Graph] Third-party wrapper latency propagation\n";

    AudioGraph graph;
    graph.init(48000.0, 512);

    FakeThirdPartyLatencyPlugin* fake = nullptr;
    auto wrapper = makeGuardedFake(&fake, 0);
    const int nodeId = graph.addProcessorForTesting("fakevst", std::move(wrapper), 0);
    CHECK(nodeId >= 0, "AudioGraph should accept fake third-party wrapper");

    graph.refreshLatencyDiagnostics();
    CHECK(graph.getOutputLatencySamples() == 0,
          "third-party graph should start at zero latency");
    const auto epochBefore = graph.getLatencyEpoch();

    fake->setParameterLatency(1024);
    CHECK(graph.setEffectParameter(nodeId, "#0", 0.25f),
          "AudioGraph should route third-party parameter changes through the wrapper");
    CHECK(graph.getOutputLatencySamples() == 1024,
          "AudioGraph output latency should update after third-party parameter refresh");
    CHECK(graph.getLatencyEpoch() == epochBefore + 1,
          "third-party latency change should trigger one PDC recompute");

    auto* guarded = dynamic_cast<GuardedPluginWrapper*>(graph.getProcessor(nodeId));
    CHECK(guarded != nullptr, "graph fake processor should remain a guarded wrapper");
    if (guarded == nullptr)
        return;
    CHECK(guarded->getProcessBlockLatencyPublishCount() == 0,
          "third-party wrapper should not publish latency from processBlock");

    const auto epochBeforeNoOp = graph.getLatencyEpoch();
    CHECK(!graph.refreshGuardedPluginLatency(nodeId),
          "unchanged guarded latency refresh should report no owner change");
    CHECK(graph.getLatencyEpoch() == epochBeforeNoOp,
          "unchanged guarded refresh should not bump the graph latency epoch");

    fake->setReportedLatency(2048);
    CHECK(graph.refreshGuardedPluginLatency(nodeId),
          "owner refresh should detect third-party internal latency changes");
    CHECK(graph.getOutputLatencySamples() == 2048,
          "owner refresh should propagate third-party internal latency to graph PDC");
    CHECK(graph.getLatencyEpoch() == epochBeforeNoOp + 1,
          "changed owner refresh should bump the graph latency epoch once");
}

static void testAudioGraphThirdPartyProgramStateBypassAndEditorRoutes()
{
    std::cout << "[Graph] Third-party program/state/bypass/editor latency routes\n";

    AudioGraph graph;
    graph.init(48000.0, 512);

    FakeThirdPartyLatencyPlugin* fake = nullptr;
    auto wrapper = makeGuardedFake(&fake, 64);
    const int nodeId = graph.addProcessorForTesting("fakevst", std::move(wrapper), 0);
    CHECK(nodeId >= 0,
          "AudioGraph should accept fake third-party wrapper for route audit");
    graph.refreshLatencyDiagnostics();
    CHECK(graph.getOutputLatencySamples() == 64,
          "third-party route audit should start with constructor-published latency");

    auto* guarded = dynamic_cast<GuardedPluginWrapper*>(graph.getProcessor(nodeId));
    CHECK(guarded != nullptr,
          "third-party route audit node should expose GuardedPluginWrapper");
    if (guarded == nullptr)
        return;

    fake->setProgramLatency(512);
    const auto epochBeforeProgram = graph.getLatencyEpoch();
    CHECK(graph.setEffectProgram(nodeId, 1),
          "program changes should route through the AudioGraph owner path");
    CHECK(graph.getOutputLatencySamples() == 512,
          "program latency should publish before the next processBlock");
    CHECK(graph.getLatencyEpoch() == epochBeforeProgram + 1,
          "program latency change should rebuild graph PDC once");

    int restoredLatency = 777;
    const auto epochBeforeState = graph.getLatencyEpoch();
    CHECK(graph.setEffectStateInformation(nodeId, &restoredLatency, sizeof(restoredLatency)),
          "state restore should route through the AudioGraph owner path");
    CHECK(graph.getOutputLatencySamples() == restoredLatency,
          "state restore latency should publish before the next processBlock");
    CHECK(graph.getLatencyEpoch() == epochBeforeState + 1,
          "state restore latency change should rebuild graph PDC once");

    const auto epochBeforeNoOpState = graph.getLatencyEpoch();
    CHECK(graph.setEffectStateInformation(nodeId, &restoredLatency, sizeof(restoredLatency)),
          "unchanged state restore should still apply successfully");
    CHECK(graph.getLatencyEpoch() == epochBeforeNoOpState,
          "unchanged state restore should not churn graph PDC epochs");

    int editorStateLatency = 1025;
    const auto publishBeforeEditorState = guarded->getLatencyChangePublishCount();
    const auto epochBeforeEditorState = graph.getLatencyEpoch();
    guarded->setStateInformation(&editorStateLatency, sizeof(editorStateLatency));
    CHECK(graph.refreshGuardedPluginLatency(nodeId, publishBeforeEditorState),
          "editor STAT path should notify owner even when wrapper already published latency");
    CHECK(graph.getOutputLatencySamples() == editorStateLatency,
          "editor STAT latency should propagate to graph diagnostics");
    CHECK(graph.getLatencyEpoch() == epochBeforeEditorState + 1,
          "editor STAT latency change should rebuild graph PDC once");

    fake->setBypassReportedLatency(0);
    const auto epochBeforeBypass = graph.getLatencyEpoch();
    CHECK(graph.setBypass(nodeId, true),
          "third-party bypass should route through GuardedPluginWrapper");
    CHECK(graph.getOutputLatencySamples() == editorStateLatency,
          "bypassed inserted third-party plugin should preserve PDC latency");
    CHECK(graph.getLatencyEpoch() == epochBeforeBypass,
          "bypass that preserves latency should not churn graph PDC epochs");

    CHECK(graph.setBypass(nodeId, false),
          "third-party bypass disable should route through GuardedPluginWrapper");
    CHECK(graph.getOutputLatencySamples() == editorStateLatency,
          "re-enabled third-party plugin should keep the active latency");

    CHECK(graph.removeEffect(nodeId),
          "removing a third-party insert should remove it from latency accounting");
    CHECK(graph.getOutputLatencySamples() == 0,
          "removed third-party insert should contribute no PDC latency");
}

struct TwoTrackEngine
{
    Timeline timeline {120.0, 48000.0};
    MixEngine engine;
    int latentTrackId = -1;
    int dryTrackId = -1;
    int trackEqNodeId = -1;
    int masterEqNodeId = -1;
};

static std::unique_ptr<TwoTrackEngine> makeTwoTrackEngine(bool trackSpectral,
                                                          bool masterSpectral)
{
    auto fixture = std::make_unique<TwoTrackEngine>();

    TrackInfo latent; latent.name = "Latent";
    TrackInfo dry; dry.name = "Dry";
    fixture->latentTrackId = fixture->timeline.addTrack(latent);
    fixture->dryTrackId = fixture->timeline.addTrack(dry);

    fixture->engine.setTimeline(&fixture->timeline);
    fixture->engine.prepare(48000.0, 512);
    fixture->engine.setNonRealtime(true);

    if (trackSpectral)
    {
        fixture->trackEqNodeId =
            fixture->engine.addEffect(fixture->latentTrackId, "xletheq", 0);
        CHECK(fixture->trackEqNodeId >= 0, "latent track should accept XlethEQ");
        requireSpectralEq(
            fixture->engine.getEffectPtr(fixture->latentTrackId, fixture->trackEqNodeId),
            "track EQ");
    }

    if (masterSpectral)
    {
        fixture->masterEqNodeId = fixture->engine.addMasterEffect("xletheq", 0);
        CHECK(fixture->masterEqNodeId >= 0, "master should accept XlethEQ");
        requireSpectralEq(
            fixture->engine.getMasterEffectPtr(fixture->masterEqNodeId),
            "master EQ");
    }

    fixture->engine.refreshLatencyDiagnostics();
    return fixture;
}

static void testPdcRegressionAccounting()
{
    std::cout << "[PDC] Regression accounting probes\n";

    {
        auto fixture = makeTwoTrackEngine(true, false);
        const int trackLat = fixture->engine.getTrackInsertLatencySamples(fixture->latentTrackId);
        const int dryComp = fixture->engine.getTrackCompensationDelaySamples(fixture->dryTrackId);
        const int latentComp =
            fixture->engine.getTrackCompensationDelaySamples(fixture->latentTrackId);

        CHECK(
            fixture->engine.isInterTrackLatencyCompensationApplied()
                && trackLat == XlethParametricEQ::kSTFTHop
                && dryComp == XlethParametricEQ::kSTFTHop
                && latentComp == 0,
            "track_to_track_impulse_alignment: dry track should be delayed by the latent track insert latency before summing");
    }

    {
        auto fixture = makeTwoTrackEngine(false, true);
        const auto snapshot = fixture->engine.getLatencyCompensationSnapshot();

        CHECK(
            snapshot.maxAudibleTrackLatencySamples == 0
                && snapshot.masterInsertLatencySamples == XlethParametricEQ::kSTFTHop
                && fixture->engine.getTrackCompensationDelaySamples(fixture->dryTrackId) == 0,
            "master_only_latency_accounting: master insert latency should be reported separately from per-track compensation");
    }

    {
        auto fixture = makeTwoTrackEngine(true, true);
        const auto snapshot = fixture->engine.getLatencyCompensationSnapshot();
        const int dryComp = fixture->engine.getTrackCompensationDelaySamples(fixture->dryTrackId);
        const int latentComp =
            fixture->engine.getTrackCompensationDelaySamples(fixture->latentTrackId);

        CHECK(
            snapshot.maxAudibleTrackLatencySamples == XlethParametricEQ::kSTFTHop
                && snapshot.masterInsertLatencySamples == XlethParametricEQ::kSTFTHop
                && dryComp == XlethParametricEQ::kSTFTHop
                && latentComp == 0,
            "track_plus_master_accounting: track PDC and master/common-path latency should remain separate");

        const int totalExportPreroll =
            snapshot.maxAudibleTrackLatencySamples
            + snapshot.masterInsertLatencySamples;
        CHECK(
            totalExportPreroll == 2 * XlethParametricEQ::kSTFTHop,
            "export_preroll_discard_accounting: export preroll/discard should include maxTrackLatency + masterLatency");
    }
}

static void testMixEngineThirdPartyLatencyPropagation()
{
    std::cout << "[MixEngine] Third-party latency propagation\n";

    auto fixture = makeTwoTrackEngine(false, false);
    auto& mixer = fixture->engine;

    FakeThirdPartyLatencyPlugin* fake = nullptr;
    auto wrapper = makeGuardedFake(&fake, 0);
    const int nodeId = mixer.addProcessorForTesting(
        fixture->latentTrackId, "fakevst", std::move(wrapper), 0);
    CHECK(nodeId >= 0,
          "MixEngine should accept fake third-party wrapper on a track");

    mixer.refreshLatencyDiagnostics();
    CHECK(mixer.getTrackInsertLatencySamples(fixture->latentTrackId) == 0,
          "third-party track should start at zero latency");

    fake->setParameterLatency(2048);
    CHECK(mixer.setEffectParameter(fixture->latentTrackId, nodeId, "#0", 0.5f),
          "MixEngine should route third-party parameter changes through owners");
    mixer.refreshLatencyDiagnostics();

    auto snapshot = mixer.getLatencyCompensationSnapshot();
    CHECK(snapshot.maxAudibleTrackLatencySamples == 2048,
          "MixEngine max track latency should update after third-party latency change");
    CHECK(mixer.getTrackCompensationDelaySamples(fixture->dryTrackId) == 2048,
          "MixEngine inter-track PDC should compensate against third-party latency");

    const int totalExportPreroll =
        snapshot.maxAudibleTrackLatencySamples + snapshot.masterInsertLatencySamples;
    CHECK(totalExportPreroll == 2048,
          "export accounting should use refreshed third-party chain latency");

    fake->setProgramLatency(3072);
    CHECK(mixer.setEffectProgram(fixture->latentTrackId, nodeId, 1),
          "MixEngine should route third-party program changes through owners");
    mixer.refreshLatencyDiagnostics();
    snapshot = mixer.getLatencyCompensationSnapshot();
    CHECK(snapshot.maxAudibleTrackLatencySamples == 3072,
          "MixEngine max track latency should update after third-party program change");

    int restoredLatency = 4096;
    CHECK(mixer.setEffectStateInformation(fixture->latentTrackId,
                                          nodeId,
                                          &restoredLatency,
                                          sizeof(restoredLatency)),
          "MixEngine should route third-party state restore through owners");
    mixer.refreshLatencyDiagnostics();
    snapshot = mixer.getLatencyCompensationSnapshot();
    CHECK(snapshot.maxAudibleTrackLatencySamples == restoredLatency,
          "MixEngine max track latency should update after third-party state restore");

    auto audioEngine = std::make_unique<AudioEngine>();
    auto& liveMixer = audioEngine->getMixEngine();
    liveMixer.setTimeline(&fixture->timeline);
    liveMixer.prepare(48000.0, 512);
    liveMixer.setNonRealtime(true);
    FakeThirdPartyLatencyPlugin* liveFake = nullptr;
    auto liveWrapper = makeGuardedFake(&liveFake, 0);
    const int liveNode = liveMixer.addProcessorForTesting(
        fixture->latentTrackId, "fakevst", std::move(liveWrapper), 0);
    CHECK(liveNode >= 0,
          "AudioEngine MixEngine should accept fake third-party wrapper");
    liveFake->setParameterLatency(1024);
    CHECK(liveMixer.setEffectParameter(fixture->latentTrackId, liveNode, "#0", 0.25f),
          "live presentation path should route third-party parameter changes");
    audioEngine->setTestDeviceOutputLatencySamplesForDiagnostics(128);
    audioEngine->refreshLivePresentationLatency();
    const auto diagnostics = audioEngine->getLivePresentationLatencyDiagnostics();
    CHECK(diagnostics.maxTrackLatencySamples == 1024,
          "live presentation diagnostics should include refreshed third-party latency");
    CHECK(diagnostics.totalPresentationLatencySamples == 1024 + 128,
          "live presentation total should keep the existing formula");

    const auto epochBeforeNoOp = mixer.getLatencyCompensationSnapshot();
    CHECK(!mixer.refreshGuardedPluginLatency(fixture->latentTrackId, nodeId),
          "MixEngine no-op guarded refresh should report unchanged latency");
    const auto snapshotAfterNoOp = mixer.getLatencyCompensationSnapshot();
    CHECK(snapshotAfterNoOp.maxAudibleTrackLatencySamples
              == epochBeforeNoOp.maxAudibleTrackLatencySamples,
          "MixEngine no-op guarded refresh should not churn compensation targets");
}

struct PresentationLatencyEngine
{
    Timeline timeline {120.0, 48000.0};
    AudioEngine engine;
    int latentTrackId = -1;
    int dryTrackId = -1;
    int trackEqNodeId = -1;
    int masterEqNodeId = -1;
};

static std::unique_ptr<PresentationLatencyEngine>
makePresentationLatencyEngine(bool trackSpectral,
                              bool masterSpectral,
                              int64_t deviceOutputLatency)
{
    auto fixture = std::make_unique<PresentationLatencyEngine>();

    TrackInfo latent; latent.name = "Presentation Latent";
    TrackInfo dry; dry.name = "Presentation Dry";
    fixture->latentTrackId = fixture->timeline.addTrack(latent);
    fixture->dryTrackId = fixture->timeline.addTrack(dry);

    auto& mixer = fixture->engine.getMixEngine();
    mixer.setTimeline(&fixture->timeline);
    mixer.prepare(48000.0, 512);
    mixer.setNonRealtime(true);

    auto& transport = fixture->engine.getTransport();
    transport.setSampleRate(48000.0);
    transport.setBPM(120.0);

    if (trackSpectral)
    {
        fixture->trackEqNodeId =
            mixer.addEffect(fixture->latentTrackId, "xletheq", 0);
        CHECK(fixture->trackEqNodeId >= 0,
              "presentation latent track should accept XlethEQ");
        requireSpectralEq(
            mixer.getEffectPtr(fixture->latentTrackId, fixture->trackEqNodeId),
            "presentation track EQ");
    }

    if (masterSpectral)
    {
        fixture->masterEqNodeId = mixer.addMasterEffect("xletheq", 0);
        CHECK(fixture->masterEqNodeId >= 0,
              "presentation master should accept XlethEQ");
        requireSpectralEq(
            mixer.getMasterEffectPtr(fixture->masterEqNodeId),
            "presentation master EQ");
    }

    mixer.refreshLatencyDiagnostics();
    fixture->engine.setTestDeviceOutputLatencySamplesForDiagnostics(deviceOutputLatency);
    fixture->engine.refreshLivePresentationLatency();
    return fixture;
}

static void testLivePresentationLatencyFormulaAndPositions()
{
    std::cout << "[Presentation] Latency formula and positions\n";

    constexpr int64_t kDeviceLatency = 512;
    auto fixture = makePresentationLatencyEngine(true, true, kDeviceLatency);
    auto& engine = fixture->engine;
    auto& transport = engine.getTransport();

    const auto diagnostics = engine.getLivePresentationLatencyDiagnostics();
    const int64_t expectedTotal =
        static_cast<int64_t>(XlethParametricEQ::kSTFTHop) * 2 + kDeviceLatency;

    CHECK(diagnostics.maxTrackLatencySamples == XlethParametricEQ::kSTFTHop,
          "presentation formula should include max audible track latency");
    CHECK(diagnostics.masterLatencySamples == XlethParametricEQ::kSTFTHop,
          "presentation formula should include master insert latency");
    CHECK(diagnostics.deviceOutputLatencySamples == kDeviceLatency,
          "presentation formula should include cached device output latency");
    CHECK(diagnostics.totalPresentationLatencySamples == expectedTotal,
          "presentation formula should sum track + master + device");
    CHECK(engine.getLivePresentationLatencySamples() == expectedTotal,
          "presentation latency getter should match diagnostic total");

    transport.seekToSample(expectedTotal - 128);
    CHECK(transport.getPositionSamples() == expectedTotal - 128,
          "raw transport position should remain unshifted below presentation latency");
    CHECK(engine.getLivePresentationPositionSamples() == 0,
          "presentation position should clamp to zero before latency has elapsed");

    transport.seekToSample(expectedTotal + 2048);
    CHECK(transport.getPositionSamples() == expectedTotal + 2048,
          "raw transport position should remain unshifted above presentation latency");
    CHECK(engine.getLivePresentationPositionSamples() == 2048,
          "presentation position should equal raw transport minus live latency");
    CHECK(std::abs(engine.getLivePresentationPositionSeconds()
                   - (2048.0 / 48000.0)) < 1.0e-9,
          "presentation seconds should derive from presentation samples");
}

static void testLivePresentationLatencyRefreshAfterEqChange()
{
    std::cout << "[Presentation] XlethEQ latency refresh after parameter change\n";

    constexpr int64_t kDeviceLatency = 128;
    auto fixture = makePresentationLatencyEngine(false, false, kDeviceLatency);
    auto& engine = fixture->engine;
    auto& mixer = engine.getMixEngine();

    fixture->trackEqNodeId = mixer.addEffect(fixture->latentTrackId, "xletheq", 0);
    CHECK(fixture->trackEqNodeId >= 0,
          "presentation refresh track should accept XlethEQ");

    auto* eq = dynamic_cast<XlethParametricEQ*>(
        mixer.getEffectPtr(fixture->latentTrackId, fixture->trackEqNodeId));
    CHECK(eq != nullptr, "presentation refresh track effect should be XlethEQ");
    if (eq == nullptr) return;

    CHECK(eq->addBand() == 0, "presentation refresh EQ should add a band");
    mixer.refreshLatencyDiagnostics();
    engine.refreshLivePresentationLatency();

    auto diagnostics = engine.getLivePresentationLatencyDiagnostics();
    CHECK(diagnostics.maxTrackLatencySamples == 0,
          "presentation refresh should start with zero track latency");

    CHECK(mixer.setEffectParameter(fixture->latentTrackId,
                                   fixture->trackEqNodeId,
                                   "b0_mode",
                                   2.0f),
          "presentation refresh should toggle Spectral through MixEngine");
    engine.refreshLivePresentationLatency();
    diagnostics = engine.getLivePresentationLatencyDiagnostics();
    CHECK(diagnostics.maxTrackLatencySamples == XlethParametricEQ::kSTFTHop,
          "presentation diagnostics should see Spectral track latency after parameter change");
    CHECK(diagnostics.totalPresentationLatencySamples
              == XlethParametricEQ::kSTFTHop + kDeviceLatency,
          "presentation total should refresh from MixEngine latency diagnostics");

    CHECK(mixer.setEffectParameter(fixture->latentTrackId,
                                   fixture->trackEqNodeId,
                                   "b0_mode",
                                   0.0f),
          "presentation refresh should toggle Spectral off through MixEngine");
    engine.refreshLivePresentationLatency();
    diagnostics = engine.getLivePresentationLatencyDiagnostics();
    CHECK(diagnostics.maxTrackLatencySamples == 0,
          "presentation diagnostics should drop Spectral track latency after parameter change");
    CHECK(diagnostics.totalPresentationLatencySamples == kDeviceLatency,
          "presentation total should drop back to device latency only");
}

static void testLivePresentationLatencyMasterTrackAndZeroCases()
{
    std::cout << "[Presentation] Master-only, track-only, and zero latency\n";

    constexpr int64_t kDeviceLatency = 256;

    {
        auto fixture = makePresentationLatencyEngine(false, true, kDeviceLatency);
        auto& engine = fixture->engine;
        const auto diagnostics = engine.getLivePresentationLatencyDiagnostics();
        CHECK(diagnostics.maxTrackLatencySamples == 0,
              "master-only presentation should have zero max track latency");
        CHECK(diagnostics.masterLatencySamples == XlethParametricEQ::kSTFTHop,
              "master-only presentation should include master latency");
        CHECK(engine.getMixEngine().getTrackCompensationDelaySamples(fixture->dryTrackId) == 0,
              "master-only latency should not become per-track compensation");
        CHECK(diagnostics.totalPresentationLatencySamples
                  == XlethParametricEQ::kSTFTHop + kDeviceLatency,
              "master-only presentation should lag by master + device latency");
    }

    {
        auto fixture = makePresentationLatencyEngine(true, false, kDeviceLatency);
        auto& engine = fixture->engine;
        const auto diagnostics = engine.getLivePresentationLatencyDiagnostics();
        CHECK(diagnostics.maxTrackLatencySamples == XlethParametricEQ::kSTFTHop,
              "track-only presentation should include max track latency");
        CHECK(diagnostics.masterLatencySamples == 0,
              "track-only presentation should have zero master latency");
        CHECK(engine.getMixEngine().getTrackCompensationDelaySamples(fixture->dryTrackId)
                  == XlethParametricEQ::kSTFTHop,
              "track-only presentation should preserve differential track PDC");
        CHECK(diagnostics.totalPresentationLatencySamples
                  == XlethParametricEQ::kSTFTHop + kDeviceLatency,
              "track-only presentation should lag by max track + device latency");
    }

    {
        auto fixture = makePresentationLatencyEngine(false, false, 0);
        auto& engine = fixture->engine;
        auto& transport = engine.getTransport();
        transport.seekToSample(4096);
        CHECK(engine.getLivePresentationLatencySamples() == 0,
              "zero-latency presentation should report zero total latency");
        CHECK(engine.getLivePresentationPositionSamples() == transport.getPositionSamples(),
              "zero-latency presentation should equal raw transport");
    }
}

// Stage 7B regression: live presentation latency and position must reflect
// MixEngine state after a chain mutation WITHOUT any caller invoking
// refreshLivePresentationLatency() or any transport / lifecycle event. This
// targets the exact failure mode that surfaced when adding RS HQ to one track
// in the NO MAIL project: per-route audio PDC adjusted, but the bridge-side
// presentation cache stayed pinned to the pre-mutation total, so the playhead
// drifted off-grid until the user pressed Stop/Play.
//
// Each subtest mutates state and then immediately reads
// getLivePresentationLatencySamples / getLivePresentationLatencyDiagnostics /
// getLivePresentationPositionSamples — no manual refresh, no seek, no replay.
static void testLivePresentationLatencyAutoRefreshAfterMutation()
{
    std::cout << "[Presentation] Live latency auto-refreshes after mutation (Stage 7B)\n";

    constexpr int64_t kDeviceLatency = 384;
    constexpr int64_t kHop = static_cast<int64_t>(XlethParametricEQ::kSTFTHop);

    // Helper: add an XlethEQ insert with a single band and toggle Spectral mode
    // through MixEngine — exactly the path the bridge uses for built-in effect
    // parameter changes (audio_setEffectParameter → MixEngine::setEffectParameter
    // → EffectChainManager::setEffectParameter → chain PDC recompute).
    auto addAndEnableSpectralViaMixer = [](MixEngine& mixer, int trackId) {
        const int eqNode = mixer.addEffect(trackId, "xletheq", 0);
        CHECK(eqNode >= 0, "Stage 7B helper: track should accept XlethEQ insert");
        auto* eq = dynamic_cast<XlethParametricEQ*>(
            mixer.getEffectPtr(trackId, eqNode));
        CHECK(eq != nullptr, "Stage 7B helper: inserted effect should be XlethEQ");
        if (eq != nullptr)
            CHECK(eq->addBand() == 0, "Stage 7B helper: EQ should add band 0");
        // The mode toggle is the latency-changing mutation that goes through
        // the MixEngine bridge surface — that path used to call
        // refreshLivePresentationLatency() in production. With Stage 7B the
        // refresh is no longer needed.
        CHECK(mixer.setEffectParameter(trackId, eqNode, "b0_mode", 2.0f),
              "Stage 7B helper: setEffectParameter should toggle spectral via MixEngine");
        return eqNode;
    };

    // ── 1. Track insert + parameter toggled via MixEngine, no manual refresh ──
    {
        auto fixture = makePresentationLatencyEngine(false, false, kDeviceLatency);
        auto& engine = fixture->engine;
        auto& mixer = engine.getMixEngine();

        CHECK(engine.getLivePresentationLatencySamples() == kDeviceLatency,
              "Stage 7B: baseline presentation latency should equal device output");

        addAndEnableSpectralViaMixer(mixer, fixture->latentTrackId);

        // No engine.refreshLivePresentationLatency() — that's the regression.
        const auto diag = engine.getLivePresentationLatencyDiagnostics();
        CHECK(diag.maxTrackLatencySamples == kHop,
              "Stage 7B: diagnostics maxTrack should reflect added insert without refresh");
        CHECK(diag.totalPresentationLatencySamples == kHop + kDeviceLatency,
              "Stage 7B: diagnostics total should reflect added insert without refresh");
        CHECK(engine.getLivePresentationLatencySamples() == kHop + kDeviceLatency,
              "Stage 7B: latency getter should reflect added insert without refresh");

        auto& transport = engine.getTransport();
        transport.seekToSample(kHop + kDeviceLatency + 1024);
        // Mutate again on the dry track — same MixEngine path — without any
        // further refresh. Both insertions should now contribute to the live
        // max-audible latency, and the position must subtract that updated
        // total instead of any stale cache.
        addAndEnableSpectralViaMixer(mixer, fixture->dryTrackId);
        CHECK(engine.getLivePresentationPositionSamples() == 1024,
              "Stage 7B: live position must subtract live latency, not stale cache");
    }

    // ── 2. Parameter change toggles latency mid-flight without manual refresh ──
    {
        auto fixture = makePresentationLatencyEngine(false, false, kDeviceLatency);
        auto& engine = fixture->engine;
        auto& mixer = engine.getMixEngine();

        const int eqNode = mixer.addEffect(fixture->latentTrackId, "xletheq", 0);
        CHECK(eqNode >= 0, "Stage 7B param: track should accept XlethEQ insert");
        auto* eq = dynamic_cast<XlethParametricEQ*>(
            mixer.getEffectPtr(fixture->latentTrackId, eqNode));
        CHECK(eq != nullptr, "Stage 7B param: inserted effect should be XlethEQ");
        CHECK(eq->addBand() == 0, "Stage 7B param: EQ should add the spectral test band");

        // Band still in non-spectral mode → zero added latency.
        CHECK(engine.getLivePresentationLatencySamples() == kDeviceLatency,
              "Stage 7B param: pre-spectral latency should match device only");

        // Toggle to spectral via the same MixEngine setter the bridge uses for
        // built-in parameter changes — this is the path that sets
        // pendingLatencyCompensationReset_ on the audio thread but, before
        // Stage 7B, never repaired the AudioEngine cache until next transport.
        CHECK(mixer.setEffectParameter(fixture->latentTrackId, eqNode, "b0_mode", 2.0f),
              "Stage 7B param: setEffectParameter should toggle spectral mode");

        // No refresh, no seek — just read.
        const auto diag = engine.getLivePresentationLatencyDiagnostics();
        CHECK(diag.maxTrackLatencySamples == kHop,
              "Stage 7B param: diagnostics should pick up post-parameter latency live");
        CHECK(engine.getLivePresentationLatencySamples() == kHop + kDeviceLatency,
              "Stage 7B param: latency getter should pick up post-parameter latency live");
    }

    // ── 3. Pre-existing master latency + new track latency, no double count ──
    // Mirrors the NO MAIL project shape: master RS HQ already present at load
    // time (fixture establishes the master spectral path), then the user adds
    // a latency-inducing insert to one individual track via the MixEngine
    // bridge surface.
    {
        auto fixture = makePresentationLatencyEngine(false, true, kDeviceLatency);
        auto& engine = fixture->engine;
        auto& mixer = engine.getMixEngine();

        // Master XlethEQ already configured by fixture (masterSpectral=true).
        CHECK(engine.getLivePresentationLatencyDiagnostics().masterLatencySamples == kHop,
              "Stage 7B master+track: master spectral latency should be reported");
        CHECK(engine.getLivePresentationLatencyDiagnostics().maxTrackLatencySamples == 0,
              "Stage 7B master+track: no track latency yet");

        // Add a track-side spectral insert via the bridge-equivalent route
        // without any manual refresh.
        addAndEnableSpectralViaMixer(mixer, fixture->latentTrackId);

        const auto diag = engine.getLivePresentationLatencyDiagnostics();
        CHECK(diag.maxTrackLatencySamples == kHop,
              "Stage 7B master+track: track latency should be visible live");
        CHECK(diag.masterLatencySamples == kHop,
              "Stage 7B master+track: master latency should still be reported");
        CHECK(diag.totalPresentationLatencySamples == kHop + kHop + kDeviceLatency,
              "Stage 7B master+track: total = track + master + device, no double count");
    }

    // ── 4. Remove path drops latency live without manual refresh ─────────────
    {
        auto fixture = makePresentationLatencyEngine(true, false, kDeviceLatency);
        auto& engine = fixture->engine;
        auto& mixer = engine.getMixEngine();

        CHECK(engine.getLivePresentationLatencySamples() == kHop + kDeviceLatency,
              "Stage 7B remove: spectral track should contribute latency live");

        CHECK(mixer.removeEffect(fixture->latentTrackId, fixture->trackEqNodeId),
              "Stage 7B remove: track effect should remove cleanly");
        CHECK(engine.getLivePresentationLatencySamples() == kDeviceLatency,
              "Stage 7B remove: latency should drop back to device only without refresh");
        CHECK(engine.getLivePresentationLatencyDiagnostics().maxTrackLatencySamples == 0,
              "Stage 7B remove: diagnostics should drop max-track to zero live");
    }

    // ── 5. Master parameter mutation visible without bridge refresh ──────────
    // (This path has no audio_setMasterEffectParameter wrapper in the bridge
    //  today; with Stage 7B the AudioEngine read still picks it up.)
    {
        auto fixture = makePresentationLatencyEngine(false, false, kDeviceLatency);
        auto& engine = fixture->engine;
        auto& mixer = engine.getMixEngine();

        const int masterEq = mixer.addMasterEffect("xletheq", 0);
        CHECK(masterEq >= 0, "Stage 7B master-param: master should accept XlethEQ");
        auto* eq = dynamic_cast<XlethParametricEQ*>(mixer.getMasterEffectPtr(masterEq));
        CHECK(eq != nullptr, "Stage 7B master-param: master effect should be XlethEQ");
        CHECK(eq->addBand() == 0,
              "Stage 7B master-param: master EQ should add the test band");

        CHECK(engine.getLivePresentationLatencySamples() == kDeviceLatency,
              "Stage 7B master-param: pre-spectral master latency should be device-only");

        // trackId == -1 selects the master chain inside MixEngine.
        CHECK(mixer.setEffectParameter(-1, masterEq, "b0_mode", 2.0f),
              "Stage 7B master-param: setEffectParameter(-1, ...) routes to master chain");

        // Critically: no refreshLivePresentationLatency call, no transport
        // event. The bridge has no audio_setMasterEffectParameter wrapper that
        // could refresh even if it wanted to.
        const auto diag = engine.getLivePresentationLatencyDiagnostics();
        CHECK(diag.masterLatencySamples == kHop,
              "Stage 7B master-param: master latency should be visible after parameter change");
        CHECK(engine.getLivePresentationLatencySamples() == kHop + kDeviceLatency,
              "Stage 7B master-param: total latency should include new master latency");
    }

    // ── 6. Position math always uses live latency (the user-visible symptom) ──
    // This is the exact failure shape the user reported: with the playhead
    // mid-flight, adding a latency-inducing insert via the MixEngine bridge
    // surface used to leave the presentation position unchanged (cache stale)
    // until Stop/Play. Post-Stage-7B the position must drop immediately by
    // exactly the new insert latency.
    {
        auto fixture = makePresentationLatencyEngine(false, false, kDeviceLatency);
        auto& engine = fixture->engine;
        auto& mixer = engine.getMixEngine();
        auto& transport = engine.getTransport();

        // Simulate a "live" playhead well past device latency.
        transport.seekToSample(kHop + kDeviceLatency + 4096);
        const int64_t baselinePos = engine.getLivePresentationPositionSamples();
        CHECK(baselinePos == kHop + 4096,
              "Stage 7B pos: baseline presentation position = raw - device");

        // Add the spectral insert via the MixEngine bridge route, no seek.
        addAndEnableSpectralViaMixer(mixer, fixture->latentTrackId);

        const int64_t postMutPos = engine.getLivePresentationPositionSamples();
        CHECK(postMutPos == 4096,
              "Stage 7B pos: presentation position must subtract NEW latency live");
        CHECK(baselinePos - postMutPos == kHop,
              "Stage 7B pos: position delta should equal added insert latency");
    }
}

static void testSyncManagerUsesPresentationProvider()
{
    std::cout << "[Presentation] SyncManager presentation position provider\n";

    Transport transport;
    transport.setSampleRate(48000.0);
    transport.setBPM(60.0);
    transport.seekToSample(48000);
    transport.play();

    std::vector<VideoDecoder*> decoders;
    FrameCache cache(1024);
    SyncManager sync(transport, decoders, cache, nullptr, []() -> int64_t {
        return 24000;
    });

    const double returnedBeat = sync.videoTick();
    CHECK(std::abs(transport.getPositionBeats() - 1.0) < 1.0e-9,
          "raw transport beat should remain one beat");
    CHECK(std::abs(returnedBeat - 0.5) < 1.0e-9,
          "SyncManager videoTick should return the presentation beat, not raw beat");
}

static double sampleToBeats(std::int64_t sample, double sampleRate, double bpm)
{
    return (static_cast<double>(sample) * bpm) / (60.0 * sampleRate);
}

static juce::File makeTempTestDir(const juce::String& prefix)
{
    auto dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
        .getChildFile(prefix + "_" + juce::String::toHexString(
            static_cast<juce::int64>(juce::Time::currentTimeMillis())));
    dir.createDirectory();
    return dir;
}

static juce::File generateImpulseWav(const juce::File& dir,
                                     const juce::String& name,
                                     double sampleRate,
                                     int numSamples,
                                     int impulseIndex)
{
    juce::AudioBuffer<float> buffer(1, numSamples);
    buffer.clear();
    buffer.setSample(0, impulseIndex, 0.5f);

    auto file = dir.getChildFile(name + ".wav");
    file.deleteFile();

    auto stream = std::unique_ptr<juce::FileOutputStream>(file.createOutputStream());
    if (stream == nullptr)
        return {};

    juce::WavAudioFormat format;
    std::unique_ptr<juce::AudioFormatWriter> writer(
        format.createWriterFor(stream.get(), sampleRate, 1, 16, {}, 0));
    if (writer == nullptr)
        return {};

    stream.release();
    writer->writeFromAudioSampleBuffer(buffer, 0, numSamples);
    writer.reset();
    return file;
}

static int findWavPeakIndex(const juce::File& file)
{
    juce::AudioFormatManager manager;
    manager.registerBasicFormats();

    std::unique_ptr<juce::AudioFormatReader> reader(manager.createReaderFor(file));
    CHECK(reader != nullptr, "exported WAV should be readable");
    if (reader == nullptr)
        return -1;

    juce::AudioBuffer<float> buffer(2, static_cast<int>(reader->lengthInSamples));
    buffer.clear();
    reader->read(&buffer, 0, buffer.getNumSamples(), 0, true, true);

    int peakIndex = -1;
    float peak = 0.0f;
    for (int s = 0; s < buffer.getNumSamples(); ++s)
    {
        const float v = std::abs(buffer.getSample(0, s));
        if (v > peak)
        {
            peak = v;
            peakIndex = s;
        }
    }
    return peakIndex;
}

static juce::AudioBuffer<float> readWavBuffer(const juce::File& file,
                                              int* outLength = nullptr)
{
    if (outLength != nullptr)
        *outLength = 0;

    juce::AudioFormatManager manager;
    manager.registerBasicFormats();

    std::unique_ptr<juce::AudioFormatReader> reader(manager.createReaderFor(file));
    CHECK(reader != nullptr, "WAV should be readable");
    if (reader == nullptr)
        return {};

    const int length = static_cast<int>(reader->lengthInSamples);
    juce::AudioBuffer<float> buffer(
        static_cast<int>(std::max<juce::uint32>(2, reader->numChannels)),
        length);
    buffer.clear();
    reader->read(&buffer, 0, length, 0, true, true);

    if (outLength != nullptr)
        *outLength = length;

    return buffer;
}

static int findPeakIndex(const juce::AudioBuffer<float>& buffer, int channel)
{
    if (buffer.getNumSamples() == 0 || channel >= buffer.getNumChannels())
        return -1;

    int peakIndex = -1;
    float peak = 0.0f;
    for (int s = 0; s < buffer.getNumSamples(); ++s)
    {
        const float v = std::abs(buffer.getSample(channel, s));
        if (v > peak)
        {
            peak = v;
            peakIndex = s;
        }
    }
    return peakIndex;
}

static float maxAbsInRange(const juce::AudioBuffer<float>& buffer,
                           int channel,
                           int startSample,
                           int numSamples)
{
    if (numSamples <= 0 || channel >= buffer.getNumChannels())
        return 0.0f;

    const int begin = std::max(0, startSample);
    const int end = std::min(buffer.getNumSamples(), begin + numSamples);
    float peak = 0.0f;
    for (int s = begin; s < end; ++s)
        peak = std::max(peak, std::abs(buffer.getSample(channel, s)));
    return peak;
}

static void configureTrackResonanceSuppressor(MixEngine& engine,
                                              int trackId,
                                              int nodeId,
                                              const char* label)
{
    CHECK(engine.setEffectParameter(trackId, nodeId, "processing_mode", 1.0f),
          std::string(label) + " should switch to High Quality");
    CHECK(engine.setEffectParameter(trackId, nodeId, "quality", 1.0f),
          std::string(label) + " quality should be Normal/1024 samples");
    CHECK(engine.setEffectParameter(trackId, nodeId, "depth", 0.0f),
          std::string(label) + " depth should be neutral");
    CHECK(engine.setEffectParameter(trackId, nodeId, "mix", 100.0f),
          std::string(label) + " mix should be wet");
    CHECK(engine.setEffectParameter(trackId, nodeId, "delta", 0.0f),
          std::string(label) + " delta listen should be off");
}

static void configureMasterResonanceSuppressor(MixEngine& engine,
                                               int nodeId,
                                               const char* label)
{
    CHECK(engine.setMasterEffectParameter(nodeId, "processing_mode", 1.0f),
          std::string(label) + " should switch to High Quality");
    CHECK(engine.setMasterEffectParameter(nodeId, "quality", 1.0f),
          std::string(label) + " quality should be Normal/1024 samples");
    CHECK(engine.setMasterEffectParameter(nodeId, "depth", 0.0f),
          std::string(label) + " depth should be neutral");
    CHECK(engine.setMasterEffectParameter(nodeId, "mix", 100.0f),
          std::string(label) + " mix should be wet");
    CHECK(engine.setMasterEffectParameter(nodeId, "delta", 0.0f),
          std::string(label) + " delta listen should be off");
}

struct ExportPrerollPlan
{
    std::int64_t renderStartSample = 0;
    std::int64_t availablePreroll = 0;
    std::int64_t samplesToDiscard = 0;
    std::int64_t renderEndSample = 0;
};

static ExportPrerollPlan computeAudioExporterPrerollPlan(std::int64_t startSample,
                                                         std::int64_t duration,
                                                         std::int64_t totalPreroll)
{
    ExportPrerollPlan plan;
    plan.renderStartSample = std::max<std::int64_t>(0, startSample - totalPreroll);
    plan.availablePreroll = startSample - plan.renderStartSample;
    plan.samplesToDiscard = plan.availablePreroll + totalPreroll;
    plan.renderEndSample = plan.renderStartSample + plan.samplesToDiscard + duration;
    return plan;
}

static ExportPrerollPlan computeOfflineRendererPrerollPlan(std::int64_t startSample,
                                                           std::int64_t duration,
                                                           std::int64_t totalPreroll)
{
    ExportPrerollPlan plan;
    plan.availablePreroll = std::min(startSample, totalPreroll);
    plan.renderStartSample = startSample - plan.availablePreroll;
    plan.samplesToDiscard = plan.availablePreroll + totalPreroll;
    plan.renderEndSample = plan.renderStartSample + plan.samplesToDiscard + duration;
    return plan;
}

static void testDynamicBuiltinLatencyOwnerPropagation()
{
    std::cout << "[Builtins] Dynamic latency owner propagation\n";

    AudioGraph graph;
    graph.init(48000.0, 512);
    const int compressorNode = graph.addEffect("compressor", 0);
    CHECK(compressorNode >= 0, "AudioGraph should add compressor");
    graph.refreshLatencyDiagnostics();
    const auto graphEpochBefore = graph.getLatencyEpoch();
    CHECK(graph.setEffectParameter(compressorNode, "lookahead", 5.0f),
          "AudioGraph should set compressor lookahead through owner path");
    CHECK(graph.getOutputLatencySamples() == 240,
          "AudioGraph output latency should update after compressor lookahead change");
    CHECK(graph.getLatencyEpoch() == graphEpochBefore + 1,
          "AudioGraph compressor lookahead change should trigger one PDC recompute");

    auto fixture = makeTwoTrackEngine(false, false);
    auto& mixer = fixture->engine;
    const int mixCompNode = mixer.addEffect(fixture->latentTrackId, "compressor", 0);
    CHECK(mixCompNode >= 0, "MixEngine should add compressor");
    CHECK(mixer.setEffectParameter(fixture->latentTrackId, mixCompNode, "lookahead", 5.0f),
          "MixEngine should set compressor lookahead through owner path");
    mixer.refreshLatencyDiagnostics();
    auto snapshot = mixer.getLatencyCompensationSnapshot();
    CHECK(snapshot.maxAudibleTrackLatencySamples == 240,
          "MixEngine max track latency should update after compressor lookahead change");
    CHECK(snapshot.masterInsertLatencySamples == 0,
          "MixEngine compressor track latency should not pollute master latency");

    constexpr int64_t kDeviceLatency = 64;
    auto presentation = makePresentationLatencyEngine(false, false, kDeviceLatency);
    auto& audioEngine = presentation->engine;
    auto& presentationMixer = audioEngine.getMixEngine();
    const int presentationNode =
        presentationMixer.addEffect(presentation->latentTrackId, "compressor", 0);
    CHECK(presentationNode >= 0, "presentation engine should add compressor");
    CHECK(presentationMixer.setEffectParameter(presentation->latentTrackId,
                                               presentationNode,
                                               "lookahead",
                                               5.0f),
          "presentation engine should set compressor lookahead through owner path");
    audioEngine.refreshLivePresentationLatency();
    auto diagnostics = audioEngine.getLivePresentationLatencyDiagnostics();
    CHECK(diagnostics.maxTrackLatencySamples == 240,
          "live presentation diagnostics should observe compressor latency change");
    CHECK(diagnostics.totalPresentationLatencySamples == 240 + kDeviceLatency,
          "live presentation total should include compressor plus device latency");

    const auto plan = computeAudioExporterPrerollPlan(
        0, 2048, snapshot.maxAudibleTrackLatencySamples
                     + snapshot.masterInsertLatencySamples);
    CHECK(plan.samplesToDiscard == 240,
          "export accounting should use updated compressor chain latency");
    CHECK(plan.renderStartSample == 0,
          "export accounting should clamp project-start compressor preroll");
}

struct ExportLatencyProbeOptions
{
    juce::String tempPrefix;
    std::int64_t requestedStartSample = 0;
    int requestedDuration = 0;
    int expectedPeakIndex = 0;
    bool enableTrackLatency = false;
    bool enableMasterLatency = false;
    bool addDryAccountingTrack = false;
};

struct ExportLatencyProbeResult
{
    MixEngine::LatencyCompensationSnapshot snapshot;
    ExportPrerollPlan plan;
    int dryTrackCompensation = -1;
    int latentTrackCompensation = -1;
    int latentTrackLatency = 0;
    bool exported = false;
    int outputLength = 0;
    int peakIndex = -1;
    juce::AudioBuffer<float> output;
};

static ExportLatencyProbeResult runAudioExporterLatencyProbe(
    const ExportLatencyProbeOptions& options)
{
    constexpr double kSampleRate = 51200.0;
    constexpr double kBpm = 120.0;
    constexpr int kBlockSize = 512;

    ExportLatencyProbeResult result;

    const auto tempDir = makeTempTestDir(options.tempPrefix);
    const int impulseSourceIndex = static_cast<int>(
        options.requestedStartSample + options.expectedPeakIndex);
    const int sourceSamples = std::max(
        16384,
        impulseSourceIndex + options.requestedDuration + 4096);
    const auto impulseFile = generateImpulseWav(tempDir, "impulse",
                                                kSampleRate,
                                                sourceSamples,
                                                impulseSourceIndex);
    CHECK(impulseFile.existsAsFile(),
          options.tempPrefix.toStdString() + " impulse WAV should be generated");

    Timeline timeline(kBpm, kSampleRate);

    TrackInfo latentTrack; latentTrack.name = "LatentExporterTrack";
    const int latentTrackId = timeline.addTrack(latentTrack);

    int dryTrackId = -1;
    if (options.addDryAccountingTrack)
    {
        TrackInfo dryTrack; dryTrack.name = "DryAccountingTrack";
        dryTrackId = timeline.addTrack(dryTrack);
    }

    SampleRegion region; region.name = "Impulse"; region.label = SampleLabel::Custom;
    const int regionId = timeline.addRegion(region);

    Clip clip;
    clip.trackId = latentTrackId;
    clip.regionId = regionId;
    clip.position = TickTime::fromBeats(0.0);
    clip.duration = TickTime::fromBeats(sampleToBeats(sourceSamples, kSampleRate, kBpm));
    timeline.addClip(clip);

    SampleBank bank;
    const int sampleId = bank.loadSample(impulseFile, kSampleRate);
    CHECK(sampleId >= 0, options.tempPrefix.toStdString() + " sample should load");

    auto engine = std::make_unique<MixEngine>();
    engine->setTimeline(&timeline);
    engine->setSampleBank(&bank);
    engine->mapRegionToSample(regionId, sampleId);
    engine->prepare(kSampleRate, kBlockSize);
    engine->setNonRealtime(true);

    if (options.enableTrackLatency)
    {
        const int rsNode = engine->addEffect(latentTrackId, "resonancesuppressor", 0);
        CHECK(rsNode >= 0, options.tempPrefix.toStdString() + " should add track RS");
        configureTrackResonanceSuppressor(*engine, latentTrackId, rsNode,
                                          "export track RS");
    }

    if (options.enableMasterLatency)
    {
        const int masterRsNode = engine->addMasterEffect("resonancesuppressor", 0);
        CHECK(masterRsNode >= 0, options.tempPrefix.toStdString() + " should add master RS");
        configureMasterResonanceSuppressor(*engine, masterRsNode,
                                           "export master RS");
    }

    engine->prepare(kSampleRate, kBlockSize);
    engine->setNonRealtime(true);
    engine->refreshLatencyDiagnostics();

    result.snapshot = engine->getLatencyCompensationSnapshot();
    const std::int64_t totalPreroll =
        static_cast<std::int64_t>(result.snapshot.maxAudibleTrackLatencySamples)
        + static_cast<std::int64_t>(result.snapshot.masterInsertLatencySamples);
    result.plan = computeAudioExporterPrerollPlan(
        options.requestedStartSample,
        options.requestedDuration,
        totalPreroll);
    result.latentTrackLatency = engine->getTrackInsertLatencySamples(latentTrackId);
    result.latentTrackCompensation =
        engine->getTrackCompensationDelaySamples(latentTrackId);
    if (dryTrackId >= 0)
        result.dryTrackCompensation =
            engine->getTrackCompensationDelaySamples(dryTrackId);

    AudioExporter exporter;
    AudioExporter::Config config;
    config.outputPath = tempDir.getChildFile("export.wav").getFullPathName().toStdString();
    config.format = AudioExporter::Format::WAV;
    config.sampleRate = static_cast<int>(kSampleRate);
    config.bitDepth = 16;
    config.startBeat = sampleToBeats(options.requestedStartSample, kSampleRate, kBpm);
    config.endBeat = sampleToBeats(options.requestedStartSample
                                       + options.requestedDuration,
                                   kSampleRate,
                                   kBpm);

    std::atomic<bool> cancel {false};
    result.exported = exporter.exportAudio(timeline, bank, *engine, config, nullptr, cancel);
    CHECK(result.exported,
          options.tempPrefix.toStdString() + " export should complete");

    result.output = readWavBuffer(juce::File(config.outputPath), &result.outputLength);
    result.peakIndex = findPeakIndex(result.output, 0);

    tempDir.deleteRecursively();
    (void) engine.release();
    return result;
}

static void checkExportProbeAlignment(const ExportLatencyProbeOptions& options,
                                      const ExportLatencyProbeResult& result,
                                      const char* label)
{
    CHECK(result.outputLength == options.requestedDuration,
          std::string(label) + ": exported WAV duration should equal requestedDuration");
    CHECK(result.peakIndex == options.expectedPeakIndex,
          std::string(label) + ": peak should align to requested musical start; peakIndex="
              + std::to_string(result.peakIndex));
    CHECK(maxAbsInRange(result.output, 0, 0, options.expectedPeakIndex) < 1.0e-4f,
          std::string(label) + ": output should not contain leading garbage before the expected impulse");
}

static void testAudioExporterPrerollDiscard()
{
    std::cout << "[Export] AudioExporter preroll/discard probe\n";

    constexpr double kSampleRate = 48000.0;
    constexpr double kBpm = 120.0;
    constexpr int kBlockSize = 512;
    constexpr int kImpulseIndex = 128;

    auto tempDir = makeTempTestDir("xleth_pdc_stage1_audio_exporter");
    const auto impulseFile = generateImpulseWav(tempDir, "impulse",
                                                kSampleRate, 8192,
                                                kImpulseIndex);
    CHECK(impulseFile.existsAsFile(), "AudioExporter probe impulse WAV should be generated");

    Timeline timeline(kBpm, kSampleRate);
    TrackInfo track; track.name = "AudioExporterTrack";
    const int trackId = timeline.addTrack(track);
    SampleRegion region; region.name = "Impulse"; region.label = SampleLabel::Custom;
    const int regionId = timeline.addRegion(region);

    Clip clip;
    clip.trackId = trackId;
    clip.regionId = regionId;
    clip.position = TickTime::fromBeats(0.0);
    clip.duration = TickTime::fromBeats(sampleToBeats(8192, kSampleRate, kBpm));
    timeline.addClip(clip);

    SampleBank bank;
    const int sampleId = bank.loadSample(impulseFile, kSampleRate);
    CHECK(sampleId >= 0, "AudioExporter probe sample should load");

    auto engine = std::make_unique<MixEngine>();
    engine->setTimeline(&timeline);
    engine->setSampleBank(&bank);
    engine->mapRegionToSample(regionId, sampleId);
    engine->prepare(kSampleRate, kBlockSize);
    engine->setNonRealtime(true);

    const int masterEq = engine->addMasterEffect("xletheq", 0);
    CHECK(masterEq >= 0, "AudioExporter probe should add master XlethEQ");
    requireSpectralEq(engine->getMasterEffectPtr(masterEq), "AudioExporter master EQ");
    engine->refreshLatencyDiagnostics();

    AudioExporter exporter;
    AudioExporter::Config config;
    config.outputPath = tempDir.getChildFile("export.wav").getFullPathName().toStdString();
    config.format = AudioExporter::Format::WAV;
    config.sampleRate = static_cast<int>(kSampleRate);
    config.bitDepth = 16;
    config.startBeat = 0.0;
    config.endBeat = sampleToBeats(8192, kSampleRate, kBpm);

    std::atomic<bool> cancel {false};
    const bool exported = exporter.exportAudio(timeline, bank, *engine, config, nullptr, cancel);
    CHECK(exported, "AudioExporter probe export should complete");

    const int peakIndex = findWavPeakIndex(juce::File(config.outputPath));
    CHECK(std::abs(peakIndex - kImpulseIndex) <= 1,
          std::string("AudioExporter should discard plugin-latency preroll before writing export audio; peakIndex=")
              + std::to_string(peakIndex));

    tempDir.deleteRecursively();
    (void) engine.release();
}

static void testAudioExporterProjectStartWithLatency()
{
    std::cout << "[Export] Project-start latent preroll clamp\n";

    ExportLatencyProbeOptions options;
    options.tempPrefix = "xleth_pdc_stage2c_start_zero";
    options.requestedStartSample = 0;
    options.requestedDuration = 2304;
    options.expectedPeakIndex = 211;
    options.enableMasterLatency = true;

    const auto result = runAudioExporterLatencyProbe(options);
    CHECK(result.snapshot.maxAudibleTrackLatencySamples == 0,
          "project-start case should have no track latency");
    CHECK(result.snapshot.masterInsertLatencySamples == 1024,
          "project-start case should report master latency");
    CHECK(result.plan.renderStartSample == 0,
          "project-start export renderStartSample should clamp to zero");
    CHECK(result.plan.availablePreroll == 0,
          "project-start export should have no musical history preroll available");
    CHECK(result.plan.samplesToDiscard == 1024,
          "project-start export should discard only plugin latency lead-in");
    checkExportProbeAlignment(options, result, "project_start_with_latency");
}

static void testAudioExporterPartialPrerollBeforeFullLatency()
{
    std::cout << "[Export] Partial available preroll before full latency\n";

    ExportLatencyProbeOptions options;
    options.tempPrefix = "xleth_pdc_stage2c_partial_preroll";
    options.requestedStartSample = 1024;
    options.requestedDuration = 2500;
    options.expectedPeakIndex = 257;
    options.enableTrackLatency = true;
    options.enableMasterLatency = true;
    options.addDryAccountingTrack = true;

    const auto result = runAudioExporterLatencyProbe(options);
    CHECK(result.snapshot.maxAudibleTrackLatencySamples == 1024,
          "partial-preroll case should report max track latency");
    CHECK(result.snapshot.masterInsertLatencySamples == 1024,
          "partial-preroll case should report master latency");
    CHECK(result.plan.renderStartSample == 0,
          "partial-preroll renderStartSample should clamp to zero");
    CHECK(result.plan.availablePreroll == options.requestedStartSample,
          "partial-preroll availablePreroll should equal requestedStartSample");
    CHECK(result.plan.samplesToDiscard == 3072,
          "partial-preroll discard should include available musical preroll plus plugin latency");
    CHECK(result.dryTrackCompensation == 1024
              && result.latentTrackCompensation == 0
              && result.latentTrackLatency == 1024,
          "partial-preroll track PDC should remain differential and exclude master latency");
    checkExportProbeAlignment(options, result, "partial_preroll_before_full_latency");
}

static void testAudioExporterFullPrerollAfterLatency()
{
    std::cout << "[Export] Full available preroll after latency\n";

    ExportLatencyProbeOptions options;
    options.tempPrefix = "xleth_pdc_stage2c_full_preroll";
    options.requestedStartSample = 3072;
    options.requestedDuration = 2600;
    options.expectedPeakIndex = 333;
    options.enableTrackLatency = true;
    options.enableMasterLatency = true;

    const auto result = runAudioExporterLatencyProbe(options);
    CHECK(result.snapshot.maxAudibleTrackLatencySamples == 1024,
          "full-preroll case should report track latency");
    CHECK(result.snapshot.masterInsertLatencySamples == 1024,
          "full-preroll case should report master latency");
    CHECK(result.plan.renderStartSample == 1024,
          "full-preroll renderStartSample should subtract maxTrackLatency + masterLatency");
    CHECK(result.plan.availablePreroll == 2048,
          "full-preroll availablePreroll should equal total latency");
    CHECK(result.plan.samplesToDiscard == 4096,
          "full-preroll discard should include full musical preroll plus plugin latency");
    checkExportProbeAlignment(options, result, "full_preroll_after_latency");
}

static void testAudioExporterPartialFinalBlockDuration()
{
    std::cout << "[Export] Partial final block duration\n";

    ExportLatencyProbeOptions options;
    options.tempPrefix = "xleth_pdc_stage2c_partial_final_block";
    options.requestedStartSample = 0;
    options.requestedDuration = 4219;
    options.expectedPeakIndex = 4097;
    options.enableMasterLatency = true;

    const auto result = runAudioExporterLatencyProbe(options);
    CHECK(options.requestedDuration % 4096 != 0,
          "partial-final-block test duration should not be an exporter render block multiple");
    CHECK(options.requestedDuration % 512 != 0,
          "partial-final-block test duration should not be a MixEngine block multiple");
    checkExportProbeAlignment(options, result, "partial_final_block_duration");
    CHECK(result.output.getNumSamples() > 0
              && std::abs(result.output.getSample(0, options.expectedPeakIndex)) > 0.1f,
          "partial-final-block export should keep the final non-block-aligned impulse");
}

static void testAudioExporterZeroLatencyProject()
{
    std::cout << "[Export] Zero-latency project path\n";

    ExportLatencyProbeOptions options;
    options.tempPrefix = "xleth_pdc_stage2c_zero_latency";
    options.requestedStartSample = 1536;
    options.requestedDuration = 2500;
    options.expectedPeakIndex = 128;

    const auto result = runAudioExporterLatencyProbe(options);
    CHECK(result.snapshot.maxAudibleTrackLatencySamples == 0,
          "zero-latency case should report zero track latency");
    CHECK(result.snapshot.masterInsertLatencySamples == 0,
          "zero-latency case should report zero master latency");
    CHECK(result.plan.renderStartSample == options.requestedStartSample,
          "zero-latency renderStartSample should equal requestedStartSample");
    CHECK(result.plan.availablePreroll == 0,
          "zero-latency export should not invent preroll");
    CHECK(result.plan.samplesToDiscard == 0,
          "zero-latency export should not trim artificial lead-in");
    checkExportProbeAlignment(options, result, "zero_latency_project");
}

static void testAudioExporterTrackPlusMasterLatency()
{
    std::cout << "[Export] Track plus master latency split\n";

    ExportLatencyProbeOptions options;
    options.tempPrefix = "xleth_pdc_stage2c_track_plus_master";
    options.requestedStartSample = 4096;
    options.requestedDuration = 3071;
    options.expectedPeakIndex = 511;
    options.enableTrackLatency = true;
    options.enableMasterLatency = true;
    options.addDryAccountingTrack = true;

    const auto result = runAudioExporterLatencyProbe(options);
    CHECK(result.snapshot.maxAudibleTrackLatencySamples == 1024,
          "track-plus-master should keep max track latency separate");
    CHECK(result.snapshot.masterInsertLatencySamples == 1024,
          "track-plus-master should keep master latency separate");
    CHECK(result.dryTrackCompensation == 1024,
          "track-plus-master dry track should receive differential track PDC");
    CHECK(result.latentTrackCompensation == 0,
          "track-plus-master latent track should not receive extra track PDC");
    CHECK(result.latentTrackLatency == 1024,
          "track-plus-master latent insert should report its own latency");
    CHECK(result.plan.renderStartSample == 2048,
          "track-plus-master export should preroll by maxTrackLatency + masterLatency");
    CHECK(result.plan.samplesToDiscard == 4096,
          "track-plus-master export should discard full musical preroll plus plugin latency");
    checkExportProbeAlignment(options, result, "track_plus_master_latency");
}

static void testOfflineRendererAudioExporterAccountingParity()
{
    std::cout << "[Export] OfflineRenderer/AudioExporter accounting parity\n";

    struct Case
    {
        std::int64_t start = 0;
        std::int64_t duration = 0;
        std::int64_t totalPreroll = 0;
        const char* label = "";
    };

    const std::vector<Case> cases {
        {0, 2304, 1024, "start_zero"},
        {1024, 2500, 2048, "partial_preroll"},
        {3072, 2600, 2048, "full_preroll"},
        {1536, 2500, 0, "zero_latency"},
        {4096, 3071, 2048, "track_plus_master"}
    };

    for (const auto& c : cases)
    {
        const auto exporterPlan =
            computeAudioExporterPrerollPlan(c.start, c.duration, c.totalPreroll);
        const auto offlinePlan =
            computeOfflineRendererPrerollPlan(c.start, c.duration, c.totalPreroll);

        CHECK(exporterPlan.renderStartSample == offlinePlan.renderStartSample,
              std::string(c.label) + ": renderStartSample should match");
        CHECK(exporterPlan.availablePreroll == offlinePlan.availablePreroll,
              std::string(c.label) + ": available/history preroll should match");
        CHECK(exporterPlan.samplesToDiscard == offlinePlan.samplesToDiscard,
              std::string(c.label) + ": discard count should match");
        CHECK(exporterPlan.renderEndSample == offlinePlan.renderEndSample,
              std::string(c.label) + ": renderEndSample should match");
    }
}

static void testExportAccountingAfterXlethEqLatencyChange()
{
    std::cout << "[Export] XlethEQ latency-change accounting\n";

    auto fixture = makeTwoTrackEngine(false, false);
    auto& mixer = fixture->engine;

    fixture->trackEqNodeId = mixer.addEffect(fixture->latentTrackId, "xletheq", 0);
    CHECK(fixture->trackEqNodeId >= 0,
          "export latency-change track should accept XlethEQ");

    auto* eq = dynamic_cast<XlethParametricEQ*>(
        mixer.getEffectPtr(fixture->latentTrackId, fixture->trackEqNodeId));
    CHECK(eq != nullptr, "export latency-change effect should be XlethEQ");
    if (eq == nullptr) return;

    CHECK(eq->addBand() == 0, "export latency-change EQ should add a band");
    CHECK(mixer.setEffectParameter(fixture->latentTrackId,
                                   fixture->trackEqNodeId,
                                   "b0_mode",
                                   2.0f),
          "export latency-change should toggle Spectral through MixEngine");
    mixer.refreshLatencyDiagnostics();

    const auto snapshot = mixer.getLatencyCompensationSnapshot();
    CHECK(snapshot.maxAudibleTrackLatencySamples == XlethParametricEQ::kSTFTHop,
          "export accounting should see toggled Spectral track latency");
    CHECK(snapshot.masterInsertLatencySamples == 0,
          "export accounting should not invent master latency for track-only EQ");

    const auto plan = computeAudioExporterPrerollPlan(
        0, 2048, snapshot.maxAudibleTrackLatencySamples
                     + snapshot.masterInsertLatencySamples);
    CHECK(plan.renderStartSample == 0,
          "export accounting should clamp project-start render start after EQ latency change");
    CHECK(plan.samplesToDiscard == XlethParametricEQ::kSTFTHop,
          "export accounting should discard plugin-latency lead-in after EQ latency change");
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout.setf(std::ios::unitbuf);
    std::cerr.setf(std::ios::unitbuf);

    std::cout << "=== test_pdc_stage1 ===\n";

    testXlethEqSpectralLatency();
    testXlethEqLatencyAffectingParameterPaths();
    testXlethEqStateRestoreLatencyBeforeProcessBlock();
    testBuiltinLatencyAuditProcessBlockNoPublish();
    testResonanceSuppressorDetectorBaselinePrefixEquivalence();
    testResonanceSuppressorHighQualityOutputStability();
    testGuardedPluginWrapperLatencyRefreshContract();
    testDynamicBuiltinLatencyParameterAndStateRestore();
    testAudioGraphLatencyEpochAndTopology();
    testAudioGraphLatencyChangePropagation();
    testAudioGraphThirdPartyLatencyRefreshPropagation();
    testAudioGraphThirdPartyProgramStateBypassAndEditorRoutes();
    testPdcRegressionAccounting();
    testMixEngineThirdPartyLatencyPropagation();
    testLivePresentationLatencyFormulaAndPositions();
    testLivePresentationLatencyRefreshAfterEqChange();
    testLivePresentationLatencyMasterTrackAndZeroCases();
    testLivePresentationLatencyAutoRefreshAfterMutation();
    testSyncManagerUsesPresentationProvider();
    testAudioExporterPrerollDiscard();
    testAudioExporterProjectStartWithLatency();
    testAudioExporterPartialPrerollBeforeFullLatency();
    testAudioExporterFullPrerollAfterLatency();
    testAudioExporterPartialFinalBlockDuration();
    testAudioExporterZeroLatencyProject();
    testAudioExporterTrackPlusMasterLatency();
    testOfflineRendererAudioExporterAccountingParity();
    testExportAccountingAfterXlethEqLatencyChange();
    testDynamicBuiltinLatencyOwnerPropagation();

    std::cout << "\nResults: " << g_passed << " passed, "
              << g_failed << " failed, "
              << g_xfailed << " expected-fail, "
              << g_xpassed << " unexpected-pass / XPASS\n";

    if (g_failed > 0)
    {
        std::cerr << "FAILED\n";
        std::cerr.flush();
        std::cout.flush();
        std::_Exit(1);
    }

    std::cout << "ALL TESTS PASSED\n";
    std::cerr.flush();
    std::cout.flush();
    std::_Exit(0);
}
