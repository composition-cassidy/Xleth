// ClipModulationEvaluator.h — Phase B
//
// Pure deterministic evaluator for per-clip Vibrato and Vinyl Scratch
// modulation descriptors (see ClipModulation in TimelineTypes.h).
//
// Stateless: same inputs always produce the same outputs. Audio (per
// sample/block) and video (per frame) call this from their own threads
// with the same ClipModulation + clip-local time and must agree exactly.
// No persistent phase, no audio-thread state, no globals.
//
// Stateful smoothing/declicking belongs in the future per-reader
// ClipModulatedReader, where local state is allowed.

#pragma once

#include "TimelineTypes.h"
#include <cstdint>

namespace xleth::clipmod {

struct ClipModulationContext {
    double  bpm                = 140.0;
    double  sampleRate         = 48000.0;

    int64_t timelineSamples    = 0;
    double  timelineSeconds    = 0.0;
    double  timelineBeats      = 0.0;

    int64_t clipLocalSamples   = 0;
    double  clipLocalSeconds   = 0.0;
    double  clipLocalBeats     = 0.0;

    double  clipDurationSeconds = 0.0;
    double  clipDurationBeats   = 0.0;
};

struct VibratoEval {
    float  phase01    = 0.0f;
    float  lfo        = 0.0f;
    float  cents      = 0.0f;
    float  semis      = 0.0f;
    double pitchRatio = 1.0;
};

struct ScratchEval {
    float  rateMultiplier      = 1.0f;
    bool   reversed            = false;
    float  intensity01         = 0.0f;
    // Deterministic integral of rate over time at unity pitch — used by
    // future random-access seeking and video sync.
    double sourceOffsetSeconds = 0.0;
    // Deterministic visual helper, derived from sourceOffsetSeconds only.
    float  phase01             = 0.0f;
};

struct ClipModulationEval {
    VibratoEval vibrato;
    ScratchEval scratch;
};

VibratoEval evaluateVibrato(const ClipModulation::Vibrato& vibrato,
                            const ClipModulationContext& ctx,
                            bool topLevelEnabled);

ScratchEval evaluateScratch(const ClipModulation::Scratch& scratch,
                            const ClipModulationContext& ctx,
                            bool topLevelEnabled);

ClipModulationEval evaluateClipModulation(const ClipModulation& modulation,
                                          const ClipModulationContext& ctx);

} // namespace xleth::clipmod
