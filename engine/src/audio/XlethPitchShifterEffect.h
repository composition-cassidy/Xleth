#pragma once

#include "audio/XlethEffectBase.h"
#include "dsp/GranularShifter.h"
#include "dsp/LiveShifterWrapper.h"

#include <juce_dsp/juce_dsp.h>

#include <atomic>
#include <string>

// ─── XlethPitchShifterEffect ────────────────────────────────────────────────
//
// Stock realtime pitch shifter, plugin id "pitchshifter". Duration preserving
// in every mode: this is a pitch control, not a time stretcher.
//
// Four modes, three DSP paths:
//
//   Granular  dsp::GranularShifter          — 2-stream Hann granular, grain
//                                             size exposed as a knob.
//   Smart     dsp::LiveShifterWrapper       — RubberBandLiveShifter,
//                                             Window::Medium + Formant::Shifted.
//   Voice     dsp::LiveShifterWrapper       — the same wrapper built
//                                             Window::Short + Formant::Preserved.
//   Clip      (none)                        — sample-exact pass-through.
//
// Clip is the offline, clip-anchored path. Its machinery lands in a later
// prompt; here it exists as a mode value and a set of inert `clip_*`
// parameters so that adding the DSP later changes no serialization and forces
// no panel rebuild. Until then it is a bit-transparent pass-through that adds
// exactly zero latency.
//
// --- WHY TWO LiveShifterWrapper INSTANCES ----------------------------------
//
// Smart and Voice differ in their WINDOW option, and
// LiveShifterWrapper::setWindowOption() is documented prepare/message-thread
// only because it reconstructs the underlying shifter (the window and channel
// options are fixed at RubberBandLiveShifter's constructor). Serving both
// modes from a single wrapper would therefore mean either
//
//   (a) rebuilding — allocating, and racing a process() that may already be
//       running on that wrapper, since the APVTS mode value changes before
//       onParameterValueChanged is invoked; or
//   (b) dropping Window::Short from Voice, which is most of what makes Voice
//       a distinct mode.
//
// Neither is acceptable, so both wrappers are constructed once and prepared
// together in prepareEffect() (message thread, graph suspended). A mode switch
// then only moves an index: no allocation, no rebuild, no race. The cost is a
// second delay calibration, and LiveShifterWrapper caches that per
// (sample rate, channels, options), so the two configurations occupy two cache
// entries and never evict each other.
//
// --- PARAMETER SMOOTHING (hard requirement, not polish) ---------------------
//
// `semitones` and `cents` are both routed through the base class's smoothing
// machinery, registered as SmoothType::Linear.
//
// The choice is forced, and then justified:
//
//   Multiplicative is DISQUALIFIED outright. SmoothedEntry::setTarget clamps a
//   multiplicative target with std::max(target, 1e-6f) — the smoother is built
//   for strictly positive quantities like gain. Both of these parameters are
//   signed and cross zero (semitones +/-24, cents +/-100), so every negative
//   value would be silently clamped to ~0. A downward shift would simply stop
//   working.
//
//   OnePole is an exponential approach that never exactly arrives, so the
//   commanded pitch would carry a decaying-but-permanent offset. For a
//   parameter whose whole job is to land on an exact musical interval, an
//   asymptote is the wrong shape.
//
//   Linear reaches the target exactly, in a bounded time, with a bounded
//   per-block step — which is precisely the property that matters here. P1
//   measured RubberBandLiveShifter's pipeline to be PATH DEPENDENT: an
//   unsmoothed instantaneous +/-24 st leap settles up to 421 samples away from
//   the calibrated delay, against 30 samples for a stream that walks there.
//   Linear smoothing turns every leap into a walk, which is what collapses
//   that residual. See LiveShifterWrapper.h finding (c).
//
// The ramp is deliberately long (kPitchRampMs). A Linear smoother traverses
// any distance in the same time, so the ramp has to be chosen against the
// worst case — a full 48-semitone leap — rather than against a typical knob
// tweak. The measured residual at this setting is reported by
// test_pitch_shifter_effect section [2].
//
// Both shifters latch pitch internally (the granular path per grain launch,
// the live path between whole shift() calls), so the smoothed value is pushed
// once per block rather than per sample. Per-sample pushes would be discarded
// by both modules anyway.
//
// --- LATENCY / PDC ---------------------------------------------------------
//
// prepareEffect() reports the ACTIVE mode's latency. A mode change recomputes
// and re-reports from onParameterValueChanged, which is safe because `mode` is
// withAutomatable(false) and therefore only ever reaches us on the message
// thread. Latency is NEVER re-reported from the audio thread or from the
// automation write path — see the hazard note at XlethEffectBase.h:250-262.
//
// Every latency-affecting quantity underneath is pitch- and size-invariant by
// construction (both P1 modules guarantee this), so within a mode the reported
// figure never moves. Mode is the only thing that can change it, and mode
// cannot be automated. That closes the PDC-desync hazard completely.
//
// --- Realtime contract ------------------------------------------------------
//
// processEffect() allocates nothing, locks nothing, logs nothing, in all four
// modes. Verified by a counting allocator in test_pitch_shifter_effect [4].
//
class XlethPitchShifterEffect : public XlethEffectBase
{
public:
    // Order is the APVTS choice order and is serialized — append only.
    enum class Mode { Granular = 0, Smart = 1, Voice = 2, Clip = 3 };
    static constexpr int kNumModes = 4;

