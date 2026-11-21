#pragma once

#include "audio/XlethEffectBase.h"
#include "audio/OptoCompressorCore.h"
#include "dsp/DspPrimitives.h"

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <vector>

// ─── XlethOptoCompressorEffect — optical leveling amplifier ─────────────────
// LA-2A-lineage opto compressor, the second stock model on
// xleth::comp::CompressorCore (docs/Compressor_Archetypes_Deep_Dive.md §3, §9):
//
//   Detector    OptoCellDetector      — sidechain tap, linked max(L,R)
//   GC          ProgramDependentGC    — EL panel law + Compress/Limit source
//   Ballistics  OptoMemoryBallistics  — EL τ + CdS fast/slow cell with memory
//   Element     CdsDivider            — R_CdS / (R_series + R_CdS)
//   Color       TubeTransformerColor  — tube line stage + transformer, always in
//
// The model and its fit are documented in OptoCompressorCore.h. Feedback-style
// (§3.4 Stage C): the panel is driven from the gain-reduced signal, the loop
// solved implicitly per sample by the core.
//
// Controls — the unit's three:
//   Peak Reduction  sidechain drive, 0–40 dB. There is no threshold knob:
//                   compression begins where level + PR crosses the EL onset
//                   (0 dBFS), so PR 20 starts the knee near −20 dBFS.
//   Gain            makeup, 0–40 dB, after the loop (the unit's gain pot is
//                   past the sidechain take-off, so it never changes the amount
//                   of reduction — §2.2/§11) and before the tube stage, which it
//                   therefore drives harder.
//   Limit/Compress  two-position switch: Limit mixes the input into the
//                   sidechain (higher ratio). A stepped control — the core
//                   crossfades its two coefficient lanes over 30 ms.
// R37 (the reissue's internal sidechain HF trim) is deliberately not a control;
// the sidechain is flat. There is no attack, release, ratio or threshold: they
// are properties of the T4 cell and emerge from it.
//
// Oversampling: the whole core — loop and colour — runs at 2× (FIR half-band,
// integer latency) like the Glue; the tube waveshaper aliases at 1×
// (test_opto_compressor [7]). All coefficients are computed at the oversampled
// rate. The measured latency is reported via setLatencySamples() for PDC, and
// the bypass crossfade blends against a latency-aligned dry.
//
// Parameters (APVTS):
//   peak_reduction  0..40 dB   (Linear 20 ms)   default 20
//   gain            0..40 dB   (Linear 20 ms)   default 0
//   mode            0 = Compress, 1 = Limit      default 0
//
// Metering slots: 0/1 = L/R output peak, 2 = gain reduction dB (max over the
// block, positive = reduction), 3 = input peak — the Glue's layout.
//
// pluginId: "opto"

class XlethOptoCompressorEffect : public XlethEffectBase
{
public:
    using Core = xleth::comp::OptoCompressorCore;

    static constexpr int kOversamplingOrder = 1;   // 2×

