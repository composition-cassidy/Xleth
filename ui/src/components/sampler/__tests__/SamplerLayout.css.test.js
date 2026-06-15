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
  return css.match(new RegExp(`(?:^|\\n)${escapedSelector}\\s*{([\\s\\S]*?)}`))?.[1] ?? ''
}

describe('Sampler layout CSS', () => {
  it('uses a flush panel body instead of the old inner sampler window shell', () => {
    const source = readUiSource('components/sampler/SamplerPanelContent.jsx')

    expect(source).toContain('className="sampler-panel-body"')
    expect(source).toContain('className="sampler-panel-tabbar"')
    expect(source).toContain('className="sampler-panel-scroll"')
    expect(source).toContain('className="sampler-panel-content"')
    expect(source).not.toContain('Xleth Sampler')
    expect(source).not.toMatch(/margin:\s*12/)
  })

  it('scopes the mixer-like chrome treatment to the Sampler panel', () => {
    const css = readAppCss()
    const frameRule = cssRule(css, '.xleth-panel-frame[data-panel-id="sampler"]')
    const titlebarRule = cssRule(css, '.xleth-windowing-titlebar[data-panel-id="sampler"]')
    const controlsRule = cssRule(css, '.xleth-windowing-titlebar[data-panel-id="sampler"] .xleth-windowing-control-button')

    expect(frameRule).toMatch(/border-color:\s*color-mix\(in srgb,\s*var\(--xleth-windowing-panel-color\)/)
    expect(frameRule).toMatch(/box-shadow:/)
    expect(titlebarRule).toMatch(/border-bottom:\s*1px solid color-mix\(in srgb,\s*var\(--xleth-windowing-panel-color\)/)
    expect(controlsRule).toMatch(/inset 0 1px 0 rgba\(255,\s*255,\s*255,\s*0\.12\)/)
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
    expect(tabbarRule).toMatch(/border-bottom:\s*1px solid color-mix\(in srgb,\s*var\(--sampler-accent\)/)
  })

  it('ports the Mixer rotary knob appearance to the active Sampler controls', () => {
    const samplerSource = readUiSource('components/sampler/SamplerPanelContent.jsx')
    const lfoSource = readUiSource('components/sampler/LfoSection.jsx')

    for (const source of [samplerSource, lfoSource]) {
      expect(source).toContain('SAMPLER_KNOB_APPEARANCE')
      expect(source).toContain("tickStyle: 'none'")
      expect(source).toContain("glyph: 'rotary-arrow'")
      expect(source).toContain('accentGlow: true')
      expect(source).toContain('<SamplerKnob')
    }
  })
})
