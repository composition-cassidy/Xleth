'use strict';

// ── Phase 7 — Preview visibility (panel show/hide) ───────────────────────────
// Extracted from ui/main.js (S5 Stage 5 decomposition). Toggles the engine's
// live-preview rendering when the preview panel is shown/hidden.

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');

function init(deps) {
  const { safeHandler } = deps;
  ipcMain.handle('xleth:preview:setEnabled',
    safeHandler((_, enabled) => callWorker('preview_setEnabled', [Boolean(enabled)])));

}

module.exports = { init };
