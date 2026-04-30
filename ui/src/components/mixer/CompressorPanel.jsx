import React, { useState, useEffect, useRef, useCallback, Component, Suspense, lazy } from 'react'
import { X } from 'lucide-react'
import useCompressorStore from '../../stores/compressorStore.js'
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

// ── Legacy body ───────────────────────────────────────────────────────────────
// Rendered only when the runtime renderer throws an unrecoverable error.
// Kept intentionally — delete once the runtime path has proven stable across releases.

const LEGACY_KNOBS = [
  { id: 'threshold', label: 'THRESH',    min: -60,  max: 0,    default: -20,  fmt: v => `${v.toFixed(1)} dB` },
  { id: 'ratio',     label: 'RATIO',     min: 1,    max: 100,  default: 4,    fmt: v => `${v.toFixed(1)}:1`  },
  { id: 'attack',    label: 'ATTACK',    min: 0.01, max: 100,  default: 10,   fmt: v => `${v.toFixed(1)} ms` },
  { id: 'release',   label: 'RELEASE',   min: 10,   max: 1000, default: 100,  fmt: v => `${v.toFixed(0)} ms` },
  { id: 'knee',      label: 'KNEE',      min: 0,    max: 24,   default: 6,    fmt: v => `${v.toFixed(1)} dB` },
  { id: 'makeup',    label: 'MAKEUP',    min: 0,    max: 36,   default: 0,    fmt: v => `${v.toFixed(1)} dB` },
  { id: 'mix',       label: 'MIX',       min: 0,    max: 100,  default: 100,  fmt: v => `${v.toFixed(0)} %`  },
  { id: 'lookahead', label: 'LOOKAHEAD', min: 0,    max: 10,   default: 0,    fmt: v => `${v.toFixed(1)} ms` },
]
const LEGACY_DEFAULTS = Object.fromEntries(LEGACY_KNOBS.map(k => [k.id, k.default]))

function LegacyCompressorBody({ target }) {
  const [params, setParams]       = useState(LEGACY_DEFAULTS)
  const [detectMode, setDetMode]  = useState(0)
  const grBarRef    = useRef(null)
  const grLabelRef  = useRef(null)
  const rafRef      = useRef(null)
  const lastPollRef = useRef(0)

  useEffect(() => {
    if (!target) return
    setParams(LEGACY_DEFAULTS)
    setDetMode(0)
    ;(async () => {
      try {
        const raw  = await window.xleth?.audio?.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...LEGACY_DEFAULTS }
        for (const p of list) {
          if (p.id in next)          next[p.id] = p.value
          if (p.id === 'detect_mode') setDetMode(Math.round(p.value))
        }
        setParams(next)
      } catch {}
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
            const grDb = Math.max(0, meters[2] ?? 0)
            const pct  = Math.min(grDb / 40 * 100, 100)
            if (grBarRef.current)   grBarRef.current.style.height  = pct + '%'
            if (grLabelRef.current) grLabelRef.current.textContent = grDb.toFixed(1)
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

  const setDetect = useCallback((mode) => {
    if (!target) return
    setDetMode(mode)
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, 'detect_mode', mode)
  }, [target])

  return (
    <>
      <div className="compressor-panel-body">
        <div className="compressor-knob-grid">
          {LEGACY_KNOBS.map(k => (
            <div key={k.id} className="compressor-knob-cell">
              <Knob value={params[k.id]} min={k.min} max={k.max} defaultValue={k.default}
                label={k.label} formatValue={k.fmt}
                onLiveChange={v => setParam(k.id, v)} onCommit={v => setParam(k.id, v)}
                size={52} dragRange={150} />
            </div>
          ))}
        </div>
        <div className="compressor-gr-meter">
          <div className="compressor-gr-track"><div className="compressor-gr-bar" ref={grBarRef} /></div>
          <div className="compressor-gr-label">GR <span ref={grLabelRef}>0.0</span> dB</div>
        </div>
      </div>
      <div className="compressor-detect-row">
        <span className="compressor-detect-label">Detect:</span>
        <button className={`compressor-detect-btn${detectMode === 0 ? ' active' : ''}`} onClick={() => setDetect(0)}>Peak</button>
        <button className={`compressor-detect-btn${detectMode === 1 ? ' active' : ''}`} onClick={() => setDetect(1)}>RMS</button>
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
    console.error('[CompressorPanel] Runtime renderer failed, falling back to legacy body:', err, info?.componentStack)
  }
  render() {
    if (this.state.hasError) {
      return <LegacyCompressorBody target={this.props.target} />
    }
    return this.props.children
  }
}

// Designer column boundary — a Designer crash must not unmount the Compressor
// runtime. The boundary shows a tiny inline error and otherwise stays out of
// the way.
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

// DesignerPreview wraps the runtime renderer with the selection overlay. A
// crash in the overlay or wrapper must not take down the runtime — fall back
// to a bare StockPluginRuntimeRenderer so the Compressor body keeps working
// even with the Designer column open.
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
      return <StockPluginRuntimeRenderer pluginId="compressor" target={target} onClose={onClose} />
    }
    return this.props.children
  }
}

// ── Panel chrome ──────────────────────────────────────────────────────────────

export default function CompressorPanel() {
  const target = useCompressorStore(s => s.target)
  const close  = useCompressorStore(s => s.close)

  const [designerOpen, setDesignerOpen] = useState(false)
  const designerCloseGuardRef = useRef(null)

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

  const panelCls = `compressor-panel${DESIGNER_ENABLED && designerOpen ? ' compressor-panel--designer-open' : ''}`

  return (
    <div className={panelCls} style={{ left: panelPos.x, top: panelPos.y }}>
      <div className="compressor-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="compressor-panel-title">Compressor</span>
        {DESIGNER_ENABLED && (
          <button
            className={`compressor-panel-edit-ui${designerOpen ? ' compressor-panel-edit-ui--active' : ''}`}
            onClick={handleEditUiClick}
            title={designerOpen ? 'Close Designer' : 'Edit UI'}
            aria-pressed={designerOpen}
          >
            Edit UI
          </button>
        )}
        <button className="compressor-panel-close" onClick={handlePanelClose} title="Close">
          <X size={12} />
        </button>
      </div>

      <div className="compressor-panel-split">
        <div className="compressor-panel-runtime-pane">
          <RuntimeBodyBoundary target={target}>
            {DESIGNER_ENABLED && designerOpen && DesignerPreview ? (
              <DesignerPreviewBoundary target={target} onClose={close}>
                <Suspense fallback={<div className="pluginui-designer-loading">Loading preview…</div>}>
                  <DesignerPreview pluginId="compressor" target={target} onClose={close} />
                </Suspense>
              </DesignerPreviewBoundary>
            ) : (
              <StockPluginRuntimeRenderer pluginId="compressor" target={target} onClose={close} />
            )}
          </RuntimeBodyBoundary>
        </div>

        {DESIGNER_ENABLED && designerOpen && PluginUIDesigner && (
          <DesignerColumnBoundary>
            <Suspense fallback={<div className="pluginui-designer-root"><div className="pluginui-designer-loading">Loading Designer…</div></div>}>
              <PluginUIDesigner
                pluginId="compressor"
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
