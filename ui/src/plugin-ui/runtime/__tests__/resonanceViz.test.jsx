// Tests for the Resonance Suppressor visualization, layout shell, and the
// draggable focus-curve overlay:
//   • Painters render without throwing for empty rings, populated rings, and
//     rings carrying NaN/Inf bucket values.
//   • The shipped layout validates against the manifest, has no sidechain
//     references, and declares the editable resonanceCurve overlay on the
//     visualizer node.
//   • Coordinate mapping helpers round-trip and clamp at all boundary cases.
//   • Pure drag-update helper writes only to the expected wc_* params and
//     clamps to manifest ranges.
//   • Overlay component renders all six handles into static HTML when the
//     PluginUIContext provides hydrated params.

import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  RESONANCE_PRESETS,
  RESONANCE_VISUALIZER_PRESETS,
  RESONANCE_SOURCE_DEFAULT_PRESET,
  drawResonanceCombined,
  drawResonanceSpectrum,
  drawResonanceReduction,
  drawResonanceWeighting,
} from '../visualizers/resonancePainter.js'
import {
  freqToX, xToFreq,
  gainToY, yToGain,
  clampHp, clampLp, clampBellFreq, clampBellGain, clampBandQ, clampBandType,
  computeDragParamUpdates,
  BELL_HANDLES,
  BAND_HANDLES,
  BAND_TYPE,
  BAND_TYPE_OPTIONS,
  BAND_Q_MIN, BAND_Q_MAX,
  HP_MIN_HZ, HP_MAX_HZ,
  LP_MIN_HZ, LP_MAX_HZ,
  BELL_FREQ_MIN_HZ, BELL_FREQ_MAX_HZ,
  BELL_GAIN_MIN_DB, BELL_GAIN_MAX_DB,
  NUM_BANDS,
  bandParamIds,
  findFirstInactiveBandIndex,
  getActiveBandIndices,
} from '../visualizers/resonanceCurveMapping.js'
import ResonanceCurveOverlay, {
  ResonanceBandEditorStrip,
  buildBandEditorModel,
  createAddBandAction,
  createRemoveBandAction,
  createBandTypeAction,
  createBandGainAction,
  isBandWidthEditable,
} from '../components/ResonanceCurveOverlay.jsx'
import { PluginUIContext } from '../PluginUIContext.js'
import { RESONANCE_SUPPRESSOR_MANIFEST } from '../../manifests/resonancesuppressor.js'
import resonanceLayout from '../../layouts/resonancesuppressor.json'
import { validate } from '../../schema/validate.js'

// ── Helpers ────────────────────────────────────────────────────────────────

function buildBucket(seed, opts = {}) {
  const N = 128
  const spectrum  = new Array(N)
  const reduction = new Array(N)
  const weighting = new Array(N)
  for (let i = 0; i < N; i++) {
    spectrum[i]  = (Math.sin((i + seed) * 0.07) + 1) * 0.5
    reduction[i] = Math.max(0, Math.sin((i + seed) * 0.11)) * 0.6
    weighting[i] = 1 + Math.sin(i * 0.05) * 0.5
  }
  return {
    sampleRate: 48000,
    fftSize: 1024,
    qualityIndex: 1,
    stereoMode: 0,
    activity: 0.42,
    maxReductionDb: 6.0,
    spectrum, reduction, weighting,
    ...opts,
  }
}

function makeRingFromBuckets(buckets) {
  return {
    buckets: buckets.slice(),
    count: buckets.length,
    last() { return this.count > 0 ? this.buckets[this.count - 1] : null },
    forEachInOrder(fn) {
      for (let i = 0; i < this.count; i++) fn(this.buckets[i], i)
    },
  }
}

function makeStubCtx() {
  const calls = []
  return {
    calls,
    setLineDash: vi.fn(),
    fillRect:    vi.fn((...a) => calls.push(['fillRect', a])),
    strokeRect:  vi.fn(),
    beginPath:   vi.fn(),
    moveTo:      vi.fn(),
    lineTo:      vi.fn(),
    closePath:   vi.fn(),
    stroke:      vi.fn(),
    fill:        vi.fn(),
    arc:         vi.fn(),
    save:        vi.fn(),
    restore:     vi.fn(),
    fillText:    vi.fn(),
    measureText: vi.fn(() => ({ width: 18 })),
    set fillStyle(v)    {},
    set strokeStyle(v)  {},
    set lineWidth(v)    {},
    set globalAlpha(v)  {},
    set font(v)         {},
    set textAlign(v)    {},
    set textBaseline(v) {},
  }
}

