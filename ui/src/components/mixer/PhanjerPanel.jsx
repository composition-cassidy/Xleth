import { useState, useEffect, useRef, useCallback } from 'react'
import { X, HelpCircle, Plus, Minus } from 'lucide-react'
import usePhanjerStore from '../../stores/phanjerStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'
import XlethSelect from '../common/XlethSelect.jsx'
import PhanjerResponseCanvas from './PhanjerResponseCanvas.jsx'
import { clamp } from './mixerFilterMath.js'

const MIXER_RING_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit' }

// ── Parameter contract ────────────────────────────────────────────────────────
// Every id/range/default below matches PhanjerEffect.h createLayout() verbatim —
// all 23 params are AudioParameterFloat, so discrete ones (mode, syncs, divs,
// feels, shape, stages) are written as their integer index cast to a float and
// read back rounded. See PHANJER_HANDOFF.md §2.

const DEFAULT_PARAMS = {
  mode: 0,
  f_mix: 75, f_rate: 0.5, f_depth: 70, f_feedback: 40,
  f_delay_min: 1.0, f_delay_max: 5.0,
  f_sync: 0, f_sync_div: 2, f_sync_feel: 0,
  p_mix: 75, p_rate: 0.35, p_depth: 80, p_feedback: 40,
  p_stages: 6, p_freq_min: 100, p_freq_max: 4000,
  p_sync: 0, p_sync_div: 2, p_sync_feel: 0,
  global_mix: 50, lfo_shape: 0, chaos: 0,
}

const pct = v => `${Math.round(Number(v))} %`
const hz = v => `${Number(v).toFixed(2)} Hz`
const ms = v => `${Number(v).toFixed(2)} ms`
const freq = v => (Number(v) >= 1000 ? `${(Number(v) / 1000).toFixed(2)} kHz` : `${Math.round(Number(v))} Hz`)

// Flanger knobs, in the original's row order.
const FLANGER_KNOBS = [
  { id: 'f_mix',      label: 'MIX',      min: 0,    max: 100, default: 75, fmt: pct },
  { id: 'f_rate',     label: 'RATE',     min: 0.05, max: 10,  default: 0.5, fmt: hz, skew: 0.5 },
  { id: 'f_depth',    label: 'DEPTH',    min: 0,    max: 100, default: 70, fmt: pct },
  { id: 'f_feedback', label: 'FEEDBACK', min: -95,  max: 95,  default: 40, fmt: pct },
]

// Phaser knobs, in the original's row order (MIX, FEEDBACK, RATE, DEPTH).
const PHASER_KNOBS = [
  { id: 'p_mix',      label: 'MIX',      min: 0,    max: 100, default: 75, fmt: pct },
  { id: 'p_feedback', label: 'FEEDBACK', min: -95,  max: 95,  default: 40, fmt: pct },
  { id: 'p_rate',     label: 'RATE',     min: 0.05, max: 10,  default: 0.35, fmt: hz, skew: 0.5 },
  { id: 'p_depth',    label: 'DEPTH',    min: 0,    max: 100, default: 80, fmt: pct },
]

const MODES = [
  { id: 0, label: 'LINKED' },
  { id: 1, label: 'SMART' },
  { id: 2, label: 'WILD' },
]

// Choice indices → labels (engine encoding). f_sync_div/p_sync_div are 0–5.
const DIV_OPTIONS = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32'].map((label, value) => ({ value, label }))
const FEEL_OPTIONS = ['Straight', 'Triplet', 'Dotted'].map((label, value) => ({ value, label }))

// LFO shapes 0–4 with inline stylised icons (stroke inherits currentColor).
const SHAPE_PATHS = [
  'M1 7 C 4 0, 6 0, 10 7 C 14 14, 16 14, 19 7',        // sine
  'M1 11 L 6 3 L 11 11 L 16 3 L 19 7',                  // triangle
  'M1 11 L 7 3 L 7 11 L 13 3 L 13 11 L 19 3',           // saw
  'M1 11 L 1 3 L 6 3 L 6 11 L 12 11 L 12 3 L 18 3 L 18 11 L 19 11', // square
  'M1 8 L 4 4 L 6 11 L 9 6 L 12 12 L 15 3 L 17 9 L 19 6', // random
]
const SHAPE_LABELS = ['Sine', 'Triangle', 'Saw', 'Square', 'Random']

