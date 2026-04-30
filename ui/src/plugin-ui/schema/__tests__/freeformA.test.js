import { describe, it, expect } from 'vitest'
import { validate } from '../validate.js'
import { SHIPPED_LAYOUTS } from '../../layouts/index.js'
import { COMPRESSOR_MANIFEST } from '../../manifests/compressor.js'
import { isSaveAllowed } from '../../designer/validationStatus.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function cloneCompressorLayout() {
  return JSON.parse(JSON.stringify(SHIPPED_LAYOUTS['compressor']))
}

function errorCodes(result) {
  return (result.errors || []).map(e => e.code)
}

function makeLayout(root) {
  return {
    schemaVersion: 1,
    pluginId:      'compressor',
    root,
  }
}

function makePanel(children) {
  return {
    id:       'panel-root',
    type:     'panel',
    children: children,
  }
}

function makeFreeformLayer(children = [], extraStyle = {}, extraProps = {}) {
  return {
    id:       'ff-layer',
    type:     'freeformLayer',
    style:    { widthPx: 400, heightPx: 120, ...extraStyle },
    props:    { snap: { gridPx: 8, enabled: true }, background: 'transparent', clip: 'panel', ...extraProps },
    children,
  }
}

function validFrame(overrides = {}) {
  return { x: 10, y: 20, widthPx: 100, heightPx: 30, ...overrides }
}

function makeDecorText(id, frameOverrides = {}, propOverrides = {}) {
  return {
    id,
    type:  'decorText',
    props: {
      frame:   validFrame(frameOverrides),
      text:    'DYNAMICS',
      variant: 'header',
      align:   'left',
      textToken: 'text.muted',
      ...propOverrides,
    },
  }
}

function makeDecorLine(id, frameOverrides = {}, propOverrides = {}) {
  return {
    id,
    type:  'decorLine',
    props: {
      frame:       validFrame(frameOverrides),
      orientation: 'horizontal',
      thickness:   'hair',
      lineStyle:   'solid',
      strokeToken: 'text.subtle',
      ...propOverrides,
    },
  }
}

function makeDecorShape(id, frameOverrides = {}, propOverrides = {}) {
  return {
    id,
    type:  'decorShape',
    props: {
      frame:       validFrame(frameOverrides),
      shape:       'roundedRect',
      cornerRadius: 4,
      fillToken:   'surface.controlRaised',
      strokeToken: 'stroke.none',
      strokeWidth: 0,
      opacity:     100,
      ...propOverrides,
    },
  }
}

function makeDecal(id, frameOverrides = {}, propOverrides = {}) {
  return {
    id,
    type:  'decal',
    props: {
      frame:   validFrame(frameOverrides),
      assetId: 'builtin.placeholder.missing',
      fit:     'contain',
      opacity: 100,
      ...propOverrides,
    },
  }
}

// ── 1. Existing Compressor layout still validates unchanged ───────────────────

describe('Freeform-A: compressor layout unaffected', () => {
  it('validates the existing Compressor layout unchanged and allows save', () => {
    const result = validate(cloneCompressorLayout(), COMPRESSOR_MANIFEST)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(isSaveAllowed(result)).toBe(true)
  })
})

// ── 2. Valid freeformLayer with each decor type ───────────────────────────────

describe('Freeform-A: valid freeform layouts', () => {
  it('accepts a freeformLayer containing a decorText node', () => {
    const layout = makeLayout(makePanel([
      makeFreeformLayer([makeDecorText('dt-1')]),
    ]))
    const result = validate(layout)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).toHaveLength(0)
  })

  it('accepts a freeformLayer containing a decorLine node', () => {
    const layout = makeLayout(makePanel([
      makeFreeformLayer([makeDecorLine('dl-1')]),
    ]))
    const result = validate(layout)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).toHaveLength(0)
  })

  it('accepts a freeformLayer containing a decorShape node', () => {
    const layout = makeLayout(makePanel([
      makeFreeformLayer([makeDecorShape('ds-1')]),
    ]))
    const result = validate(layout)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).toHaveLength(0)
  })

  it('accepts a freeformLayer containing a decal node', () => {
    const layout = makeLayout(makePanel([
      makeFreeformLayer([makeDecal('dcl-1')]),
    ]))
    const result = validate(layout)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).toHaveLength(0)
  })

  it('accepts a freeformLayer with all four decor types at once', () => {
    const layout = makeLayout(makePanel([
      makeFreeformLayer([
        makeDecorText('dt-all'),
        makeDecorLine('dl-all'),
        makeDecorShape('ds-all'),
        makeDecal('dcl-all'),
      ]),
    ]))
    const result = validate(layout)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).toHaveLength(0)
  })

  it('accepts a freeformLayer with fill.none and stroke.none pseudo-tokens', () => {
    const layout = makeLayout(makePanel([
      makeFreeformLayer([
        makeDecorShape('ds-none', {}, { fillToken: 'fill.none', strokeToken: 'stroke.none' }),
      ]),
    ]))
    const result = validate(layout)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).toHaveLength(0)
  })
})

