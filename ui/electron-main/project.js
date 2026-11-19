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
// Injected by main.js (init). A workspace window that is still booting gets
// its own xleth:project-loaded once it has mounted (see main.js, "Workspace
// window boot"); broadcasting to it here as well would hydrate it twice.
let shouldBroadcastTo = () => true;
let onLoadStart = null;
let onLoadEnd = null;

function broadcastProjectLoaded() {
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed() && shouldBroadcastTo(wc)) wc.send('xleth:project-loaded');
  }
}

async function loadProject(dir) {
  const result = await callWorker('project_load', [dir]);
  // Notify all renderers that the project was loaded — all effect chain
  // nodeIds have been reassigned by AudioGraph::fromJSON and any cached
  // nodeIds in the UI are now stale.
  broadcastProjectLoaded();
  restartAutosaveTimer();
  return result;
}

async function newBlankProject() {
  const result = await callWorker('project_newBlank', [getNewProjectGlobalStretchMethodDefault()]);
  // Broadcast so renderers drop any stale per-project state (plugin editor
  // refs, piano roll / mixer selections, etc.) — same pattern as project:load.
  if (result && result.ok) {
    broadcastProjectLoaded();
    restartAutosaveTimer();
  }
  return result;
}

function init(deps) {
  const { safeHandler } = deps;
  if (typeof deps.shouldBroadcastTo === 'function') shouldBroadcastTo = deps.shouldBroadcastTo;
  if (typeof deps.onLoadStart === 'function') onLoadStart = deps.onLoadStart;
  if (typeof deps.onLoadEnd === 'function') onLoadEnd = deps.onLoadEnd;

  // onLoadStart / onLoadEnd bracket a load requested over IPC, so main.js can
  // start booting the workspace window while the engine is still loading (the
  // Welcome → workspace hand-off). onLoadEnd always fires, with ok=false when
  // the load returned false or threw.
  ipcMain.handle('xleth:project:load', safeHandler(async (event, dir) => {
    if (onLoadStart) onLoadStart(event, dir);
    let ok = false;
    try {
      const result = await loadProject(dir);
      ok = !!result;
      return result;
    } finally {
      if (onLoadEnd) onLoadEnd(event, dir, ok);
    }
  }));
  ipcMain.handle('xleth:project:newBlank', safeHandler(() => newBlankProject()));
}

module.exports = { init, loadProject, newBlankProject };
