#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

#include "AudioScheduler.h"
#include "TriggerQueue.h"
#include "VoiceManager.h"
#include "SampleBank.h"
#include "Transport.h"
#include "audio/MixEngine.h"
#include "audio/SourcePlayer.h"

class AudioEngine : public juce::AudioIODeviceCallback
{
public:
    AudioEngine();
    ~AudioEngine() override;

    void audioDeviceAboutToStart(juce::AudioIODevice* device) override;
    void audioDeviceIOCallbackWithContext(const float* const* inputChannelData,
                                         int                 numInputChannels,
                                         float* const*       outputChannelData,
                                         int                 numOutputChannels,
                                         int                 numSamples,
                                         const juce::AudioIODeviceCallbackContext& context) override;
    void audioDeviceStopped() override;

    bool initialize(bool recordToFile = false);
    void shutdown();

    // Connect the sample bank. Call from main thread before playback starts.
    void setSampleBank(const SampleBank* bank) { sampleBank_ = bank; mixEngine_.setSampleBank(bank); }

    // Callable from any thread — pushes a trigger into the lock-free queue.
    void queueTrigger(int sampleId, float velocity = 1.0f);

    Transport&      getTransport()       { return transport_; }
    AudioScheduler& getAudioScheduler() { return audioScheduler_; }
    MixEngine&      getMixEngine()       { return mixEngine_; }
    SourcePlayer&   getSourcePlayer()    { return sourcePlayer_; }

    struct LivePresentationLatencyDiagnostics
    {
        int64_t maxTrackLatencySamples = 0;
        int64_t masterLatencySamples = 0;
        int64_t deviceOutputLatencySamples = 0;
        int64_t totalPresentationLatencySamples = 0;
    };

    void playTimeline();
    void seekTimelineToSample(int64_t sample);
    void seekTimelineToBeat(double beat);
    void refreshLivePresentationLatency();
    int64_t getLivePresentationLatencySamples() const;
    int64_t getLivePresentationPositionSamples() const;
    double  getLivePresentationPositionSeconds() const;
    LivePresentationLatencyDiagnostics getLivePresentationLatencyDiagnostics() const;
    void setTestDeviceOutputLatencySamplesForDiagnostics(int64_t samples);
    MixEngine::RealtimeDiagnosticsSnapshot getAudioPerformanceTelemetrySnapshot() const
    {
        return mixEngine_.getRealtimeDiagnosticsSnapshot();
    }

    // Suspend / resume the audio device callback.  Used by export codepaths
    // to guarantee exclusive MixEngine access on the render thread.
    void suspendCallback() { deviceManager_.removeAudioCallback(this); }
    void resumeCallback()  { deviceManager_.addAudioCallback(this); }

    bool   analyzeRecording(const juce::File& wavFile) const;
    double getSampleRate()  const { return sampleRate_; }
    int    getBufferSize()  const { return bufferSize_; }
    double getLatencyMs()   const;

    std::vector<std::string> getOutputDevices()       const;
    std::string              getCurrentOutputDevice()  const;
    std::string              setOutputDevice(const std::string& deviceName);
    void                     setPreferredOutputDevice(const std::string& name) { preferredOutputDevice_ = name; }

private:
    juce::AudioDeviceManager deviceManager_;
    juce::AudioFormatManager formatManager_;

    TriggerQueue             triggerQueue_  { 256 };
    VoiceManager             voiceManager_  { 32  };
    const SampleBank*        sampleBank_    = nullptr;
    Transport                transport_;
    AudioScheduler           audioScheduler_;
    MixEngine                mixEngine_;
    SourcePlayer             sourcePlayer_;

    juce::TimeSliceThread                                    writerThread_ { "WavWriter" };
    std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> wavWriter_;
    juce::File                                               recordingFile_;

    double sampleRate_  = 44100.0;
    int    bufferSize_  = 256;
    bool   initialized_ = false;

    std::atomic<int64_t> livePresentationMaxTrackLatencySamples_{ 0 };
    std::atomic<int64_t> livePresentationMasterLatencySamples_{ 0 };
    std::atomic<int64_t> livePresentationDeviceOutputLatencySamples_{ 0 };
    std::atomic<int64_t> livePresentationTotalLatencySamples_{ 0 };
    std::atomic<int64_t> testDeviceOutputLatencyOverrideSamples_{ -1 };

    int64_t readCurrentDeviceOutputLatencySamples() const;
    void cacheCurrentDeviceOutputLatency();

    void*       mmcssHandle_        = nullptr;
    std::string preferredOutputDevice_;
};
