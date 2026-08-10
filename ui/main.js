'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
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
const fxPresets = require('./electron-main/fx-presets');
const decals = require('./electron-main/decals');
const gridLayout = require('./electron-main/grid-layout');
settingsStore.init();
autosave.init({ log, isExportBusy: () => exportHandlers.isExportBusy() });
themesStore.init();
pluginUiLayouts.init({ getWin: () => win });
knobPresets.init();
fxPresets.init();
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
// unchanged. Wire mutations broadcast xleth:graph:changed, so effects-graph.js
// takes graphHandler alongside safeHandler; effects.js's chain mutations now
// broadcast via their manifest `graph:` entries (AUDIT.md S1 slice 6).
const audioHandlers = require('./electron-main/audio');
const effectsHandlers = require('./electron-main/effects');
const effectsGraphHandlers = require('./electron-main/effects-graph');
audioHandlers.init({ safeHandler });
effectsHandlers.init({ safeHandler });
effectsGraphHandlers.init({ safeHandler, graphHandler });

// ── Extracted handler domains: Phase 0 compat / launchers / preview / patterns /
//    VST3 / export / diagnostics (S5 Stage 5) ──────────────────────────────────
// Final handler-domain stage. Channel names, behavior and defaults unchanged;
// pure move. graphHandler / the WORLD poll / shm frame output stay in main.js.
const phase0Compat = require('./electron-main/phase0-compat');
const quickLaunchers = require('./electron-main/quick-launchers');
const previewVisibility = require('./electron-main/preview-visibility');
const patternHandlers = require('./electron-main/patterns');
const vst3Handlers = require('./electron-main/vst3');
const exportHandlers = require('./electron-main/export');
const diagnosticsHandlers = require('./electron-main/diagnostics');
phase0Compat.init({ safeHandler });
quickLaunchers.init({ getWin: () => win });
previewVisibility.init({ safeHandler });
patternHandlers.init({ safeHandler });
vst3Handlers.init({ safeHandler, getWin: () => win });
exportHandlers.init({ safeHandler, getWin: () => win });
diagnosticsHandlers.init({ safeHandler, getWin: () => win, log });

// ── Manifest-driven RPC handlers (AUDIT.md S1) ─────────────────────────────────
// Pure pass-through channels declared once in ui/rpc-manifest.js; hand-written
// registrations are deleted from the domain modules as methods migrate. Entries
// declaring `graph: 'track' | 'master'` register through graphHandler (broadcast
// xleth:graph:changed after the mutation). See docs/rpc-manifest.md.
const rpcRegistry = require('./electron-main/rpc-registry');
rpcRegistry.init({ safeHandler, graphHandler });

// (uncommitted WIP compat) — store internals referenced by the in-progress
// *FromPath handlers below; goes away when that WIP lands.
const { pluginIdSafe, validateLayoutStructure, parseImportedPluginUiLayout } = pluginUiLayouts;
const { DECAL_ASSET_MAX_BYTES, _decalMagicCheck, _ensureDecalAssetDir, _readDecalAssetIndex, _writeDecalAssetIndex, _decalAssetFilePath } = decals;
const _crypto = require('crypto');

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

