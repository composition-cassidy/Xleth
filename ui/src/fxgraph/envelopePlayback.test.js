import { describe, expect, it, vi } from 'vitest'
import {
  ENVELOPE_DRIVE_INTERVAL_MS,
  buildPatternBlockNoteEvents,
  buildTrackTriggerEvents,
  startEnvelopePlayback,
} from './envelopePlayback.js'
import { positionMsToTick } from './macroAutomationPlayback.js'
import { evaluateEnvelopeOutput, normalizeEnvelopeRuntimeSettings } from './envelopeModulation.js'

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

describe('buildPatternBlockNoteEvents — EVC-R2-r2 held-over reconstruction', () => {
  // Block scrolled by offsetTicks=1500: its window is pattern-tape [1500, 2500). blockPos is
  // large enough that held-over notes still map to non-negative absolute ticks.
  const block = { positionTicks: 10000, durationTicks: 1000, offsetTicks: 1500, loopEnabled: true }

  it('includes a note that starts before the window but is held inside it, preserving real start/end', () => {
    // Single pattern iteration (huge patLen). Note gate (tape) [1000, 2000) overlaps window
    // [1500, 2500) even though its onset (1000) is before windowStart (1500).
    const pattern = { lengthTicks: 100000, notes: [{ positionTicks: 1000, durationTicks: 1000 }] }
    const events = buildPatternBlockNoteEvents(block, pattern)
    // Real absolute start = blockPos + (tape - windowStart) = 10000 + (1000 - 1500) = 9500.
    // Real absolute end preserved at 9500 + 1000 = 10500 (NOT clamped to the window edge).
    expect(events).toEqual([{ kind: 'note', startTick: 9500, endTick: 10500 }])
  })

  it('excludes a note whose gate ends before the window', () => {
    const pattern = { lengthTicks: 100000, notes: [{ positionTicks: 100, durationTicks: 200 }] }
    // gate [100, 300) does not reach windowStart 1500.
    expect(buildPatternBlockNoteEvents(block, pattern)).toEqual([])
  })

  it('excludes a note whose onset is at/after the window end', () => {
    const pattern = { lengthTicks: 100000, notes: [{ positionTicks: 3000, durationTicks: 100 }] }
    // onset 3000 >= windowEnd 2500.
    expect(buildPatternBlockNoteEvents(block, pattern)).toEqual([])
  })

  it('reconstructs a long note held over from an earlier loop iteration', () => {
    // patLen 1000; note at tape position 900 with dur 1000 -> iteration 0 gate [900, 1900)
    // overlaps the window [1500, 2500) but its onset (900) is in the PREVIOUS iteration window.
    const pattern = { lengthTicks: 1000, notes: [{ positionTicks: 900, durationTicks: 1000 }] }
    const events = buildPatternBlockNoteEvents(block, pattern)
    // Iteration 0 (held-over, onset 900): start = 10000 + (900 - 1500) = 9400.
    // Iteration 1 (onset 1900, starts in window): start = 10000 + (1900 - 1500) = 10400.
    expect(events).toContainEqual({ kind: 'note', startTick: 9400, endTick: 10400 })
    expect(events).toContainEqual({ kind: 'note', startTick: 10400, endTick: 11400 })
  })

  it('does not collapse same-tick notes in the builder (collapse is left to the gate resolver)', () => {
    // A two-note same-tick chord stays two events here; envelopeModulation collapses them into
    // one gate at evaluation time (covered by envelopeModulation.test.js).
    const pattern = {
      lengthTicks: 100000,
      notes: [
        { positionTicks: 1000, durationTicks: 1000 },
        { positionTicks: 1000, durationTicks: 1000 },
      ],
    }
    const events = buildPatternBlockNoteEvents(block, pattern)
    expect(events).toEqual([
      { kind: 'note', startTick: 9500, endTick: 10500 },
      { kind: 'note', startTick: 9500, endTick: 10500 },
    ])
  })

  it('does not regress offset-0 blocks (every note onset is already in-window)', () => {
    const pattern = { lengthTicks: 100, notes: [{ positionTicks: 0, durationTicks: 20 }, { positionTicks: 50, durationTicks: 10 }] }
    const flat = { positionTicks: 0, durationTicks: 100, offsetTicks: 0, loopEnabled: true }
    expect(buildPatternBlockNoteEvents(flat, pattern)).toEqual([
      { kind: 'note', startTick: 0, endTick: 20 },
      { kind: 'note', startTick: 50, endTick: 60 },
    ])
  })
})

