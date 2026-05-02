import { describe, it, expect, beforeEach } from 'vitest'
import {
  PAD_L, PAD_T, PLOT_H, PLOT_W,
  FREQ_MIN, FREQ_MAX,
  freqToX,
} from '../eqGeometry.js'
import {
  computeSpectrumPaths, resetMaxHold,
  BARS_PER_OCTAVE, FREQ_BAR_EDGES, getBarEdges,
} from '../eqSpectrumPath.js'

const NYQUIST = 24000
const BIN_COUNT = 2048

function flatSpectrum(db) {
  const data = new Float32Array(BIN_COUNT)
  data.fill(db)
  return data
}

function singlePeakSpectrum(peakHz, peakDb, floorDb = -100) {
  const data = new Float32Array(BIN_COUNT)
  data.fill(floorDb)
  const peakBin = Math.round(peakHz * BIN_COUNT / NYQUIST)
  if (peakBin >= 0 && peakBin < BIN_COUNT) data[peakBin] = peakDb
  return data
}

describe('eqSpectrumPath — bar density', () => {
  it('uses 24 bars per octave', () => {
    expect(BARS_PER_OCTAVE).toBe(24)
  })

  it('FREQ_BAR_EDGES spans the full audible range', () => {
    expect(FREQ_BAR_EDGES[0]).toBeCloseTo(FREQ_MIN, 6)
    const last = FREQ_BAR_EDGES[FREQ_BAR_EDGES.length - 1]
    expect(last).toBeGreaterThanOrEqual(FREQ_MAX)
  })

  it('produces ~240 bars across 20 Hz – 20 kHz', () => {
    const numBars = FREQ_BAR_EDGES.length - 1
    expect(numBars).toBeGreaterThanOrEqual(240)
    expect(numBars).toBeLessThanOrEqual(241)
  })
})

describe('eqSpectrumPath — path command guards', () => {
  beforeEach(() => resetMaxHold())

  it('fill path uses only M / L / Z commands (no Bézier smoothing)', () => {
    const { fill, maxHold } = computeSpectrumPaths(flatSpectrum(-40), NYQUIST, 0, true)
    expect(fill.length).toBeGreaterThan(0)
    expect(maxHold.length).toBeGreaterThan(0)
    // Path tokens must contain no Bézier / quadratic / smooth-curve commands.
    expect(fill).not.toMatch(/[CcQqSsTt]/)
    expect(maxHold).not.toMatch(/[CcQqSsTt]/)
    // Only the alphabet M / L / Z is allowed.
    const fillLetters = fill.match(/[A-Za-z]/g) || []
    for (const c of fillLetters) expect('MLZ').toContain(c)
    const holdLetters = maxHold.match(/[A-Za-z]/g) || []
    for (const c of holdLetters) expect('ML').toContain(c)
  })

  it('fill path is closed and starts/ends at the plot baseline', () => {
    const { fill } = computeSpectrumPaths(flatSpectrum(-40), NYQUIST, 0, true)
    const baseline = (PAD_T + PLOT_H).toFixed(1)
    expect(fill).toMatch(new RegExp(`^M ${PAD_L} ${baseline.replace('.', '\\.')}\\b`))
    expect(fill).toMatch(new RegExp(`L ${(PAD_L + PLOT_W).toFixed(1).replace('.', '\\.')} ${baseline.replace('.', '\\.')} Z$`))
  })

  it('returns empty paths for empty input', () => {
    const out = computeSpectrumPaths(new Float32Array(0), NYQUIST, 0, true)
    expect(out.fill).toBe('')
    expect(out.maxHold).toBe('')
  })
})

describe('eqSpectrumPath — peak preservation', () => {
  beforeEach(() => resetMaxHold())

  it('preserves a sharp 1 kHz peak near the expected x-coordinate', () => {
    const peakHz = 1000
    const data = singlePeakSpectrum(peakHz, 0, -100)
    const { fill } = computeSpectrumPaths(data, NYQUIST, 0, true)
    expect(fill.length).toBeGreaterThan(0)

    // Parse all (x, y) points after the opening baseline M.
    const tokens = fill.split(/\s+/)
    const points = []
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]
      if (tok === 'L' && tokens[i + 1] && tokens[i + 2]) {
        const x = parseFloat(tokens[i + 1])
        const y = parseFloat(tokens[i + 2])
        if (!isNaN(x) && !isNaN(y)) points.push({ x, y })
      }
    }

    // The y-minimum (visually highest peak — SVG y grows downward) must be
    // close to the freqToX(1 kHz) column. "Close" allows some spread because
    // a single bin will fall into ~1 bar, but the bar-aggregation may pick
    // it up in the bar containing 1 kHz.
    let minY = Infinity, minX = NaN
    for (const p of points) {
      if (p.y < minY) { minY = p.y; minX = p.x }
    }
    const expectedX = freqToX(peakHz)
    expect(Math.abs(minX - expectedX)).toBeLessThan(15) // ~1 bar width tolerance
  })

  it('flat spectrum produces a flat top with no internal jumps', () => {
    const flatDb = -40
    const { fill } = computeSpectrumPaths(flatSpectrum(flatDb), NYQUIST, 0, true)
    const tokens = fill.split(/\s+/)
    const ys = []
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === 'L' && tokens[i + 1] && tokens[i + 2]) {
        const y = parseFloat(tokens[i + 2])
        if (!isNaN(y)) ys.push(y)
      }
    }
    // Skip the final closing baseline point (last L returns to bottom-right).
    const interior = ys.slice(0, -1)
    expect(interior.length).toBeGreaterThan(100)
    const yMin = Math.min(...interior)
    const yMax = Math.max(...interior)
    expect(yMax - yMin).toBeLessThan(0.15) // pixel drift only
  })
})

