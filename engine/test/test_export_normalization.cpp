// test_export_normalization.cpp — Loudness normalisation in export/AudioExporter:
// the pure gain plan (AudioExporter::planNormalization) and its application to a
// finished render, measured with dsp/LoudnessAnalyzer.
// Build: see engine/CMakeLists.txt target "test_export_normalization"
// Run:   test_export_normalization.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: ..." and exits 1
//
// Three layers, cheapest first:
//   • The branch matrix of planNormalization against hand-computed dB arithmetic.
//     Every branch is one subtraction, so the expected values are exact, not
//     captured — a wrong sign or a swapped min/max cannot pass.
//   • A closed loop with no engine in it: synthesise a buffer of known loudness,
//     plan, apply the gain, re-measure with LoudnessAnalyzer. This is what proves
//     the plan's *prediction* is true of the signal, not just self-consistent.
//   • The real AudioExporter::exportAudio, end to end through FFmpeg, on both the
//     Phase 3A tail path and the Phase 3B wrap path. The point of these is (a)
//     normalizationEnabled == false must leave the render bit-identical — this is
//     the guard against the feature ever becoming accidentally always-on — and
//     (b) when it is enabled, the file differs from that reference by EXACTLY the
//     planned static gain and nothing else (no second render pass, no limiter).
//
// Convention note (same as test_loudness): under BS.1770-4 a 1 kHz sine present
// in both channels of a stereo pair reads its peak dBFS back as LUFS exactly,
// because the K-weighting's +0.691 dB gain at 1 kHz cancels the -0.691 offset.

#include "audio/MixEngine.h"
#include "dsp/LoudnessAnalyzer.h"
#include "export/AudioExporter.h"
#include "model/Timeline.h"
#include "SampleBank.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <string>
#include <vector>

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                 \
    do {                                                                 \
        if (cond) { ++g_passed; }                                        \
        else { std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; ++g_failed; } \
    } while (0)

using xleth::dsp::LoudnessAnalyzer;

static constexpr double kNoMeas = LoudnessAnalyzer::kNoMeasurement;

// dB arithmetic in the plan is exact to within double rounding; nothing here is
// a fit or a measurement, so the tolerance only absorbs the last few ULPs.
static constexpr double kDbEps = 1.0e-9;

static bool approx(double a, double b, double tol) { return std::abs(a - b) <= tol; }

static void report(const char* label, const AudioExporter::NormalizationReport& r)
{
    std::cout << "    " << std::left << std::setw(38) << label << std::right
              << std::fixed << std::setprecision(3)
              << " applied=" << (r.applied ? "y" : "n")
              << "  I=" << std::setw(8) << r.measuredIntegratedLufs
              << "  TP=" << std::setw(7) << r.measuredTruePeakDbtp
              << "  gain=" << std::setw(7) << r.loudnessGainDb
              << "  safety=" << std::setw(7) << r.peakSafetyGainDb
              << "  → I'=" << std::setw(8) << r.finalPredictedIntegratedLufs
              << "  TP'=" << std::setw(7) << r.finalPredictedTruePeakDbtp << "\n";
}

// ── The gain plan, branch by branch ──────────────────────────────────────────

static void testPlanLouderThanTarget()
{
    std::cout << "planNormalization: louder than target\n";

    // -9 LUFS toward -14 is a 5 dB cut; the peak follows it down to -6.5 dBTP,
    // which is under the -1 ceiling, so no safety attenuation is needed.
    const auto r = AudioExporter::planNormalization(-9.0, -1.5, -14.0, -1.0, false);
    report("louder, downward trim", r);

    CHECK(r.applied, "should apply");
    CHECK(approx(r.loudnessGainDb, -5.0, kDbEps), "loudnessGainDb, got " << r.loudnessGainDb);
    CHECK(approx(r.peakSafetyGainDb, 0.0, kDbEps), "peakSafetyGainDb, got " << r.peakSafetyGainDb);
    CHECK(approx(r.finalPredictedIntegratedLufs, -14.0, kDbEps),
          "final I, got " << r.finalPredictedIntegratedLufs);
    CHECK(approx(r.finalPredictedTruePeakDbtp, -6.5, kDbEps),
          "final TP, got " << r.finalPredictedTruePeakDbtp);
    CHECK(approx(r.measuredIntegratedLufs, -9.0, kDbEps), "measured I is echoed back");
    CHECK(approx(r.measuredTruePeakDbtp, -1.5, kDbEps), "measured TP is echoed back");

    // A downward trim is never gated on allowUpwardGain.
    const auto rUp = AudioExporter::planNormalization(-9.0, -1.5, -14.0, -1.0, true);
    CHECK(approx(rUp.loudnessGainDb, r.loudnessGainDb, kDbEps),
          "allowUpwardGain must not change a downward trim, got " << rUp.loudnessGainDb);
}

