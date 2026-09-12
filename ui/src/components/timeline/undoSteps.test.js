import { describe, expect, it } from 'vitest'
import { deleteUndoSteps, moveUndoSteps, pitchShiftUndoSteps } from './undoSteps.js'

const ids = (n) => Array.from({ length: n }, (_, i) => i + 1)

describe('deleteUndoSteps', () => {
  it('counts ONE entry for the whole clip selection (removeClipsBatch)', () => {
    expect(deleteUndoSteps({ clipIds: ids(40) })).toBe(1)
  })

  it('counts one entry PER pattern block — the case Ctrl+Z used to under-pop', () => {
    // N× removePatternBlock, no batch RPC. Ctrl+Z popped 1 and put back a
    // single block out of the whole bulk delete.
    expect(deleteUndoSteps({ blockIds: ids(7) })).toBe(7)
  })

  it('counts one entry per automation clip', () => {
    expect(deleteUndoSteps({ automationClipIds: ids(3) })).toBe(3)
  })

  it('sums a mixed selection', () => {
    expect(deleteUndoSteps({
      clipIds: ids(12), blockIds: ids(4), automationClipIds: ids(2),
    })).toBe(1 + 4 + 2)
  })

  it('is zero for an empty selection, so the ref never latches a stale count', () => {
    expect(deleteUndoSteps({})).toBe(0)
    expect(deleteUndoSteps()).toBe(0)
  })
})

describe('pitchShiftUndoSteps', () => {
  it('counts one pitchShiftClip entry per selected clip', () => {
    expect(pitchShiftUndoSteps(ids(9))).toBe(9)
  })

  it('is zero for an empty selection', () => {
    expect(pitchShiftUndoSteps([])).toBe(0)
  })
})

describe('moveUndoSteps', () => {
  it('collapses a batched clip move to remove + move = 2', () => {
    expect(moveUndoSteps({
      doomedCount: 5, moveCount: 8, batchedRemove: true, batchedMove: true,
    })).toBe(2)
  })

  it('drops the remove entry when the move overwrote nothing', () => {
    expect(moveUndoSteps({
      doomedCount: 0, moveCount: 8, batchedRemove: true, batchedMove: true,
    })).toBe(1)
  })

  it('counts per item for pattern blocks, which have no batch RPC', () => {
    expect(moveUndoSteps({
      doomedCount: 2, moveCount: 6, batchedRemove: false, batchedMove: false,
    })).toBe(8)
  })

  it('is zero for a gesture that touched nothing', () => {
    expect(moveUndoSteps({})).toBe(0)
  })
})
