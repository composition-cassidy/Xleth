import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useUniFlangeStore from '../../stores/uniFlangeStore.js'
import EffectPresetBar from '../../fx-presets/EffectPresetBar.jsx'
import { useDynamicsVizSubscription } from '../../plugin-ui/runtime/useDynamicsVizSubscription.js'
import { VIZ_TYPE } from '../../constants/dynamicsViz.js'

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

// ── Fader definitions ────────────────────────────────────────────────────────
// Every id here is an existing engine parameter (UniFlangeEffect.h createLayout).
// Ranges and ids mirror that file's NormalisableRange bounds exactly. Labels and
// column order mirror Fruity Flangus (ORD DEPTH SPD DEL SPRD CROSS DRY WET) —
// only the presentation changed, the param ids underneath did not.
//
// NOTE on defaults: createLayout() declares speed=50, cross=0, dry=0 — not the
// 75/-25/100 figures floated when this panel was speced. The engine's APVTS
// defaults are the source of truth, so this panel mirrors what
// getEffectParameters actually returns rather than the speced numbers.
//
// `mode` (LEGACY/HQ delay-tap interpolation) has no control here by design —
// the panel never reads or writes it, so the engine stays on its LEGACY default.

const pct = v => `${v.toFixed(0)} %`

// Hover help copy (ORD/DEPTH/SPD/DEL/SPRD/CROSS only — DRY/WET are
// self-explanatory and left out by design). Every entry leads with what the
// knob does to the SOUND — the audible, perceptual result — not the DSP
// mechanism producing it (no "sweep", "voices apart in time", "stereo field"
// as the subject of a sentence; those belong in UniFlangeEffect.h, not here).
// The back half of each entry is musical guidance: when to reach for more vs.
// less, given what you just heard it do.
const PARAM_HELP = {
  order:  'Thicker and more chorus-like as you add voices; leaner and closer to a classic flange as you take them away. Push it up when you want the sound to feel huge and layered; pull it down to keep a single source recognizable.',
  depth:  'A dramatic, swooshy jet-plane movement at high settings; a gentle shimmer that sits under the sound instead of jumping out front at low ones. Use less on vocals/leads you want to stay intelligible, more on pads and risers you want to feel alive.',
  speed:  'A slow, lush, evolving wash at low settings — good on sustained pads and vocals. A fluttery, almost vibrato-like wobble at high settings — good on short stabs and risers, or anything you want to sound obviously effected.',
  delay:  'A tight, classic, metallic flange at low settings; a wider, hazier chorus-like texture at high ones. Raise it if the flange feels too narrow or phasey; lower it if it starts sounding like a separate chorus instead of a flange.',
  spread: 'Huge and enveloping across the stereo field at high settings; collapsed back to mono/centre at 0. Use full spread for width on pads and buses; dial it back when the source needs to stay centred, like a lead vocal.',
  cross:  'A subtle glue that pulls an overly wide effect back together without losing much width at small amounts; a resonant, metallic edge and extra loudness at aggressive ones — great for a larger-than-life texture, but easy to overdo.',
}

const FADERS = [
  { id: 'order',  label: 'ORD',   kind: 'stepped', min: 1,    max: 8,   default: 4,   fmt: v => `${Math.round(v)}` },
  { id: 'depth',  label: 'DEPTH', kind: 'uni',     min: 0,    max: 100, default: 50,  fmt: pct },
  { id: 'speed',  label: 'SPD',   kind: 'uni',     min: 0,    max: 100, default: 50,  fmt: pct },
  { id: 'delay',  label: 'DEL',   kind: 'uni',     min: 0,    max: 100, default: 0,   fmt: pct },
  { id: 'spread', label: 'SPRD',  kind: 'uni',     min: 0,    max: 100, default: 100, fmt: pct },
  { id: 'cross',  label: 'CROSS', kind: 'bi',      min: -100, max: 100, default: 0,   fmt: pct },
  { id: 'dry',    label: 'DRY',   kind: 'bi',      min: -100, max: 100, default: 0,   fmt: pct },
  { id: 'wet',    label: 'WET',   kind: 'bi',      min: -100, max: 100, default: 100, fmt: pct },
].map(f => ({ ...f, help: PARAM_HELP[f.id] }))

