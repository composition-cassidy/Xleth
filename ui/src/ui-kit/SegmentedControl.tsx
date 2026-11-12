import type { ReactNode } from 'react';
import { hintAttrs, type HintProps } from './hint';
import { IconActive } from './icons';
import { rovingKeyHandler } from './roving';
import styles from './SegmentedControl.module.css';
import type { DataAttrs } from './valueProps';

export interface Segment<T extends string | number> extends HintProps {
  value: T;
  label: ReactNode;
  /** Optional glyph before the label. */
  glyph?: ReactNode;
  disabled?: boolean;
  /** Accessible name when `label` is not text (an icon). */
  ariaLabel?: string;
}

export interface SegmentedControlProps<T extends string | number> extends HintProps, DataAttrs {
  /** Names the group for screen readers ("Spacebar mode"). */
  label: string;
  options: readonly Segment<T>[];
  value: T;
  onChange?: (value: T) => void;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  className?: string;
}

const ITEM = '[role="radio"]';
const onKeyDown = rovingKeyHandler(ITEM);

/**
 * One choice from a few, all visible. The selected segment is the inverted ink
 * chip; selection also sets aria-checked, so it is never colour alone.
 * Arrows move and select (radio-group behaviour); one tab stop for the group.
 */
export default function SegmentedControl<T extends string | number>(props: SegmentedControlProps<T>) {
  const { label, options, value, onChange, size = 'md', disabled = false, hint, hintMods, className, ...rest } = props;
  const selected = options.findIndex((o) => Object.is(o.value, value));
  const stop = selected >= 0 ? selected : options.findIndex((o) => !o.disabled);
  return (
    <div
      {...rest}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={`${styles.group}${className ? ` ${className}` : ''}`}
      data-size={size}
      {...hintAttrs({ hint, hintMods })}
      onKeyDown={(e) => {
        onKeyDown(e);
        // Radio behaviour: moving focus with the arrows also selects.
        const el = document.activeElement as HTMLElement | null;
        const i = el ? Array.from(e.currentTarget.querySelectorAll(ITEM)).indexOf(el) : -1;
        if (i >= 0 && i !== selected && /^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key) && !options[i].disabled) onChange?.(options[i].value);
      }}
    >
      {options.map((o, i) => {
        const checked = i === selected;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            className={styles.seg}
            aria-checked={checked}
            aria-label={o.ariaLabel}
            tabIndex={i === stop ? 0 : -1}
            disabled={disabled || o.disabled}
            data-checked={checked}
            {...hintAttrs({ hint: o.hint, hintMods: o.hintMods })}
            onClick={() => { if (!checked) onChange?.(o.value); }}
          >
            <IconActive.Provider value={checked}>
              {o.glyph ? <span className={styles.glyph} aria-hidden="true">{o.glyph}</span> : null}
              {o.label}
            </IconActive.Provider>
          </button>
        );
      })}
    </div>
  );
}
