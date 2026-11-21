// useValueDrag: the one interaction grammar every kit value control shares
// (ui/DESIGN.md section 7).
//
//   Drag            change value (vertical for knobs, horizontal for number boxes)
//   Shift + drag    fine (x0.1); toggling Shift mid-drag never jumps (rebase rule)
//   Ctrl/Cmd+click  reset to defaultValue
//   Double-click    inline text entry that parses units ("5k", "-6 dB", "1/8D")
//   Wheel           one step (Shift = fine); `wheel: false` leaves it to the container
//   Arrow keys      nudge one step (Shift x10); PageUp/PageDown x10;
//                   Enter or F2 opens the editor
//                   (Home / End are deliberately NOT bound: they are app shortcuts,
//                   and Home = rewind must work while a control has focus.)
//   Escape          cancels a drag back to its start value, or an edit
//
// Callbacks (the kit never touches IPC or the engine):
//   onChange(v)  live, coalesced to at most one call per animation frame
//   onCommit(v)  once per gesture: pointerup after movement, reset, wheel step,
//                key nudge, Enter / blur after typing. This is the undo boundary.
//   onCancel(v)  an Escape-cancelled drag; onChange(start) has already reverted
//                any live preview. Never an undo entry.
//
// `displayValue` is the value to draw: the live drag value while dragging, else
// the controlled `value` prop.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  DEFAULT_FINE,
  DEFAULT_KNOB_PX,
  beginDrag,
  moveDrag,
  stepValue,
  type Axis,
  type DragState,
} from './valueDragCore';
import { clampToScale, scaleBounds, type Scale } from './valueScale';

export interface UseValueDragOptions {
  value: number;
  scale: Scale;
  axis?: Axis;
  /** Pixels for the full sweep; a function is read at pointerdown (fader rail length). */
  pxPerRange?: number | (() => number);
  fine?: number;
  defaultValue?: number;
  step?: number;
  stepNorm?: number;
  quantize?: (value: number) => number;
  disabled?: boolean;
  /** Text the editor opens with; also what the type-in is expected to resemble. */
  format?: (value: number) => string;
  /** null = not a value (the edit is rejected, the old value stays). */
  parse?: (text: string) => number | null;
  /** false: the wheel is not handled (no step, no preventDefault), so it scrolls the container. Default true. */
  wheel?: boolean;
  onChange?: (value: number) => void;
  onCommit?: (value: number) => void;
  onCancel?: (value: number) => void;
}

type WheelHost = HTMLElement & { __kitWheel?: (e: WheelEvent) => void };

