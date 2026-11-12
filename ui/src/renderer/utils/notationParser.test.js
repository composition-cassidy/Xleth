import { describe, expect, it } from 'vitest'
import { parseNotation } from './notationParser.js'

describe('parseNotation 32nd offsets', () => {
  it('applies a single number to every 32nd symbol and leaves plain steps at 0', () => {
    const { placements } = parseNotation("1'2", 2, 0, 40)
    expect(placements.map((p) => p.audioOffsetPercent)).toEqual([40, 0])
  })

  it('gives each syllable its own offset when handed a function', () => {
    const offsets = [10, 60, 90]
    const { placements } = parseNotation("1'2'3'2x", 3, 0, (i) => offsets[i])
    expect(placements.map((p) => [p.syllableIndex, p.audioOffsetPercent])).toEqual([
      [0, 10], [1, 60], [2, 90], [1, 60], [1, 60],
    ])
  })

  it('keeps plain and starred steps at the syllable start whatever the offset is', () => {
    const { placements } = parseNotation('1 2*'.replace(' ', ''), 2, 0, () => 75)
    expect(placements.map((p) => p.audioOffsetPercent)).toEqual([0, 0])
  })
})
