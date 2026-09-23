import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useOptoCompStore from '../../stores/optoCompStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'

// Opto Comp panel (XlethOptoCompressorEffect, pluginId "opto") — the
// LA-2A-lineage optical leveling amplifier built on the shared CompressorCore.
//
// The unit's three controls and nothing else: GAIN and PEAK REDUCTION are
// automatable knobs; LIMIT / COMPRESS is the two-position switch, an
// index-valued engine param rendered as a segmented pair (like every stock
// panel's choice params it carries no paramId/automationTarget, so it never
// offers automation). Attack, release and ratio are properties of the T4 cell,
// not controls — the meter is where they show.
//
// Engine writes follow the house pattern: local state every pointer move,
// engine writes rAF-coalesced to one per parameter per frame, one
// authoritative setEffectParameter on release.

const MIXER_RING_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit' }

const fmtDb = v => `${v.toFixed(1)} dB`

// Mirrors XlethOptoCompressorEffect::createLayout() exactly.
const GAIN_KNOB = { id: 'gain', label: 'GAIN', min: 0, max: 40, default: 0, fmt: fmtDb }
const PEAK_REDUCTION_KNOB = { id: 'peak_reduction', label: 'PEAK REDUCTION', min: 0, max: 40, default: 20, fmt: fmtDb }

// Index order matches the engine's "mode": 0 = Compress, 1 = Limit.
const MODES = ['COMPRESS', 'LIMIT']

const DEFAULT_PARAMS = {
  gain: GAIN_KNOB.default,
  peak_reduction: PEAK_REDUCTION_KNOB.default,
  mode: 0,
}
const INDEX_PARAMS = new Set(['mode'])

// Gain-reduction meter full scale (dB). A leveler lives around 3–10 dB; 20 dB
// full scale keeps that readable and shows the slow tail draining.
const GR_FULL_SCALE_DB = 20

function KnobCell({ knob, value, automationTarget, onPreview, onCommit }) {
  return (
    <div className="optocomp-knob-cell">
      <PluginUIKitKnob
        value={value}
        min={knob.min}
        max={knob.max}
        defaultValue={knob.default}
        label={knob.label}
        formatValue={knob.fmt}
        onLiveChange={v => onPreview(knob.id, v)}
        onCommit={v => onCommit(knob.id, v)}
        size={72}
        dragRange={180}
        appearance={MIXER_RING_APPEARANCE}
        paramId={knob.id}
        automationTarget={automationTarget}
      />
      <div className="optocomp-knob-value">{knob.fmt(value)}</div>
    </div>
  )
}

export default function OptoCompPanel() {
  const target = useOptoCompStore(s => s.target)
  const close = useOptoCompStore(s => s.close)

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
    x: Math.round(window.innerWidth / 2 - 200),
    y: 110,
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
        x: Math.max(-300, Math.min(window.innerWidth - 100, startPanelX + e.clientX - startMouseX)),
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
      console.warn('[OptoCompPanel] audio.getEffectParameters is unavailable — panel will show defaults')
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
        console.warn('[OptoCompPanel] hydrate failed:', e?.message)
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
      console.warn('[OptoCompPanel] audio.setEffectParameter is unavailable — dropped', id, value)
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

  return (
    <div className="optocomp-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      <div className="optocomp-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="optocomp-panel-title">OPTO COMP</span>
        <span className="optocomp-panel-subtitle">T4 LEVELING AMP</span>
        <button className="optocomp-panel-close" onClick={close} title="Close">
          <X size={13} />
        </button>
      </div>

      <div className="optocomp-main-row">
        <KnobCell knob={GAIN_KNOB} value={params.gain} automationTarget={target}
          onPreview={previewParam} onCommit={commitParam} />
        <div className="optocomp-gr" aria-label="Gain reduction">
          <div className="optocomp-gr-label">GAIN REDUCTION</div>
          <div className="optocomp-gr-readout"><span ref={grLabelRef}>0.0</span> dB</div>
          <div className="optocomp-gr-track"><div className="optocomp-gr-bar" ref={grBarRef} /></div>
          <div className="optocomp-gr-scale">
            <span>0</span><span>{GR_FULL_SCALE_DB / 4}</span><span>{GR_FULL_SCALE_DB / 2}</span><span>{GR_FULL_SCALE_DB}</span>
          </div>
        </div>
        <KnobCell knob={PEAK_REDUCTION_KNOB} value={params.peak_reduction} automationTarget={target}
          onPreview={previewParam} onCommit={commitParam} />
      </div>

      <div className="optocomp-footer-row">
        <div className="optocomp-mode" role="radiogroup" aria-label="Limit/Compress">
          {MODES.map((label, i) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={params.mode === i}
              className={`optocomp-mode-btn${params.mode === i ? ' active' : ''}`}
              onClick={() => commitParam('mode', i)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
