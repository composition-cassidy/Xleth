import React, { useState, useEffect, useRef, useCallback, Component, Suspense, lazy } from 'react'
import { X } from 'lucide-react'
import useDistortionStore from '../../stores/distortionStore.js'
import Knob from '../sampler/Knob.jsx'
import StockPluginRuntimeRenderer from '../../plugin-ui/runtime/StockPluginRuntimeRenderer.jsx'
import { DESIGNER_ENABLED } from '../../plugin-ui/designer/featureFlag.js'

const PluginUIDesigner = DESIGNER_ENABLED
  ? lazy(() => import('../../plugin-ui/designer/PluginUIDesigner.jsx'))
  : null
const DesignerPreview = DESIGNER_ENABLED
  ? lazy(() => import('../../plugin-ui/designer/DesignerPreview.jsx'))
  : null

const PLUGIN_ID = 'distortion'

const LEGACY_KNOBS = [
  { id: 'drive', label: 'DRIVE', min: 0,  max: 48,    default: 12,   fmt: v => `${v.toFixed(1)} dB`, size: 64 },
  { id: 'tone',  label: 'TONE',  min: 20, max: 20000, default: 8000, fmt: v => `${v.toFixed(0)} Hz`, size: 52 },
  { id: 'mix',   label: 'MIX',   min: 0,  max: 100,   default: 100,  fmt: v => `${v.toFixed(0)} %`,  size: 52 },
]

const MODES = [
  { value: 0, label: 'Tube' },
  { value: 1, label: 'Soft Clip' },
  { value: 2, label: 'Hard Clip' },
  { value: 3, label: 'Analog' },
]

const LEGACY_DEFAULTS = Object.fromEntries(LEGACY_KNOBS.map(k => [k.id, k.default]))

function LegacyDistortionBody({ target }) {
  const [params, setParams] = useState(LEGACY_DEFAULTS)
  const [mode, setModeState] = useState(0)
  const [filterPos, setFilterPos] = useState(1)

  useEffect(() => {
    if (!target) return
    setParams(LEGACY_DEFAULTS)
    setModeState(0)
    setFilterPos(1)
    ;(async () => {
      try {
        const raw = await window.xleth?.audio?.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        const next = { ...LEGACY_DEFAULTS }
        for (const p of list) {
          if (p.id === 'drive' || p.id === 'tone' || p.id === 'mix') next[p.id] = p.value
          if (p.id === 'mode') setModeState(Math.round(p.value))
          if (p.id === 'filter_pos') setFilterPos(Math.round(p.value))
        }
        setParams(next)
      } catch (e) {
        console.warn('[DistortionPanel] hydrate failed:', e?.message)
      }
    })()
  }, [target])

  const setParam = useCallback((id, value) => {
    if (!target) return
    setParams(prev => ({ ...prev, [id]: value }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, id, value)
  }, [target])

  const setMode = useCallback((value) => {
    if (!target) return
    setModeState(value)
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, 'mode', value)
  }, [target])

  const setFilter = useCallback((value) => {
    if (!target) return
    setFilterPos(value)
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, 'filter_pos', value)
  }, [target])

  return (
    <>
      <div className="distortion-mode-row">
        {MODES.map(m => (
          <button
            key={m.value}
            className={`distortion-mode-btn${mode === m.value ? ' active' : ''}`}
            onClick={() => setMode(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="distortion-knob-row">
        {LEGACY_KNOBS.map(k => (
          <div key={k.id} className="distortion-knob-cell">
            <Knob
              value={params[k.id]}
              min={k.min}
              max={k.max}
              defaultValue={k.default}
              label={k.label}
              formatValue={k.fmt}
              onLiveChange={v => setParam(k.id, v)}
              onCommit={v => setParam(k.id, v)}
              size={k.size}
              dragRange={150}
            />
          </div>
        ))}
      </div>

      <div className="distortion-filter-row">
        <span className="distortion-filter-label">Filter:</span>
        <button
          className={`distortion-filter-btn${filterPos === 0 ? ' active' : ''}`}
          onClick={() => setFilter(0)}
        >
          Pre
        </button>
        <button
          className={`distortion-filter-btn${filterPos === 1 ? ' active' : ''}`}
          onClick={() => setFilter(1)}
        >
          Post
        </button>
      </div>
    </>
  )
}

class RuntimeBodyBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  componentDidCatch(err, info) {
    console.error('[DistortionPanel] Runtime renderer failed, falling back to legacy body:', err, info?.componentStack)
  }
  render() {
    if (this.state.hasError) {
      return <LegacyDistortionBody target={this.props.target} />
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

export default function DistortionPanel() {
  const target = useDistortionStore(s => s.target)
  const close = useDistortionStore(s => s.close)

  const [designerOpen, setDesignerOpen] = useState(false)
  const designerCloseGuardRef = useRef(null)

  const [panelPos, setPanelPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - 190),
    y: 100,
  }))
  const panelDragRef = useRef(null)

  const handlePanelMouseDown = useCallback((e) => {
    if (e.target.closest('button') || e.target.closest('input')) return
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

  const panelCls = `distortion-panel${DESIGNER_ENABLED && designerOpen ? ' distortion-panel--designer-open' : ''}`

  return (
    <div className={panelCls} style={{ left: panelPos.x, top: panelPos.y }}>
      <div className="distortion-panel-header" onMouseDown={handlePanelMouseDown}>
        <span className="distortion-panel-title">Distortion</span>
        {DESIGNER_ENABLED && (
          <button
            className={`distortion-panel-edit-ui${designerOpen ? ' distortion-panel-edit-ui--active' : ''}`}
            onClick={handleEditUiClick}
            title={designerOpen ? 'Close Designer' : 'Edit UI'}
            aria-pressed={designerOpen}
          >
            Edit UI
          </button>
        )}
        <button className="distortion-panel-close" onClick={handlePanelClose} title="Close">
          <X size={12} />
        </button>
      </div>

      <div className="distortion-panel-split">
        <div className="distortion-panel-runtime-pane">
          <RuntimeBodyBoundary target={target}>
            {DESIGNER_ENABLED && designerOpen && DesignerPreview ? (
              <DesignerPreviewBoundary target={target} onClose={close}>
                <Suspense fallback={<div className="pluginui-designer-loading">Loading preview...</div>}>
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
            <Suspense fallback={<div className="pluginui-designer-root"><div className="pluginui-designer-loading">Loading Designer...</div></div>}>
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