function ShapeIcon({ shape }) {
  return (
    <svg viewBox="0 0 20 14" width="20" height="14" aria-hidden="true">
      <path d={SHAPE_PATHS[shape]} fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

// Music-note glyph for the tempo-sync toggle.
function NoteIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M6 3 L13 1.5 L13 10.5" fill="none" stroke="currentColor" strokeWidth="1.4"
        strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="4" cy="11.5" r="2.3" fill="currentColor" />
      <circle cx="11" cy="11" r="2.3" fill="currentColor" />
    </svg>
  )
}

// ── Horizontal slider (DELAY / FREQ bounds) ──────────────────────────────────
// Log mapping matches the engine's log sweep character and keeps the low end
// usable. Pointer capture keeps the drag alive off-panel; preview during the
// drag, commit on release.

function PhanjerHSlider({ id, label, value, min, max, fmt, onPreview, onCommit }) {
  const trackRef = useRef(null)
  const draggingRef = useRef(false)
  const liveRef = useRef(value)
  liveRef.current = value

  const logMin = Math.log(min)
  const logMax = Math.log(max)

  const posToValue = useCallback((posN) => {
    const p = clamp(posN, 0, 1)
    return Math.exp(logMin + p * (logMax - logMin))
  }, [logMin, logMax])

  const valueToPos = useCallback((v) => {
    return clamp((Math.log(clamp(v, min, max)) - logMin) / (logMax - logMin), 0, 1)
  }, [logMin, logMax, min, max])

  const valueFromEvent = useCallback((e) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return liveRef.current
    return posToValue((e.clientX - rect.left) / rect.width)
  }, [posToValue])

  const onPointerDown = useCallback((e) => {
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* older engines */ }
    draggingRef.current = true
    const next = valueFromEvent(e)
    liveRef.current = next
    onPreview?.(id, next)
  }, [valueFromEvent, onPreview, id])

  const onPointerMove = useCallback((e) => {
    if (!draggingRef.current) return
    const next = valueFromEvent(e)
    liveRef.current = next
    onPreview?.(id, next)
  }, [valueFromEvent, onPreview, id])

  const onPointerUp = useCallback(() => {
    if (!draggingRef.current) return
    draggingRef.current = false
    onCommit?.(id, liveRef.current)
  }, [onCommit, id])

  const posPct = valueToPos(value) * 100

  return (
    <div className="phanjer-hslider">
      <div className="phanjer-hslider-head">
        <span className="phanjer-hslider-label">{label}</span>
        <span className="phanjer-hslider-value">{fmt(value)}</span>
      </div>
      <div
        ref={trackRef}
        className="phanjer-hslider-track"
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(e) => {
          const stepN = e.shiftKey ? 0.01 : 0.04
          const cur = valueToPos(value)
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); onCommit?.(id, posToValue(cur + stepN)) }
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); onCommit?.(id, posToValue(cur - stepN)) }
        }}
      >
        <div className="phanjer-hslider-fill" style={{ width: `${posPct}%` }} />
        <div className="phanjer-hslider-thumb" style={{ left: `${posPct}%` }} />
      </div>
    </div>
  )
}

// ── Help overlay content ──────────────────────────────────────────────────────
// One short paragraph each, matching the engine's actual behaviour (§5).
const HELP_ENTRIES = [
  ['GLOBAL MIX', 'Scales both comb paths against the dry signal — 0 % is fully dry, 100 % full effect. The dry signal enters the sum exactly once, so each side’s MIX is that comb’s depth, not a separate dry/wet blend.'],
  ['LINKED', 'One shared LFO drives both sides in anti-phase — the flanger’s comb rises as the phaser’s falls, so crossings happen fast and briefly. The leveling guard is on, and the phaser’s rate/sync follows the flanger.'],
  ['SMART', 'Independent LFOs per side with the lookahead leveling guard on: the combined path ducks up to −6 dB just before a peak-peak or notch-notch collision, so the two combs never double up or over-cancel.'],
  ['WILD', 'Independent LFOs with the guard off — a tanh saturator glues the crossings instead of leveling them. It is allowed to get hairy but stays glued rather than harsh-clipping.'],
  ['LFO SHAPE', 'The modulation waveform shared by both sides: sine, triangle, saw, square, or random. Random is a smooth per-cycle random walk rather than sample-and-hold steps.'],
  ['CHAOS', 'Active only with the Random shape. Layers two faster random sources (3× and 7× the LFO rate) on top of the sweep for a denser, broken motion. Greyed out for every other shape.'],
  ['NOTE SYNC', 'Locks a side’s LFO to the host tempo — one cycle per note division, with a Straight / Triplet / Dotted feel. Turning it on disables that side’s RATE knob.'],
]

