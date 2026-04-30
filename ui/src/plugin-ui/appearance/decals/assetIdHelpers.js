// Pure helpers — no Electron, no fs, no IPC, no DOM.
// Used by renderer tests and the renderer asset registry.
// The main process duplicates the magic-byte logic as Node Buffer code.

export const PLACEHOLDER_DECAL_ID = 'builtin.placeholder.missing'
export const DECAL_ASSET_MAX_BYTES = 1 * 1024 * 1024  // 1 MB

// ── Magic byte constants ──────────────────────────────────────────────────────

// PNG: 89 50 4E 47 0D 0A 1A 0A
const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

// WebP: bytes 0-3 = "RIFF", bytes 8-11 = "WEBP"
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46]  // "RIFF"
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50]  // "WEBP"

function bufMatchAt(buf, offset, bytes) {
  for (let i = 0; i < bytes.length; i++) {
    if ((buf[offset + i] ?? -1) !== bytes[i]) return false
  }
  return true
}

/**
 * Validate PNG or WebP magic bytes.
 * buf must be Uint8Array, Buffer, or any indexed array-like; at least 12 bytes.
 * Returns { ok: true, mime, ext } or { ok: false, error }.
 */
export function validateImageMagicBytes(buf) {
  if (!buf || buf.length < 12) {
    return { ok: false, error: 'File is too small to validate (need at least 12 bytes).' }
  }

  // Reject SVG / HTML (text files starting with '<')
  if (buf[0] === 0x3C) {
    return { ok: false, error: 'SVG files are not supported. Please use PNG or WebP.' }
  }

  // PNG
  if (bufMatchAt(buf, 0, PNG_MAGIC)) {
    return { ok: true, mime: 'image/png', ext: 'png' }
  }

  // WebP (RIFF????WEBP)
  if (bufMatchAt(buf, 0, RIFF_MAGIC) && bufMatchAt(buf, 8, WEBP_MAGIC)) {
    return { ok: true, mime: 'image/webp', ext: 'webp' }
  }

  return { ok: false, error: 'Not a valid PNG or WebP image (magic bytes do not match). SVG is not supported.' }
}

// ── Asset ID helpers ──────────────────────────────────────────────────────────

// UUID v4: 8-4-4-4-12 hex chars separated by hyphens
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function makeUserAssetId(uuid) {
  return `user.imported.${uuid}`
}

export function isValidUserAssetId(assetId) {
  if (typeof assetId !== 'string') return false
  if (!assetId.startsWith('user.imported.')) return false
  const uuid = assetId.slice('user.imported.'.length)
  return UUID_V4_RE.test(uuid)
}

export function isValidBuiltinAssetId(assetId) {
  return assetId === PLACEHOLDER_DECAL_ID
}

export function isValidDecalAssetId(assetId) {
  return isValidBuiltinAssetId(assetId) || isValidUserAssetId(assetId)
}

export function extractUuidFromAssetId(assetId) {
  if (!isValidUserAssetId(assetId)) return null
  return assetId.slice('user.imported.'.length)
}
