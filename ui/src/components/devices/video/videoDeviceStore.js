import { create } from 'zustand'

// Session-only view state for the Video side of the Devices tab. Nothing here
// reaches the engine or the project file.
//
//   view    — which chain the Devices tab shows: 'audio' (the insert chain) or 'video'
//   shown   — per track, the per-note devices added this session but currently off,
//             so turning one off with its activator does not make it vanish
//   window  — the one popped-out video device { trackId, kind, key } or null.
//             A device is never live twice: while it is in the window, its docked
//             slot is a strip with a return button.

const useVideoDeviceStore = create((set) => ({
  view: 'audio',
  shown: {},
  window: null,

  setView: (view) => set((s) => (s.view === view ? s : { view })),
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
