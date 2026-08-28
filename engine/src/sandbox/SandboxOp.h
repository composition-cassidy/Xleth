#pragma once

// AUTOTUNE's params EMBED xleth::dsp::CorrectionParams and reuse
// xleth::dsp::ScaleType rather than restating them — see AutotuneParams below.
// Both are plain structs/enums with no JUCE and no I/O, and CorrectionCurve.cpp
// already lives in this same model tier (engine/CMakeLists.txt), so this costs
// the header nothing it did not already have.
#include "dsp/CorrectionCurve.h"

#include <nlohmann/json.hpp>

#include <cstdint>
#include <string>
#include <variant>
#include <vector>

// ─── Sample Sandbox — op descriptors ──────────────────────────────────────────
//
// One SandboxOp = one DSP transform with parameters. A layer's stack is an
// ordered list of them, evaluated source → op[0] → op[1] → … → output.
//
// ── Why params are a std::variant of typed structs, not a float array ─────────
// VisualEffect (model/TimelineTypes.h) stores its parameters as `float
// params[16]` reinterpreted per effect type. That layout is hand-duplicated in
// the HLSL constant buffers, GridCompositor and the React param panel with no
// registry to keep them honest — the comment there says so explicitly, four
// times. Adding a parameter means editing four files and hoping.
//
// The Sandbox does not repeat that. Every op has its own named struct, the
// variant alternative order is locked to the SandboxOpType enum order (asserted
// below), and the ONE registry is the opTypeName/opTypeFromName pair plus the
// visit sites in SandboxOp.cpp. A new op that forgets a site fails to compile
// rather than silently reading someone else's parameter.
//
// ── Sample-rate domain ───────────────────────────────────────────────────────
// Every index and length in these params is in ENGINE-BUFFER SAMPLES, i.e. the
// rate the source buffer is actually stored at (SampleBank::SampleInfo::
// bufferSampleRate). Nothing here assumes 44100 or 48000, and nothing here is
// in seconds or ticks — a stack authored against a 48 kHz bake must not silently
// mean something else after a re-bake at another rate, so SandboxRenderer folds
// the rate into its cache key instead of letting the params drift.

namespace xleth::sandbox {

// Bumped when the serialized shape of a stack changes incompatibly. Written on
// every stack, read back with a default of 1 so a pre-versioning file (there
// are none in the wild yet, but the read path costs nothing) still loads.
//
//   1 — SB-1..SB-5. Layers carried only sourceBufferId (a SampleBank id).
//   2 — SB-6. Layers additionally carry a DURABLE source reference
//       (sourceFilePath / sourceStartTime / sourceEndTime). A v1 workspace
//       reads back with an empty path, which reloads as an unbound layer
//       (sourceBufferId = -1) whose op-stack is nonetheless intact — the
//       stack was never the part that could not be re-resolved.
//   3 — P5-3. SandboxOpType::Autotune exists. Additive like v2 was, and
//       stackFromJson's unknown-name rule means a v2 reader SKIPS an autotune
//       op rather than mis-reading one — but silently dropping a user's
//       pitch correction is exactly the kind of degradation the version
//       number is here to record, so it gets a bump.
inline constexpr int kSandboxStackVersion = 3;

// ─── SandboxOpType ────────────────────────────────────────────────────────────
// Order is load-bearing: it must match the alternative order of SandboxOpParams
// (static_assert'ed at the bottom of this header). Values are explicit so the
// enum can be reordered only deliberately — though note the JSON writes the
// NAME, not the number, so a reorder is not a file-format migration.

enum class SandboxOpType : int {
    Trim      = 0,
    Cut       = 1,
    Paste     = 2,
    Splice    = 3,
    Reverse   = 4,
    Fade      = 5,
    Gain      = 6,
    Crossfade = 7,
    Pitch     = 8,
    Stretch   = 9,

    // A gain curve over time, rather than the single scalar GAIN applies to a
    // range. Deliberately a SEPARATE type instead of a mode on GainParams: the
    // two have nothing in common at the param level (a breakpoint list vs. a
    // scalar + a normalize flag), and folding them together would reintroduce
    // exactly the "one struct reinterpreted per mode" pattern this header's
    // opening comment exists to avoid.
    GainEnvelope = 10,

    // Restoration/pitch trio. All three route through the same RubberBand R3
    // engine PITCH already stubs out to (see PitchParams) — see
    // dsp/RubberBandWrapper.h's formantScaleOverride for how FormantShift gets
    // an independent formant move out of an engine whose public API otherwise
    // only exposes "shift with/without the formants following".
    FormantShift = 11,
    Declip       = 12,
    Denoise      = 13,