describe('eqSpectrumPath — getBarEdges', () => {
  it('produces 120 bars for 12 bars/oct', () => {
    const edges = getBarEdges(12)
    expect(edges.length - 1).toBe(120)
  })

  it('produces 359 bars for 36 bars/oct', () => {
    const edges = getBarEdges(36)
    // ceil((log2(20000) - log2(20)) * 36) = ceil(9.9658 * 36) = ceil(358.77) = 359
    expect(edges.length - 1).toBe(359)
  })

  it('first edge is FREQ_MIN and last is >= FREQ_MAX for all resolutions', () => {
    for (const bpo of [12, 18, 24, 36]) {
      const edges = getBarEdges(bpo)
      expect(edges[0]).toBeCloseTo(20, 6)
      expect(edges[edges.length - 1]).toBeGreaterThanOrEqual(20000)
    }
  })

  it('is memoized — returns the same array reference on repeated calls', () => {
    const a = getBarEdges(18)
    const b = getBarEdges(18)
    expect(a).toBe(b)
  })

  it('FREQ_BAR_EDGES equals getBarEdges(24)', () => {
    expect(FREQ_BAR_EDGES).toBe(getBarEdges(24))
  })
})

describe('eqSpectrumPath — opts parameter', () => {
  beforeEach(() => resetMaxHold())

  it('barsPerOctave=12 produces fewer path L-segments than barsPerOctave=36', () => {
    const countL = path => (path.match(/\bL\b/g) || []).length
    const low = computeSpectrumPaths(flatSpectrum(-40), NYQUIST, 0, true,  { barsPerOctave: 12 })
    resetMaxHold()
    const high = computeSpectrumPaths(flatSpectrum(-40), NYQUIST, 0, false, { barsPerOctave: 36 })
    expect(countL(low.fill)).toBeLessThan(countL(high.fill))
  })

  it('path remains M/L/Z-only with custom barsPerOctave=36', () => {
    const { fill } = computeSpectrumPaths(flatSpectrum(-40), NYQUIST, 0, true, { barsPerOctave: 36 })
    expect(fill).not.toMatch(/[CcQqSsTt]/)
    const letters = fill.match(/[A-Za-z]/g) || []
    for (const c of letters) expect('MLZ').toContain(c)
  })

  it('rangeDb option does not break fill closure', () => {
    const { fill } = computeSpectrumPaths(flatSpectrum(-40), NYQUIST, 0, true, { rangeDb: 60 })
    expect(fill).toMatch(/Z$/)
    expect(fill.startsWith('M')).toBe(true)
  })

  it('default opts produce identical output to the 4-arg signature', () => {
    resetMaxHold()
    const withOpts    = computeSpectrumPaths(flatSpectrum(-40), NYQUIST, 0, true, {})
    resetMaxHold()
    const withoutOpts = computeSpectrumPaths(flatSpectrum(-40), NYQUIST, 0, true)
    expect(withOpts.fill).toBe(withoutOpts.fill)
    expect(withOpts.maxHold).toBe(withoutOpts.maxHold)
  })
})

describe('eqSpectrumPath — theme tokens registered in catalog', () => {
  it('declares all six new EQ spectrum tokens', async () => {
    const { TOKENS } = await import('../../../theming/tokens/catalog.ts')
    const names = TOKENS.map(t => t.name)
    const required = [
      '--theme-eq-spectrum-fill-top',
      '--theme-eq-spectrum-fill-bottom',
      '--theme-eq-spectrum-stroke',
      '--theme-eq-pre-spectrum-fill-top',
      '--theme-eq-pre-spectrum-fill-bottom',
      '--theme-eq-pre-spectrum-stroke',
    ]
    for (const tok of required) expect(names).toContain(tok)
  })

  it('all six tokens belong to the stock-effects.eq subsystem', async () => {
    const { TOKENS } = await import('../../../theming/tokens/catalog.ts')
    const required = [
      '--theme-eq-spectrum-fill-top',
      '--theme-eq-spectrum-fill-bottom',
      '--theme-eq-spectrum-stroke',
      '--theme-eq-pre-spectrum-fill-top',
      '--theme-eq-pre-spectrum-fill-bottom',
      '--theme-eq-pre-spectrum-stroke',
    ]
    for (const name of required) {
      const def = TOKENS.find(t => t.name === name)
      expect(def, `${name} should be registered`).toBeDefined()
      expect(def.subsystem).toBe('stock-effects.eq')
      expect(def.category).toBe('Stock effects')
    }
  })
})
