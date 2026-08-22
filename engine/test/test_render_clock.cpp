// test_render_clock.cpp — the shared sample <-> tick <-> beat clock
// (engine/src/render/RenderClock.h)
//
// RenderClock is the single owner of every engine-side timing conversion.
// Before the consolidation the same formula was written inline, in double
// arithmetic, in AutomationPlan, MixEngine (twice), Transport, AudioScheduler
// and seven places in XlethEngineService. Those copies disagreed at exact tick
// boundaries: (745290 / 44100.0) * (60/60.0) * 960.0 is 16223.999999999998, so
// a truncating cast returned tick 16223 for a position that is *exactly* tick
// 16224. Notes and automation could therefore miss a boundary by one buffer.
// This test locks the integer replacement's contract down.
//
// NOTE: this file deliberately does NOT use bare assert(). The engine builds
// Release-only with NDEBUG defined, which compiles assert() away entirely and
// makes a test print "ALL TESTS PASSED" without checking anything (see
// engine/test/test_frame_timing.cpp for the same warning).

#include "render/RenderClock.h"
#include "audio/AutomationPlan.h"

#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cmath>

// ── Minimal unconditional check harness ──────────────────────────────────────
static int g_checks = 0;
static int g_failures = 0;

static void checkEq(int64_t got, int64_t want, const char* what)
{
    ++g_checks;
    if (got != want) {
        ++g_failures;
        std::fprintf(stderr, "  FAIL %s: got %lld, want %lld\n",
                     what, (long long)got, (long long)want);
    }
}

static void checkTrue(bool cond, const char* what)
{
    ++g_checks;
    if (!cond) {
        ++g_failures;
        std::fprintf(stderr, "  FAIL %s\n", what);
    }
}

static const double kBpms[]  = { 60.0, 90.0, 120.0, 128.0, 140.0, 174.0, 87.5, 128.3, 111.11 };
static const int    kRates[] = { 44100, 48000, 96000 };

