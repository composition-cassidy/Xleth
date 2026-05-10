#include "audio/AudioPerformanceScenarioRunner.h"

#include <nlohmann/json.hpp>

#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

using xleth::audio::AudioPerfBudgetClassification;
using xleth::audio::AudioPerformanceScenarioRunner;
using xleth::audio::AudioPerfScenarioReport;
using xleth::audio::AudioTelemetryMetricSummary;
using xleth::audio::AudioTelemetryCounterSnapshot;
using xleth::audio::kAudioTelemetryEffectResonanceSuppressor;
using xleth::audio::kAudioTelemetryFlagHighQuality;
using xleth::audio::kAudioTelemetryFlagWola;

static int g_passed = 0;
static int g_failed = 0;

#define CHECK(cond, msg)                                                \
    do {                                                                \
        if (cond) {                                                     \
            ++g_passed;                                                 \
        } else {                                                        \
            std::cerr << "  FAIL [" << __LINE__ << "] " << msg << "\n"; \
            ++g_failed;                                                 \
        }                                                               \
    } while (0)

static bool contains(const std::string& text, const std::string& needle)
{
    return text.find(needle) != std::string::npos;
}

static std::filesystem::path reportDirectory()
{
    if (const char* value = std::getenv("XLETH_AUDIO_PERF_REPORT_DIR"))
    {
        if (value[0] != '\0')
            return std::filesystem::path(value);
    }

    return std::filesystem::current_path()
        / "build"
        / "engine"
        / "audio_perf_scenarios";
}

static void testDefaultScenarioInventory()
{
    std::cout << "[audio-perf-scenarios] default scenario inventory\n";
    const auto scenarios = AudioPerformanceScenarioRunner::defaultScenarios();

    bool foundBaseline = false;
    bool foundResonanceHq = false;
    bool foundThirdParty = false;

    for (const auto& scenario : scenarios)
    {
        foundBaseline = foundBaseline || scenario.metadata.id == "baseline_empty_mix";
        foundResonanceHq =
            foundResonanceHq || scenario.metadata.id == "resonance_suppressor_high_quality";
        foundThirdParty =
            foundThirdParty || scenario.metadata.id == "third_party_wrapped_chain";
    }

    CHECK(scenarios.size() >= 8, "runner should expose the expected scenario set");
    CHECK(foundBaseline, "baseline scenario should exist");
    CHECK(foundResonanceHq, "Resonance Suppressor HQ scenario should exist");
    CHECK(foundThirdParty, "third-party wrapped-chain scenario should exist");
}

static void testReportsForBaselineAndExpensiveScenario()
{
    std::cout << "[audio-perf-scenarios] baseline and expensive reports\n";
    const auto reports = AudioPerformanceScenarioRunner::runDefaultScenarios();

    const AudioPerfScenarioReport* baseline = nullptr;
    const AudioPerfScenarioReport* resonanceHq = nullptr;

    for (const auto& report : reports)
    {
        if (report.metadata.id == "baseline_empty_mix")
            baseline = &report;
        if (report.metadata.id == "resonance_suppressor_high_quality")
            resonanceHq = &report;
    }

    CHECK(baseline != nullptr, "baseline report should be generated");
    CHECK(resonanceHq != nullptr, "expensive HQ report should be generated");
    if (baseline != nullptr)
    {
        CHECK(baseline->telemetry.callback.count == baseline->metadata.blockCount,
              "baseline callback count should match block count");
        CHECK(baseline->telemetry.mixBlock.count == baseline->metadata.blockCount,
              "baseline MixEngine count should match block count");
        CHECK(baseline->classification == AudioPerfBudgetClassification::Healthy,
              "deterministic baseline should classify healthy");
    }
    if (resonanceHq != nullptr)
    {
        CHECK(resonanceHq->telemetry.counters.resonanceSuppressorWolaCallCount
                  == resonanceHq->metadata.blockCount,
              "HQ scenario should record WOLA section timing per block");
        CHECK(!resonanceHq->telemetry.worstEffectsByP99.empty(),
              "HQ report should include worst effects");

        bool hasHqWola = false;
        for (const auto& scope : resonanceHq->telemetry.worstEffectsByP99)
        {
            hasHqWola = hasHqWola
                || (scope.effectType == kAudioTelemetryEffectResonanceSuppressor
                    && (scope.flags & kAudioTelemetryFlagHighQuality) != 0
                    && (scope.flags & kAudioTelemetryFlagWola) != 0);
        }
        CHECK(hasHqWola, "HQ WOLA scope should be identifiable in worst effects");
    }
}

