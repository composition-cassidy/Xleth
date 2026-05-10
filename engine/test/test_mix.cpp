// test_mix.cpp — Phase 1 self-verification for multi-track MixEngine.
// Build: see engine/CMakeLists.txt target "test_mix"
// Run:   test_mix.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1

#include "audio/MixEngine.h"
#include "audio/TrackMixer.h"
#include "audio/XlethEQEffect.h"
#include "model/Timeline.h"
#include "SampleBank.h"
#include "Transport.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <array>
#include <cstdint>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <limits>
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

// ─── Utility: generate a synthetic WAV file ──────────────────────────────────
// Creates a mono WAV with a sine wave burst at the given frequency.

static juce::File generateWav(const juce::File& dir, const juce::String& name,
                               double sampleRate, int numSamples, float freq, float amplitude)
{
    juce::AudioBuffer<float> buf(1, numSamples);
    float* data = buf.getWritePointer(0);
    for (int i = 0; i < numSamples; ++i)
    {
        const double t = static_cast<double>(i) / sampleRate;
        data[i] = amplitude * static_cast<float>(std::sin(2.0 * juce::MathConstants<double>::pi * freq * t));
    }

    juce::File file = dir.getChildFile(name + ".wav");
    file.deleteFile();

    auto outStream = std::unique_ptr<juce::FileOutputStream>(file.createOutputStream());
    if (outStream == nullptr) return {};

    juce::WavAudioFormat wavFmt;
    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFmt.createWriterFor(outStream.get(), sampleRate, 1, 16, {}, 0));
    if (writer == nullptr) return {};
    outStream.release(); // writer takes ownership

    writer->writeFromAudioSampleBuffer(buf, 0, numSamples);
    writer.reset(); // flush + close

    return file;
}

static juce::File generateImpulseWav(const juce::File& dir, const juce::String& name,
                                     double sampleRate, int numSamples,
                                     int impulseIndex, float amplitude)
{
    juce::AudioBuffer<float> buf(1, numSamples);
    buf.clear();

    if (impulseIndex >= 0 && impulseIndex < numSamples)
        buf.setSample(0, impulseIndex, amplitude);

    juce::File file = dir.getChildFile(name + ".wav");
    file.deleteFile();

    auto outStream = std::unique_ptr<juce::FileOutputStream>(file.createOutputStream());
    if (outStream == nullptr) return {};

    juce::WavAudioFormat wavFmt;
    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFmt.createWriterFor(outStream.get(), sampleRate, 1, 16, {}, 0));
    if (writer == nullptr) return {};
    outStream.release();

    writer->writeFromAudioSampleBuffer(buf, 0, numSamples);
    writer.reset();

    return file;
}

static juce::File makeTempTestDir(const juce::String& prefix)
{
    auto dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                   .getChildFile(prefix + "_" + juce::String::toHexString(
                       static_cast<juce::int64>(juce::Time::currentTimeMillis())));
    dir.createDirectory();
    return dir;
}

static int findPeakIndex(const juce::AudioBuffer<float>& buf, int channel)
{
    int peakIndex = 0;
    float peakValue = -1.0f;
    const int numSamples = buf.getNumSamples();
    for (int i = 0; i < numSamples; ++i)
    {
        const float value = std::abs(buf.getSample(channel, i));
        if (value > peakValue)
        {
            peakValue = value;
            peakIndex = i;
        }
    }
    return peakIndex;
}

static float maxAbsInRange(const juce::AudioBuffer<float>& buf, int channel,
                           int startSample, int numSamples)
{
    if (numSamples <= 0 || startSample >= buf.getNumSamples())
        return 0.0f;

    const int clampedStart = std::max(0, startSample);
    const int clampedEnd = std::min(buf.getNumSamples(), clampedStart + numSamples);
    float peak = 0.0f;
    for (int i = clampedStart; i < clampedEnd; ++i)
        peak = std::max(peak, std::abs(buf.getSample(channel, i)));
    return peak;
}

static bool allSamplesFinite(const juce::AudioBuffer<float>& buf)
{
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
    {
        for (int i = 0; i < buf.getNumSamples(); ++i)
        {
            if (!std::isfinite(buf.getSample(ch, i)))
                return false;
        }
    }
    return true;
}

static double sampleToBeats(int64_t sample, double sampleRate, double bpm)
{
    return (static_cast<double>(sample) * bpm) / (60.0 * sampleRate);
}

static void addTwoTrackImpulseClips(Timeline& timeline, int64_t clipStartSample,
                                    double sampleRate, double bpm,
                                    int& dryTrackId, int& wetTrackId,
                                    int& dryRegionId, int& wetRegionId)
{
    TrackInfo dryTrack; dryTrack.name = "Dry";
    TrackInfo wetTrack; wetTrack.name = "Wet";
    dryTrackId = timeline.addTrack(dryTrack);
    wetTrackId = timeline.addTrack(wetTrack);

    SampleRegion dryRegion; dryRegion.name = "DryImpulse"; dryRegion.label = SampleLabel::Custom;
    SampleRegion wetRegion; wetRegion.name = "WetImpulse"; wetRegion.label = SampleLabel::Custom;
    dryRegionId = timeline.addRegion(dryRegion);
    wetRegionId = timeline.addRegion(wetRegion);

    const double clipBeat = sampleToBeats(clipStartSample, sampleRate, bpm);
    Clip dryClip; dryClip.trackId = dryTrackId; dryClip.regionId = dryRegionId;
    dryClip.position = TickTime::fromBeats(clipBeat);
    dryClip.duration = TickTime::fromBeats(1.0);
    Clip wetClip = dryClip; wetClip.trackId = wetTrackId; wetClip.regionId = wetRegionId;
    timeline.addClip(dryClip);
    timeline.addClip(wetClip);
}

static juce::AudioBuffer<float> renderTrimmedRange(MixEngine& engine, Transport& transport,
                                                   int64_t startSample, int64_t endSample,
                                                   double sampleRate, double bpm,
                                                   int blockSize = 512)
{
    const auto latencySnapshot = engine.getLatencyCompensationSnapshot();
    const int64_t requestedDuration = endSample - startSample;
    const int64_t totalPrerollSamples =
        static_cast<int64_t>(latencySnapshot.maxAudibleTrackLatencySamples)
        + static_cast<int64_t>(latencySnapshot.masterInsertLatencySamples);
    const int64_t historyPreroll = std::min(startSample, totalPrerollSamples);
    const int64_t renderStart = startSample - historyPreroll;
    const int64_t totalDiscard = historyPreroll + totalPrerollSamples;
    const int64_t renderSamplesNeeded = requestedDuration + totalDiscard;
    const int64_t renderEnd = renderStart + renderSamplesNeeded;

    juce::AudioBuffer<float> output(2, static_cast<int>(requestedDuration));
    output.clear();

    transport.setSampleRate(sampleRate);
    transport.setBPM(bpm);
    transport.seekToSample(renderStart);
    transport.play();

    int64_t currentSample = renderStart;
    int64_t writtenSamples = 0;
    int64_t discardSamples = totalDiscard;

    while (currentSample < renderEnd && writtenSamples < requestedDuration)
    {
        const int thisBlockSize = static_cast<int>(
            std::min<int64_t>(blockSize, renderEnd - currentSample));

        juce::AudioBuffer<float> block(2, thisBlockSize);
        block.clear();
        engine.processBlock(block, thisBlockSize, transport);

        const int discardThisBlock = static_cast<int>(
            std::min<int64_t>(discardSamples, thisBlockSize));
        discardSamples -= discardThisBlock;

        int keepSamples = thisBlockSize - discardThisBlock;
        if (keepSamples > 0)
        {
            keepSamples = static_cast<int>(std::min<int64_t>(
                keepSamples, requestedDuration - writtenSamples));
            for (int ch = 0; ch < 2; ++ch)
                output.copyFrom(ch, static_cast<int>(writtenSamples),
                                block, ch, discardThisBlock, keepSamples);
            writtenSamples += keepSamples;
        }

        transport.advance(thisBlockSize);
        currentSample += thisBlockSize;
    }

    transport.pause();
    return output;
}

static int64_t getLivePresentationLatencyForDiagnostics(const MixEngine& engine,
                                                        int64_t deviceOutputLatencySamples = 0)
{
    const auto latencySnapshot = engine.getLatencyCompensationSnapshot();
    return std::max<int64_t>(0, latencySnapshot.maxAudibleTrackLatencySamples)
        + std::max<int64_t>(0, latencySnapshot.masterInsertLatencySamples)
        + std::max<int64_t>(0, deviceOutputLatencySamples);
}

static int64_t getLivePresentationSampleForDiagnostics(const MixEngine& engine,
                                                       const Transport& transport,
                                                       int64_t deviceOutputLatencySamples = 0)
{
    return std::max<int64_t>(
        0,
        transport.getPositionSamples()
            - getLivePresentationLatencyForDiagnostics(engine, deviceOutputLatencySamples));
}

static juce::AudioBuffer<float> renderRawLivePreview(MixEngine& engine,
                                                     Transport& transport,
                                                     int64_t requestedStart,
                                                     int outputSamples,
                                                     double sampleRate,
                                                     double bpm,
                                                     int blockSize = 512)
{
    const int64_t presentationLatency =
        getLivePresentationLatencyForDiagnostics(engine);

    transport.setSampleRate(sampleRate);
    transport.setBPM(bpm);
    transport.seekToSample(requestedStart);
    transport.play();

    CHECK(transport.getRenderPositionSamples() == requestedStart,
          "live render clock should start at the raw requested project sample");
    CHECK(transport.getPositionSamples() == requestedStart,
          "transport position should remain raw musical time for live playback");
    CHECK(!transport.isPresentationPrerolling(),
          "Transport should not own presentation latency state");
    CHECK(transport.getPresentationLatencySamples() == 0,
          "Transport should not report live presentation latency");
    CHECK(getLivePresentationSampleForDiagnostics(engine, transport)
              == std::max<int64_t>(0, requestedStart - presentationLatency),
          "live presentation sample should lag raw transport without shifting transport");

    juce::AudioBuffer<float> output(2, outputSamples);
    output.clear();

    int written = 0;
    while (written < outputSamples)
    {
        const int n = std::min(blockSize, outputSamples - written);
        juce::AudioBuffer<float> block(2, n);
        block.clear();
        engine.processBlock(block, n, transport);

        for (int ch = 0; ch < 2; ++ch)
            output.copyFrom(ch, written, block, ch, 0, n);

        transport.advance(n);
        written += n;
    }

    CHECK(transport.getRenderPositionSamples() == transport.getPositionSamples(),
          "render position should remain the same raw transport clock");
    CHECK(transport.getPositionSamples() == requestedStart + outputSamples,
          "live playback should advance raw transport by rendered samples");
    CHECK(getLivePresentationSampleForDiagnostics(engine, transport)
              == std::max<int64_t>(0,
                                    requestedStart + outputSamples
                                        - presentationLatency),
          "presentation timing should be derived separately from raw transport");

    transport.pause();
    return output;
}

