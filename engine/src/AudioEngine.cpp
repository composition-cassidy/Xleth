#include "AudioEngine.h"

#include <algorithm>
#include <cmath>
#include <iostream>

// JUCE module headers define JUCE_WINDOWS but don't include windows.h themselves.
#if JUCE_WINDOWS
  #ifndef NOMINMAX
    #define NOMINMAX
  #endif
  #include <windows.h>
#endif

// ── MMCSS via runtime DLL load ────────────────────────────────────────────────
#if JUCE_WINDOWS
namespace {
    using AvSetFn    = HANDLE (WINAPI*)(LPCSTR, LPDWORD);
    using AvRevertFn = BOOL   (WINAPI*)(HANDLE);

    AvSetFn    g_avSet    = nullptr;
    AvRevertFn g_avRevert = nullptr;

    void loadAvrt()
    {
        if (g_avSet != nullptr) return;
        HMODULE lib = LoadLibraryA("avrt.dll");
        if (lib)
        {
            g_avSet    = reinterpret_cast<AvSetFn>   (GetProcAddress(lib, "AvSetMmThreadCharacteristicsA"));
            g_avRevert = reinterpret_cast<AvRevertFn>(GetProcAddress(lib, "AvRevertMmThreadCharacteristics"));
        }
    }
} // namespace
#endif

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

#if JUCE_WINDOWS
    loadAvrt();
#endif

    auto& dm = deviceManager_;
    juce::String error;
    juce::String selectedDriver;

    const char* driverOrder[] = { "ASIO", "Windows Audio", "Windows Audio (Exclusive Mode)" };

    bool opened = false;

    if (preferredOutputDevice_.empty())
    {
        // No user preference — open the Windows Default Device via WASAPI directly.
        error = dm.initialiseWithDefaultDevices(0, 2);
        if (error.isEmpty()) { selectedDriver = "Default"; opened = true; }
    }

    if (!opened)
    {
        // Explicit preferred device (or default init failed) — enumerate drivers.
        for (const auto* driverName : driverOrder)
        {
            for (auto* type : dm.getAvailableDeviceTypes())
            {
                if (type->getTypeName() != juce::String(driverName)) continue;
                type->scanForDevices();
                if (type->getDeviceNames(false).isEmpty()) break;

                dm.setCurrentAudioDeviceType(driverName, true);

                juce::AudioDeviceManager::AudioDeviceSetup setup;
                dm.getAudioDeviceSetup(setup);
                if (!preferredOutputDevice_.empty())
                    setup.outputDeviceName = juce::String(preferredOutputDevice_);
                else
                    setup.outputDeviceName = type->getDeviceNames(false)[0];
                setup.sampleRate               = kTargetRate;
                setup.bufferSize               = kTargetBuf;
                setup.useDefaultInputChannels  = true;
                setup.useDefaultOutputChannels = true;

                error = dm.setAudioDeviceSetup(setup, true);
                if (error.isNotEmpty()) { setup.bufferSize = kMaxBuf;   error = dm.setAudioDeviceSetup(setup, true); }
                if (error.isNotEmpty()) { setup.sampleRate = kFallback; setup.bufferSize = kTargetBuf; error = dm.setAudioDeviceSetup(setup, true); }
                if (error.isNotEmpty()) { setup.bufferSize = kMaxBuf;   error = dm.setAudioDeviceSetup(setup, true); }

                if (error.isEmpty()) { selectedDriver = driverName; opened = true; }
                break;
            }
            if (opened) break;
        }
    }

    auto* device = dm.getCurrentAudioDevice();
    if (device == nullptr)
    {
        std::cerr << "[AudioEngine] No audio device could be opened.\n";
        return false;
    }

    sampleRate_ = device->getCurrentSampleRate();
    bufferSize_ = device->getCurrentBufferSizeSamples();

    std::cout << "[AudioEngine] Driver      : " << selectedDriver.toStdString() << "\n"
              << "[AudioEngine] Device      : " << device->getName().toStdString() << "\n"
              << "[AudioEngine] Sample rate : " << sampleRate_ << " Hz\n"
              << "[AudioEngine] Buffer size : " << bufferSize_ << " samples\n"
              << "[AudioEngine] Latency     : " << getLatencyMs() << " ms\n"
              << std::flush;

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
    return true;
}

// ─────────────────────────────────────────────────────────────────────────────
void AudioEngine::shutdown()
{
    if (!initialized_) return;

    deviceManager_.removeAudioCallback(this);
    deviceManager_.closeAudioDevice();

    wavWriter_.reset();
    writerThread_.stopThread(2000);

#if JUCE_WINDOWS
    if (mmcssHandle_ != nullptr && g_avRevert != nullptr)
    {
        g_avRevert(static_cast<HANDLE>(mmcssHandle_));
        mmcssHandle_ = nullptr;
    }
#endif

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
std::string AudioEngine::setOutputDevice(const std::string& deviceName)
{
    juce::AudioDeviceManager::AudioDeviceSetup setup;
    deviceManager_.getAudioDeviceSetup(setup);
    setup.outputDeviceName         = juce::String(deviceName);
    setup.useDefaultOutputChannels = true;
    auto err = deviceManager_.setAudioDeviceSetup(setup, true);
    if (err.isEmpty()) preferredOutputDevice_ = deviceName;
    return err.toStdString();
}

// ─────────────────────────────────────────────────────────────────────────────
double AudioEngine::getLatencyMs() const
{
    auto* device = deviceManager_.getCurrentAudioDevice();
    if (device == nullptr) return 0.0;
    int latSamples = device->getOutputLatencyInSamples() + bufferSize_;
    return (latSamples / sampleRate_) * 1000.0;
}

// ─────────────────────────────────────────────────────────────────────────────
void AudioEngine::audioDeviceAboutToStart(juce::AudioIODevice* device)
{
    sampleRate_ = device->getCurrentSampleRate();
    bufferSize_ = device->getCurrentBufferSizeSamples();
    transport_.setSampleRate(sampleRate_);
    mixEngine_.prepare(sampleRate_, bufferSize_);

#if JUCE_WINDOWS
    if (g_avSet != nullptr)
    {
        DWORD  taskIndex = 0;
        HANDLE hTask     = g_avSet("Pro Audio", &taskIndex);
        if (hTask != nullptr)
        {
            mmcssHandle_ = hTask;
            std::cout << "[AudioEngine] MMCSS 'Pro Audio' priority boost applied.\n" << std::flush;
        }
        else
        {
            std::cerr << "[AudioEngine] MMCSS boost failed — continuing without it.\n" << std::flush;
        }
    }
#endif
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

    // e) Timeline-driven multi-track mix (Phase 1 MixEngine)
    mixEngine_.processBlock(outBuf, numSamples, transport_);

    // f) Source preview (Sample Picker)
    sourcePlayer_.processBlock(outBuf, numSamples);

    // Optional WAV capture (ThreadedWriter is lock-free)
    if (wavWriter_ != nullptr)
        wavWriter_->write(outputChannelData, numSamples);

    // Advance master clock — always last, after all processing
    transport_.advance(numSamples);
}

// ─────────────────────────────────────────────────────────────────────────────
void AudioEngine::audioDeviceStopped() {}

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

