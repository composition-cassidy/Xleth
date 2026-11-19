'use strict';
//
// bridge/test_parallel_mix_bitexact.js — parallel track processing must not
// change a single sample.
//
// MixEngine runs independent track effect chains on helper threads
// (HardwareTier::audioWorkerThreads, env XLETH_HW_AUDIO_WORKERS). The contract
// is BIT-IDENTICAL output to the serial mix: only the chains move; every sum
// still happens on the calling thread in processOrder.
//
// This renders one project twice through the real offline export path (the
// same MixEngine::processBlock the live callback runs) — once in a child
// process with XLETH_HW_AUDIO_WORKERS=0 (serial), once with helpers — and
// compares the 32-bit float WAVs byte for byte. The project exercises every
// dependency the scheduler must respect: plain tracks summing to Master, a bus
// fed by output routes, a send, a sidechain key route, and a dozen heavy
// stateful chains (reverb, delay, compressors, EQ, resonance suppressor,
// distortion, chorus/flanger) whose state would diverge at the first
// mis-ordered or torn block.
//
// Run after rebuilding the native addon:   cd bridge && node test_parallel_mix_bitexact.js
// Skips (exit 0) when the engine cannot initialise (no audio device).
//

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PPQ = 960;
const BEATS = 32;          // 16 s at 120 BPM
const WORKERS = process.env.XLETH_TEST_PAR_WORKERS || '4';

function pickNativeConfig() {
  const requested = process.env.XLETH_NATIVE_CONFIG;
  const configs = requested ? [requested] : ['Release', 'Debug'];
  for (const config of configs) {
    const addonPath = path.resolve(__dirname, 'build', config, 'xleth_native.node');
    if (fs.existsSync(addonPath)) return { config, addonPath };
  }
  throw new Error('xleth_native.node not found in bridge/build/Debug or bridge/build/Release');
}

// ── child: build the project, render it, report ───────────────────────────────
async function child(outWav, workDir) {
  const native = pickNativeConfig();
  const dllDirs = [
    path.dirname(native.addonPath),
    path.resolve(__dirname, 'build/vcpkg_installed/x64-windows/bin'),
    path.resolve(__dirname, '..', 'build', 'vcpkg_installed', 'x64-windows', 'bin'),
  ].filter((d) => fs.existsSync(d));
  process.env.PATH = `${dllDirs.join(';')};${process.env.PATH}`;
  const addon = require(native.addonPath);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nodeOf = (r) => (r && typeof r === 'object' ? r.nodeId : r);

  let initOk = false;
  try { initOk = addon.initialize({}); } catch (_) { initOk = false; }
  if (!initOk) { console.log(JSON.stringify({ skip: 'engine init failed' })); addon.shutdown?.(); return; }

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  addon.project_create(path.join(workDir, 'proj'), 'ParallelMix');
  addon.setBPM(120);

  // Deterministic, distinct stereo material per track (chords + noise bursts).
  const fs0 = 48000, seconds = 16, n = fs0 * seconds;
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) - 0.5;
  function writeWav(file, k) {
    const buf = Buffer.alloc(44 + n * 4);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
    buf.writeUInt32LE(fs0, 24); buf.writeUInt32LE(fs0 * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
    const f0 = 110 * Math.pow(2, k / 7);
    for (let i = 0; i < n; i += 1) {
      const t = i / fs0;
      const gate = (Math.floor(t * (2 + (k % 3))) % 2 === 0) ? 1 : 0.15;
      const v = gate * (0.35 * Math.sin(2 * Math.PI * f0 * t) + 0.2 * Math.sin(2 * Math.PI * f0 * 1.5 * t))
              + 0.08 * rnd();
      const l = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
      const r = Math.round(Math.max(-1, Math.min(1, v * 0.8 + 0.05 * rnd())) * 32767);
      buf.writeInt16LE(l, 44 + i * 4);
      buf.writeInt16LE(r, 46 + i * 4);
    }
    fs.writeFileSync(file, buf);
  }

  const chains = [
    ['reverb', 'compressor'], ['delay', 'xletheq'], ['resonancesuppressor'], ['distortion', 'chorus'],
    ['flanger', 'reverb'], ['glue', 'delay'], ['opto', 'xlethfilter'], ['fet', 'phaser'],
    ['varimu', 'reverb'], ['apex'], ['waveshaper', 'delay'], ['transientproc', 'limiter'],
  ];
  const trackIds = [];
  for (let k = 0; k < chains.length; k += 1) {
    const tid = addon.timeline_addTrack({ name: `T${k}`, volume: 0.8, order: k });
    trackIds.push(tid);
    const file = path.join(workDir, `src${k}.wav`);
    writeWav(file, k);
    const sampleId = addon.audio_loadSourceRegion(file, 0, seconds);
    const regionId = addon.timeline_addRegion({ name: `R${k}`, label: 'S', startTime: 0, endTime: seconds, audioFilePath: file });
    addon.audio_mapRegionToSample(regionId, sampleId);
    addon.timeline_addClip({ trackId: tid, regionId, positionTicks: 0, durationTicks: PPQ * BEATS, velocity: 1.0 });
    chains[k].forEach((pid, pos) => nodeOf(addon.audio_addEffect(tid, pid, pos)));
  }
  // A bus with its own heavy chain, fed by three tracks' output routes and one send.
  const bus = addon.timeline_addTrack({ name: 'Bus', volume: 0.9, order: chains.length });
  ['reverb', 'compressor', 'xletheq'].forEach((pid, pos) => nodeOf(addon.audio_addEffect(bus, pid, pos)));
  addon.timeline_setTrackOutputRoute(trackIds[0], bus);
  addon.timeline_setTrackOutputRoute(trackIds[1], bus);
  addon.timeline_setTrackOutputRoute(trackIds[2], bus);
  addon.timeline_setTrackRoutes(trackIds[3], { targetTrackId: -1, sends: [{ targetTrackId: bus, gain: 0.5 }] });
  // Sidechain: track 4 keys the compressor on track 5 (track-level route).
  addon.timeline_addSidechainRoute(trackIds[4], { targetTrackId: trackIds[5], gain: 1.0, preFader: false, enabled: true });

  const t0 = Date.now();
  const started = addon.audio_exportStart({ outputPath: outWav, format: 'wav', sampleRate: 48000, bitDepth: 32, startBeat: 0, endBeat: BEATS });
  let prog = null;
  for (let i = 0; started && i < 2400; i += 1) {
    await sleep(50);
    const raw = addon.audio_exportGetProgress();
    prog = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (prog && prog.running === false) break;
  }
  const renderMs = Date.now() - t0;
  console.log(JSON.stringify({ started, renderMs, error: prog && prog.error, exists: fs.existsSync(outWav),
    bytes: fs.existsSync(outWav) ? fs.statSync(outWav).size : 0 }));
  addon.shutdown();
}

