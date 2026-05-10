#include "SampleBank.h"
#include "Transport.h"
#include "audio/AudioPerformanceScenarioRunner.h"
#include "audio/GuardedPluginWrapper.h"
#include "audio/MixEngine.h"
#include "audio/TestGainEffect.h"
#include "audio/XlethEQEffect.h"
#include "model/Timeline.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using xleth::audio::AudioPerfScenarioReport;
using xleth::audio::AudioPerformanceScenarioRunner;
using xleth::audio::AudioTelemetryMetricSummary;
using xleth::audio::AudioTelemetrySampleKind;

constexpr double kDefaultSampleRate = 48000.0;
constexpr int kDefaultBlockSize = 256;
constexpr double kDefaultSeconds = 5.0;
constexpr double kBpm = 120.0;

struct Options
{
    double sampleRate = kDefaultSampleRate;
    int blockSize = kDefaultBlockSize;
    double seconds = kDefaultSeconds;
    std::string scenario = "all";
    std::filesystem::path outputDir;
    bool strict = false;
    bool audioEnginePath = false;
};

std::vector<std::string> supportedScenarios()
{
    return {
        "baseline_empty_mix",
        "dry_track_mix",
        "resonance_suppressor_normal_quality",
        "resonance_suppressor_high_quality",
        "multi_track_resonance_suppressor_high_quality",
        "stock_latent_effect_chain",
        "third_party_wrapped_chain",
        "master_chain_latent_heavy_effect"
    };
}

std::filesystem::path defaultOutputDir()
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

bool isAllowedBlockSize(int blockSize)
{
    switch (blockSize)
    {
        case 64:
        case 128:
        case 256:
        case 512:
        case 1024:
            return true;
        default:
            return false;
    }
}

std::uint32_t deadlineUsFor(int blockSize, double sampleRate)
{
    if (blockSize <= 0 || sampleRate <= 0.0 || !std::isfinite(sampleRate))
        return 0;

    return static_cast<std::uint32_t>(
        ((static_cast<double>(blockSize) / sampleRate) * 1000000.0) + 0.5);
}

std::uint32_t msToUs(double ms)
{
    if (ms <= 0.0 || !std::isfinite(ms))
        return 0;
    return static_cast<std::uint32_t>((ms * 1000.0) + 0.5);
}

AudioTelemetryMetricSummary metricFromMs(std::uint64_t count,
                                         double averageMs,
                                         double p50Ms,
                                         double p95Ms,
                                         double p99Ms,
                                         double maxMs)
{
    AudioTelemetryMetricSummary metric;
    metric.count = count;
    metric.averageUs = averageMs * 1000.0;
    metric.p50Us = msToUs(p50Ms);
    metric.p95Us = msToUs(p95Ms);
    metric.p99Us = msToUs(p99Ms);
    metric.maxUs = msToUs(maxMs);
    return metric;
}

bool envFlag(const char* name)
{
    const char* value = std::getenv(name);
    return value != nullptr && value[0] == '1' && value[1] == '\0';
}

void applyEnvDefaults(Options& options)
{
    if (const char* value = std::getenv("XLETH_AUDIO_PERF_SAMPLE_RATE"))
        if (value[0] != '\0')
            options.sampleRate = std::stod(value);

    if (const char* value = std::getenv("XLETH_AUDIO_PERF_BLOCK_SIZE"))
        if (value[0] != '\0')
            options.blockSize = std::stoi(value);

    if (const char* value = std::getenv("XLETH_AUDIO_PERF_SECONDS"))
        if (value[0] != '\0')
            options.seconds = std::stod(value);

    if (const char* value = std::getenv("XLETH_AUDIO_PERF_SCENARIO"))
        if (value[0] != '\0')
            options.scenario = value;

    options.strict = envFlag("XLETH_STRICT_AUDIO_PERF");
}

