// Phase 3: chrome never colours the content area. The grid (bar, beat,
// subdivision and snap markers) is drawn in neutral inks only; the accent is
// reserved for selection.
import { describe, expect, it } from 'vitest'
import { drawGrid } from './timelineDrawing.js'

const ACCENT = '#33ced6'
const PALETTE = {
  bg: '#141414',
  laneSeparator: '#3a3a3a',
  patternLaneTint: '#1b1b1b',
  gridMinor: '#2b2b2b',
  gridBeat: '#3a3a3a',
  gridBar: '#5a5a5a',
  accent: ACCENT,
  ink: '#e6e6e6',
  inkDark: '#1b1b1b',
  select: ACCENT,
}

function recordingCtx() {
  const strokes = []
  const fills = []
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'stroke') return () => strokes.push(String(target.strokeStyle))
      if (prop === 'fillRect' || prop === 'fill') return () => fills.push(String(target.fillStyle))
      if (prop === 'measureText') return () => ({ width: 0 })
      return () => {}
    },
    set(target, prop, value) { target[prop] = value; return true },
  })
  return { ctx, strokes, fills }
}

describe('drawGrid uses no accent colour', () => {
  for (const snap of ['1/16', 'Beat', 'Bar']) {
    it(`snap ${snap}: no stroke or fill in the accent`, () => {
      const { ctx, strokes, fills } = recordingCtx()
      drawGrid(ctx, 1200, 400, 0, 120, 8, null, PALETTE, null, snap)
      expect(strokes.length).toBeGreaterThan(0)
      const accentish = [...strokes, ...fills].filter((s) => s.toLowerCase().includes('33ced6') || s.includes('51, 206, 214') || s.includes('51,206,214'))
      expect(accentish).toEqual([])
    })
  }
})
