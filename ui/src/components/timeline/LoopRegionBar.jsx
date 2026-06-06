import { useCallback, useEffect, useRef, useState } from 'react'
import { Repeat } from 'lucide-react'
import useLoopRegionStore, { loopMinLengthTicks } from '../../stores/loopRegionStore.js'
import {
  PPQ, snapBeatToGrid, beatsToTicks,
} from '../../constants/timeline.js'

// Vegas-style draggable loop/render region bar rendered in the timeline ruler.
//
// • Body drag moves the whole region (length preserved).
// • Left/right edge handles adjust startTick / endTick.
// • The loop glyph toggles loopEnabled (arm / disarm).
// • Always present. When disabled it is greyed/inert functionally but still
//   fully draggable and resizable; when enabled it is clearly active.
//
// Drag uses a LOCAL live preview (no IPC, no store writes during the gesture)
// and commits exactly ONE UndoManager mutation on mouseup via
// window.xleth.timeline.setLoopRegion. The committed region comes from the
// external loopRegionStore (useSyncExternalStore-backed). Snapping reuses the
// same snapBeatToGrid path clips use; Alt = free (off-grid) placement.
//
// Colors come from theme tokens (no hardcoded production hex). The z-index is a
// structural tier set in app.css, not a theme token.

const EDGE_PX = 7 // grab width of each edge handle

