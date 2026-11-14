/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { timelineEvents } from '../../../timelineEvents.js'
import { useRoamDraftStore } from '../../../lensRoam/useLensRoam.js'
import useLensPanelMode from '../../../lensRoam/lensPanelMode.js'
import LensPanel from '../LensPanel.jsx'
import RoamPanel from '../RoamPanel.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const LENS = { fit: 'Cover', centerX: 0.5, centerY: 0.5, zoom: 1, rotationDeg: 0, flip: 'FollowTrack' }
const ROAM = { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, bounds: 'Clip', layer: 'GridOrder' }
const LAYOUT = {
  columns: 3, rows: 3, canvasWidth: 1920, canvasHeight: 1080, gapScale: 0,
  slots: [{ trackId: 7, gridX: 8, gridY: 8, spanX: 8, spanY: 8 }], fullscreenLayers: [],
}

let container
let root
let timeline
let store // the engine's current values, so a refetch after undo sees them

// The hooks chain several awaits (engine fetch, then geometry); let them all settle.
const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)   // jsdom has no 2D context; the draw effects bail on null
  store = { lens: { ...LENS }, roam: { ...ROAM } }
  timeline = {
    getLensRoam: vi.fn(async () => ({
      clips: [{ clipId: 5, lens: store.lens }],
      sources: [{ trackId: 7, regionId: 3, explicit: false, lens: store.lens }],
      tracks: [{ trackId: 7, roam: store.roam }],
      missing: { clipIds: [], sources: [], trackIds: [] },
    })),
    setClipLens: vi.fn(async (clipId, p) => { store.lens = { ...store.lens, ...p }; return { clipId, changed: true, lens: store.lens } }),
    resetClipLens: vi.fn(async (clipId) => { store.lens = { ...LENS, fit: store.lens.fit }; return { clipId, changed: true, lens: store.lens } }),
    setTrackLens: vi.fn(async (trackId, regionId, p) => { store.lens = { ...store.lens, ...p }; return { trackId, regionId, changed: true, explicit: true, lens: store.lens } }),
    resetTrackLens: vi.fn(),
    setTrackRoam: vi.fn(async (trackId, p) => { store.roam = { ...store.roam, ...p }; return { trackId, changed: true, roam: store.roam } }),
    resetTrackRoam: vi.fn(async (trackId) => { store.roam = { ...ROAM }; return { trackId, changed: true, roam: store.roam } }),
    getGridLayout: vi.fn(async () => LAYOUT),
    getTracks: vi.fn(async () => [{ id: 7, name: 'Chorus', gapScaleOverride: -1 }]),
  }
  window.xleth = { timeline, video: { getFrameAtTime: vi.fn(async () => null) } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useRoamDraftStore.getState().clearDraft()
  useLensPanelMode.setState({ mode: 'simple' })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete window.xleth
  vi.restoreAllMocks()
})

const hintOf = (el) => el.closest('[data-hint], [aria-label]')?.getAttribute('data-hint')
const byLabel = (label) => container.querySelector(`[aria-label="${label}"]`)

