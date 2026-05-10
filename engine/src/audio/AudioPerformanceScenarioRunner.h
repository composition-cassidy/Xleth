#pragma once

#include "audio/AudioPerformanceTelemetry.h"

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace xleth::audio {

enum class AudioPerfBudgetClassification
{
    Healthy,
    Warning,
    Overrunning
};

struct AudioPerfScenarioMetadata
{
    std::string id;
    std::string name;
    std::string description;
    double sampleRate = 48000.0;
    std::uint32_t blockSize = 512;
    std::uint32_t blockCount = 96;
    std::uint64_t totalRenderedSamples = 0;
    std::uint32_t deadlineUs = 0;
};

struct AudioPerfLatencyAccounting
{
    std::uint32_t latencyEpochChanges = 0;
    std::uint32_t compensationTargetChanges = 0;
    std::uint32_t maxTrackLatencySamples = 0;
    std::uint32_t masterLatencySamples = 0;
    std::uint32_t livePresentationLatencySamples = 0;
};

struct AudioPerfScenarioReport
{
    AudioPerfScenarioMetadata metadata;
    AudioPerformanceTelemetrySnapshot telemetry;
    AudioPerfLatencyAccounting latency;
    AudioPerfBudgetClassification classification = AudioPerfBudgetClassification::Healthy;
};

class AudioPerformanceScenarioRunner
{
public:
    struct ScopePlan
    {
        AudioTelemetrySampleKind kind = AudioTelemetrySampleKind::Effect;
        std::uint32_t effectType = kAudioTelemetryEffectUnknown;
        std::uint32_t flags = kAudioTelemetryFlagNone;
        std::int32_t trackId = -1;
        std::int32_t slotOrNodeId = -1;
        std::uint32_t baseDurationUs = 0;
        std::uint32_t peakDurationUs = 0;
        std::uint32_t cadence = 0;
    };

    struct ScenarioDefinition
    {
        AudioPerfScenarioMetadata metadata;
        AudioPerfLatencyAccounting latency;
        std::uint32_t callbackBaseUs = 0;
        std::uint32_t callbackPeakUs = 0;
        std::uint32_t mixBaseUs = 0;
        std::uint32_t mixPeakUs = 0;
        std::uint32_t droppedTelemetrySamples = 0;
        std::uint32_t lockMisses = 0;
        std::uint32_t staleSnapshotReuses = 0;
        std::uint32_t guardedPluginCrashedSkips = 0;
        std::vector<ScopePlan> scopes;
    };

    static std::vector<ScenarioDefinition> defaultScenarios();
    static AudioPerfScenarioReport runScenario(const ScenarioDefinition& definition);
    static std::vector<AudioPerfScenarioReport> runDefaultScenarios();

    static AudioPerfBudgetClassification classify(std::uint32_t deadlineUs,
                                                  const AudioTelemetryMetricSummary& callback,
                                                  const AudioTelemetryMetricSummary& mixEngine,
                                                  const AudioTelemetryCounterSnapshot& counters);
    static const char* classificationName(AudioPerfBudgetClassification classification) noexcept;
    static bool hasStrictBudgetFailure(const std::vector<AudioPerfScenarioReport>& reports);
    static bool strictModeEnabled() noexcept;

    static std::string toJson(const AudioPerfScenarioReport& report);
    static std::string toJson(const std::vector<AudioPerfScenarioReport>& reports);
    static std::string toMarkdown(const AudioPerfScenarioReport& report);
    static std::string toMarkdown(const std::vector<AudioPerfScenarioReport>& reports);
    static void writeReports(const std::vector<AudioPerfScenarioReport>& reports,
                             const std::filesystem::path& directory);
};

} // namespace xleth::audio
