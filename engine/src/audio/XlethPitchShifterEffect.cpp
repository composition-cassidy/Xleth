#include "audio/XlethPitchShifterEffect.h"

#include <algorithm>
#include <cmath>

using Mode = XlethPitchShifterEffect::Mode;

namespace {

// Combined pitch limit shared by both modules.
constexpr double kMaxSemitones = xleth::dsp::GranularShifter::kMaxSemitones;   // 24
constexpr int    kMaxCents     = static_cast<int>(kMaxSemitones * 100.0);      // 2400

// Half a cent's worth of formant knob. Inside this band the knob is treated as
// neutral and routed to Rubber Band's automatic sentinel — see the long note in
// pushSmoothedParams for why that specific value is the one PDC depends on.
constexpr float kFormantNeutralEpsilon = 1.0e-4f;

// Both modules' setPitch() take (semitones, cents) and internally evaluate
// `semitones + cents/100`, clamping the SUM to +/-24 st. Handing the whole
// smoothed pitch over as cents therefore covers the full range at 1-cent
// resolution (0.058%), without quantising the semitone smoother to whole
// semitones — which is what passing a rounded `semitones` would do.
inline int totalCentsFrom(float semitones, float cents) noexcept
{
    const double total = static_cast<double>(semitones) * 100.0
                       + static_cast<double>(cents);
    return static_cast<int>(std::lround(std::clamp(total,
                                                   -static_cast<double>(kMaxCents),
                                                    static_cast<double>(kMaxCents))));
}

} // namespace

// ─── Construction ───────────────────────────────────────────────────────────

XlethPitchShifterEffect::XlethPitchShifterEffect()
    : XlethEffectBase("pitchshifter", createLayout())
{
    // See the smoothing note in the header for why Linear, and only Linear, is
    // usable for the two signed pitch parameters.
    registerSmoothedParam("semitones", SmoothType::Linear, kPitchRampMs);
    registerSmoothedParam("cents",     SmoothType::Linear, kPitchRampMs);
    registerSmoothedParam("size",      SmoothType::Linear, kSizeRampMs);
    registerSmoothedParam("formant",   SmoothType::Linear, kFormantRampMs);
    registerSmoothedParam("mix",       SmoothType::Linear, kMixRampMs);

    // Window and channel options are baked into RubberBandLiveShifter's
    // constructor, so they are set here — before any prepare() — and never
    // touched again. Nothing below this point reconstructs a shifter.
    liveSmart_.setWindowOption(xleth::dsp::LiveShifterWrapper::Window::Medium);
    liveSmart_.setChannelsTogether(true);
    liveSmart_.setFormantOption(xleth::dsp::LiveShifterWrapper::Formant::Shifted);

    liveVoice_.setWindowOption(xleth::dsp::LiveShifterWrapper::Window::Short);
    liveVoice_.setChannelsTogether(true);
    liveVoice_.setFormantOption(xleth::dsp::LiveShifterWrapper::Formant::Preserved);
}

// ─── Parameter layout ───────────────────────────────────────────────────────

