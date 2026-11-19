// The motion property schema (docs/XLETH_MOTION_VIEW_DESIGN.md section 4):
//   1. staleness: the engine's checked-in MotionSchema.generated.inc is exactly what
//      scripts/generate-motion-schema.js renders from motionSchema.json;
//   2. sanity: identities, ranges, clamps, options, units, limits, engine order;
//   3. the schema.js helpers (format / parse / NumberBox props / options), numbers pinned.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import schemaJson from './motionSchema.json'
import {
  GROUPS, INTERPS, LIMITS, PROPERTIES, UNITS, clampValue, enumOptions, formatValue, groupById, identityOf,
  isAnimatable, isLayer, layerIdentityOf, numberBoxProps, parseValue, propertiesOfGroup, propertyById, propertyFor,
  rangeOf, readableLabel,
} from './schema.js'
import { INTERPS as KEY_INTERPS, LENS_CHANNELS } from '../lensRoam/lensKeyModel.js'
import { LENS_FITS, LENS_FLIPS, LENS_IDENTITY, ROAM_BOUNDS, ROAM_IDENTITY, ROAM_LAYERS } from '../lensRoam/lensRoamModel.js'
import { ROAM_CHANNELS, SWEEP_CHANNELS } from '../lensRoam/roamKeyModel.js'
import { MINUS, THIN_SPACE } from '../ui-kit/format.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..')
const require = createRequire(import.meta.url)
const generator = require(path.join(repoRoot, 'scripts', 'generate-motion-schema.js'))

const T = THIN_SPACE
const M = MINUS

describe('generated engine schema is not stale', () => {
  it('MotionSchema.generated.inc == render(motionSchema.json) (CRLF-normalised)', () => {
    const want = generator.render(generator.loadSchema())
    const abs = path.join(repoRoot, generator.OUT_REL)
    const have = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
    expect(have).toBe(want)
  })

  it('the UI imports the same file the generator reads', () => {
    expect(path.resolve(generator.SCHEMA_PATH)).toBe(path.resolve(here, 'motionSchema.json'))
    expect(generator.loadSchema()).toEqual(schemaJson)
  })

  it('render() refuses a broken schema (the generator validates)', () => {
    const bad = JSON.parse(JSON.stringify(schemaJson))
    bad.properties.push({ ...bad.properties[0] })
    expect(() => generator.render(bad)).toThrow(/duplicate property id/)
  })
})

