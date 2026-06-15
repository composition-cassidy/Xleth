import { describe, expect, it } from 'vitest'
import { PlayheadClock } from './PlayheadClock.js'

describe('PlayheadClock', () => {
  it('uses exact beat positions supplied by the transport', () => {
    const clock = new PlayheadClock()
    const frames = []
    clock.onFrame((positionMs, bpm, positionBeats) => {
      frames.push({ positionMs, bpm, positionBeats })
    })

    clock.syncFromEngine(500, 120, false, 42)

    expect(clock.positionBeats).toBe(42)
    expect(frames).toEqual([{ positionMs: 500, bpm: 120, positionBeats: 42 }])
  })

  it('holds a local seek against stale stopped transport polls', () => {
    const clock = new PlayheadClock()
    const frames = []
    clock.onFrame((positionMs, bpm, positionBeats) => {
      frames.push({ positionMs, bpm, positionBeats })
    })

    clock.seekLocally(3000, 120, false, 6)
    clock.syncFromEngine(1000, 120, false, 2)

    expect(clock.positionMs).toBe(3000)
    expect(clock.positionBeats).toBe(6)
    expect(frames).toEqual([{ positionMs: 3000, bpm: 120, positionBeats: 6 }])

    clock.syncFromEngine(3000, 120, false, 6)

    expect(clock.positionMs).toBe(3000)
    expect(clock.positionBeats).toBe(6)
    expect(frames).toEqual([
      { positionMs: 3000, bpm: 120, positionBeats: 6 },
      { positionMs: 3000, bpm: 120, positionBeats: 6 },
    ])
  })
})