describe('held-over reconstruction → envelope evaluation (integration)', () => {
  // Proves the builder's real start/end flow into ADSR evaluation: a held-over note is evaluated
  // with elapsed measured from its REAL start, not from the block/window edge.
  it('evaluates a held-over note from its real start tick (elapsed = query - realStart)', () => {
    const block = { positionTicks: 10000, durationTicks: 1000, offsetTicks: 1500, loopEnabled: true }
    const pattern = { lengthTicks: 100000, notes: [{ positionTicks: 1000, durationTicks: 1000 }] }
    const events = buildPatternBlockNoteEvents(block, pattern) // [{ start: 9500, end: 10500 }]

    // attack 1000 ticks (msPerTick = 1), linear 0 -> 1; sustain 1, no decay/release; amount 1.
    const settings = normalizeEnvelopeRuntimeSettings(
      { attackMs: 1000, holdMs: 0, decayMs: 0, sustain: 1, releaseMs: 0, amount: 1,
        triggerSource: { kind: 'parentTrack', events: 'notes' }, retriggerMode: 'restart' },
      { msPerTick: 1 },
    )

    // Query mid-attack at tick 10000: elapsed from real start 9500 is 500 -> 0.5.
    // (If elapsed were measured from the window edge 10000, this would wrongly read 0.)
    const out = evaluateEnvelopeOutput(settings, events, 10000)
    expect(out.value).toBeCloseTo(0.5, 5)
  })

  it('keeps the gate open across overlapping held-over notes until the last real end', () => {
    // Two block notes whose gates overlap: [9500, 10500) and [10000, 11500) -> merged region
    // [9500, 11500). With a long release, a query inside the merged region stays at sustain.
    const block = { positionTicks: 10000, durationTicks: 2000, offsetTicks: 1500, loopEnabled: true }
    const pattern = {
      lengthTicks: 100000,
      notes: [
        { positionTicks: 1000, durationTicks: 1000 }, // gate tape [1000, 2000) -> abs [9500, 10500)
        { positionTicks: 1500, durationTicks: 1500 }, // gate tape [1500, 3000) -> abs [10000, 11500)
      ],
    }
    const events = buildPatternBlockNoteEvents(block, pattern)
    const settings = normalizeEnvelopeRuntimeSettings(
      { attackMs: 0, holdMs: 0, decayMs: 0, sustain: 1, releaseMs: 1000, amount: 1,
        triggerSource: { kind: 'parentTrack', events: 'notes' }, retriggerMode: 'legato' },
      { msPerTick: 1 },
    )
    // At tick 11000 (past the first note's end 10500 but inside the merged region end 11500)
    // the gate is still held -> sustain 1, not releasing.
    expect(evaluateEnvelopeOutput(settings, events, 11000).value).toBeCloseTo(1, 5)
  })

  it('honors the trigger source over built note + clip events', () => {
    // One track with a clip gate [0, 5000) and a pattern note gate [1000, 6000).
    const clips = [{ trackId: 7, positionTicks: 0, durationTicks: 5000 }]
    const patternBlocks = [{ trackId: 7, patternId: 'p1', positionTicks: 1000, durationTicks: 5000, offsetTicks: 0, loopEnabled: false }]
    const patterns = { p1: { lengthTicks: 100000, notes: [{ positionTicks: 0, durationTicks: 5000 }] } }
    const events = buildTrackTriggerEvents({ clips, patternBlocks, patterns })['7']

    const make = (mode) => normalizeEnvelopeRuntimeSettings(
      { attackMs: 0, holdMs: 0, decayMs: 0, sustain: 1, releaseMs: 0, amount: 1,
        triggerSource: { kind: 'parentTrack', events: mode }, retriggerMode: 'restart' },
      { msPerTick: 1 },
    )

    // At tick 5500: clip gate has ended (>=5000), note gate still open (<6000).
    expect(evaluateEnvelopeOutput(make('notes'), events, 5500).value).toBeCloseTo(1, 5) // note seen
    expect(evaluateEnvelopeOutput(make('clips'), events, 5500).value).toBeCloseTo(0, 5) // clip ended, note ignored
    expect(evaluateEnvelopeOutput(make('notesAndClips'), events, 5500).value).toBeCloseTo(1, 5) // note seen
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
