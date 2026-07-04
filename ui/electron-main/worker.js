'use strict';

// ── Engine backend — fork addon-worker.js under system Node ──────────────────
// The addon links JUCE + FFmpeg + GLEW/GLFW and must run under system Node to
// avoid 0xFFFD0003 / 0xC0000005 crashes inside Electron's runtime. Zero-copy
// video via Windows named file mapping (shm_helper).
//
// Extracted verbatim from ui/main.js (S5 Stage 1 decomposition). This module
// owns the engine-worker lifecycle: forking addon-worker.js, the workerReady /
// addonError state, resolveSystemNodeExe, callWorker dispatch (with its 30s
// timeout), and the SILENT_METHODS log-suppression set. main.js wires it in
// via init({ log }) so all logging still lands in the shared startup.log.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { fork } = require('child_process');
const { runtimeResource } = require('../runtimePaths');

// Injected by main.js (init) — the shared startup.log logger.
let log = (msg) => { process.stdout.write(String(msg) + '\n'); };

function init(deps) {
  if (deps && typeof deps.log === 'function') log = deps.log;
}

function workerPathEnv(entries) {
  const pathEntries = entries.filter(Boolean);
  if (app.isPackaged) {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    pathEntries.push(path.join(systemRoot, 'System32'), systemRoot);
  } else if (process.env.PATH) {
    pathEntries.push(process.env.PATH);
  }
  return pathEntries.join(path.delimiter);
}

let workerReady = false;
let addonError = null;

let worker = null;
let nextMsgId = 1;
const pending = new Map();

function resolveSystemNodeExe() {
  if (process.env.XLETH_NODE_EXE) return process.env.XLETH_NODE_EXE;
  if (app.isPackaged) {
    return runtimeResource('node', process.platform === 'win32' ? 'node.exe' : 'node');
  }
  try {
    const { execFileSync } = require('child_process');
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(lookup, ['node'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  } catch (_) { /* fall through */ }
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
      path.join(os.homedir(), 'AppData', 'Roaming', 'nvm', 'nodejs', 'node.exe'),
      path.join(os.homedir(), 'scoop', 'apps', 'nodejs', 'current', 'node.exe'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

// High-frequency polling methods — suppress routine logs for these
const SILENT_METHODS = new Set(['getFrameRGBA', 'getCurrentFrame', 'getFrameBuffer', 'getTransportState', 'audio_getAllPeaks', 'audio_getRealtimeDiagnostics', 'audio_getAudioPerformanceTelemetry', 'getAudioPerformanceTelemetry', 'audio_setTrackVolume', 'audio_setTrackPan', 'audio_setTrackSpread', 'audio_setMasterVolume', 'cache_getWorldActiveJobs']);
// Last known transport state — only log when it actually changes
let lastTransportStateStr = null;

async function startWorker() {
  const bridgeDir = runtimeResource('bridge');
  const ffmpegDir = runtimeResource('ffmpeg');

  const workerPath = runtimeResource('worker', 'addon-worker.js');
  const nodeExe = resolveSystemNodeExe();
  log(`[Engine] fork mode — ${nodeExe} ${workerPath}`);
  log(`[Runtime] app.isPackaged=${app.isPackaged}`);
  log(`[Runtime] process.resourcesPath=${process.resourcesPath}`);
  log(`[Runtime] bridgeDir=${bridgeDir}`);
  log(`[Runtime] ffmpegDir=${ffmpegDir}`);

  if (!fs.existsSync(nodeExe)) {
    addonError = `Node.js executable not found: ${nodeExe}. Set XLETH_NODE_EXE or install Node to a standard location.`;
    log(`[startWorker] ${addonError}`);
    workerReady = false;
    throw new Error(addonError);
  }
  if (!fs.existsSync(bridgeDir)) {
    addonError = `Bridge addon not built — ${bridgeDir} is missing. Run: build bridge-clean`;
    log(`[startWorker] ${addonError}`);
    workerReady = false;
    throw new Error(addonError);
  }
  const addonPath = path.join(bridgeDir, 'xleth_native.node');
  if (!fs.existsSync(addonPath)) {
    addonError = `Bridge addon binary missing: ${addonPath}. Run: build bridge-clean`;
    log(`[startWorker] ${addonError}`);
    workerReady = false;
    throw new Error(addonError);
  }

  return new Promise((resolve, reject) => {
    worker = fork(workerPath, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execPath: nodeExe,
      cwd: bridgeDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        XLETH_BRIDGE_DIR: bridgeDir,
        XLETH_FFMPEG_DIR: ffmpegDir,
        PATH: workerPathEnv([bridgeDir, ffmpegDir]),
      },
      serialization: 'advanced',
    });
    // Forward C++ stdout/stderr into startup.log so proxy/engine logs are visible
    worker.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) { if (line) log(`[engine] ${line}`); }
    });
    worker.stderr.on('data', (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) { if (line) log(`[engine:err] ${line}`); }
    });
    let resolved = false;
    worker.on('message', (msg) => {
      if (msg && msg.ready) {
        workerReady = true;
        addonError = null;
        log('[Worker] ready');
        if (!resolved) { resolved = true; resolve(); }
        return;
      }
      if (msg && typeof msg.id === 'number') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) { p.reject(new Error(msg.error)); return; }
        if (msg.notImplemented) { p.reject(new Error('notImplemented')); return; }
        if (msg.frame) { p.resolve({ width: msg.frame.w, height: msg.frame.h, pixels: msg.frame.data }); return; }
        p.resolve(msg.result === undefined ? null : msg.result);
      }
    });
    worker.on('exit', (code) => {
      log(`[Worker] exited code=${code}`);
      workerReady = false;
      addonError = `worker exited (code ${code})`;
      for (const p of pending.values()) p.reject(new Error(addonError));
      pending.clear();
      if (!resolved) { resolved = true; reject(new Error(addonError)); }
    });
    worker.on('error', (err) => {
      log(`[Worker] spawn error: ${err.message}`);
      workerReady = false;
      addonError = err.message;
      if (!resolved) { resolved = true; reject(err); }
    });
  });
}

