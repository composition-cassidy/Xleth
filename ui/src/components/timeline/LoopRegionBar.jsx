import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
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

const EDGE_PX = 6 // grab width of each edge handle

// Vegas keeps the region indicator to a short strip pinned along the top of
// the ruler — the rest of the ruler's height (numbers, tick area) stays free
// for normal click-to-seek and wheel-zoom, even directly above/below the
// loop range. Only this strip's height is a drag/resize hit target.
const BAR_HEIGHT = 7

// The bar lives in the ruler above a CANVAS that the view animator redraws
// every frame, but it is a DOM element — so its own placement has to be pushed
// per frame too, from the same refs the canvas draws with (applyView(), called
// by TimelineView's commitViewportRedraw). Positioning it from the settled
// pixelsPerBeat/scrollOffset state, which only syncs ~100ms after a gesture
// stops, left the bar pinned to the viewport while the ruler scrolled beneath
// it and then snapping into place at the end.
const LoopRegionBar = forwardRef(function LoopRegionBar({
  pixelsPerBeatRef, scrollOffsetRef, snapGranularity, rulerHeight,
}, ref) {
  const committed = useLoopRegionStore((s) => s.loopRegion)
  const fetchLoopRegion = useLoopRegionStore((s) => s.fetchLoopRegion)

  // Live drag preview { startTick, endTick } or null when idle.
  const [preview, setPreview] = useState(null)
  const dragRef = useRef(null) // { mode, startMouseX, origStart, origEnd }
  const rootRef = useRef(null)

  const view = preview
    ? { ...committed, startTick: preview.startTick, endTick: preview.endTick }
    : committed

  // Latest range for applyView — an animator frame must place the bar where
  // the CURRENT (possibly drag-previewed) range says, without a re-render.
  const viewRef = useRef(view)
  viewRef.current = view

  const applyView = () => {
    const el = rootRef.current
    if (!el) return
    const ppb = pixelsPerBeatRef?.current || 0
    const scroll = scrollOffsetRef?.current || 0
    const { startTick, endTick } = viewRef.current
    const startPx = (startTick / PPQ - scroll) * ppb
    const endPx = (endTick / PPQ - scroll) * ppb
    el.style.transform = `translateX(${startPx}px)`
    el.style.width = `${Math.max(2, endPx - startPx)}px`
  }

  useImperativeHandle(ref, () => ({ applyView }))
  // Also after every render: a drag preview, a committed change, or an
  // arm/disarm all move the bar without the animator ticking.
  useLayoutEffect(applyView)

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
      const deltaBeats = (moveE.clientX - drag.startMouseX) / (pixelsPerBeatRef?.current || 1)
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
      const deltaBeats = (upE.clientX - drag.startMouseX) / (pixelsPerBeatRef?.current || 1)
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
  }, [committed, pixelsPerBeatRef, snapGranularity, minLenTicksFor, fetchLoopRegion])

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
      ref={rootRef}
      className={className}
      style={{
        // transform/width are written by applyView() — per animator frame.
        height: `${BAR_HEIGHT}px`,
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
      />
      <div
        className="loop-region-bar__edge loop-region-bar__edge--right"
        style={{ width: `${EDGE_PX}px` }}
        onMouseDown={(e) => beginDrag('right', e)}
        title="Drag to set loop end"
      />
      <button
        type="button"
        className="loop-region-bar__toggle"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={toggleEnabled}
        title={active ? 'Loop armed — click to disarm' : 'Loop disarmed — click to arm'}
      >
        <Repeat size={9} />
      </button>
    </div>
  )
})

export default LoopRegionBar
