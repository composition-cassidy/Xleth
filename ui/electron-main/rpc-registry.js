'use strict';

// ── Manifest-driven IPC handlers (AUDIT.md S1) ───────────────────────────────
// Registers one ipcMain.handle per channel listed in ui/rpc-manifest.js, each a
// pure pass-through to the engine worker: (…args) → callWorker(method, args).
// Methods needing per-call main-process logic (arg fixups, dialogs, intervals)
// stay in their hand-written domain modules — see docs/rpc-manifest.md.
//
// Like the other handler modules, registration happens inside init() because
// the handlers wrap main.js's safeHandler. ipcMain.handle throws on double
// registration, so a channel accidentally present both here (via the manifest)
// and in a hand-written module fails loudly at boot.

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');
const { METHODS, validateManifest } = require('../rpc-manifest');

function init(deps) {
  const { safeHandler } = deps;
  validateManifest();
  for (const m of METHODS) {
    for (const channel of m.channels) {
      ipcMain.handle(channel,
        safeHandler((_evt, ...args) => callWorker(m.method, args)));
    }
  }
}

module.exports = { init };
