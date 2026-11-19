// @vitest-environment jsdom
//
// Clones in Motion view (docs/XLETH_CLONE_SPEC.md "Timeline and Motion view"): Clone
// tracks indented under their source and tagged by kind, a Trail's "follows <source>"
// in place of the Parent picker, the picker never offering a Trail, a Linked Voice
// clone's read-only Lens line, and the Trail rows (Delay picker, Tint, Opacity
// stopwatch) each writing ONE setCloneSettings in the engine's wire form.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import MotionView, { keyAreaHint } from './MotionView.jsx'
import { trackRowHint } from './MotionTree.jsx'
import { parseDelayText, delayText } from './TrailControls.jsx'
import { setMotionTickForTest } from './motionTick.js'
import { useMotionViewStore } from '../../motion/motionViewStore.js'
import { resetSharedUndoGrouper } from '../timeline/undoGroup.js'
import { playheadClock } from '../../services/PlayheadClock.js'
import { cloneData, cloneTracks } from '../../motion/providers/__tests__/cloneFixtures.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TICK = 1920

function canvasStub() {
  const noop = () => {}
  return new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : noop),
    set: (t, k, v) => { t[k] = v; return true },
  })
}

let container
let host
let root
let ref
let tl

function mount({ tracks = cloneTracks(), data = cloneData() } = {}) {
  ref = { current: null }
  act(() => {
    root.render(
      <MotionView
        ref={ref}
        tracks={tracks}
        allTracks={tracks}
        data={data}
        refresh={vi.fn()}
        adopt={vi.fn()}
        keyHost={host}
        ppbRef={{ current: 40 }}
        scrollOffsetRef={{ current: 0 }}
        snapGranularity="1/16"
        onFocusTrack={vi.fn()}
        onPearl={vi.fn()}
        onSeekTick={vi.fn()}
      />,
    )
  })
}

