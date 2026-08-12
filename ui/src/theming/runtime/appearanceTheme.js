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

// Every anchor below is hue 240 (the shipped blue-grey cast), so a single
// absolute hue replaces it across the whole chrome family. This is the UI
// *chrome* hue and is deliberately independent of --theme-accent: that is what
// lets you run, say, dark pink surfaces under a green accent.
export const DEFAULT_APPEARANCE_HUE = 240;
// Multiplier on each anchor's shipped saturation, as a percentage. A multiplier
// rather than an absolute value so the palette keeps its internal relationships
// (surfaces carry slightly more saturation than the text tiers). Needed because
// the shipped saturation is only ~16% — enough for a faint cast, not enough to
// read as an actual color, so a hue change alone looks nearly grey.
export const DEFAULT_APPEARANCE_SATURATION = 100;
// Scales how far each text tier sits from its background. See contrastTarget().
export const DEFAULT_APPEARANCE_CONTRAST = 100;

// Shipped Xleth Default values for the three tokens brightness drives, per
// ui/src/theming/tokens/base.ts BASE_DEFAULTS. These are the darkness=0
// anchor — the slider's "Lowest is near-black with light text" endpoint.
const BRIGHTNESS_ANCHORS = {
  '--theme-bg-primary': '#0A0A0F',
  '--theme-bg-surface': '#1A1A24',
  '--theme-text': '#E8E8ED',
  // The recessed "well" surface behind inputs, meters, readouts, canvases and
  // the mixer/sampler chrome (via --mx-s0 / --sampler-s0 / --xleth-flat-well,
  // all of which alias this). It ships as an explicit fixed color in the
  // catalog (tokens/catalog.ts) and so was the one anchor the brightness
  // slider never moved — leaving every well pitch-black in a light theme.
  // Mirrored here alongside the others: at darkness=0 it stays the shipped
  // #0d0d14, and it lands slightly darker than bg-primary at every point
  // (L 4.9 vs 2.9 at the dark end, 95.1 vs 97.1 at the light end), so the
  // "inset is recessed" relationship holds across the whole range.
  '--theme-bg-inset': '#0d0d14',
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

// ── Surfaces: a plain linear ramp ─────────────────────────────────────────
// Moves a token's lightness from its dark-default anchor toward its mirror
// image (100 - L) as `darkness` runs 0 -> 100, holding hue/saturation fixed.
// At darkness=0 this is byte-identical to the anchor; at darkness=100 it
// lands on the mirrored lightness — together the two endpoints match the
// "near-black / light text" .. "light grey / dark text" slider labels
// without hardcoding either endpoint color by hand.
//
// The ramp is deliberately LINEAR. The slider has to behave like a real
// brightness control: 0% genuinely darkest, 50% genuinely mid, 100% genuinely
// lightest, with visible movement at every step. Earlier revisions tried to
// flatten this curve to dodge the mid-slider contrast collapse; that bought
// legibility by making most of the slider do nothing, which is the wrong
// trade. Contrast is now handled where it belongs — in the text, below.
function brightnessShift(anchorHex, darkness, tintOpts) {
  const { s, l } = tintOf(anchorHex, tintOpts);
  const t = Math.max(0, Math.min(100, darkness)) / 100;
  const targetL = 100 - l;
  return hslToHex({ h: tintOpts.hue, s, l: l + t * (targetL - l) });
}

// Re-tints an anchor: the chrome hue replaces the anchor's own (all anchors are
// 240, so this is a clean substitution) and its saturation is scaled. Lightness
// is untouched here — brightness and the contrast solver own that axis.
function tintOf(anchorHex, { hue, saturation }) {
  const hsl = hexToHsl(anchorHex);
  return {
    h: hue,
    s: Math.max(0, Math.min(100, hsl.s * saturation)),
    l: hsl.l,
  };
}

// Scales a tier's target ratio. Done in "distance above 1.0" space because a
// ratio of 1.0 means *no* contrast — scaling 14:1 by 0.5 would give 7:1, still
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
// an input to the calculation — it was only ever an accident of the two
// ramps' relative positions.
//
// Text is now computed from the resolved background: pick the direction that
// can actually produce contrast (lighter or darker than this background),
// then move exactly as far as needed to hit the tier's target ratio. Because
// the target is a ratio against the real background, the two can no longer
// converge — contrast is guaranteed by construction at every slider position.

// WCAG 2.1 relative luminance. This, not HSL lightness, is what perceived
// contrast is actually computed from — the whole reason the old L-space math
// couldn't reason about legibility.
function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const ch = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

// WCAG contrast ratio between two relative luminances.
function contrastOf(lumA, lumB) {
  const hi = Math.max(lumA, lumB);
  const lo = Math.min(lumA, lumB);
  return (hi + 0.05) / (lo + 0.05);
}

// Solve for the HSL lightness that produces `targetLum` at a fixed hue and
// saturation. Luminance rises monotonically with L, so bisection converges;
// 24 iterations resolves far finer than an 8-bit channel can represent.
function lightnessForLuminance(h, s, targetLum) {
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (relativeLuminance(hslToHex({ h, s, l: mid })) < targetLum) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// The shipped text tiers. Each contributes two things: its hue/saturation
// (so the palette keeps its faint blue cast rather than going pure grey) and
// its contrast ratio against the shipped dark bg-surface. Those ratios are
// the spec — the promise is that a tier is never LESS readable at any
// brightness than it is in the shipped dark theme, wherever physics allows.
const TEXT_ANCHORS = {
  '--theme-text': '#E8E8ED',
  '--theme-text-muted': '#8888A0',
  '--theme-text-subtle': '#555566',
  '--theme-text-placeholder': '#555566',
};

// --theme-border-subtle is derived from TEXT in derivation.ts (a fixed
// -72.7 L offset). That breaks once text goes dark for a light theme: the
// offset underflows, clamps at 0, and every border paints pure black. It is
// really a surface-relative token, so it is re-derived here as a fixed step
// off bg-surface instead, flipping direction with the theme's polarity.
const BORDER_SUBTLE_ANCHOR = '#2A2A38';

/**
 * True when this background wants light text — i.e. white out-contrasts black
 * against it. The switchover sits at relative luminance ~0.179 (where
 * (L+0.05)^2 === 1.05*0.05), which is the point of MAXIMUM difficulty: both
 * poles yield only ~4.58:1 there. That 4.58 is the floor of this whole
 * design, and it still clears WCAG AA for body text (4.5) — so even the
 * hardest possible background stays readable.
 */
function prefersLightText(bgHex) {
  const bgLum = relativeLuminance(bgHex);
  return contrastOf(1, bgLum) >= contrastOf(0, bgLum);
}

/**
 * Resolve one text tier against a background.
 *
 * `goLight` is decided ONCE from bg-surface and passed to every tier, so the
 * tiers always move as a family. Deciding per-tier would let a low-target
 * tier pick the opposite pole from primary text near the switchover (light
 * grey subtext beside black body text on the same card).
 *
 * When the target ratio is unreachable in the chosen direction the value
 * clamps to the pole (pure white / pure black) — the most contrast that
 * background physically admits.
 */
function contrastText(anchorHex, bgHex, goLight, tintOpts, contrastScale) {
  const { h, s } = tintOf(anchorHex, tintOpts);
  // The target is measured from the UNTINTED shipped anchors: it is a ratio
  // spec, so it must not drift when the user changes hue or saturation. Only
  // the resolved output color carries the tint.
  const target = contrastTarget(
    contrastOf(
      relativeLuminance(anchorHex),
      relativeLuminance(BRIGHTNESS_ANCHORS['--theme-bg-surface']),
    ),
    contrastScale,
  );
  const bgLum = relativeLuminance(bgHex);
  // Invert the contrast formula for the needed luminance in each direction.
  const lum = goLight
    ? Math.min(1, target * (bgLum + 0.05) - 0.05)
    : Math.max(0, (bgLum + 0.05) / target - 0.05);
  // Solving in the TINTED hue matters: luminance is hue-weighted (green 0.7152
  // vs blue 0.0722), so the same target ratio lands on a very different
  // lightness for green chrome than for blue. lightnessForLuminance handles it.
  return hslToHex({ h, s, l: lightnessForLuminance(h, s, lum) });
}

// Border: same fixed lightness step off the surface as the shipped palette
// (+7.1 L), flipped to -7.1 once the theme turns light so borders read as a
// recess at both ends instead of clamping to black.
function borderSubtle(bgHex, goLight, tintOpts) {
  const anchor = hexToHsl(BORDER_SUBTLE_ANCHOR);
  const shippedSurface = hexToHsl(BRIGHTNESS_ANCHORS['--theme-bg-surface']);
  const step = anchor.l - shippedSurface.l;
  const bg = hexToHsl(bgHex);
  const { h, s } = tintOf(BORDER_SUBTLE_ANCHOR, tintOpts);
  const l = Math.max(0, Math.min(100, bg.l + (goLight ? step : -step)));
  return hslToHex({ h, s, l });
}

const clampNumber = (value, lo, hi, fallback) =>
  (Number.isFinite(value) ? Math.max(lo, Math.min(hi, value)) : fallback);

/**
 * Build a ThemeFile from the user's appearance preferences.
 *
 * @param {string} accent  Hex color string, e.g. '#33CED6'. Independent of the
 *   chrome hue below, so a green accent over pink chrome is a valid combination.
 * @param {number} darkness  0 = shipped dark default, 100 = mirrored light
 * @param {object} [options]
 * @param {number} [options.hue]  Chrome hue 0-360 (default 240, the shipped cast)
 * @param {number} [options.saturation]  % of shipped chrome saturation, 0-300
 * @param {number} [options.contrast]  % of shipped text contrast, 60-160. The
 *   floor is 60 rather than 0 on purpose: below roughly 60% the decorative
 *   subtle tier drops under ~1.8:1 and stops being readable at all, which is
 *   not a setting worth offering.
 * @returns {import('../schema/types').ThemeFile}
 */
export function buildAppearanceTheme(accent, darkness, options = {}) {
  const d = Number.isFinite(darkness) ? darkness : DEFAULT_APPEARANCE_DARKNESS;
  // Hue wraps rather than clamps — it is a circular axis, so 370 is 10.
  const hue = Number.isFinite(options.hue)
    ? ((options.hue % 360) + 360) % 360
    : DEFAULT_APPEARANCE_HUE;
  const tintOpts = {
    hue,
    saturation: clampNumber(options.saturation, 0, 300, DEFAULT_APPEARANCE_SATURATION) / 100,
  };
  const contrastScale = clampNumber(options.contrast, 60, 160, DEFAULT_APPEARANCE_CONTRAST) / 100;

  const bgPrimary = brightnessShift(BRIGHTNESS_ANCHORS['--theme-bg-primary'], d, tintOpts);
  const bgSurface = brightnessShift(BRIGHTNESS_ANCHORS['--theme-bg-surface'], d, tintOpts);
  const bgInset = brightnessShift(BRIGHTNESS_ANCHORS['--theme-bg-inset'], d, tintOpts);

  // One polarity decision for the whole theme, taken from bg-surface (the
  // most common surface text actually sits on). bg-primary and bg-inset track
  // it closely enough that text stays correct on them too — and where they
  // differ they are FURTHER from the text pole, so contrast only improves.
  const goLight = prefersLightText(bgSurface);

  return {
    schemaVersion: 1,
    name: 'User Appearance',
    author: 'user',
    description: '',
    locked: false,
    // These four are normally derived by fixed lightness offsets in
    // derivation.ts. Those offsets assume a dark theme and a text color that
    // never moves far, so they underflow into flat black once the theme goes
    // light. Detached here because this file resolves them against the actual
    // background instead.
    derivationDetached: [
      '--theme-text-muted',
      '--theme-text-subtle',
      '--theme-text-placeholder',
      '--theme-border-subtle',
    ],
    tokens: {
      '--theme-accent': accent ?? DEFAULT_APPEARANCE_ACCENT,
      '--theme-bg-primary': bgPrimary,
      '--theme-bg-surface': bgSurface,
      '--theme-bg-inset': bgInset,
      '--theme-text': contrastText(TEXT_ANCHORS['--theme-text'], bgSurface, goLight, tintOpts, contrastScale),
      '--theme-text-muted': contrastText(TEXT_ANCHORS['--theme-text-muted'], bgSurface, goLight, tintOpts, contrastScale),
      '--theme-text-subtle': contrastText(TEXT_ANCHORS['--theme-text-subtle'], bgSurface, goLight, tintOpts, contrastScale),
      '--theme-text-placeholder': contrastText(TEXT_ANCHORS['--theme-text-placeholder'], bgSurface, goLight, tintOpts, contrastScale),
      '--theme-border-subtle': borderSubtle(bgSurface, goLight, tintOpts),
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
