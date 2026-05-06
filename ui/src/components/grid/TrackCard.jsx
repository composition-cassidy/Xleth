import TrackCardHeader from './TrackCardHeader.jsx'
import CornerRadiusControl from './CornerRadiusControl.jsx'
import CustomGapControl from './CustomGapControl.jsx'
import VisualFXSection from './VisualFXSection.jsx'
import SlideNoteEffectSection from './SlideNoteEffectSection.jsx'

export default function TrackCard({ track, slot, badges, gapScale, fetchTracks, applyCornerRadiusToAll, compact = false }) {
  return (
    <div className="grid-tab-track-item">
      <TrackCardHeader track={track} slot={slot} badges={badges} fetchTracks={fetchTracks} />
      {!compact && (
        <div className="grid-tab-track-sliders">
          <CornerRadiusControl
            track={track}
            fetchTracks={fetchTracks}
            applyCornerRadiusToAll={applyCornerRadiusToAll}
          />
          <CustomGapControl
            track={track}
            gapScale={gapScale}
            fetchTracks={fetchTracks}
          />
        </div>
      )}
      {!compact && <VisualFXSection track={track} fetchTracks={fetchTracks} />}
      {!compact && track.type === 'Pattern' && (
        <SlideNoteEffectSection track={track} fetchTracks={fetchTracks} />
      )}
    </div>
  )
}
