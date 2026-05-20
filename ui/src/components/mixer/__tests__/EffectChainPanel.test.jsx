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

  it('keeps stale graphShell view state from replacing the editable Mixer Chain', async () => {
    const { panelModule } = await loadEffectChainPanelFixture()
    const viewState = panelModule.getEffectChainPanelViewState('graphShell')
    const html = renderToStaticMarkup(
      <panelModule.EffectChainGraphShell chainLabel="Track effect chain" />
    )

    expect(viewState.showingGraphShell).toBe(false)
    expect(viewState.chainButtonClassName).toContain('active')
    expect(viewState.chainButtonDisabled).toBe(false)
    expect(viewState.nodeButtonDisabled).toBe(false)
    expect(html).toContain('FX Graph')
    expect(html).toContain('Workspace Ready')
    expect(html).toContain('Open FX Graph workspace')
    expect(html).not.toContain('Track Input')
    expect(html).not.toContain('effect-chain-graph-preview')
    expect(html).not.toContain('effect-chain-graph-connector')
  })

  it('routes NODE through the fxGraph windowing panel instead of openNodeEditor', async () => {
    const { panelModule, useEffectChainStore } = await loadEffectChainPanelFixture()
    const setFxPanelView = vi.fn()
    const panelRegistry = { openPanel: vi.fn() }
    useEffectChainStore.setState({ fxModes: { '7': 'chain' } })

    panelModule.showEffectChainGraphShell({ setFxPanelView, storeKey: '7', panelRegistry })

    expect(panelRegistry.openPanel).toHaveBeenCalledWith('fxGraph')
    expect(setFxPanelView).not.toHaveBeenCalled()
    expect(useEffectChainStore.getState().fxModes['7']).toBe('chain')
    expect(window.xleth.window.openNodeEditor).not.toHaveBeenCalled()
    expect(panelModule.FX_GRAPH_SHELL_BUTTON_TITLE).not.toContain('Node Editor')
  })

  it('renders the editable chain when fxMode is chain even after graphShell view state exists', async () => {
    const { EffectChainPanel, useEffectChainStore, useVstStore } = await loadEffectChainPanelFixture()
    useEffectChainStore.setState({
      chains: { '7': [] },
      fxModes: { '7': 'chain' },
      fxPanelViews: { '7': 'graphShell' },
    })
    useVstStore.setState({ plugins: [] })

    const html = renderToStaticMarkup(<EffectChainPanel trackId={7} />)

    expect(html).toContain('+ Add effect')
    expect(html).toContain('effect-chain-mode-btn active')
    expect(html).not.toContain('effect-chain-shell')
    expect(html).not.toContain('Workspace Ready')
    expect(useEffectChainStore.getState().fxModes['7']).toBe('chain')
  })

  it('keeps the graph shell status free of graph preview and chain editing affordances', async () => {
    const { panelModule } = await loadEffectChainPanelFixture()
    const chain = [
      { nodeId: 1, pluginId: 'xletheq', position: 0 },
      { nodeId: 2, pluginId: 'third-party-delay', position: 1 },
    ]

    const html = renderToStaticMarkup(
      <panelModule.EffectChainGraphShell chain={chain} chainLabel="Track effect chain" />
    )

    expect(html).toContain('FX Graph')
    expect(html).toContain('Open FX Graph workspace')
    expect(html).not.toContain('Track Input')
    expect(html).not.toContain('Track Output')
    expect(html).not.toContain('Xleth EQ')
    expect(html).not.toContain('Space Echo')
    expect(html).not.toContain('effect-chain-graph-preview')
    expect(html).not.toContain('+ Add effect')
    expect(html).not.toContain('effect-chain-add-btn')
    expect(html).not.toContain('effect-chain-overflow')
    expect(html).not.toContain('effect-module-grip')
    expect(html).not.toContain('effect-module-bypass')
    expect(html).not.toContain('Open plugin editor')
    expect(window.xleth.window.openNodeEditor).not.toHaveBeenCalled()
  })

  it('resolves fxMode graph to locked status instead of editable chain state', async () => {
    const { panelModule } = await loadEffectChainPanelFixture()
    const viewState = panelModule.getEffectChainPanelViewState('chain', 'graph')
    const html = renderToStaticMarkup(
      <panelModule.EffectChainGraphShell active chainLabel="Track effect chain" />
    )

    expect(viewState.graphModeActive).toBe(true)
    expect(viewState.showingGraphShell).toBe(false)
    expect(viewState.chainButtonDisabled).toBe(true)
    expect(viewState.nodeButtonDisabled).toBe(false)
    expect(html).toContain('FX Graph Active')
    expect(html).toContain('Chain Locked')
    expect(html).toContain('Mixer Chain slot editing is locked')
    expect(html).not.toContain('effect-module')
    expect(html).not.toContain('effect-chain-add-btn')
    expect(html).not.toContain('effect-chain-graph-preview')
  })

  it('renders locked status-only mixer chain after fxMode switches to graph', async () => {
    const { EffectChainPanel, useEffectChainStore, useVstStore } = await loadEffectChainPanelFixture()
    useEffectChainStore.setState({
      chains: {
        '7': [
          { nodeId: 44, pluginId: 'compressor', position: 0, bypassed: false },
        ],
      },
      fxModes: { '7': 'chain' },
    })
    useVstStore.setState({ plugins: [] })

    useEffectChainStore.getState().setFxMode('7', 'graph')
    const html = renderToStaticMarkup(<EffectChainPanel trackId={7} />)

    expect(html).toContain('FX Graph Active')
    expect(html).toContain('Chain Locked')
    expect(html).toContain('Mixer Chain slot editing is locked')
    expect(html).toContain('Open FX Graph workspace')
    expect(html).toContain('effect-chain-mode-btn active')
    expect(html).not.toContain('+ Add effect')
    expect(html).not.toContain('effect-chain-add-btn')
    expect(html).not.toContain('effect-module')
    expect(html).not.toContain('effect-chain-graph-preview')
    expect(window.xleth.window.openNodeEditor).not.toHaveBeenCalled()
  })

  it('keeps NODE focused on the safe fxGraph workspace while graph mode is active', async () => {
    const { panelModule } = await loadEffectChainPanelFixture()
    const panelRegistry = { openPanel: vi.fn() }

    panelModule.showEffectChainGraphShell({ panelRegistry })

    expect(panelRegistry.openPanel).toHaveBeenCalledWith('fxGraph')
    expect(window.xleth.window.openNodeEditor).not.toHaveBeenCalled()
  })
})
