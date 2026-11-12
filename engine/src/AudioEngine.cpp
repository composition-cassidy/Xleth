#include "AudioEngine.h"
#include "render/RenderClock.h"
#include "util/StartLatencyTrace.h"  // TEMP/DIAGNOSTIC — start-latency probe

#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>

// JUCE module headers define JUCE_WINDOWS but don't include windows.h themselves.
#if JUCE_WINDOWS
  #ifndef NOMINMAX
    #define NOMINMAX
  #endif
  #include <windows.h>
#endif

// (No MMCSS / thread-priority code lives here on purpose. The audio thread is
// owned by the driver layer, not by this class: JUCE's WASAPI backend starts its
// device thread at Priority::high and registers it with MMCSS "Pro Audio" from
// inside that thread (juce_WASAPI_windows.cpp, WASAPIAudioIODevice::run ->
// setMMThreadPriority). audioDeviceAboutToStart, by contrast, is invoked by JUCE
// on the CALLING thread — the RPC thread — so anything boosted from there lands
// on the wrong thread, and MMCSS refuses a second registration on a thread that
// already holds one, which made every reopen after the first log a failure.)

// ── Suspend/resume notification via runtime DLL load ──────────────────────────
// PowerRegisterSuspendResumeNotification with DEVICE_NOTIFY_CALLBACK needs no
// HWND and no message pump, which matters here: the engine is a headless addon
// worker with no window to receive WM_POWERBROADCAST. Declared locally (rather
// than pulling in powrprof.h / linking powrprof.lib) and loaded at runtime to
// keep the build inputs unchanged.
#if JUCE_WINDOWS
namespace {
    constexpr DWORD kDeviceNotifyCallback   = 2;      // DEVICE_NOTIFY_CALLBACK
    constexpr ULONG kPbtApmResumeSuspend    = 0x0007; // PBT_APMRESUMESUSPEND
    constexpr ULONG kPbtApmResumeAutomatic  = 0x0012; // PBT_APMRESUMEAUTOMATIC

    // Layout-compatible with DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS.
    struct XlethPowerNotifySubscribe
    {
        ULONG (CALLBACK* callback)(PVOID, ULONG, PVOID);
        PVOID context;
    };

    using PowerRegisterFn   = DWORD (WINAPI*)(DWORD, PVOID, PHANDLE);
    using PowerUnregisterFn = DWORD (WINAPI*)(HANDLE);

    PowerRegisterFn   g_powerRegister   = nullptr;
    PowerUnregisterFn g_powerUnregister = nullptr;
    bool              g_powrprofTried   = false;

    void loadPowrprof()
    {
        if (g_powrprofTried) return;
        g_powrprofTried = true;
        HMODULE lib = LoadLibraryA("powrprof.dll");
        if (lib)
        {
            g_powerRegister = reinterpret_cast<PowerRegisterFn>(
                GetProcAddress(lib, "PowerRegisterSuspendResumeNotification"));
            g_powerUnregister = reinterpret_cast<PowerUnregisterFn>(
                GetProcAddress(lib, "PowerUnregisterSuspendResumeNotification"));
        }
    }
} // namespace
#endif

// Watchdog tuning. The starvation window has to clear the largest buffer period
// the engine will ever open (kMaxBuf @ kFallback ≈ 10.7 ms) by a wide margin so
// an ordinary scheduling hiccup can never be read as a dead device. 500 ms was
// not a wide enough margin: on a 15 W laptop (Ryzen 5 7520U, shared VRAM) the
// burst that opens the main window — D3D11 device creation, 11 shader compiles,
// the preview shared-memory rebuild — starves the WASAPI callback for just over
// half a second on every launch, and each false positive costs a ~4 s device
// reopen that blocks the RPC thread. A device that died without a resume event
// (interface unplugged) is not time-critical to notice, so widen this; the
// resume path below keeps its own short window.
static constexpr int64_t kCallbackStarvationMs       = 1500;
// A resume event is strong evidence the device is already gone, so react faster
// — but still long enough that a poll landing between two healthy buffers does
// not trigger a pointless reopen.
static constexpr int64_t kCallbackStarvationResumeMs = 150;
static constexpr int64_t kRecoveryRetryMs            = 2000;
// After this many consecutive failures the device is presumed genuinely absent
// (interface unplugged and not coming back); back off so we stop churning.
static constexpr int     kRecoveryBackoffAfter       = 5;
static constexpr int64_t kRecoveryBackoffMs          = 10000;

static int64_t steadyNowMs()
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch()).count();
}

static constexpr int    kTargetBuf  = 256;
static constexpr int    kMaxBuf     = 512;
static constexpr double kTargetRate = 44100.0;
static constexpr double kFallback   = 48000.0;

// ─────────────────────────────────────────────────────────────────────────────
AudioEngine::AudioEngine()
    : audioScheduler_(transport_, *this)
{
    formatManager_.registerBasicFormats();
}

AudioEngine::~AudioEngine() { shutdown(); }

