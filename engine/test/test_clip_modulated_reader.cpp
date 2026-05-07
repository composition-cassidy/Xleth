// test_clip_modulated_reader.cpp — Phase C
//
// Self-verification for the per-clip vibrato audio reader. Drives the reader
// with synthetic in-memory PCM (a unit ramp, so the output sample value
// directly reveals the source position used) and asserts the integrated read
// position matches expectations.
//
// Build: see engine/CMakeLists.txt target "test_clip_modulated_reader"
// Run:   test_clip_modulated_reader(.exe)
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints failures and exits 1

#include "audio/ClipModulatedReader.h"
#include "audio/ClipVibratoIntegrator.h"
#include "model/ClipModulationCompatibility.h"
#include "model/ClipModulationEvaluator.h"
#include "model/TimelineTypes.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>

using xleth::audio::ClipModulatedReader;
using xleth::audio::VibratoSourceOffsetParams;
using xleth::audio::computeVibratoIntegratedSourceOffsetSamples;

// ─── Minimal test harness ─────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                        \
    do {                                                                        \
        if (cond) {                                                             \
            ++g_passed;                                                         \
        } else {                                                                \
            std::cerr << "  FAIL [line " << __LINE__ << "] " << (msg) << "\n"; \
            ++g_failed;                                                         \
        }                                                                       \
    } while (0)

#define CHECK_NEAR(a, b, tol, msg) \
    CHECK(std::abs((double)(a) - (double)(b)) < (tol), msg)

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Mono ramp: src[i] = i (so a Hermite read at integer i returns ~i).
// Length 16 384 samples is enough for any clip used here.
static juce::AudioBuffer<float> makeRampBuffer(int n = 16384, int channels = 1)
{
    juce::AudioBuffer<float> buf(channels, n);
    for (int ch = 0; ch < channels; ++ch)
        for (int i = 0; i < n; ++i)
            buf.setSample(ch, i, static_cast<float>(i));
    return buf;
}

// Build a Clip with sane defaults; modulation + reverse / stretch fields are
// filled by the caller.
static Clip makeClip(int id, int64_t lengthSamples)
{
    Clip c;
    c.id            = id;
    c.trackId       = 1;
    c.regionId      = 1;
    c.position      = TickTime{0};
    c.duration      = TickTime{static_cast<int64_t>(lengthSamples)}; // ticks not used by reader
    c.regionOffset  = TickTime{0};
    c.velocity      = 1.0f;
    c.pitchOffset   = 0;
    c.pitchOffsetCents = 0;
    c.reversed      = false;
    c.stretchRatio  = 1.0;
    c.fadeInPercent = 0.0f;
    c.fadeOutPercent = 0.0f;
    return c;
}

