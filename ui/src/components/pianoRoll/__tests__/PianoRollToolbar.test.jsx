/* @vitest-environment jsdom */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PianoRollToolbar from '../PianoRollToolbar.jsx'

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

    const loop = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Loop')
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
