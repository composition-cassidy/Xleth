import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadEffectModuleFixture() {
  const effectModule = await import('../EffectModule.jsx')
  const { default: useVstStore } = await import('../../../stores/vstStore.js')
  return {
    effectModule,
    EffectModule: effectModule.default,
    useVstStore,
  }
}

function createEvent() {
  return {
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
  }
}

describe('EffectModule state badges, selection, and interaction guardrails', () => {
  beforeEach(() => {
    vi.resetModules()

    globalThis.window = {
      xleth: {
        audio: {
          getEffectChain: vi.fn(async () => '[]'),
          getMasterEffectChain: vi.fn(async () => '[]'),
          openPluginEditor: vi.fn(),
          resetCrashedPlugin: vi.fn(async () => true),
        },
        onGraphChanged: vi.fn(() => () => {}),
        onProjectLoaded: vi.fn(() => () => {}),
      },
    }
  })

  afterEach(() => {
    delete globalThis.window
  })

  it('renders a normal stock row without inline VST actions', async () => {
    const { EffectModule } = await loadEffectModuleFixture()

    const html = renderToStaticMarkup(
      <EffectModule
        effect={{ nodeId: 5, pluginId: 'compressor', position: 0, bypassed: false, missing: false, crashed: false }}
        index={0}
        storeKey="7"
        onDragStart={() => {}}
        onDragOver={() => {}}
        onSelect={() => {}}
      />
    )

    expect(html).toContain('Compressor')
    expect(html).not.toContain('MISSING')
    expect(html).not.toContain('CRASHED')
    expect(html).not.toContain('Edit')
    expect(html).not.toContain('Reset')
    expect(html).not.toContain('Remove')
  })

  it('renders bypassed rows with the bypassed class and enable title', async () => {
    const { EffectModule } = await loadEffectModuleFixture()

    const html = renderToStaticMarkup(
      <EffectModule
        effect={{ nodeId: 6, pluginId: 'compressor', position: 0, bypassed: true, missing: false, crashed: false }}
        index={0}
        storeKey="7"
        onDragStart={() => {}}
        onDragOver={() => {}}
        onSelect={() => {}}
      />
    )

    expect(html).toContain('effect-module--bypassed')
    expect(html).toContain('Enable effect')
  })

  it('renders a MISSING badge with inline Remove only', async () => {
    const { EffectModule, useVstStore } = await loadEffectModuleFixture()
    useVstStore.setState({
      plugins: [{ id: 'missing.vst3', name: 'Missing Plugin', vendor: 'Ghost Audio' }],
    })

    const html = renderToStaticMarkup(
      <EffectModule
        effect={{ nodeId: 11, pluginId: 'missing.vst3', position: 0, bypassed: false, missing: true, crashed: false }}
        index={0}
        storeKey="4"
        onDragStart={() => {}}
        onDragOver={() => {}}
        onSelect={() => {}}
      />
    )

    expect(html).toContain('MISSING')
    expect(html).toContain('Remove')
    expect(html).not.toContain('Edit')
    expect(html).not.toContain('Reset')
  })

  it('renders a CRASHED badge with Reset for crashed VST rows', async () => {
    const { EffectModule, useVstStore } = await loadEffectModuleFixture()
    useVstStore.setState({
      plugins: [{ id: 'crashed.vst3', name: 'Crash Synth', vendor: 'Broken Bits' }],
    })

    const html = renderToStaticMarkup(
      <EffectModule
        effect={{ nodeId: 21, pluginId: 'crashed.vst3', position: 0, bypassed: false, missing: false, crashed: true }}
        index={0}
        storeKey="2"
        onDragStart={() => {}}
        onDragOver={() => {}}
        onSelect={() => {}}
      />
    )

    expect(html).toContain('CRASHED')
    expect(html).toContain('Reset')
    expect(html).not.toContain('Edit')
  })

  it('keeps Edit for healthy VST rows', async () => {
    const { EffectModule, useVstStore } = await loadEffectModuleFixture()
    useVstStore.setState({
      plugins: [{ id: 'healthy.vst3', name: 'Healthy Plugin', vendor: 'Stable Audio' }],
    })

    const html = renderToStaticMarkup(
      <EffectModule
        effect={{ nodeId: 31, pluginId: 'healthy.vst3', position: 0, bypassed: false, missing: false, crashed: false }}
        index={0}
        storeKey="3"
        onDragStart={() => {}}
        onDragOver={() => {}}
        onSelect={() => {}}
      />
    )

    expect(html).toContain('Edit')
    expect(html).not.toContain('Reset')
    expect(html).not.toContain('MISSING')
    expect(html).not.toContain('CRASHED')
  })

  it('adds the selected row class when selected is true', async () => {
    const { EffectModule } = await loadEffectModuleFixture()

    const html = renderToStaticMarkup(
      <EffectModule
        effect={{ nodeId: 41, pluginId: 'compressor', position: 0, bypassed: false, missing: false, crashed: false }}
        index={0}
        storeKey="3"
        onDragStart={() => {}}
        onDragOver={() => {}}
        onSelect={() => {}}
        selected
      />
    )

    expect(html).toContain('effect-module--selected')
    expect(html).toContain('aria-selected="true"')
  })

  it('routes reset recovery through window.xleth.audio.resetCrashedPlugin', async () => {
    const { effectModule } = await loadEffectModuleFixture()
    const audio = {
      openPluginEditor: vi.fn(),
      resetCrashedPlugin: vi.fn(async () => true),
    }
    const fetchChain = vi.fn(async () => {})

    await effectModule.runEffectModuleInlineAction('reset', {
      audio,
      fetchChain,
      removeEffect: vi.fn(),
      storeKey: 'master',
      nodeId: 99,
    })

    expect(audio.resetCrashedPlugin).toHaveBeenCalledWith(-1, 99)
    expect(fetchChain).toHaveBeenCalledWith('master')
  })

  it('bypass helper stops propagation and never invokes stock editor opening', async () => {
    const { effectModule } = await loadEffectModuleFixture()
    const event = createEvent()
    const setBypass = vi.fn()
    const openSpy = vi.spyOn(effectModule, 'openStockEffectEditor')

    effectModule.handleEffectModuleBypassClick(event, {
      effect: { nodeId: 12, pluginId: 'compressor', bypassed: false },
      isPending: false,
      setBypass,
      storeKey: '9',
    })

    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(setBypass).toHaveBeenCalledWith('9', 12, true)
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('inline action helper stops propagation and never invokes stock editor opening', async () => {
    const { effectModule } = await loadEffectModuleFixture()
    const event = createEvent()
    const audio = { openPluginEditor: vi.fn() }
    const fetchChain = vi.fn()
    const removeEffect = vi.fn()
    const openSpy = vi.spyOn(effectModule, 'openStockEffectEditor')

    await effectModule.handleEffectModuleInlineActionClick(event, {
      audio,
      effect: { nodeId: 22, pluginId: 'healthy.vst3' },
      fetchChain,
      inlineAction: { action: 'edit', label: 'Edit' },
      isPending: false,
      removeEffect,
      storeKey: '5',
    })

    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(audio.openPluginEditor).toHaveBeenCalledWith(5, 22)
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('drag helper stops propagation, prevents default, and never invokes stock editor opening', async () => {
    const { effectModule } = await loadEffectModuleFixture()
    const event = createEvent()
    const onDragStart = vi.fn()
    const openSpy = vi.spyOn(effectModule, 'openStockEffectEditor')

    effectModule.handleEffectModuleGripMouseDown(event, {
      effect: { nodeId: 32, pluginId: 'compressor' },
      index: 3,
      isPending: false,
      onDragStart,
    })

    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(onDragStart).toHaveBeenCalledWith(32, 3, event)
    expect(openSpy).not.toHaveBeenCalled()
  })
})