static void testPlanQuieterUpwardDisabled()
{
    std::cout << "planNormalization: quieter than target, upward disabled\n";

    // -20 LUFS wants +6 dB to reach -14. Disabled means the render ships as it
    // is: gain 0, and the plan is still a valid (no-op) plan, not a failure.
    const auto r = AudioExporter::planNormalization(-20.0, -6.0, -14.0, -1.0, false);
    report("quieter, upward disabled", r);

    CHECK(r.applied, "a no-op plan is still an applied plan");
    CHECK(approx(r.loudnessGainDb, 0.0, kDbEps), "loudnessGainDb must be 0, got " << r.loudnessGainDb);
    CHECK(approx(r.peakSafetyGainDb, 0.0, kDbEps), "peakSafetyGainDb, got " << r.peakSafetyGainDb);
    CHECK(approx(r.finalPredictedIntegratedLufs, -20.0, kDbEps),
          "final I stays at the measurement, got " << r.finalPredictedIntegratedLufs);
    CHECK(approx(r.finalPredictedTruePeakDbtp, -6.0, kDbEps),
          "final TP stays at the measurement, got " << r.finalPredictedTruePeakDbtp);

    // Quiet does NOT excuse a hot peak: the ceiling still applies with upward
    // gain disabled. -20 LUFS peaking at +0.5 dBTP is a real (clipped) render.
    const auto hot = AudioExporter::planNormalization(-20.0, 0.5, -14.0, -1.0, false);
    report("quiet but clipping, upward disabled", hot);
    CHECK(hot.applied, "should apply");
    CHECK(approx(hot.loudnessGainDb, 0.0, kDbEps), "no lift, got " << hot.loudnessGainDb);
    CHECK(approx(hot.peakSafetyGainDb, -1.5, kDbEps),
          "ceiling still enforced, got " << hot.peakSafetyGainDb);
    CHECK(approx(hot.finalPredictedTruePeakDbtp, -1.0, kDbEps),
          "final TP lands on the ceiling, got " << hot.finalPredictedTruePeakDbtp);
}

static void testPlanQuieterUpwardEnabled()
{
    std::cout << "planNormalization: quieter than target, upward enabled\n";

    // +6 dB wanted, 11 dB of peak headroom available (-1 minus -12) → take it all.
    const auto r = AudioExporter::planNormalization(-20.0, -12.0, -14.0, -1.0, true);
    report("quieter, upward enabled, headroom ok", r);

    CHECK(r.applied, "should apply");
    CHECK(approx(r.loudnessGainDb, 6.0, kDbEps), "loudnessGainDb, got " << r.loudnessGainDb);
    CHECK(approx(r.peakSafetyGainDb, 0.0, kDbEps),
          "lift within headroom needs no safety cut, got " << r.peakSafetyGainDb);
    CHECK(approx(r.finalPredictedIntegratedLufs, -14.0, kDbEps),
          "final I hits the target, got " << r.finalPredictedIntegratedLufs);
    CHECK(approx(r.finalPredictedTruePeakDbtp, -6.0, kDbEps),
          "final TP, got " << r.finalPredictedTruePeakDbtp);
}

static void testPlanUpwardCappedByHeadroom()
{
    std::cout << "planNormalization: upward lift capped by true-peak headroom\n";

    // +6 dB wanted but only 2 dB of headroom (-1 minus -3). Without a limiter the
    // ceiling wins: lift 2 dB, land exactly on it, and fall 4 LU short of target.
    const auto r = AudioExporter::planNormalization(-20.0, -3.0, -14.0, -1.0, true);
    report("quieter, upward capped", r);

    CHECK(r.applied, "should apply");
    CHECK(approx(r.loudnessGainDb, 2.0, kDbEps),
          "lift must be capped at the headroom, got " << r.loudnessGainDb);
    CHECK(approx(r.peakSafetyGainDb, 0.0, kDbEps),
          "capping already respects the ceiling, got " << r.peakSafetyGainDb);
    CHECK(approx(r.finalPredictedTruePeakDbtp, -1.0, kDbEps),
          "final TP lands exactly on the ceiling, got " << r.finalPredictedTruePeakDbtp);
    CHECK(approx(r.finalPredictedIntegratedLufs, -18.0, kDbEps),
          "the shortfall vs target must be reported honestly, got "
              << r.finalPredictedIntegratedLufs);

    // No headroom at all (already above the ceiling): the lift is 0, NOT negative
    // — pulling the peak down is peakSafetyGainDb's job, and it must not be
    // double-counted by the loudness term.
    const auto none = AudioExporter::planNormalization(-20.0, 0.5, -14.0, -1.0, true);
    report("quieter, no headroom at all", none);
    CHECK(approx(none.loudnessGainDb, 0.0, kDbEps),
          "lift must clamp at 0, not go negative, got " << none.loudnessGainDb);
    CHECK(approx(none.peakSafetyGainDb, -1.5, kDbEps),
          "peak cut, got " << none.peakSafetyGainDb);
    CHECK(approx(none.finalPredictedTruePeakDbtp, -1.0, kDbEps),
          "final TP, got " << none.finalPredictedTruePeakDbtp);
}

