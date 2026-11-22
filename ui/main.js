'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { runtimeResource, userDataPath } = require('./runtimePaths');
const { checkForUpdates } = require('./update-checker');

// Fixed name for the Windows file mapping that backs the FrameOutput double
// buffer. The engine worker creates it via FrameOutput::initSharedMemory;
// the Electron main process / preload opens the same name via shm_helper.node.
const FRAME_SHM_NAME = 'XlethFrameBuffer';
// The section is created once at 100% preview scale and never resized, because
// a Windows named section's size is fixed at creation: once preload has opened
// it, our own close/re-create hands back the SAME (old-sized) object and a
// larger MapViewOfFile fails with ERROR_ACCESS_DENIED, killing the preview for
// the rest of the session. Must match BASE_CANVAS_W/H in VideoPreview.jsx,
// which is what previewResolutionScale is a fraction OF.
const FRAME_SHM_BASE_W = 960;
const FRAME_SHM_BASE_H = 540;


// ── User settings (persisted across sessions, not per-project) ───────────────
// Extracted to electron-main/settings.js (S5 Stage 2) together with the
// xleth:layout:read/write handlers. loadSettings/saveSettings and
// getNewProjectGlobalStretchMethodDefault come from the Stage 2 require block
// below.

// Log file for startup debugging
const logPath = userDataPath('startup.log');
try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
// Buffered async stream instead of a sync appendFileSync-per-line — the
// renderer console pipe below (and every non-silent IPC call) used to cost a
// synchronous disk write per log line. 'w' truncates on open, replacing the
// old separate writeFileSync('') clear.
//
// Size cap: the file used to grow without bound for a whole session (~17 MB/h
// of mostly [IPC] lines; 56 MB seen after 1.5 h). Past LOG_ROTATE_BYTES the
// current file is moved to startup.1.log (replacing the previous chunk) and a
// fresh startup.log continues, so disk use stays under ~2x the cap and the
// most recent lines are always in startup.log. stdout is unaffected.
const LOG_ROTATE_BYTES = 20 * 1024 * 1024;
let logStream = fs.createWriteStream(logPath, { flags: 'w' });
let logBytes = 0;
let logRotations = 0;
function rotateLog() {
  const old = logStream;
  const rotatedPath = userDataPath('startup.1.log');
  logRotations += 1;
  logBytes = 0;
  // Rename once the old stream has flushed and closed; new lines go to a
  // fresh stream immediately (opened on a temp name, then swapped in, so no
  // line is lost or written into the file being renamed).
  logStream = fs.createWriteStream(`${logPath}.next`, { flags: 'w' });
  old.end(() => {
    // libuv opens files with FILE_SHARE_DELETE, so the fresh stream's handle
    // stays valid while its file is renamed into place.
    try { fs.renameSync(logPath, rotatedPath); } catch {}
    try { fs.renameSync(`${logPath}.next`, logPath); } catch {}
  });
  logStream.write(`[${new Date().toISOString()}] [log] rotated (#${logRotations}) — previous ${LOG_ROTATE_BYTES >> 20} MB in startup.1.log\n`);
}
function writeLogLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  logStream.write(line);
  logBytes += Buffer.byteLength(line);
  if (logBytes >= LOG_ROTATE_BYTES) rotateLog();
}

// ── Session console log capture (Settings → Application → Logs) ──────────────
// Every main-process line also lands in consoleLog's in-memory ring buffer, so
// the exported session report contains the same narrative startup.log does
// without each call site having to log twice. Renderer console output is
// attached separately in createWindow(). init() is deferred until the settings
// store is available below; record() works from the first line regardless.
const consoleLog = require('./electron-main/console-log');
const log = consoleLog.wrapMainLogger(writeLogLine);

// ── Extracted main-process modules (S5 Stage 1) ──────────────────────────────
// Engine-worker lifecycle and the local HTTP media server were moved verbatim
// to ui/electron-main/. Both are wired with the shared startup.log logger.
const workerBridge = require('./electron-main/worker');
const mediaServer = require('./electron-main/media-server');
workerBridge.init({ log });
const { startWorker, callWorker, isWorkerReady, getAddonError, setAddonError, killWorker } = workerBridge;
mediaServer.init({
  log,
  // The media server may only read files under the open project folder and the folders of its sources.
  getRoots: async () => {
    const [info, sources] = await Promise.all([callWorker('project_getInfo'), callWorker('timeline_getSources')]);
    return [info && info.projectDir, ...(sources || []).map((s) => s && s.filePath && path.dirname(s.filePath))];
  },
});
const { startMediaServer, getMediaPort, getMediaToken } = mediaServer;

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
const fxChains = require('./electron-main/fx-chains');
const decals = require('./electron-main/decals');
const gridLayout = require('./electron-main/grid-layout');
const recentProjects = require('./electron-main/recent-projects');
settingsStore.init();
autosave.init({ log, isExportBusy: () => exportHandlers.isExportBusy() });
themesStore.init();
pluginUiLayouts.init({ getWin: () => win });
knobPresets.init();
fxPresets.init();
fxChains.init();
decals.init({ getWin: () => win });
gridLayout.init({ safeHandler });
recentProjects.init();
const { loadSettings, saveSettings, getNewProjectGlobalStretchMethodDefault } = settingsStore;
const { restartAutosaveTimer } = autosave;

