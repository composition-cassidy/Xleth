// test_clip_sr.cpp — Regression test for the export clip-pitch (sample-rate) bug.
//
// Bug: SampleBank stores buffers at the engine rate they were baked at (the
// "bake rate", typically 44100 from live preview). Export prepares the mixer at
// the export rate (e.g. 48000). The timeline clip-render path read the bake-rate
// buffer 1:1 with prepared-rate indices, so clips rendered sharp by
// exportRate/bakeRate (48000/44100 ≈ +146.7 cents).
//
// This test renders a pure tone clip baked at one rate and "exported" at another,
// measures the rendered fundamental, and asserts the pitch is preserved. It
// exercises all three clip read branches:
//   - raw PCM fallback        (plain clip, no pitch/stretch)
//   - cache hit               (pitch-shifted clip, cache pre-warmed)
//   - modulated reader        (vibrato-enabled clip)
//
// Build: see engine/CMakeLists.txt target "test_clip_sr"
// Run:   test_clip_sr.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1

#include "audio/MixEngine.h"
#include "model/Timeline.h"
#include "model/TimelineTypes.h"
#include "SampleBank.h"
#include "Transport.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <string>
#include <thread>

// ─── Test harness ────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                  \
    do {                                                                  \
        if (cond) { ++g_passed; }                                         \
        else { std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; \
               ++g_failed; }                                              \
    } while (0)

// ─── Sine WAV generator (mono) ───────────────────────────────────────────────

static juce::File generateSineWav(const juce::File& dir, const juce::String& name,
                                  double fileRate, int numSamples,
                                  float freq, float amplitude)
{
    juce::AudioBuffer<float> buf(1, numSamples);
    float* data = buf.getWritePointer(0);
    for (int i = 0; i < numSamples; ++i)
    {
        const double t = static_cast<double>(i) / fileRate;
        data[i] = amplitude * static_cast<float>(
            std::sin(2.0 * juce::MathConstants<double>::pi * freq * t));
    }

    juce::File out = dir.getChildFile(name + ".wav");
    out.deleteFile();
    juce::WavAudioFormat fmt;
    std::unique_ptr<juce::FileOutputStream> stream(out.createOutputStream());
    std::unique_ptr<juce::AudioFormatWriter> writer(
        fmt.createWriterFor(stream.get(), fileRate, 1, 16, {}, 0));
    if (writer != nullptr)
    {
        stream.release(); // writer owns it now
        writer->writeFromAudioSampleBuffer(buf, 0, numSamples);
    }
    return out;
}

// ─── Frequency measurement (Goertzel power scan + refinement) ─────────────────
// Analyses channel 0 over [startFrac, endFrac) of the buffer to skip edge fades.