void printHelp(const char* exe)
{
    std::cout
        << "Usage: " << exe << " [options]\n\n"
        << "Manual Xleth audio performance report runner. This target drives real\n"
        << "MixEngine processing paths and writes Stage 5C JSON/Markdown reports.\n\n"
        << "Options:\n"
        << "  --help                       Show this help.\n"
        << "  --scenario <id|all>          Scenario to run (default: all).\n"
        << "  --sample-rate <hz>           Sample rate (default: 48000).\n"
        << "  --block-size <n>             Block size: 64,128,256,512,1024 (default: 256).\n"
        << "  --seconds <n>                Scenario duration (default: 5).\n"
        << "  --output-dir <path>          Report directory.\n"
        << "  --strict                     Return nonzero on warning/overrunning reports.\n"
        << "  --audio-engine               Reserved for a future headless AudioEngine path.\n\n"
        << "Environment defaults:\n"
        << "  XLETH_AUDIO_PERF_REPORT_DIR, XLETH_AUDIO_PERF_SAMPLE_RATE,\n"
        << "  XLETH_AUDIO_PERF_BLOCK_SIZE, XLETH_AUDIO_PERF_SECONDS,\n"
        << "  XLETH_AUDIO_PERF_SCENARIO, XLETH_STRICT_AUDIO_PERF=1\n\n"
        << "Scenarios:\n";

    std::cout << "  all\n";
    for (const auto& scenario : supportedScenarios())
        std::cout << "  " << scenario << "\n";
}

Options parseOptions(int argc, char** argv)
{
    Options options;
    applyEnvDefaults(options);
    options.outputDir = defaultOutputDir();

    for (int i = 1; i < argc; ++i)
    {
        const std::string arg = argv[i];
        auto requireValue = [&](const char* name) -> std::string {
            if (i + 1 >= argc)
                throw std::runtime_error(std::string("missing value for ") + name);
            return argv[++i];
        };

        if (arg == "--help" || arg == "-h")
        {
            printHelp(argv[0]);
            std::exit(0);
        }
        else if (arg == "--scenario")
        {
            options.scenario = requireValue("--scenario");
        }
        else if (arg == "--sample-rate")
        {
            options.sampleRate = std::stod(requireValue("--sample-rate"));
        }
        else if (arg == "--block-size")
        {
            options.blockSize = std::stoi(requireValue("--block-size"));
        }
        else if (arg == "--seconds")
        {
            options.seconds = std::stod(requireValue("--seconds"));
        }
        else if (arg == "--output-dir")
        {
            options.outputDir = std::filesystem::path(requireValue("--output-dir"));
        }
        else if (arg == "--strict")
        {
            options.strict = true;
        }
        else if (arg == "--audio-engine")
        {
            options.audioEnginePath = true;
        }
        else
        {
            throw std::runtime_error("unknown option: " + arg);
        }
    }

    if (options.sampleRate <= 0.0 || !std::isfinite(options.sampleRate))
        throw std::runtime_error("sample rate must be positive and finite");
    if (!isAllowedBlockSize(options.blockSize))
        throw std::runtime_error("block size must be one of 64, 128, 256, 512, 1024");
    if (options.seconds <= 0.0 || !std::isfinite(options.seconds))
        throw std::runtime_error("seconds must be positive and finite");

    const auto scenarios = supportedScenarios();
    if (options.scenario != "all"
        && std::find(scenarios.begin(), scenarios.end(), options.scenario) == scenarios.end())
    {
        throw std::runtime_error("unknown scenario: " + options.scenario);
    }

    return options;
}

juce::File makeTempDir()
{
    auto dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                   .getChildFile("xleth_audio_perf_"
                                 + juce::String::toHexString(
                                     static_cast<juce::int64>(
                                         juce::Time::currentTimeMillis())));
    if (!dir.createDirectory())
        throw std::runtime_error("failed to create temp directory");
    return dir;
}

