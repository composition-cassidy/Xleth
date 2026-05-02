'use strict';
//
// bridge/test_resonancesuppressor.js — Resonance Suppressor scaffold smoke test
//
// Verifies the scaffold is wired end-to-end at the native-addon level:
//   • Effect can be instantiated via audio_addMasterEffect
//   • All 54 parameters are returned by audio_getEffectParameters
//     (22 original + 32 new v1.1 Focus Curve band params)
//   • Each parameter can be set and the value round-trips within tolerance
//   • Meter slots 0 (PEAK_L), 1 (PEAK_R), 2 (GAIN_REDUCTION) all respond
//   • Save / load round-trip preserves non-default parameter values
//
// Run after rebuilding the native addon:
//   node bridge/test_resonancesuppressor.js
//

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const dllDir = path.resolve(__dirname, 'build/Release');
process.env.PATH = dllDir + ';' + process.env.PATH;

const addon = require('./build/Release/xleth_native.node');

let passed = 0, failed = 0, total = 0;
function ok(cond, label) {
  total++;
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else      { console.error(`  FAIL  ${label}`); failed++; }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// All 54 params: [id, testValue, tolerance]
// Original 22 params unchanged; 32 new v1.1 Focus Curve band params follow.
const PARAMS = [
  // ── Original 22 params ────────────────────────────────────────────────────
  ['depth',       75,     0.5],
  ['sharpness',   30,     0.5],
  ['selectivity', 80,     0.5],
  ['attack',      50,     0.5],
  ['release',     500,    1.0],
  ['mix',         60,     0.5],
  ['trim',        -3,     0.1],
  ['delta',       1,      0.01],
  ['quality',     2,      0.01],
  ['stereo_link', 50,     0.5],
  ['stereo_mode', 1,      0.01],
  ['mode',        1,      0.01],
  ['wc_hp',       120,    1.0],
  ['wc_lp',       14000,  100],
  ['wc_b1_freq',  400,    5.0],
  ['wc_b1_gain',  3,      0.1],
  ['wc_b2_freq',  1200,   10.0],
  ['wc_b2_gain',  -2,     0.1],
  ['wc_b3_freq',  4000,   20.0],
  ['wc_b3_gain',  1.5,    0.1],
  ['wc_b4_freq',  12000,  50.0],
  ['wc_b4_gain',  -1,     0.1],

  // ── v1.1: bands 1–4 new params (active/type/Q) ───────────────────────────
  ['wc_b1_active', 0,    0.01],  // test setting to inactive
  ['wc_b1_type',   2,    0.01],  // High Shelf
  ['wc_b1_q',      1.5,  0.05],

  ['wc_b2_active', 0,    0.01],
  ['wc_b2_type',   1,    0.01],  // Low Shelf
  ['wc_b2_q',      2.0,  0.05],

  ['wc_b3_active', 1,    0.01],
  ['wc_b3_type',   0,    0.01],  // Bell
  ['wc_b3_q',      0.5,  0.05],

  ['wc_b4_active', 1,    0.01],
  ['wc_b4_type',   4,    0.01],  // Tilt
  ['wc_b4_q',      3.0,  0.05],

  // ── v1.1: bands 5–8 (new slots, inactive by default) ─────────────────────
  ['wc_b5_active', 1,      0.01],
  ['wc_b5_type',   3,      0.01],  // Band Reject
  ['wc_b5_freq',   700,    10.0],
  ['wc_b5_gain',   3.5,    0.1],
  ['wc_b5_q',      1.0,    0.05],

  ['wc_b6_active', 0,      0.01],
  ['wc_b6_type',   2,      0.01],  // High Shelf
  ['wc_b6_freq',   2000,   20.0],
  ['wc_b6_gain',   -4.0,   0.1],
  ['wc_b6_q',      1.5,    0.05],

  ['wc_b7_active', 1,      0.01],
  ['wc_b7_type',   1,      0.01],  // Low Shelf
  ['wc_b7_freq',   5000,   50.0],
  ['wc_b7_gain',   6.0,    0.1],
  ['wc_b7_q',      0.75,   0.05],

  ['wc_b8_active', 0,      0.01],
  ['wc_b8_type',   0,      0.01],  // Bell
  ['wc_b8_freq',   12000,  100.0],
  ['wc_b8_gain',   -2.5,   0.1],
  ['wc_b8_q',      2.0,    0.05],
];

const PROJ_DIR = path.join(os.tmpdir(), '_xleth_rs_test');

(async () => {
  console.log('=== Resonance Suppressor scaffold smoke test ===\n');

  // ── 1. Init ────────────────────────────────────────────────────────────────
  let initOk = false;
  try {
    initOk = addon.initialize();
  } catch (e) {
    console.error(`Engine init failed: ${e.message}`);
    console.error('SKIPPING — this test needs an audio device.');
    process.exit(0);
  }
  ok(initOk === true, 'initialize() returns true');

  // ── 2. Create a throwaway project ─────────────────────────────────────────
  if (fs.existsSync(PROJ_DIR)) fs.rmSync(PROJ_DIR, { recursive: true, force: true });
  const created = addon.project_create(PROJ_DIR, 'RSTest');
  ok(created === true, 'project_create() returns true');

  // ── 3. Instantiate Resonance Suppressor on master ─────────────────────────
  console.log('\n[ instantiation ]');
  const raw = addon.audio_addMasterEffect('resonancesuppressor', 0);
  let nodeId = -1;
  if (typeof raw === 'string') {
    try { nodeId = JSON.parse(raw).nodeId; } catch (_) {}
  } else if (raw && typeof raw === 'object') {
    nodeId = raw.nodeId;
  } else if (typeof raw === 'number') {
    nodeId = raw;
  }
  ok(nodeId >= 0, `audio_addMasterEffect("resonancesuppressor") → nodeId=${nodeId}`);
  if (nodeId < 0) { console.error('Cannot continue — effect not instantiated.'); process.exit(1); }

  // ── 4. All 22 params returned ─────────────────────────────────────────────
  console.log('\n[ parameter enumeration ]');
  const paramJson = addon.audio_getEffectParameters(-1, nodeId);
  let params = null;
  try { params = JSON.parse(paramJson); } catch (e) { params = null; }
  ok(params !== null, 'audio_getEffectParameters returns valid JSON');
  ok(Array.isArray(params), 'params is an array');
  if (!Array.isArray(params)) { process.exit(1); }
  eq(params.length, 54, 'param count == 54');

  const paramIds = new Set(params.map(p => p.id ?? p.paramId ?? p.name));
  for (const [id] of PARAMS) {
    ok(paramIds.has(id), `param "${id}" present`);
  }

  // ── 5. Set and get-back each param ────────────────────────────────────────
  console.log('\n[ parameter set/get round-trip ]');
  for (const [id, testVal, tol] of PARAMS) {
    const setOk = addon.audio_setEffectParameter(-1, nodeId, id, testVal);
    ok(setOk === true, `setEffectParameter("${id}", ${testVal}) → true`);
  }
  // Re-fetch after setting all
  const afterJson = addon.audio_getEffectParameters(-1, nodeId);
  let afterParams = null;
  try { afterParams = JSON.parse(afterJson); } catch (_) {}
  if (Array.isArray(afterParams)) {
    for (const [id, testVal, tol] of PARAMS) {
      const p = afterParams.find(p => (p.id ?? p.paramId ?? p.name) === id);
      if (!p) { ok(false, `param "${id}" missing in after-fetch`); continue; }
      const v = p.value ?? p.currentValue ?? p.defaultValue;
      ok(Math.abs(v - testVal) <= tol, `param "${id}" round-trips: expected ~${testVal}, got ${v} (tol ±${tol})`);
    }
  }

  // ── 6. Meter slots ────────────────────────────────────────────────────────
  console.log('\n[ quality modes ]');
  for (const q of [0, 1, 2]) {
    const setOk = addon.audio_setEffectParameter(-1, nodeId, 'quality', q);
    ok(setOk === true, `setEffectParameter("quality", ${q}) -> true`);
    const qParams = JSON.parse(addon.audio_getEffectParameters(-1, nodeId));
    const qualityParam = Array.isArray(qParams) &&
      qParams.find(p => (p.id ?? p.paramId ?? p.name) === 'quality');
    const got = qualityParam && (qualityParam.value ?? qualityParam.currentValue);
    ok(Math.abs(got - q) <= 0.01, `quality ${q} round-trips after WOLA init (got ${got})`);
  }

  console.log('\n[ meter slots ]');
  const meterJson = addon.audio_getEffectMeter(-1, nodeId);
  let meters = null;
  try { meters = JSON.parse(meterJson); } catch (_) {}
  ok(meters !== null, 'audio_getEffectMeter returns valid JSON');
  // Accept either array of floats or object with slot keys
  const hasSlot = (slots, idx) => {
    if (Array.isArray(slots)) return slots.length > idx && typeof slots[idx] === 'number';
    if (slots && typeof slots === 'object') return typeof (slots[idx] ?? slots[`slot${idx}`]) === 'number';
    return false;
  };
  ok(hasSlot(meters, 0), 'meter slot 0 (PEAK_L) is numeric');
  ok(hasSlot(meters, 1), 'meter slot 1 (PEAK_R) is numeric');
  ok(hasSlot(meters, 2), 'meter slot 2 (GAIN_REDUCTION) is numeric');

  console.log('\n[ visualization contract ]');
  if (typeof addon.audio_setEffectVisualizationEnabled === 'function' &&
      typeof addon.audio_drainEffectVizFrames === 'function') {
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

  // ── 7. Save / load round-trip ─────────────────────────────────────────────
  console.log('\n[ save/load round-trip ]');
  // Set representative v1.1 params to distinctive values before save.
  addon.audio_setEffectParameter(-1, nodeId, 'depth',        77);
  addon.audio_setEffectParameter(-1, nodeId, 'wc_b1_active', 0);    // deactivated
  addon.audio_setEffectParameter(-1, nodeId, 'wc_b1_type',   2);    // High Shelf
  addon.audio_setEffectParameter(-1, nodeId, 'wc_b1_q',      2.5);
  addon.audio_setEffectParameter(-1, nodeId, 'wc_b5_active', 1);    // activated
  addon.audio_setEffectParameter(-1, nodeId, 'wc_b5_freq',   888);
  addon.audio_setEffectParameter(-1, nodeId, 'wc_b5_gain',   4.0);
  addon.audio_setEffectParameter(-1, nodeId, 'wc_b5_q',      0.75);
  const saveOk = addon.project_save();
  ok(saveOk === true || saveOk === undefined, 'project_save() does not throw');

  const loadOk = addon.project_load(PROJ_DIR);
  ok(loadOk === true, 'project_load() returns true');

  // After load, find the effect again via the master-specific API
  const chainJson = addon.audio_getMasterEffectChain();
  let chain = null;
  try { chain = JSON.parse(chainJson); } catch (_) {}
  ok(Array.isArray(chain), 'audio_getMasterEffectChain() returns an array after reload');
  const reloaded = Array.isArray(chain) && chain.find(e => e.pluginId === 'resonancesuppressor');
  ok(!!reloaded, 'resonancesuppressor found in master chain after reload');
  if (reloaded) {
    const reloadedParams = JSON.parse(addon.audio_getEffectParameters(-1, reloaded.nodeId));
    const findP = id => Array.isArray(reloadedParams) &&
      reloadedParams.find(p => (p.id ?? p.paramId ?? p.name) === id);
    const val = p => p ? (p.value ?? p.currentValue) : undefined;

    const depthParam = findP('depth');
    ok(depthParam && Math.abs(val(depthParam) - 77) <= 0.5,
       `depth persisted through save/load (expected 77, got ${val(depthParam)})`);

    // v1.1 new params — verify representative round-trips
    const b1active = findP('wc_b1_active');
    ok(b1active && Math.abs(val(b1active) - 0) <= 0.01,
       `wc_b1_active persisted (expected 0, got ${val(b1active)})`);

    const b1type = findP('wc_b1_type');
    ok(b1type && Math.abs(val(b1type) - 2) <= 0.01,
       `wc_b1_type persisted (expected 2, got ${val(b1type)})`);

    const b1q = findP('wc_b1_q');
    ok(b1q && Math.abs(val(b1q) - 2.5) <= 0.05,
       `wc_b1_q persisted (expected 2.5, got ${val(b1q)})`);

    const b5active = findP('wc_b5_active');
    ok(b5active && Math.abs(val(b5active) - 1) <= 0.01,
       `wc_b5_active persisted (expected 1, got ${val(b5active)})`);

    const b5freq = findP('wc_b5_freq');
    ok(b5freq && Math.abs(val(b5freq) - 888) <= 20,
       `wc_b5_freq persisted (expected 888, got ${val(b5freq)})`);

    const b5gain = findP('wc_b5_gain');
    ok(b5gain && Math.abs(val(b5gain) - 4.0) <= 0.1,
       `wc_b5_gain persisted (expected 4.0, got ${val(b5gain)})`);

    const b5q = findP('wc_b5_q');
    ok(b5q && Math.abs(val(b5q) - 0.75) <= 0.05,
       `wc_b5_q persisted (expected 0.75, got ${val(b5q)})`);
  }

  // ── 8. v1.1 live-edit round-trip on a single instance ────────────────────
  // Specifically exercises the bridge path the real-app UI uses for band
  // editing: setEffectParameter/getEffectParameters on an already-instantiated
  // effect. The engine-side regression that this is paired with lives in
  // engine/test/test_effects.cpp::testResonanceSuppressorFocusCurveLiveEdits.
  console.log('\n[ v1.1 live-edit round-trip ]');
  // Re-add a fresh instance so we are not relying on save/load state.
  const liveRaw = addon.audio_addMasterEffect('resonancesuppressor', 0);
  let liveNodeId = -1;
  if (typeof liveRaw === 'string') {
    try { liveNodeId = JSON.parse(liveRaw).nodeId; } catch (_) {}
  } else if (liveRaw && typeof liveRaw === 'object') {
    liveNodeId = liveRaw.nodeId;
  } else if (typeof liveRaw === 'number') {
    liveNodeId = liveRaw;
  }
  ok(liveNodeId >= 0, `live-edit instance audio_addMasterEffect → nodeId=${liveNodeId}`);

  if (liveNodeId >= 0) {
    const liveEdits = [
      ['wc_b2_active', 1,      0.01],
      ['wc_b2_type',   0,      0.01],   // Bell
      ['wc_b2_freq',   1000,   10.0],
      ['wc_b2_gain',   12,     0.1],
      ['wc_b2_q',      2.0,    0.05],
    ];
    for (const [id, v] of liveEdits) {
      const setOk = addon.audio_setEffectParameter(-1, liveNodeId, id, v);
      ok(setOk === true, `live setEffectParameter("${id}", ${v}) → true`);
    }
    const liveJson = addon.audio_getEffectParameters(-1, liveNodeId);
    let liveParams = null;
    try { liveParams = JSON.parse(liveJson); } catch (_) {}
    ok(Array.isArray(liveParams), 'live getEffectParameters returns array');
    if (Array.isArray(liveParams)) {
      for (const [id, v, tol] of liveEdits) {
        const p = liveParams.find(p => (p.id ?? p.paramId ?? p.name) === id);
        const got = p ? (p.value ?? p.currentValue) : undefined;
        ok(p && Math.abs(got - v) <= tol,
           `live param "${id}" round-trips: expected ~${v}, got ${got} (tol ±${tol})`);
      }
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log(`\n${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed}/${total} tests`);
  process.exit(failed > 0 ? 1 : 0);
})();
