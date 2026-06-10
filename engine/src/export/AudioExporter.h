#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include "render/RenderScope.h"   // xleth::TailRenderPlan (Phase 3A tail policy)

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

        // Phase 3A tail policy. Default (HardCut, maxTailSamples == 0) reproduces
        // pre-3A behaviour: render exactly [startBeat, endBeat) with no tail. The
        // bridge derives this from the project LoopRegion via
        // xleth::computeTailRenderPlan() at the export sample rate.
        xleth::TailRenderPlan tail{};
    };

    struct PrerollPlan {
        // Track-path latency term of the pre-roll. The MixEngine-driven
        // overloads fill this with the route-aware max path latency
        // (MixEngine::getMaxPathLatencySamples(), Prompt 2C) — for an unrouted
        // project that equals the flat max audible track latency this field is
        // named after. Master insert latency is the separate downstream term.
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
    // `output` is sized to (totalSamples + tail.maxTailSamples). The main
    // capture fills the first totalSamples; the tail (if tail.mode == TailClamp)
    // continues past captureEnd, reading the master-bus peak each block to detect
    // when the wet effect tail has decayed (or the cap is hit). The note-trigger
    // ceiling is set so no NEW notes/clips start during the tail. The number of
    // samples actually written (capture + detected tail) is returned via
    // outRenderedSamples.
    bool renderOffline(const Timeline& timeline,
                       MixEngine& mixer,
                       int64_t startSample,
                       int64_t warmUpStartSample,
                       int totalSamples,
                       int sampleRate,
                       const xleth::TailRenderPlan& tail,
                       juce::AudioBuffer<float>& output,
                       int& outRenderedSamples,
                       std::function<void(float)> progressCallback,
                       std::atomic<bool>& cancelFlag);

    // Phase 3B wrap (seamless loop tail-fold) render pass, corrected in 3B-r1.
    // Distinct from renderOffline so the Phase 3A hardCut/tailClamp path is
    // untouched. Strictly sequential (via xleth::renderWrapCore) — NO looped-region
    // pre-roll, NO backward seek:
    //   (A) absolute warm-up from warmUpStartSample → startSample (RETAINED: it
    //       recreates the in-flight timeline context — notes/clips/effect tails
    //       already sounding at the region start — and is discarded);
    //   (B) capture [startSample, endSample) into `output` (sized to EXACTLY
    //       totalSamples), flowing straight out of the warm-up;
    //   (C) render the post-end tail (no new triggers past endSample) into a
    //       working buffer until the master bus decays below threshold or the cap
    //       is hit;
    //   (D) fold the ENTIRE tail onto the region head
    //       (output[i % totalSamples] += tail[i], multiple wraps included).
    // The fold alone supplies the loop-seam energy (a looped-region pre-roll would
    // double-count it). The final duration is exactly totalSamples — the tail never
    // extends the output.
    bool renderOfflineWrap(const Timeline& timeline,
                           MixEngine& mixer,
                           int64_t startSample,
                           int64_t warmUpStartSample,
                           int totalSamples,
                           int sampleRate,
                           const xleth::TailRenderPlan& tail,
                           juce::AudioBuffer<float>& output,
                           int& outRenderedSamples,
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
