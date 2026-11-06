import { create } from 'zustand'
import { usePanelRegistry } from '../windowing/registry/PanelRegistry.ts'

/**
 * What the Inspector shows. The arrangement owns selection (TimelineView keeps
 * it as local state for its canvas tools); it publishes the result here so the
 * Inspector, which lives in another panel, can follow it.
 *
 *   selection: null
 *            | { kind: 'track', trackId }
 *            | { kind: 'clip', clipId, trackId }
 *            | { kind: 'multi', noun, count }      several clips / tracks / blocks
 *            | { kind: 'blocks', count }           pattern blocks (no properties yet)
 *
 *   clip:        { clip, region, source, track } for a single selected clip, kept
 *                fresh by TimelineView on every clip refresh.
 *   clipActions: the arrangement's own clip setters (same RPCs the clip menu
 *                used; each pushes its own engine undo entry).
 *
 * Callers outside the arrangement (the Preview's layer list, the track menu)
 * use requestTrackSelection(): the arrangement applies it to its own selection
 * so the highlighted track header and the Inspector never disagree.
 */
function sameSelection(a, b) {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind) return false
  return a.trackId === b.trackId && a.clipId === b.clipId && a.count === b.count && a.noun === b.noun
}

const useInspectorStore = create((set, get) => ({
  selection: null,
  clip: null,
  clipActions: null,
  trackSelectRequest: null,

  setSelection: (selection) => {
    if (sameSelection(get().selection, selection)) return
    console.log('[Arrange] inspector selection →', selection ? JSON.stringify(selection) : 'none')
    set({ selection })
  },
  setClipContext: (clip) => set({ clip }),
  setClipActions: (clipActions) => set({ clipActions }),

  requestTrackSelection: (trackId) => set((state) => ({
    selection: { kind: 'track', trackId },
    trackSelectRequest: { trackId, seq: (state.trackSelectRequest?.seq ?? 0) + 1 },
  })),
}))

/** Show the Inspector panel (opens or expands it, and focuses it). */
export function revealInspector() {
  usePanelRegistry.getState().openPanel('inspector')
}

/**
 * Pure: derive the Inspector selection from the arrangement's selection sets.
 * Whichever set the user changed last wins; with no change information the
 * order is clips, blocks, tracks.
 */
export function deriveInspectorSelection({ clipIds, blockIds, trackIds, changed = null, trackIdOfClip = () => null }) {
  const single = (set) => (set && set.size === 1 ? [...set][0] : null)
  const fromClips = () => {
    if (!clipIds?.size) return null
    if (clipIds.size > 1) return { kind: 'multi', noun: 'clips', count: clipIds.size }
    const clipId = single(clipIds)
    return { kind: 'clip', clipId, trackId: trackIdOfClip(clipId) }
  }
  const fromBlocks = () => (blockIds?.size ? { kind: 'blocks', count: blockIds.size } : null)
  const fromTracks = () => {
    if (!trackIds?.size) return null
    if (trackIds.size > 1) return { kind: 'multi', noun: 'tracks', count: trackIds.size }
    return { kind: 'track', trackId: single(trackIds) }
  }
  const order = changed === 'tracks' ? [fromTracks, fromClips, fromBlocks]
    : changed === 'blocks' ? [fromBlocks, fromClips, fromTracks]
    : [fromClips, fromBlocks, fromTracks]
  for (const pick of order) {
    const sel = pick()
    if (sel) return sel
  }
  return null
}

export default useInspectorStore
