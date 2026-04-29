import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import StockPluginRuntimeRenderer from '../runtime/StockPluginRuntimeRenderer.jsx'
import { usePluginUIDesignerStore } from './usePluginUIDesignerStore.js'

// Phase B+C wrapper around StockPluginRuntimeRenderer.
//   - Drives the runtime via layoutOverride (no IPC reads while Designer is open).
//   - Owns a selection-outline overlay over the rendered preview DOM.
//
// CompressorPanel passes `target` and `onClose` down. Working-layout state
// comes from the Designer store, not from props — so the panel doesn't need
// to wire workingLayout through itself.
export default function DesignerPreview({ pluginId = 'compressor', target, onClose }) {
  const workingLayout    = usePluginUIDesignerStore(s => s.workingLayout)
  const validationResult = usePluginUIDesignerStore(s => s.validationResult)
  const selectedNodeId   = usePluginUIDesignerStore(s => s.selectedNodeId)
  const isLoading        = usePluginUIDesignerStore(s => s.isLoading)
  const loadError        = usePluginUIDesignerStore(s => s.loadError)

  const hostRef = useRef(null)

  if (!workingLayout && isLoading) {
    return (
      <div className="pluginui-designer-preview-host" ref={hostRef}>
        <div className="pluginui-designer-loading">Loading preview…</div>
      </div>
    )
  }

  return (
    <div className="pluginui-designer-preview-host" ref={hostRef}>
      <StockPluginRuntimeRenderer
        pluginId={pluginId}
        target={target}
        onClose={onClose}
        layoutOverride={workingLayout}
        layoutOverrideErrors={validationResult?.errors ?? []}
      />
      <SelectionOutline hostRef={hostRef} selectedNodeId={selectedNodeId} workingLayout={workingLayout} />
      {loadError && (
        <div className="pluginui-designer-preview-warning" role="status">
          {loadError}
        </div>
      )}
    </div>
  )
}

// ── Selection outline overlay ────────────────────────────────────────────────
//
// Looks up the DOM node tagged with data-pluginui-id matching the current
// selection, computes its bounding rect relative to the host, and renders an
// absolutely-positioned outline div. Recomputes on:
//   - selection change
//   - layout change
//   - window resize
//   - host scroll
//
// Never mutates the runtime DOM — pure overlay.

function SelectionOutline({ hostRef, selectedNodeId, workingLayout }) {
  const [rect, setRect] = useState(null)

  useLayoutEffect(() => {
    if (!selectedNodeId || !hostRef.current) {
      setRect(null)
      return
    }

    const host   = hostRef.current
    const selector = `[data-pluginui-id="${cssEscape(selectedNodeId)}"]`

    function recompute() {
      if (!hostRef.current) return
      const el = host.querySelector(selector)
      if (!el) {
        setRect(null)
        return
      }
      const hostBox = host.getBoundingClientRect()
      const elBox   = el.getBoundingClientRect()
      setRect({
        left:   elBox.left   - hostBox.left + host.scrollLeft,
        top:    elBox.top    - hostBox.top  + host.scrollTop,
        width:  elBox.width,
        height: elBox.height,
      })
    }

    recompute()

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(recompute) : null
    if (ro) ro.observe(host)

    window.addEventListener('resize', recompute)
    host.addEventListener('scroll', recompute, { passive: true })

    // RAF-based recompute on next paint to catch async preview mounts (e.g.,
    // visualizer canvas appearing late). One follow-up tick is enough.
    const raf = requestAnimationFrame(recompute)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', recompute)
      host.removeEventListener('scroll', recompute)
      if (ro) ro.disconnect()
    }
  }, [selectedNodeId, workingLayout, hostRef])

  // Recompute when the workingLayout changes mid-mount.
  useEffect(() => {
    // No-op effect; the layout-effect above already keys on workingLayout.
  }, [workingLayout])

  if (!rect) return null
  return (
    <div
      className="pluginui-designer-preview-overlay"
      style={{
        left:   `${rect.left}px`,
        top:    `${rect.top}px`,
        width:  `${rect.width}px`,
        height: `${rect.height}px`,
      }}
      aria-hidden="true"
    />
  )
}

// CSS.escape polyfill — kept tiny, only handles the characters we expect in
// node ids (letters, digits, hyphens, underscores). Falls back to the native
// implementation when present.
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`)
}
