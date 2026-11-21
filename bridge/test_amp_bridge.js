'use strict';
//
// bridge/test_amp_bridge.js - Amp Stack (XlethAmpEffect) registration contract test
//
// Exercises EVERY bridge call the Amp Stack UI path uses, through the SAME
// native entry points the renderer reaches via window.xleth.audio. The four-layer
// bridge optional-chains its way past undefined methods, so reading the renderer
// proves nothing — this file calls each one for real and asserts the result.
//
// Covered:
//   timeline_addTrack             - a real track to hang the chain on
//   audio_addEffect               - "amp" resolves in AudioGraph::createEffect
//   audio_getEffectChain          - the node is in the TRACK chain, not master
//   audio_getEffectParameters     - exactly the spec 7 surface, ranges + defaults
//   audio_setEffectParameter      - round-trip for all 12, incl. Model and Cab
//                                   choice params, plus out-of-range clamping
//   audio_getEffectLatency        - non-zero => really prepared and in the graph
//   audio_getEffectMeter          - the generic meter slots answer
//   audio_setEffectBypass         - true/false, observed through the chain JSON
//   project_save / project_load   - all 12 params survive, Model and Cab included
//   audio_moveEffect              - chain reorder with the amp in it
//   audio_removeEffect            - teardown
//
// Run after rebuilding the native addon:
//   node bridge/test_amp_bridge.js
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
  if (typeof text !== 'string') return text;
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

function getParams(trackId, nodeId) {
  return parseJson(addon.audio_getEffectParameters(trackId, nodeId),
                   'audio_getEffectParameters');
}

function findParam(params, id) {
  return Array.isArray(params) ? params.find((p) => p.id === id) : null;
}

function getParamValue(trackId, nodeId, id) {
  const p = findParam(getParams(trackId, nodeId), id);
  return p ? p.value : undefined;
}

// ── Spec 7 parameter surface ────────────────────────────────────────────────
// [id, min, max, default]. Model is 6 archetypes (0..5, default 3 = Modern
// Tight); Cab is 5 entries (0..4) because index 0 is "Auto" ahead of the four
// IRs. Sag / Tighten default to 5 = "this model's own value" (APVTS defaults
// are static, so per-model defaults are encoded on the knob's midpoint).
const SPEC_PARAMS = [
  ['model',    0,   5,   3],
  ['drive',    0,   10,  5],
  ['bass',     0,   10,  5],
  ['mid',      0,   10,  5],
  ['treble',   0,   10,  5],
  ['sag',      0,   10,  5],
  ['tighten',  0,   10,  5],
  ['gate',     0,   10,  0],
  ['cab',      0,   4,   0],
  ['presence', 0,   10,  5],
  ['mix',      0,   100, 100],
  ['output',   -24, 12,  0],
];

// Deliberately-not-default values, one per parameter, used for the round-trip
// and the save/load check. Model 4 = Rectifier, Cab 3 = Greenback 4x12.
const PROBE_VALUES = [
  ['model',    4],
  ['drive',    8.5],
  ['bass',     3.25],
  ['mid',      7.5],
  ['treble',   2.0],
  ['sag',      9.0],
  ['tighten',  1.5],
  ['gate',     4.0],
  ['cab',      3],
  ['presence', 6.5],
  ['mix',      62],
  ['output',   -7.5],
];

const PROJ_DIR = path.join(os.tmpdir(), '_xleth_amp_bridge_test');

