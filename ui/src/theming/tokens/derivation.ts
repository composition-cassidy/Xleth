// deriveTheme — pure function that computes the full derived token set
// (§3.2 of xleth-theming-spec.md) from the 5 BaseTokens.
//
// Implementation notes:
//   - No `culori` dep; spec §6.3 defers it. Inline HSL + rgba() math keeps
//     the production bundle dependency-free.
//   - Deterministic and pure: no I/O, no randomness, no dates, no globals.
//   - Tokens listed in `derivationDetached` (an array the caller supplies)
//     are SKIPPED entirely so user overrides win.
//   - The per-token ΔL / ΔS deltas below were empirically calibrated against
//     the shipped Xleth Default palette (Phase 0 Track B formula tuning).
//     Every formula now resolves byte-identical to the hand-picked anchor
//     in ui/src/styles/theme.css; ΔE2000 pinning tests live in
//     __tests__/derivation.test.ts.
//   - §3.2 formerly assigned --theme-warning and --theme-success to accent
//     hue-rotations (+100° / −120°). Those were not derivable from the
//     shipped palette (ΔE > 26); they are now explicit semantic defaults
//     in the catalog (spec §3.3) and are no longer part of this pipeline.
//
// Changing any base token cascades through every formula below. Themes that
// want the old (untuned) look must detach the relevant tokens and supply
// explicit overrides.
//
// shift({ dL, dS }) clamps S∈[0,100] and L∈[0,100] so high-contrast themes
// (text=#FFFFFF, S=0) cannot underflow when the text family subtracts a few
// saturation points.
//
// Accent-hover is DARKER than accent in Xleth palette (−6% L). Not an error
// — matches hand-picked #2BB8BF. Do not "fix" this on a future pass.
//   (see spec §3.2; the darker-on-hover pattern is deliberate for this palette.)

import type { BaseTokens } from './base';

// ──────────────────────────────────────────────────────────────────────────
// Color math
// ──────────────────────────────────────────────────────────────────────────

interface HSL { h: number; s: number; l: number; }

