/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { playheadClock } from '../../../services/PlayheadClock.js'
import { useRoamDraftStore } from '../../../lensRoam/useLensRoam.js'
import useRoamKeysStore from '../../../stores/useRoamKeysStore.js'
import useInspectorStore from '../../../stores/useInspectorStore.js'
import RoamOverlayCanvas from '../RoamOverlayCanvas.jsx'
import RoamPanel from '../RoamPanel.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ROAM = { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, bounds: 'Clip', layer: 'GridOrder' }
const LAYOUT = {
  columns: 3, rows: 3, canvasWidth: 1920, canvasHeight: 1080, gapScale: 0,
  slots: [{ trackId: 7, gridX: 8, gridY: 8, spanX: 8, spanY: 8 }], fullscreenLayers: [],
}
const K = (channel, pos, value, interp = 'Linear') => ({ channel, anchor: 'Origin', pos, value, interp })
const BAR = 3840

let container
let root
let timeline
let store

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
const setPlayheadTick = (tick) => { playheadClock.positionBeatsValue = tick / 960 }

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)   // no 2D context in jsdom; draws bail
  // The overlay measures itself with a ResizeObserver: a 960 x 540 picture.
  globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb }
    observe() { this.cb([{ contentRect: { width: 960, height: 540 } }]) }
    disconnect() {}
  }
  store = { roam: { ...ROAM }, keys: [] }
  timeline = {
    getLensRoam: vi.fn(async () => ({
      clips: [], sources: [], tracks: [{ trackId: 7, roam: store.roam, keys: store.keys }],
      missing: { clipIds: [], sources: [], trackIds: [] },
    })),
    setTrackRoam: vi.fn(async (trackId, p) => { store.roam = { ...store.roam, ...p }; return { trackId, changed: true, roam: store.roam, keys: store.keys } }),
    setTrackRoamKeys: vi.fn(async (trackId, keys) => { store.keys = keys; return { trackId, changed: true, roam: store.roam, keys } }),
    resetTrackRoam: vi.fn(async (trackId) => ({ trackId, changed: true, roam: ROAM, keys: store.keys })),
    getGridLayout: vi.fn(async () => LAYOUT),
    getTracks: vi.fn(async () => [{ id: 7, name: 'Chorus', gapScaleOverride: -1 }]),
  }
  window.xleth = { timeline }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useRoamDraftStore.getState().clearDraft()
  useRoamKeysStore.setState({ autoKey: false, laneOpen: new Set(), channelByTrack: {}, selected: null, draft: null })
  useInspectorStore.setState({ selection: { kind: 'track', trackId: 7 } })
  setPlayheadTick(0)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete window.xleth
  delete globalThis.ResizeObserver
  setPlayheadTick(0)
  vi.restoreAllMocks()
})

const byLabel = (label) => container.querySelector(`[aria-label="${label}"]`)
const button = (text) => [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === text)

