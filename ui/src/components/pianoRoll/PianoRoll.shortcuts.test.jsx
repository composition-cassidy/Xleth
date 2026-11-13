/* @vitest-environment jsdom */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./PianoRollToolbar.jsx', () => ({ default: () => <div data-testid="toolbar" /> }))
vi.mock('./PianoRollKeyboard.jsx', () => ({
  PITCH_MIN: 0,
  PITCH_MAX: 127,
  default: React.forwardRef((props, ref) => <div data-testid="keyboard" />),
}))
// Real PianoRollCanvas/VelocityLane are forwardRef (PianoRoll's view animator
// calls .redraw() on them imperatively) — mock as forwardRef too, or React
// warns "Function components cannot be given refs" for the ref PianoRoll passes.
vi.mock('./PianoRollCanvas.jsx', () => ({
  default: React.forwardRef((props, ref) => <div data-testid="canvas" />),
}))
vi.mock('./VelocityLane.jsx', () => ({
  default: React.forwardRef((props, ref) => <div data-testid="velocity" />),
}))
vi.mock('./PianoRollScrollbarV.jsx', () => ({
  SCROLLBAR_V_WIDTH: 10,
  default: React.forwardRef((props, ref) => <div data-testid="scroll-v" />),
}))
vi.mock('./PianoRollScrollbarH.jsx', () => ({
  SCROLLBAR_H_HEIGHT: 10,
  default: React.forwardRef((props, ref) => <div data-testid="scroll-h" />),
}))
vi.mock('../Toast.jsx', () => ({ useToast: () => ({ showToast: vi.fn() }) }))

import PianoRoll, { resetPianoRollClipboardForTest } from './PianoRoll.jsx'
import {
  handleKeyEvent,
  resetBindingsForTest,
} from '../../windowing/managers/KeyboardManager'
import {
  createInitialPanelStates,
  usePanelRegistry,
} from '../../windowing/registry/PanelRegistry'
import usePianoRollStore from '../../stores/usePianoRollStore.js'
import XlethRootContext from '../../windowing/contexts/XlethRootContext.jsx'
import { init as initKeyboard, destroy as destroyKeyboard } from '../../windowing/managers/KeyboardManager'

function shortcut(key, modifiers = {}) {
  return new KeyboardEvent('keydown', {
    key,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    cancelable: true,
    ...modifiers,
  })
}

