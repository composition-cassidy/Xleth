import { describe, expect, it } from 'vitest'
import {
  TRACK_PALETTE_FALLBACK,
  buildResolvedTrackColorMap,
  isValidTrackCustomColor,
  normalizeTrackColorAssignment,
  normalizeTrackCustomColor,
  normalizeTrackPalette,
  resolveTrackColor,
  sanitizeTrackColorMode,
  sanitizeTrackColorSlot,
} from '../trackColorResolver.js'

const PALETTE = [
  '#000001', '#000002', '#000003', '#000004',
  '#000005', '#000006', '#000007', '#000008',
  '#000009', '#00000A', '#00000B', '#00000C',
  '#00000D', '#00000E', '#00000F', '#000010',
]

describe('sanitizeTrackColorMode', () => {
  it('accepts auto, paletteSlot, and custom literals', () => {
    expect(sanitizeTrackColorMode('auto')).toBe('auto')
    expect(sanitizeTrackColorMode('paletteSlot')).toBe('paletteSlot')
    expect(sanitizeTrackColorMode('custom')).toBe('custom')
  })

  it('coerces unknown strings to auto', () => {
    expect(sanitizeTrackColorMode('rainbow')).toBe('auto')
    expect(sanitizeTrackColorMode('')).toBe('auto')
  })

  it('coerces non-strings to auto', () => {
    expect(sanitizeTrackColorMode(undefined)).toBe('auto')
    expect(sanitizeTrackColorMode(null)).toBe('auto')
    expect(sanitizeTrackColorMode(5)).toBe('auto')
    expect(sanitizeTrackColorMode({ mode: 'paletteSlot' })).toBe('auto')
  })
})

describe('sanitizeTrackColorSlot', () => {
  it('accepts integers in 1..16', () => {
    expect(sanitizeTrackColorSlot(1)).toBe(1)
    expect(sanitizeTrackColorSlot(8)).toBe(8)
    expect(sanitizeTrackColorSlot(16)).toBe(16)
  })

  it('truncates fractional numbers in range', () => {
    expect(sanitizeTrackColorSlot(5.7)).toBe(5)
  })

  it('rejects out-of-range values', () => {
    expect(sanitizeTrackColorSlot(0)).toBe(null)
    expect(sanitizeTrackColorSlot(17)).toBe(null)
    expect(sanitizeTrackColorSlot(-3)).toBe(null)
  })

  it('rejects non-numbers and non-finite values', () => {
    expect(sanitizeTrackColorSlot('5')).toBe(null)
    expect(sanitizeTrackColorSlot(null)).toBe(null)
    expect(sanitizeTrackColorSlot(undefined)).toBe(null)
    expect(sanitizeTrackColorSlot(NaN)).toBe(null)
    expect(sanitizeTrackColorSlot(Infinity)).toBe(null)
  })
})

describe('isValidTrackCustomColor (Pass 6F)', () => {
  it('accepts #RRGGBB uppercase', () => {
    expect(isValidTrackCustomColor('#4CC9F0')).toBe(true)
    expect(isValidTrackCustomColor('#FF00AA')).toBe(true)
    expect(isValidTrackCustomColor('#000000')).toBe(true)
    expect(isValidTrackCustomColor('#FFFFFF')).toBe(true)
  })

  it('accepts #rrggbb lowercase and mixed case', () => {
    expect(isValidTrackCustomColor('#4cc9f0')).toBe(true)
    expect(isValidTrackCustomColor('#FF00aa')).toBe(true)
  })

  it('rejects #RGB short form', () => {
    expect(isValidTrackCustomColor('#FFF')).toBe(false)
    expect(isValidTrackCustomColor('#abc')).toBe(false)
  })

  it('rejects rgb()/rgba()/var()/hsl()', () => {
    expect(isValidTrackCustomColor('rgb(0,0,0)')).toBe(false)
    expect(isValidTrackCustomColor('rgba(0,0,0,1)')).toBe(false)
    expect(isValidTrackCustomColor('var(--theme-accent)')).toBe(false)
    expect(isValidTrackCustomColor('hsl(0,0%,0%)')).toBe(false)
  })

  it('rejects empty / null / undefined / non-string', () => {
    expect(isValidTrackCustomColor('')).toBe(false)
    expect(isValidTrackCustomColor(null)).toBe(false)
    expect(isValidTrackCustomColor(undefined)).toBe(false)
    expect(isValidTrackCustomColor(0xFF00AA)).toBe(false)
    expect(isValidTrackCustomColor({})).toBe(false)
    expect(isValidTrackCustomColor([])).toBe(false)
  })

  it('rejects too-short / too-long / bad-hex-chars', () => {
    expect(isValidTrackCustomColor('#12345')).toBe(false)
    expect(isValidTrackCustomColor('#1234567')).toBe(false)
    expect(isValidTrackCustomColor('#GGGGGG')).toBe(false)
    expect(isValidTrackCustomColor('4CC9F0')).toBe(false)
    expect(isValidTrackCustomColor('##4CC9F0')).toBe(false)
  })
})

