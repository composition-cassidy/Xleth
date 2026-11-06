import { useEffect, useState } from 'react'
import { resolveHint } from '../ui-kit/hint'
import styles from './HintBar.module.css'

const EMPTY = { text: '', mods: '' }

// Reading hints is part of the kit's hint plumbing (ui-kit/hint.ts): controls
// write data-hint / data-hint-mods, this bar reads them with the same resolver.
export { resolveHint }

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