const THEME = Object.freeze({
  bg:        '#0f0f0f',
  bgInset:   '#0a0a0a',
  surface:   '#181818',
  text:      '#ddd',
  textMuted: '#999',
  grid:      '#333',
  accent:    '#a5f3fc',
  accentDim: '#475569',
})

const PARAMS = Object.freeze({
  wc_hp: 80,
  wc_lp: 16000,
})

// ── Painter smoke tests ────────────────────────────────────────────────────

describe('Resonance painters', () => {
  it('drawResonanceCombined draws an empty ring without throwing', () => {
    const ctx = makeStubCtx()
    const ring = makeRingFromBuckets([])
    expect(() => drawResonanceCombined(ctx, 760, 220, ring, THEME, PARAMS)).not.toThrow()
    expect(ctx.fillRect).toHaveBeenCalled()
  })

  it('drawResonanceCombined draws a populated ring without throwing', () => {
    const ring = makeRingFromBuckets([buildBucket(0), buildBucket(1), buildBucket(2)])
    const ctx = makeStubCtx()
    expect(() => drawResonanceCombined(ctx, 760, 220, ring, THEME, PARAMS)).not.toThrow()
  })

  it('all resonance painters tolerate NaN/Inf in bucket arrays', () => {
    const noisy = buildBucket(5)
    noisy.spectrum[3]   = Number.NaN
    noisy.reduction[10] = Number.POSITIVE_INFINITY
    noisy.weighting[20] = Number.NEGATIVE_INFINITY
    const ring = makeRingFromBuckets([noisy])
    const ctx = makeStubCtx()
    expect(() => drawResonanceCombined (ctx, 600, 200, ring, THEME, PARAMS)).not.toThrow()
    expect(() => drawResonanceSpectrum (ctx, 600, 200, ring, THEME, PARAMS)).not.toThrow()
    expect(() => drawResonanceReduction(ctx, 600, 200, ring, THEME, PARAMS)).not.toThrow()
    expect(() => drawResonanceWeighting(ctx, 600, 200, ring, THEME, PARAMS)).not.toThrow()
  })

  it('RESONANCE_PRESETS keys are wired to functions', () => {
    expect(typeof RESONANCE_PRESETS.resonanceCombined ).toBe('function')
    expect(typeof RESONANCE_PRESETS.resonanceSpectrum ).toBe('function')
    expect(typeof RESONANCE_PRESETS.resonanceReduction).toBe('function')
    expect(typeof RESONANCE_PRESETS.resonanceWeighting).toBe('function')
  })

  it('exports a default-preset map for every documented source key', () => {
    expect(RESONANCE_SOURCE_DEFAULT_PRESET['resonance.combined']).toBe('resonanceCombined')
    expect(RESONANCE_SOURCE_DEFAULT_PRESET['resonance.spectrum']).toBe('resonanceSpectrum')
    expect(RESONANCE_SOURCE_DEFAULT_PRESET['resonance.reduction']).toBe('resonanceReduction')
    expect(RESONANCE_SOURCE_DEFAULT_PRESET['resonance.weighting']).toBe('resonanceWeighting')
  })

  it('RESONANCE_VISUALIZER_PRESETS exposes resonance.combined as its primary source', () => {
    expect(RESONANCE_VISUALIZER_PRESETS.resonanceCombined.sources).toContain('resonance.combined')
  })
})

// ── Layout shell ───────────────────────────────────────────────────────────

