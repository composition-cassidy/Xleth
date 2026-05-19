import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadEffectChainPanelFixture() {
  const panelModule = await import('../EffectChainPanel.jsx')
  const { default: useEffectChainStore } = await import('../../../stores/effectChainStore.js')
  const effectModule = await import('../EffectModule.jsx')

  return {
    panelModule,
    EffectChainPanel: panelModule.default,
    EffectModule: effectModule.default,
    useEffectChainStore,
  }
}

describe('EffectChainPanel FX graph shell gating', () => {
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

  it('renders the chain empty state by default', async () => {
    const { EffectChainPanel, useEffectChainStore } = await loadEffectChainPanelFixture()
    useEffectChainStore.setState({ chains: { '7': [] } })

    const html = renderToStaticMarkup(<EffectChainPanel trackId={7} />)

    expect(html).toContain('effect-chain-mode-btn active')
    expect(html).toContain('No effects')
    expect(html).not.toContain('FX Graph Shell')
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
      { nodeId: 2, pluginId: 'third-party-delay', pluginName: 'Space Echo', position: 1 },
    ]

    const html = renderToStaticMarkup(
      <panelModule.EffectChainGraphShell
        chain={chain}
        chainLabel="Track effect chain"
      />
    )

    expect(html).toContain('FX Graph Shell')
    expect(html).toContain('Track Input')
    expect(html).toContain('Xleth EQ')
    expect(html).toContain('Space Echo')
    expect(html).toContain('Track Output')
    expect(html).not.toContain('+ Add effect')
    expect(html).not.toContain('effect-chain-add-btn')
    expect(html).not.toContain('effect-module-grip')
    expect(html).not.toContain('effect-module-bypass')
    expect(window.xleth.window.openNodeEditor).not.toHaveBeenCalled()
  })
})
