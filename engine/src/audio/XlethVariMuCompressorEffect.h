#pragma once

#include "audio/XlethEffectBase.h"
#include "audio/VariMuCompressorCore.h"
#include "dsp/DspPrimitives.h"

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <vector>

// ─── XlethVariMuCompressorEffect — variable-mu tube limiter ─────────────────
// Fairchild 660/670-lineage vari-mu compressor, the fourth stock model on
// xleth::comp::CompressorCore (docs/Compressor_Archetypes_Deep_Dive.md §5, §9):
//
//   Detector    RcRectifierT<Cosine>  — sidechain rectifier, continuous peak
//   GC          IdentityGC            — the rectified voltage, straight through
//   Ballistics  MultiRcBallistics     — the grid-bias timing network, 6 positions
//   Element     PushPullVariMu        — remote-cutoff push-pull stage (the ratio)
//   Color       TubeTransformerColor  — tube line amp + output transformer
//
// The model and its fit are documented in VariMuCompressorCore.h. Feedback-
// style (§2.1), the loop solved implicitly per sample by the core.
//
// Controls — the unit's, minus its threshold:
//   Input          −24..+36 dB, the gain in front of the stage. There is no
//                  threshold knob: Input drives the signal into the tube's curve
//                  (and the grids harder: more reduction, a higher ratio, more
//                  tube).
//   Time Constant  1..6, the original manual's positions (÷3 to RC τ, §1.3);
//                  5 and 6 are automatic, program dependent. A stepped
//                  Setting: the core runs two lanes and crossfades their GR over
//                  30 ms, like the other models' switches.
//   Output         −24..+24 dB makeup, after the loop and in front of the line
//                  amp, which it therefore drives.
//   Mode           Linked (stereo-linked dual mono: one control voltage for L
//                  and R) or Mid/Side (the 670's sum/difference mode, §5.2: two
//                  independent limiters on M and S). Labelled Mid/Side — the
//                  hardware's Lat/Vert naming is disputed and deliberately not
//                  used (§5.2 implementation rule). Switching crossfades the two
//                  complete paths over 30 ms (CompressorCore).
//
// Oversampling: 4× (FIR half-band, integer latency) for the whole gain path —
// detector, loop, push-pull stage and colour. Chosen by measurement, as the FET
// was (test_varimu [6]): the tube waveshaping's folded products (static bias,
// 3–19 kHz, worst of the sweep) are −51 dBc at 1×; at 2× and 4× both sit at
// −87 through 20 dB of GR (the decimator's own transition band), −91 vs −109 at
// 30 dB — but slammed at 35 dB, where the swing reaches cutoff, 2× folds at
// −37 dBc and 4× at −55. 4× costs 3.3 % of a core (core + oversampler, 2×:
// 1.6 %; whole effect on heavy low-frequency program 3.9 % linked, 4.4 % M/S),
// inside the 5 % budget, so the preferred factor ships. Coefficients at the
// oversampled rate. The measured 61-sample latency goes to PDC; bypass
// crossfades against a latency-aligned dry.
//
// Parameters (APVTS):
//   input          −24..+36 dB   (Linear 20 ms)   default 0
//   output         −24..+24 dB   (Linear 20 ms)   default 0
//   time_constant  1..6          (stepped lanes)  default 2
//   mode           0 = Linked, 1 = Mid/Side        default 0
//
// Metering slots: 0/1 = L/R output peak, 2 = gain reduction dB (max over the
// block and both control signals, positive = reduction), 3 = input peak — the
// Glue's layout — plus 4/5 = GR of each control signal (Linked: both the one;
// Mid/Side: mid, side).
//
// pluginId: "varimu"

class XlethVariMuCompressorEffect : public XlethEffectBase
{
public:
    using Core = xleth::comp::VariMuCompressorCore;

    static constexpr int kOversamplingOrder = 2;   // 4×

    // In-core level (after Input) where the rectified sidechain reaches the
    // rectifier's threshold bias — where the tube starts to move. A full mix
    // peaking near −1 dBFS gets ≈1–3 dB of leveling at Input 0.
    static constexpr float kThresholdDb = -10.0f;

