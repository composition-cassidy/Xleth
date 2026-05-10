#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <type_traits>
#include <vector>

namespace xleth::audio {

enum class AudioTelemetrySampleKind : std::uint8_t
{
    AudioCallback = 1,
    MixBlock = 2,
    TrackRender = 3,
    TrackChain = 4,
    MasterChain = 5,
    Effect = 6,
    EffectSection = 7,
    PdcDelay = 8,
    OutputPost = 9
};

enum AudioTelemetryFlags : std::uint32_t
{
    kAudioTelemetryFlagNone = 0,
    kAudioTelemetryFlagMaster = 1u << 0,
    kAudioTelemetryFlagHighQuality = 1u << 1,
    kAudioTelemetryFlagWola = 1u << 2,
    kAudioTelemetryFlagSpectral = 1u << 3,
    kAudioTelemetryFlagLookahead = 1u << 4,
    kAudioTelemetryFlagThirdParty = 1u << 5,
    kAudioTelemetryFlagBypassed = 1u << 6
};

enum AudioTelemetryEffectType : std::uint32_t
{
    kAudioTelemetryEffectUnknown = 0,
    kAudioTelemetryEffectResonanceSuppressor = 1,
    kAudioTelemetryEffectEQ = 2,
    kAudioTelemetryEffectCompressor = 3,
    kAudioTelemetryEffectLimiter = 4,
    kAudioTelemetryEffectThirdParty = 0x80000000u
};

struct AudioTelemetryTimingSample
{
    std::uint64_t sequence = 0;
    std::uint64_t sampleRateMilliHz = 0;
    std::uint64_t latencyEpoch = 0;
    std::uint32_t deadlineUs = 0;
    std::uint32_t durationUs = 0;
    std::uint32_t blockSize = 0;
    std::uint32_t effectType = 0;
    std::uint32_t flags = 0;
    std::int32_t trackId = -1;
    std::int32_t slotOrNodeId = -1;
    std::int32_t compensationSamples = 0;
    AudioTelemetrySampleKind kind = AudioTelemetrySampleKind::MixBlock;
};

static_assert(std::is_trivially_copyable_v<AudioTelemetryTimingSample>);
static_assert(std::is_standard_layout_v<AudioTelemetryTimingSample>);

struct AudioTelemetryCounterSnapshot
{
    bool enabled = false;
    std::uint64_t droppedTimingSamples = 0;
    std::uint64_t audioCallbackCount = 0;
    std::uint64_t mixBlockCount = 0;
    std::uint64_t callbackOverrunCount = 0;
    std::uint64_t mixOverrunCount = 0;
    std::uint64_t overBudgetBlockCount = 0;
    std::uint64_t chainLockMissCount = 0;
    std::uint64_t masterChainSkippedCount = 0;
    std::uint64_t trackChainSkippedCount = 0;
    std::uint64_t staleSnapshotReuseCount = 0;
    std::uint64_t guardedPluginCrashedSkippedCount = 0;
    std::uint64_t latencyEpochChangeCount = 0;
    std::uint64_t compensationTargetChangeCount = 0;
    std::uint64_t pdcDelayProcessCount = 0;
    std::uint64_t resonanceSuppressorWolaCallCount = 0;
    std::uint64_t resonanceSuppressorAudioThreadReprepareCount = 0;
    std::uint64_t resonanceSuppressorDeferredReprepareCount = 0;
    std::uint64_t nanInfBlockCount = 0;
    std::uint32_t lastBlockSize = 0;
    std::uint64_t lastSampleRateMilliHz = 0;
    std::uint32_t lastDeadlineUs = 0;
    std::uint32_t maxCallbackDurationUs = 0;
    std::uint32_t maxMixDurationUs = 0;
    std::uint64_t lastTimingSequence = 0;
};

struct AudioTelemetryMetricSummary
{
    std::uint64_t count = 0;
    double averageUs = 0.0;
    std::uint32_t p50Us = 0;
    std::uint32_t p95Us = 0;
    std::uint32_t p99Us = 0;
    std::uint32_t maxUs = 0;
};

struct AudioTelemetryWorstScope
{
    AudioTelemetrySampleKind kind = AudioTelemetrySampleKind::MixBlock;
    std::uint32_t effectType = 0;
    std::uint32_t flags = 0;
    std::int32_t trackId = -1;
    std::int32_t slotOrNodeId = -1;
    AudioTelemetryMetricSummary timing;
};

struct AudioPerformanceTelemetrySnapshot
{
    AudioTelemetryCounterSnapshot counters;
    AudioTelemetryMetricSummary callback;
    AudioTelemetryMetricSummary mixBlock;
    AudioTelemetryMetricSummary trackRender;
    AudioTelemetryMetricSummary trackChain;
    AudioTelemetryMetricSummary masterChain;
    AudioTelemetryMetricSummary effect;
    AudioTelemetryMetricSummary effectSection;
    AudioTelemetryMetricSummary pdcDelay;
    AudioTelemetryMetricSummary outputPost;
    std::vector<std::uint32_t> recentCallbackDurationUs;
    std::vector<AudioTelemetryWorstScope> worstEffectsByMax;
    std::vector<AudioTelemetryWorstScope> worstEffectsByP99;
    std::vector<AudioTelemetryWorstScope> worstChainsByMax;
    std::vector<AudioTelemetryWorstScope> worstChainsByP99;
};

struct AudioPerformanceTelemetryCaptureResult
{
    AudioPerformanceTelemetrySnapshot snapshot;
    std::uint64_t accumulatedTimingSampleCount = 0;
    std::uint64_t accumulatorOverflowDrops = 0;
};

struct RealtimeRsHqRiskInputs
{
    double sampleRate = 0.0;
    std::uint32_t blockSize = 0;
    bool offlineOrExport = false;
    std::uint32_t activeHighQualityInstanceCount = 0;
    AudioTelemetryCounterSnapshot counters;
    AudioTelemetryMetricSummary callback;
    AudioTelemetryMetricSummary mixBlock;
    AudioTelemetryMetricSummary resonanceSuppressorWola;
};

struct RealtimeRsHqRiskDiagnostics
{
    std::uint32_t activeResonanceSuppressorHighQualityInstanceCount = 0;
    std::string realtimeRsHqRiskLevel = "healthy";
    std::vector<std::string> realtimeRsHqRiskReasons;
    std::vector<std::string> recommendedAction;
};

class AudioPerformanceTelemetry
{
public:
    static constexpr std::uint32_t kTimingRingCapacity = 8192;
    static constexpr std::size_t kMaxHistorySamples = 4096;
    static constexpr std::size_t kMaxCaptureSamples = 1000000;
    static constexpr std::size_t kMaxRecentCallbacks = 64;
    static constexpr std::size_t kMaxWorstScopes = 8;

