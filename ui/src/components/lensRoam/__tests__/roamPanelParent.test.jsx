/**
 * @vitest-environment jsdom
 */
// RoamPanel's Parent row (docs/XLETH_MOTION_VIEW_DESIGN.md R6, R8, 5.6): the shared
// ParentPicker names the parent; a choice is ONE setTrackParent (Alt = keep on screen
// at the playhead), and the line under it (and the hint bar) says what happened,
// naming any keyed channel that could not be kept.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { playheadClock } from '../../../services/PlayheadClock.js'
import { useRoamDraftStore } from '../../../lensRoam/useLensRoam.js'
import useRoamKeysStore from '../../../stores/useRoamKeysStore.js'
import { HINT_REFRESH_EVENT } from '../../../ui-kit/hint.ts'
import RoamPanel from '../RoamPanel.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ROAM = { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, bounds: 'Clip', layer: 'GridOrder' }
const LAYOUT = {
  columns: 3, rows: 3, canvasWidth: 1920, canvasHeight: 1080, gapScale: 0,
  slots: [{ trackId: 7, gridX: 8, gridY: 8, spanX: 8, spanY: 8 }], fullscreenLayers: [],
}

let container
let root
let timeline
let store

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  try { window.localStorage?.clear() } catch { /* storage can be blocked */ }
  store = {
    roam: { ...ROAM },
    keys: [],
    parent: -1,
    tracks: [
      { id: 7, name: 'Chorus', gapScaleOverride: -1, parentTrackId: -1 },
      { id: 3, name: 'Bass', gapScaleOverride: -1, parentTrackId: -1 },
      { id: 9, name: 'Keys', gapScaleOverride: -1, parentTrackId: 7 },
    ],
    next: null,     // the next setTrackParent result override
  }
  timeline = {
    getLensRoam: vi.fn(async () => ({
      clips: [], sources: [],
      tracks: [{ trackId: 7, roam: store.roam, keys: store.keys, masks: [], parentTrackId: store.parent }],
      missing: { clipIds: [], sources: [], trackIds: [] },
    })),
    setTrackRoam: vi.fn(async (trackId, p) => { store.roam = { ...store.roam, ...p }; return { trackId, changed: true, roam: store.roam, keys: store.keys } }),
    setTrackRoamKeys: vi.fn(async (trackId, keys) => { store.keys = keys; return { trackId, changed: true, roam: store.roam, keys } }),
    setTrackParent: vi.fn(async (trackId, parentTrackId, opts) => {
      if (store.next) { const r = store.next; store.next = null; return { trackId, roam: store.roam, keys: store.keys, compensated: [], uncompensated: [], ...r } }
      store.parent = parentTrackId
      store.tracks = store.tracks.map((t) => (t.id === trackId ? { ...t, parentTrackId } : t))
      const keep = !!opts?.keepOnScreen
      return {
        trackId, changed: true, parentTrackId, roam: store.roam, keys: store.keys,
        compensated: keep ? ['offsetX', 'offsetY', 'scale', 'rotationDeg'] : [], uncompensated: [],
      }
    }),
    resetTrackRoam: vi.fn(async (trackId) => ({ trackId, changed: true, roam: ROAM, keys: store.keys })),
    getGridLayout: vi.fn(async () => LAYOUT),
    getTracks: vi.fn(async () => store.tracks),
  }
  window.xleth = { timeline }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useRoamDraftStore.getState().clearDraft()
  useRoamKeysStore.setState({ autoKey: false, laneOpen: new Set(), channelByTrack: {}, selected: null, draft: null })
  playheadClock.positionBeatsValue = 2   // tick 1920
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete window.xleth
  playheadClock.positionBeatsValue = 0
  vi.restoreAllMocks()
})

const mount = async () => {
  await act(async () => { root.render(<RoamPanel trackId={7} context="Chorus" />) })
  await flush()
}
const picker = () => container.querySelector('[data-testid="roam-parent-picker"]')
const note = () => container.querySelector('[data-testid="roam-parent-note"]')
const itemNamed = (name) => [...document.querySelectorAll('[role^="menuitem"]')].find((el) => el.textContent === name)
const click = (el, init = {}) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })) })
const choose = async (name, init = {}) => {
  await click(picker())
  await click(itemNamed(name), init)
  await flush()
}

