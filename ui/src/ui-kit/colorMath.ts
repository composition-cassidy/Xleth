// Colour maths for the UI kit and its contract tests: WCAG contrast, OKLCH
// conversion and hue distance. Pure, dependency-free, no DOM.
//
// WCAG luminance/contrast are re-used from theming/runtime/appearanceTheme.js
// (relativeLuminance, contrastOf) so there is ONE implementation of them in the
// renderer. OKLCH is new here: DESIGN.md measures all hue exclusion in OKLCH.

import { relativeLuminance, contrastOf } from '../theming/runtime/appearanceTheme.js';

export type Oklch = { l: number; c: number; h: number };

/** WCAG 2.x contrast ratio between two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  return contrastOf(relativeLuminance(a), relativeLuminance(b));
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`colorMath: expected #RRGGBB, got "${hex}"`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toLinear = (c8: number): number => {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (x: number): number => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

/** #RRGGBB -> OKLCH (Björn Ottosson's OKLab). `h` is degrees in [0, 360). */
export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

function oklchToLinearRgb({ l: L, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: number[]): boolean => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/**
 * OKLCH -> #RRGGBB (uppercase). If the colour is outside sRGB the chroma is
 * reduced (lightness and hue are kept) until it fits.
 */
export function oklchToHex(color: Oklch): string {
  let c = color.c;
  let rgb = oklchToLinearRgb({ ...color, c });
  while (!inGamut(rgb) && c > 0) {
    c = Math.max(0, c - 0.001);
    rgb = oklchToLinearRgb({ ...color, c });
  }
  return (
    '#' +
    rgb
      .map((v) => Math.round(255 * fromLinear(Math.min(1, Math.max(0, v)))).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

/** Shortest angular distance between two hues, degrees in [0, 180]. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The automatic label colour for text drawn on an identity colour: whichever of
 * the two inks contrasts more. Returns the chosen ink and its ratio.
 */
export function pickLabelInk(bg: string, light: string, dark: string): { ink: string; ratio: number } {
  const rl = contrastRatio(bg, light);
  const rd = contrastRatio(bg, dark);
  return rl >= rd ? { ink: light, ratio: rl } : { ink: dark, ratio: rd };
}
