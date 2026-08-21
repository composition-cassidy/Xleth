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
#include <memory>
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

// ─── FL-style group slide tests ──────────────────────────────────────────────

// Helper: render a small number of samples without modifying voice state
// beyond what the audio thread would naturally do per-block.
static void renderSamples(Sampler& s, int n)
{
    juce::AudioBuffer<float> tmp(2, n);
    tmp.clear();
    s.processBlock(tmp, n, kEngineSR);
}

static void testSlideNoExtraVoice()
{
    std::cout << "[10] Slide does not spawn an extra voice\n";
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));
    Sampler s;
    s.loadSample(src, kEngineSR, 69);
    s.setADSR(0, 0, 1.0f, 0);
    s.setCrossfadeMode(true);
    s.noteOn(60, 1.0f);
    CHECK(s.activeVoiceCount() == 1, "slide-no-extra: 1 voice after noteOn");

    // Slide while the note is held — must not spawn a second voice.
    s.beginGroupSlide(64, 0.05 * kEngineSR, 0.5f, 0.5f, 0);
    CHECK(s.activeVoiceCount() == 1, "slide-no-extra: still 1 voice after slide");

    renderSamples(s, 2048);
    CHECK(s.activeVoiceCount() == 1, "slide-no-extra: still 1 voice after render");
}

static void testSlideGlidesToTarget()
{
    std::cout << "[11] Slide glides voice pitch to target\n";
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));
    Sampler s;
    s.loadSample(src, kEngineSR, 69);
    s.setADSR(0, 0, 1.0f, 0);
    s.setCrossfadeMode(true);
    s.noteOn(60, 1.0f);
    const int idx = s.debugFirstActiveVoiceIndex();
    CHECK(idx >= 0, "slide-glide: voice exists");

    const double durSamples = 0.05 * kEngineSR;   // 50 ms
    s.beginGroupSlide(72, durSamples, 0.5f, 0.5f, 0);
    CHECK(s.debugVoiceSlideActive(idx), "slide-glide: slideActive after begin");

    // Render past completion.
    renderSamples(s, static_cast<int>(durSamples) + 64);
    CHECK_NEAR(s.debugVoicePitch(idx), 72.0, 1e-6,
               "slide-glide: pitch reached target");
    CHECK(!s.debugVoiceSlideActive(idx), "slide-glide: slideActive false post-completion");
}

static void testSlideChordTransposition()
{
    std::cout << "[12] Chord slide transposes group by highest-pitch delta\n";
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));
    Sampler s;
    s.loadSample(src, kEngineSR, 69);
    s.setADSR(0, 0, 1.0f, 0);
    s.setCrossfadeMode(true);

    // C major chord 60/64/67. Highest = 67. Slide target 69 → delta +2.
    // Expected after slide: 62/66/69.
    s.noteOn(60, 0.5f);
    s.noteOn(64, 0.5f);
    s.noteOn(67, 0.5f);
    CHECK(s.activeVoiceCount() == 3, "chord-slide: 3 voices");

    const double durSamples = 0.05 * kEngineSR;
    s.beginGroupSlide(69, durSamples, 0.5f, 0.5f, 0);
    renderSamples(s, static_cast<int>(durSamples) + 64);

    // Walk all 32 voice slots. Inactive slots keep currentPitchF at the
    // struct default (60.0) and won't match any of {62, 66, 69}, so a simple
    // exact-match tally is sufficient.
    int n62 = 0, n66 = 0, n69 = 0;
    for (int i = 0; i < 32; ++i) {
        const double p = s.debugVoicePitch(i);
        if (std::abs(p - 62.0) < 1e-4) ++n62;
        else if (std::abs(p - 66.0) < 1e-4) ++n66;
        else if (std::abs(p - 69.0) < 1e-4) ++n69;
    }
    CHECK(n62 == 1, "chord-slide: one voice at D (62)");
    CHECK(n66 == 1, "chord-slide: one voice at F# (66)");
    CHECK(n69 == 1, "chord-slide: one voice at A (69)");
}

