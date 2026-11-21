// Motion runtime (ui/DESIGN.md section 27). The durations, curves and distances all live in
// ui-kit/motion.css as channel tokens; this file only (1) names the active tier on <html>,
// (2) reads a channel back for the few JS-driven moves, (3) remembers whether the last input
// was the keyboard, and (4) plays exits.
//
// Tier 1 ("flat") is also what you get with no attribute at all: before the setting has loaded,
// in unit tests and in the render harness nothing moves.
//
// Debug logs use the [Motion] prefix.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export type MotionTier = 'flat' | 'smooth' | 'lively';

export const MOTION_TIERS: readonly MotionTier[] = ['flat', 'smooth', 'lively'];
export const MOTION_TIER_ATTR = 'data-motion-tier';

/** A duration channel defined in ui-kit/motion.css. */
export type MotionChannel =
  | '--mo-hover-in' | '--mo-hover-out' | '--mo-state' | '--mo-press'
  | '--mo-popover' | '--mo-context' | '--mo-dialog' | '--mo-toast' | '--mo-page'
  | '--mo-edit' | '--mo-kbd' | '--mo-exit' | '--mo-focus' | '--mo-item' | '--mo-stagger';

export function isMotionTier(value: unknown): value is MotionTier {
  return typeof value === 'string' && (MOTION_TIERS as readonly string[]).includes(value);
}

// ── The active tier ──────────────────────────────────────────────────────────

const tokenCache = new Map<string, string>();
const listeners = new Set<(tier: MotionTier) => void>();

function root(): HTMLElement | null {
  return typeof document !== 'undefined' ? document.documentElement : null;
}

/** The tier in force (what <html> says). No attribute is flat. */
export function currentMotionTier(): MotionTier {
  const value = root()?.getAttribute(MOTION_TIER_ATTR);
  return isMotionTier(value) ? value : 'flat';
}

/** Write the tier in force. Only stores/motionStore.js calls this (and tests, and the gallery). */
export function setRootMotionTier(tier: MotionTier): void {
  const el = root();
  if (!el) return;
  if (el.getAttribute(MOTION_TIER_ATTR) === tier) return;
  el.setAttribute(MOTION_TIER_ATTR, tier);
  tokenCache.clear();
  for (const fn of listeners) fn(tier);
}

