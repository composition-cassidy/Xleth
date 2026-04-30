import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import Knob from '../../../components/sampler/Knob.jsx'
import { validate } from '../../schema/validate.js'
import { SHIPPED_LAYOUTS } from '../../layouts/index.js'
import { COMPRESSOR_MANIFEST } from '../../manifests/compressor.js'
import { PluginUIContext } from '../PluginUIContext.js'
import KnobNode from '../components/KnobNode.jsx'
import PluginUIKitKnob, {
  buildPluginKnobRenderModel,
  resolveSizePreset,
} from '../components/PluginUIKitKnob.jsx'

describe('Visual-B plugin UI knob runtime appearance', () => {
  it('normalizes missing appearance to xleth-default', () => {
    const model = buildPluginKnobRenderModel(undefined)

    expect(model.appearance.preset).toBe('xleth-default')
    expect(model.className).toContain('pluginui-knob--xleth-default')
    expect(model.knobTokens.accentCssVar).toBe('--theme-accent')
  })

  it('known studio-ring preset produces source-controlled classes and token CSS vars', () => {
    const model = buildPluginKnobRenderModel({
      preset: 'studio-ring',
      surfaceToken: 'surface.controlRaised',
      accentToken: 'accent.focus',
      textToken: 'text.muted',
    })

    expect(model.appearance.preset).toBe('studio-ring')
    expect(model.className).toContain('pluginui-knob--studio-ring')
    expect(model.style['--pluginui-knob-surface']).toBe('var(--theme-bg-elevated)')
    expect(model.style['--pluginui-knob-accent']).toBe('var(--theme-border-focus)')
    expect(model.style['--pluginui-knob-text']).toBe('var(--theme-text-muted)')
  })

  it('unknown presets and token ids fall back safely at runtime', () => {
    const model = buildPluginKnobRenderModel({
      preset: 'unknown-preset',
      accentToken: 'accent.future',
    })

    expect(model.appearance.preset).toBe('xleth-default')
    expect(model.knobTokens.accentCssVar).toBe('--theme-accent')
  })

  it('renders PluginUIKitKnob with known preset classes', () => {
    const html = renderToStaticMarkup(
      <PluginUIKitKnob
        value={0}
        min={-1}
        max={1}
        defaultValue={0}
        label="Gain"
        formatValue={value => `${value}`}
        onLiveChange={() => {}}
        onCommit={() => {}}
        appearance={{ preset: 'studio-ring' }}
      />,
    )

    expect(html).toContain('pluginui-knob--studio-ring')
    expect(html).toContain('data-appearance-preset="studio-ring"')
  })

  it('KnobNode ignores raw props.color and does not forward it into runtime markup', () => {
    const node = {
      id: 'k-test',
      type: 'knob',
      props: {
        param: 'threshold',
        label: 'THRESH',
        color: '#ff006a',
        appearance: { preset: 'flat-minimal' },
      },
    }

    const html = renderToStaticMarkup(
      <PluginUIContext.Provider value={buildPluginContext()}>
        <KnobNode node={node} />
      </PluginUIContext.Provider>,
    )

    expect(html).toContain('pluginui-knob--flat-minimal')
    expect(html).not.toContain('#ff006a')
  })

  it('existing Compressor layout without appearance still validates and renders a default knob', () => {
    const result = validate(cloneCompressorLayout(), COMPRESSOR_MANIFEST)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])

    const threshold = findNode(result.doc, 'k-threshold')
    const html = renderToStaticMarkup(
      <PluginUIContext.Provider value={buildPluginContext()}>
        <KnobNode node={threshold} />
      </PluginUIContext.Provider>,
    )

    expect(html).toContain('pluginui-knob--xleth-default')
  })

  it('resolveSizePreset maps compact / standard / large to distinct pixel sizes', () => {
    const compact = resolveSizePreset('compact', 52)
    const standard = resolveSizePreset('standard', 52)
    const large = resolveSizePreset('large', 52)

    expect(compact).toBe(40)
    expect(standard).toBe(52)
    expect(large).toBe(64)
    expect(compact).toBeLessThan(standard)
    expect(standard).toBeLessThan(large)
  })

  it('resolveSizePreset returns baseSizeProp for inherit and unrecognized values', () => {
    expect(resolveSizePreset('inherit', 52)).toBe(52)
    expect(resolveSizePreset(undefined, 52)).toBe(52)
    expect(resolveSizePreset(null, 52)).toBe(52)
    expect(resolveSizePreset('inherit', 40)).toBe(40)
    expect(resolveSizePreset(undefined, 64)).toBe(64)
  })

  it('buildPluginKnobRenderModel returns effectiveSize based on sizePreset', () => {
    const compact = buildPluginKnobRenderModel({ preset: 'studio-ring', sizePreset: 'compact' }, 52)
    const standard = buildPluginKnobRenderModel({ preset: 'studio-ring', sizePreset: 'standard' }, 52)
    const large = buildPluginKnobRenderModel({ preset: 'studio-ring', sizePreset: 'large' }, 52)
    const inherit = buildPluginKnobRenderModel({ preset: 'studio-ring', sizePreset: 'inherit' }, 60)

    expect(compact.effectiveSize).toBe(40)
    expect(standard.effectiveSize).toBe(52)
    expect(large.effectiveSize).toBe(64)
    expect(inherit.effectiveSize).toBe(60)
  })

  it('buildPluginKnobRenderModel effectiveSize passes through baseSizeProp when sizePreset is inherit', () => {
    const model = buildPluginKnobRenderModel({ preset: 'xleth-default' }, 48)
    expect(model.effectiveSize).toBe(48)
  })

  it('xleth-default explicit appearance routes to appearance rendering class', () => {
    const html = renderToStaticMarkup(
      <PluginUIKitKnob
        value={0}
        min={0}
        max={1}
        defaultValue={0}
        label="Test"
        formatValue={v => `${v}`}
        onLiveChange={() => {}}
        onCommit={() => {}}
        appearance={{ preset: 'xleth-default' }}
      />,
    )

    expect(html).toContain('pluginui-knob--xleth-default')
    expect(html).toContain('data-appearance-preset="xleth-default"')
  })

  it('valueReadout hidden suppresses the readout text in SSR', () => {
    const html = renderToStaticMarkup(
      <PluginUIKitKnob
        value={0.5}
        min={0}
        max={1}
        defaultValue={0}
        label="Test"
        formatValue={() => 'READOUT-TEXT'}
        onLiveChange={() => {}}
        onCommit={() => {}}
        appearance={{ preset: 'studio-ring', valueReadout: 'hidden' }}
      />,
    )

    expect(html).not.toContain('READOUT-TEXT')
  })

  it('valueReadout below shows the readout text in SSR', () => {
    const html = renderToStaticMarkup(
      <PluginUIKitKnob
        value={0.5}
        min={0}
        max={1}
        defaultValue={0}
        label="Test"
        formatValue={() => 'READOUT-VISIBLE'}
        onLiveChange={() => {}}
        onCommit={() => {}}
        appearance={{ preset: 'studio-ring', valueReadout: 'below' }}
      />,
    )

    expect(html).toContain('READOUT-VISIBLE')
  })

  it('labelPlacement hidden suppresses the label text in SSR', () => {
    const html = renderToStaticMarkup(
      <PluginUIKitKnob
        value={0.5}
        min={0}
        max={1}
        defaultValue={0}
        label="LABEL-HIDDEN-TEST"
        formatValue={v => `${v}`}
        onLiveChange={() => {}}
        onCommit={() => {}}
        appearance={{ preset: 'studio-ring', labelPlacement: 'hidden' }}
      />,
    )

    expect(html).not.toContain('LABEL-HIDDEN-TEST')
  })

  it('labelPlacement left produces row flex direction in SSR', () => {
    const html = renderToStaticMarkup(
      <PluginUIKitKnob
        value={0.5}
        min={0}
        max={1}
        defaultValue={0}
        label="LABEL-LEFT"
        formatValue={v => `${v}`}
        onLiveChange={() => {}}
        onCommit={() => {}}
        appearance={{ preset: 'studio-ring', labelPlacement: 'left' }}
      />,
    )

    expect(html).toContain('flex-direction:row')
    expect(html).toContain('LABEL-LEFT')
  })

  it('ring none / pointer none / ticks none are preserved in render model', () => {
    const model = buildPluginKnobRenderModel({
      preset: 'studio-ring',
      ring: 'none',
      pointer: 'none',
      ticks: 'none',
    })

    expect(model.appearance.ring).toBe('none')
    expect(model.appearance.pointer).toBe('none')
    expect(model.appearance.ticks).toBe('none')
  })

  it('shared Knob legacy usage still renders without appearance props', () => {
    const html = renderToStaticMarkup(
      <Knob
        value={0.5}
        min={0}
        max={1}
        defaultValue={0}
        label="Legacy"
        color="#abc"
        onLiveChange={() => {}}
        onCommit={() => {}}
      />,
    )

    expect(html).toContain('Legacy')
    expect(html).toContain('<canvas')
  })
})

function buildPluginContext() {
  return {
    target: { trackId: 1, nodeId: 2 },
    manifest: COMPRESSOR_MANIFEST,
    params: { threshold: -20 },
    setParam: vi.fn(),
    meterBus: null,
    onClose: null,
    layoutErrors: [],
  }
}

function cloneCompressorLayout() {
  return JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.compressor))
}

function findNode(layoutOrNode, nodeId) {
  const node = layoutOrNode.root || layoutOrNode
  if (node.id === nodeId) return node
  for (const child of node.children || []) {
    const found = findNode(child, nodeId)
    if (found) return found
  }
  return null
}
