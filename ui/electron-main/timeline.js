'use strict';

// ── Timeline handlers NOT in the RPC manifest ─────────────────────────────────
// The timeline query surface and all single-entity pass-through mutations are now
// registered by rpc-registry.js from ui/rpc-manifest.js (AUDIT.md S1). Only the
// handlers below remain hand-written, each evaluated and deliberately EXCLUDED
// from the manifest (so the next migration pass need not re-evaluate them):
//
//   • addClipsBatch / spliceClipsAtPlayhead — batch / multi-entry operations.
//     Excluded per the "no batching logic" rule even though their bodies are
//     pure forwards (see docs/rpc-manifest.md).
//   • autoTrimClip — NOT a pure pass-through: its preload wrapper supplies a
//     default arg (thresholdDb = -54). The generic manifest wrapper is a bare
//     (...args) forward and would drop that default, changing behavior when
//     called with one argument.
//
// Region/syllable, pattern/note and grid handlers live in their own modules and
// belong to later migration slices. Registration happens inside init() because
// the handlers wrap main.js's safeHandler.

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');

function init(deps) {
  const { safeHandler } = deps;

  ipcMain.handle('xleth:timeline:addClipsBatch',
    safeHandler((_, clips) => callWorker('timeline_addClipsBatch', [clips])));

  ipcMain.handle('xleth:timeline:autoTrimClip',
    safeHandler((_, id, thresholdDb) => callWorker('timeline_autoTrimClip', [id, thresholdDb])));

  ipcMain.handle('xleth:timeline:spliceClipsAtPlayhead',
    safeHandler((_, entries) => callWorker('timeline_spliceClipsAtPlayhead', [entries])));
}

module.exports = { init };
