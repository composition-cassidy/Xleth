import React, { useState, useEffect, useRef, useCallback, Component, Suspense, lazy } from 'react'
import { X } from 'lucide-react'
import useOverdoneStore from '../../stores/overdoneStore.js'
import Knob from '../sampler/Knob.jsx'
import StockPluginRuntimeRenderer from '../../plugin-ui/runtime/StockPluginRuntimeRenderer.jsx'
import { DESIGNER_ENABLED } from '../../plugin-ui/designer/featureFlag.js'

// Lazy: only pulled into the bundle when DESIGNER_ENABLED gates the import-time
// access at the call site.
const PluginUIDesigner = DESIGNER_ENABLED
  ? lazy(() => import('../../plugin-ui/designer/PluginUIDesigner.jsx'))
  : null
const DesignerPreview = DESIGNER_ENABLED
  ? lazy(() => import('../../plugin-ui/designer/DesignerPreview.jsx'))
  : null

const PLUGIN_ID = 'overdone'

// ── Legacy body ───────────────────────────────────────────────────────────────
// Rendered only when the runtime renderer throws an unrecoverable error.
// Kept intentionally — delete once the runtime path has proven stable across releases.

const LEGACY_KNOBS = [
  { id: 'depth',      label: 'DEPTH',    min: 0,     max: 100,  default: 70,   fmt: v => `${v.toFixed(0)} %`,  size: 64 },
  { id: 'time',       label: 'TIME',     min: 0,     max: 100,  default: 50,   fmt: v => `${v.toFixed(0)} %` },
  { id: 'gain_low',   label: 'LOW',      min: -12,   max: 12,   default: 0,    fmt: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB` },
  { id: 'gain_mid',   label: 'MID',      min: -12,   max: 12,   default: 0,    fmt: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB` },
  { id: 'gain_high',  label: 'HIGH',     min: -12,   max: 12,   default: 0,    fmt: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB` },
  { id: 'xover_low',  label: 'LO XOVER', min: 40,    max: 400,  default: 88,   fmt: v => `${v.toFixed(0)} Hz` },
  { id: 'xover_high', label: 'HI XOVER', min: 1000,  max: 8000, default: 2500, fmt: v => v >= 1000 ? `${(v / 1000).toFixed(1)}k Hz` : `${v.toFixed(0)} Hz` },
]
const LEGACY_DEFAULTS = Object.fromEntries(LEGACY_KNOBS.map(k => [k.id, k.default]))

function LegacyOverdoneBody({ target }) {
  const [params, setParams] = useState(LEGACY_DEFAULTS)

  const grLowBarRef    = useRef(null)
  const grMidBarRef    = useRef(null)
  const grHighBarRef   = useRef(null)
  const grLowLabelRef  = useRef(null)
  const grMidLabelRef  = useRef(null)
  const grHighLabelRef = useRef(null)
  const rafRef         = useRef(null)
  const lastPollRef    = useRef(0)

  useEffect(() => {
    if (!target) return
    setParams(LEGACY_DEFAULTS)
    ;(async () => {
      try {
        const raw = await window.xleth?.audio?.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...LEGACY_DEFAULTS }
        for (const p of list) {
          if (p.id in next) next[p.id] = p.value
        }
        setParams(next)
      } catch (e) {
        console.warn('[OTTPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

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
    return () => { active = false; cancelAnimationFrame(rafRef.current) }
  }, [target])

  const setParam = useCallback((id, value) => {
    if (!target) return
    setParams(prev => ({ ...prev, [id]: value }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, id, value)
  }, [target])

  return (
    <div className="ott-panel-body">
      <div className="ott-knob-grid">
        <div className="ott-knob-row ott-knob-row--main">
          {LEGACY_KNOBS.slice(0, 2).map(k => (
            <div key={k.id} className="ott-knob-cell">
              <Knob
                value={params[k.id]} min={k.min} max={k.max} defaultValue={k.default}
                label={k.label} formatValue={k.fmt}
                onLiveChange={v => setParam(k.id, v)} onCommit={v => setParam(k.id, v)}
                size={k.size || 52} dragRange={150}
              />
            </div>
          ))}
        </div>
        <div className="ott-knob-row ott-knob-row--gains">
          {LEGACY_KNOBS.slice(2, 5).map(k => (
            <div key={k.id} className="ott-knob-cell">
              <Knob
                value={params[k.id]} min={k.min} max={k.max} defaultValue={k.default}
                label={k.label} formatValue={k.fmt}
                onLiveChange={v => setParam(k.id, v)} onCommit={v => setParam(k.id, v)}
                size={52} dragRange={150}
              />
            </div>
          ))}
        </div>
        <div className="ott-knob-row ott-knob-row--xover">
          {LEGACY_KNOBS.slice(5, 7).map(k => (
            <div key={k.id} className="ott-knob-cell">
              <Knob
                value={params[k.id]} min={k.min} max={k.max} defaultValue={k.default}
                label={k.label} formatValue={k.fmt}
                onLiveChange={v => setParam(k.id, v)} onCommit={v => setParam(k.id, v)}
                size={48} dragRange={150}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="ott-gr-meters">
        <div className="ott-gr-band">
          <div className="ott-gr-track"><div className="ott-gr-bar ott-gr-bar--low" ref={grLowBarRef} /></div>
          <div className="ott-gr-label">L <span ref={grLowLabelRef}>0.0</span></div>
        </div>
        <div className="ott-gr-band">
          <div className="ott-gr-track"><div className="ott-gr-bar ott-gr-bar--mid" ref={grMidBarRef} /></div>
          <div className="ott-gr-label">M <span ref={grMidLabelRef}>0.0</span></div>
        </div>
        <div className="ott-gr-band">
          <div className="ott-gr-track"><div className="ott-gr-bar ott-gr-bar--high" ref={grHighBarRef} /></div>
          <div className="ott-gr-label">H <span ref={grHighLabelRef}>0.0</span></div>
        </div>
      </div>
    </div>
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
    console.error('[OTTPanel] Runtime renderer failed, falling back to legacy body:', err, info?.componentStack)
  }
  render() {
    if (this.state.hasError) {
      return <LegacyOverdoneBody target={this.props.target} />
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

export default function OTTPanel() {
  const target = useOverdoneStore(s => s.target)
  const close  = useOverdoneStore(s => s.close)

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

  const panelCls = `ott-panel${DESIGNER_ENABLED && designerOpen ? ' ott-panel--designer-open' : ''}`

  return (
    <div className={panelCls} style={{ left: panelPos.x, top: panelPos.y }}>
      <div className="ott-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="ott-panel-title">Overdone</span>
        {DESIGNER_ENABLED && (
          <button
            className={`ott-panel-edit-ui${designerOpen ? ' ott-panel-edit-ui--active' : ''}`}
            onClick={handleEditUiClick}
            title={designerOpen ? 'Close Designer' : 'Edit UI'}
            aria-pressed={designerOpen}
          >
            Edit UI
          </button>
        )}
        <button className="ott-panel-close" onClick={handlePanelClose} title="Close">
          <X size={12} />
        </button>
      </div>

      <div className="ott-panel-split">
        <div className="ott-panel-runtime-pane">
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
