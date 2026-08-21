import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { X } from 'lucide-react'
import useDelayStore from '../../stores/delayStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'
import EffectPresetBar from '../../fx-presets/EffectPresetBar.jsx'
import XlethSelect from '../common/XlethSelect.jsx'
import DelayEchoFieldVisualizer from './DelayEchoFieldVisualizer.jsx'
import DelayFilterCurve from './DelayFilterCurve.jsx'
import { subscribe as subscribeTransport, getTransportState } from '../../transportStore.js'
import {
  clamp, syncDivLabel, divisionToMs, formatMs,
  stereoWidthLabel, STEREO_MODE_SINGLE, STEREO_MODE_DUAL, STEREO_MODE_PINGPONG,
} from './delayVizMath.js'

const MIXER_RING_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit' }

// ── Parameter definitions ────────────────────────────────────────────────────
// Every id here is an existing engine parameter (XlethDelayEffect.h). Ranges
// mirror that file's NormalisableRange bounds exactly — the panel never sends a
// value the engine would clamp.

// `skew` mirrors each parameter's NormalisableRange skew in XlethDelayEffect.h,
// so knob travel follows the same curve the engine does. Omitted = 1 (linear),
// which is what every one of these except mod_rate declares.
const MOD_KNOBS = [
  { id: 'feedback',     label: 'FEEDBACK',  min: 0,    max: 95,  default: 30,  fmt: v => `${v.toFixed(0)} %`  },
  { id: 'stereo_width', label: 'WIDTH',     min: 0,    max: 100, default: 50,  fmt: v => `${v.toFixed(0)} %`  },
  { id: 'mod_rate',     label: 'MOD RATE',  min: 0.01, max: 5,   default: 0.3, skew: 0.5, fmt: v => `${v.toFixed(2)} Hz` },
  { id: 'mod_depth',    label: 'MOD DEPTH', min: 0,    max: 100, default: 15,  fmt: v => `${v.toFixed(0)} %`  },
  { id: 'duck_amount',  label: 'DUCK',      min: 0,    max: 100, default: 0,   fmt: v => `${v.toFixed(0)} %`  },
]

const DEFAULT_PARAMS = {
  ...Object.fromEntries(MOD_KNOBS.map(k => [k.id, k.default])),
  time_l: 500,
  time_r: 500,
  mix: 30,
  filter_lo: 80,
  filter_hi: 12000,
  sync: 0,
  sync_div_l: 3,
  sync_div_r: 3,
  stereo_mode: STEREO_MODE_DUAL,
}

const STEREO_MODE_OPTIONS = [
  { value: STEREO_MODE_SINGLE,   label: 'Single'   },
  { value: STEREO_MODE_DUAL,     label: 'Dual'     },
  { value: STEREO_MODE_PINGPONG, label: 'PingPong' },
]

// Free-time knob bounds (engine: 1–5000 ms).
const TIME_MIN = 1
const TIME_MAX = 5000

// time_l / time_r are declared NormalisableRange{1, 5000, 0, 0.4} in
// XlethDelayEffect.h. The knob must use the SAME skew or its travel does not
// match the parameter: on a linear map, 500 ms lands at 10 % of the sweep and a
// half-travel drag yields ~2500 ms instead of the intended ~885 ms — long
// enough that the echo falls outside short material and the delay sounds dead.
const TIME_SKEW = 0.4

// ── Legacy sync adapter ─────────────────────────────────────────────────────
// The engine stores sync_div_l/r as an integer index 0–11 into kDivFractions.
// A future engine version will expose separate note + feel params. Until then
// we translate at the UI layer only — the engine always receives the legacy
// index; no fake params are ever sent.
//
// Index map (matches engine kDivFractions exactly):
//   0=1/1 str  1=1/2 str  2=1/2 dot
//   3=1/4 str  4=1/4 dot  5=1/4 tri
//   6=1/8 str  7=1/8 dot  8=1/8 tri
//   9=1/16 str 10=1/16 dot 11=1/16 tri
const SYNC_NOTE_FEEL = [
  { note: '1/1',  feel: 'straight' }, // 0
  { note: '1/2',  feel: 'straight' }, // 1
  { note: '1/2',  feel: 'dotted'   }, // 2
  { note: '1/4',  feel: 'straight' }, // 3
  { note: '1/4',  feel: 'dotted'   }, // 4
  { note: '1/4',  feel: 'triplet'  }, // 5
  { note: '1/8',  feel: 'straight' }, // 6
  { note: '1/8',  feel: 'dotted'   }, // 7
  { note: '1/8',  feel: 'triplet'  }, // 8
  { note: '1/16', feel: 'straight' }, // 9
  { note: '1/16', feel: 'dotted'   }, // 10
  { note: '1/16', feel: 'triplet'  }, // 11
]

