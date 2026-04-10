#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <atomic>
#include <cstdint>
#include <string>

/// Plays source media files through the engine's audio output for the Sample
/// Picker.  The entire audio track is decoded into RAM on load (via FFmpeg),
/// so processBlock() is a simple memory copy — no I/O, no allocation.
///
/// Thread safety:
///   - loadSource / unloadSource: main thread only
///   - play / pause / resume / seek / stop: any thread (atomic state)
///   - processBlock: audio thread only (called from AudioEngine callback)
///   - isPlaying / isLoaded / getPosition / getDuration: any thread (atomic reads)
class SourcePlayer
{
public:
    SourcePlayer();
    ~SourcePlayer();

    // ── Main-thread API ──────────────────────────────────────────────────────

    /// Decode the audio track of `filePath` into RAM at `engineSampleRate`.
    /// Returns true on success.  Blocks until decoding is complete.
    bool loadSource(const std::string& filePath, double engineSampleRate);

    /// Release decoded audio buffer.
    void unloadSource();

    /// Lightweight probe: opens `filePath` with FFmpeg, checks for an audio
    /// stream, reads duration, and closes.  No decoding.  Used by the import
    /// pipeline to classify audio-only sources before committing to a full
    /// load.  Returns true iff an audio stream was found.
    static bool probeAudio(const std::string& filePath, double& outDurationSec);

    // ── Transport (any thread) ───────────────────────────────────────────────

    void play(double startTimeSeconds);
    void pause();
    void resume();
    void seek(double timeSeconds);
    void stop();

    // ── State queries (any thread) ───────────────────────────────────────────

    bool   isPlaying()  const { return playing_.load(std::memory_order_acquire); }
    bool   isLoaded()   const { return loaded_.load(std::memory_order_acquire); }
    double getPosition() const;   // current playback position in seconds
    double getDuration() const;   // total duration in seconds

    // ── Audio thread ─────────────────────────────────────────────────────────

    /// Mix source audio into `outputBuffer`.  Called from the audio callback.
    /// AUDIO THREAD RULES: no alloc, no lock, no I/O.
    void processBlock(juce::AudioBuffer<float>& outputBuffer, int numSamples);

private:
    juce::AudioBuffer<float> decodedAudio_;   // entire source in RAM (stereo)
    double sampleRate_  = 48000.0;
    int64_t totalSamples_ = 0;
    double duration_      = 0.0;

    std::atomic<int64_t> playPosition_ { 0 };
    std::atomic<bool>    playing_      { false };
    std::atomic<bool>    loaded_       { false };
};
