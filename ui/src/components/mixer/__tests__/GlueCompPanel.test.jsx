/**
 * @vitest-environment jsdom
 *
 * GlueCompPanel contract tests.
 *
 *  1. The continuous knobs ARE XlethGlueCompressorEffect::createLayout()'s
 *     threshold / makeup / sc_hpf_freq, with the engine's ranges and defaults,
 *     and each opts into automation (paramId + automationTarget).
 *  2. The stepped switches send the engine INDEX (ratio 10:1 → 2, release
 *     AUTO → 4, topology FF → 1) and carry no automation binding.
 *  3. Hydration reads the engine's values back, rounding index params.
 *
 * PluginUIKitKnob is stubbed (it draws into a <canvas> jsdom lacks), which is
 * also what makes its props observable.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mirrored from XlethGlueCompressorEffect::createLayout(). [id, min, max, default]
const KNOBS = [
  ['threshold',   -40, 0,   -10],
  ['makeup',      -10, 20,  0],
  ['sc_hpf_freq', 20,  500, 100],
]

const knobRenders = []

async function loadPanel() {
  vi.doMock('../../../plugin-ui/runtime/components/PluginUIKitKnob.jsx', () => ({
    default: (props) => {
      knobRenders.push(props)
      return <div data-testid={`knob-${props.paramId ?? 'unbound'}`} />
    },
  }))
  const { default: GlueCompPanel } = await import('../GlueCompPanel.jsx')
  const { default: useGlueCompStore } = await import('../../../stores/glueCompStore.js')
  return { GlueCompPanel, useGlueCompStore }
}

function installXleth(params = {}) {
  const setEffectParameter = vi.fn(() => true)
  const getEffectParameters = vi.fn(async () => JSON.stringify(
    Object.entries(params).map(([id, value]) => ({ id, value })),
  ))
  const getEffectMeter = vi.fn(async () => JSON.stringify([0, 0, 3.5, 0, 0, 0, 0, 0]))
  window.xleth = { audio: { setEffectParameter, getEffectParameters, getEffectMeter } }
  return { setEffectParameter, getEffectParameters, getEffectMeter }
}

async function mount(GlueCompPanel, useGlueCompStore) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { useGlueCompStore.getState().open(2, 9, '2') })
  await act(async () => { root.render(<GlueCompPanel />) })
  return { container, root }
}

function buttonsIn(container, groupLabel) {
  const group = container.querySelector(`[role="radiogroup"][aria-label="${groupLabel}"]`)
  return group ? [...group.querySelectorAll('button')] : []
}

describe('GlueCompPanel', () => {
  beforeEach(() => {
    vi.resetModules()
    knobRenders.length = 0
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    window.innerWidth = 1600
    window.innerHeight = 900
    window.requestAnimationFrame = () => 1
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
    const { GlueCompPanel, useGlueCompStore } = await loadPanel()
    useGlueCompStore.getState().close()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<GlueCompPanel />) })
    expect(container.querySelector('.gluecomp-panel')).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('knobs mirror the engine layout and opt into automation', async () => {
    installXleth()
    const { GlueCompPanel, useGlueCompStore } = await loadPanel()
    const { root } = await mount(GlueCompPanel, useGlueCompStore)

    const byId = new Map(knobRenders.map((p) => [p.paramId, p]))
    expect([...byId.keys()].sort()).toEqual(KNOBS.map(([id]) => id).sort())
    for (const [id, min, max, def] of KNOBS) {
      const k = byId.get(id)
      expect(k.min, `${id}.min`).toBe(min)
      expect(k.max, `${id}.max`).toBe(max)
      expect(k.defaultValue, `${id}.default`).toBe(def)
      expect(k.automationTarget).toEqual({ trackId: 2, nodeId: 9, storeKey: '2' })
    }
    await act(async () => { root.unmount() })
  })

  it('stepped switches send engine indices', async () => {
    const { setEffectParameter } = installXleth()
    const { GlueCompPanel, useGlueCompStore } = await loadPanel()
    const { container, root } = await mount(GlueCompPanel, useGlueCompStore)

    const ratio = buttonsIn(container, 'Ratio')
    const attack = buttonsIn(container, 'Attack')
    const release = buttonsIn(container, 'Release')
    const topology = buttonsIn(container, 'Topology')
    expect(ratio.map((b) => b.textContent)).toEqual(['2', '4', '10'])
    expect(attack.map((b) => b.textContent)).toEqual(['.1', '.3', '1', '3', '10', '30'])
    expect(release.map((b) => b.textContent)).toEqual(['.1', '.3', '.6', '1.2', 'AUTO'])
    expect(topology.map((b) => b.textContent)).toEqual(['CLASSIC', 'FF'])

    await act(async () => { ratio[2].click() })
    await act(async () => { attack[0].click() })
    await act(async () => { release[4].click() })
    await act(async () => { topology[1].click() })
    expect(setEffectParameter).toHaveBeenCalledWith(2, 9, 'ratio', 2)
    expect(setEffectParameter).toHaveBeenCalledWith(2, 9, 'attack', 0)
    expect(setEffectParameter).toHaveBeenCalledWith(2, 9, 'release', 4)
    expect(setEffectParameter).toHaveBeenCalledWith(2, 9, 'topology', 1)
    expect(ratio[2].getAttribute('aria-checked')).toBe('true')
    await act(async () => { root.unmount() })
  })

  it('hydrates from the engine, rounding index params', async () => {
    installXleth({ threshold: -22.5, ratio: 2.0000001, release: 1, color: 0, sc_hpf_on: 1 })
    const { GlueCompPanel, useGlueCompStore } = await loadPanel()
    const { container, root } = await mount(GlueCompPanel, useGlueCompStore)
    await act(async () => {})

    expect(buttonsIn(container, 'Ratio')[2].getAttribute('aria-checked')).toBe('true')
    expect(buttonsIn(container, 'Release')[1].getAttribute('aria-checked')).toBe('true')
    const color = [...container.querySelectorAll('button')].find((b) => b.textContent === 'COLOR')
    const hpf = [...container.querySelectorAll('button')].find((b) => b.textContent === 'S/C HPF')
    expect(color.getAttribute('aria-pressed')).toBe('false')
    expect(hpf.getAttribute('aria-pressed')).toBe('true')
    const thr = knobRenders.filter((p) => p.paramId === 'threshold').at(-1)
    expect(thr.value).toBe(-22.5)
    await act(async () => { root.unmount() })
  })
})
