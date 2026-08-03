// Builds the ThemeFile for the Settings > Appearance controls (accent color
// + brightness). Brightness follows the token system's monochromatic
// derivation model: it overrides the three base tokens that anchor the
// surface/text hierarchy (--theme-bg-primary, --theme-bg-surface,
// --theme-text) by shifting each one's HSL lightness — hue and saturation
// are left untouched. Every derived surface-hierarchy token
// (bg-secondary/tertiary/hover/active/elevated, text-muted/subtle/
// placeholder, border-subtle, etc., see tokens/derivation.ts) cascades from
// these three the same way any theme's tokens do. Brightness never touches
// document-root CSS filters, so content painted outside the token system
// (e.g. the video preview) is unaffected.

export const APPEARANCE_THEME_SLUG = 'user-appearance';
export const DEFAULT_APPEARANCE_ACCENT = '#33CED6';
export const DEFAULT_APPEARANCE_DARKNESS = 0;

// Shipped Xleth Default values for the three tokens brightness drives, per
// ui/src/theming/tokens/base.ts BASE_DEFAULTS. These are the darkness=0
// anchor — the slider's "Lowest is near-black with light text" endpoint.
const BRIGHTNESS_ANCHORS = {
  '--theme-bg-primary': '#0A0A0F',
  '--theme-bg-surface': '#1A1A24',
  '--theme-text': '#E8E8ED',
};

function normalizeHex(hex) {
  const h = hex.trim().replace(/^#/, '');
  if (h.length === 3) return '#' + h.split('').map(c => c + c).join('').toLowerCase();
  return '#' + h.slice(0, 6).toLowerCase();
}

function hexToRgb(hex) {
  const h = normalizeHex(hex).slice(1);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex(r, g, b) {
  const to = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
  return '#' + to(r) + to(g) + to(b);
}

function hexToHsl(hex) {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * (((bn - rn) / d) + 2);
    else h = 60 * (((rn - gn) / d) + 4);
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

function hslToHex({ h, s, l }) {
  const hn = ((h % 360) + 360) % 360;
  const sn = Math.max(0, Math.min(100, s)) / 100;
  const ln = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;
  let r = 0, g = 0, b = 0;
  if (hn < 60) { r = c; g = x; b = 0; }
  else if (hn < 120) { r = x; g = c; b = 0; }
  else if (hn < 180) { r = 0; g = c; b = x; }
  else if (hn < 240) { r = 0; g = x; b = c; }
  else if (hn < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

// Moves a token's lightness from its dark-default anchor toward its mirror
// image (100 - L) as `darkness` runs 0 -> 100, holding hue/saturation fixed.
// At darkness=0 this is byte-identical to the anchor; at darkness=100 it
// lands on the mirrored lightness — together the two endpoints match the
// "near-black / light text" .. "light grey / dark text" slider labels
// without hardcoding either endpoint color by hand.
function brightnessShift(anchorHex, darkness) {
  const hsl = hexToHsl(anchorHex);
  const t = Math.max(0, Math.min(100, darkness)) / 100;
  const targetL = 100 - hsl.l;
  const l = hsl.l + t * (targetL - hsl.l);
  return hslToHex({ h: hsl.h, s: hsl.s, l });
}

/**
 * Build a ThemeFile from the user's accent color and darkness (0-100) preference.
 * @param {string} accent  Hex color string, e.g. '#33CED6'
 * @param {number} darkness  0 = shipped dark default, 100 = mirrored light
 * @returns {import('../schema/types').ThemeFile}
 */
export function buildAppearanceTheme(accent, darkness) {
  const d = Number.isFinite(darkness) ? darkness : DEFAULT_APPEARANCE_DARKNESS;
  return {
    schemaVersion: 1,
    name: 'User Appearance',
    author: 'user',
    description: '',
    locked: false,
    derivationDetached: [],
    tokens: {
      '--theme-accent': accent ?? DEFAULT_APPEARANCE_ACCENT,
      '--theme-bg-primary': brightnessShift(BRIGHTNESS_ANCHORS['--theme-bg-primary'], d),
      '--theme-bg-surface': brightnessShift(BRIGHTNESS_ANCHORS['--theme-bg-surface'], d),
      '--theme-text': brightnessShift(BRIGHTNESS_ANCHORS['--theme-text'], d),
    },
  };
}

/**
 * Ensure the hex string has a leading '#' and is 7 chars.
 * Returns the original string unchanged if it doesn't look like a hex color.
 * @param {string} hex
 * @returns {string}
 */
export function normalizeAccentHex(hex) {
  if (!hex) return DEFAULT_APPEARANCE_ACCENT;
  const s = hex.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s}`;
  return s;
}
