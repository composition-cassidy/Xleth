/**
 * @vitest-environment jsdom
 *
 * FX Chain Library — mounts the REAL FxChainMenuLayer against a stubbed
 * window.xleth and drives the menu the way a user does: right-click a strip,
 * hover the library, pick Replace or Add, save, copy/paste, and press-and-hold
 * to start the sticky drag.
 *
 * Assertions read the captured IPC payloads rather than trusting that a handler
 * fired: the renderer reaches the engine through optional chaining
 * (window.xleth?.audio?.foo?.()), so a broken call is a silent no-op that a
 * "did it render" test would happily pass.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import FxChainMenuLayer from '../FxChainMenuLayer.jsx'
import useFxChainDragStore from '../../../stores/fxChainDragStore.js'
import useEffectChainStore from '../../../stores/effectChainStore.js'
import useMixerStore from '../../../stores/mixerStore.js'
import useVstStore from '../../../stores/vstStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CHAIN_SLOTS = [
  { nodeId: 1, pluginId: 'xletheq', position: 0, bypassed: false },
  { nodeId: 2, pluginId: 'reverb', position: 1, bypassed: true },
]

const SNAPSHOT = JSON.stringify({
  nodes: [
    { nodeId: 2, pluginId: 'reverb', bypassed: true, state: 'UkVW' },
    { nodeId: 1, pluginId: 'xletheq', bypassed: false, state: 'RVE=' },
  ],
})

let container
let root
let audio
let fxChains

function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root.render(<FxChainMenuLayer />) })
}

// The menu, submenu, flyout, dialog and ghost are all portaled to <body>.
const q = (sel) => document.body.querySelector(sel)
const qa = (sel) => [...document.body.querySelectorAll(sel)]

function rowByText(sel, text) {
  return qa(sel).find((el) => el.textContent.includes(text))
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

// React keeps its own value tracker on controlled inputs and skips onChange when
// the DOM value is assigned directly, so a plain `el.value = x` reads as "no
// change" and the component never re-renders. Going through the prototype setter
// is what a real keystroke does.
function typeInto(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function openMenuFor(fxKey) {
  await act(async () => { useFxChainDragStore.getState().openMenu(fxKey, 40, 40) })
  await flush()
}

beforeEach(() => {
  audio = {
    getEffectChainSnapshot: vi.fn(async () => SNAPSHOT),
    getMasterEffectChainSnapshot: vi.fn(async () => SNAPSHOT),
    applyEffectChainPreset: vi.fn(async () =>
      JSON.stringify({ ok: true, added: 2, skipped: [], effectCount: 2, undoable: true })),
    applyMasterEffectChainPreset: vi.fn(async () =>
      JSON.stringify({ ok: true, added: 2, skipped: [], effectCount: 2, undoable: true })),
  }
  fxChains = {
    list: vi.fn(async () => ({
      chains: [
        { slug: 'cool-bass', folder: null, name: 'cool bass', effectCount: 3,
          pluginIds: ['xlethfilter', 'distortion', 'compressor'] },
        { slug: 'guitar-fx', folder: null, name: 'guitar fx', effectCount: 2,
          pluginIds: ['phanjer', 'vst:ozone11'] },
        { slug: 'for-kick', folder: 'Drums', name: 'for kick', effectCount: 4,
          pluginIds: ['transientproc', 'xletheq', 'apex', 'limiter'] },
      ],
      folders: ['Drums'],
      root: 'C:\\fx-chains',
    })),
    load: vi.fn(async (folder, slug) => ({
      xlethFxChain: 1,
      name: slug === 'for-kick' ? 'for kick' : 'cool bass',
      effects: [{ pluginId: 'xlethfilter', bypassed: false, state: 'Rg==' }],
    })),
    save: vi.fn(async () => ({ slug: 'cool-bass', folder: null, overwritten: false })),
    delete: vi.fn(async () => true),
    openFolder: vi.fn(async () => ({ ok: true, root: 'C:\\fx-chains', error: null })),
  }
  globalThis.window.xleth = { audio, fxChains }

  useEffectChainStore.setState({
    chains: { 3: CHAIN_SLOTS, 4: [], master: CHAIN_SLOTS },
    fxModes: { 3: 'chain', 4: 'chain', 5: 'graph' },
  })
  useEffectChainStore.setState({ fetchChain: vi.fn(async () => {}) })
  useMixerStore.setState({
    tracks: {
      3: { id: 3, name: 'Track 1', volume: 0.5, pan: -0.2, spread: 1.2 },
      4: { id: 4, name: 'Track 2', volume: 1, pan: 0, spread: 1 },
      5: { id: 5, name: 'Track 3', volume: 1, pan: 0, spread: 1 },
    },
    setVolume: vi.fn(), setPan: vi.fn(), setSpread: vi.fn(),
  })
  useVstStore.setState({ plugins: [] })
  useFxChainDragStore.getState().end()
  useFxChainDragStore.getState().clearClipboard()
  useFxChainDragStore.getState().closeMenu()
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  vi.useRealTimers()
})

describe('the menu itself', () => {
  it('renders nothing until a strip is right-clicked', () => {
    mount()
    expect(q('.fxchain-menu')).toBeNull()
  })

  it('opens naming the track it belongs to', async () => {
    mount()
    await openMenuFor('3')
    expect(q('.fxchain-menu')).not.toBeNull()
    expect(q('.fxchain-menu-head').textContent).toContain('Track 1')
  })

  it('offers the same menu on the master strip', async () => {
    mount()
    await openMenuFor('master')
    expect(q('.fxchain-menu-head').textContent).toContain('Master')
    expect(rowByText('.fxchain-mi', 'Save FX Chain').disabled).toBe(false)
    expect(rowByText('.fxchain-mi', 'FX Chain Library').disabled).toBe(false)
  })

  it('disables saving and copying on a track with no effects', async () => {
    mount()
    await openMenuFor('4')
    expect(rowByText('.fxchain-mi', 'Save FX Chain').disabled).toBe(true)
    expect(rowByText('.fxchain-mi', 'Copy FX Chain').disabled).toBe(true)
    expect(q('.fxchain-mi-sub').textContent).toContain('no effects on this track')
  })

  it('disables the library on an FX Graph track and says why', async () => {
    mount()
    await openMenuFor('5')
    const libRow = rowByText('.fxchain-mi', 'FX Chain Library')
    expect(libRow.disabled).toBe(true)
    expect(libRow.textContent).toContain('chain mode only')
  })

  it('disables Paste until something has been copied', async () => {
    mount()
    await openMenuFor('3')
    expect(rowByText('.fxchain-mi', 'Paste FX Chain').disabled).toBe(true)
  })
})

describe('the library submenu', () => {
  async function openLibrary(fxKey = '3') {
    mount()
    await openMenuFor(fxKey)
    await act(async () => {
      rowByText('.fxchain-mi', 'FX Chain Library')
        .closest('.fxchain-mi-wrap')
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    // React synthesises mouseEnter from mouseover.
    await flush()
  }

  it('lists the root chains and the folder groups', async () => {
    await openLibrary()
    expect(q('.fxchain-submenu')).not.toBeNull()
    expect(qa('.fxchain-lib-group').map(el => el.textContent)).toEqual(['Library', 'Drums'])
    expect(qa('.fxchain-lib-name').map(el => el.textContent))
      .toEqual(['cool bass', 'guitar fx', 'for kick'])
  })

  it('shows each chain effect count', async () => {
    await openLibrary()
    expect(qa('.fxchain-lib-count').map(el => el.textContent))
      .toEqual(['3 fx', '2 fx', '4 fx'])
  })

  it('flags a chain whose plugin is not installed here', async () => {
    await openLibrary()
    const missing = qa('.fxchain-lib-item.is-missing')
    expect(missing).toHaveLength(1)
    expect(missing[0].textContent).toContain('guitar fx')
    expect(missing[0].getAttribute('title')).toContain('vst:ozone11')
  })

  it('stops flagging it once that plugin has been scanned', async () => {
    useVstStore.setState({ plugins: [{ id: 'vst:ozone11', name: 'Ozone 11' }] })
    await openLibrary()
    expect(qa('.fxchain-lib-item.is-missing')).toHaveLength(0)
  })

  it('filters on name and on contained plugin', async () => {
    await openLibrary()
    const input = q('.fxchain-search input')

    await act(async () => { typeInto(input, 'kick') })
    expect(qa('.fxchain-lib-name').map(el => el.textContent)).toEqual(['for kick'])

    await act(async () => { typeInto(input, 'distortion') })
    expect(qa('.fxchain-lib-name').map(el => el.textContent)).toEqual(['cool bass'])
  })

  it('says so when nothing matches', async () => {
    await openLibrary()
    const input = q('.fxchain-search input')
    await act(async () => { typeInto(input, 'zzzz') })
    expect(q('.fxchain-lib-empty').textContent).toContain('No chain matches')
  })

  it('asks Replace or Add on a track that already has effects', async () => {
    await openLibrary('3')
    await act(async () => {
      rowByText('.fxchain-lib-item', 'cool bass')
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    const flyout = q('.fxchain-flyout')
    expect(flyout).not.toBeNull()
    expect(flyout.textContent).toContain('Replace chain')
    expect(flyout.textContent).toContain('Add to chain')
  })

  it('loads straight away on an empty track — nothing to lose, nothing to ask', async () => {
    await openLibrary('4')
    await act(async () => {
      rowByText('.fxchain-lib-item', 'cool bass')
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(q('.fxchain-flyout')).toBeNull()

    await act(async () => {
      rowByText('.fxchain-lib-item', 'cool bass').click()
    })
    await flush()
    expect(audio.applyEffectChainPreset).toHaveBeenCalled()
    expect(audio.applyEffectChainPreset.mock.calls[0][3]).toBe(true) // replace
  })

  it('Replace sends replace=true, Add sends replace=false', async () => {
    await openLibrary('3')
    await act(async () => {
      rowByText('.fxchain-lib-item', 'for kick')
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    await act(async () => { rowByText('.fxchain-flyout .fxchain-mi', 'Add to chain').click() })
    await flush()

    expect(fxChains.load).toHaveBeenCalledWith('Drums', 'for-kick')
    const [trackId, payload, label, replace, undoable] = audio.applyEffectChainPreset.mock.calls[0]
    expect(trackId).toBe(3)
    expect(JSON.parse(payload)).toEqual([{ pluginId: 'xlethfilter', bypassed: false, state: 'Rg==' }])
    expect(label).toBe('for kick')
    expect(replace).toBe(false)
    expect(undoable).toBe(true)
  })

  it('routes a master load through the master method', async () => {
    await openLibrary('master')
    await act(async () => {
      rowByText('.fxchain-lib-item', 'cool bass')
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    await act(async () => { rowByText('.fxchain-flyout .fxchain-mi', 'Replace chain').click() })
    await flush()

    expect(audio.applyMasterEffectChainPreset).toHaveBeenCalled()
    expect(audio.applyEffectChainPreset).not.toHaveBeenCalled()
  })
})

describe('save', () => {
  it('opens a dialog listing what was captured, in chain order', async () => {
    mount()
    await openMenuFor('3')
    const saveRow = rowByText('.fxchain-mi', 'Save FX Chain')
    await act(async () => {
      saveRow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      saveRow.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    })
    await flush()

    expect(q('.fxchain-dialog')).not.toBeNull()
    expect(qa('.fxchain-capture-name').map(el => el.textContent)).toEqual(['xletheq', 'reverb'])
    // A bypassed effect is marked, because it is saved bypassed.
    expect(q('.fxchain-capture-bypass').textContent).toBe('bypassed')
    expect(q('#fxchain-name').value).toBe('Track 1')
  })

  it('writes an ordered document with bypass and state, and no strip by default', async () => {
    mount()
    await openMenuFor('3')
    const saveRow = rowByText('.fxchain-mi', 'Save FX Chain')
    await act(async () => {
      saveRow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      saveRow.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    })
    await flush()

    await act(async () => { typeInto(q('#fxchain-name'), 'cool bass') })
    await act(async () => { rowByText('.fxchain-btn', 'Save').click() })
    await flush()

    const [doc, folder] = fxChains.save.mock.calls[0]
    expect(doc.name).toBe('cool bass')
    expect(doc.effects).toEqual([
      { pluginId: 'xletheq', bypassed: false, state: 'RVE=' },
      { pluginId: 'reverb', bypassed: true, state: 'UkVW' },
    ])
    expect('strip' in doc).toBe(false)
    expect(folder).toBeNull()
  })

  it('includes fader, pan and width only when the box is ticked', async () => {
    mount()
    await openMenuFor('3')
    const saveRow = rowByText('.fxchain-mi', 'Save FX Chain')
    await act(async () => {
      saveRow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      saveRow.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    })
    await flush()

    const checkbox = q('.fxchain-opt input')
    await act(async () => { checkbox.click() })
    await act(async () => { rowByText('.fxchain-btn', 'Save').click() })
    await flush()

    expect(fxChains.save.mock.calls[0][0].strip)
      .toEqual({ volume: 0.5, pan: -0.2, spread: 1.2 })
  })

  it('offers no strip checkbox on master, which has no pan or width', async () => {
    mount()
    await openMenuFor('master')
    const saveRow = rowByText('.fxchain-mi', 'Save FX Chain')
    await act(async () => {
      saveRow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      saveRow.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    })
    await flush()
    expect(q('.fxchain-opt')).toBeNull()
  })

  it('offers the existing folders as save destinations', async () => {
    mount()
    await openMenuFor('3')
    const saveRow = rowByText('.fxchain-mi', 'Save FX Chain')
    await act(async () => {
      saveRow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      saveRow.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    })
    await flush()
    expect(qa('.fxchain-dialog-select option').map(o => o.textContent))
      .toEqual(['Library (root)', 'Drums'])
  })
})

describe('copy and paste', () => {
  it('copies a chain then pastes it onto another track', async () => {
    mount()
    await openMenuFor('3')
    await act(async () => { rowByText('.fxchain-mi', 'Copy FX Chain').click() })
    await flush()

    expect(useFxChainDragStore.getState().clipboard.effects).toHaveLength(2)

    await openMenuFor('4')
    const pasteRow = rowByText('.fxchain-mi', 'Paste FX Chain')
    expect(pasteRow.disabled).toBe(false)
    expect(pasteRow.textContent).toContain('2 fx')

    await act(async () => { pasteRow.click() })
    await flush()

    const [trackId, payload, label, replace] = audio.applyEffectChainPreset.mock.calls[0]
    expect(trackId).toBe(4)
    expect(JSON.parse(payload).map(e => e.pluginId)).toEqual(['xletheq', 'reverb'])
    expect(label).toContain('Track 1')
    expect(replace).toBe(true)
  })
})

describe('press-and-hold sticky drag', () => {
  it('a quick click saves instead of dragging', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mount()
    await openMenuFor('3')
    const saveRow = rowByText('.fxchain-mi', 'Save FX Chain')
    await act(async () => {
      saveRow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      saveRow.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    })
    await flush()
    expect(useFxChainDragStore.getState().effects).toBeNull()
    expect(q('.fxchain-dialog')).not.toBeNull()
  })

  it('holding past the threshold picks the chain up and closes the menu', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mount()
    await openMenuFor('3')
    const saveRow = rowByText('.fxchain-mi', 'Save FX Chain')
    await act(async () => {
      saveRow.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, button: 0, clientX: 200, clientY: 200,
      }))
    })
    await act(async () => { vi.advanceTimersByTime(260) })
    await flush()

    const state = useFxChainDragStore.getState()
    expect(state.effects.map(e => e.pluginId)).toEqual(['xletheq', 'reverb'])
    expect(state.sourceKey).toBe('3')
    expect(state.menu).toBeNull()
    expect(q('.fxchain-menu')).toBeNull()

    const ghost = q('.fxchain-ghost')
    expect(ghost).not.toBeNull()
    expect(ghost.textContent).toContain('Track 1 FX chain')
    expect(q('.fxchain-ghost-count').textContent).toBe('2')
  })

  it('a drop applies the chain and the ghost STAYS UP for the next track', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mount()

    // Two strips the layer can hit-test against.
    const strip4 = document.createElement('div')
    strip4.setAttribute('data-fx-key', '4')
    const strip5 = document.createElement('div')
    strip5.setAttribute('data-fx-key', '5')
    document.body.append(strip4, strip5)

    await openMenuFor('3')
    const saveRow = rowByText('.fxchain-mi', 'Save FX Chain')
    await act(async () => {
      saveRow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })
    await act(async () => { vi.advanceTimersByTime(260) })
    await flush()

    // jsdom has no layout, so elementFromPoint never resolves to our stubs —
    // point it at each strip in turn instead.
    const original = document.elementFromPoint
    document.elementFromPoint = () => strip4
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })
    await flush()

    expect(audio.applyEffectChainPreset).toHaveBeenCalledTimes(1)
    expect(audio.applyEffectChainPreset.mock.calls[0][0]).toBe(4)
    expect(useFxChainDragStore.getState().effects).not.toBeNull()
    expect(q('.fxchain-ghost')).not.toBeNull()

    document.elementFromPoint = () => strip5
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })
    await flush()

    expect(audio.applyEffectChainPreset).toHaveBeenCalledTimes(2)
    expect(audio.applyEffectChainPreset.mock.calls[1][0]).toBe(5)
    expect(useFxChainDragStore.getState().drops).toBe(2)

    // Escape is what ends it.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(useFxChainDragStore.getState().effects).toBeNull()
    expect(q('.fxchain-ghost')).toBeNull()

    document.elementFromPoint = original
    strip4.remove()
    strip5.remove()
  })

  it('dropping on the source strip does nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mount()
    const strip3 = document.createElement('div')
    strip3.setAttribute('data-fx-key', '3')
    document.body.appendChild(strip3)

    await openMenuFor('3')
    await act(async () => {
      rowByText('.fxchain-mi', 'Save FX Chain')
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })
    await act(async () => { vi.advanceTimersByTime(260) })
    await flush()

    const original = document.elementFromPoint
    document.elementFromPoint = () => strip3
    await act(async () => {
      window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })
    await flush()

    expect(audio.applyEffectChainPreset).not.toHaveBeenCalled()
    // Still carrying it — clicking the source is a no-op, not a cancel.
    expect(useFxChainDragStore.getState().effects).not.toBeNull()

    document.elementFromPoint = original
    strip3.remove()
  })

  it('cannot be started from a track with no effects', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mount()
    await openMenuFor('4')
    await act(async () => {
      rowByText('.fxchain-mi', 'Save FX Chain')
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })
    await act(async () => { vi.advanceTimersByTime(400) })
    await flush()
    expect(useFxChainDragStore.getState().effects).toBeNull()
  })
})

describe('open library folder', () => {
  it('asks the main process to reveal it', async () => {
    mount()
    await openMenuFor('3')
    await act(async () => { rowByText('.fxchain-mi', 'Open Library Folder').click() })
    await flush()
    expect(fxChains.openFolder).toHaveBeenCalled()
    expect(q('.fxchain-menu')).toBeNull()
  })
})
