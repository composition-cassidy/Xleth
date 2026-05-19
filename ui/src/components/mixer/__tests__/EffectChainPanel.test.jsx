import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadEffectChainPanelFixture() {
  const panelModule = await import('../EffectChainPanel.jsx')
  const { default: useEffectChainStore } = await import('../../../stores/effectChainStore.js')
  const { default: useMixerStore } = await import('../../../stores/mixerStore.js')
  const { default: useVstStore } = await import('../../../stores/vstStore.js')
  const effectModule = await import('../EffectModule.jsx')

  return {
    panelModule,
    EffectChainPanel: panelModule.default,
    EffectModule: effectModule.default,
    useEffectChainStore,
    useMixerStore,
    useVstStore,
  }
}

describe('EffectChainPanel compact rack rendering', () => {
  beforeEach(() => {
    vi.resetModules()

    globalThis.window = {
      xleth: {
        audio: {
          getEffectChain: vi.fn(async () => '[]'),
          getMasterEffectChain: vi.fn(async () => '[]'),
        },
        window: {
          openNodeEditor: vi.fn(),
        },
        onGraphChanged: vi.fn(() => () => {}),
        onProjectLoaded: vi.fn(() => () => {}),
      },
    }
  })

  afterEach(() => {
    delete globalThis.window
  })

  it('renders the compact empty state when the chain has no effects', async () => {
    const { EffectChainPanel, useEffectChainStore, useMixerStore, useVstStore } = await loadEffectChainPanelFixture()
    useEffectChainStore.setState({ chains: { '7': [] } })
    useVstStore.setState({ plugins: [] })

    const html = renderToStaticMarkup(<EffectChainPanel trackId={7} />)

    expect(html).toContain('effect-chain-mode-btn active')
    expect(html).toContain('effect-chain-empty-btn')
    expect(html).toContain('+ Add effect')
    expect(html).not.toContain('FX Graph Shell')
  })

  it('marks overflow as visible when the chain exceeds the 4-row rack limit', async () => {
    const { panelModule } = await loadEffectChainPanelFixture()

    expect(panelModule.VISIBLE_LIMIT).toBe(4)
    expect(panelModule.shouldShowEffectChainOverflow(4)).toBe(false)
    expect(panelModule.shouldShowEffectChainOverflow(5)).toBe(true)
  })

  it('selected-row class can be derived from the exported selection helper for a real nodeId', async () => {
    const { panelModule, EffectModule, useVstStore } = await loadEffectChainPanelFixture()
    useVstStore.setState({ plugins: [] })
    const effect = {
      nodeId: 44,
      pluginId: 'compressor',
      position: 0,
      bypassed: false,
      missing: false,
      crashed: false,
    }
    const selectedNodeId = panelModule.selectEffectChainNode(effect)

    const html = renderToStaticMarkup(
      <EffectModule
        effect={effect}
        index={0}
        storeKey="7"
        onDragStart={() => {}}
        onDragOver={() => {}}
        onSelect={() => {}}
        selected={selectedNodeId === effect.nodeId}
      />
    )

    expect(selectedNodeId).toBe(44)
    expect(html).toContain('effect-module--selected')
  })

  it('pending placeholder rows are rejected by the exported selection helper', async () => {
    const { panelModule } = await loadEffectChainPanelFixture()

    expect(panelModule.selectEffectChainNode({ nodeId: -1, pluginId: 'delay' }, 123)).toBe(123)
    expect(panelModule.syncSelectedEffectChainNode(123, [{ nodeId: -1, pluginId: 'delay' }])).toBeNull()
  })

  it('exposes a graphShell panel branch with inert shell copy', async () => {
    const { panelModule } = await loadEffectChainPanelFixture()
    const viewState = panelModule.getEffectChainPanelViewState('graphShell')
    const html = renderToStaticMarkup(
      <panelModule.EffectChainGraphShell chainLabel="Track effect chain" />
    )

    expect(viewState.showingGraphShell).toBe(true)
    expect(viewState.chainButtonDisabled).toBe(false)
    expect(viewState.nodeButtonDisabled).toBe(true)
    expect(html).toContain('FX Graph Shell')
    expect(html).toContain('Graph editing and chain-to-graph conversion are not implemented yet.')
    expect(html).toContain('This panel is a preview gate only. The track still uses the normal Mixer Chain.')
  })

  it('routes NODE through the graph shell helper instead of openNodeEditor', async () => {
    const { panelModule } = await loadEffectChainPanelFixture()
    const setFxPanelView = vi.fn()

    panelModule.showEffectChainGraphShell({ setFxPanelView, storeKey: '7' })

    expect(setFxPanelView).toHaveBeenCalledWith('7', 'graphShell')
    expect(window.xleth.window.openNodeEditor).not.toHaveBeenCalled()
    expect(panelModule.FX_GRAPH_SHELL_BUTTON_TITLE).not.toContain('Node Editor')
  })
})
