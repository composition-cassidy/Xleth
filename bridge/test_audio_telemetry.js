'use strict';
//
// bridge/test_audio_telemetry.js - Stage 5A bridge telemetry contract
//
// Verifies that audio performance telemetry is exposed as a plain object and
// keeps PDC/presentation state separate from realtime CPU deadline health.
//

const fs = require('fs');
const path = require('path');

function pickNativeConfig() {
  const requested = process.env.XLETH_NATIVE_CONFIG;
  const configs = requested ? [requested] : ['Debug', 'Release'];
  for (const config of configs) {
    const addonPath = path.resolve(__dirname, 'build', config, 'xleth_native.node');
    if (fs.existsSync(addonPath)) return { config, addonPath };
  }
  throw new Error('xleth_native.node not found in bridge/build/Debug or bridge/build/Release');
}

const native = pickNativeConfig();
const dllDirs = [
  path.dirname(native.addonPath),
  path.resolve(__dirname, 'build/vcpkg_installed/x64-windows/debug/bin'),
  path.resolve(__dirname, 'build/vcpkg_installed/x64-windows/bin'),
].filter((dir) => fs.existsSync(dir));
process.env.PATH = `${dllDirs.join(';')};${process.env.PATH}`;
process.env.XLETH_BRIDGE_DISABLE_PREVIEW_GPU = '1';

const addon = require(native.addonPath);

let passed = 0;
let failed = 0;
let total = 0;

function ok(condition, label) {
  total += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed += 1;
  } else {
    console.error(`  FAIL  ${label}`);
    failed += 1;
  }
}

function finiteNonNegative(value, label) {
  ok(typeof value === 'number' && Number.isFinite(value) && value >= 0,
     `${label} is finite and non-negative`);
}

function assertMetric(metric, label) {
  ok(metric && typeof metric === 'object', `${label} metric exists`);
  for (const key of ['count', 'averageUs', 'p50Us', 'p95Us', 'p99Us', 'maxUs']) {
    finiteNonNegative(metric[key], `${label}.${key}`);
  }
}

function assertWorstArray(value, label) {
  ok(Array.isArray(value), `${label} is an array`);
  for (const scope of value) {
    ok(scope && typeof scope === 'object', `${label} entry is object`);
    ok(typeof scope.kind === 'string', `${label} entry has kind`);
    ok(typeof scope.effectTypeName === 'string', `${label} entry has effect type name`);
    finiteNonNegative(scope.count, `${label} entry count`);
    finiteNonNegative(scope.p99Us, `${label} entry p99Us`);
    finiteNonNegative(scope.maxUs, `${label} entry maxUs`);
    assertMetric(scope.timing, `${label} entry timing`);
  }
}

function assertTelemetryShape(snapshot, label) {
  ok(snapshot && typeof snapshot === 'object', `${label}: snapshot is object`);
  for (const key of [
    'sampleRate',
    'blockSize',
    'callbackDeadlineUs',
    'callbackP50Us',
    'callbackP95Us',
    'callbackP99Us',
    'callbackMaxUs',
    'mixEngineP50Us',
    'mixEngineP95Us',
    'mixEngineP99Us',
    'mixEngineMaxUs',
    'callbackOverrunCount',
    'mixEngineOverrunCount',
    'droppedTelemetrySamples',
    'lockMissCount',
    'masterChainSkippedCount',
    'trackChainSkippedCount',
    'staleSnapshotReuseCount',
    'guardedPluginCrashedSkippedCount',
    'latencyEpochChanges',
    'compensationTargetChanges',
    'maxAudibleTrackLatencySamples',
    'masterInsertLatencySamples',
    'audioDeviceOutputLatencySamples',
    'livePresentationLatencySamples',
    'rawPositionSamples',
    'presentationPositionSamples',
    'activeResonanceSuppressorHighQualityInstanceCount',
  ]) {
    finiteNonNegative(snapshot[key], `${label}.${key}`);
  }
  ok(['healthy', 'warning', 'overrunning'].includes(snapshot.realtimeRsHqRiskLevel),
     `${label}.realtimeRsHqRiskLevel is known`);
  ok(Array.isArray(snapshot.realtimeRsHqRiskReasons),
     `${label}.realtimeRsHqRiskReasons is an array`);
  ok(Array.isArray(snapshot.recommendedAction),
     `${label}.recommendedAction is an array`);

  assertMetric(snapshot.callback, `${label}.callback`);
  assertMetric(snapshot.mixEngine, `${label}.mixEngine`);
  assertWorstArray(snapshot.worstChainsByMax, `${label}.worstChainsByMax`);
  assertWorstArray(snapshot.worstChainsByP99, `${label}.worstChainsByP99`);
  assertWorstArray(snapshot.worstEffectsByMax, `${label}.worstEffectsByMax`);
  assertWorstArray(snapshot.worstEffectsByP99, `${label}.worstEffectsByP99`);

  ok(snapshot.resonanceSuppressorHighQuality
     && typeof snapshot.resonanceSuppressorHighQuality === 'object',
     `${label}: Resonance Suppressor High Quality object exists`);
  for (const key of ['wolaCallCount', 'averageWolaUs', 'maxWolaUs',
                     'audioThreadReprepareCount', 'deferredReprepareCount',
                     'activeInstanceCount']) {
    finiteNonNegative(snapshot.resonanceSuppressorHighQuality[key],
                      `${label}.resonanceSuppressorHighQuality.${key}`);
  }
  ok(['healthy', 'warning', 'overrunning'].includes(snapshot.resonanceSuppressorHighQuality.riskLevel),
     `${label}.resonanceSuppressorHighQuality.riskLevel is known`);
  ok(Array.isArray(snapshot.resonanceSuppressorHighQuality.riskReasons),
     `${label}.resonanceSuppressorHighQuality.riskReasons is an array`);
  ok(Array.isArray(snapshot.resonanceSuppressorHighQuality.recommendedAction),
     `${label}.resonanceSuppressorHighQuality.recommendedAction is an array`);
}