describe('LensPanel', () => {
  const mount = async (target = { kind: 'clip', clipId: 5 }, context = 'Take 1 · this event only') => {
    await act(async () => { root.render(<LensPanel target={target} cellTrackId={7} context={context} frameRef={null} />) })
    await flush()
  }

  it('shows the context in its header and asks the engine for the target', async () => {
    await mount({ kind: 'source', trackId: 7, regionId: 3 }, 'Chorus · applies to all notes')
    expect(container.querySelector('[data-testid="xleth-lens-context"]').textContent).toBe('Chorus · applies to all notes')
    expect(timeline.getLensRoam).toHaveBeenCalledWith({ sources: [{ trackId: 7, regionId: 3 }] })
  })

  it('has every control the spec lists, each with hint text for the info bar', async () => {
    await mount()
    for (const name of ['Zoom', 'Center X', 'Center Y', 'Rotate', 'Lens fit', 'Lens flip']) {
      const el = byLabel(name)
      expect(el, name).not.toBeNull()
      expect(hintOf(el), `${name} hint`).toBeTruthy()
    }
    expect(container.querySelector('[data-testid="lens-frame-canvas"]').getAttribute('data-hint')).toBeTruthy()
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Reset')).toBe(true)
    // P9: the Simple | Advanced toggle, Simple by default; Simple shows nothing of the Advanced block.
    const mode = byLabel('Lens panel mode')
    expect(mode).not.toBeNull()
    expect(hintOf(mode)).toBeTruthy()
    expect([...mode.querySelectorAll('[role="radio"]')].map((r) => `${r.textContent}:${r.getAttribute('aria-checked')}`)).toEqual(['Simple:true', 'Advanced:false'])
    expect(container.querySelector('[data-testid="lens-advanced"]')).toBeNull()
  })

  it('a Fit change is one setClipLens with only that field', async () => {
    await mount()
    const contain = [...container.querySelectorAll('[role="radio"]')].find((r) => r.textContent === 'Contain')
    await act(async () => { contain.click() })
    await flush()
    expect(timeline.setClipLens).toHaveBeenCalledTimes(1)
    expect(timeline.setClipLens).toHaveBeenCalledWith(5, { fit: 'Contain' })
  })

  it('a source target writes through setTrackLens with the {trackId, regionId} key', async () => {
    await mount({ kind: 'source', trackId: 7, regionId: 3 })
    const contain = [...container.querySelectorAll('[role="radio"]')].find((r) => r.textContent === 'Stretch')
    await act(async () => { contain.click() })
    await flush()
    expect(timeline.setTrackLens).toHaveBeenCalledWith(7, 3, { fit: 'Stretch' })
  })

  it('Reset is disabled while the framing is neutral and calls resetClipLens otherwise', async () => {
    await mount()
    const reset = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Reset')
    expect(reset().disabled).toBe(true)
    store.lens = { ...store.lens, zoom: 2 }
    await act(async () => { timelineEvents.dispatchEvent(new Event('timeline-track-layout-changed')) })
    await flush()
    expect(reset().disabled).toBe(false)
    await act(async () => { reset().click() })
    await flush()
    expect(timeline.resetClipLens).toHaveBeenCalledWith(5)
  })

  it('follows an undo: the keyboard path refreshes through the arrangement events', async () => {
    await mount()
    store.lens = { ...store.lens, zoom: 2.5 }                       // the engine undid or redid something
    await act(async () => { timelineEvents.dispatchEvent(new Event('timeline-track-layout-changed')) })
    await flush()
    expect(byLabel('Zoom').getAttribute('aria-valuetext')).toContain('2.50')
  })

  it('never sends anything while a value is only previewed', async () => {
    await mount()
    expect(timeline.setClipLens).not.toHaveBeenCalled()
  })
})

describe('RoamPanel', () => {
  const mount = async () => {
    await act(async () => { root.render(<RoamPanel trackId={7} context="Chorus · moves this cell on the picture" />) })
    await flush()
  }

  it('has Units, Offset X/Y, Scale, Rotate, Bounds, Layer and Back to grid box, each with a hint', async () => {
    await mount()
    for (const name of ['Roam units', 'Offset X', 'Offset Y', 'Scale', 'Rotate', 'Roam bounds', 'Roam layer']) {
      const el = byLabel(name)
      expect(el, name).not.toBeNull()
      expect(hintOf(el), `${name} hint`).toBeTruthy()
    }
    const back = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Back to grid box')
    expect(back).toBeTruthy()
    expect(back.getAttribute('data-hint')).toBeTruthy()
  })

  it('stores offset in cells whichever unit is shown', async () => {
    await mount()
    store.roam = { ...ROAM, offsetX: 0.5 }
    await act(async () => { timelineEvents.dispatchEvent(new Event('timeline-grid-changed')) })
    await flush()
    expect(byLabel('Offset X').getAttribute('aria-valuetext')).toContain('0.50')
    const px = [...container.querySelectorAll('[role="radio"]')].find((r) => r.textContent === 'Pixels')
    await act(async () => { px.click() })
    await flush()
    // 0.5 cell of a 3x3 on a 1920 canvas = 320 px, display only.
    expect(byLabel('Offset X').getAttribute('aria-valuetext')).toContain('320')
    expect(timeline.setTrackRoam).not.toHaveBeenCalled()
  })

  it('Layer only applies when Bounds is Float', async () => {
    await mount()
    expect(byLabel('Roam layer').disabled).toBe(true)
    const float = [...container.querySelectorAll('[role="radio"]')].find((r) => r.textContent === 'Float')
    await act(async () => { float.click() })
    await flush()
    expect(timeline.setTrackRoam).toHaveBeenCalledWith(7, { bounds: 'Float' })
    expect(byLabel('Roam layer').disabled).toBe(false)
  })

  it('Back to grid box is one resetTrackRoam, enabled only once the cell has moved', async () => {
    await mount()
    const back = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Back to grid box')
    expect(back().disabled).toBe(true)
    store.roam = { ...ROAM, offsetX: 1, scale: 1.5 }
    await act(async () => { timelineEvents.dispatchEvent(new Event('timeline-grid-changed')) })
    await flush()
    await act(async () => { back().click() })
    await flush()
    expect(timeline.resetTrackRoam).toHaveBeenCalledTimes(1)
    expect(timeline.resetTrackRoam).toHaveBeenCalledWith(7)
  })

  it('a draft from the viewer overlay shows in the inspector without touching the engine', async () => {
    await mount()
    await act(async () => { useRoamDraftStore.getState().setDraft(7, { scale: 2 }) })
    expect(byLabel('Scale').getAttribute('aria-valuetext')).toContain('2.00')
    expect(timeline.setTrackRoam).not.toHaveBeenCalled()
  })
})
