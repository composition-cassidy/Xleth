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

// Dual-mode transient shaper with envelope detection or MIDI-triggered attack
// shaping. Public identity and APVTS parameter surface stay stable:
//   attack       -100..100 %   transient boost/cut
//   sustain      -100..100 %   body/tail boost/cut (envelope mode only)
//   attack_speed 0.5..20 ms    detector timing / MIDI attack window
//   threshold    -60..0 dB     envelope gate threshold (envelope mode only)
//   mix          0..100 %      dry/wet
//   midi_detect  0 or 1        envelope mode / MIDI mode
//
// Meter slots:
//   0 - L output peak (absolute, max over block)
//   1 - R output peak
//   2 - dominant signed gain in dB (boost positive, cut negative)
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
    }

    void prepareEffect(double sampleRate, int /*maxBlockSize*/) override
    {
        sampleRate_ = sampleRate;
        midiDetectPtr_ = apvts_.getRawParameterValue("midi_detect");

        fastEnv_ = 0.0f;
        slowEnv_ = 0.0f;
        smoothedGainDb_ = 0.0f;

        samplesInAttackWindow_ = 0;
        currentVelocity_ = 0.0f;
        isActive_ = false;

        vizSampleClock_ = 0;
        vizAccum_.reset();

#ifdef XLETH_DEBUG
        const bool midiMode = midiDetectPtr_
            && midiDetectPtr_->load(std::memory_order_relaxed) > 0.5f;
        juce::ignoreUnused(midiMode);
        DBG("[TransientProc] prepareEffect sr=" + juce::String(sampleRate)
            + " mode=" + juce::String(midiMode ? "MIDI" : "Envelope"));
#endif
    }

    void resetEffect() override
    {
        fastEnv_ = 0.0f;
        slowEnv_ = 0.0f;
        smoothedGainDb_ = 0.0f;
        samplesInAttackWindow_ = 0;
        currentVelocity_ = 0.0f;
        isActive_ = false;

        vizSampleClock_ = 0;
        vizAccum_.reset();
    }

    void setVisualizationEnabled(bool enabled) override;
    std::uint32_t getVisualizationType() const override
    {
        return xleth::viz::kVizTypeTransient;
    }
    std::uint32_t getVisualizationSchemaVersion() const override
    {
        return xleth::viz::kDynamicsVizSchemaVersion;
    }
    std::size_t drainVizFrames(std::uint8_t* out, std::size_t maxBytes) override
    {
        if (!vizCollector_)
            return 0;
        return vizCollector_->drain(out, maxBytes);
    }

    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh = buffer.getNumChannels();
        const float sr = static_cast<float>(sampleRate_);
        const bool midiMode = midiDetectPtr_
            && midiDetectPtr_->load(std::memory_order_relaxed) > 0.5f;

        struct Onset
        {
            int sampleOffset = 0;
            float velocity = 0.0f;
        };

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
                    onsets[numOnsets].velocity = juce::jlimit(0.0f, 1.0f, msg.getFloatVelocity());
                    ++numOnsets;
                }
            }
        }
        int nextOnsetIdx = 0;

        float peakL = 0.0f;
        float peakR = 0.0f;
        float maxBoostDb = 0.0f;
        float maxCutDb = 0.0f;

        const float gainDbAttackCoeff = msToCoeff(0.25f, sr);
        const float gainDbReleaseCoeff = msToCoeff(4.0f, sr);

        auto* vizCol = vizActive_.load(std::memory_order_acquire);

#ifdef XLETH_DEBUG
        static int debugCounter = 0;
        const bool doLog = (++debugCounter >= 1000);
        if (doLog)
            debugCounter = 0;
