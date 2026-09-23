import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useGlueCompStore from '../../stores/glueCompStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'

// Glue Comp panel (XlethGlueCompressorEffect, pluginId "glue") — the SSL-bus
// style Feedback VCA compressor built on the shared CompressorCore.
//
// The hardware's stepped switches (ratio, attack, release, topology) are
// index-valued engine params rendered as segmented buttons — like the unit,
// and like every other stock panel's choice params they carry no
// paramId/automationTarget, so they never offer automation. The continuous
// controls (threshold, makeup, S/C HPF frequency) are automatable knobs.
//
// Engine writes follow the house pattern: local state every pointer move,
// engine writes rAF-coalesced to one per parameter per frame, one
// authoritative setEffectParameter on release.

const MIXER_RING_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit' }

const fmtDb = v => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`

// Mirrors XlethGlueCompressorEffect::createLayout() exactly.
const THRESHOLD_KNOB = { id: 'threshold', label: 'THRESHOLD', min: -40, max: 0, default: -10, fmt: fmtDb }
const MAKEUP_KNOB = { id: 'makeup', label: 'MAKEUP', min: -10, max: 20, default: 0, fmt: fmtDb }
const HPF_KNOB = { id: 'sc_hpf_freq', label: 'S/C HPF', min: 20, max: 500, default: 100, skew: 0.4, fmt: v => `${Math.round(v)} Hz` }

// Index → label, index order matches the engine's kRatios / kAttacksMs / kReleasesMs.
const RATIOS = ['2', '4', '10']
const ATTACKS = ['.1', '.3', '1', '3', '10', '30']
const RELEASES = ['.1', '.3', '.6', '1.2', 'AUTO']
const TOPOLOGIES = ['CLASSIC', 'FF']

const DEFAULT_PARAMS = {
  threshold: THRESHOLD_KNOB.default,
  makeup: MAKEUP_KNOB.default,
  ratio: 1,
  attack: 4,
  release: 4,
  topology: 0,
  sc_hpf_on: 0,
  sc_hpf_freq: HPF_KNOB.default,
  color: 1,
}
const INDEX_PARAMS = new Set(['ratio', 'attack', 'release', 'topology', 'sc_hpf_on', 'color'])

// Gain-reduction meter scale (dB at full bar). A glue compressor lives in the
// 1–6 dB range; 20 dB full scale keeps that readable without pinning at 10:1.
const GR_FULL_SCALE_DB = 20

function KnobCell({ knob, value, automationTarget, onPreview, onCommit, disabled = false }) {
  return (
    <div className={`gluecomp-knob-cell${disabled ? ' is-disabled' : ''}`}>
      <PluginUIKitKnob
        value={value}
        min={knob.min}
        max={knob.max}
        defaultValue={knob.default}
        label={knob.label}
        formatValue={knob.fmt}
        onLiveChange={v => onPreview(knob.id, v)}
        onCommit={v => onCommit(knob.id, v)}
        size={60}
        dragRange={150}
        skew={knob.skew || 1}
        appearance={MIXER_RING_APPEARANCE}
        paramId={knob.id}
        automationTarget={automationTarget}
      />
      <div className="gluecomp-knob-value">{knob.fmt(value)}</div>
    </div>
  )
}

function Stepped({ label, unit, options, value, onSelect, ariaLabel }) {
  return (
    <div className="gluecomp-stepped">
      <div className="gluecomp-stepped-label">
        {label}{unit ? <span className="gluecomp-stepped-unit"> {unit}</span> : null}
      </div>
      <div className="gluecomp-stepped-row" role="radiogroup" aria-label={ariaLabel}>
        {options.map((opt, i) => (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={value === i}
            className={`gluecomp-step-btn${value === i ? ' active' : ''}`}
            onClick={() => onSelect(i)}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function GlueCompPanel() {
  const target = useGlueCompStore(s => s.target)
  const close = useGlueCompStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)

  const targetRef = useRef(target)
  const pendingRef = useRef(null)
  const rafRef = useRef(0)
  const meterRafRef = useRef(0)
  const lastPollRef = useRef(0)
  const grBarRef = useRef(null)
  const grLabelRef = useRef(null)
  targetRef.current = target

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 240),
    y: 100,
  }))
  const panelDragRef = useRef(null)

  const handlePanelMouseDown = useCallback((e) => {
    if (e.target.closest('button')) return
    e.preventDefault()
    panelDragRef.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startPanelX: panelPos.x,
      startPanelY: panelPos.y,
    }
  }, [panelPos])

  useEffect(() => {
    const onMove = (e) => {
      if (!panelDragRef.current) return
      const { startMouseX, startMouseY, startPanelX, startPanelY } = panelDragRef.current
      setPanelPos({
        x: Math.max(-380, Math.min(window.innerWidth - 100, startPanelX + e.clientX - startMouseX)),
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
      console.warn('[GlueCompPanel] audio.getEffectParameters is unavailable — panel will show defaults')
      return
    }
    ;(async () => {
      try {
        const raw = await window.xleth.audio.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...DEFAULT_PARAMS }
        for (const p of list) {
          if (!(p.id in next)) continue
          next[p.id] = INDEX_PARAMS.has(p.id) ? Math.round(p.value) : p.value
        }
        setParams(next)
      } catch (e) {
        console.warn('[GlueCompPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // ── Gain-reduction meter (slot 2), ~30 Hz, written straight to the DOM ────
  useEffect(() => {
    if (!target) return
    let active = true
    const poll = async () => {
      if (!active) return
      const now = performance.now()
      if (now - lastPollRef.current >= 33 && typeof window.xleth?.audio?.getEffectMeter === 'function') {
        lastPollRef.current = now
        try {
          const raw = await window.xleth.audio.getEffectMeter(target.trackId, target.nodeId)
          const meters = typeof raw === 'string' ? JSON.parse(raw) : raw
          if (active && Array.isArray(meters)) {
            const grDb = Math.max(0, meters[2] ?? 0)
            const pct = Math.min((grDb / GR_FULL_SCALE_DB) * 100, 100)
            if (grBarRef.current) grBarRef.current.style.width = `${pct}%`
            if (grLabelRef.current) grLabelRef.current.textContent = grDb.toFixed(1)
          }
        } catch { /* meter is best-effort */ }
      }
      if (active) meterRafRef.current = requestAnimationFrame(poll)
    }
    meterRafRef.current = requestAnimationFrame(poll)
    return () => { active = false; cancelAnimationFrame(meterRafRef.current) }
  }, [target])

  // ── Engine writes ──────────────────────────────────────────────────────────
  const sendParam = useCallback((id, value) => {
    const t = targetRef.current
    if (!t) return
    const fn = window.xleth?.audio?.setEffectParameter
    if (typeof fn !== 'function') {
      console.warn('[GlueCompPanel] audio.setEffectParameter is unavailable — dropped', id, value)
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

  const previewParam = useCallback((id, value) => {
    setParams(prev => (prev[id] === value ? prev : { ...prev, [id]: value }))
    pendingRef.current = { ...(pendingRef.current || {}), [id]: value }
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flushPending)
  }, [flushPending])

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

  const hpfOn = params.sc_hpf_on >= 0.5
  const colorOn = params.color >= 0.5

  return (
    <div className="gluecomp-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      <div className="gluecomp-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="gluecomp-panel-title">GLUE COMP</span>
        <span className="gluecomp-panel-subtitle">FEEDBACK VCA</span>
        <button className="gluecomp-panel-close" onClick={close} title="Close">
          <X size={13} />
        </button>
      </div>

      <div className="gluecomp-main-row">
        <KnobCell knob={THRESHOLD_KNOB} value={params.threshold} automationTarget={target}
          onPreview={previewParam} onCommit={commitParam} />
        <KnobCell knob={MAKEUP_KNOB} value={params.makeup} automationTarget={target}
          onPreview={previewParam} onCommit={commitParam} />
        <div className="gluecomp-gr" aria-label="Gain reduction">
          <div className="gluecomp-gr-label">GR <span ref={grLabelRef}>0.0</span> dB</div>
          <div className="gluecomp-gr-track"><div className="gluecomp-gr-bar" ref={grBarRef} /></div>
          <div className="gluecomp-gr-scale"><span>0</span><span>{GR_FULL_SCALE_DB / 2}</span><span>{GR_FULL_SCALE_DB}</span></div>
        </div>
      </div>

      <div className="gluecomp-stepped-block">
        <Stepped label="RATIO" unit=":1" options={RATIOS} value={params.ratio}
          ariaLabel="Ratio" onSelect={i => commitParam('ratio', i)} />
        <Stepped label="ATTACK" unit="ms" options={ATTACKS} value={params.attack}
          ariaLabel="Attack" onSelect={i => commitParam('attack', i)} />
        <Stepped label="RELEASE" unit="s" options={RELEASES} value={params.release}
          ariaLabel="Release" onSelect={i => commitParam('release', i)} />
      </div>

      <div className="gluecomp-footer-row">
        <Stepped label="TOPOLOGY" options={TOPOLOGIES} value={params.topology}
          ariaLabel="Topology" onSelect={i => commitParam('topology', i)} />
        <div className="gluecomp-hpf">
          <button
            type="button"
            aria-pressed={hpfOn}
            className={`gluecomp-toggle-btn${hpfOn ? ' active' : ''}`}
            onClick={() => commitParam('sc_hpf_on', hpfOn ? 0 : 1)}
          >
            S/C HPF
          </button>
          <KnobCell knob={HPF_KNOB} value={params.sc_hpf_freq} automationTarget={target}
            onPreview={previewParam} onCommit={commitParam} disabled={!hpfOn} />
        </div>
        <button
          type="button"
          aria-pressed={colorOn}
          className={`gluecomp-toggle-btn gluecomp-color-btn${colorOn ? ' active' : ''}`}
          onClick={() => commitParam('color', colorOn ? 0 : 1)}
          title="Subtle console-style output saturation"
        >
          COLOR
        </button>
      </div>
    </div>
  )
}