// ─── Utility: offline render ─────────────────────────────────────────────────
// Renders the timeline through MixEngine into a stereo buffer.

static juce::AudioBuffer<float> offlineRender(MixEngine& engine, Transport& transport,
                                               int totalSamples, int blockSize = 512)
{
    juce::AudioBuffer<float> output(2, totalSamples);
    output.clear();

    transport.seekToSample(0);
    transport.play();

    int pos = 0;
    while (pos < totalSamples)
    {
        const int n = std::min(blockSize, totalSamples - pos);

        // Create a view into the output buffer at the current write position
        juce::AudioBuffer<float> block(2, n);
        block.clear();

        engine.processBlock(block, n, transport);

        // Copy block into output at position
        for (int ch = 0; ch < 2; ++ch)
            output.copyFrom(ch, pos, block, ch, 0, n);

        transport.advance(n);
        pos += n;
    }

    transport.pause();
    return output;
}

static void renderMeterBlock(MixEngine& engine, Transport& transport, int blockSize = 512)
{
    juce::AudioBuffer<float> block(2, blockSize);
    block.clear();

    transport.seekToSample(0);
    transport.play();
    engine.processBlock(block, blockSize, transport);
    transport.pause();
}

static void configureHighQualityResonanceSuppressor(MixEngine& engine, int trackId, int nodeId,
                                                    int quality, float mixPct, bool delta,
                                                    float depthPct = 0.0f)
{
    CHECK(engine.setEffectParameter(trackId, nodeId, "processing_mode", 1.0f),
          "RS processing_mode should switch to High Quality");
    CHECK(engine.setEffectParameter(trackId, nodeId, "quality", static_cast<float>(quality)),
          "RS quality should be settable");
    CHECK(engine.setEffectParameter(trackId, nodeId, "depth", depthPct),
          "RS depth should be settable");
    CHECK(engine.setEffectParameter(trackId, nodeId, "mix", mixPct),
          "RS mix should be settable");
    CHECK(engine.setEffectParameter(trackId, nodeId, "delta", delta ? 1.0f : 0.0f),
          "RS delta should be settable");
}

// ─── Utility: compute RMS ────────────────────────────────────────────────────

static float computeRMS(const juce::AudioBuffer<float>& buf, int channel,
                         int startSample = 0, int numSamples = -1)
{
    if (numSamples < 0) numSamples = buf.getNumSamples() - startSample;
    if (numSamples <= 0) return 0.0f;

    return buf.getRMSLevel(channel, startSample, numSamples);
}

// ─── Test 1: Basic multi-track rendering ─────────────────────────────────────

static void testBasicRendering()
{
    std::cout << "[1] Basic multi-track rendering\n";

    const double bpm        = 140.0;
    const double sampleRate = 44100.0;

    // ── Setup timeline ───────────────────────────────────────────────────────
    Timeline timeline(bpm, sampleRate);

    // 3 tracks: Kick (vol=1, pan=0), Snare (vol=0.8, pan=-0.5), HiHat (vol=0.6, pan=0.5)
    TrackInfo kickTrack;  kickTrack.name  = "Kick";  kickTrack.volume = 1.0f; kickTrack.pan = 0.0f;
    TrackInfo snareTrack; snareTrack.name = "Snare"; snareTrack.volume = 0.8f; snareTrack.pan = -0.5f;
    TrackInfo hihatTrack; hihatTrack.name = "HiHat"; hihatTrack.volume = 0.6f; hihatTrack.pan = 0.5f;

    int kickId  = timeline.addTrack(kickTrack);
    int snareId = timeline.addTrack(snareTrack);
    int hihatId = timeline.addTrack(hihatTrack);

    // ── Create regions ───────────────────────────────────────────────────────
    SampleRegion kickRegion;  kickRegion.name  = "Kick";  kickRegion.label = SampleLabel::Kick;
    SampleRegion snareRegion; snareRegion.name = "Snare"; snareRegion.label = SampleLabel::Snare;
    SampleRegion hihatRegion; hihatRegion.name = "HiHat"; hihatRegion.label = SampleLabel::HiHat;

    int kickRegId  = timeline.addRegion(kickRegion);
    int snareRegId = timeline.addRegion(snareRegion);
    int hihatRegId = timeline.addRegion(hihatRegion);

    // ── Add clips ────────────────────────────────────────────────────────────
    // Kick on beats 1, 2, 3, 4 (of 4 bars = beats 0..15)
    // Beat duration at 140 BPM = 60/140 ≈ 0.4286s
    const auto beatDur = TickTime::fromBeats(1);

    // Kick: every beat for 4 bars = beats 0-15
    for (int beat = 0; beat < 16; ++beat)
    {
        Clip c; c.trackId = kickId; c.regionId = kickRegId;
        c.position = TickTime::fromBeats(beat); c.duration = beatDur;
        timeline.addClip(c);
    }

    // Snare: beats 2, 4 of each bar → beats 1, 3, 5, 7, 9, 11, 13, 15
    for (int bar = 0; bar < 4; ++bar)
    {
        for (int beat : {1, 3}) // 0-indexed within bar
        {
            Clip c; c.trackId = snareId; c.regionId = snareRegId;
            c.position = TickTime::fromBeats(bar * 4 + beat); c.duration = beatDur;
            timeline.addClip(c);
        }
    }

    // HiHat: every 8th note for 4 bars = 32 clips
    const auto eighthDur = TickTime::from16th(2); // 8th = 2 sixteenths
    for (int eighth = 0; eighth < 32; ++eighth)
    {
        Clip c; c.trackId = hihatId; c.regionId = hihatRegId;
        c.position = TickTime::from16th(eighth * 2); c.duration = eighthDur;
        timeline.addClip(c);
    }

    // ── Generate synthetic WAV files ─────────────────────────────────────────
    auto tempDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                       .getChildFile("xleth_test_mix");
    tempDir.createDirectory();

    // Short samples: ~50ms each
    const int sampleLen = static_cast<int>(sampleRate * 0.05);
    auto kickWav  = generateWav(tempDir, "kick",  sampleRate, sampleLen, 60.0f, 0.5f);
    auto snareWav = generateWav(tempDir, "snare", sampleRate, sampleLen, 200.0f, 0.5f);
    auto hihatWav = generateWav(tempDir, "hihat", sampleRate, sampleLen, 8000.0f, 0.3f);

    CHECK(kickWav.existsAsFile(),  "kick WAV generated");
    CHECK(snareWav.existsAsFile(), "snare WAV generated");
    CHECK(hihatWav.existsAsFile(), "hihat WAV generated");

    // ── Load samples ─────────────────────────────────────────────────────────
    SampleBank bank;
    int kickSampleId  = bank.loadSample(kickWav,  sampleRate);
    int snareSampleId = bank.loadSample(snareWav, sampleRate);
    int hihatSampleId = bank.loadSample(hihatWav, sampleRate);

    CHECK(kickSampleId >= 0,  "kick loaded into SampleBank");
    CHECK(snareSampleId >= 0, "snare loaded into SampleBank");
    CHECK(hihatSampleId >= 0, "hihat loaded into SampleBank");

    // ── Configure MixEngine ──────────────────────────────────────────────────
    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(kickRegId,  kickSampleId);
    engine.mapRegionToSample(snareRegId, snareSampleId);
    engine.mapRegionToSample(hihatRegId, hihatSampleId);

    // ── Offline render 4 bars ────────────────────────────────────────────────
    Transport transport;
    transport.setSampleRate(sampleRate);
    transport.setBPM(bpm);

    // 4 bars at 140 BPM = 16 beats = 16 * (60/140) seconds
    const double durationSec = 16.0 * (60.0 / bpm);
    const int totalSamples = static_cast<int>(durationSec * sampleRate);

    auto output = offlineRender(engine, transport, totalSamples);

    // ── Verify: not silent ───────────────────────────────────────────────────
    float rmsL = computeRMS(output, 0);
    float rmsR = computeRMS(output, 1);
    std::cout << "    RMS L=" << rmsL << " R=" << rmsR << "\n";
    CHECK(rmsL > 0.001f, "output L is not silent (RMS > 0.001)");
    CHECK(rmsR > 0.001f, "output R is not silent (RMS > 0.001)");

    // ── Verify: no clipping (peak <= 1.0) ────────────────────────────────────
    float peakL = output.getMagnitude(0, 0, totalSamples);
    float peakR = output.getMagnitude(1, 0, totalSamples);
    std::cout << "    Peak L=" << peakL << " R=" << peakR << "\n";
    CHECK(peakL <= 1.0f, "output L not clipping (peak <= 1.0)");
    CHECK(peakR <= 1.0f, "output R not clipping (peak <= 1.0)");

    // ── Verify: panning ──────────────────────────────────────────────────────
    // Snare is panned left (pan=-0.5) → snare content should be louder in L
    // HiHat is panned right (pan=0.5) → hihat content should be louder in R
    // We can verify by rendering only the snare track (mute others) and checking L>R.

    // Mute kick and hihat to isolate snare
    timeline.getTrackMutable(kickId)->muted  = true;
    timeline.getTrackMutable(hihatId)->muted = true;
    timeline.getTrackMutable(snareId)->muted = false;

    auto snareOnly = offlineRender(engine, transport, totalSamples);
    float snareRmsL = computeRMS(snareOnly, 0);
    float snareRmsR = computeRMS(snareOnly, 1);
    std::cout << "    Snare (pan=-0.5): RMS L=" << snareRmsL << " R=" << snareRmsR << "\n";
    CHECK(snareRmsL > snareRmsR, "snare panned left: L > R");

    // Isolate hihat
    timeline.getTrackMutable(snareId)->muted = true;
    timeline.getTrackMutable(hihatId)->muted = false;

    auto hihatOnly = offlineRender(engine, transport, totalSamples);
    float hihatRmsL = computeRMS(hihatOnly, 0);
    float hihatRmsR = computeRMS(hihatOnly, 1);
    std::cout << "    HiHat (pan=0.5): RMS L=" << hihatRmsL << " R=" << hihatRmsR << "\n";
    CHECK(hihatRmsR > hihatRmsL, "hihat panned right: R > L");

    // Restore for subsequent tests
    timeline.getTrackMutable(kickId)->muted  = false;
    timeline.getTrackMutable(snareId)->muted = false;
    timeline.getTrackMutable(hihatId)->muted = false;

    // ── Cleanup ──────────────────────────────────────────────────────────────
    tempDir.deleteRecursively();
}

// ─── Test 2: Mute ────────────────────────────────────────────────────────────
// Mute kick → kick beats should be silent (only snare + hihat audible).