// Dispatches to the engine worker. Returns a Promise.
function callWorker(method, args = []) {
  if (!workerReady) {
    return Promise.reject(new Error('Engine not ready: ' + (addonError || 'starting')));
  }
  if (!SILENT_METHODS.has(method)) {
    log(`[IPC] → ${method}(${args.map(a => typeof a === 'object' ? JSON.stringify(a).slice(0, 60) : a).join(', ')})`);
  }
  const id = nextMsgId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Engine command timed out: ${method}`));
    }, 30_000);
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        if (method === 'getTransportState') {
          const str = JSON.stringify(result);
          if (str !== lastTransportStateStr) {
            log(`[IPC] transport changed: ${str}`);
            lastTransportStateStr = str;
          }
        } else if (!SILENT_METHODS.has(method)) {
          log(`[IPC] ← result: ${JSON.stringify(result).slice(0, 80)}`);
        }
        resolve(result);
      },
      reject: (err) => {
        clearTimeout(timer);
        log(`[IPC] ← error (${method}): ${err.message}`);
        reject(err);
      },
    });
    worker.send({ id, method, args });
  });
}

// ── State accessors for main.js ───────────────────────────────────────────────
// main.js used to read/write these as module-level variables; after the
// extraction they live here and main.js goes through these accessors.

function isWorkerReady() { return workerReady; }
function getAddonError() { return addonError; }
function setAddonError(msg) { addonError = msg; }
function killWorker() { worker?.kill(); }

module.exports = {
  init,
  startWorker,
  callWorker,
  isWorkerReady,
  getAddonError,
  setAddonError,
  killWorker,
};
