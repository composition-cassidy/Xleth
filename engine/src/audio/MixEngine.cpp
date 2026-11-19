#include "audio/MixEngine.h"
#include "audio/TrackMixer.h"
#include "audio/TrackRouting.h"
#include "audio/SampleProcessor.h"
#include "audio/AudioGraph.h"
#include "audio/EffectChainManager.h"
#include "audio/EditorProcessCoordinator.h"
#include "audio/GuardedPluginWrapper.h"
#include "audio/PluginRegistry.h"
#include "audio/PluginEditorHost.h"
#include "audio/XlethEffectBase.h"
#include "audio/XlethDelayEffect.h"   // Visual Echo delay binding (resolveDelaySnapshot)
#include "audio/ClipFade.h"
#include "audio/HermiteInterp.h"
#include "audio/WorldStretchCache.h"
#include "audio/SlotBakeCache.h"
#include "HardwareTier.h"
#include "audio/RealtimeWorkerPool.h"
#if defined(_M_X64) || defined(__x86_64__) || defined(_M_IX86)
#  include <immintrin.h>
#endif
#include "dsp/DeclickEnvelope.h"
#include "model/ClipModulationCompatibility.h"
#include "model/SampleRegion.h"            // to_json(SampleSlot) for samplerInputs
#include "model/SamplerModulationJson.h"   // to_json(ModConfig)
#include "render/RenderClock.h"
#include "XlethDebug.h"

#include <juce_events/juce_events.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>
#include <cstdarg>
#include <cstdio>
#include <set>
#include <thread>
#include <unordered_map>

namespace {

// ── Realtime effect-tail drain (silence-detected) ───────────────────────────
// After a track's content ends we keep running its insert chain so reverb/delay
// wet tails ring out instead of being cut at the clip boundary. The stop is
// decided by the chain OUTPUT level, NOT by the plugin's self-reported
// getTailLengthSeconds(): external VST reverbs routinely report that as 0
// (unimplemented) or "infinite" (JUCE returns +inf), so it can't be trusted to
// size the drain. This mirrors the offline renderer's tail detector
// (RenderScope.h) so realtime and exported tails agree: drain until the output
// stays below kRealtimeTailThresholdLinear for kRealtimeTailHoldSeconds, hard-
// capped at kRealtimeTailMaxSeconds so a frozen / self-oscillating effect can
// never drain forever.
constexpr double kRealtimeTailMaxSeconds      = 30.0;
constexpr float  kRealtimeTailThresholdLinear = 0.001f;  // -60 dB
constexpr double kRealtimeTailHoldSeconds     = 0.050;   // 50 ms

uint64_t steadyNowNs() noexcept
{
    return static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count());
}

uint64_t deadlineNsFor(int numSamples, double sampleRate) noexcept
{
    if (numSamples <= 0 || sampleRate <= 0.0 || !std::isfinite(sampleRate))
        return 0;

    return static_cast<uint64_t>(
        (static_cast<double>(numSamples) / sampleRate) * 1000000000.0);
}

uint64_t ratioPermille(uint64_t elapsedNs, uint64_t deadlineNs) noexcept
{
    if (deadlineNs == 0)
        return 0;

    return static_cast<uint64_t>(
        (static_cast<long double>(elapsedNs) * 1000.0L)
        / static_cast<long double>(deadlineNs));
}

void atomicMax(std::atomic<uint64_t>& target, uint64_t value) noexcept
{
    uint64_t observed = target.load(std::memory_order_relaxed);
    while (value > observed
        && !target.compare_exchange_weak(observed, value,
                                         std::memory_order_relaxed,
                                         std::memory_order_relaxed))
    {
    }
}

bool atomicMaxWithWinner(std::atomic<uint64_t>& target, uint64_t value) noexcept
{
    uint64_t observed = target.load(std::memory_order_relaxed);
    while (value > observed)
    {
        if (target.compare_exchange_weak(observed, value,
                                         std::memory_order_relaxed,
                                         std::memory_order_relaxed))
        {
            return true;
        }
    }
    return false;
}

template <size_t Size>
void storeAtomicString(std::array<std::atomic<char>, Size>& dest,
                       const char* text) noexcept
{
    const char* src = text != nullptr ? text : "";
    size_t i = 0;
    for (; i + 1 < Size && src[i] != '\0'; ++i)
        dest[i].store(src[i], std::memory_order_relaxed);
    dest[i].store('\0', std::memory_order_relaxed);
    for (++i; i < Size; ++i)
        dest[i].store('\0', std::memory_order_relaxed);
}

template <size_t Size>
std::string loadAtomicString(const std::array<std::atomic<char>, Size>& src)
{
    char buffer[Size] = {};
    for (size_t i = 0; i < Size; ++i)
    {
        buffer[i] = src[i].load(std::memory_order_relaxed);
        if (buffer[i] == '\0')
            break;
    }
    buffer[Size - 1] = '\0';
    return std::string(buffer);
}

double nsToMs(uint64_t ns) noexcept
{
    return static_cast<double>(ns) / 1000000.0;
}

double permilleToRatio(uint64_t value) noexcept
{
    return static_cast<double>(value) / 1000.0;
}

bool isResonanceSuppressorPlugin(const char* pluginId) noexcept
{
    return pluginId != nullptr && std::strcmp(pluginId, "resonancesuppressor") == 0;
}

bool isSection(const char* sectionId, const char* expected) noexcept
{
    return sectionId != nullptr && expected != nullptr
        && std::strcmp(sectionId, expected) == 0;
}

} // namespace

// ─── MixDebugLog ─────────────────────────────────────────────────────────────

int MixDebugLog::nextPow2(int v)
{
    int p = 1;
    while (p < v) p <<= 1;
    return p;
}

MixDebugLog::MixDebugLog(int capacity)
{
    const int cap = nextPow2(capacity);
    buffer_.resize(static_cast<size_t>(cap));
    mask_ = cap - 1;
}

bool MixDebugLog::push(const MixDebugEntry& entry)
{
    const int w = writePos_.load(std::memory_order_relaxed);
    const int r = readPos_.load(std::memory_order_acquire);
    if (((w + 1) & mask_) == (r & mask_))
        return false; // full — drop
    buffer_[w & mask_] = entry;
    writePos_.store((w + 1) & mask_, std::memory_order_release);
    return true;
}

bool MixDebugLog::pop(MixDebugEntry& entry)
{
    const int r = readPos_.load(std::memory_order_relaxed);
    const int w = writePos_.load(std::memory_order_acquire);
    if (r == w)
        return false; // empty
    entry = buffer_[r & mask_];
    readPos_.store((r + 1) & mask_, std::memory_order_release);
    return true;
}

// ─── MixEngine ───────────────────────────────────────────────────────────────


int MixEngine::StereoCompensationDelay::nextPowerOfTwo(int value)
{
    int power = 1;
    while (power < value)
        power <<= 1;
    return power;
}

void MixEngine::StereoCompensationDelay::prepare(double sampleRate, int maxBlockSize)
{
    sampleRate_ = sampleRate;
    maxBlockSize_ = maxBlockSize;
    ensureCapacity(0);
    reset();
}

void MixEngine::StereoCompensationDelay::reset()
{
    resetToDelaySamples(0);
}

void MixEngine::StereoCompensationDelay::resetToDelaySamples(int delaySamples)
{
    delaySamples = juce::jmax(0, delaySamples);
    ensureCapacity(delaySamples);

    for (auto& channel : channels_)
        std::fill(channel.begin(), channel.end(), 0.0f);

    writePos_ = 0;
    currentDelaySamples_ = delaySamples;
    sourceDelaySamples_ = delaySamples;
    targetDelaySamples_ = delaySamples;
    crossfadeRemaining_ = 0;
    hasProcessedAudio_ = false;
}

void MixEngine::StereoCompensationDelay::ensureCapacity(int requiredDelaySamples)
{
    const int requiredSamples = juce::jmax(
        minCapacitySamples_,
        requiredDelaySamples + maxBlockSize_ + kCrossfadeSamples + 1);

    if (requiredSamples <= 0)
        return;

    const int oldSize = static_cast<int>(channels_[0].size());
    if (oldSize >= requiredSamples)
        return;

    const int newSize = nextPowerOfTwo(requiredSamples);
    const int delta = newSize - oldSize;

    for (auto& channel : channels_)
    {
        std::vector<float> grown(static_cast<size_t>(newSize), 0.0f);
        if (oldSize > 0)
        {
            for (int i = 0; i < oldSize; ++i)
                grown[static_cast<size_t>(i + delta)] = channel[static_cast<size_t>(i)];
        }
        channel.swap(grown);
    }

    bufferMask_ = newSize - 1;
    if (oldSize > 0)
        writePos_ += delta;
    writePos_ &= bufferMask_;
}

float MixEngine::StereoCompensationDelay::readSample(int channel, int delaySamples) const
{
    if (channels_[channel].empty())
        return 0.0f;

    const int readIndex = (writePos_ - delaySamples) & bufferMask_;
    return channels_[channel][static_cast<size_t>(readIndex)];
}

void MixEngine::StereoCompensationDelay::setTargetDelaySamples(int delaySamples)
{
    delaySamples = juce::jmax(0, delaySamples);
    ensureCapacity(delaySamples);

    if (!hasProcessedAudio_)
    {
        currentDelaySamples_ = delaySamples;
        sourceDelaySamples_ = delaySamples;
        targetDelaySamples_ = delaySamples;
        crossfadeRemaining_ = 0;
        return;
    }

    if (crossfadeRemaining_ == 0 && delaySamples == currentDelaySamples_)
    {
        targetDelaySamples_ = delaySamples;
        sourceDelaySamples_ = delaySamples;
        return;
    }

    const int activeDelay = (crossfadeRemaining_ > 0) ? targetDelaySamples_
                                                      : currentDelaySamples_;
    if (delaySamples == activeDelay)
        return;

    sourceDelaySamples_ = activeDelay;
    targetDelaySamples_ = delaySamples;

    if (sourceDelaySamples_ == targetDelaySamples_)
    {
        currentDelaySamples_ = targetDelaySamples_;
        crossfadeRemaining_ = 0;
        return;
    }

    crossfadeRemaining_ = kCrossfadeSamples;
}

void MixEngine::StereoCompensationDelay::process(juce::AudioBuffer<float>& buffer, int numSamples)
{
    if (numSamples <= 0)
        return;

    ensureCapacity(juce::jmax(currentDelaySamples_,
                              juce::jmax(sourceDelaySamples_, targetDelaySamples_)));

    auto* left = buffer.getWritePointer(0);
    auto* right = buffer.getNumChannels() > 1 ? buffer.getWritePointer(1) : nullptr;

    for (int sample = 0; sample < numSamples; ++sample)
    {
        const float inL = left[sample];
        const float inR = (right != nullptr) ? right[sample] : 0.0f;

        channels_[0][static_cast<size_t>(writePos_)] = inL;
        channels_[1][static_cast<size_t>(writePos_)] = inR;

        float outL = readSample(0, currentDelaySamples_);
        float outR = readSample(1, currentDelaySamples_);

        if (crossfadeRemaining_ > 0)
        {
            const float oldL = readSample(0, sourceDelaySamples_);
            const float oldR = readSample(1, sourceDelaySamples_);
            const float newL = readSample(0, targetDelaySamples_);
            const float newR = readSample(1, targetDelaySamples_);
            const float alpha = static_cast<float>(kCrossfadeSamples - crossfadeRemaining_)
                              / static_cast<float>(kCrossfadeSamples);

            outL = oldL + (newL - oldL) * alpha;
            outR = oldR + (newR - oldR) * alpha;

            --crossfadeRemaining_;
            if (crossfadeRemaining_ == 0)
            {
                currentDelaySamples_ = targetDelaySamples_;
                sourceDelaySamples_ = targetDelaySamples_;
            }
        }

        left[sample] = outL;
        if (right != nullptr)
            right[sample] = outR;

        writePos_ = (writePos_ + 1) & bufferMask_;
    }

    hasProcessedAudio_ = true;
}

// ── Parallel track processing: per-block scheduling state ────────────────────
// One block's worth of hand-off state between MixEngine::processBlock (the
// audio thread, the only one that runs phase B and pushes ready slots) and the
// helper threads (which pop ready slots and run phase A). Preallocated once in
// prepare(); reinitialised at the top of every parallel block.
struct MixEngine::ParallelTrackJob
{
    static constexpr int kMaxEdgesPerSlot =
        1 + kMaxTrackSends + xleth::SidechainPlan::kMaxTaps;

    std::atomic<int> claim[MixEngine::kMaxTracks];   // 0 free, 1 taken (whoever runs A)
    std::atomic<int> done[MixEngine::kMaxTracks];    // 1 once phase A has finished
    std::atomic<int> inDeg[MixEngine::kMaxTracks];   // upstream phase Bs still pending
    int              edgeTarget[MixEngine::kMaxTracks][kMaxEdgesPerSlot];
    int              edgeCount[MixEngine::kMaxTracks];
    int              readyQ[MixEngine::kMaxTracks];  // single producer (audio thread)
    std::atomic<int> readyHead{0};                   // multi-consumer (CAS)
    std::atomic<int> readyTail{0};

    void*  runner = nullptr;                         // &runSlotA (lives on the callback stack)
    void (*runA)(void* runner, int slot) = nullptr;
    const XlethEffectBase::TrackMidiRef* midiDir = nullptr;
    int      midiCount = 0;
    unsigned mxcsr     = 0;
    xleth::audio::RealtimeWorkerPool* pool = nullptr;

    int popReady() noexcept
    {
        int h = readyHead.load(std::memory_order_acquire);
        while (h < readyTail.load(std::memory_order_acquire))
        {
            if (readyHead.compare_exchange_weak(h, h + 1, std::memory_order_acq_rel))
                return readyQ[h];
        }
        return -1;
    }
};

// Helper-thread side of one parallel block: run any ready slot's phase A until
// the audio thread closes the block. Every helper adopts the callback thread's
// floating-point control word (FTZ/DAZ, rounding) and per-block thread-locals,
// so a chain computes exactly what it would have on the audio thread.
void MixEngine::parallelTrackWorker(void* p)
{
    auto& job = *static_cast<ParallelTrackJob*>(p);
    const unsigned savedCsr = _mm_getcsr();
    _mm_setcsr(job.mxcsr);
    XlethEffectBase::setTrackMidiDirectory(job.midiDir, job.midiCount);

    int idleSpins = 0;
    while (job.pool->isOpen())
    {
        const int slot = job.popReady();
        if (slot >= 0)
        {
            int expected = 0;
            if (job.claim[slot].compare_exchange_strong(expected, 1, std::memory_order_acq_rel))
            {
                job.runA(job.runner, slot);
                job.done[slot].store(1, std::memory_order_release);
            }
            idleSpins = 0;
            continue;
        }
        _mm_pause();
        if (++idleSpins >= 2048)      // nothing ready for a while: let others run
        {
            std::this_thread::yield();
            idleSpins = 0;
        }
    }

    XlethEffectBase::setTrackMidiDirectory(nullptr, 0);
    (void) XlethEffectBase::takeTailHold();
    _mm_setcsr(savedCsr);
}

int MixEngine::getTrackWorkerCount() const noexcept
{
    return trackWorkerPool_ ? trackWorkerPool_->numWorkers() : 0;
}

MixEngine::MixEngine()
{
    // Publish an empty chain snapshot before anything can call processBlock.
    // The audio thread treats a null snapshot as "no chain region this block",
    // which for a project with no effect chains at all would also skip the
    // automation write and the PDC/latency scan that run alongside it. There is
    // always a snapshot from here on; it may simply be empty.
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        publishChainSnapshotLocked();
        // Likewise an empty source-transform table, at generation 0, so
        // currentSourceTransformTable() is never null.
        sourceTransformTable_.store(
            std::make_shared<const xleth::TrackSourceTransformTable>(),
            std::memory_order_release);
    }

    trackBuffers_.resize(kMaxTracks);
    sidechainBuffers_.resize(kMaxTracks);
    activeClips_.reserve(256);
    prevActiveClipsScratch_.reserve(256);
    activeBlocks_.reserve(64);
    regionToSampleMap_.store(std::make_shared<const RegionSampleMap>(),
                             std::memory_order_release);
    // findActivePatternBlocks() swaps these two every block, so both need the
    // capacity — otherwise the first swap hands the audio thread an empty one.
    prevActiveBlocks_.reserve(64);
    // Onset events are added on the audio thread every block; clear() keeps
    // the storage, so sizing it here means addEvent() never has to grow it.
    for (auto& midi : trackMidiBuffers_)
        midi.ensureSize(4096);

    // WORLD vocoder content cache lives next to ClipRenderCache so the WORLD
    // dispatch branch (worker thread) can reuse analysis across pitch toggles.
    // Budgets scale with installed RAM (HardwareTier::ramCacheMultiplier: 1x
    // below 24 GB — the historical sizes — 2x to 48 GB, 4x above), so a big
    // machine keeps more rendered clips / bakes warm instead of re-rendering.
    worldStretchCache_ = std::make_unique<xleth::audio::WorldStretchCache>(
        xleth::hw::scaledCacheBytes(xleth::audio::WorldStretchCache::kDefaultMaxBytes));
    clipRenderCache_.setWorldCache(worldStretchCache_.get());
    clipRenderCache_.setMaxBytes(
        xleth::hw::scaledCacheBytes(ClipRenderCache::kDefaultMaxBytes));

    // Per-slot PREP bake cache. Starts memory-only; the disk tier switches on
    // once a project directory exists (setSlotBakeCacheDir).
    slotBakeCache_ = std::make_unique<xleth::audio::SlotBakeCache>(
        xleth::hw::scaledCacheBytes(xleth::audio::SlotBakeCache::kDefaultMaxBytes));

    // Create plugin registry (registers VST3 format manager).
    pluginRegistry_ = std::make_unique<PluginRegistry>();
    editorHost_     = std::make_unique<PluginEditorHost>();

    // Attempt to warm the known-plugin list from the on-disk cache.
    // %APPDATA%\Xleth\plugin-cache.xml — silently skipped if absent.
    juce::File cacheFile = juce::File::getSpecialLocation(
                               juce::File::userApplicationDataDirectory)
                           .getChildFile("Xleth")
                           .getChildFile("plugin-cache.xml");
    pluginRegistry_->loadScanResults(cacheFile);

    coordinatorReaperThread_ = std::thread([this]() { runCoordinatorReaper(); });

    xleth::dsp::DeclickEnvelope::initialize();
}

MixEngine::~MixEngine()
{
    // The settle timer calls back into this engine; stop it first.
    fxSettleTimer_.reset();

    // Stop the clip render workers before ANY member goes away. A running
    // ClipRenderJob borrows worldStretchCache_ (owner_->worldCache()), which is
    // declared after clipRenderCache_ and so is destroyed before the cache's
    // own destructor would have stopped the pool: shutting down while WORLD
    // renders were still in flight (quit, or a test exiting, within a few
    // seconds of opening a project with pitched clips) was a use-after-free.
    // shutdown() is idempotent — the member destructor finds nothing left.
    clipRenderCache_.shutdown();

    // Stop the envelope applier before anything else tears down: it writes to
    // effect chains, so it must not be running while they are destroyed.
    stopEnvelopeApplierThread();

    // Stop and join the reaper thread first. The loop drains any queued
    // coordinators before exiting (reaperStop_ && empty → return).
    {
        std::lock_guard<std::mutex> lock(reaperMutex_);
        reaperStop_.store(true);
    }
    reaperCv_.notify_all();
    if (coordinatorReaperThread_.joinable())
        coordinatorReaperThread_.join();

    // Close all out-of-process VST editors. Any coordinators still in the map
    // (editors open at shutdown) are destroyed here from the destructor thread —
    // safe because no poll thread will self-join (they're joining the reaper, now gone).
    {
        std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
        vstEditorCoordinators_.clear();
    }

    // Close all in-process editor windows (stock effects).
    // This ensures AudioProcessorEditor is released before AudioProcessor.
    if (editorHost_)
        editorHost_->closeAllEditors();
}

// ── Coordinator reaper ────────────────────────────────────────────────────────

void MixEngine::setRealtimeDiagnosticsEnabled(bool enabled)
{
    realtimeDiagnostics_.enabled.store(enabled, std::memory_order_release);
    audioPerformanceTelemetry_.setEnabled(enabled);
}

bool MixEngine::isRealtimeDiagnosticsEnabled() const
{
    return realtimeDiagnostics_.enabled.load(std::memory_order_acquire)
        || audioPerformanceTelemetry_.isEnabled();
}

void MixEngine::resetRealtimeDiagnostics()
{
    const bool enabled = realtimeDiagnostics_.enabled.load(std::memory_order_relaxed);

    realtimeDiagnostics_.blockCount.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.audioCallbackCount.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.totalProcessNs.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.maxProcessNs.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.totalDeadlineNs.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.maxRatioPermille.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.overBudgetBlockCount.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.overrunBlockCount.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.totalAudioCallbackNs.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.maxAudioCallbackNs.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.maxAudioCallbackRatioPermille.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.audioCallbackOverrunCount.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.chainLockMissCount.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.pdcRetargetCount.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.pdcDelayProcessCount.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.trackProcessCount.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.totalTrackProcessNs.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.maxTrackProcessNs.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.worstTrackId.store(-1, std::memory_order_relaxed);
    realtimeDiagnostics_.trackChainProcessCount.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.totalTrackChainNs.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.maxTrackChainNs.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.worstTrackChainId.store(-1, std::memory_order_relaxed);
    realtimeDiagnostics_.totalPdcDelayNs.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.maxPdcDelayNs.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.pluginCallCount.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.totalPluginNs.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.maxPluginNs.store(0, std::memory_order_relaxed);
    storeAtomicString(realtimeDiagnostics_.worstPluginId, "");
    realtimeDiagnostics_.worstPluginTrackId.store(-1, std::memory_order_relaxed);
    realtimeDiagnostics_.worstPluginNodeId.store(-1, std::memory_order_relaxed);
    realtimeDiagnostics_.resonanceSuppressorCallCount.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.totalResonanceSuppressorNs.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.maxResonanceSuppressorNs.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.resonanceSuppressorWolaCallCount.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.totalResonanceSuppressorWolaNs.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.maxResonanceSuppressorWolaNs.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.resonanceSuppressorAudioThreadReprepareCount.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.resonanceSuppressorDeferredReprepareCount.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.nanInfBlockCount.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.lastBlockSize.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.lastSampleRateMilliHz.store(0, std::memory_order_relaxed);
    realtimeDiagnostics_.lastDeadlineNs.store(0, std::memory_order_relaxed);
    audioPerformanceTelemetry_.reset();

    realtimeDiagnostics_.enabled.store(enabled, std::memory_order_release);
    audioPerformanceTelemetry_.setEnabled(enabled);
}

MixEngine::RealtimeDiagnosticsSnapshot MixEngine::getRealtimeDiagnosticsSnapshot(
    uint64_t minTimingSequence) const
{
    RealtimeDiagnosticsSnapshot snapshot;
    const auto perf = minTimingSequence > 0
        ? audioPerformanceTelemetry_.getSnapshotSince(minTimingSequence)
        : audioPerformanceTelemetry_.getSnapshot();
    const auto usToMs = [](double us) noexcept { return us / 1000.0; };
    const auto metricAvgMs = [&](const xleth::audio::AudioTelemetryMetricSummary& metric) {
        return usToMs(metric.averageUs);
    };
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        snapshot.activeResonanceSuppressorHighQualityInstanceCount =
            countActiveResonanceSuppressorHighQualityInstancesLocked();
    }

    snapshot.enabled = realtimeDiagnostics_.enabled.load(std::memory_order_acquire);
    snapshot.timingSequence = perf.counters.lastTimingSequence;
    snapshot.blockCount = realtimeDiagnostics_.blockCount.load(std::memory_order_relaxed);
    snapshot.audioCallbackCount = realtimeDiagnostics_.audioCallbackCount.load(std::memory_order_relaxed);
    snapshot.lastBlockSize = realtimeDiagnostics_.lastBlockSize.load(std::memory_order_relaxed);
    snapshot.lastSampleRate =
        static_cast<double>(realtimeDiagnostics_.lastSampleRateMilliHz.load(std::memory_order_relaxed))
        / 1000.0;
    snapshot.lastDeadlineMs = nsToMs(realtimeDiagnostics_.lastDeadlineNs.load(std::memory_order_relaxed));

    const uint64_t totalProcessNs = realtimeDiagnostics_.totalProcessNs.load(std::memory_order_relaxed);
    const uint64_t totalDeadlineNs = realtimeDiagnostics_.totalDeadlineNs.load(std::memory_order_relaxed);
    snapshot.avgProcessBlockMs = snapshot.blockCount > 0
        ? nsToMs(totalProcessNs / snapshot.blockCount)
        : 0.0;
    snapshot.maxProcessBlockMs = nsToMs(realtimeDiagnostics_.maxProcessNs.load(std::memory_order_relaxed));
    snapshot.avgProcessBlockRatio = totalDeadlineNs > 0
        ? static_cast<double>(totalProcessNs) / static_cast<double>(totalDeadlineNs)
        : 0.0;
    snapshot.maxProcessBlockRatio =
        permilleToRatio(realtimeDiagnostics_.maxRatioPermille.load(std::memory_order_relaxed));

    snapshot.avgAudioCallbackMs = snapshot.audioCallbackCount > 0
        ? nsToMs(realtimeDiagnostics_.totalAudioCallbackNs.load(std::memory_order_relaxed)
                 / snapshot.audioCallbackCount)
        : 0.0;
    snapshot.maxAudioCallbackMs =
        nsToMs(realtimeDiagnostics_.maxAudioCallbackNs.load(std::memory_order_relaxed));
    snapshot.maxAudioCallbackRatio =
        permilleToRatio(realtimeDiagnostics_.maxAudioCallbackRatioPermille.load(std::memory_order_relaxed));

    snapshot.overBudgetBlockCount =
        realtimeDiagnostics_.overBudgetBlockCount.load(std::memory_order_relaxed);
    snapshot.overrunBlockCount =
        realtimeDiagnostics_.overrunBlockCount.load(std::memory_order_relaxed);
    snapshot.audioCallbackOverrunCount =
        realtimeDiagnostics_.audioCallbackOverrunCount.load(std::memory_order_relaxed);
    snapshot.chainLockMissCount =
        realtimeDiagnostics_.chainLockMissCount.load(std::memory_order_relaxed);
    snapshot.pdcRetargetCount =
        realtimeDiagnostics_.pdcRetargetCount.load(std::memory_order_relaxed);
    snapshot.pdcDelayProcessCount =
        realtimeDiagnostics_.pdcDelayProcessCount.load(std::memory_order_relaxed);

    const uint64_t trackProcessCount =
        realtimeDiagnostics_.trackProcessCount.load(std::memory_order_relaxed);
    snapshot.avgTrackProcessMs = trackProcessCount > 0
        ? nsToMs(realtimeDiagnostics_.totalTrackProcessNs.load(std::memory_order_relaxed)
                 / trackProcessCount)
        : 0.0;
    snapshot.maxTrackProcessMs =
        nsToMs(realtimeDiagnostics_.maxTrackProcessNs.load(std::memory_order_relaxed));
    snapshot.worstTrackId = realtimeDiagnostics_.worstTrackId.load(std::memory_order_relaxed);

    const uint64_t trackChainProcessCount =
        realtimeDiagnostics_.trackChainProcessCount.load(std::memory_order_relaxed);
    snapshot.avgTrackChainMs = trackChainProcessCount > 0
        ? nsToMs(realtimeDiagnostics_.totalTrackChainNs.load(std::memory_order_relaxed)
                 / trackChainProcessCount)
        : 0.0;
    snapshot.maxTrackChainMs =
        nsToMs(realtimeDiagnostics_.maxTrackChainNs.load(std::memory_order_relaxed));
    snapshot.worstTrackChainId =
        realtimeDiagnostics_.worstTrackChainId.load(std::memory_order_relaxed);

    snapshot.avgPdcDelayMs = snapshot.pdcDelayProcessCount > 0
        ? nsToMs(realtimeDiagnostics_.totalPdcDelayNs.load(std::memory_order_relaxed)
                 / snapshot.pdcDelayProcessCount)
        : 0.0;
    snapshot.maxPdcDelayMs =
        nsToMs(realtimeDiagnostics_.maxPdcDelayNs.load(std::memory_order_relaxed));

    snapshot.pluginCallCount =
        realtimeDiagnostics_.pluginCallCount.load(std::memory_order_relaxed);
    snapshot.avgPluginMs = snapshot.pluginCallCount > 0
        ? nsToMs(realtimeDiagnostics_.totalPluginNs.load(std::memory_order_relaxed)
                 / snapshot.pluginCallCount)
        : 0.0;
    snapshot.maxPluginMs =
        nsToMs(realtimeDiagnostics_.maxPluginNs.load(std::memory_order_relaxed));
    snapshot.worstPluginId = loadAtomicString(realtimeDiagnostics_.worstPluginId);
    snapshot.worstPluginTrackId =
        realtimeDiagnostics_.worstPluginTrackId.load(std::memory_order_relaxed);
    snapshot.worstPluginNodeId =
        realtimeDiagnostics_.worstPluginNodeId.load(std::memory_order_relaxed);

    const uint64_t rsCount =
        realtimeDiagnostics_.resonanceSuppressorCallCount.load(std::memory_order_relaxed);
    snapshot.avgResonanceSuppressorMs = rsCount > 0
        ? nsToMs(realtimeDiagnostics_.totalResonanceSuppressorNs.load(std::memory_order_relaxed)
                 / rsCount)
        : 0.0;
    snapshot.maxResonanceSuppressorMs =
        nsToMs(realtimeDiagnostics_.maxResonanceSuppressorNs.load(std::memory_order_relaxed));
    snapshot.resonanceSuppressorWolaCallCount =
        realtimeDiagnostics_.resonanceSuppressorWolaCallCount.load(std::memory_order_relaxed);
    snapshot.avgResonanceSuppressorWolaMs = snapshot.resonanceSuppressorWolaCallCount > 0
        ? nsToMs(realtimeDiagnostics_.totalResonanceSuppressorWolaNs.load(std::memory_order_relaxed)
                 / snapshot.resonanceSuppressorWolaCallCount)
        : 0.0;
    snapshot.maxResonanceSuppressorWolaMs =
        nsToMs(realtimeDiagnostics_.maxResonanceSuppressorWolaNs.load(std::memory_order_relaxed));
    snapshot.resonanceSuppressorAudioThreadReprepareCount =
        realtimeDiagnostics_.resonanceSuppressorAudioThreadReprepareCount.load(std::memory_order_relaxed);
    snapshot.resonanceSuppressorDeferredReprepareCount =
        realtimeDiagnostics_.resonanceSuppressorDeferredReprepareCount.load(std::memory_order_relaxed);
    snapshot.nanInfBlockCount =
        realtimeDiagnostics_.nanInfBlockCount.load(std::memory_order_relaxed);

    snapshot.enabled = snapshot.enabled || perf.counters.enabled;
    snapshot.blockCount = (minTimingSequence > 0 && perf.mixBlock.count > 0)
        ? perf.mixBlock.count
        : perf.counters.mixBlockCount > 0
        ? perf.counters.mixBlockCount
        : snapshot.blockCount;
    snapshot.audioCallbackCount = (minTimingSequence > 0 && perf.callback.count > 0)
        ? perf.callback.count
        : perf.counters.audioCallbackCount > 0
        ? perf.counters.audioCallbackCount
        : snapshot.audioCallbackCount;
    snapshot.lastBlockSize = perf.counters.lastBlockSize > 0
        ? static_cast<int>(perf.counters.lastBlockSize)
        : snapshot.lastBlockSize;
    snapshot.lastSampleRate = perf.counters.lastSampleRateMilliHz > 0
        ? static_cast<double>(perf.counters.lastSampleRateMilliHz) / 1000.0
        : snapshot.lastSampleRate;
    snapshot.lastDeadlineMs = perf.counters.lastDeadlineUs > 0
        ? usToMs(static_cast<double>(perf.counters.lastDeadlineUs))
        : snapshot.lastDeadlineMs;

    if (perf.mixBlock.count > 0)
    {
        snapshot.avgProcessBlockMs = metricAvgMs(perf.mixBlock);
        snapshot.p50ProcessBlockMs = usToMs(perf.mixBlock.p50Us);
        snapshot.p95ProcessBlockMs = usToMs(perf.mixBlock.p95Us);
        snapshot.p99ProcessBlockMs = usToMs(perf.mixBlock.p99Us);
        snapshot.maxProcessBlockMs = usToMs(perf.mixBlock.maxUs);
        snapshot.maxProcessBlockRatio =
            perf.counters.lastDeadlineUs > 0
                ? static_cast<double>(perf.mixBlock.maxUs)
                    / static_cast<double>(perf.counters.lastDeadlineUs)
                : snapshot.maxProcessBlockRatio;
    }

    if (perf.callback.count > 0)
    {
        snapshot.avgAudioCallbackMs = metricAvgMs(perf.callback);
        snapshot.p50AudioCallbackMs = usToMs(perf.callback.p50Us);
        snapshot.p95AudioCallbackMs = usToMs(perf.callback.p95Us);
        snapshot.p99AudioCallbackMs = usToMs(perf.callback.p99Us);
        snapshot.maxAudioCallbackMs = usToMs(perf.callback.maxUs);
        snapshot.maxAudioCallbackRatio =
            perf.counters.lastDeadlineUs > 0
                ? static_cast<double>(perf.callback.maxUs)
                    / static_cast<double>(perf.counters.lastDeadlineUs)
                : snapshot.maxAudioCallbackRatio;
    }

    snapshot.overBudgetBlockCount = perf.counters.overBudgetBlockCount;
    snapshot.overrunBlockCount = perf.counters.mixOverrunCount;
    snapshot.audioCallbackOverrunCount = perf.counters.callbackOverrunCount;
    snapshot.droppedTelemetrySamples = perf.counters.droppedTimingSamples;
    snapshot.chainLockMissCount = perf.counters.chainLockMissCount;
    snapshot.chainSnapshotMissingCount = perf.counters.chainSnapshotMissingCount;
    snapshot.masterChainSkippedCount = perf.counters.masterChainSkippedCount;
    snapshot.trackChainSkippedCount = perf.counters.trackChainSkippedCount;
    snapshot.staleSnapshotReuseCount = perf.counters.staleSnapshotReuseCount;
    snapshot.guardedPluginCrashedSkippedCount =
        perf.counters.guardedPluginCrashedSkippedCount;
    snapshot.latencyEpochChangeCount = perf.counters.latencyEpochChangeCount;
    snapshot.pdcRetargetCount = perf.counters.compensationTargetChangeCount;
    snapshot.pdcDelayProcessCount = perf.counters.pdcDelayProcessCount;

    if (perf.trackChain.count > 0)
    {
        snapshot.avgTrackChainMs = metricAvgMs(perf.trackChain);
        snapshot.p95TrackChainMs = usToMs(perf.trackChain.p95Us);
        snapshot.p99TrackChainMs = usToMs(perf.trackChain.p99Us);
        snapshot.maxTrackChainMs = usToMs(perf.trackChain.maxUs);
    }
    if (perf.masterChain.count > 0)
    {
        snapshot.avgMasterChainMs = metricAvgMs(perf.masterChain);
        snapshot.p95MasterChainMs = usToMs(perf.masterChain.p95Us);
        snapshot.p99MasterChainMs = usToMs(perf.masterChain.p99Us);
        snapshot.maxMasterChainMs = usToMs(perf.masterChain.maxUs);
    }
    if (perf.pdcDelay.count > 0)
    {
        snapshot.avgPdcDelayMs = metricAvgMs(perf.pdcDelay);
        snapshot.p95PdcDelayMs = usToMs(perf.pdcDelay.p95Us);
        snapshot.p99PdcDelayMs = usToMs(perf.pdcDelay.p99Us);
        snapshot.maxPdcDelayMs = usToMs(perf.pdcDelay.maxUs);
    }
    if (perf.effect.count > 0)
    {
        snapshot.pluginCallCount = perf.effect.count;
        snapshot.avgPluginMs = metricAvgMs(perf.effect);
        snapshot.p95PluginMs = usToMs(perf.effect.p95Us);
        snapshot.p99PluginMs = usToMs(perf.effect.p99Us);
        snapshot.maxPluginMs = usToMs(perf.effect.maxUs);
    }

    if (!perf.worstEffectsByMax.empty())
    {
        const auto& worst = perf.worstEffectsByMax.front();
        snapshot.worstPluginId =
            xleth::audio::AudioPerformanceTelemetry::effectTypeName(worst.effectType);
        snapshot.worstPluginTrackId = worst.trackId;
        snapshot.worstPluginNodeId = worst.slotOrNodeId;
    }

    snapshot.recentAudioCallbackUs = perf.recentCallbackDurationUs;
    snapshot.worstEffectsByMax = perf.worstEffectsByMax;
    snapshot.worstEffectsByP99 = perf.worstEffectsByP99;
    snapshot.worstChainsByMax = perf.worstChainsByMax;
    snapshot.worstChainsByP99 = perf.worstChainsByP99;

    snapshot.resonanceSuppressorWolaCallCount =
        perf.counters.resonanceSuppressorWolaCallCount;
    if (perf.effectSection.count > 0)
    {
        snapshot.avgResonanceSuppressorWolaMs = metricAvgMs(perf.effectSection);
        snapshot.p99ResonanceSuppressorWolaMs = usToMs(perf.effectSection.p99Us);
        snapshot.maxResonanceSuppressorWolaMs = usToMs(perf.effectSection.maxUs);
    }
    snapshot.resonanceSuppressorAudioThreadReprepareCount =
        perf.counters.resonanceSuppressorAudioThreadReprepareCount;
    snapshot.resonanceSuppressorDeferredReprepareCount =
        perf.counters.resonanceSuppressorDeferredReprepareCount;
    snapshot.nanInfBlockCount = perf.counters.nanInfBlockCount;

    if (snapshot.overrunBlockCount > 0 || snapshot.audioCallbackOverrunCount > 0)
        snapshot.diagnosis = "realtime_cpu_overrun";
    else if (snapshot.blockCount > 0 && snapshot.pdcRetargetCount > (snapshot.blockCount / 4))
        snapshot.diagnosis = "pdc_target_churn";
    else if (snapshot.chainLockMissCount > 0)
        snapshot.diagnosis = "chain_lock_contention";
    else if (snapshot.overBudgetBlockCount > 0)
        snapshot.diagnosis = "realtime_cpu_margin_risk";
    else
        snapshot.diagnosis = "no_realtime_instability_observed";

    const double safeWolaMs = snapshot.lastDeadlineMs * 0.70;
    snapshot.highQualityResonanceSuppressorRealtimeSafe =
        snapshot.resonanceSuppressorWolaCallCount > 0
        && snapshot.maxResonanceSuppressorWolaMs <= safeWolaMs
        && snapshot.resonanceSuppressorAudioThreadReprepareCount == 0
        && snapshot.overrunBlockCount == 0;

    xleth::audio::RealtimeRsHqRiskInputs rsHqInputs;
    rsHqInputs.sampleRate = snapshot.lastSampleRate;
    rsHqInputs.blockSize = static_cast<std::uint32_t>(std::max(0, snapshot.lastBlockSize));
    rsHqInputs.offlineOrExport = nonRealtime_.load(std::memory_order_relaxed);
    rsHqInputs.activeHighQualityInstanceCount =
        static_cast<std::uint32_t>(
            std::max(0, snapshot.activeResonanceSuppressorHighQualityInstanceCount));
    rsHqInputs.counters = perf.counters;
    rsHqInputs.callback = perf.callback;
    rsHqInputs.mixBlock = perf.mixBlock;
    rsHqInputs.resonanceSuppressorWola = perf.effectSection;
    const auto rsHqRisk =
        xleth::audio::AudioPerformanceTelemetry::classifyRealtimeRsHqRisk(rsHqInputs);
    snapshot.activeResonanceSuppressorHighQualityInstanceCount =
        static_cast<int>(rsHqRisk.activeResonanceSuppressorHighQualityInstanceCount);
    snapshot.realtimeRsHqRiskLevel = rsHqRisk.realtimeRsHqRiskLevel;
    snapshot.realtimeRsHqRiskReasons = rsHqRisk.realtimeRsHqRiskReasons;
    snapshot.recommendedAction = rsHqRisk.recommendedAction;

    return snapshot;
}

void MixEngine::beginRealtimeDiagnosticsCaptureAccumulation(
    uint64_t minTimingSequence) const
{
    audioPerformanceTelemetry_.beginCaptureAccumulation(minTimingSequence);
}

void MixEngine::drainRealtimeDiagnosticsCaptureAccumulation() const
{
    audioPerformanceTelemetry_.drainPendingTimingSamplesForCapture();
}

MixEngine::RealtimeDiagnosticsSnapshot
MixEngine::finishRealtimeDiagnosticsCaptureAccumulation(
    uint64_t* accumulatedTimingSampleCount,
    uint64_t* accumulatorOverflowDrops) const
{
    const auto capture = audioPerformanceTelemetry_.finishCaptureAccumulation();
    if (accumulatedTimingSampleCount != nullptr)
        *accumulatedTimingSampleCount = capture.accumulatedTimingSampleCount;
    if (accumulatorOverflowDrops != nullptr)
        *accumulatorOverflowDrops = capture.accumulatorOverflowDrops;

    RealtimeDiagnosticsSnapshot snapshot = getRealtimeDiagnosticsSnapshot();
    const auto& perf = capture.snapshot;
    const auto usToMs = [](double us) noexcept { return us / 1000.0; };

    snapshot.timingSequence = perf.counters.lastTimingSequence;
    snapshot.enabled = snapshot.enabled || perf.counters.enabled;
    snapshot.blockCount = perf.mixBlock.count;
    snapshot.audioCallbackCount = perf.callback.count;
    snapshot.lastBlockSize = perf.counters.lastBlockSize > 0
        ? static_cast<int>(perf.counters.lastBlockSize)
        : snapshot.lastBlockSize;
    snapshot.lastSampleRate = perf.counters.lastSampleRateMilliHz > 0
        ? static_cast<double>(perf.counters.lastSampleRateMilliHz) / 1000.0
        : snapshot.lastSampleRate;
    snapshot.lastDeadlineMs = perf.counters.lastDeadlineUs > 0
        ? usToMs(static_cast<double>(perf.counters.lastDeadlineUs))
        : snapshot.lastDeadlineMs;

    if (perf.mixBlock.count > 0)
    {
        snapshot.avgProcessBlockMs = usToMs(perf.mixBlock.averageUs);
        snapshot.p50ProcessBlockMs = usToMs(perf.mixBlock.p50Us);
        snapshot.p95ProcessBlockMs = usToMs(perf.mixBlock.p95Us);
        snapshot.p99ProcessBlockMs = usToMs(perf.mixBlock.p99Us);
        snapshot.maxProcessBlockMs = usToMs(perf.mixBlock.maxUs);
        snapshot.maxProcessBlockRatio =
            perf.counters.lastDeadlineUs > 0
                ? static_cast<double>(perf.mixBlock.maxUs)
                    / static_cast<double>(perf.counters.lastDeadlineUs)
                : snapshot.maxProcessBlockRatio;
    }
    if (perf.callback.count > 0)
    {
        snapshot.avgAudioCallbackMs = usToMs(perf.callback.averageUs);
        snapshot.p50AudioCallbackMs = usToMs(perf.callback.p50Us);
        snapshot.p95AudioCallbackMs = usToMs(perf.callback.p95Us);
        snapshot.p99AudioCallbackMs = usToMs(perf.callback.p99Us);
        snapshot.maxAudioCallbackMs = usToMs(perf.callback.maxUs);
        snapshot.maxAudioCallbackRatio =
            perf.counters.lastDeadlineUs > 0
                ? static_cast<double>(perf.callback.maxUs)
                    / static_cast<double>(perf.counters.lastDeadlineUs)
                : snapshot.maxAudioCallbackRatio;
    }

    snapshot.overBudgetBlockCount = perf.counters.overBudgetBlockCount;
    snapshot.overrunBlockCount = perf.counters.mixOverrunCount;
    snapshot.audioCallbackOverrunCount = perf.counters.callbackOverrunCount;
    snapshot.droppedTelemetrySamples = perf.counters.droppedTimingSamples;
    snapshot.chainLockMissCount = perf.counters.chainLockMissCount;
    snapshot.chainSnapshotMissingCount = perf.counters.chainSnapshotMissingCount;
    snapshot.masterChainSkippedCount = perf.counters.masterChainSkippedCount;
    snapshot.trackChainSkippedCount = perf.counters.trackChainSkippedCount;
    snapshot.staleSnapshotReuseCount = perf.counters.staleSnapshotReuseCount;
    snapshot.guardedPluginCrashedSkippedCount =
        perf.counters.guardedPluginCrashedSkippedCount;
    snapshot.latencyEpochChangeCount = perf.counters.latencyEpochChangeCount;
    snapshot.pdcRetargetCount = perf.counters.compensationTargetChangeCount;
    snapshot.pdcDelayProcessCount = perf.counters.pdcDelayProcessCount;

    if (perf.trackChain.count > 0)
    {
        snapshot.avgTrackChainMs = usToMs(perf.trackChain.averageUs);
        snapshot.p95TrackChainMs = usToMs(perf.trackChain.p95Us);
        snapshot.p99TrackChainMs = usToMs(perf.trackChain.p99Us);
        snapshot.maxTrackChainMs = usToMs(perf.trackChain.maxUs);
    }
    if (perf.masterChain.count > 0)
    {
        snapshot.avgMasterChainMs = usToMs(perf.masterChain.averageUs);
        snapshot.p95MasterChainMs = usToMs(perf.masterChain.p95Us);
        snapshot.p99MasterChainMs = usToMs(perf.masterChain.p99Us);
        snapshot.maxMasterChainMs = usToMs(perf.masterChain.maxUs);
    }
    if (perf.pdcDelay.count > 0)
    {
        snapshot.avgPdcDelayMs = usToMs(perf.pdcDelay.averageUs);
        snapshot.p95PdcDelayMs = usToMs(perf.pdcDelay.p95Us);
        snapshot.p99PdcDelayMs = usToMs(perf.pdcDelay.p99Us);
        snapshot.maxPdcDelayMs = usToMs(perf.pdcDelay.maxUs);
    }
    if (perf.effect.count > 0)
    {
        snapshot.pluginCallCount = perf.effect.count;
        snapshot.avgPluginMs = usToMs(perf.effect.averageUs);
        snapshot.p95PluginMs = usToMs(perf.effect.p95Us);
        snapshot.p99PluginMs = usToMs(perf.effect.p99Us);
        snapshot.maxPluginMs = usToMs(perf.effect.maxUs);
    }

    snapshot.recentAudioCallbackUs = perf.recentCallbackDurationUs;
    snapshot.worstEffectsByMax = perf.worstEffectsByMax;
    snapshot.worstEffectsByP99 = perf.worstEffectsByP99;
    snapshot.worstChainsByMax = perf.worstChainsByMax;
    snapshot.worstChainsByP99 = perf.worstChainsByP99;

    snapshot.resonanceSuppressorWolaCallCount =
        perf.counters.resonanceSuppressorWolaCallCount;
    if (perf.effectSection.count > 0)
    {
        snapshot.avgResonanceSuppressorWolaMs = usToMs(perf.effectSection.averageUs);
        snapshot.p99ResonanceSuppressorWolaMs = usToMs(perf.effectSection.p99Us);
        snapshot.maxResonanceSuppressorWolaMs = usToMs(perf.effectSection.maxUs);
    }
    snapshot.resonanceSuppressorAudioThreadReprepareCount =
        perf.counters.resonanceSuppressorAudioThreadReprepareCount;
    snapshot.resonanceSuppressorDeferredReprepareCount =
        perf.counters.resonanceSuppressorDeferredReprepareCount;
    snapshot.nanInfBlockCount = perf.counters.nanInfBlockCount;

    if (snapshot.overrunBlockCount > 0 || snapshot.audioCallbackOverrunCount > 0)
        snapshot.diagnosis = "realtime_cpu_overrun";
    else if (snapshot.blockCount > 0 && snapshot.pdcRetargetCount > (snapshot.blockCount / 4))
        snapshot.diagnosis = "pdc_target_churn";
    else if (snapshot.chainLockMissCount > 0)
        snapshot.diagnosis = "chain_lock_contention";
    else if (snapshot.overBudgetBlockCount > 0)
        snapshot.diagnosis = "realtime_cpu_margin_risk";
    else
        snapshot.diagnosis = "no_realtime_instability_observed";

    const double safeWolaMs = snapshot.lastDeadlineMs * 0.70;
    snapshot.highQualityResonanceSuppressorRealtimeSafe =
        snapshot.resonanceSuppressorWolaCallCount > 0
        && snapshot.maxResonanceSuppressorWolaMs <= safeWolaMs
        && snapshot.resonanceSuppressorAudioThreadReprepareCount == 0
        && snapshot.overrunBlockCount == 0;

    xleth::audio::RealtimeRsHqRiskInputs rsHqInputs;
    rsHqInputs.sampleRate = snapshot.lastSampleRate;
    rsHqInputs.blockSize = static_cast<std::uint32_t>(std::max(0, snapshot.lastBlockSize));
    rsHqInputs.offlineOrExport = nonRealtime_.load(std::memory_order_relaxed);
    rsHqInputs.activeHighQualityInstanceCount =
        static_cast<std::uint32_t>(
            std::max(0, snapshot.activeResonanceSuppressorHighQualityInstanceCount));
    rsHqInputs.counters = perf.counters;
    rsHqInputs.callback = perf.callback;
    rsHqInputs.mixBlock = perf.mixBlock;
    rsHqInputs.resonanceSuppressorWola = perf.effectSection;
    const auto rsHqRisk =
        xleth::audio::AudioPerformanceTelemetry::classifyRealtimeRsHqRisk(rsHqInputs);
    snapshot.activeResonanceSuppressorHighQualityInstanceCount =
        static_cast<int>(rsHqRisk.activeResonanceSuppressorHighQualityInstanceCount);
    snapshot.realtimeRsHqRiskLevel = rsHqRisk.realtimeRsHqRiskLevel;
    snapshot.realtimeRsHqRiskReasons = rsHqRisk.realtimeRsHqRiskReasons;
    snapshot.recommendedAction = rsHqRisk.recommendedAction;

    return snapshot;
}

int MixEngine::countActiveResonanceSuppressorHighQualityInstancesLocked() const
{
    int count = 0;
    for (const auto& [trackId, chain] : effectChains_)
    {
        juce::ignoreUnused(trackId);
        if (chain)
            count += chain->countActiveResonanceSuppressorHighQualityInstances();
    }
    if (masterEffectChain_)
        count += masterEffectChain_->countActiveResonanceSuppressorHighQualityInstances();
    return count;
}

std::string MixEngine::getRealtimeDiagnosticsJSON() const
{
    const auto snapshot = getRealtimeDiagnosticsSnapshot();
    nlohmann::json j;
    j["enabled"] = snapshot.enabled;
    j["blockCount"] = snapshot.blockCount;
    j["audioCallbackCount"] = snapshot.audioCallbackCount;
    j["lastBlockSize"] = snapshot.lastBlockSize;
    j["lastSampleRate"] = snapshot.lastSampleRate;
    j["lastDeadlineMs"] = snapshot.lastDeadlineMs;
    j["avgProcessBlockMs"] = snapshot.avgProcessBlockMs;
    j["p50ProcessBlockMs"] = snapshot.p50ProcessBlockMs;
    j["p95ProcessBlockMs"] = snapshot.p95ProcessBlockMs;
    j["p99ProcessBlockMs"] = snapshot.p99ProcessBlockMs;
    j["maxProcessBlockMs"] = snapshot.maxProcessBlockMs;
    j["avgProcessBlockRatio"] = snapshot.avgProcessBlockRatio;
    j["maxProcessBlockRatio"] = snapshot.maxProcessBlockRatio;
    j["avgAudioCallbackMs"] = snapshot.avgAudioCallbackMs;
    j["p50AudioCallbackMs"] = snapshot.p50AudioCallbackMs;
    j["p95AudioCallbackMs"] = snapshot.p95AudioCallbackMs;
    j["p99AudioCallbackMs"] = snapshot.p99AudioCallbackMs;
    j["maxAudioCallbackMs"] = snapshot.maxAudioCallbackMs;
    j["maxAudioCallbackRatio"] = snapshot.maxAudioCallbackRatio;
    j["overBudgetBlockCount"] = snapshot.overBudgetBlockCount;
    j["overrunBlockCount"] = snapshot.overrunBlockCount;
    j["audioCallbackOverrunCount"] = snapshot.audioCallbackOverrunCount;
    j["droppedTelemetrySamples"] = snapshot.droppedTelemetrySamples;
    j["chainLockMissCount"] = snapshot.chainLockMissCount;
    j["chainSnapshotMissingCount"] = snapshot.chainSnapshotMissingCount;
    j["masterChainSkippedCount"] = snapshot.masterChainSkippedCount;
    j["trackChainSkippedCount"] = snapshot.trackChainSkippedCount;
    j["staleSnapshotReuseCount"] = snapshot.staleSnapshotReuseCount;
    j["guardedPluginCrashedSkippedCount"] = snapshot.guardedPluginCrashedSkippedCount;
    j["latencyEpochChangeCount"] = snapshot.latencyEpochChangeCount;
    j["pdcRetargetCount"] = snapshot.pdcRetargetCount;
    j["pdcDelayProcessCount"] = snapshot.pdcDelayProcessCount;
    j["avgTrackProcessMs"] = snapshot.avgTrackProcessMs;
    j["maxTrackProcessMs"] = snapshot.maxTrackProcessMs;
    j["worstTrackId"] = snapshot.worstTrackId;
    j["avgTrackChainMs"] = snapshot.avgTrackChainMs;
    j["p95TrackChainMs"] = snapshot.p95TrackChainMs;
    j["p99TrackChainMs"] = snapshot.p99TrackChainMs;
    j["maxTrackChainMs"] = snapshot.maxTrackChainMs;
    j["worstTrackChainId"] = snapshot.worstTrackChainId;
    j["avgMasterChainMs"] = snapshot.avgMasterChainMs;
    j["p95MasterChainMs"] = snapshot.p95MasterChainMs;
    j["p99MasterChainMs"] = snapshot.p99MasterChainMs;
    j["maxMasterChainMs"] = snapshot.maxMasterChainMs;
    j["avgPdcDelayMs"] = snapshot.avgPdcDelayMs;
    j["p95PdcDelayMs"] = snapshot.p95PdcDelayMs;
    j["p99PdcDelayMs"] = snapshot.p99PdcDelayMs;
    j["maxPdcDelayMs"] = snapshot.maxPdcDelayMs;
    j["pluginCallCount"] = snapshot.pluginCallCount;
    j["avgPluginMs"] = snapshot.avgPluginMs;
    j["p95PluginMs"] = snapshot.p95PluginMs;
    j["p99PluginMs"] = snapshot.p99PluginMs;
    j["maxPluginMs"] = snapshot.maxPluginMs;
    j["worstPluginId"] = snapshot.worstPluginId;
    j["worstPluginTrackId"] = snapshot.worstPluginTrackId;
    j["worstPluginNodeId"] = snapshot.worstPluginNodeId;
    j["recentAudioCallbackUs"] = snapshot.recentAudioCallbackUs;
    auto encodeWorst = [](const std::vector<xleth::audio::AudioTelemetryWorstScope>& scopes) {
        nlohmann::json arr = nlohmann::json::array();
        for (const auto& scope : scopes)
        {
            nlohmann::json item;
            item["kind"] = static_cast<int>(scope.kind);
            item["effectType"] = scope.effectType;
            item["effectTypeName"] =
                xleth::audio::AudioPerformanceTelemetry::effectTypeName(scope.effectType);
            item["flags"] = scope.flags;
            item["trackId"] = scope.trackId;
            item["slotOrNodeId"] = scope.slotOrNodeId;
            item["count"] = scope.timing.count;
            item["p99Us"] = scope.timing.p99Us;
            item["maxUs"] = scope.timing.maxUs;
            arr.push_back(std::move(item));
        }
        return arr;
    };
    j["worstEffectsByMax"] = encodeWorst(snapshot.worstEffectsByMax);
    j["worstEffectsByP99"] = encodeWorst(snapshot.worstEffectsByP99);
    j["worstChainsByMax"] = encodeWorst(snapshot.worstChainsByMax);
    j["worstChainsByP99"] = encodeWorst(snapshot.worstChainsByP99);
    j["avgResonanceSuppressorMs"] = snapshot.avgResonanceSuppressorMs;
    j["maxResonanceSuppressorMs"] = snapshot.maxResonanceSuppressorMs;
    j["avgResonanceSuppressorWolaMs"] = snapshot.avgResonanceSuppressorWolaMs;
    j["p99ResonanceSuppressorWolaMs"] = snapshot.p99ResonanceSuppressorWolaMs;
    j["maxResonanceSuppressorWolaMs"] = snapshot.maxResonanceSuppressorWolaMs;
    j["resonanceSuppressorWolaCallCount"] = snapshot.resonanceSuppressorWolaCallCount;
    j["resonanceSuppressorAudioThreadReprepareCount"] =
        snapshot.resonanceSuppressorAudioThreadReprepareCount;
    j["resonanceSuppressorDeferredReprepareCount"] =
        snapshot.resonanceSuppressorDeferredReprepareCount;
    j["nanInfBlockCount"] = snapshot.nanInfBlockCount;
    j["diagnosis"] = snapshot.diagnosis;
    j["highQualityResonanceSuppressorRealtimeSafe"] =
        snapshot.highQualityResonanceSuppressorRealtimeSafe;
    j["activeResonanceSuppressorHighQualityInstanceCount"] =
        snapshot.activeResonanceSuppressorHighQualityInstanceCount;
    j["realtimeRsHqRiskLevel"] = snapshot.realtimeRsHqRiskLevel;
    j["realtimeRsHqRiskReasons"] = snapshot.realtimeRsHqRiskReasons;
    j["recommendedAction"] = snapshot.recommendedAction;
    return j.dump();
}

uint64_t MixEngine::realtimeDeadlineNs(int numSamples, double sampleRate) const noexcept
{
    const uint64_t overrideNs = realtimeDeadlineOverrideNs_.load(std::memory_order_relaxed);
    return overrideNs > 0 ? overrideNs : deadlineNsFor(numSamples, sampleRate);
}

void MixEngine::recordAudioCallbackTiming(int numSamples, double sampleRate, uint64_t elapsedNs)
{
    if (!isRealtimeDiagnosticsEnabled())
        return;

    const uint64_t deadlineNs = realtimeDeadlineNs(numSamples, sampleRate);
    const uint64_t ratio = ratioPermille(elapsedNs, deadlineNs);

    realtimeDiagnostics_.audioCallbackCount.fetch_add(1, std::memory_order_relaxed);
    realtimeDiagnostics_.totalAudioCallbackNs.fetch_add(elapsedNs, std::memory_order_relaxed);
    atomicMax(realtimeDiagnostics_.maxAudioCallbackNs, elapsedNs);
    atomicMax(realtimeDiagnostics_.maxAudioCallbackRatioPermille, ratio);
    if (deadlineNs > 0 && elapsedNs >= deadlineNs)
        realtimeDiagnostics_.audioCallbackOverrunCount.fetch_add(1, std::memory_order_relaxed);

    recordTelemetryTiming(xleth::audio::AudioTelemetrySampleKind::AudioCallback,
                          -1,
                          -1,
                          xleth::audio::kAudioTelemetryEffectUnknown,
                          xleth::audio::kAudioTelemetryFlagNone,
                          numSamples,
                          sampleRate,
                          elapsedNs);
}

void MixEngine::realtimePluginTimingCallback(void* userData, const char* pluginId,
                                             int trackId, int nodeId, uint64_t elapsedNs)
{
    if (auto* engine = static_cast<MixEngine*>(userData))
        engine->recordRealtimePluginTiming(pluginId, trackId, nodeId, elapsedNs);
}

void MixEngine::realtimeSectionTimingCallback(void* userData, const char* pluginId,
                                              const char* sectionId, int trackId,
                                              int nodeId, uint64_t elapsedNs)
{
    if (auto* engine = static_cast<MixEngine*>(userData))
        engine->recordRealtimeSectionTiming(pluginId, sectionId, trackId, nodeId, elapsedNs);
}

void MixEngine::realtimeEventCallback(void* userData, const char* pluginId,
                                      const char* eventId, int trackId, int nodeId)
{
    if (auto* engine = static_cast<MixEngine*>(userData))
        engine->recordRealtimeEvent(pluginId, eventId, trackId, nodeId);
}

void MixEngine::recordRealtimePluginTiming(const char* pluginId, int trackId,
                                           int nodeId, uint64_t elapsedNs) noexcept
{
    if (!realtimeDiagnostics_.enabled.load(std::memory_order_relaxed))
        return;

    realtimeDiagnostics_.pluginCallCount.fetch_add(1, std::memory_order_relaxed);
    realtimeDiagnostics_.totalPluginNs.fetch_add(elapsedNs, std::memory_order_relaxed);
    if (atomicMaxWithWinner(realtimeDiagnostics_.maxPluginNs, elapsedNs))
    {
        realtimeDiagnostics_.worstPluginTrackId.store(trackId, std::memory_order_relaxed);
        realtimeDiagnostics_.worstPluginNodeId.store(nodeId, std::memory_order_relaxed);
    }

    const uint32_t effectType =
        xleth::audio::AudioPerformanceTelemetry::effectTypeFromPluginId(pluginId);
    const uint32_t flags =
        xleth::audio::AudioPerformanceTelemetry::flagsFromPluginId(pluginId);
    recordTelemetryTiming(xleth::audio::AudioTelemetrySampleKind::Effect,
                          trackId,
                          nodeId,
                          effectType,
                          flags,
                          0,
                          0.0,
                          elapsedNs);

    if (isResonanceSuppressorPlugin(pluginId))
    {
        realtimeDiagnostics_.resonanceSuppressorCallCount.fetch_add(1, std::memory_order_relaxed);
        realtimeDiagnostics_.totalResonanceSuppressorNs.fetch_add(elapsedNs, std::memory_order_relaxed);
        atomicMax(realtimeDiagnostics_.maxResonanceSuppressorNs, elapsedNs);
    }
}

void MixEngine::recordRealtimeSectionTiming(const char* pluginId, const char* sectionId,
                                            int trackId, int nodeId, uint64_t elapsedNs) noexcept
{
    juce::ignoreUnused(trackId, nodeId);
    if (!realtimeDiagnostics_.enabled.load(std::memory_order_relaxed))
        return;

    if (isResonanceSuppressorPlugin(pluginId) && isSection(sectionId, "rs_wola"))
    {
        realtimeDiagnostics_.resonanceSuppressorWolaCallCount.fetch_add(1, std::memory_order_relaxed);
        realtimeDiagnostics_.totalResonanceSuppressorWolaNs.fetch_add(elapsedNs, std::memory_order_relaxed);
        atomicMax(realtimeDiagnostics_.maxResonanceSuppressorWolaNs, elapsedNs);
    }

    recordTelemetryTiming(xleth::audio::AudioTelemetrySampleKind::EffectSection,
                          trackId,
                          nodeId,
                          xleth::audio::AudioPerformanceTelemetry::effectTypeFromPluginId(pluginId),
                          xleth::audio::AudioPerformanceTelemetry::flagsFromPluginId(pluginId)
                              | xleth::audio::AudioPerformanceTelemetry::flagsFromSectionId(sectionId),
                          0,
                          0.0,
                          elapsedNs);
}

void MixEngine::recordRealtimeEvent(const char* pluginId, const char* eventId,
                                    int trackId, int nodeId) noexcept
{
    juce::ignoreUnused(trackId, nodeId);
    if (!realtimeDiagnostics_.enabled.load(std::memory_order_relaxed))
    {
        return;
    }

    if (isSection(eventId, "guarded_plugin_crashed_skipped"))
    {
        audioPerformanceTelemetry_.incrementGuardedPluginCrashedSkipped();
        return;
    }

    if (!isResonanceSuppressorPlugin(pluginId))
        return;

    if (isSection(eventId, "rs_audio_thread_reprepare_blocked"))
    {
        realtimeDiagnostics_.resonanceSuppressorAudioThreadReprepareCount.fetch_add(
            1, std::memory_order_relaxed);
        audioPerformanceTelemetry_.incrementResonanceSuppressorAudioThreadReprepare();
    }
    else if (isSection(eventId, "rs_hq_reprepare_deferred"))
    {
        realtimeDiagnostics_.resonanceSuppressorDeferredReprepareCount.fetch_add(
            1, std::memory_order_relaxed);
        audioPerformanceTelemetry_.incrementResonanceSuppressorDeferredReprepare();
    }
}

void MixEngine::recordProcessBlockTiming(int numSamples, double sampleRate,
                                         uint64_t elapsedNs) noexcept
{
    if (!realtimeDiagnostics_.enabled.load(std::memory_order_relaxed))
        return;

    const uint64_t deadlineNs = realtimeDeadlineNs(numSamples, sampleRate);
    const uint64_t ratio = ratioPermille(elapsedNs, deadlineNs);

    realtimeDiagnostics_.blockCount.fetch_add(1, std::memory_order_relaxed);
    realtimeDiagnostics_.totalProcessNs.fetch_add(elapsedNs, std::memory_order_relaxed);
    realtimeDiagnostics_.totalDeadlineNs.fetch_add(deadlineNs, std::memory_order_relaxed);
    atomicMax(realtimeDiagnostics_.maxProcessNs, elapsedNs);
    atomicMax(realtimeDiagnostics_.maxRatioPermille, ratio);

    realtimeDiagnostics_.lastBlockSize.store(numSamples, std::memory_order_relaxed);
    realtimeDiagnostics_.lastSampleRateMilliHz.store(
        sampleRate > 0.0 && std::isfinite(sampleRate)
            ? static_cast<uint64_t>(sampleRate * 1000.0)
            : 0,
        std::memory_order_relaxed);
    realtimeDiagnostics_.lastDeadlineNs.store(deadlineNs, std::memory_order_relaxed);

    if (deadlineNs > 0 && ratio >= 700)
        realtimeDiagnostics_.overBudgetBlockCount.fetch_add(1, std::memory_order_relaxed);
    if (deadlineNs > 0 && elapsedNs >= deadlineNs)
        realtimeDiagnostics_.overrunBlockCount.fetch_add(1, std::memory_order_relaxed);

    recordTelemetryTiming(xleth::audio::AudioTelemetrySampleKind::MixBlock,
                          -1,
                          -1,
                          xleth::audio::kAudioTelemetryEffectUnknown,
                          xleth::audio::kAudioTelemetryFlagNone,
                          numSamples,
                          sampleRate,
                          elapsedNs);
}

void MixEngine::recordTrackProcessTiming(int trackId, uint64_t elapsedNs) noexcept
{
    if (!realtimeDiagnostics_.enabled.load(std::memory_order_relaxed))
        return;

    realtimeDiagnostics_.trackProcessCount.fetch_add(1, std::memory_order_relaxed);
    realtimeDiagnostics_.totalTrackProcessNs.fetch_add(elapsedNs, std::memory_order_relaxed);
    if (atomicMaxWithWinner(realtimeDiagnostics_.maxTrackProcessNs, elapsedNs))
        realtimeDiagnostics_.worstTrackId.store(trackId, std::memory_order_relaxed);

    recordTelemetryTiming(xleth::audio::AudioTelemetrySampleKind::TrackRender,
                          trackId,
                          -1,
                          xleth::audio::kAudioTelemetryEffectUnknown,
                          xleth::audio::kAudioTelemetryFlagNone,
                          0,
                          0.0,
                          elapsedNs);
}

void MixEngine::recordTrackChainTiming(int trackId, uint64_t elapsedNs) noexcept
{
    if (!realtimeDiagnostics_.enabled.load(std::memory_order_relaxed))
        return;

    realtimeDiagnostics_.trackChainProcessCount.fetch_add(1, std::memory_order_relaxed);
    realtimeDiagnostics_.totalTrackChainNs.fetch_add(elapsedNs, std::memory_order_relaxed);
    if (atomicMaxWithWinner(realtimeDiagnostics_.maxTrackChainNs, elapsedNs))
        realtimeDiagnostics_.worstTrackChainId.store(trackId, std::memory_order_relaxed);

    recordTelemetryTiming(trackId < 0
                              ? xleth::audio::AudioTelemetrySampleKind::MasterChain
                              : xleth::audio::AudioTelemetrySampleKind::TrackChain,
                          trackId,
                          -1,
                          xleth::audio::kAudioTelemetryEffectUnknown,
                          trackId < 0 ? xleth::audio::kAudioTelemetryFlagMaster
                                      : xleth::audio::kAudioTelemetryFlagNone,
                          0,
                          0.0,
                          elapsedNs);
}

void MixEngine::recordPdcDelayTiming(uint64_t elapsedNs) noexcept
{
    if (!realtimeDiagnostics_.enabled.load(std::memory_order_relaxed))
        return;

    realtimeDiagnostics_.pdcDelayProcessCount.fetch_add(1, std::memory_order_relaxed);
    realtimeDiagnostics_.totalPdcDelayNs.fetch_add(elapsedNs, std::memory_order_relaxed);
    atomicMax(realtimeDiagnostics_.maxPdcDelayNs, elapsedNs);

    recordTelemetryTiming(xleth::audio::AudioTelemetrySampleKind::PdcDelay,
                          -1,
                          -1,
                          xleth::audio::kAudioTelemetryEffectUnknown,
                          xleth::audio::kAudioTelemetryFlagNone,
                          0,
                          0.0,
                          elapsedNs);
}

void MixEngine::recordPdcRetarget() noexcept
{
    if (realtimeDiagnostics_.enabled.load(std::memory_order_relaxed))
    {
        realtimeDiagnostics_.pdcRetargetCount.fetch_add(1, std::memory_order_relaxed);
        audioPerformanceTelemetry_.incrementCompensationTargetChange();
    }
}

void MixEngine::recordTelemetryTiming(xleth::audio::AudioTelemetrySampleKind kind,
                                      int trackId,
                                      int slotOrNodeId,
                                      uint32_t effectType,
                                      uint32_t flags,
                                      int numSamples,
                                      double sampleRate,
                                      uint64_t elapsedNs,
                                      uint64_t latencyEpoch,
                                      int compensationSamples) noexcept
{
    if (!audioPerformanceTelemetry_.isEnabled())
        return;

    xleth::audio::AudioTelemetryTimingSample sample;
    sample.kind = kind;
    sample.trackId = trackId;
    sample.slotOrNodeId = slotOrNodeId;
    sample.effectType = effectType;
    sample.flags = flags;
    sample.blockSize = numSamples > 0 ? static_cast<uint32_t>(numSamples) : 0;
    sample.sampleRateMilliHz =
        sampleRate > 0.0 && std::isfinite(sampleRate)
            ? static_cast<uint64_t>(sampleRate * 1000.0)
            : 0;
    sample.deadlineUs =
        sample.blockSize > 0 && sample.sampleRateMilliHz > 0
            ? static_cast<uint32_t>(
                  std::max<double>(
                      0.0,
                      (static_cast<double>(sample.blockSize) / sampleRate)
                          * 1000000.0))
            : 0;
    // Callback-level samples are judged against the device's real deadline (the
    // WASAPI shared engine period), not blockSize / sampleRate. Per-effect /
    // per-track samples carry no block size and so no deadline of their own.
    if (sample.deadlineUs > 0
        && (kind == xleth::audio::AudioTelemetrySampleKind::AudioCallback
            || kind == xleth::audio::AudioTelemetrySampleKind::MixBlock))
    {
        const uint64_t overrideNs =
            realtimeDeadlineOverrideNs_.load(std::memory_order_relaxed);
        if (overrideNs > 0)
        {
            const uint64_t overrideUs = (overrideNs + 500u) / 1000u;
            sample.deadlineUs = overrideUs > UINT32_MAX
                ? UINT32_MAX
                : static_cast<uint32_t>(overrideUs);
        }
    }
    const uint64_t elapsedUs = (elapsedNs + 999u) / 1000u;
    sample.durationUs = elapsedUs > UINT32_MAX
        ? UINT32_MAX
        : static_cast<uint32_t>(elapsedUs);
    sample.latencyEpoch = latencyEpoch;
    sample.compensationSamples = compensationSamples;
    audioPerformanceTelemetry_.recordTimingFromAudioThread(sample);
}

void MixEngine::runCoordinatorReaper()
{
    while (true)
    {
        std::unique_ptr<EditorProcessCoordinator> toDestroy;
        {
            std::unique_lock<std::mutex> lock(reaperMutex_);
            reaperCv_.wait(lock, [this] {
                return reaperStop_.load() || !reaperQueue_.empty();
            });
            if (reaperStop_.load() && reaperQueue_.empty())
                return;
            toDestroy = std::move(reaperQueue_.front());
            reaperQueue_.pop_front();
        }
        auto t0 = std::chrono::high_resolution_clock::now();
        toDestroy.reset(); // synchronous destruction — may block 8-10 s on dead IPC pipe
        double ms = std::chrono::duration<double, std::milli>(
            std::chrono::high_resolution_clock::now() - t0).count();
        std::fprintf(stderr,
            "[CloseProfile] reaper destroyed coordinator in %.0fms\n", ms);
        std::fflush(stderr);
    }
}

void MixEngine::reapCoordinator(std::unique_ptr<EditorProcessCoordinator> dying)
{
    if (!dying) return;
    {
        std::lock_guard<std::mutex> lock(reaperMutex_);
        reaperQueue_.push_back(std::move(dying));
    }
    reaperCv_.notify_one();
}

// ── Plugin registry ───────────────────────────────────────────────────────────

PluginRegistry& MixEngine::getPluginRegistry()
{
    return *pluginRegistry_;
}

// ── Plugin editor host ────────────────────────────────────────────────────────

void MixEngine::setEditorHostExe(const std::string& exePath)
{
    editorHostExePath_ = exePath;
}

void MixEngine::setMainWindowHandle(uintptr_t hwnd)
{
    mainWindowHwnd_.store(hwnd);
    std::fprintf(stderr, "[EditorFlow] Main window handle stored: 0x%llX\n",
                 (unsigned long long)hwnd);
}

bool MixEngine::openPluginEditor(int trackId, int nodeId)
{
    // Close-path profiling: measure how long after CLSD_received the next open
    // arrives. Only logged when a close actually happened (flag set in CLSD handler).
    if (g_closeProfileActive)
    {
        CPLOG("new_open_arrived");
        g_closeProfileActive = false;

        // Check whether the old coordinator is still in the map.
        // If it is, onClosed_ has not fired yet — cleanup is still pending,
        // and the new open will race with the deferred teardown.
        const auto probeKey = std::make_pair(trackId, nodeId);
        std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
        auto it = vstEditorCoordinators_.find(probeKey);
        if (it != vstEditorCoordinators_.end())
        {
            std::fprintf(stderr,
                "[CloseProfile] WARNING old coordinator STILL IN MAP for "
                "track=%d node=%d isEditorClosed=%d — onClosed_ not yet fired\n",
                trackId, nodeId, (int)it->second->isEditorClosed());
        }
        else
        {
            std::fprintf(stderr,
                "[CloseProfile] map.find() = end — old coordinator already "
                "removed (onClosed_ fired before new open)\n");
        }
    }

    // Fetch the processor and plugin file path under lock, then release before
    // touching the GUI. Holding chainsMutex_ while creating a window is forbidden.
    lastEditorOpenError_.clear();
    juce::AudioProcessor*   proc = nullptr;
    juce::String            pluginFilePath;
    juce::PluginDescription pluginDesc;          // INIT v2: the exact plugin to open
    bool                    haveDesc = false;
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        ChainSnapshotPublisher chainSnapshotPublisher{this};
        EffectChainManager* chain = nullptr;
        if (trackId == -1)
        {
            chain = masterEffectChain_.get();
        }
        else
        {
            auto it = effectChains_.find(trackId);
            if (it != effectChains_.end()) chain = it->second.get();
        }
        if (chain)
        {
            proc           = chain->getProcessor(nodeId);
            pluginFilePath = chain->getPluginFilePath(nodeId);
            haveDesc       = chain->getPluginDescription(nodeId, pluginDesc);
        }
    }

    if (!proc) return false;

    // ── Route: VST node → out-of-process editor ──────────────────────────────
    auto* wrapper = dynamic_cast<GuardedPluginWrapper*>(proc);
    if (wrapper && pluginFilePath.isNotEmpty())
    {
        const auto key = std::make_pair(trackId, nodeId);

        // Already open and alive — nothing to do.
        {
            std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
            auto it = vstEditorCoordinators_.find(key);
            if (it != vstEditorCoordinators_.end() && !it->second->isEditorClosed())
            {
                std::fprintf(stderr,
                    "[EditorFlow] VST editor already open: track=%d node=%d\n",
                    trackId, nodeId);
                return true;
            }
            vstEditorCoordinators_.erase(key);  // remove stale closed entry if any
        }

        // Validate editor-host exe.
        const juce::File editorHostExe{juce::String(editorHostExePath_)};
        if (!editorHostExe.existsAsFile())
        {
            std::fprintf(stderr,
                "[EditorFlow] xleth-editor-host.exe not found at: %s\n",
                editorHostExe.getFullPathName().toRawUTF8());
            lastEditorOpenError_ = "editor-host-missing";
            return false;
        }
        if (!haveDesc)
        {
            std::fprintf(stderr,
                "[EditorFlow] no PluginDescription for track=%d node=%d - cannot open editor\n",
                trackId, nodeId);
            lastEditorOpenError_ = "no-description";
            return false;
        }

        // Serialize current plugin state for the editor process.
        juce::MemoryBlock stateBlock;
        proc->getStateInformation(stateBlock);
        juce::String stateBase64;
        if (stateBlock.getSize() > 0)
        {
            juce::MemoryOutputStream mos;
            juce::Base64::convertToBase64(mos, stateBlock.getData(), stateBlock.getSize());
            stateBase64 = mos.toString();
        }

        // Extract the inner AudioPluginInstance for bidirectional param sync.
        // The coordinator will attach a listener to it. nullptr disables sync.
        auto* pluginInstance =
            dynamic_cast<juce::AudioPluginInstance*>(wrapper->getInner());

        // Create coordinator and wire close callback.
        auto coord = std::make_unique<EditorProcessCoordinator>(pluginInstance, wrapper);

        coord->onWorkerPluginMutated_ = [this, key](std::uint64_t latencyPublishCountBefore)
        {
            refreshGuardedPluginLatency(key.first, key.second, latencyPublishCountBefore);
        };

        coord->onClosed_ = [this, key, wrapper]()
        {
            // This lambda was dispatched via callAsync. The elapsed shown here
            // vs. before_onClosed_callback_invoked reveals Win32 message-queue
            // latency in the addon-worker process (prime suspect for 6 s gap).
            CPLOG("on_closed_callback_start");
            std::fprintf(stderr,
                "[EditorFlow] VST editor closed (CLSD/ERR_): track=%d node=%d\n",
                key.first, key.second);

            // Tear down the worker-side audio ring first (editor-host is gone).
            CPLOG("before_disable_ring");
            if (wrapper) wrapper->disableAudioStream();
            CPLOG("after_disable_ring");

            // Extract the coordinator from the map without destroying it yet,
            // so the destructor (which may block in stopThread) runs OUTSIDE
            // the mutex and can be timed independently.
            std::unique_ptr<EditorProcessCoordinator> dying;
            CPLOG("before_erase_from_coordinator_map");
            {
                std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
                auto it = vstEditorCoordinators_.find(key);
                if (it != vstEditorCoordinators_.end())
                {
                    dying = std::move(it->second);   // take ownership; map entry now null
                    vstEditorCoordinators_.erase(it); // remove the (now-empty) entry
                    std::fprintf(stderr,
                        "[CloseProfile] map_erased trackId=%d nodeId=%d\n",
                        key.first, key.second);
                    std::fflush(stderr);
                }
            } // vstEditorCoordinatorsMutex_ released here
            CPLOG("after_erase_from_coordinator_map");

            // Hand destruction to the reaper thread. We are currently executing on
            // the coordinator's own IPC poll thread — destroying the coordinator
            // here would self-join (killWorkerProcess → stopThread → join self → deadlock).
            // The reaper is a distinct long-lived thread guaranteed never to be any
            // coordinator's poll thread.
            reapCoordinator(std::move(dying));
        };

        // Build parent HWND hex string for editor window parenting.
        juce::String parentHwndHex;
        const uintptr_t hwnd = mainWindowHwnd_.load();
        if (hwnd != 0)
        {
            char buf[32];
            std::snprintf(buf, sizeof(buf), "%llX", (unsigned long long)hwnd);
            parentHwndHex = juce::String(buf);
        }
        else
        {
            std::fprintf(stderr,
                "[EditorFlow] Warning: main window HWND not set — editor will be unparented\n");
        }

        // Launch editor-host process.
        std::fprintf(stderr,
            "[EditorFlow] Opening VST editor: track=%d node=%d plugin=%s parent=0x%s\n",
            trackId, nodeId, pluginFilePath.toRawUTF8(),
            parentHwndHex.isEmpty() ? "0" : parentHwndHex.toRawUTF8());

        // INIT v2 carries the engine's current rate/block so the editor-side
        // instance is created exactly like the worker's (no fixed 48000/480).
        const double initSr = preparedSampleRate_ > 0 ? (double)preparedSampleRate_ : 44100.0;
        const int    initBs = preparedBlockSize_ > 0 ? (int)preparedBlockSize_ : 512;
        if (!coord->start(editorHostExe, pluginDesc, initSr, initBs, stateBase64, parentHwndHex))
        {
            std::fprintf(stderr,
                "[EditorFlow] Failed to start editor process: track=%d node=%d\n",
                trackId, nodeId);
            lastEditorOpenError_ = "editor-host-error";
            return false;
        }

        // Poll for REDY (up to 5 s). The IPC poll thread sets editorReady_
        // directly (not via callAsync), so we can read it here safely.
        constexpr int kMaxWaitMs = 5000;
        constexpr int kPollMs    = 50;
        int waited = 0;
        while (!coord->isEditorReady() && !coord->isEditorClosed() && waited < kMaxWaitMs)
        {
            juce::Thread::sleep(kPollMs);
            waited += kPollMs;
        }

        if (!coord->isEditorReady())
        {
            std::fprintf(stderr,
                "[EditorFlow] Timed out waiting for editor ready: track=%d node=%d"
                " error='%s'\n",
                trackId, nodeId, coord->getErrorMessage().c_str());
            if (coord->isProtocolMismatch())
            {
                std::fprintf(stderr,
                    "[EditorHost] stale editor-host exe — rebuild (bridge-clean): %s\n",
                    editorHostExe.getFullPathName().toRawUTF8());
                lastEditorOpenError_ = "protocol-mismatch";
            }
            else
            {
                lastEditorOpenError_ = coord->isEditorClosed() ? "editor-host-error" : "timeout";
            }
            // Destroying a coordinator blocks for JUCE's IPC teardown (8 s
            // measured, P2 smoke 5). Detach it from the plugin here, on the
            // message thread, and let the reaper thread pay for the teardown
            // so a failed open returns at once.
            coord->setWorkerPlugin(nullptr);
            reapCoordinator(std::move(coord));
            return false;
        }

        std::fprintf(stderr,
            "[EditorFlow] VST editor ready: track=%d node=%d WxH=%dx%d\n",
            trackId, nodeId,
            coord->getEditorWidth(), coord->getEditorHeight());

        // ── Audio streaming: enable worker-side ring, then tell editor-host ──
        // Ordering: ring must exist before the editor-host tries to open it.
        // Construct name: "Xleth_AudioStream_T{trackId}_N{nodeId}".
        char shmBuf[96];
        std::snprintf(shmBuf, sizeof(shmBuf),
                      "Xleth_AudioStream_T%d_N%d", trackId, nodeId);
        const std::string shmName = shmBuf;
        const int streamSr = (int)(preparedSampleRate_ > 0 ? preparedSampleRate_ : 44100);
        const int streamBs =  preparedBlockSize_ > 0 ? preparedBlockSize_ : 512;

        wrapper->enableAudioStream(shmName, streamSr, streamBs);
        coord->sendStreamStart(shmName, streamSr, streamBs);

        {
            std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
            vstEditorCoordinators_[key] = std::move(coord);
        }
        return true;
    }

    // ── Route: stock effect → in-process DocumentWindow ─────────────────────
    return editorHost_->openEditor(proc, trackId, nodeId);
}

void MixEngine::closePluginEditor(int trackId, int nodeId)
{
    const auto key = std::make_pair(trackId, nodeId);

    // Step 1: ask the editor-host to stop its pump + releaseResources, BEFORE
    // destroying the worker-side ring (the editor-host is still reading it).
    // We hold a raw observer of the coordinator only under the map mutex; the
    // STOP send itself is OK from any thread (IPC pipe is thread-safe).
    EditorProcessCoordinator* observedCoord = nullptr;
    {
        std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
        auto it = vstEditorCoordinators_.find(key);
        if (it != vstEditorCoordinators_.end())
            observedCoord = it->second.get();
    }
    if (observedCoord) observedCoord->sendStreamStop();

    // Step 2: find the VST wrapper so we can tear down the worker-side ring.
    GuardedPluginWrapper* wrapper = nullptr;
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        ChainSnapshotPublisher chainSnapshotPublisher{this};
        EffectChainManager* chain = nullptr;
        if (trackId == -1)
        {
            chain = masterEffectChain_.get();
        }
        else
        {
            auto it = effectChains_.find(trackId);
            if (it != effectChains_.end()) chain = it->second.get();
        }
        if (chain)
            wrapper = dynamic_cast<GuardedPluginWrapper*>(chain->getProcessor(nodeId));
    }
    if (wrapper) wrapper->disableAudioStream();

    // Step 3: destroy the coordinator (closes IPC → editor-host quits).
    // Move out under the mutex, then destruct on a background thread to avoid
    // blocking the message thread if killWorkerProcess() stalls on a dead pipe.
    std::unique_ptr<EditorProcessCoordinator> dyingExplicit;
    {
        std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
        auto it = vstEditorCoordinators_.find(key);
        if (it != vstEditorCoordinators_.end())
        {
            dyingExplicit = std::move(it->second);
            vstEditorCoordinators_.erase(it);
        }
    }
    reapCoordinator(std::move(dyingExplicit));

    // Also close any in-process editor (stock effects).
    editorHost_->closeEditor(trackId, nodeId);
}

void MixEngine::closePluginEditorsForTrack(int trackId)
{
    // Collect nodeIds for this track under the map mutex, then tear down each
    // one individually via closePluginEditor so stream-stop ordering holds.
    std::vector<int> nodesToClose;
    {
        std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
        for (auto& kv : vstEditorCoordinators_)
            if (kv.first.first == trackId)
                nodesToClose.push_back(kv.first.second);
    }
    for (int nodeId : nodesToClose)
        closePluginEditor(trackId, nodeId);

    editorHost_->closeEditorsForTrack(trackId);
}

void MixEngine::closeAllPluginEditors()
{
    // Collect keys first, then tear down each one via the normal path so the
    // STOP → disable → destroy-coordinator ordering is preserved.
    std::vector<std::pair<int,int>> all;
    {
        std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
        all.reserve(vstEditorCoordinators_.size());
        for (auto& kv : vstEditorCoordinators_) all.push_back(kv.first);
    }
    for (auto& key : all) closePluginEditor(key.first, key.second);

    editorHost_->closeAllEditors();
}

bool MixEngine::isPluginEditorOpen(int trackId, int nodeId) const
{
    {
        std::lock_guard<std::mutex> lk(vstEditorCoordinatorsMutex_);
        auto it = vstEditorCoordinators_.find(std::make_pair(trackId, nodeId));
        if (it != vstEditorCoordinators_.end() && !it->second->isEditorClosed())
            return true;
    }
    return editorHost_->isEditorOpen(trackId, nodeId);
}

// ── Configuration ────────────────────────────────────────────────────────────

void MixEngine::setTimeline(const Timeline* timeline)
{
    timeline_ = timeline;
    // Force refreshTrackSnapshotIfNeeded()/findActiveClips() to rebuild on the
    // next block: a new Timeline instance's generation counters start back at
    // 0 and could otherwise coincidentally match the old instance's
    // last-seen value, leaving the caches pointing at the PREVIOUS
    // Timeline's tracks/clips.
    cachedTrackTopologyGeneration_ = ~static_cast<uint64_t>(0);
    cachedClipTopologyGeneration_  = ~static_cast<uint64_t>(0);
    clipScanLastBufferEnd_ = -1;
    syncTrackSlotsFromTimeline(false);
}

void MixEngine::setSampleBank(const SampleBank* bank)
{
    sampleBank_ = bank;
}

void MixEngine::publishRegionSampleMapLocked(RegionSampleMap next)
{
    auto previous = regionToSampleMap_.exchange(
        std::make_shared<const RegionSampleMap>(std::move(next)),
        std::memory_order_acq_rel);

    // Retire, never free here. An audio block may still hold `previous`; if it
    // dropped the last reference, the map's node frees would run on the
    // realtime thread. use_count()==1 proves only this list is left, and no new
    // reader can appear because the map is no longer reachable.
    if (previous)
        retiredRegionSampleMaps_.push_back(std::move(previous));
    retiredRegionSampleMaps_.erase(
        std::remove_if(retiredRegionSampleMaps_.begin(), retiredRegionSampleMaps_.end(),
                       [](const std::shared_ptr<const RegionSampleMap>& m)
                       { return m.use_count() == 1; }),
        retiredRegionSampleMaps_.end());
}

void MixEngine::mapRegionToSample(int regionId, int sampleBankId)
{
    std::lock_guard<std::mutex> lock(regionSampleMapWriteMutex_);
    RegionSampleMap next = *loadRegionSampleMap();
    next[regionId] = sampleBankId;
    publishRegionSampleMapLocked(std::move(next));
}

void MixEngine::clearRegionToSampleMap()
{
    std::lock_guard<std::mutex> lock(regionSampleMapWriteMutex_);
    publishRegionSampleMapLocked({});
}

void MixEngine::unmapRegion(int regionId)
{
    std::lock_guard<std::mutex> lock(regionSampleMapWriteMutex_);
    const auto current = loadRegionSampleMap();
    if (current->find(regionId) == current->end()) return;
    RegionSampleMap next = *current;
    next.erase(regionId);
    publishRegionSampleMapLocked(std::move(next));
}

int MixEngine::getSampleIdForRegion(int regionId) const
{
    const auto map = loadRegionSampleMap();
    auto it = map->find(regionId);
    return it != map->end() ? it->second : -1;
}

std::unordered_map<int, int> MixEngine::getRegionToSampleMapSnapshot() const
{
    return *loadRegionSampleMap();
}

// ── Per-slot sample mapping (main thread) ────────────────────────────────────

namespace {
// Flat key for slotSampleMap_. Slot 0 is never stored (it resolves through the
// region map), so the key space starts at slot 1.
inline int slotMapKey(int regionId, int slotIndex) {
    return regionId * MAX_SAMPLE_SLOTS + slotIndex;
}
} // namespace

void MixEngine::mapRegionSlotToSample(int regionId, int slotIndex, int sampleBankId)
{
    if (regionId < 0 || slotIndex <= 0 || slotIndex >= MAX_SAMPLE_SLOTS) return;
    slotSampleMap_[slotMapKey(regionId, slotIndex)] = sampleBankId;
}

int MixEngine::getSampleIdForRegionSlot(int regionId, int slotIndex) const
{
    // Slot 0 IS the region's audio — follows swaps automatically.
    if (slotIndex <= 0) return getSampleIdForRegion(regionId);
    auto it = slotSampleMap_.find(slotMapKey(regionId, slotIndex));
    return it != slotSampleMap_.end() ? it->second : -1;
}

void MixEngine::unmapRegionSlot(int regionId, int slotIndex)
{
    if (slotIndex <= 0) return;
    slotSampleMap_.erase(slotMapKey(regionId, slotIndex));
}

void MixEngine::unmapAllRegionSlots(int regionId)
{
    for (int i = 1; i < MAX_SAMPLE_SLOTS; ++i)
        slotSampleMap_.erase(slotMapKey(regionId, i));
}

// ── Sampler lifecycle (main thread) ──────────────────────────────────────────

std::unique_ptr<Sampler> MixEngine::buildSamplerForRegion(const SampleRegion& region)
{
    if (sampleBank_ == nullptr) return nullptr;

    auto s = std::make_unique<Sampler>();

    // ── Sampler-level (note-level) settings — unchanged by layering ──────────
    // The amp envelope, pitch envelope and the three per-note LFOs are gone as
    // dedicated region paths: the amp DAHDSR is now driven by modulation ENV 1
    // (applied inside setModulation below), and pitch/vol/pan modulation is
    // expressed as routes. A legacy project's old envelopes and LFOs arrive here
    // already converted to ENV 1 + routes by SampleRegion's load-time migration.
    s->setCrossfadeMode(region.crossfadeEnabled);
    s->setMonoMode(region.monoEnabled);
    s->setVoiceCount(region.voiceCount);
    s->setLegato(region.legatoEnabled);
    s->setPortamento(region.portamentoEnabled, region.portamentoTimeMs,
                     region.portamentoMode, region.portamentoCurve);
    s->setArpeggiator(region.arpEnabled, region.arpTempoSync, region.arpDivision,
                      region.arpFreeTimeMs, region.arpGate, region.arpRange,
                      region.arpDirection);
    // Modulation system. Compiles the route graph and publishes it; an empty
    // route list publishes nothing at all and costs the audio thread one null
    // pointer test per block. Also derives the amp VCA from ENV 1.
    s->setModulation(region.modulation);

    // ── Per-slot settings and PCM ────────────────────────────────────────────
    const int nSlots = std::min(region.slotCount(), MAX_SAMPLE_SLOTS);
    s->setSlotCount(nSlots);

    bool anyAudio = false;
    for (int i = 0; i < nSlots; ++i) {
        const SampleSlot& sl = region.slot(i);

        s->setSlotRootNote(i, sl.rootNote);
        s->setSlotTuning(i, sl.octave, sl.semitone, sl.fine, sl.coarse);
        s->setSlotLevel(i, sl.volume, sl.pan);
        s->setSlotMuteSolo(i, sl.mute, sl.solo);
        s->setSlotTrim(i, sl.smpStart, sl.smpLength, sl.declickMs,
                       sl.fadeInMs, sl.fadeOutMs);
        s->setSlotLoop(i, sl.loopEnabled, sl.loopStart, sl.loopEnd,
                       sl.crossfadeSamples, sl.loopMode, sl.exitLoopOnRelease);
        // MANGLE chain: convert the model instances to the engine's config and
        // publish the whole chain by one atomic swap.
        std::vector<xleth::mangle::InstanceConfig> mangleChain;
        mangleChain.reserve(sl.mangleChain.size());
        for (const auto& mi : sl.mangleChain)
            mangleChain.push_back({ mi.mode, mi.amount, mi.mix, mi.bypass });
        s->setSlotMangleChain(i, mangleChain);

        // Slot 0 resolves via the region map (and so follows audio swaps);
        // slots 1..7 use their own registered SampleBank id. A slot whose
        // audio has not been loaded yet simply stays silent — the sampler is
        // rebuilt once the load completes.
        const int bankId = getSampleIdForRegionSlot(region.id, i);
        if (bankId < 0) continue;
        const auto* buf = sampleBank_->getSample(bankId);
        if (buf == nullptr) continue;

        const auto info = sampleBank_->getSampleInfo(bankId);
        const double srcSR = info.originalSampleRate > 0.0
                           ? info.originalSampleRate
                           : 48000.0;

        juce::AudioBuffer<float> working(*buf);
        SampleProcessor::Flags fx{ sl.dcOffsetRemoved, sl.normalized,
                                   sl.polarityReversed, sl.reversed };
        SampleProcessor::applyFlags(working, fx);

        // The raw (post-destructive-flag) audio is always what the slot is
        // loaded with, so a slot with a pending or bypassed bake plays the
        // real sample rather than silence.
        s->loadSlotSample(i, working, srcSR, sl.rootNote);

        // ── PREP bake ────────────────────────────────────────────────────────
        // Bypassed at unity stretch and zero shift: no key, no hashing, no
        // cache entry, no copy — which is precisely what makes a project made
        // before PREP existed play bit-identically.
        if (!sl.prepIsBypassed() && slotBakeCache_ != nullptr) {
            const double bakeRate = info.bufferSampleRate > 0.0
                                  ? info.bufferSampleRate : srcSR;
            xleth::audio::BakeKey key;
            // Hashing the POST-flag PCM makes the destructive flags part of the
            // key without giving them their own fields.
            key.sourceHash   = xleth::audio::SlotBakeCache::hashPCM(working);
            key.algorithm    = sl.prepAlgorithm;
            key.stretchMilli = static_cast<int32_t>(std::lround(sl.prepStretch * 1000.0f));
            key.shiftCents   = static_cast<int32_t>(std::lround(sl.prepShiftCents));
            key.sampleRateHz = static_cast<int32_t>(std::lround(bakeRate));
            key.numChannels  = working.getNumChannels();

            const int mapKey = slotMapKey(region.id, i);
            if (auto baked = slotBakeCache_->lookup(key)) {
                // Resident (memory tier) — the slot plays the baked buffer from
                // its very first note, with no interim raw pass.
                s->setSlotPreparedBuffer(i, baked);
                publishedSlotBakes_[mapKey] = PreparedSlot{ baked, key.digest() };
                pendingSlotBakes_.erase(mapKey);
            } else {
                // Miss. Queue the bake (a disk hit is resolved on the worker,
                // so a reload after a restart still costs no DSP) and remember
                // the key so drainSlotBakes() can publish it when it lands.
                slotBakeCache_->submit(key, working);
                pendingSlotBakes_[mapKey] =
                    std::make_unique<xleth::audio::BakeKey>(key);
            }
        } else {
            // PREP off (or turned off) — drop any stale pending bake so the
            // drain does not later publish a buffer this slot no longer wants,
            // and release the previous bake so the editor goes back to
            // measuring and drawing the raw sample.
            const int mapKey = slotMapKey(region.id, i);
            pendingSlotBakes_.erase(mapKey);
            publishedSlotBakes_.erase(mapKey);
        }

        anyAudio = true;
    }

    // No slot has audio yet — nothing to play. Callers treat null as "skip".
    if (!anyAudio) return nullptr;
    return s;
}

// ── Per-slot PREP bake (main thread) ─────────────────────────────────────────

void MixEngine::setSlotBakeCacheDir(const std::string& dir)
{
    if (slotBakeCache_) slotBakeCache_->setCacheDir(dir);
}

void MixEngine::publishSlotBuffer(int regionId, int slotIndex,
                                  std::shared_ptr<const juce::AudioBuffer<float>> buffer)
{
    // Every sampler that plays this region gets the swap: the per-track
    // playback samplers and the preview sampler alike. Each swap is a single
    // atomic store inside the Sampler — no rebuild, so notes already sounding
    // keep their envelopes and simply start reading the new audio.
    const auto set = samplerSet_.load();
    for (auto& [key, sampler] : set->playback)
        if (key.regionId == regionId && sampler)
            sampler->setSlotPreparedBuffer(slotIndex, buffer);

    auto pv = set->preview.find(regionId);
    if (pv != set->preview.end() && pv->second && pv->second->sampler)
        pv->second->sampler->setSlotPreparedBuffer(slotIndex, buffer);
}

bool MixEngine::drainSlotBakes()
{
    if (!slotBakeCache_ || pendingSlotBakes_.empty()) return false;

    // Nothing has completed since the last drain — the common case, and the
    // reason this is cheap enough to call from a UI poll.
    const uint64_t epoch = slotBakeCache_->completionEpoch();
    if (epoch == lastBakeEpoch_) return false;
    lastBakeEpoch_ = epoch;

    bool changed = false;
    for (auto it = pendingSlotBakes_.begin(); it != pendingSlotBakes_.end(); ) {
        const int regionId  = it->first / MAX_SAMPLE_SLOTS;
        const int slotIndex = it->first % MAX_SAMPLE_SLOTS;
        auto baked = it->second ? slotBakeCache_->lookup(*it->second) : nullptr;
        if (!baked) { ++it; continue; }   // still baking

        publishSlotBuffer(regionId, slotIndex, baked);
        publishedSlotBakes_[it->first] = PreparedSlot{ baked, it->second->digest() };
        it = pendingSlotBakes_.erase(it);
        changed = true;
    }
    return changed;
}

MixEngine::PreparedSlot
MixEngine::getPreparedSlotBuffer(int regionId, int slotIndex) const
{
    if (regionId < 0 || slotIndex < 0 || slotIndex >= MAX_SAMPLE_SLOTS) return {};
    auto it = publishedSlotBakes_.find(slotMapKey(regionId, slotIndex));
    return it != publishedSlotBakes_.end() ? it->second : PreparedSlot{};
}

std::vector<MixEngine::SlotBakeJobInfo> MixEngine::getPendingSlotBakes() const
{
    std::vector<SlotBakeJobInfo> out;
    out.reserve(pendingSlotBakes_.size());
    for (const auto& [flatKey, key] : pendingSlotBakes_)
        out.push_back({ flatKey / MAX_SAMPLE_SLOTS, flatKey % MAX_SAMPLE_SLOTS });
    return out;
}

template <class Fn>
void MixEngine::editSamplerSet(Fn&& edit)
{
    SamplerSet next = *samplerSet_.load();
    edit(next);
    samplerSet_.publish(std::make_shared<const SamplerSet>(std::move(next)));
}

// Everything buildSamplerForRegion reads. Keep the two in step: a region field
// the builder starts using has to appear here, or a change to it will not mark
// that region's samplers stale.
nlohmann::json MixEngine::samplerInputs(const SampleRegion& region) const
{
    nlohmann::json j = {
        {"crossfadeEnabled",  region.crossfadeEnabled},
        {"monoEnabled",       region.monoEnabled},
        {"voiceCount",        region.voiceCount},
        {"legatoEnabled",     region.legatoEnabled},
        {"portamentoEnabled", region.portamentoEnabled},
        {"portamentoTimeMs",  region.portamentoTimeMs},
        {"portamentoMode",    region.portamentoMode},
        {"portamentoCurve",   region.portamentoCurve},
        {"arpEnabled",        region.arpEnabled},
        {"arpTempoSync",      region.arpTempoSync},
        {"arpDivision",       region.arpDivision},
        {"arpFreeTimeMs",     region.arpFreeTimeMs},
        {"arpGate",           region.arpGate},
        {"arpRange",          region.arpRange},
        {"arpDirection",      region.arpDirection},
        {"slots",             region.slots},
        {"modulation",        region.modulation},
    };
    nlohmann::json bankIds = nlohmann::json::array();
    const int nSlots = std::min(region.slotCount(), MAX_SAMPLE_SLOTS);
    for (int i = 0; i < nSlots; ++i)
        bankIds.push_back(getSampleIdForRegionSlot(region.id, i));
    j["bankIds"] = std::move(bankIds);
    return j;
}

bool MixEngine::buildSamplerInto(SamplerSet& set, int trackId, int regionId)
{
    if (sampleBank_ == nullptr || timeline_ == nullptr) return false;
    if (regionId < 0) return false;

    const TrackInfo* track = timeline_->getTrack(trackId);
    if (track == nullptr) return false;
    if (track->type != TrackInfo::Type::Pattern) return false;

    const SampleRegion* region = timeline_->getRegion(regionId);
    if (region == nullptr) return false;

    auto s = buildSamplerForRegion(*region);
    if (s == nullptr) return false;

    const TrackRegionKey key{trackId, regionId};
    set.playback[key]      = std::move(s);
    samplerBuiltFrom_[key] = { samplerInputs(*region), ++samplerBuildSerial_ };
    return true;
}

std::shared_ptr<MixEngine::PreviewSamplerSlot>
MixEngine::makePreviewSlot(const SampleRegion& region, const PreviewSamplerSlot* previous)
{
    auto s = buildSamplerForRegion(region);
    if (s == nullptr) return nullptr;

    auto slot = std::make_shared<PreviewSamplerSlot>();
    slot->sampler     = std::move(s);
    slot->builtFrom   = samplerInputs(region);
    slot->buildSerial = ++samplerBuildSerial_;
    if (previous != nullptr) {
        slot->routeTrackSlot.store(previous->routeTrackSlot.load(std::memory_order_relaxed),
                                   std::memory_order_relaxed);
        slot->routeTrackId.store(previous->routeTrackId.load(std::memory_order_acquire),
                                 std::memory_order_release);
    }
    return slot;
}

nlohmann::json MixEngine::describeSamplers() const
{
    const auto set = samplerSet_.load();

    // Values read off the live Sampler itself, not off the record.
    const auto live = [](const Sampler& s) {
        nlohmann::json slots = nlohmann::json::array();
        for (int i = 0; i < s.slotCount(); ++i)
            slots.push_back({ {"hasAudio", s.slotHasAudio(i)},
                              {"sounds",   s.slotSounds(i)},
                              {"mangleCount", s.debugSlotMangleCount(i)} });
        return nlohmann::json{
            {"slotCount", s.slotCount()},
            {"slots", std::move(slots)},
            {"modulationRoutes", s.modulationConfig().numRoutes},
            {"activeVoices", s.activeVoiceCount()},
        };
    };
    const auto staleAgainst = [this](int regionId, const nlohmann::json& builtFrom) {
        const SampleRegion* r = timeline_ != nullptr ? timeline_->getRegion(regionId) : nullptr;
        return r == nullptr || builtFrom != samplerInputs(*r);
    };

    nlohmann::json playback = nlohmann::json::array();
    for (const auto& [key, sampler] : set->playback) {
        if (!sampler) continue;
        const auto built = samplerBuiltFrom_.find(key);
        const bool known = built != samplerBuiltFrom_.end();
        const nlohmann::json builtFrom = known ? built->second.inputs : nlohmann::json();
        playback.push_back({ {"trackId", key.trackId}, {"regionId", key.regionId},
                             {"stale", staleAgainst(key.regionId, builtFrom)},
                             {"buildSerial", known ? built->second.serial : 0},
                             {"builtFrom", builtFrom}, {"live", live(*sampler)} });
    }

    nlohmann::json preview = nlohmann::json::array();
    for (const auto& [regionId, slot] : set->preview) {
        if (!slot || !slot->sampler) continue;
        preview.push_back({ {"regionId", regionId},
                            {"stale", staleAgainst(regionId, slot->builtFrom)},
                            {"buildSerial", slot->buildSerial},
                            {"builtFrom", slot->builtFrom}, {"live", live(*slot->sampler)} });
    }

    return { {"playback", std::move(playback)}, {"preview", std::move(preview)} };
}

void MixEngine::reclaimRetiredSamplers()
{
    samplerSet_.prune();
}

void MixEngine::loadSamplerForTrackRegion(int trackId, int regionId)
{
    SamplerSet next = *samplerSet_.load();
    if (buildSamplerInto(next, trackId, regionId))
        samplerSet_.publish(std::make_shared<const SamplerSet>(std::move(next)));
}

void MixEngine::unloadSamplerForTrackRegion(int trackId, int regionId)
{
    editSamplerSet([&](SamplerSet& set) { set.playback.erase({trackId, regionId}); });
}

void MixEngine::unloadSamplersForTrack(int trackId)
{
    editSamplerSet([&](SamplerSet& set) {
        std::erase_if(set.playback, [&](const auto& kv) { return kv.first.trackId == trackId; });
    });
}

void MixEngine::unloadSamplersForRegion(int regionId)
{
    editSamplerSet([&](SamplerSet& set) {
        std::erase_if(set.playback, [&](const auto& kv) { return kv.first.regionId == regionId; });
    });
    // The region is gone, so its slot→sample registrations are dead too.
    unmapAllRegionSlots(regionId);
}

void MixEngine::silenceAllSamplers()
{
    const auto set = samplerSet_.load();
    for (auto& [key, sampler] : set->playback)
        if (sampler) sampler->allNotesOff();
    for (auto& [id, slot] : set->preview)
        if (slot && slot->sampler) slot->sampler->allNotesOff();
}

void MixEngine::rebuildAllSamplers(int onlyRegionId)
{
    rebuildSamplers(onlyRegionId >= 0 ? SamplerRebuild::Region : SamplerRebuild::All, onlyRegionId);
}

void MixEngine::refreshStaleSamplers()
{
    rebuildSamplers(SamplerRebuild::StaleOnly, -1);
}

void MixEngine::rebuildSamplers(SamplerRebuild mode, int regionId)
{
    auto current = samplerSet_.load();
    SamplerSet next;

    if (timeline_ == nullptr) {
        next.preview = current->preview;
        samplerBuiltFrom_.clear();
        current.reset();
        samplerSet_.publish(std::make_shared<const SamplerSet>(std::move(next)));
        return;
    }

    // A region's inputs are evaluated once per rebuild, however many tracks
    // play it.
    std::unordered_map<int, nlohmann::json> inputsByRegion;
    const auto inputsOf = [&](const SampleRegion& r) -> const nlohmann::json& {
        auto it = inputsByRegion.find(r.id);
        if (it == inputsByRegion.end())
            it = inputsByRegion.emplace(r.id, samplerInputs(r)).first;
        return it->second;
    };

    // 1. Collect the set of {trackId, regionId} pairs actually referenced
    //    by any PatternBlock in the timeline (via block → pattern.regionId).
    //    A block whose region has been deleted needs no sampler.
    std::unordered_set<TrackRegionKey, TrackRegionKeyHash> needed;
    for (const PatternBlock* b : timeline_->getAllPatternBlocks()) {
        if (b == nullptr) continue;
        const Pattern* p = timeline_->getPattern(b->patternId);
        if (p == nullptr) continue;
        if (p->regionId < 0) continue;
        if (timeline_->getRegion(p->regionId) == nullptr) continue;
        const TrackInfo* t = timeline_->getTrack(b->trackId);
        if (t == nullptr || t->type != TrackInfo::Type::Pattern) continue;
        needed.insert({b->trackId, p->regionId});
    }

    // 2. Samplers no longer referenced by any block are pruned simply by not
    //    being carried into `next`.
    // 3. A needed pair is (re)built when it is missing, when the caller forces
    //    it (everything, or one region), or when it is stale — built from
    //    settings or audio its region no longer has. Anything else is carried
    //    over as it is, voices and all. A pair that cannot be built right now
    //    keeps the sampler it had.
    for (const auto& key : needed) {
        auto have = current->playback.find(key);
        if (have != current->playback.end()) {
            next.playback.insert(*have);

            const bool forced = mode == SamplerRebuild::All
                             || (mode == SamplerRebuild::Region && key.regionId == regionId);
            if (!forced) {
                auto built = samplerBuiltFrom_.find(key);
                if (built != samplerBuiltFrom_.end()
                    && built->second.inputs == inputsOf(*timeline_->getRegion(key.regionId)))
                    continue;
            }
        }
        buildSamplerInto(next, key.trackId, key.regionId);
    }

    std::erase_if(samplerBuiltFrom_, [&](const auto& kv) {
        return next.playback.find(kv.first) == next.playback.end();
    });

    // Preview samplers: never forced from here (the region's own refresh does
    // that), but a stale one is replaced and one whose region is gone dropped.
    for (const auto& [previewRegionId, slot] : current->preview) {
        const SampleRegion* region = timeline_->getRegion(previewRegionId);
        if (region == nullptr || !slot) continue;
        if (slot->builtFrom == inputsOf(*region)) {
            next.preview.emplace(previewRegionId, slot);
            continue;
        }
        auto fresh = makePreviewSlot(*region, slot.get());
        next.preview.emplace(previewRegionId, fresh ? fresh : slot);
    }

    // Let go first, so a set no block is holding is freed by this publish.
    current.reset();
    samplerSet_.publish(std::make_shared<const SamplerSet>(std::move(next)));

    // 4. Sync slot mapping, slot-owned atomics, and the non-thread-safe
    //    smoothers (still snapped in place — see the note in MixEngine.h).
    syncTrackSlotsFromTimeline(true);
}

// ── Prepare ──────────────────────────────────────────────────────────────────

void MixEngine::prepare(double sampleRate, int maxBlockSize)
{
    preparedSampleRate_ = sampleRate;

    // Parallel track processing helpers: created once, on the first prepare
    // (message thread, before any callback). None on small machines.
    if (!trackWorkerPool_)
    {
        const int workers = xleth::hw::audioWorkerThreads();
        if (workers > 0)
        {
            trackWorkerPool_  = std::make_unique<xleth::audio::RealtimeWorkerPool>(workers);
            parallelTrackJob_ = std::make_unique<ParallelTrackJob>();
        }
    }
    preparedBlockSize_  = maxBlockSize;

    for (int i = 0; i < kMaxTracks; ++i)
    {
        volumeSmoothed_[i].reset(sampleRate, 0.020); // 20ms linear ramp
        // Snap immediately to current atomic value — no initial ramp from 0
        const float cur = trackParams_[i].volume.load(std::memory_order_relaxed);
        volumeSmoothed_[i].setCurrentAndTargetValue(cur);
        trackCompensationDelays_[i].prepare(sampleRate, maxBlockSize);
        for (int k = 0; k < kMaxTrackSends; ++k)
        {
            sendCompensationDelays_[i][k].setMinimumCapacitySamples(kSendDelayMinCapacity);
            sendCompensationDelays_[i][k].prepare(sampleRate, maxBlockSize);
        }
    }
    sendScratch_.setSize(2, juce::jmax(1, maxBlockSize, trackBufferSize_), false, true, true);

    resetLatencyCompensationState();
    pendingLatencyCompensationReset_.store(false, std::memory_order_relaxed);

    // The K-weighting biquads are derived per sample rate, so the loudness meter
    // has to follow the device across a rate change. Stereo: the master bus is
    // always a stereo pair, and BS.1770-4's surround weights are out of scope.
    // Allocates on the first call only — every buffer inside the analyzer is
    // sized by channel count, not by rate. Kept outside the chainsMutex_ lock
    // below so the audio thread is never waited on while holding it. Note this
    // runs on the message thread when an export finishes (Audio_ExportGetProgress
    // re-prepares with the device live), which is exactly why it is guarded.
    withMasterLoudnessSuspended([this, sampleRate] {
        masterLoudness_.prepare(sampleRate, 2);
    });

    // Re-prepare any existing effect chains with the new sample rate / block size
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    for (auto& [id, chain] : effectChains_)
    {
        if (chain && chain->isInitialized())
            chain->reprepare(sampleRate, maxBlockSize);
    }
    if (masterEffectChain_ && masterEffectChain_->isInitialized())
        masterEffectChain_->reprepare(sampleRate, maxBlockSize);

    // Phase C: clear any per-clip vibrato readhead state on device prepare.
    clipModReader_.resetAllStates();

    // The envelope applier is the non-realtime last hop of the modulation path.
    // Starting it here (rather than in the constructor) keeps it off in
    // model-only tests that never prepare an audio device.
    startEnvelopeApplierThread();
}

void MixEngine::setDiagnosticTapSink(DiagnosticTapSink* sink)
{
    diagnosticTapSink_ = sink;
    diagnosticTapBlockIndex_ = 0;
}

// ── Master loudness meter ────────────────────────────────────────────────────

void MixEngine::setMasterLoudnessEnabled(bool enabled)
{
    if (enabled == masterLoudnessEnabled_.load(std::memory_order_relaxed))
        return;

    if (!enabled)
    {
        masterLoudnessEnabled_.store(false, std::memory_order_release);
        return;
    }

    // Clear before arming: an integration resumed across a gap would average two
    // disjoint spans of programme into one number, and the K-weighting filters
    // would start from state belonging to whatever was playing when the meter
    // was switched off.
    withMasterLoudnessSuspended([this] { masterLoudness_.reset(); });
    masterLoudnessEnabled_.store(true, std::memory_order_release);
}

void MixEngine::resetMasterLoudness()
{
    withMasterLoudnessSuspended([this] { masterLoudness_.reset(); });
}

MixEngine::MasterLoudnessSnapshot MixEngine::getMasterLoudness() const
{
    MasterLoudnessSnapshot s;
    s.enabled = masterLoudnessEnabled_.load(std::memory_order_relaxed);

    // Read-only walk over state the audio thread is writing, exactly like the
    // peak getters: values can straddle a block, which costs at most one frame
    // of meter jitter. Nothing here can resize, so nothing here can dangle.
    const auto r = masterLoudness_.getResults();
    s.integrated   = r.integrated;
    s.momentaryMax = r.momentaryMax;
    s.shortTermMax = r.shortTermMax;
    s.lra          = r.lra;
    s.truePeakDbtp = r.truePeakDbtp;

    s.momentary = masterLoudness_.getCurrentMomentaryLufs();
    s.shortTerm = masterLoudness_.getCurrentShortTermLufs();
    return s;
}

void MixEngine::setNonRealtime(bool nr)
{
    nonRealtime_.store(nr, std::memory_order_relaxed);
    // An export awaits every clip render before its first block and then plays
    // each one once, faster than realtime: nothing it waited for may be
    // evicted from under it. Ending the export runs the deferred eviction pass.
    clipRenderCache_.setEvictionSuspended(nr);
    // Propagate to each effect chain's JUCE AudioProcessorGraph.
    // JUCE's AudioProcessorGraph::processBlock() only builds its render
    // sequence synchronously when prepareToPlay() is called from the message
    // thread; from any other thread it defers via triggerAsyncUpdate().
    // Setting nonRealtime on the graph activates its built-in spin-wait so
    // processBlock() waits for the render sequence rather than clearing audio.
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    for (auto& [id, chain] : effectChains_)
        if (chain) chain->setNonRealtime(nr);
    if (masterEffectChain_)
        masterEffectChain_->setNonRealtime(nr);
}

// ── Offline tail render: note-trigger ceiling (Phase 3A) ────────────────────

void MixEngine::setNoteTriggerCeilingSample(int64_t ceilingSample)
{
    noteTriggerCeilingSample_.store(ceilingSample, std::memory_order_relaxed);
}

void MixEngine::clearNoteTriggerCeiling()
{
    noteTriggerCeilingSample_.store((std::numeric_limits<int64_t>::max)(),
                                    std::memory_order_relaxed);
}

// ── Direct atomic parameter setters (slot-based via trackIdToSlot_) ─────────

void MixEngine::setTrackVolume(int trackId, float volume)
{
    std::shared_lock<std::shared_mutex> lock(slotMutex_);
    auto it = trackIdToSlot_.find(trackId);
    if (it == trackIdToSlot_.end()) return;
    trackParams_[it->second].volume.store(volume, std::memory_order_relaxed);
}

void MixEngine::setTrackPan(int trackId, float pan)
{
    std::shared_lock<std::shared_mutex> lock(slotMutex_);
    auto it = trackIdToSlot_.find(trackId);
    if (it == trackIdToSlot_.end()) return;
    trackParams_[it->second].pan.store(pan, std::memory_order_relaxed);
}

void MixEngine::setTrackSpread(int trackId, float spread)
{
    std::shared_lock<std::shared_mutex> lock(slotMutex_);
    auto it = trackIdToSlot_.find(trackId);
    if (it == trackIdToSlot_.end()) return;
    trackParams_[it->second].spread.store(spread, std::memory_order_relaxed);
}

void MixEngine::setMasterVolume(float volume)
{
    masterVolume_.store(volume, std::memory_order_relaxed);
}

float MixEngine::getMasterVolume() const
{
    return masterVolume_.load(std::memory_order_relaxed);
}

void MixEngine::setClipBoundaryFadeSamples(int n)
{
    clipBoundaryFadeSamples_.store(n < 0 ? 0 : n, std::memory_order_relaxed);
}

// ── Global clip-processing defaults ─────────────────────────────────────────

void MixEngine::setGlobalStretchMethod(int method) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[EngineConfig] globalStretchMethod changed: %d→%d\n",
            globalStretchMethod_, (method >= 1 && method <= 5) ? method : 1);
#endif
    globalStretchMethod_ = (method >= 1 && method <= 5) ? method : 1;
}

void MixEngine::setGlobalFormantPreserve(bool enabled) {
#ifdef XLETH_DEBUG
    fprintf(stderr, "[EngineConfig] globalFormantPreserve changed: %d→%d\n",
            (int)globalFormantPreserve_, (int)enabled);
#endif
    globalFormantPreserve_ = enabled;
}

void MixEngine::invalidateAllGlobalMethodClips() {
    if (!timeline_) return;
    int count = 0;
    for (const Clip* c : timeline_->getAllClips()) {
        if (!c || c->stretchMethod != StretchMethod::Global) continue;
        if (clipNeedsCacheRender(*c)) { invalidateClipCache(c->id, "invalidateAllGlobalMethodClips"); ++count; }
    }
#ifdef XLETH_DEBUG
    fprintf(stderr, "[EngineConfig] mass markDirty: %d clips invalidated\n", count);
#endif
}

// ── Clip render cache (message thread) ──────────────────────────────────────

// Builds the content-address for a clip's processed audio. Shared by the
// invalidate (write) and lookup (read) paths so they can never disagree —
// a mismatch there shows up as permanent cache misses on the audio thread.
CacheKey MixEngine::buildClipCacheKey(const Clip& clip,
                                      const juce::AudioBuffer<float>& srcBuf) const
{
    const double bpm = timeline_->getBPM();
    const double sr  = preparedSampleRate_;

    const int64_t clipStartSample = clip.position.toSamples(bpm, sr);
    const int64_t clipEndSample   = (clip.position + clip.duration).toSamples(bpm, sr);

    // Syllable offset + clip-level regionOffset — must match findActiveClips() exactly.
    int64_t regionOffsetSamples = 0;
    if (clip.syllableIndex >= 0)
    {
        const auto* region = timeline_->getRegion(clip.regionId);
        if (region != nullptr && clip.syllableIndex < static_cast<int>(region->syllables.size()))
        {
            const auto& syl = region->syllables[clip.syllableIndex];
            regionOffsetSamples = static_cast<int64_t>(syl.startTime * sr);
        }
    }
    if (clip.regionOffset.ticks > 0)
        regionOffsetSamples += clip.regionOffset.toSamples(bpm, sr);

    CacheKey key;
    key.regionId            = clip.regionId;
    key.syllableIndex       = clip.syllableIndex;
    key.regionOffsetSamples = regionOffsetSamples;
    key.durationSamples     = clipEndSample - clipStartSample;
    key.sourceLengthSamples = srcBuf.getNumSamples();
    key.pitchOffsetSemis    = clip.pitchOffset;
    key.pitchOffsetCents    = clip.pitchOffsetCents;
    key.reversed            = clip.reversed;
    key.stretchRatio        = clip.stretchRatio;
    {
        const bool isGlobal = (clip.stretchMethod == StretchMethod::Global);
        key.stretchMethod   = isGlobal ? globalStretchMethod_
                                       : static_cast<int>(clip.stretchMethod);
        key.formantPreserve = isGlobal ? globalFormantPreserve_
                                       : clip.formantPreserve;
    }
    return key;
}

void MixEngine::invalidateClipCaches(const std::vector<int>& clipIds,
                                     const char* trigger)
{
    for (int id : clipIds)
        invalidateClipCacheImpl(id, trigger, /*quiet=*/true);
#ifdef XLETH_DEBUG
    fprintf(stderr, "[CacheQueue] batch invalidate: %zu clip(s) trigger=%s\n",
            clipIds.size(), trigger ? trigger : "null");
    fflush(stderr);
#endif
}

void MixEngine::invalidateClipCache(int clipId, const char* trigger)
{
    invalidateClipCacheImpl(clipId, trigger, /*quiet=*/false);
}

void MixEngine::invalidateClipCacheImpl(int clipId, const char* trigger, bool quiet)
{
#ifdef XLETH_DEBUG
    if (!quiet) {
        fprintf(stderr, "[CacheQueue] invalidateClipCache entry: clip=%d trigger=%s\n",
                clipId, trigger ? trigger : "null");
        fflush(stderr);
    }
#endif

    if (!timeline_ || !sampleBank_) {
        clipRenderCache_.markDirty(clipId);
        return;
    }

    const Clip* clip = timeline_->getClip(clipId);
    if (!clip) {
        clipRenderCache_.markDirty(clipId);
        return;
    }

    // Only submit a render job if the clip actually needs processing — of its
    // own, or because its track's Pitch Shifter is in Clip mode (fx lane).
    const bool needsProcessing = (clip->pitchOffset != 0
                               || clip->pitchOffsetCents != 0
                               || clip->reversed
                               || clip->stretchRatio != 1.0);
    const auto fxTable = currentSourceTransformTable();
    const xleth::SourceTransform* fx = fxTable->find(clip->trackId);
    if (!needsProcessing && fx == nullptr) {
#ifdef XLETH_DEBUG
        if (!quiet) {
            fprintf(stderr, "[CacheQueue] SKIP clip=%d reason=identity_params "
                    "(pitchSemi=%d cents=%d reversed=%d stretch=%.3f) trigger=%s\n",
                    clipId, clip->pitchOffset, clip->pitchOffsetCents,
                    clip->reversed ? 1 : 0, clip->stretchRatio,
                    trigger ? trigger : "null");
            fflush(stderr);
        }
#endif
        clipRenderCache_.markDirty(clipId);
        return;
    }

    const auto regionMap = loadRegionSampleMap();
    auto it = regionMap->find(clip->regionId);
    if (it == regionMap->end()) {
#ifdef XLETH_DEBUG
        if (!quiet) {
            fprintf(stderr, "[CacheQueue] SKIP clip=%d reason=region_%d_not_in_sampleMap trigger=%s\n",
                    clipId, clip->regionId, trigger ? trigger : "null");
            fflush(stderr);
        }
#endif
        clipRenderCache_.markDirty(clipId);
        return;
    }

    const juce::AudioBuffer<float>* srcBuf = sampleBank_->getSample(it->second);
    if (!srcBuf) {
#ifdef XLETH_DEBUG
        if (!quiet) {
            fprintf(stderr, "[CacheQueue] SKIP clip=%d reason=sampleBank_no_buffer trigger=%s\n",
                    clipId, trigger ? trigger : "null");
            fflush(stderr);
        }
#endif
        clipRenderCache_.markDirty(clipId);
        return;
    }

    const CacheKey key = buildClipCacheKey(*clip, *srcBuf);
    const double bakeRate = sampleBank_->getSampleBufferRate(it->second);

    // One lane at a time: the original render, then the shifted one. A key
    // whose entry already exists goes through submitJob's repeat path, which
    // renders nothing and only re-publishes a finished buffer the slot lost
    // (an eviction, or a stale job) — a clip MOVE, the common case, changes
    // nothing the key depends on. Bulk-moving a selection used to re-render
    // every clip in it.
    auto submitLane = [&](const CacheKey& laneKey, const char* lane) {
#ifdef XLETH_DEBUG
        if (!quiet) {
            const bool keep = clipRenderCache_.hasEntryForKey(clipId, laneKey);
            fprintf(stderr, "[CacheQueue] %s clip=%d lane=%s regionId=%d stretchRatio=%.3f reversed=%d "
                    "stretchMethod=%d (resolved=%d) pitch=%dst+%dc fx=%dst+%dc/%d trigger=%s\n",
                    keep ? "KEEP" : "ENQUEUE", clipId, lane, clip->regionId,
                    clip->stretchRatio, clip->reversed ? 1 : 0,
                    (int)clip->stretchMethod, laneKey.stretchMethod,
                    clip->pitchOffset, clip->pitchOffsetCents,
                    laneKey.fxPitchSemis, laneKey.fxPitchCents, laneKey.fxMethod,
                    trigger ? trigger : "null");
            fflush(stderr);
        }
#else
        (void) lane;
#endif
        clipRenderCache_.submitJob(clipId, laneKey, *srcBuf, preparedSampleRate_, bakeRate, quiet);
    };

    if (needsProcessing) submitLane(key, "orig");
    else                 clipRenderCache_.markDirtyLane(clipId, /*fxLane=*/false);

    // The shifted render is requested whenever the transform is active —
    // regardless of Mix, so an automated Mix sweep always has wet to blend.
    if (fx != nullptr)   submitLane(withSourceTransform(key, *fx), "fx");
    else                 clipRenderCache_.markDirtyLane(clipId, /*fxLane=*/true);
}

// ── Clip processed buffer lookup (message thread) ────────────────────────────

std::shared_ptr<const juce::AudioBuffer<float>> MixEngine::getClipProcessedBuffer(int clipId) const
{
    if (!timeline_ || !sampleBank_) return nullptr;

    const Clip* clip = timeline_->getClip(clipId);
    if (!clip) return nullptr;

    const bool needsProcessing = (clip->pitchOffset    != 0
                               || clip->pitchOffsetCents != 0
                               || clip->reversed
                               || clip->stretchRatio   != 1.0);
    if (!needsProcessing) return nullptr;

    const auto regionMap = loadRegionSampleMap();
    auto it = regionMap->find(clip->regionId);
    if (it == regionMap->end()) return nullptr;

    const juce::AudioBuffer<float>* srcBuf = sampleBank_->getSample(it->second);
    if (!srcBuf) return nullptr;

    return clipRenderCache_.getProcessedBuffer(clipId, buildClipCacheKey(*clip, *srcBuf));
}

// ── Slot mapping (main thread only) ─────────────────────────────────────────

void MixEngine::updateSlotMapping()
{
    if (timeline_ == nullptr)
    {
        std::unique_lock<std::shared_mutex> lock(slotMutex_);
        trackIdToSlot_.clear();
        return;
    }

    const auto allTracks = timeline_->getAllTracks();
    std::unique_lock<std::shared_mutex> lock(slotMutex_);
    trackIdToSlot_.clear();
    for (int i = 0; i < static_cast<int>(allTracks.size()) && i < kMaxTracks; ++i)
    {
        if (allTracks[i] != nullptr)
            trackIdToSlot_[allTracks[i]->id] = i;
    }
}

void MixEngine::syncTrackSlotsFromTimeline(bool snapVolumeSmoothers)
{
    updateSlotMapping();
    pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    if (timeline_ == nullptr) return;

    const auto allTracks = timeline_->getAllTracks();
    for (int i = 0; i < static_cast<int>(allTracks.size()) && i < kMaxTracks; ++i)
    {
        const auto* t = allTracks[i];
        if (t == nullptr) continue;

        trackParams_[i].volume.store(t->volume, std::memory_order_relaxed);
        trackParams_[i].pan.store(t->pan, std::memory_order_relaxed);
        trackParams_[i].spread.store(t->stereoSpread, std::memory_order_relaxed);

        if (snapVolumeSmoothers)
            volumeSmoothed_[i].setCurrentAndTargetValue(t->volume);
    }

    // Envelope gates are muted/soloed with the track they follow, so the snapshot
    // has to be rebuilt whenever the slot params are resynced (which is what every
    // mute/solo/volume mutation already calls).
    refreshEnvelopeDefinitions();

    // LFO definitions don't depend on mute/solo (audibility is a runtime,
    // per-block concern in evaluateLfoModulation — see its comment), but they
    // do depend on graphState, which can change alongside the same edits that
    // call this function. Rebuilding here keeps it as current as Envelope's.
    refreshLfoDefinitions();
}

void MixEngine::syncSidechainTargetBuses()
{
    if (timeline_ == nullptr) return;

    // Group, per target track, the stable effectInstanceIds that an ENABLED
    // sidechain route currently targets. A disabled route leaves the bus off
    // (no key would flow anyway). A track-level (empty) target enables every
    // capable effect on the track (the AudioGraph wildcard): each effect's own
    // external switch then decides whether it listens, like FL's sidechain
    // input selector. Source mute/visual-only is irrelevant to *enabling* the
    // bus — that only governs whether a key flows at DSP time.
    std::unordered_map<int, std::set<std::string>> targetsByTrack;
    for (const auto* tr : timeline_->getAllTracks())
    {
        if (tr == nullptr) continue;
        for (const auto& route : tr->sidechainRoutes)
        {
            if (!route.enabled) continue;
            targetsByTrack[route.targetTrackId].insert(
                route.targetEffectInstanceId.empty()
                    ? std::string(AudioGraph::kAllSidechainTargets)
                    : route.targetEffectInstanceId);
        }
    }

    // Apply to every initialized chain — including chains with no incoming routes
    // (empty set), so a removed/disabled route deterministically disables the bus.
    // Structural (re-prepare) work: hold the chains lock so the audio thread is
    // never mid-block for a chain whose layout is changing.
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    static const std::set<std::string> kEmptyTargets;
    for (auto& [trackId, chain] : effectChains_)
    {
        if (!chain || !chain->isInitialized()) continue;
        auto it = targetsByTrack.find(trackId);
        chain->applySidechainTargetInstances(
            it != targetsByTrack.end() ? it->second : kEmptyTargets);
    }
}

bool MixEngine::hasSampler(int trackId, int regionId) const
{
    const auto set = samplerSet_.load();
    return set->playback.find({trackId, regionId}) != set->playback.end();
}

Sampler* MixEngine::getSamplerPtr(int trackId, int regionId)
{
    // The raw pointer outlives the local pin because the main thread is the
    // only publisher: nothing can retire the set between here and the caller.
    const auto set = samplerSet_.load();
    auto it = set->playback.find({trackId, regionId});
    return it != set->playback.end() ? it->second.get() : nullptr;
}

// ── Preview samplers ─────────────────────────────────────────────────────────

void MixEngine::ensurePreviewSampler(int regionId)
{
    if (sampleBank_ == nullptr || timeline_ == nullptr) return;
    const SampleRegion* r = timeline_->getRegion(regionId);
    if (r == nullptr) {
        unloadPreviewSampler(regionId);
        return;
    }

    const auto current = samplerSet_.load();
    const auto old = current->preview.find(regionId);
    auto slot = makePreviewSlot(*r, old != current->preview.end() ? old->second.get() : nullptr);
    if (slot == nullptr) return;

    editSamplerSet([&](SamplerSet& set) { set.preview[regionId] = std::move(slot); });
}

void MixEngine::unloadPreviewSampler(int regionId)
{
    if (!hasPreviewSampler(regionId)) return;
    editSamplerSet([&](SamplerSet& set) { set.preview.erase(regionId); });
}

Sampler* MixEngine::getPreviewSamplerPtr(int regionId)
{
    const auto set = samplerSet_.load();
    auto it = set->preview.find(regionId);
    return it != set->preview.end() && it->second ? it->second->sampler.get() : nullptr;
}

bool MixEngine::hasPreviewSampler(int regionId) const
{
    const auto set = samplerSet_.load();
    return set->preview.find(regionId) != set->preview.end();
}

void MixEngine::silenceAllPreviewSamplers()
{
    const auto set = samplerSet_.load();
    for (auto& [id, slot] : set->preview)
        if (slot && slot->sampler) slot->sampler->allNotesOff();
}

// ── Preview effect routing (main thread) ─────────────────────────────────────

void MixEngine::setSamplerPreviewRouteMode(xleth::SamplerPreviewRouteMode mode)
{
    previewRouteMode_.store(static_cast<int>(mode), std::memory_order_relaxed);
}

xleth::SamplerPreviewRouteMode MixEngine::getSamplerPreviewRouteMode() const
{
    return static_cast<xleth::SamplerPreviewRouteMode>(
        previewRouteMode_.load(std::memory_order_relaxed));
}

void MixEngine::setSamplerPreviewSelectedTrack(int trackId)
{
    previewRouteSelectedTrackId_.store(trackId, std::memory_order_relaxed);
}

int MixEngine::getSamplerPreviewSelectedTrack() const
{
    return previewRouteSelectedTrackId_.load(std::memory_order_relaxed);
}

int MixEngine::refreshPreviewRoute(int regionId)
{
    const auto mode = getSamplerPreviewRouteMode();

    // Collect every pattern track that hosts a block whose pattern plays this
    // region. Only needed in Dedicated mode — the other modes ignore it.
    std::vector<xleth::PreviewRouteTrack> hosts;
    if (mode == xleth::SamplerPreviewRouteMode::Dedicated && timeline_ != nullptr)
    {
        for (const PatternBlock* b : timeline_->getAllPatternBlocks())
        {
            if (b == nullptr) continue;
            const Pattern* p = timeline_->getPattern(b->patternId);
            if (p == nullptr || p->regionId != regionId) continue;
            const TrackInfo* t = timeline_->getTrack(b->trackId);
            if (t == nullptr || t->type != TrackInfo::Type::Pattern) continue;
            hosts.push_back({ t->id, t->outputRoute.targetTrackId });
        }
    }

    const int resolved = xleth::resolvePreviewRoute(mode, hosts, getSamplerPreviewSelectedTrack());

    // Resolve the mixer slot here on the main thread; the audio thread cannot
    // take slotMutex_ to look it up itself.
    int slot = -1;
    if (resolved >= 0) {
        std::shared_lock<std::shared_mutex> lock(slotMutex_);
        auto slotIt = trackIdToSlot_.find(resolved);
        if (slotIt != trackIdToSlot_.end()) slot = slotIt->second;
    }

    const auto set = samplerSet_.load();
    auto it = set->preview.find(regionId);
    if (it != set->preview.end() && it->second) {
        it->second->routeTrackSlot.store(slot, std::memory_order_relaxed);
        it->second->routeTrackId.store(resolved, std::memory_order_release);
    }
    return resolved;
}

int MixEngine::getPreviewRouteTrack(int regionId) const
{
    const auto set = samplerSet_.load();
    auto it = set->preview.find(regionId);
    if (it == set->preview.end() || !it->second) return xleth::kPreviewRouteNone;
    return it->second->routeTrackId.load(std::memory_order_acquire);
}

// ── Pattern audition (main thread) ───────────────────────────────────────────

bool MixEngine::startPatternAudition(int patternId, bool loop)
{
    if (timeline_ == nullptr) return false;
    const Pattern* pattern = timeline_->getPattern(patternId);
    if (pattern == nullptr || pattern->regionId < 0 || pattern->length.ticks <= 0)
        return false;
    const int regionId = pattern->regionId;

    // The audio thread only ever looks the sampler up, so it must exist before
    // the start is published. Never rebuilt here when present: that would swap
    // a sampler out from under a running audition.
    if (!hasPreviewSampler(regionId)) ensurePreviewSampler(regionId);
    const auto set = samplerSet_.load();
    auto it = set->preview.find(regionId);
    if (it == set->preview.end() || !it->second || !it->second->sampler
        || !it->second->sampler->hasSample())
        return false;

    // Route: the track this pattern is actually placed on, so the audition
    // carries that track's effect rack. Deliberately NOT subject to the
    // piano-roll key-audition routing preference — "hear the pattern with its
    // mixer effects" is the whole point of this mode. A pattern that is not on
    // the timeline yet falls back to that preference.
    int hostTrackId = xleth::kPreviewRouteNone;
    {
        const PatternBlock* best = nullptr;
        for (const PatternBlock* b : timeline_->getAllPatternBlocks())
        {
            if (b == nullptr || b->patternId != patternId) continue;
            const TrackInfo* t = timeline_->getTrack(b->trackId);
            if (t == nullptr || t->type != TrackInfo::Type::Pattern) continue;
            if (best == nullptr || b->position.ticks < best->position.ticks) best = b;
        }
        if (best != nullptr) hostTrackId = best->trackId;
    }
    if (hostTrackId == xleth::kPreviewRouteNone)
    {
        refreshPreviewRoute(regionId);
    }
    else
    {
        int slot = -1;
        {
            std::shared_lock<std::shared_mutex> lock(slotMutex_);
            auto slotIt = trackIdToSlot_.find(hostTrackId);
            if (slotIt != trackIdToSlot_.end()) slot = slotIt->second;
        }
        it->second->routeTrackSlot.store(slot, std::memory_order_relaxed);
        it->second->routeTrackId.store(hostTrackId, std::memory_order_release);
    }

    auditionLoop_.store(loop, std::memory_order_relaxed);
    auditionPatternId_.store(patternId, std::memory_order_relaxed);
    auditionStartSeq_.fetch_add(1, std::memory_order_release);
    return true;
}

void MixEngine::stopPatternAudition()
{
    auditionPatternId_.store(-1, std::memory_order_release);
}

void MixEngine::setPatternAuditionLoop(bool loop)
{
    auditionLoop_.store(loop, std::memory_order_relaxed);
}

MixEngine::PatternAuditionState MixEngine::getPatternAuditionState() const
{
    PatternAuditionState s;
    s.patternId     = auditionPatternId_.load(std::memory_order_acquire);
    s.active        = s.patternId >= 0 && auditionActive_.load(std::memory_order_acquire);
    s.loop          = auditionLoop_.load(std::memory_order_relaxed);
    s.positionTicks = auditionPosTicks_.load(std::memory_order_relaxed);
    return s;
}

// ── Preview render (audio thread) ────────────────────────────────────────────
//
// Preview samplers are grouped by their resolved route so each track's chain
// runs ONCE per block over the sum of the previews assigned to it — running a
// stateful chain repeatedly within one block corrupts its delay lines.
//
// CRITICAL: `allowChainRouting` must be false whenever the track chains are
// ALSO processing their own tracks this block (i.e. while the transport rolls,
// including offline render). A track chain can be processed exactly once per
// block; feeding it the preview bus as a second pass shreds every stateful
// effect on that track and desynchronises its reported latency from the PDC
// plan, which is heard as distortion during playback and as delay plus a pop on
// every transient in a render. Auditioning through a rack is therefore a
// transport-stopped feature, where the chain is otherwise idle.
void MixEngine::renderPreviewSamplers(juce::AudioBuffer<float>& outputBuffer,
                                      int numSamples, double sampleRate,
                                      double bpm, const ChainSnapshot* chains)
{
    const bool allowChainRouting = (chains != nullptr);
    const auto& previewSamplers = rtSamplers_->preview;
    if (previewSamplers.empty()) return;

    if (previewBuffer_.getNumSamples() < numSamples)
        previewBuffer_.setSize(2, numSamples, false, true, false);
    if (previewMasterBus_.getNumSamples() < numSamples)
        previewMasterBus_.setSize(2, numSamples, false, true, false);
    previewMasterBus_.clear(0, numSamples);
    bool anyRouted = false;

    // Small fixed set of routes seen this block. Preview is a hand-driven
    // audition surface, so the practical count is 1; the cap only bounds the
    // work if a project somehow auditions many regions at once.
    constexpr int kMaxPreviewRoutes = 8;
    int seenRoutes[kMaxPreviewRoutes];
    int numSeenRoutes = 0;

    for (auto& kv : previewSamplers)
    {
        auto* previewSlot = kv.second.get();
        if (previewSlot == nullptr || previewSlot->sampler == nullptr
            || !previewSlot->sampler->hasSample())
            continue;

        int route = previewSlot->routeTrackId.load(std::memory_order_acquire);
        if (!allowChainRouting) route = xleth::kPreviewRouteNone;

        bool alreadyRendered = false;
        for (int i = 0; i < numSeenRoutes; ++i)
            if (seenRoutes[i] == route) { alreadyRendered = true; break; }
        if (alreadyRendered) continue;

        if (numSeenRoutes < kMaxPreviewRoutes)
            seenRoutes[numSeenRoutes++] = route;

        // Sum every preview sharing this route into the scratch bus.
        previewBuffer_.clear(0, numSamples);
        for (auto& kv2 : previewSamplers)
        {
            auto* other = kv2.second.get();
            if (other == nullptr || other->sampler == nullptr || !other->sampler->hasSample())
                continue;
            int otherRoute = other->routeTrackId.load(std::memory_order_acquire);
            if (!allowChainRouting) otherRoute = xleth::kPreviewRouteNone;
            if (otherRoute != route) continue;
            other->sampler->setBPM(bpm);
            other->sampler->processBlock(previewBuffer_, numSamples, sampleRate);
        }

        if (route < 0)
        {
            // Dry audition: straight to the master output, untouched by any
            // track or master processing. This is what "Off (raw)" means.
            for (int ch = 0; ch < std::min(2, outputBuffer.getNumChannels()); ++ch)
                outputBuffer.addFrom(ch, 0, previewBuffer_, ch, 0, numSamples);
            continue;
        }

        // Routed audition: walk the same signal path the arrangement takes —
        // track chain, track fader, then (below) master chain and master fader.
        const auto* previewEntry = chains->find(route);
        if (previewEntry != nullptr && previewEntry->chain && previewEntry->chain->isInitialized())
        {
            // Claimed like the playing path's chains: a chain the worker is
            // resetting right now is left alone and the audition is silent for
            // this one block (see EffectChainManager::beginRealtimeUse).
            if (!previewEntry->chain->beginRealtimeUse())
            {
                previewBuffer_.clear(0, numSamples);
                continue;
            }
            previewMidi_.clear();
            previewEntry->chain->processBlock(previewBuffer_, numSamples, previewMidi_);
            previewEntry->chain->endRealtimeUse();

            // The audition just left state in a chain the arrangement owns
            // (a reverb tail, a filled delay line). Request a reset on the next
            // play start so none of it bleeds into playback.
            auditionDirtiedChains_ = true;
        }

        // Post-effects track fader, ramped exactly as the playing path ramps it.
        // Safe to advance this smoother here: only the transport-stopped path
        // routes previews, and that path is the sole consumer while stopped.
        const int mixerSlot = previewSlot->routeTrackSlot.load(std::memory_order_relaxed);
        if (mixerSlot >= 0 && mixerSlot < kMaxTracks)
        {
            volumeSmoothed_[mixerSlot].setTargetValue(
                trackParams_[mixerSlot].volume.load(std::memory_order_relaxed));
            const int nCh = previewBuffer_.getNumChannels();
            float* bufL = previewBuffer_.getWritePointer(0);
            float* bufR = nCh > 1 ? previewBuffer_.getWritePointer(1) : nullptr;
            for (int s = 0; s < numSamples; ++s)
            {
                const float g = volumeSmoothed_[mixerSlot].getNextValue();
                bufL[s] *= g;
                if (bufR != nullptr) bufR[s] *= g;
            }
        }

        for (int ch = 0; ch < std::min(2, previewMasterBus_.getNumChannels()); ++ch)
            previewMasterBus_.addFrom(ch, 0, previewBuffer_, ch, 0, numSamples);
        anyRouted = true;
    }

    if (!anyRouted) return;

    // Master insert chain + master fader over the routed previews only. The
    // master chain is idle while the transport is stopped (the playing path
    // returns before this function is reached with routing enabled), so this
    // still honours the once-per-block rule.
    if (chains->master && chains->master->isInitialized())
    {
        if (!chains->master->beginRealtimeUse())
            return;   // master mid-reset: previews silent this block
        previewMidi_.clear();
        chains->master->processBlock(previewMasterBus_, numSamples, previewMidi_);
        chains->master->endRealtimeUse();
        auditionDirtiedChains_ = true;
    }

    const float masterVol = masterVolume_.load(std::memory_order_relaxed);
    if (masterVol != 1.0f)
        previewMasterBus_.applyGain(0, numSamples, masterVol);

    for (int ch = 0; ch < std::min(2, outputBuffer.getNumChannels()); ++ch)
        outputBuffer.addFrom(ch, 0, previewMasterBus_, ch, 0, numSamples);
}

// ── Effect chain management (main thread only) ─────────────────────────────

void MixEngine::initEffectChain(int trackId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    if (effectChains_.count(trackId)) return;
    auto chain = std::make_shared<EffectChainManager>();
    chain->setPluginRegistry(pluginRegistry_.get());
    chain->init(preparedSampleRate_, preparedBlockSize_);
    effectChains_[trackId] = std::move(chain);
}

void MixEngine::destroyEffectChain(int trackId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    effectChains_.erase(trackId);
    pendingLatencyCompensationReset_.store(true, std::memory_order_release);
}

void MixEngine::destroyAllEffectChains()
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    const size_t nTrack = effectChains_.size();
    effectChains_.clear();
    const bool hadMaster = (bool)masterEffectChain_;
    masterEffectChain_.reset();
    std::fprintf(stderr,
                 "[MixEngine] destroyAllEffectChains: cleared %zu track chain(s)%s\n",
                 nTrack, hadMaster ? ", destroyed master chain" : "");
    pendingLatencyCompensationReset_.store(true, std::memory_order_release);
}

int MixEngine::addEffect(int trackId, const std::string& pluginId, int position)
{
    // A node created or destroyed here invalidates the automation plan's
    // resolved parameter handles. Flag rather than rebuild: this function
    // holds chainsMutex_, and refreshAutomationPlan() takes it. The envelope
    // applier thread services the flag on its next pass.
    automationBindingsDirty_.store(true, std::memory_order_release);
    // TWO-STRIKE: chain->addEffect() instantiates the VST (DLL load + prepareToPlay).
    // Minimising hold time requires a two-phase EffectChainManager API:
    // createPluginOffline(pluginId) pre-lock, then insertPreparedPlugin(proc, pos) inside.
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    // Auto-init chain on first add
    auto& chain = effectChains_[trackId];
    if (!chain)
    {
        chain = std::make_shared<EffectChainManager>();
        chain->setPluginRegistry(pluginRegistry_.get());
        chain->init(preparedSampleRate_, preparedBlockSize_);
    }
    const int nodeId = chain->addEffect(pluginId, position);
    if (nodeId >= 0)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return nodeId;
}

bool MixEngine::removeEffect(int trackId, int nodeId)
{
    // A node created or destroyed here invalidates the automation plan's
    // resolved parameter handles. Flag rather than rebuild: this function
    // holds chainsMutex_, and refreshAutomationPlan() takes it. The envelope
    // applier thread services the flag on its next pass.
    automationBindingsDirty_.store(true, std::memory_order_release);
    // Close any open editor (in-process or out-of-process) BEFORE removing the
    // AudioProcessor node. This avoids dangling AudioProcessor* references in
    // PluginEditorWindow and EditorProcessCoordinator::ParamSyncListener.
    closePluginEditor(trackId, nodeId);

    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    const bool ok = it->second->removeEffect(nodeId);
    if (ok)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return ok;
}

bool MixEngine::moveEffect(int trackId, int nodeId, int newPosition)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    const bool ok = it->second->moveEffect(nodeId, newPosition);
    if (ok)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return ok;
}

bool MixEngine::setEffectBypass(int trackId, int nodeId, bool bypassed)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    const bool ok = it->second->setBypass(nodeId, bypassed);
    if (ok)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return ok;
}

std::string MixEngine::getEffectChainState(int trackId) const
{
    nlohmann::json state;
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        auto it = effectChains_.find(trackId);
        if (it == effectChains_.end() || !it->second) return "[]";
        state = it->second->getChainState();
    }
    return state.dump();
}

// ── Master effect chain ─────────────────────────────────────────────────────

void MixEngine::initMasterEffectChain()
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    if (masterEffectChain_) return;
    masterEffectChain_ = std::make_shared<EffectChainManager>();
    masterEffectChain_->setPluginRegistry(pluginRegistry_.get());
    masterEffectChain_->init(preparedSampleRate_, preparedBlockSize_);
}

void MixEngine::destroyMasterEffectChain()
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    masterEffectChain_.reset();
    pendingLatencyCompensationReset_.store(true, std::memory_order_release);
}

int MixEngine::addMasterEffect(const std::string& pluginId, int position)
{
    // A node created or destroyed here invalidates the automation plan's
    // resolved parameter handles. Flag rather than rebuild: this function
    // holds chainsMutex_, and refreshAutomationPlan() takes it. The envelope
    // applier thread services the flag on its next pass.
    automationBindingsDirty_.store(true, std::memory_order_release);
    // TWO-STRIKE: same as addEffect — plugin instantiation inside lock.
    // Needs createPluginOffline / insertPreparedPlugin split in EffectChainManager.
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    if (!masterEffectChain_)
    {
        masterEffectChain_ = std::make_shared<EffectChainManager>();
        masterEffectChain_->setPluginRegistry(pluginRegistry_.get());
        masterEffectChain_->init(preparedSampleRate_, preparedBlockSize_);
    }
    const int nodeId = masterEffectChain_->addEffect(pluginId, position);
    if (nodeId >= 0)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return nodeId;
}

bool MixEngine::removeMasterEffect(int nodeId)
{
    // A node created or destroyed here invalidates the automation plan's
    // resolved parameter handles. Flag rather than rebuild: this function
    // holds chainsMutex_, and refreshAutomationPlan() takes it. The envelope
    // applier thread services the flag on its next pass.
    automationBindingsDirty_.store(true, std::memory_order_release);
    // Close editor before destroying the node (trackId = -1 = master chain).
    editorHost_->closeEditor(-1, nodeId);

    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    if (!masterEffectChain_) return false;
    const bool ok = masterEffectChain_->removeEffect(nodeId);
    if (ok)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return ok;
}

bool MixEngine::moveMasterEffect(int nodeId, int newPosition)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    if (!masterEffectChain_) return false;
    const bool ok = masterEffectChain_->moveEffect(nodeId, newPosition);
    if (ok)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return ok;
}

bool MixEngine::setMasterEffectBypass(int nodeId, bool bypassed)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    if (!masterEffectChain_) return false;
    const bool ok = masterEffectChain_->setBypass(nodeId, bypassed);
    if (ok)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return ok;
}

std::string MixEngine::getMasterEffectChainState() const
{
    nlohmann::json state;
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        if (!masterEffectChain_) return "[]";
        state = masterEffectChain_->getChainState();
    }
    return state.dump();
}

// ── Stable effect-instance lookup ─────────────────────────────────────────────

int MixEngine::getEffectNodeIdForInstance(int trackId,
                                          const std::string& effectInstanceId) const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (trackId < 0)
        return masterEffectChain_
            ? masterEffectChain_->getNodeIdForEffectInstance(effectInstanceId) : -1;
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return -1;
    return it->second->getNodeIdForEffectInstance(effectInstanceId);
}

std::string MixEngine::getEffectInstanceIdForNode(int trackId, int nodeId) const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (trackId < 0)
        return masterEffectChain_
            ? masterEffectChain_->getEffectInstanceIdForNode(nodeId) : std::string{};
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return std::string{};
    return it->second->getEffectInstanceIdForNode(nodeId);
}

bool MixEngine::isEffectInstanceSidechainCapable(int trackId,
                                                 const std::string& effectInstanceId) const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (trackId < 0)
        return masterEffectChain_
            && masterEffectChain_->isEffectInstanceSidechainCapable(effectInstanceId);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    return it->second->isEffectInstanceSidechainCapable(effectInstanceId);
}

// ── FX Chain Library ─────────────────────────────────────────────────────────

nlohmann::json MixEngine::applyEffectChainPreset(int trackId, const nlohmann::json& effects,
                                                 bool replace)
{
    // Nodes may be created or destroyed here — the automation plan's resolved
    // parameter handles have to be rebuilt. See addEffect's note on why this
    // flags rather than rebuilds inline.
    automationBindingsDirty_.store(true, std::memory_order_release);
    // TWO-STRIKE: like loadEffectChainFromJSON, this instantiates every plugin in
    // the preset (DLL load + prepareToPlay) inside the lock. Held deliberately for
    // the whole rebuild rather than per effect: releasing between slots would let
    // the audio thread render a partially assembled chain.
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};

    EffectChainManager* chain = nullptr;
    if (trackId < 0)
    {
        if (!masterEffectChain_)
        {
            masterEffectChain_ = std::make_shared<EffectChainManager>();
            masterEffectChain_->setPluginRegistry(pluginRegistry_.get());
            masterEffectChain_->init(preparedSampleRate_, preparedBlockSize_);
        }
        chain = masterEffectChain_.get();
    }
    else
    {
        auto& slot = effectChains_[trackId];
        if (!slot)
        {
            slot = std::make_shared<EffectChainManager>();
            slot->setPluginRegistry(pluginRegistry_.get());
            slot->init(preparedSampleRate_, preparedBlockSize_);
        }
        chain = slot.get();
    }

    nlohmann::json result = chain->applyChainPreset(effects, replace);
    if (result.value("ok", false))
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return result;
}

// ── Effect chain serialization ───────────────────────────────────────────────

nlohmann::json MixEngine::getEffectChainJSON(int trackId) const
{
    // TWO-STRIKE: graphToJSON() serialises per-plugin APVTS state (getStateInformation)
    // which can take 50-200ms per VST under load. Splitting requires EffectChainManager
    // to separate topology snapshot (fast, lock-needed) from state serialisation
    // (slow, could run lock-free on a stable snapshot). Flagged for a follow-up pass.
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return nlohmann::json::object();
    return it->second->graphToJSON();
}

nlohmann::json MixEngine::getMasterEffectChainJSON() const
{
    // TWO-STRIKE: same as getEffectChainJSON — APVTS state serialisation under lock.
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return nlohmann::json::object();
    return masterEffectChain_->graphToJSON();
}

bool MixEngine::loadEffectChainFromJSON(int trackId, const nlohmann::json& j)
{
    // Nodes may be created or destroyed here — the automation plan's resolved
    // parameter handles have to be rebuilt. See addEffect's note on why this
    // flags rather than rebuilds inline.
    automationBindingsDirty_.store(true, std::memory_order_release);
    // TWO-STRIKE: graphFromJSON() instantiates every plugin in the chain (bulk DLL
    // load + prepareToPlay) inside the lock. A two-phase split — offline construction
    // then locked graph splice — requires EffectChainManager API changes.
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    auto& chain = effectChains_[trackId];
    if (!chain) {
        chain = std::make_shared<EffectChainManager>();
        chain->setPluginRegistry(pluginRegistry_.get());
        chain->init(preparedSampleRate_, preparedBlockSize_);
    }
    const bool ok = chain->graphFromJSON(j);
    if (ok)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return ok;
}

bool MixEngine::loadMasterEffectChainFromJSON(const nlohmann::json& j)
{
    // Nodes may be created or destroyed here — the automation plan's resolved
    // parameter handles have to be rebuilt. See addEffect's note on why this
    // flags rather than rebuilds inline.
    automationBindingsDirty_.store(true, std::memory_order_release);
    // TWO-STRIKE: same as loadEffectChainFromJSON — bulk plugin instantiation inside lock.
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    if (!masterEffectChain_) {
        masterEffectChain_ = std::make_shared<EffectChainManager>();
        masterEffectChain_->setPluginRegistry(pluginRegistry_.get());
        masterEffectChain_->init(preparedSampleRate_, preparedBlockSize_);
    }
    const bool ok = masterEffectChain_->graphFromJSON(j);
    if (ok)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return ok;
}

// ── Missing-plugin support ──────────────────────────────────────────────────

std::string MixEngine::getMissingPluginsJSON() const
{
    nlohmann::json arr = nlohmann::json::array();
    {
    std::lock_guard<std::mutex> lock(chainsMutex_);

    auto appendMissing = [&](int trackId, const EffectChainManager* chain)
    {
        if (!chain) return;
        for (const auto& node : chain->getMissingNodesJSON())
        {
            nlohmann::json entry = node;
            entry["trackId"] = trackId;

            // Enrich with human-readable name by reading the processor's display name.
            // PassthroughProcessor::getName() returns "[Missing: OriginalName]" — strip the wrapper.
            const int nid = node.value("nodeId", -1);
            juce::AudioProcessor* proc = nid >= 0
                ? const_cast<EffectChainManager*>(chain)->getProcessor(nid)
                : nullptr;

            std::string displayName = node.value("pluginId", "Unknown");
            if (proc)
            {
                const std::string raw = proc->getName().toStdString();
                constexpr auto prefix = "[Missing: ";
                constexpr auto prefixLen = 10; // strlen("[Missing: ")
                if (raw.size() > prefixLen + 1
                        && raw.substr(0, prefixLen) == prefix
                        && raw.back() == ']')
                    displayName = raw.substr(prefixLen, raw.size() - prefixLen - 1);
                else
                    displayName = raw;
            }
            entry["pluginName"]   = displayName;
            // The graph reports the vendor of VST placeholders (P2); keep it.
            if (!entry.contains("pluginVendor"))
                entry["pluginVendor"] = "";
            entry["filePath"]     = "";

            arr.push_back(entry);
        }
    };

    for (const auto& [tid, chain] : effectChains_)
        appendMissing(tid, chain.get());
    appendMissing(-1, masterEffectChain_.get());
    } // release chainsMutex_
    return arr.dump();
}

bool MixEngine::tryResolvePlugin(int trackId, int nodeId)
{
    // Nodes may be created or destroyed here — the automation plan's resolved
    // parameter handles have to be rebuilt. See addEffect's note on why this
    // flags rather than rebuilds inline.
    automationBindingsDirty_.store(true, std::memory_order_release);
    // TWO-STRIKE: tryResolvePlugin instantiates the real VST (replaces placeholder)
    // inside the lock. Same two-phase split needed as addEffect.
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    if (!pluginRegistry_) return false;

    if (trackId == -1)
    {
        if (!masterEffectChain_) return false;
        const bool ok = masterEffectChain_->tryResolvePlugin(nodeId, *pluginRegistry_);
        if (ok)
            pendingLatencyCompensationReset_.store(true, std::memory_order_release);
        return ok;
    }
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    const bool ok = it->second->tryResolvePlugin(nodeId, *pluginRegistry_);
    if (ok)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return ok;
}

void MixEngine::removeAllMissingPlugins()
{
    // Nodes may be created or destroyed here — the automation plan's resolved
    // parameter handles have to be rebuilt. See addEffect's note on why this
    // flags rather than rebuilds inline.
    automationBindingsDirty_.store(true, std::memory_order_release);
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};

    auto removeFromChain = [&](EffectChainManager* chain)
    {
        if (!chain) return;
        const auto missingJson = chain->getMissingNodesJSON();
        for (const auto& node : missingJson)
        {
            const int nid = node.value("nodeId", -1);
            if (nid >= 0) chain->removeEffect(nid);
        }
    };

    for (auto& [tid, chain] : effectChains_)
        removeFromChain(chain.get());
    removeFromChain(masterEffectChain_.get());
}

bool MixEngine::resetCrashedPlugin(int trackId, int nodeId)
{
    // Nodes may be created or destroyed here — the automation plan's resolved
    // parameter handles have to be rebuilt. See addEffect's note on why this
    // flags rather than rebuilds inline.
    automationBindingsDirty_.store(true, std::memory_order_release);
    // TWO-STRIKE: resetCrashedPlugin re-initialises a crashed VST (prepareToPlay +
    // state restore) inside the lock. Plugin re-init time is unbounded.
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    if (trackId == -1)
    {
        if (!masterEffectChain_) return false;
        const bool ok = masterEffectChain_->resetCrashedPlugin(nodeId);
        if (ok)
            pendingLatencyCompensationReset_.store(true, std::memory_order_release);
        return ok;
    }
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    const bool ok = it->second->resetCrashedPlugin(nodeId);
    if (ok)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return ok;
}

// ── Graph-mode routing (per-track) ──────────────────────────────────────────

bool MixEngine::addConnection(int trackId, int sourceNodeId, int destNodeId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    return it->second->addConnection(sourceNodeId, destNodeId);
}

bool MixEngine::removeConnection(int trackId, int sourceNodeId, int destNodeId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    return it->second->removeConnection(sourceNodeId, destNodeId);
}

bool MixEngine::setWireGain(int trackId, int srcId, int dstId, float gain)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    return it->second->setWireGain(srcId, dstId, gain);
}

bool MixEngine::setWireMute(int trackId, int srcId, int dstId, bool muted)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    return it->second->setWireMute(srcId, dstId, muted);
}

void MixEngine::setNodePosition(int trackId, int nodeId, float x, float y)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return;
    it->second->setNodePosition(nodeId, x, y);
}

std::string MixEngine::getGraphTopology(int trackId) const
{
    nlohmann::json topology;
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        auto it = effectChains_.find(trackId);
        if (it == effectChains_.end() || !it->second) return "{}";
        topology = it->second->getGraphTopology();
    }
    return topology.dump();
}

bool MixEngine::isGraphLinear(int trackId) const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return true;
    return it->second->isGraphLinear();
}

// ── Graph-owned effect instance lifecycle (FXG.3-b) ─────────────────────────
// Master track stays chain-only — reject trackId < 0 (master sentinel).
// Auto-init the per-track chain on first add (mirrors addEffect) so graph mode
// gets its own EffectChainManager. These never call addEffect/moveEffect.

int MixEngine::addGraphEffectNode(int trackId, const std::string& effectInstanceId,
                                  const std::string& pluginId)
{
    if (trackId < 0) return -1;  // master track is chain-only

    // TWO-STRIKE: addGraphNode instantiates the VST inside the lock.
    // Same two-phase split needed as addEffect.
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    auto& chain = effectChains_[trackId];
    if (!chain)
    {
        chain = std::make_shared<EffectChainManager>();
        chain->setPluginRegistry(pluginRegistry_.get());
        chain->init(preparedSampleRate_, preparedBlockSize_);
    }
    const int nodeId = chain->addGraphNode(effectInstanceId, pluginId);
    if (nodeId >= 0)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return nodeId;
}

nlohmann::json MixEngine::hydrateGraphEffectNodes(int trackId,
                                                  const nlohmann::json& graphEffectNodes)
{
    nlohmann::json rejected = {
        {"ok", false},
        {"mapping", nlohmann::json::object()},
        {"skipped", nlohmann::json::array()},
        {"failures", nlohmann::json::array()},
    };

    if (trackId < 0)
    {
        rejected["reason"] = "master_track";
        return rejected;
    }
    if (!graphEffectNodes.is_array())
    {
        rejected["reason"] = "invalid_nodes";
        return rejected;
    }
    if (graphEffectNodes.empty())
    {
        rejected["ok"] = true;
        rejected.erase("reason");
        return rejected;
    }

    // TWO-STRIKE: hydrateGraphNodes instantiates multiple VSTs inside the lock.
    // Needs a two-phase split in EffectChainManager (offline construct, locked splice).
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    auto& chain = effectChains_[trackId];
    if (!chain)
    {
        chain = std::make_shared<EffectChainManager>();
        chain->setPluginRegistry(pluginRegistry_.get());
        chain->init(preparedSampleRate_, preparedBlockSize_);
    }

    const int beforeCount = chain->getEffectCount();
    nlohmann::json result = chain->hydrateGraphNodes(graphEffectNodes);
    if (chain->getEffectCount() > beforeCount)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return result;
}

bool MixEngine::removeGraphEffectNode(int trackId, const std::string& effectInstanceId)
{
    // Nodes may be created or destroyed here — the automation plan's resolved
    // parameter handles have to be rebuilt. See addEffect's note on why this
    // flags rather than rebuilds inline.
    automationBindingsDirty_.store(true, std::memory_order_release);
    if (trackId < 0) return false;  // master track is chain-only

    // Resolve the engine node id under the lock, then release it before closing
    // any open editor. closePluginEditor takes chainsMutex_ itself, so holding
    // it here would deadlock; this mirrors removeEffect's close-before-destroy.
    int nodeId = -1;
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        ChainSnapshotPublisher chainSnapshotPublisher{this};
        auto it = effectChains_.find(trackId);
        if (it == effectChains_.end() || !it->second) return false;
        nodeId = it->second->getGraphNodeEngineId(effectInstanceId);
    }
    if (nodeId < 0) return false;

    closePluginEditor(trackId, nodeId);

    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    const bool ok = it->second->removeGraphNode(effectInstanceId);
    if (ok)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return ok;
}

int MixEngine::getGraphEffectEngineNodeId(int trackId, const std::string& effectInstanceId) const
{
    if (trackId < 0) return -1;  // master track is chain-only

    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return -1;
    return it->second->getGraphNodeEngineId(effectInstanceId);
}

// ── Graph-mode routing (master) ─────────────────────────────────────────────

nlohmann::json MixEngine::syncGraphTopology(int trackId, const nlohmann::json& topology)
{
    if (trackId < 0)
    {
        return {
            {"ok", false},
            {"phase", "FXG.3-d"},
            {"reason", "master_track"},
            {"fallback", "none"},
            {"fallbackApplied", false},
            {"pathEffectCount", 0},
            {"appliedConnectionCount", 0},
        };
    }

    // TWO-STRIKE: syncGraphTopology rebuilds the full routing graph (may create and
    // connect nodes) inside the lock. Splitting requires EffectChainManager changes.
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    auto& chain = effectChains_[trackId];
    if (!chain)
    {
        chain = std::make_shared<EffectChainManager>();
        chain->setPluginRegistry(pluginRegistry_.get());
        chain->init(preparedSampleRate_, preparedBlockSize_);
    }

    nlohmann::json result = chain->syncGraphTopology(topology);
    pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return result;
}

nlohmann::json MixEngine::syncLinearGraphTopology(int trackId, const nlohmann::json& topology)
{
    // Backward-compatible alias; syncGraphTopology now also handles parallel
    // (fan-out/fan-in) topologies.
    return syncGraphTopology(trackId, topology);
}

nlohmann::json MixEngine::adoptGraphEffectNodes(int trackId, const nlohmann::json& mapping)
{
    if (trackId < 0)
    {
        return {
            {"ok", false},
            {"reason", "master_track"},
            {"adopted", nlohmann::json::object()},
            {"skipped", nlohmann::json::array()},
        };
    }

    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second)
    {
        return {
            {"ok", false},
            {"reason", "no_chain"},
            {"adopted", nlohmann::json::object()},
            {"skipped", nlohmann::json::array()},
        };
    }

    return it->second->adoptGraphNodes(mapping);
}

bool MixEngine::addMasterConnection(int sourceNodeId, int destNodeId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    if (!masterEffectChain_) return false;
    return masterEffectChain_->addConnection(sourceNodeId, destNodeId);
}

bool MixEngine::removeMasterConnection(int sourceNodeId, int destNodeId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    if (!masterEffectChain_) return false;
    return masterEffectChain_->removeConnection(sourceNodeId, destNodeId);
}

bool MixEngine::setMasterWireGain(int srcId, int dstId, float gain)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    if (!masterEffectChain_) return false;
    return masterEffectChain_->setWireGain(srcId, dstId, gain);
}

bool MixEngine::setMasterWireMute(int srcId, int dstId, bool muted)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    if (!masterEffectChain_) return false;
    return masterEffectChain_->setWireMute(srcId, dstId, muted);
}

void MixEngine::setMasterNodePosition(int nodeId, float x, float y)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    if (!masterEffectChain_) return;
    masterEffectChain_->setNodePosition(nodeId, x, y);
}

std::string MixEngine::getMasterGraphTopology() const
{
    nlohmann::json topology;
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        if (!masterEffectChain_) return "{}";
        topology = masterEffectChain_->getGraphTopology();
    }
    return topology.dump();
}

bool MixEngine::isMasterGraphLinear() const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return true;
    return masterEffectChain_->isGraphLinear();
}

// ── Effect parameter / meter access ─────────────────────────────────────────

// ─── FXG.4-a graph-owned effect parameter descriptors ───────────────────────

std::string MixEngine::getGraphEffectParameters(int trackId, const std::string& effectInstanceId) const
{
    if (trackId < 0)
        return nlohmann::json({ {"ok", false}, {"reason", "master_track"},
                                {"effectInstanceId", effectInstanceId} }).dump();

    nlohmann::json out;
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        auto it = effectChains_.find(trackId);
        if (it == effectChains_.end() || !it->second)
            return nlohmann::json({ {"ok", false}, {"reason", "track_not_found"},
                                    {"trackId", trackId}, {"effectInstanceId", effectInstanceId} }).dump();
        out = it->second->getGraphEffectParameters(effectInstanceId);
    }
    out["trackId"] = trackId;
    return out.dump();
}

std::string MixEngine::getGraphEffectParameterValue(int trackId, const std::string& effectInstanceId,
                                                    const std::string& parameterId) const
{
    if (trackId < 0)
        return nlohmann::json({ {"ok", false}, {"reason", "master_track"},
                                {"effectInstanceId", effectInstanceId} }).dump();

    nlohmann::json out;
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        auto it = effectChains_.find(trackId);
        if (it == effectChains_.end() || !it->second)
            return nlohmann::json({ {"ok", false}, {"reason", "track_not_found"},
                                    {"trackId", trackId}, {"effectInstanceId", effectInstanceId} }).dump();
        out = it->second->getGraphEffectParameterValue(effectInstanceId, parameterId);
    }
    out["trackId"] = trackId;
    return out.dump();
}

std::string MixEngine::setGraphEffectParameterNormalized(int trackId, const std::string& effectInstanceId,
                                                         const std::string& parameterId,
                                                         double normalizedValue)
{
    if (trackId < 0)
        return nlohmann::json({ {"ok", false}, {"reason", "master_track"},
                                {"effectInstanceId", effectInstanceId} }).dump();

    nlohmann::json out;
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        auto it = effectChains_.find(trackId);
        if (it == effectChains_.end() || !it->second)
            return nlohmann::json({ {"ok", false}, {"reason", "track_not_found"},
                                    {"trackId", trackId}, {"effectInstanceId", effectInstanceId} }).dump();
        out = it->second->setGraphEffectParameterNormalized(
            effectInstanceId, parameterId, static_cast<float>(normalizedValue));
    }
    out["trackId"] = trackId;
    if (out.value("ok", false))
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return out.dump();
}

bool MixEngine::setGraphEffectParameterNormalizedValueOnly(int trackId,
                                                          const std::string& effectInstanceId,
                                                          const std::string& parameterId,
                                                          double normalizedValue)
{
    if (trackId < 0) return false;

    bool ok = false;
    bool latencyChanged = false;
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        auto it = effectChains_.find(trackId);
        if (it == effectChains_.end() || !it->second) return false;

        // Compare the chain's latency epoch across the write: a value-only write
        // that did not move the effect's reported latency needs no PDC recompute.
        const std::uint64_t epochBefore = it->second->getLatencyEpoch();
        nlohmann::json out = it->second->setGraphEffectParameterNormalized(
            effectInstanceId, parameterId, static_cast<float>(normalizedValue));
        ok = out.value("ok", false);
        latencyChanged = it->second->getLatencyEpoch() != epochBefore;
    }

    if (ok && latencyChanged)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return ok;
}

// ── FX Graph Envelope Controller → parameter modulation ──────────────────────

void MixEngine::refreshEnvelopeDefinitions()
{
    if (timeline_ == nullptr) {
        std::lock_guard<std::mutex> lock(envelopeSnapshotMutex_);
        envelopeSnapshotLive_.store(nullptr, std::memory_order_release);
        if (envelopeSnapshotOwner_) {
            envelopeSnapshotRetired_.emplace_back(
                std::move(envelopeSnapshotOwner_),
                envelopeAudioEpoch_.load(std::memory_order_acquire));
        }
        return;
    }

    // Parse + gate derivation happens entirely here, on the message thread.
    auto next = xleth::envmod::buildEnvelopeModulationSnapshot(*timeline_);

    // Augment the snapshot with the in-effect filter Envelope's per-track gates —
    // a live effect-chain concern the model-side builder can't see. Safe to
    // mutate: `next` is uniquely held and not yet published.
    if (next)
        populateFilterEnvelopeGates(
            *std::const_pointer_cast<xleth::envmod::EnvelopeModulationSnapshot>(next));

    std::lock_guard<std::mutex> lock(envelopeSnapshotMutex_);

    // Publish, then retire the previous snapshot with the epoch observed NOW.
    // Ordering matters: the store must be the release, so an audio thread that
    // sees the new pointer also sees a fully constructed snapshot.
    auto previous = std::move(envelopeSnapshotOwner_);
    envelopeSnapshotOwner_ = next;
    envelopeSnapshotLive_.store(next.get(), std::memory_order_release);

    const std::uint64_t epochAtPublish = envelopeAudioEpoch_.load(std::memory_order_acquire);
    if (previous)
        envelopeSnapshotRetired_.emplace_back(std::move(previous), epochAtPublish);

    // Deferred destruction. A retired snapshot is unreachable from the audio
    // thread once EITHER holds:
    //   * the audio epoch has moved past the publication epoch — the audio thread
    //     has begun a block that started after the new pointer was stored, so it
    //     cannot still be holding the old one; or
    //   * no audio thread is inside the evaluator at all — a thread entering from
    //     now on can only load the new pointer, because the store above already
    //     happened.
    const std::uint64_t epochNow = envelopeAudioEpoch_.load(std::memory_order_acquire);
    const bool inBlock = envelopeAudioInBlock_.load(std::memory_order_acquire);
    envelopeSnapshotRetired_.erase(
        std::remove_if(envelopeSnapshotRetired_.begin(), envelopeSnapshotRetired_.end(),
                       [epochNow, inBlock](const auto& entry) {
                           return epochNow > entry.second || !inBlock;
                       }),
        envelopeSnapshotRetired_.end());
}

void MixEngine::populateFilterEnvelopeGates(xleth::envmod::EnvelopeModulationSnapshot& snapshot)
{
    if (timeline_ == nullptr) return;

    // Gather (trackId, wantSlides) for every chain holding a filter with an
    // active Envelope modulator UNDER the chains lock, then release it before the
    // (allocating) gate build so the audio thread's per-block try_lock is never
    // starved by a long timeline scan. No caller of refreshEnvelopeDefinitions
    // holds chainsMutex_, so this cannot deadlock.
    struct Req { int trackId; bool wantSlides; };
    std::vector<Req> reqs;
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        for (auto& kv : effectChains_)
        {
            if (!kv.second) continue;
            bool wantSlides = false;
            if (kv.second->anyFilterHasActiveEnvelope(wantSlides))
                reqs.push_back({ kv.first, wantSlides });
        }
    }

    for (const auto& r : reqs)
    {
        auto build = xleth::envmod::buildTrackGateIntervals(*timeline_, r.trackId, r.wantSlides);
        snapshot.filterTrackGates[r.trackId] =
            xleth::envmod::buildGateTimeline(std::move(build.intervals));
    }
}

void MixEngine::resolveFilterGatesFromSnapshot(
    const xleth::envmod::EnvelopeModulationSnapshot& snapshot,
    int64_t positionSamples, double bpm, double sampleRate, bool atRest) noexcept
{
    filterGateCount_ = 0;
    // On stop-release (atRest) or with no valid clock, leave no gates — every
    // filter Envelope then reads invalid → env 0 → exactly its base.
    if (atRest || !(bpm > 0.0) || !(sampleRate > 0.0)) return;

    for (const auto& kv : snapshot.filterTrackGates)
    {
        if (filterGateCount_ >= kMaxTracks) break;
        const auto view = xleth::envmod::makeGateView(kv.second);
        const auto rg = xleth::envmod::resolveActiveGateAtSample(
            view, positionSamples, bpm, sampleRate);
        auto& e   = filterGates_[filterGateCount_++];
        e.trackId = kv.first;
        e.valid   = rg.valid;
        e.start   = rg.gateStartSample;
        e.end     = rg.gateEndSample;
    }
}

std::shared_ptr<const xleth::envmod::EnvelopeModulationSnapshot>
MixEngine::getEnvelopeModulationSnapshotForTesting() const
{
    std::lock_guard<std::mutex> lock(envelopeSnapshotMutex_);
    return envelopeSnapshotOwner_;
}

void MixEngine::evaluateEnvelopeModulation(int64_t positionSamples,
                                           double  bpm,
                                           double  sampleRate,
                                           bool    atRest) noexcept
{
    // Bump the epoch BEFORE loading the pointer, and hold the in-block flag for
    // exactly as long as the snapshot pointer is live in this frame. Everything
    // below is a read of immutable memory plus relaxed atomic stores: no
    // allocation, no locks, no logging, no system calls.
    envelopeAudioEpoch_.fetch_add(1, std::memory_order_acq_rel);

    struct InBlockScope
    {
        std::atomic<bool>& flag;
        explicit InBlockScope(std::atomic<bool>& f) : flag(f)
        {
            flag.store(true, std::memory_order_release);
        }
        ~InBlockScope() { flag.store(false, std::memory_order_release); }
    } inBlockScope{envelopeAudioInBlock_};

    const auto* snapshot = envelopeSnapshotLive_.load(std::memory_order_acquire);
    if (snapshot == nullptr) { filterGateCount_ = 0; return; }

    // In-effect filter Envelope gates ride the SAME snapshot + epoch guard.
    // Resolved before the mailbox early-outs below because a project can carry
    // filter envelopes with no graph envelopes at all (empty mailbox path).
    resolveFilterGatesFromSnapshot(*snapshot, positionSamples, bpm, sampleRate, atRest);

    if (snapshot->mailboxes == nullptr || snapshot->mailboxCount <= 0) return;
    if (!(bpm > 0.0) || !(sampleRate > 0.0)) return;

    const int edgeCount = static_cast<int>(snapshot->edges.size());

    for (const auto& envelope : snapshot->envelopes)
    {
        const auto shape = xleth::envmod::envelopeShapeToSamples(envelope.shape, sampleRate);

        // atRest is the stop release: publish env == 0, which every modulation
        // mapping turns into exactly its authored `base`. There is no value this
        // path can write that discards the user's parameter setting.
        double env = 0.0;
        if (!atRest) {
            const auto gates = xleth::envmod::makeGateView(envelope.gates);
            env = xleth::envmod::evaluateEnvelopeAtSample(
                shape, gates, positionSamples, bpm, sampleRate);
        }

        for (int i = 0; i < envelope.edgeCount; ++i)
        {
            const int edgeIndex = envelope.edgeOffset + i;
            if (edgeIndex < 0 || edgeIndex >= edgeCount) break;

            const auto& edge = snapshot->edges[edgeIndex];
            if (edge.mailboxIndex < 0 || edge.mailboxIndex >= snapshot->mailboxCount) continue;

            const double value = xleth::envmod::evaluateModulationMapping(edge.mapping, env);

            auto& mailbox = snapshot->mailboxes[edge.mailboxIndex];
            mailbox.value.store(static_cast<float>(value), std::memory_order_relaxed);
            mailbox.seq.fetch_add(1, std::memory_order_release);
        }
    }
}

int MixEngine::applyPendingEnvelopeModulation()
{
    std::shared_ptr<const xleth::envmod::EnvelopeModulationSnapshot> snapshot;
    {
        std::lock_guard<std::mutex> lock(envelopeSnapshotMutex_);
        snapshot = envelopeSnapshotOwner_;
    }
    if (!snapshot || snapshot->mailboxCount <= 0 || snapshot->mailboxes == nullptr)
        return 0;

    // A new snapshot resets the per-mailbox seq tracking (indices are only
    // meaningful within one snapshot). The value dedupe is keyed by target
    // identity, so it survives the rebuild and an unchanged parameter is not
    // rewritten just because the graph was edited elsewhere.
    if (envelopeDrainedSnapshot_ != snapshot) {
        envelopeDrainedSnapshot_ = snapshot;
        envelopeDrainedSeqs_.assign(static_cast<std::size_t>(snapshot->mailboxCount), 0u);
    }

    int written = 0;
    for (int i = 0; i < snapshot->mailboxCount; ++i)
    {
        const std::uint32_t seq = snapshot->mailboxes[i].seq.load(std::memory_order_acquire);
        // seq == 0 means the audio thread has never evaluated this mailbox (the
        // transport has not run since publication), so there is nothing to apply
        // and the parameter keeps its authored value.
        if (seq == 0) continue;
        if (seq == envelopeDrainedSeqs_[static_cast<std::size_t>(i)]) continue;
        envelopeDrainedSeqs_[static_cast<std::size_t>(i)] = seq;

        const float value = snapshot->mailboxes[i].value.load(std::memory_order_relaxed);
        const auto& target = snapshot->mailboxTargets[static_cast<std::size_t>(i)];

        EnvelopeApplierKey key;
        key.trackId          = target.trackId;
        key.effectInstanceId = target.effectInstanceId;
        key.parameterId      = target.parameterId;

        auto it = envelopeAppliedValues_.find(key);
        if (it != envelopeAppliedValues_.end() && std::fabs(it->second - value) <= 1.0e-5f)
            continue;

        if (setGraphEffectParameterNormalizedValueOnly(
                target.trackId, target.effectInstanceId, target.parameterId, value)) {
            envelopeAppliedValues_[key] = value;
            ++written;
        }
    }

    return written;
}

// ── Effect-chain reset (off the audio thread) ───────────────────────────────

void MixEngine::requestEffectChainReset() noexcept
{
    // AUDIO THREAD. Non-realtime renders reset inline under chainsMutex_ (the
    // export thread may block), which keeps an export deterministic. Live
    // playback only posts: AudioProcessor::reset() is not realtime-safe.
    if (nonRealtime_.load(std::memory_order_relaxed))
        pendingEffectChainReset_ = true;
    else
        effectResetRequestGen_.fetch_add(1, std::memory_order_release);
}

void MixEngine::requestJumpChainReset() noexcept
{
    // AUDIO THREAD. See jumpChainResetPending_: realtime resets in this block,
    // on this thread; an export keeps its inline full reset.
    if (nonRealtime_.load(std::memory_order_relaxed))
        pendingEffectChainReset_ = true;
    else
        jumpChainResetPending_ = true;
}

int MixEngine::serviceEffectChainResets()
{
    const uint64_t requested = effectResetRequestGen_.load(std::memory_order_acquire);
    const uint64_t jumpRequested = jumpResetRequestGen_.load(std::memory_order_acquire);
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (requested == effectResetServicedGen_ && jumpRequested == jumpResetServicedGen_) return 0;

    // A stop resets whole chains. A jump already reset them on the audio
    // thread; the worker finishes only what that left, never re-resetting a
    // node the jump block reset (that would restore the misalignment).
    const bool full = requested != effectResetServicedGen_;

    const std::shared_ptr<const ChainSnapshot> chains =
        chainSnapshot_.load(std::memory_order_acquire);

    // A failed claim means the audio thread is inside that chain for the rest
    // of its block, so a short yield-retry succeeds within a fraction of a
    // block. Bounded so a stalled device can never wedge this thread (or the
    // chains lock it holds); anything left over is retried on the next poll.
    const auto resetOne = [full](EffectChainManager* chain) -> bool
    {
        if (chain == nullptr || !chain->isInitialized()) return true;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(50);
        while (full ? !chain->tryResetProcessorsOffThread()
                    : !chain->tryResetDeferredOffThread())
        {
            if (std::chrono::steady_clock::now() >= deadline) return false;
            std::this_thread::yield();
        }
        return true;
    };

    // Two-phase: the expensive part of a reset (the Pitch Shifter's spare
    // shifter) is primed WITHOUT the claim, while the audio thread keeps
    // playing the chain, so the claimed reset below is a swap and the chain is
    // silent for microseconds rather than for the whole prime.
    const auto primeAll = [&chains]
    {
        const auto primeOne = [](EffectChainManager* chain)
        {
            if (chain != nullptr && chain->isInitialized())
                chain->primeDeferredReset();
        };
        for (const auto& entry : chains->tracks)
            primeOne(entry.chain.get());
        primeOne(chains->master.get());
    };

    bool allReset = true;
    if (chains)
    {
        // After a jump this re-primes what the jump block's swaps consumed, so
        // an effect that declined for want of a spare swaps under the claim
        // below instead of priming there. After a stop it is normally a no-op.
        primeAll();

        for (const auto& entry : chains->tracks)
            allReset = resetOne(entry.chain.get()) && allReset;
        allReset = resetOne(chains->master.get()) && allReset;

        // Replenish the spares this pass consumed, now, so the NEXT seek's
        // reset does not first wait out a prime while the chain plays on
        // unreset audio.
        primeAll();
    }

    // Requests that arrived during the pass stay pending (requested was read
    // first), so a seek that lands mid-reset still gets its own reset.
    if (allReset)
    {
        effectResetServicedGen_ = requested;
        jumpResetServicedGen_ = jumpRequested;
    }
    return 1;
}

void MixEngine::startEnvelopeApplierThread()
{
    if (envelopeApplierRunning_.exchange(true)) return;

    envelopeApplierThread_ = std::thread([this] {
        // The applier is the last hop only. Evaluation already happened on the
        // audio thread at sample accuracy; this thread exists solely because the
        // parameter write path (juce parameter setters, SEH-guarded plugin calls,
        // a possible graph rebuild) is not realtime-safe and must not run inside
        // the audio callback.
        while (envelopeApplierRunning_.load(std::memory_order_acquire))
        {
            const int written = applyPendingEnvelopeModulation();
            // LFO modulation drains into disjoint parameter targets through the
            // same value-only setter, guarded by the same chainsMutex_ — riding
            // this thread costs nothing but a second, cheap mailbox scan, so no
            // second applier thread is started for it.
            const int lfoWritten = applyPendingLfoModulation();
            // Automation does NOT drain through a mailbox — its values are
            // written in the same audio block that evaluated them, which is what
            // makes export match live playback. What this thread does for it is
            // the one job that genuinely cannot happen on the audio callback:
            // re-resolving parameter handles after a chain mutation.
            const int automationRebuilt = refreshAutomationPlanIfDirty();
            // Effect-chain resets posted by the audio thread (seek, stop, play
            // after an audition) — reset() cannot run in the callback.
            const int chainsReset = serviceEffectChainResets();
            // [PDCNotify] An effect latency change that bypassed every owner
            // path (e.g. an EQ band RPC) leaves its chain's PDC stale; recompute
            // it here, off the audio thread. Coalesced: any number of changes
            // between two passes cost one recompute per affected chain.
            const int latencyRecomputed = servicePendingLatencyChanges();
            // Back off when idle so a stopped transport costs almost nothing,
            // and stay tight while modulation is actually moving.
            std::this_thread::sleep_for((written > 0 || lfoWritten > 0 || automationRebuilt > 0
                                         || chainsReset > 0 || latencyRecomputed > 0)
                                                   ? std::chrono::milliseconds(1)
                                                   : std::chrono::milliseconds(10));
        }
    });
}

void MixEngine::stopEnvelopeApplierThread()
{
    if (!envelopeApplierRunning_.exchange(false)) return;
    if (envelopeApplierThread_.joinable())
        envelopeApplierThread_.join();
}

// ── FX Graph LFO Modulator → parameter modulation ─────────────────────────────

void MixEngine::refreshLfoDefinitions()
{
    if (timeline_ == nullptr) {
        std::lock_guard<std::mutex> lock(lfoSnapshotMutex_);
        lfoSnapshotLive_.store(nullptr, std::memory_order_release);
        if (lfoSnapshotOwner_) {
            lfoSnapshotRetired_.emplace_back(
                std::move(lfoSnapshotOwner_),
                lfoAudioEpoch_.load(std::memory_order_acquire));
        }
        return;
    }

    // Parse happens entirely here, on the message thread. Unlike the Envelope
    // snapshot, this does NOT derive gates or audibility — see
    // buildLfoModulationSnapshot's doc comment.
    auto next = xleth::lfomod::buildLfoModulationSnapshot(*timeline_);

    std::lock_guard<std::mutex> lock(lfoSnapshotMutex_);

    // Publish, then retire the previous snapshot with the epoch observed NOW.
    // Same ordering argument as refreshEnvelopeDefinitions above.
    auto previous = std::move(lfoSnapshotOwner_);
    lfoSnapshotOwner_ = next;
    lfoSnapshotLive_.store(next.get(), std::memory_order_release);

    const std::uint64_t epochAtPublish = lfoAudioEpoch_.load(std::memory_order_acquire);
    if (previous)
        lfoSnapshotRetired_.emplace_back(std::move(previous), epochAtPublish);

    const std::uint64_t epochNow = lfoAudioEpoch_.load(std::memory_order_acquire);
    const bool inBlock = lfoAudioInBlock_.load(std::memory_order_acquire);
    lfoSnapshotRetired_.erase(
        std::remove_if(lfoSnapshotRetired_.begin(), lfoSnapshotRetired_.end(),
                       [epochNow, inBlock](const auto& entry) {
                           return epochNow > entry.second || !inBlock;
                       }),
        lfoSnapshotRetired_.end());
}

std::shared_ptr<const xleth::lfomod::LfoModulationSnapshot>
MixEngine::getLfoModulationSnapshotForTesting() const
{
    std::lock_guard<std::mutex> lock(lfoSnapshotMutex_);
    return lfoSnapshotOwner_;
}

void MixEngine::evaluateLfoModulation(int64_t positionSamples,
                                      double  bpm,
                                      double  sampleRate,
                                      bool    atRest) noexcept
{
    // Same epoch-bump + single-atomic-load discipline as evaluateEnvelopeModulation.
    lfoAudioEpoch_.fetch_add(1, std::memory_order_acq_rel);

    struct InBlockScope
    {
        std::atomic<bool>& flag;
        explicit InBlockScope(std::atomic<bool>& f) : flag(f)
        {
            flag.store(true, std::memory_order_release);
        }
        ~InBlockScope() { flag.store(false, std::memory_order_release); }
    } inBlockScope{lfoAudioInBlock_};

    const auto* snapshot = lfoSnapshotLive_.load(std::memory_order_acquire);
    if (snapshot == nullptr) return;
    if (snapshot->mailboxes == nullptr || snapshot->mailboxCount <= 0) return;
    if (!atRest && (!(bpm > 0.0) || !(sampleRate > 0.0))) return;

    // Route-aware mute/solo audibility, computed fresh every block. Unlike
    // Envelope (which bakes this into the snapshot at PREPARE time via
    // omitted gates), buildLfoModulationSnapshot deliberately does NOT
    // consult mute/solo — an LFO's neutral bipolar-0 sample rescales to
    // unipolar 0.5, which does not generally equal `base`, so "go inert"
    // cannot be expressed by omitting structure the way Envelope's gate
    // timeline can. This mirrors buildEnvelopeModulationSnapshot's own use
    // of xleth::buildRoutePlan, just moved from PREPARE time to EVALUATE
    // time, once per block. The track list comes from the same generation-
    // gated snapshot processBlock uses — timeline_->getAllTracks() builds and
    // sorts a fresh vector, which would allocate on every callback.
    refreshTrackSnapshotIfNeeded();
    xleth::RoutePlanSlotInput routeInputs[xleth::RoutePlan::kMaxSlots];
    int slotCount = 0;
    if (timeline_ != nullptr) {
        for (int ti = 0; ti < cachedTrackSnapshotCount_; ++ti) {
            const auto* t = cachedTrackSnapshot_[ti];
            if (t == nullptr || slotCount >= xleth::RoutePlan::kMaxSlots) continue;
            xleth::fillRoutePlanSlotInput(routeInputs[slotCount], *t);
            ++slotCount;
        }
    }
    xleth::RoutePlan routePlan;
    xleth::buildRoutePlan(routeInputs, slotCount, routePlan);

    const auto isTrackAudible = [&routeInputs, &routePlan, slotCount](int trackId) noexcept -> bool {
        for (int i = 0; i < slotCount; ++i)
            if (routeInputs[i].trackId == trackId)
                return routePlan.audible[i];
        return false; // track not found (deleted this block) -> treat as inaudible
    };

    const int edgeCount = static_cast<int>(snapshot->edges.size());

    for (const auto& lfoEntry : snapshot->lfos)
    {
        for (int i = 0; i < lfoEntry.edgeCount; ++i)
        {
            const int edgeIndex = lfoEntry.edgeOffset + i;
            if (edgeIndex < 0 || edgeIndex >= edgeCount) break;

            const auto& edge = snapshot->edges[edgeIndex];
            if (edge.mailboxIndex < 0 || edge.mailboxIndex >= snapshot->mailboxCount) continue;

            const auto& target = snapshot->mailboxTargets[static_cast<std::size_t>(edge.mailboxIndex)];
            const bool inert = atRest || !isTrackAudible(target.trackId);

            double value;
            if (inert) {
                // Bypass evaluateModulationMapping entirely: an LFO's neutral
                // sample does not generally map to `base`, so the only correct
                // "settle" value is the authored base itself, written directly.
                value = edge.mapping.base;
            } else {
                const double bipolar = xleth::lfomod::evaluateLfoAtPosition(
                    lfoEntry.shape, positionSamples, bpm, sampleRate);
                const double unipolar = (bipolar + 1.0) * 0.5;
                value = xleth::envmod::evaluateModulationMapping(edge.mapping, unipolar);
            }

            auto& mailbox = snapshot->mailboxes[edge.mailboxIndex];
            mailbox.value.store(static_cast<float>(value), std::memory_order_relaxed);
            mailbox.seq.fetch_add(1, std::memory_order_release);
        }
    }
}

int MixEngine::applyPendingLfoModulation()
{
    std::shared_ptr<const xleth::lfomod::LfoModulationSnapshot> snapshot;
    {
        std::lock_guard<std::mutex> lock(lfoSnapshotMutex_);
        snapshot = lfoSnapshotOwner_;
    }
    if (!snapshot || snapshot->mailboxCount <= 0 || snapshot->mailboxes == nullptr)
        return 0;

    if (lfoDrainedSnapshot_ != snapshot) {
        lfoDrainedSnapshot_ = snapshot;
        lfoDrainedSeqs_.assign(static_cast<std::size_t>(snapshot->mailboxCount), 0u);
    }

    int written = 0;
    for (int i = 0; i < snapshot->mailboxCount; ++i)
    {
        const std::uint32_t seq = snapshot->mailboxes[i].seq.load(std::memory_order_acquire);
        if (seq == 0) continue;
        if (seq == lfoDrainedSeqs_[static_cast<std::size_t>(i)]) continue;
        lfoDrainedSeqs_[static_cast<std::size_t>(i)] = seq;

        const float value = snapshot->mailboxes[i].value.load(std::memory_order_relaxed);
        const auto& target = snapshot->mailboxTargets[static_cast<std::size_t>(i)];

        LfoApplierKey key;
        key.trackId          = target.trackId;
        key.effectInstanceId = target.effectInstanceId;
        key.parameterId      = target.parameterId;

        auto it = lfoAppliedValues_.find(key);
        if (it != lfoAppliedValues_.end() && std::fabs(it->second - value) <= 1.0e-5f)
            continue;

        if (setGraphEffectParameterNormalizedValueOnly(
                target.trackId, target.effectInstanceId, target.parameterId, value)) {
            lfoAppliedValues_[key] = value;
            ++written;
        }
    }

    return written;
}

// ── Automation clips (Phase A) ───────────────────────────────────────────────

namespace {

// Resolve a binding's owner chain. -1 addresses the Master chain, matching the
// convention every other trackId-keyed effect API in this file uses.
EffectChainManager* automationChainFor(
    int trackId,
    const std::unordered_map<int, std::shared_ptr<EffectChainManager>>& chains,
    const std::shared_ptr<EffectChainManager>& master)
{
    if (trackId < 0) return master.get();
    auto it = chains.find(trackId);
    return it == chains.end() ? nullptr : it->second.get();
}

} // namespace

// ─── Lock-free chain snapshot (Finding 9) ───────────────────────────────────
//
// The audio thread used to hold chainsMutex_ across the whole per-track and
// master effect region and, when the try_lock missed, skipped every chain for
// that block — a dry block, an audible level jump. Measured on a real session
// (16 tracks x 3 inserts + 2 master inserts, 441-sample blocks) the miss rate
// was 0% at idle but 1.9% under ordinary 60 Hz mixer metering, 1.45% during a
// knob drag, and up to 94.4% while effects were being added and removed.
//
// This publishes an immutable index over the SAME EffectChainManager objects
// effectChains_/masterEffectChain_ own. Both properties matter:
//   - immutable, so the audio thread can read it with no lock at all;
//   - the same objects, so an offline render (which still takes the blocking
//     lock and reads the map) and live playback drive identical DSP. Nothing
//     is copied, re-created or re-ordered, so nothing can diverge.
void MixEngine::publishChainSnapshotLocked()
{
    // PRECONDITION: chainsMutex_ is held by this thread.
    auto snapshot = std::make_shared<ChainSnapshot>();
    snapshot->generation = ++chainSnapshotGeneration_;

    snapshot->tracks.reserve(effectChains_.size());
    for (auto& [trackId, chain] : effectChains_)
    {
        if (!chain) continue;
        // Refresh the chain's own node view first: the audio thread reads that
        // view live, so it must already describe the topology this publish is
        // announcing rather than the one before the mutation.
        chain->refreshRealtimeView();

        ChainSnapshot::TrackEntry entry;
        entry.trackId = trackId;
        entry.chain   = chain;
        snapshot->tracks.push_back(std::move(entry));
    }
    std::sort(snapshot->tracks.begin(), snapshot->tracks.end(),
              [](const ChainSnapshot::TrackEntry& a, const ChainSnapshot::TrackEntry& b)
              { return a.trackId < b.trackId; });

    if (masterEffectChain_)
    {
        masterEffectChain_->refreshRealtimeView();
        snapshot->master = masterEffectChain_;
    }

    // The automation runtime travels WITH the chains it was resolved against,
    // so a target can never address an effect this snapshot does not pin.
    snapshot->automation = automationRuntime_;

    auto previous = chainSnapshot_.exchange(
        std::shared_ptr<const ChainSnapshot>(std::move(snapshot)),
        std::memory_order_acq_rel);

    // Retire, never free here. A superseded snapshot may still be in use by the
    // block currently running; if the audio thread dropped the last reference it
    // would run EffectChainManager (and plugin) destructors on the realtime
    // thread. Holding it on this list guarantees the message thread is the one
    // that lets go.
    if (previous)
        retiredChainSnapshots_.push_back(std::move(previous));

    // Prune only entries this list alone owns: use_count()==1 proves no audio
    // block still holds a copy, and no new copy can appear because the snapshot
    // is no longer reachable through chainSnapshot_.
    retiredChainSnapshots_.erase(
        std::remove_if(retiredChainSnapshots_.begin(), retiredChainSnapshots_.end(),
                       [](const std::shared_ptr<const ChainSnapshot>& s)
                       { return s.use_count() == 1; }),
        retiredChainSnapshots_.end());
}

bool MixEngine::pollSourceTransformTable()
{
    return pollSourceTransformTableAt(ClipRenderCache::nowMs());
}

// ── Clip mode settle timer ──────────────────────────────────────────────────
// One-shot in effect: armed for kSourceTransformSettleMs by every queued
// change (re-arming restarts it — that is the settle), it flushes and stops.
// juce::Timer callbacks run on the message thread, which is the only thread
// that touches the settle queue.
class MixEngine::SourceTransformSettleTimer : public juce::Timer
{
public:
    explicit SourceTransformSettleTimer(MixEngine& e) : engine_(e) {}
    ~SourceTransformSettleTimer() override { stopTimer(); }

    void timerCallback() override
    {
        stopTimer();
        engine_.flushSourceTransformInvalidations(ClipRenderCache::nowMs());
        // A change queued during the flush re-arms through the queue itself.
        if (engine_.hasPendingSourceTransformInvalidation())
            startTimer(static_cast<int>(MixEngine::kSourceTransformSettleMs));
    }

private:
    MixEngine& engine_;
};

bool MixEngine::pollSourceTransformTableAt(int64_t nowMs, bool blocking)
{
    bool republished = false;
    {
        std::unique_lock<std::mutex> lock(chainsMutex_, std::defer_lock);
        if (blocking) lock.lock();
        else          lock.try_lock();

        // The no-change path: an in-place walk against the cached stamps. No
        // allocation, no publish.
        if (lock.owns_lock()
            && xleth::sourceTransformSnapshotChanged(effectChains_, sourceTransformSnapshot_))
        {
            const auto before = currentSourceTransformTable();
            auto built = xleth::buildTrackSourceTransformTable(effectChains_);
            sourceTransformSnapshot_ = std::move(built.snapshot);
            publishSourceTransformTableLocked(std::move(built.table));
            queueSourceTransformChanges(*before, *currentSourceTransformTable(), nowMs);
            republished = true;
        }
    }

    // A due settle flushes on any poll, changed or not (no-op when idle).
    flushSourceTransformInvalidations(nowMs);
    return republished;
}

void MixEngine::queueSourceTransformChanges(const xleth::TrackSourceTransformTable& before,
                                            const xleth::TrackSourceTransformTable& after,
                                            int64_t nowMs)
{
    // Both tables are sorted by trackId: one merge walk. Only render identity
    // counts — a different provider node with the same transform (a duplicate
    // shifter removed, say) re-renders nothing.
    std::size_t i = 0, j = 0;
    bool queued = false;
    auto queue = [&](int trackId)
    {
        const auto it = std::lower_bound(fxInvalidationTracks_.begin(), fxInvalidationTracks_.end(), trackId);
        if (it == fxInvalidationTracks_.end() || *it != trackId)
            fxInvalidationTracks_.insert(it, trackId);
        queued = true;
    };
    while (i < before.entries.size() || j < after.entries.size())
    {
        if (j >= after.entries.size()
            || (i < before.entries.size() && before.entries[i].trackId < after.entries[j].trackId))
        {
            queue(before.entries[i++].trackId);
        }
        else if (i >= before.entries.size() || after.entries[j].trackId < before.entries[i].trackId)
        {
            queue(after.entries[j++].trackId);
        }
        else
        {
            if (before.entries[i].transform != after.entries[j].transform)
                queue(after.entries[j].trackId);
            ++i; ++j;
        }
    }
    if (!queued) return;

    fxInvalidationPending_      = true;
    fxInvalidationLastChangeMs_ = nowMs;
    if (juce::MessageManager::getInstanceWithoutCreating() != nullptr)
    {
        if (!fxSettleTimer_)
            fxSettleTimer_ = std::make_unique<SourceTransformSettleTimer>(*this);
        fxSettleTimer_->startTimer(static_cast<int>(kSourceTransformSettleMs));
    }
}

int MixEngine::flushSourceTransformInvalidations(int64_t nowMs, bool force)
{
    if (!fxInvalidationPending_) return 0;
    if (!force && nowMs - fxInvalidationLastChangeMs_ < kSourceTransformSettleMs) return 0;

    fxInvalidationPending_ = false;
    std::vector<int> tracks;
    tracks.swap(fxInvalidationTracks_);
    if (timeline_ == nullptr) return 0;

    std::vector<int> clipIds;
    for (const Clip* c : timeline_->getAllClips())
        if (c != nullptr && std::binary_search(tracks.begin(), tracks.end(), c->trackId))
            clipIds.push_back(c->id);

    if (!clipIds.empty())
        invalidateClipCaches(clipIds, "fxTransform");
    return static_cast<int>(clipIds.size());
}

void MixEngine::serviceClipRenderCache()
{
    clipMissScratch_.clear();
    clipRenderCache_.drainMisses(clipMissScratch_);

    if (!clipMissScratch_.empty() && timeline_ != nullptr)
    {
        // Duplicates are possible across drains; a clip on a track that is
        // still settling is the flush's job, not ours — resubmitting it here
        // would render every intermediate step of a sweep.
        std::sort(clipMissScratch_.begin(), clipMissScratch_.end());
        clipMissScratch_.erase(std::unique(clipMissScratch_.begin(), clipMissScratch_.end()),
                               clipMissScratch_.end());
        if (fxInvalidationPending_)
        {
            clipMissScratch_.erase(
                std::remove_if(clipMissScratch_.begin(), clipMissScratch_.end(),
                               [this](int id)
                               {
                                   const Clip* c = timeline_->getClip(id);
                                   return c != nullptr
                                       && std::binary_search(fxInvalidationTracks_.begin(),
                                                             fxInvalidationTracks_.end(), c->trackId);
                               }),
                clipMissScratch_.end());
        }
        if (!clipMissScratch_.empty())
            invalidateClipCaches(clipMissScratch_, "cacheMiss");
    }

    flushSourceTransformInvalidations(ClipRenderCache::nowMs());
}

void MixEngine::prepareSourceTransformsForExport()
{
    const int64_t now = ClipRenderCache::nowMs();
    pollSourceTransformTableAt(now, /*blocking=*/true);
    flushSourceTransformInvalidations(now, /*force=*/true);
}

CacheKey MixEngine::withSourceTransform(CacheKey key, const xleth::SourceTransform& t) noexcept
{
    key.fxPitchSemis = t.semis;
    key.fxPitchCents = t.cents;
    // A provider never reports Global (0); if one ever did, 0 would silently
    // mean "no fx" here, so fall back to Rubber Band, the provider's default.
    key.fxMethod     = (t.method >= 1 && t.method <= 5) ? t.method : 2;
    key.fxFormant    = t.formant;
    return key;
}

bool MixEngine::clipNeedsCacheRender(const Clip& clip) const
{
    const bool ownProcessing = (clip.pitchOffset != 0 || clip.pitchOffsetCents != 0
                             || clip.reversed || clip.stretchRatio != 1.0);
    return ownProcessing || currentSourceTransformTable()->find(clip.trackId) != nullptr;
}

bool MixEngine::isClipCacheReady(int clipId) const
{
    if (!timeline_ || !sampleBank_) return true;
    const Clip* clip = timeline_->getClip(clipId);
    if (!clip) return true;

    const bool ownProcessing = (clip->pitchOffset != 0 || clip->pitchOffsetCents != 0
                             || clip->reversed || clip->stretchRatio != 1.0);
    if (ownProcessing && getClipProcessedBuffer(clipId) == nullptr) return false;
    if (currentSourceTransformTable()->find(clip->trackId) != nullptr
        && getClipFxProcessedBuffer(clipId) == nullptr) return false;
    return true;
}

std::shared_ptr<const juce::AudioBuffer<float>> MixEngine::getClipFxProcessedBuffer(int clipId) const
{
    if (!timeline_ || !sampleBank_) return nullptr;
    const Clip* clip = timeline_->getClip(clipId);
    if (!clip) return nullptr;

    const auto table = currentSourceTransformTable();
    const auto* fx = table->find(clip->trackId);
    if (!fx) return nullptr;

    const auto regionMap = loadRegionSampleMap();
    auto it = regionMap->find(clip->regionId);
    if (it == regionMap->end()) return nullptr;
    const juce::AudioBuffer<float>* srcBuf = sampleBank_->getSample(it->second);
    if (!srcBuf) return nullptr;

    return clipRenderCache_.getProcessedBuffer(
        clipId, withSourceTransform(buildClipCacheKey(*clip, *srcBuf), *fx));
}

void MixEngine::publishSourceTransformTableLocked(xleth::TrackSourceTransformTable table)
{
    // PRECONDITION: chainsMutex_ is held by this thread.
    table.generation = ++sourceTransformGeneration_;

    auto previous = sourceTransformTable_.exchange(
        std::make_shared<const xleth::TrackSourceTransformTable>(std::move(table)),
        std::memory_order_acq_rel);

    // Retire, never free here — see publishChainSnapshotLocked. Prune only the
    // tables this list alone still owns.
    if (previous)
        retiredSourceTransformTables_.push_back(std::move(previous));
    retiredSourceTransformTables_.erase(
        std::remove_if(retiredSourceTransformTables_.begin(), retiredSourceTransformTables_.end(),
                       [](const std::shared_ptr<const xleth::TrackSourceTransformTable>& t)
                       { return t.use_count() == 1; }),
        retiredSourceTransformTables_.end());
}

void MixEngine::refreshAutomationPlan()
{
    if (timeline_ == nullptr) return;

    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};

    // The plan builder asks two questions this class is the only one able to
    // answer: does this binding address a live stock parameter (dead-clip
    // detection), and what does that parameter currently read (the base value a
    // project has never recorded). Both are resolved here, under the same lock
    // that will hold while the plan is used.
    auto resolver = [this](const AutomationBinding& b) {
        EffectChainManager* chain =
            automationChainFor(b.ownerTrackId, effectChains_, masterEffectChain_);
        return chain != nullptr && chain->canAutomate(b.effectInstanceId, b.parameterId);
    };
    auto baseResolver = [this](const AutomationBinding& b, double& out) {
        EffectChainManager* chain =
            automationChainFor(b.ownerTrackId, effectChains_, masterEffectChain_);
        return chain != nullptr
            && chain->getAutomationParameterNormalized(b.effectInstanceId, b.parameterId, out);
    };

    auto plan = std::make_shared<xleth::automation::AutomationPlan>();
    xleth::automation::buildAutomationPlan(*timeline_, resolver, baseResolver, *plan);

    auto runtime = std::make_shared<AutomationRuntime>();
    runtime->plan = plan;
    runtime->targets.resize(static_cast<std::size_t>(plan->targetCount));

    for (int i = 0; i < plan->targetCount; ++i)
    {
        const auto& target = plan->targets[i];
        auto& rt = runtime->targets[static_cast<std::size_t>(i)];
        rt.trackId = target.ownerTrackId;

        EffectChainManager* chain =
            automationChainFor(target.ownerTrackId, effectChains_, masterEffectChain_);
        if (chain == nullptr) continue;

        const auto handle =
            chain->resolveAutomationParameter(target.effectInstanceId, target.parameterId);
        if (!handle.valid()) continue;

        rt.raw    = handle.raw;
        rt.param  = handle.param;
        rt.nodeId = chain->getNodeIdForEffectInstance(target.effectInstanceId);
        rt.effect = chain->getEffect(rt.nodeId);
        if (rt.effect == nullptr) { rt.raw = nullptr; rt.param = nullptr; continue; }
        ++runtime->resolvedCount;
    }

    // Swap. The previous runtime dies here, on the message thread, while this
    // thread holds chainsMutex_ — so the audio thread cannot be inside
    // applyAutomationForBlock reading it.
    automationRuntime_ = std::move(runtime);
    automationBindingsDirty_.store(false, std::memory_order_release);
}

int MixEngine::refreshAutomationPlanIfDirty()
{
    if (!automationBindingsDirty_.load(std::memory_order_acquire)) return 0;
    refreshAutomationPlan();
    return 1;
}

nlohmann::json MixEngine::getAutomationPlanDiagnostics() const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    nlohmann::json j = nlohmann::json::object();
    if (!automationRuntime_ || !automationRuntime_->plan) {
        j["targetCount"]     = 0;
        j["windowCount"]     = 0;
        j["pointCount"]      = 0;
        j["overflowed"]      = false;
        j["droppedTargets"]  = 0;
        j["droppedWindows"]  = 0;
        j["unresolvedClips"] = 0;
        j["resolvedTargets"] = 0;
        return j;
    }
    const auto& p = *automationRuntime_->plan;
    j["targetCount"]     = p.targetCount;
    j["windowCount"]     = p.windowCount;
    j["pointCount"]      = p.pointCount;
    j["overflowed"]      = p.overflowed;
    j["droppedTargets"]  = p.droppedTargetCount;
    j["droppedWindows"]  = p.droppedWindowCount;
    j["unresolvedClips"] = p.unresolvedClipCount;
    j["resolvedTargets"] = automationRuntime_->resolvedCount;
    return j;
}

bool MixEngine::isAutomationBindingResolvable(int ownerTrackId,
                                              const std::string& effectInstanceId,
                                              const std::string& parameterId) const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    EffectChainManager* chain =
        automationChainFor(ownerTrackId, effectChains_, masterEffectChain_);
    return chain != nullptr && chain->canAutomate(effectInstanceId, parameterId);
}

bool MixEngine::getAutomationParameterNormalized(int ownerTrackId,
                                                 const std::string& effectInstanceId,
                                                 const std::string& parameterId,
                                                 double& outValue) const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    EffectChainManager* chain =
        automationChainFor(ownerTrackId, effectChains_, masterEffectChain_);
    return chain != nullptr
        && chain->getAutomationParameterNormalized(effectInstanceId, parameterId, outValue);
}

double MixEngine::evaluateAutomationAtTick(int ownerTrackId,
                                           const std::string& effectInstanceId,
                                           const std::string& parameterId,
                                           int64_t tick, bool& found) const
{
    found = false;
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!automationRuntime_ || !automationRuntime_->plan) return 0.0;
    const auto& plan = *automationRuntime_->plan;
    for (int i = 0; i < plan.targetCount; ++i) {
        const auto& t = plan.targets[i];
        if (t.ownerTrackId != ownerTrackId) continue;
        if (t.effectInstanceId != effectInstanceId) continue;
        if (t.parameterId != parameterId) continue;
        found = true;
        return xleth::automation::evaluateTarget(plan, i, tick);
    }
    return 0.0;
}

void MixEngine::applyAutomationForBlock(const ChainSnapshot& chains, int64_t tick) noexcept
{
    // AUDIO THREAD. No lock is held (Finding 9): everything comes out of
    // `chains`, which is immutable and pins both the runtime and the effect
    // instances its targets address. Allocation-free and log-free.
    AutomationRuntime* runtime = chains.automation.get();
    if (runtime == nullptr) return;
    const xleth::automation::AutomationPlan* plan = runtime->plan.get();
    if (plan == nullptr || plan->targetCount <= 0) return;

    const int n = std::min(plan->targetCount, static_cast<int>(runtime->targets.size()));
    for (int i = 0; i < n; ++i)
    {
        AutomationRuntimeTarget& rt = runtime->targets[static_cast<std::size_t>(i)];
        if (rt.raw == nullptr || rt.param == nullptr) continue;   // dead clip / VST3

        // Liveness: re-derive the effect from this snapshot's view of its chain
        // and confirm it is the same object the plan resolved. A removed effect
        // yields nullptr (or a different pointer, since node ids are monotonic
        // and never reused), and the target is skipped rather than written
        // through a stale pointer. The view is immutable and holds a strong
        // reference to every processor it names, so the comparison itself can
        // never race a removal or read freed memory.
        const EffectChainManager* chain =
            (rt.trackId < 0) ? chains.master.get()
                             : (chains.find(rt.trackId) != nullptr
                                    ? chains.find(rt.trackId)->chain.get()
                                    : nullptr);
        if (chain == nullptr) continue;
        const auto view = chain->realtimeView();
        if (!view) continue;
        if (AudioGraph::effectFor(*view, rt.nodeId) != rt.effect) continue;

        const double v = xleth::automation::evaluateTarget(*plan, i, tick);
        const float normalized = static_cast<float>(v < 0.0 ? 0.0 : (v > 1.0 ? 1.0 : v));
        const float denorm = rt.param->convertFrom0to1(normalized);

        // The effect reads this atomic once per block; writing an unchanged
        // value would only add store traffic.
        if (rt.everWritten && rt.lastWritten == denorm) continue;
        rt.raw->store(denorm, std::memory_order_relaxed);
        rt.lastWritten = denorm;
        rt.everWritten = true;
    }
}

std::string MixEngine::getEffectParameters(int trackId, int nodeId) const
{
    if (trackId == -1) return getMasterEffectParameters(nodeId);
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return "[]";
    return it->second->getEffectParameters(nodeId);
}

bool MixEngine::setEffectParameter(int trackId, int nodeId, const std::string& paramId, float value)
{
    // trackId == -1 selects the master chain (header contract). The master
    // variant takes chainsMutex_ itself — early-return before locking here.
    if (trackId == -1) return setMasterEffectParameter(nodeId, paramId, value);
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return false;
    const bool ok = it->second->setEffectParameter(nodeId, paramId, value);
    if (ok)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return ok;
}

bool MixEngine::setEffectProgram(int trackId, int nodeId, int programIndex)
{
    // TWO-STRIKE: setCurrentProgram is plugin-defined and may trigger full state
    // restoration (unbounded time). The entire call must be serialised under the lock
    // so the audio thread never sees a half-restored state; no safe split exists.
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    EffectChainManager* chain = nullptr;
    if (trackId == -1)
    {
        chain = masterEffectChain_.get();
    }
    else
    {
        auto it = effectChains_.find(trackId);
        if (it != effectChains_.end())
            chain = it->second.get();
    }

    if (chain == nullptr)
        return false;

    const bool ok = chain->setEffectProgram(nodeId, programIndex);
    if (ok)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return ok;
}

bool MixEngine::setEffectStateInformation(int trackId,
                                          int nodeId,
                                          const void* data,
                                          int sizeInBytes)
{
    // TWO-STRIKE: setStateInformation is plugin-defined and can be slow (XML parse,
    // sample-bank restore, etc.). The swap must be atomic from the audio thread's
    // perspective, so the entire restore must stay under the lock; no safe split.
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};
    EffectChainManager* chain = nullptr;
    if (trackId == -1)
    {
        chain = masterEffectChain_.get();
    }
    else
    {
        auto it = effectChains_.find(trackId);
        if (it != effectChains_.end())
            chain = it->second.get();
    }

    if (chain == nullptr)
        return false;

    const bool ok = chain->setEffectStateInformation(nodeId, data, sizeInBytes);
    if (ok)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return ok;
}

bool MixEngine::refreshGuardedPluginLatency(int trackId, int nodeId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};

    EffectChainManager* chain = nullptr;
    if (trackId == -1)
    {
        chain = masterEffectChain_.get();
    }
    else
    {
        auto it = effectChains_.find(trackId);
        if (it != effectChains_.end())
            chain = it->second.get();
    }

    if (chain == nullptr)
        return false;

    const bool changed = chain->refreshGuardedPluginLatency(nodeId);
    if (changed)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return changed;
}

bool MixEngine::refreshGuardedPluginLatency(
    int trackId,
    int nodeId,
    std::uint64_t latencyPublishCountBefore)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};

    EffectChainManager* chain = nullptr;
    if (trackId == -1)
    {
        chain = masterEffectChain_.get();
    }
    else
    {
        auto it = effectChains_.find(trackId);
        if (it != effectChains_.end())
            chain = it->second.get();
    }

    if (chain == nullptr)
        return false;

    const bool changed =
        chain->refreshGuardedPluginLatency(nodeId, latencyPublishCountBefore);
    if (changed)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return changed;
}

std::string MixEngine::getEffectMeter(int trackId, int nodeId) const
{
    if (trackId == -1) return getMasterEffectMeter(nodeId);
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return "[0,0,0,0,0,0,0,0]";
    return it->second->getEffectMeter(nodeId);
}

std::string MixEngine::getMasterEffectParameters(int nodeId) const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return "[]";
    return masterEffectChain_->getEffectParameters(nodeId);
}

bool MixEngine::setMasterEffectParameter(int nodeId, const std::string& paramId, float value)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return false;
    const bool ok = masterEffectChain_->setEffectParameter(nodeId, paramId, value);
    if (ok)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return ok;
}

std::string MixEngine::getMasterEffectMeter(int nodeId) const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return "[0,0,0,0,0,0,0,0]";
    return masterEffectChain_->getEffectMeter(nodeId);
}

// ── Direct effect pointer access ────────────────────────────────────────────

XlethEffectBase* MixEngine::getEffectPtr(int trackId, int nodeId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    auto it = effectChains_.find(trackId);
    if (it == effectChains_.end() || !it->second) return nullptr;
    return it->second->getEffect(nodeId);
}

XlethEffectBase* MixEngine::getMasterEffectPtr(int nodeId)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    if (!masterEffectChain_) return nullptr;
    return masterEffectChain_->getEffect(nodeId);
}

// ── Visual Echo delay binding ───────────────────────────────────────────────

xleth::echo::DelaySnapshot MixEngine::resolveDelaySnapshot(int trackId, int nodeId) const
{
    xleth::echo::DelaySnapshot snap;
    if (nodeId < 0) return snap;

    // Deliberately NOT reusing getEffectPtr: this is a const method on the render
    // path and must not hand a mutable effect pointer outward. The lookup is the
    // same two lines and the pointer never escapes this scope.
    XlethEffectBase* fx = nullptr;
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        if (trackId == -1) {
            if (masterEffectChain_) fx = masterEffectChain_->getEffect(nodeId);
        } else {
            auto it = effectChains_.find(trackId);
            if (it != effectChains_.end() && it->second)
                fx = it->second->getEffect(nodeId);
        }
    }
    if (!fx) return snap;

    // A binding that points at some other effect type is not an error — the user
    // can rebind or delete the Delay at any time, and the echo simply goes
    // inert until they point it at a Delay again.
    auto* delay = dynamic_cast<XlethDelayEffect*>(fx);
    if (!delay) return snap;

    float delaySamples = 0.0f, feedback01 = 0.0f;
    bool  pingPong     = false;
    if (!delay->getVisualEchoSnapshot(delaySamples, feedback01, pingPong))
        return snap;

    snap.valid        = true;
    snap.delaySamples = delaySamples;
    snap.feedback01   = feedback01;
    snap.pingPong     = pingPong;
    return snap;
}

// ── Effect visualization access ─────────────────────────────────────────────

void MixEngine::resetLatencyCompensationState()
{
    for (int i = 0; i < kMaxTracks; ++i)
    {
        trackCompensationDelays_[i].reset();
        cachedTrackInsertLatencySamples_[i] = 0;
        cachedTrackCompensationSamples_[i] = 0;
        cachedTrackLatencyEpochs_[i] = 0;
        for (int k = 0; k < kMaxTrackSends; ++k)
        {
            sendCompensationDelays_[i][k].reset();
            cachedSendCompensationSamples_[i][k] = 0;
        }
    }

    cachedMaxAudibleTrackLatencySamples_ = 0;
    cachedMasterInsertLatencySamples_ = 0;
    cachedMasterLatencyEpoch_ = 0;
}

void MixEngine::syncTrackCompensationDelayState(int slot,
                                                int compensationSamples,
                                                bool clearHistory)
{
    if (slot < 0 || slot >= kMaxTracks)
        return;

    compensationSamples = juce::jmax(0, compensationSamples);
    if (clearHistory)
        trackCompensationDelays_[slot].resetToDelaySamples(compensationSamples);
    else
        trackCompensationDelays_[slot].setTargetDelaySamples(compensationSamples);
}

void MixEngine::syncSendCompensationDelayState(int slot, bool clearHistory)
{
    if (slot < 0 || slot >= kMaxTracks)
        return;

    for (int k = 0; k < kMaxTrackSends; ++k)
    {
        const int comp = juce::jmax(0, cachedSendCompensationSamples_[slot][k]);
        if (clearHistory)
            sendCompensationDelays_[slot][k].resetToDelaySamples(comp);
        else
            sendCompensationDelays_[slot][k].setTargetDelaySamples(comp);
    }
}

int MixEngine::getTrackChainOutputLatencySamplesLocked(int trackId) const
{
    auto chainIt = effectChains_.find(trackId);
    if (chainIt == effectChains_.end() || !chainIt->second || !chainIt->second->isInitialized())
        return 0;

    return juce::jmax(0, chainIt->second->getOutputLatencySamples());
}

int MixEngine::buildRoutePdcPlanLocked(xleth::RoutePlan& plan,
                                       xleth::RoutePdcPlan& pdc,
                                       int* slotTrackIds) const
{
    xleth::RoutePlanSlotInput inputs[kMaxTracks];
    int chainLatencies[kMaxTracks] = {};
    int count = 0;

    if (timeline_ != nullptr)
    {
        for (const auto* t : timeline_->getAllTracks())
        {
            if (t == nullptr || count >= kMaxTracks) continue;
            xleth::fillRoutePlanSlotInput(inputs[count], *t);
            chainLatencies[count] = getTrackChainOutputLatencySamplesLocked(t->id);
            if (slotTrackIds != nullptr)
                slotTrackIds[count] = t->id;
            ++count;
        }
    }

    xleth::buildRoutePlan(inputs, count, plan);
    xleth::buildRoutePdcPlan(inputs, count, plan, chainLatencies, pdc);
    return count;
}

MixEngine::LatencyCompensationSnapshot MixEngine::computeLatencyCompensationSnapshotLocked() const
{
    LatencyCompensationSnapshot snapshot;
    snapshot.masterInsertLatencySamples =
        (masterEffectChain_ && masterEffectChain_->isInitialized())
            ? juce::jmax(0, masterEffectChain_->getOutputLatencySamples())
            : 0;

    if (timeline_ == nullptr)
        return snapshot;

    const auto allTracks = timeline_->getAllTracks();
    bool anySolo = false;
    for (const auto* track : allTracks)
    {
        if (track != nullptr && track->solo)
        {
            anySolo = true;
            break;
        }
    }

    for (const auto* track : allTracks)
    {
        if (track == nullptr) continue;

        const bool shouldPlay = anySolo ? track->solo : !track->muted;
        if (!shouldPlay || track->visualOnly)
            continue;

        snapshot.maxAudibleTrackLatencySamples = std::max(
            snapshot.maxAudibleTrackLatencySamples,
            getTrackChainOutputLatencySamplesLocked(track->id));
    }

    // Route-aware max path latency (Prompt 2C). For an unrouted project this
    // equals maxAudibleTrackLatencySamples (kept above with its legacy flat
    // semantics for diagnostics); for routed projects it is the deepest
    // contributing route path into the Master input junction.
    xleth::RoutePlan plan;
    xleth::RoutePdcPlan pdc;
    buildRoutePdcPlanLocked(plan, pdc, nullptr);
    snapshot.maxPathLatencySamples = pdc.maxPathLatencySamples;

    return snapshot;
}

MixEngine::LatencyCompensationSnapshot MixEngine::getLatencyCompensationSnapshot() const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    return computeLatencyCompensationSnapshotLocked();
}

int MixEngine::getTrackInsertLatencySamples(int trackId) const
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    return getTrackChainOutputLatencySamplesLocked(trackId);
}

int MixEngine::getTrackCompensationDelaySamples(int trackId) const
{
    if (timeline_ == nullptr)
        return 0;

    const TrackInfo* track = timeline_->getTrack(trackId);
    if (track == nullptr || track->visualOnly)
        return 0;

    // Junction PDC (Prompt 2C): the compensation applied immediately before
    // this track sums into its destination junction (bus input or Master).
    // For an unrouted project this reduces to the legacy flat value
    // (maxAudibleTrackLatency − ownLatency for audible tracks, else 0).
    std::lock_guard<std::mutex> lock(chainsMutex_);
    xleth::RoutePlan plan;
    xleth::RoutePdcPlan pdc;
    int slotTrackIds[kMaxTracks];
    const int count = buildRoutePdcPlanLocked(plan, pdc, slotTrackIds);
    for (int s = 0; s < count; ++s)
        if (slotTrackIds[s] == trackId)
            return pdc.branchCompensationSamples[s];
    return 0;
}

int MixEngine::getMaxAudibleTrackLatencySamples() const
{
    return getLatencyCompensationSnapshot().maxAudibleTrackLatencySamples;
}

int MixEngine::getMaxPathLatencySamples() const
{
    return getLatencyCompensationSnapshot().maxPathLatencySamples;
}

int MixEngine::getMasterInsertLatencySamples() const
{
    return getLatencyCompensationSnapshot().masterInsertLatencySamples;
}

bool MixEngine::isInterTrackLatencyCompensationApplied() const
{
    return true;
}

void MixEngine::refreshLatencyDiagnostics()
{
    std::lock_guard<std::mutex> lock(chainsMutex_);

    for (auto& [trackId, chain] : effectChains_)
    {
        juce::ignoreUnused(trackId);
        if (chain)
            chain->refreshLatencyDiagnostics();
    }

    if (masterEffectChain_)
        masterEffectChain_->refreshLatencyDiagnostics();
}

int MixEngine::servicePendingLatencyChanges()
{
    // [PDCNotify] NON-REALTIME (envelope applier thread, or a test). The
    // generation gate keeps an idle pass to one atomic load: chainsMutex_ is
    // only taken after some effect, somewhere, actually published a change.
    const std::uint64_t generation =
        xleth::audio::LatencyChangeSignal::generation().load(std::memory_order_acquire);
    if (latencyChangeGenerationSeen_.exchange(generation, std::memory_order_acq_rel) == generation)
        return 0;

    int recomputed = 0;
    {
        std::lock_guard<std::mutex> lock(chainsMutex_);
        for (auto& [trackId, chain] : effectChains_)
        {
            juce::ignoreUnused(trackId);
            if (chain && chain->servicePendingLatencyChange())
                ++recomputed;
        }
        if (masterEffectChain_ && masterEffectChain_->servicePendingLatencyChange())
            ++recomputed;
    }

    if (recomputed > 0)
    {
        // Same follow-up the generic owner path (setEffectParameter) gives a
        // latency change: the audio thread re-seeds compensation next block.
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
        latencyChangeServiceCount_.fetch_add(static_cast<std::uint64_t>(recomputed),
                                             std::memory_order_relaxed);
        std::fprintf(stderr, "[PDCNotify] recomputed PDC for %d chain(s) after a latency change "
                             "outside the owner paths\n", recomputed);
    }
    return recomputed;
}

int MixEngine::addProcessorForTesting(int trackId,
                                      const std::string& pluginId,
                                      std::unique_ptr<juce::AudioProcessor> proc,
                                      int position)
{
    std::lock_guard<std::mutex> lock(chainsMutex_);
    ChainSnapshotPublisher chainSnapshotPublisher{this};

    EffectChainManager* chain = nullptr;
    if (trackId == -1)
    {
        if (!masterEffectChain_)
        {
            masterEffectChain_ = std::make_shared<EffectChainManager>();
            masterEffectChain_->setPluginRegistry(pluginRegistry_.get());
            masterEffectChain_->init(preparedSampleRate_, preparedBlockSize_);
        }
        chain = masterEffectChain_.get();
    }
    else
    {
        auto& owned = effectChains_[trackId];
        if (!owned)
        {
            owned = std::make_shared<EffectChainManager>();
            owned->setPluginRegistry(pluginRegistry_.get());
            owned->init(preparedSampleRate_, preparedBlockSize_);
        }
        chain = owned.get();
    }

    const int nodeId = chain->addProcessorForTesting(pluginId, std::move(proc), position);
    if (nodeId >= 0)
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
    return nodeId;
}

bool MixEngine::setEffectVisualizationEnabled(int trackId, int nodeId, bool enabled)
{
    auto* effect = (trackId == -1)
        ? getMasterEffectPtr(nodeId)
        : getEffectPtr(trackId, nodeId);
    if (!effect) return false;
    effect->setVisualizationEnabled(enabled);
    return true;
}

std::size_t MixEngine::drainEffectVizFrames(int trackId, int nodeId,
                                            std::uint8_t* out, std::size_t maxBytes)
{
    auto* effect = (trackId == -1)
        ? getMasterEffectPtr(nodeId)
        : getEffectPtr(trackId, nodeId);
    if (!effect) return 0;
    return effect->drainVizFrames(out, maxBytes);
}

std::uint32_t MixEngine::getEffectVisualizationType(int trackId, int nodeId) const
{
    auto* effect = (trackId == -1)
        ? const_cast<MixEngine*>(this)->getMasterEffectPtr(nodeId)
        : const_cast<MixEngine*>(this)->getEffectPtr(trackId, nodeId);
    return effect ? effect->getVisualizationType() : 0u;
}

std::uint32_t MixEngine::getEffectVisualizationSchemaVersion(int trackId, int nodeId) const
{
    auto* effect = (trackId == -1)
        ? const_cast<MixEngine*>(this)->getMasterEffectPtr(nodeId)
        : const_cast<MixEngine*>(this)->getEffectPtr(trackId, nodeId);
    return effect ? effect->getVisualizationSchemaVersion() : 0u;
}

// ── Peak meter reads (slot-based via trackIdToSlot_) ─────────────────────────

float MixEngine::getTrackPeakL(int trackId) const
{
    std::shared_lock<std::shared_mutex> lock(slotMutex_);
    auto it = trackIdToSlot_.find(trackId);
    if (it == trackIdToSlot_.end()) return 0.0f;
    return trackPeaks_[it->second].peakL.load(std::memory_order_relaxed);
}

float MixEngine::getTrackPeakR(int trackId) const
{
    std::shared_lock<std::shared_mutex> lock(slotMutex_);
    auto it = trackIdToSlot_.find(trackId);
    if (it == trackIdToSlot_.end()) return 0.0f;
    return trackPeaks_[it->second].peakR.load(std::memory_order_relaxed);
}

// ── Track buffer management ──────────────────────────────────────────────────

void MixEngine::ensureTrackBuffers(int numSamples)
{
    if (trackBufferSize_ >= numSamples) return;

    // Re-allocate all track buffers (called rarely — only when buffer size grows)
    for (auto& buf : trackBuffers_)
        buf.setSize(2, numSamples, false, true, false);
    for (auto& buf : sidechainBuffers_)
        buf.setSize(2, numSamples, false, true, false);
    sendScratch_.setSize(2, numSamples, false, true, false);

    trackBufferSize_ = numSamples;
}

namespace {

// Allocation-free replacement for the per-block std::unordered_map<int,int>
// that mapped trackId -> track slot (Finding 2a). Track ids draw on
// Timeline's single global auto-increment counter shared with clips,
// regions, patterns, automation points and everything else — they are NOT
// small dense integers, so a raw trackId-indexed array would be an
// out-of-bounds write the moment a track is added after a few thousand
// other entities exist. Keying by a hash of the id instead of the id
// itself keeps this correct while staying entirely stack-allocated.
struct TrackSlotEntry { int trackId = -1; int slot = -1; };
constexpr int kTrackSlotTableCapacity = 128; // power of two, > 2*kMaxTracks (64) for a low load factor

inline uint32_t trackSlotHash(int trackId)
{
    return static_cast<uint32_t>(trackId) * 2654435761u; // Knuth multiplicative hash
}

inline void trackSlotTableInsert(TrackSlotEntry* table, int trackId, int slot)
{
    int idx = static_cast<int>(trackSlotHash(trackId) & (kTrackSlotTableCapacity - 1));
    while (table[idx].trackId != -1)
        idx = (idx + 1) & (kTrackSlotTableCapacity - 1);
    table[idx] = {trackId, slot};
}

// Returns the slot for trackId, or -1 if not present.
inline int trackSlotTableFind(const TrackSlotEntry* table, int trackId)
{
    int idx = static_cast<int>(trackSlotHash(trackId) & (kTrackSlotTableCapacity - 1));
    for (int probes = 0; probes < kTrackSlotTableCapacity; ++probes)
    {
        if (table[idx].trackId == -1) return -1;
        if (table[idx].trackId == trackId) return table[idx].slot;
        idx = (idx + 1) & (kTrackSlotTableCapacity - 1);
    }
    return -1;
}

} // namespace

// ── Per-block track snapshot cache (Finding 2b) ─────────────────────────────
// Rebuilds cachedTrackSnapshot_ from timeline_->getAllTracks() only when the
// track topology has actually changed since the last call. Audio-thread only:
// the occasional rebuild (on a real track add/remove/reorder) is the sole
// place this allocates — every other block is a relaxed load and compare.
void MixEngine::refreshTrackSnapshotIfNeeded()
{
    if (timeline_ == nullptr)
    {
        cachedTrackSnapshotCount_ = 0;
        return;
    }

    const uint64_t generation = timeline_->getTrackTopologyGeneration();
    if (generation == cachedTrackTopologyGeneration_) return;

    const auto allTracks = timeline_->getAllTracks();
    int n = 0;
    for (const auto* t : allTracks)
    {
        if (t == nullptr || n >= kMaxTracks) continue;
        cachedTrackSnapshot_[n++] = t;
    }
    cachedTrackSnapshotCount_       = n;
    cachedTrackTopologyGeneration_  = generation;
}

// ── Sorted-by-start clip snapshot (Finding 2c) ──────────────────────────────
// Rebuilt only when Timeline's clip topology generation has advanced.
// Ordering by tick position matches ordering by sample position for any
// fixed bpm (sample = ticks * a positive per-bpm scale factor), so this sort
// stays valid across a live tempo change — no re-sort needed when bpm alone
// moves.
void MixEngine::rebuildSortedClipsByStart()
{
    sortedClipsByStart_.clear();
    if (timeline_ == nullptr) return;

    const auto allClips = timeline_->getAllClips();
    sortedClipsByStart_.reserve(allClips.size());
    for (const Clip* c : allClips)
        if (c != nullptr)
            sortedClipsByStart_.push_back(c);

    std::stable_sort(sortedClipsByStart_.begin(), sortedClipsByStart_.end(),
        [](const Clip* a, const Clip* b) {
            if (a->position.ticks != b->position.ticks)
                return a->position.ticks < b->position.ticks;
            return a->id < b->id;
        });
}

// ── Find active clips ────────────────────────────────────────────────────────

void MixEngine::findActiveClips(int64_t bufferStart, int64_t bufferEnd,
                                double bpm, double sampleRate)
{
    if (timeline_ == nullptr)
    {
        activeClips_.clear();
        clipScanCursor_ = 0;
        clipScanLastBufferEnd_ = -1;
        return;
    }

    // Phase 3A tailClamp: suppress clips that START at/after the trigger ceiling
    // (capture end). Clips already in flight (clipStart < ceiling) keep playing
    // and decay naturally; only NEW clip onsets in the tail are gated.
    const int64_t triggerCeiling =
        noteTriggerCeilingSample_.load(std::memory_order_relaxed);

    // One atomic load pins the region map for this whole scan; a writer
    // publishing mid-block cannot change or free what we are reading.
    const auto regionMap = loadRegionSampleMap();

    const uint64_t clipGeneration = timeline_->getClipTopologyGeneration();
    const bool topologyChanged = (clipGeneration != cachedClipTopologyGeneration_);
    if (topologyChanged)
    {
        rebuildSortedClipsByStart();
        cachedClipTopologyGeneration_ = clipGeneration;
    }

    // A seek — or a topology change, which can move clips arbitrarily far
    // from where the cursor left off, or delete the very clips activeClips_
    // is still holding pointers to — forces a full rebuild. Everything below
    // this point re-derives from sortedClipsByStart_/live clip state only;
    // stale entries left over in activeClips_ are never dereferenced.
    const bool isSeek = topologyChanged
                       || clipScanLastBufferEnd_ < 0
                       || bufferStart != clipScanLastBufferEnd_;

    // Re-derives one clip's fields against the CURRENT bpm/sampleRate/
    // regionToSampleMap_/triggerCeiling and appends it if it still overlaps
    // and still qualifies. Identical per-clip logic (and order of checks) to
    // the original exhaustive scan — the only thing that changed is how many
    // clips this runs over per block.
    const auto tryActivate = [&](const Clip* clip)
    {
        const int64_t clipStart = clip->position.toSamples(bpm, sampleRate);
        const int64_t clipEnd   = (clip->position + clip->duration).toSamples(bpm, sampleRate);

        if (clipEnd <= bufferStart || clipStart >= bufferEnd)
            return;

        if (clipStart >= triggerCeiling)
            return;

        auto it = regionMap->find(clip->regionId);
        if (it == regionMap->end())
        {
            // Warn on unmapped region (throttled in maybeLogDebug)
            return;
        }

        int64_t regionOffset = 0;
        if (clip->syllableIndex >= 0)
        {
            const auto* region = timeline_->getRegion(clip->regionId);
            if (region != nullptr && clip->syllableIndex < static_cast<int>(region->syllables.size()))
            {
                const auto& syl = region->syllables[clip->syllableIndex];
                regionOffset = static_cast<int64_t>(syl.startTime * sampleRate);
            }
        }

        if (clip->regionOffset.ticks > 0)
            regionOffset += clip->regionOffset.toSamples(bpm, sampleRate);

        activeClips_.push_back({clip, it->second, clipStart, clipEnd, regionOffset});
    };

    if (isSeek)
    {
        activeClips_.clear();
        for (const Clip* clip : sortedClipsByStart_)
            tryActivate(clip);

        // Position the cursor just past every clip whose start sample is
        // already < bufferEnd, so the next (sequential) call resumes here
        // instead of re-scanning from the top.
        clipScanCursor_ = 0;
        while (clipScanCursor_ < static_cast<int>(sortedClipsByStart_.size())
               && sortedClipsByStart_[clipScanCursor_]->position.toSamples(bpm, sampleRate) < bufferEnd)
            ++clipScanCursor_;
    }
    else
    {
        // Sequential playback, no edits since the last block: refresh the
        // clips already known to be active (cheap — O(active), not
        // O(project) — and this is where a live bpm change or a live
        // region→sample remap lands, exactly as the old full rescan did
        // every block) via a swap so this never allocates once capacity
        // settles, mirroring prevActiveBlocks_.swap(activeBlocks_) below.
        prevActiveClipsScratch_.swap(activeClips_);
        activeClips_.clear();
        for (const auto& ac : prevActiveClipsScratch_)
            tryActivate(ac.clip);

        // Advance the cursor, activating clips newly entering the window.
        while (clipScanCursor_ < static_cast<int>(sortedClipsByStart_.size()))
        {
            const Clip* clip = sortedClipsByStart_[clipScanCursor_];
            if (clip->position.toSamples(bpm, sampleRate) >= bufferEnd)
                break;
            ++clipScanCursor_;
            tryActivate(clip);
        }
    }

    clipScanLastBufferEnd_ = bufferEnd;
}

// ── Find active pattern blocks ───────────────────────────────────────────────

void MixEngine::findActivePatternBlocks(int64_t bufferStart, int64_t bufferEnd,
                                        double bpm, double sampleRate)
{
    // Fix C: snapshot previous buffer's active blocks for per-block dropout
    // diff. Using swap preserves capacity in both vectors (no heap churn on
    // the audio thread), and populates prevActiveBlocks_ as a side effect.
    prevActiveBlocks_.swap(activeBlocks_);
    activeBlocks_.clear();

#ifdef XLETH_DEBUG
    // Audio-thread guardrail: the per-block diff below is O(N*M). "Typically\n// small" is exactly the assumption that breaks later — if a pattern-heavy
    // section ever drives this into the hundreds, catch it in debug builds
    // before it becomes an audio-thread stall in a release build.
    jassert(prevActiveBlocks_.size() < 64);
#endif

    if (timeline_ != nullptr)
    {
        // Walk the map directly: getAllPatternBlocks() builds a fresh vector,
        // which would be a heap allocation on every callback.
        for (const auto& [blockId, blockRef] : timeline_->getPatternBlockMap())
        {
            juce::ignoreUnused(blockId);
            const PatternBlock* block = &blockRef;

            const int64_t blockStart = block->position.toSamples(bpm, sampleRate);
            const int64_t blockEnd   = (block->position + block->duration).toSamples(bpm, sampleRate);

            if (blockEnd <= bufferStart || blockStart >= bufferEnd) continue;

            const Pattern* pattern = timeline_->getPattern(block->patternId);
            if (pattern == nullptr) continue;
            if (pattern->regionId < 0) continue;

            // Samplers are keyed by {trackId, regionId}. Look up the pair
            // this block needs — audio thread does lookup only, never
            // allocates. If the sampler is missing (race with a new block
            // added mid-playback, SampleBank not yet populated), skip the
            // block. The main thread is responsible for ensuring every
            // referenced pair has a sampler before Play() starts.
            auto sit = rtSamplers_->playback.find({block->trackId, pattern->regionId});
            if (sit == rtSamplers_->playback.end()) continue;
            Sampler* sampler = sit->second.get();
            if (sampler == nullptr || !sampler->hasSample()) continue;

            activeBlocks_.push_back({block, pattern, sampler, blockStart, blockEnd});
        }
    }

    // Fix C: per-block dropout diff. The {trackId, regionId}-keyed
    // prevActiveKeys_ diff below only fires when a whole sampler drops out.
    // It cannot see the adjacent-block case: block X ends, block Y begins,
    // both on the same {track, region} → sampler stays live → prevActiveKeys_
    // thinks nothing changed, but X's held voices have lost their owning
    // block and can strand. This diff identifies blocks that were active
    // last buffer but aren't anymore, and if the sampler is still alive it
    // releases only the voices that spawned inside the dropped block.
    for (const auto& prev : prevActiveBlocks_)
    {
        if (prev.block == nullptr || prev.sampler == nullptr) continue;

        bool stillActive = false;
        for (const auto& cur : activeBlocks_) {
            if (cur.block == prev.block) { stillActive = true; break; }
        }
        if (stillActive) continue;

        // Block dropped. If the sampler is still alive in activeBlocks_,
        // prevActiveKeys_'s allNotesOff will NOT fire for it. Release
        // only the voices that belong to this dropped block.
        bool samplerStillAlive = false;
        for (const auto& cur : activeBlocks_) {
            if (cur.sampler == prev.sampler) { samplerStillAlive = true; break; }
        }
        if (samplerStillAlive) {
            prev.sampler->releaseVoicesSpawnedInRange(
                prev.blockStartSample, prev.blockEndSample);
        }
        // If the sampler is NOT still alive, the prevActiveKeys_ diff below
        // handles it (after Fix B that is a release-envelope, not hard-kill).
    }

    // Block-exit voice cutting: diff active {trackId, regionId} keys against
    // the previous buffer's set. Any key that WAS active but no longer has
    // an active block gets allNotesOff() on its sampler — handles block
    // deletion, block moves, and playhead jumping away mid-note. Keyed per
    // region so a block ending doesn't cut voices on a different region's
    // sampler that shares the same track.
    auto& currentKeys = currentActiveKeysScratch_;
    currentKeys.clear();
    for (const auto& apb : activeBlocks_) {
        if (apb.block && apb.pattern)
            currentKeys.insert({apb.block->trackId, apb.pattern->regionId});
    }

    for (int k = 0; k < prevActiveKeys_.count; ++k)
    {
        const auto& key = prevActiveKeys_.keys[static_cast<size_t>(k)];
        if (!currentKeys.contains(key))
        {
            auto it = rtSamplers_->playback.find(key);
            if (it != rtSamplers_->playback.end() && it->second) it->second->allNotesOff();
        }
    }
    prevActiveKeys_.assign(currentKeys);
}

// ── Trigger pattern notes (block-granular) ───────────────────────────────────

void MixEngine::triggerPatternNotes(const ActivePatternBlock& apb,
                                    int64_t bufferStart, int64_t bufferEnd,
                                    double bpm, double sampleRate)
{
    // Convert sample positions to ticks (960 PPQ) through the shared clock.
    // AV_ROUND_ZERO reproduces the truncation of the old double formula.
    // RT-safe: integer arithmetic only - no locks, no allocation, no lookups.
    const int srInt = static_cast<int>(sampleRate);
    auto sampleToTick = [&](int64_t sample) -> int64_t {
        return RenderClock::sampleToPPQ(sample, srInt, bpm, AV_ROUND_ZERO);
    };

    const int64_t bufStartTick       = sampleToTick(bufferStart);
    const int64_t bufEndTick         = sampleToTick(bufferEnd);
    // Widen search by ±2 ticks to catch notes whose tick-domain position
    // rounds to just outside the narrow window but whose true sample position
    // falls within this buffer.  Sample-domain membership is the authoritative
    // filter applied in the dispatch loop below.
    const int64_t bufStartTickSearch = bufStartTick - 2;
    const int64_t bufEndTickSearch   = bufEndTick   + 2;

    const int64_t blockPosTicks    = apb.block->position.ticks;
    const int64_t blockOffsetTicks = apb.block->offset.ticks;
    const int64_t patternLenTicks  = apb.pattern->length.ticks;
    if (patternLenTicks <= 0) return;

    const int64_t blockEndTicks = blockPosTicks + apb.block->duration.ticks;

    const int64_t windowStart = std::max<int64_t>(bufStartTickSearch, blockPosTicks);
    const int64_t windowEnd   = std::min<int64_t>(bufEndTickSearch, blockEndTicks);
    if (windowEnd <= windowStart) return;

    // Loop iteration range for the (pattern-local) time axis. Clamp first to 0
    // so a block whose offset rolls the effective start negative still fires
    // notes from loop iteration 0 onward.
    const int64_t firstLoopIdx = std::max<int64_t>(
        0, (windowStart - blockPosTicks + blockOffsetTicks) / patternLenTicks);
    int64_t lastLoopIdx  =
        (windowEnd - blockPosTicks + blockOffsetTicks) / patternLenTicks;

    // When loopEnabled is false, only iteration 0 plays — notes past the
    // pattern boundary become silence (visible "empty space" in the UI).
    if (!apb.block->loopEnabled)
        lastLoopIdx = std::min<int64_t>(lastLoopIdx, 0);

    // Collect audio events (noteOn/noteOff/slideStart) into a stack-allocated
    // buffer so we can sort them before firing. The sort order guarantees:
    //   1. NoteOffs fire before NoteOns at the same tick — critical for
    //      arpeggiator chord transitions; without it, adjacent chords leak
    //      notes into each other because heldNotes_ never empties.
    //      (Mirrors XlethAddon::emitArpVideoEvents.)
    //   2. NoteOns fire before SlideStarts at the same tick — so a slide
    //      note that lands on the same tick as a chord's noteOns correctly
    //      captures those just-spawned voices in its group, instead of
    //      targeting future voices.
    //
    // Slide notes (PatternNote.isSlide == true) emit a single SlideStart
    // event — NO noteOn, NO noteOff. They are silent pitch-target markers
    // consumed by Sampler::beginGroupSlide.
    struct AudioEvent {
        enum Type : uint8_t { NoteOff = 0, NoteOn = 1, SlideStart = 2 };
        int64_t tick;
        Type    type;
        int     pitch;
        float   velocity;             // NoteOn only
        double  slideDurationSamples; // SlideStart only
        float   cx;                   // SlideStart only (bezier ctrl x)
        float   cy;                   // SlideStart only (bezier ctrl y)
    };
    static constexpr int kMaxEvents = 512;
    AudioEvent events[kMaxEvents];
    int eventCount = 0;

    for (const auto& note : apb.pattern->notes)
    {
        for (int64_t L = firstLoopIdx; L <= lastLoopIdx; ++L)
        {
            const int64_t absNoteOn  = blockPosTicks - blockOffsetTicks
                                       + L * patternLenTicks + note.position.ticks;
            // Clamp the note-off to the block end so notes whose duration
            // reaches (or exceeds) the block boundary still release instead
            // of ringing past it.
            const int64_t rawNoteOff = absNoteOn + note.duration.ticks;
            const int64_t absNoteOff = std::min<int64_t>(rawNoteOff, blockEndTicks);

            if (note.isSlide)
            {
                // Slide note → single SlideStart event at the start tick.
                // Duration is the note's TickTime duration converted to
                // samples; cx/cy carry bezier easing for the audio glide.
                if (absNoteOn >= windowStart && absNoteOn < windowEnd
                    && eventCount < kMaxEvents) {
                    AudioEvent e{};
                    e.tick = absNoteOn;
                    e.type = AudioEvent::SlideStart;
                    e.pitch = note.pitch;
                    e.velocity = 0.0f;
                    e.slideDurationSamples =
                        static_cast<double>(note.duration.toSamples(bpm, sampleRate));
                    e.cx = note.slideCurveCx;
                    e.cy = note.slideCurveCy;
                    events[eventCount++] = e;
                }
                // Slide notes do NOT emit NoteOn/NoteOff — silence by design.
                continue;
            }

            if (absNoteOn >= windowStart && absNoteOn < windowEnd
                && eventCount < kMaxEvents) {
                AudioEvent e{};
                e.tick = absNoteOn;
                e.type = AudioEvent::NoteOn;
                e.pitch = note.pitch;
                e.velocity = note.velocity;
                events[eventCount++] = e;
#ifdef XLETH_RT_TRACE
                // Log where the noteOff for this note would land relative to the window.
                // offInWin=YES means both events fire in the same buffer (very short note).
                // offInWin=NO means the noteOff must be picked up in a later buffer.
                fprintf(stderr, "[NoteOffDiag] noteOnTick=%lld noteOffTick=%lld dur=%lld "
                        "blockEnd=%lld windowStart=%lld windowEnd=%lld offInWin=%s\n",
                        (long long)absNoteOn, (long long)absNoteOff,
                        (long long)note.duration.ticks, (long long)blockEndTicks,
                        (long long)windowStart, (long long)windowEnd,
                        (absNoteOff > windowStart && absNoteOff <= windowEnd) ? "YES" : "NO");
#endif
            }

            // Half-open on the start side, inclusive on the end side so an
            // off-event that lands exactly on windowEnd (common: note ends at
            // pattern/block boundary) still fires in this buffer.
            if (absNoteOff > windowStart && absNoteOff <= windowEnd
                && eventCount < kMaxEvents) {
                AudioEvent e{};
                e.tick = absNoteOff;
                e.type = AudioEvent::NoteOff;
                e.pitch = note.pitch;
                e.velocity = 0.0f;
                events[eventCount++] = e;
            }
        }
    }

    // Catch capacity overflow in debug builds — a dropped noteOff means a
    // stuck voice, so surface this during testing rather than silently clipping.
    jassert(eventCount < kMaxEvents);

    // Sort by tick, then by type (NoteOff < NoteOn < SlideStart) at equal tick.
    // - NoteOff before NoteOn: arpeggiator drains heldNotes_ before the next
    //   chord enters.
    // - NoteOn before SlideStart: a same-tick slide can capture just-spawned
    //   voices instead of targeting future-spawned ones.
    std::sort(events, events + eventCount,
        [](const AudioEvent& a, const AudioEvent& b) {
            if (a.tick != b.tick) return a.tick < b.tick;
            return a.type < b.type;
        });

    const int numSamples = static_cast<int>(bufferEnd - bufferStart);

    // Phase 3A tailClamp: NoteOns at/after this ceiling are suppressed so no new
    // notes trigger past endTick during the tail. NoteOff/SlideStart are NOT
    // gated — sustaining voices must still release (decay) naturally. INT64_MAX =
    // disabled (normal renders/playback).
    const int64_t triggerCeiling =
        noteTriggerCeilingSample_.load(std::memory_order_relaxed);

    for (int i = 0; i < eventCount; ++i) {
        const AudioEvent& e = events[i];
        // Exact inverse of the sampleToTick() used for the search window above,
        // and the SAME conversion Transport's loop bounds use — so a note on the
        // loop-start tick lands on exactly loopStartSamples and survives the
        // membership filter below. TickTime::toSamples() (double math, truncated)
        // used to be a sample low here for positions the integer clock resolves
        // exactly, which dropped notes that sat on the seam.
        const int64_t absSample =
            RenderClock::ppqToSample(e.tick, srInt, bpm, AV_ROUND_ZERO);

        // Sample-domain membership is the authoritative filter.
        // The widened tick window may have admitted candidates from adjacent
        // buffers; discard them here before computing the offset.
        if (absSample < bufferStart) continue;

        switch (e.type) {
            case AudioEvent::NoteOn: {
                if (absSample >= bufferEnd) continue;
                if (absSample >= triggerCeiling) continue;  // tailClamp: no new notes
                const int sampleOffset = static_cast<int>(absSample - bufferStart);
                jassert(sampleOffset >= 0 && sampleOffset < numSamples);
#ifdef XLETH_RT_TRACE
                fprintf(stderr, "[PatternTrig] absTick=%lld absSample=%lld "
                        "bufStart=%lld bufEnd=%lld numSamples=%d offset=%d\n",
                        (long long)e.tick, (long long)absSample,
                        (long long)bufferStart, (long long)bufferEnd, numSamples,
                        sampleOffset);
#endif
                apb.sampler->noteOn(e.pitch, e.velocity, sampleOffset);
                break;
            }
            case AudioEvent::NoteOff: {
                // Inclusive end (> not >=). A note-off whose sample equals
                // bufferEnd MUST dispatch in this buffer — in the next buffer
                // the owning PatternBlock is absent from activeBlocks_
                // (half-open [blockStart, blockEnd) filter) and no pending-off
                // state would re-emit it. Admitting it here is the last chance.
                if (absSample > bufferEnd) continue;
                int noteOffOffset = static_cast<int>(absSample - bufferStart);
                // Clamp for the deferred-release scheduler: the sample-loop
                // gate `s >= v.releaseSample` is never true when
                // releaseSample == numSamples, which would strand the voice.
                // Firing one sample early at the edge is inaudible.
                if (noteOffOffset >= numSamples) noteOffOffset = numSamples - 1;
                jassert(noteOffOffset >= 0 && noteOffOffset < numSamples);
#ifdef XLETH_RT_TRACE
                fprintf(stderr, "[PatternOff] absTick=%lld absSample=%lld "
                        "bufStart=%lld bufEnd=%lld numSamples=%d offset=%d\n",
                        (long long)e.tick, (long long)absSample,
                        (long long)bufferStart, (long long)bufferEnd, numSamples,
                        noteOffOffset);
#endif
                apb.sampler->noteOff(e.pitch, noteOffOffset, /*force=*/true);
                break;
            }
            case AudioEvent::SlideStart: {
                if (absSample >= bufferEnd) continue;
                const int sampleOffset = static_cast<int>(absSample - bufferStart);
                jassert(sampleOffset >= 0 && sampleOffset < numSamples);
#ifdef XLETH_RT_TRACE
                fprintf(stderr, "[PatternSlide] absTick=%lld absSample=%lld "
                        "targetPitch=%d durSamples=%.1f cx=%.3f cy=%.3f offset=%d\n",
                        (long long)e.tick, (long long)absSample,
                        e.pitch, e.slideDurationSamples,
                        e.cx, e.cy, sampleOffset);
#endif
                apb.sampler->beginGroupSlide(e.pitch, e.slideDurationSamples,
                                             e.cx, e.cy, sampleOffset);
                break;
            }
        }
    }
}

// ── Pattern audition (audio thread) ──────────────────────────────────────────
// Transport-stopped only. A private sample clock (auditionPosSamples_) drives
// triggerPatternNotes() with a synthetic PatternBlock at tick 0, so slides,
// note-offs, the event sort and the loop arithmetic are exactly what the
// arrangement uses. Notes land on the region's PREVIEW sampler; the stopped
// path's renderPreviewSamplers() then runs them through the routed track chain.

void MixEngine::haltPatternAudition()
{
    if (auditionRunningRegionId_ >= 0)
    {
        auto it = rtSamplers_->preview.find(auditionRunningRegionId_);
        if (it != rtSamplers_->preview.end() && it->second && it->second->sampler)
            it->second->sampler->allNotesOff();   // release envelope, not a hard cut
    }
    auditionRunningPatternId_ = -1;
    auditionRunningRegionId_  = -1;
    auditionActive_.store(false, std::memory_order_release);
}

void MixEngine::runPatternAudition(int numSamples, double bpm, double sampleRate)
{
    const int requested = auditionPatternId_.load(std::memory_order_acquire);

    if (requested < 0)
    {
        if (auditionRunningPatternId_ >= 0) haltPatternAudition();
        return;
    }

    const int srInt = static_cast<int>(sampleRate);
    const uint32_t seq = auditionStartSeq_.load(std::memory_order_acquire);
    const bool loop = auditionLoop_.load(std::memory_order_relaxed);

    const Pattern* pattern = timeline_ != nullptr ? timeline_->getPattern(requested) : nullptr;
    if (pattern == nullptr || pattern->regionId < 0 || pattern->length.ticks <= 0)
    {
        if (auditionRunningPatternId_ >= 0) haltPatternAudition();
        auditionActive_.store(false, std::memory_order_release);
        return;
    }
    const int64_t lenTicks = pattern->length.ticks;

    if (seq != auditionSeenSeq_)
    {
        // (Re)start. Cut whatever the previous run left sounding first.
        auditionSeenSeq_ = seq;
        if (auditionRunningPatternId_ >= 0) haltPatternAudition();
        auditionRunningPatternId_ = requested;
        auditionRunningRegionId_  = pattern->regionId;
        auditionSeenLoop_   = loop;
        auditionPosSamples_ = 0;
        auditionEndTick_    = loop ? (int64_t(1) << 50) : lenTicks;
        auditionEndSample_  = loop ? INT64_MAX
                                   : RenderClock::ppqToSample(lenTicks, srInt, bpm, AV_ROUND_ZERO);
        auditionActive_.store(true, std::memory_order_release);
    }

    if (!auditionActive_.load(std::memory_order_acquire)) return;   // one-shot already ended

    // Live loop switch. Off: finish the pass in progress, then end. On: go on.
    if (loop != auditionSeenLoop_)
    {
        auditionSeenLoop_ = loop;
        if (loop)
        {
            auditionEndTick_   = int64_t(1) << 50;
            auditionEndSample_ = INT64_MAX;
        }
        else
        {
            const int64_t curTick = RenderClock::sampleToPPQ(auditionPosSamples_, srInt, bpm, AV_ROUND_ZERO);
            auditionEndTick_   = (curTick / lenTicks + 1) * lenTicks;
            auditionEndSample_ = RenderClock::ppqToSample(auditionEndTick_, srInt, bpm, AV_ROUND_ZERO);
        }
    }

    auto pv = rtSamplers_->preview.find(pattern->regionId);
    if (pv == rtSamplers_->preview.end() || !pv->second || !pv->second->sampler
        || !pv->second->sampler->hasSample())
    {
        haltPatternAudition();
        return;
    }
    Sampler* sampler = pv->second->sampler.get();
    sampler->setBPM(bpm);

    auditionBlock_.id          = -1;
    auditionBlock_.patternId   = requested;
    auditionBlock_.position    = TickTime{};
    auditionBlock_.offset      = TickTime{};
    auditionBlock_.duration.ticks = auditionEndTick_;
    auditionBlock_.loopEnabled = true;     // the end tick is what bounds a one-shot

    const int64_t bufStart = auditionPosSamples_;
    const int64_t bufEnd   = bufStart + numSamples;

    ActivePatternBlock apb { &auditionBlock_, pattern, sampler, 0, auditionEndSample_ };
    triggerPatternNotes(apb, bufStart, bufEnd, bpm, sampleRate);

    auditionPosSamples_ = bufEnd;
    const int64_t tick = RenderClock::sampleToPPQ(bufEnd, srInt, bpm, AV_ROUND_ZERO);
    auditionPosTicks_.store(tick % lenTicks, std::memory_order_relaxed);

    if (bufEnd >= auditionEndSample_)
    {
        // One-shot done. Every note-off was clamped to the pass end, so the
        // voices are already releasing; leave the tail to ring out.
        auditionRunningPatternId_ = -1;
        auditionRunningRegionId_  = -1;
        auditionPosTicks_.store(0, std::memory_order_relaxed);
        auditionActive_.store(false, std::memory_order_release);
    }
}

// ── processBlock ─────────────────────────────────────────────────────────────
// AUDIO THREAD — no alloc (after first call), no locks, no I/O.

void MixEngine::processBlock(juce::AudioBuffer<float>& outputBuffer,
                             int                       numSamples,
                             const Transport&          transport)
{
    struct ProcessBlockTimingScope
    {
        MixEngine* engine = nullptr;
        bool enabled = false;
        int samples = 0;
        double sampleRate = 0.0;
        uint64_t startNs = 0;

        ~ProcessBlockTimingScope()
        {
            if (enabled && engine != nullptr)
                engine->recordProcessBlockTiming(samples, sampleRate, steadyNowNs() - startNs);
        }
    };

    const bool rtDiagEnabled =
        realtimeDiagnostics_.enabled.load(std::memory_order_relaxed);
    ProcessBlockTimingScope processTiming {
        this,
        rtDiagEnabled,
        numSamples,
        transport.getSampleRate(),
        rtDiagEnabled ? steadyNowNs() : 0
    };

    // Pinned for the whole block: every Sampler* derived below stays alive
    // until this returns. Never the last owner (see RtPublished), so letting
    // go of it here frees nothing on this thread.
    struct SamplerSetPin
    {
        MixEngine& engine;
        xleth::util::RtPublished<SamplerSet>::Ptr held;
        explicit SamplerSetPin(MixEngine& e) : engine(e), held(e.samplerSet_.load())
        { engine.rtSamplers_ = held.get(); }
        ~SamplerSetPin() { engine.rtSamplers_ = nullptr; }
    } samplerSetPin { *this };

    // Early out: no timeline
    if (timeline_ == nullptr)
    {
        masterPeakL_.store(0.0f, std::memory_order_relaxed);
        masterPeakR_.store(0.0f, std::memory_order_relaxed);
        return;
    }

    const double sampleRateForPreview = transport.getSampleRate();

    // When transport is stopped, render only the dedicated audition samplers.
    // Playback samplers must stay behind the full track pipeline: summing them
    // directly here would bypass track effects and mute/solo routing during the
    // first release block after Stop/Pause.
    const bool isPlaying = transport.isPlaying();
    // Transport-stop transition: release any held notes so sustained envelopes
    // begin their release tail immediately instead of continuing to hold.
    if (wasPlaying_ && !isPlaying)
    {
        for (auto& kv : rtSamplers_->playback)
            if (kv.second) kv.second->allNotesOff();
        for (auto& kv : rtSamplers_->preview)
            if (kv.second && kv.second->sampler) kv.second->sampler->allNotesOff();
        // Reset active-block tracking so a subsequent Play doesn't think the
        // pre-stop blocks were previously active (and spuriously silence them).
        prevActiveKeys_.clear();
        lastBufferEnd_ = -1;
        requestEffectChainReset();
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
        std::fill(std::begin(tailEndSamples_), std::end(tailEndSamples_), int64_t(0));
        std::fill(std::begin(tailBelowThreshRun_), std::end(tailBelowThreshRun_), int64_t(0));
        clipModReader_.resetAllStates();

        // Envelope stop RELEASE. Publish the at-rest (env == 0) value for every
        // modulated parameter, which each edge's modulation mapping maps to exactly
        // its authored `base`. Modulation ceases and the user's parameter setting
        // stands — there is no destructive value this path can write.
        evaluateEnvelopeModulation(transport.getRenderPositionSamples(),
                                   transport.getBPM(),
                                   transport.getSampleRate(),
                                   /*atRest=*/true);

        // LFO stop RELEASE. atRest=true forces every edge onto its authored
        // `base` directly (bypassing evaluateModulationMapping — see
        // evaluateLfoModulation's comment for why an LFO's neutral sample
        // can't be used the way Envelope's env==0 is).
        evaluateLfoModulation(transport.getRenderPositionSamples(),
                              transport.getBPM(),
                              transport.getSampleRate(),
                              /*atRest=*/true);
    }
    // Play start after an audition: reset the chains it ran through (see
    // auditionDirtiedChains_). Not done while stopped — that would wipe the
    // tail the user is auditioning.
    // Play start cancels a pattern audition: from here the arrangement owns
    // the track chains, and the audition's private clock has no meaning.
    if (isPlaying && auditionRunningPatternId_ >= 0)
    {
        auditionPatternId_.store(-1, std::memory_order_release);
        haltPatternAudition();
    }
    if (!wasPlaying_ && isPlaying && auditionDirtiedChains_)
    {
        requestJumpChainReset();
        auditionDirtiedChains_ = false;
    }
    wasPlaying_ = isPlaying;

    if (pendingLatencyCompensationReset_.exchange(false, std::memory_order_acq_rel))
        resetLatencyCompensationState();

    if (!isPlaying)
    {
        // Transport stopped: the track chains are idle this block, so an
        // audition may safely borrow one. That needs the chains lock — taken
        // with try_lock so a main-thread chain edit can never stall audio; a
        // miss simply auditions dry for that block.
        //
        // Only taken when something is actually loaded to audition, so a
        // stopped transport with no preview sampler never touches the mutex.
        // Automation while stopped. value(t) is a pure function of the tick, and
        // the playhead still HAS a tick, so seeking with the transport stopped
        // has to leave every automated parameter on the value at the new
        // position — otherwise the knob shows whatever the last rendered block
        // happened to leave behind. No lock at all (Finding 9): this used to
        // try_lock and silently do nothing on a miss, which is precisely the
        // case where a knob keeps a stale value after a seek.
        const std::shared_ptr<const ChainSnapshot> stoppedChainsPtr =
            chainSnapshot_.load(std::memory_order_acquire);
        if (stoppedChainsPtr)
            applyAutomationForBlock(*stoppedChainsPtr,
                                    xleth::automation::tickAtSamplePosition(
                                        transport.getRenderPositionSamples(),
                                        transport.getBPM(),
                                        transport.getSampleRate()));

        // Pattern audition: schedule this block's notes onto the preview
        // sampler BEFORE it renders. Tempo-synced effects in the borrowed chain
        // need the BPM, which the stopped path otherwise never publishes.
        if (auditionPatternId_.load(std::memory_order_relaxed) >= 0
            || auditionRunningPatternId_ >= 0)
        {
            XlethEffectBase::setGlobalBPM(transport.getBPM());
            runPatternAudition(numSamples, transport.getBPM(), sampleRateForPreview);
        }

        if (!rtSamplers_->preview.empty())
            renderPreviewSamplers(outputBuffer, numSamples, sampleRateForPreview,
                                  transport.getBPM(), stoppedChainsPtr.get());

        for (int ch = 0; ch < outputBuffer.getNumChannels(); ++ch)
        {
            float* data = outputBuffer.getWritePointer(ch);
            for (int s = 0; s < numSamples; ++s)
            {
                if (data[s] > 1.0f)       data[s] = 1.0f;
                else if (data[s] < -1.0f) data[s] = -1.0f;
            }
        }

        const float mL = outputBuffer.getMagnitude(0, 0, numSamples);
        const float mR = outputBuffer.getNumChannels() >= 2
                       ? outputBuffer.getMagnitude(1, 0, numSamples)
                       : 0.0f;
        masterPeakL_.store(mL, std::memory_order_relaxed);
        masterPeakR_.store(mR, std::memory_order_relaxed);
        return;
    }

    const double bpm        = transport.getBPM();
    XlethEffectBase::setGlobalBPM(bpm);
    const double sampleRate = transport.getSampleRate();
    const int64_t position  = transport.getRenderPositionSamples();
    const int64_t bufStart  = position;
    const int64_t bufEnd    = position + numSamples;

    // Publish this block's absolute start position so any effect with an
    // in-effect free-running LFO (the Xleth Filter's per-slot LFO) derives its
    // phase from the same clock the FX-graph LFO uses — no per-effect plumbing.
    XlethEffectBase::setGlobalTransportPositionSamples(bufStart);

    // Envelope Controller → parameter modulation, evaluated on the authoritative
    // clock. Placed here, before any track or effect processing, so the values
    // published for this block belong to this block's transport position.
    //
    // Everything that made the retired renderer drive wrong is structurally absent:
    // the position is the real render position (not a wall-clock estimate re-anchored
    // by a poll), the gates are the engine's own note math, and evaluation is a pure
    // function of position — so the first rendered sample after Play is already
    // correct, a loop wrap cannot over-run, and a seek lands at the right phase.
    evaluateEnvelopeModulation(bufStart, bpm, sampleRate, /*atRest=*/false);

    // LFO Modulator → parameter modulation, evaluated at the same point for
    // the same reason (see comment above): this block's transport position,
    // before any track or effect processing.
    evaluateLfoModulation(bufStart, bpm, sampleRate, /*atRest=*/false);

    auto* diagnosticTapSink = diagnosticTapSink_;
    const uint64_t diagnosticBlockIndex =
        diagnosticTapSink != nullptr ? diagnosticTapBlockIndex_++ : 0;

    // Seek detection: if buffer start doesn't continue from previous buffer
    // end, the playhead jumped. Release all held pattern notes so stale
    // voices from the old position don't ring indefinitely at the new one, and
    // reset the effect chains / PDC latency so the new position starts clean.
    if (lastBufferEnd_ >= 0 && bufStart != lastBufferEnd_) {
        for (auto& kv : rtSamplers_->playback)
            if (kv.second) kv.second->allNotesOff();
        requestJumpChainReset();
        pendingLatencyCompensationReset_.store(true, std::memory_order_release);
        std::fill(std::begin(tailEndSamples_), std::end(tailEndSamples_), int64_t(0));
        std::fill(std::begin(tailBelowThreshRun_), std::end(tailBelowThreshRun_), int64_t(0));
        clipModReader_.resetAllStates();
    }
    lastBufferEnd_ = bufEnd;

    if (pendingLatencyCompensationReset_.exchange(false, std::memory_order_acq_rel))
        resetLatencyCompensationState();

    ensureTrackBuffers(numSamples);

    // Find clips active in this buffer window
    findActiveClips(bufStart, bufEnd, bpm, sampleRate);

    // Determine which tracks are in use. Solo/mute resolution now lives in the
    // per-block RoutePlan (route-aware closure, built below from this same track
    // list), so no separate anySolo scan is needed here.
    //
    // Finding 2b: refreshTrackSnapshotIfNeeded() mirrors getAllTracks() into
    // cachedTrackSnapshot_ but only rebuilds it (and only then pays getAllTracks()'s
    // allocation + stable_sort) when Timeline's track topology generation has
    // actually advanced since the last block — i.e. on an add/remove/reorder,
    // not on every callback.
    refreshTrackSnapshotIfNeeded();

    // Build a set of track IDs that have active clips (to know which buffers to clear).
    // Track ids are not small dense integers (see TrackSlotEntry above), so slot
    // lookup goes through the hashed fixed-capacity table built below.
    struct TrackSlot
    {
        int             slotIndex;
        const TrackInfo* info;
        bool            hasClips;
        bool            hasReleasingVoices;
    };

    // Stack-allocated array for up to kMaxTracks track slots
    TrackSlot trackSlots[kMaxTracks];
    int numTrackSlots = 0;
    TrackSlotEntry trackIdToSlot[kTrackSlotTableCapacity];

    for (int ti = 0; ti < cachedTrackSnapshotCount_; ++ti)
    {
        const auto* t = cachedTrackSnapshot_[ti];
        if (t == nullptr || numTrackSlots >= kMaxTracks) continue;
        const int slot = numTrackSlots++;
        trackSlots[slot] = {slot, t, false, false};
        trackSlotTableInsert(trackIdToSlot, t->id, slot);
    }

    // Clear track buffers that will be used
    for (int i = 0; i < numTrackSlots; ++i)
        trackBuffers_[i].clear(0, numSamples);

    // ── Build the output-route DSP plan for this block (Prompt 2B) ────────────
    // Slot space == trackSlots[] order, read live from the same getAllTracks()
    // snapshot the rest of the block uses, so the plan can never disagree with
    // the buffers it indexes. Pure, allocation-free, no locks — built once here,
    // outside the per-track processing loop. Covers the primary output route and
    // every send (FL multi-wiring); sidechain key edges are layered on below.
    xleth::RoutePlanSlotInput routeInputs[kMaxTracks];
    for (int i = 0; i < numTrackSlots; ++i)
    {
        xleth::fillRoutePlanSlotInput(routeInputs[i], *trackSlots[i].info);
    }
    xleth::RoutePlan routePlan;
    xleth::buildRoutePlan(routeInputs, numTrackSlots, routePlan);

    // ── Sidechain runtime plan (Prompt 4C+4D) ─────────────────────────────────
    // Default to the output-only passthrough (processOrder == routePlan.topoOrder,
    // no active taps). The real tap set needs effect-instance resolution, which
    // needs the chains lock, so it is rebuilt below once the lock is held. If the
    // lock is missed (realtime contention) the plan stays passthrough — sidechain
    // delivery is skipped this block, exactly as if no route existed (fail-closed).
    xleth::SidechainPlan scPlan;
    xleth::buildSidechainPlan(routeInputs, numTrackSlots, routePlan, nullptr, 0, scPlan);

    // Throttled fail-closed diagnostics (never spam the audio thread). Both
    // conditions are programming errors after 2A validation — log rarely.
    if (routePlan.cycleDetected || routePlan.targetCorrected)
    {
        static int routeDiagThrottle = 0;
        if (++routeDiagThrottle >= 500)
        {
            routeDiagThrottle = 0;
            MixDebugEntry entry;
            entry.type = MixDebugEntry::Mapping;
            if (routePlan.cycleDetected)
                snprintf(entry.message, sizeof(entry.message),
                         "[Routing] cycle detected in DSP plan — fell back to all-Master");
            else
                snprintf(entry.message, sizeof(entry.message),
                         "[Routing] output target trackId %d (slot %d) missing/invalid — routed to Master",
                         routePlan.correctedToTrackId, routePlan.correctedFromSlot);
            debugLog_.push(entry);
        }
    }

    // Set true when an audible source slot sums into this slot's bus buffer this
    // block, so a bus with no clips of its own still processes its chain and
    // drains its tail. Slot-indexed, mirrors trackBuffers_.
    bool receivedRoutedInput[kMaxTracks] = {};

    // Precompute clip boundary fade length for this block (0 = disabled, no overhead).
    const int clipFadeN = clipBoundaryFadeSamples_.load(std::memory_order_relaxed);
    const uint64_t sourceRenderStartNs = rtDiagEnabled ? steadyNowNs() : 0;

    // ── Pitch Shifter Clip mode (mode 4): per-block transform state ─────────
    // One atomic load pins the table for the whole block. Superseded tables are
    // retired on the message thread, so dropping this copy never frees one here.
    // A project without a Clip-mode shifter pays for that load and nothing else.
    const std::shared_ptr<const xleth::TrackSourceTransformTable> fxTable =
        sourceTransformTable_.load(std::memory_order_acquire);
    const bool anyFxTransform = fxTable != nullptr && !fxTable->entries.empty();
    const int64_t cacheNowMs = ClipRenderCache::nowMs();

    // Mix per track, resolved at most once per block from the provider node's
    // smoothed parameter: chain snapshot -> the chain's realtime view -> node.
    // Every step is an atomic load or a hash lookup in an immutable view — no
    // lock, no allocation. A node the view does not (yet) name reads as Mix 1.
    struct FxMixState { bool resolved = false; float start = 1.0f; float end = 1.0f; };
    std::array<FxMixState, kMaxTracks> fxMix {};
    std::shared_ptr<const ChainSnapshot> fxChains;
    auto resolveFxMix = [&](int trackSlot, const xleth::TrackSourceTransformEntry& entry)
        -> const FxMixState&
    {
        auto& st = fxMix[static_cast<std::size_t>(trackSlot)];
        if (st.resolved) return st;
        st.resolved = true;
        if (!fxChains) fxChains = chainSnapshot_.load(std::memory_order_acquire);
        if (!fxChains) return st;
        const auto* chainEntry = fxChains->find(entry.trackId);
        if (chainEntry == nullptr || !chainEntry->chain) return st;
        const auto view = chainEntry->chain->realtimeView();
        if (!view) return st;
        const auto* node = view->find(entry.providerNodeId);
        if (node == nullptr || node->effect == nullptr) return st;
        float start = 1.0f, end = 1.0f;
        if (node->effect->sourceTransformMixRamp(numSamples, start, end))
        {
            st.start = start;
            st.end   = end;
        }
        return st;
    };

    // ── Render active clips into track buffers ───────────────────────────────
    for (const auto& ac : activeClips_)
    {
        const int slot = trackSlotTableFind(trackIdToSlot, ac.clip->trackId);
        if (slot < 0) continue;
        trackSlots[slot].hasClips = true;

        auto& trackBuf = trackBuffers_[slot];

        const auto* srcBuf = sampleBank_->getSample(ac.sampleBankId);
        if (srcBuf == nullptr) continue;

        const int srcChannels = srcBuf->getNumChannels();
        const int srcTotal    = srcBuf->getNumSamples();

        // ── Bake-rate → export-rate correction ───────────────────────────────
        // SampleBank buffers are stored at the rate they were baked at (the
        // engine rate at load time). When the prepared/export rate differs, the
        // clip readhead must advance by bakeRate/preparedRate or the clip plays
        // sharp/flat (the Sampler already does this via sourceSampleRate_/
        // engineSampleRate). At matched rate srFactor == 1.0 and every read
        // below keeps its original integer fast path (bit-identical).
        const double bakeRate  = sampleBank_->getSampleBufferRate(ac.sampleBankId);
        const double srFactor  = (bakeRate > 0.0 && preparedSampleRate_ > 0.0)
                               ? bakeRate / preparedSampleRate_ : 1.0;
        const bool   matchedRate = std::abs(srFactor - 1.0) < 1e-9;

        const bool isGlobalStretch = (ac.clip->stretchMethod == StretchMethod::Global);
        const int resolvedStretchMethod = isGlobalStretch
            ? globalStretchMethod_
            : static_cast<int>(ac.clip->stretchMethod);
        const bool resolvedFormantPreserve = isGlobalStretch
            ? globalFormantPreserve_
            : ac.clip->formantPreserve;

        // ── Cache check (zero overhead when no processing needed) ────────────
        const bool needsProcessing = (ac.clip->pitchOffset    != 0
                                   || ac.clip->pitchOffsetCents != 0
                                   || ac.clip->reversed
                                   || ac.clip->stretchRatio   != 1.0);

        // Mode 4: this track's Clip-mode transform, if any.
        const xleth::TrackSourceTransformEntry* fxEntry =
            anyFxTransform ? fxTable->findEntry(ac.clip->trackId) : nullptr;

        // Build CacheKey and attempt a lock-free cache hit. The entries are
        // pinned for this clip's whole pass (see ClipRenderCache retirement).
        const juce::AudioBuffer<float>* readBuf  = nullptr; // points to processed buffer
        bool                            cacheHit = false;
        std::shared_ptr<const CacheEntry> origEntry;
        std::shared_ptr<const CacheEntry> wetEntry;
        const juce::AudioBuffer<float>* wetBuf   = nullptr; // shifted render (mode 4)

        if (needsProcessing || fxEntry != nullptr)
        {
            CacheKey key;
            key.regionId            = ac.clip->regionId;
            key.syllableIndex       = ac.clip->syllableIndex;
            key.regionOffsetSamples = ac.regionOffsetSamples;
            key.durationSamples     = ac.clipEndSample - ac.clipStartSample;
            key.sourceLengthSamples = srcTotal;
            key.pitchOffsetSemis    = ac.clip->pitchOffset;
            key.pitchOffsetCents    = ac.clip->pitchOffsetCents;
            key.reversed            = ac.clip->reversed;
            key.stretchRatio        = ac.clip->stretchRatio;
            key.stretchMethod       = resolvedStretchMethod;
            key.formantPreserve     = resolvedFormantPreserve;

            if (needsProcessing)
            {
                origEntry = clipRenderCache_.acquire(ac.clip->id, key, cacheNowMs);
                readBuf   = origEntry ? origEntry->buffer.get() : nullptr;
                cacheHit  = (readBuf != nullptr);

                // [Underrun] Clip wanted a processed buffer but the render cache had
                // none ready → this clip block is silenced / falls back. Lock-free
                // audio-thread counter, read by the 1s health sampler.
                if (!cacheHit)
                {
                    clipCacheMissCount_.fetch_add(1, std::memory_order_relaxed);
                    clipRenderCache_.noteMiss(ac.clip->id);
                }
            }

            // The dual lookup: the original key above (which may miss — the dry
            // then falls back to raw PCM, which for an identity clip IS its
            // original render) and the same key plus this track's transform.
            if (fxEntry != nullptr)
            {
                wetEntry = clipRenderCache_.acquire(
                    ac.clip->id, withSourceTransform(key, fxEntry->transform), cacheNowMs);
                wetBuf = wetEntry ? wetEntry->buffer.get() : nullptr;
                if (wetBuf == nullptr)
                    clipRenderCache_.noteMiss(ac.clip->id);
            }
        }

        // Blend mode for this block. Wet not ready yet → exactly today's output
        // (the same fallback a still-rendering pitched clip already has).
        enum class FxBlend { Off, WetOnly, Mix };
        FxBlend fxBlend  = FxBlend::Off;
        float   mixStart = 0.0f;
        float   mixEnd   = 0.0f;
        if (wetBuf != nullptr)
        {
            const auto& m = resolveFxMix(slot, *fxEntry);
            mixStart = m.start;
            mixEnd   = m.end;
            if (mixStart <= 0.0f && mixEnd <= 0.0f)      fxBlend = FxBlend::Off;
            else if (mixStart >= 1.0f && mixEnd >= 1.0f) fxBlend = FxBlend::WetOnly;
            else                                         fxBlend = FxBlend::Mix;
        }
        const float mixStep = (fxBlend == FxBlend::Mix && numSamples > 0)
                            ? (mixEnd - mixStart) / static_cast<float>(numSamples)
                            : 0.0f;

#ifdef XLETH_RT_TRACE
        // Throttled render-loop log: fire once every 1024 calls per clip slot (lock-free)
        if (needsProcessing) {
            static std::atomic<int> renderLogCounters[ClipRenderCache::kMaxClipId] {};
            const int clipSlot = (ac.clip->id >= 0 && ac.clip->id < ClipRenderCache::kMaxClipId) ? ac.clip->id : 0;
            if ((renderLogCounters[clipSlot].fetch_add(1, std::memory_order_relaxed) & 1023) == 0) {
                fprintf(stderr, "[MixRender] clip=%d needsProcessing=true cacheHit=%d\n",
                        ac.clip->id, (int)cacheHit);
            }
        }
#endif

        // ── Per-clip bezier fade LUTs (stack-allocated, built once per clip) ──
        const int64_t clipLen = ac.clipEndSample - ac.clipStartSample;
        float fadeInPercent = ac.clip->fadeInPercent;
        float fadeOutPercent = ac.clip->fadeOutPercent;
        normalizeClipFadePercents(fadeInPercent, fadeOutPercent);

        const int64_t fadeInSamples = clipFadePercentToSamples(clipLen, fadeInPercent);
        const int64_t fadeOutSamples = clipFadePercentToSamples(clipLen, fadeOutPercent);

        ClipFadeLUT fadeInLUT, fadeOutLUT;
        if (fadeInSamples > 0)
            fadeInLUT.build(ac.clip->fadeInX1, ac.clip->fadeInY1,
                           ac.clip->fadeInX2, ac.clip->fadeInY2);
        if (fadeOutSamples > 0)
            fadeOutLUT.build(ac.clip->fadeOutX1, ac.clip->fadeOutY1,
                            ac.clip->fadeOutX2, ac.clip->fadeOutY2);

        // ── Phase C / D.1: Clip Modulation FX — vibrato + vinyl scratch ─────
        // Plain clips read raw source PCM through a fractional, modulated
        // readhead. Stretched clips read ClipRenderCache's processed buffer:
        // the cache has already consumed regionOffsetSamples and written a
        // clip-local post-stretch buffer starting at sample 0. Fades, boundary
        // declick, and velocity are still applied exactly once by the reader.
        const auto& clipMod = ac.clip->modulation;
        const bool useModulatedReader = xleth::clipmod::isClipModulationCompatible(
            ac.clip->reversed,
            ac.clip->stretchRatio,
            resolvedFormantPreserve,
            clipMod);
        // F.1: route through the post-cache (ClipRenderCache) buffer whenever the
        // clip is processed in a way the raw-PCM readhead can't reproduce — a real
        // time-stretch OR formant-preserve. That buffer already bakes in the
        // user's stretch quality, static pitch, and formant preservation; the
        // modulated readhead then rides on top of it. `needsProcessing` guards the
        // formant-only no-op case (formant flag on but no pitch/stretch → no cache
        // buffer → fall through to the raw path, where formant-preserve is moot).
        // Static-pitch-only clips stay on the raw path (locked by F.0 tests).
        const bool usePostCacheModulatedReader =
            useModulatedReader
            && !ac.clip->reversed
            && needsProcessing
            && (ac.clip->stretchRatio != 1.0 || resolvedFormantPreserve);

        if (useModulatedReader)
        {
            if (usePostCacheModulatedReader && !cacheHit)
            {
                // Cache jobs are requested by the existing clip-processing
                // invalidation path off the audio thread. On a miss, silence
                // this clip block rather than modulating raw PCM and bypassing
                // the user's selected stretch engine.
                continue;
            }

            xleth::audio::ClipModulatedReader::BlockParams p {};
            p.srcBuf              = usePostCacheModulatedReader ? readBuf : srcBuf;
            p.regionOffsetSamples = usePostCacheModulatedReader ? 0 : ac.regionOffsetSamples;
            p.clipStartSample     = ac.clipStartSample;
            p.clipEndSample       = ac.clipEndSample;
            p.bufStart            = bufStart;
            p.numOutputSamples    = numSamples;
            p.bpm                 = bpm;
            p.sampleRate          = sampleRate;
            // Bake-rate of the buffer the reader walks. Plain clips read raw
            // SampleBank PCM (bake rate); post-cache clips read the prepared-rate
            // cache buffer, so pass preparedSampleRate_ there → factor 1.0.
            p.srcSampleRate       = usePostCacheModulatedReader ? preparedSampleRate_ : bakeRate;
            p.preparedSampleRate  = preparedSampleRate_;
            p.pitchOffsetSemis    = usePostCacheModulatedReader ? 0 : ac.clip->pitchOffset;
            p.pitchOffsetCents    = usePostCacheModulatedReader ? 0 : ac.clip->pitchOffsetCents;
            p.fadeInSamples       = fadeInSamples;
            p.fadeOutSamples      = fadeOutSamples;
            p.fadeInLUT           = (fadeInSamples > 0)  ? &fadeInLUT  : nullptr;
            p.fadeOutLUT          = (fadeOutSamples > 0) ? &fadeOutLUT : nullptr;
            p.clipBoundaryFadeN   = clipFadeN;
            p.velocity            = ac.clip->velocity;
            p.modulation          = &ac.clip->modulation;

            clipModReader_.renderBlock(p, trackBuf, ac.clip->id);
            clipModReader_.markClipSeen(ac.clip->id);
            continue;
        }

        // For each sample in this buffer, calculate what to read from the source
        for (int s = 0; s < numSamples; ++s)
        {
            const int64_t absPos = bufStart + s;

            // Skip samples outside this clip's range
            if (absPos < ac.clipStartSample || absPos >= ac.clipEndSample)
                continue;

            const int64_t posInClip = absPos - ac.clipStartSample;
            const int64_t fromEnd   = clipLen - 1 - posInClip;

            // Velocity × per-side fade. User bezier curve takes priority on each
            // side independently; global Hann declick fills any side without one.
            float gain = ac.clip->velocity;

            // IN side
            if (fadeInSamples > 0 && posInClip < fadeInSamples)
            {
                const float t = static_cast<float>(posInClip) / static_cast<float>(fadeInSamples);
                gain *= fadeInLUT.sample(t);
            }
            else if (fadeInSamples == 0 && clipFadeN > 0)
            {
                gain *= xleth::dsp::DeclickEnvelope::fadeIn(static_cast<int>(posInClip), clipFadeN);
            }

            // OUT side
            if (fadeOutSamples > 0 && fromEnd < fadeOutSamples)
            {
                const float t = static_cast<float>(fromEnd) / static_cast<float>(fadeOutSamples);
                gain *= fadeOutLUT.sample(t);
            }
            else if (fadeOutSamples == 0 && clipFadeN > 0)
            {
                gain *= xleth::dsp::DeclickEnvelope::fadeOut(static_cast<int>(fromEnd), clipFadeN);
            }

            // ── Dry: the clip's original signal, exactly today's three reads ──
            // Each branch produces the unscaled L/R sample (a mono source reads
            // the same value into both); gain is applied once, below. With the
            // blend Off the arithmetic is sample*gain added per channel — the
            // same operations, in the same order, as before mode 4 existed.
            float dryL = 0.0f;
            float dryR = 0.0f;
            bool  haveDry = false;

            if (cacheHit)
            {
                // ── Cache hit: read from pre-processed buffer ────────────────
                // readBuf is indexed from 0 (= clip start), no offset needed.
                const int rp         = static_cast<int>(posInClip);
                const int readCh     = readBuf->getNumChannels();
                const int readTotal  = readBuf->getNumSamples();
                if (rp >= 0 && rp < readTotal)
                {
                    haveDry = true;
                    dryL = readBuf->getSample(0, rp);
                    dryR = (readCh == 1) ? dryL
                                         : readBuf->getSample(std::min(1, readCh - 1), rp);
                }
            }
            else if (matchedRate)
            {
                // ── Raw PCM fallback (cache miss or no processing needed) ────
                // Matched bake/export rate → integer fast path (unchanged).
                const int64_t samplePos = posInClip + ac.regionOffsetSamples;
                if (samplePos >= 0 && samplePos < srcTotal)
                {
                    const int sp = static_cast<int>(samplePos);
                    haveDry = true;
                    dryL = srcBuf->getSample(0, sp);
                    dryR = (srcChannels == 1) ? dryL
                                              : srcBuf->getSample(std::min(1, srcChannels - 1), sp);
                }
            }
            else
            {
                // ── Raw PCM fallback, rate-corrected ─────────────────────────
                // Bake-rate samples addressed by a prepared-rate index advance
                // by srFactor (= bakeRate/preparedRate). Fractional readhead →
                // Hermite interpolation (same interpolator as the modulated
                // reader). regionOffset is a prepared-rate count, so scale it
                // too. Bound on srcTotal-1 so Hermite has its +1 neighbour.
                const double srcPos =
                    (static_cast<double>(posInClip) + static_cast<double>(ac.regionOffsetSamples))
                    * srFactor;
                if (srcPos >= 0.0 && srcPos < static_cast<double>(srcTotal - 1))
                {
                    haveDry = true;
                    dryL = xleth::audio::hermiteSample(*srcBuf, 0, srcPos);
                    dryR = (srcChannels == 1)
                         ? dryL
                         : xleth::audio::hermiteSample(*srcBuf, std::min(1, srcChannels - 1), srcPos);
                }
            }

            if (fxBlend == FxBlend::Off)
            {
                if (!haveDry) continue;
                trackBuf.addSample(0, s, dryL * gain);
                trackBuf.addSample(1, s, dryR * gain);
                continue;
            }

            // ── Wet: the shifted render (mode 4), clip-local like readBuf ────
            float wetL = 0.0f;
            float wetR = 0.0f;
            bool  haveWet = false;
            {
                const int rp       = static_cast<int>(posInClip);
                const int wetCh    = wetBuf->getNumChannels();
                const int wetTotal = wetBuf->getNumSamples();
                if (rp >= 0 && rp < wetTotal)
                {
                    haveWet = true;
                    wetL = wetBuf->getSample(0, rp);
                    wetR = (wetCh == 1) ? wetL
                                        : wetBuf->getSample(std::min(1, wetCh - 1), rp);
                }
            }

            if (fxBlend == FxBlend::WetOnly)
            {
                if (!haveWet) continue;
                trackBuf.addSample(0, s, wetL * gain);
                trackBuf.addSample(1, s, wetR * gain);
                continue;
            }

            // 0 < Mix < 1: per-sample linear blend. The smoother's value after
            // s + 1 advances, which is what its next() would return at sample s.
            if (!haveDry && !haveWet) continue;
            const float mix = mixStart + mixStep * static_cast<float>(s + 1);
            trackBuf.addSample(0, s, (dryL * (1.0f - mix) + wetL * mix) * gain);
            trackBuf.addSample(1, s, (dryR * (1.0f - mix) + wetR * mix) * gain);
        }
    }

    // Phase C: clear vibrato-reader state for any clip that wasn't rendered
    // through the modulated path this block (e.g. clip ended, was deleted, or
    // had vibrato turned off). Without this, a clip that re-activates later
    // would resume from a stale sourcePosD.
    clipModReader_.resetUnseenStates();

    // ── Render pattern blocks into track buffers ─────────────────────────────
    findActivePatternBlocks(bufStart, bufEnd, bpm, sampleRate);

    // Deterministic cross-block event dispatch order at shared-sampler boundaries.
    // When two ActivePatternBlocks share the same Sampler and events collide at a
    // boundary tick, the earlier-starting block must dispatch first so noteOff binds
    // to the original voice before noteOn spawns a new one. stable_sort preserves
    // timeline storage order as the tiebreaker when blockStartSample collides.
    // Insertion sort, not std::stable_sort: the latter may take a temporary
    // heap buffer, and this runs every block over a handful of entries.
    for (size_t i = 1; i < activeBlocks_.size(); ++i)
    {
        const ActivePatternBlock moving = activeBlocks_[i];
        size_t j = i;
        for (; j > 0 && moving.blockStartSample < activeBlocks_[j - 1].blockStartSample; --j)
            activeBlocks_[j] = activeBlocks_[j - 1];
        activeBlocks_[j] = moving;
    }

    for (const auto& apb : activeBlocks_)
    {
        const int slot = trackSlotTableFind(trackIdToSlot, apb.block->trackId);
        if (slot < 0) continue;
        trackSlots[slot].hasClips = true;   // mark track as having audio

        // Pass BPM for arpeggiator tempo sync.
        apb.sampler->setBPM(bpm);

        // INVARIANT: pass bufStart (buffer-start absolute sample) — not bufEnd or a
        // per-sample counter. fireNoteOn computes spawnAbsSample as
        // (currentAbsSample_ + sampleOffset), where sampleOffset is BUFFER-RELATIVE.
        apb.sampler->setCurrentSample(bufStart);

        // ── Pitch Shifter Clip mode (mode 4) on a PATTERN track ─────────────
        // The same per-block table the clip loop pinned above. An active entry
        // transposes this sampler's NEW voices by semis + cents/100; no entry
        // (inactive, bypassed or removed shifter) writes 0, which is how the
        // offset clears. Written on this thread right before the triggers that
        // read it — no handoff beyond the table's own atomic publish.
        //
        // Voices already sounding keep the transpose they spawned with and ring
        // out at that pitch; only voices spawned from here on take the new one.
        //
        // INERT here, by product decision: Mix (a dry/wet blend of one synth
        // voice would double every voice — twice the CPU and an instant comb),
        // clip_method and clip_formant (transposition at the voice is exact,
        // there is no stretch engine to choose). The transpose applies fully.
        // Event pitches and Pattern.notes are never modified, and the video
        // event builder never sees the table.
        {
            const xleth::TrackSourceTransformEntry* patFx =
                anyFxTransform ? fxTable->findEntry(apb.block->trackId) : nullptr;
            if (patFx != nullptr)
                apb.sampler->setTransposeOffset(patFx->transform.semis, patFx->transform.cents);
            else
                apb.sampler->setTransposeOffset(0, 0);
        }

        // Sample-accurate (block-granular) note triggering.
        triggerPatternNotes(apb, bufStart, bufEnd, bpm, sampleRate);

        // Mirror visualOnly flag into the sampler so processBlock zeroes its output.
        apb.sampler->setVisualOnly(trackSlots[slot].info->visualOnly);

        // Additively render sampler voices into the track buffer.
        apb.sampler->processBlock(trackBuffers_[slot], numSamples, sampleRate);
    }


    // ── Drain releasing sampler voices (block just ended) ───────────────────
    // After allNotesOff() fires in findActivePatternBlocks(), voices enter
    // their release phase but the block is no longer in activeBlocks_.
    // Render them here so the release tail is audible and feeds the effect chain.
    for (auto& [key, sampler] : rtSamplers_->playback)
    {
        if (!sampler || !sampler->hasSample()) continue;
        if (sampler->activeVoiceCount() == 0) continue;

        // Skip if this sampler was already rendered by the activeBlocks_ loop
        if (prevActiveKeys_.contains(key)) continue;

        const int slot = trackSlotTableFind(trackIdToSlot, key.trackId);
        if (slot < 0) continue;
        if (slot >= numTrackSlots) continue;

        trackSlots[slot].hasReleasingVoices = true;
        sampler->setVisualOnly(trackSlots[slot].info->visualOnly);
        sampler->processBlock(trackBuffers_[slot], numSamples, sampleRate);
    }

    if (rtDiagEnabled)
    {
        recordTelemetryTiming(xleth::audio::AudioTelemetrySampleKind::TrackRender,
                              -1,
                              -1,
                              xleth::audio::kAudioTelemetryEffectUnknown,
                              xleth::audio::kAudioTelemetryFlagNone,
                              numSamples,
                              sampleRate,
                              steadyNowNs() - sourceRenderStartNs);
    }

    // ── Populate per-track MidiBuffers with onset events ──────────────────────
    // Effects (e.g. TransientProcessor) can read these for sample-accurate
    // note-on and clip-start timing.  Channel 1 = pattern notes, channel 2 =
    // clip starts.  Only note-on events — no note-offs.
    for (int i = 0; i < numTrackSlots; ++i)
        trackMidiBuffers_[i].clear();

    // tailClamp: don't emit onset markers for triggers gated past the ceiling.
    const int64_t midiTriggerCeiling =
        noteTriggerCeilingSample_.load(std::memory_order_relaxed);

    // Clip-start events (channel 2, pitch 60, velocity from clip)
    for (const auto& ac : activeClips_)
    {
        if (ac.clipStartSample >= midiTriggerCeiling) continue;
        if (ac.clipStartSample >= bufStart && ac.clipStartSample < bufEnd)
        {
            const int slot = trackSlotTableFind(trackIdToSlot, ac.clip->trackId);
            if (slot < 0) continue;
            const int bufOffset = static_cast<int>(ac.clipStartSample - bufStart);
            const auto vel = static_cast<juce::uint8>(
                juce::jlimit(0.0f, 1.0f, ac.clip->velocity) * 127.0f);
            trackMidiBuffers_[slot].addEvent(
                juce::MidiMessage::noteOn(2, 60, vel), bufOffset);
        }
    }

    // Pattern note-on events (channel 1, pitch & velocity from note)
    for (const auto& apb : activeBlocks_)
    {
        const int slot = trackSlotTableFind(trackIdToSlot, apb.block->trackId);
        if (slot < 0) continue;

        const int64_t blockPosTicks    = apb.block->position.ticks;
        const int64_t blockOffsetTicks = apb.block->offset.ticks;
        const int64_t patternLenTicks  = apb.pattern->length.ticks;
        if (patternLenTicks <= 0) continue;
        const int64_t blockEndTicks = blockPosTicks + apb.block->duration.ticks;

        // Shared clock, AV_ROUND_ZERO to keep the truncation the old double
        // formula had. RT-safe: integer arithmetic only.
        const int srInt = static_cast<int>(sampleRate);
        auto tickToSample = [&](int64_t tick) -> int64_t {
            return RenderClock::ppqToSample(tick, srInt, bpm, AV_ROUND_ZERO);
        };
        auto sampleToTick = [&](int64_t sample) -> int64_t {
            return RenderClock::sampleToPPQ(sample, srInt, bpm, AV_ROUND_ZERO);
        };

        const int64_t bufStartTick = sampleToTick(bufStart);
        const int64_t bufEndTick   = sampleToTick(bufEnd);
        const int64_t windowStart  = std::max<int64_t>(bufStartTick, blockPosTicks);
        const int64_t windowEnd    = std::min<int64_t>(bufEndTick, blockEndTicks);
        if (windowEnd <= windowStart) continue;

        const int64_t firstLoop = std::max<int64_t>(
            0, (windowStart - blockPosTicks + blockOffsetTicks) / patternLenTicks);
        int64_t lastLoop = (windowEnd - blockPosTicks + blockOffsetTicks) / patternLenTicks;
        if (!apb.block->loopEnabled)
            lastLoop = std::min<int64_t>(lastLoop, 0);

        for (const auto& note : apb.pattern->notes)
        {
            for (int64_t L = firstLoop; L <= lastLoop; ++L)
            {
                const int64_t absNoteOn = blockPosTicks - blockOffsetTicks
                                          + L * patternLenTicks + note.position.ticks;
                if (absNoteOn < windowStart || absNoteOn >= windowEnd) continue;

                const int64_t absNoteOnSample = tickToSample(absNoteOn);
                if (absNoteOnSample >= midiTriggerCeiling) continue;  // tailClamp gate
                const int bufOffset = static_cast<int>(absNoteOnSample - bufStart);
                if (bufOffset < 0 || bufOffset >= numSamples) continue;

                const auto vel = static_cast<juce::uint8>(
                    juce::jlimit(0.0f, 1.0f, note.velocity) * 127.0f);
                trackMidiBuffers_[slot].addEvent(
                    juce::MidiMessage::noteOn(1, note.pitch, vel), bufOffset);
            }
        }
    }

    // Publish every track's onset buffer for this block so an effect can read
    // ANOTHER track's notes (Szkrezh Keys source). Cleared when this block ends —
    // the buffers persist between blocks but their contents are only this block's.
    XlethEffectBase::TrackMidiRef trackMidiDirectory[kMaxTracks];
    for (int i = 0; i < numTrackSlots; ++i)
        trackMidiDirectory[i] = { trackSlots[i].info->id, &trackMidiBuffers_[i] };
    XlethEffectBase::setTrackMidiDirectory(trackMidiDirectory, numTrackSlots);
    struct TrackMidiDirectoryScope
    {
        ~TrackMidiDirectoryScope() { XlethEffectBase::setTrackMidiDirectory(nullptr, 0); }
    } trackMidiDirectoryScope;

    // [MidiPop] Throttled debug log — every ~500 blocks
    {
        static int midiPopCounter = 0;
        if (++midiPopCounter >= 500)
        {
            midiPopCounter = 0;
            for (int i = 0; i < numTrackSlots; ++i)
            {
                if (trackMidiBuffers_[i].getNumEvents() > 0)
                {
                    MixDebugEntry entry;
                    entry.type = MixDebugEntry::Peaks; // reuse existing type
                    snprintf(entry.message, sizeof(entry.message),
                             "[MidiPop] track slot %d: %d events",
                             i, trackMidiBuffers_[i].getNumEvents());
                    debugLog_.push(entry);
                }
            }
        }
    }

    // ── Per-track processing: volume, pan, peaks, sum to output ──────────────
    //
    // Finding 9. The realtime audio thread does NOT take chainsMutex_. It reads
    // an immutable ChainSnapshot published by the message thread after every
    // chain mutation (publishChainSnapshotLocked), so a parameter write, an
    // automation edit or a chain rebuild in flight can no longer cost this
    // block its entire effect chain. The old try_lock dropped every per-track
    // AND master chain on a miss — a dry block and an audible level jump, on
    // ~1.9% of blocks under ordinary mixer metering and up to ~94% mid-edit.
    //
    // The OFFLINE path is unchanged and deliberately so: a non-realtime render
    // still blocks on chainsMutex_ until it owns it, so an export can never
    // skip an effect chain. Because the snapshot indexes the very same
    // EffectChainManager objects the map owns — and is republished before the
    // lock is released — both paths run identical DSP on identical objects,
    // which is what keeps an offline export reproducing live playback exactly.
    const bool nonRealtime = nonRealtime_.load(std::memory_order_relaxed);
    std::unique_lock<std::mutex> chainsLockGuard(chainsMutex_, std::defer_lock);
    if (nonRealtime)
        chainsLockGuard.lock();

    // One atomic load; the local copy pins every chain for the whole block.
    const std::shared_ptr<const ChainSnapshot> chainsPtr =
        chainSnapshot_.load(std::memory_order_acquire);
    const ChainSnapshot* const chains = chainsPtr.get();

    // Only false before the first publish (no chains exist yet), never because
    // of contention. Kept as a name so the diagnostic taps below still report
    // whether the chain region ran.
    const bool chainsLocked = (chains != nullptr);
    if (rtDiagEnabled && !chainsLocked)
    {
        audioPerformanceTelemetry_.incrementChainSnapshotMissing();
        audioPerformanceTelemetry_.incrementTrackChainSkipped(
            static_cast<uint64_t>(juce::jmax(0, numTrackSlots)));
    }

    // Set only in non-realtime (export) mode, where resetting inline under
    // chainsMutex_ keeps the render deterministic. If the mode flipped to
    // realtime since, this block is playing with the export's leftover state:
    // reset as for a jump, now, in step with the PDC delay lines.
    if (pendingEffectChainReset_ && chainsLocked && !nonRealtime)
    {
        jumpChainResetPending_ = true;
        pendingEffectChainReset_ = false;
    }
    if (pendingEffectChainReset_ && chainsLocked)
    {
        for (const auto& entry : chains->tracks)
            if (entry.chain)
                if (const auto view = entry.chain->realtimeView())
                    AudioGraph::resetProcessors(*view);

        if (chains->master)
            if (const auto view = chains->master->realtimeView())
                AudioGraph::resetProcessors(*view);

        pendingEffectChainReset_ = false;
    }

    // Live transport jump: every chain restarts in this block, the block whose
    // top already reset the PDC compensation delay lines - including chains
    // whose track is silent right now, which would otherwise carry pre-jump
    // state into their next note. Realtime safe by contract (see
    // XlethEffectBase::resetOnAudioThread); the worker, woken by the
    // generation bump, re-primes consumed spares and finishes any node left.
    if (jumpChainResetPending_ && chainsLocked)
    {
        for (const auto& entry : chains->tracks)
            if (entry.chain)
                entry.chain->resetOnAudioThread();
        if (chains->master)
            chains->master->resetOnAudioThread();

        jumpResetRequestGen_.fetch_add(1, std::memory_order_release);
        jumpChainResetPending_ = false;
    }

    if (chainsLocked)
    {
        // Automation, evaluated at THIS block's tick and written straight into
        // the effect parameters before any of them process. Placed inside the
        // chainsLocked region for three reasons at once: the lock is already
        // held (no new lock on the audio callback), no effect can be destroyed
        // while we hold it (the resolved handles cannot dangle), and the values
        // land in the same block that evaluated them — which is what makes an
        // offline export reproduce live playback exactly.
        applyAutomationForBlock(
            *chains, xleth::automation::tickAtSamplePosition(bufStart, bpm, sampleRate));

        int trackLatencies[kMaxTracks] = {};
        int maxAudibleTrackLatency = 0;

        for (int i = 0; i < numTrackSlots; ++i)
        {
            const auto* track = trackSlots[i].info;
            // Route-aware audible set (Prompt 2B): for unrouted projects this is
            // identical to the old `anySolo ? solo : !muted`; routed projects
            // pick up the mute/solo closure.
            const bool shouldPlay = routePlan.audible[i];

            const auto* chainEntry = chains->find(track->id);
            if (chainEntry != nullptr && chainEntry->chain && chainEntry->chain->isInitialized())
            {
                // Both reads are atomics on AudioGraph, so PDC can recompute on
                // the message thread mid-block without racing this.
                trackLatencies[i] = juce::jmax(0, chainEntry->chain->getOutputLatencySamples());
                const std::uint64_t epoch = chainEntry->chain->getLatencyEpoch();
                if (cachedTrackLatencyEpochs_[i] != 0 && cachedTrackLatencyEpochs_[i] != epoch)
                    audioPerformanceTelemetry_.incrementLatencyEpochChange();
                cachedTrackLatencyEpochs_[i] = epoch;
            }

            // Legacy flat max kept for diagnostics (taps, getters) only — it no
            // longer drives compensation targets.
            if (shouldPlay && !track->visualOnly)
                maxAudibleTrackLatency = std::max(maxAudibleTrackLatency, trackLatencies[i]);
        }

        // Junction PDC (Prompt 2C): compensation aligns each branch at its OWN
        // destination junction (bus input or Master input) instead of flattening
        // every track to the global max at Master — that flat target is wrong
        // once routes nest (a latent bus chain adds downstream path latency the
        // flat model never sees). buildRoutePdcPlan is pure and allocation-free;
        // for unrouted projects branchCompensationSamples[i] reduces exactly to
        // the old (maxAudibleTrackLatency − trackLatencies[i]) behavior.
        xleth::RoutePdcPlan routePdcPlan;
        xleth::buildRoutePdcPlan(routeInputs, numTrackSlots, routePlan,
                                 trackLatencies, routePdcPlan);

        for (int i = 0; i < kMaxTracks; ++i)
        {
            const int trackLatency = (i < numTrackSlots) ? trackLatencies[i] : 0;
            const int compensation = (i < numTrackSlots)
                                   ? routePdcPlan.branchCompensationSamples[i]
                                   : 0;

            cachedTrackInsertLatencySamples_[i] = trackLatency;

            if (cachedTrackCompensationSamples_[i] != compensation)
            {
                cachedTrackCompensationSamples_[i] = compensation;
                recordPdcRetarget();
            }
            syncTrackCompensationDelayState(i, compensation, false);

            const int sendsHere = (i < numTrackSlots) ? routePlan.sendCount[i] : 0;
            for (int k = 0; k < kMaxTrackSends; ++k)
            {
                const int sendComp = (k < sendsHere)
                                   ? routePdcPlan.sendCompensationSamples[i][k]
                                   : 0;
                if (cachedSendCompensationSamples_[i][k] != sendComp)
                {
                    cachedSendCompensationSamples_[i][k] = sendComp;
                    recordPdcRetarget();
                }
            }
            syncSendCompensationDelayState(i, false);
        }

        cachedMaxAudibleTrackLatencySamples_ = maxAudibleTrackLatency;
        const bool masterLive = chains->master != nullptr && chains->master->isInitialized();
        cachedMasterInsertLatencySamples_ =
            masterLive ? juce::jmax(0, chains->master->getOutputLatencySamples()) : 0;
        const std::uint64_t masterEpoch =
            masterLive ? chains->master->getLatencyEpoch() : 0;
        if (cachedMasterLatencyEpoch_ != 0 && cachedMasterLatencyEpoch_ != masterEpoch)
            audioPerformanceTelemetry_.incrementLatencyEpochChange();
        cachedMasterLatencyEpoch_ = masterEpoch;
    }

    float masterPeakL = 0.0f;
    float masterPeakR = 0.0f;

    auto emitTrackDiagnosticTap = [&](DiagnosticTapPoint point,
                                      int slot,
                                      const TrackSlot& trackSlot,
                                      bool shouldPlay,
                                      bool hasAudio,
                                      bool isTailing)
    {
        if (diagnosticTapSink == nullptr || trackSlot.info == nullptr)
            return;
        if (!diagnosticTapSink->wantsTrack(trackSlot.info->id))
            return;

        DiagnosticTapBlock tap;
        tap.point = point;
        tap.buffer = &trackBuffers_[slot];
        tap.numSamples = numSamples;
        tap.sampleRate = sampleRate;
        tap.transportStartSample = bufStart;
        tap.blockIndex = diagnosticBlockIndex;
        tap.trackId = trackSlot.info->id;
        tap.trackName = trackSlot.info->name.c_str();
        tap.trackType = trackSlot.info->type;
        tap.muted = trackSlot.info->muted;
        tap.solo = trackSlot.info->solo;
        tap.visualOnly = trackSlot.info->visualOnly;
        tap.audible = shouldPlay;
        tap.hadAudio = hasAudio;
        tap.tailing = isTailing;
        tap.chainsLocked = chainsLocked;
        tap.nonRealtime = nonRealtime_.load(std::memory_order_relaxed);
        tap.declaredLatencySamples = cachedTrackInsertLatencySamples_[slot];
        tap.compensationDelaySamples = cachedTrackCompensationSamples_[slot];
        tap.maxAudibleTrackLatencySamples = cachedMaxAudibleTrackLatencySamples_;
        tap.masterInsertLatencySamples = cachedMasterInsertLatencySamples_;
        diagnosticTapSink->capture(tap);
    };

    auto emitBusDiagnosticTap = [&](DiagnosticTapPoint point,
                                    const juce::AudioBuffer<float>& bus)
    {
        if (diagnosticTapSink == nullptr)
            return;

        DiagnosticTapBlock tap;
        tap.point = point;
        tap.buffer = &bus;
        tap.numSamples = numSamples;
        tap.sampleRate = sampleRate;
        tap.transportStartSample = bufStart;
        tap.blockIndex = diagnosticBlockIndex;
        tap.trackId = -1;
        tap.trackName = "MASTER_INPUT_SUM";
        tap.chainsLocked = chainsLocked;
        tap.nonRealtime = nonRealtime_.load(std::memory_order_relaxed);
        tap.maxAudibleTrackLatencySamples = cachedMaxAudibleTrackLatencySamples_;
        tap.masterInsertLatencySamples = cachedMasterInsertLatencySamples_;
        diagnosticTapSink->capture(tap);
    };

    // ── Resolve sidechain key taps for this block (Prompt 4C+4D) ─────────────
    // Built only under the chains lock (effect-instance resolution reads the
    // target chains). The resolved plan adds source→target processing-order
    // constraints and the per-target key taps; the audible output plan and
    // junction PDC above are untouched. A missed lock keeps the passthrough plan.
    if (chainsLocked && timeline_ != nullptr)
    {
        xleth::SidechainTapInput scTaps[xleth::SidechainPlan::kMaxTaps];
        int scTapCount = 0;
        for (int s = 0; s < numTrackSlots && scTapCount < xleth::SidechainPlan::kMaxTaps; ++s)
        {
            const auto* srcTrack = trackSlots[s].info;
            if (srcTrack == nullptr) continue;
            for (const auto& route : srcTrack->sidechainRoutes)
            {
                if (scTapCount >= xleth::SidechainPlan::kMaxTaps) break;

                // Resolve the target effect instance on the target chain. A stale
                // or missing target (deleted effect) does not resolve and is
                // skipped silently at DSP — the route persists but contributes no
                // key. A track-level route (empty id) always resolves: its key
                // goes to the target track, whatever effects listen there.
                bool resolved = route.targetEffectInstanceId.empty();
                if (!resolved)
                {
                    const auto* target = chains->find(route.targetTrackId);
                    if (target != nullptr && target->chain)
                        if (const auto view = target->chain->realtimeView())
                            resolved = view->initialized
                                       && AudioGraph::nodeIdForEffectInstance(
                                              *view, route.targetEffectInstanceId) >= 0;
                }

                xleth::SidechainTapInput& tp = scTaps[scTapCount++];
                tp.sourceSlot     = s;
                tp.targetTrackId  = route.targetTrackId;
                tp.gain           = xleth::clampSidechainGain(route.gain);
                tp.preFader       = route.preFader;
                tp.enabled        = route.enabled;
                tp.effectResolved = resolved;
            }
        }

        xleth::buildSidechainPlan(routeInputs, numTrackSlots, routePlan,
                                  scTaps, scTapCount, scPlan);

        // Clear the key buffers for the target slots that will receive a key so
        // accumulation starts from silence (no per-route heap churn — fixed,
        // pre-sized stereo buffers).
        if (scPlan.anyActive)
            for (int t = 0; t < numTrackSlots; ++t)
                if (scPlan.hasIncomingKey[t])
                    sidechainBuffers_[t].clear(0, numSamples);
    }

    // ── Per-slot work, split for parallel track processing ────────────────────
    // Phase A (runSlotA) is everything a slot does up to and including its
    // insert chain. It reads and writes only that slot's own state plus what its
    // upstream sources already summed into it (bus input, sends, sidechain key).
    // Phase B (runSlotB) is everything after the chain — key taps, fader, pan,
    // sends, PDC, tail bookkeeping, the sums into buses / Master — and is the only
    // part that writes ANOTHER slot's buffers or outputBuffer.
    //
    // Serial mix: A then B per slot in processOrder (exactly the previous loop).
    // Parallel mix: B still runs only on this thread, strictly in processOrder,
    // so every float sum lands in the same order as the serial mix and the output
    // is bit-identical. A runs on helper threads as soon as every upstream slot's
    // B is done; when this thread reaches a slot nobody has started, it runs that
    // slot's A itself, so a slow helper wake can never stall the callback.
    struct SlotAResult
    {
        bool     active                   = false;   // false: silenced/skipped in A
        bool     audible                  = false;
        bool     hasAudio                 = false;
        bool     isTailing                = false;
        bool     chainHoldsTail           = false;
        bool     chainRan                 = false;
        int      trackCompensationSamples = 0;
        uint64_t chainNs                  = 0;
        uint64_t phaseANs                 = 0;
    };
    SlotAResult slotA[kMaxTracks];

    auto runSlotA = [&](const int i, const bool onAudioThread)
    {
        SlotAResult& r = slotA[i];
        r = SlotAResult{};
        const uint64_t phaseStartNs = rtDiagEnabled ? steadyNowNs() : 0;
        struct PhaseATimer
        {
            SlotAResult& result; bool enabled; uint64_t startNs;
            ~PhaseATimer() { if (enabled) result.phaseANs = steadyNowNs() - startNs; }
        } phaseATimer { r, rtDiagEnabled, phaseStartNs };

        const auto* track = trackSlots[i].info;

        const int trackCompensationSamples = cachedTrackCompensationSamples_[i];

        // Route-aware mute/solo (Prompt 2B). For unrouted projects this matches
        // the legacy `anySolo ? solo : !muted`; for routed projects it is the
        // mute/solo closure over output-route edges (a soloed source stays
        // audible through its downstream bus path, a muted bus mutes its whole
        // subtree, etc. — see buildRoutePlan).
        const bool audible = routePlan.audible[i];

        // Sidechain-only processing (Prompt 4C+4D): a source silenced only by a
        // solo closure that still feeds an audible target's key is rendered here
        // (chain/fader/pan/PDC) to produce that key, but is summed nowhere
        // audible (the output sum below is gated on `audible`).
        const bool feedsKeyOnly = scPlan.feedsSidechainOnly[i];
        const bool shouldPlay   = audible || feedsKeyOnly;
        r.audible                  = audible;
        r.trackCompensationSamples = trackCompensationSamples;

        if (!shouldPlay)
        {
            trackPeaks_[i].peakL.store(0.0f, std::memory_order_relaxed);
            trackPeaks_[i].peakR.store(0.0f, std::memory_order_relaxed);
            tailEndSamples_[i] = 0;
            tailBelowThreshRun_[i] = 0;
            syncTrackCompensationDelayState(i, 0, true);
            syncSendCompensationDelayState(i, true);
            return;
        }

        // Tail-aware processing: keep calling the effect chain after content
        // ends so delay/reverb internal buffers drain naturally. A bus track
        // counts routed input from upstream sources (summed earlier this block,
        // topo order) as audio, so a bus with no clips of its own still runs its
        // chain and drains its tail (Prompt 2B).
        const bool hasAudio  = trackSlots[i].hasClips
                             || trackSlots[i].hasReleasingVoices
                             || receivedRoutedInput[i];
        const bool isTailing = !hasAudio
                             && tailEndSamples_[i] > 0
                             && bufStart < tailEndSamples_[i];

        if (!hasAudio && !isTailing)
        {
            trackPeaks_[i].peakL.store(0.0f, std::memory_order_relaxed);
            trackPeaks_[i].peakR.store(0.0f, std::memory_order_relaxed);
            tailEndSamples_[i] = 0;
            tailBelowThreshRun_[i] = 0;
            syncTrackCompensationDelayState(i, trackCompensationSamples, true);
            syncSendCompensationDelayState(i, true);
            return;
        }

        syncTrackCompensationDelayState(i, trackCompensationSamples, false);

        // 1. Update smoothed volume target so the ramp stays current even
        //    while effects run.  Indexed by slot i (always in [0, kMaxTracks)).
        volumeSmoothed_[i].setTargetValue(
            trackParams_[i].volume.load(std::memory_order_relaxed));

        // Per-track insert effect chain (if present) — runs on the full-level
        // input so level-dependent effects (compressor, gate, etc.) respond to
        // the original dynamics, not the fader position.
        // Raised by an effect that still holds material it will play while its
        // output is momentarily silent (XlethEffectBase::raiseTailHold); the
        // tail drain below then treats this block as not silent.
        bool chainHoldsTail = false;
        if (chainsLocked)
        {
            const auto* chainEntry = chains->find(track->id);
            // The view is loaded once here and held for the whole chain call:
            // it pins every processor the chain is about to run, so a message
            // thread removing one mid-block cannot pull it out from under us.
            const auto chainView = (chainEntry != nullptr && chainEntry->chain)
                                       ? chainEntry->chain->realtimeView()
                                       : std::shared_ptr<const xleth::audio::GraphRealtimeView>{};
            const bool chainLive = chainEntry != nullptr && chainEntry->chain
                                && chainView && chainView->initialized;
            // Claim the chain against an off-thread reset (see
            // EffectChainManager::beginRealtimeUse). A miss means the worker is
            // resetting it right now — only possible just after a seek or play
            // start. A freshly reset chain has nothing to output yet, so stand
            // in with silence for this one block rather than a dry burst.
            const bool chainClaimed = chainLive && chainEntry->chain->beginRealtimeUse();
            if (chainLive && !chainClaimed)
            {
                trackBuffers_[i].clear(0, numSamples);
                if (rtDiagEnabled)
                    audioPerformanceTelemetry_.incrementTrackChainSkipped(1);
            }
            if (chainClaimed)
            {
                // Hand this target's accumulated key to the chain's sidechain
                // source node for the duration of its processBlock (Prompt 4C+4D).
                // The key buffer (sidechainBuffers_[i]) was filled by upstream
                // source slots already processed this block. No-op when the chain
                // has no sidechain source node — production stock/VST consumption
                // is deferred (Prompt 5), so this is silent until a consumer exists.
                const bool deliverKey = scPlan.hasIncomingKey[i];
                if (deliverKey)
                {
                    const auto& key = sidechainBuffers_[i];
                    chainEntry->chain->setSidechainKeyBuffer(
                        key.getReadPointer(0),
                        key.getNumChannels() > 1 ? key.getReadPointer(1)
                                                 : key.getReadPointer(0),
                        numSamples);
                }

                // Deliver this track's note/clip gate to any in-effect Envelope
                // modulators (Xleth Filter) before the chain runs this block.
                // Only tracks with an active filter envelope appear in
                // filterGates_, so non-filter chains are never touched.
                for (int gi = 0; gi < filterGateCount_; ++gi)
                {
                    if (filterGates_[gi].trackId == track->id)
                    {
                        AudioGraph::deliverModulationGate(
                            *chainView, filterGates_[gi].valid,
                            filterGates_[gi].start, filterGates_[gi].end);
                        break;
                    }
                }

                const uint64_t chainStartNs = rtDiagEnabled ? steadyNowNs() : 0;
                // Per-plugin timing goes through the telemetry ring, which has a
                // single producer (this callback thread): helper threads only
                // measure the whole chain, and phase B records it from here.
                if (rtDiagEnabled && onAudioThread)
                {
                    XlethEffectBase::RealtimeTimingContext context;
                    context.enabled = true;
                    context.trackId = track->id;
                    context.userData = this;
                    context.recordPlugin = &MixEngine::realtimePluginTimingCallback;
                    context.recordSection = &MixEngine::realtimeSectionTimingCallback;
                    context.recordEvent = &MixEngine::realtimeEventCallback;
                    XlethEffectBase::setRealtimeTimingContext(context);
                }

                (void) XlethEffectBase::takeTailHold();
                chainEntry->chain->processBlock(trackBuffers_[i], numSamples,
                                                trackMidiBuffers_[i]);
                chainHoldsTail = XlethEffectBase::takeTailHold();

                if (rtDiagEnabled)
                {
                    if (onAudioThread)
                        XlethEffectBase::setRealtimeTimingContext({});
                    r.chainNs = steadyNowNs() - chainStartNs;
                }
                r.chainRan = true;

                // Drop the borrowed key pointers so no later block reads them.
                if (deliverKey)
                    chainEntry->chain->clearSidechainKeyBuffer();

                chainEntry->chain->endRealtimeUse();
            }
        }

        r.active         = true;
        r.hasAudio       = hasAudio;
        r.isTailing      = isTailing;
        r.chainHoldsTail = chainHoldsTail;
    };

    auto runSlotB = [&](const int i)
    {
        const SlotAResult& r = slotA[i];
        const auto* track = trackSlots[i].info;
        const uint64_t phaseBStartNs = rtDiagEnabled ? steadyNowNs() : 0;
        struct TrackTimingScope
        {
            MixEngine* engine; bool enabled; int trackId; uint64_t phaseANs; uint64_t startNs;
            ~TrackTimingScope()
            {
                if (enabled && engine != nullptr)
                    engine->recordTrackProcessTiming(trackId, phaseANs + (steadyNowNs() - startNs));
            }
        } trackTiming { this, rtDiagEnabled, track != nullptr ? track->id : -1, r.phaseANs, phaseBStartNs };

        if (rtDiagEnabled && r.chainRan)
            recordTrackChainTiming(track->id, r.chainNs);
        if (!r.active)
            return;

        const int  trackCompensationSamples = r.trackCompensationSamples;
        const bool audible        = r.audible;
        const bool hasAudio       = r.hasAudio;
        const bool isTailing      = r.isTailing;
        const bool chainHoldsTail = r.chainHoldsTail;

        // Sidechain pre-fader key tap (Prompt 4C+4D): snapshot the post-chain,
        // pre-fader signal of this source into each enabled pre-fader route's
        // target key buffer, scaled by the route gain. The key never enters any
        // audible buffer — only sidechainBuffers_[target]. Cheap: a handful of
        // taps, no string lookup, no allocation.
        if (scPlan.anyActive)
        {
            for (int k = 0; k < scPlan.tapCount; ++k)
            {
                if (scPlan.tapSourceSlot[k] != i || !scPlan.tapPreFader[k]) continue;
                auto& key = sidechainBuffers_[scPlan.tapTargetSlot[k]];
                const int nCh = std::min(key.getNumChannels(), trackBuffers_[i].getNumChannels());
                for (int ch = 0; ch < nCh; ++ch)
                    key.addFrom(ch, 0, trackBuffers_[i], ch, 0, numSamples, scPlan.tapGain[k]);
            }
        }

        // Post-effects fader — 20ms linear ramp to eliminate zipper noise.
        {
            const int nCh = trackBuffers_[i].getNumChannels();
            float* bufL = trackBuffers_[i].getWritePointer(0);
            float* bufR = nCh > 1 ? trackBuffers_[i].getWritePointer(1) : nullptr;
            for (int s = 0; s < numSamples; ++s)
            {
                const float g = volumeSmoothed_[i].getNextValue();
                bufL[s] *= g;
                if (bufR != nullptr) bufR[s] *= g;
            }
        }

        // 2. Pan + spread + peak measurement.
        //    Pass volume=1.0f — volume was already applied by SmoothedValue above.
        //    Indexed by slot i, not track ID.
        const float pan    = trackParams_[i].pan.load(std::memory_order_relaxed);
        const float spread = trackParams_[i].spread.load(std::memory_order_relaxed);
        float tpL = 0.0f, tpR = 0.0f;
        TrackMixer::process(trackBuffers_[i], 1.0f, pan, spread, tpL, tpR);

        // Store track peaks before compensation so meters stay responsive.
        trackPeaks_[i].peakL.store(tpL, std::memory_order_relaxed);
        trackPeaks_[i].peakR.store(tpR, std::memory_order_relaxed);

        emitTrackDiagnosticTap(DiagnosticTapPoint::PrePdcTrack,
                               i,
                               trackSlots[i],
                               audible,
                               hasAudio,
                               isTailing);

        // Tail decisions read the signal ENTERING the compensation delay (see the
        // drain bookkeeping below); only needed once content has ended.
        const float preCompensationMag =
            hasAudio ? 0.0f : trackBuffers_[i].getMagnitude(0, numSamples);

        // Sends (FL multi-wiring): the post-fader/post-pan signal also sums into
        // every send target's pre-chain buffer at the send's level. Each edge is
        // aligned by its OWN delay line (per-edge junction PDC), so it is tapped
        // here, BEFORE the primary edge's in-place compensation delay below. The
        // targets run later in topo order (sends are route-plan edges). A level
        // change ramps across the block from the edge's previous level.
        if (audible && numSamples <= sendScratch_.getNumSamples())
        {
            for (int k = 0; k < routePlan.sendCount[i]; ++k)
            {
                const int targetSlot = routePlan.sendTargetSlot[i][k];
                if (targetSlot < 0 || targetSlot >= numTrackSlots)
                    continue;
                const int nCh = std::min({ sendScratch_.getNumChannels(),
                                           trackBuffers_[i].getNumChannels(),
                                           trackBuffers_[targetSlot].getNumChannels() });
                for (int ch = 0; ch < nCh; ++ch)
                    sendScratch_.copyFrom(ch, 0, trackBuffers_[i], ch, 0, numSamples);
                sendCompensationDelays_[i][k].process(sendScratch_, numSamples);

                const float gainTo   = routePlan.sendGain[i][k];
                const float gainFrom = sendGainPrev_[i][k];
                auto& targetBuf = trackBuffers_[targetSlot];
                for (int ch = 0; ch < nCh; ++ch)
                {
                    if (gainFrom == gainTo)
                        targetBuf.addFrom(ch, 0, sendScratch_, ch, 0, numSamples, gainTo);
                    else
                        targetBuf.addFromWithRamp(ch, 0, sendScratch_.getReadPointer(ch),
                                                  numSamples, gainFrom, gainTo);
                }
                sendGainPrev_[i][k] = gainTo;
                receivedRoutedInput[targetSlot] = true;
            }
        }

        {
            const uint64_t pdcStartNs = rtDiagEnabled ? steadyNowNs() : 0;
            trackCompensationDelays_[i].process(trackBuffers_[i], numSamples);
            if (rtDiagEnabled)
                recordPdcDelayTiming(steadyNowNs() - pdcStartNs);
        }

        emitTrackDiagnosticTap(DiagnosticTapPoint::PostPdcTrack,
                               i,
                               trackSlots[i],
                               audible,
                               hasAudio,
                               isTailing);

        // ── Effect-tail drain bookkeeping (silence-detected) ─────────────────
        // While content plays, arm a generous hard cap so the insert chain keeps
        // running after the clip ends — that is what lets reverb/delay wet tails
        // (including external VSTs) ring out past the boundary. Once content has
        // ended (isTailing), stop once the signal entering the compensation delay
        // has stayed below -60 dB for ~50 ms (tail fully decayed) PLUS the
        // compensation delay itself, or the cap expires — whichever comes first.
        // The decision is driven by the ACTUAL level, never the plugin's
        // self-reported getTailLengthSeconds(), which VST reverbs routinely
        // report as 0 or "infinite".
        //
        // Stopping clears the compensation delay's history (the !hasAudio &&
        // !isTailing branch above), so it must only happen once that delay holds
        // nothing but silence. Measuring the post-PDC output does NOT guarantee
        // that: it is the signal from `compensation` samples ago, and when that
        // older content had a gap of its own (stuttered clips on a track
        // compensated by hundreds of ms) the output went quiet while audible
        // audio was still queued — the clear then deleted it, and live playback
        // dropped whole clips that an export (one large block, no empty blocks
        // between them) kept.
        if (hasAudio)
        {
            tailEndSamples_[i] = bufEnd
                + static_cast<int64_t>(std::ceil(kRealtimeTailMaxSeconds * sampleRate));
            tailBelowThreshRun_[i] = 0;
        }
        else  // isTailing — this point is reached only when hasAudio || isTailing
        {
            if (preCompensationMag < kRealtimeTailThresholdLinear && !chainHoldsTail)
                tailBelowThreshRun_[i] += numSamples;
            else
                tailBelowThreshRun_[i] = 0;

            const int64_t holdSamples =
                static_cast<int64_t>(kRealtimeTailHoldSeconds * sampleRate + 0.5)
                + juce::jmax(trackCompensationSamples,
                             trackCompensationDelays_[i].getCurrentDelaySamples());
            if (tailBelowThreshRun_[i] >= holdSamples)
            {
                tailEndSamples_[i] = 0;       // tail decayed — stop next block
                tailBelowThreshRun_[i] = 0;
            }
        }

        // Sidechain post-fader key tap (Prompt 4C+4D): the post-fader / post-pan /
        // post-PDC signal is the v1 "best-effort post-compensation" tap point per
        // the audit (§5.1). Accumulate into each enabled post-fader route's target
        // key buffer, scaled by route gain. Never enters any audible buffer.
        if (scPlan.anyActive)
        {
            for (int k = 0; k < scPlan.tapCount; ++k)
            {
                if (scPlan.tapSourceSlot[k] != i || scPlan.tapPreFader[k]) continue;
                auto& key = sidechainBuffers_[scPlan.tapTargetSlot[k]];
                const int nCh = std::min(key.getNumChannels(), trackBuffers_[i].getNumChannels());
                for (int ch = 0; ch < nCh; ++ch)
                    key.addFrom(ch, 0, trackBuffers_[i], ch, 0, numSamples, scPlan.tapGain[k]);
            }
        }

        // Sidechain-only sources (Prompt 4C+4D) have produced their key above but
        // are NOT audible — skip every audible sum so the key never leaks into
        // Master or any bus.
        if (!audible)
            return;

        // Route-aware sum (Prompt 2B). A default route (-1) sums to Master
        // (outputBuffer); a bus route sums into the target track's pre-chain
        // buffer so routed audio runs through the bus chain/fader when the bus
        // slot processes later in topo order. A routed source touches
        // outputBuffer zero times — its only path to Master is via its target,
        // so there is no direct-to-Master duplicate.
        const int targetSlot = routePlan.outputTargetSlot[i];
        if (targetSlot < 0)
        {
            for (int ch = 0; ch < std::min(2, outputBuffer.getNumChannels()); ++ch)
                outputBuffer.addFrom(ch, 0, trackBuffers_[i], ch, 0, numSamples);
        }
        else
        {
            auto& targetBuf = trackBuffers_[targetSlot];
            const int nCh = std::min(targetBuf.getNumChannels(),
                                     trackBuffers_[i].getNumChannels());
            for (int ch = 0; ch < nCh; ++ch)
                targetBuf.addFrom(ch, 0, trackBuffers_[i], ch, 0, numSamples);
            receivedRoutedInput[targetSlot] = true;
        }
    };

    xleth::audio::RealtimeWorkerPool* const trackPool = trackWorkerPool_.get();
    const bool parallelMix = trackPool != nullptr && trackPool->numWorkers() > 0
                          && parallelTrackJob_ != nullptr
                          && parallelTracksEnabled_.load(std::memory_order_relaxed)
                          && chainsLocked && numTrackSlots >= 2;
    if (!parallelMix)
    {
        for (int oi = 0; oi < numTrackSlots; ++oi)
        {
            // Topological + sidechain order: every source slot has summed into its
            // bus AND produced its key before the consuming slot runs its chain.
            const int i = scPlan.processOrder[oi];
            runSlotA(i, true);
            runSlotB(i);
        }
    }
    else
    {
        ParallelTrackJob& job = *parallelTrackJob_;
        int inDeg[kMaxTracks] = {};
        for (int s = 0; s < numTrackSlots; ++s)
        {
            job.claim[s].store(0, std::memory_order_relaxed);
            job.done[s].store(0, std::memory_order_relaxed);
            job.edgeCount[s] = 0;
        }
        // Every way a slot's phase B writes into another slot: its output route,
        // its sends, and its sidechain key taps. The target's phase A may start
        // only after all of these sources have run phase B.
        auto addEdge = [&](int u, int t)
        {
            if (u < 0 || u >= numTrackSlots || t < 0 || t >= numTrackSlots || t == u) return;
            if (job.edgeCount[u] >= ParallelTrackJob::kMaxEdgesPerSlot) return;
            job.edgeTarget[u][job.edgeCount[u]++] = t;
            ++inDeg[t];
        };
        for (int u = 0; u < numTrackSlots; ++u)
        {
            addEdge(u, routePlan.outputTargetSlot[u]);
            for (int k = 0; k < routePlan.sendCount[u]; ++k)
                addEdge(u, routePlan.sendTargetSlot[u][k]);
        }
        if (scPlan.anyActive)
            for (int k = 0; k < scPlan.tapCount; ++k)
                addEdge(scPlan.tapSourceSlot[k], scPlan.tapTargetSlot[k]);

        int readyTail = 0;
        for (int oi = 0; oi < numTrackSlots; ++oi)
        {
            const int i = scPlan.processOrder[oi];
            job.inDeg[i].store(inDeg[i], std::memory_order_relaxed);
            if (inDeg[i] == 0)
                job.readyQ[readyTail++] = i;
        }
        job.readyHead.store(0, std::memory_order_relaxed);
        job.readyTail.store(readyTail, std::memory_order_release);
        job.runner    = &runSlotA;
        job.runA      = [](void* runner, int slot) { (*static_cast<decltype(runSlotA)*>(runner))(slot, false); };
        job.midiDir   = trackMidiDirectory;
        job.midiCount = numTrackSlots;
        job.mxcsr     = _mm_getcsr();   // helpers adopt this thread's FTZ/DAZ/rounding
        job.pool      = trackPool;
        trackPool->open(&MixEngine::parallelTrackWorker, &job);

        for (int oi = 0; oi < numTrackSlots; ++oi)
        {
            const int i = scPlan.processOrder[oi];
            if (job.done[i].load(std::memory_order_acquire) == 0)
            {
                int expected = 0;
                if (job.claim[i].compare_exchange_strong(expected, 1, std::memory_order_acq_rel))
                {
                    runSlotA(i, true);
                    job.done[i].store(1, std::memory_order_release);
                }
                else
                {
                    while (job.done[i].load(std::memory_order_acquire) == 0)
                        _mm_pause();
                }
            }
            runSlotB(i);
            for (int e = 0; e < job.edgeCount[i]; ++e)
            {
                const int t = job.edgeTarget[i][e];
                if (job.inDeg[t].fetch_sub(1, std::memory_order_acq_rel) == 1)
                {
                    job.readyQ[readyTail++] = t;
                    job.readyTail.store(readyTail, std::memory_order_release);
                }
            }
        }
        trackPool->close();
    }

    // ── Preview samplers (audition bus, also audible during playback) ────────
    // Piano-roll / MiniKeyboard auditioned notes render here into a dedicated
    // bus so they never compete with timeline playback voices on the same
    // region. Mixes directly into the master output, bypassing track routing.
    //
    // Always DRY here. Every track chain has already processed its own track
    // in this block, and a chain may only be processed once per block — see
    // renderPreviewSamplers. Effect-rack auditioning is a transport-stopped
    // feature; while the transport rolls the arrangement is already audible
    // through those racks anyway.
    renderPreviewSamplers(outputBuffer, numSamples, sampleRate, bpm,
                          /*chains=*/nullptr);

    emitBusDiagnosticTap(DiagnosticTapPoint::MasterInputSum, outputBuffer);

    // Master bus insert effect chain
    const auto masterView = (chainsLocked && chains->master)
                                ? chains->master->realtimeView()
                                : std::shared_ptr<const xleth::audio::GraphRealtimeView>{};
    const bool masterLive = chainsLocked && chains->master && masterView && masterView->initialized;
    const bool masterClaimed = masterLive && chains->master->beginRealtimeUse();
    if (masterLive && !masterClaimed)
    {
        // Master mid-reset (just after a seek): silence, never an unprocessed
        // mix — same reasoning as the per-track claim above.
        outputBuffer.clear(0, numSamples);
        if (rtDiagEnabled)
            audioPerformanceTelemetry_.incrementTrackChainSkipped(1);
    }
    if (masterClaimed)
    {
        const uint64_t masterChainStartNs = rtDiagEnabled ? steadyNowNs() : 0;
        if (rtDiagEnabled)
        {
            XlethEffectBase::RealtimeTimingContext context;
            context.enabled = true;
            context.trackId = -1;
            context.userData = this;
            context.recordPlugin = &MixEngine::realtimePluginTimingCallback;
            context.recordSection = &MixEngine::realtimeSectionTimingCallback;
            context.recordEvent = &MixEngine::realtimeEventCallback;
            XlethEffectBase::setRealtimeTimingContext(context);
        }

        chains->master->processBlock(outputBuffer, numSamples, emptyMasterMidi_);

        if (rtDiagEnabled)
        {
            XlethEffectBase::setRealtimeTimingContext({});
            recordTrackChainTiming(-1, steadyNowNs() - masterChainStartNs);
        }

        chains->master->endRealtimeUse();
    }

    // Master volume fader (post-effect-chain)
    const float masterVol = masterVolume_.load(std::memory_order_relaxed);
    if (masterVol != 1.0f)
        outputBuffer.applyGain(masterVol);

    emitBusDiagnosticTap(DiagnosticTapPoint::PostMasterOutput, outputBuffer);

    // ── Master loudness meter (opt-in) ──────────────────────────────────────
    // Same point as the PostMasterOutput tap above: post master insert chain,
    // post master fader, pre safety clamp — what the mix actually measures.
    // Disabled cost is the single acquire load below. When enabled, the claim
    // published here is what lets prepare()/reset() mutate the analyzer from the
    // message thread without this thread ever blocking; see MixEngine.h. The
    // analyzer allocates only in prepare(), never here.
    if (masterLoudnessEnabled_.load(std::memory_order_acquire)
        && outputBuffer.getNumChannels() >= 2)
    {
        masterLoudnessInUse_.store(true, std::memory_order_seq_cst);
        if (masterLoudnessEnabled_.load(std::memory_order_seq_cst))
            masterLoudness_.processBlock(outputBuffer.getArrayOfReadPointers(), numSamples);
        masterLoudnessInUse_.store(false, std::memory_order_seq_cst);
    }

    // ── Clamp output to [-1, +1] (hard safety limit; replace with soft limiter in P3) ──
    for (int ch = 0; ch < outputBuffer.getNumChannels(); ++ch)
    {
        float* data = outputBuffer.getWritePointer(ch);
        for (int s = 0; s < numSamples; ++s)
        {
            if (data[s] > 1.0f)       data[s] = 1.0f;
            else if (data[s] < -1.0f) data[s] = -1.0f;
        }
    }

    if (rtDiagEnabled)
    {
        bool hasNonFinite = false;
        for (int ch = 0; ch < outputBuffer.getNumChannels() && !hasNonFinite; ++ch)
        {
            const float* data = outputBuffer.getReadPointer(ch);
            for (int s = 0; s < numSamples; ++s)
            {
                if (!std::isfinite(data[s]))
                {
                    hasNonFinite = true;
                    break;
                }
            }
        }

        if (hasNonFinite)
        {
            realtimeDiagnostics_.nanInfBlockCount.fetch_add(1, std::memory_order_relaxed);
            audioPerformanceTelemetry_.incrementNanInfBlock();
        }
    }

    const uint64_t outputPostStartNs = rtDiagEnabled ? steadyNowNs() : 0;

    // Recompute master peaks from clamped output
    masterPeakL = outputBuffer.getMagnitude(0, 0, numSamples);
    if (outputBuffer.getNumChannels() >= 2)
        masterPeakR = outputBuffer.getMagnitude(1, 0, numSamples);

    masterPeakL_.store(masterPeakL, std::memory_order_relaxed);
    masterPeakR_.store(masterPeakR, std::memory_order_relaxed);

    if (rtDiagEnabled)
    {
        recordTelemetryTiming(xleth::audio::AudioTelemetrySampleKind::OutputPost,
                              -1,
                              -1,
                              xleth::audio::kAudioTelemetryEffectUnknown,
                              xleth::audio::kAudioTelemetryFlagNone,
                              numSamples,
                              sampleRate,
                              steadyNowNs() - outputPostStartNs);
    }

    // Debug logging (throttled to ~1 Hz)
    maybeLogDebug(numSamples, sampleRate);
}

// ── Debug logging ────────────────────────────────────────────────────────────

void MixEngine::maybeLogDebug(int numSamples, double sampleRate)
{
    debugSampleRate_ = sampleRate;
    debugSampleCounter_ += numSamples;

    if (debugSampleCounter_ < static_cast<int64_t>(sampleRate))
        return; // less than 1 second since last log

    debugSampleCounter_ = 0;

    // Log active clip count
    {
        MixDebugEntry entry;
        entry.type = MixDebugEntry::ActiveClips;
        std::snprintf(entry.message, sizeof(entry.message),
                      "Active clips: %d", static_cast<int>(activeClips_.size()));
        debugLog_.push(entry);
    }

    // Log peak meters
    {
        MixDebugEntry entry;
        entry.type = MixDebugEntry::Peaks;
        std::snprintf(entry.message, sizeof(entry.message),
                      "Master peaks: L=%.4f R=%.4f",
                      masterPeakL_.load(std::memory_order_relaxed),
                      masterPeakR_.load(std::memory_order_relaxed));
        debugLog_.push(entry);
    }

    // Warn on unmapped regions. sortedClipsByStart_ mirrors every clip and was
    // refreshed by findActiveClips() this block; getAllClips() would allocate.
    if (timeline_ != nullptr)
    {
        const auto regionMap = loadRegionSampleMap();
        for (const auto* clip : sortedClipsByStart_)
        {
            if (regionMap->find(clip->regionId) == regionMap->end())
            {
                MixDebugEntry entry;
                entry.type = MixDebugEntry::UnmappedRegion;
                std::snprintf(entry.message, sizeof(entry.message),
                              "WARNING: region %d (clip %d) unmapped",
                              clip->regionId, clip->id);
                debugLog_.push(entry);
            }
        }
    }
}
