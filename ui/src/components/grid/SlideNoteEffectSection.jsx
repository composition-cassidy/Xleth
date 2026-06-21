// Slide Note Effect panel — Pattern Track only.
// Triggers a one-shot animation when a PatternNote.isSlide note fires. The
// config mirrors the existing Visual FX modules (Bounce / ZPR / TV Simulator)
// but stays a SEPARATE config from the normal Visual FX chain. Slide duration
// is owned exclusively by durationMode + fixedDurationMs (FollowSlide or Fixed),
// so the reused per-effect views hide their own durationMs control.
import { BounceParamsView, ZprParamsView, TvSimulatorParamsView } from './effectParamViews.jsx'
import XlethSelect from '../common/XlethSelect.jsx'

const EFFECT_TYPE_OPTIONS = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Zoom/Pan/Rot' },
  { value: 2, label: 'Bounce' },
  { value: 3, label: 'TV Simulator' },
]

const DURATION_OPTIONS = [
  { value: 0, label: 'Follow Slide' },
  { value: 1, label: 'Fixed' },
]

const RETURN_STYLE_OPTIONS = [
  { value: 0, label: 'Instant' },
  { value: 1, label: 'Smooth Reverse' },
]

const RETURN_TRIGGER_OPTIONS = [
  { value: 0, label: 'Next Normal Note' },
  { value: 1, label: 'Next Slide Note' },
]

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
      <XlethSelect
        className="grid-tab-slide-type-select"
        value={type}
        options={EFFECT_TYPE_OPTIONS}
        onChange={value => set({ type: value })}
        ariaLabel="Slide note effect type"
      />
      {type !== 0 && (
        <div className="grid-tab-slide-params">
          <label>Duration</label>
          <XlethSelect
            className="grid-tab-slide-param-select"
            value={durationMode}
            options={DURATION_OPTIONS}
            onChange={value => set({ durationMode: value })}
            ariaLabel="Slide note effect duration"
          />
          <span />
          {durationMode === 1 && (
            <>
              <label>Fixed ms</label>
              <input
                className="grid-tab-slide-param-input"
                type="number" min={10} max={5000} step={10}
                defaultValue={fixedMs}
                onBlur={(e) => set({ fixedDurationMs: parseFloat(e.target.value) || 300 })}
              />
              <span className="grid-tab-slide-readout">{fixedMs}ms</span>
            </>
          )}
          <label>Return</label>
          <XlethSelect
            className="grid-tab-slide-param-select"
            value={returnStyle}
            options={RETURN_STYLE_OPTIONS}
            onChange={value => set({ returnStyle: value })}
            ariaLabel="Slide note effect return style"
          />
          <span />
          <label>Trigger</label>
          <XlethSelect
            className="grid-tab-slide-param-select"
            value={returnTrigger}
            options={RETURN_TRIGGER_OPTIONS}
            onChange={value => set({ returnTrigger: value })}
            ariaLabel="Slide note effect return trigger"
          />
          <span />
          {returnStyle === 1 && (
            <>
              <label>Return ms</label>
              <input
                className="grid-tab-slide-param-input"
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
