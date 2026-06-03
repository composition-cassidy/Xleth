import { describe, expect, it } from 'vitest'
import {
  ENVELOPE_PHASE,
  computeMsPerTick,
  normalizeEnvelopeRuntimeSettings,
  evaluateEnvelopeAdsrAtTime,
  collectGateIntervals,
  resolveActiveGate,
  evaluateEnvelopeOutput,
  createEnvelopeRuntimeState,
  updateEnvelopeRuntimeState,
  evaluateEnvelopeLevel,
} from './envelopeModulation.js'

// msPerTick: 1 means ms fields map 1:1 to ticks, so AHDSR durations are easy to reason
// about (attackMs 10 -> attackTicks 10). The playback layer passes a live bpm-derived
// msPerTick; here we pin it for deterministic assertions.
function settings(overrides = {}) {
  // Accept a flat `triggerEvents` shorthand and map it onto the real triggerSource shape.
  const { triggerEvents, ...rest } = overrides
  const data = triggerEvents ? { ...rest, triggerSource: { events: triggerEvents } } : rest
  return normalizeEnvelopeRuntimeSettings(data, { msPerTick: 1 })
}

const note = (startTick, endTick) => ({ kind: 'note', startTick, endTick })
const clip = (startTick, endTick) => ({ kind: 'clip', startTick, endTick })

describe('computeMsPerTick', () => {
  it('derives ms-per-tick from tempo at PPQ 960', () => {
    // 120 bpm -> 500ms per beat -> 500/960 ms per tick.
    expect(computeMsPerTick(120)).toBeCloseTo(500 / 960)
    expect(computeMsPerTick(0)).toBeNull()
    expect(computeMsPerTick(NaN)).toBeNull()
  })
})

describe('normalizeEnvelopeRuntimeSettings', () => {
  it('converts ms stages to ticks and repairs invalid input', () => {
    const s = normalizeEnvelopeRuntimeSettings(
      { attackMs: 10, holdMs: 5, decayMs: 120, sustain: 0.7, releaseMs: 200, amount: 0.5 },
      { msPerTick: 1 },
    )
    expect(s.attackTicks).toBe(10)
    expect(s.holdTicks).toBe(5)
    expect(s.decayTicks).toBe(120)
    expect(s.releaseTicks).toBe(200)
    expect(s.sustain).toBe(0.7)
    expect(s.amount).toBe(0.5)
    expect(s.retriggerMode).toBe('restart')
    expect(s.triggerEvents).toBe('notesAndClips')
  })

  it('repairs negative / non-finite stages and amount to safe defaults', () => {
    const s = normalizeEnvelopeRuntimeSettings(
      { attackMs: -5, decayMs: Number.NaN, sustain: 5, amount: -1 },
      { msPerTick: 1 },
    )
    // attackMs default 10, decayMs default 120 (graphState normalization defaults).
    expect(s.attackTicks).toBe(10)
    expect(s.decayTicks).toBe(120)
    expect(s.sustain).toBeLessThanOrEqual(1)
    expect(s.sustain).toBeGreaterThanOrEqual(0)
    expect(s.amount).toBe(0) // clamped from -1
  })
})

