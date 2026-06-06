#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>

class Timeline;
class SampleBank;
class MixEngine;

// ─── AudioExporter ────────────────────────────────────────────────────────────
// Offline timeline-to-file renderer. Drives MixEngine with a local Transport
// (independent of AudioEngine's realtime Transport) and encodes the result
// to WAV / MP3 / FLAC via FFmpeg.
//
// exportAudio() runs synchronously on the calling thread. The bridge spawns
// a std::thread so it doesn't block the worker's IPC loop.

class AudioExporter
{
public:
    enum class Format { WAV, MP3, FLAC };

    struct Config {
        std::string outputPath;
        Format      format      = Format::WAV;
        int         sampleRate  = 44100;    // 44100 or 48000
        int         bitDepth    = 24;       // WAV: 16 / 24 / 32(float)
        int         mp3Bitrate  = 320;      // kbps
        int         flacLevel   = 5;        // 0..8
        double      startBeat   = 0.0;
        double      endBeat     = 0.0;      // 0 = auto from max clip end
        // Phase 2 scoped absolute window: beat the engine warms up FROM (output
        // discarded until startBeat). < 0 → warm up at startBeat (legacy
        // latency-only pre-roll). Set to 0 for a scoped absolute render so
        // in-flight notes/effect tails survive into the first captured sample.
        double      warmUpStartBeat = -1.0;
    };

    struct PrerollPlan {
        int     maxAudibleTrackLatencySamples = 0;
        int     masterInsertLatencySamples = 0;
        int64_t totalPrerollSamples = 0;
        int64_t renderStartSample = 0;
        int64_t availablePrerollSamples = 0;
        int64_t discardSamples = 0;
    };

    static PrerollPlan computePrerollPlan(int64_t startSample,
                                          int maxAudibleTrackLatencySamples,
                                          int masterInsertLatencySamples);
    static PrerollPlan computePrerollPlan(MixEngine& mixer,
                                          int64_t startSample);
    // Phase 2 windowed pre-roll: warm-up begins at warmUpStartSample (0 for a
    // scoped absolute window) independent of the capture start.
    static PrerollPlan computePrerollPlan(int64_t warmUpStartSample,
                                          int64_t captureStartSample,
                                          int maxAudibleTrackLatencySamples,
                                          int masterInsertLatencySamples);
    static PrerollPlan computePrerollPlan(MixEngine& mixer,
                                          int64_t warmUpStartSample,
                                          int64_t captureStartSample);

    // Renders [startBeat, endBeat) of the timeline through mixer and writes
    // to config.outputPath. progressCallback receives 0..1 as render+encode
    // progresses (render = 0..0.7, encode = 0.7..1.0). cancelFlag is checked
    // each block — set it to true to abort. Returns true on success.
    bool exportAudio(const Timeline& timeline,
                     const SampleBank& bank,
                     MixEngine& mixer,
                     const Config& config,
                     std::function<void(float)> progressCallback,
                     std::atomic<bool>& cancelFlag);

private:
    // Offline render pass: drives MixEngine::processBlock() in 4096-sample
    // chunks from a local Transport, filling output with the stereo mix.
    bool renderOffline(const Timeline& timeline,
                       MixEngine& mixer,
                       int64_t startSample,
                       int64_t warmUpStartSample,
                       int totalSamples,
                       int sampleRate,
                       juce::AudioBuffer<float>& output,
                       std::function<void(float)> progressCallback,
                       std::atomic<bool>& cancelFlag);

    // Unified FFmpeg-based encoder. Picks codec + sample format from config
    // (WAV -> pcm_s16le/pcm_s24le/pcm_f32le, MP3 -> libmp3lame, FLAC -> flac)
    // and writes the file via the WAV/MP3/FLAC muxer.
    bool encodeWithFFmpeg(const juce::AudioBuffer<float>& buf,
                          const Config& cfg,
                          std::function<void(float)> progressCallback,
                          std::atomic<bool>& cancelFlag);
};
