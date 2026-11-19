//
// bridge/verify_factory_presets.mjs - every shipped stock-effect preset, against the real engine
//
// Loads each file under ui/src/fx-presets/factory/ through the SAME adapter code the device
// preset menu uses (ui/src/fx-presets/effectPresetAdapters.js), with window.xleth.audio routed
// to the native addon, then reads the effect back and compares it with what the file says.
// One instance per effect takes every preset in turn, so each is applied over the previous
// one's state: a preset that leaves a field unwritten shows up as a mismatch.
//
// The engine ignores an unknown parameter id and clamps an out-of-range value silently, and a
// boolean handed to the EQ / Filter setters throws; all three surface here as a FAIL line.
//
//   node bridge/verify_factory_presets.mjs                 state round-trip (fast)
//   node bridge/verify_factory_presets.mjs --levels        also render each preset offline and
//                                                          print its peak / RMS change vs dry
//   node bridge/verify_factory_presets.mjs reverb delay    only these effects
//
// --levels plays nothing: it is audio_exportStart to a temp WAV. The source is a synthetic
// 4 s loop (drum hits + a sustained 220 Hz voice-like tone) that reaches the chain at about
// -9 dBFS peak. Transient Proc runs on a second track with one clip per hit, since some of
// its presets trigger on clip / note onsets (the rest detect hits from the audio and work on
// either track). Run after rebuilding the native addon.
//
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const dllDir = path.join(HERE, 'build', 'Release');
process.env.PATH = `${dllDir};${path.join(ROOT, 'build', 'vcpkg_installed', 'x64-windows', 'bin')};${process.env.PATH}`;
const addon = require(path.join(dllDir, 'xleth_native.node'));

const args = process.argv.slice(2);
const LEVELS = args.includes('--levels');
const only = args.filter((a) => !a.startsWith('--'));

const parse = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The adapters talk to window.xleth.audio.<name>; route each call to the addon's audio_<name>.
const thrown = [];
globalThis.window = {
  xleth: {
    audio: new Proxy({}, {
      get: (_, name) => (...a) => {
        const fn = addon[`audio_${String(name)}`];
        if (typeof fn !== 'function') { thrown.push(`missing RPC audio_${String(name)}`); return undefined; }
        try { return fn(...a); } catch (err) { thrown.push(`${String(name)}(${a.slice(2).join(', ')}): ${err.message}`); return undefined; }
      },
    }),
  },
};
const { getPresetAdapter } = await import(pathToFileURL(path.join(ROOT, 'ui/src/fx-presets/effectPresetAdapters.js')).href);

// ── Source: drum hits + a sustained voice-like tone + a little air, 4 s mono ──
function writeWav(file, x, fs0) {
  const n = x.length; const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(fs0, 24); buf.writeUInt32LE(fs0 * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
}
function source() {
  const fs0 = 48000; const n = fs0 * 4; const x = new Float64Array(n);
  let seed = 4242; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 - 0.5; };
  for (let hit = 0; hit < 8; hit += 1) {          // one hit per beat
    const at = Math.round(hit * fs0 / 2); let ph = 0;
    for (let i = 0; i < fs0 / 3 && at + i < n; i += 1) {
      const t = i / fs0; const f = 60 + 90 * Math.exp(-t / 0.03); ph += 2 * Math.PI * f / fs0;
      x[at + i] += 0.42 * Math.sin(ph) * Math.exp(-t / 0.09) + (i < 96 ? 0.5 * rnd() * (1 - i / 96) : 0);
    }
  }
  let ph = 0;
  for (let i = 0; i < n; i += 1) {                // 220 Hz with vibrato, gated on beats 2..4 of each second
    const t = i / fs0; const f = 220 * (1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t)); ph += f / fs0;
    const gate = (t % 1) > 0.25 ? Math.min(1, ((t % 1) - 0.25) / 0.01) * Math.min(1, (1 - (t % 1)) / 0.03) : 0;
    let s = 0; for (let h = 1; h <= 24; h += 1) s += Math.sin(2 * Math.PI * h * ph) / h * (1 / (1 + (h * 220 / 3500) ** 2));
    x[i] += 0.16 * gate * s + 0.012 * rnd();
  }
  let pk = 0; for (const v of x) pk = Math.max(pk, Math.abs(v));
  const g = 0.5 / pk; for (let i = 0; i < n; i += 1) x[i] *= g;
  return { x, fs0 };
}
function measureWav(file) {
  const b = fs.readFileSync(file); let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4); const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(off + 10), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') data = { start: off + 8, size };
    off += 8 + size + (size & 1);
  }
  const bytes = fmt.bits / 8; const frames = Math.floor(data.size / (fmt.ch * bytes));
  let peak = 0, sum = 0, bad = 0, sumSide = 0;
  for (let i = 0; i < frames; i += 1) {
    const p = data.start + i * fmt.ch * bytes;
    const l = b.readFloatLE(p); const r = fmt.ch > 1 ? b.readFloatLE(p + bytes) : l;
    if (!Number.isFinite(l) || !Number.isFinite(r)) { bad += 1; continue; }
    peak = Math.max(peak, Math.abs(l), Math.abs(r)); sum += (l * l + r * r) / 2; sumSide += ((l - r) / 2) ** 2;
  }
  const db = (v) => (v > 0 ? 20 * Math.log10(v) : -200);
  return { peak: db(peak), rms: db(Math.sqrt(sum / frames)), side: db(Math.sqrt(sumSide / frames)), bad };
}

