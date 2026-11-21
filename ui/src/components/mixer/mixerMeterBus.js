// Fan-out from the mixer's ONE existing peak-poll loop (MixerPanel) to the kit
// Meters. It adds no timer: publishMeters() is called right after the loop merges
// a getAllPeaks reply into peaksSnapshot, and each kit Meter then animates its own
// ballistics on requestAnimationFrame (and sleeps when settled).

export const METER_FLOOR_DB = -120

const subscribers = new Map() // key ('master' | String(trackId)) -> Set<push>

export function peakToDb(peak) {
  if (!Number.isFinite(peak) || peak <= 0) return METER_FLOOR_DB
  return Math.max(METER_FLOOR_DB, 20 * Math.log10(peak))
}

/** Subscribe a kit Meter's `push` to one strip. Returns the unsubscribe. */
export function subscribeMeter(key, push) {
  const k = String(key)
  let set = subscribers.get(k)
  if (!set) { set = new Set(); subscribers.set(k, set) }
  set.add(push)
  return () => {
    set.delete(push)
    if (set.size === 0) subscribers.delete(k)
  }
}

/** [L, R] in dB for a snapshot entry; a silent floor when there is no telemetry. */
export function levelsOf(entry) {
  if (!entry || !entry.hasTelemetry) return [METER_FLOOR_DB, METER_FLOOR_DB]
  return [peakToDb(entry.peakL), peakToDb(entry.peakR)]
}

/** Push the current snapshot to every subscribed meter. */
export function publishMeters(snapshot) {
  for (const [key, set] of subscribers) {
    const levels = levelsOf(key === 'master' ? snapshot.master : snapshot.tracks[key])
    for (const push of set) push(levels)
  }
}

export function meterSubscriberCount() {
  let n = 0
  for (const set of subscribers.values()) n += set.size
  return n
}
