'use strict';
//
// bridge/test_resonancesuppressor.js - Resonance Suppressor bridge smoke test
//
// Verifies:
// - effect instantiation through the native addon
// - all parameters are exposed, including processing_mode
// - new instances default to Low Latency
// - set/get round-trips work for every parameter
// - HQ-only quality/viz paths still work
// - save/load preserves representative values
// - legacy states missing processing_mode restore as High Quality
// - a fresh instance added after migration still defaults to Low Latency
//
// Run after rebuilding the native addon:
//   node bridge/test_resonancesuppressor.js
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

function eq(actual, expected, label) {
  ok(actual === expected,
     `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
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
    try {
      return JSON.parse(raw).nodeId;
    } catch (_) {
      return -1;
    }
  }
  if (raw && typeof raw === 'object') return raw.nodeId;
  if (typeof raw === 'number') return raw;
  return -1;
}

function getParams(nodeId) {
  return parseJson(addon.audio_getEffectParameters(-1, nodeId), 'audio_getEffectParameters');
}

function findParam(params, id) {
  return Array.isArray(params)
    ? params.find((p) => (p.id ?? p.paramId ?? p.name) === id)
    : null;
}

function paramValue(param) {
  return param ? (param.value ?? param.currentValue ?? param.defaultValue) : undefined;
}

function getParamValue(nodeId, id) {
  const params = getParams(nodeId);
  const param = findParam(params, id);
  return paramValue(param);
}

function getMasterResonanceEffect() {
  const chain = parseJson(addon.audio_getMasterEffectChain(), 'audio_getMasterEffectChain');
  ok(Array.isArray(chain), 'audio_getMasterEffectChain() returns an array');
  if (!Array.isArray(chain)) return null;
  return chain.find((entry) => entry.pluginId === 'resonancesuppressor') ?? null;
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

function stripProcessingModeFromStateBlob(base64State) {
  const stateText = Buffer.from(base64State, 'base64').toString('latin1');
  const updatedText = stateText.replace(/<PARAM[^>]*id="processing_mode"[^>]*\/>/, '');
  return {
    changed: updatedText !== stateText,
    base64: Buffer.from(updatedText, 'latin1').toString('base64'),
  };
}

// All 55 params: [id, testValue, tolerance]
const PARAMS = [
  ['depth',           75,     0.5],
  ['sharpness',       30,     0.5],
  ['selectivity',     80,     0.5],
  ['attack',          50,     0.5],
  ['release',         500,    1.0],
  ['mix',             60,     0.5],
  ['trim',            -3,     0.1],
  ['delta',           1,      0.01],
  ['processing_mode', 1,      0.01],
  ['quality',         2,      0.01],
  ['stereo_link',     50,     0.5],
  ['stereo_mode',     1,      0.01],
  ['mode',            1,      0.01],
  ['wc_hp',           120,    1.0],
  ['wc_lp',           14000,  100],
  ['wc_b1_freq',      400,    5.0],
  ['wc_b1_gain',      3,      0.1],
  ['wc_b2_freq',      1200,   10.0],
  ['wc_b2_gain',      -2,     0.1],
  ['wc_b3_freq',      4000,   20.0],
  ['wc_b3_gain',      1.5,    0.1],
  ['wc_b4_freq',      12000,  50.0],
  ['wc_b4_gain',      -1,     0.1],

  ['wc_b1_active',    0,      0.01],
  ['wc_b1_type',      2,      0.01],
  ['wc_b1_q',         1.5,    0.05],

  ['wc_b2_active',    0,      0.01],
  ['wc_b2_type',      1,      0.01],
  ['wc_b2_q',         2.0,    0.05],

  ['wc_b3_active',    1,      0.01],
  ['wc_b3_type',      0,      0.01],
  ['wc_b3_q',         0.5,    0.05],

  ['wc_b4_active',    1,      0.01],
  ['wc_b4_type',      4,      0.01],
  ['wc_b4_q',         3.0,    0.05],

  ['wc_b5_active',    1,      0.01],
  ['wc_b5_type',      3,      0.01],
  ['wc_b5_freq',      700,    10.0],
  ['wc_b5_gain',      3.5,    0.1],
  ['wc_b5_q',         1.0,    0.05],

  ['wc_b6_active',    0,      0.01],
  ['wc_b6_type',      2,      0.01],
  ['wc_b6_freq',      2000,   20.0],
  ['wc_b6_gain',      -4.0,   0.1],
  ['wc_b6_q',         1.5,    0.05],

  ['wc_b7_active',    1,      0.01],
  ['wc_b7_type',      1,      0.01],
  ['wc_b7_freq',      5000,   50.0],
  ['wc_b7_gain',      6.0,    0.1],
  ['wc_b7_q',         0.75,   0.05],

  ['wc_b8_active',    0,      0.01],
  ['wc_b8_type',      0,      0.01],
  ['wc_b8_freq',      12000,  100.0],
  ['wc_b8_gain',      -2.5,   0.1],
  ['wc_b8_q',         2.0,    0.05],
];

const PROJ_DIR = path.join(os.tmpdir(), '_xleth_rs_test');
const PROJECT_JSON = path.join(PROJ_DIR, 'project.json');

(async () => {
  console.log('=== Resonance Suppressor bridge smoke test ===\n');

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
  const created = addon.project_create(PROJ_DIR, 'RSTest');
  ok(created === true, 'project_create() returns true');

  console.log('\n[ instantiation ]');
  const nodeId = getNodeId(addon.audio_addMasterEffect('resonancesuppressor', 0));
  ok(nodeId >= 0, `audio_addMasterEffect("resonancesuppressor") -> nodeId=${nodeId}`);
  if (nodeId < 0) process.exit(1);

  console.log('\n[ parameter enumeration ]');
  const params = getParams(nodeId);
  ok(Array.isArray(params), 'params is an array');
  if (!Array.isArray(params)) process.exit(1);
  eq(params.length, 55, 'param count == 55');

  const paramIds = new Set(params.map((p) => p.id ?? p.paramId ?? p.name));
  for (const [id] of PARAMS) ok(paramIds.has(id), `param "${id}" present`);

  const processingModeParam = findParam(params, 'processing_mode');
  ok(!!processingModeParam, 'processing_mode param is exposed');
  ok(Math.abs(paramValue(processingModeParam) - 0) <= 0.01,
     `new instance defaults to Low Latency (got ${paramValue(processingModeParam)})`);

  console.log('\n[ parameter set/get round-trip ]');
  for (const [id, testVal] of PARAMS) {
    const setOk = addon.audio_setEffectParameter(-1, nodeId, id, testVal);
    ok(setOk === true, `setEffectParameter("${id}", ${testVal}) -> true`);
  }

  const afterParams = getParams(nodeId);
  if (Array.isArray(afterParams)) {
    for (const [id, testVal, tol] of PARAMS) {
      const p = findParam(afterParams, id);
      const v = paramValue(p);
      ok(!!p && Math.abs(v - testVal) <= tol,
         `param "${id}" round-trips: expected ~${testVal}, got ${v} (tol +/-${tol})`);
    }
  }

  console.log('\n[ High Quality controls ]');
  ok(addon.audio_setEffectParameter(-1, nodeId, 'processing_mode', 1) === true,
     'processing_mode can switch to High Quality');
  for (const q of [0, 1, 2]) {
    const setOk = addon.audio_setEffectParameter(-1, nodeId, 'quality', q);
    ok(setOk === true, `setEffectParameter("quality", ${q}) -> true`);
    const got = getParamValue(nodeId, 'quality');
    ok(Math.abs(got - q) <= 0.01, `quality ${q} round-trips in High Quality mode (got ${got})`);
  }

  console.log('\n[ meter slots ]');
  const meters = parseJson(addon.audio_getEffectMeter(-1, nodeId), 'audio_getEffectMeter');
  ok(meters !== null, 'audio_getEffectMeter returns valid JSON');
  const hasSlot = (slots, idx) => {
    if (Array.isArray(slots)) return slots.length > idx && typeof slots[idx] === 'number';
    if (slots && typeof slots === 'object') return typeof (slots[idx] ?? slots[`slot${idx}`]) === 'number';
    return false;
  };
  ok(hasSlot(meters, 0), 'meter slot 0 (PEAK_L) is numeric');
  ok(hasSlot(meters, 1), 'meter slot 1 (PEAK_R) is numeric');
  ok(hasSlot(meters, 2), 'meter slot 2 (GAIN_REDUCTION) is numeric');

  console.log('\n[ visualization contract ]');
  if (typeof addon.audio_setEffectVisualizationEnabled === 'function'
      && typeof addon.audio_drainEffectVizFrames === 'function') {
    ok(addon.audio_setEffectParameter(-1, nodeId, 'processing_mode', 1) === true,
       'visualization test can force High Quality mode');
    ok(addon.audio_setEffectParameter(-1, nodeId, 'quality', 1) === true,
       'visualization test can force Normal HQ quality');
    const enableViz = addon.audio_setEffectVisualizationEnabled(-1, nodeId, true);
    ok(enableViz === true, 'audio_setEffectVisualizationEnabled(true) -> true');
    const viz = addon.audio_drainEffectVizFrames(-1, nodeId, 4);
    ok(viz && typeof viz === 'object', 'audio_drainEffectVizFrames returns an object');
    ok(viz.type === 'resonance', `viz type is resonance (got ${viz && viz.type})`);
    ok(viz.schema === 2, `viz schema is 2 (got ${viz && viz.schema})`);
    ok(viz.bucketSize === 1584, `viz bucketSize is 1584 (got ${viz && viz.bucketSize})`);
    ok(typeof viz.count === 'number', 'viz count is numeric');
    const disableViz = addon.audio_setEffectVisualizationEnabled(-1, nodeId, false);
    ok(disableViz === true, 'audio_setEffectVisualizationEnabled(false) -> true');
  } else {
    ok(false, 'generic visualization bridge APIs are present');
  }

  console.log('\n[ save/load round-trip ]');
  addon.audio_setEffectParameter(-1, nodeId, 'processing_mode', 1);
  addon.audio_setEffectParameter(-1, nodeId, 'depth', 77);
  addon.audio_setEffectParameter(-1, nodeId, 'wc_b1_active', 0);
  addon.audio_setEffectParameter(-1, nodeId, 'wc_b1_type', 2);
  addon.audio_setEffectParameter(-1, nodeId, 'wc_b1_q', 2.5);
  addon.audio_setEffectParameter(-1, nodeId, 'wc_b5_active', 1);
  addon.audio_setEffectParameter(-1, nodeId, 'wc_b5_freq', 888);
  addon.audio_setEffectParameter(-1, nodeId, 'wc_b5_gain', 4.0);
  addon.audio_setEffectParameter(-1, nodeId, 'wc_b5_q', 0.75);
  const saveOk = addon.project_save();
  ok(saveOk === true || saveOk === undefined, 'project_save() does not throw');

  const loadOk = addon.project_load(PROJ_DIR);
  ok(loadOk === true, 'project_load() returns true');

  const reloaded = getMasterResonanceEffect();
  ok(!!reloaded, 'resonancesuppressor found in master chain after reload');
  if (reloaded) {
    const reloadedParams = getParams(reloaded.nodeId);
    const valueOf = (id) => paramValue(findParam(reloadedParams, id));

    ok(Math.abs(valueOf('depth') - 77) <= 0.5,
       `depth persisted through save/load (expected 77, got ${valueOf('depth')})`);
    ok(Math.abs(valueOf('processing_mode') - 1) <= 0.01,
       `processing_mode persisted through save/load (expected 1, got ${valueOf('processing_mode')})`);
    ok(Math.abs(valueOf('wc_b1_active') - 0) <= 0.01,
       `wc_b1_active persisted (expected 0, got ${valueOf('wc_b1_active')})`);
    ok(Math.abs(valueOf('wc_b1_type') - 2) <= 0.01,
       `wc_b1_type persisted (expected 2, got ${valueOf('wc_b1_type')})`);
    ok(Math.abs(valueOf('wc_b1_q') - 2.5) <= 0.05,
       `wc_b1_q persisted (expected 2.5, got ${valueOf('wc_b1_q')})`);
    ok(Math.abs(valueOf('wc_b5_active') - 1) <= 0.01,
       `wc_b5_active persisted (expected 1, got ${valueOf('wc_b5_active')})`);
    ok(Math.abs(valueOf('wc_b5_freq') - 888) <= 20,
       `wc_b5_freq persisted (expected 888, got ${valueOf('wc_b5_freq')})`);
    ok(Math.abs(valueOf('wc_b5_gain') - 4.0) <= 0.1,
       `wc_b5_gain persisted (expected 4.0, got ${valueOf('wc_b5_gain')})`);
    ok(Math.abs(valueOf('wc_b5_q') - 0.75) <= 0.05,
       `wc_b5_q persisted (expected 0.75, got ${valueOf('wc_b5_q')})`);
  }

  console.log('\n[ state migration ]');
  ok(fs.existsSync(PROJECT_JSON), `project.json exists at ${PROJECT_JSON}`);
  if (fs.existsSync(PROJECT_JSON)) {
    const project = JSON.parse(fs.readFileSync(PROJECT_JSON, 'utf8'));
    const stateNode = findEffectStateNode(project, 'resonancesuppressor');
    ok(!!stateNode, 'project.json contains a Resonance Suppressor state blob');
    if (stateNode) {
      const stripped = stripProcessingModeFromStateBlob(stateNode.state);
      ok(stripped.changed, 'processing_mode can be removed from the serialized state blob');
      if (stripped.changed) {
        stateNode.state = stripped.base64;
        fs.writeFileSync(PROJECT_JSON, JSON.stringify(project, null, 2));

        const migratedLoadOk = addon.project_load(PROJ_DIR);
        ok(migratedLoadOk === true, 'project_load() succeeds after removing processing_mode from state');

        const migrated = getMasterResonanceEffect();
        ok(!!migrated, 'resonancesuppressor is still present after legacy-state reload');
        if (migrated) {
          const migratedMode = getParamValue(migrated.nodeId, 'processing_mode');
          ok(Math.abs(migratedMode - 1) <= 0.01,
             `legacy state missing processing_mode restores as High Quality (got ${migratedMode})`);
        }
      }
    }
  }

  console.log('\n[ fresh-instance default after migration ]');
  const freshNodeId = getNodeId(addon.audio_addMasterEffect('resonancesuppressor', 0));
  ok(freshNodeId >= 0, `fresh audio_addMasterEffect -> nodeId=${freshNodeId}`);
  if (freshNodeId >= 0) {
    const freshMode = getParamValue(freshNodeId, 'processing_mode');
    ok(Math.abs(freshMode - 0) <= 0.01,
       `fresh instance still defaults to Low Latency after legacy migration (got ${freshMode})`);

    const liveEdits = [
      ['wc_b2_active', 1,    0.01],
      ['wc_b2_type',   0,    0.01],
      ['wc_b2_freq',   1000, 10.0],
      ['wc_b2_gain',   12,   0.1],
      ['wc_b2_q',      2.0,  0.05],
    ];

    for (const [id, value] of liveEdits) {
      const setOk = addon.audio_setEffectParameter(-1, freshNodeId, id, value);
      ok(setOk === true, `live setEffectParameter("${id}", ${value}) -> true`);
    }

    const liveParams = getParams(freshNodeId);
    ok(Array.isArray(liveParams), 'fresh getEffectParameters returns an array');
    if (Array.isArray(liveParams)) {
      for (const [id, value, tol] of liveEdits) {
        const got = paramValue(findParam(liveParams, id));
        ok(Math.abs(got - value) <= tol,
           `live param "${id}" round-trips: expected ~${value}, got ${got} (tol +/-${tol})`);
      }
    }
  }

  console.log(`\n${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed}/${total} tests`);
  process.exit(failed > 0 ? 1 : 0);
})();
