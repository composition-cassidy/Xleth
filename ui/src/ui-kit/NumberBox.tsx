import { useMemo } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { hintAttrs, VALUE_HINT_MODS } from './hint';
import { MOD_HINT_MODS, modAttrs, modRangeNorm, useModRing, type ControlMod } from './modRing';
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
  /** Short visible text in place of `label` ("Cols"); `label` stays the accessible name. */
  caption?: string;
  /** Field height: 'sm' 24px (default), 'md' 28px (matches IconButtons in a toolbar). */
  size?: 'sm' | 'md';
  /**
   * Draw the value-fill rule along the bottom edge. Default true. Pass false where another
   * control already draws the same value as a position (a mixer's volume field above its fader).
   */
  fill?: boolean;
  /** Optional modulation range (see modRing.ts): a band along the top edge. Absent = an ordinary box. */
  mod?: ControlMod | null;
}

/**
 * A value field that is also a horizontal slider: drag sideways (200 px = full
 * range) or type a value. The fill is a 3px rule along the bottom edge in the
 * value colour; the field itself stays neutral. Same gestures as the Knob.
 */
export default function NumberBox(props: NumberBoxProps) {
  const {
    label, value, defaultValue, disabled = false, bipolar = false, centre, width = 72, hideLabel = false, caption, size = 'sm',
    pxPerRange = DEFAULT_NUMBERBOX_PX, hint, hintMods, className, onChange, onCommit, onCancel,
    min, max, scale, unit, formatOptions, format, parse, codec, step, stepNorm, quantize, mod = null, fill = true,
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

  // Modulated range: a 2px band along the TOP edge in the parameter-signal colour
  // (the value keeps the bottom rule). The band itself is the amount handle.
  const ring = useModRing(mod, 'x');
  const routed = !!mod?.active;
  const [modLo, modHi] = routed && mod ? modRangeNorm(resolved.scale, mod.ringLo, mod.ringHi) : [0, 0];
  const onMark = (e: ReactPointerEvent<HTMLElement>): boolean => {
    if (!routed) return false;
    const r = e.currentTarget.getBoundingClientRect();
    return r.height > 0 && e.clientY - r.top <= 6;
  };
  const handlers = mod ? {
    ...drag.handlers,
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => { if (!ring.start(e, onMark(e))) drag.handlers.onPointerDown(e); },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => { if (!ring.move(e)) drag.handlers.onPointerMove(e); },
    onPointerUp: () => { if (!ring.end()) drag.handlers.onPointerUp(); },
    onPointerCancel: () => { if (!ring.cancel()) drag.handlers.onPointerCancel(); },
    onContextMenu: ring.onContextMenu,
  } : drag.handlers;

  return (
    <div
      {...rest}
      ref={drag.ref}
      className={`${styles.box}${className ? ` ${className}` : ''}`}
      style={{
        '--box-w': `${width}px`, '--fill-a': a, '--fill-b': b,
        ...(routed ? { '--mod-a': modLo, '--mod-b': Math.max(modHi, modLo + 0.02) } : null),
      } as CSSProperties}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={aria.min}
      aria-valuemax={aria.max}
      aria-valuenow={aria.now}
      aria-valuetext={`${label}, ${text}`}
      aria-disabled={disabled || undefined}
      data-size={size}
      data-no-label={hideLabel || undefined}
      aria-description={routed ? mod?.tooltip : undefined}
      data-dragging={drag.dragging || ring.dragging}
      data-bipolar={bipolar || undefined}
      data-disabled={disabled || undefined}
      {...modAttrs(mod)}
      {...hintAttrs({
        hint: routed && mod?.tooltip ? mod.tooltip : hint,
        hintMods: routed ? MOD_HINT_MODS : (hintMods ?? VALUE_HINT_MODS),
      })}
      {...handlers}
    >
      {hideLabel ? null : <span className={styles.label}>{caption ?? label}</span>}
      {drag.editing ? (
        <input className={styles.input} aria-label={`${label} value`} {...drag.editorProps} />
      ) : (
        <span className={styles.value}>{text}</span>
      )}
      {fill ? <span className={styles.fill} aria-hidden="true" /> : null}
      {routed ? <span className={styles.mod} aria-hidden="true" data-mod-ring="" /> : null}
    </div>
  );
}