/** Decodes a legacy sync_div index to { note, feel }. Clamps to [0, 11]. */
export function indexToNoteFeel(idx) {
  const i = Math.round(Math.max(0, Math.min(11, idx ?? 3)))
  return SYNC_NOTE_FEEL[i]
}

/**
 * Encodes a { note, feel } pair to the legacy engine index.
 * Returns null if the combo is not supported by the current engine.
 */
export function noteFeelToIndex(note, feel) {
  const i = SYNC_NOTE_FEEL.findIndex(e => e.note === note && e.feel === feel)
  return i === -1 ? null : i
}

/** Returns the feels available for a given note value. */
export function availableFeels(note) {
  return SYNC_NOTE_FEEL.filter(e => e.note === note).map(e => e.feel)
}

const NOTE_OPTIONS = ['1/1', '1/2', '1/4', '1/8', '1/16']
const FEEL_SUFFIX = { straight: '', dotted: ' Dotted', triplet: ' Triplet' }

/** Sentinel option value for millisecond free-time mode. */
export const TIME_MODE_FREE = 'ms'

/** Encodes a note+feel pair as an option value ("1/4|dotted"). */
export function encodeTimeMode(note, feel) {
  return `${note}|${feel}`
}

/**
 * Decodes an option value back to a legacy engine index.
 * Returns null for free-time mode and for any unsupported combo — callers must
 * treat null as "do not write sync_div".
 */
export function decodeTimeMode(optionValue) {
  if (optionValue === TIME_MODE_FREE) return null
  const [note, feel] = String(optionValue).split('|')
  return noteFeelToIndex(note, feel)
}

// Built from the adapter itself, so the dropdown can never offer a combo the
// engine has no index for.
const TIME_MODE_OPTIONS = [
  { value: TIME_MODE_FREE, label: 'Free · milliseconds', group: 'Mode' },
  ...NOTE_OPTIONS.flatMap(note =>
    availableFeels(note).map(feel => ({
      value: encodeTimeMode(note, feel),
      label: `${note}${FEEL_SUFFIX[feel]}`,
      group: 'Musical division',
    }))
  ),
]

// ── Vertical MIX slider ──────────────────────────────────────────────────────
// A knob would put MIX on the same visual tier as the modulation controls; a
// fader reads as the output stage it is. Pointer capture keeps the drag alive
// when the pointer leaves the panel.

function DelayMixSlider({ value, onPreview, onCommit }) {
  const trackRef = useRef(null)
  const draggingRef = useRef(false)
  const liveRef = useRef(value)
  liveRef.current = value

  const valueFromEvent = useCallback((e) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.height <= 0) return liveRef.current
    return clamp(100 * (1 - (e.clientY - rect.top) / rect.height), 0, 100)
  }, [])

  const onPointerDown = useCallback((e) => {
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* older engines */ }
    draggingRef.current = true
    const next = valueFromEvent(e)
    liveRef.current = next
    onPreview?.('mix', next)
  }, [valueFromEvent, onPreview])

  const onPointerMove = useCallback((e) => {
    if (!draggingRef.current) return
    const next = valueFromEvent(e)
    liveRef.current = next
    onPreview?.('mix', next)
  }, [valueFromEvent, onPreview])

  const onPointerUp = useCallback(() => {
    if (!draggingRef.current) return
    draggingRef.current = false
    onCommit?.('mix', liveRef.current)
  }, [onCommit])

  const pct = clamp(value, 0, 100)

  return (
    <div className="delay-mix">
      <div
        ref={trackRef}
        className="delay-mix-track"
        role="slider"
        aria-label="Mix"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 1 : 5
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); onCommit?.('mix', clamp(pct + step, 0, 100)) }
          if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); onCommit?.('mix', clamp(pct - step, 0, 100)) }
        }}
      >
        <div className="delay-mix-fill" style={{ height: `${pct}%` }} />
        <div className="delay-mix-thumb" style={{ bottom: `${pct}%` }} />
      </div>
      <div className="delay-mix-value">{Math.round(pct)}<span className="delay-unit">%</span></div>
      <div className="delay-mix-label">MIX</div>
    </div>
  )
}

