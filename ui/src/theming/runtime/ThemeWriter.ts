// Debounced theme-file writer. Called from the Advanced-mode editor as the
// user tweaks tokens; we don't flush to disk on every stroke. Spec §5 calls
// for 500 ms; the caller can override for tests.
//
// The writer validates before persisting. A ValidationResult with errors
// fails the save, returning the issues so the editor can surface them.

import { validateTheme } from '../schema/themeSchema';
import type { ThemeFile, ValidationResult } from '../schema/types';

interface ThemeBridge {
  saveUserTheme(slug: string, theme: ThemeFile): Promise<void>;
  setActiveName(slug: string): Promise<void>;
}

export function makeRendererWriterBridge(): ThemeBridge {
  return {
    async saveUserTheme(slug, theme) {
      const x = (globalThis as unknown as { xleth?: { theme?: { saveUser: (s: string, t: ThemeFile) => Promise<void> } } }).xleth;
      if (!x?.theme?.saveUser) throw new Error('ThemeWriter: window.xleth.theme.saveUser unavailable');
      await x.theme.saveUser(slug, theme);
    },
    async setActiveName(slug) {
      const x = (globalThis as unknown as { xleth?: { settings?: { set: (k: string, v: unknown) => Promise<void> } } }).xleth;
      if (!x?.settings?.set) throw new Error('ThemeWriter: window.xleth.settings.set unavailable');
      await x.settings.set('activeTheme', slug);
    },
  };
}

export interface SaveResult {
  ok: boolean;
  validation: ValidationResult;
  error?: string;
}

export interface ThemeWriter {
  /** Queue a save. Debounces; the latest theme wins if called rapidly. */
  queueSave(slug: string, theme: ThemeFile): void;
  /** Flush any pending save immediately. Resolves once written. */
  flush(): Promise<SaveResult | null>;
  /** Synchronous validate+write, bypassing debounce (for "Save As"). */
  saveNow(slug: string, theme: ThemeFile): Promise<SaveResult>;
  setActive(slug: string): Promise<void>;
}

export function createThemeWriter(
  bridge: ThemeBridge = makeRendererWriterBridge(),
  debounceMs = 500,
): ThemeWriter {
  let pending: { slug: string; theme: ThemeFile } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<SaveResult | null> | null = null;

  const performWrite = async (): Promise<SaveResult | null> => {
    if (!pending) return null;
    const { slug, theme } = pending;
    pending = null;
    timer = null;
    return saveNow(slug, theme);
  };

  const saveNow = async (slug: string, theme: ThemeFile): Promise<SaveResult> => {
    const validation = validateTheme(theme);
    if (!validation.valid) {
      return { ok: false, validation, error: 'validation failed' };
    }
    try {
      await bridge.saveUserTheme(slug, theme);
      return { ok: true, validation };
    } catch (e) {
      return { ok: false, validation, error: (e as Error).message };
    }
  };

  return {
    queueSave(slug, theme) {
      pending = { slug, theme };
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        inflight = performWrite();
      }, debounceMs);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        inflight = performWrite();
      }
      return inflight ?? null;
    },
    saveNow,
    async setActive(slug) { await bridge.setActiveName(slug); },
  };
}
