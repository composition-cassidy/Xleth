/**
 * Identity-preserving reconciliation of an id-keyed timeline list.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Every clip mutation used to end in `await fetchClips()` → `timeline_getClips()`,
 * which returns EVERY clip in the project (26 scalar fields plus a nested
 * modulation object each), structured-clones them worker → main → renderer, and
 * then builds a brand-new JS object per clip on the way into state. Two costs,
 * both paid whether or not anything changed:
 *
 *   1. transport — a 5000-clip project is megabytes per mutation, for a drag
 *      that touched three clips;
 *   2. identity — every clip object is new, so every clips-keyed memo, effect
 *      and canvas invalidation in TimelineView fires for the whole project.
 *
 * Pattern blocks had the same shape (`fetchPatternBlocks` after every paste).
 *
 * The engine now answers each batch/single mutation with the post-state of the
 * records it touched (see clipsByIdToJs / patternBlocksByIdToJs in
 * XlethEngineService.cpp), so the renderer can splice that bounded set in. This
 * module does the splice, and it is deliberately conservative about identity:
 *
 *   • a record whose fields are all unchanged keeps its EXISTING object — memos
 *     downstream of it survive;
 *   • if nothing at all changed, the SAME ARRAY comes back, so `setState` is a
 *     no-op re-render at worst and every array-identity memo survives too.
 *
 * The unbounded refetch is NOT retired — undo/redo and project load change an
 * unbounded set and still go through it. This is for the paths where the change
 * set is known.
 */

/**
 * Structural equality, used to decide "did this record actually change?".
 *
 * Deliberately structural rather than driven by a field list. Engine records are
 * open-ended trees — a clip's `modulation` grows a field most times someone adds
 * a clip effect — and a hand-maintained key list would silently drop those
 * updates on the floor the moment it went stale. Recursing costs a few hundred
 * nanoseconds over a bounded set, orders of magnitude below the refetch it
 * replaces, and it cannot go out of date.
 */
function deepEqual(a, b) {
  if (a === b) return true
  if (a == null || b == null) return a === b
  if (typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!deepEqual(a[k], b[k])) return false
  }
  return true
}

/**
 * True when `next` carries nothing `prev` does not already say.
 *
 * Only the keys PRESENT on `next` are compared, for two reasons: a mutation
 * reply is allowed to be a partial patch (commitClipControlEdit sends one), and
 * renderer-only fields that the engine never sends must survive the merge rather
 * than count as a difference.
 */
export function recordFieldsEqual(prev, next) {
  if (!prev || !next) return false
  for (const key of Object.keys(next)) {
    if (!deepEqual(prev[key], next[key])) return false
  }
  return true
}

/**
 * Splice a bounded change set into an id-keyed list.
 *
 *   records    current list
 *   updated    records returned by a mutation — matched by id. An id not present
 *              in `records` is treated as an INSERT, so a paste that returns its
 *              inserted rows needs no separate `added`.
 *   removed    ids to drop (array or Set)
 *   normalize  applied to every object this function actually creates, so
 *              spliced-in records get the same treatment the full fetch gives
 *              them (clips: fade normalization). Untouched records are never
 *              re-normalized — they already were, and re-running it would break
 *              identity for no gain.
 *
 * Returns the SAME array reference when nothing changed.
 */
export function reconcileById(records, { updated = [], removed = [], normalize = (r) => r } = {}) {
  const current = Array.isArray(records) ? records : []
  const removedIds = removed instanceof Set ? removed : new Set(removed ?? [])
  const patches = new Map()
  for (const u of (updated ?? [])) {
    // A removal is the later fact: a remove+insert batch may legitimately name
    // the same id in both halves if the engine reused it.
    if (u && u.id != null && !removedIds.has(u.id)) patches.set(u.id, u)
  }
  if (patches.size === 0 && removedIds.size === 0) return current

  let changed = false
  const out = []
  for (const record of current) {
    if (removedIds.has(record.id)) { changed = true; continue }
    const patch = patches.get(record.id)
    if (patch === undefined) { out.push(record); continue }
    patches.delete(record.id)        // consumed — whatever is left is an insert
    if (recordFieldsEqual(record, patch)) { out.push(record); continue }
    out.push(normalize({ ...record, ...patch }))
    changed = true
  }
  // Inserts (paste / duplicate / split) keep arrival order, appended at the end.
  // Position in these lists carries no meaning — the canvas draws from
  // trackId + positionTicks — so appending is not a reordering.
  for (const patch of patches.values()) {
    out.push(normalize({ ...patch }))
    changed = true
  }
  return changed ? out : current
}
