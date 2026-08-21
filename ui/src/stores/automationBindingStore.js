import { create } from 'zustand'
import { sortedEnvelopePoints, sampleEnvelopeValueAtTick } from '../components/timeline/automationLaneGeometry.js'
import { timelineEvents } from '../timelineEvents.js'

// ── automationBindingStore ───────────────────────────────────────────────────
// A read-model of the engine's automation state, keyed the way the MIXER needs
// it: "given this knob's binding, is a clip covering the playhead, and what
// value does it hold there?"
//
// Why a cache and not a per-knob RPC: the automated-knob readout updates with
// the playhead. Asking automation_evaluateAtTick per knob per display tick
// would put an IPC storm on the JUCE message thread for a purely derived
// number. The evaluation here is the SAME linear interpolation the canvas draws
// and the engine's plan evaluates (verified against automation_evaluateAtTick
// during Phase C bring-up), so the knob, the curve, and the audio agree.
//
// The cache refreshes only on 'timeline-automation-changed' and project load —
// automation data changes on user edits, not continuously.

function bindingKey(ownerTrackId, effectInstanceId, parameterId) {
  return `${ownerTrackId}\u0000${effectInstanceId}\u0000${parameterId}`
}

export { bindingKey }

const useAutomationBindingStore = create((set, get) => ({
  lanes: [],
  clips: [],
  envelopes: [],
  // bindingKey -> { envelopeIds: Set, clips: [clip, ...] } — rebuilt on refresh.
  index: new Map(),
  loaded: false,

  refresh: async () => {
    const api = globalThis.window?.xleth?.automation
    if (!api?.getLanes || !api?.getClips || !api?.getEnvelopes) return false
    try {
      const [lanes, clips, envelopes] = await Promise.all([
        api.getLanes(), api.getClips(), api.getEnvelopes(),
      ])
      set({
        lanes: lanes ?? [],
        clips: clips ?? [],
        envelopes: envelopes ?? [],
        index: buildIndex(lanes ?? [], clips ?? [], envelopes ?? []),
        loaded: true,
      })
      return true
    } catch (err) {
      console.warn('[automationBindingStore] refresh failed:', err?.message)
      return false
    }
  },

  // The envelope already bound to this parameter, or null. One envelope per
  // binding is the invariant the knob entry point maintains; if several exist
  // (a project hand-edited, or a make-unique copy) the first is canonical.
  envelopeForBinding: (ownerTrackId, effectInstanceId, parameterId) => {
    const entry = get().index.get(bindingKey(ownerTrackId, effectInstanceId, parameterId))
    return entry?.envelopes?.[0] ?? null
  },

  clipsForBinding: (ownerTrackId, effectInstanceId, parameterId) => {
    const entry = get().index.get(bindingKey(ownerTrackId, effectInstanceId, parameterId))
    return entry?.clips ?? []
  },

  // The clip covering `tick`, resolving cross-lane overlap by topmost-lane-wins
  // (lowest AutomationLane.index), exactly as the engine's plan does.
  clipCoveringTick: (ownerTrackId, effectInstanceId, parameterId, tick) => {
    const { index, lanes } = get()
    const entry = index.get(bindingKey(ownerTrackId, effectInstanceId, parameterId))
    if (!entry) return null
    const laneIndexById = new Map(lanes.map((l) => [l.id, l.index]))
    let best = null
    let bestLaneIndex = Number.MAX_SAFE_INTEGER
    for (const clip of entry.clips) {
      if (tick < clip.positionTicks || tick >= clip.positionTicks + clip.durationTicks) continue
      const laneIndex = laneIndexById.get(clip.laneId) ?? Number.MAX_SAFE_INTEGER
      if (laneIndex < bestLaneIndex) { best = clip; bestLaneIndex = laneIndex }
    }
    return best
  },

  // Automated value at a timeline tick, or null when no clip covers it (which
  // is exactly when the knob goes back to being manually editable).
  evaluateAtTick: (ownerTrackId, effectInstanceId, parameterId, tick) => {
    const state = get()
    const clip = state.clipCoveringTick(ownerTrackId, effectInstanceId, parameterId, tick)
    if (!clip) return null
    const envelope = state.envelopes.find((e) => e.id === clip.envelopeId)
    if (!envelope) return null
    const points = sortedEnvelopePoints(envelope.points)
    if (points.length === 0) return null
    // Timeline tick → intra-envelope tick through the clip's trimmed window.
    const intraTick = tick - clip.positionTicks + (clip.offsetTicks ?? 0)
    return sampleEnvelopeValueAtTick(points, intraTick)
  },
}))

function buildIndex(lanes, clips, envelopes) {
  const map = new Map()
  const envelopeById = new Map(envelopes.map((e) => [e.id, e]))
  for (const env of envelopes) {
    const b = env.binding
    if (!b) continue
    const key = bindingKey(b.ownerTrackId, b.effectInstanceId, b.parameterId)
    if (!map.has(key)) map.set(key, { envelopes: [], clips: [] })
    map.get(key).envelopes.push(env)
  }
  for (const clip of clips) {
    const env = envelopeById.get(clip.envelopeId)
    const b = env?.binding
    if (!b) continue
    const key = bindingKey(b.ownerTrackId, b.effectInstanceId, b.parameterId)
    if (!map.has(key)) map.set(key, { envelopes: [], clips: [] })
    map.get(key).clips.push(clip)
  }
  return map
}

// One subscription for the whole app: every automation mutation (timeline or
// mixer) already dispatches this event, so the mixer never has to poll.
let wired = false
export function wireAutomationBindingStore() {
  if (wired) return
  wired = true
  const refresh = () => { void useAutomationBindingStore.getState().refresh() }
  timelineEvents.addEventListener('timeline-automation-changed', refresh)
  globalThis.window?.xleth?.onProjectLoaded?.(refresh)
  refresh()
}

export default useAutomationBindingStore
