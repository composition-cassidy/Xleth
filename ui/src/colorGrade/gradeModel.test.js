import { describe, expect, it } from 'vitest'
import {
  applyAuto, autoIsNoOp, curveIsIdentity, describeGrade, gradesEqual, isActive, isNeutral,
  neutralGrade, normalizeGrade, resetGrade, resetSection, sameTarget, sectionIsNeutral, targetKey,
} from './gradeModel.js'
import { canPaste } from './gradeActions.js'

describe('neutral', () => {
  it('a fresh grade is neutral and not active', () => {
    const g = neutralGrade()
    expect(isNeutral(g)).toBe(true)
    expect(isActive(g)).toBe(false)
  })

  it('an explicit diagonal and a LUT at amount 0 are neutral', () => {
    const g = neutralGrade()
    g.curves.master = [[0, 0], [1, 1]]
    g.lut = { path: 'look.cube', amount: 0 }
    expect(curveIsIdentity(g.curves.master)).toBe(true)
    expect(isNeutral(g)).toBe(true)
  })

  it('every control on its own makes the grade not neutral', () => {
    const scalar = ['exposure', 'contrast', 'saturation', 'vibrance', 'temperature', 'tint', 'hue']
    for (const k of scalar) expect(isNeutral({ ...neutralGrade(), [k]: 0.1 })).toBe(false)
    for (const k of ['lift', 'gamma', 'gain']) {
      expect(isNeutral({ ...neutralGrade(), [k]: { x: 0, y: 0, lum: 0.1 } })).toBe(false)
      expect(isNeutral({ ...neutralGrade(), [k]: { x: 0.1, y: 0, lum: 0 } })).toBe(false)
    }
    const curve = neutralGrade()
    curve.curves.g = [[0, 0.1], [1, 1]]
    expect(isNeutral(curve)).toBe(false)
    expect(isNeutral({ ...neutralGrade(), lut: { path: 'look.cube', amount: 1 } })).toBe(false)
  })

  it('switching a grade off keeps its values and stops it rendering', () => {
    const g = { ...neutralGrade(), exposure: 1, bypassed: true }
    expect(isNeutral(g)).toBe(false)
    expect(isActive(g)).toBe(false)
  })
})

describe('normalizeGrade', () => {
  it('fills what the engine left out and survives garbage', () => {
    expect(normalizeGrade(null)).toEqual(neutralGrade())
    expect(normalizeGrade('nope')).toEqual(neutralGrade())
    const g = normalizeGrade({ exposure: 0.5, lift: { lum: -0.2 }, curves: { r: [[0, 0.1], { x: 1, y: 0.9 }, 'x'] } })
    expect(g.exposure).toBe(0.5)
    expect(g.lift).toEqual({ x: 0, y: 0, lum: -0.2 })
    expect(g.curves.r).toEqual([[0, 0.1], [1, 0.9]])
    expect(g.curves.master).toEqual([])
    expect(g.lut).toEqual({ path: '', amount: 1 })
  })
})

describe('gradesEqual', () => {
  it('treats the two spellings of the diagonal as the same curve', () => {
    const a = neutralGrade()
    const b = neutralGrade()
    b.curves.master = [[0, 0], [1, 1]]
    expect(gradesEqual(a, b)).toBe(true)
  })

  it('sees a changed point, a changed wheel and the on/off switch', () => {
    const a = neutralGrade()
    a.curves.b = [[0, 0], [0.5, 0.6], [1, 1]]
    const b = normalizeGrade(a)
    expect(gradesEqual(a, b)).toBe(true)
    b.curves.b[1][1] = 0.61
    expect(gradesEqual(a, b)).toBe(false)
    expect(gradesEqual(neutralGrade(), { ...neutralGrade(), gain: { x: 0, y: 0.1, lum: 0 } })).toBe(false)
    expect(gradesEqual(neutralGrade(), { ...neutralGrade(), bypassed: true })).toBe(false)
  })
})

