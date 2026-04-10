import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useCompressorStore from '../../stores/compressorStore.js'
import Knob from '../sampler/Knob.jsx'

// ── Parameter definitions ────────────────────────────────────────────────────

const KNOBS = [
  // Row 1
  { id: 'threshold', label: 'THRESH',    min: -60,  max: 0,    default: -20,  fmt: v => `${v.toFixed(1)} dB` },
  { id: 'ratio',     label: 'RATIO',     min: 1,    max: 100,  default: 4,    fmt: v => `${v.toFixed(1)}:1`  },
  { id: 'attack',    label: 'ATTACK',    min: 0.01, max: 100,  default: 10,   fmt: v => `${v.toFixed(1)} ms` },
  { id: 'release',   label: 'RELEASE',   min: 10,   max: 1000, default: 100,  fmt: v => `${v.toFixed(0)} ms` },
  // Row 2
  { id: 'knee',      label: 'KNEE',      min: 0,    max: 24,   default: 6,    fmt: v => `${v.toFixed(1)} dB` },
  { id: 'makeup',    label: 'MAKEUP',    min: 0,    max: 36,   default: 0,    fmt: v => `${v.toFixed(1)} dB` },
  { id: 'mix',       label: 'MIX',       min: 0,    max: 100,  default: 100,  fmt: v => `${v.toFixed(0)} %`  },
  { id: 'lookahead', label: 'LOOKAHEAD', min: 0,    max: 10,   default: 0,    fmt: v => `${v.toFixed(1)} ms` },
]

const DEFAULT_PARAMS = Object.fromEntries(KNOBS.map(k => [k.id, k.default]))

// ── CompressorPanel ──────────────────────────────────────────────────────────

export default function CompressorPanel() {
  const target = useCompressorStore(s => s.target)
  const close  = useCompressorStore(s => s.close)

  // Local param state — hydrated from engine on open
  const [params, setParams] = useState(DEFAULT_PARAMS)
  const [detectMode, setDetectMode] = useState(0)  // 0=Peak, 1=RMS

  // GR meter (updated via rAF, bypasses React setState for perf)
  const grBarRef    = useRef(null)
  const grLabelRef  = useRef(null)
  const rafRef      = useRef(null)
  const lastPollRef = useRef(0)

  // Panel drag state
  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 220),
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

  // Hydrate params from engine when target changes
  useEffect(() => {
    if (!target) return
    setParams(DEFAULT_PARAMS)
    setDetectMode(0)
    ;(async () => {
      try {
        const raw = await window.xleth?.audio?.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...DEFAULT_PARAMS }
        for (const p of list) {
          if (p.id in next)        next[p.id] = p.value
          if (p.id === 'detect_mode') setDetectMode(Math.round(p.value))
        }
        setParams(next)
      } catch (e) {
        console.warn('[CompressorPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // 30fps GR meter polling via rAF
  useEffect(() => {
    if (!target) return
    let active = true

    const poll = async () => {
      if (!active) return
      const now = performance.now()
      if (now - lastPollRef.current >= 33) {
        lastPollRef.current = now
        try {
          const raw = await window.xleth?.audio?.getEffectMeter(target.trackId, target.nodeId)
          const meters = typeof raw === 'string' ? JSON.parse(raw) : raw
          if (Array.isArray(meters)) {
            const grDb  = Math.max(0, meters[2] ?? 0)
            const pct   = Math.min(grDb / 40 * 100, 100)
            if (grBarRef.current)   grBarRef.current.style.height   = pct + '%'
            if (grLabelRef.current) grLabelRef.current.textContent  = grDb.toFixed(1)
          }
        } catch {}
      }
      rafRef.current = requestAnimationFrame(poll)
    }

    rafRef.current = requestAnimationFrame(poll)
    return () => {
      active = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [target])

  // Set a parameter value (live drag or commit)
  const setParam = useCallback((id, value) => {
    if (!target) return
    setParams(prev => ({ ...prev, [id]: value }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, id, value)
  }, [target])

  const setDetect = useCallback((mode) => {
    if (!target) return
    setDetectMode(mode)
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, 'detect_mode', mode)
  }, [target])

  if (!target) return null

  return (
    <div
      className="compressor-panel"
      style={{ left: panelPos.x, top: panelPos.y }}
    >
      {/* Header — only this area initiates panel drag */}
      <div className="compressor-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="compressor-panel-title">Compressor</span>
        <button className="compressor-panel-close" onClick={close} title="Close">
          <X size={12} />
        </button>
      </div>

      {/* Body: knob grid + GR meter */}
      <div className="compressor-panel-body">
        {/* Knob grid — 2 rows × 4 columns */}
        <div className="compressor-knob-grid">
          {KNOBS.map(k => (
            <div key={k.id} className="compressor-knob-cell">
              <Knob
                value={params[k.id]}
                min={k.min}
                max={k.max}
                defaultValue={k.default}
                label={k.label}
                formatValue={k.fmt}
                onLiveChange={v => setParam(k.id, v)}
                onCommit={v => setParam(k.id, v)}
                size={52}
                dragRange={150}
              />
            </div>
          ))}
        </div>

        {/* GR meter */}
        <div className="compressor-gr-meter">
          <div className="compressor-gr-track">
            <div className="compressor-gr-bar" ref={grBarRef} />
          </div>
          <div className="compressor-gr-label">
            GR <span ref={grLabelRef}>0.0</span> dB
          </div>
        </div>
      </div>

      {/* Detect mode toggle */}
      <div className="compressor-detect-row">
        <span className="compressor-detect-label">Detect:</span>
        <button
          className={`compressor-detect-btn${detectMode === 0 ? ' active' : ''}`}
          onClick={() => setDetect(0)}
        >
          Peak
        </button>
        <button
          className={`compressor-detect-btn${detectMode === 1 ? ' active' : ''}`}
          onClick={() => setDetect(1)}
        >
          RMS
        </button>
      </div>
    </div>
  )
}
