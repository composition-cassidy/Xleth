'use strict';
//
// bridge/test_fedda_bridge.js - Fedda (XlethFeddaEffect) registration contract + live audibility
//
// Calls every bridge entry the Fedda device uses, through the same native functions
// window.xleth.audio reaches, and then plays a real clip through it on the audio device and
// reads the effect's own meters back:
//
//   audio_addEffect("fedda")       resolves in AudioGraph::createEffect, lands on the TRACK chain
//   audio_getEffectParameters      the 11-parameter surface, ranges and defaults
//   audio_setEffectParameter       round-trip for every parameter
//   audio_getEffectLatency         0 (Fedda never delays the mid)
//   live playback, meter slots     width 0 = no side added; width 200 = side up, correlation down;
//                                  mono check engages (slot 7) and the track peak follows
//   project_save / project_load    every setting incl. the seed survives; mono check does NOT
//   audio_removeEffect             teardown
//
// Needs an audio device. Run after rebuilding the native addon:
//   node bridge/test_fedda_bridge.js
//

const fs = require('fs');
const os = require('os');
const path = require('path');

const dllDir = path.resolve(__dirname, 'build/Release');
const vcpkgDir = path.resolve(__dirname, '../build/vcpkg_installed/x64-windows/bin');
process.env.PATH = `${vcpkgDir};${dllDir};${process.env.PATH}`;

const addon = require('./build/Release/xleth_native.node');

let passed = 0;
let failed = 0;
let total = 0;

