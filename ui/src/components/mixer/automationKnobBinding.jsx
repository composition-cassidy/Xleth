import { useCallback, useEffect, useState } from 'react'
import ContextMenu from '../ContextMenu.jsx'
import { PPQ, snapTickToGrid } from '../../constants/timeline.js'
import { timelineEvents } from '../../timelineEvents.js'
import { playheadClock } from '../../services/PlayheadClock.js'
import useEffectChainStore from '../../stores/effectChainStore.js'
import useAutomationBindingStore, { wireAutomationBindingStore } from '../../stores/automationBindingStore.js'
import useSnapStore from '../../stores/snapStore.js'

// ── Automation binding for stock-effect knobs (Phase C) ──────────────────────
//
// One seam, not thirty: every stock effect panel draws its knobs with
// PluginUIKitKnob, so the right-click entry point, the automated read-only
// state and the automated value readout all live in that one component. A panel
// opts a knob in with two props:
//
//   paramId="<apvts id>"        the effect's stable parameter id
//   automationTarget={target}   the { trackId, nodeId } the panel already holds
//
// A knob missing either one runs NONE of this path — the same opt-in discipline
// as Knob's `mod` prop.
//
// Master-chain effects are trackId -1, which is exactly the id the engine
// binding and the pinned Master automation group already use. The one place it
// matters is reading the chain: the engine keeps the master chain in its own
// member, so audio_getEffectChain(-1) returns [] and the master chain has to be
// read through audio_getMasterEffectChain instead (see chainKeyForTrack).

// ── effectInstanceId resolution ──────────────────────────────────────────────
// Bindings are keyed by the STABLE effectInstanceId, never by the chain slot or
// the engine nodeId, so reordering a chain cannot break an automation clip.
// effectChainStore already caches the parsed chain (which carries
// effectInstanceId per node) for both the per-track and the master chains, so
// this resolution is a synchronous map lookup, not another RPC per knob.

export function chainKeyForTrack(trackId) {
  return trackId === -1 || trackId === 'master' ? 'master' : String(trackId)
}

export function resolveEffectInstanceId(trackId, nodeId) {
  if (trackId == null || nodeId == null) return null
  const chain = useEffectChainStore.getState().chains?.[chainKeyForTrack(trackId)]
  if (!Array.isArray(chain)) return null
  return chain.find((fx) => fx.nodeId === nodeId)?.effectInstanceId ?? null
}

// ── Placement ────────────────────────────────────────────────────────────────

const ONE_BAR_TICKS = PPQ * 4

// Default clip placement: always one bar, starting at the playhead and
// snapped to the current snap-store granularity. Never the loop/render
// region — a knob-created clip is a fresh one-bar phrase, not a span of
// whatever the user last selected for looping/rendering.
function defaultClipPlacement() {
  const beats = playheadClock?.positionBeats
  const rawTicks = Number.isFinite(beats) ? Math.max(0, Math.round(beats * PPQ)) : 0
  const granularity = useSnapStore.getState().snapGranularity
  const positionTicks = snapTickToGrid(rawTicks, {}, granularity)
  return { positionTicks, durationTicks: ONE_BAR_TICKS }
}

// Same-lane overlap is REJECTED by the engine's mutation layer, so a second
// clip for a parameter that already has one under the playhead has to land
// somewhere free. Slides right past every clip it would overlap.
export function findFreePosition(laneClips, positionTicks, durationTicks) {
  const sorted = [...laneClips].sort((a, b) => a.positionTicks - b.positionTicks)
  let pos = positionTicks
  let moved = true
  while (moved) {
    moved = false
    for (const c of sorted) {
      const cEnd = c.positionTicks + c.durationTicks
      if (pos < cEnd && c.positionTicks < pos + durationTicks) {
        pos = cEnd
        moved = true
      }
    }
  }
  return pos
}

/**
 * The "Create automation clip" action.
 *
 * Creates, or REVEALS AND REUSES, the automation lane bound to this exact
 * parameter, then adds a clip on it initialized flat at the knob's current
 * value. A parameter never grows a second lane: if one already exists, the new
 * clip joins it and shares the existing envelope, exactly like a pattern block
 * sharing a pattern.
 *
 * Returns { ok, laneId, clipId, envelopeId, reason }.
 */
