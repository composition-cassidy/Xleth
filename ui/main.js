'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { fork } = require('child_process');
const { runtimeResource, userDataPath } = require('./runtimePaths');

// Fixed name for the Windows file mapping that backs the FrameOutput double
// buffer. The forked addon-worker creates it via FrameOutput::initSharedMemory;
// the Electron main process / preload opens the same name via shm_helper.node.
const FRAME_SHM_NAME = 'XlethFrameBuffer';


// ── User settings (persisted across sessions, not per-project) ───────────────
const settingsPath = userDataPath('xleth-settings.json')
const layoutPath = userDataPath('layout.json')
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch { return {} }
}
function saveSettings(s) {
  try { fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf8') } catch {}
}

// Log file for startup debugging
const logPath = userDataPath('startup.log');
try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
fs.writeFileSync(logPath, '');  // clear previous log
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(logPath, line);
}

function ffmpegExecutable() {
  const exe = runtimeResource('ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (app.isPackaged || fs.existsSync(exe)) return exe;
  return 'ffmpeg';
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

// Register custom media protocol so renderer can play local files without CORS/CSP issues
// Must be called before app.whenReady()
protocol.registerSchemesAsPrivileged([
  { scheme: 'xleth-media', privileges: { secure: true, standard: true, stream: true } },
]);

// ── Local HTTP media server for <video> elements ─────────────────────────────
// Chromium blocks custom protocols for <video>/<audio> src. A local HTTP server
// with proper Range support lets the browser's hardware video decoder work.
let mediaPort = 0;

function startMediaServer() {
  const MIME_TYPES = {
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  };

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const filePath = decodeURIComponent(url.searchParams.get('path') || '');

      if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const range = req.headers.range;

      if (range) {
        const match = range.match(/bytes=(\d+)-(\d*)/);
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : Math.min(start + 1024 * 1024, fileSize - 1);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Accept-Ranges': 'bytes',
          'Content-Length': fileSize,
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        fs.createReadStream(filePath).pipe(res);
      }
    } catch (err) {
      log(`[MediaServer] Error: ${err.message}`);
      res.writeHead(500);
      res.end('Internal error');
    }
  });

  server.listen(0, '127.0.0.1', () => {
    mediaPort = server.address().port;
    log(`[MediaServer] Listening on port ${mediaPort}`);
  });

  return server;
}

// ── Native addon hosted in a forked Node.js child process ────────────────────
// The addon links JUCE + FFmpeg + GLEW/GLFW. Loading it in the Electron main
// process or utilityProcess crashed natively (0xFFFD0003 / 0xC0000005). A
// child_process.fork runs under system Node with its own DLL search and
// initialization, which reliably loads the addon. Zero-copy video delivery
// uses a Windows named file mapping (shm_helper) instead of SAB transfer.

let worker = null;
let workerReady = false;
let addonError = null;
let nextMsgId = 1;
const pending = new Map();

// High-frequency polling methods — suppress routine logs for these
const SILENT_METHODS = new Set(['getFrameRGBA', 'getCurrentFrame', 'getFrameBuffer', 'getTransportState', 'audio_getAllPeaks', 'audio_setTrackVolume', 'audio_setTrackPan', 'audio_setTrackSpread', 'audio_setMasterVolume', 'cache_getWorldActiveJobs']);
// Last known transport state — only log when it actually changes
let lastTransportStateStr = null;
let autosaveIntervalId = null;

function resolveSystemNodeExe() {
  // 1. Explicit override always wins.
  if (process.env.XLETH_NODE_EXE) return process.env.XLETH_NODE_EXE;
  // 2. Packaged build — use the bundled binary shipped under resources/.
  if (app.isPackaged) {
    return runtimeResource('node', process.platform === 'win32' ? 'node.exe' : 'node');
  }
  // 3. Dev build — resolve to an absolute path so child_process.fork doesn't
  //    rely on Electron's process.env.PATH being identical to the shell PATH.
  //    Bare 'node.exe' fails with ENOENT on Windows when CreateProcess can't
  //    find it in the parent's environment block.
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
  // Last resort — let fork() try its luck and surface ENOENT to the UI.
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function startWorker() {
  const workerPath = runtimeResource('worker', 'addon-worker.js');
  const bridgeDir = runtimeResource('bridge');
  const ffmpegDir = runtimeResource('ffmpeg');
  // Force system node.exe — not electron.exe --run-as-node — because the
  // JUCE/FFmpeg static initializers crash inside Electron's runtime.
  // The addon is ABI-compatible with recent Node versions.
  const nodeExe = resolveSystemNodeExe();
  log(`Forking addon worker via ${nodeExe}: ${workerPath}`);
  log(`[Runtime] app.isPackaged=${app.isPackaged}`);
  log(`[Runtime] process.resourcesPath=${process.resourcesPath}`);
  log(`[Runtime] bridgeDir=${bridgeDir}`);
  log(`[Runtime] ffmpegDir=${ffmpegDir}`);

  // Pre-flight checks — fork() throws a confusing ENOENT for ANY missing
  // file in the spawn args (executable, cwd, addon). Surface clear errors.
  if (!fs.existsSync(nodeExe)) {
    addonError = `Node.js executable not found: ${nodeExe}. Set XLETH_NODE_EXE or install Node to a standard location.`;
    log(`[startWorker] ${addonError}`);
    workerReady = false;
    return;
  }
  if (!fs.existsSync(bridgeDir)) {
    addonError = `Bridge addon not built — ${bridgeDir} is missing. Run: build bridge-clean`;
    log(`[startWorker] ${addonError}`);
    workerReady = false;
    return;
  }
  const addonPath = path.join(bridgeDir, 'xleth_native.node');
  if (!fs.existsSync(addonPath)) {
    addonError = `Bridge addon binary missing: ${addonPath}. Run: build bridge-clean`;
    log(`[startWorker] ${addonError}`);
    workerReady = false;
    return;
  }
  worker = fork(workerPath, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    execPath: nodeExe,
    cwd: bridgeDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      XLETH_BRIDGE_DIR: bridgeDir,
      XLETH_FFMPEG_DIR: ffmpegDir,
      PATH: workerPathEnv([bridgeDir, ffmpegDir]),
    },
    serialization: 'advanced',  // preserves Buffer/TypedArray/ArrayBuffer across IPC
  });

  worker.on('message', (msg) => {
    if (msg && msg.ready) {
      workerReady = true;
      log('[Worker] ready');
      // Apply saved global stretch defaults to engine on startup
      const saved = loadSettings()
      if (saved.globalStretchMethod != null)
        callWorker('engine_setGlobalStretchMethod', [saved.globalStretchMethod]).catch(() => {})
      if (saved.globalFormantPreserve != null)
        callWorker('engine_setGlobalFormantPreserve', [saved.globalFormantPreserve]).catch(() => {})
      setInterval(pollWorldProcessing, 100)
      restartAutosaveTimer()
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
    for (const { reject } of pending.values()) reject(new Error(addonError));
    pending.clear();
  });
}

// Dispatches to the forked child via IPC. Returns a Promise.
function callWorker(method, args = []) {
  if (!workerReady) {
    return Promise.reject(new Error('Engine not ready: ' + (addonError || 'starting')));
  }
  if (!SILENT_METHODS.has(method)) {
    log(`[IPC] → ${method}(${args.map(a => typeof a === 'object' ? JSON.stringify(a).slice(0, 60) : a).join(', ')})`);
  }
  const id = nextMsgId++;
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (result) => {
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
        log(`[IPC] ← error (${method}): ${err.message}`);
        reject(err);
      },
    });
    worker.send({ id, method, args });
  });
}

// ── BrowserWindow ─────────────────────────────────────────────────────────────

let win = null;
let splashWin = null;
const DEFAULT_ZOOM_FACTOR = 1;
const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 3;
const ZOOM_STEP = 0.1;

function clampZoomFactor(factor) {
  return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, factor));
}

function getTargetWindow(event) {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow && !senderWindow.isDestroyed()) return senderWindow;
  return win;
}

function setWindowZoom(targetWindow, factor) {
  const wc = targetWindow?.webContents;
  if (!wc || wc.isDestroyed()) return DEFAULT_ZOOM_FACTOR;

  const nextFactor = clampZoomFactor(Number(factor.toFixed(2)));
  wc.setZoomFactor(nextFactor);
  return nextFactor;
}

function nudgeWindowZoom(targetWindow, direction) {
  const wc = targetWindow?.webContents;
  if (!wc || wc.isDestroyed()) return DEFAULT_ZOOM_FACTOR;

  return setWindowZoom(targetWindow, wc.getZoomFactor() + (direction * ZOOM_STEP));
}
const nodeEditorWindows = new Map(); // key → BrowserWindow

function splashStatus(msg) {
  if (splashWin && !splashWin.isDestroyed()) {
    splashWin.webContents.send('splash:status', msg);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0A0A0F',
    frame: false,
    show: false,
    webPreferences: {
      // contextIsolation disabled so preload can hand the renderer a live
      // ArrayBuffer reference (shm_helper's file-mapped view). With isolation
      // on, contextBridge would structured-clone the buffer → dead copy.
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      preload: runtimeResource('app', 'preload.js'),
    },
  });

  if (addonError) {
    const msg = encodeURIComponent(addonError);
    win.loadURL(`data:text/html,<pre style="color:red;background:%230A0A0F;padding:20px">Addon error:\n${msg}</pre>`);
  } else if (process.env.XLETH_PLAYWRIGHT === '1' || app.isPackaged) {
    win.loadFile(runtimeResource('app', 'dist', 'index.html'));
  } else {
    win.loadURL('http://localhost:5173');
  }

  // Pipe all renderer console output to startup.log so we can read it externally
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    const prefix = level === 3 ? '[RENDERER ERROR]' : level === 2 ? '[RENDERER WARN]' : '[RENDERER]';
    log(`${prefix} ${message}  (${source}:${line})`);
  });

  win.on('closed', () => {
    for (const [, child] of nodeEditorWindows) {
      if (!child.isDestroyed()) child.close();
    }
    nodeEditorWindows.clear();
    win = null;
  });
}

// ── IPC helpers ───────────────────────────────────────────────────────────────

function safeHandler(fn) {
  return async (...args) => {
    if (!workerReady) throw new Error('Engine not ready: ' + (addonError || 'starting'));
    return fn(...args);
  };
}

// Broadcast graph-changed event to all windows (main + node editor children)
function broadcastGraphChanged(key) {
  const { webContents } = require('electron');
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send('xleth:graph:changed', key);
  }
}

// Wraps a graph mutation handler to broadcast after the mutation resolves
function graphHandler(keyFn, fn) {
  return safeHandler(async (...args) => {
    const result = await fn(...args);
    broadcastGraphChanged(keyFn(...args));
    return result;
  });
}

// ── Phase 0 handlers (backward compat) ───────────────────────────────────────

ipcMain.handle('xleth:play',           safeHandler(() => callWorker('play')));
ipcMain.handle('xleth:stop',           safeHandler(() => callWorker('stop')));
ipcMain.handle('xleth:pause',          safeHandler(() => callWorker('pause')));
ipcMain.handle('xleth:trigger',    safeHandler((_, id, vel) => callWorker('triggerSample', [id, vel ?? 1.0])));
ipcMain.handle('xleth:transportState', safeHandler(() => callWorker('getTransportState')));
ipcMain.handle('xleth:currentFrame',   safeHandler(() => callWorker('getFrameRGBA')));
ipcMain.handle('xleth:frameRGBA',      safeHandler(() => callWorker('getFrameRGBA')));
ipcMain.handle('xleth:syncStats',      safeHandler(() => callWorker('getSyncStats')));
ipcMain.handle('xleth:setVideoResolution', safeHandler((_, w, h) => callWorker('setVideoResolution', [w, h])));

// ── Video frame output: Windows named shared memory ─────────────────────────
// The forked worker creates a named file mapping and writes the double-buffer
// there; the renderer (via preload.js + shm_helper.node) opens the same name
// and reads frames with zero copies. Main only tells the renderer the name
// and metadata — no buffer crosses IPC.
let frameShmMeta = null;  // { name, width, height, bufferSize, indexOffset, totalSize }

async function ensureFrameShm(width, height) {
  if (frameShmMeta && frameShmMeta.width === width && frameShmMeta.height === height) {
    return frameShmMeta;
  }
  const res = await callWorker('initVideoSharedMemory', [FRAME_SHM_NAME, width, height]);
  frameShmMeta = {
    name:        res.name,
    width:       res.width,
    height:      res.height,
    bufferSize:  res.bufferSize,
    indexOffset: res.indexOffset,
    totalSize:   res.totalSize,
  };
  log(`[IPC] ← shm ready: ${JSON.stringify(frameShmMeta)}`);
  return frameShmMeta;
}

ipcMain.handle('xleth:video:getFrameShm', safeHandler(async (_, width, height) => {
  const w = width | 0 || 960;
  const h = height | 0 || 540;
  return await ensureFrameShm(w, h);
}));

ipcMain.handle('xleth:readStartupLog', () => {
  try { return fs.readFileSync(logPath, 'utf8'); } catch { return '(log unavailable)'; }
});

ipcMain.handle('xleth:importVideo', safeHandler(async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Video',
    filters: [
      { name: 'Video Files', extensions: ['mp4', 'avi', 'mkv', 'mov', 'webm', 'wmv'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;

  await callWorker('clearTimeline');

  await callWorker('setBPM', [140]);
  const drumPattern = [
    { offset: 0.00, id: 0 },
    { offset: 1.00, id: 2 },
    { offset: 1.25, id: 2 },
    { offset: 2.00, id: 0 },
    { offset: 2.00, id: 1 },
    { offset: 3.00, id: 2 },
    { offset: 3.25, id: 2 },
  ];
  for (let bar = 0; bar < 8; bar++) {
    for (const hit of drumPattern) {
      await callWorker('addAudioEvent', [bar * 4 + hit.offset, hit.id, 1.0]);
    }
  }

  const sourceId = await callWorker('loadVideo', [filePaths[0]]);
  log(`Video loaded: sourceId=${sourceId}`);

  const drums = {
    0: { sourceTime: 30, layer: 0, x: 0,       y: 2/3, w: 1/3, h: 1/3 },
    2: { sourceTime: 60, layer: 1, x: 1/3,     y: 2/3, w: 1/3, h: 1/3 },
    1: { sourceTime: 90, layer: 2, x: 2/3,     y: 2/3, w: 1/3, h: 1/3 },
  };
  const hitDuration = { 0: 0.5, 1: 0.5, 2: 0.25 };

  for (let bar = 0; bar < 8; bar++) {
    for (const hit of drumPattern) {
      const d = drums[hit.id];
      await callWorker('addVideoEvent', [{
        startBeat:       bar * 4 + hit.offset,
        durationBeats:   hitDuration[hit.id],
        sourceId,
        sourceStartTime: d.sourceTime,
        layerIndex:      d.layer,
        x: d.x, y: d.y,
        width: d.w, height: d.h,
        opacity: 1,
      }]);
    }
  }

  log(`Video chopped: ${8 * drumPattern.length} events`);
  return filePaths[0];
}));

// ── Phase 1 handlers — Project ────────────────────────────────────────────────

ipcMain.handle('xleth:project:create',
  safeHandler((_, dir, name) => callWorker('project_create', [dir, name])));

ipcMain.handle('xleth:project:save',
  safeHandler(() => callWorker('project_save')));

ipcMain.handle('xleth:project:saveAs',
  safeHandler((_, dir, name) => callWorker('project_saveAs', [dir, name])));

ipcMain.handle('xleth:project:hasProjectDir',
  safeHandler(() => callWorker('project_hasProjectDir')));

ipcMain.handle('xleth:project:load',
  safeHandler(async (_, dir) => {
    const result = await callWorker('project_load', [dir]);
    // Notify all renderers that the project was loaded — all effect chain
    // nodeIds have been reassigned by AudioGraph::fromJSON and any cached
    // nodeIds in the UI are now stale.
    const { webContents } = require('electron');
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send('xleth:project-loaded');
    }
    restartAutosaveTimer()
    return result;
  }));

ipcMain.handle('xleth:project:importSource',
  safeHandler((_, filePath) => callWorker('project_importSource', [filePath])));

ipcMain.handle('xleth:project:validateMedia',
  safeHandler(() => callWorker('project_validateMedia')));

ipcMain.handle('xleth:project:getInfo',
  safeHandler(() => callWorker('project_getInfo')));

ipcMain.handle('xleth:project:isDirty',
  safeHandler(() => callWorker('project_isDirty')));

ipcMain.handle('xleth:project:newBlank',
  safeHandler(async () => {
    const result = await callWorker('project_newBlank');
    // Broadcast so renderers drop any stale per-project state (plugin editor
    // refs, piano roll / mixer selections, etc.) — same pattern as project:load.
    if (result && result.ok) {
      const { webContents } = require('electron');
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed()) wc.send('xleth:project-loaded');
      }
      restartAutosaveTimer()
    }
    return result;
  }));

