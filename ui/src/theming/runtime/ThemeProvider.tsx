// React provider that owns the active theme for the renderer. On mount it
// calls ThemeLoader.loadActiveTheme() and applies the resulting token map to
// document.documentElement. Children get a context with:
//
//   - the current ThemeFile + its resolved values
//   - a setTheme() that swaps to a different shipped or user theme
//   - an updateTokens() for in-place Advanced-mode edits (debounced save)
//   - load diagnostics (source, fallbackReason, validation issues)
//
// The provider is renderer-only but degrades gracefully when window.xleth is
// absent (Storybook / Vitest): it loads the bundled default synchronously
// and applies it, skipping IPC entirely.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { resolveTheme, writeThemeToRoot, type ResolvedTheme } from './applyTheme';
import { DEFAULT_THEME_NAME, loadActiveTheme, type LoadResult } from './ThemeLoader';
import { createThemeWriter, type ThemeWriter } from './ThemeWriter';
import type { ThemeFile, TokenValue } from '../schema/types';

interface ThemeContextValue {
  slug: string;
  theme: ThemeFile;
  resolved: ResolvedTheme;
  /** Where the current theme came from. 'fallback' means the requested one failed to load. */
  source: LoadResult['source'];
  /** Why the fallback kicked in, if at all. */
  fallbackReason?: string;
  /** Warnings from validateTheme(); errors trigger fallback so this list is usually warning-only. */
  warnings: LoadResult['validation']['issues'];
  /** Swap the entire active theme. Persists activeTheme to settings. */
  setTheme(slug: string, theme: ThemeFile): Promise<void>;
  /** Patch tokens on the current theme in place; debounced persistence. */
  updateTokens(patch: Record<string, TokenValue>): void;
  /** Mark derived tokens as detached (value will now come from tokens, not deriveTheme). */
  setDerivationDetached(names: ReadonlyArray<string>): void;
  /** Write any pending debounced save immediately. */
  flushSaves(): Promise<void>;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children: ReactNode;
  /** Override the writer (primarily for tests). */
  writer?: ThemeWriter;
  /** Called with the LoadResult so the caller can log diagnostics. */
  onLoaded?(result: LoadResult): void;
}

export function ThemeProvider({ children, writer, onLoaded }: ThemeProviderProps) {
  const [loadResult, setLoadResult] = useState<LoadResult | null>(null);
  const [slug, setSlug] = useState<string>(DEFAULT_THEME_NAME);
  const [theme, setThemeState] = useState<ThemeFile | null>(null);
  const appliedRef = useRef<Record<string, string> | null>(null);

  const writerRef = useRef<ThemeWriter | null>(null);
  if (writerRef.current === null) {
    writerRef.current = writer ?? createThemeWriter();
  }

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    loadActiveTheme().then(result => {
      if (cancelled) return;
      setLoadResult(result);
      setSlug(result.requestedName);
      setThemeState(result.theme);
      onLoaded?.(result);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolved = useMemo<ResolvedTheme | null>(() => {
    return theme ? resolveTheme(theme) : null;
  }, [theme]);

  // Write to :root whenever the resolved token map changes.
  useEffect(() => {
    if (!resolved) return;
    writeThemeToRoot(resolved.values, appliedRef.current ?? undefined);
    appliedRef.current = resolved.values;
    window.dispatchEvent(new CustomEvent('xleth-theme-changed'));
  }, [resolved]);

  const setTheme = useCallback(async (nextSlug: string, next: ThemeFile) => {
    setSlug(nextSlug);
    setThemeState(next);
    await writerRef.current!.setActive(nextSlug);
  }, []);

  const updateTokens = useCallback((patch: Record<string, TokenValue>) => {
    setThemeState(prev => {
      if (!prev) return prev;
      if (prev.locked) return prev; // Guard: shipped themes are immutable.
      const nextTokens = { ...prev.tokens, ...patch };
      const next: ThemeFile = { ...prev, tokens: nextTokens };
      writerRef.current!.queueSave(slug, next);
      return next;
    });
  }, [slug]);

  const setDerivationDetached = useCallback((names: ReadonlyArray<string>) => {
    setThemeState(prev => {
      if (!prev || prev.locked) return prev;
      const next: ThemeFile = { ...prev, derivationDetached: [...names] };
      writerRef.current!.queueSave(slug, next);
      return next;
    });
  }, [slug]);

  const flushSaves = useCallback(async () => {
    await writerRef.current!.flush();
  }, []);

  const value = useMemo<ThemeContextValue | null>(() => {
    if (!theme || !resolved || !loadResult) return null;
    return {
      slug,
      theme,
      resolved,
      source: loadResult.source,
      fallbackReason: loadResult.fallbackReason,
      warnings: loadResult.validation.issues,
      setTheme,
      updateTokens,
      setDerivationDetached,
      flushSaves,
    };
  }, [slug, theme, resolved, loadResult, setTheme, updateTokens, setDerivationDetached, flushSaves]);

  // First paint before theme loads: render nothing to avoid a flash of
  // unstyled tokens. The loader is fast (one IPC roundtrip + one file read)
  // and the window already has its Electron loading state.
  if (!value) return null;

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme: ThemeProvider missing from the tree');
  return ctx;
}
