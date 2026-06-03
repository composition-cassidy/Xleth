import { describe, expect, it, vi } from 'vitest'
import {
  buildPatternBlockNoteEvents,
  buildTrackTriggerEvents,
  startEnvelopePlayback,
} from './envelopePlayback.js'

describe('buildPatternBlockNoteEvents', () => {
  const pattern = {
    lengthTicks: 100,
    notes: [
      { positionTicks: 0, durationTicks: 20 },
      { positionTicks: 50, durationTicks: 10 },
    ],
  }

  it('expands notes to absolute timeline ticks for a single (non-looping) window', () => {
    const block = { positionTicks: 1000, durationTicks: 100, offsetTicks: 0, loopEnabled: false }
    expect(buildPatternBlockNoteEvents(block, pattern)).toEqual([
      { kind: 'note', startTick: 1000, endTick: 1020 },
      { kind: 'note', startTick: 1050, endTick: 1060 },
    ])
  })

  it('loops the pattern across a longer block window when loop is enabled', () => {
    const block = { positionTicks: 0, durationTicks: 200, offsetTicks: 0, loopEnabled: true }
    const events = buildPatternBlockNoteEvents(block, pattern)
    // Two loop iterations of the 100-tick pattern -> 4 note triggers.
    expect(events).toHaveLength(4)
    expect(events).toContainEqual({ kind: 'note', startTick: 100, endTick: 120 })
    expect(events).toContainEqual({ kind: 'note', startTick: 150, endTick: 160 })
  })

  it('returns nothing for missing/empty patterns', () => {
    expect(buildPatternBlockNoteEvents({ positionTicks: 0, durationTicks: 100 }, null)).toEqual([])
    expect(buildPatternBlockNoteEvents({ positionTicks: 0, durationTicks: 100 }, { lengthTicks: 0, notes: [] })).toEqual([])
  })
})

describe('buildTrackTriggerEvents', () => {
  it('builds clip + note triggers keyed by String(trackId)', () => {
    const clips = [{ trackId: 7, positionTicks: 0, durationTicks: 480 }]
    const patternBlocks = [{ trackId: 9, patternId: 'p1', positionTicks: 0, durationTicks: 100, offsetTicks: 0, loopEnabled: false }]
    const patterns = { p1: { lengthTicks: 100, notes: [{ positionTicks: 10, durationTicks: 20 }] } }

    const map = buildTrackTriggerEvents({ clips, patternBlocks, patterns })
    expect(map['7']).toEqual([{ kind: 'clip', startTick: 0, endTick: 480 }])
    expect(map['9']).toEqual([{ kind: 'note', startTick: 10, endTick: 30 }])
  })

  it('tolerates empty / missing inputs', () => {
    expect(buildTrackTriggerEvents()).toEqual({})
    expect(buildTrackTriggerEvents({ clips: [null], patternBlocks: [null] })).toEqual({})
  })
})

describe('startEnvelopePlayback', () => {
  it('drives only while playing, resets on transitions, and flushes once on stop', () => {
    let handler = null
    const subscribe = vi.fn((fn) => { handler = fn; return () => {} })
    const store = {
      applyEnvelopeModulationAtTick: vi.fn(async () => ({ ok: true, driven: [] })),
      resetEnvelopeModulationRuntime: vi.fn(),
    }
    const unsubscribe = startEnvelopePlayback({
      subscribe,
      getStore: () => store,
      getTriggerData: () => ({ clips: [], patternBlocks: [], patterns: {} }),
    })

    // First update (stopped) -> transition null->false: reset, then a stop flush pass.
    handler({ positionMs: 0, bpm: 120, isPlaying: false })
    expect(store.resetEnvelopeModulationRuntime).toHaveBeenCalledTimes(1)
    expect(store.applyEnvelopeModulationAtTick).toHaveBeenCalledTimes(1)
    expect(store.applyEnvelopeModulationAtTick.mock.calls[0][1].trackEvents).toEqual({})

    // Start playing -> transition: reset again, then a real drive at the new tick.
    handler({ positionMs: 500, bpm: 120, isPlaying: true })
    expect(store.resetEnvelopeModulationRuntime).toHaveBeenCalledTimes(2)
    expect(store.applyEnvelopeModulationAtTick).toHaveBeenCalledTimes(2)
    expect(store.applyEnvelopeModulationAtTick.mock.calls[1][0]).toBe(960)

    // Continue playing (no transition) -> drive, no extra reset.
    handler({ positionMs: 1000, bpm: 120, isPlaying: true })
    expect(store.resetEnvelopeModulationRuntime).toHaveBeenCalledTimes(2)
    expect(store.applyEnvelopeModulationAtTick).toHaveBeenCalledTimes(3)
    expect(store.applyEnvelopeModulationAtTick.mock.calls[2][0]).toBe(1920)

    // Stop -> transition: reset + one flush pass with empty trackEvents.
    handler({ positionMs: 1000, bpm: 120, isPlaying: false })
    expect(store.resetEnvelopeModulationRuntime).toHaveBeenCalledTimes(3)
    expect(store.applyEnvelopeModulationAtTick).toHaveBeenCalledTimes(4)
    expect(store.applyEnvelopeModulationAtTick.mock.calls[3][1].trackEvents).toEqual({})

    // While stopped (no transition) -> no further drive (does not write forever).
    handler({ positionMs: 1000, bpm: 120, isPlaying: false })
    expect(store.applyEnvelopeModulationAtTick).toHaveBeenCalledTimes(4)

    expect(subscribe).toHaveBeenCalledTimes(1) // single transport subscription
    expect(typeof unsubscribe).toBe('function')
  })

  it('ignores empty transport snapshots', () => {
    let handler = null
    const subscribe = vi.fn((fn) => { handler = fn; return () => {} })
    const store = {
      applyEnvelopeModulationAtTick: vi.fn(),
      resetEnvelopeModulationRuntime: vi.fn(),
    }
    startEnvelopePlayback({ subscribe, getStore: () => store })
    handler(null)
    expect(store.applyEnvelopeModulationAtTick).not.toHaveBeenCalled()
  })
})
