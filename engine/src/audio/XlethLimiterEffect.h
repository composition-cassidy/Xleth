#pragma once

#include "audio/XlethEffectBase.h"
#include "audio/viz/DynamicsVizCollector.h"
#include "audio/viz/DynamicsVizFrame.h"

#include <juce_dsp/juce_dsp.h>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>
#include <cmath>

// ── File-scope DSP helpers ────────────────────────────────────────────────────

struct BiquadCoeffs { float b0, b1, b2, a1, a2; };
struct BiquadState  { float s1 = 0.0f, s2 = 0.0f; };
struct KWeightState { BiquadState pre, rlb; };

inline float processBiquad(float x, const BiquadCoeffs& c, BiquadState& s) noexcept
{
    float y = c.b0 * x + s.s1;
    s.s1    = c.b1 * x - c.a1 * y + s.s2;
    s.s2    = c.b2 * x - c.a2 * y;
    return y;
}

// ── XlethLimiterEffect ────────────────────────────────────────────────────────
//
// Brickwall limiter with:
//   • True-peak detection via 4× FIR oversampling (detection only, not output)
//   • Lookahead gain smoothing (backward-pass anticipatory ramp)
//   • Three limiting styles: Transparent / Punchy / Aggressive
//   • ITU-R BS.1770 LUFS metering (K-weighting, 400ms + 3s windows)
//
// Meter slots:
//   0 = L output peak, 1 = R output peak
//   2 = gain reduction (dB, positive = amount reduced)
//   3 = momentary LUFS (400ms), 4 = short-term LUFS (3s)
//
// pluginId: "limiter"

class XlethLimiterEffect : public XlethEffectBase
{
public:
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout();

    XlethLimiterEffect();

    void prepareEffect(double sampleRate, int maxBlockSize) override;
    void resetEffect()   override;
    void releaseEffect() override;
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    std::uint64_t getProcessBlockLatencyUpdateCount() const
    {
        return processBlockLatencyUpdateCount_.load(std::memory_order_acquire);
    }

    std::uint64_t getNonRealtimeLatencyUpdateCount() const
    {
        return nonRealtimeLatencyUpdateCount_.load(std::memory_order_acquire);
    }

    int getReportedProcessorLatencySamples() const
    {
        return AudioProcessor::getLatencySamples();
    }

    // ── Visualization (XlethEffectBase overrides) ────────────────────────────
    // Lifetime model mirrors XlethCompressorEffect: collector is allocated on
    // first enable, vizActive_ atomic publishes/un-publishes it for the audio
    // thread, the collector itself is retained until the effect is destroyed.
    void          setVisualizationEnabled(bool enabled) override;
    std::uint32_t getVisualizationType()          const override
        { return xleth::viz::kVizTypeLimiter; }
    std::uint32_t getVisualizationSchemaVersion() const override
        { return xleth::viz::kDynamicsVizSchemaVersion; }
    std::size_t   drainVizFrames(std::uint8_t* out, std::size_t maxBytes) override;

private:
    // ── DSP objects ───────────────────────────────────────────────────────────
    juce::dsp::Oversampling<float> oversampler_;   // 2ch, 2-stage (4×), FIR equiripple
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None> lookaheadDelay_;
    juce::AudioBuffer<float> detectionBuffer_;     // copy of input for oversampling
    std::vector<float> gainReductionBuf_;          // per-sample GR scratch buffer

    // ── State ─────────────────────────────────────────────────────────────────
    float  prevGRstate_           = 1.0f;  // GR at sample 0 of previous block (cross-block continuity)
    int    prevStyle_             = -1;    // detect style changes
    int    totalLookaheadSamples_ = 0;
    double sampleRate_            = 44100.0;
    std::atomic<std::uint64_t> processBlockLatencyUpdateCount_{0};
    std::atomic<std::uint64_t> nonRealtimeLatencyUpdateCount_{0};

    // ── K-weighting (ITU-R BS.1770) ───────────────────────────────────────────
    std::array<KWeightState, 2> kweightState_{};   // per channel
    BiquadCoeffs kPreCoeffs_{};                    // pre-filter (high shelf)
    BiquadCoeffs kRlbCoeffs_{};                    // RLB high-pass

