import React, { useLayoutEffect, useRef, useState, useEffect } from 'react'
import { usePluginUIDesignerStore } from './usePluginUIDesignerStore.js'
import { findNode, getParentInfo } from './layoutMutations.js'
import { dragFrame, resizeFrame, isFrameLocked } from './freeformGeometry.js'
import { setFrameLive, commitFrameGesture } from './designerActions.js'

// 8 resize handle identifiers and their CSS cursor values.
const HANDLES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']
const HANDLE_CURSOR = {
  nw: 'nwse-resize', n: 'ns-resize',   ne: 'nesw-resize',
  w:  'ew-resize',                      e: 'ew-resize',
  sw: 'nesw-resize', s: 'ns-resize',   se: 'nwse-resize',
}

// Renders only when the selected node is a freeform child (has props.frame).
// Delegates snap opts + lock state reading from the Zustand store.
export default function SelectionOverlay({ hostRef }) {
  const workingLayout    = usePluginUIDesignerStore(s => s.workingLayout)
  const selectedNodeId   = usePluginUIDesignerStore(s => s.selectedNodeId)
  const pushUndoSnapshot = usePluginUIDesignerStore(s => s.pushUndoSnapshot)

  const selectedNode = selectedNodeId ? findNode(workingLayout, selectedNodeId) : null
  const frame = selectedNode?.props?.frame

  if (!frame) return null   // not a freeform child — parent renders SelectionOutline instead

  const parentInfo   = getParentInfo(workingLayout, selectedNodeId)
  const snap         = parentInfo?.parent?.props?.snap ?? {}
  const snapOpts     = { snapEnabled: snap.enabled !== false, gridPx: snap.gridPx ?? 8 }
  const locked       = isFrameLocked(frame)

  return (
    <SelectionOverlayInner
      hostRef={hostRef}
      selectedNodeId={selectedNodeId}
      frame={frame}
      snapOpts={snapOpts}
      locked={locked}
      workingLayout={workingLayout}
      pushUndoSnapshot={pushUndoSnapshot}
    />
  )
}

// ── Inner component ────────────────────────────────────────────────────────────
// Separated so that hostRef identity doesn't force a full re-render of the
// outer shell on every layout change.

function SelectionOverlayInner({
  hostRef,
  selectedNodeId,
  frame,
  snapOpts,
  locked,
  workingLayout,
  pushUndoSnapshot,
}) {
  const [rect, setRect] = useState(null)
  // gesture is stored in a ref so pointermove never triggers React renders.
  const gestureRef = useRef(null)

  // ── Recompute overlay position from the runtime DOM ──────────────────────────
  useLayoutEffect(() => {
    if (!selectedNodeId || !hostRef?.current) {
      setRect(null)
      return
    }

    const host     = hostRef.current
    const selector = `[data-pluginui-id="${cssEscape(selectedNodeId)}"]`

    function recompute() {
      if (!hostRef.current) return
      const el = host.querySelector(selector)
      if (!el) { setRect(null); return }
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
    const raf = requestAnimationFrame(recompute)
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(recompute) : null
    if (ro) ro.observe(host)
    window.addEventListener('resize', recompute)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', recompute)
      if (ro) ro.disconnect()
    }
  }, [selectedNodeId, workingLayout, hostRef])

  // ── Window-level pointermove / pointerup during an active gesture ─────────────
  // Added once at mount; reads from gestureRef so no closure-staleness issues.
  useEffect(() => {
    function handleMove(e) {
      const g = gestureRef.current
      if (!g) return

      const dx = e.clientX - g.startX
      const dy = e.clientY - g.startY
      const bypassSnap = e.altKey

      let newFrame
      if (g.type === 'drag') {
        const constrainAxis = e.shiftKey
          ? (Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical')
          : null
        newFrame = dragFrame(g.originalFrame, dx, dy, {
          ...g.snapOpts,
          bypassSnap,
          constrainAxis,
        })
      } else {
        newFrame = resizeFrame(g.originalFrame, g.handle, dx, dy, {
          ...g.snapOpts,
          bypassSnap,
          preserveAspect: e.shiftKey && g.handle.length === 2,
        })
      }

      setFrameLive(g.nodeId, newFrame)
    }

    function handleEnd() {
      const g = gestureRef.current
      gestureRef.current = null
      if (g) commitFrameGesture()
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup',   handleEnd)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup',   handleEnd)
    }
  }, [])

  if (!rect) return null

  // ── Pointer-down handlers ─────────────────────────────────────────────────────

  function startGesture(type, handle, e) {
    e.stopPropagation()
    gestureRef.current = {
      type,
      handle:        handle ?? null,
      originalFrame: { ...frame },
      startX:        e.clientX,
      startY:        e.clientY,
      snapOpts:      { ...snapOpts },
      nodeId:        selectedNodeId,
    }
    pushUndoSnapshot(type === 'drag' ? 'drag frame' : 'resize frame')
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const overlayClass = [
    'pluginui-designer-selection-overlay',
    locked && 'pluginui-designer-selection-overlay--locked',
  ].filter(Boolean).join(' ')

  return (
    <div
      className={overlayClass}
      style={{
        left:   `${rect.left}px`,
        top:    `${rect.top}px`,
        width:  `${rect.width}px`,
        height: `${rect.height}px`,
      }}
      aria-hidden="true"
    >
      {/* Drag body — covers the full overlay; behind handles by z-index */}
      <div
        className="pluginui-designer-selection-body"
        style={{ cursor: locked ? 'default' : 'move' }}
        onPointerDown={locked ? undefined : (e) => startGesture('drag', null, e)}
      />

      {/* Frame info badge */}
      <div className="pluginui-designer-selection-badge">
        {frame.x},{frame.y} {frame.widthPx}×{frame.heightPx}
      </div>

      {/* 8 resize handles — omitted when locked */}
      {!locked && HANDLES.map(handleId => (
        <div
          key={handleId}
          className={`pluginui-designer-selection-handle pluginui-designer-selection-handle--${handleId}`}
          style={{ cursor: HANDLE_CURSOR[handleId] }}
          onPointerDown={(e) => startGesture('resize', handleId, e)}
        />
      ))}
    </div>
  )
}

// ── Tiny CSS.escape polyfill ──────────────────────────────────────────────────

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`)
}
