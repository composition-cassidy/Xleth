import { describe, expect, it } from 'vitest'
import {
  MACRO_AUTOMATION_REJECTION,
  MACRO_AUTOMATION_TARGET,
  addMacroAutomationPoint,
  buildMacroAutomationClipCopyPayload,
  clipsOverlap,
  createMacroAutomationClip,
  deleteMacroAutomationClip,
  deleteMacroAutomationPoint,
  evaluateMacroAutomationClip,
  evaluateMacroAutomationForMacro,
  evaluateMacroAutomationLaneValue,
  findMacroAutomationLane,
  getMacroAutomationClipBinding,
  hideMacroAutomationLane,
  macroClipEndValue,
  moveMacroAutomationClip,
  moveMacroAutomationPoint,
  normalizeMacroAutomationLanes,
  pasteMacroAutomationClip,
  resizeMacroAutomationClip,
  sampleMacroClipCurveAtLocalTick,
  showMacroAutomationLane,
  toggleMacroAutomationClipLoop,
} from './macroAutomation.js'

function macroNode(id, normalizedValue = 0) {
  return { id, type: 'macro', data: { label: id, normalizedValue } }
}

function graphWith(nodes, macroAutomationLanes = []) {
  return { trackId: '7', nodes, edges: [], macroAutomationLanes }
}

let idCounter = 0
const idFactory = () => `id-${++idCounter}`

describe('normalizeMacroAutomationLanes', () => {
  it('returns [] for missing / non-array input (old projects load safely)', () => {
    expect(normalizeMacroAutomationLanes(undefined)).toEqual([])
    expect(normalizeMacroAutomationLanes(null)).toEqual([])
    expect(normalizeMacroAutomationLanes('nope')).toEqual([])
  })

  it('binds a lane to its macroNodeId and target, dedupes per macro', () => {
    const lanes = normalizeMacroAutomationLanes(
      [
        { laneId: 'L1', macroNodeId: 'M1', clips: [] },
        { laneId: 'L2', macroNodeId: 'M1', clips: [] }, // duplicate macro → dropped
        { laneId: 'L3', macroNodeId: 'M2', clips: [] },
      ],
      new Set(['M1', 'M2']),
    )
    expect(lanes).toHaveLength(2)
    expect(lanes[0]).toMatchObject({ laneId: 'L1', macroNodeId: 'M1', target: MACRO_AUTOMATION_TARGET })
    expect(lanes[1].macroNodeId).toBe('M2')
  })

  it('flags lanes for missing macros as orphaned but preserves them', () => {
    const lanes = normalizeMacroAutomationLanes(
      [{ laneId: 'L1', macroNodeId: 'GONE', clips: [{ clipId: 'c', startTick: 0, lengthTicks: 100 }] }],
      new Set(['M1']),
    )
    expect(lanes).toHaveLength(1)
    expect(lanes[0].targetUnavailable).toBe(true)
    expect(lanes[0].clips).toHaveLength(1)
  })

  it('repairs a clip to a flat 2-point clip when points are missing', () => {
    const lanes = normalizeMacroAutomationLanes(
      [{ macroNodeId: 'M1', clips: [{ startTick: 0, lengthTicks: 480 }] }],
      new Set(['M1']),
    )
    const clip = lanes[0].clips[0]
    expect(clip.points).toHaveLength(2)
    expect(clip.points[0].tick).toBe(0)
    expect(clip.points[1].tick).toBe(480)
    expect(typeof clip.clipId).toBe('string')
  })

  it('keeps old off-grid saved clips unchanged during load normalization', () => {
    const lanes = normalizeMacroAutomationLanes(
      [{
        macroNodeId: 'M1',
        clips: [{
          clipId: 'off-grid',
          startTick: 17,
          lengthTicks: 481,
          points: [{ tick: 13, value: 0.1 }, { tick: 379, value: 0.9 }],
        }],
      }],
      new Set(['M1']),
    )
    const clip = lanes[0].clips[0]
    expect(clip.startTick).toBe(17)
    expect(clip.lengthTicks).toBe(481)
    expect(clip.points.map((p) => p.tick)).toEqual([13, 379])
  })

  it('drops same-lane overlapping clips on load (earliest wins)', () => {
    const lanes = normalizeMacroAutomationLanes(
      [{
        macroNodeId: 'M1',
        clips: [
          { clipId: 'a', startTick: 0, lengthTicks: 100 },
          { clipId: 'b', startTick: 50, lengthTicks: 100 }, // overlaps a → dropped
          { clipId: 'c', startTick: 200, lengthTicks: 100 },
        ],
      }],
      new Set(['M1']),
    )
    const ids = lanes[0].clips.map((c) => c.clipId)
    expect(ids).toEqual(['a', 'c'])
  })
})