static void testPlanOnTargetHotPeak()
{
    std::cout << "planNormalization: on target, hot true peak\n";

    // Already at -14 LUFS but peaking at +0.5 dBTP: nothing to trim for loudness,
    // 1.5 dB of static attenuation for the ceiling, and the loudness goes 1.5 LU
    // below target as a result. That trade is the whole no-limiter decision.
    const auto r = AudioExporter::planNormalization(-14.0, 0.5, -14.0, -1.0, false);
    report("on target, hot peak", r);

    CHECK(r.applied, "should apply");
    CHECK(approx(r.loudnessGainDb, 0.0, kDbEps), "loudnessGainDb, got " << r.loudnessGainDb);
    CHECK(approx(r.peakSafetyGainDb, -1.5, kDbEps), "peakSafetyGainDb, got " << r.peakSafetyGainDb);
    CHECK(r.peakSafetyGainDb <= 0.0, "peakSafetyGainDb must never be positive");
    CHECK(approx(r.finalPredictedTruePeakDbtp, -1.0, kDbEps),
          "final TP, got " << r.finalPredictedTruePeakDbtp);
    CHECK(approx(r.finalPredictedIntegratedLufs, -15.5, kDbEps),
          "final I, got " << r.finalPredictedIntegratedLufs);

    // Exactly on the ceiling is not over it — no attenuation.
    const auto onCeiling = AudioExporter::planNormalization(-14.0, -1.0, -14.0, -1.0, false);
    CHECK(approx(onCeiling.peakSafetyGainDb, 0.0, kDbEps),
          "TP exactly at the ceiling needs no cut, got " << onCeiling.peakSafetyGainDb);
}

static void testPlanDegenerate()
{
    std::cout << "planNormalization: degenerate measurements\n";

    // Digital silence / too-short render: LoudnessAnalyzer reports the sentinel
    // for both fields. Treating -200 as a level would ask for a +186 dB lift.
    const auto silent = AudioExporter::planNormalization(kNoMeas, kNoMeas, -14.0, -1.0, true);
    report("silence (both sentinels)", silent);
    CHECK(!silent.applied, "silent render must not be normalised");
    CHECK(approx(silent.loudnessGainDb, 0.0, kDbEps), "gain must be 0, got " << silent.loudnessGainDb);
    CHECK(approx(silent.peakSafetyGainDb, 0.0, kDbEps),
          "safety must be 0, got " << silent.peakSafetyGainDb);
    CHECK(approx(silent.measuredIntegratedLufs, kNoMeas, kDbEps),
          "the sentinel is still reported back for the UI");

    // Gated-out loudness but a real peak (a single click in an otherwise silent
    // render) is just as degenerate for a loudness target.
    const auto noLoudness = AudioExporter::planNormalization(kNoMeas, -3.0, -14.0, -1.0, true);
    CHECK(!noLoudness.applied, "no integrated measurement means no plan");

    // Non-finite must never reach the buffer as a gain.
    const auto nan = AudioExporter::planNormalization(
        std::numeric_limits<double>::quiet_NaN(), -3.0, -14.0, -1.0, true);
    CHECK(!nan.applied, "NaN loudness must not be normalised");
    CHECK(approx(nan.loudnessGainDb, 0.0, kDbEps), "NaN must not produce a gain");

    // Sanity clamp: a finite but absurd measurement (-199 LUFS is above the
    // sentinel, so it passes the first guard) would ask for +185 dB. Skip it.
    const auto absurdUp = AudioExporter::planNormalization(-199.0, -199.0, -14.0, -1.0, true);
    report("absurd upward (+185 dB)", absurdUp);
    CHECK(!absurdUp.applied, "an absurd lift must be skipped, not obeyed");
    CHECK(approx(absurdUp.loudnessGainDb, 0.0, kDbEps), "absurd lift must leave gain at 0");

    // ...and the same in the other direction.
    const auto absurdDown = AudioExporter::planNormalization(-0.5, -0.1, -75.0, -1.0, false);
    report("absurd downward (-74.5 dB)", absurdDown);
    CHECK(!absurdDown.applied, "an absurd cut must be skipped, not obeyed");
    CHECK(approx(absurdDown.loudnessGainDb, 0.0, kDbEps), "absurd cut must leave gain at 0");

    // Just inside the clamp still works — the guard is a cliff at 60 dB, not a
    // vague discouragement of large moves.
    const auto bigButSane = AudioExporter::planNormalization(-70.0, -70.0, -15.0, -1.0, true);
    CHECK(bigButSane.applied, "+55 dB is inside the clamp and must be honoured");
    CHECK(approx(bigButSane.loudnessGainDb, 55.0, kDbEps),
          "loudnessGainDb, got " << bigButSane.loudnessGainDb);
}

