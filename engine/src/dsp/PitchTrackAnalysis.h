#pragma once

// PitchTrackAnalysis — dense per-frame f0 curve + note segmentation for the
// Sample Sandbox's AUTOTUNE op (the "detection" half; correction is a later
// prompt). Built entirely on the shared NSDF primitives in LoopAnalysis.h
// (computeNSDFFft/detectPeriod/refinePeriodNSDF) — the same detector the Loop
// Lab AUTO button uses — rather than a second pitch-detection algorithm.
//
// AUTOTUNE is monophonic-only by product scope: this file's job on
// polyphonic or unpitched input is a clean, explicit refusal
// (`monophonic == false` + a `reason`), never a plausible-looking but wrong
// pitch curve. The gate started out reusing LoopOptimizer.h's own
// pitched-monophonic contract (kMinVoicedFrac/kMinMedianClarity); measuring it
// against real speech showed that pair is calibrated for a different question
// and refuses ordinary single-voice takes, so the thresholds are now
// AUTOTUNE's own — see the measurement table above them in
// PitchTrackAnalysis.cpp. LoopOptimizer's constants are unchanged.
//
// Pure and side-effect-free, like LoopAnalysis.h/LoopOptimizer.h: reads a
// buffer, returns values, runs on the analysis thread, never the audio
// callback.

#include <cstdint>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace xleth::dsp {

// One analysis frame's pitch estimate, on a fixed hop grid starting at
// sample 0. `posSample` is redundant with (frame index * hop) but kept
// explicit so a reader never has to recompute the grid.
struct PitchFrame {
    int64_t posSample  = 0;      // frame start, in samples at the analyzed rate
    float   f0Hz        = 0.0f;  // 0 when unvoiced
    float   confidence   = 0.0f; // NSDF peak height at the detected lag, [0,1]; 0 when unvoiced
    bool    voiced       = false;
};

// A contiguous run of voiced frames sharing one perceived pitch — see
// analyzePitchTrack for the exact split rule.
struct NoteSegment {
    int64_t     startSample = 0;  // inclusive, in samples at the analyzed rate
    int64_t     endSample   = 0;  // exclusive
    double      medianF0Hz  = 0.0;
    std::string noteName;         // nearest equal-tempered note name, e.g. "A4"
};

struct PitchTrackResult {
    std::vector<PitchFrame>  frames;
    std::vector<NoteSegment> notes;

    double hopSamples = 0.0;  // hop actually used, in samples at sampleRate
    double sampleRate = 0.0;

    // false ⇒ AUTOTUNE must refuse this buffer; `reason` is human-readable
    // and safe to show the user directly.
    bool        monophonic = true;
    std::string reason;

    // False only for a degenerate call (null/empty buffer, non-positive
    // rate) — mirrors LoopAnalysis's "empty in, empty out" contract. An
    // unpitched or polyphonic buffer is a VALID result with
    // monophonic == false, not a degenerate one.
    bool valid() const { return sampleRate > 0.0; }

    // Plain JSON round-trip (no JUCE types in any field) so a Model-tier
    // caller can persist/restore this without linking JUCE. See
    // SandboxPitchTrack.h for how the Sandbox cache uses these.
    nlohmann::json toJson() const;
    static PitchTrackResult fromJson(const nlohmann::json& j);
};

// Runs the NSDF pitch detector over `x` at a dense ~5 ms hop (computed from
// `sampleRate`, never assumed 44.1/48 kHz), segments the voiced runs into
// notes (split on an unvoiced gap or a >1-semitone jump), and sets the
// monophonic gate.
//
// x: N samples of mono audio, linear amplitude. sampleRate: the buffer's OWN
// rate. Returns an invalid result (valid() == false) only when x/N/sampleRate
// are degenerate or the buffer is shorter than one analysis frame.
PitchTrackResult analyzePitchTrack(const float* x, int N, double sampleRate);

} // namespace xleth::dsp
