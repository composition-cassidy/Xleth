/**
 * @vitest-environment jsdom
 *
 * FetCompPanel contract tests.
 *
 *  1. The four knobs ARE XlethFetCompressorEffect::createLayout()'s input /
 *     output / attack / release, with the engine's ranges and defaults, and
 *     each opts into automation (paramId + automationTarget).
 *  2. ATTACK / RELEASE keep the hardware numbering (1..7, 7 = fastest) and the
 *     readout shows the time the engine will use.
 *  3. The ratio buttons send the engine INDEX (4:1 0 … 20:1 3, ALL 4) and
 *     carry no automation binding.
 *  4. Hydration reads the engine's values back, rounding the index param.
 *  5. The gain-reduction meter reads slot 2.
 *
 * PluginUIKitKnob is stubbed (it draws into a <canvas> jsdom lacks), which is
 * also what makes its props observable.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mirrored from XlethFetCompressorEffect::createLayout(). [id, min, max, default]
const KNOBS = [
  ['input',   -24, 36, 0],
  ['output',  -24, 24, 0],
  ['attack',    1,  7, 3],
  ['release',   1,  7, 5],
]

const knobRenders = []

async function loadPanel() {
  vi.doMock('../../../plugin-ui/runtime/components/PluginUIKitKnob.jsx', () => ({
    default: (props) => {
      knobRenders.push(props)
      return <div data-testid={`knob-${props.paramId ?? 'unbound'}`} />
    },
  }))
  const mod = await import('../FetCompPanel.jsx')
  const { default: useFetCompStore } = await import('../../../stores/fetCompStore.js')
  return { FetCompPanel: mod.default, attackSeconds: mod.attackSeconds, releaseSeconds: mod.releaseSeconds, useFetCompStore }
}

function installXleth(params = {}, meters = [0, 0, 12.4, 0, 0, 0, 0, 0]) {
  const setEffectParameter = vi.fn(() => true)
  const getEffectParameters = vi.fn(async () => JSON.stringify(
    Object.entries(params).map(([id, value]) => ({ id, value })),
  ))
  const getEffectMeter = vi.fn(async () => JSON.stringify(meters))
  window.xleth = { audio: { setEffectParameter, getEffectParameters, getEffectMeter } }
  return { setEffectParameter, getEffectParameters, getEffectMeter }
}

async function mount(FetCompPanel, useFetCompStore) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { useFetCompStore.getState().open(3, 11, '3') })
  await act(async () => { root.render(<FetCompPanel />) })
  return { container, root }
}

function ratioButtons(container) {
  const group = container.querySelector('[role="radiogroup"][aria-label="Ratio"]')
  return group ? [...group.querySelectorAll('button')] : []
}

const lastKnob = (id) => knobRenders.filter((p) => p.paramId === id).at(-1)

describe('FetCompPanel', () => {
  let rafQueue

  beforeEach(() => {
    vi.resetModules()
    knobRenders.length = 0
    rafQueue = []
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    window.innerWidth = 1600
    window.innerHeight = 900
    window.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length }
    window.cancelAnimationFrame = () => {}
    globalThis.requestAnimationFrame = window.requestAnimationFrame
    globalThis.cancelAnimationFrame = window.cancelAnimationFrame
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    delete window.xleth
  })

  it('renders nothing until an instance is open', async () => {
    installXleth()
    const { FetCompPanel, useFetCompStore } = await loadPanel()
    useFetCompStore.getState().close()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<FetCompPanel />) })
    expect(container.querySelector('.fetcomp-panel')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('knobs mirror the engine layout and opt into automation', async () => {
    installXleth()
    const { FetCompPanel, useFetCompStore } = await loadPanel()
    const { root } = await mount(FetCompPanel, useFetCompStore)

    const byId = new Map(knobRenders.map((p) => [p.paramId, p]))
    expect([...byId.keys()].sort()).toEqual(KNOBS.map(([id]) => id).sort())
    for (const [id, min, max, def] of KNOBS) {
      const k = byId.get(id)
      expect(k.min, `${id}.min`).toBe(min)
      expect(k.max, `${id}.max`).toBe(max)
      expect(k.defaultValue, `${id}.default`).toBe(def)
      expect(k.automationTarget).toEqual({ trackId: 3, nodeId: 11, storeKey: '3' })
    }
    await act(async () => { root.unmount() })
  })

  it('attack / release keep the hardware numbering: 7 is fastest', async () => {
    installXleth()
    const { FetCompPanel, attackSeconds, releaseSeconds, useFetCompStore } = await loadPanel()
    const { root } = await mount(FetCompPanel, useFetCompStore)

    // Fet1176::attackSeconds / releaseSeconds.
    expect(attackSeconds(7)).toBeCloseTo(20e-6, 12)
    expect(attackSeconds(1)).toBeCloseTo(800e-6, 12)
    expect(releaseSeconds(7)).toBeCloseTo(0.05, 12)
    expect(releaseSeconds(1)).toBeCloseTo(1.1, 12)
    expect(attackSeconds(5)).toBeLessThan(attackSeconds(4))
    expect(releaseSeconds(5)).toBeLessThan(releaseSeconds(4))

    expect(lastKnob('attack').formatValue(7)).toBe('7.0 · 20 µs')
    expect(lastKnob('attack').formatValue(1)).toBe('1.0 · 800 µs')
    expect(lastKnob('release').formatValue(7)).toBe('7.0 · 50 ms')
    expect(lastKnob('release').formatValue(1)).toBe('1.0 · 1.10 s')
    await act(async () => { root.unmount() })
  })

  it('the ratio buttons send the engine index; ALL is index 4', async () => {
    const { setEffectParameter } = installXleth()
    const { FetCompPanel, useFetCompStore } = await loadPanel()
    const { container, root } = await mount(FetCompPanel, useFetCompStore)

    const ratio = ratioButtons(container)
    expect(ratio.map((b) => b.textContent)).toEqual(['4', '8', '12', '20', 'ALL'])
    expect(ratio[0].getAttribute('aria-checked')).toBe('true')
    expect(knobRenders.some((p) => p.paramId === 'ratio')).toBe(false)

    await act(async () => { ratio[3].click() })
    expect(setEffectParameter).toHaveBeenCalledWith(3, 11, 'ratio', 3)
    expect(ratioButtons(container)[3].getAttribute('aria-checked')).toBe('true')

    await act(async () => { ratioButtons(container)[4].click() })
    expect(setEffectParameter).toHaveBeenLastCalledWith(3, 11, 'ratio', 4)
    const checked = ratioButtons(container).filter((b) => b.getAttribute('aria-checked') === 'true')
    expect(checked.map((b) => b.textContent)).toEqual(['ALL'])
    await act(async () => { root.unmount() })
  })

  it('knob drags are rAF-coalesced; release commits exactly', async () => {
    const { setEffectParameter } = installXleth()
    const { FetCompPanel, useFetCompStore } = await loadPanel()
    const { root } = await mount(FetCompPanel, useFetCompStore)

    await act(async () => { lastKnob('input').onLiveChange(10) })
    await act(async () => { lastKnob('input').onLiveChange(12.5) })
    expect(setEffectParameter).not.toHaveBeenCalledWith(3, 11, 'input', expect.anything())
    await act(async () => { rafQueue.splice(0).forEach((cb) => cb(performance.now())) })
    const liveWrites = setEffectParameter.mock.calls.filter(([, , id]) => id === 'input')
    expect(liveWrites).toEqual([[3, 11, 'input', 12.5]])

    await act(async () => { lastKnob('input').onCommit(18) })
    expect(setEffectParameter).toHaveBeenLastCalledWith(3, 11, 'input', 18)
    expect(lastKnob('input').value).toBe(18)
    await act(async () => { root.unmount() })
  })

  it('hydrates from the engine, rounding the index param', async () => {
    installXleth({ input: 21, output: -6.5, attack: 6.2, release: 2, ratio: 3.9999999 })
    const { FetCompPanel, useFetCompStore } = await loadPanel()
    const { container, root } = await mount(FetCompPanel, useFetCompStore)
    await act(async () => {})

    expect(ratioButtons(container)[4].getAttribute('aria-checked')).toBe('true')
    expect(lastKnob('input').value).toBe(21)
    expect(lastKnob('output').value).toBe(-6.5)
    expect(lastKnob('attack').value).toBe(6.2)
    expect(lastKnob('release').value).toBe(2)
    await act(async () => { root.unmount() })
  })

  it('the gain-reduction meter reads slot 2', async () => {
    const { getEffectMeter } = installXleth()
    const { FetCompPanel, useFetCompStore } = await loadPanel()
    const { container, root } = await mount(FetCompPanel, useFetCompStore)
    const realNow = performance.now.bind(performance)
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + 1000)
    await act(async () => { rafQueue.splice(0).forEach((cb) => cb(0)) })
    await act(async () => {})
    expect(getEffectMeter).toHaveBeenCalledWith(3, 11)
    expect(container.querySelector('.fetcomp-gr-readout span').textContent).toBe('12.4')
    expect(container.querySelector('.fetcomp-gr-bar').style.width).toBe(`${(12.4 / 20) * 100}%`)
    vi.restoreAllMocks()
    await act(async () => { root.unmount() })
  })
})