describe('normalizeTrackCustomColor (Pass 6F)', () => {
  it('uppercases lowercase hex', () => {
    expect(normalizeTrackCustomColor('#4cc9f0')).toBe('#4CC9F0')
    expect(normalizeTrackCustomColor('#abcdef')).toBe('#ABCDEF')
  })

  it('preserves uppercase hex', () => {
    expect(normalizeTrackCustomColor('#4CC9F0')).toBe('#4CC9F0')
    expect(normalizeTrackCustomColor('#FF00AA')).toBe('#FF00AA')
  })

  it('preserves digits unchanged', () => {
    expect(normalizeTrackCustomColor('#012345')).toBe('#012345')
  })

  it('returns null for invalid input', () => {
    expect(normalizeTrackCustomColor('rgb(0,0,0)')).toBe(null)
    expect(normalizeTrackCustomColor('#FFF')).toBe(null)
    expect(normalizeTrackCustomColor('')).toBe(null)
    expect(normalizeTrackCustomColor(null)).toBe(null)
    expect(normalizeTrackCustomColor(undefined)).toBe(null)
  })
})

describe('normalizeTrackColorAssignment', () => {
  it('returns auto for missing fields', () => {
    expect(normalizeTrackColorAssignment({}))
      .toEqual({ mode: 'auto', slot: null, customColor: null })
    expect(normalizeTrackColorAssignment(undefined))
      .toEqual({ mode: 'auto', slot: null, customColor: null })
  })

  it('returns auto for invalid mode values', () => {
    expect(normalizeTrackColorAssignment({ trackColorMode: 'rainbow', trackColorSlot: 5 }))
      .toEqual({ mode: 'auto', slot: null, customColor: null })
  })

  it('preserves a valid paletteSlot assignment in 1..16', () => {
    expect(normalizeTrackColorAssignment({ trackColorMode: 'paletteSlot', trackColorSlot: 1 }))
      .toEqual({ mode: 'paletteSlot', slot: 1, customColor: null })
    expect(normalizeTrackColorAssignment({ trackColorMode: 'paletteSlot', trackColorSlot: 16 }))
      .toEqual({ mode: 'paletteSlot', slot: 16, customColor: null })
  })

  it('falls back to auto when paletteSlot has invalid slot', () => {
    expect(normalizeTrackColorAssignment({ trackColorMode: 'paletteSlot', trackColorSlot: 0 }))
      .toEqual({ mode: 'auto', slot: null, customColor: null })
    expect(normalizeTrackColorAssignment({ trackColorMode: 'paletteSlot', trackColorSlot: 17 }))
      .toEqual({ mode: 'auto', slot: null, customColor: null })
    expect(normalizeTrackColorAssignment({ trackColorMode: 'paletteSlot', trackColorSlot: '3' }))
      .toEqual({ mode: 'auto', slot: null, customColor: null })
    expect(normalizeTrackColorAssignment({ trackColorMode: 'paletteSlot', trackColorSlot: null }))
      .toEqual({ mode: 'auto', slot: null, customColor: null })
    expect(normalizeTrackColorAssignment({ trackColorMode: 'paletteSlot' }))
      .toEqual({ mode: 'auto', slot: null, customColor: null })
  })

  it('drops slot when mode is auto', () => {
    expect(normalizeTrackColorAssignment({ trackColorMode: 'auto', trackColorSlot: 8 }))
      .toEqual({ mode: 'auto', slot: null, customColor: null })
  })

  it('returns custom assignment for valid hex (uppercased)', () => {
    expect(normalizeTrackColorAssignment({ trackColorMode: 'custom', trackColorCustom: '#4cc9f0' }))
      .toEqual({ mode: 'custom', slot: null, customColor: '#4CC9F0' })
    expect(normalizeTrackColorAssignment({ trackColorMode: 'custom', trackColorCustom: '#FF00AA' }))
      .toEqual({ mode: 'custom', slot: null, customColor: '#FF00AA' })
  })

  it('falls back to auto when custom mode has invalid hex', () => {
    expect(normalizeTrackColorAssignment({ trackColorMode: 'custom', trackColorCustom: 'rgb(0,0,0)' }))
      .toEqual({ mode: 'auto', slot: null, customColor: null })
    expect(normalizeTrackColorAssignment({ trackColorMode: 'custom', trackColorCustom: '#FFF' }))
      .toEqual({ mode: 'auto', slot: null, customColor: null })
  })

  it('falls back to auto when custom mode is missing hex', () => {
    expect(normalizeTrackColorAssignment({ trackColorMode: 'custom' }))
      .toEqual({ mode: 'auto', slot: null, customColor: null })
  })

  it('drops customColor when mode is paletteSlot', () => {
    expect(normalizeTrackColorAssignment({
      trackColorMode: 'paletteSlot',
      trackColorSlot: 5,
      trackColorCustom: '#FF00AA',
    })).toEqual({ mode: 'paletteSlot', slot: 5, customColor: null })
  })

  it('drops customColor when mode is auto', () => {
    expect(normalizeTrackColorAssignment({ trackColorMode: 'auto', trackColorCustom: '#FF00AA' }))
      .toEqual({ mode: 'auto', slot: null, customColor: null })
  })
})

