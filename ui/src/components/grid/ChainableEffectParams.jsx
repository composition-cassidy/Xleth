import { Fragment, useState } from 'react'
import { Pipette } from 'lucide-react'
import { snapToZero, snapToOne, rangeFillStyle } from '../../utils/sliderHelpers.js'
import { TvSimulatorParamsView, TV_FIELDS } from './effectParamViews.jsx'
import { beginPick } from './chromaKeyEyedropper.js'
import XlethSelect from '../common/XlethSelect.jsx'

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

// Outline. Thickness is in CELL pixels — unlike Chroma Key's choke/blur, the
// expansion stage knows its render target's real size, so the number on the
// slider is the number of pixels you get. Softness is a fraction of that
// thickness, which is what makes 100% read as a glow rather than a fixed blur.
const OUTLINE_SLIDERS = [
  { label: 'Thickness', pi: 3, min: 0, max: 24, step: 0.5, def: 3,
    fmt: v => `${v.toFixed(1)} px`,
    title: 'Stroke width in cell pixels. The stroke is drawn OUTSIDE the video, into the gap between cells — with the gap at 0 neighbouring cells will overdraw each other’s strokes.' },
  { label: 'Softness', pi: 4, min: 0, max: 1, step: 0.01, def: 0,
    fmt: v => `${(v * 100).toFixed(0)}%`,
    title: '0% is a hard edge. Higher values feather inward from the stroke’s outer edge; at 100% it fades all the way back to the subject, which reads as a glow.' },
  { label: 'Opacity', pi: 5, min: 0, max: 1, step: 0.01, def: 1,
    fmt: v => `${(v * 100).toFixed(0)}%`,
    title: 'Strength of the stroke. At 0% the effect is skipped entirely.' },
  // Capped below 100% deliberately: the rule is "at or below this alpha is
  // background", so at exactly 100% even a fully opaque pixel is background,
  // nothing has a silhouette, and the stroke vanishes. That is consistent but it
  // is a dead end, so the slider does not go there.
  { label: 'Alpha Cutoff', pi: 6, min: 0.5, max: 0.99, step: 0.01, def: 0.95,
    fmt: v => `${(v * 100).toFixed(0)}%`,
    title: 'Pixels at or below this alpha count as background, so this is what the stroke traces around. Just under 100% by default so a faint wash of leftover alpha from the keyer is not mistaken for solid subject.' },
]

// Drop Shadow. Size and Softness are 0..100% rather than pixels because they are
// "how much", not a measurement — the engine maps them onto its own maximum
// radii (kMaxShadowInflatePx / kMaxShadowBlurPx in GridCompositor.cpp).
const DROP_SHADOW_SLIDERS = [
  { label: 'Distance', pi: 3, min: 0, max: 64, step: 0.5, def: 8,
    fmt: v => `${v.toFixed(1)} px`,
    title: 'How far the shadow is offset from the subject, in cell pixels.' },
  { label: 'Angle', pi: 4, min: 0, max: 360, step: 1, def: 45,
    fmt: v => `${v.toFixed(0)}°`,
    title: 'Direction the shadow is cast. 0° is to the right and the angle advances clockwise, so 45° is the conventional down-right. Compensated for the cell’s flip, so a mirrored cell still throws its shadow the way you set it.' },
  { label: 'Size', pi: 5, min: 0, max: 1, step: 0.01, def: 0,
    fmt: v => `${(v * 100).toFixed(0)}%`,
    title: 'Inflates the shadow. At 0% it is exactly the subject’s shape; raising it bulges the shape outward rather than just scaling it up.' },
  { label: 'Softness', pi: 6, min: 0, max: 1, step: 0.01, def: 0.35,
    fmt: v => `${(v * 100).toFixed(0)}%`,
    title: 'How hard or soft the shadow edge is. 0% is a hard-edged silhouette.' },
  { label: 'Opacity', pi: 7, min: 0, max: 1, step: 0.01, def: 0.6,
    fmt: v => `${(v * 100).toFixed(0)}%`,
    title: 'Strength of the shadow. Scaled by the cell’s own opacity on top of this. At 0% the effect is skipped entirely.' },
  // Capped below 100% for the same reason as the Outline's: at exactly 100%
  // nothing counts as foreground and the shadow disappears completely.
  { label: 'Alpha Cutoff', pi: 9, min: 0.5, max: 0.99, step: 0.01, def: 0.95,
    fmt: v => `${(v * 100).toFixed(0)}%`,
    title: 'Pixels at or below this alpha cast no shadow. Just under 100% by default so a faint wash of leftover alpha from the keyer does not cast a shadow of the whole frame.' },
]

