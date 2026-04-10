'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { fork } = require('child_process');

// Fixed name for the Windows file mapping that backs the FrameOutput double
// buffer. The forked addon-worker creates it via FrameOutput::initSharedMemory;
// the Electron main process / preload opens the same name via shm_helper.node.
const FRAME_SHM_NAME = 'XlethFrameBuffer';


// ── User settings (persisted across sessions, not per-project) ───────────────
const settingsPath = path.join(app.getPath('userData'), 'xleth-settings.json')
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch { return {} }
}
function saveSettings(s) {
  try { fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf8') } catch {}
}

// Log file for startup debugging
const logPath = path.join(__dirname, 'startup.log');
fs.writeFileSync(logPath, '');  // clear previous log
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(logPath, line);
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
const SILENT_METHODS = new Set(['getFrameRGBA', 'getCurrentFrame', 'getFrameBuffer', 'getTransportState', 'audio_getAllPeaks', 'audio_setTrackVolume', 'audio_setTrackPan', 'audio_setTrackSpread']);
// Last known transport state — only log when it actually changes
let lastTransportStateStr = null;

function startWorker() {
  const workerPath = path.join(__dirname, 'addon-worker.js');
  // Force system node.exe — not electron.exe --run-as-node — because the
  // JUCE/FFmpeg static initializers crash inside Electron's runtime.
  // The addon is ABI-compatible with recent Node versions.
  const nodeExe = process.env.XLETH_NODE_EXE || 'node.exe';
  log(`Forking addon worker via ${nodeExe}: ${workerPath}`);
  worker = fork(workerPath, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    execPath: nodeExe,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
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
const nodeEditorWindows = new Map(); // key → BrowserWindow

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0A0A0F',
    frame: false,
    webPreferences: {
      // contextIsolation disabled so preload can hand the renderer a live
      // ArrayBuffer reference (shm_helper's file-mapped view). With isolation
      // on, contextBridge would structured-clone the buffer → dead copy.
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (addonError) {
    const msg = encodeURIComponent(addonError);
    win.loadURL(`data:text/html,<pre style="color:red;background:%230A0A0F;padding:20px">Addon error:\n${msg}</pre>`);
  } else if (!app.isPackaged) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, 'dist/index.html'));
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
    return result;
  }));

ipcMain.handle('xleth:project:importSource',
  safeHandler((_, filePath) => callWorker('project_importSource', [filePath])));

ipcMain.handle('xleth:project:validateMedia',
  safeHandler(() => callWorker('project_validateMedia')));

ipcMain.handle('xleth:project:getInfo',
  safeHandler(() => callWorker('project_getInfo')));

// ── Phase 1 handlers — Timeline queries ──────────────────────────────────────

ipcMain.handle('xleth:timeline:getBPM',
  safeHandler(() => callWorker('timeline_getBPM')));

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

ipcMain.handle('xleth:timeline:addTrack',
  safeHandler((_, info) => callWorker('timeline_addTrack', [info])));

ipcMain.handle('xleth:timeline:removeTrack',
  safeHandler((_, id) => callWorker('timeline_removeTrack', [id])));

ipcMain.handle('xleth:timeline:setTrackMuted',
  safeHandler((_, trackId, muted) => callWorker('timeline_setTrackMuted', [trackId, muted])));

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

ipcMain.handle('xleth:timeline:setVideoFlipMode',
  safeHandler((_, trackId, mode) => callWorker('timeline_setVideoFlipMode', [trackId, mode])));

ipcMain.handle('xleth:timeline:setVideoHoldLastFrame',
  safeHandler((_, trackId, hold) => callWorker('timeline_setVideoHoldLastFrame', [trackId, hold])));

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

ipcMain.handle('xleth:timeline:setClipParams',
  safeHandler((_, id, params) => callWorker('timeline_setClipParams', [id, params])));

// ── Global clip-processing defaults ─────────────────────────────────────────
ipcMain.handle('xleth:settings:get',    (_, key) => loadSettings()[key])
ipcMain.handle('xleth:settings:set',    (_, key, value) => {
  const s = loadSettings(); s[key] = value; saveSettings(s)
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
    execFile('ffmpeg', [
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

ipcMain.handle('xleth:project:getSourceThumbnail', async (_, filePath) => {
  const { execFile } = require('child_process');
  const os = require('os');
  const base = path.join(os.tmpdir(), `xleth_${Date.now()}`);
  const name = path.basename(filePath);

  // Run ffmpeg with given args, return Buffer if output > 1KB, else null
  function tryFfmpeg(args, outFile) {
    return new Promise(resolve => {
      execFile('ffmpeg', args, { timeout: 20000 }, err => {
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

  // ── Strategy 3: FFmpeg thumbnail filter — picks best representative frame ─
  const thumbOut = base + '_thumb.jpg';
  const thumbData = await tryFfmpeg([
    '-y', '-i', filePath,
    '-vf', 'thumbnail=n=200,scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
    '-frames:v', '1', '-update', '1', '-q:v', '4',
    thumbOut,
  ], thumbOut);
  if (thumbData) {
    log(`[ProjectMedia] Best-frame thumbnail: ${name} (${thumbData.length} bytes)`);
    return 'data:image/jpeg;base64,' + thumbData.toString('base64');
  }

  log(`[ProjectMedia] All thumbnail strategies failed for ${name}`);
  return null;
});

ipcMain.handle('xleth:shell:showItemInFolder', (_, filePath) => {
  log(`[ProjectMedia] Reveal in folder: ${filePath}`);
  shell.showItemInFolder(filePath);
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
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const posParam = pos != null ? `&pos=${pos}` : '';
  const query = `?view=node-editor&key=${encodeURIComponent(key)}${posParam}`;
  if (!app.isPackaged) {
    child.loadURL(`http://localhost:5173${query}`);
  } else {
    child.loadFile(path.join(__dirname, 'dist/index.html'), { search: query });
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

    await callWorker('initialize');
    log('initialize() OK');

    // Swap the engine's owned FrameOutput buffer for a Windows named file
    // mapping so the renderer can read frames zero-copy via shm_helper.
    // 960x540 matches CANVAS_W/H in the addon's default initialize().
    try {
      await ensureFrameShm(960, 540);
    } catch (e) {
      log(`shm init FAILED: ${e.message}`);
    }

    // Load samples
    const mediaDir = path.join(__dirname, '../media');
    await callWorker('loadSample', [path.join(mediaDir, 'KICK_ssedit.wav')]);
    await callWorker('loadSample', [path.join(mediaDir, 'SNARE_ssedit.wav')]);
    await callWorker('loadSample', [path.join(mediaDir, 'hihat 1.wav')]);
    log('Samples loaded');

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