describe('Resonance Suppressor shipped layout', () => {
  it('validates against the manifest with no hard errors', () => {
    const result = validate(resonanceLayout, RESONANCE_SUPPRESSOR_MANIFEST)
    expect(result.ok).toBe(true)
    const hardErrors = result.errors.filter(e =>
      e.code !== 'UNKNOWN_STYLE_KEY'
    )
    expect(hardErrors).toEqual([])
  })

  it('contains the polished structural hooks the runtime expects', () => {
    const json = JSON.stringify(resonanceLayout)
    expect(json).toContain('"resonance.combined"')
    expect(json).toContain('"resonanceCombined"')
    // Mode / quality / stereo are segmented choices.
    expect(json).toContain('"mode-segmented"')
    expect(json).toContain('"quality-segmented"')
    expect(json).toContain('"stereo-mode-segmented"')
    // Graph display tabs are backed by real shipped resonance visualizer
    // sources; Delta is intentionally not a graph tab because it is an audio
    // listen mode, not a distinct visualization source.
    expect(json).toContain('"graph-view-tabs"')
    expect(json).toContain('"resonance.spectrum"')
    expect(json).toContain('"resonance.reduction"')
    expect(json).toContain('"resonance.weighting"')
    // Macro detection controls are now vertical faders (compressorSlider),
    // matching the polished XLETH plugin style (e.g. the Transient Processor).
    for (const id of ['s-depth', 's-sharpness', 's-selectivity', 's-attack', 's-release']) {
      expect(json).toContain(`"${id}"`)
    }
    expect(json).toContain('"compressorSlider"')
    // Output controls including the Δ Listen toggle (boolParam). MIX is a
    // fader; TRIM stays a compact knob.
    expect(json).toContain('"s-mix"')
    expect(json).toContain('"k-trim"')
    expect(json).toContain('"delta-toggle"')
    expect(json).toContain('"boolParam"')
    expect(json).toContain('"FOCUS CURVE"')
    // Focus curve: HP/LP boundaries are still rendered as compact knobs; the
    // 8 band slots now live entirely inside the dynamic graph overlay, so the
    // legacy node-grid (k-b1-freq..k-b4-gain) and the temporary band-N grid
    // are intentionally absent from the layout.
    for (const id of ['k-wc-hp', 'k-wc-lp']) {
      expect(json).toContain(`"${id}"`)
    }
    expect(json).not.toContain('Drag handles')
    expect(json).not.toContain('+ Band')
    // Meters were removed from the shipped layout to match the cleaner mockup
    // (the engine still exposes the meter slots; they are simply not rendered).
    expect(json).not.toContain('"PEAK_L"')
    expect(json).not.toContain('"PEAK_R"')
    expect(json).not.toContain('"GAIN_REDUCTION"')
    // Stereo LINK knob was dropped; the Stereo/Mid/Side choice remains.
    expect(json).not.toContain('"k-stereo-link"')
  })

  it('removes the temporary 8-band fallback grid and the legacy 4-band node-grid', () => {
    const json = JSON.stringify(resonanceLayout)
    // The temporary fallback (band-1..band-8 sub-controls) is gone.
    for (let n = 1; n <= 8; n++) {
      expect(json).not.toContain(`"band-${n}-active"`)
      expect(json).not.toContain(`"band-${n}-focus"`)
      expect(json).not.toContain(`"band-${n}-sens"`)
      expect(json).not.toContain(`"band-${n}-width"`)
      expect(json).not.toContain(`"band-${n}-shape-bell"`)
    }
    // The legacy 4-band freq/gain knob pairs are gone — the dynamic overlay
    // owns those edits now.
    for (const id of [
      'k-b1-freq', 'k-b1-gain',
      'k-b2-freq', 'k-b2-gain',
      'k-b3-freq', 'k-b3-gain',
      'k-b4-freq', 'k-b4-gain',
    ]) {
      expect(json).not.toContain(`"${id}"`)
    }
  })

  it('uses a compact plugin-sized preferred panel without becoming oversized', () => {
    expect(resonanceLayout.panel.preferredSize.width).toBeGreaterThanOrEqual(920)
    expect(resonanceLayout.panel.preferredSize.width).toBeLessThanOrEqual(1020)
    expect(resonanceLayout.panel.preferredSize.height).toBeLessThanOrEqual(660)
    expect(resonanceLayout.panel.preferredSize.height).toBeGreaterThanOrEqual(580)
  })

  it('manifest exposes 54 params with the Focus Curve v1.1 schema', () => {
    const ids = Object.keys(RESONANCE_SUPPRESSOR_MANIFEST.params)
    expect(ids).toHaveLength(54)
    for (let n = 1; n <= 8; n++) {
      for (const suffix of ['active', 'type', 'freq', 'gain', 'q']) {
        expect(ids).toContain(`wc_b${n}_${suffix}`)
      }
      // Type enum range must match engine: 0=Bell..4=Tilt.
      const typeMeta = RESONANCE_SUPPRESSOR_MANIFEST.params[`wc_b${n}_type`]
      expect(typeMeta.kind).toBe('discrete')
      expect(typeMeta.min).toBe(0)
      expect(typeMeta.max).toBe(4)
    }
  })

  it('does not reference any sidechain UI', () => {
    const json = JSON.stringify(resonanceLayout).toLowerCase()
    expect(json).not.toContain('sidechain')
    expect(json).not.toContain('side_chain')
    expect(json).not.toContain('"sc"')
  })

  it('does not add mockup-only fake controls', () => {
    const json = JSON.stringify(resonanceLayout).toLowerCase()
    for (const fake of ['band listen', 'offline', 'cpu', 'play', 'pause']) {
      expect(json).not.toContain(fake)
    }
  })

  it('declares the editable resonanceCurve overlay and defaults to the Reduction tab', () => {
    function collectVizNodes(node, out = []) {
      if (!node) return out
      if (node.type === 'visualizer') out.push(node)
      if (Array.isArray(node.children)) {
        for (const c of node.children) collectVizNodes(c, out)
      }
      return out
    }
    const vizNodes = collectVizNodes(resonanceLayout.root)
    expect(vizNodes.length).toBeGreaterThanOrEqual(4)
    // Every graph tab carries the editable resonanceCurve overlay.
    for (const viz of vizNodes) {
      expect(viz.props.overlay).toBe('resonanceCurve')
    }
    // The first tab is what the runtime selects by default — it must be the
    // Reduction view (drag knobs to control how much resonance is suppressed).
    expect(vizNodes[0].props.source).toBe('resonance.reduction')
    expect(vizNodes[0].props.preset).toBe('resonanceReduction')
    // The Combined view is still present, just no longer the default.
    expect(vizNodes.some(v => v.props.source === 'resonance.combined')).toBe(true)
  })
})

