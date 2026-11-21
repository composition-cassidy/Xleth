// test_presentation_clock_smoother.cpp — the preview's continuous audio clock.
// Build: see engine/CMakeLists.txt target "test_presentation_clock_smoother"
// Run:   test_presentation_clock_smoother.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1
//
// The transport position the video thread reads only moves once per audio
// callback. These tests drive PresentationClockSmoother with synthetic callback
// staircases (regular, bursty, seeking, stalling) and check its invariants, then
// close the loop the way the preview's video thread does — wake at the centre of
// the next output frame on the smoothed clock, with wake-up jitter — and require
// a gap-free, repeat-free frame sequence. A negative control runs the OLD scheme
// (raw staircase sampled by an independent fixed-period timer) through the same
// simulation and requires it to repeat and skip, so the cadence test can fail.

#include "render/PresentationClockSmoother.h"

#include <cmath>
#include <cstdint>
#include <iostream>
#include <random>

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                        \
    do {                                                                        \
        if (cond) { ++g_passed; }                                               \
        else { std::cerr << "  FAIL [line " << __LINE__ << "] " << msg << "\n"; \
               ++g_failed; }                                                    \
    } while (0)

namespace {

constexpr int     kSr      = 44100;
constexpr int64_t kBlock   = 441;                               // 10 ms
constexpr int64_t kBlockUs = kBlock * 1000000 / kSr;            // 10000
constexpr int     kFps     = 60;

// Transport position as the video thread sees it at time tUs: the position the
// last completed callback advanced to. `blocksPerWake` > 1 models shared-mode
// WASAPI delivering several blocks per wake-up.
int64_t rawAt(int64_t tUs, int blocksPerWake = 1, int64_t startSamples = 0)
{
    const int64_t wakeUs = kBlockUs * blocksPerWake;
    return startSamples + (tUs / wakeUs) * kBlock * blocksPerWake;
}

// sampleToVideoFrame rounds to the nearest frame (av_rescale_q, NEAR_INF).
int64_t frameOf(int64_t samples)
{
    return static_cast<int64_t>(std::floor(
        static_cast<double>(samples) * kFps / kSr + 0.5));
}

int64_t centreOf(int64_t frame)
{
    return static_cast<int64_t>(std::llround(static_cast<double>(frame) * kSr / kFps));
}

struct Cadence { int published = 0, repeated = 0, skipped = 0; };

void account(Cadence& c, int64_t& last, int64_t frame)
{
    ++c.published;
    if (last >= 0) {
        if (frame == last) ++c.repeated;
        else if (frame > last + 1) c.skipped += static_cast<int>(frame - last - 1);
    }
    last = frame;
}

} // namespace

