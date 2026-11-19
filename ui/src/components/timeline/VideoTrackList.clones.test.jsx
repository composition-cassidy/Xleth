// @vitest-environment jsdom
//
// The grid editor's layer list and Clones (docs/XLETH_CLONE_SPEC.md): a Trail clone
// has no cell of its own (it always draws under its source), so it is not listed or
// placeable; a Voice clone owns a cell and is listed like any track.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import VideoTrackList from './VideoTrackList.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const LAYOUT = {
  columns: 2, rows: 2,
  slots: [
    { trackId: 1, gridX: 0, gridY: 0, spanX: 8, spanY: 8, opacity: 1, zOrder: 0 },
    { trackId: 2, gridX: 8, gridY: 0, spanX: 8, spanY: 8, opacity: 1, zOrder: 1 },
  ],
  fullscreenLayers: [],
}
const TRACKS = [
  { id: 1, name: 'Lead', type: 'Pattern', cloneOf: -1 },
  { id: 2, name: 'Lead · Clone 1', type: 'Pattern', cloneOf: 1, clone: { kind: 'Voice' } },
  { id: 3, name: 'Lead · Trail 1', type: 'Pattern', cloneOf: 1, clone: { kind: 'Trail', delayTicks: 480 } },
  { id: 4, name: 'Lead · Clone 2', type: 'Pattern', cloneOf: 1, clone: { kind: 'Voice' } },
]

let container, root

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container)
  root = createRoot(container)
  window.xleth = { timeline: {} }
})
afterEach(() => { act(() => root.unmount()); container.remove(); delete window.xleth })

const names = (selector) => Array.from(container.querySelectorAll(`${selector} .vtl-row-name`)).map((n) => n.textContent)

describe('VideoTrackList with Clones', () => {
  it('lists Voice clones like any track and leaves Trail clones out', async () => {
    await act(async () => { root.render(<VideoTrackList tracks={TRACKS} layout={LAYOUT} />) })
    expect(names('.vtl-list:not(.vtl-list--unplaced)')).toEqual(['Lead · Clone 1', 'Lead'])
    expect(names('.vtl-list--unplaced')).toEqual(['Lead · Clone 2'])
    expect(container.textContent).not.toContain('Trail 1')
  })
})
