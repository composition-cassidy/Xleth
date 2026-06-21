// Shared, strictly presentational view components for the Visual FX modules.
// Used by both:
//   - the normal Visual FX panels (NonChainableEffectParams.jsx,
//     ChainableEffectParams.jsx)
//   - the Slide Note Effect panel (SlideNoteEffectSection.jsx)
//
// HARD RULES:
//   - Props are (value, onChange) only. No window.xleth, no setter calls.
//   - onChange(patch) fires a partial patch object; the parent owns IPC.
//   - hideDuration / hideEnabled hide the corresponding controls so the
//     slide panel can use these views without exposing fields the slide
//     config doesn't own (slide duration is owned by durationMode +
//     fixedDurationMs in SlideNoteEffectSection).
import { Fragment } from 'react'
import { snapToZero, snapToOne } from '../../utils/sliderHelpers.js'
import XlethSelect from '../common/XlethSelect.jsx'

const EASING_OPTIONS = [
  { value: 0, label: 'Linear' },
  { value: 1, label: 'Ease Out' },
  { value: 2, label: 'Ease In-Out' },
  { value: 3, label: 'Ease Out Back' },
]

// ─── BounceParamsView ────────────────────────────────────────────────────────
// value shape: BounceSettings — { directionDeg, distance, durationMs,
//   squashAmount, overshoot, repeatCount, easingType, enabled }
export function BounceParamsView({ value, onChange, hideDuration = false, hideEnabled = false }) {
  const v = value ?? {}
  const directionDeg = v.directionDeg ?? 270
  const distance     = v.distance     ?? 0.15
  const durationMs   = v.durationMs   ?? 200
  const repeatCount  = v.repeatCount  ?? 1
  return (
    <div className="fx-params-grid">
      <label>Dir</label>
      <div className="fx-dir-group">
        {[['↑', 90], ['↓', 270], ['←', 180], ['→', 0]].map(([lbl, deg]) => (
          <button key={deg}
            className={`grid-tab-dir-btn ${directionDeg === deg ? 'active' : ''}`}
            onClick={() => onChange({ directionDeg: deg })}>
            {lbl}
          </button>
        ))}
      </div>
      <span />
      <label>Dist</label>
      <input type="range" min={0} max={1} step={0.01} defaultValue={distance}
        onPointerUp={(e) => onChange({ distance: parseFloat(e.target.value) })} />
      <span>{distance.toFixed(2)}</span>
      {!hideDuration && (
        <>
          <label>Dur ms</label>
          <input type="number" min={20} max={2000} step={10} defaultValue={durationMs}
            onBlur={(e) => onChange({ durationMs: parseFloat(e.target.value) || 200 })} />
          <span />
        </>
      )}
      <label>Repeat</label>
      <input type="number" min={1} max={8} step={1} defaultValue={repeatCount}
        onBlur={(e) => onChange({ repeatCount: parseInt(e.target.value) || 1 })} />
      <span />
    </div>
  )
}

