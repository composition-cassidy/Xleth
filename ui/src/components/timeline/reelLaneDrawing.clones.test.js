// Clone rows on the arrangement canvas (docs/XLETH_CLONE_SPEC.md): painted by the
// Reel pass, keyed by the Clone's own track id, dimmed by the Clone's own mute;
// an overflow note in the source lane is hatched; a click hits the SOURCE
// pattern's note (shared selection with the piano roll).
import { describe, expect, it, vi } from 'vitest'

vi.mock('./reelStills.js', () => ({ getReelStill: () => null }))

import { REEL_OVERFLOW_HINT, drawReelLanes, hitTestReel, reelHoverHint, reelLaneTrackId } from './reelLaneDrawing.js'
import { buildReelModel } from './reelLaneModel.js'
import { buildTrackLayout } from './timelineRowLayout.js'
import { MUTE_OPACITY } from './timelineDrawing.js'

const palette = { reelBody: '#323232', reelBodySelected: '#444444', reelBadgeFill: '#1a1a1a', reelBadgeInk: '#f0f0f0', select: '#ffffff', reelOverflow: '#e0a000' }
const sources = { 10: { id: 10, hasVideo: true, filePath: 'a.mp4', duration: 4 } }
const regions = { 100: { id: 100, sourceId: 10, startTime: 0 } }
const n = (id, s, e, pitch) => ({ id, positionTicks: s, durationTicks: e - s, pitch, velocity: 1 })

const lead = { id: 1, name: 'Lead', type: 'Pattern', order: 0, cloneOf: -1, muted: false }
const voice1 = { id: 2, name: 'Lead · Clone 1', type: 'Pattern', order: 1, cloneOf: 1, clone: { kind: 'Voice' }, muted: false }
const trail = { id: 3, name: 'Lead · Trail 1', type: 'Pattern', order: 2, cloneOf: 1, clone: { kind: 'Trail', delayTicks: 480 }, muted: false }
const tracks = [lead, voice1, trail]

// G on the source, E on Clone 1, C overflows (one Voice clone).
const patterns = { 7: { id: 7, regionId: 100, lengthTicks: 3840, notes: [n(1, 0, 960, 67), n(2, 0, 960, 64), n(3, 0, 960, 60)] } }
const patternBlocks = [{ id: 1, trackId: 1, patternId: 7, positionTicks: 0, durationTicks: 3840, offsetTicks: 0, loopEnabled: false }]

function env() {
  const reel = buildReelModel({ tracks, patternBlocks, patterns, regions, sources })
  const reelLanes = {}
  for (const [id, lane] of reel.byTrack) reelLanes[id] = { collapsed: false, subRows: lane.subRows }
  return { reel, trackLayout: buildTrackLayout({ tracks, reelLanes }) }
}

function recordingCtx() {
  const fills = []
  const strokes = []
  const alphas = []
  const ctx = {
    _alpha: 1,
    get globalAlpha() { return this._alpha },
    set globalAlpha(v) { this._alpha = v; alphas.push(v) },
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, drawImage() {}, fillText() {},
    stroke() { strokes.push({ kind: 'path', style: ctx.strokeStyle }) },
    strokeRect(x, y, w, h) { strokes.push({ kind: 'rect', x, y, w, h, style: ctx.strokeStyle }) },
    fillRect(x, y, w, h) { fills.push({ x, y, w, h, style: ctx.fillStyle }) },
  }
  return { ctx, fills, strokes, alphas }
}

function paint(e, { muted = [] } = {}) {
  const rec = recordingCtx()
  drawReelLanes(
    { ctx: rec.ctx, w: 1200, h: 600, scrollOffset: 0, ppb: 40, trackLayout: e.trackLayout, palette, mutedTrackIds: new Set(muted) },
    { reel: e.reel, selection: {} },
  )
  return rec
}

