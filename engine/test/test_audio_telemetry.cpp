#include "audio/AudioPerformanceTelemetry.h"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
#include <type_traits>
#include <vector>

using xleth::audio::AudioPerformanceTelemetry;
using xleth::audio::AudioTelemetrySampleKind;
using xleth::audio::AudioTelemetryTimingSample;
using xleth::audio::RealtimeRsHqRiskInputs;

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

static AudioTelemetryTimingSample makeSample(AudioTelemetrySampleKind kind,
                                             std::uint32_t durationUs,
                                             std::uint32_t deadlineUs = 10000)
{
    AudioTelemetryTimingSample sample;
    sample.kind = kind;
    sample.durationUs = durationUs;
    sample.deadlineUs = deadlineUs;
    sample.blockSize = 480;
    sample.sampleRateMilliHz = 48000000;
    return sample;
}

static void testPodSampleContract()
{
    std::cout << "[telemetry] POD sample contract\n";
    CHECK(std::is_trivially_copyable_v<AudioTelemetryTimingSample>,
          "timing sample must be trivially copyable");
    CHECK(std::is_standard_layout_v<AudioTelemetryTimingSample>,
          "timing sample must be standard layout");
}

static void testRingWriteReadAndDrop()
{
    std::cout << "[telemetry] ring write/read/drop\n";
    AudioPerformanceTelemetry telemetry;
    telemetry.setEnabled(true);

    for (std::uint32_t i = 0; i < AudioPerformanceTelemetry::kTimingRingCapacity; ++i)
        telemetry.recordTimingFromAudioThread(
            makeSample(AudioTelemetrySampleKind::MixBlock, 100 + i));

    const auto snapshot = telemetry.getSnapshot();
    CHECK(snapshot.counters.mixBlockCount
              == AudioPerformanceTelemetry::kTimingRingCapacity - 1,
          "SPSC ring should accept capacity-1 samples");
    CHECK(snapshot.counters.droppedTimingSamples == 1,
          "full SPSC ring should drop without blocking");
}

static void testPercentiles()
{
    std::cout << "[telemetry] percentile aggregation\n";
    AudioPerformanceTelemetry telemetry;
    telemetry.setEnabled(true);
    telemetry.recordTimingFromAudioThread(makeSample(AudioTelemetrySampleKind::AudioCallback, 1000));
    telemetry.recordTimingFromAudioThread(makeSample(AudioTelemetrySampleKind::AudioCallback, 2000));
    telemetry.recordTimingFromAudioThread(makeSample(AudioTelemetrySampleKind::AudioCallback, 3000));
    telemetry.recordTimingFromAudioThread(makeSample(AudioTelemetrySampleKind::AudioCallback, 4000));
    telemetry.recordTimingFromAudioThread(makeSample(AudioTelemetrySampleKind::AudioCallback, 5000));

    const auto snapshot = telemetry.getSnapshot();
    CHECK(snapshot.callback.count == 5, "callback sample count should match synthetic input");
    CHECK(snapshot.callback.p50Us == 3000, "p50 should be computed off-thread");
    CHECK(snapshot.callback.p95Us == 5000, "p95 should be computed off-thread");
    CHECK(snapshot.callback.p99Us == 5000, "p99 should be computed off-thread");
    CHECK(snapshot.callback.maxUs == 5000, "max should match synthetic input");
}

static void testOverrunDetection()
{
    std::cout << "[telemetry] overrun detection\n";
    AudioPerformanceTelemetry telemetry;
    telemetry.setEnabled(true);
    telemetry.recordTimingFromAudioThread(
        makeSample(AudioTelemetrySampleKind::AudioCallback, 1501, 1500));
    telemetry.recordTimingFromAudioThread(
        makeSample(AudioTelemetrySampleKind::MixBlock, 1499, 1500));

    const auto snapshot = telemetry.getSnapshot();
    CHECK(snapshot.counters.callbackOverrunCount == 1,
          "callback duration greater than deadline should count as overrun");
    CHECK(snapshot.counters.mixOverrunCount == 0,
          "mix duration below deadline should not count as overrun");
}

