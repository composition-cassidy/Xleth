import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import useVariMuCompStore from '../../stores/variMuCompStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'

// Vari-Mu Comp panel (XlethVariMuCompressorEffect, pluginId "varimu") — the
// Fairchild 660/670-lineage variable-mu tube limiter on the shared CompressorCore.
//
// The unit's face minus its threshold: INPUT and OUTPUT around the gain-
// reduction meter, the six-position TIME CONSTANT switch and the channel MODE.
// There is no threshold and no ratio: INPUT drives the signal into the tube's
// curve, and the ratio rises with the amount of limiting. TIME CONSTANT keeps
// the hardware's positions 1–6 and shows the ORIGINAL manual's figures (the
// engine divides them by 3 to get its RC time constants); 5 and 6 are the
// automatic, program-dependent positions. MODE is Linked (one control voltage
// for L and R) or Mid/Side — deliberately not the hardware's disputed
// "Lat/Vert" labels. In Mid/Side the meter splits into M and S bars (meter
// slots 4/5); Linked shows the one control signal (slot 2).
//
// Both switches are index-valued engine params rendered as segmented groups; like
// every stock panel's choice params they carry no paramId/automationTarget, so
// they never offer automation. Engine writes follow the house pattern: local
// state every pointer move, engine writes rAF-coalesced to one per parameter per
// frame, one authoritative setEffectParameter on release.

const MIXER_RING_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit' }