juce::File generateDiagnosticWav(const juce::File& dir,
                                 const juce::String& name,
                                 double sampleRate,
                                 int numSamples,
                                 float baseFrequency,
                                 float amplitude)
{
    juce::AudioBuffer<float> buffer(1, numSamples);
    auto* data = buffer.getWritePointer(0);
    for (int i = 0; i < numSamples; ++i)
    {
        const double t = static_cast<double>(i) / sampleRate;
        const float carrier =
            0.58f * std::sin(static_cast<float>(2.0 * juce::MathConstants<double>::pi
                                                * baseFrequency * t))
            + 0.27f * std::sin(static_cast<float>(2.0 * juce::MathConstants<double>::pi
                                                  * baseFrequency * 2.01 * t))
            + 0.15f * std::sin(static_cast<float>(2.0 * juce::MathConstants<double>::pi
                                                  * baseFrequency * 4.03 * t));
        data[i] = amplitude * carrier;
    }

    juce::File file = dir.getChildFile(name + ".wav");
    file.deleteFile();

    auto outStream = std::unique_ptr<juce::FileOutputStream>(file.createOutputStream());
    if (!outStream)
        throw std::runtime_error("failed to create temp WAV");

    juce::WavAudioFormat wavFormat;
    std::unique_ptr<juce::AudioFormatWriter> writer(
        wavFormat.createWriterFor(outStream.get(), sampleRate, 1, 16, {}, 0));
    if (!writer)
        throw std::runtime_error("failed to create temp WAV writer");

    outStream.release();
    writer->writeFromAudioSampleBuffer(buffer, 0, numSamples);
    return file;
}

int addAudioTrackWithClip(Timeline& timeline,
                          SampleBank& bank,
                          MixEngine& engine,
                          const juce::File& wav,
                          double sampleRate,
                          double seconds,
                          const std::string& name)
{
    TrackInfo track;
    track.name = name;
    track.type = TrackInfo::Type::Clip;
    const int trackId = timeline.addTrack(track);

    SampleRegion region;
    region.name = name + "Region";
    region.label = SampleLabel::Custom;
    const int regionId = timeline.addRegion(region);

    Clip clip;
    clip.trackId = trackId;
    clip.regionId = regionId;
    clip.position = TickTime::fromBeats(0.0);
    clip.duration = TickTime::fromBeats((seconds * kBpm) / 60.0);
    timeline.addClip(clip);

    const int sampleId = bank.loadSample(wav, sampleRate);
    if (sampleId < 0)
        throw std::runtime_error("failed to load generated WAV into SampleBank");
    engine.mapRegionToSample(regionId, sampleId);
    return trackId;
}

void setParamOrThrow(MixEngine& engine,
                     int trackId,
                     int nodeId,
                     const std::string& paramId,
                     float value)
{
    if (!engine.setEffectParameter(trackId, nodeId, paramId, value))
        throw std::runtime_error("failed to set parameter '" + paramId + "'");
}

void configureResonanceSuppressor(MixEngine& engine,
                                  int trackId,
                                  int nodeId,
                                  bool highQuality)
{
    setParamOrThrow(engine, trackId, nodeId, "processing_mode", highQuality ? 1.0f : 0.0f);
    setParamOrThrow(engine, trackId, nodeId, "quality", highQuality ? 2.0f : 1.0f);
    setParamOrThrow(engine, trackId, nodeId, "depth", highQuality ? 65.0f : 45.0f);
    setParamOrThrow(engine, trackId, nodeId, "sharpness", 65.0f);
    setParamOrThrow(engine, trackId, nodeId, "selectivity", 70.0f);
    setParamOrThrow(engine, trackId, nodeId, "mix", 100.0f);
}

void addEqSpectralBand(MixEngine& engine, int trackId, int nodeId)
{
    auto* effect = dynamic_cast<XlethEQEffect*>(engine.getEffectPtr(trackId, nodeId));
    if (effect == nullptr)
        throw std::runtime_error("xletheq node did not expose XlethEQEffect");

    const int band = effect->addBand();
    if (band < 0)
        throw std::runtime_error("failed to add EQ band");

    effect->setBandParam(band, "freq", 2500.0f);
    effect->setBandParam(band, "gain", -6.0f);
    effect->setBandParam(band, "q", 3.0f);
    effect->setBandParam(band, "mode", 2.0f);
    effect->refreshLatencySamples();
}

