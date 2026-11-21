import type { HTMLAttributes, ReactNode } from 'react';
import { hintAttrs, type HintProps } from './hint';
import styles from './Headers.module.css';
import type { DataAttrs } from './valueProps';

export interface PanelHeaderProps extends HintProps, DataAttrs, Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  /** Quiet secondary text after the title (a count, a file name). */
  meta?: ReactNode;
  /** Right-aligned actions (IconButtons, a Select). */
  children?: ReactNode;
}

/** The 28px header of a panel: title left, actions right. Sentence case. */
export function PanelHeader({ title, meta, children, hint, hintMods, className, ...rest }: PanelHeaderProps) {
  return (
    <header {...rest} className={`${styles.panel}${className ? ` ${className}` : ''}`} {...hintAttrs({ hint, hintMods })}>
      <h2 className={styles.title}>{title}</h2>
      {meta ? <span className={styles.meta}>{meta}</span> : null}
      {children ? <div className={styles.actions}>{children}</div> : null}
    </header>
  );
}

export interface SectionHeaderProps extends HintProps, DataAttrs, Omit<HTMLAttributes<HTMLElement>, 'title'> {
  children: ReactNode;
  /** Right-aligned small controls for the section (a mode toggle). */
  actions?: ReactNode;
}

/**
 * A thin strip carrying a section's name, used inside devices (Input, Time,
 * Feedback, Output...). Not interactive itself, so it can be 20px.
 */
export function SectionHeader({ children, actions, hint, hintMods, className, ...rest }: SectionHeaderProps) {
  return (
    <div {...rest} role="heading" aria-level={3} className={`${styles.section}${className ? ` ${className}` : ''}`} {...hintAttrs({ hint, hintMods })}>
      <span className={styles.sectionName}>{children}</span>
      {actions ? <span className={styles.sectionActions}>{actions}</span> : null}
    </div>
  );
}
