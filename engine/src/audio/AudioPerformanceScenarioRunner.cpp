#include "audio/AudioPerformanceScenarioRunner.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdlib>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace xleth::audio {
namespace {

using json = nlohmann::json;

std::uint32_t deadlineUsFor(std::uint32_t blockSize, double sampleRate) noexcept
{
    if (blockSize == 0 || sampleRate <= 0.0 || !std::isfinite(sampleRate))
        return 0;

    const double us = (static_cast<double>(blockSize) / sampleRate) * 1000000.0;
    return us <= 0.0 || !std::isfinite(us)
        ? 0u
        : static_cast<std::uint32_t>(us + 0.5);
}

std::uint64_t sampleRateMilliHz(double sampleRate) noexcept
{
    if (sampleRate <= 0.0 || !std::isfinite(sampleRate))
        return 0;
    return static_cast<std::uint64_t>((sampleRate * 1000.0) + 0.5);
}

std::uint32_t durationForBlock(std::uint32_t block,
                               std::uint32_t baseUs,
                               std::uint32_t peakUs,
                               std::uint32_t cadence) noexcept
{
    if (peakUs <= baseUs || cadence == 0)
        return baseUs;
    return ((block + 1u) % cadence == 0u) ? peakUs : baseUs;
}

AudioTelemetryTimingSample makeSample(const AudioPerfScenarioMetadata& metadata,
                                      AudioTelemetrySampleKind kind,
                                      std::uint32_t durationUs,
                                      std::uint32_t effectType,
                                      std::uint32_t flags,
                                      std::int32_t trackId,
                                      std::int32_t slotOrNodeId,
                                      std::int32_t compensationSamples)
{
    AudioTelemetryTimingSample sample;
    sample.kind = kind;
    sample.durationUs = durationUs;
    sample.deadlineUs = metadata.deadlineUs;
    sample.blockSize = metadata.blockSize;
    sample.sampleRateMilliHz = sampleRateMilliHz(metadata.sampleRate);
    sample.effectType = effectType;
    sample.flags = flags;
    sample.trackId = trackId;
    sample.slotOrNodeId = slotOrNodeId;
    sample.compensationSamples = compensationSamples;
    return sample;
}

std::string kindName(AudioTelemetrySampleKind kind)
{
    switch (kind)
    {
        case AudioTelemetrySampleKind::AudioCallback: return "audio_callback";
        case AudioTelemetrySampleKind::MixBlock: return "mix_block";
        case AudioTelemetrySampleKind::TrackRender: return "track_render";
        case AudioTelemetrySampleKind::TrackChain: return "track_chain";
        case AudioTelemetrySampleKind::MasterChain: return "master_chain";
        case AudioTelemetrySampleKind::Effect: return "effect";
        case AudioTelemetrySampleKind::EffectSection: return "effect_section";
        case AudioTelemetrySampleKind::PdcDelay: return "pdc_delay";
        case AudioTelemetrySampleKind::OutputPost: return "output_post";
        default: return "unknown";
    }
}

std::vector<std::string> flagNames(std::uint32_t flags)
{
    std::vector<std::string> names;
    if ((flags & kAudioTelemetryFlagMaster) != 0) names.push_back("Master");
    if ((flags & kAudioTelemetryFlagHighQuality) != 0) names.push_back("HighQuality");
    if ((flags & kAudioTelemetryFlagWola) != 0) names.push_back("Wola");
    if ((flags & kAudioTelemetryFlagSpectral) != 0) names.push_back("Spectral");
    if ((flags & kAudioTelemetryFlagLookahead) != 0) names.push_back("Lookahead");
    if ((flags & kAudioTelemetryFlagThirdParty) != 0) names.push_back("ThirdParty");
    if ((flags & kAudioTelemetryFlagBypassed) != 0) names.push_back("Bypassed");
    return names;
}

json metricToJson(const AudioTelemetryMetricSummary& metric)
{
    return {
        {"count", metric.count},
        {"averageUs", metric.averageUs},
        {"p50Us", metric.p50Us},
        {"p95Us", metric.p95Us},
        {"p99Us", metric.p99Us},
        {"maxUs", metric.maxUs},
        {"averageMs", metric.averageUs / 1000.0},
        {"p50Ms", static_cast<double>(metric.p50Us) / 1000.0},
        {"p95Ms", static_cast<double>(metric.p95Us) / 1000.0},
        {"p99Ms", static_cast<double>(metric.p99Us) / 1000.0},
        {"maxMs", static_cast<double>(metric.maxUs) / 1000.0}
    };
}

json scopeToJson(const AudioTelemetryWorstScope& scope)
{
    return {
        {"kind", kindName(scope.kind)},
        {"effectType", scope.effectType},
        {"effectTypeName", AudioPerformanceTelemetry::effectTypeName(scope.effectType)},
        {"flags", scope.flags},
        {"flagNames", flagNames(scope.flags)},
        {"trackId", scope.trackId},
        {"slotOrNodeId", scope.slotOrNodeId},
        {"count", scope.timing.count},
        {"p99Us", scope.timing.p99Us},
        {"maxUs", scope.timing.maxUs},
        {"timing", metricToJson(scope.timing)}
    };
}

json scopesToJson(const std::vector<AudioTelemetryWorstScope>& scopes)
{
    json arr = json::array();
    for (const auto& scope : scopes)
        arr.push_back(scopeToJson(scope));
    return arr;
}

bool isFiniteMetric(const AudioTelemetryMetricSummary& metric) noexcept
{
    return std::isfinite(metric.averageUs);
}

void writeTextFile(const std::filesystem::path& path, const std::string& text)
{
    std::ofstream out(path, std::ios::binary);
    if (!out)
        throw std::runtime_error("failed to open report output: " + path.string());
    out << text;
}

std::string oneLineScope(const AudioTelemetryWorstScope& scope)
{
    std::ostringstream out;
    out << kindName(scope.kind)
        << " " << AudioPerformanceTelemetry::effectTypeName(scope.effectType)
        << " track=" << scope.trackId
        << " slot=" << scope.slotOrNodeId
        << " flags=" << scope.flags
        << " p99=" << scope.timing.p99Us << "us"
        << " max=" << scope.timing.maxUs << "us";
    return out.str();
}

void appendScopeList(std::ostringstream& out,
                     const char* title,
                     const std::vector<AudioTelemetryWorstScope>& scopes)
{
    out << "- " << title << ":\n";
    if (scopes.empty())
    {
        out << "  - none\n";
        return;
    }

    for (const auto& scope : scopes)
        out << "  - " << oneLineScope(scope) << "\n";
}

bool isResonanceSuppressorHqScope(const AudioTelemetryWorstScope& scope) noexcept
{
    return scope.effectType == kAudioTelemetryEffectResonanceSuppressor
        && (scope.flags & kAudioTelemetryFlagHighQuality) != 0;
}

bool containsResonanceSuppressorHq(const std::vector<AudioTelemetryWorstScope>& scopes)
{
    return std::any_of(scopes.begin(), scopes.end(), isResonanceSuppressorHqScope);
}

double deadlineRatio(std::uint32_t valueUs, std::uint32_t deadlineUs) noexcept
{
    if (deadlineUs == 0)
        return 0.0;
    return static_cast<double>(valueUs) / static_cast<double>(deadlineUs);
}

const char* diagnosticEvidence(const AudioPerfScenarioReport& report) noexcept
{
    const auto& counters = report.telemetry.counters;
    if (counters.callbackOverrunCount > 0 || counters.mixOverrunCount > 0
        || (report.metadata.deadlineUs > 0
            && (report.telemetry.callback.p99Us >= report.metadata.deadlineUs
                || report.telemetry.callback.maxUs >= report.metadata.deadlineUs
                || report.telemetry.mixBlock.p99Us >= report.metadata.deadlineUs
                || report.telemetry.mixBlock.maxUs >= report.metadata.deadlineUs)))
    {
        return "cpu_deadline_overrun";
    }

    if (counters.chainLockMissCount > 0 || counters.staleSnapshotReuseCount > 0)
        return "lock_or_stale_chain_issue";

    if (counters.droppedTimingSamples > 0)
        return "telemetry_dropped_samples";

    if (report.metadata.deadlineUs > 0
        && (static_cast<std::uint64_t>(report.telemetry.callback.p99Us) * 100u
                >= static_cast<std::uint64_t>(report.metadata.deadlineUs) * 60u
            || static_cast<std::uint64_t>(report.telemetry.mixBlock.p99Us) * 100u
                >= static_cast<std::uint64_t>(report.metadata.deadlineUs) * 60u))
    {
        return "cpu_deadline_margin_risk";
    }

    if (report.latency.maxTrackLatencySamples > 0 || report.latency.masterLatencySamples > 0
        || report.latency.livePresentationLatencySamples > 0)
    {
        return "compensated_latency_pdc_only";
    }

    if (report.telemetry.callback.count == 0 || report.telemetry.mixBlock.count == 0)
        return "insufficient_evidence";

    return "no_realtime_instability_observed";
}

AudioPerformanceTelemetrySnapshot makeSnapshot(const AudioPerformanceScenarioRunner::ScenarioDefinition& definition)
{
    AudioPerformanceTelemetry telemetry;
    telemetry.setEnabled(true);

    for (std::uint32_t i = 0; i < definition.droppedTelemetrySamples; ++i)
    {
        for (std::uint32_t j = 0; j < AudioPerformanceTelemetry::kTimingRingCapacity; ++j)
        {
            telemetry.recordTimingFromAudioThread(
                makeSample(definition.metadata,
                           AudioTelemetrySampleKind::MixBlock,
                           definition.mixBaseUs,
                           kAudioTelemetryEffectUnknown,
                           kAudioTelemetryFlagNone,
                           -1,
                           -1,
                           static_cast<std::int32_t>(definition.latency.maxTrackLatencySamples)));
        }
        telemetry.getSnapshot();
        telemetry.reset();
        telemetry.setEnabled(true);
    }

    for (std::uint32_t i = 0; i < definition.lockMisses; ++i)
        telemetry.incrementChainLockMiss();
    for (std::uint32_t i = 0; i < definition.staleSnapshotReuses; ++i)
        telemetry.incrementStaleSnapshotReuse();
    for (std::uint32_t i = 0; i < definition.guardedPluginCrashedSkips; ++i)
        telemetry.incrementGuardedPluginCrashedSkipped();
    for (std::uint32_t i = 0; i < definition.latency.latencyEpochChanges; ++i)
        telemetry.incrementLatencyEpochChange();
    for (std::uint32_t i = 0; i < definition.latency.compensationTargetChanges; ++i)
        telemetry.incrementCompensationTargetChange();

    for (std::uint32_t block = 0; block < definition.metadata.blockCount; ++block)
    {
        const auto callbackUs = durationForBlock(block,
                                                 definition.callbackBaseUs,
                                                 definition.callbackPeakUs,
                                                 29);
        const auto mixUs = durationForBlock(block,
                                            definition.mixBaseUs,
                                            definition.mixPeakUs,
                                            31);

        telemetry.recordTimingFromAudioThread(
            makeSample(definition.metadata,
                       AudioTelemetrySampleKind::AudioCallback,
                       callbackUs,
                       kAudioTelemetryEffectUnknown,
                       kAudioTelemetryFlagNone,
                       -1,
                       -1,
                       static_cast<std::int32_t>(definition.latency.maxTrackLatencySamples)));
        telemetry.recordTimingFromAudioThread(
            makeSample(definition.metadata,
                       AudioTelemetrySampleKind::MixBlock,
                       mixUs,
                       kAudioTelemetryEffectUnknown,
                       kAudioTelemetryFlagNone,
                       -1,
                       -1,
                       static_cast<std::int32_t>(definition.latency.maxTrackLatencySamples)));

        for (const auto& scope : definition.scopes)
        {
            const auto durationUs = durationForBlock(block,
                                                    scope.baseDurationUs,
                                                    scope.peakDurationUs,
                                                    scope.cadence);
            telemetry.recordTimingFromAudioThread(
                makeSample(definition.metadata,
                           scope.kind,
                           durationUs,
                           scope.effectType,
                           scope.flags,
                           scope.trackId,
                           scope.slotOrNodeId,
                           static_cast<std::int32_t>(definition.latency.maxTrackLatencySamples)));
        }
    }

    return telemetry.getSnapshot();
}

} // namespace

