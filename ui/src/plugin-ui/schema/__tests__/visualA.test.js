import { describe, expect, it } from 'vitest'

import {
  KNOB_PRESET_IDS,
  KNOB_PRESETS,
} from '../../appearance/knobPresets.js'
import {
  isKnownTokenId,
} from '../../appearance/tokenSlots.js'
import {
  APPEARANCE_ESCAPE_KEYS,
  getAppearanceRulesForType,
  isRawColorLike,
} from '../../appearance/appearanceRegistry.js'
import { isSaveAllowed } from '../../designer/validationStatus.js'
import { SHIPPED_LAYOUTS } from '../../layouts/index.js'
import { COMPRESSOR_MANIFEST } from '../../manifests/compressor.js'
import { validate } from '../validate.js'

describe('Visual-A appearance validator', () => {
  it('validates the existing Compressor layout unchanged', () => {
    const result = validate(cloneCompressorLayout(), COMPRESSOR_MANIFEST)

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(isSaveAllowed(result)).toBe(true)
  })

  it('accepts a knob with appearance.preset studio-ring', () => {
    const result = validateWithKnobAppearance({ preset: 'studio-ring' })

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('accepts known token ids for knob token slots', () => {
    const result = validateWithKnobAppearance({
      surfaceToken: 'surface.controlRaised',
      accentToken: 'accent.focus',
      textToken: 'text.muted',
    })

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('soft-flags unknown token ids and falls back in sanitized docs', () => {
    const result = validateWithKnobAppearance({ accentToken: 'accent.neonFuture' })

    expect(errorCodes(result)).toContain('UNKNOWN_APPEARANCE_TOKEN')
    expect(findNode(result.doc, 'k-threshold').props.appearance.accentToken).toBe('accent.primary')
    expect(isSaveAllowed(result)).toBe(false)
  })

  it('soft-flags unknown presets and falls back in sanitized docs', () => {
    const result = validateWithKnobAppearance({ preset: 'my-custom-knob' })

    expect(errorCodes(result)).toContain('UNKNOWN_APPEARANCE_VALUE')
    expect(findNode(result.doc, 'k-threshold').props.appearance.preset).toBe('xleth-default')
    expect(isSaveAllowed(result)).toBe(false)
  })

  it('soft-flags unknown harmless appearance keys and strips them', () => {
    const result = validateWithKnobAppearance({ preset: 'studio-ring', sparkle: 'reserved-future-option' })

    expect(errorCodes(result)).toContain('UNKNOWN_APPEARANCE_KEY')
    expect(findNode(result.doc, 'k-threshold').props.appearance.sparkle).toBeUndefined()
    expect(isSaveAllowed(result)).toBe(false)
  })

  it.each([null, [], 'studio-ring', 42])('blocks non-object appearance value %s', appearance => {
    const result = validateWithKnobAppearance(appearance)

    expect(errorCodes(result)).toContain('BAD_APPEARANCE')
    expect(isSaveAllowed(result)).toBe(false)
  })

  it('soft-flags and strips appearance on unsupported node types', () => {
    const layout = cloneCompressorLayout()
    findNode(layout, 'detect-label').props.appearance = { textToken: 'text.muted' }

    const result = validate(layout, COMPRESSOR_MANIFEST)

    expect(errorCodes(result)).toContain('APPEARANCE_NOT_SUPPORTED')
    expect(findNode(result.doc, 'detect-label').props.appearance).toBeUndefined()
    expect(isSaveAllowed(result)).toBe(false)
  })

  it.each([
    ['hex', '#ff006a'],
    ['short hex', '#fff'],
    ['rgba', 'rgba(255, 0, 0, 0.4)'],
    ['rgb', 'rgb(255, 0, 0)'],
    ['hsla', 'hsla(330, 100%, 50%, 0.5)'],
    ['hsl', 'hsl(330 100% 50%)'],
    ['named CSS color', 'red'],
    ['currentColor', 'currentColor'],
    ['var expression', 'var(--theme-accent)'],
    ['raw CSS variable', '--theme-accent'],
    ['CSS declaration', 'color:red'],
  ])('blocks raw %s appearance values', (_label, rawValue) => {
    const result = validateWithKnobAppearance({ accentToken: rawValue })

    expect(errorCodes(result)).toContain('RAW_APPEARANCE_VALUE')
    expect(isSaveAllowed(result)).toBe(false)
  })

  it.each(APPEARANCE_ESCAPE_KEYS)('blocks appearance escape key %s', key => {
    const result = validateWithKnobAppearance({ [key]: 'studio-ring' })

    expect(errorCodes(result)).toContain('APPEARANCE_ESCAPE_KEY')
    expect(isSaveAllowed(result)).toBe(false)
  })

  it('blocks props.color on plugin UI knobs', () => {
    const layout = cloneCompressorLayout()
    findNode(layout, 'k-threshold').props.color = '#ff006a'

    const result = validate(layout, COMPRESSOR_MANIFEST)

    expect(errorCodes(result)).toContain('PLUGIN_KNOB_COLOR_FORBIDDEN')
    expect(isSaveAllowed(result)).toBe(false)
  })
})

describe('Visual-A knob preset registry', () => {
  it('all knob presets reference valid token ids and allowed appearance keys', () => {
    const rules = getAppearanceRulesForType('knob')
    const allowedKeys = new Set(Object.keys(rules.allowedKeys))

    expect(Object.keys(KNOB_PRESETS)).toEqual(KNOB_PRESET_IDS)

    for (const presetId of KNOB_PRESET_IDS) {
      const preset = KNOB_PRESETS[presetId]
      expect(preset.label).toBeTruthy()
      expect(preset.description).toBeTruthy()
      expect(preset.defaults.preset).toBe(presetId)

      for (const [key, value] of Object.entries(preset.defaults)) {
        expect(allowedKeys.has(key)).toBe(true)
        if (key.endsWith('Token')) expect(isKnownTokenId(value)).toBe(true)
      }
    }
  })

  it('no knob preset contains raw colors, CSS variables, functions, or non-serializable defaults', () => {
    for (const preset of Object.values(KNOB_PRESETS)) {
      expect(typeof preset.className).toBe('string')
      expect(JSON.parse(JSON.stringify(preset.defaults))).toEqual(preset.defaults)

      for (const value of Object.values(preset.defaults)) {
        expect(typeof value).toBe('string')
        expect(typeof value).not.toBe('function')
        expect(isRawColorLike(value)).toBe(false)
      }
    }
  })
})

function validateWithKnobAppearance(appearance) {
  const layout = cloneCompressorLayout()
  findNode(layout, 'k-threshold').props.appearance = appearance
  return validate(layout, COMPRESSOR_MANIFEST)
}

function cloneCompressorLayout() {
  return JSON.parse(JSON.stringify(SHIPPED_LAYOUTS.compressor))
}

function findNode(layoutOrNode, nodeId) {
  const node = layoutOrNode.root || layoutOrNode
  if (node.id === nodeId) return node
  for (const child of node.children || []) {
    const found = findNode(child, nodeId)
    if (found) return found
  }
  return null
}

function errorCodes(result) {
  return (result.errors || []).map(error => error.code)
}
