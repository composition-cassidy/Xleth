import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import usePhaserStore from '../../stores/phaserStore.js'
import Knob from '../sampler/Knob.jsx'
import PhaserVisualizerCanvas from './PhaserVisualizerCanvas.jsx'

// ── Parameter definitions ────────────────────────────────────────────────────

const KNOBS = [
  // Row 1 — Modulation core
  { id: 'rate',  label: 'RATE',  min: 0.05, max: 5,   default: 0.5, fmt: v => `${v.toFixed(2)} Hz` },
  { id: 'depth', label: 'DEPTH', min: 0,    max: 100, default: 80,  fmt: v => `${v.toFixed(0)} %`  },
  // Row 2 — Sweep range
  { id: 'freq_low',  label: 'FREQ LOW',  min: 20,  max: 2000,  default: 100,  fmt: v => `${v.toFixed(0)} Hz` },
  { id: 'freq_high', label: 'FREQ HIGH', min: 200, max: 16000, default: 4000, fmt: v => `${v.toFixed(0)} Hz` },
  // Row 3 — Character & output
  { id: 'feedback', label: 'FEEDBACK', min: -95, max: 95,  default: 40, fmt: v => `${v.toFixed(0)} %` },
  { id: 'width',    label: 'WIDTH',    min: 0,   max: 100, default: 50, fmt: v => `${v.toFixed(0)} %` },
  { id: 'mix',      label: 'MIX',      min: 0,   max: 100, default: 50, fmt: v => `${v.toFixed(0)} %` },
]

const STAGES_OPTIONS = [2, 4, 6, 8, 10, 12]

const DEFAULT_PARAMS = {
  ...Object.fromEntries(KNOBS.map(k => [k.id, k.default])),
  stages: 6,
}

// ── PhaserPanel ───────────────────────────────────────────────────────────────

export default function PhaserPanel() {
  const target = usePhaserStore(s => s.target)
  const close  = usePhaserStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 210),
    y: 80,
  }))
  const panelDragRef = useRef(null)

  const handlePanelMouseDown = useCallback((e) => {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) return
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
        console.warn('[PhaserPanel] hydrate failed:', e?.message)
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
      className="phaser-panel"
      style={{ left: panelPos.x, top: panelPos.y }}
    >
      {/* Header */}
      <div className="phaser-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="phaser-panel-title">Phaser</span>
        <button className="phaser-panel-close" onClick={close} title="Close">
          <X size={12} />
        </button>
      </div>

      {/* Visualizer */}
      <div className="phaser-viz-wrap">
        <PhaserVisualizerCanvas params={params} />
      </div>

      {/* Controls */}
      <div className="phaser-knob-grid">
        {/* Rate knob */}
        <div className="phaser-knob-cell">
          <Knob
            value={params.rate}
            min={0.05}
            max={5}
            defaultValue={0.5}
            label="RATE"
            formatValue={v => `${v.toFixed(2)} Hz`}
            onLiveChange={v => setParam('rate', v)}
            onCommit={v => setParam('rate', v)}
            size={52}
            dragRange={150}
          />
        </div>

        {/* Depth knob */}
        <div className="phaser-knob-cell">
          <Knob
            value={params.depth}
            min={0}
            max={100}
            defaultValue={80}
            label="DEPTH"
            formatValue={v => `${v.toFixed(0)} %`}
            onLiveChange={v => setParam('depth', v)}
            onCommit={v => setParam('depth', v)}
            size={52}
            dragRange={150}
          />
        </div>

        {/* Stages dropdown */}
        <div className="phaser-knob-cell phaser-stages-cell">
          <label className="phaser-stages-label">STAGES</label>
          <select
            className="phaser-stages-select"
            value={params.stages}
            onChange={e => setParam('stages', Number(e.target.value))}
          >
            {STAGES_OPTIONS.map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>

        {/* Freq Low knob */}
        <div className="phaser-knob-cell">
          <Knob
            value={params.freq_low}
            min={20}
            max={2000}
            defaultValue={100}
            label="FREQ LOW"
            formatValue={v => `${v.toFixed(0)} Hz`}
            onLiveChange={v => setParam('freq_low', v)}
            onCommit={v => setParam('freq_low', v)}
            size={52}
            dragRange={150}
          />
        </div>

        {/* Freq High knob */}
        <div className="phaser-knob-cell">
          <Knob
            value={params.freq_high}
            min={200}
            max={16000}
            defaultValue={4000}
            label="FREQ HIGH"
            formatValue={v => `${v.toFixed(0)} Hz`}
            onLiveChange={v => setParam('freq_high', v)}
            onCommit={v => setParam('freq_high', v)}
            size={52}
            dragRange={150}
          />
        </div>

        {/* Feedback knob */}
        <div className="phaser-knob-cell">
          <Knob
            value={params.feedback}
            min={-95}
            max={95}
            defaultValue={40}
            label="FEEDBACK"
            formatValue={v => `${v.toFixed(0)} %`}
            onLiveChange={v => setParam('feedback', v)}
            onCommit={v => setParam('feedback', v)}
            size={52}
            dragRange={150}
          />
        </div>

        {/* Width knob */}
        <div className="phaser-knob-cell">
          <Knob
            value={params.width}
            min={0}
            max={100}
            defaultValue={50}
            label="WIDTH"
            formatValue={v => `${v.toFixed(0)} %`}
            onLiveChange={v => setParam('width', v)}
            onCommit={v => setParam('width', v)}
            size={52}
            dragRange={150}
          />
        </div>

        {/* Mix knob */}
        <div className="phaser-knob-cell">
          <Knob
            value={params.mix}
            min={0}
            max={100}
            defaultValue={50}
            label="MIX"
            formatValue={v => `${v.toFixed(0)} %`}
            onLiveChange={v => setParam('mix', v)}
            onCommit={v => setParam('mix', v)}
            size={52}
            dragRange={150}
          />
        </div>
      </div>
    </div>
  )
}
