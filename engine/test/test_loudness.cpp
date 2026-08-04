// test_loudness.cpp — Compliance tests for dsp/LoudnessAnalyzer (ITU-R BS.1770-4
// integrated/momentary/short-term LUFS, EBU Tech 3342 loudness range, true peak).
// Build: see engine/CMakeLists.txt target "test_loudness"
// Run:   test_loudness.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: ..." and exits 1
//
// These are spec vectors, not captured baselines. Three kinds of check:
//   • The 48 kHz K-weighting biquads must equal the table printed in BS.1770-4.
//     That pins the bilinear-transform derivation itself, which is the only
//     reason the 44.1 kHz path can be trusted — there is no published table to
//     compare it against.
//   • The EBU Tech 3341 test signals (§2.1 cases 1-5) drive the calibration and
//     both gating stages, at 44100 AND 48000.
//   • The EBU Tech 3342 test signals (§3 cases 1-4) drive loudness range.
// Everything else (true peak, streaming/offline equivalence, degenerate input)
// asserts a closed-form answer.
//
// Convention note: for a sine, "dBFS" here is peak-referenced, as in the EBU
// test-signal tables — a full-scale sine is 0 dBFS. Under BS.1770-4 a stereo
// 1 kHz sine present in BOTH channels reads its peak dBFS back as LUFS exactly,
// because the K-weighting's +0.691 dB gain at 1 kHz cancels the -0.691 offset.
// The same sine in ONE channel of a stereo pair reads 3.01 LU lower.

#include "dsp/LoudnessAnalyzer.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <memory>
#include <vector>

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                 \
    do {                                                                 \
        if (cond) { ++g_passed; }                                        \
        else { std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; ++g_failed; } \
    } while (0)

using xleth::dsp::LoudnessAnalyzer;

static constexpr double kSR44 = 44100.0;
static constexpr double kSR48 = 48000.0;

// Sentinel meaning "digital silence" in a Seg, distinct from any real level.
static constexpr double kSilenceDbfs = -1000.0;

struct Seg
{
    double seconds;
    double peakDbfs;   // peak amplitude of the sine, or kSilenceDbfs
};

// Which channels of the stereo pair carry the tone.
enum class Fill { Both, LeftOnly };

// Builds a stereo buffer of concatenated constant-level 1 kHz sine segments.
// Phase runs continuously across segment boundaries: a phase discontinuity is a
// click, and a click is broadband energy that would quietly contaminate the
// gating vectors.
static juce::AudioBuffer<float> makeSegments(const std::vector<Seg>& segs,
                                             double sampleRate,
                                             Fill fill = Fill::Both,
                                             double freqHz = 1000.0)
{
    int total = 0;
    for (const auto& s : segs)
        total += static_cast<int>(std::llround(s.seconds * sampleRate));

    juce::AudioBuffer<float> buf(2, total);
    buf.clear();

    const double w = 2.0 * juce::MathConstants<double>::pi * freqHz / sampleRate;
    double phase = 0.0;
    int    pos   = 0;

    for (const auto& s : segs)
    {
        const int n = static_cast<int>(std::llround(s.seconds * sampleRate));
        const double amp = (s.peakDbfs <= kSilenceDbfs + 1.0)
                             ? 0.0
                             : std::pow(10.0, s.peakDbfs / 20.0);

        for (int i = 0; i < n; ++i)
        {
            const auto v = static_cast<float>(amp * std::sin(phase));
            buf.setSample(0, pos + i, v);
            if (fill == Fill::Both) buf.setSample(1, pos + i, v);
            phase += w;
        }
        pos += n;
    }
    return buf;
}

// Raised-cosine fade at both ends of a buffer.
//
// Needed by every true-peak fixture. A test signal that starts at full level on
// sample 0 is a step into the interpolator's delay line, and a windowed sinc
// rings on a step: the sum of |taps| in the half-sample phase is about 1.9, so
// an un-faded fixture can measure +5 dB of overshoot that belongs to the buffer
// edge rather than to the signal. The fade is slow enough (tens of Hz of
// bandwidth) that it contributes no overshoot of its own, and the plateau in the
// middle is what every assertion here is actually about.
static void applyEdgeFade(juce::AudioBuffer<float>& buf, int fadeSamples = 1024)
{
    const int n = buf.getNumSamples();
    const int f = std::min(fadeSamples, n / 2);
    if (f <= 0) return;

    for (int i = 0; i < f; ++i)
    {
        const auto g = static_cast<float>(
            0.5 * (1.0 - std::cos(juce::MathConstants<double>::pi * i / f)));
        for (int c = 0; c < buf.getNumChannels(); ++c)
        {
            buf.setSample(c, i,         buf.getSample(c, i) * g);
            buf.setSample(c, n - 1 - i, buf.getSample(c, n - 1 - i) * g);
        }
    }
}

