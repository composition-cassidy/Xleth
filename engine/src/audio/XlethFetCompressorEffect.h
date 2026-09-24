#pragma once

#include "audio/XlethEffectBase.h"
#include "audio/FetCompressorCore.h"
#include "dsp/DspPrimitives.h"

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <vector>

// ─── XlethFetCompressorEffect — FET limiting amplifier ──────────────────────
// 1176-lineage FET compressor/limiter, the third stock model on
// xleth::comp::CompressorCore (docs/Compressor_Archetypes_Deep_Dive.md §4, §9):
//
//   Detector    RcRectifier       — sidechain rectifier, linked max(L,R)
//   GC          FetRatioPresetGC  — ratio buttons: slope + threshold + knee
//   Ballistics  RcBallistics      — attack RC → release RC (TPT), on the gate
//   Element     FetShuntDivider   — closed-form square-law JFET divider
//   Color       ClassAColor       — class-A line amp + output transformer
//
// The model and its fit are documented in FetCompressorCore.h. Feedback (§2.1),
// the loop solved implicitly per sample by the core.
//
// Controls — the unit's:
//   Input     −24..+36 dB. There is no threshold knob: Input is the gain in
//             front of the FET, so it drives the signal into the curve (and the
//             node harder: more reduction, more ε, more grit).
//   Output    −24..+24 dB, after the loop and in front of the class-A stage,
//             which it therefore drives.
//   Attack    1..7, 800 µs → 20 µs.  Both FASTER clockwise, numbered like the
//   Release   1..7, 1.1 s → 50 ms.   hardware (7 = fastest).
//   Ratio     4:1 / 8:1 / 12:1 / 20:1 / All — interlocked buttons. Each is a
//             preset (slope, threshold, knee, attack slowdown); All buttons in
//             is its own preset and also switches the element's bias network.
//             Ratio and the two knobs are stepped Settings: the core runs two
//             lanes and crossfades their GR over 30 ms, like the Glue's
//             buttons. The knobs are quantised to 0.01 of a number so an
//             automation ramp re-fades at most every 30 ms, not every block.
//
// Oversampling: MANDATORY 4× (FIR half-band, integer latency) for the whole
// gain path — detector, loop, divider and colour. The 20 µs attack is sub-sample
// at 44.1 kHz (§2.3) and the fast loop modulates gain at audio rate (§11);
// test_fet_compressor [5] shows both. Coefficients at the oversampled rate. The
// measured latency goes to PDC; bypass crossfades against a latency-aligned dry.
//
// Parameters (APVTS):
//   input    −24..+36 dB   (Linear 20 ms)   default 0
//   output   −24..+24 dB   (Linear 20 ms)   default 0
//   attack   1..7          (stepped lanes)  default 3   (≈ 235 µs)
//   release  1..7          (stepped lanes)  default 5   (≈ 140 ms)
//   ratio    0..4 → 4:1, 8:1, 12:1, 20:1, All   default 0
//
// Metering slots: 0/1 = L/R output peak, 2 = gain reduction dB (max over the
// block, positive = reduction), 3 = input peak — the Glue's layout.
//
// pluginId: "fet"

class XlethFetCompressorEffect : public XlethEffectBase
{
public:
    using Core = xleth::comp::FetCompressorCore;

    static constexpr int kOversamplingOrder = 2;   // 4×