    // ── LUFS ring buffers ─────────────────────────────────────────────────────
    std::vector<float> momentaryBuf_;
    std::vector<float> shortTermBuf_;
    float momentarySum_  = 0.0f;
    float shortTermSum_  = 0.0f;
    int   momentaryPos_  = 0;
    int   shortTermPos_  = 0;
    int   momentaryW_    = 0;   // window sizes in samples
    int   shortTermW_    = 0;

    // ── Debug ─────────────────────────────────────────────────────────────────
    int blockCounter_ = 0;

    // ── Visualization ─────────────────────────────────────────────────────────
    // Lazy collector: allocated on first setVisualizationEnabled(true), then
    // re-used on subsequent enables. vizActive_ is the atomic the audio thread
    // reads once per block — null when the editor is closed (zero overhead).
    std::unique_ptr<xleth::viz::DynamicsVizCollector<xleth::viz::LimiterBucket>>
        vizCollector_;
    std::atomic<xleth::viz::DynamicsVizCollector<xleth::viz::LimiterBucket>*>
        vizActive_{nullptr};
    xleth::viz::LimiterBucketAccumulator vizAccum_;
    std::uint64_t vizSampleClock_ = 0;

    // ── Helpers ───────────────────────────────────────────────────────────────
    void computeKWeightingCoeffs(double sr);
    void updateLookahead(int styleIdx, double sr);
    void onParameterValueChanged(const std::string& paramId, float value) override;
};

// ── setVisualizationEnabled ─────────────────────────────────────────────────
inline void XlethLimiterEffect::setVisualizationEnabled(bool enabled)
{
    if (enabled)
    {
        if (!vizCollector_)
        {
            vizCollector_ = std::make_unique<
                xleth::viz::DynamicsVizCollector<xleth::viz::LimiterBucket>>(
                    xleth::viz::kDynamicsVizBucketSize,
                    xleth::viz::kDynamicsVizRingDepth,
                    xleth::viz::kVizTypeLimiter);
        }
        vizActive_.store(vizCollector_.get(), std::memory_order_release);
    }
    else
    {
        vizActive_.store(nullptr, std::memory_order_release);
    }
}

// ── drainVizFrames ──────────────────────────────────────────────────────────
inline std::size_t XlethLimiterEffect::drainVizFrames(std::uint8_t* out, std::size_t maxBytes)
{
    if (!vizCollector_) return 0;
    return vizCollector_->drain(out, maxBytes);
}

inline void XlethLimiterEffect::setStateInformation(const void* data, int sizeInBytes)
{
    XlethEffectBase::setStateInformation(data, sizeInBytes);
    const int style = (int)std::round(*apvts_.getRawParameterValue("style"));
    updateLookahead(style, sampleRate_);
    prevStyle_ = style;
}

inline void XlethLimiterEffect::onParameterValueChanged(const std::string& paramId, float value)
{
    if (paramId != "style")
        return;

    const int style = juce::jlimit(0, 2, (int)std::round(value));
    updateLookahead(style, sampleRate_);
    prevStyle_ = style;
}

// ── createLayout ─────────────────────────────────────────────────────────────

inline juce::AudioProcessorValueTreeState::ParameterLayout XlethLimiterEffect::createLayout()
{
    std::vector<std::unique_ptr<juce::RangedAudioParameter>> params;

    params.push_back(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID{ "gain", 1 }, "Gain",
        juce::NormalisableRange<float>(0.0f, 36.0f, 0.0f, 1.0f),
        0.0f,
        juce::AudioParameterFloatAttributes().withLabel("dB")));

    params.push_back(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID{ "ceiling", 1 }, "Ceiling",
        juce::NormalisableRange<float>(-12.0f, 0.0f, 0.0f, 1.0f),
        -0.3f,
        juce::AudioParameterFloatAttributes().withLabel("dB")));

    params.push_back(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID{ "release", 1 }, "Release",
        juce::NormalisableRange<float>(10.0f, 1000.0f, 0.0f, 0.3f),
        100.0f,
        juce::AudioParameterFloatAttributes().withLabel("ms")));

    // Discrete: 0=Transparent, 1=Punchy, 2=Aggressive
    params.push_back(std::make_unique<juce::AudioParameterFloat>(
        juce::ParameterID{ "style", 1 }, "Style",
        juce::NormalisableRange<float>(0.0f, 2.0f, 1.0f, 1.0f),
        0.0f));

    return { params.begin(), params.end() };
}