static void testMute()
{
    std::cout << "[2] Mute test\n";

    const double bpm = 140.0;
    const double sampleRate = 44100.0;

    Timeline timeline(bpm, sampleRate);

    TrackInfo kickTrack;  kickTrack.name  = "Kick";  kickTrack.volume = 1.0f; kickTrack.pan = 0.0f;
    TrackInfo snareTrack; snareTrack.name = "Snare"; snareTrack.volume = 0.8f; snareTrack.pan = 0.0f;
    int kickId  = timeline.addTrack(kickTrack);
    int snareId = timeline.addTrack(snareTrack);

    SampleRegion kickRegion;  kickRegion.name = "Kick";  kickRegion.label = SampleLabel::Kick;
    SampleRegion snareRegion; snareRegion.name = "Snare"; snareRegion.label = SampleLabel::Snare;
    int kickRegId  = timeline.addRegion(kickRegion);
    int snareRegId = timeline.addRegion(snareRegion);

    const auto beatDur = TickTime::fromBeats(1);

    // Kick on beat 0 only, Snare on beat 2 only
    { Clip c; c.trackId = kickId; c.regionId = kickRegId;
      c.position = TickTime::fromBeats(0); c.duration = beatDur; timeline.addClip(c); }
    { Clip c; c.trackId = snareId; c.regionId = snareRegId;
      c.position = TickTime::fromBeats(2); c.duration = beatDur; timeline.addClip(c); }

    // Generate + load samples
    auto tempDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                       .getChildFile("xleth_test_mute");
    tempDir.createDirectory();
    const int sampleLen = static_cast<int>(sampleRate * 0.05);
    auto kickWav  = generateWav(tempDir, "kick",  sampleRate, sampleLen, 60.0f, 0.5f);
    auto snareWav = generateWav(tempDir, "snare", sampleRate, sampleLen, 200.0f, 0.5f);

    SampleBank bank;
    int kickSampleId  = bank.loadSample(kickWav, sampleRate);
    int snareSampleId = bank.loadSample(snareWav, sampleRate);

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(kickRegId, kickSampleId);
    engine.mapRegionToSample(snareRegId, snareSampleId);

    Transport transport;
    transport.setSampleRate(sampleRate);
    transport.setBPM(bpm);

    const int totalSamples = static_cast<int>(4.0 * (60.0 / bpm) * sampleRate); // 4 beats

    // Mute kick
    timeline.getTrackMutable(kickId)->muted = true;

    auto output = offlineRender(engine, transport, totalSamples);

    // Beat 0 region (kick is muted) — should be silent
    const int beatSamples = static_cast<int>((60.0 / bpm) * sampleRate);
    float kickRegionRms = computeRMS(output, 0, 0, std::min(sampleLen, beatSamples));
    std::cout << "    Kick region RMS (muted): " << kickRegionRms << "\n";
    CHECK(kickRegionRms < 0.001f, "muted kick is silent");

    // Beat 2 region (snare is NOT muted) — should have audio
    int snareStart = 2 * beatSamples;
    float snareRegionRms = computeRMS(output, 0, snareStart, std::min(sampleLen, beatSamples));
    std::cout << "    Snare region RMS (unmuted): " << snareRegionRms << "\n";
    CHECK(snareRegionRms > 0.001f, "unmuted snare is audible");

    tempDir.deleteRecursively();
}

// ─── Test 3: Solo ────────────────────────────────────────────────────────────
// Solo snare → only snare audible.

static void testSolo()
{
    std::cout << "[3] Solo test\n";

    const double bpm = 140.0;
    const double sampleRate = 44100.0;

    Timeline timeline(bpm, sampleRate);

    TrackInfo kickTrack;  kickTrack.name = "Kick";  kickTrack.volume = 1.0f; kickTrack.pan = 0.0f;
    TrackInfo snareTrack; snareTrack.name = "Snare"; snareTrack.volume = 0.8f; snareTrack.pan = 0.0f;
    int kickId  = timeline.addTrack(kickTrack);
    int snareId = timeline.addTrack(snareTrack);

    SampleRegion kickRegion;  kickRegion.name = "Kick";  kickRegion.label = SampleLabel::Kick;
    SampleRegion snareRegion; snareRegion.name = "Snare"; snareRegion.label = SampleLabel::Snare;
    int kickRegId  = timeline.addRegion(kickRegion);
    int snareRegId = timeline.addRegion(snareRegion);

    const auto beatDur = TickTime::fromBeats(1);

    // Kick on beat 0, Snare on beat 2
    { Clip c; c.trackId = kickId; c.regionId = kickRegId;
      c.position = TickTime::fromBeats(0); c.duration = beatDur; timeline.addClip(c); }
    { Clip c; c.trackId = snareId; c.regionId = snareRegId;
      c.position = TickTime::fromBeats(2); c.duration = beatDur; timeline.addClip(c); }

    auto tempDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                       .getChildFile("xleth_test_solo");
    tempDir.createDirectory();
    const int sampleLen = static_cast<int>(sampleRate * 0.05);
    auto kickWav  = generateWav(tempDir, "kick",  sampleRate, sampleLen, 60.0f, 0.5f);
    auto snareWav = generateWav(tempDir, "snare", sampleRate, sampleLen, 200.0f, 0.5f);

    SampleBank bank;
    int kickSampleId  = bank.loadSample(kickWav, sampleRate);
    int snareSampleId = bank.loadSample(snareWav, sampleRate);

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(kickRegId, kickSampleId);
    engine.mapRegionToSample(snareRegId, snareSampleId);

    Transport transport;
    transport.setSampleRate(sampleRate);
    transport.setBPM(bpm);

    const int totalSamples = static_cast<int>(4.0 * (60.0 / bpm) * sampleRate);

    // Solo snare
    timeline.getTrackMutable(snareId)->solo = true;

    auto output = offlineRender(engine, transport, totalSamples);

    // Kick region (not soloed) — should be silent
    const int beatSamples = static_cast<int>((60.0 / bpm) * sampleRate);
    float kickRegionRms = computeRMS(output, 0, 0, std::min(sampleLen, beatSamples));
    std::cout << "    Kick region RMS (not soloed): " << kickRegionRms << "\n";
    CHECK(kickRegionRms < 0.001f, "non-soloed kick is silent");

    // Snare region (soloed) — should have audio
    int snareStart = 2 * beatSamples;
    float snareRegionRms = computeRMS(output, 0, snareStart, std::min(sampleLen, beatSamples));
    std::cout << "    Snare region RMS (soloed): " << snareRegionRms << "\n";
    CHECK(snareRegionRms > 0.001f, "soloed snare is audible");

    tempDir.deleteRecursively();
}

// ─── Test 4: Constant-power pan law verification ─────────────────────────────

static void testPanLaw()
{
    std::cout << "[4] Constant-power pan law\n";

    // Center pan (0) → L and R should be equal, each ≈ 0.707 (-3 dB)
    {
        juce::AudioBuffer<float> buf(2, 100);
        for (int ch = 0; ch < 2; ++ch)
            for (int i = 0; i < 100; ++i)
                buf.setSample(ch, i, 1.0f);

        TrackMixer::applyPan(buf, 0.0f);
        float l = std::abs(buf.getSample(0, 50));
        float r = std::abs(buf.getSample(1, 50));
        CHECK_NEAR(l, r, 0.001, "center pan: L == R");
        CHECK_NEAR(l, std::cos(juce::MathConstants<float>::pi * 0.25f), 0.001,
                   "center pan: gain ≈ 0.707");
    }

    // Hard left (pan=-1) → L=1, R=0
    {
        juce::AudioBuffer<float> buf(2, 100);
        for (int ch = 0; ch < 2; ++ch)
            for (int i = 0; i < 100; ++i)
                buf.setSample(ch, i, 1.0f);

        TrackMixer::applyPan(buf, -1.0f);
        float l = std::abs(buf.getSample(0, 50));
        float r = std::abs(buf.getSample(1, 50));
        CHECK_NEAR(l, 1.0f, 0.001, "hard left: L ≈ 1.0");
        CHECK_NEAR(r, 0.0f, 0.001, "hard left: R ≈ 0.0");
    }

    // Hard right (pan=+1) → L=0, R=1
    {
        juce::AudioBuffer<float> buf(2, 100);
        for (int ch = 0; ch < 2; ++ch)
            for (int i = 0; i < 100; ++i)
                buf.setSample(ch, i, 1.0f);

        TrackMixer::applyPan(buf, 1.0f);
        float l = std::abs(buf.getSample(0, 50));
        float r = std::abs(buf.getSample(1, 50));
        CHECK_NEAR(l, 0.0f, 0.001, "hard right: L ≈ 0.0");
        CHECK_NEAR(r, 1.0f, 0.001, "hard right: R ≈ 1.0");
    }
}

// ─── Test 5: Peak meters ─────────────────────────────────────────────────────

static void testPeakMeters()
{
    std::cout << "[5] Peak meters\n";

    const double bpm = 140.0;
    const double sampleRate = 44100.0;

    Timeline timeline(bpm, sampleRate);

    TrackInfo track; track.name = "Test"; track.volume = 1.0f; track.pan = 0.0f;
    int trackId = timeline.addTrack(track);

    SampleRegion region; region.name = "Test"; region.label = SampleLabel::Custom;
    int regionId = timeline.addRegion(region);

    { Clip c; c.trackId = trackId; c.regionId = regionId;
      c.position = TickTime::fromBeats(0); c.duration = TickTime::fromBeats(1);
      timeline.addClip(c); }

    auto tempDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                       .getChildFile("xleth_test_peaks");
    tempDir.createDirectory();
    const int sampleLen = static_cast<int>(sampleRate * 0.05);
    auto wav = generateWav(tempDir, "test", sampleRate, sampleLen, 440.0f, 0.7f);

    SampleBank bank;
    int sampleId = bank.loadSample(wav, sampleRate);

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(regionId, sampleId);

    Transport transport;
    transport.setSampleRate(sampleRate);
    transport.setBPM(bpm);
    transport.seekToSample(0);
    transport.play();

    juce::AudioBuffer<float> block(2, 512);
    block.clear();
    engine.processBlock(block, 512, transport);

    float masterL = engine.getMasterPeakL();
    float masterR = engine.getMasterPeakR();
    std::cout << "    Master peaks: L=" << masterL << " R=" << masterR << "\n";
    CHECK(masterL > 0.0f, "master peak L > 0 during playback");
    CHECK(masterR > 0.0f, "master peak R > 0 during playback");

    transport.pause();
    tempDir.deleteRecursively();
}

