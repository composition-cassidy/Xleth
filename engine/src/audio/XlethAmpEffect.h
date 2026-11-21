#pragma once

#include "audio/XlethEffectBase.h"
#include "audio/XlethAmpCabinetIR.h"

#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>

// ─── XlethAmpEffect ─────────────────────────────────────────────────────────
// "Amp Stack" — XLETH's stock guitar amp effect.
// Spec: docs/amp spec.docx (design locked 2026-09-06).  Where this file and the
// spec disagree, the spec wins and this file is what gets fixed.
//
// pluginId: "amp"     UI display name: "Amp Stack"
//
// ── Signal chain (spec §3) ──────────────────────────────────────────────────
//
//   Input → mono sum
//     → Gate (downward expander)                              base rate
//     ┌──────────── 4× oversampled region ────────────┐
//     → Tighten (pre-filter)                                  4× rate
//     → Drive (waveshaper cascade)                            4× rate
//     → Tone stack (interactive Bass / Mid / Treble)          4× rate
//     → Power stage (saturation + envelope-following sag)     4× rate
//     └───────────────────────────────────────────────┘
//     → Presence (high shelf)                                 base rate
//     → Cabinet IR (juce::dsp::Convolution)                   base rate
//     → Mix (latency-compensated dry / wet) → Output gain     base rate
//
// The oversampled region wraps Tighten → Drive → Tone stack → Power stage as
// one block, exactly as the spec requires, and EVERY filter coefficient inside
// it is designed at `oversampledRate_`, never at the engine rate.
//
// ── What it took to pass the §10.1 aliasing sweep at 4× ─────────────────────
// Spec §9 fixes the oversampling factor at 4×, so the only remaining lever on
// fold-back is how much high-order harmonic energy the nonlinearities make in
// the first place.  Once a harmonic has folded inside the oversampled region no
// later filter can remove it.  Three things get the measured fold-back from
// worse-than-the-fundamental to ~72 dB below the input signal, and all three
// are things a real amp does anyway:
//
//   1. A fixed 4th-order input-bandwidth low-pass ahead of the drive
//      (AmpVoicing::preLpHz).  No guitar amp ever passed 15 kHz to its
//      clipping stages, and neither does this one.
//   2. A drive CASCADE rather than one shaper (kDriveStages), with an
//      interstage pole.  Fifty dB into a single clipper is a square wave;
//      split across three stages nothing is driven more than ~17 dB.
//   3. First-order antiderivative anti-aliasing on the hard-clamp curve only
//      (hardClampAdaa), which is where the last ~20 dB came from.
//
// The numbers behind each of those live in engine/test/test_amp.cpp, which
// prints the full per-model, per-frequency table on every run.
//
// ── Why FIR equiripple half-band and not the IIR one ────────────────────────
// juce::dsp::Oversampling offers two polyphase half-band designs.  This effect
// uses filterHalfBandFIREquiripple with useIntegerLatency = true because:
//   • it is linear phase, so the dry Mix path can be aligned by a plain integer
//     delay and the bypass null (spec §10.2) comes out sample-exact rather than
//     "close enough";
//   • it matches XlethDistortionEffect / XlethWaveshaperEffect, so all three
//     stock nonlinear effects report latency the same way.
// The IIR variant is cheaper but its fractional, frequency-dependent group
// delay makes an exact null impossible.  If CPU ever forces the switch, the
// latency compensation below has to become fractional first.
//
// ── Engine constraints honoured (spec §9) ───────────────────────────────────
//   • No allocation, no locks, no logging on the audio callback.  Every buffer
//     — oversampler, all four convolvers, gate envelope, delay lines — is
//     allocated in prepareEffect().  Changing cabinet on the audio thread only
//     switches which pre-loaded convolver runs; it never loads an IR.
//   • The engine sample rate is READ from prepareToPlay and everything derives
//     from it.  There is no 44.1/48 kHz constant anywhere in this file.
//   • Six amp models are DATA ROWS in kAmpVoicings.  Adding a model is a data
//     edit plus a tuning pass, never a DSP code change.
//   • Latency (oversampling + convolution) is MEASURED at prepare time from
//     getLatencyInSamples() / getLatency(), never assumed.
//   • Mono in.  The chain runs mono; the cab stage currently duplicates to
//     stereo (spec §9 says it *may* widen — widening is deferred with dual-cab
//     blending in §11).
//   • Processing is skipped when bypassed or when Mix == 0 (only the dry delay
//     line keeps running, so reported latency stays truthful in both states).
//
// ── Two deliberate deviations from the spec's parameter table (§7) ──────────
//  1. "Cab: selector, 4 IRs, default per model."  APVTS defaults are static, so
//     "per model" needs somewhere to live.  The selector therefore has FIVE
//     entries: "Auto" (follow the model's default pairing) plus the four cabs.
//     Auto is the default.  Picking any of the four still overrides the model
//     freely, so §6's "cab swapping against the wrong amp is a feature" holds.
//  2. "Sag / Tighten: default per model."  Same problem, different fix: both
//     knobs are 0–10 with a static default of 5, and 5 maps to the model row's
//     own value.  0 is always none (spec §3.2: "at 0 every model is flat") and
//     10 is always full.  Switching models re-voices what 5 means without
//     touching the stored parameter — which is what "re-voices the whole chain"
//     means in §4.
//
// ── What this class does NOT do ─────────────────────────────────────────────
// Registration.  Spec §9 and §11 make the Phase 3 stock-effect registration
// path a prerequisite audit, and that audit is not in the repository.  This
// class is deliberately NOT wired into PluginRegistry, MixEngine, the bridge,
// or the UI.  It is a self-contained DSP class with a test harness.

class XlethAmpEffect : public XlethEffectBase
{
public:
    // ── Model roster (spec §5) ──────────────────────────────────────────────
    enum class AmpModel : int
    {
        BlackfaceClean = 0,
        TweedCrunch    = 1,
        Plexi          = 2,
        ModernTight    = 3,
        Rectifier      = 4,
        Precision      = 5,
    };

    static constexpr int kNumModels = 6;

    // ── Drive topology (spec §3.3) ──────────────────────────────────────────
    // The drive is a CASCADE of gain-then-shape stages with a low-pass between
    // them, not one shaper with the whole gain range in front of it.  Spec §3.3
    // fixes the curve family and the gain range per model; the topology is left
    // to the implementation, and a cascade is both what a real preamp is (a
    // chain of triode stages, each with its own pole) and what makes the §10.1
    // aliasing sweep passable at 4×.
    //
    // Why it matters, in one paragraph.  Fold-back is set by how much high-order
    // harmonic energy the shaper produces, and that is set by how far past its
    // knee the shaper is driven.  Fifty dB into a single clipper is a square
    // wave: harmonics decay as 1/n, so harmonic 38 — the one that folds for a
    // 5 kHz fundamental at 4× — is only ~32 dB down and lands audibly below the
    // fundamental.  Split the same 50 dB across three stages and each one sees
    // only ~17 dB of overdrive, while the interstage low-pass strips the
    // harmonics before they reach the next nonlinearity.  The measured
    // difference is tens of dB.  Once a harmonic has folded inside the
    // oversampled region NO later filter can remove it, so this is the only
    // lever that exists short of raising the oversampling factor — which spec
    // §9 rules out ("4× oversampling, not 8×").
    static constexpr int kDriveStages = 3;