const PROJ = path.join(os.tmpdir(), '_xleth_factory_preset_verify');
try {
  if (!addon.initialize()) throw new Error('initialize() returned false');
} catch (err) {
  console.error(`Engine init failed: ${err.message}`);
  console.error('SKIPPING - this check needs an audio device.');
  process.exit(0);
}
if (fs.existsSync(PROJ)) fs.rmSync(PROJ, { recursive: true, force: true });
addon.project_create(PROJ, 'FactoryPresetVerify');
const loopId = addon.timeline_addTrack({ name: 'Loop', volume: 1.0, order: 0 });
const hitsId = addon.timeline_addTrack({ name: 'Hits', volume: 1.0, order: 1 });
{
  const file = path.join(PROJ, 'src.wav'); const s = source(); writeWav(file, s.x, s.fs0);
  const clip = (trackId, from, to, tick, ticks, name) => {
    const sampleId = addon.audio_loadSourceRegion(file, from, to);
    const regionId = addon.timeline_addRegion({ name, label: 'S', startTime: from, endTime: to, audioFilePath: file });
    addon.audio_mapRegionToSample(regionId, sampleId);
    addon.timeline_addClip({ trackId, regionId, positionTicks: tick, durationTicks: ticks, velocity: 1.0 });
  };
  clip(loopId, 0, 4, 0, 960 * 8, 'loop');
  for (let i = 0; i < 8; i += 1) clip(hitsId, i * 0.5, (i + 1) * 0.5, 960 * i, 960, `hit${i}`);
}
const useTrack = (id) => { addon.timeline_setTrackMuted(loopId, id !== loopId); addon.timeline_setTrackMuted(hitsId, id !== hitsId); };

let renderN = 0;
async function render() {
  const out = path.join(PROJ, `r_${renderN += 1}.wav`);
  if (!addon.audio_exportStart({ outputPath: out, format: 'wav', sampleRate: 48000, bitDepth: 32, startBeat: 0, endBeat: 8 })) return { error: 'audio_exportStart refused' };
  let prog = null;
  for (let i = 0; i < 1200; i += 1) { await sleep(25); prog = parse(addon.audio_exportGetProgress()); if (prog && prog.running === false) break; }
  if (!prog || prog.running !== false || prog.error) return { error: JSON.stringify(prog) };
  const m = measureWav(out); fs.rmSync(out, { force: true }); return m;
}

