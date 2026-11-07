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
  it('has no legacy mixer strip, rack or peak-meter rules left in app.css', () => {
    const css = readAppCss().replace(/\/\*[\s\S]*?\*\//g, '')

    expect(css).not.toMatch(/\.mixer-(strip|panel|tracks-scroll|folder|offset-column|channel-column)/)
    expect(css).not.toMatch(/\.selected-effect-rack/)
    expect(css).not.toMatch(/\.peak-meter/)
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
