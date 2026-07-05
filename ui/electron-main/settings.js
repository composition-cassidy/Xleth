'use strict';

// ── User settings (persisted across sessions, not per-project) ───────────────
// Extracted verbatim from ui/main.js (S5 Stage 2 decomposition). Owns the two
// session-scoped stores: userData/xleth-settings.json (key/value settings via
// loadSettings/saveSettings) and userData/layout.json (raw string payload via
// the xleth:layout:read/write handlers, registered at require time — the same
// module-scope timing they had in main.js). The xleth:settings:get/set
// handlers stay in main.js: they are entangled with the workspace-backdrop
// logic, not with this store.

const { ipcMain } = require('electron');
const fs = require('fs');
const { userDataPath } = require('../runtimePaths');

const settingsPath = userDataPath('xleth-settings.json')
const layoutPath = userDataPath('layout.json')
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch { return {} }
}
function saveSettings(s) {
  try { fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf8') } catch {}
}
function sanitizeGlobalStretchMethod(method) {
  const n = Number(method)
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1
}
function getNewProjectGlobalStretchMethodDefault() {
  const settings = loadSettings()
  return sanitizeGlobalStretchMethod(
    settings.defaultGlobalStretchMethod ?? settings.globalStretchMethod ?? 1
  )
}

ipcMain.handle('xleth:layout:read', () => {
  try { return fs.readFileSync(layoutPath, 'utf8') } catch { return null }
})
ipcMain.handle('xleth:layout:write', (_, raw) => {
  if (typeof raw !== 'string') throw new Error('layout payload must be a string')
  fs.writeFileSync(layoutPath, raw, 'utf8')
  return true
})

// No injected dependencies yet — init() exists so main.js wires every Stage 2
// store the same way.
function init() {}

module.exports = {
  init,
  loadSettings,
  saveSettings,
  sanitizeGlobalStretchMethod,
  getNewProjectGlobalStretchMethodDefault,
};