// ── Closed loop: plan → apply → re-measure ───────────────────────────────────

// Stereo 1 kHz sine at a given peak dBFS, with a raised-cosine fade at each end.
// The fade keeps the true-peak interpolator from ringing on the buffer edge (see
// the same helper in test_loudness); it is far too short to move the integrated
// loudness of a multi-second buffer.
static juce::AudioBuffer<float> makeSine(double peakDbfs, double seconds,
                                         double sampleRate, double freqHz = 1000.0)
{
    const int n = static_cast<int>(std::llround(seconds * sampleRate));
    juce::AudioBuffer<float> buf(2, n);
    buf.clear();

    const double amp = std::pow(10.0, peakDbfs / 20.0);
    const double w   = 2.0 * juce::MathConstants<double>::pi * freqHz / sampleRate;

    for (int i = 0; i < n; ++i)
    {
        const auto v = static_cast<float>(amp * std::sin(w * i));
        buf.setSample(0, i, v);
        buf.setSample(1, i, v);
    }

    const int f = std::min(1024, n / 2);
    for (int i = 0; i < f; ++i)
    {
        const auto g = static_cast<float>(
            0.5 * (1.0 - std::cos(juce::MathConstants<double>::pi * i / f)));
        for (int c = 0; c < 2; ++c)
        {
            buf.setSample(c, i,         buf.getSample(c, i) * g);
            buf.setSample(c, n - 1 - i, buf.getSample(c, n - 1 - i) * g);
        }
    }
    return buf;
}

static void testClosedLoopDownward(double sampleRate)
{
    std::cout << "closed loop: -9 LUFS → target -14, ceiling -1.0 @ " << sampleRate << " Hz\n";

    constexpr double kTarget  = -14.0;
    constexpr double kCeiling = -1.0;

    // A -9 dBFS stereo 1 kHz sine measures -9 LUFS integrated (see the header
    // note), so this fixture starts 5 LU above the target.
    auto buf = makeSine(-9.0, 6.0, sampleRate);

    const auto before = LoudnessAnalyzer::analyze(buf, sampleRate);
    std::cout << "    measured before: I=" << std::fixed << std::setprecision(3)
              << before.integrated << " LUFS  TP=" << before.truePeakDbtp << " dBTP\n";
    CHECK(approx(before.integrated, -9.0, 0.3),
          "fixture should measure about -9 LUFS, got " << before.integrated);

    const auto plan = AudioExporter::planNormalization(
        before.integrated, before.truePeakDbtp, kTarget, kCeiling, false);
    report("plan", plan);
    CHECK(plan.applied, "plan should apply");
    CHECK(plan.loudnessGainDb < 0.0, "a -9 LUFS render toward -14 must be a cut");
    CHECK(approx(plan.peakSafetyGainDb, 0.0, kDbEps),
          "cutting 5 dB cannot breach a -1 dBTP ceiling, got " << plan.peakSafetyGainDb);

    // Exactly what exportAudio does: ONE gain over the whole buffer.
    const double totalGainDb = plan.loudnessGainDb + plan.peakSafetyGainDb;
    buf.applyGain(static_cast<float>(std::pow(10.0, totalGainDb / 20.0)));

    const auto after = LoudnessAnalyzer::analyze(buf, sampleRate);
    std::cout << "    measured after:  I=" << after.integrated
              << " LUFS  TP=" << after.truePeakDbtp << " dBTP"
              << "  (predicted I=" << plan.finalPredictedIntegratedLufs
              << "  TP=" << plan.finalPredictedTruePeakDbtp << ")\n";

    CHECK(approx(after.integrated, kTarget, 0.2),
          "re-measured integrated must land on target within 0.2 LU, got " << after.integrated);
    CHECK(after.truePeakDbtp <= kCeiling,
          "re-measured true peak must be at or below the ceiling, got " << after.truePeakDbtp);

    // The prediction is not a guess: a static gain moves both measurements by
    // exactly that many dB, so it must match what was actually measured.
    CHECK(approx(after.integrated, plan.finalPredictedIntegratedLufs, 0.05),
          "prediction vs measurement (I): predicted " << plan.finalPredictedIntegratedLufs
              << ", measured " << after.integrated);
    CHECK(approx(after.truePeakDbtp, plan.finalPredictedTruePeakDbtp, 0.05),
          "prediction vs measurement (TP): predicted " << plan.finalPredictedTruePeakDbtp
              << ", measured " << after.truePeakDbtp);
}

