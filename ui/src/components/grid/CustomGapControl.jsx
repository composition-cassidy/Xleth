import { snapToZero } from '../../utils/sliderHelpers.js'

export default function CustomGapControl({ track, gapScale, fetchTracks }) {
  const hasOverride = (track.gapScaleOverride ?? -1) >= 0
  const displayPct  = hasOverride
    ? Math.round((track.gapScaleOverride ?? 0) * 100)
    : Math.round((gapScale ?? 0) * 100)

  return (
    <div className="grid-tab-gap-row">
      <div className="grid-tab-gap-header">
        <label className="grid-tab-gap-label">
          <input
            type="checkbox"
            checked={hasOverride}
            onChange={async (e) => {
              const v = e.target.checked ? (gapScale ?? 0) : -1
              await window.xleth?.timeline?.setTrackGapScaleOverride(track.id, v)
              fetchTracks()
            }}
          />
          {' '}custom gap
        </label>
        <span className="grid-tab-gap-readout">{displayPct}%</span>
      </div>
      {hasOverride ? (
        <input
          className="grid-tab-gap-slider"
          type="range" min={0} max={0.5} step={0.01}
          defaultValue={track.gapScaleOverride ?? 0}
          onPointerUp={async (e) => {
            const v = snapToZero(parseFloat(e.target.value))
            await window.xleth?.timeline?.setTrackGapScaleOverride(track.id, v)
            fetchTracks()
          }}
        />
      ) : (
        <div className="grid-tab-gap-hint">
          using global: {Math.round((gapScale ?? 0) * 100)}%
        </div>
      )}
    </div>
  )
}