static void report(const char* label, const LoudnessAnalyzer::Results& r)
{
    std::cout << "    " << std::left << std::setw(34) << label << std::right
              << " I=" << std::fixed << std::setprecision(3) << std::setw(8) << r.integrated
              << "  M=" << std::setw(8) << r.momentaryMax
              << "  S=" << std::setw(8) << r.shortTermMax
              << "  LRA=" << std::setw(6) << r.lra
              << "  TP=" << std::setw(7) << r.truePeakDbtp << "\n";
}

// ── K-weighting coefficients ─────────────────────────────────────────────────
// BS.1770-4 §1.1 prints these for 48 kHz only. Reproducing them from the analog
// prototype is what proves the derivation, and therefore what makes the 44.1 kHz
// coefficients trustworthy.
static void testKWeightingCoefficients()
{
    std::cout << "K-weighting coefficients\n";

    const auto shelf = LoudnessAnalyzer::makeShelfCoeffs(kSR48);
    const double tol = 1.0e-9;

    CHECK(std::abs(shelf.b0 - 1.53512485958697) < tol, "shelf b0, got " << shelf.b0);
    CHECK(std::abs(shelf.b1 + 2.69169618940638) < tol, "shelf b1, got " << shelf.b1);
    CHECK(std::abs(shelf.b2 - 1.19839281085285) < tol, "shelf b2, got " << shelf.b2);
    CHECK(std::abs(shelf.a1 + 1.69065929318241) < tol, "shelf a1, got " << shelf.a1);
    CHECK(std::abs(shelf.a2 - 0.73248077421585) < tol, "shelf a2, got " << shelf.a2);

    const auto hp = LoudnessAnalyzer::makeHighPassCoeffs(kSR48);
    CHECK(std::abs(hp.b0 - 1.0) < tol, "RLB b0, got " << hp.b0);
    CHECK(std::abs(hp.b1 + 2.0) < tol, "RLB b1, got " << hp.b1);
    CHECK(std::abs(hp.b2 - 1.0) < tol, "RLB b2, got " << hp.b2);
    CHECK(std::abs(hp.a1 + 1.99004745483398) < tol, "RLB a1, got " << hp.a1);
    CHECK(std::abs(hp.a2 - 0.99007225036621) < tol, "RLB a2, got " << hp.a2);

    // The whole point of deriving rather than hardcoding: 44.1 kHz must NOT be
    // the 48 kHz filter. If someone reintroduces a constant table, this fires.
    const auto shelf44 = LoudnessAnalyzer::makeShelfCoeffs(kSR44);
    const auto hp44    = LoudnessAnalyzer::makeHighPassCoeffs(kSR44);
    CHECK(std::abs(shelf44.a1 - shelf.a1) > 1.0e-3,
          "44.1 kHz shelf must differ from the 48 kHz table, got a1=" << shelf44.a1);
    CHECK(std::abs(hp44.a1 - hp.a1) > 1.0e-4,
          "44.1 kHz RLB must differ from the 48 kHz table, got a1=" << hp44.a1);

    // Both stages must stay stable at either rate: poles inside the unit circle
    // means |a2| < 1 and |a1| < 1 + a2.
    for (const auto& c : { shelf, hp, shelf44, hp44 })
    {
        CHECK(std::abs(c.a2) < 1.0, "pole outside unit circle: a2=" << c.a2);
        CHECK(std::abs(c.a1) < 1.0 + c.a2, "pole outside unit circle: a1=" << c.a1);
    }
}

