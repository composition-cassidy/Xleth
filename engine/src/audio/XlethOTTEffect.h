#pragma once

#include "audio/XlethEffectBase.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <cmath>

// ─── XlethOTTEffect ──────────────────────────────────────────────────────────
// 3-band multiband compressor with upward + downward compression per band.
// Modeled after the classic OTT preset: aggressive dynamics flattening with
// phase-coherent Linkwitz-Riley crossover and RMS envelope detection.
//
// Parameters (APVTS-backed):
//   depth       0–100 %       dry/wet mix  (Linear 20ms)
//   time        0–100 %       attack/release scaling  (Linear 20ms)
//   xover_low   40–400 Hz     low/mid crossover  (Mult 30ms)
//   xover_high  1000–8000 Hz  mid/high crossover  (Mult 30ms)
//   gain_low    -12–12 dB     low band trim  (Linear 20ms)
//   gain_mid    -12–12 dB     mid band trim  (Linear 20ms)
//   gain_high   -12–12 dB     high band trim  (Linear 20ms)
//
// Metering slots:
//   0 — L output peak
//   1 — R output peak
//   2 — Low band GR (dB, positive = reduction)
//   3 — Mid band GR
//   4 — High band GR
//
// pluginId: "overdone"

class XlethOTTEffect : public XlethEffectBase
{
public:
    XlethOTTEffect() : XlethEffectBase("overdone", createLayout())
    {
        registerSmoothedParam("depth",      SmoothType::Linear,         20.0f);
        registerSmoothedParam("time",       SmoothType::Linear,         20.0f);
        registerSmoothedParam("xover_low",  SmoothType::Multiplicative, 30.0f);
        registerSmoothedParam("xover_high", SmoothType::Multiplicative, 30.0f);
        registerSmoothedParam("gain_low",   SmoothType::Linear,         20.0f);
        registerSmoothedParam("gain_mid",   SmoothType::Linear,         20.0f);
        registerSmoothedParam("gain_high",  SmoothType::Linear,         20.0f);
    }

    // ── prepareEffect ───────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;

        juce::dsp::ProcessSpec spec;
        spec.sampleRate       = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
        spec.numChannels      = 2;

        crossover1_.prepare(spec);
        crossover2_.prepare(spec);
        allpassComp_.prepare(spec);

        allpassComp_.setType(juce::dsp::LinkwitzRileyFilterType::allpass);

        // Set initial crossover frequencies
        const float xLo = getSmoothedValue("xover_low");
        const float xHi = getSmoothedValue("xover_high");
        crossover1_.setCutoffFrequency(std::max(xLo, 20.0f));
        crossover2_.setCutoffFrequency(std::max(xHi, 200.0f));
        allpassComp_.setCutoffFrequency(std::max(xHi, 200.0f));

        for (int b = 0; b < 3; ++b)
        {
            env_[b]  = 0.0f;
            peak_[b] = 0.0f;
        }

#ifdef XLETH_DEBUG
        const float timePct = getSmoothedValue("time");
        const float tScale  = std::max(timePct / 50.0f, 0.002f);
        DBG("[OTT] prepareToPlay sr=" + juce::String(sampleRate)
            + " blockSize=" + juce::String(maxBlockSize)
            + " xoverLow=" + juce::String(xLo, 1)
            + " xoverHigh=" + juce::String(xHi, 1)
            + " lowAtk=" + juce::String(kBands[0].baseAttackMs * tScale, 1)
            + " lowRel=" + juce::String(kBands[0].baseReleaseMs * tScale, 1)
            + " midAtk=" + juce::String(kBands[1].baseAttackMs * tScale, 1)
            + " highAtk=" + juce::String(kBands[2].baseAttackMs * tScale, 1));
#endif
    }

    // ── resetEffect ─────────────────────────────────────────────────────────
    void resetEffect() override
    {
        crossover1_.reset();
        crossover2_.reset();
        allpassComp_.reset();
        for (int b = 0; b < 3; ++b)
        {
            env_[b]  = 0.0f;
            peak_[b] = 0.0f;
        }
    }

    // ── processEffect ───────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh      = buffer.getNumChannels();

        // Update crossover frequencies once per block
        const float xLo = getSmoothedValue("xover_low");
        const float xHi = getSmoothedValue("xover_high");
        crossover1_.setCutoffFrequency(std::max(xLo, 20.0f));
        crossover2_.setCutoffFrequency(std::max(xHi, 200.0f));
        allpassComp_.setCutoffFrequency(std::max(xHi, 200.0f));

        float peakL = 0.0f, peakR = 0.0f;
        float maxGR[3] = {};

#ifdef XLETH_DEBUG
        static int blockCount_ = 0;
        ++blockCount_;
        const bool doLog = (blockCount_ % 1000 == 0);
