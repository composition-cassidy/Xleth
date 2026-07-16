#pragma once

// LoopAnalysis — pitch and loop-point analysis primitives shared across the DSP
// layer. These were originally file-local statics inside TDPSOLA.cpp; they are
// promoted here unchanged so other consumers (e.g. the Auto Loop Optimizer) can
// reuse them without duplicating the math.
//
// Everything here is pure: no allocation beyond the returned vectors, no shared
// state, and safe to call from any thread.

#include <vector>

namespace xleth::dsp {

// Amplitude below which a frame is treated as silence, in linear RMS (≈ -60 dB).
inline constexpr float kSilenceRMS = 1.0e-3f;

// Normalised Square Difference Function over lags tau ∈ [tauMin, tauMax]:
//   NSDF[tau] = 2 * Σ x[n]*x[n+tau] / (Σ x[n]² + Σ x[n+tau]²)
// x: N input samples. tauMin/tauMax: lag bounds in samples (tauMax is clamped to
// N-1). Returns tauMax-tauMin+1 values in [-1, 1], index i meaning lag tauMin+i;
// empty if the lag range is degenerate.
std::vector<float> computeNSDF(const float* x, int N, int tauMin, int tauMax);

// Picks the fundamental period from an NSDF produced by computeNSDF.
// nsdf: NSDF values; tauMin: the lag its index 0 corresponds to, in samples.
// threshold: minimum NSDF peak height to consider the frame voiced, in NSDF
// units. Returns the lag of the first key maximum in samples, or 0 if unvoiced.
int detectPeriod(const std::vector<float>& nsdf, int tauMin, float threshold = 0.5f);

// Snaps a pitch mark to the nearest positive-going zero crossing.
// x: N input samples; center: candidate position in samples; t0: local period in
// samples, which bounds the search to ±10% of t0. Returns the chosen position in
// samples, or center unchanged if no crossing lies in range.
int snapZeroCrossing(const float* x, int N, int center, int t0);

// Root-mean-square level of N samples, in linear amplitude (0 for N <= 0).
// The Auto Loop Optimizer's energy-continuity cost term composes this directly
// as |computeRMS(windowA, N) - computeRMS(windowB, N)|; there is deliberately no
// separate RMS-continuity primitive, since that subtraction is the whole of it.
float computeRMS(const float* x, int N);

// ─── Seam-similarity primitives (Auto Loop Optimizer cost function) ───────────
// Written fresh for offline analysis: these run on the analysis thread, never on
// the audio callback, so they allocate freely and favour clarity over speed.

// Zero-mean, unit-variance normalised cross-correlation (Pearson) of two
// equal-length windows:
//   NCC = Σ (a-ā)(b-b̄) / sqrt(Σ (a-ā)² · Σ (b-b̄)²)
// a/b: N samples each, in linear amplitude. Returns a similarity in [-1, 1]:
// 1 = identical shape, -1 = exactly inverted, 0 = uncorrelated. Because both
// windows are mean-removed and variance-normalised, the result is invariant to
// DC offset and gain — level differences belong to the energy term, not here.
// Guards: returns 0 when N <= 0, or when either window has (near-)zero variance,
// which covers silent and constant windows. Never returns NaN or Inf.
float normalizedCrossCorrelation(const float* a, const float* b, int N);

// Result of bestCorrelationLag: the winning offset and its similarity.
struct CorrPeak {
    int   lag;  // offset into the search buffer, in samples
    float ncc;  // normalizedCrossCorrelation at that offset, in [-1, 1]
};

// Phase-alignment search: slides the ref window across the search buffer and
// returns the lag maximising NCC.
// ref/refN: the reference window, refN samples. search/searchN: the buffer to
// slide across. lagMin/lagMax: inclusive offset bounds in samples; lag L
// compares ref[0..refN) against search[L..L+refN), so the range is clamped to
// [max(0, lagMin), min(lagMax, searchN - refN)] to keep the window in bounds.
// Returns the best lag in samples with its NCC in [-1, 1]. Ties resolve to the
// smallest lag. Guards: returns {0, 0.0f} if refN <= 0 or the clamped lag range
// is empty. A silent or constant window yields NCC 0 at every lag (see
// normalizedCrossCorrelation), so the result is {lagMin, 0.0f}, never NaN.
CorrPeak bestCorrelationLag(const float* ref, int refN,
                            const float* search, int searchN,
                            int lagMin, int lagMax);

// Timbral distance between two windows, via their magnitude spectra.
// a/b: N samples each, in linear amplitude. N need not be a power of two: each
// window is Hann-windowed (to keep spectral leakage from smearing tonal peaks
// across bins) and zero-padded internally to the next power of two before the
// FFT. Bins are compared as natural-log magnitudes, floored at log(1e-8) so
// silence cannot produce -Inf.
//
// The metric is L2 (RMS bin-wise difference) over mean-removed log-magnitude
// spectra. Returns >= 0 in nepers (natural-log magnitude units): 0 = identical
// spectral shape, larger = more dissimilar. The scale is unbounded rather than
// normalised to [0, 1]; the cost function is expected to weight this term
// alongside the others anyway.
//
// Two choices worth stating, since both have a tempting wrong answer:
//   • Mean-removed, not raw: a gain change is a constant offset in log-magnitude,
//     so centring cancels it. That keeps this term measuring *shape* only and
//     orthogonal to the energy-continuity term above, instead of double-counting
//     level. Raw L2 would report |log g| for a pure gain change.
//   • L2, not cosine: for tonal material most bins sit pinned at the log floor.
//     That floor is a large shared component which centring does *not* remove,
//     and it dominates a cosine/Pearson inner product — two unrelated sine tones
//     measure as ~0.84 correlated, i.e. falsely similar. Under L2 the shared
//     floor cancels in the difference instead.
//
// Guards: returns 0 when N < 2. Silence needs no special case and gets none — a
// silent window's log-spectrum is flat at the floor, so centring collapses it to
// the zero vector: two silent windows yield exactly 0 (identically empty, hence
// a perfect seam), and sound-versus-silence yields the sounding window's own
// spectral spread (large, as it should be). Never returns NaN or Inf.
float spectralDistance(const float* a, const float* b, int N);

} // namespace xleth::dsp
