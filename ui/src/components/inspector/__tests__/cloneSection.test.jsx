/**
 * @vitest-environment jsdom
 */
// The Inspector's Clone section (docs/XLETH_CLONE_SPEC.md): a Voice clone says which
// voice it is and how many notes it plays and switches its Lens Linked | Own; a
// Trail says whom it follows and edits Delay / Tint / Opacity, each ONE
// setCloneSettings; a source lists its Clones. A Trail's track inspector shows only
// what applies to it (Clone + the added Roam), not the cell sections.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CloneSection, { ClonesListSection, playsText } from '../CloneSection.jsx'
import TrackVideoProperties from '../../timeline/TrackVideoProperties.jsx'
import { MOTION_REVEAL_EVENT } from '../../timeline/motionReveal.js'
import { CLONE_BLOCKS, CLONE_PATTERNS, cloneTracks } from '../../../motion/providers/__tests__/cloneFixtures.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ROAM = { offsetX: 0, offsetY: 0, scale: 1, rotationDeg: 0, bounds: 'Clip', layer: 'GridOrder' }

let container
let root
let tl

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`)
const click = async (el) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  try { window.localStorage?.clear() } catch { /* storage can be blocked */ }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  tl = {
    getPatternBlocks: vi.fn(async () => CLONE_BLOCKS),
    getPattern: vi.fn(async (id) => CLONE_PATTERNS[id] ?? null),
    setCloneSettings: vi.fn(async (trackId, patch) => ({ trackId, changed: true, clone: patch })),
    getTracks: vi.fn(async () => cloneTracks()),
    getGridLayout: vi.fn(async () => ({ columns: 2, rows: 2, canvasWidth: 1920, canvasHeight: 1080, gapScale: 0, slots: [{ trackId: 1, gridX: 0, gridY: 0, spanX: 8, spanY: 8 }], fullscreenLayers: [] })),
    getLensRoam: vi.fn(async () => ({
      clips: [], sources: [],
      tracks: [{ trackId: 6, roam: ROAM, keys: [], sweep: [], masks: [], parentTrackId: -1 }],
      missing: { clipIds: [], sources: [], trackIds: [] },
    })),
  }
  window.xleth = { timeline: tl }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete window.xleth
  vi.restoreAllMocks()
})

describe('Voice clone', () => {
  it('names its voice and counts the notes it plays; Own is one setCloneSettings', async () => {
    const tracks = cloneTracks()
    act(() => root.render(<CloneSection track={tracks[1]} tracks={tracks} />))
    await flush()
    expect(byTestId('clone-voice').textContent).toBe('Voice 1 · plays 1 note')
    const own = [...container.querySelectorAll('[role="radio"]')].find((el) => el.textContent === 'Own')
    expect(own.getAttribute('aria-checked')).toBe('false')
    await click(own)
    await flush()
    expect(tl.setCloneSettings).toHaveBeenCalledWith(5, { lensMode: 'Own' })
  })

  it('plays text', () => {
    expect(playsText(null)).toBe('counting notes…')
    expect(playsText(1)).toBe('plays 1 note')
    expect(playsText(3)).toBe('plays 3 notes')
  })
})

describe('Trail clone', () => {
  it('follows its source; Delay and Opacity are one setCloneSettings each', async () => {
    const tracks = cloneTracks()
    act(() => root.render(<CloneSection track={tracks[2]} tracks={tracks} />))
    await flush()
    expect(byTestId('clone-follows').textContent).toBe('Lead, 1/8 behind')
    expect(byTestId('clone-tint-hex').value).toBe('#F07A2A')
    await click(byTestId('clone-delay'))
    const half = [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].find((el) => el.textContent.startsWith('1/2'))
    await click(half)
    await flush()
    expect(tl.setCloneSettings).toHaveBeenCalledWith(6, { delayTicks: 1920 })
    expect(byTestId('clone-opacity').getAttribute('aria-disabled')).not.toBe('true')
  })

  it('keyed opacity: the box is read-only and offers Motion view', async () => {
    const tracks = cloneTracks({ trailExtra: { opacityKeys: [{ pos: 0, value: 0.5, interp: 'Hold' }] } })
    act(() => root.render(<CloneSection track={tracks[2]} tracks={tracks} />))
    await flush()
    const seen = []
    const on = (e) => seen.push(e.detail)
    window.addEventListener(MOTION_REVEAL_EVENT, on)
    const show = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Show in Motion view')
    await click(show)
    window.removeEventListener(MOTION_REVEAL_EVENT, on)
    expect(seen).toEqual([{ trackId: 6, path: ['trail'] }])
  })
})

describe('source Pattern track', () => {
  it('lists its Clones, read-only', () => {
    const tracks = cloneTracks()
    act(() => root.render(<ClonesListSection track={tracks[0]} tracks={tracks} />))
    expect(byTestId('clone-item-5').textContent).toBe('Lead · Clone 1Voice clonevoice 1')
    expect(byTestId('clone-item-6').textContent).toBe('Lead · Trail 1Trail clone1/8 behind')
    // Read-only: nothing to edit, only the section's fold button.
    expect(byTestId('xleth-inspector-clones').querySelectorAll('input, select')).toHaveLength(0)
    expect(byTestId('xleth-inspector-clones').querySelectorAll('button')).toHaveLength(1)
  })

  it('a track without Clones has no list', () => {
    const tracks = cloneTracks()
    act(() => root.render(<ClonesListSection track={tracks[3]} tracks={tracks} />))
    expect(byTestId('xleth-inspector-clones')).toBeNull()
  })
})

describe('Trail track inspector', () => {
  it('shows the Clone section and the added Roam (Offset X / Y), not the cell sections', async () => {
    act(() => root.render(<TrackVideoProperties trackId={6} />))
    await flush()
    const root0 = byTestId('xleth-inspector-track')
    expect(root0.textContent).toContain('Trail clone of Lead')
    expect(byTestId('xleth-inspector-clone')).toBeTruthy()
    const sections = [...root0.querySelectorAll('section')].map((s) => s.getAttribute('aria-label'))
    expect(sections).toEqual(['Clone', 'Roam · added', 'Roam keys'])
    expect(byTestId('xleth-inspector-video-fx')).toBeNull()
    expect(root0.textContent).toContain('Roam X (added)')
    expect(root0.textContent).not.toContain('Parent:')
  })

  it('a Voice clone keeps every cell section and adds its Clone section first', async () => {
    act(() => root.render(<TrackVideoProperties trackId={5} />))
    await flush()
    const sections = [...byTestId('xleth-inspector-track').querySelectorAll('section')].map((s) => s.getAttribute('aria-label'))
    expect(sections[0]).toBe('Clone')
    expect(sections).toContain('Cell')
    expect(sections).toContain('Roam')
    // An idle Voice clone draws nothing (spec "Idle"): the engine never holds a clone's frame.
    expect(sections).not.toContain('Hold last frame')
    expect(byTestId('xleth-inspector-track').textContent).toContain('Voice clone of Lead')
  })
})
