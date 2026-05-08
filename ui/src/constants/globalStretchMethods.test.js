import { describe, expect, it } from 'vitest'
import {
  GLOBAL_STRETCH_METHOD_OPTIONS,
  getGlobalStretchMethodLabel,
  sanitizeGlobalStretchMethod,
} from './globalStretchMethods.js'

describe('globalStretchMethods', () => {
  it('exports the canonical stretch method options', () => {
    expect(GLOBAL_STRETCH_METHOD_OPTIONS).toEqual([
      { value: 2, label: 'Rubber Band' },
      { value: 3, label: 'WSOLA' },
      { value: 1, label: 'TD-PSOLA' },
      { value: 5, label: 'WORLD' },
      { value: 4, label: 'Phase Vocoder' },
    ])
  })

  it('returns the expected label for each method value', () => {
    expect(getGlobalStretchMethodLabel(1)).toBe('TD-PSOLA')
    expect(getGlobalStretchMethodLabel(2)).toBe('Rubber Band')
    expect(getGlobalStretchMethodLabel(3)).toBe('WSOLA')
    expect(getGlobalStretchMethodLabel(4)).toBe('Phase Vocoder')
    expect(getGlobalStretchMethodLabel(5)).toBe('WORLD')
  })

  it('sanitizes invalid values back to TD-PSOLA', () => {
    expect(sanitizeGlobalStretchMethod(0)).toBe(1)
    expect(sanitizeGlobalStretchMethod(6)).toBe(1)
    expect(sanitizeGlobalStretchMethod('bad')).toBe(1)
    expect(sanitizeGlobalStretchMethod(null)).toBe(1)
    expect(sanitizeGlobalStretchMethod(undefined)).toBe(1)
    expect(getGlobalStretchMethodLabel(999)).toBe('TD-PSOLA')
  })
})
