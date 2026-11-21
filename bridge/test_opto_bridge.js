'use strict';
//
// bridge/test_opto_bridge.js - Opto Comp ("opto") end-to-end through the addon
//
// Drives the REAL native addon (the same xleth_native.node the Electron app
// loads) on the live audio device:
//
//   contract   audio_addEffect("opto") resolves in AudioGraph::createEffect, the
//              node sits on the TRACK chain, exposes the unit's 3 controls with
//              the engine defaults, reports its oversampler latency to PDC, and
//              every parameter round-trips set/get.
//   persist    project_save / project_load keep every parameter.
//   live       a synthesized vocal-style phrase (harmonic voice with vibrato,
//              formant weighting, syllable envelope, breath noise) played at two
//              levels 12 dB apart on two tracks, each with its own Opto at
//              identical settings. Leveling = the loud/quiet gap shrinks: with
//              Peak Reduction up, the GR meter moves, the loud take is pulled
//              down more than the quiet one, Gain lifts the output without
//              changing the reduction, Limit reduces harder than Compress, and
//              bypass restores the dry gap.
//
// Needs an audio device. Run after rebuilding the native addon:
//   node bridge/test_opto_bridge.js
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

// Mirrored from XlethOptoCompressorEffect::createLayout(). [id, min, max, default]
const SPEC = [
  ['peak_reduction', 0, 40, 20],
  ['gain',           0, 40, 0],
  ['mode',           0, 1,  0],
];

const PROBE = [['peak_reduction', 31.5], ['gain', 7.25], ['mode', 1]];

// ── Vocal-style source ───────────────────────────────────────────────────────
// 4 s mono 48 kHz 16-bit: f0 around 220 Hz gliding between syllables, 5.5 Hz
// vibrato, harmonics 1..24 weighted by two formant bumps (~700 Hz, ~1200 Hz),
// four syllables per second with a 25 ms attack and a sung decay, a little
// breath noise. Peak-normalised to `peakDb`.
function writeVocalWav(file, peakDb) {
  const fs0 = 48000;
  const n = fs0 * 4;
  const x = new Float32Array(n);
  let phase = 0;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 - 0.5; };
  const notes = [220, 247, 262, 220, 196, 220, 247, 294, 262, 247, 220, 196, 220, 247, 220, 196];
  const formant = (f) => Math.exp(-(((f - 700) / 250) ** 2)) + 0.6 * Math.exp(-(((f - 1200) / 350) ** 2)) + 0.08;
  for (let i = 0; i < n; i += 1) {
    const t = i / fs0;
    const syl = Math.floor(t * 4);
    const ts = t * 4 - syl;                                 // position inside the syllable, 0..1
    const f0 = notes[syl % notes.length] * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t));
    phase += (2 * Math.PI * f0) / fs0;
    let v = 0;
    for (let h = 1; h <= 24; h += 1) {
      if (h * f0 > 20000) break;
      v += (formant(h * f0) / h) * Math.sin(h * phase);
    }
    const att = Math.min(1, ts / 0.1);                      // 25 ms of the 250 ms syllable
    const env = att * (0.35 + 0.65 * Math.exp(-3 * ts)) * (syl % 4 === 3 ? 0.55 : 1.0);
    x[i] = env * v + 0.004 * rnd();
  }
  let pk = 0;
  for (let i = 0; i < n; i += 1) pk = Math.max(pk, Math.abs(x[i]));
  const g = 10 ** (peakDb / 20) / pk;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(fs0, 24); buf.writeUInt32LE(fs0 * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i] * g)) * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

// Roll from the top; the loudest of a poll burst is the phase level (peak
// meters decay between reads). Both tracks are read in the same burst.
async function measure(tracks, label) {
  addon.transport_seek(0);
  addon.play();
  await sleep(600);
  const out = tracks.map(() => ({ peak: 0, gr: 0 }));
  for (let i = 0; i < 48; i += 1) {
    tracks.forEach(({ trackId, nodeId }, k) => {
      const p = addon.audio_getTrackPeak(trackId);
      out[k].peak = Math.max(out[k].peak, p?.peakL ?? 0, p?.peakR ?? 0);
      if (nodeId >= 0) {
        const m = parseJson(addon.audio_getEffectMeter(trackId, nodeId), 'audio_getEffectMeter');
        if (Array.isArray(m)) out[k].gr = Math.max(out[k].gr, m[2] ?? 0);
      }
    });
    await sleep(25);
  }
  addon.stop();
  console.log(`  info  ${label}: ${out.map((o, k) => `[${tracks[k].name}] peak ${db(o.peak).toFixed(2)} dBFS, GR ${o.gr.toFixed(2)} dB`).join('  ')}`);
  return out;
}

