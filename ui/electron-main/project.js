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

function init(deps) {
  const { safeHandler } = deps;

  ipcMain.handle('xleth:project:create',
    safeHandler((_, dir, name) => callWorker('project_create', [dir, name])));

  ipcMain.handle('xleth:project:save',
    safeHandler(() => callWorker('project_save')));

  ipcMain.handle('xleth:project:saveAs',
    safeHandler((_, dir, name) => callWorker('project_saveAs', [dir, name])));

  ipcMain.handle('xleth:project:hasProjectDir',
    safeHandler(() => callWorker('project_hasProjectDir')));

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

  ipcMain.handle('xleth:project:importSource',
    safeHandler((_, filePath) => callWorker('project_importSource', [filePath])));

  ipcMain.handle('xleth:project:removeSource',
    safeHandler((_, sourceId) => callWorker('project_removeSource', [sourceId])));

  ipcMain.handle('xleth:project:validateMedia',
    safeHandler(() => callWorker('project_validateMedia')));

  ipcMain.handle('xleth:project:relinkSource',
    safeHandler((_, sourceId, newPath) => callWorker('project_relinkSource', [sourceId, newPath])));

  ipcMain.handle('xleth:project:relinkRegionAudio',
    safeHandler((_, regionId, newPath) => callWorker('project_relinkRegionAudio', [regionId, newPath])));

  ipcMain.handle('xleth:project:getInfo',
    safeHandler(() => callWorker('project_getInfo')));

  ipcMain.handle('xleth:project:isDirty',
    safeHandler(() => callWorker('project_isDirty')));

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

  ipcMain.handle('xleth:project:isExportRunning',
    safeHandler(() => callWorker('project_isExportRunning')));
}

module.exports = { init };