#endif

        for (int s = 0; s < numSamples; ++s)
        {
            // Advance all smoothed parameters
            const float depth   = getNextSmoothedValue("depth");
            const float timePct = getNextSmoothedValue("time");
            /*xover_low*/  getNextSmoothedValue("xover_low");
            /*xover_high*/ getNextSmoothedValue("xover_high");
            const float gLow    = getNextSmoothedValue("gain_low");
            const float gMid    = getNextSmoothedValue("gain_mid");
            const float gHigh   = getNextSmoothedValue("gain_high");

            // Time scaling: at 50% = 1x base values, 0% = near-zero, 100% = 2x
            const float timeScale = std::max(timePct / 50.0f, 0.002f);

            // Per-band attack/release coefficients
            float aCoeff[3], rCoeff[3];
            for (int b = 0; b < 3; ++b)
            {
                const float atkMs = kBands[b].baseAttackMs  * timeScale;
                const float relMs = kBands[b].baseReleaseMs * timeScale;
                aCoeff[b] = std::exp(-1.0f / std::max(atkMs * 0.001f * static_cast<float>(sampleRate_), 1e-6f));
                rCoeff[b] = std::exp(-1.0f / std::max(relMs * 0.001f * static_cast<float>(sampleRate_), 1e-6f));
            }

            // ── Band splitting ──────────────────────────────────────────
            float bandL[3], bandR[3];
            {
                const float inL = buffer.getSample(0, s);
                const float inR = numCh > 1 ? buffer.getSample(1, s) : inL;

                float lowL, midHighL, midL, highL;
                crossover1_.processSample(0, inL, lowL, midHighL);
                lowL = allpassComp_.processSample(0, lowL);
                crossover2_.processSample(0, midHighL, midL, highL);

                float lowR, midHighR, midR, highR;
                if (numCh > 1)
                {
                    crossover1_.processSample(1, inR, lowR, midHighR);
                    lowR = allpassComp_.processSample(1, lowR);
                    crossover2_.processSample(1, midHighR, midR, highR);
                }
                else
                {
                    lowR = lowL; midR = midL; highR = highL;
                }

                bandL[0] = lowL;  bandR[0] = lowR;
                bandL[1] = midL;  bandR[1] = midR;
                bandL[2] = highL; bandR[2] = highR;
            }

            // ── Per-band processing ─────────────────────────────────────
            const float userGain[3] = { gLow, gMid, gHigh };

            // Depth scales compression intensity (NOT dry/wet mix — avoids
            // comb filtering from phase mismatch between crossover and dry)
            // At depth=0%: no OTT compression, no internal band gain
            // At depth=100%: full OTT effect
            const float depthNorm = depth / 100.0f;

            for (int b = 0; b < 3; ++b)
            {
                // Input gain (+5.2 dB) applied to sidechain only for envelope
                // detection — keeps the audio path clean so depth=0% is unity
                const float scL = bandL[b] * kInputGainLin;
                const float scR = bandR[b] * kInputGainLin;

                // RMS envelope detection (stereo-linked, decoupled)
                const float sq = 0.5f * (scL * scL + scR * scR);
                peak_[b] = std::max(sq, rCoeff[b] * peak_[b] + (1.0f - rCoeff[b]) * sq);
                env_[b]  = aCoeff[b] * env_[b] + (1.0f - aCoeff[b]) * peak_[b];
                const float level = std::sqrt(std::max(env_[b], 1e-12f));

                // Envelope to dB
                const float envDB = 20.0f * std::log10(std::max(level, 1e-6f));

                // Combined upward + downward gain computation
                const float gainDB = computeOTTGainDB(envDB, kBands[b]);

                const float totalDB = (gainDB + kBands[b].bandGainDB + kInputGainDB) * depthNorm + userGain[b];

                // Track GR for metering (positive = reduction amount)
                // GR is the downward component only
                float grDB = 0.0f;
                if (envDB > kBands[b].downThreshDB)
                    grDB = (envDB - kBands[b].downThreshDB) * (1.0f - 1.0f / kBands[b].downRatio);
                maxGR[b] = std::max(maxGR[b], grDB);

                // Apply linear gain
                const float gainLin = std::pow(10.0f, totalDB / 20.0f);
                bandL[b] *= gainLin;
                bandR[b] *= gainLin;
            }

            // ── Recombine + master output ───────────────────────────────
            // Audio always passes through the crossover (no dry/wet mix) so
            // phase stays coherent. Depth already scaled the compression amount.
            const float masterLin = std::pow(10.0f, (kMasterOutDB * depthNorm) / 20.0f);
            const float outL = (bandL[0] + bandL[1] + bandL[2]) * masterLin;
            const float outR = (bandR[0] + bandR[1] + bandR[2]) * masterLin;

            buffer.setSample(0, s, outL);
            if (numCh > 1) buffer.setSample(1, s, outR);

            peakL = std::max(peakL, std::abs(outL));
            peakR = std::max(peakR, std::abs(outR));
        }

