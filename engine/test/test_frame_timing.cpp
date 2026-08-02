// test_frame_timing.cpp — time ↔ frame ↔ PTS conversion (engine/src/render/FrameRateMath.h)
//
// Pure arithmetic: no GPU, no media files, no engine core. Guards the fix for
// the depth-proportional video frame desync, in which RenderVideoDecoder built
// its seek target from AVRational{1, (int)round(fps)} — snapping 23.976 to 24 —
// while FrameCollector converted the other direction at the true rate.
//
// NOTE: this file deliberately does NOT use bare assert(). The engine builds
// Release-only with NDEBUG defined, which compiles assert() away entirely and
// makes a test that uses it print "ALL TESTS PASSED" without checking anything
// (see engine/test/test_frame_collector.cpp for the original instance of that
// trap). Every check below runs unconditionally and drives the exit code.

#include "render/FrameRateMath.h"
#include "model/ClipSourceAnchor.h"

#include <cstdio>
#include <cstdint>
#include <cmath>
#include <string>

using namespace xleth::frametiming;

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

// Models RenderVideoDecoder::decodeFrame()'s selection rule: after seeking, it
// walks packets forward and takes the FIRST frame whose pts >= target. That is a
// ceiling, not a rounding, so it is what decides which frame the user actually
// sees when the target is wrong.
static int64_t firstFrameAtOrAfter(int64_t targetPts, AVRational rate,
                                   AVRational timeBase, int64_t startTime)
{
    for (int64_t n = 0; n < 40000; ++n)
        if (frameToPts(n, rate, timeBase, startTime) >= targetPts)
            return n;
    return -1;
}

// ── The reference source under test ──────────────────────────────────────────
// HandBrake H.264 MP4, 33697 frames, verified with ffprobe:
//   r_frame_rate=24000/1001  avg_frame_rate=189545625/7905632
//   time_base=1/90000        start_pts=0  start_time=0
static const AVRational kRate     = {24000, 1001};
static const AVRational kTimeBase = {1, 90000};
static const int64_t    kFrames   = 33697;
static const int64_t    kStart    = 0;

