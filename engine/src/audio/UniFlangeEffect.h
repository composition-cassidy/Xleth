#pragma once

#include "audio/XlethEffectBase.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <cmath>

// ─── UniFlangeEffect ──────────────────────────────────────────────────────────
// Fruity-Flangus-style unison/ensemble generator. NOT a flanger: no feedback
// path anywhere. N parallel modulated-delay taps read from ONE shared mono
// delay line, each panned into the stereo field, summed, passed through a
// plain unnormalised 2x2 stereo cross-mix, then blended with dry.
//
// This topology (and the constants marked [CONFIRMED] below) come from
// black-box measurement of Fruity Flangus renders — see
// uniflange/UNIFLANGE_HANDOFF.md sections 1 and 4. The scalar parameter
// curves marked [UNKNOWN]/GUESS in that document are placeholders with
// correct units and wrong values, pending the round-3 renders in section 8.
//
// Parameters (APVTS-backed):
//   order   1-8     (discrete step 1) -- n_voices = 2 * order [INFERRED, §4.6]
//   depth   0-100 % (Linear 20ms smoothing) -- LFO excursion
//   speed   0-100 % (NOT smoothed -- read block-rate; feeds the LFO rate directly)
//   delay   0-100 % (Linear 20ms smoothing) -- inter-voice SPACING, not a base offset
//   spread  0-100 % (Linear 20ms smoothing) -- fans voice rate/depth/phase/pan
//   cross   -100..100 % (Linear 20ms smoothing) -- unnormalised stereo cross, c = cross/100
//   dry     -100..100 % (Linear 20ms smoothing) -- negative inverts
//   wet     -100..100 % (Linear 20ms smoothing) -- negative inverts
//   mode    discrete {0=LEGACY, 1=HQ}, default LEGACY -- delay-tap interpolation
//
// DSP shape (spec §1):
//   mono in -> ONE shared delay line (no feedback) -> 2*order taps, each with
//   its own LFO (shared rate, per-voice depth/phase from SPREAD) -> pan each
//   tap -> sum to wet_L/wet_R -> out_L = wet_L + c*wet_R, out_R = wet_R + c*wet_L
//   (c = CROSS/100 exactly, UNNORMALISED -- +6dB at CROSS=+-100 is correct
//   behaviour, spec §4.2/§9.3) -> dry*DRY/100 + out*WET/100.
//
// ORDER changes voice count. All 16 voice slots (max order 8) are
// pre-allocated in prepareEffect; a slot's PRESENCE is ramped in/out over
// ~20ms via a one-pole envelope so adding/removing voices never clicks
// (spec §7). Slot POSITION (delay/pan) is recomputed immediately when the
// active voice count changes -- ORDER is a discrete, infrequently-automated
// control (like Chorus's "voices" param elsewhere in this codebase) and the
// per-voice layout formula is itself a function of the active voice count,
// so repositioning on an order change is inherent and accepted.
//
// LEGACY mode uses juce::dsp::DelayLine<float, Linear> (2-point linear
// interpolation) -- this is the measured Flangus behaviour and is required
// for future null-testing (spec §4.4/§9.6, do not substitute Lagrange here).
// HQ mode uses Lagrange3rd. Both delay lines are fed identically every
// sample (mono write, and BOTH lines are popped every sample to keep their
// internal read cursors tracking their write cursor -- see
// juce::dsp::DelayLine::popSample/pushSample, which maintain independent
// readPos/writePos counters) so MODE can switch instantly with no reset.
//
// Metering slots:
//   0 -- L channel wet peak (post cross-mix, pre dry/wet blend)
//   1 -- R channel wet peak
//
// pluginId: "uniflange"

class UniFlangeEffect : public XlethEffectBase
{
public:
    static constexpr int kMaxOrder  = 8;
    static constexpr int kMaxVoices = 2 * kMaxOrder; // 16

    UniFlangeEffect() : XlethEffectBase("uniflange", createLayout())
    {
        // speed, order, mode are NOT registered here -- read block-rate raw
        // (spec §7: "Do NOT apply generic parameter smoothing on top of the
        // LFO output"; order/mode are discrete, ramped structurally instead).
        registerSmoothedParam("depth",  SmoothType::Linear, 20.0f);
        registerSmoothedParam("delay",  SmoothType::Linear, 20.0f);
        registerSmoothedParam("spread", SmoothType::Linear, 20.0f);
        registerSmoothedParam("cross",  SmoothType::Linear, 20.0f);
        registerSmoothedParam("dry",    SmoothType::Linear, 20.0f);
        registerSmoothedParam("wet",    SmoothType::Linear, 20.0f);
    }

