import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
import usePitchShifterStore from '../../stores/pitchShifterStore.js'
import PluginUIKitKnob from '../../plugin-ui/runtime/components/PluginUIKitKnob.jsx'
import XlethSelect from '../common/XlethSelect.jsx'

// Pitch Shifter panel (XlethPitchShifterEffect, pluginId "pitchshifter").
//
// Four modes select two DIFFERENT parameter sets, not just different DSP:
//   Granular         → mix, semitones, cents, size
//   Smart / Voice     → mix, semitones, cents, formant
//   Clip              → mix, clip_semitones, clip_cents, clip_method, clip_formant
//
// There is no declarative plugin-ui visibility primitive for "show these
// controls only in mode N" (see DistortionPanel.jsx's own mode-mirrored-into-
// local-state precedent), so this panel is hand-written: `mode` is read back
// from the engine into local state and the body below branches on it,
// HIDING the controls that don't apply rather than graying them out.
//
// `mode`, `clip_method`, and `clip_formant` are all declared
// withAutomatable(false) engine-side (see XlethPitchShifterEffect.h). They are
// therefore rendered as buttons/select here, never PluginUIKitKnob — so no
// paramId/automationTarget is ever wired to a control the engine cannot
// automate in the first place.

const MIXER_RING_APPEARANCE = { preset: 'mixer-ring', sizePreset: 'inherit' }

const MODES = [
  { value: 0, label: 'Granular' },
  { value: 1, label: 'Smart' },
  { value: 2, label: 'Voice' },
  { value: 3, label: 'Clip' },
]

const CLIP_METHOD_OPTIONS = [
  { value: 0, label: 'PSOLA' },
  { value: 1, label: 'Rubber' },
  { value: 2, label: 'WSOLA' },
  { value: 3, label: 'PhaseVocoder' },
  { value: 4, label: 'WORLD' },
]

