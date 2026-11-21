// Landings: the renderer's pure model (docs/XLETH_LANDING_SPEC.md §8 and §9).
// buildCueLandings is to setCueLandings what buildCueTransition is to
// setCueTransition: every write carries the complete list, so nothing the user
// did not touch falls back to an engine default.
import { describe, expect, it } from 'vitest'
import { beatsToTicks } from '../../constants/timeline.js'
import { buildCueLandings as reExported } from './SnapshotCueLane.jsx'
import {
  DEFAULT_LANDING, LANDING_EASING_PRESETS, LANDING_FROM_OPTIONS, LANDING_MAX_LEAD_IN_TICKS,
  LANDING_MAX_PER_CUE, LANDING_TAIL_HEIGHT, LANDING_TAIL_ROWS,
  buildCueLandings, hitLandingTail, landingCandidates, landingEasingPreset, landingStartTick,
  landingTailRowY, landingTails, leadInFloorTick, normalizeLanding, outgoingSnapshotId,
  snapLeadInBeats, tailLeadInTicks, trackHasSlot, trackIsPlaced,
} from './cueLandings.js'
import { formatLeadInBeats } from './CueLandingsSection.jsx'

const LANDING_KEYS = ['trackId', 'leadInTicks', 'from', 'edgeAngleDeg', 'custom', 'fromOpacity', 'easing']
const LAND = LANDING_EASING_PRESETS.land.curve

describe('landing defaults mirror the engine (TrackLanding)', () => {
  it('one beat, from the bottom edge, no fade, Land', () => {
    expect(DEFAULT_LANDING).toEqual({
      trackId: -1, leadInTicks: 960, from: 'edge', edgeAngleDeg: 270,
      custom: { x: 0, y: 0, w: 0, h: 0 }, fromOpacity: 1,
      easing: { x1: 0.22, y1: 1, x2: 0.36, y2: 1 },
    })
    expect(LANDING_MAX_PER_CUE).toBe(16)
    expect(LANDING_MAX_LEAD_IN_TICKS).toBe(beatsToTicks(16))
  })

  it('names the four starts and the three curves', () => {
    expect(LANDING_FROM_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ['edge', 'Edge'], ['grow', 'Grow'], ['whereItWas', 'Where it was'], ['custom', 'Custom'],
    ])
    expect(LANDING_EASING_PRESETS.land.curve).toEqual({ x1: 0.22, y1: 1, x2: 0.36, y2: 1 })
    expect(LANDING_EASING_PRESETS.glide.curve).toEqual({ x1: 0.65, y1: 0, x2: 0.35, y2: 1 })
    expect(LANDING_EASING_PRESETS.linear.curve).toEqual({ x1: 0, y1: 0, x2: 1, y2: 1 })
    expect(Object.values(LANDING_EASING_PRESETS).map((p) => p.label)).toEqual(['Land', 'Glide', 'Linear'])
  })

  it('recognises a named curve, and calls anything else custom', () => {
    expect(landingEasingPreset(LAND)).toBe('land')
    expect(landingEasingPreset({ x1: 0.65, y1: 0, x2: 0.35, y2: 1 })).toBe('glide')
    expect(landingEasingPreset({ x1: 0, y1: 0, x2: 1, y2: 1 })).toBe('linear')
    expect(landingEasingPreset({ x1: 0.3, y1: 0.3, x2: 0.5, y2: 0.9 })).toBe('custom')
    expect(landingEasingPreset(undefined)).toBe('land')
  })
})

describe('normalizeLanding', () => {
  it('fills every field of a landing that names only its track', () => {
    const landing = normalizeLanding({ trackId: 7 })
    expect(Object.keys(landing).sort()).toEqual([...LANDING_KEYS].sort())
    expect(landing).toEqual({ ...DEFAULT_LANDING, trackId: 7, custom: { x: 0, y: 0, w: 0, h: 0 }, easing: { ...LAND } })
  })

  it('clamps like the engine does', () => {
    const landing = normalizeLanding({
      trackId: 3, leadInTicks: 999999, from: 'teleport', edgeAngleDeg: -90,
      custom: { x: -1, y: 2, w: Number.NaN, h: 0.5 }, fromOpacity: 7,
      easing: { x1: 3, y1: -1, x2: 0.5, y2: 0.5 },
    })
    expect(landing.leadInTicks).toBe(LANDING_MAX_LEAD_IN_TICKS)
    expect(landing.from).toBe('edge')
    expect(landing.edgeAngleDeg).toBe(270)
    expect(landing.custom).toEqual({ x: 0, y: 1, w: 0, h: 0.5 })
    expect(landing.fromOpacity).toBe(1)
    expect(landing.easing).toEqual({ x1: 1, y1: 0, x2: 0.5, y2: 0.5 })
    expect(normalizeLanding({ trackId: 3, leadInTicks: -5 }).leadInTicks).toBe(0)
    expect(normalizeLanding({ trackId: 3, edgeAngleDeg: 720 }).edgeAngleDeg).toBe(0)
    expect(normalizeLanding({ trackId: 3, easing: { x1: Number.NaN } }).easing).toEqual({ ...LAND })
    expect(normalizeLanding({}).trackId).toBe(-1)
    expect(normalizeLanding(null).trackId).toBe(-1)
  })
})