export default function LoopRegionBar({ pixelsPerBeat, scrollOffset, snapGranularity, rulerHeight }) {
  const committed = useLoopRegionStore((s) => s.loopRegion)
  const fetchLoopRegion = useLoopRegionStore((s) => s.fetchLoopRegion)

  // Live drag preview { startTick, endTick } or null when idle.
  const [preview, setPreview] = useState(null)
  const dragRef = useRef(null) // { mode, startMouseX, origStart, origEnd }

  const view = preview
    ? { ...committed, startTick: preview.startTick, endTick: preview.endTick }
    : committed

  const tickToPx = useCallback(
    (tick) => (tick / PPQ - scrollOffset) * pixelsPerBeat,
    [scrollOffset, pixelsPerBeat],
  )

  const startPx = tickToPx(view.startTick)
  const endPx = tickToPx(view.endTick)
  const widthPx = Math.max(2, endPx - startPx)

  // Min length: 1 snap unit when snapping, 1 tick when free (Alt).
  const minLenTicksFor = useCallback(
    (modifiers) => loopMinLengthTicks(snapGranularity, modifiers.alt),
    [snapGranularity],
  )

  const commit = useCallback((patch, minLengthTicks) => {
    // Single UndoManager mutation on mouseup — never during the drag.
    Promise.resolve(window.xleth?.timeline?.setLoopRegion(patch, minLengthTicks))
      .then(() => fetchLoopRegion())
      .catch((e) => console.warn('[LoopRegion] setLoopRegion failed:', e))
  }, [fetchLoopRegion])

  // ── Drag gesture (body / left / right) ─────────────────────────────────────
  const beginDrag = useCallback((mode, e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation() // keep the ruler's click-to-seek from firing underneath
    dragRef.current = {
      mode,
      startMouseX: e.clientX,
      origStart: committed.startTick,
      origEnd: committed.endTick,
    }
    setPreview({ startTick: committed.startTick, endTick: committed.endTick })

    const onMove = (moveE) => {
      const drag = dragRef.current
      if (!drag) return
      const modifiers = { alt: moveE.altKey, shift: moveE.shiftKey, ctrl: moveE.ctrlKey }
      const deltaBeats = (moveE.clientX - drag.startMouseX) / pixelsPerBeat
      const origStartBeat = drag.origStart / PPQ
      const origEndBeat = drag.origEnd / PPQ
      const minLen = minLenTicksFor(modifiers)

      let nextStart = drag.origStart
      let nextEnd = drag.origEnd

      if (drag.mode === 'body') {
        const snappedStartBeat = snapBeatToGrid(origStartBeat + deltaBeats, modifiers, snapGranularity)
        let s = Math.max(0, beatsToTicks(snappedStartBeat))
        const len = drag.origEnd - drag.origStart
        nextStart = s
        nextEnd = s + len
      } else if (drag.mode === 'left') {
        const snappedBeat = snapBeatToGrid(origStartBeat + deltaBeats, modifiers, snapGranularity)
        let s = Math.max(0, beatsToTicks(snappedBeat))
        if (s > drag.origEnd - minLen) s = drag.origEnd - minLen
        if (s < 0) s = 0
        nextStart = s
        nextEnd = drag.origEnd
      } else { // right
        const snappedBeat = snapBeatToGrid(origEndBeat + deltaBeats, modifiers, snapGranularity)
        let en = beatsToTicks(snappedBeat)
        if (en < drag.origStart + minLen) en = drag.origStart + minLen
        nextStart = drag.origStart
        nextEnd = en
      }
      setPreview({ startTick: nextStart, endTick: nextEnd })
    }

    const onUp = (upE) => {
      const drag = dragRef.current
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (!drag) { setPreview(null); return }
      const modifiers = { alt: upE.altKey, shift: upE.shiftKey, ctrl: upE.ctrlKey }
      const deltaBeats = (upE.clientX - drag.startMouseX) / pixelsPerBeat
      const origStartBeat = drag.origStart / PPQ
      const origEndBeat = drag.origEnd / PPQ
      const minLen = minLenTicksFor(modifiers)

      let nextStart = drag.origStart
      let nextEnd = drag.origEnd
      if (drag.mode === 'body') {
        const s = Math.max(0, beatsToTicks(snapBeatToGrid(origStartBeat + deltaBeats, modifiers, snapGranularity)))
        nextStart = s
        nextEnd = s + (drag.origEnd - drag.origStart)
      } else if (drag.mode === 'left') {
        let s = Math.max(0, beatsToTicks(snapBeatToGrid(origStartBeat + deltaBeats, modifiers, snapGranularity)))
        if (s > drag.origEnd - minLen) s = drag.origEnd - minLen
        if (s < 0) s = 0
        nextStart = s
      } else {
        let en = beatsToTicks(snapBeatToGrid(origEndBeat + deltaBeats, modifiers, snapGranularity))
        if (en < drag.origStart + minLen) en = drag.origStart + minLen
        nextEnd = en
      }

      // Clear the local preview only after the committed value refreshes (in
      // commit's .then) to avoid a one-frame flash back to the old position.
      const finalize = () => setPreview(null)
      Promise.resolve(window.xleth?.timeline?.setLoopRegion(
        { startTick: nextStart, endTick: nextEnd }, minLen))
        .then(() => fetchLoopRegion())
        .then(finalize)
        .catch((err) => { console.warn('[LoopRegion] setLoopRegion failed:', err); finalize() })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [committed, pixelsPerBeat, snapGranularity, minLenTicksFor, fetchLoopRegion])

  const toggleEnabled = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    commit({ loopEnabled: !committed.loopEnabled }, 1)
  }, [committed.loopEnabled, commit])

  // Refresh committed region on mount.
  useEffect(() => { fetchLoopRegion() }, [fetchLoopRegion])

  // Fully off-screen → don't render the body (handles would have no anchor).
  const active = view.loopEnabled
  const className = `loop-region-bar${active ? ' loop-region-bar--active' : ' loop-region-bar--inert'}`

  return (
    <div
      className={className}
      style={{
        transform: `translateX(${startPx}px)`,
        width: `${widthPx}px`,
        height: `${rulerHeight}px`,
      }}
    >
      <div
        className="loop-region-bar__edge loop-region-bar__edge--left"
        style={{ width: `${EDGE_PX}px` }}
        onMouseDown={(e) => beginDrag('left', e)}
        title="Drag to set loop start"
      />
      <div
        className="loop-region-bar__body"
        onMouseDown={(e) => beginDrag('body', e)}
        title="Drag to move loop region"
      >
        <button
          type="button"
          className="loop-region-bar__toggle"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={toggleEnabled}
          title={active ? 'Loop armed — click to disarm' : 'Loop disarmed — click to arm'}
        >
          <Repeat size={11} />
        </button>
      </div>
      <div
        className="loop-region-bar__edge loop-region-bar__edge--right"
        style={{ width: `${EDGE_PX}px` }}
        onMouseDown={(e) => beginDrag('right', e)}
        title="Drag to set loop end"
      />
    </div>
  )
}
