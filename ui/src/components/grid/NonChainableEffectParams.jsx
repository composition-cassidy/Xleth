import { snapToOne, quantizedFromNorm } from '../../utils/sliderHelpers.js'
import { BounceParamsView } from './effectParamViews.jsx'
import Fader from '../controls/Fader.jsx'
import ZprTimelineCard from './zprTimeline/ZprTimelineCard.jsx'

async function applyBounce(trackId, current, patch) {
  await window.xleth?.timeline?.setTrackBounceSettings(trackId, { ...current, ...patch })
}
async function applyZpr(trackId, current, patch) {
  await window.xleth?.timeline?.setTrackZoomPanRotSettings(trackId, { ...current, ...patch })
}
async function applyZprTracks(trackId, tracks) {
  await window.xleth?.timeline?.setTrackZprTracks(trackId, tracks)
}
async function applyPP(trackId, current, patch) {
  await window.xleth?.timeline?.setTrackPingPongSettings(trackId, { ...current, ...patch })
}

export default function NonChainableEffectParams({ kind, track, fetchTracks }) {
  if (kind === 'bounce') {
    const b = track.bounce ?? {}
    return (
      <BounceParamsView
        value={b}
        onChange={async (patch) => { await applyBounce(track.id, b, patch); fetchTracks() }}
      />
    )
  }

  if (kind === 'zoomPanRot') {
    const z = track.zoomPanRot ?? {}
    return (
      <ZprTimelineCard
        trackId={track.id}
        zpr={z}
        onApplyScalar={async (patch) => { await applyZpr(track.id, z, patch); fetchTracks() }}
        onApplyTracks={async (tracks) => { await applyZprTracks(track.id, tracks); fetchTracks() }}
        onPresetApplied={fetchTracks}
      />
    )
  }

  if (kind === 'pingPong') {
    const p = track.pingPong ?? {}
    return (
      <div className="fx-params-grid">
        <label>Region Start</label>
        <Fader
          orientation="horizontal" fill thickness={14}
          value={p.regionStartPct??0.8} min={0} max={1} defaultValue={0.8}
          fromNorm={quantizedFromNorm(0, 1, 0.01)}
          onCommit={async (v) => { await applyPP(track.id, p, { regionStartPct: v }); fetchTracks() }}
        />
        <span>{((p.regionStartPct??0.8)*100).toFixed(0)}%</span>
        <label>Region End</label>
        <Fader
          orientation="horizontal" fill thickness={14}
          value={p.regionEndPct??1.0} min={0} max={1} defaultValue={1.0}
          fromNorm={quantizedFromNorm(0, 1, 0.01)}
          onCommit={async (v) => { await applyPP(track.id, p, { regionEndPct: snapToOne(v) }); fetchTracks() }}
        />
        <span>{((p.regionEndPct??1.0)*100).toFixed(0)}%</span>
        <label>Crossfade Fr</label>
        <input type="number" min={0} max={30} step={1} defaultValue={p.crossfadeFrames??3}
          onBlur={async (e) => { await applyPP(track.id, p, { crossfadeFrames: parseInt(e.target.value)||0 }); fetchTracks() }} />
        <span />
        <label>Rev Speed</label>
        <Fader
          orientation="horizontal" fill thickness={14}
          value={p.reverseSpeed??1.0} min={0.25} max={4} defaultValue={1.0}
          fromNorm={quantizedFromNorm(0.25, 4, 0.01)}
          onCommit={async (v) => { await applyPP(track.id, p, { reverseSpeed: snapToOne(v) }); fetchTracks() }}
        />
        <span>{(p.reverseSpeed??1.0).toFixed(2)}×</span>
        <label>Max Loops</label>
        <input type="number" min={0} max={99} step={1} defaultValue={p.maxLoops??0}
          onBlur={async (e) => { await applyPP(track.id, p, { maxLoops: parseInt(e.target.value)||0 }); fetchTracks() }} />
        <span style={{opacity:0.6}}>(0=∞)</span>
      </div>
    )
  }

  return null
}
