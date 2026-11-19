import { describe, expect, it, beforeEach, vi } from 'vitest'
import { PPQ, TRACK_HEIGHT } from '../../constants/timeline.js'
import {
  HOLD_THRESHOLD_UNLIMITED,
  isHoldThresholdUnlimited,
  getHoldThresholdBeats,
  getHoldThresholdTicks,
  formatHoldThreshold,
  smartHoldThresholdBeats,
  gapsBetween,
  SMART_FALLBACK_THRESHOLD_BEATS,
} from './holdLastFrame.js'
import { drawHoldZones } from './timelineDrawing.js'

describe('hold threshold helpers', () => {
  it('treats absent / negative / malformed values as unlimited', () => {
    expect(isHoldThresholdUnlimited(undefined)).toBe(true)
    expect(isHoldThresholdUnlimited(null)).toBe(true)
    expect(isHoldThresholdUnlimited(-1)).toBe(true)
    expect(isHoldThresholdUnlimited(NaN)).toBe(true)
    expect(isHoldThresholdUnlimited(Infinity)).toBe(true)
    // 0 is a real threshold (cut immediately), NOT unlimited.
    expect(isHoldThresholdUnlimited(0)).toBe(false)
    expect(isHoldThresholdUnlimited(4)).toBe(false)
  })

  it('reads the threshold off a track record, defaulting to unlimited', () => {
    expect(getHoldThresholdBeats({})).toBe(HOLD_THRESHOLD_UNLIMITED)
    expect(getHoldThresholdBeats({ videoHoldLastFrameThresholdBeats: -1 }))
      .toBe(HOLD_THRESHOLD_UNLIMITED)
    expect(getHoldThresholdBeats({ videoHoldLastFrameThresholdBeats: 2.5 })).toBe(2.5)
  })

  it('converts beats to ticks, and unlimited to null', () => {
    expect(getHoldThresholdTicks({ videoHoldLastFrameThresholdBeats: 4 })).toBe(4 * PPQ)
    expect(getHoldThresholdTicks({ videoHoldLastFrameThresholdBeats: 0 })).toBe(0)
    expect(getHoldThresholdTicks({})).toBeNull()
  })

  it('formats labels', () => {
    expect(formatHoldThreshold(-1)).toBe('Unlimited')
    expect(formatHoldThreshold(1)).toBe('1 beat')
    expect(formatHoldThreshold(4)).toBe('4 beats')
    expect(formatHoldThreshold(0.5)).toBe('0.5 beats')
  })
})

// ── drawHoldZones geometry ───────────────────────────────────────────────────
// A recording 2D context: the zones and expiry ticks are plain fillRect calls,
// so asserting on them pins the exact x-geometry across zoom and scroll without
// needing a real canvas.

function makeCtx() {
  const rects = []
  return {
    rects,
    fillStyle: '',
    fillRect(x, y, w, h) { rects.push({ x, y, w, h, style: this.fillStyle }) },
    clearRect() {},
  }
}

const TRACKS_HOLD_UNLIMITED = [{ id: 1, videoHoldLastFrame: true }]
const TRACKS_HOLD_2BEATS = [
  { id: 1, videoHoldLastFrame: true, videoHoldLastFrameThresholdBeats: 2 },
]
const IDX = { 1: 0 }

// One clip covering beats [0, 2), i.e. ticks [0, 2*PPQ).
const ONE_CLIP = [{ id: 'c1', trackId: 1, positionTicks: 0, durationTicks: 2 * PPQ }]

const PALETTE = { holdZoneFill: 'FILL', holdZoneEdge: 'EDGE' }

// Zone fills use the fill token; the expiry tick uses the edge token.
const zonesOf = (ctx) => ctx.rects.filter(r => r.style === 'FILL')
const marksOf = (ctx) => ctx.rects.filter(r => r.style === 'EDGE')

