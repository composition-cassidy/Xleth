import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import SamplePicker from '../../components/SamplePicker/SamplePicker.jsx';
import { useXlethRootContext } from '../contexts/XlethRootContext.jsx';
import styles from './PickerSheet.module.css';

/** The sheet is never shorter than this, so the picker's header, waveform and
 *  controls always fit even when the user has dragged the top row small. */
export const PICKER_SHEET_MIN_HEIGHT = 280;

const TOP_REGION_SELECTOR = '[data-testid="xleth-dock-region-top"]';

/**
 * The sample picker as a sheet over the Preview and Inspector row.
 *
 * It sits at the top of the centre column, as tall as the top dock region (at
 * least PICKER_SHEET_MIN_HEIGHT), so the Browser stays beside it as the source
 * list and the arrangement, the transport and the detail dock stay visible and
 * live underneath. Nothing is hidden or unmounted to make room. Opening moves
 * focus into the sheet; closing returns it to where it was.
 */
export function PickerSheet() {
  const { pickerSource, onClosePicker } = useXlethRootContext() as {
    pickerSource: { id: number | string; name?: string } | null;
    onClosePicker: () => void;
  };
  const sheetRef = useRef<HTMLElement>(null);
  const originRef = useRef<HTMLElement | null>(null);
  const [topHeight, setTopHeight] = useState(0);
  const open = pickerSource != null;

  // Follow the top region's height (a drag on its splitter, a window resize).
  useLayoutEffect(() => {
    if (!open) return undefined;
    const column = sheetRef.current?.parentElement;
    const region = column?.querySelector<HTMLElement>(TOP_REGION_SELECTOR) ?? null;
    if (!region) {
      setTopHeight(0);
      return undefined;
    }
    const measure = () => setTopHeight(Math.round(region.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    return () => observer.disconnect();
  }, [open]);

  // Focus: remember where it was when the sheet opens, give it back on close.
  useEffect(() => {
    if (!open) return undefined;
    const active = document.activeElement;
    originRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    return () => {
      const origin = originRef.current;
      originRef.current = null;
      if (origin && origin.isConnected) origin.focus({ preventScroll: true });
    };
  }, [open]);

  // Move focus into the sheet on open and whenever the source behind it changes.
  const sourceId = pickerSource?.id;
  useEffect(() => {
    if (sourceId == null) return;
    sheetRef.current?.focus({ preventScroll: true });
  }, [sourceId]);

  if (!open) return null;

  const style = { '--picker-sheet-h': `${Math.max(topHeight, PICKER_SHEET_MIN_HEIGHT)}px` } as CSSProperties;
  return (
    <section
      ref={sheetRef}
      className={styles.sheet}
      style={style}
      tabIndex={-1}
      role="region"
      aria-label={`Sample picker: ${pickerSource?.name ?? 'source'}`}
      data-testid="picker-sheet"
    >
      {/* key: a different source remounts the picker, which unloads the old one. */}
      <SamplePicker key={String(sourceId)} source={pickerSource} onClose={onClosePicker} scopeRef={sheetRef} />
    </section>
  );
}

export default PickerSheet;
