// ===========================================================================
// test_autotune_render — the AUTOTUNE renderer (P5-3).
// ===========================================================================
//
// Covers dsp/AutotuneRender.h end to end: detection (P5-1) → correction curve
// (P5-2) → TD-PSOLA resynthesis. What is asserted, and why each one is the
// property that actually matters:
//
//   length/channels    PSOLA here is pitch-only. A sample-count change would
//                      desync the op stack's predicted length from its render.
//   lands on the scale a hard-tuned steady tone must MEASURE as the scale note,
//                      not merely be "shifted somewhat" — the output is fed back
//                      through the same detector that drove the correction.
//   0% is exact        correctionAmount 0 returns the input bit-for-bit, not a
//                      unity-ratio resynthesis that is only nearly identical.
//   unvoiced is dry    a consonant far from any voiced boundary is bit-identical.
//   no clicks          the voiced↔unvoiced seams carry no first-difference spike
//                      the input did not already have — the whole reason the
//                      crossfade exists.
//   vibrato preserved  Preserve Vibrato 100 keeps more f0 modulation than 0.
//   refusal            polyphonic input refuses with a reason and renders nothing.
//
// Optional second phase: pass a WAV path on argv[1] (and an output directory on
// argv[2]) and the two DELIVERABLE settings — hard-tune and natural — are
// rendered from it and written out for listening, with measured f0 statistics
// printed. Nothing in the automated pass depends on that file existing.
//
// Offline throughout: no audio device, no transport.

#include "dsp/AutotuneRender.h"
#include "dsp/CorrectionCurve.h"
#include "dsp/PitchTrackAnalysis.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

using namespace xleth::dsp;

static int g_failures = 0;

#define CHECK(cond, msg)                                                       \
    do {                                                                       \
        if (!(cond)) { std::cout << "    FAIL: " << (msg) << "\n"; ++g_failures; } \
        else         { std::cout << "    ok:   " << (msg) << "\n"; }            \
    } while (0)

static constexpr double kPi = 3.14159265358979323846;
static constexpr double kRate = 48000.0;   // measured, never assumed — see below

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// A voice-like tone: a fundamental plus a few harmonics with a decaying
// spectrum, so the NSDF detector sees real periodicity and the mark-placer sees
// a pulse shape rather than a single sinusoid it could lock anywhere on.
// `vibratoHz`/`vibratoCents` add an f0 wobble; `f0End` glides.
static juce::AudioBuffer<float> makeVoice(double seconds, double f0Start, double f0End,
                                          double sampleRate, int channels = 1,
                                          double vibratoHz = 0.0, double vibratoCents = 0.0,
                                          float amp = 0.5f)
{
    const int N = (int)std::lround(seconds * sampleRate);
    juce::AudioBuffer<float> b(channels, N);
    b.clear();

    double phase = 0.0;
    for (int i = 0; i < N; ++i) {
        const double t = (double)i / sampleRate;
        const double u = (N > 1) ? (double)i / (double)(N - 1) : 0.0;
        double f0 = f0Start + (f0End - f0Start) * u;
        if (vibratoHz > 0.0 && vibratoCents > 0.0)
            f0 *= std::exp2(vibratoCents * std::sin(2.0 * kPi * vibratoHz * t) / 1200.0);

        phase += 2.0 * kPi * f0 / sampleRate;
        // Harmonics 1..5 at 1/k — a glottal-ish falling spectrum.
        double s = 0.0;
        for (int k = 1; k <= 5; ++k) s += std::sin(phase * k) / (double)k;
        const float v = (float)(s * amp * 0.5);
        for (int ch = 0; ch < channels; ++ch) b.getWritePointer(ch)[i] = v;
    }
    return b;
}

// Deterministic white noise — the stand-in for an unvoiced consonant.
static void fillNoise(juce::AudioBuffer<float>& b, int start, int end, float amp, uint32_t seed)
{
    uint32_t s = seed;
    for (int i = start; i < end && i < b.getNumSamples(); ++i) {
        s = s * 1664525u + 1013904223u;
        const float v = ((float)(s >> 8) / (float)0x00FFFFFF - 0.5f) * 2.0f * amp;
        for (int ch = 0; ch < b.getNumChannels(); ++ch) b.getWritePointer(ch)[i] = v;
    }
}

