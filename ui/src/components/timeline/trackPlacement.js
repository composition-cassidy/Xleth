import { timelineEvents } from '../../timelineEvents.js'

/**
 * Shared, engine-agnostic helpers for a track's *video placement* — the
 * unified compositing z-order that spans grid slots AND fullscreen layers
 * (see engine/src/model/TimelineTypes.h). This module is the single source of
 * truth for:
 *   • reading a track's current placement (grid / fullscreen-behind /
 *     fullscreen-front / unplaced) and its real zOrder,
 *   • sorting the flat Video-tab track list by that zOrder,
 *   • the right-click placement-mode actions (assign to grid / make fullscreen /
 *     convert grid<->fullscreen / unplace) — Video-tab list (VideoTrackList) and
 *     the Video-tab track-menu builder ONLY. The Audio tab's track context menu
 *     deliberately does not surface these (see TimelineView.jsx),
 *   • recomputing fresh zOrder integers after a drag-reorder.
 *
 * Everything here writes ONLY placement zOrder / grid / fullscreen state. It
 * NEVER touches setTrackOrder — that is the Audio/mixer *arrangement* order, an
 * entirely separate concept.
 */

// Mirror of engine constants in TimelineTypes.h (each grid column/row is split
// into this many fine sub-units; slots store gridX/gridY/spanX/spanY in them).
export const SUB_UNITS_PER_COLUMN = 8
export const SUB_UNITS_PER_ROW = 8

const notifyGrid   = () => timelineEvents.dispatchEvent(new Event('timeline-grid-changed'))
const notifyTracks = () => timelineEvents.dispatchEvent(new Event('timeline-tracks-changed'))

// ── Read helpers (pure) ──────────────────────────────────────────────────────

/**
 * Resolve a track's current video placement from the grid layout.
 * A track is grid-slotted OR fullscreen (never both), or has no placement.
 * @returns {{ kind: 'grid'|'behind'|'front'|'unplaced', zOrder: number|null,
 *             cell?: {col:number,row:number} }}
 */
export function getTrackPlacement(trackId, layout) {
  const slot = (layout?.slots ?? []).find(s => s.trackId === trackId)
  if (slot) {
    return {
      kind: 'grid',
      zOrder: slot.zOrder ?? 0,
      cell: {
        col: Math.floor((slot.gridX ?? 0) / SUB_UNITS_PER_COLUMN),
        row: Math.floor((slot.gridY ?? 0) / SUB_UNITS_PER_ROW),
      },
    }
  }
  const fs = (layout?.fullscreenLayers ?? []).find(l => l.trackId === trackId)
  if (fs) {
    const kind = fs.placement === 'front' ? 'front' : 'behind'
    return { kind, zOrder: fs.zOrder ?? 0 }
  }
  return { kind: 'unplaced', zOrder: null }
}

/**
 * Split tracks into the ordered placed stack (frontmost first = highest zOrder,
 * top of the list) and the unplaced remainder (no zOrder, don't render).
 * @returns {{ placed: Array<{track:object, placement:object}>, unplaced: object[] }}
 */
export function partitionAndSortTracks(tracks, layout) {
  const placed = []
  const unplaced = []
  for (const t of tracks ?? []) {
    const p = getTrackPlacement(t.id, layout)
    if (p.kind === 'unplaced') unplaced.push(t)
    else placed.push({ track: t, placement: p })
  }
  // Highest zOrder at the top (frontmost). Stable tie-break by trackId so the
  // order is deterministic when two placements share a zOrder (e.g. right after
  // a legacy canonical migration, before the user reorders).
  placed.sort((a, b) => {
    const dz = (b.placement.zOrder ?? 0) - (a.placement.zOrder ?? 0)
    if (dz !== 0) return dz
    return a.track.id - b.track.id
  })
  return { placed, unplaced }
}

function gridZOrders(layout) {
  return (layout?.slots ?? []).map(s => s.zOrder ?? 0)
}

/**
 * The next free main grid cell in row-major order, as fine-grid coordinates for
 * a full-cell placement. Falls back to (0,0) when the grid is full (overlap is
 * allowed — the free-canvas model — and the user fine-tunes via the overlay).
 */
export function nextFreeCell(layout) {
  const cols = layout?.columns ?? 3
  const rows = layout?.rows ?? 3
  const occupied = new Set()
  for (const s of layout?.slots ?? []) {
    const c = Math.floor((s.gridX ?? 0) / SUB_UNITS_PER_COLUMN)
    const r = Math.floor((s.gridY ?? 0) / SUB_UNITS_PER_ROW)
    occupied.add(`${c},${r}`)
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!occupied.has(`${c},${r}`)) {
        return {
          col: c, row: r,
          gridX: c * SUB_UNITS_PER_COLUMN, gridY: r * SUB_UNITS_PER_ROW,
          spanX: SUB_UNITS_PER_COLUMN, spanY: SUB_UNITS_PER_ROW,
        }
      }
    }
  }
  return { col: 0, row: 0, gridX: 0, gridY: 0, spanX: SUB_UNITS_PER_COLUMN, spanY: SUB_UNITS_PER_ROW }
}

