#pragma once

#include "audio/XlethEffectBase.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <atomic>
#include <cmath>

// ─── SmartBalanceEffect ─────────────────────────────────────────────────────
// 4-band multiband auto-leveler with dynamics restoration.
// Splits audio into 4 frequency bands via balanced binary-tree LR4 crossover,
// measures per-band RMS, pulls each band toward a target level, then
// optionally re-applies the original dynamic contour (transient punch).
//
// Parameters (APVTS-backed):
//   amount      0–100 %       master intensity  (Linear 20ms)
//   preserve    0–100 %       dynamics restore   (Linear 20ms)
//   response    10–500 ms     leveling speed     (Linear 20ms)
//   mix         0–100 %       dry/wet            (Linear 20ms)
//   mode        0/1           Relative/Absolute  (discrete)
//   target_*    -40–12 dB     per-band target    (×4, Linear 20ms)
//   bandamt_*   0–100 %       per-band amount    (×4, Linear 20ms)
//   floor_*     -96–-20 dB    per-band gate floor(×4, Linear 20ms)
//
// Metering slots:
//   0–3 — per-band RMS in dB (sub, lomid, upmid, air)
//   4–7 — per-band smoothed gain correction in dB
//
// pluginId: "smartbalance"

class SmartBalanceEffect : public XlethEffectBase
{
public:
    SmartBalanceEffect() : XlethEffectBase("smartbalance", createLayout())
    {
        // Global (mode is discrete — not smoothed)
        registerSmoothedParam("amount",   SmoothType::Linear, 20.0f);
        registerSmoothedParam("preserve", SmoothType::Linear, 20.0f);
        registerSmoothedParam("response", SmoothType::Linear, 20.0f);
        registerSmoothedParam("mix",      SmoothType::Linear, 20.0f);

        // Per-band targets
        registerSmoothedParam("target_sub",    SmoothType::Linear, 20.0f);
        registerSmoothedParam("target_lomid",  SmoothType::Linear, 20.0f);
        registerSmoothedParam("target_upmid",  SmoothType::Linear, 20.0f);
        registerSmoothedParam("target_air",    SmoothType::Linear, 20.0f);

        // Per-band amounts
        registerSmoothedParam("bandamt_sub",   SmoothType::Linear, 20.0f);
        registerSmoothedParam("bandamt_lomid", SmoothType::Linear, 20.0f);
        registerSmoothedParam("bandamt_upmid", SmoothType::Linear, 20.0f);
        registerSmoothedParam("bandamt_air",   SmoothType::Linear, 20.0f);

        // Per-band floors
        registerSmoothedParam("floor_sub",     SmoothType::Linear, 20.0f);
        registerSmoothedParam("floor_lomid",   SmoothType::Linear, 20.0f);
        registerSmoothedParam("floor_upmid",   SmoothType::Linear, 20.0f);
        registerSmoothedParam("floor_air",     SmoothType::Linear, 20.0f);

        modeParam_ = apvts_.getRawParameterValue("mode");
    }

    // ── prepareEffect ───────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;

        juce::dsp::ProcessSpec spec;
        spec.sampleRate       = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
        spec.numChannels      = 2;

        crossoverMid_.prepare(spec);
        crossoverLow_.prepare(spec);
        crossoverHigh_.prepare(spec);
        allpassLow_.prepare(spec);
        allpassHigh_.prepare(spec);

        allpassLow_.setType(juce::dsp::LinkwitzRileyFilterType::allpass);
        allpassHigh_.setType(juce::dsp::LinkwitzRileyFilterType::allpass);

        crossoverMid_.setCutoffFrequency(800.0f);
        crossoverLow_.setCutoffFrequency(150.0f);
        crossoverHigh_.setCutoffFrequency(4000.0f);
        allpassLow_.setCutoffFrequency(150.0f);
        allpassHigh_.setCutoffFrequency(4000.0f);

        // Fixed coefficients for dynamics restoration and gate release
        const float sr = static_cast<float>(sampleRate);
        dynAtkCoeff_      = std::exp(-1.0f / (2.0f    * 0.001f * sr));
        dynRelCoeff_      = std::exp(-1.0f / (80.0f   * 0.001f * sr));
        slowDynRelCoeff_  = std::exp(-1.0f / (200.0f  * 0.001f * sr));
        gateRelCoeff_     = std::exp(-1.0f / (2000.0f * 0.001f * sr));

