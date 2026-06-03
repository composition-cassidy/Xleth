// EVC-R2 (timing repaired by EVC-R2-r1) — control-rate Envelope modulation playback controller.
//
// The Envelope runtime has two distinct responsibilities, deliberately driven by two
// different clocks:
//
//   A. Transport lifecycle (the shared 200 ms transport poller). Used ONLY to detect
//      play/stop transitions, reset the session runtime cache on a transition, and run a
//      single stop flush that drives connected parameters to 0. It does NOT do per-tick
//      parameter drive — at 200 ms granularity a short ADSR would stair-step.
//
//   B. High-rate drive (PlayheadClock.onFrame, ~60 fps interpolated playback position).
//      While playing, this converts the interpolated positionMs to a tick and drives the
//      Envelope -> Parameter edges. It reuses the existing PlayheadClock frame source that
//      TimelineView already runs for auto-scroll (no second rAF loop, no second poller).
//      Drive is throttled to ENVELOPE_DRIVE_INTERVAL_MS (60 Hz) so high-refresh displays
//      do not over-drive, and is guarded by a latest-wins single-in-flight async discipline
//      so a slow IPC write never overlaps itself or lets an older tick land after a newer one.
//
// Like macroAutomationPlayback this is renderer-side / control-rate (NOT sample-accurate,
// NOT on the audio thread). Playback never mutates graphState or effectChains. The store's
// applyEnvelopeModulationAtTick evaluates each Envelope's ADSR from actual reconstructed
// event ticks (not poll ticks) and drives the value through GraphParameterTarget +
// setGraphEffectParameterNormalized.

import { subscribe as subscribeTransport } from '../transportStore.js'
import useEffectChainStore from '../stores/effectChainStore.js'
import { playheadClock } from '../services/PlayheadClock.js'
import { positionMsToTick } from './macroAutomationPlayback.js'
import { computeMsPerTick } from './envelopeModulation.js'

// Fixed 60 Hz drive cadence. onFrame already fires ~60 fps, but high-refresh displays can
// fire faster; this throttle keeps the envelope write rate bounded and deterministic.
export const ENVELOPE_DRIVE_INTERVAL_MS = 1000 / 60

// Pure: builds the parent-track trigger events for a single pattern block by expanding the
// pattern's notes across the block's (possibly looped) window. Mirrors the timeline note
// drawing math (timelineDrawing.js) so triggers line up with what is visually placed:
//   - notes are positioned within the pattern by note.positionTicks (0-based in the pattern)
//   - the block shows the pattern window [offsetTicks, offsetTicks + durationTicks)
//   - the pattern loops across that window unless block.loopEnabled === false (then only
//     loop iteration 0 plays)
//   - a visible note's absolute timeline start = block.positionTicks + (tape - windowStart)
//
// EVC-R2-r2 — held-over reconstruction. A note is emitted when its GATE overlaps the block
// window, not only when its onset (tape) falls inside it. This recovers notes whose onset is
// before windowStart (e.g. a block scrolled by offsetTicks, or a long note from an earlier
// loop iteration) but whose duration sustains into the window — the case the renderer drive
// otherwise skipped, leaving the envelope to read 0 / release early mid-held-note. The note's
// REAL absolute start/end are preserved (startTick can be < blockPos): ADSR elapsed stays
// `queryTick - noteStartTick` and release still begins at the real note end. Same-tick chord
// collapse and overlapping-gate merge happen later in envelopeModulation (buildGateRegions /
// resolveActiveGate); this builder never collapses or de-duplicates notes.
//
// EVC-R2-r3 — centralized slide-note detection. A pattern note is a slide note when its
// `isSlide` flag is exactly true (PianoRollCanvas sets `isSlide: true` together with
// slideCurveCx/slideCurveCy when a note is drawn in slide mode). The Envelope ignores
// slide notes unless the node opts in via includeSlideNotes; this is the single place
// that decides what counts as a slide note, so the rule stays consistent and testable.
// It never mutates or alters slide-note playback elsewhere — it only tags the event.
export function isSlidePatternNote(note) {
  return note != null && typeof note === 'object' && note.isSlide === true
}