    // ── Clip curve family (spec §3.3) ───────────────────────────────────────
    enum class ClipCurve : int
    {
        SymmetricSoft  = 0,   // tanh-like — clean / vintage
        AsymmetricSoft = 1,   // even harmonics — the tweed "fur"
        HardClamp      = 2,   // soft-knee clamp — modern
    };

    // ── Voicing table (spec §4) ─────────────────────────────────────────────
    // THIS TABLE IS THE ONLY PLACE MODELS DIFFER.  Every stage below reads a
    // row; none of them branches on the model id.  Adding a seventh model is
    // one more row here and a tuning pass — nothing else.
    struct AmpVoicing
    {
        const char* displayName;

        // Tighten (pre-filter), at amount == 1.  Spec §3.2.
        //
        // preLpHz is NOT part of the Tighten voicing and is NOT scaled by the
        // Tighten knob: it is the amp's own input bandwidth — the pole every
        // real preamp has from Miller capacitance, which is why no guitar amp
        // ever passed 15 kHz to its clipping stages.  It is applied as a fixed
        // 4th-order Butterworth low-pass ahead of the drive and it is what
        // keeps the spec §10.1 aliasing sweep passing at max Drive: band-limit
        // the nonlinearity's INPUT, because once a harmonic has folded inside
        // the oversampled region no later filter can remove it.
        //
        // Spec §3.2's "at 0 every model is flat" refers to the Tighten voicing
        // curve — the high-pass and low-shelf below, which are what the spec
        // itself credits for modern tightness ("the pre-distortion bass cut is
        // what makes modern high gain tight").
        float preLpHz;              // fixed input bandwidth, 4th-order
        float tightenHpHz;          // pre-drive high-pass corner
        float tightenLpHz;          // pre-drive low-pass corner
        float tightenShelfHz;       // low-shelf corner
        float tightenShelfDb;       // low-shelf gain (negative == bass trim)
        float tightenDefault01;     // what the Tighten knob's centre detent means

        // Drive.  Spec §3.3.
        ClipCurve curve;
        float driveMinDb;           // knob 0
        float driveMaxDb;           // knob 10
        float asymmetry;            // AsymmetricSoft only: shaper bias
        float clampKnee;            // HardClamp only: linear region, 0..1

        // Tone stack.  Spec §3.4.
        float bassHz,   bassMaxDb;
        float midHz,    midMaxDb,  midBaseDb;   // midBaseDb < 0 == scooped FMV
        float trebleHz, trebleMaxDb;
        float stackTrimDb;                      // passive insertion loss at max

        // Power stage.  Spec §3.5.
        float powerDriveDb;
        float sagDefault01;         // what the Sag knob's centre detent means
        float sagMaxDb;             // ceiling on the sag stage's gain reduction

        // Defaults.  Spec §4 columns "Default cab" and "Gate".
        xleth::audio::amp::CabinetId defaultCab;
        float gateDefault01;        // 0 == off; > 0 == gate on by default
        float outputTrimDb;         // static inter-model level match
    };

    static const AmpVoicing& voicing(AmpModel m) noexcept
    {
        static const AmpVoicing table[kNumModels] =
        {
            // ── Blackface Clean ─────────────────────────────────────────────
            // "Flat, slight low shelf | Symmetric soft, low | Scooped-mid FMV |
            //  Med sag | Open-back 1×12 | Gate off"
            {
                "Blackface Clean",
                 7000.0f,
                  60.0f, 12000.0f,  150.0f, -1.5f, 0.15f,
                ClipCurve::SymmetricSoft,  0.0f, 18.0f, 0.0f, 0.0f,
                 100.0f, 8.0f,   500.0f, 7.0f, -3.5f,   3200.0f, 8.0f,  -6.0f,
                2.0f, 0.50f, 3.5f,
                xleth::audio::amp::CabinetId::OpenBack1x12, 0.0f,  2.0f
            },
            // ── Tweed Crunch ────────────────────────────────────────────────
            // "Flat | Asymmetric soft, mid | Mid-forward | High sag |
            //  Alnico 2×12 | Gate off"
            {
                "Tweed Crunch",
                 6000.0f,
                  70.0f,  9000.0f,  160.0f, -1.0f, 0.20f,
                ClipCurve::AsymmetricSoft, 4.0f, 30.0f, 0.30f, 0.0f,
                  95.0f, 7.0f,   620.0f, 7.0f,  2.0f,   3000.0f, 7.0f,  -6.0f,
                5.0f, 0.85f, 6.0f,
                xleth::audio::amp::CabinetId::Alnico2x12,   0.0f,  0.0f
            },
            // ── Plexi ───────────────────────────────────────────────────────
            // "Flat, slight bass trim | Symmetric soft, mid-high | Scooped FMV |
            //  Mod sag | Greenback 4×12 | Gate off"
            {
                "Plexi",
                 6000.0f,
                 110.0f,  9500.0f,  180.0f, -2.5f, 0.30f,
                ClipCurve::SymmetricSoft,  6.0f, 34.0f, 0.0f, 0.0f,
                 105.0f, 8.0f,   550.0f, 7.0f, -2.5f,   3400.0f, 8.0f,  -6.0f,
                6.0f, 0.55f, 4.5f,
                xleth::audio::amp::CabinetId::Greenback4x12, 0.0f, -1.0f
            },
            // ── Modern Tight ────────────────────────────────────────────────
            // "TS mid push (HP ≈720 Hz + LP) | Hard clamp, high | Mid-forward |
            //  Low sag | V30 4×12 | Gate off".  The 720 Hz is the spec's figure.
            {
                "Modern Tight",
                 5500.0f,
                 720.0f,  6500.0f,  200.0f, -4.0f, 0.55f,
                ClipCurve::HardClamp,     10.0f, 44.0f, 0.0f, 0.80f,
                  90.0f, 7.0f,   700.0f, 7.0f,  2.5f,   3600.0f, 7.0f,  -7.0f,
                7.0f, 0.20f, 2.5f,
                xleth::audio::amp::CabinetId::V30_4x12,     0.0f, -3.0f
            },
            // ── Rectifier ───────────────────────────────────────────────────
            // "Mid push, less bass cut | Hard clamp, high | Deep bass range |
            //  Low sag | V30 4×12 | Gate off".  Lower tighten HP than Modern
            // Tight ("less bass cut") and a lower bass-shelf corner ("deep
            // bass range").
            {
                "Rectifier",
                 5500.0f,
                 420.0f,  6000.0f,  200.0f, -2.0f, 0.45f,
                ClipCurve::HardClamp,     10.0f, 46.0f, 0.0f, 0.80f,
                  70.0f, 9.0f,   640.0f, 7.0f,  1.0f,   3400.0f, 7.0f,  -7.0f,
                7.0f, 0.25f, 2.5f,
                xleth::audio::amp::CabinetId::V30_4x12,     0.0f, -3.0f
            },
            // ── Precision ───────────────────────────────────────────────────
            // "Highest tighten HP | Hardest clamp, very high | Presence-forward |
            //  Min sag | V30 4×12 | Gate ON".  Gate on by default is the whole
            // reason the gate exists (spec §5): chopped syllables through this
            // model.
            {
                "Precision",
                 5500.0f,
                 900.0f,  7000.0f,  220.0f, -6.0f, 0.75f,
                ClipCurve::HardClamp,     12.0f, 50.0f, 0.0f, 0.90f,
                  88.0f, 6.0f,   750.0f, 6.0f,  0.5f,   4200.0f, 9.0f,  -7.0f,
                6.0f, 0.08f, 1.5f,
                xleth::audio::amp::CabinetId::V30_4x12,     0.45f, -3.0f
            },
        };

        return table[juce::jlimit(0, kNumModels - 1, static_cast<int>(m))];
    }

