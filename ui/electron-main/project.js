'use strict';

// ── Phase 1 handlers — Project ────────────────────────────────────────────────────
// Extracted from ui/main.js (S5 Stage 3 decomposition). Engine pass-throughs
// for project lifecycle; handlers are wrapped in main.js's safeHandler at
// registration time, so — like grid-layout.js — registration happens inside
// init(). project:load / project:newBlank also restart the autosave timer and
// broadcast xleth:project-loaded so renderers drop stale per-project state.

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');
const { restartAutosaveTimer } = require('./autosave');
const { getNewProjectGlobalStretchMethodDefault } = require('./settings');

// Pure engine pass-throughs (create / save / saveAs / hasProjectDir /
// importSource / removeSource / validateMedia / relinkSource /
// relinkRegionAudio / getInfo / isDirty / isExportRunning) moved to the RPC
// manifest (ui/rpc-manifest.js, AUDIT.md S1 slice 3) — registered by
// ui/electron-main/rpc-registry.js. Only load + newBlank stay hand-written
// here: they broadcast xleth:project-loaded to every renderer and restart the
// autosave timer (and newBlank also builds its arg from the settings default),
// so they are not pure pass-throughs.
function init(deps) {
  const { safeHandler } = deps;

  ipcMain.handle('xleth:project:load',
    safeHandler(async (_, dir) => {
      const result = await callWorker('project_load', [dir]);
      // Notify all renderers that the project was loaded — all effect chain
      // nodeIds have been reassigned by AudioGraph::fromJSON and any cached
      // nodeIds in the UI are now stale.
      const { webContents } = require('electron');
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed()) wc.send('xleth:project-loaded');
      }
      restartAutosaveTimer()
      return result;
    }));

  ipcMain.handle('xleth:project:newBlank',
    safeHandler(async () => {
      const result = await callWorker('project_newBlank', [getNewProjectGlobalStretchMethodDefault()]);
      // Broadcast so renderers drop any stale per-project state (plugin editor
      // refs, piano roll / mixer selections, etc.) — same pattern as project:load.
      if (result && result.ok) {
        const { webContents } = require('electron');
        for (const wc of webContents.getAllWebContents()) {
          if (!wc.isDestroyed()) wc.send('xleth:project-loaded');
        }
        restartAutosaveTimer()
      }
      return result;
    }));
}

module.exports = { init };