ipcMain.handle('xleth:project:isExportRunning',
  safeHandler(() => callWorker('project_isExportRunning')));

// ── Phase 1 handlers — Timeline queries ──────────────────────────────────────

ipcMain.handle('xleth:timeline:getBPM',
  safeHandler(() => callWorker('timeline_getBPM')));

ipcMain.handle('xleth:timeline:getTempoLocked',
  safeHandler(() => callWorker('timeline_getTempoLocked')));

ipcMain.handle('xleth:timeline:getDeclickMs',
  safeHandler(() => callWorker('timeline_getDeclickMs')));

ipcMain.handle('xleth:timeline:setDeclickMs',
  safeHandler((_, ms) => callWorker('timeline_setDeclickMs', [ms])));

ipcMain.handle('xleth:timeline:getSources',
  safeHandler(() => callWorker('timeline_getSources')));

ipcMain.handle('xleth:timeline:getRegions',
  safeHandler(() => callWorker('timeline_getRegions')));

ipcMain.handle('xleth:timeline:getRegionsByLabel',
  safeHandler((_, label) => callWorker('timeline_getRegionsByLabel', [label])));

ipcMain.handle('xleth:timeline:getTracks',
  safeHandler(() => callWorker('timeline_getTracks')));

ipcMain.handle('xleth:timeline:getClips',
  safeHandler(() => callWorker('timeline_getClips')));

ipcMain.handle('xleth:timeline:getClipsOnTrack',
  safeHandler((_, trackId) => callWorker('timeline_getClipsOnTrack', [trackId])));

ipcMain.handle('xleth:timeline:getClipsInRange',
  safeHandler((_, startBeat, endBeat) => callWorker('timeline_getClipsInRange', [startBeat, endBeat])));

// ── Phase 1 handlers — Timeline mutations ────────────────────────────────────

ipcMain.handle('xleth:timeline:setBPM',
  safeHandler((_, bpm) => callWorker('timeline_setBPM', [bpm])));

ipcMain.handle('xleth:timeline:setTempoLocked',
  safeHandler((_, locked) => callWorker('timeline_setTempoLocked', [locked])));

ipcMain.handle('xleth:timeline:addTrack',
  safeHandler((_, info) => callWorker('timeline_addTrack', [info])));

ipcMain.handle('xleth:timeline:removeTrack',
  safeHandler((_, id) => callWorker('timeline_removeTrack', [id])));

ipcMain.handle('xleth:timeline:setTrackMuted',
  safeHandler((_, trackId, muted) => callWorker('timeline_setTrackMuted', [trackId, muted])));

ipcMain.handle('xleth:timeline:setTrackVisualOnly',
  safeHandler((_, trackId, visualOnly) => callWorker('timeline_setTrackVisualOnly', [trackId, visualOnly])));

ipcMain.handle('xleth:timeline:setTrackSolo',
  safeHandler((_, trackId, solo) => callWorker('timeline_setTrackSolo', [trackId, solo])));

ipcMain.handle('xleth:timeline:setTrackName',
  safeHandler((_, trackId, name) => callWorker('timeline_setTrackName', [trackId, name])));

ipcMain.handle('xleth:timeline:setPatternName',
  safeHandler((_, patternId, name) => callWorker('timeline_setPatternName', [patternId, name])));

ipcMain.handle('xleth:timeline:setPatternRegion',
  safeHandler((_, patternId, regionId) => callWorker('timeline_setPatternRegion', [patternId, regionId])));

ipcMain.handle('xleth:timeline:convertToPatternTrack',
  safeHandler((_, trackId) => callWorker('timeline_convertToPatternTrack', [trackId])));

ipcMain.handle('xleth:timeline:convertToClipTrack',
  safeHandler((_, trackId) => callWorker('timeline_convertToClipTrack', [trackId])));

ipcMain.handle('xleth:timeline:setVideoFlipConfig',
  safeHandler((_, trackId, config) => callWorker('timeline_setVideoFlipConfig', [trackId, config])));

ipcMain.handle('xleth:timeline:setVideoHoldLastFrame',
  safeHandler((_, trackId, hold) => callWorker('timeline_setVideoHoldLastFrame', [trackId, hold])));

ipcMain.handle('xleth:timeline:setTrackCornerRadius',
  safeHandler((_, trackId, v) => callWorker('timeline_setTrackCornerRadius', [trackId, v])));

ipcMain.handle('xleth:timeline:setTrackGapScaleOverride',
  safeHandler((_, trackId, v) => callWorker('timeline_setTrackGapScaleOverride', [trackId, v])));

ipcMain.handle('xleth:timeline:setTrackSubdivisionFactor',
  safeHandler((_, trackId, factor) => callWorker('timeline_setTrackSubdivisionFactor', [trackId, factor])));

ipcMain.handle('xleth:timeline:setTrackBounceSettings',
  safeHandler((_, trackId, bounce) => callWorker('timeline_setTrackBounceSettings', [trackId, bounce])));

ipcMain.handle('xleth:timeline:setTrackZoomPanRotSettings',
  safeHandler((_, trackId, zpr) => callWorker('timeline_setTrackZoomPanRotSettings', [trackId, zpr])));

ipcMain.handle('xleth:timeline:setTrackPingPongSettings',
  safeHandler((_, trackId, pp) => callWorker('timeline_setTrackPingPongSettings', [trackId, pp])));

ipcMain.handle('xleth:timeline:setTrackSlideNoteEffect',
  safeHandler((_, trackId, s) => callWorker('timeline_setTrackSlideNoteEffect', [trackId, s])));

ipcMain.handle('xleth:timeline:getPreviewResolutionScale',
  safeHandler(() => callWorker('timeline_getPreviewResolutionScale', [])));
ipcMain.handle('xleth:timeline:setPreviewResolutionScale',
  safeHandler((_, scale) => callWorker('timeline_setPreviewResolutionScale', [scale])));
ipcMain.handle('xleth:timeline:getPreviewEffectsBypass',
  safeHandler(() => callWorker('timeline_getPreviewEffectsBypass', [])));
ipcMain.handle('xleth:timeline:setPreviewEffectsBypass',
  safeHandler((_, bypass) => callWorker('timeline_setPreviewEffectsBypass', [bypass])));

ipcMain.handle('xleth:timeline:setNoteSlide',
  safeHandler((_, patternId, noteId, isSlide, cx, cy) =>
    callWorker('timeline_setNoteSlide', [patternId, noteId, isSlide, cx, cy])));

ipcMain.handle('xleth:timeline:addVisualEffect',
  safeHandler((_, trackId, effectType) => callWorker('timeline_addVisualEffect', [trackId, effectType])));
ipcMain.handle('xleth:timeline:removeVisualEffect',
  safeHandler((_, trackId, idx) => callWorker('timeline_removeVisualEffect', [trackId, idx])));
ipcMain.handle('xleth:timeline:reorderVisualEffect',
  safeHandler((_, trackId, from, to) => callWorker('timeline_reorderVisualEffect', [trackId, from, to])));
ipcMain.handle('xleth:timeline:setVisualEffectParam',
  safeHandler((_, trackId, ei, pi, val) => callWorker('timeline_setVisualEffectParam', [trackId, ei, pi, val])));
ipcMain.handle('xleth:timeline:setVisualEffectBypassed',
  safeHandler((_, trackId, ei, bypassed) => callWorker('timeline_setVisualEffectBypassed', [trackId, ei, bypassed])));
ipcMain.handle('xleth:timeline:getVisualEffectChain',
  safeHandler((_, trackId) => callWorker('timeline_getVisualEffectChain', [trackId])));
ipcMain.handle('xleth:timeline:setTrackVisualEffectChainOrder',
  safeHandler((_, trackId, newOrder) => callWorker('timeline_setTrackVisualEffectChainOrder', [trackId, newOrder])));

ipcMain.handle('xleth:timeline:addClip',
  safeHandler((_, clip) => callWorker('timeline_addClip', [clip])));

ipcMain.handle('xleth:timeline:removeClip',
  safeHandler((_, id) => callWorker('timeline_removeClip', [id])));

ipcMain.handle('xleth:timeline:moveClip',
  safeHandler((_, id, trackId, posTicks) => callWorker('timeline_moveClip', [id, trackId, posTicks])));

ipcMain.handle('xleth:timeline:resizeClip',
  safeHandler((_, id, durTicks) => callWorker('timeline_resizeClip', [id, durTicks])));

ipcMain.handle('xleth:timeline:resizeClipLeft',
  safeHandler((_, id, posTicks, durTicks, offsetTicks) => callWorker('timeline_resizeClipLeft', [id, posTicks, durTicks, offsetTicks])));

ipcMain.handle('xleth:timeline:stretchClip',
  safeHandler((_, id, durTicks) => callWorker('timeline_stretchClip', [id, durTicks])));

ipcMain.handle('xleth:timeline:stretchClipLeft',
  safeHandler((_, id, posTicks, durTicks) => callWorker('timeline_stretchClipLeft', [id, posTicks, durTicks])));

ipcMain.handle('xleth:timeline:pitchShiftClip',
  safeHandler((_, id, semi, cents) => callWorker('timeline_pitchShiftClip', [id, semi, cents])));

ipcMain.handle('xleth:timeline:reverseClip',
  safeHandler((_, id) => callWorker('timeline_reverseClip', [id])));

ipcMain.handle('xleth:timeline:autoTrimClip',
  safeHandler((_, id, thresholdDb) => callWorker('timeline_autoTrimClip', [id, thresholdDb])));

ipcMain.handle('xleth:timeline:spliceClipsAtPlayhead',
  safeHandler((_, entries) => callWorker('timeline_spliceClipsAtPlayhead', [entries])));

ipcMain.handle('xleth:timeline:setClipParams',
  safeHandler((_, id, params) => callWorker('timeline_setClipParams', [id, params])));

// ── Global clip-processing defaults ─────────────────────────────────────────
ipcMain.handle('xleth:settings:get',    (_, key) => loadSettings()[key])
ipcMain.handle('xleth:settings:set',    (_, key, value) => {
  const s = loadSettings(); s[key] = value; saveSettings(s)
})
ipcMain.handle('xleth:autosave:restart', () => { restartAutosaveTimer() })

// ── Autosave timer ────────────────────────────────────────────────────────────

function startAutosaveTimer(intervalMs) {
  if (autosaveIntervalId !== null) {
    clearInterval(autosaveIntervalId)
    autosaveIntervalId = null
  }
  if (!(intervalMs > 0)) return
  autosaveIntervalId = setInterval(async () => {
    try {
      if (!workerReady) return
      if (exportProgressInterval !== null || videoExportProgressInterval !== null) return
      const hasProjDir = await callWorker('project_hasProjectDir')
      if (!hasProjDir) return
      const dirty = await callWorker('project_isDirty')
      if (!dirty) return
      const ts = await callWorker('getTransportState')
      if (ts && ts.isPlaying) return
      await callWorker('project_save')
      log('[autosave] Project saved automatically')
    } catch (err) {
      log('[autosave] Save failed:', err && err.message)
    }
  }, intervalMs)
}

function restartAutosaveTimer() {
  const settings = loadSettings()
  const minutes = settings.autosaveInterval ?? 5
  startAutosaveTimer(minutes > 0 ? minutes * 60 * 1000 : 0)
}

// ── Phase 7 — Preview visibility (panel show/hide) ─────────────────────────
ipcMain.handle('xleth:preview:setEnabled',
  safeHandler((_, enabled) => callWorker('preview_setEnabled', [Boolean(enabled)])));

// ── Themes (persisted to userData/themes/<slug>.json) ─────────────────────────
// User-authored theme files. Shipped themes are bundled with the renderer and
// don't hit disk — they're imported directly from ui/src/theming/shipped/.
ipcMain.handle('xleth:layout:read', () => {
  try { return fs.readFileSync(layoutPath, 'utf8') } catch { return null }
})
ipcMain.handle('xleth:layout:write', (_, raw) => {
  if (typeof raw !== 'string') throw new Error('layout payload must be a string')
  fs.writeFileSync(layoutPath, raw, 'utf8')
  return true
})

const themesDir = userDataPath('themes')
function ensureThemesDir() {
  try { fs.mkdirSync(themesDir, { recursive: true }) } catch {}
}
function themeSlugSafe(slug) {
  // Defence-in-depth: slugs come from the renderer and become filesystem
  // paths. Permit letters, digits, dash, underscore only.
  return typeof slug === 'string' && /^[A-Za-z0-9_-]+$/.test(slug) && slug.length <= 64
}
function themePath(slug) { return path.join(themesDir, `${slug}.json`) }

ipcMain.handle('xleth:theme:loadUser', (_, slug) => {
  if (!themeSlugSafe(slug)) throw new Error('invalid theme slug')
  try { return JSON.parse(fs.readFileSync(themePath(slug), 'utf8')) }
  catch { return null }
})
ipcMain.handle('xleth:theme:saveUser', (_, slug, theme) => {
  if (!themeSlugSafe(slug)) throw new Error('invalid theme slug')
  if (!theme || typeof theme !== 'object') throw new Error('theme must be an object')
  ensureThemesDir()
  fs.writeFileSync(themePath(slug), JSON.stringify(theme, null, 2), 'utf8')
  return true
})
ipcMain.handle('xleth:theme:listUser', () => {
  ensureThemesDir()
  let entries = []
  try { entries = fs.readdirSync(themesDir) } catch { return [] }
  return entries
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5))
    .filter(themeSlugSafe)
})
ipcMain.handle('xleth:theme:deleteUser', (_, slug) => {
  if (!themeSlugSafe(slug)) throw new Error('invalid theme slug')
  try { fs.unlinkSync(themePath(slug)); return true } catch { return false }
})
// ── Stock plugin UI layouts (userData/plugin-ui/<pluginId>.json) ──────────────
// Mirrors the user-themes pattern. Does NOT require the engine worker to be
// ready — layout files are pure JSON on disk, no C++ involvement.

const pluginUiDir = userDataPath('plugin-ui')
const KNOWN_PLUGIN_IDS = new Set(['compressor', 'limiter', 'transientproc', 'overdone', 'distortion'])
const PLUGIN_UI_LAYOUT_KIND = 'plugin-ui-layout'
const SHIPPED_PLUGIN_UI_LAYOUT_FILES = {
  compressor:    runtimeResource('app', 'src', 'plugin-ui', 'layouts', 'compressor.json'),
  limiter:       runtimeResource('app', 'src', 'plugin-ui', 'layouts', 'limiter.json'),
  transientproc: runtimeResource('app', 'src', 'plugin-ui', 'layouts', 'transient.json'),
  overdone:      runtimeResource('app', 'src', 'plugin-ui', 'layouts', 'overdone.json'),
  distortion:    runtimeResource('app', 'src', 'plugin-ui', 'layouts', 'distortion.json'),
}

