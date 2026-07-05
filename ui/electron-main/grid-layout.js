'use strict';

// ── Grid Layout ─────────────────────────────────────────────────────────────
// Extracted from ui/main.js (S5 Stage 2 decomposition). Pure pass-through
// handlers to the engine worker — grid layout lives in the engine timeline,
// not in a file on the Electron side. Unlike the file-backed stores in this
// directory, registration happens inside init(): the handlers are wrapped in
// main.js's safeHandler at registration time, so it must be injected first.

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');

function init(deps) {
  const { safeHandler } = deps;

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

  ipcMain.handle('xleth:timeline:setFullscreenLayers',
    safeHandler((_, layers) => callWorker('timeline_setFullscreenLayers', [layers])));

  ipcMain.handle('xleth:timeline:setPreviewFps',
    safeHandler((_, fps) => callWorker('timeline_setPreviewFps', [fps])));
}

module.exports = { init };