describe('buildCueLandings', () => {
  const current = [
    { trackId: 1, leadInTicks: 960, from: 'whereItWas', edgeAngleDeg: 270,
      custom: { x: 0, y: 0, w: 0, h: 0 }, fromOpacity: 0.7, easing: { ...LAND } },
    { trackId: 2, leadInTicks: 480, from: 'edge', edgeAngleDeg: 270,
      custom: { x: 0, y: 0, w: 0, h: 0 }, fromOpacity: 1, easing: { x1: 0.65, y1: 0, x2: 0.35, y2: 1 } },
  ]

  it('is the same function SnapshotCueLane exports beside buildCueTransition', () => {
    expect(reExported).toBe(buildCueLandings)
  })

  it('returns the complete, normalized list when there is no patch', () => {
    const out = buildCueLandings(current)
    expect(out).toEqual(current)
    expect(out).not.toBe(current)
    for (const landing of out) expect(Object.keys(landing).sort()).toEqual([...LANDING_KEYS].sort())
    expect(buildCueLandings(undefined)).toEqual([])
    expect(buildCueLandings(null, { trackId: 4, remove: true })).toEqual([])
  })

  it('edits one field and keeps every other field of every landing', () => {
    const out = buildCueLandings(current, { trackId: 2, leadInTicks: 240 })
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual(current[0])
    expect(out[1]).toEqual({ ...current[1], leadInTicks: 240 })
    // The acceptance settings survive an unrelated edit on the same landing.
    const opacity = buildCueLandings(current, { trackId: 1, from: 'grow' })
    expect(opacity[0].fromOpacity).toBe(0.7)
    expect(opacity[0].leadInTicks).toBe(960)
    expect(opacity[0].easing).toEqual(LAND)
  })

  it('merges a custom rect and an easing patch field by field', () => {
    const withRect = buildCueLandings(current, { trackId: 1, from: 'custom', custom: { x: 0.25, w: 0.5 } })
    expect(withRect[0].custom).toEqual({ x: 0.25, y: 0, w: 0.5, h: 0 })
    const oneEdge = buildCueLandings(withRect, { trackId: 1, custom: { h: 0.4 } })
    expect(oneEdge[0].custom).toEqual({ x: 0.25, y: 0, w: 0.5, h: 0.4 })
    const curve = buildCueLandings(current, { trackId: 2, easing: { x1: 0, y1: 0, x2: 1, y2: 1 } })
    expect(curve[1].easing).toEqual({ x1: 0, y1: 0, x2: 1, y2: 1 })
  })

  it('adds a landing with the defaults plus the patch', () => {
    const out = buildCueLandings(current, { trackId: 9, from: 'whereItWas' })
    expect(out).toHaveLength(3)
    expect(out[2]).toEqual({ ...DEFAULT_LANDING, trackId: 9, from: 'whereItWas', custom: { x: 0, y: 0, w: 0, h: 0 }, easing: { ...LAND } })
    expect(out.slice(0, 2)).toEqual(current)
  })

  it('removes a landing and leaves the rest in order', () => {
    expect(buildCueLandings(current, { trackId: 1, remove: true })).toEqual([current[1]])
    expect(buildCueLandings(current, { trackId: 99, remove: true })).toEqual(current)
  })

  it('normalizes the patch', () => {
    const out = buildCueLandings(current, { trackId: 1, leadInTicks: -40, fromOpacity: 3, edgeAngleDeg: 450 })
    expect(out[0].leadInTicks).toBe(0)
    expect(out[0].fromOpacity).toBe(1)
    expect(out[0].edgeAngleDeg).toBe(90)
  })

  it('de-duplicates by track: the later entry wins, at the earlier position', () => {
    const out = buildCueLandings([
      { trackId: 1, from: 'edge', leadInTicks: 100 },
      { trackId: 2, from: 'grow' },
      { trackId: 1, from: 'custom', leadInTicks: 300 },
      { from: 'grow' },
    ])
    expect(out.map((l) => [l.trackId, l.from, l.leadInTicks])).toEqual([[1, 'custom', 300], [2, 'grow', 960]])
  })

  it('caps the list at 16 and turns a seventeenth landing away', () => {
    const full = Array.from({ length: 20 }, (_, i) => ({ trackId: 100 + i }))
    const capped = buildCueLandings(full)
    expect(capped).toHaveLength(16)
    expect(capped[15].trackId).toBe(115)
    const more = buildCueLandings(capped, { trackId: 500, from: 'grow' })
    expect(more).toEqual(capped)
    // Editing one that is already there still works on a full cue.
    expect(buildCueLandings(capped, { trackId: 100, leadInTicks: 480 })[0].leadInTicks).toBe(480)
  })

  it('ignores a patch without a track', () => {
    expect(buildCueLandings(current, { leadInTicks: 10 })).toEqual(current)
    expect(buildCueLandings(current, { trackId: -3, from: 'grow' })).toEqual(current)
  })
})

