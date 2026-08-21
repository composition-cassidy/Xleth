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
    usePanelRegistry.setState({ panels: createInitialPanelStates() })
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
})
