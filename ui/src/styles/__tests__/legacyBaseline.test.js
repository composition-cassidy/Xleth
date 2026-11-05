// The legacy-CSS ratchet, enforced by the unit suite as well as by
// `npm run check:legacy-css`: src/styles/app.css may shrink but never grow.
import { describe, expect, it } from 'vitest'
import { countLines, currentLines, evaluate, readBaseline } from '../../../scripts/legacy-css-lib.mjs'

describe('legacy CSS baseline', () => {
  it('app.css has no more lines than scripts/legacy-css-baseline.json allows', () => {
    const baseline = readBaseline()
    expect(baseline.file).toBe('src/styles/app.css')
    const lines = currentLines(baseline)
    expect(
      evaluate(lines, baseline.maxLines).status,
      `app.css is ${lines} lines, baseline ${baseline.maxLines}: legacy CSS is frozen; new styles go in ui-kit/`,
    ).not.toBe('over')
  })

  it('counts lines like wc -l', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a\n')).toBe(1)
    expect(countLines('a\nb\n')).toBe(2)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('a\r\nb\r\n')).toBe(2)
  })

  it('evaluate() only ever fails when the file grows', () => {
    expect(evaluate(101, 100)).toEqual({ status: 'over', delta: 1 })
    expect(evaluate(100, 100)).toEqual({ status: 'equal', delta: 0 })
    expect(evaluate(90, 100)).toEqual({ status: 'under', delta: 10 })
  })
})
