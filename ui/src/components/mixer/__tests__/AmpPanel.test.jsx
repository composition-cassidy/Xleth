/**
 * @vitest-environment jsdom
 *
 * AmpPanel contract tests.
 *
 * Three things this pins that nothing else can:
 *
 *  1. The panel's parameter surface IS spec 7 - twelve controls, the exact
 *     APVTS ids XlethAmpEffect::createLayout() declares, with the ranges and
 *     defaults the engine reports. bridge/test_amp_bridge.js asserts the same
 *     table from the engine side; if the two ever drift, one of them fails.
 *
 *  2. The drag discipline (spec 9). A knob drag updates local state on every
 *     move but coalesces engine writes to one per parameter per animation
 *     frame, and the release is a single authoritative write. A per-pointermove
 *     IPC storm is the failure mode this guards.
 *
 *  3. The automation opt-in. Continuous knobs pass paramId + automationTarget
 *     to PluginUIKitKnob; the Model and Cab choice selectors pass neither, so
 *     Model is structurally excluded from automation.
 *
 * PluginUIKitKnob is stubbed: the real one renders sampler/Knob.jsx into a
 * <canvas> 2D context jsdom does not implement (same convention as
 * eqBandPopup.test.jsx), and stubbing it is also what makes the props above
 * observable.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Spec 7, mirrored from XlethAmpEffect::createLayout(). [id, min, max, default]
const SPEC_PARAMS = [
  ['drive',    0,   10,  5],
  ['bass',     0,   10,  5],
  ['mid',      0,   10,  5],
  ['treble',   0,   10,  5],
  ['sag',      0,   10,  5],
  ['tighten',  0,   10,  5],
  ['gate',     0,   10,  0],
  ['presence', 0,   10,  5],
  ['mix',      0,   100, 100],
  ['output',   -24, 12,  0],
]

const knobRenders = []

async function loadAmpPanel() {
  vi.doMock('../../../plugin-ui/runtime/components/PluginUIKitKnob.jsx', () => ({
    default: (props) => {
      knobRenders.push(props)
      return <div data-testid={`knob-${props.paramId ?? 'unbound'}`} />
    },
  }))
  vi.doMock('../../../fx-presets/EffectPresetBar.jsx', () => ({
    default: () => <div data-testid="preset-bar-stub" />,
  }))
  const { default: AmpPanel } = await import('../AmpPanel.jsx')
  const { default: useAmpStore } = await import('../../../stores/ampStore.js')
  return { AmpPanel, useAmpStore }
}

function installXleth(params = {}) {
  const setEffectParameter = vi.fn(() => true)
  const getEffectParameters = vi.fn(async () => JSON.stringify(
    Object.entries(params).map(([id, value]) => ({ id, value })),
  ))
  window.xleth = { audio: { setEffectParameter, getEffectParameters } }
  return { setEffectParameter, getEffectParameters }
}

// requestAnimationFrame under our control, so "one write per frame" is testable
// rather than a matter of timing luck.
function installManualRaf() {
  const queue = []
  window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length }
  window.cancelAnimationFrame = () => {}
  globalThis.requestAnimationFrame = window.requestAnimationFrame
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame
  return {
    async flush() {
      const pending = queue.splice(0, queue.length)
      await act(async () => { pending.forEach((cb) => cb(0)) })
    },
    get pending() { return queue.length },
  }
}

async function mountPanel(AmpPanel, useAmpStore) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    useAmpStore.getState().open(1, 7, '1')
  })
  await act(async () => { root.render(<AmpPanel />) })
  return { container, root }
}

describe('AmpPanel', () => {
  beforeEach(() => {
    vi.resetModules()
    knobRenders.length = 0
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    window.innerWidth = 1600
    window.innerHeight = 900
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    delete window.xleth
  })

  it('renders nothing until an instance is open', async () => {
    installXleth()
    const { AmpPanel, useAmpStore } = await loadAmpPanel()
    useAmpStore.getState().close()

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<AmpPanel />) })

    expect(container.querySelector('.amp-panel')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('exposes exactly the spec 7 parameter surface', async () => {
    installXleth()
    const { AmpPanel, useAmpStore } = await loadAmpPanel()
    const { container, root } = await mountPanel(AmpPanel, useAmpStore)

    // Ten continuous knobs...
    const byId = new Map(knobRenders.map((p) => [p.paramId, p]))
    expect([...byId.keys()].sort()).toEqual(SPEC_PARAMS.map(([id]) => id).sort())
    for (const [id, min, max, def] of SPEC_PARAMS) {
      const knob = byId.get(id)
      expect(knob, `knob "${id}"`).toBeTruthy()
      expect(knob.min, `"${id}".min`).toBe(min)
      expect(knob.max, `"${id}".max`).toBe(max)
      expect(knob.defaultValue, `"${id}".default`).toBe(def)
    }

    // ...plus the two choice selectors, which are buttons, not knobs.
    const rows = container.querySelectorAll('.amp-choice')
    expect(rows.length).toBe(2)
    const [modelRow, cabRow] = rows
    expect(modelRow.querySelectorAll('.amp-choice-button').length).toBe(6)
    expect(cabRow.querySelectorAll('.amp-choice-button').length).toBe(5)   // Auto + 4 IRs

    await act(async () => { root.unmount() })
  })

  it('hydrates every control from the engine on open', async () => {
    const { getEffectParameters } = installXleth({
      model: 4, cab: 3, drive: 8.5, bass: 3.25, mid: 7.5, treble: 2,
      sag: 9, tighten: 1.5, gate: 4, presence: 6.5, mix: 62, output: -7.5,
    })
    const { AmpPanel, useAmpStore } = await loadAmpPanel()
    const { container, root } = await mountPanel(AmpPanel, useAmpStore)

    expect(getEffectParameters).toHaveBeenCalledWith(1, 7)

    const latest = new Map()
    for (const p of knobRenders) latest.set(p.paramId, p.value)
    expect(latest.get('drive')).toBe(8.5)
    expect(latest.get('mix')).toBe(62)
    expect(latest.get('output')).toBe(-7.5)

    // Model 4 = Rectifier, Cab 3 = Greenback 4x12 — the active radio in each row.
    const [modelRow, cabRow] = container.querySelectorAll('.amp-choice')
    const activeIndex = (row) => [...row.querySelectorAll('.amp-choice-button')]
      .findIndex((b) => b.getAttribute('aria-checked') === 'true')
    expect(activeIndex(modelRow)).toBe(4)
    expect(activeIndex(cabRow)).toBe(3)

    await act(async () => { root.unmount() })
  })

  it('coalesces a drag to one engine write per frame and commits once on release', async () => {
    const { setEffectParameter } = installXleth()
    const raf = installManualRaf()
    const { AmpPanel, useAmpStore } = await loadAmpPanel()
    const { root } = await mountPanel(AmpPanel, useAmpStore)

    const driveKnob = () => [...knobRenders].reverse().find((p) => p.paramId === 'drive')

    // Eight pointer moves inside one animation frame.
    for (const v of [5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9]) {
      const knob = driveKnob()
      await act(async () => { knob.onLiveChange(v) })
    }
    expect(setEffectParameter).not.toHaveBeenCalled()   // nothing before the frame runs
    expect(raf.pending).toBe(1)                          // one frame scheduled, not eight

    await raf.flush()
    expect(setEffectParameter).toHaveBeenCalledTimes(1)
    expect(setEffectParameter).toHaveBeenCalledWith(1, 7, 'drive', 9)   // the latest value only

    // Release: exactly one more, authoritative, write.
    setEffectParameter.mockClear()
    await act(async () => { driveKnob().onCommit(9.25) })
    expect(setEffectParameter).toHaveBeenCalledTimes(1)
    expect(setEffectParameter).toHaveBeenCalledWith(1, 7, 'drive', 9.25)

    // ...and the release does not leave a stale queued write behind.
    setEffectParameter.mockClear()
    await raf.flush()
    expect(setEffectParameter).not.toHaveBeenCalled()

    await act(async () => { root.unmount() })
  })

  it('commits a Model or Cab selection as a single click-through write', async () => {
    const { setEffectParameter } = installXleth()
    const { AmpPanel, useAmpStore } = await loadAmpPanel()
    const { container, root } = await mountPanel(AmpPanel, useAmpStore)

    const [modelRow, cabRow] = container.querySelectorAll('.amp-choice')
    const modelButtons = modelRow.querySelectorAll('.amp-choice-button')
    await act(async () => { modelButtons[1].click() })
    expect(setEffectParameter).toHaveBeenCalledWith(1, 7, 'model', 1)

    setEffectParameter.mockClear()
    const cabButtons = cabRow.querySelectorAll('.amp-choice-button')
    await act(async () => { cabButtons[2].click() })
    expect(setEffectParameter).toHaveBeenCalledTimes(1)
    expect(setEffectParameter).toHaveBeenCalledWith(1, 7, 'cab', 2)

    await act(async () => { root.unmount() })
  })

  it('opts every continuous knob into automation and excludes Model and Cab', async () => {
    installXleth()
    const { AmpPanel, useAmpStore } = await loadAmpPanel()
    const { container, root } = await mountPanel(AmpPanel, useAmpStore)

    // A knob is automatable only when it carries BOTH props (see
    // automationKnobBinding.jsx). Every knob here does.
    for (const knob of knobRenders) {
      expect(knob.paramId, 'every knob carries a paramId').toBeTruthy()
      expect(knob.automationTarget, `"${knob.paramId}".automationTarget`)
        .toEqual({ trackId: 1, nodeId: 7, storeKey: '1' })
    }
    // Model and Cab are not knobs at all, so they cannot reach that path.
    expect(knobRenders.some((k) => k.paramId === 'model')).toBe(false)
    expect(knobRenders.some((k) => k.paramId === 'cab')).toBe(false)
    expect(container.querySelectorAll('.amp-choice-button').length).toBe(11)

    await act(async () => { root.unmount() })
  })

  it('follows the model side for the skin and lets the header override it', async () => {
    installXleth({ model: 0 })                    // Blackface Clean — a vintage model
    const { AmpPanel, useAmpStore } = await loadAmpPanel()
    const { container, root } = await mountPanel(AmpPanel, useAmpStore)

    expect(container.querySelector('.amp-panel').className).toContain('amp-panel--analog')

    const chip = container.querySelector('.amp-skin-chip')
    await act(async () => { chip.click() })
    expect(container.querySelector('.amp-panel').className).toContain('amp-panel--modern')

    // The override is panel state, not an engine parameter.
    expect(window.xleth.audio.setEffectParameter).not.toHaveBeenCalled()

    await act(async () => { root.unmount() })
  })
})
