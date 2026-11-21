import type { CSSProperties, ReactNode } from 'react';
import { IconButton } from '../Button';
import { SectionHeader } from '../Headers';
import type { DataAttrs } from '../valueProps';
import styles from './DeviceSection.module.css';
import { iconComponent } from '../icons';

const IcCaretLeft = iconComponent('caret-left');
const IcCaretRight = iconComponent('caret-right');

export interface DeviceSectionProps extends DataAttrs {
  /** Section name, sentence case ("Detection", "Time", "Output"). */
  title: string;
  /** Content width in px (the header strip spans it). */
  width?: number;
  /** Right-aligned header controls. */
  actions?: ReactNode;
  /** When set, the section can fold to a vertical strip (a sidechain, an advanced block). */
  folded?: boolean;
  onFoldChange?: (folded: boolean) => void;
  children?: ReactNode;
  className?: string;
}

/**
 * One block of a device body: a SectionHeader strip over its controls. Sections
 * sit left to right in signal order, separated by a divider.
 */
export default function DeviceSection({
  title, width, actions, folded = false, onFoldChange, children, className, ...rest
}: DeviceSectionProps) {
  const foldButton = onFoldChange ? (
    <IconButton
      size="sm"
      className={styles.fold}
      label={folded ? `Show ${title}` : `Fold ${title}`}
      aria-expanded={!folded}
      onClick={() => onFoldChange(!folded)}
    >
      {folded ? <IcCaretRight aria-hidden="true" /> : <IcCaretLeft aria-hidden="true" />}
    </IconButton>
  ) : null;

  if (folded) {
    return (
      <div {...rest} className={`${styles.section} ${styles.folded}${className ? ` ${className}` : ''}`} data-folded="true">
        {foldButton}
        <span className={styles.foldedName} role="heading" aria-level={3}>{title}</span>
      </div>
    );
  }

  return (
    <div
      {...rest}
      className={`${styles.section}${className ? ` ${className}` : ''}`}
      style={width ? ({ '--section-w': `${width}px` } as CSSProperties) : undefined}
    >
      <SectionHeader
        className={styles.header}
        actions={foldButton || actions ? <>{actions}{foldButton}</> : undefined}
      >
        {title}
      </SectionHeader>
      <div className={styles.content}>{children}</div>
    </div>
  );
}
