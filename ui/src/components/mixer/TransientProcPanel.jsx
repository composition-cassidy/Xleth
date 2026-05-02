import React, { useState, useEffect, useRef, useCallback, Component, Suspense, lazy } from 'react'
import { X } from 'lucide-react'
import useTransientProcStore from '../../stores/transientProcStore.js'
import Knob from '../sampler/Knob.jsx'
import StockPluginRuntimeRenderer from '../../plugin-ui/runtime/StockPluginRuntimeRenderer.jsx'
import { DESIGNER_ENABLED } from '../../plugin-ui/designer/featureFlag.js'

// Lazy: only pulled into the bundle when DESIGNER_ENABLED gates the import-time
// access at the call site. We still use lazy() so the module can be code-split
// inside dev builds and so we don't pay its hydration cost until the user
// actually clicks "Edit UI".
const PluginUIDesigner = DESIGNER_ENABLED
  ? lazy(() => import('../../plugin-ui/designer/PluginUIDesigner.jsx'))
  : null
const DesignerPreview = DESIGNER_ENABLED
  ? lazy(() => import('../../plugin-ui/designer/DesignerPreview.jsx'))
  : null

const PLUGIN_ID = 'transientproc'

// ── Legacy body ───────────────────────────────────────────────────────────────
// Rendered only when the runtime renderer throws an unrecoverable error.
// Kept intentionally — delete once the runtime path has proven stable across releases.

const LEGACY_KNOBS = [
  { id: 'attack',       label: 'ATTACK',  min: -100, max: 100, default: 0,    fmt: v => `${v.toFixed(0)} %`  },
  { id: 'sustain',      label: 'SUSTAIN', min: -100, max: 100, default: 0,    fmt: v => `${v.toFixed(0)} %`,  envOnly: true },
  { id: 'attack_speed', label: 'SPEED',   min: 0.5,  max: 20,  default: 5,    fmt: v => `${v.toFixed(1)} ms` },
  { id: 'threshold',    label: 'THRESH',  min: -60,  max: 0,   default: -60,  fmt: v => `${v.toFixed(0)} dB`, envOnly: true },
  { id: 'mix',          label: 'MIX',     min: 0,    max: 100, default: 100,  fmt: v => `${v.toFixed(0)} %`  },
]
const LEGACY_DEFAULTS = Object.fromEntries(LEGACY_KNOBS.map(k => [k.id, k.default]))

function LegacyTransientProcBody({ target }) {
  const [params, setParams] = useState(LEGACY_DEFAULTS)
  const [midiMode, setMidiMode] = useState(0)

  const gainBarRef   = useRef(null)
  const gainLabelRef = useRef(null)
  const rafRef       = useRef(null)
  const lastPollRef  = useRef(0)

  useEffect(() => {
    if (!target) return
    setParams(LEGACY_DEFAULTS)
    setMidiMode(0)
    ;(async () => {
      try {
        const raw  = await window.xleth?.audio?.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...LEGACY_DEFAULTS }
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
            if (gainLabelRef.current) gainLabelRef.current.textContent = gainDB.toFixed(1)
          }
        } catch {}
      }
      rafRef.current = requestAnimationFrame(poll)
    }
    rafRef.current = requestAnimationFrame(poll)
    return () => { active = false; cancelAnimationFrame(rafRef.current) }
  }, [target])

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

  return (
    <>
      <div className="transientproc-mode-row">
        <span className="transientproc-mode-label">Mode:</span>
        <button
          className={`transientproc-mode-btn${midiMode === 0 ? ' transientproc-mode-btn--active' : ''}`}
          onClick={() => setMode(0)}
        >Envelope</button>
        <button
          className={`transientproc-mode-btn${midiMode === 1 ? ' transientproc-mode-btn--active' : ''}`}
          onClick={() => setMode(1)}
        >MIDI</button>

        <div className="transientproc-gain-meter" title="Gain activity">
          <div className="transientproc-gain-track">
            <div className="transientproc-gain-bar" ref={gainBarRef} />
          </div>
          <div className="transientproc-gain-label">
            <span ref={gainLabelRef}>0.0</span> dB
          </div>
        </div>
      </div>

      <div className="transientproc-knob-grid">
        {LEGACY_KNOBS.map(k => {
          const disabled = midiMode === 1 && k.envOnly
          return (
            <div
              key={k.id}
              className={`transientproc-knob-cell${disabled ? ' transientproc-knob-cell--disabled' : ''}`}
              title={disabled ? 'N/A in MIDI mode' : undefined}
            >
              <Knob
                value={params[k.id]} min={k.min} max={k.max} defaultValue={k.default}
                label={k.label} formatValue={k.fmt}
                onLiveChange={v => setParam(k.id, v)} onCommit={v => setParam(k.id, v)}
                size={52} dragRange={150}
              />
            </div>
          )
        })}
        <div className="transientproc-knob-cell transientproc-knob-cell--spacer" />
      </div>
    </>
  )
}