        for (int b = 0; b < 4; ++b)
        {
            meanSq_[b]       = 0.0f;
            smoothedGain_[b] = 0.0f;
            dryEnv_[b]       = 0.0f;
            procEnv_[b]      = 0.0f;
            slowDryEnv_[b]   = 0.0f;
        }
        overallMeanSq_ = 0.0f;

#ifdef XLETH_DEBUG
        DBG("[SmartBal] prepareToPlay sr=" + juce::String(sampleRate)
            + " blockSize=" + juce::String(maxBlockSize));
#endif
    }

    // ── resetEffect ─────────────────────────────────────────────────────────
    void resetEffect() override
    {
        crossoverMid_.reset();
        crossoverLow_.reset();
        crossoverHigh_.reset();
        allpassLow_.reset();
        allpassHigh_.reset();

        for (int b = 0; b < 4; ++b)
        {
            meanSq_[b]       = 0.0f;
            smoothedGain_[b] = 0.0f;
            dryEnv_[b]       = 0.0f;
            procEnv_[b]      = 0.0f;
            slowDryEnv_[b]   = 0.0f;
        }
        overallMeanSq_ = 0.0f;
    }

    // ── processEffect ───────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        juce::ScopedNoDenormals noDenormals;

        const int numSamples = buffer.getNumSamples();
        const int numCh      = buffer.getNumChannels();

        // Mode: discrete, read once per block
        const int mode = juce::roundToInt(modeParam_->load(std::memory_order_relaxed));

        // Response-dependent coefficients: computed once per block
        const float response = getSmoothedValue("response");
        const float sr       = static_cast<float>(sampleRate_);

        const float rmsCoeffSub  = std::exp(-1.0f / (response * 2.0f * 0.001f * sr));
        const float rmsCoeffStd  = std::exp(-1.0f / (response * 0.001f * sr));
        const float overallCoeff = std::exp(-1.0f / (response * 3.0f * 0.001f * sr));
        const float attackCoeff  = std::exp(-1.0f / std::max(response * 0.3f * 0.001f * sr, 1e-6f));
        const float releaseCoeff = std::exp(-1.0f / std::max(response * 1.5f * 0.001f * sr, 1e-6f));

        const float rmsCoeff[4] = { rmsCoeffSub, rmsCoeffStd, rmsCoeffStd, rmsCoeffStd };

        // Band parameter IDs for indexed access
        static const std::string kTargetIds[4]  = { "target_sub", "target_lomid", "target_upmid", "target_air" };
        static const std::string kBandAmtIds[4] = { "bandamt_sub", "bandamt_lomid", "bandamt_upmid", "bandamt_air" };
        static const std::string kFloorIds[4]   = { "floor_sub", "floor_lomid", "floor_upmid", "floor_air" };

#ifdef XLETH_DEBUG
        static int blockCount_ = 0;
        ++blockCount_;
        const bool doLog = (blockCount_ % 1000 == 0);
