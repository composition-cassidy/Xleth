import type { CSSProperties, ReactNode } from 'react';
import SegmentedControl from '../SegmentedControl';
import type { DataAttrs } from '../valueProps';
import styles from './DisplayWell.module.css';

export interface DisplayView<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface DisplayWellProps<T extends string> extends DataAttrs {
  /** Accessible name for the display ("Compressor display"). */
  label: string;
  /** Well width in px. Height fills the device body. */
  width: number;
  /** In-place view switch (activity / curve...). Omit for a single-view display. */
  views?: readonly DisplayView<T>[];
  view?: T;
  onViewChange?: (view: T) => void;
  /** The display itself: an existing canvas component, drawn from real audio. */
  children: ReactNode;
}

/**
 * The device's hero: one recessed g0 well. Displays are real and editable
 * (driven by the engine, draggable where the display supports it). A view
 * switch, when there is one, sits inside the well's corner.
 */
export default function DisplayWell<T extends string>({
  label, width, views, view, onViewChange, children, ...rest
}: DisplayWellProps<T>) {
  return (
    <div
      {...rest}
      className={styles.well}
      style={{ '--well-w': `${width}px` } as CSSProperties}
      role="group"
      aria-label={label}
    >
      <div className={styles.canvas}>{children}</div>
      {views && views.length > 1 && view !== undefined ? (
        <SegmentedControl
          className={styles.views}
          size="sm"
          label={`${label} view`}
          value={view}
          onChange={onViewChange}
          options={views.map((v) => ({ value: v.value, label: v.label, hint: v.hint }))}
        />
      ) : null}
    </div>
  );
}
