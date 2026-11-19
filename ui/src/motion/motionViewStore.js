import { create } from 'zustand'
import { DEFAULT_TRACK_HEIGHT, clampTrackHeight } from '../constants/timeline.js'

// Motion view: the session and view state shared by the Motion view, the
// timeline toolbar switch and the viewer overlay (docs/XLETH_MOTION_VIEW_DESIGN.md
// 2.3, R19, R20, R24). Not named motionStore: stores/motionStore.js is the UI
// animation tier.
//
// Two kinds of state live here:
//   * View state saved WITH THE PROJECT (R19), through toState() / loadState():
//     the last view, graph on/off, per-view track heights and vertical scroll,
//     the Motion header width and the expanded rows. Not undoable, never marks the
//     project dirty; motionViewPersistence.js pushes it to the engine.
//   * Session state that is never saved: the focused and selected rows, the key
//     selection, a gesture's draft, the key clipboard, the selected mask and the
//     pen tool.
// Nothing here is engine data: keys, masks and parents live in the engine and
// every edit of them is an UndoManager command (motionPlan.js). `draft` is a
// gesture's local preview: while it is non-null a drag is in progress, nothing
// is sent to the engine and the persistence push waits.
//
// Row keys (5.3): 't:<id>', 't:<id>/lens' ('t:<id>/lens:<regionId>' with several
// sources), 't:<id>/roam', 't:<id>/roam/masks', 't:<id>/mask:<maskId>',
// 't:<id>/sweep'; a property row appends '/<propId>' ('t:12/roam/roam.offsetX').

export const MOTION_VIEW_STATE_VERSION = 1
export const VIEWS = Object.freeze(['edit', 'motion'])

// Motion view track row: 28 px default, 24..96 (5.3); group and property rows are 24 px.
export const MOTION_TRACK_ROW_DEFAULT = 28
export const MOTION_TRACK_ROW_MIN = 24
export const MOTION_TRACK_ROW_MAX = 96
export const MOTION_HEADER_DEFAULT = 360
export const MOTION_HEADER_MIN = 240
export const MOTION_HEADER_MAX = 720
/** Expanded row keys kept in the saved state (the engine caps the object at 256 KB). */
export const MAX_SAVED_EXPANDED = 4096
const MAX_ROW_KEY_LENGTH = 256

const fin = (v) => typeof v === 'number' && Number.isFinite(v)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

export const clampMotionTrackRowHeight = (h) => (fin(h) ? clamp(Math.round(h), MOTION_TRACK_ROW_MIN, MOTION_TRACK_ROW_MAX) : MOTION_TRACK_ROW_DEFAULT)
export const clampMotionHeaderWidth = (w) => (fin(w) ? clamp(Math.round(w), MOTION_HEADER_MIN, MOTION_HEADER_MAX) : MOTION_HEADER_DEFAULT)
const clampScroll = (y) => (fin(y) && y > 0 ? Math.round(y) : 0)
const isRowKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= MAX_ROW_KEY_LENGTH

/** The saved part of the state at its defaults (what a project without Motion view state loads). */
export function defaultViewState() {
  return {
    view: 'edit',
    graph: false,
    edit: { trackHeight: DEFAULT_TRACK_HEIGHT, scrollY: 0 },
    motion: { trackRowHeight: MOTION_TRACK_ROW_DEFAULT, scrollY: 0, headerWidth: MOTION_HEADER_DEFAULT },
    expanded: new Set(),
  }
}

function sessionDefaults() {
  return {
    focusedRow: null,
    selectedRows: new Set(),
    keySel: new Map(),
    draft: null,
    selectedMask: null,
    penTool: null,
  }
}

