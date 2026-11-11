#pragma once

#include "audio/XlethEffectBase.h"
#include "dsp/stereoize/StereoizeCore.h"

#include <algorithm>
#include <cmath>

// ─── XlethFeddaEffect ("Fedda") ─────────────────────────────────────────────
// Mono-safe pseudo-stereo widener: the single-band, one-knob stock face of
// xleth::dsp::stereoize::Core (dsp/stereoize/StereoizeCore.h, which documents the DSP). It builds
// a synthetic side signal from the mid and adds it to L and subtracts it from R, so the mono sum
// is the input exactly. Zero latency; never calls setLatencySamples().
//
// Parameters (APVTS; the core smooths them, so none is registered with the base smoothers):
//   width           0..200 %          50       g = width / 100 through the core's width curve
//   character       Comb/Diffuse/Velvet  Diffuse  crossfaded (30 ms)
//   size            0.5..30 ms        8        Comb tau / Diffuse + Velvet lengths, crossfaded
//   low_bypass      20..2000 Hz       150      high-pass on the side signal only
//   low_slope       12 / 24 dB/oct    12
//   hf_damp         2..20 kHz         20 kHz   20 kHz = off
//   guard           0..100 %          0        Transient Guard
//   variation       0..999            random per new instance (a restored instance keeps its seed)
//   loudness_match  off/on            off      constant stereo loudness; the mono sum drops
//   mono_check      off/on            off      MONITOR: mono sum on both sides
//   compare         off/on            off      MONITOR: dry input, level-matched to the output
//
// Monitor parameters are audition switches, not settings: they are written as 0 into every saved
// state (project, chain snapshot, FX chain library), restored as 0, and ignored while the processor
// is non-realtime, which is how OfflineRenderer runs every chain during an export.
//
// Meter slots:
//   0  measured output L/R correlation (300 ms)       4  Transient Guard depth 0..1 (last block)
//   1  output mid RMS, dB                             5  target correlation for the current width
//   2  output side RMS, dB                            6  dry compare level-match gain, dB
//   3  normalised mid/side correlation (field tilt)   7  monitors engaged: 1 = mono, 2 = compare (sum)
//
// Log prefix: [Fedda]. pluginId: "fedda".

class XlethFeddaEffect : public XlethEffectBase
{
public:
    enum MeterSlot
    {
        kMeterCorrelation = 0,
        kMeterMidDb,
        kMeterSideDb,
        kMeterMsCorrelation,
        kMeterGuardDepth,
        kMeterTargetCorrelation,
        kMeterDryMatchDb,
        kMeterMonitors,
    };

    XlethFeddaEffect() : XlethEffectBase("fedda", createLayout())
    {
        pWidth_     = apvts_.getRawParameterValue("width");
        pCharacter_ = apvts_.getRawParameterValue("character");
        pSize_      = apvts_.getRawParameterValue("size");
        pLowBypass_ = apvts_.getRawParameterValue("low_bypass");
        pLowSlope_  = apvts_.getRawParameterValue("low_slope");
        pHfDamp_    = apvts_.getRawParameterValue("hf_damp");
        pGuard_     = apvts_.getRawParameterValue("guard");
        pVariation_ = apvts_.getRawParameterValue("variation");
        pLoudness_  = apvts_.getRawParameterValue("loudness_match");
        pMono_      = apvts_.getRawParameterValue("mono_check");
        pCompare_   = apvts_.getRawParameterValue("compare");

        // Spec 4.3: every new instance gets its own seed, so a mix full of Fedda instances does not
        // stamp one coherent comb pattern on the bus. setStateInformation() replaces it with the saved one.
        if (auto* v = apvts_.getParameter("variation"))
        {
            const int seed = juce::Random::getSystemRandom().nextInt(xleth::dsp::stereoize::kMaxVariation + 1);
            v->setValueNotifyingHost(v->convertTo0to1(static_cast<float>(seed)));
        }
        publishIdleMeters();
    }