// ── parent: run serial + parallel children, compare ──────────────────────────
function runChild(workers, outWav, workDir) {
  const r = spawnSync(process.execPath, [__filename, '--child', outWav, workDir], {
    env: { ...process.env, XLETH_HW_AUDIO_WORKERS: String(workers) },
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60 * 1000,
  });
  const line = (r.stdout || '').split(/\r?\n/).reverse().find((l) => l.startsWith('{'));
  const workerLine = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).find((l) => l.includes('[RealtimeWorkerPool]'));
  return { status: r.status, result: line ? JSON.parse(line) : null, workerLine: workerLine || '(no worker pool)' };
}

function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function firstDiff(a, b) {
  const x = fs.readFileSync(a), y = fs.readFileSync(b);
  const len = Math.min(x.length, y.length);
  for (let i = 0; i < len; i += 1) if (x[i] !== y[i]) return { byte: i, frame: Math.floor((i - 44) / 8) };
  return x.length === y.length ? null : { byte: len, frame: 'length differs' };
}

async function parent() {
  console.log('=== parallel track processing: bit-exact vs serial ===\n');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth_parmix_'));
  let passed = 0, failed = 0;
  const ok = (c, label) => { if (c) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; console.error(`  FAIL  ${label}`); } };
  try {
    const serialWav = path.join(base, 'serial.wav');
    const parWav = path.join(base, 'parallel.wav');
    const s = runChild(0, serialWav, path.join(base, 'serial'));
    if (s.result && s.result.skip) { console.log(`[SKIP] ${s.result.skip}`); return 0; }
    const p = runChild(WORKERS, parWav, path.join(base, 'parallel'));
    console.log(`  serial   : ${JSON.stringify(s.result)} — ${s.workerLine.trim()}`);
    console.log(`  parallel : ${JSON.stringify(p.result)} — ${p.workerLine.trim()}`);
    ok(s.result && s.result.exists && !s.result.error, 'serial render completed');
    ok(p.result && p.result.exists && !p.result.error, 'parallel render completed');
    ok(/0 audio worker|no worker pool/.test(s.workerLine), 'serial child ran with no helper threads');
    ok(/\[RealtimeWorkerPool\] [1-9]/.test(p.workerLine), 'parallel child ran with helper threads');
    if (s.result && p.result && s.result.exists && p.result.exists) {
      ok(s.result.bytes > 1000000, `render is non-trivial (${s.result.bytes} bytes)`);
      {
        // A silent render would be "bit-identical" too: require real signal.
        const b = fs.readFileSync(serialWav);
        let off = 12, dataStart = -1, dataSize = 0;
        while (off + 8 <= b.length) {
          const id = b.toString('ascii', off, off + 4);
          const size = b.readUInt32LE(off + 4);
          if (id === 'data') { dataStart = off + 8; dataSize = size; break; }
          off += 8 + size + (size & 1);
        }
        let peak = 0;
        for (let i = dataStart; dataStart > 0 && i + 4 <= dataStart + dataSize; i += 4)
          peak = Math.max(peak, Math.abs(b.readFloatLE(i)));
        ok(peak > 0.05 && Number.isFinite(peak), `render carries signal (peak ${peak.toFixed(3)})`);
      }
      const same = sha(serialWav) === sha(parWav);
      ok(same, `parallel output is bit-identical to serial (sha256 ${sha(parWav).slice(0, 12)})`);
      if (!same) console.error('    first difference:', JSON.stringify(firstDiff(serialWav, parWav)));
      console.log(`  render time: serial ${s.result.renderMs} ms, parallel ${p.result.renderMs} ms`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log(`\n=== ${passed}/${passed + failed} passed, ${failed} failed ===`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[2] === '--child') {
  child(process.argv[3], process.argv[4]).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
} else {
  parent().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
