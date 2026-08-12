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

// One slot carrying MANGLE, shaped like the engine's slotToJs() output.
function makeSlot(overrides = {}) {
  return {
    audioFilePath: 'C:/x.wav', name: 'Layer 1', rootNote: 60,
    octave: 0, semitone: 0, fine: 0, coarse: 0,
    volume: 1, pan: 0, mute: false, solo: false,
    smpStart: 0, smpLength: 0, declickMs: 1.5, fadeInMs: 0, fadeOutMs: 0,
    loopEnabled: false, loopStart: 0, loopEnd: 0, crossfadeSamples: 0,
    loopMode: 0, exitLoopOnRelease: false,
    mangleMode: 0, mangleAmount: 0, mangleMix: 1,
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
const modeSelect = () => mangleCard().querySelector('select')

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

  it('reads MANGLE off the slot, not the region', async () => {
    // 18 = Tube. If the panel read the region instead of the slot this would
    // fall back to Off.
    await mount([makeSlot({ mangleMode: 18, mangleAmount: 0.5, mangleMix: 0.75 })])
    expect(modeSelect().value).toBe('18')
    expect(mangleCard().className).not.toContain('is-bypassed')
    expect(mangleCard().textContent).toContain('per note')
  })

  it('goes quiet when mix is 0 even with a mode selected, matching the engine gate', async () => {
    await mount([makeSlot({ mangleMode: 18, mangleAmount: 1, mangleMix: 0 })])
    expect(modeSelect().value).toBe('18')
    expect(mangleCard().className).toContain('is-bypassed')
  })

  it('follows the selected slot', async () => {
    // Slot 0 is Off, slot 1 is LPF. The panel opens on slot 0.
    await mount([makeSlot(), makeSlot({ name: 'Layer 2', mangleMode: 14 })])
    expect(modeSelect().value).toBe('0')
  })

  it('commits a mode change through IPC with the slot index attached', async () => {
    await mount()
    const select = modeSelect()
    await act(async () => {
      select.value = '20'   // Hard Clip
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { await Promise.resolve() })

    const write = commits.find((c) => 'mangleMode' in c.payload)
    expect(write, 'a mangleMode commit should have reached IPC').toBeTruthy()
    expect(write.regionId).toBe(REGION_ID)
    expect(write.payload.mangleMode).toBe(20)
    // slotIndex is what routes the flat key onto the selected layer.
    expect(write.payload.slotIndex).toBe(0)
  })

  it('lights the accent immediately after a mode is picked', async () => {
    await mount()
    const select = modeSelect()
    await act(async () => {
      select.value = '18'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => { await Promise.resolve() })
    expect(mangleCard().className).not.toContain('is-bypassed')
    // The hint text must track the selection rather than staying generic.
    expect(mangleCard().textContent).not.toContain('Bypassed')
  })

  it('shows the per-mode hint for a mode that has one', async () => {
    await mount([makeSlot({ mangleMode: 1 })])   // Sync
    expect(mangleCard().textContent).toContain('hard sync')
  })

  it('the Off button bypasses without touching amount or mix', async () => {
    await mount([makeSlot({ mangleMode: 18, mangleAmount: 0.5, mangleMix: 0.75 })])
    const offBtn = [...mangleCard().querySelectorAll('button')]
      .find((b) => b.textContent.trim() === 'Off')
    expect(offBtn).toBeTruthy()
    expect(offBtn.disabled).toBe(false)

    await act(async () => { offBtn.click() })
    await act(async () => { await Promise.resolve() })

    const write = commits.find((c) => 'mangleMode' in c.payload)
    expect(write).toBeTruthy()
    expect(write.payload.mangleMode).toBe(0)
    expect(write.payload).not.toHaveProperty('mangleAmount')
    expect(write.payload).not.toHaveProperty('mangleMix')
  })

  it('disables the Off button when already bypassed', async () => {
    await mount()
    const offBtn = [...mangleCard().querySelectorAll('button')]
      .find((b) => b.textContent.trim() === 'Off')
    expect(offBtn.disabled).toBe(true)
  })
})