// ── 3. freeformLayer as root is rejected ─────────────────────────────────────

describe('Freeform-A: freeformLayer as root rejected', () => {
  it('rejects freeformLayer as the document root', () => {
    const layout = {
      schemaVersion: 1,
      pluginId:      'compressor',
      root:          { id: 'ff-root', type: 'freeformLayer', children: [] },
    }
    const result = validate(layout)
    expect(result.ok).toBe(false)
    expect(errorCodes(result)).toContain('BAD_ROOT_TYPE')
  })
})

// ── 4. Container inside freeformLayer is rejected ─────────────────────────────

describe('Freeform-A: container inside freeformLayer rejected', () => {
  for (const containerType of ['panel', 'group', 'row', 'column', 'tabGroup', 'freeformLayer']) {
    it(`rejects ${containerType} nested inside freeformLayer`, () => {
      const layout = makeLayout(makePanel([
        makeFreeformLayer([
          { id: `inner-${containerType}`, type: containerType, children: [] },
        ]),
      ]))
      const result = validate(layout)
      expect(result.ok).toBe(true)
      expect(errorCodes(result)).toContain('CONTAINER_IN_FREEFORM')
    })
  }
})

// ── 5. Missing frame on freeform child is rejected ────────────────────────────

describe('Freeform-A: missing frame on freeform child', () => {
  it('hard-rejects a decorText without props.frame', () => {
    const node = { id: 'dt-noframe', type: 'decorText', props: { text: 'Hello' } }
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).toContain('MISSING_FRAME')
    expect(isSaveAllowed(result)).toBe(false)
  })

  it('hard-rejects a knob in freeformLayer without props.frame', () => {
    const node = {
      id: 'k-noframe', type: 'knob',
      props: { param: 'threshold', label: 'T', size: 52, format: 'dB1' },
    }
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).toContain('MISSING_FRAME')
    expect(isSaveAllowed(result)).toBe(false)
  })
})

// ── 6. Frame on flow child is rejected ───────────────────────────────────────

describe('Freeform-A: frame on non-freeform child rejected', () => {
  it('hard-rejects props.frame on a knob inside a group (flow child)', () => {
    const layout = makeLayout(makePanel([{
      id:   'grp',
      type: 'group',
      children: [{
        id:    'k-withframe',
        type:  'knob',
        props: { param: 'threshold', frame: validFrame() },
      }],
    }]))
    const result = validate(layout)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).toContain('FRAME_NOT_ALLOWED')
    expect(isSaveAllowed(result)).toBe(false)
  })
})

// ── 7. Frame out-of-bounds soft-clamps ────────────────────────────────────────

describe('Freeform-A: frame out-of-bounds clamps', () => {
  it('clamps x below -2000 and records soft error', () => {
    const node = makeDecorText('dt-clamp-x', { x: -9999 })
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).toContain('FRAME_OUT_OF_BOUNDS')
    const sanitized = result.doc.root.children[0].children[0]
    expect(sanitized.props.frame.x).toBe(-2000)
  })

  it('clamps widthPx above 4096 and records soft error', () => {
    const node = makeDecorText('dt-clamp-w', { widthPx: 9000 })
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).toContain('FRAME_OUT_OF_BOUNDS')
    const sanitized = result.doc.root.children[0].children[0]
    expect(sanitized.props.frame.widthPx).toBe(4096)
  })
})

// ── 8. widthPx/heightPx ≤ 0 hard-rejects ─────────────────────────────────────

