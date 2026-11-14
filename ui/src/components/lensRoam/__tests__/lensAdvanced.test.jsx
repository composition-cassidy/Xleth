/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { timelineEvents } from '../../../timelineEvents.js'
import { resetHitPresetsCache } from '../../../lensRoam/lensRoamApi.js'
import useLensPanelMode, { LENS_PANEL_MODE_KEY } from '../../../lensRoam/lensPanelMode.js'
import useNoteSelectionStore from '../../../stores/useNoteSelectionStore.js'
import LensPanel from '../LensPanel.jsx'

// The panel's logic, with the lanes canvas replaced by a recorder of its props: what
// is hollow (inherited) and what is filled (own), and the one edit a gesture makes.
const laneProps = []
vi.mock('../LensKeyLanes.jsx', () => ({
  default: (props) => {
    laneProps.push(props)
    return <div data-testid="lens-key-lanes-mock" data-kind={props.kind} />
  },
  LANES_HEIGHT: 216,
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const LENS = { fit: 'Cover', centerX: 0.5, centerY: 0.5, zoom: 1, rotationDeg: 0, flip: 'FollowTrack' }
const LAYOUT = {
  columns: 3, rows: 3, canvasWidth: 1920, canvasHeight: 1080, gapScale: 0,
  slots: [{ trackId: 7, gridX: 8, gridY: 8, spanX: 8, spanY: 8 }], fullscreenLayers: [],
}
const key = (channel, anchor, pos, value, interp = 'Linear') => ({ channel, anchor, pos, value, interp })
const PUNCH = [key('zoom', 'Head', 0, 1.35, 'EaseOut'), key('zoom', 'Head', 120, 1.0)]
const PULSE = [key('zoom', 'Head', 0, 1.0), key('zoom', 'Body', 0.5, 1.15), key('zoom', 'Tail', 0, 1.0)]
const PUNCH_DRIFT = [
  key('zoom', 'Head', 0, 1.35, 'EaseOut'), key('zoom', 'Head', 120, 1.08),
  key('zoom', 'Tail', 240, 1.2), key('zoom', 'Tail', 0, 1.0),
]
const PRESETS = [
  { name: 'Still', keys: [], zones: { headTicks: 120, tailTicks: 240 } },
  { name: 'Punch', keys: PUNCH, zones: { headTicks: 120, tailTicks: 240 } },
  { name: 'Punch + drift', keys: PUNCH_DRIFT, zones: { headTicks: 120, tailTicks: 240 } },
  { name: 'Zoom pulse', keys: PULSE, zones: { headTicks: 120, tailTicks: 240 } },
]

let container
let root
let timeline
let store

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
const lastLanes = () => laneProps[laneProps.length - 1]
const radio = (label, text) => [...container.querySelector(`[aria-label="${label}"]`).querySelectorAll('[role="radio"]')]
  .find((r) => r.textContent === text)
const click = async (el) => { await act(async () => { el.click() }); await flush() }
const strengthDisabled = () => container.querySelector('[aria-label="Hit curve strength"]').getAttribute('aria-disabled') === 'true'
const refsOf = (...ids) => ids.map((id) => ({ patternId: 1, noteId: id }))

const noteOf = (id, over) => ({ id, positionTicks: id * 960, durationTicks: 960, pitch: 60, velocity: 1, isSlide: false, ...(over ? { lensOverride: over } : {}) })

beforeEach(() => {
  laneProps.length = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  resetHitPresetsCache()
  store = {
    hit: [...PUNCH],
    zones: { headTicks: 120, tailTicks: 240, shortNote: 'Squash' },
    clipKeys: [],
    notes: [noteOf(1), noteOf(2, { mode: 'Nudge', keys: [key('zoom', 'Body', 0.5, 1.2)] }), noteOf(3, { mode: 'Own', keys: [key('rotationDeg', 'Tail', 0, 10)] })],
  }
  const sourceState = (changed = true, extra = {}) => ({
    trackId: 7, regionId: 3, changed, explicit: true, lens: LENS, hitCurve: store.hit, zones: store.zones, ...extra,
  })
  const noteResult = (refs) => ({
    changed: true,
    notes: refs.map((r) => {
      const n = store.notes.find((x) => x.id === r.noteId)
      return { ...r, mode: n.lensOverride?.mode ?? 'Follow', lensOverride: n.lensOverride ?? null }
    }),
  })
  const patchNote = (id, fn) => { store.notes = store.notes.map((n) => (n.id === id ? fn(n) : n)) }
  timeline = {
    getLensRoam: vi.fn(async () => ({
      clips: [{ clipId: 5, lens: LENS, keys: store.clipKeys }],
      sources: [{ trackId: 7, regionId: 3, explicit: true, lens: LENS, hitCurve: store.hit, zones: store.zones }],
      tracks: [], missing: { clipIds: [], sources: [], trackIds: [] },
    })),
    getHitPresets: vi.fn(async () => PRESETS),
    applyHitPreset: vi.fn(async (t, r, name) => {
      store.hit = PRESETS.find((p) => p.name === name).keys
      store.zones = { ...store.zones, headTicks: 120, tailTicks: 240 }
      return sourceState(true, { preset: name })
    }),
    setHitCurve: vi.fn(async (t, r, curve) => {
      store.hit = curve.keys
      if (curve.zones) store.zones = { ...store.zones, ...curve.zones }
      return sourceState()
    }),
    getPattern: vi.fn(async (id) => (id === 1 ? { id: 1, regionId: 3, lengthTicks: 3840, notes: store.notes } : null)),
    getPatternBlocks: vi.fn(async () => [{ id: 9, trackId: 7, patternId: 1, positionTicks: 0, durationTicks: 7680, offsetTicks: 0, loopEnabled: false }]),
    setNoteLensMode: vi.fn(async (refs, mode) => {
      refs.forEach((r) => patchNote(r.noteId, (n) => {
        const { lensOverride, ...rest } = n
        return mode === 'Follow' ? rest : { ...rest, lensOverride: { mode, keys: lensOverride?.keys ?? [] } }
      }))
      return noteResult(refs)
    }),
    revertNotesToFollow: vi.fn(async (refs) => {
      refs.forEach((r) => patchNote(r.noteId, ({ lensOverride, ...rest }) => rest))
      return noteResult(refs)
    }),
    setNotesLensKeys: vi.fn(async (entries) => {
      entries.forEach((e) => patchNote(e.noteId, (n) => ({ ...n, lensOverride: { mode: n.lensOverride?.mode ?? 'Nudge', keys: e.keys } })))
      return noteResult(entries)
    }),
    setClipLensKeys: vi.fn(async (clipId, keys) => { store.clipKeys = keys; return { clipId, changed: true, lens: LENS, keys } }),
    setClipLens: vi.fn(), setTrackLens: vi.fn(),
    getGridLayout: vi.fn(async () => LAYOUT),
    getTracks: vi.fn(async () => [{ id: 7, name: 'Chorus', gapScaleOverride: -1 }]),
  }
  window.xleth = { timeline, video: { getFrameAtTime: vi.fn(async () => null) } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useLensPanelMode.setState({ mode: 'simple' })
  useNoteSelectionStore.getState().clear()
  try { window.localStorage.clear() } catch { /* */ }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete window.xleth
  vi.restoreAllMocks()
})

const mountSource = async () => {
  await act(async () => {
    root.render(<LensPanel target={{ kind: 'source', trackId: 7, regionId: 3 }} cellTrackId={7} context="Chorus · applies to all notes" frameRef={null} />)
  })
  await flush()
}
const mountClip = async () => {
  await act(async () => {
    root.render(
      <LensPanel
        target={{ kind: 'clip', clipId: 5 }} cellTrackId={7} context="Take 1 · this event only" frameRef={null}
        clipTiming={{ startTick: 1920, lengthTicks: 1920 }}
      />,
    )
  })
  await flush()
}
const select = async (byPattern) => { await act(async () => { useNoteSelectionStore.setState({ byPattern }) }); await flush() }

describe('Simple | Advanced', () => {
  it('Advanced only reveals more: every Simple control is still there, and the choice is remembered', async () => {
    await mountSource()
    const simpleControls = ['Zoom', 'Center X', 'Center Y', 'Rotate', 'Lens fit', 'Lens flip', 'Hit curve preset', 'Hit curve strength', 'Short notes']
    for (const l of simpleControls) expect(container.querySelector(`[aria-label="${l}"]`), `${l} in Simple`).not.toBeNull()
    expect(container.querySelector('[data-testid="lens-advanced"]')).toBeNull()

    await click(radio('Lens panel mode', 'Advanced'))
    expect(container.querySelector('[data-testid="lens-advanced"]')).not.toBeNull()
    for (const l of simpleControls) expect(container.querySelector(`[aria-label="${l}"]`), `${l} in Advanced`).not.toBeNull()
    expect(window.localStorage.getItem(LENS_PANEL_MODE_KEY)).toBe('advanced')

    // A fresh panel (a new session) reads the remembered choice.
    act(() => root.unmount())
    root = createRoot(container)
    useLensPanelMode.setState({ mode: window.localStorage.getItem(LENS_PANEL_MODE_KEY) })
    await mountSource()
    expect(radio('Lens panel mode', 'Advanced').getAttribute('aria-checked')).toBe('true')
  })

  it('works when storage is blocked: the choice still applies, it just is not remembered', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    await mountSource()
    await click(radio('Lens panel mode', 'Advanced'))
    expect(container.querySelector('[data-testid="lens-advanced"]')).not.toBeNull()
    spy.mockRestore()
  })
})

describe('Simple: presets, Strength, Short notes', () => {
  it('lists the engine\'s four presets in the spec order and marks the one the curve is', async () => {
    await mountSource()
    const group = container.querySelector('[aria-label="Hit curve preset"]')
    const radios = [...group.querySelectorAll('[role="radio"]')]
    expect(radios.map((r) => r.textContent)).toEqual(['Still', 'Punch', 'Punch + drift', 'Zoom pulse'])
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false'])
    expect(timeline.getHitPresets).toHaveBeenCalledTimes(1)
  })

  it('a preset button is one applyHitPreset; the keys stay the engine\'s', async () => {
    await mountSource()
    await click(radio('Hit curve preset', 'Zoom pulse'))
    expect(timeline.applyHitPreset).toHaveBeenCalledTimes(1)
    expect(timeline.applyHitPreset).toHaveBeenCalledWith(7, 3, 'Zoom pulse')
    expect(timeline.setHitCurve).not.toHaveBeenCalled()
    expect(radio('Hit curve preset', 'Zoom pulse').getAttribute('aria-checked')).toBe('true')
  })

  it('Still is a preset too, and a hand-edited curve is Custom with Strength waiting for a preset', async () => {
    await mountSource()
    expect(strengthDisabled()).toBe(false)   // Punch
    await click(radio('Hit curve preset', 'Still'))
    expect(radio('Hit curve preset', 'Still').getAttribute('aria-checked')).toBe('true')
    expect(strengthDisabled()).toBe(true)     // nothing to scale
    store.hit = [key('zoom', 'Head', 0, 1.5)]
    await act(async () => { timelineEvents.dispatchEvent(new Event('lens-roam-changed')) })
    await flush()
    expect(container.querySelector('[data-testid="lens-hit-custom"]')).not.toBeNull()
    expect(strengthDisabled()).toBe(true)
  })

  it('Short notes writes the zone rule and keeps the keys', async () => {
    await mountSource()
    await click(radio('Short notes', 'Cut'))
    expect(timeline.setHitCurve).toHaveBeenCalledTimes(1)
    expect(timeline.setHitCurve).toHaveBeenCalledWith(7, 3, { keys: PUNCH, zones: { shortNote: 'Cut' } })
    expect(radio('Short notes', 'Cut').getAttribute('aria-checked')).toBe('true')
  })

  it('a clip target has no hit controls (events are not notes)', async () => {
    await mountClip()
    expect(container.querySelector('[data-testid="lens-hit-controls"]')).toBeNull()
  })
})

describe('Advanced, no note selected: the hit curve', () => {
  beforeEach(() => { useLensPanelMode.setState({ mode: 'advanced' }) })

  it('edits the hit curve over a reference note: own keys, nothing inherited, the source\'s zones', async () => {
    await mountSource()
    expect(container.querySelector('[data-advanced-kind="hit"]')).not.toBeNull()
    const p = lastLanes()
    expect(p.kind).toBe('note')
    expect(p.ownKeys).toEqual(PUNCH)
    expect(p.inheritedKeys).toEqual([])
    expect(p.lengthTicks).toBe(960)
    expect(p.zones).toEqual({ headTicks: 120, tailTicks: 240, shortNote: 'Squash' })
    expect(container.querySelector('[aria-label="Preview note length"]')).not.toBeNull()
  })

  it('a lane edit is ONE setHitCurve with the edit applied to the curve', async () => {
    await mountSource()
    const added = key('centerX', 'Body', 0.4, 0.05)
    await act(async () => { lastLanes().onOp({ type: 'add', key: added }) })
    await flush()
    expect(timeline.setHitCurve).toHaveBeenCalledTimes(1)
    expect(timeline.setHitCurve).toHaveBeenCalledWith(7, 3, { keys: [...PUNCH, added] })
    await act(async () => { lastLanes().onOp({ type: 'update', match: PUNCH[1], patch: { pos: 90, value: 1.1 } }) })
    await flush()
    expect(timeline.setHitCurve).toHaveBeenLastCalledWith(7, 3, { keys: [PUNCH[0], { ...PUNCH[1], pos: 90, value: 1.1 }, added] })
    await act(async () => { lastLanes().onOp({ type: 'remove', match: PUNCH[0] }) })
    await flush()
    expect(store.hit.some((k) => k.pos === 0 && k.value === 1.35)).toBe(false)
  })

  it('an edit that changes nothing sends nothing', async () => {
    await mountSource()
    await act(async () => { lastLanes().onOp({ type: 'remove', match: key('zoom', 'Head', 55, 9) }) })
    await flush()
    expect(timeline.setHitCurve).not.toHaveBeenCalled()
  })

  it('shows what the engine has after an undo (the arrangement refresh events)', async () => {
    await mountSource()
    store.hit = PULSE                                            // the engine undid or redid something
    await act(async () => { timelineEvents.dispatchEvent(new Event('timeline-clips-changed')) })
    await flush()
    expect(lastLanes().ownKeys).toEqual(PULSE)
  })
})

describe('Advanced, notes selected', () => {
  beforeEach(() => { useLensPanelMode.setState({ mode: 'advanced' }) })

  it('a Follow note: the hit curve is inherited (hollow), nothing is its own (filled), the stack names every layer', async () => {
    await mountSource()
    await select({ 1: new Set([1]) })
    expect(container.querySelector('[data-advanced-kind="note"]')).not.toBeNull()
    const p = lastLanes()
    expect(p.inheritedKeys).toEqual(PUNCH)
    expect(p.ownKeys).toEqual([])
    expect(radio('Note Lens state', 'Follow').getAttribute('aria-checked')).toBe('true')
    const rows = [...container.querySelectorAll('[data-testid="lens-layer-stack"] [data-row]')].map((r) => r.getAttribute('data-row'))
    expect(rows).toEqual(['base', 'hit', 'note', 'sweep', 'resolved'])
    expect(container.querySelector('[data-testid="lens-layer-status-sweep"]').textContent).toBe('none')
    expect(container.querySelector('[data-testid="lens-layer-status-note"]').textContent).toBe('Follow: none')
  })

  it('a Nudge note: hit curve hollow, its own keys filled; Revert to Follow is enabled', async () => {
    await mountSource()
    await select({ 1: new Set([2]) })
    const p = lastLanes()
    expect(p.inheritedKeys).toEqual(PUNCH)
    expect(p.ownKeys).toEqual(store.notes[1].lensOverride.keys)
    const revert = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Revert to Follow')
    expect(revert.disabled).toBe(false)
    await click(revert)
    expect(timeline.revertNotesToFollow).toHaveBeenCalledTimes(1)
    expect(timeline.revertNotesToFollow).toHaveBeenCalledWith(refsOf(2))
    expect(lastLanes().ownKeys).toEqual([])
  })

  it('an Own note: the hit curve does not reach it, so nothing is hollow; the stack says so', async () => {
    await mountSource()
    await select({ 1: new Set([3]) })
    expect(lastLanes().inheritedKeys).toEqual([])
    expect(lastLanes().zones).toEqual({ headTicks: 120, tailTicks: 240, shortNote: 'Squash' })
    expect(container.querySelector('[data-testid="lens-layer-status-hit"]').textContent).toBe('not applied')
  })

  it('hollow vs filled stay correct after the hit curve is edited, and after a state switch', async () => {
    await mountSource()
    await select({ 1: new Set([2]) })
    const own = lastLanes().ownKeys
    // Edit the hit curve (a preset from the Simple controls, one engine command).
    await click(radio('Hit curve preset', 'Zoom pulse'))
    expect(lastLanes().inheritedKeys).toEqual(PULSE)         // the new curve, hollow
    expect(lastLanes().ownKeys).toEqual(own)                 // the note's own keys untouched, filled
    // Nudge -> Own: the (new) hit curve stops being inherited; the keys carry over.
    await click(radio('Note Lens state', 'Own'))
    expect(timeline.setNoteLensMode).toHaveBeenLastCalledWith(refsOf(2), 'Own')
    expect(lastLanes().inheritedKeys).toEqual([])
    expect(lastLanes().ownKeys).toEqual(own)
    // Own -> Follow: the note's keys are dropped; the hit curve is inherited again.
    await click(radio('Note Lens state', 'Follow'))
    expect(lastLanes().inheritedKeys).toEqual(PULSE)
    expect(lastLanes().ownKeys).toEqual([])
  })

  it('the Follow / Nudge / Own switch is one setNoteLensMode over the selected notes', async () => {
    await mountSource()
    await select({ 1: new Set([1]) })
    await click(radio('Note Lens state', 'Nudge'))
    expect(timeline.setNoteLensMode).toHaveBeenCalledTimes(1)
    expect(timeline.setNoteLensMode).toHaveBeenCalledWith(refsOf(1), 'Nudge')
    expect(radio('Note Lens state', 'Nudge').getAttribute('aria-checked')).toBe('true')
  })

  it('adding a key to a Follow note is one setNotesLensKeys (the engine makes it Nudge)', async () => {
    await mountSource()
    await select({ 1: new Set([1]) })
    const added = key('zoom', 'Head', 40, 1.5)
    await act(async () => { lastLanes().onOp({ type: 'add', key: added }) })
    await flush()
    expect(timeline.setNotesLensKeys).toHaveBeenCalledTimes(1)
    expect(timeline.setNotesLensKeys).toHaveBeenCalledWith([{ patternId: 1, noteId: 1, keys: [added] }])
    expect(lastLanes().ownKeys).toEqual([added])
  })

  it('Edit hit curve deselects the notes', async () => {
    await mountSource()
    await select({ 1: new Set([1]) })
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Edit hit curve'))
    expect(container.querySelector('[data-advanced-kind="hit"]')).not.toBeNull()
    expect(useNoteSelectionStore.getState().byPattern).toEqual({})
  })

  it('notes of another source are not this panel\'s notes', async () => {
    await mountSource()
    await select({ 2: new Set([1]) })      // pattern 2 does not exist / plays another region
    expect(container.querySelector('[data-advanced-kind="hit"]')).not.toBeNull()
  })
})

describe('Advanced, multi-select (piano roll or Reel lane)', () => {
  beforeEach(() => { useLensPanelMode.setState({ mode: 'advanced' }) })

  it('one edit applies to every selected note\'s OWN keys, in ONE call (one undo step)', async () => {
    await mountSource()
    await select({ 1: new Set([1, 2]) })
    expect(container.textContent).toContain('2 selected notes')
    const added = key('zoom', 'Head', 30, 1.4)
    await act(async () => { lastLanes().onOp({ type: 'add', key: added }) })
    await flush()
    expect(timeline.setNotesLensKeys).toHaveBeenCalledTimes(1)
    const entries = timeline.setNotesLensKeys.mock.calls[0][0]
    expect(entries).toEqual([
      { patternId: 1, noteId: 1, keys: [added] },
      { patternId: 1, noteId: 2, keys: [key('zoom', 'Body', 0.5, 1.2), added] },   // note 2 keeps its own key
    ])
  })

  it('an edit that exists in only one note leaves the others alone', async () => {
    await mountSource()
    await select({ 1: new Set([1, 2]) })
    await act(async () => { lastLanes().onOp({ type: 'remove', match: key('zoom', 'Body', 0.5, 1.2) }) })
    await flush()
    expect(timeline.setNotesLensKeys).toHaveBeenCalledTimes(1)
    expect(timeline.setNotesLensKeys).toHaveBeenCalledWith([{ patternId: 1, noteId: 2, keys: [] }])
  })

  it('the mode switch and Revert address all of them; mixed modes say so', async () => {
    await mountSource()
    await select({ 1: new Set([1, 2, 3]) })
    expect(container.querySelector('[data-testid="lens-mode-mixed"]')).not.toBeNull()
    expect([...container.querySelector('[aria-label="Note Lens state"]').querySelectorAll('[aria-checked="true"]')]).toHaveLength(0)
    await click(radio('Note Lens state', 'Own'))
    expect(timeline.setNoteLensMode).toHaveBeenCalledWith(refsOf(1, 2, 3), 'Own')
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Revert to Follow'))
    expect(timeline.revertNotesToFollow).toHaveBeenCalledWith(refsOf(1, 2, 3))
  })
})

describe('Advanced, Clip Track event', () => {
  beforeEach(() => { useLensPanelMode.setState({ mode: 'advanced' }) })

  it('the same lanes in event ticks: no zones, no hit curve, the static value as the base line', async () => {
    store.clipKeys = [{ channel: 'zoom', anchor: 'Origin', pos: 0, value: 1, interp: 'Linear' }]
    await mountClip()
    expect(container.querySelector('[data-advanced-kind="event"]')).not.toBeNull()
    const p = lastLanes()
    expect(p.kind).toBe('event')
    expect(p.lengthTicks).toBe(1920)
    expect(p.zones).toBeUndefined()
    expect(p.inheritedKeys ?? []).toEqual([])
    expect(p.base).toMatchObject({ zoom: 1, centerX: 0.5 })
    expect(p.ownKeys).toEqual(store.clipKeys)
    expect(container.querySelector('[aria-label="Key anchor"]')).toBeNull()
    const rows = [...container.querySelectorAll('[data-testid="lens-layer-stack"] [data-row]')].map((r) => r.getAttribute('data-row'))
    expect(rows).toEqual(['base', 'event', 'sweep', 'resolved'])
  })

  it('a lane edit is one setClipLensKeys with Origin keys', async () => {
    await mountClip()
    const added = { channel: 'zoom', anchor: 'Origin', pos: 480, value: 1.8, interp: 'Linear' }
    await act(async () => { lastLanes().onOp({ type: 'add', key: added }) })
    await flush()
    expect(timeline.setClipLensKeys).toHaveBeenCalledTimes(1)
    expect(timeline.setClipLensKeys).toHaveBeenCalledWith(5, [added])
    expect(lastLanes().ownKeys).toEqual([added])
    await act(async () => { lastLanes().onOp({ type: 'remove', match: added }) })
    await flush()
    expect(timeline.setClipLensKeys).toHaveBeenLastCalledWith(5, [])
  })

  it('follows an undo', async () => {
    await mountClip()
    store.clipKeys = [{ channel: 'rotationDeg', anchor: 'Origin', pos: 0, value: 30, interp: 'Hold' }]
    await act(async () => { timelineEvents.dispatchEvent(new Event('timeline-clips-changed')) })
    await flush()
    expect(lastLanes().ownKeys).toEqual(store.clipKeys)
  })
})