int main()
{
    // ── 1. Invariants on a regular 10 ms staircase ──────────────────────────
    {
        PresentationClockSmoother clk;
        int64_t prev = -1;
        bool monotonic = true, aboveFloor = true, underLead = true;
        const int64_t maxLead = PresentationClockSmoother::kDefaultMaxLeadUs * kSr / 1000000;
        int64_t worstLagAfterLock = 0;
        for (int64_t t = 3700; t < 5000000; t += 16667) {
            const int64_t raw = rawAt(t);
            const int64_t est = clk.update(raw, t, kSr);
            if (est < prev) monotonic = false;
            if (est < raw) aboveFloor = false;
            if (est > raw + maxLead) underLead = false;
            if (t > 1000000) {
                const int64_t truth = t * kSr / 1000000;
                worstLagAfterLock = std::max<int64_t>(worstLagAfterLock, std::llabs(truth - est));
            }
            prev = est;
        }
        CHECK(monotonic, "estimate never goes backwards on a forward staircase");
        CHECK(aboveFloor, "estimate never below the raw position");
        CHECK(underLead, "estimate never more than maxLead ahead of raw");
        // Locked onto the top edge of the staircase: within one block of truth.
        CHECK(worstLagAfterLock <= kBlock,
              "after lock, |estimate - true position| <= one block (got "
              << worstLagAfterLock << " samples)");
    }

    // ── 2. Bursty wake-ups (two blocks per 20 ms) keep the same invariants ──
    {
        PresentationClockSmoother clk;
        int64_t prev = -1;
        bool ok = true;
        for (int64_t t = 1234; t < 3000000; t += 16667) {
            const int64_t raw = rawAt(t, 2);
            const int64_t est = clk.update(raw, t, kSr);
            if (est < prev || est < raw) ok = false;
            prev = est;
        }
        CHECK(ok, "bursty callbacks: monotonic and never below raw");
    }

    // ── 3. Seek / loop wrap re-anchors to the new position at once ──────────
    {
        PresentationClockSmoother clk;
        for (int64_t t = 0; t < 1000000; t += 16667) clk.update(rawAt(t), t, kSr);
        const uint64_t before = clk.reanchorCount();
        const int64_t t = 1000000;
        const int64_t est = clk.update(88200, t, kSr);   // jumped back to 2.0 s
        CHECK(est == 88200, "backward jump returns the raw position (got " << est << ")");
        CHECK(clk.reanchorCount() == before + 1, "backward jump counts as a re-anchor");
        const int64_t fwd = clk.update(88200 + 10 * kSr, t + 16667, kSr);   // +10 s
        CHECK(fwd == 88200 + 10 * kSr, "forward jump returns the raw position");
    }

    // ── 4. A stalled callback holds the clock at raw + maxLead ──────────────
    {
        PresentationClockSmoother clk;
        int64_t t = 0;
        for (; t < 1000000; t += 16667) clk.update(rawAt(t), t, kSr);
        const int64_t frozen = rawAt(t);
        int64_t est = 0;
        for (int i = 0; i < 30; ++i, t += 16667) est = clk.update(frozen, t, kSr);
        const int64_t maxLead = PresentationClockSmoother::kDefaultMaxLeadUs * kSr / 1000000;
        CHECK(est == frozen + maxLead,
              "stalled audio: video holds at raw + maxLead (got " << est - frozen << ")");
    }

    // ── 5. Closed loop: centre-of-frame wake-ups give a perfect cadence ─────
    // Mirrors videoThreadBody: sample the smoothed clock, publish frameOf(it),
    // then sleep until the smoothed clock reaches the centre of the next frame,
    // woken with up to ±1.5 ms of scheduler jitter.
    {
        std::mt19937 rng(1234);
        std::uniform_int_distribution<int> jitter(-1500, 1500);
        for (int blocksPerWake : { 1, 2 }) {
            PresentationClockSmoother clk;
            Cadence c;
            int64_t last = -1;
            int64_t t = 5321;
            while (t < 20000000) {
                const int64_t est = clk.update(rawAt(t, blocksPerWake), t, kSr);
                const int64_t frame = frameOf(est);
                if (t > 1000000) account(c, last, frame);   // after lock-on
                const int64_t wait = clk.usUntil(centreOf(frame + 1), est);
                t += std::max<int64_t>(1000, wait) + jitter(rng);
            }
            CHECK(c.published > 1000, "closed loop published frames");
            CHECK(c.repeated == 0 && c.skipped == 0,
                  "smoothed + centre-paced (" << blocksPerWake << " block/wake): "
                  << c.repeated << " repeated, " << c.skipped << " skipped of "
                  << c.published);
        }
    }

    // ── 6. Negative control: the old scheme repeats and skips ───────────────
    {
        std::mt19937 rng(1234);
        std::uniform_int_distribution<int> jitter(-1500, 1500);
        Cadence c;
        int64_t last = -1;
        for (int64_t t = 5321; t < 20000000; t += 16667 + jitter(rng)) {
            const int64_t frame = frameOf(rawAt(t));   // raw staircase, fixed timer
            if (t > 1000000) account(c, last, frame);
        }
        CHECK(c.repeated > 0 && c.skipped > 0,
              "negative control: raw staircase + fixed timer does repeat ("
              << c.repeated << ") and skip (" << c.skipped << ")");
    }

    std::cout << "PresentationClockSmoother: " << g_passed << " passed, "
              << g_failed << " failed\n";
    if (g_failed) { std::cout << "FAILED: see above\n"; return 1; }
    std::cout << "ALL TESTS PASSED\n";
    return 0;
}
