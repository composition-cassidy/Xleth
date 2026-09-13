'use strict';
//
// bridge/test_eq_channel_routing.js - EQ per-band channel routing bridge contract
//
// The renderer reaches channel routing through the SAME generic band-param
// entry point every other EQ control uses (audio_eqSetBandParam with the
// paramName "channel"). Because every layer of that path is optional-chained
// (window.xleth?.audio?.eqSetBandParam), a missing export or a swallowed name
// would look exactly like "the UI works but nothing happens". This test proves
// the call actually lands in the APVTS by reading it back via eqGetBands.
//
// Covers:
// - eqGetBands exposes a numeric `channel` field
// - a fresh band defaults to 0 (Stereo), so pre-routing projects are unchanged
// - set/read round-trips for all five modes (0..4)
// - out-of-range writes clamp instead of corrupting the value
// - routing survives project save/load
// - a band removed from the middle carries its routing with the swapped-in band
// - routing is NOT latency-affecting
//
// Run after rebuilding the native addon:
//   node bridge/test_eq_channel_routing.js
//

const fs = require('fs');
const os = require('os');
const path = require('path');

const dllDir = path.resolve(__dirname, 'build/Release');
process.env.PATH = `${dllDir};${process.env.PATH}`;

const addon = require('./build/Release/xleth_native.node');

let passed = 0;
let failed = 0;
let total = 0;

function ok(cond, label) {
  total += 1;
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed += 1;
  } else {
    console.error(`  FAIL  ${label}`);
    failed += 1;
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    ok(false, `${label} returns valid JSON (${err.message})`);
    return null;
  }
}

function getNodeId(raw) {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw).nodeId; } catch (_) { return -1; }
  }
  if (raw && typeof raw === 'object') return raw.nodeId;
  if (typeof raw === 'number') return raw;
  return -1;
}

// Master bus effects use trackId -1 (see getEQ in XlethEngineService.cpp).
const TRACK = -1;

function getBands(nodeId) {
  return parseJson(addon.audio_eqGetBands(TRACK, nodeId), 'audio_eqGetBands') || [];
}

function getChannel(nodeId, bandIndex) {
  const b = getBands(nodeId)[bandIndex];
  return b ? b.channel : undefined;
}

function findEffectStateNode(root, pluginId) {
  if (!root || typeof root !== 'object') return null;
  if (!Array.isArray(root) && root.pluginId === pluginId && typeof root.state === 'string')
    return root;
  const values = Array.isArray(root) ? root : Object.values(root);
  for (const value of values) {
    const found = findEffectStateNode(value, pluginId);
    if (found) return found;
  }
  return null;
}

// Removes one PARAM node from a saved APVTS state blob, producing exactly what
// a project saved before that parameter existed would contain.
function stripParamFromStateBlob(base64State, paramId) {
  const stateText = Buffer.from(base64State, 'base64').toString('latin1');
  const re = new RegExp(`<PARAM[^>]*id="${paramId}"[^>]*/>`);
  const updatedText = stateText.replace(re, '');
  return {
    changed: updatedText !== stateText,
    base64: Buffer.from(updatedText, 'latin1').toString('base64'),
  };
}

// Must mirror CHANNEL_MODES in ui/src/stores/eqStore.js and
// XlethParametricEQ::ChannelMode.
const CHANNEL_MODES = ['stereo', 'left', 'right', 'mid', 'side'];

const PROJ_DIR = path.join(os.tmpdir(), '_xleth_eq_channel_routing_test');

