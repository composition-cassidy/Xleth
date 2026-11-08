import type { CSSProperties, HTMLAttributes } from 'react';
import styles from './Progress.module.css';
import type { DataAttrs } from './valueProps';

export interface ProgressProps extends DataAttrs, Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** 0 to 1, or null while the amount is unknown. */
  value: number | null;
  /** Accessible name: what is in progress. */
  label: string;
  /** Printed readout. Defaults to the percentage (or nothing while unknown). */
  text?: string;
}

/** A progress rail with a printed readout. */
export function Progress({ value, label, text, className, ...rest }: ProgressProps) {
  const known = value !== null && Number.isFinite(value);
  const clamped = known ? Math.min(1, Math.max(0, value as number)) : 0;
  const shown = text ?? (known ? `${Math.round(clamped * 100)} %` : '');
  return (
    <div {...rest} className={`${styles.wrap}${className ? ` ${className}` : ''}`}>
      <div
        className={styles.rail}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(clamped * 100) : undefined}
        aria-valuetext={shown || undefined}
        data-indeterminate={known ? undefined : ''}
        style={known ? ({ '--progress': clamped } as CSSProperties) : undefined}
      >
        <span className={styles.fill} />
      </div>
      {shown ? <span className={styles.text}>{shown}</span> : null}
    </div>
  );
}

export default Progress;
