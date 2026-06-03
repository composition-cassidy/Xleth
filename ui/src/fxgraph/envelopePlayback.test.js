import { describe, expect, it, vi } from 'vitest'
import {
  ENVELOPE_DRIVE_INTERVAL_MS,
  buildPatternBlockNoteEvents,
  buildTrackTriggerEvents,
  startEnvelopePlayback,
} from './envelopePlayback.js'
import { positionMsToTick } from './macroAutomationPlayback.js'

// Lets pending promise .catch/.finally chains settle (pump's single-in-flight guard releases
// inFlight in a .finally, which is a macrotask away from a synchronous frame() call).
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

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
  // EVC-R2-r1 — drive is fed by PlayheadClock.onFrame; the transport poll is lifecycle only.
  function makeHarness({ store, getTriggerData, applyImpl } = {}) {
    let transportHandler = null
    let frameHandler = null
    const subscribe = vi.fn((fn) => { transportHandler = fn; return () => {} })
    const onFrame = vi.fn((fn) => { frameHandler = fn; return () => {} })
    let playing = false
    let nowMs = 1_000_000
    const theStore = store ?? {
      applyEnvelopeModulationAtTick: vi.fn(applyImpl ?? (async () => ({ ok: true, driven: [] }))),
      resetEnvelopeModulationRuntime: vi.fn(),
    }
    const unsubscribe = startEnvelopePlayback({
      subscribe,
      onFrame,
      getStore: () => theStore,
      getIsPlaying: () => playing,
      now: () => nowMs,
      getTriggerData: getTriggerData ?? (() => ({ clips: [], patternBlocks: [], patterns: {} })),
    })
    return {
      unsubscribe,
      subscribe,
      onFrame,
      store: theStore,
      transport: (t) => transportHandler(t),
      frame: (positionMs, bpm) => frameHandler(positionMs, bpm),
      setPlaying: (v) => { playing = v },
      setNow: (ms) => { nowMs = ms },
      advance: (ms) => { nowMs += ms },
    }
  }

  it('subscribes to both the transport poller and PlayheadClock.onFrame exactly once', () => {
    const h = makeHarness()
    expect(h.subscribe).toHaveBeenCalledTimes(1) // single transport subscription (lifecycle)
    expect(h.onFrame).toHaveBeenCalledTimes(1)   // single onFrame source (no new rAF/poller)
    expect(typeof h.unsubscribe).toBe('function')
  })

  it('drives from onFrame while playing, not from the transport poll', async () => {
    const h = makeHarness()

    // A transport poll while playing must NOT drive a per-tick parameter pass.
    h.setPlaying(true)
    h.transport({ positionMs: 500, bpm: 120, isPlaying: true }) // play transition: reset only
    expect(h.store.resetEnvelopeModulationRuntime).toHaveBeenCalledTimes(1)
    expect(h.store.applyEnvelopeModulationAtTick).not.toHaveBeenCalled()

    // An onFrame supplies the interpolated position and drives the envelope.
    h.frame(500, 120)
    await flush()
    expect(h.store.applyEnvelopeModulationAtTick).toHaveBeenCalledTimes(1)
    expect(h.store.applyEnvelopeModulationAtTick.mock.calls[0][0]).toBe(positionMsToTick(500, 120))
  })

  it('does not drive while stopped and ignores empty transport snapshots', async () => {
    const h = makeHarness()
    h.transport(null)
    h.setPlaying(false)
    h.frame(500, 120) // not playing -> guarded
    await flush()
    expect(h.store.applyEnvelopeModulationAtTick).not.toHaveBeenCalled()
  })

  it('throttles drive to ENVELOPE_DRIVE_INTERVAL_MS', async () => {
    const h = makeHarness()
    h.setPlaying(true)

    h.setNow(2_000_000)
    h.frame(0, 120)
    await flush()
    expect(h.store.applyEnvelopeModulationAtTick).toHaveBeenCalledTimes(1)

    // Same instant -> within the throttle window -> dropped.
    h.frame(10, 120)
    await flush()
    expect(h.store.applyEnvelopeModulationAtTick).toHaveBeenCalledTimes(1)

    // One interval later -> accepted.
    h.advance(ENVELOPE_DRIVE_INTERVAL_MS)
    h.frame(20, 120)
    await flush()
    expect(h.store.applyEnvelopeModulationAtTick).toHaveBeenCalledTimes(2)
  })

  it('writes far more often than once per 200ms across a simulated playing second', async () => {
    const h = makeHarness()
    h.setPlaying(true)
    h.setNow(0)
    for (let i = 0; i < 60; i += 1) {
      h.frame(i * ENVELOPE_DRIVE_INTERVAL_MS, 120)
      await flush()
      h.advance(ENVELOPE_DRIVE_INTERVAL_MS)
    }
    // A 200ms poll would yield ~5 writes/second; onFrame yields ~60.
    expect(h.store.applyEnvelopeModulationAtTick.mock.calls.length).toBeGreaterThan(5)
    expect(h.store.applyEnvelopeModulationAtTick.mock.calls.length).toBeGreaterThanOrEqual(30)
  })

  it('produces multiple intermediate writes for a short ADSR under 200ms', async () => {
    const h = makeHarness()
    h.setPlaying(true)
    h.setNow(0)
    const ticks = []
    for (let i = 0; i < 6; i += 1) { // ~100ms window
      const posMs = i * ENVELOPE_DRIVE_INTERVAL_MS
      h.frame(posMs, 120)
      await flush()
      h.advance(ENVELOPE_DRIVE_INTERVAL_MS)
    }
    for (const call of h.store.applyEnvelopeModulationAtTick.mock.calls) ticks.push(call[0])
    expect(ticks.length).toBeGreaterThanOrEqual(3)
    // Distinct, increasing ticks within the sub-200ms window.
    expect(new Set(ticks).size).toBe(ticks.length)
  })

  it('drives from onFrame even when the first transport poll is late', async () => {
    const h = makeHarness()
    // PlayheadClock is already interpolating (playing) but the 200ms poll has not fired yet.
    h.setPlaying(true)
    h.frame(500, 120)
    await flush()
    expect(h.store.applyEnvelopeModulationAtTick).toHaveBeenCalledTimes(1)
    expect(h.store.applyEnvelopeModulationAtTick.mock.calls[0][0]).toBe(positionMsToTick(500, 120))
  })

  it('latest-wins: a slow write never overlaps and never lets an older tick land last', async () => {
    const resolvers = []
    const apply = vi.fn(() => new Promise((res) => { resolvers.push(res) }))
    const h = makeHarness({ store: { applyEnvelopeModulationAtTick: apply, resetEnvelopeModulationRuntime: vi.fn() } })
    h.setPlaying(true)
    h.setNow(0)

    h.frame(100, 120) // drives tick A (in flight, unresolved)
    expect(apply).toHaveBeenCalledTimes(1)
    const tickA = positionMsToTick(100, 120)
    expect(apply.mock.calls[0][0]).toBe(tickA)

    h.advance(ENVELOPE_DRIVE_INTERVAL_MS)
    h.frame(200, 120) // queued as latest (B)
    h.advance(ENVELOPE_DRIVE_INTERVAL_MS)
    h.frame(300, 120) // overwrites latest (C) — B is dropped, never replayed
    expect(apply).toHaveBeenCalledTimes(1) // no overlap while A is in flight

    resolvers[0]({ ok: true })
    await flush()
    // On resolve, the newest tick (C) drives — not the stale B.
    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply.mock.calls[1][0]).toBe(positionMsToTick(300, 120))

    resolvers[1]({ ok: true })
    await flush()
    expect(apply).toHaveBeenCalledTimes(2) // B was never written
  })

  it('flushes connected parameters to 0 exactly once on stop, after any in-flight drive', async () => {
    const resolvers = []
    const apply = vi.fn(() => new Promise((res) => { resolvers.push(res) }))
    const reset = vi.fn()
    const h = makeHarness({ store: { applyEnvelopeModulationAtTick: apply, resetEnvelopeModulationRuntime: reset } })

    h.setPlaying(true)
    h.transport({ positionMs: 0, bpm: 120, isPlaying: true }) // play transition (reset #1)
    h.setNow(0)
    h.frame(500, 120) // drive A (in flight)
    expect(apply).toHaveBeenCalledTimes(1)

    // Stop arrives mid-flight: the flush is deferred behind the in-flight non-zero write.
    h.setPlaying(false)
    h.transport({ positionMs: 500, bpm: 120, isPlaying: false })
    expect(apply).toHaveBeenCalledTimes(1) // not yet — waiting for in-flight to resolve

    resolvers[0]({ ok: true })
    await flush()
    // Now the flush lands last, with empty gates -> writes 0.
    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply.mock.calls[1][1].trackEvents).toEqual({})
    expect(reset).toHaveBeenCalledTimes(2) // play transition + stop flush
  })

  it('does not write stale non-zero values from a late onFrame after the stop flush', async () => {
    const h = makeHarness()
    h.setPlaying(true)
    h.transport({ positionMs: 0, bpm: 120, isPlaying: true })
    h.setNow(0)
    h.frame(500, 120)
    await flush()

    h.setPlaying(false)
    h.transport({ positionMs: 500, bpm: 120, isPlaying: false }) // stop flush (writes 0)
    await flush()
    const callsAfterFlush = h.store.applyEnvelopeModulationAtTick.mock.calls.length
    const lastCall = h.store.applyEnvelopeModulationAtTick.mock.calls[callsAfterFlush - 1]
    expect(lastCall[1].trackEvents).toEqual({}) // last write is the flush

    // A trailing onFrame fires after stop -> guarded, no further write.
    h.advance(ENVELOPE_DRIVE_INTERVAL_MS)
    h.frame(600, 120)
    await flush()
    expect(h.store.applyEnvelopeModulationAtTick.mock.calls.length).toBe(callsAfterFlush)
  })

  it('reuses the trigger-event cache for unchanged data and rebuilds when an input changes', async () => {
    const clips = [{ trackId: 7, positionTicks: 0, durationTicks: 480 }]
    let triggerData = { clips, patternBlocks: [], patterns: {} }
    const h = makeHarness({ getTriggerData: () => triggerData })
    h.setPlaying(true)
    h.setNow(0)

    h.frame(100, 120)
    await flush()
    const ev1 = h.store.applyEnvelopeModulationAtTick.mock.calls[0][1].trackEvents

    // New wrapper object but identical inner references (what TimelineView does each render).
    triggerData = { clips, patternBlocks: triggerData.patternBlocks, patterns: triggerData.patterns }
    h.advance(ENVELOPE_DRIVE_INTERVAL_MS)
    h.frame(200, 120)
    await flush()
    const ev2 = h.store.applyEnvelopeModulationAtTick.mock.calls[1][1].trackEvents
    expect(ev2).toBe(ev1) // reused — source identity unchanged

    // A real edit: new clips array reference -> rebuild.
    triggerData = { clips: [...clips], patternBlocks: triggerData.patternBlocks, patterns: triggerData.patterns }
    h.advance(ENVELOPE_DRIVE_INTERVAL_MS)
    h.frame(300, 120)
    await flush()
    const ev3 = h.store.applyEnvelopeModulationAtTick.mock.calls[2][1].trackEvents
    expect(ev3).not.toBe(ev1) // rebuilt
    expect(ev3).toEqual(ev1)  // same shape
  })
})