function pluginIdSafe(id) {
  return typeof id === 'string' && /^[a-z][a-z0-9_-]*$/.test(id) && id.length <= 64
    && KNOWN_PLUGIN_IDS.has(id)
}

function pluginUiPath(pluginId) {
  if (!pluginIdSafe(pluginId)) throw new Error('invalid pluginId')
  const base = path.resolve(pluginUiDir)
  const target = path.resolve(base, `${pluginId}.json`)
  if (target !== path.join(base, `${pluginId}.json`)) throw new Error('invalid pluginId')
  if (!target.startsWith(base + path.sep)) throw new Error('invalid pluginId')
  return target
}

function ensurePluginUiDir() {
  try { fs.mkdirSync(pluginUiDir, { recursive: true }) } catch {}
}

function broadcastPluginUiChanged(pluginId) {
  const { webContents } = require('electron')
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send('xleth:pluginUi:changed', pluginId)
  }
}

ipcMain.handle('xleth:pluginUi:loadUserOverride', (_, pluginId) => {
  if (!pluginIdSafe(pluginId)) throw new Error('invalid pluginId')
  try {
    const raw = fs.readFileSync(pluginUiPath(pluginId), 'utf8')
    return JSON.parse(raw)
  } catch { return null }
})

function validateLayoutStructure(layout, pluginId) {
  if (!layout || typeof layout !== 'object') return 'layout must be an object'
  if (layout.$xleth !== undefined && layout.$xleth !== PLUGIN_UI_LAYOUT_KIND) return 'invalid $xleth discriminator'
  if (!Number.isInteger(layout.schemaVersion)) return 'missing schemaVersion'
  if (typeof layout.pluginId !== 'string') return 'missing pluginId'
  if (pluginId && layout.pluginId !== pluginId) return `pluginId "${layout.pluginId}" does not match "${pluginId}"`
  if (!layout.root || layout.root.type !== 'panel') return 'root must be type "panel"'
  return null
}

function readShippedPluginUiLayout(pluginId) {
  if (!pluginIdSafe(pluginId)) throw new Error('invalid pluginId')
  const shippedPath = SHIPPED_PLUGIN_UI_LAYOUT_FILES[pluginId]
  if (!shippedPath) throw new Error(`No shipped layout for "${pluginId}"`)
  try {
    const layout = JSON.parse(fs.readFileSync(shippedPath, 'utf8'))
    const structErr = validateLayoutStructure(layout, pluginId)
    if (structErr) throw new Error(`Invalid shipped layout: ${structErr}`)
    return layout
  } catch (err) {
    throw new Error(`Could not read shipped layout for "${pluginId}": ${err?.message || err}`)
  }
}