function assertCaptureReportShape(report, label) {
  ok(report && typeof report === 'object', `${label}: report is object`);
  ok(report.schemaVersion === 'xleth.audioPerformanceCapture.v1',
     `${label}: schema version is v1`);
  for (const key of [
    'sampleRate',
    'blockSize',
    'captureDurationSeconds',
    'renderedBlockCount',
    'expectedApproxCallbackCount',
    'callbackSampleCount',
    'mixEngineSampleCount',
    'effectSampleCount',
    'callbackCoveragePercent',
    'mixEngineCoveragePercent',
    'droppedTelemetrySamplesDuringCapture',
    'callbackDeadlineUs',
    'callbackP50Us',
    'callbackP95Us',
    'callbackP99Us',
    'callbackMaxUs',
    'mixEngineP50Us',
    'mixEngineP95Us',
    'mixEngineP99Us',
    'mixEngineMaxUs',
    'callbackOverrunCount',
    'mixEngineOverrunCount',
    'droppedTelemetrySamples',
    'lockMisses',
    'staleChainReuse',
    'guardedPluginSkippedOrCrashedCount',
    'latencyEpochChanges',
    'compensationTargetChanges',
    'maxAudibleTrackLatencySamples',
    'masterInsertLatencySamples',
    'deviceOutputLatencySamples',
    'livePresentationLatencySamples',
    'rawPositionSamplesAtCaptureStart',
    'rawPositionSamplesAtCaptureEnd',
    'presentationPositionSamplesAtCaptureStart',
    'presentationPositionSamplesAtCaptureEnd',
    'activeResonanceSuppressorHighQualityInstanceCount',
  ]) {
    finiteNonNegative(report[key], `${label}.${key}`);
  }
  assertMetric(report.callback, `${label}.callback`);
  assertMetric(report.mixEngine, `${label}.mixEngine`);
  ok(Array.isArray(report.worstChainsByP99), `${label}.worstChainsByP99 is array`);
  ok(Array.isArray(report.worstEffectsByP99), `${label}.worstEffectsByP99 is array`);
  ok(report.resonanceSuppressorHighQuality
     && typeof report.resonanceSuppressorHighQuality === 'object',
     `${label}: RS HQ report object exists`);
  finiteNonNegative(report.resonanceSuppressorHighQuality.wolaP99Us,
                    `${label}.rsHq.wolaP99Us`);
  finiteNonNegative(report.resonanceSuppressorHighQuality.wolaMaxUs,
                    `${label}.rsHq.wolaMaxUs`);
  ok(['healthy', 'warning', 'overrunning'].includes(report.realtimeRsHqRiskLevel),
     `${label}.realtimeRsHqRiskLevel is known`);
  ok(['good', 'usable', 'poor', 'inconclusive'].includes(report.telemetryCoverageQuality),
     `${label}.telemetryCoverageQuality is known`);
  ok(typeof report.cpuHealth === 'string', `${label}.cpuHealth exists`);
  ok(report.diagnosis && ['Healthy', 'Warning', 'Overrunning', 'Inconclusive'].includes(report.diagnosis.status),
     `${label}.diagnosis.status is known`);
  ok(report.diagnosis.telemetryCoverageQuality === report.telemetryCoverageQuality,
     `${label}.diagnosis keeps coverage separate`);
  const text = JSON.stringify(report);
  ok(!/[A-Za-z]:\\\\Users\\\\/.test(text), `${label}: report omits obvious absolute user media paths`);
}