export function subscribeMotionTier(fn: (tier: MotionTier) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * True only when <html> SAYS flat (the user chose it, or the system asked for reduced motion).
 * Legacy tweens that predate the tiers use this to stand down; with no attribute at all (unit
 * tests) they keep their old behaviour.
 */
export function motionForcedFlat(): boolean {
  return root()?.getAttribute(MOTION_TIER_ATTR) === 'flat';
}

/** True when anything at all may move (tier 2 or 3). */
export function motionEnabled(): boolean {
  return currentMotionTier() !== 'flat';
}

/** `scrollIntoView` / `scrollTo` behaviour for a programmatic scroll outside playback. */
export function motionScrollBehavior(): ScrollBehavior {
  return motionEnabled() ? 'smooth' : 'auto';
}

// ── Reading a channel back ───────────────────────────────────────────────────

function readToken(name: string): string {
  const cached = tokenCache.get(name);
  if (cached !== undefined) return cached;
  const el = root();
  let value = '';
  if (el && typeof getComputedStyle === 'function') {
    try { value = getComputedStyle(el).getPropertyValue(name).trim(); } catch { value = ''; }
  }
  tokenCache.set(name, value);
  return value;
}

/** Parse a CSS time ("150ms", "0.2s") to milliseconds. Anything else is 0. */
export function parseCssTime(value: string): number {
  const m = /^(-?\d*\.?\d+)(ms|s)$/.exec(value.trim());
  if (!m) return 0;
  const n = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** A duration channel in milliseconds, for the active tier. 0 means "do not animate". */
export function motionMs(channel: MotionChannel): number {
  return parseCssTime(readToken(channel));
}

/** A non-duration token (a curve, a scale) as written, or the fallback. */
export function motionToken(name: string, fallback: string): string {
  return readToken(name) || fallback;
}

// ── Keyboard or pointer? ─────────────────────────────────────────────────────
// A surface opened from the keyboard uses the --mo-kbd channel (0 until tier 3): a shortcut is
// answered at once. Components read this once, when they mount; nothing is written to <html>,
// so a change of input never restyles the document.

let keyboardLast = false;
let anyInput = false;
let inputInstalled = false;
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

function installInputTracking(): void {
  // Some unit tests stub `window` with a bare object.
  if (inputInstalled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  inputInstalled = true;
  // A held modifier is part of a click (Ctrl+click), not a keyboard action.
  window.addEventListener('keydown', (e) => { if (!MODIFIER_KEYS.has(e.key)) { keyboardLast = true; anyInput = true; } }, true);
  window.addEventListener('pointerdown', () => { keyboardLast = false; anyInput = true; }, true);
  window.addEventListener('mousedown', () => { keyboardLast = false; anyInput = true; }, true);
}

installInputTracking();

/** True when the most recent input was a key press (so whatever opens now was opened by it). */
export function lastInputWasKeyboard(): boolean {
  return keyboardLast;
}

/**
 * False until the user has pressed a key or a button in this window. Whatever mounts before
 * that is the app drawing itself (a restored layout, a project opening): it appears fully
 * drawn, in every tier.
 */
export function hadUserInput(): boolean {
  return anyInput;
}

/** Test seam. */
export function __setLastInputWasKeyboard(value: boolean): void {
  keyboardLast = value;
  anyInput = true;
}

/**
 * False while the component renders for the first time, true on every later render. Pass it as
 * a child's `enter` so the child animates when it appears LATER (a body unfolding, a tab's
 * panel) and not when its parent first draws.
 */
export function useAfterMount(): boolean {
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; }, []);
  return mounted.current;
}

// ── Enter: a recipe attribute, fixed at mount ────────────────────────────────

export type MotionRecipe = 'pop' | 'context' | 'dialog' | 'scrim' | 'window' | 'sheet' | 'toast' | 'page' | 'reveal' | 'insert' | 'glyph';

export interface MotionEnterAttrs {
  'data-mo'?: MotionRecipe;
  'data-mo-kbd'?: '';
}

/**
 * The attributes that make an element enter with `recipe`. The decision is made once, when the
 * component mounts, and never changes: adding the attribute to an element that is already on
 * screen would start the animation on it.
 *
 * `enabled = false` (decided at mount) leaves the element alone: use it for "only when added
 * later, not when the whole list first draws".
 */
export function useMotionEnter(recipe: MotionRecipe, enabled = true): MotionEnterAttrs {
  const [attrs] = useState<MotionEnterAttrs>(() => {
    if (!enabled) return {};
    return lastInputWasKeyboard() ? { 'data-mo': recipe, 'data-mo-kbd': '' } : { 'data-mo': recipe };
  });
  return attrs;
}

// ── Exit: the surface that just closed fades where it stood ──────────────────
// Menus, dialogs and popovers are rendered conditionally by their owners, so nothing is kept
// mounted for an exit. Instead, once React has let go of the element, the same DOM node is put
// back for --mo-exit milliseconds, inert, and faded with the Web Animations API. Focus has
// already returned and the surface takes no input, so an exit never delays the next action.

export interface GhostExitOptions {
  /** Selector, inside the element, of the part that scales (a dialog's panel). Default: the element. */
  scaleTarget?: string;
  /** Fade only (an element placed with its own transform, which a scale would move). */
  fadeOnly?: boolean;
  /**
   * The element is in normal flow (a toast in the top bar): pin it at its last position as a
   * fixed-position ghost on <body> instead of re-inserting it where it was.
   */
  pin?: boolean;
  /** Extra travel at the end of the exit, in px (the toast sinks back). */
  shiftY?: number;
  /** Skip the exit (lets a component call the hook unconditionally). */
  disabled?: boolean;
}

const SCROLL_CAPTURE_LIMIT = 4000;

function scrubGhost(el: HTMLElement): void {
  const all = [el, ...Array.from(el.querySelectorAll<HTMLElement>('[id], [role], [data-mo], [tabindex], [data-xleth-menu]'))];
  for (const node of all) {
    node.removeAttribute('id');
    node.removeAttribute('role');
    node.removeAttribute('data-mo');
    node.removeAttribute('data-mo-kbd');
    node.removeAttribute('tabindex');
    node.removeAttribute('data-xleth-menu');
  }
  el.setAttribute('data-mo-ghost', '');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('inert', '');
}

/**
 * Call from a layout-effect CLEANUP, while the element is still in the document. Does nothing
 * when the exit channel is 0 (tiers without exits, tests, the render harness).
 */
export function ghostExit(el: HTMLElement | null | undefined, options: GhostExitOptions = {}): void {
  if (options.disabled || !el || typeof el.animate !== 'function' || !el.isConnected) return;
  const duration = motionMs('--mo-exit');
  if (duration <= 0) return;

  const parent = el.parentNode;
  const next = el.nextSibling;
  const rect = options.pin ? el.getBoundingClientRect() : null;

  // Scroll offsets are lost when a node leaves the document: note the scrolled ones now.
  const scrolled: Array<[HTMLElement, number, number]> = [];
  const candidates = el.getElementsByTagName('*');
  if (candidates.length <= SCROLL_CAPTURE_LIMIT) {
    if (el.scrollTop || el.scrollLeft) scrolled.push([el, el.scrollTop, el.scrollLeft]);
    for (let i = 0; i < candidates.length; i += 1) {
      const node = candidates[i] as HTMLElement;
      if (node.scrollTop || node.scrollLeft) scrolled.push([node, node.scrollTop, node.scrollLeft]);
    }
  }

  queueMicrotask(() => {
    // Still attached: this was not a real unmount (React StrictMode re-runs effects in dev).
    if (el.isConnected) return;
    const host = options.pin ? document.body : parent;
    if (!host || !(host as Node).isConnected) return;

    scrubGhost(el);
    if (rect) {
      el.style.position = 'fixed';
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.top}px`;
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
      el.style.margin = '0';
      el.style.zIndex = '2147483000';
      host.appendChild(el);
    } else {
      host.insertBefore(el, next && next.parentNode === host ? next : null);
    }
    for (const [node, top, left] of scrolled) { node.scrollTop = top; node.scrollLeft = left; }

    const easing = motionToken('--mo-ease-out', 'ease-out');
    const scaleTo = motionToken('--mo-exit-to', '1');
    const target = (options.scaleTarget ? el.querySelector<HTMLElement>(options.scaleTarget) : null) ?? el;
    const timing: KeyframeAnimationOptions = { duration, easing, fill: 'forwards' };

    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      el.remove();
    };
    try {
      const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], timing);
      // Individual transform properties: they compose with the element's own `transform`.
      if (!options.fadeOnly) {
        target.animate([{ scale: '1', translate: '0px 0px' }, { scale: scaleTo, translate: `0px ${options.shiftY ?? 0}px` }], timing);
      }
      fade.finished.then(done, done);
    } catch {
      done();
    }
    // Belt and braces: a throttled background window may never resolve `finished`.
    setTimeout(done, duration + 120);
  });
}

/** Play the exit for `ref`'s element when the component unmounts. */
export function useGhostExit(ref: RefObject<HTMLElement | null>, options?: GhostExitOptions): void {
  // The options are read at unmount; they are literals at every call site.
  useLayoutEffect(() => {
    const el = ref.current;
    return () => ghostExit(el ?? ref.current, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
