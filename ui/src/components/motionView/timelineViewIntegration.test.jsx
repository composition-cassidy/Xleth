// @vitest-environment jsdom
//
// TimelineView integration of Motion view (docs/XLETH_MOTION_VIEW_DESIGN.md 5.2):
// Motion view replaces the header column and the canvas scroller; the toolbar,
// ruler, loop bar, cue lane and horizontal scrollbar stay; the switch (toolbar or
// reveal event) round-trips without a console error.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import TimelineView from '../TimelineView.jsx'
import { ToastProvider } from '../Toast.jsx'
import { useMotionViewStore } from '../../motion/motionViewStore.js'
import { requestMotionReveal } from '../timeline/motionReveal.js'
import { registerMotionKeyAction } from './motionKeyCommands.js'
import { runEditorCommand } from '../../windowing/managers/EditorCommandRegistry'
import { handleKeyEvent } from '../../windowing/managers/KeyboardManager'
import { createInitialPanelStates, usePanelRegistry } from '../../windowing/registry/PanelRegistry'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TRACK = { id: 5, name: 'Video', type: 'Clip', muted: false, solo: false }
const CLIP = { id: 50, trackId: 5, regionId: 1, positionTicks: 0, durationTicks: 960 }

// A bridge that answers every call with null (an engine with an empty project).
// `over` replaces some members ({ timeline: { getTracks: fn } }); the rest stay null.
function emptyApi(over = null) {
  const fn = async () => null
  return new Proxy(fn, {
    get: (t, k) => {
      if (k === 'then') return undefined
      if (over && Object.prototype.hasOwnProperty.call(over, k)) {
        const v = over[k]
        return typeof v === 'function' ? v : emptyApi(v)
      }
      return /^on[A-Z]/.test(String(k)) ? () => () => {} : emptyApi()
    },
    apply: async () => null,
  })
}

let container
let root
let errors
let origError

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 1 }) : () => {}),
    set: (t, k, v) => { t[k] = v; return true },
  })
  window.xleth = emptyApi()
  useMotionViewStore.getState().reset({ all: true })
  usePanelRegistry.setState({ panels: createInitialPanelStates() })
  errors = []
  origError = console.error
  console.error = (...a) => { errors.push(a.map(String).join(' ')) }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  console.error = origError
  delete window.xleth
})

const mount = () => act(async () => {
  root.render(<ToastProvider><TimelineView activeSampleId={null} /></ToastProvider>)
})

