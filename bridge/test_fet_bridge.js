'use strict';
//
// bridge/test_fet_bridge.js - FET Comp ("fet") end-to-end through the addon
//
// Drives the REAL native addon (the same xleth_native.node the Electron app
// loads):
//
//   contract   audio_addEffect("fet") resolves in AudioGraph::createEffect, the
//              node sits on the TRACK chain, exposes the unit's 5 controls with
//              the engine defaults, reports its 4x oversampler latency to PDC,
//              and every parameter round-trips set/get.
//   persist    project_save / project_load keep every parameter.
//   live       on the audio device: a drum-style loop through the FET — the GR
//              meter follows Input (no threshold control: Input drives the
//              curve).
//   renders    offline mixdowns through the live graph (audio_exportStart,
//              32-bit float WAV), analysed here:
//                transient catching  the same hits at attack 7 (20 us) vs
//                                    attack 1 (800 us): the fast attack takes
//                                    the crest factor down, the slow one lets
//                                    the transients through;
//                grit                a 1 kHz tone clean vs driven with Input:
//                                    THD rises with gain reduction (the FET's
//                                    eps residual), 2nd harmonic leading, and
//                                    "all buttons in" is dirtier still.
//
// Needs an audio device. Run after rebuilding the native addon:
//   node bridge/test_fet_bridge.js
//
// KNOWN (pre-existing, not this effect): any process that ran audio_exportStart
// dies with 0xC0000409 at exit — XlethEngineService's global g_exportThread is
// left joinable after an export and its destructor calls std::terminate. The
// "=== N/N passed" line is the verdict until that is fixed; the exit code is
// masked by the crash.
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

// Mirrored from XlethFetCompressorEffect::createLayout(). [id, min, max, default]
const SPEC = [
  ['input',   -24, 36, 0],
  ['output',  -24, 24, 0],
  ['attack',    1,  7, 3],
  ['release',   1,  7, 5],
  ['ratio',     0,  4, 0],
];

const PROBE = [['input', 13.5], ['output', -4.25], ['attack', 6.5], ['release', 2.25], ['ratio', 4]];

