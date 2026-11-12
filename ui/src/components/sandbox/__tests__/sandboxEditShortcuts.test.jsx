/* @vitest-environment jsdom */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleKeyEvent, destroy, resetBindingsForTest } from '../../../windowing/managers/KeyboardManager'
import { createInitialPanelStates, usePanelRegistry } from '../../../windowing/registry/PanelRegistry'
import useSandboxStore from '../../../stores/sandboxStore.js'
import { useSandboxEditShortcuts } from '../useSandboxEditShortcuts.js'
import { useSandboxViewShortcuts } from '../useSandboxViewShortcuts.js'

// Same flag the other component tests in this repo set — see
// SandboxSeparationStrip.test.jsx.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The hook registers bindings from an effect, so it needs a real mount rather
// than a bare call. A component that renders nothing is the whole harness.
function ShortcutHost() {
  useSandboxEditShortcuts()
  useSandboxViewShortcuts()
  return null
}

function mountShortcuts() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => { root.render(<ShortcutHost />) })
  return root
}

// Delete / Ctrl+X / Ctrl+C / Ctrl+V / Ctrl+D in the Sample Sandbox.
//
// The point of these is the GATING, not that a store action can be called:
// which combos map to which action, that Delete is a real Cut (clipboard +
// remove) rather than a discard, and that a shortcut whose precondition is not
// met leaves the key alone for whoever else wants it.

function keyEvent(key, modifiers = {}) {
  const event = {
    key,
    type: 'keydown',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    defaultPrevented: false,
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...modifiers,
  }
  event.preventDefault = vi.fn(() => { event.defaultPrevented = true })
  return event
}

const ctrl = (key) => keyEvent(key, { ctrlKey: true })

function layer(overrides = {}) {
  return {
    id: 1,
    name: 'L1',
    ops: [],
    renderState: 'ready',
    renderedBuffer: { numChannels: 1, numSamples: 48000, sampleRate: 48000, channels: [] },
    ...overrides,
  }
}

// 4800 samples @ 48 kHz = 100 ms — comfortably past hasMeaningfulSelection's floor.
const SELECTION = { startSample: 4800, endSample: 9600 }

describe('Sample Sandbox edit shortcuts', () => {
  let actions

  beforeEach(() => {
    destroy()
    resetBindingsForTest()
    usePanelRegistry.setState({ panels: createInitialPanelStates() })

    actions = {
      cutSelection: vi.fn(),
      copySelection: vi.fn(),
      pasteClipboard: vi.fn(),
      duplicateLayer: vi.fn(),
    }
    useSandboxStore.setState({
      layers: [layer()], activeLayerId: 1, selection: SELECTION, clipboard: null, ...actions,
    })

    mountShortcuts()
    usePanelRegistry.getState().openPanel('sampleSandbox')
  })

  it('Delete and Ctrl+X both run a real, rippling CUT', () => {
    handleKeyEvent(keyEvent('Delete'))
    expect(actions.cutSelection).toHaveBeenCalledWith(1, 'ripple')

    handleKeyEvent(ctrl('x'))
    expect(actions.cutSelection).toHaveBeenCalledTimes(2)

    // Cut goes through the store action that copies to the clipboard FIRST —
    // Delete is not a discard. Nothing here reimplements that; the assertion is
    // that both combos land on that same action.
    expect(actions.cutSelection.mock.calls.every(([id, mode]) => id === 1 && mode === 'ripple')).toBe(true)
  })

  it('Backspace cuts too, and Caps Lock (Ctrl+X uppercase) still resolves', () => {
    handleKeyEvent(keyEvent('Backspace'))
    handleKeyEvent(ctrl('X'))
    expect(actions.cutSelection).toHaveBeenCalledTimes(2)
  })

  it('Ctrl+C copies without touching the stack', () => {
    handleKeyEvent(ctrl('c'))
    expect(actions.copySelection).toHaveBeenCalledWith(1)
    expect(actions.cutSelection).not.toHaveBeenCalled()
  })

  it('Ctrl+V inserts the clipboard at the selection start', () => {
    useSandboxStore.setState({ clipboard: { clipboardId: 3, numSamples: 100 } })
    handleKeyEvent(ctrl('v'))
    expect(actions.pasteClipboard).toHaveBeenCalledWith(1, SELECTION.startSample, true)
  })

  it('Ctrl+V with an empty clipboard does nothing and leaves the key alone', () => {
    const e = ctrl('v')
    handleKeyEvent(e)
    expect(actions.pasteClipboard).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('Ctrl+D duplicates the whole layer, selection or not', () => {
    useSandboxStore.setState({ selection: null })
    handleKeyEvent(ctrl('d'))
    expect(actions.duplicateLayer).toHaveBeenCalledWith(1)
  })

  it('a cut/copy with no meaningful selection is not claimed', () => {
    // A sub-millisecond drag — hasMeaningfulSelection's floor rejects it.
    useSandboxStore.setState({ selection: { startSample: 100, endSample: 110 } })

    const del = keyEvent('Delete')
    handleKeyEvent(del)
    expect(actions.cutSelection).not.toHaveBeenCalled()
    expect(del.defaultPrevented).toBe(false)

    const copy = ctrl('c')
    handleKeyEvent(copy)
    expect(actions.copySelection).not.toHaveBeenCalled()
    expect(copy.defaultPrevented).toBe(false)
  })

  it('nothing fires while the active layer has not rendered', () => {
    // A selection's sample indices describe a buffer nobody can see yet.
    useSandboxStore.setState({ layers: [layer({ renderState: 'rendering' })] })
    handleKeyEvent(keyEvent('Delete'))
    handleKeyEvent(ctrl('c'))
    handleKeyEvent(ctrl('d'))
    expect(actions.cutSelection).not.toHaveBeenCalled()
    expect(actions.copySelection).not.toHaveBeenCalled()
    expect(actions.duplicateLayer).not.toHaveBeenCalled()
  })

  it('nothing fires while another panel has focus', () => {
    usePanelRegistry.getState().openPanel('mixer')
    handleKeyEvent(keyEvent('Delete'))
    expect(actions.cutSelection).not.toHaveBeenCalled()
  })

  it('Ctrl+A selects the whole layer and claims the key', () => {
    const e = ctrl('a')
    handleKeyEvent(e)
    expect(useSandboxStore.getState().selection).toEqual({ startSample: 0, endSample: 48000 })
    expect(e.defaultPrevented).toBe(true)
  })

  // One letter per tool, through the same store action the tool bar's buttons call.
  it('S, E, B and R pick the pointer tool', () => {
    const tool = () => {
      const s = useSandboxStore.getState()
      return s.paintEditMode ? 'paint' : s.envelopeEditMode ? 'envelope' : s.spcSelectMode ? 'region' : 'select'
    }
    handleKeyEvent(keyEvent('e'))
    expect(tool()).toBe('envelope')
    handleKeyEvent(keyEvent('b'))
    expect(tool()).toBe('paint')
    expect(useSandboxStore.getState().viewMode).toBe('spc')
    handleKeyEvent(keyEvent('R')) // Caps Lock still resolves
    expect(tool()).toBe('region')
    handleKeyEvent(keyEvent('s'))
    expect(tool()).toBe('select')
  })

  it('tool keys are left alone while the layer has not rendered', () => {
    useSandboxStore.setState({ layers: [layer({ renderState: 'rendering' })] })
    const e = keyEvent('e')
    handleKeyEvent(e)
    expect(useSandboxStore.getState().envelopeEditMode).toBe(false)
    expect(e.defaultPrevented).toBe(false)
  })
})