/** Every ancestor row key of a row key, outermost first: 't:1/roam/masks' -> ['t:1', 't:1/roam']. */
export function ancestorRowKeys(rowKey) {
  const parts = String(rowKey).split('/')
  const out = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

/** The track id a row key belongs to ('t:12/roam' -> 12), else null. */
export function trackIdOfRowKey(rowKey) {
  const m = /^t:(-?\d+)(?:\/|$)/.exec(String(rowKey))
  return m ? Number(m[1]) : null
}

/**
 * The saved shape (2.3), versioned:
 *   { v: 1, view, graph, edit: { trackHeight, scrollY },
 *     motion: { trackRowHeight, scrollY, headerWidth, expanded: [rowKey...] } }
 */
export function serializeViewState(s) {
  return {
    v: MOTION_VIEW_STATE_VERSION,
    view: s.view,
    graph: !!s.graph,
    edit: { trackHeight: s.edit.trackHeight, scrollY: s.edit.scrollY },
    motion: {
      trackRowHeight: s.motion.trackRowHeight,
      scrollY: s.motion.scrollY,
      headerWidth: s.motion.headerWidth,
      expanded: [...s.expanded].slice(0, MAX_SAVED_EXPANDED),
    },
  }
}

/**
 * A saved object read TOLERANTLY: anything missing, of the wrong type or out of
 * range takes its default; unknown fields are ignored; a newer `v` is read for
 * the fields this build knows. Never throws.
 */
export function parseViewState(json) {
  const d = defaultViewState()
  if (!json || typeof json !== 'object' || Array.isArray(json)) return d
  const edit = json.edit && typeof json.edit === 'object' ? json.edit : {}
  const motion = json.motion && typeof json.motion === 'object' ? json.motion : {}
  const expanded = Array.isArray(motion.expanded) ? motion.expanded : Array.isArray(json.expanded) ? json.expanded : []
  return {
    view: VIEWS.includes(json.view) ? json.view : d.view,
    graph: typeof json.graph === 'boolean' ? json.graph : d.graph,
    edit: {
      trackHeight: fin(edit.trackHeight) ? clampTrackHeight(edit.trackHeight) : d.edit.trackHeight,
      scrollY: clampScroll(edit.scrollY),
    },
    motion: {
      trackRowHeight: fin(motion.trackRowHeight) ? clampMotionTrackRowHeight(motion.trackRowHeight) : d.motion.trackRowHeight,
      scrollY: clampScroll(motion.scrollY),
      headerWidth: fin(motion.headerWidth) ? clampMotionHeaderWidth(motion.headerWidth) : d.motion.headerWidth,
    },
    expanded: new Set(expanded.filter(isRowKey).slice(0, MAX_SAVED_EXPANDED)),
  }
}

/**
 * True when a serialized state says Motion view was never used, so nothing is
 * saved (R16 byte identity wins over R19): the Edit view is showing, the graph
 * is off, nothing is expanded and the motion block is at its defaults. The edit
 * block (Edit view track height / scroll) is ignored, so an old project that was
 * only scrolled or zoomed in the Edit view still saves byte-identically.
 */
export function isDefaultViewState(saved) {
  if (!saved || typeof saved !== 'object') return true
  const d = serializeViewState(defaultViewState())
  const m = saved.motion ?? {}
  return saved.view === d.view
    && saved.graph === d.graph
    && m.trackRowHeight === d.motion.trackRowHeight
    && m.scrollY === d.motion.scrollY
    && m.headerWidth === d.motion.headerWidth
    && (m.expanded === undefined || (Array.isArray(m.expanded) && m.expanded.length === 0))
}

const setOf = (iter) => new Set(iter ?? [])

export const useMotionViewStore = create((set, get) => ({
  ...defaultViewState(),
  ...sessionDefaults(),
  /** The key clipboard (R23): whatever motionClipboard.js copied, or null. Kept across projects. */
  clipboard: null,

  // ── View and graph (R20) ────────────────────────────────────────────────
  setView(view) {
    if (!VIEWS.includes(view) || get().view === view) return
    set({ view })
  },
  toggleView() {
    set({ view: get().view === 'motion' ? 'edit' : 'motion' })
  },
  setGraph(graph) {
    if (get().graph === !!graph) return
    set({ graph: !!graph })
  },
  toggleGraph() {
    set({ graph: !get().graph })
  },

  // ── Per-view heights, scroll, header width (R19) ────────────────────────
  setEditTrackHeight(h) {
    const trackHeight = clampTrackHeight(h)
    if (get().edit.trackHeight === trackHeight) return
    set({ edit: { ...get().edit, trackHeight } })
  },
  setEditScrollY(y) {
    const scrollY = clampScroll(y)
    if (get().edit.scrollY === scrollY) return
    set({ edit: { ...get().edit, scrollY } })
  },
  setMotionTrackRowHeight(h) {
    const trackRowHeight = clampMotionTrackRowHeight(h)
    if (get().motion.trackRowHeight === trackRowHeight) return
    set({ motion: { ...get().motion, trackRowHeight } })
  },
  setMotionScrollY(y) {
    const scrollY = clampScroll(y)
    if (get().motion.scrollY === scrollY) return
    set({ motion: { ...get().motion, scrollY } })
  },
  setHeaderWidth(w) {
    const headerWidth = clampMotionHeaderWidth(w)
    if (get().motion.headerWidth === headerWidth) return
    set({ motion: { ...get().motion, headerWidth } })
  },
  /** The scroll of whichever view is shown. */
  setScrollY(y) {
    if (get().view === 'motion') get().setMotionScrollY(y)
    else get().setEditScrollY(y)
  },

  // ── Expanded rows ───────────────────────────────────────────────────────
  isExpanded: (rowKey) => get().expanded.has(rowKey),
  setExpanded(rowKey, open) {
    if (!isRowKey(rowKey)) return
    const cur = get().expanded
    if (cur.has(rowKey) === !!open) return
    const next = new Set(cur)
    if (open) next.add(rowKey)
    else next.delete(rowKey)
    set({ expanded: next })
  },
  toggleExpanded(rowKey) {
    get().setExpanded(rowKey, !get().expanded.has(rowKey))
  },
  /** Expand a row and every row above it (the reveal of 5.2: 'xleth-motion-reveal'). */
  expandPath(rowKey) {
    const keys = [...ancestorRowKeys(rowKey), rowKey].filter(isRowKey)
    const cur = get().expanded
    if (keys.every((k) => cur.has(k))) return
    const next = new Set(cur)
    for (const k of keys) next.add(k)
    set({ expanded: next })
  },
  /** Collapse a row and every row under it. */
  collapseTree(rowKey) {
    const cur = get().expanded
    const prefix = `${rowKey}/`
    const next = new Set([...cur].filter((k) => k !== rowKey && !k.startsWith(prefix)))
    if (next.size !== cur.size) set({ expanded: next })
  },
  setExpandedRows(keys) {
    set({ expanded: new Set([...(keys ?? [])].filter(isRowKey)) })
  },

  // ── Rows: focus (the graph's value axis, R21) and selection ─────────────
  setFocusedRow(rowKey) {
    if (get().focusedRow === (rowKey ?? null)) return
    set({ focusedRow: rowKey ?? null })
  },
  /** mode 'replace' | 'add' (Shift) | 'toggle' (Ctrl). Focuses the row. */
  selectRow(rowKey, mode = 'replace') {
    const cur = get().selectedRows
    let next
    if (mode === 'add') next = new Set(cur).add(rowKey)
    else if (mode === 'toggle') {
      next = new Set(cur)
      if (next.has(rowKey)) next.delete(rowKey)
      else next.add(rowKey)
    } else next = new Set([rowKey])
    set({ selectedRows: next, focusedRow: rowKey })
  },
  setSelectedRows(keys) {
    set({ selectedRows: setOf(keys) })
  },
  clearRowSelection() {
    if (get().selectedRows.size) set({ selectedRows: new Set() })
  },

  // ── Key selection: keyId -> ref (the providers own both) ────────────────
  /**
   * entries: Map | [[keyId, ref]] | [{ id, ref }]. mode 'replace' | 'add' (Shift) |
   * 'toggle' (Ctrl) | 'remove'.
   */
  selectKeys(entries, mode = 'replace') {
    const list = entries instanceof Map ? [...entries] : (entries ?? []).map((e) => (Array.isArray(e) ? e : [e.id, e.ref]))
    const cur = get().keySel
    const next = mode === 'replace' ? new Map() : new Map(cur)
    for (const [id, ref] of list) {
      if (mode === 'remove') next.delete(id)
      else if (mode === 'toggle' && cur.has(id)) next.delete(id)
      else next.set(id, ref)
    }
    if (mode !== 'replace' && next.size === cur.size && [...next].every(([k, v]) => cur.get(k) === v)) return
    set({ keySel: next })
  },
  clearKeySel() {
    if (get().keySel.size) set({ keySel: new Map() })
  },
  /** Drop selected keys that no longer exist: keep only ids `alive(keyId, ref)` accepts. */
  pruneKeySel(alive) {
    const cur = get().keySel
    const next = new Map([...cur].filter(([id, ref]) => alive(id, ref)))
    if (next.size !== cur.size) set({ keySel: next })
  },

  // ── Gesture draft, clipboard, mask, pen ─────────────────────────────────
  /** A gesture's local preview (any shape the gesture owns). Non-null = a drag is in progress. */
  setDraft(draft) {
    set({ draft: draft ?? null })
  },
  clearDraft() {
    if (get().draft !== null) set({ draft: null })
  },
  setClipboard(clipboard) {
    set({ clipboard: clipboard ?? null })
  },
  /** { trackId, maskId } or null: the mask the viewer draws and edits. */
  setSelectedMask(sel) {
    const next = sel && Number.isFinite(sel.trackId) && Number.isFinite(sel.maskId) ? { trackId: sel.trackId, maskId: sel.maskId } : null
    const cur = get().selectedMask
    if (cur === next || (cur && next && cur.trackId === next.trackId && cur.maskId === next.maskId)) return
    set({ selectedMask: next })
  },
  /** The pen tool (Add mask > Path): { trackId, points: [...] } while drawing, else null. */
  setPenTool(pen) {
    set({ penTool: pen ?? null })
  },

  /**
   * Escape (R20): cancels a gesture in progress (drops its draft); with none, clears
   * the key selection. Returns what it did: 'draft' | 'selection' | null.
   */
  escape() {
    if (get().draft !== null) { set({ draft: null }); return 'draft' }
    if (get().keySel.size) { set({ keySel: new Map() }); return 'selection' }
    return null
  },

  // ── Saved state (R19) ───────────────────────────────────────────────────
  /** The project's Motion view state as the engine stores it (2.3). */
  toState() {
    return serializeViewState(get())
  },
  /**
   * Adopt a project's saved state (null / missing / malformed = defaults). The
   * session state of the previous project (row and key selection, draft, selected
   * mask, pen) is dropped; the clipboard is kept.
   */
  loadState(json) {
    set({ ...parseViewState(json), ...sessionDefaults() })
  },
  /** Back to a fresh session (tests, new project). Keeps the clipboard unless `all`. */
  reset({ all = false } = {}) {
    set({ ...defaultViewState(), ...sessionDefaults(), ...(all ? { clipboard: null } : null) })
  },
}))

/** The saved part of a store state, for subscribers: changes iff the saved JSON changes. */
export const savedSlice = (s) => [s.view, s.graph, s.edit, s.motion, s.expanded]

export default useMotionViewStore