    struct ScopeKey
    {
        AudioTelemetrySampleKind kind = AudioTelemetrySampleKind::MixBlock;
        std::uint32_t effectType = 0;
        std::uint32_t flags = 0;
        std::int32_t trackId = -1;
        std::int32_t slotOrNodeId = -1;

        bool operator==(const ScopeKey& other) const noexcept
        {
            return kind == other.kind
                && effectType == other.effectType
                && flags == other.flags
                && trackId == other.trackId
                && slotOrNodeId == other.slotOrNodeId;
        }
    };

    void setEnabled(bool enabled) noexcept;
    bool isEnabled() const noexcept;
    void reset();

    void recordTimingFromAudioThread(const AudioTelemetryTimingSample& sample) noexcept;
    void incrementChainLockMiss() noexcept;
    void incrementMasterChainSkipped() noexcept;
    void incrementTrackChainSkipped(std::uint64_t amount = 1) noexcept;
    void incrementStaleSnapshotReuse() noexcept;
    void incrementGuardedPluginCrashedSkipped() noexcept;
    void incrementLatencyEpochChange() noexcept;
    void incrementCompensationTargetChange() noexcept;
    void incrementResonanceSuppressorAudioThreadReprepare() noexcept;
    void incrementResonanceSuppressorDeferredReprepare() noexcept;
    void incrementNanInfBlock() noexcept;

    AudioPerformanceTelemetrySnapshot getSnapshot();
    AudioPerformanceTelemetrySnapshot getSnapshotSince(std::uint64_t minSequence);
    void beginCaptureAccumulation(std::uint64_t minSequence);
    void drainPendingTimingSamplesForCapture();
    AudioPerformanceTelemetryCaptureResult finishCaptureAccumulation();
    AudioTelemetryCounterSnapshot getCounterSnapshot() const noexcept;