/**
 * Given the new top-to-bottom ordering of the PLACED tracks (frontmost first),
 * assign fresh descending zOrder integers (top = N-1 … bottom = 0) and return
 * only the tracks whose value actually changed. Pure + unit-testable; the
 * caller commits each via setPlacementZOrder.
 * @returns {Array<{trackId:number, zOrder:number}>}
 */
export function computeReorderCommits(orderedTrackIds, layout) {
  const n = orderedTrackIds.length
  const commits = []
  for (let i = 0; i < n; i++) {
    const trackId = orderedTrackIds[i]
    const newZ = n - 1 - i          // top of the list (i=0) is frontmost → highest z
    const cur = getTrackPlacement(trackId, layout).zOrder
    if (cur !== newZ) commits.push({ trackId, zOrder: newZ })
  }
  return commits
}

// ── Mutating actions (IPC + event notify) ────────────────────────────────────
// Each is self-contained: it performs the write and broadcasts the relevant
// timeline events so every mounted view (Audio list, Video list, grid overlay,
// Track Detail) re-fetches. None of them ever calls setTrackOrder.

/** Place an unplaced track in the next free grid cell, landing on top. */
export async function assignTrackToGrid(track, layout) {
  const cell = nextFreeCell(layout)
  const zs = gridZOrders(layout)
  const newZ = (zs.length ? Math.max(...zs) : 0) + 1
  try {
    await window.xleth?.timeline?.assignTrackToGridWithZOrder(
      track.id, cell.gridX, cell.gridY, cell.spanX, cell.spanY, newZ)
    console.log(`[VideoTabList] assign-to-grid track ${track.id} → cell (${cell.col},${cell.row}) zOrder=${newZ}`)
    notifyGrid(); notifyTracks()
  } catch (e) {
    console.error('[VideoTabList] assignTrackToGrid failed:', e)
  }
}

/**
 * Add a track to fullscreenLayers. Always starts as 'behind' (hold-through-gap
 * backdrop is the overwhelmingly common case for this genre) with an initial
 * zOrder one above the current grid stack — immediately visible up front so
 * the user can confirm placement, then freely draggable anywhere afterward
 * (including behind everything) without that drag touching this `placement`
 * flag. Ongoing Behind/Front changes live in the Track Detail view instead
 * (see setFullscreenPlacementMode) — this is a one-time creation default only.
 */
export async function makeTrackFullscreen(track, layout) {
  const zs = gridZOrders(layout)
  const startZ = (zs.length ? Math.max(...zs) : 0) + 1
  // Guard against a stray duplicate entry for this track, then append.
  const next = [
    ...(layout?.fullscreenLayers ?? []).filter(l => l.trackId !== track.id),
    { trackId: track.id, placement: 'behind', opacity: 1.0, zOrder: startZ },
  ]
  try {
    await window.xleth?.timeline?.setFullscreenLayers(next)
    console.log(`[VideoTabList] make-fullscreen track ${track.id} placement=behind zOrder=${startZ}`)
    notifyGrid(); notifyTracks()
  } catch (e) {
    console.error('[VideoTabList] makeTrackFullscreen failed:', e)
  }
}

/**
 * Flip an already-fullscreen track's Behind/Front hold-through-gap semantic
 * in place. Edits ONLY the `placement` field — zOrder/position is untouched,
 * so this never interferes with where the track currently sits in the stack.
 * Used by the Track Detail view's Behind/Front toggle (never the context menu
 * — that's a one-time creation default via makeTrackFullscreen).
 */
export async function setFullscreenPlacementMode(track, layout, placement) {
  const next = (layout?.fullscreenLayers ?? []).map(l =>
    l.trackId === track.id ? { ...l, placement } : l)
  try {
    await window.xleth?.timeline?.setFullscreenLayers(next)
    console.log(`[TrackVideoProperties] track ${track.id} fullscreen placement → ${placement}`)
    notifyGrid(); notifyTracks()
  } catch (e) {
    console.error('[TrackVideoProperties] setFullscreenPlacementMode failed:', e)
  }
}

/**
 * Convert a grid-slotted track to a fullscreen layer, preserving its current
 * zOrder exactly — only what KIND of placement it has changes, not its
 * position in the stack. Defaults to 'behind' (see makeTrackFullscreen).
 */