function ffprobeExecutable() {
  const exe = runtimeResource('ffmpeg', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (app.isPackaged || fs.existsSync(exe)) return exe;
  return 'ffprobe';
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
    backgroundColor: '#00000000',
    backgroundMaterial: 'none',
    frame: false,
    show: false,
    transparent: true,
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
// Extracted to electron-main/phase0-compat.js (S5 Stage 5). Flat legacy
// transport/frame/sync channels; still routed to by preload's legacy + namespaced
// wrappers, so load-bearing (see module header for retirement conditions).

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

async function importVideoPathIntoDemoTimeline(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;

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

  const sourceId = await callWorker('loadVideo', [filePath]);
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
  return filePath;
}

ipcMain.handle('xleth:importVideoFromPath', safeHandler((_, filePath) => (
  importVideoPathIntoDemoTimeline(filePath)
)));

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
  return importVideoPathIntoDemoTimeline(filePaths[0]);
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

// -- Custom file picker filesystem bridge ------------------------------------

const FILE_PICKER_FAVORITES_KEY = 'filePickerFavorites'
const FILE_PICKER_MEDIA_EXTENSIONS = new Set([
  '.wav', '.mp3', '.flac', '.ogg', '.aac', '.m4a',
  '.mp4', '.avi', '.mov', '.mkv', '.webm', '.wmv',
])

function safeAppPath(name) {
  try {
    const value = app.getPath(name)
    return value && fs.existsSync(value) ? value : null
  } catch {
    return null
  }
}

function uniqueExistingPaths(paths) {
  const seen = new Set()
  const out = []
  for (const value of paths) {
    if (!value || typeof value !== 'string') continue
    let resolved
    try {
      resolved = path.resolve(value)
      if (!fs.existsSync(resolved)) continue
    } catch {
      continue
    }
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(key)) continue
    seen.add(key)
    out.push(resolved)
  }
  return out
}

function detectDriveRoots() {
  if (process.platform !== 'win32') return ['/']
  const roots = []
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      if (fs.existsSync(root)) roots.push(root)
    } catch {}
  }
  return roots
}

function filePickerEntryFromPath(filePath, dirent = null) {
  const stat = fs.statSync(filePath)
  const isDirectory = dirent ? dirent.isDirectory() : stat.isDirectory()
  const ext = isDirectory ? '' : path.extname(filePath).toLowerCase()
  return {
    name: path.basename(filePath) || filePath,
    path: filePath,
    isDirectory,
    isFile: dirent ? dirent.isFile() : stat.isFile(),
    extension: ext,
    size: isDirectory ? 0 : stat.size,
    modifiedMs: stat.mtimeMs,
    isMedia: !isDirectory && FILE_PICKER_MEDIA_EXTENSIONS.has(ext),
  }
}

function sanitizeFilePickerFavorites(value) {
  return uniqueExistingPaths(Array.isArray(value) ? value : [])
}

ipcMain.handle('xleth:filePicker:getRoots', () => {
  const locationSpecs = [
    ['desktop', 'Desktop'],
    ['documents', 'Documents'],
    ['downloads', 'Downloads'],
    ['music', 'Music'],
    ['videos', 'Videos'],
  ]
  const locations = uniqueExistingPaths(locationSpecs.map(([name]) => safeAppPath(name)))
    .map((locationPath) => {
      const found = locationSpecs.find(([name]) => safeAppPath(name) === locationPath)
      return {
        label: found ? found[1] : path.basename(locationPath),
        path: locationPath,
      }
    })

  const drives = detectDriveRoots().map((drivePath) => ({
    label: process.platform === 'win32' ? drivePath.replace(/\\$/, '') : drivePath,
    path: drivePath,
  }))

  return {
    home: safeAppPath('home'),
    locations,
    drives,
    favorites: sanitizeFilePickerFavorites(loadSettings()[FILE_PICKER_FAVORITES_KEY]),
  }
})

ipcMain.handle('xleth:filePicker:listDirectory', async (_, dirPath) => {
  if (!dirPath || typeof dirPath !== 'string') throw new Error('Directory path is required.')
  const resolved = path.resolve(dirPath)
  const stat = fs.statSync(resolved)
  if (!stat.isDirectory()) throw new Error('Path is not a folder.')

  const dirents = await fs.promises.readdir(resolved, { withFileTypes: true })
  const entries = []
  for (const dirent of dirents) {
    if (dirent.name === '.' || dirent.name === '..') continue
    const fullPath = path.join(resolved, dirent.name)
    try {
      entries.push(filePickerEntryFromPath(fullPath, dirent))
    } catch {
      // Skip inaccessible entries instead of breaking the whole folder.
    }
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })

  return {
    path: resolved,
    parentPath: path.dirname(resolved) !== resolved ? path.dirname(resolved) : null,
    entries,
  }
})

