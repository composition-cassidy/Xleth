// @vitest-environment jsdom
//
// Round 2 step 19.2: the arrangement toolbar and the Patterns column on kit controls.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import TimelineToolbar from './TimelineToolbar.jsx'
import PatternListPanel, { patternStepsLabel } from './PatternListPanel.jsx'
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
    expect(container.querySelector('.timeline-zoom-display').textContent).toBe(`40${T}px/beat`)
    expect(container.querySelector('.timeline-zoom-display').getAttribute('data-hint')).toBe('Zoom: 40 pixels per beat')
    for (const caps of ['SNAP', 'QN', 'ON']) expect(container.textContent).not.toContain(caps)
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
    expect(rows[0].textContent).toContain(`16${T}steps`)
    expect(rows[1].textContent).toContain(`32${T}steps`)
    act(() => { rows[0].click() })
    expect(onOpenPianoRoll).toHaveBeenCalledWith(1)
    usePianoRollStore.setState({ patternId: null })
  })

  it('opens a pattern from the keyboard', () => {
    const onOpenPianoRoll = vi.fn()
    act(() => { root.render(<PatternListPanel patterns={patterns} onOpenPianoRoll={onOpenPianoRoll} onToggleCollapsed={vi.fn()} />) })
    const row = container.querySelector('[role="option"]')
    act(() => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onOpenPianoRoll).toHaveBeenCalledWith(1)
  })
})
