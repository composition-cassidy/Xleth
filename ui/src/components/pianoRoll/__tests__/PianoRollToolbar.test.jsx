/* @vitest-environment jsdom */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PianoRollToolbar, { sampleOptions } from '../PianoRollToolbar.jsx'
import useSampleHoverStore from '../../../stores/sampleHoverStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderToolbar(props = {}) {
  const all = {
    patternName: 'Pattern 8',
    activeTool: 'pencil',
    onToolChange: vi.fn(),
    stickyNoteLength: 240,
    onStickyNoteLengthChange: vi.fn(),
    availablePatterns: [{ id: 7, name: 'Pattern 8' }, { id: 9, name: 'Chorus' }],
    currentPatternId: 7,
    onSwitchPattern: vi.fn(),
    onNewPattern: vi.fn(),
    regions: [{ id: 3, name: 'Pitch 2' }],
    currentRegionId: 3,
    ...props,
  }
  act(() => { root.render(<PianoRollToolbar {...all} />) })
  return all
}

describe('Piano Roll toolbar', () => {
  it('names every tool and its one-letter shortcut in the hint bar', () => {
    renderToolbar()
    const hints = ['Select tool (S)', 'Pencil tool (P)', 'Paint tool (B)', 'Slice tool (C)', 'Delete tool (D)']
    for (const h of hints) expect(container.querySelector(`[data-hint="${h}"]`)).not.toBeNull()
    expect(container.querySelector('[aria-label="Pencil tool"]').getAttribute('aria-pressed')).toBe('true')
  })

  it('lays the tools out Pencil, Paint, Delete, Slice, Select, with only the active one pressed', () => {
    renderToolbar({ activeTool: 'split' })
    const tools = [...container.querySelectorAll('[role="toolbar"] button')]
    expect(tools.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Pencil tool', 'Paint tool', 'Delete tool', 'Slice tool', 'Select tool',
    ])
    expect(tools.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'true', 'false'])
  })

  it('switches tools through the same callback the shortcuts use', () => {
    const p = renderToolbar()
    act(() => { container.querySelector('[aria-label="Slice tool"]').click() })
    expect(p.onToolChange).toHaveBeenCalledWith('split')
  })

  it('plays the pattern on its own and flips loop through separate controls', () => {
    const p = renderToolbar({ auditionAvailable: true, auditionLoop: true, onToggleAudition: vi.fn(), onAuditionLoopChange: vi.fn() })
    const play = container.querySelector('[aria-label="Play pattern"]')
    expect(play.getAttribute('aria-pressed')).toBe('false')
    act(() => { play.click() })
    expect(p.onToggleAudition).toHaveBeenCalledTimes(1)

    const loop = container.querySelector('[aria-label="Loop"]')
    expect(loop.getAttribute('aria-pressed')).toBe('true')
    act(() => { loop.click() })
    expect(p.onAuditionLoopChange).toHaveBeenCalledWith(false)
  })

  it('shows Stop while auditioning and disables Play with nothing to play', () => {
    renderToolbar({ auditioning: true, auditionAvailable: true })
    const stop = container.querySelector('[aria-label="Stop pattern"]')
    expect(stop.getAttribute('aria-pressed')).toBe('true')
    renderToolbar({ auditioning: false, auditionAvailable: false })
    expect(container.querySelector('[aria-label="Play pattern"]').disabled).toBe(true)
  })

  it('keeps the row to what is used while writing: no zoom, ghosts, quick notation or scale root/mode in it', () => {
    renderToolbar({ scale: { enabled: true, root: 2, mode: 'aeolian' } })
    for (const label of ['Zoom in', 'Zoom out', 'Quick notation', 'Scale root', 'Scale']) {
      expect(container.querySelector(`[aria-label="${label}"]`)).toBeNull()
    }
    // The Scale button names the scale in short form and does not widen the row.
    const scaleButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'D Minor')
    expect(scaleButton?.getAttribute('aria-pressed')).toBe('true')
  })

  it('runs a roll command from the menu and prints its shortcut', () => {
    const onCommand = vi.fn()
    renderToolbar({ onCommand, keymap: { selectAll: ['Ctrl+a'] }, selectionCount: 0 })
    act(() => { container.querySelector('[aria-label="Piano roll menu"]').click() })
    const select = Array.from(document.querySelectorAll('[role^="menuitem"]')).find((b) => b.textContent === 'Select')
    act(() => { select.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); select.click() })
    const all = Array.from(document.querySelectorAll('[role^="menuitem"]')).find((b) => b.textContent.startsWith('All'))
    expect(all.textContent).toContain('Ctrl + A')
    act(() => { all.click() })
    expect(onCommand).toHaveBeenCalledWith('selectAll')
  })

  it('has no note-length control: new notes take the length of the last note touched', () => {
    renderToolbar()
    expect(container.querySelector('[aria-label="Note length"]')).toBeNull()
    expect(container.textContent).not.toContain('Length')
  })

  it('lists swapped samples first, under their own header, and the rest after', () => {
    const regions = [
      { id: 1, name: 'Kick' },
      { id: 2, name: 'Vox', hasSwappedAudio: true },
      { id: 3, name: 'Hat' },
      { id: 4, name: 'Clip', hasSwappedVideo: true },
    ]
    const opts = sampleOptions(regions)
    expect(opts.map((o) => [o.value, o.group])).toEqual([
      [-1, undefined], [2, 'Swapped'], [4, 'Swapped'], [1, 'Samples'], [3, 'Samples'],
    ])
    // With nothing swapped the list is flat, as before.
    expect(sampleOptions(regions.slice(0, 1)).every((o) => o.group === undefined)).toBe(true)
  })

  it('tells the Sample Selector which sample the pointer is on, and clears it when the list closes', () => {
    renderToolbar({ regions: [{ id: 3, name: 'Pitch 2' }, { id: 5, name: 'Vox', hasSwappedAudio: true }], currentRegionId: 3 })
    act(() => { container.querySelector('[aria-label="Sample region"]').click() })
    // Opening highlights the current sample.
    expect(useSampleHoverStore.getState().regionId).toBe(3)
    const vox = document.querySelector('[role="option"][data-value="5"]')
    act(() => { vox.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(useSampleHoverStore.getState().regionId).toBe(5)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(useSampleHoverStore.getState().regionId).toBeNull()
  })

  it('has one pattern control and no duplicated title label', () => {
    renderToolbar()
    const text = container.textContent
    expect(text.match(/Pattern 8/g)).toHaveLength(1)
    expect(text).not.toMatch(/·/)
  })

  it('shows the reference-slot select only for a multi-slot region', () => {
    renderToolbar({ regionSlots: [{ name: 'A' }] })
    expect(container.querySelector('[aria-label="Reference slot"]')).toBeNull()
    renderToolbar({ regionSlots: [{ name: 'A' }, { name: 'B' }] })
    expect(container.querySelector('[aria-label="Reference slot"]')).not.toBeNull()
  })
})
