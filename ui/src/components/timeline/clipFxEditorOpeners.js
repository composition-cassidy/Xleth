// Shared clip-FX editor opening / orphan-closing logic.
//
// The clip-identity twin of components/mixer/effectEditorOpeners.js. Where that
// module addresses effects by (trackId, engineNodeId, storeKey), these editors
// address a timeline clip by `{ clipId }` — but the ownership rules are the
// same: callers only *request* an editor, the stores hold identity, and
// ClipFxEditorHost owns mounting.
//
// Keep CLIP_FX_EDITOR_STORES in lockstep with CLIP_FX_EDITORS.

import useClipVibratoEditorStore from '../../stores/clipVibratoEditorStore.js'
import useClipScratchEditorStore from '../../stores/clipScratchEditorStore.js'

// Registry: editor kind -> opener(clipId).
export const CLIP_FX_EDITORS = {
  vibrato: (clipId) => { useClipVibratoEditorStore.getState().open(clipId) },
  scratch: (clipId) => { useClipScratchEditorStore.getState().open(clipId) },
}

// Every clip-FX editor store shares the `{ target: { clipId } | null }` shape
// with open()/close(), so orphan handling can be written once over the list.
const CLIP_FX_EDITOR_STORES = [
  useClipVibratoEditorStore,
  useClipScratchEditorStore,
]

// Open a clip-FX editor. Returns { ok: true, kind } or { ok: false, reason }.
export function openClipFxEditor(kind, clipId) {
  const opener = CLIP_FX_EDITORS[kind]
  if (!opener) return { ok: false, reason: 'unknown_editor' }
  const id = Number(clipId)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: 'clip_unresolved' }
  opener(id)
  return { ok: true, kind }
}

// Close any open clip-FX editor targeting `clipId`. Called after a clip is
// deleted so its now-orphaned editor does not linger addressing a dead clip.
// Returns true if a panel was closed.
export function closeClipFxEditorForClip(clipId) {
  const id = Number(clipId)
  let closed = false
  for (const store of CLIP_FX_EDITOR_STORES) {
    const target = store.getState().target
    if (target && target.clipId === id) { store.getState().close(); closed = true }
  }
  return closed
}

// Close every open clip-FX editor. Used on project load, where clip ids are
// reassigned wholesale and any open panel would address a stale clip.
export function closeAllClipFxEditors() {
  for (const store of CLIP_FX_EDITOR_STORES) {
    if (store.getState().target) store.getState().close()
  }
}

// Reconcile every open clip-FX editor against the live clip list.
//
// This is the belt to closeClipFxEditorForClip's braces. Clips disappear down
// many routes — the delete tool, batch keyboard delete, split (remove + re-add
// under NEW ids), bulk ops, and region deletes that cascade — so rather than
// patching each call site, TimelineView calls this from fetchClips(), the one
// funnel every one of those paths already flows through.
//
// An empty/absent list is treated as "engine not ready", never as "everything
// was deleted".
export function reconcileClipFxEditors(clips) {
  if (!Array.isArray(clips) || clips.length === 0) return false
  const live = new Set(clips.map(c => c?.id))
  let closed = false
  for (const store of CLIP_FX_EDITOR_STORES) {
    const target = store.getState().target
    if (target && !live.has(target.clipId)) { store.getState().close(); closed = true }
  }
  return closed
}