describe('resets', () => {
  const full = () => normalizeGrade({
    bypassed: true,
    exposure: 1, contrast: 0.2, hue: 10,
    lift: { x: 0.1, y: 0, lum: 0.2 },
    curves: { master: [[0, 0], [0.5, 0.7], [1, 1]] },
    lut: { path: 'look.cube', amount: 0.5 },
  })

  it('reset one section and leave the others', () => {
    const g = resetSection(full(), 'basics')
    expect(sectionIsNeutral(g, 'basics')).toBe(true)
    expect(sectionIsNeutral(g, 'wheels')).toBe(false)
    expect(sectionIsNeutral(g, 'curves')).toBe(false)
    expect(g.lut.path).toBe('look.cube')

    expect(sectionIsNeutral(resetSection(full(), 'wheels'), 'wheels')).toBe(true)
    expect(sectionIsNeutral(resetSection(full(), 'curves'), 'curves')).toBe(true)
    expect(resetSection(full(), 'lut').lut).toEqual({ path: '', amount: 1 })
  })

  it('reset the whole grade but keep whether it is on', () => {
    const g = resetGrade(full())
    expect(isNeutral(g)).toBe(true)
    expect(g.bypassed).toBe(true)
  })

  it('never mutates the grade it was given', () => {
    const before = full()
    resetSection(before, 'curves')
    resetGrade(before)
    expect(before).toEqual(full())
  })
})

describe('Auto', () => {
  const auto = normalizeGrade({
    lift: { x: -0.2, y: 0.1, lum: -0.6 }, gain: { x: 0, y: 0, lum: 0.4 }, vibrance: 0.3,
  })
  const base = normalizeGrade({
    exposure: 0.5, lift: { x: 0, y: 0, lum: 0.9 }, curves: { master: [[0, 0], [0.5, 0.6], [1, 1]] },
  })

  it('strength 1 is the full correction, strength 0 is none of it', () => {
    const full = applyAuto(base, auto, 1)
    expect(full.lift).toEqual(auto.lift)
    expect(full.gain).toEqual(auto.gain)
    expect(full.vibrance).toBe(0.3)
    const none = applyAuto(base, auto, 0)
    expect(none.lift).toEqual({ x: 0, y: 0, lum: 0 })
    expect(none.vibrance).toBe(0)
  })

  it('scales in between and leaves every control it does not own alone', () => {
    const half = applyAuto(base, auto, 0.5)
    expect(half.lift.lum).toBeCloseTo(-0.3, 6)
    expect(half.gain.lum).toBeCloseTo(0.2, 6)
    expect(half.vibrance).toBeCloseTo(0.15, 6)
    expect(half.exposure).toBe(0.5)
    expect(half.curves.master).toEqual(base.curves.master)
  })

  it('knows when Auto would change nothing', () => {
    expect(autoIsNoOp(neutralGrade())).toBe(true)
    expect(autoIsNoOp(auto)).toBe(false)
  })
})

describe('targets, summary line, paste rules', () => {
  it('keys a target; Master has no id', () => {
    expect(targetKey({ level: 'source', id: 3 })).toBe('source:3')
    expect(targetKey({ level: 'master' })).toBe('master')
    expect(targetKey(null)).toBe('')
    expect(sameTarget({ level: 'master', id: 9 }, { level: 'master' })).toBe(true)
    expect(sameTarget({ level: 'clip', id: 1 }, { level: 'region', id: 1 })).toBe(false)
  })

  it('names what a grade changes', () => {
    expect(describeGrade(neutralGrade())).toEqual([])
    const g = normalizeGrade({ exposure: 1, curves: { r: [[0, 0.1], [1, 1]] } })
    expect(describeGrade(g)).toEqual(['Basics', 'Curves'])
  })

  it('pastes to the same level; a clip and a sample count as one level', () => {
    const copied = (level) => ({ grade: neutralGrade(), level })
    expect(canPaste(copied('source'), 'source')).toBe(true)
    expect(canPaste(copied('source'), 'layer')).toBe(false)
    expect(canPaste(copied('clip'), 'region')).toBe(true)
    expect(canPaste(copied('region'), 'clip')).toBe(true)
    expect(canPaste(copied('master'), 'master')).toBe(true)
    expect(canPaste({ grade: null, level: null }, 'source')).toBe(false)
  })
})