    // ==== [UNVERIFIED MAPS — pending round-3 renders, spec §5/§8] ==========
    // Ported from uniflange/uniflange_ref.py. Units and shape are the
    // documented findings; the numeric constants are GUESSes pending the
    // round-3 renders described in spec §8. Every use site in this class
    // goes through these functions — never inline these constants elsewhere.

    // Baseline delay of the first voice slot (frac = 0), ms. Anchors the
    // order-1 measurement (§4.6: 0.1855 ms / 12.11 ms for the two taps).
    static constexpr float kVoiceBaseDelayMs = 0.65f;

    // Per-voice gain at order 1, flat 523 Hz .. 19.4 kHz [CONFIRMED §4.3].
    static constexpr float kWetGainOrder1 = 0.9373f;

    // DEPTH% -> peak LFO excursion, ms. [UNKNOWN]
    // Anchor: DEPTH 50 / SPREAD 100 / order 1 gave 1.749 ms and 2.332 ms
    // peak-to-peak for the two voices (ratio 4/3), so depth is per-voice
    // and scaled by the spread ladder below.
    static float mapDepthMs(float depthPct) noexcept
    {
        return 0.035f * depthPct; // GUESS, linear
    }

    // SPEED% -> LFO rate, Hz. [UNKNOWN]
    // Hard constraints (spec §4.7): SPEED 75 -> period > 1.7s;
    // SPEED 0 -> ~0.03 Hz, NOT zero. Floor is non-negotiable.
    static float mapSpeedHz(float speedPct) noexcept
    {
        return 0.03f + 0.05f * std::pow(200.0f, speedPct / 100.0f); // GUESS
    }

    // DELAY% -> inter-voice delay SPACING, ms (NOT a common base offset --
    // spec §4.8/§9.4). Voice 1 sits at 0.596ms (DEL 0) vs 0.672ms (DEL 100),
    // essentially unmoved, while voice 2 moves from ~1.3ms to 26.77ms.
    static float mapDelaySpacingMs(float delayPct) noexcept
    {
        return 0.7f + 0.26f * delayPct; // ~0.7 -> ~26.8 ms
    }

    // Per-voice (delayCentreMs, depthMs, lfoPhaseTurns, pan) for nVoices
    // active slots. [UNKNOWN] Anchors: order 1 -> two taps at 12.1100 and
    // 0.1855 ms (DEL 0, SPREAD 100); order 4 DEL 100 SPREAD 100 -> voice 1
    // pan (0.5531, 0.1053), voice 2 the mirror. Pan is independent of DEPTH
    // and SPEED (spec §4.5) -- note this function does not take a speed
    // argument, so that invariant holds structurally, not by convention.
    // pan is in [-1, +1].
    static void voiceLayout(int nVoices, float spreadPct, float delayPct, float depthPct,
                            float* centresMs, float* depthsMs,
                            float* phasesTurns, float* pans) noexcept
    {
        const int n = std::max(nVoices, 1);
        const float spacing   = mapDelaySpacingMs(delayPct);
        const float baseDepth = mapDepthMs(depthPct);
        const float spreadFr  = spreadPct / 100.0f;

        for (int i = 0; i < n; ++i)
        {
            const float frac = (n > 1) ? (static_cast<float>(i) / static_cast<float>(n - 1))
                                        : 0.5f;
            centresMs[i]   = kVoiceBaseDelayMs + spacing * frac;               // GUESS
            depthsMs[i]    = baseDepth * (1.0f + 0.33f * (frac - 0.5f));       // GUESS (4/3 ratio)
            phasesTurns[i] = frac * spreadFr * 0.5f;                          // GUESS
            pans[i]        = (2.0f * frac - 1.0f) * spreadFr;                 // GUESS
        }
    }

    // pan in [-1,+1] -> (gL, gR). [UNKNOWN law, one data point]
    // The single measured voice gave (0.5531, 0.1053): sum 0.6584, quadratic
    // norm 0.5630. Neither matches a textbook constant-power or
    // constant-gain law against the order-1 figure of 0.9373, so pan law and
    // per-voice normalisation are still entangled.
    static void panGains(float pan, float& gL, float& gR) noexcept
    {
        const float a = (1.0f - pan) * 0.5f;
        gL = a;
        gR = 1.0f - a;
    }