juce::AudioProcessorValueTreeState::ParameterLayout
XlethPitchShifterEffect::createLayout()
{
    using Apf  = juce::AudioParameterFloat;
    using Apb  = juce::AudioParameterBool;
    using Apc  = juce::AudioParameterChoice;
    using Pid  = juce::ParameterID;
    using Nar  = juce::NormalisableRange<float>;
    using AfA  = juce::AudioParameterFloatAttributes;
    using AbA  = juce::AudioParameterBoolAttributes;
    using AcA  = juce::AudioParameterChoiceAttributes;

    return {
        // ── Mode ────────────────────────────────────────────────────────────
        // withAutomatable(false) is load-bearing, not cosmetic: mode is the one
        // parameter that moves this effect's latency, and a non-automatable
        // parameter can only ever be written from the message thread, where
        // re-reporting PDC is legal. See the latency note in the header.
        std::make_unique<Apc>(
            Pid{"mode", 1}, "Mode",
            juce::StringArray{"Granular", "Smart", "Voice", "Clip"},
            static_cast<int>(Mode::Granular),
            AcA{}.withAutomatable(false)),

        // ── Realtime parameters (modes 1-3) ─────────────────────────────────
        std::make_unique<Apf>(Pid{"mix", 1}, "Mix",
            Nar{0.0f, 1.0f, 0.0f, 1.0f}, 1.0f,
            AfA{}.withLabel("")),

        std::make_unique<Apf>(Pid{"semitones", 1}, "Semitones",
            Nar{-24.0f, 24.0f, 0.0f, 1.0f}, 0.0f,
            AfA{}.withLabel("st")),

        std::make_unique<Apf>(Pid{"cents", 1}, "Cents",
            Nar{-100.0f, 100.0f, 0.0f, 1.0f}, 0.0f,
            AfA{}.withLabel("ct")),

        // Granular only. Inert in Smart/Voice/Clip; the panel hides it there.
        std::make_unique<Apf>(Pid{"size", 1}, "Grain Size",
            Nar{static_cast<float>(xleth::dsp::GranularShifter::kMinGrainMs),
                static_cast<float>(xleth::dsp::GranularShifter::kMaxGrainMs),
                0.0f, 1.0f},
            50.0f, AfA{}.withLabel("ms")),

        // Smart/Voice only. A granular shifter resamples whole grains, so the
        // spectral envelope moves with the pitch by construction and there is
        // nothing here to drive — see the "deliberately NO formant control"
        // note in GranularShifter.h. No per-mode stub is needed: the parameter
        // simply goes unread in Granular.
        std::make_unique<Apf>(Pid{"formant", 1}, "Formant",
            Nar{0.5f, 2.0f, 0.0f, 1.0f}, 1.0f,
            AfA{}.withLabel("x")),

        // ── Clip mode parameters — INERT THIS PROMPT ────────────────────────
        // Declared now so that landing the Clip DSP later changes neither the
        // serialized parameter set nor the panel's parameter list. All four are
        // withAutomatable(false): Clip is an offline, clip-anchored render, so
        // none of them is meaningful on an automation lane.
        std::make_unique<Apf>(Pid{"clip_semitones", 1}, "Clip Semitones",
            Nar{-24.0f, 24.0f, 0.0f, 1.0f}, 0.0f,
            AfA{}.withLabel("st").withAutomatable(false)),

        std::make_unique<Apf>(Pid{"clip_cents", 1}, "Clip Cents",
            Nar{-100.0f, 100.0f, 0.0f, 1.0f}, 0.0f,
            AfA{}.withLabel("ct").withAutomatable(false)),

        // The five LIVE StretchMethod engines, in StretchMethod order minus the
        // Global sentinel: PSOLA=1, Rubber=2, WSOLA=3, PhaseVocoder=4, WORLD=5
        // (model/TimelineTypes.h). Global (0) stays reserved as the internal
        // "no transform" value and is deliberately not offered here, so choice
        // index i maps to StretchMethod(i + 1).
        std::make_unique<Apc>(
            Pid{"clip_method", 1}, "Clip Method",
            juce::StringArray{"PSOLA", "Rubber", "WSOLA", "PhaseVocoder", "WORLD"},
            1,  // Rubber — the polyphonic-safe default
            AcA{}.withAutomatable(false)),

        std::make_unique<Apb>(Pid{"clip_formant", 1}, "Clip Formant",
            false, AbA{}.withAutomatable(false)),
    };
}

// ─── Mode / latency ─────────────────────────────────────────────────────────

Mode XlethPitchShifterEffect::readModeRaw() const noexcept
{
    if (modePtr_ == nullptr) return Mode::Granular;
    const int v = static_cast<int>(modePtr_->load(std::memory_order_relaxed));
    return static_cast<Mode>(std::clamp(v, 0, kNumModes - 1));
}