// ─────────────────────────────────────────────────────────────────────────────
bool AudioEngine::initialize(bool recordToFile)
{
    if (initialized_) return true;

    auto& dm = deviceManager_;
    juce::String error;

    // Probe order when nothing is pinned. A saved output device (set through
    // setOutputDevice / setPreferredOutputDevice) restricts the probe to the
    // driver(s) that actually host that device.
    const char* driverOrder[] = { "ASIO", "Windows Audio", "Windows Audio (Exclusive Mode)" };

    bool opened = false;

    for (const auto* driverName : driverOrder)
    {
        juce::AudioIODeviceType* type = nullptr;
        for (auto* candidate : dm.getAvailableDeviceTypes())
            if (candidate->getTypeName() == juce::String(driverName)) { type = candidate; break; }

        // Say WHY a driver was skipped — "Driver: Default" used to hide that an
        // ASIO-capable interface was being opened through shared WASAPI.
        if (type == nullptr)
        {
            std::cout << "[AudioEngine] Driver '" << driverName
                      << "' unavailable: device type not present in this build.\n";
            continue;
        }

        type->scanForDevices();
        const auto outputNames = type->getDeviceNames(false);
        if (outputNames.isEmpty())
        {
            std::cout << "[AudioEngine] Driver '" << driverName << "' has no output devices.\n";
            continue;
        }

        juce::String outputName;
        if (!preferredOutputDevice_.empty())
        {
            if (!outputNames.contains(juce::String(preferredOutputDevice_)))
                continue;   // the preferred device belongs to another driver
            outputName = juce::String(preferredOutputDevice_);
        }
        else
        {
            // The type's own default endpoint — NOT index 0, which is merely
            // the first one enumerated.
            const int defaultIndex = type->getDefaultDeviceIndex(false);
            outputName = outputNames[juce::isPositiveAndBelow(defaultIndex, outputNames.size())
                                         ? defaultIndex : 0];
        }

        dm.setCurrentAudioDeviceType(driverName, true);

        juce::AudioDeviceManager::AudioDeviceSetup setup;
        dm.getAudioDeviceSetup(setup);
        setup.outputDeviceName         = outputName;
        setup.inputDeviceName          = {};     // output only; no capture endpoint is opened
        setup.useDefaultInputChannels  = true;
        setup.useDefaultOutputChannels = true;

        struct Attempt { double rate; int buffer; };
        std::vector<Attempt> attempts;
        // WASAPI shared has always been opened at the device's own rate and
        // engine period (rate/buffer 0 = "device default"); keep that first so
        // the honest-driver change doesn't also move the shared-mode operating
        // point. Every other driver gets the engine's target, then the ladder.
        if (isWasapiSharedDriver(driverName))
            attempts.push_back({ 0.0, 0 });
        attempts.push_back({ kTargetRate, kTargetBuf });
        attempts.push_back({ kTargetRate, kMaxBuf });
        attempts.push_back({ kFallback,   kTargetBuf });
        attempts.push_back({ kFallback,   kMaxBuf });

        for (const auto& attempt : attempts)
        {
            setup.sampleRate = attempt.rate;
            setup.bufferSize = attempt.buffer;
            error = dm.setAudioDeviceSetup(setup, true);
            if (error.isEmpty() && dm.getCurrentAudioDevice() != nullptr) break;
        }

        if (error.isEmpty() && dm.getCurrentAudioDevice() != nullptr) { opened = true; break; }

        std::cerr << "[AudioEngine] Driver '" << driverName << "' / device '"
                  << outputName.toStdString() << "' failed to open: "
                  << error.toStdString() << "\n";
    }

    if (!opened && dm.getCurrentAudioDevice() == nullptr)
    {
        // Last resort — let JUCE pick whatever it considers the default, so a
        // machine the probe above cannot open still gets sound if JUCE can.
        std::cerr << "[AudioEngine] Driver probe opened nothing — falling back to JUCE default device.\n";
        error = dm.initialiseWithDefaultDevices(0, 2);
    }

    auto* device = dm.getCurrentAudioDevice();
    if (device == nullptr)
    {
        std::cerr << "[AudioEngine] No audio device could be opened.\n";
        return false;
    }

    sampleRate_ = device->getCurrentSampleRate();
    bufferSize_ = device->getCurrentBufferSizeSamples();
    cacheCurrentDeviceOutputLatency();
    refreshLivePresentationLatency();

    // ── Optional WAV capture ──────────────────────────────────────────────────
    if (recordToFile)
    {
        recordingFile_ = juce::File::getCurrentWorkingDirectory().getChildFile("xleth_test_output.wav");
        recordingFile_.deleteFile();

        auto outStream = std::unique_ptr<juce::FileOutputStream>(recordingFile_.createOutputStream());
        if (outStream != nullptr)
        {
            juce::WavAudioFormat wavFmt;
            auto* writer = wavFmt.createWriterFor(outStream.get(), sampleRate_, 2, 16, {}, 0);
            if (writer != nullptr)
            {
                outStream.release();
                writerThread_.startThread(juce::Thread::Priority::low);
                wavWriter_.reset(new juce::AudioFormatWriter::ThreadedWriter(writer, writerThread_, 32768));
                std::cout << "[AudioEngine] Recording to: "
                          << recordingFile_.getFullPathName().toStdString() << "\n" << std::flush;
            }
        }
    }

    dm.addAudioCallback(this);
    initialized_ = true;

    // Logged AFTER the callback is attached: audioDeviceAboutToStart is what
    // publishes the real deadline. The driver name is whatever the open device
    // says it is, not a label we set.
    std::cout << "[AudioEngine] Driver      : " << device->getTypeName().toStdString() << "\n"
              << "[AudioEngine] Device      : " << device->getName().toStdString() << "\n"
              << "[AudioEngine] Sample rate : " << sampleRate_ << " Hz\n"
              << "[AudioEngine] Buffer size : " << bufferSize_ << " samples\n"
              << "[AudioEngine] Latency     : " << getLatencyMs() << " ms (driver-reported, single-counted)\n"
              << "[AudioEngine] Period      : " << getDevicePeriodMs() << " ms\n"
              << "[AudioEngine] Deadline    : " << getRealtimeDeadlineMs() << " ms ("
              << (getRealtimeDeadlineSource() == DeadlineSource::DevicePeriod
                      ? "WASAPI shared engine period" : "buffer duration") << ")\n"
              << std::flush;

    watchdogLastCounter_    = callbackCounter_.load(std::memory_order_relaxed);
    watchdogLastProgressMs_ = steadyNowMs();
    registerPowerNotification();

    return true;
}

#if JUCE_WINDOWS
// Runs on an OS-owned thread: raise a flag and nothing else. Touching the device
// manager from here would race the message thread.
static ULONG CALLBACK xlethOnPowerEvent(PVOID context, ULONG type, PVOID)
{
    if ((type == kPbtApmResumeAutomatic || type == kPbtApmResumeSuspend)
        && context != nullptr)
    {
        static_cast<AudioEngine*>(context)->notifySystemResume();
    }
    return 0; // ERROR_SUCCESS
}
#endif

