// Roving keyboard focus for tab lists, segmented controls and toolbars.
// One tab stop for the group; arrows move within it, Home / End jump to the ends.

import type { KeyboardEvent } from 'react';

/** Index to move to for a key, or null when the key is not a navigation key. */
export function rovingTarget(
  key: string,
  current: number,
  enabled: readonly boolean[],
  orientation: 'horizontal' | 'vertical' = 'horizontal',
): number | null {
  const n = enabled.length;
  if (!n || !enabled.some(Boolean)) return null;
  const prev = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const walk = (from: number, dir: 1 | -1): number => {
    for (let step = 1; step <= n; step += 1) {
      const i = (from + dir * step + n * step) % n;
      if (enabled[i]) return i;
    }
    return current;
  };
  if (key === next) return walk(current, 1);
  if (key === prev) return walk(current, -1);
  if (key === 'Home') return enabled.findIndex(Boolean);
  if (key === 'End') return enabled.length - 1 - [...enabled].reverse().findIndex(Boolean);
  return null;
}

/** onKeyDown for a group whose items are the buttons matching `selector`. */
export function rovingKeyHandler(selector: string, orientation: 'horizontal' | 'vertical' = 'horizontal') {
  return (e: KeyboardEvent<HTMLElement>): void => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector));
    const enabled = items.map((el) => !(el as HTMLButtonElement).disabled);
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (current < 0) return;
    const target = rovingTarget(e.key, current, enabled, orientation);
    if (target === null || target === current) {
      if (target !== null) e.preventDefault();
      return;
    }
    e.preventDefault();
    items[target].focus();
  };
}
