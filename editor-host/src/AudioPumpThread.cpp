#include "AudioPumpThread.h"
#include "audio/NamedAudioRing.h"

#include <chrono>
#include <cstdio>

AudioPumpThread::AudioPumpThread(juce::AudioPluginInstance*      plugin,
                                 std::unique_ptr<NamedAudioRing> ring)
    : plugin_(plugin), ring_(std::move(ring))
{
    thread_ = std::thread([this]{ run(); });
}

AudioPumpThread::~AudioPumpThread()
{
    stop();
    // ring_ reset here — consumer-side Unmap+Close in NamedAudioRing dtor.
}

void AudioPumpThread::run()
{
    if (!plugin_ || !ring_) return;

    const int blockSize = ring_->getBlockSize();
    if (blockSize <= 0) return;

    juce::AudioBuffer<float> buffer(/*numChannels*/ 2, blockSize);
    juce::MidiBuffer         emptyMidi;

    float* chans[2] = {
        buffer.getWritePointer(0),
        buffer.getWritePointer(1)
    };

    while (!stop_.load(std::memory_order_acquire))
    {
        if (!visible_.load(std::memory_order_acquire))
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
            continue;
        }

        if (ring_->tryRead(chans, blockSize, /*timeoutMs*/ 10))
        {
            // Re-fetch pointers in case the AudioBuffer internally rebased
            // (it doesn't for fixed-size allocations — belt and braces).
            chans[0] = buffer.getWritePointer(0);
            chans[1] = buffer.getWritePointer(1);

            plugin_->processBlock(buffer, emptyMidi);
            // Output discarded; side effect on analyzer state is the point.
        }
        // tryRead returned false → empty ring; loop again (timeout served as wait).
    }
}
