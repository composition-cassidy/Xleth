'use strict';

// ── User-imported decal assets ─────────────────────────────────────────────────
// Assets live under userData/plugin-ui-assets/.
// index.json: [{ assetId, label, mime, ext, sizeBytes, importedAt }]
// Asset files: <uuid>.<ext>
// Layout JSON stores ONLY assetId — never a path, URL, data URI, or blob.
// Dimension validation is deferred (no image-decode dependency in this phase).
// Extracted verbatim from ui/main.js (S5 Stage 2 decomposition); the import
// dialog parents to the main window via the injected getWin. The store
// primitives are exported for other main-process callers.

const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { userDataPath } = require('../runtimePaths');

// Injected by main.js (init) — accessor for the main BrowserWindow (dialog parent).
let getWin = () => null;

function init(deps) {
  if (deps && typeof deps.getWin === 'function') getWin = deps.getWin;
}

const _crypto = require('crypto')

const DECAL_ASSET_DIR   = userDataPath('plugin-ui-assets')
const DECAL_ASSET_INDEX = userDataPath('plugin-ui-assets', 'index.json')
const DECAL_ASSET_MAX_BYTES = 1 * 1024 * 1024  // 1 MB
const DECAL_ASSET_ID_RE = /^user\.imported\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// PNG: 89 50 4E 47 0D 0A 1A 0A
const _PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
// WebP: RIFF????WEBP
const _RIFF_MAGIC = Buffer.from([0x52, 0x49, 0x46, 0x46])
const _WEBP_MAGIC = Buffer.from([0x57, 0x45, 0x42, 0x50])

function _decalMagicCheck(buf) {
  if (!buf || buf.length < 12) return { ok: false, error: 'File is too small to validate.' }
  // Reject SVG / HTML (text starting with '<')
  if (buf[0] === 0x3C) return { ok: false, error: 'SVG files are not supported. Please use PNG or WebP.' }
  if (_PNG_MAGIC.equals(buf.slice(0, 8))) return { ok: true, mime: 'image/png', ext: 'png' }
  if (buf.slice(0, 4).equals(_RIFF_MAGIC) && buf.slice(8, 12).equals(_WEBP_MAGIC)) {
    return { ok: true, mime: 'image/webp', ext: 'webp' }
  }
  return { ok: false, error: 'Not a valid PNG or WebP image (magic bytes do not match). SVG is not supported.' }
}

function _ensureDecalAssetDir() {
  try { fs.mkdirSync(DECAL_ASSET_DIR, { recursive: true }) } catch {}
}

function _readDecalAssetIndex() {
  let raw
  try {
    raw = fs.readFileSync(DECAL_ASSET_INDEX, 'utf8')
  } catch {
    return []  // file missing — first run or clean install
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Corrupt JSON — back up the file before recreating
    const ts = Date.now()
    const backup = path.join(DECAL_ASSET_DIR, `index.corrupt.${ts}.json`)
    try { fs.copyFileSync(DECAL_ASSET_INDEX, backup) } catch {}
    try { _writeDecalAssetIndex([]) } catch {}
    console.warn(`[xleth:decalAssets] Corrupt index.json backed up to ${backup}; recreated empty index.`)
    return []
  }

  if (!Array.isArray(parsed)) return []

  // Keep only format-valid entries whose asset file still exists on disk.
  return parsed.filter(e => {
    if (!_isValidDecalEntry(e)) return false
    try { return fs.existsSync(_decalAssetFilePath(e.assetId, e.ext)) } catch { return false }
  })
}

function _writeDecalAssetIndex(entries) {
  _ensureDecalAssetDir()
  fs.writeFileSync(DECAL_ASSET_INDEX, JSON.stringify(entries, null, 2), 'utf8')
}

function _isValidDecalEntry(e) {
  if (!e || typeof e !== 'object') return false
  if (!DECAL_ASSET_ID_RE.test(e.assetId)) return false
  if (typeof e.label !== 'string' || !e.label.trim()) return false
  if (e.mime !== 'image/png' && e.mime !== 'image/webp') return false
  if (e.ext !== 'png' && e.ext !== 'webp') return false
  if (typeof e.sizeBytes !== 'number' || e.sizeBytes <= 0) return false
  return true
}

// Constructs the safe on-disk path for a user asset.
// Only accepts DECAL_ASSET_ID_RE-matched ids; verifies the result stays inside DECAL_ASSET_DIR.
function _decalAssetFilePath(assetId, ext) {
  if (!DECAL_ASSET_ID_RE.test(assetId)) throw new Error(`invalid assetId: "${assetId}"`)
  const uuid = assetId.slice('user.imported.'.length)
  const target = path.join(DECAL_ASSET_DIR, `${uuid}.${ext}`)
  if (!target.startsWith(DECAL_ASSET_DIR + path.sep)) throw new Error('path escape detected')
  return target
}

// Per-session data URL cache (cleared on restart — never persisted).
const _decalDataUrlCache = new Map()

const _PLACEHOLDER_META = {
  assetId: 'builtin.placeholder.missing',
  label:   'Missing Asset (Placeholder)',
  builtin: true,
}

