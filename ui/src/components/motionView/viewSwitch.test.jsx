// @vitest-environment jsdom
//
// The Edit | Motion switch (docs/XLETH_MOTION_VIEW_DESIGN.md 5.2, R19, R20): the toolbar
// control and Graph toggle, the reveal event, per-view height / scroll / header width
// that survive a switch and a save / load, and the persistence session.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import TimelineToolbar, { VIEW_OPTIONS } from '../timeline/TimelineToolbar.jsx'
import { requestMotionReveal } from '../timeline/motionReveal.js'
import { acceptMotionReveal, useMotionRevealListener } from './useMotionReveal.js'
import { flushMotionViewState, motionViewSessionActive, startMotionViewSession } from './motionViewSession.js'
import { useMotionViewStore } from '../../motion/motionViewStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useMotionViewStore.getState().reset({ all: true })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete window.xleth
})

const renderToolbar = (props = {}) => act(() => {
  root.render(
    <TimelineToolbar
      activeTool="select" setActiveTool={vi.fn()}
      activeSampleId={null} regions={{}}
      snapGranularity="1/16" onSnapGranularityChange={vi.fn()}
      pixelsPerBeat={40}
      onAddTrack={vi.fn()} onAddFolder={vi.fn()}
      onOpenQuantize={vi.fn()} onOpenQuickNotation={vi.fn()}
      {...props}
    />,
  )
})

describe('toolbar: Edit | Motion and Graph', () => {
  it('a kit segmented control names the ` key; choosing Motion asks for the view', () => {
    const onViewChange = vi.fn()
    renderToolbar({ view: 'edit', onViewChange })
    const group = container.querySelector('[data-testid="timeline-view-switch"]')
    expect(group.getAttribute('role')).toBe('radiogroup')
    expect(group.getAttribute('data-hint-mods')).toContain('`')
    const [edit, motion] = group.querySelectorAll('button[role="radio"]')
    expect(edit.textContent).toBe('Edit')
    expect(edit.getAttribute('aria-checked')).toBe('true')
    expect(motion.getAttribute('data-hint')).toContain('`')
    act(() => { motion.click() })
    expect(onViewChange).toHaveBeenCalledWith('motion')
    expect(VIEW_OPTIONS.map((o) => o.value)).toEqual(['edit', 'motion'])
  })

  it('Graph is disabled outside Motion view and toggles in it (G)', () => {
    const onGraphChange = vi.fn()
    renderToolbar({ view: 'edit', graph: false, onGraphChange })
    let g = container.querySelector('[data-testid="timeline-graph-toggle"]')
    expect(g.disabled).toBe(true)
    expect(g.getAttribute('data-hint')).toMatch(/Motion view only/)
    renderToolbar({ view: 'motion', graph: false, onGraphChange })
    g = container.querySelector('[data-testid="timeline-graph-toggle"]')
    expect(g.disabled).toBe(false)
    expect(g.getAttribute('aria-pressed')).toBe('false')
    act(() => { g.click() })
    expect(onGraphChange).toHaveBeenCalledWith(true)
    renderToolbar({ view: 'motion', graph: true, onGraphChange })
    expect(container.querySelector('[data-testid="timeline-graph-toggle"]').getAttribute('aria-pressed')).toBe('true')
  })

  it('in Motion view the clip tools are disabled and say why', () => {
    renderToolbar({ view: 'motion' })
    const select = container.querySelector('button[aria-label="Select tool"]')
    expect(select.disabled).toBe(true)
    expect(select.getAttribute('data-hint-mods')).toMatch(/Edit view/)
  })
})

