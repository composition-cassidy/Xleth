import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import StockPluginRuntimeRenderer from '../runtime/StockPluginRuntimeRenderer.jsx'
import { usePluginUIDesignerStore } from './usePluginUIDesignerStore.js'
import { findNode } from './layoutMutations.js'
import SelectionOverlay from './SelectionOverlay.jsx'
import { nudgeSelectedFrame, setPreviewHostEl } from './designerActions.js'

// Phase B+C wrapper around StockPluginRuntimeRenderer.
//   - Drives the runtime via layoutOverride (no IPC reads while Designer is open).
//   - Owns a selection-outline overlay over the rendered preview DOM.
//   - For freeform children (nodes with props.frame), renders SelectionOverlay
//     with drag / resize / nudge / snap instead of the plain SelectionOutline.
//
// CompressorPanel passes `target` and `onClose` down. Working-layout state
// comes from the Designer store, not from props — so the panel doesn't need
// to wire workingLayout through itself.
export default function DesignerPreview({ pluginId, target, onClose }) {
  const workingLayout    = usePluginUIDesignerStore(s => s.workingLayout)
  const validationResult = usePluginUIDesignerStore(s => s.validationResult)
  const selectedNodeId   = usePluginUIDesignerStore(s => s.selectedNodeId)
  const isLoading        = usePluginUIDesignerStore(s => s.isLoading)
  const loadError        = usePluginUIDesignerStore(s => s.loadError)

  const hostRef = useRef(null)
  const previewDisabled = validationResult?.ok === false

  // Register the preview host element with designerActions so DOM measurement
  // (move/convert to freeform) can read positions without storing DOM refs in state.
  useEffect(() => {
    setPreviewHostEl(hostRef.current)
    return () => setPreviewHostEl(null)
  }, [])

  // Determine if the selected node is a freeform child (has props.frame).
  const selectedNode     = selectedNodeId ? findNode(workingLayout, selectedNodeId) : null
  const hasFreeformFrame = !!selectedNode?.props?.frame

  // Arrow-key nudge when a freeform child is selected.
  useEffect(() => {
    if (!hasFreeformFrame || !selectedNodeId) return

    function handleKeyDown(e) {
      const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key]
      if (!dir) return
      e.preventDefault()
      nudgeSelectedFrame(dir, { shiftKey: e.shiftKey, altKey: e.altKey })
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hasFreeformFrame, selectedNodeId])

  if (!workingLayout && isLoading) {
    return (
      <div className="pluginui-designer-preview-host" ref={hostRef}>
        <div className="pluginui-designer-loading">Loading preview…</div>
      </div>
    )
  }

  return (
    <div className="pluginui-designer-preview-host" ref={hostRef}>
      {previewDisabled ? (
        <div className="pluginui-designer-preview-disabled" role="status">
          <div className="pluginui-designer-preview-disabled-title">Validation failed, preview disabled</div>
          <div className="pluginui-designer-preview-disabled-detail">
            Fix hard layout errors before previewing this layout.
          </div>
        </div>
      ) : (
        <>
          <StockPluginRuntimeRenderer
            pluginId={pluginId}
            target={target}
            onClose={onClose}
            layoutOverride={workingLayout}
            layoutOverrideErrors={validationResult?.errors ?? []}
          />
          {hasFreeformFrame ? (
            <SelectionOverlay hostRef={hostRef} />
          ) : (
            <SelectionOutline hostRef={hostRef} selectedNodeId={selectedNodeId} workingLayout={workingLayout} />
          )}
        </>
      )}
      {loadError && (
        <div className="pluginui-designer-preview-warning" role="status">
          {loadError}
        </div>
      )}
    </div>
  )
}

// ── Plain selection outline ────────────────────────────────────────────────────
// Used for flow-layout nodes (no props.frame). Pure overlay, no interaction.

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