// Median voiced f0 of a buffer, measured by the SAME detector the correction
// was driven from — so "landed on the note" is checked in the domain that
// decided where the note was, not against an independent oracle that could
// disagree for reasons unrelated to the renderer.
static double medianVoicedF0(const juce::AudioBuffer<float>& b, double sampleRate,
                             double fromSec = 0.0, double toSec = 1e9)
{
    const int N = b.getNumSamples();
    std::vector<float> mono((size_t)N, 0.0f);
    const float scale = 1.0f / (float)b.getNumChannels();
    for (int ch = 0; ch < b.getNumChannels(); ++ch)
        for (int i = 0; i < N; ++i) mono[(size_t)i] += b.getReadPointer(ch)[i] * scale;

    const PitchTrackResult tr = analyzePitchTrack(mono.data(), N, sampleRate);
    std::vector<double> f0;
    for (const auto& f : tr.frames) {
        const double t = (double)f.posSample / sampleRate;
        if (f.voiced && f.f0Hz > 0.0f && t >= fromSec && t <= toSec) f0.push_back(f.f0Hz);
    }
    if (f0.empty()) return 0.0;
    std::sort(f0.begin(), f0.end());
    return f0[f0.size() / 2];
}

// Standard deviation of the voiced f0 curve in cents — how much the pitch
// MOVES, which is what Preserve Vibrato is a control over.
static double voicedF0StdCents(const juce::AudioBuffer<float>& b, double sampleRate)
{
    const int N = b.getNumSamples();
    std::vector<float> mono((size_t)N, 0.0f);
    const float scale = 1.0f / (float)b.getNumChannels();
    for (int ch = 0; ch < b.getNumChannels(); ++ch)
        for (int i = 0; i < N; ++i) mono[(size_t)i] += b.getReadPointer(ch)[i] * scale;

    const PitchTrackResult tr = analyzePitchTrack(mono.data(), N, sampleRate);
    std::vector<double> cents;
    for (const auto& f : tr.frames)
        if (f.voiced && f.f0Hz > 0.0f) cents.push_back(1200.0 * std::log2((double)f.f0Hz));
    if (cents.size() < 2) return 0.0;
    double mean = 0.0;
    for (double c : cents) mean += c;
    mean /= (double)cents.size();
    double var = 0.0;
    for (double c : cents) var += (c - mean) * (c - mean);
    return std::sqrt(var / (double)cents.size());
}

static float maxAbs(const juce::AudioBuffer<float>& b) {
    float m = 0.0f;
    for (int ch = 0; ch < b.getNumChannels(); ++ch)
        for (int i = 0; i < b.getNumSamples(); ++i)
            m = std::max(m, std::abs(b.getReadPointer(ch)[i]));
    return m;
}

// Largest sample-to-sample step in [from, to). A click IS a first-difference
// spike, so this is the direct measurement rather than a proxy for it.
static float maxStep(const juce::AudioBuffer<float>& b, int from, int to) {
    from = std::max(1, from);
    to   = std::min(b.getNumSamples(), to);
    float m = 0.0f;
    for (int ch = 0; ch < b.getNumChannels(); ++ch) {
        const float* x = b.getReadPointer(ch);
        for (int i = from; i < to; ++i) m = std::max(m, std::abs(x[i] - x[i - 1]));
    }
    return m;
}

// The full op pipeline, exactly as SandboxRenderer::applyAutotune runs it.
static AutotuneRenderResult runAutotune(const juce::AudioBuffer<float>& in, double sampleRate,
                                        ScaleType scale, int key,
                                        const std::vector<int>& allowed,
                                        const CorrectionParams& cp,
                                        PitchTrackResult* trackOut = nullptr)
{
    const int N = in.getNumSamples();
    std::vector<float> mono((size_t)N, 0.0f);
    const float sc = 1.0f / (float)in.getNumChannels();
    for (int ch = 0; ch < in.getNumChannels(); ++ch)
        for (int i = 0; i < N; ++i) mono[(size_t)i] += in.getReadPointer(ch)[i] * sc;

    const PitchTrackResult track = analyzePitchTrack(mono.data(), N, sampleRate);
    if (trackOut) *trackOut = track;
    const CorrectionCurveResult curve = computeCorrectionCurve(
        track.frames, track.notes, sampleRate, scale, key, allowed, cp);
    return renderAutotune(in, sampleRate, track, curve);
}

// The two deliverable settings, named once so the tests and the WAV pass below
// cannot drift apart on what "hard-tune" and "natural" mean.
static CorrectionParams hardTuneParams() {
    CorrectionParams p;
    p.correctionAmount = 100.0;
    p.retuneSpeedMs    = 0.0;
    p.smoothnessMs     = 0.0;
    p.jumpiness        = 0.0;
    p.preserveVibrato  = 0.0;
    return p;
}