describe('schema sanity', () => {
  it('ids are unique and every property names a known group', () => {
    const ids = PROPERTIES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of PROPERTIES) expect(groupById(p.group), p.id).not.toBeNull()
  })

  it('every scalar: unit known, identity inside range and clamp, log ranges positive, blend set', () => {
    for (const p of PROPERTIES.filter((q) => q.type === 'scalar')) {
      expect(UNITS[p.unit], p.id).toBeTruthy()
      expect(p.identity, p.id).toBeGreaterThanOrEqual(p.range[0])
      expect(p.identity, p.id).toBeLessThanOrEqual(p.range[1])
      if (p.clamp) {
        expect(p.identity).toBeGreaterThanOrEqual(p.clamp[0])
        expect(p.identity).toBeLessThanOrEqual(p.clamp[1])
        expect(p.range[0], p.id).toBeGreaterThanOrEqual(p.clamp[0])
        expect(p.range[1], p.id).toBeLessThanOrEqual(p.clamp[1])
      }
      if (p.log) expect(p.range[0], p.id).toBeGreaterThan(0)
      expect(['absolute', 'multiply', 'add']).toContain(p.blend)
      expect(Number.isInteger(p.engineIndex)).toBe(true)
    }
  })

  it('every enum / shape identity is one of its options; non-scalars are not keyed except the shape', () => {
    for (const p of PROPERTIES) {
      if (p.type === 'enum' || p.type === 'shape') expect(p.options, p.id).toContain(p.identity)
      if (p.type !== 'scalar' && p.type !== 'shape') expect(p.animatable, p.id).toBe(false)
    }
    expect(propertyById('mask.shape').animatable).toBe(true)
  })

  it('engine order: each family numbers its channels 0..3 like the engine enums the UI already uses', () => {
    const order = (prefix) => PROPERTIES.filter((p) => p.id.startsWith(`${prefix}.`) && p.type === 'scalar')
      .sort((a, b) => a.engineIndex - b.engineIndex).map((p) => p.channel)
    expect(order('roam')).toEqual(ROAM_CHANNELS)                                 // RoamChannel
    expect(order('clipLens')).toEqual(['centerX', 'centerY', 'zoom', 'rotationDeg'])  // LensChannel
    expect(order('sourceLens')).toEqual(['centerX', 'centerY', 'zoom', 'rotationDeg'])
    expect(order('sweep')).toEqual(['centerX', 'centerY', 'zoom', 'rotationDeg'])
    expect(order('mask')).toEqual(['feather', 'expansion', 'opacity'])           // MaskChannel
    expect([...order('sweep')].sort()).toEqual([...SWEEP_CHANNELS].sort())
    expect([...order('clipLens')].sort()).toEqual([...LENS_CHANNELS].sort())
  })

  it('identities and options match the Lens / Roam model the UI renders with', () => {
    for (const ch of ['offsetX', 'offsetY', 'scale', 'rotationDeg', 'bounds', 'layer']) {
      expect(identityOf(`roam.${ch}`), ch).toBe(ROAM_IDENTITY[ch])
    }
    for (const ch of ['fit', 'centerX', 'centerY', 'zoom', 'rotationDeg', 'flip']) {
      expect(identityOf(`clipLens.${ch}`), ch).toBe(LENS_IDENTITY[ch])
      expect(identityOf(`sourceLens.${ch}`), ch).toBe(LENS_IDENTITY[ch])
    }
    expect(propertyById('roam.bounds').options).toEqual(ROAM_BOUNDS)
    expect(propertyById('roam.layer').options).toEqual(ROAM_LAYERS)
    expect(propertyById('clipLens.fit').options).toEqual(LENS_FITS)
    expect(propertyById('clipLens.flip').options).toEqual(LENS_FLIPS)
    expect(INTERPS).toEqual(KEY_INTERPS)
  })

  it('limits are the R15 caps', () => {
    expect(LIMITS).toEqual({
      maxParentDepth: 4, maxMasksPerTrack: 8, maxVerticesPerMask: 32, maxMaskVerticesPerTrack: 64, minVerticesPerMask: 3,
    })
    for (const v of Object.values(LIMITS)) expect(Number.isInteger(v)).toBe(true)
  })

  it('labels are sentence case and short', () => {
    for (const p of PROPERTIES) {
      expect(p.label[0], p.id).toBe(p.label[0].toUpperCase())
      expect(p.label.split(' ').slice(1).every((w) => w.length === 1 || w === w.toLowerCase()), p.id).toBe(true)
      expect(p.label.length).toBeLessThanOrEqual(16)
    }
  })

  it('the schema data is frozen for the UI', () => {
    expect(Object.isFrozen(PROPERTIES)).toBe(true)
    expect(Object.isFrozen(propertyById('roam.scale'))).toBe(true)
    expect(Object.isFrozen(GROUPS)).toBe(true)
  })
})

describe('lookups', () => {
  it('propertyById / propertyFor / propertiesOfGroup', () => {
    expect(propertyById('roam.offsetX').label).toBe('Offset X')
    expect(propertyById('nope')).toBeNull()
    expect(propertyFor('mask', 'feather').id).toBe('mask.feather')
    expect(propertiesOfGroup('roam').map((p) => p.id)).toEqual([
      'roam.offsetX', 'roam.offsetY', 'roam.scale', 'roam.rotationDeg', 'roam.scaleY', 'roam.scaleLinked',
      'roam.cropLeft', 'roam.cropRight', 'roam.cropTop', 'roam.cropBottom', 'roam.bounds', 'roam.layer', 'roam.motionBlur',
    ])
    expect(propertiesOfGroup('mask').map((p) => p.channel)).toEqual(['shape', 'feather', 'expansion', 'opacity', 'mode', 'invert'])
    expect(propertiesOfGroup('lens', { owner: 'clip' }).map((p) => p.channel)).toEqual(['fit', 'zoom', 'centerX', 'centerY', 'rotationDeg', 'flip'])
    expect(propertiesOfGroup('sweep').map((p) => p.channel)).toEqual(['zoom', 'centerX', 'centerY', 'rotationDeg', 'motionBlur'])
  })

  it('layer vs absolute, animatable, identities', () => {
    expect(isLayer('sweep.zoom')).toBe(true)
    expect(isLayer('sweep.centerX')).toBe(true)
    expect(isLayer('sourceLens.zoom')).toBe(true)
    expect(isLayer('clipLens.zoom')).toBe(false)
    expect(isLayer('roam.scale')).toBe(false)
    expect(isLayer('mask.opacity')).toBe(false)
    expect(isAnimatable('roam.offsetX')).toBe(true)
    expect(isAnimatable('roam.bounds')).toBe(false)
    expect(isAnimatable('roam.motionBlur')).toBe(false)
    expect(isAnimatable('mask.invert')).toBe(false)
    expect(identityOf('mask.opacity')).toBe(1)
    expect(identityOf('mask.mode')).toBe('Add')
    expect(identityOf('mask.invert')).toBe(false)
    expect(layerIdentityOf('sourceLens.zoom')).toBe(1)
    expect(layerIdentityOf('sourceLens.centerX')).toBe(0)
    expect(layerIdentityOf('roam.scale')).toBe(1)
    expect(rangeOf('sourceLens.centerX')).toEqual([0, 1])
    expect(rangeOf('sourceLens.centerX', { layer: true })).toEqual([-2, 2])
    expect(rangeOf('roam.bounds')).toBeNull()
  })

  it('clampValue uses the engine clamp; non-finite falls back to the identity', () => {
    expect(clampValue('mask.opacity', 1.4)).toBe(1)
    expect(clampValue('mask.expansion', -3)).toBe(-1)
    expect(clampValue('roam.rotationDeg', 9999)).toBe(9999)   // no clamp
    expect(clampValue('roam.scale', NaN)).toBe(1)
  })
})