const fmtSt = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} st`
const fmtCt = v => `${v >= 0 ? '+' : ''}${v.toFixed(0)} ct`

// Mirrors XlethPitchShifterEffect::createLayout() exactly — ranges, defaults,
// and labels never send a value the engine would clamp.
const MIX_KNOB = { id: 'mix', label: 'MIX', min: 0, max: 1, default: 1, fmt: v => `${Math.round(v * 100)} %` }
const SEMITONES_KNOB = { id: 'semitones', label: 'SEMITONES', min: -24, max: 24, default: 0, fmt: fmtSt }
const CENTS_KNOB = { id: 'cents', label: 'CENTS', min: -100, max: 100, default: 0, fmt: fmtCt }
const SIZE_KNOB = { id: 'size', label: 'GRAIN SIZE', min: 10, max: 100, default: 50, fmt: v => `${v.toFixed(0)} ms` }
const FORMANT_KNOB = { id: 'formant', label: 'FORMANT', min: 0.5, max: 2, default: 1, fmt: v => `${v.toFixed(2)} x` }
const CLIP_SEMITONES_KNOB = { id: 'clip_semitones', label: 'SEMITONES', min: -24, max: 24, default: 0, fmt: fmtSt }
const CLIP_CENTS_KNOB = { id: 'clip_cents', label: 'CENTS', min: -100, max: 100, default: 0, fmt: fmtCt }

const DEFAULT_PARAMS = {
  mode: 0,
  mix: MIX_KNOB.default,
  semitones: SEMITONES_KNOB.default,
  cents: CENTS_KNOB.default,
  size: SIZE_KNOB.default,
  formant: FORMANT_KNOB.default,
  clip_semitones: CLIP_SEMITONES_KNOB.default,
  clip_cents: CLIP_CENTS_KNOB.default,
  clip_method: 1, // Rubber — matches the engine's default
  clip_formant: 0,
}

function KnobCell({ knob, value, automationTarget, onPreview, onCommit }) {
  return (
    <div className="pitchshifter-knob-cell">
      <PluginUIKitKnob
        value={value}
        min={knob.min}
        max={knob.max}
        defaultValue={knob.default}
        label={knob.label}
        formatValue={knob.fmt}
        onLiveChange={v => onPreview(knob.id, v)}
        onCommit={v => onCommit(knob.id, v)}
        size={64}
        dragRange={150}
        appearance={MIXER_RING_APPEARANCE}
        paramId={knob.id}
        automationTarget={automationTarget}
      />
      <div className="pitchshifter-knob-value">{knob.fmt(value)}</div>
    </div>
  )
}

export default function PitchShifterPanel() {
  const target = usePitchShifterStore(s => s.target)
  const close = usePitchShifterStore(s => s.close)

  const [params, setParams] = useState(DEFAULT_PARAMS)

  const targetRef = useRef(target)
  const pendingRef = useRef(null)
  const rafRef = useRef(0)
  targetRef.current = target

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 220),
    y: 100,
  }))
  const panelDragRef = useRef(null)

  const handlePanelMouseDown = useCallback((e) => {
    if (e.target.closest('button') || e.target.closest('select')) return
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
        x: Math.max(-360, Math.min(window.innerWidth - 100, startPanelX + e.clientX - startMouseX)),
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
      console.warn('[PitchShifterPanel] audio.getEffectParameters is unavailable — panel will show defaults')
      return
    }
    ;(async () => {
      try {
        const raw = await window.xleth.audio.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...DEFAULT_PARAMS }
        for (const p of list) {
          if (!(p.id in next)) continue
          next[p.id] = (p.id === 'mode' || p.id === 'clip_method') ? Math.round(p.value) : p.value
        }
        setParams(next)
      } catch (e) {
        console.warn('[PitchShifterPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  // ── Engine writes ──────────────────────────────────────────────────────────
  const sendParam = useCallback((id, value) => {
    const t = targetRef.current
    if (!t) return
    const fn = window.xleth?.audio?.setEffectParameter
    if (typeof fn !== 'function') {
      console.warn('[PitchShifterPanel] audio.setEffectParameter is unavailable — dropped', id, value)
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

  // Drag-time write: local state tracks the pointer at 60 fps, engine write
  // coalesced to at most one per animation frame per parameter.
  const previewParam = useCallback((id, value) => {
    setParams(prev => (prev[id] === value ? prev : { ...prev, [id]: value }))
    pendingRef.current = { ...(pendingRef.current || {}), [id]: value }
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flushPending)
  }, [flushPending])

  // Release / discrete write: local state + an immediate authoritative send.
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

  const mode = Math.round(params.mode)
  const isGranular = mode === 0
  const isLive = mode === 1 || mode === 2
  const isClip = mode === 3

  return (
    <div className="pitchshifter-panel" style={{ left: panelPos.x, top: panelPos.y }}>
      <div className="pitchshifter-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="pitchshifter-panel-title">PITCH SHIFTER</span>
        <button className="pitchshifter-panel-close" onClick={close} title="Close">
          <X size={13} />
        </button>
      </div>

      <div className="pitchshifter-mode-row">
        {MODES.map(m => (
          <button
            key={m.value}
            type="button"
            className={`pitchshifter-mode-btn${mode === m.value ? ' active' : ''}`}
            onClick={() => commitParam('mode', m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="pitchshifter-knob-row">
        <KnobCell knob={MIX_KNOB} value={params.mix} automationTarget={target} onPreview={previewParam} onCommit={commitParam} />

        {(isGranular || isLive) && (
          <>
            <KnobCell knob={SEMITONES_KNOB} value={params.semitones} automationTarget={target} onPreview={previewParam} onCommit={commitParam} />
            <KnobCell knob={CENTS_KNOB} value={params.cents} automationTarget={target} onPreview={previewParam} onCommit={commitParam} />
          </>
        )}

        {isGranular && (
          <KnobCell knob={SIZE_KNOB} value={params.size} automationTarget={target} onPreview={previewParam} onCommit={commitParam} />
        )}

        {isLive && (
          <KnobCell knob={FORMANT_KNOB} value={params.formant} automationTarget={target} onPreview={previewParam} onCommit={commitParam} />
        )}

        {isClip && (
          <>
            <KnobCell knob={CLIP_SEMITONES_KNOB} value={params.clip_semitones} automationTarget={target} onPreview={previewParam} onCommit={commitParam} />
            <KnobCell knob={CLIP_CENTS_KNOB} value={params.clip_cents} automationTarget={target} onPreview={previewParam} onCommit={commitParam} />

            <div className="pitchshifter-clip-method">
              <span className="pitchshifter-clip-method-label">METHOD</span>
              <XlethSelect
                className="pitchshifter-clip-method-select"
                value={params.clip_method}
                options={CLIP_METHOD_OPTIONS}
                ariaLabel="Clip stretch method"
                onChange={v => commitParam('clip_method', v)}
              />
            </div>

            <button
              type="button"
              className={`pitchshifter-clip-formant-btn${params.clip_formant >= 0.5 ? ' active' : ''}`}
              onClick={() => commitParam('clip_formant', params.clip_formant >= 0.5 ? 0 : 1)}
            >
              FORMANT
            </button>
          </>
        )}
      </div>

      {isClip && (
        <div className="pitchshifter-clip-hint">
          <div>Method and Formant apply to audio clips only — pattern tracks ignore them.</div>
          <div>PSOLA and WORLD resynthesize — mid Mix can comb. Rubber, WSOLA, and PhaseVocoder blend cleanly.</div>
          <div>Clips with vibrato or scratch modulation aren't shifted.</div>
        </div>
      )}
    </div>
  )
}
