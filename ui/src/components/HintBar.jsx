import { useEffect, useState } from 'react'
import styles from './HintBar.module.css'

const HINT_SELECTOR = '[data-hint], [aria-label], [title]'
const EMPTY = { text: '', mods: '' }

/**
 * What the hint bar says for a hovered node: the nearest element that
 * documents itself. Its `data-hint` wins, then `aria-label`, then `title`;
 * `data-hint-mods` (modifier help) is shown on the right.
 */
export function resolveHint(target) {
  const element = target && typeof target.closest === 'function' ? target.closest(HINT_SELECTOR) : null
  if (!element) return EMPTY
  const text = element.getAttribute('data-hint')
    || element.getAttribute('aria-label')
    || element.getAttribute('title')
    || ''
  return { text: text.trim(), mods: (element.getAttribute('data-hint-mods') || '').trim() }
}

/**
 * The 22px bar along the bottom of the window. It never shows a value that is
 * not in a store: engine status (rate, buffer, CPU) appears here only once a
 * store carries it. Today none does, so the bar is hints only.
 */
export default function HintBar() {
  const [hint, setHint] = useState(EMPTY)

  useEffect(() => {
    const onOver = (event) => {
      const next = resolveHint(event.target)
      setHint((prev) => (prev.text === next.text && prev.mods === next.mods ? prev : next))
    }
    // Leaving the window clears the hint rather than leaving a stale one up.
    const onLeave = (event) => {
      if (event.relatedTarget === null) setHint(EMPTY)
    }
    document.addEventListener('pointerover', onOver)
    document.addEventListener('pointerout', onLeave)
    return () => {
      document.removeEventListener('pointerover', onOver)
      document.removeEventListener('pointerout', onLeave)
    }
  }, [])

  return (
    <footer className={styles.bar} data-testid="hint-bar">
      <span className={styles.hint}>{hint.text}</span>
      {hint.mods ? <span className={styles.mods}>{hint.mods}</span> : null}
    </footer>
  )
}
