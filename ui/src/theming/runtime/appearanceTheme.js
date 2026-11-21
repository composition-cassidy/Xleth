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

import { RAMPS } from '../tokens/neutralRamp';

export const APPEARANCE_THEME_SLUG = 'user-appearance';
export const DEFAULT_APPEARANCE_ACCENT = '#33CED6';
export const DEFAULT_APPEARANCE_DARKNESS = 0;

// Phase 7: the anchors are the NEUTRAL ramp (ui/DESIGN.md section 3.1), not the old
// hue-240 blue-grey. Chrome is grey by default so picture colour is judged against a
// neutral surround. A faint tint is still offered: `hue` picks its direction and
// `saturation` (kept as the option/setting name) is now the tint AMOUNT as a
// percentage of NEUTRAL_TINT_CAP_CHROMA, the OKLCH chroma at which chrome stops
// reading as neutral. 0 is exact grey (the default), 100 is right at the cap, and
// the slider runs past it (to APPEARANCE_TINT_MAX) so the editor can warn, rather
// than silently refuse, when someone asks for tinted chrome.
export const DEFAULT_APPEARANCE_HUE = 240;
export const DEFAULT_APPEARANCE_SATURATION = 0;
export const APPEARANCE_TINT_MAX = 300;
// Text, outlines and dividers never carry more tint than the neutral cap, whatever the slider says.
const INK_TINT_MAX = 100;
// Must equal TINT_CHROMA_CAP in runtime/chromeTint.ts (a unit test asserts it).
export const NEUTRAL_TINT_CAP_CHROMA = 0.012;
// Scales how far each text tier sits from its background. See contrastTarget().
export const DEFAULT_APPEARANCE_CONTRAST = 100;
// Below 80% the dimmest text tier (ink-3, 5.5:1 on the panel) drops under the 4.5:1
// DAW Floor, so the knob does not go there.
export const APPEARANCE_CONTRAST_MIN = 80;
export const APPEARANCE_CONTRAST_MAX = 160;

