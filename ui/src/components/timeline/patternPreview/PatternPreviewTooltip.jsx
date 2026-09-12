import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { tokenValue } from '../../../theming/tokenValue.ts'
import {
  getOrRenderPatternPreview,
  inferPatternKind,
  patternBarCount,
  PREVIEW_WIDTH,
  PREVIEW_HEIGHT,
  PREVIEW_DPR,
} from './renderPatternPreview.js'

const CARD_WIDTH_ESTIMATE = 268 // 240 canvas + padding/border, used for the pre-mount flip guess
const ANCHOR_GAP = 14 // clearance from the row so the card reads as floating over the timeline, not butted against the sidebar

/**
 * Floating hover-preview card for a Patterns-sidebar row (see
 * PatternListPanel.jsx). Self-contained: owns its own portal, viewport
 * clamping, fade/slide transition and Escape handling — the caller only
 * needs to mount/unmount it on hover-intent and re-supply `anchorRect`.
 *
 * `pattern` is the full Pattern object already resident in TimelineView's
 * `patterns` state ({ id, name, lengthTicks, notes: [...] }) — no bridge
 * call happens here.
 *
 * `anchorRect` is a plain DOMRect (or DOMRect-shaped object) for the row
 * being hovered, taken via getBoundingClientRect() by the caller.
 */
export default function PatternPreviewTooltip({ pattern, anchorRect, onRequestClose }) {
  const cardRef = useRef(null)
  const canvasRef = useRef(null)
  const [entered, setEntered] = useState(false)

  // Fade+slide-in on the next frame after mount (the CSS transition needs an
  // initial "not yet visible" frame to animate from).
  useEffect(() => {
    const frameId = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frameId)
  }, [])

  // Escape dismisses instantly — the card itself is pointer-events:none so
  // it can never receive its own mouse events.
  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === 'Escape') onRequestClose?.() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onRequestClose])

  const preFlip = anchorRect.right + ANCHOR_GAP + CARD_WIDTH_ESTIMATE > window.innerWidth
  const [flipped, setFlipped] = useState(preFlip)

  const initialTop = anchorRect.top
  const initialLeft = preFlip
    ? Math.max(4, anchorRect.left - ANCHOR_GAP - CARD_WIDTH_ESTIMATE)
    : anchorRect.right + ANCHOR_GAP

  // Post-mount clamp against the card's real measured size (mirrors
  // ContextMenu.jsx / TrackColorPopover.jsx's clamp-after-mount pattern).
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let nextTop = initialTop
    let nextLeft = initialLeft
    if (rect.bottom > window.innerHeight) nextTop = Math.max(4, window.innerHeight - rect.height - 4)
    if (nextTop < 4) nextTop = 4
    if (rect.right > window.innerWidth) {
      setFlipped(true)
      nextLeft = Math.max(4, anchorRect.left - ANCHOR_GAP - rect.width)
    }
    el.style.top = `${nextTop}px`
    el.style.left = `${nextLeft}px`
    // Anchor identity changes on every hover target, which is exactly when
    // this needs to re-run; initialTop/initialLeft are derived from it.
  }, [anchorRect, initialTop, initialLeft])

  // --xleth-flat-* are plain CSS custom properties, not entries in the
  // formal theme catalog (theming/tokens/catalog.ts), so useTokenValue()'s
  // ThemeContext lookup can't see them and silently returns '' — read them
  // with tokenValue() (getComputedStyle) instead. Safe here (unlike a
  // mount-time draw) because this component only ever mounts well after the
  // theme's :root vars are already applied, on user hover.
  const wellBg = tokenValue('--xleth-flat-well')
  const gridColor = tokenValue('--xleth-flat-border')
  const gridStrongColor = tokenValue('--xleth-flat-border-strong')
  const noteColor = tokenValue('--xleth-flat-text-secondary')
  const tokens = useMemo(
    () => ({ wellBg, gridColor, gridStrongColor, noteColor }),
    [wellBg, gridColor, gridStrongColor, noteColor]
  )

  const noteCount = pattern.notes?.length || 0
  const kind = inferPatternKind(pattern)
  const barCount = patternBarCount(pattern)
  const isEmpty = noteCount === 0

  // Rasterize (or hit the cache) whenever the pattern's content or the
  // resolved theme tokens change — cheap on a cache hit since
  // getOrRenderPatternPreview short-circuits on its own revision fingerprint.
  const offscreen = useMemo(
    () => (isEmpty ? null : getOrRenderPatternPreview(pattern, tokens)),
    [pattern, tokens, isEmpty]
  )

  // Hover = blit only. The offscreen bitmap is already fully laid out; this
  // effect never re-runs the drawing logic, it just copies pixels.
  useEffect(() => {
    if (!offscreen) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height)
  }, [offscreen])

  return createPortal(
    <div
      ref={cardRef}
      className={`pattern-preview-tooltip ${entered ? 'is-visible' : ''} ${flipped ? 'is-flipped' : ''}`}
      style={{ top: initialTop, left: initialLeft }}
    >
      <div className="pattern-preview-header">
        <span className="pattern-preview-name">{pattern.name || `Pattern ${pattern.id}`}</span>
        <span className="pattern-preview-kind-badge">{kind}</span>
      </div>
      <div className="pattern-preview-ticks">{pattern.lengthTicks || 0} ticks</div>

      {isEmpty ? (
        <div className="pattern-preview-empty" style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }}>
          empty pattern
        </div>
      ) : (
        <canvas
          ref={canvasRef}
          className="pattern-preview-canvas"
          width={PREVIEW_WIDTH * PREVIEW_DPR}
          height={PREVIEW_HEIGHT * PREVIEW_DPR}
        />
      )}

      <div className="pattern-preview-footer">
        {noteCount} {kind === 'PERC' ? 'hit' : 'note'}{noteCount === 1 ? '' : 's'} · {barCount} bar{barCount === 1 ? '' : 's'}
      </div>
    </div>,
    document.body
  )
}
