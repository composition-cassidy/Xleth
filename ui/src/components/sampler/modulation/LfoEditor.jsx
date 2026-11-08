import { useState } from 'react'
import {
  IconButton, Knob, SegmentedControl, Select, Toggle, skewScale,
} from '../../../ui-kit'
import { ModKnob, ModNumberBox } from '../kitMod.jsx'
import { formatSigned2, formatTime, noteValueCodec, parseOffset } from '../samplerFormat.js'
import ModShapeCanvas from './ModShapeCanvas.jsx'
import { useBoxSize } from './useBoxSize.js'
import {
  SEG_STEP, SEG_LINE, SEG_CURVE, BEHAVIORS,
  NOTE_VALUES, modTimeSeconds,
} from './modConstants.js'
import {
  TARGET_SRC_RATE, TARGET_SRC_PHASE, TARGET_SRC_RISE,
  TARGET_SRC_DELAY, TARGET_SRC_SMOOTH, TARGET_SRC_AMOUNT,
} from './modTargets.js'
import styles from '../Sampler.module.css'

// ── LFO editor ───────────────────────────────────────────────────────────────
// The drawable shape (canvas point editor: Step / Line / Curve segments on a snap
// grid) with rate, depth shaping and behaviour. A drag on the canvas streams
// through preview(); release commits once. Discrete controls commit immediately.

// Shape starters. Each returns a fresh `{t,v,seg,tension}[]`.
const PRESETS = {
  sine: () => {
    const ys = [0, 0.707, 1, 0.707, 0, -0.707, -1, -0.707]
    return ys.map((v, i) => ({ t: Number((i / 8).toFixed(4)), v, seg: SEG_LINE, tension: 0 }))
  },
  triangle: () => ([
    { t: 0, v: 0, seg: SEG_LINE, tension: 0 },
    { t: 0.25, v: 1, seg: SEG_LINE, tension: 0 },
    { t: 0.5, v: 0, seg: SEG_LINE, tension: 0 },
    { t: 0.75, v: -1, seg: SEG_LINE, tension: 0 },
  ]),
  saw: () => ([
    { t: 0, v: -1, seg: SEG_LINE, tension: 0 },
    { t: 0.999, v: 1, seg: SEG_LINE, tension: 0 },
  ]),
  square: () => ([
    { t: 0, v: 1, seg: SEG_STEP, tension: 0 },
    { t: 0.5, v: -1, seg: SEG_STEP, tension: 0 },
  ]),
  randomSteps: () => {
    const out = []
    for (let i = 0; i < 8; i++) {
      out.push({ t: Number((i / 8).toFixed(4)), v: Number((Math.random() * 2 - 1).toFixed(3)), seg: SEG_STEP, tension: 0 })
    }
    return out
  },
}

// 16px grid, 1.5px stroke, square caps: the kit icon grammar, drawn as the shape itself.
const glyph = (d) => (
  <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" />
  </svg>
)
const PRESET_LIST = [
  { id: 'sine', name: 'Sine', icon: glyph('M2,8 Q5,1 8,8 Q11,15 14,8') },
  { id: 'triangle', name: 'Triangle', icon: glyph('M2,11 L5,4 L8,11 L11,4 L14,11') },
  { id: 'saw', name: 'Saw', icon: glyph('M2,12 L10,4 L10,12 L14,12') },
  { id: 'square', name: 'Square', icon: glyph('M2,11 L2,4 L8,4 L8,11 L14,11 L14,4') },
  { id: 'randomSteps', name: 'Random steps', icon: glyph('M2,10 L4,10 L4,5 L6,5 L6,12 L8,12 L8,6 L10,6 L10,11 L12,11 L12,4 L14,4') },
]

const SEG_TOOLS = [
  { value: SEG_STEP, label: 'Step', hint: 'The selected point holds its value until the next one' },
  { value: SEG_LINE, label: 'Line', hint: 'A straight ramp to the next point' },
  { value: SEG_CURVE, label: 'Curve', hint: 'A bent ramp to the next point; set the bend with Tension' },
]

const SNAP_X = [0, 2, 3, 4, 6, 8, 12, 16, 32].map((v) => ({ value: v, label: v ? String(v) : 'Off' }))
const SNAP_Y = [0, 2, 4, 8, 12].map((v) => ({ value: v, label: v ? String(v) : 'Off' }))

