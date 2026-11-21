// test_loop_region.cpp — Phase 1 self-verification for the LoopRegion data model
// + the live playback loop trap state machine.
// Build: see engine/CMakeLists.txt target "test_loop_region"
// Run:   test_loop_region.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1

#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "commands/TimelineCommands.h"
#include "commands/UndoManager.h"
#include "audio/LoopTrap.h"
#include "render/RenderClock.h"

#include <iostream>

// ─── Minimal test harness ─────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                  \
    do {                                                                  \
        if (cond) { ++g_passed; }                                         \
        else { std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; \
               ++g_failed; }                                              \
    } while (0)

// Convenience: advance a position via the pure trap and report new pos + armed.
static int64_t advance(int64_t pos, int n, bool& armed,
                       int64_t s, int64_t e, bool enabled) {
    return xleth::loopAdvance(pos, n, armed, s, e, enabled);
}

// ─── 1. Normalization / defaults / invariants ─────────────────────────────────

static void testNormalization() {
    std::cout << "[1] LoopRegion normalization / defaults\n";

    LoopRegion def;
    CHECK(def.endTick > def.startTick, "default endTick > startTick");
    CHECK(def.loopEnabled == false, "default loopEnabled false");
    CHECK(def.renderOrigin == LoopRegion::RenderOrigin::Absolute, "default renderOrigin absolute");
    CHECK(def.tailMode == LoopRegion::TailMode::TailClamp, "default tailMode tailClamp");
    CHECK(def.tailThresholdDb == -60.0, "default tailThresholdDb -60");
    CHECK(def.tailMaxSeconds == 10.0, "default tailMaxSeconds 10");

    // endTick > startTick invariant — zero/negative length forced apart.
    {
        LoopRegion r; r.startTick = 1000; r.endTick = 1000;     // zero length
        LoopRegion n = normalizeLoopRegion(r, 1);
        CHECK(n.endTick == 1001 && n.startTick == 1000, "zero-length → +1 tick floor");
    }
    {
        LoopRegion r; r.startTick = 2000; r.endTick = 500;      // negative length
        LoopRegion n = normalizeLoopRegion(r, 1);
        CHECK(n.endTick == 2001, "negative-length → +1 tick floor");
    }

    // Snap-on min length (1 snap unit). 1/16 = 240 ticks @ 960 PPQ.
    {
        LoopRegion r; r.startTick = 0; r.endTick = 10;          // below snap unit
        LoopRegion n = normalizeLoopRegion(r, 240);
        CHECK(n.endTick - n.startTick == 240, "snap-on min length = 1 snap unit (240)");
    }
    // Snap-off min length (1 tick).
    {
        LoopRegion r; r.startTick = 0; r.endTick = 0;
        LoopRegion n = normalizeLoopRegion(r, 1);
        CHECK(n.endTick - n.startTick == 1, "snap-off min length = 1 tick");
    }
    // startTick clamped to >= 0.
    {
        LoopRegion r; r.startTick = -50; r.endTick = 100;
        LoopRegion n = normalizeLoopRegion(r, 1);
        CHECK(n.startTick == 0, "negative startTick clamped to 0");
    }
}

// ─── 2. Mutation layer enforces invariants (Timeline + UndoManager) ───────────