std::vector<AudioPerformanceScenarioRunner::ScenarioDefinition>
AudioPerformanceScenarioRunner::defaultScenarios()
{
    constexpr double sampleRate = 48000.0;
    constexpr std::uint32_t blockSize = 512;
    constexpr std::uint32_t blocks = 96;
    const std::uint32_t deadlineUs = deadlineUsFor(blockSize, sampleRate);

    auto base = [&](std::string id, std::string name, std::string description) {
        ScenarioDefinition scenario;
        scenario.metadata.id = std::move(id);
        scenario.metadata.name = std::move(name);
        scenario.metadata.description = std::move(description);
        scenario.metadata.sampleRate = sampleRate;
        scenario.metadata.blockSize = blockSize;
        scenario.metadata.blockCount = blocks;
        scenario.metadata.totalRenderedSamples =
            static_cast<std::uint64_t>(blockSize) * blocks;
        scenario.metadata.deadlineUs = deadlineUs;
        scenario.callbackBaseUs = 90;
        scenario.callbackPeakUs = 120;
        scenario.mixBaseUs = 70;
        scenario.mixPeakUs = 95;
        return scenario;
    };

    std::vector<ScenarioDefinition> scenarios;

    scenarios.push_back(base("baseline_empty_mix",
                             "Baseline empty mix",
                             "Transport callback with no audible tracks or insert chains."));

    auto dry = base("dry_track_mix",
                    "Dry track mix",
                    "One dry audio track with no insert latency.");
    dry.callbackBaseUs = 180;
    dry.mixBaseUs = 150;
    dry.scopes.push_back({AudioTelemetrySampleKind::TrackRender,
                          kAudioTelemetryEffectUnknown,
                          kAudioTelemetryFlagNone,
                          1,
                          -1,
                          80,
                          115,
                          17});
    scenarios.push_back(std::move(dry));

    auto rsNormal = base("resonance_suppressor_normal_quality",
                         "Resonance Suppressor normal quality",
                         "One track with the low-latency Resonance Suppressor path.");
    rsNormal.callbackBaseUs = 430;
    rsNormal.mixBaseUs = 380;
    rsNormal.latency.maxTrackLatencySamples = 64;
    rsNormal.latency.compensationTargetChanges = 1;
    rsNormal.scopes.push_back({AudioTelemetrySampleKind::TrackChain,
                               kAudioTelemetryEffectUnknown,
                               kAudioTelemetryFlagNone,
                               1,
                               -1,
                               260,
                               360,
                               23});
    rsNormal.scopes.push_back({AudioTelemetrySampleKind::Effect,
                               kAudioTelemetryEffectResonanceSuppressor,
                               kAudioTelemetryFlagNone,
                               1,
                               0,
                               220,
                               330,
                               23});
    scenarios.push_back(std::move(rsNormal));

    auto rsHq = base("resonance_suppressor_high_quality",
                     "Resonance Suppressor High Quality",
                     "One track with Resonance Suppressor HQ WOLA timing visible.");
    rsHq.callbackBaseUs = 2200;
    rsHq.callbackPeakUs = 5200;
    rsHq.mixBaseUs = 2000;
    rsHq.mixPeakUs = 4700;
    rsHq.latency.maxTrackLatencySamples = 2048;
    rsHq.latency.compensationTargetChanges = 1;
    rsHq.scopes.push_back({AudioTelemetrySampleKind::TrackChain,
                           kAudioTelemetryEffectUnknown,
                           kAudioTelemetryFlagNone,
                           1,
                           -1,
                           1800,
                           4300,
                           19});
    rsHq.scopes.push_back({AudioTelemetrySampleKind::Effect,
                           kAudioTelemetryEffectResonanceSuppressor,
                           kAudioTelemetryFlagHighQuality,
                           1,
                           0,
                           1700,
                           4200,
                           19});
    rsHq.scopes.push_back({AudioTelemetrySampleKind::EffectSection,
                           kAudioTelemetryEffectResonanceSuppressor,
                           kAudioTelemetryFlagHighQuality | kAudioTelemetryFlagWola,
                           1,
                           0,
                           1350,
                           3900,
                           19});
    scenarios.push_back(std::move(rsHq));

    auto rsHqMulti = base("multi_track_resonance_suppressor_high_quality",
                          "Multiple Resonance Suppressor HQ tracks",
                          "Four tracks with HQ WOLA scopes and shared callback pressure.");
    rsHqMulti.callbackBaseUs = 5200;
    rsHqMulti.callbackPeakUs = 8200;
    rsHqMulti.mixBaseUs = 4900;
    rsHqMulti.mixPeakUs = 7600;
    rsHqMulti.latency.maxTrackLatencySamples = 2048;
    rsHqMulti.latency.compensationTargetChanges = 4;
    for (int track = 1; track <= 4; ++track)
    {
        rsHqMulti.scopes.push_back({AudioTelemetrySampleKind::TrackChain,
                                    kAudioTelemetryEffectUnknown,
                                    kAudioTelemetryFlagNone,
                                    track,
                                    -1,
                                    static_cast<std::uint32_t>(1150 + track * 90),
                                    static_cast<std::uint32_t>(1850 + track * 130),
                                    17});
        rsHqMulti.scopes.push_back({AudioTelemetrySampleKind::EffectSection,
                                    kAudioTelemetryEffectResonanceSuppressor,
                                    kAudioTelemetryFlagHighQuality | kAudioTelemetryFlagWola,
                                    track,
                                    0,
                                    static_cast<std::uint32_t>(950 + track * 75),
                                    static_cast<std::uint32_t>(1750 + track * 110),
                                    17});
    }
    scenarios.push_back(std::move(rsHqMulti));

    auto stockChain = base("stock_latent_effect_chain",
                           "Stock latent effect chain",
                           "Track chain with EQ spectral timing plus compressor/limiter lookahead.");
    stockChain.callbackBaseUs = 2700;
    stockChain.callbackPeakUs = 4800;
    stockChain.mixBaseUs = 2400;
    stockChain.mixPeakUs = 4300;
    stockChain.latency.maxTrackLatencySamples = 1536;
    stockChain.latency.compensationTargetChanges = 3;
    stockChain.scopes.push_back({AudioTelemetrySampleKind::TrackChain,
                                 kAudioTelemetryEffectUnknown,
                                 kAudioTelemetryFlagNone,
                                 2,
                                 -1,
                                 2100,
                                 3900,
                                 23});
    stockChain.scopes.push_back({AudioTelemetrySampleKind::Effect,
                                 kAudioTelemetryEffectEQ,
                                 kAudioTelemetryFlagSpectral,
                                 2,
                                 0,
                                 850,
                                 1500,
                                 23});
    stockChain.scopes.push_back({AudioTelemetrySampleKind::Effect,
                                 kAudioTelemetryEffectCompressor,
                                 kAudioTelemetryFlagLookahead,
                                 2,
                                 1,
                                 620,
                                 1000,
                                 23});
    stockChain.scopes.push_back({AudioTelemetrySampleKind::Effect,
                                 kAudioTelemetryEffectLimiter,
                                 kAudioTelemetryFlagLookahead,
                                 2,
                                 2,
                                 500,
                                 850,
                                 23});
    scenarios.push_back(std::move(stockChain));

    auto thirdParty = base("third_party_wrapped_chain",
                           "Third-party wrapped plugin chain",
                           "Simulated GuardedPluginWrapper chain with stable third-party IDs.");
    thirdParty.callbackBaseUs = 3100;
    thirdParty.callbackPeakUs = 5700;
    thirdParty.mixBaseUs = 2850;
    thirdParty.mixPeakUs = 5250;
    thirdParty.latency.maxTrackLatencySamples = 1024;
    thirdParty.latency.latencyEpochChanges = 1;
    thirdParty.latency.compensationTargetChanges = 2;
    thirdParty.lockMisses = 1;
    thirdParty.staleSnapshotReuses = 1;
    thirdParty.scopes.push_back({AudioTelemetrySampleKind::TrackChain,
                                 kAudioTelemetryEffectUnknown,
                                 kAudioTelemetryFlagThirdParty,
                                 3,
                                 -1,
                                 2500,
                                 5000,
                                 29});
    thirdParty.scopes.push_back({AudioTelemetrySampleKind::Effect,
                                 kAudioTelemetryEffectThirdParty,
                                 kAudioTelemetryFlagThirdParty,
                                 3,
                                 7,
                                 1200,
                                 2600,
                                 29});
    thirdParty.scopes.push_back({AudioTelemetrySampleKind::Effect,
                                 kAudioTelemetryEffectThirdParty,
                                 kAudioTelemetryFlagThirdParty,
                                 3,
                                 8,
                                 980,
                                 2100,
                                 29});
    scenarios.push_back(std::move(thirdParty));

    auto master = base("master_chain_latent_heavy_effect",
                       "Master-chain latent heavy effect",
                       "Master chain with lookahead latency and callback pressure.");
    master.callbackBaseUs = 3600;
    master.callbackPeakUs = 6700;
    master.mixBaseUs = 3300;
    master.mixPeakUs = 6300;
    master.latency.masterLatencySamples = 2048;
    master.latency.livePresentationLatencySamples = 4096;
    master.latency.compensationTargetChanges = 1;
    master.scopes.push_back({AudioTelemetrySampleKind::MasterChain,
                             kAudioTelemetryEffectUnknown,
                             kAudioTelemetryFlagMaster,
                             -1,
                             -1,
                             2100,
                             3900,
                             31});
    master.scopes.push_back({AudioTelemetrySampleKind::Effect,
                             kAudioTelemetryEffectLimiter,
                             kAudioTelemetryFlagMaster | kAudioTelemetryFlagLookahead,
                             -1,
                             20,
                             1800,
                             3500,
                             31});
    scenarios.push_back(std::move(master));

    return scenarios;
}

