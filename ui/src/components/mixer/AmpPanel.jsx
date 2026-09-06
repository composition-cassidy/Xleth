import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { X } from 'lucide-react'
import useAmpStore from '../../stores/ampStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'
import EffectPresetBar from '../../fx-presets/EffectPresetBar.jsx'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'

// Amp Stack editor panel (spec docs/amp spec.docx §7 parameter surface, §8 UI).
//
// The engine effect is XlethAmpEffect, pluginId "amp". Every id below is an
// existing APVTS parameter from that header's createLayout(); ranges mirror its
// NormalisableRange bounds exactly so the panel never sends a value the engine
// would clamp.
//
// Drag discipline (spec §9): a knob updates local React state on every pointer
// move so the readout tracks at 60 fps, coalesces the engine write to at most
// one per parameter per animation frame, and issues one authoritative
// setEffectParameter on release. Discrete selectors (Model, Cab) are
// single-click commits. This is the ReverbPanel / DelayPanel pattern.
//
// Automation: continuous knobs pass paramId + automationTarget to
// PluginUIKitKnob, which is the whole opt-in (useKnobAutomation does the rest).
// Model and Cab are choice parameters rendered as segmented selectors, so they
// carry neither prop and are structurally excluded from automation.
//
// Theming: CSS custom-property tokens for MODERN; the ANALOG skin is the two
// hardcoded colour states spec §8 defines, carried by the root class. No
// tokenValue() at module scope.

const MIXER_RING_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit' }

// ── Model selector ───────────────────────────────────────────────────────────
// AudioParameterChoice index 0..5. Labels are hardcoded here because the bridge
// surfaces a choice param as a plain numeric value. Order MUST match
// XlethAmpEffect::createLayout()'s StringArray.
const MODEL_LABELS = [
  'Blackface Clean', 'Tweed Crunch', 'Plexi',
  'Modern Tight', 'Rectifier', 'Precision',
]
const MODEL_SHORT = ['BLACKFACE', 'TWEED', 'PLEXI', 'MODERN', 'RECTIFIER', 'PRECISION']
const MODEL_DEFAULT = 3          // Modern Tight — matches the engine APVTS default

// Spec §8: the skin follows the model side. Vintage (0,1,2) -> ANALOG,
// modern (3,4,5) -> MODERN. A header toggle overrides it manually.
const VINTAGE_MODELS = 3

// ANALOG is hardcoded paint with two colour states (spec §8), so it needs a
// dark/light signal. The theme runtime writes token VALUES to :root and sets no
// data-theme attribute or class, so there is no CSS-only selector for it — the
// panel derives the state from the luminance of the panel-surface token. Read
// in an effect (never at module scope) and re-read on every theme epoch.
// --xleth-flat-panel is not a catalog token, so useTokenValue() would return ''
// for it; tokenValue() reads the live custom property instead.
const ANALOG_DARK_THRESHOLD = 0.45

function surfaceIsDark() {
  const raw = tokenValue('--xleth-flat-panel')
  const m = /^#?([0-9a-f]{6})$/i.exec(raw)
  let r, g, b
  if (m) {
    const hex = m[1]
    r = parseInt(hex.slice(0, 2), 16) / 255
    g = parseInt(hex.slice(2, 4), 16) / 255
    b = parseInt(hex.slice(4, 6), 16) / 255
  } else {
    const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(raw)
    if (!rgb) return true          // unknown / empty: XLETH ships dark by default
    r = Number(rgb[1]) / 255
    g = Number(rgb[2]) / 255
    b = Number(rgb[3]) / 255
  }
  // Rec. 601 luma is enough to answer "is this plate dark?"
  return (0.299 * r + 0.587 * g + 0.114 * b) < ANALOG_DARK_THRESHOLD
}

// ── Cab selector ─────────────────────────────────────────────────────────────
// Five entries, not four: index 0 is "Auto" (follow the model's default
// pairing), 1..4 are the shipped IRs. Independent of Model (spec §3.6).
const CAB_LABELS = ['Auto', 'Open-back 1x12', 'Alnico 2x12', 'Greenback 4x12', 'V30 4x12']
const CAB_SHORT = ['AUTO', 'OPEN 1x12', 'ALNICO 2x12', 'GREEN 4x12', 'V30 4x12']
const CAB_DEFAULT = 0

// ── Knobs ────────────────────────────────────────────────────────────────────
// Sag / Tighten default to 5 = "this model's own value" (the engine encodes the
// per-model default that way because APVTS defaults are static). Gate defaults
// to 0 = off; the Precision voicing row carries its own non-zero gate.
const amount = v => v.toFixed(1)

