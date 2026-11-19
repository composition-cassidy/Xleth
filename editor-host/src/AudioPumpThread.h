#pragma once

// AudioPumpThread — reads from a NamedAudioRing and calls
// juce::AudioPluginInstance::processBlock() on each block, purely so the
// editor-process plugin instance's internal analyzer state (FFT buffers,
// envelope followers, spectrograms) stays in sync with the worker's real
// audio. The rendered output is discarded.
//
// Threading:
//   run() is a dedicated OS thread; the plugin is NOT the audio device.
//   processBlock is called from a plain std::thread — acceptable because the
//   instance here only has analyzer responsibilities, no real-time output.
//
// Lifetime:
//   Constructed on the message thread after the ring is opened and the plugin
//   has been prepareToPlay'd. Destructor signals stop_ and joins the thread.

#include <atomic>
#include <memory>
#include <thread>

#include <juce_audio_processors/juce_audio_processors.h>

class NamedAudioRing;

class AudioPumpThread
{
public:
    // Takes ownership of the ring. The plugin is borrowed (owned by
    // EditorHostApp). Caller must guarantee the plugin outlives this thread.
    AudioPumpThread(juce::AudioPluginInstance*        plugin,
                    std::unique_ptr<NamedAudioRing>   ring);
    ~AudioPumpThread();

    // Synchronously stop the pump thread. Sets the stop flag and joins.
    // Idempotent — safe to call multiple times.
    void stop()
    {
        stop_.store(true, std::memory_order_release);
        if (thread_.joinable()) thread_.join();
    }

private:
    void run();

    juce::AudioPluginInstance*      plugin_;
    std::unique_ptr<NamedAudioRing> ring_;
    std::atomic<bool>               stop_   {false};
    std::thread                    thread_;
};
