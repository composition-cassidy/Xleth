'use strict';

const fs = require('fs');
const path = require('path');

function findAddon() {
  for (const config of ['Release', 'Debug']) {
    const addonPath = path.resolve(__dirname, 'build', config, 'xleth_native.node');
    if (fs.existsSync(addonPath)) return addonPath;
  }
  throw new Error('xleth_native.node not found in bridge/build/Debug or bridge/build/Release');
}

const addonPath = findAddon();
process.env.PATH = path.dirname(addonPath) + ';' + process.env.PATH;
const addon = require(addonPath);

let passed = 0;
let failed = 0;

function ok(condition, label) {
  if (condition) {
    passed++;
    console.log(`PASS ${label}`);
  } else {
    failed++;
    console.error(`FAIL ${label}`);
  }
}

function trackById(id) {
  return addon.timeline_getTracks().find((track) => track.id === id);
}

try {
  ok(addon.initialize({ disablePreviewGpu: true }) === true, 'initialize');
  const projectDir = path.resolve(__dirname, '_test_fx_mode');
  fs.rmSync(projectDir, { recursive: true, force: true });
  ok(addon.project_create(projectDir, 'FxModeBridgeTest') === true, 'project_create');

  const trackId = addon.timeline_addTrack({ name: 'FX Mode Track', volume: 1.0, order: 0 });
  ok(typeof trackId === 'number' && trackId > 0, 'timeline_addTrack');
  ok(trackById(trackId).fxMode === 'chain', 'new track payload defaults to chain');

  ok(addon.timeline_setTrackFxMode(trackId, 'graph') === true, 'set fxMode graph returns true');
  ok(trackById(trackId).fxMode === 'graph', 'track payload updates to graph');

  ok(addon.timeline_setTrackFxMode(trackId, 'chain') === true, 'set fxMode chain returns true');
  ok(trackById(trackId).fxMode === 'chain', 'track payload updates to chain');

  ok(addon.timeline_setTrackFxMode(trackId, 'invalid') === true, 'invalid fxMode safely clamps');
  ok(trackById(trackId).fxMode === 'chain', 'invalid fxMode payload is chain');

  const graphState = {
    schemaVersion: 1,
    trackId: String(trackId),
    nodes: 'renderer-owned opaque payload',
    edges: [{ sourceNodeId: 'not validated in bridge' }],
  };
  ok(addon.timeline_setTrackGraphState(trackId, graphState) === true, 'set graphState returns true');
  const storedGraphState = trackById(trackId).graphState;
  ok(
    storedGraphState.schemaVersion === graphState.schemaVersion &&
      storedGraphState.trackId === graphState.trackId &&
      storedGraphState.nodes === graphState.nodes &&
      storedGraphState.edges[0].sourceNodeId === graphState.edges[0].sourceNodeId,
    'track payload includes opaque graphState'
  );

  ok(addon.timeline_setTrackGraphState(trackId, null) === true, 'clear graphState returns true');
  ok(!Object.prototype.hasOwnProperty.call(trackById(trackId), 'graphState'), 'missing graphState is omitted safely');

  ok(addon.timeline_setTrackGraphState(999999, graphState) === false, 'missing track graphState returns false');
  ok(addon.timeline_setTrackFxMode(999999, 'graph') === false, 'missing track returns false');

  addon.shutdown();
  fs.rmSync(projectDir, { recursive: true, force: true });

  if (failed > 0) process.exit(1);
  console.log(`PASSED: ${passed}/${passed + failed}`);
} catch (error) {
  try { addon.shutdown(); } catch (_) {}
  console.error(error);
  process.exit(1);
}
