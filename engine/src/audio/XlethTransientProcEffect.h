#pragma once

#include "audio/XlethEffectBase.h"
#include "audio/viz/DynamicsVizCollector.h"
#include "audio/viz/DynamicsVizFrame.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>

// ─── XlethTransientProcEffect ────────────────────────────────────────────────
// Dual-mode transient shaper with traditional envelope detection AND a novel
// MIDI-aware mode that uses sample-accurate note/clip onset data from the
// engine's MidiBuffer (populated by MixEngine in TP-01).
//
// Parameters (APVTS-backed):
//   attack       -100–100 %    transient boost/cut
//   sustain      -100–100 %    sustain boost/cut (envelope mode only)
//   attack_speed 0.5–20 ms     fast-envelope attack time / MIDI attack window
//   threshold    -60–0 dB      envelope gate threshold (envelope mode only)
//   mix          0–100 %       dry/wet
//   midi_detect  0=Envelope, 1=MIDI mode (discrete, stepped)
//
// Metering slots:
//   0 — L output peak (absolute, max over block)
//   1 — R output peak
//   2 — Current gain (dB relative to unity, max over block)
//
// pluginId: "transientproc"

class XlethTransientProcEffect : public XlethEffectBase
{
public:
    XlethTransientProcEffect() : XlethEffectBase("transientproc", createLayout())
    {
        registerSmoothedParam("attack",       SmoothType::Linear, 20.0f);
        registerSmoothedParam("sustain",      SmoothType::Linear, 20.0f);
        registerSmoothedParam("attack_speed", SmoothType::Linear, 20.0f);
        registerSmoothedParam("threshold",    SmoothType::Linear, 20.0f);
        registerSmoothedParam("mix",          SmoothType::Linear, 20.0f);
        // midi_detect is discrete — no smoothing
    }

    // ── prepareEffect ───────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int /*maxBlockSize*/) override
    {
        sampleRate_ = sampleRate;

        midiDetectPtr_ = apvts_.getRawParameterValue("midi_detect");

        // Reset envelope state
        fastEnvL_ = 0.0f;
        fastEnvR_ = 0.0f;
        slowEnvL_ = 0.0f;
        slowEnvR_ = 0.0f;
        gainSmooth_ = 1.0f;

        // Reset MIDI state
        samplesInAttackWindow_ = 0;
        currentVelocity_ = 0.0f;

        // Threshold hysteresis
        isActive_ = false;

        // Visualization state
        vizSampleClock_ = 0;
        vizAccum_.reset();

#ifdef XLETH_DEBUG
        const bool midiMode = midiDetectPtr_
            && midiDetectPtr_->load(std::memory_order_relaxed) > 0.5f;
        DBG("[TransientProc] prepareEffect sr=" + juce::String(sampleRate)
            + " mode=" + juce::String(midiMode ? "MIDI" : "Envelope"));
#endif
    }

    // ── resetEffect ─────────────────────────────────────────────────────────
    void resetEffect() override
    {
        fastEnvL_ = 0.0f;
        fastEnvR_ = 0.0f;
        slowEnvL_ = 0.0f;
        slowEnvR_ = 0.0f;
        gainSmooth_ = 1.0f;
        samplesInAttackWindow_ = 0;
        currentVelocity_ = 0.0f;
        isActive_ = false;

        vizSampleClock_ = 0;
        vizAccum_.reset();
    }

    // ── Visualization (XlethEffectBase overrides) ───────────────────────────
    // Lifetime model mirrors XlethCompressorEffect / XlethLimiterEffect: the
    // collector is allocated lazily on first enable and retained until the
    // effect is destroyed; vizActive_ atomically publishes / unpublishes it
    // for the audio thread.
    void          setVisualizationEnabled(bool enabled) override;
    std::uint32_t getVisualizationType()          const override
        { return xleth::viz::kVizTypeTransient; }
    std::uint32_t getVisualizationSchemaVersion() const override
        { return xleth::viz::kDynamicsVizSchemaVersion; }
    std::size_t   drainVizFrames(std::uint8_t* out, std::size_t maxBytes) override
    {
        if (!vizCollector_) return 0;
        return vizCollector_->drain(out, maxBytes);
    }