export async function convertToFullscreen(track, layout) {
  const slot = (layout?.slots ?? []).find(s => s.trackId === track.id)
  if (!slot) return
  const zOrder = slot.zOrder ?? 0
  try {
    await window.xleth?.timeline?.removeTrackFromGrid(track.id)
    const next = [
      ...(layout?.fullscreenLayers ?? []).filter(l => l.trackId !== track.id),
      { trackId: track.id, placement: 'behind', opacity: 1.0, zOrder },
    ]
    await window.xleth?.timeline?.setFullscreenLayers(next)
    console.log(`[VideoTabList] convert-to-fullscreen track ${track.id} zOrder=${zOrder} (preserved)`)
    notifyGrid(); notifyTracks()
  } catch (e) {
    console.error('[VideoTabList] convertToFullscreen failed:', e)
  }
}

/**
 * Convert a fullscreen track to a grid cell, preserving its current zOrder
 * exactly. Uses the same next-free-cell logic as assignTrackToGrid.
 */
export async function convertToGridCell(track, layout) {
  const fs = (layout?.fullscreenLayers ?? []).find(l => l.trackId === track.id)
  if (!fs) return
  const zOrder = fs.zOrder ?? 0
  const cell = nextFreeCell(layout)
  try {
    const next = (layout?.fullscreenLayers ?? []).filter(l => l.trackId !== track.id)
    await window.xleth?.timeline?.setFullscreenLayers(next)
    await window.xleth?.timeline?.assignTrackToGridWithZOrder(
      track.id, cell.gridX, cell.gridY, cell.spanX, cell.spanY, zOrder)
    console.log(`[VideoTabList] convert-to-grid track ${track.id} → cell (${cell.col},${cell.row}) zOrder=${zOrder} (preserved)`)
    notifyGrid(); notifyTracks()
  } catch (e) {
    console.error('[VideoTabList] convertToGridCell failed:', e)
  }
}

/** Remove a track from whichever placement array holds it — it stops rendering. */
export async function unplaceTrack(track, layout) {
  const p = getTrackPlacement(track.id, layout)
  try {
    if (p.kind === 'grid') {
      await window.xleth?.timeline?.removeTrackFromGrid(track.id)
      console.log(`[VideoTabList] unplace track ${track.id} (from grid)`)
    } else if (p.kind === 'behind' || p.kind === 'front') {
      const next = (layout?.fullscreenLayers ?? []).filter(l => l.trackId !== track.id)
      await window.xleth?.timeline?.setFullscreenLayers(next)
      console.log(`[VideoTabList] unplace track ${track.id} (from fullscreen)`)
    } else {
      return
    }
    notifyGrid(); notifyTracks()
  } catch (e) {
    console.error('[VideoTabList] unplaceTrack failed:', e)
  }
}

/**
 * Commit a drag-reorder: write fresh zOrder integers via setPlacementZOrder,
 * once per track whose value actually changed. Never calls setTrackOrder.
 */
export async function commitReorder(orderedTrackIds, layout) {
  const commits = computeReorderCommits(orderedTrackIds, layout)
  if (commits.length === 0) {
    console.log('[VideoTabList] reorder committed: no zOrder changes')
    return
  }
  try {
    for (const { trackId, zOrder } of commits) {
      await window.xleth?.timeline?.setPlacementZOrder(trackId, zOrder)
      console.log(`[VideoTabList] setPlacementZOrder(track ${trackId}, z=${zOrder})`)
    }
    notifyGrid()
  } catch (e) {
    console.error('[VideoTabList] commitReorder failed:', e)
  }
}

/**
 * Placement-mode menu items for a track. Video-tab context menu ONLY — the
 * Audio-tab track menu never shows these (see TimelineView.jsx's
 * buildTrackMenuItems, which intentionally omits them). Mode changes only
 * (which array the track lives in, and for grid<->fullscreen conversions,
 * preserving zOrder across the switch) — these are deliberately explicit and
 * separate from drag-reorder.
 */
export function buildPlacementMenuItems(track, layout) {
  const p = getTrackPlacement(track.id, layout)
  if (p.kind === 'unplaced') {
    return [
      { label: 'Assign to Grid Cell', onClick: () => assignTrackToGrid(track, layout) },
      { label: 'Make Fullscreen', onClick: () => makeTrackFullscreen(track, layout) },
    ]
  }
  const items = p.kind === 'grid'
    ? [{ label: 'Convert to Fullscreen', onClick: () => convertToFullscreen(track, layout) }]
    : [{ label: 'Convert to Grid Cell', onClick: () => convertToGridCell(track, layout) }]
  items.push({ label: 'Remove from Video (Unplace)', danger: true, onClick: () => unplaceTrack(track, layout) })
  return items
}

/** Human-readable badge label for a placement (for the list row + Track Detail). */
export function placementBadgeLabel(placement) {
  if (placement?.kind === 'behind' || placement?.kind === 'front') return 'Fullscreen'
  switch (placement?.kind) {
    case 'grid':  return `Grid ${placement.cell?.col ?? 0},${placement.cell?.row ?? 0}`
    case 'behind': return 'Fullscreen — Behind'
    case 'front':  return 'Fullscreen — Front'
    default:       return 'Unplaced'
  }
}