static void testTrackSlotSync()
{
    std::cout << "[5b] Track slot sync\n";

    const double bpm = 120.0;
    const double sampleRate = 44100.0;
    constexpr int blockSize = 512;

    Timeline timeline(bpm, sampleRate);

    TrackInfo trackA; trackA.name = "TrackA";
    TrackInfo trackB; trackB.name = "TrackB";
    TrackInfo trackC; trackC.name = "TrackC";

    const int trackAId = timeline.addTrack(trackA);
    const int trackBId = timeline.addTrack(trackB);
    const int trackCId = timeline.addTrack(trackC);

    SampleRegion regionA; regionA.name = "RegionA"; regionA.label = SampleLabel::Custom;
    SampleRegion regionB; regionB.name = "RegionB"; regionB.label = SampleLabel::Custom;
    SampleRegion regionC; regionC.name = "RegionC"; regionC.label = SampleLabel::Custom;

    const int regionAId = timeline.addRegion(regionA);
    const int regionBId = timeline.addRegion(regionB);
    const int regionCId = timeline.addRegion(regionC);

    const auto clipDur = TickTime::fromBeats(1);
    Clip clipA; clipA.trackId = trackAId; clipA.regionId = regionAId; clipA.position = TickTime::fromBeats(0); clipA.duration = clipDur;
    Clip clipB; clipB.trackId = trackBId; clipB.regionId = regionBId; clipB.position = TickTime::fromBeats(0); clipB.duration = clipDur;
    Clip clipC; clipC.trackId = trackCId; clipC.regionId = regionCId; clipC.position = TickTime::fromBeats(0); clipC.duration = clipDur;
    const int clipAId = timeline.addClip(clipA);
    const int clipBId = timeline.addClip(clipB);
    const int clipCId = timeline.addClip(clipC);
    CHECK(clipAId >= 0, "track A clip created");
    CHECK(clipBId >= 0, "track B clip created");
    CHECK(clipCId >= 0, "track C clip created");

    auto tempDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                       .getChildFile("xleth_test_track_slot_sync");
    tempDir.createDirectory();
    const int sampleLen = static_cast<int>(sampleRate * 0.05);
    auto wavA = generateWav(tempDir, "track_a", sampleRate, sampleLen, 220.0f, 0.6f);
    auto wavB = generateWav(tempDir, "track_b", sampleRate, sampleLen, 330.0f, 0.6f);
    auto wavC = generateWav(tempDir, "track_c", sampleRate, sampleLen, 440.0f, 0.6f);

    SampleBank bank;
    const int sampleAId = bank.loadSample(wavA, sampleRate);
    const int sampleBId = bank.loadSample(wavB, sampleRate);
    const int sampleCId = bank.loadSample(wavC, sampleRate);
    CHECK(sampleAId >= 0, "track A sample loaded");
    CHECK(sampleBId >= 0, "track B sample loaded");
    CHECK(sampleCId >= 0, "track C sample loaded");

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(regionAId, sampleAId);
    engine.mapRegionToSample(regionBId, sampleBId);
    engine.mapRegionToSample(regionCId, sampleCId);
    engine.syncTrackSlotsFromTimeline(false);
    engine.prepare(sampleRate, blockSize);

    Transport transport;
    transport.setSampleRate(sampleRate);
    transport.setBPM(bpm);

    renderMeterBlock(engine, transport, blockSize);
    const float initialPeakC = std::max(engine.getTrackPeakL(trackCId), engine.getTrackPeakR(trackCId));
    CHECK(initialPeakC > 0.0f, "highest-id audible track reports nonzero peak before topology changes");

    CHECK(timeline.removeClip(clipAId), "track A clip removed before track deletion");
    CHECK(timeline.removeTrack(trackAId), "track A removed");
    engine.syncTrackSlotsFromTimeline(false);

    renderMeterBlock(engine, transport, blockSize);
    const float peakCAfterRemove = std::max(engine.getTrackPeakL(trackCId), engine.getTrackPeakR(trackCId));
    CHECK(peakCAfterRemove > 0.0f, "surviving higher-id track reports nonzero peak after earlier track removal");
    CHECK(engine.getTrackPeakL(trackAId) == 0.0f, "removed track peak L reads zero");
    CHECK(engine.getTrackPeakR(trackAId) == 0.0f, "removed track peak R reads zero");

    TrackInfo trackD; trackD.name = "TrackD";
    const int trackDId = timeline.addTrack(trackD);
    SampleRegion regionD; regionD.name = "RegionD"; regionD.label = SampleLabel::Custom;
    const int regionDId = timeline.addRegion(regionD);
    Clip clipD; clipD.trackId = trackDId; clipD.regionId = regionDId; clipD.position = TickTime::fromBeats(0); clipD.duration = clipDur;
    const int clipDId = timeline.addClip(clipD);
    CHECK(clipDId >= 0, "new track clip created after live add");

    auto wavD = generateWav(tempDir, "track_d", sampleRate, sampleLen, 550.0f, 0.6f);
    const int sampleDId = bank.loadSample(wavD, sampleRate);
    CHECK(sampleDId >= 0, "new track sample loaded after live add");
    engine.mapRegionToSample(regionDId, sampleDId);
    engine.syncTrackSlotsFromTimeline(false);

    renderMeterBlock(engine, transport, blockSize);
    const float peakD = std::max(engine.getTrackPeakL(trackDId), engine.getTrackPeakR(trackDId));
    CHECK(peakD > 0.0f, "newly added audible track reports nonzero peak after slot resync");

    tempDir.deleteRecursively();
}

// ─── Test 6: Debug logging ───────────────────────────────────────────────────

static void testDebugLog()
{
    std::cout << "[6] Debug log queue\n";

    MixDebugLog log(16);

    // Push entries
    MixDebugEntry entry;
    entry.type = MixDebugEntry::ActiveClips;
    std::snprintf(entry.message, sizeof(entry.message), "test message %d", 42);
    CHECK(log.push(entry), "push succeeds");

    // Pop entry
    MixDebugEntry popped;
    CHECK(log.pop(popped), "pop succeeds");
    CHECK(popped.type == MixDebugEntry::ActiveClips, "type preserved");
    CHECK(std::string(popped.message) == "test message 42", "message preserved");

    // Pop from empty returns false
    CHECK(!log.pop(popped), "pop from empty returns false");
}

// ─── Test: EQ tail — no state-injection click at clip B start ────────────────
// Two clips (2 kHz sine) with a 125 ms silence gap on a single track.
// Bell EQ +12 dB at 2 kHz, Q=10 is active.
// Fix: EQ reports 0.2 s tail → MixEngine feeds silent buffers through EQ during
// the gap → biquad state decays to ~0 before clip B → no click.
// Without fix: z1_frozen ≈ 1.0–2.0 would inject at clip B sample 0.

static void testEQTailNoClick()
{
    std::cout << "[EQ tail] no state-injection click across silence gap\n";

    const double bpm        = 120.0;
    const double sampleRate = 44100.0;
    const int    blockSize  = 512;

    // Clip A: beat 0 → 1  (0.0–0.5 s = 22050 samples)
    // Silence:  beat 1 → 1.25  (0.5–0.625 s = 5512 samples ≈ 125 ms)
    // Clip B: beat 1.25 → 2.25  (0.625–1.125 s)
    const int clipBStartSample =
        static_cast<int>(1.25 * (60.0 / bpm) * sampleRate); // 27562

    Timeline timeline(bpm, sampleRate);

    TrackInfo track;
    track.name   = "EQ Track";
    track.volume = 1.0f;
    int trackId  = timeline.addTrack(track);

    SampleRegion regA; regA.name = "ClipA";
    SampleRegion regB; regB.name = "ClipB";
    int regAId = timeline.addRegion(regA);
    int regBId = timeline.addRegion(regB);

    Clip clipA;
    clipA.trackId  = trackId;
    clipA.regionId = regAId;
    clipA.position = TickTime::fromBeats(0.0);
    clipA.duration = TickTime::fromBeats(1.0);
    timeline.addClip(clipA);

    Clip clipB;
    clipB.trackId  = trackId;
    clipB.regionId = regBId;
    clipB.position = TickTime::fromBeats(1.25);
    clipB.duration = TickTime::fromBeats(1.0);
    timeline.addClip(clipB);

    // 2 kHz sine at 0.5 amplitude — matches EQ center so z1/z2 accumulate real energy.
    const int clipLenSamples = static_cast<int>(1.0 * (60.0 / bpm) * sampleRate);
    juce::File tempDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                             .getChildFile("xleth_eq_tail_test");
    tempDir.createDirectory();
    juce::File wavA = generateWav(tempDir, "clipA_2k", sampleRate, clipLenSamples, 2000.0f, 0.5f);
    juce::File wavB = generateWav(tempDir, "clipB_2k", sampleRate, clipLenSamples, 2000.0f, 0.5f);

    SampleBank bank;
    int smpA = bank.loadSample(wavA, sampleRate);
    int smpB = bank.loadSample(wavB, sampleRate);

    // JUCE APVTS lazy-init warmup: the 242-parameter APVTS requires JUCE's
    // internal StringPool/HashMap to be primed on first construction. Without this,
    // the first construction that happens inside AudioProcessorGraph::addNode() can
    // hit uninitialized JUCE-internal state and crash at getRawParameterValue().
    { auto warmup = std::make_unique<XlethParametricEQ>(); (void)warmup; }

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(regAId, smpA);
    engine.mapRegionToSample(regBId, smpB);
    engine.rebuildAllSamplers();
    engine.prepare(sampleRate, blockSize); // sets preparedSampleRate_ before addEffect

    // Add EQ then configure — addEffect auto-inits the chain at the prepared rate.
    int nodeId = engine.addEffect(trackId, "xletheq", 0);
    auto* base = engine.getEffectPtr(trackId, nodeId);
    auto* eq   = dynamic_cast<XlethParametricEQ*>(base);
    CHECK(eq != nullptr, "getEffectPtr should return XlethParametricEQ");
    if (!eq) return;

    // Verify the fix is in place before testing its effect.
    CHECK(eq->getTailLengthSeconds() >= 0.2,
          "EQ should report >= 0.2 s tail after fix");

    int band = eq->addBand();
    eq->setBandParam(band, "freq",    2000.0f);
    eq->setBandParam(band, "gain",    12.0f);   // +12 dB → steady-state |z1| ≈ 1–2
    eq->setBandParam(band, "q",       10.0f);
    eq->setBandParam(band, "type",    0.0f);    // Bell
    eq->setBandParam(band, "enabled", 1.0f);

    Transport transport;
    transport.setSampleRate(sampleRate);
    transport.setBPM(bpm);

    const int totalSamples = clipBStartSample + clipLenSamples + blockSize;
    auto output = offlineRender(engine, transport, totalSamples, blockSize);

    // The Sampler applies a Hann declick fade-in at clip B start (m_declickMs=0.5 → ~22
    // samples at 44100 Hz). Within this window, x[n] ≈ 0, so the only thing that can
    // raise output is injected biquad state (z1):
    //   With fix:    z1 decayed to ~0 during 200ms silence tail → y[0] ≈ 0
    //   Without fix: z1 frozen at end of clip A → y[0] ≈ z1 ≈ 1–2 (state injection spike)
    // Check only the first 5 samples — well inside the 22-sample fade, input is ~0.004,
    // so any spike here is pure filter state, not audio content.
    const int checkSamples = 5;
    float spike = 0.0f;
    for (int ch = 0; ch < 2; ++ch)
        for (int s = 0; s < checkSamples; ++s)
            spike = std::max(spike,
                             std::abs(output.getSample(ch, clipBStartSample + s)));

    CHECK(spike < 0.05f,
          "first 5 samples of clip B must not contain a state-injection spike (EQ tail fix)");

    // Sanity: flat EQ (gain=0) must also produce no click.
    eq->setBandParam(band, "gain", 0.0f);
    engine.prepare(sampleRate, blockSize); // reprepare clears biquad state via prepareEffect
    auto outputFlat = offlineRender(engine, transport, totalSamples, blockSize);
    float spikeFlat = 0.0f;
    for (int ch = 0; ch < 2; ++ch)
        for (int s = 0; s < checkSamples; ++s)
            spikeFlat = std::max(spikeFlat,
                                 std::abs(outputFlat.getSample(ch, clipBStartSample + s)));
    CHECK(spikeFlat < 0.05f, "flat EQ (gain=0) must also produce no click (regression guard)");

    tempDir.deleteRecursively();
}

