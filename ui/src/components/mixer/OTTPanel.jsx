import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useOverdoneStore from '../../stores/overdoneStore.js'
import Knob from '../sampler/Knob.jsx'

// ── Parameter definitions ────────────────────────────────────────────────────

const KNOBS = [
  // Row 1: main controls
  { id: 'depth',      label: 'DEPTH',    min: 0,     max: 100,  default: 70,   fmt: v => `${v.toFixed(0)} %`,  size: 64 },
  { id: 'time',       label: 'TIME',     min: 0,     max: 100,  default: 50,   fmt: v => `${v.toFixed(0)} %` },
  // Row 2: band gains
  { id: 'gain_low',   label: 'LOW',      min: -12,   max: 12,   default: 0,    fmt: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB` },
  { id: 'gain_mid',   label: 'MID',      min: -12,   max: 12,   default: 0,    fmt: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB` },
  { id: 'gain_high',  label: 'HIGH',     min: -12,   max: 12,   default: 0,    fmt: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB` },
  // Row 3: crossovers
  { id: 'xover_low',  label: 'LO XOVER', min: 40,    max: 400,  default: 88,   fmt: v => `${v.toFixed(0)} Hz` },
  { id: 'xover_high', label: 'HI XOVER', min: 1000,  max: 8000, default: 2500, fmt: v => v >= 1000 ? `${(v / 1000).toFixed(1)}k Hz` : `${v.toFixed(0)} Hz` },
]

const DEFAULT_PARAMS = Object.fromEntries(KNOBS.map(k => [k.id, k.default]))

// ── OTTPanel ─────────────────────────────────────────────────────────────────

export default function OTTPanel() {
  const target = useOverdoneStore(s => s.target)
  const close  = useOverdoneStore(s => s.close)

  // Local param state — hydrated from engine on open
  const [params, setParams] = useState(DEFAULT_PARAMS)

  // GR meter refs (3 bands, updated via rAF — bypasses React setState for perf)
  const grLowBarRef    = useRef(null)
  const grMidBarRef    = useRef(null)
  const grHighBarRef   = useRef(null)
  const grLowLabelRef  = useRef(null)
  const grMidLabelRef  = useRef(null)
  const grHighLabelRef = useRef(null)
  const rafRef         = useRef(null)
  const lastPollRef    = useRef(0)

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
        const raw = await window.xleth?.audio?.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...DEFAULT_PARAMS }
        for (const p of list) {
          if (p.id in next) next[p.id] = p.value
        }
        setParams(next)
      } catch (e) {
        console.warn('[OTTPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // 30fps GR meter polling via rAF (3 bands)
  useEffect(() => {
    if (!target) return
    let active = true

    const barRefs   = [grLowBarRef, grMidBarRef, grHighBarRef]
    const labelRefs = [grLowLabelRef, grMidLabelRef, grHighLabelRef]

    const poll = async () => {
      if (!active) return
      const now = performance.now()
      if (now - lastPollRef.current >= 33) {
        lastPollRef.current = now
        try {
          const raw = await window.xleth?.audio?.getEffectMeter(target.trackId, target.nodeId)
          const meters = typeof raw === 'string' ? JSON.parse(raw) : raw
          if (Array.isArray(meters)) {
            for (let i = 0; i < 3; i++) {
              const grDb = Math.max(0, meters[2 + i] ?? 0)
              const pct  = Math.min(grDb / 30 * 100, 100)
              if (barRefs[i].current)   barRefs[i].current.style.height   = pct + '%'
              if (labelRefs[i].current) labelRefs[i].current.textContent  = grDb.toFixed(1)
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

  // Set a parameter value (live drag or commit)
  const setParam = useCallback((id, value) => {
    if (!target) return
    setParams(prev => ({ ...prev, [id]: value }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, id, value)
  }, [target])

  if (!target) return null

  return (
    <div
      className="ott-panel"
      style={{ left: panelPos.x, top: panelPos.y }}
    >
      {/* Header — only this area initiates panel drag */}
      <div className="ott-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="ott-panel-title">Overdone</span>
        <button className="ott-panel-close" onClick={close} title="Close">
          <X size={12} />
        </button>
      </div>

      {/* Body: knob grid + GR meters */}
      <div className="ott-panel-body">
        <div className="ott-knob-grid">
          {/* Row 1: Depth + Time */}
          <div className="ott-knob-row ott-knob-row--main">
            {KNOBS.slice(0, 2).map(k => (
              <div key={k.id} className="ott-knob-cell">
                <Knob
                  value={params[k.id]}
                  min={k.min}
                  max={k.max}
                  defaultValue={k.default}
                  label={k.label}
                  formatValue={k.fmt}
                  onLiveChange={v => setParam(k.id, v)}
                  onCommit={v => setParam(k.id, v)}
                  size={k.size || 52}
                  dragRange={150}
                />
              </div>
            ))}
          </div>

          {/* Row 2: Band gains */}
          <div className="ott-knob-row ott-knob-row--gains">
            {KNOBS.slice(2, 5).map(k => (
              <div key={k.id} className="ott-knob-cell">
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

          {/* Row 3: Crossovers */}
          <div className="ott-knob-row ott-knob-row--xover">
            {KNOBS.slice(5, 7).map(k => (
              <div key={k.id} className="ott-knob-cell">
                <Knob
                  value={params[k.id]}
                  min={k.min}
                  max={k.max}
                  defaultValue={k.default}
                  label={k.label}
                  formatValue={k.fmt}
                  onLiveChange={v => setParam(k.id, v)}
                  onCommit={v => setParam(k.id, v)}
                  size={48}
                  dragRange={150}
                />
              </div>
            ))}
          </div>
        </div>

        {/* GR meters — 3 bands */}
        <div className="ott-gr-meters">
          {/* Low */}
          <div className="ott-gr-band">
            <div className="ott-gr-track">
              <div className="ott-gr-bar ott-gr-bar--low" ref={grLowBarRef} />
            </div>
            <div className="ott-gr-label">L <span ref={grLowLabelRef}>0.0</span></div>
          </div>
          {/* Mid */}
          <div className="ott-gr-band">
            <div className="ott-gr-track">
              <div className="ott-gr-bar ott-gr-bar--mid" ref={grMidBarRef} />
            </div>
            <div className="ott-gr-label">M <span ref={grMidLabelRef}>0.0</span></div>
          </div>
          {/* High */}
          <div className="ott-gr-band">
            <div className="ott-gr-track">
              <div className="ott-gr-bar ott-gr-bar--high" ref={grHighBarRef} />
            </div>
            <div className="ott-gr-label">H <span ref={grHighLabelRef}>0.0</span></div>
          </div>
        </div>
      </div>
    </div>
  )
}
