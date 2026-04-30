import React, { useState, useEffect, useRef, useCallback, Component, Suspense, lazy } from 'react'
import { X } from 'lucide-react'
import useLimiterStore from '../../stores/limiterStore.js'
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
  { id: 'gain',    label: 'GAIN',    min: 0,    max: 36,   default: 0,    fmt: v => `${v.toFixed(1)} dB`, size: 60 },
  { id: 'ceiling', label: 'CEILING', min: -12,  max: 0,    default: -0.3, fmt: v => `${v.toFixed(1)} dB`, size: 52 },
  { id: 'release', label: 'RELEASE', min: 10,   max: 1000, default: 100,  fmt: v => `${v.toFixed(0)} ms`, size: 52 },
]
const LEGACY_DEFAULTS = { gain: 0, ceiling: -0.3, release: 100, style: 0 }
const STYLE_LABELS = ['Transparent', 'Punchy', 'Aggressive']

function LegacyLimiterBody({ target }) {
  const [params, setParams] = useState(LEGACY_DEFAULTS)

  const grBarRef    = useRef(null)
  const grLabelRef  = useRef(null)
  const momLufsRef  = useRef(null)
  const stLufsRef   = useRef(null)
  const rafRef      = useRef(null)
  const lastPollRef = useRef(0)

  useEffect(() => {
    if (!target) return
    setParams(LEGACY_DEFAULTS)
    ;(async () => {
      try {
        const raw  = await window.xleth?.audio?.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...LEGACY_DEFAULTS }
        for (const p of list) {
          if (p.id in next) next[p.id] = p.value
        }
        setParams(next)
      } catch (e) {
        console.warn('[LimiterPanel] hydrate failed:', e?.message)
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
            const grDb  = Math.max(0, meters[2] ?? 0)
            const grPct = Math.min(grDb / 40 * 100, 100)
            if (grBarRef.current)   grBarRef.current.style.height  = grPct + '%'
            if (grLabelRef.current) grLabelRef.current.textContent = grDb.toFixed(1)

            const momLufs = meters[3] ?? -70
            const stLufs  = meters[4] ?? -70
            if (momLufsRef.current) momLufsRef.current.textContent = momLufs.toFixed(1)
            if (stLufsRef.current)  stLufsRef.current.textContent  = stLufs.toFixed(1)
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

  const setStyle = useCallback((idx) => {
    if (!target) return
    setParams(prev => ({ ...prev, style: idx }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, 'style', idx)
  }, [target])

  const currentStyle = Math.round(params.style ?? 0)

  return (
    <>
      <div className="limiter-panel-body">
        <div className="limiter-panel-controls">
          <div className="limiter-knob-row">
            {LEGACY_KNOBS.map(k => (
              <div key={k.id} className="limiter-knob-cell">
                <Knob
                  value={params[k.id]} min={k.min} max={k.max} defaultValue={k.default}
                  label={k.label} formatValue={k.fmt}
                  onLiveChange={v => setParam(k.id, v)} onCommit={v => setParam(k.id, v)}
                  size={k.size} dragRange={150}
                />
              </div>
            ))}
          </div>
          <div className="limiter-style-row">
            <span className="limiter-style-label">Style:</span>
            {STYLE_LABELS.map((label, idx) => (
              <button
                key={idx}
                className={`limiter-style-btn${currentStyle === idx ? ' active' : ''}`}
                onClick={() => setStyle(idx)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="limiter-gr-meter">
          <div className="limiter-gr-track"><div className="limiter-gr-bar" ref={grBarRef} /></div>
          <div className="limiter-gr-label">GR <span ref={grLabelRef}>0.0</span> dB</div>
        </div>
      </div>
      <div className="limiter-lufs-row">
        <span className="limiter-lufs-label">M:</span>
        <span className="limiter-lufs-value" ref={momLufsRef}>—</span>
        <span className="limiter-lufs-unit">LUFS</span>
        <span className="limiter-lufs-sep" />
        <span className="limiter-lufs-label">S:</span>
        <span className="limiter-lufs-value" ref={stLufsRef}>—</span>
        <span className="limiter-lufs-unit">LUFS</span>
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
    console.error('[LimiterPanel] Runtime renderer failed, falling back to legacy body:', err, info?.componentStack)
  }
  render() {
    if (this.state.hasError) {
      return <LegacyLimiterBody target={this.props.target} />
    }
    return this.props.children
  }
}

// Designer column boundary — a Designer crash must not unmount the Limiter
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
// to a bare StockPluginRuntimeRenderer so the Limiter body keeps working
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
      return <StockPluginRuntimeRenderer pluginId="limiter" target={target} onClose={onClose} />
    }
    return this.props.children
  }
}

// ── Panel chrome ──────────────────────────────────────────────────────────────

export default function LimiterPanel() {
  const target = useLimiterStore(s => s.target)
  const close  = useLimiterStore(s => s.close)

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

  const panelCls = `limiter-panel${DESIGNER_ENABLED && designerOpen ? ' limiter-panel--designer-open' : ''}`

  return (
    <div className={panelCls} style={{ left: panelPos.x, top: panelPos.y }}>
      <div className="limiter-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="limiter-panel-title">Limiter</span>
        {DESIGNER_ENABLED && (
          <button
            className={`limiter-panel-edit-ui${designerOpen ? ' limiter-panel-edit-ui--active' : ''}`}
            onClick={handleEditUiClick}
            title={designerOpen ? 'Close Designer' : 'Edit UI'}
            aria-pressed={designerOpen}
          >
            Edit UI
          </button>
        )}
        <button className="limiter-panel-close" onClick={handlePanelClose} title="Close">
          <X size={12} />
        </button>
      </div>

      <div className="limiter-panel-split">
        <div className="limiter-panel-runtime-pane">
          <RuntimeBodyBoundary target={target}>
            {DESIGNER_ENABLED && designerOpen && DesignerPreview ? (
              <DesignerPreviewBoundary target={target} onClose={close}>
                <Suspense fallback={<div className="pluginui-designer-loading">Loading preview…</div>}>
                  <DesignerPreview pluginId="limiter" target={target} onClose={close} />
                </Suspense>
              </DesignerPreviewBoundary>
            ) : (
              <StockPluginRuntimeRenderer pluginId="limiter" target={target} onClose={close} />
            )}
          </RuntimeBodyBoundary>
        </div>

        {DESIGNER_ENABLED && designerOpen && PluginUIDesigner && (
          <DesignerColumnBoundary>
            <Suspense fallback={<div className="pluginui-designer-root"><div className="pluginui-designer-loading">Loading Designer…</div></div>}>
              <PluginUIDesigner
                pluginId="limiter"
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
