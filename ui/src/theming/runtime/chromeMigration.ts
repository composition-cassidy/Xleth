// Load-time migration of saved user themes and the Appearance theme onto the neutral-chrome
// contract (ui/DESIGN.md section 3.1: boundary, ink and the g-ramp are grey; only the accent,
// and the identity palette, carry colour).
//
// Why this exists. A theme saved before Phase 7 holds a handful of base tokens, and the old
// editor picked the TEXT colour from the accent's hue (mint accent -> mint text, purple accent
// -> purple text). deriveTheme() then stepped ink-2, ink-3, the boundary and the dividers off
// that text by HSL lightness, which keeps HSL saturation, so a near-white text of chroma 0.008
// became a chroma-0.10 outline. Nothing re-neutralised a file on load (only the Appearance
// slider positions were migrated, never the files), so those themes drew every control outline
// and many labels in the accent's hue.
//
// What it does, in memory and nothing else (a file on disk is only rewritten when the user
// saves):
//   1. caps the chroma of every explicit surface colour (<= SURFACE_TARGET, under the 0.012
//      "tinted chrome" cap) and ink colour (<= INK_TARGET, under INK_CHROMA_CAP), keeping
//      lightness and hue, so the user's brightness choice and a faint cast survive;
//   2. points the legacy text tiers and border-subtle at the ramp (ink-2 / ink-3 / g4) the way
//      the shipped themes do, replacing the HSL formulas that amplified the cast;
//   3. drops stale cyan accent fills that were frozen into the file from the old default while
//      the theme's own accent is something else;
//   4. stamps `chromeModel`, which makes it idempotent: a stamped theme is returned untouched.
// The accent, the danger colour and every identity colour (track palette etc.) are never read.
//
// The ramp itself no longer amplifies a tint either (tokens/derivation.ts `stepOf`), so a theme
// edited in Advanced mode after migration cannot regain the leak through the formulas.

import { capChroma, hexToOklch } from '../../ui-kit/colorMath';
import { RAMPS, inferRamp, isRampName } from '../tokens/neutralRamp';
import { CHROME_INK_TOKENS, CHROME_SURFACE_TOKENS } from './chromeTint';
import type { ThemeFile, TokenValue } from '../schema/types';

/** Bump when the migration's output contract changes; a theme stamped lower is migrated again. */
export const CHROME_MODEL_VERSION = 2;

// Targets sit under the detection caps (0.012 surface, 0.02 ink) with room for 8-bit rounding.
export const SURFACE_TARGET_CHROMA = 0.01;
export const INK_TARGET_CHROMA = 0.008;

const SURFACE_KEYS: ReadonlyArray<string> = Array.from(new Set([
  ...CHROME_SURFACE_TOKENS,
  '--theme-bg-secondary',
  '--theme-bg-tertiary',
  '--theme-bg-hover',
  '--theme-bg-active',
  '--theme-bg-elevated',
]));
const INK_KEYS: ReadonlyArray<string> = Array.from(new Set([...CHROME_INK_TOKENS, '--theme-text-inverse']));

/** Legacy text tiers and divider that the shipped themes point at the ramp. */
const RAMP_REFS: Readonly<Record<string, string>> = {
  '--theme-text-muted': 'var(--theme-ui-ink-2)',
  '--theme-text-subtle': 'var(--theme-ui-ink-3)',
  '--theme-text-placeholder': 'var(--theme-ui-ink-3)',
  '--theme-border-subtle': 'var(--theme-ui-g4)',
};

const DEFAULT_CYAN = '#33CED6';
const STALE_CYAN_FILLS: ReadonlyArray<string> = ['--theme-accent-bg-subtle', '--theme-accent-bg-medium'];
const OLD_CYAN_RGBA = /^rgba\(\s*51\s*,\s*206\s*,\s*214\b/i;

export interface ChromeMigrationResult {
  theme: ThemeFile;
  /** True when the migration altered tokens or detach list (the stamp alone does not count). */
  changed: boolean;
  /** One line per alteration, for the [Theme] debug log. */
  notes: string[];
}

function asHex6(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(t)) return ('#' + t.slice(1).split('').map((c) => c + c).join('')).toUpperCase();
  return null;
}

/**
 * Bring a saved theme onto the neutral-chrome contract. Pure; returns the input untouched when
 * the theme is locked (shipped) or already stamped. Never throws on odd token values.
 */
export function migrateChrome(theme: ThemeFile): ChromeMigrationResult {
  if (theme.locked || (typeof theme.chromeModel === 'number' && theme.chromeModel >= CHROME_MODEL_VERSION)) {
    return { theme, changed: false, notes: [] };
  }

  const notes: string[] = [];
  const tokens: Record<string, TokenValue> = { ...(theme.tokens ?? {}) };
  const detached = new Set(theme.derivationDetached ?? []);

  // 1. Cap explicit surface and ink colours.
  const capKeys = (keys: ReadonlyArray<string>, target: number) => {
    for (const key of keys) {
      const hex = asHex6(tokens[key]);
      if (!hex) continue;
      const c = hexToOklch(hex).c;
      if (c <= target) continue;
      const next = capChroma(hex, target);
      tokens[key] = next;
      notes.push(`${key} ${hex} (c=${c.toFixed(3)}) -> ${next}`);
    }
  };
  capKeys(SURFACE_KEYS, SURFACE_TARGET_CHROMA);
  capKeys(INK_KEYS, INK_TARGET_CHROMA);

  // 2. Legacy text tiers and divider: derive from the ramp instead of the HSL formulas.
  for (const [name, ref] of Object.entries(RAMP_REFS)) {
    if (name in tokens || detached.has(name)) continue;
    tokens[name] = ref;
    detached.add(name);
    notes.push(`${name} -> ${ref}`);
  }

  // 3. Stale cyan fills (the old default's literals) on a theme whose accent is not that cyan.
  const accent = asHex6(tokens['--theme-accent']);
  const ramp = isRampName(theme.ramp) ? theme.ramp : inferRamp(asHex6(tokens['--theme-bg-surface']) ?? undefined);
  const effectiveAccent = accent ?? asHex6(RAMPS[ramp].base['--theme-accent']);
  if (effectiveAccent && effectiveAccent !== DEFAULT_CYAN) {
    for (const key of STALE_CYAN_FILLS) {
      const v = tokens[key];
      if (typeof v === 'string' && OLD_CYAN_RGBA.test(v.trim())) {
        delete tokens[key];
        detached.delete(key);
        notes.push(`${key} dropped (stale ${v.trim()}; follows the accent now)`);
      }
    }
  }

  const next: ThemeFile = {
    ...theme,
    chromeModel: CHROME_MODEL_VERSION,
    derivationDetached: Array.from(detached),
    tokens,
  };
  return { theme: next, changed: notes.length > 0, notes };
}