// ─── main ────────────────────────────────────────────────────────────────────

static void testTrackPdcTwoTrackImpulseAlignment()
{
    std::cout << "[PDC 1] Two-track impulse alignment\n";

    const double bpm = 120.0;
    const double sampleRate = 51200.0;
    constexpr int blockSize = 512;
    constexpr int renderSamples = 4096;
    constexpr int expectedLatency = 1024;
    constexpr int impulseIndex = 128;

    Timeline timeline(bpm, sampleRate);
    TrackInfo dryTrack; dryTrack.name = "Dry";
    TrackInfo wetTrack; wetTrack.name = "Wet";
    const int dryTrackId = timeline.addTrack(dryTrack);
    const int wetTrackId = timeline.addTrack(wetTrack);

    SampleRegion dryRegion; dryRegion.name = "DryImpulse"; dryRegion.label = SampleLabel::Custom;
    SampleRegion wetRegion; wetRegion.name = "WetImpulse"; wetRegion.label = SampleLabel::Custom;
    const int dryRegionId = timeline.addRegion(dryRegion);
    const int wetRegionId = timeline.addRegion(wetRegion);

    Clip dryClip; dryClip.trackId = dryTrackId; dryClip.regionId = dryRegionId;
    dryClip.position = TickTime::fromBeats(0.0); dryClip.duration = TickTime::fromBeats(1.0);
    Clip wetClip = dryClip; wetClip.trackId = wetTrackId; wetClip.regionId = wetRegionId;
    timeline.addClip(dryClip);
    timeline.addClip(wetClip);

    auto tempDir = makeTempTestDir("xleth_test_pdc_two_track");
    auto impulseWav = generateImpulseWav(tempDir, "impulse", sampleRate, 4096, impulseIndex, 0.25f);
    CHECK(impulseWav.existsAsFile(), "impulse WAV generated");

    SampleBank bank;
    const int sampleId = bank.loadSample(impulseWav, sampleRate);
    CHECK(sampleId >= 0, "impulse sample loaded");

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(dryRegionId, sampleId);
    engine.mapRegionToSample(wetRegionId, sampleId);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    const int rsNode = engine.addEffect(wetTrackId, "resonancesuppressor", 0);
    CHECK(rsNode >= 0, "RS effect added to wet track");
    configureHighQualityResonanceSuppressor(engine, wetTrackId, rsNode, 1, 100.0f, false, 0.0f);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    CHECK(engine.getTrackInsertLatencySamples(wetTrackId) == expectedLatency,
          "wet track should report Normal-quality RS latency");
    CHECK(engine.getTrackCompensationDelaySamples(dryTrackId) == expectedLatency,
          "dry track should receive full compensation delay");
    CHECK(engine.getTrackCompensationDelaySamples(wetTrackId) == 0,
          "wet track should not need extra compensation");
    CHECK(engine.getMaxAudibleTrackLatencySamples() == expectedLatency,
          "max audible track latency should match the wet track");

    Transport transport;
    transport.setSampleRate(sampleRate);
    transport.setBPM(bpm);

    juce::AudioBuffer<float> firstBlock(2, blockSize);
    firstBlock.clear();
    transport.seekToSample(0);
    transport.play();
    engine.processBlock(firstBlock, blockSize, transport);
    transport.pause();

    CHECK(engine.getTrackPeakL(dryTrackId) > 0.1f,
          "pre-compensation dry-track meter should react in the first block");
    CHECK(firstBlock.getMagnitude(0, 0, blockSize) < 1.0e-4f,
          "summed audio should remain silent before compensated alignment arrives");

    auto output = offlineRender(engine, transport, renderSamples, blockSize);
    CHECK(allSamplesFinite(output), "two-track PDC render should stay finite");
    CHECK(findPeakIndex(output, 0) == expectedLatency + impulseIndex,
          "two-track impulses should align at the RS latency point");
    CHECK(maxAbsInRange(output, 0, 0, expectedLatency + impulseIndex) < 1.0e-4f,
          "no pre-alignment impulse should leak before compensated sync");

    tempDir.deleteRecursively();
}

static void testTrackPdcMultiLatencyAlignment()
{
    std::cout << "[PDC 2] Multi-latency alignment\n";

    const double bpm = 120.0;
    const double sampleRate = 51200.0;
    constexpr int blockSize = 512;
    constexpr int renderSamples = 4096;
    constexpr int impulseIndex = 128;

    Timeline timeline(bpm, sampleRate);
    TrackInfo track0; track0.name = "Zero";
    TrackInfo track1; track1.name = "Lookahead";
    TrackInfo track2; track2.name = "Resonance";
    const int track0Id = timeline.addTrack(track0);
    const int track1Id = timeline.addTrack(track1);
    const int track2Id = timeline.addTrack(track2);

    SampleRegion region0; region0.name = "Impulse0"; region0.label = SampleLabel::Custom;
    SampleRegion region1; region1.name = "Impulse1"; region1.label = SampleLabel::Custom;
    SampleRegion region2; region2.name = "Impulse2"; region2.label = SampleLabel::Custom;
    const int region0Id = timeline.addRegion(region0);
    const int region1Id = timeline.addRegion(region1);
    const int region2Id = timeline.addRegion(region2);

    Clip clip0; clip0.trackId = track0Id; clip0.regionId = region0Id;
    clip0.position = TickTime::fromBeats(0.0); clip0.duration = TickTime::fromBeats(1.0);
    Clip clip1 = clip0; clip1.trackId = track1Id; clip1.regionId = region1Id;
    Clip clip2 = clip0; clip2.trackId = track2Id; clip2.regionId = region2Id;
    timeline.addClip(clip0);
    timeline.addClip(clip1);
    timeline.addClip(clip2);

    auto tempDir = makeTempTestDir("xleth_test_pdc_multi");
    auto impulseWav = generateImpulseWav(tempDir, "impulse", sampleRate, 4096, impulseIndex, 0.25f);
    CHECK(impulseWav.existsAsFile(), "multi-latency impulse WAV generated");

    SampleBank bank;
    const int sampleId = bank.loadSample(impulseWav, sampleRate);
    CHECK(sampleId >= 0, "multi-latency impulse sample loaded");

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(region0Id, sampleId);
    engine.mapRegionToSample(region1Id, sampleId);
    engine.mapRegionToSample(region2Id, sampleId);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    const int compNode = engine.addEffect(track1Id, "compressor", 0);
    CHECK(compNode >= 0, "compressor effect added");
    CHECK(engine.setEffectParameter(track1Id, compNode, "threshold", 0.0f),
          "compressor threshold should be settable");
    CHECK(engine.setEffectParameter(track1Id, compNode, "ratio", 1.0f),
          "compressor ratio should be settable");
    CHECK(engine.setEffectParameter(track1Id, compNode, "mix", 100.0f),
          "compressor mix should be settable");
    CHECK(engine.setEffectParameter(track1Id, compNode, "lookahead", 5.0f),
          "compressor lookahead should be settable");

    const int rsNode = engine.addEffect(track2Id, "resonancesuppressor", 0);
    CHECK(rsNode >= 0, "RS effect added to third track");
    configureHighQualityResonanceSuppressor(engine, track2Id, rsNode, 1, 100.0f, false, 0.0f);

    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    CHECK(engine.getTrackInsertLatencySamples(track0Id) == 0,
          "dry track should report zero insert latency");
    CHECK(engine.getTrackInsertLatencySamples(track1Id) == 256,
          "compressor lookahead should report 256 samples at 51.2 kHz");
    CHECK(engine.getTrackInsertLatencySamples(track2Id) == 1024,
          "RS track should report 1024 samples");
    CHECK(engine.getTrackCompensationDelaySamples(track0Id) == 1024,
          "zero-latency track should be delayed to the max path");
    CHECK(engine.getTrackCompensationDelaySamples(track1Id) == 768,
          "256-sample track should be delayed by the remaining 768 samples");
    CHECK(engine.getTrackCompensationDelaySamples(track2Id) == 0,
          "max-latency track should not receive extra delay");

    Transport transport;
    transport.setSampleRate(sampleRate);
    transport.setBPM(bpm);
    auto output = offlineRender(engine, transport, renderSamples, blockSize);

    CHECK(allSamplesFinite(output), "multi-latency render should stay finite");
    CHECK(findPeakIndex(output, 0) == 1024 + impulseIndex,
          "all three latency paths should align to the max 1024-sample point");
    CHECK(maxAbsInRange(output, 0, 0, 1024 + impulseIndex) < 1.0e-4f,
          "no earlier impulse should remain after compensation");

    tempDir.deleteRecursively();
}

