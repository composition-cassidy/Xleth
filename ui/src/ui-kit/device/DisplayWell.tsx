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
  /**
   * Where the view switch sits. 'corner' (default) floats it over the display's top-right;
   * 'header' gives it its own strip above the display, so it never covers the drawing.
   */
  viewsPlacement?: 'corner' | 'header';
  /** The display itself: an existing canvas component, drawn from real audio. */
  children: ReactNode;
}

/**
 * The device's hero: one recessed g0 well. Displays are real and editable
 * (driven by the engine, draggable where the display supports it). A view
 * switch, when there is one, sits inside the well's corner.
 */
export default function DisplayWell<T extends string>({
  label, width, views, view, onViewChange, viewsPlacement = 'corner', children, ...rest
}: DisplayWellProps<T>) {
  const hasViews = Boolean(views && views.length > 1 && view !== undefined);
  const header = hasViews && viewsPlacement === 'header';
  return (
    <div
      {...rest}
      className={header ? `${styles.well} ${styles.withHeader}` : styles.well}
      style={{ '--well-w': `${width}px` } as CSSProperties}
      role="group"
      aria-label={label}
    >
      <div className={styles.canvas}>{children}</div>
      {hasViews && views && view !== undefined ? (
        <div className={header ? styles.header : styles.corner}>
          <SegmentedControl
            size="sm"
            label={`${label} view`}
            value={view}
            onChange={onViewChange}
            options={views.map((v) => ({ value: v.value, label: v.label, hint: v.hint }))}
          />
        </div>
      ) : null}
    </div>
  );
}
