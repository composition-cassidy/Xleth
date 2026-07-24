#pragma once

#include "audio/XlethEffectBase.h"
#include <juce_dsp/juce_dsp.h>

#include <algorithm>
#include <array>
#include <cmath>

// ─── XlethReverbEffect ──────────────────────────────────────────────────────
// 8×8 Feedback Delay Network reverb with early reflections, Hadamard feedback
// matrix, per-line damping, per-line modulation, and DC blockers.
//
// Four internal backends, each with dedicated state, dispatched per block:
//
//   • LegacyFdn — bit-frozen Generic algorithm. Used ONLY when style ==
//     Generic AND the smoothness ("Ring Tame") parameter is exactly 0
//     (raw and smoothed). Hardcoded to kGenericTuning constants. No
//     anti-metal processing of any kind. Future enhancement passes MUST
//     NOT modify this path — it exists so projects saved before any
//     anti-metal work loaded with smoothness=0 reproduce their original
//     sound exactly.
//
//   • EnhancedFdn — used for Room AND for Generic when smoothness > 0.
//     Pass 1 (this revision) replaces the legacy consecutive-prime delay
//     cluster with log-spread non-adjacent primes, swaps equal per-line
//     input excitation for signed/decorrelated input vectors, and replaces
//     the even/odd output split with style-specific mixed-sign output
//     vectors L/R. Hadamard feedback, damping, and modulation behaviour are
//     unchanged from the previous pass; future passes will add scattering /
//     multiband attenuation / alternate matrices behind this same backend.
//
//   • HallFdn — dedicated 16-line FDN for Hall. See processBlockHall().
//
//   • PlateTank — dedicated Dattorro/Griesinger-inspired cross-coupled
//     allpass/delay tank for Plate. See processBlockPlate(). Does NOT use
//     the FDN path. All Plate DSP constants live in the Plate constants
//     block below.
//
// Processing stages (both backends):
//   1. Pre-delay (0–100 ms, non-interpolated)
//   2. Early reflections (8–12 stereo-decorrelated taps; per-style geometry)
//   2b. Optional input diffusion (Schroeder allpass cascade) feeding the FDN
//       only. Hall uses 2 stages; Generic / Room / Plate use 0 (bypassed).
//       (Enhanced path only.)
//   3. Late reverb (8×8 FDN with FWHT, damping, modulation, DC blocking)
//
// Parameters (APVTS-backed):
//   decay      0.1–30 s       (Linear 30ms)
//   predelay   0–100 ms       (None — read per block)
//   size       0–100 %        (Linear 30ms)
//   damping    0–100 %        (Linear 20ms)
//   mod_rate   0–100 %        (Linear 20ms)
//   mod_depth  0–100 %        (Linear 20ms)
//   er_level   0–100 %        (Linear 20ms)
//   er_late    0–100 %        (Linear 20ms)
//   hicut      1000–20000 Hz  (Multiplicative 30ms)
//   locut      20–500 Hz      (Multiplicative 30ms)
//   mix        0–100 %        (Linear 20ms)
//   smoothness 0–100 %        (Linear 30ms)  — surfaced as "RING TAME" in UI
//      Anti-metal / anti-ringing control. 0 = legacy/raw (selects the
//      LegacyFdn backend on Generic). Higher values currently drive the
//      same damping/HF/ER softening as before; future passes will move
//      additional anti-metal behaviour behind this control inside the
//      EnhancedFdn backend only. Defaults to 0 so projects saved before
//      this parameter existed load with anti-metal off and reproduce
//      their original sound exactly.
//
// Metering slots:
//   0 — L output peak
//   1 — R output peak
//
// Latency: 0 (pre-delay is creative, not compensated)
//
// pluginId: "reverb"

// ─── Shared reverb types ─────────────────────────────────────────────────────

struct ReverbERTap { float delayMs; float gainL; float gainR; };

// ── AllpassDiffuser ──────────────────────────────────────────────────────────
// Single-section Schroeder allpass: H(z) = (z^-D − g) / (1 + g·z^-D).
// Implemented with one delay line and a transposed Direct-Form II topology so
// only one circular buffer is needed. Stable for |g| < 1; unity magnitude
// response. Used to smooth attack transients before the FDN feed for Hall,
// turning a clicky impulse into a dispersed cluster without coloring tone.
struct AllpassDiffuser
{
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None>
          line;
    int   delaySamples = 0;
    float coeff        = 0.0f;

    void prepare(double sampleRate, int maxBlockSize,
                 int delaySamplesAt48k, float g)
    {
        const float srScale = static_cast<float>(sampleRate) / 48000.0f;
        delaySamples = std::max(1,
            static_cast<int>(static_cast<float>(delaySamplesAt48k) * srScale + 0.5f));
        coeff = g;

        line.setMaximumDelayInSamples(delaySamples + 4);
        juce::dsp::ProcessSpec spec;
        spec.sampleRate       = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
        spec.numChannels      = 1;
        line.prepare(spec);
        line.reset();
    }

    void reset() { line.reset(); }

    // DEPRECATED — DO NOT USE IN NEW CODE. Computes v = x - g·delayed, giving
    // H(z) = (z^-D - g)/(1 + g·z^-D), which is NOT a unity-gain allpass — it
    // resonates with peak (1+g)/(1-g) at the frequencies where cos(ωD) = -1
    // (the sign error root-caused in commit 80f58e9; see docs/plans/reverb-
    // audit-and-redesign.md §7 errata). As of the Phase 3B Hall re-tune this
    // method has NO remaining callers: Hall's input diffusion — its last user,
    // which had relied on the resonant coloration — was migrated to the
    // correct processAllpass() below. It is retained (not deleted) only so the
    // change set stays minimal and any out-of-tree/experimental code that still
    // links it keeps compiling; deleting it is a later cleanup-phase decision.
    // Every diffuser in this file (Room input, Hall input, Plate tank, ER bus)
    // now uses processAllpass().
    inline float process(float x)
    {
        const float delayed = line.popSample(0,
            static_cast<float>(delaySamples), true);
        const float v = x - coeff * delayed;
        line.pushSample(0, v);
        return -coeff * v + delayed;
    }

    // Correct unity-gain Schroeder allpass: v = x + g·delayed →
    // H(z) = (z^-D - g)/(1 - g·z^-D), |H| = 1 at every frequency. Required for
    // any allpass placed inside a feedback loop; the Plate tank uses this for
    // its input diffusers and fixed allpasses so the loop gain stays bounded.
    inline float processAllpass(float x)
    {
        const float delayed = line.popSample(0,
            static_cast<float>(delaySamples), true);
        const float v = x + coeff * delayed;
        line.pushSample(0, v);
        return -coeff * v + delayed;
    }
};

struct FdnTuning
{
    const float*       baseDelays;            // [8]  line lengths (samples @ 48 kHz)
    const float*       modRates;              // [8]  per-line LFO frequencies (Hz)
    const ReverbERTap* erTaps;                // [numErTaps]
    int                numErTaps;
    float              fdnInputGain;          // overall input scalar (legacy 0.1)
    // ── Style-specific behaviour scalars ────────────────────────────────────
    float              erGainScale;
    float              lateGainScale;
    float              dampingOffset;
    float              modDepthScale;
    float              decayScale;
    int                inputDiffusionStages;
    // ── Enhanced anti-metal vectors (pass 1) ────────────────────────────────
    // Per-line input gains (signed, decorrelated). The enhanced backend
    // injects fdnIn * fdnInputGain * inputGains[i] into line i.  Legacy
    // backend ignores these (it always injects fdnIn * 0.1f equally).
    //
    // Output mixing replaces the legacy "even lines → L, odd lines → R"
    // routing.  Enhanced fdnL = (Σ lineOut[i] * outputGainsL[i]) * lateOutputGain
    //          Enhanced fdnR = (Σ lineOut[i] * outputGainsR[i]) * lateOutputGain
    //
    // All arrays are statically allocated; no heap traffic in process().
    const float* inputGains;     // [8]
    const float* outputGainsL;   // [8]
    const float* outputGainsR;   // [8]
    float        lateOutputGain; // overall late output normalisation
    // Phase 2 equal-loudness calibration (docs/plans/reverb-audit-and-redesign.md
    // Phase 2): applied once to the final wet sum, on top of lateOutputGain.
    // Generic-enhanced is the calibration reference (trim = 1.0 by definition);
    // Room's trim is measurement-derived. See kGenericWetCalTrim / kRoomWetCalTrim.
    float        wetCalTrim;
};

// Maximum allpass stages on the FDN input path. Hall's dedicated backend
// (processBlockHall) uses all of these, reading fdnLate_.inputDiffusers
// directly — it does not consult FdnTuning::inputDiffusionStages at all.
// Phase 3B raised this 2 → 3: the diffusion migration (defective process()
// → processAllpass()) removed the old pairing's resonant ringing, which had
// been (accidentally) filling in the tail and holding the late-tail crest
// factor down. With 2 true allpass stages the crest jumped 11.94 → 25.14
// (breaching testHallTailCrestFactorBounded's 25.0 ceiling) — the resonant
// coloration was masking a density deficit. A 3rd incommensurate allpass
// stage restores the dispersion honestly (measured crest back to ~12). Within
// the shared EnhancedFdn backend (processBlockEnhanced), Room reads
// fdnLate_.roomInputDiffusers instead — a separate array, its own 2-stage
// count (kRoomInputDiffusionStages) — so Room is unaffected by this bump.
// Generic stays 0 (calibration reference). Plate has its own 4-stage cascade.
static constexpr int kMaxInputDiffusionStages = 3;

// ─── Style enumeration ───────────────────────────────────────────────────────
// Discrete topology selector exposed as the "style" APVTS choice parameter.
// Each value maps to a dedicated backend in processEffect():
//   Generic (0) → processBlockLegacy (smoothness=0) or processBlockEnhanced
//   Room    (1) → processBlockEnhanced
//   Plate   (2) → processBlockPlate  (cross-coupled allpass/delay tank)
//   Hall    (3) → processBlockHall   (16-line FDN)
enum class ReverbStyle : int { Generic = 0, Room = 1, Plate = 2, Hall = 3 };
static constexpr int kNumReverbStyles = 4;

// ─── ReverbTunings (constant tables) ─────────────────────────────────────────
//
// All immutable per-style tuning data lives here. The Generic table is also
// referenced directly by the LegacyFdn backend so future edits to the
// EnhancedFdn pipeline cannot accidentally drift the legacy character.

