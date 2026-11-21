import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { hintAttrs, type HintProps } from './hint';
import styles from './TextField.module.css';
import type { DataAttrs } from './valueProps';

export interface TextFieldProps extends HintProps, DataAttrs, Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'onChange' | 'value' | 'aria-label'> {
  /** Accessible name (there is no visible label on the field itself). */
  label: string;
  value: string;
  /** Called with the new text, not the event. */
  onChange?: (value: string) => void;
  size?: 'sm' | 'md' | 'lg';
  /** Code-like text only: notation, paths, hex values. */
  mono?: boolean;
  invalid?: boolean;
}

/** Single-line text input. Same height scale as Button (24 / 28 / 32). */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, value, onChange, size = 'md', mono = false, invalid = false, hint, hintMods, className, type = 'text', ...rest },
  ref,
) {
  return (
    <input
      {...rest}
      ref={ref}
      type={type}
      className={`${styles.field}${className ? ` ${className}` : ''}`}
      aria-label={label}
      aria-invalid={invalid || undefined}
      data-size={size}
      data-mono={mono || undefined}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      {...hintAttrs({ hint, hintMods })}
    />
  );
});

export default TextField;