    // Overall per-voice gain before panning. [UNKNOWN]
    // order 1 -> 0.9373 (confirmed). Output RMS grows 1.126x (order 2) /
    // 1.192x (order 4) against the sqrt(N) an unnormalised sum would give.
    static float voiceGain(int nVoices) noexcept
    {
        const float n = static_cast<float>(std::max(nVoices, 1));
        return kWetGainOrder1 / std::pow(n, 0.33f); // GUESS
    }
    // ==== [END UNVERIFIED MAPS] =============================================

    // Max delay capacity: 40ms of range + a safety margin over the
    // placeholder depth map's max excursion (~4ms at DEPTH 100) + 1 sample
    // of interpolation headroom, at whatever sample rate prepareEffect is
    // called with (spec §7).
    static constexpr float kMaxDelayMs         = 40.0f;
    static constexpr float kMaxLfoExcursionMs  = 10.0f;

    // ── prepareEffect ────────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;

        orderPtr_ = apvts_.getRawParameterValue("order");
        speedPtr_ = apvts_.getRawParameterValue("speed");
        modePtr_  = apvts_.getRawParameterValue("mode");

        const int maxDelaySamples = static_cast<int>(
            std::ceil((kMaxDelayMs + kMaxLfoExcursionMs) * 0.001 * sampleRate)) + 1;
        maxDelaySamples_ = maxDelaySamples;

        juce::dsp::ProcessSpec spec;
        spec.sampleRate       = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
        spec.numChannels      = 1; // ONE shared mono line -- spec §7

        delayLineLegacy_.setMaximumDelayInSamples(maxDelaySamples);
        delayLineHQ_.setMaximumDelayInSamples(maxDelaySamples);
        delayLineLegacy_.prepare(spec);
        delayLineHQ_.prepare(spec);
        delayLineLegacy_.reset();
        delayLineHQ_.reset();

        masterPhase_ = 0.0f;
        for (int v = 0; v < kMaxVoices; ++v)
        {
            voiceEnv_[v]     = 0.0f;
            voiceDelayMs_[v] = kVoiceBaseDelayMs;
            voiceGL_[v]      = 0.5f;
            voiceGR_[v]      = 0.5f;
        }

        // ~20ms one-pole for per-voice presence (order-change) ramping.
        envCoeff_ = 1.0f - std::exp(-1.0f / (0.02f * static_cast<float>(sampleRate)));

        hDepth_  = resolveSmoothed("depth");
        hDelay_  = resolveSmoothed("delay");
        hSpread_ = resolveSmoothed("spread");
        hCross_  = resolveSmoothed("cross");
        hDry_    = resolveSmoothed("dry");
        hWet_    = resolveSmoothed("wet");

#ifdef XLETH_DEBUG
        DBG("[UniFlange] prepareToPlay sr=" + juce::String(sampleRate)
            + " blockSize=" + juce::String(maxBlockSize)
            + " maxDelay=" + juce::String(maxDelaySamples) + " samples");
#endif
    }

    // ── resetEffect ──────────────────────────────────────────────────────────
    void resetEffect() override
    {
        delayLineLegacy_.reset();
        delayLineHQ_.reset();
        masterPhase_ = 0.0f;
        for (int v = 0; v < kMaxVoices; ++v)
            voiceEnv_[v] = 0.0f;
    }

    // ── getTailLengthSeconds ─────────────────────────────────────────────────
    // No feedback (spec §4.1) -- the tail is simply the longest tap delay
    // this effect can ever produce, i.e. its declared delay-line range.
    double getTailLengthSeconds() const override
    {
        return static_cast<double>(kMaxDelayMs) / 1000.0;
    }

    // ── processEffect ────────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int   numSamples = buffer.getNumSamples();
        const int   numCh      = buffer.getNumChannels();
        const float sr         = static_cast<float>(sampleRate_);
        const float maxDelayF  = static_cast<float>(maxDelaySamples_ - 2);

        // ── Discrete params: read once per block ────────────────────────────
        const int order = std::clamp(
            static_cast<int>(orderPtr_ ? orderPtr_->load(std::memory_order_relaxed) : 4.0f),
            1, kMaxOrder);
        const int nVoicesTarget = 2 * order;

        const float speedPct = speedPtr_ ? speedPtr_->load(std::memory_order_relaxed) : 50.0f;
        const float rateHz   = mapSpeedHz(speedPct);

        const bool hqMode = modePtr_ && modePtr_->load(std::memory_order_relaxed) >= 0.5f;

        const float gBase = voiceGain(nVoicesTarget);

        float centresMs[kMaxVoices];
        float depthsMs[kMaxVoices];
        float phasesTurns[kMaxVoices];
        float pans[kMaxVoices];

        float peakL = 0.0f, peakR = 0.0f;