    // Linear ramp for the two pitch parameters. See the smoothing note above
    // for why Linear, and why the ramp is sized against a full-scale leap.
    static constexpr float kPitchRampMs   = 120.0f;
    static constexpr float kSizeRampMs    = 30.0f;
    static constexpr float kFormantRampMs = 30.0f;
    static constexpr float kMixRampMs     = 20.0f;

    XlethPitchShifterEffect();

    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout();

    // ── Test / introspection surface (main thread) ──────────────────────────

    // The mode currently selected in the APVTS.
    Mode getMode() const noexcept;

    // Latency this effect would report in `m`, at the prepared sample rate.
    // Returns 0 before prepareEffect() has run.
    int computeLatencyForMode(Mode m) const noexcept;

    // Number of times setLatencySamples() has actually been called with a NEW
    // value since construction. The mode-switch PDC test asserts this advances
    // exactly once per mode change.
    int getLatencyUpdateCount() const noexcept
    {
        return latencyUpdateCount_.load(std::memory_order_acquire);
    }

    // Underlying modules, for the conformance tests only.
    const xleth::dsp::GranularShifter&    getGranularShifter() const noexcept { return granular_; }
    const xleth::dsp::LiveShifterWrapper& getSmartShifter()    const noexcept { return liveSmart_; }
    const xleth::dsp::LiveShifterWrapper& getVoiceShifter()    const noexcept { return liveVoice_; }

protected:
    void prepareEffect(double sampleRate, int maxBlockSize) override;
    void releaseEffect() override;
    void resetEffect() override;
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;
    void onParameterValueChanged(const std::string& paramId, float value) override;

    // A 200 ms wet path cannot be bypass-crossfaded against an undelayed dry —
    // the base class would blend two different moments in time. Hand it the
    // latency-aligned dry instead, exactly as the amp does.
    bool usesLatencyAlignedBypassDry() const override { return true; }
    bool copyLatencyAlignedBypassDry(juce::AudioBuffer<float>& dest, int numSamples) override;

private:
    // Recompute and re-report. Returns true iff the reported value changed.
    // MESSAGE THREAD ONLY.
    bool refreshLatencySamples();

    // Read `mode` from its raw APVTS atomic and clamp into the enum.
    // Audio-thread safe (a relaxed load plus a clamp).
    Mode readModeRaw() const noexcept;

    // Push this block's smoothed parameter values into the active module and
    // advance the smoothers by `numSamples`. Audio thread; no allocation.
    void pushSmoothedParams(Mode mode, int numSamples) noexcept;

    // Blend the latency-aligned dry back in at `mix`. Audio thread.
    void applyMix(juce::AudioBuffer<float>& buffer, int numSamples) noexcept;

    // ── DSP modules ─────────────────────────────────────────────────────────
    xleth::dsp::GranularShifter    granular_;
    xleth::dsp::LiveShifterWrapper liveSmart_;   // Window::Medium, Formant::Shifted
    xleth::dsp::LiveShifterWrapper liveVoice_;   // Window::Short,  Formant::Preserved

    // ── Prepared state ──────────────────────────────────────────────────────
    double sampleRate_   = 0.0;
    int    maxBlockSize_ = 0;

    // ── Raw APVTS pointers (resolved in prepareEffect) ──────────────────────
    std::atomic<float>* modePtr_ = nullptr;

    // ── Smoother handles (resolved in prepareEffect) ────────────────────────
    SmoothedHandle hSemitones_;
    SmoothedHandle hCents_;
    SmoothedHandle hSize_;
    SmoothedHandle hFormant_;
    SmoothedHandle hMix_;

    // ── Dry alignment ───────────────────────────────────────────────────────
    // The dry that `mix` blends against, and that the base class's bypass
    // crossfade reads, must be delayed by the active mode's latency or the two
    // sides of the blend are from different moments and comb-filter.
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None> dryDelay_{ 4096 };
    juce::AudioBuffer<float> alignedDryBuf_;
    int dryDelaySamples_ = -1;   // depth currently programmed into dryDelay_

    // Mode observed on the audio thread last block, so the dry delay is only
    // re-programmed when it actually changes.
    Mode lastAudioMode_ = Mode::Granular;

    std::atomic<int> latencyUpdateCount_ { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(XlethPitchShifterEffect)
};
