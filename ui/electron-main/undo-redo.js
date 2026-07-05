'use strict';

// ── Phase 1 handlers — Undo / Redo ────────────────────────────────────────────────
// Extracted from ui/main.js (S5 Stage 3 decomposition). Pure pass-throughs to
// the engine-side undo manager. Wrapped in main.js's safeHandler, so
// registration happens inside init().

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');

function init(deps) {
  const { safeHandler } = deps;

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
}

module.exports = { init };
