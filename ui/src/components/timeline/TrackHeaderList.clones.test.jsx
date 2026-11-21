// @vitest-environment jsdom
//
// Clone headers (docs/XLETH_CLONE_SPEC.md): indented under the source, a kind tag,
// the source's colour (Voice) or the tint (Trail) on a non-interactive chip, no
// output pearl and no Visual only (no audio), a Hide video control that is the
// Clone's mute, no drag of their own, and the row height of their lane.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import TrackHeaderList from './TrackHeaderList.jsx'
import { buildTrackLayout } from './timelineRowLayout.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container, root

const tracks = [
  { id: 1, name: 'Lead', type: 'Pattern', order: 0, cloneOf: -1, muted: false, solo: false, visualOnly: false, color: { mode: 'custom', customColor: '#3366CC' } },
  { id: 2, name: 'Lead · Clone 1', type: 'Pattern', order: 1, cloneOf: 1, muted: false, solo: false, visualOnly: true, clone: { kind: 'Voice', voice: 1 } },
  { id: 3, name: 'Lead · Trail 1', type: 'Pattern', order: 2, cloneOf: 1, muted: true, solo: false, visualOnly: true, clone: { kind: 'Trail', delayTicks: 480, tint: '#f07a2a' } },
  { id: 4, name: 'Bass', type: 'Clip', order: 3, cloneOf: -1, muted: false, solo: false, visualOnly: false },
]

function render(props = {}) {
  const layout = buildTrackLayout({ tracks, trackHeight: 36, reelLanes: { 1: { subRows: 1 }, 2: { subRows: 3 }, 3: { subRows: 1 } } })
  act(() => {
    root.render(
      <TrackHeaderList
        tracks={tracks}
        folderLayout={null}
        onAddTrack={vi.fn()}
        onMute={vi.fn()} onSolo={vi.fn()} onVisualOnly={vi.fn()}
        onRename={vi.fn()}
        trackHeight={36}
        reelRows={layout.reelRows}
        cloneRows={layout.cloneRows}
        {...props}
      />,
    )
  })
  return layout
}

const header = (name) => Array.from(container.querySelectorAll('.track-header'))
  .find((h) => h.querySelector('.track-header-name')?.textContent === name)

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

describe('Clone headers', () => {
  it('mark the row as a Clone (indented by CSS) and say its kind', () => {
    render()
    expect(header('Lead · Clone 1').getAttribute('data-clone')).toBe('voice')
    expect(header('Lead · Trail 1').getAttribute('data-clone')).toBe('trail')
    expect(header('Lead').hasAttribute('data-clone')).toBe(false)
    expect(header('Lead · Clone 1').querySelector('[data-testid="track-clone-tag"]').textContent).toBe('Voice clone')
    expect(header('Lead · Trail 1').querySelector('[data-testid="track-clone-tag"]').textContent).toBe('Trail clone')
    expect(header('Lead').querySelector('[data-testid="track-clone-tag"]')).toBeNull()
  })

  it('have no output pearl and no Visual only, but a Hide video toggle that is the Clone\'s mute', () => {
    const onMute = vi.fn()
    render({ onMute })
    const clone = header('Lead · Clone 1')
    expect(clone.querySelector('button[aria-label="Lead · Clone 1 output"]')).toBeNull()
    expect(clone.querySelector('button[aria-label="Visual only Lead · Clone 1"]')).toBeNull()
    const hide = clone.querySelector('button[aria-label="Hide video Lead · Clone 1"]')
    expect(hide.getAttribute('aria-pressed')).toBe('false')
    expect(hide.getAttribute('data-hint-mods')).toMatch(/only hides the picture/)
    act(() => hide.click())
    expect(onMute).toHaveBeenCalledWith(2)
    // The hidden Trail shows the toggle pressed and dims its identity like a muted track.
    const trail = header('Lead · Trail 1')
    expect(trail.querySelector('button[aria-label="Hide video Lead · Trail 1"]').getAttribute('aria-pressed')).toBe('true')
    expect(trail.getAttribute('data-muted')).toBe('true')
    // The source keeps its pearl.
    expect(header('Lead').querySelector('button[aria-label="Lead output"]')).not.toBeNull()
  })

  it('a Voice clone takes the source colour, a Trail clone its tint; the chip is not a colour picker', () => {
    render()
    const src = header('Lead').style.getPropertyValue('--track-header-fill')
    expect(header('Lead · Clone 1').style.getPropertyValue('--track-header-fill')).toBe(src)
    expect(header('Lead · Trail 1').style.getPropertyValue('--track-header-fill')).toBe('#F07A2A')
    expect(header('Lead · Clone 1').querySelector('button.track-header-color-btn')).toBeNull()
    expect(header('Lead · Clone 1').querySelector('.track-header-clone-chip [data-icon="copy"]')).not.toBeNull()
    expect(header('Lead · Trail 1').querySelector('.track-header-clone-chip [data-icon="stack"]')).not.toBeNull()
  })

  it('are not draggable on their own; the source is', () => {
    render()
    expect(header('Lead · Clone 1').getAttribute('draggable')).toBe('false')
    expect(header('Lead').getAttribute('draggable')).toBe('true')
  })

  it('take their lane row height, so the header column stays in lockstep with the canvas rows', () => {
    const layout = render()
    const [c1, c2] = layout.cloneRows
    expect(header('Lead · Clone 1').style.height).toBe(`${c1.height}px`)
    expect(header('Lead · Trail 1').style.height).toBe(`${c2.height}px`)
    expect(c1.height).toBeGreaterThan(36)
  })

  it('soloing logic ignores Clones: the source is lit when it is heard, whatever its Clones are', () => {
    render()
    expect(header('Lead').querySelector('button[aria-label="Lead output"]').getAttribute('data-lit')).toBe('true')
  })

  it('the source\'s Reel header says it shows voice 0 and that its Clones collapse with it', () => {
    render()
    const reel = container.querySelector('.track-header-reel-lane')
    expect(reel.textContent).toContain('Voice 0')
    expect(reel.querySelector('button').getAttribute('data-hint-mods')).toMatch(/clones' lanes collapse/)
  })

  it('a Clone has no rename on double-click (the engine names it)', () => {
    const onRename = vi.fn()
    render({ onRename })
    const name = header('Lead · Clone 1').querySelector('.track-header-name')
    act(() => { name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(header('Lead · Clone 1').querySelector('input')).toBeNull()
  })
})