// ── Time cell ────────────────────────────────────────────────────────────────
// One per channel. The dropdown chooses the cell's function; the knob and its
// label follow. In free mode the knob is TIME (ms → time_l/time_r); in sync
// mode it is DIVISION (a 12-step sweep over the same legacy sync_div index the
// dropdown writes). Both controls address the same engine parameter, so they
// can never disagree.

function DelayTimeCell({ side, synced, divIndex, timeMs, bpm, locked = false, onModeChange, onPreview, onCommit }) {
  const timeParam = side === 'L' ? 'time_l' : 'time_r'
  const divParam  = side === 'L' ? 'sync_div_l' : 'sync_div_r'
  const nf = indexToNoteFeel(divIndex)
  const modeValue = synced ? encodeTimeMode(nf.note, nf.feel) : TIME_MODE_FREE

  const knob = synced
    ? {
        param: divParam,
        value: clamp(divIndex, 0, 11),
        min: 0,
        max: 11,
        default: 3,
        label: 'DIVISION',
        skew: 1,
        fmt: v => syncDivLabel(v),
        quantize: v => Math.round(clamp(v, 0, 11)),
      }
    : {
        param: timeParam,
        value: clamp(timeMs, TIME_MIN, TIME_MAX),
        min: TIME_MIN,
        max: TIME_MAX,
        default: 500,
        label: 'TIME',
        skew: TIME_SKEW,
        fmt: v => formatMs(v),
        quantize: v => clamp(v, TIME_MIN, TIME_MAX),
      }

  // In sync the audible delay comes from the transport tempo, so show what the
  // chosen division actually resolves to.
  const subReadout = synced
    ? `≈ ${formatMs(divisionToMs(divIndex, bpm))} @ ${Math.round(bpm)} BPM`
    : `${(timeMs / 1000).toFixed(3)} s`

  return (
    <div className={`delay-time-cell${synced ? ' is-synced' : ''}${locked ? ' is-locked' : ''}`}>
      <span className="delay-time-chan">{side === 'L' ? 'L' : locked ? 'R = L' : 'R'}</span>

      <div className="delay-time-knob">
        <PluginUIKitKnob
          value={knob.value}
          min={knob.min}
          max={knob.max}
          defaultValue={knob.default}
          label={knob.label}
          formatValue={knob.fmt}
          onLiveChange={v => { if (!locked) onPreview(knob.param, knob.quantize(v)) }}
          onCommit={v => { if (!locked) onCommit(knob.param, knob.quantize(v)) }}
          size={72}
          dragRange={180}
          skew={knob.skew}
          appearance={MIXER_RING_APPEARANCE}
        />
      </div>

      <div className="delay-time-sub">{subReadout}</div>

      {/* Only meaningful when this side actually chooses its own time — the
          locked (Single-mode) R cell mirrors L and has no mode of its own. */}
      {!locked && (
        <XlethSelect
          className="delay-mode-select"
          value={modeValue}
          options={TIME_MODE_OPTIONS}
          ariaLabel={`${side === 'L' ? 'Left' : 'Right'} tap time mode`}
          onChange={v => onModeChange(side, v)}
        />
      )}
    </div>
  )
}

// ── Stereo mode selector ─────────────────────────────────────────────────────
// Sits beneath both time cells, spanning them. It writes the engine's discrete
// stereo_mode param directly — Single/Dual/PingPong semantics live in the
// engine (already shipped); this cell just selects the mode.

