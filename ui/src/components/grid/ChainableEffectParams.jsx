import { Fragment } from 'react'
import { snapToZero, snapToOne } from '../../utils/sliderHelpers.js'

export default function ChainableEffectParams({ fx, trackId, fxIdx, fetchTracks }) {
  const set = async (paramIdx, v) => {
    await window.xleth?.timeline?.setVisualEffectParam(trackId, fxIdx, paramIdx, v)
    fetchTracks()
  }

  return (
    <div className="fx-params-grid">

      {fx.type === 0 && (
        <>
          <label>Amount</label>
          <input type="range" min={0} max={1} step={0.01}
            defaultValue={fx.params?.[0] ?? 1}
            onPointerUp={async (e) => set(0, snapToZero(parseFloat(e.target.value)))} />
          <span>{((fx.params?.[0] ?? 1) * 100).toFixed(0)}%</span>
        </>
      )}

      {fx.type === 1 && (
        <>
          <label>Colour</label>
          <input type="color"
            defaultValue={(() => {
              const r = Math.round((fx.params?.[0] ?? 1)    * 255).toString(16).padStart(2,'0')
              const g = Math.round((fx.params?.[1] ?? 0.85) * 255).toString(16).padStart(2,'0')
              const b = Math.round((fx.params?.[2] ?? 0.6)  * 255).toString(16).padStart(2,'0')
              return `#${r}${g}${b}`
            })()}
            onBlur={async (e) => {
              const h = e.target.value
              await set(0, parseInt(h.slice(1,3),16)/255)
              await set(1, parseInt(h.slice(3,5),16)/255)
              await set(2, parseInt(h.slice(5,7),16)/255)
            }} />
          <span />
          <label>Strength</label>
          <input type="range" min={0} max={1} step={0.01}
            defaultValue={fx.params?.[3] ?? 0.5}
            onPointerUp={async (e) => set(3, snapToZero(parseFloat(e.target.value)))} />
          <span>{((fx.params?.[3] ?? 0.5) * 100).toFixed(0)}%</span>
          <label>Floor</label>
          <input type="range" min={0} max={1} step={0.01}
            defaultValue={fx.params?.[4] ?? 0.15}
            onPointerUp={async (e) => set(4, parseFloat(e.target.value))} />
          <span>{((fx.params?.[4] ?? 0.15) * 100).toFixed(0)}%</span>
          <label>Ceiling</label>
          <input type="range" min={0} max={1} step={0.01}
            defaultValue={fx.params?.[5] ?? 1.0}
            onPointerUp={async (e) => set(5, parseFloat(e.target.value))} />
          <span>{((fx.params?.[5] ?? 1.0) * 100).toFixed(0)}%</span>
        </>
      )}

      {fx.type === 2 && (
        <>
          <label>Brightness</label>
          <input type="range" min={-1} max={1} step={0.01}
            defaultValue={fx.params?.[0] ?? 0}
            onPointerUp={async (e) => set(0, snapToZero(parseFloat(e.target.value)))} />
          <span>{((fx.params?.[0] ?? 0) * 100).toFixed(0)}%</span>
          <label>Contrast</label>
          <input type="range" min={-1} max={1} step={0.01}
            defaultValue={fx.params?.[1] ?? 0}
            onPointerUp={async (e) => set(1, snapToZero(parseFloat(e.target.value)))} />
          <span>{((fx.params?.[1] ?? 0) * 100).toFixed(0)}%</span>
        </>
      )}

      {fx.type === 3 && [
        { label: 'Intensity',   pi: 0, min: 0,    max: 1,    step: 0.01,   def: 0.5,   fmt: v => (v*100).toFixed(0)+'%' },
        { label: 'Roll Speed',  pi: 1, min: 0,    max: 5,    step: 0.01,   def: 1.0,   fmt: v => v.toFixed(2)           },
        { label: 'Scanlines',   pi: 2, min: 0,    max: 1,    step: 0.01,   def: 0.3,   fmt: v => (v*100).toFixed(0)+'%' },
        { label: 'Chroma',      pi: 3, min: 0,    max: 0.01, step: 0.0001, def: 0.003, fmt: v => v.toFixed(4)           },
        { label: 'Noise',       pi: 4, min: 0,    max: 1,    step: 0.01,   def: 0.0,   fmt: v => (v*100).toFixed(0)+'%' },
        { label: 'Jitter',      pi: 5, min: 0,    max: 10,   step: 0.1,    def: 2.0,   fmt: v => v.toFixed(1)           },
        { label: 'Color Bleed', pi: 6, min: 0,    max: 0.02, step: 0.0001, def: 0.0,   fmt: v => v.toFixed(4)           },
      ].map(({ label, pi, min, max, step, def, fmt }) => (
        <Fragment key={pi}>
          <label>{label}</label>
          <input type="range" min={min} max={max} step={step}
            defaultValue={fx.params?.[pi] ?? def}
            onPointerUp={async (e) => set(pi, parseFloat(e.target.value))} />
          <span>{fmt(fx.params?.[pi] ?? def)}</span>
        </Fragment>
      ))}

      {fx.type === 4 && [
        { label: 'Target Zoom', pi: 1, min: 0.25, max: 4,   step: 0.01, def: 1.0, fmt: v => v.toFixed(2)+'×', snap1: true },
        { label: 'Pan X',       pi: 4, min: -1,   max: 1,   step: 0.01, def: 0.0, fmt: v => v.toFixed(2),      snap0: true },
        { label: 'Pan Y',       pi: 5, min: -1,   max: 1,   step: 0.01, def: 0.0, fmt: v => v.toFixed(2),      snap0: true },
        { label: 'Rotation°',   pi: 7, min: -360, max: 360, step: 1,    def: 0.0, fmt: v => v.toFixed(0)+'°',  snap0: true },
      ].map(({ label, pi, min, max, step, def, fmt, snap0, snap1 }) => (
        <Fragment key={pi}>
          <label>{label}</label>
          <input type="range" min={min} max={max} step={step}
            defaultValue={fx.params?.[pi] ?? def}
            onPointerUp={async (e) => {
              let v = parseFloat(e.target.value)
              if (snap0) v = snapToZero(v)
              if (snap1) v = snapToOne(v)
              set(pi, v)
            }} />
          <span>{fmt(fx.params?.[pi] ?? def)}</span>
        </Fragment>
      ))}

    </div>
  )
}
