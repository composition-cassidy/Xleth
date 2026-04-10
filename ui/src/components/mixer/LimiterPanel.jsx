import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useLimiterStore from '../../stores/limiterStore.js'
import Knob from '../sampler/Knob.jsx'

// ── Parameter definitions ─────────────────────────────────────────────────────

const KNOBS = [
  { id: 'gain',    label: 'GAIN',    min: 0,    max: 36,   default: 0,     fmt: v => `${v.toFixed(1)} dB`,  size: 60 },
  { id: 'ceiling', label: 'CEILING', min: -12,  max: 0,    default: -0.3,  fmt: v => `${v.toFixed(1)} dB`,  size: 52 },
  { id: 'release', label: 'RELEASE', min: 10,   max: 1000, default: 100,   fmt: v => `${v.toFixed(0)} ms`,  size: 52 },
]

const STYLE_LABELS = ['Transparent', 'Punchy', 'Aggressive']

const DEFAULT_PARAMS = { gain: 0, ceiling: -0.3, release: 100, style: 0 }

// ── LimiterPanel ──────────────────────────────────────────────────────────────

export default function LimiterPanel() {
  const target = useLimiterStore(s => s.target)
  const close  = useLimiterStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)

  // GR meter + LUFS refs — updated directly in rAF (no React setState)
  const grBarRef    = useRef(null)
  const grLabelRef  = useRef(null)
  const momLufsRef  = useRef(null)
  const stLufsRef   = useRef(null)
  const rafRef      = useRef(null)
  const lastPollRef = useRef(0)

  // Panel drag state
  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 230),
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
    ;(async () => {
      try {
        const raw  = await window.xleth?.audio?.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...DEFAULT_PARAMS }
        for (const p of list) {
          if (p.id in next) next[p.id] = p.value
        }
        setParams(next)
      } catch (e) {
        console.warn('[LimiterPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // 30fps meter polling via rAF (slots 2=GR, 3=momentary LUFS, 4=short-term LUFS)
  useEffect(() => {
    if (!target) return
    let active = true

    const poll = async () => {
      if (!active) return
      const now = performance.now()
      if (now - lastPollRef.current >= 33) {
        lastPollRef.current = now
        try {
          const raw    = await window.xleth?.audio?.getEffectMeter(target.trackId, target.nodeId)
          const meters = typeof raw === 'string' ? JSON.parse(raw) : raw
          if (Array.isArray(meters)) {
            // Slot 2: GR dB (positive = amount reduced)
            const grDb  = Math.max(0, meters[2] ?? 0)
            const grPct = Math.min(grDb / 40 * 100, 100)
            if (grBarRef.current)   grBarRef.current.style.height  = grPct + '%'
            if (grLabelRef.current) grLabelRef.current.textContent = grDb.toFixed(1)

            // Slots 3 & 4: LUFS
            const momLufs = meters[3] ?? -70
            const stLufs  = meters[4] ?? -70
            if (momLufsRef.current) momLufsRef.current.textContent = momLufs.toFixed(1)
            if (stLufsRef.current)  stLufsRef.current.textContent  = stLufs.toFixed(1)
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

  // Set a knob parameter value
  const setParam = useCallback((id, value) => {
    if (!target) return
    setParams(prev => ({ ...prev, [id]: value }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, id, value)
  }, [target])

  // Set style (discrete 0/1/2)
  const setStyle = useCallback((idx) => {
    if (!target) return
    setParams(prev => ({ ...prev, style: idx }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, 'style', idx)
  }, [target])

  if (!target) return null

  const currentStyle = Math.round(params.style ?? 0)

  return (
    <div
      className="limiter-panel"
      style={{ left: panelPos.x, top: panelPos.y }}
    >
      {/* Header — drag handle */}
      <div className="limiter-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="limiter-panel-title">Limiter</span>
        <button className="limiter-panel-close" onClick={close} title="Close">
          <X size={12} />
        </button>
      </div>

      {/* Body */}
      <div className="limiter-panel-body">

        {/* Left: knobs + style selector */}
        <div className="limiter-panel-controls">
          <div className="limiter-knob-row">
            {KNOBS.map(k => (
              <div key={k.id} className="limiter-knob-cell">
                <Knob
                  value={params[k.id]}
                  min={k.min}
                  max={k.max}
                  defaultValue={k.default}
                  label={k.label}
                  formatValue={k.fmt}
                  onLiveChange={v => setParam(k.id, v)}
                  onCommit={v => setParam(k.id, v)}
                  size={k.size}
                  dragRange={150}
                />
              </div>
            ))}
          </div>

          {/* Style selector */}
          <div className="limiter-style-row">
            <span className="limiter-style-label">Style:</span>
            {STYLE_LABELS.map((label, idx) => (
              <button
                key={idx}
                className={`limiter-style-btn${currentStyle === idx ? ' active' : ''}`}
                onClick={() => setStyle(idx)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Right: GR meter */}
        <div className="limiter-gr-meter">
          <div className="limiter-gr-track">
            <div className="limiter-gr-bar" ref={grBarRef} />
          </div>
          <div className="limiter-gr-label">
            GR <span ref={grLabelRef}>0.0</span> dB
          </div>
        </div>
      </div>

      {/* Footer: LUFS readouts */}
      <div className="limiter-lufs-row">
        <span className="limiter-lufs-label">M:</span>
        <span className="limiter-lufs-value" ref={momLufsRef}>—</span>
        <span className="limiter-lufs-unit">LUFS</span>
        <span className="limiter-lufs-sep" />
        <span className="limiter-lufs-label">S:</span>
        <span className="limiter-lufs-value" ref={stLufsRef}>—</span>
        <span className="limiter-lufs-unit">LUFS</span>
      </div>
    </div>
  )
}