export async function createAutomationClipForKnob({ ownerTrackId, effectInstanceId, parameterId }) {
  const api = globalThis.window?.xleth?.automation
  // The four-layer bridge optional-chains missing methods into silence, so
  // every method this flow needs is checked up front and named when absent.
  const missing = ['getBaseValue', 'addEnvelope', 'addLane', 'addClip', 'getLanes', 'getClips', 'getEnvelopes']
    .filter((m) => typeof api?.[m] !== 'function')
  if (missing.length > 0) {
    console.error(`[Automation] bridge methods unavailable: ${missing.join(', ')} - cannot create automation clip`)
    return { ok: false, reason: 'bridge-unavailable' }
  }

  const binding = { ownerTrackId, effectInstanceId, parameterId }
  let baseValue = 0
  try {
    const base = await api.getBaseValue(binding)
    if (base && Number.isFinite(base.value)) baseValue = base.value
    if (base && base.resolved === false) {
      console.warn(`[Automation] binding is not a live automatable parameter: ${effectInstanceId}/${parameterId}`)
    }
  } catch (err) {
    console.warn('[Automation] getBaseValue failed, initializing the envelope at 0:', err?.message)
  }

  await useAutomationBindingStore.getState().refresh()
  const fresh = useAutomationBindingStore.getState()

  const placement = await defaultClipPlacement()
  const existingEnvelope = fresh.envelopeForBinding(ownerTrackId, effectInstanceId, parameterId)
  const existingClips = fresh.clipsForBinding(ownerTrackId, effectInstanceId, parameterId)

  // Reveal-and-reuse: the lane that already carries this parameter's clips.
  let laneId = existingClips[0]?.laneId ?? null
  if (laneId == null) {
    // No clips yet. Reuse an empty lane owned by this track if the project has
    // one; otherwise add a lane to the owner's group (Master when -1).
    const clipLaneIds = new Set(fresh.clips.map((c) => c.laneId))
    const emptyOwned = fresh.lanes.find((l) => l.ownerTrackId === ownerTrackId && !clipLaneIds.has(l.id))
    laneId = emptyOwned?.id ?? null
  }
  if (laneId == null) {
    laneId = await api.addLane({ ownerTrackId })
    if (!Number.isInteger(laneId) || laneId < 0) {
      console.error('[Automation] addLane rejected for owner', ownerTrackId)
      return { ok: false, reason: 'lane-rejected' }
    }
  }

  let envelopeId = existingEnvelope?.id ?? null
  if (envelopeId == null) {
    // Flat at the knob's current value: two points, so the clip reads as a
    // horizontal line whose ends the user can immediately grab. curveType 0 =
    // Linear, tension 0 - the fields ship from v1 so the tension UI can land
    // later without a format migration.
    envelopeId = await api.addEnvelope({
      ownerTrackId, effectInstanceId, parameterId,
      points: [
        { tick: 0, value: baseValue, curveType: 0, tension: 0 },
        { tick: placement.durationTicks, value: baseValue, curveType: 0, tension: 0 },
      ],
    })
    if (!Number.isInteger(envelopeId) || envelopeId < 0) {
      console.error('[Automation] addEnvelope rejected for', binding)
      return { ok: false, reason: 'envelope-rejected' }
    }
  }

  const laneClips = fresh.clips.filter((c) => c.laneId === laneId)
  const positionTicks = findFreePosition(laneClips, placement.positionTicks, placement.durationTicks)
  const clipId = await api.addClip({
    laneId, envelopeId, positionTicks, durationTicks: placement.durationTicks, offsetTicks: 0,
  })
  if (!Number.isInteger(clipId) || clipId < 0) {
    console.error('[Automation] addClip rejected', { laneId, envelopeId, positionTicks })
    return { ok: false, reason: 'clip-rejected' }
  }

  await useAutomationBindingStore.getState().refresh()
  timelineEvents.dispatchEvent(new Event('timeline-automation-changed'))
  // Asks the timeline to expand the owning group and select the new clip -
  // "reveal", not merely "create".
  timelineEvents.dispatchEvent(new CustomEvent('timeline-automation-reveal', {
    detail: { ownerTrackId, laneId, clipId },
  }))
  console.log(`[Automation] Created clip ${clipId} on lane ${laneId} (envelope ${envelopeId}) for ${ownerTrackId}/${effectInstanceId}/${parameterId} @${positionTicks}t`)
  return { ok: true, laneId, clipId, envelopeId }
}

// ── The knob-side hook ───────────────────────────────────────────────────────

// JUCE NormalisableRange, mirrored: convertFrom0to1(p) = start + (end-start) *
// p^(1/skew). The same mapping Knob uses for its own travel, so a normalized
// automation value lands on the identical knob position the engine applies.
export function displayFromNormalized(norm, min, max, skew) {
  const span = max - min
  if (!(span > 0)) return min
  const p = Math.max(0, Math.min(1, norm))
  const eff = Number.isFinite(skew) && skew > 0 ? skew : 1
  return min + span * (eff === 1 || p <= 0 ? p : Math.pow(p, 1 / eff))
}

