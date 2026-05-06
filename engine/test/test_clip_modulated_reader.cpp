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