// ── EBU Tech 3341 §2.1 cases 1 and 2 — calibration ───────────────────────────
static void testCalibration(double sr)
{
    std::cout << "EBU 3341 calibration @ " << sr << " Hz\n";

    // Case 1: stereo 1 kHz sine, -23.0 dBFS, 20 s → M = S = I = -23.0 LUFS.
    {
        const auto buf = makeSegments({{20.0, -23.0}}, sr);
        const auto r   = LoudnessAnalyzer::analyze(buf, sr);
        report("3341-1  stereo -23 dBFS", r);

        CHECK(std::abs(r.integrated   + 23.0) < 0.1, "I should be -23.0, got " << r.integrated);
        CHECK(std::abs(r.momentaryMax + 23.0) < 0.1, "M should be -23.0, got " << r.momentaryMax);
        CHECK(std::abs(r.shortTermMax + 23.0) < 0.1, "S should be -23.0, got " << r.shortTermMax);
    }

    // Case 2: same at -33.0 dBFS. Proves the scale is linear in dB rather than
    // the -23 result being a lucky constant.
    {
        const auto buf = makeSegments({{20.0, -33.0}}, sr);
        const auto r   = LoudnessAnalyzer::analyze(buf, sr);
        report("3341-2  stereo -33 dBFS", r);
        CHECK(std::abs(r.integrated + 33.0) < 0.1, "I should be -33.0, got " << r.integrated);
    }

    // Channel summation with G = 1.0 each: the SAME tone at -20 dBFS in one
    // channel only must land 3.01 LU below the both-channels case, i.e. at
    // -23.01 LUFS. This is the other reading of "a -20 dBFS sine measures -23",
    // and it is the check that would catch a stray averaging-instead-of-summing
    // over channels.
    {
        const auto buf = makeSegments({{20.0, -20.0}}, sr, Fill::LeftOnly);
        const auto r   = LoudnessAnalyzer::analyze(buf, sr);
        report("        -20 dBFS, left only", r);
        CHECK(std::abs(r.integrated + 23.01) < 0.1,
              "single-channel -20 dBFS should be -23.01, got " << r.integrated);
    }
}

// ── EBU Tech 3341 §2.1 cases 3, 4, 5 — gating ────────────────────────────────
static void testEbuGatingVectors(double sr)
{
    std::cout << "EBU 3341 gating vectors @ " << sr << " Hz\n";

    // Case 3: -36 / -23 / -36 dBFS for 10 / 60 / 10 s → I = -23.0.
    // The -36 blocks sit below the relative gate and must drop out.
    {
        const auto buf = makeSegments({{10.0, -36.0}, {60.0, -23.0}, {10.0, -36.0}}, sr);
        const auto r   = LoudnessAnalyzer::analyze(buf, sr);
        report("3341-3  -36/-23/-36", r);
        CHECK(std::abs(r.integrated + 23.0) < 0.1, "I should be -23.0, got " << r.integrated);
    }

    // Case 4: adds -72 dBFS shoulders, which the ABSOLUTE gate must drop before
    // they can drag the relative gate down.
    {
        const auto buf = makeSegments({{10.0, -72.0}, {10.0, -36.0}, {60.0, -23.0},
                                       {10.0, -36.0}, {10.0, -72.0}}, sr);
        const auto r   = LoudnessAnalyzer::analyze(buf, sr);
        report("3341-4  -72/-36/-23/-36/-72", r);
        CHECK(std::abs(r.integrated + 23.0) < 0.1, "I should be -23.0, got " << r.integrated);
    }

    // Case 5: -26 / -20 / -26 for 20 / 20.1 / 20 s → I = -23.0. Nothing is
    // gated here; this one tests that the surviving blocks are averaged by
    // ENERGY and not by their dB values (a dB mean would give -24.0).
    {
        const auto buf = makeSegments({{20.0, -26.0}, {20.1, -20.0}, {20.0, -26.0}}, sr);
        const auto r   = LoudnessAnalyzer::analyze(buf, sr);
        report("3341-5  -26/-20/-26", r);
        CHECK(std::abs(r.integrated + 23.0) < 0.1, "I should be -23.0, got " << r.integrated);
    }
}

