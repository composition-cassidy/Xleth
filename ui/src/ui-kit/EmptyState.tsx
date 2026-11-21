import type { HTMLAttributes, ReactNode } from 'react';
import { Button } from './Button';
import { hintAttrs, type HintProps } from './hint';
import styles from './EmptyState.module.css';
import type { DataAttrs } from './valueProps';

export interface EmptyStateProps extends HintProps, DataAttrs, Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Direct copy: "No tracks. Add a clip track or a pattern track." */
  message: ReactNode;
  /** The one inline action. */
  actionLabel?: string;
  onAction?: () => void;
  children?: ReactNode;
}

/**
 * Structural, not a poster: it sits inside the real layout of its region (the
 * first row of a list, the top of a lane), left aligned at the region's own
 * padding, with at most one inline action. No icon in a void, no illustration.
 */
export default function EmptyState({ message, actionLabel, onAction, children, hint, hintMods, className, ...rest }: EmptyStateProps) {
  return (
    <div {...rest} className={`${styles.empty}${className ? ` ${className}` : ''}`} {...hintAttrs({ hint, hintMods })}>
      <span className={styles.message}>{message}</span>
      {actionLabel ? <Button size="sm" onClick={onAction}>{actionLabel}</Button> : null}
      {children}
    </div>
  );
}
