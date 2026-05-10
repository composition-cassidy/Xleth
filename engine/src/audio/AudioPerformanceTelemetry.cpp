#include "audio/AudioPerformanceTelemetry.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <unordered_map>

namespace xleth::audio {
namespace {

void atomicMax(std::atomic<std::uint32_t>& target, std::uint32_t value) noexcept
{
    std::uint32_t observed = target.load(std::memory_order_relaxed);
    while (value > observed
        && !target.compare_exchange_weak(observed, value,
                                         std::memory_order_relaxed,
                                         std::memory_order_relaxed))
    {
    }
}

bool equals(const char* a, const char* b) noexcept
{
    return a != nullptr && b != nullptr && std::strcmp(a, b) == 0;
}

AudioTelemetryMetricSummary summarizeDurations(std::vector<std::uint32_t>& values)
{
    AudioTelemetryMetricSummary summary;
    summary.count = static_cast<std::uint64_t>(values.size());
    if (values.empty())
        return summary;

    std::uint64_t total = 0;
    for (std::uint32_t value : values)
        total += value;

    std::sort(values.begin(), values.end());
    const auto percentile = [&](double p) -> std::uint32_t {
        if (values.empty())
            return 0;
        const double scaled = p * static_cast<double>(values.size() - 1);
        const auto index = static_cast<std::size_t>(std::ceil(scaled));
        return values[std::min(index, values.size() - 1)];
    };

    summary.averageUs = static_cast<double>(total)
                      / static_cast<double>(values.size());
    summary.p50Us = percentile(0.50);
    summary.p95Us = percentile(0.95);
    summary.p99Us = percentile(0.99);
    summary.maxUs = values.back();
    return summary;
}

struct ScopeKeyHash
{
    std::size_t operator()(const AudioPerformanceTelemetry::ScopeKey& key) const noexcept
    {
        std::size_t h = static_cast<std::size_t>(key.effectType);
        h ^= static_cast<std::size_t>(key.flags) + 0x9e3779b9u + (h << 6) + (h >> 2);
        h ^= static_cast<std::size_t>(static_cast<std::uint32_t>(key.trackId))
           + 0x9e3779b9u + (h << 6) + (h >> 2);
        h ^= static_cast<std::size_t>(static_cast<std::uint32_t>(key.slotOrNodeId))
           + 0x9e3779b9u + (h << 6) + (h >> 2);
        h ^= static_cast<std::size_t>(key.kind) + 0x9e3779b9u + (h << 6) + (h >> 2);
        return h;
    }
};

void appendWorstScopes(
    const std::vector<AudioTelemetryTimingSample>& history,
    AudioTelemetrySampleKind firstKind,
    AudioTelemetrySampleKind secondKind,
    std::vector<AudioTelemetryWorstScope>& byMax,
    std::vector<AudioTelemetryWorstScope>& byP99)
{
    std::unordered_map<AudioPerformanceTelemetry::ScopeKey,
                       std::vector<std::uint32_t>,
                       ScopeKeyHash> grouped;

    for (const auto& sample : history)
    {
        if (sample.kind != firstKind && sample.kind != secondKind)
            continue;

        AudioPerformanceTelemetry::ScopeKey key;
        key.kind = sample.kind;
        key.effectType = sample.effectType;
        key.flags = sample.flags;
        key.trackId = sample.trackId;
        key.slotOrNodeId = sample.slotOrNodeId;
        grouped[key].push_back(sample.durationUs);
    }

    std::vector<AudioTelemetryWorstScope> scopes;
    scopes.reserve(grouped.size());
    for (auto& [key, values] : grouped)
    {
        AudioTelemetryWorstScope scope;
        scope.kind = key.kind;
        scope.effectType = key.effectType;
        scope.flags = key.flags;
        scope.trackId = key.trackId;
        scope.slotOrNodeId = key.slotOrNodeId;
        scope.timing = summarizeDurations(values);
        scopes.push_back(scope);
    }

    byMax = scopes;
    std::sort(byMax.begin(), byMax.end(),
              [](const auto& a, const auto& b) {
                  return a.timing.maxUs > b.timing.maxUs;
              });
    if (byMax.size() > AudioPerformanceTelemetry::kMaxWorstScopes)
        byMax.resize(AudioPerformanceTelemetry::kMaxWorstScopes);

    byP99 = std::move(scopes);
    std::sort(byP99.begin(), byP99.end(),
              [](const auto& a, const auto& b) {
                  return a.timing.p99Us > b.timing.p99Us;
              });
    if (byP99.size() > AudioPerformanceTelemetry::kMaxWorstScopes)
        byP99.resize(AudioPerformanceTelemetry::kMaxWorstScopes);
}

AudioPerformanceTelemetrySnapshot summarizeSamples(
    const std::vector<AudioTelemetryTimingSample>& samples,
    const AudioTelemetryCounterSnapshot& counters,
    std::uint64_t minSequence)
{
    AudioPerformanceTelemetrySnapshot snapshot;
    snapshot.counters = counters;

    std::vector<AudioTelemetryTimingSample> filtered;
    const std::vector<AudioTelemetryTimingSample>* source = &samples;
    if (minSequence > 0)
    {
        filtered.reserve(samples.size());
        for (const auto& item : samples)
            if (item.sequence >= minSequence)
                filtered.push_back(item);
        source = &filtered;
    }

    auto summarizeKind = [&](AudioTelemetrySampleKind kind) {
        std::vector<std::uint32_t> values;
        values.reserve(source->size());
        for (const auto& item : *source)
            if (item.kind == kind)
                values.push_back(item.durationUs);
        return summarizeDurations(values);
    };

    snapshot.callback = summarizeKind(AudioTelemetrySampleKind::AudioCallback);
    snapshot.mixBlock = summarizeKind(AudioTelemetrySampleKind::MixBlock);
    snapshot.trackRender = summarizeKind(AudioTelemetrySampleKind::TrackRender);
    snapshot.trackChain = summarizeKind(AudioTelemetrySampleKind::TrackChain);
    snapshot.masterChain = summarizeKind(AudioTelemetrySampleKind::MasterChain);
    snapshot.effect = summarizeKind(AudioTelemetrySampleKind::Effect);
    snapshot.effectSection = summarizeKind(AudioTelemetrySampleKind::EffectSection);
    snapshot.pdcDelay = summarizeKind(AudioTelemetrySampleKind::PdcDelay);
    snapshot.outputPost = summarizeKind(AudioTelemetrySampleKind::OutputPost);

    for (auto it = source->rbegin();
         it != source->rend()
             && snapshot.recentCallbackDurationUs.size()
                    < AudioPerformanceTelemetry::kMaxRecentCallbacks;
         ++it)
    {
        if (it->kind == AudioTelemetrySampleKind::AudioCallback)
            snapshot.recentCallbackDurationUs.push_back(it->durationUs);
    }
    std::reverse(snapshot.recentCallbackDurationUs.begin(),
                 snapshot.recentCallbackDurationUs.end());

    appendWorstScopes(*source,
                      AudioTelemetrySampleKind::Effect,
                      AudioTelemetrySampleKind::EffectSection,
                      snapshot.worstEffectsByMax,
                      snapshot.worstEffectsByP99);
    appendWorstScopes(*source,
                      AudioTelemetrySampleKind::TrackChain,
                      AudioTelemetrySampleKind::MasterChain,
                      snapshot.worstChainsByMax,
                      snapshot.worstChainsByP99);

    return snapshot;
}

void appendUnique(std::vector<std::string>& values, const char* value)
{
    if (value == nullptr || value[0] == '\0')
        return;
    if (std::find(values.begin(), values.end(), value) == values.end())
        values.emplace_back(value);
}

std::uint32_t deadlineUsForRisk(const RealtimeRsHqRiskInputs& inputs) noexcept
{
    if (inputs.counters.lastDeadlineUs > 0)
        return inputs.counters.lastDeadlineUs;
    if (inputs.blockSize == 0 || inputs.sampleRate <= 0.0
        || !std::isfinite(inputs.sampleRate))
    {
        return 0;
    }

    const long double us =
        (static_cast<long double>(inputs.blockSize)
         / static_cast<long double>(inputs.sampleRate)) * 1000000.0L;
    if (us <= 0.0L || !std::isfinite(static_cast<double>(us)))
        return 0;
    return us > static_cast<long double>(UINT32_MAX)
        ? UINT32_MAX
        : static_cast<std::uint32_t>(us + 0.5L);
}

} // namespace

void AudioPerformanceTelemetry::setEnabled(bool enabled) noexcept
{
    enabled_.store(enabled, std::memory_order_release);
}

bool AudioPerformanceTelemetry::isEnabled() const noexcept
{
    return enabled_.load(std::memory_order_acquire);
}

void AudioPerformanceTelemetry::reset()
{
    const bool wasEnabled = enabled_.load(std::memory_order_relaxed);
    enabled_.store(false, std::memory_order_release);
    clearRing();

    droppedTimingSamples_.store(0, std::memory_order_relaxed);
    audioCallbackCount_.store(0, std::memory_order_relaxed);
    mixBlockCount_.store(0, std::memory_order_relaxed);
    callbackOverrunCount_.store(0, std::memory_order_relaxed);
    mixOverrunCount_.store(0, std::memory_order_relaxed);
    overBudgetBlockCount_.store(0, std::memory_order_relaxed);
    chainLockMissCount_.store(0, std::memory_order_relaxed);
    masterChainSkippedCount_.store(0, std::memory_order_relaxed);
    trackChainSkippedCount_.store(0, std::memory_order_relaxed);
    staleSnapshotReuseCount_.store(0, std::memory_order_relaxed);
    guardedPluginCrashedSkippedCount_.store(0, std::memory_order_relaxed);
    latencyEpochChangeCount_.store(0, std::memory_order_relaxed);
    compensationTargetChangeCount_.store(0, std::memory_order_relaxed);
    pdcDelayProcessCount_.store(0, std::memory_order_relaxed);
    resonanceSuppressorWolaCallCount_.store(0, std::memory_order_relaxed);
    resonanceSuppressorAudioThreadReprepareCount_.store(0, std::memory_order_relaxed);
    resonanceSuppressorDeferredReprepareCount_.store(0, std::memory_order_relaxed);
    nanInfBlockCount_.store(0, std::memory_order_relaxed);
    lastBlockSize_.store(0, std::memory_order_relaxed);
    lastSampleRateMilliHz_.store(0, std::memory_order_relaxed);
    lastDeadlineUs_.store(0, std::memory_order_relaxed);
    maxCallbackDurationUs_.store(0, std::memory_order_relaxed);
    maxMixDurationUs_.store(0, std::memory_order_relaxed);
    sequence_.store(0, std::memory_order_relaxed);

    {
        std::lock_guard<std::mutex> lock(snapshotMutex_);
        history_.clear();
    }

    enabled_.store(wasEnabled, std::memory_order_release);
}

void AudioPerformanceTelemetry::recordTimingFromAudioThread(
    const AudioTelemetryTimingSample& input) noexcept
{
    if (!enabled_.load(std::memory_order_relaxed))
        return;

    AudioTelemetryTimingSample sample = input;
    sample.sequence = sequence_.fetch_add(1, std::memory_order_relaxed) + 1;
    if (sample.deadlineUs == 0)
        sample.deadlineUs = deadlineUsFor(sample.blockSize, sample.sampleRateMilliHz);

    const std::uint32_t write = writePos_.load(std::memory_order_relaxed);
    const std::uint32_t read = readPos_.load(std::memory_order_acquire);
    const std::uint32_t next = (write + 1u) & (kTimingRingCapacity - 1u);
    if (next == read)
    {
        droppedTimingSamples_.fetch_add(1, std::memory_order_relaxed);
        return;
    }

    timingRing_[write] = sample;
    writePos_.store(next, std::memory_order_release);

    if (sample.kind == AudioTelemetrySampleKind::AudioCallback)
    {
        audioCallbackCount_.fetch_add(1, std::memory_order_relaxed);
        atomicMax(maxCallbackDurationUs_, sample.durationUs);
        if (sample.deadlineUs > 0 && sample.durationUs >= sample.deadlineUs)
            callbackOverrunCount_.fetch_add(1, std::memory_order_relaxed);
    }
    else if (sample.kind == AudioTelemetrySampleKind::MixBlock)
    {
        mixBlockCount_.fetch_add(1, std::memory_order_relaxed);
        atomicMax(maxMixDurationUs_, sample.durationUs);
        if (sample.deadlineUs > 0 && sample.durationUs >= sample.deadlineUs)
            mixOverrunCount_.fetch_add(1, std::memory_order_relaxed);
        if (sample.deadlineUs > 0
            && static_cast<std::uint64_t>(sample.durationUs) * 100u
                >= static_cast<std::uint64_t>(sample.deadlineUs) * 70u)
        {
            overBudgetBlockCount_.fetch_add(1, std::memory_order_relaxed);
        }
        lastBlockSize_.store(sample.blockSize, std::memory_order_relaxed);
        lastSampleRateMilliHz_.store(sample.sampleRateMilliHz, std::memory_order_relaxed);
        lastDeadlineUs_.store(sample.deadlineUs, std::memory_order_relaxed);
    }
    else if (sample.kind == AudioTelemetrySampleKind::PdcDelay)
    {
        pdcDelayProcessCount_.fetch_add(1, std::memory_order_relaxed);
    }
    else if (sample.kind == AudioTelemetrySampleKind::EffectSection
             && (sample.flags & kAudioTelemetryFlagWola) != 0)
    {
        resonanceSuppressorWolaCallCount_.fetch_add(1, std::memory_order_relaxed);
    }
}

void AudioPerformanceTelemetry::incrementChainLockMiss() noexcept
{
    chainLockMissCount_.fetch_add(1, std::memory_order_relaxed);
}

void AudioPerformanceTelemetry::incrementMasterChainSkipped() noexcept
{
    masterChainSkippedCount_.fetch_add(1, std::memory_order_relaxed);
}

void AudioPerformanceTelemetry::incrementTrackChainSkipped(std::uint64_t amount) noexcept
{
    trackChainSkippedCount_.fetch_add(amount, std::memory_order_relaxed);
}

void AudioPerformanceTelemetry::incrementStaleSnapshotReuse() noexcept
{
    staleSnapshotReuseCount_.fetch_add(1, std::memory_order_relaxed);
}

void AudioPerformanceTelemetry::incrementGuardedPluginCrashedSkipped() noexcept
{
    guardedPluginCrashedSkippedCount_.fetch_add(1, std::memory_order_relaxed);
}

void AudioPerformanceTelemetry::incrementLatencyEpochChange() noexcept
{
    latencyEpochChangeCount_.fetch_add(1, std::memory_order_relaxed);
}

void AudioPerformanceTelemetry::incrementCompensationTargetChange() noexcept
{
    compensationTargetChangeCount_.fetch_add(1, std::memory_order_relaxed);
}

void AudioPerformanceTelemetry::incrementResonanceSuppressorAudioThreadReprepare() noexcept
{
    resonanceSuppressorAudioThreadReprepareCount_.fetch_add(1, std::memory_order_relaxed);
}

void AudioPerformanceTelemetry::incrementResonanceSuppressorDeferredReprepare() noexcept
{
    resonanceSuppressorDeferredReprepareCount_.fetch_add(1, std::memory_order_relaxed);
}

void AudioPerformanceTelemetry::incrementNanInfBlock() noexcept
{
    nanInfBlockCount_.fetch_add(1, std::memory_order_relaxed);
}

AudioPerformanceTelemetrySnapshot AudioPerformanceTelemetry::getSnapshot()
{
    return getSnapshotInternal(0);
}

AudioPerformanceTelemetrySnapshot AudioPerformanceTelemetry::getSnapshotSince(
    std::uint64_t minSequence)
{
    return getSnapshotInternal(minSequence);
}

AudioPerformanceTelemetrySnapshot AudioPerformanceTelemetry::getSnapshotInternal(
    std::uint64_t minSequence)
{
    std::lock_guard<std::mutex> lock(snapshotMutex_);
    drainPendingTimingSamplesLocked();
    return summarizeSamples(history_, loadCounters(), minSequence);
}

void AudioPerformanceTelemetry::beginCaptureAccumulation(std::uint64_t minSequence)
{
    std::lock_guard<std::mutex> lock(snapshotMutex_);
    drainPendingTimingSamplesLocked();
    captureActive_ = true;
    captureMinSequence_ = minSequence == 0 ? 1 : minSequence;
    captureAccumulatorOverflowDrops_ = 0;
    captureHistory_.clear();
    captureHistory_.reserve(std::min<std::size_t>(kMaxCaptureSamples, 65536));
}

void AudioPerformanceTelemetry::drainPendingTimingSamplesForCapture()
{
    std::lock_guard<std::mutex> lock(snapshotMutex_);
    drainPendingTimingSamplesLocked();
}

AudioPerformanceTelemetryCaptureResult
AudioPerformanceTelemetry::finishCaptureAccumulation()
{
    std::lock_guard<std::mutex> lock(snapshotMutex_);
    drainPendingTimingSamplesLocked();

    AudioPerformanceTelemetryCaptureResult result;
    result.accumulatedTimingSampleCount =
        static_cast<std::uint64_t>(captureHistory_.size());
    result.accumulatorOverflowDrops = captureAccumulatorOverflowDrops_;
    result.snapshot = summarizeSamples(captureHistory_,
                                       loadCounters(),
                                       captureMinSequence_);

    captureActive_ = false;
    captureMinSequence_ = 1;
    captureHistory_.clear();
    captureAccumulatorOverflowDrops_ = 0;
    return result;
}

AudioTelemetryCounterSnapshot
AudioPerformanceTelemetry::getCounterSnapshot() const noexcept
{
    return loadCounters();
}

std::uint32_t AudioPerformanceTelemetry::effectTypeFromPluginId(const char* pluginId) noexcept
{
    if (equals(pluginId, "resonancesuppressor"))
        return kAudioTelemetryEffectResonanceSuppressor;
    if (equals(pluginId, "eq") || equals(pluginId, "xletheq"))
        return kAudioTelemetryEffectEQ;
    if (equals(pluginId, "compressor"))
        return kAudioTelemetryEffectCompressor;
    if (equals(pluginId, "limiter"))
        return kAudioTelemetryEffectLimiter;
    if (equals(pluginId, "third_party"))
        return kAudioTelemetryEffectThirdParty;
    return kAudioTelemetryEffectUnknown;
}

std::uint32_t AudioPerformanceTelemetry::flagsFromPluginId(const char* pluginId) noexcept
{
    const auto type = effectTypeFromPluginId(pluginId);
    return (type == kAudioTelemetryEffectThirdParty
            || (type == kAudioTelemetryEffectUnknown && pluginId != nullptr && pluginId[0] != '\0'))
        ? kAudioTelemetryFlagThirdParty
        : kAudioTelemetryFlagNone;
}

std::uint32_t AudioPerformanceTelemetry::flagsFromSectionId(const char* sectionId) noexcept
{
    if (equals(sectionId, "rs_wola"))
        return kAudioTelemetryFlagHighQuality | kAudioTelemetryFlagWola;
    return kAudioTelemetryFlagNone;
}

const char* AudioPerformanceTelemetry::effectTypeName(std::uint32_t effectType) noexcept
{
    switch (effectType)
    {
        case kAudioTelemetryEffectResonanceSuppressor: return "resonancesuppressor";
        case kAudioTelemetryEffectEQ: return "eq";
        case kAudioTelemetryEffectCompressor: return "compressor";
        case kAudioTelemetryEffectLimiter: return "limiter";
        case kAudioTelemetryEffectThirdParty: return "third_party";
        default: return "unknown";
    }
}

double AudioPerformanceTelemetry::coveragePercent(
    std::uint64_t retainedSamples,
    std::uint64_t expectedSamples) noexcept
{
    if (expectedSamples == 0)
        return 0.0;
    const double percent =
        (static_cast<double>(retainedSamples) * 100.0)
        / static_cast<double>(expectedSamples);
    return std::isfinite(percent) ? percent : 0.0;
}

const char* AudioPerformanceTelemetry::classifyCoverageQuality(
    std::uint64_t callbackSampleCount,
    std::uint64_t mixEngineSampleCount,
    std::uint64_t expectedCallbackCount) noexcept
{
    if (expectedCallbackCount == 0 || callbackSampleCount == 0
        || mixEngineSampleCount == 0)
    {
        return "inconclusive";
    }

    const double callbackCoverage =
        coveragePercent(callbackSampleCount, expectedCallbackCount);
    if (callbackCoverage < 5.0)
        return "inconclusive";
    if (callbackCoverage >= 90.0)
        return "good";
    if (callbackCoverage >= 50.0)
        return "usable";
    return "poor";
}

AudioPerformanceTelemetrySnapshot
AudioPerformanceTelemetry::summarizeTimingSamples(
    const std::vector<AudioTelemetryTimingSample>& samples,
    const AudioTelemetryCounterSnapshot& counters,
    std::uint64_t minSequence)
{
    return summarizeSamples(samples, counters, minSequence);
}

RealtimeRsHqRiskDiagnostics AudioPerformanceTelemetry::classifyRealtimeRsHqRisk(
    const RealtimeRsHqRiskInputs& inputs)
{
    RealtimeRsHqRiskDiagnostics result;
    result.activeResonanceSuppressorHighQualityInstanceCount =
        inputs.activeHighQualityInstanceCount;

    if (inputs.offlineOrExport)
    {
        appendUnique(result.realtimeRsHqRiskReasons, "exportOfflineSafe");
        appendUnique(result.recommendedAction, "useHqForExport");
        return result;
    }

    if (inputs.activeHighQualityInstanceCount == 0)
        return result;

    const std::uint32_t deadlineUs = deadlineUsForRisk(inputs);
    const bool telemetryOverrun =
        inputs.counters.callbackOverrunCount > 0
        || inputs.counters.mixOverrunCount > 0
        || (deadlineUs > 0
            && (inputs.callback.maxUs >= deadlineUs
                || inputs.callback.p99Us >= deadlineUs
                || inputs.mixBlock.maxUs >= deadlineUs
                || inputs.mixBlock.p99Us >= deadlineUs));

    const bool wolaNearDeadline =
        deadlineUs > 0
        && inputs.resonanceSuppressorWola.count > 0
        && (static_cast<std::uint64_t>(inputs.resonanceSuppressorWola.p99Us) * 100u
                >= static_cast<std::uint64_t>(deadlineUs) * 60u
            || static_cast<std::uint64_t>(inputs.resonanceSuppressorWola.maxUs) * 100u
                >= static_cast<std::uint64_t>(deadlineUs) * 70u);

    if (inputs.activeHighQualityInstanceCount > 1)
    {
        result.realtimeRsHqRiskLevel = "warning";
        appendUnique(result.realtimeRsHqRiskReasons, "multipleInstances");
        appendUnique(result.recommendedAction, "reduceHqInstances");
        appendUnique(result.recommendedAction, "useNormalQualityForRealtime");
        appendUnique(result.recommendedAction, "useHqForExport");
    }
    else if (inputs.blockSize > 0 && inputs.blockSize <= 256)
    {
        result.realtimeRsHqRiskLevel = "warning";
        appendUnique(result.realtimeRsHqRiskReasons, "smallBlockSize");
        appendUnique(result.recommendedAction, "increaseBufferSize");
        appendUnique(result.recommendedAction, "useNormalQualityForRealtime");
        appendUnique(result.recommendedAction, "useHqForExport");
    }

    if (wolaNearDeadline)
    {
        result.realtimeRsHqRiskLevel = "warning";
        appendUnique(result.realtimeRsHqRiskReasons, "wolaNearDeadline");
        appendUnique(result.recommendedAction, "increaseBufferSize");
        appendUnique(result.recommendedAction, "optimizationNeeded");
    }

    if (telemetryOverrun)
    {
        result.realtimeRsHqRiskLevel = "overrunning";
        appendUnique(result.realtimeRsHqRiskReasons, "telemetryOverrun");
        appendUnique(result.recommendedAction, "increaseBufferSize");
        appendUnique(result.recommendedAction, "reduceHqInstances");
        appendUnique(result.recommendedAction, "useNormalQualityForRealtime");
        appendUnique(result.recommendedAction, "useHqForExport");
        appendUnique(result.recommendedAction, "optimizationNeeded");
    }

    return result;
}

AudioTelemetryCounterSnapshot AudioPerformanceTelemetry::loadCounters() const noexcept
{
    AudioTelemetryCounterSnapshot counters;
    counters.enabled = enabled_.load(std::memory_order_acquire);
    counters.droppedTimingSamples = droppedTimingSamples_.load(std::memory_order_relaxed);
    counters.audioCallbackCount = audioCallbackCount_.load(std::memory_order_relaxed);
    counters.mixBlockCount = mixBlockCount_.load(std::memory_order_relaxed);
    counters.callbackOverrunCount = callbackOverrunCount_.load(std::memory_order_relaxed);
    counters.mixOverrunCount = mixOverrunCount_.load(std::memory_order_relaxed);
    counters.overBudgetBlockCount = overBudgetBlockCount_.load(std::memory_order_relaxed);
    counters.chainLockMissCount = chainLockMissCount_.load(std::memory_order_relaxed);
    counters.masterChainSkippedCount = masterChainSkippedCount_.load(std::memory_order_relaxed);
    counters.trackChainSkippedCount = trackChainSkippedCount_.load(std::memory_order_relaxed);
    counters.staleSnapshotReuseCount = staleSnapshotReuseCount_.load(std::memory_order_relaxed);
    counters.guardedPluginCrashedSkippedCount =
        guardedPluginCrashedSkippedCount_.load(std::memory_order_relaxed);
    counters.latencyEpochChangeCount = latencyEpochChangeCount_.load(std::memory_order_relaxed);
    counters.compensationTargetChangeCount =
        compensationTargetChangeCount_.load(std::memory_order_relaxed);
    counters.pdcDelayProcessCount = pdcDelayProcessCount_.load(std::memory_order_relaxed);
    counters.resonanceSuppressorWolaCallCount =
        resonanceSuppressorWolaCallCount_.load(std::memory_order_relaxed);
    counters.resonanceSuppressorAudioThreadReprepareCount =
        resonanceSuppressorAudioThreadReprepareCount_.load(std::memory_order_relaxed);
    counters.resonanceSuppressorDeferredReprepareCount =
        resonanceSuppressorDeferredReprepareCount_.load(std::memory_order_relaxed);
    counters.nanInfBlockCount = nanInfBlockCount_.load(std::memory_order_relaxed);
    counters.lastBlockSize = lastBlockSize_.load(std::memory_order_relaxed);
    counters.lastSampleRateMilliHz = lastSampleRateMilliHz_.load(std::memory_order_relaxed);
    counters.lastDeadlineUs = lastDeadlineUs_.load(std::memory_order_relaxed);
    counters.maxCallbackDurationUs = maxCallbackDurationUs_.load(std::memory_order_relaxed);
    counters.maxMixDurationUs = maxMixDurationUs_.load(std::memory_order_relaxed);
    counters.lastTimingSequence = sequence_.load(std::memory_order_relaxed);
    return counters;
}

void AudioPerformanceTelemetry::drainPendingTimingSamplesLocked()
{
    AudioTelemetryTimingSample sample;
    while (popTimingSample(sample))
    {
        history_.push_back(sample);
        appendCaptureSampleLocked(sample);
        if (history_.size() > kMaxHistorySamples)
            history_.erase(history_.begin(),
                           history_.begin()
                               + static_cast<std::ptrdiff_t>(
                                     history_.size() - kMaxHistorySamples));
    }
}

void AudioPerformanceTelemetry::appendCaptureSampleLocked(
    const AudioTelemetryTimingSample& sample)
{
    if (!captureActive_ || sample.sequence < captureMinSequence_)
        return;

    if (captureHistory_.size() >= kMaxCaptureSamples)
    {
        ++captureAccumulatorOverflowDrops_;
        return;
    }
    captureHistory_.push_back(sample);
}

bool AudioPerformanceTelemetry::popTimingSample(AudioTelemetryTimingSample& sample) noexcept
{
    const std::uint32_t read = readPos_.load(std::memory_order_relaxed);
    const std::uint32_t write = writePos_.load(std::memory_order_acquire);
    if (read == write)
        return false;

    sample = timingRing_[read];
    readPos_.store((read + 1u) & (kTimingRingCapacity - 1u),
                   std::memory_order_release);
    return true;
}

void AudioPerformanceTelemetry::clearRing() noexcept
{
    readPos_.store(0, std::memory_order_relaxed);
    writePos_.store(0, std::memory_order_relaxed);
}

std::uint32_t AudioPerformanceTelemetry::elapsedNsToUs(std::uint64_t elapsedNs) noexcept
{
    const std::uint64_t us = (elapsedNs + 999u) / 1000u;
    return us > UINT32_MAX ? UINT32_MAX : static_cast<std::uint32_t>(us);
}

std::uint32_t AudioPerformanceTelemetry::deadlineUsFor(
    std::uint32_t blockSize,
    std::uint64_t sampleRateMilliHz) noexcept
{
    if (blockSize == 0 || sampleRateMilliHz == 0)
        return 0;

    const long double sampleRate =
        static_cast<long double>(sampleRateMilliHz) / 1000.0L;
    const long double us =
        (static_cast<long double>(blockSize) / sampleRate) * 1000000.0L;
    if (us <= 0.0L || !std::isfinite(static_cast<double>(us)))
        return 0;
    return us > static_cast<long double>(UINT32_MAX)
        ? UINT32_MAX
        : static_cast<std::uint32_t>(us + 0.5L);
}

} // namespace xleth::audio
