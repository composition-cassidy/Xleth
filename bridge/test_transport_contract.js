'use strict';
//
// bridge/test_transport_contract.js - Stage 3 transport-state bridge contract
//
// Verifies that bridge transport state exposes engine-owned live presentation
// fields separately from raw transport fields.
//
// Run after rebuilding the native addon:
//   node bridge/test_transport_contract.js
//

const fs = require('fs');
const path = require('path');

function pickNativeConfig() {
  const requested = process.env.XLETH_NATIVE_CONFIG;
  const configs = requested ? [requested] : ['Release', 'Debug'];
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

function near(actual, expected, tolerance, label) {
  ok(Math.abs(actual - expected) <= tolerance,
     `${label} (expected ${expected}, got ${actual}, tolerance ${tolerance})`);
}

function getNodeId(raw) {
  if (raw && typeof raw === 'object') return raw.nodeId;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw).nodeId; } catch (_) { return -1; }
  }
  return -1;
}

function assertTransportShape(state, label) {
  ok(state && typeof state === 'object', `${label}: state is an object`);
  for (const key of [
    'positionMs',
    'positionBeats',
    'positionSamples',
    'rawPositionMs',
    'rawPositionBeats',
    'rawPositionSamples',
    'livePresentationLatencySamples',
    'livePresentationMaxTrackLatencySamples',
    'livePresentationMasterLatencySamples',
    'livePresentationDeviceOutputLatencySamples',
    'sampleRate',
  ]) {
    ok(typeof state[key] === 'number', `${label}: ${key} is numeric`);
  }
}

function assertPresentationConversions(state, label) {
  const sampleRate = state.sampleRate || 48000;
  const expectedPresentationMs = (state.positionSamples / sampleRate) * 1000;
  const expectedRawMs = (state.rawPositionSamples / sampleRate) * 1000;
  near(state.positionMs, expectedPresentationMs, 0.25,
       `${label}: positionMs is derived from presentation samples`);
  near(state.rawPositionMs, expectedRawMs, 0.25,
       `${label}: rawPositionMs is derived from raw samples`);

  const beatsPerSample = state.bpm / (60 * sampleRate);
  near(state.positionBeats, state.positionSamples * beatsPerSample, 1.0e-3,
       `${label}: positionBeats is derived from presentation samples`);
  near(state.rawPositionBeats, state.rawPositionSamples * beatsPerSample, 1.0e-3,
       `${label}: rawPositionBeats is derived from raw samples`);
}

async function main() {
  console.log(`=== xleth bridge transport contract test (${native.config}) ===\n`);

  ok(addon.initialize({ disablePreviewGpu: true }) === true, 'initialize() returns true');
  ok(typeof addon.audio_setTestDeviceOutputLatencySamplesForDiagnostics === 'function',
     'diagnostic device-latency override is exported');
  ok(addon.audio_setTestDeviceOutputLatencySamplesForDiagnostics(0) === true,
     'device output latency override set to zero');
  addon.timeline_setBPM(140);

  console.log('\n[ zero live presentation latency ]');
  addon.transport_seek(8.0);
  const zero = addon.transport_getState();
  assertTransportShape(zero, 'zero latency');
  near(zero.rawPositionBeats, 8.0, 1.0e-4,
       'rawPositionBeats remains raw musical time after seek');
  ok(zero.livePresentationLatencySamples === 0,
     `live presentation latency is zero (got ${zero.livePresentationLatencySamples})`);
  near(zero.positionSamples, zero.rawPositionSamples, 1.0e-6,
       'zero latency keeps presentation samples equal to raw samples');
  near(zero.positionBeats, zero.rawPositionBeats, 1.0e-6,
       'zero latency keeps presentation beats equal to raw beats');
  near(zero.positionMs, zero.rawPositionMs, 1.0e-6,
       'zero latency keeps presentation ms equal to raw ms');
  assertPresentationConversions(zero, 'zero latency');

  console.log('\n[ nonzero engine-owned live presentation latency ]');
  ok(addon.audio_setTestDeviceOutputLatencySamplesForDiagnostics(256) === true,
     'device output latency override set to 256 samples');
  const nodeId = getNodeId(addon.audio_addMasterEffect('resonancesuppressor', 0));
  ok(nodeId >= 0, `audio_addMasterEffect("resonancesuppressor") -> nodeId=${nodeId}`);
  ok(addon.audio_setEffectParameter(-1, nodeId, 'processing_mode', 1.0) === true,
     'master resonance suppressor processing_mode set to High Quality');
  ok(addon.audio_setEffectParameter(-1, nodeId, 'quality', 2.0) === true,
     'master resonance suppressor quality set to 2');

  addon.transport_seek(8.0);
  const delayed = addon.transport_getState();
  assertTransportShape(delayed, 'nonzero latency');
  ok(delayed.livePresentationLatencySamples > 0,
     `live presentation latency is nonzero (${delayed.livePresentationLatencySamples} samples)`);
  ok(delayed.livePresentationMasterLatencySamples > 0,
     `master latency contributes to live presentation (${delayed.livePresentationMasterLatencySamples} samples)`);
  ok(delayed.livePresentationDeviceOutputLatencySamples === 256,
     `device latency diagnostic uses override (got ${delayed.livePresentationDeviceOutputLatencySamples})`);
  ok(delayed.rawPositionSamples >= delayed.positionSamples,
     'rawPositionSamples is greater than or equal to presentation positionSamples');
  ok(delayed.rawPositionBeats >= delayed.positionBeats,
     'rawPositionBeats is greater than or equal to presentation positionBeats');
  ok(delayed.rawPositionMs >= delayed.positionMs,
     'rawPositionMs is greater than or equal to presentation positionMs');
  near(delayed.rawPositionSamples - delayed.positionSamples,
       delayed.livePresentationLatencySamples,
       1.0e-6,
       'presentation samples carry the engine-owned latency offset');
  assertPresentationConversions(delayed, 'nonzero latency');

  console.log('\n[ cleanup and reset ]');
  ok(addon.audio_removeMasterEffect(nodeId) === true,
     'audio_removeMasterEffect() returned true');
  ok(addon.audio_setTestDeviceOutputLatencySamplesForDiagnostics(0) === true,
     'device output latency override reset to zero for equality check');
  addon.transport_seek(8.0);
  const reset = addon.transport_getState();
  ok(reset.livePresentationLatencySamples === 0,
     `latency returns to zero after cleanup (got ${reset.livePresentationLatencySamples})`);
  near(reset.positionSamples, reset.rawPositionSamples, 1.0e-6,
       'cleanup restores raw/presentation equality');

  addon.audio_setTestDeviceOutputLatencySamplesForDiagnostics(-1);
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
  try {
    addon.audio_setTestDeviceOutputLatencySamplesForDiagnostics(-1);
    addon.shutdown();
  } catch (_) {
    // best-effort cleanup after a failing native call
  }
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