const DEFAULT_PARAMS = Object.fromEntries(FADERS.map(f => [f.id, f.default]))

// ── Live dry/wet waveform previews ──────────────────────────────────────────
// Backed by the same per-effect dynamics-visualization pipeline used by
// Compressor/Limiter/Transient/Overdone/Resonance Suppressor (see
// engine/src/audio/viz/DynamicsVizFrame.h + DynamicsVizCollector.h — this
// panel is the UniFlangeBucket consumer). Dry is the raw pre-effect mono
// input tap; wet is the post cross-mix ensemble tap (pre dry/wet gain
// blend) — literally the two signals the DRY/WET faders below blend
// together. Each bucket carries signed linear min/max excursion over ~64
// samples; the panel keeps the larger-magnitude of the two per bucket
// (mirrors TransientBucket's "dominant signed value" convention) and draws
// a single scrolling trace, refreshed via useDynamicsVizSubscription's
// shared 30Hz drain loop.
//
// Until the first live bucket arrives (or if the engine viz API is
// unavailable), the panel falls back to a static illustrative trace built
// once at module load from a fixed sum-of-sines, so the panel never shows
// an empty pane on open.

const WAVE_W = 120
const WAVE_H = 168
const WAVE_POINTS = 96

// Linear headroom above unity for the wet ensemble tap (CROSS can add up to
// +6dB / 2x via the unnormalised stereo cross-mix, spec §4.2/§9.3). Values
// are clamped to this range before being mapped to pane height so a hot
// ensemble signal never draws outside the SVG viewBox.
const AMP_HEADROOM = 1.5

function dominantSigned(minV, maxV) {
  return Math.abs(maxV) >= Math.abs(minV) ? maxV : minV
}

