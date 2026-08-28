#pragma once

// AutotuneRender — the audio half of the Sample Sandbox AUTOTUNE op (P5-3).
//
// Takes the two things P5-1 and P5-2 already produce for a buffer — the
// per-frame f0 track + voicing (dsp/PitchTrackAnalysis.h) and the per-frame
// TARGET f0 curve (dsp/CorrectionCurve.h) — and resynthesizes the audio onto
// that target with Praat-style time-domain PSOLA. It re-derives NEITHER: no
// second pitch detector, no second copy of the correction math. Hand it a
// track and a curve; it moves samples.
//
// ── Why a new PSOLA rather than dsp/TDPSOLA.h ────────────────────────────────
// processTDPSOLA is a CONSTANT-ratio shifter: one pitchFactor for the whole
// buffer, marks snapped to zero crossings, and each channel detected and
// resynthesized INDEPENDENTLY. Autotune needs the opposite of all three — a
// ratio that varies per frame under an externally-supplied curve, marks locked
// to the glottal pulse (a zero crossing is not a fixed point of the cycle once
// the ratio moves), and ONE mark set shared by every channel so a stereo image
// survives. Those are different algorithms wearing the same name, so this is a
// separate entry point rather than a fifth mode bolted onto that one. Nothing
// here changes processTDPSOLA or its callers (ClipRenderCache/SlotBakeCache).
//
// ── What it does, in order ───────────────────────────────────────────────────
//   1. Per voiced RUN of the f0 track, place pitch-synchronous ANALYSIS marks:
//      seed on the strongest peak of the first period, then step forward one
//      source period at a time, re-locking each mark to the local peak within
//      ±T0/4. Peaks are picked on a lightly low-passed mono sum so a bright or
//      breathy vowel does not park a mark on a harmonic's ripple.
//   2. Place SYNTHESIS marks along the same (unscaled) timeline at the TARGET
//      period. No time-stretch: output length == input length exactly.
//   3. Overlap-add. Each synthesis mark takes the analysis mark nearest to it
//      and copies that mark's grain — an asymmetric Hann spanning the previous
//      and next analysis periods, i.e. the classic 2x-period window when the
//      pitch is steady — into the output, accumulating a window-sum alongside
//      and dividing by it at the end.
//   4. Unvoiced material is passed through untouched, with a raised-cosine
//      crossfade (`crossfadeMs`) at every voiced<->unvoiced boundary. The
//      correction ITSELF is faded over the same window, so at the seam the
//      resynthesis is a unity-ratio reconstruction of the dry signal and the
//      crossfade has nothing left to smear. That pair is what keeps a plosive
//      or a fricative from clicking on the way in or out of a corrected vowel.
//
// ── Formants ride with the pitch, deliberately ───────────────────────────────
// TD-PSOLA moves the spectral envelope along with the fundamental. That is the
// classic hard-tune sound and it is the intended one here. There is no formant
// correction in this file and there should not be: SandboxOpType::FormantShift
// already exists for the caller who wants the envelope moved independently.
//
// Pure and side-effect-free: no cache, no statics, no logging, no allocation
// beyond its own working vectors. Offline only — this is nowhere near the
// audio callback, and it is far too heavy to be.

#include "dsp/CorrectionCurve.h"
#include "dsp/PitchTrackAnalysis.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <cstdint>
#include <string>

namespace xleth::dsp {

struct AutotuneRenderOptions {
    // Raised-cosine blend width at each voiced<->unvoiced boundary, centred on
    // the boundary. ~10 ms is the shortest window that reliably hides the
    // waveform discontinuity between a resynthesized vowel and a passed-through
    // consonant while still being short enough not to soften the consonant's
    // own attack.
    double crossfadeMs = 10.0;

    // Hard clamp on |target - source|, in cents, applied per frame. A
    // CorrectionCurve driven by a sane scale never asks for more than a few
    // semitones; this exists so one bad segment median (a detector octave
    // error, say) cannot demand a 4-octave grain rate and turn a vowel into a
    // buzz. One octave either way is far outside anything correction needs.
    double maxShiftCents = 1200.0;
};

struct AutotuneRenderResult {
    juce::AudioBuffer<float> buffer;

    // false ⇒ nothing was rendered and `buffer` is untouched/empty; `reason` is
    // human-readable and safe to show the user directly (P5-4 surfaces it).
    // The monophonic gate is the expected cause: see PitchTrackResult::reason.
    bool        ok = false;
    std::string reason;

    // Instrumentation, for tests and the render stats line.
    int     voicedRegions      = 0;   // contiguous voiced runs found
    int     regionsSkipped     = 0;   // runs too short to resynthesize (left dry)
    int64_t grainsSynthesized  = 0;   // synthesis marks overlap-added
    int64_t analysisMarks      = 0;
};

// `track` and `curve` MUST be the same analysis of the same buffer: same frame
// count, same grid. `track.sampleRate` and `sampleRate` must agree (this is the
// engine-buffer rate the caller measured — never an assumed 44.1/48 kHz).
//
// Refuses (ok == false) when: the buffer/rate is degenerate, the two inputs
// disagree on frame count, the track is invalid, or — the case the AUTOTUNE op
// exists to report rather than fake — `track.monophonic` is false.
//
// A buffer that passes the gate but happens to be entirely unvoiced renders as
// an exact copy with ok == true: nothing to correct is not a failure.
AutotuneRenderResult renderAutotune(const juce::AudioBuffer<float>& input,
                                    double                         sampleRate,
                                    const PitchTrackResult&        track,
                                    const CorrectionCurveResult&   curve,
                                    const AutotuneRenderOptions&   opts = {});

} // namespace xleth::dsp
