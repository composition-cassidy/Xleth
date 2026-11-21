import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import PreviewHeader, { pickedResolution, rendererLabel, POSTER_CHIP_HINT } from '../PreviewHeader.jsx'

const base = {
  fps: 30,
  mode: 'webgl',
  outputDims: { w: 960, h: 540 },
  resolutionScale: 1,
  autoResolution: true,
  onResolutionChange: () => {},
  effectsBypass: false,
  onEffectsToggle: () => {},
  posterMode: false,
  onPosterToggle: () => {},
  gridEditMode: false,
  onGridEditChange: () => {},
  importing: false,
  onImport: () => {},
}

const render = (props = {}) => renderToStaticMarkup(<PreviewHeader {...base} {...props} />)

describe('Preview header', () => {
  it('at rest shows View, FX, Edit grid and Import, and no timecode or state chips', () => {
    const html = render()
    expect(html).not.toContain('data-testid="preview-timecode"')
    expect(html).toContain('>View<')
    expect(html).toContain('>FX<')
    expect(html).toContain('Edit grid')
    expect(html).toContain('Import')
    expect(html).not.toContain('Poster')
    expect(html).not.toMatch(/FPS/)
  })

  it('labels the grid toggle "Edit" with the grid glyph after it, so it reads "Edit grid"', () => {
    const html = render()
    const toggle = html.slice(html.indexOf('aria-label="Edit grid"'))
    const label = toggle.indexOf('>Edit<')
    const glyph = toggle.indexOf('<svg')
    expect(label).toBeGreaterThan(-1)
    expect(glyph).toBeGreaterThan(label)
  })

  it('drops its own row chrome when it sits in a floating titlebar', () => {
    expect(render({ inTitlebar: true })).toContain('data-in-titlebar="true"')
    expect(render()).not.toContain('data-in-titlebar')
  })

  it('shows the Poster state as a neutral chip with its explanation, only while Poster is on', () => {
    const html = render({ posterMode: true })
    expect(html).toContain('Poster')
    expect(html).toContain('data-hint="Poster frames')
    expect(POSTER_CHIP_HINT).toMatch(/Exports are always full-fidelity/)
  })

  it('has no Preview ≠ Render badge, no caps renderer chip and no resolution select', () => {
    const html = render({ posterMode: true })
    expect(html).not.toContain('≠')
    expect(html).not.toMatch(/WEBGL|webgl/)
    expect(html).not.toContain('<select')
  })

  it('names a renderer fallback as a chip and says it in words', () => {
    expect(render({ mode: 'canvas2d' })).toContain('Canvas 2D')
    expect(render({ mode: 'init' })).not.toContain('Starting')
    expect(rendererLabel('webgl')).toBe('WebGL')
  })

  it('maps the resolution state onto the menu choice', () => {
    expect(pickedResolution(true, 0.5)).toBe('auto')
    expect(pickedResolution(false, 1)).toBe('1.0')
    expect(pickedResolution(false, 0.25)).toBe('0.25')
  })
})