Mode XlethPitchShifterEffect::getMode() const noexcept
{
    if (auto* raw = apvts_.getRawParameterValue("mode"))
        return static_cast<Mode>(
            std::clamp(static_cast<int>(raw->load(std::memory_order_relaxed)),
                       0, kNumModes - 1));
    return Mode::Granular;
}

int XlethPitchShifterEffect::computeLatencyForMode(Mode m) const noexcept
{
    if (sampleRate_ <= 0.0) return 0;

    switch (m)
    {
        case Mode::Granular:
            // Spec: the max of the two module families at the current rate.
            // At every rate this engine actually runs at, the granular figure
            // (2 x 100 ms = 0.2 * sr) is the larger of the two, so this
            // resolves to the granular module's own latency and the measured
            // impulse delay matches the report exactly. The conformance test
            // asserts that equality rather than assuming it.
            return std::max({ granular_.getLatencySamples(),
                              liveSmart_.getLatencySamples(),
                              liveVoice_.getLatencySamples() });

        case Mode::Smart:  return liveSmart_.getLatencySamples();
        case Mode::Voice:  return liveVoice_.getLatencySamples();
        case Mode::Clip:   return 0;   // pure pass-through
    }
    return 0;
}

bool XlethPitchShifterEffect::refreshLatencySamples()
{
    const int wanted = computeLatencyForMode(getMode());
    if (wanted == AudioProcessor::getLatencySamples())
        return false;

    setLatencySamples(wanted);
    latencyUpdateCount_.fetch_add(1, std::memory_order_acq_rel);
    return true;
}

void XlethPitchShifterEffect::onParameterValueChanged(const std::string& paramId,
                                                      float /*value*/)
{
    // `mode` is the ONLY latency-affecting parameter, and it is
    // withAutomatable(false), so this can only ever run on the message thread.
    // Nothing here is reachable from the audio thread or the automation write
    // path — which is exactly the invariant that keeps PDC correct.
    if (paramId == "mode")
        refreshLatencySamples();

    // The one and only writer of sourceTransformEpoch_. Every parameter
    // provideSourceTransform reads is listed; anything else (the realtime
    // modes' knobs, mix) leaves the Clip render identity alone.
    if (paramId == "mode"
        || paramId == "clip_semitones" || paramId == "clip_cents"
        || paramId == "clip_method"    || paramId == "clip_formant")
    {
        sourceTransformEpoch_.fetch_add(1, std::memory_order_acq_rel);
    }
}

// ─── Source transform (Clip mode) ───────────────────────────────────────────

bool XlethPitchShifterEffect::provideSourceTransform(xleth::SourceTransform& out) const
{
    const auto readInt = [this](const char* id) noexcept
    {
        const auto* raw = apvts_.getRawParameterValue(id);
        return raw != nullptr
            ? static_cast<int>(std::lround(raw->load(std::memory_order_relaxed)))
            : 0;
    };

    out = xleth::SourceTransform{};
    out.semis   = std::clamp(readInt("clip_semitones"), -24, 24);
    out.cents   = std::clamp(readInt("clip_cents"), -100, 100);
    // Choice index 0..4 -> StretchMethod 1..5. Global (0) is never produced.
    out.method  = std::clamp(readInt("clip_method"), 0, 4) + 1;
    out.formant = readInt("clip_formant") != 0;
    out.active  = xleth::isSourceTransformActive(getMode() == Mode::Clip,
                                                 out.semis, out.cents, out.formant);
    return out.active;
}