AudioPerfScenarioReport
AudioPerformanceScenarioRunner::runScenario(const ScenarioDefinition& definition)
{
    AudioPerfScenarioReport report;
    report.metadata = definition.metadata;
    if (report.metadata.totalRenderedSamples == 0)
    {
        report.metadata.totalRenderedSamples =
            static_cast<std::uint64_t>(report.metadata.blockSize)
            * report.metadata.blockCount;
    }
    if (report.metadata.deadlineUs == 0)
        report.metadata.deadlineUs =
            deadlineUsFor(report.metadata.blockSize, report.metadata.sampleRate);

    ScenarioDefinition normalized = definition;
    normalized.metadata = report.metadata;
    report.telemetry = makeSnapshot(normalized);
    report.latency = definition.latency;
    report.classification = classify(report.metadata.deadlineUs,
                                     report.telemetry.callback,
                                     report.telemetry.mixBlock,
                                     report.telemetry.counters);
    return report;
}

std::vector<AudioPerfScenarioReport>
AudioPerformanceScenarioRunner::runDefaultScenarios()
{
    std::vector<AudioPerfScenarioReport> reports;
    for (const auto& scenario : defaultScenarios())
        reports.push_back(runScenario(scenario));
    return reports;
}

AudioPerfBudgetClassification
AudioPerformanceScenarioRunner::classify(std::uint32_t deadlineUs,
                                         const AudioTelemetryMetricSummary& callback,
                                         const AudioTelemetryMetricSummary& mixEngine,
                                         const AudioTelemetryCounterSnapshot& counters)
{
    const std::uint32_t p99Us = std::max(callback.p99Us, mixEngine.p99Us);
    const std::uint32_t maxUs = std::max(callback.maxUs, mixEngine.maxUs);
    if ((deadlineUs > 0 && (p99Us >= deadlineUs || maxUs >= deadlineUs))
        || counters.callbackOverrunCount > 0
        || counters.mixOverrunCount > 0)
    {
        return AudioPerfBudgetClassification::Overrunning;
    }

    if ((deadlineUs > 0
         && static_cast<std::uint64_t>(p99Us) * 100u
                >= static_cast<std::uint64_t>(deadlineUs) * 60u)
        || counters.droppedTimingSamples > 0)
    {
        return AudioPerfBudgetClassification::Warning;
    }

    return AudioPerfBudgetClassification::Healthy;
}

