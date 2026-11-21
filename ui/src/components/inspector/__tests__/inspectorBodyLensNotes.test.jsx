/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import useInspectorStore from '../../../stores/useInspectorStore.js'
import useNoteSelectionStore from '../../../stores/useNoteSelectionStore.js'
import useLensPanelMode from '../../../lensRoam/lensPanelMode.js'
import InspectorBody from '../InspectorBody.jsx'

// The Inspector shows the Lens panel of a picked NOTE's source in Advanced, and only
// then: Simple never changes what the Inspector follows (Advanced only reveals more).
vi.mock('../PatternSourceInspector.jsx', () => ({
  default: ({ selection }) => <div data-testid="source-inspector">{`${selection.trackId}:${selection.regionId}:${selection.patternId}`}</div>,
}))
vi.mock('../../timeline/TrackVideoProperties.jsx', () => ({
  default: ({ trackId }) => <div data-testid="track-props">{trackId}</div>,
}))
vi.mock('../ClipInspector.jsx', () => ({ default: () => <div data-testid="clip-inspector" /> }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }

beforeEach(() => {
  window.xleth = {
    timeline: {
      getPattern: vi.fn(async (id) => (id === 4 ? { id: 4, regionId: 9, lengthTicks: 3840, notes: [] } : null)),
      getPatternBlocks: vi.fn(async () => [{ id: 1, trackId: 6, patternId: 4 }]),
    },
  }
  useInspectorStore.setState({ selection: { kind: 'track', trackId: 2 }, clip: null, clipActions: null })
  useNoteSelectionStore.getState().clear()
  useLensPanelMode.setState({ mode: 'simple' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete window.xleth
})

const mount = async () => { await act(async () => { root.render(<InspectorBody />) }); await flush() }
const pickNote = async () => { await act(async () => { useNoteSelectionStore.setState({ byPattern: { 4: new Set([1]) } }) }); await flush() }

describe('InspectorBody and the note selection', () => {
  it('Simple: picking a note leaves the Inspector on the arrangement selection', async () => {
    await mount()
    await pickNote()
    expect(container.querySelector('[data-testid="track-props"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="source-inspector"]')).toBeNull()
  })

  it('Advanced: picking a note shows the Lens panel of its source {track, region}', async () => {
    useLensPanelMode.setState({ mode: 'advanced' })
    await mount()
    expect(container.querySelector('[data-testid="track-props"]')).not.toBeNull()   // nothing picked yet
    await pickNote()
    expect(container.querySelector('[data-testid="source-inspector"]').textContent).toBe('6:9:4')
  })

  it('Advanced: touching the arrangement afterwards gives the Inspector back to it', async () => {
    useLensPanelMode.setState({ mode: 'advanced' })
    await mount()
    await pickNote()
    await act(async () => { useInspectorStore.setState({ selection: { kind: 'track', trackId: 3 } }) })
    await flush()
    expect(container.querySelector('[data-testid="track-props"]').textContent).toBe('3')
  })

  it('Advanced: deselecting the notes returns to the arrangement selection', async () => {
    useLensPanelMode.setState({ mode: 'advanced' })
    await mount()
    await pickNote()
    await act(async () => { useNoteSelectionStore.getState().clear() })
    await flush()
    expect(container.querySelector('[data-testid="source-inspector"]')).toBeNull()
    expect(container.querySelector('[data-testid="track-props"]')).not.toBeNull()
  })
})
