import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { IconButton } from './Button';
import styles from './Dialog.module.css';

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  /** Panel and dialog title (16px). Also the dialog's accessible name. */
  title: string;
  /** Escape, a press on the backdrop and the close button. Omit with `dismissable={false}` for a dialog that must be answered. */
  onClose?: () => void;
  /** Enter runs this, unless focus is on a button, link or field (those keep their own Enter). */
  onEnter?: () => void;
  /** Default true. False hides the close button and ignores Escape and backdrop presses (a task is running). */
  dismissable?: boolean;
  /** The reading text and controls. Dialog body is prose: 16px. */
  children: ReactNode;
  /** The footer: Buttons, right-aligned. Put the default action last (`variant="primary"`). */
  actions?: ReactNode;
  width?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * A modal dialog: floating surface (hard offset shadow), no blur. Focus moves in on open
 * (to the element marked `data-autofocus`, else the first control), is trapped while open and
 * returns to where it was on close.
 */
export default function Dialog({ title, onClose, onEnter, dismissable = true, children, actions, width = 'md', className }: DialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onClose, onEnter, dismissable });
  callbacks.current = { onClose, onEnter, dismissable };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = panel.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE) ?? el;
    first?.focus({ preventScroll: true });
    return () => {
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cb = callbacks.current;
      if (e.key === 'Escape' && cb.dismissable && cb.onClose) { e.stopPropagation(); cb.onClose(); return; }
      if (e.key === 'Enter' && cb.onEnter) {
        const t = e.target as HTMLElement | null;
        if (t && /^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
        e.preventDefault();
        cb.onEnter();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const trap = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (!nodes.length) { e.preventDefault(); return; }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={(e) => { if (e.target === e.currentTarget && dismissable) onClose?.(); }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`${styles.panel}${className ? ` ${className}` : ''}`}
        data-width={width}
        onKeyDown={trap}
      >
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>{title}</h2>
          {dismissable && onClose ? (
            <IconButton label="Close" size="sm" onClick={onClose}><X size={14} /></IconButton>
          ) : null}
        </div>
        <div className={styles.body}>{children}</div>
        {actions ? <div className={styles.footer}>{actions}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/** A paragraph of dialog prose (16px, 1.5 line height). */
export function DialogText({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'secondary' }) {
  return <p className={styles.text} data-tone={tone}>{children}</p>;
}

/** A ruled list of label / value rows (what will be deleted, which plugins are missing). */
export function DialogList({ label, children }: { label: string; children: ReactNode }) {
  return <ul className={styles.list} aria-label={label}>{children}</ul>;
}

export function DialogListItem({ label, detail, value, strong, children }: { label: ReactNode; detail?: ReactNode; value?: ReactNode; strong?: boolean; children?: ReactNode }) {
  return (
    <li className={styles.row} data-strong={strong || undefined}>
      <span className={styles.rowText}>
        <span className={styles.rowLabel}>{label}</span>
        {detail ? <span className={styles.rowDetail}>{detail}</span> : null}
      </span>
      {value ? <span className={styles.rowValue}>{value}</span> : null}
      {children ? <span className={styles.rowActions}>{children}</span> : null}
    </li>
  );
}
