import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useReverbStore from '../../stores/reverbStore.js'
import Knob from '../sampler/Knob.jsx'
import ReverbVisualizerCanvas from './ReverbVisualizerCanvas.jsx'

// ── Parameter definitions ────────────────────────────────────────────────────

const KNOBS_ROW1 = [
  { id: 'decay',      label: 'DECAY',   min: 0.1, max: 30,    default: 2.0, fmt: v => `${v.toFixed(1)} s`  },
  { id: 'size',       label: 'SIZE',    min: 0,   max: 100,   default: 50,  fmt: v => `${v.toFixed(0)} %`  },
  { id: 'damping',    label: 'DAMPING', min: 0,   max: 100,   default: 50,  fmt: v => `${v.toFixed(0)} %`  },
  // Anti-metal control. APVTS id stays "smoothness" for save/load
  // compatibility; the UI surface reads "RING TAME". 0 = legacy/raw
  // (engine LegacyFdn backend); higher values engage the enhanced FDN
  // backend's anti-metal processing.
  { id: 'smoothness', label: 'RING TAME', min: 0, max: 100, default: 0, fmt: v => `${v.toFixed(0)} %` },
]

const KNOBS_ROW2 = [
  { id: 'predelay', label: 'PRE-DELAY', min: 0, max: 100, default: 10, fmt: v => `${v.toFixed(0)} ms` },
  { id: 'er_level', label: 'ER LEVEL',  min: 0, max: 100, default: 50, fmt: v => `${v.toFixed(0)} %`  },
  { id: 'er_late',  label: 'LATE LEVEL', min: 0, max: 100, default: 50, fmt: v => `${v.toFixed(0)} %`  },
]

const KNOBS_ROW3 = [
  { id: 'mod_rate',  label: 'MOD RATE',  min: 0,    max: 100,   default: 30,    fmt: v => `${v.toFixed(0)} %`   },
  { id: 'mod_depth', label: 'MOD DEPTH', min: 0,    max: 100,   default: 20,    fmt: v => `${v.toFixed(0)} %`   },
  { id: 'hicut',     label: 'HI CUT',    min: 1000, max: 20000, default: 12000, fmt: v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v.toFixed(0)} Hz` },
  { id: 'locut',     label: 'LO CUT',    min: 20,   max: 500,   default: 80,    fmt: v => `${v.toFixed(0)} Hz`  },
]

const ALL_KNOBS = [...KNOBS_ROW1, ...KNOBS_ROW2, ...KNOBS_ROW3]

const MIX_KNOB = { id: 'mix', label: 'MIX', min: 0, max: 100, default: 30, fmt: v => `${v.toFixed(0)} %` }

// ── Style selector ───────────────────────────────────────────────────────────
// Engine-side AudioParameterChoice — index 0..3. Labels are hardcoded here
// (the bridge surfaces a choice param as a plain numeric value).
//
// Stage 2: all four indices route to the Generic FDN backend on the engine
// side, so changing this currently does not change the sound. The selector
// exists so future Room/Hall/Plate DSP work has a place to land.
const STYLE_OPTIONS = [
  { value: 0, label: 'GENERIC' },
  { value: 1, label: 'ROOM' },
  { value: 2, label: 'PLATE' },
  { value: 3, label: 'HALL' },
]
const STYLE_DEFAULT = 0   // Generic — matches engine APVTS default

const DEFAULT_PARAMS = {
  ...Object.fromEntries([...ALL_KNOBS, MIX_KNOB].map(k => [k.id, k.default])),
  style: STYLE_DEFAULT,
}

// ── ReverbPanel ──────────────────────────────────────────────────────────────

export default function ReverbPanel() {
  const target = useReverbStore(s => s.target)
  const close  = useReverbStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)

  // Panel drag state
  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 240),
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
        console.warn('[ReverbPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  const setParam = useCallback((id, value) => {
    if (!target) return
    setParams(prev => ({ ...prev, [id]: value }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, id, value)
  }, [target])

  const setStyle = useCallback((idx) => {
    if (!target) return
    setParams(prev => ({ ...prev, style: idx }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, 'style', idx)
  }, [target])

  if (!target) return null

  // Engine returns style as a float (AudioParameterChoice index). Round to
  // the nearest valid integer index defensively in case of float jitter.
  const activeStyleIdx = Math.max(0, Math.min(STYLE_OPTIONS.length - 1,
    Math.round(Number(params.style) || 0)))

  const renderKnobRow = (knobs) => (
    <div className="reverb-knob-row">
      {knobs.map(k => (
        <div key={k.id} className="reverb-knob-cell">
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
  )

  return (
    <div
      className="reverb-panel"
      style={{ left: panelPos.x, top: panelPos.y }}
    >
      {/* Header */}
      <div className="reverb-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="reverb-panel-title">Reverb</span>
        <button className="reverb-panel-close" onClick={close} title="Close">
          <X size={12} />
        </button>
      </div>

      {/* Style selector — segmented choice. Stage 2: all routes go through
          Generic on the engine side; this is the seam for future per-style DSP. */}
      <div className="reverb-style-row" role="radiogroup" aria-label="Reverb style">
        {STYLE_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={activeStyleIdx === opt.value}
            className={
              'reverb-style-button' +
              (activeStyleIdx === opt.value ? ' reverb-style-button-active' : '')
            }
            onClick={() => setStyle(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Visualizer */}
      <div className="reverb-viz-wrap">
        <ReverbVisualizerCanvas params={params} styleIndex={activeStyleIdx} />
      </div>

      {/* Knob rows */}
      <div className="reverb-knob-grid">
        {renderKnobRow(KNOBS_ROW1)}
        {renderKnobRow(KNOBS_ROW2)}
        {renderKnobRow(KNOBS_ROW3)}
      </div>

      {/* Large Mix knob */}
      <div className="reverb-mix-row">
        <Knob
          value={params[MIX_KNOB.id]}
          min={MIX_KNOB.min}
          max={MIX_KNOB.max}
          defaultValue={MIX_KNOB.default}
          label={MIX_KNOB.label}
          formatValue={MIX_KNOB.fmt}
          onLiveChange={v => setParam(MIX_KNOB.id, v)}
          onCommit={v => setParam(MIX_KNOB.id, v)}
          size={64}
          dragRange={150}
        />
      </div>
    </div>
  )
}