void configureScenario(const std::string& scenarioId,
                       MixEngine& engine,
                       Timeline& timeline,
                       SampleBank& bank,
                       const juce::File& tempDir,
                       const Options& options)
{
    const int sampleCount = static_cast<int>(
        std::ceil((options.seconds + 2.0) * options.sampleRate));
    const juce::File wav = generateDiagnosticWav(tempDir,
                                                 "diagnostic",
                                                 options.sampleRate,
                                                 sampleCount,
                                                 220.0f,
                                                 0.35f);

    if (scenarioId == "baseline_empty_mix")
        return;

    const auto addTrack = [&](const std::string& name, float frequency) {
        const juce::File trackWav = generateDiagnosticWav(tempDir,
                                                          juce::String(name),
                                                          options.sampleRate,
                                                          sampleCount,
                                                          frequency,
                                                          0.30f);
        return addAudioTrackWithClip(timeline, bank, engine, trackWav,
                                     options.sampleRate, options.seconds, name);
    };

    if (scenarioId == "dry_track_mix")
    {
        (void) addAudioTrackWithClip(timeline, bank, engine, wav,
                                     options.sampleRate, options.seconds, "DryTrack");
    }
    else if (scenarioId == "resonance_suppressor_normal_quality")
    {
        const int trackId = addAudioTrackWithClip(timeline, bank, engine, wav,
                                                  options.sampleRate, options.seconds,
                                                  "RSNormal");
        const int nodeId = engine.addEffect(trackId, "resonancesuppressor", 0);
        if (nodeId < 0)
            throw std::runtime_error("failed to add Resonance Suppressor");
        configureResonanceSuppressor(engine, trackId, nodeId, false);
    }
    else if (scenarioId == "resonance_suppressor_high_quality")
    {
        const int trackId = addAudioTrackWithClip(timeline, bank, engine, wav,
                                                  options.sampleRate, options.seconds,
                                                  "RSHQ");
        const int nodeId = engine.addEffect(trackId, "resonancesuppressor", 0);
        if (nodeId < 0)
            throw std::runtime_error("failed to add Resonance Suppressor");
        configureResonanceSuppressor(engine, trackId, nodeId, true);
    }
    else if (scenarioId == "multi_track_resonance_suppressor_high_quality")
    {
        for (int i = 0; i < 4; ++i)
        {
            const int trackId = addTrack("RSHQTrack" + std::to_string(i + 1),
                                         170.0f + 70.0f * static_cast<float>(i));
            const int nodeId = engine.addEffect(trackId, "resonancesuppressor", 0);
            if (nodeId < 0)
                throw std::runtime_error("failed to add Resonance Suppressor");
            configureResonanceSuppressor(engine, trackId, nodeId, true);
        }
    }
    else if (scenarioId == "stock_latent_effect_chain")
    {
        const int trackId = addAudioTrackWithClip(timeline, bank, engine, wav,
                                                  options.sampleRate, options.seconds,
                                                  "StockLatent");
        const int eqNode = engine.addEffect(trackId, "xletheq", 0);
        const int compressorNode = engine.addEffect(trackId, "compressor", 1);
        const int limiterNode = engine.addEffect(trackId, "limiter", 2);
        if (eqNode < 0 || compressorNode < 0 || limiterNode < 0)
            throw std::runtime_error("failed to add stock latent chain");
        addEqSpectralBand(engine, trackId, eqNode);
        setParamOrThrow(engine, trackId, limiterNode, "style", 2.0f);
    }
    else if (scenarioId == "third_party_wrapped_chain")
    {
        const int trackId = addAudioTrackWithClip(timeline, bank, engine, wav,
                                                  options.sampleRate, options.seconds,
                                                  "ThirdPartyWrapped");
        auto wrappedA = std::make_unique<GuardedPluginWrapper>(
            std::make_unique<TestGainEffect>());
        auto wrappedB = std::make_unique<GuardedPluginWrapper>(
            std::make_unique<TestGainEffect>());
        const int nodeA = engine.addProcessorForTesting(trackId,
                                                        "third_party",
                                                        std::move(wrappedA),
                                                        0);
        const int nodeB = engine.addProcessorForTesting(trackId,
                                                        "third_party",
                                                        std::move(wrappedB),
                                                        1);
        if (nodeA < 0 || nodeB < 0)
            throw std::runtime_error("failed to add GuardedPluginWrapper chain");
    }
    else if (scenarioId == "master_chain_latent_heavy_effect")
    {
        (void) addAudioTrackWithClip(timeline, bank, engine, wav,
                                     options.sampleRate, options.seconds,
                                     "MasterInput");
        const int rsNode = engine.addMasterEffect("resonancesuppressor", 0);
        const int limiterNode = engine.addMasterEffect("limiter", 1);
        if (rsNode < 0 || limiterNode < 0)
            throw std::runtime_error("failed to add master chain");
        configureResonanceSuppressor(engine, -1, rsNode, true);
        setParamOrThrow(engine, -1, limiterNode, "style", 2.0f);
    }
    else
    {
        throw std::runtime_error("unsupported scenario: " + scenarioId);
    }
}

