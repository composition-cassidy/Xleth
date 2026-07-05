'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { runtimeResource, userDataPath } = require('./runtimePaths');
const { checkForUpdates } = require('./update-checker');
const {
  WORKSPACE_BACKDROP_DEFAULT_PREFERENCE,
  applyWorkspaceBackdropMaterial,
  getWorkspaceBackdropCachePath,
  loadWorkspaceBackdropCapability,
  sanitizeWorkspaceBackdropPreference,
} = require('./workspaceBackdropCapability');

// Fixed name for the Windows file mapping that backs the FrameOutput double
// buffer. The engine worker creates it via FrameOutput::initSharedMemory;
// the Electron main process / preload opens the same name via shm_helper.node.
const FRAME_SHM_NAME = 'XlethFrameBuffer';
const WORKSPACE_BACKDROP_DEFAULT_IMAGE = 'backdrop-1@1.25x.png';
const WORKSPACE_BACKDROP_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const BACKDROP_MEDIA_SETTINGS_KEY = 'backdropMedia';
const BACKDROP_MEDIA_SOURCE_TYPES = new Set(['none', 'acrylic', 'image', 'video']);


// ── User settings (persisted across sessions, not per-project) ───────────────
// Extracted to electron-main/settings.js (S5 Stage 2) together with the
// xleth:layout:read/write handlers. loadSettings/saveSettings and
// getNewProjectGlobalStretchMethodDefault come from the Stage 2 require block
// below.

// Log file for startup debugging
const logPath = userDataPath('startup.log');
try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
fs.writeFileSync(logPath, '');  // clear previous log
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(logPath, line);
}

// ── Extracted main-process modules (S5 Stage 1) ──────────────────────────────
// Engine-worker lifecycle and the local HTTP media server were moved verbatim
// to ui/electron-main/. Both are wired with the shared startup.log logger.
const workerBridge = require('./electron-main/worker');
const mediaServer = require('./electron-main/media-server');
workerBridge.init({ log });
mediaServer.init({ log });
const { startWorker, callWorker, isWorkerReady, getAddonError, setAddonError, killWorker } = workerBridge;
const { startMediaServer, getMediaPort } = mediaServer;

// ── Extracted main-process persistence stores + autosave (S5 Stage 2) ────────
// File-backed stores moved verbatim to ui/electron-main/: user settings +
// layout.json (settings.js), user themes (themes.js), stock plugin UI layouts
// (plugin-ui-layouts.js), knob appearance presets (knob-presets.js), decal
// assets (decals.js), the autosave timer (autosave.js) and the Grid Layout
// engine pass-throughs (grid-layout.js). Channel names, file paths and
// defaults are unchanged. Handlers register at require time, except
// grid-layout's, which are wrapped in safeHandler at registration and so
// register inside init.
const settingsStore = require('./electron-main/settings');
const autosave = require('./electron-main/autosave');
const themesStore = require('./electron-main/themes');
const pluginUiLayouts = require('./electron-main/plugin-ui-layouts');
const knobPresets = require('./electron-main/knob-presets');
const decals = require('./electron-main/decals');
const gridLayout = require('./electron-main/grid-layout');
settingsStore.init();
autosave.init({ log, isExportBusy: () => exportProgressInterval !== null || videoExportProgressInterval !== null });
themesStore.init();
pluginUiLayouts.init({ getWin: () => win });
knobPresets.init();
decals.init({ getWin: () => win });
gridLayout.init({ safeHandler });
const { loadSettings, saveSettings, getNewProjectGlobalStretchMethodDefault } = settingsStore;
const { restartAutosaveTimer } = autosave;

// ── Extracted Phase 1 handler domains (S5 Stage 3) ─────────────────────────────
// Project, Timeline (queries + mutations), Undo/Redo, Transport handlers and
// the engine-level global clip-processing defaults moved verbatim to
// ui/electron-main/. Channel names and behavior unchanged. All of them wrap
// main.js's safeHandler at registration time, so — like grid-layout.js — they
// register inside init({ safeHandler }).
const projectHandlers = require('./electron-main/project');
const timelineHandlers = require('./electron-main/timeline');
const clipProcessingDefaults = require('./electron-main/clip-processing-defaults');
const undoRedoHandlers = require('./electron-main/undo-redo');
const transportHandlers = require('./electron-main/transport');
projectHandlers.init({ safeHandler });
timelineHandlers.init({ safeHandler });
clipProcessingDefaults.init({ safeHandler });
undoRedoHandlers.init({ safeHandler });
transportHandlers.init({ safeHandler });

// ── Extracted Phase 1 Audio + Effects/Graph handler domains (S5 Stage 4) ──────
// Audio (samples/mixer/peaks/diagnostics/output devices), the effect chain +
// per-family parameter access (generic, EQ, SmartBalance, Waveshaper, dynamics
// visualization) and graph-mode routing incl. graph-owned effect instances
// (FXG.3-b) moved verbatim to ui/electron-main/. Channel names and behavior
// unchanged. Chain/wire mutations broadcast xleth:graph:changed, so effects.js
// and effects-graph.js take graphHandler alongside safeHandler.
const audioHandlers = require('./electron-main/audio');
const effectsHandlers = require('./electron-main/effects');
const effectsGraphHandlers = require('./electron-main/effects-graph');
audioHandlers.init({ safeHandler });
effectsHandlers.init({ safeHandler, graphHandler });
effectsGraphHandlers.init({ safeHandler, graphHandler });

let workspaceBackdropCapability = null;
let workspaceBackdropState = {
  capability: null,
  preference: 'none',
  mode: 'off',
  imagePath: null,
  imageUrl: null,
  videoPath: null,
  videoUrl: null,
  lastError: null,
};