// ─── ZprParamsView ───────────────────────────────────────────────────────────
// value shape: ZoomPanRotSettings — { startZoom, targetZoom, startPanX,
//   startPanY, targetPanX, targetPanY, startRotation, targetRotation,
//   durationMs, zoomEasing, panEasing, rotEasing, overshoot, enabled }
export function ZprParamsView({ value, onChange, hideDuration = false, hideEnabled = false }) {
  const z = value ?? {}
  const startZoom      = z.startZoom      ?? 1
  const targetZoom     = z.targetZoom     ?? 1
  const targetPanX     = z.targetPanX     ?? 0
  const targetPanY     = z.targetPanY     ?? 0
  const targetRotation = z.targetRotation ?? 0
  const durationMs     = z.durationMs     ?? 300
  const zoomEasing     = z.zoomEasing     ?? 1
  const overshoot      = z.overshoot      ?? 1.70158
  return (
    <div className="fx-params-grid">
      <label>Target Zoom</label>
      <input type="range" min={0.25} max={4} step={0.01} defaultValue={targetZoom}
        onPointerUp={(e) => onChange({ targetZoom: snapToOne(parseFloat(e.target.value)) })} />
      <span>{targetZoom.toFixed(2)}×</span>
      {!hideDuration && (
        <>
          <label>Dur ms</label>
          <input type="number" min={20} max={5000} step={10} defaultValue={durationMs}
            onBlur={(e) => onChange({ durationMs: parseFloat(e.target.value) || 300 })} />
          <span />
        </>
      )}
      <label>Start Zoom</label>
      <input type="range" min={0.25} max={4} step={0.01} defaultValue={startZoom}
        onPointerUp={(e) => onChange({ startZoom: snapToOne(parseFloat(e.target.value)) })} />
      <span>{startZoom.toFixed(2)}×</span>
      <label>Pan X</label>
      <input type="range" min={-1} max={1} step={0.01} defaultValue={targetPanX}
        onPointerUp={(e) => onChange({ targetPanX: snapToZero(parseFloat(e.target.value)) })} />
      <span>{targetPanX.toFixed(2)}</span>
      <label>Pan Y</label>
      <input type="range" min={-1} max={1} step={0.01} defaultValue={targetPanY}
        onPointerUp={(e) => onChange({ targetPanY: snapToZero(parseFloat(e.target.value)) })} />
      <span>{targetPanY.toFixed(2)}</span>
      <label>Rotation°</label>
      <input type="number" min={-360} max={360} step={1} defaultValue={targetRotation}
        onBlur={(e) => onChange({ targetRotation: parseFloat(e.target.value) || 0 })} />
      <span />
      <label>Easing</label>
      <XlethSelect
        className="fx-param-select"
        value={zoomEasing}
        options={EASING_OPTIONS}
        onChange={value => onChange({ zoomEasing: value, panEasing: value, rotEasing: value })}
        ariaLabel="Effect easing"
      />
      <span />
      {zoomEasing === 3 && (<>
        <label>Overshoot</label>
        <input type="range" min={0.5} max={3} step={0.01} defaultValue={overshoot}
          onPointerUp={(e) => onChange({ overshoot: parseFloat(e.target.value) })} />
        <span>{overshoot.toFixed(2)}</span>
      </>)}
    </div>
  )
}

// ─── TvSimulatorParamsView ───────────────────────────────────────────────────
// value shape: { intensity, rollSpeed, scanlines, chroma, noise, jitter,
//   colorBleed } — matches SlideTVSettings; for chain TV the parent maps
//   between this shape and the typeless params[0..6] array.
const TV_FIELDS = [
  { key: 'intensity',  label: 'Intensity',   min: 0, max: 1,    step: 0.01,   def: 0.5,   fmt: v => (v * 100).toFixed(0) + '%' },
  { key: 'rollSpeed',  label: 'Roll Speed',  min: 0, max: 5,    step: 0.01,   def: 1.0,   fmt: v => v.toFixed(2) },
  { key: 'scanlines',  label: 'Scanlines',   min: 0, max: 1,    step: 0.01,   def: 0.3,   fmt: v => (v * 100).toFixed(0) + '%' },
  { key: 'chroma',     label: 'Chroma',      min: 0, max: 0.01, step: 0.0001, def: 0.003, fmt: v => v.toFixed(4) },
  { key: 'noise',      label: 'Noise',       min: 0, max: 1,    step: 0.01,   def: 0.0,   fmt: v => (v * 100).toFixed(0) + '%' },
  { key: 'jitter',     label: 'Jitter',      min: 0, max: 10,   step: 0.1,    def: 2.0,   fmt: v => v.toFixed(1) },
  { key: 'colorBleed', label: 'Color Bleed', min: 0, max: 0.02, step: 0.0001, def: 0.0,   fmt: v => v.toFixed(4) },
]

export function TvSimulatorParamsView({ value, onChange }) {
  const v = value ?? {}
  return (
    <div className="fx-params-grid">
      {TV_FIELDS.map(({ key, label, min, max, step, def, fmt }) => {
        const val = v[key] ?? def
        return (
          <Fragment key={key}>
            <label>{label}</label>
            <input type="range" min={min} max={max} step={step} defaultValue={val}
              onPointerUp={(e) => onChange({ [key]: parseFloat(e.target.value) })} />
            <span>{fmt(val)}</span>
          </Fragment>
        )
      })}
    </div>
  )
}

export { TV_FIELDS }