    static constexpr const char* kMonitorParamIds[] = { "mono_check", "compare" };

    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        core_.prepare(sampleRate, maxBlockSize);
        publishIdleMeters();
#ifdef XLETH_DEBUG
        DBG("[Fedda] prepare sr=" + juce::String(sampleRate) + " block=" + juce::String(maxBlockSize));
#endif
    }

    void resetEffect() override { core_.reset(); }

    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int n = buffer.getNumSamples();
        // A one-channel buffer has nothing to widen into; its mono sum is already the input.
        if (n <= 0 || buffer.getNumChannels() < 2) return;

        auto p = readParams();
        if (isNonRealtime())
        {
            p.monoCheck  = false;
            p.compareDry = false;
        }

        core_.process(buffer.getWritePointer(0), buffer.getWritePointer(1), n, p);

        const auto& m = core_.meters();
        writeMeterValue(kMeterCorrelation,       m.correlation);
        writeMeterValue(kMeterMidDb,             m.midRmsDb);
        writeMeterValue(kMeterSideDb,            m.sideRmsDb);
        writeMeterValue(kMeterMsCorrelation,     m.msCorrelation);
        writeMeterValue(kMeterGuardDepth,        m.guardDepth);
        writeMeterValue(kMeterTargetCorrelation, m.targetCorrelation);
        writeMeterValue(kMeterDryMatchDb,        m.dryMatchGainDb);
        writeMeterValue(kMeterMonitors,          (p.monoCheck ? 1.0f : 0.0f) + (p.compareDry ? 2.0f : 0.0f));
    }

    // Monitor switches never persist (spec 4.7).
    void getStateInformation(juce::MemoryBlock& dest) override
    {
        auto state = apvts_.copyState();
        for (const char* id : kMonitorParamIds)
        {
            auto child = state.getChildWithProperty("id", juce::String(id));
            if (child.isValid()) child.setProperty("value", 0.0f, nullptr);
        }
        if (auto xml = state.createXml()) copyXmlToBinary(*xml, dest);
    }

    void setStateInformation(const void* data, int sizeInBytes) override
    {
        XlethEffectBase::setStateInformation(data, sizeInBytes);
        for (const char* id : kMonitorParamIds)
            if (auto* p = apvts_.getParameter(id))
                p->setValueNotifyingHost(0.0f);
        publishTarget(pWidth_->load(std::memory_order_relaxed));
    }

    // Chains are not processed while the transport is stopped, so the target slot would otherwise
    // keep the width it had at the last block. (Automation only writes while processing, where
    // processEffect publishes it anyway.)
    void onParameterValueChanged(const std::string& paramId, float value) override
    {
        if (paramId == "width") publishTarget(value);
    }

    // Tests / diagnostics.
    const xleth::dsp::stereoize::Core& core() const noexcept { return core_; }

    xleth::dsp::stereoize::Params readParams() const noexcept
    {
        namespace st = xleth::dsp::stereoize;
        st::Params p;
        p.widthPct      = pWidth_->load(std::memory_order_relaxed);
        p.character     = static_cast<st::Character>(std::clamp(static_cast<int>(std::lround(pCharacter_->load(std::memory_order_relaxed))), 0, 2));
        p.sizeMs        = pSize_->load(std::memory_order_relaxed);
        p.lowBypassHz   = pLowBypass_->load(std::memory_order_relaxed);
        p.lowSlope      = pLowSlope_->load(std::memory_order_relaxed) >= 0.5f ? st::LowSlope::Db24 : st::LowSlope::Db12;
        p.hfDampHz      = pHfDamp_->load(std::memory_order_relaxed);
        p.guard         = pGuard_->load(std::memory_order_relaxed) * 0.01f;
        p.variation     = static_cast<int>(std::lround(pVariation_->load(std::memory_order_relaxed)));
        p.loudnessMatch = pLoudness_->load(std::memory_order_relaxed) >= 0.5f;
        p.monoCheck     = pMono_->load(std::memory_order_relaxed) >= 0.5f;
        p.compareDry    = pCompare_->load(std::memory_order_relaxed) >= 0.5f;
        return p;
    }

