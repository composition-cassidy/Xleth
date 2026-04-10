// test_mix.cpp — Phase 1 self-verification for multi-track MixEngine.
// Build: see engine/CMakeLists.txt target "test_mix"
// Run:   test_mix.exe
// Pass:  prints "ALL TESTS PASSED" and exits 0
// Fail:  prints "FAILED: <reason>" and exits 1

#include "audio/MixEngine.h"
#include "audio/TrackMixer.h"
#include "model/Timeline.h"
#include "SampleBank.h"
#include "Transport.h"

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

// ─── main ────────────────────────────────────────────────────────────────────

int main()
{
    // Initialize JUCE message manager (needed for audio format manager)
    juce::ScopedJuceInitialiser_GUI juceInit;

    std::cout << "=== MixEngine Self-Verification ===\n\n";

    testPanLaw();
    testDebugLog();
    testPeakMeters();
    testBasicRendering();
    testMute();
    testSolo();

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
