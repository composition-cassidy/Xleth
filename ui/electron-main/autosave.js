'use strict';

// ── Autosave timer ────────────────────────────────────────────────────────────
// Extracted verbatim from ui/main.js (S5 Stage 2 decomposition). Periodically
// saves the open project when it is safe to: worker ready, no audio/video
// export running (that state lives in main.js and is probed via the injected
// isExportBusy), a project directory exists, the project is dirty, and the
// transport is stopped. Interval comes from settings.autosaveInterval
// (minutes, default 5; 0 disables). The xleth:autosave:restart handler
// registers at require time, as it did at main.js module scope.

const { ipcMain } = require('electron');
const { callWorker, isWorkerReady } = require('./worker');
const { loadSettings } = require('./settings');

// Injected by main.js (init) — the shared startup.log logger and the
// export-progress probe.
let log = (msg) => { process.stdout.write(String(msg) + '\n'); };
let isExportBusy = () => false;

function init(deps) {
  if (deps && typeof deps.log === 'function') log = deps.log;
  if (deps && typeof deps.isExportBusy === 'function') isExportBusy = deps.isExportBusy;
}

let autosaveIntervalId = null;

function startAutosaveTimer(intervalMs) {
  if (autosaveIntervalId !== null) {
    clearInterval(autosaveIntervalId)
    autosaveIntervalId = null
  }
  if (!(intervalMs > 0)) return
  autosaveIntervalId = setInterval(async () => {
    try {
      if (!isWorkerReady()) return
      if (isExportBusy()) return
      const hasProjDir = await callWorker('project_hasProjectDir')
      if (!hasProjDir) return
      const dirty = await callWorker('project_isDirty')
      if (!dirty) return
      const ts = await callWorker('getTransportState')
      if (ts && ts.isPlaying) return
      await callWorker('project_save')
      log('[autosave] Project saved automatically')
    } catch (err) {
      log('[autosave] Save failed:', err && err.message)
    }
  }, intervalMs)
}

function restartAutosaveTimer() {
  const settings = loadSettings()
  const minutes = settings.autosaveInterval ?? 5
  startAutosaveTimer(minutes > 0 ? minutes * 60 * 1000 : 0)
}

ipcMain.handle('xleth:autosave:restart', () => { restartAutosaveTimer() })

module.exports = { init, restartAutosaveTimer };