describe('evaluateEnvelopeAdsrAtTime', () => {
  const s = settings({ attackMs: 10, holdMs: 0, decayMs: 120, sustain: 0.7, releaseMs: 200 })

  it('outputs 0 with no trigger / before the gate', () => {
    expect(evaluateEnvelopeAdsrAtTime(s, null, null, 50)).toBe(0)
    expect(evaluateEnvelopeAdsrAtTime(s, 100, null, 50)).toBe(0)
  })

  it('attack rises 0 -> 1', () => {
    expect(evaluateEnvelopeAdsrAtTime(s, 0, null, 0)).toBe(0)
    expect(evaluateEnvelopeAdsrAtTime(s, 0, null, 5)).toBeCloseTo(0.5)
    expect(evaluateEnvelopeAdsrAtTime(s, 0, null, 10)).toBeCloseTo(1)
  })

  it('hold stays at 1', () => {
    const sh = settings({ attackMs: 10, holdMs: 20, decayMs: 120, sustain: 0.7 })
    expect(evaluateEnvelopeAdsrAtTime(sh, 0, null, 10)).toBeCloseTo(1)
    expect(evaluateEnvelopeAdsrAtTime(sh, 0, null, 25)).toBeCloseTo(1)
    expect(evaluateEnvelopeAdsrAtTime(sh, 0, null, 30)).toBeCloseTo(1)
  })

  it('decay falls 1 -> sustain', () => {
    expect(evaluateEnvelopeAdsrAtTime(s, 0, null, 70)).toBeCloseTo(0.85) // mid decay
    expect(evaluateEnvelopeAdsrAtTime(s, 0, null, 130)).toBeCloseTo(0.7) // decay end
  })

  it('sustain holds while gate active', () => {
    expect(evaluateEnvelopeAdsrAtTime(s, 0, null, 2000)).toBeCloseTo(0.7)
    expect(evaluateEnvelopeAdsrAtTime(s, 0, null, 5000)).toBeCloseTo(0.7)
  })

  it('release starts from the ACTUAL gate-end level for a short gate', () => {
    // Gate [0,5): closes mid-attack at level 0.5, not at sustain.
    expect(evaluateEnvelopeAdsrAtTime(s, 0, 5, 5)).toBeCloseTo(0.5)
    expect(evaluateEnvelopeAdsrAtTime(s, 0, 5, 105)).toBeCloseTo(0.25) // halfway through release
  })

  it('release reaches 0 / off', () => {
    expect(evaluateEnvelopeAdsrAtTime(s, 0, 5, 205)).toBe(0)
  })

  it('zero attack / zero release are safe', () => {
    const z = settings({ attackMs: 0, holdMs: 0, decayMs: 120, sustain: 0.7, releaseMs: 0 })
    expect(evaluateEnvelopeAdsrAtTime(z, 0, 100, 0)).toBeCloseTo(1) // instant attack
    expect(evaluateEnvelopeAdsrAtTime(z, 0, 100, 100)).toBe(0) // instant release
  })
})

describe('collectGateIntervals — trigger source filtering', () => {
  const events = [note(0, 100), clip(200, 300)]

  it('notes-only ignores clips', () => {
    expect(collectGateIntervals(events, 'notes')).toEqual([{ startTick: 0, endTick: 100 }])
  })

  it('clips-only ignores notes', () => {
    expect(collectGateIntervals(events, 'clips')).toEqual([{ startTick: 200, endTick: 300 }])
  })

  it('notesAndClips uses both', () => {
    expect(collectGateIntervals(events, 'notesAndClips')).toEqual([
      { startTick: 0, endTick: 100 },
      { startTick: 200, endTick: 300 },
    ])
  })

  it('drops invalid events and clamps missing ends to zero-length gates', () => {
    const messy = [{ kind: 'note', startTick: -1 }, { kind: 'note', startTick: 10 }, null, { kind: 'foo', startTick: 5 }]
    expect(collectGateIntervals(messy, 'notes')).toEqual([{ startTick: 10, endTick: 10 }])
  })
})

describe('resolveActiveGate — gate regions, chords, retrigger modes', () => {
  it('returns null before any gate begins', () => {
    expect(resolveActiveGate([{ startTick: 100, endTick: 200 }], 50, 'restart')).toBeNull()
  })

  it('same-tick chord collapses into one trigger', () => {
    // Two notes at the same start collapse: one region, one start tick.
    const intervals = [{ startTick: 0, endTick: 100 }, { startTick: 0, endTick: 100 }]
    expect(resolveActiveGate(intervals, 50, 'restart')).toEqual({ gateStartTick: 0, gateEndTick: 100 })
  })

  it('overlapping notes keep the gate open until the last one ends', () => {
    const intervals = [{ startTick: 0, endTick: 100 }, { startTick: 50, endTick: 150 }]
    // Still held at 120 (< 150): governing region end is 150.
    const gate = resolveActiveGate(intervals, 120, 'legato')
    expect(gate).toEqual({ gateStartTick: 0, gateEndTick: 150 })
  })

  it('restart re-attacks from the latest trigger start within the region', () => {
    const intervals = [{ startTick: 0, endTick: 100 }, { startTick: 50, endTick: 150 }]
    expect(resolveActiveGate(intervals, 60, 'restart')).toEqual({ gateStartTick: 50, gateEndTick: 150 })
  })

  it('legato does not restart while the gate is already active', () => {
    const intervals = [{ startTick: 0, endTick: 100 }, { startTick: 50, endTick: 150 }]
    expect(resolveActiveGate(intervals, 60, 'legato')).toEqual({ gateStartTick: 0, gateEndTick: 150 })
  })
})

