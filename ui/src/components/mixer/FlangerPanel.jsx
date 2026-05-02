import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useFlangerStore from '../../stores/flangerStore.js'
import Knob from '../sampler/Knob.jsx'
import FlangerVisualizerCanvas from './FlangerVisualizerCanvas.jsx'

// ── Parameter definitions ────────────────────────────────────────────────────

const KNOBS = [
  // Row 1 — Modulation core
  { id: 'rate',     label: 'RATE',     min: 0.05, max: 10,  default: 0.5,  fmt: v => `${v.toFixed(2)} Hz` },
  { id: 'depth',    label: 'DEPTH',    min: 0,    max: 100, default: 70,   fmt: v => `${v.toFixed(0)} %`  },
  { id: 'delay',    label: 'DELAY',    min: 0.1,  max: 5,   default: 1.5,  fmt: v => `${v.toFixed(2)} ms` },
  // Row 2 — Character & output
  { id: 'feedback', label: 'FEEDBACK', min: -95,  max: 95,  default: 50,   fmt: v => `${v.toFixed(0)} %`  },
  { id: 'width',    label: 'WIDTH',    min: 0,    max: 100, default: 50,   fmt: v => `${v.toFixed(0)} %`  },
  { id: 'mix',      label: 'MIX',      min: 0,    max: 100, default: 50,   fmt: v => `${v.toFixed(0)} %`  },
]

const DEFAULT_PARAMS = Object.fromEntries(KNOBS.map(k => [k.id, k.default]))

// ── FlangerPanel ─────────────────────────────────────────────────────────────

export default function FlangerPanel() {
  const target = useFlangerStore(s => s.target)
  const close  = useFlangerStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 210),
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
        const raw = await window.xleth?.audio?.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...DEFAULT_PARAMS }
        for (const p of list) {
          if (p.id in next) next[p.id] = p.value
        }
        setParams(next)
      } catch (e) {
        console.warn('[FlangerPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  const setParam = useCallback((id, value) => {
    if (!target) return
    setParams(prev => ({ ...prev, [id]: value }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, id, value)
  }, [target])

  if (!target) return null

  return (
    <div
      className="flanger-panel"
      style={{ left: panelPos.x, top: panelPos.y }}
    >
      {/* Header */}
      <div className="flanger-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="flanger-panel-title">Flanger</span>
        <button className="flanger-panel-close" onClick={close} title="Close">
          <X size={12} />
        </button>
      </div>

      {/* Visualizer */}
      <div className="flanger-viz-wrap">
        <FlangerVisualizerCanvas params={params} />
      </div>

      {/* Knob grid */}
      <div className="flanger-knob-grid">
        {KNOBS.map(k => (
          <div key={k.id} className="flanger-knob-cell">
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
    </div>
  )
}
