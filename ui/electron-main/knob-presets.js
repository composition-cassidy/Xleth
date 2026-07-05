'use strict';

// ── User-saved knob appearance presets ────────────────────────────────────────
// Stored at userData/plugin-ui-presets/knob.json as an array of
// { id, label, description, appearance } records. Layouts never reference
// user-preset ids; "applying" a user preset just copies its appearance object
// into the node — so missing presets after disk loss never invalidate layouts.
// Extracted verbatim from ui/main.js (S5 Stage 2 decomposition); handlers
// register at require time.

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { userDataPath } = require('../runtimePaths');

const userKnobPresetsPath = userDataPath('plugin-ui-presets', 'knob.json')
const USER_KNOB_PRESET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const USER_KNOB_PRESET_MAX_COUNT = 200

function ensureUserKnobPresetsDir() {
  try { fs.mkdirSync(path.dirname(userKnobPresetsPath), { recursive: true }) } catch {}
}

function readUserKnobPresets() {
  try {
    const raw = fs.readFileSync(userKnobPresetsPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidUserKnobPreset)
  } catch { return [] }
}

function writeUserKnobPresets(presets) {
  ensureUserKnobPresetsDir()
  fs.writeFileSync(userKnobPresetsPath, JSON.stringify(presets, null, 2), 'utf8')
}

function isValidUserKnobPreset(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  if (typeof entry.id !== 'string' || !USER_KNOB_PRESET_ID_RE.test(entry.id)) return false
  if (typeof entry.label !== 'string' || entry.label.trim().length === 0 || entry.label.length > 64) return false
  if (entry.description !== undefined && (typeof entry.description !== 'string' || entry.description.length > 256)) return false
  if (!entry.appearance || typeof entry.appearance !== 'object' || Array.isArray(entry.appearance)) return false
  return true
}

ipcMain.handle('xleth:pluginUi:listKnobPresets', () => {
  return readUserKnobPresets()
})

ipcMain.handle('xleth:pluginUi:saveKnobPreset', (_, preset) => {
  if (!isValidUserKnobPreset(preset)) throw new Error('invalid knob preset')
  const existing = readUserKnobPresets()
  const index = existing.findIndex(entry => entry.id === preset.id)
  const next = index >= 0
    ? existing.map((entry, i) => i === index ? preset : entry)
    : [...existing, preset]
  if (next.length > USER_KNOB_PRESET_MAX_COUNT) throw new Error('too many user knob presets')
  writeUserKnobPresets(next)
  return next
})

ipcMain.handle('xleth:pluginUi:deleteKnobPreset', (_, id) => {
  if (typeof id !== 'string' || !USER_KNOB_PRESET_ID_RE.test(id)) throw new Error('invalid preset id')
  const existing = readUserKnobPresets()
  const next = existing.filter(entry => entry.id !== id)
  writeUserKnobPresets(next)
  return next
})

// No injected dependencies yet — init() exists so main.js wires every Stage 2
// store the same way.
function init() {}

module.exports = { init };
