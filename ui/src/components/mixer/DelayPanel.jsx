import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useDelayStore from '../../stores/delayStore.js'
import Knob from '../sampler/Knob.jsx'
import DelayTapeheadVisualizer from './DelayTapeheadVisualizer.jsx'

// ── Parameter definitions ────────────────────────────────────────────────────

const KNOBS = [
  // Row 1 — Time, core, stereo
  { id: 'time_l',       label: 'TIME L',    min: 1,    max: 5000,  default: 500,   fmt: v => `${v.toFixed(0)} ms` },
  { id: 'time_r',       label: 'TIME R',    min: 1,    max: 5000,  default: 500,   fmt: v => `${v.toFixed(0)} ms` },
  { id: 'feedback',     label: 'FEEDBACK',  min: 0,    max: 95,    default: 30,    fmt: v => `${v.toFixed(0)} %`  },
  { id: 'mix',          label: 'MIX',       min: 0,    max: 100,   default: 30,    fmt: v => `${v.toFixed(0)} %`  },
  { id: 'stereo_width', label: 'WIDTH',     min: 0,    max: 100,   default: 50,    fmt: v => `${v.toFixed(0)} %`  },
  // Row 2 — Filters, modulation, ducking
  { id: 'filter_lo',    label: 'LO CUT',    min: 20,   max: 2000,  default: 80,    fmt: v => `${v.toFixed(0)} Hz` },
  { id: 'filter_hi',    label: 'HI CUT',    min: 1000, max: 20000, default: 12000, fmt: v => `${v.toFixed(0)} Hz` },
  { id: 'mod_rate',     label: 'MOD RATE',  min: 0.01, max: 5,     default: 0.3,   fmt: v => `${v.toFixed(2)} Hz` },
  { id: 'mod_depth',    label: 'MOD DEPTH', min: 0,    max: 100,   default: 15,    fmt: v => `${v.toFixed(0)} %`  },
  { id: 'duck_amount',  label: 'DUCK',      min: 0,    max: 100,   default: 0,     fmt: v => `${v.toFixed(0)} %`  },
]

const DEFAULT_PARAMS = {
  ...Object.fromEntries(KNOBS.map(k => [k.id, k.default])),
  sync: 0,
  sync_div_l: 3,
  sync_div_r: 3,
}

// ── Legacy sync adapter ─────────────────────────────────────────────────────
// The engine stores sync_div_l/r as an integer index 0–11 into kDivFractions.
// A future engine version will expose separate note + feel params. Until then
// we translate at the UI layer only — the engine always receives the legacy
// index; no fake params are ever sent.
//
// Index map (matches engine kDivFractions exactly):
//   0=1/1 str  1=1/2 str  2=1/2 dot
//   3=1/4 str  4=1/4 dot  5=1/4 tri
//   6=1/8 str  7=1/8 dot  8=1/8 tri
//   9=1/16 str 10=1/16 dot 11=1/16 tri
const SYNC_NOTE_FEEL = [
  { note: '1/1',  feel: 'straight' }, // 0
  { note: '1/2',  feel: 'straight' }, // 1
  { note: '1/2',  feel: 'dotted'   }, // 2
  { note: '1/4',  feel: 'straight' }, // 3
  { note: '1/4',  feel: 'dotted'   }, // 4
  { note: '1/4',  feel: 'triplet'  }, // 5
  { note: '1/8',  feel: 'straight' }, // 6
  { note: '1/8',  feel: 'dotted'   }, // 7
  { note: '1/8',  feel: 'triplet'  }, // 8
  { note: '1/16', feel: 'straight' }, // 9
  { note: '1/16', feel: 'dotted'   }, // 10
  { note: '1/16', feel: 'triplet'  }, // 11
]

/** Decodes a legacy sync_div index to { note, feel }. Clamps to [0, 11]. */
export function indexToNoteFeel(idx) {
  const i = Math.round(Math.max(0, Math.min(11, idx ?? 3)))
  return SYNC_NOTE_FEEL[i]
}