describe('formatValue', () => {
  it('scalars: thin space, true minus, signed units, no sign on zero', () => {
    expect(formatValue('roam.offsetX', -0.25)).toBe(`${M}0.25${T}c`)
    expect(formatValue('roam.offsetX', 0.25)).toBe(`+0.25${T}c`)
    expect(formatValue('roam.offsetX', 0)).toBe(`0.00${T}c`)
    expect(formatValue('roam.offsetX', -0.001)).toBe(`0.00${T}c`)
    expect(formatValue('roam.scale', 1)).toBe(`1.00${T}×`)
    expect(formatValue('roam.scale', 1.005)).toBe(`1.01${T}×`)
    expect(formatValue('roam.rotationDeg', -45)).toBe(`${M}45.0°`)
    expect(formatValue('mask.opacity', 0.5)).toBe(`50${T}%`)
    expect(formatValue('mask.feather', 0.1)).toBe(`0.100${T}c`)
    expect(formatValue('mask.expansion', -0.05)).toBe(`${M}0.050${T}c`)
    expect(formatValue('clipLens.centerX', 0.5)).toBe('0.50')
    expect(formatValue('sweep.centerX', 0.1)).toBe('+0.10')
    expect(formatValue('sweep.centerX', -0.1)).toBe(`${M}0.10`)
    expect(formatValue('roam.offsetX', NaN)).toBe('—')
  })

  it('short drops the space; layer signs an offset layer', () => {
    expect(formatValue('roam.scale', 2, { short: true })).toBe('2.00×')
    expect(formatValue('mask.opacity', 0.25, { short: true })).toBe('25%')
    expect(formatValue('sourceLens.centerX', 0.1, { layer: true })).toBe('+0.10')
    expect(formatValue('sourceLens.centerX', 0.6)).toBe('0.60')
  })

  it('enums, bools, the motion blur row and shapes', () => {
    expect(formatValue('roam.layer', 'AboveNeighbours')).toBe('Above neighbours')
    expect(formatValue('clipLens.flip', 'FollowTrack')).toBe('Follow track')
    expect(formatValue('mask.invert', true)).toBe('On')
    expect(formatValue('mask.invert', false)).toBe('Off')
    expect(formatValue('roam.motionBlur', { enabled: true, shutterAngleDeg: 180 })).toBe('Project · 180°')
    expect(formatValue('sweep.motionBlur', { enabled: false, shutterAngleDeg: 180 })).toBe('Project · Off')
    expect(formatValue('mask.shape', 'Ellipse')).toBe('Ellipse')
    expect(formatValue('mask.shape', { vertices: [[], [], []] })).toBe(`3${T}points`)
  })

  it('readableLabel splits CamelCase into sentence case', () => {
    expect(readableLabel('AboveNeighbours')).toBe('Above neighbours')
    expect(readableLabel('FollowTrack')).toBe('Follow track')
    expect(readableLabel('GridOrder')).toBe('Grid order')
    expect(readableLabel('EaseOut')).toBe('Ease out')
    expect(readableLabel('Top')).toBe('Top')
  })
})

