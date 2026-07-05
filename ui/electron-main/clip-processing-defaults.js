'use strict';

// ── Global clip-processing defaults ─────────────────────────────────────────
// Extracted from ui/main.js (S5 Stage 3 decomposition). Engine-level global
// stretch-method / formant-preserve defaults (xleth:engine:*) — the process-wide
// clip-processing defaults, distinct from the per-project timeline_set* pair in
// timeline.js. Wrapped in main.js's safeHandler, so registration happens
// inside init().

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');

function init(deps) {
  const { safeHandler } = deps;

  ipcMain.handle('xleth:engine:setGlobalStretchMethod',
    safeHandler((_, m) => callWorker('engine_setGlobalStretchMethod', [m])))
  ipcMain.handle('xleth:engine:getGlobalStretchMethod',
    safeHandler(() => callWorker('engine_getGlobalStretchMethod', [])))
  ipcMain.handle('xleth:engine:setGlobalFormantPreserve',
    safeHandler((_, v) => callWorker('engine_setGlobalFormantPreserve', [v])))
  ipcMain.handle('xleth:engine:getGlobalFormantPreserve',
    safeHandler(() => callWorker('engine_getGlobalFormantPreserve', [])))
}

module.exports = { init };