describe('viewer overlay: keys', () => {
  let parent
  const mountOverlay = async () => {
    await act(async () => { root.render(<div data-testid="picture"><RoamOverlayCanvas aspect={16 / 9} /></div>) })
    await flush()
    parent = container.querySelector('[data-testid="picture"]')
  }
  const fire = (type, x, y, extra = {}) => act(async () => {
    parent.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, ...extra }))
  })
  // The home cell of the fixture is the middle ninth of a 960 x 540 picture: centre (480, 270).

  it('a drag on a key dot moves that key: one draft stream, ONE setTrackRoamKeys on pointerup', async () => {
    store.keys = [K('offsetX', 0, 0), K('offsetX', BAR, 2)]
    await mountOverlay()
    // The dot at tick 3840: offsetX 2 cells = 2/3 of the picture to the right of the home centre.
    const dotX = 480 + (2 / 3) * 960
    await fire('pointerdown', dotX, 270)
    expect(useRoamKeysStore.getState().selected).toEqual({ trackId: 7, channel: 'offsetX', pos: BAR })
    await fire('pointermove', dotX - 50, 270)
    await fire('pointermove', dotX - 100, 270)
    expect(timeline.setTrackRoamKeys).not.toHaveBeenCalled()       // local preview only
    expect(timeline.setTrackRoam).not.toHaveBeenCalled()
    await fire('pointerup', dotX - 100, 270)
    await flush()
    expect(timeline.setTrackRoamKeys).toHaveBeenCalledTimes(1)
    const [trackId, keys] = timeline.setTrackRoamKeys.mock.calls[0]
    expect(trackId).toBe(7)
    const x = keys.find((k) => k.channel === 'offsetX' && k.pos === BAR)
    expect(x.value).toBeCloseTo(2 - 100 / 960 / (1 / 3), 6)        // moved 100 px left
    expect(keys.find((k) => k.channel === 'offsetY' && k.pos === BAR).value).toBeCloseTo(0, 9)
    expect(keys.find((k) => k.channel === 'offsetX' && k.pos === 0).value).toBe(0)
    expect(useRoamKeysStore.getState().draft).toBeNull()
  })

  it('Escape cancels a dot drag: nothing sent', async () => {
    store.keys = [K('offsetX', 0, 0), K('offsetX', BAR, 2)]
    await mountOverlay()
    const dotX = 480 + (2 / 3) * 960
    await fire('pointerdown', dotX, 270)
    await fire('pointermove', dotX - 100, 270)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await fire('pointerup', dotX - 100, 270)
    await flush()
    expect(timeline.setTrackRoamKeys).not.toHaveBeenCalled()
    expect(useRoamKeysStore.getState().draft).toBeNull()
  })

  it('Auto-key: moving the cell writes a key at the playhead, plus a rest key a bar earlier', async () => {
    useRoamKeysStore.setState({ autoKey: true })
    setPlayheadTick(BAR)
    await mountOverlay()
    await fire('pointerdown', 480, 270)
    await fire('pointermove', 528, 270)
    await fire('pointermove', 576, 270)                           // 96 px = 0.1 of the picture = 0.3 cells
    await fire('pointerup', 576, 270)
    await flush()
    expect(timeline.setTrackRoam).not.toHaveBeenCalled()          // the base is untouched
    expect(timeline.setTrackRoamKeys).toHaveBeenCalledTimes(1)
    const keys = timeline.setTrackRoamKeys.mock.calls[0][1]
    expect(keys).toHaveLength(2)                                  // offsetY did not change: no key
    expect(keys[0]).toMatchObject({ channel: 'offsetX', anchor: 'Origin', pos: 0, value: 0 })
    expect(keys[1]).toMatchObject({ channel: 'offsetX', pos: BAR })
    expect(keys[1].value).toBeCloseTo(0.3, 6)
  })

  it('Auto-key off, parameter unkeyed: the static edit it always was', async () => {
    await mountOverlay()
    await fire('pointerdown', 480, 270)
    await fire('pointermove', 576, 270)
    await fire('pointerup', 576, 270)
    await flush()
    expect(timeline.setTrackRoamKeys).not.toHaveBeenCalled()
    expect(timeline.setTrackRoam).toHaveBeenCalledTimes(1)
    expect(timeline.setTrackRoam.mock.calls[0][1].offsetX).toBeCloseTo(0.3, 6)
  })

  it('a keyed parameter with Auto-key off refuses the drag: not-allowed cursor, the reason in the hint, nothing sent', async () => {
    store.keys = [K('offsetX', 0, 0), K('offsetX', BAR, 2)]
    await mountOverlay()
    // Inside the cell but off its centre (the centre carries the key dot at tick 0).
    await fire('pointermove', 540, 270)
    expect(parent.style.cursor).toBe('not-allowed')
    expect(parent.getAttribute('data-hint')).toMatch(/Auto-key/)
    await fire('pointerdown', 540, 270)
    await fire('pointermove', 636, 270)
    await fire('pointerup', 636, 270)
    await flush()
    expect(timeline.setTrackRoam).not.toHaveBeenCalled()
    expect(timeline.setTrackRoamKeys).not.toHaveBeenCalled()
  })

  it('an unkeyed parameter of a keyed track still scales normally', async () => {
    store.keys = [K('offsetX', 0, 0), K('offsetX', BAR, 2)]
    await mountOverlay()
    // top-right corner square of the home cell: centre + (160, -90)
    await fire('pointerdown', 480 + 160, 270 - 90)
    await fire('pointermove', 480 + 240, 270 - 135)
    await fire('pointerup', 480 + 240, 270 - 135)
    await flush()
    expect(timeline.setTrackRoam).toHaveBeenCalledTimes(1)
    expect(timeline.setTrackRoam.mock.calls[0][1].scale).toBeGreaterThan(1)
  })
})