describe('Freeform-A: BAD_FRAME_SIZE for non-positive dimensions', () => {
  it('hard-rejects widthPx: 0', () => {
    const node = makeDecorText('dt-zero-w', { widthPx: 0 })
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(errorCodes(result)).toContain('BAD_FRAME_SIZE')
    expect(isSaveAllowed(result)).toBe(false)
  })

  it('hard-rejects widthPx: -10', () => {
    const node = makeDecorText('dt-neg-w', { widthPx: -10 })
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(errorCodes(result)).toContain('BAD_FRAME_SIZE')
    expect(isSaveAllowed(result)).toBe(false)
  })

  it('hard-rejects heightPx: 0', () => {
    const node = makeDecorText('dt-zero-h', { heightPx: 0 })
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(errorCodes(result)).toContain('BAD_FRAME_SIZE')
    expect(isSaveAllowed(result)).toBe(false)
  })
})

// ── 9. Unsupported rotation on knob soft-clamps ───────────────────────────────

describe('Freeform-A: rotation not supported on knob', () => {
  it('soft-clamps rotationDeg to 0 on a knob in freeformLayer', () => {
    const node = {
      id: 'k-rot', type: 'knob',
      props: {
        param: 'threshold',
        frame: { x: 0, y: 0, widthPx: 64, heightPx: 64, rotationDeg: 45 },
      },
    }
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout, COMPRESSOR_MANIFEST)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).toContain('ROTATION_NOT_SUPPORTED')
    const sanitized = result.doc.root.children[0].children[0]
    expect(sanitized.props.frame.rotationDeg).toBe(0)
  })

  it('accepts rotationDeg on a decorShape (supported type)', () => {
    const node = makeDecorShape('ds-rot', { rotationDeg: 45 })
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).not.toContain('ROTATION_NOT_SUPPORTED')
    const sanitized = result.doc.root.children[0].children[0]
    expect(sanitized.props.frame.rotationDeg).toBe(45)
  })
})

// ── 10. Forbidden keys hard-reject ───────────────────────────────────────────

describe('Freeform-A: forbidden props keys hard-reject', () => {
  for (const forbiddenKey of ['src', 'href', 'url', 'style', 'className', 'class', 'script', 'html', 'data', 'base64']) {
    it(`hard-rejects props.${forbiddenKey} on a decorText`, () => {
      const node = makeDecorText('dt-fk')
      node.props[forbiddenKey] = 'bad-value'
      const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
      const result = validate(layout)
      expect(errorCodes(result)).toContain('FORBIDDEN_PROPS_KEY')
      expect(isSaveAllowed(result)).toBe(false)
    })
  }

  it('hard-rejects onClick event handler key', () => {
    const node = makeDecorText('dt-click')
    node.props.onClick = '() => {}'
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(errorCodes(result)).toContain('FORBIDDEN_PROPS_KEY')
    expect(isSaveAllowed(result)).toBe(false)
  })

  it('hard-rejects src inside frame', () => {
    const node = makeDecorText('dt-frame-src')
    node.props.frame.src = 'http://evil.com'
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(errorCodes(result)).toContain('FORBIDDEN_FRAME_KEY')
    expect(isSaveAllowed(result)).toBe(false)
  })
})

// ── 11. Forbidden string values hard-reject ───────────────────────────────────

describe('Freeform-A: forbidden string values hard-reject', () => {
  const forbiddenValues = [
    ['hex color', '#ff006a'],
    ['rgb color', 'rgb(255,0,0)'],
    ['rgba color', 'rgba(255,0,0,0.5)'],
    ['hsl color', 'hsl(330 100% 50%)'],
    ['var()', 'var(--theme-accent)'],
    ['CSS variable', '--theme-accent'],
    ['http URL', 'http://example.com'],
    ['https URL', 'https://example.com/img.png'],
    ['file URL', 'file://C:/secret'],
    ['data URI', 'data:image/png;base64,abc'],
    ['javascript URI', 'javascript:alert(1)'],
    ['Windows path C:\\', 'C:\\Users\\test'],
    ['path traversal', '../../../etc/passwd'],
  ]

  for (const [label, value] of forbiddenValues) {
    it(`hard-rejects ${label} as strokeToken on decorLine`, () => {
      const node = makeDecorLine('dl-fv')
      node.props.strokeToken = value
      const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
      const result = validate(layout)
      const codes = errorCodes(result)
      expect(
        codes.includes('FORBIDDEN_PROPS_VALUE') || codes.includes('UNKNOWN_DECOR_TOKEN'),
        `Expected FORBIDDEN_PROPS_VALUE or UNKNOWN_DECOR_TOKEN for "${label}" but got: ${codes.join(', ')}`,
      ).toBe(true)
      expect(isSaveAllowed(result)).toBe(false)
    })
  }

  it('hard-rejects <script> HTML injection in decorText.text', () => {
    const node = makeDecorText('dt-html', {}, { text: '<script>alert(1)</script>' })
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(errorCodes(result)).toContain('FORBIDDEN_PROPS_VALUE')
    expect(isSaveAllowed(result)).toBe(false)
  })
})