// A quiet bed with a few short loud bursts on top: high crest factor, so the true
// peak sits far above where the integrated loudness alone would put it. A plain
// sine cannot exercise the headroom cap at all — its peak and its loudness move
// together, so there is always enough headroom for the lift.
static juce::AudioBuffer<float> makeHighCrestSignal(double bedDbfs, double burstDbfs,
                                                    double seconds, double sampleRate)
{
    auto buf = makeSine(bedDbfs, seconds, sampleRate);

    const double burstAmp   = std::pow(10.0, burstDbfs / 20.0);
    const double w          = 2.0 * juce::MathConstants<double>::pi * 1000.0 / sampleRate;
    const int    burstLen   = static_cast<int>(0.005 * sampleRate);   // 5 ms
    const int    n          = buf.getNumSamples();

    // Three bursts, well inside the buffer so the edge fade never touches them.
    for (int b = 1; b <= 3; ++b)
    {
        const int start = (n * b) / 4;
        for (int i = 0; i < burstLen && start + i < n; ++i)
        {
            // Raised-cosine envelope: a hard-edged burst would be a step into the
            // true-peak interpolator, and the overshoot it rings with belongs to
            // the edge rather than to the signal.
            const double env = 0.5 * (1.0 - std::cos(
                2.0 * juce::MathConstants<double>::pi * i / burstLen));
            const auto v = static_cast<float>(burstAmp * env * std::sin(w * (start + i)));
            for (int c = 0; c < 2; ++c)
                buf.setSample(c, start + i, buf.getSample(c, start + i) + v);
        }
    }
    return buf;
}

static void testClosedLoopUpwardCapped(double sampleRate)
{
    std::cout << "closed loop: quiet render, upward lift capped by the ceiling @ "
              << sampleRate << " Hz\n";

    constexpr double kTarget  = -6.0;   // deliberately louder than the headroom allows
    constexpr double kCeiling = -1.0;

    // Quiet bed (~-20 LUFS) under bursts that peak near -2 dBTP: about 1 dB of
    // headroom against a lift of well over 10 dB, so the ceiling has to bind.
    auto buf = makeHighCrestSignal(-20.0, -2.0, 6.0, sampleRate);
    const auto before = LoudnessAnalyzer::analyze(buf, sampleRate);
    std::cout << "    measured before: I=" << std::fixed << std::setprecision(3)
              << before.integrated << " LUFS  TP=" << before.truePeakDbtp << " dBTP"
              << "  (crest " << (before.truePeakDbtp - before.integrated) << " dB)\n";
    CHECK(kCeiling - before.truePeakDbtp < kTarget - before.integrated,
          "fixture must have LESS headroom than the wanted lift, else nothing is capped:"
              " headroom " << (kCeiling - before.truePeakDbtp)
              << " vs lift " << (kTarget - before.integrated));

    const auto plan = AudioExporter::planNormalization(
        before.integrated, before.truePeakDbtp, kTarget, kCeiling, true);
    report("plan (upward, capped)", plan);
    CHECK(plan.applied, "plan should apply");
    CHECK(plan.loudnessGainDb > 0.0, "should lift");
    CHECK(approx(plan.loudnessGainDb, kCeiling - before.truePeakDbtp, kDbEps),
          "the lift must be exactly the available headroom, got " << plan.loudnessGainDb
              << " vs headroom " << (kCeiling - before.truePeakDbtp));
    CHECK(plan.finalPredictedIntegratedLufs < kTarget - 1.0,
          "the ceiling must cost loudness, and the report must say so: got "
              << plan.finalPredictedIntegratedLufs);

    buf.applyGain(static_cast<float>(
        std::pow(10.0, (plan.loudnessGainDb + plan.peakSafetyGainDb) / 20.0)));

    const auto after = LoudnessAnalyzer::analyze(buf, sampleRate);
    std::cout << "    measured after:  I=" << after.integrated
              << " LUFS  TP=" << after.truePeakDbtp << " dBTP\n";
    CHECK(after.truePeakDbtp <= kCeiling + 0.05,
          "the ceiling is the invariant that must hold, got " << after.truePeakDbtp);
    CHECK(approx(after.integrated, plan.finalPredictedIntegratedLufs, 0.05),
          "prediction vs measurement (I): predicted " << plan.finalPredictedIntegratedLufs
              << ", measured " << after.integrated);
}

// ── End to end through AudioExporter::exportAudio ────────────────────────────

static constexpr double kExportSampleRate = 44100.0;
static constexpr double kExportBpm        = 120.0;   // 1 beat = 22050 samples
static constexpr double kExportEndBeat    = 12.0;    // 6 s
static constexpr int    kExportBlockSize  = 512;

static juce::File makeTempTestDir(const juce::String& prefix)
{
    auto dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
        .getChildFile(prefix + "_" + juce::String::toHexString(
            static_cast<juce::int64>(juce::Time::currentTimeMillis())));
    dir.createDirectory();
    return dir;
}