const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`)
const click = async (el, init = {}) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ...init }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }))
  })
}
const flush = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve() })
const menuItems = () => [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')]

function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => canvasStub()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  container = document.createElement('div')
  host = document.createElement('div')
  document.body.append(container, host)
  root = createRoot(container)
  useMotionViewStore.getState().reset({ all: true })
  resetSharedUndoGrouper()
  playheadClock.positionBeatsValue = 2
  setMotionTickForTest(TICK)
  tl = {
    setCloneSettings: vi.fn(async (trackId, patch) => ({ trackId, changed: true, clone: { kind: 'Trail', ...patch } })),
    setTrackRoam: vi.fn(async (id, p) => ({ trackId: id, changed: true, roam: p })),
    setTrackRoamKeys: vi.fn(async (id, keys) => ({ trackId: id, changed: true, roam: {}, keys })),
    setTrackParent: vi.fn(async (id, parent) => ({ trackId: id, changed: true, parentTrackId: parent })),
  }
  window.xleth = { timeline: tl, undo: { beginGroup: vi.fn(async () => 1), endGroup: vi.fn(async () => true) } }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  host.remove()
  delete window.xleth
  playheadClock.positionBeatsValue = 0
  vi.restoreAllMocks()
})

describe('Clone track rows', () => {
  it('are indented under their source and tagged by kind; a Trail follows its source instead of a Parent picker', () => {
    mount()
    const voice = byTestId('motion-row-t:5')
    const trail = byTestId('motion-row-t:6')
    expect(voice.style.paddingLeft).toBe('14px')
    expect(trail.style.paddingLeft).toBe('14px')
    expect(byTestId('motion-row-t:1').style.paddingLeft).toBe('0px')
    expect(voice.textContent).toContain('Voice clone')
    expect(trail.textContent).toContain('Trail clone')
    expect(voice.querySelector('[data-testid="motion-parent-5"]')).toBeTruthy()
    expect(trail.querySelector('[data-testid="motion-parent-6"]')).toBeNull()
    expect(byTestId('motion-follows-6').textContent).toBe('follows Lead')
    // A Trail wears its tint.
    expect(trail.style.getPropertyValue('--track-chip')).toBe('#F07A2A')
  })

  it('the Parent picker offers Voice clones but never a Trail', async () => {
    mount()
    await click(byTestId('motion-parent-2'))
    const names = menuItems().map((el) => el.textContent)
    expect(names).toContain('Lead · Clone 1')
    expect(names.some((n) => n.includes('Trail'))).toBe(false)
  })

  it('hints say what each Clone is and what its reference strip shows', () => {
    const data = cloneData()
    const tracks = cloneTracks()
    expect(trackRowHint(tracks[1], data, tracks)).toMatch(/Voice clone \(voice 1\)\. It plays the notes Lead cannot/)
    expect(trackRowHint(tracks[2], data, tracks)).toMatch(/Trail clone\. It follows Lead's whole picture 1\/8 behind, tinted #F07A2A, at 90 % opacity/)
    expect(keyAreaHint({ row: { kind: 'track', track: tracks[2] } }, data).hint).toBe("Lead · Trail 1: Lead's notes 1/8 later (where this Trail shows them), for reference")
    expect(keyAreaHint({ row: { kind: 'track', track: tracks[1] } }, data).hint).toBe('Lead · Clone 1: the notes this Voice clone plays, for reference')
  })
})

describe('Voice clone Lens', () => {
  it('Linked: one read-only line, no twirl', () => {
    useMotionViewStore.getState().setExpandedRows(['t:5'])
    mount()
    const row = byTestId('motion-row-t:5/lens')
    expect(row.textContent).toContain('Lens · linked to Lead')
    expect(row.getAttribute('data-readonly')).toBe('true')
    expect(byTestId('motion-twirl-t:5/lens')).toBeNull()
    expect(byTestId('motion-twirl-t:5/roam')).toBeTruthy()
    expect(byTestId('motion-twirl-t:5/sweep')).toBeTruthy()
  })

  it('Own: its own Lens rows on its own trackId', () => {
    useMotionViewStore.getState().setExpandedRows(['t:5', 't:5/lens'])
    mount({ data: cloneData({ lensMode: 'Own' }) })
    expect(byTestId('motion-row-t:5/lens/sourceLens.zoom')).toBeTruthy()
    expect(byTestId('motion-row-t:5/lens').getAttribute('data-readonly')).toBeNull()
  })
})

describe('Trail rows', () => {
  beforeEach(() => { useMotionViewStore.getState().setExpandedRows(['t:6', 't:6/trail', 't:6/roam']) })

  it('show Delay, Tint, Opacity and the added Offset X / Y only', () => {
    mount()
    expect(byTestId('motion-value-t:6/trail/trail.delay').textContent).toContain('1/8')
    expect(byTestId('motion-value-t:6/trail/trail.tint-hex').value).toBe('#F07A2A')
    expect(byTestId('motion-value-t:6/trail/trail.opacity')).toBeTruthy()
    expect(byTestId('motion-row-t:6/roam').textContent).toContain('Roam · added')
    expect(byTestId('motion-row-t:6/roam/roam.offsetX')).toBeTruthy()
    expect(byTestId('motion-row-t:6/roam/roam.scale')).toBeNull()
    expect(byTestId('motion-row-t:6/sweep')).toBeNull()
    expect(byTestId('motion-row-t:6/lens')).toBeNull()
    // Delay and Tint are static (no key toggle); Opacity is animatable.
    expect(byTestId('motion-stopwatch-t:6/trail/trail.delay')).toBeNull()
    expect(byTestId('motion-stopwatch-t:6/trail/trail.opacity')).toBeTruthy()
  })

  it('Delay: a musical value from the menu is one setCloneSettings', async () => {
    mount()
    await click(byTestId('motion-value-t:6/trail/trail.delay'))
    const quarter = menuItems().find((el) => el.textContent.startsWith('1/4'))
    await click(quarter)
    await flush()
    expect(tl.setCloneSettings).toHaveBeenCalledWith(6, { delayTicks: 960 })
  })

  it('Delay: exact ticks typed in the menu (Enter)', async () => {
    mount()
    await click(byTestId('motion-value-t:6/trail/trail.delay'))
    const field = byTestId('motion-value-t:6/trail/trail.delay-exact')
    await act(async () => { typeInto(field, '700') })
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await flush()
    expect(tl.setCloneSettings).toHaveBeenCalledWith(6, { delayTicks: 700 })
  })

  it('Tint: a typed hex is set on Enter (normalised), a bad one is not', async () => {
    mount()
    const hex = byTestId('motion-value-t:6/trail/trail.tint-hex')
    await act(async () => { typeInto(hex, '#zz0000') })
    await act(async () => { hex.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(tl.setCloneSettings).not.toHaveBeenCalled()
    await act(async () => { typeInto(hex, '9b7bf0') })
    await act(async () => { hex.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await flush()
    expect(tl.setCloneSettings).toHaveBeenCalledWith(6, { tint: '#9B7BF0' })
  })

  it('Opacity: the key toggle writes one key at the playhead, in the strict wire form', async () => {
    mount()
    await click(byTestId('motion-stopwatch-t:6/trail/trail.opacity'))
    await flush()
    expect(tl.setCloneSettings).toHaveBeenCalledWith(6, { opacityKeys: [{ pos: TICK, value: 0.9, interp: 'Linear' }] })
  })

  it('added Roam: Offset X edits the Trail\'s own Roam base', async () => {
    mount()
    const api = ref.current.api()
    await act(async () => { await api.valuePlan(ref.current.layout().byKey.get('t:6/roam/roam.offsetX'), 0.25) })
    expect(tl.setTrackRoam).toHaveBeenCalledWith(6, { offsetX: 0.25 })
  })
})

describe('TrailControls helpers', () => {
  it('parse exact delays and print delays', () => {
    expect(parseDelayText('700')).toBe(700)
    expect(parseDelayText('1 920 ticks')).toBe(1920)
    expect(parseDelayText('0')).toBe(1)
    expect(parseDelayText('abc')).toBeNull()
    expect(delayText(480)).toBe('1/8')
    expect(delayText(700)).toBe('700 ticks')
  })
})
