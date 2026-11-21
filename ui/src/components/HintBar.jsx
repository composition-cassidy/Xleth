import { useEffect, useRef, useState } from 'react'
import { HINT_REFRESH_EVENT, requestHintRefresh, resolveHint } from '../ui-kit/hint'
import styles from './HintBar.module.css'

const EMPTY = { text: '', mods: '' }

// Reading hints is part of the kit's hint plumbing (ui-kit/hint.ts): controls
// write data-hint / data-hint-mods, this bar reads them with the same resolver.
export { resolveHint, requestHintRefresh, HINT_REFRESH_EVENT }

/**
 * The 22px bar along the bottom of the window. It never shows a value that is
 * not in a store: engine status (rate, buffer, CPU) appears here only once a
 * store carries it. Today none does, so the bar is hints only.
 *
 * It reads the hovered element's hint on `pointerover`. A canvas whose hint
 * depends on the row under the pointer (no new pointerover fires inside one
 * element) dispatches window 'xleth-hint-refresh': detail { hint, mods } shows
 * that text until the pointer enters another element; detail null re-reads the
 * hovered element (after the canvas rewrote its own data-hint).
 */
export default function HintBar() {
  const [hint, setHint] = useState(EMPTY)
  const hoveredRef = useRef(null)

  useEffect(() => {
    const show = (next) => setHint((prev) => (prev.text === next.text && prev.mods === next.mods ? prev : next))
    const onOver = (event) => {
      hoveredRef.current = event.target
      show(resolveHint(event.target))
    }
    // Leaving the window clears the hint rather than leaving a stale one up.
    const onLeave = (event) => {
      if (event.relatedTarget === null) {
        hoveredRef.current = null
        setHint(EMPTY)
      }
    }
    const onRefresh = (event) => {
      const d = event.detail
      if (d && typeof d === 'object' && typeof d.hint === 'string') {
        show({ text: d.hint.trim(), mods: typeof d.mods === 'string' ? d.mods.trim() : '' })
      } else {
        show(hoveredRef.current ? resolveHint(hoveredRef.current) : EMPTY)
      }
    }
    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerout', onLeave)
    window.addEventListener(HINT_REFRESH_EVENT, onRefresh)
    return () => {
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerout', onLeave)
      window.removeEventListener(HINT_REFRESH_EVENT, onRefresh)
    }
  }, [])

  return (
    <footer className={styles.bar} data-testid="hint-bar">
      <span className={styles.hint}>{hint.text}</span>
      {hint.mods ? <span className={styles.mods}>{hint.mods}</span> : null}
    </footer>
  )
}