namespace {

// ── Generic tuning (LEGACY-FROZEN constants) ──────────────────────────────
//
// These constants define the legacy Generic sound.  They are also consumed
// by the EnhancedFdn backend when style == Generic, but the LegacyFdn path
// pins to them directly so the legacy character cannot be perturbed by a
// future change to FdnTuning's layout.

constexpr float kGenericBaseDelays[8] = {
    809.0f, 877.0f, 937.0f, 1049.0f,
    1151.0f, 1249.0f, 1373.0f, 1499.0f
};

constexpr float kGenericModRates[8] = {
    0.37f, 0.43f, 0.53f, 0.61f, 0.71f, 0.83f, 0.97f, 1.13f
};

constexpr ReverbERTap kGenericErTaps[12] = {
    {  3.1f, 0.85f, 0.72f }, {  7.3f, 0.72f, 0.85f },
    { 12.5f, 0.65f, 0.58f }, { 17.8f, 0.58f, 0.65f },
    { 23.2f, 0.50f, 0.43f }, { 29.7f, 0.43f, 0.50f },
    { 36.1f, 0.36f, 0.30f }, { 42.8f, 0.30f, 0.36f },
    { 51.3f, 0.24f, 0.20f }, { 58.9f, 0.20f, 0.24f },
    { 67.4f, 0.15f, 0.12f }, { 76.2f, 0.10f, 0.08f },
};

constexpr int   kGenericNumErTaps   = 12;
constexpr float kGenericFdnInputGain = 0.1f;

// Hall input-diffusion table (processBlockHall). Phase 3B: the first two
// stages keep their original incommensurate delays (211/367 samp @48k =
// 4.4/7.6 ms); the third (557 samp = 11.6 ms, prime, incommensurate with the
// first two and with every kHallBaseDelays16 line) is added to restore the
// tail density the resonant process() pairing had been masking — see the
// kMaxInputDiffusionStages comment. Coefficients stay in the standard
// Schroeder range (0.60–0.70); the cascade builds echo density over ~24 ms.
constexpr int   kInputDiffusionDelaysAt48k[kMaxInputDiffusionStages] = { 211, 367, 557 };
constexpr float kInputDiffusionCoeffs    [kMaxInputDiffusionStages] = { 0.625f, 0.700f, 0.650f };

// Room input-diffusion cascade (Phase 3: docs/plans/reverb-audit-and-
// redesign.md §6). This seam was originally reserved for a future SMOOTH-
// driven diffuser and was never wired in — its original 197/313-sample
// delays are documented (in the prior revision of this comment) as having
// caused audible comb resonances when tried, i.e. they were too short: a
// two-stage Schroeder allpass's own impulse response is a pulse train spaced
// at its delay length, and 197/313 samples (~4.1/6.5 ms @ 48 kHz) put those
// pulses close enough together to read as a metallic ring in their own
// right rather than as diffuse texture. Resized here to 251/419 samples
// (~5.2/8.7 ms @ 48 kHz) — both prime, mutually incommensurate, and clear of
// small-integer ratios against every kRoomBaseDelays entry (277–797) — before
// wiring it as Room's 2-stage input diffusion ahead of the FDN feed. Gains
// are in the standard Schroeder range (~0.5–0.7).
static constexpr int   kRoomInputDiffusionStages = 2;
constexpr int   kRoomInputDiffusionDelaysAt48k[kRoomInputDiffusionStages] = { 251, 419 };
constexpr float kRoomInputDiffusionCoeffs     [kRoomInputDiffusionStages] = { 0.62f, 0.58f };

// ER bus decorrelation (Phase 3: docs/plans/reverb-audit-and-redesign.md §6).
// The shared ER tap line (FdnLate::erLine) feeds every non-legacy style's ER
// taps (Generic-enhanced, Room, Hall — legacy Generic is bit-frozen; Plate
// doesn't use erLine, it has its own diffusion). A single short allpass
// diffuses the signal that feeds erLine, so the taps read an already-smeared
// cluster instead of one clean impulse — de-spiking the discrete tap-arrival
// bundle. 443 samples (~9.2 ms @ 48 kHz) sits in the requested 5-15 ms range,
// is prime, and doesn't coincide with any FDN base delay, input-diffuser, or
// Plate tank delay already in use. This is architecturally disjoint from the
// FDN recirculating state (fdnLines/hallLate_.fdnLines, their damping/DC-
// blocker/feedback gain) that RT60 is a property of — erLine never feeds the
// FDN, only the ER taps — so it cannot change RT60 (measured/locked in
// test_reverb.cpp's testErBusDecorrelationPreservesRT60).
constexpr int   kErBusDiffuserDelayAt48k = 443;
constexpr float kErBusDiffuserCoeff      = 0.60f;

// ─── Enhanced anti-metal vectors (pass 1) ────────────────────────────────
//
// Design goals:
//   • Delay sets are no longer the consecutive-prime cluster the legacy path
//     uses.  Each enhanced set is log-spread, picks primes that are not
//     adjacent in the prime sequence, and avoids small-integer ratios.
//   • inputGains break equal excitation across the 8 lines (sign + magnitude
//     vary per line; Σ|g|² ≈ 8 keeps total injected energy comparable to the
//     legacy all-ones case).
//   • outputGainsL / outputGainsR replace the legacy "even lines → L, odd
//     lines → R" routing with sign/magnitude patterns that decorrelate
//     stereo and break the modal clustering caused by the regular split.
//     Σg² ≈ 4 per channel keeps wet level ~unchanged vs. the legacy 4-line
//     sum.
//   • lateOutputGain trims residual level differences so the wet bus does
//     not jump when smoothness rises off zero.
//
// All arrays are deterministic constants — no runtime randomness.

// Enhanced Generic — neutral, less metallic than legacy. Log-spread primes
// that are scattered through the prime sequence rather than consecutive.
constexpr float kEnhGenericBaseDelays[8] = {
    601.0f, 691.0f, 811.0f, 937.0f,
    1093.0f, 1259.0f, 1483.0f, 1693.0f
};
constexpr float kEnhGenericInputGains[8] = {
    +0.95f, -1.05f, +1.02f, -0.98f,
    -1.04f, +0.96f, -1.06f, +0.94f
};
constexpr float kEnhGenericOutputGainsL[8] = {
    +0.78f, -0.62f, +0.55f, -0.85f,
    +0.70f, -0.45f, +0.92f, -0.65f
};
constexpr float kEnhGenericOutputGainsR[8] = {
    -0.65f, +0.85f, -0.45f, +0.55f,
    -0.92f, +0.70f, -0.62f, +0.78f
};
constexpr float kEnhGenericLateOutputGain = 1.0f;

// Phase 2 equal-loudness calibration: Generic-enhanced (style Generic,
// smoothness > 0) IS the calibration reference (docs/plans/reverb-audit-and-
// redesign.md Phase 2) — its trim is the identity value by definition. All
// other non-legacy styles are trimmed to match ITS pink-noise wet RMS at the
// calibration setting (decay 2s / size 50 / damping 50 / mix 100, 44.1 kHz),
// within +-1 dB, locked by testReverbEqualLoudnessCalibration.
constexpr float kGenericWetCalTrim = 1.0f;

// Generic intentionally locks every behaviour scalar to its identity value
// (1.0 / 0.0) and uses zero diffusion stages.  When the EnhancedFdn backend
// runs Generic at smoothness>0 it consumes this tuning; smoothness=0 still
// dispatches to the LegacyFdn backend, which references kGenericBaseDelays
// etc. directly and never reads this struct.
const FdnTuning kGenericTuning = {
    kEnhGenericBaseDelays, kGenericModRates, kGenericErTaps, kGenericNumErTaps,
    kGenericFdnInputGain,
    1.0f, 1.0f, 0.0f, 1.0f, 1.0f,
    0,
    kEnhGenericInputGains, kEnhGenericOutputGainsL, kEnhGenericOutputGainsR,
    kEnhGenericLateOutputGain, kGenericWetCalTrim
};

// ─── Room tuning ─────────────────────────────────────────────────────────
// Enhanced Room — tighter than Generic, larger gaps from Generic's set so
// switching styles produces audibly distinct modal patterns.
constexpr float kRoomBaseDelays[8] = {
    277.0f, 337.0f, 389.0f, 449.0f,
    521.0f, 599.0f, 683.0f, 797.0f
};

constexpr float kRoomModRates[8] = {
    0.19f, 0.22f, 0.27f, 0.31f, 0.36f, 0.42f, 0.49f, 0.57f
};

constexpr ReverbERTap kRoomErTaps[8] = {
    {  2.3f, 0.78f, 0.65f }, {  4.7f, 0.65f, 0.78f },
    {  8.1f, 0.70f, 0.55f }, { 12.3f, 0.55f, 0.70f },
    { 16.9f, 0.58f, 0.45f }, { 21.7f, 0.45f, 0.58f },
    { 26.3f, 0.42f, 0.35f }, { 31.9f, 0.35f, 0.42f },
};

constexpr float kRoomInputGains[8] = {
    +1.05f, +0.93f, -1.02f, +0.97f,
    -0.91f, -1.06f, +0.99f, -1.08f
};
constexpr float kRoomOutputGainsL[8] = {
    +0.80f, -0.60f, +0.90f, -0.50f,
    +0.75f, +0.95f, -0.55f, +0.70f
};
constexpr float kRoomOutputGainsR[8] = {
    -0.50f, +0.95f, -0.65f, +0.80f,
    -0.55f, +0.70f, -0.90f, +0.60f
};
constexpr float kRoomLateOutputGain = 0.96f;

// Phase 2 equal-loudness calibration: measured pink-noise wet RMS at the
// calibration setting was 0.140111 vs the Generic-enhanced reference's
// 0.123408 (+1.10 dB — just outside the +-1 dB target). Trim = ref/measured.
// Phase 3 (docs/plans/reverb-audit-and-redesign.md §6): wiring Room's input
// diffusion (kRoomInputDiffusionStages) shifted the measured wet RMS at the
// same calibration setting to 0.124744 vs the 0.8808-trimmed value (+0.093 dB
// — still comfortably inside +-1 dB, but re-measured and re-trimmed anyway
// per the "any change that moves wet RMS must recalibrate in the same
// commit" rule). New trim = 0.8808 * (0.123408 / 0.124744) = 0.8714.
constexpr float kRoomWetCalTrim = 0.8714f;

const FdnTuning kRoomTuning = {
    kRoomBaseDelays, kRoomModRates, kRoomErTaps, 8, 0.1f,
    1.15f, 0.75f, 0.15f, 0.45f, 0.75f,
    kRoomInputDiffusionStages,
    kRoomInputGains, kRoomOutputGainsL, kRoomOutputGainsR,
    kRoomLateOutputGain, kRoomWetCalTrim
};

// ─── Hall tuning ─────────────────────────────────────────────────────────
// Enhanced Hall — longer, log-spread, broader stereo decorrelation than
// Room.  Maximum delay (2417 @ 48 kHz) sets the worst-case FDN allocation.
constexpr float kHallBaseDelays[8] = {
    1117.0f, 1283.0f, 1429.0f, 1601.0f,
    1777.0f, 1973.0f, 2179.0f, 2417.0f
};

constexpr float kHallModRates[8] = {
    0.31f, 0.37f, 0.43f, 0.51f, 0.59f, 0.69f, 0.79f, 0.91f
};

constexpr ReverbERTap kHallErTaps[10] = {
    {   7.1f, 0.65f, 0.45f }, {  11.7f, 0.45f, 0.65f },
    {  17.3f, 0.55f, 0.40f }, {  23.9f, 0.40f, 0.55f },
    {  31.1f, 0.45f, 0.32f }, {  39.7f, 0.32f, 0.45f },
    {  49.3f, 0.30f, 0.22f }, {  61.7f, 0.22f, 0.30f },
    {  77.3f, 0.18f, 0.13f }, {  93.1f, 0.13f, 0.18f },
};

constexpr float kHallInputGains[8] = {
    +0.98f, -1.04f, -0.96f, +1.07f,
    +0.89f, -1.05f, -1.02f, +0.95f
};
constexpr float kHallOutputGainsL[8] = {
    +0.70f, -0.55f, +0.85f, -0.45f,
    +0.90f, -0.65f, +0.60f, -0.75f
};
constexpr float kHallOutputGainsR[8] = {
    -0.45f, +0.70f, -0.85f, +0.65f,
    -0.55f, +0.85f, -0.75f, +0.55f
};
constexpr float kHallLateOutputGain = 1.0f;

// wetCalTrim is irrelevant here — processBlockHall does not consult
// kHallTuning at runtime (its own kHallEnh16WetCalTrim below is what's
// actually applied); 1.0f keeps this struct's aggregate init well-formed.
const FdnTuning kHallTuning = {
    kHallBaseDelays, kHallModRates, kHallErTaps, 10, 0.1f,
    0.45f, 1.25f, -0.08f, 1.0f, 1.4f,
    2,
    kHallInputGains, kHallOutputGainsL, kHallOutputGainsR,
    kHallLateOutputGain, 1.0f
};

// ─── Hall 16-line FDN backend (Enhanced Hall pass 1) ─────────────────────
//
// Hall now runs through a dedicated 16-line backend (processBlockHall) that
// is structurally separate from the shared 8-line enhanced FDN. The 8-line
// kHallTuning above is left in place — it is referenced by kReverbStyleTunings
// for prepare-time worst-case sizing, but processBlockHall does not consult
// it. All Hall DSP constants live in this block.
//
// Topology rationale:
//   • 16 lines × wider log spread → higher modal density, slower buildup,
//     fewer audible comb modes than the 8-line pattern.
//   • Hadamard-16 feedback (FWHT, normalised by 1/sqrt(16)=0.25) keeps the
//     loop energy-preserving and produces dense line-to-line mixing.
//   • Per-line two-stage damping cascade: a decorrelated one-pole LPF
//     (stage A, coefficient = base + per-line offset) followed by a fixed
//     HF tilt (stage B, coefficient = 0.30) gives a -12 dB/oct rolloff
//     above the per-line corner. HF energy decays substantially faster
//     than mid/low energy in the recirculation, which is what a real hall
//     does (air absorption + diffuse-field HF loss).
//   • Stereo decorrelation is achieved by 16-element output vectors with
//     mixed signs and no even/odd structure. L and R use distinct sign
//     patterns so the wet image opens up without becoming arbitrarily
//     wide.
//   • Modulation is per-line (16 LFO rates, 0.27–1.03 Hz) with a halved
//     depth scalar so the ear reads "settling air" rather than chorus.
//
// All arrays are deterministic constants; nothing here depends on runtime
// state.

constexpr int kHallNumLines = 16;

// 16 non-adjacent primes, log-spread across ~2.7× range.
//   min  = 1097 samples ≈ 22.9 ms @ 48 kHz
//   max  = 2999 samples ≈ 62.5 ms @ 48 kHz
// Inter-line ratios sit in [1.061, 1.082] — close to a smooth log spread,
// no two ratios within 0.5% of a small-integer fraction p/q (q ≤ 8).
constexpr float kHallBaseDelays16[kHallNumLines] = {
    1097.0f, 1187.0f, 1277.0f, 1373.0f,
    1481.0f, 1583.0f, 1697.0f, 1811.0f,
    1933.0f, 2069.0f, 2207.0f, 2351.0f,
    2503.0f, 2657.0f, 2819.0f, 2999.0f
};

// 16 per-line LFO rates (Hz). Values are deliberately not log-spaced
// (would create harmonic-related slow beats); chosen as a dense
// non-coherent set within 0.27–1.03 Hz. Combined with kHallEnh16ModDepthScale
// = 0.45 the depth stays sub-chorus.
constexpr float kHallModRates16[kHallNumLines] = {
    0.27f, 0.31f, 0.37f, 0.43f, 0.49f, 0.55f, 0.59f, 0.67f,
    0.71f, 0.77f, 0.83f, 0.89f, 0.91f, 0.97f, 1.01f, 1.03f
};

// Decorrelated input vector. Σ|g|² ≈ 16, so total energy injected matches
// the legacy "all-ones" 8-line case after normalisation by fdnInputGain.
constexpr float kHallInputGains16[kHallNumLines] = {
    +1.05f, -0.92f, +1.08f, -0.96f, +0.94f, -1.04f, +0.91f, +1.07f,
    -0.95f, +1.02f, -1.06f, +0.97f, -0.93f, +1.05f, -0.99f, +1.01f
};

// ── Stereo output taps (Phase 3B stereo re-derivation) ─────────────────────
// The old design summed the SAME 16 line outputs into L and R with two
// near-anti-parallel gain vectors (kHallOutputGainsL16/R16, dot product
// ≈ -0.977). Because those vectors were essentially -1×permutations of each
// other, whenever the FDN's line outputs shared a coherent component the two
// channels became a near-mirror pair and |L/R corr| pinned at ~0.9 (the last
// red test, testHallStereoDecorrelation). Merely re-signing the vectors can't
// escape that: any two fixed gain vectors over one shared source set have a
// correlation floor set by the source covariance.
//
// The fix is temporal, not just sign-based: read each line at fixed, mutually
// incommensurate offsets — distinct for L and R — so the channels hear
// decorrelated points of every line's history (the Plate's interleaved-tap
// philosophy, adapted to the 16-line FDN). This is decorrelation by
// construction that holds across presets, not the old fragile cancellation.
//
// Both primary fractions live in the HIGH band [0.72, 0.96]: the oldest point
// of a line is the most-recirculated (smoothest), so tapping near the base
// delay keeps the late tail as smooth as this de-resonanced FDN allows.
// |fracL-fracR| ≥ 0.18·base on every line gives ≥ ~4 ms L/R separation for a
// natural hall width. Both channels draw from ALL 16 lines (no center hole);
// signs balanced 8+/8- (no common-mode buildup); magnitude 0.5 ⇒ Σg²=4/channel
// (matches the old vectors' energy norm). The feedback read stays at the full
// modulated base delay, so RT60 is untouched.
//
// NOTE on tail crest: removing the resonant input diffuser (a genuine defect —
// the metallic ping) also removed the sustained resonant energy it had been
// injecting, which had artificially held the late-tail crest factor down
// (11.9 with the resonance vs ~24 without). Allpass diffusion CANNOT recover
// that number — a Schroeder allpass disperses an arrival into a discrete
// decaying echo train, which on impulsive tail content raises the crest
// metric, not lowers it (measured: 4 output allpass stages pushed crest 24 →
// 25.2). The ~24 crest is the FDN's honest, colorless late-tail character; it
// stays under testHallTailCrestFactorBounded's 25.0 ceiling and far below
// legacy Generic's 58.9. Echo density from the 16-line core is unchanged and
// the input diffusion was deepened 2 → 3 stages, so front-end density is if
// anything higher; only the (dishonest) resonant sustain is gone.
constexpr float kHallTapFracL[kHallNumLines] = {
    0.93f, 0.74f, 0.90f, 0.72f, 0.95f, 0.76f, 0.89f, 0.73f,
    0.96f, 0.78f, 0.91f, 0.72f, 0.94f, 0.77f, 0.90f, 0.75f
};
constexpr float kHallTapFracR[kHallNumLines] = {
    0.73f, 0.94f, 0.72f, 0.91f, 0.75f, 0.96f, 0.71f, 0.93f,
    0.76f, 0.96f, 0.72f, 0.90f, 0.74f, 0.96f, 0.72f, 0.93f
};
constexpr float kHallOutTapGainL[kHallNumLines] = {
    +0.50f, +0.50f, -0.50f, +0.50f, -0.50f, -0.50f, +0.50f, -0.50f,
    +0.50f, -0.50f, +0.50f, +0.50f, -0.50f, +0.50f, -0.50f, -0.50f
};
constexpr float kHallOutTapGainR[kHallNumLines] = {
    +0.50f, -0.50f, -0.50f, -0.50f, +0.50f, -0.50f, -0.50f, +0.50f,
    +0.50f, +0.50f, +0.50f, -0.50f, -0.50f, +0.50f, +0.50f, -0.50f
};

// Per-line damping offsets: each line's stage-A LPF coefficient gets
// shifted by ±0.07 from the global damping target. Decorrelated HF
// rolloff across lines is the most effective single anti-metal lever
// for an FDN — it spreads the modal HF decay times so no narrow band
// remains coherent over the tail.
constexpr float kHallDampOffsets16[kHallNumLines] = {
    -0.05f, +0.07f, -0.03f, +0.04f, -0.06f, +0.02f, -0.04f, +0.05f,
    +0.03f, -0.07f, +0.06f, -0.02f, +0.04f, -0.05f, +0.03f, -0.06f
};

// Hall-specific behaviour scalars (separate from kHallTuning, which the
// 8-line enhanced path used and is no longer consulted for Hall).
constexpr float kHallEnh16FdnInputGain   = 0.10f;
constexpr float kHallEnh16ErGainScale    = 0.45f;
constexpr float kHallEnh16LateGainScale  = 1.20f;
constexpr float kHallEnh16DampingOffset  = 0.00f;   // per-line offsets supersede the global offset
constexpr float kHallEnh16ModDepthScale  = 0.45f;   // halved vs. 8-line Hall — keeps Hall non-chorussy
constexpr float kHallEnh16DecayScale     = 1.40f;
constexpr float kHallEnh16LateOutputGain = 1.00f;
constexpr float kHallEnh16HfTiltCoeff    = 0.30f;   // stage-B fixed LPF (gentle additional HF damp per line)

// Phase 2 equal-loudness calibration: measured pink-noise wet RMS at the
// calibration setting was 0.137012 vs the Generic-enhanced reference's
// 0.123408 (+0.91 dB), giving the Phase 2 trim 0.9007.
// Phase 3B RECALIBRATION: the Hall re-tune (defective process() → true
// processAllpass() input diffusion) removed the old pairing's resonant
// amplification (|H| peaked at up to ~5.7× at its resonances), which had been
// inflating Hall's wet level. Wet RMS at the calibration setting fell to
// 0.048857 (with the old 0.9007 trim still applied) vs the Generic-enhanced
// reference 0.122857 — Hall was now ~8 dB quiet. New trim = 0.9007 ×
// (0.122857 / 0.048857) = 2.2649, restoring equal-loudness (locked by
// testReverbEqualLoudnessCalibration). The larger trim is expected: it simply
// makes up the honest level the resonance had been adding dishonestly.
constexpr float kHallEnh16WetCalTrim     = 2.2649f;

// Number of Hall ER taps — keeps processBlockHall self-contained even
// though kHallErTaps is shared with the legacy 8-line Hall tuning above.
constexpr int kHallNumErTaps = 10;

// ─── Plate backend constants — true Dattorro (JAES 1997) plate ───────────
//
// Phase 1 rewrite (see docs/plans/reverb-audit-and-redesign.md §6 Phase 1
// and §7 errata). The tank is Dattorro's cross-coupled figure-8 plate:
// two arms, four long tank delays, decay applied INSIDE each arm, tank
// modulation on the first allpass of each arm, and 7 interleaved output
// taps per channel spanning all four delays. Topology per arm:
//
//   arm_in → [damping LPF] → [modulated AP] → [delay1] → (× decay)
//                → [fixed AP2] → [delay2] → [DC blocker] → arm_out
//
//   figure-8: diffused source injects into arm A; arm A → arm B → arm A.
//
// Delays are Dattorro's plate figure (samples @ 29761 Hz) scaled to a
// 48 kHz base by ×(48000/29761) = ×1.61285; srScale = sr/48000 applies the
// final runtime-rate correction, sizeScale (0.75..1.25) scales the two long
// delays. Dattorro chose these lengths mutually incommensurate so no two
// tank delays share a comb mode; the linear scaling preserves the ratios.
//
// TWO named deviations from Dattorro's published figure (justified in the
// processBlockPlate header):
//   (1) the in-loop damping LPF is placed at the ARM INPUT (not between
//       delay1 and delay2) so every tap point is post-damping — the audit's
//       "no pre-damping taps" rule. |loop gain| is unchanged (series loop).
//   (2) the two output taps Dattorro reads from the AP2 lines are folded
//       onto the sibling delay2 line (nearby offsets) so taps span only the
//       four addressable delay lines; AllpassDiffuser hides its buffer.

constexpr int   kPlateInputDiffuserDelays[4] = { 149, 263, 421, 587 };
constexpr float kPlateInputDiffuserCoeffs[4] = { 0.65f, 0.62f, 0.68f, 0.60f };

// ── Tank arm A (Dattorro "left" half; 29761→48k values in the comment) ──
constexpr int   kPlateModApA_Delay  = 1084;   // Dattorro 672  (decay-diffusion-1, modulated)
constexpr int   kPlateDelay1A_Delay = 7182;   // Dattorro 4453
constexpr int   kPlateAp2A_Delay    = 2903;   // Dattorro 1800 (decay-diffusion-2)
constexpr int   kPlateDelay2A_Delay = 6000;   // Dattorro 3720

// ── Tank arm B (Dattorro "right" half) ──
constexpr int   kPlateModApB_Delay  = 1465;   // Dattorro 908
constexpr int   kPlateDelay1B_Delay = 6801;   // Dattorro 4217
constexpr int   kPlateAp2B_Delay    = 4283;   // Dattorro 2656
constexpr int   kPlateDelay2B_Delay = 5102;   // Dattorro 3163

// Decay-diffusion allpass coefficients. Dattorro: decayDiffusion1 = 0.70,
// decayDiffusion2 ∈ [0.25, 0.50] — we pin it at the 0.50 ceiling. Both use
// the CORRECTED unity-gain form (processAllpass); never the broken sign
// pairing (see §7 errata). Round-trip: 17169 + 17651 = 34820 samples @ 48k
// = 725 ms (≫ the 400 ms floor; ×1.25 at size 100 → 906 ms).
constexpr float kPlateDecayDiffusion1 = 0.70f;
constexpr float kPlateDecayDiffusion2 = 0.50f;

// Tank modulation — Dattorro modulates the first tank allpass ±8 samples to
// decohere regeneration (this is what kills the comb percept at long decay).
// mod_depth 0..100% maps to 0..kPlateModDepthSamples of peak excursion on
// each arm's modulated allpass; the two LFO rates are incommensurate.
constexpr float kPlateModDepthSamples = 24.0f;
constexpr float kPlateModRateA_Hz     = 0.70f;
constexpr float kPlateModRateB_Hz     = 1.13f;

// Input injection level — a LEVEL control, NOT a stability control (it scales
// the injected signal only; the recirculating loop gain is gA·gB from the
// honest-T60 relation below). See §7 errata.
constexpr float kPlateInputGain = 0.60f;

// Honest-RT60 safety ceiling on the per-arm decay gain. With the long
// Dattorro tank the per-arm gain never approaches this even at the worst
// corner (decay 30 / size 0 → ~0.94, round-trip 0.88 < 1), so stability
// comes from the exact T60 relation and the in-loop damping, not this clamp.
// It exists only as NaN/edge insurance so an extreme automated value can
// never reach unity. (Contrast the old 0.93 clamp that killed 80% of the
// decay knob.)
constexpr float kPlateDecayCeiling = 0.9995f;

// ── 7 output taps per channel across all four tank delays ──
// Offsets are Dattorro's accumulator tap table (samples @ 29761 Hz) scaled
// ×1.61285 to the 48 kHz base, then ×sizeScale×srScale at runtime. Left reads
// mostly from arm B and vice-versa (spatial interleave); the offsets differ
// per line (temporal interleave). Signs are Dattorro's. Magnitudes are all
// equal and normalized so Σg² = 1 per channel (7 taps → 1/√7 = 0.377964),
// then a single calibrated wet trim (kPlateLateOutputGain) is applied once.
// All four delays are post-damping (deviation (1) above) — no pre-damping taps.
enum PlateDelayId { PL_D1A = 0, PL_D2A = 1, PL_D1B = 2, PL_D2B = 3 };
struct PlateOutputTap { int delayId; int offsetAt48k; float sign; };

constexpr float kPlateTapMag = 0.3779645f;   // 1/sqrt(7) — normalizes Σg²=1

// Left channel accumulator (Dattorro left; AP2 taps folded onto delay2).
constexpr PlateOutputTap kPlateTapsL[7] = {
    { PL_D1B,  429, +1.0f },   // Dattorro rightDelay1 @266
    { PL_D1B, 4797, +1.0f },   //           rightDelay1 @2974
    { PL_D2B, 3086, -1.0f },   //           rightAP2    @1913 → delay2B
    { PL_D2B, 3219, +1.0f },   //           rightDelay2 @1996
    { PL_D1A, 3210, -1.0f },   //           leftDelay1  @1990
    { PL_D2A,  302, -1.0f },   //           leftAP2     @187  → delay2A
    { PL_D2A, 1719, -1.0f },   //           leftDelay2  @1066
};
// Right channel accumulator (Dattorro right).
constexpr PlateOutputTap kPlateTapsR[7] = {
    { PL_D1A,  569, +1.0f },   // Dattorro leftDelay1  @353
    { PL_D1A, 5850, +1.0f },   //           leftDelay1  @3627
    { PL_D2A, 1981, -1.0f },   //           leftAP2     @1228 → delay2A
    { PL_D2A, 4311, +1.0f },   //           leftDelay2  @2673
    { PL_D1B, 3405, -1.0f },   //           rightDelay1 @2111
    { PL_D2B,  540, -1.0f },   //           rightAP2    @335  → delay2B
    { PL_D2B,  195, -1.0f },   //           rightDelay2 @121
};
constexpr int   kPlateNumOutputTaps  = 7;
// Single calibrated wet trim. Phase 2 equal-loudness calibration (docs/plans/
// reverb-audit-and-redesign.md Phase 2): measured pink-noise wet RMS at the
// calibration setting (decay 2s/size50/damping50/mix100, 44.1kHz) with the
// Phase 1 trim (1.45) was 0.0310256 vs the Generic-enhanced reference's
// 0.123408 (-11.99 dB — Plate was still ~16% of reference level, matching
// the Phase 1 report's uncalibrated-level note). New trim = 1.45 *
// (ref/measured) = 5.7675, locked by testReverbEqualLoudnessCalibration.
constexpr float kPlateLateOutputGain = 5.7675f;

// Mode-entry wet ramp length (samples). Wet output fades 0→1 over this many
// samples after each PlateLate::reset(), preventing a click or sudden blast
// on the first block after switching to Plate. ~21 ms at 48 kHz.
static constexpr int kPlateEntryRampSamples = 1024;

// ─── Style → tuning lookup ───────────────────────────────────────────────────
// Used at prepare-time to find worst-case delay and ER tap lengths for buffer
// sizing. At runtime, processEffect() dispatches Plate to processBlockPlate()
// — the kGenericTuning pointer at index 2 is NEVER consulted for actual
// Plate DSP. Hall uses processBlockHall(), which also ignores kHallTuning at
// runtime; both are included here solely so prepareEffect() can size its
// shared buffers conservatively.
const FdnTuning* const kReverbStyleTunings[kNumReverbStyles] = {
    &kGenericTuning,   // 0 = Generic (runtime: LegacyFdn or EnhancedFdn)
    &kRoomTuning,      // 1 = Room    (runtime: EnhancedFdn)
    &kGenericTuning,   // 2 = Plate   (runtime: processBlockPlate — sizing only)
    &kHallTuning,      // 3 = Hall    (runtime: processBlockHall — sizing only)
};

} // namespace

