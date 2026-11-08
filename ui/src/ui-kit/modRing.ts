// Modulation ring support for kit value controls (Knob, NumberBox).
//
// A control that can RECEIVE modulation is handed one optional `mod` object. Absent
// (every control outside the sampler) means nothing here runs: no extra drawing, no
// extra hit-testing, no extra attributes. The kit never calls IPC; the callbacks are
// the caller's (the sampler wires them to its modulation store).
//
//   dropProps        spread on the control's root so a source drag can find it
//   active           a route drives this control: draw the modulated range
//   highlight        a source is being dragged over this control: outline it
//   amount           the route amount, -1..+1 (where an amount drag starts)
//   ringLo / ringHi  the modulated range, already in the control's own units
//   tooltip          "LFO 1 → Slot 2 fine: ±12 ct · …" (becomes the hint text)
//   onRingPreview    every amount-drag frame, local only
//   onRingCommit     once, on release (the undo boundary)
//   onToggleBipolar  right-click
//
// Gestures, identical on both controls: drag the modulation mark (the Knob's inner
// ring) or Alt+drag anywhere on the cell = amount (180 px for the full -1..+1 swing,
// Shift = fine, Escape cancels), right-click = toggle bipolar. The amount also has a
// typed alternative in the sampler's route list.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { clampToScale, type Scale } from './valueScale';

export interface ControlMod {
  dropProps?: Record<string, string>;
  active: boolean;
  highlight?: boolean;
  amount: number;
  bipolar?: boolean;
  ringLo: number;
  ringHi: number;
  tooltip?: string;
  onRingPreview?: (amount: number) => void;
  onRingCommit?: (amount: number) => void;
  onToggleBipolar?: () => void;
}

/** Pixels of travel for one unit of amount (the old sampler ring's law). */
export const MOD_AMOUNT_PX = 180;
export const MOD_FINE = 0.1;
export const MOD_HINT_MODS = 'Drag the modulation mark or Alt+drag: amount · Shift: fine · Right-click: bipolar · Ctrl+click: reset';

export const clampAmount = (a: number): number => (a < -1 ? -1 : a > 1 ? 1 : a);

/** Amount after `deltaPx` of travel (positive = up for a knob, right for a box). */
export function stepAmount(amount: number, deltaPx: number, fine: boolean): number {
  return clampAmount(amount + (deltaPx / MOD_AMOUNT_PX) * (fine ? MOD_FINE : 1));
}

/** The modulated range as normalised [lo, hi] on the control's own scale. */
export function modRangeNorm(scale: Scale, lo: number, hi: number): [number, number] {
  const a = scale.toNorm(clampToScale(scale, Math.min(lo, hi)));
  const b = scale.toNorm(clampToScale(scale, Math.max(lo, hi)));
  return [Math.max(0, Math.min(1, a)), Math.max(0, Math.min(1, b))];
}

/** Root-element attributes for a modulation-aware control (empty when `mod` is absent). */
export function modAttrs(mod: ControlMod | null | undefined): Record<string, string | boolean | undefined> {
  if (!mod) return {};
  return {
    ...(mod.dropProps || {}),
    'data-modulated': mod.active || undefined,
    'data-mod-highlight': mod.highlight || undefined,
  };
}

interface RingDrag { startAmount: number; amount: number; last: number; id: number; el: Element }

/**
 * The amount drag. `start` returns true when it took the pointer, so the control's
 * own value drag must not run.
 */
export function useModRing(mod: ControlMod | null | undefined, axis: 'x' | 'y') {
  const modRef = useRef(mod);
  modRef.current = mod;
  const dragRef = useRef<RingDrag | null>(null);
  const escRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const [dragging, setDragging] = useState(false);

  const pos = (e: { clientX: number; clientY: number }) => (axis === 'x' ? e.clientX : -e.clientY);

  const stop = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    if (escRef.current) document.removeEventListener('keydown', escRef.current, true);
    escRef.current = null;
    if (d) {
      try { d.el.releasePointerCapture(d.id); } catch { /* already released */ }
    }
    setDragging(false);
    return d;
  }, []);

  const start = useCallback((e: ReactPointerEvent<HTMLElement>, onMark: boolean): boolean => {
    const m = modRef.current;
    if (!m?.active || e.button !== 0 || e.ctrlKey || e.metaKey) return false;
    if (!e.altKey && !onMark) return false;
    e.preventDefault();
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom */ }
    const a = Number(m.amount) || 0;
    dragRef.current = { startAmount: a, amount: a, last: pos(e), id: e.pointerId, el: e.currentTarget };
    escRef.current = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      const d = stop();
      if (d && d.amount !== d.startAmount) modRef.current?.onRingPreview?.(d.startAmount);
    };
    document.addEventListener('keydown', escRef.current, true);
    setDragging(true);
    return true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop, axis]);

  const move = useCallback((e: ReactPointerEvent<HTMLElement>): boolean => {
    const d = dragRef.current;
    if (!d) return false;
    const p = pos(e);
    const next = stepAmount(d.amount, p - d.last, e.shiftKey);
    d.last = p;
    if (next !== d.amount) {
      d.amount = next;
      modRef.current?.onRingPreview?.(next);
    }
    return true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axis]);

  const end = useCallback((): boolean => {
    const d = stop();
    if (!d) return false;
    if (d.amount !== d.startAmount) modRef.current?.onRingCommit?.(d.amount);
    return true;
  }, [stop]);

  const cancel = useCallback((): boolean => {
    const d = stop();
    if (!d) return false;
    if (d.amount !== d.startAmount) modRef.current?.onRingPreview?.(d.startAmount);
    return true;
  }, [stop]);

  const onContextMenu = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    const m = modRef.current;
    if (!m?.active) return;
    e.preventDefault();
    e.stopPropagation();
    m.onToggleBipolar?.();
  }, []);

  useEffect(() => () => { stop(); }, [stop]);

  return { start, move, end, cancel, onContextMenu, dragging };
}
