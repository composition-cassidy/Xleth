import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { applyFrameStyle } from '../freeformGeometry.js'
import FreeformLayerNode from '../components/FreeformLayerNode.jsx'
import DecorTextNode     from '../components/DecorTextNode.jsx'
import DecorLineNode     from '../components/DecorLineNode.jsx'
import DecorShapeNode    from '../components/DecorShapeNode.jsx'
import DecalNode         from '../components/DecalNode.jsx'

// ── applyFrameStyle ───────────────────────────────────────────────────────────

describe('applyFrameStyle', () => {
  it('returns absolute position with correct pixel strings', () => {
    const style = applyFrameStyle({ x: 10, y: 20, widthPx: 100, heightPx: 40 })
    expect(style.position).toBe('absolute')
    expect(style.left).toBe('10px')
    expect(style.top).toBe('20px')
    expect(style.width).toBe('100px')
    expect(style.height).toBe('40px')
  })

  it('omits transform when rotationDeg is 0', () => {
    const style = applyFrameStyle({ x: 0, y: 0, widthPx: 50, heightPx: 50, rotationDeg: 0 })
    expect(style.transform).toBeUndefined()
    expect(style.transformOrigin).toBeUndefined()
  })

  it('omits transform when rotationDeg is absent', () => {
    const style = applyFrameStyle({ x: 0, y: 0, widthPx: 50, heightPx: 50 })
    expect(style.transform).toBeUndefined()
  })

  it('includes rotate transform when rotationDeg is non-zero', () => {
    const style = applyFrameStyle({ x: 0, y: 0, widthPx: 50, heightPx: 50, rotationDeg: 45 })
    expect(style.transform).toBe('rotate(45deg)')
    expect(style.transformOrigin).toBe('50% 50%')
  })

  it('handles negative rotation', () => {
    const style = applyFrameStyle({ x: 0, y: 0, widthPx: 50, heightPx: 50, rotationDeg: -90 })
    expect(style.transform).toBe('rotate(-90deg)')
  })

  it('handles negative x/y (off-canvas)', () => {
    const style = applyFrameStyle({ x: -20, y: -5, widthPx: 80, heightPx: 30 })
    expect(style.left).toBe('-20px')
    expect(style.top).toBe('-5px')
  })

  it('returns safe fallback for null/undefined input', () => {
    const style = applyFrameStyle(null)
    expect(style.position).toBe('absolute')
  })

  it('zIndex is included', () => {
    const style = applyFrameStyle({ x: 0, y: 0, widthPx: 10, heightPx: 10, zIndex: 5 })
    expect(style.zIndex).toBe(5)
  })

  it('produces no NaN or undefined in numeric fields', () => {
    const style = applyFrameStyle({ x: 0, y: 0, widthPx: 64, heightPx: 64 })
    for (const val of [style.left, style.top, style.width, style.height]) {
      expect(val).not.toMatch(/NaN|undefined/)
    }
  })
})

// ── FreeformLayerNode ─────────────────────────────────────────────────────────