ipcMain.handle('xleth:filePicker:validatePath', (_, rawPath) => {
  const text = typeof rawPath === 'string' ? rawPath.trim() : ''
  if (!text) return { ok: false, error: 'Path is empty.' }
  const resolved = path.resolve(text)
  const parentPath = path.dirname(resolved)
  let exists = false
  let isDirectory = false
  let isFile = false
  let size = 0
  let modifiedMs = 0
  try {
    const stat = fs.statSync(resolved)
    exists = true
    isDirectory = stat.isDirectory()
    isFile = stat.isFile()
    size = stat.size
    modifiedMs = stat.mtimeMs
  } catch {}

  let parentExists = false
  try {
    parentExists = fs.statSync(parentPath).isDirectory()
  } catch {}

  return {
    ok: true,
    path: resolved,
    name: path.basename(resolved),
    parentPath,
    parentExists,
    exists,
    isDirectory,
    isFile,
    extension: path.extname(resolved).toLowerCase(),
    size,
    modifiedMs,
  }
})

ipcMain.handle('xleth:filePicker:createFolder', async (_, parentPath, folderName) => {
  const parent = typeof parentPath === 'string' ? path.resolve(parentPath) : ''
  const name = typeof folderName === 'string' ? folderName.trim() : ''
  if (!parent || !fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error('Parent folder does not exist.')
  }
  if (!name || name !== path.basename(name) || /[<>:"/\\|?*]/.test(name)) {
    throw new Error('Folder name is not valid.')
  }
  const target = path.join(parent, name)
  await fs.promises.mkdir(target)
  return filePickerEntryFromPath(target)
})

ipcMain.handle('xleth:filePicker:getFavorites', () => {
  const settings = loadSettings()
  return sanitizeFilePickerFavorites(settings[FILE_PICKER_FAVORITES_KEY])
})

ipcMain.handle('xleth:filePicker:setFavorites', (_, favorites) => {
  const settings = loadSettings()
  const sanitized = sanitizeFilePickerFavorites(favorites)
  settings[FILE_PICKER_FAVORITES_KEY] = sanitized
  saveSettings(settings)
  return sanitized
})

function probeMediaDuration(filePath) {
  return new Promise((resolve) => {
    if (!filePath || typeof filePath !== 'string') {
      resolve(null)
      return
    }
    const ext = path.extname(filePath).toLowerCase()
    if (!FILE_PICKER_MEDIA_EXTENSIONS.has(ext)) {
      resolve(null)
      return
    }
    execFile(ffprobeExecutable(), [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeout: 6000 }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      const value = Number.parseFloat(String(stdout || '').trim())
      resolve(Number.isFinite(value) && value >= 0 ? value : null)
    })
  })
}

ipcMain.handle('xleth:filePicker:probeDurations', async (_, filePaths) => {
  const paths = Array.isArray(filePaths) ? filePaths.slice(0, 200) : []
  const result = {}
  let index = 0
  const workers = Array.from({ length: Math.min(4, paths.length) }, async () => {
    while (index < paths.length) {
      const filePath = paths[index]
      index += 1
      try {
        const duration = await probeMediaDuration(filePath)
        if (duration != null) result[filePath] = duration
      } catch {}
    }
  })
  await Promise.all(workers)
  return result
})

// ── Quick Launchers ──────────────────────────────────────────────────────────
// Extracted to electron-main/quick-launchers.js (S5 Stage 5).

// ── Autosave timer ────────────────────────────────────────────────────────────
// Extracted to electron-main/autosave.js (S5 Stage 2), including the
// xleth:autosave:restart handler. Export-progress state stays here and is
// probed via the injected isExportBusy.

// ── Phase 7 — Preview visibility (panel show/hide) ───────────────────────────
// Extracted to electron-main/preview-visibility.js (S5 Stage 5).

// ── Themes (persisted to userData/themes/<slug>.json) ─────────────────────────
// Extracted to electron-main/themes.js (S5 Stage 2); the xleth:layout:read/
// write handlers that lived here moved into electron-main/settings.js.
// ── Stock plugin UI layouts (userData/plugin-ui/<pluginId>.json) ──────────────
// Extracted to electron-main/plugin-ui-layouts.js (S5 Stage 2), including the
// xleth:dialog:importPluginUi / xleth:dialog:exportPluginUi handlers.