    // ── processEffect ───────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh      = buffer.getNumChannels();
        const float sr       = static_cast<float>(sampleRate_);

        // Read discrete param
        const bool midiMode = midiDetectPtr_
            && midiDetectPtr_->load(std::memory_order_relaxed) > 0.5f;

        // ── MIDI mode: collect onsets from MidiBuffer ────────────────────────
        struct Onset { int sampleOffset; float velocity; };
        Onset onsets[64];
        int numOnsets = 0;

        if (midiMode)
        {
            for (const auto metadata : midi)
            {
                const auto msg = metadata.getMessage();
                if (msg.isNoteOn() && numOnsets < 64)
                {
                    onsets[numOnsets].sampleOffset = metadata.samplePosition;
                    onsets[numOnsets].velocity     = msg.getFloatVelocity();
                    ++numOnsets;
                }
            }
        }
        int nextOnsetIdx = 0;

        float peakL = 0.0f;
        float peakR = 0.0f;
        float maxGainDB = 0.0f;

        // Visualization is opt-in per instance; one acquire-load per block.
        // When disabled, the hot loop pays only a null-check.
        auto* vizCol = vizActive_.load(std::memory_order_acquire);

#ifdef XLETH_DEBUG
        static int debugCounter = 0;
        const bool doLog = (++debugCounter >= 1000);
        if (doLog) debugCounter = 0;
#endif

