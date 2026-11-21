'use strict';

// ── VST3 plugin scanner + editor windows ─────────────────────────────────────
// Extracted from ui/main.js (S5 Stage 5 decomposition). Plugin scan/progress,
// editor-window open/close/query, missing/crashed-plugin recovery, and the
// add-VST3-search-path directory picker (parents to the main window via getWin).
// The plugin registry itself lives in the engine worker; these are pass-throughs.

const { ipcMain, dialog } = require('electron');
let getWin = () => null;


function init(deps) {
  if (deps && typeof deps.getWin === 'function') getWin = deps.getWin;

  // ── VST3 plugin scanner ───────────────────────────────────────────────────────

  // The whole scan surface (scanPlugins / cancelPluginScan / getScanProgress /
  // getScannedPlugins / getFailedPlugins / retryFailedPlugins /
  // get+setPluginSearchPaths), the plugin-editor window methods, the
  // missing-plugin helpers, and crash recovery are RPC-manifest pass-throughs
  // (ui/rpc-manifest.js). Search paths are engine-owned since P1.

  // addVstSearchPath owns a native Electron directory picker, not an engine
  // call, so it stays hand-written (the established xleth:dialog:* pattern).
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