int main()
{
    std::fprintf(stderr, "\n[TEST:FrameTiming] 24000/1001 in time_base 1/90000\n");

    // ── (a) Round trip: ptsToFrame(frameToPts(n)) == n over the whole source ──
    // One frame is 90000 * 1001 / 24000 = 3753.75 ticks — deliberately NOT an
    // integer, which is what makes this conversion easy to get wrong.
    {
        int64_t firstBad = -1;
        for (int64_t n = 0; n < kFrames; ++n) {
            const int64_t pts = frameToPts(n, kRate, kTimeBase, kStart);
            const int64_t rt  = ptsToFrame(pts, kRate, kTimeBase, kStart);
            if (rt != n) { firstBad = n; break; }
        }
        checkEq(firstBad, -1, "(a) round trip exact for all n in 0..33696");
        std::fprintf(stderr, "  [a] round-tripped %lld frames\n", (long long)kFrames);
    }

    // ── (a2) frameToPts reproduces the REAL muxer timestamps ─────────────────
    // Sampled from the actual file with:
    //   ffprobe -select_streams v:0 -show_entries frame=pts -read_intervals "%+#8"
    // The muxer floors the ideal grid: pts_N == floor(N * 3753.75).
    {
        const int64_t realPts[] = {0, 3753, 7507, 11261, 15015, 18768, 22522, 26276, 30030};
        for (int64_t n = 0; n < 9; ++n)
            checkEq(frameToPts(n, kRate, kTimeBase, kStart), realPts[n],
                    ("(a2) frameToPts matches real muxer pts at n=" + std::to_string(n)).c_str());

        // …and still matches deep into the file, i.e. no accumulated drift.
        // Frame 21917 was read back from the real file as pts 82270938.
        checkEq(frameToPts(21917, kRate, kTimeBase, kStart), 82270938,
                "(a2) frameToPts matches real muxer pts at n=21917 (deep, no drift)");
        // Last frame: pts + one frame duration must land on the container duration
        // (1405.445689 s * 90000 = 126490112 ticks, within one tick).
        checkEq(frameToPts(kFrames - 1, kRate, kTimeBase, kStart), 126486360,
                "(a2) frameToPts at last frame 33696");
    }

    // ── (b) Floor semantics ──────────────────────────────────────────────────
    // The region picker is a Chromium <video> element: frame N is the frame whose
    // interval [N/fps, (N+1)/fps) contains t. The engine must agree exactly.
    {
        // The anchor case from the bug report. t*fps = 21980.582…, so the picker
        // shows 21980. Round-to-nearest (the old FrameCollector behaviour via
        // av_rescale's default AV_ROUND_NEAR_INF) would answer 21981.
        checkEq(timeToFrameFloor(916.7734480660205, kRate), 21980,
                "(b) t=916.7734480660205 -> 21980 (floor, not 21981)");

        // The other region exercised at runtime.
        checkEq(timeToFrameFloor(83.7298124630748, kRate), 2007,
                "(b) t=83.7298124630748 -> 2007");

        // t exactly on frame N's start must yield N, not N-1. This is the case a
        // naive floor(t*num/den) gets wrong, because N*1001/24000 is not exactly
        // representable as a double and can land one ulp low.
        int64_t firstBadBoundary = -1;
        for (int64_t n = 0; n < kFrames; ++n) {
            const double tExact = static_cast<double>(n) * kRate.den / kRate.num;
            if (timeToFrameFloor(tExact, kRate) != n) { firstBadBoundary = n; break; }
        }
        checkEq(firstBadBoundary, -1, "(b) exact frame-start time -> N for all n");

        // Just inside a frame stays on that frame; just before the next boundary
        // must not tip over early.
        checkEq(timeToFrameFloor(21980.0 * 1001.0 / 24000.0 + 0.0001, kRate), 21980,
                "(b) just after frame 21980 start stays 21980");
        checkEq(timeToFrameFloor(21981.0 * 1001.0 / 24000.0 - 0.0001, kRate), 21980,
                "(b) just before frame 21981 start stays 21980");

        // Degenerate inputs clamp rather than produce garbage.
        checkEq(timeToFrameFloor(-5.0, kRate), 0, "(b) negative time clamps to 0");
        checkEq(timeToFrameFloor(0.0, kRate), 0, "(b) t=0 -> frame 0");
        checkEq(timeToFrameFloor(std::nan(""), kRate), 0, "(b) NaN clamps to 0");
    }

    // ── (c) The old bug: AVRational{1, round(fps)} diverges by a full frame ───
    // round(23.976023976) == 24, so the old code computed
    //   targetPTS = av_rescale_q(n, {1,24}, {1,90000}) = n * 3750
    // against a true frame spacing of 3753.75 ticks. The 3.75-tick-per-frame
    // deficit reaches a whole frame at n = 3753.75 / 3.75 = 1001 — hence the
    // "error = frameIndex / 1001 frames" curve in the diagnostic.
    {
        const AVRational buggyFrameDur = {1, 24};   // what std::round(23.976) produced
        const int64_t buggyTarget = av_rescale_q(1001, buggyFrameDur, kTimeBase);
        const int64_t trueTarget  = frameToPts(1001, kRate, kTimeBase, kStart);

        checkEq(buggyTarget, 3753750, "(c) old {1,24} target for n=1001");
        checkEq(trueTarget,  3757503, "(c) correct target for n=1001");
        checkEq(trueTarget - buggyTarget, 3753,
                "(c) divergence is exactly one frame duration at n=1001");

        // decodeFrame() accepts the first frame with pts >= target, so the old
        // target lands the decoder on frame 1000 when 1001 was requested.
        checkEq(firstFrameAtOrAfter(buggyTarget, kRate, kTimeBase, kStart), 1000,
                "(c) old target delivers frame 1000 (off by one) for request 1001");
        // The fixed target delivers exactly what was asked for.
        checkEq(firstFrameAtOrAfter(trueTarget, kRate, kTimeBase, kStart), 1001,
                "(c) fixed target delivers frame 1001 for request 1001");

        // At the region-2 depth the same arithmetic is off by 21 frames, matching
        // the -21 predicted in the diagnostic report and measured at runtime
        // (requested 21981 -> delivered 21960).
        const int64_t buggyDeep = av_rescale_q(21980, buggyFrameDur, kTimeBase);
        checkEq(firstFrameAtOrAfter(buggyDeep, kRate, kTimeBase, kStart) - 21980, -21,
                "(c) old math delivers -21 frames at n=21980 (matches measured desync)");
        checkEq(firstFrameAtOrAfter(frameToPts(21980, kRate, kTimeBase, kStart),
                                    kRate, kTimeBase, kStart), 21980,
                "(c) fixed math delivers exactly frame 21980");
    }

    // ── halfFramePts: the decode acceptance tolerance ────────────────────────
    // Must be under a full frame, or the previous frame could satisfy the test.
    {
        // One frame is 3753.75 ticks; av_rescale_q rounds that to 3754, halved to 1877.
        const int64_t half = halfFramePts(kRate, kTimeBase);
        checkEq(half, 1877, "halfFramePts == 1877 (half of 3753.75 ticks)");
        checkTrue(half > 0 && half < 3753,
                  "halfFramePts is a strict fraction of one frame duration");
        // The safety property that matters: the tolerance can never reach back to
        // the PREVIOUS frame, so widening the acceptance test cannot deliver N-1.
        int64_t tolBad = -1;
        for (int64_t n = 1; n < kFrames; ++n) {
            const int64_t target = frameToPts(n, kRate, kTimeBase, kStart);
            if (frameToPts(n - 1, kRate, kTimeBase, kStart) >= target - half) {
                tolBad = n; break;
            }
        }
        checkEq(tolBad, -1, "half-frame tolerance never admits the previous frame");
    }

    // ── start_time is added back on the way out and removed on the way in ────
    {
        const int64_t st = 12345;
        const int64_t pts = frameToPts(500, kRate, kTimeBase, st);
        checkEq(pts, frameToPts(500, kRate, kTimeBase, 0) + st,
                "start_time offsets the seek target");
        checkEq(ptsToFrame(pts, kRate, kTimeBase, st), 500,
                "start_time round trips");
        // AV_NOPTS_VALUE must behave as "no offset", not as a huge number.
        checkEq(frameToPts(500, kRate, kTimeBase, AV_NOPTS_VALUE),
                frameToPts(500, kRate, kTimeBase, 0),
                "AV_NOPTS_VALUE start_time treated as 0");
    }

    // ── chooseFrameRate: r_frame_rate wins over avg_frame_rate ───────────────
    {
        bool fallback = false, vfr = false;
        const AVRational avgReal = {189545625, 7905632};   // the real file's avg
        AVRational got = chooseFrameRate(kRate, avgReal, &fallback, &vfr);
        checkEq(got.num, kRate.num, "chooseFrameRate prefers r_frame_rate (num)");
        checkEq(got.den, kRate.den, "chooseFrameRate prefers r_frame_rate (den)");
        checkTrue(!fallback, "no fallback when r_frame_rate is valid");
        checkTrue(!vfr, "real file's r/avg divergence (0.0016%) is not flagged VFR");

        // Falls back to avg when r_frame_rate is absent.
        got = chooseFrameRate(AVRational{0, 0}, avgReal, &fallback, &vfr);
        checkEq(got.num, avgReal.num, "falls back to avg_frame_rate");
        checkTrue(fallback, "fallback reported when r_frame_rate is invalid");

        // Falls back to 30/1 when neither is usable.
        got = chooseFrameRate(AVRational{0, 0}, AVRational{0, 1}, &fallback, &vfr);
        checkEq(got.num, 30, "final fallback is 30/1 (num)");
        checkEq(got.den, 1,  "final fallback is 30/1 (den)");
        checkTrue(fallback, "fallback reported when neither rate is usable");

        // A genuine VFR-sized divergence IS flagged.
        chooseFrameRate(kRate, AVRational{30, 1}, &fallback, &vfr);
        checkTrue(vfr, ">0.5% r/avg divergence is flagged as VFR-suspect");
    }

    // ── rateFromSource: legacy float-only projects recover the exact rational ─
    {
        AVRational r = rateFromSource(0, 0, 23.976023976023978);
        checkEq(r.num, 24000, "legacy double 23.976023976023978 -> 24000 (num)");
        checkEq(r.den, 1001,  "legacy double 23.976023976023978 -> 1001 (den)");

        r = rateFromSource(24000, 1001, 0.0);
        checkEq(r.num, 24000, "persisted rational is used verbatim (num)");
        checkEq(r.den, 1001,  "persisted rational is used verbatim (den)");

        r = rateFromSource(0, 0, 29.97002997002997);
        checkEq(r.num, 30000, "legacy 29.97 -> 30000 (num)");
        checkEq(r.den, 1001,  "legacy 29.97 -> 1001 (den)");

        r = rateFromSource(0, 0, 0.0);
        checkEq(r.num, 30, "no rate at all -> 30/1");
    }

    // ── Other common rates round-trip too (regression net) ───────────────────
    {
        struct { AVRational rate; AVRational tb; const char* name; } cases[] = {
            {{30000, 1001}, {1, 90000},  "29.97 @ 1/90000"},
            {{60000, 1001}, {1, 90000},  "59.94 @ 1/90000"},
            {{24000, 1001}, {1, 24000},  "23.976 @ 1/24000"},
            {{25, 1},       {1, 12800},  "25 @ 1/12800"},
            {{30, 1},       {1, 15360},  "30 @ 1/15360"},
        };
        for (const auto& c : cases) {
            int64_t firstBad = -1;
            for (int64_t n = 0; n < 20000; ++n) {
                if (ptsToFrame(frameToPts(n, c.rate, c.tb, 0), c.rate, c.tb, 0) != n) {
                    firstBad = n; break;
                }
            }
            checkEq(firstBad, -1, (std::string("round trip: ") + c.name).c_str());

            int64_t firstBadT = -1;
            for (int64_t n = 0; n < 20000; ++n) {
                const double t = static_cast<double>(n) * c.rate.den / c.rate.num;
                if (timeToFrameFloor(t, c.rate) != n) { firstBadT = n; break; }
            }
            checkEq(firstBadT, -1, (std::string("boundary floor: ") + c.name).c_str());
        }
    }

    // ── Clip source anchoring (model/ClipSourceAnchor.h) ─────────────────────
    // Where a clip's playhead starts in the source. The two VideoEvent builders
    // (realtime preview in XlethEngineService, export in OfflineRenderer) and
    // MixEngine's audio readhead must all agree, so the expression lives in one
    // place and is pinned here.
    {
        using xleth::anchoring::clipSourceAnchorSeconds;
        using xleth::anchoring::ticksToSeconds;

        // The reference case that prompted this: region 2 of the EAT project.
        // Its clips carry regionOffsetTicks = 53, a leading-silence trim written
        // by AutoTrimClipCommand — NOT a rounding artifact and NOT related to the
        // region's audio swap (the same region also has clips at 293 ticks, and
        // swappedAudioDurationSec is a per-REGION field that cannot vary per clip).
        const double kRegion2Start = 916.7734480660205;
        const double kBpm = 140.0;

        // An UNTRIMMED clip must anchor exactly at the region start — bit for
        // bit, no epsilon. This is the invariant that makes picker and render
        // agree, and it is what region 40 (regionOffsetTicks = 0) exercises.
        checkTrue(clipSourceAnchorSeconds(kRegion2Start, 0, kBpm) == kRegion2Start,
                  "anchor: regionOffset 0 returns region start exactly");
        checkTrue(clipSourceAnchorSeconds(83.7298124630748, 0, kBpm) == 83.7298124630748,
                  "anchor: region 40 (offset 0) anchors exactly at its start");
        checkEq(timeToFrameFloor(clipSourceAnchorSeconds(83.7298124630748, 0, kBpm), kRate),
                2007, "anchor: region 40 untrimmed -> frame 2007 (== picker)");

        // 53 ticks at 140 BPM is 0.0236607142857 s. Reproduces the measured
        // VideoEvent anchor 916.7971087803062 and the frame it renders.
        const double trimmed = clipSourceAnchorSeconds(kRegion2Start, 53, kBpm);
        checkTrue(std::fabs(trimmed - 916.7971087803062) < 1e-12,
                  "anchor: region 2 + 53 ticks == 916.7971087803062");
        checkEq(timeToFrameFloor(kRegion2Start, kRate), 21980,
                "anchor: region 2 HEAD floors to 21980 (what the picker shows)");
        checkEq(timeToFrameFloor(trimmed, kRate), 21981,
                "anchor: region 2 trimmed clip floors to 21981 (what the timeline renders)");
        // The one-frame gap between those two is the TRIM, not an off-by-one:
        // 53 ticks is 0.567 of a frame at 23.976 fps and the region head sits
        // 0.582 of a frame past 21980's boundary, so the sum crosses into 21981.
        checkTrue(timeToFrameFloor(trimmed, kRate) - timeToFrameFloor(kRegion2Start, kRate) == 1,
                  "anchor: picker/render differ by exactly the trim, not a rounding bug");

        // Syllable term stacks on top of the trim, and the ordering does not
        // matter — this is the term OfflineRenderer used to drop.
        checkTrue(std::fabs(clipSourceAnchorSeconds(kRegion2Start, 53, kBpm, 0.25)
                            - (trimmed + 0.25)) < 1e-12,
                  "anchor: syllable offset stacks on the trim");
        checkTrue(clipSourceAnchorSeconds(100.0, 0, kBpm, 0.0) == 100.0,
                  "anchor: no syllable, no trim is a pure passthrough");

        // Tick conversion matches TickTime::toSeconds(bpm) by construction, and
        // is tempo-dependent BY DESIGN so video tracks MixEngine's audio readhead
        // (which converts the same ticks at the same tempo) at any tempo.
        checkTrue(std::fabs(ticksToSeconds(960, 120.0) - 0.5) < 1e-15,
                  "anchor: 960 ticks @120bpm == 0.5 s");
        checkTrue(std::fabs(ticksToSeconds(53, 140.0) - 0.023660714285714285) < 1e-15,
                  "anchor: 53 ticks @140bpm == 0.0236607142857 s");
        checkTrue(clipSourceAnchorSeconds(500.0, 53, 70.0)
                  > clipSourceAnchorSeconds(500.0, 53, 140.0),
                  "anchor: halving the tempo doubles the trim in seconds");
        // Degenerate tempo must not produce NaN/inf into the frame conversion.
        checkTrue(clipSourceAnchorSeconds(500.0, 53, 0.0) == 500.0,
                  "anchor: bpm 0 degrades to the region start, not NaN");

        // A trim landing EXACTLY on a frame boundary must select that frame, not
        // the one before — the anchoring path feeding timeToFrameFloor's boundary
        // handling. 1001/24000 s is exactly one frame at 24000/1001.
        const double frameDurSec = 1001.0 / 24000.0;
        for (int n = 1; n <= 5; ++n) {
            const double base = 0.0;
            const double t = clipSourceAnchorSeconds(base, 0, kBpm, frameDurSec * n);
            checkEq(timeToFrameFloor(t, kRate), n,
                    "anchor: exact frame-boundary offset selects that frame");
        }
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    std::fprintf(stderr, "\n[TEST:FrameTiming] %d checks, %d failures\n",
                 g_checks, g_failures);
    if (g_failures == 0) {
        std::fprintf(stderr, "[TEST:FrameTiming] ALL TESTS PASSED\n\n");
        return 0;
    }
    std::fprintf(stderr, "[TEST:FrameTiming] FAILED\n\n");
    return 1;
}