describe('resolveTrackColor', () => {
  it('uses visible-index auto when no metadata is present', () => {
    expect(resolveTrackColor({ id: 1 }, 0, PALETTE, '#fallback')).toBe('#000001')
    expect(resolveTrackColor({ id: 2 }, 1, PALETTE, '#fallback')).toBe('#000002')
  })

  it('honors a valid paletteSlot assignment regardless of visible index', () => {
    const track = { id: 7, trackColorMode: 'paletteSlot', trackColorSlot: 5 }
    expect(resolveTrackColor(track, 0,  PALETTE, '#fallback')).toBe('#000005')
    expect(resolveTrackColor(track, 12, PALETTE, '#fallback')).toBe('#000005')
  })

  it('falls back to auto when paletteSlot is invalid', () => {
    const track = { id: 9, trackColorMode: 'paletteSlot', trackColorSlot: 99 }
    expect(resolveTrackColor(track, 3, PALETTE, '#fallback')).toBe('#000004')
  })

  it('wraps auto past the palette length', () => {
    expect(resolveTrackColor({ id: 1 }, 16, PALETTE, '#fallback')).toBe('#000001')
    expect(resolveTrackColor({ id: 2 }, 17, PALETTE, '#fallback')).toBe('#000002')
  })

  it('falls back to TRACK_PALETTE_FALLBACK when palette is empty', () => {
    expect(resolveTrackColor({ id: 1 }, 0, [], '#fallback'))
      .toBe(TRACK_PALETTE_FALLBACK[0])
  })

  it('returns custom hex regardless of palette/visibleIndex (Pass 6F)', () => {
    const track = { id: 11, trackColorMode: 'custom', trackColorCustom: '#FF00AA' }
    expect(resolveTrackColor(track, 0, PALETTE, '#fallback')).toBe('#FF00AA')
    expect(resolveTrackColor(track, 7, PALETTE, '#fallback')).toBe('#FF00AA')
    expect(resolveTrackColor(track, 99, PALETTE, '#fallback')).toBe('#FF00AA')
  })

  it('uppercases custom hex on resolve (Pass 6F)', () => {
    const track = { id: 11, trackColorMode: 'custom', trackColorCustom: '#abcdef' }
    expect(resolveTrackColor(track, 0, PALETTE, '#fallback')).toBe('#ABCDEF')
  })

  it('falls back to auto when custom mode has invalid hex (Pass 6F)', () => {
    const track = { id: 11, trackColorMode: 'custom', trackColorCustom: 'rgb(0,0,0)' }
    expect(resolveTrackColor(track, 2, PALETTE, '#fallback')).toBe('#000003')
  })

  it('falls back to auto when custom mode has missing hex (Pass 6F)', () => {
    const track = { id: 11, trackColorMode: 'custom' }
    expect(resolveTrackColor(track, 4, PALETTE, '#fallback')).toBe('#000005')
  })
})

