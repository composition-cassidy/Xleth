'use strict';

// ── Phase 0 handlers (backward compat) ───────────────────────────────────────
// Extracted from ui/main.js (S5 Stage 5 decomposition). The original flat
// transport / frame / sync IPC channels (xleth:play/stop/pause/trigger/
// transportState/currentFrame/frameRGBA/syncStats/setVideoResolution +
// proxy:getStatus) that predate the Phase-1 domain channel scheme. Still
// load-bearing: preload.js routes BOTH its legacy flat API AND its namespaced
// transport/video/sync/proxy/sampler wrappers through these exact names, so they
// cannot be retired until preload stops invoking them. Registration happens
// inside init() since the handlers wrap main.js's safeHandler.

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');

function init(deps) {
  const { safeHandler } = deps;
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

}

module.exports = { init };