describe('FreeformLayerNode', () => {
  it('renders a relative-positioned container', () => {
    const node = {
      id:       'ff-1',
      type:     'freeformLayer',
      style:    { widthPx: 300, heightPx: 100 },
      props:    { clip: 'panel' },
      children: [],
    }
    const html = renderToStaticMarkup(<FreeformLayerNode node={node} />)
    expect(html).toContain('pluginui-freeform')
    expect(html).toContain('data-pluginui-id="ff-1"')
  })

  it('applies width and height from style', () => {
    const node = {
      id: 'ff-2', type: 'freeformLayer',
      style: { widthPx: 480, heightPx: 160 },
      props: {}, children: [],
    }
    const html = renderToStaticMarkup(<FreeformLayerNode node={node} />)
    expect(html).toContain('width:480px')
    expect(html).toContain('height:160px')
  })

  it('uses overflow:hidden when clip is panel (default)', () => {
    const node = { id: 'ff-3', type: 'freeformLayer', style: {}, props: { clip: 'panel' }, children: [] }
    const html = renderToStaticMarkup(<FreeformLayerNode node={node} />)
    expect(html).toContain('overflow:hidden')
  })

  it('uses overflow:visible when clip is visible', () => {
    const node = { id: 'ff-4', type: 'freeformLayer', style: {}, props: { clip: 'visible' }, children: [] }
    const html = renderToStaticMarkup(<FreeformLayerNode node={node} />)
    expect(html).toContain('overflow:visible')
  })

  it('wraps children in absolute-positioned frame divs', () => {
    const child = {
      id: 'dt-child', type: 'decorText',
      props: {
        frame: { x: 16, y: 8, widthPx: 120, heightPx: 20 },
        text: 'Hello',
      },
    }
    const node = {
      id: 'ff-5', type: 'freeformLayer',
      style: { widthPx: 300, heightPx: 60 },
      props: {}, children: [child],
    }
    const html = renderToStaticMarkup(<FreeformLayerNode node={node} />)
    expect(html).toContain('position:absolute')
    expect(html).toContain('left:16px')
    expect(html).toContain('top:8px')
    expect(html).toContain('width:120px')
    expect(html).toContain('height:20px')
    expect(html).toContain('data-pluginui-frame-id="dt-child"')
  })

  it('renders DecorTextNode inside the layer', () => {
    const child = {
      id: 'dt-inner', type: 'decorText',
      props: { frame: { x: 0, y: 0, widthPx: 80, heightPx: 16 }, text: 'DYNAMICS' },
    }
    const node = {
      id: 'ff-6', type: 'freeformLayer',
      style: { widthPx: 200, heightPx: 40 }, props: {}, children: [child],
    }
    const html = renderToStaticMarkup(<FreeformLayerNode node={node} />)
    expect(html).toContain('DYNAMICS')
    expect(html).toContain('pluginui-decor-text')
  })
})

// ── DecorTextNode ─────────────────────────────────────────────────────────────

describe('DecorTextNode', () => {
  function makeTextNode(propOverrides = {}) {
    return { id: 'dt-test', type: 'decorText', props: { text: 'TEST', ...propOverrides } }
  }

  it('renders the text content', () => {
    const html = renderToStaticMarkup(<DecorTextNode node={makeTextNode({ text: 'ATTACK' })} />)
    expect(html).toContain('ATTACK')
  })

  it('applies pluginui-decor-text class', () => {
    const html = renderToStaticMarkup(<DecorTextNode node={makeTextNode()} />)
    expect(html).toContain('pluginui-decor-text')
  })

  it('applies variant class for header', () => {
    const html = renderToStaticMarkup(<DecorTextNode node={makeTextNode({ variant: 'header' })} />)
    expect(html).toContain('pluginui-decor-text--header')
  })

  it('applies letter-spacing class for wide', () => {
    const html = renderToStaticMarkup(<DecorTextNode node={makeTextNode({ letterSpacing: 'wide' })} />)
    expect(html).toContain('pluginui-decor-text--ls-wide')
  })

  it('does not add variant class for default variant', () => {
    const html = renderToStaticMarkup(<DecorTextNode node={makeTextNode({ variant: 'default' })} />)
    expect(html).not.toContain('pluginui-decor-text--default')
  })

  it('resolves textToken to a CSS variable', () => {
    const html = renderToStaticMarkup(<DecorTextNode node={makeTextNode({ textToken: 'accent.primary' })} />)
    expect(html).toContain('--theme-accent')
  })

  it('applies text-align from align prop', () => {
    const html = renderToStaticMarkup(<DecorTextNode node={makeTextNode({ align: 'center' })} />)
    expect(html).toContain('text-align:center')
  })
})

// ── DecorLineNode ─────────────────────────────────────────────────────────────

describe('DecorLineNode', () => {
  function makeLineNode(propOverrides = {}) {
    return { id: 'dl-test', type: 'decorLine', props: { orientation: 'horizontal', ...propOverrides } }
  }

  it('renders with pluginui-decor-line class', () => {
    const html = renderToStaticMarkup(<DecorLineNode node={makeLineNode()} />)
    expect(html).toContain('pluginui-decor-line')
  })

  it('applies orientation class', () => {
    const html = renderToStaticMarkup(<DecorLineNode node={makeLineNode({ orientation: 'horizontal' })} />)
    expect(html).toContain('pluginui-decor-line--horizontal')
  })

  it('uses border-top for horizontal orientation', () => {
    const html = renderToStaticMarkup(<DecorLineNode node={makeLineNode({ orientation: 'horizontal' })} />)
    expect(html).toMatch(/border-top:[^;]+/)
  })

  it('uses border-left for vertical orientation', () => {
    const html = renderToStaticMarkup(<DecorLineNode node={makeLineNode({ orientation: 'vertical' })} />)
    expect(html).toMatch(/border-left:[^;]+/)
  })

  it('resolves strokeToken to a CSS variable', () => {
    const html = renderToStaticMarkup(<DecorLineNode node={makeLineNode({ strokeToken: 'accent.primary' })} />)
    expect(html).toContain('--theme-accent')
  })
})