function ok(cond, label) {
  total += 1;
  if (cond) { console.log(`  PASS  ${label}`); passed += 1; }
  else { console.error(`  FAIL  ${label}`); failed += 1; }
}
function near(actual, expected, tol, label) {
  ok(Math.abs(actual - expected) <= tol, `${label} (expected ~${expected}, got ${actual}, tol +/-${tol})`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseJson = (t) => (typeof t === 'string' ? JSON.parse(t) : t);
function getNodeId(raw) {
  if (typeof raw === 'string') { try { return JSON.parse(raw).nodeId; } catch (_) { return -1; } }
  if (raw && typeof raw === 'object') return raw.nodeId;
  if (typeof raw === 'number') return raw;
  return -1;
}
const params = (t, n) => parseJson(addon.audio_getEffectParameters(t, n));
const param = (t, n, id) => params(t, n).find((p) => p.id === id);
const meter = async (t, n) => parseJson(await addon.audio_getEffectMeter(t, n));

// [id, min, max, default]; variation's APVTS default is 0 but every new instance draws its own.
const SPEC = [
  ['width', 0, 200, 50], ['character', 0, 2, 1], ['size', 0.5, 30, 8], ['low_bypass', 20, 2000, 150],
  ['low_slope', 0, 1, 0], ['hf_damp', 2000, 20000, 20000], ['guard', 0, 100, 0], ['variation', 0, 999, 0],
  ['loudness_match', 0, 1, 0], ['mono_check', 0, 1, 0], ['compare', 0, 1, 0],
];
const PROBE = [
  ['width', 137], ['character', 2], ['size', 12.5], ['low_bypass', 333], ['low_slope', 1],
  ['hf_damp', 7100], ['guard', 42], ['variation', 808], ['loudness_match', 1],
];

const PROJ_DIR = path.join(os.tmpdir(), '_xleth_fedda_bridge_test');
const AUDIO = path.resolve(__dirname, '../docs/plans/hall_ab_renders/hall_before_chord.wav');
const PPQ = 960;

// Roll from the top and sample the effect's meters + the track peak for ~1 s.
async function measure(trackId, nodeId, label) {
  addon.transport_seek(0);
  addon.play();
  await sleep(600);
  let peak = 0;
  let m = null;
  for (let i = 0; i < 20; i += 1) {
    const p = addon.audio_getTrackPeak(trackId);
    peak = Math.max(peak, p?.peakL ?? 0, p?.peakR ?? 0);
    m = await meter(trackId, nodeId);
    await sleep(25);
  }
  addon.stop();
  console.log(`  info  ${label}: corr ${m[0].toFixed(3)} (target ${m[5].toFixed(3)}), mid ${m[1].toFixed(1)} dB, side ${m[2].toFixed(1)} dB, monitors ${m[7]}, peak ${peak.toFixed(4)}`);
  return { m, peak };
}

(async () => {
  console.log('=== Fedda (XlethFeddaEffect) bridge contract + live check ===\n');
  let initOk = false;
  try { initOk = addon.initialize(); }
  catch (err) {
    console.error(`Engine init failed: ${err.message}\nSKIPPING - this test needs an audio device.`);
    process.exit(0);
  }
  ok(initOk === true, 'initialize() returns true');
  if (fs.existsSync(PROJ_DIR)) fs.rmSync(PROJ_DIR, { recursive: true, force: true });
  ok(addon.project_create(PROJ_DIR, 'FeddaBridgeTest') === true, 'project_create() returns true');

  console.log('\n[ track, clip, instantiation ]');
  addon.setBPM(120);
  const trackId = addon.timeline_addTrack({ name: 'Fedda', volume: 1.0, order: 0 });
  ok(Number.isInteger(trackId) && trackId >= 0, `timeline_addTrack -> ${trackId}`);
  const sampleId = addon.audio_loadSourceRegion(AUDIO, 0, 4);
  const regionId = addon.timeline_addRegion({ name: 'R', label: 'R', startTime: 0, endTime: 4, audioFilePath: AUDIO });
  addon.audio_mapRegionToSample(regionId, sampleId);
  addon.timeline_addClip({ trackId, regionId, positionTicks: 0, durationTicks: PPQ * 8, velocity: 1.0 });

  const nodeId = getNodeId(addon.audio_addEffect(trackId, 'fedda', 0));
  ok(nodeId >= 0, `audio_addEffect(${trackId}, "fedda", 0) -> nodeId=${nodeId}`);
  if (nodeId < 0) process.exit(1);
  const chain = parseJson(addon.audio_getEffectChain(trackId));
  const entry = chain.find((e) => e.nodeId === nodeId);
  ok(entry?.pluginId === 'fedda' && entry?.bypassed === false, 'track chain lists fedda, not bypassed');

  console.log('\n[ parameter surface ]');
  const ps = params(trackId, nodeId);
  ok(ps.length === SPEC.length, `exposes ${SPEC.length} parameters (got ${ps.length})`);
  for (const [id, min, max, def] of SPEC) {
    const p = ps.find((x) => x.id === id);
    ok(!!p, `"${id}" is exposed`);
    if (!p) continue;
    near(p.min, min, 1e-4, `"${id}".min`);
    near(p.max, max, 1e-4, `"${id}".max`);
    near(p.default, def, 1e-3, `"${id}".default`);
  }
  console.log(`  info  this instance drew seed ${param(trackId, nodeId, 'variation').value}`);
  const lat = parseJson(addon.audio_getEffectLatency(trackId, nodeId));
  const latSamples = lat?.samples ?? lat?.latencySamples ?? lat?.latency ?? lat;
  console.log(`  info  audio_getEffectLatency -> ${JSON.stringify(lat)}`);
  ok(latSamples === 0, 'zero latency');

  console.log('\n[ live playback through Fedda ]');
  addon.audio_setEffectParameter(trackId, nodeId, 'low_bypass', 20);
  addon.audio_setEffectParameter(trackId, nodeId, 'width', 0);
  const w0 = await measure(trackId, nodeId, 'width 0');
  ok(w0.peak > 0.01, `audio flows (peak ${w0.peak.toFixed(4)})`);
  near(w0.m[5], 1, 1e-4, 'target correlation at width 0 is 1');
  addon.audio_setEffectParameter(trackId, nodeId, 'width', 200);
  const w200 = await measure(trackId, nodeId, 'width 200');
  ok(w200.m[2] - w0.m[2] > 3, `width 200 raises the side by ${(w200.m[2] - w0.m[2]).toFixed(1)} dB`);
  ok(w200.m[0] < w0.m[0] - 0.2, `width 200 lowers the correlation (${w0.m[0].toFixed(2)} -> ${w200.m[0].toFixed(2)})`);
  near(w200.m[1], w0.m[1], 0.5, 'the mid level does not move with width (dB)');
  near(w200.m[5], -0.6, 1e-3, 'target correlation at width 200 is -0.6');

  addon.audio_setEffectParameter(trackId, nodeId, 'mono_check', 1);
  const mono = await measure(trackId, nodeId, 'width 200 + mono check');
  ok(mono.m[7] === 1, 'meter slot 7 reports mono check engaged');

  console.log('\n[ set/get round-trip ]');
  for (const [id, v] of PROBE) ok(addon.audio_setEffectParameter(trackId, nodeId, id, v) === true, `set "${id}" = ${v}`);
  for (const [id, v] of PROBE) near(param(trackId, nodeId, id).value, v, 1e-2, `"${id}" reads back`);

  console.log('\n[ save / load: settings survive, mono check does not ]');
  addon.audio_setEffectParameter(trackId, nodeId, 'mono_check', 1);
  ok(addon.project_save() === true, 'project_save() returns true');
  ok(addon.project_load(PROJ_DIR) === true, 'project_load() returns true');
  {
    const e = parseJson(addon.audio_getEffectChain(trackId)).find((x) => x.pluginId === 'fedda');
    ok(!!e, 'fedda survives the reload');
    if (e) {
      for (const [id, v] of PROBE) near(param(trackId, e.nodeId, id).value, v, 1e-2, `"${id}" survives save/load`);
      ok(param(trackId, e.nodeId, 'mono_check').value === 0, 'mono check is off after reload');
      ok(addon.audio_removeEffect(trackId, e.nodeId) === true, 'audio_removeEffect -> true');
    }
  }

  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  try { addon.shutdown?.(); } catch (_) { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
})();
