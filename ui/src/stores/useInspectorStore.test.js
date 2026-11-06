import { describe, expect, it } from 'vitest'
import { deriveInspectorSelection } from './useInspectorStore.js'

const S = (...ids) => new Set(ids)

describe('deriveInspectorSelection', () => {
  it('nothing selected is null (the honest empty state)', () => {
    expect(deriveInspectorSelection({ clipIds: S(), blockIds: S(), trackIds: S() })).toBeNull()
  })

  it('one clip shows the clip, with its track', () => {
    expect(deriveInspectorSelection({ clipIds: S(7), blockIds: S(), trackIds: S(2), trackIdOfClip: () => 2 }))
      .toEqual({ kind: 'clip', clipId: 7, trackId: 2 })
  })

  it('the set the user changed last wins', () => {
    const sets = { clipIds: S(7), blockIds: S(), trackIds: S(3) }
    expect(deriveInspectorSelection({ ...sets, changed: 'tracks' })).toEqual({ kind: 'track', trackId: 3 })
    expect(deriveInspectorSelection({ ...sets, changed: 'clips' }).kind).toBe('clip')
  })

  it('several items say how many, never a merged editor', () => {
    expect(deriveInspectorSelection({ clipIds: S(1, 2, 3), blockIds: S(), trackIds: S() }))
      .toEqual({ kind: 'multi', noun: 'clips', count: 3 })
    expect(deriveInspectorSelection({ clipIds: S(), blockIds: S(), trackIds: S(1, 2) }))
      .toEqual({ kind: 'multi', noun: 'tracks', count: 2 })
  })

  it('pattern blocks are reported as blocks', () => {
    expect(deriveInspectorSelection({ clipIds: S(), blockIds: S(4), trackIds: S() }))
      .toEqual({ kind: 'blocks', count: 1 })
  })
})