describe('RoamPanel: Parent', () => {
  it('shows the picker naming the parent, with its hint; never offers itself or a track that follows it', async () => {
    await mount()
    expect(picker().textContent).toBe('Parent: none')
    expect(picker().getAttribute('data-hint')).toMatch(/^Parent: this cell follows another track/)
    await click(picker())
    expect(itemNamed('Bass')).toBeTruthy()
    expect(itemNamed('Chorus')).toBeUndefined()       // itself
    expect(itemNamed('Keys')).toBeUndefined()         // Keys follows Chorus: a loop
  })

  it('a plain choice: ONE setTrackParent with no options; the cell may jump, and the note says so', async () => {
    await mount()
    const refresh = vi.fn()
    window.addEventListener(HINT_REFRESH_EVENT, refresh)
    await choose('Bass')
    expect(timeline.setTrackParent).toHaveBeenCalledTimes(1)
    expect(timeline.setTrackParent.mock.calls[0]).toEqual([7, 3])
    expect(picker().textContent).toBe('Parent: Bass')
    expect(note().textContent).toBe('Now follows Bass. Its Roam values are kept, so it may jump; hold Alt while choosing to keep it in place.')
    expect(picker().getAttribute('data-hint')).toMatch(/^Now follows Bass\./)
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ hint: note().textContent }) }))
    window.removeEventListener(HINT_REFRESH_EVENT, refresh)
    // Folded, the section's summary names the parent.
    const section = container.querySelector('[data-testid="xleth-roam-panel"]')
    await click(section.querySelector('button[aria-expanded]'))
    expect(section.querySelector('h3').textContent).toContain('Follows Bass · at its grid box')
  })

  it('Alt while choosing: keepOnScreen at the playhead tick; all four kept', async () => {
    await mount()
    await choose('Bass', { altKey: true })
    expect(timeline.setTrackParent.mock.calls[0]).toEqual([7, 3, { keepOnScreen: true, tick: 1920 }])
    expect(note().textContent).toBe('Now follows Bass. It keeps its place on screen.')
  })

  it('Alt with keyed channels: the note names what could not be kept (R6)', async () => {
    await mount()
    store.next = { changed: true, parentTrackId: 3, compensated: ['scale'], uncompensated: ['offsetX', 'offsetY', 'rotationDeg'] }
    await choose('Bass', { altKey: true })
    expect(note().textContent).toBe('Now follows Bass. Offset X, Y and Rotation are keyed: they keep their keys and may jump.')
  })

  it('one keyed channel reads singular; an unplaced child says there was nothing to keep', async () => {
    await mount()
    store.next = { changed: true, parentTrackId: 3, compensated: ['offsetX', 'offsetY', 'rotationDeg'], uncompensated: ['scale'] }
    await choose('Bass', { altKey: true })
    expect(note().textContent).toBe('Now follows Bass. Scale is keyed: it keeps its keys and may jump.')
    store.next = { changed: true, parentTrackId: 3, keepOnScreenSkipped: 'not_placed' }
    await choose('None', { altKey: true })
    expect(note().textContent).toBe('Detached. It has no cell at the playhead, so there was no place on screen to keep.')
  })

  it('a refused choice changes nothing and says why', async () => {
    await mount()
    store.next = { changed: false, parentTrackId: -1, rejected: 'too_deep' }
    await choose('Bass')
    expect(note().textContent).toBe('Not attached: the chain would be deeper than 4 parents.')
    expect(picker().textContent).toBe('Parent: none')
    store.next = { changed: false, parentTrackId: -1, rejected: 'cycle' }
    await choose('Bass')
    expect(note().textContent).toBe('Not attached: Bass already follows this track, so that would be a loop.')
  })

  it('detaching (None) is one call with -1', async () => {
    store.parent = 3
    store.tracks = store.tracks.map((t) => (t.id === 7 ? { ...t, parentTrackId: 3 } : t))
    await mount()
    expect(picker().textContent).toBe('Parent: Bass')
    await choose('None')
    expect(timeline.setTrackParent.mock.calls[0]).toEqual([7, -1])
    expect(picker().textContent).toBe('Parent: none')
    expect(note().textContent).toMatch(/^Detached\./)
  })
})
