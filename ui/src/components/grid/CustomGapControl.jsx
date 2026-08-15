import { snapToZero, quantizedFromNorm } from '../../utils/sliderHelpers.js'
import Fader from '../controls/Fader.jsx'

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
        // Wrapped (rather than styling Fader's own root) so the existing
        // .grid-tab-gap-slider layout rules — grid-column span in the flat
        // grid variant, flex `order` in the Track Detail (.tvp-root) variant
        // — still apply; Fader has no className passthrough.
        <div className="grid-tab-gap-slider">
          <Fader
            orientation="horizontal" fill thickness={14}
            value={track.gapScaleOverride ?? 0} min={0} max={0.5} defaultValue={0}
            fromNorm={quantizedFromNorm(0, 0.5, 0.01)}
            onCommit={async (v) => {
              await window.xleth?.timeline?.setTrackGapScaleOverride(track.id, snapToZero(v))
              fetchTracks()
            }}
          />
        </div>
      ) : (
        <div className="grid-tab-gap-hint">
          using global: {Math.round((gapScale ?? 0) * 100)}%
        </div>
      )}
    </div>
  )
}
