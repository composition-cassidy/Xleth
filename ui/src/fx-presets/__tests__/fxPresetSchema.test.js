import { describe, it, expect } from 'vitest'
import { validatePreset, buildPreset, PRESET_MAGIC, PRESET_VERSION } from '../fxPresetSchema.js'

function apexPreset(overrides = {}) {
  return {
    xlethFxPreset: 1,
    effectType: 'apex',
    name: 'Test',
    created: '2026-08-10T00:00:00.000Z',
    state: { params: { bandmix: 90 } },
    ...overrides,
  }
}

describe('validatePreset', () => {
  it('accepts a well-formed preset', () => {
    const res = validatePreset(apexPreset())
    expect(res.ok).toBe(true)
    expect(res.preset.effectType).toBe('apex')
    expect(res.errors).toEqual([])
  })

  it('passes when the expected effectType matches', () => {
    expect(validatePreset(apexPreset(), 'apex').ok).toBe(true)
  })

  it('REFUSES an effectType mismatch (never silently applies)', () => {
    const res = validatePreset(apexPreset(), 'compressor')
    expect(res.ok).toBe(false)
    expect(res.errors[0].code).toBe('EFFECT_TYPE_MISMATCH')
    expect(res.errors[0].message).toMatch(/is for "apex", not "compressor"/)
  })

  it('rejects a wrong / missing magic', () => {
    expect(validatePreset(apexPreset({ xlethFxPreset: 2 })).errors[0].code).toBe('BAD_MAGIC')
    expect(validatePreset(apexPreset({ xlethFxPreset: undefined })).errors[0].code).toBe('BAD_MAGIC')
  })

  it('rejects a bad or missing effectType', () => {
    expect(validatePreset(apexPreset({ effectType: 'Apex' })).errors[0].code).toBe('BAD_EFFECT_TYPE')
    expect(validatePreset(apexPreset({ effectType: 123 })).errors[0].code).toBe('BAD_EFFECT_TYPE')
  })

  it('rejects a missing / blank name', () => {
    expect(validatePreset(apexPreset({ name: '' })).errors[0].code).toBe('MISSING_NAME')
    expect(validatePreset(apexPreset({ name: '   ' })).errors[0].code).toBe('MISSING_NAME')
  })

  it('rejects a missing or empty state object', () => {
    expect(validatePreset(apexPreset({ state: undefined })).errors[0].code).toBe('MISSING_STATE')
    expect(validatePreset(apexPreset({ state: [] })).errors[0].code).toBe('MISSING_STATE')
    expect(validatePreset(apexPreset({ state: {} })).errors[0].code).toBe('EMPTY_STATE')
  })

  it('rejects non-object input', () => {
    expect(validatePreset(null).errors[0].code).toBe('BAD_INPUT')
    expect(validatePreset('nope').errors[0].code).toBe('BAD_INPUT')
    expect(validatePreset([]).errors[0].code).toBe('BAD_INPUT')
  })
})

describe('buildPreset', () => {
  it('builds a valid envelope with an ISO created stamp', () => {
    const p = buildPreset('compressor', 'Glue', { params: { ratio: 2 } })
    expect(p[PRESET_MAGIC]).toBe(PRESET_VERSION)
    expect(p.effectType).toBe('compressor')
    expect(p.name).toBe('Glue')
    expect(Number.isNaN(Date.parse(p.created))).toBe(false)
    expect(validatePreset(p, 'compressor').ok).toBe(true)
  })

  it('omits author when falsy, includes it when given', () => {
    expect('author' in buildPreset('apex', 'x', { params: {} })).toBe(false)
    expect(buildPreset('apex', 'x', { params: {} }, 'me').author).toBe('me')
  })
})