#ifdef XLETH_DEBUG
        if (doLog)
            DBG("[OTT] GR low=" + juce::String(maxGR[0], 2)
                + " mid=" + juce::String(maxGR[1], 2)
                + " high=" + juce::String(maxGR[2], 2)
                + " depth=" + juce::String(getSmoothedValue("depth"), 1) + "%"
                + " envLow=" + juce::String(20.0f * std::log10(std::max(std::sqrt(std::max(env_[0], 1e-12f)), 1e-6f)), 1)
                + " envMid=" + juce::String(20.0f * std::log10(std::max(std::sqrt(std::max(env_[1], 1e-12f)), 1e-6f)), 1)
                + " envHigh=" + juce::String(20.0f * std::log10(std::max(std::sqrt(std::max(env_[2], 1e-12f)), 1e-6f)), 1));
#endif

        writeMeterValue(0, peakL);
        writeMeterValue(1, numCh > 1 ? peakR : peakL);
        writeMeterValue(2, maxGR[0]);
        writeMeterValue(3, maxGR[1]);
        writeMeterValue(4, maxGR[2]);
    }

private:
    // ── Internal OTT preset ─────────────────────────────────────────────────
    struct BandPreset
    {
        float baseAttackMs, baseReleaseMs;
        float downThreshDB, downRatio;
        float upThreshDB,   upRatio;
        float bandGainDB;
    };

    static constexpr BandPreset kBands[3] = {
        // Low:  47.8ms atk, 282ms rel, down -33.8dB@66.7:1, up -40.8dB@4.17:1, +10.3dB
        { 47.8f, 282.0f, -33.8f, 66.7f, -40.8f, 4.17f, 10.3f },
        // Mid:  22.4ms atk, 282ms rel, down -30.3dB@66.7:1, up -41.8dB@4.17:1, +5.7dB
        { 22.4f, 282.0f, -30.3f, 66.7f, -41.8f, 4.17f,  5.7f },
        // High: 13.5ms atk, 132ms rel, down -35.5dB@inf:1,  up -40.8dB@4.17:1, +10.3dB
        { 13.5f, 132.0f, -35.5f, 1e6f,  -40.8f, 4.17f, 10.3f },
    };

    static constexpr float kInputGainDB  =  5.2f;
    static constexpr float kMasterOutDB  = -2.0f;
    static constexpr float kNoiseGateDB  = -80.0f;

    // Precomputed linear gains
    static constexpr float kInputGainLin = 1.8197f;  // 10^(5.2/20)
    static constexpr float kMasterOutLin = 0.7943f;  // 10^(-2/20)

    // ── Gain computation ────────────────────────────────────────────────────
    static float computeOTTGainDB(float envDB, const BandPreset& p)
    {
        float gainDB = 0.0f;

        // Upward compression: boost quiet signals toward upThresh
        // Noise gate at -80 dB prevents amplifying silence
        if (envDB < p.upThreshDB && envDB > kNoiseGateDB)
            gainDB += (p.upThreshDB - envDB) * (1.0f - 1.0f / p.upRatio);

        // Downward compression: reduce loud signals above downThresh
        if (envDB > p.downThreshDB)
            gainDB -= (envDB - p.downThreshDB) * (1.0f - 1.0f / p.downRatio);

        return gainDB;
    }

    // ── Parameter layout ────────────────────────────────────────────────────
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            std::make_unique<Apf>(Pid{"depth",      1}, "Depth",
                Nar{0.0f,    100.0f,  0.0f, 1.0f}, 70.0f,   "%"),
            std::make_unique<Apf>(Pid{"time",       1}, "Time",
                Nar{0.0f,    100.0f,  0.0f, 1.0f}, 50.0f,   "%"),
            std::make_unique<Apf>(Pid{"xover_low",  1}, "Xover Low",
                Nar{40.0f,   400.0f,  0.0f, 1.0f}, 88.0f,   "Hz"),
            std::make_unique<Apf>(Pid{"xover_high", 1}, "Xover High",
                Nar{1000.0f, 8000.0f, 0.0f, 1.0f}, 2500.0f, "Hz"),
            std::make_unique<Apf>(Pid{"gain_low",   1}, "Low Gain",
                Nar{-12.0f,  12.0f,   0.0f, 1.0f}, 0.0f,    "dB"),
            std::make_unique<Apf>(Pid{"gain_mid",   1}, "Mid Gain",
                Nar{-12.0f,  12.0f,   0.0f, 1.0f}, 0.0f,    "dB"),
            std::make_unique<Apf>(Pid{"gain_high",  1}, "High Gain",
                Nar{-12.0f,  12.0f,   0.0f, 1.0f}, 0.0f,    "dB"),
        };
    }

    // ── DSP state ───────────────────────────────────────────────────────────
    double sampleRate_ = 44100.0;

    // 3-band Linkwitz-Riley crossover (phase-coherent reconstruction)
    juce::dsp::LinkwitzRileyFilter<float> crossover1_;   // LP/HP at xover_low
    juce::dsp::LinkwitzRileyFilter<float> crossover2_;   // LP/HP at xover_high
    juce::dsp::LinkwitzRileyFilter<float> allpassComp_;  // allpass at xover_high (low band phase comp)

    // Per-band RMS envelope state (stereo-linked)
    float env_[3]  = {};   // 0=low, 1=mid, 2=high
    float peak_[3] = {};
};