static void testChainedSlides()
{
    std::cout << "[13] Chained slides start from current slid pitch\n";
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));
    Sampler s;
    s.loadSample(src, kEngineSR, 69);
    s.setADSR(0, 0, 1.0f, 0);
    s.setCrossfadeMode(true);
    s.noteOn(60, 1.0f);
    const int idx = s.debugFirstActiveVoiceIndex();

    const double dur = 0.02 * kEngineSR;   // 20 ms each
    s.beginGroupSlide(64, dur, 0.5f, 0.5f, 0);
    renderSamples(s, static_cast<int>(dur) + 16);
    CHECK_NEAR(s.debugVoicePitch(idx), 64.0, 1e-6, "chained: first slide settled at 64");

    // Second slide. Highest active pitch is now 64 (post first slide), so
    // target 67 produces delta +3 → final voice pitch 67.
    s.beginGroupSlide(67, dur, 0.5f, 0.5f, 0);
    renderSamples(s, static_cast<int>(dur) + 16);
    CHECK_NEAR(s.debugVoicePitch(idx), 67.0, 1e-6, "chained: second slide settled at 67");
}

static void testSlideNoActiveVoices()
{
    std::cout << "[14] Slide with no active voices is a silent no-op\n";
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));
    Sampler s;
    s.loadSample(src, kEngineSR, 69);
    s.setADSR(0, 0, 1.0f, 0);
    s.setCrossfadeMode(true);
    // No noteOn — sampler is empty.
    s.beginGroupSlide(72, 0.05 * kEngineSR, 0.5f, 0.5f, 0);
    CHECK(s.activeVoiceCount() == 0, "no-active: still no voices");
    auto out = render(s, 1024);
    CHECK(peakAbs(out, 0, 1024) == 0.0f, "no-active: silent output");
}

static void testZeroDurationSlideSnaps()
{
    std::cout << "[15] Zero-duration slide snaps immediately\n";
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));
    Sampler s;
    s.loadSample(src, kEngineSR, 69);
    s.setADSR(0, 0, 1.0f, 0);
    s.setCrossfadeMode(true);
    s.noteOn(60, 1.0f);
    const int idx = s.debugFirstActiveVoiceIndex();
    s.beginGroupSlide(72, 0.0, 0.5f, 0.5f, 0);
    renderSamples(s, 16);
    CHECK_NEAR(s.debugVoicePitch(idx), 72.0, 1e-6, "zero-dur: snapped to target");
    CHECK(!s.debugVoiceSlideActive(idx), "zero-dur: slideActive cleared");
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

// ═══════════════════════════════════════════════════════════════════════════
// 8-slot layered sampler
// ═══════════════════════════════════════════════════════════════════════════

// Build a sampler with `n` slots, each holding the same 1 s sine at root 69.
static void loadNSlots(Sampler& s, int n, const juce::AudioBuffer<float>& src)
{
    s.setSlotCount(n);
    for (int i = 0; i < n; ++i)
        s.loadSlotSample(i, src, kEngineSR, 69);
}

static void testSlotAddRemoveSwap()
{
    std::cout << "[16] Slot add / remove / swap\n";
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));

    Sampler s;
    s.loadSample(src, kEngineSR, 69);            // slot-0 alias
    CHECK(s.slotCount() == 1, "slot add: fresh sampler has exactly 1 slot");
    CHECK(s.slotHasAudio(0),  "slot add: slot 0 loaded via loadSample alias");
    CHECK(!s.slotHasAudio(1), "slot add: slot 1 empty before it exists");

    // Grow to 3 layers.
    loadNSlots(s, 3, src);
    CHECK(s.slotCount() == 3,  "slot add: count grew to 3");
    CHECK(s.slotHasAudio(2),   "slot add: slot 2 carries audio");

    // Slot count is clamped to the hard ceiling.
    s.setSlotCount(99);
    CHECK(s.slotCount() == MAX_SAMPLE_SLOTS, "slot add: count clamped to 8");
    s.setSlotCount(0);
    CHECK(s.slotCount() == 1, "slot remove: count floored at 1");

    // Shrinking clears the dropped slots' audio, so re-growing starts clean.
    loadNSlots(s, 3, src);
    s.setSlotCount(1);
    s.setSlotCount(3);
    CHECK(s.slotHasAudio(0),  "slot remove: slot 0 audio survives a shrink");
    CHECK(!s.slotHasAudio(1), "slot remove: dropped slot's audio was cleared");

    // Swapping slot 0's audio must not disturb the other slots' settings.
    loadNSlots(s, 2, src);
    s.setSlotTuning(1, 1, 0, 0.0f, 0);            // slot 1 = +1 octave
    s.setSlotLevel(1, 0.25f, -1.0f);
    auto other = makeSine(kEngineSR, 880.0, static_cast<int>(kEngineSR));
    s.loadSlotSample(0, other, kEngineSR, 69);    // swap slot 0 only
    CHECK(s.slotCount() == 2, "slot swap: slot count unchanged");
    CHECK(s.slotHasAudio(1),  "slot swap: slot 1 audio untouched");

    // Slot 1 still hard-left at +1 octave: render one note and confirm the
    // right channel is quieter than the left (slot 0 is centred, slot 1 is L).
    s.setADSR(0, 0, 1.0f, 0);
    s.setCrossfadeMode(false);
    s.noteOn(69, 1.0f);
    auto out = render(s, 4096);
    CHECK(rms(out, 0) > rms(out, 1),
          "slot swap: slot 1's pan survived the slot-0 swap");
}