    // ── Stage isolation (spec §10.3) ────────────────────────────────────────
    // Diagnostic surface for the element-isolation acceptance test: bypass one
    // stage at a time and measure the per-stage gain.  Backed by one relaxed
    // atomic read per block, so it costs nothing on the audio path and is safe
    // to poke from the main thread mid-stream.
    //
    // NOTE: disabling Cabinet shortens the wet path by the convolution's own
    // latency.  With the default zero-latency Convolution that is 0 samples, so
    // alignment is unaffected — but if the convolver is ever reconfigured with
    // a Latency{} or NonUniform{} head size, this stops being free.
    enum class Stage : int
    {
        Gate = 0, Tighten, Drive, ToneStack, Power, Presence, Cabinet,
        Count
    };

    void setStageEnabled(Stage s, bool enabled) noexcept
    {
        const std::uint32_t bit = 1u << static_cast<int>(s);
        std::uint32_t cur = stageMask_.load(std::memory_order_relaxed);
        stageMask_.store(enabled ? (cur | bit) : (cur & ~bit), std::memory_order_relaxed);
    }

    bool isStageEnabled(Stage s) const noexcept
    {
        return (stageMask_.load(std::memory_order_relaxed) & (1u << static_cast<int>(s))) != 0u;
    }

    void setAllStagesEnabled(bool enabled) noexcept
    {
        stageMask_.store(enabled ? 0xFFFFFFFFu : 0u, std::memory_order_relaxed);
    }

    // ── Measured latency, for tests and diagnostics ─────────────────────────
    // Both halves are read back from JUCE at prepare time, never assumed.
    int getOversamplingLatencySamples() const noexcept { return osLatencySamples_; }
    int getConvolutionLatencySamples()  const noexcept { return convLatencySamples_; }
    int getWetLatencySamples()          const noexcept { return wetLatencySamples_; }
    int getCabinetIrSamples()           const noexcept { return cabIrSamples_; }
    double getOversampledRate()         const noexcept { return oversampledRate_; }

    // ── Constructor ─────────────────────────────────────────────────────────
    XlethAmpEffect()
        : XlethEffectBase("amp", createLayout())
        , oversampling_(1, 2,
                        juce::dsp::Oversampling<float>::filterHalfBandFIREquiripple,
                        true,   // maxQuality
                        true)   // integer latency — see the header note above
    {
        registerSmoothedParam("drive",    SmoothType::Linear, 20.0f);
        registerSmoothedParam("bass",     SmoothType::Linear, 30.0f);
        registerSmoothedParam("mid",      SmoothType::Linear, 30.0f);
        registerSmoothedParam("treble",   SmoothType::Linear, 30.0f);
        registerSmoothedParam("sag",      SmoothType::Linear, 30.0f);
        registerSmoothedParam("tighten",  SmoothType::Linear, 30.0f);
        registerSmoothedParam("gate",     SmoothType::Linear, 30.0f);
        registerSmoothedParam("presence", SmoothType::Linear, 30.0f);
        registerSmoothedParam("mix",      SmoothType::Linear, 20.0f);
        registerSmoothedParam("output",   SmoothType::Linear, 20.0f);

        // One background loader shared by all four convolvers instead of four
        // private threads.  Constructed before them (member order below).
        for (auto& c : cabConv_)
            c = std::make_unique<juce::dsp::Convolution>(convQueue_);
    }

    // ── Parameter layout (spec §7) ──────────────────────────────────────────
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            std::make_unique<juce::AudioParameterChoice>(
                Pid{"model", 1}, "Model",
                juce::StringArray{"Blackface Clean", "Tweed Crunch", "Plexi",
                                  "Modern Tight", "Rectifier", "Precision"},
                static_cast<int>(AmpModel::ModernTight)),

            std::make_unique<Apf>(Pid{"drive", 1}, "Drive",
                Nar{0.0f, 10.0f, 0.0f, 1.0f}, 5.0f, ""),

            std::make_unique<Apf>(Pid{"bass", 1}, "Bass",
                Nar{0.0f, 10.0f, 0.0f, 1.0f}, 5.0f, ""),
            std::make_unique<Apf>(Pid{"mid", 1}, "Mid",
                Nar{0.0f, 10.0f, 0.0f, 1.0f}, 5.0f, ""),
            std::make_unique<Apf>(Pid{"treble", 1}, "Treble",
                Nar{0.0f, 10.0f, 0.0f, 1.0f}, 5.0f, ""),

            // Sag / Tighten: 5 == "this model's own value" (see the header's
            // deviation note 2).
            std::make_unique<Apf>(Pid{"sag", 1}, "Sag",
                Nar{0.0f, 10.0f, 0.0f, 1.0f}, 5.0f, ""),
            std::make_unique<Apf>(Pid{"tighten", 1}, "Tighten",
                Nar{0.0f, 10.0f, 0.0f, 1.0f}, 5.0f, ""),

            // Gate: 0 == off for every model EXCEPT the ones whose voicing row
            // carries a non-zero gateDefault01 (Precision).  Spec §3.1 / §7.
            std::make_unique<Apf>(Pid{"gate", 1}, "Gate",
                Nar{0.0f, 10.0f, 0.0f, 1.0f}, 0.0f, ""),

            // Cab: "Auto" follows the model's default pairing; the four
            // explicit entries override it (see deviation note 1).
            std::make_unique<juce::AudioParameterChoice>(
                Pid{"cab", 1}, "Cab",
                juce::StringArray{"Auto", "Open-back 1x12", "Alnico 2x12",
                                  "Greenback 4x12", "V30 4x12"},
                0),

