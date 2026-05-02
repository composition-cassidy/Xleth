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
// Two internal backends share the same state buffers but are dispatched
// independently per block:
//
//   • LegacyFdn — bit-frozen Generic algorithm. Used ONLY when style ==
//     Generic AND the smoothness ("Ring Tame") parameter is exactly 0
//     (raw and smoothed). Hardcoded to kGenericTuning constants. No
//     anti-metal processing of any kind. Future enhancement passes MUST
//     NOT modify this path — it exists so projects saved before any
//     anti-metal work loaded with smoothness=0 reproduce their original
//     sound exactly.
//
//   • EnhancedFdn — used for Room, Hall, Plate, AND for Generic when
//     smoothness > 0. Pass 1 (this revision) replaces the legacy
//     consecutive-prime delay cluster with log-spread non-adjacent primes,
//     swaps equal per-line input excitation for signed/decorrelated input
//     vectors, and replaces the even/odd output split with style-specific
//     mixed-sign output vectors L/R. Hadamard feedback, damping, and
//     modulation behaviour are unchanged from the previous pass; future
//     passes will add scattering / multiband attenuation / alternate
//     matrices behind this same backend boundary.
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

    inline float process(float x)
    {
        const float delayed = line.popSample(0,
            static_cast<float>(delaySamples), true);
        const float v = x - coeff * delayed;
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
};

// Maximum allpass stages on the FDN input path. Only Hall currently uses
// non-zero stages (2). Generic, Room, and Plate set 0, so the diffusion loop
// in the enhanced backend runs zero iterations.
static constexpr int kMaxInputDiffusionStages = 2;

// ─── Style enumeration ───────────────────────────────────────────────────────
// Discrete topology selector exposed as the "style" APVTS choice parameter.
// Plate currently routes to the Generic placeholder tuning (a real Dattorro-
// inspired plate backend is intentionally deferred).
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

// Hall input-diffusion table — only consumed when a tuning sets
// inputDiffusionStages > 0.
constexpr int   kInputDiffusionDelaysAt48k[kMaxInputDiffusionStages] = { 211, 367 };
constexpr float kInputDiffusionCoeffs    [kMaxInputDiffusionStages] = { 0.625f, 0.700f };

// SMOOTH-driven diffuser cascade — currently allocated/processed but its
// wet contribution is not mixed into the FDN feed (see history: short
// 197/313 sample delays caused audible comb resonances). Kept here as a
// reserved slot for a future DIFFUSE control inside the EnhancedFdn backend.
static constexpr int   kSmoothDiffusionStages = 2;
constexpr int   kSmoothDiffusionDelaysAt48k[kSmoothDiffusionStages] = { 197, 313 };
constexpr float kSmoothDiffusionCoeffs     [kSmoothDiffusionStages] = { 0.600f, 0.550f };

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
    kEnhGenericLateOutputGain
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

