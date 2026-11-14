/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ZONES, laneRange, valueToUnit, LENS_CHANNELS } from '../../../lensRoam/lensKeyModel.js'
import LensKeyLanes from '../LensKeyLanes.jsx'
import LensKeyInspector from '../LensKeyInspector.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The lanes' geometry (LensKeyLanes.jsx): jsdom has no layout, so the canvas box is
// (0,0) and a client coordinate IS a canvas coordinate. Width defaults to 300.
const W = 300
const GUTTER = 52
const INSET = 7
const RULER_H = 16
const LANE_H = 50
const LANE_PAD = 6
const X0 = GUTTER + INSET
const PLOT_W = W - INSET - GUTTER - INSET
const xOf = (t, len) => X0 + (t / len) * PLOT_W
const key = (channel, anchor, pos, value, interp = 'Linear') => ({ channel, anchor, pos, value, interp })
const yOf = (channel, value, keys, opts = {}) => {
  const i = LENS_CHANNELS.indexOf(channel)
  const range = laneRange(channel, keys.filter((k) => k.channel === channel).map((k) => k.value), opts)
  const u = Math.min(Math.max(valueToUnit(range, value), 0), 1)
  return RULER_H + i * LANE_H + LANE_PAD + (1 - u) * (LANE_H - 2 * LANE_PAD)
}
const laneMidY = (channel) => RULER_H + LENS_CHANNELS.indexOf(channel) * LANE_H + LANE_H / 2

let container
let root
const ptr = (type, x, y, extra = {}) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...extra })
const canvas = () => container.querySelector('[data-testid="lens-key-lanes"]')
const fire = async (el, ev) => { await act(async () => { el.dispatchEvent(ev) }) }

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)   // jsdom has no 2D context; the draw effect bails on null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const PUNCH = [key('zoom', 'Head', 0, 1.35, 'EaseOut'), key('zoom', 'Head', 120, 1.0)]

const mount = async (props = {}) => {
  const onOp = vi.fn()
  const onSelect = vi.fn()
  const base = {
    kind: 'note', zones: { ...DEFAULT_ZONES }, lengthTicks: 960, ownKeys: PUNCH, inheritedKeys: [],
    selected: null, onSelect, onOp, label: 'Test lanes',
  }
  await act(async () => { root.render(<LensKeyLanes {...base} {...props} />) })
  return { onOp, onSelect, props: { ...base, ...props } }
}