describe('which snapshot a cue leaves, and what it places', () => {
  const snapshots = [
    { id: 'base', name: 'Base', active: true, slotTrackIds: [1, 2], fullscreenTrackIds: [5] },
    { id: 'two', name: 'Two', active: false, slotTrackIds: [1, 2, 3, 4, 4, 77], fullscreenTrackIds: [] },
  ]
  const tracks = [
    { id: 1, name: 'Chords' }, { id: 2, name: 'Bass' }, { id: 3, name: 'Lead' },
    { id: 4, name: '' }, { id: 5, name: 'Backdrop' },
  ]
  const cues = [
    { tick: 7680, snapshotId: 'two' },
    { tick: 15360, snapshotId: 'gone' },
    { tick: 23040, snapshotId: 'base' },
  ]

  it('the outgoing snapshot is the previous cue that still resolves, else the default', () => {
    expect(outgoingSnapshotId(cues, 7680, 'base', snapshots)).toBe('base')
    expect(outgoingSnapshotId(cues, 23040, 'base', snapshots)).toBe('two')   // the dangling cue is skipped
    expect(outgoingSnapshotId([], 100, 'missing', snapshots)).toBe('base')   // falls back to the first
  })

  it('the lead-in floor is the previous resolving pin, or 0', () => {
    expect(leadInFloorTick(cues, 7680, snapshots)).toBe(0)
    expect(leadInFloorTick(cues, 23040, snapshots)).toBe(7680)
    expect(leadInFloorTick(cues, 15360, snapshots)).toBe(7680)
  })

  it('knows a slot from a fullscreen layer', () => {
    expect(trackHasSlot(snapshots[0], 1)).toBe(true)
    expect(trackHasSlot(snapshots[0], 5)).toBe(false)
    expect(trackIsPlaced(snapshots[0], 5)).toBe(true)
    expect(trackIsPlaced(snapshots[0], 3)).toBe(false)
    expect(trackIsPlaced(null, 1)).toBe(false)
    expect(trackIsPlaced({ id: 'old', name: 'no arrays' }, 1)).toBe(false)
  })

  it('offers tracks with a slot in the cue snapshot and no landing yet', () => {
    const cue = { tick: 7680, snapshotId: 'two', landings: [{ trackId: 1 }] }
    expect(landingCandidates(cue, snapshots, tracks)).toEqual([
      { trackId: 2, name: 'Bass' }, { trackId: 3, name: 'Lead' }, { trackId: 4, name: 'Track 4' },
    ])
    // A slot whose track was deleted (77) and a duplicate slot (4) are not offered twice or at all.
    expect(landingCandidates({ tick: 1, snapshotId: 'gone' }, snapshots, tracks)).toEqual([])
    expect(landingCandidates({ tick: 1, snapshotId: 'base' }, snapshots, tracks).map((c) => c.trackId)).toEqual([1, 2])
  })
})

