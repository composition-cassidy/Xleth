import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { knobGeometry } from './arc';
import { hintAttrs, VALUE_HINT_MODS } from './hint';
import styles from './Knob.module.css';
import { useValueDrag } from './useValueDrag';
import { DEFAULT_KNOB_PX } from './valueDragCore';
import { ariaNumbers, centreNormOf, resolveValue, type DataAttrs, type ValueControlProps } from './valueProps';

export interface KnobProps extends ValueControlProps, DataAttrs {
  /** Fills from the centre (pan, gain trim, detune) instead of from the minimum. */
  bipolar?: boolean;
  /** Value at the centre of a bipolar knob. Default 0 when the range spans 0. */
  centre?: number;
  /** Diameter of the dial in px. Default 32. The whole cell, label included, is the drag target. */
  size?: number;
  /** Cell width in px. Default 56. Long labels truncate with an ellipsis. */
  width?: number;
}

/**
 * Label above, arc + pointer, value with unit below. Flat: no glow, no shadow.
 * Drag vertically (180 px = full range), Shift = fine, Ctrl+click = reset,
 * double-click = type, wheel = step, arrows = nudge (ui/DESIGN.md section 7).
 */
export default function Knob(props: KnobProps) {
  const {
    label, value, defaultValue, disabled = false, bipolar = false, centre, size = 32, width = 56,
    pxPerRange = DEFAULT_KNOB_PX, hint, hintMods, className, onChange, onCommit, onCancel,
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
    axis: 'y',
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
  const geo = knobGeometry(norm, bipolar ? centreNormOf(resolved.scale, centre) : null, size);
  const aria = ariaNumbers(resolved.scale, shown);

  return (
    <div
      {...rest}
      ref={drag.ref}
      className={`${styles.cell}${className ? ` ${className}` : ''}`}
      style={{ '--knob-w': `${width}px` } as CSSProperties}
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
      data-bipolar={bipolar || undefined}
      data-disabled={disabled || undefined}
      {...hintAttrs({ hint, hintMods: hintMods ?? VALUE_HINT_MODS })}
      {...drag.handlers}
    >
      <span className={styles.label}>{label}</span>
      <svg className={styles.dial} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        <path className={styles.track} d={geo.track} />
        {geo.value ? <path className={styles.arc} d={geo.value} /> : null}
        {geo.zero ? <line className={styles.zero} {...geo.zero} /> : null}
        <line className={styles.pointer} {...geo.pointer} />
      </svg>
      {drag.editing ? (
        <input className={styles.input} aria-label={`${label} value`} {...drag.editorProps} />
      ) : (
        <span className={styles.value}>{text}</span>
      )}
    </div>
  );
}