private:
    // The meter slots start at 0, which reads as a 0 dB mid and side at correlation 0: a signal that
    // is not there. Until the first block, publish what is true: silence, and the target for the
    // current width.
    void publishIdleMeters() noexcept
    {
        writeMeterValue(kMeterCorrelation,       1.0f);
        writeMeterValue(kMeterMidDb,             -120.0f);
        writeMeterValue(kMeterSideDb,            -120.0f);
        writeMeterValue(kMeterMsCorrelation,     0.0f);
        writeMeterValue(kMeterGuardDepth,        0.0f);
        writeMeterValue(kMeterDryMatchDb,        0.0f);
        writeMeterValue(kMeterMonitors,          0.0f);
        publishTarget(pWidth_->load(std::memory_order_relaxed));
    }

    void publishTarget(float widthPct) noexcept
    {
        namespace st = xleth::dsp::stereoize;
        writeMeterValue(kMeterTargetCorrelation, st::targetCorrelation(st::widthToGain(widthPct)));
    }

    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Apc = juce::AudioParameterChoice;
        using Apb = juce::AudioParameterBool;
        using Api = juce::AudioParameterInt;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        // Skews put each range's geometric mean at the knob's centre (size 3.9 ms, low bypass
        // 200 Hz, HF damp 6.3 kHz).
        return {
            std::make_unique<Apf>(Pid{ "width", 1 }, "Width", Nar{ 0.0f, 200.0f, 0.0f, 1.0f }, 50.0f, "%"),
            std::make_unique<Apc>(Pid{ "character", 1 }, "Character",
                                  juce::StringArray{ "Comb", "Diffuse", "Velvet" }, 1),
            std::make_unique<Apf>(Pid{ "size", 1 }, "Size", Nar{ 0.5f, 30.0f, 0.0f, 0.32f }, 8.0f, "ms"),
            std::make_unique<Apf>(Pid{ "low_bypass", 1 }, "Low Bypass", Nar{ 20.0f, 2000.0f, 0.0f, 0.29f }, 150.0f, "Hz"),
            std::make_unique<Apc>(Pid{ "low_slope", 1 }, "Low Slope",
                                  juce::StringArray{ "12 dB/oct", "24 dB/oct" }, 0),
            std::make_unique<Apf>(Pid{ "hf_damp", 1 }, "HF Damp", Nar{ 2000.0f, 20000.0f, 0.0f, 0.485f }, 20000.0f, "Hz"),
            std::make_unique<Apf>(Pid{ "guard", 1 }, "Transient Guard", Nar{ 0.0f, 100.0f, 0.0f, 1.0f }, 0.0f, "%"),
            std::make_unique<Api>(Pid{ "variation", 1 }, "Variation", 0, xleth::dsp::stereoize::kMaxVariation, 0),
            std::make_unique<Apb>(Pid{ "loudness_match", 1 }, "Loudness Match", false),
            std::make_unique<Apb>(Pid{ "mono_check", 1 }, "Mono Check", false),
            std::make_unique<Apb>(Pid{ "compare", 1 }, "Dry Compare", false),
        };
    }

    xleth::dsp::stereoize::Core core_;

    std::atomic<float>* pWidth_     = nullptr;
    std::atomic<float>* pCharacter_ = nullptr;
    std::atomic<float>* pSize_      = nullptr;
    std::atomic<float>* pLowBypass_ = nullptr;
    std::atomic<float>* pLowSlope_  = nullptr;
    std::atomic<float>* pHfDamp_    = nullptr;
    std::atomic<float>* pGuard_     = nullptr;
    std::atomic<float>* pVariation_ = nullptr;
    std::atomic<float>* pLoudness_  = nullptr;
    std::atomic<float>* pMono_      = nullptr;
    std::atomic<float>* pCompare_   = nullptr;
};
