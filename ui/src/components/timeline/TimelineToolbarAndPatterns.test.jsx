// @vitest-environment jsdom
//
// Round 2 step 19.2: the arrangement toolbar and the Patterns column on kit controls.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import TimelineToolbar, { zoomReadout } from './TimelineToolbar.jsx'
import PatternListPanel, { patternOwnerColors, patternPreviewRects, patternStepsLabel } from './PatternListPanel.jsx'
import usePianoRollStore from '../../stores/usePianoRollStore.js'
import { THIN_SPACE as T } from '../../ui-kit'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container, root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const renderToolbar = (props = {}) => act(() => {
  root.render(
    <TimelineToolbar
      activeTool="select" setActiveTool={vi.fn()}
      activeSampleId={null} regions={{}}
      snapGranularity="1/16" onSnapGranularityChange={vi.fn()}
      pixelsPerBeat={40}
      onAddTrack={vi.fn()} onAddFolder={vi.fn()}
      onOpenQuantize={vi.fn()} onOpenQuickNotation={vi.fn()}
      {...props}
    />,
  )
})

describe('arrangement toolbar', () => {
  it('names each tool with its one-letter key and marks the active one pressed', () => {
    renderToolbar({ activeTool: 'pencil' })
    const keys = { Select: 'S', Pencil: 'P', Split: 'C', Delete: 'D' }
    for (const [name, key] of Object.entries(keys)) {
      const b = container.querySelector(`button[aria-label="${name} tool"]`)
      expect(b, name).toBeTruthy()
      expect(b.getAttribute('data-hint')).toBe(`${name} tool (${key})`)
      expect(b.getAttribute('aria-pressed')).toBe(name === 'Pencil' ? 'true' : 'false')
    }
  })

  it('says nothing about a sample when none is selected, and "Painting with:" when one is', () => {
    renderToolbar()
    expect(container.textContent).not.toContain('Painting with')
    expect(container.textContent).not.toContain('No sample')
    renderToolbar({ activeSampleId: 's1', regions: { s1: { name: 'Pitch 1', label: 'Pitch' } } })
    expect(container.textContent).toContain('Painting with:')
    expect(container.textContent).toContain('Pitch 1')
  })

  it('has snap as a labelled Select and a sentence-case, unit-bearing zoom readout', () => {
    renderToolbar()
    expect(container.textContent).toContain('Snap')
    expect(container.querySelector('[aria-label="Snap"]')).toBeTruthy()
    // With no measured lane width (this render) the readout falls back to the engine-side zoom value.
    expect(container.querySelector('.timeline-zoom-display').textContent).toBe(`40${T}px/beat`)
    expect(container.querySelector('.timeline-zoom-display').getAttribute('data-hint')).toBe('Zoom: 40 pixels per beat')
    for (const caps of ['SNAP', 'QN', 'ON']) expect(container.textContent).not.toContain(caps)
  })

  it('reads the zoom in bars visible; pixels per beat stays in the hint', () => {
    renderToolbar({ pixelsPerBeat: 33, viewportWidth: 1305 })
    const zoom = container.querySelector('.timeline-zoom-display')
    // 1305px at 33 px/beat is 39.5 beats: 9.9 bars.
    expect(zoom.textContent).toBe(`9.9${T}bars`)
    expect(zoom.getAttribute('aria-label')).toBe('Zoom: 9.9 bars visible')
    expect(zoom.getAttribute('data-hint')).toBe('Zoom: 9.9 bars visible (33 pixels per beat)')
  })

  it('zoomReadout: whole bars from ten up, one decimal under ten, beats under one bar, px/beat without a width', () => {
    expect(zoomReadout(8, 1280).text).toBe(`40${T}bars`)
    expect(zoomReadout(40, 1280).text).toBe(`8${T}bars`)
    expect(zoomReadout(40, 160).text).toBe(`1${T}bar`)
    expect(zoomReadout(400, 1280).text).toBe(`3.2${T}beats`)
    expect(zoomReadout(1280, 1280).text).toBe(`1${T}beat`)
    expect(zoomReadout(40, 0).text).toBe(`40${T}px/beat`)
    expect(zoomReadout(40, undefined).bars).toBeNull()
  })

  it('disables quantize with nothing selected and enables it with a selection', () => {
    renderToolbar()
    expect(container.querySelector('button[aria-label="Quantize"]').disabled).toBe(true)
    renderToolbar({ quantizeSelectionCount: 3 })
    const q = container.querySelector('button[aria-label="Quantize"]')
    expect(q.disabled).toBe(false)
    expect(q.getAttribute('data-hint')).toBe('Quantize 3 selected')
  })
})