static void testMutationLayer() {
    std::cout << "[2] Mutation layer (Timeline::setLoopRegion + UndoManager)\n";

    Timeline tl;
    UndoManager um;

    // Body move preserves length: start 0 len 480 → start 960, end 1440.
    {
        LoopRegion r; r.startTick = 960; r.endTick = 1440; r.loopEnabled = false;
        um.execute(std::make_unique<SetLoopRegionCommand>(r, 240, tl), tl);
        const LoopRegion& cur = tl.getLoopRegion();
        CHECK(cur.startTick == 960 && cur.endTick == 1440, "body region stored verbatim");
        CHECK(cur.endTick - cur.startTick == 480, "length preserved (480)");
    }

    // Disabled-but-adjustable: mutate a disabled region's edges.
    {
        LoopRegion r = tl.getLoopRegion();
        r.endTick = 2000; r.loopEnabled = false;
        um.execute(std::make_unique<SetLoopRegionCommand>(r, 240, tl), tl);
        CHECK(tl.getLoopRegion().endTick == 2000, "disabled region edge adjustable");
        CHECK(tl.getLoopRegion().loopEnabled == false, "still disabled");
    }

    // Toggle loopEnabled via UndoManager mutation, undo restores.
    {
        LoopRegion before = tl.getLoopRegion();
        LoopRegion r = before; r.loopEnabled = true;
        um.execute(std::make_unique<SetLoopRegionCommand>(r, 1, tl), tl);
        CHECK(tl.getLoopRegion().loopEnabled == true, "toggle on via command");
        CHECK(um.undo(tl), "undo returns true");
        CHECK(tl.getLoopRegion().loopEnabled == before.loopEnabled, "undo restores loopEnabled");
        CHECK(um.redo(tl), "redo returns true");
        CHECK(tl.getLoopRegion().loopEnabled == true, "redo re-applies toggle");
    }

    // Zero/negative length is unreachable through the mutation layer.
    {
        LoopRegion r; r.startTick = 5000; r.endTick = 5000;
        um.execute(std::make_unique<SetLoopRegionCommand>(r, 240, tl), tl);
        const LoopRegion& cur = tl.getLoopRegion();
        CHECK(cur.endTick > cur.startTick, "mutation layer forbids zero length");
        CHECK(cur.endTick - cur.startTick >= 240, "mutation layer applies snap min length");
    }
}

// ─── 3. renderScoped derived, never persisted ─────────────────────────────────

static void testRenderScopedDerived() {
    std::cout << "[3] renderScoped derived, not persisted\n";

    Timeline tl;
    LoopRegion r; r.loopEnabled = true; r.startTick = 0; r.endTick = 960;
    tl.setLoopRegion(r, 1);
    CHECK(tl.isRenderScoped() == true, "renderScoped == loopEnabled (true)");

    r.loopEnabled = false;
    tl.setLoopRegion(r, 1);
    CHECK(tl.isRenderScoped() == false, "renderScoped == loopEnabled (false)");

    // toJSON must NOT contain a stored renderScoped key under loopRegion.
    auto j = tl.toJSON();
    CHECK(j.contains("loopRegion"), "loopRegion serialized");
    CHECK(!j["loopRegion"].contains("renderScoped"), "renderScoped NOT persisted");

    // Round-trip: load a project with loopEnabled true and confirm derived again.
    r.loopEnabled = true; tl.setLoopRegion(r, 1);
    auto j2 = tl.toJSON();
    Timeline tl2;
    CHECK(tl2.fromJSON(j2), "fromJSON round-trip ok");
    CHECK(tl2.getLoopRegion().loopEnabled == true, "loopEnabled round-trips");
    CHECK(tl2.isRenderScoped() == true, "renderScoped re-derived after load");
}

// ─── 4. Playback trap state machine (pure LoopTrap) ───────────────────────────