static void testTrackPdcBypassRecalculation()
{
    std::cout << "[PDC 3] Bypass recalculation\n";

    const double bpm = 120.0;
    const double sampleRate = 51200.0;
    constexpr int blockSize = 512;
    constexpr int impulseIndex = 128;

    Timeline timeline(bpm, sampleRate);
    TrackInfo dryTrack; dryTrack.name = "Dry";
    TrackInfo wetTrack; wetTrack.name = "Wet";
    const int dryTrackId = timeline.addTrack(dryTrack);
    const int wetTrackId = timeline.addTrack(wetTrack);

    SampleRegion dryRegion; dryRegion.name = "DryImpulse"; dryRegion.label = SampleLabel::Custom;
    SampleRegion wetRegion; wetRegion.name = "WetImpulse"; wetRegion.label = SampleLabel::Custom;
    const int dryRegionId = timeline.addRegion(dryRegion);
    const int wetRegionId = timeline.addRegion(wetRegion);

    Clip dryClip; dryClip.trackId = dryTrackId; dryClip.regionId = dryRegionId;
    dryClip.position = TickTime::fromBeats(0.0); dryClip.duration = TickTime::fromBeats(1.0);
    Clip wetClip = dryClip; wetClip.trackId = wetTrackId; wetClip.regionId = wetRegionId;
    timeline.addClip(dryClip);
    timeline.addClip(wetClip);

    auto tempDir = makeTempTestDir("xleth_test_pdc_bypass");
    auto impulseWav = generateImpulseWav(tempDir, "impulse", sampleRate, 4096, impulseIndex, 0.25f);

    SampleBank bank;
    const int sampleId = bank.loadSample(impulseWav, sampleRate);
    CHECK(sampleId >= 0, "bypass impulse sample loaded");

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(dryRegionId, sampleId);
    engine.mapRegionToSample(wetRegionId, sampleId);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    const int rsNode = engine.addEffect(wetTrackId, "resonancesuppressor", 0);
    CHECK(rsNode >= 0, "RS effect added for bypass test");
    configureHighQualityResonanceSuppressor(engine, wetTrackId, rsNode, 1, 100.0f, false, 0.0f);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    Transport transport;
    transport.setSampleRate(sampleRate);
    transport.setBPM(bpm);

    auto compensated = offlineRender(engine, transport, 4096, blockSize);
    CHECK(findPeakIndex(compensated, 0) == 1024 + impulseIndex,
          "pre-bypass render should align at the RS latency");

    CHECK(engine.setEffectBypass(wetTrackId, rsNode, true),
          "RS bypass should be settable");
    CHECK(engine.getTrackInsertLatencySamples(wetTrackId) == 0,
          "bypassed RS should report zero latency");
    CHECK(engine.getTrackCompensationDelaySamples(dryTrackId) == 0,
          "dry track compensation should clear after bypass");

    auto bypassed = offlineRender(engine, transport, 2048, blockSize);
    CHECK(allSamplesFinite(bypassed), "bypass render should stay finite");
    CHECK(findPeakIndex(bypassed, 0) == impulseIndex,
          "bypassed latency path should realign to the clip's original impulse offset");
    CHECK(maxAbsInRange(bypassed, 0, 1000, 400) < 1.0e-4f,
          "no stale compensated impulse should remain at the old latency point");

    tempDir.deleteRecursively();
}

static void testTrackPdcResonanceMixZeroAndQualityLatencyChange()
{
    std::cout << "[PDC 4] Resonance mix=0 and quality latency change\n";

    const double bpm = 120.0;
    const double sampleRate = 51200.0;
    constexpr int blockSize = 512;
    constexpr int impulseIndex = 128;

    Timeline timeline(bpm, sampleRate);
    TrackInfo dryTrack; dryTrack.name = "Dry";
    TrackInfo wetTrack; wetTrack.name = "Wet";
    const int dryTrackId = timeline.addTrack(dryTrack);
    const int wetTrackId = timeline.addTrack(wetTrack);

    SampleRegion dryRegion; dryRegion.name = "DryImpulse"; dryRegion.label = SampleLabel::Custom;
    SampleRegion wetRegion; wetRegion.name = "WetImpulse"; wetRegion.label = SampleLabel::Custom;
    const int dryRegionId = timeline.addRegion(dryRegion);
    const int wetRegionId = timeline.addRegion(wetRegion);

    Clip dryClip; dryClip.trackId = dryTrackId; dryClip.regionId = dryRegionId;
    dryClip.position = TickTime::fromBeats(0.0); dryClip.duration = TickTime::fromBeats(1.0);
    Clip wetClip = dryClip; wetClip.trackId = wetTrackId; wetClip.regionId = wetRegionId;
    timeline.addClip(dryClip);
    timeline.addClip(wetClip);

    auto tempDir = makeTempTestDir("xleth_test_pdc_mix_zero");
    auto impulseWav = generateImpulseWav(tempDir, "impulse", sampleRate, 4096, impulseIndex, 0.25f);

    SampleBank bank;
    const int sampleId = bank.loadSample(impulseWav, sampleRate);
    CHECK(sampleId >= 0, "mix-zero impulse sample loaded");

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(dryRegionId, sampleId);
    engine.mapRegionToSample(wetRegionId, sampleId);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    const int rsNode = engine.addEffect(wetTrackId, "resonancesuppressor", 0);
    CHECK(rsNode >= 0, "RS effect added for mix-zero test");
    configureHighQualityResonanceSuppressor(engine, wetTrackId, rsNode, 1, 100.0f, false, 0.0f);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    CHECK(engine.getTrackInsertLatencySamples(wetTrackId) == 1024,
          "wet RS path should start at 1024 samples");
    CHECK(engine.getTrackCompensationDelaySamples(dryTrackId) == 1024,
          "dry track should initially compensate to 1024 samples");

    CHECK(engine.setEffectParameter(wetTrackId, rsNode, "mix", 0.0f),
          "RS mix should accept 0%");
    CHECK(engine.setEffectParameter(wetTrackId, rsNode, "delta", 0.0f),
          "RS delta should remain off for true dry");
    CHECK(engine.getTrackInsertLatencySamples(wetTrackId) == 0,
          "RS mix=0 with delta off should report zero latency");
    CHECK(engine.getTrackCompensationDelaySamples(dryTrackId) == 0,
          "dry track compensation should clear when RS is true dry");

    Transport transport;
    transport.setSampleRate(sampleRate);
    transport.setBPM(bpm);
    auto dryAligned = offlineRender(engine, transport, 2048, blockSize);
    CHECK(findPeakIndex(dryAligned, 0) == impulseIndex,
          "mix=0 render should align immediately to the clip's original impulse offset");

    CHECK(engine.setEffectParameter(wetTrackId, rsNode, "mix", 100.0f),
          "RS mix should restore to wet");
    CHECK(engine.setEffectParameter(wetTrackId, rsNode, "quality", 2.0f),
          "RS quality should accept High");
    CHECK(engine.getTrackInsertLatencySamples(wetTrackId) == 2048,
          "RS High quality should report 2048 samples");
    CHECK(engine.getTrackCompensationDelaySamples(dryTrackId) == 2048,
          "dry track compensation should retarget to the new max latency");

    auto highQualityAligned = offlineRender(engine, transport, 6144, blockSize);
    CHECK(allSamplesFinite(highQualityAligned), "high-quality RS render should stay finite");
    CHECK(findPeakIndex(highQualityAligned, 0) == 2048 + impulseIndex,
          "quality change should move the aligned impulse to 2048 samples");

    tempDir.deleteRecursively();
}

static void testTrackPdcRawLivePlaybackProjectStart()
{
    std::cout << "[PDC 5] Raw live playback from project start\n";

    const double bpm = 120.0;
    const double sampleRate = 51200.0;
    constexpr int blockSize = 512;
    constexpr int impulseIndex = 128;

    Timeline timeline(bpm, sampleRate);
    int dryTrackId = 0, wetTrackId = 0, dryRegionId = 0, wetRegionId = 0;
    addTwoTrackImpulseClips(timeline, 0, sampleRate, bpm,
                            dryTrackId, wetTrackId, dryRegionId, wetRegionId);

    auto tempDir = makeTempTestDir("xleth_test_pdc_live_start");
    auto impulseWav = generateImpulseWav(tempDir, "impulse", sampleRate, 4096,
                                         impulseIndex, 0.25f);

    SampleBank bank;
    const int sampleId = bank.loadSample(impulseWav, sampleRate);
    CHECK(sampleId >= 0, "live-start sample loaded");

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(dryRegionId, sampleId);
    engine.mapRegionToSample(wetRegionId, sampleId);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    const int rsNode = engine.addEffect(wetTrackId, "resonancesuppressor", 0);
    CHECK(rsNode >= 0, "live-start RS effect added");
    configureHighQualityResonanceSuppressor(engine, wetTrackId, rsNode, 1,
                                            100.0f, false, 0.0f);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    Transport transport;
    const int64_t presentationLatency =
        getLivePresentationLatencyForDiagnostics(engine);
    CHECK(presentationLatency == 1024,
          "live presentation latency should include max track latency only");

    auto preview = renderRawLivePreview(engine, transport, 0, 2048,
                                        sampleRate, bpm, blockSize);
    CHECK(findPeakIndex(preview, 0) == presentationLatency + impulseIndex,
          "raw live playback should not hide PDC lead-in at project start");

    tempDir.deleteRecursively();
}

static void testTrackPdcRawLivePlaybackMidProject()
{
    std::cout << "[PDC 6] Raw live playback from mid-project\n";

    const double bpm = 120.0;
    const double sampleRate = 51200.0;
    constexpr int blockSize = 512;
    constexpr int impulseIndex = 128;
    const int64_t beatSamples = static_cast<int64_t>((60.0 / bpm) * sampleRate);

    Timeline timeline(bpm, sampleRate);
    int dryTrackId = 0, wetTrackId = 0, dryRegionId = 0, wetRegionId = 0;
    addTwoTrackImpulseClips(timeline, beatSamples, sampleRate, bpm,
                            dryTrackId, wetTrackId, dryRegionId, wetRegionId);

    auto tempDir = makeTempTestDir("xleth_test_pdc_live_mid");
    auto impulseWav = generateImpulseWav(tempDir, "impulse", sampleRate, 4096,
                                         impulseIndex, 0.25f);

    SampleBank bank;
    const int sampleId = bank.loadSample(impulseWav, sampleRate);
    CHECK(sampleId >= 0, "live-mid sample loaded");

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(dryRegionId, sampleId);
    engine.mapRegionToSample(wetRegionId, sampleId);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    const int rsNode = engine.addEffect(wetTrackId, "resonancesuppressor", 0);
    CHECK(rsNode >= 0, "live-mid RS effect added");
    configureHighQualityResonanceSuppressor(engine, wetTrackId, rsNode, 1,
                                            100.0f, false, 0.0f);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    Transport transport;
    const int64_t presentationLatency =
        getLivePresentationLatencyForDiagnostics(engine);
    CHECK(presentationLatency == 1024,
          "mid-project live presentation latency should include max track latency only");

    auto preview = renderRawLivePreview(engine, transport, beatSamples,
                                        2048, sampleRate, bpm, blockSize);
    CHECK(findPeakIndex(preview, 0) == presentationLatency + impulseIndex,
          "raw live playback should not internally preroll before the requested sample");

    tempDir.deleteRecursively();
}