describe('lead-in tails', () => {
  const cue = {
    tick: 7680,
    landings: [
      { trackId: 1, leadInTicks: 960 }, { trackId: 2, leadInTicks: 480 },
      { trackId: 3, leadInTicks: 1920 }, { trackId: 4, leadInTicks: 0 },
      { trackId: 5, leadInTicks: 240 }, { trackId: 6, leadInTicks: 240 },
    ],
  }

  it('one tail per landing in four rows, the rest counted as overflow', () => {
    const { tails, overflow } = landingTails(cue, 0)
    expect(LANDING_TAIL_ROWS).toBe(4)
    expect(tails.map((t) => [t.trackId, t.row, t.startTick])).toEqual([
      [1, 0, 6720], [2, 1, 7200], [3, 2, 5760], [4, 3, 7680],
    ])
    expect(overflow).toBe(2)
    expect(landingTails({ tick: 7680, landings: [] }, 0)).toEqual({ tails: [], overflow: 0 })
  })

  it('a tail cannot start before the previous cue', () => {
    expect(landingStartTick(7680, 1920, 6720)).toBe(6720)
    expect(landingStartTick(7680, 480, 6720)).toBe(7200)
    expect(landingStartTick(480, 1920, 0)).toBe(0)
    expect(landingTails(cue, 7000).tails.map((t) => t.startTick)).toEqual([7000, 7200, 7000, 7680])
    // The stored lead-in is reported as stored; only the drawn start is clamped.
    expect(landingTails(cue, 7000).tails[2].leadInTicks).toBe(1920)
  })

  it('rows fit inside the 24px lane', () => {
    expect(landingTailRowY(0)).toBeGreaterThanOrEqual(8)
    expect(landingTailRowY(LANDING_TAIL_ROWS - 1) + LANDING_TAIL_HEIGHT).toBeLessThanOrEqual(24)
    expect(landingTailRowY(1) - landingTailRowY(0)).toBeGreaterThan(LANDING_TAIL_HEIGHT)
  })

  it('hit-tests the left end, and separates two tails that start together', () => {
    const tickToX = (tick) => tick / 24            // 40 px per beat, no scroll
    const { tails } = landingTails({ tick: 7680, landings: [
      { trackId: 1, leadInTicks: 960 }, { trackId: 2, leadInTicks: 960 }, { trackId: 3, leadInTicks: 480 },
    ] }, 0)
    const startX = tickToX(6720)                   // 280
    expect(hitLandingTail(tails, startX, landingTailRowY(0) + 1, tickToX).trackId).toBe(1)
    expect(hitLandingTail(tails, startX + 4, landingTailRowY(1) + 1, tickToX).trackId).toBe(2)
    expect(hitLandingTail(tails, tickToX(7200), landingTailRowY(2), tickToX).trackId).toBe(3)
    expect(hitLandingTail(tails, startX + 12, landingTailRowY(0), tickToX)).toBe(null)   // the bar, not its end
    expect(hitLandingTail(tails, startX, 2, tickToX)).toBe(null)                         // the top of the lane
    expect(hitLandingTail([], startX, 12, tickToX)).toBe(null)
  })

  it('turns a dragged end into a snapped, clamped lead-in', () => {
    const args = (x, mods = {}, floor = 0) => [x, 0, 40, mods, '1/16', 7680, floor]
    // 40 px per beat: x 240 is beat 6, two beats before the pin at beat 8.
    expect(tailLeadInTicks(...args(240))).toBe(1920)
    expect(tailLeadInTicks(...args(243))).toBe(1920)                 // snaps to the 1/16 grid
    expect(tailLeadInTicks(...args(250))).toBe(1680)                 // beat 6.25
    expect(tailLeadInTicks(...args(243, { alt: true }))).toBe(1848)  // Alt: free, still whole ticks
    expect(tailLeadInTicks(...args(400))).toBe(0)                    // never past the pin
    expect(tailLeadInTicks(...args(100, {}, 6720))).toBe(960)        // never before the previous cue
    expect(tailLeadInTicks(600, 0, 40, {}, '1/16', 30720, 0)).toBe(LANDING_MAX_LEAD_IN_TICKS)
  })

  it('snaps and prints a lead-in in beats', () => {
    expect(snapLeadInBeats(1.1, '1/16')).toBe(1)
    expect(snapLeadInBeats(0.4, '1/8')).toBe(0.5)
    expect(snapLeadInBeats(99, 'Beat')).toBe(16)
    expect(snapLeadInBeats(-2, '1/16')).toBe(0)
    expect(formatLeadInBeats(1)).toBe('1 beat')
    expect(formatLeadInBeats(0.5)).toBe('0.5 beats')
    expect(formatLeadInBeats(2)).toBe('2 beats')
  })
})
