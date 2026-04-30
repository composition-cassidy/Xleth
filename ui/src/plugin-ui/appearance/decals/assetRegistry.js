// Renderer-side decal asset registry.
// Wraps window.xleth.pluginUiAssets (Electron preload) when present.
// Falls back gracefully to placeholder-only when running in tests or Vite preview.
// Never accepts raw filesystem paths, URLs, or base64 strings as sources.

import { PLACEHOLDER_DECAL_ID, PLACEHOLDER_DECAL } from './placeholder.js'

// In-memory data URL cache. Keyed by assetId.
// Cleared on page load; survives within a session to avoid redundant IPC round-trips.
const _dataUrlCache = new Map()

function getApi() {
  return (typeof window !== 'undefined' && window.xleth?.pluginUiAssets) || null
}

export function getPlaceholderAsset() {
  return PLACEHOLDER_DECAL
}

/**
 * List all decal assets: built-in placeholder first, then user-imported.
 * Returns an array of { assetId, label, mime?, sizeBytes?, builtin? }.
 * Falls back to [placeholder] when no IPC is available.
 */
export async function listDecalAssets() {
  const api = getApi()
  if (!api) {
    return [{ assetId: PLACEHOLDER_DECAL_ID, label: PLACEHOLDER_DECAL.label, builtin: true }]
  }
  try {
    const list = await api.list()
    if (!Array.isArray(list)) return [{ assetId: PLACEHOLDER_DECAL_ID, label: PLACEHOLDER_DECAL.label, builtin: true }]
    return list
  } catch {
    return [{ assetId: PLACEHOLDER_DECAL_ID, label: PLACEHOLDER_DECAL.label, builtin: true }]
  }
}

/**
 * Open the file dialog and import a PNG or WebP as a decal asset.
 * Returns the new asset metadata { assetId, label, mime, sizeBytes, ... }
 * or null if the user cancelled.
 * Throws with a user-readable message if import failed.
 */
export async function importDecalAsset() {
  const api = getApi()
  if (!api) throw new Error('Import is only available in the Electron desktop app.')
  const result = await api.import()
  if (result) {
    // Invalidate any stale cache entry for this id (shouldn't exist yet, but be safe).
    _dataUrlCache.delete(result.assetId)
  }
  return result  // null = user cancelled
}

/**
 * Resolve assetId → data URL for rendering.
 * Returns null for the placeholder id (placeholder is CSS-rendered).
 * Returns null when running outside Electron.
 * Caches resolved URLs in memory for the session.
 */
export async function getDecalAssetDataUrl(assetId) {
  if (!assetId || assetId === PLACEHOLDER_DECAL_ID) return null
  if (_dataUrlCache.has(assetId)) return _dataUrlCache.get(assetId)

  const api = getApi()
  if (!api) return null

  try {
    const url = await api.getDataUrl(assetId)
    if (url && typeof url === 'string' && url.startsWith('data:image/')) {
      _dataUrlCache.set(assetId, url)
      return url
    }
    return null
  } catch {
    return null
  }
}

/**
 * Delete a user-imported asset from disk and the index.
 * Always clears the local data URL cache entry.
 * No-ops the IPC call when running outside Electron.
 */
export async function deleteDecalAsset(assetId) {
  _dataUrlCache.delete(assetId)  // always clear renderer cache
  const api = getApi()
  if (!api) return
  try { await api.delete(assetId) } catch { /* best-effort */ }
}

/**
 * Scan for orphan files and missing index entries without deleting anything.
 * Returns { missing: [...], orphans: [...] } or null when not in Electron.
 * Does not modify the index or delete any files.
 */
export async function scanDecalOrphans() {
  const api = getApi()
  if (!api) return null
  try { return await api.scanOrphans() } catch { return null }
}

/**
 * Prefix-based check: does this look like a valid decal asset id?
 * Does NOT verify against the live index (async) — use for quick guards only.
 */
export function isKnownDecalAssetId(assetId) {
  if (!assetId || typeof assetId !== 'string') return false
  return assetId === PLACEHOLDER_DECAL_ID || assetId.startsWith('user.imported.')
}

/** Clear the in-memory data URL cache (e.g. after deleting assets). */
export function invalidateDataUrlCache(assetId) {
  if (assetId) _dataUrlCache.delete(assetId)
  else _dataUrlCache.clear()
}
