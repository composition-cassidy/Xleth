// The neutral-chrome knobs shared by Settings > Appearance and the theme editor's Simple
// mode: brightness, text contrast and a capped tint. They are the same four numbers
// buildAppearanceTheme() takes, so a theme edited in either place is the same file.
//
// Because those numbers fully determine the surfaces, they can also be READ BACK from
// any resolved theme (including one saved before Phase 7), which is how the sliders open
// at the right positions for a custom theme without any new field in the theme file.

import {
  APPEARANCE_CONTRAST_MAX,
  APPEARANCE_CONTRAST_MIN,
  APPEARANCE_TINT_MAX,
  DEFAULT_APPEARANCE_HUE,
  buildAppearanceTheme,
} from './appearanceTheme.js';
import { RAMPS } from '../tokens/neutralRamp';
import { chromaOf, resolveHex, TINT_CHROMA_CAP } from './chromeTint';
import { contrastRatio, hexToOklch } from '../../ui-kit/colorMath';
import type { ThemeFile } from '../schema/types';

export interface ChromeKnobs {
  /** 0 = near-black with light text, 100 = light grey with dark text. */
  brightness: number;
  /** % of the shipped text contrast, APPEARANCE_CONTRAST_MIN..MAX. */
  contrast: number;
  /** Tint direction, degrees. Irrelevant at tint 0. */
  hue: number;
  /** Tint amount as a % of the neutral cap: 0 is grey, 100 is the cap, above it is "tinted chrome". */
  tint: number;
}

export const DEFAULT_CHROME_KNOBS: ChromeKnobs = { brightness: 0, contrast: 100, hue: DEFAULT_APPEARANCE_HUE, tint: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function hslLightness(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  return ((Math.max(r, g, b) + Math.min(r, g, b)) / 2) * 100;
}

/** The ink contrast on the panel at 100% contrast (the dark ramp's ink on its g1). */
const SHIPPED_INK_RATIO = contrastRatio(RAMPS.dark.base['--theme-text'], RAMPS.dark.base['--theme-bg-surface']);

/**
 * Where the four sliders sit for a resolved theme. `fallbackHue` is kept when the theme is
 * neutral (a grey has no hue to read), so dragging tint up again resumes from the last hue.
 */
export function readChromeKnobs(values: Record<string, string>, fallbackHue = DEFAULT_APPEARANCE_HUE): ChromeKnobs {
  const surface = resolveHex(values, '--theme-ui-g1');
  const ink = resolveHex(values, '--theme-ui-ink');
  if (!surface || !ink) return { ...DEFAULT_CHROME_KNOBS, hue: fallbackHue };

  // Brightness is linear in the surface's HSL lightness between the dark anchor and its mirror.
  const anchorL = hslLightness(RAMPS.dark.base['--theme-bg-surface']);
  const brightness = clamp(Math.round(((hslLightness(surface) - anchorL) / (100 - 2 * anchorL)) * 100), 0, 100);

  const chroma = chromaOf(surface);
  const tint = clamp(Math.round((chroma / TINT_CHROMA_CAP) * 100), 0, APPEARANCE_TINT_MAX);
  const hue = chroma > 0.002 ? Math.round(hexToOklch(surface).h) % 360 : fallbackHue;

  // Contrast scale: distance of the ink ratio above 1.0, against the shipped ink's. Quantised
  // to the slider's 5% step; ink saturates at the pole, so this is a best read, not exact.
  const scale = ((contrastRatio(ink, surface) - 1) / (SHIPPED_INK_RATIO - 1)) * 100;
  const contrast = clamp(Math.round(scale / 5) * 5, APPEARANCE_CONTRAST_MIN, APPEARANCE_CONTRAST_MAX);

  return { brightness, contrast, hue, tint };
}

/**
 * Re-derive every surface / ink token of `theme` from the knobs, keeping everything else
 * (palette, accent-family overrides, panel-local choices) as the author left it.
 */
export function applyChromeKnobs(theme: ThemeFile, accent: string, knobs: ChromeKnobs): ThemeFile {
  const built = buildAppearanceTheme(accent, knobs.brightness, {
    hue: knobs.hue,
    saturation: knobs.tint,
    contrast: knobs.contrast,
  }) as ThemeFile;
  const detached = Array.from(new Set([...(theme.derivationDetached ?? []), ...built.derivationDetached]));
  return {
    ...theme,
    ramp: built.ramp,
    derivationDetached: detached,
    tokens: { ...theme.tokens, ...built.tokens },
  };
}

/** The same theme with the tint taken to exactly zero (chroma 0 on every surface and ink). */
export function neutralizeTheme(theme: ThemeFile, accent: string, values: Record<string, string>): ThemeFile {
  const knobs = readChromeKnobs(values);
  return applyChromeKnobs(theme, accent, { ...knobs, tint: 0 });
}

/** How many of the 16 identity colours sit within `degrees` (OKLCH) of the accent's hue. */
export function accentIdentityClashes(values: Record<string, string>, degrees = 20): number {
  const accent = resolveHex(values, '--theme-accent');
  if (!accent) return 0;
  const ah = hexToOklch(accent).h;
  let n = 0;
  for (let i = 1; i <= 16; i++) {
    const c = resolveHex(values, `--theme-track-palette-${i}`);
    if (!c) continue;
    const d = Math.abs(hexToOklch(c).h - ah) % 360;
    if ((d > 180 ? 360 - d : d) < degrees) n++;
  }
  return n;
}
