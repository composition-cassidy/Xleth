#pragma once

#include "audio/XlethEffectBase.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <cmath>

// ─── XlethDistortionEffect ────────────────────────────────────────────────────
// Stereo distortion effect with 4 shaping modes, pre/post Butterworth tone
// filter, 4× FIR equiripple oversampling, DC blocking, and dry/wet mix.
//
// Parameters (APVTS-backed):
//   mode       0–3   discrete  0=Tube(tanh), 1=SoftClip(cubic),
//                              2=HardClip,   3=Analog(asymmetric diode)
//   drive      0–48 dB         (Linear 20ms smoothing, skew 0.5)
//   tone       20–20000 Hz     (Multiplicative 30ms smoothing, skew 0.23)
//   filter_pos 0–1   discrete  0=pre-distortion, 1=post-distortion
//   mix        0–100 %         (Linear 20ms smoothing)
//
// Metering slots:
//   0 — L channel output peak (absolute, max over block)
//   1 — R channel output peak
//
// Oversampling: 4× FIR equiripple (factor exponent 2 → 2^2 = 4×),
//               integer latency, reported via setLatencySamples().
// Tone filter : 2nd-order Butterworth LP; coefficients set each block.
// DC blocker  : 2nd-order Butterworth HP at 10 Hz, applied at base sample
//               rate after downsampling. Mandatory for Analog mode.
//
// pluginId: "distortion"

class XlethDistortionEffect : public XlethEffectBase
{
public:
    // ── Constructor ─────────────────────────────────────────────────────────
    XlethDistortionEffect()
        : XlethEffectBase("distortion", createLayout())
        , oversampling_(2, 2,
                        juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple,
                        true, true)
    {
        registerSmoothedParam("drive", SmoothType::Linear,         20.0f);
        registerSmoothedParam("tone",  SmoothType::Multiplicative, 30.0f);
        registerSmoothedParam("mix",   SmoothType::Linear,         20.0f);
    }

    // ── prepareEffect ────────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;

        // Cache raw APVTS pointers for discrete (non-smoothed) parameters
        modePtr_      = apvts_.getRawParameterValue("mode");
        filterPosPtr_ = apvts_.getRawParameterValue("filter_pos");

        prevFilterPos_ = filterPosPtr_
            ? static_cast<int>(filterPosPtr_->load(std::memory_order_relaxed))
            : 1;

        // Oversampling — reset before init to clear stale state on re-prepare.
        // initProcessing() must NEVER be called from the audio thread.
        oversampling_.reset();
        oversampling_.initProcessing(static_cast<size_t>(maxBlockSize));

        oversampledRate_ = sampleRate_ * oversampling_.getOversamplingFactor();

        // Report FIR latency to the host PDC
        setLatencySamples(static_cast<int>(oversampling_.getLatencyInSamples()));

        // Tone filters (one per channel, 2nd-order Butterworth LP)
        juce::dsp::ProcessSpec spec;
        spec.sampleRate       = sampleRate_;
        spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
        spec.numChannels      = 1;

        toneFilterL_.prepare(spec);
        toneFilterR_.prepare(spec);
        toneFilterL_.reset();
        toneFilterR_.reset();

        // DC blockers at base sample rate (HP @ 10 Hz, coefficients set once)
        dcBlockerL_.prepare(spec);
        dcBlockerR_.prepare(spec);
        dcBlockerL_.reset();
        dcBlockerR_.reset();

        auto dcCoeffs = juce::dsp::IIR::Coefficients<float>::makeHighPass(
            sampleRate_, 10.0f);
        dcBlockerL_.coefficients = dcCoeffs;
        dcBlockerR_.coefficients = dcCoeffs;