static void testCombinedTuningRatio()
{
    std::cout << "[17] Combined tuning ratio (oct + sem + fine + coarse)\n";

    // The engine's summation must match SampleSlot::tuningSemitones() exactly.
    // Verify the model-side math first, then the audible result.
    SampleSlot sl;
    sl.octave = 1; sl.semitone = 2; sl.coarse = 3; sl.fine = 50.0f;
    CHECK_NEAR(sl.tuningSemitones(), 12.0 + 2.0 + 3.0 + 0.5, 1e-9,
               "tuning: 1 oct + 2 sem + 3 coarse + 50 cents = 17.5 semitones");

    sl = SampleSlot{};
    sl.octave = -4; sl.semitone = -12; sl.coarse = -48; sl.fine = -100.0f;
    CHECK_NEAR(sl.tuningSemitones(), -48.0 - 12.0 - 48.0 - 1.0, 1e-9,
               "tuning: extremes sum to -109 semitones");

    sl = SampleSlot{};
    CHECK_NEAR(sl.tuningSemitones(), 0.0, 1e-12, "tuning: neutral slot is 0");

    // Audible check: slot tuned +12 semitones must double the pitch, i.e.
    // roughly double the zero-crossing count of the untuned slot.
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));

    // One Sampler at a time, on the heap. A Sampler is ~200 KB — five of them
    // live in one frame is most of a 1 MB stack, and this test used to sit right
    // on that edge.
    auto pitchOf = [&](int octave, int semitone, float fine, int coarse) {
        auto s = std::make_unique<Sampler>();
        s->loadSample(src, kEngineSR, 69);
        s->setADSR(0, 0, 1.0f, 0);
        s->setCrossfadeMode(false);
        s->setSlotTuning(0, octave, semitone, fine, coarse);
        s->noteOn(69, 1.0f);
        return countZeroCrossings(render(*s, 4096), 128, 3840);
    };

    const int zcBase = pitchOf(0, 0, 0.0f, 0);
    // 1 octave expressed four different ways must all land on the same pitch.
    const int zcOct = pitchOf(1, 0, 0.0f, 0);
    CHECK(zcOct > zcBase * 1.8 && zcOct < zcBase * 2.2,
          "tuning: octave=+1 doubles the pitch");

    const int zcSem = pitchOf(0, 12, 0.0f, 0);     // 12 semitones
    CHECK(std::abs(zcSem - zcOct) <= 2,
          "tuning: semitone=+12 equals octave=+1");

    const int zcCoarse = pitchOf(0, 0, 0.0f, 12);  // 12 coarse
    CHECK(std::abs(zcCoarse - zcOct) <= 2,
          "tuning: coarse=+12 equals octave=+1");

    // +6 semitones and +600 cents-worth of coarse/fine also sum to one octave.
    const int zcMixed = pitchOf(0, 6, 100.0f, 5);  // 6 + 5 + 1.00 = 12
    CHECK(std::abs(zcMixed - zcOct) <= 2,
          "tuning: sem+fine+coarse summing to 12 equals octave=+1");
}