describe('evaluateEnvelopeOutput — one value per envelope node', () => {
  it('amount scales the output once', () => {
    const full = settings({ attackMs: 10, decayMs: 120, sustain: 0.7, releaseMs: 200, amount: 1 })
    const half = settings({ attackMs: 10, decayMs: 120, sustain: 0.7, releaseMs: 200, amount: 0.5 })
    const events = [note(0, 5000)]
    expect(evaluateEnvelopeOutput(full, events, 2000).value).toBeCloseTo(0.7)
    expect(evaluateEnvelopeOutput(half, events, 2000).value).toBeCloseTo(0.35)
  })

  it('outputs 0 before the trigger and off after release', () => {
    const s = settings({ attackMs: 10, decayMs: 120, sustain: 0.7, releaseMs: 200 })
    const events = [note(100, 105)]
    expect(evaluateEnvelopeOutput(s, events, 50).value).toBe(0)
    expect(evaluateEnvelopeOutput(s, events, 50).phase).toBe(ENVELOPE_PHASE.OFF)
    // Released by 100+5+200 = 305.
    expect(evaluateEnvelopeOutput(s, events, 305).value).toBe(0)
  })

  it('restart vs legato produce different values mid-overlap', () => {
    // Long attack so the phase is still rising at the query tick.
    const restart = settings({ attackMs: 100, decayMs: 0, sustain: 1, retriggerMode: 'restart' })
    const legato = settings({ attackMs: 100, decayMs: 0, sustain: 1, retriggerMode: 'legato' })
    const events = [note(0, 100), note(50, 150)]
    expect(evaluateEnvelopeOutput(restart, events, 60).value).toBeCloseTo(0.1) // attack from 50
    expect(evaluateEnvelopeOutput(legato, events, 60).value).toBeCloseTo(0.6) // attack from 0
  })

  it('overlapping clip gates stay open until the last clip ends', () => {
    const s = settings({ attackMs: 0, decayMs: 0, sustain: 1, releaseMs: 100, triggerEvents: 'clips' })
    const events = [clip(0, 100), clip(50, 150)]
    expect(evaluateEnvelopeOutput(s, events, 120).value).toBeCloseTo(1) // still held (< 150)
    expect(evaluateEnvelopeOutput(s, events, 200).value).toBeCloseTo(0.5) // 50 ticks into release
  })

  it('notes-only ignores clip triggers (and vice versa)', () => {
    const notesOnly = settings({ attackMs: 0, decayMs: 0, sustain: 1, triggerEvents: 'notes' })
    const clipsOnly = settings({ attackMs: 0, decayMs: 0, sustain: 1, triggerEvents: 'clips' })
    const both = settings({ attackMs: 0, decayMs: 0, sustain: 1, triggerEvents: 'notesAndClips' })

    expect(evaluateEnvelopeOutput(notesOnly, [clip(0, 100)], 50).value).toBe(0)
    expect(evaluateEnvelopeOutput(notesOnly, [note(0, 100)], 50).value).toBeCloseTo(1)
    expect(evaluateEnvelopeOutput(clipsOnly, [note(0, 100)], 50).value).toBe(0)
    expect(evaluateEnvelopeOutput(clipsOnly, [clip(0, 100)], 50).value).toBeCloseTo(1)
    expect(evaluateEnvelopeOutput(both, [note(0, 100)], 50).value).toBeCloseTo(1)
    expect(evaluateEnvelopeOutput(both, [clip(0, 100)], 50).value).toBeCloseTo(1)
  })
})

describe('runtime state helpers', () => {
  it('createEnvelopeRuntimeState starts off at 0', () => {
    const state = createEnvelopeRuntimeState()
    expect(state.phase).toBe(ENVELOPE_PHASE.OFF)
    expect(state.lastOutputValue).toBe(0)
    expect(state.gateStartTick).toBeNull()
  })

  it('updateEnvelopeRuntimeState reconstructs deterministically (seek-safe)', () => {
    const s = settings({ attackMs: 10, decayMs: 120, sustain: 0.7, releaseMs: 200 })
    const events = [note(0, 5000)]
    // Seek straight to tick 2000 with a fresh state -> still resolves the sustain level.
    const seeked = updateEnvelopeRuntimeState(createEnvelopeRuntimeState(), events, 2000, s)
    expect(seeked.gateStartTick).toBe(0)
    expect(seeked.lastOutputValue).toBeCloseTo(0.7)
    expect(seeked.phase).toBe(ENVELOPE_PHASE.SUSTAIN)
    // evaluateEnvelopeLevel agrees with the stored gate.
    expect(evaluateEnvelopeLevel(s, seeked, 2000)).toBeCloseTo(0.7)
  })
})
