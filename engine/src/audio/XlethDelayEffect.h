#pragma once

#include "audio/XlethEffectBase.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>

// ─── XlethDelayEffect ────────────────────────────────────────────────────────
// Stereo delay with tempo sync, independent L/R times, feedback filtering,
// LFO modulation, ping-pong cross-feed, and input-driven ducking.
//
// Parameters (APVTS-backed):
//   time_l        1–5000 ms       (cascaded one-pole 80ms, NOT SmoothedValue)
//   time_r        1–5000 ms       (cascaded one-pole 80ms, NOT SmoothedValue)
//   sync          0/1             (discrete: 0=Free, 1=Sync)
//   sync_div_l    0–11            (discrete: index into beat fractions)
//   sync_div_r    0–11            (discrete: index into beat fractions)
//   feedback      0–95 %          (Linear 20ms smoothing)
//   filter_lo     20–2000 Hz      (Multiplicative 30ms smoothing)
//   filter_hi     1000–20000 Hz   (Multiplicative 30ms smoothing)
//   mod_rate      0.01–5 Hz       (Linear 20ms smoothing)
//   mod_depth     0–100 %         (Linear 20ms smoothing)
//   stereo_width  0–100 %         (Linear 20ms smoothing)
//   duck_amount   0–100 %         (Linear 20ms smoothing)
//   mix           0–100 %         (Linear 20ms smoothing)
//
// Sync divisions: 0=1/1, 1=1/2, 2=1/2D, 3=1/4, 4=1/4D, 5=1/4T,
//                 6=1/8, 7=1/8D, 8=1/8T, 9=1/16, 10=1/16D, 11=1/16T
//
// Metering slots:
//   0 — L channel wet peak (absolute, max over block)
//   1 — R channel wet peak
//
// pluginId: "delay"

class XlethDelayEffect : public XlethEffectBase
{
public:
    XlethDelayEffect() : XlethEffectBase("delay", createLayout())
    {
        // Register base-class smoothers for continuous params.
        // time_l / time_r use custom cascaded one-pole — NOT registered here.
        registerSmoothedParam("feedback",     SmoothType::Linear,          20.0f);
        registerSmoothedParam("filter_lo",    SmoothType::Multiplicative,  30.0f);
        registerSmoothedParam("filter_hi",    SmoothType::Multiplicative,  30.0f);
        registerSmoothedParam("mod_rate",     SmoothType::Linear,          20.0f);
        registerSmoothedParam("mod_depth",    SmoothType::Linear,          20.0f);
        registerSmoothedParam("stereo_width", SmoothType::Linear,          20.0f);
        registerSmoothedParam("duck_amount",  SmoothType::Linear,          20.0f);
        registerSmoothedParam("mix",          SmoothType::Linear,          20.0f);
    }

    // ── prepareEffect ───────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;

        // Resolve raw APVTS pointers for discrete + custom-smoothed params
        timeLPtr_    = apvts_.getRawParameterValue("time_l");
        timeRPtr_    = apvts_.getRawParameterValue("time_r");
        syncPtr_     = apvts_.getRawParameterValue("sync");
        syncDivLPtr_ = apvts_.getRawParameterValue("sync_div_l");
        syncDivRPtr_ = apvts_.getRawParameterValue("sync_div_r");

        // Delay lines: 5 seconds at max sample rate
        const int maxDelaySamples = static_cast<int>(5.0 * sampleRate) + 1;

        delayLineL_.setMaximumDelayInSamples(maxDelaySamples);
        delayLineR_.setMaximumDelayInSamples(maxDelaySamples);

        juce::dsp::ProcessSpec spec;
        spec.sampleRate       = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
        spec.numChannels      = 1;  // each delay line is mono
        delayLineL_.prepare(spec);
        delayLineR_.prepare(spec);
        delayLineL_.reset();
        delayLineR_.reset();

        maxDelaySamples_ = maxDelaySamples;

        // Cascaded one-pole coefficient for delay time smoothing (80ms)
        smoothCoeff_ = 1.0f - std::exp(-1.0f / (0.08f * static_cast<float>(sampleRate)));