        // Dry buffer for dry/wet blend — must be copied before upsampling
        distortDryBuf_.setSize(2, maxBlockSize, false, true, true);

#ifdef XLETH_DEBUG
        DBG("[Distortion] prepareEffect sr=" + juce::String(sampleRate_)
            + " osFactor=" + juce::String((int)oversampling_.getOversamplingFactor())
            + " osLatency=" + juce::String(oversampling_.getLatencyInSamples(), 1)
            + " oversampledRate=" + juce::String(oversampledRate_)
            + " blockSize=" + juce::String(maxBlockSize));
#endif
    }

    // ── resetEffect ──────────────────────────────────────────────────────────
    void resetEffect() override
    {
        oversampling_.reset();
        toneFilterL_.reset();
        toneFilterR_.reset();
        dcBlockerL_.reset();
        dcBlockerR_.reset();
    }

    // ── releaseEffect ────────────────────────────────────────────────────────
    void releaseEffect() override
    {
        distortDryBuf_.setSize(0, 0);
    }

    // ── processEffect ────────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh      = buffer.getNumChannels();

        // ── 1. Discrete parameters (read once per block) ─────────────────────
        const int mode = modePtr_
            ? static_cast<int>(modePtr_->load(std::memory_order_relaxed))
            : 0;
        const int filterPos = filterPosPtr_
            ? static_cast<int>(filterPosPtr_->load(std::memory_order_relaxed))
            : 1;

        // Reset tone filters when filter_pos changes to avoid transients
        if (filterPos != prevFilterPos_)
        {
            toneFilterL_.reset();
            toneFilterR_.reset();
            prevFilterPos_ = filterPos;
        }

        // ── 2. Advance smoothers at sampleRate_, capture final block values ───
        // Smoothers operate at sampleRate_, not oversampledRate_. We advance
        // numSamples times and use block-level values for all OS samples.
        float driveDb = 12.0f;
        float toneHz  = 8000.0f;
        float mixPct  = 100.0f;

        for (int s = 0; s < numSamples; ++s)
        {
            driveDb = getNextSmoothedValue("drive");
            toneHz  = getNextSmoothedValue("tone");
            mixPct  = getNextSmoothedValue("mix");
        }

        const float driveLin = std::pow(10.0f, driveDb / 20.0f);
        const float modeDriveTrim = getModeDriveTrim(mode);
        const float modeOutputTrim = getModeOutputTrim(mode);

        // ── 3. Copy dry signal BEFORE upsampling (buffer still clean here) ───
        for (int ch = 0; ch < std::min(numCh, distortDryBuf_.getNumChannels()); ++ch)
            distortDryBuf_.copyFrom(ch, 0, buffer, ch, 0, numSamples);

        // ── 4. PRE tone filter (applied at sampleRate_) ───────────────────────
        if (filterPos == 0)
        {
            auto lp = juce::dsp::IIR::Coefficients<float>::makeLowPass(
                sampleRate_, toneHz);
            toneFilterL_.coefficients = lp;
            toneFilterR_.coefficients = lp;

            float* pL = buffer.getWritePointer(0);
            for (int s = 0; s < numSamples; ++s)
                pL[s] = toneFilterL_.processSample(pL[s]);

            if (numCh > 1)
            {
                float* pR = buffer.getWritePointer(1);
                for (int s = 0; s < numSamples; ++s)
                    pR[s] = toneFilterR_.processSample(pR[s]);
            }
        }

        // ── 5. Upsample ───────────────────────────────────────────────────────
        // processSamplesUp reads from inputBlock and writes to internal memory;
        // returns an AudioBlock referencing that internal memory (do NOT store).
        juce::dsp::AudioBlock<const float> inputBlock(buffer);
        auto osBlock = oversampling_.processSamplesUp(inputBlock);

        const int osNumSamples = static_cast<int>(osBlock.getNumSamples());
        const int osNumCh      = static_cast<int>(osBlock.getNumChannels());

        // ── 6. Distortion per channel per OS sample ───────────────────────────
        for (int ch = 0; ch < osNumCh; ++ch)
        {
            float* data = osBlock.getChannelPointer(static_cast<size_t>(ch));

            for (int s = 0; s < osNumSamples; ++s)
            {
                const float x = data[s] * driveLin * modeDriveTrim;
                float out;

                switch (mode)
                {
                    case 0: // Tube — tanh saturation
                        out = std::tanh(0.82f * x);
                        break;

                    case 1: // SoftClip — cubic polynomial, normalized ×1.5
                        if (std::abs(x) < 1.0f)
                            out = x - (x * x * x) / 3.0f;
                        else
                            out = std::copysign(2.0f / 3.0f, x);
                        out *= 1.5f;
                        break;

                    case 2: // HardClip — brick-wall ±1
                        out = juce::jlimit(-0.72f, 0.72f, x) / 0.72f;
                        break;

                    case 3: // Analog — asymmetric diode waveshaper
                        {
                            constexpr float bias = 0.78f;
                            const float center = std::tanh(bias);
                            const float y = std::tanh(0.92f * x + bias) - center;
                            const float norm = y >= 0.0f ? (1.0f - center) : (1.0f + center);
                            out = y / norm;
                        }
                        break;

                    default:
                        out = x;
                        break;
                }

                data[s] = juce::jlimit(-1.0f, 1.0f, out * modeOutputTrim);
            }
        }

        // ── 7. POST tone filter (applied at oversampledRate_) ─────────────────
        if (filterPos == 1)
        {
            auto lp = juce::dsp::IIR::Coefficients<float>::makeLowPass(
                oversampledRate_, toneHz);
            toneFilterL_.coefficients = lp;
            toneFilterR_.coefficients = lp;

            float* pL = osBlock.getChannelPointer(0);
            for (int s = 0; s < osNumSamples; ++s)
                pL[s] = toneFilterL_.processSample(pL[s]);

            if (osNumCh > 1)
            {
                float* pR = osBlock.getChannelPointer(1);
                for (int s = 0; s < osNumSamples; ++s)
                    pR[s] = toneFilterR_.processSample(pR[s]);
            }
        }

        // ── 8. Downsample back to sampleRate_ ────────────────────────────────
        juce::dsp::AudioBlock<float> outputBlock(buffer);
        oversampling_.processSamplesDown(outputBlock);

        // ── 9. DC blockers at sampleRate_ (after downsampling, never in OS) ───
        {
            float* pL = buffer.getWritePointer(0);
            for (int s = 0; s < numSamples; ++s)
                pL[s] = dcBlockerL_.processSample(pL[s]);

            if (numCh > 1)
            {
                float* pR = buffer.getWritePointer(1);
                for (int s = 0; s < numSamples; ++s)
                    pR[s] = dcBlockerR_.processSample(pR[s]);
            }
        }

        // ── 10. Dry/wet blend ─────────────────────────────────────────────────
        const float mixNorm = juce::jlimit(0.0f, 1.0f, mixPct / 100.0f);
        if (mixNorm < 1.0f)
        {
            for (int ch = 0; ch < numCh && ch < distortDryBuf_.getNumChannels(); ++ch)
            {
                const float* dry = distortDryBuf_.getReadPointer(ch);
                float*       wet = buffer.getWritePointer(ch);
                for (int s = 0; s < numSamples; ++s)
                    wet[s] = dry[s] * (1.0f - mixNorm) + wet[s] * mixNorm;
            }
        }

        // ── 11. Metering: slots 0,1 = L/R output peak ────────────────────────
        float peakL = 0.0f, peakR = 0.0f;
        {
            const float* pL = buffer.getReadPointer(0);
            for (int s = 0; s < numSamples; ++s)
                peakL = std::max(peakL, std::abs(pL[s]));
        }
        if (numCh > 1)
        {
            const float* pR = buffer.getReadPointer(1);
            for (int s = 0; s < numSamples; ++s)
                peakR = std::max(peakR, std::abs(pR[s]));
        }

        writeMeterValue(0, peakL);
        writeMeterValue(1, numCh > 1 ? peakR : peakL);

