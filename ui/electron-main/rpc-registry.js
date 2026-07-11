'use strict';

// ── Manifest-driven IPC handlers (AUDIT.md S1) ───────────────────────────────
// Registers one ipcMain.handle per channel listed in ui/rpc-manifest.js, each a
// pure pass-through to the engine worker: (…args) → callWorker(method, args).
// Entries carrying `graph: 'track' | 'master'` are graph mutations: they
// register through main.js's graphHandler (which broadcasts xleth:graph:changed
// after the call resolves) instead of plain safeHandler, keyed by the canonical
// trackKey / masterKey functions shared with effects.js / effects-graph.js.
// Methods needing per-call main-process logic (arg fixups, dialogs, intervals)
// stay in their hand-written domain modules — see docs/rpc-manifest.md.
//
// Like the other handler modules, registration happens inside init() because
// the handlers wrap main.js's safeHandler/graphHandler. ipcMain.handle throws
// on double registration, so a channel accidentally present both here (via the
// manifest) and in a hand-written module fails loudly at boot.

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');
const { METHODS, validateManifest } = require('../rpc-manifest');
const { trackKey, masterKey } = require('./effects');

// manifest `graph` value → key function graphHandler broadcasts with.
// validateManifest() rejects any value outside this table.
const GRAPH_KEYS = { track: trackKey, master: masterKey };

function init(deps) {
  const { safeHandler, graphHandler } = deps;
  validateManifest();
  for (const m of METHODS) {
    const wrap = m.graph
      ? (fn) => graphHandler(GRAPH_KEYS[m.graph], fn)
      : safeHandler;
    for (const channel of m.channels) {
      ipcMain.handle(channel,
        wrap((_evt, ...args) => callWorker(m.method, args)));
    }
  }
}

module.exports = { init };