function defaultParse(text: string): number | null {
  const t = text.replace(/−/g, '-').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function useValueDrag(options: UseValueDragOptions) {
  const optsRef = useRef(options);
  optsRef.current = options;

  const elRef = useRef<WheelHost | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const pendingRef = useRef<number | null>(null);
  const rafRef = useRef(0);
  const escRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const editingRef = useRef(false);
  const captureRef = useRef<{ el: Element; id: number } | null>(null);

  const [live, setLive] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [editInvalid, setEditInvalid] = useState(false);

  // ── coalesced live change ────────────────────────────────────────────────
  const cancelPending = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    pendingRef.current = null;
  }, []);

  const schedule = useCallback((v: number) => {
    pendingRef.current = v;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const p = pendingRef.current;
      pendingRef.current = null;
      if (p === null || !dragRef.current) return;
      setLive(p);
      optsRef.current.onChange?.(p);
    });
  }, []);

  /** Instant change + commit (reset, wheel, keys, typed value). */
  const applyAndCommit = useCallback((next: number) => {
    const o = optsRef.current;
    cancelPending();
    setLive(null);
    o.onChange?.(next);
    o.onCommit?.(next);
  }, [cancelPending]);

  // ── drag lifecycle ───────────────────────────────────────────────────────
  const stopDrag = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    if (escRef.current) document.removeEventListener('keydown', escRef.current, true);
    escRef.current = null;
    document.body.style.cursor = '';
    const cap = captureRef.current;
    captureRef.current = null;
    if (cap) {
      try { cap.el.releasePointerCapture(cap.id); } catch { /* already released */ }
    }
    setDragging(false);
    return d;
  }, []);

  const endDrag = useCallback(() => {
    const d = stopDrag();
    if (!d) return;
    cancelPending();
    setLive(null);
    if (d.moved) optsRef.current.onCommit?.(d.lastValue);
  }, [stopDrag, cancelPending]);

  const cancelDrag = useCallback(() => {
    const d = stopDrag();
    if (!d) return;
    cancelPending();
    setLive(null);
    if (d.moved) {
      optsRef.current.onChange?.(d.startValue);
      optsRef.current.onCancel?.(d.startValue);
    }
  }, [stopDrag, cancelPending]);

  const dragConfig = useCallback(() => {
    const o = optsRef.current;
    const px = typeof o.pxPerRange === 'function' ? o.pxPerRange() : o.pxPerRange;
    return {
      scale: o.scale,
      axis: o.axis ?? 'y',
      pxPerRange: px && px > 0 ? px : DEFAULT_KNOB_PX,
      fine: o.fine ?? DEFAULT_FINE,
      quantize: o.quantize,
    };
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const o = optsRef.current;
    if (o.disabled || editingRef.current || e.button !== 0) return;
    if ((e.target as HTMLElement).closest?.('input')) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      applyAndCommit(o.defaultValue ?? scaleBounds(o.scale).lo);
      return;
    }
    e.preventDefault(); // no text selection, no native drag
    e.currentTarget.focus({ preventScroll: true });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
      captureRef.current = { el: e.currentTarget, id: e.pointerId };
    } catch { /* jsdom, or the pointer already ended */ }
    const cfg = dragConfig();
    dragRef.current = beginDrag(cfg, o.value, cfg.axis === 'x' ? e.clientX : e.clientY, e.shiftKey);
    document.body.style.cursor = cfg.axis === 'x' ? 'ew-resize' : 'ns-resize';
    // Escape anywhere cancels the drag back to where it started.
    escRef.current = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      cancelDrag();
    };
    document.addEventListener('keydown', escRef.current, true);
    setDragging(true);
  }, [applyAndCommit, cancelDrag, dragConfig]);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const cfg = dragConfig();
    schedule(moveDrag(cfg, d, cfg.axis === 'x' ? e.clientX : e.clientY, e.shiftKey));
  }, [dragConfig, schedule]);

  // ── editor ───────────────────────────────────────────────────────────────
  const beginEdit = useCallback(() => {
    const o = optsRef.current;
    if (o.disabled || editingRef.current) return;
    editingRef.current = true;
    setEditText(o.format ? o.format(o.value) : String(o.value));
    setEditInvalid(false);
    setEditing(true);
  }, []);

  const finishEdit = useCallback((refocus: boolean) => {
    editingRef.current = false;
    setEditing(false);
    setEditInvalid(false);
    if (refocus) elRef.current?.focus({ preventScroll: true });
  }, []);

  const commitEdit = useCallback((text: string, refocus: boolean): boolean => {
    const o = optsRef.current;
    const parsed = (o.parse ?? defaultParse)(text);
    if (parsed === null || Number.isNaN(parsed)) {
      setEditInvalid(true);
      return false;
    }
    let next = clampToScale(o.scale, parsed);
    if (o.quantize) next = clampToScale(o.scale, o.quantize(next));
    finishEdit(refocus);
    if (next !== o.value) applyAndCommit(next);
    return true;
  }, [applyAndCommit, finishEdit]);

  const inputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) { node.focus(); node.select(); }
  }, []);

  const editorProps = {
    ref: inputRef,
    value: editText,
    spellCheck: false,
    autoComplete: 'off',
    'aria-invalid': editInvalid || undefined,
    onChange: (e: { target: { value: string } }) => { setEditText(e.target.value); setEditInvalid(false); },
    onPointerDown: (e: { stopPropagation(): void }) => e.stopPropagation(),
    onDoubleClick: (e: { stopPropagation(): void }) => e.stopPropagation(),
    onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation(); // arrows, Home/End and shortcuts belong to the text field
      if (e.key === 'Enter') { e.preventDefault(); commitEdit(e.currentTarget.value, true); }
      else if (e.key === 'Escape') { e.preventDefault(); finishEdit(true); }
    },
    onBlur: (e: { currentTarget: HTMLInputElement }) => {
      if (!editingRef.current) return;
      // Clicking away commits a valid entry and quietly drops an invalid one.
      if (!commitEdit(e.currentTarget.value, false)) finishEdit(false);
    },
  };

  // ── keyboard ─────────────────────────────────────────────────────────────
  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>) => {
    const o = optsRef.current;
    if (o.disabled || editingRef.current || dragRef.current) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const stepCfg = { scale: o.scale, step: o.step, stepNorm: o.stepNorm, quantize: o.quantize };
    let next: number;
    const mult = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': next = stepValue(stepCfg, o.value, 1, mult); break;
      case 'ArrowDown': case 'ArrowLeft': next = stepValue(stepCfg, o.value, -1, mult); break;
      case 'PageUp': next = stepValue(stepCfg, o.value, 1, 10); break;
      case 'PageDown': next = stepValue(stepCfg, o.value, -1, 10); break;
      case 'Enter': case 'F2': e.preventDefault(); e.stopPropagation(); beginEdit(); return;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (next !== o.value) applyAndCommit(next);
  }, [applyAndCommit, beginEdit]);

  // ── wheel: needs a NON-passive native listener to preventDefault ─────────
  const applyRef = useRef(applyAndCommit);
  applyRef.current = applyAndCommit;
  const wheelRef = useRef((e: WheelEvent) => {
    const o = optsRef.current;
    if (o.wheel === false) return; // the container scrolls
    if (o.disabled || editingRef.current || dragRef.current || e.ctrlKey) return;
    const delta = e.deltaY || e.deltaX; // Shift+wheel arrives as deltaX on Windows
    if (!delta) return;
    e.preventDefault();
    const next = stepValue(
      { scale: o.scale, step: o.step, stepNorm: o.stepNorm, quantize: o.quantize },
      o.value,
      delta < 0 ? 1 : -1,
      e.shiftKey ? (o.fine ?? DEFAULT_FINE) : 1,
    );
    if (next !== o.value) applyRef.current(next);
  });

  const ref = useCallback((node: HTMLElement | null) => {
    const prev = elRef.current;
    if (prev?.__kitWheel) prev.removeEventListener('wheel', prev.__kitWheel);
    elRef.current = node as WheelHost | null;
    if (node) {
      const listener = (e: WheelEvent) => wheelRef.current(e);
      (node as WheelHost).__kitWheel = listener;
      node.addEventListener('wheel', listener, { passive: false });
    }
  }, []);

  useEffect(() => () => {
    cancelPending();
    if (dragRef.current) stopDrag();
  }, [cancelPending, stopDrag]);

  return {
    ref,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: cancelDrag,
      onKeyDown,
      onDoubleClick: beginEdit,
    },
    displayValue: live ?? options.value,
    dragging,
    editing,
    editInvalid,
    editorProps,
    beginEdit,
  };
}