(async () => {
  console.log('=== Amp Stack (XlethAmpEffect) bridge contract test ===\n');

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
  ok(addon.project_create(PROJ_DIR, 'AmpBridgeTest') === true, 'project_create() returns true');

  console.log('\n[ track + instantiation ]');
  const trackRaw = addon.timeline_addTrack({ name: 'Amp Test' });
  const trackId = typeof trackRaw === 'number' ? trackRaw : getNodeId(trackRaw);
  ok(Number.isInteger(trackId) && trackId >= 0, `timeline_addTrack() -> trackId=${trackId}`);
  if (!(trackId >= 0)) process.exit(1);

  const nodeId = getNodeId(addon.audio_addEffect(trackId, 'amp', 0));
  ok(nodeId >= 0, `audio_addEffect(${trackId}, "amp", 0) -> nodeId=${nodeId}`);
  if (nodeId < 0) {
    console.error('  amp did not resolve in AudioGraph::createEffect — registration is missing.');
    process.exit(1);
  }

  {
    const chain = parseJson(addon.audio_getEffectChain(trackId), 'audio_getEffectChain');
    const entry = Array.isArray(chain) ? chain.find((e) => e.nodeId === nodeId) : null;
    ok(!!entry, 'audio_getEffectChain lists the node on the TRACK chain');
    ok(entry?.pluginId === 'amp', `chain entry pluginId is "amp" (got ${entry?.pluginId})`);
    ok(entry?.bypassed === false, 'chain entry starts un-bypassed');
  }

  console.log('\n[ spec 7 parameter surface ]');
  const params = getParams(trackId, nodeId);
  ok(Array.isArray(params), 'audio_getEffectParameters returns an array');
  if (!Array.isArray(params)) process.exit(1);

  ok(params.length === SPEC_PARAMS.length,
     `exposes exactly ${SPEC_PARAMS.length} parameters (got ${params.length}: ${params.map(p => p.id).join(', ')})`);

  for (const [id, min, max, def] of SPEC_PARAMS) {
    const p = findParam(params, id);
    ok(!!p, `"${id}" is exposed`);
    if (!p) continue;
    near(p.min, min, 1e-6, `"${id}".min`);
    near(p.max, max, 1e-6, `"${id}".max`);
    near(p.default, def, 1e-6, `"${id}".default`);
    near(p.value, def, 1e-4, `"${id}" fresh instance reads its default`);
  }

  console.log('\n[ latency: really prepared and in the live graph ]');
  {
    const lat = parseJson(addon.audio_getEffectLatency(trackId, nodeId), 'audio_getEffectLatency');
    const samples = lat?.samples ?? lat?.latencySamples ?? lat?.latency;
    console.log(`  info  audio_getEffectLatency -> ${JSON.stringify(lat)}`);
    ok(Number.isFinite(samples) && samples > 0,
       `reports non-zero wet latency (oversampler + convolver), got ${samples}`);
  }

  console.log('\n[ meter slots ]');
  {
    const meter = parseJson(addon.audio_getEffectMeter(trackId, nodeId), 'audio_getEffectMeter');
    ok(Array.isArray(meter) && meter.length > 0,
       `audio_getEffectMeter returns a slot array (len=${Array.isArray(meter) ? meter.length : 'n/a'})`);
  }

  console.log('\n[ set/get round-trip for every parameter ]');
  for (const [id, value] of PROBE_VALUES) {
    ok(addon.audio_setEffectParameter(trackId, nodeId, id, value) === true,
       `audio_setEffectParameter("${id}", ${value}) -> true`);
  }
  {
    const after = getParams(trackId, nodeId);
    for (const [id, value] of PROBE_VALUES) {
      near(findParam(after, id)?.value, value, 1e-3, `"${id}" reads back`);
    }
  }

  console.log('\n[ choice params: every index is reachable ]');
  for (let i = 0; i < 6; i += 1) {
    addon.audio_setEffectParameter(trackId, nodeId, 'model', i);
    near(getParamValue(trackId, nodeId, 'model'), i, 1e-3, `model index ${i} round-trips`);
  }
  for (let i = 0; i < 5; i += 1) {
    addon.audio_setEffectParameter(trackId, nodeId, 'cab', i);
    near(getParamValue(trackId, nodeId, 'cab'), i, 1e-3, `cab index ${i} round-trips`);
  }

  console.log('\n[ out-of-range clamping ]');
  addon.audio_setEffectParameter(trackId, nodeId, 'model', 99);
  near(getParamValue(trackId, nodeId, 'model'), 5, 1e-3, 'model clamps 99 -> 5');
  addon.audio_setEffectParameter(trackId, nodeId, 'cab', -3);
  near(getParamValue(trackId, nodeId, 'cab'), 0, 1e-3, 'cab clamps -3 -> 0');
  addon.audio_setEffectParameter(trackId, nodeId, 'drive', 500);
  near(getParamValue(trackId, nodeId, 'drive'), 10, 1e-3, 'drive clamps 500 -> 10');
  addon.audio_setEffectParameter(trackId, nodeId, 'output', -500);
  near(getParamValue(trackId, nodeId, 'output'), -24, 1e-3, 'output clamps -500 -> -24');

  ok(addon.audio_setEffectParameter(trackId, nodeId, 'not_a_param', 1) === false,
     'audio_setEffectParameter rejects an unknown parameter id');

  console.log('\n[ bypass ]');
  ok(addon.audio_setEffectBypass(trackId, nodeId, true) === true,
     'audio_setEffectBypass(true) -> true');
  {
    const chain = parseJson(addon.audio_getEffectChain(trackId), 'audio_getEffectChain');
    const entry = Array.isArray(chain) ? chain.find((e) => e.nodeId === nodeId) : null;
    ok(entry?.bypassed === true, 'chain JSON reports bypassed=true');
  }
  ok(addon.audio_setEffectBypass(trackId, nodeId, false) === true,
     'audio_setEffectBypass(false) -> true');
  {
    const chain = parseJson(addon.audio_getEffectChain(trackId), 'audio_getEffectChain');
    const entry = Array.isArray(chain) ? chain.find((e) => e.nodeId === nodeId) : null;
    ok(entry?.bypassed === false, 'chain JSON reports bypassed=false again');
  }

  console.log('\n[ save / load round-trip ]');
  // Re-apply the full probe set (the clamp checks above moved four of them).
  for (const [id, value] of PROBE_VALUES) {
    addon.audio_setEffectParameter(trackId, nodeId, id, value);
  }
  ok(addon.project_save() === true, 'project_save() returns true');

  const projectPath = path.join(PROJ_DIR, 'project.json');
  ok(fs.existsSync(projectPath), 'project.json exists on disk');
  {
    const raw = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
    const chains = raw.effectChains || {};
    const chain = chains[String(trackId)];
    const node = chain?.nodes?.find?.((n) => n.pluginId === 'amp');
    ok(!!node, 'project.json carries the amp node under effectChains');
    ok(typeof node?.state === 'string' && node.state.length > 0,
       'the amp node carries a non-empty APVTS state blob');
  }

  ok(addon.project_load(PROJ_DIR) === true, 'project_load() returns true');
  {
    const chain = parseJson(addon.audio_getEffectChain(trackId), 'audio_getEffectChain');
    const entry = Array.isArray(chain) ? chain.find((e) => e.pluginId === 'amp') : null;
    ok(!!entry, 'amp survives project reload on the same track');
    if (entry) {
      const after = getParams(trackId, entry.nodeId);
      ok(Array.isArray(after) && after.length === SPEC_PARAMS.length,
         'reloaded instance still exposes the full spec 7 surface');
      for (const [id, value] of PROBE_VALUES) {
        near(findParam(after, id)?.value, value, 1e-3,
             `"${id}" survives save/load`);
      }
    }
  }

  console.log('\n[ chain mutation with the amp in it ]');
  {
    const chain = parseJson(addon.audio_getEffectChain(trackId), 'audio_getEffectChain');
    const ampEntry = Array.isArray(chain) ? chain.find((e) => e.pluginId === 'amp') : null;
    const ampNode = ampEntry?.nodeId;
    ok(Number.isInteger(ampNode), `resolved reloaded amp nodeId=${ampNode}`);

    const otherNode = getNodeId(addon.audio_addEffect(trackId, 'reverb', 1));
    ok(otherNode >= 0, 'a second effect can be added after the amp');

    ok(addon.audio_moveEffect(trackId, ampNode, 1) === true,
       'audio_moveEffect moves the amp to position 1');
    {
      const after = parseJson(addon.audio_getEffectChain(trackId), 'audio_getEffectChain');
      const e = after.find((x) => x.nodeId === ampNode);
      ok(e?.position === 1, `amp is at position 1 (got ${e?.position})`);
      // The move must not disturb the state.
      near(getParamValue(trackId, ampNode, 'model'), 4, 1e-3,
           'model survives the chain reorder');
    }

    ok(addon.audio_removeEffect(trackId, otherNode) === true, 'audio_removeEffect(reverb) -> true');
    ok(addon.audio_removeEffect(trackId, ampNode) === true, 'audio_removeEffect(amp) -> true');
    {
      const after = parseJson(addon.audio_getEffectChain(trackId), 'audio_getEffectChain');
      ok(!after.some((e) => e.pluginId === 'amp'), 'amp is gone from the chain');
    }
  }

  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  try { addon.shutdown?.(); } catch (_) { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
})();
