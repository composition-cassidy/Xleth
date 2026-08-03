import { describe, expect, it } from 'vitest'
import {
  CLIP_CONTROL_DEFAULTS,
  CLIP_CONTROL_TUNABLE_FIELDS,
  CLIP_GAIN_MAX_DB,
  applyFadeDrag,
  applyGainDrag,
  buildClipControlTuningReport,
  clipControlDefaultsHash,
  clipControlCursor,
  computeClipControlGeometry,
  dbToVelocity,
  diffClipControlSpec,
  formatClipControlValue,
  getClipControlVisibility,
  hitTestClipControl,
  normalizeClipFades,
  normalizeClipControlSpec,
  setPathValue,
  shouldDrawFadeOverlay,
  velocityToDb,
} from './clipControlSpec.js'

const rect = { x: 10, y: 20, w: 200, h: 46 }
const clip = { id: 1, velocity: 1, fadeInPercent: 25, fadeOutPercent: 25 }

describe('clipControlSpec gain conversion and dragging', () => {
  it('maps silence, unity, and the preserved +6.02 dB maximum', () => {
    expect(velocityToDb(0)).toBe(Number.NEGATIVE_INFINITY)
    expect(velocityToDb(1)).toBeCloseTo(0)
    expect(velocityToDb(2)).toBeCloseTo(CLIP_GAIN_MAX_DB)
    expect(dbToVelocity(0)).toBe(1)
    expect(dbToVelocity(CLIP_GAIN_MAX_DB)).toBeCloseTo(2)
    expect(dbToVelocity(CLIP_CONTROL_DEFAULTS.interaction.muteFloorDb)).toBe(0)
  })

  it('uses relative no-jump motion, Shift precision, unity snap, and Alt bypass', () => {
    expect(applyGainDrag(0.5, 0)).toBeCloseTo(0.5)
    const coarse = applyGainDrag(0.5, -20)
    const fine = applyGainDrag(0.5, -20, { shiftKey: true })
    expect(coarse).toBeGreaterThan(fine)
    expect(fine).toBeGreaterThan(0.5)
    expect(applyGainDrag(1, -1)).toBe(1)
    expect(applyGainDrag(1, -1, { altKey: true })).toBeGreaterThan(1)
    expect(applyGainDrag(2, -1000)).toBe(2)
    expect(applyGainDrag(0, 1000)).toBe(0)
  })

  it('formats gain and fade values for the live tooltip', () => {
    expect(formatClipControlValue('volume', 0)).toBe('-∞ dB')
    expect(formatClipControlValue('volume', 2)).toBe('+6.0 dB')
    expect(formatClipControlValue('fadeIn', 12.34)).toBe('Fade in 12.3%')
  })
})

