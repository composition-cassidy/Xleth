#pragma once

#include "audio/XlethEffectBase.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <cmath>

// ─── XlethDistortionEffect ────────────────────────────────────────────────────
// Stereo distortion effect with 7 shaping modes, pre/post Butterworth tone
// filter, 4× FIR equiripple oversampling, DC blocking, and dry/wet mix.
//
// Parameters (APVTS-backed):
//   mode       0–6   discrete  0=Tube(tanh), 1=SoftClip(cubic),
//                              2=HardClip,   3=Analog(asymmetric diode),
//                              4=Crush(bit quantize + S&H decimate),
//                              5=Fuzz(brick-wall clip → fixed LP),
//                              6=Sine(sin(k·x), k ramps with drive)
//   drive      0–48 dB         (Linear 20ms smoothing, skew 0.5)
//   tone       20–20000 Hz     (Multiplicative 30ms smoothing, skew 0.23)
//   filter_pos 0–1   discrete  0=pre-distortion, 1=post-distortion
//   mix        0–100 %         (Linear 20ms smoothing)
//   symmetry   0–100 %         (Linear 20ms smoothing) — Analog only.
//                              100 = the historical fixed 0.78 diode bias,
//                              0 = symmetric tanh. Default 100 reproduces the
//                              pre-expansion Analog curve bit-for-bit.
//   bits       2–16            (Linear 20ms smoothing) — Crush only.
//                              Default 16 (quantization step 2⁻¹⁵, transparent).
//   downsample 1–40×           (Linear 20ms smoothing) — Crush only.
//                              Sample-and-hold length in OVERSAMPLED samples.
//                              Default 1 (no hold, transparent).
//
// Append-only mode contract: modes 0–3 keep their stored meaning, and every new
// parameter defaults to its transparent value, so a session saved before the
// 7-mode expansion renders bit-identically after it. This is enforced by
// test_effects.cpp::testDistortionDefaultRenderUnchanged().
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
// Crush/Fuzz run INSIDE the oversampled stage (step 6): quantization steps and
// brick-wall corners generate wideband content, and doing them at 4× means the
// downsampling FIR removes everything that would otherwise fold back as
// inharmonic aliasing. The audible crunch lives below Nyquist; only the garbage
// above it is discarded.
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

        // New continuous params. Smoothed like the originals so a knob drag or
        // an automation ramp never steps the shaper discontinuously.
        registerSmoothedParam("symmetry",   SmoothType::Linear, 20.0f);
        registerSmoothedParam("bits",       SmoothType::Linear, 20.0f);
        registerSmoothedParam("downsample", SmoothType::Linear, 20.0f);
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
        prevMode_ = modePtr_
            ? static_cast<int>(modePtr_->load(std::memory_order_relaxed))
            : 0;

        // Handle-based smoother access for the new params: resolves the string
        // hash ONCE here so the per-block reads below cost a pointer deref.
        symmetrySmoother_   = resolveSmoothed("symmetry");
        bitsSmoother_       = resolveSmoothed("bits");
        downsampleSmoother_ = resolveSmoothed("downsample");

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

        // Fuzz tone-stack pole. One-pole LP at kFuzzLowpassHz, run at the
        // OVERSAMPLED rate (that is where the clipping corners are generated),
        // coefficient derived once here so the audio loop stays transcendental-
        // free for this mode.
        fuzzLpCoeff_ = 1.0f - std::exp(-2.0f * juce::MathConstants<float>::pi
                                       * kFuzzLowpassHz
                                       / static_cast<float>(oversampledRate_));

        resetShaperState();

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
        resetShaperState();
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

        // Crush's sample-and-hold register and Fuzz's lowpass pole hold state
        // from whenever their mode was last active. Clearing it on a mode change
        // stops a stale held sample or a stale pole value clicking in on the
        // first block after the switch.
        if (mode != prevMode_)
        {
            resetShaperState();
            prevMode_ = mode;
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

        // The new params are consumed at block rate (like drive/tone/mix above),
        // so advance their smoothers by the block length in one call and read
        // the resulting value — identical ramp position, no per-sample cost.
        symmetrySmoother_.skip(numSamples);
        bitsSmoother_.skip(numSamples);
        downsampleSmoother_.skip(numSamples);

        const float symmetryPct  = symmetrySmoother_.isValid()   ? symmetrySmoother_.current()   : 100.0f;
        const float bitsValue    = bitsSmoother_.isValid()       ? bitsSmoother_.current()       : 16.0f;
        const float downsampleValue = downsampleSmoother_.isValid() ? downsampleSmoother_.current() : 1.0f;

        const float driveLin = std::pow(10.0f, driveDb / 20.0f);
        const float modeDriveTrim = getModeDriveTrim(mode);
        const float modeOutputTrim = getModeOutputTrim(mode);

        // ── 2b. Block-rate shaper coefficients ───────────────────────────────
        // Everything transcendental or divide-heavy that depends only on block
        // parameters is hoisted here; the per-sample switch below stays cheap.

        // Analog bias morph. symmetry = 100 % yields exactly 0.78f — the value
        // that used to be a constexpr — so the default Analog curve is unchanged
        // to the last bit. symmetry = 0 % yields bias 0, i.e. a plain symmetric
        // tanh(0.92·x) with center 0 and norm 1.
        const float symNorm      = juce::jlimit(0.0f, 1.0f, symmetryPct * 0.01f);
        const float analogBias   = 0.78f * symNorm;
        const float analogCenter = std::tanh(analogBias);

        // Crush: half-scale step count for a mid-tread quantizer over [-1, 1].
        // bits = 16 → 32768 steps per polarity (≈ -96 dBFS error, transparent).
        const float crushSteps = std::pow(2.0f, juce::jlimit(2.0f, 16.0f, bitsValue) - 1.0f);
        const float crushStepsInv = 1.0f / crushSteps;
        // Sample-and-hold length in OVERSAMPLED samples; 1 = hold nothing.
        const int crushHold = std::max(1, static_cast<int>(
            std::lround(juce::jlimit(1.0f, 40.0f, downsampleValue))));

        // Sine: k sweeps π/2 → 2.30 rad across the drive range. At k = π/2 the
        // shaper is a pure quarter-sine soft clip that just reaches ±1 at the
        // input rails — a rounder knee than tanh, with the hollow odd-harmonic
        // spectrum that gives this mode its glassy character. Past π/2 the curve
        // turns over and folds, and the fold is where the extra harmonics come
        // from. The top of the sweep stops at 2.30, NOT at π: sin(π·x) is
        // exactly zero at the rails, so a k that reaches π makes a fully driven
        // signal collapse toward silence — measured as a 10 dB RMS hole against
        // the other modes. At 2.30 the rails still return sin(2.30) = 0.75, so
        // the fold is audible but the level stays honest.
        // |sin| never exceeds 1 over the clamped input, so the curve is
        // peak-normalized by construction — no extra scaling needed.
        const float sineK = juce::MathConstants<float>::halfPi
                          + (2.30f - juce::MathConstants<float>::halfPi)
                            * juce::jlimit(0.0f, 1.0f, driveDb / 48.0f);

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

            // Per-channel shaper state (Crush S&H register, Fuzz LP pole).
            const int stateIdx = std::min(ch, kMaxStateChannels - 1);
            float& holdValue   = crushHoldValue_[stateIdx];
            int&   holdCounter = crushHoldCounter_[stateIdx];
            float& fuzzLp      = fuzzLpState_[stateIdx];

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
                            // bias / center are the block-rate symmetry morph;
                            // at symmetry = 100 % they are 0.78f and tanh(0.78f),
                            // exactly the constants this mode always used.
                            const float y = std::tanh(0.92f * x + analogBias) - analogCenter;
                            const float norm = y >= 0.0f ? (1.0f - analogCenter)
                                                         : (1.0f + analogCenter);
                            out = y / norm;
                        }
                        break;

                    case 4: // Crush — sample-and-hold decimation + bit quantization
                        {
                            // Decimate first, then quantize the held value: the
                            // step edges then land on hold boundaries instead of
                            // dithering within a hold, which is what makes the
                            // grit read as "digital" rather than as noise.
                            if (holdCounter <= 0)
                            {
                                holdValue   = juce::jlimit(-1.0f, 1.0f, x);
                                holdCounter = crushHold;
                            }
                            --holdCounter;

                            // Mid-tread quantizer: symmetric about 0, so no new
                            // DC offset and no fold-back — drive past the rails
                            // clips rather than wrapping (wrapping just sounds
                            // broken).
                            out = std::round(holdValue * crushSteps) * crushStepsInv;
                        }
                        break;

                    case 5: // Fuzz — brick-wall clip into a fixed lowpass
                        {
                            const float clipped = juce::jlimit(-1.0f, 1.0f, x);
                            fuzzLp += fuzzLpCoeff_ * (clipped - fuzzLp);
                            out = fuzzLp;
                        }
                        break;

                    case 6: // Sine — sin(k·x), k ramping with drive
                        out = std::sin(sineK * juce::jlimit(-1.0f, 1.0f, x));
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
                + " sym=" + juce::String(symmetryPct, 0) + "%"
                + " bits=" + juce::String(bitsValue, 1)
                + " ds=" + juce::String(crushHold)
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
            case 4: return 0.90f; // Crush: the quantizer grid spans ±1, so hold
                                  // a little headroom back — otherwise every
                                  // drive setting above unity is just a clipper
                                  // and the bit steps stop being audible.
            case 5: return 1.25f; // Fuzz: the wall IS the effect. Extra gain in
                                  // keeps the duty cycle wide at low drive.
            case 6: return 0.85f; // Sine: drive already steepens k, so trimming
                                  // the input keeps the two from compounding
                                  // into instant fold-back.
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
            case 4: return 0.90f; // Crush: a quantized/held signal is dense and
                                  // sits close to the rails; pull it back to the
                                  // legacy modes' loudness.
            case 5: return 0.82f; // Fuzz: near-square output is the loudest
                                  // thing this effect can make — the biggest
                                  // trim in the table, for the same reason.
            case 6: return 0.86f; // Sine: peak-normalized already, only a small
                                  // RMS correction for the folded region.
            default: return 1.0f;
        }
    }

    // Clears the shaping state that survives between blocks. Crush's hold
    // register and Fuzz's lowpass pole are the only two; the tone filters,
    // DC blockers and oversampler own their own reset paths.
    void resetShaperState() noexcept
    {
        for (int i = 0; i < kMaxStateChannels; ++i)
        {
            crushHoldValue_[i]   = 0.0f;
            crushHoldCounter_[i] = 0;
            fuzzLpState_[i]      = 0.0f;
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
                Nar{0.0f,       6.0f,  1.0f, 1.0f  },   0.0f, ""),
            std::make_unique<Apf>(Pid{"drive",       1}, "Drive",
                Nar{0.0f,      48.0f,  0.0f, 0.5f  },  12.0f, "dB"),
            std::make_unique<Apf>(Pid{"tone",        1}, "Tone",
                Nar{20.0f,  20000.0f,  0.0f, 0.23f }, 8000.0f, "Hz"),
            std::make_unique<Apf>(Pid{"filter_pos",  1}, "Filter Position",
                Nar{0.0f,       1.0f,  1.0f, 1.0f  },   1.0f, ""),
            std::make_unique<Apf>(Pid{"mix",         1}, "Mix",
                Nar{0.0f,     100.0f,  0.0f, 1.0f  }, 100.0f, "%"),

            // ── Mode-specific params ────────────────────────────────────────
            // Every default below is the transparent value for its mode, which
            // is what makes the expansion append-only: a stored session that
            // predates these params gets the defaults and renders unchanged.
            std::make_unique<Apf>(Pid{"symmetry",    1}, "Symmetry",
                Nar{0.0f,     100.0f,  0.0f, 1.0f  }, 100.0f, "%"),
            std::make_unique<Apf>(Pid{"bits",        1}, "Bits",
                Nar{2.0f,      16.0f,  0.0f, 1.0f  },  16.0f, ""),
            std::make_unique<Apf>(Pid{"downsample",  1}, "Downsample",
                Nar{1.0f,      40.0f,  0.0f, 1.0f  },   1.0f, "x"),
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

    // ── Smoother handles for the mode-specific params ────────────────────────
    SmoothedHandle symmetrySmoother_;
    SmoothedHandle bitsSmoother_;
    SmoothedHandle downsampleSmoother_;

    // ── State ─────────────────────────────────────────────────────────────────
    double sampleRate_      = 44100.0;
    double oversampledRate_ = 176400.0;
    int    prevFilterPos_   = 1;
    int    prevMode_        = 0;

    // Fuzz tone stack: fixed one-pole LP after the brick wall. 5 kHz sits in the
    // middle of the 4–6 kHz vintage-fuzz window and, being only 6 dB/oct, still
    // leaves the tone knob (20 Hz–20 kHz, 2nd-order) an audible sweep on top of
    // it rather than burying it.
    static constexpr float kFuzzLowpassHz = 5000.0f;
    float fuzzLpCoeff_ = 0.0f; // set in prepareEffect from oversampledRate_

    // Per-channel shaper state (stereo; index clamped for wider layouts).
    static constexpr int kMaxStateChannels = 2;
    float crushHoldValue_  [kMaxStateChannels] {};
    int   crushHoldCounter_[kMaxStateChannels] {};
    float fuzzLpState_     [kMaxStateChannels] {};
};
