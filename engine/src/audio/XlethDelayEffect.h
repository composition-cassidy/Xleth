#pragma once

#include "audio/XlethEffectBase.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>

// ─── XlethDelayEffect ────────────────────────────────────────────────────────
// Stereo delay with tempo sync, three stereo modes, feedback filtering,
// LFO modulation, ping-pong cross-feed, and input-driven ducking.
//
// Parameters (APVTS-backed):
//   time_l        1–5000 ms       (cascaded one-pole 80ms, NOT SmoothedValue)
//   time_r        1–5000 ms       (cascaded one-pole 80ms, NOT SmoothedValue)
//   sync          0/1             (discrete: 0=Free, 1=Sync)
//   sync_div_l    0–11            (discrete: index into beat fractions)
//   sync_div_r    0–11            (discrete: index into beat fractions)
//   stereo_mode   0–2             (discrete: 0=Single, 1=Dual, 2=PingPong)
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
// ── Stereo modes ────────────────────────────────────────────────────────────
// stereo_mode selects how the two delay lines relate. It defaults to Dual,
// which is bit-identical to the pre-stereo_mode behaviour, so existing projects
// (whose saved APVTS state has no stereo_mode node and therefore falls back to
// the parameter default) are unaffected.
//
// stereo_width is re-interpreted per mode — one control, three jobs:
//
//   0 Single    One time value (time_l / sync_div_l) drives BOTH lines, offset
//               symmetrically by a spread of up to ±100 ms:
//                   L = t − spread/2, R = t + spread/2
//               spread = (stereo_width / 100) × 200 ms.
//               Cross-feed is forced to 0 — the two taps are one delay heard
//               slightly wide, not a feedback network.
//
//   1 Dual      Legacy behaviour. time_l / time_r (or sync_div_l / sync_div_r)
//               are independent; cross-feed = stereo_width / 100.
//
//   2 PingPong  One time value drives both lines, cross-feed is forced to 1.0,
//               and the input is summed to mono and injected into the L line
//               ONLY. Each repeat therefore hands its energy to the opposite
//               line — genuine call-and-answer alternation. stereo_width then
//               steers the wet mid/side balance (0 = mono wet, 50 = unaltered,
//               100 = side ×2).
//
// Mode switching is crossfaded, not stepped: wSingle_/wPingPong_ are one-pole
// weights (same 80 ms coefficient as the delay-time smoother) that the audio
// loop blends with. They snap exactly to 0.0f/1.0f once within kWeightSnap, so
// steady-state Dual computes the identical expression the old code did — no
// residual blend error on the legacy path.
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
        stereoModePtr_  = apvts_.getRawParameterValue("stereo_mode");
        stereoWidthPtr_ = apvts_.getRawParameterValue("stereo_width");

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

        // Snap the mode weights to the restored mode so the first block after
        // prepare/load plays the saved mode outright instead of gliding in
        // from Dual.
        const int mode = readStereoMode();
        wSingle_   = (mode == kModeSingle)   ? 1.0f : 0.0f;
        wPingPong_ = (mode == kModePingPong) ? 1.0f : 0.0f;

        // Ducking envelope coefficients
        duckAttackCoeff_  = std::exp(-1.0f / (0.001f * static_cast<float>(sampleRate)));
        duckReleaseCoeff_ = std::exp(-1.0f / (0.200f * static_cast<float>(sampleRate)));
        duckEnvelope_ = 0.0f;

        // Handle-based smoother access (Phase 4 CPU pass): resolved once
        // here instead of hashing a std::string per sample per param.
        hFeedback_    = resolveSmoothed("feedback");
        hFilterLo_    = resolveSmoothed("filter_lo");
        hFilterHi_    = resolveSmoothed("filter_hi");
        hModRate_     = resolveSmoothed("mod_rate");
        hModDepth_    = resolveSmoothed("mod_depth");
        hStereoWidth_ = resolveSmoothed("stereo_width");
        hDuckAmount_  = resolveSmoothed("duck_amount");
        hMix_         = resolveSmoothed("mix");

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

        const int mode = readStereoMode();
        wSingle_   = (mode == kModeSingle)   ? 1.0f : 0.0f;
        wPingPong_ = (mode == kModePingPong) ? 1.0f : 0.0f;
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

        // Single and PingPong collapse to the L time; Single then widens it by
        // half the spread. Mirrors the target-time maths in processEffect so
        // the reported tail matches what is actually being rendered.
        const int mode = readStereoMode();
        if (mode != kModeDual)
        {
            float base;
            if (syncPtr_ && syncPtr_->load(std::memory_order_relaxed) >= 0.5f)
            {
                double bpm = getGlobalBPM();
                if (bpm <= 0.0) bpm = 140.0;
                const int divL = syncDivLPtr_
                    ? std::clamp(static_cast<int>(syncDivLPtr_->load(std::memory_order_relaxed)), 0, 11)
                    : 3;
                base = (60000.0f / static_cast<float>(bpm)) * kDivFractions[divL];
            }
            else
            {
                base = timeLPtr_ ? timeLPtr_->load(std::memory_order_relaxed) : 500.0f;
            }

            if (mode == kModeSingle)
            {
                const float widthPct = stereoWidthPtr_
                                     ? stereoWidthPtr_->load(std::memory_order_relaxed)
                                     : 50.0f;
                base += std::clamp(widthPct, 0.0f, 100.0f) * 0.01f
                      * kSingleSpreadRangeMs * 0.5f;
            }
            maxTimeMs = std::clamp(base, 1.0f, 5000.0f);
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
        const int   mode     = readStereoMode();

        // Mode weight targets — smoothed per sample below so a mode switch
        // crossfades rather than steps.
        const float wSingleTarget   = (mode == kModeSingle)   ? 1.0f : 0.0f;
        const float wPingPongTarget = (mode == kModePingPong) ? 1.0f : 0.0f;

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

        // Modes that collapse to a single time do so here, at block rate. The
        // cascaded one-pole below then glides between the old and new targets,
        // so a mode switch never jumps the delay time.
        if (mode == kModeSingle)
        {
            // stereo_width re-purposed as the L/R spread (±100 ms at 100 %).
            const float widthPct = stereoWidthPtr_
                                 ? stereoWidthPtr_->load(std::memory_order_relaxed)
                                 : 50.0f;
            const float halfSpread = std::clamp(widthPct, 0.0f, 100.0f) * 0.01f
                                   * kSingleSpreadRangeMs * 0.5f;
            const float base = targetTimeL;
            targetTimeL = std::clamp(base - halfSpread, 1.0f, 5000.0f);
            targetTimeR = std::clamp(base + halfSpread, 1.0f, 5000.0f);
        }
        else if (mode == kModePingPong)
        {
            // Both lines share one time so the alternation stays even.
            targetTimeR = targetTimeL;
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
            const float feedbackPct  = hFeedback_.next();
            const float filterLo     = hFilterLo_.next();
            const float filterHi     = hFilterHi_.next();
            const float modRate      = hModRate_.next();
            const float modDepth     = hModDepth_.next();
            const float stereoWidth  = hStereoWidth_.next();
            const float duckAmount   = hDuckAmount_.next();
            const float mixPct       = hMix_.next();

            // ── 0. Mode crossfade weights ───────────────────────────────────
            // Same 80 ms coefficient as the delay-time smoother. The snap keeps
            // steady-state Dual at exactly wSingle_ = wPingPong_ = 0.0f, so the
            // expressions below reduce to the pre-stereo_mode arithmetic.
            wSingle_   += smoothCoeff_ * (wSingleTarget   - wSingle_);
            wPingPong_ += smoothCoeff_ * (wPingPongTarget - wPingPong_);
            if (std::abs(wSingleTarget   - wSingle_)   < kWeightSnap) wSingle_   = wSingleTarget;
            if (std::abs(wPingPongTarget - wPingPong_) < kWeightSnap) wPingPong_ = wPingPongTarget;

            // Dual is the implicit remainder. Clamped because a direct
            // Single → PingPong switch briefly has both weights in flight.
            const float wDual = std::max(0.0f, 1.0f - wSingle_ - wPingPong_);

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
            // Dual  → stereo_width drives the cross amount (legacy).
            // Single→ 0: the two taps are one delay, not a feedback network.
            // PingPong → 1: every repeat hands its energy to the opposite line.
            // At steady-state Dual this is 1.0f * (stereo_width/100.0f) + 0.0f,
            // i.e. bit-identical to the expression this replaced.
            const float crossAmt = wDual * (stereoWidth / 100.0f) + wPingPong_;
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
            // PingPong injects the summed input into the L line only; the R
            // line is fed purely by cross-feed, which is what makes the repeats
            // alternate ears instead of running two parallel delays.
            // At wPingPong_ = 0 these reduce to inputL / inputR exactly.
            const float monoIn = 0.5f * (inputL + inputR);
            const float pushL  = inputL + wPingPong_ * (monoIn - inputL);
            const float pushR  = inputR - wPingPong_ * inputR;

            delayLineL_.pushSample(0, pushL + fbL);
            delayLineR_.pushSample(0, pushR + fbR);

            // ── 9. Ducking envelope ─────────────────────────────────────────
            const float inputLevel = std::max(std::abs(inputL), std::abs(inputR));
            if (inputLevel > duckEnvelope_)
                duckEnvelope_ = inputLevel;  // instant attack (~1ms)
            else
                duckEnvelope_ = duckReleaseCoeff_ * duckEnvelope_;  // 200ms release

            const float duckGain = 1.0f - (duckAmount / 100.0f)
                                         * std::min(duckEnvelope_ / 0.5f, 1.0f);

            // ── 10. Wet signal with ducking ─────────────────────────────────
            float wetL = delayedL * duckGain;
            float wetR = delayedR * duckGain;

            // PingPong has no cross-feed job left for stereo_width, so it
            // steers the wet mid/side balance instead: 0 = mono wet,
            // 50 = unaltered, 100 = side x2. Branch-guarded so Single and Dual
            // pass wetL / wetR through untouched — a mid/side round-trip is not
            // bit-exact in float, and Dual must stay identical.
            if (wPingPong_ > 0.0f)
            {
                const float mid      = 0.5f * (wetL + wetR);
                const float side     = 0.5f * (wetL - wetR);
                const float sideGain = 1.0f + wPingPong_ * ((stereoWidth / 50.0f) - 1.0f);
                wetL = mid + side * sideGain;
                wetR = mid - side * sideGain;
            }

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
            // Default 1 = Dual = the behaviour that shipped before this param
            // existed. Legacy projects restore no stereo_mode node and land here.
            std::make_unique<Apf>(Pid{"stereo_mode",   1}, "Stereo Mode",
                Nar{0.0f,     2.0f,    1.0f, 1.0f  }, 1.0f,     ""),
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

    // ── Stereo mode ─────────────────────────────────────────────────────────
    enum StereoMode { kModeSingle = 0, kModeDual = 1, kModePingPong = 2 };

    // Maximum L/R time offset in Single mode: stereo_width 100 % → ±100 ms.
    static constexpr float kSingleSpreadRangeMs = 200.0f;

    // Mode weights snap to their target once this close, so steady-state Dual
    // evaluates the pre-stereo_mode expressions exactly (× 1.0f, + 0.0f).
    static constexpr float kWeightSnap = 1.0e-6f;

    // Reads stereo_mode as a clamped enum. Defaults to Dual when unresolved.
    inline int readStereoMode() const noexcept
    {
        if (!stereoModePtr_) return kModeDual;
        const int m = static_cast<int>(stereoModePtr_->load(std::memory_order_relaxed) + 0.5f);
        return std::clamp(m, 0, 2);
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
    std::atomic<float>* stereoModePtr_  = nullptr;
    // Block-rate (unsmoothed) read of stereo_width, used only to derive the
    // Single-mode time spread. The smoothed handle still drives the audio-rate
    // cross-feed / width maths; the spread rides the delay-time smoother
    // instead, so reading the raw value here costs nothing and allocates nothing.
    std::atomic<float>* stereoWidthPtr_ = nullptr;

    // ── Mode crossfade weights ──────────────────────────────────────────────
    // Dual is the implicit base: wDual = 1 − wSingle_ − wPingPong_.
    float wSingle_   = 0.0f;
    float wPingPong_ = 0.0f;

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

    // ── Handle-based smoother access (Phase 4 CPU pass) ──────────────────────
    SmoothedHandle hFeedback_, hFilterLo_, hFilterHi_, hModRate_, hModDepth_,
                   hStereoWidth_, hDuckAmount_, hMix_;
};
