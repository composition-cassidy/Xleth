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
float computeRMS(const float* x, int N);

} // namespace xleth::dsp
