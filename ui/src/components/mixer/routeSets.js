// FL-style multi-wiring as pure set operations. A track's audible destinations
// are its primary output (Master = -1 by default) plus its sends (extra routes
// into other tracks, each with a level). The engine needs exactly one primary,
// so these helpers keep that invariant: Master, when routed, is always the
// primary; otherwise the first remaining destination is.
//
// No store, no IPC: mixerStore feeds these the current routing and sends the
// result to timeline.setTrackRoutes in one undoable call.

export const MASTER = -1
export const MAX_SENDS = 8          // mirrors kMaxTrackSends in the engine
export const SEND_GAIN_MAX = 2      // the engine clamps send levels to [0, 2]

/** Every destination of a track, primary first: [{ targetTrackId, gain, primary }]. */
export function destinationsOf(primary, sends = []) {
  const list = [{ targetTrackId: primary, gain: 1, primary: true }]
  for (const s of sends) {
    if (s.targetTrackId === primary) continue
    list.push({ targetTrackId: s.targetTrackId, gain: s.gain ?? 1, primary: false })
  }
  return list
}

/** True when `targetTrackId` is one of the track's audible destinations. */
export function isRoutedTo(primary, sends, targetTrackId) {
  return primary === targetTrackId || (sends ?? []).some(s => s.targetTrackId === targetTrackId)
}

/** The engine shape for a destination list: Master first if present, else the first entry. */
function fromDestinations(list) {
  const masterIdx = list.findIndex(d => d.targetTrackId === MASTER)
  const primaryIdx = masterIdx >= 0 ? masterIdx : 0
  const primary = list[primaryIdx].targetTrackId
  const sends = list
    .filter((_, i) => i !== primaryIdx)
    .map(d => ({ targetTrackId: d.targetTrackId, gain: d.gain ?? 1 }))
  return { targetTrackId: primary, sends }
}

/**
 * Left-click on a target's route arrow: route the source there too, or unroute
 * it if it is already routed there. Returns the new { targetTrackId, sends },
 * or null when nothing changes (the last remaining route is Master: a track
 * always has an output) or the source would exceed MAX_SENDS.
 *
 * Unrouting a track's last destination returns it to Master.
 */
export function toggleDestination(primary, sends, targetTrackId) {
  const list = destinationsOf(primary, sends)
  const idx = list.findIndex(d => d.targetTrackId === targetTrackId)
  if (idx >= 0) {
    const rest = list.filter((_, i) => i !== idx)
    if (rest.length === 0) {
      if (targetTrackId === MASTER) return null
      return { targetTrackId: MASTER, sends: [] }
    }
    return fromDestinations(rest)
  }
  if (list.length - 1 >= MAX_SENDS) return null
  return fromDestinations([...list, { targetTrackId, gain: 1 }])
}

/** Ctrl+click: route to this target only (FL "Route to this track only"). */
export function routeOnly(targetTrackId) {
  return { targetTrackId, sends: [] }
}

/** The track-level sidechain route source→target (empty effect id), if any. */
export function findTrackSidechain(sidechainRoutes, sourceTrackId, targetTrackId) {
  return (sidechainRoutes ?? []).find(r =>
    r.sourceTrackId === sourceTrackId &&
    r.targetTrackId === targetTrackId &&
    !r.targetEffectInstanceId) ?? null
}

/** True when source keys target by ANY sidechain route (track- or effect-level). */
export function isSidechainedTo(sidechainRoutes, sourceTrackId, targetTrackId) {
  return (sidechainRoutes ?? []).some(r =>
    r.sourceTrackId === sourceTrackId &&
    r.targetTrackId === targetTrackId &&
    r.enabled !== false)
}

/** Send level shown as dB for hints: 1 → "0.0 dB", 0 → "-inf dB". */
export function formatSendGain(gain) {
  if (!(gain > 0)) return '-inf dB'
  const db = 20 * Math.log10(gain)
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`
}