ipcMain.handle('xleth:pluginUi:importFromPath', (_, selectedPath) => {
  if (!selectedPath || typeof selectedPath !== 'string') return null
  try {
    const raw = fs.readFileSync(selectedPath, 'utf8')
    const { pluginId, layout } = parseImportedPluginUiLayout(raw)
    return { pluginId, layout, path: selectedPath }
  } catch (err) {
    throw new Error(`Import failed: ${err?.message || err}`)
  }
})

// ── User-saved knob appearance presets ────────────────────────────────────────
// Extracted to electron-main/knob-presets.js (S5 Stage 2).

ipcMain.handle('xleth:pluginUi:exportToPath', (_, pluginId, layout, filePath) => {
  if (!pluginIdSafe(pluginId)) throw new Error('invalid pluginId')
  const structErr = validateLayoutStructure(layout, pluginId)
  if (structErr) throw new Error(`Invalid layout: ${structErr}`)
  if (!filePath || typeof filePath !== 'string') return null

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(layout, null, 2), 'utf8')
    return { path: filePath }
  } catch (err) {
    throw new Error(`Export failed: ${err?.message || err}`)
  }
})

// ── User-imported decal assets ─────────────────────────────────────────────────
// Extracted to electron-main/decals.js (S5 Stage 2).

ipcMain.handle('xleth:pluginUiAssets:importFromPath', (_, srcPath) => {
  if (!srcPath || typeof srcPath !== 'string') return null
  const srcExt = path.extname(srcPath).toLowerCase().slice(1)
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

  const uuid = _crypto.randomUUID()
  const assetId = `user.imported.${uuid}`
  const label = path.basename(srcPath, path.extname(srcPath)).slice(0, 64) || 'Untitled'

  _ensureDecalAssetDir()
  const destPath = _decalAssetFilePath(assetId, magic.ext)
  fs.writeFileSync(destPath, buf)

  const meta = {
    assetId,
    label,
    mime: magic.mime,
    ext: magic.ext,
    sizeBytes: buf.length,
    importedAt: new Date().toISOString(),
  }

  const index = _readDecalAssetIndex()
  index.push(meta)
  _writeDecalAssetIndex(index)
  return meta
})

// Engine-level global clip-processing defaults (stretch method / formant
// preserve) extracted to electron-main/clip-processing-defaults.js (S5 Stage 3).

// Region / syllable handlers (addRegion/modifyRegion/set+getSyllables/
// removeRegion) extracted to electron-main/patterns.js (S5 Stage 5).

// ── Grid Layout ─────────────────────────────────────────────────────────────
// Extracted to electron-main/grid-layout.js (S5 Stage 2) — engine pass-through
// handlers, wired via gridLayout.init({ safeHandler }).

// Set a track's global compositing zOrder (grid slot OR fullscreen layer), one
// undo step. Engine entry point for the future Video-tab reorder UI; compositing
// order only (unrelated to setTrackOrder / audio arrangement).
ipcMain.handle('xleth:timeline:setPlacementZOrder',
  safeHandler((_, trackId, zOrder) => callWorker('timeline_setPlacementZOrder', [trackId, zOrder])));

// ── Pattern handlers ─────────────────────────────────────────────────────────
// Extracted to electron-main/patterns.js (S5 Stage 5), together with the
// region/syllable handlers above.

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

// ── VST3 plugin scanner + editor windows ─────────────────────────────────────
// Extracted to electron-main/vst3.js (S5 Stage 5).

// ── Audio + Video Export ─────────────────────────────────────────────────────
// Extracted to electron-main/export.js (S5 Stage 5), including the two export
// progress-poll intervals + isExportBusy() (consumed by the autosave gate). The
// video export/hw-encoder/GPU handlers, physically split from here by the WORLD
// poll below, are extracted too. graphHandler untouched.

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

// (Video export + hardware-encoder + GPU handlers extracted to
// electron-main/export.js (S5 Stage 5) — see the Export breadcrumb above.)

// ─── Visual Preview Diagnostic Log + Pixel-content verification ──────────────
// Extracted to electron-main/diagnostics.js (S5 Stage 5).

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
  let defaultPath = undefined;
  try {
    const info = await callWorker('project_getInfo');
    if (info && typeof info.exportsDir === 'string' && info.exportsDir) defaultPath = info.exportsDir;
  } catch {}
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Select Processed Audio',
    defaultPath,
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