// Mono 1 kHz sine source for the timeline clip. Level is irrelevant to what the
// export tests assert (they compare renders against each other, never against an
// absolute LUFS), it only has to be comfortably audible and not silent.
static juce::File writeSineWav(const juce::File& dir, const juce::String& name,
                               double sampleRate, int numSamples, double peakDbfs)
{
    juce::AudioBuffer<float> buffer(1, numSamples);
    buffer.clear();

    const double amp = std::pow(10.0, peakDbfs / 20.0);
    const double w   = 2.0 * juce::MathConstants<double>::pi * 1000.0 / sampleRate;
    for (int i = 0; i < numSamples; ++i)
        buffer.setSample(0, i, static_cast<float>(amp * std::sin(w * i)));

    auto file = dir.getChildFile(name + ".wav");
    file.deleteFile();

    auto stream = std::unique_ptr<juce::FileOutputStream>(file.createOutputStream());
    if (stream == nullptr) return {};

    juce::WavAudioFormat format;
    std::unique_ptr<juce::AudioFormatWriter> writer(
        format.createWriterFor(stream.get(), sampleRate, 1, 24, {}, 0));
    if (writer == nullptr) return {};

    stream.release();
    writer->writeFromAudioSampleBuffer(buffer, 0, numSamples);
    writer.reset();
    return file;
}

static juce::AudioBuffer<float> readWavBuffer(const juce::File& file)
{
    juce::AudioFormatManager manager;
    manager.registerBasicFormats();

    std::unique_ptr<juce::AudioFormatReader> reader(manager.createReaderFor(file));
    CHECK(reader != nullptr, "exported WAV should be readable: "
                                 << file.getFullPathName().toStdString());
    if (reader == nullptr) return {};

    const int length = static_cast<int>(reader->lengthInSamples);
    juce::AudioBuffer<float> buffer(
        static_cast<int>(std::max<juce::uint32>(2, reader->numChannels)), length);
    buffer.clear();
    reader->read(&buffer, 0, length, 0, true, true);
    return buffer;
}

// Everything an export needs, kept alive together: the MixEngine holds raw
// pointers into the timeline and the bank.
struct ExportFixture
{
    juce::File               tempDir;
    Timeline                 timeline {kExportBpm, kExportSampleRate};
    SampleBank               bank;
    std::unique_ptr<MixEngine> engine;

    explicit ExportFixture(const juce::String& prefix)
        : tempDir(makeTempTestDir(prefix))
    {
        const int sourceSamples = static_cast<int>(kExportSampleRate * 7.0);
        const auto wav = writeSineWav(tempDir, "tone", kExportSampleRate,
                                      sourceSamples, -9.0);
        CHECK(wav.existsAsFile(), "source tone WAV should be generated");

        TrackInfo track; track.name = "NormalizationTrack";
        const int trackId = timeline.addTrack(track);

        SampleRegion region; region.name = "Tone"; region.label = SampleLabel::Custom;
        const int regionId = timeline.addRegion(region);

        Clip clip;
        clip.trackId  = trackId;
        clip.regionId = regionId;
        clip.position = TickTime::fromBeats(0.0);
        clip.duration = TickTime::fromBeats(kExportEndBeat);
        timeline.addClip(clip);

        const int sampleId = bank.loadSample(wav, kExportSampleRate);
        CHECK(sampleId >= 0, "source tone should load into the SampleBank");

        engine = std::make_unique<MixEngine>();
        engine->setTimeline(&timeline);
        engine->setSampleBank(&bank);
        engine->mapRegionToSample(regionId, sampleId);
        engine->prepare(kExportSampleRate, kExportBlockSize);
        engine->setNonRealtime(true);
    }

    ~ExportFixture()
    {
        // Same as test_pdc_stage1: the MixEngine is deliberately leaked rather
        // than torn down inside a test process that never ran a message loop.
        (void) engine.release();
        tempDir.deleteRecursively();
    }

    AudioExporter::Config baseConfig(const juce::String& fileName) const
    {
        AudioExporter::Config cfg;
        cfg.outputPath = tempDir.getChildFile(fileName).getFullPathName().toStdString();
        cfg.format     = AudioExporter::Format::WAV;
        cfg.sampleRate = static_cast<int>(kExportSampleRate);
        cfg.bitDepth   = 32;      // PCM float — read-back is exact, no quantisation
        cfg.startBeat  = 0.0;
        cfg.endBeat    = kExportEndBeat;
        return cfg;
    }

    // Runs one export and returns the decoded file.
    juce::AudioBuffer<float> run(const AudioExporter::Config& cfg,
                                 AudioExporter::NormalizationReport& outReport,
                                 const char* label)
    {
        AudioExporter exporter;
        std::atomic<bool> cancel {false};
        const bool ok = exporter.exportAudio(timeline, bank, *engine, cfg,
                                             nullptr, cancel, &outReport);
        CHECK(ok, label << ": export should complete");
        if (!ok) return {};
        return readWavBuffer(juce::File(cfg.outputPath));
    }
};

static bool sameLength(const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b)
{
    return a.getNumChannels() == b.getNumChannels()
        && a.getNumSamples()  == b.getNumSamples()
        && a.getNumSamples()  > 0;
}

