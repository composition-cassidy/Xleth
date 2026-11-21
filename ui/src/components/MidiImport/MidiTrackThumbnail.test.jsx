// @vitest-environment jsdom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import MidiTrackThumbnail from './MidiTrackThumbnail.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root

function renderThumb(props) {
  act(() => {
    root.render(<MidiTrackThumbnail {...props} />)
  })
}

describe('MidiTrackThumbnail', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('renders one bar per non-zero bucket', () => {
    const buckets = new Array(96).fill(0)
    buckets[0] = 1
    buckets[48] = 4
    buckets[95] = 1

    renderThumb({ thumb: { startTick: 0, endTick: 9600, pitchMin: 60, pitchMax: 72, buckets } })

    const rects = container.querySelectorAll('svg[data-midi-thumbnail] rect')
    expect(rects.length).toBe(3)
  })

  it('scales bar height by density relative to the busiest bucket', () => {
    const buckets = new Array(96).fill(0)
    buckets[10] = 1
    buckets[20] = 4

    renderThumb({ thumb: { startTick: 0, endTick: 9600, pitchMin: 60, pitchMax: 60, buckets } })

    const rects = Array.from(container.querySelectorAll('svg[data-midi-thumbnail] rect'))
    const sparse = rects.find(r => Number(r.getAttribute('x')) < 11)
    const dense = rects.find(r => Number(r.getAttribute('x')) > 19)
    expect(Number(dense.getAttribute('height'))).toBeGreaterThan(Number(sparse.getAttribute('height')))
  })

  it('renders nothing when thumb data is missing or malformed', () => {
    renderThumb({ thumb: null })
    expect(container.querySelector('svg')).toBeNull()

    renderThumb({ thumb: { buckets: [1, 2, 3] } })
    expect(container.querySelector('svg')).toBeNull()
  })
})