// Needs the settings store for its auto-export-on-quit preference, so it is
// initialised here rather than beside its require at the top of the file.
consoleLog.init({ loadSettings, saveSettings, getWin: () => win, log });

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
const welcomeHandlers = require('./electron-main/welcome');
// The three hooks are function declarations further down (hoisted): see
// "Workspace window boot". They only run once a load is actually requested.
projectHandlers.init({
  safeHandler,
  shouldBroadcastTo: (wc) => workspaceTakesBroadcasts(wc),
  onLoadStart: (event) => onIpcProjectLoadStart(event),
  onLoadEnd: (event, _dir, ok) => onIpcProjectLoadEnd(event, ok),
});
require('./electron-main/still-media').init({ safeHandler });
timelineHandlers.init({ safeHandler });
clipProcessingDefaults.init({ safeHandler });
undoRedoHandlers.init({ safeHandler });
transportHandlers.init({ safeHandler });
// onProjectReady is a lazy reference to launchWorkspace() (defined later,
// near createWindow) — function declarations hoist, and this callback only
// actually runs once Welcome signals success, long after the whole module
// has finished loading.
welcomeHandlers.init({
  safeHandler,
  callWorker,
  log,
  onProjectReady: (dir, name) => launchWorkspace(dir, name),
});

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
// Source separation (P4) — owns the Python/FastAPI sidecar lifecycle. Not on
// the RPC manifest: every manifest entry names a C++ engine handler symbol,
// and separation never reaches the engine.
const separationHandlers = require('./electron-main/separation');
phase0Compat.init({ safeHandler });
quickLaunchers.init({ getWin: () => win });
previewVisibility.init({ safeHandler });
patternHandlers.init({ safeHandler });
vst3Handlers.init({ safeHandler, getWin: () => win });
exportHandlers.init({ safeHandler, getWin: () => win });
diagnosticsHandlers.init({ safeHandler, getWin: () => win, log });
// No safeHandler here on purpose — separation never reaches the engine, so
// gating it on engine readiness would strand the Sandbox's separation strip
// whenever the panel is opened during startup. See separation.js's `handler`.
separationHandlers.init({ getWin: () => win, log });
// Machine-local add-ons in ui/local/ (git-excluded, not packaged); absent in other checkouts and builds.
const localAddons = path.join(__dirname, 'local', 'index.js');
if (fs.existsSync(localAddons)) require(localAddons).init({ getWin: () => win, log, ffmpegPath: ffmpegExecutable });

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

// Same id as electron-builder's appId, so the taskbar groups XLETH windows (and
// pins/jump lists) under the XLETH icon instead of electron.exe's identity.
if (process.platform === 'win32') app.setAppUserModelId('com.xleth.app');

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

  // Proxy codec (Settings > Graphics > Proxies). Pushed before any project can
  // open, because project open is what decides whether legacy intra proxies get
  // migrated to H.264. Unset → the engine's own default (H.264).
  if (saved.proxyCodec === 'h264' || saved.proxyCodec === 'intra') {
    const state = await callWorker('proxy_setCodec', [saved.proxyCodec]).catch(() => null);
    if (!state || state.requested !== saved.proxyCodec) {
      log(`applyEngineDefaults: restore proxy codec '${saved.proxyCodec}' failed: ${JSON.stringify(state)}`);
    }
  }

  // "Delete regenerable files when closing a project" (Settings > Project). Pushed
  // before any project can open or close: the ENGINE performs the purge, at the
  // moment it tears the old project down (project switch or quit). Off by default,
  // so only an explicit true needs pushing. The engine echoes the value in force,
  // so a call that silently never arrived is logged instead of leaving the
  // setting ON in the UI and OFF in the engine.
  if (saved.purgeRegenerableOnClose === true) {
    const inForce = await callWorker('project_setPurgeOnClose', [true]).catch(() => null);
    if (inForce !== true) {
      log(`applyEngineDefaults: restore purge-on-close failed: ${JSON.stringify(inForce)}`);
    }
  }

  // Per-machine audio device preferences (output device, buffer size, sample
  // rate) — hardware properties of this machine, not this project, persisted
  // in the same generic settings store as previewResolutionScale, never in
  // project.json. Reapplied here, before the window is ever shown, so any
  // resulting device reopen happens during the splash screen instead of as
  // an audible glitch after the UI and audio are already live.
  if (typeof saved.audioOutputDevice === 'string' && saved.audioOutputDevice) {
    const result = await callWorker('audio_setOutputDevice', [saved.audioOutputDevice]).catch(() => null);
    if (result && !result.ok) log(`applyEngineDefaults: restore output device failed: ${result.error}`);
  }
  if (typeof saved.audioBufferSize === 'number') {
    const result = await callWorker('audio_setBufferSize', [saved.audioBufferSize]).catch(() => null);
    if (result && !result.ok) log(`applyEngineDefaults: restore buffer size failed: ${result.error}`);
  }
  if (typeof saved.audioSampleRate === 'number') {
    const result = await callWorker('audio_setSampleRate', [saved.audioSampleRate]).catch(() => null);
    if (result && !result.ok) log(`applyEngineDefaults: restore sample rate failed: ${result.error}`);
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
// UI scale (Phase 7): the window zoom factor IS the global UI scale. 100 % to 200 % in 10 %
// steps, persisted as `uiScale` (a percent) in settings.json and restored when the workspace
// window loads. The Zoom In / Zoom Out / Reset Zoom menu items and their shortcuts, and the
// Settings > Appearance control, all move this one value. Real Chromium zoom, so hit-testing
// stays correct; never a CSS transform.
const {
  DEFAULT_ZOOM_FACTOR,
  ZOOM_STEP,
  UI_SCALE_SETTINGS_KEY,
  clampZoomFactor,
  factorFromStoredPercent,
} = require('./electron-main/ui-scale');

function getTargetWindow(event) {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow && !senderWindow.isDestroyed()) return senderWindow;
  return win;
}