// ── Coordinate mapping helpers ────────────────────────────────────────────

describe('Resonance curve coordinate helpers', () => {
  it('freqToX maps the audible band onto [0, w-1] and clamps outside it', () => {
    const w = 800
    expect(freqToX(20, w)).toBeCloseTo(0, 5)
    expect(freqToX(20000, w)).toBeCloseTo(w - 1, 5)
    expect(freqToX(632.4555, w)).toBeCloseTo((w - 1) / 2, 0) // geomean of 20 / 20k
    expect(freqToX(5,  w)).toBeCloseTo(0, 5)        // clamp
    expect(freqToX(50000, w)).toBeCloseTo(w - 1, 5) // clamp
    expect(freqToX(Number.NaN, w)).toBe(0)
  })

  it('freqToX and xToFreq round-trip across the band', () => {
    const w = 700
    for (const hz of [50, 100, 220, 440, 880, 1500, 5000, 12000]) {
      const back = xToFreq(freqToX(hz, w), w)
      expect(back).toBeCloseTo(hz, 0)
    }
  })

  it('gainToY clamps and inverts (top = +12 dB, bottom = -12 dB)', () => {
    const h = 240
    expect(gainToY(BELL_GAIN_MAX_DB, h)).toBeCloseTo(0, 5)
    expect(gainToY(BELL_GAIN_MIN_DB, h)).toBeCloseTo(h - 1, 5)
    expect(gainToY(0, h)).toBeCloseTo((h - 1) / 2, 5)
    expect(gainToY(99, h)).toBeCloseTo(0, 5)         // clamp
    expect(gainToY(-99, h)).toBeCloseTo(h - 1, 5)    // clamp
  })

  it('gainToY and yToGain round-trip', () => {
    const h = 200
    for (const db of [-12, -6, -1, 0, 1, 6, 12]) {
      expect(yToGain(gainToY(db, h), h)).toBeCloseTo(db, 1)
    }
  })

  it('clamps respect manifest ranges', () => {
    expect(clampHp(5)).toBe(HP_MIN_HZ)
    expect(clampHp(5000)).toBe(HP_MAX_HZ)
    expect(clampLp(500)).toBe(LP_MIN_HZ)
    expect(clampLp(50000)).toBe(LP_MAX_HZ)
    expect(clampBellFreq(5)).toBe(BELL_FREQ_MIN_HZ)
    expect(clampBellFreq(50000)).toBe(BELL_FREQ_MAX_HZ)
    expect(clampBellGain(-99)).toBe(BELL_GAIN_MIN_DB)
    expect(clampBellGain(99)).toBe(BELL_GAIN_MAX_DB)
    expect(clampHp(Number.NaN)).toBe(HP_MIN_HZ)
  })

  it('BAND_HANDLES wires every 1..8 slot canonically', () => {
    expect(NUM_BANDS).toBe(8)
    expect(BAND_HANDLES).toHaveLength(8)
    BAND_HANDLES.forEach((h, i) => {
      expect(h.idx).toBe(i + 1)
      expect(h.activeId).toBe(`wc_b${i + 1}_active`)
      expect(h.typeId).toBe(`wc_b${i + 1}_type`)
      expect(h.freqId).toBe(`wc_b${i + 1}_freq`)
      expect(h.gainId).toBe(`wc_b${i + 1}_gain`)
      expect(h.qId).toBe(`wc_b${i + 1}_q`)
    })
  })

  it('BELL_HANDLES is preserved as a 4-entry legacy alias', () => {
    expect(BELL_HANDLES).toHaveLength(4)
    BELL_HANDLES.forEach((h, i) => {
      expect(h.freqId).toBe(`wc_b${i + 1}_freq`)
      expect(h.gainId).toBe(`wc_b${i + 1}_gain`)
    })
  })

  it('clampBandQ respects [0.25, 4.0]', () => {
    expect(clampBandQ(0)).toBe(BAND_Q_MIN)
    expect(clampBandQ(99)).toBe(BAND_Q_MAX)
    expect(clampBandQ(1)).toBe(1)
    expect(clampBandQ(Number.NaN)).toBe(BAND_Q_MIN)
  })

  it('clampBandType returns a valid enum index', () => {
    expect(clampBandType(0)).toBe(0)
    expect(clampBandType(4)).toBe(4)
    expect(clampBandType(-5)).toBe(0)
    expect(clampBandType(99)).toBe(4)
    expect(clampBandType(Number.NaN)).toBe(0)
  })

  it('BAND_TYPE enum aligns with engine weightingForBin()', () => {
    expect(BAND_TYPE.BELL).toBe(0)
    expect(BAND_TYPE.LOW_SHELF).toBe(1)
    expect(BAND_TYPE.HIGH_SHELF).toBe(2)
    expect(BAND_TYPE.BAND_REJECT).toBe(3)
    expect(BAND_TYPE.TILT).toBe(4)
    expect(BAND_TYPE_OPTIONS).toHaveLength(5)
    // Engine value 3 is exposed in the UI as "Protect" without renaming the enum.
    expect(BAND_TYPE_OPTIONS[3].value).toBe(3)
    expect(BAND_TYPE_OPTIONS[3].label).toBe('Protect')
  })

  it('bandParamIds returns the canonical id quintuple for a slot', () => {
    expect(bandParamIds(5)).toEqual({
      activeId: 'wc_b5_active',
      typeId:   'wc_b5_type',
      freqId:   'wc_b5_freq',
      gainId:   'wc_b5_gain',
      qId:      'wc_b5_q',
    })
  })
})