// ── Gating, isolated ─────────────────────────────────────────────────────────
static void testGatingIsolated(double sr)
{
    std::cout << "gate isolation @ " << sr << " Hz\n";

    const auto loudOnly = LoudnessAnalyzer::analyze(makeSegments({{30.0, -23.0}}, sr), sr);

    // Absolute gate: 30 s of -80 dBFS appended must leave the integrated value
    // alone. Without the gate the tail would drag it to about -29.8 LUFS, so
    // the 0.05 LU bound is nowhere near accidentally satisfiable. The residual
    // is the three 400 ms blocks that straddle the level change, which is a
    // windowing effect and not a gating one.
    {
        const auto r = LoudnessAnalyzer::analyze(
            makeSegments({{30.0, -23.0}, {30.0, -80.0}}, sr), sr);
        report("absolute gate  -23 + -80 tail", r);
        CHECK(std::abs(r.integrated - loudOnly.integrated) < 0.05,
              "silence tail moved I from " << loudOnly.integrated << " to " << r.integrated);
    }

    // Digital-silence tail: same requirement, and it must not produce NaN.
    {
        const auto r = LoudnessAnalyzer::analyze(
            makeSegments({{30.0, -23.0}, {30.0, kSilenceDbfs}}, sr), sr);
        report("absolute gate  -23 + silence", r);
        CHECK(std::isfinite(r.integrated), "silence tail produced a non-finite I");
        CHECK(std::abs(r.integrated - loudOnly.integrated) < 0.05,
              "silence tail moved I from " << loudOnly.integrated << " to " << r.integrated);
    }

    // Relative gate: a section exactly 20 LU down is well past the -10 LU gate
    // and must be excluded. Ungated it would pull the answer to about -26.0.
    {
        const auto r = LoudnessAnalyzer::analyze(
            makeSegments({{30.0, -23.0}, {30.0, -43.0}}, sr), sr);
        report("relative gate  -23 + -43", r);
        CHECK(std::abs(r.integrated - loudOnly.integrated) < 0.1,
              "-20 LU section was not gated out: I=" << r.integrated
              << " vs loud-only " << loudOnly.integrated);
    }

    // ...but a section only 5 LU down is INSIDE the relative gate and must
    // still count. This is the negative control: without it, a bug that gates
    // everything except the loudest block would pass the two checks above.
    {
        const auto r = LoudnessAnalyzer::analyze(
            makeSegments({{30.0, -23.0}, {30.0, -28.0}}, sr), sr);
        report("relative gate  -23 + -28 (kept)", r);
        // Energy mean of equal durations at -23 and -28 dBFS.
        const double expected = 10.0 * std::log10(
            (std::pow(10.0, -2.3) + std::pow(10.0, -2.8)) / 2.0);
        CHECK(std::abs(r.integrated - expected) < 0.1,
              "-5 LU section should be kept: I=" << r.integrated
              << ", expected " << expected);
    }
}

// ── EBU Tech 3342 §3 cases 1-4 — loudness range ──────────────────────────────
static void testLoudnessRange(double sr)
{
    std::cout << "EBU 3342 loudness range @ " << sr << " Hz\n";

    struct Case { const char* label; std::vector<Seg> segs; double expectedLra; };

    const std::vector<Case> cases = {
        { "3342-1  -20 / -30",         {{20.0, -20.0}, {20.0, -30.0}},                 10.0 },
        { "3342-2  -20 / -15",         {{20.0, -20.0}, {20.0, -15.0}},                  5.0 },
        { "3342-3  -40 / -20",         {{20.0, -40.0}, {20.0, -20.0}},                 20.0 },
        { "3342-4  -50 / -35 / -20",   {{20.0, -50.0}, {20.0, -35.0}, {20.0, -20.0}},  15.0 },
    };

    for (const auto& c : cases)
    {
        const auto r = LoudnessAnalyzer::analyze(makeSegments(c.segs, sr), sr);
        report(c.label, r);
        CHECK(std::abs(r.lra - c.expectedLra) < 1.0,
              c.label << ": LRA should be " << c.expectedLra << " LU, got " << r.lra);
    }

    // A steady tone has no range at all.
    {
        const auto r = LoudnessAnalyzer::analyze(makeSegments({{20.0, -23.0}}, sr), sr);
        CHECK(r.lra < 0.2, "steady tone should have ~0 LRA, got " << r.lra);
    }
}

// ── Momentary / short-term maxima ────────────────────────────────────────────
static void testWindowMaxima(double sr)
{
    std::cout << "momentary / short-term maxima @ " << sr << " Hz\n";

    // A 5 s burst 15 LU above the bed. Both windows fit entirely inside it, so
    // both maxima must reach the burst level; the integrated value must not,
    // since the bed dominates the duration.
    const auto r = LoudnessAnalyzer::analyze(
        makeSegments({{20.0, -30.0}, {5.0, -15.0}, {20.0, -30.0}}, sr), sr);
    report("burst -15 in a -30 bed", r);

    CHECK(std::abs(r.momentaryMax + 15.0) < 0.1,
          "momentary max should reach -15.0, got " << r.momentaryMax);
    CHECK(std::abs(r.shortTermMax + 15.0) < 0.1,
          "short-term max should reach -15.0, got " << r.shortTermMax);
    CHECK(r.integrated < r.momentaryMax,
          "integrated (" << r.integrated << ") must sit below the momentary peak");

    // A signal shorter than the 3 s short-term window can report a momentary
    // value but must not invent a short-term one.
    const auto brief = LoudnessAnalyzer::analyze(makeSegments({{1.0, -23.0}}, sr), sr);
    CHECK(std::abs(brief.momentaryMax + 23.0) < 0.1,
          "1 s signal should still give M = -23.0, got " << brief.momentaryMax);
    CHECK(brief.shortTermMax == LoudnessAnalyzer::kNoMeasurement,
          "1 s signal must not report a short-term value, got " << brief.shortTermMax);
    CHECK(brief.lra == 0.0, "1 s signal must report LRA 0, got " << brief.lra);
}

