// Device-pixel-ratio tracking for canvases (Phase 7).
//
// The UI scale is the Electron window zoom factor, which Chromium reports as a change in
// `window.devicePixelRatio` (zoom 150 % on a 1.25x display is a DPR of 1.875). A canvas
// that sized its backing store as `cssSize * devicePixelRatio` once, at mount, is then
// blurry until something else happens to redraw it. This module is the one place that
// notices the change:
//
//   useDprEpoch()   a number that increments whenever the DPR changes. Put it in the
//                   dependency array of the effect that sizes and draws the canvas.
//   subscribeDpr()  the same signal for non-React code (a draw loop, a renderer class).
//   backingSize()   the pixel size a canvas of `cssPx` needs at the current DPR.
//
// `matchMedia('(resolution: Ndppx)')` fires exactly when the DPR leaves N, and has to be
// re-armed for the new value each time. Debug logs use the [Theme] prefix.

import { useSyncExternalStore } from 'react';

type Listener = (dpr: number) => void;

const listeners = new Set<Listener>();
let epoch = 0;
let current = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
let teardown: (() => void) | null = null;

/** The current device pixel ratio (never below 1). */
export function getDpr(): number {
  return Math.max(1, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
}

/** Pixel size of the backing store for a canvas that is `cssPx` CSS pixels wide or tall. */
export function backingSize(cssPx: number, dpr: number = getDpr()): number {
  return Math.max(1, Math.round(cssPx * dpr));
}

function arm(): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  teardown?.();
  const mq = window.matchMedia(`(resolution: ${current}dppx)`);
  const onChange = () => {
    const next = window.devicePixelRatio || 1;
    if (next === current) { arm(); return; }
    current = next;
    epoch += 1;
    console.debug(`[Theme] devicePixelRatio -> ${next} (epoch ${epoch}, ${listeners.size} listeners)`);
    listeners.forEach((fn) => fn(next));
    arm();
  };
  mq.addEventListener('change', onChange);
  teardown = () => mq.removeEventListener('change', onChange);
}

/** Subscribe to DPR changes. Returns the unsubscribe function. */
export function subscribeDpr(fn: Listener): () => void {
  if (listeners.size === 0) { current = window.devicePixelRatio || 1; arm(); }
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) { teardown?.(); teardown = null; }
  };
}

const subscribeEpoch = (onStoreChange: () => void) => subscribeDpr(() => onStoreChange());
const getEpoch = () => epoch;

/** Increments when the DPR changes; use it as an effect dependency so the canvas re-sizes and redraws. */
export function useDprEpoch(): number {
  return useSyncExternalStore(subscribeEpoch, getEpoch, getEpoch);
}
