// Per-theme contract for the five shipped themes (ui/DESIGN.md section 3, Phase 7).
// The Phase 0 numbers in tokens.test.ts are asserted on Default only; this file
// extends the same floors to every theme: dark, light, high contrast, and the warm
// and cool accent variants.

import { describe, expect, it } from 'vitest';

import { resolveTheme } from '../../theming/runtime/applyTheme';
import { getShippedTheme, listShippedThemes } from '../../theming/runtime/ThemeLoader';
import { RAMPS } from '../../theming/tokens/neutralRamp';
import { CHROME_SURFACE_TOKENS, chromaOf, findTintedSurfaces, resolveHex } from '../../theming/runtime/chromeTint';
import { contrastRatio, hexToOklch, hueDistance, pickLabelInk } from '../colorMath';

const SLUGS = ['xleth-default', 'xleth-light', 'xleth-warm', 'xleth-cool', 'xleth-high-contrast'] as const;
type Slug = (typeof SLUGS)[number];

const theme = (slug: Slug) => getShippedTheme(slug)!;
const resolved = (slug: Slug) => resolveTheme(theme(slug));
const hex = (slug: Slug, name: string): string => {
  const h = resolveHex(resolved(slug).values, name);
  if (!h) throw new Error(`${slug}: ${name} did not resolve to a hex`);
  return h;
};
const isGrey = (h: string) => {
  const [, r, g, b] = /^#(..)(..)(..)$/.exec(h)!;
  return r === g && g === b;
};

/** A white-on-black alpha line composited over `bg`, as a #RRGGBB. */
function composite(rgba: string, bg: string): string {
  const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(rgba)!;
  const a = Number(m[4]);
  const b = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
  const mix = [Number(m[1]), Number(m[2]), Number(m[3])].map((c, i) => Math.round(c * a + b[i] * (1 - a)));
  return '#' + mix.map((v) => v.toString(16).padStart(2, '0')).join('');
}

describe('shipped theme list', () => {
  it('ships exactly the five themes', () => {
    expect(listShippedThemes().map((t) => t.slug).sort()).toEqual([...SLUGS].sort());
  });

  it('names the ramp each theme sits on', () => {
    expect(resolved('xleth-default').ramp).toBe('dark');
    expect(resolved('xleth-warm').ramp).toBe('dark');
    expect(resolved('xleth-cool').ramp).toBe('dark');
    expect(resolved('xleth-light').ramp).toBe('light');
    expect(resolved('xleth-high-contrast').ramp).toBe('hc');
  });
});

