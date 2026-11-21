import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { hintAttrs, type HintProps } from './hint';
import { IconActive } from './icons';
import buttonStyles from './Button.module.css';
import type { OnTone } from './Button';
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
  /** Draw the glyph after the label, so "Edit" + a grid glyph reads as "Edit grid". */
  glyphEnd?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** `quiet`: an always-on housekeeping toggle keeps a raised g3 control instead of the ink chip. */
  tone?: OnTone;
}

/**
 * Off = neutral outline. On = the inverted ink chip (`--ui-on`), or with `tone="quiet"` a raised
 * g3 control for toggles that are on nearly all the time (DESIGN.md 3.2). A real
 * `<button aria-pressed>`, so Space and Enter work and screen readers say "pressed".
 */
export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { on, onChange, children, glyph, glyphEnd = false, size = 'md', tone, hint, hintMods, className, type = 'button', onClick, ...rest },
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
      data-tone={tone === 'quiet' ? 'quiet' : undefined}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onChange?.(!on);
      }}
      {...hintAttrs({ hint, hintMods })}
    >
      {/* On: the glyph renders in Fill as well as the chip inverting. */}
      <IconActive.Provider value={!!on}>
        {glyph && !glyphEnd ? <span className={styles.glyph} aria-hidden="true">{glyph}</span> : null}
        {children}
        {glyph && glyphEnd ? <span className={styles.glyph} aria-hidden="true">{glyph}</span> : null}
      </IconActive.Provider>
    </button>
  );
});

export default Toggle;
