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

  it('exposes a graphShell panel branch with read-only preview copy', async () => {
    const { panelModule } = await loadEffectChainPanelFixture()
    const viewState = panelModule.getEffectChainPanelViewState('graphShell')
    const html = renderToStaticMarkup(
      <panelModule.EffectChainGraphShell chain={[]} chainLabel="Track effect chain" />
    )

    expect(viewState.showingGraphShell).toBe(true)
    expect(viewState.chainButtonDisabled).toBe(false)
    expect(viewState.nodeButtonDisabled).toBe(true)
    expect(html).toContain('FX Graph Shell')
    expect(html).toContain('Preview Only')
    expect(html).toContain('This read-only preview mirrors the current Mixer Chain order without mutating routing.')
    expect(html).toContain('Editable FX Graph conversion is not implemented yet.')
  })

  it('routes NODE through the graph shell helper instead of openNodeEditor', async () => {
    const { panelModule } = await loadEffectChainPanelFixture()
    const setFxPanelView = vi.fn()

    panelModule.showEffectChainGraphShell({ setFxPanelView, storeKey: '7' })

    expect(setFxPanelView).toHaveBeenCalledWith('7', 'graphShell')
    expect(window.xleth.window.openNodeEditor).not.toHaveBeenCalled()
    expect(panelModule.FX_GRAPH_SHELL_BUTTON_TITLE).not.toContain('Node Editor')
  })

  it('renders Track Input directly connected to Track Output for an empty graph shell preview', async () => {
    const { panelModule } = await loadEffectChainPanelFixture()
    const html = renderToStaticMarkup(
      <panelModule.EffectChainGraphShell chain={[]} chainLabel="Track effect chain" />
    )

    expect(html).toContain('Track Input')
    expect(html).toContain('Track Output')
    expect(html.match(/effect-chain-graph-connector/g)).toHaveLength(1)
    expect(html).not.toContain('effect-module')
    expect(html).not.toContain('effect-chain-add-btn')
    expect(html).not.toContain('effect-chain-empty-btn')
  })

  it('shows current chain slots in order in the read-only graph shell preview', async () => {
    const { panelModule } = await loadEffectChainPanelFixture()
    const chain = [
      { nodeId: 1, pluginId: 'xletheq', position: 0 },
      { nodeId: 2, pluginId: 'overdone', position: 1 },
      { nodeId: 3, pluginId: 'delay', position: 2 },
    ]
    const html = renderToStaticMarkup(
      <panelModule.EffectChainGraphShell chain={chain} chainLabel="Track effect chain" />
    )

    expect(html).toContain('Track Input')
    expect(html).toContain('Xleth EQ')
    expect(html).toContain('Overdone')
    expect(html).toContain('Delay')
    expect(html).toContain('Track Output')
    expect(html.indexOf('Track Input')).toBeLessThan(html.indexOf('Xleth EQ'))
    expect(html.indexOf('Xleth EQ')).toBeLessThan(html.indexOf('Overdone'))
    expect(html.indexOf('Overdone')).toBeLessThan(html.indexOf('Delay'))
    expect(html.indexOf('Delay')).toBeLessThan(html.indexOf('Track Output'))
    expect(html.match(/effect-chain-graph-connector/g)).toHaveLength(4)
  })

  it('keeps the graph shell preview free of chain editing affordances', async () => {
    const { panelModule } = await loadEffectChainPanelFixture()
    const chain = [
      { nodeId: 1, pluginId: 'xletheq', position: 0 },
      { nodeId: 2, pluginId: 'third-party-delay', position: 1 },
    ]
    const vstPlugins = [{ id: 'third-party-delay', name: 'Space Echo', vendor: 'Acme' }]

    const html = renderToStaticMarkup(
      <panelModule.EffectChainGraphShell
        chain={chain}
        chainLabel="Track effect chain"
        vstPlugins={vstPlugins}
      />
    )

    expect(html).toContain('FX Graph Shell')
    expect(html).toContain('Track Input')
    expect(html).toContain('Xleth EQ')
    expect(html).toContain('Space Echo')
    expect(html).toContain('Track Output')
    expect(html).not.toContain('+ Add effect')
    expect(html).not.toContain('effect-chain-add-btn')
    expect(html).not.toContain('effect-chain-overflow')
    expect(html).not.toContain('effect-module-grip')
    expect(html).not.toContain('effect-module-bypass')
    expect(html).not.toContain('Open plugin editor')
    expect(window.xleth.window.openNodeEditor).not.toHaveBeenCalled()
  })
})