describe('parseValue', () => {
  it('scalars accept the true minus, a plus, thin spaces and the unit words', () => {
    expect(parseValue('roam.offsetX', `${M}0.25${T}c`)).toBe(-0.25)
    expect(parseValue('roam.offsetX', '+1.5cells')).toBe(1.5)
    expect(parseValue('roam.offsetX', '2')).toBe(2)
    expect(parseValue('roam.scale', 'x2')).toBe(2)
    expect(parseValue('roam.scale', `2${T}×`)).toBe(2)
    expect(parseValue('roam.rotationDeg', '45°')).toBe(45)
    expect(parseValue('roam.rotationDeg', '-90 deg')).toBe(-90)
    expect(parseValue('mask.opacity', '50')).toBe(0.5)
    expect(parseValue('mask.opacity', `50${T}%`)).toBe(0.5)
    expect(parseValue('mask.feather', '0.1 c')).toBe(0.1)
    expect(parseValue('roam.offsetX', 'abc')).toBeNull()
    expect(parseValue('roam.offsetX', '')).toBeNull()
    expect(parseValue('roam.offsetX', '1..2')).toBeNull()
  })

  it('round-trips what formatValue prints', () => {
    const cases = [['roam.offsetX', -1.25], ['roam.scale', 3.5], ['roam.rotationDeg', -720], ['mask.opacity', 0.37],
      ['mask.expansion', -0.125], ['sweep.centerY', 0.75], ['clipLens.zoom', 0.25]]
    for (const [id, v] of cases) expect(parseValue(id, formatValue(id, v)), id).toBeCloseTo(v, 6)
  })

  it('pickers: options by value or label, bools, shutter angles', () => {
    expect(parseValue('roam.layer', 'above neighbours')).toBe('AboveNeighbours')
    expect(parseValue('roam.layer', 'Top')).toBe('Top')
    expect(parseValue('roam.layer', 'Bottom')).toBeNull()
    expect(parseValue('mask.invert', 'off')).toBe(false)
    expect(parseValue('mask.invert', 'On')).toBe(true)
    expect(parseValue('roam.motionBlur', '180°')).toBe(180)
    expect(parseValue('roam.motionBlur', 'Off')).toBe(0)
    expect(parseValue('roam.motionBlur', '400')).toBeNull()
  })
})

describe('numberBoxProps', () => {
  it('offsets: bipolar ±8 cells at 50 px per cell, reset to 0', () => {
    const p = numberBoxProps('roam.offsetX')
    expect(p).toMatchObject({ label: 'Offset X', min: -8, max: 8, pxPerRange: 800, bipolar: true, centre: 0, defaultValue: 0 })
    expect(p.format(1)).toBe(`+1.00${T}c`)
    expect(p.parse('1 c')).toBe(1)
  })

  it('multipliers are log scales with the identity as the reset', () => {
    const p = numberBoxProps('roam.scale')
    expect(p.min).toBeUndefined()
    expect(p.defaultValue).toBe(1)
    expect(p.pxPerRange).toBe(200)
    expect(p.scale.toNorm(0.05)).toBe(0)
    expect(p.scale.toNorm(16)).toBe(1)
    expect(p.scale.fromNorm(0.5)).toBeCloseTo(Math.sqrt(0.05 * 16), 9)
  })

  it('rotation 2 px per degree (RoamPanel / LensPanel); positions; layers', () => {
    expect(numberBoxProps('roam.rotationDeg').pxPerRange).toBe(2880)
    expect(numberBoxProps('clipLens.rotationDeg').pxPerRange).toBe(1440)
    expect(numberBoxProps('clipLens.centerX')).toMatchObject({ min: 0, max: 1, pxPerRange: 200, defaultValue: 0.5 })
    expect(numberBoxProps('clipLens.centerX').bipolar).toBeUndefined()
    expect(numberBoxProps('sourceLens.centerX', { layer: true })).toMatchObject({ min: -2, max: 2, defaultValue: 0, bipolar: true, centre: 0 })
    expect(numberBoxProps('sourceLens.zoom', { layer: true }).scale.toNorm(0.05)).toBe(0)
    expect(numberBoxProps('mask.feather')).toMatchObject({ min: 0, max: 1, pxPerRange: 400, defaultValue: 0 })
    expect(numberBoxProps('mask.expansion')).toMatchObject({ min: -1, max: 1, pxPerRange: 800, bipolar: true })
    expect(numberBoxProps('mask.opacity')).toMatchObject({ min: 0, max: 1, defaultValue: 1 })
    expect(numberBoxProps('roam.layer')).toBeNull()
  })
})

describe('enumOptions', () => {
  it('readable labels, bools, the blur menu', () => {
    expect(enumOptions('roam.layer')).toEqual([
      { value: 'GridOrder', label: 'Grid order' },
      { value: 'AboveNeighbours', label: 'Above neighbours' },
      { value: 'Top', label: 'Top' },
    ])
    expect(enumOptions('clipLens.flip').map((o) => o.label)).toEqual(['Follow track', 'None', 'Horizontal', 'Vertical'])
    expect(enumOptions('mask.invert')).toEqual([{ value: false, label: 'Off' }, { value: true, label: 'On' }])
    expect(enumOptions('roam.motionBlur').map((o) => o.label)).toEqual(['Off', '90°', '180°', '270°', '360°'])
    expect(enumOptions('mask.shape').map((o) => o.value)).toEqual(['Rectangle', 'Ellipse', 'Path'])
    expect(enumOptions('roam.offsetX')).toEqual([])
  })
})
