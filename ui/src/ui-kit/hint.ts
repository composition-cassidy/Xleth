// Hint plumbing: every kit control takes `hint` / `hintMods` and renders them as
// `data-hint` / `data-hint-mods`, which the hint bar reads (components/HintBar).
export interface HintProps {
  /** What the control is and does; shown in the hint bar on hover. */
  hint?: string;
  /** Modifier help shown on the right of the hint bar ("Shift: fine · Ctrl+click: reset"). */
  hintMods?: string;
}

export function hintAttrs({ hint, hintMods }: HintProps): { 'data-hint'?: string; 'data-hint-mods'?: string } {
  const out: { 'data-hint'?: string; 'data-hint-mods'?: string } = {};
  if (hint) out['data-hint'] = hint;
  if (hintMods) out['data-hint-mods'] = hintMods;
  return out;
}

/** The modifier help every draggable value control shares (DESIGN.md section 7). */
export const VALUE_HINT_MODS = 'Drag: change · Shift: fine · Ctrl+click: reset · Double-click: type · Wheel: step';

/** The same help for a control whose wheel is left to its scrolling container (`wheel={false}`). */
export const VALUE_HINT_MODS_NO_WHEEL = 'Drag: change · Shift: fine · Ctrl+click: reset · Double-click: type';

/** The default modifier help of a value control, with or without the wheel. */
export function valueHintMods(wheel = true): string {
  return wheel ? VALUE_HINT_MODS : VALUE_HINT_MODS_NO_WHEEL;
}

// ── Asking the hint bar to re-read (canvases) ─────────────────────────────────

/**
 * The window event the hint bar re-resolves on. The bar reads hints on
 * `pointerover`, which never fires while the pointer moves WITHIN one element, so
 * a canvas with per-row hints dispatches this when the hovered row changes:
 *   detail { hint, mods? }  show this text (and modifier help) now
 *   detail null             re-read the hovered element's data-hint
 */
export const HINT_REFRESH_EVENT = 'xleth-hint-refresh';

export interface HintRefreshDetail {
  hint: string;
  mods?: string;
}

/** Ask the hint bar to show `detail` (or, with null, to re-read the hovered element). */
export function requestHintRefresh(detail: HintRefreshDetail | null = null): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(HINT_REFRESH_EVENT, { detail }));
}

// ── Reading hints back (the hint bar) ─────────────────────────────────────────

const HINT_SELECTOR = '[data-hint], [aria-label], [title]';
const EMPTY_HINT = { text: '', mods: '' };

/**
 * What the hint bar says for a hovered node: the nearest element that documents
 * itself. Its `data-hint` wins, then `aria-label`, then `title`; `data-hint-mods`
 * (modifier help) is shown on the right.
 */
export function resolveHint(target: unknown): { text: string; mods: string } {
  const node = target as { closest?: (selector: string) => Element | null } | null;
  const element = node && typeof node.closest === 'function' ? node.closest(HINT_SELECTOR) : null;
  if (!element) return EMPTY_HINT;
  const text = element.getAttribute('data-hint')
    || element.getAttribute('aria-label')
    || element.getAttribute('title')
    || '';
  return { text: text.trim(), mods: (element.getAttribute('data-hint-mods') || '').trim() };
}
