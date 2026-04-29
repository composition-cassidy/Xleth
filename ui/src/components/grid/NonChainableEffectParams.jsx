import { snapToZero, snapToOne } from '../../utils/sliderHelpers.js'

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
      <div className="fx-params-grid">
        <label>Dir</label>
        <div className="fx-dir-group">
          {[['↑',90],['↓',270],['←',180],['→',0]].map(([lbl,deg]) => (
            <button key={deg}
              className={`grid-tab-dir-btn ${(b.directionDeg??270)===deg?'active':''}`}
              onClick={async () => { await applyBounce(track.id, b, { directionDeg: deg }); fetchTracks() }}>
              {lbl}
            </button>
          ))}
        </div>
        <span />
        <label>Dist</label>
        <input type="range" min={0} max={1} step={0.01} defaultValue={b.distance??0.15}
          onPointerUp={async (e) => { await applyBounce(track.id, b, { distance: parseFloat(e.target.value) }); fetchTracks() }} />
        <span>{(b.distance??0.15).toFixed(2)}</span>
        <label>Dur ms</label>
        <input type="number" min={20} max={2000} step={10} defaultValue={b.durationMs??200}
          onBlur={async (e) => { await applyBounce(track.id, b, { durationMs: parseFloat(e.target.value)||200 }); fetchTracks() }} />
        <span />
        <label>Repeat</label>
        <input type="number" min={1} max={8} step={1} defaultValue={b.repeatCount??1}
          onBlur={async (e) => { await applyBounce(track.id, b, { repeatCount: parseInt(e.target.value)||1 }); fetchTracks() }} />
        <span />
      </div>
    )
  }

  if (kind === 'zoomPanRot') {
    const z = track.zoomPanRot ?? {}
    return (
      <div className="fx-params-grid">
        <label>Target Zoom</label>
        <input type="range" min={0.25} max={4} step={0.01} defaultValue={z.targetZoom??1}
          onPointerUp={async (e) => { await applyZpr(track.id, z, { targetZoom: snapToOne(parseFloat(e.target.value)) }); fetchTracks() }} />
        <span>{(z.targetZoom??1).toFixed(2)}×</span>
        <label>Dur ms</label>
        <input type="number" min={20} max={5000} step={10} defaultValue={z.durationMs??300}
          onBlur={async (e) => { await applyZpr(track.id, z, { durationMs: parseFloat(e.target.value)||300 }); fetchTracks() }} />
        <span />
        <label>Start Zoom</label>
        <input type="range" min={0.25} max={4} step={0.01} defaultValue={z.startZoom??1}
          onPointerUp={async (e) => { await applyZpr(track.id, z, { startZoom: snapToOne(parseFloat(e.target.value)) }); fetchTracks() }} />
        <span>{(z.startZoom??1).toFixed(2)}×</span>
        <label>Pan X</label>
        <input type="range" min={-1} max={1} step={0.01} defaultValue={z.targetPanX??0}
          onPointerUp={async (e) => { await applyZpr(track.id, z, { targetPanX: snapToZero(parseFloat(e.target.value)) }); fetchTracks() }} />
        <span>{(z.targetPanX??0).toFixed(2)}</span>
        <label>Pan Y</label>
        <input type="range" min={-1} max={1} step={0.01} defaultValue={z.targetPanY??0}
          onPointerUp={async (e) => { await applyZpr(track.id, z, { targetPanY: snapToZero(parseFloat(e.target.value)) }); fetchTracks() }} />
        <span>{(z.targetPanY??0).toFixed(2)}</span>
        <label>Rotation°</label>
        <input type="number" min={-360} max={360} step={1} defaultValue={z.targetRotation??0}
          onBlur={async (e) => { await applyZpr(track.id, z, { targetRotation: parseFloat(e.target.value)||0 }); fetchTracks() }} />
        <span />
        <label>Easing</label>
        <select value={z.zoomEasing??1}
          onChange={async (e) => {
            const v = parseInt(e.target.value)
            await applyZpr(track.id, z, { zoomEasing: v, panEasing: v, rotEasing: v })
            fetchTracks()
          }}>
          <option value={0}>Linear</option>
          <option value={1}>Ease Out</option>
          <option value={2}>Ease In-Out</option>
          <option value={3}>Ease Out Back</option>
        </select>
        <span />
        {z.zoomEasing === 3 && (<>
          <label>Overshoot</label>
          <input type="range" min={0.5} max={3} step={0.01} defaultValue={z.overshoot??1.70158}
            onPointerUp={async (e) => { await applyZpr(track.id, z, { overshoot: parseFloat(e.target.value) }); fetchTracks() }} />
          <span>{(z.overshoot??1.70158).toFixed(2)}</span>
        </>)}
      </div>
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
