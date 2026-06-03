// EVC-R2 — control-rate Envelope modulation playback controller.
//
// Subscribes to the shared transport poller and, on each tick WHILE PLAYING, reconstructs
// each graph-mode track's parent-track trigger events (clips + pattern-block notes) and
// asks the effectChainStore to evaluate every Envelope node's ADSR at the current tick and
// drive the resulting normalized value through the existing Envelope -> Parameter edge path
// (GraphParameterTarget + setGraphEffectParameterNormalized). Like macroAutomationPlayback,
// this is renderer-side / control-rate (NOT sample-accurate, NOT on the audio thread):
// graph parameter drive is already a renderer-side concern, so envelope runtime lives in
// the same place and reuses the same transport subscription and position->tick conversion.
//
// Playback never mutates graphState or effectChains. Triggered envelopes only drive while
// playing; on transport stop the controller resets the session runtime cache and performs
// one flush pass with no active gates, which drives connected parameters to 0 so a held-
// open envelope never leaves a parameter stuck.

import { subscribe as subscribeTransport } from '../transportStore.js'
import useEffectChainStore from '../stores/effectChainStore.js'
import { positionMsToTick } from './macroAutomationPlayback.js'
import { computeMsPerTick } from './envelopeModulation.js'

// Pure: builds the parent-track trigger events for a single pattern block by expanding the
// pattern's notes across the block's (possibly looped) window. Mirrors the timeline note
// drawing math (timelineDrawing.js) so triggers line up with what is visually placed:
//   - notes are positioned within the pattern by note.positionTicks (0-based in the pattern)
//   - the block shows the pattern window [offsetTicks, offsetTicks + durationTicks)
//   - the pattern loops across that window unless block.loopEnabled === false (then only
//     loop iteration 0 plays)
//   - a visible note's absolute timeline start = block.positionTicks + (tape - windowStart)
// Returns [{ kind: 'note', startTick, endTick }].
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

  const blockLoopEnabled = block.loopEnabled !== false
  const firstLoop = Math.floor(windowStart / patLen)
  let lastLoop = Math.floor((windowEnd - 1) / patLen)
  if (!blockLoopEnabled) lastLoop = Math.min(lastLoop, 0)

  for (let loop = firstLoop; loop <= lastLoop; loop += 1) {
    for (const note of notes) {
      if (note == null) continue
      const notePos = Number.isFinite(note.positionTicks) ? note.positionTicks : 0
      const tape = loop * patLen + notePos
      if (tape < windowStart || tape >= windowEnd) continue
      const startTick = blockPos + (tape - windowStart)
      const dur = Number.isFinite(note.durationTicks) ? Math.max(0, note.durationTicks) : 0
      events.push({ kind: 'note', startTick, endTick: startTick + dur })
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
// function. `getTriggerData` returns { clips, patternBlocks, patterns } from the renderer
// (TimelineView wires this to its live timeline state).
export function startEnvelopePlayback(deps = {}) {
  const subscribe = deps.subscribe ?? subscribeTransport
  const getStore = deps.getStore ?? (() => useEffectChainStore.getState())
  const getTriggerData = deps.getTriggerData ?? (() => ({}))
  const options = deps.options ?? {}
  let lastIsPlaying = null

  const handleTransport = (transport) => {
    if (!transport) return
    const store = getStore()
    if (!store) return

    const playingChanged = transport.isPlaying !== lastIsPlaying
    if (playingChanged) {
      lastIsPlaying = transport.isPlaying
      // On any play/stop transition, reset the session runtime cache so the next drive
      // re-evaluates from the current position (handles seek-while-stopped and resume).
      store.resetEnvelopeModulationRuntime?.()
    }

    const tick = positionMsToTick(transport.positionMs, transport.bpm)
    const msPerTick = computeMsPerTick(transport.bpm)

    if (transport.isPlaying) {
      const trackEvents = buildTrackTriggerEvents(getTriggerData())
      // Fire-and-forget: the store dedupes redundant writes and never throws.
      void store.applyEnvelopeModulationAtTick?.(tick, { ...options, trackEvents, msPerTick, bpm: transport.bpm })
    } else if (playingChanged) {
      // Stop transition: one flush pass with no active gates drives connected parameters
      // to 0 so a triggered envelope never leaves a parameter stuck open. (The cache was
      // just reset above, so this write is not suppressed.)
      void store.applyEnvelopeModulationAtTick?.(tick, { ...options, trackEvents: {}, msPerTick, bpm: transport.bpm })
    }
  }

  return subscribe(handleTransport)
}
