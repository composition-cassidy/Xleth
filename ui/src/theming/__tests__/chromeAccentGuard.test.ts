// Guard: the accent never reaches chrome (control outlines, labels, dividers, surfaces).
//
// Regression for "some themes put the accent on chrome". Saved user themes and the Appearance
// file used to load verbatim; the ramp then stepped ink-2 / ink-3 / boundary off a text colour
// that carried the accent's hue and amplified it (chroma 0.008 -> 0.10). Every theme path is
// covered here: the five shipped themes, fixtures of an old custom theme (mint and cyan accent)
// and a legacy Appearance file, and the live Appearance builder at its extreme tint.
//
// The contract (ui/DESIGN.md section 3.1): boundary and every text tier have OKLCH chroma
// <= 0.02; ink tiers >= 4.5:1 on g0..g3, boundary >= 3:1 (>= 7:1 on the hc ramp); the accent
// appears only in value / active / selection tokens.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveTheme } from '../runtime/applyTheme';
import { getShippedTheme } from '../runtime/ThemeLoader';
import { buildAppearanceTheme } from '../runtime/appearanceTheme.js';
import { CHROME_MODEL_VERSION, migrateChrome } from '../runtime/chromeMigration';
import { INK_CHROMA_CAP, findTintedInk, findTintedSurfaces, resolveHex } from '../runtime/chromeTint';
import { contrastRatio, hexToOklch } from '../../ui-kit/colorMath';
import type { ThemeFile } from '../schema/types';

import oldCustom from './fixtures/oldCustomTheme.json';
import oldCyan from './fixtures/oldCyanTheme.json';
import legacyAppearance from './fixtures/legacyAppearanceTheme.json';

const SHIPPED = ['xleth-default', 'xleth-light', 'xleth-warm', 'xleth-cool', 'xleth-high-contrast'] as const;

// ── the legacy aliases, read from the real CSS so a new alias cannot dodge the guard ─────────
const SRC = path.resolve(__dirname, '../..');
const ALIAS_RE = /^\s*(--(?:mx|xleth-flat|xleth-eq|ui)-[a-z0-9-]+)\s*:\s*([^;]+);/gm;
const ALIASES: Record<string, string> = {};
for (const file of ['styles/app.css', 'ui-kit/tokens.css']) {
  const css = fs.readFileSync(path.join(SRC, file), 'utf8');
  for (const m of css.matchAll(ALIAS_RE)) ALIASES[m[1]] = m[2].trim();
}

function resolveAny(values: Record<string, string>, name: string, depth = 0): string | null {
  const raw = values[name] ?? ALIASES[name];
  if (raw == null || depth > 10) return null;
  return resolveRaw(values, raw, depth);
}
function resolveRaw(values: Record<string, string>, raw: string, depth: number): string | null {
  const v = raw.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(v);
  if (!m) return null; // rgba(), color-mix(): alpha lines, not a resolvable solid
  return resolveAny(values, m[1], depth + 1) ?? (m[2] ? resolveRaw(values, m[2], depth + 1) : null);
}

/** Tokens and aliases that paint labels, outlines and dividers. None may carry the accent. */
const INK_AND_OUTLINE = [
  '--theme-ui-boundary', '--theme-ui-ink', '--theme-ui-ink-2', '--theme-ui-ink-3', '--theme-ui-g4',
  '--theme-text', '--theme-text-muted', '--theme-text-subtle', '--theme-text-placeholder', '--theme-border-subtle',
  '--ui-boundary', '--ui-ink', '--ui-ink-2', '--ui-ink-3',
  '--xleth-flat-border', '--xleth-flat-preview-border', '--xleth-flat-text', '--xleth-flat-text-secondary',
  '--xleth-flat-text-muted', '--xleth-flat-text-subtle', '--xleth-flat-empty-text',
  '--mx-bd', '--mx-t1', '--mx-t2', '--mx-t3', '--mx-t4',
];
const SURFACES = [
  '--theme-ui-g0', '--theme-ui-g1', '--theme-ui-g2', '--theme-ui-g3', '--theme-bg-primary', '--theme-bg-surface',
  '--theme-bg-inset', '--xleth-flat-bg', '--xleth-flat-well', '--xleth-flat-chrome', '--mx-s0', '--mx-s1', '--mx-s2',
];
/** The only tokens allowed to equal the accent: value fills, active state, selection, focus. */
const ACCENT_TOKENS = [
  '--theme-accent', '--theme-border-focus', '--theme-info', '--ui-value', '--ui-select',
  '--xleth-flat-accent', '--mx-ac', '--xleth-eq-accent',
];

interface Case { label: string; theme: ThemeFile; migrate: boolean }
const asTheme = (j: unknown) => j as unknown as ThemeFile;

const CASES: Case[] = [
  ...SHIPPED.map((s) => ({ label: `shipped ${s}`, theme: getShippedTheme(s)!, migrate: false })),
  { label: 'fixture: old custom theme (mint accent)', theme: asTheme(oldCustom), migrate: true },
  { label: 'fixture: old custom theme (cyan accent)', theme: asTheme(oldCyan), migrate: true },
  { label: 'fixture: legacy Appearance file (cyan, 300% tint)', theme: asTheme(legacyAppearance), migrate: true },
  { label: 'Appearance builder: cyan, hue 190, tint 300', theme: asTheme(buildAppearanceTheme('#33CED6', 0, { hue: 190, saturation: 300 })), migrate: false },
  { label: 'Appearance builder: orange, light, tint 300', theme: asTheme(buildAppearanceTheme('#E38131', 80, { hue: 30, saturation: 300, contrast: 160 })), migrate: false },
  { label: 'Appearance builder: your saved settings', theme: asTheme(buildAppearanceTheme('#e38131', 1, { hue: 227, saturation: 50, contrast: 160 })), migrate: false },
];