#ifdef XLETH_DEBUG
        static int dbgBlockCount_ = 0;
        if ((++dbgBlockCount_ % 500) == 0)
            DBG("[Distortion] Throttled:"
                " mode=" + juce::String(mode)
                + " drive=" + juce::String(driveDb, 1) + "dB"
                + " tone=" + juce::String((int)toneHz) + "Hz"
                + " filterPos=" + juce::String(filterPos)
                + " mix=" + juce::String(mixPct, 0) + "%"
                + " peakL=" + juce::String(peakL, 3)
                + " peakR=" + juce::String(peakR, 3));
#endif
    }

private:
    static float getModeDriveTrim(int mode) noexcept
    {
        switch (mode)
        {
            case 0: return 0.58f; // Tube: later, rounder saturation.
            case 1: return 0.72f; // Soft Clip: clear knee without becoming a brick wall.
            case 2: return 1.35f; // Hard Clip: intentionally lower effective headroom.
            case 3: return 1.00f; // Analog: enough level to expose asymmetry.
            default: return 1.0f;
        }
    }

    static float getModeOutputTrim(int mode) noexcept
    {
        // Small compensation trims keep comparisons honest without making one
        // mode win merely by being louder.
        switch (mode)
        {
            case 0: return 1.10f;
            case 1: return 1.08f;
            case 2: return 0.88f;
            case 3: return 1.04f;
            default: return 1.0f;
        }
    }

    // ── Parameter layout ─────────────────────────────────────────────────────
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            std::make_unique<Apf>(Pid{"mode",       1}, "Mode",
                Nar{0.0f,       3.0f,  1.0f, 1.0f  },   0.0f, ""),
            std::make_unique<Apf>(Pid{"drive",       1}, "Drive",
                Nar{0.0f,      48.0f,  0.0f, 0.5f  },  12.0f, "dB"),
            std::make_unique<Apf>(Pid{"tone",        1}, "Tone",
                Nar{20.0f,  20000.0f,  0.0f, 0.23f }, 8000.0f, "Hz"),
            std::make_unique<Apf>(Pid{"filter_pos",  1}, "Filter Position",
                Nar{0.0f,       1.0f,  1.0f, 1.0f  },   1.0f, ""),
            std::make_unique<Apf>(Pid{"mix",         1}, "Mix",
                Nar{0.0f,     100.0f,  0.0f, 1.0f  }, 100.0f, "%"),
        };
    }

    // ── Raw APVTS pointers for discrete (non-smoothed) parameters ────────────
    std::atomic<float>* modePtr_      = nullptr;
    std::atomic<float>* filterPosPtr_ = nullptr;

    // ── 4× FIR equiripple oversampling (2 channels, factor exponent 2) ───────
    // Constructed in MIL with all args; initProcessing() called in prepareEffect.
    juce::dsp::Oversampling<float> oversampling_;

    // ── Tone filters: 2nd-order Butterworth LP, one per channel ──────────────
    juce::dsp::IIR::Filter<float> toneFilterL_;
    juce::dsp::IIR::Filter<float> toneFilterR_;

    // ── DC blockers: 2nd-order HP @ 10 Hz, one per channel ───────────────────
    juce::dsp::IIR::Filter<float> dcBlockerL_;
    juce::dsp::IIR::Filter<float> dcBlockerR_;

    // ── Dry copy buffer (taken before upsampling for mix blend) ──────────────
    juce::AudioBuffer<float> distortDryBuf_;

    // ── State ─────────────────────────────────────────────────────────────────
    double sampleRate_      = 44100.0;
    double oversampledRate_ = 176400.0;
    int    prevFilterPos_   = 1;
};
