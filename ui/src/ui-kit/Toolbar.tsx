import type { HTMLAttributes, ReactNode } from 'react';
import { hintAttrs, type HintProps } from './hint';
import { rovingKeyHandler } from './roving';
import styles from './Toolbar.module.css';
import type { DataAttrs } from './valueProps';

export interface ToolbarProps extends HintProps, DataAttrs, Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'aria-label'> {
  /** Names the toolbar ("Piano roll tools"). */
  label: string;
  children: ReactNode;
  orientation?: 'horizontal' | 'vertical';
}

/**
 * A row (or column) of buttons. Left/Right (Up/Down when vertical) move focus
 * between the enabled buttons, Home/End jump to the ends.
 */
export function Toolbar({ label, children, orientation = 'horizontal', hint, hintMods, className, ...rest }: ToolbarProps) {
  return (
    <div
      {...rest}
      role="toolbar"
      aria-label={label}
      aria-orientation={orientation}
      className={`${styles.toolbar}${className ? ` ${className}` : ''}`}
      data-orientation={orientation}
      {...hintAttrs({ hint, hintMods })}
      onKeyDown={rovingKeyHandler('button:not(:disabled)', orientation)}
    >
      {children}
    </div>
  );
}

export function ToolbarSeparator() {
  return <span className={styles.sep} role="separator" aria-hidden="true" />;
}

export default Toolbar;
