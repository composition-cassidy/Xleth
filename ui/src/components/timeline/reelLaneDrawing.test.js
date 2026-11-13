import { beforeEach, describe, expect, it, vi } from 'vitest'

// The still cache is the only collaborator with the engine; replace it so the
// painter is tested on its own and the thumbnail decision is observable.
const stillCalls = []
vi.mock('./reelStills.js', () => ({
  getReelStill: (desc) => { stillCalls.push(desc); return { naturalWidth: 320, naturalHeight: 180 } },
}))

import { drawReelLanes, hitTestReel } from './reelLaneDrawing.js'
import { buildReelModel, REEL_THUMB_MIN_W } from './reelLaneModel.js'
import { buildTrackLayout } from './timelineRowLayout.js'
import { beatsToTicks } from '../../constants/timeline.js'
const T = (beats) => beatsToTicks(beats)

const palette = { reelBody: '#323232', reelBodySelected: '#444444', reelBadgeInk: '#b4b4b4', select: '#ffffff' }
const tracks = [{ id: 1, type: 'Pattern' }]
const sources = { 10: { id: 10, hasVideo: true, filePath: 'a.mp4', duration: 4 } }
const regions = { 100: { id: 100, sourceId: 10, startTime: 0 } }

function setup(notes, { subRowsOverride, collapsed = false } = {}) {
  const patterns = { 1: { id: 1, regionId: 100, lengthTicks: T(64), notes } }
  const patternBlocks = [{ id: 1, trackId: 1, patternId: 1, positionTicks: 0, durationTicks: T(64), offsetTicks: 0, loopEnabled: false }]
  const reel = buildReelModel({ tracks, patternBlocks, patterns, regions, sources })
  const subRows = subRowsOverride ?? reel.byTrack.get(1).subRows
  const trackLayout = buildTrackLayout({ tracks, reelLanes: { 1: { collapsed, subRows } } })
  return { reel, trackLayout }
}

function fakeCtx() {
  const calls = { fillRect: [], drawImage: [], strokeRect: [] }
  const ctx = {
    calls, globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    fillRect: (...a) => calls.fillRect.push(a),
    strokeRect: (...a) => calls.strokeRect.push(a),
    drawImage: (...a) => calls.drawImage.push(a),
    fillText() {},
  }
  return ctx
}

const note = (id, positionTicks, durationTicks) => ({ id, positionTicks, durationTicks, pitch: 60, velocity: 1 })

function paint(env, { ppb = 40, scrollOffset = 0, selection = {}, muted = false, w = 1200, h = 400 } = {}) {
  const ctx = fakeCtx()
  drawReelLanes(
    { ctx, w, h, scrollOffset, ppb, trackLayout: env.trackLayout, palette, mutedTrackIds: new Set(muted ? [1] : []) },
    { reel: env.reel, selection },
  )
  return ctx
}

beforeEach(() => { stillCalls.length = 0 })

describe('drawReelLanes: thumbnail threshold', () => {
  // One beat-long note: its width is exactly ppb pixels (less the 1px gap).
  const env = () => setup([note(1, 0, T(1))])

  it('a clip below the threshold is a plain block: no image, and no still is even requested', () => {
    const ctx = paint(env(), { ppb: REEL_THUMB_MIN_W - 2 })
    expect(ctx.calls.fillRect.length).toBeGreaterThan(0)
    expect(ctx.calls.drawImage.length).toBe(0)
    expect(stillCalls.length).toBe(0)
  })

  it('at or above it the clip shows its region still', () => {
    const ctx = paint(env(), { ppb: REEL_THUMB_MIN_W + 2 })
    expect(ctx.calls.drawImage.length).toBe(1)
    expect(stillCalls[0]).toMatchObject({ regionId: 100 })
  })

  it('crosses the threshold as the user zooms (several zoom levels)', () => {
    const results = [8, 16, 24, 28, 32, 64, 128, 400].map((ppb) => [ppb, paint(env(), { ppb }).calls.drawImage.length])
    // painted width is ppb - 1 (the gap); the threshold applies to the painted width
    expect(results).toEqual([[8, 0], [16, 0], [24, 0], [28, 0], [32, 1], [64, 1], [128, 1], [400, 1]])
  })

  it('the thumbnail is cover-cropped (never squashed) and stays inside the clip', () => {
    const ctx = paint(env(), { ppb: 200 })
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = ctx.calls.drawImage[0]
    expect(sw / sh).toBeCloseTo(dw / dh, 3)
    expect(dw).toBeLessThanOrEqual(199)
    expect(dh).toBeGreaterThan(0)
    expect([sx, sy].every((v) => v >= 0)).toBe(true)
  })
})