// ─── FdnLate ─────────────────────────────────────────────────────────────────
// Owns all mutable state for the early-reflection tap network and the 8-line
// FDN late tail. Shared between the LegacyFdn and EnhancedFdn backends so
// state continuity is preserved when dispatch flips between them (e.g. when
// the user sweeps Ring Tame from 0 to 50 and back).

struct FdnLate
{
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None>
        erLine;

    std::array<juce::dsp::DelayLine<float,
        juce::dsp::DelayLineInterpolationTypes::Lagrange3rd>, 8> fdnLines;

    std::array<float, 8> dampState = {};

    std::array<float, 8> dcX       = {};
    std::array<float, 8> dcY       = {};
    float                dcR       = 0.0f;

    std::array<float, 8> modPhase  = {};

    float maxErSamplesF  = 0.0f;
    float maxFdnSamplesF = 0.0f;

    // Enhanced-only state: Hall's dedicated input diffusers (processBlockHall,
    // 211/367-sample delays) and Room's dedicated input diffusers
    // (processBlockEnhanced, 251/419-sample delays) — separate arrays so
    // the two styles' diffusion state never aliases (both are reset on style
    // switch regardless, but keeping them distinct avoids any confusion about
    // which tuning a given buffer's history belongs to).
    std::array<AllpassDiffuser, kMaxInputDiffusionStages>   inputDiffusers;
    std::array<AllpassDiffuser, kRoomInputDiffusionStages>  roomInputDiffusers;

    // ER bus decorrelation (Phase 3): single short allpass on erLine's feed,
    // shared by every non-legacy style that uses erLine (Generic-enhanced,
    // Room, Hall). See kErBusDiffuserDelayAt48k above.
    AllpassDiffuser erDiffuser;

    float erSoftStateL = 0.0f;
    float erSoftStateR = 0.0f;

    void prepare(double sampleRate, int maxBlockSize,
                 float worstCaseBaseDelaySamplesAt48k,
                 float worstCaseErTapMs)
    {
        const float sr      = static_cast<float>(sampleRate);
        const float srScale = sr / 48000.0f;

        const int maxEr =
            static_cast<int>(worstCaseErTapMs * 1.25f * 0.001 * sampleRate) + 8;
        erLine.setMaximumDelayInSamples(maxEr);
        {
            juce::dsp::ProcessSpec spec;
            spec.sampleRate       = sampleRate;
            spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
            spec.numChannels      = 1;
            erLine.prepare(spec);
            erLine.reset();
        }
        maxErSamplesF = static_cast<float>(maxEr - 1);

        const int maxFdn =
            static_cast<int>(worstCaseBaseDelaySamplesAt48k * 1.25f * srScale) + 8;
        for (int i = 0; i < 8; ++i)
        {
            fdnLines[i].setMaximumDelayInSamples(maxFdn);
            juce::dsp::ProcessSpec spec;
            spec.sampleRate       = sampleRate;
            spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
            spec.numChannels      = 1;
            fdnLines[i].prepare(spec);
            fdnLines[i].reset();
        }
        maxFdnSamplesF = static_cast<float>(maxFdn - 1);

        dcR = 1.0f - 2.0f * juce::MathConstants<float>::pi * 5.0f / sr;

        for (int d = 0; d < kMaxInputDiffusionStages; ++d)
        {
            inputDiffusers[d].prepare(
                sampleRate, maxBlockSize,
                kInputDiffusionDelaysAt48k[d],
                kInputDiffusionCoeffs[d]);
        }

        for (int d = 0; d < kRoomInputDiffusionStages; ++d)
        {
            roomInputDiffusers[d].prepare(
                sampleRate, maxBlockSize,
                kRoomInputDiffusionDelaysAt48k[d],
                kRoomInputDiffusionCoeffs[d]);
        }

        erDiffuser.prepare(sampleRate, maxBlockSize,
                            kErBusDiffuserDelayAt48k, kErBusDiffuserCoeff);

        dampState.fill(0.0f);
        dcX.fill(0.0f);
        dcY.fill(0.0f);
        modPhase.fill(0.0f);
        erSoftStateL = 0.0f;
        erSoftStateR = 0.0f;
    }

    void reset()
    {
        erLine.reset();
        for (int i = 0; i < 8; ++i)
            fdnLines[i].reset();
        for (auto& d : inputDiffusers)     d.reset();
        for (auto& d : roomInputDiffusers) d.reset();
        erDiffuser.reset();
        dampState.fill(0.0f);
        dcX.fill(0.0f);
        dcY.fill(0.0f);
        modPhase.fill(0.0f);
        erSoftStateL = 0.0f;
        erSoftStateR = 0.0f;
    }
};

