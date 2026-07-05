'use strict';

// ── Stock plugin UI layouts (userData/plugin-ui/<pluginId>.json) ──────────────
// Mirrors the user-themes pattern. Does NOT require the engine worker to be
// ready — layout files are pure JSON on disk, no C++ involvement.
// Extracted verbatim from ui/main.js (S5 Stage 2 decomposition), including the
// xleth:dialog:importPluginUi / xleth:dialog:exportPluginUi handlers; their
// dialogs parent to the main window via the injected getWin.

const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { runtimeResource, userDataPath } = require('../runtimePaths');

// Injected by main.js (init) — accessor for the main BrowserWindow (dialog parent).
let getWin = () => null;

function init(deps) {
  if (deps && typeof deps.getWin === 'function') getWin = deps.getWin;
}

const pluginUiDir = userDataPath('plugin-ui')
const KNOWN_PLUGIN_IDS = new Set(['compressor', 'limiter', 'transientproc', 'overdone', 'distortion'])
const PLUGIN_UI_LAYOUT_KIND = 'plugin-ui-layout'
const SHIPPED_PLUGIN_UI_LAYOUT_FILES = {
  compressor:    runtimeResource('app', 'src', 'plugin-ui', 'layouts', 'compressor.json'),
  limiter:       runtimeResource('app', 'src', 'plugin-ui', 'layouts', 'limiter.json'),
  transientproc: runtimeResource('app', 'src', 'plugin-ui', 'layouts', 'transient.json'),
  overdone:      runtimeResource('app', 'src', 'plugin-ui', 'layouts', 'overdone.json'),
  distortion:    runtimeResource('app', 'src', 'plugin-ui', 'layouts', 'distortion.json'),
}

function pluginIdSafe(id) {
  return typeof id === 'string' && /^[a-z][a-z0-9_-]*$/.test(id) && id.length <= 64
    && KNOWN_PLUGIN_IDS.has(id)
}

function pluginUiPath(pluginId) {
  if (!pluginIdSafe(pluginId)) throw new Error('invalid pluginId')
  const base = path.resolve(pluginUiDir)
  const target = path.resolve(base, `${pluginId}.json`)
  if (target !== path.join(base, `${pluginId}.json`)) throw new Error('invalid pluginId')
  if (!target.startsWith(base + path.sep)) throw new Error('invalid pluginId')
  return target
}

function ensurePluginUiDir() {
  try { fs.mkdirSync(pluginUiDir, { recursive: true }) } catch {}
}

function broadcastPluginUiChanged(pluginId) {
  const { webContents } = require('electron')
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send('xleth:pluginUi:changed', pluginId)
  }
}

ipcMain.handle('xleth:pluginUi:loadUserOverride', (_, pluginId) => {
  if (!pluginIdSafe(pluginId)) throw new Error('invalid pluginId')
  try {
    const raw = fs.readFileSync(pluginUiPath(pluginId), 'utf8')
    return JSON.parse(raw)
  } catch { return null }
})

function validateLayoutStructure(layout, pluginId) {
  if (!layout || typeof layout !== 'object') return 'layout must be an object'
  if (layout.$xleth !== undefined && layout.$xleth !== PLUGIN_UI_LAYOUT_KIND) return 'invalid $xleth discriminator'
  if (!Number.isInteger(layout.schemaVersion)) return 'missing schemaVersion'
  if (typeof layout.pluginId !== 'string') return 'missing pluginId'
  if (pluginId && layout.pluginId !== pluginId) return `pluginId "${layout.pluginId}" does not match "${pluginId}"`
  if (!layout.root || layout.root.type !== 'panel') return 'root must be type "panel"'
  return null
}

