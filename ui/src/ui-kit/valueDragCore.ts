// Pure interaction maths for kit controls (no DOM, no React). `useValueDrag`
// wires these to pointer, wheel, keyboard and the inline editor.
//
// Drag law: grab-relative. A drag accumulates pixels in NORMALISED 0..1 space
// over a fixed pixel travel (`pxPerRange`, independent of the parameter's range),
// through the control's scale. Shift = fine (x0.1). The fine flag for a move is
// "shift now OR shift at pointerdown"; whenever it flips the anchor is REBASED
// to where the old sensitivity had got to, so toggling Shift mid-drag never
// makes the value jump.

import { clamp01, clampToScale, scaleBounds, type Scale } from './valueScale';

export type Axis = 'x' | 'y';

export interface DragConfig {
  scale: Scale;
  axis: Axis;
  /** Pixels of travel for the full minimum -> maximum sweep. */
  pxPerRange: number;
  /** Fine multiplier applied while Shift is held. Default 0.1. */
  fine?: number;
  /** Applied to every emitted value (integer parameters, 0.1 dB steps...). */
  quantize?: (value: number) => number;
}

export interface DragState {
  startPos: number;
  startNorm: number;
  startValue: number;
  initialFine: boolean;
  activeFine: boolean;
  moved: boolean;
  lastValue: number;
}

export const DEFAULT_FINE = 0.1;
export const DEFAULT_KNOB_PX = 180;
export const DEFAULT_NUMBERBOX_PX = 200;

/** Vertical drags increase upward (smaller clientY), horizontal drags to the right. */
function directedDelta(axis: Axis, startPos: number, pos: number): number {
  return axis === 'y' ? startPos - pos : pos - startPos;
}

function emit(cfg: DragConfig, norm: number): number {
  const v = cfg.scale.fromNorm(norm);
  return cfg.quantize ? clampToScale(cfg.scale, cfg.quantize(v)) : v;
}

export function beginDrag(cfg: DragConfig, value: number, pos: number, shift: boolean): DragState {
  return {
    startPos: pos,
    startNorm: cfg.scale.toNorm(value),
    startValue: value,
    initialFine: shift,
    activeFine: shift,
    moved: false,
    lastValue: value,
  };
}

/** Advance a drag to `pos`; mutates `state` and returns the new value. */
export function moveDrag(cfg: DragConfig, state: DragState, pos: number, shift: boolean): number {
  const range = cfg.pxPerRange > 0 ? cfg.pxPerRange : 1;
  const fine = cfg.fine ?? DEFAULT_FINE;
  const fineNow = shift || state.initialFine;
  if (fineNow !== state.activeFine) {
    const delta = directedDelta(cfg.axis, state.startPos, pos);
    const oldRatio = state.activeFine ? fine : 1;
    state.startNorm = clamp01(state.startNorm + (delta / range) * oldRatio);
    state.startPos = pos;
    state.activeFine = fineNow;
  }
  const ratio = state.activeFine ? fine : 1;
  const delta = directedDelta(cfg.axis, state.startPos, pos);
  const value = emit(cfg, state.startNorm + (delta / range) * ratio);
  state.moved = true;
  state.lastValue = value;
  return value;
}

// ── Stepping (wheel, arrow keys, Home/End) ──────────────────────────────────

export interface StepConfig {
  scale: Scale;
  /** Step in VALUE units (integers, semitones). Wins over `stepNorm`. */
  step?: number;
  /** Step in normalised space when no value step is given. Default 0.01. */
  stepNorm?: number;
  quantize?: (value: number) => number;
}

export const DEFAULT_STEP_NORM = 0.01;

/**
 * Move `value` by `count` steps (negative = down). `mult` scales one step
 * (Shift+arrow = 10, Shift+wheel = fine 0.1).
 */
export function stepValue(cfg: StepConfig, value: number, count: number, mult = 1): number {
  const { lo, hi } = scaleBounds(cfg.scale);
  let next: number;
  if (cfg.step !== undefined && cfg.step > 0) {
    // A value that is -inf (fader floor) steps up from the lowest finite point.
    const base = Number.isFinite(value) ? value : lo === -Infinity ? cfg.scale.fromNorm(0.0001) : lo;
    next = base + count * cfg.step * mult;
  } else {
    const norm = cfg.scale.toNorm(value) + count * (cfg.stepNorm ?? DEFAULT_STEP_NORM) * mult;
    next = cfg.scale.fromNorm(norm);
  }
  if (cfg.quantize) next = cfg.quantize(next);
  return clampToScale(cfg.scale, next);
}