        // Initialize smooth states to current param values
        const float initL = timeLPtr_ ? timeLPtr_->load(std::memory_order_relaxed) : 500.0f;
        const float initR = timeRPtr_ ? timeRPtr_->load(std::memory_order_relaxed) : 500.0f;
        smoothTimeL_[0] = initL;
        smoothTimeL_[1] = initL;
        smoothTimeR_[0] = initR;
        smoothTimeR_[1] = initR;

        // Reset filter states
        lpStateL_ = 0.0f;  lpStateR_ = 0.0f;
        hpStateL_ = 0.0f;  hpStateR_ = 0.0f;

        // Reset LFO
        lfoPhase_ = 0.0f;

        // Ducking envelope coefficients
        duckAttackCoeff_  = std::exp(-1.0f / (0.001f * static_cast<float>(sampleRate)));
        duckReleaseCoeff_ = std::exp(-1.0f / (0.200f * static_cast<float>(sampleRate)));
        duckEnvelope_ = 0.0f;

#ifdef XLETH_DEBUG
        DBG("[Delay] prepareToPlay sr=" + juce::String(sampleRate)
            + " blockSize=" + juce::String(maxBlockSize)
            + " maxDelay=" + juce::String(maxDelaySamples) + " samples");
#endif
    }

    // ── resetEffect ─────────────────────────────────────────────────────────
    void resetEffect() override
    {
        delayLineL_.reset();
        delayLineR_.reset();
        lpStateL_ = 0.0f;  lpStateR_ = 0.0f;
        hpStateL_ = 0.0f;  hpStateR_ = 0.0f;
        lfoPhase_ = 0.0f;
        duckEnvelope_ = 0.0f;
    }

    // ── getTailLengthSeconds ────────────────────────────────────────────────
    // Time for feedback to decay to -60 dB: n repeats × delay time, where
    // n = -3 / log10(feedback).  Accounts for sync mode via global BPM.
    double getTailLengthSeconds() const override
    {
        const float fb = getSmoothedValue("feedback") / 100.0f; // 0–0.95
        if (fb < 0.01f) return 0.0;

        float maxTimeMs;
        if (syncPtr_ && syncPtr_->load(std::memory_order_relaxed) >= 0.5f)
        {
            double bpm = getGlobalBPM();
            if (bpm <= 0.0) bpm = 140.0;
            const float beatMs = 60000.0f / static_cast<float>(bpm);
            const int divL = syncDivLPtr_
                ? std::clamp(static_cast<int>(syncDivLPtr_->load(std::memory_order_relaxed)), 0, 11)
                : 3;
            const int divR = syncDivRPtr_
                ? std::clamp(static_cast<int>(syncDivRPtr_->load(std::memory_order_relaxed)), 0, 11)
                : 3;
            maxTimeMs = std::max(beatMs * kDivFractions[divL],
                                beatMs * kDivFractions[divR]);
        }
        else
        {
            const float tL = timeLPtr_ ? timeLPtr_->load(std::memory_order_relaxed) : 500.0f;
            const float tR = timeRPtr_ ? timeRPtr_->load(std::memory_order_relaxed) : 500.0f;
            maxTimeMs = std::max(tL, tR);
        }

        // -60 dB = -3 bels → repeats = -3 / log10(fb)
        const float repeats = -3.0f / std::log10(std::max(fb, 0.01f));
        return static_cast<double>(repeats * maxTimeMs * 0.001f);
    }

    // ── processEffect ───────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh      = buffer.getNumChannels();
        const float sr       = static_cast<float>(sampleRate_);

        // ── Discrete params: read once per block ────────────────────────────
        const bool  synced   = syncPtr_
                             ? (syncPtr_->load(std::memory_order_relaxed) >= 0.5f)
                             : false;
        const int   divL     = syncDivLPtr_
                             ? std::clamp(static_cast<int>(syncDivLPtr_->load(std::memory_order_relaxed)), 0, 11)
                             : 3;
        const int   divR     = syncDivRPtr_
                             ? std::clamp(static_cast<int>(syncDivRPtr_->load(std::memory_order_relaxed)), 0, 11)
                             : 3;

        // ── Compute target delay times (ms) ─────────────────────────────────
        float targetTimeL, targetTimeR;

        if (synced)
        {
            double bpm = getGlobalBPM();
            if (bpm <= 0.0) bpm = 140.0;
            const float beatMs = 60000.0f / static_cast<float>(bpm);
            targetTimeL = std::clamp(beatMs * kDivFractions[divL], 1.0f, 5000.0f);
            targetTimeR = std::clamp(beatMs * kDivFractions[divR], 1.0f, 5000.0f);
        }
        else
        {
            targetTimeL = timeLPtr_ ? timeLPtr_->load(std::memory_order_relaxed) : 500.0f;
            targetTimeR = timeRPtr_ ? timeRPtr_->load(std::memory_order_relaxed) : 500.0f;
        }

        const float maxDelaySamplesF = static_cast<float>(maxDelaySamples_ - 1);

        float peakL = 0.0f, peakR = 0.0f;

