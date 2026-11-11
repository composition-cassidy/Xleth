// @vitest-environment jsdom
//
// Round 2 step 19.1: the header is a neutral row. Identity is the stripe and the
// chip; the name, the menu and M / S / V are never dimmed; folders disclose with
// aria-expanded and show their child count.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import TrackHeaderList from './TrackHeaderList.jsx'
import { contrastRatio } from '../../ui-kit/colorMath'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container, root

const tracks = [
  { id: 1, name: 'KICK', type: 'Clip', muted: false, solo: false, visualOnly: false },
  { id: 2, name: 'pitch', type: 'Pattern', muted: true, solo: true, visualOnly: false, videoHoldLastFrame: true },
  { id: 3, name: 'bass', type: 'Clip', muted: false, solo: false, visualOnly: true },
]

function render(props = {}) {
  act(() => {
    root.render(
      <TrackHeaderList
        tracks={tracks}
        folderLayout={null}
        onAddTrack={vi.fn()}
        onMute={vi.fn()} onSolo={vi.fn()} onVisualOnly={vi.fn()}
        onRename={vi.fn()}
        trackHeight={36}
        {...props}
      />,
    )
  })
}

const header = (name) => Array.from(container.querySelectorAll('.track-header')).find((h) => h.textContent.includes(name))

describe('track header', () => {
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('has M, S and V as pressed-state toggles at rest, per track', () => {
    render()
    const pitch = header('pitch')
    const mute = pitch.querySelector('button[aria-label="Mute pitch"]')
    const solo = pitch.querySelector('button[aria-label="Solo pitch"]')
    const visual = pitch.querySelector('button[aria-label="Visual only pitch"]')
    expect(mute.getAttribute('aria-pressed')).toBe('true')
    expect(solo.getAttribute('aria-pressed')).toBe('true')
    expect(visual.getAttribute('aria-pressed')).toBe('false')
    expect(header('bass').querySelector('button[aria-label="Visual only bass"]').getAttribute('aria-pressed')).toBe('true')
  })

  it('marks a muted track on the row, and leaves the name unstyled by it', () => {
    render()
    const pitch = header('pitch')
    expect(pitch.getAttribute('data-muted')).toBe('true')
    expect(header('KICK').getAttribute('data-muted')).toBe('false')
    // Only the stripe and the chip carry the identity; there is no inline colour or opacity on the name.
    const name = pitch.querySelector('.track-header-name')
    expect(name.getAttribute('style')).toBeNull()
    expect(pitch.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0)
  })

  it('keeps a hold badge named, a pattern track distinguishable, and the colour button at 24px by class', () => {
    render()
    const pitch = header('pitch')
    expect(pitch.getAttribute('data-kind')).toBe('pattern')
    expect(header('KICK').getAttribute('data-kind')).toBe('clip')
    expect(pitch.querySelector('[aria-label="Hold last frame"]')).toBeTruthy()
    expect(pitch.querySelector('button[aria-label="Change track color"]')).toBeTruthy()
    expect(pitch.querySelector('button[aria-label="Track menu"]')).toBeTruthy()
  })

  it('stacks the controls under the name from a 56px lane', () => {
    render({ trackHeight: 90 })
    expect(header('KICK').getAttribute('data-stack')).toBe('true')
    render({ trackHeight: 36 })
    expect(header('KICK').getAttribute('data-stack')).toBe('false')
  })

  it('has no delete-track button of its own: Delete Track is in the track menu', () => {
    render()
    expect(container.querySelector('.track-delete-btn')).toBeNull()
  })

  // Round 3: the name has the row. The track menu is still a real button (reachable by Tab,
  // revealed on hover and focus) but it holds no column of its own; right-click opens the same menu.
  it('gives the name the row: the track menu has no column, and the default column leaves the name 120px or more', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const css = readFileSync(path.resolve(process.cwd(), 'src/components/timeline/TrackHeader.module.css'), 'utf8')
    expect(css).toMatch(/grid-template-areas:\s*"chip name state"/)
    expect(css).not.toMatch(/"chip name menu/)
    // The menu sits in the name's cell and is undrawn at rest.
    expect(css).toMatch(/\.row > \.menu \{[^}]*grid-area: name;[^}]*opacity: 0;[^}]*pointer-events: none;/)
    expect(css).toMatch(/\.row:hover > \.menu,\s*\.row:focus-within > \.menu \{[^}]*opacity: 1;/)

    const { HEADER_WIDTH } = await import('../../constants/timeline.js')
    // Column - 1px border - 8px left padding (stripe) - 24 chip - 2 gap - 2 gap - three 24px
    // toggles sharing two borders (70) - 2px right padding.
    const nameCell = HEADER_WIDTH - 1 - 8 - 24 - 2 - 2 - 70 - 2
    expect(nameCell).toBeGreaterThanOrEqual(120)

    render()
    const row = header('KICK')
    const menu = row.querySelector('button[aria-label="Track menu"]')
    expect(menu.getAttribute('data-hint-mods')).toMatch(/Right-click/)
    // M / S / V stay in the row at rest.
    expect(row.querySelectorAll('[role="group"] button[aria-pressed]')).toHaveLength(3)
  })
})

describe('folder row', () => {
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const layout = (collapsed) => ({
    rootOrder: [{ kind: 'folder', id: 'f1' }, { kind: 'track', id: 3 }],
    folders: [{ id: 'f1', name: 'Drums', collapsed, trackIds: [1, 2] }],
  })

  it('discloses with aria-expanded and prints the child count', () => {
    const onToggleFolder = vi.fn()
    render({ folderLayout: layout(false), onToggleFolder })
    const toggle = container.querySelector('.track-folder-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('Collapse folder Drums')
    expect(container.querySelector('.track-folder-count').textContent).toBe('2')
    expect(container.querySelector('.track-folder-count').getAttribute('aria-label')).toBe('2 tracks')
    act(() => { toggle.click() })
    expect(onToggleFolder).toHaveBeenCalledWith('f1', true)
  })

  it('collapsed: expanded is false and its tracks are not drawn', () => {
    render({ folderLayout: layout(true) })
    expect(container.querySelector('.track-folder-toggle').getAttribute('aria-expanded')).toBe('false')
    expect(header('KICK')).toBeUndefined()
    expect(header('bass')).toBeTruthy()
  })
})

describe('the ramp the header sits on', () => {
  it('ink and ink-2 read at 4.5:1 or better on g2 and g3, so a muted track keeps a legible name', () => {
    for (const bg of ['#222222', '#2B2B2B']) {
      expect(contrastRatio('#E6E6E6', bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio('#B4B4B4', bg)).toBeGreaterThanOrEqual(4.5)
    }
  })
})
