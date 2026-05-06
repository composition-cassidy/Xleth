// ClipVibratoIntegrator.h — Phase C.1
//
// Pure deterministic helper that computes the source-position offset (in
// samples) that continuous per-sample playback would have accumulated by the
// time it reached a given clip-local sample position.
//
// Used by ClipModulatedReader's seed path on transport seek / scrub / block
// discontinuity, so that a vibrato-enabled clip reseeded at clip-local sample
// M reads from the same source position whether playback reached M
// continuously or jumped there directly.
//
// Stateless. No allocation. Re-uses xleth::clipmod::evaluateVibrato so the
// math cannot drift from the per-sample render loop. Audio-thread safe.

#pragma once

#include <cstdint>

#include "model/TimelineTypes.h"

namespace xleth::audio {

struct VibratoSourceOffsetParams
{
    // Vibrato descriptor (must outlive the call). May be null when
    // topLevelEnabled is false; in that case the helper returns the static
    // closed-form result.
    const ClipModulation::Vibrato* vibrato = nullptr;
    bool    topLevelEnabled = false;

    double  staticRatio     = 1.0;
    double  bpm             = 140.0;
    double  sampleRate      = 48000.0;

    // Target clip-local sample position. The returned offset is what
    // continuous playback would have accumulated to reach this point.
    int64_t clipLocalSamples = 0;

    // Constants for the evaluator's ClipModulationContext.
    double  clipDurationSeconds = 0.0;
    double  clipDurationBeats   = 0.0;

    // Required only when vibrato.phaseResetOnClipStart == false (timeline
    // phase). Ignored otherwise.
    int64_t clipStartTimelineSamples = 0;
};

// Returns the offset in samples that should be ADDED to regionOffsetSamples
// at the seed point. Equivalent to:
//
//   sum_{i=0}^{clipLocalSamples-1} staticRatio * evaluateVibrato(...).pitchRatio
//
// computed exactly for short positions and via shape-aware adaptive midpoint
// integration for long positions. Always returns a finite, non-negative value
// for non-negative clipLocalSamples. Cost is bounded by the strided path:
// worst case is a few hundred thousand evaluator calls for 10-minute seeks
// with smooth shapes (a few milliseconds), more samples per call for
// non-smooth shapes (Square / SawUp / SawDown / Custom-with-jumps).
double computeVibratoIntegratedSourceOffsetSamples(
    const VibratoSourceOffsetParams& p) noexcept;

} // namespace xleth::audio
