/* @vitest-environment jsdom */
// Zoom/pan/rot's own motion blur control: per track, written through the
// card's scalar path as one whole { enabled, shutterAngle } object, and shown
// only on the track variant (the slide variant blurs through the track's).
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ZprTimelineCard from './ZprTimelineCard.jsx'

function mount(ui) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  return { container, root }
}

describe('ZprTimelineCard motion blur', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    window.xleth = {}
    // jsdom has no 2D canvas: the card's keyframe canvas and viewport only
    // need calls that do nothing.
    const noop = () => {}
    const ctx = new Proxy({}, {
      get: (t, k) => (k in t ? t[k]
        : k === 'measureText' ? () => ({ width: 0 })
        : k === 'createLinearGradient' || k === 'createPattern' ? () => ({ addColorStop: noop })
        : k === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) })
        : noop),
      set: (t, k, v) => { t[k] = v; return true },
    })
    HTMLCanvasElement.prototype.getContext = () => ctx
  })
  afterEach(() => { document.body.innerHTML = '' })

  function findToggle(container) {
    return Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent.trim() === 'Motion blur')
  }

  it('turns the track ZPR blur on, carrying its shutter angle along', async () => {
    const onApplyScalar = vi.fn()
    const { container, root } = mount()
    await act(async () => {
      root.render(
        <ZprTimelineCard
          trackId={3}
          layout="device"
          zpr={{ enabled: true, motionBlur: { enabled: false, shutterAngle: 120 } }}
          onApplyScalar={onApplyScalar}
          onApplyTracks={() => {}}
        />,
      )
    })
    const toggle = findToggle(container)
    expect(toggle).toBeTruthy()
    expect(container.textContent).toContain('120°')
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onApplyScalar).toHaveBeenCalledWith({ motionBlur: { enabled: true, shutterAngle: 120 } })
    await act(async () => root.unmount())
  })

  it('defaults to off at 180 degrees for a track saved before motion blur', async () => {
    const { container, root } = mount()
    await act(async () => {
      root.render(
        <ZprTimelineCard trackId={3} layout="window" zpr={{ enabled: true }}
          onApplyScalar={() => {}} onApplyTracks={() => {}} />,
      )
    })
    expect(findToggle(container)).toBeTruthy()
    expect(container.textContent).toContain('180°')
    await act(async () => root.unmount())
  })

  it('has no blur control on the slide variant', async () => {
    const { container, root } = mount()
    await act(async () => {
      root.render(
        <ZprTimelineCard trackId={3} layout="device" variant="slide" zpr={{}}
          onApplyScalar={() => {}} onApplyTracks={() => {}} />,
      )
    })
    expect(findToggle(container)).toBeFalsy()
    await act(async () => root.unmount())
  })
})
