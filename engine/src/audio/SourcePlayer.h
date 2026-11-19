#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

/// Plays source media files through the engine's audio output for the Sample
/// Picker.  The entire audio track is decoded into RAM on load (via FFmpeg),
/// so processBlock() is a simple memory copy — no I/O, no allocation.
///
/// Thread safety:
///   - loadSource / unloadSource: main thread only
///   - play / pause / resume / seek / stop: any thread (atomic state)
///   - processBlock: audio thread only (called from AudioEngine callback)
///   - isPlaying / isLoaded / getPosition / getDuration: any thread (atomic reads)
///
/// Buffer lifetime: the main thread owns the decoded buffer and publishes it
/// through `current_`; processBlock pins what it reads in `inUse_` (a one-slot
/// hazard pointer), and a buffer is freed only once the pin has moved off it.
/// unloadSource waits for that at most kUnloadWaitMs; a buffer still pinned
/// then is parked on `retired_` and freed by a later load / unload, never while
/// pinned. The audio thread never allocates, frees, locks or waits.
///
/// Why not xleth::util::RtPublished here: it would cost the callback more (an
/// atomic shared_ptr load is four interlocked operations and a spin bit shared
/// with the writer; the pin is one), and this buffer is a whole source in RAM,
/// which the pin lets unloadSource free at once in the normal case instead of
/// at the next prune.
class SourcePlayer
{
public:
    SourcePlayer();
    ~SourcePlayer();

    // ── Main-thread API ──────────────────────────────────────────────────────

    /// Decode the audio track of `filePath` into RAM at `engineSampleRate`.
    /// Returns true on success.  Blocks until decoding is complete.
    bool loadSource(const std::string& filePath, double engineSampleRate);

    /// Release decoded audio buffer. Never blocks longer than kUnloadWaitMs
    /// (plus scheduler slack); see "Buffer lifetime" above. Not for the audio
    /// thread.
    void unloadSource();

    bool isCurrentSource(const std::string& filePath, double engineSampleRate) const;

    /// Lightweight probe: opens `filePath` with FFmpeg, checks for an audio
    /// stream, reads duration, and closes.  No decoding.  Used by the import
    /// pipeline to classify audio-only sources before committing to a full
    /// load.  Returns true iff an audio stream was found.
    static bool probeAudio(const std::string& filePath, double& outDurationSec);

    // ── Transport (any thread) ───────────────────────────────────────────────

    void play(double startTimeSeconds);
    uint64_t playRegionPreview(double startTimeSeconds, double endTimeSeconds);
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
    using Buffer = juce::AudioBuffer<float>;

    void mixBlock(const Buffer& src, juce::AudioBuffer<float>& outputBuffer, int numSamples);

    // Tests reach the pin and the retire list through this; no runtime cost.
    friend struct SourcePlayerTestAccess;

    // The longest unloadSource waits for the callback to let go of a buffer.
    static constexpr int kUnloadWaitMs = 50;

    std::unique_ptr<Buffer> decodedAudio_;     // entire source in RAM (stereo); main thread owns
    std::atomic<Buffer*>    current_ { nullptr };   // what processBlock may pick up
    std::atomic<Buffer*>    inUse_   { nullptr };   // what processBlock is reading right now

    // Unpublished buffers the callback had not let go of within the bound.
    // Main thread only. At most one can still be pinned (there is one pin).
    std::vector<std::unique_ptr<Buffer>> retired_;
    uint64_t deferredFrees_ = 0;        // unloads that hit the bound
    // Frees every retired buffer the pin does not name; true when none is left.
    bool reclaimRetired();

    // Debug builds only: the thread processBlock last ran on, for the
    // "unloadSource is never called from the callback" assertion.
    std::atomic<void*> audioThreadId_ { nullptr };
    double sampleRate_  = 48000.0;
    int64_t totalSamples_ = 0;   // main-thread copy; the audio thread uses the buffer's own size
    double duration_      = 0.0;
    std::string loadedFilePath_;

    std::atomic<int64_t> playPosition_ { 0 };
    std::atomic<int64_t> previewEndSample_ { -1 };
    std::atomic<uint64_t> previewSeq_ { 0 };
    std::atomic<bool>    playing_      { false };
    std::atomic<bool>    loaded_       { false };
};
