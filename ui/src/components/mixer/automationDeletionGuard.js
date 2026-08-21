import { PPQ } from '../../constants/timeline.js'
import { timelineEvents } from '../../timelineEvents.js'
import { showAutomationDeleteConfirm } from './AutomationDeleteConfirmDialog.jsx'
import { PLUGIN_NAMES } from './effectEditorOpeners.js'
import { chainKeyForTrack } from './automationKnobBinding.jsx'
import useEffectChainStore from '../../stores/effectChainStore.js'
import useAutomationBindingStore from '../../stores/automationBindingStore.js'

// ── Effect / track deletion contract (Phase C) ───────────────────────────────
//
// From the locked spec: deleting an effect that has bound automation clips
// shows a confirmation naming the clips that will die; confirming deletes clips
// + effect, cancelling aborts the removal entirely. Deleting a whole track
// cascades through the same confirmation when ANY effect on its chain has
// bound clips.
//
// The automation half is one engine command per effect instance
// (RemoveAutomationForEffectInstanceCommand): every bound clip plus any lane
// they leave empty, in ONE undo step, restored together by Ctrl+Z. The effect
// removal itself is a MixEngine call that is not part of the engine's undo
// system, which is exactly why Phase A defines the order — automation first,
// then the effect — so undo puts the clips back when the effect returns.

function barLabel(positionTicks) {
  const beats = positionTicks / PPQ
  const bar = Math.floor(beats / 4) + 1
  const beat = (beats % 4) + 1
  return `Bar ${bar}.${beat % 1 === 0 ? beat : beat.toFixed(2)}`
}

function effectDisplayName(pluginId) {
  if (!pluginId) return 'Effect'
  return PLUGIN_NAMES?.[pluginId] ?? pluginId
}

/**
 * Bound clips for one effect instance, shaped for the dialog.
 * Returns [] when the engine query is unavailable or the instance has none.
 */
export async function boundClipsForEffectInstance(ownerTrackId, effectInstanceId, effectName) {
  const fn = globalThis.window?.xleth?.automation?.getClipsForEffectInstance
  if (typeof fn !== 'function') {
    console.warn('[Automation] automation.getClipsForEffectInstance is unavailable - deletion guard skipped')
    return []
  }
  if (!effectInstanceId) return []
  try {
    const clips = await fn(ownerTrackId, effectInstanceId)
    if (!Array.isArray(clips)) return []
    return clips.map((c) => ({
      id: c.id,
      effectInstanceId,
      label: `${effectName} - ${c.parameterId ?? '?'}`,
      position: barLabel(c.positionTicks ?? 0),
    }))
  } catch (err) {
    console.warn('[Automation] getClipsForEffectInstance failed:', err?.message)
    return []
  }
}

// Resolves { effectInstanceId, pluginId } for a chain slot from the cached
// chain (nodeId is a chain-local handle; the binding uses the stable id).
function chainEntry(trackId, nodeId) {
  const chain = useEffectChainStore.getState().chains?.[chainKeyForTrack(trackId)]
  if (!Array.isArray(chain)) return null
  return chain.find((fx) => fx.nodeId === nodeId) ?? null
}

async function removeAutomationForInstances(ownerTrackId, effectInstanceIds) {
  const fn = globalThis.window?.xleth?.automation?.removeForEffectInstance
  if (typeof fn !== 'function') {
    console.error('[Automation] automation.removeForEffectInstance is unavailable - clips would be orphaned')
    return 0
  }
  let removed = 0
  for (const id of effectInstanceIds) {
    try {
      const n = await fn(ownerTrackId, id)
      if (Number.isFinite(n)) removed += n
    } catch (err) {
      console.error(`[Automation] removeForEffectInstance(${ownerTrackId}, ${id}) failed:`, err)
    }
  }
  if (removed > 0) {
    await useAutomationBindingStore.getState().refresh()
    timelineEvents.dispatchEvent(new Event('timeline-automation-changed'))
  }
  return removed
}

/**
 * Gate one effect removal.
 *
 * Returns true when the caller should go ahead and remove the effect (either
 * nothing was bound, or the user confirmed and the clips are already gone),
 * false when the user cancelled and the removal must be abandoned.
 */
export async function confirmEffectRemoval(trackId, nodeId) {
  const entry = chainEntry(trackId, nodeId)
  const effectInstanceId = entry?.effectInstanceId
  const effectName = effectDisplayName(entry?.pluginId)
  const clips = await boundClipsForEffectInstance(trackId, effectInstanceId, effectName)
  if (clips.length === 0) return true

  const ok = await showAutomationDeleteConfirm({
    title: 'Delete effect with automation?',
    subject: effectName,
    clips,
  })
  if (!ok) {
    console.log(`[Automation] Effect removal cancelled - ${clips.length} bound clip(s) kept`)
    return false
  }
  const removed = await removeAutomationForInstances(trackId, [effectInstanceId])
  console.log(`[Automation] Removed ${removed} clip(s) bound to ${effectInstanceId} before deleting the effect`)
  return true
}

/**
 * Gate a whole-track removal: cascades through the same confirmation when any
 * effect on the track's chain has bound clips. Returns true to proceed.
 */
export async function confirmTrackRemoval(trackId, trackName) {
  const chain = useEffectChainStore.getState().chains?.[chainKeyForTrack(trackId)]
  if (!Array.isArray(chain) || chain.length === 0) return true

  const all = []
  for (const fx of chain) {
    const clips = await boundClipsForEffectInstance(trackId, fx.effectInstanceId, effectDisplayName(fx.pluginId))
    all.push(...clips)
  }
  if (all.length === 0) return true

  const ok = await showAutomationDeleteConfirm({
    title: 'Delete track with automation?',
    subject: trackName ? `track "${trackName}"` : 'this track',
    clips: all,
  })
  if (!ok) {
    console.log(`[Automation] Track removal cancelled - ${all.length} bound clip(s) kept`)
    return false
  }
  const instanceIds = [...new Set(all.map((c) => c.effectInstanceId))]
  const removed = await removeAutomationForInstances(trackId, instanceIds)
  console.log(`[Automation] Removed ${removed} clip(s) across ${instanceIds.length} effect(s) before deleting track ${trackId}`)
  return true
}