// ── Sources (4 s, mono, 48 kHz, 16-bit) ─────────────────────────────────────
function writeWav(file, x, fs0) {
  const n = x.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(fs0, 24); buf.writeUInt32LE(fs0 * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

// Drum-style hits, 4 per second: a 1.5 ms noise click and a pitched body
// (120 -> 60 Hz sweep, 90 ms decay), peaking at -6 dBFS — steep transients
// over a sustained body, what a FET catches.
function drumLoop() {
  const fs0 = 48000;
  const n = fs0 * 4;
  const x = new Float64Array(n);
  let seed = 777;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 - 0.5; };
  for (let hit = 0; hit < 16; hit += 1) {
    const at = Math.round(hit * fs0 / 4);
    let ph = 0;
    for (let i = 0; i < fs0 / 4 && at + i < n; i += 1) {
      const t = i / fs0;
      const f = 60 + 60 * Math.exp(-t / 0.03);
      ph += 2 * Math.PI * f / fs0;
      const body = Math.sin(ph) * Math.exp(-t / 0.09);
      const click = rnd() * 2.2 * Math.exp(-t / 0.0015);
      x[at + i] += 0.8 * body + click;
    }
  }
  let pk = 0;
  for (let i = 0; i < n; i += 1) pk = Math.max(pk, Math.abs(x[i]));
  const g = 10 ** (-6 / 20) / pk;
  return { x: Array.from(x, (v) => v * g), fs0 };
}

function tone(hz, peakDb) {
  const fs0 = 48000;
  const n = fs0 * 4;
  const a = 10 ** (peakDb / 20);
  return { x: Array.from({ length: n }, (_, i) => a * Math.sin(2 * Math.PI * hz * i / fs0)), fs0 };
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
  const frames = Math.floor(data.size / (fmt.ch * fmt.bits / 8));
  const L = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const p = data.start + i * fmt.ch * (fmt.bits / 8);
    if (fmt.tag === 3 || (fmt.tag === 0xfffe && fmt.bits === 32)) L[i] = b.readFloatLE(p);
    else if (fmt.bits === 24) L[i] = (b.readIntLE(p, 3)) / 8388608;
    else L[i] = b.readInt16LE(p) / 32768;
  }
  return { L, sr: fmt.sr, fmt };
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

// Goertzel-free single-bin DFT over an integer number of cycles.
function toneAmp(x, from, n, hz, sr) {
  let re = 0, im = 0;
  for (let i = 0; i < n; i += 1) {
    const ph = 2 * Math.PI * hz * i / sr;
    re += x[from + i] * Math.cos(ph);
    im += x[from + i] * Math.sin(ph);
  }
  return 2 * Math.sqrt(re * re + im * im) / n;
}

function thd(x, sr, f0) {
  const n = sr;                       // 1 s = an integer number of cycles
  const from = Math.floor(x.length / 2) - Math.floor(n / 2);
  const h1 = toneAmp(x, from, n, f0, sr);
  let sum = 0, h2 = 0, h3 = 0;
  for (let k = 2; k <= 9; k += 1) {
    const a = toneAmp(x, from, n, k * f0, sr);
    if (k === 2) h2 = a;
    if (k === 3) h3 = a;
    sum += a * a;
  }
  return { thd: Math.sqrt(sum) / h1, h1, h2: h2 / h1, h3: h3 / h1 };
}

// Per hit (4 per second, hits 2..15): the click — the peak in the first 1 ms
// after the onset — against the body, the RMS 20..80 ms after it. The onset is
// found in the render itself (the first sample above 30 % of the hit's peak —
// the previous hit's tail stays below that), so PDC alignment does not matter.
// Returns the mean click-to-body ratio in dB and the mean click peak.
function clickToBody(x, sr) {
  const ratios = [], clicks = [];
  for (let hit = 2; hit < 15; hit += 1) {
    const w0 = Math.floor(hit * sr / 4) - Math.floor(0.004 * sr), w1 = w0 + Math.floor(0.2 * sr);
    let pk = 0;
    for (let i = w0; i < w1; i += 1) pk = Math.max(pk, Math.abs(x[i]));
    let on = w0;
    while (on < w1 && Math.abs(x[on]) < 0.3 * pk) on += 1;
    let click = 0, ss = 0;
    for (let i = on; i < on + Math.floor(0.001 * sr); i += 1) click = Math.max(click, Math.abs(x[i]));
    const b0 = on + Math.floor(0.02 * sr), b1 = on + Math.floor(0.08 * sr);
    for (let i = b0; i < b1; i += 1) ss += x[i] * x[i];
    ratios.push(db(click) - db(Math.sqrt(ss / (b1 - b0))));
    clicks.push(db(click));
  }
  const mean = (v) => v.reduce((s, a) => s + a, 0) / v.length;
  return { ratioDb: mean(ratios), clickDb: mean(clicks) };
}

// Roll from the top; the loudest of a poll burst is the phase level.
async function measureLive(trackId, nodeId, label) {
  addon.transport_seek(0);
  addon.play();
  await sleep(500);
  let peak = 0, gr = 0;
  for (let i = 0; i < 48; i += 1) {
    const p = addon.audio_getTrackPeak(trackId);
    peak = Math.max(peak, p?.peakL ?? 0, p?.peakR ?? 0);
    const m = parseJson(addon.audio_getEffectMeter(trackId, nodeId), 'audio_getEffectMeter');
    if (Array.isArray(m)) gr = Math.max(gr, m[2] ?? 0);
    await sleep(25);
  }
  addon.stop();
  console.log(`  info  ${label}: peak ${db(peak).toFixed(2)} dBFS, GR ${gr.toFixed(2)} dB`);
  return { peak, gr };
}

const PROJ_DIR = path.join(os.tmpdir(), '_xleth_fet_bridge_test');
const PPQ = 960;

(async () => {
  console.log('=== FET Comp bridge + live playback + renders ===\n');

  let initOk = false;
  try { initOk = addon.initialize(); } catch (err) {
    console.error(`Engine init failed: ${err.message} — SKIPPING (needs an audio device).`);
    process.exit(0);
  }
  ok(initOk === true, 'initialize() returns true');

  if (fs.existsSync(PROJ_DIR)) fs.rmSync(PROJ_DIR, { recursive: true, force: true });
  ok(addon.project_create(PROJ_DIR, 'FetBridgeTest') === true, 'project_create() returns true');
  addon.setBPM(120);

  const drumId = addon.timeline_addTrack({ name: 'Drums', volume: 1.0, order: 0 });
  const toneId = addon.timeline_addTrack({ name: 'Tone', volume: 1.0, order: 1 });
  ok(Number.isInteger(drumId) && Number.isInteger(toneId), `two tracks (${drumId}, ${toneId})`);

  console.log('\n[ contract ]');
  const nodeId = getNodeId(addon.audio_addEffect(drumId, 'fet', 0));
  ok(nodeId >= 0, `audio_addEffect("fet") -> nodeId=${nodeId}`);
  if (nodeId < 0) { console.error('  "fet" did not resolve in AudioGraph::createEffect.'); process.exit(1); }
  {
    const chain = parseJson(addon.audio_getEffectChain(drumId), 'audio_getEffectChain');
    const entry = Array.isArray(chain) ? chain.find((e) => e.nodeId === nodeId) : null;
    ok(entry?.pluginId === 'fet', `track chain lists the node as "fet" (got ${entry?.pluginId})`);
  }
  const params = getParams(drumId, nodeId);
  ok(Array.isArray(params) && params.length === SPEC.length,
     `exposes ${SPEC.length} parameters (got ${Array.isArray(params) ? params.map((p) => p.id).join(', ') : 'n/a'})`);
  ok(Array.isArray(params) && !params.some((p) => /thresh/i.test(p.id)), 'no threshold control (Input drives the curve)');
  for (const [id, min, max, def] of SPEC) {
    const p = findParam(params, id);
    ok(!!p, `"${id}" exposed`);
    if (!p) continue;
    near(p.min, min, 1e-6, `"${id}".min`);
    near(p.max, max, 1e-6, `"${id}".max`);
    near(p.default, def, 1e-4, `"${id}".default`);
  }
  {
    const lat = parseJson(addon.audio_getEffectLatency(drumId, nodeId), 'audio_getEffectLatency');
    const samples = lat?.samples ?? lat?.latencySamples ?? lat?.latency ?? lat;
    console.log(`  info  audio_getEffectLatency -> ${JSON.stringify(lat)}`);
    ok(Number.isFinite(samples) && samples > 49, `reports the 4x oversampler latency to PDC (${samples} samples, > the 2x models' 49)`);
  }
  for (const [id, v] of PROBE) ok(addon.audio_setEffectParameter(drumId, nodeId, id, v) === true, `set "${id}" = ${v}`);
  {
    const after = getParams(drumId, nodeId);
    for (const [id, v] of PROBE) near(findParam(after, id)?.value, v, 1e-3, `"${id}" reads back`);
  }

  console.log('\n[ persistence ]');
  ok(addon.project_save() === true, 'project_save() returns true');
  ok(addon.project_load(PROJ_DIR) === true, 'project_load() returns true');
  let drumNode = -1;
  {
    const chain = parseJson(addon.audio_getEffectChain(drumId), 'audio_getEffectChain');
    const entry = Array.isArray(chain) ? chain.find((e) => e.pluginId === 'fet') : null;
    ok(!!entry, 'fet survives project reload');
    if (entry) {
      drumNode = entry.nodeId;
      const after = getParams(drumId, drumNode);
      for (const [id, v] of PROBE) near(findParam(after, id)?.value, v, 1e-3, `"${id}" survives save/load`);
    }
  }
  if (drumNode < 0) process.exit(1);

  // Sources on the two tracks.
  const toneNode = getNodeId(addon.audio_addEffect(toneId, 'fet', 0));
  ok(toneNode >= 0, 'a FET on the tone track too');
  const drumWav = path.join(PROJ_DIR, 'drums.wav');
  const toneWav = path.join(PROJ_DIR, 'tone.wav');
  { const d = drumLoop(); writeWav(drumWav, d.x, d.fs0); }
  { const t = tone(1000, -12); writeWav(toneWav, t.x, t.fs0); }
  for (const [trackId, file] of [[drumId, drumWav], [toneId, toneWav]]) {
    const sampleId = addon.audio_loadSourceRegion(file, 0, 4);
    const regionId = addon.timeline_addRegion({ name: path.basename(file), label: 'S', startTime: 0, endTime: 4, audioFilePath: file });
    addon.audio_mapRegionToSample(regionId, sampleId);
    addon.timeline_addClip({ trackId, regionId, positionTicks: 0, durationTicks: PPQ * 8, velocity: 1.0 });
  }
  const set = (t, n, kv) => { for (const [id, v] of Object.entries(kv)) addon.audio_setEffectParameter(t, n, id, v); };
  const solo = (trackId) => {
    addon.timeline_setTrackMuted(drumId, trackId !== drumId);
    addon.timeline_setTrackMuted(toneId, trackId !== toneId);
  };

  console.log('\n[ live: Input drives the curve (drums, 4:1) ]');
  solo(drumId);
  set(drumId, drumNode, { input: -12, output: 0, attack: 5, release: 5, ratio: 0 });
  const lo = await measureLive(drumId, drumNode, 'Input -12 dB');
  set(drumId, drumNode, { input: 18 });
  const hi = await measureLive(drumId, drumNode, 'Input +18 dB');
  ok(hi.peak > 0.01, 'the drums are audible through the FET');
  ok(hi.gr > lo.gr + 10, `the GR meter follows Input (${lo.gr.toFixed(2)} -> ${hi.gr.toFixed(2)} dB for +30 dB of Input)`);
  ok(db(hi.peak) - db(lo.peak) < 18, `and the output rises far less than the Input (${(db(hi.peak) - db(lo.peak)).toFixed(2)} dB for +30 dB)`);

  // 4:1: at 20:1 the feedback loop closes in ~tau/20 at any attack setting
  // (the doc's section 2.1), so the knob's transient shaping shows at 4:1.
  console.log('\n[ render: transient catching (drums, 4:1, release 7, Input +18) ]');
  addon.audio_setEffectBypass(drumId, drumNode, true);
  const dryR = await render('dry drums');
  addon.audio_setEffectBypass(drumId, drumNode, false);
  set(drumId, drumNode, { input: 18, output: 0, ratio: 0, release: 7, attack: 7 });
  const fastR = await render('attack 7');
  set(drumId, drumNode, { attack: 1 });
  const slowR = await render('attack 1');
  if (dryR && fastR && slowR) {
    const cd = clickToBody(dryR.L, dryR.sr), cf = clickToBody(fastR.L, fastR.sr), cs = clickToBody(slowR.L, slowR.sr);
    console.log(`  info  click-to-body: dry ${cd.ratioDb.toFixed(2)} dB | attack 1 (800 us) ${cs.ratioDb.toFixed(2)} dB | attack 7 (20 us) ${cf.ratioDb.toFixed(2)} dB`);
    ok(cd.ratioDb - cf.ratioDb > 6, `the fast attack catches the transients (click-to-body ${cd.ratioDb.toFixed(2)} -> ${cf.ratioDb.toFixed(2)} dB)`);
    ok(cs.ratioDb - cf.ratioDb > 6, `the slow attack lets them through (${cs.ratioDb.toFixed(2)} vs ${cf.ratioDb.toFixed(2)} dB)`);
    ok(cf.clickDb < cs.clickDb - 6, `clicks: attack 7 ${cf.clickDb.toFixed(2)} dBFS vs attack 1 ${cs.clickDb.toFixed(2)} dBFS`);
  }

  console.log('\n[ render: grit at high Input (1 kHz tone, release 1) ]');
  solo(toneId);
  set(toneId, toneNode, { input: -12, output: 0, attack: 3, release: 1, ratio: 3 });
  const cleanR = await render('tone, Input -12 (no reduction)');
  set(toneId, toneNode, { input: 12, output: -12 });
  const mid = await render('tone, Input +12');
  set(toneId, toneNode, { input: 30, output: -24 });
  const gritR = await render('tone, Input +30');
  set(toneId, toneNode, { ratio: 4 });
  const allR = await render('tone, Input +30, all buttons in');
  if (cleanR && mid && gritR && allR) {
    const rows = [['Input -12', cleanR], ['Input +12', mid], ['Input +30', gritR], ['Input +30 ALL', allR]].map(([name, r]) => {
      const t = thd(r.L, r.sr, 1000);
      console.log(`  info  ${name.padEnd(14)} out ${db(t.h1).toFixed(2)} dBFS  THD ${(100 * t.thd).toFixed(3)} %  H2 ${db(t.h2).toFixed(1)} dBc  H3 ${db(t.h3).toFixed(1)} dBc`);
      return t;
    });
    ok(rows[0].thd < 0.001, `clean below the threshold (${(100 * rows[0].thd).toFixed(3)} %)`);
    ok(rows[1].thd > 3 * rows[0].thd && rows[2].thd > 2 * rows[1].thd, 'THD rises with Input (gain reduction)');
    ok(rows[2].thd > 0.01, `audible grit when driven (${(100 * rows[2].thd).toFixed(2)} % at Input +30)`);
    ok(rows[2].h2 > rows[2].h3, 'even-order (2nd harmonic) leads the grit');
    ok(rows[3].thd > 1.5 * rows[2].thd, `all buttons in is dirtier (${(100 * rows[3].thd).toFixed(2)} %)`);
    ok(db(rows[2].h1) - db(rows[1].h1) < 18 - 12 + 3, 'and the level is held (limiting, not just gain)');
  }

  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  try { addon.shutdown?.(); } catch (_) { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
})();