describe('TimelineView with Motion view', () => {
  it('swaps the header column and the canvas; the shared timeline parts stay', async () => {
    await mount()
    expect(container.querySelector('.timeline-header-column')).toBeTruthy()
    expect(container.querySelector('.timeline-canvas-scroll')).toBeTruthy()
    expect(container.querySelector('[data-testid="motion-view"]')).toBeNull()
    const ruler = container.querySelector('.timeline-canvas-area')
    expect(ruler).toBeTruthy()

    await act(async () => { useMotionViewStore.getState().setView('motion') })
    expect(container.querySelector('[data-testid="motion-view"]')).toBeTruthy()
    expect(container.querySelector('.timeline-header-column')).toBeNull()
    expect(container.querySelector('.timeline-canvas-scroll')).toBeNull()
    expect(container.querySelectorAll('[data-testid="motion-key-host"] canvas')).toHaveLength(3)
    // The same canvas area (ruler, loop bar, cue lane, scrollbar) is still mounted.
    expect(container.querySelector('.timeline-canvas-area')).toBe(ruler)
    const group = container.querySelector('[data-testid="timeline-view-switch"]')
    expect(group.querySelector('[aria-checked="true"]').textContent).toBe('Motion')
    expect(container.querySelector('[data-testid="timeline-graph-toggle"]').disabled).toBe(false)

    // Back through the toolbar.
    await act(async () => { group.querySelector('button[role="radio"]').click() })
    expect(useMotionViewStore.getState().view).toBe('edit')
    expect(container.querySelector('.timeline-header-column')).toBeTruthy()
    expect(container.querySelector('[data-testid="timeline-graph-toggle"]').disabled).toBe(true)
    expect(errors).toEqual([])
  })

  it('the reveal event switches to Motion view', async () => {
    await mount()
    await act(async () => { requestMotionReveal(5, ['roam']) })
    expect(useMotionViewStore.getState().view).toBe('motion')
    expect(container.querySelector('[data-testid="motion-view"]')).toBeTruthy()
    expect(errors).toEqual([])
  })

  it('a finished reveal does not run again when Motion view remounts (5.2, R19)', async () => {
    window.xleth = emptyApi({ timeline: { getTracks: async () => [TRACK] } })
    await mount()
    await act(async () => { requestMotionReveal(5, ['roam']) })
    expect([...useMotionViewStore.getState().selectedRows]).toEqual(['t:5/roam'])
    // The user moves on in Motion view, goes to the Edit view and comes back.
    await act(async () => { useMotionViewStore.getState().selectRow('t:5', 'replace') })
    await act(async () => { useMotionViewStore.getState().setView('edit') })
    await act(async () => { useMotionViewStore.getState().setView('motion') })
    expect([...useMotionViewStore.getState().selectedRows]).toEqual(['t:5'])
    // A new reveal still works.
    await act(async () => { requestMotionReveal(5, ['roam']) })
    expect([...useMotionViewStore.getState().selectedRows]).toEqual(['t:5/roam'])
    expect(errors).toEqual([])
  })

  it('undo / redo refetch the patterns (note Lens overrides are undoable)', async () => {
    const getAllPatterns = vi.fn(async () => [])
    window.xleth = emptyApi({ timeline: { getAllPatterns }, undo: { undo: async () => true, redo: async () => true } })
    await mount()
    const before = getAllPatterns.mock.calls.length
    await act(async () => { await runEditorCommand('undo', 'timeline') })
    expect(getAllPatterns.mock.calls.length).toBeGreaterThan(before)
    const mid = getAllPatterns.mock.calls.length
    await act(async () => { await runEditorCommand('redo', 'timeline') })
    expect(getAllPatterns.mock.calls.length).toBeGreaterThan(mid)
  })

  it('Edit > Delete in Motion view never deletes the hidden Edit selection', async () => {
    const removeClipsBatch = vi.fn(async () => ({ removedIds: [CLIP.id] }))
    window.xleth = emptyApi({ timeline: { getTracks: async () => [TRACK], getClips: async () => [CLIP], removeClipsBatch } })
    await mount()
    usePanelRegistry.getState().focusPanel('timeline')
    await act(async () => { handleKeyEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, cancelable: true })) })
    await act(async () => { useMotionViewStore.getState().setView('motion') })
    // Nothing selected in Motion view: the command is not claimed and nothing goes.
    let claimed
    await act(async () => { claimed = await runEditorCommand('deleteSelected', 'timeline') })
    expect(claimed).toBe(false)
    expect(removeClipsBatch).not.toHaveBeenCalled()
    // The Motion view key delete gets it.
    const del = vi.fn(() => true)
    const off = registerMotionKeyAction('delete', del)
    try {
      await act(async () => { claimed = await runEditorCommand('deleteSelected', 'timeline') })
    } finally { off() }
    expect(claimed).toBe(true)
    expect(del).toHaveBeenCalledTimes(1)
    expect(removeClipsBatch).not.toHaveBeenCalled()
    // Back in the Edit view the same command deletes the Edit selection, as before.
    await act(async () => { useMotionViewStore.getState().setView('edit') })
    await act(async () => { await runEditorCommand('deleteSelected', 'timeline') })
    expect(removeClipsBatch).toHaveBeenCalledWith([CLIP.id])
  })

  it('the Motion header column takes its own width from the store', async () => {
    await mount()     // (the project's saved state loads on mount: an empty engine = defaults)
    await act(async () => {
      useMotionViewStore.getState().setHeaderWidth(420)
      useMotionViewStore.getState().setView('motion')
    })
    expect(container.querySelector('[data-testid="motion-view"]').style.width).toBe('420px')
    expect(container.querySelector('.timeline-header-column')).toBeNull()
  })
})