// ── Error boundary ────────────────────────────────────────────────────────────

class RuntimeBodyBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  componentDidCatch(err, info) {
    console.error('[TransientProcPanel] Runtime renderer failed, falling back to legacy body:', err, info?.componentStack)
  }
  render() {
    if (this.state.hasError) {
      return <LegacyTransientProcBody target={this.props.target} />
    }
    return this.props.children
  }
}

class DesignerColumnBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, message: null }
  }
  static getDerivedStateFromError(err) {
    return { hasError: true, message: err?.message || String(err) }
  }
  componentDidCatch(err, info) {
    console.error('[PluginUIDesigner] Crashed:', err, info?.componentStack)
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="pluginui-designer-root">
          <div className="pluginui-designer-error">
            Designer crashed. Close and re-open it.
            {this.state.message ? <div style={{ marginTop: 4, opacity: 0.7 }}>{this.state.message}</div> : null}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

class DesignerPreviewBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  componentDidCatch(err, info) {
    console.error('[DesignerPreview] Crashed; falling back to bare runtime:', err, info?.componentStack)
  }
  render() {
    if (this.state.hasError) {
      const { target, onClose } = this.props
      return <StockPluginRuntimeRenderer pluginId={PLUGIN_ID} target={target} onClose={onClose} />
    }
    return this.props.children
  }
}

// ── Panel chrome ──────────────────────────────────────────────────────────────

export default function TransientProcPanel() {
  const target = useTransientProcStore(s => s.target)
  const close  = useTransientProcStore(s => s.close)

  const [designerOpen, setDesignerOpen] = useState(false)
  const designerCloseGuardRef = useRef(null)

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

  const requestDesignerClose = useCallback(async () => {
    if (!designerOpen) return true
    const guard = designerCloseGuardRef.current
    if (typeof guard !== 'function') return true
    try {
      return !!await guard()
    } catch {
      return false
    }
  }, [designerOpen])

  const handleEditUiClick = useCallback(async () => {
    if (!designerOpen) {
      setDesignerOpen(true)
      return
    }
    if (await requestDesignerClose()) {
      setDesignerOpen(false)
    }
  }, [designerOpen, requestDesignerClose])

  const handlePanelClose = useCallback(async () => {
    if (await requestDesignerClose()) {
      close()
    }
  }, [close, requestDesignerClose])

  if (!target) return null

  const panelCls = `transientproc-panel${DESIGNER_ENABLED && designerOpen ? ' transientproc-panel--designer-open' : ''}`

  return (
    <div className={panelCls} style={{ left: panelPos.x, top: panelPos.y }}>
      <div className="transientproc-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="transientproc-panel-title">Transient Processor</span>
        {DESIGNER_ENABLED && (
          <button
            className={`transientproc-panel-edit-ui${designerOpen ? ' transientproc-panel-edit-ui--active' : ''}`}
            onClick={handleEditUiClick}
            title={designerOpen ? 'Close Designer' : 'Edit UI'}
            aria-pressed={designerOpen}
          >
            Edit UI
          </button>
        )}
        <button className="transientproc-panel-close" onClick={handlePanelClose} title="Close">
          <X size={12} />
        </button>
      </div>

      <div className="transientproc-panel-split">
        <div className="transientproc-panel-runtime-pane">
          <RuntimeBodyBoundary target={target}>
            {DESIGNER_ENABLED && designerOpen && DesignerPreview ? (
              <DesignerPreviewBoundary target={target} onClose={close}>
                <Suspense fallback={<div className="pluginui-designer-loading">Loading preview…</div>}>
                  <DesignerPreview pluginId={PLUGIN_ID} target={target} onClose={close} />
                </Suspense>
              </DesignerPreviewBoundary>
            ) : (
              <StockPluginRuntimeRenderer pluginId={PLUGIN_ID} target={target} onClose={close} />
            )}
          </RuntimeBodyBoundary>
        </div>

        {DESIGNER_ENABLED && designerOpen && PluginUIDesigner && (
          <DesignerColumnBoundary>
            <Suspense fallback={<div className="pluginui-designer-root"><div className="pluginui-designer-loading">Loading Designer…</div></div>}>
              <PluginUIDesigner
                pluginId={PLUGIN_ID}
                onClose={() => setDesignerOpen(false)}
                registerCloseGuard={(guard) => {
                  designerCloseGuardRef.current = guard
                  return () => {
                    if (designerCloseGuardRef.current === guard) {
                      designerCloseGuardRef.current = null
                    }
                  }
                }}
              />
            </Suspense>
          </DesignerColumnBoundary>
        )}
      </div>
    </div>
  )
}
