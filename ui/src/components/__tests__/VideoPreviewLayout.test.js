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

  it('draws the placeholder in sentence case at a readable size', () => {
    const block = css.slice(css.indexOf('.placeholder {'), css.indexOf('}', css.indexOf('.placeholder {')))
    expect(block).toMatch(/font-size:\s*var\(--type-12\)/)
    expect(block).not.toMatch(/uppercase|letter-spacing/)
  })
})
