// @vitest-environment jsdom
//
// Motion view, Edit-view side (docs/XLETH_MOTION_VIEW_DESIGN.md R17, R18):
//   * the header column has no Roam / Sweep lane headers and the Reel header has no Sweep
//     toggle, whatever old props a caller still passes;
//   * the header DOM stays in lockstep with the canvas row model (same rows, same heights,
//     same order), so hit-testing under a header row is the row beside it;
//   * a track with motion shows the motion marker; clicking it asks for the Motion view
//     reveal ('xleth-motion-reveal' {trackId, path: []}) and nothing else.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import TrackHeaderList from './TrackHeaderList.jsx'
import { buildTrackLayout } from './timelineRowLayout.js'
import { MOTION_REVEAL_EVENT } from './motionReveal.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container, root

const tracks = [
  { id: 1, name: 'KICK', type: 'Clip', muted: false, solo: false, visualOnly: false },
  { id: 2, name: 'pitch', type: 'Pattern', muted: true, solo: false, visualOnly: false, videoHoldLastFrame: true },
  { id: 3, name: 'bass', type: 'Clip', muted: false, solo: false, visualOnly: false },
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
const marker = (name) => header(name)?.querySelector('[data-testid="track-motion-marker"]') ?? null

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

describe('motion marker (R18)', () => {
  it('is absent without motionTrackIds, and when the set is empty', () => {
    render()
    expect(container.querySelector('[data-testid="track-motion-marker"]')).toBeNull()
    render({ motionTrackIds: new Set() })
    expect(container.querySelector('[data-testid="track-motion-marker"]')).toBeNull()
    render({ motionTrackIds: [] })
    expect(container.querySelector('[data-testid="track-motion-marker"]')).toBeNull()
  })

  it('shows on exactly the tracks in motionTrackIds (a Set or an array, numeric or string ids)', () => {
    render({ motionTrackIds: new Set([2]) })
    expect(marker('pitch')).not.toBeNull()
    expect(marker('KICK')).toBeNull()
    expect(marker('bass')).toBeNull()
    render({ motionTrackIds: [1, '3'] })
    expect(marker('KICK')).not.toBeNull()
    expect(marker('pitch')).toBeNull()
    expect(marker('bass')).not.toBeNull()
    expect(container.querySelectorAll('[data-testid="track-motion-marker"]')).toHaveLength(2)
  })

  it('anything that is not a list of ids shows no marker', () => {
    for (const motionTrackIds of [null, undefined, 7, '12', {}, true]) {
      render({ motionTrackIds })
      expect(container.querySelector('[data-testid="track-motion-marker"]')).toBeNull()
    }
  })

  it('sits in its own cell after the name and badges, is a real button and says what it is', () => {
    render({ motionTrackIds: new Set([2]) })
    const m = marker('pitch')
    expect(m.tagName).toBe('BUTTON')
    expect(m.getAttribute('type')).toBe('button')
    // Its own grid cell (not inside the name cell the hover menu covers).
    expect(m.closest('.track-header-name-wrap')).toBeNull()
    expect(m.parentElement).toBe(header('pitch'))
    expect(header('pitch').getAttribute('data-motion')).toBe('true')
    expect(header('KICK').getAttribute('data-motion')).toBe('false')
    // after the H badge
    const hold = header('pitch').querySelector('[aria-label="Hold last frame"]')
    expect(hold.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(m.getAttribute('data-hint')).toBe('This track has motion (keys, Parent or Masks). See it in Motion view (`).')
    expect(m.getAttribute('aria-label')).toBe('pitch has motion. Show it in Motion view')
    // The glyph is decoration: an outline diamond (stroke, no fill), hidden from assistive tech.
    const svg = m.querySelector('svg')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.querySelector('path').getAttribute('d')).toBe('M8 3 13 8 8 13 3 8Z')
  })

  it('a click asks for the Motion view reveal of that track, and does not select or focus the row', () => {
    const onSelectTrack = vi.fn()
    const onFocusTrack = vi.fn()
    const onOpenInMixer = vi.fn()
    const seen = []
    const onReveal = (e) => seen.push(e.detail)
    window.addEventListener(MOTION_REVEAL_EVENT, onReveal)
    try {
      render({ motionTrackIds: new Set([2]), onSelectTrack, onFocusTrack, onOpenInMixer })
      const m = marker('pitch')
      act(() => {
        m.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
        m.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
      })
      expect(seen).toEqual([{ trackId: 2, path: [] }])
      expect(onSelectTrack).not.toHaveBeenCalled()
      expect(onFocusTrack).not.toHaveBeenCalled()
      // A double-click on it does not jump to the mixer either (buttons own their clicks).
      act(() => { m.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
      expect(onOpenInMixer).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(MOTION_REVEAL_EVENT, onReveal)
    }
  })

  it('a muted track keeps its marker undimmed (only the stripe and chip dim)', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const css = readFileSync(path.resolve(process.cwd(), 'src/components/timeline/TrackHeader.module.css'), 'utf8')
    expect(css).toMatch(/\.row\[data-muted="true"\] :is\(\.stripe, \.chipFace\)/)
    expect(css).not.toMatch(/data-muted[^{]*\.motion/)
  })
})

describe('motion marker styles (tokens, 24px hit area, outline in the value accent)', () => {
  it('lives in the kit layer, uses tokens only and no animation', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const css = readFileSync(path.resolve(process.cwd(), 'src/components/timeline/TrackHeader.module.css'), 'utf8')
    expect(css.trimStart().replace(/^\/\*[\s\S]*?\*\/\s*/, '')).toMatch(/^@layer kit \{/)
    const rule = (sel) => {
      const m = css.match(new RegExp(`\\n\\s*${sel.replace(/[.:]/g, (c) => `\\${c}`)} \\{([^}]*)\\}`))
      return m ? m[1] : null
    }
    const motion = rule('.motion')
    expect(motion).toMatch(/width: var\(--hit-min\);/)
    expect(motion).toMatch(/height: var\(--hit-min\);/)
    expect(motion).toMatch(/color: var\(--ui-value\);/)
    expect(motion).not.toMatch(/transition|animation/)
    const glyph = rule('.motionGlyph')
    expect(glyph).toMatch(/fill: none;/)
    expect(glyph).toMatch(/stroke: currentColor;/)
    expect(rule('.motion:focus-visible')).toMatch(/outline: 1px solid var\(--ui-select\);/)
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).not.toMatch(/\brgba?\(/)
  })

  it('the hover menu never covers the marker: the marker has its own grid area in both layouts', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const css = readFileSync(path.resolve(process.cwd(), 'src/components/timeline/TrackHeader.module.css'), 'utf8')
    const rule = (sel) => {
      const m = css.match(new RegExp(`\\n\\s*${sel.replace(/[.:[\]"=]/g, (c) => `\\${c}`)} \\{([^}]*)\\}`))
      return m ? m[1] : null
    }
    expect(rule('.motion')).toMatch(/grid-area: motion;/)
    // The menu stays over the end of the NAME cell.
    expect(rule('.row > .menu')).toMatch(/grid-area: name;/)
    // Normal row: chip | name (shrinks to 0, ellipsizes) | marker | Pearl cluster.
    const normal = rule('.row[data-motion="true"]')
    expect(normal).toMatch(/grid-template-columns: var\(--hit-min\) minmax\(0, 1fr\) auto auto;/)
    expect(normal).toMatch(/grid-template-areas: "chip name motion state";/)
    // Stacked (trackHeight >= 56): the marker beside the name, the cluster on its own row.
    const stacked = rule('.row[data-stack="true"][data-motion="true"]')
    expect(stacked).toMatch(/grid-template-columns: var\(--hit-min\) minmax\(0, 1fr\) auto;/)
    expect(stacked).toMatch(/"chip name motion"\s*"state state state";/)
  })

  it('the marker never shares the name cell, in both header layouts', () => {
    for (const trackHeight of [36, 60]) {
      render({ motionTrackIds: new Set([1]), trackHeight })
      const h = header('KICK')
      expect(h.getAttribute('data-stack')).toBe(trackHeight >= 56 ? 'true' : 'false')
      const m = marker('KICK')
      const menu = h.querySelector('[aria-label="Track menu"]')
      expect(m.closest('.track-header-name-wrap')).toBeNull()
      expect(menu.contains(m)).toBe(false)
      // Header height is unchanged by the marker.
      expect(parseFloat(h.style.height)).toBe(trackHeight)
    }
  })
})

describe('R17: no Roam or Sweep lane headers in the Edit view', () => {
  const reelRow = { id: 'reel:2', rowType: 'reel', parentTrackId: 2, height: 40, collapsed: false, subRows: 1 }
  // What an old TimelineView passed for an open Roam / Sweep lane: ignored now.
  const oldRoam = [{ id: 'roam:2', rowType: 'roam', parentTrackId: 2, height: 60 }]
  const oldSweep = [{ id: 'sweep:2', rowType: 'sweep', parentTrackId: 2, height: 60 }]

  it('the Reel header has no Sweep toggle; the Reel disclosure still works', () => {
    const onToggleReelLane = vi.fn()
    render({ reelRows: [reelRow], onToggleReelLane })
    const reel = container.querySelector('.track-header-reel-lane')
    expect(reel).not.toBeNull()
    expect(reel.querySelector('[aria-label^="Sweep lane"]')).toBeNull()
    expect([...reel.querySelectorAll('button')].map((b) => b.textContent.trim())).toEqual([''])
    expect(reel.textContent).toContain('Timing comes from notes')
    act(() => { reel.querySelector('button[aria-expanded]').click() })
    expect(onToggleReelLane).toHaveBeenCalledWith(2)
  })

  it('old roamRows / sweepRows props draw nothing', () => {
    render({ reelRows: [reelRow], roamRows: oldRoam, sweepRows: oldSweep })
    expect(container.querySelector('.track-header-roam-lane')).toBeNull()
    expect(container.querySelector('.track-header-sweep-lane')).toBeNull()
    expect(container.querySelector('[aria-label^="Roam key lane"]')).toBeNull()
    expect(container.querySelector('[aria-label^="Sweep lane"]')).toBeNull()
    expect(container.querySelector('[aria-label="Auto-key"]')).toBeNull()
  })
})

describe('header DOM and canvas row model stay in lockstep', () => {
  // The heights of the header column's rows in DOM order, from their inline style.
  const ROW_SELECTOR = [
    '.track-folder-header', '.track-header', '.track-header-reel-lane',
    '.track-header-automation-group-header', '.track-header-automation-lane', '.track-header-macro-lane',
  ].join(', ')
  const domHeights = () => [...container.querySelectorAll(ROW_SELECTOR)].map((el) => parseFloat(el.style.height))

  it('every row the layout builds has one header of the same height, in the same order (old lane inputs ignored)', () => {
    const graphStates = {
      1: { nodes: [{ id: 'm1', label: 'Macro 1' }], macroAutomationLanes: [{ laneId: 'l1', macroNodeId: 'm1' }] },
    }
    const automationGroups = {
      '-1': { lanes: [{ id: 9, index: 0, label: 'Master drive' }] },
      2: { lanes: [{ id: 5, index: 0, label: 'Drive' }, { id: 6, index: 1, label: 'Tone' }] },
    }
    const folderLayout = {
      rootOrder: [{ kind: 'folder', id: 'f1' }, { kind: 'track', id: 3 }],
      folders: [{ id: 'f1', name: 'Drums', collapsed: false, trackIds: [1, 2] }],
    }
    for (const trackHeight of [36, 60]) {
      const layout = buildTrackLayout({
        tracks, graphStates, automationGroups, folderLayout, trackHeight,
        reelLanes: { 2: { subRows: 2 } },
        roamLanes: { 1: true, 2: true, 3: true }, sweepLanes: { 2: true },
      })
      render({
        trackHeight, folderLayout,
        macroRows: layout.macroRows, reelRows: layout.reelRows,
        automationGroupRows: layout.automationGroupRows, automationLaneRows: layout.automationLaneRows,
        // An old TimelineView passed these from the layout; the layout no longer has them.
        roamRows: layout.roamRows, sweepRows: layout.sweepRows,
        motionTrackIds: new Set([1, 2, 3]),
      })
      expect(layout.rows.map((r) => r.rowType)).toEqual([
        'automationGroupHeader', 'automationLane',
        'folder', 'track', 'macroAutomation', 'track', 'reel', 'automationGroupHeader', 'automationLane', 'automationLane',
        'track',
      ])
      expect(domHeights()).toEqual(layout.rows.map((r) => r.height))
      // The marker lives inside the track row: it adds no row and no height.
      expect(container.querySelectorAll('[data-testid="track-motion-marker"]')).toHaveLength(3)
    }
  })
})
