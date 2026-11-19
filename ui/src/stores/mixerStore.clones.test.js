// Clones have no audio (docs/XLETH_CLONE_SPEC.md): the mixer gives them no strip,
// no route and no send, and their ids leave the folder layout with them.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const lead = { id: 1, name: 'Lead', type: 'Pattern', muted: false, solo: false, visualOnly: false, cloneOf: -1 }
const c1 = { id: 2, name: 'Lead · Clone 1', type: 'Pattern', muted: false, solo: false, visualOnly: true, cloneOf: 1, clone: { kind: 'Voice' } }
const t1 = { id: 3, name: 'Lead · Trail 1', type: 'Pattern', muted: false, solo: false, visualOnly: true, cloneOf: 1, clone: { kind: 'Trail' } }
const bass = { id: 4, name: 'Bass', type: 'Clip', muted: false, solo: false, visualOnly: false, cloneOf: -1 }
const all = [lead, c1, t1, bass]

describe('withoutCloneTracks', () => {
  beforeEach(() => { vi.resetModules() })

  it('drops Clones from the list and from the root order and folders', async () => {
    const { withoutCloneTracks } = await import('./mixerStore.js')
    const layout = {
      rootOrder: [{ kind: 'folder', id: 'f' }, { kind: 'track', id: 4 }],
      folders: [{ id: 'f', name: 'Leads', collapsed: false, trackIds: [1, 2, 3] }],
    }
    const out = withoutCloneTracks(all, layout)
    expect(out.list.map((t) => t.id)).toEqual([1, 4])
    expect(out.layout.folders[0].trackIds).toEqual([1])
    expect(out.layout.rootOrder).toEqual([{ kind: 'folder', id: 'f' }, { kind: 'track', id: 4 }])
    const flat = withoutCloneTracks(all, { rootOrder: all.map((t) => ({ kind: 'track', id: t.id })), folders: [] })
    expect(flat.layout.rootOrder.map((i) => i.id)).toEqual([1, 4])
  })

  it('is the identity for a project with no Clones', async () => {
    const { withoutCloneTracks } = await import('./mixerStore.js')
    const list = [lead, bass]
    const layout = { rootOrder: [], folders: [] }
    const out = withoutCloneTracks(list, layout)
    expect(out.list).toBe(list)
    expect(out.layout).toBe(layout)
  })
})

describe('mixer sync hides Clones', () => {
  beforeEach(() => {
    vi.resetModules()
    globalThis.window = { xleth: { timeline: { getRouting: vi.fn(async () => []) }, audio: {} } }
  })

  it('syncFromTimeline gives Clones no strip and keeps the engine folder layout', async () => {
    const { default: useMixerStore } = await import('./mixerStore.js')
    const layout = {
      rootOrder: [{ kind: 'folder', id: 'f' }, { kind: 'track', id: 4 }],
      folders: [{ id: 'f', name: 'Leads', collapsed: false, trackIds: [1, 2, 3] }],
    }
    useMixerStore.getState().syncFromTimeline(all, layout)
    const s = useMixerStore.getState()
    expect(s.trackOrder).toEqual([1, 4])
    expect(Object.keys(s.tracks).map(Number).sort()).toEqual([1, 4])
    expect(Object.keys(s.outputRoutes).map(Number).sort()).toEqual([1, 4])
    // The layout was not thrown away for a flat one: the folder survives, minus the Clones.
    expect(s.trackLayout.folders).toEqual([{ id: 'f', name: 'Leads', collapsed: false, trackIds: [1] }])
  })

  it('init reads the same way', async () => {
    window.xleth.timeline.getTracks = vi.fn(async () => all)
    window.xleth.timeline.getTrackLayout = vi.fn(async () => null)
    window.xleth.audio.getMasterVolume = vi.fn(async () => 1)
    const { default: useMixerStore } = await import('./mixerStore.js')
    await useMixerStore.getState().init()
    expect(useMixerStore.getState().trackOrder).toEqual([1, 4])
  })
})