// Largest |a[i] - b[i] * scale| across the whole buffer.
static float maxDeviation(const juce::AudioBuffer<float>& a,
                          const juce::AudioBuffer<float>& b,
                          float scale)
{
    float worst = 0.0f;
    for (int c = 0; c < a.getNumChannels(); ++c)
        for (int s = 0; s < a.getNumSamples(); ++s)
            worst = std::max(worst, std::abs(a.getSample(c, s) - b.getSample(c, s) * scale));
    return worst;
}

static float maxAbs(const juce::AudioBuffer<float>& b)
{
    float peak = 0.0f;
    for (int c = 0; c < b.getNumChannels(); ++c)
        peak = std::max(peak, b.getMagnitude(c, 0, b.getNumSamples()));
    return peak;
}

// One export path (Phase 3A tail or Phase 3B wrap), three exports:
//   reference — normalisation off
//   alwaysOn  — normalisation off but with a target that WOULD move it; the file
//               must come out bit-identical to the reference
//   normalised— normalisation on; the file must equal the reference times the
//               planned gain and nothing else
static void runExportPathChecks(ExportFixture& fx,
                                const xleth::TailRenderPlan& tail,
                                double warmUpStartBeat,
                                const char* pathLabel)
{
    std::cout << "exportAudio: " << pathLabel << " path\n";

    AudioExporter::NormalizationReport refReport;
    auto refCfg = fx.baseConfig(juce::String(pathLabel) + "_ref.wav");
    refCfg.tail = tail;
    refCfg.warmUpStartBeat = warmUpStartBeat;
    const auto reference = fx.run(refCfg, refReport, pathLabel);

    CHECK(!refReport.applied,
          pathLabel << ": a disabled export must report applied = false");
    CHECK(reference.getNumSamples() > 0, pathLabel << ": reference render should have samples");
    if (reference.getNumSamples() == 0) return;

    const float refPeak = maxAbs(reference);
    CHECK(refPeak > 0.01f,
          pathLabel << ": reference render must not be silent (peak " << refPeak
                    << ") or these comparisons prove nothing");
    if (refPeak <= 0.01f) return;

    const auto refMeasured = LoudnessAnalyzer::analyze(reference, kExportSampleRate);
    std::cout << "    reference render: I=" << std::fixed << std::setprecision(3)
              << refMeasured.integrated << " LUFS  TP=" << refMeasured.truePeakDbtp
              << " dBTP  (" << reference.getNumSamples() << " samples)\n";
    CHECK(refMeasured.integrated > kNoMeas + 1.0,
          pathLabel << ": reference render must be measurable, got " << refMeasured.integrated);

    // ── The always-on guard ──────────────────────────────────────────────────
    // Same config, same aggressive target and ceiling as the normalised export
    // below — but the flag is off. Nothing may move.
    const double target  = refMeasured.integrated - 4.0;
    const double ceiling = -1.0;

    AudioExporter::NormalizationReport offReport;
    auto offCfg = fx.baseConfig(juce::String(pathLabel) + "_off.wav");
    offCfg.tail = tail;
    offCfg.warmUpStartBeat     = warmUpStartBeat;
    offCfg.normalizationEnabled = false;
    offCfg.targetLufs           = target;
    offCfg.maxDbtp              = ceiling;
    offCfg.allowUpwardGain      = true;
    const auto disabled = fx.run(offCfg, offReport, pathLabel);

    CHECK(!offReport.applied, pathLabel << ": disabled export must report applied = false");
    CHECK(approx(offReport.loudnessGainDb, 0.0, kDbEps),
          pathLabel << ": disabled export must report no gain");
    CHECK(sameLength(disabled, reference),
          pathLabel << ": disabled export length should match the reference");
    if (sameLength(disabled, reference))
    {
        const float dev = maxDeviation(disabled, reference, 1.0f);
        CHECK(dev == 0.0f,
              pathLabel << ": normalizationEnabled = false must leave the render "
                           "bit-identical; max deviation " << dev);
    }

    // ── The enabled path ─────────────────────────────────────────────────────
    AudioExporter::NormalizationReport onReport;
    auto onCfg = fx.baseConfig(juce::String(pathLabel) + "_on.wav");
    onCfg.tail = tail;
    onCfg.warmUpStartBeat      = warmUpStartBeat;
    onCfg.normalizationEnabled = true;
    onCfg.targetLufs           = target;
    onCfg.maxDbtp              = ceiling;
    onCfg.allowUpwardGain      = true;
    const auto normalised = fx.run(onCfg, onReport, pathLabel);
    report(pathLabel, onReport);

    const auto expected = AudioExporter::planNormalization(
        refMeasured.integrated, refMeasured.truePeakDbtp, target, ceiling, true);

    CHECK(onReport.applied, pathLabel << ": enabled export should apply");
    // Measuring the finished buffer means measuring the SAME thing the analyzer
    // sees here — for the wrap path that is specifically the post-fold buffer,
    // which is what ships.
    CHECK(approx(onReport.measuredIntegratedLufs, refMeasured.integrated, 0.001),
          pathLabel << ": export must measure the final buffer; report "
                    << onReport.measuredIntegratedLufs << " vs " << refMeasured.integrated);
    CHECK(approx(onReport.measuredTruePeakDbtp, refMeasured.truePeakDbtp, 0.001),
          pathLabel << ": TP measured on the final buffer; report "
                    << onReport.measuredTruePeakDbtp << " vs " << refMeasured.truePeakDbtp);
    CHECK(approx(onReport.loudnessGainDb, expected.loudnessGainDb, 1.0e-6),
          pathLabel << ": loudnessGainDb " << onReport.loudnessGainDb
                    << " should equal the plan's " << expected.loudnessGainDb);
    CHECK(approx(onReport.peakSafetyGainDb, expected.peakSafetyGainDb, 1.0e-6),
          pathLabel << ": peakSafetyGainDb " << onReport.peakSafetyGainDb
                    << " should equal the plan's " << expected.peakSafetyGainDb);
    CHECK(approx(onReport.loudnessGainDb, -4.0, 0.001),
          pathLabel << ": a target 4 LU below the render is a 4 dB cut, got "
                    << onReport.loudnessGainDb);

    CHECK(sameLength(normalised, reference),
          pathLabel << ": normalisation must not change the export length");
    if (sameLength(normalised, reference))
    {
        const auto g = static_cast<float>(std::pow(
            10.0, (onReport.loudnessGainDb + onReport.peakSafetyGainDb) / 20.0));

        // The file must be the reference times one constant — that is what "no
        // limiter, no second render pass" means, sample for sample.
        const float dev = maxDeviation(normalised, reference, g);
        CHECK(dev <= 1.0e-6f,
              pathLabel << ": normalised export must be the reference scaled by "
                        << g << "; max deviation " << dev);

        CHECK(maxDeviation(normalised, reference, 1.0f) > 1.0e-4f,
              pathLabel << ": the enabled export must actually differ from the reference");

        const auto outMeasured = LoudnessAnalyzer::analyze(normalised, kExportSampleRate);
        std::cout << "    normalised file:  I=" << outMeasured.integrated
                  << " LUFS  TP=" << outMeasured.truePeakDbtp << " dBTP"
                  << "  (target " << target << ", predicted "
                  << onReport.finalPredictedIntegratedLufs << ")\n";
        CHECK(approx(outMeasured.integrated, target, 0.2),
              pathLabel << ": exported file should measure the target within 0.2 LU, got "
                        << outMeasured.integrated);
        CHECK(outMeasured.truePeakDbtp <= ceiling,
              pathLabel << ": exported file must respect the ceiling, got "
                        << outMeasured.truePeakDbtp);
    }
}