// ── Sample Video Export / Swap (mirrors Sample Audio Export/Swap above) ──────

// Dialog: open a video file to swap in as the replacement video stream
ipcMain.handle('xleth:dialog:swapVideo', async () => {
  let defaultPath = undefined;
  try {
    const info = await callWorker('project_getInfo');
    if (info && typeof info.exportsDir === 'string' && info.exportsDir) defaultPath = info.exportsDir;
  } catch {}
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Select Replacement Video',
    defaultPath,
    filters: [{ name: 'Video Files', extensions: ['mp4', 'avi', 'mov', 'mkv'] }],
    properties: ['openFile'],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

// Export region's original source video to exports/, then reveal in Explorer
ipcMain.handle('xleth:video:exportRegion',
  safeHandler(async (_, regionId) => {
    const VALID_NAMING_FORMATS = ['sampleNameOnly', 'categoryAndName', 'sourceAndName', 'fullLegacy'];
    const saved = loadSettings().sampleNamingFormat;
    const format = VALID_NAMING_FORMATS.includes(saved) ? saved : 'sampleNameOnly';
    const result = await callWorker('video_exportRegion', [regionId, format]);
    if (result?.success && result.path) shell.showItemInFolder(result.path);
    return result;
  }));

ipcMain.handle('xleth:video:swapRegionVideo',
  safeHandler((_, regionId, replacementFilePath) =>
    callWorker('video_swapRegionVideo', [regionId, replacementFilePath])));

ipcMain.handle('xleth:video:revertRegionVideo',
  safeHandler((_, regionId) =>
    callWorker('video_revertRegionVideo', [regionId])));

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
  let defaultPath = undefined;
  try {
    const info = await callWorker('project_getInfo');
    if (info && typeof info.projectDir === 'string' && info.projectDir) defaultPath = info.projectDir;
  } catch {}
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Save Project As — Choose Folder',
    defaultPath,
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
    let destPath = typeof opts?.destPath === 'string' ? opts.destPath : '';
    if (!destPath) {
      const { canceled, filePath } = await dialog.showSaveDialog(senderWin, {
        title: 'Export Project as ZIP…',
        defaultPath: `${projectName}.zip`,
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
      });
      if (canceled || !filePath) return { ok: false, cancelled: true };
      destPath = filePath;
    }
    if (path.extname(destPath).toLowerCase() !== '.zip') destPath += '.zip';

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

// ─── Loop Lab (DEV dataset-authoring tool) ───────────────────────────────────
// Main-process helpers for the Loop Lab panel: a WAV multi-picker, a WAV-header
// probe (authoritative file rate/channels/frame-count), and the dataset ZIP
// export. All renderer-side loop authoring is done through existing engine RPCs
// (see docs/loop-lab-codepath-report.md); these handlers only touch the
// filesystem, which the renderer cannot. The parsing/conversion/dataset logic
// lives in electron-main/loopLabExport.js so it can be unit-tested.
const loopLabExport = require('./electron-main/loopLabExport');

// xleth:loopLab:pickWavs → string[] of absolute file paths (empty if cancelled).
ipcMain.handle('xleth:loopLab:pickWavs', async (event) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender) || win;
  const { canceled, filePaths } = await dialog.showOpenDialog(senderWin, {
    title: 'Loop Lab — Import WAV samples',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'WAV audio', extensions: ['wav'] }],
  });
  return canceled ? [] : filePaths;
});

// xleth:loopLab:probeWav(filePath) → header info | null
ipcMain.handle('xleth:loopLab:probeWav', async (_, filePath) => {
  return loopLabExport.parseWavHeader(filePath);
});

// ── Loop Lab persistent state ────────────────────────────────────────────────
// ONE permanent JSON file in the app's userData dir, independent of any project.
// The panel autosaves its whole working set here on every change and re-hydrates
// from it on open — so imported WAVs + loop edits survive app restarts and
// project switches. Written atomically (tmp + rename) so a crash mid-write can't
// corrupt it.
function loopLabStatePath() {
  return path.join(app.getPath('userData'), 'loop-lab-state.json');
}

