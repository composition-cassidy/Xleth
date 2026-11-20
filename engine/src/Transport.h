#pragma once

#include <atomic>
#include <cstdint>

class Transport
{
public:
    Transport();

    void setSampleRate(double sr);
    void setBPM(double bpm);

    void play();
    void stop();   // Stops and resets position to 0
    void pause();  // Stops but keeps position

    // Called ONLY from the audio thread at the end of each buffer
    void advance(int numSamples);

    // Thread-safe reads (atomic) — callable from ANY thread
    int64_t getPositionSamples() const;
    int64_t getRenderPositionSamples() const;
    double  getPositionSeconds() const;
    double  getPositionBeats()   const;  // Beat number (e.g., 4.5 = beat 4, halfway to beat 5)
    int     getPositionBars()    const;  // Bar number, 1-indexed, 4/4 assumed
    bool    isPlaying()          const;
    double  getBPM()             const;
    double  getSampleRate()      const;

    // Legacy Stage 2 live-preroll hooks. Presentation latency is now owned by
    // AudioEngine, so these are retained only for compatibility with older
    // probes and always report no Transport-level presentation state.
    bool    isPresentationPrerolling() const;
    int64_t getPresentationLatencySamples() const;

    // Seek
    void seekToSample(int64_t sample);
    void seekToBeat(double beat);

    // ── Live playback loop trap ───────────────────────────────────────────────
    // Set the loop window (already converted to samples by the caller using the
    // current BPM / sample-rate) and the enabled flag. Called from the message
    // thread by the bridge after a LoopRegion mutation, on project load, and on
    // BPM change. Recomputes the arm latch against the current position so
    // shrinking the window past the playhead disarms it until natural re-entry —
    // it never yanks the playhead. The wrap itself is applied on the audio thread
    // inside advance().
    void setLoopBounds(int64_t startSamples, int64_t endSamples, bool enabled);
    bool isLoopEnabled() const;
    bool isLoopArmed()   const;  // diagnostic read — true while the trap is active

    // AUDIO THREAD ONLY. How many of the next `numSamples` may be rendered from
    // the current position before the loop trap wraps — the seam splitter for
    // the mix callback. Returns `numSamples` when this block does not cross the
    // loop end (and always when stopped or the trap is disabled), otherwise the
    // count that lands the playhead exactly on the loop end, so a following
    // advance() of that count wraps to exactly the loop start.
    //
    // Rendering a whole buffer and wrapping afterwards skips the region's first
    // (overshoot) samples on every lap — see xleth::loopSamplesUntilWrap.
    int samplesUntilLoopWrap(int numSamples) const;

private:
    // Position, playing flag and loop-trap arm latch share ONE atomic word, so
    // every change to them is a single store or CAS. advance() (audio thread)
    // CASes from the word it read, so a seek/stop/pause that lands mid-block
    // fails that CAS and wins; it can never be written back over.
    // Layout: bits 63..2 = position in samples (signed, +-2^61), bit 1 = playing,
    // bit 0 = loop armed (the latch: the audio thread arms on natural entry, the
    // message thread re-evaluates it on play/seek/stop/bounds events).
    std::atomic<int64_t> state_{ 0 };
    std::atomic<double>  bpm_{ 140.0 };
    double               sampleRate_ = 44100.0;

    // Loop bounds/enabled: written from the message thread, read on the audio
    // thread. All atomic → no locks on the audio path.
    std::atomic<bool>    loopEnabled_{ false };
    std::atomic<int64_t> loopStartSamples_{ 0 };
    std::atomic<int64_t> loopEndSamples_{ 0 };

    double  samplesToSeconds(int64_t samples) const;
    double  samplesToBeats(int64_t samples)   const;
    int64_t beatsToSamples(double beats)       const;
};