// ─── HallLate ────────────────────────────────────────────────────────────────
// Dedicated 16-line FDN state for the Enhanced Hall backend. Owns its own
// delay lines + per-line filter / DC-blocker / modulation state. Pre-delay,
// the ER tap-line, and the Hall input-diffusion cascade still live in the
// shared FdnLate (no need to duplicate buffers that aren't sensitive to
// line count). All allocation is in prepare(); no heap traffic in process().

struct HallLate
{
    std::array<juce::dsp::DelayLine<float,
        juce::dsp::DelayLineInterpolationTypes::Lagrange3rd>, kHallNumLines> fdnLines;

    // Two-stage per-line damping cascade: stage A is the per-line
    // decorrelated LPF, stage B is the fixed HF tilt LPF.
    std::array<float, kHallNumLines> dampStateA = {};
    std::array<float, kHallNumLines> dampStateB = {};

    // DC blocker per line.
    std::array<float, kHallNumLines> dcX = {};
    std::array<float, kHallNumLines> dcY = {};
    float                            dcR = 0.0f;

    // Per-line modulation phase (0..1).
    std::array<float, kHallNumLines> modPhase = {};

    float maxFdnSamplesF = 0.0f;

    void prepare(double sampleRate, int maxBlockSize,
                 float worstCaseBaseDelaySamplesAt48k)
    {
        const float sr      = static_cast<float>(sampleRate);
        const float srScale = sr / 48000.0f;

        const int maxFdn =
            static_cast<int>(worstCaseBaseDelaySamplesAt48k * 1.25f * srScale) + 8;
        for (int i = 0; i < kHallNumLines; ++i)
        {
            fdnLines[i].setMaximumDelayInSamples(maxFdn);
            juce::dsp::ProcessSpec spec;
            spec.sampleRate       = sampleRate;
            spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
            spec.numChannels      = 1;
            fdnLines[i].prepare(spec);
            fdnLines[i].reset();
        }
        maxFdnSamplesF = static_cast<float>(maxFdn - 1);

        dcR = 1.0f - 2.0f * juce::MathConstants<float>::pi * 5.0f / sr;

        dampStateA.fill(0.0f);
        dampStateB.fill(0.0f);
        dcX.fill(0.0f);
        dcY.fill(0.0f);
        modPhase.fill(0.0f);
    }

    void reset()
    {
        for (auto& l : fdnLines) l.reset();
        dampStateA.fill(0.0f);
        dampStateB.fill(0.0f);
        dcX.fill(0.0f);
        dcY.fill(0.0f);
        modPhase.fill(0.0f);
    }
};

// ─── PlateLate ───────────────────────────────────────────────────────────────
// True Dattorro (JAES 1997) plate tank. Owns, per arm:
//   • damping LPF (at the arm input — deviation (1), all taps post-damping)
//   • modulated allpass  (decay-diffusion-1, Lagrange3rd, tank modulation)
//   • long delay1        (None interp; multi-tap source)
//   • fixed allpass AP2  (decay-diffusion-2, AllpassDiffuser)
//   • long delay2        (None interp; multi-tap source)
//   • DC blocker
// Plus the shared 4-stage input diffusion cascade and the cross-feed memory.
//
// The decay gain is applied inside each arm (between delay1 and AP2); it is
// NOT stored here — it is recomputed per sample from the honest-T60 relation.
// All buffers allocated in prepare(); no heap traffic in process().

struct PlateLate
{
    std::array<AllpassDiffuser, 4> inputDiffusers;

    // Modulated allpasses (decay-diffusion-1). Lagrange3rd delay line for the
    // internal "v" state; allpass arithmetic inlined in processBlockPlate.
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Lagrange3rd> modApA;
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Lagrange3rd> modApB;

    // The four long tank delays — also the source for the 7 output taps.
    // Size-scaled (0.75..1.25) at runtime; buffers cover the ×1.25 worst case.
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None> delay1A;
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None> delay2A;
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None> delay1B;
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None> delay2B;

    // Fixed allpasses (decay-diffusion-2). Not size-scaled (fixed length),
    // their length is still folded into τ so RT60 stays honest.
    AllpassDiffuser ap2A;
    AllpassDiffuser ap2B;

    // Damping LPF state per arm (one-pole, at the arm input).
    float dampStateA = 0.0f;
    float dampStateB = 0.0f;

    // DC blockers per arm.
    float dcXA = 0.0f, dcYA = 0.0f;
    float dcXB = 0.0f, dcYB = 0.0f;
    float dcR  = 0.0f;

    // Cross-feed memory: arm A consumes B's *previous-sample* output; the
    // single-sample lag resolves the compute ordering of the figure-8 loop
    // (each arm already carries thousands of samples of true delay).
    float lastB = 0.0f;

    // Modulation phases.
    float modPhaseA = 0.0f;
    float modPhaseB = 0.0f;

    // Mode-entry wet ramp counter (fades 0→1 over kPlateEntryRampSamples after
    // each reset(), i.e. on every style switch into Plate).
    int rampPos = 0;

    // Cached sample-rate-scaled bases & buffer max bounds (samples @ runtime
    // SR, size 50 — delay1/delay2 get the extra ×sizeScale at runtime).
    float modApBaseA = 0.0f, modApBaseB = 0.0f;
    float modApMaxF_A = 0.0f, modApMaxF_B = 0.0f;
    float delay1BaseA = 0.0f, delay2BaseA = 0.0f;
    float delay1BaseB = 0.0f, delay2BaseB = 0.0f;
    float delay1MaxF_A = 0.0f, delay2MaxF_A = 0.0f;
    float delay1MaxF_B = 0.0f, delay2MaxF_B = 0.0f;
    // AP2 lengths in samples @ runtime SR (fixed; used for τ / RT60).
    float ap2LenA = 0.0f, ap2LenB = 0.0f;

    // Prepare a None-interp long delay, returning its max-read float bound.
    static float prepareLongDelay(
        juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None>& line,
        const juce::dsp::ProcessSpec& spec, int base48k, float srScale)
    {
        // Cover the full delay AND every tap offset (< base) at the ×1.25
        // size ceiling, + interpolation/rounding margin.
        const int maxSamp =
            static_cast<int>(static_cast<float>(base48k) * 1.25f * srScale + 8.0f) + 4;
        line.setMaximumDelayInSamples(maxSamp);
        line.prepare(spec);
        line.reset();
        return static_cast<float>(maxSamp - 1);
    }

    void prepare(double sampleRate, int maxBlockSize)
    {
        const float sr      = static_cast<float>(sampleRate);
        const float srScale = sr / 48000.0f;

        for (int d = 0; d < 4; ++d)
            inputDiffusers[d].prepare(
                sampleRate, maxBlockSize,
                kPlateInputDiffuserDelays[d],
                kPlateInputDiffuserCoeffs[d]);

        juce::dsp::ProcessSpec spec;
        spec.sampleRate       = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
        spec.numChannels      = 1;

        // Modulated allpasses — not size-scaled; buffer covers base ± mod depth
        // (+ Lagrange margin). Modulation excursion is kPlateModDepthSamples.
        modApBaseA = static_cast<float>(kPlateModApA_Delay) * srScale;
        modApBaseB = static_cast<float>(kPlateModApB_Delay) * srScale;
        const float modExc = kPlateModDepthSamples * srScale;
        const int modApMaxA = static_cast<int>(modApBaseA + modExc + 8.0f) + 4;
        const int modApMaxB = static_cast<int>(modApBaseB + modExc + 8.0f) + 4;
        modApA.setMaximumDelayInSamples(modApMaxA);
        modApB.setMaximumDelayInSamples(modApMaxB);
        modApA.prepare(spec);  modApA.reset();
        modApB.prepare(spec);  modApB.reset();
        modApMaxF_A = static_cast<float>(modApMaxA - 1);
        modApMaxF_B = static_cast<float>(modApMaxB - 1);

        // Four long tank delays (size-scaled at runtime).
        delay1BaseA = static_cast<float>(kPlateDelay1A_Delay) * srScale;
        delay2BaseA = static_cast<float>(kPlateDelay2A_Delay) * srScale;
        delay1BaseB = static_cast<float>(kPlateDelay1B_Delay) * srScale;
        delay2BaseB = static_cast<float>(kPlateDelay2B_Delay) * srScale;
        delay1MaxF_A = prepareLongDelay(delay1A, spec, kPlateDelay1A_Delay, srScale);
        delay2MaxF_A = prepareLongDelay(delay2A, spec, kPlateDelay2A_Delay, srScale);
        delay1MaxF_B = prepareLongDelay(delay1B, spec, kPlateDelay1B_Delay, srScale);
        delay2MaxF_B = prepareLongDelay(delay2B, spec, kPlateDelay2B_Delay, srScale);

        // Fixed AP2 allpasses (own their delay buffers internally).
        ap2A.prepare(sampleRate, maxBlockSize, kPlateAp2A_Delay, kPlateDecayDiffusion2);
        ap2B.prepare(sampleRate, maxBlockSize, kPlateAp2B_Delay, kPlateDecayDiffusion2);
        ap2LenA = static_cast<float>(kPlateAp2A_Delay) * srScale;
        ap2LenB = static_cast<float>(kPlateAp2B_Delay) * srScale;

        dcR = 1.0f - 2.0f * juce::MathConstants<float>::pi * 5.0f / sr;

        dampStateA = 0.0f; dampStateB = 0.0f;
        lastB      = 0.0f;
        dcXA = 0.0f; dcYA = 0.0f;
        dcXB = 0.0f; dcYB = 0.0f;
        modPhaseA = 0.0f; modPhaseB = 0.0f;
        rampPos    = 0;
    }

    void reset()
    {
        for (auto& d : inputDiffusers) d.reset();
        modApA.reset(); modApB.reset();
        delay1A.reset(); delay2A.reset();
        delay1B.reset(); delay2B.reset();
        ap2A.reset(); ap2B.reset();
        dampStateA = 0.0f; dampStateB = 0.0f;
        lastB      = 0.0f;
        dcXA = 0.0f; dcYA = 0.0f;
        dcXB = 0.0f; dcYB = 0.0f;
        modPhaseA = 0.0f; modPhaseB = 0.0f;
        rampPos    = 0;
    }
};

// ─── XlethReverbEffect ───────────────────────────────────────────────────────

class XlethReverbEffect : public XlethEffectBase
{
public:
    XlethReverbEffect() : XlethEffectBase("reverb", createLayout())
    {
        registerSmoothedParam("decay",     SmoothType::Linear,          30.0f);
        registerSmoothedParam("size",      SmoothType::Linear,          30.0f);
        registerSmoothedParam("damping",   SmoothType::Linear,          20.0f);
        registerSmoothedParam("mod_rate",  SmoothType::Linear,          20.0f);
        registerSmoothedParam("mod_depth", SmoothType::Linear,          20.0f);
        registerSmoothedParam("er_level",  SmoothType::Linear,          20.0f);
        registerSmoothedParam("er_late",   SmoothType::Linear,          20.0f);
        registerSmoothedParam("hicut",     SmoothType::Multiplicative,  30.0f);
        registerSmoothedParam("locut",     SmoothType::Multiplicative,  30.0f);
        registerSmoothedParam("mix",       SmoothType::Linear,          20.0f);
        registerSmoothedParam("smoothness",SmoothType::Linear,          30.0f);
        // Phase 3 (docs/plans/reverb-audit-and-redesign.md §6): predelay was
        // unsmoothed and read at block rate, so dragging it live zipper-
        // clicked. Registered here for the Enhanced/Hall/Plate backends;
        // processBlockLegacy still advances-and-discards it (bit-frozen).
        registerSmoothedParam("predelay",  SmoothType::Linear,          30.0f);
    }

    // ── prepareEffect ────────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;

        predelayPtr_   = apvts_.getRawParameterValue("predelay");
        stylePtr_      = apvts_.getRawParameterValue("style");
        smoothnessPtr_ = apvts_.getRawParameterValue("smoothness");

        // Pre-delay. Two parallel lines share the same max length: predelayLine_
        // (None interpolation) stays exclusively on processBlockLegacy's raw,
        // unsmoothed atomic read (bit-frozen); predelayLineInterp_ (Linear
        // interpolation) is driven by the "predelay" smoother and used by
        // processBlockEnhanced/Hall/Plate (Phase 3).
        const int maxPredelay = static_cast<int>(0.1 * sampleRate) + 1;
        predelayLine_.setMaximumDelayInSamples(maxPredelay);
        predelayLineInterp_.setMaximumDelayInSamples(maxPredelay);
        {
            juce::dsp::ProcessSpec spec;
            spec.sampleRate       = sampleRate;
            spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
            spec.numChannels      = 1;
            predelayLine_.prepare(spec);
            predelayLine_.reset();
            predelayLineInterp_.prepare(spec);
            predelayLineInterp_.reset();
        }
        maxPredelaySamplesF_ = static_cast<float>(maxPredelay - 1);

        // FdnLate state — sized to the worst case across all styles so mid-
        // stream style swaps need no reallocation. Both backends share these
        // buffers.
        float worstBaseDelay = 0.0f;
        float worstErTapMs   = 0.0f;
        for (int s = 0; s < kNumReverbStyles; ++s)
        {
            const FdnTuning* t = kReverbStyleTunings[s];
            worstBaseDelay = std::max(worstBaseDelay, t->baseDelays[7]);
            for (int i = 0; i < t->numErTaps; ++i)
                worstErTapMs = std::max(worstErTapMs, t->erTaps[i].delayMs);
        }
        // Legacy Generic delays live outside kReverbStyleTunings (the legacy
        // backend pins to kGenericBaseDelays directly).  Including them here
        // keeps the FDN buffer correctly sized even if a future enhanced
        // tuning shrinks below the legacy maximum.
        for (int i = 0; i < 8; ++i)
            worstBaseDelay = std::max(worstBaseDelay, kGenericBaseDelays[i]);
        fdnLate_.prepare(sampleRate, maxBlockSize, worstBaseDelay, worstErTapMs);

        // HallLate — its own 16-line buffer set, sized to the Hall worst-
        // case delay (kHallBaseDelays16[15] = 2999 samples @ 48 kHz).
        hallLate_.prepare(sampleRate, maxBlockSize,
                          kHallBaseDelays16[kHallNumLines - 1]);

        // PlateLate — its own diffusion + tank delay buffers.
        plateLate_.prepare(sampleRate, maxBlockSize);

