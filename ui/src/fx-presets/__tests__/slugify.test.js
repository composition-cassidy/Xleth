import { describe, it, expect } from 'vitest'
import { slugifyPresetName, isSlugSafe } from '../slugify.js'

describe('slugifyPresetName', () => {
  it('lowercases and dashes plain names', () => {
    expect(slugifyPresetName('Hello World')).toBe('hello-world')
    expect(slugifyPresetName('Gentle Glue')).toBe('gentle-glue')
    expect(slugifyPresetName('Punch Master')).toBe('punch-master')
  })

  it('collapses symbol runs and trims to a single dash', () => {
    expect(slugifyPresetName('My  Preset!!!')).toBe('my-preset')
    expect(slugifyPresetName('a___b---c')).toBe('a-b-c')
    expect(slugifyPresetName('50% Mix @ 3:1')).toBe('50-mix-3-1')
  })

  it('trims leading/trailing dots, spaces and dashes', () => {
    expect(slugifyPresetName('  ...Hello...  ')).toBe('hello')
    expect(slugifyPresetName('.hidden.')).toBe('hidden')
    expect(slugifyPresetName('---edge---')).toBe('edge')
  })

  it('never yields empty — falls back to "preset"', () => {
    expect(slugifyPresetName('')).toBe('preset')
    expect(slugifyPresetName('   ')).toBe('preset')
    expect(slugifyPresetName('!!!')).toBe('preset')
    expect(slugifyPresetName(null)).toBe('preset')
    expect(slugifyPresetName(undefined)).toBe('preset')
  })

  it('prefixes Windows reserved device names', () => {
    expect(slugifyPresetName('CON')).toBe('_con')
    expect(slugifyPresetName('nul')).toBe('_nul')
    expect(slugifyPresetName('COM1')).toBe('_com1')
    expect(slugifyPresetName('LPT9')).toBe('_lpt9')
    // Not reserved once it carries more than the device token.
    expect(slugifyPresetName('con job')).toBe('con-job')
  })

  it('strips accents to ASCII and stays within the safe charset', () => {
    const s = slugifyPresetName('Café Déjà Vu')
    expect(s).toMatch(/^[a-z0-9-]+$/)
    expect(s.startsWith('-')).toBe(false)
    expect(s.endsWith('-')).toBe(false)
    expect(s).toContain('cafe')
    expect(s).toContain('vu')
  })

  it('caps length at 64 and re-trims', () => {
    const s = slugifyPresetName('a'.repeat(200))
    expect(s.length).toBeLessThanOrEqual(64)
    expect(s.endsWith('-')).toBe(false)
    const mixed = slugifyPresetName('x'.repeat(63) + ' tail')
    expect(mixed.length).toBeLessThanOrEqual(64)
    expect(mixed.endsWith('-')).toBe(false)
  })

  it('output is always accepted by isSlugSafe', () => {
    for (const name of ['Hello World', 'CON', '', '???', 'Café', 'a'.repeat(200), '.dots.']) {
      expect(isSlugSafe(slugifyPresetName(name))).toBe(true)
    }
  })
})

describe('isSlugSafe', () => {
  it('accepts clean slugs and rejects traversal / separators / bad chars', () => {
    expect(isSlugSafe('gentle-glue')).toBe(true)
    expect(isSlugSafe('_con')).toBe(true)
    expect(isSlugSafe('a1_b-2')).toBe(true)
    expect(isSlugSafe('../evil')).toBe(false)
    expect(isSlugSafe('a/b')).toBe(false)
    expect(isSlugSafe('a.b')).toBe(false)
    expect(isSlugSafe('UPPER')).toBe(false)
    expect(isSlugSafe('')).toBe(false)
    expect(isSlugSafe('x'.repeat(81))).toBe(false)
  })
})
