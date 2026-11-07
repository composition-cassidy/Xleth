import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { hintAttrs, type HintProps } from './hint';
import styles from './Button.module.css';
import type { DataAttrs } from './valueProps';

type Size = 'sm' | 'md' | 'lg';
/** `primary` is the inverted ink chip (the one default action of a dialog); `danger` outlines in the error text colour. */
type Variant = 'default' | 'ghost' | 'primary' | 'danger';

interface BaseProps extends HintProps, DataAttrs, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  size?: Size;
  variant?: Variant;
}

export interface ButtonProps extends BaseProps {
  children: ReactNode;
  /** Optional leading glyph (an icon element). */
  glyph?: ReactNode;
}

/** Text button. Neutral outline at rest; no hover lift, no glow. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { size = 'md', variant = 'default', glyph, hint, hintMods, className, type = 'button', children, ...rest },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={`${styles.btn}${className ? ` ${className}` : ''}`}
      data-size={size}
      data-variant={variant}
      {...hintAttrs({ hint, hintMods })}
    >
      {glyph ? <span className={styles.glyph} aria-hidden="true">{glyph}</span> : null}
      {children}
    </button>
  );
});

export interface IconButtonProps extends BaseProps {
  /** Required: the accessible name, and the hint bar's fallback text. */
  label: string;
  children: ReactNode;
  /** Toggle state. When set the button is aria-pressed and, when on, the inverted ink chip. */
  pressed?: boolean;
}

/** Square icon button, hit area at least 24x24. `pressed` makes it a toggle. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { size = 'md', variant = 'ghost', label, pressed, hint, hintMods, className, type = 'button', children, ...rest },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={`${styles.btn} ${styles.icon}${className ? ` ${className}` : ''}`}
      data-size={size}
      data-variant={variant}
      aria-label={label}
      aria-pressed={pressed}
      {...hintAttrs({ hint, hintMods })}
    >
      {children}
    </button>
  );
});

export default Button;