static void testExportEndToEnd()
{
    // Phase 3A: default hardCut tail, legacy latency-only pre-roll.
    {
        ExportFixture fx("xleth_export_norm_tail");
        xleth::TailRenderPlan tail;
        tail.mode = xleth::TailRenderMode::HardCut;
        runExportPathChecks(fx, tail, /*warmUpStartBeat*/ -1.0, "tail");
    }

    // Phase 3B: wrap. The single normalisation call site sits after renderOffline
    // returns, so the buffer it measures is the folded region head — the thing
    // that ships — not the pre-fold capture.
    {
        ExportFixture fx("xleth_export_norm_wrap");
        xleth::TailRenderPlan tail;
        tail.mode            = xleth::TailRenderMode::Wrap;
        tail.maxTailSamples  = static_cast<int64_t>(kExportSampleRate * 2.0);
        tail.holdSamples     = xleth::tailHoldSamples(kExportSampleRate);
        tail.thresholdLinear = xleth::tailDbToLinear(-60.0);
        runExportPathChecks(fx, tail, /*warmUpStartBeat*/ 0.0, "wrap");
    }
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    std::cout.setf(std::ios::unitbuf);
    std::cerr.setf(std::ios::unitbuf);

    std::cout << "=== test_export_normalization ===\n";

    testPlanLouderThanTarget();
    testPlanQuieterUpwardDisabled();
    testPlanQuieterUpwardEnabled();
    testPlanUpwardCappedByHeadroom();
    testPlanOnTargetHotPeak();
    testPlanDegenerate();

    // Both export rates, because the analyzer derives its K-weighting per rate.
    testClosedLoopDownward(44100.0);
    testClosedLoopDownward(48000.0);
    testClosedLoopUpwardCapped(44100.0);

    testExportEndToEnd();

    std::cout << "\n" << g_passed << " passed, " << g_failed << " failed\n";
    if (g_failed > 0)
    {
        std::cerr << "FAILED: " << g_failed << " check(s)\n";
        std::cerr.flush();
        std::cout.flush();
        std::_Exit(1);
    }

    std::cout << "ALL TESTS PASSED\n";
    std::cerr.flush();
    std::cout.flush();
    std::_Exit(0);
}