static void verifyTrackPdcExportTrimProjectStart(const juce::File& impulseWav,
                                                 double sampleRate,
                                                 double bpm,
                                                 int blockSize,
                                                 int impulseIndex)
{
    Timeline timeline(bpm, sampleRate);
    TrackInfo dryTrack; dryTrack.name = "Dry";
    TrackInfo wetTrack; wetTrack.name = "Wet";
    const int dryTrackId = timeline.addTrack(dryTrack);
    const int wetTrackId = timeline.addTrack(wetTrack);

    SampleRegion dryRegion; dryRegion.name = "DryImpulse"; dryRegion.label = SampleLabel::Custom;
    SampleRegion wetRegion; wetRegion.name = "WetImpulse"; wetRegion.label = SampleLabel::Custom;
    const int dryRegionId = timeline.addRegion(dryRegion);
    const int wetRegionId = timeline.addRegion(wetRegion);

    Clip dryClip; dryClip.trackId = dryTrackId; dryClip.regionId = dryRegionId;
    dryClip.position = TickTime::fromBeats(0.0); dryClip.duration = TickTime::fromBeats(1.0);
    Clip wetClip = dryClip; wetClip.trackId = wetTrackId; wetClip.regionId = wetRegionId;
    timeline.addClip(dryClip);
    timeline.addClip(wetClip);

    SampleBank bank;
    const int sampleId = bank.loadSample(impulseWav, sampleRate);
    CHECK(sampleId >= 0, "project-start sample loaded");

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(dryRegionId, sampleId);
    engine.mapRegionToSample(wetRegionId, sampleId);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    const int rsNode = engine.addEffect(wetTrackId, "resonancesuppressor", 0);
    CHECK(rsNode >= 0, "project-start RS effect added");
    configureHighQualityResonanceSuppressor(engine, wetTrackId, rsNode, 1, 100.0f, false, 0.0f);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    Transport transport;
    auto trimmed = renderTrimmedRange(engine, transport, 0, 2048, sampleRate, bpm, blockSize);
    CHECK(trimmed.getNumSamples() == 2048, "project-start trimmed render should preserve requested duration");
    CHECK(findPeakIndex(trimmed, 0) == impulseIndex,
          "project-start trimmed export should begin at the requested musical time");
}

static void verifyTrackPdcExportTrimMidProject(const juce::File& impulseWav,
                                               double sampleRate,
                                               double bpm,
                                               int blockSize,
                                               int impulseIndex)
{
    const int64_t beatSamples = static_cast<int64_t>((60.0 / bpm) * sampleRate);
    Timeline timeline(bpm, sampleRate);
    TrackInfo dryTrack; dryTrack.name = "Dry";
    TrackInfo wetTrack; wetTrack.name = "Wet";
    const int dryTrackId = timeline.addTrack(dryTrack);
    const int wetTrackId = timeline.addTrack(wetTrack);

    SampleRegion dryRegion; dryRegion.name = "DryImpulse"; dryRegion.label = SampleLabel::Custom;
    SampleRegion wetRegion; wetRegion.name = "WetImpulse"; wetRegion.label = SampleLabel::Custom;
    const int dryRegionId = timeline.addRegion(dryRegion);
    const int wetRegionId = timeline.addRegion(wetRegion);

    const double startBeat = sampleToBeats(beatSamples, sampleRate, bpm);
    Clip dryClip; dryClip.trackId = dryTrackId; dryClip.regionId = dryRegionId;
    dryClip.position = TickTime::fromBeats(startBeat); dryClip.duration = TickTime::fromBeats(1.0);
    Clip wetClip = dryClip; wetClip.trackId = wetTrackId; wetClip.regionId = wetRegionId;
    timeline.addClip(dryClip);
    timeline.addClip(wetClip);

    SampleBank bank;
    const int sampleId = bank.loadSample(impulseWav, sampleRate);
    CHECK(sampleId >= 0, "mid-project sample loaded");

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(dryRegionId, sampleId);
    engine.mapRegionToSample(wetRegionId, sampleId);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    const int rsNode = engine.addEffect(wetTrackId, "resonancesuppressor", 0);
    CHECK(rsNode >= 0, "mid-project RS effect added");
    configureHighQualityResonanceSuppressor(engine, wetTrackId, rsNode, 1, 100.0f, false, 0.0f);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    Transport transport;
    auto trimmed = renderTrimmedRange(engine, transport, beatSamples, beatSamples + 2048,
                                      sampleRate, bpm, blockSize);
    CHECK(trimmed.getNumSamples() == 2048, "mid-project trimmed render should preserve requested duration");
    CHECK(findPeakIndex(trimmed, 0) == impulseIndex,
          "mid-project trimmed export should discard preroll and start on the requested beat");
}

static void verifyTrackPdcExportTrimNoPdc(const juce::File& impulseWav,
                                          double sampleRate,
                                          double bpm,
                                          int blockSize,
                                          int impulseIndex)
{
    Timeline timeline(bpm, sampleRate);
    TrackInfo track; track.name = "Dry";
    const int trackId = timeline.addTrack(track);

    SampleRegion region; region.name = "DryImpulse"; region.label = SampleLabel::Custom;
    const int regionId = timeline.addRegion(region);

    Clip clip; clip.trackId = trackId; clip.regionId = regionId;
    clip.position = TickTime::fromBeats(0.0); clip.duration = TickTime::fromBeats(1.0);
    timeline.addClip(clip);

    SampleBank bank;
    const int sampleId = bank.loadSample(impulseWav, sampleRate);
    CHECK(sampleId >= 0, "no-PDC sample loaded");

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(regionId, sampleId);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    const auto latencySnapshot = engine.getLatencyCompensationSnapshot();
    CHECK(latencySnapshot.maxAudibleTrackLatencySamples == 0,
          "no-PDC case should report zero track latency");
    CHECK(latencySnapshot.masterInsertLatencySamples == 0,
          "no-PDC case should report zero master latency");

    Transport transport;
    auto trimmed = renderTrimmedRange(engine, transport, 0, 1024, sampleRate, bpm, blockSize);
    CHECK(trimmed.getNumSamples() == 1024, "no-PDC trimmed render should preserve requested duration");
    CHECK(findPeakIndex(trimmed, 0) == impulseIndex,
          "no-PDC trimmed export should preserve the original musical start without added delay");
}

static void verifyTrackPdcExportTrimMasterLatency(const juce::File& impulseWav,
                                                  double sampleRate,
                                                  double bpm,
                                                  int blockSize,
                                                  int impulseIndex)
{
    Timeline timeline(bpm, sampleRate);
    TrackInfo track; track.name = "Dry";
    const int trackId = timeline.addTrack(track);

    SampleRegion region; region.name = "DryImpulse"; region.label = SampleLabel::Custom;
    const int regionId = timeline.addRegion(region);

    Clip clip; clip.trackId = trackId; clip.regionId = regionId;
    clip.position = TickTime::fromBeats(0.0); clip.duration = TickTime::fromBeats(1.0);
    timeline.addClip(clip);

    SampleBank bank;
    const int sampleId = bank.loadSample(impulseWav, sampleRate);
    CHECK(sampleId >= 0, "master-latency sample loaded");

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(regionId, sampleId);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    const int masterRsNode = engine.addMasterEffect("resonancesuppressor", 0);
    CHECK(masterRsNode >= 0, "master RS effect added");
    CHECK(engine.setMasterEffectParameter(masterRsNode, "processing_mode", 1.0f),
          "master RS should switch to High Quality");
    CHECK(engine.setMasterEffectParameter(masterRsNode, "quality", 1.0f),
          "master RS quality should be settable");
    CHECK(engine.setMasterEffectParameter(masterRsNode, "depth", 0.0f),
          "master RS depth should be settable");
    CHECK(engine.setMasterEffectParameter(masterRsNode, "mix", 100.0f),
          "master RS mix should be settable");
    CHECK(engine.setMasterEffectParameter(masterRsNode, "delta", 0.0f),
          "master RS delta should be settable");
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    const auto latencySnapshot = engine.getLatencyCompensationSnapshot();
    CHECK(latencySnapshot.maxAudibleTrackLatencySamples == 0,
          "master-only latency case should not add live track-to-track compensation");
    CHECK(latencySnapshot.masterInsertLatencySamples == 1024,
          "master RS should contribute trim-only export latency");

    Transport transport;
    auto trimmed = renderTrimmedRange(engine, transport, 0, 2048, sampleRate, bpm, blockSize);
    CHECK(trimmed.getNumSamples() == 2048, "master-latency trimmed render should preserve requested duration");
    CHECK(findPeakIndex(trimmed, 0) == impulseIndex,
          "master-latency trimmed export should remove master lead-in");
}

static void testTrackPdcExportTrimVariants()
{
    std::cout << "[PDC 7] Export trim variants\n";

    const double bpm = 120.0;
    const double sampleRate = 51200.0;
    constexpr int blockSize = 512;
    constexpr int impulseIndex = 128;

    auto tempDir = makeTempTestDir("xleth_test_pdc_export");
    auto impulseWav = generateImpulseWav(tempDir, "impulse", sampleRate, 4096, impulseIndex, 0.25f);
    CHECK(impulseWav.existsAsFile(), "export-trim impulse WAV generated");

    verifyTrackPdcExportTrimProjectStart(impulseWav, sampleRate, bpm, blockSize, impulseIndex);
    verifyTrackPdcExportTrimMidProject(impulseWav, sampleRate, bpm, blockSize, impulseIndex);
    verifyTrackPdcExportTrimNoPdc(impulseWav, sampleRate, bpm, blockSize, impulseIndex);
    verifyTrackPdcExportTrimMasterLatency(impulseWav, sampleRate, bpm, blockSize, impulseIndex);

    tempDir.deleteRecursively();
}