function DelayStereoModeCell({ mode, onChange }) {
  return (
    <XlethSelect
      className="delay-stereo-mode-select"
      value={mode}
      options={STEREO_MODE_OPTIONS}
      ariaLabel="Stereo mode"
      onChange={onChange}
    />
  )
}

// ── DelayPanel ───────────────────────────────────────────────────────────────

export default function DelayPanel() {
  const target = useDelayStore(s => s.target)
  const close  = useDelayStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)
  const [bpm, setBpm] = useState(() => getTransportState()?.bpm ?? 120)

  const targetRef  = useRef(target)
  const pendingRef = useRef(null)
  const rafRef     = useRef(0)
  targetRef.current = target

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 320),
    y: 60,
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
        x: Math.max(-400, Math.min(window.innerWidth  - 100, startPanelX + e.clientX - startMouseX)),
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

  // Live tempo for the sync-mode readouts and the visualizer's musical grid.
  // Rides the existing 4 Hz singleton poller — no extra IPC.
  useEffect(() => subscribeTransport((s) => {
    if (typeof s?.bpm === 'number' && Number.isFinite(s.bpm)) {
      setBpm(prev => (prev !== s.bpm ? s.bpm : prev))
    }
  }), [])

  // ── Hydration ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!target) return
    setParams(DEFAULT_PARAMS)
    if (typeof window.xleth?.audio?.getEffectParameters !== 'function') {
      console.warn('[DelayPanel] audio.getEffectParameters is unavailable — panel will show defaults')
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
        console.warn('[DelayPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // ── Engine writes ──────────────────────────────────────────────────────────
  // sendParam is the single bridge exit point. window.xleth.audio.setEffectParameter
  // is optional-chained everywhere else in the app, which means a missing method
  // fails silently — so the presence check is explicit and warns once per call
  // site rather than dropping the write into the void.
  const sendParam = useCallback((id, value) => {
    const t = targetRef.current
    if (!t) return
    const fn = window.xleth?.audio?.setEffectParameter
    if (typeof fn !== 'function') {
      console.warn('[DelayPanel] audio.setEffectParameter is unavailable — dropped', id, value)
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
   * Drag-time write: updates local state immediately so the canvases and
   * readouts track the pointer at 60 fps, and coalesces the engine write to at
   * most one per animation frame per parameter. Without the coalescing a knob
   * sweep is a per-pointermove IPC storm on the JUCE message thread.
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

  // Preset load/undo: the adapter already wrote every param to the engine —
  // mirror them into local state so the knobs/visualizer reflect it immediately.
  const applyPresetState = useCallback((state) => {
    if (!state?.params || typeof state.params !== 'object') return
    setParams(prev => ({ ...prev, ...state.params }))
  }, [])

  /**
   * Mode dropdown → legacy adapter.
   * Free mode writes sync = 0. A division writes sync_div_<side> and, if
   * needed, sync = 1. `sync` is a single engine parameter shared by both taps,
   * so switching one cell's mode necessarily switches the other's — the
   * dropdowns re-render to show that rather than lying about it.
   */
  const handleModeChange = useCallback((side, optionValue) => {
    if (optionValue === TIME_MODE_FREE) {
      commitParam('sync', 0)
      return
    }
    const idx = decodeTimeMode(optionValue)
    if (idx === null) return  // unsupported combo — never send a fake value
    commitParam(side === 'L' ? 'sync_div_l' : 'sync_div_r', idx)
    commitParam('sync', 1)
  }, [commitParam])

  const handleStereoModeChange = useCallback((value) => {
    commitParam('stereo_mode', value)
  }, [commitParam])

  const modKnobs = useMemo(() => {
    const widthLabel = stereoWidthLabel(params.stereo_mode)
    return MOD_KNOBS.map(k => (k.id === 'stereo_width' ? { ...k, label: widthLabel } : k))
  }, [params.stereo_mode])

  // Primary strip: feedback + the two modulation knobs, evenly weighted with
  // the time knobs. Secondary tier: width/spread + duck, beside the filter.
  const primaryModKnobs = useMemo(
    () => modKnobs.filter(k => k.id === 'feedback' || k.id === 'mod_rate' || k.id === 'mod_depth'),
    [modKnobs],
  )
  const secondaryModKnobs = useMemo(
    () => modKnobs.filter(k => k.id === 'stereo_width' || k.id === 'duck_amount'),
    [modKnobs],
  )

  if (!target) return null

  const synced = params.sync >= 0.5
  const stereoMode = params.stereo_mode ?? STEREO_MODE_DUAL
  const isSingle = stereoMode === STEREO_MODE_SINGLE

  return (
    <div className="delay-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      {/* Header */}
      <div className="delay-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="delay-panel-title">DELAY</span>
        <span className="delay-panel-sub">{synced ? 'TEMPO SYNC' : 'FREE TIME'}</span>
        <button className="delay-panel-close" onClick={close} title="Close">
          <X size={13} />
        </button>
      </div>

      <div className="fx-panel-preset-strip">
        <EffectPresetBar
          effectType="delay"
          target={target}
          onApplied={applyPresetState}
        />
      </div>

      {/* Stage — dominant visualization */}
      <div className="delay-stage">
        <DelayEchoFieldVisualizer params={params} bpm={bpm} />
      </div>

      {/* Strip — one flat control row, no titles */}
      <div className="delay-strip">
        <DelayMixSlider
          value={params.mix}
          onPreview={previewParam}
          onCommit={commitParam}
        />

        <div className="delay-strip-time">
          <div className="delay-strip-time-knobs">
            <DelayTimeCell
              side="L"
              synced={synced}
              divIndex={params.sync_div_l}
              timeMs={params.time_l}
              bpm={bpm}
              onModeChange={handleModeChange}
              onPreview={previewParam}
              onCommit={commitParam}
            />
            <DelayTimeCell
              side="R"
              synced={synced}
              divIndex={isSingle ? params.sync_div_l : params.sync_div_r}
              timeMs={isSingle ? params.time_l : params.time_r}
              bpm={bpm}
              locked={isSingle}
              onModeChange={handleModeChange}
              onPreview={previewParam}
              onCommit={commitParam}
            />
          </div>
          <div className="delay-strip-stereo-mode">
            <DelayStereoModeCell
              mode={stereoMode}
              onChange={handleStereoModeChange}
            />
          </div>
        </div>

        <div className="delay-strip-right">
          <div className="delay-strip-primary-knobs">
            {primaryModKnobs.map(k => (
              <div key={k.id} className="delay-knob-cell">
                <PluginUIKitKnob
                  value={params[k.id]}
                  min={k.min}
                  max={k.max}
                  defaultValue={k.default}
                  label={k.label}
                  formatValue={k.fmt}
                  onLiveChange={v => previewParam(k.id, v)}
                  onCommit={v => commitParam(k.id, v)}
                  size={72}
                  dragRange={150}
                  skew={k.skew ?? 1}
                  appearance={MIXER_RING_APPEARANCE}
                />
                {/* The mixer-ring preset hides its own readout (and would draw an
                    accent dot beside it); the value is rendered here instead so
                    every control on the panel is legible without a drag. */}
                <div className="delay-knob-value">{k.fmt(params[k.id])}</div>
              </div>
            ))}
          </div>

          <div className="delay-strip-secondary">
            {secondaryModKnobs.map(k => (
              <div key={k.id} className="delay-knob-cell delay-knob-cell--sm">
                <PluginUIKitKnob
                  value={params[k.id]}
                  min={k.min}
                  max={k.max}
                  defaultValue={k.default}
                  label={k.label}
                  formatValue={k.fmt}
                  onLiveChange={v => previewParam(k.id, v)}
                  onCommit={v => commitParam(k.id, v)}
                  size={52}
                  dragRange={150}
                  skew={k.skew ?? 1}
                  appearance={MIXER_RING_APPEARANCE}
                />
                <div className="delay-knob-value">{k.fmt(params[k.id])}</div>
              </div>
            ))}

            <div className="delay-filter">
              <DelayFilterCurve
                loHz={params.filter_lo}
                hiHz={params.filter_hi}
                onPreview={previewParam}
                onCommit={commitParam}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
