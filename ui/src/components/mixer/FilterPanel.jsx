import React, { useState, useEffect, useRef, useCallback } from 'react'
import { X, Plus, Info } from 'lucide-react'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import useFilterStore, {
  SLOT_TYPES, SLOPES, MAX_SLOTS,
  MOD_DESTS, LFO_SHAPES, LFO_SYNC_DIVISIONS,
  MOD_KINDS, MOD_KIND_OFF, MOD_KIND_LFO, MOD_KIND_ENV, MOD_KIND_DYN,
  MAX_MODS_PER_SLOT, modKindLabel, activeMods,
  typeUsesGain, typeUsesMorph, typeUsesSlope,
  typeGainLabel, typeGainRange, typeMorphLabel,
} from '../../stores/filterStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'
import Fader from '../controls/Fader.jsx'
import { quantizedFromNorm } from '../../utils/sliderHelpers.js'
import {
  readMixerCanvasTheme, withAlpha, syncCanvasSize, MONO, MONO_SM,
} from './mixerCanvasTheme.js'
import {
  slotResponseDb, responseFrequencies, RESPONSE_SIZE, FREQ_MIN, FREQ_MAX,
} from './filterResponse.js'

// XLETH FILTER editor window. Flat, zero-radius console laid out in the same
// design language as the APEX panel: a chrome header with an accent tick + muted
// subtitle, a slot rail, an inset graph well, then a sectioned control deck whose
// columns are separated by 1px dividers (the border colour showing through a 1px
// gap). Colour is earned — the teal accent only lights active slots, the active
// slope, and live modulation. tokenValue() is never called at module scope.

// ── Constants ────────────────────────────────────────────────────────────────

// Same skews as the engine's createLayout(): knob travel matches each param's
// own NormalisableRange curve.
const FREQ_SKEW = 0.23
const Q_SKEW    = 0.18

// The mixer-ring knob preset hides its own value readout, so each cell prints
// the formatted value below — the APEX / Reverb / Delay convention.
const KNOB_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit' }

const TYPE_SHORT = ['LP', 'HP', 'BP', 'NOTCH', 'AP', 'PEAK', 'L.SHELF', 'H.SHELF', 'MORPH']

const DB_RANGE   = 24
const GRID_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const GRID_LABELS = { 20: '20', 100: '100', 1000: '1k', 10000: '10k', 20000: '20k' }
const DB_LINES = [-24, -12, 0, 12, 24]

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

const fmtHz = (v) => (v >= 1000
  ? `${(v / 1000).toFixed(2).replace(/\.?0+$/, '')} kHz`
  : `${Math.round(v)} Hz`)
const fmtQ    = (v) => v.toFixed(2)
const fmtGain = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`
const fmtDrive = (v) => `${v.toFixed(1)} dB`
const fmtMix  = (v) => `${Math.round(v * 100)} %`
const fmtMorph = (v) => v.toFixed(2)
const fmtMs   = (v) => (v >= 100 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`)

// ── Small building blocks ─────────────────────────────────────────────────────

// Stock mixer-ring knob with the formatted value printed below.
function FilterKnob({ value, min, max, def, skew, label, fmt, onChange, size = 48 }) {
  const v = Number.isFinite(value) ? value : def
  return (
    <div className="filter-knob-cell">
      <PluginUIKitKnob
        value={v} min={min} max={max} defaultValue={def} skew={skew || 1}
        label={label} formatValue={fmt} appearance={KNOB_APPEARANCE}
        size={size} dragRange={155}
        onLiveChange={onChange} onCommit={onChange}
      />
      <div className="filter-knob-value">{fmt(v)}</div>
    </div>
  )
}

