#include "AudioScheduler.h"
#include "AudioEngine.h"   // needed to call engine_.queueTrigger()

AudioScheduler::AudioScheduler(Transport& transport, AudioEngine& engine)
    : transport_(transport)
    , engine_(engine)
{
}

// ─────────────────────────────────────────────────────────────────────────────
// Main-thread setup — call before playback starts, never during.
// ─────────────────────────────────────────────────────────────────────────────

void AudioScheduler::addEvent(const AudioEvent& event)
{
    events_.push_back(event);
    triggered_.push_back(0);
}

void AudioScheduler::clearEvents()
{
    events_.clear();
    triggered_.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper — replicates Transport::beatsToSamples() via public getters.
// Transport::beatsToSamples is private; getSampleRate()/getBPM() are public.
// getSampleRate() returns a plain double that is stable after audioDeviceAboutToStart.
// getBPM() reads an atomic — safe from any thread.
// ─────────────────────────────────────────────────────────────────────────────

int64_t AudioScheduler::beatsToSamples(double beats) const
{
    return static_cast<int64_t>(
        beats * (transport_.getSampleRate() * 60.0 / transport_.getBPM()));
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO THREAD — no alloc, no logging, no locks, no I/O.
//
// Algorithm:
// 1. Read current transport position (start of this buffer).
// 2. Detect backward seek (stop/reset or explicit seek): if position jumped
//    backward since last buffer, re-arm all events.
// 3. Skip the event scan when the transport is not playing.
// 4. For each untriggered event whose beat position falls in [start, end),
//    calculate the sample offset within the buffer, queue a trigger, and
//    mark the event as triggered.
// 5. Update lastKnownPosition_ for the next call.
// ─────────────────────────────────────────────────────────────────────────────

void AudioScheduler::processBlock(int numSamples)
{
    const int64_t startSample = transport_.getRenderPositionSamples();

    // ── Seek detection ────────────────────────────────────────────────────────
    // Covers transport.stop() (resets to 0) and any explicit seekTo*() call.
    // lastKnownPosition_ == -1 on the very first call → condition is false.
    if (lastKnownPosition_ >= 0 && startSample < lastKnownPosition_)
    {
        for (uint8_t& t : triggered_)
            t = 0;
    }

    lastKnownPosition_ = startSample;

    // Don't fire events while the transport is stopped/paused.
    if (!transport_.isPlaying())
        return;

    const int64_t endSample = startSample + static_cast<int64_t>(numSamples);

    const int numEvents = static_cast<int>(events_.size());
    for (int i = 0; i < numEvents; ++i)
    {
        if (triggered_[i] != 0) continue;

        const int64_t eventSamplePos = beatsToSamples(events_[i].beatPosition);

        if (eventSamplePos >= startSample && eventSamplePos < endSample)
        {
            // Sample-accurate offset within this buffer (available for future
            // sub-buffer voice scheduling; unused by queueTrigger today).
            // const int offset = static_cast<int>(eventSamplePos - startSample);

            engine_.queueTrigger(events_[i].sampleId, events_[i].velocity);
            triggered_[i] = 1;
        }
    }
}
