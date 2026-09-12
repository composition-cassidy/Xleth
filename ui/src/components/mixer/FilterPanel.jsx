import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { X, Plus, Info } from 'lucide-react'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import useFilterStore, {
  SLOT_TYPES, SLOPES, MAX_SLOTS,
  MOD_DESTS, LFO_SHAPES, LFO_SYNC_DIVISIONS,
  MOD_KINDS, MOD_KIND_OFF, MOD_KIND_LFO, MOD_KIND_ENV, MOD_KIND_DYN,
  MAX_MODS_PER_SLOT, modKindLabel, activeMods,
  typeUsesGain, typeUsesMorph, typeUsesSlope,
  typeGainLabel, typeGainRange, typeMorphLabel,
  decodeLiveState, slotWithLiveValues, hasAnyModulator,
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
import EffectPresetBar from '../../fx-presets/EffectPresetBar.jsx'

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

// ModDest index → the knob it moves, in the order MOD_DESTS declares them.
const MOD_DEST_FIELDS = ['cutoff', 'q', 'gain', 'morph', 'drive', 'mix']

// How far a live value has to sit from the parked one before the panel prints
// it, per destination and in that destination's own units. Below these the two
// numbers would read identically anyway and the extra line is just flicker.
const LIVE_EPSILON = {
  cutoff: 0.5,    // Hz
  q:      0.005,
  gain:   0.05,   // dB
  morph:  0.002,
  drive:  0.05,   // dB
  mix:    0.002,
}

// The guide curves are recomputed every animation frame, so they are sampled
// coarser than the parked ones: at the well's ~736px width a 256-point hairline
// is indistinguishable from a 512-point one and costs half as much per frame.
const LIVE_GUIDE_SIZE = 256

// ── Live frame plumbing ───────────────────────────────────────────────────────
// The engine's live state arrives ~30 times a second. None of it goes through
// React state: the panel owns one Set of subscribers, the poll loop hands each
// of them the decoded frame, and each subscriber paints straight into a canvas
// or a DOM node it already holds. A setState at frame rate would re-render every
// knob, select and canvas in the panel for a number two pixels care about.

function useLiveFrame(bus, fn) {
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    if (!bus) return undefined
    // The registered callback is stable for the subscriber's lifetime and reads
    // the latest closure through the ref, so a re-render never churns the Set.
    const cb = (frame) => fnRef.current(frame)
    bus.add(cb)
    return () => { bus.delete(cb) }
  }, [bus])
}

// ── Small building blocks ─────────────────────────────────────────────────────

// The live, post-modulation value of one slot knob, printed under the parked
// one. Blank whenever the engine has no live reading or the modulators are not
// actually moving this knob, so a knob nothing points at looks exactly as it
// did before any of this existed.
function LiveKnobValue({ bus, slotIndex, field, fmt, base, epsilon }) {
  const ref = useRef(null)
  useLiveFrame(bus, (frame) => {
    const el = ref.current
    if (!el) return
    const ls = frame?.slots?.[slotIndex]
    const v = (ls && ls.valid) ? ls[field] : null
    const text = (Number.isFinite(v) && Math.abs(v - base) > epsilon) ? fmt(v) : ''
    if (el.textContent !== text) el.textContent = text
  })
  return <div className="filter-knob-live" ref={ref} />
}

