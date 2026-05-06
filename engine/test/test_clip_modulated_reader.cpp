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
#include "model/TimelineTypes.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <cmath>
#include <cstdint>
#include <iostream>

using xleth::audio::ClipModulatedReader;

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