describe('drawHoldZones', () => {
  let ctx
  beforeEach(() => { ctx = makeCtx() })

  it('draws nothing when no track has hold enabled', () => {
    drawHoldZones(ctx, 800, TRACK_HEIGHT, 0, 100, ONE_CLIP,
      IDX, [{ id: 1, videoHoldLastFrame: false }], PALETTE, null)
    expect(ctx.rects).toHaveLength(0)
  })

  it('draws nothing when there are no clips', () => {
    drawHoldZones(ctx, 800, TRACK_HEIGHT, 0, 100, [], IDX, TRACKS_HOLD_2BEATS, PALETTE, null)
    expect(ctx.rects).toHaveLength(0)
  })

  it('extends a finite zone from the clip end to clipEnd + threshold', () => {
    // ppb = 100px/beat. Clip ends at beat 2 -> x=200. Threshold 2 beats -> x=400.
    drawHoldZones(ctx, 800, TRACK_HEIGHT, 0, 100, ONE_CLIP, IDX, TRACKS_HOLD_2BEATS, PALETTE, null)
    const zones = zonesOf(ctx)
    expect(zones).toHaveLength(1)
    expect(zones[0].x).toBeCloseTo(200)
    expect(zones[0].w).toBeCloseTo(200)

    // Expiry tick sits at the far end of the zone.
    const marks = marksOf(ctx)
    expect(marks).toHaveLength(1)
    expect(marks[0].x).toBeCloseTo(400)
  })

  it('stops an unlimited zone at the next clip and draws no expiry tick', () => {
    const clips = [
      ...ONE_CLIP,
      { id: 'c2', trackId: 1, positionTicks: 5 * PPQ, durationTicks: PPQ },
    ]
    drawHoldZones(ctx, 800, TRACK_HEIGHT, 0, 100, clips, IDX, TRACKS_HOLD_UNLIMITED, PALETTE, null)
    const zones = zonesOf(ctx)
    // Zone for clip 1 runs beat 2 -> 5; clip 2 is last so its zone runs to the
    // viewport edge (unlimited, no following clip).
    expect(zones[0].x).toBeCloseTo(200)
    expect(zones[0].w).toBeCloseTo(300)
    // Unlimited never expires, so no tick anywhere.
    expect(marksOf(ctx)).toHaveLength(0)
  })

  it('truncates the zone at the next clip when it starts before the threshold expires', () => {
    // Next clip at beat 3 — before clipEnd(2) + threshold(2) = 4.
    const clips = [
      ...ONE_CLIP,
      { id: 'c2', trackId: 1, positionTicks: 3 * PPQ, durationTicks: PPQ },
    ]
    drawHoldZones(ctx, 800, TRACK_HEIGHT, 0, 100, clips, IDX, TRACKS_HOLD_2BEATS, PALETTE, null)
    const zones = zonesOf(ctx)
    expect(zones[0].x).toBeCloseTo(200)
    expect(zones[0].w).toBeCloseTo(100)   // beat 2 -> 3, not 2 -> 4
    // The hold never actually expires here (the next clip cuts it), so the
    // first clip contributes no expiry tick.
    const marks = marksOf(ctx)
    expect(marks.every(m => Math.abs(m.x - 400) > 0.5)).toBe(true)
  })

  it('tracks zoom: doubling pixels-per-beat doubles the zone width and marker x', () => {
    const at = (ppb) => {
      const c = makeCtx()
      drawHoldZones(c, 4000, TRACK_HEIGHT, 0, ppb, ONE_CLIP, IDX, TRACKS_HOLD_2BEATS, PALETTE, null)
      return { zone: zonesOf(c)[0], mark: marksOf(c)[0] }
    }
    const a = at(50)
    const b = at(100)
    const d = at(200)
    expect(a.zone.w).toBeCloseTo(100)
    expect(b.zone.w).toBeCloseTo(200)
    expect(d.zone.w).toBeCloseTo(400)
    expect(a.mark.x).toBeCloseTo(200)
    expect(b.mark.x).toBeCloseTo(400)
    expect(d.mark.x).toBeCloseTo(800)
  })

  it('tracks scroll: the zone shifts left by scrollOffset * ppb, width unchanged', () => {
    const at = (scroll) => {
      const c = makeCtx()
      drawHoldZones(c, 800, TRACK_HEIGHT, scroll, 100, ONE_CLIP, IDX, TRACKS_HOLD_2BEATS, PALETTE, null)
      return { zone: zonesOf(c)[0], mark: marksOf(c)[0] }
    }
    const a = at(0)
    const b = at(1)   // scrolled one beat -> 100px left
    expect(b.zone.x).toBeCloseTo(a.zone.x - 100)
    expect(b.zone.w).toBeCloseTo(a.zone.w)
    expect(b.mark.x).toBeCloseTo(a.mark.x - 100)
  })

  it('clamps a partially scrolled-off zone to the viewport instead of drawing negative x', () => {
    // Scroll past the clip end so the zone starts left of x=0.
    const c = makeCtx()
    drawHoldZones(c, 800, TRACK_HEIGHT, 3, 100, ONE_CLIP, IDX, TRACKS_HOLD_2BEATS, PALETTE, null)
    const zones = zonesOf(c)
    expect(zones).toHaveLength(1)
    expect(zones[0].x).toBe(0)          // clamped, not -100
    expect(zones[0].w).toBeCloseTo(100) // 0 -> beat 4 (x=100)
  })

  it('culls zones entirely off-screen', () => {
    const c = makeCtx()
    // Scroll far past everything.
    drawHoldZones(c, 800, TRACK_HEIGHT, 500, 100, ONE_CLIP, IDX, TRACKS_HOLD_2BEATS, PALETTE, null)
    expect(c.rects).toHaveLength(0)
  })

  it('does not draw an expiry tick outside the viewport', () => {
    // Threshold pushes the expiry well past the right edge.
    const tracks = [{ id: 1, videoHoldLastFrame: true, videoHoldLastFrameThresholdBeats: 100 }]
    const c = makeCtx()
    drawHoldZones(c, 800, TRACK_HEIGHT, 0, 100, ONE_CLIP, IDX, tracks, PALETTE, null)
    expect(marksOf(c)).toHaveLength(0)
    // The zone itself is still drawn, clamped to the viewport width.
    expect(zonesOf(c)[0].w).toBeCloseTo(600)
  })

  it('ignores clips on tracks that are not in the track index', () => {
    const c = makeCtx()
    drawHoldZones(c, 800, TRACK_HEIGHT, 0, 100, ONE_CLIP, {}, TRACKS_HOLD_2BEATS, PALETTE, null)
    expect(c.rects).toHaveLength(0)
  })

  it('does not query the engine while drawing', () => {
    const spy = vi.fn()
    const prev = globalThis.window
    globalThis.window = { xleth: new Proxy({}, { get: () => { spy(); return undefined } }) }
    try {
      drawHoldZones(ctx, 800, TRACK_HEIGHT, 0, 100, ONE_CLIP, IDX, TRACKS_HOLD_2BEATS, PALETTE, null)
    } finally {
      globalThis.window = prev
    }
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('smart hold (mirror of engine SmartHold.h)', () => {
  it('holds every gap when there are none or all are under a beat', () => {
    expect(smartHoldThresholdBeats([])).toBe(Infinity)
    expect(smartHoldThresholdBeats([0.25, 0.5, 0.25])).toBe(Infinity)
  })

  it('splits phrase rests from phrase breaks at the biggest jump', () => {
    const t = smartHoldThresholdBeats([0.5, 0.5, 6.5])
    expect(t).toBeGreaterThan(0.5)
    expect(t).toBeLessThan(6.5)
    expect(t).toBeCloseTo(Math.sqrt(0.5 * 6.5))
    const t2 = smartHoldThresholdBeats([0.125, 0.25, 0.75, 0.5, 5, 6, 0.25])
    expect(t2).toBeGreaterThan(0.75)
    expect(t2).toBeLessThan(5)
  })

  it('falls back to one bar when every gap is the same long kind', () => {
    expect(smartHoldThresholdBeats([8, 8])).toBe(SMART_FALLBACK_THRESHOLD_BEATS)
  })

  it('merges overlapping and butted clips before measuring gaps', () => {
    expect(gapsBetween([[0, 1], [0.5, 2], [3, 4], [4, 5]])).toEqual([1])
  })

  it('draws zones only over the held gaps and none after the last clip', () => {
    const ctx = makeCtx()
    // [0,.5) [1,1.5)  rest 6.5  [8,8.5) [9,9.5)
    const clips = [0, 1, 8, 9].map((b, i) => ({
      id: `c${i}`, trackId: 1, positionTicks: b * PPQ, durationTicks: PPQ / 2,
    }))
    drawHoldZones(ctx, 2000, TRACK_HEIGHT, 0, 100, clips, IDX,
      [{ id: 1, videoHoldLastFrame: true, videoHoldSmart: true }], PALETTE, null)
    const zones = zonesOf(ctx)
    expect(zones.map((z) => Math.round(z.x))).toEqual([50, 850])
    expect(zones.every((z) => Math.round(z.w) === 50)).toBe(true)
    expect(marksOf(ctx)).toHaveLength(0)
  })
})