describe('clipsOverlap', () => {
  it('detects overlap and abutment correctly', () => {
    expect(clipsOverlap({ startTick: 0, lengthTicks: 100 }, { startTick: 50, lengthTicks: 100 })).toBe(true)
    // Abutting clips (end == next start) do NOT overlap.
    expect(clipsOverlap({ startTick: 0, lengthTicks: 100 }, { startTick: 100, lengthTicks: 100 })).toBe(false)
  })
})

describe('lane lifecycle', () => {
  it('shows (creates) a lane bound to the macro and parent track', () => {
    const gs = graphWith([macroNode('M1', 0.3)])
    const result = showMacroAutomationLane(gs, 'M1', { idFactory })
    expect(result.ok).toBe(true)
    const lane = findMacroAutomationLane(result.graphState, 'M1')
    expect(lane.macroNodeId).toBe('M1')
    expect(lane.visible).toBe(true)
    expect(result.graphState.trackId).toBe('7')
  })

  it('rejects show on non-macro / missing node', () => {
    const gs = graphWith([{ id: 'E1', type: 'effect', data: {} }])
    expect(showMacroAutomationLane(gs, 'E1').reason).toBe(MACRO_AUTOMATION_REJECTION.NOT_MACRO_NODE)
    expect(showMacroAutomationLane(gs, 'nope').reason).toBe(MACRO_AUTOMATION_REJECTION.MISSING_MACRO_NODE)
  })

  it('hides a lane without deleting clips', () => {
    let gs = graphWith([macroNode('M1')])
    gs = createMacroAutomationClip(gs, 'M1', { startTick: 0, lengthTicks: 480 }, { idFactory }).graphState
    const hidden = hideMacroAutomationLane(gs, 'M1')
    expect(hidden.ok).toBe(true)
    const lane = findMacroAutomationLane(hidden.graphState, 'M1')
    expect(lane.visible).toBe(false)
    expect(lane.clips).toHaveLength(1)
  })
})

describe('clip lifecycle and overlap rules', () => {
  it('creates a clip seeded flat at the macro current value', () => {
    const gs = graphWith([macroNode('M1', 0.42)])
    const result = createMacroAutomationClip(gs, 'M1', { startTick: 960, lengthTicks: 480 }, { idFactory })
    expect(result.ok).toBe(true)
    const { clip } = findClip(result.graphState, result.clipId)
    expect(clip.startTick).toBe(960)
    expect(clip.points.every((p) => p.value === 0.42)).toBe(true)
  })

  it('rejects an overlapping clip in the SAME lane', () => {
    let gs = graphWith([macroNode('M1')])
    gs = createMacroAutomationClip(gs, 'M1', { startTick: 0, lengthTicks: 480 }, { idFactory }).graphState
    const overlap = createMacroAutomationClip(gs, 'M1', { startTick: 240, lengthTicks: 480 }, { idFactory })
    expect(overlap.ok).toBe(false)
    expect(overlap.reason).toBe(MACRO_AUTOMATION_REJECTION.CLIP_OVERLAP)
  })

  it('allows overlapping clips in DIFFERENT macro lanes under one track', () => {
    let gs = graphWith([macroNode('M1'), macroNode('M2')])
    gs = createMacroAutomationClip(gs, 'M1', { startTick: 0, lengthTicks: 480 }, { idFactory }).graphState
    const other = createMacroAutomationClip(gs, 'M2', { startTick: 0, lengthTicks: 480 }, { idFactory })
    expect(other.ok).toBe(true)
    expect(findMacroAutomationLane(other.graphState, 'M1').clips).toHaveLength(1)
    expect(findMacroAutomationLane(other.graphState, 'M2').clips).toHaveLength(1)
  })

  it('rejects a move that would overlap another clip in the lane', () => {
    let gs = graphWith([macroNode('M1')])
    const a = createMacroAutomationClip(gs, 'M1', { startTick: 0, lengthTicks: 480 }, { idFactory })
    gs = a.graphState
    const b = createMacroAutomationClip(gs, 'M1', { startTick: 1000, lengthTicks: 480 }, { idFactory })
    gs = b.graphState
    const moved = moveMacroAutomationClip(gs, b.clipId, 200) // would overlap a
    expect(moved.reason).toBe(MACRO_AUTOMATION_REJECTION.CLIP_OVERLAP)
    const movedOk = moveMacroAutomationClip(gs, b.clipId, 600)
    expect(movedOk.ok).toBe(true)
  })

  it('resizes a clip and toggles loop', () => {
    let gs = graphWith([macroNode('M1')])
    const a = createMacroAutomationClip(gs, 'M1', { startTick: 0, lengthTicks: 480 }, { idFactory })
    gs = a.graphState
    const resized = resizeMacroAutomationClip(gs, a.clipId, { lengthTicks: 960 })
    expect(findClip(resized.graphState, a.clipId).clip.lengthTicks).toBe(960)
    const looped = toggleMacroAutomationClipLoop(resized.graphState, a.clipId, true)
    expect(findClip(looped.graphState, a.clipId).clip.loopEnabled).toBe(true)
  })

  it('deletes a clip without deleting the lane', () => {
    let gs = graphWith([macroNode('M1')])
    const a = createMacroAutomationClip(gs, 'M1', { startTick: 0, lengthTicks: 480 }, { idFactory })
    const deleted = deleteMacroAutomationClip(a.graphState, a.clipId)
    expect(deleted.ok).toBe(true)
    expect(findMacroAutomationLane(deleted.graphState, 'M1').clips).toHaveLength(0)
  })
})

