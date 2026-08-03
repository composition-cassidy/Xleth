'use strict';
//
// bridge/test_delay_stereo_mode.js - Delay stereo_mode bridge contract test
//
// Verifies, through the SAME native entry points the renderer uses
// (audio_getEffectParameters / audio_setEffectParameter):
// - stereo_mode is exposed with range 0..2 and default 1 (Dual)
// - a fresh delay instance reports Dual, so existing sessions are unchanged
// - set/get round-trips for Single (0), Dual (1) and PingPong (2)
// - out-of-range writes clamp instead of corrupting the value
// - stereo_mode survives project save/load
// - a legacy project state with NO stereo_mode node restores as Dual
// - the pre-existing delay params still round-trip alongside it
//
// Run after rebuilding the native addon:
//   node bridge/test_delay_stereo_mode.js
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

function near(actual, expected, tol, label) {
  ok(Math.abs(actual - expected) <= tol,
     `${label} (expected ~${expected}, got ${actual}, tol +/-${tol})`);
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

function getParams(nodeId) {
  return parseJson(addon.audio_getEffectParameters(-1, nodeId), 'audio_getEffectParameters');
}

function findParam(params, id) {
  return Array.isArray(params) ? params.find((p) => p.id === id) : null;
}

function getParamValue(nodeId, id) {
  const p = findParam(getParams(nodeId), id);
  return p ? p.value : undefined;
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

// Removes the stereo_mode PARAM node from a saved APVTS state blob, producing
// exactly what a project saved before this parameter existed would contain.
function stripStereoModeFromStateBlob(base64State) {
  const stateText = Buffer.from(base64State, 'base64').toString('latin1');
  const updatedText = stateText.replace(/<PARAM[^>]*id="stereo_mode"[^>]*\/>/, '');
  return {
    changed: updatedText !== stateText,
    base64: Buffer.from(updatedText, 'latin1').toString('base64'),
  };
}

// Pre-existing delay params, re-checked so the new one did not disturb them.
const LEGACY_PARAMS = [
  ['time_l',       320,   0.5],
  ['time_r',       480,   0.5],
  ['sync',         0,     0.01],
  ['sync_div_l',   7,     0.01],
  ['sync_div_r',   3,     0.01],
  ['feedback',     55,    0.5],
  ['filter_lo',    180,   1.0],
  ['filter_hi',    9000,  50.0],
  ['mod_rate',     1.25,  0.05],
  ['mod_depth',    40,    0.5],
  ['stereo_width', 65,    0.5],
  ['duck_amount',  25,    0.5],
  ['mix',          80,    0.5],
];

const PROJ_DIR = path.join(os.tmpdir(), '_xleth_delay_stereo_mode_test');

(async () => {
  console.log('=== Delay stereo_mode bridge contract test ===\n');

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
  ok(addon.project_create(PROJ_DIR, 'DelayStereoModeTest') === true, 'project_create() returns true');

  console.log('\n[ instantiation + parameter enumeration ]');
  const nodeId = getNodeId(addon.audio_addMasterEffect('delay', 0));
  ok(nodeId >= 0, `audio_addMasterEffect("delay") -> nodeId=${nodeId}`);
  if (nodeId < 0) process.exit(1);

  const params = getParams(nodeId);
  ok(Array.isArray(params), 'audio_getEffectParameters returns an array');
  if (!Array.isArray(params)) process.exit(1);

  const sm = findParam(params, 'stereo_mode');
  ok(!!sm, 'stereo_mode is exposed through audio_getEffectParameters');
  if (sm) {
    near(sm.min, 0, 1e-6, 'stereo_mode.min');
    near(sm.max, 2, 1e-6, 'stereo_mode.max');
    near(sm.default, 1, 1e-6, 'stereo_mode.default is Dual');
    near(sm.value, 1, 1e-6, 'fresh instance reports Dual (existing projects unchanged)');
  }

  console.log('\n[ set/get round-trip ]');
  for (const [label, value] of [['Single', 0], ['PingPong', 2], ['Dual', 1]]) {
    const setOk = addon.audio_setEffectParameter(-1, nodeId, 'stereo_mode', value);
    ok(setOk === true, `audio_setEffectParameter("stereo_mode", ${value}) -> true`);
    near(getParamValue(nodeId, 'stereo_mode'), value, 1e-3, `stereo_mode reads back ${label}`);
  }

  console.log('\n[ out-of-range clamping ]');
  addon.audio_setEffectParameter(-1, nodeId, 'stereo_mode', 7);
  near(getParamValue(nodeId, 'stereo_mode'), 2, 1e-3, 'stereo_mode clamps 7 -> 2');
  addon.audio_setEffectParameter(-1, nodeId, 'stereo_mode', -4);
  near(getParamValue(nodeId, 'stereo_mode'), 0, 1e-3, 'stereo_mode clamps -4 -> 0');

  console.log('\n[ pre-existing params still round-trip ]');
  for (const [id, value, tol] of LEGACY_PARAMS) {
    ok(addon.audio_setEffectParameter(-1, nodeId, id, value) === true,
       `audio_setEffectParameter("${id}", ${value}) -> true`);
  }
  {
    const after = getParams(nodeId);
    for (const [id, value, tol] of LEGACY_PARAMS) {
      const got = findParam(after, id)?.value;
      near(got, value, tol, `"${id}" round-trips`);
    }
  }

  console.log('\n[ save / load persistence ]');
  addon.audio_setEffectParameter(-1, nodeId, 'stereo_mode', 2);
  ok(addon.project_save() === true, 'project_save() returns true');

  const projectPath = path.join(PROJ_DIR, 'project.json');
  ok(fs.existsSync(projectPath), 'project.json exists on disk');

  ok(addon.project_load(PROJ_DIR) === true, 'project_load() returns true');
  {
    const chain = parseJson(addon.audio_getMasterEffectChain(), 'audio_getMasterEffectChain');
    const entry = Array.isArray(chain) ? chain.find((e) => e.pluginId === 'delay') : null;
    ok(!!entry, 'delay survives project reload');
    if (entry) {
      near(getParamValue(entry.nodeId, 'stereo_mode'), 2, 1e-3,
           'stereo_mode = PingPong survives save/load');
    }
  }

  console.log('\n[ legacy project migration (no stereo_mode node) ]');
  {
    const projectRaw = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
    const stateNode = findEffectStateNode(projectRaw, 'delay');
    ok(!!stateNode, 'found the delay effect state blob inside project.json');

    if (stateNode) {
      const stripped = stripStereoModeFromStateBlob(stateNode.state);
      ok(stripped.changed, 'stereo_mode PARAM node was present and removed from the blob');
      stateNode.state = stripped.base64;
      fs.writeFileSync(projectPath, JSON.stringify(projectRaw, null, 2), 'utf8');

      ok(addon.project_load(PROJ_DIR) === true, 'project_load() of the legacy state returns true');
      const chain = parseJson(addon.audio_getMasterEffectChain(), 'audio_getMasterEffectChain');
      const entry = Array.isArray(chain) ? chain.find((e) => e.pluginId === 'delay') : null;
      ok(!!entry, 'delay still loads from the legacy state');
      if (entry) {
        near(getParamValue(entry.nodeId, 'stereo_mode'), 1, 1e-3,
             'legacy state with no stereo_mode restores as Dual (behaviour preserved)');
      }
    }
  }

  console.log('\n[ fresh instance default after migration ]');
  {
    const freshId = getNodeId(addon.audio_addMasterEffect('delay', 0));
    ok(freshId >= 0, `fresh audio_addMasterEffect("delay") -> nodeId=${freshId}`);
    if (freshId >= 0) {
      near(getParamValue(freshId, 'stereo_mode'), 1, 1e-3,
           'a delay added after a legacy load still defaults to Dual');
    }
  }

  console.log(`\n${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed}/${total} tests`);
  process.exit(failed > 0 ? 1 : 0);
})();