function setWindowZoom(targetWindow, factor) {
  const wc = targetWindow?.webContents;
  if (!wc || wc.isDestroyed()) return DEFAULT_ZOOM_FACTOR;

  const nextFactor = clampZoomFactor(Number(factor));
  wc.setZoomFactor(nextFactor);
  // Only the workspace window owns the persisted value; child windows follow Chromium's
  // per-origin zoom and are told about it too.
  if (targetWindow === win) {
    const s = loadSettings();
    const percent = Math.round(nextFactor * 100);
    if (s[UI_SCALE_SETTINGS_KEY] !== percent) { s[UI_SCALE_SETTINGS_KEY] = percent; saveSettings(s); }
  }
  wc.send('xleth:window:zoomChanged', nextFactor);
  return nextFactor;
}

// Restore the saved scale once the renderer exists. Idempotent: Chromium may already hold it.
function restoreUiScale(targetWindow) {
  const wc = targetWindow?.webContents;
  if (!wc || wc.isDestroyed()) return;
  const factor = factorFromStoredPercent(loadSettings()[UI_SCALE_SETTINGS_KEY]);
  wc.setZoomFactor(factor);
  wc.send('xleth:window:zoomChanged', factor);
  log(`[Theme] ui scale restored -> ${Math.round(factor * 100)}%`);
}

function nudgeWindowZoom(targetWindow, direction) {
  const wc = targetWindow?.webContents;
  if (!wc || wc.isDestroyed()) return DEFAULT_ZOOM_FACTOR;

  return setWindowZoom(targetWindow, wc.getZoomFactor() + (direction * ZOOM_STEP));
}
const nodeEditorWindows = new Map(); // key → BrowserWindow

// The splash is never waited FOR: whatever it is covering (engine boot, a
// project load, the workspace window's own boot) starts at once and runs
// alongside it. A status sent before the splash page exists is remembered and
// replayed when it appears; a transition that finishes before the splash has
// even painted closes it unseen instead of flashing it.
const SPLASH_MIN_VISIBLE_MS = 400;   // once seen, it stays long enough to be read
let splashVisibleSince = 0;          // Date.now() when it became visible; 0 = not (yet) shown
let splashShownPromise = null;
let lastSplashStatus = null;
let splashEpoch = 0;                 // bumped by every showSplashWindow(); see finishSplash

function splashStatus(message, percent) {
  lastSplashStatus = [message, percent];
  if (splashWin && !splashWin.isDestroyed() && splashVisibleSince) {
    splashWin.webContents.send('splash:status', message, percent);
  }
}

// Closes the splash, then runs `reveal` (showing whatever it was covering).
// The minimum-visibility wait counts from when the splash APPEARED, not from
// when the thing behind it became ready — so it only ever costs time on a
// transition quick enough that the splash would otherwise blink.
function finishSplash(reveal) {
  const w = splashWin;
  const epoch = splashEpoch;
  const wait = splashVisibleSince
    ? Math.max(0, SPLASH_MIN_VISIBLE_MS - (Date.now() - splashVisibleSince))
    : 0;
  const done = () => {
    // Asked for again while this close was waiting out the minimum (a retry
    // straight after a failed load): it now belongs to that newer transition.
    if (w && !w.isDestroyed() && epoch === splashEpoch) w.close();
    if (reveal) {
      try { reveal(); } catch (e) { log(`[Splash] reveal failed: ${e.message}`); }
    }
  };
  if (wait > 0) setTimeout(done, wait); else done();
}

// Creates (or reuses) the splash window and resolves once it's actually
// visible (or with null if it was closed first). Used both for the one-time
// engine-boot sequence and for any later transition that needs the same
// "loading, here's the progress" treatment — Welcome handing off to the
// workspace, and in-app project switches (see launchWorkspace/
// switchProjectWindow below). Idempotent: if splashWin is already up (e.g. a
// switch triggered while the previous one is still closing), it's shown/
// reused rather than duplicated.
function showSplashWindow() {
  splashEpoch++;
  if (splashWin && !splashWin.isDestroyed()) {
    if (!splashVisibleSince) return splashShownPromise;   // still loading its page
    if (!splashWin.isVisible()) splashWin.show();
    return Promise.resolve(splashWin);
  }
  splashVisibleSince = 0;
  const w = new BrowserWindow({
    width: 640,
    height: 400,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    center: true,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'splash-preload.js'),
    },
  });
  splashWin = w;
  splashShownPromise = new Promise((resolve) => {
    w.once('ready-to-show', () => {
      if (w.isDestroyed()) { resolve(null); return; }
      w.show();
      splashVisibleSince = Date.now();
      if (lastSplashStatus) w.webContents.send('splash:status', ...lastSplashStatus);
      resolve(w);
    });
    w.once('closed', () => resolve(null));
  });
  w.loadFile(path.join(__dirname, 'splash.html'), { query: { v: app.getVersion() } });
  w.on('closed', () => {
    if (splashWin === w) { splashWin = null; splashVisibleSince = 0; }
  });
  return splashShownPromise;
}

