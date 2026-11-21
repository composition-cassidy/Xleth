import { create } from 'zustand'

// Session-only view state for devices, keyed by `${storeKey}:${nodeId}`. Nothing
// here reaches the engine or the project file: fold, the display view and folded
// sections are how this user is looking at a device, not what it does.

const useDeviceUiStore = create((set) => ({
  folded: {},
  views: {},
  sections: {},

  setFolded: (key, folded) => set((s) => ({ folded: { ...s.folded, [key]: !!folded } })),
  setView: (key, view) => set((s) => ({ views: { ...s.views, [key]: view } })),
  setSectionFolded: (key, section, folded) => set((s) => ({
    sections: { ...s.sections, [`${key}:${section}`]: !!folded },
  })),
}))

export const deviceKey = (storeKey, nodeId) => `${storeKey}:${nodeId}`

export default useDeviceUiStore
