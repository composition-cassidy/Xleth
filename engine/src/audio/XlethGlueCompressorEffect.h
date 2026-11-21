#pragma once

#include "audio/XlethEffectBase.h"
#include "audio/CompressorCore.h"
#include "dsp/DspPrimitives.h"

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <vector>

// ─── XlethGlueCompressorEffect — Feedback VCA "Bus Glue" compressor ─────────
// SSL-bus-lineage stereo glue compressor, the first stock model built on
// xleth::comp::CompressorCore (docs/Compressor_Archetypes_Deep_Dive.md §6, §9):
//
//   Detector    LogPeakDetector       — log-domain, stereo-linked max(L,R)
//   GC          SoftKneeGC            — Giannoulis soft knee, fixed 4 dB knee
//   Ballistics  AutoReleaseBallistics — stepped attack/release + dual-env Auto
//   Element     IdealVca              — Blackmer VCA, clean
//   Color       SubtleConsoleColor    — one gentle output stage, switchable
//
// Topology (§2.2): the SSL sidechain is tapped from the INPUT but runs through
// its own VCA that copies the main VCA's gain, so the detector sees compressed
// signal — feedback behaviour with a feedforward tap. It is modelled exactly as
// that: detector on the (optionally high-passed) input, loop closed in dB by the
// tracking gain and solved implicitly. "FF" cuts the tracking VCA's control
// (the GroupDIY mod in §2.2): detector sees the raw input, a harder grab. Both
// topologies settle on the same textbook static curve; only dynamics differ.
//
// Control values — checked against SSL documentation (September 2026):
//   The classic 2:1/4:1/10:1, 0.1/0.3/1/3/10/30 ms and 0.1/0.3/0.6/1.2 s + Auto
//   sets match SSL's G-series bus compressor as published by UA's licensed
//   "SSL 4000 G Bus Compressor" manual. THE BUS+ User Guide v1.1 (SSL) expands
//   them (11-position attack 0.1–40 ms, release 0.05–1.2 s + AUTO/AUTO 2,
//   ratios 1.3:1 to −0.5:1); the classic subset is what is modelled here.
//   Corrections/additions to doc §6.3 taken from that guide:
//     • AUTO release = "two-stage release (100 ms short, 12 seconds long)" —
//       §6.3/§6.5 give no figures; these drive AutoReleaseBallistics.
//     • The SSL S/C HPF is 12 dB/oct, OUT..300 Hz. Ours is the same 2nd-order
//       slope over the task's wider 20–500 Hz range, default OUT.
//     • Makeup on THE BUS+ is −10..+20 dB, applied post-sidechain (MDAC), which
//       is exactly why makeup here sits after the loop.
//   Threshold on hardware is ±20 dB about the unit's reference level; here it
//   is absolute dBFS, −40..0.
//
// Oversampling: the whole gain path runs at 2× (FIR half-band, integer
// latency) — the 0.1 ms attack at 10:1 modulates gain at audio rate and the
// colour stage is a waveshaper (§11 "oversample the whole gain path"). All
// core coefficients are computed at the oversampled rate. The measured
// oversampler latency is reported with setLatencySamples() so the engine's PDC
// compensates it, and the bypass crossfade uses a latency-aligned dry.
//
// Parameters (APVTS; stepped controls are index-valued floats, house style):
//   threshold    −40..0 dBFS     (Linear 20 ms)      default −10
//   makeup       −10..+20 dB     (Linear 20 ms)      default 0
//   ratio        0..2  → 2, 4, 10 :1                  default 1 (4:1)
//   attack       0..5  → 0.1, 0.3, 1, 3, 10, 30 ms    default 4 (10 ms)
//   release      0..4  → 0.1, 0.3, 0.6, 1.2 s, Auto   default 4 (Auto)
//   topology     0 = Classic (tracked feedback), 1 = FF    default 0
//   sc_hpf_on    0/1                                  default 0 (OUT)
//   sc_hpf_freq  20..500 Hz      (Linear 30 ms)      default 100
//   color        0/1 console saturation               default 1
//
// Stereo linking is mandatory for a glue compressor (§6.5) and is not a
// parameter: one detector, identical gain on both channels.
//
// Metering slots: 0/1 = L/R output peak, 2 = gain reduction dB (max over the
// block, positive = reduction — same slot the stock compressor's GR meter
// reads), 3 = input peak.
//
// pluginId: "glue"