// Returns [{ kind: 'note', startTick, endTick }], with `isSlide: true` added only on
// slide-note events (normal notes omit the flag).
export function buildPatternBlockNoteEvents(block, pattern) {
  const events = []
  if (block == null || pattern == null) return events
  const patLen = pattern.lengthTicks
  if (!Number.isFinite(patLen) || patLen <= 0) return events
  const notes = Array.isArray(pattern.notes) ? pattern.notes : []
  if (notes.length === 0) return events

  const blockPos = Number.isFinite(block.positionTicks) ? block.positionTicks : 0
  const blockDur = Number.isFinite(block.durationTicks) ? block.durationTicks : 0
  if (blockDur <= 0) return events
  const offsetTicks = Number.isFinite(block.offsetTicks) ? block.offsetTicks : 0
  const windowStart = offsetTicks
  const windowEnd = offsetTicks + blockDur

  const noteDur = (note) =>
    (Number.isFinite(note?.durationTicks) ? Math.max(0, note.durationTicks) : 0)

  const blockLoopEnabled = block.loopEnabled !== false
  let firstLoop = Math.floor(windowStart / patLen)
  let lastLoop = Math.floor((windowEnd - 1) / patLen)
  if (!blockLoopEnabled) {
    // Loop disabled: only iteration 0 plays; the rest of the block is empty space. Keep the
    // original first/last iteration bounds so disabled-loop semantics are unchanged.
    lastLoop = Math.min(lastLoop, 0)
  } else {
    // Loop enabled: extend the first iteration downward by the longest note so a note that
    // started in an earlier iteration but is still held into the window is reconstructed.
    // The per-note overlap test below does the precise filtering; extra iterations are cheap
    // and produce no spurious events. Negative iterations do not exist (tape is >= 0).
    let maxNoteDur = 0
    for (const note of notes) {
      const d = noteDur(note)
      if (d > maxNoteDur) maxNoteDur = d
    }
    firstLoop = Math.max(0, Math.floor((windowStart - maxNoteDur) / patLen))
  }

  for (let loop = firstLoop; loop <= lastLoop; loop += 1) {
    for (const note of notes) {
      if (note == null) continue
      const notePos = Number.isFinite(note.positionTicks) ? note.positionTicks : 0
      const tape = loop * patLen + notePos
      const dur = noteDur(note)
      // Include the note when its onset is inside the window (original behavior) OR when it
      // started earlier but its gate is still open inside the window (held-over). Half-open
      // intervals: gate [tape, tape + dur) overlaps window [windowStart, windowEnd).
      const startsInWindow = tape >= windowStart && tape < windowEnd
      const heldOverIntoWindow = tape < windowStart && tape + dur > windowStart
      if (!startsInWindow && !heldOverIntoWindow) continue
      const startTick = blockPos + (tape - windowStart)
      // EVC-R2-r3 — tag slide notes so envelopeModulation can drop them unless the Envelope
      // opts in. Only slide notes carry the flag; a normal note keeps its plain shape, so
      // the absence of `isSlide` means "not a slide note" (the filter checks === true).
      const event = { kind: 'note', startTick, endTick: startTick + dur }
      if (isSlidePatternNote(note)) event.isSlide = true
      events.push(event)
    }
  }
  return events
}

// Pure: builds a { [trackKey]: [{ kind, startTick, endTick }] } map of trigger events from
// renderer timeline data. Clip triggers come straight from timeline clips; note triggers
// are expanded from pattern blocks + their patterns. trackKey is String(trackId).
//
// Limitation (documented): note reconstruction depends on renderer-accessible pattern data
// (the patterns map). If a block references a pattern that is not loaded, its notes produce
// no triggers for that tick. Clip triggers are always exact.
export function buildTrackTriggerEvents({ clips = [], patternBlocks = [], patterns = {} } = {}) {
  const map = {}
  const push = (trackId, event) => {
    if (trackId == null) return
    const key = String(trackId)
    if (!map[key]) map[key] = []
    map[key].push(event)
  }

  if (Array.isArray(clips)) {
    for (const clip of clips) {
      if (clip == null) continue
      const startTick = clip.positionTicks
      if (!Number.isFinite(startTick)) continue
      const dur = Number.isFinite(clip.durationTicks) ? Math.max(0, clip.durationTicks) : 0
      push(clip.trackId, { kind: 'clip', startTick, endTick: startTick + dur })
    }
  }

  if (Array.isArray(patternBlocks)) {
    for (const block of patternBlocks) {
      if (block == null) continue
      const pattern = patterns?.[block.patternId]
      const noteEvents = buildPatternBlockNoteEvents(block, pattern)
      for (const event of noteEvents) push(block.trackId, event)
    }
  }

  return map
}