// params[8]. Darkening modes blend against whatever is BEHIND the cell, which is
// why the shadow is drawn as its own quad rather than folded into the cell.
// Colour Burn is absent on purpose — it cannot be expressed as a fixed-function
// blend (see the emit table in FX_DropShadow.hlsl).
const BLEND_MODE_OPTIONS = [
  { value: 0, label: 'Normal'      },
  { value: 1, label: 'Multiply'    },
  { value: 2, label: 'Darken'      },
  { value: 3, label: 'Linear Burn' },
]

function rgbToHex(r, g, b) {
  const h = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

// Outline and Drop Shadow are terminal stages in the engine — they run after the
// whole chain regardless of where they sit in it. Without saying so, a user who
// drags one above the keyer and sees no change reads that as a bug.
function TerminalStageNote({ children }) {
  return <p className="fx-param-note">{children}</p>
}

// Slider rows for a params[]-indexed table. Commits on pointer-up rather than on
// every tick: each set() is one undoable engine command, so a live drag would
// both storm the bridge and bury the undo stack.
function SliderRows({ rows, params, set }) {
  return rows.map(({ label, pi, min, max, step, def, fmt, title }) => (
    <Fragment key={pi}>
      <label title={title}>{label}</label>
      <input type="range" min={min} max={max} step={step}
        defaultValue={params?.[pi] ?? def}
        style={rangeFillStyle(params?.[pi] ?? def, min, max)}
        title={title}
        onPointerUp={async (e) => set(pi, snapToZero(parseFloat(e.target.value)))} />
      <span>{fmt(params?.[pi] ?? def)}</span>
    </Fragment>
  ))
}

export default function ChainableEffectParams({ fx, trackId, fxIdx, fetchTracks }) {
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
  // pick and restore it afterwards, via the preview-only mute RPC (no undo
  // entry, not persisted, not seen by export — see
  // Timeline::setVisualEffectChainPreviewMuted).
  const pickKeyColor = async () => {
    if (picking) return
    setPicking(true)
    try {
      await window.xleth?.timeline?.setVisualEffectChainPreviewMuted(trackId, true)
      const rgb = await beginPick(trackId)
      if (rgb) {
        await set(0, rgb.r)
        await set(1, rgb.g)
        await set(2, rgb.b)
      }
    } finally {
      // Runs on cancel (Escape / superseding pick) too, not just a successful
      // pick — beginPick's promise always resolves, never rejects.
      try { await window.xleth?.timeline?.setVisualEffectChainPreviewMuted(trackId, false) } catch { /* no-op */ }
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

        <SliderRows rows={CHROMA_SLIDERS} params={fx.params} set={set} />
      </div>
    )
  }

  // ── Outline (type 6) ───────────────────────────────────────────────────────
  // A layer style, not a filter: it draws outside the video's own bounds, so the
  // cell's drawn rect grows by the thickness and the stroke lands in the gap
  // between cells. On keyed footage it traces the cutout; on plain footage the
  // silhouette is just the cell rectangle, so it frames the box.
  if (fx.type === 6) {
    const strokeHex = rgbToHex(fx.params?.[0] ?? 1, fx.params?.[1] ?? 1, fx.params?.[2] ?? 1)
    return (
      <div className="fx-params-grid">
        <label>Colour</label>
        <input
          type="color"
          value={strokeHex}
          onChange={async (e) => {
            const h = e.target.value
            await set(0, parseInt(h.slice(1, 3), 16) / 255)
            await set(1, parseInt(h.slice(3, 5), 16) / 255)
            await set(2, parseInt(h.slice(5, 7), 16) / 255)
          }} />
        <span>{strokeHex}</span>

        <SliderRows rows={OUTLINE_SLIDERS} params={fx.params} set={set} />
        <TerminalStageNote>
          Applied after every other effect on this track, so its position in the
          chain does not change the result.
        </TerminalStageNote>
      </div>
    )
  }

  // ── Drop Shadow (type 7) ───────────────────────────────────────────────────
  if (fx.type === 7) {
    const shadowHex = rgbToHex(fx.params?.[0] ?? 0, fx.params?.[1] ?? 0, fx.params?.[2] ?? 0)
    return (
      <div className="fx-params-grid">
        <label>Colour</label>
        <input
          type="color"
          value={shadowHex}
          onChange={async (e) => {
            const h = e.target.value
            await set(0, parseInt(h.slice(1, 3), 16) / 255)
            await set(1, parseInt(h.slice(3, 5), 16) / 255)
            await set(2, parseInt(h.slice(5, 7), 16) / 255)
          }} />
        <span>{shadowHex}</span>

        <label title="How the shadow combines with whatever is behind the cell. Multiply and Darken only ever darken the backdrop; Normal paints the shadow colour over it.">
          Blend
        </label>
        <XlethSelect
          className="fx-param-select"
          value={Math.round(fx.params?.[8] ?? 1)}
          options={BLEND_MODE_OPTIONS}
          onChange={value => set(8, value)}
          ariaLabel="Drop shadow blend mode"
        />
        <span />

        <SliderRows rows={DROP_SHADOW_SLIDERS} params={fx.params} set={set} />
        <TerminalStageNote>
          Cast by the finished cell, including its outline, so its position in the
          chain does not change the result.
        </TerminalStageNote>
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
            style={rangeFillStyle(fx.params?.[0] ?? 1, 0, 1)}
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
            style={rangeFillStyle(fx.params?.[3] ?? 0.5, 0, 1)}
            onPointerUp={async (e) => set(3, snapToZero(parseFloat(e.target.value)))} />
          <span>{((fx.params?.[3] ?? 0.5) * 100).toFixed(0)}%</span>
          <label>Floor</label>
          <input type="range" min={0} max={1} step={0.01}
            defaultValue={fx.params?.[4] ?? 0.15}
            style={rangeFillStyle(fx.params?.[4] ?? 0.15, 0, 1)}
            onPointerUp={async (e) => set(4, parseFloat(e.target.value))} />
          <span>{((fx.params?.[4] ?? 0.15) * 100).toFixed(0)}%</span>
          <label>Ceiling</label>
          <input type="range" min={0} max={1} step={0.01}
            defaultValue={fx.params?.[5] ?? 1.0}
            style={rangeFillStyle(fx.params?.[5] ?? 1.0, 0, 1)}
            onPointerUp={async (e) => set(5, parseFloat(e.target.value))} />
          <span>{((fx.params?.[5] ?? 1.0) * 100).toFixed(0)}%</span>
        </>
      )}

      {fx.type === 2 && (
        <>
          <label>Brightness</label>
          <input type="range" min={-1} max={1} step={0.01}
            defaultValue={fx.params?.[0] ?? 0}
            style={rangeFillStyle(fx.params?.[0] ?? 0, -1, 1)}
            onPointerUp={async (e) => set(0, snapToZero(parseFloat(e.target.value)))} />
          <span>{((fx.params?.[0] ?? 0) * 100).toFixed(0)}%</span>
          <label>Contrast</label>
          <input type="range" min={-1} max={1} step={0.01}
            defaultValue={fx.params?.[1] ?? 0}
            style={rangeFillStyle(fx.params?.[1] ?? 0, -1, 1)}
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
            style={rangeFillStyle(fx.params?.[pi] ?? def, min, max)}
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