// Builds a single scrolling trace from the most recent live buckets. `minKey`
// /`maxKey` select which tap (dry or wet) to read off each decoded bucket.
function buildLiveWavePath(buckets, minKey, maxKey) {
  const n = buckets.length
  if (n === 0) return ''
  const cy = WAVE_H / 2
  const scale = (WAVE_H * 0.42) / AMP_HEADROOM
  return buckets.map((b, i) => {
    const v = clamp(dominantSigned(b[minKey], b[maxKey]), -AMP_HEADROOM, AMP_HEADROOM)
    const x = n > 1 ? (i / (n - 1)) * WAVE_W : WAVE_W / 2
    const y = cy - v * scale
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
}

function buildWavePath(harmonics) {
  const raw = []
  for (let i = 0; i < WAVE_POINTS; i++) {
    const t = i / (WAVE_POINTS - 1)
    const envelope = Math.sin(Math.PI * t) // fades in/out at the edges like a real clip
    let y = 0
    for (const [freq, amp, phase] of harmonics) y += Math.sin(t * Math.PI * 2 * freq + phase) * amp
    raw.push(y * envelope)
  }
  const peak = Math.max(...raw.map(Math.abs), 0.0001)
  const scale = (WAVE_H * 0.42) / peak
  const cy = WAVE_H / 2
  return raw.map((y, i) => {
    const x = (i / (WAVE_POINTS - 1)) * WAVE_W
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${(cy - y * scale).toFixed(1)}`
  }).join(' ')
}

// Fallback traces shown until the first live bucket arrives (or if the
// engine viz API is unavailable) so the panel never shows an empty pane.
const FALLBACK_DRY_WAVE_PATH = buildWavePath([[2.5, 1, 0], [5, 0.35, 1.2]])
const FALLBACK_WET_WAVE_PATH = buildWavePath([[2.5, 0.6, 0], [7, 0.5, 0.8], [13, 0.35, 2.4], [21, 0.22, 1.1], [31, 0.15, 3.0]])

function UniFlangeWave({ variant, path }) {
  return (
    <div className={`uniflange-wave uniflange-wave-${variant}`} aria-hidden="true">
      <svg viewBox={`0 0 ${WAVE_W} ${WAVE_H}`} preserveAspectRatio="none">
        <path d={path} fill="none" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  )
}

// ── Parameter label + hover help ────────────────────────────────────────────
// Hovering a param name for ~2s pops a short explainer of what that one knob
// does to the flange/widening sound. Scoped to the label text only (not the
// whole column) so dragging the fader itself never triggers it.

const HELP_HOVER_DELAY_MS = 2000

function ParamLabel({ label, help }) {
  const [show, setShow] = useState(false)
  const timerRef = useRef(0)

  const handleEnter = useCallback(() => {
    if (!help) return
    timerRef.current = setTimeout(() => setShow(true), HELP_HOVER_DELAY_MS)
  }, [help])

  const handleLeave = useCallback(() => {
    clearTimeout(timerRef.current)
    setShow(false)
  }, [])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  return (
    <div className="uniflange-fader-label-wrap" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <div className="uniflange-fader-label">{label}</div>
      {show && help && <div className="uniflange-fader-help">{help}</div>}
    </div>
  )
}

const TRACK_H = 150
const THUMB_H = 10
const GROOVE_H = TRACK_H - THUMB_H

const posFromValue = (min, max, v) => {
  const span = max - min
  return span > 0 ? (clamp(v, min, max) - min) / span : 0
}
const valueFromPos = (min, max, p) => min + (max - min) * clamp(p, 0, 1)

// ── Vertical fader — DEPTH / SPD / DEL / SPRD (unipolar) and CROSS / DRY / WET
// (bipolar, center detent at 0). Pointer-captured relative drag mirrors the
// mixer-ring knob/VolumeFader interaction: grab anywhere on the track, drag up
// to increase. Shift = fine. Double-click = reset to default. Arrow keys / Home
// / End drive it from the keyboard once focused.

function UniFlangeFader({ label, help, min, max, defaultValue, bipolar, value, fmt, onLiveChange, onCommit }) {
  const dragRef = useRef(null)
  const liveRef = useRef(value)
  useEffect(() => { liveRef.current = value }, [value])

  const pos = posFromValue(min, max, value)
  const centerPos = bipolar ? posFromValue(min, max, 0) : 0
  const thumbTop = (1 - pos) * GROOVE_H

  const handlePointerDown = useCallback((e) => {
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) {}
    dragRef.current = { startY: e.clientY, startPos: pos, fine: e.shiftKey }
  }, [pos])

  const handlePointerMove = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    const dy = d.startY - e.clientY
    const sensitivity = (e.shiftKey || d.fine) ? 8 : 1
    const nextPos = clamp(d.startPos + (dy / GROOVE_H) / sensitivity, 0, 1)
    const next = valueFromPos(min, max, nextPos)
    liveRef.current = next
    onLiveChange(next)
  }, [min, max, onLiveChange])

  const handlePointerUp = useCallback(() => {
    if (!dragRef.current) return
    dragRef.current = null
    onCommit(liveRef.current)
  }, [onCommit])

  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const sensitivity = e.shiftKey ? 500 : 100
    const next = valueFromPos(min, max, pos - (e.deltaY / sensitivity) / 20)
    onLiveChange(next)
    onCommit(next)
  }, [min, max, pos, onLiveChange, onCommit])

  const handleDoubleClick = useCallback(() => {
    onCommit(defaultValue)
  }, [defaultValue, onCommit])

  const handleKeyDown = useCallback((e) => {
    const span = max - min
    const step = (e.shiftKey ? 0.1 : 0.01) * span
    let next = null
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = clamp(value + step, min, max)
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = clamp(value - step, min, max)
    else if (e.key === 'Home') next = min
    else if (e.key === 'End') next = max
    if (next === null) return
    e.preventDefault()
    onCommit(next)
  }, [value, min, max, onCommit])

  const fillStyle = bipolar
    ? { bottom: `${Math.min(pos, centerPos) * 100}%`, height: `${Math.abs(pos - centerPos) * 100}%` }
    : { bottom: 0, height: `${pos * 100}%` }

  return (
    <div className="uniflange-fader-cell">
      <div
        className="uniflange-fader-track"
        style={{ height: TRACK_H }}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value)}
        aria-orientation="vertical"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        title={`${label} · Drag vertical · Shift = fine · Double-click = reset`}
      >
        <div className="uniflange-fader-groove" style={{ top: THUMB_H / 2, bottom: THUMB_H / 2 }}>
          <div className="uniflange-fader-fill" style={fillStyle} />
          {bipolar && <div className="uniflange-fader-center" style={{ bottom: `${centerPos * 100}%` }} />}
        </div>
        <div className="uniflange-fader-thumb" style={{ top: thumbTop + THUMB_H / 2 }} />
      </div>
      <ParamLabel label={label} help={help} />
      <div className="uniflange-fader-value">{fmt(value)}</div>
    </div>
  )
}

// ── ORD — 8-position stepped ladder ─────────────────────────────────────────
// Flangus renders ORD as discrete detents rather than a smooth fader; this
// reproduces that with 8 stacked steps (top = max, bottom = min). Click/drag a
// step to jump straight to it — there's no meaningful "relative drag" for a
// small discrete range.

function UniFlangeOrderStepper({ label, help, min, max, defaultValue, value, fmt, onLiveChange, onCommit }) {
  const trackRef = useRef(null)
  const draggingRef = useRef(false)
  const steps = max - min + 1

  const stepFromClientY = useCallback((clientY) => {
    const el = trackRef.current
    if (!el) return value
    const rect = el.getBoundingClientRect()
    const t = clamp((clientY - rect.top) / rect.height, 0, 1)
    return clamp(Math.round(max - t * (steps - 1)), min, max)
  }, [min, max, steps, value])

  const handlePointerDown = useCallback((e) => {
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (_) {}
    draggingRef.current = true
    onLiveChange(stepFromClientY(e.clientY))
  }, [stepFromClientY, onLiveChange])

  const handlePointerMove = useCallback((e) => {
    if (!draggingRef.current) return
    onLiveChange(stepFromClientY(e.clientY))
  }, [stepFromClientY, onLiveChange])

  const handlePointerUp = useCallback((e) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    onCommit(stepFromClientY(e.clientY))
  }, [stepFromClientY, onCommit])

  const handleDoubleClick = useCallback(() => {
    onCommit(defaultValue)
  }, [defaultValue, onCommit])

  const handleKeyDown = useCallback((e) => {
    let next = null
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = clamp(value + 1, min, max)
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = clamp(value - 1, min, max)
    else if (e.key === 'Home') next = min
    else if (e.key === 'End') next = max
    if (next === null) return
    e.preventDefault()
    onCommit(next)
  }, [value, min, max, onCommit])

  return (
    <div className="uniflange-fader-cell">
      <div
        ref={trackRef}
        className="uniflange-order-track"
        style={{ height: TRACK_H }}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-orientation="vertical"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        title={`${label} · Click/drag a step · Double-click = reset`}
      >
        {Array.from({ length: steps }).map((_, row) => {
          const stepValue = max - row
          return (
            <div
              key={stepValue}
              className={`uniflange-order-step${stepValue === value ? ' active' : ''}`}
            />
          )
        })}
      </div>
      <ParamLabel label={label} help={help} />
      <div className="uniflange-fader-value">{fmt(value)}</div>
    </div>
  )
}

// ── UniFlangePanel ───────────────────────────────────────────────────────────

export default function UniFlangePanel() {
  const target = useUniFlangeStore(s => s.target)
  const close  = useUniFlangeStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)

  const targetRef  = useRef(target)
  const pendingRef = useRef(null)
  const rafRef     = useRef(0)
  targetRef.current = target

  // ── Live dry/wet waveform previews ────────────────────────────────────────
  const vizHandle = useDynamicsVizSubscription(
    target?.trackId ?? null, target?.nodeId ?? null, VIZ_TYPE.UNIFLANGE)
  const [dryPath, setDryPath] = useState(FALLBACK_DRY_WAVE_PATH)
  const [wetPath, setWetPath] = useState(FALLBACK_WET_WAVE_PATH)

  useEffect(() => {
    if (!target) return
    // Reset to the static placeholder on every (re)target so switching
    // between two UniFlange instances never shows the previous node's shape.
    setDryPath(FALLBACK_DRY_WAVE_PATH)
    setWetPath(FALLBACK_WET_WAVE_PATH)

    let vizRafId = 0
    let lastEpoch = -1
    const pumpWave = () => {
      const epoch = vizHandle.epochRef.current?.value
      if (epoch !== undefined && epoch !== lastEpoch) {
        lastEpoch = epoch
        const ring = vizHandle.ringRef.current
        if (ring && ring.count > 0) {
          const take = Math.min(ring.count, WAVE_POINTS)
          const skip = ring.count - take
          const buckets = []
          let seen = 0
          ring.forEachInOrder((b) => {
            if (seen++ >= skip && b) buckets.push(b)
          })
          if (buckets.length > 0) {
            setDryPath(buildLiveWavePath(buckets, 'dryMin', 'dryMax'))
            setWetPath(buildLiveWavePath(buckets, 'wetMin', 'wetMax'))
          }
        }
      }
      vizRafId = requestAnimationFrame(pumpWave)
    }
    vizRafId = requestAnimationFrame(pumpWave)
    return () => cancelAnimationFrame(vizRafId)
  }, [target, vizHandle])

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 410),
    y: 80,
  }))
  const panelDragRef = useRef(null)

  const handlePanelMouseDown = useCallback((e) => {
    if (e.target.closest('button') || e.target.closest('input')) return
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

  // ── Hydration ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!target) return
    setParams(DEFAULT_PARAMS)
    if (typeof window.xleth?.audio?.getEffectParameters !== 'function') {
      console.warn('[UniFlangePanel] audio.getEffectParameters is unavailable — panel will show defaults')
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
        console.warn('[UniFlangePanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // ── Engine writes ──────────────────────────────────────────────────────────
  // sendParam is the single bridge exit point. The presence check is explicit
  // and warns once per call site rather than dropping the write into the void.
  const sendParam = useCallback((id, value) => {
    const t = targetRef.current
    if (!t) return
    const fn = window.xleth?.audio?.setEffectParameter
    if (typeof fn !== 'function') {
      console.warn('[UniFlangePanel] audio.setEffectParameter is unavailable — dropped', id, value)
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
   * Drag-time write: updates local state immediately so readouts track the
   * pointer at 60 fps, and coalesces the engine write to at most one per
   * animation frame per parameter. Without the coalescing a fader sweep is a
   * per-pointermove IPC storm on the JUCE message thread.
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
  // mirror them into local state so the faders reflect it immediately.
  const applyPresetState = useCallback((state) => {
    if (!state?.params || typeof state.params !== 'object') return
    setParams(prev => ({ ...prev, ...state.params }))
  }, [])

  if (!target) return null

  return (
    <div className="uniflange-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      {/* Header */}
      <div className="uniflange-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="uniflange-panel-title">UNIFLANGE</span>
        <button className="uniflange-panel-close" onClick={close} title="Close">
          <X size={13} />
        </button>
      </div>

      <div className="fx-panel-preset-strip">
        <EffectPresetBar
          effectType="uniflange"
          target={target}
          onApplied={applyPresetState}
        />
      </div>

      {/* Body — dry waveform / Flangus-order fader strip / wet waveform */}
      <div className="uniflange-panel-body">
        <UniFlangeWave variant="dry" path={dryPath} />
        <div className="uniflange-fader-row">
          {FADERS.map(f => (
            f.kind === 'stepped' ? (
              <UniFlangeOrderStepper
                key={f.id}
                label={f.label}
                help={f.help}
                min={f.min}
                max={f.max}
                defaultValue={f.default}
                value={params[f.id]}
                fmt={f.fmt}
                onLiveChange={v => previewParam(f.id, v)}
                onCommit={v => commitParam(f.id, v)}
              />
            ) : (
              <UniFlangeFader
                key={f.id}
                label={f.label}
                help={f.help}
                min={f.min}
                max={f.max}
                defaultValue={f.default}
                bipolar={f.kind === 'bi'}
                value={params[f.id]}
                fmt={f.fmt}
                onLiveChange={v => previewParam(f.id, v)}
                onCommit={v => commitParam(f.id, v)}
              />
            )
          ))}
        </div>
        <UniFlangeWave variant="wet" path={wetPath} />
      </div>
    </div>
  )
}
