import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, KeyboardEvent, MouseEvent } from 'react';
import { hintAttrs, type HintProps } from './hint';
import { PEARL_HINT, PEARL_HINT_MODS } from './pearlRules';
import styles from './Pearl.module.css';
import type { DataAttrs } from './valueProps';

export interface PearlProps extends Partial<HintProps>, DataAttrs,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onToggle' | 'children' | 'aria-label' | 'aria-pressed'> {
  /** Lit = this output is heard. */
  lit: boolean;
  /** What the pearl belongs to, for its accessible name ("Insert 2 output"). */
  label: string;
  /** Click: turn on or off. */
  onToggle: () => void;
  /** Right-click, Shift+click or S: solo (or, on the only lit one, everything back on). */
  onSolo: () => void;
}

/**
 * The output pearl (FL Studio style): a lit green bead when the output is heard, a hollow ring when
 * it is not, so state is carried by form as well as colour. Rules: ui-kit/pearl.ts.
 * A real <button aria-pressed>, 24x24 hit area; right-click never reaches the row's own menu.
 */
export const Pearl = forwardRef<HTMLButtonElement, PearlProps>(function Pearl(
  { lit, label, onToggle, onSolo, hint = PEARL_HINT, hintMods = PEARL_HINT_MODS, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={`${styles.pearl}${className ? ` ${className}` : ''}`}
      aria-pressed={lit}
      aria-label={`${label} output`}
      aria-keyshortcuts="S"
      data-lit={lit ? 'true' : 'false'}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        if (e.shiftKey) onSolo(); else onToggle();
      }}
      onContextMenu={(e: MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        e.stopPropagation();
        onSolo();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
        if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          onSolo();
        }
      }}
      {...hintAttrs({ hint, hintMods })}
    >
      <span className={styles.bead} aria-hidden="true" />
    </button>
  );
});

export default Pearl;
