import React, { useCallback, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import {
  IconButton, Knob, NumberBox, SegmentedControl, Select, Toggle, formatValue, skewScale,
} from '../../ui-kit'
import { useDprEpoch } from '../../ui-kit/dpr'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import { uiCanvasFont } from '../../styles/typography.js'
import {
  MOD_DESTS, LFO_SHAPES, LFO_SYNC_DIVISIONS, MOD_KINDS,
  MOD_KIND_LFO, MOD_KIND_ENV, MOD_KIND_DYN, MAX_MODS_PER_SLOT, modKindLabel,
} from '../../stores/filterStore.js'
import { fractionPercent, phaseDegrees, plainFormat } from './deviceFormat.js'
import { useLiveFrame } from './filterLive.js'
import styles from './FilterDevice.module.css'

// The Xleth Filter's modulators: an addable list of lanes (any mix of LFO,
// Envelope and Dynamics follower, up to six per slot, each aimed at one of the
// slot's knobs) and the editor for the selected lane. Every control writes the
// exact slot-relative parameter the editor did ("m2_depth" and so on) through the
// store's setModParam / setCutMin / setCutMax. A lane's `kind` is its existence:
// adding is one write, removing is kind = off.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

const DEST_OPTIONS = MOD_DESTS.map((d) => ({ value: d.value, label: d.label }))
const SHAPE_OPTIONS = LFO_SHAPES.map((s) => ({ value: s.value, label: s.label.replace('↑', 'up').replace('↓', 'down') }))
const DIV_OPTIONS = LFO_SYNC_DIVISIONS.map((d) => ({ value: d.value, label: d.label }))
const RATE_MODES = [
  { value: 1, label: 'Sync', hint: 'Rate is a note value from the project tempo' },
  { value: 0, label: 'Free', hint: 'Rate is a time in milliseconds' },
]
const ADD_OPTIONS = MOD_KINDS.map((k) => ({ value: k.value, label: k.label }))

const TIME_2000 = skewScale(0, 2000, 0.4)
const TIME_5000 = skewScale(0, 5000, 0.4)
const RATE_SCALE = skewScale(1, 5000, 0.35)
const DYN_ATTACK = skewScale(0.1, 100, 0.4)
const DYN_RELEASE = skewScale(1, 2000, 0.4)
const CUT_SCALE = skewScale(20, 20000, 0.23)

const laneDest = (mod) => clamp(Math.round(mod.dest ?? 0), 0, 5)

// ── Live bits ───────────────────────────────────────────────────────────────

/** The lane's own activity light: brightness rides |source| (an LFO breathes, an envelope flashes). */
export function ModActivityDot({ bus, slotIndex, lane }) {
  const ref = useRef(null)
  useLiveFrame(bus, (frame) => {
    const el = ref.current
    if (!el) return
    const src = frame?.slots?.[slotIndex]?.lanes?.[lane]?.src
    const a = Number.isFinite(src) ? Math.min(1, Math.abs(src)) : 0
    el.style.opacity = (0.25 + 0.75 * a).toFixed(3)
  })
  return <span className={styles.dot} ref={ref} aria-hidden="true" />
}

/**
 * The modulator's own output, live. An LFO swings either side of centre; an
 * envelope and a follower fill from the left because neither goes negative.
 * Written straight to the DOM nodes, never through state.
 */
function LaneMeter({ bus, slotIndex, lane, bipolar }) {
  const fillRef = useRef(null)
  const textRef = useRef(null)
  useLiveFrame(bus, (frame) => {
    const src = frame?.slots?.[slotIndex]?.lanes?.[lane]?.src
    const v = Number.isFinite(src) ? clamp(src, -1, 1) : 0
    const fill = fillRef.current
    if (fill) {
      if (bipolar) {
        const half = Math.abs(v) * 50
        fill.style.left = `${(v >= 0 ? 50 : 50 - half).toFixed(2)}%`
        fill.style.width = `${half.toFixed(2)}%`
      } else {
        fill.style.left = '0%'
        fill.style.width = `${(Math.max(0, v) * 100).toFixed(2)}%`
      }
    }
    const t = textRef.current
    if (t) {
      const s = formatValue(v, 'dB', { unitless: true, decimals: 2, signed: bipolar })
      if (t.textContent !== s) t.textContent = s
    }
  })
  return (
    <div className={styles.laneMeter} data-hint="The modulator's output right now">
      <span className={styles.caption}>Out</span>
      <div className={styles.laneTrack} data-bipolar={bipolar || undefined}>
        <div className={styles.laneFill} ref={fillRef} data-filter-lane-fill="" />
      </div>
      <span className={styles.laneReadout} ref={textRef} data-filter-lane-readout="">
        {formatValue(0, 'dB', { unitless: true, decimals: 2, signed: bipolar })}
      </span>
    </div>
  )
}

// ── Lane list ───────────────────────────────────────────────────────────────

export function ModulatorList({ slotIndex, mods, selectedLane, onSelect, onAdd, onRemove, liveBus }) {
  const full = mods.length >= MAX_MODS_PER_SLOT
  return (
    <div className={styles.laneList}>
      <div className={styles.laneAdd}>
        <Select
          size="sm"
          ariaLabel="Add modulator"
          value=""
          placeholder={`Add modulator (${mods.length}/${MAX_MODS_PER_SLOT})`}
          options={ADD_OPTIONS}
          disabled={full}
          onChange={(kind) => onAdd(slotIndex, kind)}
          hint={full ? `This slot already has ${MAX_MODS_PER_SLOT} modulators` : 'Add an LFO, an envelope or a dynamics follower to this slot'}
        />
      </div>
      {mods.length === 0 ? (
        <p className={styles.empty}>No modulators on this slot. Each one moves one of its knobs live.</p>
      ) : mods.map((mod) => {
        const lane = Number(mod.index ?? 0)
        const kind = Number(mod.kind)
        const depth = Number(mod.depth ?? 0)
        const idle = kind === MOD_KIND_DYN && depth === 0
        return (
          <div key={lane} className={styles.laneRow} data-selected={lane === selectedLane || undefined} data-idle={idle || undefined}>
            <button
              type="button"
              className={styles.laneSelect}
              aria-pressed={lane === selectedLane}
              onClick={() => onSelect(lane)}
              data-hint={idle ? 'A dynamics follower does nothing until its depth is not 0' : 'Edit this modulator'}
            >
              <ModActivityDot bus={liveBus} slotIndex={slotIndex} lane={lane} />
              <span className={styles.laneName}>M{lane + 1} {modKindLabel(kind)}</span>
              <span className={styles.laneDest}>{DEST_OPTIONS[laneDest(mod)].label}</span>
              <span className={styles.laneDepth}>{formatValue(depth, 'dB', { unitless: true, decimals: 2, signed: true })}</span>
            </button>
            <IconButton size="sm" label={`Remove modulator M${lane + 1}`} onClick={() => onRemove(slotIndex, lane)}>
              <X aria-hidden="true" />
            </IconButton>
          </div>
        )
      })}
    </div>
  )
}

// ── Envelope preview ────────────────────────────────────────────────────────

/** A static ADSR picture drawn from the lane's own parameters. */
function EnvViz({ attack, hold, decay, sustain, release }) {
  const canvasRef = useRef(null)
  const themeEpoch = useThemeEpoch()
  const dprEpoch = useDprEpoch()

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const cssW = canvas.clientWidth
    const cssH = canvas.clientHeight
    if (cssW < 16 || cssH < 16) return
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const tw = Math.round(cssW * dpr)
    const th = Math.round(cssH * dpr)
    if (canvas.width !== tw || canvas.height !== th) { canvas.width = tw; canvas.height = th }
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const cs = getComputedStyle(canvas)
    const get = (n, fb) => cs.getPropertyValue(n).trim() || fb
    const ground = get('--ui-g0', '#141414')
    const grid = get('--ui-g4', '#3A3A3A')
    const value = get('--ui-value', '#33CED6')

    ctx.fillStyle = ground
    ctx.fillRect(0, 0, cssW, cssH)

    const padX = 8
    const padY = 6
    const plotW = Math.max(10, cssW - padX * 2)
    const plotH = Math.max(10, cssH - padY * 2)
    const yBot = padY + plotH
    const yOf = (v) => yBot - clamp(v, 0, 1) * plotH

    const a = Math.max(0, attack)
    const h = Math.max(0, hold)
    const d = Math.max(0, decay)
    const r = Math.max(0, release)
    const timeSum = a + h + d + r
    const sustainFrac = 0.22
    const timeFrac = 1 - sustainFrac
    const wOf = (t, fallback) => (timeSum > 0 ? t / timeSum : fallback) * timeFrac * plotW
    const wA = wOf(a, 0.34)
    const wH = wOf(h, 0)
    const wD = wOf(d, 0.33)
    const wR = wOf(r, 0.33)
    const wS = sustainFrac * plotW
    const s = clamp(sustain, 0, 1)

    let x = padX
    const pts = [[x, yOf(0)]]
    x += wA; pts.push([x, yOf(1)])
    x += wH; pts.push([x, yOf(1)])
    x += wD; pts.push([x, yOf(s)])
    x += wS; pts.push([x, yOf(s)])
    x += wR; pts.push([x, yOf(0)])

    ctx.strokeStyle = grid
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(padX, yBot + 0.5); ctx.lineTo(padX + plotW, yBot + 0.5); ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(pts[0][0], yBot)
    pts.forEach((p) => ctx.lineTo(p[0], p[1]))
    ctx.lineTo(pts[pts.length - 1][0], yBot)
    ctx.closePath()
    ctx.fillStyle = value
    ctx.globalAlpha = 0.14
    ctx.fill()
    ctx.globalAlpha = 1

    ctx.beginPath()
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])))
    ctx.strokeStyle = value
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.stroke()

    ctx.fillStyle = value
    for (const i of [1, 3, 4]) {
      ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], 2.4, 0, 2 * Math.PI); ctx.fill()
    }
    // Sustain level, in words, so the picture has its one number.
    ctx.font = uiCanvasFont('10px')
    ctx.fillStyle = get('--ui-ink-3', '#929292')
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText(`Sustain ${formatValue(s * 100, '%')}`, cssW - 6, 3)
  }, [attack, hold, decay, sustain, release])

  useEffect(() => { paint() }, [paint, themeEpoch, dprEpoch])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => paint())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [paint])

  return <canvas ref={canvasRef} className={styles.envViz} role="img" aria-label="Envelope shape" />
}

