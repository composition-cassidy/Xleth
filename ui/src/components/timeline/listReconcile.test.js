import { describe, it, expect } from 'vitest'
import { reconcileById, recordFieldsEqual } from './listReconcile.js'

const clip = (id, over = {}) => ({
  id, trackId: 1, regionId: 7,
  positionTicks: id * 960, durationTicks: 480, regionOffsetTicks: 0,
  syllableIndex: -1, velocity: 1, pitchOffset: 0, pitchOffsetCents: 0,
  reversed: false, stretchRatio: 1, stretchMethod: 0, formantPreserve: false,
  fadeInPercent: 0, fadeOutPercent: 0,
  fadeInX1: 0, fadeInY1: 0, fadeInX2: 1, fadeInY2: 1,
  fadeOutX1: 0, fadeOutY1: 0, fadeOutX2: 1, fadeOutY2: 1,
  modulation: { vibrato: { enabled: false, depth: 0 } },
  ...over,
})

const block = (id, over = {}) => ({
  id, trackId: 1, patternId: 3,
  positionTicks: id * 3840, durationTicks: 3840, offsetTicks: 0,
  loopEnabled: false,
  ...over,
})

describe('recordFieldsEqual', () => {
  it('ignores fields the patch does not carry', () => {
    // A mutation reply is allowed to be a partial patch — a missing key means
    // "unchanged", never "reset to undefined".
    expect(recordFieldsEqual(clip(1), { id: 1, positionTicks: 960 })).toBe(true)
    expect(recordFieldsEqual(clip(1), { id: 1, positionTicks: 1920 })).toBe(false)
  })

  it('sees a change inside the nested modulation object', () => {
    const prev = clip(1)
    expect(recordFieldsEqual(prev, { id: 1, modulation: { vibrato: { enabled: true, depth: 0 } } }))
      .toBe(false)
    expect(recordFieldsEqual(prev, { id: 1, modulation: { vibrato: { enabled: false, depth: 0 } } }))
      .toBe(true)
  })

  it('treats a nested key added or removed as a change', () => {
    // The structural walk is what makes this hold for fields nobody listed —
    // the reason there is no hand-maintained field list to go stale.
    const prev = clip(1)
    expect(recordFieldsEqual(prev, { id: 1, modulation: {} })).toBe(false)
    expect(recordFieldsEqual(prev, {
      id: 1, modulation: { vibrato: { enabled: false, depth: 0 }, scratch: { enabled: true } },
    })).toBe(false)
  })

  it('compares arrays element-wise, not by identity', () => {
    const prev = clip(1, { modulation: { scratch: { curve: [{ t: 0, v: 1 }] } } })
    expect(recordFieldsEqual(prev, { id: 1, modulation: { scratch: { curve: [{ t: 0, v: 1 }] } } }))
      .toBe(true)
    expect(recordFieldsEqual(prev, { id: 1, modulation: { scratch: { curve: [{ t: 0, v: 2 }] } } }))
      .toBe(false)
    expect(recordFieldsEqual(prev, { id: 1, modulation: { scratch: { curve: [] } } })).toBe(false)
  })
})

describe('reconcileById', () => {
  it('returns the SAME array when the delta is empty', () => {
    const clips = [clip(1), clip(2)]
    expect(reconcileById(clips, {})).toBe(clips)
    expect(reconcileById(clips, { updated: [], removed: [] })).toBe(clips)
  })

  it('returns the SAME array when every update is a no-op', () => {
    // The identity guarantee downstream memos depend on: an engine reply that
    // confirms what the renderer already believed must not churn any object.
    // This is the common case after an optimistic drag repaint.
    const clips = [clip(1), clip(2)]
    expect(reconcileById(clips, { updated: [clip(1), clip(2)] })).toBe(clips)
  })

  it('replaces only the records that actually changed, preserving the rest', () => {
    const clips = [clip(1), clip(2), clip(3)]
    const out = reconcileById(clips, { updated: [{ id: 2, positionTicks: 99 }] })
    expect(out).not.toBe(clips)
    expect(out[0]).toBe(clips[0])          // untouched object identity survives
    expect(out[2]).toBe(clips[2])
    expect(out[1]).not.toBe(clips[1])
    expect(out[1].positionTicks).toBe(99)
    expect(out[1].durationTicks).toBe(480) // unpatched fields carried over
  })

  it('keeps renderer-only fields the engine never sends', () => {
    const clips = [{ ...clip(1), uiSelected: true }]
    const out = reconcileById(clips, { updated: [{ id: 1, positionTicks: 5 }] })
    expect(out[0].uiSelected).toBe(true)
  })

  it('drops removed ids and keeps list order', () => {
    const clips = [clip(1), clip(2), clip(3)]
    const out = reconcileById(clips, { removed: [2] })
    expect(out.map(c => c.id)).toEqual([1, 3])
    expect(out[0]).toBe(clips[0])
    expect(out[1]).toBe(clips[2])
  })

  it('treats an unknown id in `updated` as an insert', () => {
    // This is what makes a paste reply a single delta: pasteClipsBatch hands
    // back the inserted clips and the buried ids together.
    const clips = [clip(1), clip(2)]
    const out = reconcileById(clips, { updated: [clip(9)], removed: [1] })
    expect(out.map(c => c.id)).toEqual([2, 9])
  })

  it('lets `removed` win over `updated` for the same id', () => {
    const clips = [clip(1)]
    const out = reconcileById(clips, { updated: [{ id: 1, positionTicks: 5 }], removed: [1] })
    expect(out).toEqual([])
  })

  it('normalizes objects it creates, and only those', () => {
    const seen = []
    const normalize = (c) => { seen.push(c.id); return { ...c, normalized: true } }
    const clips = [clip(1), clip(2)]
    const out = reconcileById(clips, { updated: [{ id: 2, velocity: 0.5 }], normalize })
    expect(seen).toEqual([2])              // clip 1 was never re-normalized
    expect(out[0].normalized).toBeUndefined()
    expect(out[1].normalized).toBe(true)
  })

  it('accepts a Set for removed', () => {
    const clips = [clip(1), clip(2)]
    expect(reconcileById(clips, { removed: new Set([1]) }).map(c => c.id)).toEqual([2])
  })

  it('survives a null/undefined list', () => {
    expect(reconcileById(undefined, { updated: [clip(1)] }).map(c => c.id)).toEqual([1])
  })

  it('reconciles pattern blocks, not just clips', () => {
    // Same helper backs applyPatternBlockDelta — a paste returns the inserted
    // blocks and the buried ids, and that is the whole round trip.
    const blocks = [block(1), block(2)]
    const out = reconcileById(blocks, {
      updated: [block(5, { loopEnabled: true })],
      removed: [1],
    })
    expect(out.map(b => b.id)).toEqual([2, 5])
    expect(out[0]).toBe(blocks[1])
    expect(out[1].loopEnabled).toBe(true)
  })
})