static void testJsonReportStructure()
{
    std::cout << "[audio-perf-scenarios] JSON structure\n";
    const auto reports = AudioPerformanceScenarioRunner::runDefaultScenarios();
    const auto parsed =
        nlohmann::json::parse(AudioPerformanceScenarioRunner::toJson(reports));

    CHECK(parsed["reportType"] == "xleth_audio_performance_scenarios",
          "JSON report type should identify scenario reports");
    CHECK(parsed["scenarioCount"].get<std::size_t>() == reports.size(),
          "JSON scenarioCount should match report count");
    CHECK(parsed["scenarios"].is_array(), "JSON scenarios should be an array");

    const auto& first = parsed["scenarios"].at(0);
    CHECK(first["scenario"].contains("sampleRate"), "scenario metadata should include sampleRate");
    CHECK(first["scenario"].contains("blockSize"), "scenario metadata should include blockSize");
    CHECK(first["scenario"].contains("blockCount"), "scenario metadata should include blockCount");
    CHECK(first["scenario"].contains("totalRenderedSamples"),
          "scenario metadata should include totalRenderedSamples");
    CHECK(first["scenario"].contains("callbackDeadlineUs"),
          "scenario metadata should include callbackDeadlineUs");
    CHECK(first.contains("classification"), "classification should exist");
    CHECK(first.contains("latencyPdcAccounting"), "latency/PDC section should exist");
    CHECK(first.contains("realtimeCpuDeadlineHealth"), "CPU deadline section should exist");
    CHECK(first.contains("worstChains"), "worstChains section should exist");
    CHECK(first.contains("worstEffects"), "worstEffects section should exist");
    CHECK(first.contains("lockAndStaleStateHealth"), "lock/stale section should exist");
    CHECK(first.contains("resonanceSuppressorHighQuality"), "HQ WOLA section should exist");

    for (const auto& item : parsed["scenarios"])
    {
        const auto callbackAverage =
            item["realtimeCpuDeadlineHealth"]["callback"]["averageUs"].get<double>();
        const auto mixAverage =
            item["realtimeCpuDeadlineHealth"]["mixEngine"]["averageUs"].get<double>();
        CHECK(std::isfinite(callbackAverage) && callbackAverage >= 0.0,
              "callback average should be finite and non-negative");
        CHECK(std::isfinite(mixAverage) && mixAverage >= 0.0,
              "MixEngine average should be finite and non-negative");
        CHECK(item["worstChains"]["byP99"].is_array(), "worst chain p99 list should be an array");
        CHECK(item["worstEffects"]["byMax"].is_array(), "worst effect max list should be an array");
    }
}

static void testMarkdownReportStructure()
{
    std::cout << "[audio-perf-scenarios] Markdown structure\n";
    const auto reports = AudioPerformanceScenarioRunner::runDefaultScenarios();
    const auto markdown = AudioPerformanceScenarioRunner::toMarkdown(reports);

    CHECK(contains(markdown, "## Scenario Metadata"), "Markdown should include metadata section");
    CHECK(contains(markdown, "## Latency/PDC Accounting"),
          "Markdown should include Latency/PDC section");
    CHECK(contains(markdown, "## Realtime CPU Deadline Health"),
          "Markdown should include CPU deadline section");
    CHECK(contains(markdown, "## Worst Chains/Effects"),
          "Markdown should include worst scope section");
    CHECK(contains(markdown, "## Lock/Stale-State Health"),
          "Markdown should include lock/stale section");
    CHECK(contains(markdown, "## Resonance Suppressor HQ WOLA"),
          "Markdown should include HQ WOLA section");
}