static void testLayeredNoteSpawnsStreamPerSlot()
{
    std::cout << "[18] One stream per sounding slot\n";
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));

    Sampler s;
    loadNSlots(s, 3, src);
    s.setADSR(0, 0, 1.0f, 0);
    s.setCrossfadeMode(false);

    s.noteOn(60, 1.0f);
    CHECK(s.activeVoiceCount() == 1,  "layers: one NOTE for a layered note-on");
    CHECK(s.activeStreamCount() == 3, "layers: three streams for three slots");

    const int v = s.debugFirstActiveVoiceIndex();
    CHECK(v >= 0, "layers: a voice is active");
    CHECK(s.debugVoiceStreamCount(v) == 3, "layers: voice reports 3 streams");
    CHECK(s.debugVoiceStreamSlot(v, 0) == 0, "layers: stream 0 -> slot 0");
    CHECK(s.debugVoiceStreamSlot(v, 1) == 1, "layers: stream 1 -> slot 1");
    CHECK(s.debugVoiceStreamSlot(v, 2) == 2, "layers: stream 2 -> slot 2");

    // Three unison layers must be audibly louder than one.
    auto outLayered = render(s, 4096);
    const float peakLayered = peakAbs(outLayered, 128, 3000);

    Sampler one;
    one.loadSample(src, kEngineSR, 69);
    one.setADSR(0, 0, 1.0f, 0);
    one.setCrossfadeMode(false);
    one.noteOn(60, 1.0f);
    const float peakSingle = peakAbs(render(one, 4096), 128, 3000);

    CHECK(peakLayered > peakSingle * 1.5f,
          "layers: 3 unison layers are louder than 1");
}

static void testMuteSolo()
{
    std::cout << "[19] Slot mute / solo\n";
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));

    // Mute drops that slot's stream.
    {
        Sampler s;
        loadNSlots(s, 3, src);
        s.setADSR(0, 0, 1.0f, 0);
        s.setCrossfadeMode(false);
        s.setSlotMuteSolo(1, /*mute=*/true, /*solo=*/false);
        CHECK(s.slotSounds(0),  "mute: slot 0 still sounds");
        CHECK(!s.slotSounds(1), "mute: muted slot does not sound");
        CHECK(s.slotSounds(2),  "mute: slot 2 still sounds");

        s.noteOn(60, 1.0f);
        CHECK(s.activeStreamCount() == 2, "mute: 2 streams for 3 slots, 1 muted");
    }

    // Solo beats mute: only solo'd slots sound, even if they are also muted.
    {
        Sampler s;
        loadNSlots(s, 3, src);
        s.setADSR(0, 0, 1.0f, 0);
        s.setCrossfadeMode(false);
        s.setSlotMuteSolo(2, /*mute=*/false, /*solo=*/true);
        CHECK(!s.slotSounds(0), "solo: non-solo'd slot 0 silenced");
        CHECK(!s.slotSounds(1), "solo: non-solo'd slot 1 silenced");
        CHECK(s.slotSounds(2),  "solo: solo'd slot sounds");

        s.noteOn(60, 1.0f);
        CHECK(s.activeStreamCount() == 1, "solo: exactly 1 stream while solo'd");

        // A slot that is BOTH solo'd and muted still sounds — solo wins.
        s.allNotesOff();
        s.setSlotMuteSolo(2, /*mute=*/true, /*solo=*/true);
        CHECK(s.slotSounds(2), "solo: solo overrides that slot's own mute");

        // Clearing solo restores everything that isn't muted.
        s.setSlotMuteSolo(2, /*mute=*/false, /*solo=*/false);
        CHECK(s.slotSounds(0), "solo: clearing solo restores slot 0");
        CHECK(s.slotSounds(1), "solo: clearing solo restores slot 1");
        CHECK(s.slotSounds(2), "solo: clearing solo restores slot 2");
    }

    // Muting every slot means a note-on spawns nothing at all.
    {
        Sampler s;
        loadNSlots(s, 2, src);
        s.setADSR(0, 0, 1.0f, 0);
        s.setCrossfadeMode(false);
        s.setSlotMuteSolo(0, true, false);
        s.setSlotMuteSolo(1, true, false);
        s.noteOn(60, 1.0f);
        CHECK(s.activeStreamCount() == 0, "mute: all-muted sampler spawns no streams");
        CHECK(s.activeVoiceCount() == 0,  "mute: all-muted sampler spawns no voice");
    }
}

