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

  it('reserves one equal 28px folder lane across every mixer column', () => {
    const css = readAppCss()
    const spacerRule = cssRule(css, '.mixer-folder-spacer,\n.mixer-folder-header')
    const folderStripsRule = cssRule(css, '.mixer-folder-strips')
    const offsetColumnRule = cssRule(css, '.mixer-folder-group,\n.mixer-channel-column,\n.mixer-offset-column')

    expect(spacerRule).toMatch(/height:\s*28px\s*;/)
    expect(spacerRule).toMatch(/min-height:\s*28px\s*;/)
    expect(folderStripsRule).toMatch(/flex:\s*1\s*;/)
    expect(offsetColumnRule).toMatch(/flex-direction:\s*column\s*;/)
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

  it('switches short mixer panels to a side-by-side compact control layout', () => {
    const css = readAppCss()
    const mixerPanelRule = cssRule(css, '.mixer-panel')
    const compactBlock = css.match(/@container mixer-panel \(max-height:\s*360px\)\s*{([\s\S]*?)\n}/)?.[1] ?? ''

    expect(mixerPanelRule).toMatch(/container-name:\s*mixer-panel\s*;/)
    expect(mixerPanelRule).toMatch(/container-type:\s*size\s*;/)
    expect(compactBlock).toMatch(/\.mixer-strip-bottom\s*{[\s\S]*?flex-direction:\s*row\s*;/)
    expect(compactBlock).toMatch(/\.mixer-strip-fader-area\s*{[\s\S]*?min-height:\s*56px\s*;/)
    expect(compactBlock).toMatch(/\.mixer-strip-knobs\s*{[\s\S]*?width:\s*36px\s*;/)
  })
})
