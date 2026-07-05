'use strict';

// ── Phase 1 handlers — Audio ─────────────────────────────────────────────────
// Extracted from ui/main.js (S5 Stage 4 decomposition). Sample loading, mixer
// controls (track volume/pan/spread, master volume), peak meters, realtime
// diagnostics + audio performance telemetry, and output-device selection.
// Wrapped in main.js's safeHandler, so registration happens inside init().

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');
const { userDataPath } = require('../runtimePaths');

function init(deps) {
  const { safeHandler } = deps;

  ipcMain.handle('xleth:audio:loadSample',
    safeHandler((_, filePath) => callWorker('loadSample', [filePath])));

  ipcMain.handle('xleth:audio:mapRegionToSample',
    safeHandler((_, regionId, sampleId) => callWorker('audio_mapRegionToSample', [regionId, sampleId])));

  ipcMain.handle('xleth:audio:loadSourceRegion',
    safeHandler((_, filePath, startTime, endTime) => callWorker('audio_loadSourceRegion', [filePath, startTime, endTime])));

  ipcMain.handle('xleth:audio:getMasterPeak',
    safeHandler(() => callWorker('audio_getMasterPeak')));

  ipcMain.handle('xleth:audio:getTrackPeak',
    safeHandler((_, trackId) => callWorker('audio_getTrackPeak', [trackId])));

  ipcMain.handle('xleth:audio:getAllPeaks',
    safeHandler(() => callWorker('audio_getAllPeaks')));

  ipcMain.handle('xleth:audio:setRealtimeDiagnosticsEnabled',
    safeHandler((_, enabled) => callWorker('audio_setRealtimeDiagnosticsEnabled', [Boolean(enabled)])));

  ipcMain.handle('xleth:audio:resetRealtimeDiagnostics',
    safeHandler(() => callWorker('audio_resetRealtimeDiagnostics')));

  ipcMain.handle('xleth:audio:getRealtimeDiagnostics',
    safeHandler(() => callWorker('audio_getRealtimeDiagnostics')));

  ipcMain.handle('xleth:audio:getAudioPerformanceTelemetry',
    safeHandler(() => callWorker('audio_getAudioPerformanceTelemetry')));

  ipcMain.handle('xleth:audio:captureAudioPerformanceReport',
    safeHandler((_, options = {}) => {
      const reportOptions = {
        ...(options && typeof options === 'object' ? options : {}),
        outputDir: options?.outputDir || userDataPath('diagnostics', 'audio-performance'),
      };
      return callWorker('audio_captureAudioPerformanceReport', [reportOptions]);
    }));

  ipcMain.handle('xleth:audio:setTrackVolume',
    safeHandler((_, trackId, vol) => callWorker('audio_setTrackVolume', [trackId, vol])));

  ipcMain.handle('xleth:audio:setTrackPan',
    safeHandler((_, trackId, pan) => callWorker('audio_setTrackPan', [trackId, pan])));

  ipcMain.handle('xleth:audio:setTrackSpread',
    safeHandler((_, trackId, spread) => callWorker('audio_setTrackSpread', [trackId, spread])));

  ipcMain.handle('xleth:audio:setMasterVolume',
    safeHandler((_, vol) => callWorker('audio_setMasterVolume', [vol])));

  ipcMain.handle('xleth:audio:getOutputDevices',
    safeHandler(() => callWorker('audio_getOutputDevices')));
  ipcMain.handle('xleth:audio:getCurrentOutputDevice',
    safeHandler(() => callWorker('audio_getCurrentOutputDevice')));
  ipcMain.handle('xleth:audio:setOutputDevice',
    safeHandler((_, name) => callWorker('audio_setOutputDevice', [name])));
}

module.exports = { init };