// ── Authored state vs what the engine reports back ──────────────────────────
const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= Math.max(2e-3, 2e-4 * Math.abs(b));
const num = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
function diffState(effect, authored, got) {
  const d = [];
  const cmp = (where, a, g) => { for (const [k, v] of Object.entries(a || {})) if (!near(num(g?.[k]), num(v))) d.push(`${where}${k}: wrote ${v}, read ${g?.[k]}`); };
  if (effect === 'xletheq') {
    if ((got.bands || []).length !== authored.bands.length) d.push(`band count ${got.bands?.length} != ${authored.bands.length}`);
    authored.bands.forEach((b, i) => cmp(`band ${i} `, b, got.bands?.[i]));
    cmp('global ', authored.global, got.global);
  } else if (effect === 'xlethfilter') {
    if ((got.slots || []).length !== authored.slots.length) d.push(`slot count ${got.slots?.length} != ${authored.slots.length}`);
    authored.slots.forEach((s, i) => {
      cmp(`slot ${i} `, s.params, got.slots?.[i]?.params);
      s.mods.forEach((l, j) => {
        // An Off lane's other fields are whatever the engine left there; only its kind matters.
        if (l.kind === 0) { if (num(got.slots?.[i]?.mods?.[j]?.kind) !== 0) d.push(`slot ${i} lane ${j} is not Off`); } else cmp(`slot ${i} lane ${j} `, l, got.slots?.[i]?.mods?.[j]);
      });
    });
  } else {
    cmp('', authored.params, got.params);
    if (effect === 'apex') {
      for (const c of authored.curves || []) {
        const g = (got.curves || []).find((x) => x.band === c.band);
        if (!g || g.nodes.length !== c.nodes.length) { d.push(`curve ${c.band} node count`); continue; }
        c.nodes.forEach((n, i) => { if (!near(g.nodes[i].in, n.in) || !near(g.nodes[i].out, n.out)) d.push(`curve ${c.band} node ${i}`); });
      }
    }
    if (effect === 'waveshaper' && authored.points) {
      const g = got.points || [];
      if (g.length !== authored.points.length) d.push(`curve has ${g.length} points, wrote ${authored.points.length}`);
      else authored.points.forEach((p, i) => { if (!near(g[i][0], p[0]) || !near(g[i][1], p[1])) d.push(`curve point ${i}`); });
    }
  }
  return d;
}

const FACTORY = path.join(ROOT, 'ui/src/fx-presets/factory');
const rows = []; const failures = [];
useTrack(loopId);
const loopDry = LEVELS ? await render() : null;
for (const effect of fs.readdirSync(FACTORY).sort()) {
  if (effect === 'xform') continue;                       // video transform presets, not an audio effect
  if (only.length && !only.includes(effect)) continue;
  const host = effect === 'transientproc' ? hitsId : loopId;
  useTrack(host);
  const dry = !LEVELS ? null : (host === loopId ? loopDry : await render());
  const nodeRaw = parse(addon.audio_addEffect(host, effect, 0));
  const nodeId = typeof nodeRaw === 'number' ? nodeRaw : nodeRaw?.nodeId;
  if (!(nodeId >= 0)) { failures.push(`${effect}: audio_addEffect failed`); continue; }
  const target = { trackId: host, nodeId };
  const adapter = getPresetAdapter(effect);
  for (const f of fs.readdirSync(path.join(FACTORY, effect)).filter((x) => x.endsWith('.json')).sort()) {
    const doc = JSON.parse(fs.readFileSync(path.join(FACTORY, effect, f), 'utf8'));
    thrown.length = 0;
    await adapter.applyState(target, doc.state);
    await sleep(30);
    const diffs = diffState(effect, doc.state, await adapter.captureState(target));
    for (const t of thrown) diffs.push(`threw: ${t}`);
    const row = { id: `${effect}/${f.replace(/\.json$/, '')}`, diffs, dry };
    if (LEVELS) Object.assign(row, await render());
    if (diffs.length) failures.push(`${row.id}: ${diffs.slice(0, 6).join(' | ')}`);
    rows.push(row);
  }
  addon.audio_removeEffect(host, nodeId);
}

if (LEVELS) {
  console.log('\npreset                                            peak dBFS (vs dry)   RMS vs dry   side dB');
  const sign = (v) => (v >= 0 ? '+' : '') + v.toFixed(1);
  for (const r of rows) {
    if (r.error) { console.log(`${r.id.padEnd(48)} RENDER ERROR ${r.error}`); failures.push(`${r.id}: render failed`); continue; }
    if (r.bad) failures.push(`${r.id}: ${r.bad} non-finite samples`);
    console.log(`${r.id.padEnd(48)} ${r.peak.toFixed(1).padStart(7)} (${sign(r.peak - r.dry.peak)})   ${sign(r.rms - r.dry.rms).padStart(6)}   ${r.side.toFixed(0).padStart(5)}`);
  }
}
console.log(`\n=== factory presets: ${rows.length} applied, ${failures.length} failed ===`);
for (const f of failures) console.log(`  FAIL  ${f}`);
try { addon.shutdown?.(); } catch { /* already down */ }
process.exit(failures.length ? 1 : 0);