static ClipModulatedReader::BlockParams makeParams(
        const juce::AudioBuffer<float>& src,
        const Clip& clip,
        int64_t bufStart,
        int numOutputSamples,
        int64_t clipLengthSamples,
        double sampleRate = 48000.0,
        double bpm = 120.0)
{
    ClipModulatedReader::BlockParams p {};
    p.srcBuf              = &src;
    p.regionOffsetSamples = 0;
    p.clipStartSample     = 0;
    p.clipEndSample       = clipLengthSamples;
    p.bufStart            = bufStart;
    p.numOutputSamples    = numOutputSamples;
    p.bpm                 = bpm;
    p.sampleRate          = sampleRate;
    p.pitchOffsetSemis    = clip.pitchOffset;
    p.pitchOffsetCents    = clip.pitchOffsetCents;
    p.fadeInSamples       = 0;
    p.fadeOutSamples      = 0;
    p.fadeInLUT           = nullptr;
    p.fadeOutLUT          = nullptr;
    p.clipBoundaryFadeN   = 0;
    p.velocity            = clip.velocity;
    p.modulation          = &clip.modulation;
    return p;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

static void test01_disabledModulation_passthroughAtUnitRatio()
{
    std::cout << "\n[01] modulation top-level disabled -> unit-ratio passthrough\n";

    auto src = makeRampBuffer();
    Clip c = makeClip(1, 1024);
    c.modulation.enabled = false;
    c.modulation.vibrato.enabled = true;          // vibrato flag alone shouldn't matter
    c.modulation.vibrato.depthCents = 100.0f;

    juce::AudioBuffer<float> trackBuf(2, 64);
    trackBuf.clear();

    ClipModulatedReader reader;
    auto p = makeParams(src, c, /*bufStart*/0, /*numOut*/64, /*clipLen*/1024);
    reader.renderBlock(p, trackBuf, c.id);

    // With ratio == 1, sample[s] should equal source[s] = s.
    CHECK_NEAR(trackBuf.getSample(0,  0),  0.0, 1e-3, "out[0]  ~ 0");
    CHECK_NEAR(trackBuf.getSample(0,  8),  8.0, 1e-3, "out[8]  ~ 8");
    CHECK_NEAR(trackBuf.getSample(0, 32), 32.0, 1e-3, "out[32] ~ 32");
    CHECK_NEAR(trackBuf.getSample(1, 32), 32.0, 1e-3, "out[32] R = L (mono broadcast)");
}

static void test02_vibratoEnabledDepthZero_passthrough()
{
    std::cout << "\n[02] vibrato enabled, depth 0 -> unit-ratio passthrough\n";

    auto src = makeRampBuffer();
    Clip c = makeClip(2, 1024);
    c.modulation.enabled = true;
    c.modulation.vibrato.enabled = true;
    c.modulation.vibrato.depthCents = 0.0f;       // no modulation applied
    c.modulation.vibrato.rateHz = 5.0f;
    c.modulation.vibrato.shape = ClipModulation::Vibrato::Shape::Sine;

    juce::AudioBuffer<float> trackBuf(2, 64);
    trackBuf.clear();

    ClipModulatedReader reader;
    auto p = makeParams(src, c, 0, 64, 1024);
    reader.renderBlock(p, trackBuf, c.id);

    CHECK_NEAR(trackBuf.getSample(0,  0),  0.0, 1e-3, "out[0]  ~ 0");
    CHECK_NEAR(trackBuf.getSample(0, 16), 16.0, 1e-3, "out[16] ~ 16");
    CHECK_NEAR(trackBuf.getSample(0, 63), 63.0, 1e-3, "out[63] ~ 63");
}

static void test03_staticPitch1200Cents_doublesReadStride()
{
    std::cout << "\n[03] +1200 cents (one octave) -> source advances 2x per output sample\n";

    auto src = makeRampBuffer();
    Clip c = makeClip(3, 4096);
    c.pitchOffset      = 12;   // +12 semitones = +1200 cents
    c.pitchOffsetCents = 0;
    c.modulation.enabled = true;
    c.modulation.vibrato.enabled = true;
    c.modulation.vibrato.depthCents = 0.0f;       // pure static pitch

    juce::AudioBuffer<float> trackBuf(2, 100);
    trackBuf.clear();

    ClipModulatedReader reader;
    auto p = makeParams(src, c, 0, 100, 4096);
    reader.renderBlock(p, trackBuf, c.id);

    // ratio = 2, so output[s] should equal source[2s] = 2s.
    CHECK_NEAR(trackBuf.getSample(0,  0),   0.0, 1e-3, "out[0]  ~ 0");
    CHECK_NEAR(trackBuf.getSample(0, 10),  20.0, 1e-3, "out[10] ~ 20");
    CHECK_NEAR(trackBuf.getSample(0, 50), 100.0, 1e-3, "out[50] ~ 100");
}

static void test04_zeroCentVibratoStillUnitOnAverage()
{
    std::cout << "\n[04] vibrato depth 0 cents -> identical regardless of shape/rate\n";

    auto src = makeRampBuffer();

    Clip a = makeClip(11, 1024);
    a.modulation.enabled = true;
    a.modulation.vibrato.enabled = true;
    a.modulation.vibrato.depthCents = 0.0f;
    a.modulation.vibrato.rateHz = 5.0f;
    a.modulation.vibrato.shape = ClipModulation::Vibrato::Shape::Sine;

    Clip b = makeClip(12, 1024);
    b.modulation.enabled = true;
    b.modulation.vibrato.enabled = true;
    b.modulation.vibrato.depthCents = 0.0f;
    b.modulation.vibrato.rateHz = 17.0f;
    b.modulation.vibrato.shape = ClipModulation::Vibrato::Shape::Triangle;

    juce::AudioBuffer<float> ta(2, 64), tb(2, 64);
    ta.clear(); tb.clear();
    ClipModulatedReader r1, r2;
    r1.renderBlock(makeParams(src, a, 0, 64, 1024), ta, a.id);
    r2.renderBlock(makeParams(src, b, 0, 64, 1024), tb, b.id);

    bool same = true;
    for (int s = 0; s < 64; ++s)
        if (std::abs(ta.getSample(0, s) - tb.getSample(0, s)) > 1e-4f) { same = false; break; }
    CHECK(same, "depth=0 produces identical output regardless of shape/rate");
}

static void test05_blockSizeInvariance()
{
    std::cout << "\n[05] block-size invariance: 1x256 == 8x32\n";

    auto src = makeRampBuffer();

    Clip c = makeClip(20, 8192);
    c.pitchOffset      = 2;     // +200 cents
    c.pitchOffsetCents = 35;    // +35 cents
    c.modulation.enabled = true;
    c.modulation.vibrato.enabled = true;
    c.modulation.vibrato.depthCents = 40.0f;
    c.modulation.vibrato.rateHz     = 6.0f;
    c.modulation.vibrato.shape      = ClipModulation::Vibrato::Shape::Sine;

    // Reference: one big block.
    juce::AudioBuffer<float> ref(2, 256);
    ref.clear();
    {
        ClipModulatedReader rr;
        auto p = makeParams(src, c, 0, 256, 8192);
        rr.renderBlock(p, ref, c.id);
        rr.markClipSeen(c.id);
        rr.resetUnseenStates();
    }

    // Test: 8 blocks of 32 samples each, sharing one reader (state persists).
    juce::AudioBuffer<float> chunked(2, 256);
    chunked.clear();
    {
        ClipModulatedReader rr;
        for (int blk = 0; blk < 8; ++blk)
        {
            const int64_t bufStart = static_cast<int64_t>(blk) * 32;
            // Render the 32-sample window into a temp buffer, then copy into chunked.
            juce::AudioBuffer<float> tmp(2, 32);
            tmp.clear();
            auto p = makeParams(src, c, bufStart, 32, 8192);
            rr.renderBlock(p, tmp, c.id);
            rr.markClipSeen(c.id);
            rr.resetUnseenStates();
            for (int s = 0; s < 32; ++s)
            {
                chunked.setSample(0, blk * 32 + s, tmp.getSample(0, s));
                chunked.setSample(1, blk * 32 + s, tmp.getSample(1, s));
            }
        }
    }

    bool match = true;
    int  firstMismatch = -1;
    for (int s = 0; s < 256; ++s)
    {
        if (std::abs(ref.getSample(0, s) - chunked.getSample(0, s)) > 1e-4f)
        {
            match = false;
            firstMismatch = s;
            break;
        }
    }
    if (!match)
        std::cerr << "    first mismatch at sample " << firstMismatch
                  << ": ref=" << ref.getSample(0, firstMismatch)
                  << " chunked=" << chunked.getSample(0, firstMismatch) << "\n";
    CHECK(match, "8x32 == 1x256 across the entire output");
}

static void test06_outOfRangeReadsSilence()
{
    std::cout << "\n[06] reading past source end emits silence\n";

    // Tiny source so the readhead runs off the end.
    auto src = makeRampBuffer(/*n*/64);
    Clip c = makeClip(30, 1024);
    c.pitchOffset      = 12; // ratio = 2 → source pos exceeds 64 by sample 32
    c.modulation.enabled = true;
    c.modulation.vibrato.enabled = true;
    c.modulation.vibrato.depthCents = 0.0f;

    juce::AudioBuffer<float> trackBuf(2, 64);
    trackBuf.clear();

    ClipModulatedReader reader;
    auto p = makeParams(src, c, 0, 64, 1024);
    reader.renderBlock(p, trackBuf, c.id);

    // Last sample should have read past srcTotal-1=63 (pos = 2*63 = 126) -> silence.
    CHECK_NEAR(trackBuf.getSample(0, 63), 0.0, 1e-6, "out[63] = 0 (past source end)");
    // Mid-way it's still reading inside the source.
    CHECK(trackBuf.getSample(0, 5) > 0.0f, "out[5] non-zero (still inside source)");
}

static void test07_unseenSweepClearsStaleState()
{
    std::cout << "\n[07] resetUnseenStates clears state for clips not rendered this block\n";

    auto src = makeRampBuffer();

    Clip c = makeClip(40, 1024);
    c.modulation.enabled = true;
    c.modulation.vibrato.enabled = true;
    c.modulation.vibrato.depthCents = 0.0f;       // unit ratio: easy to verify

    ClipModulatedReader reader;

    // Block 1: render clip 40 starting at posInClip=64 to advance state.
    {
        juce::AudioBuffer<float> tb(2, 64);
        tb.clear();
        auto p = makeParams(src, c, /*bufStart*/64, /*numOut*/64, /*clipLen*/1024);
        reader.renderBlock(p, tb, c.id);
        reader.markClipSeen(c.id);
        reader.resetUnseenStates();
    }

    // Block 2: clip 40 NOT rendered → unseen sweep clears state.
    reader.resetUnseenStates();

    // Block 3: clip 40 rendered again at posInClip=0 → must seed cleanly,
    // not resume from the stale offset of ~128 left over from block 1.
    juce::AudioBuffer<float> tb(2, 32);
    tb.clear();
    auto p = makeParams(src, c, /*bufStart*/0, /*numOut*/32, /*clipLen*/1024);
    reader.renderBlock(p, tb, c.id);

    CHECK_NEAR(tb.getSample(0,  0),  0.0, 1e-3, "out[0] = 0 (fresh reseed)");
    CHECK_NEAR(tb.getSample(0, 10), 10.0, 1e-3, "out[10] = 10 (fresh reseed)");
}

// ─── Phase C.1: deterministic seek seeding ──────────────────────────────────
//
// Helper math tests (test08..test20) operate on
// computeVibratoIntegratedSourceOffsetSamples directly. They compute an
// in-test exact per-sample reference (calling evaluateVibrato in a tight loop
// the same way the reader's render loop does) and assert the helper's output
// matches it within a shape-dependent source-offset bound.
//
// Render equivalence tests (test21..test23) use the helper through the
// reader: render continuously to N, reset, render directly from M, and
// confirm the overlapping audio segments agree under a tight render tolerance.

namespace {

// Builds the same ClipModulationContext that ClipModulatedReader builds per
// sample. Kept in sync with audio/ClipModulatedReader.cpp.
xleth::clipmod::ClipModulationContext buildCtxAt(int64_t clipLocalIdx,
                                                  int64_t clipStartTimelineSamples,
                                                  double bpm,
                                                  double sampleRate,
                                                  double clipDurationSeconds,
                                                  double clipDurationBeats) noexcept
{
    xleth::clipmod::ClipModulationContext ctx;
    ctx.bpm        = bpm;
    ctx.sampleRate = sampleRate;
    const double invSr = (sampleRate > 0.0) ? 1.0 / sampleRate : 0.0;
    const double bps   = bpm / 60.0;
    const int64_t timelineSamples = clipStartTimelineSamples + clipLocalIdx;
    ctx.timelineSamples = timelineSamples;
    ctx.timelineSeconds = static_cast<double>(timelineSamples) * invSr;
    ctx.timelineBeats   = ctx.timelineSeconds * bps;
    ctx.clipLocalSamples = clipLocalIdx;
    ctx.clipLocalSeconds = static_cast<double>(clipLocalIdx) * invSr;
    ctx.clipLocalBeats   = ctx.clipLocalSeconds * bps;
    ctx.clipDurationSeconds = clipDurationSeconds;
    ctx.clipDurationBeats   = clipDurationBeats;
    return ctx;
}

// Exact per-sample reference: sum_{i=0}^{N-1} staticRatio * vibratoRatio_i.
// Mirrors the reader's per-sample accumulation order (accum starts at 0; same
// order of additions as the helper's exact path), so this is the single
// canonical truth that both the reader and the helper must match.
double exactIntegrateReference(const ClipModulation::Vibrato& v,
                               bool topLevelEnabled,
                               double staticRatio,
                               int64_t clipStartTimelineSamples,
                               double bpm,
                               double sampleRate,
                               int64_t N) noexcept
{
    double accum = 0.0;
    for (int64_t i = 0; i < N; ++i) {
        const auto ctx = buildCtxAt(i, clipStartTimelineSamples, bpm, sampleRate,
                                    /*durSec*/ 0.0, /*durBeats*/ 0.0);
        const auto vEval = xleth::clipmod::evaluateVibrato(v, ctx, topLevelEnabled);
        accum += staticRatio * vEval.pitchRatio;
    }
    return accum;
}

VibratoSourceOffsetParams paramsFor(const ClipModulation::Vibrato& v,
                                    bool topLevelEnabled,
                                    double staticRatio,
                                    int64_t N,
                                    double bpm = 120.0,
                                    double sampleRate = 48000.0,
                                    int64_t clipStartTimelineSamples = 0) noexcept
{
    VibratoSourceOffsetParams sp;
    sp.vibrato                  = &v;
    sp.topLevelEnabled          = topLevelEnabled;
    sp.staticRatio              = staticRatio;
    sp.bpm                      = bpm;
    sp.sampleRate               = sampleRate;
    sp.clipLocalSamples         = N;
    sp.clipDurationSeconds      = 0.0;
    sp.clipDurationBeats        = 0.0;
    sp.clipStartTimelineSamples = clipStartTimelineSamples;
    return sp;
}

} // namespace

static void test08_helperDisabledVibratoExact()
{
    std::cout << "\n[08] helper: top-level disabled & vibrato.enabled=false -> staticRatio*N exact\n";

    ClipModulation::Vibrato v;
    v.enabled = false;
    v.depthCents = 100.0f;          // ignored
    v.rateHz = 5.0f;
    v.shape = ClipModulation::Vibrato::Shape::Sine;

    for (int64_t N : {int64_t{0}, int64_t{1}, int64_t{1024}, int64_t{1'000'000}}) {
        // Top-level disabled → return staticRatio * N regardless of vibrato.enabled.
        auto sp = paramsFor(v, /*topLevel*/ false, /*staticRatio*/ 1.5, N);
        const double got = computeVibratoIntegratedSourceOffsetSamples(sp);
        const double expect = 1.5 * static_cast<double>(N);
        CHECK(got == expect, "topLevel=false returns staticRatio*N");
    }
}

static void test09_helperDepthZeroExact()
{
    std::cout << "\n[09] helper: depthCents == 0 -> staticRatio*N exact regardless of shape/rate\n";

    using S = ClipModulation::Vibrato::Shape;
    for (S shape : {S::Sine, S::Triangle, S::Square, S::SawUp, S::SawDown}) {
        ClipModulation::Vibrato v;
        v.enabled = true;
        v.depthCents = 0.0f;
        v.rateHz = 7.5f;
        v.shape = shape;

        auto sp = paramsFor(v, /*topLevel*/ true, /*staticRatio*/ 0.75, /*N*/ 4096);
        const double got = computeVibratoIntegratedSourceOffsetSamples(sp);
        const double expect = 0.75 * 4096.0;
        CHECK(got == expect, "depth=0 returns staticRatio*N exactly");
    }
}

static void test10_helperStaticRatioOnly()
{
    std::cout << "\n[10] helper: vibrato disabled, +1200 cents -> 2.0*N exact\n";

    ClipModulation::Vibrato v;
    v.enabled = false;
    auto sp = paramsFor(v, /*topLevel*/ true, /*staticRatio*/ 2.0, /*N*/ 8192);
    const double got = computeVibratoIntegratedSourceOffsetSamples(sp);
    CHECK(got == 16384.0, "staticRatio=2 -> 2*N exact");
}

static void test11_helperExactRegimeMachineEpsilon()
{
    std::cout << "\n[11] helper exact regime: sine 50c/5Hz matches per-sample reference at machine-epsilon\n";

    ClipModulation::Vibrato v;
    v.enabled = true;
    v.depthCents = 50.0f;
    v.rateHz = 5.0f;
    v.shape = ClipModulation::Vibrato::Shape::Sine;
    v.phaseResetOnClipStart = true;

    const double bpm = 120.0;
    const double sr  = 48000.0;
    const double staticRatio = 1.0;

    // Inside kExactBudget (=65536 for smooth shapes); 16384 well under.
    for (int64_t N : {int64_t{0}, int64_t{1}, int64_t{1024}, int64_t{8192}, int64_t{16384}}) {
        const double ref = exactIntegrateReference(v, true, staticRatio, 0, bpm, sr, N);
        auto sp = paramsFor(v, true, staticRatio, N, bpm, sr);
        const double got = computeVibratoIntegratedSourceOffsetSamples(sp);
        // Same operation order as reference → expect bitwise equality. Allow
        // a few ULPs scaled by N as a defensive epsilon.
        const double tol = 8.0 * std::numeric_limits<double>::epsilon()
                         * std::max(1.0, static_cast<double>(N));
        CHECK_NEAR(got, ref, tol, "exact-regime helper matches reference at machine epsilon");
    }
}

static void test12_helperStridedSineBounded()
{
    std::cout << "\n[12] helper strided: sine 100c/5Hz, N=1M -> source-offset error < 0.5 samples\n";

    ClipModulation::Vibrato v;
    v.enabled = true;
    v.depthCents = 100.0f;
    v.rateHz = 5.0f;
    v.shape = ClipModulation::Vibrato::Shape::Sine;
    v.phaseResetOnClipStart = true;

    const int64_t N = 1'000'000;
    const double  ref = exactIntegrateReference(v, true, 1.0, 0, 120.0, 48000.0, N);
    auto sp = paramsFor(v, true, 1.0, N);
    const double got = computeVibratoIntegratedSourceOffsetSamples(sp);
    const double err = std::abs(got - ref);
    std::cout << "    max abs source-offset error: " << err << " samples\n";
    CHECK(err < 0.5, "sine strided source-offset error < 0.5 samples");
}

static void test13_helperStridedTriangleBounded()
{
    std::cout << "\n[13] helper strided: triangle 100c/5Hz, N=1M -> source-offset error < 4.0 samples\n";

    ClipModulation::Vibrato v;
    v.enabled = true;
    v.depthCents = 100.0f;
    v.rateHz = 5.0f;
    v.shape = ClipModulation::Vibrato::Shape::Triangle;
    v.phaseResetOnClipStart = true;

    const int64_t N = 1'000'000;
    const double  ref = exactIntegrateReference(v, true, 1.0, 0, 120.0, 48000.0, N);
    auto sp = paramsFor(v, true, 1.0, N);
    const double got = computeVibratoIntegratedSourceOffsetSamples(sp);
    const double err = std::abs(got - ref);
    std::cout << "    max abs source-offset error: " << err << " samples\n";
    // Triangle has corners (C^0, not C^1), so it uses the tighter sharp-shape
    // stride. Empirical bound at 100c / 5Hz / 1M samples is well under 1.0.
    CHECK(err < 4.0, "triangle strided source-offset error < 4.0 samples");
}

static void test14_helperStridedSquareBounded()
{
    std::cout << "\n[14] helper strided: square 100c/5Hz, N=1M -> source-offset error < 12.0 samples\n";

    ClipModulation::Vibrato v;
    v.enabled = true;
    v.depthCents = 100.0f;
    v.rateHz = 5.0f;
    v.shape = ClipModulation::Vibrato::Shape::Square;
    v.phaseResetOnClipStart = true;

    const int64_t N = 1'000'000;
    const double  ref = exactIntegrateReference(v, true, 1.0, 0, 120.0, 48000.0, N);
    auto sp = paramsFor(v, true, 1.0, N);
    const double got = computeVibratoIntegratedSourceOffsetSamples(sp);
    const double err = std::abs(got - ref);
    std::cout << "    max abs source-offset error: " << err << " samples\n";
    CHECK(err < 12.0, "square strided source-offset error < 12.0 samples (~0.001% of 1M)");
}

static void test15_helperStridedSawUpBounded()
{
    std::cout << "\n[15] helper strided: sawUp 100c/5Hz, N=1M -> source-offset error < 10.0 samples\n";

    ClipModulation::Vibrato v;
    v.enabled = true;
    v.depthCents = 100.0f;
    v.rateHz = 5.0f;
    v.shape = ClipModulation::Vibrato::Shape::SawUp;
    v.phaseResetOnClipStart = true;

    const int64_t N = 1'000'000;
    const double  ref = exactIntegrateReference(v, true, 1.0, 0, 120.0, 48000.0, N);
    auto sp = paramsFor(v, true, 1.0, N);
    const double got = computeVibratoIntegratedSourceOffsetSamples(sp);
    const double err = std::abs(got - ref);
    std::cout << "    max abs source-offset error: " << err << " samples\n";
    CHECK(err < 10.0, "sawUp strided source-offset error < 10.0 samples");
}

static void test16_helperStridedSawDownBounded()
{
    std::cout << "\n[16] helper strided: sawDown 100c/5Hz, N=1M -> source-offset error < 10.0 samples\n";

    ClipModulation::Vibrato v;
    v.enabled = true;
    v.depthCents = 100.0f;
    v.rateHz = 5.0f;
    v.shape = ClipModulation::Vibrato::Shape::SawDown;
    v.phaseResetOnClipStart = true;

    const int64_t N = 1'000'000;
    const double  ref = exactIntegrateReference(v, true, 1.0, 0, 120.0, 48000.0, N);
    auto sp = paramsFor(v, true, 1.0, N);
    const double got = computeVibratoIntegratedSourceOffsetSamples(sp);
    const double err = std::abs(got - ref);
    std::cout << "    max abs source-offset error: " << err << " samples\n";
    CHECK(err < 10.0, "sawDown strided source-offset error < 10.0 samples");
}

static void test17_helperStridedCustomBounded()
{
    std::cout << "\n[17] helper strided: custom shape with sharp jump, N=1M -> error < 12.0 samples\n";

    ClipModulation::Vibrato v;
    v.enabled = true;
    v.depthCents = 100.0f;
    v.rateHz = 5.0f;
    v.shape = ClipModulation::Vibrato::Shape::Custom;
    v.phaseResetOnClipStart = true;
    // Two-segment shape: stays at +1, snaps to -1 mid-cycle.
    SampleRegion::LfoBreakpoint b0; b0.time = 0.0f; b0.value =  1.0f;
    SampleRegion::LfoBreakpoint b1; b1.time = 0.5f; b1.value =  1.0f;
    SampleRegion::LfoBreakpoint b2; b2.time = 0.5f; b2.value = -1.0f;  // sharp jump
    SampleRegion::LfoBreakpoint b3; b3.time = 1.0f; b3.value = -1.0f;
    v.customShape = { b0, b1, b2, b3 };

    const int64_t N = 1'000'000;
    const double  ref = exactIntegrateReference(v, true, 1.0, 0, 120.0, 48000.0, N);
    auto sp = paramsFor(v, true, 1.0, N);
    const double got = computeVibratoIntegratedSourceOffsetSamples(sp);
    const double err = std::abs(got - ref);
    std::cout << "    max abs source-offset error: " << err << " samples\n";
    CHECK(err < 12.0, "custom-with-jump strided source-offset error < 12.0 samples (~0.001% of 1M)");
}

static void test18_helperPhaseOffsetExactRegime()
{
    std::cout << "\n[18] helper exact regime: sine with phaseOffset=0.37 matches reference\n";

    ClipModulation::Vibrato v;
    v.enabled = true;
    v.depthCents = 50.0f;
    v.rateHz = 5.0f;
    v.shape = ClipModulation::Vibrato::Shape::Sine;
    v.phaseResetOnClipStart = true;
    v.phaseOffset = 0.37f;

    const int64_t N = 8192;
    const double ref = exactIntegrateReference(v, true, 1.0, 0, 120.0, 48000.0, N);
    auto sp = paramsFor(v, true, 1.0, N);
    const double got = computeVibratoIntegratedSourceOffsetSamples(sp);
    const double tol = 8.0 * std::numeric_limits<double>::epsilon() * static_cast<double>(N);
    CHECK_NEAR(got, ref, tol, "phaseOffset preserved through helper");
}

static void test19_helperTempoSyncExactRegime()
{
    std::cout << "\n[19] helper exact regime: TempoSync Eighth, sine, matches reference\n";

    ClipModulation::Vibrato v;
    v.enabled = true;
    v.depthCents = 75.0f;
    v.shape = ClipModulation::Vibrato::Shape::Sine;
    v.phaseResetOnClipStart = true;
    v.rateMode = ClipModulation::Vibrato::RateMode::TempoSync;
    v.syncDivision = ClipModulation::Vibrato::SyncDivision::Eighth;

    const int64_t N = 16384;
    const double ref = exactIntegrateReference(v, true, 1.0, 0, 140.0, 48000.0, N);
    auto sp = paramsFor(v, true, 1.0, N, /*bpm*/140.0);
    const double got = computeVibratoIntegratedSourceOffsetSamples(sp);
    const double tol = 8.0 * std::numeric_limits<double>::epsilon() * static_cast<double>(N);
    CHECK_NEAR(got, ref, tol, "TempoSync Eighth matches reference");
}

static void test20_helperPhaseResetOffNonzeroClipStart()
{
    std::cout << "\n[20] helper: phaseResetOnClipStart=false with clipStart>0 still matches reference\n";

    ClipModulation::Vibrato v;
    v.enabled = true;
    v.depthCents = 50.0f;
    v.rateHz = 7.0f;
    v.shape = ClipModulation::Vibrato::Shape::Sine;
    v.phaseResetOnClipStart = false;     // timeline phase
    v.phaseOffset = 0.0f;

    const int64_t clipStart = 123'456;
    const int64_t N = 8192;
    const double ref = exactIntegrateReference(v, true, 1.0, clipStart, 120.0, 48000.0, N);
    auto sp = paramsFor(v, true, 1.0, N, /*bpm*/120.0, /*sr*/48000.0, clipStart);
    const double got = computeVibratoIntegratedSourceOffsetSamples(sp);
    const double tol = 8.0 * std::numeric_limits<double>::epsilon() * static_cast<double>(N);
    CHECK_NEAR(got, ref, tol, "non-phaseReset path uses timeline phase identically");
}

// ── Render equivalence tests ─────────────────────────────────────────────────

namespace {

// Render [0, N) continuously, then reset reader and render only [M, M+K),
// returning {bufA, bufB}. After the call, bufA[M..M+K) should equal bufB[0..K)
// to within rendering precision when the helper's seed is correct.
struct ContinuousVsSeededResult {
    juce::AudioBuffer<float> continuousBuf;  // size N (stereo)
    juce::AudioBuffer<float> seededBuf;      // size K (stereo)
};

ContinuousVsSeededResult renderContinuousVsSeeded(const Clip& c,
                                                  const juce::AudioBuffer<float>& src,
                                                  int64_t N,
                                                  int64_t M,
                                                  int64_t K,
                                                  int64_t clipLen)
{
    ContinuousVsSeededResult r{
        juce::AudioBuffer<float>(2, static_cast<int>(N)),
        juce::AudioBuffer<float>(2, static_cast<int>(K))
    };
    r.continuousBuf.clear();
    r.seededBuf.clear();

    {
        ClipModulatedReader rr;
        auto p = makeParams(src, c, /*bufStart*/ 0, static_cast<int>(N), clipLen);
        rr.renderBlock(p, r.continuousBuf, c.id);
    }
    {
        ClipModulatedReader rr;  // fresh reader → discontinuity at posInClip=M
        auto p = makeParams(src, c, /*bufStart*/ M, static_cast<int>(K), clipLen);
        rr.renderBlock(p, r.seededBuf, c.id);
    }
    return r;
}

double maxAbsRenderDiff(const juce::AudioBuffer<float>& continuousBuf,
                        int64_t M,
                        const juce::AudioBuffer<float>& seededBuf,
                        int64_t K)
{
    double maxDiff = 0.0;
    for (int64_t s = 0; s < K; ++s) {
        const double dL = std::abs(static_cast<double>(continuousBuf.getSample(0, static_cast<int>(M + s)))
                                 - static_cast<double>(seededBuf.getSample(0, static_cast<int>(s))));
        const double dR = std::abs(static_cast<double>(continuousBuf.getSample(1, static_cast<int>(M + s)))
                                 - static_cast<double>(seededBuf.getSample(1, static_cast<int>(s))));
        if (dL > maxDiff) maxDiff = dL;
        if (dR > maxDiff) maxDiff = dR;
    }
    return maxDiff;
}

} // namespace

static void test21_continuousVsSeededRenderSine()
{
    std::cout << "\n[21] render equivalence: sine 50c/5Hz, continuous[0..4096) ~ seeded[2048..3072)\n";

    auto src = makeRampBuffer();
    Clip c = makeClip(50, 8192);
    c.modulation.enabled = true;
    c.modulation.vibrato.enabled = true;
    c.modulation.vibrato.depthCents = 50.0f;
    c.modulation.vibrato.rateHz = 5.0f;
    c.modulation.vibrato.shape = ClipModulation::Vibrato::Shape::Sine;
    c.modulation.vibrato.phaseResetOnClipStart = true;

    const int64_t N = 4096, M = 2048, K = 1024;
    auto rs = renderContinuousVsSeeded(c, src, N, M, K, 8192);
    const double diff = maxAbsRenderDiff(rs.continuousBuf, M, rs.seededBuf, K);
    std::cout << "    max abs render diff: " << diff << "\n";
    // Source amplitudes go up to ~ramp value ≈ 16384; tight tolerance.
    CHECK(diff < 1e-2, "sine continuous-vs-seeded render diff < 1e-2");
}

static void test22_continuousVsSeededRenderTempoSync()
{
    std::cout << "\n[22] render equivalence: TempoSync Eighth, continuous[0..4096) ~ seeded[2048..3072)\n";

    auto src = makeRampBuffer();
    Clip c = makeClip(51, 8192);
    c.modulation.enabled = true;
    c.modulation.vibrato.enabled = true;
    c.modulation.vibrato.depthCents = 50.0f;
    c.modulation.vibrato.rateMode = ClipModulation::Vibrato::RateMode::TempoSync;
    c.modulation.vibrato.syncDivision = ClipModulation::Vibrato::SyncDivision::Eighth;
    c.modulation.vibrato.shape = ClipModulation::Vibrato::Shape::Sine;
    c.modulation.vibrato.phaseResetOnClipStart = true;

    const int64_t N = 4096, M = 2048, K = 1024;
    auto rs = renderContinuousVsSeeded(c, src, N, M, K, 8192);
    const double diff = maxAbsRenderDiff(rs.continuousBuf, M, rs.seededBuf, K);
    std::cout << "    max abs render diff: " << diff << "\n";
    CHECK(diff < 1e-2, "TempoSync continuous-vs-seeded render diff < 1e-2");
}

static void test23_continuousVsSeededRenderTriangle()
{
    std::cout << "\n[23] render equivalence: triangle 50c/5Hz, continuous[0..4096) ~ seeded[2048..3072)\n";

    auto src = makeRampBuffer();
    Clip c = makeClip(52, 8192);
    c.modulation.enabled = true;
    c.modulation.vibrato.enabled = true;
    c.modulation.vibrato.depthCents = 50.0f;
    c.modulation.vibrato.rateHz = 5.0f;
    c.modulation.vibrato.shape = ClipModulation::Vibrato::Shape::Triangle;
    c.modulation.vibrato.phaseResetOnClipStart = true;

    const int64_t N = 4096, M = 2048, K = 1024;
    auto rs = renderContinuousVsSeeded(c, src, N, M, K, 8192);
    const double diff = maxAbsRenderDiff(rs.continuousBuf, M, rs.seededBuf, K);
    std::cout << "    max abs render diff: " << diff << "\n";
    CHECK(diff < 1e-2, "triangle continuous-vs-seeded render diff < 1e-2");
}

// ─── Phase D.1: Vinyl Scratch ────────────────────────────────────────────────
//
// All Scratch tests use the ramp-buffer pattern (src[i] = i) so the output
// sample value at sample s directly reveals the source position the reader
// read from. Tests are numbered S01..S15 and are wired into main() at the
// bottom alongside the Phase C tests.
//
// The single most important test is S14: it forces a re-seed in the middle
// of a clip with non-trivial staticRatio and asserts continuous == split.
// With the corrected seed formula `vibTrim = integratedOff − N` the test
// passes; with the (incorrect) D.0-report formula `vibTrim = integratedOff −
// N * staticRatio` the split path drops to the wrong readhead and the test
// fails by exactly N samples.

namespace {

// Build a scratch curve from a vector of (timeSeconds, rate) points.
ClipModulation::Scratch makeScratchSeconds(
    std::initializer_list<std::pair<float, float>> pts) noexcept
{
    ClipModulation::Scratch s;
    s.enabled  = true;
    s.timeMode = ClipModulation::Scratch::CurveTimeMode::ClipSeconds;
    s.edgeMode = ClipModulation::Scratch::EdgeMode::Clamp;
    for (auto& p : pts)
        s.curve.push_back({p.first, p.second, 0.0f});
    return s;
}

// Convenience: render N samples of `clip` into a fresh stereo buffer.
juce::AudioBuffer<float> renderClipFresh(const Clip& clip,
                                          const juce::AudioBuffer<float>& src,
                                          int64_t bufStart,
                                          int numSamples,
                                          int64_t clipLen)
{
    juce::AudioBuffer<float> tb(2, numSamples);
    tb.clear();
    ClipModulatedReader r;
    auto p = makeParams(src, clip, bufStart, numSamples, clipLen);
    r.renderBlock(p, tb, clip.id);
    return tb;
}

// Compute the closed-form expected sourceOffsetSeconds for a piecewise-linear
// scratch curve evaluated at the given clipLocalSeconds. Used by S07 to
// cross-check the reader against the evaluator.
double expectedScratchSourceOffsetSec(const ClipModulation::Scratch& s,
                                      double tNow) noexcept
{
    xleth::clipmod::ClipModulationContext ctx;
    ctx.bpm = 120.0;
    ctx.sampleRate = 48000.0;
    ctx.clipLocalSeconds = tNow;
    ctx.clipLocalSamples = static_cast<int64_t>(tNow * 48000.0);
    ctx.clipDurationSeconds = 1e9;  // not used for ClipSeconds mode
    auto e = xleth::clipmod::evaluateScratch(s, ctx, true);
    return e.sourceOffsetSeconds;
}

} // namespace

static void test_S01_scratchDisabledIsNeutral()
{
    std::cout << "\n[S01] scratch disabled -> identical to legacy vibrato-only path\n";

    auto src = makeRampBuffer();
    Clip a = makeClip(101, 1024);
    a.modulation.enabled = true;
    a.modulation.vibrato.enabled = true;
    a.modulation.vibrato.depthCents = 0.0f;       // unit ratio
    a.modulation.scratch.enabled = false;

    Clip b = makeClip(102, 1024);
    b.modulation = a.modulation;
    b.modulation.scratch.enabled = false;
    b.modulation.scratch.curve.push_back({0.0f, 99.0f, 0.0f}); // curve ignored when disabled

    auto outA = renderClipFresh(a, src, 0, 64, 1024);
    auto outB = renderClipFresh(b, src, 0, 64, 1024);
    bool identical = true;
    for (int i = 0; i < 64; ++i)
        if (std::abs(outA.getSample(0, i) - outB.getSample(0, i)) > 1e-6f) { identical = false; break; }
    CHECK(identical, "scratch disabled bit-equal regardless of curve content");
    CHECK_NEAR(outA.getSample(0, 32), 32.0, 1e-3, "vibrato-only path still passthrough at unit ratio");
}

static void test_S02_scratchEnabledEmptyCurveIsNeutral()
{
    std::cout << "\n[S02] scratch enabled with empty curve -> passthrough at unit ratio\n";

    auto src = makeRampBuffer();
    Clip c = makeClip(110, 1024);
    c.modulation.enabled = true;
    c.modulation.scratch.enabled = true;
    // curve intentionally empty.

    auto out = renderClipFresh(c, src, 0, 64, 1024);
    CHECK_NEAR(out.getSample(0,  0),  0.0, 1e-3, "out[0]  ~ 0  (empty curve = neutral)");
    CHECK_NEAR(out.getSample(0, 16), 16.0, 1e-3, "out[16] ~ 16 (empty curve = neutral)");
    CHECK_NEAR(out.getSample(0, 63), 63.0, 1e-3, "out[63] ~ 63 (empty curve = neutral)");
}

static void test_S03_scratchConstantRate1()
{
    std::cout << "\n[S03] scratch constant rate 1.0 -> normal forward playback\n";

    auto src = makeRampBuffer();
    Clip c = makeClip(120, 1024);
    c.modulation.enabled = true;
    c.modulation.scratch = makeScratchSeconds({{0.0f, 1.0f}});

    auto out = renderClipFresh(c, src, 0, 64, 1024);
    CHECK_NEAR(out.getSample(0,  0),  0.0, 1e-3, "out[0]  ~ 0");
    CHECK_NEAR(out.getSample(0, 32), 32.0, 1e-3, "out[32] ~ 32");
    CHECK_NEAR(out.getSample(0, 63), 63.0, 1e-3, "out[63] ~ 63");
}

static void test_S04_scratchConstantRate2()
{
    std::cout << "\n[S04] scratch constant rate 2.0 -> source advances 2x per output sample\n";

    auto src = makeRampBuffer(/*n*/16384);
    Clip c = makeClip(121, 4096);
    c.modulation.enabled = true;
    c.modulation.scratch = makeScratchSeconds({{0.0f, 2.0f}});

    auto out = renderClipFresh(c, src, 0, 100, 4096);
    CHECK_NEAR(out.getSample(0,  0),   0.0, 1e-3, "out[0]  ~ 0");
    CHECK_NEAR(out.getSample(0, 10),  20.0, 1e-3, "out[10] ~ 20");
    CHECK_NEAR(out.getSample(0, 50), 100.0, 1e-3, "out[50] ~ 100");
}

static void test_S05_scratchRate0Freezes()
{
    std::cout << "\n[S05] scratch rate 0.0 -> readhead frozen at regionOffset\n";

    auto src = makeRampBuffer();
    Clip c = makeClip(122, 1024);
    c.modulation.enabled = true;
    c.modulation.scratch = makeScratchSeconds({{0.0f, 0.0f}});

    auto out = renderClipFresh(c, src, 0, 64, 1024);
    for (int i = 0; i < 64; ++i)
        CHECK_NEAR(out.getSample(0, i), 0.0, 1e-3, "rate=0 holds at sample 0");
}

static void test_S06_scratchRateNeg1ReadsBackward()
{
    std::cout << "\n[S06] scratch rate -1.0 from regionOffset=200 -> reads backward\n";

    auto src = makeRampBuffer();
    Clip c = makeClip(123, 1024);
    c.modulation.enabled = true;
    c.modulation.scratch = makeScratchSeconds({{0.0f, -1.0f}});

    // Custom params with regionOffsetSamples=200.
    juce::AudioBuffer<float> tb(2, 64);
    tb.clear();
    ClipModulatedReader reader;
    auto p = makeParams(src, c, 0, 64, 1024);
    p.regionOffsetSamples = 200;
    reader.renderBlock(p, tb, c.id);

    // Output[s] should read source at 200 - s, clamped at 0 by EdgeMode::Clamp.
    CHECK_NEAR(tb.getSample(0,  0), 200.0, 1e-3, "out[0]  ~ src[200]");
    CHECK_NEAR(tb.getSample(0, 50), 150.0, 1e-3, "out[50] ~ src[150]");
}

static void test_S07_scratchLinearRamp()
{
    std::cout << "\n[S07] scratch linear ramp 1.0 -> -1.0 -> readhead matches evaluator integral\n";

    auto src = makeRampBuffer();

    // Curve goes from rate +1 at t=0 to rate -1 at t = 64/48000s.
    const double sr = 48000.0;
    const float  endT = static_cast<float>(64.0 / sr);

    Clip c = makeClip(124, 1024);
    c.modulation.enabled = true;
    c.modulation.scratch = makeScratchSeconds({
        {0.0f, 1.0f},
        {endT, -1.0f},
    });

    auto out = renderClipFresh(c, src, 0, 64, 1024);

    // Cross-check at i=16 and i=48 against evaluator.sourceOffsetSeconds * sr.
    for (int idx : {0, 16, 32, 48}) {
        const double tNow = static_cast<double>(idx) / sr;
        const double expectedPos = expectedScratchSourceOffsetSec(c.modulation.scratch, tNow) * sr;
        CHECK_NEAR(out.getSample(0, idx), static_cast<float>(expectedPos), 5e-1,
                   "ramp readhead matches evaluator integral");
    }
}

static void test_S08_scratchContinuousEqualsSplit()
{
    std::cout << "\n[S08] scratch continuous render equals split render (vibrato off)\n";

    auto src = makeRampBuffer();
    Clip c = makeClip(125, 4096);
    c.modulation.enabled = true;
    c.modulation.scratch = makeScratchSeconds({{0.0f, 1.5f}, {0.05f, 0.7f}});

    const int N = 2048;
    auto outFull = renderClipFresh(c, src, 0, N, 4096);

    // Split: first half with one reader, second half with a fresh reader.
    juce::AudioBuffer<float> outSplit(2, N);
    outSplit.clear();
    {
        ClipModulatedReader r;
        auto p = makeParams(src, c, 0, N/2, 4096);
        juce::AudioBuffer<float> tb(2, N/2); tb.clear();
        r.renderBlock(p, tb, c.id);
        for (int i = 0; i < N/2; ++i) {
            outSplit.setSample(0, i, tb.getSample(0, i));
            outSplit.setSample(1, i, tb.getSample(1, i));
        }
    }
    {
        ClipModulatedReader r;
        auto p = makeParams(src, c, N/2, N/2, 4096);
        juce::AudioBuffer<float> tb(2, N/2); tb.clear();
        r.renderBlock(p, tb, c.id);
        for (int i = 0; i < N/2; ++i) {
            outSplit.setSample(0, N/2 + i, tb.getSample(0, i));
            outSplit.setSample(1, N/2 + i, tb.getSample(1, i));
        }
    }

    double maxDiff = 0.0;
    for (int i = 0; i < N; ++i) {
        const double d = std::abs((double)outFull.getSample(0, i) - (double)outSplit.getSample(0, i));
        if (d > maxDiff) maxDiff = d;
    }
    std::cout << "    max abs diff: " << maxDiff << "\n";
    CHECK(maxDiff < 1e-2, "continuous render ~= split render across re-seed");
}

static void test_S09_scratchClampPastEnd()
{
    std::cout << "\n[S09] scratch Clamp edge -> readhead held at last source sample past end\n";

    // Tiny source, large rate forces readhead past srcTotal-1 quickly.
    auto src = makeRampBuffer(/*n*/64);
    Clip c = makeClip(126, 1024);
    c.modulation.enabled = true;
    c.modulation.scratch = makeScratchSeconds({{0.0f, 4.0f}});
    c.modulation.scratch.edgeMode = ClipModulation::Scratch::EdgeMode::Clamp;

    auto out = renderClipFresh(c, src, 0, 64, 1024);
    // By sample 16 the readhead is at 64 → clamped to last valid sample (~62).
    // Output beyond that should stay near the last source value, not zero.
    CHECK(out.getSample(0, 30) > 50.0f, "out[30] holds boundary, not zero");
    CHECK(out.getSample(0, 60) > 50.0f, "out[60] still holds boundary");
}

static void test_S10_scratchSilencePastEnd()
{
    std::cout << "\n[S10] scratch Silence edge -> readhead emits zero past end\n";

    auto src = makeRampBuffer(/*n*/64);
    Clip c = makeClip(127, 1024);
    c.modulation.enabled = true;
    c.modulation.scratch = makeScratchSeconds({{0.0f, 4.0f}});
    c.modulation.scratch.edgeMode = ClipModulation::Scratch::EdgeMode::Silence;

    auto out = renderClipFresh(c, src, 0, 64, 1024);
    CHECK_NEAR(out.getSample(0, 30), 0.0, 1e-6, "out[30] silent past source end");
    CHECK_NEAR(out.getSample(0, 60), 0.0, 1e-6, "out[60] silent past source end");
    CHECK(out.getSample(0,  5) > 5.0f,         "out[5]  inside source -> non-zero");
}

static void test_S11_scratchDirectionFlipBounded()
{
    std::cout << "\n[S11] scratch direction flip output bounded (declick fires)\n";

    auto src = makeRampBuffer();   // src[i] = i, max ~= 16383
    Clip c = makeClip(128, 4096);
    c.modulation.enabled = true;
    // +2 rate then sharp flip to -2 at sample 1024 (~= 0.0213s @ 48k).
    c.modulation.scratch = makeScratchSeconds({
        {0.000f,  2.0f},
        {0.020f,  2.0f},
        {0.0205f, -2.0f},
        {1.000f,  -2.0f},
    });
    c.modulation.scratch.smoothingMs = 5.0f;

    auto out = renderClipFresh(c, src, 0, 2048, 4096);
    float maxAbs = 0.0f;
    for (int i = 0; i < 2048; ++i)
        maxAbs = std::max(maxAbs, std::abs(out.getSample(0, i)));
    // Source max ~ 4096 (within rendered window). Cap at well under 2x.
    CHECK(maxAbs < 6000.0f, "direction flip stays bounded after declick");
}

static void test_S12_scratchPlusVibratoDeterministic()
{
    std::cout << "\n[S12] scratch + vibrato is deterministic across repeated renders\n";

    auto src = makeRampBuffer();
    Clip c = makeClip(129, 4096);
    c.modulation.enabled = true;
    c.modulation.vibrato.enabled = true;
    c.modulation.vibrato.depthCents = 50.0f;
    c.modulation.vibrato.rateHz = 6.0f;
    c.modulation.vibrato.shape = ClipModulation::Vibrato::Shape::Sine;
    c.modulation.scratch = makeScratchSeconds({{0.0f, 1.5f}, {0.04f, 0.7f}});

    auto a = renderClipFresh(c, src, 0, 1024, 4096);
    auto b = renderClipFresh(c, src, 0, 1024, 4096);
    bool ok = true;
    for (int i = 0; i < 1024; ++i)
        if (a.getSample(0, i) != b.getSample(0, i)) { ok = false; break; }
    CHECK(ok, "two fresh renders produce bit-equal output");
}

static void test_S13_scratchZeroPlusVibratoBounded()
{
    std::cout << "\n[S13] scratch rate 0 + vibrato 100c -> output stays bounded near regionOffset\n";

    auto src = makeRampBuffer();
    Clip c = makeClip(130, 4096);
    c.modulation.enabled = true;
    c.modulation.vibrato.enabled = true;
    c.modulation.vibrato.depthCents = 100.0f;
    c.modulation.vibrato.rateHz = 5.0f;
    c.modulation.vibrato.shape = ClipModulation::Vibrato::Shape::Sine;
    c.modulation.scratch = makeScratchSeconds({{0.0f, 0.0f}});

    juce::AudioBuffer<float> tb(2, 512);
    tb.clear();
    ClipModulatedReader r;
    auto p = makeParams(src, c, 0, 512, 4096);
    p.regionOffsetSamples = 1000;
    r.renderBlock(p, tb, c.id);

    // With rate 0, sourceBase stays at 1000. Vibrato perturbs the readhead by
    // an integral whose magnitude is bounded by depth/rate. ±100c at 5Hz on a
    // ~10ms window stays within a few samples — keep the bound generous.
    float minS = 1e9f, maxS = -1e9f;
    for (int i = 0; i < 512; ++i) {
        minS = std::min(minS, tb.getSample(0, i));
        maxS = std::max(maxS, tb.getSample(0, i));
    }
    std::cout << "    range: [" << minS << ", " << maxS << "]\n";
    CHECK(minS > 900.0f && maxS < 1100.0f, "stays within ±100 samples of regionOffset");
}

static void test_S14_seedFormulaCatchesWrongSubtraction()
{
    std::cout << "\n[S14] static pitch +1200c + scratch rate 1.0 — split equals continuous\n";
    std::cout << "      (this test FAILS if vibTrim seed uses N*staticRatio instead of N)\n";

    auto src = makeRampBuffer(/*n*/16384);
    Clip c = makeClip(131, 4096);
    c.pitchOffset      = 12;   // +1200 cents → staticRatio = 2.0
    c.pitchOffsetCents = 0;
    c.modulation.enabled = true;
    // Vibrato deliberately disabled to isolate the static-ratio contribution.
    c.modulation.vibrato.enabled = false;
    c.modulation.scratch = makeScratchSeconds({{0.0f, 1.0f}});  // unity scratch

    const int N = 1024;

    // Continuous render through one reader.
    auto cont = renderClipFresh(c, src, 0, N, 4096);

    // Split render: fresh reader at midpoint forces a re-seed at posInClip = N/2.
    juce::AudioBuffer<float> split(2, N);
    split.clear();
    {
        ClipModulatedReader r;
        juce::AudioBuffer<float> tb(2, N/2);
        tb.clear();
        auto p = makeParams(src, c, 0, N/2, 4096);
        r.renderBlock(p, tb, c.id);
        for (int i = 0; i < N/2; ++i) {
            split.setSample(0, i, tb.getSample(0, i));
            split.setSample(1, i, tb.getSample(1, i));
        }
    }
    {
        ClipModulatedReader r;  // fresh → discontinuity at posInClip = N/2
        juce::AudioBuffer<float> tb(2, N/2);
        tb.clear();
        auto p = makeParams(src, c, N/2, N/2, 4096);
        r.renderBlock(p, tb, c.id);
        for (int i = 0; i < N/2; ++i) {
            split.setSample(0, N/2 + i, tb.getSample(0, i));
            split.setSample(1, N/2 + i, tb.getSample(1, i));
        }
    }

    // Expect: output[i] ~= source[i + i] = 2i, because sourceBase advances 1
    // per output sample (scratch rate 1) and vibTrim grows by 1 per sample
    // (residual = staticRatio*1.0 - 1.0 = 1.0). After re-seed the correct
    // formula is vibTrim = 2*(N/2) - (N/2) = N/2, so split[N/2] = 2*(N/2).
    // The wrong formula yields vibTrim = 0 → split[N/2] = N/2, off by N/2.
    double maxDiff = 0.0;
    int    firstBad = -1;
    for (int i = 0; i < N; ++i) {
        const double d = std::abs((double)cont.getSample(0, i) - (double)split.getSample(0, i));
        if (d > maxDiff) { maxDiff = d; if (firstBad < 0) firstBad = i; }
    }
    std::cout << "    max abs diff: " << maxDiff
              << "  cont[N/2]=" << cont.getSample(0, N/2)
              << "  split[N/2]=" << split.getSample(0, N/2) << "\n";
    CHECK(maxDiff < 1e-2,
          "continuous == split with corrected vibTrim seed (integratedOff - N)");

    // And as an independent sanity check, confirm the readhead does walk at 2x.
    CHECK_NEAR(cont.getSample(0, 100), 200.0, 1e-2, "continuous readhead advances at 2x");
}

static void test_S15_activationFallbackReversedClip()
{
    std::cout << "\n[S15] activation predicate excludes reversed clips (cache-path fallback)\n";

    // The fallback decision is made in MixEngine, not the reader. We document
    // it by asserting the predicate logic directly so a regression in
    // ClipModulatedReader's activation policy expectations is visible from a
    // unit test.
    Clip c = makeClip(132, 1024);
    c.reversed = true;
    c.modulation.enabled = true;
    c.modulation.scratch.enabled = true;
    c.modulation.scratch.curve.push_back({0.0f, 1.0f, 0.0f});

    const auto& mod = c.modulation;
    const bool useModulatedReader =
        xleth::clipmod::isClipModulationCompatible(
            c.reversed, c.stretchRatio, c.formantPreserve, mod);

    CHECK(!useModulatedReader, "reversed clip falls back to cache path");

    c.reversed = false;
    c.stretchRatio = 1.5;
    const bool useModulatedReader2 =
        xleth::clipmod::isClipModulationCompatible(
            c.reversed, c.stretchRatio, c.formantPreserve, mod);
    CHECK(useModulatedReader2, "stretched clip uses post-cache modulated path");

    c.stretchRatio = 1.0;
    c.formantPreserve = true;
    const bool useModulatedReader3 =
        xleth::clipmod::isClipModulationCompatible(
            c.reversed, c.stretchRatio, c.formantPreserve, mod);
    CHECK(!useModulatedReader3, "formantPreserve clip falls back to cache path");

    c.formantPreserve = false;
    const bool useModulatedReader4 =
        xleth::clipmod::isClipModulationCompatible(
            c.reversed, c.stretchRatio, c.formantPreserve, mod);
    CHECK(useModulatedReader4, "compatible scratch-on clip uses modulated reader");
}

// ─── Phase F.0: vibrato + static pitch composes; helper agrees on activation ──

// Vibrato + static pitch must *both* be applied to the readhead. Render the
// combined case, then render two baselines (vibrato-only at unit pitch, and
// static-pitch-only at zero vibrato depth) and confirm the combined output
// differs from BOTH — proving neither contribution was silently dropped. Also
// pin down the average advance: with static pitch +12 semitones (ratio 2.0)
// and vibrato whose mean ratio is ~1.0, the readhead should average ~2.0 per
// output sample, matching the pitch-only case at the block midpoint within a
// vibrato-bounded margin.
static void test_F0_vibratoWithStaticPitchSemis_appliesBoth()
{
    std::cout << "\n[F0a] vibrato + static pitch (+12 semis) composes — both applied\n";

    auto src = makeRampBuffer(/*n*/16384);
    const int N = 1024;

    // Combined: vibrato + +12 semis
    Clip combined = makeClip(2001, 4096);
    combined.pitchOffset = 12;
    combined.modulation.enabled = true;
    combined.modulation.vibrato.enabled = true;
    combined.modulation.vibrato.depthCents = 75.0f;
    combined.modulation.vibrato.rateHz     = 6.0f;
    combined.modulation.vibrato.shape      = ClipModulation::Vibrato::Shape::Sine;
    combined.modulation.vibrato.phaseResetOnClipStart = true;

    // Baseline A: pitch only (vibrato disabled). +12 semis → readhead at 2*i.
    Clip pitchOnly = combined;
    pitchOnly.modulation.vibrato.enabled = false;

    // Baseline B: vibrato only (no static pitch). Readhead averages 1*i.
    Clip vibOnly = combined;
    vibOnly.pitchOffset = 0;
    vibOnly.pitchOffsetCents = 0;

    auto outCombined  = renderClipFresh(combined,  src, 0, N, 4096);
    auto outPitchOnly = renderClipFresh(pitchOnly, src, 0, N, 4096);
    auto outVibOnly   = renderClipFresh(vibOnly,   src, 0, N, 4096);

    // 1) Combined != pitch-only: vibrato modulation visible.
    double maxDiffVsPitch = 0.0;
    for (int i = 0; i < N; ++i)
        maxDiffVsPitch = std::max(maxDiffVsPitch,
            std::abs((double)outCombined.getSample(0, i) - (double)outPitchOnly.getSample(0, i)));
    std::cout << "    max |combined - pitchOnly| = " << maxDiffVsPitch
              << "  (>= ~0.5 means vibrato is felt on top of static pitch)\n";
    CHECK(maxDiffVsPitch > 0.5,
          "combined render differs from pitch-only — vibrato is applied");

    // 2) Combined != vibrato-only: static pitch ratio visible.
    // At i = N/2 the static-pitch contribution alone already shifts the
    // readhead by N/2 * (2.0 - 1.0) = N/2 samples, so the difference is huge.
    const double diffMid =
        std::abs((double)outCombined.getSample(0, N/2)
               - (double)outVibOnly  .getSample(0, N/2));
    std::cout << "    |combined - vibOnly| at i=N/2: " << diffMid
              << "  (expect ~N/2 = " << (N/2) << ")\n";
    CHECK(diffMid > N/4.0,
          "combined render differs from vibrato-only — static pitch is applied");

    // 3) At i=N/2 the combined readhead is near the pitch-only value (2*N/2=N),
    //    perturbed only by the bounded vibrato residual.
    const double combinedMid = outCombined.getSample(0, N/2);
    const double pitchMid    = outPitchOnly.getSample(0, N/2);
    std::cout << "    combined[N/2] = " << combinedMid
              << "  pitchOnly[N/2] = " << pitchMid << "\n";
    // 75-cent depth at 6 Hz over a ~10ms window stays within a few samples.
    CHECK(std::abs(combinedMid - pitchMid) < 50.0,
          "combined readhead tracks pitch-only readhead within bounded vibrato residual");
}

// Same composition test using cents-only static pitch (covers the cents path
// independently from the semitone path).
static void test_F0_vibratoWithStaticPitchCents_appliesBoth()
{
    std::cout << "\n[F0b] vibrato + static pitch (+1200 cents) composes — both applied\n";

    auto src = makeRampBuffer(/*n*/16384);
    const int N = 1024;

    Clip combined = makeClip(2002, 4096);
    combined.pitchOffset = 0;
    combined.pitchOffsetCents = 1200;     // equivalent to +12 semis via cents path
    combined.modulation.enabled = true;
    combined.modulation.vibrato.enabled = true;
    combined.modulation.vibrato.depthCents = 50.0f;
    combined.modulation.vibrato.rateHz     = 5.0f;
    combined.modulation.vibrato.shape      = ClipModulation::Vibrato::Shape::Sine;
    combined.modulation.vibrato.phaseResetOnClipStart = true;

    Clip pitchOnly = combined;
    pitchOnly.modulation.vibrato.enabled = false;

    Clip vibOnly = combined;
    vibOnly.pitchOffsetCents = 0;

    auto outCombined  = renderClipFresh(combined,  src, 0, N, 4096);
    auto outPitchOnly = renderClipFresh(pitchOnly, src, 0, N, 4096);
    auto outVibOnly   = renderClipFresh(vibOnly,   src, 0, N, 4096);

    // Pitch-only at i=N/2 advances ~N (ratio 2.0).
    CHECK_NEAR(outPitchOnly.getSample(0, N/2), N, 5.0,
               "pitch-only via cents advances readhead at 2x");

    // Combined differs from both baselines.
    double maxDiffVsPitch = 0.0;
    for (int i = 0; i < N; ++i)
        maxDiffVsPitch = std::max(maxDiffVsPitch,
            std::abs((double)outCombined.getSample(0, i) - (double)outPitchOnly.getSample(0, i)));
    CHECK(maxDiffVsPitch > 0.3, "vibrato is applied on top of cents-based static pitch");

    const double diffMid =
        std::abs((double)outCombined.getSample(0, N/2)
               - (double)outVibOnly  .getSample(0, N/2));
    CHECK(diffMid > N/4.0, "static pitch (cents) is applied on top of vibrato");
}

// Static pitch + scratch composition: extends test_S14 (which holds vibrato
// disabled) by enabling vibrato as well so the full Phase D.1 path is exercised
// with static pitch.
static void test_F0_scratchWithStaticPitchAndVibrato_combines()
{
    std::cout << "\n[F0c] scratch + vibrato + static pitch — split == continuous (deterministic seed)\n";

    auto src = makeRampBuffer(/*n*/16384);
    const int N = 1024;

    Clip c = makeClip(2003, 4096);
    c.pitchOffset = 7;                    // +7 semis static
    c.modulation.enabled = true;
    c.modulation.vibrato.enabled = true;
    c.modulation.vibrato.depthCents = 60.0f;
    c.modulation.vibrato.rateHz     = 5.0f;
    c.modulation.vibrato.shape      = ClipModulation::Vibrato::Shape::Sine;
    c.modulation.vibrato.phaseResetOnClipStart = true;
    c.modulation.scratch.enabled = true;
    c.modulation.scratch.timeMode = ClipModulation::Scratch::CurveTimeMode::ClipSeconds;
    c.modulation.scratch.curve.push_back({0.0f, 1.0f, 0.0f}); // unity scratch rate

    auto cont = renderClipFresh(c, src, 0, N, 4096);

    // Split render at midpoint, fresh reader → forces re-seed.
    juce::AudioBuffer<float> split(2, N);
    split.clear();
    {
        ClipModulatedReader r;
        juce::AudioBuffer<float> tb(2, N/2);
        tb.clear();
        auto p = makeParams(src, c, 0, N/2, 4096);
        r.renderBlock(p, tb, c.id);
        for (int i = 0; i < N/2; ++i) {
            split.setSample(0, i, tb.getSample(0, i));
            split.setSample(1, i, tb.getSample(1, i));
        }
    }
    {
        ClipModulatedReader r;
        juce::AudioBuffer<float> tb(2, N/2);
        tb.clear();
        auto p = makeParams(src, c, N/2, N/2, 4096);
        r.renderBlock(p, tb, c.id);
        for (int i = 0; i < N/2; ++i) {
            split.setSample(0, N/2 + i, tb.getSample(0, i));
            split.setSample(1, N/2 + i, tb.getSample(1, i));
        }
    }

    double maxDiff = 0.0;
    for (int i = 0; i < N; ++i)
        maxDiff = std::max(maxDiff,
            std::abs((double)cont.getSample(0, i) - (double)split.getSample(0, i)));
    std::cout << "    max |continuous - split| = " << maxDiff << "\n";
    CHECK(maxDiff < 1e-2,
          "scratch + vibrato + static pitch: split == continuous "
          "(seed correctly accounts for staticRatio)");
}

// Helper-vs-S15 lock-in: assert that the new shared helper agrees with the old
// inline predicate logic, including the positive case for static-pitch clips.
static void test_F0_compatibilityHelperAgreesWithLegacyPredicate()
{
    std::cout << "\n[F0d] compatibility helper agrees with MixEngine activation logic\n";

    Clip c = makeClip(2004, 1024);
    c.modulation.enabled = true;
    c.modulation.vibrato.enabled = true;
    c.modulation.vibrato.depthCents = 50.0f;

    // Plain
    CHECK(xleth::clipmod::isClipModulationCompatible(c.reversed, c.stretchRatio, c.formantPreserve, c.modulation),
          "plain + vibrato: helper says compatible");

    // Static pitch (semis only)
    c.pitchOffset = 12;
    CHECK(xleth::clipmod::isClipModulationCompatible(c.reversed, c.stretchRatio, c.formantPreserve, c.modulation),
          "static pitch +12 semis: helper says compatible");

    // Static pitch (cents only)
    c.pitchOffset = 0;
    c.pitchOffsetCents = 1200;
    CHECK(xleth::clipmod::isClipModulationCompatible(c.reversed, c.stretchRatio, c.formantPreserve, c.modulation),
          "static pitch +1200c: helper says compatible");

    // Static pitch mixed
    c.pitchOffset = 5;
    c.pitchOffsetCents = 35;
    CHECK(xleth::clipmod::isClipModulationCompatible(c.reversed, c.stretchRatio, c.formantPreserve, c.modulation),
          "static pitch +5 semis +35 cents: helper says compatible");

    // Bypass cases
    c.reversed = true;
    CHECK(!xleth::clipmod::isClipModulationCompatible(c.reversed, c.stretchRatio, c.formantPreserve, c.modulation),
          "reversed: helper says NOT compatible");
    c.reversed = false;

    c.stretchRatio = 1.5;
    CHECK(xleth::clipmod::isClipModulationCompatible(c.reversed, c.stretchRatio, c.formantPreserve, c.modulation),
          "stretched forward/non-formant: helper says compatible");
    c.stretchRatio = 1.0;

    c.formantPreserve = true;
    CHECK(!xleth::clipmod::isClipModulationCompatible(c.reversed, c.stretchRatio, c.formantPreserve, c.modulation),
          "formant-preserve: helper says NOT compatible");

    c.formantPreserve = false;
    c.modulation.enabled = false;
    CHECK(!xleth::clipmod::isClipModulationCompatible(c.reversed, 1.5, c.formantPreserve, c.modulation),
          "disabled stretched clip says NOT compatible");

    c.modulation.enabled = true;
    c.modulation.vibrato.enabled = false;
    c.modulation.scratch.enabled = false;
    CHECK(!xleth::clipmod::isClipModulationCompatible(c.reversed, 1.5, c.formantPreserve, c.modulation),
          "stretched clip with no active curve says NOT compatible");
}

static void test_F1_stretchedCacheVibratoModulatesPostCacheBuffer()
{
    std::cout << "\n[F1a] stretched cache + vibrato reads post-cache buffer\n";

    auto cacheBuf = makeRampBuffer(/*n*/4096);
    Clip c = makeClip(2101, 4096);
    c.stretchRatio = 1.5;
    c.modulation.enabled = true;
    c.modulation.vibrato.enabled = true;
    c.modulation.vibrato.depthCents = 1200.0f;
    c.modulation.vibrato.rateHz = 20.0f;
    c.modulation.vibrato.shape = ClipModulation::Vibrato::Shape::Sine;

    auto out = renderClipFresh(c, cacheBuf, 0, 256, 4096);

    double maxDiff = 0.0;
    for (int i = 0; i < 256; ++i)
        maxDiff = std::max(maxDiff,
            std::abs((double)out.getSample(0, i) - (double)cacheBuf.getSample(0, i)));
    CHECK(maxDiff > 0.5, "vibrato changes readhead over stretched cache baseline");
    CHECK_NEAR(out.getSample(0, 0), cacheBuf.getSample(0, 0), 1e-3,
               "cache-local sample 0 maps to reader source sample 0");
}

static void test_F1_stretchedCacheScratchSemantics()
{
    std::cout << "\n[F1b] stretched cache + scratch operates over cache-local time\n";

    auto cacheBuf = makeRampBuffer(/*n*/4096);
    Clip c = makeClip(2102, 4096);
    c.stretchRatio = 0.75;
    c.modulation.enabled = true;
    c.modulation.scratch = makeScratchSeconds({{0.0f, 1.0f}});

    auto rate1 = renderClipFresh(c, cacheBuf, 0, 64, 4096);
    CHECK_NEAR(rate1.getSample(0, 32), 32.0, 1e-3,
               "scratch rate 1 reads forward through stretched buffer");

    c.modulation.scratch = makeScratchSeconds({{0.0f, 0.0f}});
    auto freeze = renderClipFresh(c, cacheBuf, 0, 64, 4096);
    CHECK_NEAR(freeze.getSample(0, 63), 0.0, 1e-3,
               "scratch rate 0 freezes at stretched buffer start");

    c.modulation.scratch = makeScratchSeconds({{0.0f, -1.0f}});
    auto backwards = renderClipFresh(c, cacheBuf, 0, 64, 4096);
    CHECK_NEAR(backwards.getSample(0, 32), 0.0, 1e-3,
               "scratch rate -1 moves backward over stretched buffer and clamps at start");
}

static void test_F1_stretchedCacheScratchSplitDeterministic()
{
    std::cout << "\n[F1c] stretched cache + scratch split render is deterministic\n";

    auto cacheBuf = makeRampBuffer(/*n*/4096);
    const int N = 256;
    Clip c = makeClip(2103, 4096);
    c.stretchRatio = 1.5;
    c.modulation.enabled = true;
    c.modulation.scratch = makeScratchSeconds({
        {0.0f, 1.0f},
        {static_cast<float>(N / 48000.0), 0.5f}
    });

    auto cont = renderClipFresh(c, cacheBuf, 0, N, 4096);

    juce::AudioBuffer<float> split(2, N);
    split.clear();
    for (int part = 0; part < 2; ++part)
    {
        const int start = part == 0 ? 0 : N / 2;
        ClipModulatedReader r;
        juce::AudioBuffer<float> tmp(2, N / 2);
        tmp.clear();
        auto p = makeParams(cacheBuf, c, start, N / 2, 4096);
        p.regionOffsetSamples = 0;
        p.pitchOffsetSemis = 0;
        p.pitchOffsetCents = 0;
        r.renderBlock(p, tmp, c.id);
        for (int i = 0; i < N / 2; ++i)
        {
            split.setSample(0, start + i, tmp.getSample(0, i));
            split.setSample(1, start + i, tmp.getSample(1, i));
        }
    }

    double maxDiff = 0.0;
    for (int i = 0; i < N; ++i)
        maxDiff = std::max(maxDiff,
            std::abs((double)cont.getSample(0, i) - (double)split.getSample(0, i)));
    CHECK(maxDiff < 1e-2, "stretched scratch cache render split == continuous");
}

static void test_F1_stretchedCacheStaticPitchNotAppliedTwice()
{
    std::cout << "\n[F1d] stretched cache already contains static pitch; reader does not double it\n";

    auto cacheBuf = makeRampBuffer(/*n*/4096);
    for (int i = 0; i < cacheBuf.getNumSamples(); ++i)
        cacheBuf.setSample(0, i, static_cast<float>(2 * i)); // synthetic pre-pitched cache

    Clip c = makeClip(2104, 4096);
    c.stretchRatio = 1.5;
    c.pitchOffset = 12;
    c.modulation.enabled = true;
    c.modulation.vibrato.enabled = true;
    c.modulation.vibrato.depthCents = 0.0f;

    juce::AudioBuffer<float> out(2, 64);
    out.clear();
    ClipModulatedReader r;
    auto p = makeParams(cacheBuf, c, 0, 64, 4096);
    p.regionOffsetSamples = 0;
    p.pitchOffsetSemis = 0;
    p.pitchOffsetCents = 0;
    r.renderBlock(p, out, c.id);

    CHECK_NEAR(out.getSample(0, 20), 40.0, 1e-3,
               "post-cache path keeps baked pitch and does not apply +12 semis again");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

int main()
{
    test01_disabledModulation_passthroughAtUnitRatio();
    test02_vibratoEnabledDepthZero_passthrough();
    test03_staticPitch1200Cents_doublesReadStride();
    test04_zeroCentVibratoStillUnitOnAverage();
    test05_blockSizeInvariance();
    test06_outOfRangeReadsSilence();
    test07_unseenSweepClearsStaleState();
    test08_helperDisabledVibratoExact();
    test09_helperDepthZeroExact();
    test10_helperStaticRatioOnly();
    test11_helperExactRegimeMachineEpsilon();
    test12_helperStridedSineBounded();
    test13_helperStridedTriangleBounded();
    test14_helperStridedSquareBounded();
    test15_helperStridedSawUpBounded();
    test16_helperStridedSawDownBounded();
    test17_helperStridedCustomBounded();
    test18_helperPhaseOffsetExactRegime();
    test19_helperTempoSyncExactRegime();
    test20_helperPhaseResetOffNonzeroClipStart();
    test21_continuousVsSeededRenderSine();
    test22_continuousVsSeededRenderTempoSync();
    test23_continuousVsSeededRenderTriangle();

    // Phase D.1 — Vinyl Scratch
    test_S01_scratchDisabledIsNeutral();
    test_S02_scratchEnabledEmptyCurveIsNeutral();
    test_S03_scratchConstantRate1();
    test_S04_scratchConstantRate2();
    test_S05_scratchRate0Freezes();
    test_S06_scratchRateNeg1ReadsBackward();
    test_S07_scratchLinearRamp();
    test_S08_scratchContinuousEqualsSplit();
    test_S09_scratchClampPastEnd();
    test_S10_scratchSilencePastEnd();
    test_S11_scratchDirectionFlipBounded();
    test_S12_scratchPlusVibratoDeterministic();
    test_S13_scratchZeroPlusVibratoBounded();
    test_S14_seedFormulaCatchesWrongSubtraction();
    test_S15_activationFallbackReversedClip();

    // Phase F.0 — modified-clip compatibility lock-in
    test_F0_vibratoWithStaticPitchSemis_appliesBoth();
    test_F0_vibratoWithStaticPitchCents_appliesBoth();
    test_F0_scratchWithStaticPitchAndVibrato_combines();
    test_F0_compatibilityHelperAgreesWithLegacyPredicate();
    test_F1_stretchedCacheVibratoModulatesPostCacheBuffer();
    test_F1_stretchedCacheScratchSemantics();
    test_F1_stretchedCacheScratchSplitDeterministic();
    test_F1_stretchedCacheStaticPitchNotAppliedTwice();

    std::cout << "\n";
    if (g_failed == 0)
    {
        std::cout << "ALL TESTS PASSED (" << g_passed << " checks)\n";
        return 0;
    }
    std::cout << "FAILED: " << g_failed << " check(s) failed, "
              << g_passed << " passed\n";
    return 1;
}
