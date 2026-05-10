'use strict';
//
// bridge/test_pdc_live_presentation_refresh.js - Stage 7C bridge smoke test
//
// Loads a Stage 7C scratch copy of the NO MAIL duplicate, adds Resonance
// Suppressor HQ to the individual KICK track, and verifies the bridge reports
// updated live presentation latency without stop/play/seek after the mutation.
//

const fs = require('fs');
const path = require('path');

const TRACK_ID = 959;
const TRACK_NAME = 'KICK';
const TRACK_TYPE = 'Clip';
const EXPECTED_RS_HQ_LATENCY = 2048;

const STAGE7A_SOURCE = 'C:\\Users\\Krasen\\Desktop\\XLETH\\diagnostics\\pdc-stage7a\\NO_MAIL_project_copy';
const SCRATCH_PROJECT = path.resolve(__dirname, '..', 'diagnostics', 'pdc-stage7c', 'NO_MAIL_bridge_smoke_copy');
const ORIGINAL_NO_MAIL = 'C:\\Users\\Krasen\\Desktop\\SR\\NO MAIL';

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
const result = {
  nativeConfig: native.config,
  sourceProject: STAGE7A_SOURCE,
  scratchProject: SCRATCH_PROJECT,
  originalNoMail: ORIGINAL_NO_MAIL,
  selectedTrack: { id: TRACK_ID, name: TRACK_NAME, type: TRACK_TYPE },
  assertions: [],
  limitations: [],
};

