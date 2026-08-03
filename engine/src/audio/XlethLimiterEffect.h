#pragma once

#include "audio/XlethEffectBase.h"
#include "audio/viz/DynamicsVizCollector.h"
#include "audio/viz/DynamicsVizFrame.h"

#include <juce_dsp/juce_dsp.h>
#include <algorithm>
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

// ── Limiter gain-computer building blocks ────────────────────────────────────
//
// All three pieces below are allocation-free once prepare() has run: they own
// fixed-capacity rings sized for the LONGEST style at the current sample rate,
// and only their *active window length* changes when the style changes.

namespace xleth_limiter
{

// Streaming moving minimum (monotonic wedge / van Herk-Lemire).
//
// push(x, W) returns min(x[n-W+1] … x[n]) in amortised O(1) with no allocation.
// The wedge holds a strictly increasing run of candidates; anything a newer,
// smaller sample dominates can never be the minimum again and is dropped.
class MovingMinimum
{
public:
    void prepare(int maxWindow)
    {
        capacity_ = juce::jmax(2, maxWindow + 1);
        val_.assign((std::size_t)capacity_, 0.0f);
        pos_.assign((std::size_t)capacity_, 0LL);
        reset(0.0f);
    }

    void reset(float seed)
    {
        head_ = 0; count_ = 0; n_ = 0;
        std::fill(val_.begin(), val_.end(), seed);
        std::fill(pos_.begin(), pos_.end(), 0LL);
    }

    // `window` may change between calls (style switch): entries that fall
    // outside the new window are trimmed here, and a wider window simply sees
    // a shorter history until it refills.
    float push(float x, int window) noexcept
    {
        while (count_ > 0
               && val_[(std::size_t)((head_ + count_ - 1) % capacity_)] >= x)
            --count_;

        if (count_ < capacity_)
        {
            const int slot = (head_ + count_) % capacity_;
            val_[(std::size_t)slot] = x;
            pos_[(std::size_t)slot] = n_;
            ++count_;
        }

        const std::int64_t oldest = n_ - (std::int64_t)window + 1;
        while (count_ > 1 && pos_[(std::size_t)head_] < oldest)
        {
            head_ = (head_ + 1) % capacity_;
            --count_;
        }

        ++n_;
        return val_[(std::size_t)head_];
    }

private:
    std::vector<float>        val_;
    std::vector<std::int64_t> pos_;
    int          capacity_ = 0;
    int          head_     = 0;
    int          count_    = 0;
    std::int64_t n_        = 0;
};

// Fixed-length moving average (box FIR) with a running sum.
// The sum is kept in double so a long run never accumulates float drift.
class BoxAverage
{
public:
    void prepare(int maxLen)
    {
        buf_.assign((std::size_t)juce::jmax(1, maxLen), 0.0f);
        len_ = 1; pos_ = 0; sum_ = 0.0; invLen_ = 1.0;
    }

    // Re-arm at a new length, pre-filled with `seed` so the output value is
    // continuous across the change (no click on a style switch).
    void configure(int len, float seed)
    {
        len_    = juce::jlimit(1, (int)buf_.size(), len);
        invLen_ = 1.0 / (double)len_;
        std::fill(buf_.begin(), buf_.begin() + len_, seed);
        sum_ = (double)seed * (double)len_;
        pos_ = 0;
    }

    int length() const noexcept { return len_; }