        for (int s = 0; s < numSamples; ++s)
        {
            // Advance smoothers every sample — MUST happen in both modes
            const float attackPct    = getNextSmoothedValue("attack");
            const float sustainPct   = getNextSmoothedValue("sustain");
            const float attackSpeedMs = getNextSmoothedValue("attack_speed");
            const float thresholdDB  = getNextSmoothedValue("threshold");
            const float mixPct       = getNextSmoothedValue("mix");

            const float dryL = buffer.getSample(0, s);
            const float dryR = numCh > 1 ? buffer.getSample(1, s) : dryL;

            // Captured for visualization: envelope follower outputs (linear).
            // Stay NaN in MIDI mode — the followers don't run there, so we
            // surface "not measured" rather than stale state.
            float vizFastEnvLin = std::numeric_limits<float>::quiet_NaN();
            float vizSlowEnvLin = std::numeric_limits<float>::quiet_NaN();

            float gain = 1.0f;

            if (midiMode)
            {
                // ── MIDI detect path ─────────────────────────────────────
                // Check if current sample hits an onset
                while (nextOnsetIdx < numOnsets
                       && onsets[nextOnsetIdx].sampleOffset <= s)
                {
                    samplesInAttackWindow_ = static_cast<int>(
                        attackSpeedMs * 0.001f * sr);
                    currentVelocity_ = onsets[nextOnsetIdx].velocity;
                    ++nextOnsetIdx;
                }

                if (samplesInAttackWindow_ > 0)
                {
                    // Inside attack window — apply attack shaping
                    // Scale by velocity: louder hits get more shaping
                    gain += (attackPct / 100.0f) * currentVelocity_;
                    --samplesInAttackWindow_;
                }
                // No sustain in MIDI mode — ADSR handles that
                // No threshold in MIDI mode — onsets are known
            }
            else
            {
                // ── Envelope detect path ─────────────────────────────────
                // Compute coefficients from attack_speed
                const float fastAttackMs  = attackSpeedMs;
                const float fastReleaseMs = 15.0f;
                const float slowAttackMs  = 30.0f;
                const float slowReleaseMs = std::max(attackSpeedMs * 20.0f, 150.0f);

                const float fastAttCoeff  = msToCoeff(fastAttackMs, sr);
                const float fastRelCoeff  = msToCoeff(fastReleaseMs, sr);
                const float slowAttCoeff  = msToCoeff(slowAttackMs, sr);
                const float slowRelCoeff  = msToCoeff(slowReleaseMs, sr);

                // Update envelopes per channel
                updateEnvelope(dryL, fastEnvL_, fastAttCoeff, fastRelCoeff);
                updateEnvelope(dryR, fastEnvR_, fastAttCoeff, fastRelCoeff);
                updateEnvelope(dryL, slowEnvL_, slowAttCoeff, slowRelCoeff);
                updateEnvelope(dryR, slowEnvR_, slowAttCoeff, slowRelCoeff);

                // Stereo-linked detection: use max of L/R
                const float fastEnv = std::max(fastEnvL_, fastEnvR_);
                const float slowEnv = std::max(slowEnvL_, slowEnvR_);
                vizFastEnvLin = fastEnv;
                vizSlowEnvLin = slowEnv;

                // Transient ratio
                const float ratio = fastEnv / (slowEnv + 1e-6f);

                // Gain computation
                const float transientAmount = attackPct / 100.0f;
                const float sustainAmount   = sustainPct / 100.0f;

                if (ratio > 1.0f)
                    gain += transientAmount * (ratio - 1.0f);
                else if (slowEnv > 1e-5f) // noise floor guard
                    gain += sustainAmount * (1.0f - ratio) * 0.5f;

                // Threshold gating with hysteresis
                const float level = std::max(std::abs(dryL),
                                             numCh > 1 ? std::abs(dryR) : 0.0f);
                const float threshLin = std::pow(10.0f, thresholdDB / 20.0f);

                if (!isActive_ && level > threshLin)
                    isActive_ = true;
                if (isActive_ && level < threshLin * 0.7f)
                    isActive_ = false;
                if (!isActive_)
                    gain = 1.0f;

#ifdef XLETH_DEBUG
                if (doLog)
                    DBG("[TransientProc] env fast=" + juce::String(fastEnv, 4)
                        + " slow=" + juce::String(slowEnv, 4)
                        + " ratio=" + juce::String(ratio, 2)
                        + " gain=" + juce::String(gain, 3));
#endif
            }

            gain = juce::jlimit(0.01f, 10.0f, gain);

            // Smooth gain — fast one-pole (~0.1ms)
            gainSmooth_ += 0.002f * (gain - gainSmooth_);

            // Apply gain with dry/wet mix
            const float mixN = mixPct / 100.0f;
            const float wetL = dryL * gainSmooth_;
            const float wetR = dryR * gainSmooth_;
            const float outL = dryL * (1.0f - mixN) + wetL * mixN;
            const float outR = dryR * (1.0f - mixN) + wetR * mixN;

            buffer.setSample(0, s, outL);
            if (numCh > 1)
                buffer.setSample(1, s, outR);

            peakL = std::max(peakL, std::abs(outL));
            peakR = std::max(peakR, std::abs(outR));

            // Signed gainDB — written as last-sample value so UI can distinguish
            // boosting (positive) from cutting (negative).
            const float gainDB = 20.0f * std::log10(std::max(gainSmooth_, 1e-6f));
            maxGainDB = gainDB;   // signed, updated every sample, last wins

            if (vizCol)
            {
                const float vizAbsIn  = std::max(std::abs(dryL),
                                                 numCh > 1 ? std::abs(dryR) : 0.0f);
                const float vizAbsOut = std::max(std::abs(outL),
                                                 numCh > 1 ? std::abs(outR) : 0.0f);
                // Param values normalised for the bucket: percent → unit
                // ([-1, 1] for bipolar, [0, 1] for mix). speedMs / thresholdDB
                // pass through unchanged.
                const float attackUnit  = attackPct  * 0.01f;
                const float sustainUnit = sustainPct * 0.01f;
                const float mixUnit     = mixPct     * 0.01f;

                vizAccum_.observe(vizAbsIn, vizAbsOut,
                                  vizFastEnvLin, vizSlowEnvLin,
                                  gainSmooth_,
                                  attackUnit, sustainUnit,
                                  attackSpeedMs, thresholdDB, mixUnit);
                ++vizSampleClock_;
                vizAccum_.advance(vizSampleClock_, *vizCol);
            }
            else
            {
                ++vizSampleClock_;
            }
        }

#ifdef XLETH_DEBUG
        if (midiMode && numOnsets > 0 && doLog)
            DBG("[TransientProc] MIDI onsets=" + juce::String(numOnsets)
                + " vel=" + juce::String(currentVelocity_, 2));
#endif

