#pragma once

#include <cstdint>

// ─── Varispeed resample ───────────────────────────────────────────────────────
//
// "Play it faster and it goes up" — the tape/turntable pitch move, where pitch
// and length are the SAME parameter. This is the counterpart to the
// time-preserving RubberBand path (dsp/RubberBandWrapper.h): that one holds
// length fixed and rebuilds the spectrum, this one holds the waveform fixed and
// changes how fast it is read.
//
// Neither is a better version of the other. Time-preserving is what you want on
// a vocal that has to stay in the pocket; varispeed is what you want when the
// artefacts of a phase vocoder are the problem, when the material is a one-shot
// whose length nobody is counting, or when the tape-speed character IS the
// effect. Sandbox's PITCH op exposes both through SandboxPitchMode.
//
// ── Why this is model-tier, and takes raw pointers ───────────────────────────
// SandboxOp::outputLength has to predict the resulting length WITHOUT rendering
// (it runs in XlethEngineModel, which has no JUCE and no buffers), while
// SandboxRenderer has to produce exactly that many samples. Two copies of
// "how long does this get" would be free to disagree, and a stack whose
// predicted length drifts from its rendered length is precisely the class of
// bug the sandbox's cache keying exists to avoid. So the length rule and the
// resampler that must honour it live in ONE file, at the tier both callers can
// reach, over plain float pointers rather than a buffer type only one of them
// can name.

namespace xleth::dsp {

// Beyond ±4 octaves a varispeed move is no longer an edit anyone is auditioning
// — it is a number that got typed wrong, and letting it through would ask for a
// buffer either 16× too long or one sample short. Clamped rather than rejected:
// an op is never an error in this engine, it is at worst a bounded extreme.
inline constexpr double kVarispeedMaxCents = 4800.0;

// Input samples consumed per output sample. > 1 = pitched UP (shorter),
// < 1 = pitched DOWN (longer). `cents` is clamped to ±kVarispeedMaxCents;
// a non-finite value is treated as 0 (unity).
double varispeedRatio(double cents) noexcept;

// Length a varispeed move by `cents` produces from `inputLength` samples.
// Rounds to nearest, and never collapses non-empty input to nothing — the
// shortest a real buffer can become is one sample, not zero.
int64_t varispeedOutputLength(int64_t inputLength, double cents) noexcept;

// Band-limited resample of ONE channel: reads `in` at `ratio` input samples per
// output sample and writes exactly `outLen` samples to `out`.
//
// ── Why a windowed sinc rather than juce::LagrangeInterpolator ───────────────
// ClipRenderCache uses Lagrange for its rate conversion, which is the right
// call there: it runs per playback block and the ratios are small. A varispeed
// pitch-up is decimation by up to 16×, and a fixed 5-point interpolator has no
// mechanism to remove the content that folds when you decimate — an octave up
// would alias everything above 12 kHz back down into the audible band, audibly
// and permanently, in an OFFLINE render the user then bakes. The kernel here
// scales its cutoff with the ratio (cutoff = min(1, 1/ratio)), which is what
// makes it an anti-aliasing decimator on the way up and a plain interpolator on
// the way down, and the cost of the wider kernel is paid once per edit.
//
// Taps that fall outside the input are simply not summed, and the result is
// normalized by the weight actually used — so the kernel narrows gracefully at
// both edges instead of fading into (or ringing against) invented silence.
void resampleVarispeed(const float* in, int64_t inLen,
                       float* out, int64_t outLen,
                       double ratio) noexcept;

} // namespace xleth::dsp
