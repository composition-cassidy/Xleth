'use strict';
//
// bridge/test_szkrezh_bridge.js - Szkrezh (XlethSzkrezhEffect) registration contract + live check
//
// Calls every bridge entry the Szkrezh device uses, through the same native functions
// window.xleth.audio reaches, then plays a real clip through it on the audio device:
//
//   audio_addEffect("szkrezh")     resolves in AudioGraph::createEffect, lands on the TRACK chain
//   audio_getEffectParameters      the 31-parameter surface, ranges and defaults
//   audio_setEffectParameter       round-trip
//   audio_getEffectLatency         0 (the wet path is the delay)
//   live playback, meter slots     wet signal appears, latched pitch reads +1200 ct, the splice
//                                  clock (slot 5) moves
//   tail hold (MixEngine)          a 0.25 s clip on a 1/2-note reverse splice: crystals are still
//                                  heard well after the clip ends, where the 50 ms silence
//                                  detector alone would have stopped the chain
//   project_save / project_load    settings survive
//   audio_removeEffect             teardown
//
// Needs an audio device. Run after rebuilding the native addon:
//   node bridge/test_szkrezh_bridge.js
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

// [id, min, max, default]
const SPEC = [
  ['pitch_src', 0, 2, 0], ['pitch', -3600, 3600, 1200], ['pitch_offset', -2400, 2400, 0], ['harmony', -14, 14, 2],
  ['key', 0, 11, 0], ['scale', 0, 8, 0], ['root', 0, 127, 60], ['midi_track', 0, 1000000, 0],
  ['sync', 0, 1, 1], ['splice', 10, 2000, 500], ['splice_div', 1, 15, 10], ['smoothing', 5, 250, 20],
  ['delay', 0, 2000, 0], ['delay_div', 0, 15, 0], ['splice_offset', 0, 50, 0], ['delay_offset', 0, 50, 0],
  ['reverse', 0, 1, 1], ['recycle', 0, 100, 35], ['fb_mode', 0, 2, 0], ['low_cut', 20, 5000, 80],
  ['high_cut', 500, 20000, 20000], ['freeze', 0, 1, 0], ['dyn_amount', -100, 100, 0], ['dyn_threshold', -60, 0, -24],
  ['dyn_attack', 0.1, 200, 5], ['dyn_release', 10, 2000, 250], ['dyn_target', 0, 2, 0], ['quality', 0, 1, 0],
  ['input', -24, 24, 0], ['output', -24, 24, 0], ['mix', 0, 100, 50],
];
const PROBE = [
  ['pitch', -700], ['pitch_offset', 24], ['splice_div', 7], ['recycle', 61], ['fb_mode', 1],
  ['low_cut', 300], ['high_cut', 9000], ['dyn_amount', -40], ['quality', 1], ['midi_track', 4242], ['mix', 75],
];

const PROJ_DIR = path.join(os.tmpdir(), '_xleth_szkrezh_bridge_test');
const AUDIO = path.resolve(__dirname, '../docs/plans/hall_ab_renders/hall_before_chord.wav');
const PPQ = 960;

async function peakOver(trackId, ms) {
  let peak = 0;
  for (let t = 0; t < ms; t += 25) {
    const p = addon.audio_getTrackPeak(trackId);
    peak = Math.max(peak, p?.peakL ?? 0, p?.peakR ?? 0);
    await sleep(25);
  }
  return peak;
}