#endif

        for (int s = 0; s < numSamples; ++s)
        {
            const float attackPct = getNextSmoothedValue("attack");
            const float sustainPct = getNextSmoothedValue("sustain");
            const float attackSpeedMs = getNextSmoothedValue("attack_speed");
            const float thresholdDb = getNextSmoothedValue("threshold");
            const float mixPct = getNextSmoothedValue("mix");

            const float dryL = buffer.getSample(0, s);
            const float dryR = numCh > 1 ? buffer.getSample(1, s) : dryL;
            const float absIn = std::max(std::abs(dryL),
                                         numCh > 1 ? std::abs(dryR) : std::abs(dryL));

            float vizFastEnvLin = std::numeric_limits<float>::quiet_NaN();
            float vizSlowEnvLin = std::numeric_limits<float>::quiet_NaN();
            float targetGainDb = 0.0f;

            if (midiMode)
            {
                while (nextOnsetIdx < numOnsets
                       && onsets[nextOnsetIdx].sampleOffset <= s)
                {
                    const float attackWindowSamples =
                        std::max(1.0f, attackSpeedMs * 0.001f * sr);
                    samplesInAttackWindow_ = static_cast<int>(std::ceil(attackWindowSamples));
                    currentVelocity_ = onsets[nextOnsetIdx].velocity;
                    ++nextOnsetIdx;
                }

                if (samplesInAttackWindow_ > 0)
                {
                    const float attackDb = amountToSignedDb(attackPct);
                    targetGainDb = juce::jlimit(-kMaxShapeGainDb, kMaxShapeGainDb,
                                                attackDb * currentVelocity_);
                    --samplesInAttackWindow_;
                }
            }
            else
            {
                const float fastAttackMs = std::max(0.125f, attackSpeedMs * 0.25f);
                const float fastReleaseMs = std::max(1.0f, attackSpeedMs * 1.5f);
                const float slowAttackMs = std::max(5.0f, attackSpeedMs * 3.0f);
                const float slowReleaseMs = std::max(40.0f, attackSpeedMs * 12.0f);

                const float fastAttCoeff = msToCoeff(fastAttackMs, sr);
                const float fastRelCoeff = msToCoeff(fastReleaseMs, sr);
                const float slowAttCoeff = msToCoeff(slowAttackMs, sr);
                const float slowRelCoeff = msToCoeff(slowReleaseMs, sr);

                updateEnvelope(absIn, fastEnv_, fastAttCoeff, fastRelCoeff);
                updateEnvelope(absIn, slowEnv_, slowAttCoeff, slowRelCoeff);

                vizFastEnvLin = fastEnv_;
                vizSlowEnvLin = slowEnv_;

                const float threshLin = std::pow(10.0f, thresholdDb / 20.0f);
                if (!isActive_ && absIn > threshLin)
                    isActive_ = true;
                if (isActive_ && absIn < threshLin * 0.7f)
                    isActive_ = false;

                if (isActive_)
                {
                    const float attackDb = amountToSignedDb(attackPct);
                    const float sustainDb = amountToSignedDb(sustainPct);
                    const float safeFastEnv = std::max(fastEnv_, 1.0e-5f);
                    const float transientMask = juce::jlimit(0.0f, 1.0f,
                        (fastEnv_ - slowEnv_) / safeFastEnv);
                    const float bodyMask = 1.0f - transientMask;

                    targetGainDb = juce::jlimit(-kMaxShapeGainDb, kMaxShapeGainDb,
                        attackDb * transientMask + sustainDb * bodyMask);

#ifdef XLETH_DEBUG
                    if (doLog)
                    {
                        DBG("[TransientProc] env fast=" + juce::String(fastEnv_, 4)
                            + " slow=" + juce::String(slowEnv_, 4)
                            + " tMask=" + juce::String(transientMask, 3)
                            + " targetDb=" + juce::String(targetGainDb, 3));
                    }
#endif
                }
            }

            if (!std::isfinite(targetGainDb))
                targetGainDb = 0.0f;

            const bool engagingMore =
                std::abs(targetGainDb) > std::abs(smoothedGainDb_) + 1.0e-6f;
            const float gainCoeff = engagingMore ? gainDbAttackCoeff : gainDbReleaseCoeff;

            smoothedGainDb_ = gainCoeff * smoothedGainDb_
                            + (1.0f - gainCoeff) * targetGainDb;
            if (!std::isfinite(smoothedGainDb_))
                smoothedGainDb_ = 0.0f;

            smoothedGainDb_ = juce::jlimit(-kMaxShapeGainDb, kMaxShapeGainDb, smoothedGainDb_);
            const float gainLin = dbToLinearGain(smoothedGainDb_);
            const float mixN = juce::jlimit(0.0f, 1.0f, mixPct * 0.01f);

            const float wetL = dryL * gainLin;
            const float wetR = dryR * gainLin;
            const float outL = dryL * (1.0f - mixN) + wetL * mixN;
            const float outR = dryR * (1.0f - mixN) + wetR * mixN;

            buffer.setSample(0, s, outL);
            if (numCh > 1)
                buffer.setSample(1, s, outR);

            peakL = std::max(peakL, std::abs(outL));
            peakR = std::max(peakR, std::abs(outR));

            if (smoothedGainDb_ > maxBoostDb)
                maxBoostDb = smoothedGainDb_;
            if (smoothedGainDb_ < maxCutDb)
                maxCutDb = smoothedGainDb_;

            if (vizCol)
            {
                const float vizAbsOut = std::max(std::abs(outL),
                                                 numCh > 1 ? std::abs(outR) : std::abs(outL));
                const float attackUnit = juce::jlimit(-1.0f, 1.0f, attackPct * 0.01f);
                const float sustainUnit = juce::jlimit(-1.0f, 1.0f, sustainPct * 0.01f);

                vizAccum_.observe(absIn, vizAbsOut,
                                  vizFastEnvLin, vizSlowEnvLin,
                                  smoothedGainDb_,
                                  attackUnit, sustainUnit,
                                  attackSpeedMs, thresholdDb, mixN);
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
        {
            DBG("[TransientProc] MIDI onsets=" + juce::String(numOnsets)
                + " vel=" + juce::String(currentVelocity_, 2));
        }
#endif

        writeMeterValue(0, peakL);
        writeMeterValue(1, numCh > 1 ? peakR : peakL);
        writeMeterValue(2, dominantSignedGain(maxBoostDb, maxCutDb));
    }

private:
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

    static float msToCoeff(float ms, float sr)
    {
        return std::exp(-1.0f / (ms * 0.001f * sr + 1.0e-6f));
    }

    static float amountToSignedDb(float percent)
    {
        const float unit = juce::jlimit(-1.0f, 1.0f, percent * 0.01f);
        if (!std::isfinite(unit))
            return 0.0f;
        return std::copysign(unit * unit * kMaxShapeGainDb, unit);
    }

    static float dbToLinearGain(float gainDb)
    {
        if (!std::isfinite(gainDb))
            return 1.0f;

        const float clampedDb = juce::jlimit(-kMaxShapeGainDb, kMaxShapeGainDb, gainDb);
        return juce::jlimit(kMinShapeGainLin, kMaxShapeGainLin,
                            std::pow(10.0f, clampedDb / 20.0f));
    }

    static float dominantSignedGain(float maxBoostDb, float maxCutDb)
    {
        return std::abs(maxBoostDb) >= std::abs(maxCutDb) ? maxBoostDb : maxCutDb;
    }

    static void updateEnvelope(float input, float& state,
                               float attackCoeff, float releaseCoeff)
    {
        const float level = std::abs(input);
        const float coeff = level > state ? attackCoeff : releaseCoeff;
        state = coeff * state + (1.0f - coeff) * level;
    }

    std::atomic<float>* midiDetectPtr_ = nullptr;

    static constexpr float kMaxShapeGainDb = 12.0f;
    static constexpr float kMinShapeGainLin = 0.25118864f;
    static constexpr float kMaxShapeGainLin = 3.98107171f;

    float fastEnv_ = 0.0f;
    float slowEnv_ = 0.0f;
    float smoothedGainDb_ = 0.0f;

    int samplesInAttackWindow_ = 0;
    float currentVelocity_ = 0.0f;

    bool isActive_ = false;
    double sampleRate_ = 44100.0;

    std::unique_ptr<xleth::viz::DynamicsVizCollector<xleth::viz::TransientBucket>>
        vizCollector_;
    std::atomic<xleth::viz::DynamicsVizCollector<xleth::viz::TransientBucket>*>
        vizActive_{nullptr};
    xleth::viz::TransientBucketAccumulator vizAccum_;
    std::uint64_t vizSampleClock_ = 0;
};

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
