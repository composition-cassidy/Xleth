import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readAppCss() {
  return readFileSync(path.resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
}

describe('Mixer layout CSS', () => {
  it('has no legacy mixer strip, rack or peak-meter rules left in app.css', () => {
    const css = readAppCss().replace(/\/\*[\s\S]*?\*\//g, '')

    expect(css).not.toMatch(/\.mixer-(strip|panel|tracks-scroll|folder|offset-column|channel-column)/)
    expect(css).not.toMatch(/\.selected-effect-rack/)
    expect(css).not.toMatch(/\.peak-meter/)
  })

  it('keeps the VST browser on the kit: no legacy vst-browser or scan-progress rules in app.css', () => {
    const css = readAppCss().replace(/\/\*[\s\S]*?\*\//g, '')

    expect(css).not.toMatch(/\.vst-browser/)
    expect(css).not.toMatch(/\.scan-progress/)
  })
})
