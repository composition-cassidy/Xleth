/**
 * Freeform-E2: Hardening tests for user-imported decal assets.
 *
 * Coverage:
 *   Index helpers (pure — no fs/IPC)
 *     1.  isValidDecalIndexEntry accepts a well-formed entry
 *     2.  isValidDecalIndexEntry rejects bad assetId format
 *     3.  isValidDecalIndexEntry rejects unrecognised mime
 *     4.  isValidDecalIndexEntry rejects unrecognised ext
 *     5.  isValidDecalIndexEntry rejects sizeBytes ≤ 0
 *     6.  isValidDecalIndexEntry rejects non-object input
 *     7.  parseDecalIndexJson parses a valid array
 *     8.  parseDecalIndexJson returns wasCorrupt=true for corrupt JSON
 *     9.  parseDecalIndexJson returns empty entries for a non-array value
 *    10.  parseDecalIndexJson filters out invalid entries from mixed arrays
 *
 *   Schema validator
 *    11.  user.imported.* assetId is preserved in validated doc (no UNKNOWN_DECAL_ASSET)
 *    12.  unknown builtin.* assetId still gets UNKNOWN_DECAL_ASSET and resets to placeholder
 *    13.  validated doc with user.imported.* contains no data: URL, no raw path
 *    14.  layout with user.imported.* assetId validates without crash (repairable state)
 *
 *   Asset registry (renderer-side, no IPC)
 *    15.  deleteDecalAsset does not throw when no IPC
 *    16.  scanDecalOrphans returns null when no IPC
 *
 *   Validator: export safety
 *    17.  exported layout JSON contains assetId only — no data:, no fs paths, no base64
 *    18.  forbidden string value in assetId (data: URI) hard-rejects via scanForbiddenProps
 *
 *   DecalInspector (static render)
 *    19.  shows missing-asset warning when assetId is user.imported.* (asset not in initial list)
 *    20.  shows "Use Placeholder" button in missing-asset panel
 *    21.  shows "Import Replacement" button in missing-asset panel
 *    22.  does NOT show Delete button when assetId is the placeholder
 *    23.  does NOT show missing-asset warning when assetId is the placeholder
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  isValidDecalIndexEntry,
  parseDecalIndexJson,
} from '../../appearance/decals/indexHelpers.js'

import {
  deleteDecalAsset,
  scanDecalOrphans,
  invalidateDataUrlCache,
} from '../../appearance/decals/assetRegistry.js'

import { PLACEHOLDER_DECAL_ID } from '../../appearance/decals/placeholder.js'
import DecalInspector from '../inspectors/DecalInspector.jsx'

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_UUID     = '12345678-1234-4234-8234-123456789abc'
const VALID_ASSET_ID = `user.imported.${VALID_UUID}`

function makeValidEntry(overrides = {}) {
  return {
    assetId:    VALID_ASSET_ID,
    label:      'test-image',
    mime:       'image/png',
    ext:        'png',
    sizeBytes:  4096,
    importedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeDecalLayout(assetId) {
  return {
    schemaVersion: 1,
    pluginId: 'compressor',
    root: {
      id: 'root',
      type: 'panel',
      children: [{
        id: 'ff',
        type: 'freeformLayer',
        style: { widthPx: 480, heightPx: 160 },
        props: { snap: { gridPx: 8, enabled: true }, background: 'transparent', clip: 'panel' },
        children: [{
          id: 'dcl',
          type: 'decal',
          props: { assetId, fit: 'contain', opacity: 100, frame: { x: 10, y: 10, widthPx: 80, heightPx: 80 } },
        }],
      }],
    },
  }
}

function makeDecalNode(assetId) {
  return {
    id: 'dcl-1',
    type: 'decal',
    props: { assetId, fit: 'contain', opacity: 100, frame: { x: 0, y: 0, widthPx: 100, heightPx: 100 } },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1–6. isValidDecalIndexEntry
// ─────────────────────────────────────────────────────────────────────────────

describe('isValidDecalIndexEntry', () => {
  it('accepts a well-formed png entry', () => {
    expect(isValidDecalIndexEntry(makeValidEntry())).toBe(true)
  })

  it('accepts a well-formed webp entry', () => {
    expect(isValidDecalIndexEntry(makeValidEntry({ mime: 'image/webp', ext: 'webp' }))).toBe(true)
  })

  it('rejects bad assetId format (wrong prefix)', () => {
    expect(isValidDecalIndexEntry(makeValidEntry({ assetId: 'builtin.placeholder.missing' }))).toBe(false)
  })

  it('rejects bad assetId format (not a uuid)', () => {
    expect(isValidDecalIndexEntry(makeValidEntry({ assetId: 'user.imported.not-a-uuid' }))).toBe(false)
  })

  it('rejects unrecognised mime type', () => {
    expect(isValidDecalIndexEntry(makeValidEntry({ mime: 'image/gif' }))).toBe(false)
    expect(isValidDecalIndexEntry(makeValidEntry({ mime: 'image/svg+xml' }))).toBe(false)
  })

  it('rejects unrecognised extension', () => {
    expect(isValidDecalIndexEntry(makeValidEntry({ ext: 'gif' }))).toBe(false)
    expect(isValidDecalIndexEntry(makeValidEntry({ ext: 'svg' }))).toBe(false)
  })

  it('rejects sizeBytes = 0', () => {
    expect(isValidDecalIndexEntry(makeValidEntry({ sizeBytes: 0 }))).toBe(false)
  })

  it('rejects sizeBytes < 0', () => {
    expect(isValidDecalIndexEntry(makeValidEntry({ sizeBytes: -1 }))).toBe(false)
  })

  it('rejects non-numeric sizeBytes', () => {
    expect(isValidDecalIndexEntry(makeValidEntry({ sizeBytes: '4096' }))).toBe(false)
  })

  it('rejects empty label', () => {
    expect(isValidDecalIndexEntry(makeValidEntry({ label: '' }))).toBe(false)
    expect(isValidDecalIndexEntry(makeValidEntry({ label: '   ' }))).toBe(false)
  })

  it('rejects null', () => {
    expect(isValidDecalIndexEntry(null)).toBe(false)
  })

  it('rejects array', () => {
    expect(isValidDecalIndexEntry([])).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7–10. parseDecalIndexJson
// ─────────────────────────────────────────────────────────────────────────────

describe('parseDecalIndexJson', () => {
  it('parses a valid array and returns wasCorrupt=false', () => {
    const raw = JSON.stringify([makeValidEntry()])
    const { entries, wasCorrupt } = parseDecalIndexJson(raw)
    expect(wasCorrupt).toBe(false)
    expect(entries).toHaveLength(1)
    expect(entries[0].assetId).toBe(VALID_ASSET_ID)
  })

  it('returns wasCorrupt=true for syntactically invalid JSON', () => {
    const { entries, wasCorrupt } = parseDecalIndexJson('{this is not json}')
    expect(wasCorrupt).toBe(true)
    expect(entries).toHaveLength(0)
  })

  it('returns empty entries and wasCorrupt=false for a non-array value', () => {
    const { entries, wasCorrupt } = parseDecalIndexJson(JSON.stringify({ foo: 'bar' }))
    expect(wasCorrupt).toBe(false)
    expect(entries).toHaveLength(0)
  })

  it('filters out invalid entries from a mixed array', () => {
    const raw = JSON.stringify([
      makeValidEntry(),
      { assetId: 'bad', label: 'x', mime: 'image/png', ext: 'png', sizeBytes: 1 },
      null,
      makeValidEntry({ assetId: `user.imported.${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}` }),
    ])
    const { entries } = parseDecalIndexJson(raw)
    expect(entries).toHaveLength(2)
  })

  it('handles an empty array', () => {
    const { entries, wasCorrupt } = parseDecalIndexJson('[]')
    expect(wasCorrupt).toBe(false)
    expect(entries).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 11–14. Schema validator behaviour with user.imported.* assetIds
// ─────────────────────────────────────────────────────────────────────────────

describe('validator: user.imported.* assetId handling', () => {
  it('preserves user.imported.* assetId in validated doc (no UNKNOWN_DECAL_ASSET)', async () => {
    const { validate } = await import('../../schema/validate.js')
    const result = validate(makeDecalLayout(VALID_ASSET_ID))
    expect(result.ok).toBe(true)
    const decal = result.doc.root.children[0].children[0]
    expect(decal.props.assetId).toBe(VALID_ASSET_ID)
    const assetErrors = result.errors.filter(e => e.code === 'UNKNOWN_DECAL_ASSET')
    expect(assetErrors).toHaveLength(0)
  })

  it('soft-resets unknown builtin.* assetId to placeholder (regression guard)', async () => {
    const { validate } = await import('../../schema/validate.js')
    const result = validate(makeDecalLayout('builtin.brand.nonexistent'))
    expect(result.ok).toBe(true)
    const decal = result.doc.root.children[0].children[0]
    expect(decal.props.assetId).toBe(PLACEHOLDER_DECAL_ID)
    expect(result.errors.some(e => e.code === 'UNKNOWN_DECAL_ASSET')).toBe(true)
  })

  it('validated doc with user.imported.* contains no data: URL or raw path', async () => {
    const { validate } = await import('../../schema/validate.js')
    const result = validate(makeDecalLayout(VALID_ASSET_ID))
    const json = JSON.stringify(result.doc)
    expect(json).not.toMatch(/data:/i)
    expect(json).not.toMatch(/C:\\/)
    expect(json).not.toMatch(/\/home\//)
    expect(json).not.toMatch(/base64/)
    expect(json).toContain(VALID_ASSET_ID)
  })

  it('layout with user.imported.* validates without crash even if file is missing', async () => {
    // The validator must NOT crash or hard-reject just because the asset file
    // isn't available at validation time — that is a runtime concern.
    const { validate } = await import('../../schema/validate.js')
    const result = validate(makeDecalLayout(VALID_ASSET_ID))
    expect(result.ok).toBe(true)
    expect(() => JSON.stringify(result.doc)).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Export safety: forbidden values cannot enter layout JSON
// ─────────────────────────────────────────────────────────────────────────────

describe('export safety: forbidden values blocked by validator', () => {
  const forbiddenAssetIds = [
    ['data: URI',        'data:image/png;base64,AAAA=='],
    ['file:// URL',      'file:///C:/images/decal.png'],
    ['Windows path',     'C:\\Users\\test\\image.png'],
    ['Unix path',        '/home/user/image.png'],
    ['https URL',        'https://example.com/image.png'],
    ['path traversal',   '../../etc/passwd'],
  ]

  for (const [label, badId] of forbiddenAssetIds) {
    it(`hard-rejects assetId containing ${label}`, async () => {
      const { validate } = await import('../../schema/validate.js')
      const { isSaveAllowed } = await import('../../designer/validationStatus.js')
      const layout = makeDecalLayout(badId)
      const result = validate(layout)
      // Must produce a hard error — save must not be allowed with this layout
      expect(isSaveAllowed(result)).toBe(false)
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 15–16. Asset registry — no-IPC fallbacks
// ─────────────────────────────────────────────────────────────────────────────

describe('assetRegistry: no-IPC fallbacks', () => {
  beforeEach(() => invalidateDataUrlCache())

  it('deleteDecalAsset does not throw when no IPC is available', async () => {
    await expect(deleteDecalAsset(VALID_ASSET_ID)).resolves.toBeUndefined()
  })

  it('deleteDecalAsset does not throw for placeholder id', async () => {
    await expect(deleteDecalAsset(PLACEHOLDER_DECAL_ID)).resolves.toBeUndefined()
  })

  it('scanDecalOrphans returns null when no IPC is available', async () => {
    const result = await scanDecalOrphans()
    expect(result).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 19–23. DecalInspector — missing-asset UX (static render)
// ─────────────────────────────────────────────────────────────────────────────

describe('DecalInspector: missing-asset UX', () => {
  // renderToStaticMarkup captures the initial render only (no useEffect).
  // Initial assetList state = [{ assetId: placeholder }].
  // Therefore any user.imported.* id appears "missing" in the initial render — correct.

  it('shows missing-asset warning when assetId is user.imported.* (not in initial list)', () => {
    const html = renderToStaticMarkup(
      <DecalInspector node={makeDecalNode(VALID_ASSET_ID)} onPatchProps={() => {}} />,
    )
    expect(html).toContain('pluginui-designer-decal-missing')
    expect(html).toContain('Asset not found in local registry')
  })

  it('shows "Use Placeholder" button in missing-asset panel', () => {
    const html = renderToStaticMarkup(
      <DecalInspector node={makeDecalNode(VALID_ASSET_ID)} onPatchProps={() => {}} />,
    )
    expect(html).toContain('Use Placeholder')
  })

  it('shows "Import Replacement" button in missing-asset panel', () => {
    const html = renderToStaticMarkup(
      <DecalInspector node={makeDecalNode(VALID_ASSET_ID)} onPatchProps={() => {}} />,
    )
    expect(html).toContain('Import Replacement')
  })

  it('does NOT show missing-asset panel when assetId is the placeholder', () => {
    const html = renderToStaticMarkup(
      <DecalInspector node={makeDecalNode(PLACEHOLDER_DECAL_ID)} onPatchProps={() => {}} />,
    )
    expect(html).not.toContain('pluginui-designer-decal-missing')
    expect(html).not.toContain('Asset not found in local registry')
  })

  it('does NOT show Delete Asset button when assetId is the placeholder', () => {
    const html = renderToStaticMarkup(
      <DecalInspector node={makeDecalNode(PLACEHOLDER_DECAL_ID)} onPatchProps={() => {}} />,
    )
    expect(html).not.toContain('Delete Asset')
  })

  it('still shows the Import PNG/WebP button regardless of missing-asset state', () => {
    const missingHtml = renderToStaticMarkup(
      <DecalInspector node={makeDecalNode(VALID_ASSET_ID)} onPatchProps={() => {}} />,
    )
    const placeholderHtml = renderToStaticMarkup(
      <DecalInspector node={makeDecalNode(PLACEHOLDER_DECAL_ID)} onPatchProps={() => {}} />,
    )
    expect(missingHtml).toContain('Import PNG/WebP')
    expect(placeholderHtml).toContain('Import PNG/WebP')
  })

  it('does not render any text or URL input fields', () => {
    const html = renderToStaticMarkup(
      <DecalInspector node={makeDecalNode(VALID_ASSET_ID)} onPatchProps={() => {}} />,
    )
    expect(html).not.toMatch(/<input[^>]+type="text"/i)
    expect(html).not.toMatch(/<input[^>]+type="url"/i)
  })
})
