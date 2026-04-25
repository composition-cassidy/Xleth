import { create } from 'zustand'

const useGridEditStore = create((set) => ({
  gridEditMode: false,
  setGridEditMode: (value) => set({ gridEditMode: value }),
  toggleGridEditMode: () => set((state) => ({ gridEditMode: !state.gridEditMode })),
}))

export default useGridEditStore
