import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useDistortionStore from '../../stores/distortionStore.js'
import Knob from '../sampler/Knob.jsx'

// ── Parameter definitions ────────────────────────────────────────────────────

const KNOBS = [
  { id: 'drive', label: 'DRIVE', min: 0,  max: 48,    default: 12,   fmt: v => `${v.toFixed(1)} dB`, size: 64 },
  { id: 'tone',  label: 'TONE',  min: 20, max: 20000, default: 8000, fmt: v => `${v.toFixed(0)} Hz`, size: 52 },
  { id: 'mix',   label: 'MIX',   min: 0,  max: 100,   default: 100,  fmt: v => `${v.toFixed(0)} %`,  size: 52 },
]

const MODES = [
  { value: 0, label: 'Tube'      },
  { value: 1, label: 'Soft Clip' },
  { value: 2, label: 'Hard Clip' },
  { value: 3, label: 'Analog'    },
]

const DEFAULT_PARAMS = Object.fromEntries(KNOBS.map(k => [k.id, k.default]))

// ── DistortionPanel ──────────────────────────────────────────────────────────

export default function DistortionPanel() {
  const target = useDistortionStore(s => s.target)
  const close  = useDistortionStore(s => s.close)

  // Local param state — hydrated from engine on open
  const [params, setParams]       = useState(DEFAULT_PARAMS)
  const [mode, setModeState]      = useState(0)   // 0–3
  const [filterPos, setFilterPos] = useState(1)   // 0=Pre, 1=Post

  // Panel drag state
  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 190),
    y: 100,
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
        x: Math.max(-360, Math.min(window.innerWidth  - 100, startPanelX + e.clientX - startMouseX)),
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
    setModeState(0)
    setFilterPos(1)
    ;(async () => {
      try {
        const raw = await window.xleth?.audio?.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...DEFAULT_PARAMS }
        for (const p of list) {
          if (p.id === 'drive' || p.id === 'tone' || p.id === 'mix') next[p.id] = p.value
          if (p.id === 'mode')       setModeState(Math.round(p.value))
          if (p.id === 'filter_pos') setFilterPos(Math.round(p.value))
        }
        setParams(next)
      } catch (e) {
        console.warn('[DistortionPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // Set a continuous parameter (live drag or commit)
  const setParam = useCallback((id, value) => {
    if (!target) return
    setParams(prev => ({ ...prev, [id]: value }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, id, value)
  }, [target])

  const setMode = useCallback((value) => {
    if (!target) return
    setModeState(value)
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, 'mode', value)
  }, [target])

  const setFilter = useCallback((value) => {
    if (!target) return
    setFilterPos(value)
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, 'filter_pos', value)
  }, [target])

  if (!target) return null

  return (
    <div
      className="distortion-panel"
      style={{ left: panelPos.x, top: panelPos.y }}
    >
      {/* Header — drag handle */}
      <div className="distortion-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="distortion-panel-title">Distortion</span>
        <button className="distortion-panel-close" onClick={close} title="Close">
          <X size={12} />
        </button>
      </div>

      {/* Mode selector */}
      <div className="distortion-mode-row">
        {MODES.map(m => (
          <button
            key={m.value}
            className={`distortion-mode-btn${mode === m.value ? ' active' : ''}`}
            onClick={() => setMode(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Knobs row */}
      <div className="distortion-knob-row">
        {KNOBS.map(k => (
          <div key={k.id} className="distortion-knob-cell">
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

      {/* Filter position toggle */}
      <div className="distortion-filter-row">
        <span className="distortion-filter-label">Filter:</span>
        <button
          className={`distortion-filter-btn${filterPos === 0 ? ' active' : ''}`}
          onClick={() => setFilter(0)}
        >
          Pre
        </button>
        <button
          className={`distortion-filter-btn${filterPos === 1 ? ' active' : ''}`}
          onClick={() => setFilter(1)}
        >
          Post
        </button>
      </div>
    </div>
  )
}