(async () => {
  console.log('=== EQ channel routing bridge contract test ===\n');

  let initOk = false;
  try {
    initOk = addon.initialize();
  } catch (err) {
    console.error(`Engine init failed: ${err.message}`);
    console.error('SKIPPING - this test needs an audio device.');
    process.exit(0);
  }
  ok(initOk === true, 'initialize() returns true');

  if (fs.existsSync(PROJ_DIR)) fs.rmSync(PROJ_DIR, { recursive: true, force: true });
  ok(addon.project_create(PROJ_DIR, 'EqChannelRoutingTest') === true,
     'project_create() returns true');

  console.log('\n[ the channel field exists and defaults to Stereo ]');
  const nodeId = getNodeId(addon.audio_addMasterEffect('xletheq', 0));
  ok(nodeId >= 0, `audio_addMasterEffect("xletheq") -> nodeId=${nodeId}`);
  if (nodeId < 0) process.exit(1);

  ok(addon.audio_eqAddBand(TRACK, nodeId) === 0, 'audio_eqAddBand() -> band 0');

  const firstBand = getBands(nodeId)[0];
  ok(firstBand != null, 'audio_eqGetBands() reports the new band');
  ok(firstBand && typeof firstBand.channel === 'number',
     `band JSON exposes a numeric channel field (got ${firstBand && typeof firstBand.channel})`);
  ok(firstBand && firstBand.channel === 0,
     `a fresh band defaults to Stereo (0) - old projects unchanged (got ${firstBand && firstBand.channel})`);

  console.log('\n[ set/read round-trip through the generic band-param path ]');
  // This is the load-bearing check: the whole renderer -> preload -> worker ->
  // addon chain is optional-chained, so a silently-dropped call is invisible
  // from the UI. If the value does not come back, the wiring is broken.
  for (let value = 0; value < CHANNEL_MODES.length; value++) {
    const wrote = addon.audio_eqSetBandParam(TRACK, nodeId, 0, 'channel', value);
    ok(wrote === true, `audio_eqSetBandParam(..., "channel", ${value}) returns true`);
    ok(getChannel(nodeId, 0) === value,
       `channel reads back as ${value} (${CHANNEL_MODES[value]}) - the call reached the APVTS`);
  }

  console.log('\n[ out-of-range writes clamp ]');
  addon.audio_eqSetBandParam(TRACK, nodeId, 0, 'channel', 99);
  ok(getChannel(nodeId, 0) === 4, `channel 99 clamps to 4 (got ${getChannel(nodeId, 0)})`);
  addon.audio_eqSetBandParam(TRACK, nodeId, 0, 'channel', -5);
  ok(getChannel(nodeId, 0) === 0, `channel -5 clamps to 0 (got ${getChannel(nodeId, 0)})`);

  console.log('\n[ routing is not latency-affecting ]');
  addon.audio_eqSetBandParam(TRACK, nodeId, 0, 'channel', 0);
  const latBefore = addon.audio_getEffectLatency(TRACK, nodeId).latencySamples;
  addon.audio_eqSetBandParam(TRACK, nodeId, 0, 'channel', 3);
  const latAfter = addon.audio_getEffectLatency(TRACK, nodeId).latencySamples;
  ok(latBefore === latAfter,
     `changing channel must not change latency (${latBefore} -> ${latAfter})`);

  console.log('\n[ remove-band swap carries routing with the band ]');
  // removeBand swaps the LAST band into the removed slot, so band 1's routing
  // must follow it down to index 0.
  ok(addon.audio_eqAddBand(TRACK, nodeId) === 1, 'audio_eqAddBand() -> band 1');
  addon.audio_eqSetBandParam(TRACK, nodeId, 0, 'channel', 1);  // Left
  addon.audio_eqSetBandParam(TRACK, nodeId, 1, 'channel', 4);  // Side
  ok(addon.audio_eqRemoveBand(TRACK, nodeId, 0) === true, 'audio_eqRemoveBand(0) returns true');
  ok(getChannel(nodeId, 0) === 4,
     `the swapped-in band keeps its Side routing (got ${getChannel(nodeId, 0)})`);

  console.log('\n[ routing survives save/load ]');
  addon.audio_eqSetBandParam(TRACK, nodeId, 0, 'channel', 3);  // Mid
  ok(addon.project_save() === true, 'project_save() returns true');
  ok(addon.project_load(PROJ_DIR) === true, 'project_load() returns true');

  // Re-resolve the node: ids are stable across a load of the same project, but
  // read the chain back rather than assuming.
  const reloaded = getBands(nodeId);
  if (reloaded.length === 0) {
    ok(false, 'EQ band survives project reload (no bands reported after load)');
  } else {
    ok(reloaded[0].channel === 3,
       `channel survives save/load as Mid (3) (got ${reloaded[0].channel})`);
  }

  console.log('\n[ legacy project with no channel node restores as Stereo ]');
  // Projects saved before routing existed have no b0_channel PARAM in their
  // APVTS blob. Those must come back as Stereo, i.e. behave exactly as they did.
  {
    const projectPath = path.join(PROJ_DIR, 'project.json');
    ok(fs.existsSync(projectPath), 'project.json exists on disk');

    const projectRaw = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
    const stateNode = findEffectStateNode(projectRaw, 'xletheq');
    ok(!!stateNode, 'found the xletheq effect state blob inside project.json');

    if (stateNode) {
      const stripped = stripParamFromStateBlob(stateNode.state, 'b0_channel');
      ok(stripped.changed, 'b0_channel PARAM node was present and removed from the blob');
      stateNode.state = stripped.base64;
      fs.writeFileSync(projectPath, JSON.stringify(projectRaw, null, 2), 'utf8');

      ok(addon.project_load(PROJ_DIR) === true,
         'project_load() of the legacy state returns true');
      const legacy = getBands(nodeId);
      if (legacy.length === 0) {
        ok(false, 'EQ band still loads from the legacy state');
      } else {
        ok(legacy[0].channel === 0,
           `legacy state with no channel node restores as Stereo (got ${legacy[0].channel})`);
      }
    }
  }

  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