describe('switching views changes no data, selection, zoom or scroll', () => {
  it('each view keeps its own height, scroll and header width; the key selection stays', () => {
    const s = () => useMotionViewStore.getState()
    s().setEditTrackHeight(48)
    s().setEditScrollY(300)
    s().setMotionTrackRowHeight(40)
    s().setMotionScrollY(120)
    s().setHeaderWidth(420)
    s().selectKeys([['r:1:offsetX:0', { kind: 'roam', trackId: 1, channel: 'offsetX', pos: 0 }]])
    s().selectRow('t:1/roam/roam.offsetX')
    const ppbRef = { current: 55 }
    const scrollOffsetRef = { current: 12.5 }
    s().toggleView()
    expect(s().view).toBe('motion')
    s().setScrollY(200)                            // scrolling Motion view moves only its own scroll
    s().toggleView()
    expect(s().view).toBe('edit')
    expect(s().edit).toEqual({ trackHeight: 48, scrollY: 300 })
    expect(s().motion).toEqual({ trackRowHeight: 40, scrollY: 200, headerWidth: 420 })
    expect([...s().keySel.keys()]).toEqual(['r:1:offsetX:0'])
    expect([...s().selectedRows]).toEqual(['t:1/roam/roam.offsetX'])
    // The view switch never touches the shared horizontal zoom / scroll refs.
    expect(ppbRef.current).toBe(55)
    expect(scrollOffsetRef.current).toBe(12.5)
  })

  it('per-view state round-trips through the project (toState -> loadState)', () => {
    const s = () => useMotionViewStore.getState()
    s().setView('motion')
    s().setGraph(true)
    s().setEditTrackHeight(60)
    s().setEditScrollY(512)
    s().setMotionTrackRowHeight(32)
    s().setMotionScrollY(96)
    s().setHeaderWidth(400)
    s().setExpandedRows(['t:1', 't:1/roam'])
    const saved = JSON.parse(JSON.stringify(s().toState()))
    s().reset()
    expect(s().view).toBe('edit')
    s().loadState(saved)
    expect(s().view).toBe('motion')
    expect(s().graph).toBe(true)
    expect(s().edit).toEqual({ trackHeight: 60, scrollY: 512 })
    expect(s().motion).toEqual({ trackRowHeight: 32, scrollY: 96, headerWidth: 400 })
    expect([...s().expanded].sort()).toEqual(['t:1', 't:1/roam'])
  })
})

describe('reveal (xleth-motion-reveal)', () => {
  function Listener({ onReveal }) {
    useMotionRevealListener(onReveal)
    return null
  }

  it('switches to Motion view and hands { trackId, path } over', () => {
    const onReveal = vi.fn()
    act(() => { root.render(<Listener onReveal={onReveal} />) })
    expect(useMotionViewStore.getState().view).toBe('edit')
    act(() => { requestMotionReveal(7, ['roam']) })
    expect(useMotionViewStore.getState().view).toBe('motion')
    expect(onReveal).toHaveBeenCalledWith({ trackId: 7, path: ['roam'] })
    act(() => { requestMotionReveal(7, ['roam']) })
    // A second reveal of the same row is a new request (so it scrolls there again).
    expect(onReveal.mock.calls[1][0]).not.toBe(onReveal.mock.calls[0][0])
  })

  it('ignores a detail without a track id and cleans the path', () => {
    expect(acceptMotionReveal({ trackId: 'x' })).toBeNull()
    expect(useMotionViewStore.getState().view).toBe('edit')
    expect(acceptMotionReveal({ trackId: 3, path: ['sweep', '', 5] })).toEqual({ trackId: 3, path: ['sweep'] })
  })
})

describe('persistence session', () => {
  it('is ref-counted and flush pushes a pending change at once', async () => {
    const setMotionViewState = vi.fn(async () => true)
    window.xleth = { project: { getMotionViewState: vi.fn(async () => null), setMotionViewState }, onProjectLoaded: () => () => {} }
    const stopA = startMotionViewSession()
    const stopB = startMotionViewSession()
    expect(motionViewSessionActive()).toBe(true)
    await act(async () => { await Promise.resolve() })
    useMotionViewStore.getState().setHeaderWidth(500)
    await act(async () => { await flushMotionViewState() })
    expect(setMotionViewState).toHaveBeenCalledTimes(1)
    expect(setMotionViewState.mock.calls[0][0].motion.headerWidth).toBe(500)
    stopA()
    expect(motionViewSessionActive()).toBe(true)
    stopB()
    expect(motionViewSessionActive()).toBe(false)
    expect(await flushMotionViewState()).toBe(false)
  })
})
