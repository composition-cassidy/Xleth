'use strict';
//
// bridge/test_varimu_bridge.js - Vari-Mu Comp ("varimu") end-to-end through the addon
//
// Drives the REAL native addon (the same xleth_native.node the Electron app
// loads):
//
//   contract   audio_addEffect("varimu") resolves in AudioGraph::createEffect,
//              the node sits on the TRACK chain, exposes the unit's 4 controls
//              with the engine defaults (no threshold), reports its 4x
//              oversampler latency to PDC, and every parameter round-trips.
//   persist    project_save / project_load keep every parameter.
//   live       on the audio device, a full-mix-style loop at -1 dBFS peaks: the
//              defaults level it gently (1-3 dB of GR); Input drives it harder.
//   renders    offline mixdowns through the live graph (audio_exportStart,
//              32-bit float WAV), analysed here:
//                gentle leveling  the mix at the defaults: peaks come down by
//                                 a dB or two, the level is otherwise kept;
//                release          a loud burst then a quiet probe tone: the
//                                 probe is still ducked at Time Constant 4
//                                 (5 s) where 1 (0.3 s) has let go;
//                Mid/Side         a loud mid tone and a quiet side tone: in
//                                 Linked the side is pulled down with the mid,
//                                 in Mid/Side it keeps its level.
//
// Needs an audio device. Run after rebuilding the native addon:
//   node bridge/test_varimu_bridge.js
//
// The exit code is meaningful: shutdown() joins the audio-export thread, so a
// process that ran audio_exportStart no longer dies with 0xC0000409 at exit
// (it used to, with the verdict line already printed).
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
const db = (x) => (x > 1e-12 ? 20 * Math.log10(x) : -240);

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

// Mirrored from XlethVariMuCompressorEffect::createLayout(). [id, min, max, default]
const SPEC = [
  ['input',         -24, 36, 0],
  ['output',        -24, 24, 0],
  ['time_constant',   1,  6, 2],
  ['mode',            0,  1, 0],
];

const PROBE = [['input', 13.5], ['output', -4.25], ['time_constant', 5], ['mode', 1]];

// ── Sources (4 s, stereo, 48 kHz, 16-bit) ───────────────────────────────────
function writeWav(file, L, R, fs0) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(fs0, 24); buf.writeUInt32LE(fs0 * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  const q = (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(q(L[i]), 44 + i * 4);
    buf.writeInt16LE(q(R[i]), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

// A full-mix-style loop at -1 dBFS peaks: kick on the beat, a noise snare on
// the off-beat, a bass line, a slowly swelling decorrelated pad.
function mixLoop() {
  const fs0 = 48000;
  const n = fs0 * 4;
  const L = new Float64Array(n), R = new Float64Array(n);
  let seed = 4242;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 - 0.5; };
  let pl = 0, pr = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / fs0;
    const beat = t % 0.5, off = (t + 0.25) % 0.5;
    const kick = Math.exp(-beat / 0.08) * Math.sin(2 * Math.PI * (50 + 60 * Math.exp(-beat / 0.02)) * beat);
    const snare = off < 0.12 ? Math.exp(-off / 0.04) * rnd() * 1.2 : 0;
    const bass = 0.35 * Math.sin(2 * Math.PI * (t < 2 ? 55 : 73.4) * t);
    pl += 0.02 * (rnd() * 3.4 - pl);
    pr += 0.02 * (rnd() * 3.4 - pr);
    const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.25 * t);
    L[i] = 0.8 * kick + 0.5 * snare + bass + 0.6 * swell * pl;
    R[i] = 0.8 * kick + 0.5 * snare + bass + 0.6 * swell * pr;
  }
  let pk = 0;
  for (let i = 0; i < n; i += 1) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  const g = 10 ** (-1 / 20) / pk;
  return { L: Array.from(L, (v) => v * g), R: Array.from(R, (v) => v * g), fs0 };
}

