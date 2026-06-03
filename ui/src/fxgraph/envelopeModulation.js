// EVC-R2 — pure, renderer-side, control-rate Envelope ADSR evaluation + trigger/gate
// reconstruction for Envelope-to-parameter modulation.
//
// Correct model (see docs/dev/fxgraph-envelope-controller-architecture-audit.md):
//   parent-track note/clip triggers
//     -> a single normalized 0..1 ADSR control value per Envelope node
//     -> existing Envelope-to-Parameter edges apply per-link mapping (FXG.4-e/f/g)
//     -> setGraphEffectParameterNormalized writes the stock/VST parameter (FXG.4-a)
//
// This module is PURE. It never reads transport state, the store, effectChains, audio
// topology, engine node ids, or plugin parameters. It only turns an Envelope node's
// (normalized) AHDSR definition plus a flat list of parent-track trigger events into a
// single deterministic 0..1 value at a query tick.
//
// One Envelope node => one output value. There are NO per-voice envelopes: overlapping
// notes/clips are collapsed into gate regions, never summed/averaged/maxed. This is the
// corrected parameter-modulation model that replaced the retired per-voice voiceGain
// branch (EVC-R0/EVC-R1); it must never reintroduce per-voice outputs.
//
// Determinism / seeking: the active gate is reconstructed from the full event list at
// each query tick, so evaluation is stateless w.r.t. prior ticks. Seeking into an active
// note/clip therefore evaluates the correct ADSR phase from the gate's start. The
// optional runtime-state helpers below are a thin convenience for the store's redundant-
// write suppression; they hold no information that changes the evaluated value.
//
// Tension is intentionally ignored at runtime in this phase: the renderer node preview
// (buildEnvelopePreviewPoints in EnvelopeEditor.tsx) also draws straight A/H/D/S/R
// segments and explicitly does not model tension, so runtime matches the preview. MSEG /
// drawable envelopes and audio-rate/sample-accurate modulation are out of scope.

import { normalizeEnvelopeNodeData } from './graphState.js'
import { PPQ } from '../constants/timeline.js'

export const ENVELOPE_PHASE = Object.freeze({
  OFF: 'off',
  ATTACK: 'attack',
  HOLD: 'hold',
  DECAY: 'decay',
  SUSTAIN: 'sustain',
  RELEASE: 'release',
})

// Trigger-source filter values mirror graphState's ENVELOPE_TRIGGER_EVENTS.
const TRIGGER_EVENTS_NOTES = 'notes'
const TRIGGER_EVENTS_CLIPS = 'clips'
const TRIGGER_EVENTS_BOTH = 'notesAndClips'

// Default tempo used only when the caller supplies neither msPerTick nor bpm. The
// playback layer always passes a live bpm, so this only affects standalone/unit use.
const DEFAULT_BPM = 120

function clamp01(value, fallback = 0) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

function toNonNegativeTicks(value) {
  if (!Number.isFinite(value) || value < 0) return 0
  return value
}

// Converts a tempo to milliseconds-per-tick. Returns null on invalid tempo so callers
// can fall back to the default.
export function computeMsPerTick(bpm, ppq = PPQ) {
  if (!Number.isFinite(bpm) || bpm <= 0) return null
  if (!Number.isFinite(ppq) || ppq <= 0) return null
  return (60000 / bpm) / ppq
}

// Normalizes an Envelope node's persisted data into the runtime settings used by ADSR
// evaluation. AHDSR stage durations are converted from milliseconds to ticks using the
// context's msPerTick (or bpm). Negative/non-finite values are repaired via the
// graphState envelope normalization defaults; amount/sustain stay in 0..1.
//
// context: { msPerTick?, bpm?, ppq? }
export function normalizeEnvelopeRuntimeSettings(envelopeNodeData, context = {}) {
  const data = normalizeEnvelopeNodeData(envelopeNodeData)

  let msPerTick = Number.isFinite(context.msPerTick) && context.msPerTick > 0
    ? context.msPerTick
    : computeMsPerTick(context.bpm, context.ppq ?? PPQ)
  if (!Number.isFinite(msPerTick) || msPerTick <= 0) {
    msPerTick = computeMsPerTick(DEFAULT_BPM, context.ppq ?? PPQ)
  }

  const msToTicks = (ms) => toNonNegativeTicks(ms / msPerTick)

  return {
    attackTicks: msToTicks(data.attackMs),
    holdTicks: msToTicks(data.holdMs),
    decayTicks: msToTicks(data.decayMs),
    releaseTicks: msToTicks(data.releaseMs),
    sustain: clamp01(data.sustain, 0),
    amount: clamp01(data.amount, 0),
    retriggerMode: data.retriggerMode,
    triggerEvents: data.triggerSource.events,
    msPerTick,
  }
}