describe('copy / paste binding rules', () => {
  it('pastes into the same macro lane with a fresh clip id', () => {
    let gs = graphWith([macroNode('M1')])
    const a = createMacroAutomationClip(gs, 'M1', { startTick: 0, lengthTicks: 480 }, { idFactory })
    gs = a.graphState
    const payload = buildMacroAutomationClipCopyPayload(gs, a.clipId)
    expect(payload.sourceMacroNodeId).toBe('M1')
    const pasted = pasteMacroAutomationClip(gs, 'M1', payload, { startTick: 1000, idFactory })
    expect(pasted.ok).toBe(true)
    expect(pasted.clipId).not.toBe(a.clipId)
    expect(findMacroAutomationLane(pasted.graphState, 'M1').clips).toHaveLength(2)
  })

  it('rejects pasting a clip into a different macro lane', () => {
    let gs = graphWith([macroNode('M1'), macroNode('M2')])
    const a = createMacroAutomationClip(gs, 'M1', { startTick: 0, lengthTicks: 480 }, { idFactory })
    gs = a.graphState
    const payload = buildMacroAutomationClipCopyPayload(gs, a.clipId)
    const pasted = pasteMacroAutomationClip(gs, 'M2', payload, { startTick: 0, idFactory })
    expect(pasted.ok).toBe(false)
    expect(pasted.reason).toBe(MACRO_AUTOMATION_REJECTION.INCOMPATIBLE_LANE)
  })
})