    // SPECTRAL_PAINT (P3-2) — attenuate energy in user-painted time/frequency
    // regions on the SPC canvas. See SpectralPaintParams below.
    SpectralPaint = 14,

    // AUTOTUNE (P5-3) — snap the melody to a scale by TD-PSOLA resynthesis.
    // See AutotuneParams below.
    Autotune = 15,
};

inline constexpr int kSandboxOpTypeCount = 16;

// ─── Shared enums ─────────────────────────────────────────────────────────────

// Curve applied across a fade or crossfade window.
enum class SandboxFadeShape : int {
    Linear      = 0,   // gain = t
    EqualPower  = 1,   // gain = sin(t·π/2) — constant power, the crossfade default
    Exponential = 2,   // gain = t²        — slow start, fast finish
    Logarithmic = 3,   // gain = 1-(1-t)²  — fast start, slow finish
    SCurve      = 4,   // gain = t²(3-2t)  — smoothstep, click-free at both ends
    Hann        = 5,   // gain = 0.5(1-cos(t·π)) — same raised-cosine ramp as
                       // dsp::DeclickEnvelope, so a Crossfade seam declicks
                       // exactly like the sampler's trim boundaries do.
};

// What happens to the material after an edit point.
enum class SandboxRippleMode : int {
    Ripple = 0,   // close the gap — everything downstream slides left
    Gap    = 1,   // leave silence in place — buffer length unchanged
};

// ─── Per-op parameter structs ─────────────────────────────────────────────────
//
// Convention shared by every range-carrying op: `endSample < 0` means "to the
// end of the buffer". That keeps a range op meaningful after an upstream op
// changes the length, which is the whole point of a re-evaluable stack —
// a trim that hard-coded the old end would silently truncate after a paste.

// TRIM — keep [startSample, endSample), discard the rest.
struct TrimParams {
    int64_t startSample = 0;
    int64_t endSample   = -1;

    bool operator==(const TrimParams&) const = default;
};

// CUT — remove [startSample, endSample). Ripple closes the gap; Gap replaces the
// range with silence and preserves the buffer length.
struct CutParams {
    int64_t           startSample = 0;
    int64_t           endSample   = -1;
    SandboxRippleMode mode        = SandboxRippleMode::Ripple;

    bool operator==(const CutParams&) const = default;
};

// PASTE — insert (or overwrite with) clipboard material at atSample.
//
// clipboardId resolves against SandboxRenderer's session-local clipboard store
// (SB-4). clipboardId == -1, or an id that no longer resolves (e.g. a stack
// reloaded from a project file in a later session — the clipboard is NOT
// persisted), means "no material": the op inserts/overwrites
// clipboardLengthSamples of SILENCE instead. That is also how INSERT SILENCE
// is expressed — there is no separate op type for it. clipboardLengthSamples
// is always authoritative for length prediction (outputLength() needs it
// without touching a buffer), so a stale reference degrades gracefully to
// silence of the same length rather than desyncing the stack's predicted
// length from its actual render.
struct PasteParams {
    int64_t atSample              = 0;
    int     clipboardId           = -1;   // -1 = nothing on the clipboard
    int64_t clipboardLengthSamples = 0;
    bool    insert                = true; // false = overwrite in place

    bool operator==(const PasteParams&) const = default;
};

// SPLICE — split at atSample and swap the two halves (tail moves in front of
// head). Ripple abuts them with no gap; Gap inserts gapSamples of silence at
// the new seam between the (relocated) tail and head.
struct SpliceParams {
    int64_t           atSample   = 0;
    SandboxRippleMode mode       = SandboxRippleMode::Ripple;
    int64_t           gapSamples = 0;   // only consulted when mode == Gap

    bool operator==(const SpliceParams&) const = default;
};

// REVERSE — reverse the material in [startSample, endSample) in place.
struct ReverseParams {
    int64_t startSample = 0;
    int64_t endSample   = -1;

    bool operator==(const ReverseParams&) const = default;
};

// FADE — ramp gain across [startSample, startSample + lengthSamples).
// fadeIn ramps 0→1, otherwise 1→0.
struct FadeParams {
    int64_t          startSample   = 0;
    int64_t          lengthSamples = 0;
    SandboxFadeShape shape         = SandboxFadeShape::Linear;
    bool             fadeIn        = true;

