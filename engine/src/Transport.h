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
    void seekToBar(int bar);

    void configureLivePresentationTiming(int64_t renderStart,
                                         int64_t requestedStart,
                                         int64_t totalLatency,
                                         int64_t discardSamples);
    void clearLivePresentationTiming();

private:
    std::atomic<int64_t> positionSamples_{ 0 };
    std::atomic<bool>    playing_{ false };
    std::atomic<double>  bpm_{ 140.0 };
    double               sampleRate_ = 44100.0;

    double  samplesToSeconds(int64_t samples) const;
    double  samplesToBeats(int64_t samples)   const;
    int64_t beatsToSamples(double beats)       const;
};