const DRIVE_KNOB = { id: 'drive', label: 'DRIVE', min: 0, max: 10, default: 5, fmt: amount }

const TONE_KNOBS = [
  { id: 'bass',   label: 'BASS',   min: 0, max: 10, default: 5, fmt: amount },
  { id: 'mid',    label: 'MID',    min: 0, max: 10, default: 5, fmt: amount },
  { id: 'treble', label: 'TREBLE', min: 0, max: 10, default: 5, fmt: amount },
]

const CHARACTER_KNOBS = [
  { id: 'sag',      label: 'SAG',      min: 0, max: 10, default: 5, fmt: amount },
  { id: 'tighten',  label: 'TIGHTEN',  min: 0, max: 10, default: 5, fmt: amount },
  { id: 'gate',     label: 'GATE',     min: 0, max: 10, default: 0, fmt: amount },
  { id: 'presence', label: 'PRESENCE', min: 0, max: 10, default: 5, fmt: amount },
]

const OUTPUT_KNOBS = [
  { id: 'mix',    label: 'MIX',    min: 0,   max: 100, default: 100, fmt: v => `${v.toFixed(0)} %` },
  { id: 'output', label: 'OUTPUT', min: -24, max: 12,  default: 0,   fmt: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB` },
]

const ALL_KNOBS = [DRIVE_KNOB, ...TONE_KNOBS, ...CHARACTER_KNOBS, ...OUTPUT_KNOBS]

const DEFAULT_PARAMS = {
  ...Object.fromEntries(ALL_KNOBS.map(k => [k.id, k.default])),
  model: MODEL_DEFAULT,
  cab: CAB_DEFAULT,
}

// The engine returns choice params as floats; round and clamp defensively.
function choiceIndex(value, count) {
  const idx = Math.round(Number(value))
  if (!Number.isFinite(idx)) return 0
  return Math.max(0, Math.min(count - 1, idx))
}

// ── Segmented choice row ─────────────────────────────────────────────────────

function AmpChoiceRow({ label, options, value, onSelect, titles }) {
  return (
    <div className="amp-choice">
      <div className="amp-choice-label">{label}</div>
      <div className="amp-choice-row" role="radiogroup" aria-label={label}>
        {options.map((opt, idx) => (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={value === idx}
            title={titles?.[idx] ?? opt}
            className={'amp-choice-button' + (value === idx ? ' is-active' : '')}
            onClick={() => onSelect(idx)}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── AmpPanel ─────────────────────────────────────────────────────────────────

export default function AmpPanel() {
  const target = useAmpStore(s => s.target)
  const close = useAmpStore(s => s.close)
  const skinOverride = useAmpStore(s => s.skinOverride)
  const setSkinOverride = useAmpStore(s => s.setSkinOverride)

  const [params, setParams] = useState(DEFAULT_PARAMS)

  // ANALOG's two colour states (see surfaceIsDark above).
  const themeEpoch = useThemeEpoch()
  const [analogDark, setAnalogDark] = useState(true)
  useEffect(() => { setAnalogDark(surfaceIsDark()) }, [themeEpoch, target])

  const targetRef = useRef(target)
  const pendingRef = useRef(null)
  const rafRef = useRef(0)
  targetRef.current = target

  // Panel drag state
  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 320),
    y: 60,
  }))
  const panelDragRef = useRef(null)

  const handlePanelMouseDown = useCallback((e) => {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('canvas')) return
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
        x: Math.max(-400, Math.min(window.innerWidth - 100, startPanelX + e.clientX - startMouseX)),
        y: Math.max(0, Math.min(window.innerHeight - 100, startPanelY + e.clientY - startMouseY)),
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

  // ── Hydration ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!target) return
    setParams(DEFAULT_PARAMS)
    if (typeof window.xleth?.audio?.getEffectParameters !== 'function') {
      console.warn('[AmpPanel] audio.getEffectParameters is unavailable — panel will show defaults')
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
        console.warn('[AmpPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // ── Engine writes ──────────────────────────────────────────────────────────
  // sendParam is the single bridge exit point. window.xleth.audio.setEffectParameter
  // is optional-chained everywhere else in the app, which means a missing method
  // fails silently — so the presence check is explicit and warns rather than
  // dropping the write into the void.
  const sendParam = useCallback((id, value) => {
    const t = targetRef.current
    if (!t) return
    const fn = window.xleth?.audio?.setEffectParameter
    if (typeof fn !== 'function') {
      console.warn('[AmpPanel] audio.setEffectParameter is unavailable — dropped', id, value)
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

  /** Drag-time write: local state now, engine write coalesced to one per frame. */
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

  const modelIdx = choiceIndex(params.model, MODEL_LABELS.length)
  const cabIdx = choiceIndex(params.cab, CAB_LABELS.length)

  // Skin: follows the model side unless the header toggle overrode it (spec §8).
  const skin = skinOverride ?? (modelIdx < VINTAGE_MODELS ? 'analog' : 'modern')

  const setModel = useCallback((idx) => { commitParam('model', idx) }, [commitParam])
  const setCab = useCallback((idx) => { commitParam('cab', idx) }, [commitParam])

  // Preset load/undo: the adapter already wrote every param to the engine —
  // mirror them into local state so the controls reflect it immediately.
  const applyPresetState = useCallback((state) => {
    if (!state?.params || typeof state.params !== 'object') return
    setParams(prev => ({ ...prev, ...state.params }))
  }, [])

  // Cab 0 is "Auto" — the model picks the pairing, so name that rather than
  // repeating the model, which the header already shows.
  const cabTag = useMemo(
    () => (cabIdx === 0 ? 'CAB AUTO' : CAB_SHORT[cabIdx]),
    [cabIdx],
  )

  if (!target) return null

  const renderKnob = (k, size) => (
    <div key={k.id} className={`amp-knob-cell${size <= 52 ? ' amp-knob-cell--sm' : ''}`}>
      <PluginUIKitKnob
        value={params[k.id]}
        min={k.min}
        max={k.max}
        defaultValue={k.default}
        label={k.label}
        formatValue={k.fmt}
        onLiveChange={v => previewParam(k.id, v)}
        onCommit={v => commitParam(k.id, v)}
        size={size}
        dragRange={size >= 72 ? 180 : 150}
        appearance={MIXER_RING_APPEARANCE}
        paramId={k.id}
        automationTarget={target}
      />
      {/* The mixer-ring preset hides its own readout; the value is rendered here
          so every control is legible without a drag. */}
      <div className="amp-knob-value">{k.fmt(params[k.id])}</div>
    </div>
  )

  return (
    <div
      className={
        `amp-panel amp-panel--${skin}`
        + (skin === 'analog' && analogDark ? ' amp-panel--analog-dark' : '')
      }
      style={{ left: panelPos.x, top: panelPos.y }}
    >
      {/* Header */}
      <div className="amp-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="amp-panel-title">AMP STACK</span>
        <span className="amp-panel-sub">{MODEL_SHORT[modelIdx]} / {cabTag}</span>
        <button
          type="button"
          className="amp-skin-chip"
          title={skinOverride
            ? 'Skin overridden — click to flip it back'
            : 'Skin follows the model — click to override'}
          onClick={() => setSkinOverride(skin === 'analog' ? 'modern' : 'analog')}
        >
          {skin === 'analog' ? 'ANALOG' : 'MODERN'}
          {skinOverride ? <span className="amp-skin-chip-pin">*</span> : null}
        </button>
        <button className="amp-panel-close" onClick={close} title="Close">
          <X size={13} />
        </button>
      </div>

      <div className="fx-panel-preset-strip">
        <EffectPresetBar
          effectType="amp"
          target={target}
          onApplied={applyPresetState}
        />
      </div>

      {/* Model — re-voices the whole chain (spec §7). */}
      <AmpChoiceRow
        label="MODEL"
        options={MODEL_SHORT}
        titles={MODEL_LABELS}
        value={modelIdx}
        onSelect={setModel}
      />

      {/* Cab — independent of Model; index 0 follows the model's pairing. */}
      <AmpChoiceRow
        label="CAB"
        options={CAB_SHORT}
        titles={CAB_LABELS}
        value={cabIdx}
        onSelect={setCab}
      />

      {/* Control deck */}
      <div className="amp-deck">
        <div className="amp-deck-drive">
          {renderKnob(DRIVE_KNOB, 76)}
        </div>

        <div className="amp-deck-columns">
          <div className="amp-group">
            <div className="amp-group-label">TONE STACK</div>
            <div className="amp-group-row">{TONE_KNOBS.map(k => renderKnob(k, 56))}</div>
          </div>

          <div className="amp-group">
            <div className="amp-group-label">CHARACTER</div>
            <div className="amp-group-row">{CHARACTER_KNOBS.map(k => renderKnob(k, 48))}</div>
          </div>

          <div className="amp-group">
            <div className="amp-group-label">OUTPUT</div>
            <div className="amp-group-row">{OUTPUT_KNOBS.map(k => renderKnob(k, 48))}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