// ── Live M / S windows (the meter path) ──────────────────────────────────────
// getCurrentMomentaryLufs / getCurrentShortTermLufs feed the master-bus meter.
// Unlike the maxima in Results they must track the signal down as well as up,
// so a level change has to move them within one window length.
static void testLiveWindows(double sr)
{
    std::cout << "live momentary / short-term windows @ " << sr << " Hz\n";

    // A steady -23 dBFS sine in both channels reads -23 LUFS (see the header's
    // convention note). Fed in one shot, both windows are full at the end.
    {
        LoudnessAnalyzer a;
        a.prepare(sr, 2);

        const auto buf = makeSegments({{10.0, -23.0}}, sr);
        a.processBlock(buf.getArrayOfReadPointers(), buf.getNumSamples());

        const double m = a.getCurrentMomentaryLufs();
        const double s = a.getCurrentShortTermLufs();
        std::cout << "    steady -23 dBFS sine           M=" << std::fixed
                  << std::setprecision(3) << m << "  S=" << s << "\n";

        CHECK(std::abs(m + 23.0) < 0.1, "live M should be -23.0, got " << m);
        CHECK(std::abs(s + 23.0) < 0.1, "live S should be -23.0, got " << s);
    }

    // Before a single 100 ms sub-block closes there is nothing to average.
    {
        LoudnessAnalyzer a;
        a.prepare(sr, 2);
        CHECK(a.getCurrentMomentaryLufs() == LoudnessAnalyzer::kNoMeasurement,
              "M before any audio should be kNoMeasurement, got " << a.getCurrentMomentaryLufs());
        CHECK(a.getCurrentShortTermLufs() == LoudnessAnalyzer::kNoMeasurement,
              "S before any audio should be kNoMeasurement, got " << a.getCurrentShortTermLufs());

        const auto brief = makeSegments({{0.05, -23.0}}, sr);   // half a sub-block
        a.processBlock(brief.getArrayOfReadPointers(), brief.getNumSamples());
        CHECK(a.getCurrentMomentaryLufs() == LoudnessAnalyzer::kNoMeasurement,
              "M after 50 ms should still be kNoMeasurement, got " << a.getCurrentMomentaryLufs());
    }

    // The windows must fall, not latch. -23 for 10 s then -33 for 10 s: both
    // live readings sit at the new level while both maxima stay at the old one.
    {
        LoudnessAnalyzer a;
        a.prepare(sr, 2);

        const auto buf = makeSegments({{10.0, -23.0}, {10.0, -33.0}}, sr);
        a.processBlock(buf.getArrayOfReadPointers(), buf.getNumSamples());

        const double m = a.getCurrentMomentaryLufs();
        const double s = a.getCurrentShortTermLufs();
        std::cout << "    -23 then -33 dBFS              M=" << std::fixed
                  << std::setprecision(3) << m << "  S=" << s << "\n";

        CHECK(std::abs(m + 33.0) < 0.1, "live M should follow down to -33.0, got " << m);
        CHECK(std::abs(s + 33.0) < 0.1, "live S should follow down to -33.0, got " << s);

        const auto r = a.getResults();
        CHECK(std::abs(r.momentaryMax + 23.0) < 0.1,
              "momentary MAX must stay at -23.0, got " << r.momentaryMax);
    }

    // Streaming in device-sized blocks must give the same answer as one shot —
    // the meter is fed 512 samples at a time on the audio thread.
    {
        LoudnessAnalyzer a;
        a.prepare(sr, 2);

        const auto buf = makeSegments({{6.0, -20.0}}, sr);
        const int  n   = buf.getNumSamples();
        const float* const* src = buf.getArrayOfReadPointers();

        for (int pos = 0; pos < n; pos += 512)
        {
            const float* chans[2] = { src[0] + pos, src[1] + pos };
            a.processBlock(chans, std::min(512, n - pos));
        }

        CHECK(std::abs(a.getCurrentMomentaryLufs() + 20.0) < 0.1,
              "block-fed live M should be -20.0, got " << a.getCurrentMomentaryLufs());
        CHECK(std::abs(a.getCurrentShortTermLufs() + 20.0) < 0.1,
              "block-fed live S should be -20.0, got " << a.getCurrentShortTermLufs());
    }

    // reset() drops the windows along with everything else.
    {
        LoudnessAnalyzer a;
        a.prepare(sr, 2);
        const auto buf = makeSegments({{5.0, -23.0}}, sr);
        a.processBlock(buf.getArrayOfReadPointers(), buf.getNumSamples());
        a.reset();
        CHECK(a.getCurrentMomentaryLufs() == LoudnessAnalyzer::kNoMeasurement,
              "M after reset should be kNoMeasurement, got " << a.getCurrentMomentaryLufs());
        CHECK(a.getCurrentShortTermLufs() == LoudnessAnalyzer::kNoMeasurement,
              "S after reset should be kNoMeasurement, got " << a.getCurrentShortTermLufs());
    }
}

