import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '../Button';
import styles from './DeviceMenu.module.css';

export interface DeviceMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Destructive (Delete). Marked with a leading glyph as well as ink, never colour alone. */
  danger?: boolean;
}

export interface DeviceMenuProps {
  /** The trigger's accessible name ("More for Compressor"). */
  label: string;
  /** Trigger glyph (an icon element). */
  children: ReactNode;
  items: readonly DeviceMenuItem[];
  hint?: string;
}

interface Position { left: number; top?: number; bottom?: number }

const ITEM = '[role="menuitem"]:not(:disabled)';

/**
 * The device "more" menu: an icon trigger and a small action list. The popup is
 * a floating surface (portalled to the body), so it carries the hard offset
 * shadow. Arrow keys move, Enter / Space run, Escape and an outside click close.
 */
export default function DeviceMenu({ label, children, items, hint }: DeviceMenuProps) {
  const menuId = `device-menu-${useId()}`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setPos(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const pad = 8;
    const width = 180;
    const left = Math.max(pad, Math.min(rect.right - width, window.innerWidth - width - pad));
    const opensUp = window.innerHeight - rect.bottom < 160 && rect.top > 160;
    setPos(opensUp ? { left, bottom: window.innerHeight - rect.top + 4 } : { left, top: rect.bottom + 4 });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const first = popupRef.current?.querySelector<HTMLElement>(ITEM);
    first?.focus();
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popupRef.current?.contains(t)) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    const onResize = () => close(false);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, pos, close]);

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(ITEM));
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!list.length) return;
      const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[next].focus();
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return (
    <>
      <IconButton
        ref={triggerRef}
        size="sm"
        label={label}
        hint={hint ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {children}
      </IconButton>
      {open && pos && typeof document !== 'undefined'
        ? createPortal(
          <div
            ref={popupRef}
            id={menuId}
            role="menu"
            aria-label={label}
            className={styles.popup}
            style={pos}
            onKeyDown={onMenuKey}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={styles.item}
                data-danger={item.danger || undefined}
                disabled={item.disabled}
                onClick={() => { close(); item.onSelect(); }}
              >
                {item.danger ? <span className={styles.dangerGlyph} aria-hidden="true">×</span> : null}
                <span className={styles.itemLabel}>{item.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )
        : null}
    </>
  );
}
