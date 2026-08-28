#pragma once

// CorrectionCurve — the pure-math layer of the Sample Sandbox AUTOTUNE op.
// Takes PitchTrackAnalysis's output (per-frame f0 + note segments, see
// PitchTrackAnalysis.h) plus a scale/key and the six AUTOTUNE controls, and
// produces a per-frame target-f0 curve. No audio rendering, no UI — P5-3
// (the AUTOTUNE renderer) is the only intended caller of computeCorrectionCurve.
//
// Pure and side-effect-free like PitchTrackAnalysis.h/LoopAnalysis.h: no
// JUCE dependency (PitchFrame/NoteSegment carry no JUCE types either), safe
// to link from the Model tier. Deterministic, allocates only for its output
// vector (reserved up front), never inside the per-frame loop.
//
// ─── Algorithm (fixed ordering per the AUTOTUNE spec) ───────────────────────
// For each voiced frame:
//   1. quantize segment target  — the frame's containing NoteSegment's
//      medianF0Hz is snapped, once per segment, to the nearest note in the
//      active scale/key (or the custom allowed-note set, which overrides the
//      preset outright).
//   2. jumpiness hold           — a candidate note change is accepted only
//      once >= jumpiness-derived hold time has elapsed since the last
//      accepted commit; otherwise the previously committed note is kept.
//      This is the guard against the "T-Pain flutter" bug: quantizing
//      straight to semitones frame-by-frame with no minimum-hold logic
//      makes the target chatter every time the source dithers across a
//      scale-note boundary.
//   3. retune-speed approach within the hold — while holding on a committed
//      note (i.e. outside the post-switch release window below), the
//      running corrected pitch approaches the committed target with a
//      one-pole time constant of retuneSpeedMs.
//   4. smoothness ramp on release — for smoothnessMs immediately after a
//      note switch is committed, the one-pole time constant is smoothnessMs
//      instead, producing the between-note portamento; retune-speed pull
//      resumes once that window elapses.
//   5. re-add scaled vibrato — the raw correction (corrected-minus-input, in
//      cents) is split by a low-pass filter at ~6 Hz into a slow "center"
//      component (the real pitch-correction signal) and a fast "vibrato"
//      component (the singer's own wobble, which correction would otherwise
//      flatten); preserveVibrato scales how much of the fast component is
//      re-added rather than applied as correction.
//   6. scale total correction by amount — the whole correction (relative to
//      the frame's own input pitch) is scaled by correctionAmount; 0% is a
//      bypass (target == input) even for a voiced, in-scale frame.
// Unvoiced frames (or f0Hz <= 0) always pass through unchanged — this is
// checked before any of the above and short-circuits the whole pipeline.

#include "dsp/PitchTrackAnalysis.h"

#include <cstdint>
#include <vector>

namespace xleth::dsp {

// The 10 scales the AUTOTUNE spec names explicitly: the 7 diatonic modes,
// harmonic and melodic minor, and the two pentatonics. Melodic minor here is
// the single ascending-form collection (no separate descending/natural-minor
// switch) — CorrectionCurve has no notion of melodic direction to key that
// off of.
enum class ScaleType {
    Ionian,
    Dorian,
    Phrygian,
    Lydian,
    Mixolydian,
    Aeolian,
    Locrian,
    HarmonicMinor,
    MelodicMinor,
    MajorPentatonic,
    MinorPentatonic,
};

// Product default per the AUTOTUNE spec.
constexpr int       kDefaultKey   = 2;  // D
constexpr ScaleType kDefaultScale = ScaleType::Phrygian;

// Semitone offsets from the root, ascending, within one octave (first entry
// always 0). Unknown enumerators (can't happen with a scoped enum covering
// every value) fall back to Ionian.
std::vector<int> scaleIntervals(ScaleType scale);

// `scaleIntervals(scale)` transposed by `key` (0=C..11=B) and reduced mod 12,
// sorted ascending. This is the "preset" allowed-note set before any UI
// keyboard override is applied.
std::vector<int> allowedPitchClasses(int key, ScaleType scale);

// The six AUTOTUNE controls, exactly as specced — no more, no less.
struct CorrectionParams {
    double correctionAmount = 100.0;  // 0-100%; 0 = bypass
    double retuneSpeedMs    = 20.0;   // within-note pull time constant (one-pole tau)
    double smoothnessMs     = 20.0;   // between-note release ramp time constant (one-pole tau)
    double jumpiness        = 0.0;    // 0-100%, 1% = 1ms minimum hold; 0 = off (free jump)
    double preserveVibrato  = 100.0;  // 0-100%; 100 = vibrato untouched, 0 = flattened

    // Defaulted so AutotuneParams (sandbox/SandboxOp.h) can EMBED this struct
    // rather than restating its six fields — the op's params and the DSP's
    // params are the same six controls, and two declarations of them would be
    // free to drift exactly the way SandboxOp.h's opening comment warns about.
    bool operator==(const CorrectionParams&) const = default;
};

// One frame of the output curve, on the same grid as the input f0track.
struct CorrectionFrame {
    int64_t posSample       = 0;
    float   targetF0Hz      = 0.0f;  // == input f0Hz when unvoiced or amount == 0
    float   correctionCents = 0.0f;  // signed; targetF0Hz expressed as cents relative to input f0Hz
};

struct CorrectionCurveResult {
    std::vector<CorrectionFrame> frames;
};

// Snaps `hz` to the nearest note (any octave) among `pitchClasses` (0-11,
// duplicates/order don't matter). Returns `hz` unchanged if it is <= 0 or
// `pitchClasses` is empty. Exposed for direct testing of the quantization
// step and reuse by callers that only need single-note snapping.
double quantizeToNearestNote(double hz, const std::vector<int>& pitchClasses);

// f0track/segments: PitchTrackAnalysis's own output for the buffer being
// corrected (segments must be sorted by startSample, non-overlapping, as
// analyzePitchTrack always produces). sampleRate: the rate f0track's
// posSample values are expressed in (same contract as PitchTrackResult).
// scale/key: the active preset. allowedNotes: pitch classes (0-11) from the
// UI keyboard; non-empty OVERRIDES scale/key entirely per the spec, rather
// than merging with it.
CorrectionCurveResult computeCorrectionCurve(
    const std::vector<PitchFrame>&  f0track,
    const std::vector<NoteSegment>& segments,
    double                          sampleRate,
    ScaleType                       scale,
    int                             key,
    const std::vector<int>&         allowedNotes,
    const CorrectionParams&         params);

} // namespace xleth::dsp