class XlethGlueCompressorEffect : public XlethEffectBase
{
public:
    using Core = xleth::comp::GlueCompressorCore;

    static constexpr int kOversamplingOrder = 1;   // 2×
    static constexpr float kKneeDb = 4.0f;

    static constexpr std::array<float, 3> kRatios    { 2.0f, 4.0f, 10.0f };
    static constexpr std::array<float, 6> kAttacksMs { 0.1f, 0.3f, 1.0f, 3.0f, 10.0f, 30.0f };
    static constexpr std::array<float, 4> kReleasesMs{ 100.0f, 300.0f, 600.0f, 1200.0f };
    static constexpr int kReleaseAutoIndex = 4;

    XlethGlueCompressorEffect()
        : XlethEffectBase("glue", createLayout())
        , os_(2, kOversamplingOrder)
    {
        registerSmoothedParam("threshold",   SmoothType::Linear, 20.0f);
        registerSmoothedParam("makeup",      SmoothType::Linear, 20.0f);
        registerSmoothedParam("sc_hpf_freq", SmoothType::Linear, 30.0f);
    }

    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            std::make_unique<Apf>(Pid{"threshold",   1}, "Threshold",
                Nar{-40.0f, 0.0f,   0.0f, 1.0f }, -10.0f, "dB"),
            std::make_unique<Apf>(Pid{"makeup",      1}, "Makeup",
                Nar{-10.0f, 20.0f,  0.0f, 1.0f },   0.0f, "dB"),
            std::make_unique<Apf>(Pid{"ratio",       1}, "Ratio",
                Nar{0.0f,   2.0f,   1.0f, 1.0f },   1.0f, ""),
            std::make_unique<Apf>(Pid{"attack",      1}, "Attack",
                Nar{0.0f,   5.0f,   1.0f, 1.0f },   4.0f, ""),
            std::make_unique<Apf>(Pid{"release",     1}, "Release",
                Nar{0.0f,   4.0f,   1.0f, 1.0f },   4.0f, ""),
            std::make_unique<Apf>(Pid{"topology",    1}, "Topology",
                Nar{0.0f,   1.0f,   1.0f, 1.0f },   0.0f, ""),
            std::make_unique<Apf>(Pid{"sc_hpf_on",   1}, "S/C HPF",
                Nar{0.0f,   1.0f,   1.0f, 1.0f },   0.0f, ""),
            std::make_unique<Apf>(Pid{"sc_hpf_freq", 1}, "S/C HPF Freq",
                Nar{20.0f,  500.0f, 0.0f, 0.4f }, 100.0f, "Hz"),
            std::make_unique<Apf>(Pid{"color",       1}, "Color",
                Nar{0.0f,   1.0f,   1.0f, 1.0f },   1.0f, ""),
        };
    }

    // ── Diagnostics / tests ─────────────────────────────────────────────────
    int    getOversamplingLatencySamples() const noexcept { return os_.getLatencySamples(); }
    int    getOversamplingFactor() const noexcept { return os_.getFactor(); }
    const Core& getCore() const noexcept { return core_; }

    // Maps the current stepped parameter values onto a core Settings value.
    Core::Settings currentSettings() const noexcept
    {
        Core::Settings s;
        s.gc.ratio  = kRatios[static_cast<size_t>(indexOf(ratioPtr_, 1, 2))];
        s.gc.kneeDb = kKneeDb;
        s.bal.attackMs = kAttacksMs[static_cast<size_t>(indexOf(attackPtr_, 4, 5))];
        const int rel = indexOf(releasePtr_, kReleaseAutoIndex, kReleaseAutoIndex);
        s.bal.autoRelease = (rel == kReleaseAutoIndex);
        s.bal.releaseMs = s.bal.autoRelease ? kReleasesMs.back()
                                            : kReleasesMs[static_cast<size_t>(rel)];
        s.topology = indexOf(topologyPtr_, 0, 1) == 1 ? xleth::comp::Topology::FeedForward
                                                      : xleth::comp::Topology::TrackedFeedback;
        return s;
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_   = sampleRate;
        maxBlock_     = std::max(1, maxBlockSize);

        ratioPtr_    = apvts_.getRawParameterValue("ratio");
        attackPtr_   = apvts_.getRawParameterValue("attack");
        releasePtr_  = apvts_.getRawParameterValue("release");
        topologyPtr_ = apvts_.getRawParameterValue("topology");
        hpfOnPtr_    = apvts_.getRawParameterValue("sc_hpf_on");
        colorPtr_    = apvts_.getRawParameterValue("color");

        hThreshold_ = resolveSmoothed("threshold");
        hMakeup_    = resolveSmoothed("makeup");
        hHpfFreq_   = resolveSmoothed("sc_hpf_freq");

        os_.prepare(maxBlock_);
        thresholdBuf_.assign(static_cast<size_t>(maxBlock_), 0.0f);
        makeupBuf_.assign(static_cast<size_t>(maxBlock_), 0.0f);
        alignedDry_.setSize(2, maxBlock_, false, true, false);

        core_.setSidechainHighPass(readBool(hpfOnPtr_, false), hHpfFreq_.current());
        core_.setColorEnabled(readBool(colorPtr_, true));
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
        // Auto release's slow stage holds for tens of seconds in the worst case,
        // but only as gain REDUCTION: the tail that matters for render length is
        // the oversampler's, a handful of samples.
        return sampleRate_ > 0.0 ? os_.getLatencySamples() / sampleRate_ : 0.0;
    }

    // ── Processing ──────────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh      = std::min(2, buffer.getNumChannels());
        if (numSamples <= 0 || numCh <= 0) return;

        // Stepped controls → the core crossfades if they changed.
        core_.setSettings(currentSettings());
        core_.setColorEnabled(readBool(colorPtr_, true));

        float peakInL = 0.0f, peakInR = 0.0f;   // used for slot 3
        float peakL = 0.0f, peakR = 0.0f;
        float maxGr = 0.0f;

        for (int start = 0; start < numSamples; start += maxBlock_)
        {
            const int n = std::min(maxBlock_, numSamples - start);

            // Host-rate smoothers: one value per host sample, and the HPF cutoff
            // at chunk rate (TPT SVF is stable under that modulation).
            for (int i = 0; i < n; ++i)
            {
                thresholdBuf_[static_cast<size_t>(i)] = hThreshold_.next();
                makeupBuf_[static_cast<size_t>(i)]    = hMakeup_.next();
            }
            core_.setSidechainHighPass(readBool(hpfOnPtr_, false), hHpfFreq_.current());
            hHpfFreq_.skip(n);

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
                          thresholdBuf_.data(), makeupBuf_.data(), os_.getFactor());
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
        // Only valid when the block was processed in one chunk (the base class
        // hands us blocks of at most the prepared size, so that is every block).
        if (numSamples != lastChunkSamples_ || numSamples > alignedDry_.getNumSamples())
            return false;
        const int ch = std::min(dest.getNumChannels(), alignedDry_.getNumChannels());
        for (int c = 0; c < ch; ++c)
            dest.copyFrom(c, 0, alignedDry_, c, 0, numSamples);
        return true;
    }

private:
    static int indexOf(const std::atomic<float>* p, int fallback, int maxIndex) noexcept
    {
        const float v = p ? p->load(std::memory_order_relaxed) : static_cast<float>(fallback);
        return std::clamp(static_cast<int>(std::lround(v)), 0, maxIndex);
    }

    static bool readBool(const std::atomic<float>* p, bool fallback) noexcept
    {
        return p ? p->load(std::memory_order_relaxed) >= 0.5f : fallback;
    }

    Core core_ {};
    xleth::dsp::Oversampler os_;

    double sampleRate_ = 48000.0;
    int    maxBlock_   = 512;
    int    lastChunkSamples_ = 0;

    std::vector<float> thresholdBuf_;
    std::vector<float> makeupBuf_;
    juce::AudioBuffer<float> alignedDry_;

    std::atomic<float>* ratioPtr_    = nullptr;
    std::atomic<float>* attackPtr_   = nullptr;
    std::atomic<float>* releasePtr_  = nullptr;
    std::atomic<float>* topologyPtr_ = nullptr;
    std::atomic<float>* hpfOnPtr_    = nullptr;
    std::atomic<float>* colorPtr_    = nullptr;

    SmoothedHandle hThreshold_, hMakeup_, hHpfFreq_;
};