describe('LensKeyLanes: gestures are local, one commit on mouseup', () => {
  it('click-drag on an empty lane adds ONE key, sent once, on pointerup', async () => {
    const { onOp } = await mount()
    const c = canvas()
    await fire(c, ptr('pointerdown', xOf(420, 960), laneMidY('centerX')))
    await fire(c, ptr('pointermove', xOf(430, 960), laneMidY('centerX') - 5))
    await fire(c, ptr('pointermove', xOf(440, 960), laneMidY('centerX') - 9))
    expect(onOp).not.toHaveBeenCalled()                     // nothing leaves the canvas mid-drag
    await fire(c, ptr('pointerup', xOf(440, 960), laneMidY('centerX') - 9))
    expect(onOp).toHaveBeenCalledTimes(1)
    const op = onOp.mock.calls[0][0]
    expect(op.type).toBe('add')
    expect(op.key).toMatchObject({ channel: 'centerX', anchor: 'Body', interp: 'Linear' })
    expect(op.key.pos).toBeCloseTo((440 - 120) / 600, 2)    // body fraction under the pointer
    expect(op.key.value).toBeGreaterThan(0)                 // dragged up = a positive offset
  })

  it('a click that adds a key in the Head band anchors it to Head, in ticks', async () => {
    const { onOp } = await mount()
    await fire(canvas(), ptr('pointerdown', xOf(60, 960), laneMidY('rotationDeg')))
    await fire(canvas(), ptr('pointerup', xOf(60, 960), laneMidY('rotationDeg')))
    expect(onOp.mock.calls[0][0].key).toMatchObject({ channel: 'rotationDeg', anchor: 'Head' })
    expect(onOp.mock.calls[0][0].key.pos).toBeGreaterThan(55)
    expect(onOp.mock.calls[0][0].key.pos).toBeLessThan(65)
  })

  it('dragging a filled key moves it (one update with the key as it was) and keeps its anchor inside its zone', async () => {
    const { onOp } = await mount()
    const k = PUNCH[1]
    const x = xOf(120, 960)
    const y = yOf('zoom', k.value, PUNCH)
    const c = canvas()
    await fire(c, ptr('pointerdown', x, y))
    await fire(c, ptr('pointermove', xOf(400, 960), y - 10))   // far past the Head's edge, and up
    await fire(c, ptr('pointerup', xOf(400, 960), y - 10))
    expect(onOp).toHaveBeenCalledTimes(1)
    const op = onOp.mock.calls[0][0]
    expect(op.type).toBe('update')
    expect(op.match).toEqual(k)
    expect(op.patch.anchor).toBe('Head')
    expect(op.patch.pos).toBe(120)                    // clamped at the zone's edge: a plain drag cannot leave it
    expect(op.patch.value).toBeGreaterThan(1.0)       // it went up
  })

  it('Alt-drag across the zone edge changes the anchor to the zone under the pointer', async () => {
    const { onOp } = await mount()
    const k = PUNCH[1]
    const c = canvas()
    await fire(c, ptr('pointerdown', xOf(120, 960), yOf('zoom', k.value, PUNCH)))
    await fire(c, ptr('pointermove', xOf(420, 960), yOf('zoom', k.value, PUNCH), { altKey: true }))
    await fire(c, ptr('pointerup', xOf(420, 960), yOf('zoom', k.value, PUNCH), { altKey: true }))
    expect(onOp).toHaveBeenCalledTimes(1)
    const patch = onOp.mock.calls[0][0].patch
    expect(patch.anchor).toBe('Body')
    expect(patch.pos).toBeCloseTo(0.5, 2)             // 420 ticks is mid-body (120..720)
    // ...and on across the Body / Tail edge.
    onOp.mockClear()
    await fire(c, ptr('pointerdown', xOf(120, 960), yOf('zoom', k.value, PUNCH)))
    await fire(c, ptr('pointermove', xOf(900, 960), yOf('zoom', k.value, PUNCH), { altKey: true }))
    await fire(c, ptr('pointerup', xOf(900, 960), yOf('zoom', k.value, PUNCH), { altKey: true }))
    expect(onOp.mock.calls[0][0].patch).toMatchObject({ anchor: 'Tail' })
    expect(onOp.mock.calls[0][0].patch.pos).toBeCloseTo(60, 0)      // 60 ticks before the end
  })

  it('a drag that ends where it began commits nothing', async () => {
    const { onOp } = await mount()
    const y = yOf('zoom', 1.0, PUNCH)
    const c = canvas()
    await fire(c, ptr('pointerdown', xOf(120, 960), y))
    await fire(c, ptr('pointermove', xOf(300, 960), y))   // plain drag: clamped back to the Head's edge, same value
    await fire(c, ptr('pointerup', xOf(300, 960), y))
    expect(onOp).not.toHaveBeenCalled()
  })

  it('Escape cancels the gesture: nothing is sent', async () => {
    const { onOp } = await mount()
    const c = canvas()
    await fire(c, ptr('pointerdown', xOf(40, 960), laneMidY('centerY')))
    await fire(c, ptr('pointermove', xOf(90, 960), laneMidY('centerY') - 8))
    await fire(c, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await fire(c, ptr('pointerup', xOf(90, 960), laneMidY('centerY') - 8))
    expect(onOp).not.toHaveBeenCalled()
  })

  it('right-click on a filled key deletes it; on a hollow (inherited) key it does nothing', async () => {
    const hollow = [key('zoom', 'Head', 60, 1.2)]
    const own = [key('centerX', 'Body', 0.5, 0.1)]
    const { onOp } = await mount({ ownKeys: own, inheritedKeys: hollow })
    const c = canvas()
    await fire(c, ptr('contextmenu', xOf(420, 960), yOf('centerX', 0.1, own), { button: 2 }))
    expect(onOp).toHaveBeenCalledTimes(1)
    expect(onOp).toHaveBeenCalledWith({ type: 'remove', match: own[0] })
    onOp.mockClear()
    await fire(c, ptr('contextmenu', xOf(60, 960), yOf('zoom', 1.2, [...hollow]), { button: 2 }))
    expect(onOp).not.toHaveBeenCalled()
  })

  it('an inherited key cannot be dragged: it clears the selection and sends nothing', async () => {
    const hollow = [key('zoom', 'Head', 60, 1.2)]
    const { onOp, onSelect } = await mount({ ownKeys: [], inheritedKeys: hollow })
    const c = canvas()
    await fire(c, ptr('pointerdown', xOf(60, 960), yOf('zoom', 1.2, hollow)))
    await fire(c, ptr('pointermove', xOf(200, 960), yOf('zoom', 1.2, hollow) - 20))
    await fire(c, ptr('pointerup', xOf(200, 960), yOf('zoom', 1.2, hollow) - 20))
    expect(onOp).not.toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('read-only lanes edit nothing', async () => {
    const { onOp } = await mount({ readOnly: true })
    await fire(canvas(), ptr('pointerdown', xOf(300, 960), laneMidY('zoom')))
    await fire(canvas(), ptr('pointerup', xOf(300, 960), laneMidY('zoom')))
    expect(onOp).not.toHaveBeenCalled()
  })

  it('event lanes: keys are Origin keys in whole ticks, with no zones', async () => {
    const { onOp } = await mount({ kind: 'event', zones: undefined, lengthTicks: 1920, ownKeys: [], base: { zoom: 1, centerX: 0.5, centerY: 0.5, rotationDeg: 0 } })
    await fire(canvas(), ptr('pointerdown', xOf(960, 1920), laneMidY('zoom')))
    await fire(canvas(), ptr('pointerup', xOf(960, 1920), laneMidY('zoom')))
    const key1 = onOp.mock.calls[0][0].key
    expect(key1).toMatchObject({ channel: 'zoom', anchor: 'Origin' })
    expect(Number.isInteger(key1.pos)).toBe(true)
    expect(Math.abs(key1.pos - 960)).toBeLessThanOrEqual(2)
  })
})

describe('LensKeyLanes: the keyboard alternative to every drag', () => {
  it('Delete removes the selected key; arrows nudge it by a tick and a step of value', async () => {
    const k = key('zoom', 'Head', 100, 1.2)
    const { onOp, onSelect } = await mount({ ownKeys: [k], selected: k })
    const c = canvas()
    await fire(c, new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(onOp).toHaveBeenLastCalledWith({ type: 'update', match: k, patch: { pos: 101 } })
    await fire(c, new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(onOp.mock.calls[1][0].patch.value).toBeGreaterThan(1.2)
    await fire(c, new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    expect(onOp).toHaveBeenLastCalledWith({ type: 'remove', match: k })
    expect(onSelect).toHaveBeenLastCalledWith(null)
  })

  it('a key at its zone edge does not move past it (the engine would clamp it anyway)', async () => {
    const k = PUNCH[1]                                   // Head 120, the Head band's last tick
    const { onOp } = await mount({ selected: k })
    await fire(canvas(), new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(onOp).not.toHaveBeenCalled()
  })

  it('a Tail key nudges the other way (its position counts back from the note end)', async () => {
    const tail = key('zoom', 'Tail', 100, 1.1)
    const { onOp } = await mount({ ownKeys: [tail], selected: tail })
    await fire(canvas(), new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(onOp).toHaveBeenLastCalledWith({ type: 'update', match: tail, patch: { pos: 99 } })   // later in time = fewer ticks before the end
  })

  it('the bracket keys walk the keys; the canvas names what it holds', async () => {
    const { onSelect } = await mount()
    await fire(canvas(), new KeyboardEvent('keydown', { key: ']', bubbles: true }))
    expect(onSelect).toHaveBeenLastCalledWith(PUNCH[0])
    expect(canvas().getAttribute('aria-label')).toContain('2 keys')
    expect(canvas().getAttribute('data-hint')).toBeTruthy()
    expect(canvas().getAttribute('data-hint-mods')).toContain('Alt')
  })
})

describe('LensKeyInspector: the key, typed', () => {
  const renderInspector = async (keyObj, extra = {}) => {
    const onOp = vi.fn()
    const onSelect = vi.fn()
    await act(async () => {
      root.render(<LensKeyInspector keyObj={keyObj} kind="note" zones={DEFAULT_ZONES} lengthTicks={960} onOp={onOp} onSelect={onSelect} {...extra} />)
    })
    return { onOp, onSelect }
  }

  it('asks for a selection when there is none', async () => {
    await renderInspector(null)
    expect(container.querySelector('[data-testid="lens-key-empty"]')).not.toBeNull()
  })

  it('an anchor change is one update that keeps the key where it is in time', async () => {
    const k = key('zoom', 'Head', 100, 1.2)
    const { onOp, onSelect } = await renderInspector(k)
    const body = [...container.querySelectorAll('[aria-label="Key anchor"] [role="radio"]')].find((r) => r.textContent === 'Body')
    await act(async () => { body.click() })
    expect(onOp).toHaveBeenCalledTimes(1)
    expect(onOp).toHaveBeenCalledWith({ type: 'update', match: k, patch: { anchor: 'Body', pos: 0 } })
    expect(onSelect).toHaveBeenCalledWith({ ...k, anchor: 'Body', pos: 0 })
  })

  it('interpolation and delete each commit once; every control has a hint', async () => {
    const k = key('rotationDeg', 'Tail', 50, 12)
    const { onOp, onSelect } = await renderInspector(k)
    for (const label of ['Key value', 'Key anchor', 'Key position', 'Key interpolation']) {
      const el = container.querySelector(`[aria-label="${label}"]`)
      expect(el, label).not.toBeNull()
      expect(el.closest('[data-hint]')?.getAttribute('data-hint') ?? el.getAttribute('data-hint'), `${label} hint`).toBeTruthy()
    }
    await act(async () => { [...container.querySelectorAll('button')].find((b) => b.textContent === 'Delete key').click() })
    expect(onOp).toHaveBeenCalledWith({ type: 'remove', match: k })
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('an event key has no anchor control (event keys are ticks from the start)', async () => {
    await renderInspector(key('zoom', 'Origin', 480, 1.5), { kind: 'event' })
    expect(container.querySelector('[aria-label="Key anchor"]')).toBeNull()
    expect(container.querySelector('[aria-label="Key position"]')).not.toBeNull()
  })

  it('says so when Cut hides the key at this note length', async () => {
    const cutZones = { ...DEFAULT_ZONES, shortNote: 'Cut' }
    await renderInspector(key('zoom', 'Head', 100, 1.2), { zones: cutZones, lengthTicks: 300 })
    expect(container.querySelector('[data-testid="lens-key-unreached"]')).not.toBeNull()
  })
})