    bool operator==(const FadeParams&) const = default;
};

// GAIN — scale [startSample, endSample) by gainDb, or normalize that range so
// its peak lands on targetPeakDb. Normalize ignores gainDb.
struct GainParams {
    int64_t startSample  = 0;
    int64_t endSample    = -1;
    double  gainDb       = 0.0;
    bool    normalize    = false;
    double  targetPeakDb = 0.0;

    bool operator==(const GainParams&) const = default;
};

// CROSSFADE — declick a seam at atSample by dipping gain toward silence and
// back across lengthSamples (half before the seam, half after), the same
// technique dsp::DeclickEnvelope uses at a clip's hard start/end boundaries,
// just centred on an INTERIOR point instead of the buffer edge. Because a
// single-buffer op stack has no second signal to blend against once upstream
// material has been cut away, this "declicks toward silence" rather than
// true-crossfading two waveforms — which is exactly what makes it re-runnable
// at any point in the stack, including seams the buffer no longer remembers
// the far side of. Default shape is Hann to match the sampler exactly.
struct CrossfadeParams {
    int64_t          atSample      = 0;
    int64_t          lengthSamples = 0;
    SandboxFadeShape shape         = SandboxFadeShape::Hann;

    bool operator==(const CrossfadeParams&) const = default;
};

// ─── Gain envelope ────────────────────────────────────────────────────────────

// dB bounds every breakpoint is clamped to on ingest. The top is deliberately
// generous (a duck is authored against material that may already be quiet), the
// bottom is a true mute rather than an asymptote — see kGainEnvelopeSilenceDb.
inline constexpr double kGainEnvelopeMaxDb = 24.0;
inline constexpr double kGainEnvelopeMinDb = -96.0;

// A curve that reaches the floor is SILENCE, not 1.6e-5. Interpolating in dB
// has no -inf to travel toward, so without this a "mute this section" gesture
// leaves a floor of noise that survives a later normalize and comes back
// audible. The floor is exact only AT the floor; everything above it is the
// ordinary 10^(dB/20).
inline constexpr double kGainEnvelopeSilenceDb = kGainEnvelopeMinDb;

// One breakpoint: a dB value at a sample position. Positions are in
// engine-buffer samples like every other param in this header.
struct SandboxGainPoint {
    int64_t samplePos = 0;
    double  db        = 0.0;

    bool operator==(const SandboxGainPoint&) const = default;
};

// ── Mode 2 — relative dynamics modulation ───────────────────────────────────
// Absolute (Mode 1) applies the drawn dB straight to the signal, unaware of
// what the material is actually doing at that instant. Relative (Mode 2) asks
// SandboxRenderer to first track the source's OWN loudness contour (a smoothed
// RMS envelope follower) and scale the drawn dB by how loud THAT instant is
// relative to the dynamic range the follower covers across this buffer — see
// applyGainEnvelope() in SandboxRenderer.cpp for the exact arithmetic and why
// it is not just "add the drawn dB to the detected envelope".
enum class SandboxGainEnvelopeMode : int {
    Absolute = 0,   // Mode 1 — the drawn curve IS the applied gain
    Relative = 1,   // Mode 2 — the drawn curve modulates the detected envelope
};

// Follower time-constant bounds and defaults. Fast attack (default) so a
// transient is caught inside its own duration rather than a follower cycle
// late; slow-ish release (default) so the curve does not chase every
// microdynamic wiggle back down, which would just reinvent Mode 1.
inline constexpr double kGainEnvelopeMinAttackMs      = 0.1;
inline constexpr double kGainEnvelopeMaxAttackMs      = 500.0;
inline constexpr double kGainEnvelopeDefaultAttackMs  = 5.0;
inline constexpr double kGainEnvelopeMinReleaseMs     = 1.0;
inline constexpr double kGainEnvelopeMaxReleaseMs     = 2000.0;
inline constexpr double kGainEnvelopeDefaultReleaseMs = 150.0;

// GAIN ENVELOPE — a gain curve traced through `points`, evaluated per sample.
//
// ── Why dB, and why interpolate IN dB ────────────────────────────────────────
// The UI draws this as a dB line over the waveform, so the interpolation domain
// has to be dB too: interpolating the LINEAR gain between two dB breakpoints
// would render a curve that does not match the one on screen (halfway between
// 0 and -12 dB would land at -3.5 dB, not -6). What is drawn is what is applied.
//
// ── Why smoothstep rather than linear ────────────────────────────────────────
// Linear-in-dB segments meet at breakpoints with a derivative discontinuity —
// an audible corner on anything but the gentlest slope, and precisely the
// "zipper" class of artefact. Smoothstep (t²(3-2t)) has zero slope at both ends
// of every segment, so the composed curve is C¹ everywhere including across
// breakpoints. The cost is that a segment cannot be a straight ramp — it always
// eases in and out. That is the intended trade: this op renders offline, where
// smoothness is free and a click is not.
//
// ── Degenerate shapes are all pass-throughs or constants, never errors ───────
//   0 points          → unity (0 dB) everywhere; the op is a no-op.
//   1 point           → that point's dB everywhere, i.e. a plain constant gain.
//   before the first  → held at the first point's dB.
//   after the last    → held at the last point's dB.
// Two points sharing a samplePos would be a zero-length segment; the renderer
// sorts and de-duplicates (last wins) rather than dividing by zero, and
// opFromJson normalizes on the way in so a saved stack is already clean.
//
// ── mode is a field here, not a second op type ───────────────────────────────
// Mode 1 and Mode 2 share every other field: the same breakpoint list, the
// same editor, the same "what does 0 dB mean" mental model — only how the
// curve's dB value gets turned into a sample gain differs, which is exactly
// the kind of variation a mode flag exists for. See SandboxOpType::GainEnvelope
// for why this op is nonetheless its own type rather than a mode of GAIN.
struct GainEnvelopeParams {
    // Ordered by samplePos, one point per position. Not enforced by the type —
    // enforced by normalizeGainEnvelope(), which every ingest path calls.
    std::vector<SandboxGainPoint> points;