#ifdef XLETH_DEBUG
        static int blockCount_ = 0;
        ++blockCount_;
        const bool doLog = (blockCount_ % 1000 == 0);
#endif

        // ── Per-sample loop ─────────────────────────────────────────────────
        for (int s = 0; s < numSamples; ++s)
        {
            // Advance base-class smoothers
            const float feedbackPct  = getNextSmoothedValue("feedback");
            const float filterLo     = getNextSmoothedValue("filter_lo");
            const float filterHi     = getNextSmoothedValue("filter_hi");
            const float modRate      = getNextSmoothedValue("mod_rate");
            const float modDepth     = getNextSmoothedValue("mod_depth");
            const float stereoWidth  = getNextSmoothedValue("stereo_width");
            const float duckAmount   = getNextSmoothedValue("duck_amount");
            const float mixPct       = getNextSmoothedValue("mix");

            // ── 1. Cascaded one-pole delay time smoothing (2 stages) ────────
            smoothTimeL_[0] += smoothCoeff_ * (targetTimeL - smoothTimeL_[0]);
            smoothTimeL_[1] += smoothCoeff_ * (smoothTimeL_[0] - smoothTimeL_[1]);
            smoothTimeR_[0] += smoothCoeff_ * (targetTimeR - smoothTimeR_[0]);
            smoothTimeR_[1] += smoothCoeff_ * (smoothTimeR_[0] - smoothTimeR_[1]);

            // Convert ms → samples
            float delaySamplesL = smoothTimeL_[1] * 0.001f * sr;
            float delaySamplesR = smoothTimeR_[1] * 0.001f * sr;

            // ── 2. LFO modulation ───────────────────────────────────────────
            const float lfoVal = std::sin(2.0f * juce::MathConstants<float>::pi * lfoPhase_);
            lfoPhase_ += modRate / sr;
            if (lfoPhase_ >= 1.0f) lfoPhase_ -= 1.0f;

            // maxModDepth = 0.5ms at depth=100%
            const float modSamples = lfoVal * 0.0005f * sr * (modDepth / 100.0f);
            delaySamplesL += modSamples;
            delaySamplesR -= modSamples;  // opposite phase for stereo interest

            // Clamp to valid range
            delaySamplesL = std::clamp(delaySamplesL, 1.0f, maxDelaySamplesF);
            delaySamplesR = std::clamp(delaySamplesR, 1.0f, maxDelaySamplesF);

            // ── 3. Pop FIRST (read delayed signal before push) ──────────────
            const float delayedL = delayLineL_.popSample(0, delaySamplesL);
            const float delayedR = delayLineR_.popSample(0, delaySamplesR);

            // ── 4. Feedback filtering (one-pole LP then HP in series) ───────
            // LP: removes highs above filter_hi
            const float lpCoeff = std::exp(-2.0f * juce::MathConstants<float>::pi * filterHi / sr);
            lpStateL_ = lpCoeff * lpStateL_ + (1.0f - lpCoeff) * delayedL;
            lpStateR_ = lpCoeff * lpStateR_ + (1.0f - lpCoeff) * delayedR;

            // HP: removes lows below filter_lo (applied to LP output)
            const float hpCoeff = std::exp(-2.0f * juce::MathConstants<float>::pi * filterLo / sr);
            hpStateL_ += (1.0f - hpCoeff) * (lpStateL_ - hpStateL_);
            hpStateR_ += (1.0f - hpCoeff) * (lpStateR_ - hpStateR_);
            const float filteredL = lpStateL_ - hpStateL_;
            const float filteredR = lpStateR_ - hpStateR_;

            // ── 5. Ping-pong cross-feed ─────────────────────────────────────
            const float crossAmt = stereoWidth / 100.0f;
            float fbL = filteredL * (1.0f - crossAmt) + filteredR * crossAmt;
            float fbR = filteredR * (1.0f - crossAmt) + filteredL * crossAmt;

            // ── 6. Apply feedback gain and clamp ────────────────────────────
            const float fbGain = feedbackPct / 100.0f;
            fbL = std::clamp(fbL * fbGain, -0.95f, 0.95f);
            fbR = std::clamp(fbR * fbGain, -0.95f, 0.95f);

            // ── 7. Read dry input ───────────────────────────────────────────
            const float inputL = buffer.getSample(0, s);
            const float inputR = numCh > 1 ? buffer.getSample(1, s) : inputL;

            // ── 8. Push to delay lines (input + feedback) ───────────────────
            delayLineL_.pushSample(0, inputL + fbL);
            delayLineR_.pushSample(0, inputR + fbR);

            // ── 9. Ducking envelope ─────────────────────────────────────────
            const float inputLevel = std::max(std::abs(inputL), std::abs(inputR));
            if (inputLevel > duckEnvelope_)
                duckEnvelope_ = inputLevel;  // instant attack (~1ms)
            else
                duckEnvelope_ = duckReleaseCoeff_ * duckEnvelope_;  // 200ms release

            const float duckGain = 1.0f - (duckAmount / 100.0f)
                                         * std::min(duckEnvelope_ / 0.5f, 1.0f);

            // ── 10. Wet signal with ducking ─────────────────────────────────
            const float wetL = delayedL * duckGain;
            const float wetR = delayedR * duckGain;

            // ── 11. Dry/wet mix ─────────────────────────────────────────────
            const float mixNorm = mixPct / 100.0f;
            buffer.setSample(0, s, inputL * (1.0f - mixNorm) + wetL * mixNorm);
            if (numCh > 1)
                buffer.setSample(1, s, inputR * (1.0f - mixNorm) + wetR * mixNorm);

            // Track peaks for metering
            peakL = std::max(peakL, std::abs(wetL));
            peakR = std::max(peakR, std::abs(wetR));
        }

