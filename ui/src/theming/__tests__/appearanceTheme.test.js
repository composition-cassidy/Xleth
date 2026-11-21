// Regression tests for the Settings > Appearance brightness slider.
//
// This behavior has regressed three times, each time in one of two opposite
// directions, so both are pinned here:
//
//   1. Text became illegible in the middle of the slider. Root cause was
//      structural: text was shifted along its OWN lightness mirror,
//      independently of the background's mirror. Any L and its mirror 100-L
//      meet at exactly 50, so mid-slider the background and every text tier
//      converged and contrast fell to ~1.06 (invisible). Contrast was never an
//      input to the math.
//   2. Attempts to fix (1) by flattening the background curve — holding it
//      near-black through the lower half of the slider so text kept its
//      separation. That restored contrast but made the control useless: 0-43%
//      produced no visible change at all.
//
// The invariants below fail for BOTH mistakes, so neither can come back
// silently. If you are changing the brightness math and one of these fails,
// the fix is not to relax the threshold.

import { describe, it, expect } from 'vitest';
import {
  APPEARANCE_CONTRAST_MIN,
  NEUTRAL_TINT_CAP_CHROMA,
  buildAppearanceTheme,
} from '../runtime/appearanceTheme';
import { resolveTheme } from '../runtime/applyTheme';
import { TINT_CHROMA_CAP, findTintedSurfaces } from '../runtime/chromeTint';

// ── WCAG color math (independent of the implementation under test) ──────────

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const ch = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(hexA, hexB) {
  const a = relativeLuminance(hexA) + 0.05;
  const b = relativeLuminance(hexB) + 0.05;
  return a > b ? a / b : b / a;
}

function hslLightness(hex) {
  const { r, g, b } = hexToRgb(hex);
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  return ((mx + mn) / 2) * 100;
}

const STEPS = Array.from({ length: 101 }, (_, d) => d);
const tokensAt = (d) => buildAppearanceTheme('#33CED6', d).tokens;

describe('appearance brightness — surfaces track the slider', () => {
  // Mistake (2): a flattened curve keeps text legible by making the control do
  // nothing. Require the background to actually move across every region of
  // the slider, and to reach genuinely dark / mid / light at the ends.
  it('moves the background monotonically at every step', () => {
    let previous = -Infinity;
    for (const d of STEPS) {
      const l = hslLightness(tokensAt(d)['--theme-bg-surface']);
      expect(l).toBeGreaterThanOrEqual(previous);
      previous = l;
    }
  });

  it('makes visible progress in every quarter of the slider', () => {
    // No 25-point span may be a dead zone. The old flattened curve moved <3 L
    // points across 0-43%; a linear ramp moves ~19 per quarter.
    for (const [lo, hi] of [[0, 25], [25, 50], [50, 75], [75, 100]]) {
      const delta = hslLightness(tokensAt(hi)['--theme-bg-surface'])
        - hslLightness(tokensAt(lo)['--theme-bg-surface']);
      expect(delta).toBeGreaterThan(10);
    }
  });

  it('is genuinely dark at 0%, mid at 50% and light at 100%', () => {
    expect(hslLightness(tokensAt(0)['--theme-bg-surface'])).toBeLessThan(15);
    expect(hslLightness(tokensAt(50)['--theme-bg-surface'])).toBeGreaterThan(40);
    expect(hslLightness(tokensAt(50)['--theme-bg-surface'])).toBeLessThan(60);
    expect(hslLightness(tokensAt(100)['--theme-bg-surface'])).toBeGreaterThan(85);
  });
});

