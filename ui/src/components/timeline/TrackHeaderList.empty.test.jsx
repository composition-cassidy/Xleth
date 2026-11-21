// @vitest-environment jsdom
//
// Phase 3: an empty arrangement keeps its structure. The header column shows
// two ghost rows that call the existing add-track actions; once a track exists
// they give way to the normal "Add Track" footer row.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import TrackHeaderList from './TrackHeaderList.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container, root

function render(props) {
  act(() => {
    root.render(
      <TrackHeaderList
        tracks={[]}
        folderLayout={null}
        onAddTrack={vi.fn()}
        onMute={vi.fn()} onSolo={vi.fn()} onVisualOnly={vi.fn()}
        onRename={vi.fn()} onRemove={vi.fn()}
        trackHeight={36}
        {...props}
      />,
    )
  })
}

const buttons = () => Array.from(container.querySelectorAll('button'))
const byText = (t) => buttons().find((b) => b.textContent.trim() === t)

describe('TrackHeaderList — empty arrangement', () => {
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('shows two lane-height ghost rows that add a clip or a pattern track', () => {
    const onAddClipTrack = vi.fn()
    const onAddPatternTrack = vi.fn()
    render({ onAddClipTrack, onAddPatternTrack })
    const clip = byText('Clip track')
    const pattern = byText('Pattern track')
    expect(clip).toBeTruthy()
    expect(pattern).toBeTruthy()
    expect(clip.style.height).toBe('36px')
    expect(byText('Add track')).toBeUndefined()
    act(() => { clip.click() })
    act(() => { pattern.click() })
    expect(onAddClipTrack).toHaveBeenCalledTimes(1)
    expect(onAddPatternTrack).toHaveBeenCalledTimes(1)
  })

  it('with tracks, the ghost rows give way to the Add track footer', () => {
    render({ tracks: [{ id: 1, name: 'One', type: 'Clip' }] })
    expect(byText('Clip track')).toBeUndefined()
    expect(byText('Add track')).toBeTruthy()
  })
})