describe('buildResolvedTrackColorMap', () => {
  it('returns {} for empty/missing tracks', () => {
    expect(buildResolvedTrackColorMap([], PALETTE)).toEqual({})
    expect(buildResolvedTrackColorMap(undefined, PALETTE)).toEqual({})
  })

  it('uses visible-index auto when metadata is missing', () => {
    const tracks = [{ id: 10 }, { id: 20 }, { id: 30 }]
    const map = buildResolvedTrackColorMap(tracks, PALETTE)
    expect(map).toEqual({ 10: '#000001', 20: '#000002', 30: '#000003' })
  })

  it('overrides visible index when paletteSlot is valid', () => {
    const tracks = [
      { id: 10 },
      { id: 20, trackColorMode: 'paletteSlot', trackColorSlot: 5 },
      { id: 30 },
    ]
    const map = buildResolvedTrackColorMap(tracks, PALETTE)
    expect(map[10]).toBe('#000001')
    expect(map[20]).toBe('#000005')
    expect(map[30]).toBe('#000003')
  })

  it('falls back to auto when paletteSlot is invalid', () => {
    const tracks = [
      { id: 10, trackColorMode: 'paletteSlot', trackColorSlot: 0 },
      { id: 20, trackColorMode: 'paletteSlot', trackColorSlot: 17 },
    ]
    const map = buildResolvedTrackColorMap(tracks, PALETTE)
    expect(map[10]).toBe('#000001')
    expect(map[20]).toBe('#000002')
  })

  it('wraps auto past slot 16', () => {
    const tracks = Array.from({ length: 18 }, (_, i) => ({ id: 100 + i }))
    const map = buildResolvedTrackColorMap(tracks, PALETTE)
    expect(map[100 + 16]).toBe(PALETTE[0])
    expect(map[100 + 17]).toBe(PALETTE[1])
  })

  it('mixes custom, paletteSlot, and auto tracks (Pass 6F)', () => {
    const tracks = [
      { id: 10, trackColorMode: 'custom', trackColorCustom: '#FF00AA' },
      { id: 20, trackColorMode: 'paletteSlot', trackColorSlot: 5 },
      { id: 30 },
      { id: 40, trackColorMode: 'custom', trackColorCustom: 'rgb(0,0,0)' },
    ]
    const map = buildResolvedTrackColorMap(tracks, PALETTE)
    expect(map[10]).toBe('#FF00AA')          // custom honored
    expect(map[20]).toBe('#000005')          // paletteSlot 5
    expect(map[30]).toBe('#000003')          // visible index 2
    expect(map[40]).toBe('#000004')          // invalid custom → visible index 3
  })
})

describe('normalizeTrackPalette (Pass 6C invariant)', () => {
  it('replaces invalid entries with TRACK_PALETTE_FALLBACK', () => {
    const result = normalizeTrackPalette([null, 'oops', '#1234567'])
    expect(result).toHaveLength(16)
    expect(result[0]).toBe(TRACK_PALETTE_FALLBACK[0])
    expect(result[1]).toBe(TRACK_PALETTE_FALLBACK[1])
    expect(result[2]).toBe(TRACK_PALETTE_FALLBACK[2])
  })

  it('preserves valid #RRGGBB hex values', () => {
    expect(normalizeTrackPalette(PALETTE)[5]).toBe('#000006')
  })
})
