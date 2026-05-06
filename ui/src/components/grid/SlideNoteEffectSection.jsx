// Slide Note Effect panel — Pattern Track only.
// Triggers a one-shot animation when a PatternNote.isSlide note fires. The
// config mirrors the existing Visual FX modules (Bounce / ZPR / TV Simulator)
// but stays a SEPARATE config from the normal Visual FX chain. Slide duration
// is owned exclusively by durationMode + fixedDurationMs (FollowSlide or Fixed),
// so the reused per-effect views hide their own durationMs control.
import { BounceParamsView, ZprParamsView, TvSimulatorParamsView } from './effectParamViews.jsx'

export default function SlideNoteEffectSection({ track, fetchTracks }) {
  const sl             = track.slideNoteEffect ?? {}
  const type           = sl.type ?? 0
  const durationMode   = sl.durationMode ?? 0
  const fixedMs        = sl.fixedDurationMs ?? 300
  const returnStyle    = sl.returnStyle ?? 1     // 1 = Smooth Reverse
  const returnTrigger  = sl.returnTrigger ?? 0   // 0 = Next Normal Note
  const returnMs       = sl.returnDurationMs ?? 200

  const set = async (patch) => {
    await window.xleth?.timeline?.setTrackSlideNoteEffect(track.id, { ...sl, ...patch })
    fetchTracks()
  }

  const onBounceChange = (patch) => set({ bounce: { ...(sl.bounce ?? {}), ...patch } })
  const onZprChange    = (patch) => set({ zoomPanRot: { ...(sl.zoomPanRot ?? {}), ...patch } })
  const onTvChange     = (patch) => set({ tv: { ...(sl.tv ?? {}), ...patch } })

  return (
    <div className="grid-tab-track-slide">
      <div className="grid-tab-slide-header">SLIDE NOTE EFFECT</div>
      <select
        className="grid-tab-slide-type-select"
        value={type}
        onChange={e => set({ type: parseInt(e.target.value) || 0 })}
      >
        <option value="0">None</option>
        <option value="1">Zoom/Pan/Rot</option>
        <option value="2">Bounce</option>
        <option value="3">TV Simulator</option>
      </select>
      {type !== 0 && (
        <div className="grid-tab-slide-params">
          <label>Duration</label>
          <select
            value={durationMode}
            onChange={e => set({ durationMode: parseInt(e.target.value) || 0 })}
          >
            <option value="0">Follow Slide</option>
            <option value="1">Fixed</option>
          </select>
          <span />
          {durationMode === 1 && (
            <>
              <label>Fixed ms</label>
              <input
                type="number" min={10} max={5000} step={10}
                defaultValue={fixedMs}
                onBlur={(e) => set({ fixedDurationMs: parseFloat(e.target.value) || 300 })}
              />
              <span className="grid-tab-slide-readout">{fixedMs}ms</span>
            </>
          )}
          <label>Return</label>
          <select
            value={returnStyle}
            onChange={e => set({ returnStyle: parseInt(e.target.value) || 0 })}
          >
            <option value="0">Instant</option>
            <option value="1">Smooth Reverse</option>
          </select>
          <span />
          <label>Trigger</label>
          <select
            value={returnTrigger}
            onChange={e => set({ returnTrigger: parseInt(e.target.value) || 0 })}
          >
            <option value="0">Next Normal Note</option>
            <option value="1">Next Slide Note</option>
          </select>
          <span />
          {returnStyle === 1 && (
            <>
              <label>Return ms</label>
              <input
                type="number" min={10} max={5000} step={10}
                defaultValue={returnMs}
                onBlur={(e) => set({ returnDurationMs: parseFloat(e.target.value) || 200 })}
              />
              <span className="grid-tab-slide-readout">{returnMs}ms</span>
            </>
          )}
        </div>
      )}
      {type === 1 && (
        <ZprParamsView value={sl.zoomPanRot ?? {}} onChange={onZprChange} hideDuration hideEnabled />
      )}
      {type === 2 && (
        <BounceParamsView value={sl.bounce ?? {}} onChange={onBounceChange} hideDuration hideEnabled />
      )}
      {type === 3 && (
        <TvSimulatorParamsView value={sl.tv ?? {}} onChange={onTvChange} />
      )}
    </div>
  )
}