describe('drawReelLanes: what is drawn', () => {
  it('draws nothing for a collapsed lane or off-screen clips', () => {
    expect(paint(setup([note(1, 0, T(1))], { collapsed: true })).calls.fillRect.length).toBe(0)
    expect(paint(setup([note(1, 0, T(1))]), { scrollOffset: 10 }).calls.fillRect.length).toBe(0)
  })

  it('a selected clip is a lighter step AND outlined (not colour alone)', () => {
    const env = setup([note(1, 0, T(1)), note(2, T(2), T(1))])
    const ctx = paint(env, { ppb: 40, selection: { 1: new Set([2]) } })
    expect(ctx.calls.strokeRect.length).toBe(1)
  })

  it('selection is per pattern: the same note id in another pattern is not selected', () => {
    const env = setup([note(1, 0, T(1))])
    expect(paint(env, { selection: { 2: new Set([1]) } }).calls.strokeRect.length).toBe(0)
    expect(paint(env, { selection: { 1: new Set([1]) } }).calls.strokeRect.length).toBe(1)
  })

  it('a muted track dims its lane', () => {
    const ctx = fakeCtx()
    const alphas = []
    Object.defineProperty(ctx, 'globalAlpha', { get: () => 1, set: (v) => alphas.push(v) })
    const env = setup([note(1, 0, T(1))])
    drawReelLanes(
      { ctx, w: 1200, h: 400, scrollOffset: 0, ppb: 40, trackLayout: env.trackLayout, palette, mutedTrackIds: new Set([1]) },
      { reel: env.reel, selection: {} },
    )
    expect(alphas).toEqual([0.45])
  })

  it('overlapping notes are painted in different sub-rows', () => {
    const env = setup([note(1, 0, T(2)), note(2, T(1), T(2))])
    const ys = new Set(paint(env).calls.fillRect.map((r) => r[1]))
    expect(ys.size).toBe(2)
  })

  it('stays inside the lane even with many sub-rows (compression)', () => {
    const notes = []
    for (let i = 0; i < 8; i++) notes.push(note(i + 1, 0, T(4)))
    const env = setup(notes)
    const row = env.trackLayout.getReelRows()[0]
    for (const [, y, , h] of paint(env).calls.fillRect) {
      expect(y).toBeGreaterThanOrEqual(row.y)
      expect(y + h).toBeLessThanOrEqual(row.y + row.height)
    }
  })
})

describe('hitTestReel', () => {
  const env = () => setup([note(1, 0, T(2)), note(2, T(1), T(2)), note(3, T(8), T(1))])
  const rowOf = (e) => e.trackLayout.getReelRows()[0]

  it('returns null outside any Reel lane', () => {
    const e = env()
    expect(hitTestReel(e.reel, e.trackLayout, 50, 5, 0, 40)).toBeNull()
  })

  it('finds the note under the pointer, by pattern and note id', () => {
    const e = env()
    const row = rowOf(e)
    // sub-row 0 is the upper one; note 1 occupies 0..80px there
    const top = hitTestReel(e.reel, e.trackLayout, 20, row.y + 8, 0, 40)
    expect(top).toMatchObject({ patternId: 1, noteId: 1 })
    const lower = hitTestReel(e.reel, e.trackLayout, 60, row.y + row.height - 6, 0, 40)
    expect(lower).toMatchObject({ patternId: 1, noteId: 2 })
  })

  it('empty lane space is a miss inside the lane (so a click can clear the selection)', () => {
    const e = env()
    const hit = hitTestReel(e.reel, e.trackLayout, 600, rowOf(e).y + 8, 0, 40)
    expect(hit).toMatchObject({ patternId: null, noteId: null })
    expect(hit.row).toBe(rowOf(e))
  })

  it('a collapsed strip never hits a clip', () => {
    const e = setup([note(1, 0, T(2))], { collapsed: true })
    const hit = hitTestReel(e.reel, e.trackLayout, 20, rowOf(e).y + 8, 0, 40)
    expect(hit.noteId).toBeNull()
  })

  it('agrees with where the painter put the clip (scrolled and zoomed)', () => {
    const e = setup([note(7, T(20), T(1))])
    const ppb = 100
    const scrollOffset = 19
    const ctx = paint(e, { ppb, scrollOffset })
    const [x, y, w, h] = ctx.calls.fillRect[0]
    const hit = hitTestReel(e.reel, e.trackLayout, x + w / 2, y + h / 2, scrollOffset, ppb)
    expect(hit.noteId).toBe(7)
  })
})
