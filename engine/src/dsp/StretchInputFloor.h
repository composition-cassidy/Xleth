#pragma once

/**
 * StretchInputFloor — the shortest input each stretch engine can actually stretch.
 *
 * WHY THIS EXISTS
 * ---------------
 * TDPSOLA, WSOLA and PhaseVocoder each give up on inputs shorter than one
 * analysis window/period and fall back to `linearResample(in, N, N * ratio)`.
 * That fallback is a VARISPEED: it produces the right output length by playing
 * the input slower, which transposes it DOWN by the stretch ratio. A 4× clip
 * therefore drops two octaves the moment its input dips below the floor.
 *
 * The input length a cached clip gets is `clipDuration / stretchRatio`, so the
 * bigger the stretch, the shorter the input — which is why the symptom showed up
 * as "stretch a sample really long, then trim a small piece off it and the piece
 * sounds pitched down". The clip was never the problem; the input was 1/ratio of
 * its length.
 *
 * ClipRenderCache uses these floors to read EXTRA source material past what the
 * clip strictly needs (the trimmed-away audio is right there in the region) and
 * then discards the extra output, so the engines stay on their real path and the
 * pitch is correct. Only when the source itself runs out does it zero-pad.
 *
 * The numbers mirror private constants in the DSP translation units. test_tdpsola
 * pins the PSOLA one to the implementation so the two cannot drift apart
 * silently.
 */

#include <algorithm>
#include <cmath>

namespace xleth::dsp {

/** TDPSOLA.cpp kMinDurSec — 50 ms of audio, whatever the sample rate. */
inline constexpr double kPsolaMinInputSec = 0.05;

/** WSOLA.cpp kWindowSize — one OLA grain. */
inline constexpr int kWsolaMinInputSamples = 1024;

/** PhaseVocoder.cpp kWindowSize — one STFT frame. */
inline constexpr int kPhaseVocoderMinInputSamples = 1024;

/**
 * Shortest input `stretchMethod` can process without degrading to varispeed.
 *
 * stretchMethod uses the StretchMethod enum's wire values, already resolved
 * (i.e. Global has been replaced by the project's real method):
 *   1 = PSOLA, 2 = RubberBand, 3 = WSOLA, 4 = PhaseVocoder, 5 = WORLD
 * RubberBand and WORLD have no such fallback and return 0.
 *
 * pitchShiftSemitones matters for WSOLA only: it resamples for pitch BEFORE
 * windowing, so an upward shift shortens the buffer the window has to fit into.
 */
inline int minStretchInputSamples(int    stretchMethod,
                                 double sampleRate,
                                 double pitchShiftSemitones = 0.0)
{
    switch (stretchMethod) {
        case 1: // PSOLA
            return std::max(1, static_cast<int>(std::lround(sampleRate * kPsolaMinInputSec)));
        case 3: { // WSOLA
            const double pitchRatio = std::pow(2.0, pitchShiftSemitones / 12.0);
            const double scale      = std::max(1.0, pitchRatio);
            return static_cast<int>(std::ceil(kWsolaMinInputSamples * scale));
        }
        case 4: // PhaseVocoder
            return kPhaseVocoderMinInputSamples;
        default: // 2 = RubberBand, 5 = WORLD, unknown → no varispeed fallback
            return 0;
    }
}

} // namespace xleth::dsp
