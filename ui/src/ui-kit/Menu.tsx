import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './Menu.module.css';
import { useGhostExit, useMotionEnter } from './motion';
import { iconComponent } from './icons';

const IcCheck = iconComponent('check');

const SURFACE_ATTR = 'data-xleth-menu';
const ITEM_SELECTOR = '[role^="menuitem"]:not([aria-disabled="true"])';

export interface MenuProps {
  /** Page position of the top-left corner (clientX / clientY); clamped into the viewport. */
  x: number;
  y: number;
  /** Outside press, Escape, Tab, and (for items that ask) selecting an item. */
  onClose: () => void;
  /** Accessible name of the menu. */
  label?: string;
  className?: string;
  /**
   * For a submenu: the x of its parent menu's left edge. When the menu does not fit to the
   * right of `x`, it opens to the LEFT of the parent instead (its right edge meets this x)
   * rather than being clamped back over the parent.
   */
  flipX?: number;
  /**
   * How it was asked for, which decides its motion channel (ui-kit/motion.css): `context` is a
   * right-click menu (in the edit loop: instant until the lively tier), `popover` (the default)
   * is a menu opened from a button.
   */
  kind?: 'popover' | 'context';
  children: ReactNode;
}

const CloseContext = createContext<(() => void) | null>(null);

/**
 * A floating menu (context menu or popover list). It is a floating surface, so it alone
 * carries the hard offset shadow (DESIGN.md section 1). Keyboard: arrows, Home and End move
 * between items, Enter and Space select, Escape closes and returns focus to where it was.
 * Several menus may be open at once (a submenu is a second Menu): a press inside any menu
 * surface is never "outside".
 */
export function Menu({ x, y, onClose, label = 'Menu', className, flipX, kind = 'popover', children }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const enter = useMotionEnter(kind === 'context' ? 'context' : 'pop');
  useGhostExit(ref);
  const returnFocus = useRef<Element | null>(null);

  // Clamp into the viewport, again whenever the menu's own size changes (items can appear
  // while it is open).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const clamp = () => {
      const r = el.getBoundingClientRect();
      let wantLeft = x;
      if (flipX !== undefined && x + r.width > window.innerWidth - 4) wantLeft = flipX - r.width + 2;
      const left = Math.max(4, Math.min(wantLeft, window.innerWidth - r.width - 4));
      const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
      setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
    };
    clamp();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(clamp);
    ro.observe(el);
    return () => ro.disconnect();
  }, [x, y, flipX]);

  // Focus the surface on open so the arrow keys work, and give focus back on close.
  useEffect(() => {
    returnFocus.current = document.activeElement;
    ref.current?.focus({ preventScroll: true });
    return () => {
      const el = returnFocus.current as HTMLElement | null;
      if (el && typeof el.focus === 'function' && document.contains(el)) el.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t && typeof t.closest === 'function' && t.closest(`[${SURFACE_ATTR}]`)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % items.length;
    else if (e.key === 'ArrowUp') next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Tab') { e.preventDefault(); onClose(); return; }
    if (next >= 0) { e.preventDefault(); items[next].focus(); }
  };

  return createPortal(
    <CloseContext.Provider value={onClose}>
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        {...{ [SURFACE_ATTR]: '' }}
        className={`${styles.menu}${className ? ` ${className}` : ''}`}
        {...enter}
        style={{ left: pos.left, top: pos.top, '--mo-origin': `${Math.max(0, x - pos.left)}px ${Math.max(0, y - pos.top)}px` } as CSSProperties}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {children}
      </div>
    </CloseContext.Provider>,
    document.body,
  );
}

export interface MenuItemProps {
  children: ReactNode;
  /** Runs on click, Enter or Space. The menu closes afterwards unless `keepOpen`. */
  onSelect?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  /** Leading glyph (an icon element). */
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** When defined the item is a checkbox row and always reserves the check column. */
  checked?: boolean;
  /** Draws a trailing glyph (for example a chevron) and does not close the menu on select. */
  trailing?: ReactNode;
  keepOpen?: boolean;
  /** The command's key combo, printed dim at the right edge ("Ctrl + X"). Display only: the binding lives elsewhere. */
  shortcut?: string;
  onMouseEnter?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}

export function MenuItem({ children, onSelect, icon, danger, disabled, checked, trailing, keepOpen, shortcut, onMouseEnter }: MenuItemProps) {
  const close = useContext(CloseContext);
  const role = checked === undefined ? 'menuitem' : 'menuitemcheckbox';
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      className={styles.item}
      data-danger={danger || undefined}
      onMouseEnter={onMouseEnter}
      onClick={(e) => {
        if (disabled) return;
        onSelect?.(e);
        if (!keepOpen && !trailing) close?.();
      }}
    >
      {checked !== undefined ? (
        <span className={styles.lead} aria-hidden="true">{checked ? <IcCheck size={14} /> : null}</span>
      ) : icon ? (
        <span className={styles.lead} aria-hidden="true">{icon}</span>
      ) : null}
      <span className={styles.text}>{children}</span>
      {shortcut ? <span className={styles.shortcut} aria-hidden="true">{shortcut}</span> : null}
      {trailing ? <span className={styles.trail} aria-hidden="true">{trailing}</span> : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className={styles.sep} />;
}

/** Arbitrary content (a slider, a select) inside a menu. A press inside it does not close the menu. */
export function MenuCustom({ children }: { children: ReactNode }) {
  return <div className={styles.custom} onMouseDown={(e) => e.stopPropagation()}>{children}</div>;
}
