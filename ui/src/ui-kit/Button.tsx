import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { hintAttrs, type HintProps } from './hint';
import { IconActive } from './icons';
import styles from './Button.module.css';
import type { DataAttrs } from './valueProps';

type Size = 'sm' | 'md' | 'lg';
/** `primary` is the inverted ink chip (the one default action of a dialog); `danger` outlines in the error text colour. */
type Variant = 'default' | 'ghost' | 'primary' | 'danger';
/**
 * How an "on" toggle reads. `chip` (default) is the inverted ink chip: state you watch (M / S / V,
 * the active tool, loop armed). `quiet` is for housekeeping toggles that are on nearly all the time
 * (region toggles, tempo lock): a raised g3 control with its outline and an ink glyph, so the
 * brightest things in the chrome are not the ones that never change. DESIGN.md 3.2.
 */
export type OnTone = 'chip' | 'quiet';

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
  /** `quiet`: an always-on housekeeping toggle (see OnTone). Only meaningful with `pressed`. */
  tone?: OnTone;
  /** Tool pickers: the one-letter shortcut. The button stays icon-sized; on hover or focus the icon rolls up and the letter rolls in. */
  keyHint?: string;
}

/** Square icon button, hit area at least 24x24. `pressed` makes it a toggle. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { size = 'md', variant = 'ghost', label, pressed, tone, keyHint, hint, hintMods, className, type = 'button', children, ...rest },
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
      data-tone={tone === 'quiet' ? 'quiet' : undefined}
      data-key={keyHint || undefined}
      aria-keyshortcuts={keyHint || undefined}
      {...hintAttrs({ hint, hintMods })}
    >
      {/* A pressed IconButton renders its icon in Fill (active = Fill, never colour alone). */}
      <IconActive.Provider value={!!pressed}>
        {keyHint ? (
          <span className={styles.reel}>
            <span className={styles.track}>
              <span className={styles.cell}>{children}</span>
              <span className={`${styles.cell} ${styles.key}`} aria-hidden="true">{keyHint}</span>
            </span>
          </span>
        ) : children}
      </IconActive.Provider>
    </button>
  );
});

export default Button;