describe('Piano Roll keyboard ownership', () => {
  let container
  let root
  let timeline
  let clipboard
  let warnSpy

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    }

    resetBindingsForTest()
    resetPianoRollClipboardForTest()
    // The detail dock shows one panel at a time, so for both to be open the
    // mixer is popped out while the piano roll sits in the dock.
    const panels = createInitialPanelStates()
    panels.mixer = { ...panels.mixer, mode: 'floating' }
    usePanelRegistry.setState({ panels })
    usePanelRegistry.getState().openPanel('pianoRoll')
    usePanelRegistry.getState().openPanel('mixer')
    usePianoRollStore.setState({ activeCenterTab: 'timeline' })

    timeline = {
      getPattern: vi.fn(async () => ({
        id: 7,
        regionId: 3,
        lengthTicks: 960,
        notes: [{ id: 1, positionTicks: 120, durationTicks: 240, pitch: 60, velocity: 0.8 }],
      })),
      getRegions: vi.fn(async () => []),
      removeNote: vi.fn(async () => true),
      addNote: vi.fn(async () => 99),
      previewAllNotesOff: vi.fn(),
    }
    Object.defineProperty(window, 'xleth', {
      configurable: true,
      value: { timeline, undo: { undo: vi.fn(), redo: vi.fn() } },
    })

    clipboard = {
      writeText: vi.fn(async () => { throw new Error('clipboard denied') }),
      readText: vi.fn(async () => { throw new Error('clipboard denied') }),
    }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<PianoRoll patternId={7} />)
      await Promise.resolve()
    })
    expect(timeline.getPattern).toHaveBeenCalled()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    resetBindingsForTest()
    resetPianoRollClipboardForTest()
    warnSpy.mockRestore()
    delete window.xleth
    delete globalThis.ResizeObserver
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
  })

  it('routes Delete by focused panel even when activeCenterTab is stale', async () => {
    usePanelRegistry.getState().focusPanel('pianoRoll')
    await act(async () => { handleKeyEvent(shortcut('a', { ctrlKey: true })) })

    usePanelRegistry.getState().focusPanel('mixer')
    await act(async () => { handleKeyEvent(shortcut('Delete')) })
    expect(timeline.removeNote).not.toHaveBeenCalled()

    usePanelRegistry.getState().focusPanel('pianoRoll')
    await act(async () => {
      handleKeyEvent(shortcut('Delete'))
      await Promise.resolve()
    })
    expect(timeline.removeNote).toHaveBeenCalledWith(7, 1)
    expect(usePianoRollStore.getState().activeCenterTab).toBe('timeline')
  })

  describe('FL Studio keys', () => {
    const press = async (key, mods) => {
      await act(async () => {
        handleKeyEvent(shortcut(key, mods))
        await Promise.resolve()
        await Promise.resolve()
      })
    }
    const selectAll = () => press('a', { ctrlKey: true })

    it('Shift+Up is a semitone and Ctrl+Up an octave (was: Shift+Up = octave)', async () => {
      timeline.moveNote = vi.fn(async () => true)
      usePanelRegistry.getState().focusPanel('pianoRoll')
      await selectAll()
      await press('ArrowUp', { shiftKey: true })
      expect(timeline.moveNote).toHaveBeenLastCalledWith(7, 1, 120, 61)
      await press('ArrowUp', { ctrlKey: true })
      expect(timeline.moveNote).toHaveBeenLastCalledWith(7, 1, 120, 72)
    })

    it('lands a compound edit as ONE editPatternNotes call when the engine has it', async () => {
      timeline.editPatternNotes = vi.fn(async (_id, notes) => notes.map((n, i) => ({ ...n, id: n.id ?? 100 + i })))
      usePanelRegistry.getState().focusPanel('pianoRoll')
      await selectAll()
      await press('b', { ctrlKey: true })
      expect(timeline.editPatternNotes).toHaveBeenCalledTimes(1)
      const [, sent] = timeline.editPatternNotes.mock.calls[0]
      expect(sent).toEqual([
        { id: 1, positionTicks: 120, durationTicks: 240, pitch: 60, velocity: 0.8 },
        // Ctrl+B: the 120..360 note widens to the 1/16 grid (0..480), so its copy lands 480 later.
        { positionTicks: 600, durationTicks: 240, pitch: 60, velocity: 0.8 },
      ])
    })

    it('Ctrl+X copies then removes the selection', async () => {
      usePanelRegistry.getState().focusPanel('pianoRoll')
      await selectAll()
      await press('x', { ctrlKey: true })
      expect(clipboard.writeText).toHaveBeenCalledTimes(1)
      expect(timeline.removeNote).toHaveBeenCalledWith(7, 1)
    })

    it('claims Ctrl+M so it cannot reach window listeners (the mixer toggle)', async () => {
      const onOpenMidiImport = vi.fn()
      await act(async () => {
        root.render(
          <XlethRootContext.Provider value={{ onOpenMidiImport }}>
            <PianoRoll patternId={7} />
          </XlethRootContext.Provider>,
        )
        await Promise.resolve()
      })
      const windowListener = vi.fn()
      initKeyboard()
      window.addEventListener('keydown', windowListener)
      usePanelRegistry.getState().focusPanel('pianoRoll')
      const event = shortcut('m', { ctrlKey: true, bubbles: true })
      await act(async () => { document.body.dispatchEvent(event) })
      window.removeEventListener('keydown', windowListener)
      destroyKeyboard()
      expect(event.defaultPrevented).toBe(true)
      expect(onOpenMidiImport).toHaveBeenCalledTimes(1)
      expect(windowListener).not.toHaveBeenCalled()
    })
  })

  it('copies and pastes through the internal clipboard when browser access fails', async () => {
    usePanelRegistry.getState().focusPanel('pianoRoll')
    await act(async () => { handleKeyEvent(shortcut('a', { ctrlKey: true })) })
    await act(async () => {
      handleKeyEvent(shortcut('c', { ctrlKey: true }))
      await Promise.resolve()
    })
    expect(clipboard.writeText).toHaveBeenCalledTimes(1)

    await act(async () => {
      handleKeyEvent(shortcut('v', { ctrlKey: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(clipboard.readText).not.toHaveBeenCalled()
    expect(timeline.addNote).toHaveBeenCalledWith(7, {
      positionTicks: 0,
      durationTicks: 240,
      pitch: 60,
      velocity: 0.8,
    })
  })

  it('copy/paste carries a per-note Lens override to the pasted copy and keeps the original', async () => {
    const lensOverride = { mode: 'Nudge', keys: [{ channel: 'zoom', anchor: 'Head', pos: 0, value: 1.2 }] }
    timeline.getPattern.mockImplementation(async () => ({
      id: 7,
      regionId: 3,
      lengthTicks: 960,
      notes: [
        { id: 1, positionTicks: 120, durationTicks: 240, pitch: 60, velocity: 0.8, lensOverride },
        { id: 2, positionTicks: 480, durationTicks: 240, pitch: 62, velocity: 0.8 },
      ],
    }))
    timeline.editPatternNotes = vi.fn(async (_id, notes) => notes.map((n, i) => ({ ...n, id: n.id ?? 100 + i })))
    await act(async () => {
      root.render(<PianoRoll patternId={7} key="override" />)
      await Promise.resolve()
    })
    usePanelRegistry.getState().focusPanel('pianoRoll')
    await act(async () => { handleKeyEvent(shortcut('a', { ctrlKey: true })) })
    await act(async () => {
      handleKeyEvent(shortcut('c', { ctrlKey: true }))
      await Promise.resolve()
    })
    await act(async () => {
      handleKeyEvent(shortcut('v', { ctrlKey: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(timeline.editPatternNotes).toHaveBeenCalledTimes(1)
    const [, sent] = timeline.editPatternNotes.mock.calls[0]
    expect(sent).toHaveLength(4)
    expect(sent[0]).toMatchObject({ id: 1, lensOverride })
    expect(sent[1]).not.toHaveProperty('lensOverride')
    // Pasted copies have no id (the engine assigns new ones); only note 1's copy carries it.
    expect(sent[2]).not.toHaveProperty('id')
    expect(sent[2].lensOverride).toEqual(lensOverride)
    expect(sent[3]).not.toHaveProperty('lensOverride')
  })
})