// xleth:loopLab:loadState() → state object | null
ipcMain.handle('xleth:loopLab:loadState', async () => {
  try {
    const f = loopLabStatePath();
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    log(`[LoopLab] loadState error: ${e && e.message}`);
    return null;
  }
});

// xleth:loopLab:saveState(state) → { ok } | { ok:false, error }
ipcMain.handle('xleth:loopLab:saveState', async (_, state) => {
  try {
    const f = loopLabStatePath();
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, f);
    return { ok: true };
  } catch (e) {
    log(`[LoopLab] saveState error: ${e && e.message}`);
    return { ok: false, error: (e && e.message) || 'save failed' };
  }
});

// xleth:loopLab:exportDataset({ destPath?, samples: [...] }) → { ok, path } | { ok:false, ... }
// samples[i] = { filePath, name, className, instrumentName|null, source, rootNote|null,
//                behaviorFamily, engineSampleRate, gold: { start, end, xfade } }  // gold in ENGINE-buffer samples
ipcMain.handle('xleth:loopLab:exportDataset', async (event, payload) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender) || win;
  const samples = Array.isArray(payload?.samples) ? payload.samples : [];
  if (samples.length === 0) return { ok: false, error: 'No samples to export.' };
  try {
    let dataset, zipEntries;
    try {
      ({ dataset, zipEntries } = loopLabExport.buildDataset(samples));
    } catch (be) {
      return { ok: false, error: be.message };
    }

    let destPath = typeof payload?.destPath === 'string' ? payload.destPath : '';
    if (!destPath) {
      const { canceled, filePath } = await dialog.showSaveDialog(senderWin, {
        title: 'Loop Lab — Export corpus + dataset.json…',
        defaultPath: 'loop-lab-corpus.zip',
        filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
      });
      if (canceled || !filePath) return { ok: false, cancelled: true };
      destPath = filePath;
    }
    if (path.extname(destPath).toLowerCase() !== '.zip') destPath += '.zip';

    const archiver = require('archiver');
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(destPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.on('warning', (w) => log(`[LoopLab] zip warning: ${w.message}`));
      archive.pipe(output);
      archive.append(JSON.stringify(dataset, null, 2), { name: 'dataset.json' });
      for (const e of zipEntries) archive.file(e.src, { name: e.name });
      archive.finalize();
    });

    log(`[LoopLab] exported ${dataset.length} samples → ${destPath}`);
    return { ok: true, path: destPath, count: dataset.length };
  } catch (e) {
    log(`[LoopLab] export error: ${e && e.message}`);
    return { ok: false, error: (e && e.message) || 'Export failed' };
  }
});

// ── Loop Lab blind A/B rater: candidates.json in, ratings.jsonl out ──────────
// The rater loads the arm set written by `python -m loop_optimizer export` and
// appends one verdict per line to ratings.jsonl BESIDE it, so a corpus, the
// candidates generated from it and the verdicts collected on them stay in one
// directory. Parsing lives in the renderer (loopLabRater.js, unit-tested);
// these handlers only read and append text, which the renderer cannot.
const RATINGS_FILENAME = 'ratings.jsonl';

function loopLabRatingsPath(candidatesPath) {
  return path.join(path.dirname(candidatesPath), RATINGS_FILENAME);
}

function readCandidatesFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: `no candidates file at ${filePath}` };
    return { ok: true, path: filePath, text: fs.readFileSync(filePath, 'utf8') };
  } catch (e) {
    log(`[LoopLab] readCandidates error: ${e && e.message}`);
    return { ok: false, error: (e && e.message) || 'read failed' };
  }
}

// xleth:loopLab:pickCandidates() → { ok, path, text } | { cancelled } | { ok:false, error }
ipcMain.handle('xleth:loopLab:pickCandidates', async (event) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender) || win;
  const { canceled, filePaths } = await dialog.showOpenDialog(senderWin, {
    title: 'Loop Lab — Open candidates.json',
    properties: ['openFile'],
    filters: [{ name: 'Candidate set', extensions: ['json'] }],
  });
  if (canceled || !filePaths || !filePaths[0]) return { cancelled: true };
  return readCandidatesFile(filePaths[0]);
});

