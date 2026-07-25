import { Fragment, useState } from 'react'
import { Pipette } from 'lucide-react'
import { snapToZero, snapToOne } from '../../utils/sliderHelpers.js'
import { TvSimulatorParamsView, TV_FIELDS } from './effectParamViews.jsx'
import { beginPick } from './chromaKeyEyedropper.js'

// Chain TV Simulator stores values in fx.params[0..6]; the shared view uses
// a named-object shape. Map between the two.
const TV_KEY_TO_PI = { intensity: 0, rollSpeed: 1, scanlines: 2, chroma: 3,
                       noise: 4, jitter: 5, colorBleed: 6 }
function tvParamsToView(params) {
  const out = {}
  for (const { key, def } of TV_FIELDS) {
    out[key] = params?.[TV_KEY_TO_PI[key]] ?? def
  }
  return out
}

// Chroma Key sliders. Tolerance/softness are distances in the CbCr plane
// (roughly 0..1.41 across the whole gamut), so useful values live low.
// Choke/blur are radii in OUTPUT pixels — see the v1 note on the canonical
// param layout in engine/src/model/TimelineTypes.h.
const CHROMA_SLIDERS = [
  { label: 'Tolerance', pi: 3, min: 0, max: 0.6, step: 0.005, def: 0.10,
    fmt: v => v.toFixed(3),
    title: 'Core threshold. Colours closer to the key than this are fully removed. Raise until the background is gone.' },
  { label: 'Softness', pi: 4, min: 0, max: 0.8, step: 0.005, def: 0.22,
    fmt: v => v.toFixed(3),
    title: 'Edge threshold, and it must sit above Tolerance. The gap between the two is the soft edge — widen it for hair and motion blur.' },
  { label: 'Spill Suppression', pi: 5, min: 0, max: 1, step: 0.01, def: 0.50,
    fmt: v => `${(v * 100).toFixed(0)}%`,
    title: 'Pulls key-coloured bounce light out of the pixels that survive, without touching their brightness.' },
  { label: 'Matte Choke', pi: 6, min: 0, max: 8, step: 0.1, def: 0,
    fmt: v => `${v.toFixed(1)} px`,
    title: 'Shrinks the matte inward, in output pixels. Use a little to eat the compression fringe on YouTube-rip sources.' },
  { label: 'Edge Blur', pi: 7, min: 0, max: 8, step: 0.1, def: 0,
    fmt: v => `${v.toFixed(1)} px`,
    title: 'Feathers the matte edge, in output pixels, so the cutout does not look cut out with scissors.' },
]

function rgbToHex(r, g, b) {
  const h = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

export default function ChainableEffectParams({ fx, trackId, fxIdx, chain, fetchTracks }) {
  const set = async (paramIdx, v) => {
    await window.xleth?.timeline?.setVisualEffectParam(trackId, fxIdx, paramIdx, v)
    fetchTracks()
  }

  const [picking, setPicking] = useState(false)

  // Eyedropper: read the key colour off the preview.
  //
  // The shm frame the picker samples is the fully composited output, so with
  // the chain live a pick would return the POST-effect colour — and for a
  // working keyer that is the layer showing THROUGH the hole, not the green we
  // want to sample. So mute this track's whole chain for the duration of the
  // pick and restore it afterwards.
  const pickKeyColor = async () => {
    if (picking) return
    setPicking(true)
    // Only touch effects that are actually live. Every toggle is an undoable
    // command, so skipping the already-bypassed ones keeps the undo stack as
    // quiet as this can be without a preview-only mute RPC.
    const list = Array.isArray(chain) ? chain : []
    const toMute = list
      .map((e, i) => ({ i, bypassed: !!e?.bypassed }))
      .filter(({ bypassed }) => !bypassed)
      .map(({ i }) => i)
    const muted = []
    try {
      for (const i of toMute) {
        await window.xleth?.timeline?.setVisualEffectBypassed(trackId, i, true)
        muted.push(i)
      }
      const rgb = await beginPick(trackId)
      if (rgb) {
        await set(0, rgb.r)
        await set(1, rgb.g)
        await set(2, rgb.b)
      }
    } finally {
      // Restore in reverse so the chain ends up exactly as it started even if
      // a mid-loop call above threw.
      for (const i of muted.reverse()) {
        try { await window.xleth?.timeline?.setVisualEffectBypassed(trackId, i, false) } catch { /* no-op */ }
      }
      setPicking(false)
      fetchTracks()
    }
  }

  if (fx.type === 5) {
    const keyHex = rgbToHex(fx.params?.[0] ?? 0, fx.params?.[1] ?? 0.694, fx.params?.[2] ?? 0.251)
    return (
      <div className="fx-params-grid">
        <label>Key Colour</label>
        <div className="fx-chroma-key-row">
          <input
            type="color"
            value={keyHex}
            onChange={async (e) => {
              const h = e.target.value
              await set(0, parseInt(h.slice(1, 3), 16) / 255)
              await set(1, parseInt(h.slice(3, 5), 16) / 255)
              await set(2, parseInt(h.slice(5, 7), 16) / 255)
            }} />
          <button
            type="button"
            className={`fx-eyedropper-btn ${picking ? 'active' : ''}`}
            onClick={pickKeyColor}
            disabled={picking}
            title={picking
              ? 'Click the preview to sample the key colour — Escape to cancel'
              : 'Pick the key colour from the preview'}
          >
            <Pipette size={13} />
          </button>
        </div>
        <span>{picking ? 'Click preview…' : keyHex}</span>

        {CHROMA_SLIDERS.map(({ label, pi, min, max, step, def, fmt, title }) => (
          <Fragment key={pi}>
            <label title={title}>{label}</label>
            <input type="range" min={min} max={max} step={step}
              defaultValue={fx.params?.[pi] ?? def}
              title={title}
              onPointerUp={async (e) => set(pi, snapToZero(parseFloat(e.target.value)))} />
            <span>{fmt(fx.params?.[pi] ?? def)}</span>
          </Fragment>
        ))}
      </div>
    )
  }

  // TV Simulator uses the shared view (which provides its own fx-params-grid).
  if (fx.type === 3) {
    return (
      <TvSimulatorParamsView
        value={tvParamsToView(fx.params)}
        onChange={async (patch) => {
          for (const [k, v] of Object.entries(patch)) {
            const pi = TV_KEY_TO_PI[k]
            if (pi != null) await set(pi, v)
          }
        }}
      />
    )
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