// ── True peak ────────────────────────────────────────────────────────────────
static void testTruePeak(double sr)
{
    std::cout << "true peak @ " << sr << " Hz\n";

    // The canonical inter-sample overshoot. The sample pattern +1,+1,-1,-1 is
    // period-4, so its band-limited reconstruction is a pure fs/4 sine whose
    // only non-zero DFT bin gives it amplitude sqrt(2). Sample peak is 0 dBFS;
    // true peak is +3.01 dBTP, and the overshoot sits exactly on the half-sample
    // grid point, so 4x oversampling lands on it rather than near it.
    {
        const int n = static_cast<int>(sr) * 2;
        juce::AudioBuffer<float> buf(2, n);
        for (int i = 0; i < n; ++i)
        {
            const float v = ((i % 4) < 2) ? 1.0f : -1.0f;
            buf.setSample(0, i, v);
            buf.setSample(1, i, v);
        }
        applyEdgeFade(buf);

        const auto r = LoudnessAnalyzer::analyze(buf, sr);
        std::cout << "    fs/4 alternating pairs        TP=" << std::fixed
                  << std::setprecision(3) << r.truePeakDbtp << " dBTP (sample peak 0.000 dBFS)\n";

        CHECK(r.truePeakDbtp > 0.0,
              "true peak must exceed the 0 dBFS sample peak, got " << r.truePeakDbtp);
        CHECK(std::abs(r.truePeakDbtp - 3.01) < 0.3,
              "reconstructed peak should be ~+3.01 dBTP, got " << r.truePeakDbtp);
    }

    // Half amplitude: the same geometry 6.02 dB down. Confirms the measurement
    // scales rather than saturating at some internal ceiling.
    {
        const int n = static_cast<int>(sr) * 2;
        juce::AudioBuffer<float> buf(2, n);
        for (int i = 0; i < n; ++i)
        {
            const float v = ((i % 4) < 2) ? 0.5f : -0.5f;
            buf.setSample(0, i, v);
            buf.setSample(1, i, v);
        }
        applyEdgeFade(buf);

        const auto r = LoudnessAnalyzer::analyze(buf, sr);
        CHECK(std::abs(r.truePeakDbtp + 3.01) < 0.3,
              "half-amplitude case should be ~-3.01 dBTP, got " << r.truePeakDbtp);
    }

    // DC: every polyphase branch is normalised to unity DC gain, so a constant
    // must measure as exactly itself with no overshoot invented by the window.
    {
        const int n = static_cast<int>(sr);
        juce::AudioBuffer<float> buf(2, n);
        for (int i = 0; i < n; ++i) { buf.setSample(0, i, 0.5f); buf.setSample(1, i, 0.5f); }
        applyEdgeFade(buf);

        const auto r = LoudnessAnalyzer::analyze(buf, sr);
        const double expected = 20.0 * std::log10(0.5);
        CHECK(std::abs(r.truePeakDbtp - expected) < 0.01,
              "DC 0.5 should measure " << expected << " dBTP, got " << r.truePeakDbtp);
    }

    // A sine sampled exactly on its peaks has no overshoot to find: sample peak
    // and true peak coincide. Negative control against an interpolator that
    // always reports a bit more than the samples.
    {
        const int n = static_cast<int>(sr);
        juce::AudioBuffer<float> buf(2, n);
        buf.clear();
        for (int i = 0; i < n; i += 4)
        {
            buf.setSample(0, i, 1.0f);      buf.setSample(1, i, 1.0f);
            if (i + 2 < n) { buf.setSample(0, i + 2, -1.0f); buf.setSample(1, i + 2, -1.0f); }
        }
        applyEdgeFade(buf);

        const auto r = LoudnessAnalyzer::analyze(buf, sr);
        CHECK(std::abs(r.truePeakDbtp) < 0.1,
              "peak-sampled fs/4 sine should be ~0.0 dBTP, got " << r.truePeakDbtp);
    }

    // True peak must never be reported below the sample peak, even for a signal
    // whose only loud sample is the very last one (the delay line never flushes
    // it through the interpolator).
    {
        const int n = 1000;
        juce::AudioBuffer<float> buf(2, n);
        buf.clear();
        buf.setSample(0, n - 1, 0.8f);
        buf.setSample(1, n - 1, 0.8f);

        const auto r = LoudnessAnalyzer::analyze(buf, sr);
        CHECK(r.truePeakDbtp >= 20.0 * std::log10(0.8) - 0.01,
              "trailing sample peak must still be reported, got " << r.truePeakDbtp);
    }
}

