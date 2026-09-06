import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { X } from 'lucide-react'
import useAmpStore from '../../stores/ampStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'
import EffectPresetBar from '../../fx-presets/EffectPresetBar.jsx'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'

// Amp Stack editor panel (spec docs/amp spec.docx §7 parameter surface, §8 UI;
// look governed by docs/amp stack.html, the interactive skin reference).
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
// Theming: CSS custom-property tokens for MODERN — Dark/Light comes free with
// the token swap, nothing hardcoded here. ANALOG is the two hardcoded colour
// states spec §8 defines, carried entirely by CSS variables on the panel root
// (app.css .amp-panel--analog / .amp-panel--analog-dark) and never referenced
// as a literal hex in this file: knob accent/surface/pointer colors are read
// off those same CSS custom properties at paint time (getComputedStyle on the
// panel root, in an effect — never at module scope, matching tokenValue()'s
// own rule) so the canvas-drawn knob face tracks the two states exactly.
//
// Metering: XlethAmpEffect already writes the post-mix, post-output-gain peak
// to meter slots 0/1 (PEAK_L/PEAK_R) every block — see writeMeterValue calls
// at the end of its processBlock. That is real output level, not a stand-in,
// so both the ANALOG VU needle and the MODERN segmented bar poll the existing
// getEffectMeter bridge call (same one CompressorPanel/LimiterPanel/etc. use)
// at ~30 Hz and write the DOM directly via refs — no React re-render per tick,
// matching the house pattern in LimiterPanel.

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
const ANALOG_DARK_THRESHOLD = 0.45

function surfaceIsDark() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--xleth-flat-panel').trim()
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
// Order matches the mockup's 5x2 grid: Drive/Bass/Mid/Treble/Presence over
// Sag/Tighten/Gate/Mix/Output. Sag / Tighten default to 5 = "this model's own
// value" (the engine encodes the per-model default that way because APVTS
// defaults are static). Gate defaults to 0 = off; Precision's voicing row
// carries its own non-zero gate.
const amount = v => v.toFixed(1)

