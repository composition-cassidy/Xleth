'use strict';

// ── Phase 1 handlers — Project ────────────────────────────────────────────────────
// Extracted from ui/main.js (S5 Stage 3 decomposition). Engine pass-throughs
// for project lifecycle; handlers are wrapped in main.js's safeHandler at
// registration time, so — like grid-layout.js — registration happens inside
// init(). project:load / project:newBlank also restart the autosave timer and
// broadcast xleth:project-loaded so renderers drop stale per-project state.

const { ipcMain, webContents } = require('electron');
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
//
// Exported as plain functions (not just IPC handlers) so main.js can call
// them directly when orchestrating the workspace-window hide/splash/show
// sequence for in-app project switches (xleth:project:switchToLoad/New) —
// see openWorkspaceWindow/switchProjectWindow in main.js.
async function loadProject(dir) {
  const result = await callWorker('project_load', [dir]);
  // Notify all renderers that the project was loaded — all effect chain
  // nodeIds have been reassigned by AudioGraph::fromJSON and any cached
  // nodeIds in the UI are now stale.
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send('xleth:project-loaded');
  }
  restartAutosaveTimer();
  return result;
}

async function newBlankProject() {
  const result = await callWorker('project_newBlank', [getNewProjectGlobalStretchMethodDefault()]);
  // Broadcast so renderers drop any stale per-project state (plugin editor
  // refs, piano roll / mixer selections, etc.) — same pattern as project:load.
  if (result && result.ok) {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send('xleth:project-loaded');
    }
    restartAutosaveTimer();
  }
  return result;
}

function init(deps) {
  const { safeHandler } = deps;

  ipcMain.handle('xleth:project:load', safeHandler((_, dir) => loadProject(dir)));
  ipcMain.handle('xleth:project:newBlank', safeHandler(() => newBlankProject()));
}

module.exports = { init, loadProject, newBlankProject };
