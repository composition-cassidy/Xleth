import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// The Preview's picture always scales to fit its panel and the placeholder only
// exists before the first frame (ui/DESIGN.md 8.1). Pinned as source contracts,
// because the failure modes are CSS: a canvas that sizes its box from its bitmap
// (so 25% render draws small) and a pseudo-element label that no state can hide.

const read = (rel) => readFileSync(path.resolve(process.cwd(), rel), 'utf8')

describe('Preview picture and placeholder', () => {
  const css = read('src/components/VideoPreview.module.css')
  const jsx = read('src/components/VideoPreview.jsx')

  it('takes the canvas out of flow and contains it, whatever the render resolution', () => {
    const canvas = css.slice(css.indexOf('.canvas {'), css.indexOf('}', css.indexOf('.canvas {')))
    expect(canvas).toMatch(/position:\s*absolute/)
    expect(canvas).toMatch(/inset:\s*0/)
    expect(canvas).toMatch(/object-fit:\s*contain/)
    expect(canvas).toMatch(/width:\s*100%/)
    expect(canvas).toMatch(/height:\s*100%/)
  })

  it('keeps the surround on the neutral ground', () => {
    expect(css).toMatch(/\.stage \{[^}]*background:\s*var\(--ui-g0\)/)
  })

  it('has no legacy PREVIEW pseudo-element, and the placeholder is a real element tied to hasFrame', () => {
    const app = read('src/styles/app.css')
    expect(app).not.toMatch(/content:\s*"PREVIEW"/)
    expect(app).not.toMatch(/\.video-canvas-wrapper/)
    expect(jsx).toMatch(/\{!hasFrame && \(/)
    expect(jsx).toMatch(/setHasFrame\(true\)/)
  })

  // Edit Grid mode (DESIGN.md 8.2): rails beside the picture, not rows above and
  // below it. The rows took 152px of a 346px panel and left black gutters.
  it('puts the track rail, the picture and the settings rail in one row, in that order', () => {
    const stage = jsx.slice(jsx.indexOf('<div className={styles.stage}'))
    const dock = stage.indexOf('<GridEditorDock />')
    const area = stage.indexOf('<div className={styles.area}')
    const toolbar = stage.indexOf('<GridEditToolbar />')
    expect(dock).toBeGreaterThan(-1)
    expect(dock).toBeLessThan(area)
    expect(area).toBeLessThan(toolbar)
    // Nothing between the header and the stage any more.
    expect(jsx.slice(0, jsx.indexOf('<div className={styles.stage}'))).not.toMatch(/<GridEditToolbar/)
  })

  it('lets the picture take the full height at the project aspect, and the rails the rest', () => {
    expect(css).toMatch(/\.stage\[data-grid-editing\] \{[^}]*flex-direction:\s*row/)
    expect(css).toMatch(/\.stage\[data-grid-editing\] \{[^}]*container:\s*pv-stage \/ size/)
    const area = css.slice(css.indexOf('.area[data-grid-editing] {'), css.indexOf('}', css.indexOf('.area[data-grid-editing] {')))
    expect(area).toMatch(/height:\s*100%/)
    expect(area).toMatch(/aspect-ratio:\s*var\(--xleth-canvas-aspect/)
    expect(area).toMatch(/max-width:\s*calc\(100cqw - 2 \* var\(--pv-rail-min\)\)/)
  })

  // A Preview too narrow for the rails (Compose docks it in a ~345px corner)
  // used to stack them above and below a postage-stamp picture, with the
  // settings rail cut off. Now the rails open in a flyout beside the panel.
  it('opens the rails in a flyout beside a narrow Preview instead of squeezing them in', () => {
    expect(jsx).toMatch(/GRID_RAILS_MIN_WIDTH = 560/)
    const flyout = jsx.slice(jsx.indexOf('<GridEditFlyout'))
    expect(flyout.indexOf('<GridEditorDock />')).toBeGreaterThan(-1)
    expect(flyout.indexOf('<GridEditorDock />')).toBeLessThan(flyout.indexOf('<GridEditToolbar />'))
    expect(jsx).toMatch(/railsInStage && <GridEditorDock \/>/)
    expect(jsx).toMatch(/railsInStage && <GridEditToolbar \/>/)
    // No narrow band layout left for the rails to fall into.
    expect(css).not.toMatch(/@container pv-root/)
    expect(read('src/components/GridEditorDock.module.css')).not.toMatch(/@container pv-root/)
    expect(read('src/components/grid/GridEditToolbar.module.css')).not.toMatch(/@container pv-root/)
  })

  it('portals the header controls into a floating Preview titlebar slot', () => {
    expect(jsx).toMatch(/headerSlot \? createPortal\(header, headerSlot\) : header/)
    const panel = read('src/windowing/panels/PreviewPanel.tsx')
    expect(panel).toMatch(/titlebarContentFill=\{titled\}/)
    expect(panel).toMatch(/headerSlot=\{titled \? slot : null\}/)
  })

  it('draws the placeholder in sentence case at a readable size', () => {
    const block = css.slice(css.indexOf('.placeholder {'), css.indexOf('}', css.indexOf('.placeholder {')))
    expect(block).toMatch(/font-size:\s*var\(--type-12\)/)
    expect(block).not.toMatch(/uppercase|letter-spacing/)
  })
})