// ── Workspace window boot ────────────────────────────────────────────────────
// Booting the workspace renderer (process spawn, bundle load + evaluation)
// takes about as long as the engine takes to load a project, and neither
// needs the other. So the window is created HIDDEN as soon as a project load
// is known to be coming, and the two run side by side:
//
//   gate    The renderer evaluates its bundle, then waits on
//           xleth:boot:whenProjectReady before mounting React (ui/src/
//           main.jsx). The UI therefore still mounts against a fully loaded
//           project, exactly as when the window was only created afterwards.
//   mounted After its first commit the renderer reports xleth:boot:mounted.
//           That — not Chromium's ready-to-show, which for a gated page fires
//           on an empty document — is what the reveal waits for, plus the
//           start-up burst of engine queries draining (whenEngineQuiet).
//
// One xleth:project-loaded is delivered per boot (it is what hydrates
// effectChainStore's FX Graph state), and it is sent immediately BEFORE the
// gate opens: the stores, whose listeners register when the bundle is
// evaluated, get it; the components, which are not mounted yet, do not — they
// read the project once, as they mount. (Sent after the mount, as it used to
// be, every mounted component threw its fresh state away and fetched the
// whole project a second time.) project.js's own broadcast skips a window
// that is still booting, see workspaceTakesBroadcasts.
//
// A bundle that predates the gate never asks for it: it mounts at once (its
// queries simply queue behind the load in the engine worker), gets its signal
// from the fallback timer, and is revealed by it.
let workspaceBoot = null;   // boot state of the current workspace window, or null
let workspaceLaunchRequested = false;   // a project is open(ing) in a workspace window
let welcomeLoadInFlight = false;

function newWorkspaceBootState(gateOpen) {
  let openGate;
  const gatePromise = new Promise((resolve) => { openGate = resolve; });
  if (gateOpen) openGate();
  return {
    gateOpen, openGate, gatePromise,
    gateAware: false,       // the renderer asked for the gate (current bundle)
    finishedLoad: false,    // did-finish-load
    mounted: false,         // xleth:boot:mounted
    fallback: false,        // gave up waiting for `mounted`
    fallbackTimer: null,
    signalled: false,       // xleth:project-loaded delivered
    revealRequested: false, // openWorkspaceWindow() ran: show it when ready
    revealed: false,
    handleSplash: false,
    createdAt: Date.now(),
  };
}

function isWorkspaceSender(event) {
  return !!(win && !win.isDestroyed() && event.sender === win.webContents);
}

// project.js asks before each xleth:project-loaded broadcast. The workspace
// window gets its own, once, when its boot completes; until then it is skipped.
function workspaceTakesBroadcasts(wc) {
  if (!win || win.isDestroyed() || wc !== win.webContents) return true;
  return !workspaceBoot || workspaceBoot.signalled;
}

// The boot's one xleth:project-loaded. Only ever sent to a renderer whose
// bundle has been evaluated (it asked for the gate, or the page finished
// loading), so the stores' listeners exist to receive it.
function signalWorkspaceProjectLoaded(st) {
  if (st.signalled || workspaceBoot !== st || !win || win.isDestroyed()) return;
  st.signalled = true;
  win.webContents.send('xleth:project-loaded');
}

ipcMain.handle('xleth:boot:whenProjectReady', (event) => {
  const st = workspaceBoot;
  if (!st || !isWorkspaceSender(event)) return true;   // child windows are never gated
  st.gateAware = true;
  // Project already in (the window was created after the load, or the load
  // beat the bundle): signal now, ahead of the reply that lets it mount.
  if (st.gateOpen) signalWorkspaceProjectLoaded(st);
  return st.gatePromise.then(() => true);
});

ipcMain.on('xleth:boot:mounted', (event) => {
  const st = workspaceBoot;
  if (!st || !isWorkspaceSender(event)) return;
  st.mounted = true;
  advanceWorkspaceBoot();
});

// Resolves when the engine has had no call in flight for `settleMs` — i.e.
// the renderer's start-up queries (tracks, clips, chains, …) have been
// answered — or after `capMs` regardless. Polling calls resolve in well under
// a millisecond, so they do not hold this open.
function whenEngineQuiet({ settleMs = 60, capMs = 900 } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    let quietSince = 0;
    const tick = () => {
      const now = Date.now();
      if (workerBridge.getPendingCount() === 0) {
        if (!quietSince) quietSince = now;
        if (now - quietSince >= settleMs) { resolve(now - start); return; }
      } else {
        quietSince = 0;
      }
      if (now - start >= capMs) { resolve(now - start); return; }
      setTimeout(tick, 15);
    };
    tick();
  });
}

// Moves the workspace boot along whenever one of its inputs changes. Safe to
// call at any time, any number of times.
function advanceWorkspaceBoot() {
  const st = workspaceBoot;
  if (!st || !win || win.isDestroyed() || !st.gateOpen) return;

  // Never leave the user without a window: if the renderer has not reported a
  // mount, carry on without it. A bundle that never asked for the gate is not
  // going to report one, so it gets a short wait; a current one a long one.
  if (st.finishedLoad && !st.mounted && !st.fallback && !st.fallbackTimer) {
    st.fallbackTimer = setTimeout(() => {
      st.fallbackTimer = null;
      if (workspaceBoot !== st || st.mounted) return;
      st.fallback = true;
      log(`[Boot] workspace renderer reported no mount (${st.gateAware ? 'timeout' : 'pre-gate bundle'}) — continuing without it`);
      advanceWorkspaceBoot();
    }, st.gateAware ? 3000 : 400);
  }

  const settled = st.mounted || st.fallback;
  // Normally sent already, ahead of the gate. This is the pre-gate bundle's
  // turn (it never asked): its page has loaded, so its listeners exist.
  if (st.finishedLoad && settled) signalWorkspaceProjectLoaded(st);
  if (st.revealRequested && !st.revealed && settled) {
    st.revealed = true;
    if (st.fallbackTimer) { clearTimeout(st.fallbackTimer); st.fallbackTimer = null; }
    revealWorkspace(st);
  }
}

async function revealWorkspace(st) {
  const waited = await whenEngineQuiet();
  const show = () => {
    if (workspaceBoot !== st || !win || win.isDestroyed()) return;
    win.show();
    log(`[Boot] workspace shown ${Date.now() - st.createdAt}ms after its window was created (hydration settled in ${waited}ms)`);
  };
  if (st.handleSplash) {
    splashStatus('Ready.', 100);
    finishSplash(show);
  } else {
    show();
  }
}

