#pragma once

// LoopOptimizer — offline steady-state detection and loop-candidate generation
// for the Auto Loop Optimizer.
//
// This is the *candidate generation* half of the feature: it decides where a
// loop could plausibly go and returns every viable option, UNRANKED. Scoring,
// ranking and top-3 selection are a separate, later phase and deliberately live
// nowhere in this file.
//
// Everything here is pure and side-effect-free: it reads a sample buffer and
// returns values. It writes no engine state, touches no RPC, and runs on the
// analysis thread — never on the audio callback — so it allocates freely and
// favours correctness and clarity over speed.
//
// Built on the shared primitives in dsp/LoopAnalysis.h (computeNSDF,
// detectPeriod, snapZeroCrossing, computeRMS, normalizedCrossCorrelation,
// bestCorrelationLag).
//
// Scope limits worth stating, since each has a tempting wrong answer:
//   • Pitched-monophonic material only. Material that fails the voicing gate in
//     generateLoopCandidates yields an empty vector rather than a correlation-
//     only guess; the poly/textural fallback is a later phase.
//   • No cost scoring. seamNcc is reported because the alignment search computes
//     it anyway, not as a ranking key.

#include <cstdint>
#include <vector>

namespace xleth::dsp {

// A half-open sample range [start, end) to search within. A zero-length window
// (start == end == 0) is the "no viable region" signal — see
// detectSteadyStateWindow.
struct LoopWindow {
    int64_t start;  // sample index, inclusive
    int64_t end;    // sample index, exclusive
};

// One viable loop point pair. Produced by generateLoopCandidates; consumed by
// the (later) cost function.
struct LoopCandidate {
    int64_t loopStart;         // sample index, snapped to a zero crossing
    int64_t loopEnd;           // sample index, snapped to a zero crossing
    int64_t crossfadeSamples;  // proposed seam crossfade length; see kMinClickSuppressionSamples
    int     periodSamples;     // detected fundamental period this candidate is quantized to
    int     periodMultiple;    // k, where loopEnd - loopStart ≈ k * periodSamples
    float   seamNcc;           // NCC of the two seam regions at the returned alignment, in [-1, 1]
};

// ─── Tuning constants ────────────────────────────────────────────────────────
// Every value below is a documented starting policy, not a tuned one. They are
// named and exposed here (rather than buried in the .cpp) precisely because the
// intent is to calibrate them against the real sample corpus once the diagnostic
// tool has been run over enough material.

// RMS envelope frame for steady-state detection, in milliseconds. 20 ms is long
// enough to average out the waveform of the lowest supported pitch (75 Hz = 13.3
// ms per cycle, so every frame spans at least one full cycle and the envelope
// measures level rather than phase) and short enough to resolve an attack
// transient, which is typically 5–50 ms on plucked and struck material.
inline constexpr double kEnvelopeFrameMs = 20.0;

// Fraction of peak RMS a frame must reach to be considered past the attack
// transient. At 70% of peak the level has arrived but is not required to have
// hit the exact peak frame, which on material with a sharp spike would push the
// window start needlessly late.
inline constexpr float kAttackSkipFrac = 0.70f;

// Fraction of peak RMS a frame must hold to count as part of the sustain
// plateau. 50% (≈ -6 dB below peak) tolerates natural decay and tremolo across a
// long sustain without letting the plateau run down into the release tail.
inline constexpr float kSustainThresholdFrac = 0.50f;

// Lowest pitch treated as loopable, in Hz. Carried over from TDPSOLA's voicing
// floor (sampleRate / 75.0 as its longest lag). 75 Hz sits comfortably below the
// corpus's lowest observed fundamental (C3 ≈ 131 Hz), so it is not a binding
// constraint today; corpus-tunable if sub-bass material ever needs looping.
inline constexpr double kMinPitchHz = 75.0;

// Highest pitch treated as loopable, in Hz. CORPUS-TUNABLE (like the steady-state
// fractions above), NOT a fixed law.
//
// This started at 500 Hz, inherited verbatim from TDPSOLA's voicing ceiling
// (sampleRate / 500.0). That number is a *speech*-range assumption — human vocal
// fundamentals rarely exceed 500 Hz — and TDPSOLA is a voice pitch-shifter, so it
// was right there. It is wrong here: the Auto Loop Optimizer's input is tuned
// pitch samples and vocal chops that routinely sit above 500 Hz, and the very
// first diagnostic run caught it. Pitch_22_C5's true fundamental is 525 Hz
// (period 84 samples at 44.1 kHz), which fell *above* the 500 Hz ceiling, so the
// detector could only see the 2× subharmonic and quantized the loop to 260.9 Hz
// — a clean but octave-wrong period.
//
// Raised to 1800 Hz after a regression sweep over the corpus proved the widening
// is free: at this ceiling Pitch_22_C5 resolves correctly to 525 Hz, while every
// other measured sample (C3, E3, A#3, A3, D4, E4, A4) kept a byte-identical
// detected period and clarity. Lowering the shortest lag toward 24 samples does
// not induce harmonic lock on low material, because detectPeriod takes the first
// key maximum clearing 0.8·peak and a low tone's NSDF is monotonically falling
// through those short lags — there is no earlier peak for it to grab.
//
// 1800 Hz ≈ A6, well past any tuned sample expected in practice, with headroom.
// Re-derive from the corpus if that assumption changes.
inline constexpr double kMaxPitchHz = 1800.0;

// Minimum plateau length for a window to be viable, expressed in periods of the
// lowest supported pitch. Reasoning: a loop needs one period to be the loop body
// itself, a second for the seam-alignment search to have somewhere to look, and
// a third as headroom for the crossfade — below that there is no sustain to loop
// and the honest answer is refusal. At kMinPitchHz this works out to 3/75 s =
// 40 ms; at higher pitches it is proportionally more periods, which is fine
// (this is a floor, not a target).
inline constexpr int kMinViablePeriods = 3;

// Analysis frame and hop for the per-hop period estimate, in samples. Both mirror
// TDPSOLA.cpp's kFrame/kHop exactly so the two agree on what period they see in
// the same material. 512 samples is 10.7 ms at 48 kHz and 11.6 ms at 44.1 kHz —
// inside the 10–20 ms convention at every rate we support.
inline constexpr int kAnalysisFrame = 2048;
inline constexpr int kAnalysisHop   = 512;

// Fraction of analysis hops that must be voiced (detectPeriod returning non-zero)
// for the material to be treated as pitched-monophonic. A strict majority: if
// half or more of the window cannot be assigned a period, a "fundamental" derived
// from the rest is not describing the material, and quantizing a loop to it would
// be fitting a number to noise.
inline constexpr float kMinVoicedFrac = 0.5f;

// Median NSDF peak height required across the voiced hops. detectPeriod's own
// per-hop threshold (0.5) admits weakly periodic frames one at a time; requiring
// the *median* voiced hop to clear 0.7 asserts something stronger — that the
// window is dominated by strongly periodic frames rather than merely containing
// some. Placeholder pending corpus calibration.
inline constexpr float kMinMedianClarity = 0.7f;

// Longest loop we will propose, in seconds. Past a couple of seconds a "loop"
// has stopped being a sustain loop and become a phrase repeat, which is a
// different feature with different criteria. Also bounds the candidate count on
// high-pitched material, where the period is short and k would otherwise run into
// the thousands.
inline constexpr double kMaxLoopDurationSec = 2.0;

// Length of the seam correlation windows, in periods. One period is deliberate:
// the alignment search only sweeps ±10% of a period, which is far narrower than
// any harmonic ambiguity, so a longer reference window would buy no robustness
// against octave errors and would only blur the correlation peak by averaging
// over material that drifts across the window.
inline constexpr int kSeamCorrelationPeriods = 1;

// Minimum seam NCC for a candidate to be returned. Deliberately permissive: the
// (later) cost function does the fine discrimination between good and better
// seams, so this floor exists only to drop candidates whose seam regions are
// essentially unrelated — a k whose best lag still cannot correlate is not a real
// option, and returning it would push a known-bad answer into the ranker.
inline constexpr float kMinSeamNcc = 0.5f;

// Crossfade floor, in samples. 64 samples is ~1.3 ms at 48 kHz — long enough to
// round off a discontinuity into something inaudible, short enough not to smear a
// short loop. PLACEHOLDER, explicitly flagged for later calibration against the
// sample corpus: the right floor is a perceptual question that synthetic signals
// cannot answer, and this value is a starting policy chosen to be obviously safe
// rather than measured to be correct.
inline constexpr int64_t kMinClickSuppressionSamples = 64;

// ─── Analysis entry points ───────────────────────────────────────────────────

// Finds the sustained region of a sample, for use ONLY when the caller has no
// user selection to search within.
//
// x: N samples of mono audio, linear amplitude. sampleRate in Hz. Computes an
// RMS envelope in kEnvelopeFrameMs frames, skips forward to the first frame
// reaching kAttackSkipFrac of the envelope's own peak (the attack transient), and
// returns the longest contiguous run from there of frames holding at least
// kSustainThresholdFrac of that peak.
//
// Returns {0, 0} — an empty window — when the material has no sustain to loop:
// a silent buffer, a buffer shorter than one frame, or a plateau shorter than
// kMinViablePeriods periods at kMinPitchHz. That empty window is the one-shot
// refusal signal, and callers are expected to treat it as "this sample cannot be
// looped", not as an error.
LoopWindow detectSteadyStateWindow(const float* x, int N, double sampleRate);

// Generates period-quantized, phase-aligned loop candidates within a window.
//
// x: N samples of mono audio, linear amplitude. sampleRate in Hz. window: the
// region to search, either user-supplied or from detectSteadyStateWindow.
//
// The window is a HARD boundary: no loop point is placed outside it and no sample
// outside it is read. ("Soft" edges, per the product spec, means the window's own
// edges are never used verbatim as loop points — not that the boundary itself is
// negotiable.)
//
// Runs a per-hop period estimate across the window and gates on it: if fewer than
// kMinVoicedFrac of hops are voiced, or the median voiced clarity is below
// kMinMedianClarity, the material is not reliably pitched-monophonic and the
// result is an EMPTY vector. There is deliberately no correlation-only fallback —
// that is a later, separate phase, and guessing here would launder unpitched
// material into confident-looking candidates.
//
// Otherwise the fundamental is the median period across voiced hops (robust to
// per-hop jitter and outliers, which a single hop's estimate is not), and one
// candidate is generated per loop length k*periodSamples, each phase-aligned by
// correlation search and snapped to zero crossings. Candidates falling outside
// the window or below kMinSeamNcc are dropped.
//
// Returns the surviving candidates in ascending k order, UNRANKED — the order is
// generation order and carries no quality meaning. Returns empty (never garbage,
// never NaN) for silent, unpitched, too-short, or degenerate input.
std::vector<LoopCandidate> generateLoopCandidates(const float* x, int N,
                                                  double sampleRate,
                                                  LoopWindow window);

} // namespace xleth::dsp