function assertNoReactLatencyFormula() {
  const uiFiles = [
    path.resolve(__dirname, '../ui/src/components/SettingsPanel.jsx'),
    path.resolve(__dirname, '../ui/src/components/debug/AudioPerformanceDiagnosticsPanel.jsx'),
  ];
  const forbidden = [
    /rawPositionSamples\s*-\s*[^;\n]*livePresentationLatencySamples/,
    /livePresentationLatencySamples\s*=\s*[^;\n]*maxAudibleTrackLatencySamples/,
    /maxAudibleTrackLatencySamples\s*\+\s*masterInsertLatencySamples/,
  ];
  for (const file of uiFiles) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    for (const pattern of forbidden) {
      ok(!pattern.test(text), `no React-side latency formula in ${path.basename(file)} (${pattern})`);
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`=== xleth bridge audio telemetry test (${native.config}) ===\n`);

  ok(typeof addon.getAudioPerformanceTelemetry === 'function',
     'getAudioPerformanceTelemetry() is exported');
  ok(typeof addon.audio_getAudioPerformanceTelemetry === 'function',
     'audio_getAudioPerformanceTelemetry() alias is exported');
  ok(typeof addon.startAudioPerformanceCapture === 'function',
     'startAudioPerformanceCapture() is exported');
  ok(typeof addon.stopAudioPerformanceCapture === 'function',
     'stopAudioPerformanceCapture() is exported');
  ok(typeof addon.exportAudioPerformanceCaptureReport === 'function',
     'exportAudioPerformanceCaptureReport() is exported');
  ok(typeof addon.captureAudioPerformanceReport === 'function',
     'captureAudioPerformanceReport() is exported');

  ok(addon.initialize({ disablePreviewGpu: true }) === true,
     'initialize() returns true');
  ok(addon.audio_setRealtimeDiagnosticsEnabled(true) === true,
     'realtime diagnostics enabled');

  assertTelemetryShape(addon.getAudioPerformanceTelemetry(), 'after init');
  assertTelemetryShape(addon.audio_getAudioPerformanceTelemetry(), 'after init alias');

  addon.play();
  for (let i = 0; i < 3; ++i) {
    await delay(100);
    assertTelemetryShape(addon.getAudioPerformanceTelemetry(), `during play ${i + 1}`);
  }

  addon.stop();
  assertTelemetryShape(addon.getAudioPerformanceTelemetry(), 'after stop');

  try {
    addon.captureAudioPerformanceReport({ seconds: 2 });
    ok(false, 'capture duration below 3 seconds is rejected');
  } catch (_) {
    ok(true, 'capture duration below 3 seconds is rejected');
  }

  const outDir = path.resolve(__dirname, '_tmp_audio_perf_capture');
  fs.rmSync(outDir, { recursive: true, force: true });
  addon.startAudioPerformanceCapture({ seconds: 3, label: 'bridge-test' });
  addon.play();
  await delay(150);
  addon.stop();
  const report = addon.stopAudioPerformanceCapture();
  assertCaptureReportShape(report, 'real-project capture report');
  const exported = addon.exportAudioPerformanceCaptureReport({
    seconds: 3,
    outputDir: outDir,
    includeJson: true,
    includeMarkdown: true,
    label: 'bridge-test',
  });
  ok(exported && exported.ok === true, 'capture export returns ok');
  ok(fs.existsSync(exported.jsonPath), 'JSON report file exists');
  ok(fs.existsSync(exported.markdownPath), 'Markdown report file exists');
  const jsonReport = JSON.parse(fs.readFileSync(exported.jsonPath, 'utf8'));
  assertCaptureReportShape(jsonReport, 'JSON report file');
  const markdown = fs.readFileSync(exported.markdownPath, 'utf8');
  for (const section of ['Summary', 'Realtime CPU', 'Telemetry Coverage', 'Latency / PDC', 'RS HQ', 'Worst Effects', 'Diagnosis']) {
    ok(markdown.includes(`## ${section}`), `Markdown report contains ${section}`);
  }

  assertNoReactLatencyFormula();

  ok(addon.audio_setRealtimeDiagnosticsEnabled(false) === true,
     'realtime diagnostics disabled');
  addon.shutdown();
  ok(true, 'shutdown() completed');

  console.log('\n' + '-'.repeat(50));
  console.log(`PASSED: ${passed}/${total} tests`);
  if (failed > 0) {
    console.error(`FAILED: ${failed}/${total} tests`);
    process.exit(1);
  }
}

main().catch((err) => {
  try { addon.stop(); } catch (_) {}
  try { addon.shutdown(); } catch (_) {}
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