static void testCounters()
{
    std::cout << "[telemetry] counters\n";
    AudioPerformanceTelemetry telemetry;
    telemetry.setEnabled(true);
    telemetry.incrementChainLockMiss();
    telemetry.incrementTrackChainSkipped(3);
    telemetry.incrementStaleSnapshotReuse();
    telemetry.incrementLatencyEpochChange();
    telemetry.incrementCompensationTargetChange();

    const auto snapshot = telemetry.getSnapshot();
    CHECK(snapshot.counters.chainLockMissCount == 1,
          "chain lock miss counter should increment");
    CHECK(snapshot.counters.trackChainSkippedCount == 3,
          "track chain skipped counter should accumulate");
    CHECK(snapshot.counters.staleSnapshotReuseCount == 1,
          "stale snapshot reuse counter should increment");
    CHECK(snapshot.counters.latencyEpochChangeCount == 1,
          "latency epoch counter should increment");
    CHECK(snapshot.counters.compensationTargetChangeCount == 1,
          "compensation target counter should increment");
}

static void testCaptureAccumulatorAcrossDrainedBatches()
{
    std::cout << "[telemetry] capture accumulator drained batches\n";
    AudioPerformanceTelemetry telemetry;
    telemetry.setEnabled(true);
    telemetry.beginCaptureAccumulation(1);

    for (std::uint32_t i = 0; i < 50; ++i)
    {
        telemetry.recordTimingFromAudioThread(
            makeSample(AudioTelemetrySampleKind::AudioCallback, 1000 + i));
        telemetry.recordTimingFromAudioThread(
            makeSample(AudioTelemetrySampleKind::MixBlock, 900 + i));
    }
    telemetry.drainPendingTimingSamplesForCapture();

    for (std::uint32_t i = 0; i < 50; ++i)
    {
        telemetry.recordTimingFromAudioThread(
            makeSample(AudioTelemetrySampleKind::AudioCallback, 2000 + i));
        telemetry.recordTimingFromAudioThread(
            makeSample(AudioTelemetrySampleKind::MixBlock, 1900 + i));
    }

    const auto capture = telemetry.finishCaptureAccumulation();
    CHECK(capture.snapshot.callback.count == 100,
          "capture accumulator should include callbacks from multiple drains");
    CHECK(capture.snapshot.mixBlock.count == 100,
          "capture accumulator should include MixEngine samples from multiple drains");
    CHECK(capture.snapshot.callback.p50Us >= 2000,
          "capture accumulator should compute percentiles from accumulated samples");
    CHECK(capture.snapshot.callback.maxUs == 2049,
          "capture accumulator should preserve max across drained batches");
}

static void testCaptureAccumulatorUnderEffectPressure()
{
    std::cout << "[telemetry] capture accumulator mixed effect pressure\n";
    AudioPerformanceTelemetry telemetry;
    telemetry.setEnabled(true);
    telemetry.beginCaptureAccumulation(1);

    constexpr std::uint32_t blocks = 3000;
    for (std::uint32_t block = 0; block < blocks; ++block)
    {
        telemetry.recordTimingFromAudioThread(
            makeSample(AudioTelemetrySampleKind::AudioCallback, 1000 + (block % 7)));
        telemetry.recordTimingFromAudioThread(
            makeSample(AudioTelemetrySampleKind::MixBlock, 900 + (block % 5)));
        for (std::uint32_t effect = 0; effect < 20; ++effect)
            telemetry.recordTimingFromAudioThread(
                makeSample(AudioTelemetrySampleKind::Effect, 100 + effect));
        if ((block + 1u) % 25u == 0u)
            telemetry.drainPendingTimingSamplesForCapture();
    }

    const auto capture = telemetry.finishCaptureAccumulation();
    CHECK(capture.snapshot.callback.count == blocks,
          "long capture should not collapse to a tiny final callback window");
    CHECK(capture.snapshot.mixBlock.count == blocks,
          "long capture should retain MixEngine samples under effect pressure");
    CHECK(capture.snapshot.effect.count == blocks * 20ull,
          "effect samples should still be accumulated when capacity allows");
    CHECK(capture.snapshot.counters.droppedTimingSamples == 0,
          "periodic drain should avoid ring overflow in the synthetic long capture");
    CHECK(AudioPerformanceTelemetry::coveragePercent(
              capture.snapshot.callback.count, blocks) >= 99.0,
          "callback coverage percent should be good");
}

static void testCoverageQuality()
{
    std::cout << "[telemetry] coverage quality\n";
    CHECK(std::string(AudioPerformanceTelemetry::classifyCoverageQuality(90, 90, 100))
              == "good",
          "90 percent callback coverage should be good");
    CHECK(std::string(AudioPerformanceTelemetry::classifyCoverageQuality(50, 50, 100))
              == "usable",
          "50 percent callback coverage should be usable");
    CHECK(std::string(AudioPerformanceTelemetry::classifyCoverageQuality(25, 25, 100))
              == "poor",
          "below 50 percent callback coverage should be poor");
    CHECK(std::string(AudioPerformanceTelemetry::classifyCoverageQuality(0, 10, 100))
              == "inconclusive",
          "missing callback samples should be inconclusive");
    CHECK(std::string(AudioPerformanceTelemetry::classifyCoverageQuality(90, 0, 100))
              == "inconclusive",
          "missing MixEngine samples should be inconclusive");
}

