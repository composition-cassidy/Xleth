import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { IconButton } from '../../ui-kit'
import styles from './ClipFxEditors.module.css'

/**
 * The frame of a per-clip FX editor (Vibrato, Scratch), DESIGN.md 22. A floating, draggable,
 * NON-modal window of kit controls: you edit a curve while the arrangement stays live under it,
 * so it is not a Dialog (which is modal, with a scrim). It takes focus when it opens, Escape
 * closes the focused one (several can be open), and the title bar drags it.
 *
 * Mounted by ClipFxEditorHost at the windowing root, position: fixed, never inside a PanelFrame
 * (see ClipFxEditorHost.jsx for why). Hard offset shadow, as every floating surface carries.
 */
export default function ClipFxWindow({
  title, subtitle, label, testId, pos, width, onClose, onTitlePointerDown, children,
}) {
  const ref = useRef(null)

  // A window you just asked for is the one you are in.
  useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])

  return (
    <div
      ref={ref}
      className={`clipfx-window ${styles.window}`}
      style={{ left: pos.x, top: pos.y, width }}
      data-testid={testId}
      role="dialog"
      aria-modal="false"
      aria-label={label}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      }}
    >
      <div className={`clipfx-titlebar ${styles.titlebar}`} onPointerDown={onTitlePointerDown}>
        <span className={styles.title}>{title}</span>
        <span className={styles.subtitle}>{subtitle}</span>
        <IconButton size="sm" label={`Close ${title.toLowerCase()} editor`} onClick={onClose} hint="Close the editor" hintMods="Esc">
          <X size={14} aria-hidden="true" />
        </IconButton>
      </div>
      {children}
    </div>
  )
}

/** A labelled row of controls inside the window. */
export function FxRow({ label, children, hint }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <div className={styles.rowControls}>{children}</div>
      {hint ? <span className={styles.rowHint}>{hint}</span> : null}
    </div>
  )
}

/** The status line: whether the effect is on, and its settings in mono. */
export function FxStatus({ enabled, right }) {
  return (
    <div className={styles.status}>
      <span className={styles.statusMark} data-on={enabled ? 'true' : 'false'} aria-hidden="true" />
      <span>{enabled ? 'Active' : 'Off'}</span>
      <span className={styles.statusRight}>{right}</span>
    </div>
  )
}

/** Pushes the controls after it to the right edge of a row. */
export function FxSpacer() {
  return <span className={styles.grow} />
}

/** The two-column parameter grid. */
export function FxGrid({ children }) {
  return <div className={styles.grid}>{children}</div>
}

/** One labelled field of the grid; `wide` spans both columns on one line. */
export function FxField({ label, note, wide, children }) {
  return (
    <div className={`${styles.field}${wide ? ` ${styles.wide}` : ''}`}>
      {label ? <span className={styles.fieldLabel}>{label}</span> : null}
      {children}
      {note ? <span className={styles.fieldNote}>{note}</span> : null}
    </div>
  )
}

/** Wraps the canvas graph and its hint. */
export function FxGraph({ hint, children }) {
  return (
    <div className={styles.graphWrap}>
      {children}
      {hint ? <span className={styles.graphHint}>{hint}</span> : null}
    </div>
  )
}

/** A static, non-interactive chip (the "Custom" curve indicator): outlined, with its word. */
export function FxStaticChip({ testId, children }) {
  return <span className={styles.chipStatic} data-testid={testId}>{children}</span>
}