static void testPlaybackTrap() {
    std::cout << "[4] Playback trap state machine\n";

    const int64_t S = 1000;   // loop start (samples)
    const int64_t E = 2000;   // loop end
    const int N = 256;        // buffer

    // start-inside arms immediately (play/seek event, keepLatch=false).
    CHECK(xleth::loopArmOnEvent(false, false, 1500, S, E, true) == true,
          "start inside [S,E) arms immediately");
    // start exactly at start is inside.
    CHECK(xleth::loopArmOnEvent(false, false, S, S, E, true) == true,
          "start == S arms (half-open inside)");
    // start exactly at end is OUTSIDE (half-open).
    CHECK(xleth::loopArmOnEvent(false, false, E, S, E, true) == false,
          "start == E is outside (half-open)");

    // start-outside (before region): plays linearly until entry, then arms.
    {
        bool armed = xleth::loopArmOnEvent(false, false, 100, S, E, true);
        CHECK(armed == false, "start before region: not armed on play");
        int64_t pos = 100;
        // Advance until we reach the region; out-of-bounds is never blocked.
        bool blockedBefore = false;
        while (pos + N < S) {
            int64_t np = advance(pos, N, armed, S, E, true);
            if (np != pos + N) blockedBefore = true;  // any clamp = blocked
            pos = np;
            CHECK(!armed, "stays disarmed while still before region");
        }
        CHECK(!blockedBefore, "out-of-bounds playback before entry never blocked");
        // One more buffer crosses into the region → arms.
        pos = advance(pos, N, armed, S, E, true);
        CHECK(armed, "natural entry arms the trap");
        CHECK(pos >= S && pos < E, "post-entry position lands inside region");
    }

    // start-after region: plays linearly, never jumps backward, never arms.
    {
        bool armed = xleth::loopArmOnEvent(false, false, 5000, S, E, true);
        CHECK(armed == false, "start after region: not armed");
        int64_t pos = 5000;
        for (int i = 0; i < 10; ++i) {
            int64_t np = advance(pos, N, armed, S, E, true);
            CHECK(np == pos + N, "after-region playback advances linearly (no backward jump)");
            CHECK(!armed, "after-region never arms");
            pos = np;
        }
    }

    // once armed, reaching end jumps back to start (carry remainder).
    {
        bool armed = true;
        int64_t pos = E - 100;          // 100 samples before end
        int64_t np = advance(pos, N, armed, S, E, true);
        // overshoot = (E-100+256) - E = 156 → wraps to S + 156.
        // NOTE: this is loopAdvance in isolation. Callers must NOT hand it a
        // block that straddles the seam — the carried overshoot then names a
        // range [S, S+156) that no render covers. Split first: see testSeamSplit.
        CHECK(np == S + 156, "wrap carries overshoot remainder (S+156)");
        CHECK(armed, "stays armed after wrap");
        CHECK(np >= S && np < E, "wrapped position inside region");
    }

    // drag/shrink during playback disarms if playhead becomes outside.
    {
        // armed, playing at 1500. Region shrinks to [1000, 1200): 1500 now outside.
        bool armed = xleth::loopArmOnEvent(true, /*keepLatch*/ true, 1500, 1000, 1200, true);
        CHECK(armed == false, "shrink past playhead disarms (no yank)");
        // Shrink that still contains the playhead keeps it armed.
        bool armed2 = xleth::loopArmOnEvent(true, true, 1100, 1000, 1200, true);
        CHECK(armed2 == true, "shrink still containing playhead stays armed");
    }

    // toggle off mid-loop releases the trap (enabled=false → linear).
    {
        bool armed = true;
        int64_t pos = E - 10;
        int64_t np = advance(pos, N, armed, S, E, /*enabled*/ false);
        CHECK(np == pos + N, "loop disabled → linear advance past end (trap released)");
        // And the discrete event recompute disarms.
        CHECK(xleth::loopArmOnEvent(true, true, pos, S, E, false) == false,
              "disabling loop disarms latch");
    }

    // seek inside keeps armed; seek outside disarms until re-entry.
    {
        CHECK(xleth::loopArmOnEvent(true, false, 1500, S, E, true) == true,
              "seek inside stays armed");
        bool armed = xleth::loopArmOnEvent(true, false, 100, S, E, true);
        CHECK(armed == false, "seek outside (before) disarms");
        // Re-entry by natural advance re-arms.
        int64_t pos = 100;
        while (pos < S) pos = advance(pos, N, armed, S, E, true);
        CHECK(armed == true, "natural re-entry re-arms after seek-outside");

        CHECK(xleth::loopArmOnEvent(true, false, 9000, S, E, true) == false,
              "seek outside (after) disarms");
    }

    // disabled region: advance is always a plain linear step (no trap effect).
    {
        bool armed = false;
        int64_t pos = 1500;
        int64_t np = advance(pos, N, armed, S, E, false);
        CHECK(np == pos + N && !armed, "disabled region: pure linear advance, no arm");
    }
}

// ─── 5. Seam split — the wrap must not skip the head of the region ────────────
//
// Regression guard for "pattern notes on the loop-start tick never sound".
// loopAdvance carries the overshoot across the seam, so a caller that renders a
// whole device buffer and wraps afterwards resumes at (S + overshoot) and never
// renders [S, S + overshoot). loopSamplesUntilWrap exists to split the buffer at
// the seam so that gap cannot open.