#endif

        for (int s = 0; s < numSamples; ++s)
        {
            // ── Advance all smoothed parameters (once per sample) ────────
            const float amount   = getNextSmoothedValue("amount");
            const float preserve = getNextSmoothedValue("preserve");
            /*response*/ getNextSmoothedValue("response");
            const float mix      = getNextSmoothedValue("mix");

            float target[4], bandamt[4], floorDb[4];
            for (int b = 0; b < 4; ++b)
            {
                target[b]  = getNextSmoothedValue(kTargetIds[b]);
                bandamt[b] = getNextSmoothedValue(kBandAmtIds[b]);
                floorDb[b] = getNextSmoothedValue(kFloorIds[b]);
            }

            // ── Read input ───────────────────────────────────────────────
            const float inL = buffer.getSample(0, s);
            const float inR = numCh > 1 ? buffer.getSample(1, s) : inL;

            // ── Overall broadband RMS (for Relative mode) ────────────────
            const float sqBB = 0.5f * (inL * inL + inR * inR);
            overallMeanSq_ = overallCoeff * overallMeanSq_ + (1.0f - overallCoeff) * sqBB;
            const float overallRmsDb = 10.0f * std::log10(std::max(overallMeanSq_, 1e-10f));

            // ── Crossover split: balanced binary tree ────────────────────
            // L channel
            float lowHalfL, highHalfL;
            crossoverMid_.processSample(0, inL, lowHalfL, highHalfL);

            float band3L, band4L;
            crossoverHigh_.processSample(0, allpassLow_.processSample(0, highHalfL), band3L, band4L);

            float band1L, band2L;
            crossoverLow_.processSample(0, allpassHigh_.processSample(0, lowHalfL), band1L, band2L);

            // R channel
            float band1R, band2R, band3R, band4R;
            if (numCh > 1)
            {
                float lowHalfR, highHalfR;
                crossoverMid_.processSample(1, inR, lowHalfR, highHalfR);

                crossoverHigh_.processSample(1, allpassLow_.processSample(1, highHalfR), band3R, band4R);
                crossoverLow_.processSample(1, allpassHigh_.processSample(1, lowHalfR), band1R, band2R);
            }
            else
            {
                band1R = band1L; band2R = band2L;
                band3R = band3L; band4R = band4L;
            }

            float dryBandL[4] = { band1L, band2L, band3L, band4L };
            float dryBandR[4] = { band1R, band2R, band3R, band4R };
            float procBandL[4], procBandR[4];

            // ── Per-band processing ──────────────────────────────────────
            for (int b = 0; b < 4; ++b)
            {
                // 1. RMS measurement (stereo-linked one-pole IIR on squared signal)
                const float sq = 0.5f * (dryBandL[b] * dryBandL[b] + dryBandR[b] * dryBandR[b]);
                meanSq_[b] = rmsCoeff[b] * meanSq_[b] + (1.0f - rmsCoeff[b]) * sq;
                const float bandRmsDb = 10.0f * std::log10(std::max(meanSq_[b], 1e-10f));

                // 2. Dry peak envelope (for dynamics restoration)
                const float dryRect = std::max(std::abs(dryBandL[b]), std::abs(dryBandR[b]));
                if (dryRect > dryEnv_[b])
                    dryEnv_[b] = dynAtkCoeff_ * dryEnv_[b] + (1.0f - dynAtkCoeff_) * dryRect;
                else
                    dryEnv_[b] = dynRelCoeff_ * dryEnv_[b] + (1.0f - dynRelCoeff_) * dryRect;

                // Slow dry envelope (for transient detection debug display)
                if (dryRect > slowDryEnv_[b])
                    slowDryEnv_[b] = dynAtkCoeff_ * slowDryEnv_[b] + (1.0f - dynAtkCoeff_) * dryRect;
                else
                    slowDryEnv_[b] = slowDynRelCoeff_ * slowDryEnv_[b] + (1.0f - slowDynRelCoeff_) * dryRect;

                // 3. Compute target based on mode
                float targetDb;
                if (mode == 0) // Relative
                    targetDb = overallRmsDb + target[b];
                else // Absolute
                    targetDb = target[b];

                // 4. Compute error
                float errorDb = targetDb - bandRmsDb;

                // 5. Soft knee (6 dB knee width)
                float correction;
                constexpr float knee = 6.0f;
                if (std::abs(errorDb) < knee / 2.0f)
                    correction = errorDb * (errorDb + knee / 2.0f) / knee;
                else
                    correction = errorDb;

                // 6. Scale by global amount and per-band amount
                correction *= (amount / 100.0f) * (bandamt[b] / 100.0f);

                // 7. Clamp ±10 dB
                correction = juce::jlimit(-10.0f, 10.0f, correction);

                // 8. Gate: if band RMS below floor, drift correction toward 0
                float smoothCoeff;
                if (bandRmsDb < floorDb[b])
                {
                    correction = 0.0f;
                    smoothCoeff = gateRelCoeff_;
                }
                else
                {
                    smoothCoeff = (std::abs(correction) > std::abs(smoothedGain_[b]))
                        ? attackCoeff : releaseCoeff;
                }

                // 9. Smooth the correction
                smoothedGain_[b] = correction + smoothCoeff * (smoothedGain_[b] - correction);

                // 10. Apply auto-gain
                const float gainLin = std::pow(10.0f, smoothedGain_[b] / 20.0f);
                procBandL[b] = dryBandL[b] * gainLin;
                procBandR[b] = dryBandR[b] * gainLin;

                // 11. Processed peak envelope (AFTER auto-gain, BEFORE restoration)
                const float procRect = std::max(std::abs(procBandL[b]), std::abs(procBandR[b]));
                if (procRect > procEnv_[b])
                    procEnv_[b] = dynAtkCoeff_ * procEnv_[b] + (1.0f - dynAtkCoeff_) * procRect;
                else
                    procEnv_[b] = dynRelCoeff_ * procEnv_[b] + (1.0f - dynRelCoeff_) * procRect;

                // 12. Dynamics restoration
                const float dryEnvDb  = 20.0f * std::log10(std::max(dryEnv_[b], 1e-10f));
                const float procEnvDb = 20.0f * std::log10(std::max(procEnv_[b], 1e-10f));
                const float deltaDb   = juce::jlimit(-10.0f, 10.0f, dryEnvDb - procEnvDb);
                const float restoreGain = std::pow(10.0f, (deltaDb * preserve / 100.0f) / 20.0f);

                procBandL[b] *= restoreGain;
                procBandR[b] *= restoreGain;
            }

            // ── Recombine bands ──────────────────────────────────────────
            const float wetL = procBandL[0] + procBandL[1] + procBandL[2] + procBandL[3];
            const float wetR = procBandR[0] + procBandR[1] + procBandR[2] + procBandR[3];

            // ── Dry/wet mix ──────────────────────────────────────────────
            const float mixN = mix / 100.0f;
            const float outL = inL + mixN * (wetL - inL);
            const float outR = inR + mixN * (wetR - inR);

            buffer.setSample(0, s, outL);
            if (numCh > 1) buffer.setSample(1, s, outR);
        }

        // ── Metering (once per block) ────────────────────────────────────
        for (int b = 0; b < 4; ++b)
        {
            const float rmsDb = 10.0f * std::log10(std::max(meanSq_[b], 1e-10f));
            writeMeterValue(b,     rmsDb);             // Slots 0–3: per-band RMS
            writeMeterValue(b + 4, smoothedGain_[b]);  // Slots 4–7: gain correction

            debugDryRms_[b].store(rmsDb, std::memory_order_relaxed);

            debugDynDelta_[b].store(
                juce::jlimit(-10.0f, 10.0f,
                    20.0f * std::log10(std::max(dryEnv_[b], 1e-10f))
                  - 20.0f * std::log10(std::max(procEnv_[b], 1e-10f))),
                std::memory_order_relaxed);

            debugTransient_[b].store(
                (slowDryEnv_[b] > 1e-10f && dryEnv_[b] / slowDryEnv_[b] > 2.0f)
                    ? 1.0f : 0.0f,
                std::memory_order_relaxed);
        }
        debugOverallRms_.store(
            10.0f * std::log10(std::max(overallMeanSq_, 1e-10f)),
            std::memory_order_relaxed);

