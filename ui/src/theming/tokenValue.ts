// Token value helpers for Phase 0 color-token migration.
//
// Two forms:
//   tokenValue(name)      — non-React (canvas/worker callers). Reads the live
//                           CSS custom property from :root. Pure pass-through;
//                           no caching — caller owns memoisation if needed.
//   useTokenValue(name)   — React hook. Reads from ThemeContext.resolved.values
//                           to stay in sync with the render tree (avoids the
//                           useEffect write-to-:root ordering hazard).

import { useContext } from 'react';
import { ThemeContext } from './runtime/ThemeProvider';

/**
 * Read a resolved CSS token value from `:root` at call time.
 * Returns the empty string when the property is not set (SSR / test environments
 * without a DOM, or an unknown token name).
 *
 * No internal caching — pure pass-through. If you call this inside a tight
 * render loop, memoize at the callsite.
 */
export function tokenValue(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * React hook that returns the resolved CSS string for a token.
 * Reads from `ThemeContext.resolved.values` rather than the DOM so the value
 * is always coherent with the current React render — the `:root` write happens
 * in a useEffect (after paint) which would otherwise race with same-commit
 * canvas draws.
 *
 * Falls back to `tokenValue(name)` when called outside a ThemeProvider
 * (e.g. in isolated component tests that render without the full provider tree).
 */
export function useTokenValue(name: string): string {
  const ctx = useContext(ThemeContext);
  if (ctx) return ctx.resolved.values[name] ?? '';
  return tokenValue(name);
}