// ── Constructor ───────────────────────────────────────────────────────────────

inline XlethLimiterEffect::XlethLimiterEffect()
    : XlethEffectBase("limiter", createLayout())
    , oversampler_(2, 2, juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple)
{
    registerSmoothedParam("gain",    SmoothType::Linear, 20.0f);
    registerSmoothedParam("ceiling", SmoothType::Linear, 20.0f);
    registerSmoothedParam("release", SmoothType::Linear, 20.0f);
    // "style" is discrete — not registered as smoothed
}

// ── computeKWeightingCoeffs ───────────────────────────────────────────────────
// Bilinear-transform design from libebur128 / ITU-R BS.1770 Annex 1.
// Works for any sample rate.

inline void XlethLimiterEffect::computeKWeightingCoeffs(double sr)
{
    // --- Stage 1: pre-filter (high-shelf) ---
    // Models acoustic effect of the head; shelf at f0 ≈ 1682 Hz, gain ≈ +4 dB
    constexpr double Vh  = 1.584893192;
    constexpr double Vb  = 1.258925412;
    constexpr double f0p = 1681.974450955533;
    const double Kp  = std::tan(juce::MathConstants<double>::pi * f0p / sr);
    const double Kp2 = Kp * Kp;
    const double sqr2 = std::sqrt(2.0);
    const double normp = 1.0 + sqr2 * Kp + Kp2;

    kPreCoeffs_.b0 = (float)((Vh + Vb * sqr2 * Kp + Kp2) / normp);
    kPreCoeffs_.b1 = (float)(2.0 * (Kp2 - Vh) / normp);
    kPreCoeffs_.b2 = (float)((Vh - Vb * sqr2 * Kp + Kp2) / normp);
    kPreCoeffs_.a1 = (float)(2.0 * (Kp2 - 1.0) / normp);
    kPreCoeffs_.a2 = (float)((1.0 - sqr2 * Kp + Kp2) / normp);

    // --- Stage 2: RLB high-pass ---
    // Removes unwanted low-frequency contribution; HP at f0 ≈ 38.1 Hz
    constexpr double f0r = 38.13547087602444;
    constexpr double Qr  = 0.5003270373238773;
    const double Kr  = std::tan(juce::MathConstants<double>::pi * f0r / sr);
    const double Kr2 = Kr * Kr;
    const double a0r = 1.0 + Kr / Qr + Kr2;

    kRlbCoeffs_.b0 = (float)(1.0 / a0r);
    kRlbCoeffs_.b1 = (float)(-2.0 / a0r);
    kRlbCoeffs_.b2 = (float)(1.0 / a0r);
    kRlbCoeffs_.a1 = (float)(2.0 * (Kr2 - 1.0) / a0r);
    kRlbCoeffs_.a2 = (float)((1.0 - Kr / Qr + Kr2) / a0r);
}

// ── updateLookahead ───────────────────────────────────────────────────────────

inline void XlethLimiterEffect::updateLookahead(int styleIdx, double sr)
{
    static constexpr float kStyleLookaheadMs[3] = { 3.0f, 1.0f, 0.5f };
    const float styleMs = kStyleLookaheadMs[juce::jlimit(0, 2, styleIdx)];

    const int oversamplerLatency = (int)std::ceil(oversampler_.getLatencyInSamples());
    const int styleSamples       = (int)std::ceil(styleMs * 0.001f * (float)sr);
    totalLookaheadSamples_       = styleSamples + oversamplerLatency;

    if (totalLookaheadSamples_ != AudioProcessor::getLatencySamples())
    {
        setLatencySamples(totalLookaheadSamples_);
        nonRealtimeLatencyUpdateCount_.fetch_add(1, std::memory_order_acq_rel);
    }
}

// ── prepareEffect ─────────────────────────────────────────────────────────────

