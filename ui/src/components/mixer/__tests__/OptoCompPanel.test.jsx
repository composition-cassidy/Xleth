/**
 * @vitest-environment jsdom
 *
 * OptoCompPanel contract tests.
 *
 *  1. The two knobs ARE XlethOptoCompressorEffect::createLayout()'s gain /
 *     peak_reduction, with the engine's ranges and defaults, and each opts
 *     into automation (paramId + automationTarget).
 *  2. The Limit/Compress switch sends the engine INDEX (Compress 0, Limit 1)
 *     and carries no automation binding.
 *  3. Hydration reads the engine's values back, rounding the index param.
 *  4. The gain-reduction meter reads slot 2.
 *
 * PluginUIKitKnob is stubbed (it draws into a <canvas> jsdom lacks), which is
 * also what makes its props observable.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mirrored from XlethOptoCompressorEffect::createLayout(). [id, min, max, default]
const KNOBS = [
  ['gain',           0, 40, 0],
  ['peak_reduction', 0, 40, 20],
]

const knobRenders = []

async function loadPanel() {
  vi.doMock('../../../plugin-ui/runtime/components/PluginUIKitKnob.jsx', () => ({
    default: (props) => {
      knobRenders.push(props)
      return <div data-testid={`knob-${props.paramId ?? 'unbound'}`} />
    },
  }))
  const { default: OptoCompPanel } = await import('../OptoCompPanel.jsx')
  const { default: useOptoCompStore } = await import('../../../stores/optoCompStore.js')
  return { OptoCompPanel, useOptoCompStore }
}

function installXleth(params = {}, meters = [0, 0, 7.25, 0, 0, 0, 0, 0]) {
  const setEffectParameter = vi.fn(() => true)
  const getEffectParameters = vi.fn(async () => JSON.stringify(
    Object.entries(params).map(([id, value]) => ({ id, value })),
  ))
  const getEffectMeter = vi.fn(async () => JSON.stringify(meters))
  window.xleth = { audio: { setEffectParameter, getEffectParameters, getEffectMeter } }
  return { setEffectParameter, getEffectParameters, getEffectMeter }
}

async function mount(OptoCompPanel, useOptoCompStore) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { useOptoCompStore.getState().open(3, 11, '3') })
  await act(async () => { root.render(<OptoCompPanel />) })
  return { container, root }
}

function modeButtons(container) {
  const group = container.querySelector('[role="radiogroup"][aria-label="Limit/Compress"]')
  return group ? [...group.querySelectorAll('button')] : []
}

describe('OptoCompPanel', () => {
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
    const { OptoCompPanel, useOptoCompStore } = await loadPanel()
    useOptoCompStore.getState().close()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<OptoCompPanel />) })
    expect(container.querySelector('.optocomp-panel')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('knobs mirror the engine layout and opt into automation', async () => {
    installXleth()
    const { OptoCompPanel, useOptoCompStore } = await loadPanel()
    const { root } = await mount(OptoCompPanel, useOptoCompStore)

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

  it('the Limit/Compress switch sends the engine index', async () => {
    const { setEffectParameter } = installXleth()
    const { OptoCompPanel, useOptoCompStore } = await loadPanel()
    const { container, root } = await mount(OptoCompPanel, useOptoCompStore)

    const mode = modeButtons(container)
    expect(mode.map((b) => b.textContent)).toEqual(['COMPRESS', 'LIMIT'])
    expect(mode[0].getAttribute('aria-checked')).toBe('true')

    await act(async () => { mode[1].click() })
    expect(setEffectParameter).toHaveBeenCalledWith(3, 11, 'mode', 1)
    expect(modeButtons(container)[1].getAttribute('aria-checked')).toBe('true')

    await act(async () => { modeButtons(container)[0].click() })
    expect(setEffectParameter).toHaveBeenCalledWith(3, 11, 'mode', 0)
    await act(async () => { root.unmount() })
  })

  it('knob drags are rAF-coalesced; release commits exactly', async () => {
    const { setEffectParameter } = installXleth()
    const { OptoCompPanel, useOptoCompStore } = await loadPanel()
    const { root } = await mount(OptoCompPanel, useOptoCompStore)
    const pr = () => knobRenders.filter((p) => p.paramId === 'peak_reduction').at(-1)

    await act(async () => { pr().onLiveChange(25) })
    await act(async () => { pr().onLiveChange(27.5) })
    expect(setEffectParameter).not.toHaveBeenCalledWith(3, 11, 'peak_reduction', expect.anything())
    await act(async () => { rafQueue.splice(0).forEach((cb) => cb(performance.now())) })
    const liveWrites = setEffectParameter.mock.calls.filter(([, , id]) => id === 'peak_reduction')
    expect(liveWrites).toEqual([[3, 11, 'peak_reduction', 27.5]])

    await act(async () => { pr().onCommit(30) })
    expect(setEffectParameter).toHaveBeenLastCalledWith(3, 11, 'peak_reduction', 30)
    expect(pr().value).toBe(30)
    await act(async () => { root.unmount() })
  })

  it('hydrates from the engine, rounding the index param', async () => {
    installXleth({ gain: 12.5, peak_reduction: 33, mode: 0.9999999 })
    const { OptoCompPanel, useOptoCompStore } = await loadPanel()
    const { container, root } = await mount(OptoCompPanel, useOptoCompStore)
    await act(async () => {})

    expect(modeButtons(container)[1].getAttribute('aria-checked')).toBe('true')
    expect(knobRenders.filter((p) => p.paramId === 'gain').at(-1).value).toBe(12.5)
    expect(knobRenders.filter((p) => p.paramId === 'peak_reduction').at(-1).value).toBe(33)
    await act(async () => { root.unmount() })
  })

  it('the gain-reduction meter reads slot 2', async () => {
    const { getEffectMeter } = installXleth()
    const { OptoCompPanel, useOptoCompStore } = await loadPanel()
    const { container, root } = await mount(OptoCompPanel, useOptoCompStore)
    const realNow = performance.now.bind(performance)
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + 1000)
    await act(async () => { rafQueue.splice(0).forEach((cb) => cb(0)) })
    await act(async () => {})
    expect(getEffectMeter).toHaveBeenCalledWith(3, 11)
    const readout = container.querySelector('.optocomp-gr-readout span')
    expect(readout.textContent).toBe('7.3')
    expect(container.querySelector('.optocomp-gr-bar').style.width).toBe(`${(7.25 / 20) * 100}%`)
    vi.restoreAllMocks()
    await act(async () => { root.unmount() })
  })
})
