'use strict';

// ── Phase 1 handlers — Transport extensions ───────────────────────────────────────
// Extracted from ui/main.js (S5 Stage 3 decomposition). Phase 0 transport
// (play/pause/stop/transportState) stays in main.js; this holds the Phase 1
// extensions. Wrapped in main.js's safeHandler, so registration happens
// inside init().

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');

function init(deps) {
  const { safeHandler } = deps;

  ipcMain.handle('xleth:transport:seek',
    safeHandler((_, beatPos) => callWorker('transport_seek', [beatPos])));
}

module.exports = { init };