const rowOf = (e, trackId) => e.trackLayout.getReelLaneRows().find((r) => reelLaneTrackId(r) === trackId)
const fillsIn = (rec, row) => rec.fills.filter((f) => f.y >= row.y && f.y + f.h <= row.y + row.height && f.style === palette.reelBody)

describe('Clone rows on the canvas', () => {
  it('the lane track id is the Clone itself for a Clone row, the parent for a Reel lane', () => {
    const e = env()
    expect(reelLaneTrackId(e.trackLayout.getReelRows()[0])).toBe(1)
    expect(reelLaneTrackId(e.trackLayout.cloneRows[0])).toBe(2)
  })

  it('paints the clips each lane plays inside its own row', () => {
    const e = env()
    const rec = paint(e)
    expect(fillsIn(rec, rowOf(e, 1))).toHaveLength(2)   // G + the overflow C
    expect(fillsIn(rec, rowOf(e, 2))).toHaveLength(1)   // E
    expect(fillsIn(rec, rowOf(e, 3))).toHaveLength(2)   // the source cell, delayed
    // The Trail's clips start one 1/8 (480 ticks = half a beat = 20px) later.
    const srcX = fillsIn(rec, rowOf(e, 1))[0].x
    expect(fillsIn(rec, rowOf(e, 3))[0].x).toBe(srcX + 20)
  })

  it('hatches and outlines an overflow note in the warning colour, only in the source lane', () => {
    const e = env()
    const rec = paint(e)
    const warn = rec.strokes.filter((s) => s.style === palette.reelOverflow)
    expect(warn.some((s) => s.kind === 'path')).toBe(true)
    const rects = warn.filter((s) => s.kind === 'rect')
    expect(rects).toHaveLength(1)
    const src = rowOf(e, 1)
    expect(rects[0].y).toBeGreaterThanOrEqual(src.y)
    expect(rects[0].y + rects[0].h).toBeLessThanOrEqual(src.y + src.height)
  })

  it('a hidden (muted) Clone dims its own row; muting the source does not dim its Clones', () => {
    const e = env()
    expect(paint(e, { muted: [2] }).alphas).toEqual([MUTE_OPACITY])
    expect(paint(e, { muted: [1] }).alphas).toEqual([MUTE_OPACITY])  // the source's own lane only
  })

  it('a click in a Clone row hits the SOURCE pattern note, and names the Clone as the lane track', () => {
    const e = env()
    const row = rowOf(e, 2)
    const hit = hitTestReel(e.reel, e.trackLayout, 10, row.y + row.height / 2, 0, 40)
    expect(hit).toMatchObject({ trackId: 2, patternId: 7, noteId: 2, overflow: false })
    const src = rowOf(e, 1)
    // The overflow C stacks in the source lane's second sub-row.
    const low = hitTestReel(e.reel, e.trackLayout, 10, src.y + src.height - 4, 0, 40)
    expect(low).toMatchObject({ trackId: 1, noteId: 3, overflow: true })
  })

  it('hover hints: the overflow fix, and what a Clone lane shows', () => {
    const e = env()
    const src = rowOf(e, 1)
    const over = hitTestReel(e.reel, e.trackLayout, 10, src.y + src.height - 4, 0, 40)
    expect(reelHoverHint(over, tracks).hint).toBe(REEL_OVERFLOW_HINT)
    const v = hitTestReel(e.reel, e.trackLayout, 900, rowOf(e, 2).y + 4, 0, 40)
    expect(reelHoverHint(v, tracks).hint).toMatch(/^Voice clone: /)
    const t = hitTestReel(e.reel, e.trackLayout, 900, rowOf(e, 3).y + 4, 0, 40)
    expect(reelHoverHint(t, tracks).hint).toContain('1/8 later')
    const plain = hitTestReel(e.reel, e.trackLayout, 900, src.y + 2, 0, 40)
    expect(reelHoverHint(plain, tracks)).toBeNull()
    expect(reelHoverHint(null, tracks)).toBeNull()
  })
})
