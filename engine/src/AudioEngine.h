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
    // to guarantee exclusive MixEngine access on the render thread. The
    // suspended flag is what stops the device watchdog from mistaking a
    // deliberate teardown for a dead driver.
    void suspendCallback()
    {
        callbackSuspended_.store(true, std::memory_order_release);
        deviceManager_.removeAudioCallback(this);
    }
    void resumeCallback()
    {
        deviceManager_.addAudioCallback(this);
        callbackSuspended_.store(false, std::memory_order_release);
    }

    // ── Device-health watchdog ───────────────────────────────────────────────
    // Sleep/resume invalidates the WASAPI render client (AUDCLNT_E_DEVICE_-
    // INVALIDATED) and a hot-unplugged interface does the same. In both cases
    // JUCE keeps handing back a non-null AudioIODevice with plausible-looking
    // sample rate and latency, but the driver thread is gone and
    // audioDeviceIOCallbackWithContext is never invoked again — so the
    // transport silently stops advancing and playback produces nothing.
    //
    // The audio callback bumps a counter; checkDeviceHealth() polls it from a
    // non-audio thread and reopens the device once the counter has been frozen
    // for longer than any legitimate buffer period. Cheap enough (two atomic
    // loads on the healthy path) to hang off the engine's existing high-rate
    // poll. Returns true when a recovery reopen actually happened.
    //
    // MUST be called from the message/RPC thread — reopenAudioDevice() drives
    // juce::AudioDeviceManager, which is not thread-safe, and the resulting
    // audioDeviceAboutToStart -> MixEngine::prepare() has to land on the same
    // thread that owns the effect-chain graphs.
    bool checkDeviceHealth();
    bool reopenAudioDevice();

    // Pure watchdog policy — the decision half of checkDeviceHealth(), split out
    // so the starvation thresholds and backoff can be tested without a real
    // audio device. checkDeviceHealth() calls exactly this, so a test here
    // exercises the shipping policy rather than a copy of it.
    struct WatchdogInputs
    {
        bool    suspended          = false; // callback deliberately detached
        bool    counterMoved       = false; // callback ran since the last poll
        bool    resumeArmed        = false; // system resume seen since last poll
        int64_t msSinceProgress    = 0;     // age of the last observed callback
        int64_t msUntilNextAttempt = 0;     // >0 while backing off after failures
    };
    static bool shouldAttemptRecovery(const WatchdogInputs& in);

    // Raises the "system just resumed" flag, shortening the watchdog's
    // starvation window on the next poll. Safe to call from any thread — it
    // stores a single atomic and does no device work. Called by the OS power
    // notification, and directly by tests.
    void notifySystemResume() { resumeFromSleepPending_.store(true, std::memory_order_release); }

    bool   analyzeRecording(const juce::File& wavFile) const;
    double getSampleRate()  const { return sampleRate_; }
    int    getBufferSize()  const { return bufferSize_; }
    double getLatencyMs()   const;

    // ── Audio-health instrumentation ─────────────────────────────────────────
    // [XRun] Current device hardware x-run (under/overflow) count, or -1 when the
    // active driver does not report it. CPU usage is the JUCE device-manager load
    // estimate in [0,1]. Both are cheap, lock-free-ish reads safe to poll from a
    // background sampler thread during steady playback.
    int    getDeviceXRunCount() const;
    double getDeviceCpuUsage()  const;

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

    // ── Device-health watchdog state ─────────────────────────────────────────
    // Written on the audio thread, read by the watchdog poll.
    std::atomic<uint64_t> callbackCounter_{ 0 };
    // Set while the callback is deliberately detached (export).
    std::atomic<bool>     callbackSuspended_{ false };
    // Set by the OS power-notification callback on an arbitrary thread; it only
    // ever raises this flag, all device work stays on the polling thread.
    std::atomic<bool>     resumeFromSleepPending_{ false };

    // Watchdog-thread-only scratch — no synchronisation needed.
    uint64_t watchdogLastCounter_      = 0;
    int64_t  watchdogLastProgressMs_   = 0;
    int64_t  watchdogNextAttemptMs_    = 0;
    int      watchdogFailedAttempts_   = 0;
    bool     watchdogResumeArmed_      = false;

    void registerPowerNotification();
    void unregisterPowerNotification();
    void* powerNotifyHandle_ = nullptr;

    void*       mmcssHandle_        = nullptr;
    std::string preferredOutputDevice_;
};