inline void XlethLimiterEffect::prepareEffect(double sampleRate, int maxBlockSize)
{
    sampleRate_ = sampleRate;
    computeKWeightingCoeffs(sampleRate);

    // Oversampler — must init before calling getLatencyInSamples()
    oversampler_.initProcessing((size_t)maxBlockSize);
    oversampler_.reset();

    // Lookahead delay line
    const int oversamplerLatency = (int)std::ceil(oversampler_.getLatencyInSamples());
    const int maxDelaySamples    = (int)std::ceil(5.0 * 0.001 * sampleRate)
                                   + oversamplerLatency + 5;

    juce::dsp::ProcessSpec spec{ sampleRate,
                                 (juce::uint32)maxBlockSize,
                                 2u };
    lookaheadDelay_.prepare(spec);
    lookaheadDelay_.setMaximumDelayInSamples(maxDelaySamples);
    lookaheadDelay_.reset();

    // Working buffers
    detectionBuffer_.setSize(2, maxBlockSize);
    gainReductionBuf_.resize((size_t)maxBlockSize, 1.0f);

    // LUFS ring buffers
    momentaryW_ = (int)std::round(0.400 * sampleRate);
    shortTermW_ = (int)std::round(3.000 * sampleRate);
    momentaryBuf_.assign((size_t)momentaryW_, 0.0f);
    shortTermBuf_.assign((size_t)shortTermW_, 0.0f);
    momentarySum_ = 0.0f;  shortTermSum_ = 0.0f;
    momentaryPos_ = 0;     shortTermPos_ = 0;

    // Initial lookahead from current style param
    const int initStyle = (int)std::round(*apvts_.getRawParameterValue("style"));
    updateLookahead(initStyle, sampleRate);
    prevStyle_ = initStyle;

    // Zero state
    prevGRstate_  = 1.0f;
    kweightState_ = {};
    blockCounter_ = 0;

    // Visualization state
    vizSampleClock_ = 0;
    vizAccum_.reset();
}

// ── resetEffect ───────────────────────────────────────────────────────────────

inline void XlethLimiterEffect::resetEffect()
{
    oversampler_.reset();
    lookaheadDelay_.reset();

    prevGRstate_ = 1.0f;

    std::fill(momentaryBuf_.begin(), momentaryBuf_.end(), 0.0f);
    std::fill(shortTermBuf_.begin(), shortTermBuf_.end(), 0.0f);
    momentarySum_ = 0.0f;  shortTermSum_ = 0.0f;
    momentaryPos_ = 0;     shortTermPos_ = 0;

    kweightState_ = {};
    blockCounter_ = 0;

    vizSampleClock_ = 0;
    vizAccum_.reset();
}

// ── releaseEffect ─────────────────────────────────────────────────────────────

inline void XlethLimiterEffect::releaseEffect()
{
    momentaryBuf_.clear();
    shortTermBuf_.clear();
    gainReductionBuf_.clear();
}

// ── processEffect ─────────────────────────────────────────────────────────────