describe('patterns column', () => {
  const patterns = {
    1: { id: 1, name: 'Pattern 1', lengthTicks: 3840, notes: new Array(5) },
    2: { id: 2, name: 'Pattern 2', lengthTicks: 7680, notes: [] },
  }

  it('prints length in steps with the unit', () => {
    expect(patternStepsLabel(3840)).toBe(`16${T}steps`)
    expect(patternStepsLabel(7680)).toBe(`32${T}steps`)
    expect(patternStepsLabel(240)).toBe(`1${T}step`)
    expect(patternStepsLabel(360)).toBe(`1.5${T}steps`)
  })

  it('lists rows as options, selects the pattern open in the Piano Roll, and opens one on click', () => {
    usePianoRollStore.setState({ patternId: 2 })
    const onOpenPianoRoll = vi.fn()
    act(() => { root.render(<PatternListPanel patterns={patterns} onOpenPianoRoll={onOpenPianoRoll} onToggleCollapsed={vi.fn()} />) })
    const rows = Array.from(container.querySelectorAll('[role="option"]'))
    expect(rows.map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true'])
    // A row is the name and a preview of the notes; the length in steps is in the hint.
    expect(rows[0].textContent).toBe('Pattern 1')
    expect(rows[0].getAttribute('data-hint')).toBe(`Pattern 1: 16${T}steps, 5 notes, not placed`)
    expect(rows[1].getAttribute('data-hint')).toBe(`Pattern 2: 32${T}steps, 0 notes, not placed`)
    expect(rows[0].querySelector('canvas')).not.toBeNull()
    expect(container.querySelector('[role="listbox"]').getAttribute('aria-label')).toBe('Patterns')
    act(() => { rows[0].click() })
    expect(onOpenPianoRoll).toHaveBeenCalledWith(1)
    usePianoRollStore.setState({ patternId: null })
  })

  it('a row wears the colour of the track its first block sits on; an unplaced pattern takes the value colour', () => {
    const tracks = [{ id: 7, name: 'bass', type: 'Pattern', trackColorMode: 'custom', trackColorCustom: '#D76A8F' }]
    const blocks = [
      { id: 2, patternId: 1, trackId: 9, positionTicks: 7680 },
      { id: 1, patternId: 1, trackId: 7, positionTicks: 0 },
    ]
    expect(patternOwnerColors(blocks, { 7: '#D76A8F', 9: '#58B2CE' })).toEqual({ 1: '#D76A8F' })
    expect(patternOwnerColors([], { 7: '#D76A8F' })).toEqual({})

    act(() => { root.render(<PatternListPanel patterns={patterns} tracks={tracks} blocks={blocks} onToggleCollapsed={vi.fn()} />) })
    const rows = Array.from(container.querySelectorAll('[role="option"]'))
    const edge = (row) => row.firstElementChild.style.background
    expect(edge(rows[0])).toMatch(/rgb\(215, 106, 143\)|#D76A8F/i)
    expect(edge(rows[1])).toBe('var(--ui-value)')
    expect(rows[0].getAttribute('data-hint')).toBe(`Pattern 1: 16${T}steps, 5 notes`)
  })

  it('patternPreviewRects: x by time, y by pitch within the pattern own range, every note at least 1px wide', () => {
    const p = { lengthTicks: 3840, notes: [
      { positionTicks: 0, durationTicks: 960, pitch: 60 },
      { positionTicks: 1920, durationTicks: 1, pitch: 72 },
      { positionTicks: 3840, durationTicks: 960, pitch: 66 },
    ] }
    const rects = patternPreviewRects(p, 40, 14)
    // The note that starts at the pattern's end is outside the box.
    expect(rects).toHaveLength(2)
    expect(rects[0]).toEqual({ x: 0, y: 12, w: 10, h: 2 })
    expect(rects[1]).toMatchObject({ x: 20, y: 0, w: 1 })
    expect(patternPreviewRects({ lengthTicks: 3840, notes: [] }, 40, 14)).toEqual([])
    expect(patternPreviewRects({ lengthTicks: 0, notes: [{ positionTicks: 0, durationTicks: 1, pitch: 60 }] }, 40, 14)).toEqual([])
    // One pitch only: the notes sit on the bottom row, nothing divides by zero.
    expect(patternPreviewRects({ lengthTicks: 960, notes: [{ positionTicks: 0, durationTicks: 960, pitch: 60 }] }, 40, 14)[0].y).toBe(12)
  })

  it('opens a pattern from the keyboard', () => {
    const onOpenPianoRoll = vi.fn()
    act(() => { root.render(<PatternListPanel patterns={patterns} onOpenPianoRoll={onOpenPianoRoll} onToggleCollapsed={vi.fn()} />) })
    const row = container.querySelector('[role="option"]')
    act(() => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onOpenPianoRoll).toHaveBeenCalledWith(1)
  })
})
