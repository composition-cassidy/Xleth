// The ONE place the renderer writes a track's visual effects.
//
// Every function is the exact call the Inspector's legacy panels made
// (VisualFXSection, ChainableEffectParams, NonChainableEffectParams,
// NoteFadeSection, SlideNoteEffectSection), followed by the same refresh they
// triggered through fetchTracks(): a 'timeline-tracks-changed' event, which every
// view that mirrors these fields (the Devices Video view, the Inspector, the
// arrangement) listens for. Each engine call is one undo command, exactly as before.
//
// Chain entries have no ids: the engine addresses them by INDEX. Callers must
// pass the index of the chain they are showing, and that chain is refetched after
// every write, so two surfaces never keep diverging copies of it.

import { timelineEvents } from '../../../timelineEvents.js'

const notify = () => timelineEvents.dispatchEvent(new Event('timeline-tracks-changed'))

function timelineFn(name) {
  const fn = window.xleth?.timeline?.[name]
  if (typeof fn !== 'function') {
    // A missing link in the four-layer bridge must not look like a write that worked.
    console.warn(`[VideoFx] timeline.${name} is unavailable; nothing written`)
    return null
  }
  return fn
}

async function call(name, ...args) {
  const fn = timelineFn(name)
  if (!fn) return undefined
  try {
    return await fn(...args)
  } catch (err) {
    console.error(`[VideoFx] ${name} failed:`, err)
    return undefined
  }
}

// ── Chain structure ──────────────────────────────────────────────────────────

export async function addChainEffect(trackId, type) {
  await call('addVisualEffect', trackId, type)
  notify()
}

export async function removeChainEffect(trackId, index) {
  await call('removeVisualEffect', trackId, index)
  notify()
}

export async function setChainEffectBypassed(trackId, index, bypassed) {
  await call('setVisualEffectBypassed', trackId, index, bypassed)
  notify()
}

/** Move one entry. Sends the permutation setTrackVisualEffectChainOrder expects. */
export async function moveChainEffect(trackId, length, fromIndex, toIndex) {
  if (fromIndex === toIndex) return
  const order = Array.from({ length }, (_, i) => i)
  const [moved] = order.splice(fromIndex, 1)
  order.splice(toIndex, 0, moved)
  await call('setTrackVisualEffectChainOrder', trackId, order)
  notify()
}

// ── Chain parameters ─────────────────────────────────────────────────────────

export async function setChainParam(trackId, index, paramIndex, value) {
  await call('setVisualEffectParam', trackId, index, paramIndex, value)
  notify()
}

/** A colour is three params (0..2), three calls, as the legacy colour inputs sent. */
export async function setChainColour(trackId, index, [r, g, b]) {
  await call('setVisualEffectParam', trackId, index, 0, r)
  await call('setVisualEffectParam', trackId, index, 1, g)
  await call('setVisualEffectParam', trackId, index, 2, b)
  notify()
}

/** Preview-only mute (no undo, not saved, not exported): used by the chroma key eyedropper. */
export async function setChainPreviewMuted(trackId, muted) {
  await call('setVisualEffectChainPreviewMuted', trackId, muted)
}

// ── Per-note configs (whole-object writes, as before) ────────────────────────

export async function setBounce(trackId, current, patch) {
  await call('setTrackBounceSettings', trackId, { ...(current ?? {}), ...patch })
  notify()
}

export async function setZoomPanRot(trackId, current, patch) {
  await call('setTrackZoomPanRotSettings', trackId, { ...(current ?? {}), ...patch })
  notify()
}

export async function setZprTracks(trackId, tracks) {
  await call('setTrackZprTracks', trackId, tracks)
  notify()
}

export async function setPingPong(trackId, current, patch) {
  await call('setTrackPingPongSettings', trackId, { ...(current ?? {}), ...patch })
  notify()
}

export async function setNoteFade(trackId, config) {
  await call('setTrackNoteFade', trackId, config)
  notify()
}

export async function setSlideNoteEffect(trackId, current, patch) {
  await call('setTrackSlideNoteEffect', trackId, { ...(current ?? {}), ...patch })
  notify()
}

/** Turn a per-note config on or off (the device's activator, add and remove). */
export async function setNoteDeviceEnabled(track, id, enabled) {
  switch (id) {
    case 'bounce': return setBounce(track.id, track.bounce, { enabled })
    case 'zoomPanRot': return setZoomPanRot(track.id, track.zoomPanRot, { enabled })
    case 'pingPong': return setPingPong(track.id, track.pingPong, { enabled })
    case 'noteFade': {
      const nf = track.noteFade ?? {}
      return setNoteFade(track.id, { enabled, fadeIn: nf.fadeIn, fadeOut: nf.fadeOut })
    }
    default: return undefined
  }
}
