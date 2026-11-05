import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { hintAttrs, type HintProps } from './hint';
import styles from './Select.module.css';
import type { DataAttrs } from './valueProps';

// Behaviourally the same as components/common/XlethSelect.jsx (same keys, same
// `openSignal`, same option matching), restyled onto the kit. XlethSelect stays
// for panels that have not migrated yet and is removed in Phase 8.

export interface SelectOption<T = unknown> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Options with the same `group` as their predecessor share one heading. */
  group?: string;
}

export interface SelectProps<T = unknown> extends HintProps, DataAttrs {
  value: T;
  options: readonly SelectOption<T>[];
  onChange?: (value: T) => void;
  disabled?: boolean;
  /** Accessible name (there is no visible label on the trigger). */
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
  id?: string;
  /** Bump to pop the list open without a click (a middle-drag that commits a region). */
  openSignal?: number;
  size?: 'sm' | 'md' | 'lg';
}

const clamp = (value: number, min: number, max: number): number => (max < min ? min : Math.min(Math.max(value, min), max));

export function getSelectedOption<T>(options: readonly SelectOption<T>[], value: T): SelectOption<T> | null {
  return options.find((o) => Object.is(o.value, value))
    ?? options.find((o) => String(o.value) === String(value))
    ?? null;
}

function scrollParentsOf(node: HTMLElement | null): Array<HTMLElement | Window> {
  if (!node || typeof window === 'undefined') return [];
  const parents: Array<HTMLElement | Window> = [];
  let parent = node.parentElement;
  while (parent && parent !== document.body) {
    const style = window.getComputedStyle(parent);
    if (/(auto|scroll|overlay)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) parents.push(parent);
    parent = parent.parentElement;
  }
  parents.push(window);
  return parents;
}

interface Position {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
  placement: 'top' | 'bottom';
}

export default function Select<T = unknown>(props: SelectProps<T>) {
  const {
    id, value, options, onChange, disabled = false, ariaLabel, placeholder = 'Select…', className, openSignal = 0,
    size = 'md', hint, hintMods, ...rest
  } = props;
  const generatedId = useId();
  const triggerId = id || `ui-select-${generatedId}`;
  const listboxId = `${triggerId}-listbox`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [position, setPosition] = useState<Position | null>(null);

  const selectedOption = useMemo(() => getSelectedOption(options, value), [options, value]);
  const selectedIndex = useMemo(() => {
    const i = options.findIndex((o) => o === selectedOption);
    return i >= 0 ? i : 0;
  }, [options, selectedOption]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === 'undefined') { setOpen(false); return; }
    const rect = trigger.getBoundingClientRect();
    const pad = 8;
    const width = Math.min(Math.max(rect.width, 180), window.innerWidth - pad * 2);
    const left = clamp(rect.left, pad, window.innerWidth - width - pad);
    const below = window.innerHeight - rect.bottom - pad;
    const above = rect.top - pad;
    const opensUp = below < 180 && above > below;
    const maxHeight = Math.min(280, Math.max(120, opensUp ? above : below));
    setPosition(opensUp
      ? { left, width, maxHeight, bottom: Math.max(pad, window.innerHeight - rect.top + 4), placement: 'top' }
      : { left, width, maxHeight, top: Math.min(window.innerHeight - pad, rect.bottom + 4), placement: 'bottom' });
  }, []);

  const close = useCallback(() => { setOpen(false); setPosition(null); }, []);

  const openPopup = useCallback((index = selectedIndex) => {
    if (disabled || options.length === 0) return;
    setHighlighted(clamp(index, 0, options.length - 1));
    setOpen(true);
  }, [disabled, options.length, selectedIndex]);

  useEffect(() => { if (open) updatePosition(); }, [open, updatePosition]);

  const lastSignal = useRef(openSignal);
  useEffect(() => {
    if (openSignal === lastSignal.current) return;
    lastSignal.current = openSignal;
    if (openSignal <= 0) return;
    openPopup(selectedIndex);
    // Focus the trigger as well, or arrows and Enter have nowhere to land.
    triggerRef.current?.focus();
  }, [openSignal, openPopup, selectedIndex]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popupRef.current?.contains(t)) return;
      close();
    };
    const onViewport = () => updatePosition();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    const parents = scrollParentsOf(triggerRef.current);
    window.addEventListener('resize', onViewport);
    parents.forEach((p) => p.addEventListener('scroll', onViewport, true));
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onViewport);
      parents.forEach((p) => p.removeEventListener('scroll', onViewport, true));
      window.removeEventListener('keydown', onKey, true);
    };
  }, [close, open, updatePosition]);

  useEffect(() => {
    if (open) optionRefs.current[highlighted]?.scrollIntoView?.({ block: 'nearest' });
  }, [highlighted, open]);

  useEffect(() => { if (disabled) close(); }, [close, disabled]);

  const selectIndex = useCallback((index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange?.(option.value);
    close();
    triggerRef.current?.focus();
  }, [close, onChange, options]);

  const moveHighlight = useCallback((direction: 1 | -1) => {
    if (options.length === 0) return;
    setHighlighted((current) => {
      let next = current;
      for (let i = 0; i < options.length; i += 1) {
        next = (next + direction + options.length) % options.length;
        if (!options[next]?.disabled) return next;
      }
      return current;
    });
  }, [options]);

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) openPopup(selectedIndex); else moveHighlight(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) openPopup(selectedIndex); else moveHighlight(-1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (!open) openPopup(selectedIndex); else selectIndex(highlighted);
        break;
      case 'Tab':
        close();
        break;
      default:
        break;
    }
  };

  const popup = open && position && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={popupRef}
          className={styles.popup}
          data-placement={position.placement}
          style={{ left: position.left, width: position.width, maxHeight: position.maxHeight, top: position.top, bottom: position.bottom }}
          role="listbox"
          id={listboxId}
          aria-labelledby={triggerId}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {options.map((option, index) => {
            const selected = option === selectedOption || Object.is(option.value, value) || String(option.value) === String(value);
            const startsGroup = option.group && option.group !== options[index - 1]?.group;
            return (
              <Fragment key={`${String(option.value)}-${option.label}`}>
                {startsGroup ? <div className={styles.group} role="presentation">{option.group}</div> : null}
                <button
                  ref={(node) => { optionRefs.current[index] = node; }}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={option.disabled}
                  data-value={String(option.value)}
                  data-highlighted={index === highlighted}
                  className={styles.option}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => selectIndex(index)}
                >
                  <span className={styles.optionLabel}>{option.label}</span>
                  {selected ? <Check size={14} aria-hidden="true" /> : null}
                </button>
              </Fragment>
            );
          })}
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        {...rest}
        id={triggerId}
        ref={triggerRef}
        type="button"
        className={`${styles.trigger}${className ? ` ${className}` : ''}`}
        data-size={size}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        {...hintAttrs({ hint, hintMods })}
        onClick={() => {
          if (disabled) return;
          if (open) close(); else openPopup(selectedIndex);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={styles.triggerLabel}>{selectedOption?.label ?? placeholder}</span>
        <ChevronDown className={styles.chevron} size={14} aria-hidden="true" />
      </button>
      {popup}
    </>
  );
}