const char*
AudioPerformanceScenarioRunner::classificationName(AudioPerfBudgetClassification classification) noexcept
{
    switch (classification)
    {
        case AudioPerfBudgetClassification::Healthy: return "healthy";
        case AudioPerfBudgetClassification::Warning: return "warning";
        case AudioPerfBudgetClassification::Overrunning: return "overrunning";
        default: return "unknown";
    }
}

bool AudioPerformanceScenarioRunner::hasStrictBudgetFailure(
    const std::vector<AudioPerfScenarioReport>& reports)
{
    return std::any_of(reports.begin(), reports.end(), [](const auto& report) {
        return report.classification != AudioPerfBudgetClassification::Healthy;
    });
}

bool AudioPerformanceScenarioRunner::strictModeEnabled() noexcept
{
    const char* value = std::getenv("XLETH_STRICT_AUDIO_PERF");
    return value != nullptr && value[0] == '1' && value[1] == '\0';
}

std::string AudioPerformanceScenarioRunner::toJson(const AudioPerfScenarioReport& report)
{
    const auto& counters = report.telemetry.counters;
    json j;
    j["scenario"] = {
        {"id", report.metadata.id},
        {"name", report.metadata.name},
        {"description", report.metadata.description},
        {"sampleRate", report.metadata.sampleRate},
        {"blockSize", report.metadata.blockSize},
        {"blockCount", report.metadata.blockCount},
        {"totalRenderedSamples", report.metadata.totalRenderedSamples},
        {"callbackDeadlineUs", report.metadata.deadlineUs}
    };
    j["classification"] = classificationName(report.classification);
    j["latencyPdcAccounting"] = {
        {"latencyEpochChanges", counters.latencyEpochChangeCount},
        {"compensationTargetChanges", counters.compensationTargetChangeCount},
        {"maxTrackLatencySamples", report.latency.maxTrackLatencySamples},
        {"masterLatencySamples", report.latency.masterLatencySamples},
        {"livePresentationLatencySamples", report.latency.livePresentationLatencySamples},
        {"pdcDelayProcessCount", counters.pdcDelayProcessCount}
    };
    j["realtimeCpuDeadlineHealth"] = {
        {"callbackDeadlineUs", report.metadata.deadlineUs},
        {"callback", metricToJson(report.telemetry.callback)},
        {"mixEngine", metricToJson(report.telemetry.mixBlock)},
        {"overrunCount", counters.callbackOverrunCount + counters.mixOverrunCount},
        {"callbackOverrunCount", counters.callbackOverrunCount},
        {"mixEngineOverrunCount", counters.mixOverrunCount},
        {"droppedTelemetrySamples", counters.droppedTimingSamples}
    };
    j["worstChains"] = {
        {"byP99", scopesToJson(report.telemetry.worstChainsByP99)},
        {"byMax", scopesToJson(report.telemetry.worstChainsByMax)}
    };
    j["worstEffects"] = {
        {"byP99", scopesToJson(report.telemetry.worstEffectsByP99)},
        {"byMax", scopesToJson(report.telemetry.worstEffectsByMax)}
    };
    j["lockAndStaleStateHealth"] = {
        {"lockMissCount", counters.chainLockMissCount},
        {"masterChainSkippedCount", counters.masterChainSkippedCount},
        {"trackChainSkippedCount", counters.trackChainSkippedCount},
        {"staleSnapshotReuseCount", counters.staleSnapshotReuseCount},
        {"guardedPluginCrashedSkippedCount", counters.guardedPluginCrashedSkippedCount}
    };
    j["resonanceSuppressorHighQuality"] = {
        {"wolaCallCount", counters.resonanceSuppressorWolaCallCount},
        {"wolaTiming", metricToJson(report.telemetry.effectSection)},
        {"audioThreadReprepareCount", counters.resonanceSuppressorAudioThreadReprepareCount},
        {"deferredReprepareCount", counters.resonanceSuppressorDeferredReprepareCount},
        {"appearsInWorstEffectsByP99",
         containsResonanceSuppressorHq(report.telemetry.worstEffectsByP99)},
        {"appearsInWorstEffectsByMax",
         containsResonanceSuppressorHq(report.telemetry.worstEffectsByMax)}
    };
    j["diagnosis"] = {
        {"evidence", diagnosticEvidence(report)},
        {"callbackP99DeadlineRatio",
         deadlineRatio(report.telemetry.callback.p99Us, report.metadata.deadlineUs)},
        {"callbackMaxDeadlineRatio",
         deadlineRatio(report.telemetry.callback.maxUs, report.metadata.deadlineUs)},
        {"mixEngineP99DeadlineRatio",
         deadlineRatio(report.telemetry.mixBlock.p99Us, report.metadata.deadlineUs)},
        {"mixEngineMaxDeadlineRatio",
         deadlineRatio(report.telemetry.mixBlock.maxUs, report.metadata.deadlineUs)}
    };
    j["structuralChecks"] = {
        {"callbackMetricFinite", isFiniteMetric(report.telemetry.callback)},
        {"mixEngineMetricFinite", isFiniteMetric(report.telemetry.mixBlock)}
    };
    return j.dump(2);
}