function getWorkspaceBackdropPreference(settings = loadSettings()) {
  return sanitizeWorkspaceBackdropPreference(settings.workspaceBackdrop);
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

function sanitizeBackdropMediaSettings(value, settings = loadSettings()) {
  const source = typeof value === 'string'
    ? { sourceType: value }
    : value && typeof value === 'object'
      ? value
      : {};
  const legacyPreference = getWorkspaceBackdropPreference(settings);
  let sourceType = BACKDROP_MEDIA_SOURCE_TYPES.has(source.sourceType)
    ? source.sourceType
    : null;
  if (!sourceType) {
    sourceType = ['acrylic', 'image', 'video'].includes(legacyPreference)
      ? legacyPreference
      : 'none';
  }
  return {
    sourceType,
    imagePath: stringOrEmpty(source.imagePath),
    videoPath: stringOrEmpty(source.videoPath),
    lastError: stringOrEmpty(source.lastError),
  };
}

function getWorkspaceBackdropArtDir() {
  return runtimeResource('art');
}

function isWorkspaceBackdropImageName(name) {
  return typeof name === 'string'
    && path.basename(name) === name
    && WORKSPACE_BACKDROP_IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function isWorkspaceBackdropImagePath(filePath) {
  return typeof filePath === 'string'
    && WORKSPACE_BACKDROP_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isWorkspaceBackdropVideoPath(filePath) {
  return typeof filePath === 'string' && path.extname(filePath).toLowerCase() === '.mp4';
}

function buildXlethMediaUrl(filePath) {
  const normalised = filePath.replace(/\\/g, '/');
  const driveMatch = normalised.match(/^([a-zA-Z]):\/(.*)$/);
  if (driveMatch) {
    const [, drive, rest] = driveMatch;
    return 'xleth-media://' + drive.toLowerCase() + '/' +
      rest.split('/').map(encodeURIComponent).join('/');
  }
  return 'xleth-media:///' + normalised.split('/').map(encodeURIComponent).join('/');
}

function resolveWorkspaceBackdropImage(settings = loadSettings(), mediaSettings = null) {
  if (isWorkspaceBackdropImagePath(mediaSettings?.imagePath)) {
    try {
      if (fs.existsSync(mediaSettings.imagePath)) {
        return {
          name: path.basename(mediaSettings.imagePath),
          path: mediaSettings.imagePath,
          url: buildXlethMediaUrl(mediaSettings.imagePath),
        };
      }
    } catch {}
  }

  const artDir = getWorkspaceBackdropArtDir();
  const configuredName = isWorkspaceBackdropImageName(settings.workspaceBackdropImage)
    ? settings.workspaceBackdropImage
    : null;
  const candidates = [
    configuredName,
    WORKSPACE_BACKDROP_DEFAULT_IMAGE,
  ].filter(Boolean);

  try {
    const discovered = fs.readdirSync(artDir)
      .filter(isWorkspaceBackdropImageName)
      .sort((a, b) => a.localeCompare(b));
    candidates.push(...discovered);
  } catch {}

  for (const name of candidates) {
    const candidatePath = path.join(artDir, name);
    try {
      if (fs.existsSync(candidatePath)) {
        return {
          name,
          path: candidatePath,
          url: buildXlethMediaUrl(candidatePath),
        };
      }
    } catch {}
  }
  return { name: null, path: null, url: null };
}

function resolveWorkspaceBackdropVideo(mediaSettings) {
  const videoPath = isWorkspaceBackdropVideoPath(mediaSettings?.videoPath)
    ? mediaSettings.videoPath
    : null;
  if (!videoPath) return { path: null, url: null, lastError: null };
  try {
    if (fs.existsSync(videoPath)) {
      return { path: videoPath, url: buildXlethMediaUrl(videoPath), lastError: null };
    }
  } catch {}
  return {
    path: videoPath,
    url: null,
    lastError: 'Video backdrop could not be played. The file may be missing or unsupported.',
  };
}

function ensureWorkspaceBackdropCapability() {
  if (workspaceBackdropCapability) return workspaceBackdropCapability;
  try {
    workspaceBackdropCapability = loadWorkspaceBackdropCapability({
      cachePath: getWorkspaceBackdropCachePath(app),
    });
  } catch (e) {
    log(`[Backdrop] capability cache unavailable: ${e.message}`);
    workspaceBackdropCapability = loadWorkspaceBackdropCapability();
  }
  return workspaceBackdropCapability;
}

function getWorkspaceBackdropStateSnapshot() {
  return {
    capability: workspaceBackdropState.capability || ensureWorkspaceBackdropCapability(),
    preference: workspaceBackdropState.preference,
    mode: ['native-acrylic', 'image', 'video'].includes(workspaceBackdropState.mode)
      ? workspaceBackdropState.mode
      : 'off',
    imagePath: workspaceBackdropState.imagePath,
    imageUrl: workspaceBackdropState.imageUrl,
    videoPath: workspaceBackdropState.videoPath,
    videoUrl: workspaceBackdropState.videoUrl,
    lastError: workspaceBackdropState.lastError,
  };
}

function logWorkspaceBackdropApply(reason, applyResult) {
  const state = getWorkspaceBackdropStateSnapshot();
  const c = state.capability || {};
  const nativeApply = applyResult.requestedMaterial === 'acrylic'
    ? (applyResult.applySucceeded ? 'success' : 'failure')
    : 'not-requested';
  const error = applyResult.error
    ? ` error=${String(applyResult.error.message || applyResult.error)}`
    : '';
  log(
    `[Backdrop] ${reason} platform=${c.platform || 'unknown'} osVersion=${c.osVersion || 'unknown'} ` +
    `windowsBuild=${c.windowsBuild ?? 'unknown'} supportsNativeSystemBackdrop=${!!c.supportsNativeSystemBackdrop} ` +
    `preference=${state.preference} setBackgroundMaterial=${!!applyResult.materialMethodExists} ` +
    `nativeAcrylicApply=${nativeApply} finalMode=${state.mode}${error}`
  );
}

function notifyWorkspaceBackdropChanged() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('xleth:backdrop:modeChanged', getWorkspaceBackdropStateSnapshot());
}

function applyMainWorkspaceBackdrop(reason = 'startup', { notify = false } = {}) {
  const capability = ensureWorkspaceBackdropCapability();
  const settings = loadSettings();
  const mediaSettings = sanitizeBackdropMediaSettings(settings[BACKDROP_MEDIA_SETTINGS_KEY], settings);
  const sourceType = mediaSettings.sourceType;
  const materialPreference = sourceType === 'acrylic'
    ? 'acrylic'
    : sourceType === 'image'
      ? 'image'
      : 'off';
  const applyResult = applyWorkspaceBackdropMaterial(win, { capability, preference: materialPreference });
  const image = sourceType === 'image'
    ? resolveWorkspaceBackdropImage(settings, mediaSettings)
    : { path: null, url: null };
  const video = sourceType === 'video'
    ? resolveWorkspaceBackdropVideo(mediaSettings)
    : { path: null, url: null, lastError: null };
  workspaceBackdropState = {
    capability,
    preference: sourceType,
    mode: sourceType === 'video'
      ? 'video'
      : sourceType === 'acrylic'
        ? (applyResult.mode === 'native-acrylic' ? 'native-acrylic' : 'off')
        : (sourceType === 'image' && applyResult.mode === 'image' ? 'image' : 'off'),
    imagePath: image.path,
    imageUrl: image.url,
    videoPath: video.path,
    videoUrl: video.url,
    lastError: mediaSettings.lastError || video.lastError,
  };
  logWorkspaceBackdropApply(reason, applyResult);
  if (notify) notifyWorkspaceBackdropChanged();
  return getWorkspaceBackdropStateSnapshot();
}

function backdropImportNameForSource(srcPath) {
  const ext = path.extname(srcPath).toLowerCase();
  if (!WORKSPACE_BACKDROP_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error('Workspace backdrops must be PNG, JPEG, or WebP images.');
  }
  const stem = path.basename(srcPath, ext)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace-backdrop';
  return `${stem}-${Date.now()}${ext}`;
}

async function chooseWorkspaceBackdropImage() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose Workspace Backdrop',
    filters: [{ name: 'Images (PNG, JPEG, WebP)', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return getWorkspaceBackdropStateSnapshot();

  const srcPath = filePaths[0];
  const destName = backdropImportNameForSource(srcPath);
  const artDir = getWorkspaceBackdropArtDir();
  fs.mkdirSync(artDir, { recursive: true });
  const destPath = path.join(artDir, destName);
  fs.copyFileSync(srcPath, destPath);

  const settings = loadSettings();
  settings.workspaceBackdrop = 'image';
  settings.workspaceBackdropImage = destName;
  settings[BACKDROP_MEDIA_SETTINGS_KEY] = sanitizeBackdropMediaSettings({
    ...(settings[BACKDROP_MEDIA_SETTINGS_KEY] || {}),
    sourceType: 'image',
    imagePath: destPath,
    lastError: '',
  }, settings);
  saveSettings(settings);
  return applyMainWorkspaceBackdrop('image-chosen', { notify: true });
}

async function chooseWorkspaceBackdropVideo() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose Workspace Background Video',
    filters: [{ name: 'Background Video (MP4)', extensions: ['mp4'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return getWorkspaceBackdropStateSnapshot();

  const srcPath = filePaths[0];
  if (!isWorkspaceBackdropVideoPath(srcPath)) {
    throw new Error('Workspace background videos must be MP4 files.');
  }

  const settings = loadSettings();
  settings.workspaceBackdrop = 'video';
  settings[BACKDROP_MEDIA_SETTINGS_KEY] = sanitizeBackdropMediaSettings({
    ...(settings[BACKDROP_MEDIA_SETTINGS_KEY] || {}),
    sourceType: 'video',
    videoPath: srcPath,
    lastError: '',
  }, settings);
  saveSettings(settings);
  return applyMainWorkspaceBackdrop('video-chosen', { notify: true });
}

function setWorkspaceBackdropMedia(value) {
  const settings = loadSettings();
  const next = sanitizeBackdropMediaSettings(value, settings);
  settings[BACKDROP_MEDIA_SETTINGS_KEY] = next;
  settings.workspaceBackdrop = next.sourceType === 'none' ? 'off' : next.sourceType;
  saveSettings(settings);
  return applyMainWorkspaceBackdrop('media-settings-changed', { notify: true });
}

function ffmpegExecutable() {
  const exe = runtimeResource('ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (app.isPackaged || fs.existsSync(exe)) return exe;
  return 'ffmpeg';
}

// Cap V8 old-space so the renderer/main heaps don't balloon on long sessions.
// Caps Electron's V8 heaps only; the forked engine worker runs under system Node
// and is unaffected (intended — this targets UI-side memory growth).
// Must be appended before the app 'ready' event fires.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');

// Register custom media protocol so renderer can play local files without CORS/CSP issues
// Must be called before app.whenReady()
protocol.registerSchemesAsPrivileged([
  { scheme: 'xleth-media', privileges: { secure: true, standard: true, stream: true } },
]);

// ── Local HTTP media server ──────────────────────────────────────────────────
// Extracted to electron-main/media-server.js (S5 Stage 1).

// ── Engine backend ────────────────────────────────────────────────────────────
// Worker lifecycle (fork of addon-worker.js, workerReady/addonError state,
// resolveSystemNodeExe, callWorker + SILENT_METHODS) extracted to
// electron-main/worker.js (S5 Stage 1). The engine background tasks and
// autosave timer below remain here — they belong to later stages.

let engineBackgroundTasksStarted = false;

async function applyEngineDefaults() {
  const saved = loadSettings();
  await callWorker('timeline_setGlobalStretchMethod',
    [getNewProjectGlobalStretchMethodDefault()]).catch(() => {});
  if (saved.globalFormantPreserve != null) {
    await callWorker('engine_setGlobalFormantPreserve',
      [saved.globalFormantPreserve]).catch(() => {});
  }
}

function startEngineBackgroundTasks() {
  if (engineBackgroundTasksStarted) return;
  engineBackgroundTasksStarted = true;
  scheduleWorldPoll(WORLD_POLL_ACTIVE_MS);
  restartAutosaveTimer();
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
  applyMainWorkspaceBackdrop('startup');

  const addonError = getAddonError();
  if (addonError) {
    const msg = encodeURIComponent(addonError);
    win.loadURL(`data:text/html,<pre style="color:red;background:%230A0A0F;padding:20px">Addon error:\n${msg}</pre>`);
  } else if (process.env.XLETH_PLAYWRIGHT === '1'
             || process.argv.includes('--xleth-use-dist')
             || app.isPackaged) {
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
    if (!isWorkerReady()) throw new Error('Engine not ready: ' + (getAddonError() || 'starting'));
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
ipcMain.handle('xleth:proxy:getStatus', safeHandler(() => callWorker('proxy_getStatus')));
ipcMain.handle('xleth:currentFrame',   safeHandler(() => callWorker('getFrameRGBA')));
ipcMain.handle('xleth:frameRGBA',      safeHandler(() => callWorker('getFrameRGBA')));
ipcMain.handle('xleth:syncStats',      safeHandler(() => callWorker('getSyncStats')));
ipcMain.handle('xleth:setVideoResolution', safeHandler((_, w, h) => callWorker('setVideoResolution', [w, h])));

// ── Video frame output: Windows named shared memory ─────────────────────────
// The engine worker creates a named file mapping and writes the double-buffer
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
// Extracted to electron-main/project.js (S5 Stage 3) — registers inside
// init({ safeHandler }); pulls restartAutosaveTimer / the new-project
// stretch-method default from the Stage 2 autosave.js / settings.js modules.

// ── Phase 1 handlers — Timeline queries ──────────────────────────────────────
// Extracted to electron-main/timeline.js (S5 Stage 3).

// ── Phase 1 handlers — Timeline mutations ────────────────────────────────────
// Extracted to electron-main/timeline.js (S5 Stage 3).

// ── Global clip-processing defaults ─────────────────────────────────────────
ipcMain.handle('xleth:settings:get',    (_, key) => {
  const settings = loadSettings()
  if (key === 'workspaceBackdrop') return getWorkspaceBackdropPreference(settings)
  if (key === BACKDROP_MEDIA_SETTINGS_KEY) return sanitizeBackdropMediaSettings(settings[BACKDROP_MEDIA_SETTINGS_KEY], settings)
  return settings[key]
})
ipcMain.handle('xleth:settings:set',    (_, key, value) => {
  const s = loadSettings()
  if (key === BACKDROP_MEDIA_SETTINGS_KEY) {
    return setWorkspaceBackdropMedia(value)
  }
  if (key === 'workspaceBackdrop') {
    const previous = getWorkspaceBackdropPreference(s)
    const next = sanitizeWorkspaceBackdropPreference(value)
    s[key] = next
    saveSettings(s)
    if (next !== previous) {
      return applyMainWorkspaceBackdrop('preference-changed', { notify: true })
    }
    return getWorkspaceBackdropStateSnapshot()
  }
  s[key] = value; saveSettings(s)
})
ipcMain.handle('xleth:backdrop:getState', () => getWorkspaceBackdropStateSnapshot())
ipcMain.handle('xleth:backdrop:chooseImage', () => chooseWorkspaceBackdropImage())
ipcMain.handle('xleth:backdrop:chooseVideo', () => chooseWorkspaceBackdropVideo())
ipcMain.handle('xleth:backdrop:setMedia', (_, value) => setWorkspaceBackdropMedia(value))

// ── Quick Launchers ───────────────────────────────────────────────────────────
ipcMain.handle('xleth:launcher:chooseExe', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose Executable',
    filters: [{ name: 'Executables', extensions: ['exe'] }],
    properties: ['openFile'],
  })
  return canceled || !filePaths.length ? null : filePaths[0]
})

ipcMain.handle('xleth:launcher:choosePng', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose Icon (PNG)',
    filters: [{ name: 'PNG Images', extensions: ['png'] }],
    properties: ['openFile'],
  })
  return canceled || !filePaths.length ? null : filePaths[0]
})

ipcMain.handle('xleth:launcher:spawn', (_, exePath) => {
  try {
    spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ── Autosave timer ────────────────────────────────────────────────────────────
// Extracted to electron-main/autosave.js (S5 Stage 2), including the
// xleth:autosave:restart handler. Export-progress state stays here and is
// probed via the injected isExportBusy.

// ── Phase 7 — Preview visibility (panel show/hide) ─────────────────────────
ipcMain.handle('xleth:preview:setEnabled',
  safeHandler((_, enabled) => callWorker('preview_setEnabled', [Boolean(enabled)])));

// ── Themes (persisted to userData/themes/<slug>.json) ─────────────────────────
// Extracted to electron-main/themes.js (S5 Stage 2); the xleth:layout:read/
// write handlers that lived here moved into electron-main/settings.js.
// ── Stock plugin UI layouts (userData/plugin-ui/<pluginId>.json) ──────────────
// Extracted to electron-main/plugin-ui-layouts.js (S5 Stage 2), including the
// xleth:dialog:importPluginUi / xleth:dialog:exportPluginUi handlers.

// ── User-saved knob appearance presets ────────────────────────────────────────
// Extracted to electron-main/knob-presets.js (S5 Stage 2).

// ── User-imported decal assets ─────────────────────────────────────────────────
// Extracted to electron-main/decals.js (S5 Stage 2).

// Engine-level global clip-processing defaults (stretch method / formant
// preserve) extracted to electron-main/clip-processing-defaults.js (S5 Stage 3).

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
// Extracted to electron-main/grid-layout.js (S5 Stage 2) — engine pass-through
// handlers, wired via gridLayout.init({ safeHandler }).

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

ipcMain.handle('xleth:timeline:addNotesBatch',
  safeHandler((_, patternId, notes) => callWorker('timeline_addNotesBatch', [patternId, notes])));

ipcMain.handle('xleth:fsc:parse',
  safeHandler((_, filePath) => callWorker('fsc_parse', [filePath])));

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
// Extracted to electron-main/undo-redo.js (S5 Stage 3).

// ── Phase 1 handlers — Transport extensions ──────────────────────────────────
// Extracted to electron-main/transport.js (S5 Stage 3).

// ── Phase 1 handlers — Audio ─────────────────────────────────────────────────
// Extracted to electron-main/audio.js (S5 Stage 4).

// ── P3 — Effect Chain / effect parameter + meter access / EQ / SmartBalance /
// Waveshaper / dynamics visualization ─────────────────────────────────────────
// Extracted to electron-main/effects.js (S5 Stage 4).

// ── Graph-mode routing + graph-owned effect instances (FXG.3-b) ──────────────
// Extracted to electron-main/effects-graph.js (S5 Stage 4).

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

// ── WORLD processing indicator poll (adaptive) ───────────────────────────────
// Drives per-clip caching spinners. Time-stretch caching is a load-time burst;
// during steady playback no WORLD jobs are active, so the previous fixed 100ms
// (10 Hz) cache_getWorldActiveJobs round-trip was pure contention against the
// engine's audio thread over the synchronous named pipe — a measured
// contributor to audio underruns on complex projects (on a Ryzen 5 7520U the
// engine already sits at ~150% of one core for DSP+video while playing BFDIA 7,
// vs ~66% for a 1-track project). We poll fast (150ms) only while jobs are
// active or just finished, and idle at 1000ms otherwise. Measured on BFDIA 7
// (10 tracks / 220 clips) during playback this drops total UI poll traffic from
// 21.5 to 12.7 pipe calls/sec (and from 58.2/sec before the transport+peak
// throttles), giving the audio callback materially more uncontended CPU.
const WORLD_POLL_ACTIVE_MS = 150
const WORLD_POLL_IDLE_MS = 1000
const WORLD_POLL_COOLDOWN_MS = 1500  // stay fast briefly after the last job ends
let prevWorldClips = new Set()
let worldPollTimer = null
let lastWorldActiveAt = 0

// Returns true when WORLD jobs are active or a start/complete transition fired
// this tick — the signal the adaptive scheduler uses to stay in fast mode.
async function pollWorldProcessing() {
  if (!isWorkerReady() || !win || win.isDestroyed()) return false
  try {
    const active = await callWorker('cache_getWorldActiveJobs', [])
    const activeSet = new Set(active)
    let changed = false
    for (const id of activeSet) {
      if (!prevWorldClips.has(id)) {
        win.webContents.send('stretch:worldProcessingStart', { clipId: id })
        changed = true
      }
    }
    for (const id of prevWorldClips) {
      if (!activeSet.has(id)) {
        win.webContents.send('stretch:worldProcessingComplete', { clipId: id })
        changed = true
      }
    }
    prevWorldClips = activeSet
    return activeSet.size > 0 || changed
  } catch { return false }
}

function scheduleWorldPoll(delayMs) {
  clearTimeout(worldPollTimer)
  worldPollTimer = setTimeout(async () => {
    const busy = await pollWorldProcessing()
    const now = Date.now()
    if (busy) lastWorldActiveAt = now
    const fast = busy || (now - lastWorldActiveAt) < WORLD_POLL_COOLDOWN_MS
    scheduleWorldPoll(fast ? WORLD_POLL_ACTIVE_MS : WORLD_POLL_IDLE_MS)
  }, delayMs)
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
function fmtHex(n) {
  if (!Number.isFinite(n)) return 'n/a';
  return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
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

// ── Pixel-content verification helpers ───────────────────────────────────────
// The six stages are sourced from two places: native stages come from the
// engine N-API snapshot (engine.pixelStats array); renderer stages come from
// the live preview canvas (extras.preview.pixelStats object). This merges both
// into one stage→{observed, sampleCount, latest} lookup the section can render.
const PIXEL_STAGE_ORDER = [
  'post-d3d11-readback',
  'pre-frameoutput-write',
  'post-frameoutput-write',
  'renderer-pre-webgl-upload',
  'renderer-post-webgl-readpixels',
  'export-pre-encode',
];

function buildPixelStageLookup(engine, preview) {
  const lookup = {};
  // Native (array of rows)
  if (engine && Array.isArray(engine.pixelStats)) {
    for (const row of engine.pixelStats) {
      if (row && row.stage) {
        lookup[row.stage] = {
          observed: !!row.observed,
          sampleCount: row.sampleCount || 0,
          dumpCount: row.dumpCount || 0,
          latest: row.latest || null,
          source: 'native',
        };
      }
    }
  }
  // Renderer (object keyed by stage)
  if (preview && preview.pixelStats && typeof preview.pixelStats === 'object') {
    for (const [stage, v] of Object.entries(preview.pixelStats)) {
      if (!v) continue;
      lookup[stage] = {
        observed: !!v.observed,
        sampleCount: v.sampleCount || 0,
        dumpCount: 0,
        latest: v.latest || null,
        source: 'renderer',
      };
    }
  }
  return lookup;
}

// Classify a stage row: 'non-zero' | 'all-zero' | 'not-sampled' | 'failed'.
function interpretPixelStage(entry) {
  if (!entry || !entry.observed) return 'not-sampled';
  const s = entry.latest;
  if (!s || !s.observed || !s.width || !s.height) return 'failed';
  return (s.nonZeroPixels > 0) ? 'non-zero' : 'all-zero';
}

function fmtPixelArr(a) {
  return Array.isArray(a) ? `[${a.join(', ')}]` : 'n/a';
}

function buildVisualPreviewDiagnosticText({ engine, extras, settings, gpuInfo }) {
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
  if (engine) {
    out.push(`  D3D feature level:    ${engine.activeFeatureLevel || 'n/a'}`);
    out.push(`  Device type:          ${engine.deviceIsWarp ? 'WARP (software rasterizer — XLETH_D3D11_WARP)' : 'hardware'}`);
    out.push(`  D3D11 debug layer:    ${fmtBool(engine.debugLayerActive)}`);
  }
  out.push(`  Engine compositor backend: D3D11 (GridCompositor) — NOT OpenGL`);
  out.push(`  Renderer (Electron preview canvas) backend: WebGL / Canvas2D`);
  out.push(`  Video encode/decode mode (requested): ${(settings && settings.videoMode) || 'auto'}`);
  // Electron's own GPU view — a third independent signal (engine DXGI list and
  // renderer WebGL unmasked-renderer are the other two). Useful when Chromium
  // falls back to a different adapter than the engine's D3D11 device.
  out.push('');
  out.push('  Electron app.getGPUInfo(\'basic\'):');
  if (!gpuInfo) {
    out.push('    (unavailable)');
  } else if (gpuInfo.error) {
    out.push(`    ✗ getGPUInfo failed: ${gpuInfo.error}`);
  } else {
    const gpus = (gpuInfo.gpuDevice && Array.isArray(gpuInfo.gpuDevice)) ? gpuInfo.gpuDevice : [];
    if (!gpus.length) {
      out.push('    (no gpuDevice entries reported)');
    } else {
      gpus.forEach((g, i) => {
        out.push(`    [${i}] vendorId=${fmtVendorHex(g.vendorId)} deviceId=${fmtVendorHex(g.deviceId)}` +
          `${g.active ? ' ACTIVE' : ''}${g.driverVendor ? ` driverVendor=${g.driverVendor}` : ''}` +
          `${g.driverVersion ? ` driverVersion=${g.driverVersion}` : ''}`);
      });
    }
    if (gpuInfo.auxAttributes && gpuInfo.auxAttributes.glRenderer) {
      out.push(`    glRenderer: ${gpuInfo.auxAttributes.glRenderer}`);
    }
  }
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
      const lt = engine.lastTick;
      out.push(`  Last tick:              ${lt.requestCount} cell requests, ${lt.decodeMissCount} decode misses`);
      out.push('');
      out.push('  TIMELINE / COLLECTOR CONTENT (latest preview tick):');
      out.push(`    Preview time used:        ${lt.previewTimeMs != null ? (lt.previewTimeMs / 1000).toFixed(3) + ' s' : 'unavailable'}`);
      out.push(`    Active visual events:     ${lt.activeVisualEvents != null ? lt.activeVisualEvents : 'unavailable'}  (events fed to the collector)`);
      out.push(`    Project has visual events:${lt.activeVisualEvents != null ? (lt.activeVisualEvents > 0 ? ' yes' : ' NO — nothing to render') : ' unavailable'}`);
      out.push(`    Cells requested:          ${lt.requestCount}  (final compositor input count)`);
      out.push(`    Unique decode keys:       ${lt.dedupKeyCount != null ? lt.dedupKeyCount : 'unavailable'}  (after dedup)`);
      out.push(`    Cache hits:               ${lt.cacheHitCount != null ? lt.cacheHitCount : 'unavailable'}`);
      out.push(`    Decode requests (misses): ${lt.decodeMissCount}`);
      out.push(`    Decode successes:         ${lt.decodeSuccessCount != null ? lt.decodeSuccessCount : 'unavailable'}`);
      out.push(`    Decode failures:          ${lt.decodeFailCount != null ? lt.decodeFailCount : 'unavailable'}`);
      out.push(`    Cells skipped (+reason):  unavailable — collectRequests does not currently`);
      out.push(`                              expose a per-cell skip/reject reason list`);
      out.push(`    Paused for export:        ${fmtBool(engine.pauseForExport)}`);
      out.push(`    Paused for visibility:    ${fmtBool(engine.pauseForVisibility)}`);
      if (lt.requestCount === 0) {
        out.push('    ⚠ 0 cells requested → the collector found NO visual content at this');
        out.push('      timeline position. If the project DOES have video on the grid, the');
        out.push('      compositor is rendering an empty (black) scene — the pixels are');
        out.push('      genuinely zero at the source, not lost in transport. This matches a');
        out.push('      PIXEL CONTENT VERIFICATION reading of all-zero at post-d3d11-readback.');
      }
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
    out.push(`  lastReadbackHRESULT:    ${fmtHex(engine.lastTick.lastReadbackHRESULT)} (${engine.lastTick.lastReadbackHRESULTText})`);
    out.push(`  lastReadbackFailureStage: ${engine.lastTick.lastReadbackFailureStage || 'n/a'}`);
    out.push(`  deviceRemovedReason:    ${fmtHex(engine.lastTick.deviceRemovedReason)} (${engine.lastTick.deviceRemovedReasonText})`);
    out.push(`  Map type / flags:       ${engine.lastTick.readbackMapType} / ${fmtHex(engine.lastTick.readbackMapFlags)}`);
    out.push(`  Map RowPitch:           ${engine.lastTick.mappedRowPitch}`);
    out.push(`  expected bytes:         ${engine.lastTick.expectedBytes}`);
    out.push(`  actual copy bytes:      ${engine.lastTick.actualCopyBytes}`);
    out.push(`  source/staging dimensions match: ${fmtBool(engine.lastTick.sourceStagingDimensionsMatch)}`);
    if (engine.lastTick.sourceTexture) {
      const s = engine.lastTick.sourceTexture;
      out.push(`  Source texture:         ${s.width} × ${s.height} fmt=${s.format} samples=${s.sampleCount}`);
    }
    if (engine.lastTick.stagingTexture) {
      const s = engine.lastTick.stagingTexture;
      out.push(`  Staging texture:        ${s.width} × ${s.height} fmt=${s.format} usage=${s.usage} cpu=${fmtHex(s.cpuAccessFlags)} bind=${fmtHex(s.bindFlags)} misc=${fmtHex(s.miscFlags)} samples=${s.sampleCount}`);
    }
  }
  if (engine && engine.counters) {
    const c = engine.counters;
    out.push(`  Video tick count:           ${c.videoTickCount}`);
    out.push(`  Compositor path entered:    ${c.compositorPathEntered}`);
    // ── Render-gate per-term truth counts ────────────────────────────────────
    // Each counter increments once per tick when that gate sub-condition is true,
    // evaluated independently so short-circuit doesn't hide the false term.
    // Whichever counter is ~0 (vs videoTickCount) is the term shutting the gate.
    const vtc = c.videoTickCount || 1; // avoid divide-by-zero
    const pct = (n) => `${(((n || 0) / vtc) * 100).toFixed(1)}%`;
    out.push(`  gateIsPlayingTrueTicks:     ${c.gateIsPlayingTrueTicks || 0}  (${pct(c.gateIsPlayingTrueTicks)} of video ticks)`);
    out.push(`  gateEventsNonEmptyTicks:    ${c.gateEventsNonEmptyTicks || 0}  (${pct(c.gateEventsNonEmptyTicks)} of video ticks)`);
    out.push(`  gateForceRenderTicks:       ${c.gateForceRenderTicks || 0}  (${pct(c.gateForceRenderTicks)} of video ticks)`);
    out.push(`  gatePreviewPausedTicks:     ${c.gatePreviewPausedTicks || 0}  (${pct(c.gatePreviewPausedTicks)} of video ticks)`);
    out.push(`  gateBlockReachedTicks:      ${c.gateBlockReachedTicks || 0}  (${pct(c.gateBlockReachedTicks)} of video ticks)`);
    out.push(`  gateBlockSkippedNoInit:     ${c.gateBlockSkippedNoInit || 0}  (${pct(c.gateBlockSkippedNoInit)} of video ticks)`);
    out.push(`  compositeFrame() calls:     ${c.compositeFrameCount}`);
    out.push(`  readback() valid:           ${c.readbackValidCount}`);
    out.push(`  readback() not-ready:       ${c.readbackNotReadyCount || 0}`);
    out.push(`  readback() invalid (fatal): ${c.readbackInvalidCount}`);
    out.push(`  Canvas copy count:          ${c.canvasCopyCount}`);
    out.push(`  Black frames written:       ${c.blackFrameCount}`);
    out.push(`  Compositor init failures:   ${c.compositorInitFailures}`);
    const policyStr = c.readbackPolicyActive === 1 ? 'AsyncQueued' : 'FastImmediate';
    const switchReasonMap = {0:'none', 1:'fatal-invalids', 2:'map-stall-too-slow', 3:'poor-yield'};
    out.push(`  Readback policy:            ${policyStr}`);
    out.push(`  Policy switch reason:       ${switchReasonMap[c.readbackPolicySwitchReason || 0] || 'unknown'}`);
    out.push(`  Dropped pending frames:     ${c.droppedPendingFrames || 0}`);
    out.push(`  Pending slots (ring):       ${c.pendingSlotsCount || 0}`);
    out.push(`  Last readback:              ${((c.lastReadbackUs||0)/1000).toFixed(2)} ms`);
    out.push(`  Avg readback (60-frame):    ${((c.avgReadbackUs||0)/1000).toFixed(2)} ms`);
    out.push(`  Max readback:               ${((c.maxReadbackUs||0)/1000).toFixed(2)} ms`);
    out.push('');
    out.push('  Interpretation:');
    const notReady = c.readbackNotReadyCount || 0;
    const policy    = c.readbackPolicyActive === 1 ? 'AsyncQueued' : 'FastImmediate';
    const dropped   = c.droppedPendingFrames || 0;
    const avgMs     = (c.avgReadbackUs || 0) / 1000;
    if (c.compositeFrameCount === 0 && c.compositorPathEntered === 0) {
      out.push('    ✗ Compositor path never entered — engine in CPU fallback or paused.');
    } else if (c.compositeFrameCount === 0) {
      out.push('    ✗ Path entered but compositeFrame() never called — compositor not initialized.');
    } else if (c.readbackInvalidCount > 0) {
      out.push(`    ✗ FATAL readback failures (${c.readbackInvalidCount}). Check HRESULT/stage/deviceRemovedReason.`);
    } else if (policy === 'FastImmediate' && c.canvasCopyCount > 0) {
      const msNote = avgMs > 0 ? ` (avg ${avgMs.toFixed(2)} ms/frame)` : '';
      out.push(`    ✓ FastImmediate healthy — blocking Map, no DO_NOT_WAIT.${msNote}`);
      out.push(`      canvasCopyCount=${c.canvasCopyCount} confirms frames reach the canvas.`);
    } else if (policy === 'AsyncQueued' && c.readbackValidCount > 0) {
      const dropNote = dropped > 0
        ? ` (${dropped} ring drops — GPU behind tick rate)`
        : ' (no ring drops)';
      out.push(`    ✓ AsyncQueued healthy — ring serving valid frames.${dropNote}`);
      out.push(`      FastImmediate switched away: reason=${switchReasonMap[c.readbackPolicySwitchReason||0]||'?'}`);
    } else if (policy === 'AsyncQueued' && notReady > 0 && c.readbackValidCount === 0) {
      out.push('    ⚠ AsyncQueued: ring still priming (notReady ticks, no valid yet).');
      out.push('      Normal for first few frames; if it persists, check GPU load.');
    } else if (c.canvasCopyCount === 0 && c.readbackValidCount > 0) {
      out.push('    ✗ Readback valid but no canvas copy — frameOutput.getBackBuffer() returning null.');
    } else {
      out.push(`    ✓ Engine readback healthy (policy=${policy}).`);
      out.push('      If preview is still blank, inspect section 5 delivery/WebGL counters.');
    }
  }
  out.push('');

  // ── 4b. Preview tick stage timing ──────────────────────────────────────
  // Per-stage wall-clock breakdown of the preview video-thread tick, measured
  // in the engine (instrumentation only). Locates the dominant cost when the
  // preview underperforms despite a fast readback / zero decode misses.
  out.push('4b. PREVIEW TICK STAGE TIMING (per-stage wall clock, video thread)');
  out.push(sep);
  if (engine && engine.counters) {
    const c = engine.counters;
    const ms = (us) => ((us || 0) / 1000).toFixed(3);
    const row = (label, last, avg, max) =>
      out.push(`  ${label.padEnd(22)} last ${ms(last).padStart(8)} ms   avg ${ms(avg).padStart(8)} ms   max ${ms(max).padStart(8)} ms`);
    row('1. collectRequests',   c.lastCollectUs,   c.avgCollectUs,   c.maxCollectUs);
    row('2. dedup + resolve',   c.lastResolveUs,   c.avgResolveUs,   c.maxResolveUs);
    row('3. decode-miss loop',  c.lastDecodeUs,    c.avgDecodeUs,    c.maxDecodeUs);
    row('4. compositeFrame',    c.lastCompositeUs, c.avgCompositeUs, c.maxCompositeUs);
    row('5. readback',          c.lastReadbackUs,  c.avgReadbackUs,  c.maxReadbackUs);
    row('6. swizzle+shm copy',  c.lastSwizzleUs,   c.avgSwizzleUs,   c.maxSwizzleUs);
    row('7. WHOLE TICK',        c.lastTickUs,      c.avgTickUs,      c.maxTickUs);
    out.push('');
    out.push(`  Delivered FPS (real 1s window): ${c.deliveredFps || 0}`);
    out.push(`  Active cells this tick:         ${c.lastCellCount || 0} (peak ${c.maxCellCount || 0})`);
    out.push('');
    out.push('  Note: avg = trailing 60-sample window per stage; the readback avg uses');
    out.push('        a ~1s wallclock window (shared with the readback-policy health gate).');
    out.push('        Stages 1–6 are exclusive slices of the tick; their sum ≈ stage 7.');
    out.push('        Delivered FPS counts frames actually written to the shm back buffer');
    out.push('        per real second — NOT playhead time — so stalls show as a low number.');
  } else {
    out.push('  (no engine counters — preview tick has not run)');
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

  // ── 7. Pixel content verification ──────────────────────────────────────
  out.push('7. PIXEL CONTENT VERIFICATION');
  out.push(sep);
  const diagFlags = engine && engine.visualDiagFlags;
  const pixelsOn = diagFlags && diagFlags.pixelsEnabled;
  const rendererPixelsOn = preview && preview.pixelDiagEnabled;
  out.push('  This section proves whether REAL non-zero pixels exist at each stage of');
  out.push('  the pipeline — not just that bytes moved. Native readback is BGRA; the');
  out.push('  shared-memory / WebGL stages are RGBA (channel order is labelled per row,');
  out.push('  so do NOT compare first-bytes across formats blindly).');
  out.push('');
  out.push(`  Native pixel diag (XLETH_VISUAL_DIAG_PIXELS):   ${pixelsOn ? 'ON' : 'OFF'}`);
  out.push(`  Renderer pixel diag (same flag, renderer):     ${rendererPixelsOn ? 'ON' : 'OFF'}`);
  if (diagFlags) {
    out.push(`  Raw frame dumps (XLETH_VISUAL_DIAG_DUMP_FRAMES): ${diagFlags.dumpFramesEnabled ? 'ON' : 'OFF'}` +
      ` (max ${diagFlags.maxDumpFramesPerStage}/stage)`);
    if (diagFlags.dumpFramesEnabled && diagFlags.dumpSessionDir) {
      out.push(`  Dump folder: ${diagFlags.dumpSessionDir}`);
    }
  }
  if (!pixelsOn && !rendererPixelsOn) {
    out.push('');
    out.push('  ⚠ Pixel verification was NOT enabled for this run. To capture it:');
    out.push('      1. Close Xleth.');
    out.push('      2. Relaunch with the environment variable XLETH_VISUAL_DIAG_PIXELS=1');
    out.push('         (PowerShell:  $env:XLETH_VISUAL_DIAG_PIXELS=1 ; .\\Xleth.exe )');
    out.push('      3. Open a project WITH visible video, let the preview run a moment,');
    out.push('         start a short export if render also fails, then export this log again.');
  }
  out.push('');

  const pix = buildPixelStageLookup(engine, preview);
  for (const stage of PIXEL_STAGE_ORDER) {
    const entry = pix[stage];
    const verdict = interpretPixelStage(entry);
    out.push(`  ── ${stage} ──`);
    if (!entry) {
      out.push(`     observed:        no`);
      out.push(`     interpretation:  not-sampled (stage never recorded this run)`);
      out.push('');
      continue;
    }
    const s = entry.latest;
    out.push(`     observed:        ${fmtBool(entry.observed)}   (source: ${entry.source})`);
    out.push(`     frames sampled:  ${entry.sampleCount}${entry.dumpCount ? `   raw dumps: ${entry.dumpCount}` : ''}`);
    if (s && s.observed) {
      out.push(`     format:          ${s.format}`);
      out.push(`     dimensions:      ${s.width} × ${s.height}   rowPitch=${s.rowPitch}   bytes=${s.byteCount}`);
      out.push(`     checksum64:      ${s.checksum64}`);
      out.push(`     nonZeroBytes:    ${s.nonZeroBytes}`);
      out.push(`     nonZeroPixels:   ${s.nonZeroPixels} / ${(s.width * s.height) || 0}`);
      out.push(`     averageLuma:     ${typeof s.averageLuma === 'number' ? s.averageLuma.toFixed(3) : s.averageLuma}  (0..255)`);
      out.push(`     first16Bytes:    ${s.first16Bytes}`);
      out.push(`     centerPixel:     ${fmtPixelArr(s.centerPixel)}  (${s.format})`);
      if (Array.isArray(s.corners)) {
        out.push(`     corners TL/TR/BL/BR: ${s.corners.map(fmtPixelArr).join(' ')}`);
      }
    }
    out.push(`     interpretation:  ${verdict}`);
    out.push('');
  }

  // Plain-English cross-stage diagnosis.
  out.push('  PLAIN-ENGLISH INTERPRETATION:');
  const v = (stage) => interpretPixelStage(pix[stage]);
  const readback   = v('post-d3d11-readback');
  const preFO      = v('pre-frameoutput-write');
  const postFO     = v('post-frameoutput-write');
  const preUpload  = v('renderer-pre-webgl-upload');
  const postDraw   = v('renderer-post-webgl-readpixels');
  const exportPre  = v('export-pre-encode');
  const isZero = (x) => x === 'all-zero';
  const isNon  = (x) => x === 'non-zero';

  const lines = [];
  if (isZero(readback) && (isZero(preFO) || preFO === 'not-sampled')) {
    lines.push('  • Native readback is ALL-ZERO → the engine / compositor / timeline is');
    lines.push('    producing EMPTY frames BEFORE shared memory. The transport and WebGL are');
    lines.push('    innocent — look upstream (cell requests / decode / compositor scene).');
  }
  if (isNon(readback) && (isZero(preUpload) || isZero(postFO))) {
    lines.push('  • Native readback is NON-ZERO but the renderer reads ZERO before upload →');
    lines.push('    FrameOutput / shared-memory transport or buffer-index swap mismatch.');
  }
  if (isNon(preUpload) && isZero(postDraw)) {
    lines.push('  • Renderer pre-upload is NON-ZERO but post-WebGL readPixels is ZERO →');
    lines.push('    WebGL upload / draw / presentation issue (texture, context, or driver).');
  }
  if ((isNon(preUpload) || isNon(postDraw)) && isZero(exportPre)) {
    lines.push('  • Preview pixels are NON-ZERO but export-pre-encode is ZERO →');
    lines.push('    the export path diverges from the preview path (black before encode).');
  }
  if (isZero(readback) && isZero(exportPre)) {
    lines.push('  • BOTH preview readback AND export are ALL-ZERO before encode/upload →');
    lines.push('    upstream timeline / collector / compositor content issue (empty scene).');
    lines.push('    Cross-check section 3 "Last tick: N cell requests" — 0 requests means');
    lines.push('    the collector requested no visual cells (see section 3 below/above).');
  }
  if (isNon(readback) && isNon(preUpload) && isNon(postDraw)) {
    lines.push('  • Every sampled stage has NON-ZERO pixels. If the canvas still looks blank,');
    lines.push('    the problem is presentation/compositing AFTER the WebGL draw (CSS, blend,');
    lines.push('    canvas size, or the window compositor) — not the pixel pipeline.');
  }
  if (!lines.length) {
    if (!pixelsOn && !rendererPixelsOn) {
      lines.push('  • No pixel data captured (diagnostic flag was off — see note above).');
    } else {
      lines.push('  • Not enough stages were sampled to draw a cross-stage conclusion.');
      lines.push('    Ensure the preview was visible (and export ran, if render also fails)');
      lines.push('    while XLETH_VISUAL_DIAG_PIXELS=1, then re-export this log.');
    }
  }
  lines.forEach((l) => out.push(l));
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
  out.push('  • All GPUs start on FastImmediate (blocking Map, no DO_NOT_WAIT, ~0-2ms on NVIDIA).');
  out.push('    If avgReadbackMs>8, fatalInvalids>3, or yield<25% in a 60-frame window,');
  out.push('    the engine auto-switches to AsyncQueued (DO_NOT_WAIT ring, 5 slots).');
  out.push('    D3D11_MAP_FLAG_DO_NOT_WAIT = 0x00100000 (confirmed in readbackMapFlags log).');
  out.push('  • readbackInvalid(fatal)>0 = descriptor/device issue, not GPU latency.');
  out.push('  • readbackNotReady in AsyncQueued = GPU behind tick rate; previous frame stays visible.');
  out.push('  • droppedPendingFrames in AsyncQueued is non-fatal: oldest frame dropped, preview continues.');
  out.push(sep);
  out.push('End of report.');

  return out.join('\n') + '\n';
}

ipcMain.handle('xleth:diag:exportVisualPreviewLog', safeHandler(async (event, extras) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender) || win;

  // Pull engine state. Tolerate the engine not being ready — we still
  // want to produce *some* report so the tester can send something.
  let engine = null;
  let engineError = null;
  try {
    engine = await callWorker('diag_getVisualPreviewDiagnostic', []);
  } catch (e) {
    engineError = e && e.message ? e.message : String(e);
    log(`[diag] engine call failed: ${engineError}`);
  }

  // Carry forward the persisted videoMode setting for context.
  let settings = {};
  try { settings = loadSettings() || {}; } catch {}

  // Electron's own view of the GPU (separate from the engine's DXGI list and
  // the renderer's WebGL context — a third independent signal). 'basic' is
  // cheap; tolerate failure so the report still generates.
  let gpuInfo = null;
  try {
    if (app.getGPUInfo) gpuInfo = await app.getGPUInfo('basic');
  } catch (e) {
    gpuInfo = { error: e && e.message ? e.message : String(e) };
  }

  let body = buildVisualPreviewDiagnosticText({ engine, extras, settings, gpuInfo });
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
    const VALID_NAMING_FORMATS = ['sampleNameOnly', 'categoryAndName', 'sourceAndName', 'fullLegacy'];
    const saved = loadSettings().sampleNamingFormat;
    const format = VALID_NAMING_FORMATS.includes(saved) ? saved : 'sampleNameOnly';
    const result = await callWorker('audio_exportRegion', [regionId, format]);
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

ipcMain.handle('xleth:audio:playRegionPreview',
  safeHandler((_, startTime, endTime) =>
    callWorker('source_playRegionPreview', [startTime ?? 0, endTime ?? 0])));

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
    // preload.js guarantees noteData is a Buffer; the pipe client base64-encodes it.
    callWorker('midi_executeImport', [noteData, optionsJson]));

// Replaced by WaveformMipmap N-API bindings — see WaveformMipmap.h
// Pipeline A (extractPCM, pcmCache, buildPeaks, getWaveformData/Region IPC) removed.

// ── Phase 1B — FrameServer (native frame extraction via C++ engine) ─────────

ipcMain.handle('xleth:video:openSource',
  safeHandler((_, sourceId) => callWorker('video_openSource', [sourceId])));

ipcMain.handle('xleth:video:closeSource',
  safeHandler((_, sourceId) => callWorker('video_closeSource', [sourceId])));

ipcMain.handle('xleth:video:requestPreviewFrameAtTimelinePosition',
  safeHandler((_, position) => callWorker('video_requestPreviewFrameAtTimelinePosition', [position])));

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

// Locate a single replacement file for a missing source/sample (relink flow).
ipcMain.handle('xleth:dialog:locateMedia', async (_, displayName) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: displayName ? `Locate "${displayName}"` : 'Locate Media File',
    filters: [
      { name: 'All Supported', extensions: ['mp4', 'avi', 'mov', 'mkv', 'wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a'] },
      { name: 'Video Files', extensions: ['mp4', 'avi', 'mov', 'mkv'] },
      { name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;
  log(`[Relink] Located replacement: ${filePaths[0]}`);
  return filePaths[0];
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

// ── Export Project as ZIP ─────────────────────────────────────────────────────
// Bundles the project into a portable .zip. In 'full' mode external source media
// is copied into media/ and every in-project path is rewritten to project-relative
// so the archive opens on any machine with no relinking. In 'projectOnly' mode the
// large sources are left out (recipient relinks them) but samples are still bundled.
// Proxies are never shipped — they regenerate on demand.

function sanitizeZipName(name) {
  return String(name).replace(/[<>:"/\\|?* -]/g, '_') || 'file';
}

function isUnderArchivedSubdir(rel) {
  return /^(media|swapped|exports)\//i.test(rel);
}

async function buildProjectZip({ projectDir, destPath, mode, senderWin }) {
  const archiver = require('archiver');
  const send = (p) => {
    if (senderWin && !senderWin.isDestroyed())
      senderWin.webContents.send('zip-export:progress', p);
  };
  send({ running: true, phase: 'preparing', percent: 0 });

  const proj = JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8'));

  const insideProject = (p) => {
    if (!p) return false;
    const rel = path.relative(projectDir, p);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const relInProject = (p) =>
    insideProject(p) ? path.relative(projectDir, p).split(path.sep).join('/') : null;

  const extraFiles = [];          // { src, name } added beyond the archived dirs
  const usedMediaNames = new Set();
  const uniqueMediaName = (absPath) => {
    const base = sanitizeZipName(path.basename(absPath));
    let name = base, i = 1;
    while (usedMediaNames.has(name.toLowerCase())) {
      const ext = path.extname(base);
      name = `${base.slice(0, base.length - ext.length)}_${i++}${ext}`;
    }
    usedMediaNames.add(name.toLowerCase());
    return `media/${name}`;
  };

  // Media Pool sources.
  if (Array.isArray(proj.sources)) {
    for (const s of proj.sources) {
      const rel = relInProject(s.filePath);
      if (rel && isUnderArchivedSubdir(rel)) {
        s.filePath = rel;                                  // shipped via archive.directory
      } else if (mode === 'full' && s.filePath && fs.existsSync(s.filePath)) {
        const zipRel = uniqueMediaName(s.filePath);        // external/root → copy into media/
        extraFiles.push({ src: s.filePath, name: zipRel });
        s.filePath = zipRel;
      }
      // projectOnly, or a missing file: leave s.filePath untouched (recipient relinks).
      s.proxyPath = '';                                    // proxies are not shipped
    }
  }

  // Region audio that lives inside the project → rewrite to relative (these dirs ship).
  if (Array.isArray(proj.regions)) {
    for (const r of proj.regions) {
      const sw = relInProject(r.swappedAudioPath);
      if (sw) r.swappedAudioPath = sw;
      const au = relInProject(r.audioFilePath);
      if (au) r.audioFilePath = au;
    }
  }

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destPath);
    const archive = archiver('zip', { zlib: { level: mode === 'full' ? 6 : 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (w) => log(`[ZipExport] warning: ${w.message}`));
    archive.on('progress', (data) => {
      const total = (data.fs && data.fs.totalBytes) || 0;
      const done = (data.fs && data.fs.processedBytes) || 0;
      send({ running: true, phase: 'archiving', percent: total > 0 ? Math.round((done / total) * 100) : 0 });
    });
    archive.pipe(output);

    archive.append(JSON.stringify(proj, null, 4), { name: 'project.json' });
    for (const sub of ['media', 'swapped', 'exports']) {
      const dir = path.join(projectDir, sub);
      if (fs.existsSync(dir)) archive.directory(dir, sub);
    }
    for (const f of extraFiles) {
      if (fs.existsSync(f.src)) archive.file(f.src, { name: f.name });
    }
    archive.finalize();
  });

  send({ running: false, phase: 'done', percent: 100, path: destPath });
}

ipcMain.handle('xleth:project:exportZip', async (event, opts) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender) || win;
  const mode = (opts && opts.mode) === 'projectOnly' ? 'projectOnly' : 'full';
  try {
    // Flush the latest timeline state to project.json before bundling.
    await callWorker('project_save');

    const info = await callWorker('project_getInfo');
    const projectDir = info && info.projectDir;
    if (!projectDir || !fs.existsSync(path.join(projectDir, 'project.json'))) {
      return { ok: false, error: 'No project is open to export.' };
    }

    const projectName = path.basename(projectDir) || 'project';
    const { canceled, filePath: destPath } = await dialog.showSaveDialog(senderWin, {
      title: 'Export Project as ZIP…',
      defaultPath: `${projectName}.zip`,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    });
    if (canceled || !destPath) return { ok: false, cancelled: true };

    log(`[ZipExport] ${mode} → ${destPath}`);
    await buildProjectZip({ projectDir, destPath, mode, senderWin });
    log(`[ZipExport] done → ${destPath}`);
    return { ok: true, path: destPath };
  } catch (e) {
    log(`[ZipExport] error: ${e && e.message}`);
    if (senderWin && !senderWin.isDestroyed())
      senderWin.webContents.send('zip-export:progress',
        { running: false, phase: 'error', error: (e && e.message) || 'Export failed' });
    return { ok: false, error: (e && e.message) || 'Export failed' };
  }
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

ipcMain.handle('xleth:getMediaPort', () => getMediaPort());

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
    await startWorker();
    splashStatus('Initializing audio engine…');
    splashStatus('Registering codecs…');

    await callWorker('initialize');
    log('initialize() OK');
    await applyEngineDefaults();
    startEngineBackgroundTasks();
    splashStatus('Starting compositor…');

    // Swap the engine's owned FrameOutput buffer for a Windows named file
    // mapping so the renderer can read frames zero-copy via shm_helper.
    // 960x540 matches CANVAS_W/H in the addon's default initialize().
    try {
      await ensureFrameShm(960, 540);
    } catch (e) {
      log(`shm init FAILED: ${e.message}`);
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
    setAddonError(e.message);
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
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
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

    if (!filePath || !fs.existsSync(filePath)) {
      return new Response('Not found', {
        status: 404,
        headers: { 'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Allow-Origin': '*' },
      });
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
              'Access-Control-Allow-Origin': '*',
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
          'Access-Control-Allow-Origin': '*',
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

  // Pass the main-window native HWND to the engine so VST editor-host
  // processes can call SetWindowLongPtrW(GWLP_HWNDPARENT) and be treated as
  // owned popups: they minimize with the main window, don't get a separate
  // taskbar button, and stay above the main window in Z-order.
  if (win && isWorkerReady()) {
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

  checkForUpdates(win);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (win === null) createWindow();
});

let engineQuitStarted = false;
app.on('before-quit', (event) => {
  if (engineQuitStarted) return;
  event.preventDefault();
  engineQuitStarted = true;
  (async () => {
    try {
      if (isWorkerReady()) {
        try { await callWorker('shutdown'); } catch (e) { log('shutdown error: ' + e.message); }
      }
      try { killWorker(); } catch {}
    } catch (e) {
      log('shutdown error: ' + e.message);
    }
    log('Exiting.');
    app.quit();
  })();
});

// Also expose the frame-shm meta synchronously for preload (sendSync path).
ipcMain.on('xleth:video:getFrameShmSync', (event) => {
  event.returnValue = frameShmMeta;
});

ipcMain.on('xleth:backdrop:getStateSync', (event) => {
  event.returnValue = getWorkspaceBackdropStateSnapshot();
});

process.on('uncaughtException', (e) => {
  log(`uncaughtException: ${e.message}\n${e.stack}`);
});