const fmtDb = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`

// Mirrors XlethVariMuCompressorEffect::createLayout() exactly.
const INPUT_KNOB  = { id: 'input',  label: 'INPUT',  min: -24, max: 36, default: 0, fmt: fmtDb, size: 72 }
const OUTPUT_KNOB = { id: 'output', label: 'OUTPUT', min: -24, max: 24, default: 0, fmt: fmtDb, size: 72 }

// Fairchild670::kPositions (the original manual's figures), positions 1..6.
export const TIME_CONSTANTS = [
  { pos: 1, attack: '0.2 ms', release: '0.3 s' },
  { pos: 2, attack: '0.2 ms', release: '0.8 s' },
  { pos: 3, attack: '0.4 ms', release: '2 s' },
  { pos: 4, attack: '0.4 ms', release: '5 s' },
  { pos: 5, attack: '0.4 ms', release: 'AUTO 2 s · 10 s', auto: true },
  { pos: 6, attack: '0.2 ms', release: 'AUTO 0.3 s · 10 s · 25 s', auto: true },
]

// Engine "mode": 0 = Linked, 1 = Mid/Side.
export const MODES = ['LINKED', 'MID/SIDE']

const DEFAULT_PARAMS = {
  input: INPUT_KNOB.default,
  output: OUTPUT_KNOB.default,
  time_constant: 2,
  mode: 0,
}
const INDEX_PARAMS = new Set(['time_constant', 'mode'])

// Gain-reduction meter full scale (dB).
const GR_FULL_SCALE_DB = 20

function KnobCell({ knob, value, automationTarget, onPreview, onCommit }) {
  return (
    <div className="varimu-knob-cell">
      <PluginUIKitKnob
        value={value}
        min={knob.min}
        max={knob.max}
        defaultValue={knob.default}
        label={knob.label}
        formatValue={knob.fmt}
        onLiveChange={v => onPreview(knob.id, v)}
        onCommit={v => onCommit(knob.id, v)}
        size={knob.size}
        dragRange={180}
        appearance={MIXER_RING_APPEARANCE}
        paramId={knob.id}
        automationTarget={automationTarget}
      />
      <div className="varimu-knob-value">{knob.fmt(value)}</div>
    </div>
  )
}

export default function VariMuCompPanel() {
  const target = useVariMuCompStore(s => s.target)
  const close = useVariMuCompStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)

  const targetRef = useRef(target)
  const pendingRef = useRef(null)
  const rafRef = useRef(0)
  const meterRafRef = useRef(0)
  const lastPollRef = useRef(0)
  // [0] = Linked / mid, [1] = side
  const grBarRefs = [useRef(null), useRef(null)]
  const grLabelRefs = [useRef(null), useRef(null)]
  targetRef.current = target
  const modeRef = useRef(params.mode)
  modeRef.current = params.mode

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 230),
    y: 110,
  }))
  const panelDragRef = useRef(null)

  const handlePanelMouseDown = useCallback((e) => {
    if (e.target.closest('button')) return
    e.preventDefault()
    panelDragRef.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startPanelX: panelPos.x,
      startPanelY: panelPos.y,
    }
  }, [panelPos])

  useEffect(() => {
    const onMove = (e) => {
      if (!panelDragRef.current) return
      const { startMouseX, startMouseY, startPanelX, startPanelY } = panelDragRef.current
      setPanelPos({
        x: Math.max(-300, Math.min(window.innerWidth - 100, startPanelX + e.clientX - startMouseX)),
        y: Math.max(0, Math.min(window.innerHeight - 100, startPanelY + e.clientY - startMouseY)),
      })
    }
    const onUp = () => { panelDragRef.current = null }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [])

  // ── Hydration ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!target) return
    setParams(DEFAULT_PARAMS)
    if (typeof window.xleth?.audio?.getEffectParameters !== 'function') {
      console.warn('[VariMuCompPanel] audio.getEffectParameters is unavailable — panel will show defaults')
      return
    }
    ;(async () => {
      try {
        const raw = await window.xleth.audio.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...DEFAULT_PARAMS }
        for (const p of list) {
          if (!(p.id in next)) continue
          next[p.id] = INDEX_PARAMS.has(p.id) ? Math.round(p.value) : p.value
        }
        setParams(next)
      } catch (e) {
        console.warn('[VariMuCompPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // ── Gain-reduction meter, ~30 Hz, written straight to the DOM ─────────────
  // Linked: slot 2 on the one bar. Mid/Side: slot 4 (mid) and slot 5 (side).
  useEffect(() => {
    if (!target) return
    let active = true
    const show = (i, grDb) => {
      const g = Math.max(0, grDb ?? 0)
      const bar = grBarRefs[i].current, label = grLabelRefs[i].current
      if (bar) bar.style.width = `${Math.min((g / GR_FULL_SCALE_DB) * 100, 100)}%`
      if (label) label.textContent = g.toFixed(1)
    }
    const poll = async () => {
      if (!active) return
      const now = performance.now()
      if (now - lastPollRef.current >= 33 && typeof window.xleth?.audio?.getEffectMeter === 'function') {
        lastPollRef.current = now
        try {
          const raw = await window.xleth.audio.getEffectMeter(target.trackId, target.nodeId)
          const meters = typeof raw === 'string' ? JSON.parse(raw) : raw
          if (active && Array.isArray(meters)) {
            if (modeRef.current === 1) {
              show(0, meters[4])
              show(1, meters[5])
            } else {
              show(0, meters[2])
            }
          }
        } catch { /* meter is best-effort */ }
      }
      if (active) meterRafRef.current = requestAnimationFrame(poll)
    }
    meterRafRef.current = requestAnimationFrame(poll)
    return () => { active = false; cancelAnimationFrame(meterRafRef.current) }
    // grBarRefs/grLabelRefs are stable refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  // ── Engine writes ──────────────────────────────────────────────────────────
  const sendParam = useCallback((id, value) => {
    const t = targetRef.current
    if (!t) return
    const fn = window.xleth?.audio?.setEffectParameter
    if (typeof fn !== 'function') {
      console.warn('[VariMuCompPanel] audio.setEffectParameter is unavailable — dropped', id, value)
      return
    }
    fn(t.trackId, t.nodeId, id, value)
  }, [])

  const flushPending = useCallback(() => {
    rafRef.current = 0
    const pending = pendingRef.current
    pendingRef.current = null
    if (!pending) return
    for (const id of Object.keys(pending)) sendParam(id, pending[id])
  }, [sendParam])

  const previewParam = useCallback((id, value) => {
    setParams(prev => (prev[id] === value ? prev : { ...prev, [id]: value }))
    pendingRef.current = { ...(pendingRef.current || {}), [id]: value }
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flushPending)
  }, [flushPending])

  const commitParam = useCallback((id, value) => {
    setParams(prev => (prev[id] === value ? prev : { ...prev, [id]: value }))
    if (pendingRef.current) delete pendingRef.current[id]
    sendParam(id, value)
  }, [sendParam])

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    pendingRef.current = null
  }, [])

  if (!target) return null

  const midSide = params.mode === 1
  const tc = TIME_CONSTANTS.find(t => t.pos === params.time_constant) ?? TIME_CONSTANTS[1]

  const meterBar = (i, label) => (
    <div className="varimu-gr-line" key={i}>
      {label && <span className="varimu-gr-channel">{label}</span>}
      <div className="varimu-gr-track"><div className="varimu-gr-bar" ref={grBarRefs[i]} /></div>
      <span className="varimu-gr-readout"><span ref={grLabelRefs[i]}>0.0</span></span>
    </div>
  )

  return (
    <div className="varimu-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      <div className="varimu-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="varimu-panel-title">VARI-MU COMP</span>
        <span className="varimu-panel-subtitle">VARIABLE-MU TUBE LIMITER</span>
        <button className="varimu-panel-close" onClick={close} title="Close">
          <X size={13} />
        </button>
      </div>

      <div className="varimu-main-row">
        <KnobCell knob={INPUT_KNOB} value={params.input} automationTarget={target}
          onPreview={previewParam} onCommit={commitParam} />
        <div className="varimu-gr" aria-label="Gain reduction">
          <div className="varimu-gr-label">GAIN REDUCTION dB</div>
          {midSide ? [meterBar(0, 'M'), meterBar(1, 'S')] : meterBar(0, null)}
          <div className={`varimu-gr-scale${midSide ? ' split' : ''}`}>
            <span>0</span><span>{GR_FULL_SCALE_DB / 4}</span><span>{GR_FULL_SCALE_DB / 2}</span><span>{GR_FULL_SCALE_DB}</span>
          </div>
        </div>
        <KnobCell knob={OUTPUT_KNOB} value={params.output} automationTarget={target}
          onPreview={previewParam} onCommit={commitParam} />
      </div>

      <div className="varimu-footer">
        <div className="varimu-switch-block">
          <div className="varimu-switch-label">TIME CONSTANT</div>
          <div className="varimu-seg" role="radiogroup" aria-label="Time Constant">
            {TIME_CONSTANTS.map(t => (
              <button
                key={t.pos}
                type="button"
                role="radio"
                aria-checked={params.time_constant === t.pos}
                title={`Position ${t.pos}: attack ${t.attack}, release ${t.release}`}
                className={`varimu-seg-btn${params.time_constant === t.pos ? ' active' : ''}${t.auto ? ' auto' : ''}`}
                onClick={() => commitParam('time_constant', t.pos)}
              >
                {t.pos}
              </button>
            ))}
          </div>
          <div className="varimu-tc-readout">ATTACK {tc.attack} · RELEASE {tc.release}</div>
        </div>
        <div className="varimu-switch-block mode">
          <div className="varimu-switch-label">MODE</div>
          <div className="varimu-seg" role="radiogroup" aria-label="Mode">
            {MODES.map((label, i) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={params.mode === i}
                title={i === 0 ? 'Stereo-linked: one control voltage for L and R' : 'Mid/Side: independent limiters on M and S'}
                className={`varimu-seg-btn${params.mode === i ? ' active' : ''}`}
                onClick={() => commitParam('mode', i)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
