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

  it('keeps the graph shell free of chain editing affordances', async () => {
    const { panelModule } = await loadEffectChainPanelFixture()
    const html = renderToStaticMarkup(
      <panelModule.EffectChainGraphShell chainLabel="Track effect chain" />
    )

    expect(html).toContain('FX Graph Shell')
    expect(html).not.toContain('effect-module')
    expect(html).not.toContain('effect-chain-add-btn')
    expect(html).not.toContain('effect-module-grip')
    expect(html).not.toContain('effect-module-bypass')
    expect(window.xleth.window.openNodeEditor).not.toHaveBeenCalled()
  })
})
