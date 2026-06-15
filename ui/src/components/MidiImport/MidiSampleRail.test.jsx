// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import MidiSampleRail from './MidiSampleRail.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root

function renderRail(props) {
  act(() => {
    root.render(<MidiSampleRail {...props} />)
  })
}

describe('MidiSampleRail', () => {
  beforeEach(() => {
    window.xleth = { video: {} }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('selects a sample tile and clears back to assign later', () => {
    const onChange = vi.fn()
    const items = [
      { id: 42, name: 'Kick', source: { id: 1, hasVideo: false } },
    ]

    renderRail({ items, value: null, onChange })
    const initialTiles = container.querySelectorAll('.midi-sample-tile')
    expect(initialTiles[0].getAttribute('aria-pressed')).toBe('true')

    act(() => {
      initialTiles[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith(42)

    renderRail({ items, value: 42, onChange })
    const selectedTiles = container.querySelectorAll('.midi-sample-tile')
    expect(selectedTiles[1].getAttribute('aria-pressed')).toBe('true')

    act(() => {
      selectedTiles[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('renders disabled tiles without firing selection', () => {
    const onChange = vi.fn()
    renderRail({
      items: [{ id: 42, name: 'Kick', source: { id: 1, hasVideo: false } }],
      value: 42,
      onChange,
      disabled: true,
    })

    const sampleTile = container.querySelectorAll('.midi-sample-tile')[1]
    expect(sampleTile.disabled).toBe(true)
    act(() => {
      sampleTile.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})
