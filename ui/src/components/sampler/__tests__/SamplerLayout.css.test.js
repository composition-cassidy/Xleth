import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readUiSource(relativePath) {
  return readFileSync(path.resolve(process.cwd(), 'src', relativePath), 'utf8')
}

function readAppCss() {
  return readUiSource('styles/app.css')
}

function cssRule(css, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...css.matchAll(new RegExp(`(?:^|\\n)${escapedSelector}\\s*{([\\s\\S]*?)}`, 'g'))]
  return matches.at(-1)?.[1] ?? ''
}

describe('Sampler layout CSS', () => {
  it('uses the mockup hierarchy with live metadata and no undefined Turn control', () => {
    const source = readUiSource('components/sampler/SamplerPanelContent.jsx')

    expect(source).toContain('className="sampler-panel-body"')
    expect(source).toContain('className="sampler-waveform-meta"')
    expect(source).toContain('className="sampler-identity-row"')
    expect(source).toContain('sampler-range-card--trim')
    expect(source).toContain('sampler-range-card--loop')
    expect(source).toContain('className="sampler-process-row"')
    expect(source).toContain('sampler-voice-panel')
    expect(source).toContain('sampler-lfo-module')
    expect(source).toContain('responsive')
    expect(source).not.toContain('sampler-panel-region-label')
    expect(source).not.toContain("|| region?.name")
    expect(source).not.toContain('>Turn<')
  })

  it('applies the flat mockup palette and window controls only to the Sampler', () => {
    const css = readAppCss()
    const frameRule = cssRule(css, '.xleth-panel-frame[data-panel-id="sampler"]')
    const titlebarRule = cssRule(css, '.xleth-windowing-titlebar[data-panel-id="sampler"]')
    const controlsRule = cssRule(css, '.xleth-windowing-titlebar[data-panel-id="sampler"] .xleth-windowing-control-button')

    expect(frameRule).toContain('--sampler-s0: var(--theme-bg-inset)')
    expect(frameRule).toContain('--sampler-accent: var(--theme-accent)')
    expect(frameRule).toContain('--sampler-loop: var(--theme-warning)')
    expect(titlebarRule).toMatch(/background:\s*var\(--xleth-flat-chrome\)/)
    expect(controlsRule).toMatch(/border-radius:\s*0/)
    expect(controlsRule).toMatch(/background:\s*transparent/)
  })

  it('keeps the Sampler content edge-to-edge while the body owns scrolling', () => {
    const css = readAppCss()
    const bodyRule = cssRule(css, '.sampler-panel-body')
    const scrollRule = cssRule(css, '.sampler-panel-scroll')
    const tabbarRule = cssRule(css, '.sampler-panel-tabbar')

    expect(bodyRule).toMatch(/flex:\s*1 1 auto\s*;/)
    expect(bodyRule).toMatch(/margin:\s*0\s*;/)
    expect(bodyRule).toMatch(/overflow:\s*hidden\s*;/)
    expect(scrollRule).toMatch(/overflow:\s*auto\s*;/)
    expect(tabbarRule).toMatch(/height:\s*34px/)
    expect(tabbarRule).toMatch(/background:\s*var\(--sampler-s3\)/)
  })

  it('keeps the existing rotary knob appearance contract intact', () => {
    const samplerSource = readUiSource('components/sampler/SamplerPanelContent.jsx')
    const lfoSource = readUiSource('components/sampler/LfoSection.jsx')

    for (const source of [samplerSource, lfoSource]) {
      expect(source).toContain('SAMPLER_KNOB_APPEARANCE')
      expect(source).toContain("tickStyle: 'none'")
      expect(source).toContain("glyph: 'rotary-arrow'")
      expect(source).toContain('<SamplerKnob')
    }

    expect(samplerSource).toContain('accentGlow: false')
    expect(lfoSource).toContain('accentGlow: true')
  })

  it('uses container-responsive wrapping at the retained default panel size', () => {
    const css = readAppCss()
    const waveformSource = readUiSource('components/sampler/SamplerWaveform.jsx')

    expect(css).toContain('@container (max-width: 820px)')
    expect(css).toContain('@container (max-width: 560px)')
    expect(cssRule(css, '.sampler-panel-body')).toMatch(/container-type:\s*inline-size/)
    expect(cssRule(css, '.sampler-waveform-well')).toMatch(/overflow:\s*hidden/)
    expect(waveformSource).toContain('new ResizeObserver')
    expect(waveformSource).toContain('responsiveWidth')
  })
})