// The raw (pre-amount) ADSR level for a number of ticks the gate has been held, using
// straight-line A/H/D/S segments. heldTicks <= 0 yields the level at the gate's very
// start (0 unless attack is instant). Zero-duration stages are safe (no divide-by-zero).
function levelWhileHeld(settings, heldTicks) {
  const { attackTicks, holdTicks, decayTicks, sustain } = settings
  if (heldTicks <= 0) {
    if (attackTicks > 0) return 0
    if (holdTicks > 0 || decayTicks > 0) return 1
    return sustain
  }

  const attackEnd = attackTicks
  const holdEnd = attackEnd + holdTicks
  const decayEnd = holdEnd + decayTicks

  if (heldTicks < attackEnd) return heldTicks / attackTicks // attack 0 -> 1
  if (heldTicks < holdEnd) return 1 // hold plateau
  if (heldTicks < decayEnd) {
    const t = decayTicks > 0 ? (heldTicks - holdEnd) / decayTicks : 1
    return 1 + t * (sustain - 1) // decay 1 -> sustain
  }
  return sustain // sustain plateau
}

// Evaluates the raw (pre-amount) ADSR shape, 0..1, at queryTick given an explicit gate.
//   gateStartTick : tick the (possibly re-triggered) attack begins. null/non-finite => off.
//   gateEndTick   : tick the gate closes and release begins. null => still held.
// Release falls from the ACTUAL level at gate end (not an assumed sustain), so short
// gates release from wherever attack/decay had reached.
export function evaluateEnvelopeAdsrAtTime(settings, gateStartTick, gateEndTick, queryTick) {
  if (gateStartTick == null || !Number.isFinite(gateStartTick)) return 0
  if (!Number.isFinite(queryTick) || queryTick < gateStartTick) return 0

  const heldSpan = gateEndTick == null || !Number.isFinite(gateEndTick)
    ? Infinity
    : Math.max(0, gateEndTick - gateStartTick)
  const sinceStart = queryTick - gateStartTick

  if (sinceStart < heldSpan) {
    return clamp01(levelWhileHeld(settings, sinceStart))
  }

  // Released.
  const releaseStartLevel = clamp01(levelWhileHeld(settings, heldSpan))
  const sinceRelease = sinceStart - heldSpan
  if (settings.releaseTicks <= 0) return 0
  if (sinceRelease >= settings.releaseTicks) return 0
  return clamp01(releaseStartLevel * (1 - sinceRelease / settings.releaseTicks))
}

// Determines the ADSR phase label for a gate window at queryTick (status/UI only).
function resolvePhase(settings, gateStartTick, gateEndTick, queryTick) {
  if (gateStartTick == null || !Number.isFinite(gateStartTick) || queryTick < gateStartTick) {
    return ENVELOPE_PHASE.OFF
  }
  const heldSpan = gateEndTick == null || !Number.isFinite(gateEndTick)
    ? Infinity
    : Math.max(0, gateEndTick - gateStartTick)
  const sinceStart = queryTick - gateStartTick

  if (sinceStart >= heldSpan) {
    const sinceRelease = sinceStart - heldSpan
    if (settings.releaseTicks <= 0 || sinceRelease >= settings.releaseTicks) return ENVELOPE_PHASE.OFF
    return ENVELOPE_PHASE.RELEASE
  }

  const attackEnd = settings.attackTicks
  const holdEnd = attackEnd + settings.holdTicks
  const decayEnd = holdEnd + settings.decayTicks
  if (sinceStart < attackEnd) return ENVELOPE_PHASE.ATTACK
  if (sinceStart < holdEnd) return ENVELOPE_PHASE.HOLD
  if (sinceStart < decayEnd) return ENVELOPE_PHASE.DECAY
  return ENVELOPE_PHASE.SUSTAIN
}

// Filters a flat trigger-event list by the Envelope's trigger source, returning the
// gate intervals [{ startTick, endTick }] it should respond to. An event is
// { kind: 'note' | 'clip', startTick, endTick }; endTick is exclusive. Events with a
// non-finite/negative start are dropped; a missing/short end is treated as a zero-length
// gate (endTick = startTick).
export function collectGateIntervals(triggerEvents, triggerEventsMode) {
  if (!Array.isArray(triggerEvents)) return []
  const wantNotes = triggerEventsMode === TRIGGER_EVENTS_NOTES || triggerEventsMode === TRIGGER_EVENTS_BOTH
  const wantClips = triggerEventsMode === TRIGGER_EVENTS_CLIPS || triggerEventsMode === TRIGGER_EVENTS_BOTH

  const intervals = []
  for (const event of triggerEvents) {
    if (event == null || typeof event !== 'object') continue
    if (event.kind === 'note' && !wantNotes) continue
    if (event.kind === 'clip' && !wantClips) continue
    if (event.kind !== 'note' && event.kind !== 'clip') continue
    const startTick = event.startTick
    if (!Number.isFinite(startTick) || startTick < 0) continue
    const endTick = Number.isFinite(event.endTick) && event.endTick > startTick ? event.endTick : startTick
    intervals.push({ startTick, endTick })
  }
  return intervals
}

