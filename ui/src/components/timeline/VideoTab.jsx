import useVideoTabStore from '../../stores/useVideoTabStore.js'
import VideoOverviewTab from './VideoOverviewTab.jsx'
import TrackVideoProperties from './TrackVideoProperties.jsx'

/**
 * Video tab container. Owns the Overview ⇄ Track Detail mode switch, driven
 * entirely by `selectedTrackId` in useVideoTabStore:
 *   null  → Overview (grid layout, gap, fullscreen layers)  [Phase 1]
 *   <id>  → Track Detail (per-track video properties)        [this phase]
 */
export default function VideoTab() {
  const selectedTrackId  = useVideoTabStore((s) => s.selectedTrackId)
  const clearSelectedTrack = useVideoTabStore((s) => s.clearSelectedTrack)

  if (selectedTrackId != null) {
    return (
      <TrackVideoProperties
        trackId={selectedTrackId}
        onBack={clearSelectedTrack}
      />
    )
  }
  return <VideoOverviewTab />
}