// Starts the controller. Dependencies are injectable for testing. Returns an unsubscribe
// function that tears down BOTH the transport-lifecycle subscription and the onFrame drive.
//
// `getTriggerData` returns { clips, patternBlocks, patterns } from the renderer (TimelineView
// wires this to its live timeline state). The returned object's *identity* is unstable (it is
// rebuilt every render), but its inner clips/patternBlocks/patterns references are stable
// between edits, so the trigger-event cache keys on those three references — it reuses the
// built event map while the source data is unchanged and rebuilds when any reference changes
// (an edit, a project load, or a track change). This keeps 60 Hz drive cheap on dense projects
// without fragile deep versioning.
export function startEnvelopePlayback(deps = {}) {
  const subscribe = deps.subscribe ?? subscribeTransport
  const onFrame = deps.onFrame ?? ((cb) => playheadClock.onFrame(cb))
  const getStore = deps.getStore ?? (() => useEffectChainStore.getState())
  const getTriggerData = deps.getTriggerData ?? (() => ({}))
  const getIsPlaying = deps.getIsPlaying ?? (() => playheadClock.isPlaying)
  const now = deps.now ?? (() =>
    (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()))
  const options = deps.options ?? {}
  const warn = options.warn ?? console.warn

  let lastIsPlaying = null

  // ── Memoized trigger events (identity-keyed cache) ────────────────────────────
  let triggerCache = { clips: null, patternBlocks: null, patterns: null, events: null, valid: false }
  const invalidateTriggerCache = () => { triggerCache.valid = false }
  const getTrackEvents = () => {
    const data = getTriggerData() || {}
    const clips = data.clips
    const patternBlocks = data.patternBlocks
    const patterns = data.patterns
    if (
      triggerCache.valid &&
      triggerCache.clips === clips &&
      triggerCache.patternBlocks === patternBlocks &&
      triggerCache.patterns === patterns
    ) {
      return triggerCache.events
    }
    const events = buildTrackTriggerEvents(data)
    triggerCache = { clips, patternBlocks, patterns, events, valid: true }
    return events
  }

  // ── Latest-wins single-in-flight drive state ──────────────────────────────────
  let inFlight = false           // a drive pass is awaiting its IPC writes
  let latest = null              // newest { tick, msPerTick, bpm } not yet driven
  let lastDriveTime = -Infinity  // last accepted frame time (throttle anchor)
  let stopFlush = null           // a transport snapshot whose stop flush is deferred behind an in-flight pass

  const driveStopFlush = (transport) => {
    const store = getStore()
    if (!store) return
    store.resetEnvelopeModulationRuntime?.()
    invalidateTriggerCache()
    const tick = positionMsToTick(transport.positionMs, transport.bpm)
    const msPerTick = computeMsPerTick(transport.bpm)
    // One no-gate flush pass drives every connected parameter to 0. Invoked synchronously so
    // the call is observable immediately; its promise is guarded against unhandled rejection.
    const p = store.applyEnvelopeModulationAtTick?.(
      tick, { ...options, trackEvents: {}, msPerTick, bpm: transport.bpm })
    if (p && typeof p.catch === 'function') p.catch(() => {})
  }

  const pump = () => {
    if (inFlight || latest == null) return
    if (!getIsPlaying()) { latest = null; return }
    const store = getStore()
    const drive = store?.applyEnvelopeModulationAtTick
    if (!drive) { latest = null; return }

    const frame = latest
    latest = null
    inFlight = true

    let result
    try {
      result = drive(frame.tick, {
        ...options,
        trackEvents: getTrackEvents(),
        msPerTick: frame.msPerTick,
        bpm: frame.bpm,
      })
    } catch (e) {
      // Synchronous throw — should not happen (the store action never throws), but stay safe.
      inFlight = false
      warn?.('[FXG] envelope drive pass failed', e?.message ?? e)
      return
    }

    Promise.resolve(result)
      .catch((e) => { warn?.('[FXG] envelope drive pass failed', e?.message ?? e) })
      .finally(() => {
        inFlight = false
        if (stopFlush) {
          // A stop arrived mid-flight. The in-flight (non-zero) write has now completed, so the
          // flush to 0 lands last — it is the final write on stop, as required.
          const t = stopFlush
          stopFlush = null
          driveStopFlush(t)
          return
        }
        // Latest-wins: if a newer frame arrived while we were in flight and we are still
        // playing, drive the newest one now. Stale intermediate ticks are never replayed.
        if (latest != null && getIsPlaying()) pump()
      })
  }

  // ── B. High-rate drive path (PlayheadClock.onFrame) ───────────────────────────
  const handleFrame = (positionMs, bpm) => {
    if (!getIsPlaying()) return
    const t = now()
    if (t - lastDriveTime < ENVELOPE_DRIVE_INTERVAL_MS) return // throttle to 60 Hz
    lastDriveTime = t
    latest = {
      tick: positionMsToTick(positionMs, bpm),
      msPerTick: computeMsPerTick(bpm),
      bpm,
    }
    pump()
  }

  // ── A. Transport lifecycle path (200 ms poller) ───────────────────────────────
  const handleTransport = (transport) => {
    if (!transport) return
    const store = getStore()
    if (!store) return

    if (transport.isPlaying === lastIsPlaying) return // lifecycle only — no per-tick drive here
    lastIsPlaying = transport.isPlaying

    if (transport.isPlaying) {
      // Play transition: reset the session cache and drive-runtime so the next onFrame
      // re-evaluates from the current position. Allow an immediate first drive.
      store.resetEnvelopeModulationRuntime?.()
      invalidateTriggerCache()
      latest = null
      lastDriveTime = -Infinity
      return
    }

    // Stop transition. Drop any pending frame so no stale non-zero value is driven, then flush
    // to 0 exactly once. If a drive is still in flight, defer the flush until it resolves so the
    // 0 write is guaranteed to land last.
    latest = null
    if (inFlight) {
      stopFlush = transport
    } else {
      driveStopFlush(transport)
    }
  }

  const unsubscribeTransport = subscribe(handleTransport)
  const unsubscribeFrame = onFrame(handleFrame)

  return () => {
    if (typeof unsubscribeTransport === 'function') unsubscribeTransport()
    if (typeof unsubscribeFrame === 'function') unsubscribeFrame()
  }
}
