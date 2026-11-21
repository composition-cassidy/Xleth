import { forwardRef, useEffect, useRef } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { hintAttrs, type HintProps } from './hint';
import styles from './Checkbox.module.css';
import type { DataAttrs } from './valueProps';

export interface CheckboxProps extends HintProps, DataAttrs, Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked' | 'children'> {
  checked: boolean;
  /** Called with the new state, not the event. */
  onChange?: (next: boolean) => void;
  /** Visible label. Omit for a box with no text and pass `aria-label`. */
  children?: ReactNode;
  /** Mixed selection (a "select all" over a partly ticked list). */
  indeterminate?: boolean;
}

/** A labelled checkbox. The label is part of the hit area. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { checked, onChange, children, indeterminate = false, disabled, hint, hintMods, className, ...rest },
  ref,
) {
  const inner = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (inner.current) inner.current.indeterminate = indeterminate; }, [indeterminate]);
  return (
    <label
      className={`${styles.row}${className ? ` ${className}` : ''}`}
      data-disabled={disabled || undefined}
      {...hintAttrs({ hint, hintMods })}
    >
      <input
        {...rest}
        ref={(node) => {
          inner.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        type="checkbox"
        className={styles.box}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      {children}
    </label>
  );
});

export default Checkbox;
