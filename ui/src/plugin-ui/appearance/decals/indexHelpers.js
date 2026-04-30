// Pure decal asset index entry helpers.
// No fs, no IPC, no Electron. Safe to import in renderer tests and shared logic.
// main.js duplicates equivalent logic in CJS; this file is for the renderer/test side.

export const DECAL_ASSET_ID_RE = /^user\.imported\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Validates that a raw index entry object has the correct format.
 * Does NOT check file existence on disk (that requires fs — done in main.js).
 */
export function isValidDecalIndexEntry(e) {
  if (!e || typeof e !== 'object') return false
  if (!DECAL_ASSET_ID_RE.test(e.assetId)) return false
  if (typeof e.label !== 'string' || !e.label.trim()) return false
  if (e.mime !== 'image/png' && e.mime !== 'image/webp') return false
  if (e.ext !== 'png' && e.ext !== 'webp') return false
  if (typeof e.sizeBytes !== 'number' || e.sizeBytes <= 0) return false
  return true
}

/**
 * Parses a raw JSON string as the asset index.
 * Returns { entries: [...], wasCorrupt: boolean }.
 * wasCorrupt = true when JSON.parse threw (caller should back up the original file).
 * Only entries that pass isValidDecalIndexEntry are included.
 * Does NOT check file existence.
 */
export function parseDecalIndexJson(rawJson) {
  let parsed
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return { entries: [], wasCorrupt: true }
  }
  if (!Array.isArray(parsed)) return { entries: [], wasCorrupt: false }
  return { entries: parsed.filter(isValidDecalIndexEntry), wasCorrupt: false }
}
