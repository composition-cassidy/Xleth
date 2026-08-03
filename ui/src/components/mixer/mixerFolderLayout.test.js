import { describe, expect, it } from 'vitest'
import { buildMixerFolderLayout } from './mixerFolderLayout.js'

describe('mixer folder layout', () => {
  const tracks = { 1: { id: 1 }, 2: { id: 2 }, 3: { id: 3 } }

  it('preserves root order, spans members, and ignores timeline collapse', () => {
    const result = buildMixerFolderLayout({
      rootOrder: [{ kind: 'folder', id: 10 }, { kind: 'track', id: 3 }],
      folders: [{ id: 10, name: 'Drums', collapsed: true, trackIds: [1, 2] }],
    }, tracks)
    expect(result.hasFolderHeaders).toBe(true)
    expect(result.items.map(item => item.kind)).toEqual(['folder', 'track'])
    expect(result.items[0].trackIds).toEqual([1, 2])
  })

  it('omits empty folders and leaves the legacy full-height path active', () => {
    const result = buildMixerFolderLayout({
      rootOrder: [{ kind: 'track', id: 1 }, { kind: 'folder', id: 10 }],
      folders: [{ id: 10, name: 'Empty', collapsed: false, trackIds: [] }],
    }, tracks)
    expect(result.hasFolderHeaders).toBe(false)
    expect(result.items).toEqual([{ kind: 'track', id: 1 }])
  })
})
