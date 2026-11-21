// Lead-in tails on the Snapshots cue lane (docs/XLETH_LANDING_SPEC.md §8).
//
// For every cue that has landings: one thin bar per landing, from where that
// landing starts to the cue pin, stacked in up to four rows, with "+N" when the
// cue has more. Drawn on ONE canvas that sits under the transition band, its
// grips and the pins, and never takes the pointer: CueLane hit-tests the tail
// ends itself, so a tail can never steal a grip's or a pin's hit area.
//
// A drag does not go through React. CueLane calls setDraft() on each pointer
// move and this repaints the canvas directly; the one setCueLandings write
// happens on release, in CueLane.
import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { beatToPlayheadPixel, ticksToBeats } from '../../constants/timeline.js'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import {
  LANDING_TAIL_HEIGHT, landingStartTick, landingTailRowY,
} from './cueLandings.js'
import styles from './CueLandings.module.css'

// The lane's own tick -> x (the mapping the pins and the playhead use).
export function tailTickToPixel(tick, scrollOffset, pixelsPerBeat) {
  return beatToPlayheadPixel(ticksToBeats(tick), scrollOffset, pixelsPerBeat, 1)
}

// Pure paint, exported for tests: `items` is
//   [{ cueTick, floorTick, selected, tails: [{ trackId, row, startTick, leadInTicks, pinTick }], overflow }]
// and `draft` ({ cueTick, trackId, leadInTicks } or null) overrides one tail's
// lead-in while it is being dragged.
export function paintLandingTails(ctx, {
  items, draft, width, height, scrollOffset, pixelsPerBeat, ink, font,
}) {
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = ink
  for (const item of items) {
    const pinX = tailTickToPixel(item.cueTick, scrollOffset, pixelsPerBeat)
    if (pinX < 0) continue
    for (const tail of item.tails) {
      const dragged = draft && draft.cueTick === item.cueTick && draft.trackId === tail.trackId
      const startTick = dragged
        ? landingStartTick(item.cueTick, draft.leadInTicks, item.floorTick)
        : tail.startTick
      const startX = tailTickToPixel(startTick, scrollOffset, pixelsPerBeat)
      if (startX > width) continue
      const y = landingTailRowY(tail.row)
      const left = Math.round(startX)
      const barWidth = Math.max(1, Math.round(pinX) - left)
      // The bar, then its left end at full strength: the end is the grip.
      ctx.globalAlpha = item.selected ? 0.7 : 0.38
      ctx.fillRect(left, y, barWidth, LANDING_TAIL_HEIGHT)
      ctx.globalAlpha = item.selected ? 1 : 0.6
      ctx.fillRect(left, y, Math.min(3, barWidth), LANDING_TAIL_HEIGHT)
    }
    if (item.overflow > 0) {
      ctx.globalAlpha = item.selected ? 1 : 0.7
      ctx.font = font
      ctx.textAlign = 'right'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(`+${item.overflow}`, Math.round(pinX) - 6, 9)
    }
  }
  ctx.globalAlpha = 1
}

const LandingTails = forwardRef(function LandingTails({
  items, width, height, pixelsPerBeatRef, scrollOffsetRef,
}, ref) {
  const canvasRef = useRef(null)
  const draftRef = useRef(null)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const epoch = useThemeEpoch()

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0 || height <= 0) return
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
    const pxWidth = Math.max(1, Math.round(width * dpr))
    const pxHeight = Math.max(1, Math.round(height * dpr))
    if (canvas.width !== pxWidth) canvas.width = pxWidth
    if (canvas.height !== pxHeight) canvas.height = pxHeight
    // jsdom has no 2D context; a real browser always does.
    let ctx = null
    try { ctx = canvas.getContext('2d') } catch (_) { ctx = null }
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    paintLandingTails(ctx, {
      items: itemsRef.current,
      draft: draftRef.current,
      width,
      height,
      scrollOffset: scrollOffsetRef.current,
      pixelsPerBeat: pixelsPerBeatRef.current,
      // Read at paint time, so a theme change or a first paint before the
      // theme effect cannot leave a stale or empty colour behind.
      ink: tokenValue('--ui-ink') || '#e6e6e6',
      font: `10px ${tokenValue('--ui-font') || 'sans-serif'}`,
    })
  }, [width, height, pixelsPerBeatRef, scrollOffsetRef])

  // Every render: the lane re-renders when the view scrolls or zooms, when a
  // cue changes and when the selection moves, and each of those moves a tail.
  useLayoutEffect(() => { draw() })
  useLayoutEffect(() => { draw() }, [epoch, draw])

  useImperativeHandle(ref, () => ({
    setDraft: (draft) => { draftRef.current = draft; draw() },
  }), [draw])

  return (
    <canvas
      ref={canvasRef}
      className={`vmt-landing-tails ${styles.tails}`}
      style={{ width, height }}
      aria-hidden="true"
    />
  )
})

export default LandingTails