static RealtimeRsHqRiskInputs makeRsHqRiskInput(std::uint32_t blockSize,
                                                std::uint32_t activeInstances)
{
    RealtimeRsHqRiskInputs input;
    input.sampleRate = 48000.0;
    input.blockSize = blockSize;
    input.activeHighQualityInstanceCount = activeInstances;
    input.counters.lastDeadlineUs =
        blockSize > 0 ? static_cast<std::uint32_t>(
            (static_cast<double>(blockSize) / input.sampleRate) * 1000000.0 + 0.5)
                      : 0;
    input.callback.p99Us = input.counters.lastDeadlineUs / 4;
    input.callback.maxUs = input.counters.lastDeadlineUs / 3;
    input.mixBlock.p99Us = input.counters.lastDeadlineUs / 5;
    input.mixBlock.maxUs = input.counters.lastDeadlineUs / 4;
    return input;
}

static bool hasString(const std::vector<std::string>& values, const char* needle)
{
    return std::find(values.begin(), values.end(), needle) != values.end();
}

static void testRsHqRiskClassification()
{
    std::cout << "[telemetry] RS HQ realtime risk classification\n";

    auto input = makeRsHqRiskInput(512, 1);
    auto risk = AudioPerformanceTelemetry::classifyRealtimeRsHqRisk(input);
    CHECK(risk.realtimeRsHqRiskLevel == "healthy",
          "single HQ at block 512 without overruns should be healthy");
    CHECK(risk.activeResonanceSuppressorHighQualityInstanceCount == 1,
          "active HQ instance count should round-trip");

    input = makeRsHqRiskInput(256, 1);
    risk = AudioPerformanceTelemetry::classifyRealtimeRsHqRisk(input);
    CHECK(risk.realtimeRsHqRiskLevel == "warning",
          "single HQ at block 256 should warn under conservative policy");
    CHECK(hasString(risk.realtimeRsHqRiskReasons, "smallBlockSize"),
          "block 256 warning should cite smallBlockSize policy");

    input = makeRsHqRiskInput(128, 1);
    risk = AudioPerformanceTelemetry::classifyRealtimeRsHqRisk(input);
    CHECK(risk.realtimeRsHqRiskLevel == "warning",
          "single HQ at block 128 should warn");

    input = makeRsHqRiskInput(512, 2);
    risk = AudioPerformanceTelemetry::classifyRealtimeRsHqRisk(input);
    CHECK(risk.realtimeRsHqRiskLevel == "warning",
          "multiple HQ instances at block 512 should warn");
    CHECK(hasString(risk.realtimeRsHqRiskReasons, "multipleInstances"),
          "multi-instance warning should cite multipleInstances");

    input = makeRsHqRiskInput(512, 1);
    input.counters.callbackOverrunCount = 1;
    risk = AudioPerformanceTelemetry::classifyRealtimeRsHqRisk(input);
    CHECK(risk.realtimeRsHqRiskLevel == "overrunning",
          "telemetry overrun should escalate RS HQ risk");
    CHECK(hasString(risk.realtimeRsHqRiskReasons, "telemetryOverrun"),
          "overrun classification should cite telemetryOverrun");

    input = makeRsHqRiskInput(64, 4);
    input.offlineOrExport = true;
    risk = AudioPerformanceTelemetry::classifyRealtimeRsHqRisk(input);
    CHECK(risk.realtimeRsHqRiskLevel == "healthy",
          "offline/export HQ should remain allowed");
    CHECK(hasString(risk.realtimeRsHqRiskReasons, "exportOfflineSafe"),
          "offline/export classification should report exportOfflineSafe");
    CHECK(hasString(risk.recommendedAction, "useHqForExport"),
          "offline/export classification should recommend HQ for export");
}

int main()
{
    std::cout << "=== Audio Performance Telemetry Tests ===\n\n";
    testPodSampleContract();
    testRingWriteReadAndDrop();
    testPercentiles();
    testOverrunDetection();
    testCounters();
    testCaptureAccumulatorAcrossDrainedBatches();
    testCaptureAccumulatorUnderEffectPressure();
    testCoverageQuality();
    testRsHqRiskClassification();

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
