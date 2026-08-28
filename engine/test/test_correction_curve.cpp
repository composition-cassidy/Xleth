// test_correction_curve.cpp — Self-verification for the AUTOTUNE correction
// curve (P5-2): scale/key tables, quantization, the jumpiness-hold /
// retune-speed / smoothness state machine, and the Preserve Vibrato
// low-pass split. Pure math — no JUCE, no FFmpeg, no GL.
// Build: see engine/CMakeLists.txt target "test_correction_curve"
// Run:   test_correction_curve.exe [vibrato-csv-out-path]
//        Passing a path writes the vibrato-preservation example (input f0 vs
//        target f0, one row per frame per preserveVibrato setting) as CSV so
//        it can be plotted; omit it to just run the assertions.
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1

#include "dsp/CorrectionCurve.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <functional>
#include <iostream>
#include <vector>

using namespace xleth::dsp;

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                        \
    do {                                                                        \
        if (cond) { ++g_passed; }                                               \
        else { std::cerr << "  FAIL [line " << __LINE__ << "] " << msg << "\n"; \
               ++g_failed; }                                                    \
    } while (0)

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kSampleRate = 48000.0;
constexpr double kHopMs      = 5.0;
constexpr int64_t kHopSamples = (int64_t)(kSampleRate * kHopMs / 1000.0);

double centsOf(double hz) { return 1200.0 * std::log2(hz); }
double hzOf(double midi)  { return 440.0 * std::exp2((midi - 69.0) / 12.0); }

// One continuous voiced note: numFrames frames at the standard hop, f0Hz(i)
// given by `f0At(i)`, all belonging to a single NoteSegment whose
// medianF0Hz is `segMedianHz`.
struct SyntheticNote {
    std::vector<PitchFrame>  frames;
    std::vector<NoteSegment> segments;
};

SyntheticNote makeSingleNote(int numFrames, double segMedianHz,
                              const std::function<double(int)>& f0At)
{
    SyntheticNote s;
    s.frames.reserve((size_t)numFrames);
    for (int i = 0; i < numFrames; ++i) {
        PitchFrame f;
        f.posSample  = (int64_t)i * kHopSamples;
        f.f0Hz       = (float)f0At(i);
        f.confidence = 1.0f;
        f.voiced     = true;
        s.frames.push_back(f);
    }
    NoteSegment seg;
    seg.startSample = 0;
    seg.endSample   = (int64_t)numFrames * kHopSamples;
    seg.medianF0Hz  = segMedianHz;
    s.segments.push_back(seg);
    return s;
}

// Frame `i` belongs to segment `i / framesPerSeg` (alternating between the
// two target Hz values); every segment is exactly framesPerSeg frames long.
SyntheticNote makeAlternating(int numSegments, int framesPerSeg,
                                double hzA, double hzB)
{
    SyntheticNote s;
    s.frames.reserve((size_t)(numSegments * framesPerSeg));
    s.segments.reserve((size_t)numSegments);
    for (int seg = 0; seg < numSegments; ++seg) {
        const double hz = (seg % 2 == 0) ? hzA : hzB;
        const int64_t segStart = (int64_t)seg * framesPerSeg * kHopSamples;
        for (int j = 0; j < framesPerSeg; ++j) {
            PitchFrame f;
            f.posSample  = segStart + (int64_t)j * kHopSamples;
            f.f0Hz       = (float)hz;
            f.confidence = 1.0f;
            f.voiced     = true;
            s.frames.push_back(f);
        }
        NoteSegment ns;
        ns.startSample = segStart;
        ns.endSample   = segStart + (int64_t)framesPerSeg * kHopSamples;
        ns.medianF0Hz  = hz;
        s.segments.push_back(ns);
    }
    return s;
}

int countTransitions(const CorrectionCurveResult& r)
{
    int n = 0;
    for (size_t i = 1; i < r.frames.size(); ++i)
        if (std::fabs(r.frames[i].targetF0Hz - r.frames[i - 1].targetF0Hz) > 1e-3f)
            ++n;
    return n;
}

} // namespace

