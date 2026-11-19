/* @vitest-environment jsdom */
// Voice pins in the Piano Roll (docs/XLETH_CLONE_SPEC.md "Pinned"): the selection's
// pin, the "V1" marker drawn on a pinned note, the toolbar's Voice control (only
// when the pattern's track has Voice clones) and which source the roll pins against.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  notePin, selectedNoteRefs, selectionPin, voicePinMark, voicePinSelectOptions,
} from '../voicePin.js'
import { drawNotes, noteStyle } from '../pianoRollNotes.js'
import { voiceSourceFor } from '../usePatternContext.js'
import PianoRollToolbar from '../PianoRollToolbar.jsx'

vi.mock('../../../theming/tokenValue.ts', () => ({ tokenValue: () => '' }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const tracks = [
  { id: 1, name: 'Lead', type: 'Pattern', order: 0, cloneOf: -1 },
  { id: 2, name: 'Lead · Clone 1', type: 'Pattern', order: 1, cloneOf: 1, clone: { kind: 'Voice' } },
  { id: 3, name: 'Lead · Trail 1', type: 'Pattern', order: 2, cloneOf: 1, clone: { kind: 'Trail' } },
  { id: 4, name: 'Lead · Clone 2', type: 'Pattern', order: 3, cloneOf: 1, clone: { kind: 'Voice' } },
  { id: 5, name: 'Pad', type: 'Pattern', order: 4, cloneOf: -1 },
  { id: 6, name: 'Pad · Clone 1', type: 'Pattern', order: 5, cloneOf: 5, clone: { kind: 'Voice' } },
  { id: 7, name: 'Bass', type: 'Pattern', order: 6, cloneOf: -1 },
]

describe('pins', () => {
  const notes = [
    { id: 1, voicePin: 1 }, { id: 2, voicePin: 1 }, { id: 3 }, { id: 4, voicePin: -1 }, { id: 5, voicePin: 0 },
  ]

  it('reads a note\'s pin: absent and -1 are Auto', () => {
    expect(notes.map(notePin)).toEqual([1, 1, -1, -1, 0])
  })

  it('the selection\'s shared pin, "mixed", or null with nothing selected', () => {
    expect(selectionPin(notes, new Set([1, 2]))).toBe(1)
    expect(selectionPin(notes, new Set([3, 4]))).toBe(-1)
    expect(selectionPin(notes, new Set([1, 5]))).toBe('mixed')
    expect(selectionPin(notes, new Set())).toBeNull()
    expect(selectionPin(notes, new Set([99]))).toBeNull()
  })

  it('marks V0 for the source and Vk for Clone k; nothing for Auto or a pin to a missing voice', () => {
    expect(voicePinMark({ voicePin: 0 }, 2)).toBe('V0')
    expect(voicePinMark({ voicePin: 2 }, 2)).toBe('V2')
    expect(voicePinMark({ voicePin: 3 }, 2)).toBeNull()
    expect(voicePinMark({}, 2)).toBeNull()
    expect(voicePinMark({ voicePin: 1 }, 0)).toBeNull()
  })

  it('options: Auto, the source, then each Voice clone in order (Trails are not voices)', () => {
    expect(voicePinSelectOptions(tracks, 1).map((o) => [o.value, o.label])).toEqual([
      [-1, 'Auto'], [0, 'Source (Lead)'], [1, 'Lead · Clone 1'], [2, 'Lead · Clone 2'],
    ])
  })

  it('refs for one engine command: {patternId, noteId} per selected note', () => {
    expect(selectedNoteRefs(9, notes, new Set([2, 5]))).toEqual([{ patternId: 9, noteId: 2 }, { patternId: 9, noteId: 5 }])
    expect(selectedNoteRefs(9, notes, new Set())).toEqual([])
    expect(selectedNoteRefs(null, notes, new Set([2]))).toEqual([])
  })
})

describe('which source the roll pins against', () => {
  const block = (trackId, positionTicks) => ({ trackId, patternId: 11, positionTicks, durationTicks: 960 })

  it('the anchor track when it has Voice clones', () => {
    expect(voiceSourceFor(tracks, [block(5, 0), block(1, 960)], 11, 5)).toEqual({ sourceId: 5, count: 1 })
  })

  it('else the track playing the pattern with the most Voice clones', () => {
    expect(voiceSourceFor(tracks, [block(7, 0), block(5, 960), block(1, 1920)], 11, 7)).toEqual({ sourceId: 1, count: 2 })
  })

  it('null when no track playing it has Voice clones', () => {
    expect(voiceSourceFor(tracks, [block(7, 0)], 11, 7)).toBeNull()
    expect(voiceSourceFor(tracks, [], 11, null)).toBeNull()
  })
})

describe('the V marker on the canvas', () => {
  const PALETTE = { g0: '#141414', g1: '#1B1B1B', g4: '#3A3A3A', boundary: '#747474', ink: '#E6E6E6', value: '#33CED6', select: '#33CED6', font: 'sans-serif' }

  function textsDrawn(notes, voiceCount) {
    const calls = []
    const ctx = new Proxy({}, {
      get: (t, p) => (p in t ? t[p] : p === 'measureText' ? (s) => ({ width: s.length * 6 }) : (...a) => calls.push([p, ...a])),
      set: (t, p, v) => { t[p] = v; return true },
    })
    const style = noteStyle({ color: '#58B2CE', palette: PALETTE, voiceCount })
    drawNotes(ctx, 800, 400, notes, new Set(), 80, 14, 0, (131 - 70) * 14, style)
    return calls.filter((c) => c[0] === 'fillText').map((c) => [c[1], c[2]])
  }

  it('a pinned note shows its voice at its right end, after the note name', () => {
    const texts = textsDrawn([{ id: 1, positionTicks: 0, durationTicks: 960, pitch: 60, velocity: 1, voicePin: 1 }], 2)
    expect(texts.map((t) => t[0])).toEqual(['C4', 'V1'])
    // 80px note: the mark ends 3px inside the right edge.
    expect(texts[1][1]).toBe(80 - 3 - 12)
  })

  it('Auto notes, and every note when the track has no Voice clones, show no marker', () => {
    expect(textsDrawn([{ id: 1, positionTicks: 0, durationTicks: 960, pitch: 60, velocity: 1 }], 2).map((t) => t[0])).toEqual(['C4'])
    expect(textsDrawn([{ id: 1, positionTicks: 0, durationTicks: 960, pitch: 60, velocity: 1, voicePin: 1 }], 0).map((t) => t[0])).toEqual(['C4'])
  })

  it('the note name wins when both do not fit', () => {
    // 2/8 beat = 20px: room 14, "C4" is 12px, "C4" + 4 + "V1" is 28px.
    const texts = textsDrawn([{ id: 1, positionTicks: 0, durationTicks: 240, pitch: 60, velocity: 1, voicePin: 1 }], 2)
    expect(texts.map((t) => t[0])).toEqual(['C4'])
  })
})

describe('the toolbar Voice control', () => {
  let container
  let root
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = '' })

  function renderToolbar(props = {}) {
    const all = {
      patternName: 'Pattern 8', activeTool: 'pencil', onToolChange: vi.fn(),
      stickyNoteLength: 240, onStickyNoteLengthChange: vi.fn(),
      availablePatterns: [{ id: 7, name: 'Pattern 8' }], currentPatternId: 7,
      regions: [], currentRegionId: -1,
      ...props,
    }
    act(() => { root.render(<PianoRollToolbar {...all} />) })
    return all
  }
  const trigger = () => container.querySelector('[aria-label="Voice of the selected notes"]')

  it('is absent when the pattern\'s track has no Voice clones', () => {
    renderToolbar()
    expect(trigger()).toBeNull()
  })

  it('shows the selection\'s pin, "Mixed", or is disabled with nothing selected', () => {
    const options = voicePinSelectOptions(tracks, 1)
    renderToolbar({ voicePinOptions: options, voicePinValue: 1 })
    expect(trigger().textContent).toContain('Lead · Clone 1')
    renderToolbar({ voicePinOptions: options, voicePinValue: 'mixed' })
    expect(trigger().textContent).toContain('Mixed')
    renderToolbar({ voicePinOptions: options, voicePinValue: null })
    expect(trigger().disabled).toBe(true)
  })

  it('choosing a voice commits it through one callback', () => {
    const onVoicePinChange = vi.fn()
    renderToolbar({ voicePinOptions: voicePinSelectOptions(tracks, 1), voicePinValue: -1, onVoicePinChange })
    act(() => { trigger().click() })
    const option = Array.from(document.querySelectorAll('[role="option"]')).find((o) => o.textContent.includes('Lead · Clone 2'))
    act(() => { option.click() })
    expect(onVoicePinChange).toHaveBeenCalledWith(2)
  })
})