            std::make_unique<Apf>(Pid{"presence", 1}, "Presence",
                Nar{0.0f, 10.0f, 0.0f, 1.0f}, 5.0f, ""),
            std::make_unique<Apf>(Pid{"mix", 1}, "Mix",
                Nar{0.0f, 100.0f, 0.0f, 1.0f}, 100.0f, "%"),
            std::make_unique<Apf>(Pid{"output", 1}, "Output",
                Nar{-24.0f, 12.0f, 0.0f, 1.0f}, 0.0f, "dB"),
        };
    }

    // ── prepareEffect ───────────────────────────────────────────────────────
    // Everything that allocates happens here and only here.
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        // Spec §9: read the rate, derive everything, assume nothing.
        sampleRate_   = sampleRate;
        maxBlockSize_ = maxBlockSize;

        modelPtr_ = apvts_.getRawParameterValue("model");
        cabPtr_   = apvts_.getRawParameterValue("cab");
        mixPtr_   = apvts_.getRawParameterValue("mix");

        hDrive_    = resolveSmoothed("drive");
        hBass_     = resolveSmoothed("bass");
        hMid_      = resolveSmoothed("mid");
        hTreble_   = resolveSmoothed("treble");
        hSag_      = resolveSmoothed("sag");
        hTighten_  = resolveSmoothed("tighten");
        hGate_     = resolveSmoothed("gate");
        hPresence_ = resolveSmoothed("presence");
        hMix_      = resolveSmoothed("mix");
        hOutput_   = resolveSmoothed("output");

        // ── Oversampling ────────────────────────────────────────────────────
        // initProcessing() allocates; it must never run on the audio thread.
        oversampling_.reset();
        oversampling_.initProcessing(static_cast<size_t>(maxBlockSize));
        oversampledRate_  = sampleRate_ * oversampling_.getOversamplingFactor();
        osLatencySamples_ = static_cast<int>(
            std::lround(oversampling_.getLatencyInSamples()));

        juce::dsp::ProcessSpec osSpec;
        osSpec.sampleRate       = oversampledRate_;
        osSpec.maximumBlockSize = static_cast<juce::uint32>(
            maxBlockSize * static_cast<int>(oversampling_.getOversamplingFactor()));
        osSpec.numChannels      = 1;

        juce::dsp::ProcessSpec baseSpec;
        baseSpec.sampleRate       = sampleRate_;
        baseSpec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
        baseSpec.numChannels      = 1;

        // ── Tighten: TPT SVF pair + a shelving biquad, all at the OS rate ────
        tightenHp_.prepare(osSpec);
        tightenHp_.setType(juce::dsp::StateVariableTPTFilterType::highpass);
        tightenHp_.reset();
        tightenLp_.prepare(osSpec);
        tightenLp_.setType(juce::dsp::StateVariableTPTFilterType::lowpass);
        tightenLp_.reset();
        tightenShelf_.prepare(osSpec);
        tightenShelf_.reset();
        for (auto& f : preLp_)   { f.prepare(osSpec); f.reset(); }
        for (auto& f : interLp_) { f.prepare(osSpec); f.reset(); }
        drivePrev_.fill(0.0f);

        // ── Tone stack: three biquads at the OS rate ────────────────────────
        stackBass_.prepare(osSpec);   stackBass_.reset();
        stackMid_.prepare(osSpec);    stackMid_.reset();
        stackTreble_.prepare(osSpec); stackTreble_.reset();

        // ── Power stage DC blocker at the OS rate ───────────────────────────
        // The asymmetric shaper and the sag stage both introduce DC; the cab's
        // own high-pass would mostly hide it, but leaving DC inside the loop
        // would bias the following block's envelope follower.
        powerDcState_ = 0.0f;
        powerDcCoeff_ = dcBlockerCoeff(12.0, oversampledRate_);

        // ── Presence: high shelf at the base rate (post-stack, pre-cab) ──────
        presence_.prepare(baseSpec);
        presence_.reset();

        // ── Envelope follower coefficients (no per-sample exp()) ────────────
        gateAtkCoeff_   = onePoleCoeff(  1.0, sampleRate_);
        gateRelCoeff_   = onePoleCoeff( 60.0, sampleRate_);   // spec §3.1: ≥ 50 ms
        sagAtkCoeff_    = onePoleCoeff( 15.0, oversampledRate_);
        sagRelCoeff_    = onePoleCoeff(120.0, oversampledRate_);
        gateEnv_ = 0.0f; gateGain_ = 1.0f; sagEnv_ = 0.0f;

        // ── Cabinets: all four loaded up front so the audio thread only ever
        //    SELECTS one.  loadImpulseResponse() before prepare() so the IR is
        //    live on the very first process() call (JUCE's documented order).
        cabIrSamples_ = 0;
        for (int i = 0; i < xleth::audio::amp::kNumCabinets; ++i)
        {
            auto ir = xleth::audio::amp::synthesizePlaceholderCabinetIR(
                static_cast<xleth::audio::amp::CabinetId>(i), sampleRate_);
            cabIrSamples_ = std::max(cabIrSamples_, ir.getNumSamples());

            // Trim::no / Normalise::no — the synthesiser already peak-magnitude
            // normalised the IR and shaped its head and tail deliberately.
            cabConv_[static_cast<size_t>(i)]->loadImpulseResponse(
                std::move(ir), sampleRate_,
                juce::dsp::Convolution::Stereo::no,
                juce::dsp::Convolution::Trim::no,
                juce::dsp::Convolution::Normalise::no);
            cabConv_[static_cast<size_t>(i)]->prepare(baseSpec);
            cabConv_[static_cast<size_t>(i)]->reset();
        }
        convLatencySamples_ = cabConv_[0]->getLatency();

        activeCab_    = defaultCabIndex();
        fadingCab_    = activeCab_;
        cabFadePos_   = 0;
        cabFadeLen_   = std::max(1, static_cast<int>(sampleRate_ * 0.010));  // 10 ms

        // ── Measured wet latency, and the dry path aligned to it (spec §3.7) ─
        wetLatencySamples_ = osLatencySamples_ + convLatencySamples_;
        setLatencySamples(wetLatencySamples_);

        dryDelay_.setMaximumDelayInSamples(std::max(1, wetLatencySamples_ + 8));
        {
            juce::dsp::ProcessSpec drySpec;
            drySpec.sampleRate       = sampleRate_;
            drySpec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
            drySpec.numChannels      = 2;
            dryDelay_.prepare(drySpec);
            dryDelay_.reset();
            dryDelay_.setDelay(static_cast<float>(wetLatencySamples_));
        }

        // ── Working buffers ─────────────────────────────────────────────────
        monoBuf_.setSize(1, maxBlockSize, false, true, true);
        cabOutA_.setSize(1, maxBlockSize, false, true, true);
        cabOutB_.setSize(1, maxBlockSize, false, true, true);
        alignedDryBuf_.setSize(2, maxBlockSize, false, true, true);

        bypassHoldSamples_ = 0;
    }

    void releaseEffect() override
    {
        monoBuf_.setSize(0, 0);
        cabOutA_.setSize(0, 0);
        cabOutB_.setSize(0, 0);
        alignedDryBuf_.setSize(0, 0);
    }

    void resetEffect() override
    {
        oversampling_.reset();
        tightenHp_.reset();
        tightenLp_.reset();
        tightenShelf_.reset();
        for (auto& f : preLp_)   f.reset();
        for (auto& f : interLp_) f.reset();
        drivePrev_.fill(0.0f);
        stackBass_.reset();
        stackMid_.reset();
        stackTreble_.reset();
        presence_.reset();
        for (auto& c : cabConv_) c->reset();
        dryDelay_.reset();
        gateEnv_ = 0.0f; gateGain_ = 1.0f; sagEnv_ = 0.0f;
        powerDcState_ = 0.0f;
        cabFadePos_ = 0;
        fadingCab_ = activeCab_;
    }

    // Cab tail — MixEngine uses this to decide how long to keep rendering.
    double getTailLengthSeconds() const override
    {
        return sampleRate_ > 0.0 ? (cabIrSamples_ / sampleRate_) : 0.0;
    }

    // ── processEffect ───────────────────────────────────────────────────────
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        const int numSamples = buffer.getNumSamples();
        const int numCh      = buffer.getNumChannels();
        if (numSamples <= 0 || numCh <= 0) return;

        // ── Block-rate parameter reads ──────────────────────────────────────
        const AmpModel model = modelPtr_
            ? static_cast<AmpModel>(juce::jlimit(0, kNumModels - 1,
                  static_cast<int>(modelPtr_->load(std::memory_order_relaxed))))
            : AmpModel::ModernTight;
        const AmpVoicing& v = voicing(model);

        const std::uint32_t mask = stageMask_.load(std::memory_order_relaxed);
        const auto stageOn = [mask](Stage s)
        { return (mask & (1u << static_cast<int>(s))) != 0u; };

        // Advance every smoother once per block and take the block-end value —
        // the same discipline XlethDistortionEffect uses.  Nothing below calls
        // a transcendental per sample.
        hDrive_.skip(numSamples);
        hBass_.skip(numSamples);
        hMid_.skip(numSamples);
        hTreble_.skip(numSamples);
        hSag_.skip(numSamples);
        hTighten_.skip(numSamples);
        hGate_.skip(numSamples);
        hPresence_.skip(numSamples);
        hMix_.skip(numSamples);
        hOutput_.skip(numSamples);

        const float mixPct    = hMix_.current();
        const float mixN      = juce::jlimit(0.0f, 1.0f, mixPct * 0.01f);
        const float outputGain = juce::Decibels::decibelsToGain(hOutput_.current());

        // ── Always feed the dry delay, then tap it ──────────────────────────
        // This runs in every path — full processing, Mix == 0, and bypass —
        // because the reported latency is unconditional.  It is also what
        // copyLatencyAlignedBypassDry() hands back to the base class.
        pumpDryDelay(buffer, numSamples, numCh);

        // ── Skip paths (spec §9: "Skip processing entirely when bypassed or
        //    Mix = 0") ────────────────────────────────────────────────────────
        // Bypass gets a hold window: the base class crossfades wet↔dry over
        // 5 ms and needs real wet output for that long after bypass engages,
        // so the DSP only actually stops once the fade is over.
        if (bypassHoldSamples_ > 0)
            bypassHoldSamples_ = std::max(0, bypassHoldSamples_ - numSamples);

        const bool skipForBypass = isBypassed() && bypassHoldSamples_ <= 0;
        const float mixRaw = mixPtr_ ? mixPtr_->load(std::memory_order_relaxed) : 100.0f;
        const bool skipForMix = (mixRaw <= 0.0f) && (mixPct <= 0.0f);

        if (skipForBypass || skipForMix)
        {
            for (int ch = 0; ch < numCh; ++ch)
            {
                const int src = std::min(ch, alignedDryBuf_.getNumChannels() - 1);
                buffer.copyFrom(ch, 0, alignedDryBuf_, src, 0, numSamples);
                if (!skipForBypass)
                    buffer.applyGain(ch, 0, numSamples, outputGain);
            }
            writeMeterValue(2, 0.0f);
            writeMeterValue(3, 0.0f);
            return;
        }

        // ── Mono sum (spec §9: mono in) ─────────────────────────────────────
        // Averaging keeps a mono-duplicated stereo source at unity, which is
        // what pitch samples always are.
        {
            float* m = monoBuf_.getWritePointer(0);
            if (numCh == 1)
            {
                juce::FloatVectorOperations::copy(m, buffer.getReadPointer(0), numSamples);
            }
            else
            {
                const float* l = buffer.getReadPointer(0);
                const float* r = buffer.getReadPointer(1);
                for (int s = 0; s < numSamples; ++s)
                    m[s] = 0.5f * (l[s] + r[s]);
            }
        }

        // ── 1. Gate — downward expander, base rate (spec §3.1) ──────────────
        const float gateAmount = std::max(hGate_.current() * 0.1f, v.gateDefault01);
        if (stageOn(Stage::Gate) && gateAmount > 0.0f)
            processGate(monoBuf_.getWritePointer(0), numSamples, gateAmount);
        else
        {
            gateGain_ = 1.0f;
            writeMeterValue(2, 0.0f);
        }

        // ── 2–5. The 4× oversampled nonlinear region (spec §3, §9) ──────────
        {
            juce::dsp::AudioBlock<float> baseBlock(monoBuf_);
            auto block   = baseBlock.getSubBlock(0, static_cast<size_t>(numSamples));
            auto osBlock = oversampling_.processSamplesUp(block);

            updateOversampledCoefficients(v, stageOn(Stage::Tighten),
                                          stageOn(Stage::ToneStack));

            const int   osN       = static_cast<int>(osBlock.getNumSamples());
            float*      x         = osBlock.getChannelPointer(0);

            const float totalDriveDb = v.driveMinDb + (v.driveMaxDb - v.driveMinDb)
                * juce::jlimit(0.0f, 1.0f, hDrive_.current() * 0.1f);
            const float stageGain = juce::Decibels::decibelsToGain(
                totalDriveDb / static_cast<float>(kDriveStages));
            const float asymNorm  = 1.0f / (1.0f + std::abs(softClipSym(v.asymmetry)));

            const float sagAmount = modelBiasedAmount(hSag_.current() * 0.1f, v.sagDefault01);
            const float sagRange  = 1.0f - juce::Decibels::decibelsToGain(-v.sagMaxDb * sagAmount);
            const float powerGain = juce::Decibels::decibelsToGain(v.powerDriveDb);

            const bool driveOn = stageOn(Stage::Drive);
            const bool stackOn = stageOn(Stage::ToneStack);
            const bool tightOn = stageOn(Stage::Tighten);
            const bool powerOn = stageOn(Stage::Power);

            float sagPeak = 0.0f;

            for (int s = 0; s < osN; ++s)
            {
                float y = x[s];

                // ── Tighten (pre-filter) ────────────────────────────────────
                if (tightOn)
                {
                    // Input bandwidth first: this is the stage that keeps the
                    // waveshaper below from squaring off on content it would
                    // never see in a real amp, and therefore the stage that
                    // makes the §10.1 aliasing sweep pass at max Drive.
                    y = preLp_[0].processSample(y);
                    y = preLp_[1].processSample(y);
                    y = tightenHp_.processSample(0, y);
                    y = tightenLp_.processSample(0, y);
                    y = tightenShelf_.processSample(y);
                }

                // ── Drive: a CASCADE of kDriveStages gain+shape stages ──────
                // See the kDriveStages note: the total drive is split across
                // the stages and low-passed between them, which is both what a
                // real preamp does and what keeps the fold-back down.
                if (driveOn)
                {
                    for (int st = 0; st < kDriveStages; ++st)
                    {
                        const float d = y * stageGain;
                        switch (v.curve)
                        {
                            case ClipCurve::SymmetricSoft:
                                y = softClipSym(d);
                                break;
                            case ClipCurve::AsymmetricSoft:
                                // Bias is applied AFTER the stage gain: biasing
                                // before it collapses the positive half at high
                                // drive.  The static offset is removed here and
                                // the residual DC by powerDc below.
                                y = (softClipSym(d + v.asymmetry)
                                     - softClipSym(v.asymmetry)) * asymNorm;
                                break;
                            case ClipCurve::HardClamp:
                                y = hardClampAdaa(
                                        d, drivePrev_[static_cast<size_t>(st)],
                                        v.clampKnee);
                                break;
                        }

                        // Stored for every curve, not just HardClamp, so a
                        // model change mid-stream cannot leave a stale sample
                        // behind in the ADAA memory.
                        drivePrev_[static_cast<size_t>(st)] = d;

                        if (st + 1 < kDriveStages)
                            y = interLp_[static_cast<size_t>(st)].processSample(y);
                    }
                }

                // ── Tone stack (interactive B/M/T) ──────────────────────────
                if (stackOn)
                {
                    y = stackBass_.processSample(y);
                    y = stackMid_.processSample(y);
                    y = stackTreble_.processSample(y);
                    y *= stackGain_;
                }

                // ── Power stage: saturation + envelope-following sag ────────
                if (powerOn)
                {
                    const float a = std::abs(y);
                    const float c = (a > sagEnv_) ? sagAtkCoeff_ : sagRelCoeff_;
                    sagEnv_ += c * (a - sagEnv_);

                    // Sag drops the rail: less gain AND earlier clipping, which
                    // is the same thing when the saturator's ceiling is fixed.
                    const float sagGain = 1.0f - sagRange * std::min(1.0f, sagEnv_);
                    sagPeak = std::max(sagPeak, 1.0f - sagGain);

                    y = softClipSym(y * powerGain * sagGain);
                }

                // DC blocker (one pole, coefficient fixed at prepare time).
                const float dcIn = y;
                y = dcIn - powerDcState_;
                powerDcState_ = dcIn - powerDcCoeff_ * y;

                x[s] = y;
            }

            writeMeterValue(3, sagPeak);
            oversampling_.processSamplesDown(block);
        }

        // ── 6. Presence — post-stack, pre-cab (spec §3.7) ───────────────────
        if (stageOn(Stage::Presence))
        {
            float* m = monoBuf_.getWritePointer(0);
            for (int s = 0; s < numSamples; ++s)
                m[s] = presence_.processSample(m[s]);
        }

        // ── 7. Cabinet IR (spec §3.6) ───────────────────────────────────────
        const float* wet = monoBuf_.getReadPointer(0);
        if (stageOn(Stage::Cabinet))
        {
            wet = processCabinet(numSamples, defaultCabIndex());
        }

        // ── 8. Mix (latency-compensated dry) + Output gain ──────────────────
        const float dryGain = (1.0f - mixN) * outputGain;
        const float wetGain = mixN * outputGain;

        float peakL = 0.0f, peakR = 0.0f;
        for (int ch = 0; ch < numCh; ++ch)
        {
            const int   src = std::min(ch, alignedDryBuf_.getNumChannels() - 1);
            const float* dry = alignedDryBuf_.getReadPointer(src);
            float*       out = buffer.getWritePointer(ch);
            float        pk  = 0.0f;
            for (int s = 0; s < numSamples; ++s)
            {
                const float o = dry[s] * dryGain + wet[s] * wetGain;
                out[s] = o;
                pk = std::max(pk, std::abs(o));
            }
            if (ch == 0) peakL = pk; else if (ch == 1) peakR = pk;
        }

        writeMeterValue(0, peakL);
        writeMeterValue(1, numCh > 1 ? peakR : peakL);
    }