// Creates the workspace window hidden, gate closed, ahead of a project load
// that is starting now. openWorkspaceWindow() adopts it once the project is in.
function prewarmWorkspaceWindow() {
  if (win && !win.isDestroyed()) return;
  if (getAddonError()) return;
  createWindow(newWorkspaceBootState(false));
  log('[Boot] workspace window booting (hidden) alongside the project load');
}

// Throws away a pre-warmed window whose project never arrived (load failed,
// Welcome closed mid-load, engine died). Only ever touches a still-gated,
// never-shown window.
function discardPrewarmedWorkspace(reason) {
  const st = workspaceBoot;
  if (!st || st.gateOpen || !win || win.isDestroyed()) return false;
  log(`[Boot] discarding the pre-warmed workspace window (${reason})`);
  if (st.fallbackTimer) clearTimeout(st.fallbackTimer);
  workspaceBoot = null;
  const w = win;
  win = null;
  w.destroy();
  return true;
}

// xleth:project:load arriving from the Welcome window is the start of the
// Welcome → workspace hand-off: put the splash up and start the workspace
// window now, while the engine loads. (The same channel from an already open
// workspace is an in-app load and needs none of this.)
function onIpcProjectLoadStart(event) {
  const welcomeWin = welcomeHandlers.getWelcomeWindow();
  if (!welcomeWin || welcomeWin.isDestroyed() || event.sender !== welcomeWin.webContents) return;
  welcomeLoadInFlight = true;
  showSplashWindow();
  splashStatus('Loading project…', 30);
  prewarmWorkspaceWindow();
}

function onIpcProjectLoadEnd(event, ok) {
  if (!welcomeLoadInFlight) return;
  welcomeLoadInFlight = false;
  if (ok) return;   // Welcome reports projectReady next → launchWorkspace()
  // Back to Welcome, which shows the error.
  discardPrewarmedWorkspace('project load failed');
  finishSplash();
}

function createWindow(bootState) {
  workspaceBoot = bootState || newWorkspaceBootState(true);
  const boot = workspaceBoot;
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    // Opaque (Phase 7): the workspace backdrop modes needed a transparent window; with them
    // gone the window is a plain one on the neutral ground (--theme-ui-g0 of the default theme).
    backgroundColor: '#0F0F0F',
    frame: false,
    show: false,
    transparent: false,
    webPreferences: {
      // contextIsolation disabled so preload can hand the renderer live
      // references — the shm_helper handle and the frame buffers it fills.
      // With isolation on, contextBridge would structured-clone every frame.
      // (The mapping itself is never exposed to JS; V8's renderer sandbox
      // forbids external ArrayBuffers — see the note in preload.js.)
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      preload: runtimeResource('app', 'preload.js'),
    },
  });

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

  // The workspace window never exists before its project is loaded (Welcome's
  // project.load / the auto-boot path both run first) — so the ONE broadcast
  // electron-main/project.js sends for that load fires to a webContents list
  // that doesn't include this window yet, and effectChainStore's
  // onProjectLoaded listener (which is the only thing that hydrates FX Graph
  // state) never sees it. Re-signal once this window's own renderer bundle
  // has finished evaluating (its listener registers at module scope, before
  // did-finish-load), so every fresh workspace window gets its own delivery
  // regardless of how the project already loaded. In-app project switches are
  // unaffected — this window already exists then, so project.js's own
  // broadcast reaches it directly.
  //
  // With the boot gate (see "Workspace window boot") the page can finish
  // loading BEFORE its project has, so the signal is no longer tied to
  // did-finish-load: it is sent once the project is in, just ahead of the
  // renderer's mount — still exactly once per window.
  const thisWin = win;
  if (!addonError) {
    win.webContents.once('did-finish-load', () => {
      if (thisWin.isDestroyed()) return;
      restoreUiScale(thisWin);
      boot.finishedLoad = true;
      advanceWorkspaceBoot();
    });
  }

  // Renderer console → the in-memory session buffer, which Settings →
  // Application → Logs exports and which auto-export writes out on quit or
  // crash. This is always on: capture costs one array push per line, unlike
  // the startup.log pipe below, so the chatty-component problem that gates
  // that pipe does not apply here.
  consoleLog.attachToWebContents(win.webContents, 'renderer');

  // Pipe renderer console output to startup.log so we can read it externally.
  // Gated behind a debug flag — chatty timeline components (selectTool logs on
  // drag start, every commit, every rubber-band) fire a log line, and hence a
  // disk write, per interaction event otherwise. Set XLETH_LOG_RENDERER_CONSOLE=1
  // to re-enable while debugging a renderer-side issue.
  if (process.env.XLETH_LOG_RENDERER_CONSOLE === '1') {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      const prefix = level === 3 ? '[RENDERER ERROR]' : level === 2 ? '[RENDERER WARN]' : '[RENDERER]';
      log(`${prefix} ${message}  (${source}:${line})`);
    });
  }

  win.on('closed', () => {
    if (boot.fallbackTimer) { clearTimeout(boot.fallbackTimer); boot.fallbackTimer = null; }
    // A discarded pre-warmed window closes after `win` has already moved on
    // (to null, or to its replacement) — only the current window's closing
    // tears the session's child windows down.
    if (win !== thisWin && win !== null) return;
    for (const [, child] of nodeEditorWindows) {
      if (!child.isDestroyed()) child.close();
    }
    nodeEditorWindows.clear();
    if (workspaceBoot === boot) workspaceBoot = null;
    win = null;
  });
}

