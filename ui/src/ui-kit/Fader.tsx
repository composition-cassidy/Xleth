import { useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { hintAttrs, VALUE_HINT_MODS } from './hint';
import styles from './Fader.module.css';
import { useValueDrag } from './useValueDrag';
import { ariaNumbers, resolveValue, type DataAttrs, type ValueControlProps } from './valueProps';
import { dbTaperScale } from './valueScale';

export interface FaderProps extends Omit<ValueControlProps, 'pxPerRange'>, DataAttrs {
  /** Cell width in px. Default 28 (hit area is the whole rail column). */
  width?: number;
}

/**
 * Vertical fader. Defaults to the mixer's dB taper (-inf .. +12 dB, 0 dB at 75%
 * travel). The drag range is the rail's own length, so the cap tracks the pointer
 * 1:1 (Shift = fine). The numeric field lives above it: use `FaderMeter`, or pair
 * with a `NumberBox` on the same value.
 */
export default function Fader(props: FaderProps) {
  const {
    label, value, defaultValue = 0, disabled = false, width = 28, hint, hintMods, className,
    onChange, onCommit, onCancel,
    min, max, scale = dbTaperScale, unit = 'dB', formatOptions, format, parse, codec, step, stepNorm, quantize,
    ...rest
  } = props;
  const railRef = useRef<HTMLDivElement | null>(null);
  const capRef = useRef<HTMLSpanElement | null>(null);
  const resolved = useMemo(
    () => resolveValue({ min, max, scale, unit, formatOptions, format, parse, codec, step, quantize }),
    [min, max, scale, unit, formatOptions, format, parse, codec, step, quantize],
  );
  const drag = useValueDrag({
    value,
    scale: resolved.scale,
    axis: 'y',
    // Cap travel: the rail minus the cap's own height.
    pxPerRange: () => {
      const travel = (railRef.current?.clientHeight ?? 0) - (capRef.current?.offsetHeight ?? 0);
      return travel > 1 ? travel : 160; // not laid out (tests): a sane default
    },
    defaultValue,
    step: resolved.step,
    stepNorm,
    quantize: resolved.quantize,
    disabled,
    format: resolved.format,
    parse: resolved.parse,
    onChange,
    onCommit,
    onCancel,
  });

  const shown = drag.displayValue;
  const text = resolved.format(shown);
  const norm = resolved.scale.toNorm(shown);
  const aria = ariaNumbers(resolved.scale, shown);

  return (
    <div
      {...rest}
      ref={drag.ref}
      className={`${styles.fader}${className ? ` ${className}` : ''}`}
      style={{ '--fader-w': `${width}px`, '--norm': norm } as CSSProperties}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={aria.min}
      aria-valuemax={aria.max}
      aria-valuenow={aria.now}
      aria-valuetext={`${label}, ${text}`}
      aria-disabled={disabled || undefined}
      data-dragging={drag.dragging}
      data-disabled={disabled || undefined}
      {...hintAttrs({ hint, hintMods: hintMods ?? VALUE_HINT_MODS })}
      {...drag.handlers}
    >
      <div ref={railRef} className={styles.rail}>
        <span className={styles.groove} aria-hidden="true" />
        <span ref={capRef} className={styles.cap} aria-hidden="true" />
      </div>
    </div>
  );
}
