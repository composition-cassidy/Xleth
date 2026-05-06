import { snapToZero, snapToOne } from '../../utils/sliderHelpers.js'
import { BounceParamsView, ZprParamsView } from './effectParamViews.jsx'

async function applyBounce(trackId, current, patch) {
  await window.xleth?.timeline?.setTrackBounceSettings(trackId, { ...current, ...patch })
}
async function applyZpr(trackId, current, patch) {
  await window.xleth?.timeline?.setTrackZoomPanRotSettings(trackId, { ...current, ...patch })
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
      <ZprParamsView
        value={z}
        onChange={async (patch) => { await applyZpr(track.id, z, patch); fetchTracks() }}
      />
    )
  }

  if (kind === 'pingPong') {
    const p = track.pingPong ?? {}
    return (
      <div className="fx-params-grid">
        <label>Region Start</label>
        <input type="range" min={0} max={1} step={0.01} defaultValue={p.regionStartPct??0.8}
          onPointerUp={async (e) => { await applyPP(track.id, p, { regionStartPct: parseFloat(e.target.value) }); fetchTracks() }} />
        <span>{((p.regionStartPct??0.8)*100).toFixed(0)}%</span>
        <label>Region End</label>
        <input type="range" min={0} max={1} step={0.01} defaultValue={p.regionEndPct??1.0}
          onPointerUp={async (e) => { await applyPP(track.id, p, { regionEndPct: snapToOne(parseFloat(e.target.value)) }); fetchTracks() }} />
        <span>{((p.regionEndPct??1.0)*100).toFixed(0)}%</span>
        <label>Crossfade Fr</label>
        <input type="number" min={0} max={30} step={1} defaultValue={p.crossfadeFrames??3}
          onBlur={async (e) => { await applyPP(track.id, p, { crossfadeFrames: parseInt(e.target.value)||0 }); fetchTracks() }} />
        <span />
        <label>Rev Speed</label>
        <input type="range" min={0.25} max={4} step={0.01} defaultValue={p.reverseSpeed??1.0}
          onPointerUp={async (e) => { await applyPP(track.id, p, { reverseSpeed: snapToOne(parseFloat(e.target.value)) }); fetchTracks() }} />
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