const FdnTuning kRoomTuning = {
    kRoomBaseDelays, kRoomModRates, kRoomErTaps, 8, 0.1f,
    1.15f, 0.75f, 0.15f, 0.45f, 0.75f,
    0,
    kRoomInputGains, kRoomOutputGainsL, kRoomOutputGainsR,
    kRoomLateOutputGain
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

const FdnTuning kHallTuning = {
    kHallBaseDelays, kHallModRates, kHallErTaps, 10, 0.1f,
    0.45f, 1.25f, -0.08f, 1.0f, 1.4f,
    2,
    kHallInputGains, kHallOutputGainsL, kHallOutputGainsR,
    kHallLateOutputGain
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

// Output mixing vectors. Σg² ≈ 4 per channel keeps wet RMS comparable to
// the legacy 4-line sum. L and R use distinct sign patterns for stereo
// decorrelation; no even/odd structure.
constexpr float kHallOutputGainsL16[kHallNumLines] = {
    +0.55f, -0.45f, +0.50f, -0.60f, +0.40f, -0.55f, +0.50f, -0.45f,
    +0.60f, -0.50f, +0.45f, -0.55f, +0.50f, -0.40f, +0.55f, -0.50f
};
constexpr float kHallOutputGainsR16[kHallNumLines] = {
    -0.45f, +0.60f, -0.50f, +0.40f, -0.55f, +0.50f, -0.45f, +0.55f,
    -0.50f, +0.45f, -0.60f, +0.50f, -0.55f, +0.50f, -0.40f, +0.55f
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

// Number of Hall ER taps — keeps processBlockHall self-contained even
// though kHallErTaps is shared with the legacy 8-line Hall tuning above.
constexpr int kHallNumErTaps = 10;

// ─── Plate backend constants (Dattorro/Griesinger-inspired, original) ────
//
// The Plate topology is intentionally NOT an FDN. It is a pair of
// cross-coupled allpass-and-delay chains forming a single long feedback
// path that traverses both arms in turn. That path looks like:
//
//   diffused → arm A: [modulated AP] → [long delay] → [damping LPF] → [fixed AP] →
//                            ↓
//             arm B: [modulated AP] → [long delay] → [damping LPF] → [fixed AP] →
//                            ↓
//                          (× decay) → back into arm A
//
// All arrays here are deterministic. Delays and coefficients were chosen
// to be coprime with every other delay in the file (FDN, Hall ER, Hall
// input diffusion, the abandoned smoothness allpass pair) so no two
// systems share a comb mode. Allpass coefficients sit in 0.55–0.68 — well
// below the 0.9+ region where allpasses themselves start to ring.

constexpr int   kPlateInputDiffuserDelays[4] = { 149, 263, 421, 587 };
constexpr float kPlateInputDiffuserCoeffs[4] = { 0.65f, 0.62f, 0.68f, 0.60f };

// Tank arm A
constexpr int   kPlateModApA_BaseDelay = 359;     // ~7.5 ms @ 48 kHz
constexpr float kPlateModApA_Coeff     = 0.55f;
constexpr int   kPlateLongA_Delay      = 1721;    // ~35.9 ms
constexpr int   kPlateFixedApA_Delay   = 877;     // ~18.3 ms
constexpr float kPlateFixedApA_Coeff   = 0.62f;

// Tank arm B
constexpr int   kPlateModApB_BaseDelay = 461;     // ~9.6 ms
constexpr float kPlateModApB_Coeff     = 0.58f;
constexpr int   kPlateLongB_Delay      = 1979;    // ~41.2 ms
constexpr int   kPlateFixedApB_Delay   = 1031;    // ~21.5 ms
constexpr float kPlateFixedApB_Coeff   = 0.65f;

// Tank-wide
constexpr float kPlateModDepthSamples  = 3.0f;    // peak ±3 samples LFO depth
constexpr float kPlateModDepthScalar   = 0.5f;    // halves user mod_depth — Plate stays non-chorussy
constexpr float kPlateModRateA_Hz      = 0.43f;
constexpr float kPlateModRateB_Hz      = 0.71f;
constexpr float kPlateInputGain        = 0.6f;    // scales diffused signal entering tank

// 6 stereo output taps (3 per arm) at deterministic positions inside the
// long delay lines.  Σg² ≈ 1.3 per channel × kPlateLateOutputGain — the
// tank's recirculating energy is much higher than a single FDN line, so
// modest tap gains plus an output trim land Plate at a comparable wet
// level to the 8-line FDN styles.
struct PlateOutputTap
{
    int   armIndex;       // 0 = arm A long delay, 1 = arm B long delay
    int   delaySamplesAt48k;
    float gainL;
    float gainR;
};

constexpr PlateOutputTap kPlateOutputTaps[6] = {
    { 0,  271,  +0.55f, -0.40f },
    { 0, 1019,  -0.40f, +0.55f },
    { 0, 1453,  +0.50f, -0.45f },
    { 1,  353,  -0.45f, +0.60f },
    { 1, 1109,  +0.50f, -0.40f },
    { 1, 1487,  -0.35f, +0.50f },
};
constexpr int   kPlateNumOutputTaps   = 6;
constexpr float kPlateLateOutputGain  = 0.55f;     // overall tap-bus trim

// ─── Style → tuning lookup ───────────────────────────────────────────────────
// Plate currently routes to Generic — Plate needs its own non-FDN backend
// (Dattorro-inspired allpass plate) which is intentionally deferred.
const FdnTuning* const kReverbStyleTunings[kNumReverbStyles] = {
    &kGenericTuning,   // 0 = Generic
    &kRoomTuning,      // 1 = Room
    &kGenericTuning,   // 2 = Plate — placeholder
    &kHallTuning,      // 3 = Hall
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

    // Enhanced-only state: input diffusers (Hall) and SMOOTH-reserved diffusers.
    std::array<AllpassDiffuser, kMaxInputDiffusionStages> inputDiffusers;
    std::array<AllpassDiffuser, kSmoothDiffusionStages>   smoothDiffusers;

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

        for (int d = 0; d < kSmoothDiffusionStages; ++d)
        {
            smoothDiffusers[d].prepare(
                sampleRate, maxBlockSize,
                kSmoothDiffusionDelaysAt48k[d],
                kSmoothDiffusionCoeffs[d]);
        }

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
        for (auto& d : inputDiffusers)  d.reset();
        for (auto& d : smoothDiffusers) d.reset();
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
// Dedicated Dattorro/Griesinger-inspired plate tank. Owns:
//   • 4-stage input diffusion cascade
//   • per-arm modulated allpass (Lagrange3rd interpolation)
//   • per-arm long delay line (no interpolation; modulation lives in the
//     modulated allpass stage instead)
//   • per-arm fixed-delay Schroeder allpass
//   • per-arm damping LPF state
//   • per-arm DC blocker
//   • per-arm modulation phase + cross-feed memory
//
// All buffers allocated in prepare(); no heap traffic in process().

struct PlateLate
{
    std::array<AllpassDiffuser, 4> inputDiffusers;

    // Modulated allpasses — implemented as a Lagrange3rd delay line for the
    // internal "v" state plus a fixed coefficient. The allpass arithmetic
    // is inlined in processBlockPlate.
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Lagrange3rd> modApA;
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Lagrange3rd> modApB;

    // Long delay lines — also serve as the source for the 6 output taps,
    // hence sized to comfortably cover both the line's full delay and the
    // largest tap offset (× 1.25 size headroom × srScale).
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None> longA;
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None> longB;

    // Fixed allpasses — the existing AllpassDiffuser type fits exactly.
    AllpassDiffuser fixedApA;
    AllpassDiffuser fixedApB;

    // Damping LPF state per arm.
    float dampStateA = 0.0f;
    float dampStateB = 0.0f;

    // DC blockers per arm.
    float dcXA = 0.0f, dcYA = 0.0f;
    float dcXB = 0.0f, dcYB = 0.0f;
    float dcR  = 0.0f;

    // Cross-feed memory: arm A consumes B's *previous* output and arm B
    // consumes A's *current-sample* output. The lastB store provides the
    // single-sample delay that breaks the otherwise instantaneous loop.
    float lastB = 0.0f;

    // Modulation phases.
    float modPhaseA = 0.0f;
    float modPhaseB = 0.0f;

    // Cached sample-rate-scaled bases & buffer max bounds.
    float modApBaseA  = 0.0f;
    float modApBaseB  = 0.0f;
    float modApMaxF_A = 0.0f;
    float modApMaxF_B = 0.0f;
    float longBaseA   = 0.0f;
    float longBaseB   = 0.0f;
    float longMaxF_A  = 0.0f;
    float longMaxF_B  = 0.0f;

    void prepare(double sampleRate, int maxBlockSize)
    {
        const float sr      = static_cast<float>(sampleRate);
        const float srScale = sr / 48000.0f;

        for (int d = 0; d < 4; ++d)
        {
            inputDiffusers[d].prepare(
                sampleRate, maxBlockSize,
                kPlateInputDiffuserDelays[d],
                kPlateInputDiffuserCoeffs[d]);
        }

        juce::dsp::ProcessSpec spec;
        spec.sampleRate       = sampleRate;
        spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
        spec.numChannels      = 1;

        // Modulated allpasses — buffer covers base ± mod depth.
        modApBaseA = static_cast<float>(kPlateModApA_BaseDelay) * srScale;
        modApBaseB = static_cast<float>(kPlateModApB_BaseDelay) * srScale;
        const int modApMaxA =
            static_cast<int>(modApBaseA + kPlateModDepthSamples + 8.0f) + 4;
        const int modApMaxB =
            static_cast<int>(modApBaseB + kPlateModDepthSamples + 8.0f) + 4;
        modApA.setMaximumDelayInSamples(modApMaxA);
        modApB.setMaximumDelayInSamples(modApMaxB);
        modApA.prepare(spec);  modApA.reset();
        modApB.prepare(spec);  modApB.reset();
        modApMaxF_A = static_cast<float>(modApMaxA - 1);
        modApMaxF_B = static_cast<float>(modApMaxB - 1);

        // Long delays — sized for max(line delay, longest tap offset) × 1.25
        // size headroom × srScale.
        const float worstLongA = static_cast<float>(std::max(
            kPlateLongA_Delay, kPlateOutputTaps[2].delaySamplesAt48k));   // largest A-tap = 1453
        const float worstLongB = static_cast<float>(std::max(
            kPlateLongB_Delay, kPlateOutputTaps[5].delaySamplesAt48k));   // largest B-tap = 1487
        longBaseA = static_cast<float>(kPlateLongA_Delay) * srScale;
        longBaseB = static_cast<float>(kPlateLongB_Delay) * srScale;
        const int longMaxA = static_cast<int>(worstLongA * 1.25f * srScale + 8.0f) + 4;
        const int longMaxB = static_cast<int>(worstLongB * 1.25f * srScale + 8.0f) + 4;
        longA.setMaximumDelayInSamples(longMaxA);
        longB.setMaximumDelayInSamples(longMaxB);
        longA.prepare(spec);  longA.reset();
        longB.prepare(spec);  longB.reset();
        longMaxF_A = static_cast<float>(longMaxA - 1);
        longMaxF_B = static_cast<float>(longMaxB - 1);

        // Fixed allpasses (own their delay buffers internally).
        fixedApA.prepare(sampleRate, maxBlockSize,
                         kPlateFixedApA_Delay, kPlateFixedApA_Coeff);
        fixedApB.prepare(sampleRate, maxBlockSize,
                         kPlateFixedApB_Delay, kPlateFixedApB_Coeff);

        dcR = 1.0f - 2.0f * juce::MathConstants<float>::pi * 5.0f / sr;

        dampStateA = 0.0f; dampStateB = 0.0f;
        lastB      = 0.0f;
        dcXA = 0.0f; dcYA = 0.0f;
        dcXB = 0.0f; dcYB = 0.0f;
        modPhaseA = 0.0f; modPhaseB = 0.0f;
    }

    void reset()
    {
        for (auto& d : inputDiffusers) d.reset();
        modApA.reset(); modApB.reset();
        longA.reset();  longB.reset();
        fixedApA.reset(); fixedApB.reset();
        dampStateA = 0.0f; dampStateB = 0.0f;
        lastB      = 0.0f;
        dcXA = 0.0f; dcYA = 0.0f;
        dcXB = 0.0f; dcYB = 0.0f;
        modPhaseA = 0.0f; modPhaseB = 0.0f;
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
    }

    // ── prepareEffect ────────────────────────────────────────────────────────
    void prepareEffect(double sampleRate, int maxBlockSize) override
    {
        sampleRate_ = sampleRate;

        predelayPtr_   = apvts_.getRawParameterValue("predelay");
        stylePtr_      = apvts_.getRawParameterValue("style");
        smoothnessPtr_ = apvts_.getRawParameterValue("smoothness");

        // Pre-delay
        const int maxPredelay = static_cast<int>(0.1 * sampleRate) + 1;
        predelayLine_.setMaximumDelayInSamples(maxPredelay);
        {
            juce::dsp::ProcessSpec spec;
            spec.sampleRate       = sampleRate;
            spec.maximumBlockSize = static_cast<juce::uint32>(maxBlockSize);
            spec.numChannels      = 1;
            predelayLine_.prepare(spec);
            predelayLine_.reset();
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
        fdnLate_.reset();
        hallLate_.reset();
        plateLate_.reset();

        hicutStateL_ = 0.0f;  hicutStateR_ = 0.0f;
        locutStateL_ = 0.0f;  locutStateR_ = 0.0f;
        smoothHfStateL_ = 0.0f;  smoothHfStateR_ = 0.0f;
    }

    double getTailLengthSeconds() const override
    {
        return static_cast<double>(getSmoothedValue("decay"));
    }

    // ── processEffect ────────────────────────────────────────────────────────
    // Per-block style-change handling, then dispatch to one of two backends.
    void processEffect(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& /*midi*/) override
    {
        // ── Style-change detection (once per block) ──────────────────────────
        // A switch resets all FDN/ER buffers and the predelay; output tone
        // filters are intentionally preserved (style-independent).
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
                fdnLate_.reset();
                hallLate_.reset();
                plateLate_.reset();
                currentStyle_ = newStyle;
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

        const float predelayMs = predelayPtr_
            ? predelayPtr_->load(std::memory_order_relaxed) : 10.0f;
        const float predelaySamples = std::clamp(
            predelayMs * 0.001f * sr, 0.0f, maxPredelaySamplesF_);

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

            const float smoothFrac = std::clamp(smoothPct * 0.01f, 0.0f, 1.0f);

            const float inputL = buffer.getSample(0, s);
            const float inputR = numCh > 1 ? buffer.getSample(1, s) : inputL;
            const float monoIn = (inputL + inputR) * 0.5f;

            // Pre-delay
            predelayLine_.pushSample(0, monoIn);
            const float preOut = predelayLine_.popSample(0, predelaySamples);

            // Optional input diffusion (FDN feed only)
            float fdnIn = preOut;
            for (int d = 0; d < t->inputDiffusionStages; ++d)
                fdnIn = fdnLate_.inputDiffusers[d].process(fdnIn);

            // Early reflections
            const float sizeScale = (size / 100.0f) * 0.5f + 0.75f;
            fdnLate_.erLine.pushSample(0, preOut);

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

            float wetL = erL  * (erLevel / 100.0f) * t->erGainScale
                       + fdnL * (erLate  / 100.0f) * t->lateGainScale;
            float wetR = erR  * (erLevel / 100.0f) * t->erGainScale
                       + fdnR * (erLate  / 100.0f) * t->lateGainScale;

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
            buffer.setSample(0, s, inputL * (1.0f - mixN) + wetL * mixN);
            if (numCh > 1)
                buffer.setSample(1, s, inputR * (1.0f - mixN) + wetR * mixN);

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
    //   • fdnLate_.inputDiffusers — 2-stage Schroeder allpass on the FDN feed
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

        const float predelayMs = predelayPtr_
            ? predelayPtr_->load(std::memory_order_relaxed) : 10.0f;
        const float predelaySamples = std::clamp(
            predelayMs * 0.001f * sr, 0.0f, maxPredelaySamplesF_);

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

            const float smoothFrac = std::clamp(smoothPct * 0.01f, 0.0f, 1.0f);

            const float inputL = buffer.getSample(0, s);
            const float inputR = numCh > 1 ? buffer.getSample(1, s) : inputL;
            const float monoIn = (inputL + inputR) * 0.5f;

            // Pre-delay
            predelayLine_.pushSample(0, monoIn);
            const float preOut = predelayLine_.popSample(0, predelaySamples);

            // Hall input diffusion (2-stage Schroeder allpass).
            // Smooths the FDN feed; ER tap line still reads preOut directly so
            // discrete reflection events stay punctate.
            float fdnIn = preOut;
            for (int d = 0; d < kMaxInputDiffusionStages; ++d)
                fdnIn = fdnLate_.inputDiffusers[d].process(fdnIn);

            // Early reflections — Hall ER table (10 taps), shared erLine.
            const float sizeScale = (size / 100.0f) * 0.5f + 0.75f;
            fdnLate_.erLine.pushSample(0, preOut);

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

            // Pop modulated samples from all 16 lines.
            float fdnOut[kHallNumLines];
            for (int i = 0; i < kHallNumLines; ++i)
            {
                const float baseDelay = kHallBaseDelays16[i] * sizeScale * srScale;

                const float lfoVal = std::sin(
                    2.0f * juce::MathConstants<float>::pi * hallLate_.modPhase[i]);
                hallLate_.modPhase[i] += kHallModRates16[i] * modRateFrac / sr;
                if (hallLate_.modPhase[i] >= 1.0f) hallLate_.modPhase[i] -= 1.0f;

                const float modulatedDelay = std::clamp(
                    baseDelay + lfoVal * modAmt, 1.0f, hallLate_.maxFdnSamplesF);

                fdnOut[i] = hallLate_.fdnLines[i].popSample(0, modulatedDelay, true);
            }

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

            // 16-element output mixing — decorrelated weighted sums.
            float fdnL = 0.0f, fdnR = 0.0f;
            for (int i = 0; i < kHallNumLines; ++i)
            {
                fdnL += fdnOut[i] * kHallOutputGainsL16[i];
                fdnR += fdnOut[i] * kHallOutputGainsR16[i];
            }
            fdnL *= kHallEnh16LateOutputGain;
            fdnR *= kHallEnh16LateOutputGain;

            // ER softening (smoothness wet contribution).
            constexpr float kErSoft = 0.62f;
            fdnLate_.erSoftStateL = (1.0f - kErSoft) * erL
                                   + kErSoft * fdnLate_.erSoftStateL;
            fdnLate_.erSoftStateR = (1.0f - kErSoft) * erR
                                   + kErSoft * fdnLate_.erSoftStateR;
            const float erBlend = smoothFrac * 0.5f;
            erL = erL + (fdnLate_.erSoftStateL - erL) * erBlend;
            erR = erR + (fdnLate_.erSoftStateR - erR) * erBlend;

            float wetL = erL  * (erLevel / 100.0f) * kHallEnh16ErGainScale
                       + fdnL * (erLate  / 100.0f) * kHallEnh16LateGainScale;
            float wetR = erR  * (erLevel / 100.0f) * kHallEnh16ErGainScale
                       + fdnR * (erLate  / 100.0f) * kHallEnh16LateGainScale;

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
            buffer.setSample(0, s, inputL * (1.0f - mixN) + wetL * mixN);
            if (numCh > 1)
                buffer.setSample(1, s, inputR * (1.0f - mixN) + wetR * mixN);

            peakL = std::max(peakL, std::abs(wetL));
            peakR = std::max(peakR, std::abs(wetR));
        }
    }

    // ─── PLATE backend ───────────────────────────────────────────────────────
    // Dattorro/Griesinger-inspired plate tank — designed from scratch (no
    // third-party constants). Topology:
    //
    //   predelay → 4-stage allpass diffusion →
    //     ↳ arm A: [modAP] → [longA] → [LPF] → [fixedAP] → A_out
    //     ↳ arm B: [modAP] → [longB] → [LPF] → [fixedAP] → B_out
    //   feedback path: arm A reads (B's previous-sample output × decay);
    //                  arm B reads (A's just-computed output × decay).
    //   The single-sample lag on B→A breaks the otherwise instantaneous loop.
    //
    // Stereo output = 6 deterministic taps (3 from each arm's long delay)
    // mixed into L and R with signed gains and a separate pattern per
    // channel.
    //
    // Style-specific parameter mapping:
    //   er_level  — input diffusion / front-bloom blend (NOT room ER taps)
    //   er_late   — tank tail level
    //   damping   — tank HF damping
    //   decay     — tank feedback (RT60 for the round-trip path)
    //   size      — scales tank delays + tap offsets
    //   mod_*     — subtle decorrelated modulation in the modulated allpasses
    //   smoothness — slightly raises damping AND drives the wet HF shelf
    void processBlockPlate(juce::AudioBuffer<float>& buffer,
                           float& peakL, float& peakR)
    {
        const int   numSamples = buffer.getNumSamples();
        const int   numCh      = buffer.getNumChannels();
        const float sr         = static_cast<float>(sampleRate_);
        const float srScale    = sr / 48000.0f;

        const float predelayMs = predelayPtr_
            ? predelayPtr_->load(std::memory_order_relaxed) : 10.0f;
        const float predelaySamples = std::clamp(
            predelayMs * 0.001f * sr, 0.0f, maxPredelaySamplesF_);

        // Round-trip distance (in samples) is a constant for given delays
        // but scales with size + sample rate.  Computed once per block.
        const float roundtripBaseSamples =
            static_cast<float>(kPlateLongA_Delay + kPlateLongB_Delay
                               + kPlateModApA_BaseDelay + kPlateModApB_BaseDelay
                               + kPlateFixedApA_Delay + kPlateFixedApB_Delay);

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

            const float smoothFrac = std::clamp(smoothPct * 0.01f, 0.0f, 1.0f);

            const float inputL = buffer.getSample(0, s);
            const float inputR = numCh > 1 ? buffer.getSample(1, s) : inputL;
            const float monoIn = (inputL + inputR) * 0.5f;

            // Pre-delay (shared)
            predelayLine_.pushSample(0, monoIn);
            const float preOut = predelayLine_.popSample(0, predelaySamples);

            // ── Input diffusion (4 stages) ───────────────────────────────────
            // er_level acts as a wet/dry blend between the un-diffused
            // pre-delay output and the fully-diffused signal — controls
            // "front bloom" amount instead of room ER taps.
            float diffused = preOut;
            for (int d = 0; d < 4; ++d)
                diffused = plateLate_.inputDiffusers[d].process(diffused);
            const float bloomBlend = std::clamp(erLevel / 100.0f, 0.0f, 1.0f);
            diffused = preOut * (1.0f - bloomBlend) + diffused * bloomBlend;

            // ── Tank coefficients ────────────────────────────────────────────
            const float sizeScale = (size / 100.0f) * 0.5f + 0.75f;

            // RING TAME nudges damping up so HF in tank decays faster (less
            // metallic ringing) without darkening dry/early signal.
            const float dampG = std::clamp(
                damping / 100.0f + smoothFrac * 0.15f,
                0.0f, 0.95f);

            // Decay → feedback gain.  The plate's main loop traverses both
            // arms in turn, so feedbackGain is applied TWICE per full round
            // trip (A→B and the lastB→A handoff).  The target full-round-
            // trip gain equals 10^(-3·τ/T) (the standard RT60 relation), so
            // the per-application gain is the square root of that, i.e.
            // 10^(-1.5·τ/T).
            const float roundtripSec =
                (roundtripBaseSamples * sizeScale * srScale) / sr;
            const float safeDecay = std::max(decay, 0.1f);
            const float feedbackGain = std::clamp(
                std::pow(10.0f, -1.5f * roundtripSec / safeDecay),
                0.0f, 0.97f);    // hard ceiling — even at 30 s the tank can't run away

            const float modAmt = (modDepth / 100.0f)
                                * kPlateModDepthSamples
                                * kPlateModDepthScalar;
            const float modRateFrac = modRate / 100.0f;

            // ── Arm A ────────────────────────────────────────────────────────
            // Cross-fed by B's *previous-sample* output (single-sample delay
            // breaks the instantaneous loop).
            const float armA_in = diffused * kPlateInputGain
                                 + plateLate_.lastB * feedbackGain;

            // Modulated allpass A.
            const float lfoA = std::sin(
                2.0f * juce::MathConstants<float>::pi * plateLate_.modPhaseA);
            plateLate_.modPhaseA += kPlateModRateA_Hz * modRateFrac / sr;
            if (plateLate_.modPhaseA >= 1.0f) plateLate_.modPhaseA -= 1.0f;
            const float modDelayA = std::clamp(
                plateLate_.modApBaseA + lfoA * modAmt,
                1.0f, plateLate_.modApMaxF_A);
            const float delayedVA = plateLate_.modApA.popSample(0, modDelayA, true);
            const float vA = armA_in - kPlateModApA_Coeff * delayedVA;
            plateLate_.modApA.pushSample(0, vA);
            const float modApA_out = -kPlateModApA_Coeff * vA + delayedVA;

            // Long delay A — push first so taps read fresh history.
            plateLate_.longA.pushSample(0, modApA_out);

            // Multi-tap reads from longA (no read-pointer advance — independent
            // taps).  Indices 0–2 of kPlateOutputTaps belong to arm A.
            const float tapA0 = plateLate_.longA.popSample(0,
                std::clamp(static_cast<float>(kPlateOutputTaps[0].delaySamplesAt48k)
                           * sizeScale * srScale,
                           0.0f, plateLate_.longMaxF_A), false);
            const float tapA1 = plateLate_.longA.popSample(0,
                std::clamp(static_cast<float>(kPlateOutputTaps[1].delaySamplesAt48k)
                           * sizeScale * srScale,
                           0.0f, plateLate_.longMaxF_A), false);
            const float tapA2 = plateLate_.longA.popSample(0,
                std::clamp(static_cast<float>(kPlateOutputTaps[2].delaySamplesAt48k)
                           * sizeScale * srScale,
                           0.0f, plateLate_.longMaxF_A), false);

            // Main read from longA (chain output).
            const float longAoutDelay = std::clamp(
                plateLate_.longBaseA * sizeScale,
                1.0f, plateLate_.longMaxF_A);
            const float longA_out = plateLate_.longA.popSample(0, longAoutDelay, true);

            // Damping LPF A.
            plateLate_.dampStateA =
                (1.0f - dampG) * longA_out + dampG * plateLate_.dampStateA;

            // Fixed allpass A (own buffer).
            const float fixedApA_out = plateLate_.fixedApA.process(plateLate_.dampStateA);

            // DC blocker A.
            const float dcOutA = fixedApA_out
                                - plateLate_.dcXA
                                + plateLate_.dcR * plateLate_.dcYA;
            plateLate_.dcXA = fixedApA_out;
            plateLate_.dcYA = dcOutA;

            const float armA_out = dcOutA;

            // ── Arm B ────────────────────────────────────────────────────────
            // Arm B reads arm A's *current-sample* output × feedbackGain. This
            // creates the single-loop snake A → B → (lastB) → A.
            const float armB_in = diffused * kPlateInputGain
                                 + armA_out * feedbackGain;

            const float lfoB = std::sin(
                2.0f * juce::MathConstants<float>::pi * plateLate_.modPhaseB);
            plateLate_.modPhaseB += kPlateModRateB_Hz * modRateFrac / sr;
            if (plateLate_.modPhaseB >= 1.0f) plateLate_.modPhaseB -= 1.0f;
            const float modDelayB = std::clamp(
                plateLate_.modApBaseB + lfoB * modAmt,
                1.0f, plateLate_.modApMaxF_B);
            const float delayedVB = plateLate_.modApB.popSample(0, modDelayB, true);
            const float vB = armB_in - kPlateModApB_Coeff * delayedVB;
            plateLate_.modApB.pushSample(0, vB);
            const float modApB_out = -kPlateModApB_Coeff * vB + delayedVB;

            plateLate_.longB.pushSample(0, modApB_out);

            const float tapB0 = plateLate_.longB.popSample(0,
                std::clamp(static_cast<float>(kPlateOutputTaps[3].delaySamplesAt48k)
                           * sizeScale * srScale,
                           0.0f, plateLate_.longMaxF_B), false);
            const float tapB1 = plateLate_.longB.popSample(0,
                std::clamp(static_cast<float>(kPlateOutputTaps[4].delaySamplesAt48k)
                           * sizeScale * srScale,
                           0.0f, plateLate_.longMaxF_B), false);
            const float tapB2 = plateLate_.longB.popSample(0,
                std::clamp(static_cast<float>(kPlateOutputTaps[5].delaySamplesAt48k)
                           * sizeScale * srScale,
                           0.0f, plateLate_.longMaxF_B), false);

            const float longBoutDelay = std::clamp(
                plateLate_.longBaseB * sizeScale,
                1.0f, plateLate_.longMaxF_B);
            const float longB_out = plateLate_.longB.popSample(0, longBoutDelay, true);

            plateLate_.dampStateB =
                (1.0f - dampG) * longB_out + dampG * plateLate_.dampStateB;

            const float fixedApB_out = plateLate_.fixedApB.process(plateLate_.dampStateB);

            const float dcOutB = fixedApB_out
                                - plateLate_.dcXB
                                + plateLate_.dcR * plateLate_.dcYB;
            plateLate_.dcXB = fixedApB_out;
            plateLate_.dcYB = dcOutB;

            const float armB_out = dcOutB;

            // Save arm B for next sample's cross-feed into arm A.
            plateLate_.lastB = armB_out;

            // ── 6-tap stereo output mixing ───────────────────────────────────
            float plateL =
                ( tapA0 * kPlateOutputTaps[0].gainL
                + tapA1 * kPlateOutputTaps[1].gainL
                + tapA2 * kPlateOutputTaps[2].gainL
                + tapB0 * kPlateOutputTaps[3].gainL
                + tapB1 * kPlateOutputTaps[4].gainL
                + tapB2 * kPlateOutputTaps[5].gainL) * kPlateLateOutputGain;

            float plateR =
                ( tapA0 * kPlateOutputTaps[0].gainR
                + tapA1 * kPlateOutputTaps[1].gainR
                + tapA2 * kPlateOutputTaps[2].gainR
                + tapB0 * kPlateOutputTaps[3].gainR
                + tapB1 * kPlateOutputTaps[4].gainR
                + tapB2 * kPlateOutputTaps[5].gainR) * kPlateLateOutputGain;

            // ── Wet output stage ─────────────────────────────────────────────
            const float wetGain = erLate / 100.0f;
            float wetL = plateL * wetGain;
            float wetR = plateR * wetGain;

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
            buffer.setSample(0, s, inputL * (1.0f - mixN) + wetL * mixN);
            if (numCh > 1)
                buffer.setSample(1, s, inputR * (1.0f - mixN) + wetR * mixN);

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
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::None>
        predelayLine_;
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

    // ── State ─────────────────────────────────────────────────────────────────
    double sampleRate_ = 44100.0;
};