// ── Welcome screen (mandatory startup gate) ──────────────────────────────────
// Decides what app.whenReady() shows once the engine has booted: either the
// most recent valid project (auto-boot, only when "show Welcome on startup"
// is off AND a valid recent exists) or the mandatory Welcome window. The gate
// is never bypassed, only shortened — no valid recent always falls through
// to Welcome regardless of the setting.
function decideBootTarget() {
  const settings = loadSettings();
  const showWelcomeOnStartup = settings.showWelcomeOnStartup !== false; // default true
  if (!showWelcomeOnStartup) {
    const recent = recentProjects.firstValidRecent();
    if (recent) return { mode: 'workspace', dir: recent.dir, name: recent.name };
  }
  return { mode: 'welcome' };
}

// Shows the real workspace window for a project that has JUST finished
// loading, and performs the one-time per-window setup (HWND handoff to the
// engine, update check). Adopts the window pre-warmed alongside the load when
// there is one (its renderer is already evaluated and waiting at the boot
// gate); otherwise creates it now. Either way the window appears only once
// its renderer has mounted and hydrated — see "Workspace window boot".
// handleSplash: the splash is up and should be closed as the window appears.
function openWorkspaceWindow({ handleSplash }) {
  workspaceLaunchRequested = true;
  const prewarmed = !!(win && !win.isDestroyed() && workspaceBoot && !workspaceBoot.gateOpen);
  if (!prewarmed) createWindow(newWorkspaceBootState(true));
  const st = workspaceBoot;
  if (win && st) {
    st.handleSplash = !!handleSplash;
    if (getAddonError()) {
      // The engine-error page: no renderer bundle, so no mount report. Show
      // it on first paint, as before.
      const errorWin = win;
      errorWin.once('ready-to-show', () => {
        if (errorWin.isDestroyed()) return;
        if (st.handleSplash) finishSplash(() => { if (!errorWin.isDestroyed()) errorWin.show(); });
        else errorWin.show();
      });
    } else {
      st.revealRequested = true;
      if (!st.gateOpen) {
        st.gateOpen = true;
        // Signal first, then let it mount (same tick, so in that order on the
        // wire). A renderer that has not asked for the gate yet is signalled
        // when it does — see xleth:boot:whenProjectReady.
        if (st.gateAware) signalWorkspaceProjectLoaded(st);
        st.openGate();
      }
      advanceWorkspaceBoot();
    }
  }

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
}

// Welcome's onProjectReady callback (project already created/loaded and
// touched into recents by the time this fires — see welcome.js). Splash was
// already closed once when Welcome itself appeared, so it's re-shown here
// for the Welcome → workspace handoff (this used to be a silent gap: Welcome
// closes, then nothing visible until the workspace window's first paint).
function launchWorkspace(dir, name) {
  // Synchronous on purpose: welcome.js calls this and THEN closes Welcome,
  // whose 'closed' handler reads workspaceLaunchRequested (set in
  // openWorkspaceWindow) to know this is not a quit.
  showSplashWindow();   // usually already up since the load started
  splashStatus(name ? `Opening “${name}”…` : 'Opening project…', 70);
  openWorkspaceWindow({ handleSplash: true });
}

// Wraps an in-app project switch (New Project / Open Project triggered from
// inside an already-open workspace) with the same splash treatment used at
// boot: show the splash, hide the workspace window (not destroy it — its
// native HWND is what VST editor windows are parented to, and destroying/
// recreating it would orphan any open plugin editors), do the engine work,
// then reveal the workspace again. `work` is loadProject(dir) or
// newBlankProject() from electron-main/project.js.
async function switchProjectWindow(message, work) {
  // The engine work starts immediately; the splash comes up alongside it and
  // the workspace is hidden only once the splash is actually covering for it
  // (never a moment with nothing on screen). A switch that finishes before the
  // splash has painted skips it entirely.
  const wasVisible = !!(win && !win.isDestroyed() && win.isVisible());
  let finished = false;
  let hidden = false;
  showSplashWindow().then((shown) => {
    if (finished || !shown || !win || win.isDestroyed()) return;
    win.hide();
    hidden = true;
  });
  splashStatus(message, 25);

  const reveal = () => {
    finished = true;
    finishSplash(() => {
      if (hidden && wasVisible && win && !win.isDestroyed()) win.show();
    });
  };

  try {
    const result = await work();
    splashStatus('Ready.', 100);
    // The broadcast in work() has the renderer re-reading the whole project;
    // bring the window back once those queries have been answered.
    await whenEngineQuiet();
    reveal();
    return result;
  } catch (e) {
    splashStatus('Failed: ' + e.message, 100);
    finished = true;
    setTimeout(reveal, 900); // linger so the failure message is readable
    throw e;
  }
}

ipcMain.handle('xleth:project:switchToNew', safeHandler(() =>
  switchProjectWindow('Starting new project…', () => projectHandlers.newBlankProject())));

ipcMain.handle('xleth:project:switchToLoad', safeHandler((_event, dir) =>
  switchProjectWindow('Loading project…', () => projectHandlers.loadProject(dir))));

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

// Serialises ensureFrameShm. The cache test below is a check-then-act across an
// await, and callers genuinely do overlap: React.StrictMode double-invokes
// VideoPreview's mount effect, so two restorePreviewSettings() runs race and
// every preview RPC arrives twice. Both could miss the cache and both fire
// initVideoSharedMemory, which on the engine side stops the video thread,
// reframes the mapping, then restarts it — and
// stopVideoThread/startVideoThread are not reentrant. Chaining each call onto
// the previous one means the second caller re-tests the cache only after the
// first has published its result, so a same-size request collapses to one RPC
// and a genuine resize never overlaps another.
let frameShmQueue = Promise.resolve();

