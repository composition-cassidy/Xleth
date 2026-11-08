import { describe, expect, it } from 'vitest'
import {
  PITCH_MAX, PITCH_MIN, gridTiers, isBlackKey, pitchAtY, pitchLabel, rowY, rulerMarks, visibleRows,
} from '../pianoRollGeometry.js'

describe('piano roll geometry', () => {
  it('maps rows and pitches both ways, so keys and grid agree', () => {
    for (const [pps, scrollY] of [[14, 0], [12, 96], [6, 333], [40, 1000]]) {
      for (const p of [PITCH_MAX, 72, 60, 61, PITCH_MIN + 1]) {
        const y = rowY(p, pps, scrollY)
        expect(pitchAtY(y + 0.5, pps, scrollY)).toBe(p)
        expect(pitchAtY(y + pps - 0.5, pps, scrollY)).toBe(p)
      }
    }
  })

  it('lists only visible rows, top to bottom', () => {
    const rows = visibleRows(10, 25, 50)
    expect(rows[0].pitch).toBe(PITCH_MAX - 2)
    expect(rows[0].y).toBe(-5)
    expect(rows.at(-1).y).toBeLessThan(50)
    expect(rows.every((r, i) => i === 0 || r.pitch === rows[i - 1].pitch - 1)).toBe(true)
  })

  it('names keys and black keys', () => {
    expect(pitchLabel(60)).toBe('C4')
    expect(pitchLabel(61)).toBe('C#4')
    expect(isBlackKey(61)).toBe(true)
    expect(isBlackKey(64)).toBe(false)
  })

  it('never draws a line tier closer than 6px', () => {
    expect(gridTiers(80)).toEqual({ steps: true, beats: true, barEvery: 1 })
    expect(gridTiers(20)).toEqual({ steps: false, beats: true, barEvery: 1 })   // 5px steps hidden
    expect(gridTiers(24)).toEqual({ steps: true, beats: true, barEvery: 1 })    // 6px steps shown
    expect(gridTiers(1)).toEqual({ steps: false, beats: false, barEvery: 2 })
  })

  it('labels bars, thins them when crowded, and labels beats only with room', () => {
    const wide = rulerMarks(80, 0, 400)
    expect(wide.filter((m) => m.kind === 'bar').map((m) => m.label)).toEqual(['1', '2'])
    expect(wide.find((m) => m.kind === 'beat').label).toBe('1.2')
    const narrow = rulerMarks(20, 0, 600)
    expect(narrow.find((m) => m.kind === 'beat').label).toBeNull()
    const veryNarrow = rulerMarks(5, 0, 600)
    const barLabels = veryNarrow.filter((m) => m.kind === 'bar' && m.label).map((m) => m.label)
    expect(barLabels.slice(0, 3)).toEqual(['1', '3', '5'])
    // Marks share the grid's x: bar 2 at 4 beats.
    expect(rulerMarks(40, 30, 400).find((m) => m.label === '2').x).toBe(130)
  })
})
