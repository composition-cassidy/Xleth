#pragma once

#include <cstdint>
#include <vector>
#include "Transport.h"

class AudioEngine;  // forward declaration — breaks circular include with AudioEngine.h

// A scheduled audio event on the timeline.
struct AudioEvent {
    double beatPosition;  // When to trigger (in beats)
    int    sampleId;      // Which sample to play
    float  velocity;      // 0.0–1.0
};

class AudioScheduler
{
public:
    AudioScheduler(Transport& transport, AudioEngine& engine);

    // Call from the main thread before playback starts — not during playback.
    void addEvent(const AudioEvent& event);
    void clearEvents();

    // Called from the audio thread inside getNextAudioBlock().
    // Checks if any events fall within the current buffer window
    // and triggers them with sample-accurate timing.
    // AUDIO THREAD ONLY — no alloc, no locking, no I/O.
    void processBlock(int numSamples);

private:
    Transport&   transport_;
    AudioEngine& engine_;

    std::vector<AudioEvent>  events_;
    std::vector<uint8_t>     triggered_;  // 0=armed, 1=fired — avoids vector<bool> proxy issues

    // Track position from the previous buffer to detect backward seeks.
    // Initialized to -1 so the first buffer never triggers a spurious reset.
    int64_t lastKnownPosition_ = -1;

    // Replicate Transport's private beatsToSamples via public getters.
    // Safe to call from the audio thread (reads only stable, atomic-backed state).
    int64_t beatsToSamples(double beats) const;
};