#ifdef XLETH_DEBUG
        if (doLog)
        {
            juce::String gated;
            for (int b = 0; b < 4; ++b)
                if (debugDryRms_[b].load(std::memory_order_relaxed) < getSmoothedValue(kFloorIds[b]))
                    gated += juce::String(b) + " ";

            DBG("[SmartBal] RMS: "
                + juce::String(debugDryRms_[0].load(std::memory_order_relaxed), 1) + " / "
                + juce::String(debugDryRms_[1].load(std::memory_order_relaxed), 1) + " / "
                + juce::String(debugDryRms_[2].load(std::memory_order_relaxed), 1) + " / "
                + juce::String(debugDryRms_[3].load(std::memory_order_relaxed), 1)
                + " Gain: "
                + juce::String(smoothedGain_[0], 1) + " / "
                + juce::String(smoothedGain_[1], 1) + " / "
                + juce::String(smoothedGain_[2], 1) + " / "
                + juce::String(smoothedGain_[3], 1)
                + " DynDelta: "
                + juce::String(debugDynDelta_[0].load(std::memory_order_relaxed), 1) + " / "
                + juce::String(debugDynDelta_[1].load(std::memory_order_relaxed), 1) + " / "
                + juce::String(debugDynDelta_[2].load(std::memory_order_relaxed), 1) + " / "
                + juce::String(debugDynDelta_[3].load(std::memory_order_relaxed), 1)
                + " OverallRMS: "
                + juce::String(debugOverallRms_.load(std::memory_order_relaxed), 1)
                + " Gated: [" + gated.trim() + "]");
        }
#endif
    }

