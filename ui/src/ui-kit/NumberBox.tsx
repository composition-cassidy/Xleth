import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { hintAttrs, VALUE_HINT_MODS } from './hint';
import styles from './NumberBox.module.css';
import { useValueDrag } from './useValueDrag';
import { DEFAULT_NUMBERBOX_PX } from './valueDragCore';
import { ariaNumbers, centreNormOf, resolveValue, type DataAttrs, type ValueControlProps } from './valueProps';

export interface NumberBoxProps extends ValueControlProps, DataAttrs {
  bipolar?: boolean;
  centre?: number;
  /** Field width in px. Default 72. */
  width?: number;
  /** Hide the visible label (it stays the accessible name). */
  hideLabel?: boolean;
}

/**
 * A value field that is also a horizontal slider: drag sideways (200 px = full
 * range) or type a value. The fill is a 3px rule along the bottom edge in the
 * value colour; the field itself stays neutral. Same gestures as the Knob.
 */
export default function NumberBox(props: NumberBoxProps) {
  const {
    label, value, defaultValue, disabled = false, bipolar = false, centre, width = 72, hideLabel = false,
    pxPerRange = DEFAULT_NUMBERBOX_PX, hint, hintMods, className, onChange, onCommit, onCancel,
    min, max, scale, unit, formatOptions, format, parse, codec, step, stepNorm, quantize,
    ...rest
  } = props;
  const resolved = useMemo(
    () => resolveValue({ min, max, scale, unit, formatOptions, format, parse, codec, step, quantize }),
    [min, max, scale, unit, formatOptions, format, parse, codec, step, quantize],
  );
  const drag = useValueDrag({
    value,
    scale: resolved.scale,
    axis: 'x',
    pxPerRange,
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
  const centreNorm = bipolar ? centreNormOf(resolved.scale, centre) : 0;
  const a = Math.min(norm, centreNorm);
  const b = Math.max(norm, centreNorm);
  const aria = ariaNumbers(resolved.scale, shown);

  return (
    <div
      {...rest}
      ref={drag.ref}
      className={`${styles.box}${className ? ` ${className}` : ''}`}
      style={{ '--box-w': `${width}px`, '--fill-a': a, '--fill-b': b } as CSSProperties}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={aria.min}
      aria-valuemax={aria.max}
      aria-valuenow={aria.now}
      aria-valuetext={`${label}, ${text}`}
      aria-disabled={disabled || undefined}
      data-dragging={drag.dragging}
      data-bipolar={bipolar || undefined}
      data-disabled={disabled || undefined}
      {...hintAttrs({ hint, hintMods: hintMods ?? VALUE_HINT_MODS })}
      {...drag.handlers}
    >
      {hideLabel ? null : <span className={styles.label}>{label}</span>}
      {drag.editing ? (
        <input className={styles.input} aria-label={`${label} value`} {...drag.editorProps} />
      ) : (
        <span className={styles.value}>{text}</span>
      )}
      <span className={styles.fill} aria-hidden="true" />
    </div>
  );
}