/**
 * Encodes a { note, feel } pair to the legacy engine index.
 * Returns null if the combo is not supported by the current engine.
 */
export function noteFeelToIndex(note, feel) {
  const i = SYNC_NOTE_FEEL.findIndex(e => e.note === note && e.feel === feel)
  return i === -1 ? null : i
}

/** Returns the feels available for a given note value. */
export function availableFeels(note) {
  return SYNC_NOTE_FEEL.filter(e => e.note === note).map(e => e.feel)
}

const NOTE_OPTIONS = ['1/1', '1/2', '1/4', '1/8', '1/16']
const FEEL_OPTIONS = [
  { value: 'straight', label: 'Str' },
  { value: 'dotted',   label: 'Dot' },
  { value: 'triplet',  label: 'Tri' },
]

// ── DelayPanel ───────────────────────────────────────────────────────────────

export default function DelayPanel() {
  const target = useDelayStore(s => s.target)
  const close  = useDelayStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)

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

  const setParam = useCallback((id, value) => {
    if (!target) return
    setParams(prev => ({ ...prev, [id]: value }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, id, value)
  }, [target])

  // Note/Feel change handler: converts the selected pair to the legacy engine
  // index and sends sync_div_l or sync_div_r. If the combo is unsupported
  // (shouldn't happen with valid UI state) we do nothing.
  const handleNoteFeel = useCallback((side, note, feel) => {
    const divParam = side === 'L' ? 'sync_div_l' : 'sync_div_r'
    // If the current feel is not valid for the new note, fall back to straight.
    const resolvedFeel = availableFeels(note).includes(feel) ? feel : 'straight'
    const idx = noteFeelToIndex(note, resolvedFeel)
    if (idx !== null) setParam(divParam, idx)
  }, [setParam])

  if (!target) return null

  const synced = params.sync >= 0.5

  // Derive current note + feel from stored engine indices.
  const nfL = indexToNoteFeel(params.sync_div_l)
  const nfR = indexToNoteFeel(params.sync_div_r)

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

      {/* Tapehead visualizer */}
      <div className="delay-viz-wrap">
        <DelayTapeheadVisualizer params={params} />
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

        {/* L channel Note + Feel */}
        <span className="delay-sync-chan-label">L</span>
        <select
          className="delay-note-select"
          value={nfL.note}
          disabled={!synced}
          onChange={(e) => handleNoteFeel('L', e.target.value, nfL.feel)}
        >
          {NOTE_OPTIONS.map(n => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <div className="delay-feel-group">
          {FEEL_OPTIONS.map(f => {
            const supported = availableFeels(nfL.note).includes(f.value)
            const active    = nfL.feel === f.value
            return (
              <button
                key={f.value}
                className={`delay-feel-btn${active ? ' active' : ''}`}
                disabled={!synced || !supported}
                onClick={() => handleNoteFeel('L', nfL.note, f.value)}
              >
                {f.label}
              </button>
            )
          })}
        </div>

        {/* R channel Note + Feel */}
        <span className="delay-sync-chan-label">R</span>
        <select
          className="delay-note-select"
          value={nfR.note}
          disabled={!synced}
          onChange={(e) => handleNoteFeel('R', e.target.value, nfR.feel)}
        >
          {NOTE_OPTIONS.map(n => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <div className="delay-feel-group">
          {FEEL_OPTIONS.map(f => {
            const supported = availableFeels(nfR.note).includes(f.value)
            const active    = nfR.feel === f.value
            return (
              <button
                key={f.value}
                className={`delay-feel-btn${active ? ' active' : ''}`}
                disabled={!synced || !supported}
                onClick={() => handleNoteFeel('R', nfR.note, f.value)}
              >
                {f.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Knob grid */}
      <div className="delay-knob-grid">
        {KNOBS.map(k => {
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
