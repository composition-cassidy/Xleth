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
import { snapToZero, snapToOne, quantizedFromNorm } from '../../utils/sliderHelpers.js'
import XlethSelect from '../common/XlethSelect.jsx'
import Fader from '../controls/Fader.jsx'

// The four ZPR easing presets, and the EXACT cubic-bezier each one migrates to
// in the engine (engine/src/model/ParamTrack.cpp — keep the two in sync).
//
// These are not the CSS presets. The legacy curves are polynomials in t, so
// e.g. Ease Out is `1-(1-t)^2`, which cubic-bezier(0,0,0.58,1) misses by 0.069.
// Fixing p1x=1/3, p2x=2/3 collapses x(t) to the identity, and any cubic then
// matches exactly. `curve: null` means the preset needs more than one segment
// (Ease In-Out splits at t=0.5) or depends on the overshoot param.
//
// The engine still receives the INDEX, not the curve — the keyframe editor that
// writes beziers directly arrives next phase. This table is the shared source
// of truth those controls will seed from.
export const EASING_CURVES = {
  0: [1 / 3, 1 / 3, 2 / 3, 2 / 3],   // Linear
  1: [1 / 3, 2 / 3, 2 / 3, 1],       // Ease Out
  2: null,                            // Ease In-Out — two segments
  3: null,                            // Ease Out Back — p1y = (overshoot+3)/3
}

// Ease Out Back's curve is continuous in the overshoot slider rather than fixed.
export const easeOutBackCurve = (overshoot) => [1 / 3, (overshoot + 3) / 3, 2 / 3, 1]

const EASING_OPTIONS = [
  { value: 0, label: 'Linear',        curve: EASING_CURVES[0] },
  { value: 1, label: 'Ease Out',      curve: EASING_CURVES[1] },
  { value: 2, label: 'Ease In-Out',   curve: EASING_CURVES[2] },
  { value: 3, label: 'Ease Out Back', curve: EASING_CURVES[3] },
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
      <Fader
        orientation="horizontal" fill thickness={14}
        value={distance} min={0} max={1} defaultValue={0.15}
        fromNorm={quantizedFromNorm(0, 1, 0.01)}
        onCommit={(v) => onChange({ distance: v })}
      />
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
      <Fader
        orientation="horizontal" fill thickness={14}
        value={targetZoom} min={0.25} max={4} defaultValue={1}
        fromNorm={quantizedFromNorm(0.25, 4, 0.01)}
        onCommit={(v) => onChange({ targetZoom: snapToOne(v) })}
      />
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
      <Fader
        orientation="horizontal" fill thickness={14}
        value={startZoom} min={0.25} max={4} defaultValue={1}
        fromNorm={quantizedFromNorm(0.25, 4, 0.01)}
        onCommit={(v) => onChange({ startZoom: snapToOne(v) })}
      />
      <span>{startZoom.toFixed(2)}×</span>
      <label>Pan X</label>
      <Fader
        orientation="horizontal" fill thickness={14}
        value={targetPanX} min={-1} max={1} defaultValue={0}
        fromNorm={quantizedFromNorm(-1, 1, 0.01)}
        onCommit={(v) => onChange({ targetPanX: snapToZero(v) })}
      />
      <span>{targetPanX.toFixed(2)}</span>
      <label>Pan Y</label>
      <Fader
        orientation="horizontal" fill thickness={14}
        value={targetPanY} min={-1} max={1} defaultValue={0}
        fromNorm={quantizedFromNorm(-1, 1, 0.01)}
        onCommit={(v) => onChange({ targetPanY: snapToZero(v) })}
      />
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
        <Fader
          orientation="horizontal" fill thickness={14}
          value={overshoot} min={0.5} max={3} defaultValue={1.70158}
          fromNorm={quantizedFromNorm(0.5, 3, 0.01)}
          onCommit={(v) => onChange({ overshoot: v })}
        />
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
            <Fader
              orientation="horizontal" fill thickness={14}
              value={val} min={min} max={max} defaultValue={def}
              fromNorm={quantizedFromNorm(min, max, step)}
              onCommit={(next) => onChange({ [key]: next })}
            />
            <span>{fmt(val)}</span>
          </Fragment>
        )
      })}
    </div>
  )
}

export { TV_FIELDS }