// ── Active-band helpers ───────────────────────────────────────────────────

describe('Active-band helpers', () => {
  it('getActiveBandIndices reads only bands whose wc_bN_active is set', () => {
    expect(getActiveBandIndices({})).toEqual([])
    const params = {
      wc_b1_active: 1,
      wc_b2_active: 0,
      wc_b3_active: 1,
      // 4–8 missing → treated as inactive
    }
    expect(getActiveBandIndices(params)).toEqual([1, 3])
  })

  it('findFirstInactiveBandIndex picks the lowest free slot, or null when full', () => {
    expect(findFirstInactiveBandIndex({})).toBe(1)
    expect(findFirstInactiveBandIndex({ wc_b1_active: 1 })).toBe(2)
    const allActive = {}
    for (let i = 1; i <= 8; i++) allActive[`wc_b${i}_active`] = 1
    expect(findFirstInactiveBandIndex(allActive)).toBe(null)

    // Holes are filled left-to-right.
    const partial = { ...allActive, wc_b4_active: 0 }
    expect(findFirstInactiveBandIndex(partial)).toBe(4)
  })
})

// ── Bottom band editor helpers ─────────────────────────────────────────────

describe('Resonance bottom band editor helpers', () => {
  it('Add Band activates the first inactive band', () => {
    const action = createAddBandAction({
      wc_b1_active: 1,
      wc_b2_active: 0,
      wc_b3_active: 0,
    })
    expect(action.idx).toBe(2)
    expect(action.updates).toEqual({ wc_b2_active: 1 })
  })

  it('Remove Band deactivates only the selected active band', () => {
    const action = createRemoveBandAction({
      wc_b1_active: 1,
      wc_b2_active: 1,
    }, 2)
    expect(action.idx).toBe(2)
    expect(action.updates).toEqual({ wc_b2_active: 0 })
    expect(createRemoveBandAction({ wc_b2_active: 0 }, 2)).toBe(null)
  })

  it('type selector writes wc_bN_type', () => {
    const action = createBandTypeAction({ wc_b3_active: 1, wc_b3_gain: -2 }, 3, BAND_TYPE.HIGH_SHELF)
    expect(action.updates).toEqual({ wc_b3_type: BAND_TYPE.HIGH_SHELF })
  })

  it('Protect type clamps positive Sens from the editor path', () => {
    const typeAction = createBandTypeAction({ wc_b4_active: 1, wc_b4_gain: 6 }, 4, BAND_TYPE.BAND_REJECT)
    expect(typeAction.updates).toEqual({
      wc_b4_type: BAND_TYPE.BAND_REJECT,
      wc_b4_gain: 0,
    })

    const gainAction = createBandGainAction(4, BAND_TYPE.BAND_REJECT, 8)
    expect(gainAction.updates).toEqual({ wc_b4_gain: 0 })
  })

  it('Width is not editable for Tilt', () => {
    expect(isBandWidthEditable(BAND_TYPE.TILT)).toBe(false)
    expect(isBandWidthEditable(BAND_TYPE.BELL)).toBe(true)
  })
})