// Merges gate intervals into continuous gate regions. Two intervals belong to the same
// region when they overlap (next.start < current.end); an interval that starts exactly
// when another ends (start === end) opens a NEW region (a momentary gate close + reopen).
// Each region records its sorted, de-duplicated start ticks so same-tick chord starts
// collapse into one trigger, and the latest start before the query can be found for
// restart retriggering.
function buildGateRegions(intervals) {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((a, b) => a.startTick - b.startTick)
  const regions = []
  let current = null
  for (const interval of sorted) {
    if (current && interval.startTick < current.end) {
      current.end = Math.max(current.end, interval.endTick)
      if (current.starts[current.starts.length - 1] !== interval.startTick) {
        current.starts.push(interval.startTick)
      }
    } else {
      current = { start: interval.startTick, end: interval.endTick, starts: [interval.startTick] }
      regions.push(current)
    }
  }
  return regions
}

// Resolves the gate window (attack origin + release point) that governs queryTick.
// Returns { gateStartTick, gateEndTick } or null when no gate has begun yet.
//   - The governing region either contains queryTick, or is the most recent region that
//     ended at/before queryTick (its release tail may still be sounding).
//   - gateEndTick = region end (release begins when the last note/clip in the region ends,
//     so overlapping notes/clips keep the gate open until the last one ends).
//   - gateStartTick = region start in 'legato' mode (a new trigger during an active gate
//     does NOT restart); in 'restart' mode it is the latest trigger start at/<= queryTick
//     within the region (a new trigger restarts the attack), or the region's last start
//     once the region has fully ended.
export function resolveActiveGate(intervals, queryTick, retriggerMode = 'restart') {
  const regions = buildGateRegions(intervals)
  if (regions.length === 0) return null

  let governing = null
  for (const region of regions) {
    if (queryTick >= region.start && queryTick < region.end) {
      governing = region
      break
    }
    if (region.end <= queryTick) {
      if (!governing || region.end > governing.end) governing = region
    }
  }
  if (!governing) return null

  let gateStartTick
  if (retriggerMode === 'legato') {
    gateStartTick = governing.start
  } else {
    let latest = governing.starts[0]
    for (const start of governing.starts) {
      if (start <= queryTick && start > latest) latest = start
    }
    gateStartTick = latest
  }

  return { gateStartTick, gateEndTick: governing.end }
}

// High-level pure output used by the store's runtime drive. Given runtime settings, the
// parent-track trigger-event list, and a query tick, returns the single amount-scaled
// 0..1 output plus the resolved gate + phase. One value per Envelope node.
export function evaluateEnvelopeOutput(settings, triggerEvents, queryTick) {
  const intervals = collectGateIntervals(triggerEvents, settings.triggerEvents)
  const gate = resolveActiveGate(intervals, queryTick, settings.retriggerMode)
  const gateStartTick = gate ? gate.gateStartTick : null
  const gateEndTick = gate ? gate.gateEndTick : null
  const raw = evaluateEnvelopeAdsrAtTime(settings, gateStartTick, gateEndTick, queryTick)
  const value = clamp01(raw * settings.amount)
  const phase = gate ? resolvePhase(settings, gateStartTick, gateEndTick, queryTick) : ENVELOPE_PHASE.OFF
  return { value, phase, gateStartTick, gateEndTick }
}

// ---------------------------------------------------------------------------
// Session-only runtime state (suggested EVC-R2 helpers).
//
// The evaluated value is fully reconstructed from the event list each tick, so this
// state holds nothing that changes the output — it exists only so a poller can carry the
// last resolved gate/value forward (e.g. for redundant-write suppression and UI status).
// It must never be persisted and must be reset on project load, graphState hydration,
// and transport stop (the store owns those resets, mirroring macroAutomationLastValues).
// ---------------------------------------------------------------------------

export function createEnvelopeRuntimeState() {
  return {
    phase: ENVELOPE_PHASE.OFF,
    gateStartTick: null,
    gateEndTick: null,
    lastOutputValue: 0,
    lastProcessedTick: null,
  }
}

// Recomputes the runtime state for an Envelope from the full trigger-event list at
// queryTick (deterministic; safe to call after a seek). Returns a NEW state object.
export function updateEnvelopeRuntimeState(runtimeState, triggerEvents, queryTick, settings) {
  const out = evaluateEnvelopeOutput(settings, triggerEvents, queryTick)
  return {
    phase: out.phase,
    gateStartTick: out.gateStartTick,
    gateEndTick: out.gateEndTick,
    lastOutputValue: out.value,
    lastProcessedTick: queryTick,
  }
}

// Reads the amount-scaled 0..1 output implied by a runtime state's resolved gate at
// queryTick. Pairs with updateEnvelopeRuntimeState for callers that hold state.
export function evaluateEnvelopeLevel(settings, runtimeState, queryTick) {
  if (!runtimeState) return 0
  const raw = evaluateEnvelopeAdsrAtTime(
    settings,
    runtimeState.gateStartTick ?? null,
    runtimeState.gateEndTick ?? null,
    queryTick,
  )
  return clamp01(raw * settings.amount)
}