function readShippedPluginUiLayout(pluginId) {
  if (!pluginIdSafe(pluginId)) throw new Error('invalid pluginId')
  const shippedPath = SHIPPED_PLUGIN_UI_LAYOUT_FILES[pluginId]
  if (!shippedPath) throw new Error(`No shipped layout for "${pluginId}"`)
  try {
    const layout = JSON.parse(fs.readFileSync(shippedPath, 'utf8'))
    const structErr = validateLayoutStructure(layout, pluginId)
    if (structErr) throw new Error(`Invalid shipped layout: ${structErr}`)
    return layout
  } catch (err) {
    throw new Error(`Could not read shipped layout for "${pluginId}": ${err?.message || err}`)
  }
}

function parseImportedPluginUiLayout(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid JSON: ${err?.message || err}`)
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Layout file must contain a JSON object')
  }

  if (parsed.$xleth !== undefined && parsed.$xleth !== PLUGIN_UI_LAYOUT_KIND) {
    throw new Error(`Invalid $xleth discriminator: ${parsed.$xleth}`)
  }

  const pluginId = parsed.pluginId
  if (!pluginIdSafe(pluginId)) throw new Error('invalid pluginId')
  const structErr = validateLayoutStructure(parsed, pluginId)
  if (structErr) throw new Error(`Invalid layout: ${structErr}`)
  return { pluginId, layout: parsed }
}

ipcMain.handle('xleth:pluginUi:getShipped', (_, pluginId) => {
  return readShippedPluginUiLayout(pluginId)
})

ipcMain.handle('xleth:pluginUi:saveUserOverride', (_, pluginId, layout) => {
  if (!pluginIdSafe(pluginId)) throw new Error('invalid pluginId')
  if (!layout || typeof layout !== 'object') throw new Error('layout must be an object')
  const structErr = validateLayoutStructure(layout, pluginId)
  if (structErr) throw new Error(`Invalid layout: ${structErr}`)
  ensurePluginUiDir()
  fs.writeFileSync(pluginUiPath(pluginId), JSON.stringify(layout, null, 2), 'utf8')
  broadcastPluginUiChanged(pluginId)
  return true
})

ipcMain.handle('xleth:pluginUi:clearUserOverride', (_, pluginId) => {
  if (!pluginIdSafe(pluginId)) throw new Error('invalid pluginId')
  let removed = false
  try { fs.unlinkSync(pluginUiPath(pluginId)); removed = true } catch { removed = false }
  broadcastPluginUiChanged(pluginId)
  return removed
})

ipcMain.handle('xleth:dialog:importPluginUi', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(getWin(), {
    title: 'Import Plugin UI Layout',
    filters: [
      { name: 'XLETH Plugin UI Layout', extensions: ['xlethui.json', 'json'] },
      { name: 'JSON Files', extensions: ['json'] },
    ],
    properties: ['openFile'],
  })
  if (canceled || !filePaths.length) return null

  const selectedPath = filePaths[0]
  try {
    const raw = fs.readFileSync(selectedPath, 'utf8')
    const { pluginId, layout } = parseImportedPluginUiLayout(raw)
    return { pluginId, layout, path: selectedPath }
  } catch (err) {
    throw new Error(`Import failed: ${err?.message || err}`)
  }
})

ipcMain.handle('xleth:dialog:exportPluginUi', async (_, pluginId, layout) => {
  if (!pluginIdSafe(pluginId)) throw new Error('invalid pluginId')
  const structErr = validateLayoutStructure(layout, pluginId)
  if (structErr) throw new Error(`Invalid layout: ${structErr}`)

  const { canceled, filePath } = await dialog.showSaveDialog(getWin(), {
    title: 'Export Plugin UI Layout',
    defaultPath: `${pluginId}.xlethui.json`,
    filters: [
      { name: 'XLETH Plugin UI Layout', extensions: ['xlethui.json'] },
      { name: 'JSON Files', extensions: ['json'] },
    ],
  })
  if (canceled || !filePath) return null

  try {
    fs.writeFileSync(filePath, JSON.stringify(layout, null, 2), 'utf8')
    return { path: filePath }
  } catch (err) {
    throw new Error(`Export failed: ${err?.message || err}`)
  }
})

module.exports = {
  init,
  pluginIdSafe,
  validateLayoutStructure,
  parseImportedPluginUiLayout,
};