function parseImportedPluginUiLayout(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid JSON: ${err?.message || err}`)
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Layout file must contain a JSON object')
  }

  if (parsed.$xleth !== undefined && parsed.$xleth !== PLUGIN_UI_LAYOUT_KIND) {
    throw new Error(`Invalid $xleth discriminator: ${parsed.$xleth}`)
  }

  const pluginId = parsed.pluginId
  if (!pluginIdSafe(pluginId)) throw new Error('invalid pluginId')
  const structErr = validateLayoutStructure(parsed, pluginId)
  if (structErr) throw new Error(`Invalid layout: ${structErr}`)
  return { pluginId, layout: parsed }
}

ipcMain.handle('xleth:pluginUi:getShipped', (_, pluginId) => {
  return readShippedPluginUiLayout(pluginId)
})

ipcMain.handle('xleth:pluginUi:saveUserOverride', (_, pluginId, layout) => {
  if (!pluginIdSafe(pluginId)) throw new Error('invalid pluginId')
  if (!layout || typeof layout !== 'object') throw new Error('layout must be an object')
  const structErr = validateLayoutStructure(layout, pluginId)
  if (structErr) throw new Error(`Invalid layout: ${structErr}`)
  ensurePluginUiDir()
  fs.writeFileSync(pluginUiPath(pluginId), JSON.stringify(layout, null, 2), 'utf8')
  broadcastPluginUiChanged(pluginId)
  return true
})

ipcMain.handle('xleth:pluginUi:clearUserOverride', (_, pluginId) => {
  if (!pluginIdSafe(pluginId)) throw new Error('invalid pluginId')
  let removed = false
  try { fs.unlinkSync(pluginUiPath(pluginId)); removed = true } catch { removed = false }
  broadcastPluginUiChanged(pluginId)
  return removed
})

ipcMain.handle('xleth:dialog:importPluginUi', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Plugin UI Layout',
    filters: [
      { name: 'XLETH Plugin UI Layout', extensions: ['xlethui.json', 'json'] },
      { name: 'JSON Files', extensions: ['json'] },
    ],
    properties: ['openFile'],
  })
  if (canceled || !filePaths.length) return null

  const selectedPath = filePaths[0]
  try {
    const raw = fs.readFileSync(selectedPath, 'utf8')
    const { pluginId, layout } = parseImportedPluginUiLayout(raw)
    return { pluginId, layout, path: selectedPath }
  } catch (err) {
    throw new Error(`Import failed: ${err?.message || err}`)
  }
})

// ── User-saved knob appearance presets ────────────────────────────────────────
// Stored at userData/plugin-ui-presets/knob.json as an array of
// { id, label, description, appearance } records. Layouts never reference
// user-preset ids; "applying" a user preset just copies its appearance object
// into the node — so missing presets after disk loss never invalidate layouts.

const userKnobPresetsPath = userDataPath('plugin-ui-presets', 'knob.json')
const USER_KNOB_PRESET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const USER_KNOB_PRESET_MAX_COUNT = 200

function ensureUserKnobPresetsDir() {
  try { fs.mkdirSync(path.dirname(userKnobPresetsPath), { recursive: true }) } catch {}
}

function readUserKnobPresets() {
  try {
    const raw = fs.readFileSync(userKnobPresetsPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidUserKnobPreset)
  } catch { return [] }
}

function writeUserKnobPresets(presets) {
  ensureUserKnobPresetsDir()
  fs.writeFileSync(userKnobPresetsPath, JSON.stringify(presets, null, 2), 'utf8')
}

function isValidUserKnobPreset(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  if (typeof entry.id !== 'string' || !USER_KNOB_PRESET_ID_RE.test(entry.id)) return false
  if (typeof entry.label !== 'string' || entry.label.trim().length === 0 || entry.label.length > 64) return false
  if (entry.description !== undefined && (typeof entry.description !== 'string' || entry.description.length > 256)) return false
  if (!entry.appearance || typeof entry.appearance !== 'object' || Array.isArray(entry.appearance)) return false
  return true
}

ipcMain.handle('xleth:pluginUi:listKnobPresets', () => {
  return readUserKnobPresets()
})

ipcMain.handle('xleth:pluginUi:saveKnobPreset', (_, preset) => {
  if (!isValidUserKnobPreset(preset)) throw new Error('invalid knob preset')
  const existing = readUserKnobPresets()
  const index = existing.findIndex(entry => entry.id === preset.id)
  const next = index >= 0
    ? existing.map((entry, i) => i === index ? preset : entry)
    : [...existing, preset]
  if (next.length > USER_KNOB_PRESET_MAX_COUNT) throw new Error('too many user knob presets')
  writeUserKnobPresets(next)
  return next
})

ipcMain.handle('xleth:pluginUi:deleteKnobPreset', (_, id) => {
  if (typeof id !== 'string' || !USER_KNOB_PRESET_ID_RE.test(id)) throw new Error('invalid preset id')
  const existing = readUserKnobPresets()
  const next = existing.filter(entry => entry.id !== id)
  writeUserKnobPresets(next)
  return next
})

ipcMain.handle('xleth:dialog:exportPluginUi', async (_, pluginId, layout) => {
  if (!pluginIdSafe(pluginId)) throw new Error('invalid pluginId')
  const structErr = validateLayoutStructure(layout, pluginId)
  if (structErr) throw new Error(`Invalid layout: ${structErr}`)

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Plugin UI Layout',
    defaultPath: `${pluginId}.xlethui.json`,
    filters: [
      { name: 'XLETH Plugin UI Layout', extensions: ['xlethui.json'] },
      { name: 'JSON Files', extensions: ['json'] },
    ],
  })
  if (canceled || !filePath) return null

  try {
    fs.writeFileSync(filePath, JSON.stringify(layout, null, 2), 'utf8')
    return { path: filePath }
  } catch (err) {
    throw new Error(`Export failed: ${err?.message || err}`)
  }
})

// ── User-imported decal assets ─────────────────────────────────────────────────
// Assets live under userData/plugin-ui-assets/.
// index.json: [{ assetId, label, mime, ext, sizeBytes, importedAt }]
// Asset files: <uuid>.<ext>
// Layout JSON stores ONLY assetId — never a path, URL, data URI, or blob.
// Dimension validation is deferred (no image-decode dependency in this phase).

const _crypto = require('crypto')

const DECAL_ASSET_DIR   = userDataPath('plugin-ui-assets')
const DECAL_ASSET_INDEX = userDataPath('plugin-ui-assets', 'index.json')
const DECAL_ASSET_MAX_BYTES = 1 * 1024 * 1024  // 1 MB
const DECAL_ASSET_ID_RE = /^user\.imported\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// PNG: 89 50 4E 47 0D 0A 1A 0A
const _PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
// WebP: RIFF????WEBP
const _RIFF_MAGIC = Buffer.from([0x52, 0x49, 0x46, 0x46])
const _WEBP_MAGIC = Buffer.from([0x57, 0x45, 0x42, 0x50])

function _decalMagicCheck(buf) {
  if (!buf || buf.length < 12) return { ok: false, error: 'File is too small to validate.' }
  // Reject SVG / HTML (text starting with '<')
  if (buf[0] === 0x3C) return { ok: false, error: 'SVG files are not supported. Please use PNG or WebP.' }
  if (_PNG_MAGIC.equals(buf.slice(0, 8))) return { ok: true, mime: 'image/png', ext: 'png' }
  if (buf.slice(0, 4).equals(_RIFF_MAGIC) && buf.slice(8, 12).equals(_WEBP_MAGIC)) {
    return { ok: true, mime: 'image/webp', ext: 'webp' }
  }
  return { ok: false, error: 'Not a valid PNG or WebP image (magic bytes do not match). SVG is not supported.' }
}

function _ensureDecalAssetDir() {
  try { fs.mkdirSync(DECAL_ASSET_DIR, { recursive: true }) } catch {}
}

function _readDecalAssetIndex() {
  let raw
  try {
    raw = fs.readFileSync(DECAL_ASSET_INDEX, 'utf8')
  } catch {
    return []  // file missing — first run or clean install
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Corrupt JSON — back up the file before recreating
    const ts = Date.now()
    const backup = path.join(DECAL_ASSET_DIR, `index.corrupt.${ts}.json`)
    try { fs.copyFileSync(DECAL_ASSET_INDEX, backup) } catch {}
    try { _writeDecalAssetIndex([]) } catch {}
    console.warn(`[xleth:decalAssets] Corrupt index.json backed up to ${backup}; recreated empty index.`)
    return []
  }

  if (!Array.isArray(parsed)) return []

  // Keep only format-valid entries whose asset file still exists on disk.
  return parsed.filter(e => {
    if (!_isValidDecalEntry(e)) return false
    try { return fs.existsSync(_decalAssetFilePath(e.assetId, e.ext)) } catch { return false }
  })
}

function _writeDecalAssetIndex(entries) {
  _ensureDecalAssetDir()
  fs.writeFileSync(DECAL_ASSET_INDEX, JSON.stringify(entries, null, 2), 'utf8')
}

function _isValidDecalEntry(e) {
  if (!e || typeof e !== 'object') return false
  if (!DECAL_ASSET_ID_RE.test(e.assetId)) return false
  if (typeof e.label !== 'string' || !e.label.trim()) return false
  if (e.mime !== 'image/png' && e.mime !== 'image/webp') return false
  if (e.ext !== 'png' && e.ext !== 'webp') return false
  if (typeof e.sizeBytes !== 'number' || e.sizeBytes <= 0) return false
  return true
}

// Constructs the safe on-disk path for a user asset.
// Only accepts DECAL_ASSET_ID_RE-matched ids; verifies the result stays inside DECAL_ASSET_DIR.
function _decalAssetFilePath(assetId, ext) {
  if (!DECAL_ASSET_ID_RE.test(assetId)) throw new Error(`invalid assetId: "${assetId}"`)
  const uuid = assetId.slice('user.imported.'.length)
  const target = path.join(DECAL_ASSET_DIR, `${uuid}.${ext}`)
  if (!target.startsWith(DECAL_ASSET_DIR + path.sep)) throw new Error('path escape detected')
  return target
}

// Per-session data URL cache (cleared on restart — never persisted).
const _decalDataUrlCache = new Map()

const _PLACEHOLDER_META = {
  assetId: 'builtin.placeholder.missing',
  label:   'Missing Asset (Placeholder)',
  builtin: true,
}

ipcMain.handle('xleth:pluginUiAssets:list', () => {
  return [_PLACEHOLDER_META, ..._readDecalAssetIndex()]
})

ipcMain.handle('xleth:pluginUiAssets:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Decal — PNG or WebP only',
    filters: [{ name: 'Images (PNG, WebP)', extensions: ['png', 'webp'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths.length) return null

  const srcPath = filePaths[0]
  const srcExt  = path.extname(srcPath).toLowerCase().slice(1)
  if (srcExt !== 'png' && srcExt !== 'webp') {
    throw new Error('Only PNG and WebP files are supported.')
  }

  let buf
  try { buf = fs.readFileSync(srcPath) }
  catch (err) { throw new Error(`Could not read file: ${err.message}`) }

  if (buf.length > DECAL_ASSET_MAX_BYTES) {
    throw new Error(`File too large (${Math.round(buf.length / 1024)} KB). Maximum is ${DECAL_ASSET_MAX_BYTES / 1024} KB.`)
  }

  const magic = _decalMagicCheck(buf)
  if (!magic.ok) throw new Error(magic.error)

  const uuid    = _crypto.randomUUID()
  const assetId = `user.imported.${uuid}`
  const label   = path.basename(srcPath, path.extname(srcPath)).slice(0, 64) || 'Untitled'

  _ensureDecalAssetDir()
  const destPath = _decalAssetFilePath(assetId, magic.ext)
  fs.writeFileSync(destPath, buf)

  const meta = {
    assetId,
    label,
    mime:       magic.mime,
    ext:        magic.ext,
    sizeBytes:  buf.length,
    importedAt: new Date().toISOString(),
  }

  const index = _readDecalAssetIndex()
  index.push(meta)
  _writeDecalAssetIndex(index)
  return meta
})

ipcMain.handle('xleth:pluginUiAssets:getDataUrl', (_, assetId) => {
  if (assetId === 'builtin.placeholder.missing') return null

  if (!DECAL_ASSET_ID_RE.test(assetId)) {
    throw new Error(`Invalid assetId format: "${assetId}"`)
  }

  if (_decalDataUrlCache.has(assetId)) return _decalDataUrlCache.get(assetId)

  const index = _readDecalAssetIndex()
  const entry = index.find(e => e.assetId === assetId)
  if (!entry) throw new Error(`Asset not found in index: "${assetId}"`)

  const filePath = _decalAssetFilePath(assetId, entry.ext)
  let buf
  try { buf = fs.readFileSync(filePath) }
  catch { throw new Error(`Asset file missing from disk for "${assetId}"`) }

  const magic = _decalMagicCheck(buf)
  if (!magic.ok) throw new Error(`Stored asset is corrupt: ${magic.error}`)

  const dataUrl = `data:${magic.mime};base64,${buf.toString('base64')}`
  _decalDataUrlCache.set(assetId, dataUrl)
  return dataUrl
})

ipcMain.handle('xleth:pluginUiAssets:delete', (_, assetId) => {
  if (!DECAL_ASSET_ID_RE.test(assetId)) throw new Error(`Invalid assetId: "${assetId}"`)

  const index = _readDecalAssetIndex()
  const entry = index.find(e => e.assetId === assetId)

  if (entry) {
    try { fs.unlinkSync(_decalAssetFilePath(assetId, entry.ext)) } catch {}
  }

  _decalDataUrlCache.delete(assetId)
  _writeDecalAssetIndex(index.filter(e => e.assetId !== assetId))
  return true
})

ipcMain.handle('xleth:pluginUiAssets:scanOrphans', () => {
  _ensureDecalAssetDir()

  // Read raw entries (format-valid but NOT filtered by file existence) so we can report missing files.
  let rawEntries = []
  try {
    const raw = fs.readFileSync(DECAL_ASSET_INDEX, 'utf8')
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) rawEntries = parsed.filter(_isValidDecalEntry)
    } catch { /* corrupt — raw already [] */ }
  } catch { /* file missing */ }

  // Missing: index entries whose files are gone from disk.
  const missing = rawEntries
    .filter(e => {
      try { return !fs.existsSync(_decalAssetFilePath(e.assetId, e.ext)) } catch { return true }
    })
    .map(e => ({ assetId: e.assetId, label: e.label }))

  // Orphans: files in the asset dir that have no matching index entry.
  let dirFiles = []
  try { dirFiles = fs.readdirSync(DECAL_ASSET_DIR) } catch {}

  const indexedFilenames = new Set(
    rawEntries.map(e => {
      try { return path.basename(_decalAssetFilePath(e.assetId, e.ext)) } catch { return null }
    }).filter(Boolean),
  )

  const orphans = dirFiles
    .filter(f => f !== 'index.json' && !f.startsWith('index.corrupt.') && !indexedFilenames.has(f))
    .map(f => ({ filename: f }))

  return { missing, orphans }
})

ipcMain.handle('xleth:engine:setGlobalStretchMethod',
  safeHandler((_, m) => callWorker('engine_setGlobalStretchMethod', [m])))
ipcMain.handle('xleth:engine:getGlobalStretchMethod',
  safeHandler(() => callWorker('engine_getGlobalStretchMethod', [])))
ipcMain.handle('xleth:engine:setGlobalFormantPreserve',
  safeHandler((_, v) => callWorker('engine_setGlobalFormantPreserve', [v])))
ipcMain.handle('xleth:engine:getGlobalFormantPreserve',
  safeHandler(() => callWorker('engine_getGlobalFormantPreserve', [])))

ipcMain.handle('xleth:timeline:addRegion',
  safeHandler((_, region) => callWorker('timeline_addRegion', [region])));

ipcMain.handle('xleth:timeline:modifyRegion',
  safeHandler((_, id, region) => callWorker('timeline_modifyRegion', [id, region])));

ipcMain.handle('xleth:timeline:setSyllables',
  safeHandler((_, id, syllables) => callWorker('timeline_setSyllables', [id, syllables])));

ipcMain.handle('xleth:timeline:getSyllables',
  safeHandler((_, id) => callWorker('timeline_getSyllables', [id])));

ipcMain.handle('xleth:timeline:removeRegion',
  safeHandler((_, id) => callWorker('timeline_removeRegion', [id])));

// ── Grid Layout ─────────────────────────────────────────────────────────────

ipcMain.handle('xleth:timeline:getGridLayout',
  safeHandler(() => callWorker('timeline_getGridLayout')));

ipcMain.handle('xleth:timeline:setGridLayout',
  safeHandler((_, layout) => callWorker('timeline_setGridLayout', [layout])));

ipcMain.handle('xleth:timeline:assignTrackToGrid',
  safeHandler((_, trackId, gx, gy, sx, sy) => callWorker('timeline_assignTrackToGrid', [trackId, gx, gy, sx, sy])));

ipcMain.handle('xleth:timeline:assignTrackToGridWithZOrder',
  safeHandler((_, trackId, gx, gy, sx, sy, z) => callWorker('timeline_assignTrackToGridWithZOrder', [trackId, gx, gy, sx, sy, z])));

ipcMain.handle('xleth:timeline:removeTrackFromGrid',
  safeHandler((_, trackId) => callWorker('timeline_removeTrackFromGrid', [trackId])));

ipcMain.handle('xleth:timeline:setChorusTrack',
  safeHandler((_, trackId) => callWorker('timeline_setChorusTrack', [trackId])));

ipcMain.handle('xleth:timeline:setCrashOverlay',
  safeHandler((_, enabled, trackId, opacity) => callWorker('timeline_setCrashOverlay', [enabled, trackId, opacity])));

ipcMain.handle('xleth:timeline:setPreviewFps',
  safeHandler((_, fps) => callWorker('timeline_setPreviewFps', [fps])));

// ── Pattern handlers ─────────────────────────────────────────────────────────

ipcMain.handle('xleth:timeline:addPattern',
  safeHandler((_, info) => callWorker('timeline_addPattern', [info])));

ipcMain.handle('xleth:timeline:getPattern',
  safeHandler((_, id) => callWorker('timeline_getPattern', [id])));

ipcMain.handle('xleth:timeline:getAllPatterns',
  safeHandler(() => callWorker('timeline_getAllPatterns')));

ipcMain.handle('xleth:timeline:removePattern',
  safeHandler((_, id) => callWorker('timeline_removePattern', [id])));

ipcMain.handle('xleth:timeline:updateSamplerSettings',
  safeHandler((_, id, settings) => callWorker('timeline_updateSamplerSettings', [id, settings])));

ipcMain.handle('xleth:timeline:getPatternAudioInfo',
  safeHandler((_, id) => callWorker('timeline_getPatternAudioInfo', [id])));

ipcMain.handle('xleth:timeline:getRegionAudioInfo',
  safeHandler((_, regionId) => callWorker('timeline_getRegionAudioInfo', [regionId])));

// Pipeline B (getRegionWaveformPeaks) retired — replaced by xleth:waveform:getRegionPeaks

ipcMain.handle('xleth:timeline:addPatternBlock',
  safeHandler((_, block) => callWorker('timeline_addPatternBlock', [block])));

ipcMain.handle('xleth:timeline:getPatternBlocks',
  safeHandler(() => callWorker('timeline_getPatternBlocks')));

ipcMain.handle('xleth:timeline:removePatternBlock',
  safeHandler((_, id) => callWorker('timeline_removePatternBlock', [id])));

ipcMain.handle('xleth:timeline:movePatternBlock',
  safeHandler((_, id, trackId, posTicks) => callWorker('timeline_movePatternBlock', [id, trackId, posTicks])));

ipcMain.handle('xleth:timeline:resizePatternBlock',
  safeHandler((_, id, durTicks) => callWorker('timeline_resizePatternBlock', [id, durTicks])));

ipcMain.handle('xleth:timeline:resizePatternBlockLeft',
  safeHandler((_, id, posTicks, durTicks, offTicks) => callWorker('timeline_resizePatternBlockLeft', [id, posTicks, durTicks, offTicks])));

ipcMain.handle('xleth:timeline:setPatternBlockLoop',
  safeHandler((_, id, enabled) => callWorker('timeline_setPatternBlockLoop', [id, enabled])));

ipcMain.handle('xleth:timeline:addNote',
  safeHandler((_, patternId, note) => callWorker('timeline_addNote', [patternId, note])));

ipcMain.handle('xleth:timeline:removeNote',
  safeHandler((_, patternId, noteId) => callWorker('timeline_removeNote', [patternId, noteId])));

ipcMain.handle('xleth:timeline:moveNote',
  safeHandler((_, patternId, noteId, posTicks, pitch) => callWorker('timeline_moveNote', [patternId, noteId, posTicks, pitch])));

ipcMain.handle('xleth:timeline:moveNotesBatch',
  safeHandler((_, patternId, moves) => callWorker('timeline_moveNotesBatch', [patternId, moves])));

ipcMain.handle('xleth:timeline:quantizeClipsBatch',
  safeHandler((_, specs) => callWorker('timeline_quantizeClipsBatch', [specs])));

ipcMain.handle('xleth:timeline:resizeNotesBatch',
  safeHandler((_, patternId, resizes) => callWorker('timeline_resizeNotesBatch', [patternId, resizes])));

ipcMain.handle('xleth:timeline:resizeNote',
  safeHandler((_, patternId, noteId, durTicks) => callWorker('timeline_resizeNote', [patternId, noteId, durTicks])));

ipcMain.handle('xleth:timeline:setNoteVelocity',
  safeHandler((_, patternId, noteId, velocity) => callWorker('timeline_setNoteVelocity', [patternId, noteId, velocity])));

ipcMain.handle('xleth:timeline:previewNote',
  safeHandler((_, patternId, pitch, velocity) => callWorker('timeline_previewNote', [patternId, pitch, velocity])));

ipcMain.handle('xleth:timeline:previewNoteOff',
  safeHandler((_, patternId, pitch) => callWorker('timeline_previewNoteOff', [patternId, pitch])));

ipcMain.handle('xleth:timeline:previewAllNotesOff',
  safeHandler((_, regionId) => callWorker('timeline_previewAllNotesOff', [regionId])));

// ── Phase 1 handlers — Undo / Redo ───────────────────────────────────────────

ipcMain.handle('xleth:undo:undo',
  safeHandler(() => callWorker('undo_undo')));

ipcMain.handle('xleth:undo:redo',
  safeHandler(() => callWorker('undo_redo')));

ipcMain.handle('xleth:undo:canUndo',
  safeHandler(() => callWorker('undo_canUndo')));

ipcMain.handle('xleth:undo:canRedo',
  safeHandler(() => callWorker('undo_canRedo')));

ipcMain.handle('xleth:undo:getUndoDescription',
  safeHandler(() => callWorker('undo_getUndoDescription')));

ipcMain.handle('xleth:undo:getRedoDescription',
  safeHandler(() => callWorker('undo_getRedoDescription')));

// ── Phase 1 handlers — Transport extensions ──────────────────────────────────

ipcMain.handle('xleth:transport:seek',
  safeHandler((_, beatPos) => callWorker('transport_seek', [beatPos])));

// ── Phase 1 handlers — Audio ─────────────────────────────────────────────────

ipcMain.handle('xleth:audio:loadSample',
  safeHandler((_, filePath) => callWorker('loadSample', [filePath])));

ipcMain.handle('xleth:audio:mapRegionToSample',
  safeHandler((_, regionId, sampleId) => callWorker('audio_mapRegionToSample', [regionId, sampleId])));

ipcMain.handle('xleth:audio:loadSourceRegion',
  safeHandler((_, filePath, startTime, endTime) => callWorker('audio_loadSourceRegion', [filePath, startTime, endTime])));

ipcMain.handle('xleth:audio:getMasterPeak',
  safeHandler(() => callWorker('audio_getMasterPeak')));

ipcMain.handle('xleth:audio:getTrackPeak',
  safeHandler((_, trackId) => callWorker('audio_getTrackPeak', [trackId])));

ipcMain.handle('xleth:audio:getAllPeaks',
  safeHandler(() => callWorker('audio_getAllPeaks')));

ipcMain.handle('xleth:audio:setTrackVolume',
  safeHandler((_, trackId, vol) => callWorker('audio_setTrackVolume', [trackId, vol])));

ipcMain.handle('xleth:audio:setTrackPan',
  safeHandler((_, trackId, pan) => callWorker('audio_setTrackPan', [trackId, pan])));

ipcMain.handle('xleth:audio:setTrackSpread',
  safeHandler((_, trackId, spread) => callWorker('audio_setTrackSpread', [trackId, spread])));

ipcMain.handle('xleth:audio:setMasterVolume',
  safeHandler((_, vol) => callWorker('audio_setMasterVolume', [vol])));

ipcMain.handle('xleth:audio:getOutputDevices',
  safeHandler(() => callWorker('audio_getOutputDevices')));
ipcMain.handle('xleth:audio:getCurrentOutputDevice',
  safeHandler(() => callWorker('audio_getCurrentOutputDevice')));
ipcMain.handle('xleth:audio:setOutputDevice',
  safeHandler((_, name) => callWorker('audio_setOutputDevice', [name])));

// ── P3 — Effect Chain ───────────────────────────────────────────────────────

const trackKey = (_, trackId) => String(trackId);
const masterKey = () => 'master';

ipcMain.handle('xleth:audio:addEffect',
  graphHandler(trackKey, (_, trackId, pluginId, position) => callWorker('audio_addEffect', [trackId, pluginId, position])));

ipcMain.handle('xleth:audio:removeEffect',
  graphHandler(trackKey, (_, trackId, nodeId) => callWorker('audio_removeEffect', [trackId, nodeId])));

ipcMain.handle('xleth:audio:moveEffect',
  graphHandler(trackKey, (_, trackId, nodeId, newPosition) => callWorker('audio_moveEffect', [trackId, nodeId, newPosition])));

ipcMain.handle('xleth:audio:setEffectBypass',
  graphHandler(trackKey, (_, trackId, nodeId, bypassed) => callWorker('audio_setEffectBypass', [trackId, nodeId, bypassed])));

ipcMain.handle('xleth:audio:getEffectChain',
  safeHandler((_, trackId) => callWorker('audio_getEffectChain', [trackId])));

ipcMain.handle('xleth:audio:addMasterEffect',
  graphHandler(masterKey, (_, pluginId, position) => callWorker('audio_addMasterEffect', [pluginId, position])));

ipcMain.handle('xleth:audio:removeMasterEffect',
  graphHandler(masterKey, (_, nodeId) => callWorker('audio_removeMasterEffect', [nodeId])));

ipcMain.handle('xleth:audio:moveMasterEffect',
  graphHandler(masterKey, (_, nodeId, newPosition) => callWorker('audio_moveMasterEffect', [nodeId, newPosition])));

ipcMain.handle('xleth:audio:setMasterEffectBypass',
  graphHandler(masterKey, (_, nodeId, bypassed) => callWorker('audio_setMasterEffectBypass', [nodeId, bypassed])));

ipcMain.handle('xleth:audio:getMasterEffectChain',
  safeHandler(() => callWorker('audio_getMasterEffectChain')));

// ── Generic effect parameter / meter access ───────────────────────────────

ipcMain.handle('xleth:audio:getEffectParameters',
  safeHandler((_, trackId, nodeId) => callWorker('audio_getEffectParameters', [trackId, nodeId])));

ipcMain.handle('xleth:audio:setEffectParameter',
  safeHandler((_, trackId, nodeId, paramId, value) => callWorker('audio_setEffectParameter', [trackId, nodeId, paramId, value])));

ipcMain.handle('xleth:audio:getEffectMeter',
  safeHandler((_, trackId, nodeId) => callWorker('audio_getEffectMeter', [trackId, nodeId])));

// ── Effect visualization (dynamics; binary ArrayBuffer payload) ────────────
ipcMain.handle('xleth:audio:setEffectVisualizationEnabled',
  safeHandler((_, trackId, nodeId, enabled) =>
    callWorker('audio_setEffectVisualizationEnabled', [trackId, nodeId, !!enabled])));

ipcMain.handle('xleth:audio:drainEffectVizFrames',
  safeHandler((_, trackId, nodeId, maxBuckets) =>
    callWorker('audio_drainEffectVizFrames', [trackId, nodeId, maxBuckets | 0])));

// ── EQ-specific ────────────────────────────────────────────────────────────

ipcMain.handle('xleth:audio:eqAddBand',
  safeHandler((_, trackId, nodeId) => callWorker('audio_eqAddBand', [trackId, nodeId])));

ipcMain.handle('xleth:audio:eqRemoveBand',
  safeHandler((_, trackId, nodeId, bandIndex) => callWorker('audio_eqRemoveBand', [trackId, nodeId, bandIndex])));

ipcMain.handle('xleth:audio:eqSetBandParam',
  safeHandler((_, trackId, nodeId, bandIndex, paramName, value) => callWorker('audio_eqSetBandParam', [trackId, nodeId, bandIndex, paramName, value])));

ipcMain.handle('xleth:audio:eqGetResponseCurve',
  safeHandler((_, trackId, nodeId) => callWorker('audio_eqGetResponseCurve', [trackId, nodeId])));

ipcMain.handle('xleth:audio:eqGetSpectrumData',
  safeHandler((_, trackId, nodeId) => callWorker('audio_eqGetSpectrumData', [trackId, nodeId])));

ipcMain.handle('xleth:audio:eqSetPreSpectrum',
  safeHandler((_, trackId, nodeId, enabled) => callWorker('audio_eqSetPreSpectrum', [trackId, nodeId, enabled])));

ipcMain.handle('xleth:audio:eqGetBands',
  safeHandler((_, trackId, nodeId) => callWorker('audio_eqGetBands', [trackId, nodeId])));

ipcMain.handle('xleth:audio:eqGetBandGR',
  safeHandler((_, trackId, nodeId) => callWorker('audio_eqGetBandGR', [trackId, nodeId])));

ipcMain.handle('xleth:audio:eqSetGlobalParam',
  safeHandler((_, trackId, nodeId, paramName, value) => callWorker('audio_eqSetGlobalParam', [trackId, nodeId, paramName, value])));

ipcMain.handle('xleth:audio:eqGetGlobalParams',
  safeHandler((_, trackId, nodeId) => callWorker('audio_eqGetGlobalParams', [trackId, nodeId])));

ipcMain.handle('xleth:audio:eqGetSampleRate',
  safeHandler((_, trackId, nodeId) => callWorker('audio_eqGetSampleRate', [trackId, nodeId])));

// ── SmartBalance-specific ──────────────────────────────────────────────────

ipcMain.handle('xleth:audio:smartBalanceGetDebug',
  safeHandler((_, trackId, nodeId) => callWorker('audio_smartBalanceGetDebug', [trackId, nodeId])));

// ── Waveshaper-specific ────────────────────────────────────────────────────

ipcMain.handle('xleth:audio:wsGetCurvePoints',
  safeHandler((_, trackId, nodeId) => callWorker('audio_wsGetCurvePoints', [trackId, nodeId])));

ipcMain.handle('xleth:audio:wsSetCurvePoints',
  safeHandler((_, trackId, nodeId, pointsJSON) => callWorker('audio_wsSetCurvePoints', [trackId, nodeId, pointsJSON])));

ipcMain.handle('xleth:audio:wsSetPreset',
  safeHandler((_, trackId, nodeId, presetIndex) => callWorker('audio_wsSetPreset', [trackId, nodeId, presetIndex])));

// ── Graph-mode routing ──────────────────────────────────────────────────────

ipcMain.handle('xleth:audio:addConnection',
  graphHandler(trackKey, (_, trackId, srcId, dstId) => callWorker('audio_addConnection', [trackId, srcId, dstId])));

ipcMain.handle('xleth:audio:removeConnection',
  graphHandler(trackKey, (_, trackId, srcId, dstId) => callWorker('audio_removeConnection', [trackId, srcId, dstId])));

ipcMain.handle('xleth:audio:setWireGain',
  graphHandler(trackKey, (_, trackId, srcId, dstId, gain) => callWorker('audio_setWireGain', [trackId, srcId, dstId, gain])));

ipcMain.handle('xleth:audio:setWireMute',
  graphHandler(trackKey, (_, trackId, srcId, dstId, muted) => callWorker('audio_setWireMute', [trackId, srcId, dstId, muted])));

ipcMain.handle('xleth:audio:getGraphTopology',
  safeHandler((_, trackId) => callWorker('audio_getGraphTopology', [trackId])));

ipcMain.handle('xleth:audio:setNodePosition',
  safeHandler((_, trackId, nodeId, x, y) => callWorker('audio_setNodePosition', [trackId, nodeId, x, y])));

ipcMain.handle('xleth:audio:isGraphLinear',
  safeHandler((_, trackId) => callWorker('audio_isGraphLinear', [trackId])));

ipcMain.handle('xleth:audio:addMasterConnection',
  graphHandler(masterKey, (_, srcId, dstId) => callWorker('audio_addMasterConnection', [srcId, dstId])));

ipcMain.handle('xleth:audio:removeMasterConnection',
  graphHandler(masterKey, (_, srcId, dstId) => callWorker('audio_removeMasterConnection', [srcId, dstId])));

ipcMain.handle('xleth:audio:setMasterWireGain',
  graphHandler(masterKey, (_, srcId, dstId, gain) => callWorker('audio_setMasterWireGain', [srcId, dstId, gain])));

ipcMain.handle('xleth:audio:setMasterWireMute',
  graphHandler(masterKey, (_, srcId, dstId, muted) => callWorker('audio_setMasterWireMute', [srcId, dstId, muted])));

ipcMain.handle('xleth:audio:getMasterGraphTopology',
  safeHandler(() => callWorker('audio_getMasterGraphTopology')));

ipcMain.handle('xleth:audio:setMasterNodePosition',
  safeHandler((_, nodeId, x, y) => callWorker('audio_setMasterNodePosition', [nodeId, x, y])));

ipcMain.handle('xleth:audio:isMasterGraphLinear',
  safeHandler(() => callWorker('audio_isMasterGraphLinear')));

// ── VST3 plugin scanner ───────────────────────────────────────────────────────

ipcMain.handle('xleth:audio:scanPlugins',
  safeHandler((_, paths) => callWorker('audio_scanPlugins', paths && paths.length ? [paths] : [])));

ipcMain.handle('xleth:audio:getScanProgress',
  safeHandler(() => callWorker('audio_getScanProgress', [])));

ipcMain.handle('xleth:audio:getScannedPlugins',
  safeHandler(() => callWorker('audio_getScannedPlugins', [])));

ipcMain.handle('xleth:audio:getFailedPlugins',
  safeHandler(() => callWorker('audio_getFailedPlugins', [])));

// ── VST3 plugin editor windows ────────────────────────────────────────────────

ipcMain.handle('xleth:audio:openPluginEditor',
  safeHandler((_, trackId, nodeId) => callWorker('audio_openPluginEditor', [trackId, nodeId])));

ipcMain.handle('xleth:audio:closePluginEditor',
  safeHandler((_, trackId, nodeId) => callWorker('audio_closePluginEditor', [trackId, nodeId])));

ipcMain.handle('xleth:audio:closeAllPluginEditors',
  safeHandler(() => callWorker('audio_closeAllPluginEditors', [])));

ipcMain.handle('xleth:audio:isPluginEditorOpen',
  safeHandler((_, trackId, nodeId) => callWorker('audio_isPluginEditorOpen', [trackId, nodeId])));

ipcMain.handle('xleth:audio:getMissingPlugins',
  safeHandler(() => callWorker('audio_getMissingPlugins', [])));

ipcMain.handle('xleth:audio:retryMissingPlugin',
  safeHandler((_, trackId, nodeId) => callWorker('audio_retryMissingPlugin', [trackId, nodeId])));

ipcMain.handle('xleth:audio:removeAllMissing',
  safeHandler(() => callWorker('audio_removeAllMissing', [])));

ipcMain.handle('xleth:audio:resetCrashedPlugin',
  safeHandler((_, trackId, nodeId) => callWorker('audio_resetCrashedPlugin', [trackId, nodeId])));

ipcMain.handle('xleth:dialog:addVstSearchPath', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Add VST3 Search Path',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

// ── Audio Export ─────────────────────────────────────────────────────────────

let exportProgressInterval = null;
function startExportProgressPoll() {
  if (exportProgressInterval) return;
  exportProgressInterval = setInterval(async () => {
    try {
      const p = await callWorker('audio_exportGetProgress', []);
      if (!p) return;
      if (win && !win.isDestroyed()) win.webContents.send('export:progress', p);
      if (!p.running) {
        clearInterval(exportProgressInterval);
        exportProgressInterval = null;
      }
    } catch {}
  }, 100);
}

ipcMain.handle('xleth:audio:exportStart',
  safeHandler(async (_, cfg) => {
    const ok = await callWorker('audio_exportStart', [cfg]);
    if (ok) startExportProgressPoll();
    return ok;
  }));

ipcMain.handle('xleth:audio:exportGetProgress',
  safeHandler(() => callWorker('audio_exportGetProgress', [])));

ipcMain.handle('xleth:audio:exportCancel',
  safeHandler(() => callWorker('audio_exportCancel', [])));

// ── Video Export ─────────────────────────────────────────────────────────────

let videoExportProgressInterval = null;
function startVideoExportProgressPoll() {
  if (videoExportProgressInterval) return;
  videoExportProgressInterval = setInterval(async () => {
    try {
      const p = await callWorker('video_exportGetProgress', []);
      if (!p) return;
      if (win && !win.isDestroyed()) win.webContents.send('video-export:progress', p);
      if (!p.running) {
        clearInterval(videoExportProgressInterval);
        videoExportProgressInterval = null;
      }
    } catch {}
  }, 100);
}

// ── WORLD processing indicator poll ──────────────────────────────────────────
// Polls the engine every 100ms for in-flight WORLD render jobs and forwards
// start/complete events to the renderer so the UI can show per-clip spinners.
let prevWorldClips = new Set()

async function pollWorldProcessing() {
  if (!workerReady || !win || win.isDestroyed()) return
  try {
    const active = await callWorker('cache_getWorldActiveJobs', [])
    const activeSet = new Set(active)
    for (const id of activeSet) {
      if (!prevWorldClips.has(id))
        win.webContents.send('stretch:worldProcessingStart', { clipId: id })
    }
    for (const id of prevWorldClips) {
      if (!activeSet.has(id))
        win.webContents.send('stretch:worldProcessingComplete', { clipId: id })
    }
    prevWorldClips = activeSet
  } catch {}
}

ipcMain.handle('xleth:video:exportStart', safeHandler(async (_, cfg) => {
  const ok = await callWorker('video_exportStart', [cfg]);
  if (ok) startVideoExportProgressPoll();
  return ok;
}));

ipcMain.handle('xleth:video:exportGetProgress',
  safeHandler(() => callWorker('video_exportGetProgress', [])));

ipcMain.handle('xleth:video:exportCancel',
  safeHandler(() => callWorker('video_exportCancel', [])));

// Hardware encoder queries
ipcMain.handle('xleth:video:getAvailableEncoders',
  safeHandler((_, codec) => callWorker('hwenc_getAvailableEncoders', [codec])));

ipcMain.handle('xleth:video:getDefaultEncoder',
  safeHandler((_, codec) => callWorker('hwenc_getDefaultEncoder', [codec])));

// GPU adapter detection — used by Settings to show NVIDIA/AMD/Intel/none status
ipcMain.handle('xleth:gpu:getAvailableGpus',
  safeHandler(() => callWorker('gpu_getAvailableGpus', [])));

// ─── Visual Preview Diagnostic Log ──────────────────────────────────────────
// Beta-tester-friendly .txt export of the live preview / grid pipeline state.
// Triggered from Settings → Graphics. The renderer passes `extras` containing:
//   - preview:    snapshot of window.__xlethVisualPreviewDiag (the AUTHORITATIVE
//                 state of the live preview canvas, or null if VideoPreview
//                 has not mounted yet)
//   - proxyWebgl: a fresh WebGL context created from the SettingsPanel; only
//                 a *proxy* for the live preview canvas's adapter (Chromium
//                 *usually* shares the GPU process but it is not guaranteed)
// The main process pulls engine state via the diag_getVisualPreviewDiagnostic
// N-API call, formats a plain-text report, and writes it via showSaveDialog
// (or falls back to the user-data folder if the dialog is unavailable).
function pad2(n) { return String(n).padStart(2, '0'); }
function diagnosticTimestamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}
function fmtVendorHex(n) {
  if (!Number.isFinite(n) || n <= 0) return 'n/a';
  return '0x' + n.toString(16).toUpperCase().padStart(4, '0');
}
function fmtBool(b) { return b ? 'yes' : 'no'; }
function fmtKVLines(obj, indent = '  ') {
  const lines = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      lines.push(`${indent}${k}:`);
      lines.push(fmtKVLines(v, indent + '  '));
    } else {
      lines.push(`${indent}${k}: ${v == null ? 'n/a' : v}`);
    }
  }
  return lines.join('\n');
}

function buildVisualPreviewDiagnosticText({ engine, extras, settings }) {
  const ts = new Date();
  const out = [];
  const sep = '─'.repeat(72);

  out.push('Xleth — Visual Preview Diagnostic Log');
  out.push(sep);
  out.push(`Generated:        ${ts.toISOString()}`);
  out.push(`App version:      ${app.getVersion ? app.getVersion() : 'unknown'}`);
  out.push(`Electron:         ${process.versions.electron || 'n/a'}`);
  out.push(`Chrome:           ${process.versions.chrome || 'n/a'}`);
  out.push(`Node:             ${process.versions.node || 'n/a'}`);
  out.push(`OS:               ${os.type()} ${os.release()} (${os.arch()})`);
  out.push(`OS platform:      ${process.platform}`);
  out.push(`CPU:              ${(os.cpus()[0] || {}).model || 'n/a'} × ${os.cpus().length}`);
  out.push(`Total memory:     ${(os.totalmem() / (1024 * 1024)).toFixed(0)} MB`);
  out.push(`Free memory:      ${(os.freemem() / (1024 * 1024)).toFixed(0)} MB`);
  out.push(`Portable EXE:     ${app.isPackaged ? 'yes' : 'no (dev build)'}`);
  out.push('');

  // ── 1. System / adapter ────────────────────────────────────────────────
  out.push('1. SYSTEM / ADAPTER');
  out.push(sep);
  const adapters = (engine && engine.adapters) || [];
  if (!adapters.length) {
    out.push('  (no adapters reported by engine — DXGI enumeration failed or engine not initialized)');
  } else {
    out.push(`  Detected ${adapters.length} DXGI adapter(s). Active index: ${engine.activeAdapterIndex}`);
    adapters.forEach((a, i) => {
      out.push(`  [${i}] ${a.vendor} — ${a.name}`);
      out.push(`        vendorId=${fmtVendorHex(a.vendorId)} deviceId=${fmtVendorHex(a.deviceId)}`);
      const luid = (a.luidHighPart != null && a.luidLowPart != null)
        ? `${a.luidHighPart.toString(16).toUpperCase().padStart(8, '0')}:${a.luidLowPart.toString(16).toUpperCase().padStart(8, '0')}`
        : 'unavailable';
      out.push(`        LUID=${luid}  (compare against UNMASKED_RENDERER_WEBGL to confirm same adapter)`);
      const shared = (a.sharedSystemMemoryMB == null)
        ? 'unavailable'
        : `${a.sharedSystemMemoryMB} MB`;
      out.push(`        VRAM(dedicated)=${a.vramMB} MB  shared=${shared}`);
      out.push(`        discrete=${fmtBool(a.isDiscrete)}  default=${fmtBool(a.isDefault)}  index=${a.index}`);
    });
  }
  out.push(`  D3D11 device created: ${fmtBool(engine && engine.hasD3D11Device)}`);
  out.push(`  Engine compositor backend: D3D11 (GridCompositor) — NOT OpenGL`);
  out.push(`  Renderer (Electron preview canvas) backend: WebGL / Canvas2D`);
  out.push(`  Video encode/decode mode (requested): ${(settings && settings.videoMode) || 'auto'}`);
  out.push('');

  // ── 2. Known-good video paths ──────────────────────────────────────────
  out.push('2. KNOWN-GOOD VIDEO PATHS');
  out.push(sep);
  out.push('  Sample Selector preview:    Chromium <video> element via local HTTP server');
  out.push('                              → bypasses native GridCompositor + shared memory entirely.');
  out.push('  Imported-video popup:       Chromium <video> element');
  out.push('                              → bypasses native GridCompositor + shared memory entirely.');
  out.push('  ⚠ A working Chromium video element does NOT prove the native GridCompositor');
  out.push('    or the shared-memory → WebGL preview pipeline is working. Those use entirely');
  out.push('    different code paths (D3D11 composite + Win32 named file mapping + WebGL).');
  out.push('');

  // ── 3. Main preview / grid pipeline state ──────────────────────────────
  out.push('3. MAIN PREVIEW / GRID PIPELINE');
  out.push(sep);
  if (!engine) {
    out.push('  (engine state unavailable — diag_getVisualPreviewDiagnostic returned nothing)');
  } else {
    out.push(`  compositorReady:        ${fmtBool(engine.compositorReady)}`);
    out.push(`  compositorPresent:      ${fmtBool(engine.compositorPresent)}`);
    out.push(`  decoderPresent:         ${fmtBool(engine.decoderPresent)}`);
    out.push(`  collectorPresent:       ${fmtBool(engine.collectorPresent)}`);
    out.push(`  renderCachePresent:     ${fmtBool(engine.renderCachePresent)}`);
    out.push(`  animMgrPresent:         ${fmtBool(engine.animMgrPresent)}`);
    out.push(`  pauseForExport:         ${fmtBool(engine.pauseForExport)}`);
    out.push(`  pauseForVisibility:     ${fmtBool(engine.pauseForVisibility)}`);
    out.push(`  previewResolutionScale: ${engine.previewResolutionScale}`);
    out.push(`  previewEffectsBypass:   ${fmtBool(engine.previewEffectsBypass)}`);
    if (engine.gridLayout) {
      out.push(`  Grid layout:            ${engine.gridLayout.columns} cols × ${engine.gridLayout.rows} rows @ ${engine.gridLayout.previewFps} fps  gapScale=${engine.gridLayout.gapScale}`);
    }
    if (engine.lastTick) {
      out.push(`  Last tick:              ${engine.lastTick.requestCount} cell requests, ${engine.lastTick.decodeMissCount} decode misses`);
    }
  }
  out.push('');

  // ── 4. Native compositor / readback ────────────────────────────────────
  out.push('4. NATIVE COMPOSITOR (D3D11 GridCompositor)');
  out.push(sep);
  if (engine && engine.lastTick) {
    out.push(`  Init dimensions:        ${engine.lastTick.initWidth} × ${engine.lastTick.initHeight}`);
    out.push(`  Compositor RT:          ${engine.lastTick.compositorWidth} × ${engine.lastTick.compositorHeight}`);
    out.push(`  Last readback:          ${engine.lastTick.readbackWidth} × ${engine.lastTick.readbackHeight}`);
  }
  if (engine && engine.counters) {
    const c = engine.counters;
    out.push(`  Video tick count:           ${c.videoTickCount}`);
    out.push(`  Compositor path entered:    ${c.compositorPathEntered}`);
    out.push(`  compositeFrame() calls:     ${c.compositeFrameCount}`);
    out.push(`  readback() valid:           ${c.readbackValidCount}`);
    out.push(`  readback() invalid:         ${c.readbackInvalidCount}`);
    out.push(`  Canvas copy count:          ${c.canvasCopyCount}`);
    out.push(`  Black frames written:       ${c.blackFrameCount}`);
    out.push(`  Compositor init failures:   ${c.compositorInitFailures}`);
    out.push('');
    out.push('  Interpretation:');
    if (c.compositeFrameCount === 0 && c.compositorPathEntered === 0) {
      out.push('    ✗ Compositor path never entered — engine is in CPU fallback or paused.');
    } else if (c.compositeFrameCount === 0) {
      out.push('    ✗ Path entered but compositeFrame() never called — compositor not initialized.');
    } else if (c.readbackValidCount === 0 && c.readbackInvalidCount > 0) {
      out.push('    ✗ Readback has been called but ALWAYS returned invalid — D3D11 readback failing.');
    } else if (c.canvasCopyCount === 0) {
      out.push('    ✗ Readback valid but no canvas copy — frameOutput.getBackBuffer() returning null.');
    } else {
      out.push('    ✓ Engine is producing frames into shared memory.');
      out.push('      If preview is still blank, the failure is in shared-memory delivery or WebGL upload.');
    }
  }
  out.push('');

  // ── 5. Preview delivery to Electron / WebGL ────────────────────────────
  out.push('5. PREVIEW DELIVERY (shared memory → WebGL canvas)');
  out.push(sep);
  if (engine) {
    out.push(`  Engine side:`);
    out.push(`    FrameOutput initialized:    ${fmtBool(engine.frameOutputInitialized)}`);
    out.push(`    FrameOutput dimensions:     ${engine.frameOutputWidth} × ${engine.frameOutputHeight}`);
    out.push(`    FrameOutput buffer size:    ${engine.frameOutputBufferSize} bytes (per half)`);
    out.push(`    FrameOutput current index:  ${engine.frameOutputCurrentIndex} (0 or 1; should change as engine swaps)`);
    out.push(`    Shared-memory name:         ${FRAME_SHM_NAME}`);
  }
  out.push('');

  // ── 5a. Live preview canvas (authoritative renderer state) ─────────────
  out.push('  Renderer side — LIVE PREVIEW CANVAS (authoritative):');
  const preview = extras && extras.preview;
  if (!preview) {
    out.push('    ⚠ VideoPreview component never mounted (or not visible since launch).');
    out.push('      The renderer has not exposed any state for the main preview canvas.');
    out.push('      Re-trigger this export AFTER the preview panel has been visible at least once.');
  } else {
    out.push(`    mode (component reports):   ${preview.mode}`);
    out.push(`    drawApi:                    ${preview.drawApi}  (webgl | canvas2d | none)`);
    out.push(`    last tick action:           ${preview.lastTickAction}  (frame | no-frame | upload-failed | no-shm | none)`);
    out.push(`    last tick:                  ${preview.lastTickAtMsAgo == null ? 'n/a' : preview.lastTickAtMsAgo + ' ms ago'}`);
    out.push(`    shm opened:                 ${fmtBool(preview.shm && preview.shm.opened)}`);
    out.push(`    shm name:                   ${preview.shm && preview.shm.name || 'n/a'}`);
    out.push(`    shm open error:             ${preview.shm && preview.shm.error || 'none'}`);
    out.push(`    last shm index seen:        ${preview.shm && preview.shm.lastIndex}`);
    out.push(`    frames received:            ${preview.shm && preview.shm.framesReceived}`);
    out.push(`    last frame dimensions:      ${preview.shm && preview.shm.lastFrameW} × ${preview.shm && preview.shm.lastFrameH}`);
    out.push(`    texture upload success:     ${preview.texUploadSuccess}`);
    out.push(`    texture upload failures:    ${preview.texUploadFailures}`);
    out.push(`    last texture upload error:  ${preview.lastTexUploadError || 'none'}`);
    out.push(`    WebGL context lost count:   ${preview.contextLostCount}`);
    out.push(`    WebGL context restored:     ${preview.contextRestoredCount}`);
    if (preview.clearColorRgb) {
      const [r, g, b] = preview.clearColorRgb;
      out.push(`    Last fallback clear color:  rgb(${(r*255)|0}, ${(g*255)|0}, ${(b*255)|0})  (this is what fills the canvas when no frame is accepted)`);
    } else {
      out.push(`    Last fallback clear color:  not yet set (drawNoVideo never called) — canvas may show its CSS background`);
    }
    out.push('');
    out.push('    WebGL context info (FROM THE ACTUAL LIVE PREVIEW CANVAS):');
    if (preview.webgl && !preview.webgl.error) {
      const w = preview.webgl;
      out.push(`      GL_VENDOR:                ${w.vendor || 'n/a'}`);
      out.push(`      GL_RENDERER:              ${w.renderer || 'n/a'}`);
      out.push(`      GL_VERSION:               ${w.version || 'n/a'}`);
      out.push(`      GL_SHADING_LANGUAGE_VER:  ${w.glsl || 'n/a'}`);
      out.push(`      UNMASKED_VENDOR_WEBGL:    ${w.unmaskedVendor || 'n/a'}`);
      out.push(`      UNMASKED_RENDERER_WEBGL:  ${w.unmaskedRenderer || 'n/a'}`);
      out.push(`      MAX_TEXTURE_SIZE:         ${w.maxTextureSize || 'n/a'}`);
      if (Array.isArray(w.extensions)) {
        out.push(`      Extensions (${w.extensions.length}):`);
        const ext = w.extensions.slice().sort();
        for (let i = 0; i < ext.length; i += 4) {
          out.push('        ' + ext.slice(i, i + 4).join(', '));
        }
      }
    } else if (preview.webgl && preview.webgl.error) {
      out.push(`      ✗ WebGL context creation failed on the live preview canvas: ${preview.webgl.error}`);
    } else {
      out.push('      (no WebGL info captured — likely Canvas2D fallback or context creation failed)');
    }
  }
  out.push('');

  // ── 5b. Proxy WebGL context (settings-tab probe; weaker signal) ────────
  out.push('  Renderer side — PROXY WEBGL PROBE (Settings tab, NOT the live canvas):');
  out.push('    Chromium usually reuses the same GPU process for both contexts, but this is');
  out.push('    NOT guaranteed. Treat this as a backup only — section 5a above is authoritative.');
  const proxy = extras && extras.proxyWebgl;
  if (!proxy) {
    out.push('    (proxy probe data missing)');
  } else if (proxy.error) {
    out.push(`    ✗ Proxy WebGL context creation failed: ${proxy.error}`);
  } else {
    out.push(`    GL_VENDOR:                ${proxy.vendor || 'n/a'}`);
    out.push(`    GL_RENDERER:              ${proxy.renderer || 'n/a'}`);
    out.push(`    GL_VERSION:               ${proxy.version || 'n/a'}`);
    out.push(`    UNMASKED_VENDOR_WEBGL:    ${proxy.unmaskedVendor || 'n/a'}`);
    out.push(`    UNMASKED_RENDERER_WEBGL:  ${proxy.unmaskedRenderer || 'n/a'}`);
    out.push(`    MAX_TEXTURE_SIZE:         ${proxy.maxTextureSize || 'n/a'}`);
  }
  out.push('');

  // ── 5c. Interpretation (only claims things actually backed by data) ────
  out.push('  Interpretation:');
  if (!preview) {
    out.push('    (cannot interpret renderer health — preview was never mounted)');
  } else {
    const engineWroteFrames = engine && engine.counters && engine.counters.canvasCopyCount > 0;
    const rxFrames = preview.shm ? preview.shm.framesReceived : 0;
    const uploadFails = preview.texUploadFailures || 0;
    const uploadOk = preview.texUploadSuccess || 0;

    if (preview.mode === 'no-shm') {
      out.push('    ✗ openFrameShm() returned nothing → shm_helper.node not loaded or preload failed.');
      out.push('      Preview canvas is showing the WebGL clear color (see "fallback clear color" above)');
      out.push('      OR the underlying CSS background — that explains a white/black/themed surface.');
    } else if (preview.mode === 'shm-error') {
      out.push('    ✗ openFrameShm() threw → OpenFileMappingA failed (engine mapping not created yet,');
      out.push('      or FRAME_SHM_NAME mismatch). Same fallback-color story as no-shm above.');
    } else if (rxFrames === 0 && engineWroteFrames) {
      out.push('    ✗ Engine wrote frames but renderer received ZERO. Either the index never changed');
      out.push('      from the renderer\'s view (stale shared-memory mapping?) or the tick loop never ran.');
    } else if (uploadFails > 0 && uploadOk === 0) {
      out.push('    ✗ Every texture upload FAILED — WebGL/Canvas2D rejected the frame data.');
      out.push(`      Last error: ${preview.lastTexUploadError || 'unknown'}`);
      out.push('      Canvas is filled with the WebGL clear color (above) — that is your white/black surface.');
    } else if (preview.contextLostCount > 0) {
      out.push('    ✗ WebGL context was LOST at least once — AMD driver dropped it (often VRAM pressure).');
      out.push('      Once lost, the canvas paints clear color until the context is restored.');
    } else if (rxFrames > 0 && uploadOk > 0) {
      out.push('    ✓ Renderer is receiving frames AND uploading them successfully.');
      out.push('      If the preview is still blank, the engine may be writing all-zero pixels');
      out.push('      (check section 4 readbackValidCount > 0 vs actual pixel content).');
    } else {
      out.push('    (no clear failure pattern — share this report with the dev team for analysis)');
    }
  }
  out.push('');

  // ── 6. Memory / allocation ─────────────────────────────────────────────
  out.push('6. MEMORY / ALLOCATION');
  out.push(sep);
  if (engine) {
    const bytes = engine.frameOutputBufferSize || 0;
    out.push(`  Per-frame buffer:           ${bytes} bytes (${(bytes / (1024 * 1024)).toFixed(2)} MB)`);
    out.push(`  Shared-memory total:        ~${((bytes * 2 + 64) / (1024 * 1024)).toFixed(2)} MB (2 halves + 64-byte control)`);
  }
  out.push(`  Process memory (rss):       ${(process.memoryUsage().rss / (1024 * 1024)).toFixed(1)} MB`);
  out.push('  GPU memory pressure:        not directly available from JS — see vendor tooling');
  out.push('                              (Task Manager → Performance → GPU, or GPU-Z)');
  out.push('');

  // ── Footer ─────────────────────────────────────────────────────────────
  out.push(sep);
  out.push('Notes for the developer reading this report:');
  out.push('  • The Sample Selector and the imported-video popup BOTH use Chromium <video>');
  out.push('    elements served via http://127.0.0.1 — they are completely independent of the');
  out.push('    GridCompositor / shared-memory / WebGL pipeline. They working tells you nothing');
  out.push('    about the main preview path.');
  out.push('  • The "Hardware/Software" video mode setting only affects DECODE/ENCODE; it does');
  out.push('    NOT bypass the D3D11 GridCompositor or the WebGL canvas. There is no full CPU');
  out.push('    fallback for the main preview.');
  out.push('  • If section 4 shows readbackValid > 0 and section 5 shows framesReceived === 0,');
  out.push('    the failure is between the engine writing to the file mapping and the renderer');
  out.push('    reading from it — check shm_helper.node load and FRAME_SHM_NAME match.');
  out.push('  • If section 4 shows readbackInvalid > 0 and readbackValid === 0, the D3D11');
  out.push('    staging-texture readback is failing — typically wrong adapter, GPU driver crash,');
  out.push('    or out-of-VRAM on the integrated AMD adapter.');
  out.push(sep);
  out.push('End of report.');

  return out.join('\n') + '\n';
}

ipcMain.handle('xleth:diag:exportVisualPreviewLog', safeHandler(async (event, extras) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender) || win;

  // Pull engine state. Tolerate worker not ready / call failure — we still
  // want to produce *some* report so the tester can send something.
  let engine = null;
  let engineError = null;
  try {
    engine = await callWorker('diag_getVisualPreviewDiagnostic', []);
  } catch (e) {
    engineError = e && e.message ? e.message : String(e);
    log(`[diag] worker call failed: ${engineError}`);
  }

  // Carry forward the persisted videoMode setting for context.
  let settings = {};
  try { settings = loadSettings() || {}; } catch {}

  let body = buildVisualPreviewDiagnosticText({ engine, extras, settings });
  if (engineError) {
    let engineWarning;
    if (engineError === 'notImplemented') {
      engineWarning =
        'WARNING: engine diag returned "notImplemented" — sections 3 and 4 are empty.\n' +
        '\n' +
        'ROOT CAUSE: The packaged xleth_native.node was compiled BEFORE the\n' +
        'diag_getVisualPreviewDiagnostic function was added. The source code is\n' +
        'correct; the binary is stale.\n' +
        '\n' +
        'FIX (developer): Rebuild xleth_native.node:\n' +
        '  cmake --build build --target xleth_native   (or npm run build:addon)\n' +
        'Then repackage the portable EXE. Do NOT send this build to further\n' +
        'testers until the native addon binary is current.\n' +
        '\n' +
        'Sections 1, 2, 5, and 6 below were assembled from renderer-side data\n' +
        'only and are valid regardless of this error.\n';
    } else {
      engineWarning =
        `WARNING: engine diag call failed: ${engineError}\n` +
        `(sections 3 and 4 are empty; all other sections are renderer-side data)\n`;
    }
    body = engineWarning + '\n' + body;
  }

  const fileName = `xleth-visual-preview-diagnostic-${diagnosticTimestamp()}.txt`;

  // Try save dialog first; fall back to the user-data folder if the dialog
  // is unavailable (headless test, dialog cancelled, etc.).
  let savedPath = null;
  let cancelled = false;
  try {
    const defaultPath = path.join(app.getPath('desktop') || app.getPath('home') || '.', fileName);
    const result = await dialog.showSaveDialog(senderWin, {
      title: 'Export Visual Preview Diagnostic',
      defaultPath,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    if (result.canceled) {
      cancelled = true;
    } else if (result.filePath) {
      fs.writeFileSync(result.filePath, body, 'utf8');
      savedPath = result.filePath;
    }
  } catch (e) {
    log(`[diag] showSaveDialog failed: ${e.message}`);
  }

  if (cancelled) return { cancelled: true };

  if (!savedPath) {
    // Fallback: write to user data folder
    try {
      const fallback = userDataPath(fileName);
      fs.mkdirSync(path.dirname(fallback), { recursive: true });
      fs.writeFileSync(fallback, body, 'utf8');
      savedPath = fallback;
    } catch (e) {
      return { error: `failed to write diagnostic: ${e.message}` };
    }
  }

  log(`[diag] visual preview diagnostic written: ${savedPath}`);
  return { path: savedPath };
}));

ipcMain.handle('xleth:video:computeDurationSeconds',
  safeHandler((_, startBeat, endBeat) =>
    callWorker('video_computeDurationSeconds', [startBeat, endBeat])));

// ── Export presets (persisted in xleth-settings.json under "exportPresets") ─
// See ui/src/components/exportPresets/presets.js for the defaults / migrator.
const CURRENT_EXPORT_PRESET_VERSION = 1;

function defaultExportPresets() {
  return {
    version:  CURRENT_EXPORT_PRESET_VERSION,
    lastTab:  'youtube',
    youtube:  { resolution: '1080p', fps: 60, quality: 0.75, hwEncoder: null },
    discord:  { tier: 'free', fps: 30, hwEncoder: null },
    custom:   [],
    migrated: false,
  };
}

function migrateExportPresets(stored) {
  if (!stored || typeof stored !== 'object' ||
      typeof stored.version !== 'number' ||
      stored.version < CURRENT_EXPORT_PRESET_VERSION) {
    const d = defaultExportPresets();
    d.migrated = true;  // renderer surfaces a one-time toast
    return d;
  }
  return stored;
}

ipcMain.handle('xleth:video:getExportPresets', safeHandler(() => {
  const s = loadSettings();
  return migrateExportPresets(s.exportPresets);
}));

ipcMain.handle('xleth:video:saveExportPresets', safeHandler((_, presets) => {
  if (!presets || typeof presets !== 'object') return false;
  const s = loadSettings();
  const clean = { ...presets, version: CURRENT_EXPORT_PRESET_VERSION };
  delete clean.migrated;
  s.exportPresets = clean;
  saveSettings(s);
  return true;
}));

// ── Sample Export / Swap ──────────────────────────────────────────────────────

// Dialog: open a WAV file to swap in as processed audio
ipcMain.handle('xleth:dialog:swapAudio', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Select Processed Audio',
    filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
    properties: ['openFile'],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

// Export region audio to exports/ at native sample rate, then reveal in Explorer
ipcMain.handle('xleth:audio:exportRegion',
  safeHandler(async (_, regionId) => {
    const result = await callWorker('audio_exportRegion', [regionId]);
    if (result?.success && result.path) shell.showItemInFolder(result.path);
    return result;
  }));

ipcMain.handle('xleth:audio:swapRegionAudio',
  safeHandler((_, regionId, processedFilePath) =>
    callWorker('audio_swapRegionAudio', [regionId, processedFilePath])));

ipcMain.handle('xleth:audio:revertRegionAudio',
  safeHandler((_, regionId) =>
    callWorker('audio_revertRegionAudio', [regionId])));

ipcMain.handle('xleth:audio:loadRegionAudio',
  safeHandler((_, regionId) =>
    callWorker('audio_loadRegionAudio', [regionId])));

ipcMain.handle('xleth:audio:probeAudioDuration',
  safeHandler((_, filePath) =>
    callWorker('audio_probeAudioDuration', [filePath])));

// ── Phase 1B — SourcePlayer (Sample Picker audio preview via engine) ────────

ipcMain.handle('xleth:audio:loadSource',
  safeHandler((_, filePath) => callWorker('source_loadSource', [filePath])));

ipcMain.handle('xleth:audio:playSource',
  safeHandler((_, startTime) => callWorker('source_playSource', [startTime ?? 0])));

ipcMain.handle('xleth:audio:pauseSource',
  safeHandler(() => callWorker('source_pauseSource')));

ipcMain.handle('xleth:audio:resumeSource',
  safeHandler(() => callWorker('source_resumeSource')));

ipcMain.handle('xleth:audio:seekSource',
  safeHandler((_, time) => callWorker('source_seekSource', [time])));

ipcMain.handle('xleth:audio:stopSource',
  safeHandler(() => callWorker('source_stopSource')));

ipcMain.handle('xleth:audio:getSourcePosition',
  safeHandler(() => callWorker('source_getPosition')));

ipcMain.handle('xleth:audio:isSourcePlaying',
  safeHandler(() => callWorker('source_isPlaying')));

ipcMain.handle('xleth:audio:unloadSource',
  safeHandler(() => callWorker('source_unloadSource')));

// ── Waveform mipmap bindings (replace FFmpeg 8kHz extraction pipeline) ───────

ipcMain.handle('xleth:waveform:getRegionPeaks',
  safeHandler((_, regionId, startTime, endTime, targetPixels, channel) =>
    callWorker('waveform_getRegionPeaks', [regionId, startTime, endTime, targetPixels, channel])));

ipcMain.handle('xleth:waveform:getRawSamples',
  safeHandler((_, regionId, startSample, endSample, channel) =>
    callWorker('waveform_getRawSamples', [regionId, startSample, endSample, channel])));

ipcMain.handle('xleth:waveform:getFilePeaks',
  safeHandler((_, filePath, startTime, endTime, targetPixels, channel) =>
    callWorker('waveform_getFilePeaks', [filePath, startTime, endTime, targetPixels, channel])));

ipcMain.handle('xleth:waveform:getClipPeaks',
  safeHandler((_, clipId, startSec, endSec, numPeaks) =>
    callWorker('waveform_getClipPeaks', [clipId, startSec, endSec, numPeaks])));

// ── MIDI Import ───────────────────────────────────────────────────────────────

ipcMain.handle('xleth:midi:parseSummary', (_, filePath) =>
    callWorker('midi_parseSummary', [filePath]));

ipcMain.handle('xleth:midi:importFull', (_, filePath, optionsJson) =>
    callWorker('midi_importFull', [filePath, optionsJson]));

ipcMain.handle('xleth:midi:executeImport', (_, noteData, optionsJson) =>
    // preload.js guarantees noteData is a Buffer; fork uses serialization:'advanced'
    // so it crosses to the worker as a real Buffer. No coercion needed here.
    callWorker('midi_executeImport', [noteData, optionsJson]));

// Replaced by WaveformMipmap N-API bindings — see WaveformMipmap.h
// Pipeline A (extractPCM, pcmCache, buildPeaks, getWaveformData/Region IPC) removed.

// ── Phase 1B — FrameServer (native frame extraction via C++ engine) ─────────

ipcMain.handle('xleth:video:openSource',
  safeHandler((_, sourceId) => callWorker('video_openSource', [sourceId])));

ipcMain.handle('xleth:video:closeSource',
  safeHandler((_, sourceId) => callWorker('video_closeSource', [sourceId])));

// Legacy FFmpeg subprocess fallback (for callers still passing filePath strings)
function legacyGetFrameAtTime(filePath, timeSeconds) {
  const { execFile } = require('child_process');
  const os = require('os');
  const t  = Math.max(0, timeSeconds || 0);
  const outFile = path.join(os.tmpdir(), `xleth_frame_${Date.now()}.jpg`);
  log(`[FrameServer] Legacy FFmpeg frame @ ${t.toFixed(3)}s: ${path.basename(filePath)}`);
  return new Promise(resolve => {
    execFile(ffmpegExecutable(), [
      '-y',
      '-ss', String(t),
      '-i',  filePath,
      '-frames:v', '1',
      '-update',   '1',
      '-q:v',      '4',
      outFile,
    ], { timeout: 15000 }, (err) => {
      if (err) { resolve(null); return; }
      try {
        const data = fs.readFileSync(outFile);
        try { fs.unlinkSync(outFile); } catch {}
        resolve(data.length > 100
          ? 'data:image/jpeg;base64,' + data.toString('base64')
          : null);
      } catch { resolve(null); }
    });
  });
}

ipcMain.handle('xleth:video:getFrameAtTime', async (_, sourceIdOrPath, timeSeconds, maxWidth, maxHeight) => {
  // New path: sourceId (number) → native FrameServer
  if (typeof sourceIdOrPath === 'number') {
    const buf = await callWorker('video_getFrame', [
      sourceIdOrPath, timeSeconds, maxWidth || 480, maxHeight || 270, 75
    ]);
    if (!buf || buf.length < 100) return null;
    return 'data:image/jpeg;base64,' + Buffer.from(buf).toString('base64');
  }
  // Legacy path: filePath (string) → FFmpeg subprocess
  return legacyGetFrameAtTime(sourceIdOrPath, timeSeconds);
});

ipcMain.handle('xleth:audio:detectRootNote', async (_, filePath) => {
  log(`[SampleSelector] Detecting root note: ${path.basename(filePath)}`);
  try {
    // Only WAV files can have smpl chunks
    if (!/\.wav$/i.test(filePath)) return { note: -1 };

    const buf = fs.readFileSync(filePath);
    // Verify RIFF/WAVE header
    if (buf.length < 44) return { note: -1 };
    const riff = buf.toString('ascii', 0, 4);
    const wave = buf.toString('ascii', 8, 12);
    if (riff !== 'RIFF' || wave !== 'WAVE') return { note: -1 };

    // Walk chunks starting after the WAVE header (offset 12)
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const chunkId   = buf.toString('ascii', offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);
      if (chunkId === 'smpl' && chunkSize >= 16 && offset + 8 + 16 <= buf.length) {
        // smpl chunk layout: manufacturer(4), product(4), samplePeriod(4), midiUnityNote(4)
        const midiNote = buf.readUInt32LE(offset + 8 + 12);
        log(`[SampleSelector] Root note detected: MIDI ${midiNote} (${path.basename(filePath)})`);
        return { note: midiNote, confidence: 1.0 };
      }
      // Advance to next chunk (chunks are padded to even size)
      offset += 8 + chunkSize + (chunkSize % 2);
    }

    return { note: -1 };
  } catch (e) {
    log(`[SampleSelector] Root note detection failed: ${e.message}`);
    return { note: -1 };
  }
});

// ── Phase 1 handlers — Dialogs & Shell ───────────────────────────────────────

ipcMain.handle('xleth:dialog:newProject', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose Project Folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths.length) return null;
  log(`[ProjectMedia] New project folder: ${filePaths[0]}`);
  return filePaths[0];
});

ipcMain.handle('xleth:dialog:openProject', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open Project',
    filters: [
      { name: 'XLETH Project', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths.length) return null;
  log(`[ProjectMedia] Open project folder: ${filePaths[0]}`);
  return filePaths[0];
});

ipcMain.handle('xleth:dialog:saveProjectAs', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Save Project As — Choose Folder',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Save Here',
  });
  if (canceled || !filePaths.length) return null;
  log(`[ProjectMedia] Save As folder: ${filePaths[0]}`);
  return filePaths[0];
});

ipcMain.handle('xleth:dialog:importMIDI', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import MIDI',
    filters: [
      { name: 'MIDI Files', extensions: ['mid', 'midi'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;
  log(`[MidiImport] Import dialog selected: ${filePaths[0]}`);
  return filePaths[0];
});

ipcMain.handle('xleth:dialog:importSources', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Sources',
    filters: [
      { name: 'All Supported', extensions: ['mp4', 'avi', 'mov', 'mkv', 'wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a'] },
      { name: 'Video Files', extensions: ['mp4', 'avi', 'mov', 'mkv'] },
      { name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled || !filePaths.length) return null;
  log(`[ProjectMedia] Import dialog selected ${filePaths.length} file(s)`);
  return filePaths;
});

ipcMain.handle('xleth:dialog:exportAudio', async (_, defaultName, format) => {
  const filters = ({
    wav:  [{ name: 'WAV Audio',  extensions: ['wav']  }],
    mp3:  [{ name: 'MP3 Audio',  extensions: ['mp3']  }],
    flac: [{ name: 'FLAC Audio', extensions: ['flac'] }],
  })[format] || [{ name: 'All Files', extensions: ['*'] }];
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Audio As…',
    defaultPath: defaultName || `export.${format || 'wav'}`,
    filters,
  });
  if (canceled || !filePath) return null;
  log(`[ProjectMedia] Export audio target: ${filePath}`);
  return filePath;
});

ipcMain.handle('xleth:dialog:exportVideo', async (_, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Video As…',
    defaultPath: defaultName || 'export.mp4',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });
  if (canceled || !filePath) return null;
  log(`[ProjectMedia] Export video target: ${filePath}`);
  return filePath;
});

ipcMain.handle('xleth:project:getSourceThumbnail', async (_, filePath, duration) => {
  const { execFile } = require('child_process');
  const os = require('os');
  const base = path.join(os.tmpdir(), `xleth_${Date.now()}`);
  const name = path.basename(filePath);

  // Run ffmpeg with given args, return Buffer if output > 1KB, else null
  function tryFfmpeg(args, outFile) {
    return new Promise(resolve => {
      execFile(ffmpegExecutable(), args, { timeout: 20000 }, err => {
        if (err) return resolve(null);
        try {
          const data = fs.readFileSync(outFile);
          try { fs.unlinkSync(outFile); } catch {}
          resolve(data.length > 1024 ? data : null);
        } catch { resolve(null); }
      });
    });
  }

  // Run a PowerShell .ps1 file, return Buffer from outFile if > 1KB, else null
  function tryPowershell(script, outFile) {
    const psFile = base + '.ps1';
    try { fs.writeFileSync(psFile, script, 'utf8'); } catch { return Promise.resolve(null); }
    return new Promise(resolve => {
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile],
        { timeout: 15000 },
        err => {
          try { fs.unlinkSync(psFile); } catch {}
          if (err) return resolve(null);
          try {
            const data = fs.readFileSync(outFile);
            try { fs.unlinkSync(outFile); } catch {}
            resolve(data.length > 1024 ? data : null);
          } catch { resolve(null); }
        }
      );
    });
  }

  // ── Strategy 1: Embedded cover art (MP4 attached_pic / tagged thumbnail) ──
  // NOTE: do NOT use -vcodec copy — cover art may be PNG inside the MP4,
  // copying raw bytes then labeling as image/jpeg breaks the browser decoder.
  // Let FFmpeg re-encode to JPEG (output extension drives the codec choice).
  const coverOut = base + '_cover.jpg';
  const coverData = await tryFfmpeg([
    '-y', '-i', filePath,
    '-map', '0:v', '-map', '-0:v:0',   // all video streams except the main one
    '-vframes', '1', '-update', '1', '-q:v', '4',
    coverOut,
  ], coverOut);
  if (coverData) {
    log(`[ProjectMedia] Embedded cover art: ${name} (${coverData.length} bytes)`);
    return 'data:image/jpeg;base64,' + coverData.toString('base64');
  }

  // ── Strategy 2: Windows Shell thumbnail — same as File Explorer ───────────
  // Uses IShellItemImageFactory COM interface (exact Windows thumbnail cache)
  const shellOut = base + '_shell.jpg';
  const fp = filePath.replace(/'/g, "''");   // escape single quotes for PS
  const so = shellOut.replace(/'/g, "''");
  const psScript = `
$null = [Reflection.Assembly]::LoadWithPartialName('System.Drawing')
Add-Type @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class WinThumb {
    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISIIF { [PreserveSig] int GetImage(SIZE sz, int f, out IntPtr h); }
    [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
    [DllImport("shell32", CharSet=CharSet.Unicode, PreserveSig=false)]
    static extern void SHCreateItemFromParsingName(string p, IntPtr b, ref Guid g,
        [MarshalAs(UnmanagedType.IUnknown)] out object o);
    [DllImport("gdi32")] static extern bool DeleteObject(IntPtr h);
    public static byte[] Get(string src) {
        var g = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
        SHCreateItemFromParsingName(src, IntPtr.Zero, ref g, out var o);
        if (o == null) return null;
        var f = o as ISIIF; if (f == null) return null;
        if (f.GetImage(new SIZE{cx=320,cy=180}, 0, out var h) != 0) return null;
        using (var bmp = Image.FromHbitmap(h)) { DeleteObject(h);
            using (var ms = new System.IO.MemoryStream()) {
                bmp.Save(ms, ImageFormat.Jpeg); return ms.ToArray(); } }
    }
}
"@ -ReferencedAssemblies System.Drawing
$b = [WinThumb]::Get('${fp}')
if ($b -and $b.Length -gt 0) { [System.IO.File]::WriteAllBytes('${so}', $b) }
`;
  const shellData = await tryPowershell(psScript, shellOut);
  if (shellData) {
    log(`[ProjectMedia] Windows Shell thumbnail: ${name} (${shellData.length} bytes)`);
    return 'data:image/jpeg;base64,' + shellData.toString('base64');
  }

  // ── Strategy 3: Single seeked frame at 10% of duration (fast keyframe seek) ─
  const thumbOut = base + '_thumb.jpg';
  const seekSecs = (typeof duration === 'number' && duration > 1) ? duration * 0.1 : 3;
  const thumbData = await tryFfmpeg([
    '-y', '-ss', seekSecs.toFixed(3),
    '-i', filePath,
    '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
    '-frames:v', '1', '-update', '1', '-q:v', '4',
    thumbOut,
  ], thumbOut);
  if (thumbData) {
    log(`[ProjectMedia] Seeked-frame thumbnail: ${name} seek=${seekSecs.toFixed(1)}s (${thumbData.length} bytes)`);
    return 'data:image/jpeg;base64,' + thumbData.toString('base64');
  }

  log(`[ProjectMedia] All thumbnail strategies failed for ${name}`);
  return null;
});

ipcMain.handle('xleth:shell:showItemInFolder', (_, filePath) => {
  log(`[ProjectMedia] Reveal in folder: ${filePath}`);
  shell.showItemInFolder(filePath);
});

ipcMain.handle('xleth:shell:openPath', async (_, filePath) => {
  log(`[Shell] Open path: ${filePath}`);
  return shell.openPath(filePath);
});

// ── Media server port (for <video> elements) ──────────────────────────────────

ipcMain.handle('xleth:getMediaPort', () => mediaPort);

// ── Window controls (frameless title bar) ─────────────────────────────────────

ipcMain.on('xleth:window:minimize', () => { log('[IPC] window:minimize'); win?.minimize(); });
ipcMain.on('xleth:window:maximize', () => {
  log('[IPC] window:maximize');
  if (win?.isMaximized()) win.unmaximize(); else win?.maximize();
});
ipcMain.on('xleth:window:close', () => { log('[IPC] window:close'); win?.close(); });
ipcMain.on('xleth:window:zoomIn', (event) => {
  const nextFactor = nudgeWindowZoom(getTargetWindow(event), 1);
  log(`[IPC] window:zoomIn -> ${nextFactor}`);
});
ipcMain.on('xleth:window:zoomOut', (event) => {
  const nextFactor = nudgeWindowZoom(getTargetWindow(event), -1);
  log(`[IPC] window:zoomOut -> ${nextFactor}`);
});
ipcMain.on('xleth:window:resetZoom', (event) => {
  const nextFactor = setWindowZoom(getTargetWindow(event), DEFAULT_ZOOM_FACTOR);
  log(`[IPC] window:resetZoom -> ${nextFactor}`);
});

// ── Node Editor child windows ─────────────────────────────────────────────────

ipcMain.on('xleth:window:openNodeEditor', (event, key, pos) => {
  log(`[IPC] openNodeEditor key=${key} pos=${pos}`);

  const existing = nodeEditorWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const child = new BrowserWindow({
    width: 800,
    height: 500,
    minWidth: 500,
    minHeight: 350,
    backgroundColor: '#0A0A0F',
    frame: false,
    parent: win,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      preload: runtimeResource('app', 'preload.js'),
    },
  });

  const posParam = pos != null ? `&pos=${pos}` : '';
  const query = `?view=node-editor&key=${encodeURIComponent(key)}${posParam}`;
  if (!app.isPackaged) {
    child.loadURL(`http://localhost:5173${query}`);
  } else {
    child.loadFile(runtimeResource('app', 'dist', 'index.html'), { search: query });
  }

  child.webContents.on('console-message', (_e, level, message, line, source) => {
    const prefix = level === 3 ? '[NE ERROR]' : level === 2 ? '[NE WARN]' : '[NE]';
    log(`${prefix} ${message}  (${source}:${line})`);
  });

  child.on('closed', () => {
    nodeEditorWindows.delete(key);
    log(`[IPC] nodeEditor closed key=${key}`);
  });

  nodeEditorWindows.set(key, child);
});