// xleth:loopLab:readCandidates(path) → { ok, path, text } | { ok:false, error }
// Re-opens the file the panel was last pointed at, so a session resumes without
// the user having to find it again.
ipcMain.handle('xleth:loopLab:readCandidates', async (_, filePath) => readCandidatesFile(filePath));

// xleth:loopLab:loadRatings(candidatesPath) → { ok, path, text }
// A missing file is the normal first-run case, not an error: it reads as empty.
ipcMain.handle('xleth:loopLab:loadRatings', async (_, candidatesPath) => {
  try {
    const f = loopLabRatingsPath(candidatesPath);
    if (!fs.existsSync(f)) return { ok: true, path: f, text: '' };
    return { ok: true, path: f, text: fs.readFileSync(f, 'utf8') };
  } catch (e) {
    log(`[LoopLab] loadRatings error: ${e && e.message}`);
    return { ok: false, error: (e && e.message) || 'load failed' };
  }
});

// xleth:loopLab:appendRating(candidatesPath, line) → { ok, path } | { ok:false, error }
// A single appendFileSync per verdict, deliberately: a 36-trial session is a
// long sit, and a crash at trial 30 must not cost the previous 29. Rewriting a
// whole ratings array would put every earlier verdict at risk on every write.
ipcMain.handle('xleth:loopLab:appendRating', async (_, candidatesPath, line) => {
  try {
    if (typeof line !== 'string' || !line.endsWith('\n')) {
      return { ok: false, error: 'rating line must be a newline-terminated string' };
    }
    const f = loopLabRatingsPath(candidatesPath);
    fs.appendFileSync(f, line, 'utf8');
    return { ok: true, path: f };
  } catch (e) {
    log(`[LoopLab] appendRating error: ${e && e.message}`);
    return { ok: false, error: (e && e.message) || 'append failed' };
  }
});

// ── AUTO-loop telemetry (local JSONL, no network) ────────────────────────────
// The sampler AUTO button appends one line per event: an "apply" when a loop is
// snapped, and a "nudge" when the user edits loopStart/loopEnd/crossfade within
// 30 s of an apply. No confidence model exists (measured features cannot predict
// acceptance — LOO AUC 0.53), so this replaces it: it is the only signal for how
// often the snap is kept vs. adjusted.
//
// Written beside the current project when one is known; the main process does not
// track a project path (project state lives in the renderer/engine), so this
// lands in userData — the same durable, per-user location loop-lab-state.json
// uses. "Export loop telemetry" (dev menu) saves a copy wherever the user picks.
// The append/read logic lives in electron-main/loopTelemetry.js so it is unit-
// testable without Electron.
const loopTelemetry = require('./electron-main/loopTelemetry');
function loopTelemetryPath() {
  return loopTelemetry.telemetryFile(app.getPath('userData'));
}

// xleth:loopTelemetry:append(event) → { ok, path } | { ok:false, error }
ipcMain.handle('xleth:loopTelemetry:append', async (_, event) => {
  try {
    const file = loopTelemetry.appendEvent(app.getPath('userData'), event);
    return { ok: true, path: file };
  } catch (e) {
    log(`[LoopTelemetry] append error: ${e && e.message}`);
    return { ok: false, error: (e && e.message) || 'append failed' };
  }
});

// xleth:loopTelemetry:export() → { ok, path } | { ok:false, error } | { ok:false, canceled }
ipcMain.handle('xleth:loopTelemetry:export', async (event) => {
  try {
    const src = loopTelemetryPath();
    if (!fs.existsSync(src)) return { ok: false, error: 'No telemetry recorded yet.' };
    const senderWin = BrowserWindow.fromWebContents(event.sender) || win;
    const { canceled, filePath } = await dialog.showSaveDialog(senderWin, {
      title: 'Export loop telemetry',
      defaultPath: path.join(app.getPath('desktop') || app.getPath('home') || '.', 'loop-telemetry.jsonl'),
      filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.copyFileSync(src, filePath);
    return { ok: true, path: filePath };
  } catch (e) {
    log(`[LoopTelemetry] export error: ${e && e.message}`);
    return { ok: false, error: (e && e.message) || 'export failed' };
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
