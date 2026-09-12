'use strict';

// ── Source separation sidecar (P4-1) ────────────────────────────────────────
// Owns the lifecycle of the Python + FastAPI separation service and the IPC
// surface the renderer drives it through.
//
// Why a sidecar at all: the separation models live in the PyTorch/ONNX
// ecosystem, and the XLETH engine is C++/JUCE running under a forked system
// Node. Embedding a second ML runtime in the audio engine for an operation
// that is offline, minutes long and never real-time would buy nothing and
// cost a great deal; a separate process also means a model that hard-crashes
// takes down only itself.
//
// Why it is NOT on the RPC manifest: every manifest entry names a C++ engine
// handler symbol (see ui/rpc-manifest.js's validateManifest — `handler` is
// required and is an engine symbol). Separation never reaches the engine, so
// it is a hand-written main-process module in the same shape as export.js.
//
// Lifecycle: the sidecar is started LAZILY, on the first call that needs it,
// and stopped on app quit. Starting a Python process (and importing torch)
// costs seconds and hundreds of MB; a user who never opens the Sample Sandbox
// should never pay for it.

const { ipcMain, app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { execFileSync } = require('child_process');
const { userDataPath, runtimeResource, isPackagedRuntime } = require('../runtimePaths');

let log = (msg) => { process.stdout.write(String(msg) + '\n'); };
let getWin = () => null;

const READY_PREFIX = 'XLETH_SIDECAR_READY ';
// The sidecar imports torch on startup, which on a cold filesystem cache can
// genuinely take 20+ seconds. A short timeout here reads as "separation is
// broken" on exactly the machines where it is merely slow.
const START_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 500;

// ── Paths ────────────────────────────────────────────────────────────────

function sidecarRoot() {
  // Dev: the repo's tools/ tree. Packaged: extraResources copies it beside
  // the app (electron-builder.json's `separation_sidecar` entry).
  return isPackagedRuntime()
    ? runtimeResource('separation_sidecar')
    : path.join(runtimeResource(), 'tools', 'separation_sidecar');
}

function separationDataDir(...segments) {
  return userDataPath('xleth-separation', ...segments);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Python resolution ────────────────────────────────────────────────────

function candidatePythons() {
  const out = [];
  if (process.env.XLETH_PYTHON) out.push({ exe: process.env.XLETH_PYTHON, args: [], why: 'XLETH_PYTHON' });

  const venv = process.platform === 'win32'
    ? path.join(sidecarRoot(), '.venv', 'Scripts', 'python.exe')
    : path.join(sidecarRoot(), '.venv', 'bin', 'python');
  out.push({ exe: venv, args: [], why: 'sidecar venv' });

  if (process.platform === 'win32') {
    out.push({ exe: 'py', args: ['-3'], why: 'py launcher' });
  }
  out.push({ exe: 'python3', args: [], why: 'PATH python3' });
  out.push({ exe: 'python', args: [], why: 'PATH python' });
  return out;
}

// Cached across calls — probing four interpreters costs a process spawn each.
let resolvedPython = null;

function probePython(candidate) {
  try {
    if (candidate.exe.includes(path.sep) && !fs.existsSync(candidate.exe)) return null;
    const out = execFileSync(candidate.exe, [...candidate.args, '-c',
      'import sys,json;print(json.dumps({"v":list(sys.version_info[:3]),"exe":sys.executable}))'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
    const info = JSON.parse(out.trim().split(/\r?\n/).pop());
    const [maj, min] = info.v;
    if (maj < 3 || (maj === 3 && min < 9)) return null;
    return { ...candidate, version: info.v.join('.'), realExe: info.exe };
  } catch {
    return null;
  }
}

function resolvePython(force = false) {
  // A venv created AFTER the app started must beat a cached system
  // interpreter. Without this, installing the requirements into
  // tools/separation_sidecar/.venv appears to do nothing — the session keeps
  // using the `py -3` it resolved at first use, which is exactly the Python
  // that lacks onnxruntime — until the whole app is restarted.
  if (resolvedPython && !force && resolvedPython.why !== 'sidecar venv') {
    const venvExe = process.platform === 'win32'
      ? path.join(sidecarRoot(), '.venv', 'Scripts', 'python.exe')
      : path.join(sidecarRoot(), '.venv', 'bin', 'python');
    if (fs.existsSync(venvExe)) force = true;
  }
  if (resolvedPython && !force) return resolvedPython;
  for (const c of candidatePythons()) {
    const hit = probePython(c);
    if (hit) {
      resolvedPython = hit;
      log(`[Separation] python: ${hit.realExe || hit.exe} (${hit.version}) via ${hit.why}`);
      return hit;
    }
  }
  resolvedPython = null;
  return null;
}

// Cheap check that the sidecar's own dependencies are importable. Without
// this a missing `torch` surfaces as "the process died during startup", which
// tells the user nothing about what to install.
function probeDependencies(py) {
  try {
    const out = execFileSync(py.exe, [...py.args, '-c',
      'import json\n'
      + 'r={}\n'
      + 'for m in ("fastapi","uvicorn","numpy","soundfile","torch","onnxruntime"):\n'
      + '    try:\n'
      + '        __import__(m); r[m]=True\n'
      + '    except Exception:\n'
      + '        r[m]=False\n'
      + 'print(json.dumps(r))'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000,
        cwd: sidecarRoot() });
    return JSON.parse(out.trim().split(/\r?\n/).pop());
  } catch (e) {
    return null;
  }
}

// ── Sidecar process ──────────────────────────────────────────────────────

let sidecar = null;        // { proc, port, token, device, host }
let startPromise = null;   // in-flight start, so concurrent callers share one
let lastError = null;

function sidecarUrl(pathname) {
  if (!sidecar) throw new Error('separation sidecar is not running');
  return `http://${sidecar.host}:${sidecar.port}${pathname}`;
}

async function sidecarFetch(pathname, options = {}) {
  const res = await fetch(sidecarUrl(pathname), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Xleth-Token': sidecar.token,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { detail: text }; }
  if (!res.ok) {
    const detail = body && body.detail !== undefined ? body.detail : `HTTP ${res.status}`;
    // A refusal can carry structure, not just prose. The licence-acknowledgement
    // 409 is an object — code, model id, SPDX, the text to show — because the
    // renderer has to tell "ask the user a question and retry" apart from
    // "this failed", and parsing that distinction out of an English sentence
    // is how it starts guessing.
    const message = typeof detail === 'string'
      ? detail
      : (detail && detail.message) || `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    if (detail && typeof detail === 'object') err.detail = detail;
    throw err;
  }
  return body;
}

function startSidecar() {
  if (sidecar) return Promise.resolve(sidecar);
  if (startPromise) return startPromise;

  startPromise = new Promise((resolve, reject) => {
    const py = resolvePython();
    if (!py) {
      const e = new Error(
        'No suitable Python found. Install Python 3.9+ and the sidecar requirements '
        + '(tools/separation_sidecar/requirements.txt), or set XLETH_PYTHON to an interpreter.');
      lastError = e.message;
      return reject(e);
    }

    const root = sidecarRoot();
    if (!fs.existsSync(path.join(root, 'xleth_separation', '__main__.py'))) {
      const e = new Error(`separation sidecar not found at ${root}`);
      lastError = e.message;
      return reject(e);
    }

    const token = crypto.randomBytes(24).toString('hex');
    const modelsDir = ensureDir(separationDataDir('models'));
    const workDir = ensureDir(separationDataDir('work'));

    const args = [...py.args, '-m', 'xleth_separation',
      '--host', '127.0.0.1', '--port', '0',
      '--models-dir', modelsDir,
      '--work-dir', workDir,
      '--token', token];

    log(`[Separation] starting sidecar: ${py.exe} ${args.join(' ')}`);
    const proc = spawn(py.exe, args, {
      cwd: root,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONPATH: root },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let settled = false;
    let stdoutBuf = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      lastError = `sidecar did not become ready within ${START_TIMEOUT_MS / 1000}s`;
      try { proc.kill(); } catch {}
      startPromise = null;
      reject(new Error(lastError));
    }, START_TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        if (line.startsWith(READY_PREFIX)) {
          try {
            const info = JSON.parse(line.slice(READY_PREFIX.length));
            sidecar = { proc, port: info.port, token, device: info.device,
                        host: info.host || '127.0.0.1' };
            lastError = null;
            clearTimeout(timer);
            settled = true;
            startPromise = null;
            log(`[Separation] sidecar ready on port ${info.port} (device: ${info.device})`);
            resolve(sidecar);
          } catch (e) {
            log(`[Separation] bad ready line: ${line}`);
          }
        } else {
          log(`[Separation] ${line}`);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) log(`[Separation:err] ${text}`);
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lastError = `could not start sidecar: ${err.message}`;
      startPromise = null;
      reject(new Error(lastError));
    });

    proc.on('exit', (code, signal) => {
      log(`[Separation] sidecar exited (code ${code}, signal ${signal})`);
      const wasRunning = sidecar && sidecar.proc === proc;
      if (wasRunning) sidecar = null;
      stopAllPolls('sidecar stopped');
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        lastError = `sidecar exited during startup (code ${code}). `
          + 'Check that the requirements in tools/separation_sidecar/requirements.txt are installed.';
        startPromise = null;
        reject(new Error(lastError));
      }
    });
  });

  return startPromise;
}

async function stopSidecar() {
  stopAllPolls('shutting down');
  if (!sidecar) return false;
  const { proc } = sidecar;
  try {
    await sidecarFetch('/shutdown', { method: 'POST' });
  } catch {
    // The sidecar may already be gone, or wedged. Either way the kill below
    // is the backstop — never leave a detached Python holding a GPU.
  }
  sidecar = null;
  setTimeout(() => { try { proc.kill(); } catch {} }, 1500);
  return true;
}

// ── WAV writing ──────────────────────────────────────────────────────────

// 32-bit float RIFF. The renderer hands us the layer's RENDERED buffer (what
// the user is actually looking at and hearing, op-stack applied), so this is
// the one place the audio crosses from JS into a file the sidecar can read.
// Float, not 16-bit: the buffer can legitimately exceed ±1.0 after gain ops,
// and quantising here would bake in damage no later stage could undo.
function writeWavFloat32(filePath, channels, sampleRate) {
  const numChannels = channels.length;
  if (!numChannels) throw new Error('no channels to write');
  const numSamples = channels[0].length;
  const bytesPerSample = 4;
  const dataBytes = numSamples * numChannels * bytesPerSample;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);                                  // IEEE float
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  header.writeUInt16LE(numChannels * bytesPerSample, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);

  // Interleave through a Float32Array view rather than writeFloatLE per
  // sample: a three-minute stereo buffer is ~16 million samples, and the
  // per-call version turns "write the input file" into a visible stall
  // before the progress bar has anything to show.
  const data = Buffer.alloc(dataBytes);
  if (os.endianness() !== 'LE') {
    // WAV is little-endian by definition. No supported XLETH target is BE,
    // but failing loudly beats writing byte-swapped audio that decodes as
    // noise somewhere much further downstream.
    throw new Error('big-endian host: refusing to write a little-endian WAV');
  }
  const view = new Float32Array(data.buffer, data.byteOffset, numSamples * numChannels);
  let off = 0;
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numChannels; c++) view[off++] = channels[c][i];
  }

  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
  return filePath;
}

function safeName(text, fallback = 'layer') {
  const cleaned = String(text || '').replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/^[._ ]+|[._ ]+$/g, '');
  return cleaned.slice(0, 60) || fallback;
}

// ── Job progress polling ─────────────────────────────────────────────────

const polls = new Map(); // jobId -> { timer, inputPath }

function emit(channel, payload) {
  const w = getWin();
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

function stopPoll(jobId) {
  const entry = polls.get(jobId);
  if (!entry) return;
  clearInterval(entry.timer);
  polls.delete(jobId);
}

function stopAllPolls(reason) {
  for (const [jobId, entry] of polls) {
    clearInterval(entry.timer);
    emit('separation:progress', {
      id: jobId, state: 'error', phase: 'error', progress: 0,
      error: reason, stems: [],
    });
  }
  polls.clear();
}

function startPoll(jobId, inputPath) {
  stopPoll(jobId);
  const timer = setInterval(async () => {
    let job;
    try {
      job = await sidecarFetch(`/jobs/${jobId}`);
    } catch (e) {
      stopPoll(jobId);
      emit('separation:progress', {
        id: jobId, state: 'error', phase: 'error', progress: 0,
        error: e.message, stems: [],
      });
      return;
    }
    emit('separation:progress', job);
    if (job.state === 'done' || job.state === 'cancelled' || job.state === 'error') {
      stopPoll(jobId);
      // The input WAV was written purely to hand the audio to another
      // process — it is a copy of a buffer the engine already owns, so
      // keeping it around would just accumulate hundreds of MB per session.
      // The STEMS stay: layers hold a durable file reference to them, and a
      // project saved with a stem layer must still resolve after a restart.
      if (inputPath) { try { fs.unlinkSync(inputPath); } catch {} }
    }
  }, POLL_INTERVAL_MS);
  polls.set(jobId, { timer, inputPath });
}

// ── IPC ──────────────────────────────────────────────────────────────────

// Deliberately NOT main.js's safeHandler.
//
// safeHandler gates every call on the ENGINE worker being ready
// (`if (!isWorkerReady()) throw`). Separation does not touch the engine — it
// talks to a Python process — and gating it on the engine would mean that
// opening the Sample Sandbox while the engine is still starting leaves the
// separation strip permanently stuck reporting an error, because its status
// probe is a one-shot on mount.
//
// The one part of this feature that DOES need the engine is importing a
// finished stem as a layer, and that goes through audio.loadSourceRegion,
// which carries its own gate.
function handler(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      log(`[Separation] ${e && e.message ? e.message : e}`);
      throw e;
    }
  };
}

function init(deps) {
  if (deps && typeof deps.log === 'function') log = deps.log;
  if (deps && typeof deps.getWin === 'function') getWin = deps.getWin;

  // Non-starting status probe. The separation strip calls this on mount, and
  // it must NOT boot a Python process just to render three buttons.
  ipcMain.handle('xleth:separation:getStatus', handler(async () => {
    const py = resolvePython();
    // When the sidecar is already up, ask it what it can actually do. The
    // READY line's `device` is a snapshot from process start; /health is the
    // live answer and also names any missing packages, which is what lets the
    // strip say "onnxruntime is not installed" instead of offering a button
    // that fails 20 seconds and one 66 MB download later.
    let health = null;
    if (sidecar) {
      try { health = await sidecarFetch('/health'); } catch { health = null; }
    }
    return {
      running: !!sidecar,
      device: health ? health.device : (sidecar ? sidecar.device : null),
      runtimeOk: health ? !!health.ok : null,
      missing: health ? (health.missing || []) : null,
      runtimeError: health ? (health.error || null) : null,
      providers: health ? (health.providers || []) : null,
      port: sidecar ? sidecar.port : null,
      python: py ? { exe: py.realExe || py.exe, version: py.version, source: py.why } : null,
      sidecarRoot: sidecarRoot(),
      modelsDir: separationDataDir('models'),
      stemsDir: separationDataDir('stems'),
      lastError,
    };
  }));

  // Deep probe — spawns a Python to check imports. Called from the strip's
  // "why is this unavailable?" path, never on mount.
  ipcMain.handle('xleth:separation:checkEnvironment', handler(async () => {
    const py = resolvePython(true);
    if (!py) {
      return { ok: false, python: null, dependencies: null,
               error: 'No Python 3.9+ interpreter found.' };
    }
    const deps2 = probeDependencies(py);
    const missing = deps2 ? Object.entries(deps2).filter(([, ok]) => !ok).map(([m]) => m) : null;
    return {
      ok: !!deps2 && missing.length === 0,
      python: { exe: py.realExe || py.exe, version: py.version, source: py.why },
      dependencies: deps2,
      missing,
      error: !deps2 ? 'Could not probe the interpreter.'
        : missing.length ? `Missing Python packages: ${missing.join(', ')}` : null,
    };
  }));

  ipcMain.handle('xleth:separation:start', handler(async () => {
    await startSidecar();
    return { running: true, device: sidecar.device, port: sidecar.port };
  }));

  ipcMain.handle('xleth:separation:stop', handler(async () => ({ stopped: await stopSidecar() })));

  ipcMain.handle('xleth:separation:listModels', handler(async () => {
    await startSidecar();
    return sidecarFetch('/models');
  }));

  // Separate the PCM the renderer hands over. `payload` is
  //   { sampleRate, channels: [Float32Array, ...], name, tier, ensembleModelIds, deBleed }
  // The channels arrive by structured clone — no base64, no copy through a
  // string. See writeWavFloat32 for why the audio comes from the renderer
  // rather than from the layer's source file on disk.
  //
  // `tier` and `ensembleModelIds` are mutually exclusive on the wire — a
  // single tier string, or exactly two model ids to run and average. Sending
  // both would be ambiguous about which one the caller meant, so the ensemble
  // array wins when present rather than falling back to `tier || 'fast'`.
  ipcMain.handle('xleth:separation:separateBuffer', handler(async (_, payload) => {
    const { sampleRate, channels, name, tier, acknowledgeLicense, ensembleModelIds, deBleed } = payload || {};
    if (!Array.isArray(channels) || channels.length === 0) {
      throw new Error('separateBuffer: no channel data');
    }
    if (!(sampleRate > 0)) throw new Error('separateBuffer: bad sample rate');

    await startSidecar();

    const stamp = Date.now();
    const base = safeName(name);
    const inputPath = path.join(ensureDir(separationDataDir('work')), `${base}-${stamp}.wav`);
    const frames = channels[0].length;
    writeWavFloat32(inputPath, channels.map((c) => (c instanceof Float32Array ? c : Float32Array.from(c))), sampleRate);

    const outputDir = ensureDir(separationDataDir('stems', `${base}-${stamp}`));

    const modeFields = Array.isArray(ensembleModelIds) && ensembleModelIds.length
      ? { ensembleModelIds }
      : { tier: tier || 'fast' };

    let job;
    try {
      job = await sidecarFetch('/separate', {
        method: 'POST',
        body: JSON.stringify({
          inputPath, outputDir, label: base, ...modeFields,
          acknowledgeLicense: !!acknowledgeLicense,
          deBleed: !!deBleed,
          // The renderer knows the length before the job starts, and the
          // sidecar cannot derive it until it has read the file. Sending it
          // is what lets the progress split be computed from estimated
          // seconds rather than falling back to fixed weights.
          durationSec: frames / sampleRate,
        }),
      });
    } catch (e) {
      try { fs.unlinkSync(inputPath); } catch {}
      // A licence question is not a failure, and it must not reach the
      // renderer as one. Electron serialises a thrown Error by MESSAGE only,
      // dropping the structured detail — so this one case is returned rather
      // than thrown, and the store can put the question to the user and retry.
      if (e.status === 409 && e.detail) return { licenseRequired: e.detail };
      throw e;
    }

    startPoll(job.id, inputPath);
    return job;
  }));

  // Separate a file already on disk — the path used when a layer has no
  // rendered buffer to send (and by tests).
  ipcMain.handle('xleth:separation:separateFile', handler(async (_, opts) => {
    const { filePath, name, tier, acknowledgeLicense, durationSec } = opts || {};
    if (!filePath || !fs.existsSync(filePath)) throw new Error(`no such file: ${filePath}`);
    await startSidecar();
    const base = safeName(name || path.basename(filePath, path.extname(filePath)));
    const outputDir = ensureDir(separationDataDir('stems', `${base}-${Date.now()}`));
    let job;
    try {
      job = await sidecarFetch('/separate', {
        method: 'POST',
        body: JSON.stringify({
          inputPath: filePath, outputDir, tier: tier || 'fast', label: base,
          acknowledgeLicense: !!acknowledgeLicense,
          // Optional here: unlike the buffer path, nobody has decoded this
          // file yet. The sidecar falls back to fixed phase weights.
          durationSec: durationSec || null,
        }),
      });
    } catch (e) {
      if (e.status === 409 && e.detail) return { licenseRequired: e.detail };
      throw e;
    }
    // No inputPath handed to the poll: this file belongs to the user (or to
    // the engine), and deleting it on completion would destroy their source.
    startPoll(job.id, null);
    return job;
  }));

  ipcMain.handle('xleth:separation:getJob', handler(async (_, jobId) => {
    if (!sidecar) return null;
    return sidecarFetch(`/jobs/${jobId}`);
  }));

  ipcMain.handle('xleth:separation:cancel', handler(async (_, jobId) => {
    if (!sidecar) return { cancelled: false };
    const res = await sidecarFetch(`/jobs/${jobId}/cancel`, { method: 'POST' });
    return res;
  }));

  app.on('before-quit', () => { stopSidecar(); });
}

module.exports = {
  init,
  stopSidecar,
  isSeparationBusy: () => polls.size > 0,
  // exported for tests
  writeWavFloat32,
  safeName,
};