// ── Lane editor ─────────────────────────────────────────────────────────────

function LaneKnob({ id, label, value, scale, min, max, def, unit, format, parse, onMod, width = 64 }) {
  return (
    <Knob
      label={label}
      value={value}
      scale={scale}
      min={min}
      max={max}
      defaultValue={def}
      unit={unit}
      format={format}
      parse={parse}
      size={40}
      width={width}
      onChange={(v) => onMod(id, v)}
      onCommit={(v) => onMod(id, v)}
      data-param={id}
    />
  )
}

function LfoBody({ mod, onMod }) {
  const sync = Math.round(mod.rate_mode ?? 1) !== 0
  return (
    <>
      <div className={styles.editRow}>
        <Select
          size="sm"
          ariaLabel="LFO shape"
          value={clamp(Math.round(mod.shape ?? 0), 0, 5)}
          options={SHAPE_OPTIONS}
          onChange={(v) => onMod('shape', v)}
        />
        <SegmentedControl
          size="sm"
          label="LFO rate mode"
          value={sync ? 1 : 0}
          options={RATE_MODES}
          onChange={(v) => onMod('rate_mode', v)}
        />
      </div>
      <div className={styles.editRow}>
        {sync ? (
          <Select
            size="sm"
            ariaLabel="LFO division"
            value={Number(mod.sync ?? 4)}
            options={DIV_OPTIONS}
            onChange={(v) => onMod('sync', v)}
          />
        ) : (
          <LaneKnob id="rate_ms" label="Rate" value={Number(mod.rate_ms ?? 500)} scale={RATE_SCALE} def={500} unit="ms" onMod={onMod} />
        )}
        <LaneKnob id="phase" label="Phase" value={Number(mod.phase ?? 0)} min={0} max={1} def={0} {...phaseDegrees} onMod={onMod} />
      </div>
    </>
  )
}