static void testSeamSplit() {
    std::cout << "[5] seam split — no sample of the region goes unrendered\n";

    // Loop length deliberately NOT a multiple of the buffer size, so every lap
    // produces a non-zero overshoot — exactly the case that dropped notes.
    const int64_t S = 1000, E = 4321;   // len 3321, buffer 256 → overshoot != 0
    const int     N = 256;
    const int     kBuffers = 200;

    // ── Split render loop, mirroring AudioEngine::audioDeviceIOCallback ──────
    {
        bool    armed         = xleth::loopArmOnEvent(false, false, S, S, E, true);
        int64_t pos           = S;
        int64_t totalRendered = 0;
        int64_t prevEnd       = -1;
        int     seams         = 0;
        int     laps          = 0;
        int     hitsOnS       = 0;
        bool    chunkInRange  = true;
        bool    contiguous    = true;
        bool    stayedInside  = true;

        CHECK(armed, "starting on the loop start arms the trap");

        for (int buf = 0; buf < kBuffers; ++buf) {
            int remaining = N;
            while (remaining > 0) {
                const int chunk =
                    xleth::loopSamplesUntilWrap(pos, remaining, armed, S, E, true);
                if (chunk < 1 || chunk > remaining) { chunkInRange = false; break; }

                const int64_t winStart = pos;
                const int64_t winEnd   = pos + chunk;

                // A note sitting exactly on the loop start must fall inside a
                // rendered window — this is the user-visible symptom.
                if (winStart <= S && S < winEnd) ++hitsOnS;
                if (winStart < S || winEnd > E)  stayedInside = false;

                if (prevEnd >= 0 && winStart != prevEnd) {
                    // The ONLY permitted discontinuity is the seam itself, and
                    // it must be exactly E → S (no overshoot carried across).
                    if (prevEnd == E && winStart == S) ++seams;
                    else                               contiguous = false;
                }

                prevEnd        = winEnd;
                totalRendered += chunk;

                const int64_t next = xleth::loopAdvance(pos, chunk, armed, S, E, true);
                if (next < pos) ++laps;      // counted independently of `seams`
                pos = next;
                remaining -= chunk;
            }
        }

        CHECK(chunkInRange, "chunk is always in [1, remaining] (no stall, no overrun)");
        CHECK(totalRendered == int64_t(kBuffers) * N,
              "every requested sample is rendered exactly once");
        CHECK(contiguous, "the only discontinuity is the seam, and it is exactly E -> S");
        CHECK(stayedInside, "no sub-block renders outside [S, E) once armed");
        CHECK(laps > 0, "the simulation actually crossed the seam");
        CHECK(seams == laps, "every lap produced an exact E -> S seam");
        // The user-visible symptom, stated against the lap count so it cannot
        // pass vacuously when the split is removed (laps still happen; the
        // rendered windows just stop covering S).
        CHECK(hitsOnS == laps + 1,
              "the loop-start sample is rendered on the first pass and on every lap");
    }

    // ── Contrast: the un-split, block-granular wrap (the bug) ────────────────
    {
        bool    armed  = true;
        int64_t pos    = S;
        int     laps   = 0;
        int     gapped = 0;

        for (int buf = 0; buf < kBuffers; ++buf) {
            const int64_t np = xleth::loopAdvance(pos, N, armed, S, E, true);
            if (np < pos) {           // wrapped this buffer
                ++laps;
                // np > S means [S, np) was rendered by no buffer at all.
                if (np > S) ++gapped;
            }
            pos = np;
        }

        CHECK(laps > 0, "un-split simulation crossed the seam");
        CHECK(gapped == laps,
              "un-split wrap skips the head of the region on EVERY lap (the bug)");
    }

    // Degenerate window shorter than one buffer still yields forward progress.
    {
        const int64_t s2 = 100, e2 = 164;   // 64 samples, buffer 256
        bool    armed = true;
        int64_t pos   = s2;
        bool    progresses = true;
        for (int i = 0; i < 32; ++i) {
            const int chunk = xleth::loopSamplesUntilWrap(pos, N, armed, s2, e2, true);
            if (chunk < 1 || chunk > N) { progresses = false; break; }
            pos = xleth::loopAdvance(pos, chunk, armed, s2, e2, true);
        }
        CHECK(progresses, "sub-buffer-length region: chunk stays in [1, N] (no stall)");
    }

    // No wrap this block → the full request is returned untouched.
    {
        CHECK(xleth::loopSamplesUntilWrap(S, N, true, S, E, true) == N,
              "block that does not reach the seam is not split");
        CHECK(xleth::loopSamplesUntilWrap(E - N, N, true, S, E, true) == N,
              "block ending exactly ON the seam is not split (wrap lands on S anyway)");
        CHECK(xleth::loopSamplesUntilWrap(E - 100, N, true, S, E, true) == 100,
              "block crossing the seam splits at the seam");
        CHECK(xleth::loopSamplesUntilWrap(100, N, false, S, E, false) == N,
              "trap disabled → never split");
        CHECK(xleth::loopSamplesUntilWrap(100, N, false, S, S, true) == N,
              "degenerate window → never split");
        CHECK(xleth::loopSamplesUntilWrap(9000, N, false, S, E, true) == N,
              "playing past the region (never armed) → never split");
    }
}

