/**
 * @vitest-environment jsdom
 *
 * MANGLE section — mounts the REAL SamplerPanelContent against a stubbed
 * window.xleth and drives the mode dropdown, so the whole chain is exercised:
 * engine slot payload -> panel state -> rendered controls -> IPC commit.
 *
 * The source-assertion suite next door can prove the JSX contains the right
 * strings but not that the component renders at all, and the renderer's
 * optional chaining (window.xleth?.timeline?.foo?.()) turns a broken call into
 * a silent no-op. So the commit assertions here read the captured IPC payload
 * rather than trusting that a handler fired.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SamplerPanelContent from '../SamplerPanelContent.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no canvas backend and this panel paints knobs + a waveform on mount.
const gradient = { addColorStop: () => {} }
const noopCtx = () => new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'canvas') return { width: 0, height: 0 }
    if (prop === 'measureText') return () => ({ width: 0 })
    if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) })
    return () => gradient
  },
})

const REGION_ID = 7

// One MANGLE instance, shaped like the engine's slotToJs() chain entry.
function inst(mode, amount = 0, mix = 1, bypass = false) {
  return { mode, amount, mix, bypass }
}

// One slot carrying a MANGLE chain, shaped like the engine's slotToJs() output.
function makeSlot(overrides = {}) {
  return {
    audioFilePath: 'C:/x.wav', name: 'Layer 1', rootNote: 60,
    octave: 0, semitone: 0, fine: 0, coarse: 0,
    volume: 1, pan: 0, mute: false, solo: false,
    smpStart: 0, smpLength: 0, declickMs: 1.5, fadeInMs: 0, fadeOutMs: 0,
    loopEnabled: false, loopStart: 0, loopEnd: 0, crossfadeSamples: 0,
    loopMode: 0, exitLoopOnRelease: false,
    mangleChain: [],
    prepAlgorithm: 2, prepStretch: 1, prepShiftCents: 0,
    dcOffsetRemoved: false, normalized: false, polarityReversed: false, reversed: false,
    ...overrides,
  }
}

let container = null
let root = null
let commits = []

// The stub must APPLY writes, not just record them. Every commit re-fetches
// the region, so a stub that swallowed the patch would silently revert the
// panel's optimistic state and make the post-commit assertions test nothing.
// This mirrors the engine's Timeline_UpdateSamplerSettings routing: a `slots`
// array replaces the list, otherwise the flat keys patch slot `slotIndex`.
function installXleth(initialSlots) {
  commits = []
  let slots = initialSlots.map((s) => ({ ...s }))

  globalThis.window.xleth = {
    timeline: {
      getRegions: async () => ([{
        id: REGION_ID, name: 'R', slots: slots.map((s) => ({ ...s })),
        attackMs: 0, decayMs: 0, sustain: 1, releaseMs: 50,
        crossfadeEnabled: true,
      }]),
      getRegionAudioInfo: async () => ({
        numSamples: 48000, originalSampleRate: 48000, duration: 1,
        audioFilePath: 'C:/x.wav',
      }),
      updateSamplerSettings: async (regionId, payload) => {
        commits.push({ regionId, payload })
        if (Array.isArray(payload.slots)) {
          slots = payload.slots.map((s) => ({ ...s }))
        } else {
          const { slotIndex = 0, ...flat } = payload
          if (slots[slotIndex]) slots[slotIndex] = { ...slots[slotIndex], ...flat }
        }
        return true
      },
      previewNote: () => {}, previewNoteOff: () => {},
      getSlotBakeStatus: async () => ({ pending: [], changed: false }),
    },
  }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(noopCtx)
})

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  container?.remove()
  container = null
  root = null
  delete globalThis.window.xleth
})

async function mount(slots = [makeSlot()]) {
  installXleth(slots)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<SamplerPanelContent regionId={REGION_ID} onClose={() => {}} />)
  })
  // Let the async fetchAll() settle into state.
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  return container
}

const mangleCard = () => container.querySelector('.sampler-range-card--mangle')
const rows = () => [...mangleCard().querySelectorAll('.sampler-mangle-inst')]
const modeSelect = (row = 0) => rows()[row].querySelector('select')
const addButton = () => mangleCard().querySelector('.sampler-mangle-add')
const lastCommit = (key) => [...commits].reverse().find((c) => key in c.payload)

async function pickMode(row, value) {
  const select = modeSelect(row)
  await act(async () => {
    select.value = String(value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => { await Promise.resolve() })
}

describe('MANGLE section renders', () => {
  it('mounts the panel and shows the MANGLE card', async () => {
    await mount()
    expect(mangleCard()).toBeTruthy()
    expect(mangleCard().textContent).toContain('Mangle')
  })

  it('offers every mode, grouped into the four families', async () => {
    await mount()
    const select = modeSelect()
    expect(select).toBeTruthy()

    const groups = [...select.querySelectorAll('optgroup')].map((g) => g.label)
    expect(groups).toEqual(['Alt', 'Filter', 'Distortion', 'Modulation'])

    const options = [...select.querySelectorAll('option')]
    // 35 playable modes + the standalone Off entry.
    expect(options).toHaveLength(36)
    expect(options[0].value).toBe('0')
    expect(options[0].textContent).toBe('Off')

    // Ids must be contiguous 0..35 with no gap or duplicate.
    const values = options.map((o) => Number(o.value)).sort((a, b) => a - b)
    expect(values).toEqual(Array.from({ length: 36 }, (_, i) => i))
  })

  it('renders AMOUNT and MIX knobs alongside the dropdown', async () => {
    await mount()
    const text = mangleCard().textContent
    expect(text).toContain('Amount')
    expect(text).toContain('Mix')
    // Both knobs paint to their own canvas.
    expect(mangleCard().querySelectorAll('canvas').length).toBeGreaterThanOrEqual(2)
  })

  it('starts bypassed for a default slot and drops the accent state', async () => {
    await mount()
    expect(mangleCard().className).toContain('is-bypassed')
    expect(mangleCard().textContent).toContain('Bypassed')
    expect(mangleCard().textContent).not.toContain('per note')
  })

  it('reads the chain off the slot, not the region', async () => {
    // 18 = Tube. If the panel read the region instead of the slot this would
    // fall back to Off.
    await mount([makeSlot({ mangleChain: [inst(18, 0.5, 0.75)] })])
    expect(modeSelect().value).toBe('18')
    expect(mangleCard().className).not.toContain('is-bypassed')
    expect(mangleCard().textContent).toContain('per note')
  })

  it('goes quiet when an instance mixes 0, matching the engine gate', async () => {
    await mount([makeSlot({ mangleChain: [inst(18, 1, 0)] })])
    expect(modeSelect().value).toBe('18')
    expect(mangleCard().className).toContain('is-bypassed')
  })

  it('goes quiet when the only instance is bypassed', async () => {
    await mount([makeSlot({ mangleChain: [inst(18, 1, 1, true)] })])
    expect(mangleCard().className).toContain('is-bypassed')
  })

  it('follows the selected slot', async () => {
    // Slot 0 is empty (virtual Off), slot 1 is LPF. The panel opens on slot 0.
    await mount([makeSlot(), makeSlot({ name: 'Layer 2', mangleChain: [inst(14)] })])
    expect(modeSelect().value).toBe('0')
    expect(mangleCard().className).toContain('is-bypassed')
  })

  it('commits a mode change as the full chain array with the slot index attached', async () => {
    await mount()
    await pickMode(0, 20)   // Hard Clip

    const write = lastCommit('mangleChain')
    expect(write, 'a mangleChain commit should have reached IPC').toBeTruthy()
    expect(write.regionId).toBe(REGION_ID)
    expect(Array.isArray(write.payload.mangleChain)).toBe(true)
    expect(write.payload.mangleChain).toHaveLength(1)
    expect(write.payload.mangleChain[0].mode).toBe(20)
    // slotIndex is what routes the array onto the selected layer.
    expect(write.payload.slotIndex).toBe(0)
  })

  it('lights the accent immediately after a mode is picked', async () => {
    await mount()
    await pickMode(0, 18)
    expect(mangleCard().className).not.toContain('is-bypassed')
    expect(mangleCard().textContent).not.toContain('Bypassed')
  })

  it('shows the per-mode hint for a single-instance chain', async () => {
    await mount([makeSlot({ mangleChain: [inst(1)] })])   // Sync
    expect(mangleCard().textContent).toContain('hard sync')
  })

  it('adds an instance via the + control, up to the cap', async () => {
    await mount([makeSlot({ mangleChain: [inst(18)] })])
    expect(rows()).toHaveLength(1)

    await act(async () => { addButton().click() })
    await act(async () => { await Promise.resolve() })

    expect(rows()).toHaveLength(2)
    const write = lastCommit('mangleChain')
    expect(write.payload.mangleChain).toHaveLength(2)
    expect(write.payload.mangleChain[0].mode).toBe(18)   // existing instance preserved
    expect(write.payload.mangleChain[1].mode).toBe(0)    // new one starts Off

    // Fill to the cap (4); the + control then disappears.
    await act(async () => { addButton().click() })
    await act(async () => { addButton().click() })
    await act(async () => { await Promise.resolve() })
    expect(rows()).toHaveLength(4)
    expect(addButton()).toBeNull()
  })

  it('bypasses one instance without disturbing the others', async () => {
    await mount([makeSlot({ mangleChain: [inst(18, 0.5, 0.75), inst(14, 0.3, 1)] })])
    const bypassBtn = rows()[0].querySelector('.sampler-mangle-bypass')
    expect(bypassBtn).toBeTruthy()
    expect(bypassBtn.getAttribute('aria-pressed')).toBe('true')   // on == pressed

    await act(async () => { bypassBtn.click() })
    await act(async () => { await Promise.resolve() })

    const write = lastCommit('mangleChain')
    expect(write.payload.mangleChain[0].bypass).toBe(true)
    expect(write.payload.mangleChain[0].mode).toBe(18)   // mode untouched
    expect(write.payload.mangleChain[1].bypass).toBe(false)
  })

  it('removes an instance', async () => {
    await mount([makeSlot({ mangleChain: [inst(18), inst(14)] })])
    expect(rows()).toHaveLength(2)

    await act(async () => { rows()[0].querySelector('.sampler-mangle-remove').click() })
    await act(async () => { await Promise.resolve() })

    expect(rows()).toHaveLength(1)
    const write = lastCommit('mangleChain')
    expect(write.payload.mangleChain).toHaveLength(1)
    expect(write.payload.mangleChain[0].mode).toBe(14)   // the survivor
  })

  it('reorders instances, which the engine renders in order', async () => {
    await mount([makeSlot({ mangleChain: [inst(20, 0.7, 1), inst(14, 0.5, 1)] })])
    // Row 0 move-down (the second .sampler-mangle-move in the row).
    const moves = rows()[0].querySelectorAll('.sampler-mangle-move')
    expect(moves).toHaveLength(2)
    const down = moves[1]
    expect(down.disabled).toBe(false)

    await act(async () => { down.click() })
    await act(async () => { await Promise.resolve() })

    const write = lastCommit('mangleChain')
    expect(write.payload.mangleChain.map((m) => m.mode)).toEqual([14, 20])
  })

  it('shows the ordered chain summary for multiple active instances', async () => {
    await mount([makeSlot({ mangleChain: [inst(18, 0.8, 1), inst(14, 0.4, 1)] })])
    // Tube -> LPF, in chain order.
    expect(mangleCard().textContent).toContain('Tube → LPF')
  })
})