// ── Streaming ────────────────────────────────────────────────────────────────
static void testStreamingEquivalence(double sr)
{
    std::cout << "streaming vs offline @ " << sr << " Hz\n";

    const auto buf = makeSegments({{6.0, -30.0}, {6.0, -18.0}, {6.0, -26.0}}, sr);
    const auto offline = LoudnessAnalyzer::analyze(buf, sr);

    // Odd chunk sizes, none of them a divisor of the 100 ms sub-block, so every
    // sub-block boundary falls mid-chunk at least once.
    for (int chunk : { 1, 37, 511, 4096 })
    {
        LoudnessAnalyzer a;
        a.prepare(sr, 2);

        const float* const* src = buf.getArrayOfReadPointers();
        const int n = buf.getNumSamples();
        for (int pos = 0; pos < n; pos += chunk)
        {
            const int len = std::min(chunk, n - pos);
            const float* ptrs[2] = { src[0] + pos, src[1] + pos };
            a.processBlock(ptrs, len);
        }
        const auto r = a.getResults();

        CHECK(std::abs(r.integrated   - offline.integrated)   < 1.0e-9,
              "chunk " << chunk << ": I drifted, " << r.integrated << " vs " << offline.integrated);
        CHECK(std::abs(r.momentaryMax - offline.momentaryMax) < 1.0e-9,
              "chunk " << chunk << ": M drifted");
        CHECK(std::abs(r.shortTermMax - offline.shortTermMax) < 1.0e-9,
              "chunk " << chunk << ": S drifted");
        CHECK(std::abs(r.lra          - offline.lra)          < 1.0e-9,
              "chunk " << chunk << ": LRA drifted");
        CHECK(std::abs(r.truePeakDbtp - offline.truePeakDbtp) < 1.0e-9,
              "chunk " << chunk << ": TP drifted, " << r.truePeakDbtp
              << " vs " << offline.truePeakDbtp);
    }

    // reset() must return the analyzer to a virgin state without re-preparing.
    {
        LoudnessAnalyzer a;
        a.prepare(sr, 2);
        a.processBlock(buf.getArrayOfReadPointers(), buf.getNumSamples());
        a.reset();
        a.processBlock(buf.getArrayOfReadPointers(), buf.getNumSamples());
        const auto r = a.getResults();
        CHECK(std::abs(r.integrated - offline.integrated) < 1.0e-9,
              "reset() left residue: I=" << r.integrated << " vs " << offline.integrated);
        CHECK(std::abs(r.truePeakDbtp - offline.truePeakDbtp) < 1.0e-9,
              "reset() left residue in the true-peak state");
    }
}