function ok(condition, label, detail = undefined) {
  total += 1;
  result.assertions.push({ ok: !!condition, label, detail });
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` (${detail})` : ''}`);
    failed += 1;
  }
}

function finiteNumber(value, label) {
  ok(typeof value === 'number' && Number.isFinite(value), `${label} is numeric`, String(value));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statPath(target) {
  if (!fs.existsSync(target)) return null;
  const stat = fs.statSync(target);
  return {
    exists: true,
    isDirectory: stat.isDirectory(),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mtimeIso: stat.mtime.toISOString(),
  };
}

function refreshScratchCopy() {
  if (!fs.existsSync(STAGE7A_SOURCE)) {
    throw new Error(`Stage 7A source duplicate is missing: ${STAGE7A_SOURCE}`);
  }
  if (!fs.existsSync(path.join(STAGE7A_SOURCE, 'project.json'))) {
    throw new Error(`Stage 7A source duplicate has no project.json: ${STAGE7A_SOURCE}`);
  }

  fs.rmSync(SCRATCH_PROJECT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(SCRATCH_PROJECT), { recursive: true });
  fs.cpSync(STAGE7A_SOURCE, SCRATCH_PROJECT, { recursive: true });
}

function cleanupScratchCopy() {
  if (process.env.XLETH_KEEP_STAGE7C_SCRATCH === '1') return;
  fs.rmSync(SCRATCH_PROJECT, { recursive: true, force: true });
}

function getNodeId(raw) {
  if (raw && typeof raw === 'object') return raw.nodeId;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw).nodeId; } catch (_) { return -1; }
  }
  return -1;
}

function parseJsonString(value, fallback, label) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (err) {
    result.limitations.push(`${label}: ${err.message}`);
    return fallback;
  }
}

function normalizeChain(raw) {
  const parsed = parseJsonString(raw, [], 'chain JSON parse');
  if (Array.isArray(parsed)) return { nodes: parsed, raw: parsed };
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.nodes)) return { nodes: parsed.nodes, raw: parsed };
    if (Array.isArray(parsed.chain)) return { nodes: parsed.chain, raw: parsed };
  }
  return { nodes: [], raw: parsed };
}

function getEffectParameters(trackId, nodeId) {
  if (typeof addon.audio_getEffectParameters !== 'function') return [];
  return parseJsonString(addon.audio_getEffectParameters(trackId, nodeId), [], `params ${trackId}:${nodeId}`);
}

function parameterValue(params, id) {
  const param = Array.isArray(params) ? params.find((p) => p && p.id === id) : null;
  if (!param) return undefined;
  if (typeof param.value === 'number') return param.value;
  if (typeof param.default === 'number') return param.default;
  return undefined;
}

function summarizeMasterChain() {
  const chain = normalizeChain(addon.audio_getMasterEffectChain());
  const rsNodes = chain.nodes.filter((node) => node && node.pluginId === 'resonancesuppressor');
  const rsDetails = rsNodes.map((node) => {
    let processingMode;
    let quality;
    try {
      const params = getEffectParameters(-1, node.nodeId);
      processingMode = parameterValue(params, 'processing_mode');
      quality = parameterValue(params, 'quality');
    } catch (err) {
      result.limitations.push(`master params unavailable for node ${node.nodeId}: ${err.message}`);
    }
    return {
      nodeId: node.nodeId,
      bypassed: node.bypassed === true,
      processingMode,
      quality,
      highQuality: processingMode === undefined ? undefined : processingMode >= 0.5,
    };
  });

  return {
    nodeCount: chain.nodes.length,
    resonanceSuppressorCount: rsNodes.length,
    resonanceSuppressorHighQualityCount: rsDetails.filter((node) => node.highQuality === true && !node.bypassed).length,
    resonanceSuppressors: rsDetails,
  };
}

function summarizeTrackChain(trackId) {
  const chain = normalizeChain(addon.audio_getEffectChain(trackId));
  return {
    nodeCount: chain.nodes.length,
    resonanceSuppressorCount: chain.nodes.filter((node) => node && node.pluginId === 'resonancesuppressor').length,
    nodes: chain.nodes.map((node) => ({
      nodeId: node.nodeId,
      pluginId: node.pluginId,
      bypassed: node.bypassed === true,
    })),
  };
}

function pickLatencyFields(label) {
  const telemetry = addon.getAudioPerformanceTelemetry();
  const transport = addon.transport_getState();
  const fields = {
    label,
    telemetry: {
      rawPositionSamples: telemetry.rawPositionSamples,
      presentationPositionSamples: telemetry.presentationPositionSamples,
      livePresentationLatencySamples: telemetry.livePresentationLatencySamples,
      maxAudibleTrackLatencySamples: telemetry.maxAudibleTrackLatencySamples,
      masterInsertLatencySamples: telemetry.masterInsertLatencySamples,
      audioDeviceOutputLatencySamples: telemetry.audioDeviceOutputLatencySamples,
      activeResonanceSuppressorHighQualityInstanceCount:
        telemetry.activeResonanceSuppressorHighQualityInstanceCount,
    },
    transport: {
      rawPositionSamples: transport.rawPositionSamples,
      presentationPositionSamples: transport.positionSamples,
      livePresentationLatencySamples: transport.livePresentationLatencySamples,
      maxAudibleTrackLatencySamples: transport.livePresentationMaxTrackLatencySamples,
      masterInsertLatencySamples: transport.livePresentationMasterLatencySamples,
      audioDeviceOutputLatencySamples: transport.livePresentationDeviceOutputLatencySamples,
      isPlaying: transport.isPlaying,
    },
  };

  for (const [key, value] of Object.entries(fields.telemetry)) {
    finiteNumber(value, `${label}.telemetry.${key}`);
  }
  for (const [key, value] of Object.entries(fields.transport)) {
    if (key !== 'isPlaying') finiteNumber(value, `${label}.transport.${key}`);
  }

  return fields;
}

function assertPresentationMath(snapshot, label) {
  const t = snapshot.telemetry;
  const expected = Math.max(0, t.rawPositionSamples - t.livePresentationLatencySamples);
  const delta = Math.abs(t.presentationPositionSamples - expected);
  ok(delta <= 4096,
     `${label}: presentationPositionSamples reflects raw minus live latency`,
     `expected ${expected}, got ${t.presentationPositionSamples}, delta ${delta}`);
}

async function main() {
  console.log(`=== xleth Stage 7C bridge PDC live-presentation smoke (${native.config}) ===\n`);

  result.originalBefore = statPath(ORIGINAL_NO_MAIL);
  result.stage7aProjectBefore = statPath(path.join(STAGE7A_SOURCE, 'project.json'));

  console.log('[ scratch copy ]');
  refreshScratchCopy();
  ok(fs.existsSync(path.join(SCRATCH_PROJECT, 'project.json')),
     'Stage 7C scratch copy has project.json');
  result.scratchProjectJson = statPath(path.join(SCRATCH_PROJECT, 'project.json'));

  console.log('\n[ initialize and load scratch project ]');
  ok(addon.initialize({ disablePreviewGpu: true }) === true, 'initialize() returns true');
  if (typeof addon.audio_setRealtimeDiagnosticsEnabled === 'function') {
    ok(addon.audio_setRealtimeDiagnosticsEnabled(true) === true, 'realtime diagnostics enabled');
  }

  const loaded = addon.project_load(SCRATCH_PROJECT);
  ok(loaded === true, 'project_load(Stage 7C scratch) returns true');

  const tracks = addon.timeline_getTracks();
  const kick = tracks.find((track) => track && track.id === TRACK_ID);
  ok(!!kick, `track ${TRACK_ID} exists`);
  ok(kick && kick.name === TRACK_NAME, `track ${TRACK_ID} is named ${TRACK_NAME}`, kick && kick.name);
  ok(kick && kick.type === TRACK_TYPE, `track ${TRACK_ID} is type ${TRACK_TYPE}`, kick && kick.type);

  const masterBefore = summarizeMasterChain();
  const kickChainBefore = summarizeTrackChain(TRACK_ID);
  result.masterBefore = masterBefore;
  result.kickChainBefore = kickChainBefore;
  ok(masterBefore.resonanceSuppressorCount === 1,
     'master chain exposes exactly one Resonance Suppressor before test mutation',
     JSON.stringify(masterBefore));
  if (masterBefore.resonanceSuppressorHighQualityCount === 0) {
    result.limitations.push('Master chain parameters did not expose an active HQ RS count; telemetry and latency fields are still checked.');
  } else {
    ok(masterBefore.resonanceSuppressorHighQualityCount === 1,
       'master chain exposes exactly one active RS HQ before test mutation',
       JSON.stringify(masterBefore));
  }
  ok(kickChainBefore.resonanceSuppressorCount === 0,
     'KICK has no Resonance Suppressor before test mutation',
     JSON.stringify(kickChainBefore));

  console.log('\n[ simulated live transport baseline ]');
  addon.transport_seek(64.0);
  await delay(50);
  const baseline = pickLatencyFields('baseline');
  result.baseline = baseline;
  ok(baseline.telemetry.rawPositionSamples > 0,
     'transport raw position is nonzero before mutation');
  assertPresentationMath(baseline, 'baseline');

  console.log('\n[ mutate KICK only: add RS HQ ]');
  const addPosition = kickChainBefore.nodeCount;
  const nodeId = getNodeId(addon.audio_addEffect(TRACK_ID, 'resonancesuppressor', addPosition));
  result.addedTrackNodeId = nodeId;
  ok(nodeId >= 0, `audio_addEffect(${TRACK_ID}, "resonancesuppressor", ${addPosition}) returned nodeId=${nodeId}`);
  ok(addon.audio_setEffectParameter(TRACK_ID, nodeId, 'processing_mode', 1.0) === true,
     'KICK RS processing_mode set to High Quality');
  ok(addon.audio_setEffectParameter(TRACK_ID, nodeId, 'quality', 2.0) === true,
     'KICK RS quality set to High');

  const post = pickLatencyFields('postMutation');
  const masterAfter = summarizeMasterChain();
  const kickChainAfter = summarizeTrackChain(TRACK_ID);
  result.postMutation = post;
  result.masterAfter = masterAfter;
  result.kickChainAfter = kickChainAfter;

  console.log('\n[ assertions ]');
  ok(post.telemetry.livePresentationLatencySamples > baseline.telemetry.livePresentationLatencySamples,
     'livePresentationLatencySamples increases immediately after KICK RS HQ mutation',
     `${baseline.telemetry.livePresentationLatencySamples} -> ${post.telemetry.livePresentationLatencySamples}`);
  ok(post.telemetry.maxAudibleTrackLatencySamples >= EXPECTED_RS_HQ_LATENCY,
     'maxAudibleTrackLatencySamples reflects the KICK RS HQ insert latency',
     `got ${post.telemetry.maxAudibleTrackLatencySamples}`);
  ok(post.telemetry.maxAudibleTrackLatencySamples >= baseline.telemetry.maxAudibleTrackLatencySamples,
     'maxAudibleTrackLatencySamples does not drop after KICK mutation',
     `${baseline.telemetry.maxAudibleTrackLatencySamples} -> ${post.telemetry.maxAudibleTrackLatencySamples}`);
  ok(post.telemetry.masterInsertLatencySamples === baseline.telemetry.masterInsertLatencySamples,
     'masterInsertLatencySamples remains counted once',
     `${baseline.telemetry.masterInsertLatencySamples} -> ${post.telemetry.masterInsertLatencySamples}`);
  ok(post.telemetry.rawPositionSamples >= baseline.telemetry.rawPositionSamples,
     'rawPositionSamples remains raw and monotonic after mutation',
     `${baseline.telemetry.rawPositionSamples} -> ${post.telemetry.rawPositionSamples}`);
  assertPresentationMath(post, 'postMutation');
  ok(post.telemetry.activeResonanceSuppressorHighQualityInstanceCount
       > baseline.telemetry.activeResonanceSuppressorHighQualityInstanceCount,
     'active RS HQ count increases when exposed',
     `${baseline.telemetry.activeResonanceSuppressorHighQualityInstanceCount} -> ${post.telemetry.activeResonanceSuppressorHighQualityInstanceCount}`);
  ok(masterAfter.nodeCount === masterBefore.nodeCount,
     'master node count is unchanged by the test',
     `${masterBefore.nodeCount} -> ${masterAfter.nodeCount}`);
  ok(masterAfter.resonanceSuppressorCount === masterBefore.resonanceSuppressorCount,
     'no Resonance Suppressor was added to master by the test',
     `${masterBefore.resonanceSuppressorCount} -> ${masterAfter.resonanceSuppressorCount}`);
  ok(kickChainAfter.resonanceSuppressorCount === kickChainBefore.resonanceSuppressorCount + 1,
     'exactly one Resonance Suppressor was added to KICK',
     `${kickChainBefore.resonanceSuppressorCount} -> ${kickChainAfter.resonanceSuppressorCount}`);

  result.originalAfter = statPath(ORIGINAL_NO_MAIL);
  result.stage7aProjectAfter = statPath(path.join(STAGE7A_SOURCE, 'project.json'));
  ok(JSON.stringify(result.originalAfter) === JSON.stringify(result.originalBefore),
     'original NO MAIL directory stat unchanged during smoke test');
  ok(JSON.stringify(result.stage7aProjectAfter) === JSON.stringify(result.stage7aProjectBefore),
     'Stage 7A source duplicate project.json stat unchanged during smoke test');

  addon.shutdown();
  cleanupScratchCopy();

  console.log('\n[ result json ]');
  console.log(JSON.stringify(result, null, 2));
  console.log('\n' + '-'.repeat(50));
  console.log(`PASSED: ${passed}/${total} tests`);
  if (failed > 0) {
    console.error(`FAILED: ${failed}/${total} tests`);
    process.exit(1);
  }
}

main().catch((err) => {
  result.error = err && err.stack ? err.stack : String(err);
  try { addon.shutdown(); } catch (_) {}
  console.error('\nUnhandled error:', err);
  console.error('\n[ result json ]');
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
});
