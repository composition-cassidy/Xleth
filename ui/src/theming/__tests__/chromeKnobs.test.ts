// Knob round-trip, custom-theme migration and the "pre-Phase-7 file still loads" guarantee.

import { describe, expect, it } from 'vitest';

import { migrateLegacyAppearance, buildAppearanceTheme } from '../runtime/appearanceTheme.js';
import { resolveTheme } from '../runtime/applyTheme';
import { findTintedSurfaces, resolveHex } from '../runtime/chromeTint';
import { accentIdentityClashes, applyChromeKnobs, neutralizeTheme, readChromeKnobs } from '../runtime/chromeKnobs';
import { getShippedTheme } from '../runtime/ThemeLoader';
import { validateTheme } from '../schema/themeSchema';
import type { ThemeFile } from '../schema/types';

describe('migrateLegacyAppearance', () => {
  it('turns the untouched legacy default (hue 240, saturation 100) into exact grey', () => {
    expect(migrateLegacyAppearance({ hue: 240, saturation: 100, contrast: 100 })).toEqual({ hue: 240, saturation: 0, contrast: 100 });
  });

  it('keeps a deliberately chosen hue and a proportional tint', () => {
    const m = migrateLegacyAppearance({ hue: 330, saturation: 150, contrast: 100 });
    expect(m.hue).toBe(330);
    expect(m.saturation).toBeGreaterThan(100);
    expect(m.saturation).toBeLessThanOrEqual(300);
  });

  it('raises a pre-Phase-7 contrast below the floor to the new minimum', () => {
    expect(migrateLegacyAppearance({ hue: 240, saturation: 100, contrast: 60 }).contrast).toBe(80);
  });

  it('survives garbage', () => {
    expect(migrateLegacyAppearance({ hue: NaN, saturation: NaN, contrast: NaN })).toEqual({ hue: 240, saturation: 0, contrast: 100 });
  });
});

describe('a theme saved before Phase 7 keeps loading', () => {
  // The shape the old Appearance panel and the old editor wrote: no `ramp`, hue-240 bases,
  // explicit legacy overrides.
  const legacy: ThemeFile = {
    schemaVersion: 1,
    name: 'User Appearance',
    locked: false,
    derivationDetached: ['--theme-text-muted', '--theme-text-subtle', '--theme-text-placeholder', '--theme-border-subtle'],
    tokens: {
      '--theme-accent': '#33CED6',
      '--theme-bg-primary': '#0A0A0F',
      '--theme-bg-surface': '#1A1A24',
      '--theme-bg-inset': '#0D0D14',
      '--theme-text': '#E8E8ED',
      '--theme-text-muted': '#8888A0',
      '--theme-text-subtle': '#555566',
      '--theme-text-placeholder': '#555566',
      '--theme-border-subtle': '#2A2A38',
    },
  };

  it('validates without errors', () => {
    expect(validateTheme(legacy).valid).toBe(true);
  });

  it('resolves exactly the colours it was saved with, and infers the dark ramp', () => {
    const r = resolveTheme(legacy);
    expect(r.ramp).toBe('dark');
    expect(r.values['--theme-bg-surface']).toBe('#1A1A24');
    expect(r.values['--theme-bg-primary']).toBe('#0A0A0F');
    expect(r.values['--theme-text-muted']).toBe('#8888A0');
    // The ramp is still produced from its bases, so the kit has every --ui-* token.
    expect(resolveHex(r.values, '--theme-ui-g1')).toBe('#1A1A24');
    expect(resolveHex(r.values, '--theme-ui-rec')).toBe('#E5484D');
  });

  it('is flagged as tinted, not rejected', () => {
    expect(findTintedSurfaces(resolveTheme(legacy).values).length).toBeGreaterThan(0);
  });

  it('a light legacy theme infers the light ramp', () => {
    const light: ThemeFile = {
      ...legacy,
      tokens: { ...legacy.tokens, '--theme-bg-surface': '#E6E6E2', '--theme-bg-primary': '#F2F2EE', '--theme-text': '#18181F' },
    };
    expect(resolveTheme(light).ramp).toBe('light');
  });

  it('an unknown ramp name is a warning and falls back to inference', () => {
    const odd = { ...legacy, ramp: 'sepia' } as unknown as ThemeFile;
    const v = validateTheme(odd);
    expect(v.valid).toBe(true);
    expect(v.issues.some((i) => i.path === 'ramp' && i.severity === 'warning')).toBe(true);
    expect(resolveTheme(odd).ramp).toBe('dark');
  });

  it('Neutralize turns it into an untinted theme without touching the accent', () => {
    const r = resolveTheme(legacy);
    const fixed = neutralizeTheme(legacy, '#33CED6', r.values);
    const after = resolveTheme(fixed);
    expect(findTintedSurfaces(after.values)).toEqual([]);
    expect(after.values['--theme-accent']).toBe('#33CED6');
  });

  it('an old bare theme with only an accent resolves onto the neutral ramp, not the old blue-grey', () => {
    const bare: ThemeFile = { schemaVersion: 1, name: 'bare', derivationDetached: [], tokens: { '--theme-accent': '#E8943A' } };
    expect(findTintedSurfaces(resolveTheme(bare).values)).toEqual([]);
  });
});

describe('chrome knobs', () => {
  const dark = getShippedTheme('xleth-default')!;

  it('read back the shipped dark theme as brightness 0, no tint', () => {
    const k = readChromeKnobs(resolveTheme(dark).values);
    expect(k.brightness).toBe(0);
    expect(k.tint).toBe(0);
  });

  it('round-trip: apply then read returns the same positions', () => {
    const base = { brightness: 35, contrast: 120, hue: 200, tint: 100 };
    const themed = applyChromeKnobs(dark, '#33CED6', base);
    const read = readChromeKnobs(resolveTheme(themed).values);
    expect(Math.abs(read.brightness - base.brightness)).toBeLessThanOrEqual(1);
    expect(Math.abs(read.tint - base.tint)).toBeLessThanOrEqual(8);
    // A cast at the neutral cap is only ~3 8-bit steps wide, so its hue reads back coarsely.
    expect(Math.abs(read.hue - base.hue)).toBeLessThanOrEqual(35);
  });

  it('applying knobs keeps palette and panel-local overrides', () => {
    const themed = applyChromeKnobs(dark, '#33CED6', { brightness: 20, contrast: 100, hue: 240, tint: 0 });
    expect(themed.tokens['--theme-track-palette-1']).toBe(dark.tokens['--theme-track-palette-1']);
    expect(themed.derivationDetached).toEqual(expect.arrayContaining(dark.derivationDetached));
  });

  it('pushing the tint past the cap makes the theme report tinted chrome', () => {
    const at = (tint: number) =>
      findTintedSurfaces(resolveTheme(applyChromeKnobs(dark, '#33CED6', { brightness: 10, contrast: 100, hue: 330, tint })).values).length;
    expect(at(100)).toBe(0);
    expect(at(250)).toBeGreaterThan(0);
  });

  it('an appearance file validates', () => {
    expect(validateTheme(buildAppearanceTheme('#33CED6', 40, { hue: 90, saturation: 120, contrast: 110 }) as ThemeFile).valid).toBe(true);
  });
});

describe('accent / identity clash warning', () => {
  it('Default accent clashes with no identity colour; warm amber clashes with several', () => {
    expect(accentIdentityClashes(resolveTheme(getShippedTheme('xleth-default')!).values)).toBe(0);
    expect(accentIdentityClashes(resolveTheme(getShippedTheme('xleth-warm')!).values)).toBeGreaterThan(0);
  });
});