        writeMeterValue(0, peakL);
        writeMeterValue(1, numCh > 1 ? peakR : peakL);
        writeMeterValue(2, maxGainDB);
    }

private:
    // ── Parameter layout ────────────────────────────────────────────────────
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            std::make_unique<Apf>(Pid{"attack",       1}, "Attack",
                Nar{-100.0f, 100.0f, 0.0f, 1.0f}, 0.0f,  "%"),
            std::make_unique<Apf>(Pid{"sustain",      1}, "Sustain",
                Nar{-100.0f, 100.0f, 0.0f, 1.0f}, 0.0f,  "%"),
            std::make_unique<Apf>(Pid{"attack_speed", 1}, "Attack Speed",
                Nar{0.5f,    20.0f,  0.0f, 1.0f}, 5.0f,  "ms"),
            std::make_unique<Apf>(Pid{"threshold",    1}, "Threshold",
                Nar{-60.0f,  0.0f,   0.0f, 1.0f}, -60.0f, "dB"),
            std::make_unique<Apf>(Pid{"mix",          1}, "Mix",
                Nar{0.0f,    100.0f, 0.0f, 1.0f}, 100.0f, "%"),
            std::make_unique<Apf>(Pid{"midi_detect",  1}, "MIDI Detect",
                Nar{0.0f,    1.0f,   1.0f, 1.0f}, 0.0f,  ""),
        };
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    // Convert milliseconds to one-pole coefficient: exp(-1 / (ms * sr / 1000))
    static float msToCoeff(float ms, float sr)
    {
        return std::exp(-1.0f / (ms * 0.001f * sr + 1e-6f));
    }

    // Update a one-pole envelope follower in place.
    static void updateEnvelope(float input, float& state,
                               float attackCoeff, float releaseCoeff)
    {
        const float level = std::abs(input);
        const float coeff = (level > state) ? attackCoeff : releaseCoeff;
        state = coeff * state + (1.0f - coeff) * level;
    }

    // ── Raw APVTS pointer for discrete parameter ────────────────────────────
    std::atomic<float>* midiDetectPtr_ = nullptr;

    // ── Envelope follower state (per channel) ───────────────────────────────
    float fastEnvL_ = 0.0f;
    float fastEnvR_ = 0.0f;
    float slowEnvL_ = 0.0f;
    float slowEnvR_ = 0.0f;

    // ── Shared state ────────────────────────────────────────────────────────
    float gainSmooth_ = 1.0f;

    // ── MIDI mode state ─────────────────────────────────────────────────────
    int   samplesInAttackWindow_ = 0;
    float currentVelocity_       = 0.0f;

    // ── Threshold hysteresis (envelope mode) ────────────────────────────────
    bool isActive_ = false;

    double sampleRate_ = 44100.0;

    // ── Visualization ───────────────────────────────────────────────────────
    // Lazy collector: allocated on first setVisualizationEnabled(true), then
    // re-used on subsequent enables. vizActive_ is the atomic the audio thread
    // reads once per block — null when the editor is closed (zero overhead).
    std::unique_ptr<xleth::viz::DynamicsVizCollector<xleth::viz::TransientBucket>>
        vizCollector_;
    std::atomic<xleth::viz::DynamicsVizCollector<xleth::viz::TransientBucket>*>
        vizActive_{nullptr};
    xleth::viz::TransientBucketAccumulator vizAccum_;
    std::uint64_t vizSampleClock_ = 0;
};

// ── setVisualizationEnabled ─────────────────────────────────────────────────

inline void XlethTransientProcEffect::setVisualizationEnabled(bool enabled)
{
    if (enabled)
    {
        if (!vizCollector_)
        {
            vizCollector_ = std::make_unique<
                xleth::viz::DynamicsVizCollector<xleth::viz::TransientBucket>>(
                    xleth::viz::kDynamicsVizBucketSize,
                    xleth::viz::kDynamicsVizRingDepth,
                    xleth::viz::kVizTypeTransient);
        }
        vizActive_.store(vizCollector_.get(), std::memory_order_release);
    }
    else
    {
        vizActive_.store(nullptr, std::memory_order_release);
    }
}