(async () => {
  console.log('=== Szkrezh (XlethSzkrezhEffect) bridge contract + live check ===\n');
  let initOk = false;
  try { initOk = addon.initialize(); }
  catch (err) {
    console.error(`Engine init failed: ${err.message}\nSKIPPING - this test needs an audio device.`);
    process.exit(0);
  }
  ok(initOk === true, 'initialize() returns true');
  if (fs.existsSync(PROJ_DIR)) fs.rmSync(PROJ_DIR, { recursive: true, force: true });
  ok(addon.project_create(PROJ_DIR, 'SzkrezhBridgeTest') === true, 'project_create() returns true');

  console.log('\n[ track, clip, instantiation ]');
  addon.setBPM(120);
  const trackId = addon.timeline_addTrack({ name: 'Szkrezh', volume: 1.0, order: 0 });
  ok(Number.isInteger(trackId) && trackId >= 0, `timeline_addTrack -> ${trackId}`);
  const sampleId = addon.audio_loadSourceRegion(AUDIO, 0, 4);
  const regionId = addon.timeline_addRegion({ name: 'R', label: 'R', startTime: 0, endTime: 4, audioFilePath: AUDIO });
  addon.audio_mapRegionToSample(regionId, sampleId);
  // A short clip: half a beat (0.25 s at 120 BPM).
  addon.timeline_addClip({ trackId, regionId, positionTicks: 0, durationTicks: PPQ / 2, velocity: 1.0 });

  const nodeId = getNodeId(addon.audio_addEffect(trackId, 'szkrezh', 0));
  ok(nodeId >= 0, `audio_addEffect(${trackId}, "szkrezh", 0) -> nodeId=${nodeId}`);
  if (nodeId < 0) process.exit(1);
  const entry = parseJson(addon.audio_getEffectChain(trackId)).find((e) => e.nodeId === nodeId);
  ok(entry?.pluginId === 'szkrezh' && entry?.bypassed === false, 'track chain lists szkrezh, not bypassed');

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
  const lat = parseJson(addon.audio_getEffectLatency(trackId, nodeId));
  const latSamples = lat?.samples ?? lat?.latencySamples ?? lat?.latency ?? lat;
  ok(latSamples === 0, `zero latency (${JSON.stringify(lat)})`);

  console.log('\n[ live playback: wet path, latched pitch, splice clock, tail hold ]');
  addon.audio_setEffectParameter(trackId, nodeId, 'mix', 100);
  addon.audio_setEffectParameter(trackId, nodeId, 'splice_div', 13);   // 1/2 = 1 s at 120 BPM
  addon.audio_setEffectParameter(trackId, nodeId, 'recycle', 50);
  addon.transport_seek(0);
  addon.play();
  await sleep(300);
  const phases = [];
  let wet = 0;
  let cents = null;
  for (let i = 0; i < 40; i += 1) {
    const m = await meter(trackId, nodeId);
    wet = Math.max(wet, m[0], m[1]);
    phases.push(m[5]);
    cents = m[3];
    await sleep(25);
  }
  ok(wet > 0.001, `wet signal on the meters (peak ${wet.toFixed(4)})`);
  near(cents, 1200, 0.5, 'latched pitch (slot 3) is +1200 ct');
  ok(new Set(phases.map((p) => p.toFixed(3))).size > 5, 'the splice clock (slot 5) moves during playback');
  // The clip ended at 0.25 s; at 1.3 s .. 2.5 s only crystals can sound.
  await sleep(1000);
  const late = await peakOver(trackId, 1200);
  addon.stop();
  ok(late > 0.001, `crystals still sound 1-2 s after a 0.25 s clip ended (track peak ${late.toFixed(4)})`);

  console.log('\n[ set/get round-trip ]');
  for (const [id, v] of PROBE) ok(addon.audio_setEffectParameter(trackId, nodeId, id, v) === true, `set "${id}" = ${v}`);
  for (const [id, v] of PROBE) near(param(trackId, nodeId, id).value, v, 1e-2, `"${id}" reads back`);

  console.log('\n[ save / load ]');
  ok(addon.project_save() === true, 'project_save() returns true');
  ok(addon.project_load(PROJ_DIR) === true, 'project_load() returns true');
  {
    const e = parseJson(addon.audio_getEffectChain(trackId)).find((x) => x.pluginId === 'szkrezh');
    ok(!!e, 'szkrezh survives the reload');
    if (e) {
      for (const [id, v] of PROBE) near(param(trackId, e.nodeId, id).value, v, 1e-2, `"${id}" survives save/load`);
      ok(addon.audio_removeEffect(trackId, e.nodeId) === true, 'audio_removeEffect -> true');
    }
  }

  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  try { addon.shutdown?.(); } catch (_) { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
})();
