// test_sampler.cpp — Self-verification for the Sampler DSP engine.
// Build: see engine/CMakeLists.txt target "test_sampler"
// Run:   test_sampler.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: ..." and exits 1

#include "audio/Sampler.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <cmath>
#include <iostream>
#include <string>
#include <vector>

// ─── Test harness ────────────────────────────────────────────────────────────

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                 \
    do {                                                                 \
        if (cond) {                                                      \
            ++g_passed;                                                  \
        } else {                                                         \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n";  \
            ++g_failed;                                                  \
        }                                                                \
    } while (0)

#define CHECK_NEAR(a, b, tol, msg) \
    CHECK(std::abs(static_cast<double>(a) - static_cast<double>(b)) < (tol), msg)

// ─── Utilities ───────────────────────────────────────────────────────────────

static constexpr double kEngineSR = 48000.0;

// Generate a stereo sine buffer at a given frequency and length.
static juce::AudioBuffer<float> makeSine(double sampleRate, double freqHz,
                                         int numSamples, float amplitude = 0.5f)
{
    juce::AudioBuffer<float> buf(2, numSamples);
    const double w = 2.0 * juce::MathConstants<double>::pi * freqHz / sampleRate;
    for (int i = 0; i < numSamples; ++i)
    {
        const float s = static_cast<float>(amplitude * std::sin(w * i));
        buf.setSample(0, i, s);
        buf.setSample(1, i, s);
    }
    return buf;
}

// Count zero-crossings (positive → negative or vice versa) on channel 0.
static int countZeroCrossings(const juce::AudioBuffer<float>& buf, int start, int len)
{
    int zc = 0;
    const float* d = buf.getReadPointer(0);
    const int end = std::min(start + len, buf.getNumSamples());
    for (int i = start + 1; i < end; ++i)
        if ((d[i - 1] >= 0.0f) != (d[i] >= 0.0f))
            ++zc;
    return zc;
}

static float peakAbs(const juce::AudioBuffer<float>& buf, int start, int len)
{
    const int end = std::min(start + len, buf.getNumSamples());
    float m = 0.0f;
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        const float* d = buf.getReadPointer(ch);
        for (int i = start; i < end; ++i)
            m = std::max(m, std::abs(d[i]));
    }
    return m;
}

static double rms(const juce::AudioBuffer<float>& buf, int ch)
{
    const int n = buf.getNumSamples();
    if (n <= 0) return 0.0;
    const float* d = buf.getReadPointer(ch);
    double acc = 0.0;
    for (int i = 0; i < n; ++i) acc += d[i] * d[i];
    return std::sqrt(acc / n);
}

// Render `numSamples` frames from the sampler into a fresh stereo buffer.
static juce::AudioBuffer<float> render(Sampler& s, int numSamples, int blockSize = 512)
{
    juce::AudioBuffer<float> out(2, numSamples);
    out.clear();
    int pos = 0;
    while (pos < numSamples)
    {
        const int n = std::min(blockSize, numSamples - pos);
        juce::AudioBuffer<float> slice(out.getArrayOfWritePointers(), 2, pos, n);
        s.processBlock(slice, n, kEngineSR);
        pos += n;
    }
    return out;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

static void testRootPitchPassthrough()
{
    std::cout << "[1] Root-pitch passthrough (440 Hz @ A4)\n";
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));   // 1 s
    Sampler s;
    s.loadSample(src, kEngineSR, 69);      // A4
    s.setADSR(0, 0, 1.0f, 0);
    s.setCrossfadeMode(false);
    s.noteOn(69, 1.0f);
    auto out = render(s, static_cast<int>(kEngineSR));

    // 440 Hz sine → ~880 zero crossings in 1 second.
    const int zc = countZeroCrossings(out, 0, static_cast<int>(kEngineSR));
    CHECK_NEAR(zc, 880, 20, "root pitch zero-crossings ~ 880/s");
    CHECK(peakAbs(out, 0, 1000) > 0.1f, "signal present at root pitch");
}