std::string AudioPerformanceScenarioRunner::toJson(const std::vector<AudioPerfScenarioReport>& reports)
{
    json root;
    root["reportType"] = "xleth_audio_performance_scenarios";
    root["version"] = 1;
    root["scenarioCount"] = reports.size();
    root["scenarios"] = json::array();
    for (const auto& report : reports)
        root["scenarios"].push_back(json::parse(toJson(report)));
    return root.dump(2);
}

std::string AudioPerformanceScenarioRunner::toMarkdown(const AudioPerfScenarioReport& report)
{
    const auto& counters = report.telemetry.counters;
    std::ostringstream out;
    out << "# Audio Performance Scenario: " << report.metadata.name << "\n\n";
    out << "## Scenario Metadata\n";
    out << "- id: " << report.metadata.id << "\n";
    out << "- sampleRate: " << report.metadata.sampleRate << "\n";
    out << "- blockSize: " << report.metadata.blockSize << "\n";
    out << "- blockCount: " << report.metadata.blockCount << "\n";
    out << "- totalRenderedSamples: " << report.metadata.totalRenderedSamples << "\n";
    out << "- callbackDeadlineUs: " << report.metadata.deadlineUs << "\n";
    out << "- classification: " << classificationName(report.classification) << "\n\n";

    out << "## Latency/PDC Accounting\n";
    out << "- latencyEpochChanges: " << counters.latencyEpochChangeCount << "\n";
    out << "- compensationTargetChanges: " << counters.compensationTargetChangeCount << "\n";
    out << "- maxTrackLatencySamples: " << report.latency.maxTrackLatencySamples << "\n";
    out << "- masterLatencySamples: " << report.latency.masterLatencySamples << "\n";
    out << "- livePresentationLatencySamples: "
        << report.latency.livePresentationLatencySamples << "\n\n";

    out << "## Realtime CPU Deadline Health\n";
    out << "- callback p50/p95/p99/max us: "
        << report.telemetry.callback.p50Us << "/"
        << report.telemetry.callback.p95Us << "/"
        << report.telemetry.callback.p99Us << "/"
        << report.telemetry.callback.maxUs << "\n";
    out << "- MixEngine p50/p95/p99/max us: "
        << report.telemetry.mixBlock.p50Us << "/"
        << report.telemetry.mixBlock.p95Us << "/"
        << report.telemetry.mixBlock.p99Us << "/"
        << report.telemetry.mixBlock.maxUs << "\n";
    out << "- overrunCount: "
        << (counters.callbackOverrunCount + counters.mixOverrunCount) << "\n";
    out << "- droppedTelemetrySamples: " << counters.droppedTimingSamples << "\n\n";

    out << "## Worst Chains/Effects\n";
    appendScopeList(out, "worstChainsByP99", report.telemetry.worstChainsByP99);
    appendScopeList(out, "worstChainsByMax", report.telemetry.worstChainsByMax);
    appendScopeList(out, "worstEffectsByP99", report.telemetry.worstEffectsByP99);
    appendScopeList(out, "worstEffectsByMax", report.telemetry.worstEffectsByMax);
    out << "\n";

    out << "## Lock/Stale-State Health\n";
    out << "- lockMissCount: " << counters.chainLockMissCount << "\n";
    out << "- staleSnapshotReuseCount: " << counters.staleSnapshotReuseCount << "\n";
    out << "- guardedPluginCrashedSkippedCount: "
        << counters.guardedPluginCrashedSkippedCount << "\n\n";

    out << "## Resonance Suppressor HQ WOLA\n";
    out << "- wolaCallCount: " << counters.resonanceSuppressorWolaCallCount << "\n";
    out << "- WOLA p99/max us: "
        << report.telemetry.effectSection.p99Us << "/"
        << report.telemetry.effectSection.maxUs << "\n";
    out << "- appearsInWorstEffectsByP99: "
        << (containsResonanceSuppressorHq(report.telemetry.worstEffectsByP99)
                ? "yes" : "no")
        << "\n";
    out << "- appearsInWorstEffectsByMax: "
        << (containsResonanceSuppressorHq(report.telemetry.worstEffectsByMax)
                ? "yes" : "no")
        << "\n";
    out << "- callback p99/max vs deadline: "
        << std::fixed << std::setprecision(2)
        << (deadlineRatio(report.telemetry.callback.p99Us, report.metadata.deadlineUs) * 100.0)
        << "%/"
        << (deadlineRatio(report.telemetry.callback.maxUs, report.metadata.deadlineUs) * 100.0)
        << "%\n";
    out << "- overruns: "
        << (counters.callbackOverrunCount + counters.mixOverrunCount) << "\n\n";

    out << "## Diagnosis\n";
    out << "- evidence: " << diagnosticEvidence(report) << "\n";
    out << "- compensatedLatencyPdc: maxTrackLatencySamples="
        << report.latency.maxTrackLatencySamples
        << " masterLatencySamples=" << report.latency.masterLatencySamples
        << " livePresentationLatencySamples="
        << report.latency.livePresentationLatencySamples << "\n";
    out << "- lockOrStaleState: lockMissCount=" << counters.chainLockMissCount
        << " staleSnapshotReuseCount=" << counters.staleSnapshotReuseCount << "\n";
    out << "- telemetryIntegrity: droppedTelemetrySamples="
        << counters.droppedTimingSamples << "\n";
    return out.str();
}

std::string AudioPerformanceScenarioRunner::toMarkdown(
    const std::vector<AudioPerfScenarioReport>& reports)
{
    std::ostringstream out;
    out << "# Xleth Audio Performance Scenario Report\n\n";
    out << "This report separates PDC latency accounting from realtime CPU "
           "deadline health. Timing classifications are soft diagnostics.\n\n";
    for (const auto& report : reports)
        out << toMarkdown(report) << "\n";
    return out.str();
}

void AudioPerformanceScenarioRunner::writeReports(
    const std::vector<AudioPerfScenarioReport>& reports,
    const std::filesystem::path& directory)
{
    std::filesystem::create_directories(directory);
    writeTextFile(directory / "audio-performance-scenarios.json", toJson(reports));
    writeTextFile(directory / "audio-performance-scenarios.md", toMarkdown(reports));
}

} // namespace xleth::audio