    XlethFetCompressorEffect()
        : XlethEffectBase("fet", createLayout())
        , os_(2, kOversamplingOrder)
    {
        registerSmoothedParam("input",  SmoothType::Linear, 20.0f);
        registerSmoothedParam("output", SmoothType::Linear, 20.0f);
    }

    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            std::make_unique<Apf>(Pid{"input",   1}, "Input",
                Nar{-24.0f, 36.0f, 0.0f, 1.0f}, 0.0f, "dB"),
            std::make_unique<Apf>(Pid{"output",  1}, "Output",
                Nar{-24.0f, 24.0f, 0.0f, 1.0f}, 0.0f, "dB"),
            std::make_unique<Apf>(Pid{"attack",  1}, "Attack",
                Nar{1.0f, 7.0f, 0.0f, 1.0f}, 3.0f, ""),
            std::make_unique<Apf>(Pid{"release", 1}, "Release",
                Nar{1.0f, 7.0f, 0.0f, 1.0f}, 5.0f, ""),
            std::make_unique<Apf>(Pid{"ratio",   1}, "Ratio",
                Nar{0.0f, 4.0f, 1.0f, 1.0f}, 0.0f, ""),
        };
    }

    // ── Diagnostics / tests ─────────────────────────────────────────────────
    int    getOversamplingLatencySamples() const noexcept { return os_.getLatencySamples(); }
    int    getOversamplingFactor() const noexcept { return os_.getFactor(); }
    const Core& getCore() const noexcept { return core_; }
    Core&       getCoreForTest() noexcept { return core_; }

    int ratioIndex() const noexcept
    {
        const float v = ratioPtr_ ? ratioPtr_->load(std::memory_order_relaxed) : 0.0f;
        return std::clamp(static_cast<int>(std::lround(v)), 0, xleth::comp::Fet1176::kAllButtonsIn);
    }

    // Maps the buttons and knobs onto a core Settings value.
    Core::Settings currentSettings() const noexcept
    {
        return xleth::comp::fetSettings(ratioIndex(), knob(attackPtr_, 3.0f), knob(releasePtr_, 5.0f));
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;
        maxBlock_   = std::max(1, maxBlockSize);

        ratioPtr_   = apvts_.getRawParameterValue("ratio");
        attackPtr_  = apvts_.getRawParameterValue("attack");
        releasePtr_ = apvts_.getRawParameterValue("release");
        hInput_  = resolveSmoothed("input");
        hOutput_ = resolveSmoothed("output");

        os_.prepare(maxBlock_);
        thresholdBuf_.assign(static_cast<size_t>(maxBlock_), xleth::comp::Fet1176::kThresholdDb);
        outputBuf_.assign(static_cast<size_t>(maxBlock_), 0.0f);
        alignedDry_.setSize(2, maxBlock_, false, true, false);

        core_.setSidechainHighPass(false, 100.0f);   // the unit's sidechain is flat
        core_.setColorEnabled(true);                 // no colour switch on the unit
        core_.gainElement().setAllButtonsIn(ratioIndex() == xleth::comp::Fet1176::kAllButtonsIn);
        core_.prepare(sampleRate_ * os_.getFactor(), currentSettings());

        setLatencySamples(os_.getLatencySamples());
    }

    void resetEffect() override
    {
        os_.reset();
        core_.gainElement().setAllButtonsIn(ratioIndex() == xleth::comp::Fet1176::kAllButtonsIn);
        core_.setSettings(currentSettings());
        core_.reset();
        alignedDry_.clear();
    }

    double getTailLengthSeconds() const override
    {
        // Release holds gain REDUCTION, not signal; the render tail is the
        // oversampler's.
        return sampleRate_ > 0.0 ? os_.getLatencySamples() / sampleRate_ : 0.0;
    }

    // ── Processing ──────────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh      = std::min(2, buffer.getNumChannels());
        if (numSamples <= 0 || numCh <= 0) return;

        // Buttons and knobs → the core crossfades if they changed; the bias
        // network ramps on its own.
        core_.setSettings(currentSettings());
        core_.gainElement().setAllButtonsIn(ratioIndex() == xleth::comp::Fet1176::kAllButtonsIn);

        float peakInL = 0.0f, peakInR = 0.0f;
        float peakL = 0.0f, peakR = 0.0f;
        float maxGr = 0.0f;

        for (int start = 0; start < numSamples; start += maxBlock_)
        {
            const int n = std::min(maxBlock_, numSamples - start);

            float* chans[2] = { buffer.getWritePointer(0, start),
                                buffer.getWritePointer(numCh > 1 ? 1 : 0, start) };

            for (int c = 0; c < numCh; ++c)
            {
                alignedDry_.copyFrom(c, 0, chans[c], n);
                const float pk = alignedDry_.getMagnitude(c, 0, n);
                if (c == 0) peakInL = std::max(peakInL, pk); else peakInR = std::max(peakInR, pk);
            }
            os_.alignDry(alignedDry_.getArrayOfWritePointers(), numCh, n);

            // Input: the gain in front of the FET, per host sample (smoothed).
            for (int i = 0; i < n; ++i)
            {
                const float g = xleth::dsp::dbToGain(hInput_.next());
                for (int c = 0; c < numCh; ++c) chans[c][i] *= g;
                outputBuf_[static_cast<size_t>(i)] = hOutput_.next();
            }

            juce::dsp::AudioBlock<float> host(chans, static_cast<size_t>(numCh), static_cast<size_t>(n));
            auto up = os_.processUp(host);
            float* upL = up.getChannelPointer(0);
            float* upR = numCh > 1 ? up.getChannelPointer(1) : upL;
            core_.process(upL, upR, static_cast<int>(up.getNumSamples()),
                          thresholdBuf_.data(), outputBuf_.data(), os_.getFactor());
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
    // Knob position, quantised to 0.01 of a number (see the header comment).
    static float knob(const std::atomic<float>* p, float fallback) noexcept
    {
        const float v = p ? p->load(std::memory_order_relaxed) : fallback;
        return std::round(std::clamp(v, 1.0f, 7.0f) * 100.0f) * 0.01f;
    }

    Core core_ {};
    xleth::dsp::Oversampler os_;

    double sampleRate_ = 48000.0;
    int    maxBlock_   = 512;
    int    lastChunkSamples_ = 0;

    std::vector<float> thresholdBuf_;
    std::vector<float> outputBuf_;
    juce::AudioBuffer<float> alignedDry_;

    std::atomic<float>* ratioPtr_   = nullptr;
    std::atomic<float>* attackPtr_  = nullptr;
    std::atomic<float>* releasePtr_ = nullptr;

    SmoothedHandle hInput_, hOutput_;
};