static void testSyntheticClassification()
{
    std::cout << "[audio-perf-scenarios] synthetic classification\n";
    AudioTelemetryMetricSummary callback;
    AudioTelemetryMetricSummary mix;
    AudioTelemetryCounterSnapshot counters;

    callback.p99Us = 5000;
    callback.maxUs = 5500;
    mix.p99Us = 4000;
    mix.maxUs = 4500;
    CHECK(AudioPerformanceScenarioRunner::classify(10000, callback, mix, counters)
              == AudioPerfBudgetClassification::Healthy,
          "p99 below 60 percent with no overruns should be healthy");

    callback.p99Us = 6000;
    CHECK(AudioPerformanceScenarioRunner::classify(10000, callback, mix, counters)
              == AudioPerfBudgetClassification::Warning,
          "p99 at 60 percent should warn without hard-failing");

    callback.p99Us = 5000;
    counters.droppedTimingSamples = 1;
    CHECK(AudioPerformanceScenarioRunner::classify(10000, callback, mix, counters)
              == AudioPerfBudgetClassification::Warning,
          "dropped telemetry should warn");

    counters.droppedTimingSamples = 0;
    mix.maxUs = 10000;
    CHECK(AudioPerformanceScenarioRunner::classify(10000, callback, mix, counters)
              == AudioPerfBudgetClassification::Overrunning,
          "max at deadline should be overrunning");

    mix.maxUs = 5000;
    counters.callbackOverrunCount = 1;
    CHECK(AudioPerformanceScenarioRunner::classify(10000, callback, mix, counters)
              == AudioPerfBudgetClassification::Overrunning,
          "overrun counter should classify as overrunning");
}

static void testSyntheticStrictModeFailure()
{
    std::cout << "[audio-perf-scenarios] synthetic strict-mode helper\n";
    auto healthy = AudioPerformanceScenarioRunner::runScenario(
        AudioPerformanceScenarioRunner::defaultScenarios().front());

    AudioPerformanceScenarioRunner::ScenarioDefinition strictFailure =
        AudioPerformanceScenarioRunner::defaultScenarios().front();
    strictFailure.metadata.id = "synthetic_strict_failure";
    strictFailure.callbackBaseUs = strictFailure.metadata.deadlineUs;
    strictFailure.callbackPeakUs = strictFailure.metadata.deadlineUs;
    auto overrunning = AudioPerformanceScenarioRunner::runScenario(strictFailure);

    CHECK(!AudioPerformanceScenarioRunner::hasStrictBudgetFailure({healthy}),
          "healthy synthetic report should not fail strict mode");
    CHECK(AudioPerformanceScenarioRunner::hasStrictBudgetFailure({overrunning}),
          "overrunning synthetic report should fail strict mode");
}

static void testReportFiles()
{
    std::cout << "[audio-perf-scenarios] report file export\n";
    const auto reports = AudioPerformanceScenarioRunner::runDefaultScenarios();
    const auto outputDir = reportDirectory();
    AudioPerformanceScenarioRunner::writeReports(reports, outputDir);

    CHECK(std::filesystem::exists(outputDir / "audio-performance-scenarios.json"),
          "JSON report file should be written");
    CHECK(std::filesystem::exists(outputDir / "audio-performance-scenarios.md"),
          "Markdown report file should be written");
    std::cout << "  wrote " << (outputDir / "audio-performance-scenarios.json").string() << "\n";
    std::cout << "  wrote " << (outputDir / "audio-performance-scenarios.md").string() << "\n";
}

int main()
{
    std::cout << "=== Audio Performance Scenario Tests ===\n\n";
    testDefaultScenarioInventory();
    testReportsForBaselineAndExpensiveScenario();
    testJsonReportStructure();
    testMarkdownReportStructure();
    testSyntheticClassification();
    testSyntheticStrictModeFailure();
    testReportFiles();

    const auto reports = AudioPerformanceScenarioRunner::runDefaultScenarios();
    if (AudioPerformanceScenarioRunner::strictModeEnabled()
        && AudioPerformanceScenarioRunner::hasStrictBudgetFailure(reports))
    {
        std::cerr << "  FAIL strict mode budget classification requested by "
                     "XLETH_STRICT_AUDIO_PERF=1\n";
        ++g_failed;
    }

    std::cout << "\n";
    if (g_failed == 0)
    {
        std::cout << "ALL TESTS PASSED, " << g_passed << " checks\n";
        return 0;
    }

    std::cout << "FAILED: " << g_failed << " failed, "
              << g_passed << " passed\n";
    return 1;
}
