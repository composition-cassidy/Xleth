import { create } from 'zustand'

// Session-only view state for the Video side of the Devices tab. Nothing here
// reaches the engine or the project file.
//
//   view    — which lane the Devices tab was last asked to bring into view: 'audio' or 'video'
//             (both lanes are always shown; viewNonce bumps on every ask, so asking twice scrolls twice)
//   shown   — per track, the per-note devices added this session but currently off,
//             so turning one off with its activator does not make it vanish
//   window  — the one popped-out video device { trackId, kind, key } or null.
//             A device is never live twice: while it is in the window, its docked
//             slot is a strip with a return button.

const useVideoDeviceStore = create((set) => ({
  view: 'audio',
  viewNonce: 0,
  shown: {},
  window: null,

  setView: (view) => set((s) => ({ view, viewNonce: s.viewNonce + 1 })),
  showNoteDevice: (trackId, id) => set((s) => {
    const list = s.shown[trackId] ?? []
    return list.includes(id) ? s : { shown: { ...s.shown, [trackId]: [...list, id] } }
  }),
  hideNoteDevice: (trackId, id) => set((s) => ({
    shown: { ...s.shown, [trackId]: (s.shown[trackId] ?? []).filter((x) => x !== id) },
  })),
  openWindow: (win) => set({ window: win }),
  closeWindow: () => set({ window: null }),
}))

export const isInWindow = (win, trackId, kind, key) => (
  win != null && win.trackId === trackId && win.kind === kind && win.key === key
)

export default useVideoDeviceStore
