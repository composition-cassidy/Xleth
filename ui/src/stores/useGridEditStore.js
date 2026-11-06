import { create } from 'zustand'

// Preview "Edit Grid" mode. `snapEnabled` lives here (not in the overlay) so the
// Edit Grid toolbar row can show and change it; `stripView` picks what the strip
// under the picture shows: tracks to place, or the layer (compositing) order.
const useGridEditStore = create((set) => ({
  gridEditMode: false,
  setGridEditMode: (value) => set({ gridEditMode: value }),
  toggleGridEditMode: () => set((state) => ({ gridEditMode: !state.gridEditMode })),

  snapEnabled: true,
  setSnapEnabled: (value) => set({ snapEnabled: value }),

  stripView: 'place',
  setStripView: (value) => set({ stripView: value }),
}))

export default useGridEditStore