ipcMain.on('xleth:window:closeNodeEditor', (event) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow && senderWindow !== win) {
    senderWindow.close();
  }
});

// ── App lifecycle ──────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  log('app ready — loading addon...');

  // ── Splash window ──────────────────────────────────────────────────────────
  splashWin = new BrowserWindow({
    width: 680,
    height: 400,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: false,
    center: true,
    backgroundColor: '#0D0F13',
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'splash-preload.js'),
    },
  });
  splashWin.once('ready-to-show', () => {
    // Inject logo as base64 data URL — avoids Chromium's cross-origin
    // block on file:// URLs from different directories.
    const logoPath = app.isPackaged
      ? path.join(process.resourcesPath, 'xlethpopup.png')
      : path.join(__dirname, '..', 'xlethpopup.png');
    try {
      const dataUrl = 'data:image/png;base64,' +
        fs.readFileSync(logoPath).toString('base64');
      splashWin.webContents.executeJavaScript(
        `document.getElementById('logo').src = ${JSON.stringify(dataUrl)};`
      ).catch(() => {});
    } catch { /* logo file absent — img stays hidden via onerror */ }
    splashWin.show();
  });
  splashWin.loadFile(path.join(__dirname, 'splash.html'));
  splashWin.on('closed', () => { splashWin = null; });
  // ──────────────────────────────────────────────────────────────────────────

  // COOP/COEP — required so the renderer's `crossOriginIsolated` flag is
  // true, which is a prerequisite for `SharedArrayBuffer` in Chromium.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    responseHeaders['Cross-Origin-Opener-Policy']   = ['same-origin'];
    responseHeaders['Cross-Origin-Embedder-Policy'] = ['require-corp'];
    callback({ responseHeaders });
  });

  try {
    startWorker();
    splashStatus('Initializing audio engine…');
    // Wait for worker ready signal (arrives on 'message' as {ready:true}).
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const check = () => {
        if (workerReady) return resolve();
        if (addonError) return reject(new Error(addonError));
        if (Date.now() - t0 > 10000) return reject(new Error('worker ready timeout'));
        setTimeout(check, 50);
      };
      check();
    });
    splashStatus('Registering codecs…');

    await callWorker('initialize');
    log('initialize() OK');
    splashStatus('Starting compositor…');

    // Swap the engine's owned FrameOutput buffer for a Windows named file
    // mapping so the renderer can read frames zero-copy via shm_helper.
    // 960x540 matches CANVAS_W/H in the addon's default initialize().
    try {
      await ensureFrameShm(960, 540);
    } catch (e) {
      log(`shm init FAILED: ${e.message}`);
    }

    // Load samples
    const mediaDir = runtimeResource('media');
    await callWorker('loadSample', [path.join(mediaDir, 'KICK_ssedit.wav')]);
    await callWorker('loadSample', [path.join(mediaDir, 'SNARE_ssedit.wav')]);
    await callWorker('loadSample', [path.join(mediaDir, 'hihat 1.wav')]);
    log('Samples loaded');
    splashStatus('Loading workspace…');

    // Load video if available
    const videoPath = path.join(mediaDir, 'source_clip.mp4');
    if (fs.existsSync(videoPath)) {
      await callWorker('loadVideo', [videoPath]);
      log('Video loaded');
    } else {
      log('No video file — skipping loadVideo');
    }

    // Set up audio-scheduler timeline (drum pattern for legacy transport)
    await callWorker('setBPM', [140]);
    const drumPattern = [
      { offset: 0.00, id: 0 },
      { offset: 1.00, id: 2 },
      { offset: 1.25, id: 2 },
      { offset: 2.00, id: 0 },
      { offset: 2.00, id: 1 },
      { offset: 3.00, id: 2 },
      { offset: 3.25, id: 2 },
    ];
    for (let bar = 0; bar < 8; bar++) {
      for (const hit of drumPattern) {
        await callWorker('addAudioEvent', [bar * 4 + hit.offset, hit.id, 1.0]);
      }
    }
    log('Timeline populated (8 bars, kick|hh hh|kick+snare|hh hh at BPM=140)');

  } catch (e) {
    addonError = e.message;
    log(`Engine init FAILED: ${e.message}`);
    if (splashWin && !splashWin.isDestroyed()) splashWin.close();
  }

  // Serve local media files via xleth-media:// protocol so the renderer can load
  // audio/video without file:// CORS/CSP issues when running from localhost:5173.
  // Explicit Range support is required for <video> seeking — net.fetch with
  // file:// URLs doesn't reliably handle Range headers in all Electron versions.
  const MIME_TYPES = {
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska', '.webm': 'video/webm',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
    '.ogg': 'audio/ogg', '.aac': 'audio/aac',
  };

  protocol.handle('xleth-media', async (request) => {
    log(`[Protocol] Request: ${request.url} Range: ${request.headers.get('Range')}`);
    // buildAudioUrl places the Windows drive letter as the URL host, e.g.:
    //   xleth-media://e/Shows/file.mp4  →  E:\Shows\file.mp4
    // Triple-slash URLs (xleth-media:///C%3A/...) have empty hostname.
    const { hostname, pathname } = new URL(request.url);
    let filePath;
    if (/^[a-zA-Z]$/.test(hostname)) {
      filePath = hostname.toUpperCase() + ':' +
                 decodeURIComponent(pathname).replace(/\//g, path.sep);
    } else {
      filePath = decodeURIComponent(pathname.slice(1)).replace(/\//g, path.sep);
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const rangeHeader = request.headers.get('Range');

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : Math.min(start + 1024 * 1024, fileSize - 1);
        const chunkSize = end - start + 1;
        return new Response(
          fs.createReadStream(filePath, { start, end }),
          {
            status: 206,
            headers: {
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(chunkSize),
              'Content-Type': contentType,
              'Cross-Origin-Resource-Policy': 'cross-origin',
            },
          }
        );
      }
    }

    return new Response(
      fs.createReadStream(filePath),
      {
        status: 200,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Length': String(fileSize),
          'Content-Type': contentType,
          'Cross-Origin-Resource-Policy': 'cross-origin',
        },
      }
    );
  });
  log('[Protocol] xleth-media registered');

  startMediaServer();

  createWindow();

  // ── Splash → main window handoff ──────────────────────────────────────────
  if (win) {
    win.once('ready-to-show', () => {
      setTimeout(() => {
        if (splashWin && !splashWin.isDestroyed()) {
          splashWin.webContents.executeJavaScript(
            `document.body.classList.add('fade-out');`
          ).catch(() => {});
          setTimeout(() => {
            if (splashWin && !splashWin.isDestroyed()) splashWin.close();
            win.show();
          }, 320); // 300ms CSS transition + 20ms buffer
        } else {
          win.show(); // splash already gone — show immediately
        }
      }, 400); // minimum splash visibility after first paint
    });
  }
  // ──────────────────────────────────────────────────────────────────────────

  // Pass the main-window native HWND to the worker so VST editor-host
  // processes can call SetWindowLongPtrW(GWLP_HWNDPARENT) and be treated as
  // owned popups: they minimize with the main window, don't get a separate
  // taskbar button, and stay above the main window in Z-order.
  if (win && workerReady) {
    try {
      const hwndBuf = win.getNativeWindowHandle();
      // Buffer is little-endian; on 64-bit Windows it is 8 bytes.
      const hwndBigInt = hwndBuf.length >= 8
        ? hwndBuf.readBigUInt64LE(0)
        : BigInt(hwndBuf.readUInt32LE(0));
      const hwndHex = hwndBigInt.toString(16).toUpperCase();
      log(`[HWND] Main window handle: 0x${hwndHex}`);
      callWorker('audio_setMainWindowHandle', [hwndHex]).catch(e =>
        log('[HWND] setMainWindowHandle failed: ' + e.message));
    } catch (e) {
      log('[HWND] Failed to read native window handle: ' + e.message);
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (win === null) createWindow();
});

app.on('before-quit', async () => {
  if (workerReady) {
    try { await callWorker('shutdown'); } catch (e) { log('shutdown error: ' + e.message); }
  }
  try { worker?.kill(); } catch {}
  log('Exiting.');
});

// Also expose the frame-shm meta synchronously for preload (sendSync path).
ipcMain.on('xleth:video:getFrameShmSync', (event) => {
  event.returnValue = frameShmMeta;
});

process.on('uncaughtException', (e) => {
  log(`uncaughtException: ${e.message}\n${e.stack}`);
});
