#pragma once

// AutoLoopPolicy — the selection-first "AUTO" loop policy (round-4 policy v2),
// ported from the Python reference optimizer (tools/loop_optimizer, policy_v2).
//
// This is the SHIPPING product: the user drags a rough region (or takes the
// whole sample) and the machine snaps a period-aligned, formant-stable loop
// inside it. It is NOT full-auto placement — three blind rating rounds showed
// full-auto loses to human gold, while the in-selection policy reached parity
// with a monotonic trend (see docs + the loop_optimizer README). No confidence
// model: measured features cannot predict acceptance (LOO AUC 0.53), so the
// caller ships "smart snap, user nudges" and logs telemetry instead.
//
// The chain, end to end (mirrors loop_optimizer/export.py::policy_v2_loop):
//   1. measure the fundamental period with the engine's own NSDF detector
//      (LoopAnalysis.h computeNSDF/detectPeriod) — NOT YIN. See the .cpp for the
//      documented NSDF-vs-YIN divergence and the sub-sample refinement that
//      keeps the two within tolerance;
//   2. inside the selection ±POLICY_SELECTION_MARGIN_FRAC, enumerate every
//      period-multiple loop LENGTH and, per length, the seam-NCC placements
//      (candidates.py viable_lengths + a cosine sliding end-match);
//   3. track F1-F3 (LPC) across the window and reject placements whose formant
//      drift exceeds the lowest-quartile-or-50-cents cut — the round-4
//      hypothesis that timbre-jump losses are a PLACEMENT problem;
//   4. take the LONGEST surviving span, and the longest period-multiple
//      crossfade the engine's clamp leaves untouched (xfade_variants).
//
// DELIBERATE PORT SCOPE — the fade gates are omitted. The round-4 corpus proved
// them inert: across all 25 policy_v2 arms the formant-fade gate never fired
// (max 216 cents vs a 300-cent gate) and the click/flam mechanical guards never
// bound (gold measures click 0.79-1.07 vs 2.0, flam 0.0 vs 20), so
// chosen_xfade == max_xfade on every corpus sample. Porting the render + metric
// suite those gates need would cost ~a full engine_emu render per fade width for
// zero change in output. The placement/drift gate — the one that actually fires
// (it shortened 18 of 25 spans) — IS ported in full. If a future corpus makes a
// fade gate bind, re-port measure_perceptual's click/flam here.
//
// Everything in this header is PURE and side-effect-free: it reads a sample
// buffer and returns values. It writes no engine state, touches no RPC, and runs
// on the UI action thread (never the audio callback), so it allocates freely and
// favours correctness over speed. Target: <=250 ms for a 5 s mono sample.

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace xleth::dsp {

// ─── Policy v2 tuning constants (mirror loop_optimizer/export.py + constants.py) ─
// Every value carries the provenance the Python reference records. "Corpus-
// bounded" means measured against the gold corpus, not derived a priori.

// How far the selection window extends past the user's drag on each side, as a
// fraction of the drag's own length. Stands in for the slop in a rough drag.
inline constexpr double kPolicySelectionMarginFrac = 0.15;

// Placement gate: the fraction of candidate spans (ranked by formant drift) that
// stay eligible. A deliberately weak quartile filter — length decides within the
// survivors. (FORMANT_DRIFT_QUANTILE)
inline constexpr double kFormantDriftQuantile = 0.25;

// ...and a span this stable is kept whatever the quartile says. Load-bearing:
// drift is a std over the span's frames, so it creeps up with length even on a
// held vowel; a pure quartile would prefer SHORT loops on every sample. 50 cents
// ~= +/-3% formant movement, under the ~5-8% JND. (FORMANT_STABLE_DRIFT_CENTS)
inline constexpr double kFormantStableDriftCents = 50.0;

// Longest / shortest loop we will propose, in seconds (MAX/MIN_LOOP_DURATION_SEC).
// Prefixed to avoid colliding with LoopOptimizer.h's identically-named engine-
// window constant (same value; both TUs are pulled together by AutoLoopPolicy.cpp).
inline constexpr double kPolicyMaxLoopDurationSec = 2.0;
inline constexpr double kPolicyMinLoopDurationSec = 0.05;

// Guards against pathological runtime, not quality policy (MAX_PERIOD_MULTIPLES /
// MAX_XFADE_PERIOD_MULTIPLES / MAX_SPAN_ATTEMPTS).
inline constexpr int kMaxPeriodMultiples    = 512;
inline constexpr int kMaxXfadePeriodMultiples = 16;
inline constexpr int kMaxSpanAttempts        = 32;

// Minimum seam NCC for a placement to be considered (MIN_SEAM_NCC). Cosine, not
// mean-removed Pearson — see slidingEndMatchNcc in the .cpp.
inline constexpr float kPolicyMinSeamNcc = 0.5f;

// Length of the seam correlation window, in periods (SEAM_CORRELATION_PERIODS).
// Prefixed for the same reason as kPolicyMaxLoopDurationSec above.
inline constexpr int kPolicySeamCorrelationPeriods = 1;

// Margin, in periods, used ONLY to derive the fundamental period (mirrors
// analysis.py _select_window for --selection gold, default margin_periods=8).
inline constexpr double kPeriodWindowMarginPeriods = 8.0;

// ─── Formant tracker constants (mirror loop_optimizer/formants.py) ────────────
inline constexpr double kFormantBandHz        = 4500.0;
inline constexpr double kFormantFrameMs       = 30.0;
inline constexpr double kFormantHopMs         = 10.0;
inline constexpr int    kFormantLpcOrder      = 12;
inline constexpr double kFormantMinHz         = 90.0;
inline constexpr double kFormantMaxHz         = 4200.0;
inline constexpr double kFormantMaxBandwidthHz = 500.0;
inline constexpr double kFormantPreemphasis   = 0.97;
inline constexpr int    kNumFormants          = 3;

// ─── Results ──────────────────────────────────────────────────────────────────

// The policy's answer, in ENGINE-buffer samples (the domain the Sampler's
// loopStart/loopEnd/crossfadeSamples fields live in). `valid == false` is a
// legitimate refusal — material too short, unpitched, or no stable placement.
struct AutoLoopResult {
    bool    valid = false;
    int64_t loopStart = 0;
    int64_t loopEnd = 0;
    int64_t crossfadeSamples = 0;

    // Telemetry / audit — what the gates did, mirroring PolicyV2Trace fields that
    // survive the fade-gate omission.
    double  period = 0.0;            // measured fundamental period, samples
    int     periodMultiple = 0;      // k of the chosen span
    double  spanDriftCents = 0.0;    // formant drift of the chosen span
    double  selectionMedianDriftCents = 0.0;
    double  driftCutCents = 0.0;
    int     spansConsidered = 0;
    int     spansKept = 0;
    int64_t longestSpan = 0;         // longest span the selection could hold
    int     maxXfade = 0;            // longest fade available (== chosen here)

    // Which gates bound this result, for the telemetry `gates_bound[]`. Contains
    // "placement_drift" when the drift gate shortened the span below the longest
    // available; empty when the policy took the whole drag.
    std::vector<std::string> gatesBound;

    std::string reason;              // human-readable, set when !valid
};

// The full policy v2 chain. `x`: N samples of mono audio at `sampleRate`
// (the ENGINE buffer rate — caller MUST measure it, never assume 48000).
// `selStart`/`selEnd`: the user's selection (engine domain). Pass [0, N) for
// "whole sample". Returns loop points in the same engine domain.
AutoLoopResult autoLoopForSelection(const float* x, int N, double sampleRate,
                                    int64_t selStart, int64_t selEnd);

// ─── Primitives exposed for the parity/validation harness ─────────────────────
// (loop_optimizer parity is asserted against these directly.)

// Per-hop fundamental period across [0, N), in samples, sub-sample refined; 0.0
// where a hop is unvoiced. Frame/hop/lag bounds match the Python track_pitch
// grid so the two f0 estimates line up hop-for-hop. Used by the NSDF-vs-YIN
// validation the task requires.
std::vector<double> measureHopPeriods(const float* x, int N, double sampleRate);

// Median voiced hop period inside [start, end); mirrors analysis._period_in_window.
// NaN if no voiced hop anywhere.
double periodInWindow(const float* x, int N, double sampleRate,
                      int64_t start, int64_t end);

// F1-F3 of one already-extracted frame, in Hz (NaN where unresolved). The raw
// LPC pole read, exposed so the harness can diff it against formants.frame_formants.
std::array<double, kNumFormants> frameFormantsHz(const float* frame, int n,
                                                 double sampleRate);

} // namespace xleth::dsp
