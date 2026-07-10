'use strict';

// ── Phase 0 handlers (backward compat) ───────────────────────────────────────
// Extracted from ui/main.js (S5 Stage 5 decomposition). The original flat
// Only xleth:trigger remains here. Its velocity default is handler-specific;
// the other Phase 0 pass-through channels are registered from rpc-manifest.js.

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');

function init(deps) {
  const { safeHandler } = deps;
  // Keep this hand-written: absent velocity must become 1.0 before forwarding.
  ipcMain.handle('xleth:trigger',    safeHandler((_, id, vel) => callWorker('triggerSample', [id, vel ?? 1.0])));
}

module.exports = { init };