// ─────────────────────────────────────────────────────────────────────────────
void AudioEngine::registerPowerNotification()
{
#if JUCE_WINDOWS
    if (powerNotifyHandle_ != nullptr) return;

    loadPowrprof();
    if (g_powerRegister == nullptr) return;

    XlethPowerNotifySubscribe params {};
    params.callback = &xlethOnPowerEvent;
    params.context  = this;

    HANDLE handle = nullptr;
    if (g_powerRegister(kDeviceNotifyCallback, &params, &handle) == 0 && handle != nullptr)
    {
        powerNotifyHandle_ = handle;
    }
    else
    {
        // Non-fatal: the watchdog still recovers, just after the full
        // starvation window instead of the shortened post-resume one.
        std::cerr << "[AudioEngine] Suspend/resume notification unavailable — "
                     "falling back to watchdog-only recovery.\n" << std::flush;
    }
#endif
}

// ─────────────────────────────────────────────────────────────────────────────
void AudioEngine::unregisterPowerNotification()
{
#if JUCE_WINDOWS
    if (powerNotifyHandle_ != nullptr && g_powerUnregister != nullptr)
        g_powerUnregister(static_cast<HANDLE>(powerNotifyHandle_));
#endif
    powerNotifyHandle_ = nullptr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure policy — no device access, no clock read. See AudioEngine.h.
bool AudioEngine::shouldAttemptRecovery(const WatchdogInputs& in)
{
    // A deliberate detach (export) is not a dead device.
    if (in.suspended)    return false;
    // The callback ran since the last poll — the driver is alive.
    if (in.counterMoved) return false;

    const int64_t threshold = in.resumeArmed ? kCallbackStarvationResumeMs
                                             : kCallbackStarvationMs;
    if (in.msSinceProgress < threshold) return false;

    // Backing off after repeated failures.
    if (in.msUntilNextAttempt > 0) return false;

    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure bookkeeping — no device access, no clock read. See AudioEngine.h.
AudioEngine::WatchdogRecoveryState
AudioEngine::afterRecoveryAttempt(bool    recovered,
                                  int     failedAttempts,
                                  int64_t lastProgressMs,
                                  int64_t completedAtMs)
{
    WatchdogRecoveryState out;

    if (recovered)
    {
        out.failedAttempts = 0;
        // Re-baseline so the next poll judges the *new* device from the moment
        // it actually came up, and hold the watchdog off for a full retry
        // interval: a freshly reopened driver is entitled to take longer than
        // the bare starvation window to produce its first block.
        out.lastProgressMs = completedAtMs;
        out.nextAttemptMs  = completedAtMs + kRecoveryRetryMs;
    }
    else
    {
        out.failedAttempts = failedAttempts + 1;
        // Nothing came up, so the progress age keeps running from whenever the
        // callback was last seen — only the retry deadline moves.
        out.lastProgressMs = lastProgressMs;
        out.nextAttemptMs  = completedAtMs
                           + (out.failedAttempts >= kRecoveryBackoffAfter
                                  ? kRecoveryBackoffMs
                                  : kRecoveryRetryMs);
    }

    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message/RPC thread only. See the contract in AudioEngine.h.
bool AudioEngine::checkDeviceHealth()
{
    if (!initialized_) return false;

    const int64_t now = steadyNowMs();

    if (resumeFromSleepPending_.exchange(false, std::memory_order_acq_rel))
        watchdogResumeArmed_ = true;

    // A deliberate detach (export) is not a dead device — re-baseline and wait.
    if (callbackSuspended_.load(std::memory_order_acquire))
    {
        watchdogLastCounter_    = callbackCounter_.load(std::memory_order_relaxed);
        watchdogLastProgressMs_ = now;
        watchdogResumeArmed_    = false;
        return false;
    }

    const uint64_t counter = callbackCounter_.load(std::memory_order_relaxed);
    if (counter != watchdogLastCounter_)
    {
        watchdogLastCounter_    = counter;
        watchdogLastProgressMs_ = now;
        watchdogResumeArmed_    = false;
        watchdogFailedAttempts_ = 0;
        return false;
    }

    const int64_t starvedMs = now - watchdogLastProgressMs_;

    WatchdogInputs inputs;
    inputs.suspended          = false;          // handled above
    inputs.counterMoved       = false;          // handled above
    inputs.resumeArmed        = watchdogResumeArmed_;
    inputs.msSinceProgress    = starvedMs;
    inputs.msUntilNextAttempt = watchdogNextAttemptMs_ - now;

    if (!shouldAttemptRecovery(inputs)) return false;

    // With no device present at all the retry loop runs indefinitely; log the
    // first few rounds in full, then only occasionally, so a machine with no
    // audio hardware does not bury the rest of the log.
    const bool verbose = watchdogFailedAttempts_ < 3
                      || watchdogFailedAttempts_ % 30 == 0;

    if (verbose)
        std::cerr << "[AudioEngine] Audio callback starved for " << starvedMs
                  << " ms" << (watchdogResumeArmed_ ? " (after system resume)" : "")
                  << " — reopening device.\n" << std::flush;

    watchdogResumeArmed_ = false;
    const bool recovered = reopenAudioDevice();

    // reopenAudioDevice() blocks for seconds on a real driver, so `now` is
    // stale by the time it returns — every deadline below is stamped from a
    // fresh read. See afterRecoveryAttempt()'s note in AudioEngine.h.
    const auto state = afterRecoveryAttempt(recovered,
                                            watchdogFailedAttempts_,
                                            watchdogLastProgressMs_,
                                            steadyNowMs());
    watchdogFailedAttempts_ = state.failedAttempts;
    watchdogNextAttemptMs_  = state.nextAttemptMs;
    watchdogLastProgressMs_ = state.lastProgressMs;

    if (recovered)
    {
        watchdogLastCounter_ = callbackCounter_.load(std::memory_order_relaxed);

        std::cout << "[AudioEngine] Device recovered: "
                  << getCurrentOutputDevice() << " @ " << sampleRate_ << " Hz / "
                  << bufferSize_ << " samples\n" << std::flush;
    }
    else if (verbose)
    {
        std::cerr << "[AudioEngine] Device reopen failed (attempt "
                  << watchdogFailedAttempts_ << ") — no audio device available.\n"
                  << std::flush;
    }

    return recovered;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message/RPC thread only.
bool AudioEngine::reopenAudioDevice()
{
    juce::AudioDeviceManager::AudioDeviceSetup setup;
    deviceManager_.getAudioDeviceSetup(setup);

    deviceManager_.removeAudioCallback(this);
    deviceManager_.closeAudioDevice();

    // The device list itself can change across suspend/resume, so a stale scan
    // would keep handing back the invalidated endpoint.
    if (auto* type = deviceManager_.getCurrentDeviceTypeObject())
        type->scanForDevices();

    juce::String error = deviceManager_.setAudioDeviceSetup(setup, true);

    if (error.isNotEmpty() || deviceManager_.getCurrentAudioDevice() == nullptr)
    {
        // The previous endpoint is gone for good (or came back renamed) — take
        // whatever the OS now calls the default rather than leaving it silent.
        error = deviceManager_.initialiseWithDefaultDevices(0, 2);
    }

    auto* device = deviceManager_.getCurrentAudioDevice();
    if (device == nullptr)
    {
        // Keep the callback attached: if the device returns later, JUCE starts
        // driving it again on its own and the watchdog sees the counter move.
        deviceManager_.addAudioCallback(this);
        return false;
    }

    // addAudioCallback re-runs audioDeviceAboutToStart, which republishes
    // sampleRate_/bufferSize_, retunes the transport and re-prepares MixEngine
    // against the (possibly different) reopened device.
    deviceManager_.addAudioCallback(this);
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
void AudioEngine::shutdown()
{
    if (!initialized_) return;

    unregisterPowerNotification();
    deviceManager_.removeAudioCallback(this);
    deviceManager_.closeAudioDevice();
    livePresentationDeviceOutputLatencySamples_.store(0, std::memory_order_release);
    refreshLivePresentationLatency();

    wavWriter_.reset();
    writerThread_.stopThread(2000);

    initialized_ = false;
}

// ─────────────────────────────────────────────────────────────────────────────
void AudioEngine::queueTrigger(int sampleId, float velocity)
{
    triggerQueue_.push({ sampleId, velocity });
}

// ─────────────────────────────────────────────────────────────────────────────
std::vector<std::string> AudioEngine::getOutputDevices() const
{
    std::vector<std::string> names;
    auto* type = deviceManager_.getCurrentDeviceTypeObject();
    if (!type) return names;
    for (const auto& n : type->getDeviceNames(false))
        names.push_back(n.toStdString());
    return names;
}

// ─────────────────────────────────────────────────────────────────────────────
std::string AudioEngine::getCurrentOutputDevice() const
{
    if (auto* dev = deviceManager_.getCurrentAudioDevice())
        return dev->getName().toStdString();
    return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// [XRun] Hardware x-run count from the active driver (-1 if unsupported).
int AudioEngine::getDeviceXRunCount() const
{
    if (auto* dev = deviceManager_.getCurrentAudioDevice())
        return dev->getXRunCount();
    return -1;
}

// [XRun] JUCE device-manager CPU load estimate, range [0,1].
double AudioEngine::getDeviceCpuUsage() const
{
    return deviceManager_.getCpuUsage();
}

// ─────────────────────────────────────────────────────────────────────────────
// A saved preference is a device NAME (persisted by the UI), and since the
// startup probe now opens the best driver rather than always shared WASAPI, the
// current driver need not be the one that hosts it. JUCE would answer "No such
// device" for a name outside the current driver's list — but only AFTER it has
// already torn the working device down, leaving the app silent. So resolve the
// hosting driver first and refuse without touching the device if there is none.
std::string AudioEngine::setOutputDevice(const std::string& deviceName)
{
    const juce::String wanted(deviceName);
    auto& dm = deviceManager_;

    juce::AudioIODeviceType* host = nullptr;
    if (auto* current = dm.getCurrentDeviceTypeObject())
        if (current->getDeviceNames(false).contains(wanted))
            host = current;

    if (host == nullptr)
    {
        const char* driverOrder[] = { "ASIO", "Windows Audio", "Windows Audio (Exclusive Mode)" };
        for (const auto* driverName : driverOrder)
        {
            for (auto* type : dm.getAvailableDeviceTypes())
                if (type->getTypeName() == juce::String(driverName)
                    && type->getDeviceNames(false).contains(wanted))
                    { host = type; break; }
            if (host != nullptr) break;
        }
    }
    if (host == nullptr)
    {
        for (auto* type : dm.getAvailableDeviceTypes())
            if (type->getDeviceNames(false).contains(wanted)) { host = type; break; }
    }

    if (host == nullptr)
        return ("No such device: " + wanted).toStdString();

    if (host != dm.getCurrentDeviceTypeObject())
    {
        std::cout << "[AudioEngine] Output device '" << deviceName << "' is hosted by driver '"
                  << host->getTypeName().toStdString() << "' — switching driver.\n" << std::flush;
        dm.setCurrentAudioDeviceType(host->getTypeName(), true);
    }

    juce::AudioDeviceManager::AudioDeviceSetup setup;
    dm.getAudioDeviceSetup(setup);
    setup.outputDeviceName         = wanted;
    setup.useDefaultOutputChannels = true;
    auto err = dm.setAudioDeviceSetup(setup, true);
    if (err.isEmpty())
    {
        preferredOutputDevice_ = deviceName;
        cacheCurrentDeviceOutputLatency();
        refreshLivePresentationLatency();
        logDeviceState("Output device changed");
    }
    return err.toStdString();
}

// ─────────────────────────────────────────────────────────────────────────────
std::vector<double> AudioEngine::getSupportedSampleRates() const
{
    std::vector<double> rates;
    if (auto* device = deviceManager_.getCurrentAudioDevice())
        for (double rate : device->getAvailableSampleRates())
            rates.push_back(rate);
    return rates;
}

// ─────────────────────────────────────────────────────────────────────────────
std::vector<int> AudioEngine::getAvailableBufferSizes() const
{
    std::vector<int> sizes;
    if (auto* device = deviceManager_.getCurrentAudioDevice())
        for (int size : device->getAvailableBufferSizes())
            sizes.push_back(size);
    return sizes;
}

int AudioEngine::getDefaultBufferSize() const
{
    if (auto* device = deviceManager_.getCurrentAudioDevice())
        return device->getDefaultBufferSize();
    return bufferSize_;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message/RPC thread only — drives juce::AudioDeviceManager, same contract as
// setOutputDevice()/reopenAudioDevice().
std::vector<std::string> AudioEngine::rescanDevices()
{
    auto& dm = deviceManager_;
    for (auto* type : dm.getAvailableDeviceTypes())
        type->scanForDevices();

    auto names = getOutputDevices();
    const std::string current = getCurrentOutputDevice();

    if (std::find(names.begin(), names.end(), current) == names.end())
    {
        // Selected device vanished (unplugged) — fall back to this driver's
        // default output, same reconfigure path setOutputDevice uses. An
        // empty outputDeviceName + useDefaultOutputChannels asks JUCE for
        // whatever the OS now calls the default for the current driver type.
        juce::AudioDeviceManager::AudioDeviceSetup setup;
        dm.getAudioDeviceSetup(setup);
        setup.outputDeviceName         = {};
        setup.useDefaultOutputChannels = true;
        auto err = dm.setAudioDeviceSetup(setup, true);
        if (err.isEmpty())
        {
            preferredOutputDevice_ = getCurrentOutputDevice();
            cacheCurrentDeviceOutputLatency();
            refreshLivePresentationLatency();
        }
        names = getOutputDevices();
    }

    return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// Same shape as setOutputDevice: mutate the setup, let setAudioDeviceSetup's
// restart (audioDeviceAboutToStart) do the actual reconfigure. No parallel
// path — deviceChanged is the only place sampleRate_/bufferSize_ are written.
std::string AudioEngine::setBufferSize(int bufferSize)
{
    juce::AudioDeviceManager::AudioDeviceSetup setup;
    deviceManager_.getAudioDeviceSetup(setup);
    setup.bufferSize = bufferSize;
    auto err = deviceManager_.setAudioDeviceSetup(setup, true);
    if (err.isEmpty())
    {
        cacheCurrentDeviceOutputLatency();
        refreshLivePresentationLatency();
        logDeviceState("Buffer size changed (requested " + std::to_string(bufferSize) + ")");
    }
    else
    {
        std::cerr << "[AudioEngine] Buffer size change to " << bufferSize
                  << " refused: " << err.toStdString() << "\n" << std::flush;
    }
    return err.toStdString();
}

std::string AudioEngine::setSampleRate(double sampleRate)
{
    juce::AudioDeviceManager::AudioDeviceSetup setup;
    deviceManager_.getAudioDeviceSetup(setup);
    setup.sampleRate = sampleRate;
    auto err = deviceManager_.setAudioDeviceSetup(setup, true);
    if (err.isEmpty())
    {
        cacheCurrentDeviceOutputLatency();
        refreshLivePresentationLatency();
        logDeviceState("Sample rate changed (requested " + std::to_string(sampleRate) + " Hz)");
    }
    return err.toStdString();
}

// Message/RPC thread only. One line carrying everything needed to tell what the
// device is really doing: the actual driver, device, rate and buffer (read back
// from the open device, so a value JUCE snapped is reported as snapped), the
// single-counted driver latency, and the period/deadline telemetry judges by.
void AudioEngine::logDeviceState(const std::string& what) const
{
    auto* device = deviceManager_.getCurrentAudioDevice();
    if (device == nullptr)
    {
        std::cout << "[AudioEngine] " << what << ": no device open\n" << std::flush;
        return;
    }

    std::cout << "[AudioEngine] " << what
              << ": driver=" << device->getTypeName().toStdString()
              << " device=\"" << device->getName().toStdString() << "\""
              << " rate=" << sampleRate_ << " Hz"
              << " buffer=" << bufferSize_ << " samples"
              << " latency=" << getLatencyMs() << " ms (single-counted)"
              << " period=" << getDevicePeriodMs() << " ms"
              << " deadline=" << getRealtimeDeadlineMs() << " ms ("
              << (getRealtimeDeadlineSource() == DeadlineSource::DevicePeriod
                      ? "device period" : "buffer") << ")\n"
              << std::flush;
}

int64_t AudioEngine::readCurrentDeviceOutputLatencySamples() const
{
    const int64_t overrideSamples =
        testDeviceOutputLatencyOverrideSamples_.load(std::memory_order_acquire);
    if (overrideSamples >= 0)
        return overrideSamples;

    auto* device = deviceManager_.getCurrentAudioDevice();
    if (device == nullptr)
        return 0;

    return std::max<int64_t>(0, device->getOutputLatencyInSamples());
}

void AudioEngine::cacheCurrentDeviceOutputLatency()
{
    livePresentationDeviceOutputLatencySamples_.store(
        readCurrentDeviceOutputLatencySamples(),
        std::memory_order_release);
}

// Stage 7B: presentation latency is computed live from MixEngine on every read
// (see getLivePresentationLatencySamples). The cached atomics below are mirrors
// kept in sync by this method so external observers that read the atomics
// directly (diagnostics, tests) see the most recent published snapshot. No live
// reader inside AudioEngine depends on the cache: even if this method is never
// called between mutations, getLivePresentationLatencySamples and
// getLivePresentationLatencyDiagnostics still return current values.
void AudioEngine::refreshLivePresentationLatency()
{
    // Prompt 5A: keep stock-compressor sidechain buses in sync with the routes
    // before reading latency — this is the universal main-thread hook called
    // after every routing/chain mutation and after project load. Idempotent and
    // cheap when nothing changed; may re-prepare a chain when a route's target
    // set changes (which can shift latency, so it must precede the snapshot).
    mixEngine_.syncSidechainTargetBuses();

    const auto snapshot = mixEngine_.getLatencyCompensationSnapshot();
    const int64_t maxTrackLatency = std::max<int64_t>(
        0,
        static_cast<int64_t>(snapshot.maxAudibleTrackLatencySamples));
    const int64_t masterLatency = std::max<int64_t>(
        0,
        static_cast<int64_t>(snapshot.masterInsertLatencySamples));
    const int64_t deviceOutputLatency =
        livePresentationDeviceOutputLatencySamples_.load(std::memory_order_acquire);
    const int64_t totalLatency = maxTrackLatency
                               + masterLatency
                               + std::max<int64_t>(0, deviceOutputLatency);

    livePresentationMaxTrackLatencySamples_.store(maxTrackLatency,
                                                  std::memory_order_release);
    livePresentationMasterLatencySamples_.store(masterLatency,
                                                std::memory_order_release);
    livePresentationTotalLatencySamples_.store(totalLatency,
                                               std::memory_order_release);
}

void AudioEngine::playTimeline()
{
    refreshLivePresentationLatency();
    transport_.play();
}

void AudioEngine::seekTimelineToSample(int64_t sample)
{
    sample = std::max<int64_t>(0, sample);
    transport_.seekToSample(sample);
    refreshLivePresentationLatency();
}

void AudioEngine::seekTimelineToBeat(double beat)
{
    const double bpm = transport_.getBPM();
    const int sampleRate = static_cast<int>(std::llround(transport_.getSampleRate()));
    const int64_t sample = RenderClock::beatToSample(beat, sampleRate, bpm);
    seekTimelineToSample(sample);
}

// Stage 7B: read live from MixEngine + cached device output latency. MixEngine
// owns the authoritative track / master insert latency state and updates it
// synchronously under chainsMutex_ on every mutation path (insert/remove/move/
// bypass/parameter/program/state-restore/guarded-wrapper-refresh). Reading on
// demand removes the staleness window where the AudioEngine cache lagged behind
// the chain after a non-transport mutation. The mutex is uncontended on the
// read side: the audio render thread does not take chainsMutex_, only non-RT
// chain mutators do.
int64_t AudioEngine::getLivePresentationLatencySamples() const
{
    const auto snapshot = mixEngine_.getLatencyCompensationSnapshot();
    const int64_t maxTrackLatency = std::max<int64_t>(
        0,
        static_cast<int64_t>(snapshot.maxAudibleTrackLatencySamples));
    const int64_t masterLatency = std::max<int64_t>(
        0,
        static_cast<int64_t>(snapshot.masterInsertLatencySamples));
    const int64_t deviceOutputLatency = std::max<int64_t>(
        0,
        livePresentationDeviceOutputLatencySamples_.load(std::memory_order_acquire));
    return maxTrackLatency + masterLatency + deviceOutputLatency;
}

int64_t AudioEngine::getLivePresentationPositionSamples() const
{
    const int64_t rawPosition = transport_.getPositionSamples();
    const int64_t latency = getLivePresentationLatencySamples();
    return std::max<int64_t>(0, rawPosition - latency);
}

double AudioEngine::getLivePresentationPositionSeconds() const
{
    const double sampleRate = transport_.getSampleRate();
    return sampleRate > 0.0
        ? static_cast<double>(getLivePresentationPositionSamples()) / sampleRate
        : 0.0;
}

// Stage 7B: same live-on-read story as getLivePresentationLatencySamples — all
// four fields are recomputed from the authoritative MixEngine snapshot plus the
// cached device output latency, so callers never see a stale max-track / master
// / total triple after a mutation that did not pass through a transport
// lifecycle event.
AudioEngine::LivePresentationLatencyDiagnostics
AudioEngine::getLivePresentationLatencyDiagnostics() const
{
    const auto snapshot = mixEngine_.getLatencyCompensationSnapshot();
    LivePresentationLatencyDiagnostics diagnostics;
    diagnostics.maxTrackLatencySamples = std::max<int64_t>(
        0,
        static_cast<int64_t>(snapshot.maxAudibleTrackLatencySamples));
    diagnostics.masterLatencySamples = std::max<int64_t>(
        0,
        static_cast<int64_t>(snapshot.masterInsertLatencySamples));
    diagnostics.deviceOutputLatencySamples = std::max<int64_t>(
        0,
        livePresentationDeviceOutputLatencySamples_.load(std::memory_order_acquire));
    diagnostics.totalPresentationLatencySamples =
        diagnostics.maxTrackLatencySamples
        + diagnostics.masterLatencySamples
        + diagnostics.deviceOutputLatencySamples;
    return diagnostics;
}

void AudioEngine::setTestDeviceOutputLatencySamplesForDiagnostics(int64_t samples)
{
    testDeviceOutputLatencyOverrideSamples_.store(samples >= 0 ? samples : -1,
                                                  std::memory_order_release);
    cacheCurrentDeviceOutputLatency();
    refreshLivePresentationLatency();
}

// ─────────────────────────────────────────────────────────────────────────────
std::string AudioEngine::getCurrentDriverName() const
{
    if (auto* device = deviceManager_.getCurrentAudioDevice())
        return device->getTypeName().toStdString();
    return {};
}

// Single-counted. getOutputLatencyInSamples() already contains the buffer: JUCE
// WASAPI sets latencyOut = GetStreamLatency + currentBufferSizeSamples
// (juce_WASAPI_windows.cpp, WASAPIAudioIODevice::open), and ASIO's getLatencies()
// includes the buffer by spec. Adding bufferSize_ on top — as this used to —
// reported exactly 2 x buffer / rate whenever the driver's own term was 0
// (WASAPI shared reports GetStreamLatency == 0 on many endpoints).
double AudioEngine::getLatencyMs() const
{
    auto* device = deviceManager_.getCurrentAudioDevice();
    if (device == nullptr || sampleRate_ <= 0.0) return 0.0;
    const int latSamples = std::max(0, device->getOutputLatencyInSamples());
    return (latSamples / sampleRate_) * 1000.0;
}

bool AudioEngine::isWasapiSharedDriver(const std::string& driverName)
{
    return driverName == "Windows Audio";
}

AudioEngine::RealtimeDeadline
AudioEngine::chooseRealtimeDeadline(const std::string& driverName,
                                    int bufferSizeSamples,
                                    int devicePeriodSamples)
{
    RealtimeDeadline out;
    if (isWasapiSharedDriver(driverName) && devicePeriodSamples > 0)
    {
        out.source  = DeadlineSource::DevicePeriod;
        out.samples = devicePeriodSamples;
    }
    else
    {
        out.source  = DeadlineSource::BufferSize;
        out.samples = std::max(0, bufferSizeSamples);
    }
    return out;
}

// WASAPI shared: JUCE's getDefaultBufferSize() is GetDevicePeriod's default
// period — the engine period — expressed in samples at the endpoint's mix-format
// rate. WASAPI shared normally runs the session AT the mix rate (JUCE only
// offers the rates the endpoint accepts), so dividing by the session rate is
// exact there; it is an approximation only if the session was snapped to some
// other supported rate. Everything else runs one buffer per period.
double AudioEngine::getDevicePeriodMs() const
{
    auto* device = deviceManager_.getCurrentAudioDevice();
    if (device == nullptr || sampleRate_ <= 0.0) return 0.0;

    const int periodSamples = isWasapiSharedDriver(device->getTypeName().toStdString())
        ? device->getDefaultBufferSize()
        : bufferSize_;
    return (std::max(0, periodSamples) / sampleRate_) * 1000.0;
}

double AudioEngine::getRealtimeDeadlineMs() const
{
    return static_cast<double>(realtimeDeadlineNs_.load(std::memory_order_relaxed)) / 1.0e6;
}

// ─────────────────────────────────────────────────────────────────────────────
void AudioEngine::audioDeviceAboutToStart(juce::AudioIODevice* device)
{
    sampleRate_ = device->getCurrentSampleRate();
    bufferSize_ = device->getCurrentBufferSizeSamples();
    transport_.setSampleRate(sampleRate_);
    mixEngine_.prepare(sampleRate_, bufferSize_);
    metronome_.prepare(sampleRate_);
    cacheCurrentDeviceOutputLatency();
    refreshLivePresentationLatency();

    // Which quantity is the real callback deadline for THIS device. Published
    // to the audio thread through MixEngine only when it differs from the
    // block-derived default (i.e. WASAPI shared); everywhere else 0 keeps the
    // existing numSamples / sampleRate accounting untouched.
    const auto deadline = chooseRealtimeDeadline(device->getTypeName().toStdString(),
                                                 bufferSize_,
                                                 device->getDefaultBufferSize());
    const int64_t deadlineNs = sampleRate_ > 0.0
        ? static_cast<int64_t>(std::llround((deadline.samples / sampleRate_) * 1.0e9))
        : 0;
    realtimeDeadlineNs_.store(deadlineNs, std::memory_order_relaxed);
    realtimeDeadlineFromPeriod_.store(deadline.source == DeadlineSource::DevicePeriod,
                                      std::memory_order_relaxed);
    mixEngine_.setRealtimeDeadlineOverrideNs(
        deadline.source == DeadlineSource::DevicePeriod ? static_cast<uint64_t>(deadlineNs) : 0u);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO THREAD — no alloc, no logging, no locks, no I/O
void AudioEngine::audioDeviceIOCallbackWithContext(
    const float* const* /*inputChannelData*/,
    int                 /*numInputChannels*/,
    float* const*       outputChannelData,
    int                 numOutputChannels,
    int                 numSamples,
    const juce::AudioIODeviceCallbackContext& /*context*/)
{
    // a) Wrap raw pointers — no allocation, just a view
    const bool rtDiagEnabled = mixEngine_.isRealtimeDiagnosticsEnabled();
    const auto rtDiagStart = rtDiagEnabled ? std::chrono::steady_clock::now()
                                           : std::chrono::steady_clock::time_point {};

    juce::AudioBuffer<float> outBuf(outputChannelData, numOutputChannels, numSamples);

    // b) Clear output
    outBuf.clear();

    // c) Manual triggers → voice manager (keyboard / UI triggers)
    if (sampleBank_ != nullptr)
    {
        // Drain trigger queue (keyboard triggers) → voice manager
        TriggerEvent ev;
        while (triggerQueue_.pop(ev))
            voiceManager_.triggerSample(ev.sampleId, ev.velocity);

        // d) Mix manual voice triggers into output
        voiceManager_.processBlock(outBuf, *sampleBank_);
    }

    // e) Timeline-driven multi-track mix (Phase 1 MixEngine), rendered in
    //    sub-blocks split at the loop seam.
    //
    //    Rendering the whole device buffer and only then wrapping the clock is
    //    wrong: loopAdvance carries the overshoot across the seam, so playback
    //    resumes at (loopStart + overshoot) and the samples in
    //    [loopStart, loopStart + overshoot) are rendered by no buffer at all.
    //    Any note landing in that gap is silently dropped on every lap — most
    //    visibly a pattern note sitting exactly ON the loop start tick, which
    //    never sounds. The mirror symptom is the up-to-one-buffer tail past
    //    loopEnd that DID get rendered before the jump.
    //
    //    Splitting renders [pos, loopEnd), advances (which wraps to exactly
    //    loopStart), then renders the remainder from loopStart: the region is
    //    covered contiguously, and nothing past loopEnd is heard.
    {
        // A region shorter than one device buffer would split once per lap
        // inside a single callback. Cap the chain so the audio thread can never
        // be handed an unbounded number of sub-blocks; past the cap the last
        // sub-block falls back to the plain (overshoot-carrying) advance.
        constexpr int kMaxLoopSplits = 8;

        int offset    = 0;
        int remaining = numSamples;

        for (int split = 0; remaining > 0; ++split)
        {
            int chunk = remaining;
            if (split < kMaxLoopSplits)
            {
                chunk = transport_.samplesUntilLoopWrap(remaining);
                if (chunk < 1)         chunk = 1;
                if (chunk > remaining) chunk = remaining;
            }

            if (offset == 0 && chunk == numSamples)
            {
                mixEngine_.processBlock(outBuf, chunk, transport_);
            }
            else
            {
                // Pointer view over [offset, offset + chunk). AudioBuffer stores
                // the offset channel pointers in its preallocated space for
                // <= 32 channels, so this constructor does not allocate.
                juce::AudioBuffer<float> seamView(outBuf.getArrayOfWritePointers(),
                                                  numOutputChannels, offset, chunk);
                mixEngine_.processBlock(seamView, chunk, transport_);
            }

            // Metronome: post-mix, outside the master bus. The grid is read at
            // (position - PDC) so each click lands with the audio it counts
            // against, which the mix delays by the track + master insert latency
            // (device latency is common to both and is deliberately not applied).
            // Runs on this sub-block's own position, so loop wraps stay in step.
            if (metronome_.isEnabled() || metronome_.activeVoices() > 0)
            {
                const int64_t pdc =
                    livePresentationMaxTrackLatencySamples_.load(std::memory_order_relaxed)
                  + livePresentationMasterLatencySamples_.load(std::memory_order_relaxed);
                juce::AudioBuffer<float> metroView(outBuf.getArrayOfWritePointers(),
                                                   numOutputChannels, offset, chunk);
                metronome_.process(metroView.getArrayOfWritePointers(), numOutputChannels, chunk,
                                   transport_.getPositionSamples() - pdc,
                                   transport_.getBPM(), transport_.isPlaying());
            }

            // The master clock advances per sub-block because the advance IS
            // the wrap — see the removed trailing advance() below.
            transport_.advance(chunk);

            offset    += chunk;
            remaining -= chunk;
        }
    }

    // f) Source preview (Sample Picker)
    sourcePlayer_.processBlock(outBuf, numSamples);

    // Optional WAV capture (ThreadedWriter is lock-free)
    if (wavWriter_ != nullptr)
        wavWriter_->write(outputChannelData, numSamples);

    // [StartLatencyTrace] TEMP/DIAGNOSTIC — (b) first audio block produced.
    // Guarded by isPlaying() so silent blocks during the pre-play rebuild
    // barrier are NOT counted. Lock-free single atomic store, RT-safe; the
    // logging happens off-thread (preview loop flush). Remove with
    // util/StartLatencyTrace.h.
    if (transport_.isPlaying())
        xleth::diag::StartLatencyTrace::instance().markFirstAudio();

    // Master clock already advanced, per sub-block, inside (e) — the loop wrap
    // has to happen mid-buffer at the seam, so it cannot be deferred to here.
    // Nothing between (e) and this point reads the transport position:
    // SourcePlayer is position-independent, the WAV writer takes raw samples,
    // and StartLatencyTrace only reads isPlaying().

    // Device-health heartbeat. Relaxed is sufficient: the watchdog only needs to
    // observe that the value changed, never a happens-before on anything else.
    callbackCounter_.fetch_add(1, std::memory_order_relaxed);

    if (rtDiagEnabled)
    {
        const auto elapsed =
            std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::steady_clock::now() - rtDiagStart).count();
        mixEngine_.recordAudioCallbackTiming(
            numSamples,
            sampleRate_,
            static_cast<uint64_t>(std::max<int64_t>(0, elapsed)));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
void AudioEngine::audioDeviceStopped()
{
    livePresentationDeviceOutputLatencySamples_.store(0, std::memory_order_release);
    refreshLivePresentationLatency();
}

// ─────────────────────────────────────────────────────────────────────────────
bool AudioEngine::analyzeRecording(const juce::File& wavFile) const
{
    if (!wavFile.existsAsFile())
    {
        std::cerr << "[Analyze] WAV file not found: " << wavFile.getFullPathName().toStdString() << "\n";
        return false;
    }

    juce::AudioFormatManager afm;
    afm.registerBasicFormats();

    std::unique_ptr<juce::AudioFormatReader> rdr(afm.createReaderFor(wavFile));
    if (rdr == nullptr) { std::cerr << "[Analyze] Could not open WAV file.\n"; return false; }

    const int    total           = static_cast<int>(rdr->lengthInSamples);
    const double sr              = rdr->sampleRate;
    const int    blockSize       = 512;
    const float  silenceThresh   = 0.01f;
    const int    dropoutMinSmp   = static_cast<int>(sr * 0.002);

    std::cout << "\n[Analyze] File     : " << wavFile.getFileName().toStdString() << "\n"
              << "[Analyze] Duration : " << (total / sr) << " s  |  "
              << total << " samples  @  " << sr << " Hz\n";

    juce::AudioBuffer<float> buf(2, blockSize);
    int   dropouts = 0, silenceRun = 0, pos = 0;
    bool  inDropout = false;
    float peak = 0.0f;

    while (pos < total)
    {
        const int n = std::min(blockSize, total - pos);
        buf.clear();
        rdr->read(&buf, 0, n, pos, true, true);
        for (int s = 0; s < n; ++s)
        {
            const float v = std::abs(buf.getSample(0, s));
            if (v > peak) peak = v;
            if (v < silenceThresh) { ++silenceRun; if (!inDropout && silenceRun >= dropoutMinSmp) { inDropout = true; ++dropouts; } }
            else                   { silenceRun = 0; inDropout = false; }
        }
        pos += n;
    }

    std::cout << "[Analyze] Peak     : " << peak << "  |  Dropouts: " << dropouts << "\n";
    const bool pass = (dropouts == 0 && peak > 0.25f && peak < 0.35f);
    std::cout << "[Analyze] " << (pass ? "PASS" : "FAIL") << "\n";
    return pass;
}
