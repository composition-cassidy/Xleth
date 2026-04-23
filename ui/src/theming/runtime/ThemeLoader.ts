// Boot-time theme resolution.
//
//   1. Read the active-theme name from user settings.
//   2. If it names a shipped theme → use the bundled JSON.
//   3. Otherwise read `userData/themes/<name>.json` via IPC.
//   4. On validation error or missing file, fall back to the default and
//      surface the issues so the caller can log/toast them.
//
// Pure-ish: returns a ThemeFile plus the ValidationResult. No DOM writes.
// ThemeProvider is the only place that actually applies a theme.

import { validateTheme } from '../schema/themeSchema';
import type { ThemeFile, ValidationResult } from '../schema/types';
import shippedDefault from '../shipped/xleth-default.json';

const ACTIVE_THEME_SETTING_KEY = 'activeTheme';
export const DEFAULT_THEME_NAME = 'xleth-default';

const SHIPPED_THEMES: Record<string, ThemeFile> = {
  [DEFAULT_THEME_NAME]: shippedDefault as unknown as ThemeFile,
};

export interface LoadResult {
  theme: ThemeFile;
  /** Which source the loader actually used — useful for debug surfaces. */
  source: 'shipped' | 'user' | 'fallback';
  /** The slug that was asked for (may differ from theme.name). */
  requestedName: string;
  validation: ValidationResult;
  /** If non-null, the initial attempt failed and we fell back to default. */
  fallbackReason?: string;
}

interface ThemeBridge {
  readActiveName(): Promise<string | null>;
  readUserTheme(name: string): Promise<unknown | null>;
}

/**
 * Real bridge wired to window.xleth.theme. ThemeLoader takes the bridge as
 * an argument so tests can inject a stub and so the loader is usable even
 * when the Electron preload hasn't attached yet (e.g. Storybook, Vitest).
 */
export function makeRendererBridge(): ThemeBridge {
  return {
    async readActiveName() {
      const x = (globalThis as unknown as { xleth?: { settings?: { get: (k: string) => Promise<unknown> } } }).xleth;
      if (!x?.settings?.get) return null;
      const v = await x.settings.get(ACTIVE_THEME_SETTING_KEY);
      return typeof v === 'string' && v.length > 0 ? v : null;
    },
    async readUserTheme(name) {
      const x = (globalThis as unknown as { xleth?: { theme?: { loadUser: (name: string) => Promise<unknown> } } }).xleth;
      if (!x?.theme?.loadUser) return null;
      try { return await x.theme.loadUser(name); }
      catch { return null; }
    },
  };
}

export async function loadActiveTheme(bridge: ThemeBridge = makeRendererBridge()): Promise<LoadResult> {
  const requested = (await bridge.readActiveName()) ?? DEFAULT_THEME_NAME;

  // Shipped themes: bundled, always present, no I/O.
  if (SHIPPED_THEMES[requested]) {
    const theme = SHIPPED_THEMES[requested];
    const validation = validateTheme(theme);
    if (!validation.valid) {
      return fallback(requested, validation, `shipped theme "${requested}" failed validation`);
    }
    return { theme, source: 'shipped', requestedName: requested, validation };
  }

  // User theme from disk.
  const raw = await bridge.readUserTheme(requested);
  if (raw == null) {
    return fallback(requested, { valid: false, issues: [] }, `user theme "${requested}" not found`);
  }
  const validation = validateTheme(raw);
  if (!validation.valid) {
    return fallback(requested, validation, `user theme "${requested}" failed validation`);
  }
  return { theme: raw as ThemeFile, source: 'user', requestedName: requested, validation };
}

function fallback(requested: string, validation: ValidationResult, reason: string): LoadResult {
  const theme = SHIPPED_THEMES[DEFAULT_THEME_NAME];
  return {
    theme,
    source: 'fallback',
    requestedName: requested,
    validation,
    fallbackReason: reason,
  };
}

export function listShippedThemes(): ReadonlyArray<{ slug: string; name: string; locked: boolean }> {
  return Object.entries(SHIPPED_THEMES).map(([slug, t]) => ({
    slug,
    name: t.name,
    locked: Boolean(t.locked),
  }));
}