const RATE_SCALE = skewScale(0.01, 40, 0.4)
const RATE_CODEC = noteValueCodec(NOTE_VALUES, { allowOff: false })
const TIME_CODEC = noteValueCodec(NOTE_VALUES)
const formatHz = (v) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)} Hz`
const parseHz = (t) => { const n = parseOffset(String(t).replace(/hz$/i, '').trim()); return n == null ? null : n }
const round = (v) => Math.round(v)

// Cross-modulation registrations. `source` is this LFO's own flat index, which is
// what a route targeting it carries in ModRoute.index. `scale` converts the
// control's units to the engine's: percent controls drive 0..1 parameters.
const srcReg = (target, source, scale = 1) => (source == null ? null : { target, index: source, stage: 0, scale })

export default function LfoEditor({ lfo, color, bpm, preview, commit, source = null, label = 'LFO' }) {
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const [snapX, setSnapX] = useState(0)
  const [snapY, setSnapY] = useState(0)
  const [wellRef, size] = useBoxSize()

  const points = Array.isArray(lfo.points) ? lfo.points : []
  const sync = !!lfo.tempoSync
  const selPoint = selectedIdx >= 0 && selectedIdx < points.length ? points[selectedIdx] : null
  const curveSelected = !!selPoint && selPoint.seg === SEG_CURVE

  const setPointsLive = (pts) => preview({ points: pts })
  const setPointsFinal = (pts) => { preview({ points: pts }); commit() }
  const applyPreset = (id) => { setPointsFinal(PRESETS[id]()); setSelectedIdx(-1) }
  const withSel = (patch) => points.map((p, i) => (i === selectedIdx ? { ...p, ...patch } : p))

  const setTimeLive = (key, patch) => preview({ [key]: { ...lfo[key], ...patch } })
  const setTimeFinal = (key, patch) => { preview({ [key]: { ...lfo[key], ...patch } }); commit() }

  const syncedRateMs = sync ? modTimeSeconds(lfo.syncRate, true, bpm) * 1000 : null

  const timeKnob = (key, name, target) => (sync ? (
    <Knob
      key={key} label={name} codec={TIME_CODEC} defaultValue={0}
      value={lfo[key]?.noteValue ?? 0}
      onChange={(v) => setTimeLive(key, { noteValue: round(v) })}
      onCommit={(v) => setTimeFinal(key, { noteValue: round(v) })}
      hint={`${name}, as a note value at the project tempo`}
      data-lfo-field={key}
    />
  ) : (
    <ModKnob
      key={key} label={name} unit="ms" min={0} max={10000} defaultValue={0} quantize={round}
      modTarget={srcReg(target, source)}
      value={lfo[key]?.ms ?? 0}
      onChange={(v) => setTimeLive(key, { ms: round(v) })}
      onCommit={(v) => setTimeFinal(key, { ms: round(v) })}
      hint={key === 'rise' ? 'Rise: fades the LFO in after each note starts' : 'Delay: waits before the LFO starts'}
      data-lfo-field={key}
    />
  ))

  return (
    <div className={styles.editor} data-editor="lfo">
      <div className={styles.editorHead}>
        <SegmentedControl
          size="sm" label={`${label} behaviour`} value={lfo.behavior ?? 0}
          options={BEHAVIORS.map((b) => ({ value: b.v, label: b.l, hint: b.title }))}
          onChange={(v) => { preview({ behavior: v }); commit() }}
          data-lfo-field="behavior"
        />
        <Toggle
          size="sm" on={!!lfo.mono}
          onChange={(v) => { preview({ mono: v }); commit() }}
          hint="Mono: one shared instance even in Retrig and Env"
          data-lfo-field="mono"
        >Mono</Toggle>
        <div className={styles.inline} role="group" aria-label="Shape presets">
          {PRESET_LIST.map((p) => (
            <IconButton key={p.id} size="sm" label={`${p.name} shape`} onClick={() => applyPreset(p.id)}
              hint={`Replace the drawn shape with a ${p.name.toLowerCase()}`}>
              {p.icon}
            </IconButton>
          ))}
        </div>
        <SegmentedControl
          size="sm" label="Segment of the selected point" value={selPoint ? (selPoint.seg ?? SEG_LINE) : -1}
          options={SEG_TOOLS} disabled={!selPoint}
          onChange={(seg) => { if (selPoint) setPointsFinal(withSel({ seg })) }}
          hint={selPoint ? 'Segment type for the selected point' : 'Select a point on the shape first'}
        />
        <span className={styles.caption}>Snap</span>
        <Select size="sm" className={styles.snapSelect} ariaLabel="Snap time" value={snapX} options={SNAP_X}
          onChange={(v) => setSnapX(Number(v))} hint="Snap points in time: divisions per cycle" />
        <Select size="sm" className={styles.snapSelect} ariaLabel="Snap value" value={snapY} options={SNAP_Y}
          onChange={(v) => setSnapY(Number(v))} hint="Snap points in value: divisions of the range" />
        <span className={styles.spacer} />
        <ModNumberBox
          label="Out" width={96} min={0} max={100} unit="%" quantize={round} defaultValue={100}
          modTarget={srcReg(TARGET_SRC_AMOUNT, source, 0.01)}
          value={(lfo.outputAmount ?? 1) * 100}
          onChange={(v) => preview({ outputAmount: round(v) / 100 })}
          onCommit={(v) => { preview({ outputAmount: round(v) / 100 }); commit() }}
          hint="Output: scales everything this LFO drives"
          data-lfo-field="outputAmount"
        />
      </div>

      <div
        className={styles.editorWell}
        ref={wellRef}
        data-hint={`${label} shape: one cycle, drawn`}
        data-hint-mods="Double-click: add a point · Drag: move · Alt+click or right-click: delete"
      >
        <ModShapeCanvas
          points={points}
          selectedIdx={selectedIdx}
          snapX={snapX}
          snapY={snapY}
          color={color}
          width={size.width}
          height={size.height}
          onPreview={setPointsLive}
          onCommit={setPointsFinal}
          onSelect={setSelectedIdx}
        />
      </div>

      <div className={styles.knobRow}>
        <div className={styles.rateBox}>
          <SegmentedControl
            size="sm" label={`${label} rate base`} value={sync ? 'sync' : 'hz'}
            options={[
              { value: 'hz', label: 'Hz', hint: 'Rate in cycles per second' },
              { value: 'sync', label: 'Sync', hint: 'Rate as a note value at the project tempo' },
            ]}
            onChange={(v) => { preview({ tempoSync: v === 'sync' }); commit() }}
            data-lfo-field="tempoSync"
          />
          {sync ? (
            <div className={styles.inline}>
              <Toggle size="sm" on={!!lfo.syncRate?.triplet} onChange={(v) => setTimeFinal('syncRate', { triplet: v })}
                hint="Triplet: two thirds of the note value">Triplet</Toggle>
              <Toggle size="sm" on={!!lfo.syncRate?.dotted} onChange={(v) => setTimeFinal('syncRate', { dotted: v })}
                hint="Dotted: one and a half times the note value">Dotted</Toggle>
            </div>
          ) : null}
        </div>
        {sync ? (
          <Knob
            label="Rate" codec={RATE_CODEC} defaultValue={8}
            value={lfo.syncRate?.noteValue ?? 8}
            onChange={(v) => setTimeLive('syncRate', { noteValue: round(v) })}
            onCommit={(v) => setTimeFinal('syncRate', { noteValue: round(v) })}
            hint={`One cycle per note value. At the project tempo that is ${formatTime(syncedRateMs ?? 0)}.`}
            data-lfo-field="syncRate"
          />
        ) : (
          <ModKnob
            label="Rate" scale={RATE_SCALE} min={0.01} max={40} defaultValue={1}
            format={formatHz} parse={parseHz}
            modTarget={srcReg(TARGET_SRC_RATE, source)}
            value={lfo.rateHz ?? 1}
            onChange={(v) => preview({ rateHz: Number(v.toFixed(3)) })}
            onCommit={(v) => { preview({ rateHz: Number(v.toFixed(3)) }); commit() }}
            hint="Cycles per second"
            data-lfo-field="rateHz"
          />
        )}
        {timeKnob('rise', 'Rise', TARGET_SRC_RISE)}
        {timeKnob('delay', 'Delay', TARGET_SRC_DELAY)}
        <ModKnob
          label="Smooth" unit="%" min={0} max={100} defaultValue={0} quantize={round}
          modTarget={srcReg(TARGET_SRC_SMOOTH, source, 0.01)}
          value={lfo.smooth ?? 0}
          onChange={(v) => preview({ smooth: round(v) })}
          onCommit={(v) => { preview({ smooth: round(v) }); commit() }}
          hint="Smooth: rounds off steps and corners in the shape"
          data-lfo-field="smooth"
        />
        <ModKnob
          label="Phase" unit="%" min={0} max={100} defaultValue={0} quantize={round}
          modTarget={srcReg(TARGET_SRC_PHASE, source, 0.01)}
          value={lfo.phase ?? 0}
          onChange={(v) => preview({ phase: round(v) })}
          onCommit={(v) => { preview({ phase: round(v) }); commit() }}
          hint="Phase: where in the cycle the LFO starts"
          data-lfo-field="phase"
        />
        <Knob
          label="Tension" min={-1} max={1} defaultValue={0} bipolar step={0.01}
          format={(v) => (curveSelected ? formatSigned2(v) : '—')} parse={parseOffset}
          disabled={!curveSelected}
          value={selPoint?.tension || 0}
          onChange={(v) => { if (curveSelected) setPointsLive(withSel({ tension: Number(v.toFixed(3)) })) }}
          onCommit={(v) => { if (curveSelected) setPointsFinal(withSel({ tension: Number(v.toFixed(3)) })) }}
          hint="Bend of the selected Curve segment"
          data-lfo-field="tension"
        />
      </div>
    </div>
  )
}
