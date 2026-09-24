import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useFetCompStore from '../../stores/fetCompStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'

// FET Comp panel (XlethFetCompressorEffect, pluginId "fet") — the 1176-lineage
// FET limiting amplifier built on the shared CompressorCore.
//
// The unit's face: INPUT and OUTPUT around the gain-reduction meter, ATTACK
// and RELEASE, and the interlocked ratio buttons. There is no threshold: INPUT
// drives the signal into the curve. ATTACK and RELEASE keep the hardware's
// numbering — 1..7, FASTER clockwise — so turning a knob up makes it faster,
// exactly as on the unit; the readout under each shows the time it means.
// The ratio buttons (4 / 8 / 12 / 20 / ALL) are an index-valued engine param
// rendered as a segmented group; like every stock panel's choice params they
// carry no paramId/automationTarget, so they never offer automation. ALL is
// the "all buttons in" mode — its own preset, not a blend of the four.
//
// Engine writes follow the house pattern: local state every pointer move,
// engine writes rAF-coalesced to one per parameter per frame, one
// authoritative setEffectParameter on release.

const MIXER_RING_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit' }

const fmtDb = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`

// XlethFetCompressorEffect / Fet1176: knob 1 = slowest, 7 = fastest, geometric.
const knobSeconds = (k, slowS, fastS) => slowS * Math.pow(fastS / slowS, (Math.min(7, Math.max(1, k)) - 1) / 6)
export const attackSeconds = k => knobSeconds(k, 800e-6, 20e-6)
export const releaseSeconds = k => knobSeconds(k, 1.1, 0.05)
const fmtAttack = k => `${k.toFixed(1)} · ${Math.round(attackSeconds(k) * 1e6)} µs`
const fmtRelease = (k) => {
  const s = releaseSeconds(k)
  return `${k.toFixed(1)} · ${s >= 1 ? `${s.toFixed(2)} s` : `${Math.round(s * 1000)} ms`}`
}

// Mirrors XlethFetCompressorEffect::createLayout() exactly.
const INPUT_KNOB   = { id: 'input',   label: 'INPUT',   min: -24, max: 36, default: 0, fmt: fmtDb, size: 72 }
const OUTPUT_KNOB  = { id: 'output',  label: 'OUTPUT',  min: -24, max: 24, default: 0, fmt: fmtDb, size: 72 }
const ATTACK_KNOB  = { id: 'attack',  label: 'ATTACK',  min: 1,   max: 7,  default: 3, fmt: fmtAttack, size: 56 }
const RELEASE_KNOB = { id: 'release', label: 'RELEASE', min: 1,   max: 7,  default: 5, fmt: fmtRelease, size: 56 }

// Index order matches the engine's "ratio": 0..3 = 4/8/12/20:1, 4 = all buttons in.
const RATIOS = ['4', '8', '12', '20', 'ALL']

const DEFAULT_PARAMS = {
  input: INPUT_KNOB.default,
  output: OUTPUT_KNOB.default,
  attack: ATTACK_KNOB.default,
  release: RELEASE_KNOB.default,
  ratio: 0,
}
const INDEX_PARAMS = new Set(['ratio'])

// Gain-reduction meter full scale (dB) — the 1176's GR scale reads to 20.
const GR_FULL_SCALE_DB = 20

function KnobCell({ knob, value, automationTarget, onPreview, onCommit, caption }) {
  return (
    <div className="fetcomp-knob-cell">
      <PluginUIKitKnob
        value={value}
        min={knob.min}
        max={knob.max}
        defaultValue={knob.default}
        label={knob.label}
        formatValue={knob.fmt}
        onLiveChange={v => onPreview(knob.id, v)}
        onCommit={v => onCommit(knob.id, v)}
        size={knob.size}
        dragRange={180}
        appearance={MIXER_RING_APPEARANCE}
        paramId={knob.id}
        automationTarget={automationTarget}
      />
      <div className="fetcomp-knob-value">{knob.fmt(value)}</div>
      {caption && <div className="fetcomp-knob-caption">{caption}</div>}
    </div>
  )
}

export default function FetCompPanel() {
  const target = useFetCompStore(s => s.target)
  const close = useFetCompStore(s => s.close)

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
    x: Math.round(window.innerWidth / 2 - 220),
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
      console.warn('[FetCompPanel] audio.getEffectParameters is unavailable — panel will show defaults')
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
        console.warn('[FetCompPanel] hydrate failed:', e?.message)
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
      console.warn('[FetCompPanel] audio.setEffectParameter is unavailable — dropped', id, value)
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
    <div className="fetcomp-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      <div className="fetcomp-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="fetcomp-panel-title">FET COMP</span>
        <span className="fetcomp-panel-subtitle">FET LIMITING AMP</span>
        <button className="fetcomp-panel-close" onClick={close} title="Close">
          <X size={13} />
        </button>
      </div>

      <div className="fetcomp-main-row">
        <KnobCell knob={INPUT_KNOB} value={params.input} automationTarget={target}
          onPreview={previewParam} onCommit={commitParam} />
        <div className="fetcomp-gr" aria-label="Gain reduction">
          <div className="fetcomp-gr-label">GAIN REDUCTION</div>
          <div className="fetcomp-gr-readout"><span ref={grLabelRef}>0.0</span> dB</div>
          <div className="fetcomp-gr-track"><div className="fetcomp-gr-bar" ref={grBarRef} /></div>
          <div className="fetcomp-gr-scale">
            <span>0</span><span>{GR_FULL_SCALE_DB / 4}</span><span>{GR_FULL_SCALE_DB / 2}</span><span>{GR_FULL_SCALE_DB}</span>
          </div>
        </div>
        <KnobCell knob={OUTPUT_KNOB} value={params.output} automationTarget={target}
          onPreview={previewParam} onCommit={commitParam} />
      </div>

      <div className="fetcomp-footer-row">
        <KnobCell knob={ATTACK_KNOB} value={params.attack} automationTarget={target}
          onPreview={previewParam} onCommit={commitParam} caption="1 SLOW · 7 FAST" />
        <KnobCell knob={RELEASE_KNOB} value={params.release} automationTarget={target}
          onPreview={previewParam} onCommit={commitParam} caption="1 SLOW · 7 FAST" />
        <div className="fetcomp-ratio-block">
          <div className="fetcomp-ratio-label">RATIO</div>
          <div className="fetcomp-ratio" role="radiogroup" aria-label="Ratio">
            {RATIOS.map((label, i) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={params.ratio === i}
                title={i === RATIOS.length - 1 ? 'All buttons in' : `${label}:1`}
                className={`fetcomp-ratio-btn${params.ratio === i ? ' active' : ''}${i === RATIOS.length - 1 ? ' all' : ''}`}
                onClick={() => commitParam('ratio', i)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
