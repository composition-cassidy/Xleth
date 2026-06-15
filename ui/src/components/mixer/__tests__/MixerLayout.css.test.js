import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readAppCss() {
  return readFileSync(path.resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
}

function cssRule(css, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`(?:^|\\n)${escapedSelector}\\s*{([\\s\\S]*?)}`))?.[1] ?? ''
}

describe('Mixer layout CSS', () => {
  it('keeps the track strip lane horizontally scrollable inside the fixed rack/master layout', () => {
    const tracksScrollRule = cssRule(readAppCss(), '.mixer-tracks-scroll')

    expect(tracksScrollRule).toMatch(/min-width:\s*0\s*;/)
    expect(tracksScrollRule).toMatch(/overflow-x:\s*auto\s*;/)
    expect(tracksScrollRule).toMatch(/overflow-y:\s*hidden\s*;/)
  })

  it('lets the selected effect rack list use vertical scrolling instead of row limits', () => {
    const css = readAppCss()
    const effectChainListRule = cssRule(css, '.effect-chain-list')
    const selectedRackListRule = cssRule(css, '.selected-effect-rack .effect-chain-list')

    expect(effectChainListRule).toMatch(/flex:\s*1\s*;/)
    expect(effectChainListRule).toMatch(/min-height:\s*0\s*;/)
    expect(effectChainListRule).toMatch(/overflow-y:\s*auto\s*;/)
    expect(selectedRackListRule).toMatch(/max-height:\s*none\s*;/)
  })

  it('embeds the VST browser inside Settings instead of positioning it as a floating panel', () => {
    const css = readAppCss()
    const embeddedBrowserRule = cssRule(css, '.vst-browser--embedded')
    const embeddedListRule = cssRule(css, '.vst-browser--embedded .vst-browser-list')

    expect(embeddedBrowserRule).toMatch(/position:\s*static\s*;/)
    expect(embeddedBrowserRule).toMatch(/width:\s*100%\s*;/)
    expect(embeddedListRule).toMatch(/max-height:\s*360px\s*;/)
  })
})