describe('point editing', () => {
  it('adds, moves and deletes points (keeps a 2-point minimum)', () => {
    let gs = graphWith([macroNode('M1', 0.5)])
    const a = createMacroAutomationClip(gs, 'M1', { startTick: 0, lengthTicks: 1000 }, { idFactory })
    gs = a.graphState
    gs = addMacroAutomationPoint(gs, a.clipId, { tick: 500, value: 1.0 }).graphState
    expect(findClip(gs, a.clipId).clip.points).toHaveLength(3)

    const moved = moveMacroAutomationPoint(gs, a.clipId, 1, { value: 0.25 })
    expect(findClip(moved.graphState, a.clipId).clip.points[1].value).toBe(0.25)
    gs = moved.graphState

    const del = deleteMacroAutomationPoint(gs, a.clipId, 1)
    expect(findClip(del.graphState, a.clipId).clip.points).toHaveLength(2)

    // Cannot delete below 2 points.
    const tooFew = deleteMacroAutomationPoint(del.graphState, a.clipId, 0)
    expect(tooFew.reason).toBe(MACRO_AUTOMATION_REJECTION.MIN_POINTS)
  })

  it('repairs added and moved point ticks to stay inside clip bounds', () => {
    let gs = graphWith([macroNode('M1', 0.5)])
    const a = createMacroAutomationClip(gs, 'M1', { startTick: 0, lengthTicks: 1000 }, { idFactory })
    gs = a.graphState

    gs = addMacroAutomationPoint(gs, a.clipId, { tick: 2000, value: 0.77 }).graphState
    expect(findClip(gs, a.clipId).clip.points.every((p) => p.tick >= 0 && p.tick <= 1000)).toBe(true)

    gs = moveMacroAutomationPoint(gs, a.clipId, 0, { tick: 9999, value: 0.33 }).graphState
    expect(findClip(gs, a.clipId).clip.points.every((p) => p.tick >= 0 && p.tick <= 1000)).toBe(true)
  })

  it('repairs duplicate edited point positions safely', () => {
    let gs = graphWith([macroNode('M1', 0.5)])
    const a = createMacroAutomationClip(gs, 'M1', { startTick: 0, lengthTicks: 1000 }, { idFactory })
    gs = addMacroAutomationPoint(a.graphState, a.clipId, { tick: 500, value: 0.25 }).graphState

    const moved = moveMacroAutomationPoint(gs, a.clipId, 1, { tick: 0, value: 0.75 })
    expect(moved.ok).toBe(true)
    const ticks = findClip(moved.graphState, a.clipId).clip.points.map((p) => p.tick)
    expect(new Set(ticks).size).toBe(ticks.length)
    expect(ticks.length).toBeGreaterThanOrEqual(2)
  })

  it('clamps points safely when resizing a clip shorter', () => {
    let gs = graphWith([macroNode('M1', 0.5)])
    const a = createMacroAutomationClip(gs, 'M1', {
      startTick: 0,
      lengthTicks: 1000,
      points: [{ tick: 0, value: 0 }, { tick: 800, value: 1 }, { tick: 1000, value: 0.5 }],
    }, { idFactory })
    const resized = resizeMacroAutomationClip(a.graphState, a.clipId, { lengthTicks: 480 })
    expect(resized.ok).toBe(true)
    expect(findClip(resized.graphState, a.clipId).clip.points.every((p) => p.tick <= 480)).toBe(true)
  })
})

describe('curve sampling', () => {
  it('linearly interpolates between points and holds at the ends', () => {
    const points = [
      { tick: 0, value: 0, curve: 'linear' },
      { tick: 100, value: 1, curve: 'linear' },
    ]
    expect(sampleMacroClipCurveAtLocalTick(points, -10)).toBe(0)
    expect(sampleMacroClipCurveAtLocalTick(points, 50)).toBeCloseTo(0.5, 5)
    expect(sampleMacroClipCurveAtLocalTick(points, 200)).toBe(1)
  })
})

describe('clip evaluation', () => {
  it('is inactive outside its bounds', () => {
    const clip = clipFromPoints({ startTick: 100, lengthTicks: 100 }, [
      { tick: 0, value: 0.2 }, { tick: 100, value: 0.8 },
    ])
    expect(evaluateMacroAutomationClip(clip, 50).active).toBe(false)
    expect(evaluateMacroAutomationClip(clip, 200).active).toBe(false)
    expect(evaluateMacroAutomationClip(clip, 150).active).toBe(true)
  })

  it('loops only inside bounds using first/last point as the loop range', () => {
    // points at local 0..100 inside a 300-long clip; loop repeats the 0..100 ramp.
    const clip = clipFromPoints({ startTick: 0, lengthTicks: 300, loopEnabled: true }, [
      { tick: 0, value: 0 }, { tick: 100, value: 1 },
    ])
    expect(evaluateMacroAutomationClip(clip, 50).value).toBeCloseTo(0.5, 5)
    // 150 → (150-0) % 100 = 50 → 0.5 again (looped), not held at 1.
    expect(evaluateMacroAutomationClip(clip, 150).value).toBeCloseTo(0.5, 5)
    expect(evaluateMacroAutomationClip(clip, 250).value).toBeCloseTo(0.5, 5)
    // Outside the clip the loop does nothing.
    expect(evaluateMacroAutomationClip(clip, 300).active).toBe(false)
  })

  it('without loop, end value equals the last point (clip ends at 80%)', () => {
    const clip = clipFromPoints({ startTick: 0, lengthTicks: 200 }, [
      { tick: 0, value: 0.1 }, { tick: 100, value: 0.8 },
    ])
    expect(macroClipEndValue(clip)).toBeCloseTo(0.8, 5)
  })
})