function SlotTab({ slot, index, selected, onSelect, onToggleEnabled, onRemove }) {
  const enabled = !!slot.enabled
  const type = clamp(Math.round(slot.type ?? 0), 0, 8)
  return (
    <div
      className={`filter-slot-tab${selected ? ' selected' : ''}${enabled ? '' : ' silenced'}`}
      onClick={() => onSelect(index)}
      title={`Slot ${index + 1} — ${SLOT_TYPES[type].label}`}
    >
      <button
        type="button"
        className={`filter-slot-enable${enabled ? ' on' : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggleEnabled(index, !enabled) }}
        title={enabled ? 'Bypass slot' : 'Enable slot'}
        aria-pressed={enabled}
      />
      <span className="filter-slot-idx">S{index + 1}</span>
      <span className="filter-slot-type">{TYPE_SHORT[type]}</span>
      <button
        type="button"
        className="filter-slot-remove"
        onClick={(e) => { e.stopPropagation(); onRemove(index) }}
        title="Remove slot"
      >
        <X size={11} />
      </button>
    </div>
  )
}

// ── Response curve (canvas only — no DOM overlays) ────────────────────────────

function ResponseCurve({ slots, selectedSlotIndex, aggregateRef, version }) {
  const canvasRef = useRef(null)
  const themeEpoch = useThemeEpoch()

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const size = syncCanvasSize(canvas, 736, 176)
    if (!size) return
    const { cssW, cssH, dpr } = size
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const th = readMixerCanvasTheme(canvas)

    const padL = 30
    const padR = cssW - 8
    const padT = 8
    const padB = cssH - 15
    const plotW = Math.max(10, padR - padL)
    const plotH = Math.max(10, padB - padT)

    const logMin = Math.log(FREQ_MIN)
    const logMax = Math.log(FREQ_MAX)
    const xOf = (f) => padL + ((Math.log(f) - logMin) / (logMax - logMin)) * plotW
    const yOf = (db) => padT + ((DB_RANGE - clamp(db, -DB_RANGE, DB_RANGE)) / (2 * DB_RANGE)) * plotH

    ctx.fillStyle = th.well
    ctx.fillRect(0, 0, cssW, cssH)

    // Frequency grid + sparse labels.
    ctx.strokeStyle = withAlpha(th.border, 0.9)
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const f of GRID_FREQS) {
      const gx = Math.round(xOf(f)) + 0.5
      ctx.moveTo(gx, padT)
      ctx.lineTo(gx, padB)
    }
    ctx.stroke()
    ctx.font = MONO_SM
    ctx.textBaseline = 'top'
    ctx.textAlign = 'center'
    ctx.fillStyle = withAlpha(th.textSubtle, 0.85)
    for (const f of GRID_FREQS) {
      if (!GRID_LABELS[f]) continue
      ctx.fillText(GRID_LABELS[f], xOf(f), padB + 3)
    }

    // dB grid + labels (0 dB rule emphasised).
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const db of DB_LINES) {
      const gy = Math.round(yOf(db)) + 0.5
      ctx.strokeStyle = db === 0 ? withAlpha(th.borderStrong, 1) : withAlpha(th.border, 0.7)
      ctx.beginPath()
      ctx.moveTo(padL, gy)
      ctx.lineTo(padR, gy)
      ctx.stroke()
      ctx.fillStyle = withAlpha(th.textSubtle, 0.85)
      ctx.fillText(`${db > 0 ? '+' : ''}${db}`, padL - 4, gy)
    }

    // Per-slot faint guide curves (client-side; sum in dB to the aggregate).
    const freqs = responseFrequencies(RESPONSE_SIZE)
    slots.forEach((slot, si) => {
      const curve = slotResponseDb(slot)
      if (!curve) return
      const isSel = si === selectedSlotIndex
      ctx.beginPath()
      for (let i = 0; i < RESPONSE_SIZE; i++) {
        const x = xOf(freqs[i])
        const y = yOf(curve[i])
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = withAlpha(th.accent, isSel ? 0.5 : 0.2)
      ctx.lineWidth = isSel ? 1.5 : 1
      ctx.stroke()
    })

    // Bold aggregate — authoritative array from audio_filterGetResponseCurve.
    const agg = aggregateRef.current
    if (agg && agg.length > 1) {
      const n = Math.min(agg.length, RESPONSE_SIZE)
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1)
        const f = Math.exp(logMin + t * (logMax - logMin))
        const x = xOf(f)
        const y = yOf(agg[i])
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = th.accent
      ctx.lineWidth = 2
      ctx.stroke()
    } else if (slots.length === 0) {
      ctx.font = MONO
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = withAlpha(th.textSubtle, 0.8)
      ctx.fillText('Add a slot to start filtering', (padL + padR) / 2, (padT + padB) / 2)
    }
  }, [slots, selectedSlotIndex, version, themeEpoch, aggregateRef])

  useEffect(() => { paint() }, [paint])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => paint())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [paint])

  return (
    <canvas
      ref={canvasRef}
      className="filter-response-canvas"
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}

// ── Per-slot modulator decks (LFO + Envelope) ─────────────────────────────────

// Shared header: kind badge, a live dot, and the remove button. A lane's
// EXISTENCE is now its on state — there is no separate toggle, because you add
// exactly the modulators you want and remove the ones you don't.
function ModHeader({ title, badge, onRemove }) {
  return (
    <div className="filter-col-title-row">
      <span className="filter-mod-badge">{badge}</span>
      <span className="filter-col-title">{title}</span>
      <span className="filter-mod-dot" aria-hidden />
      <button
        type="button"
        className="filter-mod-remove"
        onClick={onRemove}
        title="Remove this modulator"
        aria-label={`Remove ${title}`}
      >
        <X size={13} />
      </button>
    </div>
  )
}

// Shared destination select + signed depth slider.
function ModDestDepth({ dest, depth, onDest, onDepth }) {
  return (
    <div className="filter-mod-row">
      <label className="filter-field filter-field--inline">
        <span className="filter-field-label">Dest</span>
        <select className="filter-select" value={dest}
          onChange={(e) => onDest(Number(e.target.value))}>
          {MOD_DESTS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
      </label>
      <div className="filter-mod-depth">
        <span className="filter-field-label">Depth</span>
        <Fader
          orientation="horizontal" fill thickness={14}
          value={depth} min={-1} max={1} defaultValue={0}
          fromNorm={quantizedFromNorm(-1, 1, 0.01)}
          onLiveChange={(v) => onDepth(v)}
        />
        <span className="filter-depth-readout">{depth > 0 ? '+' : ''}{depth.toFixed(2)}</span>
      </div>
    </div>
  )
}

// Every deck below takes `mod` — one entry of the slot's `mods` array — and an
// `onMod(paramName, value)` already bound to that lane, so none of them needs to
// know its own lane index or build parameter names.

function LfoBody({ mod, onMod }) {
  const shape = clamp(Math.round(mod.shape ?? 0), 0, 5)
  const sync = Math.round(mod.rate_mode ?? 1) !== 0
  const syncVal = Number(mod.sync ?? 4)
  const rateMs = Number(mod.rate_ms ?? 500)
  const phase = Number(mod.phase ?? 0)
  return (
    <div className="filter-mod-row">
      <label className="filter-field filter-field--inline">
        <span className="filter-field-label">Shape</span>
        <select className="filter-select" value={shape}
          onChange={(e) => onMod('shape', Number(e.target.value))}>
          {LFO_SHAPES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </label>
      <div className="filter-field filter-field--inline">
        <span className="filter-field-label">Rate</span>
        <div className="filter-seg">
          <button type="button" className={`filter-seg-btn${sync ? ' active' : ''}`}
            onClick={() => onMod('rate_mode', 1)}>Sync</button>
          <button type="button" className={`filter-seg-btn${!sync ? ' active' : ''}`}
            onClick={() => onMod('rate_mode', 0)}>Free</button>
        </div>
      </div>
      {sync ? (
        <label className="filter-field filter-field--inline">
          <span className="filter-field-label">Div</span>
          <select className="filter-select" value={syncVal}
            onChange={(e) => onMod('sync', Number(e.target.value))}>
            {LFO_SYNC_DIVISIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </label>
      ) : (
        <FilterKnob value={rateMs} min={1} max={5000} def={500} skew={0.35}
          label="RATE" fmt={fmtMs} size={44}
          onChange={(v) => onMod('rate_ms', v)} />
      )}
      <FilterKnob value={phase} min={0} max={1} def={0} label="PHASE"
        fmt={(v) => `${Math.round(v * 360)}°`} size={44}
        onChange={(v) => onMod('phase', v)} />
    </div>
  )
}

// Static ADSR curve preview — draws A/H/D/S/R from the live envelope params.
// Segment widths scale with each stage's ms; the held sustain gets a fixed
// display slice (it has no intrinsic duration). Accent stroke over the well,
// same visual language as the response graph above.
function EnvViz({ attack, hold, decay, sustain, release }) {
  const canvasRef = useRef(null)
  const themeEpoch = useThemeEpoch()

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const size = syncCanvasSize(canvas, 360, 84)
    if (!size) return
    const { cssW, cssH, dpr } = size
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const th = readMixerCanvasTheme(canvas)

    ctx.fillStyle = th.well
    ctx.fillRect(0, 0, cssW, cssH)

    const padL = 8, padR = 8, padT = 10, padB = 10
    const plotW = Math.max(10, cssW - padL - padR)
    const plotH = Math.max(10, cssH - padT - padB)
    const yBot = padT + plotH
    const yOf = (v) => yBot - clamp(v, 0, 1) * plotH

    const a = Math.max(0, attack), h = Math.max(0, hold)
    const d = Math.max(0, decay), r = Math.max(0, release)
    const timeSum = a + h + d + r
    const sustainFrac = 0.22
    const timeFrac = 1 - sustainFrac
    const wOf = (t, fallback) => (timeSum > 0 ? t / timeSum : fallback) * timeFrac * plotW
    const wA = wOf(a, 0.34), wH = wOf(h, 0.0), wD = wOf(d, 0.33), wR = wOf(r, 0.33)
    const wS = sustainFrac * plotW
    const s = clamp(sustain, 0, 1)

    let x = padL
    const pts = [[x, yOf(0)]]
    x += wA; pts.push([x, yOf(1)])
    x += wH; pts.push([x, yOf(1)])
    x += wD; pts.push([x, yOf(s)])
    x += wS; pts.push([x, yOf(s)])
    x += wR; pts.push([x, yOf(0)])

    // Baseline + faint sustain guide line.
    ctx.strokeStyle = withAlpha(th.border, 0.8)
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(padL, yBot + 0.5); ctx.lineTo(padL + plotW, yBot + 0.5); ctx.stroke()

    // Fill under the curve.
    ctx.beginPath()
    ctx.moveTo(pts[0][0], yBot)
    pts.forEach(p => ctx.lineTo(p[0], p[1]))
    ctx.lineTo(pts[pts.length - 1][0], yBot)
    ctx.closePath()
    ctx.fillStyle = withAlpha(th.accent, 0.12)
    ctx.fill()

    // Stroke.
    ctx.beginPath()
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])))
    ctx.strokeStyle = th.accent
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.stroke()

    // Stage nodes at the peak, sustain-start and sustain-end.
    ctx.fillStyle = withAlpha(th.accent, 0.95)
    for (const i of [1, 3, 4]) {
      const p = pts[i]
      ctx.beginPath(); ctx.arc(p[0], p[1], 2.2, 0, 2 * Math.PI); ctx.fill()
    }
  }, [attack, hold, decay, sustain, release, themeEpoch])

  useEffect(() => { paint() }, [paint])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => paint())
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [paint])

  return (
    <canvas
      ref={canvasRef}
      className="filter-env-viz"
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
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
      <div className="filter-env-body">
        <div className="filter-knob-row filter-knob-row--left">
          <FilterKnob value={attack} min={0} max={2000} def={5}
            skew={0.4} label="ATTACK" fmt={fmtMs} size={44}
            onChange={(v) => onMod('attack', v)} />
          <FilterKnob value={hold} min={0} max={2000} def={0}
            skew={0.4} label="HOLD" fmt={fmtMs} size={44}
            onChange={(v) => onMod('hold', v)} />
          <FilterKnob value={decay} min={0} max={2000} def={120}
            skew={0.4} label="DECAY" fmt={fmtMs} size={44}
            onChange={(v) => onMod('decay', v)} />
          <FilterKnob value={sustain} min={0} max={1} def={0.7}
            label="SUSTAIN" fmt={(v) => v.toFixed(2)} size={44}
            onChange={(v) => onMod('sustain', v)} />
          <FilterKnob value={release} min={0} max={5000} def={200}
            skew={0.4} label="RELEASE" fmt={fmtMs} size={44}
            onChange={(v) => onMod('release', v)} />
        </div>
        <div className="filter-env-viz-wrap">
          <EnvViz attack={attack} hold={hold} decay={decay}
            sustain={sustain} release={release} />
        </div>
      </div>
      <label className="filter-slides-check">
        <input type="checkbox" checked={!!mod.slides}
          onChange={(e) => onMod('slides', e.target.checked ? 1 : 0)} />
        <span>Trigger on slide notes</span>
      </label>
    </>
  )
}

// The follower's ballistics plus ITS OWN sweep window. cut_min / cut_max are per
// lane, so two followers on one slot can sweep different ranges.
function DynBody({ mod, onCutMin, onCutMax, onMod }) {
  return (
    <div className="filter-knob-row filter-knob-row--left">
      <FilterKnob value={Number(mod.dyn_attack ?? 10)} min={0.1} max={100} def={10}
        skew={0.4} label="ATTACK" fmt={fmtMs} size={44}
        onChange={(v) => onMod('dyn_attack', v)} />
      <FilterKnob value={Number(mod.dyn_release ?? 100)} min={1} max={2000} def={100}
        skew={0.4} label="RELEASE" fmt={fmtMs} size={44}
        onChange={(v) => onMod('dyn_release', v)} />
      <FilterKnob value={Number(mod.cut_min ?? 20)} min={20} max={20000} def={20}
        skew={FREQ_SKEW} label="CUT MIN" fmt={fmtHz} size={44}
        onChange={onCutMin} />
      <FilterKnob value={Number(mod.cut_max ?? 20000)} min={20} max={20000} def={20000}
        skew={FREQ_SKEW} label="CUT MAX" fmt={fmtHz} size={44}
        onChange={onCutMax} />
    </div>
  )
}

// One modulator lane: header, the shared Dest + Depth row, then the body for
// whichever kind this lane is.
function ModDeck({ slotIndex, mod, onModParam, onRemove, onCutMin, onCutMax }) {
  const lane = Number(mod.index ?? 0)
  const kind = Number(mod.kind ?? MOD_KIND_OFF)
  const dest = clamp(Math.round(mod.dest ?? 0), 0, 5)
  const depth = Number(mod.depth ?? 0)
  // A follower is depth-gated; the other two are live the moment they exist.
  const active = kind === MOD_KIND_DYN ? depth !== 0 : true

  const onMod = useCallback(
    (name, value) => onModParam(slotIndex, lane, name, value),
    [onModParam, slotIndex, lane])

  return (
    <div className={`filter-col filter-col-dyn filter-mod-lane${active ? ' is-active' : ''}`}>
      <ModHeader
        title={modKindLabel(kind)}
        badge={`M${lane + 1}`}
        onRemove={() => onRemove(slotIndex, lane)} />
      <ModDestDepth dest={dest} depth={depth}
        onDest={(v) => onMod('dest', v)}
        onDepth={(v) => onMod('depth', v)} />
      {kind === MOD_KIND_LFO && <LfoBody mod={mod} onMod={onMod} />}
      {kind === MOD_KIND_ENV && <EnvBody mod={mod} onMod={onMod} />}
      {kind === MOD_KIND_DYN && (
        <DynBody mod={mod} onMod={onMod}
          onCutMin={(v) => onCutMin(slotIndex, lane, v)}
          onCutMax={(v) => onCutMax(slotIndex, lane, v)} />
      )}
    </div>
  )
}

// The "+ Add Modulator" affordance: one button per kind, all disabled once the
// slot's lanes are full.
function AddModulatorBar({ slotIndex, used, onAdd }) {
  const full = used >= MAX_MODS_PER_SLOT
  return (
    <div className="filter-mod-add">
      <span className="filter-field-label">
        Add modulator&nbsp;<span className="filter-mod-count">{used}/{MAX_MODS_PER_SLOT}</span>
      </span>
      <div className="filter-mod-add-btns">
        {MOD_KINDS.map(k => (
          <button
            key={k.id}
            type="button"
            className="filter-mod-add-btn"
            disabled={full}
            title={full
              ? `This slot already has ${MAX_MODS_PER_SLOT} modulators`
              : k.blurb}
            onClick={() => onAdd(slotIndex, k.value)}
          >
            <Plus size={12} />{k.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Selected-slot control deck ────────────────────────────────────────────────

function SlotControls({ slot, index, onParam, onModParam, onAddMod, onRemoveMod,
                        onCutMin, onCutMax }) {
  const type = clamp(Math.round(slot.type ?? 0), 0, 8)
  const slope = clamp(Math.round(slot.slope ?? 1), 0, 3)
  const mods = activeMods(slot)

  return (
    <>
      {/* Deck row 1 — filter shaping */}
      <div className="filter-deck">
        <div className="filter-col filter-col-filter">
          <div className="filter-col-title">Filter</div>
          <label className="filter-field">
            <span className="filter-field-label">Type</span>
            <select
              className="filter-select"
              value={type}
              onChange={(e) => onParam(index, 'type', Number(e.target.value))}
            >
              {SLOT_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </label>
          {typeUsesSlope(type) && (
            <div className="filter-field">
              <span className="filter-field-label">Slope&nbsp;dB/oct</span>
              <div className="filter-seg">
                {SLOPES.map(s => (
                  <button
                    key={s.value}
                    type="button"
                    className={`filter-seg-btn${slope === s.value ? ' active' : ''}`}
                    onClick={() => onParam(index, 'slope', s.value)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="filter-col filter-col-tone">
          <div className="filter-col-title">Tone</div>
          <div className="filter-knob-row">
            <FilterKnob value={Number(slot.cutoff ?? 1000)} min={20} max={20000} def={1000}
              skew={FREQ_SKEW} label="CUTOFF" fmt={fmtHz}
              onChange={(v) => onParam(index, 'cutoff', v)} />
            <FilterKnob value={Number(slot.q ?? 0.7071)} min={0.5} max={30} def={0.7071}
              skew={Q_SKEW} label="Q" fmt={fmtQ}
              onChange={(v) => onParam(index, 'q', v)} />
            {typeUsesGain(type) && (
              <FilterKnob value={Number(slot.gain ?? 0)}
                min={typeGainRange(type).min} max={typeGainRange(type).max} def={0}
                label={typeGainLabel(type)} fmt={fmtGain}
                onChange={(v) => onParam(index, 'gain', v)} />
            )}
            {typeUsesMorph(type) && (
              <FilterKnob value={Number(slot.morph ?? 0)} min={0} max={1} def={0}
                label={typeMorphLabel(type)} fmt={fmtMorph}
                onChange={(v) => onParam(index, 'morph', v)} />
            )}
          </div>
        </div>

        <div className="filter-col filter-col-shape">
          <div className="filter-col-title">Shape</div>
          <div className="filter-knob-row">
            <FilterKnob value={Number(slot.drive ?? 0)} min={0} max={24} def={0}
              label="DRIVE" fmt={fmtDrive}
              onChange={(v) => onParam(index, 'drive', v)} />
            <FilterKnob value={Number(slot.mix ?? 1)} min={0} max={1} def={1}
              label="MIX" fmt={fmtMix}
              onChange={(v) => onParam(index, 'mix', v)} />
          </div>
        </div>
      </div>

      {/* Modulators — an addable list, any mix of kinds, any mix of targets */}
      <div className="filter-deck">
        <div className="filter-col filter-col-mods">
          <AddModulatorBar slotIndex={index} used={mods.length} onAdd={onAddMod} />
          <div className="filter-mod-hint">
            <Info size={12} />
            <span>
              Every modulator composes live around this slot&apos;s knobs — no FX graph
              needed. Add as many as you like and point each one at a different knob.
            </span>
          </div>
          {mods.length === 0 && (
            <div className="filter-mod-empty">
              No modulators on this slot. Add an LFO, an Envelope or a Dynamics
              follower above to start moving its knobs.
            </div>
          )}
        </div>
      </div>

      {mods.map(mod => (
        <div className="filter-deck" key={mod.index}>
          <ModDeck
            slotIndex={index}
            mod={mod}
            onModParam={onModParam}
            onRemove={onRemoveMod}
            onCutMin={onCutMin}
            onCutMax={onCutMax}
          />
        </div>
      ))}
    </>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export default function FilterPanel() {
  const target = useFilterStore(s => s.target)
  const slots = useFilterStore(s => s.slots)
  const selectedSlotIndex = useFilterStore(s => s.selectedSlotIndex)
  const setSelectedSlot = useFilterStore(s => s.setSelectedSlot)
  const close = useFilterStore(s => s.close)

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 380),
    y: 72,
  }))
  const panelDragRef = useRef(null)

  const aggregateRef = useRef(null)
  const [curveVersion, setCurveVersion] = useState(0)
  const refreshTimerRef = useRef(null)

  const refreshCurve = useCallback(async () => {
    const c = await useFilterStore.getState().fetchResponseCurve()
    if (c && c.length > 1) {
      aggregateRef.current = c
      setCurveVersion(v => v + 1)
    }
  }, [])

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      refreshCurve()
    }, 100)
  }, [refreshCurve])

  useEffect(() => {
    if (!target) return
    refreshCurve()
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  }, [target, refreshCurve])

  const handleParam = useCallback((i, paramName, value) => {
    useFilterStore.getState().setSlotParam(i, paramName, value)
    scheduleRefresh()
  }, [scheduleRefresh])

  const handleModParam = useCallback((i, lane, paramName, value) => {
    useFilterStore.getState().setModParam(i, lane, paramName, value)
    scheduleRefresh()
  }, [scheduleRefresh])

  // Add / remove need a full refetch: the engine seeds a new lane with its
  // kind's defaults, and those come back in the next getSlots payload.
  const handleAddMod = useCallback(async (i, kind) => {
    await useFilterStore.getState().addModulator(i, kind)
    refreshCurve()
  }, [refreshCurve])

  const handleRemoveMod = useCallback(async (i, lane) => {
    await useFilterStore.getState().removeModulator(i, lane)
    await useFilterStore.getState().fetchSlots()
    refreshCurve()
  }, [refreshCurve])

  const handleCutMin = useCallback((i, lane, value) => {
    useFilterStore.getState().setCutMin(i, lane, value)
    scheduleRefresh()
  }, [scheduleRefresh])

  const handleCutMax = useCallback((i, lane, value) => {
    useFilterStore.getState().setCutMax(i, lane, value)
    scheduleRefresh()
  }, [scheduleRefresh])

  const handleToggleEnabled = useCallback((i, enabled) => {
    useFilterStore.getState().setSlotParam(i, 'enabled', enabled ? 1 : 0)
    scheduleRefresh()
  }, [scheduleRefresh])

  const handleAddSlot = useCallback(async () => {
    await useFilterStore.getState().addSlot()
    refreshCurve()
  }, [refreshCurve])

  const handleRemoveSlot = useCallback(async (i) => {
    await useFilterStore.getState().removeSlot(i)
    refreshCurve()
  }, [refreshCurve])

  const handleHeaderMouseDown = useCallback((e) => {
    if (e.target.closest('button') || e.target.closest('select') || e.target.closest('input')) return
    e.preventDefault()
    panelDragRef.current = {
      startMouseX: e.clientX, startMouseY: e.clientY,
      startPanelX: panelPos.x, startPanelY: panelPos.y,
    }
  }, [panelPos])

  useEffect(() => {
    const onMove = (e) => {
      if (!panelDragRef.current) return
      const { startMouseX, startMouseY, startPanelX, startPanelY } = panelDragRef.current
      setPanelPos({
        x: clamp(startPanelX + (e.clientX - startMouseX), -680, window.innerWidth - 100),
        y: clamp(startPanelY + (e.clientY - startMouseY), 0, window.innerHeight - 80),
      })
    }
    const onUp = () => { panelDragRef.current = null }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  if (!target) return null

  const selected = selectedSlotIndex >= 0 ? (slots[selectedSlotIndex] ?? null) : null

  return (
    <div className="filter-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      <div className="filter-panel-header" onMouseDown={handleHeaderMouseDown}>
        <span className="filter-panel-title">XLETH FILTER</span>
        <span className="filter-panel-sub">multi-slot filter</span>
        <div className="filter-header-actions">
          <button type="button" className="filter-panel-close" onClick={close} title="Close">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Slot rail */}
      <div className="filter-slot-rail">
        {Array.from({ length: MAX_SLOTS }, (_, i) => {
          if (i < slots.length) {
            return (
              <SlotTab
                key={i}
                slot={slots[i]}
                index={i}
                selected={i === selectedSlotIndex}
                onSelect={setSelectedSlot}
                onToggleEnabled={handleToggleEnabled}
                onRemove={handleRemoveSlot}
              />
            )
          }
          if (i === slots.length) {
            return (
              <button key={i} type="button" className="filter-slot-add" onClick={handleAddSlot} title="Add filter slot">
                <Plus size={14} />
              </button>
            )
          }
          return <div key={i} className="filter-slot-tab filter-slot-tab--ghost" aria-hidden />
        })}
      </div>

      {/* Graph well */}
      <div className="filter-graph-row">
        <div className="filter-graph-wrap">
          <ResponseCurve
            slots={slots}
            selectedSlotIndex={selectedSlotIndex}
            aggregateRef={aggregateRef}
            version={curveVersion}
          />
        </div>
      </div>

      {/* Control deck / empty state */}
      {selected ? (
        <SlotControls
          slot={selected}
          index={selectedSlotIndex}
          onParam={handleParam}
          onModParam={handleModParam}
          onAddMod={handleAddMod}
          onRemoveMod={handleRemoveMod}
          onCutMin={handleCutMin}
          onCutMax={handleCutMax}
        />
      ) : (
        <div className="filter-empty-state">
          {slots.length === 0
            ? 'No filter slots yet — press + to add one.'
            : 'Select a slot to edit its controls.'}
        </div>
      )}
    </div>
  )
}