#ifdef XLETH_DEBUG
        static int blockCount_ = 0;
        ++blockCount_;
        const bool doLog = (blockCount_ % 1000 == 0);
#endif

        // ── Per-sample loop ──────────────────────────────────────────────────
        for (int s = 0; s < numSamples; ++s)
        {
            const float depthPct  = hDepth_.next();
            const float delayPct  = hDelay_.next();
            const float spreadPct = hSpread_.next();
            const float crossPct  = hCross_.next();
            const float dryPct    = hDry_.next();
            const float wetPct    = hWet_.next();

            // Shared LFO phase (turns, 0..1) -- ALL voices share this rate;
            // only depth/phase-offset/pan differ per voice (ref model §6).
            masterPhase_ += rateHz / sr;
            if (masterPhase_ >= 1.0f) masterPhase_ -= 1.0f;

            voiceLayout(nVoicesTarget, spreadPct, delayPct, depthPct,
                        centresMs, depthsMs, phasesTurns, pans);

            // ── Mono sum (assumed, spec §5/§7 -- untested, all probes mono) ──
            const float inputL = buffer.getSample(0, s);
            const float inputR = numCh > 1 ? buffer.getSample(1, s) : inputL;
            const float monoIn = 0.5f * (inputL + inputR);

            float wetL = 0.0f, wetR = 0.0f;

            for (int v = 0; v < kMaxVoices; ++v)
            {
                const bool  active = v < nVoicesTarget;
                const float target = active ? 1.0f : 0.0f;
                voiceEnv_[v] += envCoeff_ * (target - voiceEnv_[v]);

                if (active)
                {
                    // Position recomputed live from the smoothed params.
                    const float lfo = std::sin(juce::MathConstants<float>::twoPi
                                                * (masterPhase_ + phasesTurns[v]));
                    voiceDelayMs_[v] = centresMs[v] + depthsMs[v] * lfo;
                    panGains(pans[v], voiceGL_[v], voiceGR_[v]);
                }
                // else: slot is fading out (order was just lowered) -- keep
                // its last known delay/pan frozen rather than reading an
                // out-of-range layout entry; its envelope is heading to 0.

                const float delaySamples = std::clamp(
                    voiceDelayMs_[v] * 0.001f * sr, 0.0f, maxDelayF);

                // Advance BOTH lines' internal read cursors every sample
                // (see class comment) so MODE can switch without a reset.
                const bool advance = (v == kMaxVoices - 1);
                const float tapLegacy = delayLineLegacy_.popSample(0, delaySamples, advance);
                const float tapHQ     = delayLineHQ_.popSample(0, delaySamples, advance);
                const float tap       = hqMode ? tapHQ : tapLegacy;

                const float voiceOut = tap * gBase * voiceEnv_[v];
                wetL += voiceOut * voiceGL_[v];
                wetR += voiceOut * voiceGR_[v];
            }

            // ── Stereo cross matrix: unnormalised, exact (§4.2/§9.3) ─────────
            // No 1/(1+|c|), no 1/sqrt(1+c^2). +6dB at CROSS=+-100 is correct.
            const float c    = crossPct * 0.01f;
            const float outL = wetL + c * wetR;
            const float outR = wetR + c * wetL;

            // ── Push AFTER reading (no feedback -- only raw input feeds
            //    the line, spec §4.1/§9.1) ─────────────────────────────────
            delayLineLegacy_.pushSample(0, monoIn);
            delayLineHQ_.pushSample(0, monoIn);

            // ── Dry/Wet: independent, signed -100..100 (negative inverts) ────
            const float dryGain = dryPct * 0.01f;
            const float wetGain = wetPct * 0.01f;

            buffer.setSample(0, s, inputL * dryGain + outL * wetGain);
            if (numCh > 1)
                buffer.setSample(1, s, inputR * dryGain + outR * wetGain);

            peakL = std::max(peakL, std::abs(outL));
            peakR = std::max(peakR, std::abs(outR));
        }