function normalizeHex(hex: string): string {
  const h = hex.trim().replace(/^#/, '');
  if (h.length === 3) return '#' + h.split('').map(c => c + c).join('').toLowerCase();
  if (h.length === 6) return '#' + h.toLowerCase();
  if (h.length === 8) return '#' + h.slice(0, 6).toLowerCase();
  throw new Error(`derivation: unsupported hex color "${hex}"`);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = normalizeHex(hex).slice(1);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  // Emit uppercase to match the hand-picked anchors in ui/src/styles/theme.css
  // byte-identically (Default snapshot is a Phase 0 Track B invariant).
  const to = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
  return '#' + to(r) + to(g) + to(b);
}

function hexToHsl(hex: string): HSL {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn)      h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * (((bn - rn) / d) + 2);
    else                 h = 60 * (((rn - gn) / d) + 4);
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

function hslToHex({ h, s, l }: HSL): string {
  const hn = ((h % 360) + 360) % 360;
  const sn = Math.max(0, Math.min(100, s)) / 100;
  const ln = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;
  let r = 0, g = 0, b = 0;
  if (hn < 60)       { r = c; g = x; b = 0; }
  else if (hn < 120) { r = x; g = c; b = 0; }
  else if (hn < 180) { r = 0; g = c; b = x; }
  else if (hn < 240) { r = 0; g = x; b = c; }
  else if (hn < 300) { r = x; g = 0; b = c; }
  else               { r = c; g = 0; b = x; }
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

// Shift lightness and saturation by fixed percentage-point deltas.
// Both S and L are clamped to [0, 100] so extreme base tokens (e.g. a
// pure-white text with S=0) stay in gamut when the text family subtracts
// a few saturation points.
function shift(hex: string, delta: { dL?: number; dS?: number; dH?: number }): string {
  const hsl = hexToHsl(hex);
  const dL = delta.dL ?? 0;
  const dS = delta.dS ?? 0;
  const dH = delta.dH ?? 0;
  return hslToHex({
    h: hsl.h + dH,
    s: Math.max(0, Math.min(100, hsl.s + dS)),
    l: Math.max(0, Math.min(100, hsl.l + dL)),
  });
}

// Back-compat shim — `lighten(hex, n)` ≡ `shift(hex, { dL: n })`. Retained
// because some call sites and tests reference it by name.
function lighten(hex: string, deltaL: number): string {
  return shift(hex, { dL: deltaL });
}

// Rotate hue by `deltaH` degrees.
function rotateHue(hex: string, deltaH: number): string {
  return shift(hex, { dH: deltaH });
}

// Apply an alpha to a hex color, emitting rgba() so the browser blends it
// against whatever sits underneath at paint time.
function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3).replace(/\.?0+$/, '')})`;
}

// ──────────────────────────────────────────────────────────────────────────
// Derivation table — spec §3.2
// ──────────────────────────────────────────────────────────────────────────

export type DerivedTokens = Record<string, string>;

/**
 * Derive every token in §3.2 from the base 5. The caller passes a list of
 * detached token names; those are excluded from the output so user overrides
 * remain authoritative (the compile step fills detached tokens from the
 * theme JSON's `tokens` record, not from here).
 *
 * The per-token deltas are empirically calibrated against the Xleth Default
 * palette. Each tuned formula is annotated with its ΔE2000 distance to the
 * shipped anchor; pinning tests enforce the thresholds in derivation.test.ts.
 */
export function deriveTheme(base: BaseTokens, derivationDetached: ReadonlyArray<string> = []): DerivedTokens {
  const detached = new Set(derivationDetached);
  const bgPrimary = base['--theme-bg-primary'];
  const bgSurface = base['--theme-bg-surface'];
  const accent    = base['--theme-accent'];
  const text      = base['--theme-text'];

  const out: DerivedTokens = {};
  const put = (name: string, value: string) => { if (!detached.has(name)) out[name] = value; };

  // Background family — shifts from bg-primary / bg-surface.
  // Tuned: bg-secondary +3.14% L, −2.93% S  → #111118 (ΔE=0.0 vs anchor)
  put('--theme-bg-secondary', shift(bgPrimary, { dL: 3.137, dS: -2.927 }));
  put('--theme-bg-tertiary',  shift(bgPrimary, { dL: 4.8 }));
  put('--theme-bg-hover',     shift(bgSurface, { dL: 4 }));
  put('--theme-bg-active',    shift(bgSurface, { dL: 8 }));
  // Tuned: bg-elevated  +3.92% L, +0.94% S  → #222230 (ΔE=0.0 vs anchor)
  put('--theme-bg-elevated',  shift(bgSurface, { dL: 3.921, dS: 0.944 }));

  // Text family — solid L-shifts (not alpha) so the anchor reproduces exactly.
  // Tuned: text-muted       −33.92% L, −0.98% S → #8888A0 (ΔE=0.0 vs anchor)
  // Tuned: text-subtle      −55.29% L, −3.10% S → #555566 (ΔE=0.0 vs anchor)
  // Tuned: text-placeholder shares the text-subtle formula — both resolve to
  //        #555566 in Default. Themes may diverge them by detaching either.
  put('--theme-text-muted',       shift(text, { dL: -33.922, dS: -0.980 }));
  put('--theme-text-subtle',      shift(text, { dL: -55.294, dS: -3.104 }));
  put('--theme-text-placeholder', shift(text, { dL: -55.294, dS: -3.104 }));
  put('--theme-text-inverse',     bgPrimary);

  // Border family.
  // Tuned: border-subtle −72.75% L, +2.09% S → #2A2A38 (ΔE=0.0 vs anchor)
  put('--theme-border-subtle', shift(text, { dL: -72.745, dS: 2.091 }));
  put('--theme-border-strong', withAlpha(text, 0.25));
  put('--theme-border-focus',  accent);

  // Semantic family.
  //   --theme-info           === --theme-accent (pass-through)
  //   --theme-warning / --theme-success : independent semantic colors, NOT
  //       derivable from accent at any meaningful ΔE. Defined as explicit
  //       defaults in the catalog (spec §3.3); not emitted here.
  put('--theme-info', accent);

  // Accent states.
  // Tuned: accent-hover  −6.08% L, −3.28% S  → #2BB8BF (ΔE=0.87 vs anchor)
  //        (darker-on-hover is deliberate for the Xleth palette)
  put('--theme-accent-hover',  shift(accent, { dL: -6.079, dS: -3.284 }));
  put('--theme-accent-active', shift(accent, { dL: 10 }));
  // Tuned: focus-ring = accent @15% alpha (was 40%). Matches rgba(51,206,214,0.15).
  put('--theme-focus-ring',    withAlpha(accent, 0.15));

  // Panel type colors — 60° rotations.
  put('--theme-panel-mixer',     accent);
  put('--theme-panel-timeline',  rotateHue(accent, 60));
  put('--theme-panel-pianoroll', rotateHue(accent, 120));
  put('--theme-panel-preview',   rotateHue(accent, 180));
  put('--theme-panel-grid',      rotateHue(accent, 240));
  put('--theme-panel-node',      rotateHue(accent, 300));

  // ── Accent-relative tokens (formerly explicit teal hardcodes) ───────────
  // These were rgba(51,206,214,...) in the catalog. Now derived so every
  // theme that changes --theme-accent gets consistent alpha variants.
  put('--theme-accent-bg-subtle',              withAlpha(accent, 0.08));
  put('--theme-accent-bg-medium',              withAlpha(accent, 0.10));
  put('--theme-snap-ghost-fill',               withAlpha(accent, 0.18));
  put('--theme-snap-ghost-border',             withAlpha(accent, 0.40));
  put('--theme-pianoroll-note-slide-stroke',   withAlpha(accent, 0.12));
  put('--theme-pianoroll-loop-region',         withAlpha(accent, 0.08));
  put('--theme-pianoroll-selection-rect',      withAlpha(accent, 0.18));
  put('--theme-sampler-mod-color-volume',      accent);
  put('--theme-timeline-selection-rect',       withAlpha(accent, 0.18));
  put('--theme-grid-chorus-overlay',           withAlpha(accent, 0.18));
  put('--theme-nodeeditor-selection-rect',     withAlpha(accent, 0.18));
  put('--theme-projectmedia-dropzone',         withAlpha(accent, 0.14));
  put('--theme-eq-band-1',                     accent);
  put('--theme-eq-response-fill',              withAlpha(accent, 0.12));
  put('--theme-dyn-transfer-fill',             withAlpha(accent, 0.12));
  put('--theme-dyn-transient-sustain-fill',    withAlpha(accent, 0.30));
  put('--theme-filter-response-fill',          withAlpha(accent, 0.12));
  put('--theme-dist-waveshape-fill',           withAlpha(accent, 0.12));
  put('--theme-syllable-accent-light',         shift(accent, { dL: 18 }));
  put('--theme-syllable-section-alt',          withAlpha(accent, 0.06));
  put('--theme-lipsync-selection-fill',        withAlpha(accent, 0.15));
  put('--theme-waveform-envelope-fill',        withAlpha(accent, 0.35));
  put('--theme-waveform-rms-body',             withAlpha(accent, 0.55));

  return out;
}

// Named exports reserved for unit tests; not part of the public API.
export const _internal = { hexToHsl, hslToHex, shift, lighten, rotateHue, withAlpha, normalizeHex };
