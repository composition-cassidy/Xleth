import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './GridEditFlyout.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcX = iconComponent('x')

/** Width of the flyout: two rails of 208px side by side. */
export const FLYOUT_WIDTH = 416
const GAP = 4
const MARGIN = 8
const MAX_HEIGHT = 560
const MIN_HEIGHT = 240

/**
 * Where the flyout goes, beside the Preview's rect. Prefers the right side
 * (Compose docks the Preview at the left), falls back to the left, and
 * overlaps the Preview only when neither side has room. Top-aligned with the
 * Preview, as tall as the window allows up to MAX_HEIGHT.
 */
export function placeFlyout(anchor, viewport) {
  const width = Math.min(FLYOUT_WIDTH, Math.max(0, viewport.width - 2 * MARGIN))
  let left
  if (anchor.right + GAP + width <= viewport.width - MARGIN) left = anchor.right + GAP
  else if (anchor.left - GAP - width >= MARGIN) left = anchor.left - GAP - width
  else left = Math.max(MARGIN, viewport.width - MARGIN - width)

  const height = Math.max(Math.min(MIN_HEIGHT, viewport.height), Math.min(MAX_HEIGHT, viewport.height - 2 * MARGIN))
  const top = Math.max(MARGIN, Math.min(anchor.top, viewport.height - MARGIN - height))
  return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) }
}

function sameBox(a, b) {
  return a && b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
}

/**
 * Edit Grid in a Preview too narrow to hold its two rails (Compose docks it in
 * a ~345px corner): the track rail and the settings rail open together in a
 * window-level flyout beside the Preview, and the picture keeps the whole
 * panel. It follows the Preview while it is open (a floating Preview can be
 * dragged, docks can be resized), and closing it leaves Edit Grid mode.
 *
 * Portaled to body so no panel or dock clips it. Its React parent is still the
 * Preview, so stores, context and HTML drag-and-drop onto the picture work as
 * they do with the rails in place.
 */
export default function GridEditFlyout({ anchorRef, onClose, children }) {
  const [box, setBox] = useState(null)

  useLayoutEffect(() => {
    let raf = 0
    let last = null
    const measure = () => {
      const el = anchorRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        const next = placeFlyout(r, { width: window.innerWidth, height: window.innerHeight })
        if (!sameBox(last, next)) { last = next; setBox(next) }
      }
      raf = requestAnimationFrame(measure)
    }
    measure()
    return () => cancelAnimationFrame(raf)
  }, [anchorRef])

  if (!box) return null

  return createPortal(
    <div
      className={styles.flyout}
      role="dialog"
      aria-label="Edit grid"
      data-testid="grid-edit-flyout"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    >
      <div className={styles.head}>
        <span className={styles.title}>Edit grid</span>
        <button
          type="button"
          className={styles.close}
          aria-label="Done editing the grid"
          data-hint="Done: leave Edit grid"
          onClick={onClose}
        >
          <IcX aria-hidden="true" />
        </button>
      </div>
      <div className={styles.body}>{children}</div>
    </div>,
    document.body,
  )
}
