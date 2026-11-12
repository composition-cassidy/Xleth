// @vitest-environment jsdom
//
// An automation lane can be deleted from its header: a trash button and the
// right-click menu both call onDeleteAutomationLane with the lane id.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import TrackHeaderList from './TrackHeaderList.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container, root
const onDelete = vi.fn()

function render(extra = {}) {
  act(() => {
    root.render(
      <TrackHeaderList
        tracks={[]}
        folderLayout={null}
        onAddTrack={vi.fn()}
        trackHeight={36}
        automationGroupRows={[{ ownerTrackId: -1, label: 'Master', collapsed: false, height: 24, laneCount: 1 }]}
        automationLaneRows={[{ ownerTrackId: -1, id: 'automationLane:-1:7', laneId: 7, index: 0, height: 40, label: 'Drive' }]}
        onDeleteAutomationLane={onDelete}
        {...extra}
      />,
    )
  })
}

describe('TrackHeaderList — automation lane delete', () => {
  beforeEach(() => {
    onDelete.mockClear()
    container = document.createElement('div'); document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('the trash button deletes that lane', () => {
    render()
    const btn = container.querySelector('button[aria-label="Delete automation lane"]')
    expect(btn).not.toBeNull()
    act(() => btn.click())
    expect(onDelete).toHaveBeenCalledWith(7)
  })

  it('right-clicking the lane offers Delete automation lane', () => {
    render()
    const lane = container.querySelector('.track-header-automation-lane')
    act(() => {
      lane.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
    })
    const item = Array.from(document.querySelectorAll('button, [role="menuitem"]'))
      .find((e) => e.textContent.trim() === 'Delete automation lane')
    expect(item).toBeTruthy()
    act(() => item.click())
    expect(onDelete).toHaveBeenCalledWith(7)
  })

  it('shows no delete affordance when no handler is passed', () => {
    render({ onDeleteAutomationLane: undefined })
    expect(container.querySelector('button[aria-label="Delete automation lane"]')).toBeNull()
  })
})