static void testOctaveUp()
{
    std::cout << "[2] +12 semitones (doubles frequency)\n";
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));   // 1 s
    Sampler s;
    s.loadSample(src, kEngineSR, 69);
    s.setADSR(0, 0, 1.0f, 0);
    s.setCrossfadeMode(false);
    s.noteOn(81, 1.0f);                     // +12 semitones

    // Plays 2× faster, so the 1-second sample finishes in ~0.5 s.
    // Count zero crossings in the first 0.5 s → expect ~880 (2× root rate).
    auto out = render(s, static_cast<int>(kEngineSR * 0.45));
    const int zc = countZeroCrossings(out, 0, static_cast<int>(kEngineSR * 0.45));
    const double zcPerSec = zc / 0.45;
    CHECK_NEAR(zcPerSec, 1760.0, 60.0, "octave-up ~ 1760 zero-crossings/s");
}

static void testOctaveDown()
{
    std::cout << "[3] -12 semitones (halves frequency)\n";
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));   // 1 s
    Sampler s;
    s.loadSample(src, kEngineSR, 69);
    s.setADSR(0, 0, 1.0f, 0);
    s.setCrossfadeMode(false);
    s.noteOn(57, 1.0f);                     // -12 semitones

    // Plays 0.5× speed → takes ~2 s; count in first 1.5 s.
    auto out = render(s, static_cast<int>(kEngineSR * 1.5));
    const int zc = countZeroCrossings(out, 0, static_cast<int>(kEngineSR * 1.5));
    const double zcPerSec = zc / 1.5;
    CHECK_NEAR(zcPerSec, 440.0, 20.0, "octave-down ~ 440 zero-crossings/s");
}

static void testAttackEnvelope()
{
    std::cout << "[4] Attack envelope (100 ms ramp-in)\n";
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));
    Sampler s;
    s.loadSample(src, kEngineSR, 69);
    s.setADSR(100.0f, 0.0f, 1.0f, 0.0f);
    s.setCrossfadeMode(false);
    s.noteOn(69, 1.0f);

    // Render 200 ms. Attack = 100 ms = 4800 samples.
    auto out = render(s, static_cast<int>(kEngineSR * 0.2));

    // First 100 samples: near silent (envelope ≤ 0.02).
    CHECK(peakAbs(out, 0, 100) < 0.05f, "attack: near-silent at t=0");
    // By sample ~4800 (100 ms), envelope should be at full level → peak ≈ 0.5 (sine amplitude).
    CHECK(peakAbs(out, 4700, 200) > 0.4f, "attack: full level at 100 ms");
}

static void testReleaseEnvelope()
{
    std::cout << "[5] Release envelope (sustained mode, 200 ms release)\n";
    // Long sample (1 s) so noteOff happens well before end-of-sample.
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));
    Sampler s;
    s.loadSample(src, kEngineSR, 69);
    s.setADSR(0.0f, 0.0f, 1.0f, 200.0f);
    s.setCrossfadeMode(true);   // sustained mode → noteOff honored
    s.noteOn(69, 1.0f);

    // Render 100 ms, then noteOff, then render 400 ms more.
    juce::AudioBuffer<float> out(2, static_cast<int>(kEngineSR * 0.5));
    out.clear();
    juce::AudioBuffer<float> part1(out.getArrayOfWritePointers(), 2, 0,
                                   static_cast<int>(kEngineSR * 0.1));
    s.processBlock(part1, part1.getNumSamples(), kEngineSR);
    s.noteOff(69);
    juce::AudioBuffer<float> part2(out.getArrayOfWritePointers(), 2,
                                   static_cast<int>(kEngineSR * 0.1),
                                   static_cast<int>(kEngineSR * 0.4));
    s.processBlock(part2, part2.getNumSamples(), kEngineSR);

    // Before release: full level.
    CHECK(peakAbs(out, 0, static_cast<int>(kEngineSR * 0.1)) > 0.3f,
          "release: signal present before noteOff");
    // 100 ms into release (still mid-ramp): partial signal.
    CHECK(peakAbs(out, static_cast<int>(kEngineSR * 0.2),
                  static_cast<int>(kEngineSR * 0.01)) > 0.05f,
          "release: audible 100 ms into release");
    // Well after release (300 ms in — 100 ms past release end): silent.
    CHECK(peakAbs(out, static_cast<int>(kEngineSR * 0.4),
                  static_cast<int>(kEngineSR * 0.05)) < 0.02f,
          "release: silent 100 ms after release ends");
}