    float process(float x) noexcept
    {
        sum_ += (double)x - (double)buf_[(std::size_t)pos_];
        buf_[(std::size_t)pos_] = x;
        if (++pos_ >= len_) pos_ = 0;
        return (float)(sum_ * invLen_);
    }

private:
    std::vector<float> buf_;
    int    len_    = 1;
    int    pos_    = 0;
    double sum_    = 0.0;
    double invLen_ = 1.0;
};

// Asymptotic soft clipper. Linear (unity slope, C1) up to `knee`, then bends
// toward `ceiling` which it approaches but never reaches:
//     y = knee + range · u/(1+u),  u = (|x|-knee)/range,  range = ceiling-knee
// No transcendentals, monotonic, and bounded by the ceiling for any input.
inline float softClipToCeiling(float x, float ceiling, float knee) noexcept
{
    const float a = std::abs(x);
    if (a <= knee) return x;

    const float range = ceiling - knee;
    if (range <= 1.0e-9f) return juce::jlimit(-ceiling, ceiling, x);

    const float u = (a - knee) / range;
    const float y = knee + range * (u / (1.0f + u));
    return (x < 0.0f) ? -y : y;
}

// ── Style tunings ───────────────────────────────────────────────────────────
//
// The three styles are TUNINGS of one gain computer, not three algorithms.
// Only these numbers differ: how far ahead the transient stage looks, how long
// the gain is frozen before release starts, how the user's release time is
// scaled/floored, how many release poles are cascaded, and how much peak the
// output saturator is allowed to absorb.
struct StyleTuning
{
    float lookaheadMs;    // transient-stage window; also the FIR smoothing length
    float holdMs;         // delayed release — gain frozen this long after any dip
    float releaseScale;   // multiplies the user's release time
    float minReleaseMs;   // floor applied AFTER scaling (anti-flutter)
    int   releaseStages;  // cascaded one-poles, each with release/N
    float overshootDb;    // peak allowance handed to the output saturator
    float softKneeDb;     // saturator knee below the ceiling (0 = hard clip only)
};

inline constexpr StyleTuning kStyles[3] = {
    /* 0 Transparent */ { 3.0f, 20.0f, 1.50f, 40.0f, 3, 0.0f, 0.0f },
    /* 1 Punchy      */ { 1.5f, 10.0f, 0.80f, 25.0f, 2, 0.0f, 0.0f },
    /* 2 Aggressive  */ { 0.8f,  5.0f, 0.50f, 12.0f, 2, 1.2f, 0.8f },
};

inline constexpr float kMaxLookaheadMs   = 3.0f;  // == max(kStyles[].lookaheadMs)
inline constexpr int   kMaxReleaseStages = 3;
inline constexpr int   kBoxStages        = 2;     // cascaded box filters

// dB ⇄ linear without pow/log10 (natural-log forms).
inline constexpr float kDbToLn   = 0.11512925464970229f;  // ln(10)/20
inline constexpr float kLnToDb   = 8.685889638065035f;    // 20/ln(10)

} // namespace xleth_limiter