function EnvBody({ mod, onMod }) {
  const attack = Number(mod.attack ?? 5)
  const hold = Number(mod.hold ?? 0)
  const decay = Number(mod.decay ?? 120)
  const sustain = Number(mod.sustain ?? 0.7)
  const release = Number(mod.release ?? 200)
  return (
    <>
      <div className={styles.editRow}>
        <LaneKnob id="attack" label="Attack" value={attack} scale={TIME_2000} def={5} unit="ms" onMod={onMod} width={58} />
        <LaneKnob id="hold" label="Hold" value={hold} scale={TIME_2000} def={0} unit="ms" onMod={onMod} width={58} />
        <LaneKnob id="decay" label="Decay" value={decay} scale={TIME_2000} def={120} unit="ms" onMod={onMod} width={58} />
        <LaneKnob id="sustain" label="Sustain" value={sustain} min={0} max={1} def={0.7} {...fractionPercent} onMod={onMod} width={58} />
        <LaneKnob id="release" label="Release" value={release} scale={TIME_5000} def={200} unit="ms" onMod={onMod} width={58} />
      </div>
      <EnvViz attack={attack} hold={hold} decay={decay} sustain={sustain} release={release} />
      <Toggle
        size="sm"
        on={!!mod.slides}
        onChange={(on) => onMod('slides', on ? 1 : 0)}
        hint="Retrigger the envelope on slide notes too"
      >
        Trigger on slide notes
      </Toggle>
    </>
  )
}