        // Output tone-shaping state
        hicutStateL_ = 0.0f;  hicutStateR_ = 0.0f;
        locutStateL_ = 0.0f;  locutStateR_ = 0.0f;
        smoothHfStateL_ = 0.0f;  smoothHfStateR_ = 0.0f;
    }

    // ── resetEffect ──────────────────────────────────────────────────────────
    void resetEffect() override
    {
        predelayLine_.reset();
        predelayLineInterp_.reset();
        fdnLate_.reset();
        hallLate_.reset();
        plateLate_.reset();

        hicutStateL_ = 0.0f;  hicutStateR_ = 0.0f;
        locutStateL_ = 0.0f;  locutStateR_ = 0.0f;
        smoothHfStateL_ = 0.0f;  smoothHfStateR_ = 0.0f;

        // A true host reset (transport stop, bypass toggle) has no meaningful
        // "held" pre-reset sample to fade from — drop any pending crossfade.
        xfadeRemaining_  = 0;
        xfadeHeldL_      = 0.0f;  xfadeHeldR_      = 0.0f;
        runningLastOutL_ = 0.0f;  runningLastOutR_ = 0.0f;
    }

    double getTailLengthSeconds() const override
    {
        const double decay = static_cast<double>(getSmoothedValue("decay"));
        const int    idx   = std::clamp(
            static_cast<int>(stylePtr_ ? stylePtr_->load(std::memory_order_relaxed) + 0.5f : 0.0f),
            0, kNumReverbStyles - 1);
        switch (static_cast<ReverbStyle>(idx))
        {
            case ReverbStyle::Plate:
                // Honest ceiling: the in-loop DC blockers + damping floor cap
                // measured RT60 at ~20.1 s even when the knob reads 30 s (see
                // testPlateRT60MonotonicWithDecay and docs/plans/reverb-audit-
                // and-redesign.md Phase 1 report). Reporting min(knob, ceiling)
                // keeps callers of getTailLengthSeconds() honest; MixEngine's
                // realtime tail drain does NOT consult this value (it drains by
                // measured output level instead — see MixEngine.cpp:33-40), so
                // this has no effect on realtime/export tail behaviour today.
                return std::min(decay, 20.1);
            case ReverbStyle::Hall:
                // Hall's decayScale silently targets 1.4x the knob's face value
                // (kHallEnh16DecayScale) — the knob reads e.g. 30 s but the
                // FDN's per-line RT60 gain is computed against 42 s. Reporting
                // the true target instead of the face value.
                return decay * static_cast<double>(kHallEnh16DecayScale);
            default:
                return decay;
        }
    }

    // Test-only accessor for the equal-power mix crossfade law (Phase 2).
    // Exposes the private static helper so test_reverb.cpp can lock the
    // dryGain^2 + wetGain^2 == 1 invariant directly, without depending on
    // audio-domain dry/wet correlation. Not part of the bridge/RPC surface.
    static void computeEqualPowerMixGainsForTest(float mixN, float& dryGain, float& wetGain)
    {
        equalPowerMixGains(mixN, dryGain, wetGain);
    }

    // ── processEffect ────────────────────────────────────────────────────────
    // Per-block style-change handling, then dispatch to one of two backends.
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        // ── Style-change detection (once per block) ──────────────────────────
        // A switch resets all FDN/ER buffers and the predelay; output tone
        // filters are intentionally preserved (style-independent). The hard
        // reset itself is unavoidable — a different style's tank state can't
        // be reinterpreted under a new topology — but its audible dropout is
        // masked below (Phase 3: docs/plans/reverb-audit-and-redesign.md §6)
        // by arming a short output crossfade.
        {
            const float rawStyle = stylePtr_
                ? stylePtr_->load(std::memory_order_relaxed) : 0.0f;
            const int   idx      = std::clamp(
                static_cast<int>(rawStyle + 0.5f), 0, kNumReverbStyles - 1);
            const ReverbStyle newStyle = static_cast<ReverbStyle>(idx);

            if (newStyle != currentStyle_)
            {
                tuning_ = kReverbStyleTunings[idx];
                predelayLine_.reset();
                predelayLineInterp_.reset();
                fdnLate_.reset();
                hallLate_.reset();
                plateLate_.reset();
                currentStyle_ = newStyle;

                // Arm the crossfade: hold the outgoing style's last actual
                // output sample (captured at the tail of the previous block,
                // below) and fade it out while the incoming style's own
                // freshly-reset (near-silent) output fades in over the same
                // window. This is a pure post-processing pass over the
                // buffer that whichever backend already produced — it needs
                // zero new state or per-sample logic INSIDE any backend
                // (Legacy included, which stays byte-identical) and reuses
                // the same "linear 0->1 ramp over N samples" idea as Plate's
                // existing entry ramp (kPlateEntryRampSamples), generalized
                // to every style and to the outgoing side too.
                //
                // Skip arming on an instance's very first block: currentStyle_
                // defaults to Generic, so a project that loads with a
                // different style already selected would otherwise see a
                // "switch" fire before any real audio ever played — fading in
                // from silence that was never audible isn't fixing a click,
                // it's just delaying the true onset (and corrupts onset-
                // transient measurements/tests that set style before the
                // first processBlock).
                if (hasProcessedBlock_)
                {
                    xfadeHeldL_ = runningLastOutL_;
                    xfadeHeldR_ = runningLastOutR_;
                    xfadeRemaining_ = kStyleXfadeSamples;
                }
            }
        }

        // ── Backend dispatch ─────────────────────────────────────────────────
        // Four-way:
        //   • Generic + smoothness=0 (raw and settled)            → Legacy
        //   • Hall    (any smoothness)                            → HallLate
        //   • Plate   (any smoothness)                            → PlateLate
        //   • Everything else (Generic w/ smoothness>0, Room)     → EnhancedFdn
        const float rawSmooth = smoothnessPtr_
            ? smoothnessPtr_->load(std::memory_order_relaxed) : 0.0f;
        const float settledSmooth = getSmoothedValue("smoothness");

        const bool useLegacy =
            (currentStyle_ == ReverbStyle::Generic)
            && (rawSmooth      == 0.0f)
            && (settledSmooth  <  1.0e-4f);

        float peakL = 0.0f, peakR = 0.0f;

        if (useLegacy)
            processBlockLegacy(buffer, peakL, peakR);
        else if (currentStyle_ == ReverbStyle::Hall)
            processBlockHall(buffer, peakL, peakR);
        else if (currentStyle_ == ReverbStyle::Plate)
            processBlockPlate(buffer, peakL, peakR);
        else
            processBlockEnhanced(buffer, peakL, peakR);

        // ── Style-switch crossfade (Phase 3) ─────────────────────────────────
        // Post-processing pass over the block the backend above just wrote.
        // A no-op whenever xfadeRemaining_ is 0 (i.e. almost always — only
        // active for kStyleXfadeSamples after a style switch), so normal
        // playback is untouched. Blends toward the held pre-switch sample so
        // the reset's discontinuity is inaudible instead of a hard cut.
        const int numSamples = buffer.getNumSamples();
        const int numCh      = buffer.getNumChannels();
        for (int s = 0; s < numSamples && xfadeRemaining_ > 0; ++s)
        {
            const float t = 1.0f - static_cast<float>(xfadeRemaining_)
                                  / static_cast<float>(kStyleXfadeSamples);
            const float newL = buffer.getSample(0, s);
            const float newR = numCh > 1 ? buffer.getSample(1, s) : newL;
            const float blendedL = newL * t + xfadeHeldL_ * (1.0f - t);
            const float blendedR = newR * t + xfadeHeldR_ * (1.0f - t);
            buffer.setSample(0, s, blendedL);
            if (numCh > 1) buffer.setSample(1, s, blendedR);
            --xfadeRemaining_;
        }
        if (numSamples > 0)
        {
            runningLastOutL_ = buffer.getSample(0, numSamples - 1);
            runningLastOutR_ = numCh > 1 ? buffer.getSample(1, numSamples - 1)
                                          : runningLastOutL_;
        }
        hasProcessedBlock_ = true;

        writeMeterValue(0, peakL);
        writeMeterValue(1, buffer.getNumChannels() > 1 ? peakR : peakL);
    }

