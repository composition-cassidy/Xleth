import { create } from 'zustand'

// Pattern-note selection, shared by the Piano Roll and the Reel lane.
//
// The Piano Roll keeps its selection as local React state (a Set of note ids for
// the ONE pattern it shows). The Reel lane lives in the arrangement and can show
// notes of several patterns at once. Note ids are only unique inside one pattern
// (audit answer 5), so the shared selection is keyed {patternId -> Set(noteId)}.
//
// Both sides publish here and mirror from here (PianoRoll.jsx, TimelineCanvas.jsx),
// which is what makes the selection sync both ways. Each side only writes when its
// set differs from the store's, so the mirror never loops.
//
// Selection is view state, not project state: nothing here is undoable and nothing
// crosses the bridge.

const EMPTY = Object.freeze({})

export function sameIdSet(a, b) {
  if (a === b) return true
  const sa = a?.size ?? 0
  const sb = b?.size ?? 0
  if (sa !== sb) return false
  if (sa === 0) return true
  for (const id of a) if (!b.has(id)) return false
  return true
}

function sameSelection(a, b) {
  if (a === b) return true
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!sameIdSet(a[k], b[k])) return false
  return true
}

function normalised(byPattern) {
  const out = {}
  for (const k of Object.keys(byPattern)) {
    const set = byPattern[k]
    if (set && set.size > 0) out[k] = set
  }
  return Object.keys(out).length === 0 ? EMPTY : out
}

const useNoteSelectionStore = create((set, get) => ({
  /** { [patternId]: Set<noteId> }; patterns with nothing selected are absent. */
  byPattern: EMPTY,

  // The Piano Roll's selection (one pattern): replaces the whole selection, so a
  // click in the roll never leaves a stale clip highlighted in another pattern.
  // An empty set only clears THAT pattern, so merely opening the roll on a pattern
  // does not wipe a selection made in the lane on another one.
  setPatternSelection(patternId, ids) {
    const current = get().byPattern
    const next = new Set(ids)
    if (next.size === 0) {
      if (!current[patternId]) return
      const { [patternId]: _gone, ...rest } = current
      set({ byPattern: normalised(rest) })
      return
    }
    // Echoing back what the store already holds for this pattern (the roll just
    // mirrored it) must not drop the other patterns' clips from a multi-select.
    if (sameIdSet(current[patternId], next)) return
    set({ byPattern: { [patternId]: next } })
  },

  // The lane's plain click: exactly this note.
  selectOnly(patternId, noteId) {
    const current = get().byPattern
    const next = { [patternId]: new Set([noteId]) }
    if (sameSelection(current, next)) return
    set({ byPattern: next })
  },

  // The lane's Ctrl/Shift click: add the note, or drop it if it is already in.
  toggle(patternId, noteId) {
    const current = get().byPattern
    const ids = new Set(current[patternId] ?? [])
    if (ids.has(noteId)) ids.delete(noteId)
    else ids.add(noteId)
    set({ byPattern: normalised({ ...current, [patternId]: ids }) })
  },

  clear() {
    if (get().byPattern === EMPTY) return
    set({ byPattern: EMPTY })
  },
}))

export default useNoteSelectionStore