private:
    // ── Parameter layout ────────────────────────────────────────────────────
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Apc = juce::AudioParameterChoice;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            // Global
            std::make_unique<Apf>(Pid{"amount",   1}, "Amount",   Nar{0.0f,   100.0f, 0.0f, 1.0f},  70.0f,  "%"),
            std::make_unique<Apf>(Pid{"preserve", 1}, "Preserve", Nar{0.0f,   100.0f, 0.0f, 1.0f},  40.0f,  "%"),
            std::make_unique<Apf>(Pid{"response", 1}, "Response", Nar{10.0f,  500.0f, 0.0f, 1.0f}, 150.0f,  "ms"),
            std::make_unique<Apf>(Pid{"mix",      1}, "Mix",      Nar{0.0f,   100.0f, 0.0f, 1.0f}, 100.0f,  "%"),
            std::make_unique<Apc>(Pid{"mode",     1}, "Mode",
                juce::StringArray{"Relative", "Absolute"}, 0),

            // Per-band targets
            std::make_unique<Apf>(Pid{"target_sub",    1}, "Target Sub",
                Nar{-40.0f, 12.0f, 0.0f, 1.0f}, 0.0f, "dB"),
            std::make_unique<Apf>(Pid{"target_lomid",  1}, "Target LoMid",
                Nar{-40.0f, 12.0f, 0.0f, 1.0f}, 0.0f, "dB"),
            std::make_unique<Apf>(Pid{"target_upmid",  1}, "Target UpMid",
                Nar{-40.0f, 12.0f, 0.0f, 1.0f}, 0.0f, "dB"),
            std::make_unique<Apf>(Pid{"target_air",    1}, "Target Air",
                Nar{-40.0f, 12.0f, 0.0f, 1.0f}, 0.0f, "dB"),

            // Per-band amounts
            std::make_unique<Apf>(Pid{"bandamt_sub",   1}, "Band Amt Sub",
                Nar{0.0f, 100.0f, 0.0f, 1.0f}, 100.0f, "%"),
            std::make_unique<Apf>(Pid{"bandamt_lomid", 1}, "Band Amt LoMid",
                Nar{0.0f, 100.0f, 0.0f, 1.0f}, 100.0f, "%"),
            std::make_unique<Apf>(Pid{"bandamt_upmid", 1}, "Band Amt UpMid",
                Nar{0.0f, 100.0f, 0.0f, 1.0f}, 100.0f, "%"),
            std::make_unique<Apf>(Pid{"bandamt_air",   1}, "Band Amt Air",
                Nar{0.0f, 100.0f, 0.0f, 1.0f}, 100.0f, "%"),

            // Per-band floors
            std::make_unique<Apf>(Pid{"floor_sub",    1}, "Floor Sub",
                Nar{-96.0f, -20.0f, 0.0f, 1.0f}, -60.0f, "dB"),
            std::make_unique<Apf>(Pid{"floor_lomid",  1}, "Floor LoMid",
                Nar{-96.0f, -20.0f, 0.0f, 1.0f}, -60.0f, "dB"),
            std::make_unique<Apf>(Pid{"floor_upmid",  1}, "Floor UpMid",
                Nar{-96.0f, -20.0f, 0.0f, 1.0f}, -60.0f, "dB"),
            std::make_unique<Apf>(Pid{"floor_air",    1}, "Floor Air",
                Nar{-96.0f, -20.0f, 0.0f, 1.0f}, -60.0f, "dB"),
        };
    }

    // ── DSP state ───────────────────────────────────────────────────────────
    double sampleRate_ = 44100.0;

    // Crossover (balanced binary tree: 3 LR4 + 2 allpass compensators)
    juce::dsp::LinkwitzRileyFilter<float> crossoverMid_;    // 800 Hz
    juce::dsp::LinkwitzRileyFilter<float> crossoverLow_;    // 150 Hz
    juce::dsp::LinkwitzRileyFilter<float> crossoverHigh_;   // 4000 Hz
    juce::dsp::LinkwitzRileyFilter<float> allpassLow_;      // 150 Hz, allpass
    juce::dsp::LinkwitzRileyFilter<float> allpassHigh_;     // 4000 Hz, allpass

    // Per-band RMS
    float meanSq_[4] = {};           // one-pole IIR state for RMS
    float overallMeanSq_ = 0.0f;     // broadband RMS for relative mode

    // Per-band gain
    float smoothedGain_[4] = {};     // smoothed correction in dB

    // Dynamics restoration envelopes
    float dryEnv_[4] = {};           // dry peak envelope per band
    float procEnv_[4] = {};          // processed peak envelope per band
    float slowDryEnv_[4] = {};       // slow dry envelope for transient detection

    // Fixed coefficients (set in prepareEffect)
    float dynAtkCoeff_     = 0.0f;   // 2 ms attack
    float dynRelCoeff_     = 0.0f;   // 80 ms release
    float slowDynRelCoeff_ = 0.0f;   // 200 ms release (transient detect)
    float gateRelCoeff_    = 0.0f;   // 2000 ms gate release

    // Mode parameter (discrete, not smoothed)
    std::atomic<float>* modeParam_ = nullptr;

public:
    // Debug atomics — read by the N-API bridge at ~30 fps (relaxed loads only).
    // Written once per block on the audio thread; no locks needed.
    std::atomic<float> debugDryRms_[4] = {};
    std::atomic<float> debugDynDelta_[4] = {};
    std::atomic<float> debugTransient_[4] = {};
    std::atomic<float> debugOverallRms_{0.0f};
};