describe('lane evaluation — hold last value', () => {
  function laneFromClips(clips) {
    return { laneId: 'L', macroNodeId: 'M1', target: MACRO_AUTOMATION_TARGET, visible: true, clips }
  }

  it('uses the macro fallback when no earlier clip exists', () => {
    const lane = laneFromClips([
      clipFromPoints({ startTick: 1000, lengthTicks: 100 }, [{ tick: 0, value: 0.3 }, { tick: 100, value: 0.9 }]),
    ])
    expect(evaluateMacroAutomationLaneValue(lane, 0, 0.55)).toBeCloseTo(0.55, 5)
  })

  it('holds the last clip end value in empty space after a clip ends at 80%', () => {
    const lane = laneFromClips([
      clipFromPoints({ startTick: 0, lengthTicks: 200 }, [{ tick: 0, value: 0.1 }, { tick: 100, value: 0.8 }]),
    ])
    // After the clip ends, value holds 0.8 (not 0.0, not the fallback default).
    expect(evaluateMacroAutomationLaneValue(lane, 500, 0.0)).toBeCloseTo(0.8, 5)
  })

  it('a later clip takes over the value', () => {
    const lane = laneFromClips([
      clipFromPoints({ startTick: 0, lengthTicks: 100 }, [{ tick: 0, value: 0.1 }, { tick: 100, value: 0.8 }]),
      clipFromPoints({ startTick: 200, lengthTicks: 100 }, [{ tick: 0, value: 0.2 }, { tick: 100, value: 0.2 }]),
    ])
    // In the gap → hold 0.8; inside the later clip → its value 0.2.
    expect(evaluateMacroAutomationLaneValue(lane, 150, 0)).toBeCloseTo(0.8, 5)
    expect(evaluateMacroAutomationLaneValue(lane, 250, 0)).toBeCloseTo(0.2, 5)
  })

  it('orphaned lanes evaluate to the fallback (never drive a missing macro)', () => {
    const lane = { ...laneFromClips([
      clipFromPoints({ startTick: 0, lengthTicks: 100 }, [{ tick: 0, value: 0.9 }, { tick: 100, value: 0.9 }]),
    ]), targetUnavailable: true }
    expect(evaluateMacroAutomationLaneValue(lane, 50, 0.3)).toBeCloseTo(0.3, 5)
  })
})

describe('evaluateMacroAutomationForMacro', () => {
  it('reports hasAutomation false for a macro with no lane/clips', () => {
    const gs = graphWith([macroNode('M1', 0.7)])
    const r = evaluateMacroAutomationForMacro(gs, 'M1', 0, 0.7)
    expect(r.hasAutomation).toBe(false)
    expect(r.value).toBeCloseTo(0.7, 5)
  })

  it('reports hasAutomation true and evaluates the lane when a clip exists', () => {
    let gs = graphWith([macroNode('M1', 0.7)])
    const a = createMacroAutomationClip(gs, 'M1', { startTick: 0, lengthTicks: 100 }, { idFactory })
    gs = addMacroAutomationPoint(a.graphState, a.clipId, { tick: 100, value: 1.0 }).graphState
    // Move first point to 0 value to make a ramp 0→1.
    gs = moveMacroAutomationPoint(gs, a.clipId, 0, { value: 0 }).graphState
    const r = evaluateMacroAutomationForMacro(gs, 'M1', 50, 0.7)
    expect(r.hasAutomation).toBe(true)
    expect(r.value).toBeGreaterThan(0)
    expect(r.value).toBeLessThan(1)
  })
})

describe('getMacroAutomationClipBinding', () => {
  it('exposes parentTrackId from the owning graphState', () => {
    let gs = graphWith([macroNode('M1')])
    const a = createMacroAutomationClip(gs, 'M1', { startTick: 0, lengthTicks: 100 }, { idFactory })
    const binding = getMacroAutomationClipBinding(a.graphState, a.clipId)
    expect(binding).toMatchObject({
      parentTrackId: '7',
      macroNodeId: 'M1',
      clipId: a.clipId,
      target: MACRO_AUTOMATION_TARGET,
    })
  })
})

// ---- helpers ----
function findClip(graphState, clipId) {
  for (const lane of graphState.macroAutomationLanes) {
    const clip = lane.clips.find((c) => c.clipId === clipId)
    if (clip) return { lane, clip }
  }
  throw new Error(`clip ${clipId} not found`)
}

function clipFromPoints(base, points) {
  return {
    clipId: 'c',
    startTick: base.startTick,
    lengthTicks: base.lengthTicks,
    loopEnabled: base.loopEnabled === true,
    points: points.map((p) => ({ tick: p.tick, value: p.value, curve: 'linear' })),
  }
}