describe.each(CASES)('$label', ({ label, theme, migrate }) => {
  const loaded = migrate ? migrateChrome(theme).theme : theme;
  const { values, ramp } = resolveTheme(loaded);
  const hex = (n: string) => resolveAny(values, n);
  const accent = hex('--theme-accent')!;
  const G = ['g0', 'g1', 'g2', 'g3'].map((k) => hex(`--theme-ui-${k}`)!);

  it('boundary, every text tier, divider and alias have chroma <= 0.02', () => {
    for (const n of INK_AND_OUTLINE) {
      const h = hex(n);
      expect(h, `${n} should resolve to a solid colour`).not.toBeNull();
      expect(hexToOklch(h!).c, `${n} = ${h}`).toBeLessThanOrEqual(INK_CHROMA_CAP);
    }
    expect(findTintedInk(values)).toEqual([]);
  });

  it('meets the DESIGN.md contrast floors on g0..g3', () => {
    const boundaryFloor = ramp === 'hc' ? 7 : 3;
    for (const g of G) {
      for (const n of ['--theme-ui-ink', '--theme-ui-ink-2', '--theme-ui-ink-3', '--theme-text', '--theme-text-muted', '--theme-text-subtle']) {
        expect(contrastRatio(hex(n)!, g), `${n} on ${g}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(hex('--theme-ui-boundary')!, g), `boundary on ${g}`).toBeGreaterThanOrEqual(boundaryFloor);
    }
  });

  it('the accent appears only in value / active / selection tokens', () => {
    for (const n of [...INK_AND_OUTLINE, ...SURFACES]) {
      expect(hex(n), `${n} must not be the accent`).not.toBe(accent);
    }
    for (const n of ACCENT_TOKENS) {
      expect(hex(n), `${n} follows the accent`).toBe(accent);
    }
  });

  it('surfaces stay under the tint cap (the Appearance slider may exceed it on surfaces only, and warns)', () => {
    const sliderPastCap = /^Appearance builder: .*tint 300/.test(label);
    if (!sliderPastCap) expect(findTintedSurfaces(values)).toEqual([]);
  });
});

describe('migration of saved themes', () => {
  const SAVED = [oldCustom, oldCyan, legacyAppearance].map(asTheme);

  it.each(SAVED.map((t) => [t.name, t] as const))('%s: the leak is real before migration and gone after', (_name, t) => {
    // Unmigrated, the legacy text-muted / subtle / border-subtle HSL formulas (and, for the
    // Appearance file, its explicit tinted tokens) still load coloured ink: the migration is
    // what removes it.
    const raw = resolveTheme(t).values;
    expect(findTintedInk(raw).length, 'fixture must reproduce the leak').toBeGreaterThan(0);
    const migrated = resolveTheme(migrateChrome(t).theme).values;
    expect(findTintedInk(migrated)).toEqual([]);
    expect(findTintedSurfaces(migrated)).toEqual([]);
  });

  it.each(SAVED.map((t) => [t.name, t] as const))('%s: is idempotent and does not mutate its input', (_name, t) => {
    const before = JSON.stringify(t);
    const once = migrateChrome(t);
    expect(JSON.stringify(t)).toBe(before);
    const twice = migrateChrome(once.theme);
    expect(twice.changed).toBe(false);
    expect(twice.theme).toBe(once.theme); // untouched, same object
    expect(once.theme.chromeModel).toBe(CHROME_MODEL_VERSION);
  });

  it('keeps the accent, danger and identity colours exactly', () => {
    for (const t of SAVED) {
      const out = migrateChrome(t).theme.tokens as Record<string, unknown>;
      for (const [k, v] of Object.entries(t.tokens)) {
        if (k === '--theme-accent' || k === '--theme-danger' || /track-palette|smartbalance|sampler-mod-color|semantic-(success|warning)/.test(k)) {
          expect(out[k], k).toBe(v);
        }
      }
    }
  });

  it('drops the stale cyan fills only when the accent is not that cyan', () => {
    const mint = migrateChrome(asTheme(oldCustom)).theme.tokens as Record<string, unknown>;
    expect(mint['--theme-accent-bg-subtle']).toBeUndefined();
    expect(mint['--theme-accent-bg-medium']).toBeUndefined();
    const cyan = migrateChrome(asTheme(oldCyan)).theme.tokens as Record<string, unknown>;
    expect(cyan['--theme-accent-bg-subtle']).toBe('rgba(51, 206, 214, 0.08)');
  });

  it('never touches a locked (shipped) theme', () => {
    for (const s of SHIPPED) {
      const t = getShippedTheme(s)!;
      const r = migrateChrome(t);
      expect(r.theme).toBe(t);
      expect(r.changed).toBe(false);
    }
  });

  it('a derived ramp never has more chroma than the base it steps from', () => {
    // The formula-level guard: even with NO migration, tinted text must not become tinted outlines.
    const t: ThemeFile = { schemaVersion: 1, name: 'raw', derivationDetached: [], tokens: { '--theme-text': '#E2F7F8', '--theme-bg-surface': '#14201F', '--theme-bg-primary': '#091213', '--theme-accent': '#33CED6' } };
    const v = resolveTheme(t).values;
    const baseC = hexToOklch(resolveHex(v, '--theme-ui-ink')!).c;
    for (const n of ['--theme-ui-ink-2', '--theme-ui-ink-3', '--theme-ui-boundary']) {
      expect(hexToOklch(resolveHex(v, n)!).c, n).toBeLessThanOrEqual(baseC + 0.002);
    }
  });
});