AudioPerfScenarioReport runMixEngineScenario(const std::string& scenarioId,
                                             const Options& options,
                                             const juce::File& tempDir)
{
    Timeline timeline(kBpm, options.sampleRate);
    SampleBank bank;
    MixEngine engine;
    Transport transport;

    engine.prepare(options.sampleRate, options.blockSize);
    engine.setTimeline(&timeline);
    engine.setSampleBank(&bank);
    transport.setSampleRate(options.sampleRate);
    transport.setBPM(kBpm);

    configureScenario(scenarioId, engine, timeline, bank, tempDir, options);
    engine.syncTrackSlotsFromTimeline(true);
    engine.refreshLatencyDiagnostics();

    engine.setRealtimeDiagnosticsEnabled(true);
    engine.resetRealtimeDiagnostics();

    const std::uint32_t blockCount = static_cast<std::uint32_t>(
        std::max(1.0, std::ceil((options.seconds * options.sampleRate)
                                / static_cast<double>(options.blockSize))));
    juce::AudioBuffer<float> block(2, options.blockSize);

    transport.seekToSample(0);
    transport.play();
    for (std::uint32_t i = 0; i < blockCount; ++i)
    {
        block.clear();
        const auto start = std::chrono::steady_clock::now();
        engine.processBlock(block, options.blockSize, transport);
        const auto elapsedNs =
            static_cast<std::uint64_t>(
                std::chrono::duration_cast<std::chrono::nanoseconds>(
                    std::chrono::steady_clock::now() - start).count());
        engine.recordAudioCallbackTiming(options.blockSize, options.sampleRate, elapsedNs);
        transport.advance(options.blockSize);
    }
    transport.pause();

    const auto diagnostics = engine.getRealtimeDiagnosticsSnapshot();
    const auto latency = engine.getLatencyCompensationSnapshot();

    AudioPerfScenarioReport report;
    report.metadata.id = scenarioId;
    report.metadata.name = scenarioId;
    report.metadata.description =
        "Manual real MixEngine processing path for " + scenarioId;
    report.metadata.sampleRate = options.sampleRate;
    report.metadata.blockSize = static_cast<std::uint32_t>(options.blockSize);
    report.metadata.blockCount = blockCount;
    report.metadata.totalRenderedSamples =
        static_cast<std::uint64_t>(blockCount)
        * static_cast<std::uint64_t>(options.blockSize);
    report.metadata.deadlineUs = deadlineUsFor(options.blockSize, options.sampleRate);

    auto& telemetry = report.telemetry;
    telemetry.counters.enabled = diagnostics.enabled;
    telemetry.counters.droppedTimingSamples = diagnostics.droppedTelemetrySamples;
    telemetry.counters.audioCallbackCount = diagnostics.audioCallbackCount;
    telemetry.counters.mixBlockCount = diagnostics.blockCount;
    telemetry.counters.callbackOverrunCount = diagnostics.audioCallbackOverrunCount;
    telemetry.counters.mixOverrunCount = diagnostics.overrunBlockCount;
    telemetry.counters.overBudgetBlockCount = diagnostics.overBudgetBlockCount;
    telemetry.counters.chainLockMissCount = diagnostics.chainLockMissCount;
    telemetry.counters.masterChainSkippedCount = diagnostics.masterChainSkippedCount;
    telemetry.counters.trackChainSkippedCount = diagnostics.trackChainSkippedCount;
    telemetry.counters.staleSnapshotReuseCount = diagnostics.staleSnapshotReuseCount;
    telemetry.counters.guardedPluginCrashedSkippedCount =
        diagnostics.guardedPluginCrashedSkippedCount;
    telemetry.counters.latencyEpochChangeCount = diagnostics.latencyEpochChangeCount;
    telemetry.counters.compensationTargetChangeCount = diagnostics.pdcRetargetCount;
    telemetry.counters.pdcDelayProcessCount = diagnostics.pdcDelayProcessCount;
    telemetry.counters.resonanceSuppressorWolaCallCount =
        diagnostics.resonanceSuppressorWolaCallCount;
    telemetry.counters.resonanceSuppressorAudioThreadReprepareCount =
        diagnostics.resonanceSuppressorAudioThreadReprepareCount;
    telemetry.counters.resonanceSuppressorDeferredReprepareCount =
        diagnostics.resonanceSuppressorDeferredReprepareCount;
    telemetry.counters.nanInfBlockCount = diagnostics.nanInfBlockCount;
    telemetry.counters.lastBlockSize = static_cast<std::uint32_t>(options.blockSize);
    telemetry.counters.lastSampleRateMilliHz =
        static_cast<std::uint64_t>((options.sampleRate * 1000.0) + 0.5);
    telemetry.counters.lastDeadlineUs = report.metadata.deadlineUs;
    telemetry.counters.maxCallbackDurationUs = msToUs(diagnostics.maxAudioCallbackMs);
    telemetry.counters.maxMixDurationUs = msToUs(diagnostics.maxProcessBlockMs);

    telemetry.callback = metricFromMs(diagnostics.audioCallbackCount,
                                      diagnostics.avgAudioCallbackMs,
                                      diagnostics.p50AudioCallbackMs,
                                      diagnostics.p95AudioCallbackMs,
                                      diagnostics.p99AudioCallbackMs,
                                      diagnostics.maxAudioCallbackMs);
    telemetry.mixBlock = metricFromMs(diagnostics.blockCount,
                                      diagnostics.avgProcessBlockMs,
                                      diagnostics.p50ProcessBlockMs,
                                      diagnostics.p95ProcessBlockMs,
                                      diagnostics.p99ProcessBlockMs,
                                      diagnostics.maxProcessBlockMs);
    telemetry.trackChain = metricFromMs(diagnostics.blockCount,
                                        diagnostics.avgTrackChainMs,
                                        0.0,
                                        diagnostics.p95TrackChainMs,
                                        diagnostics.p99TrackChainMs,
                                        diagnostics.maxTrackChainMs);
    telemetry.masterChain = metricFromMs(diagnostics.blockCount,
                                         diagnostics.avgMasterChainMs,
                                         0.0,
                                         diagnostics.p95MasterChainMs,
                                         diagnostics.p99MasterChainMs,
                                         diagnostics.maxMasterChainMs);
    telemetry.effect = metricFromMs(diagnostics.pluginCallCount,
                                    diagnostics.avgPluginMs,
                                    0.0,
                                    diagnostics.p95PluginMs,
                                    diagnostics.p99PluginMs,
                                    diagnostics.maxPluginMs);
    telemetry.pdcDelay = metricFromMs(diagnostics.pdcDelayProcessCount,
                                      diagnostics.avgPdcDelayMs,
                                      0.0,
                                      diagnostics.p95PdcDelayMs,
                                      diagnostics.p99PdcDelayMs,
                                      diagnostics.maxPdcDelayMs);

    telemetry.recentCallbackDurationUs = diagnostics.recentAudioCallbackUs;
    telemetry.worstEffectsByMax = diagnostics.worstEffectsByMax;
    telemetry.worstEffectsByP99 = diagnostics.worstEffectsByP99;
    telemetry.worstChainsByMax = diagnostics.worstChainsByMax;
    telemetry.worstChainsByP99 = diagnostics.worstChainsByP99;

    auto wolaMetric = AudioTelemetryMetricSummary{};
    wolaMetric.count = diagnostics.resonanceSuppressorWolaCallCount;
    wolaMetric.averageUs = diagnostics.avgResonanceSuppressorWolaMs * 1000.0;
    wolaMetric.maxUs = msToUs(diagnostics.maxResonanceSuppressorWolaMs);
    for (const auto& scope : diagnostics.worstEffectsByP99)
    {
        if (scope.kind == AudioTelemetrySampleKind::EffectSection
            && (scope.flags & xleth::audio::kAudioTelemetryFlagWola) != 0)
        {
            wolaMetric.p99Us = scope.timing.p99Us;
            wolaMetric.p95Us = scope.timing.p95Us;
            wolaMetric.p50Us = scope.timing.p50Us;
            break;
        }
    }
    if (wolaMetric.p99Us == 0)
        wolaMetric.p99Us = wolaMetric.maxUs;
    telemetry.effectSection = wolaMetric;

    report.latency.latencyEpochChanges =
        static_cast<std::uint32_t>(diagnostics.latencyEpochChangeCount);
    report.latency.compensationTargetChanges =
        static_cast<std::uint32_t>(diagnostics.pdcRetargetCount);
    report.latency.maxTrackLatencySamples =
        static_cast<std::uint32_t>(
            std::max(0, latency.maxAudibleTrackLatencySamples));
    report.latency.masterLatencySamples =
        static_cast<std::uint32_t>(
            std::max(0, latency.masterInsertLatencySamples));
    report.latency.livePresentationLatencySamples = 0;

    report.classification = AudioPerformanceScenarioRunner::classify(
        report.metadata.deadlineUs,
        report.telemetry.callback,
        report.telemetry.mixBlock,
        report.telemetry.counters);

    return report;
}