// 1 s of a loud 200 Hz tone, then 3 s of a quiet 1.5 kHz probe.
function burstThenProbe() {
  const fs0 = 48000;
  const n = fs0 * 4;
  const x = Array.from({ length: n }, (_, i) => {
    const t = i / fs0;
    return t < 1 ? 0.9 * Math.sin(2 * Math.PI * 200 * t) : 0.03 * Math.sin(2 * Math.PI * 1500 * t);
  });
  return { L: x, R: x, fs0 };
}

// Mid 220 Hz at -3 dBFS, side 3 kHz at -32 dBFS (L = m + s, R = m - s).
function midAndSide() {
  const fs0 = 48000;
  const n = fs0 * 4;
  const L = [], R = [];
  for (let i = 0; i < n; i += 1) {
    const m = 0.7 * Math.sin(2 * Math.PI * 220 * i / fs0);
    const s = 0.025 * Math.sin(2 * Math.PI * 3000 * i / fs0);
    L.push(m + s);
    R.push(m - s);
  }
  return { L, R, fs0 };
}

// ── Offline render through the live graph, read back ─────────────────────────
function readWavFloat(file) {
  const b = fs.readFileSync(file);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(off + 8), ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') data = { start: off + 8, size };
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('bad wav');
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.size / (fmt.ch * bytes));
  const L = new Float64Array(frames), R = new Float64Array(frames);
  const rd = (p) => ((fmt.tag === 3 || (fmt.tag === 0xfffe && fmt.bits === 32)) ? b.readFloatLE(p)
    : fmt.bits === 24 ? b.readIntLE(p, 3) / 8388608 : b.readInt16LE(p) / 32768);
  for (let i = 0; i < frames; i += 1) {
    const p = data.start + i * fmt.ch * bytes;
    L[i] = rd(p);
    R[i] = fmt.ch > 1 ? rd(p + bytes) : L[i];
  }
  return { L, R, sr: fmt.sr, fmt };
}

let renderCount = 0;
async function render(label) {
  const out = path.join(PROJ_DIR, `render_${renderCount += 1}.wav`);
  const started = addon.audio_exportStart({ outputPath: out, format: 'wav', sampleRate: 48000, bitDepth: 32, startBeat: 0, endBeat: 8 });
  if (!started) { ok(false, `${label}: audio_exportStart accepted`); return null; }
  let prog = null;
  for (let i = 0; i < 600; i += 1) {
    await sleep(50);
    prog = parseJson(addon.audio_exportGetProgress(), 'audio_exportGetProgress');
    if (prog && prog.running === false) break;
  }
  if (!prog || prog.running !== false || prog.error) {
    ok(false, `${label}: render finished (${JSON.stringify(prog)})`);
    return null;
  }
  return readWavFloat(out);
}

function toneAmp(x, from, n, hz, sr) {
  let re = 0, im = 0;
  for (let i = 0; i < n; i += 1) {
    const ph = 2 * Math.PI * hz * i / sr;
    re += x[from + i] * Math.cos(ph);
    im += x[from + i] * Math.sin(ph);
  }
  return 2 * Math.sqrt(re * re + im * im) / n;
}

const peakOf = (x, from, to) => { let p = 0; for (let i = from; i < to; i += 1) p = Math.max(p, Math.abs(x[i])); return p; };
const rmsOf = (x, from, to) => { let s = 0; for (let i = from; i < to; i += 1) s += x[i] * x[i]; return Math.sqrt(s / (to - from)); };

async function measureLive(trackId, nodeId, label) {
  addon.transport_seek(0);
  addon.play();
  await sleep(700);
  let peak = 0, grMax = 0, grSum = 0, grN = 0;
  for (let i = 0; i < 100; i += 1) {
    const p = addon.audio_getTrackPeak(trackId);
    peak = Math.max(peak, p?.peakL ?? 0, p?.peakR ?? 0);
    const m = parseJson(addon.audio_getEffectMeter(trackId, nodeId), 'audio_getEffectMeter');
    if (Array.isArray(m)) { grMax = Math.max(grMax, m[2] ?? 0); grSum += m[2] ?? 0; grN += 1; }
    await sleep(25);
  }
  addon.stop();
  const grMean = grN ? grSum / grN : 0;
  console.log(`  info  ${label}: peak ${db(peak).toFixed(2)} dBFS, GR mean ${grMean.toFixed(2)} / max ${grMax.toFixed(2)} dB`);
  return { peak, grMean, grMax };
}