// ── 12. Unknown enum values soft-fallback ─────────────────────────────────────

describe('Freeform-A: unknown enum values soft-fallback', () => {
  it('soft-falls-back unknown decorText variant to "default"', () => {
    const node = makeDecorText('dt-enum', {}, { variant: 'super-rare-variant' })
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).toContain('UNKNOWN_DECOR_ENUM')
    const sanitized = result.doc.root.children[0].children[0]
    expect(sanitized.props.variant).toBe('default')
  })

  it('soft-falls-back unknown decorShape shape', () => {
    const node = makeDecorShape('ds-enum', {}, { shape: 'hexagon' })
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(errorCodes(result)).toContain('MISSING_SHAPE')
    const sanitized = result.doc.root.children[0].children[0]
    expect(sanitized._invalid).toBe(true)
  })
})

// ── 13. Unknown token id soft-fallback ────────────────────────────────────────

describe('Freeform-A: unknown token ids soft-fallback', () => {
  it('soft-falls-back unknown textToken on decorText', () => {
    const node = makeDecorText('dt-tok', {}, { textToken: 'text.neonFuture' })
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).toContain('UNKNOWN_DECOR_TOKEN')
    const sanitized = result.doc.root.children[0].children[0]
    expect(sanitized.props.textToken).toBe('text.primary')
  })

  it('soft-falls-back unknown strokeToken on decorLine', () => {
    const node = makeDecorLine('dl-tok', {}, { strokeToken: 'accent.neonFuture' })
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).toContain('UNKNOWN_DECOR_TOKEN')
    const sanitized = result.doc.root.children[0].children[0]
    expect(sanitized.props.strokeToken).toBe('text.subtle')
  })
})

// ── 14. Unknown asset id soft-fallback to placeholder ─────────────────────────

describe('Freeform-A: unknown asset id soft-fallback', () => {
  it('soft-falls-back unknown builtin asset id to placeholder', () => {
    const node = makeDecal('dcl-unk', {}, { assetId: 'builtin.brand.nonexistent' })
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(result.ok).toBe(true)
    expect(errorCodes(result)).toContain('UNKNOWN_DECAL_ASSET')
    const sanitized = result.doc.root.children[0].children[0]
    expect(sanitized.props.assetId).toBe('builtin.placeholder.missing')
  })
})

// ── 15. Bad asset id format hard-rejects ─────────────────────────────────────

describe('Freeform-A: bad asset id format hard-rejects', () => {
  it('hard-rejects assetId with path separator', () => {
    const node = makeDecal('dcl-bad', {}, { assetId: 'builtin/brand/evil' })
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(errorCodes(result)).toContain('BAD_ASSET_ID_FORMAT')
    expect(isSaveAllowed(result)).toBe(false)
  })

  it('hard-rejects assetId with path traversal', () => {
    const node = makeDecal('dcl-trav', {}, { assetId: 'builtin.brand..evil' })
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(errorCodes(result)).toContain('BAD_ASSET_ID_FORMAT')
    expect(isSaveAllowed(result)).toBe(false)
  })

  it('hard-rejects assetId with unsupported prefix', () => {
    const node = makeDecal('dcl-pfx', {}, { assetId: 'custom.brand.logo' })
    const layout = makeLayout(makePanel([makeFreeformLayer([node])]))
    const result = validate(layout)
    expect(errorCodes(result)).toContain('BAD_ASSET_ID_FORMAT')
    expect(isSaveAllowed(result)).toBe(false)
  })
})

// ── 16. decorText/decorLine/decorShape/decal outside freeformLayer rejected ────

describe('Freeform-A: decor types outside freeformLayer rejected', () => {
  for (const type of ['decorText', 'decorLine', 'decorShape', 'decal']) {
    it(`hard-rejects ${type} as a direct panel child`, () => {
      const node = { id: `${type}-out`, type, props: {} }
      const layout = makeLayout(makePanel([node]))
      const result = validate(layout)
      expect(errorCodes(result)).toContain('DECOR_NOT_IN_FREEFORM')
      expect(isSaveAllowed(result)).toBe(false)
    })
  }
})
