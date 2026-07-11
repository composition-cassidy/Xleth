import { create } from 'zustand'

/**
 * Coordinates the Timeline panel's Audio/Video tabs and the Video tab's
 * internal Overview ⇄ Track Detail mode.
 *
 * `activeTab` used to be local state in TimelinePanel.tsx; it lives here so the
 * track right-click menu (built in TimelineView, a child of the Audio tab) can
 * switch to the Video tab and open a specific track's detail view in one call —
 * without prop-drilling through the windowing layer.
 *
 * `selectedTrackId` is the sole driver of the Video tab's mode:
 *   null  → Overview (grid layout / fullscreen layers)
 *   <id>  → Track Detail (per-track video properties)
 */
const useVideoTabStore = create((set) => ({
  activeTab: 'audio',
  setActiveTab: (tab) => set({ activeTab: tab }),

  selectedTrackId: null,
  setSelectedTrackId: (id) => set({ selectedTrackId: id }),

  // One-shot from the track context menu: jump to the Video tab AND open the
  // given track's detail view.
  openTrackVideoProperties: (trackId) =>
    set({ activeTab: 'video', selectedTrackId: trackId }),

  // Back/breadcrumb control in Track Detail returns to Overview.
  clearSelectedTrack: () => set({ selectedTrackId: null }),
}))

export default useVideoTabStore
