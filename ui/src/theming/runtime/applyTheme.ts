// Resolve a ThemeFile into the final flat map of CSS custom properties and
// write them to :root via element.style.setProperty(). Per spec §6.
//
// Resolution order (lowest → highest precedence):
//   1. Catalog defaults (base literals, derived-var refs, explicit literals).
//   2. deriveTheme() output (replaces derived-formula tokens unless detached).
//   3. theme.tokens — user/theme overrides win.
//
// Gradient objects compile to CSS strings at write time. Refs like
// `var(--theme-accent)` remain as references so the browser resolves them
// dynamically — updating one base token cascades to every downstream token
// without us having to re-materialize them.

import { BASE_DEFAULTS, BASE_TOKEN_NAMES, type BaseTokens } from '../tokens/base';
import { deriveTheme } from '../tokens/derivation';
import { TOKENS, TOKENS_BY_NAME } from '../tokens/catalog';
import { compileTokenValue } from '../schema/gradientCompiler';
import type { ThemeFile, TokenValue } from '../schema/types';

export interface ResolvedTheme {
  /** Final CSS-string value for every token in the catalog. */
  values: Record<string, string>;
  /** The resolved base tokens, after theme overrides. */
  base: BaseTokens;
}

/**
 * Resolve a theme into a flat `name → cssString` map without touching the DOM.
 * Pure — callers get the full map back and can diff against the previously-
 * applied one to avoid redundant setProperty calls.
 */
export function resolveTheme(theme: ThemeFile): ResolvedTheme {
  const tokens = (theme.tokens ?? {}) as Record<string, TokenValue>;
  const detached = theme.derivationDetached ?? [];

  // 1. Base tokens.
  const base: BaseTokens = { ...BASE_DEFAULTS };
  for (const name of BASE_TOKEN_NAMES) {
    const override = tokens[name];
    if (typeof override === 'string') base[name] = override;
  }

  // 2. Derived-formula tokens via deriveTheme (skips detached).
  const derived = deriveTheme(base, detached);

  // 3. Assemble full map from the catalog.
  const values: Record<string, string> = {};
  for (const t of TOKENS) {
    switch (t.derivation.type) {
      case 'base':
        values[t.name] = base[t.name as keyof BaseTokens];
        break;
      case 'derived-formula':
        values[t.name] = derived[t.name] ?? '';
        break;
      case 'derived-var':
        values[t.name] = `var(${t.derivation.ref})`;
        break;
      case 'explicit':
        values[t.name] = t.derivation.value;
        break;
    }
  }

  // 4. Apply theme-file overrides last. A detached derived token gets its
  //    value from here; a non-detached derived token can still be overridden
  //    but will be rewritten on the next deriveTheme pass — that's expected.
  for (const [name, value] of Object.entries(tokens)) {
    if (!TOKENS_BY_NAME[name]) continue;  // unknown token — skip silently (warned at validate)
    values[name] = compileTokenValue(value);
  }

  return { values, base };
}

/**
 * Write a resolved token map to the document root. Only touches properties
 * that differ from the previously-applied map — this matters for themes with
 * hundreds of tokens where a redundant pass of setProperty can force layout.
 */
export function writeThemeToRoot(
  values: Record<string, string>,
  previous?: Record<string, string>,
  root: HTMLElement = document.documentElement,
): void {
  for (const [name, value] of Object.entries(values)) {
    if (previous && previous[name] === value) continue;
    root.style.setProperty(name, value);
  }
  // Remove tokens that existed before but not now (rare: catalog shrinkage).
  if (previous) {
    for (const name of Object.keys(previous)) {
      if (!(name in values)) root.style.removeProperty(name);
    }
  }
}
