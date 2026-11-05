import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { hintAttrs, type HintProps } from './hint';
import buttonStyles from './Button.module.css';
import styles from './Toggle.module.css';
import type { DataAttrs } from './valueProps';

export interface ToggleProps extends HintProps, DataAttrs, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'children'> {
  on: boolean;
  onChange?: (next: boolean) => void;
  /** Visible label (omit for a glyph-only toggle and pass `aria-label`). */
  children?: ReactNode;
  /**
   * Optional glyph. Off: shown as-is; on: the chip also fills in, so state is
   * never carried by colour alone. Pass a check, a power mark, an M / S letter.
   */
  glyph?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Off = neutral outline. On = the inverted ink chip (`--ui-on`). A real
 * `<button aria-pressed>`, so Space and Enter work and screen readers say "pressed".
 */
export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { on, onChange, children, glyph, size = 'md', hint, hintMods, className, type = 'button', onClick, ...rest },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={`${buttonStyles.btn} ${styles.toggle}${className ? ` ${className}` : ''}`}
      data-size={size}
      aria-pressed={on}
      data-on={on}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onChange?.(!on);
      }}
      {...hintAttrs({ hint, hintMods })}
    >
      {glyph ? <span className={styles.glyph} aria-hidden="true">{glyph}</span> : null}
      {children}
    </button>
  );
});

export default Toggle;
