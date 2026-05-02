import React, { useState, useEffect, useRef, useCallback, Component, Suspense, lazy } from 'react'
import { X } from 'lucide-react'
import useResonanceSuppressorStore from '../../stores/resonanceSuppressorStore.js'
import StockPluginRuntimeRenderer from '../../plugin-ui/runtime/StockPluginRuntimeRenderer.jsx'
import { DESIGNER_ENABLED } from '../../plugin-ui/designer/featureFlag.js'

const PluginUIDesigner = DESIGNER_ENABLED
  ? lazy(() => import('../../plugin-ui/designer/PluginUIDesigner.jsx'))
  : null
const DesignerPreview = DESIGNER_ENABLED
  ? lazy(() => import('../../plugin-ui/designer/DesignerPreview.jsx'))
  : null

const PLUGIN_ID = 'resonancesuppressor'
const PANEL_WIDTH = 760

// ── Legacy body ───────────────────────────────────────────────────────────────
// Minimal fallback rendered only when the runtime renderer throws.

function LegacyResonanceSuppressorBody() {
  return (
    <div style={{ padding: '16px', fontSize: '11px', color: 'var(--theme-text-muted)' }}>
      Resonance Suppressor — runtime UI unavailable.
    </div>
  )
}

// ── Error boundaries ──────────────────────────────────────────────────────────

class RuntimeBodyBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  componentDidCatch(err, info) {
    console.error('[ResonanceSuppressorPanel] Runtime renderer failed, falling back to legacy body:', err, info?.componentStack)
  }
  render() {
    if (this.state.hasError) {
      return <LegacyResonanceSuppressorBody target={this.props.target} />
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

export default function ResonanceSuppressorPanel() {
  const target = useResonanceSuppressorStore(s => s.target)
  const close  = useResonanceSuppressorStore(s => s.close)

  const [designerOpen, setDesignerOpen] = useState(false)
  const designerCloseGuardRef = useRef(null)

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.max(24, Math.round(window.innerWidth / 2 - PANEL_WIDTH / 2)),
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
        x: Math.max(-800, Math.min(window.innerWidth  - 100, startPanelX + e.clientX - startMouseX)),
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

  const panelCls = `resonancesuppressor-panel${DESIGNER_ENABLED && designerOpen ? ' resonancesuppressor-panel--designer-open' : ''}`

  return (
    <div className={panelCls} style={{ left: panelPos.x, top: panelPos.y }}>
      <div className="resonancesuppressor-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="resonancesuppressor-panel-title">Resonance Suppressor</span>
        {DESIGNER_ENABLED && (
          <button
            className={`resonancesuppressor-panel-edit-ui${designerOpen ? ' resonancesuppressor-panel-edit-ui--active' : ''}`}
            onClick={handleEditUiClick}
            title={designerOpen ? 'Close Designer' : 'Edit UI'}
            aria-pressed={designerOpen}
          >
            Edit UI
          </button>
        )}
        <button className="resonancesuppressor-panel-close" onClick={handlePanelClose} title="Close">
          <X size={12} />
        </button>
      </div>

      <div className="resonancesuppressor-panel-split">
        <div className="resonancesuppressor-panel-runtime-pane">
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