#ifdef XLETH_DEBUG
        if (doLog)
            DBG("[Delay] L=" + juce::String(smoothTimeL_[1], 1) + "ms"
                + " R=" + juce::String(smoothTimeR_[1], 1) + "ms"
                + " fb=" + juce::String(getSmoothedValue("feedback"), 1) + "%"
                + " BPM=" + juce::String(getGlobalBPM(), 0));
#endif

        writeMeterValue(0, peakL);
        writeMeterValue(1, numCh > 1 ? peakR : peakL);
    }

private:
    // ── Parameter layout ────────────────────────────────────────────────────
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            std::make_unique<Apf>(Pid{"time_l",        1}, "Time L",
                Nar{1.0f,     5000.0f, 0.0f, 0.4f  }, 500.0f,   "ms"),
            std::make_unique<Apf>(Pid{"time_r",        1}, "Time R",
                Nar{1.0f,     5000.0f, 0.0f, 0.4f  }, 500.0f,   "ms"),
            std::make_unique<Apf>(Pid{"sync",          1}, "Sync",
                Nar{0.0f,     1.0f,    1.0f, 1.0f  }, 0.0f,     ""),
            std::make_unique<Apf>(Pid{"sync_div_l",    1}, "Sync Div L",
                Nar{0.0f,     11.0f,   1.0f, 1.0f  }, 3.0f,     ""),
            std::make_unique<Apf>(Pid{"sync_div_r",    1}, "Sync Div R",
                Nar{0.0f,     11.0f,   1.0f, 1.0f  }, 3.0f,     ""),
            std::make_unique<Apf>(Pid{"feedback",      1}, "Feedback",
                Nar{0.0f,     95.0f,   0.0f, 1.0f  }, 30.0f,    "%"),
            std::make_unique<Apf>(Pid{"filter_lo",     1}, "Filter Lo",
                Nar{20.0f,    2000.0f, 0.0f, 0.3f  }, 80.0f,    "Hz"),
            std::make_unique<Apf>(Pid{"filter_hi",     1}, "Filter Hi",
                Nar{1000.0f, 20000.0f, 0.0f, 0.23f }, 12000.0f, "Hz"),
            std::make_unique<Apf>(Pid{"mod_rate",      1}, "Mod Rate",
                Nar{0.01f,    5.0f,    0.0f, 0.5f  }, 0.3f,     "Hz"),
            std::make_unique<Apf>(Pid{"mod_depth",     1}, "Mod Depth",
                Nar{0.0f,     100.0f,  0.0f, 1.0f  }, 15.0f,    "%"),
            std::make_unique<Apf>(Pid{"stereo_width",  1}, "Stereo Width",
                Nar{0.0f,     100.0f,  0.0f, 1.0f  }, 50.0f,    "%"),
            std::make_unique<Apf>(Pid{"duck_amount",   1}, "Duck Amount",
                Nar{0.0f,     100.0f,  0.0f, 1.0f  }, 0.0f,     "%"),
            std::make_unique<Apf>(Pid{"mix",           1}, "Mix",
                Nar{0.0f,     100.0f,  0.0f, 1.0f  }, 30.0f,    "%"),
        };
    }

    // ── Sync division fractions (beat multiples) ────────────────────────────
    // 0=1/1, 1=1/2, 2=1/2D, 3=1/4, 4=1/4D, 5=1/4T,
    // 6=1/8, 7=1/8D, 8=1/8T, 9=1/16, 10=1/16D, 11=1/16T
    static constexpr float kDivFractions[12] = {
        4.0f,            // 0: 1/1   (whole note = 4 beats)
        2.0f,            // 1: 1/2   (half note)
        3.0f,            // 2: 1/2D  (dotted half = 1.5 × half = 3 beats)
        1.0f,            // 3: 1/4   (quarter note)
        1.5f,            // 4: 1/4D  (dotted quarter)
        2.0f / 3.0f,     // 5: 1/4T  (quarter triplet)
        0.5f,            // 6: 1/8   (eighth note)
        0.75f,           // 7: 1/8D  (dotted eighth)
        1.0f / 3.0f,     // 8: 1/8T  (eighth triplet)
        0.25f,           // 9: 1/16  (sixteenth note)
        0.375f,          // 10: 1/16D (dotted sixteenth)
        1.0f / 6.0f,     // 11: 1/16T (sixteenth triplet)
    };

    // ── Raw APVTS pointers (discrete + custom-smoothed params) ──────────────
    std::atomic<float>* timeLPtr_    = nullptr;
    std::atomic<float>* timeRPtr_    = nullptr;
    std::atomic<float>* syncPtr_     = nullptr;
    std::atomic<float>* syncDivLPtr_ = nullptr;
    std::atomic<float>* syncDivRPtr_ = nullptr;

    // ── Delay lines (Lagrange3rd for fractional-sample modulation) ──────────
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Lagrange3rd> delayLineL_;
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Lagrange3rd> delayLineR_;
    int maxDelaySamples_ = 0;

    // ── Cascaded one-pole delay time smoothing (2 stages each) ──────────────
    float smoothTimeL_[2] = {0.0f, 0.0f};
    float smoothTimeR_[2] = {0.0f, 0.0f};
    float smoothCoeff_    = 0.0f;

    // ── Feedback filter state (one-pole LP then HP, per channel) ────────────
    float lpStateL_ = 0.0f, lpStateR_ = 0.0f;
    float hpStateL_ = 0.0f, hpStateR_ = 0.0f;

    // ── LFO ─────────────────────────────────────────────────────────────────
    float lfoPhase_ = 0.0f;

    // ── Ducking envelope ────────────────────────────────────────────────────
    float duckEnvelope_      = 0.0f;
    float duckAttackCoeff_   = 0.0f;
    float duckReleaseCoeff_  = 0.0f;

    // ── State ───────────────────────────────────────────────────────────────
    double sampleRate_ = 44100.0;
};
