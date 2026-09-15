// Tests for the Distortion transfer-curve math (distortionPainter.js) and the
// redesigned layout JSON:
//   • Curve math matches XlethDistortionEffect.h's per-mode shapers exactly.
//   • Drive squeezes the transition region toward the center ("zoom into the
//     knee") rather than the curve simply flattening at a fixed x.
//   • Crush produces a genuinely stepped (non-injective) curve; Analog leans
//     off the origin's slope once symmetry > 0.
//   • The shipped layout validates and carries the analytic curve + dimmed
//     mode-conditional knobs.

import { describe, expect, it } from 'vitest'

import distortionLayout from '../../layouts/distortion.json'
import { DISTORTION_MANIFEST } from '../../manifests/distortion.js'
import { validate } from '../../schema/validate.js'
import { resolveFormat } from '../formats.js'
import {
  buildDistortionCurvePoints,
  computeDistortionCoeffs,
  distortionCurveY,
  normalizeDistortionParams,
  shapeSample,
} from '../visualizers/distortionPainter.js'

function collectNodes(root, out = []) {
  if (!root) return out
  out.push(root)
  if (Array.isArray(root.children)) for (const c of root.children) collectNodes(c, out)
  return out
}

// The raw shape as it lives in plugin-ui `params` (manifest param ids).
const RAW_PARAMS = Object.freeze({
  mode: 0, drive: 12, tone: 8000, filter_pos: 1, mix: 100,
  symmetry: 100, bits: 16, downsample: 1,
})

// buildDistortionCurvePoints/computeDistortionCoeffs/distortionCurveY consume
// the already-normalized shape (driveDb/symmetryPct/bitsValue), same as what
// normalizeDistortionParams() hands DistortionCurveNode every frame.
const NORM = Object.freeze(normalizeDistortionParams(RAW_PARAMS))
const DRIVE_LIN_12DB = Math.pow(10, RAW_PARAMS.drive / 20)

// ── Curve math ──────────────────────────────────────────────────────────────