ipcMain.handle('xleth:pluginUiAssets:list', () => {
  return [_PLACEHOLDER_META, ..._readDecalAssetIndex()]
})

ipcMain.handle('xleth:pluginUiAssets:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(getWin(), {
    title: 'Import Decal — PNG or WebP only',
    filters: [{ name: 'Images (PNG, WebP)', extensions: ['png', 'webp'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths.length) return null

  const srcPath = filePaths[0]
  const srcExt  = path.extname(srcPath).toLowerCase().slice(1)
  if (srcExt !== 'png' && srcExt !== 'webp') {
    throw new Error('Only PNG and WebP files are supported.')
  }

  let buf
  try { buf = fs.readFileSync(srcPath) }
  catch (err) { throw new Error(`Could not read file: ${err.message}`) }

  if (buf.length > DECAL_ASSET_MAX_BYTES) {
    throw new Error(`File too large (${Math.round(buf.length / 1024)} KB). Maximum is ${DECAL_ASSET_MAX_BYTES / 1024} KB.`)
  }

  const magic = _decalMagicCheck(buf)
  if (!magic.ok) throw new Error(magic.error)

  const uuid    = _crypto.randomUUID()
  const assetId = `user.imported.${uuid}`
  const label   = path.basename(srcPath, path.extname(srcPath)).slice(0, 64) || 'Untitled'

  _ensureDecalAssetDir()
  const destPath = _decalAssetFilePath(assetId, magic.ext)
  fs.writeFileSync(destPath, buf)

  const meta = {
    assetId,
    label,
    mime:       magic.mime,
    ext:        magic.ext,
    sizeBytes:  buf.length,
    importedAt: new Date().toISOString(),
  }

  const index = _readDecalAssetIndex()
  index.push(meta)
  _writeDecalAssetIndex(index)
  return meta
})

ipcMain.handle('xleth:pluginUiAssets:getDataUrl', (_, assetId) => {
  if (assetId === 'builtin.placeholder.missing') return null

  if (!DECAL_ASSET_ID_RE.test(assetId)) {
    throw new Error(`Invalid assetId format: "${assetId}"`)
  }

  if (_decalDataUrlCache.has(assetId)) return _decalDataUrlCache.get(assetId)

  const index = _readDecalAssetIndex()
  const entry = index.find(e => e.assetId === assetId)
  if (!entry) throw new Error(`Asset not found in index: "${assetId}"`)

  const filePath = _decalAssetFilePath(assetId, entry.ext)
  let buf
  try { buf = fs.readFileSync(filePath) }
  catch { throw new Error(`Asset file missing from disk for "${assetId}"`) }

  const magic = _decalMagicCheck(buf)
  if (!magic.ok) throw new Error(`Stored asset is corrupt: ${magic.error}`)

  const dataUrl = `data:${magic.mime};base64,${buf.toString('base64')}`
  _decalDataUrlCache.set(assetId, dataUrl)
  return dataUrl
})

ipcMain.handle('xleth:pluginUiAssets:delete', (_, assetId) => {
  if (!DECAL_ASSET_ID_RE.test(assetId)) throw new Error(`Invalid assetId: "${assetId}"`)

  const index = _readDecalAssetIndex()
  const entry = index.find(e => e.assetId === assetId)

  if (entry) {
    try { fs.unlinkSync(_decalAssetFilePath(assetId, entry.ext)) } catch {}
  }

  _decalDataUrlCache.delete(assetId)
  _writeDecalAssetIndex(index.filter(e => e.assetId !== assetId))
  return true
})

ipcMain.handle('xleth:pluginUiAssets:scanOrphans', () => {
  _ensureDecalAssetDir()

  // Read raw entries (format-valid but NOT filtered by file existence) so we can report missing files.
  let rawEntries = []
  try {
    const raw = fs.readFileSync(DECAL_ASSET_INDEX, 'utf8')
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) rawEntries = parsed.filter(_isValidDecalEntry)
    } catch { /* corrupt — raw already [] */ }
  } catch { /* file missing */ }

  // Missing: index entries whose files are gone from disk.
  const missing = rawEntries
    .filter(e => {
      try { return !fs.existsSync(_decalAssetFilePath(e.assetId, e.ext)) } catch { return true }
    })
    .map(e => ({ assetId: e.assetId, label: e.label }))

  // Orphans: files in the asset dir that have no matching index entry.
  let dirFiles = []
  try { dirFiles = fs.readdirSync(DECAL_ASSET_DIR) } catch {}

  const indexedFilenames = new Set(
    rawEntries.map(e => {
      try { return path.basename(_decalAssetFilePath(e.assetId, e.ext)) } catch { return null }
    }).filter(Boolean),
  )

  const orphans = dirFiles
    .filter(f => f !== 'index.json' && !f.startsWith('index.corrupt.') && !indexedFilenames.has(f))
    .map(f => ({ filename: f }))

  return { missing, orphans }
})

module.exports = {
  init,
  DECAL_ASSET_MAX_BYTES,
  _decalMagicCheck,
  _ensureDecalAssetDir,
  _readDecalAssetIndex,
  _writeDecalAssetIndex,
  _decalAssetFilePath,
};