function DynBody({ mod, onMod, onCutMin, onCutMax }) {
  return (
    <div className={styles.editRow}>
      <LaneKnob id="dyn_attack" label="Attack" value={Number(mod.dyn_attack ?? 10)} scale={DYN_ATTACK} def={10} unit="ms" onMod={onMod} />
      <LaneKnob id="dyn_release" label="Release" value={Number(mod.dyn_release ?? 100)} scale={DYN_RELEASE} def={100} unit="ms" onMod={onMod} />
      <Knob
        label="Cut min"
        value={Number(mod.cut_min ?? 20)}
        scale={CUT_SCALE}
        defaultValue={20}
        unit="Hz"
        size={40}
        width={64}
        onChange={onCutMin}
        onCommit={onCutMin}
        data-param="cut_min"
      />
      <Knob
        label="Cut max"
        value={Number(mod.cut_max ?? 20000)}
        scale={CUT_SCALE}
        defaultValue={20000}
        unit="Hz"
        size={40}
        width={64}
        onChange={onCutMax}
        onCommit={onCutMax}
        data-param="cut_max"
      />
    </div>
  )
}

/** The selected lane: destination and depth for every kind, then the kind's own controls. */
export function ModulatorEditor({ slotIndex, mod, onModParam, onCutMin, onCutMax, liveBus }) {
  const lane = Number(mod.index ?? 0)
  const kind = Number(mod.kind)
  const onMod = useCallback((name, value) => onModParam(slotIndex, lane, name, value), [onModParam, slotIndex, lane])
  const depth = Number(mod.depth ?? 0)
  return (
    <div className={styles.editor} data-kind={kind}>
      <div className={styles.editRow}>
        <Select
          size="sm"
          ariaLabel="Modulator destination"
          value={laneDest(mod)}
          options={DEST_OPTIONS}
          onChange={(v) => onMod('dest', v)}
          hint="The knob this modulator moves"
        />
        <NumberBox
          label="Depth"
          value={depth}
          min={-1}
          max={1}
          bipolar
          defaultValue={0}
          width={84}
          format={plainFormat(2, true)}
          quantize={(v) => Math.round(v * 100) / 100}
          step={0.01}
          onChange={(v) => onMod('depth', v)}
          onCommit={(v) => onMod('depth', v)}
          data-param="depth"
        />
      </div>
      <LaneMeter bus={liveBus} slotIndex={slotIndex} lane={lane} bipolar={kind === MOD_KIND_LFO} />
      {kind === MOD_KIND_LFO ? <LfoBody mod={mod} onMod={onMod} /> : null}
      {kind === MOD_KIND_ENV ? <EnvBody mod={mod} onMod={onMod} /> : null}
      {kind === MOD_KIND_DYN ? (
        <DynBody
          mod={mod}
          onMod={onMod}
          onCutMin={(v) => onCutMin(slotIndex, lane, v)}
          onCutMax={(v) => onCutMax(slotIndex, lane, v)}
        />
      ) : null}
    </div>
  )
}