static void testOneShotIgnoresNoteOff()
{
    std::cout << "[6] One-shot ignores noteOff\n";
    // 50 ms sample.
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR * 0.05));
    Sampler s;
    s.loadSample(src, kEngineSR, 69);
    s.setADSR(0, 0, 1.0f, 0);
    s.setCrossfadeMode(false);    // one-shot — noteOff is IGNORED
    s.noteOn(69, 1.0f);
    s.noteOff(69);                // should be no-op

    // Render 100 ms. Sample should play through the full 50 ms.
    auto out = render(s, static_cast<int>(kEngineSR * 0.1));
    // Signal should be present throughout the 50 ms window.
    CHECK(peakAbs(out, 0, static_cast<int>(kEngineSR * 0.04)) > 0.2f,
          "one-shot: still playing at 40 ms after noteOff");
}

static void testSustainedLoop()
{
    std::cout << "[7] Sustained + loop (sample loops seamlessly)\n";
    // 100 ms sample.
    const int srcLen = static_cast<int>(kEngineSR * 0.1);
    auto src = makeSine(kEngineSR, 440.0, srcLen);
    Sampler s;
    s.loadSample(src, kEngineSR, 69);
    s.setADSR(0, 0, 1.0f, 0);
    s.setCrossfadeMode(true);
    s.setLoopPoints(true, 0, srcLen);
    s.noteOn(69, 1.0f);

    // Render 500 ms → sample loops 5×.
    auto out = render(s, static_cast<int>(kEngineSR * 0.5));

    // At 400 ms (4 loops in), output should still be present.
    CHECK(peakAbs(out, static_cast<int>(kEngineSR * 0.4),
                  static_cast<int>(kEngineSR * 0.05)) > 0.2f,
          "loop: signal present after 4 loops");
    // Counts of zero crossings should track 440 Hz across the whole window.
    const int zc = countZeroCrossings(out, 0, static_cast<int>(kEngineSR * 0.5));
    const double zcPerSec = zc / 0.5;
    CHECK_NEAR(zcPerSec, 880.0, 80.0, "loop: frequency preserved");
}

static void testPolyphony()
{
    std::cout << "[8] Polyphony (8 voices)\n";
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));
    Sampler s;
    s.loadSample(src, kEngineSR, 69);
    s.setADSR(0, 0, 1.0f, 0);
    s.setCrossfadeMode(false);

    for (int pitch = 60; pitch < 68; ++pitch) s.noteOn(pitch, 0.25f);
    CHECK(s.activeVoiceCount() == 8, "8 voices active");

    auto out = render(s, static_cast<int>(kEngineSR * 0.1));
    // Signal present on both channels, peak bounded.
    CHECK(peakAbs(out, 0, static_cast<int>(kEngineSR * 0.05)) > 0.2f,
          "polyphony: audible signal");
    CHECK(peakAbs(out, 0, static_cast<int>(kEngineSR * 0.05)) < 4.0f,
          "polyphony: peak bounded");
    CHECK(rms(out, 0) > 0.05, "polyphony: non-zero RMS L");
    CHECK(rms(out, 1) > 0.05, "polyphony: non-zero RMS R");
}

static void testVoiceStealing()
{
    std::cout << "[9] Voice stealing (33 rapid triggers don't crash)\n";
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));
    Sampler s;
    s.loadSample(src, kEngineSR, 69);
    s.setADSR(0, 0, 1.0f, 0);
    s.setCrossfadeMode(false);

    for (int i = 0; i < 33; ++i) s.noteOn(60 + (i % 12), 0.3f);
    CHECK(s.activeVoiceCount() <= 32, "voice count capped at MAX_VOICES");
    // Should render without crashing.
    auto out = render(s, 1024);
    CHECK(peakAbs(out, 0, 1024) > 0.0f, "voice-steal: audio rendered");
}

// ─── Main ────────────────────────────────────────────────────────────────────

int main()
{
    // JUCE MessageManager required for some AudioFormatManager use, not strictly
    // needed here but kept for safety parity with test_mix.
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "Running Sampler tests...\n\n";

    testRootPitchPassthrough();
    testOctaveUp();
    testOctaveDown();
    testAttackEnvelope();
    testReleaseEnvelope();
    testOneShotIgnoresNoteOff();
    testSustainedLoop();
    testPolyphony();
    testVoiceStealing();

    std::cout << "\n";
    if (g_failed == 0)
    {
        std::cout << "ALL TESTS PASSED (" << g_passed << " checks)\n";
        return 0;
    }
    std::cerr << "FAILED: " << g_failed << " / " << (g_passed + g_failed)
              << " checks\n";
    return 1;
}