private:
    // ─── LEGACY backend ──────────────────────────────────────────────────────
    // Bit-frozen Generic algorithm. Pinned to kGeneric* constants — does not
    // dereference tuning_, never reads/uses smoothness, never touches
    // smoothDiffusers, inputDiffusers, smoothHfState, or erSoftState.
    //
    // WARNING — DO NOT MODIFY THIS FUNCTION:
    //   This is the legacy preservation path. Any change here changes the
    //   sound of every project saved before the enhanced FDN work. Future
    //   anti-metal improvements belong in processBlockEnhanced.
    //
    //   The smoothness smoother is still advanced per sample so the smoother
    //   stays time-correlated with the audio when the user later pushes
    //   Ring Tame above 0 — but its value is discarded.
    void processBlockLegacy(juce::AudioBuffer<float>& buffer,
                            float& peakL, float& peakR)
    {
        const int   numSamples = buffer.getNumSamples();
        const int   numCh      = buffer.getNumChannels();
        const float sr         = static_cast<float>(sampleRate_);

        const float predelayMs = predelayPtr_
            ? predelayPtr_->load(std::memory_order_relaxed) : 10.0f;
        const float predelaySamples = std::clamp(
            predelayMs * 0.001f * sr, 0.0f, maxPredelaySamplesF_);

        const float srScale = sr / 48000.0f;

        for (int s = 0; s < numSamples; ++s)
        {
            const float decay    = getNextSmoothedValue("decay");
            const float size     = getNextSmoothedValue("size");
            const float damping  = getNextSmoothedValue("damping");
            const float modRate  = getNextSmoothedValue("mod_rate");
            const float modDepth = getNextSmoothedValue("mod_depth");
            const float erLevel  = getNextSmoothedValue("er_level");
            const float erLate   = getNextSmoothedValue("er_late");
            const float hicut    = getNextSmoothedValue("hicut");
            const float locut    = getNextSmoothedValue("locut");
            const float mixPct   = getNextSmoothedValue("mix");
            (void)getNextSmoothedValue("smoothness");  // advance, discard
            (void)getNextSmoothedValue("predelay");    // advance, discard — legacy
                                                        // stays on the raw unsmoothed
                                                        // atomic below (bit-frozen)

            const float inputL = buffer.getSample(0, s);
            const float inputR = numCh > 1 ? buffer.getSample(1, s) : inputL;
            const float monoIn = (inputL + inputR) * 0.5f;

            // Pre-delay
            predelayLine_.pushSample(0, monoIn);
            const float preOut = predelayLine_.popSample(0, predelaySamples);

            // Early reflections — Generic ER table only
            const float sizeScale = (size / 100.0f) * 0.5f + 0.75f;

            fdnLate_.erLine.pushSample(0, preOut);

            float erL = 0.0f, erR = 0.0f;
            for (int t = 0; t < kGenericNumErTaps; ++t)
            {
                const float tapSamples = std::clamp(
                    kGenericErTaps[t].delayMs * 0.001f * sr * sizeScale,
                    0.0f, fdnLate_.maxErSamplesF);
                const float tapVal = fdnLate_.erLine.popSample(
                    0, tapSamples, t == kGenericNumErTaps - 1);
                erL += tapVal * kGenericErTaps[t].gainL;
                erR += tapVal * kGenericErTaps[t].gainR;
            }

            // Late FDN — Generic constants, identity scalars
            const float dampG     = std::clamp(damping / 100.0f, 0.0f, 0.95f);
            const float modAmt    = (modDepth / 100.0f) * 3.0f;
            const float safeDecay = std::max(decay, 0.1f);
            const float modRateFrac = modRate / 100.0f;

            float fdnOut[8];
            for (int i = 0; i < 8; ++i)
            {
                const float baseDelay = kGenericBaseDelays[i] * sizeScale * srScale;

                const float lfoVal = std::sin(
                    2.0f * juce::MathConstants<float>::pi * fdnLate_.modPhase[i]);
                fdnLate_.modPhase[i] += kGenericModRates[i] * modRateFrac / sr;
                if (fdnLate_.modPhase[i] >= 1.0f) fdnLate_.modPhase[i] -= 1.0f;

                const float modulatedDelay = std::clamp(
                    baseDelay + lfoVal * modAmt, 1.0f, fdnLate_.maxFdnSamplesF);

                fdnOut[i] = fdnLate_.fdnLines[i].popSample(0, modulatedDelay, true);
            }

            float h[8];
            for (int i = 0; i < 8; ++i) h[i] = fdnOut[i];
            hadamard8(h);

            for (int i = 0; i < 8; ++i)
            {
                fdnLate_.dampState[i] =
                    (1.0f - dampG) * h[i] + dampG * fdnLate_.dampState[i];

                const float delaySeconds =
                    (kGenericBaseDelays[i] * sizeScale * srScale) / sr;
                const float g = std::pow(10.0f,
                    -3.0f * delaySeconds / safeDecay);

                const float fbSample = fdnLate_.dampState[i] * g;

                const float dcOut =
                    fbSample - fdnLate_.dcX[i] + fdnLate_.dcR * fdnLate_.dcY[i];
                fdnLate_.dcX[i] = fbSample;
                fdnLate_.dcY[i] = dcOut;

                fdnLate_.fdnLines[i].pushSample(
                    0, dcOut + preOut * kGenericFdnInputGain);
            }

            const float fdnL = fdnOut[0] + fdnOut[2] + fdnOut[4] + fdnOut[6];
            const float fdnR = fdnOut[1] + fdnOut[3] + fdnOut[5] + fdnOut[7];

            float wetL = erL  * (erLevel / 100.0f)
                       + fdnL * (erLate  / 100.0f);
            float wetR = erR  * (erLevel / 100.0f)
                       + fdnR * (erLate  / 100.0f);

            // Output tone shaping (hi-cut → lo-cut)
            const float hcCoeff = std::exp(
                -2.0f * juce::MathConstants<float>::pi * hicut / sr);
            hicutStateL_ = hcCoeff * hicutStateL_ + (1.0f - hcCoeff) * wetL;
            hicutStateR_ = hcCoeff * hicutStateR_ + (1.0f - hcCoeff) * wetR;

            const float lcCoeff = std::exp(
                -2.0f * juce::MathConstants<float>::pi * locut / sr);
            locutStateL_ += (1.0f - lcCoeff) * (hicutStateL_ - locutStateL_);
            locutStateR_ += (1.0f - lcCoeff) * (hicutStateR_ - locutStateR_);
            wetL = hicutStateL_ - locutStateL_;
            wetR = hicutStateR_ - locutStateR_;

            const float mixN = mixPct / 100.0f;
            buffer.setSample(0, s, inputL * (1.0f - mixN) + wetL * mixN);
            if (numCh > 1)
                buffer.setSample(1, s, inputR * (1.0f - mixN) + wetR * mixN);

            peakL = std::max(peakL, std::abs(wetL));
            peakR = std::max(peakR, std::abs(wetR));
        }
    }

    // ─── ENHANCED backend ────────────────────────────────────────────────────
    // Pass 1 anti-metal pipeline. Each style's FdnTuning supplies:
    //   • a log-spread non-adjacent-prime delay set (baseDelays)
    //   • a signed/decorrelated per-line input vector (inputGains)
    //   • style-specific output vectors L/R (outputGainsL / outputGainsR)
    //   • a lateOutputGain for residual wet-level normalisation
    //
    // The output of this backend is no longer bit-identical to the legacy
    // backend even at kGenericTuning + smoothness=0 — the new I/O vectors
    // diverge structurally. Generic + smoothness=0 therefore continues to
    // dispatch to processBlockLegacy so projects that pre-date the enhanced
    // FDN work load with their original character intact.
    //
    // Future passes (scattering, multiband attenuation, alternate matrices,
    // 16-line FDN) all land in this function without touching the legacy
    // backend above.
    void processBlockEnhanced(juce::AudioBuffer<float>& buffer,
                              float& peakL, float& peakR)
    {
        const int   numSamples = buffer.getNumSamples();
        const int   numCh      = buffer.getNumChannels();
        const float sr         = static_cast<float>(sampleRate_);

        const FdnTuning* const t = tuning_;

        for (int s = 0; s < numSamples; ++s)
        {
            const float decay    = getNextSmoothedValue("decay");
            const float size     = getNextSmoothedValue("size");
            const float damping  = getNextSmoothedValue("damping");
            const float modRate  = getNextSmoothedValue("mod_rate");
            const float modDepth = getNextSmoothedValue("mod_depth");
            const float erLevel  = getNextSmoothedValue("er_level");
            const float erLate   = getNextSmoothedValue("er_late");
            const float hicut    = getNextSmoothedValue("hicut");
            const float locut    = getNextSmoothedValue("locut");
            const float mixPct   = getNextSmoothedValue("mix");
            const float smoothPct= getNextSmoothedValue("smoothness");
            // Phase 3: predelay is now sample-smoothed (30 ms Linear) and read
            // through an interpolated delay line, so dragging it live no
            // longer zipper-clicks (contrast processBlockLegacy above, which
            // stays on the raw unsmoothed/uninterpolated read).
            const float predelayMs = getNextSmoothedValue("predelay");
            const float predelaySamples = std::clamp(
                predelayMs * 0.001f * sr, 0.0f, maxPredelaySamplesF_);

            const float smoothFrac = std::clamp(smoothPct * 0.01f, 0.0f, 1.0f);

            const float inputL = buffer.getSample(0, s);
            const float inputR = numCh > 1 ? buffer.getSample(1, s) : inputL;
            const float monoIn = (inputL + inputR) * 0.5f;

            // Pre-delay
            predelayLineInterp_.pushSample(0, monoIn);
            const float preOut = predelayLineInterp_.popSample(0, predelaySamples);

            // Optional input diffusion (FDN feed only). Within this shared
            // backend only Room sets inputDiffusionStages > 0 (Hall has its
            // own dedicated processBlockHall path and never reaches here;
            // Generic stays at 0, the calibration reference). Uses the
            // CORRECTED unity-gain allpass pairing (processAllpass) per the
            // ground rule that no new code may wire the legacy sign-broken
            // process() pairing — see AllpassDiffuser's docs and §7 errata.
            float fdnIn = preOut;
            for (int d = 0; d < t->inputDiffusionStages; ++d)
                fdnIn = fdnLate_.roomInputDiffusers[d].processAllpass(fdnIn);

            // Early reflections. The shared ER bus feed is diffused through a
            // single short allpass (Phase 3) before hitting the tap line, so
            // the discrete tap arrivals read as an already-smeared cluster
            // rather than one clean impulse.
            const float sizeScale = (size / 100.0f) * 0.5f + 0.75f;
            fdnLate_.erLine.pushSample(0, fdnLate_.erDiffuser.processAllpass(preOut));

            float erL = 0.0f, erR = 0.0f;
            for (int ti = 0; ti < t->numErTaps; ++ti)
            {
                const float tapSamples = std::clamp(
                    t->erTaps[ti].delayMs * 0.001f * sr * sizeScale,
                    0.0f, fdnLate_.maxErSamplesF);
                const float tapVal = fdnLate_.erLine.popSample(
                    0, tapSamples, ti == t->numErTaps - 1);
                erL += tapVal * t->erTaps[ti].gainL;
                erR += tapVal * t->erTaps[ti].gainR;
            }

            // Late FDN
            const float srScale = sr / 48000.0f;
            const float dampG   = std::clamp(
                damping / 100.0f + t->dampingOffset
                                 + smoothFrac * 0.20f,
                0.0f, 0.95f);
            const float modAmt    = (modDepth / 100.0f) * 3.0f * t->modDepthScale;
            const float safeDecay = std::max(decay, 0.1f) * t->decayScale;
            const float modRateFrac = modRate / 100.0f;

            float fdnOut[8];
            for (int i = 0; i < 8; ++i)
            {
                const float baseDelay = t->baseDelays[i] * sizeScale * srScale;

                const float lfoVal = std::sin(
                    2.0f * juce::MathConstants<float>::pi * fdnLate_.modPhase[i]);
                fdnLate_.modPhase[i] += t->modRates[i] * modRateFrac / sr;
                if (fdnLate_.modPhase[i] >= 1.0f) fdnLate_.modPhase[i] -= 1.0f;

                const float modulatedDelay = std::clamp(
                    baseDelay + lfoVal * modAmt, 1.0f, fdnLate_.maxFdnSamplesF);

                fdnOut[i] = fdnLate_.fdnLines[i].popSample(0, modulatedDelay, true);
            }

            float h[8];
            for (int i = 0; i < 8; ++i) h[i] = fdnOut[i];
            hadamard8(h);

            for (int i = 0; i < 8; ++i)
            {
                fdnLate_.dampState[i] =
                    (1.0f - dampG) * h[i] + dampG * fdnLate_.dampState[i];

                const float delaySeconds =
                    (t->baseDelays[i] * sizeScale * srScale) / sr;
                const float g = std::pow(10.0f,
                    -3.0f * delaySeconds / safeDecay);

                const float fbSample = fdnLate_.dampState[i] * g;

                const float dcOut =
                    fbSample - fdnLate_.dcX[i] + fdnLate_.dcR * fdnLate_.dcY[i];
                fdnLate_.dcX[i] = fbSample;
                fdnLate_.dcY[i] = dcOut;

                // Per-line input vector breaks equal excitation across the
                // 8 lines (signs/magnitudes vary per tuning).  Total injected
                // energy is normalised so wet level matches the legacy path.
                fdnLate_.fdnLines[i].pushSample(
                    0, dcOut + fdnIn * t->fdnInputGain * t->inputGains[i]);
            }

            // Style-specific output vectors replace the legacy even/odd
            // routing.  Each channel is a decorrelated weighted sum of all 8
            // lines, multiplied by the tuning's lateOutputGain for residual
            // level normalisation.
            float fdnL = 0.0f, fdnR = 0.0f;
            for (int i = 0; i < 8; ++i)
            {
                fdnL += fdnOut[i] * t->outputGainsL[i];
                fdnR += fdnOut[i] * t->outputGainsR[i];
            }
            fdnL *= t->lateOutputGain;
            fdnR *= t->lateOutputGain;

            // ER softening — wet contribution multiplied by smoothFrac
            constexpr float kErSoft = 0.62f;
            fdnLate_.erSoftStateL = (1.0f - kErSoft) * erL
                                   + kErSoft * fdnLate_.erSoftStateL;
            fdnLate_.erSoftStateR = (1.0f - kErSoft) * erR
                                   + kErSoft * fdnLate_.erSoftStateR;
            const float erBlend = smoothFrac * 0.5f;
            erL = erL + (fdnLate_.erSoftStateL - erL) * erBlend;
            erR = erR + (fdnLate_.erSoftStateR - erR) * erBlend;

            float wetL = (erL  * (erLevel / 100.0f) * t->erGainScale
                        + fdnL * (erLate  / 100.0f) * t->lateGainScale) * t->wetCalTrim;
            float wetR = (erR  * (erLevel / 100.0f) * t->erGainScale
                        + fdnR * (erLate  / 100.0f) * t->lateGainScale) * t->wetCalTrim;

            // SMOOTH HF shelf
            constexpr float kSmoothShelfK = 0.45f;
            smoothHfStateL_ = (1.0f - kSmoothShelfK) * wetL
                             + kSmoothShelfK * smoothHfStateL_;
            smoothHfStateR_ = (1.0f - kSmoothShelfK) * wetR
                             + kSmoothShelfK * smoothHfStateR_;
            const float shelfBlend = smoothFrac * 0.45f;
            wetL += (smoothHfStateL_ - wetL) * shelfBlend;
            wetR += (smoothHfStateR_ - wetR) * shelfBlend;

            // Output tone shaping
            const float hcCoeff = std::exp(
                -2.0f * juce::MathConstants<float>::pi * hicut / sr);
            hicutStateL_ = hcCoeff * hicutStateL_ + (1.0f - hcCoeff) * wetL;
            hicutStateR_ = hcCoeff * hicutStateR_ + (1.0f - hcCoeff) * wetR;

            const float lcCoeff = std::exp(
                -2.0f * juce::MathConstants<float>::pi * locut / sr);
            locutStateL_ += (1.0f - lcCoeff) * (hicutStateL_ - locutStateL_);
            locutStateR_ += (1.0f - lcCoeff) * (hicutStateR_ - locutStateR_);
            wetL = hicutStateL_ - locutStateL_;
            wetR = hicutStateR_ - locutStateR_;

            const float mixN = mixPct / 100.0f;
            float dryGain, wetGain;
            equalPowerMixGains(mixN, dryGain, wetGain);
            buffer.setSample(0, s, inputL * dryGain + wetL * wetGain);
            if (numCh > 1)
                buffer.setSample(1, s, inputR * dryGain + wetR * wetGain);

            peakL = std::max(peakL, std::abs(wetL));
            peakR = std::max(peakR, std::abs(wetR));
        }
    }

    // ─── HALL backend ────────────────────────────────────────────────────────
    // Dedicated Enhanced Hall pass-1 backend. 16-line FDN with Hadamard-16
    // feedback, per-line two-stage damping (decorrelated stage A + fixed
    // HF tilt stage B), 16-element decorrelated input/output vectors, and
    // 16 mod-rate sinusoids at sub-chorus depth.
    //
    // Shares with the other backends:
    //   • predelayLine_       — pre-delay
    //   • fdnLate_.erLine     — ER tap line (sized for worst-case ER tap)
    //   • fdnLate_.inputDiffusers — 3-stage Schroeder allpass on the FDN feed
    //   • output tone-shaping (hicut/locut)
    //   • smoothness ER softening + HF shelf state
    //
    // Owns exclusively:
    //   • hallLate_.fdnLines[16]  — Lagrange-3 16 delay lines
    //   • hallLate_.dampStateA/B  — two-stage per-line damping
    //   • hallLate_.dcX/dcY       — per-line DC blockers
    //   • hallLate_.modPhase      — per-line LFO phase
    void processBlockHall(juce::AudioBuffer<float>& buffer,
                          float& peakL, float& peakR)
    {
        const int   numSamples = buffer.getNumSamples();
        const int   numCh      = buffer.getNumChannels();
        const float sr         = static_cast<float>(sampleRate_);
        const float srScale    = sr / 48000.0f;

        for (int s = 0; s < numSamples; ++s)
        {
            const float decay    = getNextSmoothedValue("decay");
            const float size     = getNextSmoothedValue("size");
            const float damping  = getNextSmoothedValue("damping");
            const float modRate  = getNextSmoothedValue("mod_rate");
            const float modDepth = getNextSmoothedValue("mod_depth");
            const float erLevel  = getNextSmoothedValue("er_level");
            const float erLate   = getNextSmoothedValue("er_late");
            const float hicut    = getNextSmoothedValue("hicut");
            const float locut    = getNextSmoothedValue("locut");
            const float mixPct   = getNextSmoothedValue("mix");
            const float smoothPct= getNextSmoothedValue("smoothness");
            const float predelayMs = getNextSmoothedValue("predelay");   // Phase 3
            const float predelaySamples = std::clamp(
                predelayMs * 0.001f * sr, 0.0f, maxPredelaySamplesF_);

            const float smoothFrac = std::clamp(smoothPct * 0.01f, 0.0f, 1.0f);

            const float inputL = buffer.getSample(0, s);
            const float inputR = numCh > 1 ? buffer.getSample(1, s) : inputL;
            const float monoIn = (inputL + inputR) * 0.5f;

            // Pre-delay
            predelayLineInterp_.pushSample(0, monoIn);
            const float preOut = predelayLineInterp_.popSample(0, predelaySamples);

            // Hall input diffusion (2-stage Schroeder allpass).
            // Smooths the FDN feed; ER tap line still reads preOut directly so
            // discrete reflection events stay punctate. Phase 3B: migrated from
            // the defective process() pairing to processAllpass() — the old
            // pairing H(z)=(z^-D - g)/(1 + g·z^-D) is NOT an allpass, its
            // magnitude peaks at (1+g)/(1-g) ≈ 3.4-4.7x at resonant frequencies
            // (root-caused in 80f58e9), so transients picked up a metallic
            // resonant ping. This is feed-forward (no loop), so it was never a
            // stability issue — only coloration — and was left byte-identical
            // through Phases 1-3A solely because Hall's tuning leaned on it.
            // processAllpass() is the true |H|=1 Schroeder allpass: same echo
            // dispersal, no resonant coloration. See §7 errata.
            float fdnIn = preOut;
            for (int d = 0; d < kMaxInputDiffusionStages; ++d)
                fdnIn = fdnLate_.inputDiffusers[d].processAllpass(fdnIn);

            // Early reflections — Hall ER table (10 taps), shared erLine. The
            // feed is diffused through the same single short allpass (Phase 3)
            // as processBlockEnhanced uses, ahead of the tap reads.
            const float sizeScale = (size / 100.0f) * 0.5f + 0.75f;
            fdnLate_.erLine.pushSample(0, fdnLate_.erDiffuser.processAllpass(preOut));

            float erL = 0.0f, erR = 0.0f;
            for (int t = 0; t < kHallNumErTaps; ++t)
            {
                const float tapSamples = std::clamp(
                    kHallErTaps[t].delayMs * 0.001f * sr * sizeScale,
                    0.0f, fdnLate_.maxErSamplesF);
                const float tapVal = fdnLate_.erLine.popSample(
                    0, tapSamples, t == kHallNumErTaps - 1);
                erL += tapVal * kHallErTaps[t].gainL;
                erR += tapVal * kHallErTaps[t].gainR;
            }

            // ── 16-line FDN ──────────────────────────────────────────────────
            // Stage-A base damping coefficient. Smoothness contributes the
            // global +0.20 boost AND widens the per-line offset spread by
            // 1.5× at smoothness=100, so Ring Tame doesn't only "darken"
            // Hall — it also pushes per-line HF decay times further apart,
            // which is the actual anti-metal axis.
            const float baseDamp      = damping / 100.0f
                                        + kHallEnh16DampingOffset
                                        + smoothFrac * 0.20f;
            const float offsetScale   = 1.0f + smoothFrac * 0.5f;
            const float modAmt        = (modDepth / 100.0f) * 3.0f
                                        * kHallEnh16ModDepthScale;
            const float safeDecay     = std::max(decay, 0.1f) * kHallEnh16DecayScale;
            const float modRateFrac   = modRate / 100.0f;
            constexpr float kHfTilt   = kHallEnh16HfTiltCoeff;

            // Pop modulated samples from all 16 lines, and — in the same pass —
            // read each line's two decorrelated stereo output taps.
            //
            // Tap-read ordering (verified against juce_DelayLine): popSample
            // reads relative to readPos and only advances readPos when
            // updateReadPointer=true. Both output taps (false) are therefore
            // issued BEFORE this line's single feedback read (true), so all
            // three read relative to the SAME readPos — exactly the Plate's
            // interleaved-tap contract. The feedback read is byte-for-byte
            // unchanged (same modulatedDelay, same true-read, same push
            // below), so the FDN loop — hence RT60 and stability — is untouched.
            float fdnOut[kHallNumLines];
            float fdnL = 0.0f, fdnR = 0.0f;
            for (int i = 0; i < kHallNumLines; ++i)
            {
                const float baseDelay = kHallBaseDelays16[i] * sizeScale * srScale;

                // Stereo output taps (fixed, incommensurate per-line offsets).
                // Both false-reads issue at the current readPos before the
                // single feedback read (true) advances it.
                const float tapDelayL = std::clamp(
                    baseDelay * kHallTapFracL[i], 1.0f, hallLate_.maxFdnSamplesF);
                const float tapDelayR = std::clamp(
                    baseDelay * kHallTapFracR[i], 1.0f, hallLate_.maxFdnSamplesF);
                fdnL += hallLate_.fdnLines[i].popSample(0, tapDelayL, false)
                        * kHallOutTapGainL[i];
                fdnR += hallLate_.fdnLines[i].popSample(0, tapDelayR, false)
                        * kHallOutTapGainR[i];

                const float lfoVal = std::sin(
                    2.0f * juce::MathConstants<float>::pi * hallLate_.modPhase[i]);
                hallLate_.modPhase[i] += kHallModRates16[i] * modRateFrac / sr;
                if (hallLate_.modPhase[i] >= 1.0f) hallLate_.modPhase[i] -= 1.0f;

                const float modulatedDelay = std::clamp(
                    baseDelay + lfoVal * modAmt, 1.0f, hallLate_.maxFdnSamplesF);

                fdnOut[i] = hallLate_.fdnLines[i].popSample(0, modulatedDelay, true);
            }
            fdnL *= kHallEnh16LateOutputGain;
            fdnR *= kHallEnh16LateOutputGain;

            // Hadamard-16 in place.
            float h[kHallNumLines];
            for (int i = 0; i < kHallNumLines; ++i) h[i] = fdnOut[i];
            hadamard16(h);

            // Per-line two-stage damping cascade → RT60 gain → DC block → push.
            for (int i = 0; i < kHallNumLines; ++i)
            {
                // Stage A — per-line decorrelated LPF.
                const float dampA = std::clamp(
                    baseDamp + kHallDampOffsets16[i] * offsetScale,
                    0.0f, 0.95f);
                hallLate_.dampStateA[i] =
                    (1.0f - dampA) * h[i] + dampA * hallLate_.dampStateA[i];

                // Stage B — fixed HF tilt LPF (gentle 2nd one-pole). Cumulative
                // -12 dB/oct rolloff above the per-line corner means HF energy
                // decays meaningfully faster than mid/low energy in the loop.
                hallLate_.dampStateB[i] =
                    (1.0f - kHfTilt) * hallLate_.dampStateA[i]
                    + kHfTilt * hallLate_.dampStateB[i];

                // RT60 decay gain (per-line — uses the line's actual delay).
                const float delaySeconds =
                    (kHallBaseDelays16[i] * sizeScale * srScale) / sr;
                const float g = std::pow(10.0f,
                    -3.0f * delaySeconds / safeDecay);

                const float fbSample = hallLate_.dampStateB[i] * g;

                // DC blocker.
                const float dcOut =
                    fbSample - hallLate_.dcX[i] + hallLate_.dcR * hallLate_.dcY[i];
                hallLate_.dcX[i] = fbSample;
                hallLate_.dcY[i] = dcOut;

                // Push: feedback + decorrelated input vector contribution.
                hallLate_.fdnLines[i].pushSample(
                    0, dcOut + fdnIn * kHallEnh16FdnInputGain
                                     * kHallInputGains16[i]);
            }

            // fdnL / fdnR were already accumulated from the interleaved stereo
            // output taps in the pop loop above (Phase 3B). No post-push output
            // mixing here — the old 16-element anti-parallel weighted sums have
            // been replaced by the temporal-tap design.

            // ER softening (smoothness wet contribution).
            constexpr float kErSoft = 0.62f;
            fdnLate_.erSoftStateL = (1.0f - kErSoft) * erL
                                   + kErSoft * fdnLate_.erSoftStateL;
            fdnLate_.erSoftStateR = (1.0f - kErSoft) * erR
                                   + kErSoft * fdnLate_.erSoftStateR;
            const float erBlend = smoothFrac * 0.5f;
            erL = erL + (fdnLate_.erSoftStateL - erL) * erBlend;
            erR = erR + (fdnLate_.erSoftStateR - erR) * erBlend;

            float wetL = (erL  * (erLevel / 100.0f) * kHallEnh16ErGainScale
                        + fdnL * (erLate  / 100.0f) * kHallEnh16LateGainScale) * kHallEnh16WetCalTrim;
            float wetR = (erR  * (erLevel / 100.0f) * kHallEnh16ErGainScale
                        + fdnR * (erLate  / 100.0f) * kHallEnh16LateGainScale) * kHallEnh16WetCalTrim;

            // SMOOTH HF shelf on wet output.
            constexpr float kSmoothShelfK = 0.45f;
            smoothHfStateL_ = (1.0f - kSmoothShelfK) * wetL
                             + kSmoothShelfK * smoothHfStateL_;
            smoothHfStateR_ = (1.0f - kSmoothShelfK) * wetR
                             + kSmoothShelfK * smoothHfStateR_;
            const float shelfBlend = smoothFrac * 0.45f;
            wetL += (smoothHfStateL_ - wetL) * shelfBlend;
            wetR += (smoothHfStateR_ - wetR) * shelfBlend;

            // Output tone shaping.
            const float hcCoeff = std::exp(
                -2.0f * juce::MathConstants<float>::pi * hicut / sr);
            hicutStateL_ = hcCoeff * hicutStateL_ + (1.0f - hcCoeff) * wetL;
            hicutStateR_ = hcCoeff * hicutStateR_ + (1.0f - hcCoeff) * wetR;

            const float lcCoeff = std::exp(
                -2.0f * juce::MathConstants<float>::pi * locut / sr);
            locutStateL_ += (1.0f - lcCoeff) * (hicutStateL_ - locutStateL_);
            locutStateR_ += (1.0f - lcCoeff) * (hicutStateR_ - locutStateR_);
            wetL = hicutStateL_ - locutStateL_;
            wetR = hicutStateR_ - locutStateR_;

            const float mixN = mixPct / 100.0f;
            float dryGain, wetGain;
            equalPowerMixGains(mixN, dryGain, wetGain);
            buffer.setSample(0, s, inputL * dryGain + wetL * wetGain);
            if (numCh > 1)
                buffer.setSample(1, s, inputR * dryGain + wetR * wetGain);

            peakL = std::max(peakL, std::abs(wetL));
            peakR = std::max(peakR, std::abs(wetR));
        }
    }

    // ─── PLATE backend — true Dattorro (JAES 1997) plate ────────────────────
    // Phase 1 rewrite. Cross-coupled figure-8 tank, four long delays, honest
    // T60, tank modulation, 7 interleaved post-damping taps per channel.
    //
    //   predelay → 4-stage input diffusion (er_level = bloom blend) →
    //     inject into arm A. Single loop A→B→A:
    //
    //   arm: in → [damping LPF] → [mod AP] → [delay1] → (× decay g)
    //            → [AP2] → [delay2] → [DC blocker] → out
    //
    //   figure-8: armA_in = diffused·inputGain + lastB(=prev armB_out);
    //             armB_in = armA_out(this sample); lastB = armB_out.
    //   Each arm carries thousands of samples of true delay; the single-sample
    //   lastB lag only fixes the compute order of the two halves.
    //
    // Honest T60: the decay gain is applied ONCE per arm (between delay1 and
    // AP2). Per-arm gain g = 10^(-3·τ_arm/T60) where τ_arm is the arm's ACTUAL
    // runtime traversal time (mod-AP + delay1 + AP2 + delay2, size-scaled). Over
    // a full round trip the gain is gA·gB = 10^(-3·(τA+τB)/T60) = 10^(-3·τ_rt/T60)
    // — an exact 60 dB drop per T60 seconds, monotonic across the full 0.1–30 s
    // knob with NO dead zone. With the 725 ms Dattorro round trip, gA·gB stays
    // well below 1 even at decay 30 / size 0 (~0.88) → unconditional decay; the
    // ceiling clamp (kPlateDecayCeiling) never engages in the knob range and is
    // pure NaN insurance. Stability is PROVEN BY MEASUREMENT — see the
    // decay×size×damping×mod grid test testPlatePerRoundTripGainUnderUnity.
    //
    // TWO named deviations from Dattorro's published figure:
    //   (1) The in-loop damping one-pole sits at the ARM INPUT rather than
    //       between delay1 and delay2. In a series loop |H| is the product of
    //       the element magnitudes, so LPF position does not change the loop
    //       gain or RT60 — but it makes ALL four delays (and hence every output
    //       tap) post-damping, satisfying the audit's "no pre-damping taps"
    //       rule (the old plate's bright-spike defect). Decay gain stays inside
    //       the arm between delay1 and AP2 per the spec.
    //   (2) The two taps Dattorro reads from the AP2 (decay-diffusion-2) lines
    //       are folded onto the sibling delay2 line at nearby offsets, so the 7
    //       taps span only the four addressable delay lines (AllpassDiffuser
    //       hides its buffer). All other tap offsets/signs are Dattorro's.
    //
    // Style-specific parameter mapping (unchanged surface):
    //   er_level  — input diffusion / front-bloom blend (NOT room ER taps)
    //   er_late   — tank tail level
    //   damping   — in-loop HF damping
    //   decay     — honest RT60 of the round-trip path
    //   size      — scales the two long tank delays + tap offsets (±25%)
    //   mod_*     — tank modulation on each arm's first allpass (decoheres the
    //               comb; ±kPlateModDepthSamples at mod_depth=100%)
    //   smoothness — raises damping AND drives the wet HF shelf
    void processBlockPlate(juce::AudioBuffer<float>& buffer,
                           float& peakL, float& peakR)
    {
        const int   numSamples = buffer.getNumSamples();
        const int   numCh      = buffer.getNumChannels();
        const float sr         = static_cast<float>(sampleRate_);
        const float srScale    = sr / 48000.0f;

        PlateLate& P = plateLate_;

        // NOTE on tap reads: JUCE's DelayLine reads relative to readPos, which
        // advances only on the ONE popSample(...,true) call per line per sample.
        // Every tapRead below (updateReadPointer=false) is therefore issued
        // BEFORE that line's single main read, or it would be off by one sample.

        for (int s = 0; s < numSamples; ++s)
        {
            const float decay    = getNextSmoothedValue("decay");
            const float size     = getNextSmoothedValue("size");
            const float damping  = getNextSmoothedValue("damping");
            const float modRate  = getNextSmoothedValue("mod_rate");
            const float modDepth = getNextSmoothedValue("mod_depth");
            const float erLevel  = getNextSmoothedValue("er_level");   // input bloom amount
            const float erLate   = getNextSmoothedValue("er_late");    // tank tail level
            const float hicut    = getNextSmoothedValue("hicut");
            const float locut    = getNextSmoothedValue("locut");
            const float mixPct   = getNextSmoothedValue("mix");
            const float smoothPct= getNextSmoothedValue("smoothness");
            const float predelayMs = getNextSmoothedValue("predelay");   // Phase 3
            const float predelaySamples = std::clamp(
                predelayMs * 0.001f * sr, 0.0f, maxPredelaySamplesF_);

            const float smoothFrac = std::clamp(smoothPct * 0.01f, 0.0f, 1.0f);

            const float inputL = buffer.getSample(0, s);
            const float inputR = numCh > 1 ? buffer.getSample(1, s) : inputL;
            const float monoIn = (inputL + inputR) * 0.5f;

            // Pre-delay (Phase 3: smoothed/interpolated line, shared with the
            // Enhanced and Hall backends)
            predelayLineInterp_.pushSample(0, monoIn);
            const float preOut = predelayLineInterp_.popSample(0, predelaySamples);

            // ── Input diffusion (4 stages) ───────────────────────────────────
            float diffused = preOut;
            for (int d = 0; d < 4; ++d)
                diffused = P.inputDiffusers[d].processAllpass(diffused);
            const float bloomBlend = std::clamp(erLevel / 100.0f, 0.0f, 1.0f);
            diffused = preOut * (1.0f - bloomBlend) + diffused * bloomBlend;

            // ── Tank coefficients (per sample; size + decay are smoothed) ─────
            const float sizeScale = (size / 100.0f) * 0.5f + 0.75f;
            const float scl       = sizeScale * srScale;

            // In-loop HF damping one-pole (at arm input). A light floor keeps
            // some HF loss even at damping=0 without touching low-mid modes.
            const float dampG = std::clamp(
                0.05f + (damping / 100.0f) * 0.55f + smoothFrac * 0.20f,
                0.0f, 0.9f);

            // Size-scaled long-delay read lengths.
            const float len1A = std::clamp(P.delay1BaseA * sizeScale, 1.0f, P.delay1MaxF_A);
            const float len2A = std::clamp(P.delay2BaseA * sizeScale, 1.0f, P.delay2MaxF_A);
            const float len1B = std::clamp(P.delay1BaseB * sizeScale, 1.0f, P.delay1MaxF_B);
            const float len2B = std::clamp(P.delay2BaseB * sizeScale, 1.0f, P.delay2MaxF_B);

            // Honest per-arm decay gains. τ_arm = actual traversal time (mod-AP
            // + delay1 + AP2 + delay2) at the runtime SR; g = 10^(-3·τ/T60).
            const float tauA = (P.modApBaseA + len1A + P.ap2LenA + len2A) / sr;
            const float tauB = (P.modApBaseB + len1B + P.ap2LenB + len2B) / sr;
            const float safeDecay = std::max(decay, 0.1f);
            const float gA = std::clamp(
                std::pow(10.0f, -3.0f * tauA / safeDecay), 0.0f, kPlateDecayCeiling);
            const float gB = std::clamp(
                std::pow(10.0f, -3.0f * tauB / safeDecay), 0.0f, kPlateDecayCeiling);

            // Tank modulation excursion (samples @ runtime SR) + LFO rate frac.
            const float modAmt      = (modDepth / 100.0f) * kPlateModDepthSamples * srScale;
            const float modRateFrac = modRate / 100.0f;
            const float c1          = kPlateDecayDiffusion1;

            auto tapRead = [&](juce::dsp::DelayLine<float,
                                 juce::dsp::DelayLineInterpolationTypes::None>& line,
                               float off48, float maxF) -> float
            {
                return line.popSample(0,
                    std::clamp(off48 * scl, 0.0f, maxF), false);
            };

            // ── Arm A ────────────────────────────────────────────────────────
            const float armA_in = diffused * kPlateInputGain + P.lastB;
            P.dampStateA = (1.0f - dampG) * armA_in + dampG * P.dampStateA;
            const float xA = P.dampStateA;

            // Modulated allpass A (decay-diffusion-1).
            const float lfoA = std::sin(
                2.0f * juce::MathConstants<float>::pi * P.modPhaseA);
            P.modPhaseA += kPlateModRateA_Hz * modRateFrac / sr;
            if (P.modPhaseA >= 1.0f) P.modPhaseA -= 1.0f;
            const float modDelayA = std::clamp(
                P.modApBaseA + lfoA * modAmt, 1.0f, P.modApMaxF_A);
            const float delayedVA = P.modApA.popSample(0, modDelayA, true);
            const float vA = xA + c1 * delayedVA;      // CORRECTED unity allpass (+ sign)
            P.modApA.pushSample(0, vA);
            const float mA = -c1 * vA + delayedVA;

            // delay1 A — push, taps (false), then the single main read (true).
            P.delay1A.pushSample(0, mA);
            const float La_d1a = tapRead(P.delay1A, 3210.0f, P.delay1MaxF_A); // L
            const float Ra0_d1a = tapRead(P.delay1A, 569.0f, P.delay1MaxF_A); // R
            const float Ra1_d1a = tapRead(P.delay1A, 5850.0f, P.delay1MaxF_A);// R
            const float d1A = P.delay1A.popSample(0, len1A, true);

            // Decay gain INSIDE the arm (between delay1 and AP2).
            const float afterDecayA = d1A * gA;
            const float a2A = P.ap2A.processAllpass(afterDecayA);

            // delay2 A — push, taps (false), main (true).
            P.delay2A.pushSample(0, a2A);
            const float La0_d2a = tapRead(P.delay2A, 302.0f,  P.delay2MaxF_A);// L
            const float La1_d2a = tapRead(P.delay2A, 1719.0f, P.delay2MaxF_A);// L
            const float Ra0_d2a = tapRead(P.delay2A, 1981.0f, P.delay2MaxF_A);// R
            const float Ra1_d2a = tapRead(P.delay2A, 4311.0f, P.delay2MaxF_A);// R
            const float d2A = P.delay2A.popSample(0, len2A, true);

            // DC blocker A → arm output.
            const float dcOutA = d2A - P.dcXA + P.dcR * P.dcYA;
            P.dcXA = d2A; P.dcYA = dcOutA;
            const float armA_out = dcOutA;

            // ── Arm B ────────────────────────────────────────────────────────
            const float armB_in = armA_out;
            P.dampStateB = (1.0f - dampG) * armB_in + dampG * P.dampStateB;
            const float xB = P.dampStateB;

            const float lfoB = std::sin(
                2.0f * juce::MathConstants<float>::pi * P.modPhaseB);
            P.modPhaseB += kPlateModRateB_Hz * modRateFrac / sr;
            if (P.modPhaseB >= 1.0f) P.modPhaseB -= 1.0f;
            const float modDelayB = std::clamp(
                P.modApBaseB + lfoB * modAmt, 1.0f, P.modApMaxF_B);
            const float delayedVB = P.modApB.popSample(0, modDelayB, true);
            const float vB = xB + c1 * delayedVB;
            P.modApB.pushSample(0, vB);
            const float mB = -c1 * vB + delayedVB;

            P.delay1B.pushSample(0, mB);
            const float La0_d1b = tapRead(P.delay1B, 429.0f,  P.delay1MaxF_B);// L
            const float La1_d1b = tapRead(P.delay1B, 4797.0f, P.delay1MaxF_B);// L
            const float Ra_d1b  = tapRead(P.delay1B, 3405.0f, P.delay1MaxF_B);// R
            const float d1B = P.delay1B.popSample(0, len1B, true);

            const float afterDecayB = d1B * gB;
            const float a2B = P.ap2B.processAllpass(afterDecayB);

            P.delay2B.pushSample(0, a2B);
            const float La0_d2b = tapRead(P.delay2B, 3086.0f, P.delay2MaxF_B);// L
            const float La1_d2b = tapRead(P.delay2B, 3219.0f, P.delay2MaxF_B);// L
            const float Ra0_d2b = tapRead(P.delay2B, 540.0f,  P.delay2MaxF_B);// R
            const float Ra1_d2b = tapRead(P.delay2B, 195.0f,  P.delay2MaxF_B);// R
            const float d2B = P.delay2B.popSample(0, len2B, true);

            const float dcOutB = d2B - P.dcXB + P.dcR * P.dcYB;
            P.dcXB = d2B; P.dcYB = dcOutB;
            const float armB_out = dcOutB;

            // Non-finite guard — reset the tank and pass dry for this sample
            // rather than feeding garbage back into the loop. Never taken in use.
            if (!std::isfinite(armA_out) || !std::isfinite(armB_out))
            {
                P.reset();
                const float mixN = mixPct / 100.0f;
                float mixDryGain, mixWetGain;
                equalPowerMixGains(mixN, mixDryGain, mixWetGain);
                buffer.setSample(0, s, inputL * mixDryGain);
                if (numCh > 1) buffer.setSample(1, s, inputR * mixDryGain);
                continue;
            }

            // Cross-feed store for next sample's arm A.
            P.lastB = armB_out;

            // ── 7-tap stereo output (Σg²=1 per channel, single trim) ─────────
            // Signs are Dattorro's accumulator; left reads mostly arm B, right
            // reads mostly arm A (spatial interleave).
            float plateL = kPlateTapMag * (
                  La0_d1b + La1_d1b            // + rightDelay1 @266,@2974
                - La0_d2b + La1_d2b            // - rightAP2 @1913, + rightDelay2 @1996
                - La_d1a                       // - leftDelay1 @1990
                - La0_d2a - La1_d2a            // - leftAP2 @187, - leftDelay2 @1066
                ) * kPlateLateOutputGain;

            float plateR = kPlateTapMag * (
                  Ra0_d1a + Ra1_d1a            // + leftDelay1 @353,@3627
                - Ra0_d2a + Ra1_d2a            // - leftAP2 @1228, + leftDelay2 @2673
                - Ra_d1b                       // - rightDelay1 @2111
                - Ra0_d2b - Ra1_d2b            // - rightAP2 @335, - rightDelay2 @121
                ) * kPlateLateOutputGain;

            // ── Wet output stage (shared with the FDN backends) ──────────────
            if (!std::isfinite(plateL)) plateL = 0.0f;
            if (!std::isfinite(plateR)) plateR = 0.0f;

            const float wetGain = erLate / 100.0f;
            float wetL = plateL * wetGain;
            float wetR = plateR * wetGain;

            // Mode-entry wet ramp (fades 0→1 over kPlateEntryRampSamples).
            if (P.rampPos < kPlateEntryRampSamples)
            {
                const float rampGain = static_cast<float>(P.rampPos)
                                      / static_cast<float>(kPlateEntryRampSamples);
                wetL *= rampGain;
                wetR *= rampGain;
                ++P.rampPos;
            }

            // SMOOTH HF shelf on wet output (shared with FDN backends).
            constexpr float kSmoothShelfK = 0.45f;
            smoothHfStateL_ = (1.0f - kSmoothShelfK) * wetL
                             + kSmoothShelfK * smoothHfStateL_;
            smoothHfStateR_ = (1.0f - kSmoothShelfK) * wetR
                             + kSmoothShelfK * smoothHfStateR_;
            const float shelfBlend = smoothFrac * 0.45f;
            wetL += (smoothHfStateL_ - wetL) * shelfBlend;
            wetR += (smoothHfStateR_ - wetR) * shelfBlend;

            // Output tone shaping (shared hicut/locut).
            const float hcCoeff = std::exp(
                -2.0f * juce::MathConstants<float>::pi * hicut / sr);
            hicutStateL_ = hcCoeff * hicutStateL_ + (1.0f - hcCoeff) * wetL;
            hicutStateR_ = hcCoeff * hicutStateR_ + (1.0f - hcCoeff) * wetR;

            const float lcCoeff = std::exp(
                -2.0f * juce::MathConstants<float>::pi * locut / sr);
            locutStateL_ += (1.0f - lcCoeff) * (hicutStateL_ - locutStateL_);
            locutStateR_ += (1.0f - lcCoeff) * (hicutStateR_ - locutStateR_);
            wetL = hicutStateL_ - locutStateL_;
            wetR = hicutStateR_ - locutStateR_;

            const float mixN = mixPct / 100.0f;
            float mixDryGain, mixWetGain;
            equalPowerMixGains(mixN, mixDryGain, mixWetGain);
            buffer.setSample(0, s, inputL * mixDryGain + wetL * mixWetGain);
            if (numCh > 1)
                buffer.setSample(1, s, inputR * mixDryGain + wetR * mixWetGain);

            peakL = std::max(peakL, std::abs(wetL));
            peakR = std::max(peakR, std::abs(wetR));
        }
    }

    // ── Parameter layout ─────────────────────────────────────────────────────
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout()
    {
        using Apf = juce::AudioParameterFloat;
        using Pid = juce::ParameterID;
        using Nar = juce::NormalisableRange<float>;

        return {
            std::make_unique<Apf>(Pid{"decay",     1}, "Decay",
                Nar{0.1f,    30.0f,    0.0f, 0.3f  }, 2.0f,     "s"),
            std::make_unique<Apf>(Pid{"predelay",  1}, "Pre-delay",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 10.0f,    "ms"),
            std::make_unique<Apf>(Pid{"size",      1}, "Size",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 50.0f,    "%"),
            std::make_unique<Apf>(Pid{"damping",   1}, "Damping",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 50.0f,    "%"),
            std::make_unique<Apf>(Pid{"mod_rate",  1}, "Mod Rate",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 30.0f,    "%"),
            std::make_unique<Apf>(Pid{"mod_depth", 1}, "Mod Depth",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 20.0f,    "%"),
            std::make_unique<Apf>(Pid{"er_level",  1}, "ER Level",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 50.0f,    "%"),
            std::make_unique<Apf>(Pid{"er_late",   1}, "Late Level",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 50.0f,    "%"),
            std::make_unique<Apf>(Pid{"hicut",     1}, "Hi Cut",
                Nar{1000.0f, 20000.0f, 0.0f, 0.23f }, 12000.0f, "Hz"),
            std::make_unique<Apf>(Pid{"locut",     1}, "Lo Cut",
                Nar{20.0f,   500.0f,   0.0f, 0.3f  }, 80.0f,    "Hz"),
            std::make_unique<Apf>(Pid{"mix",       1}, "Mix",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 30.0f,    "%"),
            // smoothness — APVTS id retained for save/load compatibility.
            // UI surfaces this as "RING TAME". Default 0 keeps old projects
            // bit-identical: the dispatch in processEffect routes Generic +
            // smoothness=0 to the LegacyFdn backend.
            std::make_unique<Apf>(Pid{"smoothness",1}, "Ring Tame",
                Nar{0.0f,    100.0f,   0.0f, 1.0f  }, 0.0f,     "%"),
            std::make_unique<juce::AudioParameterChoice>(
                Pid{"style", 1},
                "Style",
                juce::StringArray{"Generic", "Room", "Plate", "Hall"},
                static_cast<int>(ReverbStyle::Generic)),
        };
    }

    // ── Equal-power (constant-power) mix crossfade ───────────────────────────
    // Phase 2 (docs/plans/reverb-audit-and-redesign.md Phase 2): replaces the
    // linear crossfade's -6 dB center dip with a √-law pairing where
    // dryGain² + wetGain² == 1 at every mix position, so perceived loudness
    // stays constant as mix is automated. The +3 dB level shift at mix≈50%
    // vs. the old linear law is INTENTIONAL — it's why this ships in the same
    // phase as the wet-level calibration above. Used by every non-legacy
    // backend (Enhanced/Hall/Plate); processBlockLegacy keeps its linear
    // crossfade untouched (bit-frozen).
    static inline void equalPowerMixGains(float mixN, float& dryGain, float& wetGain)
    {
        dryGain = std::sqrt(std::max(0.0f, 1.0f - mixN));
        wetGain = std::sqrt(std::max(0.0f, mixN));
    }

    // ── Hadamard 8×8 via Fast Walsh-Hadamard Transform (in-place) ────────────
    static inline void hadamard8(float* v)
    {
        float a0 = v[0] + v[1], a1 = v[0] - v[1],
              a2 = v[2] + v[3], a3 = v[2] - v[3],
              a4 = v[4] + v[5], a5 = v[4] - v[5],
              a6 = v[6] + v[7], a7 = v[6] - v[7];
        float b0 = a0 + a2, b1 = a1 + a3, b2 = a0 - a2, b3 = a1 - a3,
              b4 = a4 + a6, b5 = a5 + a7, b6 = a4 - a6, b7 = a5 - a7;
        v[0] = b0 + b4;  v[1] = b1 + b5;  v[2] = b2 + b6;  v[3] = b3 + b7;
        v[4] = b0 - b4;  v[5] = b1 - b5;  v[6] = b2 - b6;  v[7] = b3 - b7;
        constexpr float scale = 1.0f / 2.8284271247f;
        for (int i = 0; i < 8; ++i) v[i] *= scale;
    }

    // ── Hadamard 16×16 via Fast Walsh-Hadamard Transform (in-place) ──────────
    // Four butterfly stages (stride 1, 2, 4, 8) + 1/sqrt(16)=0.25 normalisation.
    // Energy-preserving and unconditionally stable as an FDN feedback matrix.
    static inline void hadamard16(float* v)
    {
        // Stage 0 — stride 1
        for (int i = 0; i < 16; i += 2)
        {
            const float x = v[i], y = v[i + 1];
            v[i] = x + y;  v[i + 1] = x - y;
        }
        // Stage 1 — stride 2
        for (int i = 0; i < 16; i += 4)
        {
            for (int j = 0; j < 2; ++j)
            {
                const float x = v[i + j], y = v[i + j + 2];
                v[i + j] = x + y;  v[i + j + 2] = x - y;
            }
        }
        // Stage 2 — stride 4
        for (int i = 0; i < 16; i += 8)
        {
            for (int j = 0; j < 4; ++j)
            {
                const float x = v[i + j], y = v[i + j + 4];
                v[i + j] = x + y;  v[i + j + 4] = x - y;
            }
        }
        // Stage 3 — stride 8
        for (int j = 0; j < 8; ++j)
        {
            const float x = v[j], y = v[j + 8];
            v[j] = x + y;  v[j + 8] = x - y;
        }
        // Normalise
        constexpr float scale = 0.25f;  // 1 / sqrt(16)
        for (int i = 0; i < 16; ++i) v[i] *= scale;
    }

    // Active enhanced-path tuning (defaults to Generic). The legacy path does
    // not consult this pointer.
    const FdnTuning* tuning_ = &kGenericTuning;

    // ── Style selector ───────────────────────────────────────────────────────
    std::atomic<float>* stylePtr_      = nullptr;
    std::atomic<float>* smoothnessPtr_ = nullptr;
    ReverbStyle         currentStyle_  = ReverbStyle::Generic;

    // ── Pre-delay ────────────────────────────────────────────────────────────
    std::atomic<float>* predelayPtr_ = nullptr;
    // Legacy-only: None interpolation, raw unsmoothed atomic read (bit-frozen).
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None>
        predelayLine_;
    // Enhanced/Hall/Plate (Phase 3): Linear interpolation, driven by the
    // "predelay" smoother — kills the zipper-click when dragging live.
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear>
        predelayLineInterp_;
    float maxPredelaySamplesF_ = 0.0f;

    // ── Shared FDN state ─────────────────────────────────────────────────────
    FdnLate fdnLate_;

    // ── Hall-only 16-line FDN state ──────────────────────────────────────────
    // Used exclusively by processBlockHall. Allocated in prepareEffect, reset
    // on every style switch.
    HallLate hallLate_;

    // ── Plate-only tank state ────────────────────────────────────────────────
    // Used exclusively by processBlockPlate. Allocated in prepareEffect, reset
    // on every style switch.
    PlateLate plateLate_;

    // ── Output tone-shaping filter state ─────────────────────────────────────
    float hicutStateL_ = 0.0f, hicutStateR_ = 0.0f;
    float locutStateL_ = 0.0f, locutStateR_ = 0.0f;
    float smoothHfStateL_ = 0.0f, smoothHfStateR_ = 0.0f;

    // ── Style-switch click-free transition (Phase 3) ─────────────────────────
    // See processEffect()'s style-change-detection block. A pure output-level
    // crossfade applied after backend dispatch; touches no backend internals.
    static constexpr int kStyleXfadeSamples = 1440;   // ~30ms @48k / ~32.7ms @44.1k
    float xfadeHeldL_      = 0.0f, xfadeHeldR_      = 0.0f;   // pre-switch held sample
    int   xfadeRemaining_  = 0;                                // 0 = no crossfade active
    float runningLastOutL_ = 0.0f, runningLastOutR_ = 0.0f;    // last sample of the block just written
    bool  hasProcessedBlock_ = false;   // true once processEffect has run at least once

    // ── State ─────────────────────────────────────────────────────────────────
    double sampleRate_ = 44100.0;
};