int main(int argc, char** argv)
{
    // ── Scale tables ──────────────────────────────────────────────────────
    {
        // Default: D Phrygian == D, Eb, F, G, A, Bb, C.
        auto pcs = allowedPitchClasses(kDefaultKey, kDefaultScale);
        std::vector<int> expected = { 0, 2, 3, 5, 7, 9, 10 }; // C, D, Eb, F, G, A, Bb (sorted)
        CHECK(pcs == expected, "default D Phrygian == {C,D,Eb,F,G,A,Bb} pitch classes");
    }
    {
        // C Ionian == the white keys.
        auto pcs = allowedPitchClasses(0, ScaleType::Ionian);
        std::vector<int> expected = { 0, 2, 4, 5, 7, 9, 11 };
        CHECK(pcs == expected, "C Ionian == white keys");
    }
    {
        auto pcs = allowedPitchClasses(0, ScaleType::MajorPentatonic);
        CHECK(pcs.size() == 5, "major pentatonic has 5 notes");
    }
    {
        auto pcs = allowedPitchClasses(0, ScaleType::MinorPentatonic);
        CHECK(pcs.size() == 5, "minor pentatonic has 5 notes");
    }
    for (int s = 0; s <= (int)ScaleType::MinorPentatonic; ++s) {
        auto pcs = allowedPitchClasses(3, (ScaleType)s);
        CHECK(!pcs.empty(), "every scale produces a non-empty pitch-class set");
        for (int pc : pcs) CHECK(pc >= 0 && pc <= 11, "pitch classes stay in [0,11]");
    }

    // ── quantizeToNearestNote: constant f0 between two scale notes snaps to
    // the nearer one ──────────────────────────────────────────────────────
    {
        const std::vector<int> cMajor = allowedPitchClasses(0, ScaleType::Ionian);
        // D4 (293.665 Hz, midi 62) and E4 (329.628 Hz, midi 64) are both in
        // C major. 310 Hz sits closer to D4 in cents (~92 cents above D4 vs
        // ~108 below E4).
        const double q = quantizeToNearestNote(310.0, cMajor);
        CHECK(std::fabs(q - hzOf(62.0)) < 0.5, "310 Hz (closer to D4) snaps to D4");

        // 320 Hz sits closer to E4.
        const double q2 = quantizeToNearestNote(320.0, cMajor);
        CHECK(std::fabs(q2 - hzOf(64.0)) < 0.5, "320 Hz (closer to E4) snaps to E4");

        // Exactly the midpoint in cents rounds to one side deterministically
        // (round-half-away-from-zero via std::round) without oscillating.
        const double midCents = (centsOf(hzOf(62.0)) + centsOf(hzOf(64.0))) / 2.0;
        const double midHz = std::exp2(midCents / 1200.0);
        const double qm1 = quantizeToNearestNote(midHz, cMajor);
        const double qm2 = quantizeToNearestNote(midHz, cMajor);
        CHECK(qm1 == qm2, "quantization at an exact midpoint is deterministic");
    }

    // ── computeCorrectionCurve: a segment's target snaps to the nearest
    // in-scale note (full pipeline, instant snap to isolate quantization) ──
    {
        const std::vector<int> cMajor = allowedPitchClasses(0, ScaleType::Ionian);
        auto note = makeSingleNote(20, 310.0, [](int) { return 310.0; });

        CorrectionParams p;
        p.correctionAmount = 100.0;
        p.retuneSpeedMs     = 0.0;   // instant snap
        p.smoothnessMs      = 0.0;
        p.jumpiness         = 0.0;
        p.preserveVibrato   = 0.0;   // no vibrato split confound

        auto r = computeCorrectionCurve(note.frames, note.segments, kSampleRate,
                                         ScaleType::Ionian, 0, cMajor, p);
        CHECK(r.frames.size() == note.frames.size(), "one output frame per input frame");
        CHECK(std::fabs(r.frames.back().targetF0Hz - hzOf(62.0)) < 0.5,
              "constant 310 Hz input snaps to D4 through the full pipeline");
    }

    // ── Unvoiced frames pass through unchanged ──────────────────────────────
    {
        std::vector<PitchFrame> frames(3);
        frames[0].voiced = false; frames[0].f0Hz = 0.0f; frames[0].posSample = 0;
        frames[1].voiced = false; frames[1].f0Hz = 123.0f; frames[1].posSample = kHopSamples; // voiced flag governs, not f0Hz
        frames[2].voiced = false; frames[2].f0Hz = 0.0f; frames[2].posSample = 2 * kHopSamples;
        std::vector<NoteSegment> segs; // no segments at all

        CorrectionParams p;
        auto r = computeCorrectionCurve(frames, segs, kSampleRate, ScaleType::Ionian, 0, {}, p);
        CHECK(r.frames.size() == 3, "unvoiced-only track still returns one frame per input frame");
        for (size_t i = 0; i < r.frames.size(); ++i) {
            CHECK(r.frames[i].targetF0Hz == frames[i].f0Hz, "unvoiced frame target == input f0Hz unchanged");
            CHECK(r.frames[i].correctionCents == 0.0f, "unvoiced frame reports zero correction");
        }
    }

    // ── Correction Amount 0% == bypass, even for an off-scale voiced note ──
    {
        auto note = makeSingleNote(10, 310.0, [](int) { return 310.0; });
        CorrectionParams p;
        p.correctionAmount = 0.0;
        p.retuneSpeedMs = 0.0;
        auto r = computeCorrectionCurve(note.frames, note.segments, kSampleRate,
                                         ScaleType::Ionian, 0, {}, p);
        for (size_t i = 0; i < r.frames.size(); ++i) {
            CHECK(std::fabs(r.frames[i].targetF0Hz - 310.0f) < 1e-2f,
                  "amount == 0 bypasses correction: target == input");
            CHECK(std::fabs(r.frames[i].correctionCents) < 1e-2f,
                  "amount == 0 reports ~zero correction cents");
        }
    }

    // ── Custom allowedNotes overrides the scale/key preset ──────────────────
    {
        // C major preset would snap 310 Hz to D4; a custom single-note
        // allowed set of {C#} must override the preset and snap to C#
        // instead, regardless of what scale/key were also passed in.
        auto note = makeSingleNote(10, 310.0, [](int) { return 310.0; });
        CorrectionParams p;
        p.correctionAmount = 100.0;
        p.retuneSpeedMs = 0.0;
        p.preserveVibrato = 0.0;
        auto r = computeCorrectionCurve(note.frames, note.segments, kSampleRate,
                                         ScaleType::Ionian, 0, /*allowedNotes=*/{ 1 }, p);
        // Nearest C# (pitch class 1) to 310 Hz: C#4 = midi 61.
        CHECK(std::fabs(r.frames.back().targetF0Hz - hzOf(61.0)) < 0.5,
              "custom allowedNotes={C#} overrides the C-major preset");
    }

    // ── Gliding f0 within one note: the approach matches the retune-speed
    // time constant (a clean one-pole toward the committed target) ─────────
    {
        const double targetHz = hzOf(69.0);   // A4, exactly the committed target
        const double startHz  = hzOf(68.0);   // one semitone flat at onset
        auto note = makeSingleNote(60, targetHz, [&](int) { return startHz; });

        CorrectionParams p;
        p.correctionAmount = 100.0;
        p.retuneSpeedMs     = 50.0;  // 10 frames at the 5ms hop
        p.smoothnessMs      = 0.0;   // irrelevant: no note switch occurs
        p.jumpiness         = 0.0;
        p.preserveVibrato   = 0.0;   // isolate the retune-speed approach

        auto r = computeCorrectionCurve(note.frames, note.segments, kSampleRate,
                                         ScaleType::Ionian, 9 /* A */, {}, p);

        const double startCents  = centsOf(startHz);
        const double targetCents = centsOf(targetHz);
        // Frame 10 lands exactly at t == retuneSpeedMs == one time constant:
        // a discrete one-pole recurrence with alpha = 1-exp(-dt/tau) applied
        // every step reproduces continuous exponential decay exactly at
        // multiples of dt, so the fraction moved should be 1 - e^-1 (~63.2%).
        const double frame10Cents = centsOf(r.frames[10].targetF0Hz);
        const double fracMoved = (frame10Cents - startCents) / (targetCents - startCents);
        CHECK(std::fabs(fracMoved - (1.0 - std::exp(-1.0))) < 1e-3,
              "after one retune-speed time constant, ~63.2% of the way to target");

        // Monotonic approach, never overshoots. Tolerance is float32-storage
        // roundoff (targetF0Hz is a float), not a precision requirement: at
        // ~6900 cents magnitude a float32 round-trip through Hz and back
        // through log2 can move the last bit by ~1e-3 cents.
        double prev = startCents;
        for (const auto& f : r.frames) {
            const double c = centsOf(f.targetF0Hz);
            CHECK(c >= prev - 1e-3 && c <= targetCents + 1e-3, "retune-speed approach is monotonic and never overshoots");
            prev = c;
        }
        // Long after several time constants, essentially at the target.
        CHECK(std::fabs(centsOf(r.frames.back().targetF0Hz) - targetCents) < 1.0,
              "retune-speed approach converges to the target after enough time");
    }

    // ── Jumpiness hold: two notes alternating every hop (5 ms) — the
    // frame-by-frame "T-Pain flutter" scenario the hold exists to prevent.
    // jumpiness 10% (10 ms hold) vs 0% (free jump). retune/smoothness are
    // forced to 0 so the output snaps instantly to whatever note is
    // committed, making commit switches directly countable in the output. ──
    {
        const double hzA = hzOf(60.0); // C4
        const double hzB = hzOf(62.0); // D4
        auto alt = makeAlternating(/*numSegments=*/20, /*framesPerSeg=*/1, hzA, hzB);

        CorrectionParams p;
        p.correctionAmount = 100.0;
        p.retuneSpeedMs = 0.0;
        p.smoothnessMs  = 0.0;
        p.preserveVibrato = 0.0;

        p.jumpiness = 0.0;
        auto rNoHold = computeCorrectionCurve(alt.frames, alt.segments, kSampleRate,
                                               ScaleType::Ionian, 0, {}, p);
        p.jumpiness = 10.0; // 10 ms hold
        auto rHold = computeCorrectionCurve(alt.frames, alt.segments, kSampleRate,
                                             ScaleType::Ionian, 0, {}, p);

        const int transitionsNoHold = countTransitions(rNoHold);
        const int transitionsHold   = countTransitions(rHold);
        CHECK(transitionsNoHold == 19, "no hold: every 5ms alternation is a target switch (19 of 20)");
        CHECK(transitionsHold < transitionsNoHold,
              "10ms hold suppresses some of the 5ms-cadence switches");
        CHECK(transitionsHold <= transitionsNoHold / 2,
              "10ms hold cuts flutter substantially (>=50% fewer switches) vs no hold");
    }

    // ── Jumpiness hold, fully saturating: a hold longer than the whole
    // phrase locks onto the first note and never switches again. ───────────
    {
        const double hzA = hzOf(60.0);
        const double hzB = hzOf(62.0);
        auto alt = makeAlternating(/*numSegments=*/8, /*framesPerSeg=*/1, hzA, hzB); // 40 ms total

        CorrectionParams p;
        p.correctionAmount = 100.0;
        p.retuneSpeedMs = 0.0;
        p.smoothnessMs  = 0.0;
        p.preserveVibrato = 0.0;
        p.jumpiness = 100.0; // 100 ms hold >> 40 ms phrase

        auto r = computeCorrectionCurve(alt.frames, alt.segments, kSampleRate,
                                         ScaleType::Ionian, 0, {}, p);
        CHECK(countTransitions(r) == 0, "hold >> phrase length: fully locked, zero switches after onset");
        for (const auto& f : r.frames)
            CHECK(std::fabs(f.targetF0Hz - (float)hzA) < 1e-2f, "locked onto the onset note (C4) throughout");
    }

    // ── Preserve Vibrato: synthetic 6 Hz vibrato on a note held exactly at
    // its (in-tune) target. 100% preserves most of the depth; 0% flattens
    // it to (essentially) nothing after center correction. ─────────────────
    CorrectionCurveResult vib100, vib0, vib50;
    std::vector<PitchFrame> vibFrames;
    {
        const double targetHz  = hzOf(69.0); // A4
        const double vibHz     = 6.0;
        const double vibDepthCents = 40.0;   // +/-40 cents peak vibrato
        const int    numFrames = 100;        // 500 ms == 3 full 6 Hz cycles

        auto note = makeSingleNote(numFrames, targetHz, [&](int i) {
            const double tSec = (double)i * kHopMs / 1000.0;
            const double devCents = vibDepthCents * std::sin(2.0 * kPi * vibHz * tSec);
            return targetHz * std::exp2(devCents / 1200.0);
        });
        vibFrames = note.frames;

        CorrectionParams p;
        p.correctionAmount = 100.0;
        p.retuneSpeedMs = 5.0;   // fast center-lock relative to the 167ms vibrato period
        p.smoothnessMs  = 0.0;
        p.jumpiness     = 0.0;

        p.preserveVibrato = 100.0;
        vib100 = computeCorrectionCurve(note.frames, note.segments, kSampleRate, ScaleType::Ionian, 9, {}, p);
        p.preserveVibrato = 0.0;
        vib0 = computeCorrectionCurve(note.frames, note.segments, kSampleRate, ScaleType::Ionian, 9, {}, p);
        p.preserveVibrato = 50.0;
        vib50 = computeCorrectionCurve(note.frames, note.segments, kSampleRate, ScaleType::Ionian, 9, {}, p);

        // Measure peak-to-peak wobble (in cents) over the settled tail
        // (skip the first 100ms retune-speed transient).
        auto ptpCentsTail = [&](const CorrectionCurveResult& r) {
            double lo = 1e18, hi = -1e18;
            for (size_t i = 20; i < r.frames.size(); ++i) {
                const double c = centsOf(r.frames[i].targetF0Hz);
                lo = std::min(lo, c);
                hi = std::max(hi, c);
            }
            return hi - lo;
        };
        double inputLo = 1e18, inputHi = -1e18;
        for (size_t i = 20; i < note.frames.size(); ++i) {
            const double c = centsOf(note.frames[i].f0Hz);
            inputLo = std::min(inputLo, c);
            inputHi = std::max(inputHi, c);
        }
        const double inputPtp = inputHi - inputLo;

        const double ptp100 = ptpCentsTail(vib100);
        const double ptp0   = ptpCentsTail(vib0);
        const double ptp50  = ptpCentsTail(vib50);

        std::cerr << "  [vibrato] input ptp=" << inputPtp << "c  0%=" << ptp0
                   << "c  50%=" << ptp50 << "c  100%=" << ptp100 << "c\n";

        CHECK(ptp0 < 2.0, "preserveVibrato=0%: vibrato flattened to near-zero after center correction");
        CHECK(ptp100 > ptp0 * 5.0, "preserveVibrato=100%: retains substantially more depth than 0%");
        CHECK(ptp100 > inputPtp * 0.3, "preserveVibrato=100%: retains a meaningful fraction of the original depth");
        CHECK(ptp50 > ptp0 && ptp50 < ptp100, "preserveVibrato=50%: depth falls strictly between the 0% and 100% cases");

        // Center correction still happens at 100%: the mean pitch across the
        // tail should sit close to the target note, not the (in-tune) input's
        // own mean (which is also ~target here, so this mainly checks the
        // curve doesn't drift away from target while preserving vibrato).
        double sum = 0.0;
        for (size_t i = 20; i < vib100.frames.size(); ++i) sum += centsOf(vib100.frames[i].targetF0Hz);
        const double mean100 = sum / (double)(vib100.frames.size() - 20);
        CHECK(std::fabs(mean100 - centsOf(targetHz)) < 5.0, "preserveVibrato=100% still centers on the target note");
    }

    // ── Optional: dump the vibrato example as CSV for plotting ─────────────
    if (argc > 1) {
        FILE* f = std::fopen(argv[1], "w");
        if (f) {
            std::fprintf(f, "frame,t_ms,input_hz,target_hz_preserve100,target_hz_preserve0,target_hz_preserve50\n");
            for (size_t i = 0; i < vibFrames.size(); ++i) {
                std::fprintf(f, "%zu,%.3f,%.5f,%.5f,%.5f,%.5f\n",
                             i, (double)i * kHopMs,
                             (double)vibFrames[i].f0Hz,
                             (double)vib100.frames[i].targetF0Hz,
                             (double)vib0.frames[i].targetF0Hz,
                             (double)vib50.frames[i].targetF0Hz);
            }
            std::fclose(f);
            std::cerr << "  wrote vibrato example CSV to " << argv[1] << "\n";
        } else {
            std::cerr << "  FAILED to open '" << argv[1] << "' for the CSV dump\n";
        }
    }

    std::cerr << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0) { std::cerr << "FAILED\n"; return 1; }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