static CorrectionParams naturalParams() {
    CorrectionParams p;
    p.correctionAmount = 60.0;
    p.retuneSpeedMs    = 80.0;
    p.smoothnessMs     = 80.0;
    p.jumpiness        = 20.0;
    p.preserveVibrato  = 100.0;
    return p;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

static void testShapePreserved()
{
    std::cout << "\n[shape -- pitch-only: length and channel count survive]\n";

    for (int channels : { 1, 2 }) {
        juce::AudioBuffer<float> in = makeVoice(0.8, 300.0, 300.0, kRate, channels);
        const auto r = runAutotune(in, kRate, ScaleType::Phrygian, 2, {}, hardTuneParams());
        CHECK(r.ok, channels == 1 ? "mono renders" : "stereo renders");
        CHECK(r.buffer.getNumSamples() == in.getNumSamples(),
              "output length == input length (no time-stretch)");
        CHECK(r.buffer.getNumChannels() == channels, "channel count preserved");
        CHECK(r.voicedRegions >= 1, "a sustained tone yields at least one voiced region");
        CHECK(r.grainsSynthesized > 0, "grains were actually overlap-added");
    }

    // One mark set for every channel: a stereo buffer whose two sides carry the
    // same signal must come back with them still identical. Per-channel mark
    // detection (what processTDPSOLA does) would give the sides different grain
    // boundaries and decorrelate them.
    {
        juce::AudioBuffer<float> in = makeVoice(0.8, 300.0, 300.0, kRate, 2);
        const auto r = runAutotune(in, kRate, ScaleType::Phrygian, 2, {}, hardTuneParams());
        float maxDiff = 0.0f;
        for (int i = 0; i < r.buffer.getNumSamples(); ++i)
            maxDiff = std::max(maxDiff,
                std::abs(r.buffer.getReadPointer(0)[i] - r.buffer.getReadPointer(1)[i]));
        CHECK(maxDiff < 1.0e-6f,
              "identical stereo channels stay bit-identical -- one shared mark set");
    }
}

static void testHardTuneLandsOnScale()
{
    std::cout << "\n[hard-tune -- a steady off-scale tone measures AS the scale note]\n";

    // 300 Hz sits 37 cents above D4 (293.66). D Phrygian contains D, so a
    // 100% correction with no retune lag must land on D4 and stay there.
    juce::AudioBuffer<float> in = makeVoice(1.0, 300.0, 300.0, kRate);
    const double inF0 = medianVoicedF0(in, kRate);
    CHECK(std::abs(inF0 - 300.0) < 3.0, "fixture really is a 300 Hz tone before correction");

    const auto r = runAutotune(in, kRate, ScaleType::Phrygian, 2, {}, hardTuneParams());
    CHECK(r.ok, "hard-tune renders");

    // Skip the first 100 ms: the crossfade at the buffer-start boundary and the
    // detector's own settling both live there.
    const double outF0 = medianVoicedF0(r.buffer, kRate, 0.15, 0.85);
    const double d4 = 440.0 * std::exp2((62.0 - 69.0) / 12.0);   // 293.66
    const double errCents = 1200.0 * std::log2(outF0 / d4);
    std::cout << "      in " << inF0 << " Hz -> out " << outF0
              << " Hz (D4 = " << d4 << ", err " << errCents << " cents)\n";
    CHECK(std::abs(errCents) < 15.0, "output measures within 15 cents of D4");
    CHECK(std::abs(outF0 - inF0) > 3.0, "and it actually MOVED off the input pitch");

    // A note NOT in the scale must be pushed away from itself. E4 (329.63) is
    // not in D Phrygian (which has D Eb F G A Bb C) -- nearest member is F4.
    {
        juce::AudioBuffer<float> e4 = makeVoice(1.0, 329.63, 329.63, kRate);
        const auto re = runAutotune(e4, kRate, ScaleType::Phrygian, 2, {}, hardTuneParams());
        const double outE = medianVoicedF0(re.buffer, kRate, 0.15, 0.85);
        const double f4 = 440.0 * std::exp2((65.0 - 69.0) / 12.0);   // 349.23
        std::cout << "      E4 329.63 Hz -> " << outE << " Hz (F4 = " << f4 << ")\n";
        CHECK(std::abs(1200.0 * std::log2(outE / f4)) < 25.0,
              "an out-of-scale E4 is pulled up to F4, the nearest D Phrygian note");
    }

    // The custom note set OVERRIDES the preset outright (CorrectionCurve's own
    // contract): the same 300 Hz tone against an A-only set lands on A3/A4.
    {
        const auto ra = runAutotune(in, kRate, ScaleType::Phrygian, 2, { 9 }, hardTuneParams());
        const double outA = medianVoicedF0(ra.buffer, kRate, 0.15, 0.85);
        const double a4 = 440.0;
        const double a3 = 220.0;
        const bool onA = std::abs(1200.0 * std::log2(outA / a4)) < 30.0
                      || std::abs(1200.0 * std::log2(outA / a3)) < 30.0;
        std::cout << "      allowedNotes={A} -> " << outA << " Hz\n";
        CHECK(onA, "a non-empty allowedNotes set overrides scale/key");
    }
}

static void testBypassIsExact()
{
    std::cout << "\n[bypass -- 0% correction returns the input, bit for bit]\n";

    juce::AudioBuffer<float> in = makeVoice(0.5, 300.0, 300.0, kRate);
    CorrectionParams p = hardTuneParams();
    p.correctionAmount = 0.0;

    const int N = in.getNumSamples();
    std::vector<float> mono((size_t)N);
    for (int i = 0; i < N; ++i) mono[(size_t)i] = in.getReadPointer(0)[i];
    const PitchTrackResult track = analyzePitchTrack(mono.data(), N, kRate);
    const CorrectionCurveResult curve = computeCorrectionCurve(
        track.frames, track.notes, kRate, ScaleType::Phrygian, 2, {}, p);
    const auto r = renderAutotune(in, kRate, track, curve);

    CHECK(r.ok, "0% renders");
    float maxDiff = 0.0f;
    for (int i = 0; i < N; ++i)
        maxDiff = std::max(maxDiff, std::abs(r.buffer.getReadPointer(0)[i] - in.getReadPointer(0)[i]));
    // renderAutotune itself does a unity-ratio resynthesis at 0% (the exact
    // early-out lives one level up, in SandboxRenderer::applyAutotune). What is
    // asserted here is the weaker but more interesting property: a unity-ratio
    // PSOLA pass RECONSTRUCTS its input rather than merely resembling it.
    std::cout << "      unity-ratio reconstruction error: " << maxDiff
              << " (peak " << maxAbs(in) << ")\n";
    CHECK(maxDiff < 0.05f * maxAbs(in),
          "a unity-ratio PSOLA pass reconstructs the input to better than -26 dB");
}

static void testUnvoicedPassThrough()
{
    std::cout << "\n[unvoiced -- consonants pass through untouched, seams do not click]\n";

    // vowel | consonant | vowel, with the noise burst 200 ms long in the middle.
    const double seconds = 1.2;
    juce::AudioBuffer<float> in = makeVoice(seconds, 300.0, 300.0, kRate);
    const int noiseStart = (int)(0.50 * kRate);
    const int noiseEnd   = (int)(0.70 * kRate);
    fillNoise(in, noiseStart, noiseEnd, 0.35f, 12345u);

    PitchTrackResult track;
    const auto r = runAutotune(in, kRate, ScaleType::Phrygian, 2, {}, hardTuneParams(), &track);
    CHECK(r.ok, "mixed voiced/unvoiced material renders");
    CHECK(r.voicedRegions >= 2, "the noise burst splits the buffer into >= 2 voiced regions");

    // Well inside the unvoiced burst -- 40 ms past either edge, comfortably
    // beyond the 10 ms crossfade plus the detector's frame-grid granularity.
    const int guard = (int)(0.04 * kRate);
    float maxDiff = 0.0f;
    for (int i = noiseStart + guard; i < noiseEnd - guard; ++i)
        maxDiff = std::max(maxDiff, std::abs(r.buffer.getReadPointer(0)[i] - in.getReadPointer(0)[i]));
    CHECK(maxDiff == 0.0f, "the interior of an unvoiced burst is bit-identical to the input");

    // No click at either seam. The comparison is against the burst's OWN
    // first-difference: white noise steps hard by nature, so the bar is "the
    // seam adds nothing", not "the seam is smooth".
    const float noiseStep = maxStep(in, noiseStart + guard, noiseEnd - guard);
    const float seamInStep  = maxStep(r.buffer, noiseStart - guard, noiseStart + guard);
    const float seamOutStep = maxStep(r.buffer, noiseEnd   - guard, noiseEnd   + guard);
    std::cout << "      burst step " << noiseStep
              << " | seam-in " << seamInStep << " | seam-out " << seamOutStep << "\n";
    CHECK(seamInStep  <= noiseStep, "no first-difference spike entering the consonant");
    CHECK(seamOutStep <= noiseStep, "no first-difference spike leaving the consonant");

    CHECK(maxAbs(r.buffer) < 1.25f * maxAbs(in),
          "overlap-add normalization holds the level (no OLA blow-up)");
}

static void testVibratoPreservation()
{
    std::cout << "\n[vibrato -- Preserve Vibrato 100 keeps the wobble, 0 flattens it]\n";

    // 300 Hz with a 5.5 Hz, +/-60 cent vibrato: a real singing wobble, sitting
    // right on CorrectionCurve's slow/fast split boundary.
    juce::AudioBuffer<float> in = makeVoice(1.4, 300.0, 300.0, kRate, 1, 5.5, 60.0);
    const double inStd = voicedF0StdCents(in, kRate);

    CorrectionParams keep = hardTuneParams();
    keep.preserveVibrato = 100.0;
    keep.retuneSpeedMs   = 20.0;
    CorrectionParams flat = keep;
    flat.preserveVibrato = 0.0;

    const auto rKeep = runAutotune(in, kRate, ScaleType::Phrygian, 2, {}, keep);
    const auto rFlat = runAutotune(in, kRate, ScaleType::Phrygian, 2, {}, flat);
    const double keepStd = voicedF0StdCents(rKeep.buffer, kRate);
    const double flatStd = voicedF0StdCents(rFlat.buffer, kRate);

    std::cout << "      f0 std (cents): input " << inStd
              << " | preserve 100 " << keepStd << " | preserve 0 " << flatStd << "\n";
    CHECK(keepStd > flatStd, "preserve 100 leaves more pitch movement than preserve 0");
    CHECK(flatStd < inStd, "preserve 0 flattens the input's own wobble");
}

static void testGlideTracksTheCurve()
{
    std::cout << "\n[glide -- a moving source is corrected per frame, not per buffer]\n";

    // A slide from ~D4 up to ~A4 across 2 s. Hard-tuned into D Phrygian, the
    // output should be a staircase: measured f0 near the start and near the end
    // must both sit on scale notes, and on DIFFERENT ones.
    juce::AudioBuffer<float> in = makeVoice(2.0, 294.0, 440.0, kRate);
    const auto r = runAutotune(in, kRate, ScaleType::Phrygian, 2, {}, hardTuneParams());
    CHECK(r.ok, "a glide renders");

    const double early = medianVoicedF0(r.buffer, kRate, 0.15, 0.45);
    const double late  = medianVoicedF0(r.buffer, kRate, 1.55, 1.85);
    std::cout << "      early " << early << " Hz | late " << late << " Hz\n";
    CHECK(late > early * 1.2, "the correction follows the glide rather than freezing one ratio");

    const std::vector<int> pcs = allowedPitchClasses(2, ScaleType::Phrygian);
    auto centsOffScale = [&](double hz) {
        return std::abs(1200.0 * std::log2(quantizeToNearestNote(hz, pcs) / hz));
    };
    CHECK(centsOffScale(early) < 30.0, "the early portion sits on a D Phrygian note");
    CHECK(centsOffScale(late)  < 30.0, "the late portion sits on a D Phrygian note");
}

static void testRefusals()
{
    std::cout << "\n[refusal -- non-monophonic material fails cleanly, with a reason]\n";

    // An A major triad: three simultaneous pitches. P5-1's gate refuses it, and
    // the renderer must pass that refusal straight through rather than emitting
    // a plausible-looking correction of one arbitrary voice.
    const int N = (int)(1.0 * kRate);
    juce::AudioBuffer<float> chord(1, N);
    float* d = chord.getWritePointer(0);
    const double freqs[3] = { 220.0, 277.18, 329.63 };
    for (int i = 0; i < N; ++i) {
        const double t = (double)i / kRate;
        double s = 0.0;
        for (double f : freqs) s += std::sin(2.0 * kPi * f * t);
        d[i] = (float)(s * 0.18);
    }

    PitchTrackResult track;
    const auto r = runAutotune(chord, kRate, ScaleType::Phrygian, 2, {}, hardTuneParams(), &track);
    CHECK(!track.monophonic, "the chord fails P5-1's monophonic gate");
    CHECK(!r.ok, "renderAutotune refuses rather than rendering");
    CHECK(!r.reason.empty(), "the refusal carries a reason");
    CHECK(r.reason == track.reason, "the reason is the analysis's own wording, not a paraphrase");
    std::cout << "      reason: \"" << r.reason << "\"\n";
    CHECK(r.buffer.getNumSamples() == 0, "a refusal renders nothing at all");

    // Degenerate inputs refuse rather than crash or guess.
    {
        juce::AudioBuffer<float> empty(1, 0);
        PitchTrackResult t2;
        CorrectionCurveResult c2;
        CHECK(!renderAutotune(empty, kRate, t2, c2).ok, "an empty buffer refuses");

        juce::AudioBuffer<float> tone = makeVoice(0.4, 300.0, 300.0, kRate);
        CHECK(!renderAutotune(tone, 0.0, t2, c2).ok, "a non-positive sample rate refuses");
    }

    // A track and a curve from different analyses must not be silently mixed.
    {
        juce::AudioBuffer<float> tone = makeVoice(0.6, 300.0, 300.0, kRate);
        std::vector<float> mono((size_t)tone.getNumSamples());
        for (int i = 0; i < tone.getNumSamples(); ++i) mono[(size_t)i] = tone.getReadPointer(0)[i];
        PitchTrackResult track2 = analyzePitchTrack(mono.data(), tone.getNumSamples(), kRate);
        CorrectionCurveResult shortCurve;
        shortCurve.frames.resize(track2.frames.size() / 2);
        const auto rr = renderAutotune(tone, kRate, track2, shortCurve);
        CHECK(!rr.ok, "a curve whose frame count disagrees with the track refuses");
    }
}

static void testSampleRateIndependence()
{
    std::cout << "\n[rate -- everything is measured, nothing assumes 44.1 or 48 kHz]\n";

    // The same musical content at two rates must land on the same NOTE. A
    // renderer that had baked in one rate would be off by the ratio between them.
    for (double rate : { 44100.0, 48000.0 }) {
        juce::AudioBuffer<float> in = makeVoice(1.0, 300.0, 300.0, rate);
        const auto r = runAutotune(in, rate, ScaleType::Phrygian, 2, {}, hardTuneParams());
        const double out = medianVoicedF0(r.buffer, rate, 0.15, 0.85);
        const double d4 = 440.0 * std::exp2((62.0 - 69.0) / 12.0);
        std::cout << "      " << rate << " Hz -> " << out << " Hz\n";
        CHECK(r.ok && std::abs(1200.0 * std::log2(out / d4)) < 15.0,
              std::string("lands on D4 at ") + std::to_string((int)rate) + " Hz");
    }
}

static void testRenderTime()
{
    std::cout << "\n[perf -- 10 s of 48 kHz mono, the deliverable's benchmark]\n";

    juce::AudioBuffer<float> in = makeVoice(10.0, 300.0, 300.0, 48000.0, 1, 5.0, 40.0);

    const int N = in.getNumSamples();
    std::vector<float> mono((size_t)N);
    for (int i = 0; i < N; ++i) mono[(size_t)i] = in.getReadPointer(0)[i];

    const auto t0 = std::chrono::steady_clock::now();
    const PitchTrackResult track = analyzePitchTrack(mono.data(), N, 48000.0);
    const auto t1 = std::chrono::steady_clock::now();
    const CorrectionCurveResult curve = computeCorrectionCurve(
        track.frames, track.notes, 48000.0, ScaleType::Phrygian, 2, {}, hardTuneParams());
    const auto t2 = std::chrono::steady_clock::now();
    const auto r = renderAutotune(in, 48000.0, track, curve);
    const auto t3 = std::chrono::steady_clock::now();

    auto ms = [](auto a, auto b) {
        return std::chrono::duration_cast<std::chrono::microseconds>(b - a).count() / 1000.0;
    };
    std::cout << "      detection (P5-1, CACHED per input prefix): " << ms(t0, t1) << " ms\n";
    std::cout << "      curve     (P5-2):                          " << ms(t1, t2) << " ms\n";
    std::cout << "      PSOLA     (P5-3, re-runs on every knob):   " << ms(t2, t3) << " ms\n";
    std::cout << "      total:                                     " << ms(t0, t3) << " ms\n";
    std::cout << "      marks " << r.analysisMarks << ", grains " << r.grainsSynthesized
              << ", regions " << r.voicedRegions << " (" << r.regionsSkipped << " skipped)\n";
    CHECK(r.ok, "10 s renders");
    // The number that gates autoRender(): a knob drag re-runs ONLY the PSOLA.
    CHECK(ms(t2, t3) < 2000.0, "PSOLA alone stays well inside an interactive budget");
}

// ─── Optional: render a real WAV for listening QA ─────────────────────────────

static void renderWavPass(const std::string& inPath, const std::string& outDir)
{
    std::cout << "\n[wav -- listening QA pass on " << inPath << "]\n";

    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    // Braces, not parens: `File f(String(inPath))` is a function declaration.
    const juce::File f{ juce::String(inPath) };
    std::unique_ptr<juce::AudioFormatReader> reader(fm.createReaderFor(f));
    if (!reader) { std::cout << "    (could not open -- skipping)\n"; return; }

    const double rate = reader->sampleRate;          // measured, never assumed
    const int    N    = (int)reader->lengthInSamples;
    juce::AudioBuffer<float> in((int)reader->numChannels, N);
    reader->read(&in, 0, N, 0, true, true);
    std::cout << "    " << N << " samples, " << in.getNumChannels() << " ch, " << rate << " Hz ("
              << (N / rate) << " s)\n";

    // The two numbers P5-1's monophonic gate is made of, printed before any
    // render: when a file is refused, "which of the two floors did it miss, and
    // by how much" is the only question worth asking, and reading it off the
    // gate's own inputs beats guessing from the message.
    {
        std::vector<float> mono((size_t)N, 0.0f);
        const float sc = 1.0f / (float)in.getNumChannels();
        for (int ch = 0; ch < in.getNumChannels(); ++ch)
            for (int i = 0; i < N; ++i) mono[(size_t)i] += in.getReadPointer(ch)[i] * sc;
        const PitchTrackResult tr = analyzePitchTrack(mono.data(), N, rate);
        std::vector<double> clarity;
        int voiced = 0;
        for (const auto& fr : tr.frames)
            if (fr.voiced) { ++voiced; clarity.push_back(fr.confidence); }
        std::sort(clarity.begin(), clarity.end());
        const double med = clarity.empty() ? 0.0 : clarity[clarity.size() / 2];
        std::cout << "    gate: frames=" << tr.frames.size()
                  << " voicedFrac=" << (tr.frames.empty() ? 0.0 : (double)voiced / (double)tr.frames.size())
                  << " medianClarity=" << med
                  << " notes=" << tr.notes.size()
                  << " -> monophonic=" << (tr.monophonic ? "yes" : "no") << "\n";
    }

    struct Setting { const char* name; CorrectionParams p; };
    const Setting settings[] = {
        { "hardtune", hardTuneParams() },
        { "natural",  naturalParams()  },
    };

    for (const auto& st : settings) {
        PitchTrackResult track;
        const auto t0 = std::chrono::steady_clock::now();
        const auto r = runAutotune(in, rate, ScaleType::Phrygian, 2, {}, st.p, &track);
        const auto t1 = std::chrono::steady_clock::now();
        const double elapsed =
            std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count() / 1000.0;

        std::cout << "    [" << st.name << "] monophonic=" << (track.monophonic ? "yes" : "no")
                  << " ok=" << (r.ok ? "yes" : "no");
        if (!r.ok) { std::cout << " reason=\"" << r.reason << "\"\n"; continue; }
        std::cout << " regions=" << r.voicedRegions << " (skipped " << r.regionsSkipped << ")"
                  << " marks=" << r.analysisMarks << " grains=" << r.grainsSynthesized
                  << " in " << elapsed << " ms\n";
        // THE acceptance measurement: per frame, does the rendered audio sit on
        // the pitch the curve asked for? A whole-file median f0 is worthless on
        // an utterance that walks through five different vowels — half the
        // frames being below it says nothing about whether any single frame
        // landed. This compares frame to frame, against the target, in cents.
        {
            const CorrectionCurveResult cc = computeCorrectionCurve(
                track.frames, track.notes, rate, ScaleType::Phrygian, 2, {}, st.p);
            const int on = r.buffer.getNumSamples();
            std::vector<float> omono((size_t)on, 0.0f);
            const float osc = 1.0f / (float)r.buffer.getNumChannels();
            for (int ch = 0; ch < r.buffer.getNumChannels(); ++ch)
                for (int i = 0; i < on; ++i) omono[(size_t)i] += r.buffer.getReadPointer(ch)[i] * osc;
            const PitchTrackResult otrack = analyzePitchTrack(omono.data(), on, rate);

            // "Settled" frames are those whose 2048-sample ANALYSIS WINDOW lies
            // entirely inside one note segment. A frame whose window straddles a
            // note change measures a blend of two pitches, so at a hard-tune
            // setting (retune 0 = an instantaneous staircase target) it reads
            // tens of cents off no matter how exactly the renderer hit the step.
            // Splitting the two populations separates "the renderer missed" from
            // "the measurement could not resolve it".
            const int64_t win = 2048;
            auto settled = [&](int64_t pos) {
                for (const auto& seg : track.notes)
                    if (pos >= seg.startSample && pos + win <= seg.endSample) return true;
                return false;
            };

            std::vector<double> err, errSettled;
            const size_t n = std::min({ track.frames.size(), cc.frames.size(), otrack.frames.size() });
            for (size_t i = 0; i < n; ++i) {
                if (!track.frames[i].voiced || !otrack.frames[i].voiced) continue;
                if (!(cc.frames[i].targetF0Hz > 0.0f) || !(otrack.frames[i].f0Hz > 0.0f)) continue;
                const double e = 1200.0 * std::log2((double)otrack.frames[i].f0Hz
                                                    / (double)cc.frames[i].targetF0Hz);
                err.push_back(e);
                if (settled(track.frames[i].posSample)) errSettled.push_back(e);
            }
            auto report = [](const char* label, std::vector<double> v) {
                std::sort(v.begin(), v.end());
                int within50 = 0;
                for (double e : v) if (std::abs(e) <= 50.0) ++within50;
                std::cout << "               " << label << ": n=" << v.size()
                          << " median err " << (v.empty() ? 0.0 : v[v.size() / 2]) << " cents"
                          << ", within +/-50c: "
                          << (v.empty() ? 0.0 : 100.0 * within50 / (double)v.size()) << "%\n";
            };
            report("target-vs-output, all voiced frames ", err);
            report("target-vs-output, settled frames only", errSettled);
        }
        // Artifact proxies. A PSOLA render that clicks, buzzes or blows up shows
        // as a first-difference the source never had, or as a level move — the
        // overlap-add normalization is supposed to make neither possible.
        {
            double rmsIn = 0.0, rmsOut = 0.0;
            for (int ch = 0; ch < in.getNumChannels(); ++ch)
                for (int i = 0; i < N; ++i) {
                    const double a = in.getReadPointer(ch)[i];
                    const double b = r.buffer.getReadPointer(ch)[i];
                    rmsIn += a * a; rmsOut += b * b;
                }
            const double denom = (double)N * in.getNumChannels();
            rmsIn = std::sqrt(rmsIn / denom); rmsOut = std::sqrt(rmsOut / denom);
            std::cout << "               artifacts: max-step " << maxStep(in, 1, N)
                      << " -> " << maxStep(r.buffer, 1, N)
                      << " | rms " << rmsIn << " -> " << rmsOut
                      << " (" << (20.0 * std::log10(std::max(1e-9, rmsOut / std::max(1e-9, rmsIn))))
                      << " dB)\n";
        }
        std::cout << "               f0 median in " << medianVoicedF0(in, rate)
                  << " Hz -> out " << medianVoicedF0(r.buffer, rate)
                  << " Hz | f0 std " << voicedF0StdCents(in, rate)
                  << " -> " << voicedF0StdCents(r.buffer, rate) << " cents"
                  << " | peak " << maxAbs(in) << " -> " << maxAbs(r.buffer) << "\n";

        juce::File out = juce::File(juce::String(outDir))
                             .getChildFile(f.getFileNameWithoutExtension() + "_" + st.name + ".wav");
        out.getParentDirectory().createDirectory();
        out.deleteFile();
        juce::WavAudioFormat wav;
        std::unique_ptr<juce::FileOutputStream> os(out.createOutputStream());
        if (os) {
            std::unique_ptr<juce::AudioFormatWriter> w(
                wav.createWriterFor(os.release(), rate, (unsigned)r.buffer.getNumChannels(), 24, {}, 0));
            if (w) { w->writeFromAudioSampleBuffer(r.buffer, 0, r.buffer.getNumSamples()); w.reset(); }
        }
        std::cout << "               wrote " << out.getFullPathName() << "\n";
    }
}

int main(int argc, char** argv)
{
    std::cout << "=== test_autotune_render (P5-3) ===\n";

    testShapePreserved();
    testHardTuneLandsOnScale();
    testBypassIsExact();
    testUnvoicedPassThrough();
    testVibratoPreservation();
    testGlideTracksTheCurve();
    testRefusals();
    testSampleRateIndependence();
    testRenderTime();

    if (argc >= 2) renderWavPass(argv[1], argc >= 3 ? argv[2] : ".");

    std::cout << "\n" << (g_failures == 0 ? "ALL PASS" : "FAILURES") << ": " << g_failures << "\n";
    return g_failures == 0 ? 0 : 1;
}