static double goertzelPower(const float* x, int n, double freq, double sampleRate)
{
    const double w = 2.0 * juce::MathConstants<double>::pi * freq / sampleRate;
    const double cw = std::cos(w);
    const double coeff = 2.0 * cw;
    double s0 = 0.0, s1 = 0.0, s2 = 0.0;
    for (int i = 0; i < n; ++i)
    {
        s0 = x[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

static double measureFreq(const juce::AudioBuffer<float>& buf, double sampleRate,
                          double startFrac = 0.2, double endFrac = 0.8,
                          double fLo = 350.0, double fHi = 560.0)
{
    const int total = buf.getNumSamples();
    const int a = std::max(0, static_cast<int>(total * startFrac));
    const int b = std::min(total, static_cast<int>(total * endFrac));
    const int n = b - a;
    if (n <= 64) return 0.0;
    const float* x = buf.getReadPointer(0) + a;

    // Coarse scan (1 Hz), then fine scan (0.005 Hz) around the peak.
    double bestF = fLo, bestP = -1.0;
    for (double f = fLo; f <= fHi; f += 1.0)
    {
        const double p = goertzelPower(x, n, f, sampleRate);
        if (p > bestP) { bestP = p; bestF = f; }
    }
    double lo = bestF - 1.0, hi = bestF + 1.0;
    bestP = -1.0;
    for (double f = lo; f <= hi; f += 0.005)
    {
        const double p = goertzelPower(x, n, f, sampleRate);
        if (p > bestP) { bestP = p; bestF = f; }
    }
    return bestF;
}

static double centsBetween(double measured, double reference)
{
    return 1200.0 * std::log2(measured / reference);
}

// ─── Clip render driver ──────────────────────────────────────────────────────

struct ClipSpec
{
    double bakeRate        = 44100.0; // rate the WAV is baked into the bank at
    double exportRate      = 48000.0; // rate the mixer is prepared/rendered at
    double bpm             = 120.0;
    float  freqHz          = 440.0f;
    double sampleSeconds   = 1.0;     // length of source WAV (at bake rate)
    double clipBeats       = 1.0;     // clip duration in beats
    int    pitchSemis      = 0;
    int    pitchCents      = 0;
    double stretchRatio    = 1.0;
    bool   vibrato         = false;   // engage the modulated reader
    float  vibratoDepthCents = 0.0f;
    bool   warmCache       = false;   // pre-warm the async clip render cache
};

static juce::AudioBuffer<float> renderClip(const ClipSpec& spec)
{
    constexpr int blockSize = 512;

    Timeline timeline(spec.bpm, spec.exportRate);

    TrackInfo track; track.name = "t"; track.volume = 1.0f; track.pan = 0.0f;
    const int trackId = timeline.addTrack(track);

    SampleRegion region; region.name = "r"; region.label = SampleLabel::Custom;
    const int regionId = timeline.addRegion(region);

    Clip c;
    c.trackId      = trackId;
    c.regionId     = regionId;
    c.position     = TickTime::fromBeats(0);
    c.duration     = TickTime::fromBeats(spec.clipBeats);
    c.pitchOffset  = spec.pitchSemis;
    c.pitchOffsetCents = spec.pitchCents;
    c.stretchRatio = spec.stretchRatio;
    if (spec.vibrato)
    {
        c.modulation.enabled         = true;
        c.modulation.vibrato.enabled = true;
        c.modulation.vibrato.depthCents = spec.vibratoDepthCents;
        c.modulation.vibrato.rateHz     = 5.0f;
    }
    const int clipId = timeline.addClip(c);

    auto tempDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                       .getChildFile("xleth_test_clip_sr");
    tempDir.createDirectory();
    const int nSamp = static_cast<int>(spec.bakeRate * spec.sampleSeconds);
    auto wav = generateSineWav(tempDir, "tone", spec.bakeRate, nSamp,
                               spec.freqHz, 0.8f);

    SampleBank bank;
    const int sampleId = bank.loadSample(wav, spec.bakeRate); // baked at bakeRate

    MixEngine engine;
    engine.prepare(spec.exportRate, blockSize);  // sets preparedSampleRate_
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(regionId, sampleId);

    if (spec.warmCache)
    {
        engine.invalidateClipCache(clipId, "test_clip_sr");
        // Poll until the async render job lands (bounded — never hang forever).
        for (int i = 0; i < 4000; ++i)
        {
            if (engine.getClipProcessedBuffer(clipId) != nullptr) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
    }

    Transport transport;
    transport.setSampleRate(spec.exportRate);
    transport.setBPM(spec.bpm);
    transport.seekToSample(0);
    transport.play();

    const int64_t clipLen = static_cast<int64_t>(
        spec.clipBeats * (60.0 / spec.bpm) * spec.exportRate);
    const int total = static_cast<int>(clipLen);

    juce::AudioBuffer<float> big(2, total);
    big.clear();
    juce::AudioBuffer<float> block(2, blockSize);

    int64_t pos = 0;
    while (pos < total)
    {
        const int n = static_cast<int>(std::min<int64_t>(blockSize, total - pos));
        block.clear();
        engine.processBlock(block, n, transport);
        for (int ch = 0; ch < 2; ++ch)
            big.copyFrom(ch, static_cast<int>(pos), block, ch, 0, n);
        transport.advance(n);
        pos += n;
    }

    tempDir.deleteRecursively();
    return big;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// STEP 1 anchor + STEP 3.1: raw-fallback branch. Baked@44100, exported@48000.
// Pre-fix this reads ~478.9 Hz (+146.7 c). Post-fix must read ≈ 440 Hz.
static void testRawFallbackCrossRate()
{
    std::cout << "[1] Raw-fallback clip: bake 44100 → export 48000\n";
    ClipSpec spec; // defaults: 440 Hz, 44100→48000, no pitch/stretch
    auto buf = renderClip(spec);
    const double f = measureFreq(buf, spec.exportRate);
    const double cents = centsBetween(f, spec.freqHz);
    std::cout << "    measured " << f << " Hz  (" << cents << " cents vs 440)\n";
    CHECK(std::abs(cents) < 2.0,
          "raw-fallback cross-rate clip preserves pitch (≈440 Hz, was +146.7 c)");
}

// Residual of the steady region after projecting onto a pure sinusoid at
// `freq` (least-squares cos/sin fit). Returns residualRMS / signalRMS. A clean
// tone (integer fast path, no interpolation distortion) → near zero; added
// interpolation artifacts / aliasing raise it. Phase- and latency-independent.
static double toneResidualRatio(const juce::AudioBuffer<float>& buf,
                                double sampleRate, double freq,
                                double startFrac = 0.25, double endFrac = 0.75)
{
    const int total = buf.getNumSamples();
    const int a = static_cast<int>(total * startFrac);
    const int b = static_cast<int>(total * endFrac);
    const int n = b - a;
    if (n <= 64) return 1.0;
    const float* x = buf.getReadPointer(0) + a;

    const double w = 2.0 * juce::MathConstants<double>::pi * freq / sampleRate;
    double ss = 0, cc = 0, scs = 0, xc = 0, xs = 0, sig = 0;
    for (int i = 0; i < n; ++i)
    {
        const double c = std::cos(w * i), s = std::sin(w * i), v = x[i];
        cc += c * c; ss += s * s; scs += c * s;
        xc += v * c; xs += v * s; sig += v * v;
    }
    const double det = cc * ss - scs * scs;
    if (std::abs(det) < 1e-12 || sig < 1e-12) return 1.0;
    const double A = ( xc * ss - xs * scs) / det;   // cos coefficient
    const double B = (-xc * scs + xs * cc) / det;   // sin coefficient
    double resid = 0;
    for (int i = 0; i < n; ++i)
    {
        const double fit = A * std::cos(w * i) + B * std::sin(w * i);
        const double e = x[i] - fit;
        resid += e * e;
    }
    return std::sqrt(resid / sig);
}

// STEP 3.2: matched-rate guard. Baked & exported at 44100 → factor == 1.0 → the
// integer fast path. Output must be a clean 440 Hz tone with no added
// interpolation/aliasing. (Sample-exact comparison is impossible here because
// the master chain applies latency compensation, phase-shifting the output.)
static void testMatchedRateClean()
{
    std::cout << "[2] Matched-rate clip: bake 44100 = export 44100 (fast path)\n";
    ClipSpec spec;
    spec.bakeRate   = 44100.0;
    spec.exportRate = 44100.0;
    auto buf = renderClip(spec);

    const double f = measureFreq(buf, spec.exportRate);
    const double resid = toneResidualRatio(buf, spec.exportRate, f);
    std::cout << "    measured " << f << " Hz  (" << centsBetween(f, 440.0)
              << " cents);  tone residual " << resid << "\n";
    CHECK(std::abs(centsBetween(f, 440.0)) < 0.5,
          "matched-rate render is exactly 440 Hz");
    CHECK(resid < 0.02,
          "matched-rate render is a clean tone (integer fast path, no artifacts)");
}

// STEP 3.3: cache-hit branch via pure time-stretch (pitch=0, stretchRatio≠1 →
// needsProcessing → cache). Time-stretch is pitch-preserving, so the rendered
// fundamental must stay at the source 440 Hz regardless of export rate — this
// isolates the cache's bake→export resample from any pitch-engine behaviour.
// (A pitch-SHIFT through the rate-dependent stretch engine is deliberately not
// used here: the engine itself behaves differently at 44.1 k vs 48 k for the
// same musical input, which is expected and unrelated to the SR-readhead bug.)
static void testCacheHitCrossRate()
{
    std::cout << "[3] Cache-hit clip (stretch ×1.5, no pitch): "
                 "bake 44100 → export 48000\n";

    ClipSpec spec;
    spec.stretchRatio = 1.5;     // time-stretch only → pitch preserved
    spec.warmCache    = true;
    spec.clipBeats    = 0.6;     // keep clip well inside the 1 s source after stretch
    auto buf = renderClip(spec);
    const double f = measureFreq(buf, spec.exportRate);
    const double cents = centsBetween(f, spec.freqHz);
    std::cout << "    measured " << f << " Hz  (" << cents << " cents vs 440)\n";
    CHECK(std::abs(cents) < 6.0,
          "cache-hit cross-rate time-stretch preserves pitch (≈440 Hz)");
}

// STEP 3.4: modulated reader. Vibrato enabled with zero depth → the modulated
// readhead runs (pure carrier). Cross-rate must still read ≈ 440 Hz.
static void testModulatedReaderCrossRate()
{
    std::cout << "[4] Modulated-reader clip (vibrato, depth 0): "
                 "bake 44100 → export 48000\n";

    ClipSpec spec;
    spec.vibrato          = true;
    spec.vibratoDepthCents = 0.0f;
    auto buf = renderClip(spec);
    const double f = measureFreq(buf, spec.exportRate);
    const double cents = centsBetween(f, spec.freqHz);
    std::cout << "    measured " << f << " Hz  (" << cents << " cents vs 440)\n";
    CHECK(std::abs(cents) < 2.0,
          "modulated-reader cross-rate clip preserves pitch (≈440 Hz)");
}

// ─── main ────────────────────────────────────────────────────────────────────

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit; // message manager for thread pool

    std::cout << "=== test_clip_sr ===\n";
    testRawFallbackCrossRate();
    testMatchedRateClean();
    testCacheHitCrossRate();
    testModulatedReaderCrossRate();

    std::cout << "\n" << g_passed << " checks passed, " << g_failed << " failed\n";
    if (g_failed == 0) { std::cout << "ALL TESTS PASSED\n"; return 0; }
    std::cout << "FAILED\n";
    return 1;
}