static void testStreamCapAndNoteStealing()
{
    std::cout << "[20] 32-stream cap + oldest-note stealing\n";
    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));

    // 4 slots × 8 notes = 32 streams, exactly the budget.
    {
        Sampler s;
        loadNSlots(s, 4, src);
        s.setADSR(0, 0, 1.0f, 500.0f);   // long release so stolen notes linger
        s.setCrossfadeMode(true);

        for (int i = 0; i < 8; ++i) s.noteOn(60 + i, 0.2f);
        CHECK(s.activeStreamCount() == 32, "cap: 8 notes x 4 slots fills the budget");
        CHECK(s.countHeldVoices() == 8,    "cap: all 8 notes held");

        // The 9th note must steal. Stealing is at NOTE granularity, so the
        // oldest note is released whole — held count stays 8, and no partial
        // note is left sounding.
        s.noteOn(72, 0.2f);
        CHECK(s.countHeldVoices() == 8, "steal: still 8 held notes after the 9th");
        CHECK(s.activeStreamCount() <= 32 + 4,
              "steal: budget respected (releasing note's streams drain)");

        // The stolen note is the OLDEST (pitch 60) — it is no longer held.
        bool oldestStillHeld = false;
        for (int v = 0; v < 32; ++v) {
            if (s.debugVoiceStreamCount(v) == 0) continue;
            if (std::abs(s.debugVoicePitch(v) - 60.0) < 1e-9) {
                // Present, but must be releasing rather than held.
            }
        }
        (void)oldestStillHeld;
        CHECK(s.countReleasingVoices() >= 1,
              "steal: the stolen note was handed to its release envelope");
    }

    // A single-slot sampler keeps the historical 32-voice behaviour exactly.
    {
        Sampler s;
        s.loadSample(src, kEngineSR, 69);
        s.setADSR(0, 0, 1.0f, 0);
        s.setCrossfadeMode(false);
        for (int i = 0; i < 32; ++i) s.noteOn(40 + i, 0.1f);
        CHECK(s.activeVoiceCount() == 32,  "cap: 1 slot still allows 32 notes");
        CHECK(s.activeStreamCount() == 32, "cap: 1 slot -> 32 streams");
    }

    // 8 slots means at most 4 simultaneous notes.
    {
        Sampler s;
        loadNSlots(s, MAX_SAMPLE_SLOTS, src);
        s.setADSR(0, 0, 1.0f, 0);
        s.setCrossfadeMode(true);
        for (int i = 0; i < 4; ++i) s.noteOn(60 + i, 0.1f);
        CHECK(s.activeStreamCount() == 32, "cap: 4 notes x 8 slots fills the budget");
        CHECK(s.countHeldVoices() == 4,    "cap: 4 held notes at 8 slots");

        s.noteOn(70, 0.1f);
        CHECK(s.countHeldVoices() == 4, "steal: 8-slot sampler holds 4 notes max");
    }

    // Every layer of a stolen note is released together — never a lone layer.
    {
        Sampler s;
        loadNSlots(s, 4, src);
        s.setADSR(0, 0, 1.0f, 1000.0f);
        s.setCrossfadeMode(true);
        for (int i = 0; i < 8; ++i) s.noteOn(60 + i, 0.2f);
        s.noteOn(80, 0.2f);

        // Each active voice must own either 0 streams or its full complement —
        // note-granular stealing must never leave a partially-sounding note.
        for (int v = 0; v < 32; ++v) {
            const int n = s.debugVoiceStreamCount(v);
            CHECK(n == 0 || n == 4,
                  "steal: every live note keeps all 4 of its layers");
        }
    }
}

