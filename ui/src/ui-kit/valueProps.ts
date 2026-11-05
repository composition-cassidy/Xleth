// Props and helpers shared by every draggable value control (Knob, NumberBox, Fader).

import { formatValue, type FormatOptions, type Unit } from './format';
import type { HintProps } from './hint';
import { parseValue, type Codec } from './parse';
import { FADER_FLOOR_DB, linearScale, scaleBounds, type Scale } from './valueScale';

/** `data-*` attributes pass through to the root element (tests, the gallery, hooks for e2e). */
export type DataAttrs = { [key: `data-${string}`]: string | number | boolean | undefined };

export interface ValueControlProps extends HintProps {
  /** Accessible name, and the visible label on knobs and number boxes. Sentence case. */
  label: string;
  value: number;
  min?: number;
  max?: number;
  /** Overrides min/max with a curve (log, skew, the dB taper). */
  scale?: Scale;
  /** Ctrl+click target. Defaults to the minimum. */
  defaultValue?: number;
  unit?: Unit;
  formatOptions?: FormatOptions;
  /** Overrides unit-based formatting (anything `formatValue` does not cover). */
  format?: (value: number) => string;
  /** Overrides unit-based type-in parsing. Return null for "not a value". */
  parse?: (text: string) => number | null;
  /** Index-valued controls (tempo sync): supplies range, step, format and parse. */
  codec?: Codec;
  step?: number;
  stepNorm?: number;
  quantize?: (value: number) => number;
  disabled?: boolean;
  /** Pixels for the full sweep. Knob 180, number box 200, fader its rail length. */
  pxPerRange?: number;
  /** Live, at most once per animation frame. */
  onChange?: (value: number) => void;
  /** Once per gesture: pointerup, reset, wheel step, key nudge, Enter / blur after typing. The undo boundary. */
  onCommit?: (value: number) => void;
  /** An Escape-cancelled drag (the live preview has already been reverted through onChange). */
  onCancel?: (value: number) => void;
  className?: string;
}

export interface ResolvedValue {
  scale: Scale;
  format: (value: number) => string;
  parse: ((text: string) => number | null) | undefined;
  step: number | undefined;
  quantize: ((value: number) => number) | undefined;
}

export function resolveValue(p: Pick<ValueControlProps, 'min' | 'max' | 'scale' | 'unit' | 'formatOptions' | 'format' | 'parse' | 'codec' | 'step' | 'quantize'>): ResolvedValue {
  const { codec } = p;
  const scale = p.scale ?? linearScale(codec?.min ?? p.min ?? 0, codec?.max ?? p.max ?? 1);
  const format = p.format
    ?? codec?.format
    ?? (p.unit ? (v: number) => formatValue(v, p.unit as Unit, p.formatOptions) : (v: number) => String(v));
  const parse = p.parse ?? codec?.parse ?? (p.unit ? (t: string) => parseValue(t, p.unit as Unit) : undefined);
  const step = p.step ?? codec?.step;
  const quantize = p.quantize ?? (codec ? (v: number) => Math.round(v) : undefined);
  return { scale, format, parse, step, quantize };
}

/** ARIA wants finite numbers; -inf (a fader at the floor) reports the finite floor. */
export function ariaNumbers(scale: Scale, value: number): { min: number; max: number; now: number } {
  const { lo, hi } = scaleBounds(scale);
  const min = Number.isFinite(lo) ? lo : FADER_FLOOR_DB;
  const max = Number.isFinite(hi) ? hi : 0;
  const now = Number.isFinite(value) ? value : min;
  return { min, max, now };
}

/** Bipolar controls fill from their centre: 0 when it is in range, else the middle. */
export function centreNormOf(scale: Scale, centre: number | undefined): number {
  const { lo, hi } = scaleBounds(scale);
  const c = centre ?? (lo < 0 && hi > 0 ? 0 : (lo + hi) / 2);
  return scale.toNorm(c);
}