    SandboxGainEnvelopeMode mode = SandboxGainEnvelopeMode::Absolute;

    // Consulted only in Relative mode; harmless dead weight in Absolute, kept
    // rather than omitted so flipping modes back and forth never loses the
    // user's tuning.
    double followerAttackMs  = kGainEnvelopeDefaultAttackMs;
    double followerReleaseMs = kGainEnvelopeDefaultReleaseMs;

    bool operator==(const GainEnvelopeParams&) const = default;
};

// Sorts by samplePos, drops negative positions, clamps every db into
// [kGainEnvelopeMinDb, kGainEnvelopeMaxDb], collapses duplicate positions
// keeping the LAST one written (the same "last edit wins" a UI drag produces
// when a handle is dragged onto its neighbour), and clamps mode/follower
// times into their declared bounds.
void normalizeGainEnvelope(GainEnvelopeParams& p);

// dB → linear, with the exact-silence floor (kGainEnvelopeSilenceDb): a curve
// that reaches the floor is SILENCE, not 10^(-96/20) ≈ 1.6e-5 of noise. Public
// because both the Absolute evaluator below and SandboxRenderer's Relative-mode
// arithmetic need the identical rule — a second copy of "what does this dB
// value mean as a gain" would be free to drift from this one.
double envDbToGain(double db) noexcept;

// Raw dB the drawn curve evaluates to at `samplePos` — smoothstep-interpolated,
// held flat outside the authored range, but WITHOUT gainEnvelopeAt's
// exact-silence floor snap. Relative mode needs the authored dB value itself
// (to scale by the detected envelope) rather than the gain that value would
// produce in isolation; Absolute mode never calls this directly. Assumes `p`
// has been normalized, same as gainEnvelopeAt.
double gainEnvelopeDbAt(const GainEnvelopeParams& p, int64_t samplePos) noexcept;

// Gain (LINEAR, not dB) this envelope produces at `samplePos` in ABSOLUTE
// mode — i.e. envDbToGain(gainEnvelopeDbAt(p, samplePos)). The single
// evaluator — the renderer's per-sample loop and any UI-side prediction must
// agree, so there is exactly one implementation of the curve. Assumes `p` has
// been normalized; unsorted input degrades to a wrong-but-bounded curve rather
// than UB. Relative mode's actual applied gain is NOT this function — see
// applyGainEnvelope() in SandboxRenderer.cpp.
double gainEnvelopeAt(const GainEnvelopeParams& p, int64_t samplePos) noexcept;

// PITCH — shift by cents without changing length, via dsp::processRubberBand
// (RubberBand R3, offline). formantPreserve is the "formant lock" toggle: off,
// the formant envelope rides up/down with the pitch (RubberBand's
// OptionFormantShifted — the classic "chipmunk" effect at large shifts); on,
// RubberBand's OptionFormantPreserved keeps the envelope where it started, so
// a vocal shifted an octave up still sounds like the same voice register.
struct PitchParams {
    double cents           = 0.0;
    bool   formantPreserve = false;