describe('Distortion curve math', () => {
  it('normalizeDistortionParams clamps and defaults out-of-range/missing values', () => {
    expect(normalizeDistortionParams({}, {})).toEqual({ mode: 0, driveDb: 12, symmetryPct: 100, bitsValue: 16 })
    expect(normalizeDistortionParams({ mode: 9, drive: -5, symmetry: 200, bits: 1 }))
      .toEqual({ mode: 6, driveDb: 0, symmetryPct: 100, bitsValue: 2 })
  })

  it('all 7 modes stay within [-1, 1] across the full input domain', () => {
    for (let mode = 0; mode <= 6; mode++) {
      const points = buildDistortionCurvePoints({ ...NORM, mode }, 200)
      for (const { y } of points) {
        expect(Number.isFinite(y)).toBe(true)
        expect(y).toBeGreaterThanOrEqual(-1)
        expect(y).toBeLessThanOrEqual(1)
      }
    }
  })

  it('every mode passes through (or arbitrarily close to) the origin', () => {
    for (let mode = 0; mode <= 6; mode++) {
      const coeffs = computeDistortionCoeffs({ ...NORM, mode })
      expect(Math.abs(distortionCurveY(0, mode, DRIVE_LIN_12DB, coeffs))).toBeLessThan(1e-6)
    }
  })

  it('Hard Clip (mode 2) saturates to the same value near and at the input rail', () => {
    const coeffs = computeDistortionCoeffs(NORM)
    // 1.35 drive trim * driveLin already exceeds the 0.72 clip threshold well
    // before xin=1, so the curve should be flat (clipped) at the right edge.
    const nearRail = distortionCurveY(0.9, 2, DRIVE_LIN_12DB, coeffs)
    const atRail   = distortionCurveY(1.0, 2, DRIVE_LIN_12DB, coeffs)
    expect(nearRail).toBeCloseTo(atRail, 5)
  })

  it('raising drive squeezes the transition region toward the center (zoom into the knee)', () => {
    // For Tube, tanh saturates faster as drive increases, so at a fixed small
    // input the output should move closer to its asymptote.
    const xin = 0.15
    const coeffsLowDrive  = computeDistortionCoeffs({ ...NORM, driveDb: 0 })
    const coeffsHighDrive = computeDistortionCoeffs({ ...NORM, driveDb: 48 })
    const yLow  = Math.abs(distortionCurveY(xin, 0, Math.pow(10, 0 / 20), coeffsLowDrive))
    const yHigh = Math.abs(distortionCurveY(xin, 0, Math.pow(10, 48 / 20), coeffsHighDrive))
    expect(yHigh).toBeGreaterThan(yLow)
  })

  it('Crush (mode 4) is a genuine staircase — many distinct inputs collapse to few outputs', () => {
    const coeffs = computeDistortionCoeffs({ ...NORM, bitsValue: 3 }) // coarse: 4 steps/polarity
    const outputs = new Set()
    for (let i = -50; i <= 50; i++) {
      outputs.add(distortionCurveY(i / 50, 4, DRIVE_LIN_12DB, coeffs).toFixed(6))
    }
    // 101 sampled inputs should NOT produce 101 distinct outputs at 3 bits.
    expect(outputs.size).toBeLessThan(50)
  })

  it('Analog (mode 3) is symmetric at symmetry=0 and leans off-axis as symmetry rises', () => {
    const symmetric = computeDistortionCoeffs({ ...NORM, symmetryPct: 0 })
    const biased     = computeDistortionCoeffs({ ...NORM, symmetryPct: 100 })

    const yPosSym = distortionCurveY(0.5, 3, DRIVE_LIN_12DB, symmetric)
    const yNegSym = distortionCurveY(-0.5, 3, DRIVE_LIN_12DB, symmetric)
    expect(Math.abs(yPosSym + yNegSym)).toBeLessThan(1e-6) // odd symmetry

    const yPosBias = distortionCurveY(0.5, 3, DRIVE_LIN_12DB, biased)
    const yNegBias = distortionCurveY(-0.5, 3, DRIVE_LIN_12DB, biased)
    expect(Math.abs(yPosBias + yNegBias)).toBeGreaterThan(1e-3) // no longer odd
  })

  it('shapeSample handles an unknown mode as a passthrough (defensive default)', () => {
    expect(shapeSample(99, 0.42, computeDistortionCoeffs(NORM))).toBe(0.42)
  })
})

// ── Format ──────────────────────────────────────────────────────────────────

describe('Distortion downsample format', () => {
  it('formats as ×N', () => {
    const fmt = resolveFormat('x0')
    expect(fmt(1)).toBe('×1')
    expect(fmt(40)).toBe('×40')
    expect(fmt(12.4)).toBe('×12')
  })
})

// ── Layout JSON ─────────────────────────────────────────────────────────────

describe('Distortion layout', () => {
  it('validates cleanly against the Distortion manifest', () => {
    const result = validate(JSON.parse(JSON.stringify(distortionLayout)), DISTORTION_MANIFEST)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(collectNodes(result.doc.root).filter((n) => n._invalid)).toEqual([])
  })

  it('is a 2x4 mode grid: 7 real modes plus one reserved placeholder', () => {
    const toggles = collectNodes(distortionLayout.root).filter((n) => n.type === 'toggle' && n.props?.param === 'mode')
    const buttons = collectNodes(distortionLayout.root).filter((n) => n.type === 'button')
    expect(toggles).toHaveLength(7)
    expect(buttons).toHaveLength(1)
  })

  it('carries exactly one distortionCurve node', () => {
    const curves = collectNodes(distortionLayout.root).filter((n) => n.type === 'distortionCurve')
    expect(curves).toHaveLength(1)
  })

  it('preferred panel size is roughly 380x300', () => {
    expect(distortionLayout.panel.preferredSize).toEqual({ width: 380, height: 300 })
  })
})
