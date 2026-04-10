import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useTransientProcStore from '../../stores/transientProcStore.js'
import Knob from '../sampler/Knob.jsx'

// ── Parameter definitions ────────────────────────────────────────────────────

const KNOBS = [
  // Row 1 — transient/sustain amounts (bipolar: center=0)
  { id: 'attack',       label: 'ATTACK',  min: -100, max: 100, default: 0,    fmt: v => `${v.toFixed(0)} %`  },
  { id: 'sustain',      label: 'SUSTAIN', min: -100, max: 100, default: 0,    fmt: v => `${v.toFixed(0)} %`,  envOnly: true },
  // Row 2 — timing / threshold / mix
  { id: 'attack_speed', label: 'SPEED',   min: 0.5,  max: 20,  default: 5,    fmt: v => `${v.toFixed(1)} ms` },
  { id: 'threshold',    label: 'THRESH',  min: -60,  max: 0,   default: -60,  fmt: v => `${v.toFixed(0)} dB`, envOnly: true },
  { id: 'mix',          label: 'MIX',     min: 0,    max: 100, default: 100,  fmt: v => `${v.toFixed(0)} %`  },
]

const DEFAULT_PARAMS = Object.fromEntries(KNOBS.map(k => [k.id, k.default]))

// ── TransientProcPanel ───────────────────────────────────────────────────────

export default function TransientProcPanel() {
  const target = useTransientProcStore(s => s.target)
  const close  = useTransientProcStore(s => s.close)

  // Local param state — hydrated from engine on open
  const [params, setParams]     = useState(DEFAULT_PARAMS)
  const [midiMode, setMidiMode] = useState(0) // 0=Envelope, 1=MIDI

  // Gain activity meter (updated via rAF)
  const gainBarRef   = useRef(null)
  const gainLabelRef = useRef(null)
  const rafRef       = useRef(null)
  const lastPollRef  = useRef(0)

  // Panel drag state
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
    setMidiMode(0)
    ;(async () => {
      try {
        const raw = await window.xleth?.audio?.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...DEFAULT_PARAMS }
        for (const p of list) {
          if (p.id in next)           next[p.id] = p.value
          if (p.id === 'midi_detect') setMidiMode(Math.round(p.value))
        }
        setParams(next)
      } catch (e) {
        console.warn('[TransientProcPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // 30fps gain meter polling via rAF
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
            // Slot 2: signed gainDB (positive=boosting, negative=cutting)
            const gainDB = meters[2] ?? 0
            const isBoosting = gainDB > 0.2
            const isCutting  = gainDB < -0.2
            const pct = Math.min(Math.abs(gainDB) / 24 * 100, 100)

            if (gainBarRef.current) {
              gainBarRef.current.style.width = pct + '%'
              gainBarRef.current.className = 'transientproc-gain-bar' +
                (isBoosting ? ' transientproc-gain-bar--boost' :
                 isCutting  ? ' transientproc-gain-bar--cut'   : '')
            }
            if (gainLabelRef.current) {
              gainLabelRef.current.textContent = gainDB.toFixed(1)
            }
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

  // Set a continuous parameter (live drag or commit)
  const setParam = useCallback((id, value) => {
    if (!target) return
    setParams(prev => ({ ...prev, [id]: value }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, id, value)
  }, [target])

  const setMode = useCallback((mode) => {
    if (!target) return
    setMidiMode(mode)
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, 'midi_detect', mode)
  }, [target])

  if (!target) return null

  return (
    <div
      className="transientproc-panel"
      style={{ left: panelPos.x, top: panelPos.y }}
    >
      {/* Header */}
      <div className="transientproc-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="transientproc-panel-title">Transient Processor</span>
        <button className="transientproc-panel-close" onClick={close} title="Close">
          <X size={12} />
        </button>
      </div>

      {/* Mode toggle row */}
      <div className="transientproc-mode-row">
        <span className="transientproc-mode-label">Mode:</span>
        <button
          className={`transientproc-mode-btn${midiMode === 0 ? ' transientproc-mode-btn--active' : ''}`}
          onClick={() => setMode(0)}
        >
          Envelope
        </button>
        <button
          className={`transientproc-mode-btn${midiMode === 1 ? ' transientproc-mode-btn--active' : ''}`}
          onClick={() => setMode(1)}
        >
          MIDI
        </button>

        {/* Gain activity indicator */}
        <div className="transientproc-gain-meter" title="Gain activity">
          <div className="transientproc-gain-track">
            <div className="transientproc-gain-bar" ref={gainBarRef} />
          </div>
          <div className="transientproc-gain-label">
            <span ref={gainLabelRef}>0.0</span> dB
          </div>
        </div>
      </div>

      {/* Knob grid — 3 columns, 2 rows */}
      <div className="transientproc-knob-grid">
        {KNOBS.map(k => {
          const disabled = midiMode === 1 && k.envOnly
          return (
            <div
              key={k.id}
              className={`transientproc-knob-cell${disabled ? ' transientproc-knob-cell--disabled' : ''}`}
              title={disabled ? 'N/A in MIDI mode' : undefined}
            >
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
        {/* Empty cell to fill row 1 col 3 (2 knobs in row 1, 3 in row 2) */}
        <div className="transientproc-knob-cell transientproc-knob-cell--spacer" />
      </div>
    </div>
  )
}