describe.each(SLUGS)('%s', (slug) => {
  const { values, ramp } = resolved(slug);
  const spec = RAMPS[ramp];
  const hc = ramp === 'hc';
  const G = ['g0', 'g1', 'g2', 'g3'].map((k) => hex(slug, `--theme-ui-${k}`));

  it('base tokens equal the ramp row (one source, no drift)', () => {
    for (const k of ['--theme-bg-primary', '--theme-bg-surface', '--theme-text'] as const) {
      expect(String(theme(slug).tokens[k]).toUpperCase(), k).toBe(spec.base[k].toUpperCase());
    }
  });

  it('chrome is neutral: ramp steps, legacy surfaces and the Preview surround are exact greys', () => {
    const names = [
      ...['g0', 'g1', 'g2', 'g3', 'g4', 'boundary', 'ink', 'ink-2', 'ink-3'].map((k) => `--theme-ui-${k}`),
      ...CHROME_SURFACE_TOKENS,
      '--theme-bg-secondary', '--theme-bg-tertiary', '--theme-bg-hover', '--theme-bg-active', '--theme-bg-elevated',
      '--theme-text-muted', '--theme-text-subtle', '--theme-text-placeholder', '--theme-border-subtle',
      '--theme-timeline-lane-bg', '--theme-pianoroll-grid-bg', '--theme-pianoroll-key-black-bg', '--theme-pianoroll-key-white-bg',
      '--theme-pianoroll-velocity-bg', '--theme-sampler-key-border', '--theme-syllable-splitter-bg', '--theme-pattern-list-item-hover-bg',
      '--theme-fx-knob-lg-bg', '--theme-fx-knob-lg-border',
    ];
    for (const n of names) {
      const h = resolveHex(values, n);
      expect(h, `${slug} ${n} (${values[n]})`).not.toBeNull();
      expect(isGrey(h!), `${slug} ${n} = ${h}`).toBe(true);
    }
    expect(findTintedSurfaces(values)).toEqual([]);
  });

  it('every ink reaches 4.5:1 on every surface (7:1 in high contrast); boundary 3:1 (7:1)', () => {
    const inkFloor = hc ? 7 : 4.5;
    const boundaryFloor = hc ? 7 : 3;
    for (const [i, g] of G.entries()) {
      for (const k of ['ink', 'ink-2', 'ink-3']) {
        expect(contrastRatio(hex(slug, `--theme-ui-${k}`), g), `${k} on g${i}`).toBeGreaterThanOrEqual(inkFloor);
      }
      expect(contrastRatio(hex(slug, '--theme-ui-boundary'), g), `boundary on g${i}`).toBeGreaterThanOrEqual(boundaryFloor);
    }
  });

  it('the legacy dimmest-text tokens clear 4.5:1 too (nothing below ink-3 remains)', () => {
    for (const n of ['--theme-text-muted', '--theme-text-subtle', '--theme-text-placeholder']) {
      for (const [i, g] of G.entries()) {
        expect(contrastRatio(hex(slug, n), g), `${n} on g${i}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('g4 is decorative on dark/light (below 3:1) and keeps ordering', () => {
    if (!hc) expect(contrastRatio(hex(slug, '--theme-ui-g4'), G[1])).toBeLessThan(3);
    const [i1, i2, i3] = ['ink', 'ink-2', 'ink-3'].map((k) => contrastRatio(hex(slug, `--theme-ui-${k}`), G[1]));
    expect(i1).toBeGreaterThan(i2);
    expect(i2).toBeGreaterThan(i3);
  });

  it('semantic and signal text colours reach 4.5:1 on every surface (7:1 in high contrast)', () => {
    const floor = hc ? 7 : 4.5;
    const named: Record<string, string> = {
      value: hex(slug, '--theme-accent'),
      clip: hex(slug, '--theme-danger'),
      'rec-text': hex(slug, '--theme-ui-rec-text'),
      solo: hex(slug, '--theme-ui-solo'),
      'signal-audio': hex(slug, '--theme-ui-signal-audio'),
      'signal-events': hex(slug, '--theme-ui-signal-events'),
      'signal-parameter': hex(slug, '--theme-ui-signal-parameter'),
      'signal-video': hex(slug, '--theme-ui-signal-video'),
    };
    for (const [n, h] of Object.entries(named)) {
      // clip (--theme-danger) is the Phase 0 base colour: it is text on the ground, panel and
      // header (g0..g2). On control fills (g3) danger text uses --theme-semantic-danger-text.
      const surfaces = n === 'clip' && !hc ? G.slice(0, 3) : G;
      for (const [i, g] of surfaces.entries()) {
        expect(contrastRatio(h, g), `${slug} ${n} ${h} on g${i}`).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  it('danger text (--theme-semantic-danger-text) reaches 4.5:1 on every surface', () => {
    const dt = resolveHex(values, '--theme-semantic-danger-text');
    expect(dt).not.toBeNull();
    for (const [i, g] of G.entries()) {
      expect(contrastRatio(dt!, g), `${slug} danger-text on g${i}`).toBeGreaterThanOrEqual(hc ? 7 : 4.5);
    }
  });

  it('rec is fills and glyphs only: 3:1 on g1', () => {
    expect(contrastRatio(hex(slug, '--theme-ui-rec'), G[1])).toBeGreaterThanOrEqual(3);
  });

  it('the "on" chip text (g1) reads on the chip (ink)', () => {
    expect(contrastRatio(G[1], hex(slug, '--theme-ui-ink'))).toBeGreaterThanOrEqual(4.5);
  });

  it('text on the accent fill reaches 4.5:1', () => {
    expect(contrastRatio(hex(slug, '--theme-text-on-accent'), hex(slug, '--theme-accent'))).toBeGreaterThanOrEqual(4.5);
  });

  it('signal hues stay >= 30 deg (OKLCH) from the accent, rec, solo and danger, and from each other', () => {
    const state = [hex(slug, '--theme-accent'), hex(slug, '--theme-ui-rec'), hex(slug, '--theme-ui-solo'), hex(slug, '--theme-danger')];
    const signals = ['audio', 'events', 'parameter', 'video'].map((n) => hex(slug, `--theme-ui-signal-${n}`));
    // The accent variants (warm amber, cool cobalt) deliberately move the accent hue; the
    // signal hues are the fixed reference, so only the fixed state hues are asserted for them.
    const stateToCheck = slug === 'xleth-warm' || slug === 'xleth-cool' ? state.slice(1) : state;
    for (const s of signals) {
      for (const t of stateToCheck) expect(hueDistance(hexToOklch(s).h, hexToOklch(t).h)).toBeGreaterThanOrEqual(30);
    }
    for (let a = 0; a < signals.length; a++) {
      for (let b = a + 1; b < signals.length; b++) {
        expect(hueDistance(hexToOklch(signals[a]).h, hexToOklch(signals[b]).h)).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it('identity palette: every slot gets an automatic label (ink or g1) at 4.5:1', () => {
    const ink = hex(slug, '--theme-ui-ink');
    for (let i = 1; i <= 16; i++) {
      const c = hex(slug, `--theme-track-palette-${i}`);
      expect(pickLabelInk(c, ink, G[1]).ratio, `${slug} slot ${i} ${c}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('identity palette is one palette across themes', () => {
  const palette = (slug: Slug) => Array.from({ length: 16 }, (_, i) => hex(slug, `--theme-track-palette-${i + 1}`).toUpperCase());
  for (const slug of SLUGS.filter((s) => s !== 'xleth-default')) {
    it(`${slug} uses Default's 16 colours, so a track keeps its colour when the theme changes`, () => {
      expect(palette(slug)).toEqual(palette('xleth-default'));
    });
  }

  it('the colours that exclude hue from rec, solo and danger do so in light and high contrast too', () => {
    for (const slug of ['xleth-light', 'xleth-high-contrast'] as const) {
      const state = [hex(slug, '--theme-ui-rec'), hex(slug, '--theme-ui-solo'), hex(slug, '--theme-danger'), hex(slug, '--theme-accent')];
      for (let i = 1; i <= 16; i++) {
        const h = hexToOklch(hex(slug, `--theme-track-palette-${i}`)).h;
        for (const s of state) expect(hueDistance(h, hexToOklch(s).h), `${slug} slot ${i}`).toBeGreaterThanOrEqual(20);
      }
    }
  });
});

describe('warm and cool are accent variants only', () => {
  const base = theme('xleth-default').tokens as Record<string, unknown>;
  // Everything that is allowed to differ is derived from, or paints, the accent.
  const ACCENT_KEYS = new Set([
    '--theme-accent', '--theme-accent-bg-subtle', '--theme-accent-bg-medium',
    '--theme-lipsync-selection-fill', '--theme-lipsync-handle',
    '--theme-waveform-envelope-fill', '--theme-waveform-rms-body',
    '--theme-syllable-accent-light', '--theme-syllable-section-alt',
    '--theme-sampler-mod-color-volume', '--theme-sampler-mod-bg-volume',
  ]);

  for (const slug of ['xleth-warm', 'xleth-cool'] as const) {
    it(`${slug}: every token outside the accent family is identical to Default`, () => {
      const t = theme(slug).tokens as Record<string, unknown>;
      expect(Object.keys(t).sort()).toEqual(Object.keys(base).sort());
      const differing = Object.keys(t).filter((k) => JSON.stringify(t[k]) !== JSON.stringify(base[k]));
      for (const k of differing) expect(ACCENT_KEYS.has(k), `${slug} changes ${k}`).toBe(true);
      expect(differing).toContain('--theme-accent');
      expect(theme(slug).ramp).toBe('dark');
      expect(theme(slug).derivationDetached).toEqual(theme('xleth-default').derivationDetached);
    });

    it(`${slug}: surfaces and ink resolve to the same hexes as Default`, () => {
      for (const n of ['g0', 'g1', 'g2', 'g3', 'g4', 'ink', 'ink-2', 'ink-3', 'boundary']) {
        expect(hex(slug, `--theme-ui-${n}`)).toBe(hex('xleth-default', `--theme-ui-${n}`));
      }
    });
  }
});

describe('high contrast: grid lines survive the low-contrast check', () => {
  const { values } = resolved('xleth-high-contrast');
  const bed = hex('xleth-high-contrast', '--theme-ui-g0');
  const lines = (prefix: string) => ({
    bar: composite(values[`--theme-${prefix}-bar-line`], bed),
    beat: composite(values[`--theme-${prefix}-beat-line`], bed),
    step: composite(values[`--theme-${prefix}-subdivision-line`], bed),
  });
  for (const prefix of ['timeline', 'pianoroll']) {
    it(`${prefix}: bar >= 3:1, beat >= 3:1, step >= 1.5:1 over the ground`, () => {
      const l = lines(prefix);
      expect(contrastRatio(l.bar, bed)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(l.beat, bed)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(l.step, bed)).toBeGreaterThanOrEqual(1.5);
      expect(contrastRatio(l.bar, bed)).toBeGreaterThan(contrastRatio(l.beat, bed));
      expect(contrastRatio(l.beat, bed)).toBeGreaterThan(contrastRatio(l.step, bed));
    });
  }
});

describe('chromeTint', () => {
  it('measures exact greys as chroma 0 and a blue-grey as tinted', () => {
    expect(chromaOf('#1B1B1B')).toBeLessThan(0.001);
    expect(findTintedSurfaces({ '--theme-bg-surface': '#1A1A24' }).map((t) => t.token)).toEqual(['--theme-bg-surface']);
    expect(findTintedSurfaces({ '--theme-bg-surface': '#1B1B1D' })).toEqual([]);
  });
});