    static std::uint32_t effectTypeFromPluginId(const char* pluginId) noexcept;
    static std::uint32_t flagsFromPluginId(const char* pluginId) noexcept;
    static std::uint32_t flagsFromSectionId(const char* sectionId) noexcept;
    static const char* effectTypeName(std::uint32_t effectType) noexcept;
    static double coveragePercent(std::uint64_t retainedSamples,
                                  std::uint64_t expectedSamples) noexcept;
    static const char* classifyCoverageQuality(std::uint64_t callbackSampleCount,
                                               std::uint64_t mixEngineSampleCount,
                                               std::uint64_t expectedCallbackCount) noexcept;
    static AudioPerformanceTelemetrySnapshot summarizeTimingSamples(
        const std::vector<AudioTelemetryTimingSample>& samples,
        const AudioTelemetryCounterSnapshot& counters,
        std::uint64_t minSequence = 0);
    static RealtimeRsHqRiskDiagnostics classifyRealtimeRsHqRisk(
        const RealtimeRsHqRiskInputs& inputs);

private:
    AudioTelemetryCounterSnapshot loadCounters() const noexcept;
    AudioPerformanceTelemetrySnapshot getSnapshotInternal(std::uint64_t minSequence);
    void drainPendingTimingSamplesLocked();
    void appendCaptureSampleLocked(const AudioTelemetryTimingSample& sample);
    bool popTimingSample(AudioTelemetryTimingSample& sample) noexcept;
    void clearRing() noexcept;
    static std::uint32_t elapsedNsToUs(std::uint64_t elapsedNs) noexcept;
    static std::uint32_t deadlineUsFor(std::uint32_t blockSize,
                                       std::uint64_t sampleRateMilliHz) noexcept;

    std::array<AudioTelemetryTimingSample, kTimingRingCapacity> timingRing_ {};
    std::atomic<std::uint32_t> writePos_{0};
    std::atomic<std::uint32_t> readPos_{0};
    std::atomic<std::uint64_t> sequence_{0};

    std::atomic<bool> enabled_{false};
    std::atomic<std::uint64_t> droppedTimingSamples_{0};
    std::atomic<std::uint64_t> audioCallbackCount_{0};
    std::atomic<std::uint64_t> mixBlockCount_{0};
    std::atomic<std::uint64_t> callbackOverrunCount_{0};
    std::atomic<std::uint64_t> mixOverrunCount_{0};
    std::atomic<std::uint64_t> overBudgetBlockCount_{0};
    std::atomic<std::uint64_t> chainLockMissCount_{0};
    std::atomic<std::uint64_t> masterChainSkippedCount_{0};
    std::atomic<std::uint64_t> trackChainSkippedCount_{0};
    std::atomic<std::uint64_t> staleSnapshotReuseCount_{0};
    std::atomic<std::uint64_t> guardedPluginCrashedSkippedCount_{0};
    std::atomic<std::uint64_t> latencyEpochChangeCount_{0};
    std::atomic<std::uint64_t> compensationTargetChangeCount_{0};
    std::atomic<std::uint64_t> pdcDelayProcessCount_{0};
    std::atomic<std::uint64_t> resonanceSuppressorWolaCallCount_{0};
    std::atomic<std::uint64_t> resonanceSuppressorAudioThreadReprepareCount_{0};
    std::atomic<std::uint64_t> resonanceSuppressorDeferredReprepareCount_{0};
    std::atomic<std::uint64_t> nanInfBlockCount_{0};
    std::atomic<std::uint32_t> lastBlockSize_{0};
    std::atomic<std::uint64_t> lastSampleRateMilliHz_{0};
    std::atomic<std::uint32_t> lastDeadlineUs_{0};
    std::atomic<std::uint32_t> maxCallbackDurationUs_{0};
    std::atomic<std::uint32_t> maxMixDurationUs_{0};

    std::mutex snapshotMutex_;
    std::vector<AudioTelemetryTimingSample> history_;
    bool captureActive_ = false;
    std::uint64_t captureMinSequence_ = 1;
    std::uint64_t captureAccumulatorOverflowDrops_ = 0;
    std::vector<AudioTelemetryTimingSample> captureHistory_;
};

} // namespace xleth::audio
