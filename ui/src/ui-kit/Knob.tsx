import { useMemo, useRef } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { ARC_START_DEG, ARC_SWEEP_DEG, arcPath, knobGeometry } from './arc';
import { hintAttrs, VALUE_HINT_MODS } from './hint';
import styles from './Knob.module.css';
import { MOD_HINT_MODS, modAttrs, modRangeNorm, useModRing, type ControlMod } from './modRing';
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
  /**
   * Do not print the label (it stays the accessible name and the value text). For a row of
   * identical knobs whose label is printed once beside the row (the mixer's Pan and Width).
   * The value under the dial always stays.
   */
  hideLabel?: boolean;
  /** Optional modulation ring (see modRing.ts). Absent = an ordinary knob. */
  mod?: ControlMod | null;
  /** Right-click, for hosts that add a menu (automation). Ignored while `mod` owns right-click. */
  onContextMenu?: (e: ReactMouseEvent<HTMLElement>) => void;
}

/** Smallest visible sweep for a routed knob at amount 0, so "routed" never draws as nothing. */
const MIN_MOD_SWEEP_DEG = 8;

/**
 * Label above, arc + pointer, value with unit below. Flat: no glow, no shadow.
 * Drag vertically (180 px = full range), Shift = fine, Ctrl+click = reset,
 * double-click = type, wheel = step, arrows = nudge (ui/DESIGN.md section 7).
 */
export default function Knob(props: KnobProps) {
  const {
    label, value, defaultValue, disabled = false, bipolar = false, centre, size = 32, width = 56, hideLabel = false,
    pxPerRange = DEFAULT_KNOB_PX, hint, hintMods, className, onChange, onCommit, onCancel,
    min, max, scale, unit, formatOptions, format, parse, codec, step, stepNorm, quantize, mod = null,
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

  const ring = useModRing(mod, 'y');
  const dialRef = useRef<SVGSVGElement | null>(null);

  const shown = drag.displayValue;
  const text = resolved.format(shown);
  const norm = resolved.scale.toNorm(shown);
  const geo = knobGeometry(norm, bipolar ? centreNormOf(resolved.scale, centre) : null, size);
  const aria = ariaNumbers(resolved.scale, shown);

  // The modulated range is a second arc INSIDE the value arc, drawn in the same SVG
  // (never a DOM overlay), in the parameter-signal colour.
  const ringR = size / 2 - 9;
  let modPath = '';
  if (mod?.active) {
    const [lo, hi] = modRangeNorm(resolved.scale, mod.ringLo, mod.ringHi);
    let a = ARC_START_DEG + lo * ARC_SWEEP_DEG;
    let b = ARC_START_DEG + hi * ARC_SWEEP_DEG;
    if (b - a < MIN_MOD_SWEEP_DEG) {
      const mid = (a + b) / 2;
      a = Math.max(ARC_START_DEG, mid - MIN_MOD_SWEEP_DEG / 2);
      b = Math.min(ARC_START_DEG + ARC_SWEEP_DEG, a + MIN_MOD_SWEEP_DEG);
    }
    modPath = arcPath(size / 2, size / 2, ringR, a, b);
  }

  // The inner ring is the amount handle: a press inside the dial's inner disc.
  const onMark = (e: ReactPointerEvent<HTMLElement>): boolean => {
    const svg = dialRef.current;
    if (!svg || !mod?.active) return false;
    const r = svg.getBoundingClientRect();
    if (!r.width) return false;
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    return Math.hypot(dx, dy) <= ringR + 3;
  };
  const handlers = mod ? {
    ...drag.handlers,
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => { if (!ring.start(e, onMark(e))) drag.handlers.onPointerDown(e); },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => { if (!ring.move(e)) drag.handlers.onPointerMove(e); },
    onPointerUp: () => { if (!ring.end()) drag.handlers.onPointerUp(); },
    onPointerCancel: () => { if (!ring.cancel()) drag.handlers.onPointerCancel(); },
    onContextMenu: ring.onContextMenu,
  } : drag.handlers;
  const routed = !!mod?.active;

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
      aria-description={routed ? mod?.tooltip : undefined}
      data-dragging={drag.dragging || ring.dragging}
      data-bipolar={bipolar || undefined}
      data-disabled={disabled || undefined}
      data-no-label={hideLabel || undefined}
      {...modAttrs(mod)}
      {...hintAttrs({
        hint: routed && mod?.tooltip ? mod.tooltip : hint,
        hintMods: routed ? MOD_HINT_MODS : (hintMods ?? VALUE_HINT_MODS),
      })}
      {...handlers}
    >
      {hideLabel ? null : <span className={styles.label}>{label}</span>}
      <svg ref={dialRef} className={styles.dial} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        <path className={styles.track} d={geo.track} />
        {geo.value ? <path className={styles.arc} d={geo.value} /> : null}
        {geo.zero ? <line className={styles.zero} {...geo.zero} /> : null}
        <line className={styles.pointer} {...geo.pointer} />
        {modPath ? <path className={styles.mod} d={modPath} data-mod-ring="" /> : null}
      </svg>
      {drag.editing ? (
        <input className={styles.input} aria-label={`${label} value`} {...drag.editorProps} />
      ) : (
        <span className={styles.value}>{text}</span>
      )}
    </div>
  );
}
