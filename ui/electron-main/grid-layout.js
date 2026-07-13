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

  ipcMain.handle('xleth:timeline:createSnapshot',
    safeHandler((_, name) => callWorker('timeline_createSnapshot', [name])));

  ipcMain.handle('xleth:timeline:duplicateSnapshot',
    safeHandler((_, name) => callWorker('timeline_duplicateSnapshot', [name])));

  ipcMain.handle('xleth:timeline:deleteSnapshot',
    safeHandler((_, id) => callWorker('timeline_deleteSnapshot', [id])));

  ipcMain.handle('xleth:timeline:renameSnapshot',
    safeHandler((_, id, name) => callWorker('timeline_renameSnapshot', [id, name])));

  ipcMain.handle('xleth:timeline:setActiveSnapshot',
    safeHandler((_, id) => callWorker('timeline_setActiveSnapshot', [id])));

  ipcMain.handle('xleth:timeline:listSnapshots',
    safeHandler(() => callWorker('timeline_listSnapshots')));

  // ── Grid cues (time-based snapshot resolution) ─────────────────────────────
  // Pure pass-through to the engine cue API; tick values are integer ticks
  // (same convention as clip position/duration). moveCue/removeCue resolve to
  // the engine bool (false = no cue at that tick), addCue → the updated cue list.
  ipcMain.handle('xleth:timeline:addCue',
    safeHandler((_, tick, snapshotId) => callWorker('timeline_addCue', [tick, snapshotId])));

  ipcMain.handle('xleth:timeline:moveCue',
    safeHandler((_, oldTick, newTick) => callWorker('timeline_moveCue', [oldTick, newTick])));

  ipcMain.handle('xleth:timeline:removeCue',
    safeHandler((_, tick) => callWorker('timeline_removeCue', [tick])));

  ipcMain.handle('xleth:timeline:listCues',
    safeHandler(() => callWorker('timeline_listCues')));

  // Set a cue's boundary animation (offsets in ticks). transition is
  // { enabled, startOffsetTicks, endOffsetTicks, type, freezeOutgoing, geomAngleDeg };
  // enabled=false is a hard cut. Returns the updated cue list.
  ipcMain.handle('xleth:timeline:setCueTransition',
    safeHandler((_, tick, transition) => callWorker('timeline_setCueTransition', [tick, transition])));

  ipcMain.handle('xleth:timeline:getDefaultSnapshot',
    safeHandler(() => callWorker('timeline_getDefaultSnapshot')));

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