const PROJ_DIR = path.join(os.tmpdir(), '_xleth_opto_bridge_test');
const PPQ = 960;

(async () => {
  console.log('=== Opto Comp bridge + live playback ===\n');

  let initOk = false;
  try { initOk = addon.initialize(); } catch (err) {
    console.error(`Engine init failed: ${err.message} — SKIPPING (needs an audio device).`);
    process.exit(0);
  }
  ok(initOk === true, 'initialize() returns true');

  if (fs.existsSync(PROJ_DIR)) fs.rmSync(PROJ_DIR, { recursive: true, force: true });
  ok(addon.project_create(PROJ_DIR, 'OptoBridgeTest') === true, 'project_create() returns true');
  addon.setBPM(120);

  const loudId = addon.timeline_addTrack({ name: 'Vox loud', volume: 1.0, order: 0 });
  const quietId = addon.timeline_addTrack({ name: 'Vox quiet', volume: 1.0, order: 1 });
  ok(Number.isInteger(loudId) && Number.isInteger(quietId), `two tracks (${loudId}, ${quietId})`);

  console.log('\n[ contract ]');
  const nodeId = getNodeId(addon.audio_addEffect(loudId, 'opto', 0));
  ok(nodeId >= 0, `audio_addEffect("opto") -> nodeId=${nodeId}`);
  if (nodeId < 0) { console.error('  "opto" did not resolve in AudioGraph::createEffect.'); process.exit(1); }
  {
    const chain = parseJson(addon.audio_getEffectChain(loudId), 'audio_getEffectChain');
    const entry = Array.isArray(chain) ? chain.find((e) => e.nodeId === nodeId) : null;
    ok(entry?.pluginId === 'opto', `track chain lists the node as "opto" (got ${entry?.pluginId})`);
  }
  const params = getParams(loudId, nodeId);
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
    const lat = parseJson(addon.audio_getEffectLatency(loudId, nodeId), 'audio_getEffectLatency');
    const samples = lat?.samples ?? lat?.latencySamples ?? lat?.latency ?? lat;
    console.log(`  info  audio_getEffectLatency -> ${JSON.stringify(lat)}`);
    ok(Number.isFinite(samples) && samples > 0, `reports the 2x oversampler latency to PDC (${samples} samples)`);
  }
  for (const [id, v] of PROBE) ok(addon.audio_setEffectParameter(loudId, nodeId, id, v) === true, `set "${id}" = ${v}`);
  {
    const after = getParams(loudId, nodeId);
    for (const [id, v] of PROBE) near(findParam(after, id)?.value, v, 1e-3, `"${id}" reads back`);
  }

  console.log('\n[ persistence ]');
  ok(addon.project_save() === true, 'project_save() returns true');
  ok(addon.project_load(PROJ_DIR) === true, 'project_load() returns true');
  let loudNode = -1;
  {
    const chain = parseJson(addon.audio_getEffectChain(loudId), 'audio_getEffectChain');
    const entry = Array.isArray(chain) ? chain.find((e) => e.pluginId === 'opto') : null;
    ok(!!entry, 'opto survives project reload');
    if (entry) {
      loudNode = entry.nodeId;
      const after = getParams(loudId, loudNode);
      for (const [id, v] of PROBE) near(findParam(after, id)?.value, v, 1e-3, `"${id}" survives save/load`);
    }
  }

  console.log('\n[ live playback: vocal-style phrase, loud vs quiet take ]');
  const quietNode = getNodeId(addon.audio_addEffect(quietId, 'opto', 0));
  ok(quietNode >= 0 && loudNode >= 0, 'an Opto on each track');
  const loudWav = path.join(PROJ_DIR, 'vox_loud.wav');
  const quietWav = path.join(PROJ_DIR, 'vox_quiet.wav');
  writeVocalWav(loudWav, -4);
  writeVocalWav(quietWav, -16);
  for (const [trackId, file] of [[loudId, loudWav], [quietId, quietWav]]) {
    const sampleId = addon.audio_loadSourceRegion(file, 0, 4);
    const regionId = addon.timeline_addRegion({ name: path.basename(file), label: 'V', startTime: 0, endTime: 4, audioFilePath: file });
    addon.audio_mapRegionToSample(regionId, sampleId);
    addon.timeline_addClip({ trackId, regionId, positionTicks: 0, durationTicks: PPQ * 8, velocity: 1.0 });
  }
  const tracks = [
    { name: 'loud', trackId: loudId, nodeId: loudNode },
    { name: 'quiet', trackId: quietId, nodeId: quietNode },
  ];
  const setBoth = (id, v) => { for (const t of tracks) addon.audio_setEffectParameter(t.trackId, t.nodeId, id, v); };
  const bypassBoth = (on) => { for (const t of tracks) addon.audio_setEffectBypass(t.trackId, t.nodeId, on); };
  const gap = ([l, q]) => db(l.peak) - db(q.peak);

  setBoth('mode', 0); setBoth('gain', 0); setBoth('peak_reduction', 0);

  bypassBoth(true);
  const dry = await measure(tracks.map((t) => ({ ...t, nodeId: -1 })), 'bypassed (dry)');
  ok(dry[0].peak > 0.1 && dry[1].peak > 0.01, 'both takes are audible');
  console.log(`  info  dry loud/quiet gap ${gap(dry).toFixed(2)} dB`);
  ok(Math.abs(gap(dry) - 12) < 1.5, `the takes are ~12 dB apart dry (${gap(dry).toFixed(2)} dB)`);
  bypassBoth(false);

  const idle = await measure(tracks, 'Peak Reduction 0 (EL onset above the signal)');
  ok(idle[0].gr < 0.5 && idle[1].gr < 0.5, `no reduction at Peak Reduction 0 (${idle[0].gr.toFixed(2)} / ${idle[1].gr.toFixed(2)} dB)`);
  ok(Math.abs(db(idle[0].peak) - db(dry[0].peak)) < 1.0, 'and the level is the dry level (colour only)');

  setBoth('peak_reduction', 30);
  const lev = await measure(tracks, 'Peak Reduction 30, Compress');
  ok(lev[0].gr > 4, `the GR meter shows real leveling on the loud take (${lev[0].gr.toFixed(2)} dB)`);
  ok(lev[0].gr > lev[1].gr + 3, `the loud take is reduced more than the quiet one (${lev[0].gr.toFixed(2)} vs ${lev[1].gr.toFixed(2)} dB)`);
  ok(gap(lev) < gap(dry) - 4, `audible leveling: loud/quiet gap ${gap(dry).toFixed(2)} -> ${gap(lev).toFixed(2)} dB`);

  setBoth('gain', 10);
  const made = await measure(tracks, '... + Gain 10 dB');
  ok(db(made[0].peak) - db(lev[0].peak) > 7, `Gain raises the output (delta ${(db(made[0].peak) - db(lev[0].peak)).toFixed(2)} dB)`);
  ok(Math.abs(made[0].gr - lev[0].gr) < 2.0, `Gain does not change the reduction — outside the loop (${lev[0].gr.toFixed(2)} -> ${made[0].gr.toFixed(2)} dB)`);
  setBoth('gain', 0);

  setBoth('mode', 1);
  const lim = await measure(tracks, 'Peak Reduction 30, Limit');
  ok(lim[0].gr > lev[0].gr + 0.5, `Limit reduces harder than Compress (${lev[0].gr.toFixed(2)} -> ${lim[0].gr.toFixed(2)} dB)`);
  ok(gap(lim) < gap(lev) + 0.5, `and levels at least as tightly (gap ${gap(lim).toFixed(2)} dB)`);

  bypassBoth(true);
  const back = await measure(tracks.map((t) => ({ ...t, nodeId: -1 })), 'bypassed again');
  ok(Math.abs(gap(back) - gap(dry)) < 1.0, `bypass restores the dry gap (${gap(back).toFixed(2)} dB)`);
  ok(Math.abs(db(back[0].peak) - db(dry[0].peak)) < 1.0, 'and the dry level');

  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  try { addon.shutdown?.(); } catch (_) { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
})();
