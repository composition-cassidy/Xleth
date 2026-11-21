'use strict';

// ── Recent Projects (Welcome screen) ──────────────────────────────────────────
// Mirrors settings.js's file-per-concern pattern: userData/recent-projects.json,
// most-recent-first, hard-capped at 10, deduped by normalized absolute project
// directory. List-transform logic lives in recentProjectsLogic.js (no Electron
// dependency, directly smoke-testable); this module is the fs + IPC glue
// around it, following the same shape as settings.js.

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { userDataPath } = require('../runtimePaths');
const logic = require('./recentProjectsLogic');

const recentsPath = userDataPath('recent-projects.json');

function loadRecents() {
  try {
    const raw = JSON.parse(fs.readFileSync(recentsPath, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function saveRecents(list) {
  try { fs.writeFileSync(recentsPath, JSON.stringify(list, null, 2), 'utf8'); } catch {}
}

// Live entries with a freshly-computed `exists` flag (see projectFileExists).
function listWithStatus() {
  return logic.withStatus(loadRecents());
}

function touchRecent(entry) {
  const next = logic.withTouched(loadRecents(), entry);
  saveRecents(next);
  return next;
}

function removeRecent(dir) {
  const next = logic.withRemoved(loadRecents(), dir);
  saveRecents(next);
  return next;
}

// Used by main.js's boot gating: when "show Welcome on startup" is off, this
// is the project auto-loaded instead. null when there is no valid recent —
// the gate is then never bypassed, only shortened (Welcome shows anyway).
function firstValidRecent() {
  return logic.firstValid(loadRecents());
}

function init() {
  ipcMain.handle('xleth:recentProjects:list', () => listWithStatus());
  ipcMain.handle('xleth:recentProjects:touch', (_event, entry) => {
    if (!entry || typeof entry.dir !== 'string' || !entry.dir) {
      throw new Error('recentProjects:touch requires { dir }');
    }
    const name = typeof entry.name === 'string' && entry.name ? entry.name : path.basename(entry.dir);
    return touchRecent({ name, dir: entry.dir });
  });
  ipcMain.handle('xleth:recentProjects:remove', (_event, dir) => removeRecent(dir));
}

module.exports = {
  init,
  listWithStatus,
  touchRecent,
  removeRecent,
  firstValidRecent,
};