// ─── 6. Loop bounds and note dispatch must share one tick->sample domain ──────
//
// Transport's bounds come from RenderClock::ppqToSample on the LoopRegion ticks;
// MixEngine::triggerPatternNotes resolves a note tick the same way and then
// applies a half-open [bufferStart, bufferEnd) sample-membership filter. If the
// two use different rounding, a note ON the loop-start tick can resolve one
// sample BEFORE loopStartSamples — and is then dropped on every lap even with a
// perfectly split seam. Both sides must use AV_ROUND_ZERO.

static void testBoundRoundingMatchesNoteDispatch() {
    std::cout << "[6] loop bounds share the note-dispatch tick->sample rounding\n";

    const int     srs[]   = {44100, 48000};
    const double  bpms[]  = {120.0, 140.0, 128.0, 174.0, 93.5};
    const int64_t ticks[] = {0, 960, 2400, 3840, 7680, 15360, 61440};

    bool boundEverPastNote = false;   // the failure the old rounding produced
    bool zeroAlwaysMatches = true;

    for (int sr : srs)
        for (double bpm : bpms)
            for (int64_t t : ticks) {
                // What MixEngine::triggerPatternNotes computes for a note here.
                const int64_t noteSample =
                    RenderClock::ppqToSample(t, sr, bpm, AV_ROUND_ZERO);
                // What syncTransportLoopFromTimeline now publishes as the bound.
                const int64_t boundZero =
                    RenderClock::ppqToSample(t, sr, bpm, AV_ROUND_ZERO);
                // What it used to publish (RenderClock's half-away default).
                const int64_t boundHalfAway = RenderClock::ppqToSample(t, sr, bpm);

                if (boundZero != noteSample)    zeroAlwaysMatches = false;
                if (boundHalfAway > noteSample) boundEverPastNote = true;
            }

    CHECK(zeroAlwaysMatches,
          "AV_ROUND_ZERO bound == note sample for every tick/bpm/rate tested");
    CHECK(boundEverPastNote,
          "half-away rounding DID push the bound past the note (this test has teeth)");

    // The invariant that actually matters, stated directly: a note on the
    // loop-start tick must not resolve before the loop-start sample, or the
    // half-open membership filter discards it.
    {
        const int     sr  = 48000;
        const double  bpm = 93.5;
        const int64_t startTick = 15360;   // bar 5 @ 960 PPQ
        const int64_t S = RenderClock::ppqToSample(startTick, sr, bpm, AV_ROUND_ZERO);
        const int64_t noteSample =
            RenderClock::ppqToSample(startTick, sr, bpm, AV_ROUND_ZERO);
        CHECK(noteSample >= S, "note on the loop-start tick is not before loopStartSamples");
        CHECK(noteSample == S, "note on the loop-start tick lands exactly on the seam");
    }
}

int main() {
    std::cout << "── test_loop_region ──────────────────────────────────────\n";
    testNormalization();
    testMutationLayer();
    testRenderScopedDerived();
    testPlaybackTrap();
    testSeamSplit();
    testBoundRoundingMatchesNoteDispatch();

    std::cout << "──────────────────────────────────────────────────────────\n";
    std::cout << "Passed: " << g_passed << "  Failed: " << g_failed << "\n";
    if (g_failed == 0) {
        std::cout << "ALL TESTS PASSED\n";
        return 0;
    }
    std::cout << "FAILED: " << g_failed << " checks\n";
    return 1;
}
