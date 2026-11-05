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

  it('steps the strip through height tiers so a short panel never clips or overlaps', () => {
    const css = readAppCss()
    const mixerPanelRule = cssRule(css, '.mixer-panel')
    const tier = (px) => css.match(
      new RegExp(String.raw`@container mixer-panel \(max-height:\s*${px}px\)\s*\{([\s\S]*?)\n\}`),
    )?.[1] ?? ''

    expect(mixerPanelRule).toMatch(/container-name:\s*mixer-panel\s*;/)
    expect(mixerPanelRule).toMatch(/container-type:\s*size\s*;/)

    // Tier 1: the PAN/WIDTH pair goes side by side, still below the fader.
    expect(tier(430)).toMatch(/\.mixer-strip-knobs\s*{[\s\S]*?flex-direction:\s*row\s*;/)

    // Tier 2: density pass only — it must NOT rearrange anything, or the two
    // concerns (arrangement, density) stop being independently tunable.
    expect(tier(360)).toMatch(/\.mixer-strip-fader-area\s*{[\s\S]*?min-height:\s*56px\s*;/)
    expect(tier(360)).not.toMatch(/flex-direction:/)

    // Tier 3: the knob pair moves out of the stack, beside the meter/fader.
    expect(tier(296)).toMatch(/\.mixer-strip-bottom\s*{[\s\S]*?flex-direction:\s*row\s*;/)
    expect(tier(296)).toMatch(/\.mixer-strip-knobs\s*{[\s\S]*?flex-direction:\s*column\s*;/)
    expect(tier(296)).toMatch(/\.mixer-strip-knobs\s*{[\s\S]*?width:\s*40px\s*;/)

    // Tier 4: dropping the knob captions is what keeps the centred knob column
    // from overflowing its row and painting over M/S/V and the output select.
    expect(tier(216)).toMatch(/\.mixer-knob-label\s*{[\s\S]*?display:\s*none\s*;/)

    // Tiers are additive, so they have to stay in descending order.
    const order = [430, 360, 296, 216].map(px => css.indexOf(`@container mixer-panel (max-height: ${px}px)`))
    expect(order.every(i => i > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('does not reserve strip height for an empty output-routing chip row', () => {
    const css = readAppCss()

    expect(cssRule(css, '.mixer-route-badges:empty')).toMatch(/min-height:\s*0\s*;/)
  })

})