static void testTrackPdcTopologySafety()
{
    std::cout << "[PDC 8] Track/plugin topology safety\n";

    const double bpm = 120.0;
    const double sampleRate = 51200.0;
    constexpr int blockSize = 512;
    constexpr int impulseIndex = 128;

    Timeline timeline(bpm, sampleRate);
    TrackInfo trackA; trackA.name = "TrackA";
    TrackInfo trackB; trackB.name = "TrackB";
    TrackInfo trackC; trackC.name = "TrackC";
    const int trackAId = timeline.addTrack(trackA);
    const int trackBId = timeline.addTrack(trackB);
    const int trackCId = timeline.addTrack(trackC);

    SampleRegion regionA; regionA.name = "RegionA"; regionA.label = SampleLabel::Custom;
    SampleRegion regionB; regionB.name = "RegionB"; regionB.label = SampleLabel::Custom;
    SampleRegion regionC; regionC.name = "RegionC"; regionC.label = SampleLabel::Custom;
    const int regionAId = timeline.addRegion(regionA);
    const int regionBId = timeline.addRegion(regionB);
    const int regionCId = timeline.addRegion(regionC);

    Clip clipA; clipA.trackId = trackAId; clipA.regionId = regionAId;
    clipA.position = TickTime::fromBeats(0.0); clipA.duration = TickTime::fromBeats(1.0);
    Clip clipB = clipA; clipB.trackId = trackBId; clipB.regionId = regionBId;
    Clip clipC = clipA; clipC.trackId = trackCId; clipC.regionId = regionCId;
    timeline.addClip(clipA);
    timeline.addClip(clipB);
    timeline.addClip(clipC);

    auto tempDir = makeTempTestDir("xleth_test_pdc_topology");
    auto impulseWav = generateImpulseWav(tempDir, "impulse", sampleRate, 4096, impulseIndex, 0.2f);

    SampleBank bank;
    const int sampleId = bank.loadSample(impulseWav, sampleRate);
    CHECK(sampleId >= 0, "topology sample loaded");

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(regionAId, sampleId);
    engine.mapRegionToSample(regionBId, sampleId);
    engine.mapRegionToSample(regionCId, sampleId);
    engine.syncTrackSlotsFromTimeline(false);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    const int rsNode = engine.addEffect(trackCId, "resonancesuppressor", 0);
    CHECK(rsNode >= 0, "topology RS effect added");
    configureHighQualityResonanceSuppressor(engine, trackCId, rsNode, 1, 100.0f, false, 0.0f);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    Transport transport;
    transport.setSampleRate(sampleRate);
    transport.setBPM(bpm);

    auto initial = offlineRender(engine, transport, 4096, blockSize);
    CHECK(allSamplesFinite(initial), "initial topology render should stay finite");

    CHECK(engine.removeEffect(trackCId, rsNode), "existing effect should remove cleanly");
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    CHECK(timeline.removeTrack(trackAId), "track A should remove cleanly");
    engine.destroyEffectChain(trackAId);
    engine.syncTrackSlotsFromTimeline(false);

    auto afterRemoval = offlineRender(engine, transport, 4096, blockSize);
    CHECK(allSamplesFinite(afterRemoval), "render after track removal and slot remap should stay finite");

    TrackInfo trackD; trackD.name = "TrackD";
    const int trackDId = timeline.addTrack(trackD);
    SampleRegion regionD; regionD.name = "RegionD"; regionD.label = SampleLabel::Custom;
    const int regionDId = timeline.addRegion(regionD);
    Clip clipD; clipD.trackId = trackDId; clipD.regionId = regionDId;
    clipD.position = TickTime::fromBeats(0.0); clipD.duration = TickTime::fromBeats(1.0);
    timeline.addClip(clipD);
    engine.mapRegionToSample(regionDId, sampleId);
    engine.syncTrackSlotsFromTimeline(false);

    const int newRsNode = engine.addEffect(trackDId, "resonancesuppressor", 0);
    CHECK(newRsNode >= 0, "effect should add cleanly after slot remap");
    configureHighQualityResonanceSuppressor(engine, trackDId, newRsNode, 1, 100.0f, false, 0.0f);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(true);

    auto afterAdd = offlineRender(engine, transport, 4096, blockSize);
    CHECK(allSamplesFinite(afterAdd), "render after track add and plugin add should stay finite");

    tempDir.deleteRecursively();
}

static bool processRealtimeDiagnosticBlocks(MixEngine& engine, Transport& transport,
                                            int blockSize, int numBlocks)
{
    bool finite = true;
    for (int block = 0; block < numBlocks; ++block)
    {
        juce::AudioBuffer<float> buffer(2, blockSize);
        buffer.clear();
        engine.processBlock(buffer, blockSize, transport);
        finite = finite && allSamplesFinite(buffer);
        transport.advance(blockSize);
    }
    return finite;
}

static void testRealtimeDiagnosticsAndResonanceSuppressorSafety()
{
    std::cout << "[RT 1] Realtime diagnostics and RS High Quality stability\n";

    const double bpm = 120.0;
    const double sampleRate = 48000.0;
    constexpr int blockSize = 512;
    constexpr int impulseIndex = 128;

    Timeline timeline(bpm, sampleRate);
    int dryTrackId = 0, wetTrackId = 0, dryRegionId = 0, wetRegionId = 0;
    addTwoTrackImpulseClips(timeline, 0, sampleRate, bpm,
                            dryTrackId, wetTrackId, dryRegionId, wetRegionId);

    auto tempDir = makeTempTestDir("xleth_test_rt_diag");
    auto impulseWav = generateImpulseWav(tempDir, "impulse", sampleRate, 8192,
                                         impulseIndex, 0.25f);

    SampleBank bank;
    const int sampleId = bank.loadSample(impulseWav, sampleRate);
    CHECK(sampleId >= 0, "realtime diagnostic sample loaded");

    MixEngine engine;
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    engine.mapRegionToSample(dryRegionId, sampleId);
    engine.mapRegionToSample(wetRegionId, sampleId);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(false);

    const int rsNode = engine.addEffect(wetTrackId, "resonancesuppressor", 0);
    CHECK(rsNode >= 0, "realtime diagnostic RS effect added");
    configureHighQualityResonanceSuppressor(engine, wetTrackId, rsNode, 2,
                                            100.0f, false, 0.0f);
    engine.prepare(sampleRate, blockSize);
    engine.setNonRealtime(false);

    Transport transport;
    transport.setSampleRate(sampleRate);
    transport.setBPM(bpm);
    transport.play();

    engine.setRealtimeDiagnosticsEnabled(true);

    // Establish the initial latency target before measuring steady-state churn.
    CHECK(processRealtimeDiagnosticBlocks(engine, transport, blockSize, 1),
          "realtime warmup block should stay finite");

    engine.resetRealtimeDiagnostics();
    CHECK(processRealtimeDiagnosticBlocks(engine, transport, blockSize, 48),
          "realtime diagnostic output should stay finite");

    auto snapshot = engine.getRealtimeDiagnosticsSnapshot();
    std::cout << std::fixed << std::setprecision(3)
              << "  [RT budget] block=" << snapshot.lastBlockSize
              << " deadlineMs=" << snapshot.lastDeadlineMs
              << " maxProcessMs=" << snapshot.maxProcessBlockMs
              << " maxRatio=" << snapshot.maxProcessBlockRatio
              << " maxPluginMs=" << snapshot.maxPluginMs
              << " rsWolaMaxMs=" << snapshot.maxResonanceSuppressorWolaMs
              << " pdcMaxMs=" << snapshot.maxPdcDelayMs
              << " diagnosis=" << snapshot.diagnosis << "\n";

    CHECK(snapshot.blockCount == 48, "diagnostics should count measured realtime blocks");
    CHECK(snapshot.chainLockMissCount == 0, "realtime chain lock should not miss without contention");
    CHECK(snapshot.pdcRetargetCount == 0, "PDC target should stay stable after warmup");
    CHECK(snapshot.resonanceSuppressorWolaCallCount > 0,
          "RS High Quality WOLA should be timed in realtime diagnostics");
    CHECK(snapshot.resonanceSuppressorAudioThreadReprepareCount == 0,
          "RS High Quality should not reprepare on the audio thread");
    CHECK(snapshot.pdcDelayProcessCount > 0, "track PDC delay should be timed");
    CHECK(snapshot.nanInfBlockCount == 0, "realtime diagnostic output should contain no NaN/Inf");
    CHECK(snapshot.overrunBlockCount == 0, "controlled realtime diagnostic should not overrun block deadline");

    CHECK(engine.setEffectParameter(wetTrackId, rsNode, "quality", 1.0f),
          "RS quality change should be settable during realtime simulation");
    engine.resetRealtimeDiagnostics();
    CHECK(processRealtimeDiagnosticBlocks(engine, transport, blockSize, 8),
          "quality-change realtime output should stay finite");
    auto qualitySnapshot = engine.getRealtimeDiagnosticsSnapshot();
    CHECK(engine.getTrackInsertLatencySamples(wetTrackId) == 1024,
          "quality change should update RS latency to Normal once");
    CHECK(qualitySnapshot.resonanceSuppressorAudioThreadReprepareCount == 0,
          "quality change should not cause audio-thread WOLA reprepare");
    CHECK(qualitySnapshot.pdcRetargetCount <= 1,
          "quality change should retarget PDC once, not every block");
    CHECK(qualitySnapshot.nanInfBlockCount == 0,
          "quality-change output should contain no NaN/Inf");

    transport.seekToSample(0);
    transport.play();
    CHECK(engine.setEffectParameter(wetTrackId, rsNode, "mix", 0.0f),
          "RS mix=0 should be settable");
    engine.resetRealtimeDiagnostics();
    CHECK(processRealtimeDiagnosticBlocks(engine, transport, blockSize, 8),
          "mix=0 realtime output should stay finite");
    auto dryOnlySnapshot = engine.getRealtimeDiagnosticsSnapshot();
    CHECK(dryOnlySnapshot.pluginCallCount > 0, "mix=0 should still execute lightweight plugin path");
    CHECK(dryOnlySnapshot.resonanceSuppressorWolaCallCount == 0,
          "mix=0 should skip heavy RS WOLA processing");
    CHECK(dryOnlySnapshot.nanInfBlockCount == 0,
          "mix=0 output should contain no NaN/Inf");

    transport.seekToSample(0);
    transport.play();
    CHECK(engine.setEffectParameter(wetTrackId, rsNode, "mix", 100.0f),
          "RS mix=100 should be restorable");
    CHECK(engine.setEffectBypass(wetTrackId, rsNode, true),
          "RS bypass should be settable");
    CHECK(processRealtimeDiagnosticBlocks(engine, transport, blockSize, 1),
          "bypass ramp warmup should stay finite");
    engine.resetRealtimeDiagnostics();
    CHECK(processRealtimeDiagnosticBlocks(engine, transport, blockSize, 8),
          "bypassed realtime output should stay finite");
    auto bypassSnapshot = engine.getRealtimeDiagnosticsSnapshot();
    CHECK(bypassSnapshot.pluginCallCount > 0, "bypass should still execute lightweight plugin path");
    CHECK(bypassSnapshot.resonanceSuppressorWolaCallCount == 0,
          "fully bypassed RS should skip heavy WOLA processing");
    CHECK(bypassSnapshot.nanInfBlockCount == 0,
          "bypassed output should contain no NaN/Inf");

    engine.setRealtimeDiagnosticsEnabled(false);
    tempDir.deleteRecursively();
}

int main()
{
    // Initialize JUCE message manager (needed for audio format manager)
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "=== MixEngine Self-Verification ===\n\n";

    testPanLaw();
    testDebugLog();
    testPeakMeters();
    testTrackSlotSync();
    testBasicRendering();
    testMute();
    testSolo();
    testEQTailNoClick();
    testTrackPdcTwoTrackImpulseAlignment();
    testTrackPdcMultiLatencyAlignment();
    testTrackPdcBypassRecalculation();
    testTrackPdcResonanceMixZeroAndQualityLatencyChange();
    testTrackPdcRawLivePlaybackProjectStart();
    testTrackPdcRawLivePlaybackMidProject();
    testTrackPdcExportTrimVariants();
    testTrackPdcTopologySafety();
    testRealtimeDiagnosticsAndResonanceSuppressorSafety();

    std::cout << "\n";
    if (g_failed == 0)
    {
        std::cout << "ALL TESTS PASSED (" << g_passed << " checks)\n";
        return 0;
    }
    else
    {
        std::cout << "FAILED: " << g_failed << " of " << (g_passed + g_failed) << " checks failed\n";
        return 1;
    }
}
