'use strict';

// ── Pattern / region / note handlers (excluded from the RPC manifest) ────────
// Most of this file's timeline_* region / syllable / pattern / pattern-block /
// single-note pass-throughs — plus the read-only xleth:fsc:parse — migrated to
// the RPC manifest in AUDIT.md S1 slice 4 (ui/rpc-manifest.js registers them via
// ui/electron-main/rpc-registry.js). Only the handlers below stay hand-written,
// each deliberately EXCLUDED so the next migration pass need not re-evaluate them:
//
//   • moveNotesBatch / addNotesBatch / quantizeClipsBatch / resizeNotesBatch —
//     batch / multi-entry operations. Excluded per the timeline.js batch
//     precedent (addClipsBatch / spliceClipsAtPlayhead), even though their
//     bodies are pure forwards. See docs/rpc-manifest.md.
//   • previewNote — NOT a pure pass-through: its preload wrapper supplies a
//     default arg (velocity = 0.8). The generic manifest wrapper is a bare
//     (...args) forward and would drop that default, changing behavior when
//     called with two arguments. (previewNoteOff / previewAllNotesOff have no
//     such default and did migrate.)

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');

function init(deps) {
  const { safeHandler } = deps;

  ipcMain.handle('xleth:timeline:moveNotesBatch',
    safeHandler((_, patternId, moves) => callWorker('timeline_moveNotesBatch', [patternId, moves])));

  ipcMain.handle('xleth:timeline:addNotesBatch',
    safeHandler((_, patternId, notes) => callWorker('timeline_addNotesBatch', [patternId, notes])));

  ipcMain.handle('xleth:timeline:quantizeClipsBatch',
    safeHandler((_, specs) => callWorker('timeline_quantizeClipsBatch', [specs])));

  ipcMain.handle('xleth:timeline:resizeNotesBatch',
    safeHandler((_, patternId, resizes) => callWorker('timeline_resizeNotesBatch', [patternId, resizes])));

  ipcMain.handle('xleth:timeline:previewNote',
    safeHandler((_, patternId, pitch, velocity) => callWorker('timeline_previewNote', [patternId, pitch, velocity])));

}

module.exports = { init };