// ─────────────────────────────────────────────────────────────────────────────
// 1. The built-in frame/PPQ assertions still hold.
// ─────────────────────────────────────────────────────────────────────────────
static void testValidate()
{
    std::fprintf(stderr, "Test 1: RenderClock::validate()\n");
    checkTrue(RenderClock::validate(), "RenderClock::validate() returns true");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Rounding modes mean what the call sites assume they mean.
//
//    Every migrated call site picked a mode to reproduce its old arithmetic:
//      AV_ROUND_ZERO      == static_cast<int64_t>(double)   (truncate)
//      AV_ROUND_DOWN      == std::floor(double)
//      AV_ROUND_NEAR_INF  == std::llround(double)           (half away from 0)
//    Getting these backwards is the one way this consolidation moves audio.
// ─────────────────────────────────────────────────────────────────────────────
static void testRoundingModes()
{
    std::fprintf(stderr, "Test 2: rounding modes\n");

    // 48 kHz / 120 BPM: one tick is exactly 25 samples, so tick 4 starts at
    // sample 100 and the samples either side of it pin every mode down.
    const int    sr  = 48000;
    const double bpm = 120.0;

    checkEq(RenderClock::ppqToSample(1, sr, bpm), 25, "120bpm/48k: 1 tick == 25 samples");

    checkEq(RenderClock::sampleToPPQ(100, sr, bpm, AV_ROUND_ZERO), 4, "sample 100 -> tick 4 (ZERO)");
    checkEq(RenderClock::sampleToPPQ(100, sr, bpm, AV_ROUND_DOWN), 4, "sample 100 -> tick 4 (DOWN)");
    checkEq(RenderClock::sampleToPPQ(100, sr, bpm, AV_ROUND_NEAR_INF), 4, "sample 100 -> tick 4 (NEAR)");

    // One sample short of the boundary: floor/truncate must stay on tick 3,
    // round-nearest is allowed to reach 4.
    checkEq(RenderClock::sampleToPPQ(99, sr, bpm, AV_ROUND_ZERO), 3, "sample 99 -> tick 3 (ZERO)");
    checkEq(RenderClock::sampleToPPQ(99, sr, bpm, AV_ROUND_DOWN), 3, "sample 99 -> tick 3 (DOWN)");
    checkEq(RenderClock::sampleToPPQ(99, sr, bpm, AV_ROUND_NEAR_INF), 4, "sample 99 -> tick 4 (NEAR)");

    checkEq(RenderClock::sampleToPPQ(112, sr, bpm, AV_ROUND_ZERO), 4, "sample 112 -> tick 4 (ZERO)");
    checkEq(RenderClock::sampleToPPQ(113, sr, bpm, AV_ROUND_NEAR_INF), 5, "sample 113 -> tick 5 (NEAR)");

    // The regression the double formula actually had: 44.1 kHz / 60 BPM,
    // sample 745290 is exactly tick 16224 (745290 * 960 == 16224 * 44100).
    checkEq(RenderClock::sampleToPPQ(745290, 44100, 60.0, AV_ROUND_DOWN), 16224,
            "exact boundary 745290 -> 16224, not 16223");
    checkEq(RenderClock::sampleToPPQ(745290, 44100, 60.0, AV_ROUND_ZERO), 16224,
            "exact boundary 745290 -> 16224 (ZERO)");
    checkEq(RenderClock::ppqToSample(536928, 48000, 60.0, AV_ROUND_ZERO), 26846400,
            "exact boundary tick 536928 -> 26846400, not ...399");
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Tick boundaries land on the right sample, and never one block early.
//
//    This is the property pattern-note triggering (MixEngine) and automation
//    playback (AutomationPlan) both rest on:
//      - the first sample at or after tick T floors back to exactly T;
//      - the sample before it floors below T, so a tick is never entered early.
// ─────────────────────────────────────────────────────────────────────────────
static void testBoundaryRoundTrip()
{
    std::fprintf(stderr, "Test 3: tick boundary round-trip\n");

    int64_t sweep = 0, lateFail = 0, earlyFail = 0;
    for (double bpm : kBpms) {
        for (int sr : kRates) {
            for (int64_t t = 0; t < 200000; t += 37) {
                // First sample at or after the tick boundary.
                const int64_t up = RenderClock::ppqToSample(t, sr, bpm, AV_ROUND_UP);
                ++sweep;
                if (RenderClock::sampleToPPQ(up, sr, bpm, AV_ROUND_DOWN) != t) ++lateFail;
                if (up > 0 && RenderClock::sampleToPPQ(up - 1, sr, bpm, AV_ROUND_DOWN) >= t) ++earlyFail;
            }
        }
    }
    std::fprintf(stderr, "  swept %lld boundaries\n", (long long)sweep);
    checkEq(lateFail,  0, "every boundary sample floors back to its own tick");
    checkEq(earlyFail, 0, "no tick is entered one sample early");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. sampleToPPQ is monotonic — a forward-moving transport never sees a tick
//    go backwards, which a drifting double formula can produce.
// ─────────────────────────────────────────────────────────────────────────────
static void testMonotonic()
{
    std::fprintf(stderr, "Test 4: monotonicity\n");

    int64_t regressions = 0;
    for (double bpm : kBpms) {
        for (int sr : kRates) {
            int64_t prev = -1;
            for (int64_t s = 0; s < 4000000; s += 512) {     // 512-sample buffers
                const int64_t t = RenderClock::sampleToPPQ(s, sr, bpm, AV_ROUND_DOWN);
                if (t < prev) ++regressions;
                prev = t;
            }
        }
    }
    checkEq(regressions, 0, "tick never moves backwards over a forward sweep");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. PPQ <-> beats. These stay in the double domain, and ppqToBeats divides
//    rather than multiplying by a pre-rounded 1.0/960.0.
// ─────────────────────────────────────────────────────────────────────────────
static void testBeats()
{
    std::fprintf(stderr, "Test 5: PPQ <-> beats\n");

    checkTrue(RenderClock::ppqToBeats(960)  == 1.0,  "960 ticks == 1.0 beat");
    checkTrue(RenderClock::ppqToBeats(3840) == 4.0,  "3840 ticks == 4.0 beats (one bar)");
    checkTrue(RenderClock::ppqToBeats(480)  == 0.5,  "480 ticks == 0.5 beat");
    checkTrue(RenderClock::ppqToBeats(0)    == 0.0,  "0 ticks == 0.0 beats");

    checkEq(RenderClock::beatsToPPQ(1.0),   960,  "1.0 beat == 960 ticks");
    checkEq(RenderClock::beatsToPPQ(4.0),   3840, "4.0 beats == 3840 ticks");
    checkEq(RenderClock::beatsToPPQ(0.5),   480,  "0.5 beat == 480 ticks");
    checkEq(RenderClock::beatsToPPQ(-1.0), -960,  "-1.0 beat == -960 ticks");

    // Round-trip on tick-aligned beats must be exact, not epsilon-off.
    int64_t rt = 0;
    for (int64_t t = 0; t < 100000; ++t)
        if (RenderClock::beatsToPPQ(RenderClock::ppqToBeats(t)) != t) ++rt;
    checkEq(rt, 0, "ticks -> beats -> ticks is exact");

    // Divide, not multiply-by-reciprocal: 1.0/960.0 is not representable, so
    // the two differ by an ULP on some inputs. ppqToBeats must be the divide.
    int64_t reciprocalDiffs = 0;
    const double recip = 1.0 / 960.0;
    for (int64_t t = 1; t < 2000000; t += 7)
        if (RenderClock::ppqToBeats(t) != static_cast<double>(t) * recip) ++reciprocalDiffs;
    checkTrue(reciprocalDiffs > 0, "ppqToBeats divides (differs from *(1.0/960.0) somewhere)");
    std::fprintf(stderr, "  ppqToBeats differs from *(1.0/960.0) on %lld of ~285714 inputs\n",
                 (long long)reciprocalDiffs);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. sample <-> beats, and the beat -> sample path used by Transport,
//    AudioScheduler and the seek / scrub RPCs.
// ─────────────────────────────────────────────────────────────────────────────
static void testSampleBeats()
{
    std::fprintf(stderr, "Test 6: sample <-> beats\n");

    // 120 BPM / 48 kHz: one beat is exactly 24000 samples.
    checkEq(RenderClock::beatToSample(1.0, 48000, 120.0), 24000, "1 beat == 24000 samples");
    checkEq(RenderClock::beatToSample(0.0, 48000, 120.0), 0,     "beat 0 == sample 0");
    checkTrue(RenderClock::sampleToBeats(24000, 48000, 120.0) == 1.0, "24000 samples == 1 beat");
    checkTrue(RenderClock::sampleToBeats(0, 48000, 120.0) == 0.0,     "sample 0 == beat 0");

    // beatToSample keeps sub-tick resolution — routing it through PPQ would
    // quantize a scrub target to 1/960 beat and visibly move the playhead.
    checkEq(RenderClock::beatToSample(1.0 / 3840.0, 48000, 120.0), 6,
            "a 1/3840-beat scrub offset survives (sub-tick resolution)");

    // Negative / non-finite beats clamp to sample 0.
    checkEq(RenderClock::beatToSample(-4.0, 48000, 120.0), 0, "negative beat clamps to 0");
    checkEq(RenderClock::beatToSample(std::nan(""), 48000, 120.0), 0, "NaN beat -> 0");
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Degenerate inputs return 0 instead of av_rescale's INT64_MIN.
// ─────────────────────────────────────────────────────────────────────────────
static void testGuards()
{
    std::fprintf(stderr, "Test 7: degenerate inputs\n");

    checkEq(RenderClock::sampleToPPQ(48000, 0, 120.0), 0, "sampleToPPQ: sampleRate 0 -> 0");
    checkEq(RenderClock::sampleToPPQ(48000, 48000, 0.0), 0, "sampleToPPQ: bpm 0 -> 0");
    checkEq(RenderClock::sampleToPPQ(48000, 48000, -5.0), 0, "sampleToPPQ: negative bpm -> 0");
    checkEq(RenderClock::ppqToSample(960, 0, 120.0), 0, "ppqToSample: sampleRate 0 -> 0");
    checkEq(RenderClock::ppqToSample(960, 48000, 0.0), 0, "ppqToSample: bpm 0 -> 0");
    checkTrue(RenderClock::sampleToBeats(48000, 48000, 0.0) == 0.0, "sampleToBeats: bpm 0 -> 0");
    checkEq(RenderClock::beatsToPPQ(std::nan("")), 0, "beatsToPPQ: NaN -> 0");
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. AutomationPlan's tick lookup is the same clock, with floor semantics —
//    the export-parity requirement its header documents.
// ─────────────────────────────────────────────────────────────────────────────
static void testAutomationPlanAgrees()
{
    std::fprintf(stderr, "Test 8: AutomationPlan::tickAtSamplePosition\n");

    int64_t mismatches = 0;
    for (double bpm : kBpms) {
        for (int sr : kRates) {
            for (int64_t s = 0; s < 2000000; s += 977) {
                const int64_t a = xleth::automation::tickAtSamplePosition(
                    s, bpm, static_cast<double>(sr));
                const int64_t b = RenderClock::sampleToPPQ(s, sr, bpm, AV_ROUND_DOWN);
                if (a != b) ++mismatches;
            }
        }
    }
    checkEq(mismatches, 0, "tickAtSamplePosition == sampleToPPQ(AV_ROUND_DOWN)");

    checkEq(xleth::automation::tickAtSamplePosition(48000, 0.0, 48000.0), 0, "bpm 0 -> tick 0");
    checkEq(xleth::automation::tickAtSamplePosition(48000, 120.0, 0.0), 0, "sampleRate 0 -> tick 0");
}

int main()
{
    std::fprintf(stderr, "=== test_render_clock ===\n");

    testValidate();
    testRoundingModes();
    testBoundaryRoundTrip();
    testMonotonic();
    testBeats();
    testSampleBeats();
    testGuards();
    testAutomationPlanAgrees();

    std::fprintf(stderr, "\n%d checks, %d failures\n", g_checks, g_failures);
    if (g_failures != 0) {
        std::fprintf(stderr, "TESTS FAILED\n");
        return EXIT_FAILURE;
    }
    std::fprintf(stderr, "ALL TESTS PASSED\n");
    return EXIT_SUCCESS;
}