const DRIVE_KNOB    = { id: 'drive',    label: 'DRIVE',    min: 0,   max: 10,  default: 5,   fmt: amount }
const BASS_KNOB     = { id: 'bass',     label: 'BASS',     min: 0,   max: 10,  default: 5,   fmt: amount }
const MID_KNOB      = { id: 'mid',      label: 'MID',      min: 0,   max: 10,  default: 5,   fmt: amount }
const TREBLE_KNOB   = { id: 'treble',   label: 'TREBLE',   min: 0,   max: 10,  default: 5,   fmt: amount }
const PRESENCE_KNOB = { id: 'presence', label: 'PRESENCE', min: 0,   max: 10,  default: 5,   fmt: amount }
const SAG_KNOB      = { id: 'sag',      label: 'SAG',      min: 0,   max: 10,  default: 5,   fmt: amount }
const TIGHTEN_KNOB  = { id: 'tighten',  label: 'TIGHTEN',  min: 0,   max: 10,  default: 5,   fmt: amount }
const GATE_KNOB     = { id: 'gate',     label: 'GATE',     min: 0,   max: 10,  default: 0,   fmt: amount }
const MIX_KNOB      = { id: 'mix',      label: 'MIX',      min: 0,   max: 100, default: 100, fmt: v => `${v.toFixed(0)} %` }
const OUTPUT_KNOB   = { id: 'output',   label: 'OUTPUT',   min: -24, max: 12,  default: 0,   fmt: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB` }

const ALL_KNOBS = [
  DRIVE_KNOB, BASS_KNOB, MID_KNOB, TREBLE_KNOB, PRESENCE_KNOB,
  SAG_KNOB, TIGHTEN_KNOB, GATE_KNOB, MIX_KNOB, OUTPUT_KNOB,
]

const DEFAULT_PARAMS = {
  ...Object.fromEntries(ALL_KNOBS.map(k => [k.id, k.default])),
  model: MODEL_DEFAULT,
  cab: CAB_DEFAULT,
}

const KNOB_SIZE = 64
const KNOB_DRAG_RANGE = 150   // matches the mockup's own drag law annotation

// Knob face per skin. MODERN keeps the standard mixer-ring puck (its body is a
// fixed hardware-style disc by design — see Knob.jsx's rotary-arrow branch —
// so only the accent arc is themeable, which is exactly the "color is earned
// on active states" rule). ANALOG uses the hardware-cap face (tick ring +
// needle + raised cap), whose surface/pointer/accent all take literal color
// overrides resolved from the panel's own CSS variables. Both hide the built-in
// label/value strip — the panel renders its own so type fully matches spec §8.
const AMP_MODERN_KNOB_APPEARANCE = {
  preset: 'mixer-ring', sizePreset: 'inherit', valueReadout: 'hidden', labelPlacement: 'hidden',
}
const AMP_ANALOG_KNOB_APPEARANCE = {
  preset: 'hardware-cap', sizePreset: 'inherit', valueReadout: 'hidden', labelPlacement: 'hidden',
}

// ── Metering ─────────────────────────────────────────────────────────────────
// meters[0]/[1] are the universal PEAK_L/PEAK_R slots XlethEffectBase reserves
// for every stock effect; XlethAmpEffect writes the real post-output-gain peak
// there (engine/src/audio/XlethAmpEffect.h, end of processBlock). Linear peak
// -> dBFS -> a 0..1 sweep fraction, with simple asymmetric (fast-attack,
// slow-release) smoothing so the needle/bar doesn't strobe at 30 Hz.
const METER_POLL_MS = 33
const METER_MIN_DB = -36
const METER_MAX_DB = 3
const METER_ATTACK = 0.55
const METER_RELEASE = 0.09
const VU_ANGLE_MIN = -52
const VU_ANGLE_MAX = 32

function meterFraction(db) {
  return Math.max(0, Math.min(1, (db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)))
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

  const panelRef = useRef(null)

  // ANALOG's two colour states (see surfaceIsDark above).
  const themeEpoch = useThemeEpoch()
  const [analogDark, setAnalogDark] = useState(true)
  useEffect(() => { setAnalogDark(surfaceIsDark()) }, [themeEpoch, target])
  // useThemeEpoch() only updates where something calls bumpThemeEpoch(), which
  // nothing in the app currently does — so a live Dark/Light flip while this
  // panel is already open would otherwise be missed. ThemeProvider always
  // dispatches this window event after writing new tokens to :root, so listen
  // to it directly rather than depending on the (currently unwired) epoch.
  useEffect(() => {
    const onThemeChanged = () => setAnalogDark(surfaceIsDark())
    window.addEventListener('xleth-theme-changed', onThemeChanged)
    return () => window.removeEventListener('xleth-theme-changed', onThemeChanged)
  }, [])

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

  // Knob face colours: MODERN's puck ignores surface/text (fixed hardware disc,
  // see AMP_MODERN_KNOB_APPEARANCE comment above) so only accent is resolved for
  // it. ANALOG needs all three, read live off the panel root's own CSS custom
  // properties — never a literal hex in this file. Runs after the skin/analogDark
  // classes have committed to the DOM (same-commit ref + effect ordering), same
  // rule as surfaceIsDark() above.
  const [knobPalette, setKnobPalette] = useState({ accent: null, surface: null, text: null })
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const cs = getComputedStyle(el)
    const read = (name) => cs.getPropertyValue(name).trim() || null
    setKnobPalette(skin === 'analog'
      ? { accent: read('--amp-accent'), surface: read('--amp-knob-surface'), text: read('--amp-knob-pointer') }
      : { accent: read('--amp-accent'), surface: null, text: null })
  }, [skin, analogDark, themeEpoch])

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

  // ── Output meter ─────────────────────────────────────────────────────────
  // Real output level (see the header comment). DOM refs, not React state — the
  // needle/bar update at ~30 Hz and a re-render per tick would be wasted work.
  const vuNeedleRef = useRef(null)
  const meterFillRef = useRef(null)
  const meterDbRef = useRef(METER_MIN_DB)
  const meterLastPollRef = useRef(0)

  useEffect(() => {
    if (!target) return
    meterDbRef.current = METER_MIN_DB
    let active = true
    let raf = 0

    const applyDb = (db) => {
      const t = meterFraction(db)
      if (vuNeedleRef.current) {
        const angle = VU_ANGLE_MIN + t * (VU_ANGLE_MAX - VU_ANGLE_MIN)
        vuNeedleRef.current.style.transform = `rotate(${angle.toFixed(2)}deg)`
      }
      if (meterFillRef.current) {
        meterFillRef.current.style.width = `${(t * 100).toFixed(1)}%`
      }
    }
    applyDb(meterDbRef.current)

    // No bridge metering (older host, or a test double) -> render the static
    // baseline above and stop. Do not spin a polling loop that can never have
    // anything to show, and do not fake movement.
    if (typeof window.xleth?.audio?.getEffectMeter !== 'function') return

    const poll = async () => {
      if (!active) return
      const now = performance.now()
      if (now - meterLastPollRef.current >= METER_POLL_MS) {
        meterLastPollRef.current = now
        const fn = window.xleth?.audio?.getEffectMeter
        if (typeof fn === 'function') {
          try {
            const raw = await fn(target.trackId, target.nodeId)
            const meters = typeof raw === 'string' ? JSON.parse(raw) : raw
            if (Array.isArray(meters) && active) {
              const peak = Math.max(meters[0] ?? 0, meters[1] ?? 0)
              const instDb = 20 * Math.log10(Math.max(peak, 1e-5))
              const prev = meterDbRef.current
              const k = instDb > prev ? METER_ATTACK : METER_RELEASE
              const next = prev + (instDb - prev) * k
              meterDbRef.current = next
              applyDb(next)
            }
          } catch {
            // Meter read can fail on close; the loop keeps running regardless.
          }
        }
      }
      raf = requestAnimationFrame(poll)
    }
    raf = requestAnimationFrame(poll)
    return () => { active = false; cancelAnimationFrame(raf) }
  }, [target])

  if (!target) return null

  const knobAppearance = skin === 'analog' ? AMP_ANALOG_KNOB_APPEARANCE : AMP_MODERN_KNOB_APPEARANCE

  const renderKnob = (k) => (
    <div key={k.id} className="amp-knob-cell">
      <PluginUIKitKnob
        value={params[k.id]}
        min={k.min}
        max={k.max}
        defaultValue={k.default}
        label={k.label}
        onLiveChange={v => previewParam(k.id, v)}
        onCommit={v => commitParam(k.id, v)}
        size={KNOB_SIZE}
        dragRange={KNOB_DRAG_RANGE}
        appearance={knobAppearance}
        accentColor={knobPalette.accent || undefined}
        surfaceColor={skin === 'analog' ? (knobPalette.surface || undefined) : undefined}
        textColor={skin === 'analog' ? (knobPalette.text || undefined) : undefined}
        paramId={k.id}
        automationTarget={target}
      />
      <div className="amp-knob-label">{k.label}</div>
      <div className="amp-knob-value">{k.fmt(params[k.id])}</div>
    </div>
  )

  return (
    <div
      ref={panelRef}
      className={
        `amp-panel amp-panel--${skin}`
        + (skin === 'analog' && analogDark ? ' amp-panel--analog-dark' : '')
      }
      style={{ left: panelPos.x, top: panelPos.y }}
    >
      {skin === 'analog' && (
        <>
          <div className="amp-screw amp-screw--tl" />
          <div className="amp-screw amp-screw--tr" />
          <div className="amp-screw amp-screw--bl" />
          <div className="amp-screw amp-screw--br" />
        </>
      )}

      {/* Header */}
      <div className="amp-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="amp-jewel" title="power" />
        <div className="amp-brand">
          <span className="amp-brand-title">Amp Stack</span>
          <span className="amp-brand-sub">{skin === 'analog' ? 'XLETH · TUBE VOICING' : 'XLETH STOCK EFFECT'}</span>
        </div>
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

      {skin === 'analog' && <div className="amp-stripe-band" aria-hidden="true" />}

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

      {/* Knob grid — Drive/Bass/Mid/Treble/Presence over Sag/Tighten/Gate/Mix/Output,
          matching the mockup's 5x2 layout exactly (spec §8: identical across skins). */}
      <div className="amp-knob-grid">
        {ALL_KNOBS.map(renderKnob)}
      </div>

      {/* Footer — Cab (independent of Model; index 0 follows the model's pairing)
          alongside the real output meter. */}
      <div className="amp-footer">
        <div className="amp-footer-cab">
          <AmpChoiceRow
            label="CAB"
            options={CAB_SHORT}
            titles={CAB_LABELS}
            value={cabIdx}
            onSelect={setCab}
          />
        </div>

        {skin === 'analog' ? (
          <div className="amp-meter amp-meter--analog">
            <div className="amp-vu-face">
              <div className="amp-vu-arc" />
              <div className="amp-vu-needle" ref={vuNeedleRef} />
              <div className="amp-vu-pivot" />
              <div className="amp-vu-label">OUTPUT · VU</div>
            </div>
          </div>
        ) : (
          <div className="amp-meter amp-meter--modern">
            <div className="amp-meter-track">
              <div className="amp-meter-fill" ref={meterFillRef} />
            </div>
            <div className="amp-meter-scale">
              <span>-24</span><span>-12</span><span>-6</span><span>0 dB</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