function ensureFrameShm(width, height) {
  const run = frameShmQueue.then(async () => {
    if (frameShmMeta && frameShmMeta.width === width && frameShmMeta.height === height) {
      return frameShmMeta;
    }
    // Capacity is the section size; width/height only move the live frame
    // inside it. Math.max guards a caller asking for more than base scale.
    const capW = Math.max(width, FRAME_SHM_BASE_W);
    const capH = Math.max(height, FRAME_SHM_BASE_H);
    const res = await callWorker('initVideoSharedMemory', [FRAME_SHM_NAME, width, height, capW, capH]);
    frameShmMeta = {
      name:        res.name,
      width:       res.width,
      height:      res.height,
      bufferSize:  res.bufferSize,
      indexOffset: res.indexOffset,
      totalSize:   res.totalSize,
      capacityBufferSize: res.capacityBufferSize,
    };
    log(`[IPC] ← shm ready: ${JSON.stringify(frameShmMeta)}`);
    return frameShmMeta;
  });
  // Swallow rejections on the queue only — `run` still rejects for the caller.
  // Without this a single failed resize would wedge every later call.
  frameShmQueue = run.catch(() => {});
  return run;
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
ipcMain.handle('xleth:settings:get',    (_, key) => loadSettings()[key])
ipcMain.handle('xleth:settings:set',    (_, key, value) => {
  const s = loadSettings()
  s[key] = value; saveSettings(s)
})

// -- Custom file picker filesystem bridge ------------------------------------

const FILE_PICKER_FAVORITES_KEY = 'filePickerFavorites'
const FILE_PICKER_MEDIA_EXTENSIONS = new Set([
  '.wav', '.mp3', '.flac', '.ogg', '.aac', '.m4a',
  '.mp4', '.avi', '.mov', '.mkv', '.webm', '.wmv',
  '.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif',
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
// Dialog: pick a .cube LUT for a Color Grade (the renderer hands the path to
// colorGrade.checkLut before using it).
ipcMain.handle('xleth:dialog:openLut', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import LUT',
    filters: [{ name: '3D LUT', extensions: ['cube'] }],
    properties: ['openFile'],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

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
  safeHandler((_, regionId, startTime, endTime, targetPixels, channel, slotIndex = 0) =>
    callWorker('waveform_getRegionPeaks', [regionId, startTime, endTime, targetPixels, channel, slotIndex])));

ipcMain.handle('xleth:waveform:getRawSamples',
  safeHandler((_, regionId, startSample, endSample, channel, slotIndex = 0) =>
    callWorker('waveform_getRawSamples', [regionId, startSample, endSample, channel, slotIndex])));

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

ipcMain.handle('xleth:midi:getReimportTargets', () =>
    callWorker('midi_getReimportTargets', []));

ipcMain.handle('xleth:midi:executeImport', (_, noteData, optionsJson) =>
    // preload.js guarantees noteData is a Buffer; the pipe client base64-encodes it.
    callWorker('midi_executeImport', [noteData, optionsJson]));

// FL Studio project import: the .flp is converted to a temp MIDI file here in
// main (pure JS, electron-main/flp-import.js); the dialog then runs the normal
// midi.* pipeline on that path.
ipcMain.handle('xleth:flp:convert', (_, filePath, options) => {
  const result = require('./electron-main/flp-import.js').convertFlpFile(filePath, options || {});
  log(`[FlpImport] ${filePath} → ${result.ok ? result.midiPath : 'FAILED: ' + result.reason}` +
      (result.info ? ` (arrangement ${result.info.arrangementIndex}, ${result.info.tracks.length} tracks)` : ''));
  return result;
});

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
      { name: 'MIDI and FL Studio projects', extensions: ['mid', 'midi', 'flp'] },
      { name: 'MIDI Files', extensions: ['mid', 'midi'] },
      { name: 'FL Studio projects', extensions: ['flp'] },
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
      { name: 'All Supported', extensions: ['mp4', 'avi', 'mov', 'mkv', 'wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a', 'png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif'] },
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
      { name: 'All Supported', extensions: ['mp4', 'avi', 'mov', 'mkv', 'wav', 'mp3', 'flac', 'ogg', 'aac', 'm4a', 'png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif'] },
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
  function tryFfmpeg(args, outFile, minBytes = 1024) {
    return new Promise(resolve => {
      execFile(ffmpegExecutable(), args, { timeout: 20000 }, err => {
        if (err) return resolve(null);
        try {
          const data = fs.readFileSync(outFile);
          try { fs.unlinkSync(outFile); } catch {}
          resolve(data.length > minBytes ? data : null);
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

  // Still images (incl. generated solids/gradients) are one frame, shorter than
  // the seek below, and a flat colour encodes under the 1 KB bar: take frame 0.
  if (/\.(jpe?g|bmp|webp)$/i.test(filePath)) {
    const stillOut = base + '_still.jpg';
    const stillData = await tryFfmpeg(['-y', '-i', filePath, '-vframes', '1', '-vf', 'scale=320:-2', '-q:v', '4', stillOut], stillOut, 0);
    if (stillData) return 'data:image/jpeg;base64,' + stillData.toString('base64');
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
// Read synchronously by preload so media URLs can be built synchronously.
ipcMain.on('xleth:getMediaTokenSync', (event) => { event.returnValue = getMediaToken(); });

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
// The Settings control sets an absolute value; getZoom lets it open at the live one.
ipcMain.on('xleth:window:setZoom', (event, factor) => {
  const nextFactor = setWindowZoom(getTargetWindow(event), Number(factor));
  log(`[IPC] window:setZoom -> ${nextFactor}`);
});
ipcMain.handle('xleth:window:getZoom', (event) => {
  const wc = getTargetWindow(event)?.webContents;
  return wc && !wc.isDestroyed() ? wc.getZoomFactor() : DEFAULT_ZOOM_FACTOR;
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
    icon: path.join(__dirname, 'assets', 'icon.ico'),
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
  const bootStart = Date.now();
  log('app ready — loading addon...');

  // COOP/COEP — required so the renderer's `crossOriginIsolated` flag is
  // true, which is a prerequisite for `SharedArrayBuffer` in Chromium.
  // Installed before any window exists so every page load goes through it.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    responseHeaders['Cross-Origin-Opener-Policy']   = ['same-origin'];
    responseHeaders['Cross-Origin-Embedder-Policy'] = ['require-corp'];
    callback({ responseHeaders });
  });

  registerMediaProtocol();
  startMediaServer();

  // ── Start-up runs three things side by side ───────────────────────────────
  // The splash, the engine, and the first real window (Welcome, or the
  // workspace on the auto-boot path) do not depend on one another to START,
  // only to FINISH — so none of them waits for another before beginning.
  // The splash is not awaited: a status sent before its page exists is
  // replayed when it appears (splashStatus).
  showSplashWindow();

  // Settings + recents are plain files; no engine needed to decide.
  const bootTarget = decideBootTarget();

  // Welcome is shown once BOTH its page has painted and the engine is up (its
  // buttons all go through the engine). Whichever finishes last calls this.
  let engineBootDone = false;
  let welcomePainted = null;   // the Welcome window, once ready-to-show
  let welcomeShown = false;
  const maybeShowWelcome = () => {
    if (welcomeShown || !engineBootDone || !welcomePainted) return;
    welcomeShown = true;
    const w = welcomePainted;
    splashStatus('Ready.', 100);
    finishSplash(() => {
      if (w.isDestroyed()) return;
      w.show();
      log(`[Boot] Welcome shown ${Date.now() - bootStart}ms after app ready`);
    });
  };
  const openWelcome = () => {
    welcomeHandlers.createWelcomeWindow({
      onReadyToShow: (welcomeWin) => { welcomePainted = welcomeWin; maybeShowWelcome(); },
      onClosed: () => {
        if (workspaceLaunchRequested) return;   // closed because a project was opened
        // Closed without a project having been created/opened (the × button,
        // Alt+F4, taskbar close — see welcome-preload.js/welcome.html). The
        // mandatory gate: there is no path to the workspace without a
        // project file, so XLETH quits. Windows-only, so window-all-closed
        // (below) does that — once nothing else is open: a workspace window
        // pre-warmed for a load still in flight, and the splash over it,
        // would otherwise keep the app alive with no visible window.
        log('[Welcome] closed without a project — quitting (mandatory gate)');
        discardPrewarmedWorkspace('Welcome closed');
        finishSplash();
      },
    });
  };

  if (bootTarget.mode === 'welcome') openWelcome();
  else prewarmWorkspaceWindow();   // auto-boot: its renderer boots during engine init + project load

  try {
    splashStatus('Loading audio engine…', 15); // engine fork about to spawn
    await startWorker();
    splashStatus('Connecting to engine bridge…', 35); // engine fork is up, bridge IPC ready

    await callWorker('initialize');
    log('initialize() OK');
    await applyEngineDefaults();
    startEngineBackgroundTasks();
    splashStatus('Starting compositor…', 65);

    // Swap the engine's owned FrameOutput buffer for a Windows named file
    // mapping so the renderer can read frames zero-copy via shm_helper.
    // 960x540 matches CANVAS_W/H in the addon's default initialize().
    try {
      await ensureFrameShm(960, 540);
    } catch (e) {
      log(`shm init FAILED: ${e.message}`);
    }
    splashStatus('Finalizing startup…', 85);

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
    discardPrewarmedWorkspace('engine init failed');
    if (splashWin && !splashWin.isDestroyed()) splashWin.close();
  }
  engineBootDone = true;
  log(`[Boot] engine ready ${Date.now() - bootStart}ms after app ready`);

  // ── Mandatory Welcome gate ───────────────────────────────────────────────
  // No path to the workspace exists without a project file on disk. Auto-boot
  // straight into the workspace only when "show Welcome on startup" is off
  // AND a valid recent project exists; otherwise Welcome always shows first —
  // the gate is shortened, never bypassed.
  if (bootTarget.mode === 'workspace') {
    try {
      splashStatus(bootTarget.name ? `Opening “${bootTarget.name}”…` : 'Opening project…', 90);
      const loaded = await callWorker('project_load', [bootTarget.dir]);
      if (!loaded) throw new Error('project_load returned false');
      recentProjects.touchRecent({ name: bootTarget.name, dir: bootTarget.dir });
    } catch (e) {
      log(`[Boot] Auto-load of last project failed, falling back to Welcome: ${e.message}`);
      bootTarget.mode = 'welcome';
      discardPrewarmedWorkspace('auto-load failed');
      openWelcome();
    }
  }

  if (bootTarget.mode === 'workspace') {
    openWorkspaceWindow({ handleSplash: true });
  } else {
    maybeShowWelcome();
  }
  // ──────────────────────────────────────────────────────────────────────────
});

// Serve local media files via xleth-media:// protocol so the renderer can load
// audio/video without file:// CORS/CSP issues when running from localhost:5173.
// Called once from app.whenReady(), before any window is created.
function registerMediaProtocol() {
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
}

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

process.on('uncaughtException', (e) => {
  log(`uncaughtException: ${e.message}\n${e.stack}`);
});