// ── XlethLimiterEffect ────────────────────────────────────────────────────────
//
// Two-stage brickwall limiter (transient stage + release stage), in the spirit
// of a modern mastering limiter:
//
//   input ─┬─ ×drive ─→ lookahead delay ──────────────→ × gain → saturate → out
//          └─ ×drive ─→ 4× FIR upsample → true peak ─┐
//                                                    │
//   required gain (dB) ── moving MINIMUM over the lookahead window   (attack)
//                      ── hold (delayed release) + cascaded one-poles (release)
//                      ── cascaded box FIRs, total support ≤ lookahead (polish)
//
// Why this shape:
//
//   • Attack — the moving minimum makes the gain reach its target BEFORE the
//     transient arrives; the box cascade then rounds the ramp. Because every
//     tap of the box cascade sits inside the min window, the smoothed gain is
//     provably ≤ the required gain at the sample it is applied to, so the
//     brickwall ceiling survives the smoothing (proof in the comment at §E).
//
//   • Hold — after any dip the gain is frozen for holdMs before release starts.
//     This is what kills the crackle: without it, a short release lets the
//     envelope recover inside a single low-frequency cycle, which amplitude-
//     modulates the waveform (harmonic + intermodulation distortion). The hold
//     floor applies no matter how short a release the user dials in.
//
//   • Release — 2-3 cascaded one-poles, each with time constant release/N, so
//     the recovery curve is continuous in value AND gradient. A single pole
//     starts releasing with a corner (a step in slope) which clicks; a cascade
//     starts from zero slope. The final box pass sits after the release stage
//     precisely so any residual corner gets rounded off.
//
//   • Saturation — Aggressive deliberately leaves ~1.2 dB of peak for the
//     output soft clipper instead of asking the envelope to chase it. The
//     distortion moves from the gain envelope (crackle) to the waveform tips
//     (musical saturation). Transparent/Punchy leave the clipper unused; the
//     hard clip below is only a numerical safety net.
//
// Latency: lookahead + detection-path oversampler latency, reported via
// setLatencySamples() (AudioGraph reads getLatencySamples() and compensates —
// see the PDC planner in AudioGraph.cpp). Latency is only ever republished on
// the main thread (prepare / style change / state restore), never in
// processEffect, so the graph never re-plans from the audio thread.
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

    // Lookahead length for a style, in samples. Pure function of (style, rate)
    // so the main thread (latency reporting) and the audio thread (delay tap)
    // always agree without sharing mutable state.
    static int styleLookaheadSamples(int styleIdx, double sr)
    {
        const auto& st = xleth_limiter::kStyles[juce::jlimit(0, 2, styleIdx)];
        return juce::jmax(2, (int)std::ceil((double)st.lookaheadMs * 0.001 * sr));
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

    // ── Gain computer ─────────────────────────────────────────────────────────
    xleth_limiter::MovingMinimum minTracker_;                     // attack stage
    std::array<float, xleth_limiter::kMaxReleaseStages> relState_{}; // release cascade (dB)
    std::array<xleth_limiter::BoxAverage, xleth_limiter::kBoxStages> boxStages_{};
    int   holdCounter_  = 0;
    int   holdSamples_  = 0;
    int   minWindow_    = 3;   // == lookahead + 1
    int   boxLen_       = 2;   // per-stage box length
    int   activeStyle_  = -1;  // style the stages are currently armed for
    float lastGainDb_   = 0.0f;

    // ── Per-block scratch (preallocated; never resized on the audio thread) ───
    std::vector<float> peakBuf_;      // true peak of the driven input
    std::vector<float> driveLinBuf_;  // input gain, linear
    std::vector<float> gainDbBuf_;    // computed limiter gain, dB (≤ 0)
    std::vector<float> gainLinBuf_;   // computed limiter gain, linear (≤ 1)

    // ── Parameter access resolved once, in prepareEffect ──────────────────────
    // Handles for the smoothed params; a raw atomic pointer for the discrete
    // style, so the audio thread does no APVTS map lookup per block.
    SmoothedHandle      hGain_, hCeiling_, hRelease_;
    std::atomic<float>* styleParam_ = nullptr;

    // ── State ─────────────────────────────────────────────────────────────────
    int    prevStyle_             = -1;    // detect style changes (main thread)
    int    osLatencySamples_      = 0;
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
    void armStyleStages(int styleIdx, float seedDb);   // audio thread, no alloc
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
// Main thread only. Publishes the processor latency for the PDC planner; the
// audio thread never calls this (it derives the same number from the style via
// styleLookaheadSamples(), so the two can never disagree).

inline void XlethLimiterEffect::updateLookahead(int styleIdx, double sr)
{
    const int oversamplerLatency = (int)std::ceil(oversampler_.getLatencyInSamples());
    totalLookaheadSamples_ = styleLookaheadSamples(styleIdx, sr) + oversamplerLatency;

    if (totalLookaheadSamples_ != AudioProcessor::getLatencySamples())
    {
        setLatencySamples(totalLookaheadSamples_);
        nonRealtimeLatencyUpdateCount_.fetch_add(1, std::memory_order_acq_rel);
    }
}

// ── armStyleStages ────────────────────────────────────────────────────────────
// Re-arms the window lengths of the gain computer for a style. Called once from
// prepareEffect and then only when the style actually changes — a bounded,
// allocation-free loop over rings that are already sized for the longest style.
// The box stages are re-seeded with the current gain so the envelope value stays
// continuous across the switch (no click from the gain path itself).

inline void XlethLimiterEffect::armStyleStages(int styleIdx, float seedDb)
{
    const int la = styleLookaheadSamples(styleIdx, sampleRate_);

    // Moving-minimum window covers the whole lookahead (current sample + la).
    minWindow_ = la + 1;

    // Box cascade support must stay inside the min window, i.e.
    //   kBoxStages · (boxLen - 1) ≤ la   ⟹   boxLen = ⌊la / kBoxStages⌋ + 1.
    boxLen_ = la / xleth_limiter::kBoxStages + 1;
    for (auto& box : boxStages_)
        box.configure(boxLen_, seedDb);

    // Re-seed the release cascade too: the stage count differs between styles,
    // so a stage that was idle must not wake up holding a stale value.
    relState_.fill(seedDb);

    const auto& st = xleth_limiter::kStyles[juce::jlimit(0, 2, styleIdx)];
    holdSamples_ = (int)std::lround((double)st.holdMs * 0.001 * sampleRate_);
    holdCounter_ = juce::jmin(holdCounter_, holdSamples_);

    activeStyle_ = styleIdx;
}

// ── prepareEffect ─────────────────────────────────────────────────────────────

inline void XlethLimiterEffect::prepareEffect(double sampleRate, int maxBlockSize)
{
    sampleRate_ = sampleRate;
    computeKWeightingCoeffs(sampleRate);

    hGain_      = resolveSmoothed("gain");
    hCeiling_   = resolveSmoothed("ceiling");
    hRelease_   = resolveSmoothed("release");
    styleParam_ = apvts_.getRawParameterValue("style");

    // Oversampler — must init before calling getLatencyInSamples()
    oversampler_.initProcessing((size_t)maxBlockSize);
    oversampler_.reset();

    // Lookahead delay line
    osLatencySamples_         = (int)std::ceil(oversampler_.getLatencyInSamples());
    const int maxDelaySamples = (int)std::ceil(5.0 * 0.001 * sampleRate)
                                + osLatencySamples_ + 5;

    juce::dsp::ProcessSpec spec{ sampleRate,
                                 (juce::uint32)maxBlockSize,
                                 2u };
    lookaheadDelay_.prepare(spec);
    lookaheadDelay_.setMaximumDelayInSamples(maxDelaySamples);
    lookaheadDelay_.reset();

    // Working buffers
    detectionBuffer_.setSize(2, maxBlockSize);
    peakBuf_    .assign((std::size_t)maxBlockSize, 0.0f);
    driveLinBuf_.assign((std::size_t)maxBlockSize, 1.0f);
    gainDbBuf_  .assign((std::size_t)maxBlockSize, 0.0f);
    gainLinBuf_ .assign((std::size_t)maxBlockSize, 1.0f);

    // Gain-computer rings, sized for the LONGEST style so a style switch never
    // has to allocate. kMaxLookaheadMs must stay == max(kStyles[].lookaheadMs).
    const int maxLa = (int)std::ceil((double)xleth_limiter::kMaxLookaheadMs
                                     * 0.001 * sampleRate) + 2;
    minTracker_.prepare(maxLa + 1);
    minTracker_.reset(0.0f);
    for (auto& box : boxStages_)
        box.prepare(maxLa);

    relState_.fill(0.0f);
    holdCounter_ = 0;
    lastGainDb_  = 0.0f;
    activeStyle_ = -1;

    // LUFS ring buffers
    momentaryW_ = (int)std::round(0.400 * sampleRate);
    shortTermW_ = (int)std::round(3.000 * sampleRate);
    momentaryBuf_.assign((size_t)momentaryW_, 0.0f);
    shortTermBuf_.assign((size_t)shortTermW_, 0.0f);
    momentarySum_ = 0.0f;  shortTermSum_ = 0.0f;
    momentaryPos_ = 0;     shortTermPos_ = 0;

    // Initial lookahead + stage arming from the current style param
    const int initStyle = juce::jlimit(
        0, 2, (int)std::round(*apvts_.getRawParameterValue("style")));
    updateLookahead(initStyle, sampleRate);
    armStyleStages(initStyle, 0.0f);
    prevStyle_ = initStyle;

    // Zero state
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

    minTracker_.reset(0.0f);
    relState_.fill(0.0f);
    for (auto& box : boxStages_)
        box.configure(box.length(), 0.0f);
    holdCounter_ = 0;
    lastGainDb_  = 0.0f;

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
    peakBuf_.clear();
    driveLinBuf_.clear();
    gainDbBuf_.clear();
    gainLinBuf_.clear();
}

// ── processEffect ─────────────────────────────────────────────────────────────

inline void XlethLimiterEffect::processEffect(juce::AudioBuffer<float>& buffer,
                                               juce::MidiBuffer& /*midi*/)
{
    const int numSamples  = buffer.getNumSamples();
    const int numChannels = buffer.getNumChannels();
    if (numSamples == 0 || numChannels == 0) return;

    // Scratch is sized for maxBlockSize in prepareEffect; a larger block would
    // mean the host broke its own contract. Bail out rather than allocate or
    // run off the end of the rings.
    if ((int)peakBuf_.size() < numSamples) return;

    // ── A: Style (discrete, read once per block) ──────────────────────────────
    const int styleIdx = styleParam_
        ? juce::jlimit(0, 2, (int)std::lround(
              styleParam_->load(std::memory_order_relaxed)))
        : 0;
    const auto& style = xleth_limiter::kStyles[styleIdx];

    if (styleIdx != activeStyle_)
        armStyleStages(styleIdx, lastGainDb_);

    // Delay tap is derived from the style, exactly as updateLookahead() derives
    // the reported latency — the audio thread never reads main-thread state.
    const int delaySamples = styleLookaheadSamples(styleIdx, sampleRate_)
                           + osLatencySamples_;

    // ── B: Block-rate parameter endpoints ─────────────────────────────────────
    // Every smoothed parameter is sampled at the block's first and last sample
    // and linearly interpolated in between, so the per-sample loop pays no
    // exp/pow for parameters. skip() leaves the smoother exactly where the
    // next block's current() expects it, so the ramp stays continuous.
    const float invN = 1.0f / (float)numSamples;

    const float gainDb0  = hGain_.current();
    const float gainDb1  = hGain_.peekAfter(numSamples);
    hGain_.skip(numSamples);
    const float driveLin0 = juce::Decibels::decibelsToGain(gainDb0);
    const float driveLin1 = juce::Decibels::decibelsToGain(gainDb1);
    const float driveStep = (driveLin1 - driveLin0) * invN;
    const float gainDbStep = (gainDb1 - gainDb0) * invN;

    const float ceilDb0  = hCeiling_.current();
    const float ceilDb1  = hCeiling_.peekAfter(numSamples);
    hCeiling_.skip(numSamples);
    const float ceilDbStep  = (ceilDb1 - ceilDb0) * invN;
    const float ceilLin0    = juce::Decibels::decibelsToGain(ceilDb0);
    const float ceilLin1    = juce::Decibels::decibelsToGain(ceilDb1);
    const float ceilLinStep = (ceilLin1 - ceilLin0) * invN;

    const float relMs0 = hRelease_.current();
    const float relMs1 = hRelease_.peekAfter(numSamples);
    hRelease_.skip(numSamples);
    const float relMsStep = (relMs1 - relMs0) * invN;

    // One-pole coefficient per release stage. The user's release is scaled and
    // floored per style, then split across the cascade (release / N each), so
    // the composite recovery still lands near the requested time while every
    // individual stage stays smooth. The floor is what guarantees that a very
    // short release cannot reintroduce per-cycle gain modulation.
    auto releaseCoef = [&](float userMs) noexcept
    {
        const float effMs = juce::jmax(userMs * style.releaseScale, style.minReleaseMs);
        const float tau   = juce::jmax(1.0f, effMs * 0.001f * (float)sampleRate_
                                             / (float)style.releaseStages);
        return 1.0f - std::exp(-1.0f / tau);
    };
    const float relCoef0    = releaseCoef(relMs0);
    const float relCoefStep = (releaseCoef(relMs1) - relCoef0) * invN;

    // Saturator geometry (linear, relative to the ceiling).
    const bool  useSoftClip = style.softKneeDb > 0.0f;
    const float kneeScale   = useSoftClip
                            ? std::exp(-style.softKneeDb * xleth_limiter::kDbToLn)
                            : 1.0f;

    // ── C: Fill detection buffer (driven input) and upsample ──────────────────
    {
        float drive = driveLin0;
        for (int i = 0; i < numSamples; ++i, drive += driveStep)
            driveLinBuf_[(std::size_t)i] = drive;
    }

    const int detCh = juce::jmin(numChannels, 2);
    for (int ch = 0; ch < detCh; ++ch)
    {
        const float* src = buffer.getReadPointer(ch);
        float*       dst = detectionBuffer_.getWritePointer(ch);
        for (int i = 0; i < numSamples; ++i)
            dst[i] = src[i] * driveLinBuf_[(std::size_t)i];
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
        peakBuf_[(std::size_t)i] = pk;
    }

    // ── E: Gain computer (dB domain, stereo-linked) ───────────────────────────
    //
    // Ceiling proof. Write r[n] for the required gain, m[n] = min(r[n-L…n]) for
    // the moving minimum (L = lookahead), e[n] for the release-stage output and
    // a[n] = Σ_j w_j·e[n-j] for the box cascade (w ≥ 0, Σw = 1, support j ≤ L).
    // The release cascade tracks downwards instantly, so e[n] ≤ m[n]; and for
    // any 0 ≤ j ≤ L the sample n-L lies inside m[n-j]'s window, so
    // m[n-j] ≤ r[n-L]. Hence a[n] ≤ Σ_j w_j·r[n-L] = r[n-L] — the gain applied
    // to the sample leaving the delay line is never above what that sample
    // required. The hard clip at the end of §F is therefore dead code in
    // steady state and only catches parameter jumps / style switches.
    {
        const int nStages = style.releaseStages;
        float ceilDb  = ceilDb0;
        float relCoef = relCoef0;

        for (int i = 0; i < numSamples; ++i, ceilDb += ceilDbStep, relCoef += relCoefStep)
        {
            // Required gain: the detection threshold is the ceiling plus the
            // overshoot this style hands to the output saturator.
            const float thrDb = ceilDb + style.overshootDb;
            const float pk    = peakBuf_[(std::size_t)i];
            float reqDb = 0.0f;
            if (pk > 1.0e-9f)
            {
                const float pkDb = xleth_limiter::kLnToDb * std::log(pk);
                if (pkDb > thrDb)
                    reqDb = juce::jmax(thrDb - pkDb, -120.0f);
            }

            // Attack stage: inverted peak hold over the lookahead window.
            const float mDb = minTracker_.push(reqDb, minWindow_);

            // Release stage: instant attack (so the bound above survives),
            // then hold, then a cascade of one-poles.
            if (mDb <= relState_[0])
            {
                relState_[0] = mDb;
                holdCounter_ = holdSamples_;
            }
            else if (holdCounter_ > 0)
            {
                --holdCounter_;            // delayed release: gain frozen
            }
            else
            {
                relState_[0] += (mDb - relState_[0]) * relCoef;
            }

            for (int k = 1; k < nStages; ++k)
            {
                const float in = relState_[(std::size_t)(k - 1)];
                float&      y  = relState_[(std::size_t)k];
                if (in <= y) y  = in;
                else         y += (in - y) * relCoef;
            }

            // Finite-length smoothing pass, after the release stage so the
            // corner where release begins gets rounded off too.
            float gDb = relState_[(std::size_t)(nStages - 1)];
            gDb = boxStages_[0].process(gDb);
            gDb = boxStages_[1].process(gDb);

            gainDbBuf_[(std::size_t)i]  = gDb;
            gainLinBuf_[(std::size_t)i] = (gDb >= -1.0e-5f)
                                        ? 1.0f
                                        : std::exp(gDb * xleth_limiter::kDbToLn);
        }

        lastGainDb_ = gainDbBuf_[(std::size_t)(numSamples - 1)];
    }

    // ── F: Push to delay, apply gain, saturate ────────────────────────────────
    // The delay line was prepared for 2 channels (the effect's bus layout is
    // stereo); clamp so a wider buffer can never write past it.
    const int procCh = juce::jmin(numChannels, 2);
    for (int ch = 0; ch < procCh; ++ch)
    {
        float* data    = buffer.getWritePointer(ch);
        float  ceilLin = ceilLin0;

        for (int i = 0; i < numSamples; ++i, ceilLin += ceilLinStep)
        {
            const float inGained = data[i] * driveLinBuf_[(std::size_t)i];
            lookaheadDelay_.pushSample(ch, inGained);
            const float delayed = lookaheadDelay_.popSample(ch, (float)delaySamples);

            float out = delayed * gainLinBuf_[(std::size_t)i];

            // Aggressive leaves headroom for this saturator on purpose; the
            // other styles never reach it (see the proof at §E) and only keep
            // the hard clip as a numerical safety net.
            if (useSoftClip)
                out = xleth_limiter::softClipToCeiling(out, ceilLin,
                                                       ceilLin * kneeScale);

            data[i] = juce::jlimit(-ceilLin, ceilLin, out);
        }
    }

    // ── G: Output peak meters + visualization observation ────────────────────
    // Visualization is opt-in per instance; one acquire-load per block. When
    // disabled, the hot loop pays only a null-check.
    auto* vizCol = vizActive_.load(std::memory_order_acquire);

    const float* detL = detectionBuffer_.getReadPointer(0);
    const float* detR = (detectionBuffer_.getNumChannels() > 1)
                      ? detectionBuffer_.getReadPointer(1)
                      : detL;

    float minGainDb = 0.0f;
    float peakL     = 0.0f;
    float peakR     = 0.0f;
    float ceilDbM   = ceilDb0;
    float gainDbM   = gainDb0;
    float relMsM    = relMs0;

    for (int i = 0; i < numSamples; ++i,
         ceilDbM += ceilDbStep, gainDbM += gainDbStep, relMsM += relMsStep)
    {
        const float outLs = buffer.getSample(0, i);
        const float outRs = (numChannels > 1) ? buffer.getSample(1, i) : outLs;
        const float absOL = std::abs(outLs);
        const float absOR = std::abs(outRs);
        peakL = juce::jmax(peakL, absOL);
        if (numChannels > 1)
            peakR = juce::jmax(peakR, absOR);

        minGainDb = juce::jmin(minGainDb, gainDbBuf_[(std::size_t)i]);

        if (vizCol)
        {
            // Pre-limit driven input (stereo-linked max abs)
            const float absInL = std::abs(detL[i]);
            const float absInR = std::abs(detR[i]);
            const float vizAbsIn  = juce::jmax(absInL, absInR);
            const float vizAbsOut = juce::jmax(absOL,  absOR);

            // Per-sample GR as positive dB — already in the dB domain, so no
            // log10 here.
            const float grDbS = -gainDbBuf_[(std::size_t)i];

            // Cheap mean-square contribution (stereo-summed).
            const float msIn  = 0.5f * (absInL * absInL + absInR * absInR);
            const float msOut = 0.5f * (absOL  * absOL  + absOR  * absOR);

            vizAccum_.observe(vizAbsIn, vizAbsOut, msIn, msOut, grDbS,
                              ceilDbM, gainDbM, relMsM);
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

    // ── H: GR meter (slot 2) — positive dB = amount of reduction ─────────────
    const float grDb = -minGainDb;
    writeMeterValue(2, grDb);

    // ── I: LUFS metering on OUTPUT (after the saturator) ──────────────────────
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

    // ── J: Debug throttle ─────────────────────────────────────────────────────
#if XLETH_DEBUG
    if (++blockCounter_ % 500 == 0)
    {
        juce::Logger::writeToLog(
            "[Limiter] GR: " + juce::String(grDb, 1)
            + " dB | Momentary: " + juce::String(momLUFS, 1)
            + " LUFS | Ceiling: " + juce::String(ceilDb0, 1) + " dB");
    }
#endif
}
