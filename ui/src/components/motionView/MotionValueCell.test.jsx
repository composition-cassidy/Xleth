// @vitest-environment jsdom
//
// The Motion view value cell (docs/XLETH_MOTION_VIEW_DESIGN.md R1, R4, 5.7): units,
// true minus and thin space from the schema; one plan per commit; a blocked cell
// is disabled and says why; the read-through motion blur choice.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import MotionValueCell, { motionBlurOptions, motionBlurPatch, valueText } from './MotionValueCell.jsx'
import { buildMotionRows } from '../../motion/rowRegistry.js'
import { formatValue, propertyById } from '../../motion/schema.js'
import { useMotionViewStore } from '../../motion/motionViewStore.js'
import { fixtureData, fixtureTracks } from '../../motion/providers/__tests__/fixtures.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const data = fixtureData()
const L = buildMotionRows({
  tracks: fixtureTracks(), data,
  expanded: new Set(['t:1', 't:1/roam', 't:1/roam/masks', 't:1/mask:1', 't:2', 't:2/lens']),
  trackRowHeight: 28,
})
const row = (k) => L.byKey.get(k)

let container
let root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useMotionViewStore.getState().reset({ all: true })
})
afterEach(() => { act(() => root.unmount()); container.remove() })

const render = (props) => act(() => { root.render(<MotionValueCell {...props} />) })

describe('value text', () => {
  it('formats with the schema: true minus, thin space, units', () => {
    const ox = propertyById('roam.offsetX')
    expect(valueText(ox, -0.25)).toBe(formatValue(ox, -0.25))
    expect(valueText(ox, -0.25)).toContain('−')
    expect(valueText(propertyById('roam.scale'), 1)).toBe(formatValue(propertyById('roam.scale'), 1))
    expect(valueText(ox, null)).toBe('—')
  })

  it('the motion blur row is the PROJECT setting: "Project · 180°", Off = disabled (R1)', () => {
    const opts = motionBlurOptions({ enabled: true, shutterAngleDeg: 180 })
    expect(opts[0]).toEqual({ value: 0, label: 'Off' })
    expect(opts.map((o) => o.label)).toContain('180°')
    expect(motionBlurOptions({ enabled: true, shutterAngleDeg: 123 }).at(-1)).toEqual({ value: 123, label: '123°' })
    expect(motionBlurPatch(270, null)).toEqual({ enabled: true, shutterAngle: 270 })
    expect(motionBlurPatch(0, { enabled: true, shutterAngleDeg: 90 })).toEqual({ enabled: false, shutterAngle: 90 })
  })
})

describe('MotionValueCell', () => {
  it('a scalar cell: wheel off, the live value, ONE plan per commit', async () => {
    const onPlan = vi.fn(async () => ({ changed: true }))
    const r = row('t:1/roam/roam.scale')
    render({ row: r, value: 1, animated: false, onPlan, hint: 'Scale' })
    const box = container.querySelector('[role="slider"]')
    expect(box).toBeTruthy()
    expect(container.textContent).toContain(formatValue(r.prop, 1))
    // Wheel is off (the tree scrolls): its hint mods do not offer it.
    expect(box.closest('[data-hint-mods]')?.getAttribute('data-hint-mods') ?? '').not.toMatch(/Wheel/)
    await act(async () => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    expect(onPlan).toHaveBeenCalledTimes(1)
    expect(onPlan.mock.calls[0][0]).toBe(r)
    expect(onPlan.mock.calls[0][1]).toBeGreaterThan(1)
    expect(useMotionViewStore.getState().draft).toBeNull()        // the gesture left no draft behind
  })

  it('a blocked cell is disabled and its hint says why', () => {
    render({ row: row('t:2/lens/clipLens.zoom'), value: 1, blocker: 'No clip under the playhead on this track', onPlan: vi.fn() })
    const box = container.querySelector('[role="slider"]')
    expect(box.getAttribute('aria-disabled') === 'true' || box.tabIndex === -1).toBe(true)
    expect(container.innerHTML).toContain('No clip under the playhead on this track')
  })

  it('no value: a dash, not a number', () => {
    render({ row: row('t:2/lens/clipLens.zoom'), value: null, onPlan: vi.fn() })
    expect(container.textContent).toBe('—')
  })

  it('pickers: enum / bool / shape kind / motion blur', () => {
    render({ row: row('t:1/roam/roam.bounds'), value: 'Clip', onPlan: vi.fn() })
    expect(container.querySelector('[data-testid="motion-value-t:1/roam/roam.bounds"]')).toBeTruthy()
    render({ row: row('t:1/mask:1/mask.invert'), value: false, onPlan: vi.fn() })
    expect(container.textContent).toContain('Off')
    render({ row: row('t:1/mask:1/mask.shape'), value: { kind: 'Rectangle' }, onPlan: vi.fn() })
    expect(container.textContent).toContain('Rectangle')
    render({ row: row('t:1/roam/roam.motionBlur'), value: { enabled: true, shutterAngleDeg: 180 }, onMotionBlur: vi.fn() })
    expect(container.textContent).toContain('180°')
  })
})