// Stock mixer-ring knob with the formatted value printed below. Passing
// liveField opts the cell into a second, accent-coloured readout that tracks
// where the slot's modulators have actually put this knob.
function FilterKnob({ value, min, max, def, skew, label, fmt, onChange, size = 48,
                      paramId = null, automationTarget = null,
                      liveBus = null, liveSlot = -1, liveField = null }) {
  const v = Number.isFinite(value) ? value : def
  return (
    <div className="filter-knob-cell">
      <PluginUIKitKnob
        value={v} min={min} max={max} defaultValue={def} skew={skew || 1}
        label={label} formatValue={fmt} appearance={KNOB_APPEARANCE}
        size={size} dragRange={155}
        onLiveChange={onChange} onCommit={onChange}
        paramId={paramId} automationTarget={automationTarget}
      />
      <div className="filter-knob-value">{fmt(v)}</div>
      {liveBus && liveField && liveSlot >= 0 && (
        <LiveKnobValue
          bus={liveBus} slotIndex={liveSlot} field={liveField}
          fmt={fmt} base={v} epsilon={LIVE_EPSILON[liveField] ?? 1e-4} />
      )}
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

function ResponseCurve({ slots, selectedSlotIndex, aggregateRef, version,
                         liveBus = null, liveRef = null }) {
  const canvasRef = useRef(null)
  const themeEpoch = useThemeEpoch()
  // One cached guide curve per slot, keyed by the exact values it was drawn
  // from. A slot nothing modulates keeps the same key every frame and is never
  // recomputed, so an eight-slot filter with one moving slot costs one curve
  // per frame rather than eight.
  const guideCacheRef = useRef([])

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

    // The engine's live frame, if the panel is animating. `animating` means the
    // engine has actually composed at least one slot — not merely that a poll
    // came back — so a filter whose modulators exist but have never seen audio
    // draws exactly the parked picture it always did.
    const live = liveRef ? liveRef.current : null
    const animating = !!(live && live.slots && live.slots.some(s => s.valid))

    // Per-slot faint guide curves (client-side; sum in dB to the aggregate).
    // While animating each guide is drawn at its own MODULATED position, so a
    // slot sweeps under the aggregate instead of sitting still beneath it.
    const guideN = animating ? LIVE_GUIDE_SIZE : RESPONSE_SIZE
    const freqs = responseFrequencies(guideN)
    const cache = guideCacheRef.current
    slots.forEach((slot, si) => {
      const drawn = animating ? slotWithLiveValues(slot, live.slots[si]) : slot
      const key = `${guideN}|${drawn.enabled ? 1 : 0}|${drawn.type}|${drawn.slope}`
        + `|${drawn.cutoff}|${drawn.q}|${drawn.gain}|${drawn.morph}|${drawn.mix}`
      let entry = cache[si]
      if (!entry || entry.key !== key) {
        entry = { key, curve: slotResponseDb(drawn, live?.sampleRate || 44100, guideN) }
        cache[si] = entry
      }
      const curve = entry.curve
      if (!curve) return
      const isSel = si === selectedSlotIndex
      ctx.beginPath()
      for (let i = 0; i < guideN; i++) {
        const x = xOf(freqs[i])
        const y = yOf(curve[i])
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = withAlpha(th.accent, isSel ? 0.5 : 0.2)
      ctx.lineWidth = isSel ? 1.5 : 1
      ctx.stroke()
    })
    cache.length = slots.length

    // Aggregate. `agg` is the PARKED curve — the authoritative array from
    // audio_filterGetResponseCurve, i.e. where the knobs are sitting. While
    // animating it drops back to a dashed ghost and the bold line becomes the
    // engine's live curve, so the sweep is always read against its own rest
    // position instead of against nothing.
    const agg = aggregateRef.current
    const strokeCurve = (arr, alpha, width, dashed) => {
      const n = Math.min(arr.length, RESPONSE_SIZE)
      if (n < 2) return
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1)
        const f = Math.exp(logMin + t * (logMax - logMin))
        const x = xOf(f)
        const y = yOf(arr[i])
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      if (dashed) ctx.setLineDash([3, 3])
      ctx.strokeStyle = alpha >= 1 ? th.accent : withAlpha(th.accent, alpha)
      ctx.lineWidth = width
      ctx.stroke()
      if (dashed) ctx.setLineDash([])
    }

    const hasAgg = agg && agg.length > 1
    if (animating && live.curve && live.curve.length > 1) {
      if (hasAgg) strokeCurve(agg, 0.3, 1, true)
      strokeCurve(live.curve, 1, 2, false)

      // Where the selected slot's corner actually is this instant. The vertical
      // rule is the part that reads as movement on a flat low-pass curve, whose
      // shape barely changes as it sweeps.
      const ls = live.slots[selectedSlotIndex]
      if (ls && ls.valid && ls.cutoff >= FREQ_MIN && ls.cutoff <= FREQ_MAX) {
        const mx = Math.round(xOf(ls.cutoff)) + 0.5
        ctx.strokeStyle = withAlpha(th.accent, 0.45)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(mx, padT)
        ctx.lineTo(mx, padB)
        ctx.stroke()

        // The dot rides the bold curve at that frequency.
        const t = (Math.log(ls.cutoff) - logMin) / (logMax - logMin)
        const idx = clamp(Math.round(t * (live.curve.length - 1)), 0, live.curve.length - 1)
        ctx.fillStyle = th.accent
        ctx.beginPath()
        ctx.arc(mx, yOf(live.curve[idx]), 2.6, 0, 2 * Math.PI)
        ctx.fill()
      }
    } else if (hasAgg) {
      strokeCurve(agg, 1, 2, false)
    } else if (slots.length === 0) {
      ctx.font = MONO
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = withAlpha(th.textSubtle, 0.8)
      ctx.fillText('Add a slot to start filtering', (padL + padR) / 2, (padT + padB) / 2)
    }
  }, [slots, selectedSlotIndex, version, themeEpoch, aggregateRef, liveRef])

  useEffect(() => { paint() }, [paint])

  // Every live frame repaints the well. `paint` reads liveRef at call time, so
  // the subscription never has to be torn down and rebuilt as frames arrive.
  useLiveFrame(liveBus, () => { paint() })

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

// The lane's own activity light. Brightness and size ride |source|, so an LFO's
// dot breathes at its rate and an envelope's flashes on each note — visible from
// the slot rail without reading the meter below it.
function ModActivityDot({ bus, slotIndex, lane }) {
  const ref = useRef(null)
  useLiveFrame(bus, (frame) => {
    const el = ref.current
    if (!el) return
    const src = frame?.slots?.[slotIndex]?.lanes?.[lane]?.src
    const a = Number.isFinite(src) ? Math.min(1, Math.abs(src)) : 0
    el.style.opacity = (0.25 + 0.75 * a).toFixed(3)
    el.style.transform = `scale(${(1 + 0.6 * a).toFixed(3)})`
  })
  return <span className="filter-mod-dot" ref={ref} aria-hidden />
}

// The modulator's own output, live — the thing that actually makes a lane look
// like it is running. An LFO swings either side of centre at its rate; an
// envelope and a follower fill from the left, because neither ever goes
// negative. Everything is written straight to the DOM node, never through state.
function ModLiveMeter({ bus, slotIndex, lane, bipolar }) {
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
      const s = `${bipolar && v >= 0 ? '+' : ''}${v.toFixed(2)}`
      if (t.textContent !== s) t.textContent = s
    }
  })
  return (
    <div className="filter-mod-live">
      <span className="filter-field-label">Out</span>
      <div className={`filter-mod-live-track${bipolar ? ' bipolar' : ''}`}>
        <div className="filter-mod-live-fill" ref={fillRef} />
      </div>
      <span className="filter-mod-live-readout" ref={textRef}>
        {bipolar ? '+0.00' : '0.00'}
      </span>
    </div>
  )
}