    bool operator==(const PitchParams&) const = default;
};

// STRETCH — scale length by ratio without changing pitch. STUB in SB-1.
// `algorithm` mirrors StretchMethod (model/TimelineTypes.h); 0 = engine default.
struct StretchParams {
    double ratio     = 1.0;
    int    algorithm = 0;

    bool operator==(const StretchParams&) const = default;
};

// FORMANT SHIFT — move the spectral envelope by `cents` (same unit as
// PitchParams::cents) while leaving pitch AND length untouched. This is the
// case PitchParams::formantPreserve cannot express: that toggle only ever
// locks the formants to where they already were during a PITCH move, it never
// moves them on their own. Implemented via
// RubberBandParams::formantScaleOverride — see that field's comment for why
// the stretcher needs an explicit override rather than just "pitch shift with
// formants shifted".
struct FormantShiftParams {
    double cents = 0.0;

    bool operator==(const FormantShiftParams&) const = default;
};

// DECLIP — find runs of samples pinned at or above `threshold` (a fraction of
// full scale, so 0.98 catches a run flat-topped at ±0.98..1.0) and rebuild
// them with a cubic Hermite curve anchored on the last/first good sample on
// either side. `maxRunSamples` is the escape hatch: a run longer than this is
// left alone rather than "reconstructed" — past a few dozen samples a flat-top
// is far more likely to be genuine full-scale content (a clap, a synth
// square) than an actual clip, and Hermite-filling a long run would just
// invent audio that was never there. Whole-buffer default range, like every
// other range-carrying op in this header.
struct DeclipParams {
    int64_t startSample    = 0;
    int64_t endSample      = -1;
    double  threshold      = 0.98;
    int     maxRunSamples  = 64;

    bool operator==(const DeclipParams&) const = default;
};

// DENOISE — learn a noise magnitude profile from [noiseStartSample,
// noiseEndSample) and spectrally subtract `sensitivity` × that profile from
// every frame across the WHOLE buffer, floored so no bin is ever attenuated
// past -reductionDb (the floor is what keeps this from collapsing into
// "musical noise" — full silence in a bin the instant its energy dips near
// the profile). `noiseEndSample <= noiseStartSample` (the default: 0/0) means
// "nothing learned yet" and the op is a pass-through — the same
// empty-input-is-a-no-op convention GainEnvelope's empty `points` uses. The UI
// commits a learned region as an ordinary SetSandboxOpParamsCommand (see
// SandboxCommands.h): "Learn Noise Profile" is not a separate RPC, it is this
// op's params being set to the user's current selection, so it is undoable
// for free and the actual profile is re-derived from those two indices at
// render time rather than stored as a second, driftable copy of the data.
struct DenoiseParams {
    int64_t noiseStartSample = 0;
    int64_t noiseEndSample   = 0;
    double  reductionDb      = 12.0;
    double  sensitivity      = 1.5;

