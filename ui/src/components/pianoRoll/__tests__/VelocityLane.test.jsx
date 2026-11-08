/* @vitest-environment jsdom */
import React, { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VelocityLane, { lollipopGroups, valueToY, velocityToMidi, yToValue } from '../VelocityLane.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('velocity lane scale', () => {
  it('draws and reads values on the same scale', () => {
    for (const h of [48, 80, 240]) {
      for (const v of [0, 0.25, 0.5, 1]) expect(yToValue(valueToY(v, h), h)).toBeCloseTo(v, 9)
    }
    expect(valueToY(1, 80)).toBe(5)
    expect(valueToY(0, 80)).toBe(77)
  })

  it('speaks 1..127', () => {
    expect(velocityToMidi(1)).toBe(127)
    expect(velocityToMidi(0)).toBe(1)
    expect(velocityToMidi(0.5)).toBe(64)
  })

  it('stacks notes that share a start, highest head first', () => {
    const notes = [
      { id: 1, positionTicks: 0, velocity: 0.4 },
      { id: 2, positionTicks: 0, velocity: 0.9 },
      { id: 3, positionTicks: 960, velocity: 0.7 },
    ]
    const groups = lollipopGroups(notes, 80, 0, 800, (n) => n.velocity)
    expect(groups).toHaveLength(2)
    expect(groups[0].notes.map((n) => n.id)).toEqual([2, 1])
    expect(groups[1].x).toBe(80)
  })
})

describe('velocity lane drag', () => {
  let container
  let root
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('previews locally and commits once on release, at the value under the pointer', () => {
    const onSetVelocity = vi.fn()
    const onSetVelocities = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const notes = [
      { id: 1, positionTicks: 0, velocity: 0.4 },
      { id: 2, positionTicks: 0, velocity: 0.9 },
    ]
    act(() => {
      root.render(
        <VelocityLane
          ref={createRef()}
          notes={notes}
          selectedNoteIds={new Set()}
          pixelsPerBeatRef={{ current: 80 }}
          scrollXRef={{ current: 0 }}
          width={400}
          height={80}
          onSetVelocity={onSetVelocity}
          onSetVelocities={onSetVelocities}
        />,
      )
    })
    const lane = container.firstChild
    lane.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 80, width: 400, height: 80, x: 0, y: 0 })
    // Press near the LOW head of the stack (note 1 at 0.4): that note is grabbed.
    const y = valueToY(0.4, 80)
    act(() => { lane.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 1, clientY: y })) })
    act(() => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: valueToY(0.6, 80) })) })
    expect(onSetVelocity).not.toHaveBeenCalled()
    act(() => { window.dispatchEvent(new MouseEvent('mouseup', {})) })
    expect(onSetVelocity).toHaveBeenCalledTimes(1)
    expect(onSetVelocity.mock.calls[0][0]).toBe(1)
    expect(onSetVelocity.mock.calls[0][1]).toBeCloseTo(0.6, 6)
  })
})