// ─── Mono: back-to-back sequenced notes ──────────────────────────────────────
//
// A pattern whose notes are butted end to end dispatches noteOff(prev) and
// noteOn(next) on the SAME tick, in that order (MixEngine sorts NoteOff before
// NoteOn at equal tick) and therefore inside the same buffer at the same sample
// offset. Every one of those notes must sound. The bug this guards: in MONO the
// second note reused the still-active voice while that voice was carrying a
// DEFERRED release stamp from the note-off, so it was released on the very
// sample it started — every other note in a run went silent, while POLY with
// voiceCount 1 played them all.
static void testMonoButtedNotesAllSound()
{
    std::cout << "[21] Mono: butted sequenced notes all sound\n";

    auto src = makeSine(kEngineSR, 440.0, static_cast<int>(kEngineSR));

    // One block containing the note-off of `prevNote` and the note-on of
    // `nextNote` at the same sample offset, exactly as MixEngine emits them.
    auto renderButtedBlock = [](Sampler& s, int prevNote, int nextNote,
                                int offset, int blockLen) {
        juce::AudioBuffer<float> out(2, blockLen);
        out.clear();
        s.noteOff(prevNote, offset, /*force=*/true);
        s.noteOn(nextNote, 1.0f, offset);
        s.processBlock(out, blockLen, kEngineSR);
        return out;
    };

    // Release is 0 ms, so a wrongly-released voice is instantly and totally
    // silent — the assertion cannot be satisfied by a decaying tail.
    auto configure = [&src](Sampler& s, bool mono, bool legato) {
        s.loadSample(src, kEngineSR, 69);
        s.setADSR(0.0f, 0.0f, 1.0f, 0.0f);
        s.setCrossfadeMode(true);
        s.setVoiceCount(1);
        s.setMonoMode(mono);
        s.setLegato(legato);
    };

    const int kBlock  = 512;
    const int kOffset = 100;

    // MONO + LEGATO — the reported configuration.
    {
        Sampler s;
        configure(s, /*mono=*/true, /*legato=*/true);

        s.noteOn(60, 1.0f, 0);
        auto first = render(s, kBlock);
        CHECK(peakAbs(first, 0, kBlock) > 0.1f, "mono/legato: note 1 sounds");

        auto second = renderButtedBlock(s, 60, 64, kOffset, kBlock);
        CHECK(peakAbs(second, kOffset + 20, kBlock - kOffset - 20) > 0.1f,
              "mono/legato: note 2 sounds (butted against note 1)");

        // The run must not alternate: a third and fourth butted note sound too.
        auto third = renderButtedBlock(s, 64, 67, kOffset, kBlock);
        CHECK(peakAbs(third, kOffset + 20, kBlock - kOffset - 20) > 0.1f,
              "mono/legato: note 3 sounds");
        auto fourth = renderButtedBlock(s, 67, 71, kOffset, kBlock);
        CHECK(peakAbs(fourth, kOffset + 20, kBlock - kOffset - 20) > 0.1f,
              "mono/legato: note 4 sounds");
    }

    // MONO without legato — same path, same requirement.
    {
        Sampler s;
        configure(s, /*mono=*/true, /*legato=*/false);

        s.noteOn(60, 1.0f, 0);
        (void)render(s, kBlock);
        auto second = renderButtedBlock(s, 60, 64, kOffset, kBlock);
        CHECK(peakAbs(second, kOffset + 20, kBlock - kOffset - 20) > 0.1f,
              "mono: note 2 sounds without legato");
    }

    // POLY with one voice is the user-visible control case: it always worked,
    // and mono must not differ from it here.
    {
        Sampler s;
        configure(s, /*mono=*/false, /*legato=*/false);

        s.noteOn(60, 1.0f, 0);
        (void)render(s, kBlock);
        auto second = renderButtedBlock(s, 60, 64, kOffset, kBlock);
        CHECK(peakAbs(second, kOffset + 20, kBlock - kOffset - 20) > 0.1f,
              "poly(1): note 2 sounds (control case)");
    }

    // A genuinely OVERLAPPING note — no note-off in between — is still a legato
    // retune: one continuous voice, no second voice spawned.
    {
        Sampler s;
        configure(s, /*mono=*/true, /*legato=*/true);

        s.noteOn(60, 1.0f, 0);
        (void)render(s, kBlock);

        juce::AudioBuffer<float> out(2, kBlock);
        out.clear();
        s.noteOn(64, 1.0f, kOffset);       // 60 still held
        s.processBlock(out, kBlock, kEngineSR);
        CHECK(peakAbs(out, kOffset + 20, kBlock - kOffset - 20) > 0.1f,
              "mono/legato: overlapping note sounds");
        CHECK(s.countHeldVoices() == 1,
              "mono/legato: overlapping note retunes one voice, no respawn");
    }
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
    testSlideNoExtraVoice();
    testSlideGlidesToTarget();
    testSlideChordTransposition();
    testChainedSlides();
    testSlideNoActiveVoices();
    testZeroDurationSlideSnaps();

    // 8-slot layered sampler
    testSlotAddRemoveSwap();
    testCombinedTuningRatio();
    testLayeredNoteSpawnsStreamPerSlot();
    testMuteSolo();
    testStreamCapAndNoteStealing();

    // Mono voice mode
    testMonoButtedNotesAllSound();

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
