import { useCallback, useId, useState } from 'react'
import { iconComponent } from '../../ui-kit/icons'
import styles from './TrackInspector.module.css'

const IcCaretDown = iconComponent('caret-down')
const IcCaretRight = iconComponent('caret-right')

// Which sections the user folded. One set for every track, so folding Roam keys
// keeps it folded while stepping through tracks. A per-viewer convenience:
// storage can be blocked, and then nothing is remembered.
const FOLD_KEY = 'xleth.inspector.track.folded'
function readFolded() {
  try {
    const v = JSON.parse(window.localStorage?.getItem(FOLD_KEY) ?? '[]')
    return new Set(Array.isArray(v) ? v : [])
  } catch { return new Set() }
}
function writeFolded(id, folded) {
  try {
    const s = readFolded()
    if (folded) s.add(id); else s.delete(id)
    window.localStorage?.setItem(FOLD_KEY, JSON.stringify([...s]))
  } catch { /* storage can be blocked */ }
}

function useFold(id) {
  const [folded, setFolded] = useState(() => readFolded().has(id))
  const toggle = useCallback(() => {
    setFolded((f) => { writeFolded(id, !f); return !f })
  }, [id])
  return [folded, toggle]
}

/**
 * One Inspector section: the name folds it (a real button with aria-expanded),
 * a quiet one-line summary sits beside the name while folded, and `actions`
 * (the section's own on/off switch, a units choice) stay at the right whether
 * folded or not. `children == null` means the section is only its switch
 * (Hold last frame while off): no chevron, nothing to fold.
 *
 * Props: id (fold memory key), title, summary, actions, hint (info bar),
 *        off (dim the body), testId, children.
 */
export function TrackSection({ id, title, summary, actions, hint, off = false, testId, children }) {
  const [folded, toggle] = useFold(id)
  const bodyId = useId()
  const hasBody = children != null && children !== false
  const open = hasBody && !folded
  return (
    <section className={styles.section} aria-label={title} data-testid={testId}>
      <h3 className={styles.sectionHead} data-hint={hint}>
        {hasBody ? (
          <button
            type="button"
            className={styles.fold}
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            onClick={toggle}
            data-hint={`${open ? 'Fold' : 'Unfold'} ${title}`}
          >
            {open
              ? <IcCaretDown className={styles.chevron} aria-hidden="true" />
              : <IcCaretRight className={styles.chevron} aria-hidden="true" />}
            <span className={styles.sectionName}>{title}</span>
          </button>
        ) : (
          <span className={styles.fold}>
            <span className={styles.chevronSpacer} aria-hidden="true" />
            <span className={styles.sectionName}>{title}</span>
          </span>
        )}
        {!open && summary ? <span className={styles.summary}>{summary}</span> : null}
        {actions ? <span className={styles.sectionActions}>{actions}</span> : null}
      </h3>
      {open ? (
        <div id={bodyId} className={styles.sectionBody} data-off={off || undefined}>
          {children}
        </div>
      ) : null}
    </section>
  )
}

/** A label / value row: the label in a fixed column, the control(s) beside it. */
export function TRow({ label, children }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <div className={styles.rowControl}>{children}</div>
    </div>
  )
}

/** Two aligned columns of fields, label above the box. */
export function Fields({ children }) {
  return <div className={styles.fields}>{children}</div>
}

/** One field of a Fields grid. `stretch` makes a number box or menu fill the column. */
export function Field({ label, stretch = false, children }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <div className={styles.fieldControl} data-stretch={stretch || undefined}>{children}</div>
    </div>
  )
}

export { styles as trackStyles }