describe('clipControlSpec fade dragging and geometry', () => {
  it('moves fades relatively, reverses fade-out direction, and respects the opposite fade', () => {
    expect(applyFadeDrag('fadeIn', 20, 10, 20, 200)).toBeCloseTo(30)
    expect(applyFadeDrag('fadeOut', 20, 10, -20, 200)).toBeCloseTo(30)
    expect(applyFadeDrag('fadeIn', 80, 30, 200, 200)).toBe(70)
    expect(applyFadeDrag('fadeIn', 20, 10, 20, 200, { shiftKey: true })).toBeCloseTo(21)
  })

  it('uses one shared geometry for paint anchors and hit testing', () => {
    const geometry = computeClipControlGeometry({ clip, rect })
    expect(geometry.eligible).toBe(true)
    expect(geometry.fadeIn.anchor.x).toBe(60)
    expect(geometry.fadeOut.anchor.x).toBe(160)
    expect(hitTestClipControl({
      localX: geometry.gain.anchor.x,
      localY: geometry.gain.anchor.y,
      clip,
      rect,
    })?.kind).toBe('volume')
  })

  it('chooses the closest fade handle when hit regions overlap and uses pointer side for ties', () => {
    const overlapping = { ...clip, fadeInPercent: 49, fadeOutPercent: 49 }
    expect(hitTestClipControl({ localX: 107, localY: 64, clip: overlapping, rect })?.kind).toBe('fadeIn')
    expect(hitTestClipControl({ localX: 113, localY: 64, clip: overlapping, rect })?.kind).toBe('fadeOut')
    expect(hitTestClipControl({ localX: 110, localY: 64, clip: overlapping, rect })?.kind).toBe('fadeIn')
  })

  it('suppresses controls below the single shared eligibility threshold', () => {
    const geometry = computeClipControlGeometry({ clip, rect: { ...rect, w: 41 } })
    expect(geometry.eligible).toBe(false)
    expect(hitTestClipControl({ localX: 20, localY: 40, clip, rect: { ...rect, w: 41 } })).toBeNull()
  })

  it('keeps tunable gain travel inside the clip at extreme inset values', () => {
    let extreme = setPathValue(CLIP_CONTROL_DEFAULTS, 'gain.topInset', 60)
    extreme = setPathValue(extreme, 'gain.bottomInset', 60)
    extreme = setPathValue(extreme, 'gain.minTravel', 40)
    extreme = setPathValue(extreme, 'eligibility.minHeight', 16)
    const smallRect = { x: 0, y: 0, w: 80, h: 16 }
    const geometry = computeClipControlGeometry({ clip, rect: smallRect, spec: extreme })
    expect(geometry.gain.top).toBeGreaterThanOrEqual(0)
    expect(geometry.gain.bottom).toBeLessThanOrEqual(16)
    expect(geometry.gain.lineY).toBeGreaterThanOrEqual(0)
    expect(geometry.gain.lineY).toBeLessThanOrEqual(16.5)
  })

  it('normalizes fade overlap and follows fade-overlay visibility modes', () => {
    const normalized = normalizeClipFades({ fadeInPercent: 80, fadeOutPercent: 80 })
    expect(normalized.fadeInPercent).toBe(50)
    expect(normalized.fadeOutPercent).toBe(50)
    expect(shouldDrawFadeOverlay(clip, false)).toBe(true)
    const selectedOnly = normalizeClipControlSpec(setPathValue(
      CLIP_CONTROL_DEFAULTS,
      'visibility.fadeOverlay',
      'selected-when-set',
    ))
    expect(shouldDrawFadeOverlay(clip, false, selectedOnly)).toBe(false)
    expect(shouldDrawFadeOverlay(clip, true, selectedOnly)).toBe(true)
  })
})

describe('clipControlSpec tuning state', () => {
  it('starts with hybrid visibility', () => {
    expect(getClipControlVisibility({ selected: false })).toEqual({ gainLine: true, handles: false })
    expect(getClipControlVisibility({ hoveredKind: 'volume' })).toEqual({ gainLine: true, handles: true })
    expect(getClipControlVisibility({ selected: true })).toEqual({ gainLine: true, handles: true })
    expect(clipControlCursor('volume')).toBe('ns-resize')
    expect(clipControlCursor('fadeOut')).toBe('ew-resize')
  })

  it('exposes each baked leaf as a typed tuning field', () => {
    const fieldPaths = new Set(CLIP_CONTROL_TUNABLE_FIELDS.map((field) => field.path))
    const visit = (value, prefix = '') => {
      for (const [key, child] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (child && typeof child === 'object') visit(child, path)
        else expect(fieldPaths.has(path), `${path} is tunable`).toBe(true)
      }
    }
    visit(CLIP_CONTROL_DEFAULTS)
    for (const field of CLIP_CONTROL_TUNABLE_FIELDS) {
      expect(field.path).toMatch(/^[a-z]+\./i)
      expect(field.label.length).toBeGreaterThan(0)
      if (!field.type) {
        expect(Number.isFinite(field.min)).toBe(true)
        expect(Number.isFinite(field.max)).toBe(true)
        expect(field.step).toBeGreaterThan(0)
      }
    }
  })

  it('normalizes tunable values and reports exact changes', () => {
    const candidate = setPathValue(CLIP_CONTROL_DEFAULTS, 'gain.pillWidth', 999)
    const normalized = normalizeClipControlSpec(candidate)
    expect(normalized.gain.pillWidth).toBe(80)
    const diff = diffClipControlSpec(normalized)
    expect(diff.gain.pillWidth).toEqual({ from: 34, to: 80 })

    const report = buildClipControlTuningReport({
      finalSpec: normalized,
      changeHistory: [{ path: 'gain.pillWidth', from: 34, to: 80, at: 'now' }],
      previewState: { gainDb: 0 },
      context: { theme: 'test' },
      appVersion: 'test',
      generatedAt: '2026-07-15T00:00:00.000Z',
    })
    expect(report.kind).toBe('xleth.clip-control-tuning')
    expect(report.defaultsHash).toBe(clipControlDefaultsHash())
    expect(report.final.gain.pillWidth).toBe(80)
    expect(report.diff.gain.pillWidth.to).toBe(80)
  })
})