protected:
    // The wet path has real latency, so the base class's bypass crossfade must
    // compare against a dry that is delayed by exactly the reported amount —
    // otherwise engaging bypass combs.  This is also what makes the spec §10.2
    // bypass null sample-exact.
    bool usesLatencyAlignedBypassDry() const override { return true; }

    bool copyLatencyAlignedBypassDry(juce::AudioBuffer<float>& dest, int numSamples) override
    {
        const int n  = std::min(numSamples, alignedDryBuf_.getNumSamples());
        const int ch = std::min(dest.getNumChannels(), alignedDryBuf_.getNumChannels());
        if (n <= 0 || ch <= 0) return false;
        for (int c = 0; c < ch; ++c)
            dest.copyFrom(c, 0, alignedDryBuf_, c, 0, n);
        return true;
    }

    void onBypassChanged(bool bypassed) override
    {
        // Keep the DSP alive across the base class's 5 ms wet↔dry crossfade,
        // then let the skip path take over.
        if (bypassed)
            bypassHoldSamples_ = static_cast<int>(sampleRate_ * 0.005) + maxBlockSize_ + 1;
        else
            bypassHoldSamples_ = 0;
    }

private:
    // ── Waveshapers (spec §3.3) ─────────────────────────────────────────────

    // Padé-style tanh approximation.  Saturates at exactly ±1 when |x| == 3,
    // where its slope is also exactly 0 — so clamping there is C1-continuous
    // and does not manufacture the corner that a naive clip would.
    static inline float softClipSym(float x) noexcept
    {
        x = juce::jlimit(-3.0f, 3.0f, x);
        const float x2 = x * x;
        return x * (27.0f + x2) / (27.0f + 9.0f * x2);
    }

    // Soft-knee clamp: linear up to `knee`, then a Hermite cubic that reaches
    // exactly 1.0 with zero slope at knee + 2(1 − knee).  Higher knee == harder.
    // A true hard clip has an infinite-order discontinuity and aliases badly
    // even at 4×; this keeps the corner finite while still sounding clamped.
    static inline float hardClampKnee(float x, float knee) noexcept
    {
        const float t = juce::jlimit(0.05f, 0.98f, knee);
        const float a = std::abs(x);
        if (a <= t) return x;
        const float sgn  = (x < 0.0f) ? -1.0f : 1.0f;
        const float span = 2.0f * (1.0f - t);
        if (a >= t + span) return sgn;
        const float u = (a - t) / span;
        return sgn * (t + (1.0f - t) * u * (2.0f - u));
    }

    // Exact antiderivative of hardClampKnee.  The shaper is odd, so its
    // antiderivative is even — hence the abs() and no sign handling.
    static inline float hardClampKneeAntideriv(float x, float knee) noexcept
    {
        const float t    = juce::jlimit(0.05f, 0.98f, knee);
        const float span = 2.0f * (1.0f - t);
        const float a    = std::abs(x);
        const float fT   = 0.5f * t * t;

        if (a <= t) return 0.5f * a * a;

        if (a >= t + span)
        {
            const float fEnd = fT + span * (t + (1.0f - t) * (2.0f / 3.0f));
            return fEnd + (a - (t + span));
        }

        const float u = (a - t) / span;
        return fT + span * (t * u + (1.0f - t) * (u * u - u * u * u * (1.0f / 3.0f)));
    }

    // ── First-order antiderivative anti-aliasing (ADAA) for the hard clamp ──
    //
    // Applied to the HardClamp curve ONLY, and for a measured reason: with the
    // drive cascade in place the three soft-clip models come out 30+ dB inside
    // the spec §10.1 limit, while the hard-clamp models sit right on it.  The
    // difference is the curve.  softClipSym is a Padé tanh whose harmonics fall
    // away fast; hardClampKnee's Hermite knee is only C1, so its harmonics decay
    // polynomially and the ones that fold at 4× are still audible.
    //
    // ADAA1 replaces f(x) with the average of f over the segment between
    // consecutive samples — computed exactly from the antiderivative — which
    // band-limits the shaper's output before it can alias.  It costs a
    // subtraction, a divide, and a second antiderivative evaluation; because
    // hardClampKnee is piecewise polynomial its antiderivative is exact and
    // needs no transcendental, so this is genuinely cheap here in a way it would
    // not be for a tanh (whose antiderivative carries a log).
    //
    // The ill-conditioned case — consecutive samples nearly equal, where the
    // divide loses precision — falls back to evaluating the shaper at the
    // midpoint, which is the limit of the same expression.
    //
    // ADAA1 delays by half a sample AT THE OVERSAMPLED RATE, i.e. 1/8 of a base
    // sample per stage.  That is not compensated and does not need to be: the
    // wet path is an amp, not a null path, and the bypass and Mix = 0 paths do
    // not run the shaper at all — both still null exactly.
    static inline float hardClampAdaa(float x, float xPrev, float knee) noexcept
    {
        const float dx = x - xPrev;
        if (std::abs(dx) > 1.0e-5f)
            return (hardClampKneeAntideriv(x, knee)
                  - hardClampKneeAntideriv(xPrev, knee)) / dx;
        return hardClampKnee(0.5f * (x + xPrev), knee);
    }

    // ── Knob mapping helpers ────────────────────────────────────────────────

    // "Default per model" knobs (Sag, Tighten).  0 → none, 0.5 → the model
    // row's own value, 1 → full.  Spec §3.2's "at 0 every model is flat" is the
    // lower half of this curve.
    static inline float modelBiasedAmount(float knob01, float rowDefault) noexcept
    {
        const float k = juce::jlimit(0.0f, 1.0f, knob01);
        const float d = juce::jlimit(0.0f, 1.0f, rowDefault);
        return (k <= 0.5f) ? d * (k * 2.0f)
                           : d + (1.0f - d) * ((k - 0.5f) * 2.0f);
    }

    static inline float onePoleCoeff(double ms, double rate) noexcept
    {
        const double t = std::max(1.0e-4, ms * 0.001);
        return static_cast<float>(1.0 - std::exp(-1.0 / (t * rate)));
    }

    static inline float dcBlockerCoeff(double hz, double rate) noexcept
    {
        return static_cast<float>(std::exp(-2.0 * juce::MathConstants<double>::pi * hz / rate));
    }

    int defaultCabIndex() const noexcept
    {
        const int sel = cabPtr_
            ? juce::jlimit(0, xleth::audio::amp::kNumCabinets,
                  static_cast<int>(cabPtr_->load(std::memory_order_relaxed)))
            : 0;
        if (sel > 0) return sel - 1;   // explicit override

        const AmpModel m = modelPtr_
            ? static_cast<AmpModel>(juce::jlimit(0, kNumModels - 1,
                  static_cast<int>(modelPtr_->load(std::memory_order_relaxed))))
            : AmpModel::ModernTight;
        return static_cast<int>(voicing(m).defaultCab);
    }

    // ── Dry delay (spec §3.7: measured, not assumed) ─────────────────────────
    void pumpDryDelay(const juce::AudioBuffer<float>& buffer, int numSamples, int numCh)
    {
        const int dryCh = alignedDryBuf_.getNumChannels();
        for (int ch = 0; ch < dryCh; ++ch)
        {
            const int src = std::min(ch, numCh - 1);
            const float* in  = buffer.getReadPointer(src);
            float*       out = alignedDryBuf_.getWritePointer(ch);
            for (int s = 0; s < numSamples; ++s)
            {
                dryDelay_.pushSample(ch, in[s]);
                out[s] = dryDelay_.popSample(ch);
            }
        }
    }

    // ── Gate: downward expander, no lookahead, no sidechain (spec §3.1) ─────
    void processGate(float* x, int numSamples, float amount)
    {
        // amount 0..1 → threshold −70..−24 dBFS.  One exp per block, not per
        // sample.
        const float thrDb  = -70.0f + 46.0f * juce::jlimit(0.0f, 1.0f, amount);
        const float thrLin = juce::Decibels::decibelsToGain(thrDb);
        const float invThr = 1.0f / std::max(1.0e-9f, thrLin);

        float minGain = 1.0f;
        for (int s = 0; s < numSamples; ++s)
        {
            const float a = std::abs(x[s]);
            const float c = (a > gateEnv_) ? gateAtkCoeff_ : gateRelCoeff_;
            gateEnv_ += c * (a - gateEnv_);

            // Ratio 3:1 downward expansion == squaring the normalised envelope.
            // No pow(), no exp(), and it is exactly 1.0 above threshold.
            const float r = juce::jlimit(0.0f, 1.0f, gateEnv_ * invThr);
            const float target = r * r;

            // Open fast, close on the release constant: spec §3.1 requires the
            // release to be slow enough not to chatter on chopped syllables.
            gateGain_ += ((target > gateGain_) ? gateAtkCoeff_ : gateRelCoeff_)
                       * (target - gateGain_);

            x[s] *= gateGain_;
            minGain = std::min(minGain, gateGain_);
        }
        writeMeterValue(2, 1.0f - minGain);
    }

    // ── Interactive tone stack (spec §3.4) ──────────────────────────────────
    //
    // Spec §2 rejects circuit simulation outright, and §3.4 still demands that
    // Bass/Mid/Treble "interact the way a real amp stack does".  So this is a
    // BEHAVIOURAL model of an FMV stack's interaction, not a component-value
    // derivation of one.  Four rules, each modelling something a passive stack
    // actually does:
    //
    //   R1  The mid notch is INHERENT, not a control.  At mid = 5 the stack
    //       already sits `midBaseDb` below the shelves on a scooped-FMV row;
    //       the Mid knob fills or deepens the notch it finds there.
    //   R2  Bass and treble share the stack's capacitive divider, so they fight
    //       each other: opening treble pulls the bass shelf down, and (more
    //       weakly, as in the real network) opening bass pulls treble down.
    //   R3  The notch RIDES UP in frequency as the mid pot opens.
    //   R4  The stack is passive.  Its insertion loss grows as the controls
    //       close, so a stack with everything down is quiet as well as dull.
    //
    // Three independent biquads with fixed centres and no cross terms would be
    // a multiband EQ; the coupling below is the difference.
    //
    // Everything here is designed at `oversampledRate_` and recomputed once per
    // block — no per-sample coefficient math.
    void updateOversampledCoefficients(const AmpVoicing& v, bool tightenOn, bool stackOn)
    {
        using Coeffs = juce::dsp::IIR::Coefficients<float>;
        const float osNyq = static_cast<float>(oversampledRate_ * 0.5);
        const auto  fc = [osNyq](float hz) { return juce::jlimit(10.0f, osNyq * 0.95f, hz); };

        // ── Input bandwidth (always on, never scaled by the Tighten knob) ───
        // Fourth-order Butterworth: the two section Qs below are the standard
        // 4th-order Butterworth pole pair.  Designed at the oversampled rate.
        {
            static constexpr float kButterQ4[2] = { 0.54120f, 1.30656f };
            const float lp = fc(v.preLpHz);
            for (int i = 0; i < 2; ++i)
                preLp_[static_cast<size_t>(i)].coefficients =
                    Coeffs::makeLowPass(oversampledRate_, lp, kButterQ4[i]);

            // Interstage pole — one per triode stage, same corner.
            auto inter = Coeffs::makeLowPass(oversampledRate_, lp, 0.707f);
            for (auto& f : interLp_)
                f.coefficients = inter;
        }

        // ── Tighten ─────────────────────────────────────────────────────────
        if (tightenOn)
        {
            const float amt = modelBiasedAmount(hTighten_.current() * 0.1f,
                                                v.tightenDefault01);
            // Geometric interpolation from "flat" to the model's voicing, so
            // the knob feels even across its travel.
            const float flatHp = 20.0f;
            const float flatLp = osNyq * 0.9f;
            const float hpHz = flatHp * std::pow(v.tightenHpHz / flatHp, amt);
            const float lpHz = flatLp * std::pow(v.tightenLpHz / flatLp, amt);

            tightenHp_.setCutoffFrequency(fc(hpHz));
            tightenHp_.setResonance(0.707f);
            tightenLp_.setCutoffFrequency(fc(lpHz));
            tightenLp_.setResonance(0.707f);
            tightenShelf_.coefficients = Coeffs::makeLowShelf(
                oversampledRate_, fc(v.tightenShelfHz), 0.707f,
                juce::Decibels::decibelsToGain(v.tightenShelfDb * amt));
        }

        // ── Tone stack ──────────────────────────────────────────────────────
        if (stackOn)
        {
            const float b = juce::jlimit(0.0f, 1.0f, hBass_.current()   * 0.1f);
            const float m = juce::jlimit(0.0f, 1.0f, hMid_.current()    * 0.1f);
            const float t = juce::jlimit(0.0f, 1.0f, hTreble_.current() * 0.1f);

            constexpr float kBassFromTreble = 0.35f;   // R2
            constexpr float kTrebleFromBass = 0.15f;   // R2
            constexpr float kPassiveLossDb  = 6.0f;    // R4

            const float bassDb   = v.bassMaxDb   * (b - 0.5f) * 2.0f
                                 - v.bassMaxDb   * kBassFromTreble * (t - 0.5f) * 2.0f;
            const float midDb    = v.midBaseDb + v.midMaxDb * (m - 0.5f) * 2.0f;   // R1
            const float trebleDb = v.trebleMaxDb * (t - 0.5f) * 2.0f
                                 - v.trebleMaxDb * kTrebleFromBass * (b - 0.5f) * 2.0f;

            const float midHz = v.midHz * (0.7f + 0.6f * m);                       // R3
            // Deeper notch == narrower, the way an LC null behaves.
            const float midQ  = juce::jlimit(0.5f, 2.2f, 0.7f + 0.9f * std::abs(midDb) / 8.0f);

            stackBass_.coefficients = Coeffs::makeLowShelf(
                oversampledRate_, fc(v.bassHz), 0.707f,
                juce::Decibels::decibelsToGain(bassDb));
            stackMid_.coefficients = Coeffs::makePeakFilter(
                oversampledRate_, fc(midHz), midQ,
                juce::Decibels::decibelsToGain(midDb));
            stackTreble_.coefficients = Coeffs::makeHighShelf(
                oversampledRate_, fc(v.trebleHz), 0.707f,
                juce::Decibels::decibelsToGain(trebleDb));

            const float insertionDb = v.stackTrimDb
                                    - kPassiveLossDb * (1.0f - (b + m + t) / 3.0f);   // R4
            stackGain_ = juce::Decibels::decibelsToGain(insertionDb);
        }
        else
        {
            stackGain_ = 1.0f;
        }

        // ── Presence (base rate, post-stack pre-cab) ────────────────────────
        {
            const float p  = juce::jlimit(0.0f, 1.0f, hPresence_.current() * 0.1f);
            const float db = (p - 0.5f) * 2.0f * 8.0f;
            const float baseNyq = static_cast<float>(sampleRate_ * 0.5);
            presence_.coefficients = Coeffs::makeHighShelf(
                sampleRate_, juce::jlimit(1000.0f, baseNyq * 0.9f, 3200.0f), 0.707f,
                juce::Decibels::decibelsToGain(db));
        }
    }

    // ── Cabinet stage ───────────────────────────────────────────────────────
    // The audio thread only ever SELECTS a pre-loaded convolver.  A cab change
    // starts a 10 ms equal-gain crossfade during which both convolvers run;
    // outside the fade only one does.  No IR is ever loaded here.
    const float* processCabinet(int numSamples, int wantCab)
    {
        if (wantCab != activeCab_ && cabFadePos_ == 0)
        {
            fadingCab_  = activeCab_;
            activeCab_  = wantCab;
            cabFadePos_ = cabFadeLen_;
        }

        auto runConv = [this, numSamples](int idx, juce::AudioBuffer<float>& dest)
        {
            dest.copyFrom(0, 0, monoBuf_, 0, 0, numSamples);
            juce::dsp::AudioBlock<float> blk(dest);
            auto sub = blk.getSubBlock(0, static_cast<size_t>(numSamples));
            juce::dsp::ProcessContextReplacing<float> ctx(sub);
            cabConv_[static_cast<size_t>(idx)]->process(ctx);
        };

        runConv(activeCab_, cabOutA_);

        if (cabFadePos_ > 0)
        {
            runConv(fadingCab_, cabOutB_);
            float* a = cabOutA_.getWritePointer(0);
            const float* bch = cabOutB_.getReadPointer(0);
            for (int s = 0; s < numSamples && cabFadePos_ > 0; ++s)
            {
                const float w = 1.0f - static_cast<float>(cabFadePos_)
                                     / static_cast<float>(cabFadeLen_);
                a[s] = a[s] * w + bch[s] * (1.0f - w);
                --cabFadePos_;
            }
        }

        return cabOutA_.getReadPointer(0);
    }

    // ── State ───────────────────────────────────────────────────────────────
    double sampleRate_      = 48000.0;   // overwritten by prepareToPlay; never assumed
    double oversampledRate_ = 192000.0;
    int    maxBlockSize_    = 512;

    juce::dsp::Oversampling<float> oversampling_;

    // Tighten (OS rate)
    juce::dsp::StateVariableTPTFilter<float> tightenHp_, tightenLp_;
    juce::dsp::IIR::Filter<float>            tightenShelf_;
    // Fixed 4th-order Butterworth input-bandwidth low-pass (see AmpVoicing::
    // preLpHz).  Two cascaded biquads at the Butterworth Q pair.
    std::array<juce::dsp::IIR::Filter<float>, 2> preLp_;
    // Interstage low-pass between drive stages (one fewer than the stage count).
    std::array<juce::dsp::IIR::Filter<float>, kDriveStages - 1> interLp_;
    // Previous shaper input per drive stage — the ADAA1 memory.
    std::array<float, kDriveStages> drivePrev_ {};

    // Tone stack (OS rate)
    juce::dsp::IIR::Filter<float> stackBass_, stackMid_, stackTreble_;
    float stackGain_ = 1.0f;

    // Power stage (OS rate)
    float sagEnv_ = 0.0f, sagAtkCoeff_ = 0.0f, sagRelCoeff_ = 0.0f;
    float powerDcState_ = 0.0f, powerDcCoeff_ = 0.0f;

    // Gate (base rate)
    float gateEnv_ = 0.0f, gateGain_ = 1.0f;
    float gateAtkCoeff_ = 0.0f, gateRelCoeff_ = 0.0f;

    // Presence (base rate)
    juce::dsp::IIR::Filter<float> presence_;

    // Cabinet.  convQueue_ MUST stay declared before cabConv_ — the convolvers
    // hold a reference to it and are constructed from it.
    juce::dsp::ConvolutionMessageQueue convQueue_;
    std::array<std::unique_ptr<juce::dsp::Convolution>,
               xleth::audio::amp::kNumCabinets> cabConv_;
    int activeCab_ = 0, fadingCab_ = 0, cabFadePos_ = 0, cabFadeLen_ = 1;
    int cabIrSamples_ = 0;

    // Latency compensation — every number here is measured at prepare time.
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None> dryDelay_{ 4096 };
    int osLatencySamples_   = 0;
    int convLatencySamples_ = 0;
    int wetLatencySamples_  = 0;

    // Working buffers (all sized in prepareEffect)
    juce::AudioBuffer<float> monoBuf_, cabOutA_, cabOutB_, alignedDryBuf_;

    int bypassHoldSamples_ = 0;

    // Raw APVTS pointers for the discrete / gate-condition params
    std::atomic<float>* modelPtr_ = nullptr;
    std::atomic<float>* cabPtr_   = nullptr;
    std::atomic<float>* mixPtr_   = nullptr;

    SmoothedHandle hDrive_, hBass_, hMid_, hTreble_, hSag_, hTighten_,
                   hGate_, hPresence_, hMix_, hOutput_;

    std::atomic<std::uint32_t> stageMask_{ 0xFFFFFFFFu };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(XlethAmpEffect)
};