describe('Roam inspector: keys', () => {
  const mountPanel = async () => {
    await act(async () => { root.render(<RoamPanel trackId={7} context="Chorus" />) })
    await flush()
  }

  it('Auto-key is a toggle in the section header', async () => {
    await mountPanel()
    expect(useRoamKeysStore.getState().autoKey).toBe(false)
    const toggle = [...container.querySelectorAll('[aria-pressed]')].find((b) => /^(On|Off)$/.test(b.textContent.trim()))
    await act(async () => { toggle.click() })
    expect(useRoamKeysStore.getState().autoKey).toBe(true)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })

  it('Key at playhead is ONE setTrackRoamKeys with the value the cell has there', async () => {
    store.roam = { ...ROAM, offsetX: 0.5 }
    setPlayheadTick(960)
    await mountPanel()
    await act(async () => { button('Key at playhead').click() })
    await flush()
    expect(timeline.setTrackRoamKeys).toHaveBeenCalledTimes(1)
    expect(timeline.setTrackRoamKeys.mock.calls[0]).toEqual([7, [K('offsetX', 960, 0.5)]])
    expect(useRoamKeysStore.getState().selected).toEqual({ trackId: 7, channel: 'offsetX', pos: 960 })
  })

  it('a keyed parameter is read-only with Auto-key off and says why, pointing at Motion view', async () => {
    store.keys = [K('offsetX', 0, 0), K('offsetX', BAR, 2)]
    setPlayheadTick(BAR)
    await mountPanel()
    expect(byLabel('Offset X').getAttribute('aria-disabled')).toBe('true')
    expect(byLabel('Offset X').getAttribute('aria-valuetext')).toContain('2.00')     // the value AT THE PLAYHEAD, not the base
    expect(byLabel('Offset Y').getAttribute('aria-disabled')).toBeNull()
    const note = container.querySelector('[data-testid="roam-keyed-note"]').textContent
    expect(note).toMatch(/Offset X is keyed/)
    expect(note).toMatch(/Motion view/)
    expect(note).not.toMatch(/\blane\b/)
  })

  // docs/XLETH_MOTION_VIEW_DESIGN.md R17 / 5.6: the Edit view has no key lane; the
  // inspector's "Key lane" switch became "Show in Motion view".
  it('"Show in Motion view" asks for the reveal of this track\'s Roam rows; no lane switch is left', async () => {
    store.keys = [K('offsetX', 0, 0), K('offsetX', BAR, 2)]
    const seen = []
    const onReveal = (e) => seen.push(e.detail)
    window.addEventListener('xleth-motion-reveal', onReveal)
    try {
      await mountPanel()
      expect([...container.querySelectorAll('[aria-pressed]')].some((b) => /^(Shown|Hidden)$/.test(b.textContent.trim()))).toBe(false)
      expect(byLabel('Key lane')).toBeNull()
      const show = button('Show in Motion view')
      expect(show).toBeTruthy()
      expect(show.getAttribute('data-testid')).toBe('roam-show-in-motion')
      expect(show.getAttribute('data-hint')).toMatch(/Motion view \(`\)/)
      expect(show.disabled).toBe(false)
      const before = useRoamKeysStore.getState()
      await act(async () => { show.click() })
      expect(seen).toEqual([{ trackId: 7, path: ['roam'] }])
      // A view request only: no engine write, no lane state, no key selection change.
      expect(timeline.setTrackRoamKeys).not.toHaveBeenCalled()
      expect(timeline.setTrackRoam).not.toHaveBeenCalled()
      expect(useRoamKeysStore.getState().laneOpen).toBe(before.laneOpen)
      expect(useRoamKeysStore.getState().selected).toBe(before.selected)
    } finally {
      window.removeEventListener('xleth-motion-reveal', onReveal)
    }
  })

  it('a track with no cell can still be shown in Motion view; the hint says it moves nothing yet', async () => {
    timeline.getGridLayout = vi.fn(async () => ({ ...LAYOUT, slots: [] }))
    const seen = []
    const onReveal = (e) => seen.push(e.detail)
    window.addEventListener('xleth-motion-reveal', onReveal)
    try {
      await mountPanel()
      const show = button('Show in Motion view')
      expect(show.disabled).toBe(false)
      expect(show.getAttribute('data-hint')).toMatch(/no cell on the grid/)
      await act(async () => { show.click() })
      expect(seen).toEqual([{ trackId: 7, path: ['roam'] }])
    } finally {
      window.removeEventListener('xleth-motion-reveal', onReveal)
    }
  })

  it('with Auto-key on a keyed box edits through a key at the playhead', async () => {
    store.keys = [K('offsetX', 0, 0), K('offsetX', BAR, 2)]
    useRoamKeysStore.setState({ autoKey: true })
    setPlayheadTick(2 * BAR)
    await mountPanel()
    expect(byLabel('Offset X').getAttribute('aria-disabled')).toBeNull()
  })

  it('the selected key can be retimed, re-valued, re-shaped and deleted: each ONE setTrackRoamKeys', async () => {
    store.keys = [K('offsetX', 0, 0), K('offsetX', BAR, 2)]
    useRoamKeysStore.setState({ selected: { trackId: 7, channel: 'offsetX', pos: BAR } })
    await mountPanel()
    expect(container.querySelector('[data-testid="roam-key-inspector"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="roam-key-bar"]').textContent).toContain('2.1.0')

    // Interp: Hold
    const interp = byLabel('Key interpolation')
    await act(async () => { interp.click() })
    const hold = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.trim() === 'Hold')
    await act(async () => { hold.click() })
    await flush()
    expect(timeline.setTrackRoamKeys).toHaveBeenLastCalledWith(7, [K('offsetX', 0, 0), K('offsetX', BAR, 2, 'Hold')])

    // Delete
    await act(async () => { button('Delete key').click() })
    await flush()
    expect(timeline.setTrackRoamKeys).toHaveBeenLastCalledWith(7, [K('offsetX', 0, 0)])
    expect(useRoamKeysStore.getState().selected).toBeNull()
  })

  it('Clear keys removes them all in one call and is disabled when there are none', async () => {
    await mountPanel()
    expect(button('Clear keys').disabled).toBe(true)
    act(() => root.unmount())
    root = createRoot(container)
    store.keys = [K('offsetX', 0, 0), K('scale', BAR, 2)]
    await mountPanel()
    expect(button('Clear keys').disabled).toBe(false)
    await act(async () => { button('Clear keys').click() })
    await flush()
    expect(timeline.setTrackRoamKeys).toHaveBeenLastCalledWith(7, [])
  })
})
