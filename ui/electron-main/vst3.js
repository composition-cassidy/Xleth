'use strict';

// ── VST3 plugin scanner + editor windows ─────────────────────────────────────
// Extracted from ui/main.js (S5 Stage 5 decomposition). Plugin scan/progress,
// editor-window open/close/query, missing/crashed-plugin recovery, and the
// add-VST3-search-path directory picker (parents to the main window via getWin).
// The plugin registry itself lives in the engine worker; these are pass-throughs.

const { ipcMain, dialog } = require('electron');
const { callWorker } = require('./worker');
let getWin = () => null;


function init(deps) {
  const { safeHandler } = deps;  if (deps && typeof deps.getWin === 'function') getWin = deps.getWin;

  // ── VST3 plugin scanner ───────────────────────────────────────────────────────

  ipcMain.handle('xleth:audio:scanPlugins',
    safeHandler((_, paths) => callWorker('audio_scanPlugins', paths && paths.length ? [paths] : [])));

  ipcMain.handle('xleth:audio:getScanProgress',
    safeHandler(() => callWorker('audio_getScanProgress', [])));

  ipcMain.handle('xleth:audio:getScannedPlugins',
    safeHandler(() => callWorker('audio_getScannedPlugins', [])));

  ipcMain.handle('xleth:audio:getFailedPlugins',
    safeHandler(() => callWorker('audio_getFailedPlugins', [])));

  // ── VST3 plugin editor windows ────────────────────────────────────────────────

  ipcMain.handle('xleth:audio:openPluginEditor',
    safeHandler((_, trackId, nodeId) => callWorker('audio_openPluginEditor', [trackId, nodeId])));

  ipcMain.handle('xleth:audio:closePluginEditor',
    safeHandler((_, trackId, nodeId) => callWorker('audio_closePluginEditor', [trackId, nodeId])));

  ipcMain.handle('xleth:audio:closeAllPluginEditors',
    safeHandler(() => callWorker('audio_closeAllPluginEditors', [])));

  ipcMain.handle('xleth:audio:isPluginEditorOpen',
    safeHandler((_, trackId, nodeId) => callWorker('audio_isPluginEditorOpen', [trackId, nodeId])));

  ipcMain.handle('xleth:audio:getMissingPlugins',
    safeHandler(() => callWorker('audio_getMissingPlugins', [])));

  ipcMain.handle('xleth:audio:retryMissingPlugin',
    safeHandler((_, trackId, nodeId) => callWorker('audio_retryMissingPlugin', [trackId, nodeId])));

  ipcMain.handle('xleth:audio:removeAllMissing',
    safeHandler(() => callWorker('audio_removeAllMissing', [])));

  ipcMain.handle('xleth:audio:resetCrashedPlugin',
    safeHandler((_, trackId, nodeId) => callWorker('audio_resetCrashedPlugin', [trackId, nodeId])));

  ipcMain.handle('xleth:dialog:addVstSearchPath', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWin(), {
      title: 'Add VST3 Search Path',
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths.length) return null;
    return filePaths[0];
  });

}

module.exports = { init };