// The exact inverse: convertTo0to1(v) = ((v - start) / (end - start))^skew.
export function normalizedFromDisplay(value, min, max, skew) {
  const span = max - min
  if (!(span > 0)) return 0
  const p = Math.max(0, Math.min(1, (value - min) / span))
  const eff = Number.isFinite(skew) && skew > 0 ? skew : 1
  return eff === 1 || p <= 0 ? p : Math.pow(p, eff)
}

/**
 * Automation state for one knob. Inert (every field false/null) unless the knob
 * declares BOTH a paramId and an automationTarget.
 *
 * Returns:
 *   enabled          the right-click entry point applies to this knob
 *   automated        a clip covers the playhead, so the knob is read-only
 *   automatedValue   that clip's value at the playhead, in the knob's units
 *   onContextMenu    right-click handler for the knob's root element
 *   menuNode         the rendered context menu (null when closed)
 */
export function useKnobAutomation(paramId, automationTarget, { min, max, skew } = {}) {
  const [menu, setMenu] = useState(null)
  const [automatedNorm, setAutomatedNorm] = useState(null)
  const [effectInstanceId, setEffectInstanceId] = useState(null)

  const trackId = automationTarget?.trackId ?? null
  const nodeId = automationTarget?.nodeId ?? null
  const wanted = !!(paramId && trackId != null && nodeId != null)

  // Track the chain so the instance id survives a chain refetch (add/remove/
  // reorder all replace the array). Synchronous read, store subscription — no
  // extra IPC per knob.
  useEffect(() => {
    if (!wanted) { setEffectInstanceId(null); return undefined }
    const read = () => setEffectInstanceId(resolveEffectInstanceId(trackId, nodeId))
    read()
    return useEffectChainStore.subscribe(read)
  }, [wanted, trackId, nodeId])

  const enabled = wanted && !!effectInstanceId

  // Re-evaluate on playhead display ticks (10 fps - the cadence every other
  // transport readout uses) and whenever automation data changes. The lookup is
  // local: the store already holds the clips and envelopes, so an automated
  // knob costs no IPC per frame.
  useEffect(() => {
    if (!enabled) { setAutomatedNorm(null); return undefined }
    wireAutomationBindingStore()
    const evaluate = () => {
      const beats = playheadClock?.positionBeats ?? 0
      const tick = Math.round(beats * PPQ)
      const next = useAutomationBindingStore.getState()
        .evaluateAtTick(trackId, effectInstanceId, paramId, tick)
      setAutomatedNorm((prev) => {
        if (prev === null && next === null) return prev
        if (prev !== null && next !== null && Math.abs(prev - next) < 1e-6) return prev
        return next
      })
    }
    evaluate()
    const offClock = playheadClock.onDisplayUpdate(evaluate)
    const unsubStore = useAutomationBindingStore.subscribe(evaluate)
    return () => { offClock?.(); unsubStore?.() }
  }, [enabled, trackId, effectInstanceId, paramId])

  const onContextMenu = useCallback((e) => {
    if (!enabled) return
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY })
  }, [enabled])

  const handleCreate = useCallback(() => {
    if (!enabled) return
    void createAutomationClipForKnob({
      ownerTrackId: trackId, effectInstanceId, parameterId: paramId,
    })
  }, [enabled, trackId, effectInstanceId, paramId])

  const automated = automatedNorm !== null
  const automatedValue = automated
    ? displayFromNormalized(automatedNorm, min ?? 0, max ?? 1, skew)
    : null

  // A manual edit OUTSIDE every clip is the parameter's base value: the value
  // the plan uses before any clip has played, and the one it must fall back to
  // rather than whatever the last clip happened to leave behind. Only written
  // for parameters that actually have an envelope — an unautomated knob must
  // not grow a stored base value it never asked for.
  const writeBaseValue = useCallback((displayValue) => {
    if (!enabled || automated) return
    const hasEnvelope = !!useAutomationBindingStore.getState()
      .envelopeForBinding(trackId, effectInstanceId, paramId)
    if (!hasEnvelope) return
    const fn = globalThis.window?.xleth?.automation?.setBaseValue
    if (typeof fn !== 'function') {
      console.warn('[Automation] automation.setBaseValue is unavailable - base value not stored')
      return
    }
    const norm = normalizedFromDisplay(displayValue, min ?? 0, max ?? 1, skew)
    Promise.resolve(fn({ ownerTrackId: trackId, effectInstanceId, parameterId: paramId }, norm))
      .catch((err) => console.warn('[Automation] setBaseValue failed:', err?.message))
  }, [enabled, automated, trackId, effectInstanceId, paramId, min, max, skew])

  const menuNode = enabled && menu ? (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={[{ label: 'Create automation clip', onClick: handleCreate }]}
      onClose={() => setMenu(null)}
    />
  ) : null

  return {
    enabled,
    automated,
    automatedValue,
    writeBaseValue,
    onContextMenu: enabled ? onContextMenu : undefined,
    menuNode,
  }
}
