import { describe, it, expect } from 'vitest'
import {
  DYN_FIELDS, SPEC_FIELDS,
  getInspectorFields, inspectorHasGR,
} from '../eqInspectorConfig.js'

describe('eqInspectorConfig — field sets', () => {
  it('getInspectorFields(0) returns [] for static mode', () => {
    expect(getInspectorFields(0)).toEqual([])
  })

  it('getInspectorFields(1) returns DYN_FIELDS for dynamic mode', () => {
    expect(getInspectorFields(1)).toBe(DYN_FIELDS)
  })

  it('getInspectorFields(2) returns SPEC_FIELDS for spectral mode', () => {
    expect(getInspectorFields(2)).toBe(SPEC_FIELDS)
  })

  it('DYN_FIELDS contains exactly dyn_thresh, dyn_ratio, dyn_attack, dyn_release', () => {
    const keys = DYN_FIELDS.map(f => f.key)
    expect(keys).toEqual(['dyn_thresh', 'dyn_ratio', 'dyn_attack', 'dyn_release'])
  })

  it('SPEC_FIELDS contains exactly spec_sens, spec_depth, spec_sel, spec_attack, spec_release', () => {
    const keys = SPEC_FIELDS.map(f => f.key)
    expect(keys).toEqual(['spec_sens', 'spec_depth', 'spec_sel', 'spec_attack', 'spec_release'])
  })

  it('every DYN field has label, min, max, step, def, decimals', () => {
    for (const f of DYN_FIELDS) {
      expect(typeof f.label).toBe('string')
      expect(typeof f.min).toBe('number')
      expect(typeof f.max).toBe('number')
      expect(typeof f.step).toBe('number')
      expect(typeof f.def).toBe('number')
      expect(typeof f.decimals).toBe('number')
      expect(f.max).toBeGreaterThan(f.min)
    }
  })

  it('every SPEC field has label, min, max, step, def, decimals', () => {
    for (const f of SPEC_FIELDS) {
      expect(typeof f.label).toBe('string')
      expect(typeof f.min).toBe('number')
      expect(typeof f.max).toBe('number')
      expect(typeof f.step).toBe('number')
      expect(typeof f.def).toBe('number')
      expect(typeof f.decimals).toBe('number')
      expect(f.max).toBeGreaterThan(f.min)
    }
  })

  it('dyn_thresh field has expected min/max/def', () => {
    const f = DYN_FIELDS.find(f => f.key === 'dyn_thresh')
    expect(f.min).toBe(-60)
    expect(f.max).toBe(0)
    expect(f.def).toBe(-20)
  })

  it('spec_sens field has min=0 max=1', () => {
    const f = SPEC_FIELDS.find(f => f.key === 'spec_sens')
    expect(f.min).toBe(0)
    expect(f.max).toBe(1)
  })
})

describe('eqInspectorConfig — GR flag', () => {
  it('inspectorHasGR(1) is true (dynamic bands show GR)', () => {
    expect(inspectorHasGR(1)).toBe(true)
  })

  it('inspectorHasGR(0) is false (static bands have no GR)', () => {
    expect(inspectorHasGR(0)).toBe(false)
  })

  it('inspectorHasGR(2) is false (spectral bands have no GR meter in inspector)', () => {
    expect(inspectorHasGR(2)).toBe(false)
  })
})