// ── DecorShapeNode ────────────────────────────────────────────────────────────

describe('DecorShapeNode', () => {
  function makeShapeNode(propOverrides = {}) {
    return { id: 'ds-test', type: 'decorShape', props: { shape: 'rect', ...propOverrides } }
  }

  it('renders with pluginui-decor-shape class', () => {
    const html = renderToStaticMarkup(<DecorShapeNode node={makeShapeNode()} />)
    expect(html).toContain('pluginui-decor-shape')
  })

  it('applies shape class', () => {
    const html = renderToStaticMarkup(<DecorShapeNode node={makeShapeNode({ shape: 'roundedRect' })} />)
    expect(html).toContain('pluginui-decor-shape--roundedRect')
  })

  it('applies border-radius for circle', () => {
    const html = renderToStaticMarkup(<DecorShapeNode node={makeShapeNode({ shape: 'circle' })} />)
    expect(html).toContain('border-radius:50%')
  })

  it('applies border-radius 9999px for pill', () => {
    const html = renderToStaticMarkup(<DecorShapeNode node={makeShapeNode({ shape: 'pill' })} />)
    expect(html).toContain('border-radius:9999px')
  })

  it('applies cornerRadius for roundedRect', () => {
    const html = renderToStaticMarkup(<DecorShapeNode node={makeShapeNode({ shape: 'roundedRect', cornerRadius: 8 })} />)
    expect(html).toContain('border-radius:8px')
  })

  it('does not set background-color when fillToken is fill.none', () => {
    const html = renderToStaticMarkup(<DecorShapeNode node={makeShapeNode({ fillToken: 'fill.none' })} />)
    expect(html).not.toContain('background-color')
  })

  it('sets background-color when fillToken is a real surface token', () => {
    const html = renderToStaticMarkup(<DecorShapeNode node={makeShapeNode({ fillToken: 'surface.control' })} />)
    expect(html).toContain('background-color')
  })

  it('does not set border when strokeToken is stroke.none', () => {
    const html = renderToStaticMarkup(
      <DecorShapeNode node={makeShapeNode({ strokeToken: 'stroke.none', strokeWidth: 2 })} />,
    )
    expect(html).not.toMatch(/border:[^-]/)
  })

  it('applies opacity', () => {
    const html = renderToStaticMarkup(<DecorShapeNode node={makeShapeNode({ opacity: 50 })} />)
    expect(html).toContain('opacity:0.5')
  })
})

// ── DecalNode ─────────────────────────────────────────────────────────────────

describe('DecalNode', () => {
  function makeDecalNode(propOverrides = {}) {
    return { id: 'dcl-test', type: 'decal', props: { assetId: 'builtin.placeholder.missing', ...propOverrides } }
  }

  it('renders with pluginui-decal class', () => {
    const html = renderToStaticMarkup(<DecalNode node={makeDecalNode()} />)
    expect(html).toContain('pluginui-decal')
  })

  it('renders as placeholder in Freeform-A (no img src from layout)', () => {
    const html = renderToStaticMarkup(<DecalNode node={makeDecalNode()} />)
    expect(html).not.toContain('<img')
    expect(html).toContain('pluginui-decal--placeholder')
  })

  it('includes data-decal-id attribute', () => {
    const html = renderToStaticMarkup(<DecalNode node={makeDecalNode()} />)
    expect(html).toContain('data-decal-id="builtin.placeholder.missing"')
  })

  it('applies opacity from props', () => {
    const html = renderToStaticMarkup(<DecalNode node={makeDecalNode({ opacity: 50 })} />)
    expect(html).toContain('opacity:0.5')
  })
})