// ── PhanjerPanel ──────────────────────────────────────────────────────────────

export default function PhanjerPanel() {
  const target = usePhanjerStore(s => s.target)
  const close  = usePhanjerStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)
  const [showHelp, setShowHelp] = useState(false)

  const targetRef  = useRef(target)
  const pendingRef = useRef(null)
  const rafRef     = useRef(0)
  targetRef.current = target

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 290),
    y: 70,
  }))
  const panelDragRef = useRef(null)

  const handlePanelMouseDown = useCallback((e) => {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) return
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
        x: Math.max(-500, Math.min(window.innerWidth  - 100, startPanelX + e.clientX - startMouseX)),
        y: Math.max(0,    Math.min(window.innerHeight - 100, startPanelY + e.clientY - startMouseY)),
      })
    }
    const onUp = () => { panelDragRef.current = null }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
  }, [])

  // ── Hydration — reset to defaults, then apply the engine's live values ──────
  useEffect(() => {
    if (!target) return
    setParams(DEFAULT_PARAMS)
    setShowHelp(false)
    if (typeof window.xleth?.audio?.getEffectParameters !== 'function') {
      console.warn('[PhanjerPanel] audio.getEffectParameters is unavailable — panel will show defaults')
      return
    }
    ;(async () => {
      try {
        const raw = await window.xleth.audio.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...DEFAULT_PARAMS }
        for (const p of list) {
          if (p.id in next) next[p.id] = p.value
        }
        setParams(next)
      } catch (e) {
        console.warn('[PhanjerPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // ── Engine writes ────────────────────────────────────────────────────────────
  // sendParam is the single bridge exit point. setEffectParameter is optional-
  // chained everywhere else, so a missing method fails silently — the presence
  // check warns per call site rather than dropping the write into the void.
  const sendParam = useCallback((id, value) => {
    const t = targetRef.current
    if (!t) return
    const fn = window.xleth?.audio?.setEffectParameter
    if (typeof fn !== 'function') {
      console.warn('[PhanjerPanel] audio.setEffectParameter is unavailable — dropped', id, value)
      return
    }
    fn(t.trackId, t.nodeId, id, value)
  }, [])

  const flushPending = useCallback(() => {
    rafRef.current = 0
    const pending = pendingRef.current
    pendingRef.current = null
    if (!pending) return
    for (const id of Object.keys(pending)) sendParam(id, pending[id])
  }, [sendParam])

  /**
   * Drag-time write: updates local state immediately so knobs, sliders and the
   * response canvas track the pointer at 60 fps, and coalesces the engine write
   * to at most one per animation frame per parameter. Without the coalescing a
   * knob or slider drag is a per-pointermove IPC storm on the JUCE message thread.
   */
  const previewParam = useCallback((id, value) => {
    setParams(prev => (prev[id] === value ? prev : { ...prev, [id]: value }))
    pendingRef.current = { ...(pendingRef.current || {}), [id]: value }
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flushPending)
  }, [flushPending])

  /** Release / discrete write: local state + an immediate authoritative send. */
  const commitParam = useCallback((id, value) => {
    setParams(prev => (prev[id] === value ? prev : { ...prev, [id]: value }))
    if (pendingRef.current) delete pendingRef.current[id]
    sendParam(id, value)
  }, [sendParam])

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    pendingRef.current = null
  }, [])

  if (!target) return null

  // ── Derived enable/disable state ─────────────────────────────────────────────
  const modeIdx  = Math.round(params.mode)
  const shapeIdx = Math.round(params.lfo_shape)
  const linked   = modeIdx === 0
  const fSyncOn  = params.f_sync >= 0.5
  const pSyncOn  = params.p_sync >= 0.5
  const isRandom = shapeIdx === 4

  const flangerRateDisabled  = fSyncOn                 // side's RATE off while its sync is on
  const phaserRateDisabled   = linked || pSyncOn       // LINKED shares the flanger LFO
  const phaserSyncRowDisabled = linked                 // whole phaser rate/sync row greyed in LINKED
  const chaosDisabled        = !isRandom               // CHAOS only bites on Random

  const stages = clamp(Math.round(params.p_stages), 1, 6)

  const renderKnob = (k, disabled, size) => (
    <div key={k.id} className={`phanjer-knob-cell${disabled ? ' phanjer-knob-cell--disabled' : ''}`}>
      <PluginUIKitKnob
        value={params[k.id]}
        min={k.min}
        max={k.max}
        defaultValue={k.default}
        label={k.label}
        formatValue={k.fmt}
        skew={k.skew ?? 1}
        onLiveChange={disabled ? undefined : (v => previewParam(k.id, v))}
        onCommit={disabled ? undefined : (v => commitParam(k.id, v))}
        size={size}
        dragRange={150}
        appearance={MIXER_RING_APPEARANCE}
      />
      <div className="phanjer-knob-value">{k.fmt(params[k.id])}</div>
    </div>
  )

  const renderSyncRow = (side, disabled) => {
    const syncId = `${side}_sync`
    const divId  = `${side}_sync_div`
    const feelId = `${side}_sync_feel`
    const on = params[syncId] >= 0.5
    return (
      <div className={`phanjer-sync-row${disabled ? ' phanjer-sync-row--disabled' : ''}`}>
        <button
          type="button"
          className={`phanjer-note-toggle${on ? ' phanjer-note-toggle--on' : ''}`}
          aria-pressed={on}
          disabled={disabled}
          title="Tempo sync"
          onClick={() => commitParam(syncId, on ? 0 : 1)}
        >
          <NoteIcon />
        </button>
        <XlethSelect
          className="phanjer-mini-select"
          value={Math.round(params[divId])}
          options={DIV_OPTIONS}
          ariaLabel={`${side === 'f' ? 'Flanger' : 'Phaser'} division`}
          disabled={disabled}
          onChange={v => commitParam(divId, Number(v))}
        />
        <XlethSelect
          className="phanjer-mini-select"
          value={Math.round(params[feelId])}
          options={FEEL_OPTIONS}
          ariaLabel={`${side === 'f' ? 'Flanger' : 'Phaser'} feel`}
          disabled={disabled}
          onChange={v => commitParam(feelId, Number(v))}
        />
      </div>
    )
  }

  return (
    <div className="phanjer-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      {/* Header — drag handle + mode selector + help + close */}
      <div className="phanjer-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="phanjer-panel-title">PHANJER</span>
        <div className="phanjer-mode-seg" role="group" aria-label="Mode">
          {MODES.map(m => (
            <button
              key={m.id}
              type="button"
              className={`phanjer-mode-btn${modeIdx === m.id ? ' phanjer-mode-btn--active' : ''}`}
              aria-pressed={modeIdx === m.id}
              onClick={() => commitParam('mode', m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="phanjer-header-spacer" />
        <button
          type="button"
          className={`phanjer-help-btn${showHelp ? ' phanjer-help-btn--active' : ''}`}
          aria-pressed={showHelp}
          title="How it works"
          onClick={() => setShowHelp(v => !v)}
        >
          <HelpCircle size={15} />
        </button>
        <button className="phanjer-panel-close" onClick={close} title="Close">
          <X size={14} />
        </button>
      </div>

      {/* Response strip — both comb curves, param-driven */}
      <div className="phanjer-response">
        <PhanjerResponseCanvas params={params} />
      </div>

      {/* Three columns */}
      <div className="phanjer-body">
        {/* FLANGER */}
        <div className="phanjer-col phanjer-col--flanger">
          <div className="phanjer-col-title">FLANGER</div>
          <div className="phanjer-knob-grid">
            {renderKnob(FLANGER_KNOBS[0], false, 56)}
            {renderKnob(FLANGER_KNOBS[1], flangerRateDisabled, 56)}
            {renderKnob(FLANGER_KNOBS[2], false, 56)}
            {renderKnob(FLANGER_KNOBS[3], false, 56)}
          </div>
          <PhanjerHSlider id="f_delay_min" label="DELAY MIN" value={params.f_delay_min}
            min={0.1} max={20} fmt={ms} onPreview={previewParam} onCommit={commitParam} />
          <PhanjerHSlider id="f_delay_max" label="DELAY MAX" value={params.f_delay_max}
            min={0.1} max={20} fmt={ms} onPreview={previewParam} onCommit={commitParam} />
          {renderSyncRow('f', false)}
        </div>

        {/* CENTER */}
        <div className="phanjer-col phanjer-col--center">
          <div className="phanjer-center-knob">
            {renderKnob(
              { id: 'global_mix', label: 'GLOBAL MIX', min: 0, max: 100, default: 50, fmt: pct },
              false, 76,
            )}
          </div>

          <div className="phanjer-shape-block">
            <div className="phanjer-mini-title">LFO SHAPE</div>
            <div className="phanjer-shape-row" role="group" aria-label="LFO shape">
              {SHAPE_PATHS.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  className={`phanjer-shape-btn${shapeIdx === i ? ' phanjer-shape-btn--active' : ''}`}
                  aria-pressed={shapeIdx === i}
                  title={SHAPE_LABELS[i]}
                  onClick={() => commitParam('lfo_shape', i)}
                >
                  <ShapeIcon shape={i} />
                </button>
              ))}
            </div>
          </div>

          <div className="phanjer-center-knob">
            {renderKnob(
              { id: 'chaos', label: 'CHAOS', min: 0, max: 100, default: 0, fmt: pct },
              chaosDisabled, 56,
            )}
          </div>
        </div>

        {/* PHASER */}
        <div className="phanjer-col phanjer-col--phaser">
          <div className="phanjer-col-title">PHASER</div>
          <div className="phanjer-knob-grid">
            {renderKnob(PHASER_KNOBS[0], false, 56)}
            {renderKnob(PHASER_KNOBS[1], false, 56)}
            {renderKnob(PHASER_KNOBS[2], phaserRateDisabled, 56)}
            {renderKnob(PHASER_KNOBS[3], false, 56)}
          </div>

          <div className="phanjer-stages">
            <span className="phanjer-hslider-label">STAGES</span>
            <div className="phanjer-stepper">
              <button
                type="button"
                className="phanjer-step-btn"
                disabled={stages <= 1}
                aria-label="Fewer stages"
                onClick={() => commitParam('p_stages', clamp(stages - 1, 1, 6))}
              >
                <Minus size={13} />
              </button>
              <span className="phanjer-step-value">{stages}</span>
              <button
                type="button"
                className="phanjer-step-btn"
                disabled={stages >= 6}
                aria-label="More stages"
                onClick={() => commitParam('p_stages', clamp(stages + 1, 1, 6))}
              >
                <Plus size={13} />
              </button>
            </div>
          </div>

          <PhanjerHSlider id="p_freq_min" label="FREQ MIN" value={params.p_freq_min}
            min={20} max={2000} fmt={freq} onPreview={previewParam} onCommit={commitParam} />
          <PhanjerHSlider id="p_freq_max" label="FREQ MAX" value={params.p_freq_max}
            min={200} max={16000} fmt={freq} onPreview={previewParam} onCommit={commitParam} />
          {renderSyncRow('p', phaserSyncRowDisabled)}
        </div>
      </div>

      {/* HOW IT WORKS overlay */}
      {showHelp && (
        <div className="phanjer-help">
          <div className="phanjer-help-head">
            <span className="phanjer-help-title">HOW IT WORKS</span>
            <button className="phanjer-panel-close" onClick={() => setShowHelp(false)} title="Close help">
              <X size={14} />
            </button>
          </div>
          <div className="phanjer-help-body">
            {HELP_ENTRIES.map(([term, text]) => (
              <div key={term} className="phanjer-help-entry">
                <div className="phanjer-help-term">{term}</div>
                <p className="phanjer-help-text">{text}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
