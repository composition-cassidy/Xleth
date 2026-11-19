import { useMemo, useRef } from 'react';
import type { CSSProperties } from 'react';
import { hintAttrs, valueHintMods } from './hint';
import styles from './Slider.module.css';
import { useValueDrag } from './useValueDrag';
import { ariaNumbers, centreNormOf, resolveValue, type DataAttrs, type ValueControlProps } from './valueProps';

export interface SliderProps extends Omit<ValueControlProps, 'pxPerRange'>, DataAttrs {
  /** Cell width in px. Omit to fill the parent's width. */
  width?: number;
  /** Fills from the centre (pan) instead of from the minimum, and marks the centre with a notch. */
  bipolar?: boolean;
  /** Value at the centre of a bipolar slider. Default 0 when the range spans 0. */
  centre?: number;
  /**
   * How hard the slider is to pull, as a multiple of its own travel: 1 = the cap tracks the
   * pointer 1:1, 1.5 = the pointer has to cover one and a half rails to sweep the whole range.
   * Shift still takes the fine x0.1 on top. Default 1.
   */
  weight?: number;
}

/**
 * Horizontal slider: a thin groove and a flat bracket cap, the Fader turned on its side. The drag
 * range is the rail's own length times `weight` (Shift = fine), the same grammar as every kit
 * value control: Ctrl/Cmd+click resets, double-click types a value, wheel and arrows step.
 */
export default function Slider(props: SliderProps) {
  const {
    label, value, defaultValue, disabled = false, width, hint, hintMods, className, bipolar = false, centre, weight = 1,
    onChange, onCommit, onCancel,
    min, max, scale, unit, formatOptions, format, parse, codec, step, stepNorm, quantize,
    wheel = true,
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
    axis: 'x',
    // Cap travel (the rail minus the cap's own width), stretched by the weight.
    pxPerRange: () => {
      const travel = (railRef.current?.clientWidth ?? 0) - (capRef.current?.offsetWidth ?? 0);
      return (travel > 1 ? travel : 60) * Math.max(weight, 0.1); // not laid out (tests): a sane default
    },
    defaultValue,
    step: resolved.step,
    stepNorm,
    quantize: resolved.quantize,
    disabled,
    format: resolved.format,
    parse: resolved.parse,
    wheel,
    onChange,
    onCommit,
    onCancel,
  });

  const shown = drag.displayValue;
  const text = resolved.format(shown);
  const norm = resolved.scale.toNorm(shown);
  const centreNorm = bipolar ? centreNormOf(resolved.scale, centre) : null;
  const aria = ariaNumbers(resolved.scale, shown);

  return (
    <div
      {...rest}
      ref={drag.ref}
      className={`${styles.slider}${className ? ` ${className}` : ''}`}
      style={{ '--slider-w': width != null ? `${width}px` : undefined, '--norm': norm, '--centre': centreNorm ?? 0 } as CSSProperties}
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
      {...hintAttrs({ hint, hintMods: hintMods ?? valueHintMods(wheel) })}
      {...drag.handlers}
    >
      <div ref={railRef} className={styles.rail}>
        <span className={styles.groove} aria-hidden="true" />
        {bipolar ? <span className={styles.notch} aria-hidden="true" /> : null}
        <span ref={capRef} className={styles.cap} aria-hidden="true" />
      </div>
      {drag.editing ? <input className={styles.input} aria-label={`${label} value`} {...drag.editorProps} /> : null}
    </div>
  );
}
