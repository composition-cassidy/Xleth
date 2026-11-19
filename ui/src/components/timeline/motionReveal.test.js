// @vitest-environment jsdom
// The Motion view reveal request (docs/XLETH_MOTION_VIEW_DESIGN.md 5.2): one window
// CustomEvent, 'xleth-motion-reveal', detail { trackId, path }.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MOTION_REVEAL_EVENT, requestMotionReveal } from './motionReveal.js'

let seen
const onReveal = (e) => { seen.push(e) }
beforeEach(() => { seen = []; window.addEventListener(MOTION_REVEAL_EVENT, onReveal) })
afterEach(() => { window.removeEventListener(MOTION_REVEAL_EVENT, onReveal) })

describe('requestMotionReveal', () => {
  it('is the event the design names', () => {
    expect(MOTION_REVEAL_EVENT).toBe('xleth-motion-reveal')
  })

  it('dispatches ONE window CustomEvent with { trackId, path }', () => {
    expect(requestMotionReveal(12, ['roam'])).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(CustomEvent)
    expect(seen[0].detail).toEqual({ trackId: 12, path: ['roam'] })
  })

  it('the path defaults to the track row; junk path entries are dropped', () => {
    requestMotionReveal(3)
    requestMotionReveal(3, ['sweep', '', null, 4])
    requestMotionReveal(3, 'roam')
    expect(seen.map((e) => e.detail)).toEqual([
      { trackId: 3, path: [] },
      { trackId: 3, path: ['sweep'] },
      { trackId: 3, path: [] },
    ])
  })

  it('without a usable track id nothing is sent', () => {
    for (const id of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, true]) {
      expect(requestMotionReveal(id, ['roam'])).toBe(false)
    }
    expect(seen).toHaveLength(0)
  })

  it('does not share the caller\'s array: a later change to it does not reach the listener', () => {
    const path = ['roam']
    requestMotionReveal(5, path)
    path.push('sweep')
    expect(seen[0].detail.path).toEqual(['roam'])
  })
})
