#include "audio/GuardedPluginWrapper.h"
#include "audio/EditorProcessCoordinator.h"  // CPLOG / g_closeProfile_t0
#include "audio/PluginCrashGuard.h"
#include "audio/NamedAudioRing.h"

#include <chrono>
#include <cstdio>
#include <thread>

// ─── Construction / destruction ─────────────────────────────────────────────

GuardedPluginWrapper::GuardedPluginWrapper(std::unique_ptr<juce::AudioProcessor> inner)
    : juce::AudioProcessor(BusesProperties()
          .withInput ("Input",  juce::AudioChannelSet::stereo(), true)
          .withOutput("Output", juce::AudioChannelSet::stereo(), true))
    , inner_(std::move(inner))
{
    if (inner_)
    {
        // Force stereo I/O to match the rest of the graph.  VST3 plugins that
        // default to a non-stereo layout get reconfigured here before any
        // prepareToPlay call.
        inner_->setPlayConfigDetails(2, 2,
                                     getSampleRate() > 0 ? getSampleRate() : 44100.0,
                                     getBlockSize()  > 0 ? getBlockSize()  : 512);
        cachedName_ = inner_->getName();
        setLatencySamples(inner_->getLatencySamples());
    }
}

GuardedPluginWrapper::~GuardedPluginWrapper() = default;

// ─── Lifecycle (guarded — plugins can fault in prepareToPlay) ───────────────

void GuardedPluginWrapper::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    if (!inner_) return;

    auto* innerPtr = inner_.get();
    const bool ok = xleth::pluginGuardCall([&]
    {
        innerPtr->setPlayConfigDetails(2, 2, sampleRate, samplesPerBlock);
        innerPtr->prepareToPlay(sampleRate, samplesPerBlock);
    });

    if (!ok)
    {
        crashed_.store(true, std::memory_order_release);
#ifdef XLETH_DEBUG
        std::fprintf(stderr,
                     "[PluginHost] CRASH: \"%s\" in prepareToPlay — auto-bypassed\n",
                     cachedName_.toRawUTF8());
#endif
        return;
    }
    setLatencySamples(innerPtr->getLatencySamples());

    // Some VST3 plugins initialise their reported name lazily — refresh the
    // cache now so getName() returns the real value after first prepareToPlay.
    const auto freshName = innerPtr->getName();
    if (freshName.isNotEmpty())
        cachedName_ = freshName;
}

void GuardedPluginWrapper::releaseResources()
{
    if (!inner_) return;
    auto* innerPtr = inner_.get();
    xleth::pluginGuardCall([&]{ innerPtr->releaseResources(); });
}

void GuardedPluginWrapper::reset()
{
    if (!inner_) return;
    auto* innerPtr = inner_.get();
    xleth::pluginGuardCall([&]{ innerPtr->reset(); });
}

// ─── Audio thread ───────────────────────────────────────────────────────────

void GuardedPluginWrapper::processBlock(juce::AudioBuffer<float>& buffer,
                                        juce::MidiBuffer&         midi)
{
    // Fast path: already crashed → passthrough.  The APG render sequence leaves
    // the input audio in the buffer, so returning without touching it equals
    // dry signal.
    if (crashed_.load(std::memory_order_acquire))
        return;

    if (!inner_) return;

    auto* innerPtr = inner_.get();
    const bool ok = xleth::pluginGuardCall([&]
    {
        innerPtr->processBlock(buffer, midi);

        // ── Audio-stream tap (post-plugin output) ───────────────────────────
        // Acquire-load pairs with the release-store in enableAudioStream,
        // guaranteeing a fully-constructed ring when we observe `true`. The
        // raw pointer stays valid until disableAudioStream clears the flag
        // and drains a full audio-block's worth of time before destruction.
        // Inlined here (no function call, no alloc, no lock, no log).
        if (hasOpenEditor_.load(std::memory_order_acquire))
        {
            NamedAudioRing* ring = audioStreamRing_.get();
            if (ring != nullptr)
            {
                const int numCh      = buffer.getNumChannels();
                const int numSamples = buffer.getNumSamples();
                const float* chans[2] = {
                    numCh > 0 ? buffer.getReadPointer(0) : nullptr,
                    numCh > 1 ? buffer.getReadPointer(1)
                              : (numCh > 0 ? buffer.getReadPointer(0) : nullptr)
                };
                if (chans[0] != nullptr && chans[1] != nullptr)
                    ring->tryWrite(chans, numSamples);
            }
        }
    });

    if (!ok)
    {
        crashed_.store(true, std::memory_order_release);
        // One-shot logging — subsequent crashes on this node short-circuit above.
#ifdef XLETH_DEBUG
        std::fprintf(stderr,
                     "[PluginHost] CRASH: \"%s\" in processBlock — auto-bypassed\n",
                     cachedName_.toRawUTF8());
#endif
    }
}

// ─── Audio streaming (message thread only) ──────────────────────────────────

void GuardedPluginWrapper::enableAudioStream(const std::string& shmName,
                                             int                streamSampleRate,
                                             int                streamBlockSize)
{
    if (streamSampleRate <= 0 || streamBlockSize <= 0) return;

    // Construct the ring with ~16 blocks of headroom, rounded up to power of two.
    const int desired   = streamBlockSize * 16;
    const int ringSize  = NamedAudioRing::nextPow2(desired);

    auto ring = NamedAudioRing::createAndOwn(shmName,
                                             streamSampleRate, streamBlockSize,
                                             /*numChannels*/ 2,
                                             ringSize);
    if (!ring)
    {
        std::fprintf(stderr,
                     "[AudioStream] failed to create ring name=%s sr=%d bs=%d\n",
                     shmName.c_str(), streamSampleRate, streamBlockSize);
        std::fflush(stderr);
        return;
    }

    streamSampleRate_ = streamSampleRate;
    streamBlockSize_  = streamBlockSize;
    audioStreamRing_  = std::move(ring);

    // Publish: release pairs with acquire in processBlock. After this store,
    // the audio thread may observe the ring pointer and begin writing.
    hasOpenEditor_.store(true, std::memory_order_release);

    std::fprintf(stderr,
                 "[AudioStream] ring created name=%s sr=%d bs=%d ringSamples=%d\n",
                 shmName.c_str(), streamSampleRate, streamBlockSize, ringSize);
    std::fflush(stderr);
}