// The dark ramp's neutral values (ui/DESIGN.md 3.1; tokens/neutralRamp.ts). These are the
// darkness=0 anchors: the slider's "lowest is near-black with light text" endpoint.
const BRIGHTNESS_ANCHORS = {
  '--theme-bg-primary': RAMPS.dark.base['--theme-bg-primary'], // g0
  '--theme-bg-surface': RAMPS.dark.base['--theme-bg-surface'], // g1
  '--theme-text': RAMPS.dark.base['--theme-text'],             // ink
  // The recessed "well" behind inputs, meters, canvases and the mixer/sampler chrome
  // (aliased as --xleth-flat-well / --mx-s0 / --sampler-s0). It is g0 in the default
  // theme; it is mirrored here so brightness moves it with the rest.
  '--theme-bg-inset': RAMPS.dark.base['--theme-bg-primary'],
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

// ── Tint: chroma-targeted greys ───────────────────────────────────────────
// A colour at HSL lightness `l` whose OKLCH chroma is `chroma` (0 = exact grey).
// Targeting chroma rather than HSL saturation keeps "how tinted is the chrome"
// comparable across brightness and hue (the same HSL saturation is far more visible
// at mid lightness, and in blue than in yellow), which is what the neutral cap needs.

// OKLCH chroma of a #RRGGBB colour (Ottosson's OKLab). Mirrors ui-kit/colorMath.ts,
// which cannot be imported here because it imports this module.
function oklabChroma(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lin = (c8) => {
    const c = c8 / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return Math.hypot(A, Bb);
}

function colorAt(h, l, chroma) {
  if (!(chroma > 1e-6)) return hslToHex({ h, s: 0, l });
  if (oklabChroma(hslToHex({ h, s: 100, l })) <= chroma) return hslToHex({ h, s: 100, l });
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 14; i += 1) {
    const mid = (lo + hi) / 2;
    if (oklabChroma(hslToHex({ h, s: mid, l })) < chroma) lo = mid;
    else hi = mid;
  }
  // Stay on the neutral side of the target: 'right at the cap' must not tip over it.
  return hslToHex({ h, s: lo, l });
}

// The tint of the chrome as a chroma target.
function tintOf({ hue, tint }) {
  return { h: hue, chroma: (tint / 100) * NEUTRAL_TINT_CAP_CHROMA };
}

// ── Surfaces: a plain linear ramp ─────────────────────────────────────────
// Moves a token's lightness from its dark-default anchor toward its mirror
// image (100 - L) as `darkness` runs 0 -> 100. At darkness=0 this is
// byte-identical to the anchor; at darkness=100 it lands on the mirrored
// lightness - together the two endpoints match the "near-black / light text" ..
// "light grey / dark text" slider labels without hardcoding either endpoint.
//
// The ramp is deliberately LINEAR. The slider has to behave like a real
// brightness control: 0% genuinely darkest, 50% genuinely mid, 100% genuinely
// lightest, with visible movement at every step. Earlier revisions tried to
// flatten this curve to dodge the mid-slider contrast collapse; that bought
// legibility by making most of the slider do nothing, which is the wrong
// trade. Contrast is handled where it belongs - in the text, below.
function brightnessShift(anchorHex, darkness, tintOpts) {
  const { l } = hexToHsl(anchorHex);
  const t = Math.max(0, Math.min(100, darkness)) / 100;
  const targetL = 100 - l;
  const { h, chroma } = tintOf(tintOpts);
  return colorAt(h, l + t * (targetL - l), chroma);
}

// Scales a tier's target ratio. Done in "distance above 1.0" space because a
// ratio of 1.0 means *no* contrast - scaling 14:1 by 0.5 would give 7:1, still
// punchy, not "half the contrast". This mapping is monotonic, so the tier
// ordering (primary > muted > subtle) survives any setting for free.
function contrastTarget(shippedRatio, contrastScale) {
  return 1 + (shippedRatio - 1) * contrastScale;
}

// ── Text: derived FROM the surface, to hit a contrast ratio ───────────────
// The original bug was structural, not a matter of tuning. Text was shifted
// along its OWN mirror (light anchor -> dark mirror) independently of the
// background's mirror. Two independent mirrors cross the midpoint together:
// any L and its mirror 100-L meet at exactly 50, so at mid-slider the
// background and every text tier all converged on L=50 and contrast fell to
// ~1.06 (invisible). No easing curve fixes that, because contrast was never
// an input to the calculation.
//
// Text is now computed from the resolved background: pick the direction that
// can actually produce contrast (lighter or darker than this background),
// then move exactly as far as needed to hit the tier's target ratio. Because
// the target is a ratio against the real background, the two can no longer
// converge - contrast is guaranteed by construction at every slider position.

// WCAG 2.1 relative luminance. This, not HSL lightness, is what perceived
// contrast is actually computed from.
export function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const ch = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

// WCAG contrast ratio between two relative luminances.
export function contrastOf(lumA, lumB) {
  const hi = Math.max(lumA, lumB);
  const lo = Math.min(lumA, lumB);
  return (hi + 0.05) / (lo + 0.05);
}

// Solve for the HSL lightness that produces `targetLum` at a fixed hue and
// chroma. Luminance rises monotonically with L, so bisection converges.
function lightnessForLuminance(h, chroma, targetLum) {
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 20; i += 1) {
    const mid = (lo + hi) / 2;
    if (relativeLuminance(colorAt(h, mid, chroma)) < targetLum) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// The text tiers. Each contributes its contrast ratio against the shipped dark
// bg-surface (g1): that ratio is the spec - a tier is never LESS readable at any
// brightness than it is in the shipped dark theme, wherever physics allows. They
// are the ramp's ink / ink-2 / ink-3 (ink-3 is the dimmest text allowed anywhere,
// 5.54:1), so every tier clears the 4.5:1 floor.
const TEXT_ANCHORS = {
  '--theme-text': RAMPS.dark.base['--theme-text'],              // ink
  '--theme-text-muted': '#B4B4B4',                              // ink-2
  '--theme-text-subtle': '#9A9A9A',                             // ink-3
  '--theme-text-placeholder': '#9A9A9A',                        // ink-3
};

// --theme-border-subtle is the ramp's g4 divider: a fixed lightness step off the
// surface, flipping direction with the theme's polarity so it reads as a recess at
// both ends instead of clamping to black.
const BORDER_SUBTLE_ANCHOR = '#444444';

// Control outlines (ui-boundary) must clear 3:1 on EVERY surface step, not just the
// panel; solved against the least favourable one with a little headroom.
const BOUNDARY_TARGET = 3.1;
// WCAG AA is 4.5:1; every ink tier holds it on every ramp surface. Solved with a little
// headroom so 8-bit rounding of the result cannot land a hair under the floor.
const FLOOR_RATIO = 4.56;

/**
 * Resolve one text tier against a reference background.
 *
 * `goLight` is decided ONCE from bg-surface and passed to every tier, so the
 * tiers always move as a family. When the target ratio is unreachable in the
 * chosen direction the value clamps to the pole (pure white / pure black) - the
 * most contrast that background physically admits.
 */
function contrastText(anchorHex, bgHex, goLight, tintOpts, contrastScale, fixedTarget, floorBgHex) {
  const { h, chroma } = tintOf(tintOpts);
  // The target is measured from the UNTINTED shipped anchors: it is a ratio
  // spec, so it must not drift when the tint changes.
  const target = fixedTarget ?? contrastTarget(
    contrastOf(
      relativeLuminance(anchorHex),
      relativeLuminance(BRIGHTNESS_ANCHORS['--theme-bg-surface']),
    ),
    contrastScale,
  );
  const bgLum = relativeLuminance(bgHex);
  // Invert the contrast formula for the needed luminance in each direction.
  let lum = goLight
    ? Math.min(1, target * (bgLum + 0.05) - 0.05)
    : Math.max(0, (bgLum + 0.05) / target - 0.05);
  // The ratio is the spec on `bgHex` (the panel). The Floor must also hold on every other
  // ramp surface, so where the panel-relative value would fall short on the least
  // favourable one (`floorBgHex`), the text moves further out to reach FLOOR_RATIO there.
  if (floorBgHex) {
    const floorLum = relativeLuminance(floorBgHex);
    lum = goLight
      ? Math.max(lum, Math.min(1, FLOOR_RATIO * (floorLum + 0.05) - 0.05))
      : Math.min(lum, Math.max(0, (floorLum + 0.05) / FLOOR_RATIO - 0.05));
  }
  let l = lightnessForLuminance(h, chroma, lum);
  // 8-bit rounding can land a hair under the ratio the solver asked for (a single step is
  // ~0.1:1 near black). Step toward the pole until both requirements actually hold.
  const need = [[bgHex, target]];
  if (floorBgHex) need.push([floorBgHex, FLOOR_RATIO]);
  for (let i = 0; i < 40 && l > 0 && l < 100; i += 1) {
    const hex = colorAt(h, l, chroma);
    const short = need.some(([bg, ratio]) => contrastOf(relativeLuminance(hex), relativeLuminance(bg)) < ratio - 1e-9);
    if (!short) break;
    l += goLight ? 0.2 : -0.2;
  }
  return colorAt(h, l, chroma);
}

// Border: the same lightness step off the surface as the ramp's g4.
function borderSubtle(bgHex, goLight, tintOpts) {
  const anchor = hexToHsl(BORDER_SUBTLE_ANCHOR);
  const shippedSurface = hexToHsl(BRIGHTNESS_ANCHORS['--theme-bg-surface']);
  const step = anchor.l - shippedSurface.l;
  const bg = hexToHsl(bgHex);
  const { h, chroma } = tintOf(tintOpts);
  return colorAt(h, Math.max(0, Math.min(100, bg.l + (goLight ? step : -step))), chroma);
}

const clampNumber = (value, lo, hi, fallback) =>
  (Number.isFinite(value) ? Math.max(lo, Math.min(hi, value)) : fallback);

/**
 * Build a ThemeFile from the user's appearance preferences.
 *
 * @param {string} accent  Hex color string, e.g. '#33CED6'. Independent of the
 *   chrome tint, so a green accent over pink-tinted chrome is a valid combination.
 * @param {number} darkness  0 = shipped dark default, 100 = mirrored light
 * @param {object} [options]
 * @param {number} [options.hue]  Tint direction 0-360 (wraps). Irrelevant at tint 0.
 * @param {number} [options.saturation]  Tint amount, % of NEUTRAL_TINT_CAP_CHROMA,
 *   0-APPEARANCE_TINT_MAX. 0 (default) is exact grey; above 100 is "tinted chrome".
 * @param {number} [options.contrast]  % of shipped text contrast,
 *   APPEARANCE_CONTRAST_MIN-APPEARANCE_CONTRAST_MAX.
 * @returns {import('../schema/types').ThemeFile}
 */
export function buildAppearanceTheme(accent, darkness, options = {}) {
  const d = Number.isFinite(darkness) ? darkness : DEFAULT_APPEARANCE_DARKNESS;
  // Hue wraps rather than clamps - it is a circular axis, so 370 is 10.
  const hue = Number.isFinite(options.hue)
    ? ((options.hue % 360) + 360) % 360
    : DEFAULT_APPEARANCE_HUE;
  const tintOpts = {
    hue,
    tint: clampNumber(options.saturation, 0, APPEARANCE_TINT_MAX, DEFAULT_APPEARANCE_SATURATION),
  };
  const contrastScale = clampNumber(
    options.contrast, APPEARANCE_CONTRAST_MIN, APPEARANCE_CONTRAST_MAX, DEFAULT_APPEARANCE_CONTRAST,
  ) / 100;

  const bgPrimary = brightnessShift(BRIGHTNESS_ANCHORS['--theme-bg-primary'], d, tintOpts);
  const bgSurface = brightnessShift(BRIGHTNESS_ANCHORS['--theme-bg-surface'], d, tintOpts);
  const bgInset = brightnessShift(BRIGHTNESS_ANCHORS['--theme-bg-inset'], d, tintOpts);

  // The ramp's four surfaces (g0..g3) must all be able to carry text at the Floor. White
  // clears 4.5:1 only on surfaces with relative luminance <= ~0.183, black only on >= ~0.175,
  // so near mid brightness the raised steps (g2, g3) can push a surface past the pole that
  // suits the panel. For light text the raised steps are therefore clamped to that
  // luminance (they flatten toward the panel rather than leaving the text's reach); for dark
  // text, raising only helps. The polarity is whichever pole has the better worst case.
  const { h: tintH, chroma: tintC } = tintOf(tintOpts);
  const surfaceL = hexToHsl(bgSurface).l;
  const WHITE_MAX_LUM = 1.05 / FLOOR_RATIO - 0.05;
  const raised = (step, clampForLightText) => {
    let l = Math.max(0, Math.min(100, surfaceL + step));
    let hex = colorAt(tintH, l, tintC);
    if (clampForLightText) {
      const cap = Math.max(WHITE_MAX_LUM, relativeLuminance(bgSurface));
      while (l > surfaceL && relativeLuminance(hex) > cap) {
        l -= 0.25;
        hex = colorAt(tintH, l, tintC);
      }
    }
    return hex;
  };
  const surfacesFor = (lightText) => [
    bgPrimary,
    bgSurface,
    raised(RAMPS.dark.steps.g2, lightText),
    raised(RAMPS.dark.steps.g3, lightText),
  ];
  const worstRatio = (surfaces, poleLum) => Math.min(...surfaces.map((x) => contrastOf(poleLum, relativeLuminance(x))));
  const lightSurfaces = surfacesFor(true);
  const darkSurfaces = surfacesFor(false);
  const goLight = worstRatio(lightSurfaces, 1) >= worstRatio(darkSurfaces, 0);
  const ramp = goLight ? 'dark' : 'light';
  const surfaces = goLight ? lightSurfaces : darkSurfaces;
  const lums = surfaces.map(relativeLuminance);
  const refBg = surfaces[lums.indexOf(goLight ? Math.max(...lums) : Math.min(...lums))];

  // Only the SURFACES may carry the tint past the neutral cap (the editor warns when they do).
  // Text tiers, outlines and dividers are held at the cap at most, so a 300% tint never turns
  // labels and control outlines into the tint colour.
  const inkTintOpts = { hue: tintOpts.hue, tint: Math.min(tintOpts.tint, INK_TINT_MAX) };
  const text = contrastText(TEXT_ANCHORS['--theme-text'], bgSurface, goLight, inkTintOpts, contrastScale, undefined, refBg);
  const muted = contrastText(TEXT_ANCHORS['--theme-text-muted'], bgSurface, goLight, inkTintOpts, contrastScale, undefined, refBg);
  const subtle = contrastText(TEXT_ANCHORS['--theme-text-subtle'], bgSurface, goLight, inkTintOpts, contrastScale, undefined, refBg);

  // The divider (legacy border-subtle and the ramp's g4) is a line, not a surface: it holds at the cap.
  const borderDivider = borderSubtle(bgSurface, goLight, inkTintOpts);

  return {
    schemaVersion: 1,
    name: 'User Appearance',
    author: 'user',
    description: '',
    locked: false,
    ramp,
    // The legacy text and border tokens, and the ramp's ink-2 / ink-3 / boundary, are
    // normally derived by fixed lightness steps. Those steps assume the shipped base
    // text, so they are resolved here against the actual surfaces instead.
    derivationDetached: [
      '--theme-text-muted',
      '--theme-text-subtle',
      '--theme-text-placeholder',
      '--theme-border-subtle',
      '--theme-ui-g2',
      '--theme-ui-g3',
      '--theme-ui-g4',
      '--theme-ui-ink-2',
      '--theme-ui-ink-3',
      '--theme-ui-boundary',
    ],
    tokens: {
      '--theme-accent': accent ?? DEFAULT_APPEARANCE_ACCENT,
      '--theme-bg-primary': bgPrimary,
      '--theme-bg-surface': bgSurface,
      '--theme-bg-inset': bgInset,
      '--theme-text': text,
      '--theme-text-muted': muted,
      '--theme-text-subtle': subtle,
      '--theme-text-placeholder': subtle,
      '--theme-border-subtle': borderDivider,
      '--theme-ui-g4': borderDivider,
      '--theme-ui-g2': surfaces[2],
      '--theme-ui-g3': surfaces[3],
      '--theme-ui-ink-2': muted,
      '--theme-ui-ink-3': subtle,
      '--theme-ui-boundary': contrastText(TEXT_ANCHORS['--theme-text'], refBg, goLight, inkTintOpts, contrastScale, BOUNDARY_TARGET),
    },
  };
}

// The settings keys `appearanceHue` / `appearanceSaturation` / `appearanceContrast` predate
// the neutral ramp. Saturation used to be a multiplier on the blue-grey anchors' own ~16%
// saturation (100 = the shipped cast); it is now a tint amount measured against the neutral
// cap. Files saved with `appearanceModelVersion` < 2 are re-read through this once.
export const APPEARANCE_MODEL_VERSION = 2;
const LEGACY_CAST_CHROMA = 0.025; // typical OKLCH chroma of the old 100% blue-grey surfaces

/**
 * Map pre-Phase-7 knob positions onto the current model. The untouched legacy default
 * (hue 240, saturation 100) becomes exact grey; a deliberately tinted theme keeps its hue
 * and a proportional tint (clamped to the slider), so it still reads as the cast the user
 * chose. Contrast is raised to the new minimum. Nothing here rewrites a saved theme file:
 * the file keeps loading as-is, this only decides where the sliders re-open.
 */
export function migrateLegacyAppearance({ hue, saturation, contrast }) {
  const h = Number.isFinite(hue) ? ((hue % 360) + 360) % 360 : DEFAULT_APPEARANCE_HUE;
  const mult = Number.isFinite(saturation) ? Math.max(0, saturation) : 100;
  const untouched = h === 240 && mult === 100;
  const tint = untouched
    ? 0
    : Math.min(APPEARANCE_TINT_MAX, Math.round(((mult / 100) * LEGACY_CAST_CHROMA) / NEUTRAL_TINT_CAP_CHROMA * 100 / 5) * 5);
  return {
    hue: h,
    saturation: tint,
    contrast: clampNumber(contrast, APPEARANCE_CONTRAST_MIN, APPEARANCE_CONTRAST_MAX, DEFAULT_APPEARANCE_CONTRAST),
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
