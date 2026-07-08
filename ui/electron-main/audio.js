'use strict';

// ── Phase 1 handlers — Audio ─────────────────────────────────────────────────
// Extracted from ui/main.js (S5 Stage 4 decomposition). Most audio pass-throughs
// (sample loading, region->sample mapping, peak meters, realtime-diagnostics
// reset/get, performance telemetry, mixer volume/pan/spread + master volume, and
// output-device get/set) now come from the RPC manifest (ui/rpc-manifest.js,
// AUDIT.md S1 slice 5) via ui/electron-main/rpc-registry.js. Only the two
// handlers below stay hand-written — each carries per-call main-process logic:
//   • setRealtimeDiagnosticsEnabled — coerces its arg to a strict boolean.
//   • captureAudioPerformanceReport — injects a userDataPath outputDir default.
// Wrapped in main.js's safeHandler, so registration happens inside init().

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');
const { userDataPath } = require('../runtimePaths');

function init(deps) {
  const { safeHandler } = deps;

  ipcMain.handle('xleth:audio:setRealtimeDiagnosticsEnabled',
    safeHandler((_, enabled) => callWorker('audio_setRealtimeDiagnosticsEnabled', [Boolean(enabled)])));

  ipcMain.handle('xleth:audio:captureAudioPerformanceReport',
    safeHandler((_, options = {}) => {
      const reportOptions = {
        ...(options && typeof options === 'object' ? options : {}),
        outputDir: options?.outputDir || userDataPath('diagnostics', 'audio-performance'),
      };
      return callWorker('audio_captureAudioPerformanceReport', [reportOptions]);
    }));
}

module.exports = { init };