std::vector<std::string> selectedScenarioIds(const Options& options)
{
    if (options.scenario == "all")
        return supportedScenarios();
    return {options.scenario};
}

} // namespace

int main(int argc, char** argv)
{
    try
    {
        juce::ScopedJuceInitialiser_GUI juceInit;
        const auto options = parseOptions(argc, argv);

        if (options.audioEnginePath)
        {
            std::cerr
                << "AudioEngine headless device path is deferred for this manual runner. "
                << "Run without --audio-engine to use the MixEngine path.\n";
            return 2;
        }

        juce::File tempDir = makeTempDir();
        std::vector<AudioPerfScenarioReport> reports;
        for (const auto& scenarioId : selectedScenarioIds(options))
        {
            std::cout << "[xleth-audio-perf] running " << scenarioId << "\n";
            reports.push_back(runMixEngineScenario(scenarioId, options, tempDir));
        }

        AudioPerformanceScenarioRunner::writeReports(reports, options.outputDir);

        std::cout << "[xleth-audio-perf] wrote "
                  << (options.outputDir / "audio-performance-scenarios.json").string()
                  << "\n";
        std::cout << "[xleth-audio-perf] wrote "
                  << (options.outputDir / "audio-performance-scenarios.md").string()
                  << "\n";

        if (options.strict
            && AudioPerformanceScenarioRunner::hasStrictBudgetFailure(reports))
        {
            std::cerr << "[xleth-audio-perf] strict mode failed: "
                      << "one or more scenarios classified warning/overrunning\n";
            return 3;
        }

        return 0;
    }
    catch (const std::exception& e)
    {
        std::cerr << "xleth_audio_perf_report: " << e.what() << "\n";
        std::cerr << "Run with --help for usage.\n";
        return 1;
    }
}
