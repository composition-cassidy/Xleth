/**
 * @vitest-environment jsdom
 *
 * VariMuCompPanel contract tests.
 *
 *  1. The two knobs ARE XlethVariMuCompressorEffect::createLayout()'s input /
 *     output, with the engine's ranges and defaults, and each opts into
 *     automation (paramId + automationTarget). There is no threshold knob.
 *  2. TIME CONSTANT sends the engine's position 1..6 (default 2) and shows the
 *     original manual's figures; 5 and 6 are marked automatic.
 *  3. MODE sends the engine index (Linked 0, Mid/Side 1) and is labelled
 *     Mid/Side — never the disputed Lat/Vert. Neither switch is automatable.
 *  4. Hydration reads the engine's values back, rounding the index params.
 *  5. The meter reads slot 2 Linked, and slots 4/5 as M and S in Mid/Side.
 *
 * PluginUIKitKnob is stubbed (it draws into a <canvas> jsdom lacks), which is
 * also what makes its props observable.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mirrored from XlethVariMuCompressorEffect::createLayout(). [id, min, max, default]
const KNOBS = [
  ['input',  -24, 36, 0],
  ['output', -24, 24, 0],
]

const knobRenders = []

async function loadPanel() {
  vi.doMock('../../../plugin-ui/runtime/components/PluginUIKitKnob.jsx', () => ({
    default: (props) => {
      knobRenders.push(props)
      return <div data-testid={`knob-${props.paramId ?? 'unbound'}`} />
    },
  }))
  const mod = await import('../VariMuCompPanel.jsx')
  const { default: useVariMuCompStore } = await import('../../../stores/variMuCompStore.js')
  return { VariMuCompPanel: mod.default, useVariMuCompStore }
}

function installXleth(params = {}, meters = [0, 0, 12.4, 0, 7.5, 2.25, 0, 0]) {
  const setEffectParameter = vi.fn(() => true)
  const getEffectParameters = vi.fn(async () => JSON.stringify(
    Object.entries(params).map(([id, value]) => ({ id, value })),
  ))
  const getEffectMeter = vi.fn(async () => JSON.stringify(meters))
  window.xleth = { audio: { setEffectParameter, getEffectParameters, getEffectMeter } }
  return { setEffectParameter, getEffectParameters, getEffectMeter }
}

async function mount(VariMuCompPanel, useVariMuCompStore) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { useVariMuCompStore.getState().open(3, 11, '3') })
  await act(async () => { root.render(<VariMuCompPanel />) })
  return { container, root }
}

const group = (container, label) => {
  const g = container.querySelector(`[role="radiogroup"][aria-label="${label}"]`)
  return g ? [...g.querySelectorAll('button')] : []
}

const lastKnob = (id) => knobRenders.filter((p) => p.paramId === id).at(-1)

async function pumpMeter(rafQueue) {
  const realNow = performance.now.bind(performance)
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + 1000)
  await act(async () => { rafQueue.splice(0).forEach((cb) => cb(0)) })
  await act(async () => {})
  spy.mockRestore()
}

describe('VariMuCompPanel', () => {
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
    const { VariMuCompPanel, useVariMuCompStore } = await loadPanel()
    useVariMuCompStore.getState().close()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<VariMuCompPanel />) })
    expect(container.querySelector('.varimu-panel')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('knobs mirror the engine layout, opt into automation, and there is no threshold', async () => {
    installXleth()
    const { VariMuCompPanel, useVariMuCompStore } = await loadPanel()
    const { container, root } = await mount(VariMuCompPanel, useVariMuCompStore)

    const byId = new Map(knobRenders.map((p) => [p.paramId, p]))
    expect([...byId.keys()].sort()).toEqual(KNOBS.map(([id]) => id).sort())
    for (const [id, min, max, def] of KNOBS) {
      const k = byId.get(id)
      expect(k.min, `${id}.min`).toBe(min)
      expect(k.max, `${id}.max`).toBe(max)
      expect(k.defaultValue, `${id}.default`).toBe(def)
      expect(k.automationTarget).toEqual({ trackId: 3, nodeId: 11, storeKey: '3' })
    }
    expect(container.textContent.toUpperCase()).not.toContain('THRESHOLD')
    await act(async () => { root.unmount() })
  })

  it('TIME CONSTANT sends positions 1..6 and shows the manual figures; 5 and 6 are automatic', async () => {
    const { setEffectParameter } = installXleth()
    const { VariMuCompPanel, useVariMuCompStore } = await loadPanel()
    const { container, root } = await mount(VariMuCompPanel, useVariMuCompStore)

    const tc = group(container, 'Time Constant')
    expect(tc.map((b) => b.textContent)).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(tc[1].getAttribute('aria-checked')).toBe('true')                  // default position 2
    expect(tc.filter((b) => b.classList.contains('auto')).map((b) => b.textContent)).toEqual(['5', '6'])
    expect(container.querySelector('.varimu-tc-readout').textContent).toBe('ATTACK 0.2 ms · RELEASE 0.8 s')
    expect(knobRenders.some((p) => p.paramId === 'time_constant')).toBe(false)

    await act(async () => { tc[5].click() })
    expect(setEffectParameter).toHaveBeenLastCalledWith(3, 11, 'time_constant', 6)
    expect(container.querySelector('.varimu-tc-readout').textContent)
      .toBe('ATTACK 0.2 ms · RELEASE AUTO 0.3 s · 10 s · 25 s')
    await act(async () => { root.unmount() })
  })

  it('MODE is Linked | Mid/Side (never Lat/Vert) and sends the engine index', async () => {
    const { setEffectParameter } = installXleth()
    const { VariMuCompPanel, useVariMuCompStore } = await loadPanel()
    const { container, root } = await mount(VariMuCompPanel, useVariMuCompStore)

    const mode = group(container, 'Mode')
    expect(mode.map((b) => b.textContent)).toEqual(['LINKED', 'MID/SIDE'])
    expect(container.textContent.toUpperCase()).not.toMatch(/\bLAT\b|\bVERT\b|LATERAL|VERTICAL/)
    expect(mode[0].getAttribute('aria-checked')).toBe('true')

    await act(async () => { mode[1].click() })
    expect(setEffectParameter).toHaveBeenLastCalledWith(3, 11, 'mode', 1)
    expect(group(container, 'Mode')[1].getAttribute('aria-checked')).toBe('true')
    await act(async () => { root.unmount() })
  })

  it('knob drags are rAF-coalesced; release commits exactly', async () => {
    const { setEffectParameter } = installXleth()
    const { VariMuCompPanel, useVariMuCompStore } = await loadPanel()
    const { root } = await mount(VariMuCompPanel, useVariMuCompStore)

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

  it('hydrates from the engine, rounding the index params', async () => {
    installXleth({ input: 21, output: -6.5, time_constant: 4.9999999, mode: 0.9999999 })
    const { VariMuCompPanel, useVariMuCompStore } = await loadPanel()
    const { container, root } = await mount(VariMuCompPanel, useVariMuCompStore)
    await act(async () => {})

    expect(group(container, 'Time Constant')[4].getAttribute('aria-checked')).toBe('true')
    expect(group(container, 'Mode')[1].getAttribute('aria-checked')).toBe('true')
    expect(lastKnob('input').value).toBe(21)
    expect(lastKnob('output').value).toBe(-6.5)
    await act(async () => { root.unmount() })
  })

  it('Linked: one GR bar from slot 2', async () => {
    const { getEffectMeter } = installXleth()
    const { VariMuCompPanel, useVariMuCompStore } = await loadPanel()
    const { container, root } = await mount(VariMuCompPanel, useVariMuCompStore)
    await pumpMeter(rafQueue)
    expect(getEffectMeter).toHaveBeenCalledWith(3, 11)
    const bars = container.querySelectorAll('.varimu-gr-bar')
    expect(bars).toHaveLength(1)
    expect(container.querySelector('.varimu-gr-readout span').textContent).toBe('12.4')
    expect(bars[0].style.width).toBe(`${(12.4 / 20) * 100}%`)
    await act(async () => { root.unmount() })
  })

  it('Mid/Side: M and S bars from slots 4 and 5', async () => {
    installXleth({ mode: 1 })
    const { VariMuCompPanel, useVariMuCompStore } = await loadPanel()
    const { container, root } = await mount(VariMuCompPanel, useVariMuCompStore)
    await act(async () => {})
    await pumpMeter(rafQueue)
    expect([...container.querySelectorAll('.varimu-gr-channel')].map((e) => e.textContent)).toEqual(['M', 'S'])
    const readouts = [...container.querySelectorAll('.varimu-gr-readout span')].map((e) => e.textContent)
    expect(readouts).toEqual(['7.5', '2.3'])
    await act(async () => { root.unmount() })
  })
})