    XlethOptoCompressorEffect()
        : XlethEffectBase("opto", createLayout())
        , os_(2, kOversamplingOrder)
    {
        registerSmoothedParam("peak_reduction", SmoothType::Linear, 20.0f);
        registerSmoothedParam("gain",           SmoothType::Linear, 20.0f);
    }

    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            std::make_unique<Apf>(Pid{"peak_reduction", 1}, "Peak Reduction",
                Nar{0.0f, 40.0f, 0.0f, 1.0f}, 20.0f, "dB"),
            std::make_unique<Apf>(Pid{"gain",           1}, "Gain",
                Nar{0.0f, 40.0f, 0.0f, 1.0f},  0.0f, "dB"),
            std::make_unique<Apf>(Pid{"mode",           1}, "Limit/Compress",
                Nar{0.0f, 1.0f,  1.0f, 1.0f},  0.0f, ""),
        };
    }

    // ── Diagnostics / tests ─────────────────────────────────────────────────
    int    getOversamplingLatencySamples() const noexcept { return os_.getLatencySamples(); }
    int    getOversamplingFactor() const noexcept { return os_.getFactor(); }
    const Core& getCore() const noexcept { return core_; }

    // Maps the Limit/Compress switch onto a core Settings value.
    Core::Settings currentSettings() const noexcept
    {
        Core::Settings s;
        const bool limit = modePtr_ && modePtr_->load(std::memory_order_relaxed) >= 0.5f;
        s.gc.inputMix = limit ? xleth::comp::ProgramDependentGC::kLimitMix : 0.0f;
        s.topology = xleth::comp::Topology::TrackedFeedback;
        return s;
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;
        maxBlock_   = std::max(1, maxBlockSize);

        modePtr_ = apvts_.getRawParameterValue("mode");
        hPeakReduction_ = resolveSmoothed("peak_reduction");
        hGain_          = resolveSmoothed("gain");

        os_.prepare(maxBlock_);
        driveBuf_.assign(static_cast<size_t>(maxBlock_), 0.0f);
        gainBuf_.assign(static_cast<size_t>(maxBlock_), 0.0f);
        alignedDry_.setSize(2, maxBlock_, false, true, false);

        core_.setSidechainHighPass(false, 100.0f);   // R37: flat, no user control
        core_.setColorEnabled(true);                 // the unit has no colour switch
        core_.prepare(sampleRate_ * os_.getFactor(), currentSettings());

        setLatencySamples(os_.getLatencySamples());
    }

    void resetEffect() override
    {
        os_.reset();
        core_.setSettings(currentSettings());
        core_.reset();
        alignedDry_.clear();
    }

    double getTailLengthSeconds() const override
    {
        // The cell's memory holds gain REDUCTION for up to ~15 s, but that is
        // not a signal tail; the render-length tail is the oversampler's.
        return sampleRate_ > 0.0 ? os_.getLatencySamples() / sampleRate_ : 0.0;
    }

    // ── Processing ──────────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh      = std::min(2, buffer.getNumChannels());
        if (numSamples <= 0 || numCh <= 0) return;

        // Limit/Compress → the core crossfades if it changed.
        core_.setSettings(currentSettings());

        float peakInL = 0.0f, peakInR = 0.0f;
        float peakL = 0.0f, peakR = 0.0f;
        float maxGr = 0.0f;

        for (int start = 0; start < numSamples; start += maxBlock_)
        {
            const int n = std::min(maxBlock_, numSamples - start);

            // Host-rate smoothers, one value per host sample. The core's
            // "threshold" input carries −PeakReduction: drive = level + PR.
            for (int i = 0; i < n; ++i)
            {
                driveBuf_[static_cast<size_t>(i)] = -hPeakReduction_.next();
                gainBuf_[static_cast<size_t>(i)]  = hGain_.next();
            }

            float* chans[2] = { buffer.getWritePointer(0, start),
                                buffer.getWritePointer(numCh > 1 ? 1 : 0, start) };

            for (int c = 0; c < numCh; ++c)
            {
                alignedDry_.copyFrom(c, 0, chans[c], n);
                const float pk = alignedDry_.getMagnitude(c, 0, n);
                if (c == 0) peakInL = std::max(peakInL, pk); else peakInR = std::max(peakInR, pk);
            }
            os_.alignDry(alignedDry_.getArrayOfWritePointers(), numCh, n);

            juce::dsp::AudioBlock<float> host(chans, static_cast<size_t>(numCh), static_cast<size_t>(n));
            auto up = os_.processUp(host);
            float* upL = up.getChannelPointer(0);
            float* upR = numCh > 1 ? up.getChannelPointer(1) : upL;
            core_.process(upL, upR, static_cast<int>(up.getNumSamples()),
                          driveBuf_.data(), gainBuf_.data(), os_.getFactor());
            os_.processDown(host);

            maxGr = std::max(maxGr, core_.takeMaxGainReductionDb());
            peakL = std::max(peakL, buffer.getMagnitude(0, start, n));
            if (numCh > 1) peakR = std::max(peakR, buffer.getMagnitude(1, start, n));
            lastChunkSamples_ = n;
        }

        writeMeterValue(0, peakL);
        writeMeterValue(1, numCh > 1 ? peakR : peakL);
        writeMeterValue(2, maxGr);
        writeMeterValue(3, std::max(peakInL, peakInR));
    }

protected:
    // The wet path carries the oversampler's latency, so the base-class bypass
    // crossfade must blend against a dry delayed by exactly that much.
    bool usesLatencyAlignedBypassDry() const override { return true; }

    bool copyLatencyAlignedBypassDry(juce::AudioBuffer<float>& dest, int numSamples) override
    {
        if (numSamples != lastChunkSamples_ || numSamples > alignedDry_.getNumSamples())
            return false;
        const int ch = std::min(dest.getNumChannels(), alignedDry_.getNumChannels());
        for (int c = 0; c < ch; ++c)
            dest.copyFrom(c, 0, alignedDry_, c, 0, numSamples);
        return true;
    }

private:
    Core core_ {};
    xleth::dsp::Oversampler os_;

    double sampleRate_ = 48000.0;
    int    maxBlock_   = 512;
    int    lastChunkSamples_ = 0;

    std::vector<float> driveBuf_;
    std::vector<float> gainBuf_;
    juce::AudioBuffer<float> alignedDry_;

    std::atomic<float>* modePtr_ = nullptr;

    SmoothedHandle hPeakReduction_, hGain_;
};