    bool operator==(const DenoiseParams&) const = default;
};

// ─── Spectral paint ───────────────────────────────────────────────────────────
//
// SPECTRAL_PAINT — attenuate energy inside painted time/frequency regions
// ("dabs") rather than a fixed sample range or a learned noise profile. The
// user paints directly on the SPC (spectrogram) canvas; one mouse-drag on
// that canvas commits as one or more dabs appended to `dabs` in a SINGLE
// SetSandboxOpParamsCommand (see DenoiseParams's comment on the same
// "commit whole params on release" contract — SPECTRAL_PAINT follows it too,
// there is no per-dab RPC).
//
// ── Coordinates ─────────────────────────────────────────────────────────────
// Time is engine-buffer SAMPLES, same convention as every op in this header.
// Frequency is Hz, NOT an FFT bin index: a bin index is meaningless until the
// renderer picks an FFT size, and that size is an implementation detail of
// applySpectralPaint, not something a saved stack should have to know about.
//
// ── Falloff, not a hard edge ─────────────────────────────────────────────────
// Each dab is a rectangle in (time, frequency) — [-halfWidth,+halfWidth] ×
// [-halfHeight,+halfHeight] around its centre — with a raised-cosine feather
// added past that core on both axes, so a painted-out region does not leave a
// audible seam at its boundary the way a hard rectangular gate would.
// featherTimeMs/featherFreqHz of 0 means a hard edge (no feather).
//
// ── How dabs combine ─────────────────────────────────────────────────────────
// Overlapping dabs' amountDb SUMS (equivalently, their gains multiply) — the
// same "interpolate/combine in dB" rule GainEnvelopeParams uses, and it is
// what makes re-painting over an already-quiet region make it quieter still
// rather than clamping at whichever single dab is loudest. A boost dab and an
// attenuate dab overlapping simply partially cancel, for the same reason.
// applySpectralPaint floors AND ceils the combined total (see
// kSpectralPaintFloorDb/kSpectralPaintCeilDb) so an absurd pile of overlapping
// dabs cannot demand more gain, either direction, than the bit depth can
// represent.
struct SpectralPaintDab {
    int64_t centerSample     = 0;      // time centre, engine-buffer samples
    int64_t halfWidthSamples = 0;      // time half-extent, BEFORE feather
    double  centerFreqHz     = 0.0;    // frequency centre
    double  halfHeightHz     = 0.0;    // frequency half-extent, BEFORE feather
    // Gain at the dab's core, in dB — negative ATTENUATES (the original P3-2
    // use, e.g. denoising a hum line), positive BOOSTS (SPC selection's BOOST
    // action). Same field either way: dabs combine by summing dB regardless
    // of sign, so a boost dab and an attenuate dab overlapping just partially
    // cancel, which is the expected "re-paint over an edit" behaviour.
    double  amountDb         = -12.0;
    double  featherTimeMs    = 0.0;    // half-Hann falloff past halfWidthSamples
    double  featherFreqHz    = 0.0;    // half-Hann falloff past halfHeightHz

    bool operator==(const SpectralPaintDab&) const = default;
};

// Per-dab clamp on the ATTENUATE side: one dab attenuating past this is not
// "more paint", it is a modelling error (e.g. a corrupt file) —
// kSpectralPaintFloorDb below is what actually bounds a legitimate pile of
// overlapping attenuate dabs.
inline constexpr double kSpectralPaintMinAmountDb = -60.0;

// Per-dab clamp on the BOOST side — matches kGainEnvelopeMaxDb's ceiling,
// since a boost dab is the same "how far can one authored edit push a
// signal" question GainEnvelope's top clamp already answers.
inline constexpr double kSpectralPaintMaxAmountDb = 24.0;

// Floor for the SUM of every dab covering a given (time, frequency) point.
// Matches kGainEnvelopeMinDb's role: a total that reaches the floor is
// silence, not a numerically-absurd negative gain.
inline constexpr double kSpectralPaintFloorDb = -96.0;

// Ceiling for that same sum, on the boost side — bounds a pile of overlapping
// boost dabs the same way the floor bounds a pile of attenuate ones, rather
// than letting them stack without limit.
inline constexpr double kSpectralPaintCeilDb = 24.0;

// SPECTRAL_PAINT — see the dabs/coordinates/combining notes above.
struct SpectralPaintParams {
    // Paint order does not matter to the render (dab combination is
    // commutative — see the header comment), but IS preserved across a
    // save/load round-trip since it is what the "undo the last stroke" UX
    // wants to remove last.
    std::vector<SpectralPaintDab> dabs;