// ── Drag-update helper ────────────────────────────────────────────────────

describe('computeDragParamUpdates', () => {
  it('hp drag writes only wc_hp, clamped to [20, 2000]', () => {
    const w = 800, h = 240
    const updates = computeDragParamUpdates({ kind: 'hp' }, 0, h / 2, w, h)
    expect(Object.keys(updates)).toEqual(['wc_hp'])
    expect(updates.wc_hp).toBe(HP_MIN_HZ)

    const farRight = computeDragParamUpdates({ kind: 'hp' }, w - 1, h / 2, w, h)
    // Going far right would yield 20kHz on the painter axis, but the HP param
    // is hard-clamped to 2000 Hz.
    expect(farRight.wc_hp).toBe(HP_MAX_HZ)
  })

  it('lp drag writes only wc_lp, clamped to [2000, 20000]', () => {
    const w = 800, h = 240
    const left = computeDragParamUpdates({ kind: 'lp' }, 0, 0, w, h)
    expect(Object.keys(left)).toEqual(['wc_lp'])
    expect(left.wc_lp).toBe(LP_MIN_HZ)
    const right = computeDragParamUpdates({ kind: 'lp' }, w - 1, 0, w, h)
    // Right edge of the painter axis lands at the LP ceiling (within FP tol).
    expect(right.wc_lp).toBeCloseTo(LP_MAX_HZ, 5)
    expect(right.wc_lp).toBeLessThanOrEqual(LP_MAX_HZ)
  })

  it('bell drag writes both freq and gain to the supplied param ids', () => {
    const w = 800, h = 240
    const drag = { kind: 'bell', freqId: 'wc_b2_freq', gainId: 'wc_b2_gain' }
    const updates = computeDragParamUpdates(drag, freqToX(800, w), gainToY(3, h), w, h)
    expect(Object.keys(updates).sort()).toEqual(['wc_b2_freq', 'wc_b2_gain'])
    expect(updates.wc_b2_freq).toBeCloseTo(800, 0)
    expect(updates.wc_b2_gain).toBeCloseTo(3, 1)
  })

  it('bell drag clamps both axes', () => {
    const w = 800, h = 240
    const drag = { kind: 'bell', freqId: 'wc_b1_freq', gainId: 'wc_b1_gain' }
    const top   = computeDragParamUpdates(drag, -100, -100, w, h)
    expect(top.wc_b1_freq).toBe(BELL_FREQ_MIN_HZ)
    expect(top.wc_b1_gain).toBe(BELL_GAIN_MAX_DB)
    const bot   = computeDragParamUpdates(drag, 5000, 5000, w, h)
    // Right-edge log mapping lands at the ceiling within FP tolerance.
    expect(bot.wc_b1_freq).toBeCloseTo(BELL_FREQ_MAX_HZ, 5)
    expect(bot.wc_b1_freq).toBeLessThanOrEqual(BELL_FREQ_MAX_HZ)
    expect(bot.wc_b1_gain).toBe(BELL_GAIN_MIN_DB)
  })

  it('unknown drag kind yields no updates', () => {
    expect(computeDragParamUpdates({ kind: 'wat' }, 10, 10, 800, 240)).toEqual({})
    expect(computeDragParamUpdates(null, 10, 10, 800, 240)).toEqual({})
  })

  it('band drag (Bell) writes freq/gain like a bell', () => {
    const w = 800, h = 240
    const drag = {
      kind: 'band',
      bandType: BAND_TYPE.BELL,
      freqId: 'wc_b3_freq',
      gainId: 'wc_b3_gain',
    }
    const u = computeDragParamUpdates(drag, freqToX(800, w), gainToY(4, h), w, h)
    expect(u.wc_b3_freq).toBeCloseTo(800, 0)
    expect(u.wc_b3_gain).toBeCloseTo(4, 1)
  })

  it('band drag (Low Shelf / High Shelf / Tilt) all write freq + gain ±12 dB', () => {
    const w = 800, h = 240
    for (const t of [BAND_TYPE.LOW_SHELF, BAND_TYPE.HIGH_SHELF, BAND_TYPE.TILT]) {
      const drag = { kind: 'band', bandType: t, freqId: 'wc_b1_freq', gainId: 'wc_b1_gain' }
      // Drag to the very top: gain pegs at +12 dB.
      const top = computeDragParamUpdates(drag, freqToX(2000, w), -100, w, h)
      expect(top.wc_b1_freq).toBeCloseTo(2000, 0)
      expect(top.wc_b1_gain).toBe(BELL_GAIN_MAX_DB)
      // Drag to the very bottom: gain pegs at -12 dB.
      const bot = computeDragParamUpdates(drag, freqToX(2000, w), 9999, w, h)
      expect(bot.wc_b1_gain).toBe(BELL_GAIN_MIN_DB)
    }
  })

  it('band drag (Protect / Band Reject) clamps gain to 0 dB max even on upward drag', () => {
    const w = 800, h = 240
    const drag = {
      kind: 'band',
      bandType: BAND_TYPE.BAND_REJECT,
      freqId: 'wc_b2_freq',
      gainId: 'wc_b2_gain',
    }
    // Drag far above the 0 dB line — engine APVTS allows +12, but the overlay
    // must never push a Protect band into a positive regime.
    const above = computeDragParamUpdates(drag, freqToX(1000, w), -200, w, h)
    expect(above.wc_b2_freq).toBeCloseTo(1000, 0)
    expect(above.wc_b2_gain).toBeLessThanOrEqual(0)
    // The bottom edge still resolves to -12 dB.
    const below = computeDragParamUpdates(drag, freqToX(1000, w), 9999, w, h)
    expect(below.wc_b2_gain).toBe(BELL_GAIN_MIN_DB)
  })

  it('band drag with a missing/invalid bandType falls back to Bell behaviour', () => {
    const w = 800, h = 240
    const drag = {
      kind: 'band',
      // no bandType → defaults to 0 (Bell), allowing positive gains.
      freqId: 'wc_b4_freq',
      gainId: 'wc_b4_gain',
    }
    const u = computeDragParamUpdates(drag, freqToX(500, w), gainToY(6, h), w, h)
    expect(u.wc_b4_gain).toBeCloseTo(6, 1)
    expect(u.wc_b4_gain).toBeGreaterThan(0)
  })
})

