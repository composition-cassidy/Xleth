/**
 * Freeform-E: User-imported PNG/WebP decal assets.
 *
 * Coverage:
 *   1.  PNG magic bytes accepted
 *   2.  WebP magic bytes accepted
 *   3.  Wrong magic bytes rejected
 *   4.  SVG rejected (starts with '<')
 *   5.  Buffer too small rejected
 *   6.  makeUserAssetId generates user.imported.<uuid>
 *   7.  isValidDecalAssetId accepts builtin and user.imported
 *   8.  isValidDecalAssetId rejects raw paths / URLs / arbitrary strings
 *   9.  isValidUserAssetId rejects malformed UUIDs
 *  10.  extractUuidFromAssetId round-trips
 *  11.  listDecalAssets returns placeholder-only when no window.xleth
 *  12.  getDecalAssetDataUrl returns null for placeholder id
 *  13.  getDecalAssetDataUrl returns null when no window.xleth (user asset)
 *  14.  getDecalAssetDataUrl caches and re-uses valid data URLs
 *  15.  getDecalAssetDataUrl only caches data: URLs, not arbitrary strings
 *  16.  validator accepts user.imported.* assetId on a decal node
 *  17.  DecalNode renders placeholder div for builtin.placeholder.missing
 *  18.  DecalNode renders placeholder div when assetId resolves to null
 *  19.  DecalInspector does not render any <input type="text"> or URL fields
 *  20.  DecalInspector renders the "Import PNG/WebP" button
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  validateImageMagicBytes,
  makeUserAssetId,
  isValidDecalAssetId,
  isValidUserAssetId,
  isValidBuiltinAssetId,
  extractUuidFromAssetId,
  PLACEHOLDER_DECAL_ID,
} from '../../appearance/decals/assetIdHelpers.js'

import {
  listDecalAssets,
  getDecalAssetDataUrl,
  invalidateDataUrlCache,
} from '../../appearance/decals/assetRegistry.js'

import DecalNode from '../../runtime/components/DecalNode.jsx'
import DecalInspector from '../inspectors/DecalInspector.jsx'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Build a minimal 12-byte PNG-magic buffer (only first 8 bytes matter).
function makePngBuf() {
  return new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0])
}

// Build a minimal 12-byte WebP-magic buffer (RIFF????WEBP).
function makeWebpBuf() {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46,  // "RIFF"
    0x00, 0x00, 0x00, 0x00,  // chunk size (ignored)
    0x57, 0x45, 0x42, 0x50,  // "WEBP"
  ])
}

function makeSvgBuf() {
  return new Uint8Array(Array.from('<svg width="100"').map(c => c.charCodeAt(0)).concat(new Array(4).fill(0)))
}

function makeRandomBuf() {
  return new Uint8Array([0xFF, 0xFE, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09])
}

const VALID_UUID = '12345678-1234-4234-8234-123456789abc'
const VALID_USER_ASSET_ID = `user.imported.${VALID_UUID}`

// ─────────────────────────────────────────────────────────────────────────────
// 1–5. validateImageMagicBytes
// ─────────────────────────────────────────────────────────────────────────────

describe('validateImageMagicBytes', () => {
  it('accepts PNG magic bytes', () => {
    const result = validateImageMagicBytes(makePngBuf())
    expect(result.ok).toBe(true)
    expect(result.mime).toBe('image/png')
    expect(result.ext).toBe('png')
  })

  it('accepts WebP magic bytes', () => {
    const result = validateImageMagicBytes(makeWebpBuf())
    expect(result.ok).toBe(true)
    expect(result.mime).toBe('image/webp')
    expect(result.ext).toBe('webp')
  })

  it('rejects unrecognised magic bytes', () => {
    const result = validateImageMagicBytes(makeRandomBuf())
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not a valid PNG or WebP/i)
  })

  it('rejects SVG (first byte is "<")', () => {
    const result = validateImageMagicBytes(makeSvgBuf())
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/SVG/i)
  })

  it('rejects buffers shorter than 12 bytes', () => {
    const result = validateImageMagicBytes(new Uint8Array([0x89, 0x50]))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/too small/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6–10. Asset ID helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('makeUserAssetId', () => {
  it('prefixes uuid with user.imported.', () => {
    expect(makeUserAssetId(VALID_UUID)).toBe(VALID_USER_ASSET_ID)
  })
})

describe('isValidBuiltinAssetId', () => {
  it('accepts builtin.placeholder.missing', () => {
    expect(isValidBuiltinAssetId('builtin.placeholder.missing')).toBe(true)
  })

  it('rejects other strings', () => {
    expect(isValidBuiltinAssetId('builtin.other')).toBe(false)
    expect(isValidBuiltinAssetId('')).toBe(false)
  })
})

describe('isValidUserAssetId', () => {
  it('accepts correctly formatted user.imported.<uuid>', () => {
    expect(isValidUserAssetId(VALID_USER_ASSET_ID)).toBe(true)
  })

  it('rejects missing UUID suffix', () => {
    expect(isValidUserAssetId('user.imported.')).toBe(false)
    expect(isValidUserAssetId('user.imported.not-a-uuid')).toBe(false)
  })

  it('rejects non-string input', () => {
    expect(isValidUserAssetId(null)).toBe(false)
    expect(isValidUserAssetId(42)).toBe(false)
  })
})

describe('isValidDecalAssetId', () => {
  it('accepts placeholder id', () => {
    expect(isValidDecalAssetId(PLACEHOLDER_DECAL_ID)).toBe(true)
  })

  it('accepts valid user.imported.<uuid>', () => {
    expect(isValidDecalAssetId(VALID_USER_ASSET_ID)).toBe(true)
  })

  it('rejects Windows paths', () => {
    expect(isValidDecalAssetId('C:\\Users\\test\\image.png')).toBe(false)
  })

  it('rejects Unix paths', () => {
    expect(isValidDecalAssetId('/home/user/image.png')).toBe(false)
  })

  it('rejects http URLs', () => {
    expect(isValidDecalAssetId('https://example.com/image.png')).toBe(false)
  })

  it('rejects file:// URLs', () => {
    expect(isValidDecalAssetId('file:///C:/image.png')).toBe(false)
  })

  it('rejects arbitrary strings', () => {
    expect(isValidDecalAssetId('my-custom-id')).toBe(false)
    expect(isValidDecalAssetId('')).toBe(false)
  })
})

describe('extractUuidFromAssetId', () => {
  it('round-trips: makeUserAssetId → extractUuid', () => {
    const id = makeUserAssetId(VALID_UUID)
    expect(extractUuidFromAssetId(id)).toBe(VALID_UUID)
  })

  it('returns null for placeholder or invalid ids', () => {
    expect(extractUuidFromAssetId(PLACEHOLDER_DECAL_ID)).toBeNull()
    expect(extractUuidFromAssetId('arbitrary')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 11–15. Asset registry — fallback + cache behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('listDecalAssets (no window.xleth)', () => {
  it('returns array with placeholder when IPC is unavailable', async () => {
    const list = await listDecalAssets()
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBeGreaterThanOrEqual(1)
    expect(list[0].assetId).toBe(PLACEHOLDER_DECAL_ID)
  })
})

describe('getDecalAssetDataUrl', () => {
  beforeEach(() => invalidateDataUrlCache())

  it('returns null for the placeholder id', async () => {
    expect(await getDecalAssetDataUrl(PLACEHOLDER_DECAL_ID)).toBeNull()
  })

  it('returns null for a user asset when IPC is unavailable', async () => {
    expect(await getDecalAssetDataUrl(VALID_USER_ASSET_ID)).toBeNull()
  })

  it('caches and re-uses a valid data URL returned by a mocked API', async () => {
    const fakeUrl = `data:image/png;base64,AAAA`
    globalThis.window = {
      xleth: {
        pluginUiAssets: {
          getDataUrl: vi.fn().mockResolvedValue(fakeUrl),
        },
      },
    }

    const url1 = await getDecalAssetDataUrl(VALID_USER_ASSET_ID)
    const url2 = await getDecalAssetDataUrl(VALID_USER_ASSET_ID)

    expect(url1).toBe(fakeUrl)
    expect(url2).toBe(fakeUrl)
    // Should only have called IPC once — second call hits the cache.
    expect(window.xleth.pluginUiAssets.getDataUrl).toHaveBeenCalledTimes(1)

    delete globalThis.window
    invalidateDataUrlCache()
  })

  it('does not cache non-data-URL responses from IPC', async () => {
    globalThis.window = {
      xleth: {
        pluginUiAssets: {
          getDataUrl: vi.fn().mockResolvedValue('https://evil.example.com/image.png'),
        },
      },
    }

    const url = await getDecalAssetDataUrl(VALID_USER_ASSET_ID)
    expect(url).toBeNull()  // rejected — not a data:image/ URL

    delete globalThis.window
    invalidateDataUrlCache()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 16. Validator accepts user.imported.* assetId
// ─────────────────────────────────────────────────────────────────────────────

describe('validator accepts user.imported.* assetId', () => {
  it('passes schema validation for a decal node with a user.imported assetId', async () => {
    const { validate } = await import('../../schema/validate.js')
    const layout = {
      schemaVersion: 1,
      pluginId: 'compressor',
      root: {
        id: 'root',
        type: 'panel',
        children: [
          {
            id: 'ff-layer',
            type: 'freeformLayer',
            style: { widthPx: 480, heightPx: 160 },
            props: { snap: { gridPx: 8, enabled: true }, background: 'transparent', clip: 'panel' },
            children: [
              {
                id: 'decal-1',
                type: 'decal',
                props: {
                  assetId: VALID_USER_ASSET_ID,
                  fit: 'contain',
                  opacity: 100,
                  frame: { x: 10, y: 10, widthPx: 80, heightPx: 80 },
                },
              },
            ],
          },
        ],
      },
    }
    const result = validate(layout, { pluginId: 'compressor' })
    // The assetId prefix is valid; no hard error expected.
    const assetErrors = result.errors.filter(e => e.code === 'BAD_ASSET_ID_FORMAT')
    expect(assetErrors).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 17–18. DecalNode — placeholder fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('DecalNode (static render)', () => {
  const makeNode = (assetId) => ({
    id: 'decal-1',
    type: 'decal',
    props: { assetId, fit: 'contain', opacity: 100, frame: { x: 0, y: 0, widthPx: 100, heightPx: 100 } },
  })

  it('renders placeholder div for builtin.placeholder.missing', () => {
    const html = renderToStaticMarkup(
      <DecalNode node={makeNode(PLACEHOLDER_DECAL_ID)} />,
    )
    expect(html).toContain('pluginui-decal--placeholder')
    expect(html).not.toContain('<img')
  })

  it('renders placeholder div when assetId resolves to null (no IPC)', () => {
    // No window.xleth → getDecalAssetDataUrl returns null → placeholder shown.
    // renderToStaticMarkup runs initial render (before effects) — initial state has dataUrl=null.
    const html = renderToStaticMarkup(
      <DecalNode node={makeNode(VALID_USER_ASSET_ID)} />,
    )
    expect(html).toContain('pluginui-decal--placeholder')
    expect(html).not.toContain('<img')
  })

  it('sets data-decal-id attribute on the rendered element', () => {
    const html = renderToStaticMarkup(
      <DecalNode node={makeNode(PLACEHOLDER_DECAL_ID)} />,
    )
    expect(html).toContain(`data-decal-id="${PLACEHOLDER_DECAL_ID}"`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 19–20. DecalInspector — no URL/path fields; has Import button
// ─────────────────────────────────────────────────────────────────────────────

describe('DecalInspector (static render)', () => {
  const node = {
    id: 'decal-1',
    type: 'decal',
    props: {
      assetId: PLACEHOLDER_DECAL_ID,
      fit: 'contain',
      opacity: 100,
      frame: { x: 0, y: 0, widthPx: 100, heightPx: 100 },
    },
  }

  it('renders the Import PNG/WebP button', () => {
    const html = renderToStaticMarkup(
      <DecalInspector node={node} onPatchProps={() => {}} />,
    )
    expect(html).toContain('Import PNG/WebP')
  })

  it('does not render any text or URL input fields', () => {
    const html = renderToStaticMarkup(
      <DecalInspector node={node} onPatchProps={() => {}} />,
    )
    // No <input type="text"> or <input type="url"> — only <select> and <button>
    expect(html).not.toMatch(/<input[^>]+type="text"/i)
    expect(html).not.toMatch(/<input[^>]+type="url"/i)
  })

  it('does not render any label with "url", "path", "src", or "href"', () => {
    const html = renderToStaticMarkup(
      <DecalInspector node={node} onPatchProps={() => {}} />,
    )
    expect(html.toLowerCase()).not.toContain('type="url"')
    // Ensure no raw path / URL field labels appear
    expect(html).not.toMatch(/\blabel[^>]*>.*\b(url|path|src|href)\b/i)
  })
})
