'use strict';
//
// bridge/test_glue_bridge.js - Glue Comp ("glue") end-to-end through the addon
//
// Drives the REAL native addon (the same xleth_native.node the Electron app
// loads) on the live audio device:
//
//   contract   audio_addEffect("glue") resolves in AudioGraph::createEffect, the
//              node sits on the TRACK chain, exposes the 9-parameter surface
//              with the engine defaults, reports its oversampler latency to
//              PDC, and every parameter round-trips set/get.
//   persist    project_save / project_load keep every parameter.
//   live       one real audio clip, transport rolling: the Glue actually
//              processes it — heavy settings raise the GR meter (slot 2) and
//              pull the track peak down, makeup brings it back, a threshold
//              above the signal leaves the level alone, bypass restores dry.
//
// Needs an audio device. Run after rebuilding the native addon:
//   node bridge/test_glue_bridge.js
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

function near(a, b, tol, label) {
  ok(Number.isFinite(a) && Math.abs(a - b) <= tol, `${label}: ${a} ~= ${b}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -Infinity);

function parseJson(raw, label) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (err) { ok(false, `${label} returns JSON (${err.message})`); return null; }
}

function getNodeId(raw) {
  if (typeof raw === 'string') { try { return JSON.parse(raw).nodeId; } catch (_) { return -1; } }
  if (raw && typeof raw === 'object') return raw.nodeId;
  if (typeof raw === 'number') return raw;
  return -1;
}

const getParams = (t, n) => parseJson(addon.audio_getEffectParameters(t, n), 'audio_getEffectParameters');
const findParam = (list, id) => (Array.isArray(list) ? list.find((p) => p.id === id) : undefined);

// Mirrored from XlethGlueCompressorEffect::createLayout(). [id, min, max, default]
const SPEC = [
  ['threshold',   -40, 0,   -10],
  ['makeup',      -10, 20,  0],
  ['ratio',       0,   2,   1],
  ['attack',      0,   5,   4],
  ['release',     0,   4,   4],
  ['topology',    0,   1,   0],
  ['sc_hpf_on',   0,   1,   0],
  ['sc_hpf_freq', 20,  500, 100],
  ['color',       0,   1,   1],
];

const PROBE = [
  ['threshold', -27.5], ['makeup', 6.5], ['ratio', 2], ['attack', 1], ['release', 2],
  ['topology', 1], ['sc_hpf_on', 1], ['sc_hpf_freq', 180], ['color', 0],
];

// Roll from the top of the clip; the loudest of a poll burst is the phase level
// (peak meters decay between reads). The GR meter is the block max, sampled too.
async function measure(trackId, nodeId, label) {
  addon.transport_seek(0);
  addon.play();
  await sleep(450);
  let peak = 0;
  let gr = 0;
  for (let i = 0; i < 40; i += 1) {
    const p = addon.audio_getTrackPeak(trackId);
    peak = Math.max(peak, p?.peakL ?? 0, p?.peakR ?? 0);
    if (nodeId >= 0) {
      const m = parseJson(addon.audio_getEffectMeter(trackId, nodeId), 'audio_getEffectMeter');
      if (Array.isArray(m)) gr = Math.max(gr, m[2] ?? 0);
    }
    await sleep(25);
  }
  addon.stop();
  console.log(`  info  ${label}: peak ${db(peak).toFixed(2)} dBFS, GR ${gr.toFixed(2)} dB`);
  return { peak, gr };
}

const PROJ_DIR = path.join(os.tmpdir(), '_xleth_glue_bridge_test');
const AUDIO = path.resolve(__dirname, '../docs/plans/hall_ab_renders/hall_before_chord.wav');
const PPQ = 960;

(async () => {
  console.log('=== Glue Comp bridge + live playback ===\n');

  let initOk = false;
  try { initOk = addon.initialize(); } catch (err) {
    console.error(`Engine init failed: ${err.message} — SKIPPING (needs an audio device).`);
    process.exit(0);
  }
  ok(initOk === true, 'initialize() returns true');

  if (fs.existsSync(PROJ_DIR)) fs.rmSync(PROJ_DIR, { recursive: true, force: true });
  ok(addon.project_create(PROJ_DIR, 'GlueBridgeTest') === true, 'project_create() returns true');
  addon.setBPM(120);

  const trackId = addon.timeline_addTrack({ name: 'Glue', volume: 1.0, order: 0 });
  ok(Number.isInteger(trackId) && trackId >= 0, `timeline_addTrack -> ${trackId}`);

  console.log('\n[ contract ]');
  const nodeId = getNodeId(addon.audio_addEffect(trackId, 'glue', 0));
  ok(nodeId >= 0, `audio_addEffect("glue") -> nodeId=${nodeId}`);
  if (nodeId < 0) { console.error('  "glue" did not resolve in AudioGraph::createEffect.'); process.exit(1); }
  {
    const chain = parseJson(addon.audio_getEffectChain(trackId), 'audio_getEffectChain');
    const entry = Array.isArray(chain) ? chain.find((e) => e.nodeId === nodeId) : null;
    ok(entry?.pluginId === 'glue', `track chain lists the node as "glue" (got ${entry?.pluginId})`);
  }
  const params = getParams(trackId, nodeId);
  ok(Array.isArray(params) && params.length === SPEC.length,
     `exposes ${SPEC.length} parameters (got ${Array.isArray(params) ? params.map((p) => p.id).join(', ') : 'n/a'})`);
  for (const [id, min, max, def] of SPEC) {
    const p = findParam(params, id);
    ok(!!p, `"${id}" exposed`);
    if (!p) continue;
    near(p.min, min, 1e-6, `"${id}".min`);
    near(p.max, max, 1e-6, `"${id}".max`);
    near(p.default, def, 1e-4, `"${id}".default`);
  }
  {
    const lat = parseJson(addon.audio_getEffectLatency(trackId, nodeId), 'audio_getEffectLatency');
    const samples = lat?.samples ?? lat?.latencySamples ?? lat?.latency ?? lat;
    console.log(`  info  audio_getEffectLatency -> ${JSON.stringify(lat)}`);
    ok(Number.isFinite(samples) && samples > 0, `reports the 2x oversampler latency to PDC (${samples} samples)`);
  }
  for (const [id, v] of PROBE) {
    ok(addon.audio_setEffectParameter(trackId, nodeId, id, v) === true, `set "${id}" = ${v}`);
  }
  {
    const after = getParams(trackId, nodeId);
    for (const [id, v] of PROBE) near(findParam(after, id)?.value, v, 1e-3, `"${id}" reads back`);
  }

  console.log('\n[ persistence ]');
  ok(addon.project_save() === true, 'project_save() returns true');
  ok(addon.project_load(PROJ_DIR) === true, 'project_load() returns true');
  let liveNode = -1;
  {
    const chain = parseJson(addon.audio_getEffectChain(trackId), 'audio_getEffectChain');
    const entry = Array.isArray(chain) ? chain.find((e) => e.pluginId === 'glue') : null;
    ok(!!entry, 'glue survives project reload');
    if (entry) {
      liveNode = entry.nodeId;
      const after = getParams(trackId, liveNode);
      for (const [id, v] of PROBE) near(findParam(after, id)?.value, v, 1e-3, `"${id}" survives save/load`);
    }
  }

  console.log('\n[ live playback ]');
  if (!fs.existsSync(AUDIO)) {
    console.log(`  SKIP  live section — test audio missing: ${AUDIO}`);
  } else if (liveNode >= 0) {
    const sampleId = addon.audio_loadSourceRegion(AUDIO, 0, 4);
    const regionId = addon.timeline_addRegion({ name: 'R', label: 'R', startTime: 0, endTime: 4, audioFilePath: AUDIO });
    addon.audio_mapRegionToSample(regionId, sampleId);
    addon.timeline_addClip({ trackId, regionId, positionTicks: 0, durationTicks: PPQ * 8, velocity: 1.0 });

    // Neutral: threshold above the signal, colour off, makeup 0, classic topology.
    const set = (id, v) => addon.audio_setEffectParameter(trackId, liveNode, id, v);
    set('makeup', 0); set('color', 0); set('sc_hpf_on', 0); set('topology', 0);
    set('ratio', 1); set('attack', 1); set('release', 1); set('threshold', 0);

    addon.audio_setEffectBypass(trackId, liveNode, true);
    const dry = await measure(trackId, -1, 'bypassed (dry)');
    ok(dry.peak > 0.01, `the clip is audible (${db(dry.peak).toFixed(2)} dBFS)`);
    addon.audio_setEffectBypass(trackId, liveNode, false);

    const idle = await measure(trackId, liveNode, 'threshold 0 dBFS (above signal)');
    ok(Math.abs(db(idle.peak) - db(dry.peak)) < 1.0,
       `no compression when the threshold is above the signal (delta ${(db(idle.peak) - db(dry.peak)).toFixed(2)} dB)`);

    set('threshold', -40); set('ratio', 2); set('attack', 0);
    const heavy = await measure(trackId, liveNode, 'threshold -40, 10:1, 0.1 ms');
    ok(heavy.gr > 6, `the GR meter shows real gain reduction (${heavy.gr.toFixed(2)} dB)`);
    ok(db(heavy.peak) - db(dry.peak) < -6,
       `the live track is audibly compressed (delta ${(db(heavy.peak) - db(dry.peak)).toFixed(2)} dB)`);

    set('makeup', 12);
    const madeUp = await measure(trackId, liveNode, '... + makeup 12 dB');
    ok(db(madeUp.peak) - db(heavy.peak) > 8,
       `makeup raises the output after the loop (delta ${(db(madeUp.peak) - db(heavy.peak)).toFixed(2)} dB)`);
    ok(Math.abs(madeUp.gr - heavy.gr) < 2.0,
       `makeup does not change gain reduction — it is outside the loop (${heavy.gr.toFixed(2)} -> ${madeUp.gr.toFixed(2)} dB)`);

    set('color', 1);
    const colored = await measure(trackId, liveNode, '... + console colour');
    ok(colored.peak > 0.005 && colored.peak < 4, `colour stage keeps the output alive and bounded (${db(colored.peak).toFixed(2)} dBFS)`);

    set('release', 4); set('topology', 1); set('sc_hpf_on', 1); set('sc_hpf_freq', 300);
    const auto = await measure(trackId, liveNode, 'Auto release, FF, S/C HPF 300 Hz');
    ok(auto.gr > 1 && auto.peak > 0.005, `Auto / FF / HPF path processes live audio (GR ${auto.gr.toFixed(2)} dB)`);

    addon.audio_setEffectBypass(trackId, liveNode, true);
    const back = await measure(trackId, -1, 'bypassed again');
    ok(Math.abs(db(back.peak) - db(dry.peak)) < 1.0,
       `bypass restores the dry level (delta ${(db(back.peak) - db(dry.peak)).toFixed(2)} dB)`);
  }

  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  try { addon.shutdown?.(); } catch (_) { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
})();