// ── ResonanceCurveOverlay render ──────────────────────────────────────────

function renderOverlay(params, setParam = vi.fn()) {
  const ctxValue = {
    target:    { trackId: -1, nodeId: 1 },
    manifest:  RESONANCE_SUPPRESSOR_MANIFEST,
    params,
    setParam,
    meterBus:  { register: () => {}, unregister: () => {} },
    onClose:   () => {},
    layoutErrors: [],
  }
  return renderToStaticMarkup(
    <PluginUIContext.Provider value={ctxValue}>
      <ResonanceCurveOverlay />
    </PluginUIContext.Provider>,
  )
}

describe('ResonanceCurveOverlay render', () => {
  // Note: under react-dom/server we don't get a real ResizeObserver, so the
  // overlay renders the empty bootstrap SVG. Static tests still cover the
  // structural contract: the SVG mounts under the correct class with no
  // errors. The drag math is exercised separately by computeDragParamUpdates.

  it('renders into static markup without throwing — empty params', () => {
    const html = renderOverlay({})
    expect(html).toContain('pluginui-resonance-overlay')
    expect(html).toContain('pluginui-resonance-band-editor')
    expect(html).toContain('Select band')
    expect(html).toContain('+ Band')
    expect(html).not.toContain('pluginui-resonance-inspector')
    expect(html).not.toContain('pluginui-resonance-toolbar')
  })

  it('renders into static markup without throwing — populated params', () => {
    const params = {
      wc_hp: 80,
      wc_lp: 16000,
      wc_b1_active: 1, wc_b1_type: BAND_TYPE.BELL,        wc_b1_freq: 250,  wc_b1_gain: 0,  wc_b1_q: 1,
      wc_b2_active: 1, wc_b2_type: BAND_TYPE.BAND_REJECT, wc_b2_freq: 800,  wc_b2_gain: -2, wc_b2_q: 1.2,
      wc_b3_active: 0, wc_b3_type: BAND_TYPE.TILT,        wc_b3_freq: 2500, wc_b3_gain: 5,  wc_b3_q: 1,
    }
    const html = renderOverlay(params)
    expect(html).toContain('pluginui-resonance-overlay')
    expect(html).toContain('data-handle="hp"')
    expect(html).toContain('data-handle="lp"')
    expect(html).toContain('data-handle="band-1"')
    expect(html).toContain('data-handle="band-2"')
    expect(html).not.toContain('data-handle="band-3"')
    expect(html).toContain('is-neutral')
  })

  it('exports the overlay component with expected static contract', () => {
    expect(typeof ResonanceCurveOverlay).toBe('function')
  })

  it('renders Add and Remove controls in the bottom band editor strip', () => {
    const model = buildBandEditorModel({
      wc_b1_active: 1,
      wc_b1_type: BAND_TYPE.BELL,
      wc_b1_freq: 1000,
      wc_b1_gain: -3,
      wc_b1_q: 1,
      wc_b2_active: 0,
    }, 1)
    const html = renderToStaticMarkup(
      <ResonanceBandEditorStrip
        model={model}
        onAddBand={() => {}}
        onRemoveBand={() => {}}
        onToggleActive={() => {}}
        onSelectType={() => {}}
        onChangeFreq={() => {}}
        onChangeGain={() => {}}
        onChangeQ={() => {}}
      />,
    )

    expect(html).toContain('pluginui-resonance-band-editor')
    expect(html).toContain('+ Band')
    expect(html).toContain('- Band')
    expect(html).toContain('Band 1')
  })

  it('hides Width in the bottom strip for Tilt bands', () => {
    const model = buildBandEditorModel({
      wc_b1_active: 1,
      wc_b1_type: BAND_TYPE.TILT,
      wc_b1_freq: 1000,
      wc_b1_gain: 3,
      wc_b1_q: 1,
    }, 1)
    const html = renderToStaticMarkup(
      <ResonanceBandEditorStrip
        model={model}
        onAddBand={() => {}}
        onRemoveBand={() => {}}
        onToggleActive={() => {}}
        onSelectType={() => {}}
        onChangeFreq={() => {}}
        onChangeGain={() => {}}
        onChangeQ={() => {}}
      />,
    )

    expect(html).toContain('Tilt')
    expect(html).not.toContain('Width')
  })
})
