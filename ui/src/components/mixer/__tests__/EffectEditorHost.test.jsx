import React from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// These tests pin down the editor *ownership* contract that fixes the
// floating-Mixer containment bug:
//
//   - Stock effect editors are rendered by the global EffectEditorHost, NOT by
//     the Mixer panel. A floating PanelFrame uses `transform: translate3d(...)`,
//     which would make a `position: fixed` editor mounted inside it clip to the
//     Mixer's box. Hosting editors outside every PanelFrame keeps them free.
//   - The Mixer Chain and FX Graph only *request* an editor through the effect
//     store's open(trackId, engineNodeId, storeKey); identity is preserved.
//
// NOTE: zustand v5 uses getInitialState() as its server snapshot, so
// renderToStaticMarkup never reflects setState() updates. We therefore assert
// ownership against the React element tree / module graph rather than rendered
// HTML, and assert identity against the store's getState().

const here = dirname(fileURLToPath(import.meta.url))
const MIXER_DIR = resolve(here, '..')

// Collect the component types that a hookless component mounts in its own JSX,
// descending only through host (string-typed) elements — never into nested
// component instances. This reveals which editors a host *owns*.
function collectOwnedComponents(children, acc = []) {
  React.Children.forEach(children, (child) => {
    if (!child || typeof child !== 'object') return
    acc.push(child.type)
    if (typeof child.type === 'string' && child.props?.children) {
      collectOwnedComponents(child.props.children, acc)
    }
  })
  return acc
}

function installWindow() {
  globalThis.window = {
    innerWidth: 1600,
    innerHeight: 900,
    xleth: {
      audio: {
        eqGetBands: vi.fn(async () => '[]'),
        eqGetGlobalParams: vi.fn(async () => '{}'),
        getSampleRate: vi.fn(async () => 44100),
        eqGetSampleRate: vi.fn(async () => 44100),
        getEffectMeter: vi.fn(async () => '[0,0]'),
        openPluginEditor: vi.fn(),
      },
    },
  }
}

describe('EffectEditorHost ownership contract', () => {
  beforeEach(() => {
    vi.resetModules()
    installWindow()
  })

  afterEach(() => {
    delete globalThis.window
  })

  it('mounts every stock effect editor (including Parametric EQ) at the global host', async () => {
    const { default: EffectEditorHost } = await import('../EffectEditorHost.jsx')
    const { default: EqPanel } = await import('../EqPanel.jsx')
    const { default: CompressorPanel } = await import('../CompressorPanel.jsx')
    const { default: ResonanceSuppressorPanel } = await import('../ResonanceSuppressorPanel.jsx')

    const tree = EffectEditorHost() // hookless — safe to invoke directly
    expect(tree.props.className).toBe('effect-editor-host')

    const owned = collectOwnedComponents(tree.props.children)
    // 14 stock editors, all real function components, hosted globally.
    expect(owned).toHaveLength(14)
    expect(owned.every((type) => typeof type === 'function')).toBe(true)
    expect(owned).toContain(EqPanel)
    expect(owned).toContain(CompressorPanel)
    expect(owned).toContain(ResonanceSuppressorPanel)
  })

  it('does NOT mount any stock editor inside the Mixer panel (anti-nesting guard)', () => {
    // The Mixer must not own editor DOM: if it did, a floating Mixer's transform
    // would clip the editor. Guard against any editor panel being re-introduced
    // into the Mixer panel's module/JSX.
    const mixerSource = readFileSync(resolve(MIXER_DIR, 'MixerPanel.jsx'), 'utf8')
    const editorPanels = [
      'EqPanel',
      'CompressorPanel',
      'LimiterPanel',
      'DistortionPanel',
      'WaveshaperPanel',
      'DelayPanel',
      'ChorusPanel',
      'FlangerPanel',
      'PhaserPanel',
      'OTTPanel',
      'ReverbPanel',
      'TransientProcPanel',
      'SmartBalancePanel',
      'ResonanceSuppressorPanel',
    ]
    for (const panel of editorPanels) {
      // No import of, and no JSX element for, any stock editor panel.
      expect(mixerSource).not.toMatch(new RegExp(`import\\s+${panel}\\b`))
      expect(mixerSource).not.toMatch(new RegExp(`<${panel}\\b`))
    }

    // ...and they all live in the global host instead.
    const hostSource = readFileSync(resolve(MIXER_DIR, 'EffectEditorHost.jsx'), 'utf8')
    for (const panel of editorPanels) {
      expect(hostSource).toMatch(new RegExp(`<${panel}\\b`))
    }
  })

  it('Mixer Chain edit path opens the stock editor with the chain slot identity', async () => {
    const { default: useEqStore } = await import('../../../stores/eqStore.js')
    const { openStockEffectEditor } = await import('../EffectModule.jsx')

    const opened = openStockEffectEditor(
      { nodeId: 4, pluginId: 'xletheq', missing: false },
      '7',
    )

    expect(opened).toBe(true)
    expect(useEqStore.getState().target).toEqual({ trackId: 7, nodeId: 4, storeKey: '7' })
  })

  it('FX Graph edit path opens the SAME stock editor addressed by resolved engine node id', async () => {
    const { default: useEqStore } = await import('../../../stores/eqStore.js')
    const { openEffectEditorByEngineNode } = await import('../effectEditorOpeners.js')

    // FX Graph resolves graph node -> effectInstanceId -> engine nodeId, then
    // opens through the shared opener with the ENGINE node id (never a graph id).
    const result = openEffectEditorByEngineNode({
      pluginId: 'xletheq',
      engineNodeId: 12,
      storeKey: '3',
      audio: window.xleth.audio,
    })

    expect(result).toEqual({ ok: true, kind: 'stock' })
    expect(useEqStore.getState().target).toEqual({ trackId: 3, nodeId: 12, storeKey: '3' })
  })

  it('FX Graph edit path refuses to open when the engine node is unresolved', async () => {
    const { openEffectEditorByEngineNode } = await import('../effectEditorOpeners.js')

    const result = openEffectEditorByEngineNode({
      pluginId: 'xletheq',
      engineNodeId: -1,
      storeKey: '3',
      audio: window.xleth.audio,
    })

    expect(result).toEqual({ ok: false, reason: 'engine_node_unresolved' })
  })
})