    bool operator==(const SpectralPaintParams&) const = default;
};

// ─── Autotune ─────────────────────────────────────────────────────────────────
//
// AUTOTUNE — quantize the melody to a scale and resynthesize onto the corrected
// pitch with TD-PSOLA (dsp/AutotuneRender.h). Three cooperating pieces, none of
// which this struct restates:
//   • detection  — dsp/PitchTrackAnalysis.h produces the per-frame f0 track,
//                  the note segmentation, and the monophonic gate.
//   • correction — dsp/CorrectionCurve.h turns that track plus THESE params
//                  into a per-frame target-f0 curve.
//   • render     — dsp/AutotuneRender.h moves the samples onto that curve.
//
// ── Why the six controls are an embedded CorrectionParams ────────────────────
// They ARE dsp::CorrectionParams — the same six knobs, the same units, the same
// meanings. Restating them here as six loose doubles would be a second
// declaration free to drift from the one the math actually reads, which is the
// failure mode this header's opening comment exists to prevent. The JSON is
// nonetheless FLAT (correctionAmount/retuneSpeedMs/... at the top level of
// "params"), because the UI edits six controls, not a control and a sub-object.
//
// ── Formants ride with the pitch ─────────────────────────────────────────────
// Deliberate, and there is no toggle for it. TD-PSOLA moves the spectral
// envelope with the fundamental; that is the classic hard-tune sound and the
// intended one. A caller who wants the envelope moved independently already has
// SandboxOpType::FormantShift.
//
// ── Refusal, not a guess ─────────────────────────────────────────────────────
// If the pitch analysis of this op's INPUT reports monophonic == false, the op
// renders as a pass-through and the renderer reports the analysis's own reason
// (SandboxRenderResult::refusalReason). It never emits a plausible-looking
// correction of polyphonic material.
// Upper bounds on the two time constants. CorrectionCurve itself only floors
// them at 0 (it has no opinion about how slow is too slow); these ceilings are
// the op's, so a typo in a saved file cannot produce a retune so slow the
// correction never arrives and the op reads as broken rather than as mistuned.
// Half a second is already far past the ~80 ms that sounds "natural".
inline constexpr double kAutotuneMaxRetuneMs     = 500.0;
inline constexpr double kAutotuneMaxSmoothnessMs = 500.0;

struct AutotuneParams {
    // The preset scale/key. Ignored entirely when `allowedNotes` is non-empty —
    // see below, and CorrectionCurve.h's own note on the same override.
    xleth::dsp::ScaleType scale = xleth::dsp::kDefaultScale;   // Phrygian
    int                   key   = xleth::dsp::kDefaultKey;     // D

    // Pitch classes 0-11 from the UI keyboard. NON-EMPTY OVERRIDES scale/key
    // outright rather than merging with it — a user who has hand-picked a note
    // set means that set, not that set unioned with a preset they stopped
    // caring about. Empty (the default) = use scale/key.
    std::vector<int> allowedNotes;

    // The six controls, verbatim: correctionAmount, retuneSpeedMs,
    // smoothnessMs, jumpiness, preserveVibrato. See CorrectionParams.
    xleth::dsp::CorrectionParams correction;

    bool operator==(const AutotuneParams&) const = default;
};

// Clamps `key` into 0-11, drops out-of-range/duplicate allowedNotes and sorts
// them, and clamps every one of the six controls into its declared range.
// Called by opFromJson so a saved stack is already clean, and available to any
// other ingest path for the same reason normalizeGainEnvelope is.
void normalizeAutotune(AutotuneParams& p);

// ─── SandboxOpParams ──────────────────────────────────────────────────────────
// Alternative order MUST match SandboxOpType — see the static_assert below.

using SandboxOpParams = std::variant<
    TrimParams,       // 0  Trim
    CutParams,        // 1  Cut
    PasteParams,      // 2  Paste
    SpliceParams,     // 3  Splice
    ReverseParams,    // 4  Reverse
    FadeParams,       // 5  Fade
    GainParams,       // 6  Gain
    CrossfadeParams,  // 7  Crossfade
    PitchParams,      // 8  Pitch
    StretchParams,    // 9  Stretch
    GainEnvelopeParams, // 10 GainEnvelope
    FormantShiftParams, // 11 FormantShift
    DeclipParams,       // 12 Declip
    DenoiseParams,      // 13 Denoise
    SpectralPaintParams,// 14 SpectralPaint
    AutotuneParams      // 15 Autotune
>;

static_assert(std::variant_size_v<SandboxOpParams> == kSandboxOpTypeCount,
              "SandboxOpParams must carry exactly one alternative per SandboxOpType");

// ─── SandboxOp ────────────────────────────────────────────────────────────────

struct SandboxOp {
    // Stable within its layer's stack. Survives reorder, so a UI selection or a
    // pending command reference stays valid across a drag. NOT part of the
    // content hash: two structurally identical stacks must share a cache entry
    // even if their ops were created in a different order.
    int id = 0;

    SandboxOpType   type = SandboxOpType::Gain;
    SandboxOpParams params = GainParams{};

    // false = bypassed. IS part of the content hash — bypassing changes output.
    bool enabled = true;

    // Set on every mutation, cleared by SandboxCore::clearDirty once the
    // renderer has published a buffer that accounts for this op. Render
    // bookkeeping only, so it is NOT part of the content hash: a re-render must
    // not miss a cache entry merely because the flag has not been cleared yet.
    bool dirty = true;

    // True once params.index() agrees with type. A hand-built op that sets one
    // without the other is malformed; deserialization repairs it by trusting
    // the type name and defaulting the params.
    bool consistent() const noexcept {
        return static_cast<int>(params.index()) == static_cast<int>(type);
    }