#ifdef XLETH_DEBUG
        if (doLog)
            DBG("[UniFlange] order=" + juce::String(order)
                + " voices=" + juce::String(nVoicesTarget)
                + " rate=" + juce::String(rateHz, 3) + "Hz"
                + " mode=" + juce::String(hqMode ? "HQ" : "Legacy"));
#endif

        writeMeterValue(0, peakL);
        writeMeterValue(1, numCh > 1 ? peakR : peakL);
    }

private:
    // ── Parameter layout ─────────────────────────────────────────────────────
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            std::make_unique<Apf>(Pid{"order",  1}, "Order",
                Nar{1.0f,    8.0f,   1.0f, 1.0f}, 4.0f,   ""),
            std::make_unique<Apf>(Pid{"depth",  1}, "Depth",
                Nar{0.0f,    100.0f, 0.0f, 1.0f}, 50.0f,  "%"),
            std::make_unique<Apf>(Pid{"speed",  1}, "Speed",
                Nar{0.0f,    100.0f, 0.0f, 1.0f}, 50.0f,  "%"),
            std::make_unique<Apf>(Pid{"delay",  1}, "Delay",
                Nar{0.0f,    100.0f, 0.0f, 1.0f}, 0.0f,   "%"),
            std::make_unique<Apf>(Pid{"spread", 1}, "Spread",
                Nar{0.0f,    100.0f, 0.0f, 1.0f}, 100.0f, "%"),
            std::make_unique<Apf>(Pid{"cross",  1}, "Cross",
                Nar{-100.0f, 100.0f, 0.0f, 1.0f}, 0.0f,   "%"),
            std::make_unique<Apf>(Pid{"dry",    1}, "Dry",
                Nar{-100.0f, 100.0f, 0.0f, 1.0f}, 0.0f,   "%"),
            std::make_unique<Apf>(Pid{"wet",    1}, "Wet",
                Nar{-100.0f, 100.0f, 0.0f, 1.0f}, 100.0f, "%"),
            // Default 0 = LEGACY -- required so the effect can be null-tested
            // against the Fruity Flangus reference (spec §4.4/§9.6).
            std::make_unique<Apf>(Pid{"mode",   1}, "Mode",
                Nar{0.0f,    1.0f,   1.0f, 1.0f}, 0.0f,   ""),
        };
    }

    // ── Raw APVTS pointers (discrete, unsmoothed params) ────────────────────
    std::atomic<float>* orderPtr_ = nullptr;
    std::atomic<float>* speedPtr_ = nullptr;
    std::atomic<float>* modePtr_  = nullptr;

    // ── Shared delay lines (ONE mono line, two interpolation qualities) ─────
    // Both are fed and read every sample so MODE can switch without a reset
    // -- see popSample/pushSample semantics in the class comment above.
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear>
        delayLineLegacy_;
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Lagrange3rd>
        delayLineHQ_;
    int maxDelaySamples_ = 0;

    // ── Shared LFO phase (turns, 0..1) ───────────────────────────────────────
    float masterPhase_ = 0.0f;

    // ── Per-voice-slot persistent state (kMaxVoices = 16, order 1-8) ────────
    // voiceEnv_ ramps a slot's presence in/out over ~20ms when ORDER changes
    // the active voice count, instead of hard-switching (spec §7). When a
    // slot is inactive, voiceDelayMs_/voiceGL_/voiceGR_ stay frozen at their
    // last active values rather than being recomputed from an out-of-range
    // layout entry.
    float voiceEnv_[kMaxVoices]     = {};
    float voiceDelayMs_[kMaxVoices] = {};
    float voiceGL_[kMaxVoices]      = {};
    float voiceGR_[kMaxVoices]      = {};
    float envCoeff_ = 0.0f;

    double sampleRate_ = 44100.0;

    // ── Handle-based smoother access (Phase 4 CPU pass) ──────────────────────
    SmoothedHandle hDepth_, hDelay_, hSpread_, hCross_, hDry_, hWet_;
};