void GuardedPluginWrapper::disableAudioStream()
{
    if (!audioStreamRing_ && !hasOpenEditor_.load(std::memory_order_acquire))
        return;

    // Un-publish: after this, the audio thread's acquire-load may still see
    // `true` for one more block (already past the load before we stored false).
    hasOpenEditor_.store(false, std::memory_order_release);

    // Drain: any in-flight processBlock that already passed the acquire-load
    // is guaranteed to finish within one audio block. Sleep a block plus
    // slack. Worst-case 1024 samples / 44100 Hz ≈ 23 ms.
    const int  sr = streamSampleRate_ > 0 ? streamSampleRate_ : 44100;
    const int  bs = streamBlockSize_  > 0 ? streamBlockSize_  : 512;
    const int  blockMs   = (bs * 1000) / sr;
    const int  sleepMs   = blockMs + 10;
    // NOTE: these stages are in GuardedPluginWrapper::disableAudioStream(),
    // called from MixEngine's onClosed_ lambda — BEFORE the coordinator destructor.
    // They carry "dtor_" prefix to match the user's requested naming sequence.
    CPLOG("before_ring_drain");
    std::this_thread::sleep_for(std::chrono::milliseconds(sleepMs));

    CPLOG("dtor_before_ring_destroy");
    audioStreamRing_.reset();
    CPLOG("dtor_after_ring_destroy");

    std::fprintf(stderr, "[AudioStream] ring destroyed (drain=%dms)\n", sleepMs);
    std::fflush(stderr);
}

// ─── Editor (guarded — createEditor can fault) ──────────────────────────────

juce::AudioProcessorEditor* GuardedPluginWrapper::createEditor()
{
    if (!inner_ || crashed_.load(std::memory_order_acquire))
        return nullptr;

    auto* innerPtr = inner_.get();
    juce::AudioProcessorEditor* editor = nullptr;
    const bool ok = xleth::pluginGuardCall([&]{ editor = innerPtr->createEditor(); });
    if (!ok)
    {
#ifdef XLETH_DEBUG
        std::fprintf(stderr,
                     "[PluginHost] CRASH: \"%s\" in createEditor — editor unavailable\n",
                     cachedName_.toRawUTF8());
#endif
        return nullptr;
    }
    return editor;
}

// ─── State save / restore (guarded) ─────────────────────────────────────────

void GuardedPluginWrapper::getStateInformation(juce::MemoryBlock& destData)
{
    if (!inner_ || crashed_.load(std::memory_order_acquire)) return;
    auto* innerPtr = inner_.get();
    const bool ok = xleth::pluginGuardCall([&]{ innerPtr->getStateInformation(destData); });
    if (!ok)
    {
        destData.setSize(0);
#ifdef XLETH_DEBUG
        std::fprintf(stderr,
                     "[PluginHost] CRASH: \"%s\" in getStateInformation — skipping state save\n",
                     cachedName_.toRawUTF8());
#endif
    }
}

void GuardedPluginWrapper::setStateInformation(const void* data, int sizeInBytes)
{
    if (!inner_) return;
    auto* innerPtr = inner_.get();
    const bool ok = xleth::pluginGuardCall([&]{ innerPtr->setStateInformation(data, sizeInBytes); });
    if (!ok)
    {
        crashed_.store(true, std::memory_order_release);
#ifdef XLETH_DEBUG
        std::fprintf(stderr,
                     "[PluginHost] CRASH: \"%s\" in setStateInformation — plugin bypassed, default state\n",
                     cachedName_.toRawUTF8());
#endif
        return;
    }
    // setStateInformation often changes reported latency — re-sync for PDC.
    setLatencySamples(innerPtr->getLatencySamples());
}

// ─── Recovery ───────────────────────────────────────────────────────────────

bool GuardedPluginWrapper::resetCrashed()
{
    if (!inner_) return false;
    if (!crashed_.load(std::memory_order_acquire)) return true;

    auto* innerPtr = inner_.get();
    const double sr = getSampleRate() > 0 ? getSampleRate() : 44100.0;
    const int    bs = getBlockSize()  > 0 ? getBlockSize()  : 512;

    const bool ok = xleth::pluginGuardCall([&]
    {
        innerPtr->releaseResources();
        innerPtr->setPlayConfigDetails(2, 2, sr, bs);
        innerPtr->prepareToPlay(sr, bs);
        innerPtr->reset();
    });

    if (!ok)
    {
#ifdef XLETH_DEBUG
        std::fprintf(stderr,
                     "[PluginHost] Reset attempted: \"%s\" — failed\n",
                     cachedName_.toRawUTF8());
#endif
        return false;
    }

    setLatencySamples(innerPtr->getLatencySamples());
    crashed_.store(false, std::memory_order_release);
#ifdef XLETH_DEBUG
    std::fprintf(stderr,
                 "[PluginHost] Reset attempted: \"%s\" — success\n",
                 cachedName_.toRawUTF8());
#endif
    return true;
}