    XlethVariMuCompressorEffect()
        : XlethEffectBase("varimu", createLayout())
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
            std::make_unique<Apf>(Pid{"input",         1}, "Input",
                Nar{-24.0f, 36.0f, 0.0f, 1.0f}, 0.0f, "dB"),
            std::make_unique<Apf>(Pid{"output",        1}, "Output",
                Nar{-24.0f, 24.0f, 0.0f, 1.0f}, 0.0f, "dB"),
            std::make_unique<Apf>(Pid{"time_constant", 1}, "Time Constant",
                Nar{1.0f, 6.0f, 1.0f, 1.0f}, 2.0f, ""),
            std::make_unique<Apf>(Pid{"mode",          1}, "Mode",
                Nar{0.0f, 1.0f, 1.0f, 1.0f}, 0.0f, ""),
        };
    }

    // ── Diagnostics / tests ─────────────────────────────────────────────────
    int    getOversamplingLatencySamples() const noexcept { return os_.getLatencySamples(); }
    int    getOversamplingFactor() const noexcept { return os_.getFactor(); }
    const Core& getCore() const noexcept { return core_; }
    Core&       getCoreForTest() noexcept { return core_; }

    int timeConstant() const noexcept
    {
        const float v = tcPtr_ ? tcPtr_->load(std::memory_order_relaxed) : 2.0f;
        return std::clamp(static_cast<int>(std::lround(v)), 1, 6);
    }

    xleth::comp::ChannelMode channelMode() const noexcept
    {
        const float v = modePtr_ ? modePtr_->load(std::memory_order_relaxed) : 0.0f;
        return v >= 0.5f ? xleth::comp::ChannelMode::MidSide : xleth::comp::ChannelMode::Linked;
    }

    Core::Settings currentSettings() const noexcept { return xleth::comp::variMuSettings(timeConstant()); }

    // ── Lifecycle ───────────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;
        maxBlock_   = std::max(1, maxBlockSize);

        tcPtr_   = apvts_.getRawParameterValue("time_constant");
        modePtr_ = apvts_.getRawParameterValue("mode");
        hInput_  = resolveSmoothed("input");
        hOutput_ = resolveSmoothed("output");

        os_.prepare(maxBlock_);
        thresholdBuf_.assign(static_cast<size_t>(maxBlock_), kThresholdDb);
        outputBuf_.assign(static_cast<size_t>(maxBlock_), 0.0f);
        alignedDry_.setSize(2, maxBlock_, false, true, false);

        xleth::comp::wireVariMu(core_, kThresholdDb);   // flat sidechain, line amp always in
        core_.setChannelMode(channelMode());
        core_.prepare(sampleRate_ * os_.getFactor(), currentSettings());

        setLatencySamples(os_.getLatencySamples());
    }

    void resetEffect() override
    {
        os_.reset();
        core_.setSettings(currentSettings());
        core_.setChannelMode(channelMode());
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

        // Time Constant and Mode → the core crossfades if they changed.
        core_.setSettings(currentSettings());
        core_.setChannelMode(channelMode());

        float peakInL = 0.0f, peakInR = 0.0f;
        float peakL = 0.0f, peakR = 0.0f;
        float maxGrA = 0.0f, maxGrB = 0.0f;

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

            // Input: the gain in front of the stage, per host sample (smoothed).
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

            maxGrA = std::max(maxGrA, core_.takeMaxGainReductionDb(0));
            maxGrB = std::max(maxGrB, core_.takeMaxGainReductionDb(1));
            peakL = std::max(peakL, buffer.getMagnitude(0, start, n));
            if (numCh > 1) peakR = std::max(peakR, buffer.getMagnitude(1, start, n));
            lastChunkSamples_ = n;
        }

        writeMeterValue(0, peakL);
        writeMeterValue(1, numCh > 1 ? peakR : peakL);
        writeMeterValue(2, std::max(maxGrA, maxGrB));
        writeMeterValue(3, std::max(peakInL, peakInR));
        writeMeterValue(4, maxGrA);
        writeMeterValue(5, maxGrB);
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
    Core core_ { xleth::comp::variMuConfig() };
    xleth::dsp::Oversampler os_;

    double sampleRate_ = 48000.0;
    int    maxBlock_   = 512;
    int    lastChunkSamples_ = 0;

    std::vector<float> thresholdBuf_;
    std::vector<float> outputBuf_;
    juce::AudioBuffer<float> alignedDry_;

    std::atomic<float>* tcPtr_   = nullptr;
    std::atomic<float>* modePtr_ = nullptr;

    SmoothedHandle hInput_, hOutput_;
};