// Shared header: kind badge, a live dot, and the remove button. A lane's
// EXISTENCE is now its on state — there is no separate toggle, because you add
// exactly the modulators you want and remove the ones you don't.
function ModHeader({ title, badge, onRemove, dot = null }) {
  return (
    <div className="filter-col-title-row">
      <span className="filter-mod-badge">{badge}</span>
      <span className="filter-col-title">{title}</span>
      {dot || <span className="filter-mod-dot" aria-hidden />}
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
function ModDeck({ slotIndex, mod, onModParam, onRemove, onCutMin, onCutMax, liveBus = null }) {
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
        onRemove={() => onRemove(slotIndex, lane)}
        dot={liveBus
          ? <ModActivityDot bus={liveBus} slotIndex={slotIndex} lane={lane} />
          : null} />
      <ModDestDepth dest={dest} depth={depth}
        onDest={(v) => onMod('dest', v)}
        onDepth={(v) => onMod('depth', v)} />
      {liveBus && (
        <ModLiveMeter bus={liveBus} slotIndex={slotIndex} lane={lane}
          bipolar={kind === MOD_KIND_LFO} />
      )}
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
                        onCutMin, onCutMax, automationTarget = null, liveBus = null }) {
  // Slot parameters are APVTS-prefixed per slot ("s<index>_<name>"), matching
  // XlethFilterEffect::createLayout — that prefix IS the automation binding's
  // parameterId. The modulator-lane sub-parameters below carry a further lane
  // prefix and are not wired for automation in this pass.
  const slotParamId = (name) => `s${index}_${name}`
  const type = clamp(Math.round(slot.type ?? 0), 0, 8)
  const slope = clamp(Math.round(slot.slope ?? 1), 0, 3)
  const mods = activeMods(slot)

  // Only the knobs something is actually AIMED at get a live readout. The blank
  // readout row still holds its height once a lane points at a knob — otherwise
  // the whole deck would jog by a line every time a modulator crossed back
  // through its parked value — but a knob no lane touches, and every knob on a
  // slot with no modulators at all, renders exactly as it did before.
  const liveFields = useMemo(() => {
    const set = new Set()
    for (const m of mods) set.add(MOD_DEST_FIELDS[clamp(Math.round(m.dest ?? 0), 0, 5)])
    return set
  }, [mods])
  const busFor = (field) => (liveBus && liveFields.has(field) ? liveBus : null)

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
              paramId={slotParamId('cutoff')} automationTarget={automationTarget}
              liveBus={busFor('cutoff')} liveSlot={index} liveField="cutoff"
              onChange={(v) => onParam(index, 'cutoff', v)} />
            <FilterKnob value={Number(slot.q ?? 0.7071)} min={0.5} max={30} def={0.7071}
              skew={Q_SKEW} label="Q" fmt={fmtQ}
              paramId={slotParamId('q')} automationTarget={automationTarget}
              liveBus={busFor('q')} liveSlot={index} liveField="q"
              onChange={(v) => onParam(index, 'q', v)} />
            {typeUsesGain(type) && (
              <FilterKnob value={Number(slot.gain ?? 0)}
                min={typeGainRange(type).min} max={typeGainRange(type).max} def={0}
                label={typeGainLabel(type)} fmt={fmtGain}
                paramId={slotParamId('gain')} automationTarget={automationTarget}
                liveBus={busFor('gain')} liveSlot={index} liveField="gain"
                onChange={(v) => onParam(index, 'gain', v)} />
            )}
            {typeUsesMorph(type) && (
              <FilterKnob value={Number(slot.morph ?? 0)} min={0} max={1} def={0}
                label={typeMorphLabel(type)} fmt={fmtMorph}
                paramId={slotParamId('morph')} automationTarget={automationTarget}
                liveBus={busFor('morph')} liveSlot={index} liveField="morph"
                onChange={(v) => onParam(index, 'morph', v)} />
            )}
          </div>
        </div>

        <div className="filter-col filter-col-shape">
          <div className="filter-col-title">Shape</div>
          <div className="filter-knob-row">
            <FilterKnob value={Number(slot.drive ?? 0)} min={0} max={24} def={0}
              label="DRIVE" fmt={fmtDrive}
              paramId={slotParamId('drive')} automationTarget={automationTarget}
              liveBus={busFor('drive')} liveSlot={index} liveField="drive"
              onChange={(v) => onParam(index, 'drive', v)} />
            <FilterKnob value={Number(slot.mix ?? 1)} min={0} max={1} def={1}
              label="MIX" fmt={fmtMix}
              paramId={slotParamId('mix')} automationTarget={automationTarget}
              liveBus={busFor('mix')} liveSlot={index} liveField="mix"
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
            liveBus={liveBus}
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

  // The live animation frame, and the subscribers that paint it. Both are refs:
  // a frame arrives ~30 times a second and must not re-render the panel.
  const liveRef = useRef(null)
  const liveBusRef = useRef(null)
  if (liveBusRef.current === null) liveBusRef.current = new Set()
  const liveBus = liveBusRef.current

  // Nothing to animate unless a modulator exists — a filter that is only knobs
  // never starts the loop, and never costs a poll.
  const modulated = useMemo(() => hasAnyModulator(slots), [slots])

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

  // ── The animation loop ─────────────────────────────────────────────────────
  // One rAF loop, throttled to ~30 Hz, that pulls the engine's live state and
  // hands it to every subscriber. It exists only while the panel is open AND the
  // filter actually has a modulator on it; closing the panel unmounts this
  // component, which cancels the frame and leaves zero background work behind.
  useEffect(() => {
    if (!target || !modulated) {
      // Drop any stale frame so the well falls straight back to the parked
      // picture rather than freezing on the last modulated one.
      if (liveRef.current) {
        liveRef.current = null
        liveBus.forEach(cb => cb(null))
      }
      return undefined
    }

    let active = true
    let rafId = 0
    let last = 0
    let inFlight = false

    const tick = async (now) => {
      if (!active) return
      // A hidden window still fires rAF in some Electron configurations; there
      // is nothing to look at, so there is nothing to poll for.
      if (now - last >= 33 && !inFlight && !document.hidden) {
        last = now
        inFlight = true
        try {
          const buf = await useFilterStore.getState().fetchLiveState()
          const frame = decodeLiveState(buf)
          if (active && frame) {
            liveRef.current = frame
            liveBus.forEach(cb => cb(frame))
          }
        } catch {
          // A chain torn down between two frames is not an error worth logging
          // thirty times a second.
        } finally {
          inFlight = false
        }
      }
      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => {
      active = false
      cancelAnimationFrame(rafId)
      liveRef.current = null
    }
  }, [target, modulated, liveBus])

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

      <div className="fx-panel-preset-strip">
        <EffectPresetBar
          effectType="xlethfilter"
          target={target}
          onApplied={() => useFilterStore.getState().fetchSlots()}
        />
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
            liveBus={liveBus}
            liveRef={liveRef}
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
          automationTarget={target}
          liveBus={liveBus}
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