describe('appearance brightness — text stays legible', () => {
  // Mistake (1): the mid-slider contrast collapse. 4.5 is WCAG AA for body
  // text; the theoretical floor of the current design is ~4.58 (the background
  // luminance where neither white nor black can do better).
  it('holds primary text at WCAG AA or better at every brightness', () => {
    for (const d of STEPS) {
      const t = tokensAt(d);
      expect(contrast(t['--theme-text'], t['--theme-bg-surface'])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('holds each de-emphasized tier at its shipped ratio, or the physical max', () => {
    // The original report was that subtext and percentages washed out first.
    // Each tier's contrast against the shipped dark surface is the promise —
    // but no color can beat white-or-black against a given background, and
    // near the polarity switchover that ceiling dips to ~4.58. So the real
    // invariant is: hold the shipped ratio wherever it is reachable, and take
    // the maximum the background admits otherwise. A tier that is merely
    // "dimmer than it needs to be" fails this.
    // QUANTIZATION_EPSILON is one 8-bit channel step. Around the mid-grey
    // muted tier a single step moves the ratio by ~0.056, so the solver can
    // only ever land that close to an exact target. Measured, not padded to
    // make this pass — anything larger would hide a real regression.
    const QUANTIZATION_EPSILON = 0.1;
    // The promise is the neutral ramp's own ink-2 / ink-3 against its panel (g1 #1A1A1A).
    // (Phase 7: it is no longer read back from this builder's own 0% output, because the
    // tiers are now solved against the least favourable surface and carry headroom there.)
    const SHIPPED_ANCHOR = {
      '--theme-text-muted': '#B4B4B4',
      '--theme-text-subtle': '#9A9A9A',
      '--theme-text-placeholder': '#9A9A9A',
    };
    for (const tier of ['--theme-text-muted', '--theme-text-subtle', '--theme-text-placeholder']) {
      const promised = contrast(SHIPPED_ANCHOR[tier], '#1A1A1A');
      for (const d of STEPS) {
        const t = tokensAt(d);
        const bg = t['--theme-bg-surface'];
        const ceiling = Math.max(contrast('#FFFFFF', bg), contrast('#000000', bg));
        const floor = Math.min(promised, ceiling) - QUANTIZATION_EPSILON;
        expect(contrast(t[tier], bg)).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  it('keeps the text hierarchy ordered (primary >= muted >= subtle)', () => {
    for (const d of STEPS) {
      const t = tokensAt(d);
      const bg = t['--theme-bg-surface'];
      const primary = contrast(t['--theme-text'], bg);
      const muted = contrast(t['--theme-text-muted'], bg);
      const subtle = contrast(t['--theme-text-subtle'], bg);
      // Near the polarity switchover primary clamps to a pole and muted can
      // draw level with it, so this is >= rather than >.
      expect(primary + 0.05).toBeGreaterThanOrEqual(muted);
      // Both de-emphasized tiers now carry the 4.5:1 floor, so at the polarity
      // switchover (where white or black only reaches ~4.58) they can both sit on the
      // pole and tie. The order may therefore be level, never inverted.
      expect(muted + 0.05).toBeGreaterThanOrEqual(subtle);
    }
  });
});

describe('appearance brightness — borders survive the light theme', () => {
  // --theme-border-subtle is normally a fixed -72.7 L offset from text. Once
  // text goes dark for a light theme that underflows and clamps at 0, painting
  // every border pure black. It must stay a visible step off the surface.
  it('never collapses to black and always differs from the surface', () => {
    for (const d of STEPS) {
      const t = tokensAt(d);
      const border = t['--theme-border-subtle'];
      expect(border.toLowerCase()).not.toBe('#000000');
      const delta = Math.abs(hslLightness(border) - hslLightness(t['--theme-bg-surface']));
      expect(delta).toBeGreaterThan(3);
    }
  });
});

describe('appearance brightness — endpoints match the shipped palette', () => {
  it('reproduces the neutral ramp anchors at 0%', () => {
    const t = tokensAt(0);
    // Surfaces are an exact linear identity at darkness=0, and exact greys.
    expect(t['--theme-bg-primary']).toBe('#0F0F0F');
    expect(t['--theme-bg-surface']).toBe('#1A1A1A');
    expect(t['--theme-bg-inset'].toUpperCase()).toBe('#0F0F0F');
    // Text is solved from a luminance target, so allow 8-bit rounding drift.
    for (const [tier, want] of [
      ['--theme-text', '#E6E6E6'],
      ['--theme-text-muted', '#B4B4B4'],
      ['--theme-text-subtle', '#9A9A9A'],
    ]) {
      const got = hexToRgb(t[tier]);
      const expected = hexToRgb(want);
      // Solved against the panel (g1), nudged outward only where g3 would fall under 4.5:1.
      expect(got.r).toBeGreaterThanOrEqual(expected.r - 2);
      expect(got.r).toBeLessThanOrEqual(expected.r + 2);
      expect(got.r).toBe(got.g);
      expect(got.g).toBe(got.b);
    }
  });

  it('inverts text polarity between the two extremes', () => {
    const dark = tokensAt(0);
    const light = tokensAt(100);
    // Light text on dark ground at 0%, dark text on light ground at 100%.
    expect(relativeLuminance(dark['--theme-text']))
      .toBeGreaterThan(relativeLuminance(dark['--theme-bg-surface']));
    expect(relativeLuminance(light['--theme-text']))
      .toBeLessThan(relativeLuminance(light['--theme-bg-surface']));
  });

  it('defaults to the shipped dark theme for a non-numeric darkness', () => {
    expect(buildAppearanceTheme('#33CED6', undefined).tokens['--theme-bg-surface'])
      .toBe(tokensAt(0)['--theme-bg-surface']);
  });
});

// ── Hue / saturation / contrast knobs ──────────────────────────────────────

describe('appearance hue and saturation', () => {
  const hsl = (hex) => {
    const { r, g, b } = hexToRgb(hex);
    const mx = Math.max(r, g, b) / 255;
    const mn = Math.min(r, g, b) / 255;
    const l = (mx + mn) / 2;
    const d = mx - mn;
    return { sat: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l: l * 100 };
  };

  it('omitting options is exact neutral grey (no hue cast by default)', () => {
    for (const d of [0, 37, 100]) {
      const t = buildAppearanceTheme('#33CED6', d).tokens;
      for (const tier of ['--theme-bg-primary', '--theme-bg-surface', '--theme-bg-inset', '--theme-text', '--theme-border-subtle']) {
        const { r, g, b } = hexToRgb(t[tier]);
        expect(r === g && g === b, `${tier} @${d} = ${t[tier]}`).toBe(true);
      }
      expect(JSON.stringify(buildAppearanceTheme('#33CED6', d, {}).tokens))
        .toBe(JSON.stringify(buildAppearanceTheme('#33CED6', d).tokens));
    }
  });

  it('leaves the accent untouched, so chrome hue and accent are independent', () => {
    // The headline use case: pink chrome under a green accent.
    const t = buildAppearanceTheme('#3BE07A', 20, { hue: 330, saturation: 220 }).tokens;
    expect(t['--theme-accent']).toBe('#3BE07A');
    const surface = hexToRgb(t['--theme-bg-surface']);
    expect(surface.r).toBeGreaterThan(surface.g); // reads pink/red, not green
    expect(surface.b).toBeGreaterThan(surface.g);
  });

  it('saturation 0 produces pure neutral grey at any hue', () => {
    for (const hue of [0, 90, 200, 330]) {
      for (const tier of ['--theme-bg-primary', '--theme-bg-surface', '--theme-text']) {
        const { r, g, b } = hexToRgb(
          buildAppearanceTheme('#33CED6', 40, { hue, saturation: 0 }).tokens[tier],
        );
        expect(r).toBe(g);
        expect(g).toBe(b);
      }
    }
  });

  it('raising saturation actually intensifies the cast', () => {
    const at = (s) => hsl(buildAppearanceTheme('#33CED6', 30, { hue: 330, saturation: s }).tokens['--theme-bg-surface']).sat;
    expect(at(200)).toBeGreaterThan(at(100));
    expect(at(100)).toBeGreaterThan(at(30));
  });

  it('wraps hue rather than clamping it', () => {
    const base = buildAppearanceTheme('#33CED6', 30, { hue: 20 }).tokens;
    const wrapped = buildAppearanceTheme('#33CED6', 30, { hue: 380 }).tokens;
    expect(wrapped['--theme-bg-surface']).toBe(base['--theme-bg-surface']);
  });
});

describe('appearance text contrast knob', () => {
  const ratioAt = (contrastPct, tier) => {
    const t = buildAppearanceTheme('#33CED6', 20, { contrast: contrastPct }).tokens;
    return contrast(t[tier], t['--theme-bg-surface']);
  };

  it('increases separation monotonically for the de-emphasized tiers', () => {
    // Primary saturates against the pole at high settings, so the observable
    // knob response lives in the tiers that have headroom.
    for (const tier of ['--theme-text-muted', '--theme-text-subtle']) {
      // The 4.5:1 floor on every ramp surface binds the low end, so neighbouring settings
      // can tie there; the response is never inverted and the full range still opens up.
      expect(ratioAt(APPEARANCE_CONTRAST_MIN, tier)).toBeLessThanOrEqual(ratioAt(100, tier));
      expect(ratioAt(100, tier)).toBeLessThanOrEqual(ratioAt(140, tier));
      expect(ratioAt(APPEARANCE_CONTRAST_MIN, tier)).toBeLessThan(ratioAt(140, tier));
    }
  });

  it('keeps body text above the WCAG AA floor at every setting', () => {
    for (let c = 60; c <= 160; c += 5) {
      for (const d of [0, 25, 50, 55, 75, 100]) {
        const t = buildAppearanceTheme('#33CED6', d, { contrast: c }).tokens;
        expect(contrast(t['--theme-text'], t['--theme-bg-surface'])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('clamps out-of-range values instead of producing broken colors', () => {
    for (const bad of [-500, 0, 5, 9999, NaN, undefined, 'x']) {
      const t = buildAppearanceTheme('#33CED6', 30, { contrast: bad }).tokens;
      expect(t['--theme-text']).toMatch(/^#[0-9A-F]{6}$/i);
      expect(contrast(t['--theme-text'], t['--theme-bg-surface'])).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('appearance knobs — combined safety envelope', () => {
  // The knobs multiply: hue changes luminance weighting (green contributes
  // 0.7152, blue 0.0722), saturation changes headroom, brightness moves the
  // background and contrast moves the target. Legibility has to survive every
  // combination, not just each axis alone.
  it('holds body text at WCAG AA across the whole knob space', () => {
    let worst = Infinity;
    let worstAt = null;
    for (let hue = 0; hue < 360; hue += 30) {
      for (const saturation of [0, 100, 200, 300]) {
        for (let d = 0; d <= 100; d += 10) {
          for (const c of [80, 100, 160]) {
            const t = buildAppearanceTheme('#33CED6', d, { hue, saturation, contrast: c }).tokens;
            const ratio = contrast(t['--theme-text'], t['--theme-bg-surface']);
            if (ratio < worst) {
              worst = ratio;
              worstAt = { hue, saturation, d, c };
            }
          }
        }
      }
    }
    expect(worst, `worst case at ${JSON.stringify(worstAt)}`).toBeGreaterThanOrEqual(4.5);
  });

  it('emits only valid hex for every token across the knob space', () => {
    for (let hue = 0; hue < 360; hue += 45) {
      for (const saturation of [0, 150, 300]) {
        for (const d of [0, 50, 100]) {
          const tokens = buildAppearanceTheme('#33CED6', d, { hue, saturation, contrast: 100 }).tokens;
          for (const [name, value] of Object.entries(tokens)) {
            expect(value, `${name} @ hue ${hue} sat ${saturation} d ${d}`).toMatch(/^#[0-9A-F]{6}$/i);
          }
        }
      }
    }
  });
});

// ── Phase 7: the chrome is neutral, and the floors hold on every ramp surface ─────

describe('appearance — neutral chrome and the DAW Floor (Phase 7)', () => {
  const ratio = (a, b) => contrast(a, b);

  it('the tint cap equals the one the theme editor warns on', () => {
    expect(NEUTRAL_TINT_CAP_CHROMA).toBe(TINT_CHROMA_CAP);
  });

  it('is not tinted at the default knobs, and is tinted past the cap', () => {
    const at = (saturation) => {
      const file = buildAppearanceTheme('#33CED6', 30, { hue: 330, saturation });
      return findTintedSurfaces(resolveTheme(file).values).length;
    };
    expect(at(0)).toBe(0);
    expect(at(100)).toBe(0); // right at the cap is still neutral
    expect(at(250)).toBeGreaterThan(0);
  });

  it('every ink and the boundary clear their floor on g0..g3 across the whole slider', () => {
    let worstInk = Infinity;
    let worstBoundary = Infinity;
    for (const saturation of [0, 100]) {
      for (const c of [APPEARANCE_CONTRAST_MIN, 100, 160]) {
        for (let d = 0; d <= 100; d += 5) {
          const { values } = resolveTheme(buildAppearanceTheme('#33CED6', d, { contrast: c, saturation, hue: 200 }));
          const surfaces = ['g0', 'g1', 'g2', 'g3'].map((k) => values[`--theme-ui-${k}`]);
          for (const s of surfaces) {
            for (const k of ['ink', 'ink-2', 'ink-3']) worstInk = Math.min(worstInk, ratio(values[`--theme-ui-${k}`], s));
            worstBoundary = Math.min(worstBoundary, ratio(values['--theme-ui-boundary'], s));
          }
        }
      }
    }
    expect(worstInk).toBeGreaterThanOrEqual(4.5);
    expect(worstBoundary).toBeGreaterThanOrEqual(3);
  });

  it('names the ramp that matches its polarity, so ink-2 / ink-3 step toward the surface', () => {
    expect(buildAppearanceTheme('#33CED6', 0).ramp).toBe('dark');
    expect(buildAppearanceTheme('#33CED6', 100).ramp).toBe('light');
  });
});