void XlethPitchShifterEffect::setStateInformation(const void* data, int sizeInBytes)
{
    XlethEffectBase::setStateInformation(data, sizeInBytes);

    // replaceState() moved every parameter without a single
    // onParameterValueChanged call. Re-enter it for `mode` (message thread —
    // state restore is never an audio-thread operation): that re-reports the
    // restored mode's latency and advances the source-transform epoch through
    // its one sanctioned writer, which covers the clip_* values restored
    // alongside it.
    if (const auto* raw = apvts_.getRawParameterValue("mode"))
        onParameterValueChanged("mode", raw->load(std::memory_order_relaxed));
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

void XlethPitchShifterEffect::prepareEffect(double sampleRate, int maxBlockSize)
{
    sampleRate_   = sampleRate;
    maxBlockSize_ = maxBlockSize;

    modePtr_ = apvts_.getRawParameterValue("mode");

    // All three modules are prepared unconditionally, so a later mode switch
    // never has to allocate or rebuild. This is the message thread with the
    // graph suspended, which is the only place either prepare() is legal.
    granular_.prepare(sampleRate, 2, maxBlockSize);
    liveSmart_.prepare(sampleRate, 2, maxBlockSize);
    liveVoice_.prepare(sampleRate, 2, maxBlockSize);

    // Seed the granular grain size from the stored parameter so the first block
    // is not stuck on the module default.
    if (auto* sizeRaw = apvts_.getRawParameterValue("size"))
        granular_.setGrainSizeMs(static_cast<double>(
            sizeRaw->load(std::memory_order_relaxed)));

    // Handles are resolved AFTER the base class's prepareToPlay has run
    // initSmoothers() (it calls prepareEffect last), so every entry already has
    // its raw pointer and its ramp.
    hSemitones_ = resolveSmoothed("semitones");
    hCents_     = resolveSmoothed("cents");
    hSize_      = resolveSmoothed("size");
    hFormant_   = resolveSmoothed("formant");
    hMix_       = resolveSmoothed("mix");

    // The dry line has to span the deepest latency any mode can select, since
    // a mode switch re-programs the depth without re-preparing the line.
    int deepest = 0;
    for (int m = 0; m < kNumModes; ++m)
        deepest = std::max(deepest, computeLatencyForMode(static_cast<Mode>(m)));

    dryDelay_.setMaximumDelayInSamples(std::max(1, deepest + 8));
    {
        juce::dsp::ProcessSpec spec;
        spec.sampleRate       = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(std::max(1, maxBlockSize));
        spec.numChannels      = 2;
        dryDelay_.prepare(spec);
        dryDelay_.reset();
    }

    lastAudioMode_   = getMode();
    dryDelaySamples_ = computeLatencyForMode(lastAudioMode_);
    dryDelay_.setDelay(static_cast<float>(dryDelaySamples_));

    alignedDryBuf_.setSize(2, std::max(1, maxBlockSize), false, true, true);
    alignedDryBuf_.clear();

    refreshLatencySamples();
}

void XlethPitchShifterEffect::releaseEffect()
{
    alignedDryBuf_.setSize(0, 0);
}

void XlethPitchShifterEffect::primeDeferredReset()
{
    // Each call is a no-op when that spare is already primed. In steady state
    // only the active mode's wrapper consumed its spare at the last reset, so
    // that is the only one that pays; an inactive one re-primes only after a
    // mode switch has swapped its spare in.
    liveSmart_.primeSpare();
    liveVoice_.primeSpare();
}

bool XlethPitchShifterEffect::resetOnAudioThread() noexcept
{
    // Only the audio thread consumes a spare (reset/process); the worker only
    // ever primes one. So a spare seen ready here is still ready in reset().
    const Mode mode = readModeRaw();
    if ((mode == Mode::Smart && ! liveSmart_.isSpareReady())
        || (mode == Mode::Voice && ! liveVoice_.isSpareReady()))
        return false;

    resetBypassRamp();
    resetForMode(mode);
    return true;
}

void XlethPitchShifterEffect::resetEffect()
{
    resetForMode(readModeRaw());
}

void XlethPitchShifterEffect::resetForMode(Mode mode)
{
    granular_.reset();
    dryDelay_.reset();
    alignedDryBuf_.clear();

    // The running live wrapper resets now: a swap to its primed spare when
    // primeDeferredReset() ran first, otherwise the vendored shifter's reset()
    // plus inline priming, which is NOT realtime safe. Only the swap may run
    // on the audio thread - resetOnAudioThread() declines otherwise - and
    // neither may migrate into processEffect().
    //
    // The other wrapper is not running, so it resets lazily: markStale() makes
    // its next process() swap in its own spare (realtime safe). If the mode
    // changes between here and the next block, whichever wrapper ends up
    // running is still reset - one now, the other on first use.
    if (mode == Mode::Smart) liveSmart_.reset(); else liveSmart_.markStale();
    if (mode == Mode::Voice) liveVoice_.reset(); else liveVoice_.markStale();
}

bool XlethPitchShifterEffect::copyLatencyAlignedBypassDry(juce::AudioBuffer<float>& dest,
                                                          int numSamples)
{
    const int n  = std::min(numSamples, alignedDryBuf_.getNumSamples());
    const int ch = std::min(dest.getNumChannels(), alignedDryBuf_.getNumChannels());
    if (n <= 0 || ch <= 0) return false;
    for (int c = 0; c < ch; ++c)
        dest.copyFrom(c, 0, alignedDryBuf_, c, 0, n);
    return true;
}

// ─── Audio thread ───────────────────────────────────────────────────────────

void XlethPitchShifterEffect::pushSmoothedParams(Mode mode, int numSamples) noexcept
{
    // Advance first, then read: the value handed to the module is the one the
    // ramp reaches at the END of this block, so a ramp of kPitchRampMs settles
    // exactly on the commanded pitch rather than one block short of it.
    hSemitones_.skip(numSamples);
    hCents_.skip(numSamples);
    hSize_.skip(numSamples);
    hFormant_.skip(numSamples);

    const int cents = totalCentsFrom(hSemitones_.current(), hCents_.current());

    switch (mode)
    {
        case Mode::Granular:
            granular_.setPitch(0, cents);
            granular_.setGrainSizeMs(static_cast<double>(hSize_.current()));
            break;

        case Mode::Smart:
        case Mode::Voice:
        {
            auto& live = (mode == Mode::Smart) ? liveSmart_ : liveVoice_;
            live.setPitch(0, cents);

            // The knob is a MULTIPLIER on top of whatever the mode's formant
            // option would do automatically, so that the control is continuous
            // and 1.0 reproduces each mode's natural behaviour:
            //
            //   Smart (Formant::Shifted)   automatic scale 1.0
            //                              -> knob is the scale directly.
            //   Voice (Formant::Preserved) automatic scale 1/pitchScale
            //                              -> knob / pitchScale, so 1.0 still
            //                                 preserves formants rather than
            //                                 dragging them along with the
            //                                 pitch (which would silently turn
            //                                 Voice back into Smart).
            //
            // AT EXACTLY NEUTRAL the knob hands over 0.0 — Rubber Band's
            // "automatic" sentinel — instead of the arithmetically equal
            // explicit scale, and this is load-bearing for PDC, not a
            // shortcut. LiveShifterWrapper::measureDelayAtRatio calibrates the
            // delay curve by moving setPitchScale() ONLY; it never touches the
            // formant scale, so the whole curve describes a shifter running
            // with formants on automatic. Forcing an explicit scale engages a
            // resampler the calibration never measured and walks the real delay
            // away from the reported one — measured here at 964 samples (Smart)
            // and 1625 (Voice) across a +/-24 st sweep, against 38 and 95 once
            // neutral routes to the sentinel. Off neutral the user has asked
            // for an explicit formant move and the (bounded) deviation is the
            // price; at the default, which is where automation sweeps live,
            // the calibrated path is exact.
            //
            // The two branches agree in the limit — automatic IS 1/pitchScale
            // under Preserved and 1.0 under Shifted — so the control has no
            // discontinuity at the switchover. Rubber Band clamps a non-zero
            // scale to [0.25, 4.0], which only bites at the extreme corners
            // (knob 2.0 against a -24 st shift).
            const float  knob  = hFormant_.current();
            const double ratio = std::pow(2.0, (cents / 100.0) / 12.0);
            const double base  = (mode == Mode::Voice) ? (1.0 / ratio) : 1.0;
            live.setFormantScale(std::abs(knob - 1.0f) <= kFormantNeutralEpsilon
                                     ? 0.0f
                                     : static_cast<float>(static_cast<double>(knob) * base));
            break;
        }

        case Mode::Clip:
            break;   // nothing to drive
    }
}

void XlethPitchShifterEffect::applyMix(juce::AudioBuffer<float>& buffer,
                                       int numSamples) noexcept
{
    const int ch = std::min(buffer.getNumChannels(), alignedDryBuf_.getNumChannels());

    for (int s = 0; s < numSamples; ++s)
    {
        const float mix = std::clamp(hMix_.next(), 0.0f, 1.0f);
        for (int c = 0; c < ch; ++c)
        {
            const float wet = buffer.getSample(c, s);
            const float dry = alignedDryBuf_.getSample(c, s);
            buffer.setSample(c, s, dry * (1.0f - mix) + wet * mix);
        }
    }
}

void XlethPitchShifterEffect::processEffect(juce::AudioBuffer<float>& buffer,
                                            juce::MidiBuffer& /*midi*/)
{
    const int numSamples = buffer.getNumSamples();
    const int numCh      = buffer.getNumChannels();
    if (numSamples <= 0 || numCh <= 0) return;

    const Mode mode = readModeRaw();

    // ── Mode 4: sample-exact pass-through, zero added latency ───────────────
    // The buffer is processed in place, so "copy in to out" is the identity —
    // touching nothing is what makes it bit-exact. The smoothers are still
    // advanced so their ramp positions stay correct for a later mode switch,
    // and the aligned-dry buffer is fed the UNDELAYED input so that a bypass
    // crossfade in Clip mode nulls too.
    if (mode == Mode::Clip)
    {
        hSemitones_.skip(numSamples);
        hCents_.skip(numSamples);
        hSize_.skip(numSamples);
        hFormant_.skip(numSamples);
        hMix_.skip(numSamples);

        const int dryCh = std::min(numCh, alignedDryBuf_.getNumChannels());
        for (int c = 0; c < dryCh; ++c)
            alignedDryBuf_.copyFrom(c, 0, buffer, c, 0, numSamples);

        lastAudioMode_ = mode;
        return;
    }

    // ── Dry alignment ───────────────────────────────────────────────────────
    // Re-program the delay only when the mode actually changed. setDelay() on a
    // None-interpolation line is a store plus an assert — no allocation — so it
    // is safe here, but doing it every block would be pointless work.
    if (mode != lastAudioMode_ || dryDelaySamples_ < 0)
    {
        const int wanted = std::min(computeLatencyForMode(mode),
                                    dryDelay_.getMaximumDelayInSamples());
        dryDelaySamples_ = wanted;
        dryDelay_.setDelay(static_cast<float>(wanted));
        lastAudioMode_   = mode;
    }

    const int dryCh = std::min(numCh, alignedDryBuf_.getNumChannels());
    for (int c = 0; c < dryCh; ++c)
    {
        const float* in  = buffer.getReadPointer(c);
        float*       out = alignedDryBuf_.getWritePointer(c);
        for (int s = 0; s < numSamples; ++s)
        {
            dryDelay_.pushSample(c, in[s]);
            out[s] = dryDelay_.popSample(c);
        }
    }

    // ── Parameters, then the wet path ───────────────────────────────────────
    pushSmoothedParams(mode, numSamples);

    switch (mode)
    {
        case Mode::Granular: granular_.process(buffer);  break;
        case Mode::Smart:    liveSmart_.process(buffer); break;
        case Mode::Voice:    liveVoice_.process(buffer); break;
        case Mode::Clip:     break;   // handled above
    }

    applyMix(buffer, numSamples);
}