    // False for the ops whose DSP has not landed yet (Stretch only, as of the
    // restoration/pitch trio landing — deferred to the phase that wires in the
    // stretch engines). Paste/Splice/Crossfade landed in SB-4; Pitch,
    // FormantShift, Declip and Denoise landed with the restoration ops. An
    // unimplemented op is a PASS-THROUGH in the renderer,
    // never a silent partial edit — the UI is expected to badge it so
    // "nothing happened" reads as "not built yet" rather than as a bug.
    bool implemented() const noexcept;

    // False for op types that must never auto-trigger a render from a plain
    // stack edit — reserved for a future op heavy enough that running it on
    // every keystroke/drag tick would stall the UI (e.g. model separation).
    // True for every op type that exists today. The UI's auto-render
    // scheduler skips a layer whose stack contains an ENABLED op with
    // autoRender() == false, and that layer then requires the explicit
    // RE-RENDER fallback. Distinct from implemented(): an op can be
    // cheap-and-real (autoRender true) or unimplemented-and-cheap
    // (Pitch/Stretch — still auto-renders today, since a pass-through costs
    // nothing).
    bool autoRender() const noexcept;

    // Length this op produces from an input of `inputLength` samples, without
    // rendering. Bypassed and unimplemented ops return inputLength unchanged.
    int64_t outputLength(int64_t inputLength) const noexcept;

    // Deterministic 64-bit digest of type + params + enabled. Stable across
    // runs, builds and machines: fields are fed in explicitly (never as raw
    // struct bytes, whose padding is not guaranteed to be zeroed) and floats go
    // through their bit pattern.
    uint64_t contentHash() const noexcept;

    bool operator==(const SandboxOp&) const = default;
};

// ─── Registry ─────────────────────────────────────────────────────────────────
// The single source of truth for the type↔name mapping. JSON writes the NAME,
// so reordering the enum is not a file-format migration and an unknown name
// read from a newer file is a clean rejection rather than a wrong op.

const char*   opTypeName(SandboxOpType type) noexcept;
bool          opTypeFromName(const std::string& name, SandboxOpType& out) noexcept;

// Default-constructed params for `type`, with the variant alternative that
// matches it. Used by deserialization and by the UI's "add op" path.
SandboxOpParams defaultParamsFor(SandboxOpType type);

// ─── Stack helpers ────────────────────────────────────────────────────────────

// Digest of the first `count` ops of `ops`, chained. prefixHash(ops, i) is the
// identity of the audio produced after op i-1 has run, which is exactly what
// SandboxRenderer keys its per-prefix cache on: mutating op k leaves every
// prefix hash below k untouched, so the renderer re-runs ops k.. and no more.
//
// `count` is clamped to ops.size(). prefixHash(ops, 0) is the identity of the
// unmodified source.
uint64_t prefixHash(const std::vector<SandboxOp>& ops, size_t count) noexcept;

// Digest of the whole stack — prefixHash(ops, ops.size()).
uint64_t stackHash(const std::vector<SandboxOp>& ops) noexcept;

// Length the whole stack produces from `inputLength`, without rendering.
int64_t stackOutputLength(const std::vector<SandboxOp>& ops, int64_t inputLength) noexcept;

// ─── JSON ─────────────────────────────────────────────────────────────────────
// Round-trips losslessly. Op objects carry every field explicitly rather than
// omitting defaults: a stack is small, and an explicit shape means a future
// default change cannot retroactively alter a saved edit.

nlohmann::json opToJson(const SandboxOp& op);

// Returns false and leaves `out` untouched when the type name is unknown. A
// param that is missing or the wrong JSON type falls back to that param's
// default rather than aborting the load — one corrupt field must not cost the
// user the whole stack.
bool opFromJson(const nlohmann::json& j, SandboxOp& out);

// A whole stack, wrapped with its version:
//   { "sandboxStackVersion": 1, "ops": [ … ] }
nlohmann::json stackToJson(const std::vector<SandboxOp>& ops);

// Reads either the wrapper above or a bare array of ops. Unknown-type ops are
// SKIPPED (and reported via `skipped`) so a file written by a newer build
// degrades to "some ops missing" rather than "project will not open".
bool stackFromJson(const nlohmann::json& j,
                   std::vector<SandboxOp>& out,
                   int* versionOut = nullptr,
                   int* skipped    = nullptr);

} // namespace xleth::sandbox