const PROJ_DIR = path.join(os.tmpdir(), '_xleth_varimu_bridge_test');
const PPQ = 960;

(async () => {
  console.log('=== Vari-Mu Comp bridge + live playback + renders ===\n');

  let initOk = false;
  try { initOk = addon.initialize(); } catch (err) {
    console.error(`Engine init failed: ${err.message} — SKIPPING (needs an audio device).`);
    process.exit(0);
  }
  ok(initOk === true, 'initialize() returns true');

  if (fs.existsSync(PROJ_DIR)) fs.rmSync(PROJ_DIR, { recursive: true, force: true });
  ok(addon.project_create(PROJ_DIR, 'VariMuBridgeTest') === true, 'project_create() returns true');
  addon.setBPM(120);

  const names = ['Mix', 'Burst', 'MidSide'];
  const tracks = names.map((name, order) => addon.timeline_addTrack({ name, volume: 1.0, order }));
  ok(tracks.every(Number.isInteger), `three tracks (${tracks.join(', ')})`);
  const [mixId, burstId, msId] = tracks;

  console.log('\n[ contract ]');
  const nodeId = getNodeId(addon.audio_addEffect(mixId, 'varimu', 0));
  ok(nodeId >= 0, `audio_addEffect("varimu") -> nodeId=${nodeId}`);
  if (nodeId < 0) { console.error('  "varimu" did not resolve in AudioGraph::createEffect.'); process.exit(1); }
  {
    const chain = parseJson(addon.audio_getEffectChain(mixId), 'audio_getEffectChain');
    const entry = Array.isArray(chain) ? chain.find((e) => e.nodeId === nodeId) : null;
    ok(entry?.pluginId === 'varimu', `track chain lists the node as "varimu" (got ${entry?.pluginId})`);
  }
  const params = getParams(mixId, nodeId);
  ok(Array.isArray(params) && params.length === SPEC.length,
     `exposes ${SPEC.length} parameters (got ${Array.isArray(params) ? params.map((p) => p.id).join(', ') : 'n/a'})`);
  ok(Array.isArray(params) && !params.some((p) => /thresh|ratio/i.test(p.id)), 'no threshold or ratio control (Input drives the curve)');
  for (const [id, min, max, def] of SPEC) {
    const p = findParam(params, id);
    ok(!!p, `"${id}" exposed`);
    if (!p) continue;
    near(p.min, min, 1e-6, `"${id}".min`);
    near(p.max, max, 1e-6, `"${id}".max`);
    near(p.default, def, 1e-4, `"${id}".default`);
  }
  {
    const lat = parseJson(addon.audio_getEffectLatency(mixId, nodeId), 'audio_getEffectLatency');
    const samples = lat?.samples ?? lat?.latencySamples ?? lat?.latency ?? lat;
    console.log(`  info  audio_getEffectLatency -> ${JSON.stringify(lat)}`);
    ok(Number.isFinite(samples) && samples > 49, `reports the 4x oversampler latency to PDC (${samples} samples)`);
  }
  for (const [id, v] of PROBE) ok(addon.audio_setEffectParameter(mixId, nodeId, id, v) === true, `set "${id}" = ${v}`);
  {
    const after = getParams(mixId, nodeId);
    for (const [id, v] of PROBE) near(findParam(after, id)?.value, v, 1e-3, `"${id}" reads back`);
  }

  console.log('\n[ persistence ]');
  ok(addon.project_save() === true, 'project_save() returns true');
  ok(addon.project_load(PROJ_DIR) === true, 'project_load() returns true');
  let mixNode = -1;
  {
    const chain = parseJson(addon.audio_getEffectChain(mixId), 'audio_getEffectChain');
    const entry = Array.isArray(chain) ? chain.find((e) => e.pluginId === 'varimu') : null;
    ok(!!entry, 'varimu survives project reload');
    if (entry) {
      mixNode = entry.nodeId;
      const after = getParams(mixId, mixNode);
      for (const [id, v] of PROBE) near(findParam(after, id)?.value, v, 1e-3, `"${id}" survives save/load`);
    }
  }
  if (mixNode < 0) process.exit(1);

  const burstNode = getNodeId(addon.audio_addEffect(burstId, 'varimu', 0));
  const msNode = getNodeId(addon.audio_addEffect(msId, 'varimu', 0));
  ok(burstNode >= 0 && msNode >= 0, 'a Vari-Mu on the burst and mid/side tracks too');
  const sources = [[mixId, 'mix.wav', mixLoop()], [burstId, 'burst.wav', burstThenProbe()], [msId, 'midside.wav', midAndSide()]];
  for (const [trackId, name, src] of sources) {
    const file = path.join(PROJ_DIR, name);
    writeWav(file, src.L, src.R, src.fs0);
    const sampleId = addon.audio_loadSourceRegion(file, 0, 4);
    const regionId = addon.timeline_addRegion({ name, label: 'S', startTime: 0, endTime: 4, audioFilePath: file });
    addon.audio_mapRegionToSample(regionId, sampleId);
    addon.timeline_addClip({ trackId, regionId, positionTicks: 0, durationTicks: PPQ * 8, velocity: 1.0 });
  }
  const set = (t, n, kv) => { for (const [id, v] of Object.entries(kv)) addon.audio_setEffectParameter(t, n, id, v); };
  const solo = (only) => { for (const t of tracks) addon.timeline_setTrackMuted(t, t !== only); };
  const DEFAULTS = { input: 0, output: 0, time_constant: 2, mode: 0 };

  console.log('\n[ live: the defaults level a full mix gently; Input drives harder ]');
  solo(mixId);
  set(mixId, mixNode, DEFAULTS);
  const gentle = await measureLive(mixId, mixNode, 'defaults (Input 0, TC 2, Linked)');
  set(mixId, mixNode, { input: 18 });
  const hard = await measureLive(mixId, mixNode, 'Input +18');
  ok(gentle.peak > 0.1, 'the mix is audible through the Vari-Mu');
  ok(gentle.grMean >= 0.7 && gentle.grMean <= 3.5 && gentle.grMax < 6,
     `gentle leveling at the defaults (mean ${gentle.grMean.toFixed(2)} dB, max ${gentle.grMax.toFixed(2)} dB of GR)`);
  ok(hard.grMean > gentle.grMean + 8, `Input drives it into limiting (mean GR ${hard.grMean.toFixed(2)} dB at +18)`);
  ok(db(hard.peak) - db(gentle.peak) < 6, `the output rises far less than the Input (${(db(hard.peak) - db(gentle.peak)).toFixed(2)} dB for +18 dB)`);

  console.log('\n[ render: gentle leveling on the mix (defaults) ]');
  set(mixId, mixNode, DEFAULTS);
  addon.audio_setEffectBypass(mixId, mixNode, true);
  const dryMix = await render('dry mix');
  addon.audio_setEffectBypass(mixId, mixNode, false);
  const wetMix = await render('Vari-Mu, defaults');
  if (dryMix && wetMix) {
    const sr = dryMix.sr, from = Math.floor(0.5 * sr), to = Math.floor(3.9 * sr);
    const pkDry = db(peakOf(dryMix.L, from, to)), pkWet = db(peakOf(wetMix.L, from, to));
    const rmsDry = db(rmsOf(dryMix.L, from, to)), rmsWet = db(rmsOf(wetMix.L, from, to));
    const crestDry = pkDry - rmsDry, crestWet = pkWet - rmsWet;
    console.log(`  info  dry peak ${pkDry.toFixed(2)} / rms ${rmsDry.toFixed(2)} dBFS (crest ${crestDry.toFixed(2)}) | wet peak ${pkWet.toFixed(2)} / rms ${rmsWet.toFixed(2)} dBFS (crest ${crestWet.toFixed(2)})`);
    ok(pkDry - pkWet > 0.5 && pkDry - pkWet < 4, `peaks come down gently (${(pkDry - pkWet).toFixed(2)} dB)`);
    ok(crestDry - crestWet > 0.2, `the mix is leveled: crest factor ${crestDry.toFixed(2)} -> ${crestWet.toFixed(2)} dB`);
    ok(rmsDry - rmsWet < 3, 'without collapsing the level');
  }

  console.log('\n[ render: release — a loud burst, then a quiet probe (Input +12) ]');
  solo(burstId);
  const probeDuck = async (tc) => {
    set(burstId, burstNode, { input: 12, output: 0, time_constant: tc, mode: 0 });
    const r = await render(`TC ${tc}`);
    if (!r) return null;
    const sr = r.sr, w = Math.floor(0.1 * sr);
    const early = toneAmp(r.L, Math.floor(1.4 * sr), w, 1500, sr);   // 0.4 s after the burst
    const late = toneAmp(r.L, Math.floor(3.85 * sr), w, 1500, sr);   // near the end
    return { early, late, duckDb: db(late) - db(early) };
  };
  const tc1 = await probeDuck(1), tc4 = await probeDuck(4);
  if (tc1 && tc4) {
    console.log(`  info  probe 0.4 s after the burst vs at 3.85 s: TC 1 (0.3 s) ${tc1.duckDb.toFixed(2)} dB ducked, TC 4 (5 s) ${tc4.duckDb.toFixed(2)} dB ducked`);
    ok(tc1.duckDb < 1.0, `TC 1 has let go within 0.4 s (${tc1.duckDb.toFixed(2)} dB)`);
    ok(tc4.duckDb > 4.0, `TC 4 is still holding the burst's reduction (${tc4.duckDb.toFixed(2)} dB)`);
  }

  console.log('\n[ render: Mid/Side vs Linked (loud mid, quiet side, Input +12) ]');
  solo(msId);
  addon.audio_setEffectBypass(msId, msNode, true);
  const dryMs = await render('dry');
  addon.audio_setEffectBypass(msId, msNode, false);
  set(msId, msNode, { input: 12, output: -12, time_constant: 2, mode: 0 });
  const linked = await render('Linked');
  set(msId, msNode, { mode: 1 });
  const midSide = await render('Mid/Side');
  if (dryMs && linked && midSide) {
    const levels = (r) => {
      const sr = r.sr, from = Math.floor(2 * sr), n = sr;
      const M = new Float64Array(n), S = new Float64Array(n);
      for (let i = 0; i < n; i += 1) { M[i] = 0.5 * (r.L[from + i] + r.R[from + i]); S[i] = 0.5 * (r.L[from + i] - r.R[from + i]); }
      return { mid: db(toneAmp(M, 0, n, 220, sr)), side: db(toneAmp(S, 0, n, 3000, sr)) };
    };
    const d = levels(dryMs), l = levels(linked), m = levels(midSide);
    // Input +12 / Output -12: the side changes only by what the gain element does to it.
    const sideLinked = l.side - d.side, sideMs = m.side - d.side;
    console.log(`  info  side tone vs dry: Linked ${sideLinked.toFixed(2)} dB, Mid/Side ${sideMs.toFixed(2)} dB; mid vs dry: Linked ${(l.mid - d.mid).toFixed(2)}, Mid/Side ${(m.mid - d.mid).toFixed(2)} dB`);
    ok(sideLinked < -6, `Linked: the quiet side is pulled down with the loud mid (${sideLinked.toFixed(2)} dB)`);
    ok(Math.abs(sideMs) < 1.0, `Mid/Side: the quiet side keeps its level (${sideMs.toFixed(2)} dB)`);
    ok(Math.abs((m.mid - d.mid) - (l.mid - d.mid)) < 1.5, 'and the mid is limited alike in both modes');
  }

  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  try { addon.shutdown?.(); } catch (_) { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
})();
