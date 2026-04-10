import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useDelayStore from '../../stores/delayStore.js'
import Knob from '../sampler/Knob.jsx'

// ── Parameter definitions ────────────────────────────────────────────────────

const KNOBS = [
  // Row 1 — Time & core
  { id: 'time_l',    label: 'TIME L',    min: 1,    max: 5000,  default: 500,   fmt: v => `${v.toFixed(0)} ms` },
  { id: 'time_r',    label: 'TIME R',    min: 1,    max: 5000,  default: 500,   fmt: v => `${v.toFixed(0)} ms` },
  { id: 'feedback',  label: 'FEEDBACK',  min: 0,    max: 95,    default: 30,    fmt: v => `${v.toFixed(0)} %`  },
  { id: 'mix',       label: 'MIX',       min: 0,    max: 100,   default: 30,    fmt: v => `${v.toFixed(0)} %`  },
  // Row 2 — Filters & modulation
  { id: 'filter_lo', label: 'LO CUT',    min: 20,   max: 2000,  default: 80,    fmt: v => `${v.toFixed(0)} Hz` },
  { id: 'filter_hi', label: 'HI CUT',    min: 1000, max: 20000, default: 12000, fmt: v => `${v.toFixed(0)} Hz` },
  { id: 'mod_rate',  label: 'MOD RATE',  min: 0.01, max: 5,     default: 0.3,   fmt: v => `${v.toFixed(2)} Hz` },
  { id: 'mod_depth', label: 'MOD DEPTH', min: 0,    max: 100,   default: 15,    fmt: v => `${v.toFixed(0)} %`  },
  // Row 3 — Stereo & ducking
  { id: 'stereo_width', label: 'WIDTH',  min: 0,    max: 100,   default: 50,    fmt: v => `${v.toFixed(0)} %`  },
  { id: 'duck_amount',  label: 'DUCK',   min: 0,    max: 100,   default: 0,     fmt: v => `${v.toFixed(0)} %`  },
]

const SYNC_DIVISIONS = [
  { value: 0,  label: '1/1'   },
  { value: 1,  label: '1/2'   },
  { value: 2,  label: '1/2D'  },
  { value: 3,  label: '1/4'   },
  { value: 4,  label: '1/4D'  },
  { value: 5,  label: '1/4T'  },
  { value: 6,  label: '1/8'   },
  { value: 7,  label: '1/8D'  },
  { value: 8,  label: '1/8T'  },
  { value: 9,  label: '1/16'  },
  { value: 10, label: '1/16D' },
  { value: 11, label: '1/16T' },
]

const DEFAULT_PARAMS = {
  ...Object.fromEntries(KNOBS.map(k => [k.id, k.default])),
  sync: 0,
  sync_div_l: 3,
  sync_div_r: 3,
}

// ── DelayPanel ──────────────────────────────────────────────────────────────

export default function DelayPanel() {
  const target = useDelayStore(s => s.target)
  const close  = useDelayStore(s => s.close)

  // Local param state — hydrated from engine on open
  const [params, setParams] = useState(DEFAULT_PARAMS)

  // Panel drag state
  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 260),
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
        console.warn('[DelayPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // Set a parameter value (live drag or commit)
  const setParam = useCallback((id, value) => {
    if (!target) return
    setParams(prev => ({ ...prev, [id]: value }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, id, value)
  }, [target])

  if (!target) return null

  const synced = params.sync >= 0.5

  return (
    <div
      className="delay-panel"
      style={{ left: panelPos.x, top: panelPos.y }}
    >
      {/* Header */}
      <div className="delay-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="delay-panel-title">Delay</span>
        <button className="delay-panel-close" onClick={close} title="Close">
          <X size={12} />
        </button>
      </div>

      {/* Sync row */}
      <div className="delay-sync-row">
        <span className="delay-sync-label">Time:</span>
        <button
          className={`delay-sync-btn${!synced ? ' active' : ''}`}
          onClick={() => setParam('sync', 0)}
        >
          Free
        </button>
        <button
          className={`delay-sync-btn${synced ? ' active' : ''}`}
          onClick={() => setParam('sync', 1)}
        >
          Sync
        </button>

        <span className="delay-sync-select-label">L</span>
        <select
          className="delay-sync-select"
          value={Math.round(params.sync_div_l)}
          disabled={!synced}
          onChange={(e) => setParam('sync_div_l', Number(e.target.value))}
        >
          {SYNC_DIVISIONS.map(d => (
            <option key={d.value} value={d.value}>{d.label}</option>
          ))}
        </select>

        <span className="delay-sync-select-label">R</span>
        <select
          className="delay-sync-select"
          value={Math.round(params.sync_div_r)}
          disabled={!synced}
          onChange={(e) => setParam('sync_div_r', Number(e.target.value))}
        >
          {SYNC_DIVISIONS.map(d => (
            <option key={d.value} value={d.value}>{d.label}</option>
          ))}
        </select>
      </div>

      {/* Knob grid */}
      <div className="delay-knob-grid">
        {KNOBS.map(k => {
          // Dim time knobs when synced
          const dimmed = synced && (k.id === 'time_l' || k.id === 'time_r')
          return (
            <div key={k.id} className="delay-knob-cell" style={dimmed ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
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
          )
        })}
      </div>
    </div>
  )
}