inline void XlethLimiterEffect::processEffect(juce::AudioBuffer<float>& buffer,
                                               juce::MidiBuffer& /*midi*/)
{
    const int numSamples  = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples == 0 || numChannels == 0) return;

    // ── A: Style (discrete, read once per block) ──────────────────────────────
    const int styleIdx = (int)std::round(*apvts_.getRawParameterValue("style"));
    if (styleIdx != prevStyle_)
    {
        prevStyle_ = styleIdx;
    }
    static constexpr float kBaseRelease[3] = { 100.0f, 50.0f, 20.0f };
    const float baseReleaseMs = kBaseRelease[juce::jlimit(0, 2, styleIdx)];
    (void)baseReleaseMs; // used implicitly via per-sample releaseMs below

    // ── B: Collect per-sample smoothed params ─────────────────────────────────
    // Allocate on stack for small blocks, heap via vector for safety
    std::vector<float> gainLin(   (size_t)numSamples);
    std::vector<float> ceilingLin((size_t)numSamples);
    std::vector<float> releaseMs( (size_t)numSamples);

    for (int i = 0; i < numSamples; ++i)
    {
        gainLin[i]    = juce::Decibels::decibelsToGain(getNextSmoothedValue("gain"));
        ceilingLin[i] = juce::Decibels::decibelsToGain(getNextSmoothedValue("ceiling"));
        releaseMs[i]  = getNextSmoothedValue("release");
    }

    // ── C: Fill detection buffer (gained input) and upsample ──────────────────
    const int detCh = juce::jmin(numChannels, 2);
    for (int ch = 0; ch < detCh; ++ch)
    {
        const float* src = buffer.getReadPointer(ch);
        float*       dst = detectionBuffer_.getWritePointer(ch);
        for (int i = 0; i < numSamples; ++i)
            dst[i] = src[i] * gainLin[i];
    }
    // Mirror mono to second channel if needed
    if (detCh == 1)
        detectionBuffer_.copyFrom(1, 0, detectionBuffer_, 0, 0, numSamples);

    // Wrap in AudioBlock and upsample — DO NOT call processSamplesDown
    juce::dsp::AudioBlock<float> detBlock(
        detectionBuffer_.getArrayOfWritePointers(), 2u, (size_t)numSamples);
    auto osBlock    = oversampler_.processSamplesUp(detBlock);
    const int osFactor = (int)oversampler_.getOversamplingFactor();   // == 4

    // ── D: True-peak per original sample (stereo-linked) ──────────────────────
    const int osTotal = (int)osBlock.getNumSamples();
    for (int i = 0; i < numSamples; ++i)
    {
        float pk   = 0.0f;
        const int base = i * osFactor;
        for (int ch = 0; ch < 2; ++ch)
        {
            const float* osData = osBlock.getChannelPointer((size_t)ch);
            const int end = juce::jmin(base + osFactor, osTotal);
            for (int k = base; k < end; ++k)
                pk = juce::jmax(pk, std::abs(osData[k]));
        }
        gainReductionBuf_[i] = pk;   // store true-peak; GR computed next step
    }

    // ── E: Required GR (first pass) ───────────────────────────────────────────
    for (int i = 0; i < numSamples; ++i)
    {
        const float ceil = ceilingLin[i];
        const float pk   = gainReductionBuf_[i];
        gainReductionBuf_[i] = (pk > ceil && pk > 1e-10f) ? ceil / pk : 1.0f;
    }

    // ── F: Backward pass — anticipatory onset ramp (lookahead smoothing) ──────
    // Going backward: if GR[i] > GR[i+1], the gain is about to drop (a transient
    // is coming). Cap GR[i] so the drop is gradual: GR[i] ≤ GR[i+1] / relCoeff.
    // This ensures a smooth ramp-down BEFORE the transient reaches the output.
    // prevGRstate_ carries the GR at sample 0 of the last block for continuity.
    {
        float nextGR = prevGRstate_;
        for (int i = numSamples - 1; i >= 0; --i)
        {
            // Release coefficient: fraction GR can recover per sample going forward
            const float relCoeff = std::exp(
                std::log(0.1f) / (float)(releaseMs[i] * 0.001 * sampleRate_));

            if (gainReductionBuf_[i] > nextGR)
                gainReductionBuf_[i] = juce::jmin(gainReductionBuf_[i],
                                                   nextGR / relCoeff);
            nextGR = gainReductionBuf_[i];
        }
        prevGRstate_ = gainReductionBuf_[0];
    }

    // ── G: Push to delay, apply GR, hard clip ─────────────────────────────────
    float minGR  = 1.0f;
    float peakL  = 0.0f;
    float peakR  = 0.0f;

    for (int ch = 0; ch < numChannels; ++ch)
    {
        for (int i = 0; i < numSamples; ++i)
        {
            const float inGained = buffer.getSample(ch, i) * gainLin[i];
            lookaheadDelay_.pushSample(ch, inGained);
            const float delayed = lookaheadDelay_.popSample(
                ch, (float)totalLookaheadSamples_);

            float out = delayed * gainReductionBuf_[i];
            // Hard clip — safety net; smoothing never perfectly reaches zero
            out = juce::jlimit(-ceilingLin[i], ceilingLin[i], out);
            buffer.setSample(ch, i, out);

            // Track GR from channel 0 (stereo-linked)
            if (ch == 0)
                minGR = juce::jmin(minGR, gainReductionBuf_[i]);
        }
    }

    // ── H: Output peak meters + visualization observation ────────────────────
    // Visualization is opt-in per instance; one acquire-load per block. When
    // disabled, the hot loop pays only a null-check.
    auto* vizCol = vizActive_.load(std::memory_order_acquire);

    const float* detL = detectionBuffer_.getReadPointer(0);
    const float* detR = (detectionBuffer_.getNumChannels() > 1)
                      ? detectionBuffer_.getReadPointer(1)
                      : detL;

    for (int i = 0; i < numSamples; ++i)
    {
        const float outLs = buffer.getSample(0, i);
        const float outRs = (numChannels > 1) ? buffer.getSample(1, i) : outLs;
        const float absOL = std::abs(outLs);
        const float absOR = std::abs(outRs);
        peakL = juce::jmax(peakL, absOL);
        if (numChannels > 1)
            peakR = juce::jmax(peakR, absOR);

        if (vizCol)
        {
            // Pre-limit gained input (stereo-linked max abs)
            const float absInL = std::abs(detL[i]);
            const float absInR = std::abs(detR[i]);
            const float vizAbsIn  = juce::jmax(absInL, absInR);
            const float vizAbsOut = juce::jmax(absOL,  absOR);

            // Per-sample GR converted to positive dB.
            const float gr   = gainReductionBuf_[i];
            const float grDbS = (gr > 1e-10f) ? (-20.0f * std::log10(gr)) : 40.0f;

            // Cheap mean-square contribution (stereo-summed).
            const float msIn  = 0.5f * (absInL * absInL + absInR * absInR);
            const float msOut = 0.5f * (absOL  * absOL  + absOR  * absOR);

            const float ceilingDbS = juce::Decibels::gainToDecibels(ceilingLin[i]);
            const float gainDbS    = juce::Decibels::gainToDecibels(gainLin[i]);
            const float releaseMsS = releaseMs[i];

            vizAccum_.observe(vizAbsIn, vizAbsOut, msIn, msOut, grDbS,
                              ceilingDbS, gainDbS, releaseMsS);
            ++vizSampleClock_;
            vizAccum_.advance(vizSampleClock_, *vizCol);
        }
        else
        {
            ++vizSampleClock_;
        }
    }
    writeMeterValue(0, peakL);
    writeMeterValue(1, peakR);

    // ── I: GR meter (slot 2) — positive dB = amount of reduction ─────────────
    const float grDb = (minGR > 1e-10f) ? -20.0f * std::log10(minGR) : 40.0f;
    writeMeterValue(2, grDb);

    // ── J: LUFS metering on OUTPUT (after hard clip) ──────────────────────────
    // BS.1770 stereo: LUFS = -0.691 + 10*log10(mean_sq_L + mean_sq_R)
    for (int i = 0; i < numSamples; ++i)
    {
        const float outL = buffer.getSample(0, i);
        const float outR = (numChannels > 1) ? buffer.getSample(1, i) : outL;

        const float kwL = processBiquad(
            processBiquad(outL, kPreCoeffs_, kweightState_[0].pre),
            kRlbCoeffs_, kweightState_[0].rlb);
        const float kwR = processBiquad(
            processBiquad(outR, kPreCoeffs_, kweightState_[1].pre),
            kRlbCoeffs_, kweightState_[1].rlb);

        const float msVal = kwL * kwL + kwR * kwR;

        // Momentary (400ms) ring buffer
        momentarySum_ -= momentaryBuf_[(size_t)momentaryPos_];
        momentaryBuf_[(size_t)momentaryPos_] = msVal;
        momentarySum_ += msVal;
        momentaryPos_ = (momentaryPos_ + 1) % momentaryW_;

        // Short-term (3s) ring buffer
        shortTermSum_ -= shortTermBuf_[(size_t)shortTermPos_];
        shortTermBuf_[(size_t)shortTermPos_] = msVal;
        shortTermSum_ += msVal;
        shortTermPos_ = (shortTermPos_ + 1) % shortTermW_;
    }

    const float momLUFS = -0.691f + 10.0f * std::log10(
        juce::jmax(momentarySum_ / (float)momentaryW_, 1e-10f));
    const float stLUFS  = -0.691f + 10.0f * std::log10(
        juce::jmax(shortTermSum_ / (float)shortTermW_, 1e-10f));
    writeMeterValue(3, momLUFS);
    writeMeterValue(4, stLUFS);

    // ── K: Debug throttle ─────────────────────────────────────────────────────
#if XLETH_DEBUG
    if (++blockCounter_ % 500 == 0)
    {
        const float ceilDb = juce::Decibels::gainToDecibels(ceilingLin[0]);
        juce::Logger::writeToLog(
            "[Limiter] GR: " + juce::String(grDb, 1)
            + " dB | Momentary: " + juce::String(momLUFS, 1)
            + " LUFS | Ceiling: " + juce::String(ceilDb, 1) + " dB");
    }
#endif
}