// ── Degenerate input ─────────────────────────────────────────────────────────
static void testDegenerate()
{
    std::cout << "degenerate input\n";

    // Digital silence: nothing measurable, and nothing that produces -inf or NaN.
    {
        juce::AudioBuffer<float> buf(2, 48000);
        buf.clear();
        const auto r = LoudnessAnalyzer::analyze(buf, kSR48);
        CHECK(r.integrated   == LoudnessAnalyzer::kNoMeasurement, "silence I, got " << r.integrated);
        CHECK(r.momentaryMax == LoudnessAnalyzer::kNoMeasurement, "silence M, got " << r.momentaryMax);
        CHECK(r.shortTermMax == LoudnessAnalyzer::kNoMeasurement, "silence S, got " << r.shortTermMax);
        CHECK(r.truePeakDbtp == LoudnessAnalyzer::kNoMeasurement, "silence TP, got " << r.truePeakDbtp);
        CHECK(r.lra == 0.0, "silence LRA, got " << r.lra);
    }

    // Empty buffer, and a buffer shorter than one sub-block.
    {
        juce::AudioBuffer<float> empty(2, 0);
        const auto r = LoudnessAnalyzer::analyze(empty, kSR48);
        CHECK(r.integrated == LoudnessAnalyzer::kNoMeasurement, "empty buffer I");

        juce::AudioBuffer<float> tiny(2, 10);
        tiny.clear();
        tiny.setSample(0, 5, 0.25f);
        const auto t = LoudnessAnalyzer::analyze(tiny, kSR48);
        CHECK(t.integrated == LoudnessAnalyzer::kNoMeasurement, "10-sample buffer I");
        CHECK(std::abs(t.truePeakDbtp - 20.0 * std::log10(0.25)) < 0.5,
              "10-sample buffer should still report a peak, got " << t.truePeakDbtp);
    }

    // Mono in, and unprepared / invalid use must not crash or measure.
    {
        juce::AudioBuffer<float> mono(1, static_cast<int>(kSR48) * 4);
        const double w = 2.0 * juce::MathConstants<double>::pi * 1000.0 / kSR48;
        const double amp = std::pow(10.0, -20.0 / 20.0);
        for (int i = 0; i < mono.getNumSamples(); ++i)
            mono.setSample(0, i, static_cast<float>(amp * std::sin(w * i)));

        const auto r = LoudnessAnalyzer::analyze(mono, kSR48);
        // One channel at G = 1.0: same -23.01 LUFS as the left-only stereo case.
        CHECK(std::abs(r.integrated + 23.01) < 0.1,
              "mono -20 dBFS should be -23.01, got " << r.integrated);

        LoudnessAnalyzer bare;                       // never prepared
        const float* const* ptrs = mono.getArrayOfReadPointers();
        bare.processBlock(ptrs, mono.getNumSamples());
        bare.processBlock(nullptr, 100);
        CHECK(bare.getResults().integrated == LoudnessAnalyzer::kNoMeasurement,
              "unprepared analyzer must measure nothing");

        LoudnessAnalyzer bad;
        bad.prepare(0.0, 2);                          // invalid rate
        CHECK(bad.getResults().integrated == LoudnessAnalyzer::kNoMeasurement,
              "prepare(0) must leave the analyzer inert");
    }
}

// ── WAV mode (diagnostic, not a pass/fail gate) ──────────────────────────────
// Following the precedent in test_loop_optimizer: given a file path as argv[1],
// this binary measures that file instead of running the unit tests. That is how
// the analyzer gets cross-checked against an external meter — point both this
// and `ffmpeg -af ebur128` at the SAME file, so neither tool's idea of how to
// synthesise a test tone is part of the comparison.
static int runWavMode(const char* path)
{
    juce::AudioFormatManager fm;
    fm.registerBasicFormats();

    juce::File file(juce::String::fromUTF8(path));
    std::unique_ptr<juce::AudioFormatReader> reader(fm.createReaderFor(file));
    if (reader == nullptr)
    {
        std::cerr << "could not read: " << path << "\n";
        return 1;
    }

    const int numCh = static_cast<int>(reader->numChannels);
    const int numSm = static_cast<int>(reader->lengthInSamples);
    juce::AudioBuffer<float> buf(numCh, numSm);
    reader->read(&buf, 0, numSm, 0, true, numCh > 1);

    const auto r = LoudnessAnalyzer::analyze(buf, reader->sampleRate);

    std::cout << std::fixed << std::setprecision(3)
              << file.getFileName() << "\n"
              << "  sampleRate      " << reader->sampleRate << "\n"
              << "  channels        " << numCh << "\n"
              << "  duration (s)    " << (numSm / reader->sampleRate) << "\n"
              << "  Integrated      " << r.integrated   << " LUFS\n"
              << "  Momentary max   " << r.momentaryMax << " LUFS\n"
              << "  Short-term max  " << r.shortTermMax << " LUFS\n"
              << "  LRA             " << r.lra          << " LU\n"
              << "  True peak       " << r.truePeakDbtp << " dBTP\n";
    return 0;
}

int main(int argc, char** argv)
{
    if (argc > 1) return runWavMode(argv[1]);

    std::cout << "=== test_loudness ===\n";

    testKWeightingCoefficients();

    // The calibration runs at both rates — that pair is the whole defence
    // against a hardcoded-48 kHz-coefficient regression.
    testCalibration(kSR48);
    testCalibration(kSR44);

    testEbuGatingVectors(kSR48);
    testEbuGatingVectors(kSR44);

    testGatingIsolated(kSR48);
    testLoudnessRange(kSR48);
    testLoudnessRange(kSR44);
    testWindowMaxima(kSR48);

    // Both rates: the live meter windows are the one path that reads the
    // sub-block history directly, so they get the same 44.1/48 pairing as the
    // calibration.
    testLiveWindows(kSR48);
    testLiveWindows(kSR44);

    testTruePeak(kSR48);
    testTruePeak(kSR44);

    testStreamingEquivalence(kSR48);
    testDegenerate();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0) {
        std::cerr << "FAILED: " << g_failed << " check(s)\n";
        return 1;
    }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
