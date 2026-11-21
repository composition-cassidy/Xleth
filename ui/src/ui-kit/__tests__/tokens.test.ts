// Contract tests for ui/DESIGN.md: the neutral ramp, semantic colours, signal
// hues, identity palette and fixed (non-colour) tokens.
//
// These assert the DESIGN.md numbers against what the app actually ships:
// the resolved Xleth Default theme (theming pipeline) and ui-kit/tokens.css.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveTheme } from '../../theming/runtime/applyTheme';
import { TOKENS_BY_NAME, SUBSYSTEMS } from '../../theming/tokens/catalog';
import defaultTheme from '../../theming/shipped/xleth-default.json';
import { TRACK_PALETTE_FALLBACK } from '../../components/timeline/trackColorResolver.js';
import { contrastRatio, hexToOklch, hueDistance, pickLabelInk } from '../colorMath';

type Theme = Parameters<typeof resolveTheme>[0];

const { values } = resolveTheme(defaultTheme as Theme);
const tokensCss = fs.readFileSync(path.resolve(__dirname, '..', 'tokens.css'), 'utf8');
const appCss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'styles', 'app.css'), 'utf8');

const catalogDefault = (name: string): string => {
  const rule = TOKENS_BY_NAME[name].derivation;
  if (rule.type !== 'explicit') throw new Error(`${name} is not an explicit token`);
  return rule.value;
};

/** `--name: value;` declarations of tokens.css, with comments stripped. */
const cssDecls = (() => {
  const out: Record<string, string> = {};
  const src = tokensCss.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of src.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim().replace(/\s+/g, ' ');
  return out;
})();

const G = {
  g0: values['--theme-ui-g0'],
  g1: values['--theme-ui-g1'],
  g2: values['--theme-ui-g2'],
  g3: values['--theme-ui-g3'],
  g4: values['--theme-ui-g4'],
};
const INK = values['--theme-ui-ink'];
const INK_2 = values['--theme-ui-ink-2'];
const INK_3 = values['--theme-ui-ink-3'];
const BOUNDARY = values['--theme-ui-boundary'];
const ACCENT = values['--theme-accent'];
const DANGER = values['--theme-danger'];
const REC = values['--theme-ui-rec'];
const REC_TEXT = values['--theme-ui-rec-text'];
const SOLO = values['--theme-ui-solo'];

describe('neutral ramp (DESIGN.md 3.1)', () => {
  it('resolves to the contract values from the Default base', () => {
    expect(G).toEqual({ g0: '#0F0F0F', g1: '#1A1A1A', g2: '#262626', g3: '#323232', g4: '#444444' });
    expect(INK).toBe('#E6E6E6');
    expect(INK_2).toBe('#B4B4B4');
    expect(INK_3).toBe('#9A9A9A');
    expect(BOUNDARY).toBe('#7C7C7C');
  });

  it('carries no hue: every ramp step is an exact grey', () => {
    for (const hex of [...Object.values(G), INK, INK_2, INK_3, BOUNDARY]) {
      const [, r, g, b] = /^#(..)(..)(..)$/.exec(hex)!;
      expect(r === g && g === b, `${hex} is not neutral`).toBe(true);
    }
  });

  it('boundary is at least 3:1 on g1, g2 and g3 (and g0)', () => {
    for (const k of ['g0', 'g1', 'g2', 'g3'] as const) {
      expect(contrastRatio(BOUNDARY, G[k]), `boundary on ${k}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('every ink is at least 4.5:1 on every surface; ink-3 is the dimmest text', () => {
    for (const k of ['g0', 'g1', 'g2', 'g3'] as const) {
      for (const [name, ink] of [['ink', INK], ['ink-2', INK_2], ['ink-3', INK_3]] as const) {
        expect(contrastRatio(ink, G[k]), `${name} on ${k}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrastRatio(INK, G.g1)).toBeGreaterThan(contrastRatio(INK_2, G.g1));
    expect(contrastRatio(INK_2, G.g1)).toBeGreaterThan(contrastRatio(INK_3, G.g1));
  });

  it('g4 is decorative: below the 3:1 non-text floor, never text', () => {
    expect(contrastRatio(G.g4, G.g1)).toBeLessThan(3);
  });
});

describe('text tokens (DESIGN.md: every text token >= 4.5:1 on g1)', () => {
  // rec is intentionally absent: it is fills/glyphs only; rec-text is its text colour.
  const TEXT_TOKENS: Record<string, string> = {
    ink: INK,
    'ink-2': INK_2,
    'ink-3': INK_3,
    'rec-text': REC_TEXT,
    value: ACCENT,
    solo: SOLO,
    clip: DANGER,
    'signal-audio': values['--theme-ui-signal-audio'],
    'signal-events': values['--theme-ui-signal-events'],
    'signal-parameter': values['--theme-ui-signal-parameter'],
    'signal-video': values['--theme-ui-signal-video'],
  };

  for (const [name, hex] of Object.entries(TEXT_TOKENS)) {
    it(`${name} (${hex}) is at least 4.5:1 on g1`, () => {
      expect(contrastRatio(hex, G.g1)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('rec-text also clears 4.5:1 on g3; rec itself is fills/glyphs only (>= 3:1 on g1, < 4.5:1)', () => {
    expect(contrastRatio(REC_TEXT, G.g3)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(REC, G.g1)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(REC, G.g1)).toBeLessThan(4.5);
  });

  it('the "on" chip text (g1) is at least 4.5:1 on the chip (ink)', () => {
    // on-bg aliases ink and on-fg aliases g1 (asserted in "semantic aliases follow their sources").
    expect(contrastRatio(G.g1, INK)).toBeGreaterThanOrEqual(4.5);
  });

  it('legacy muted text passes 4.5:1: --theme-text-muted -> ink-2 and --xleth-flat-text-muted -> ink-3', () => {
    expect((defaultTheme as { tokens: Record<string, string> }).tokens['--theme-text-muted']).toBe('var(--theme-ui-ink-2)');
    expect(contrastRatio(INK_2, G.g1)).toBeGreaterThanOrEqual(4.5);
    expect(appCss).toMatch(/--xleth-flat-text-muted:\s*var\(--ui-ink-3\);/);
    expect(appCss).not.toMatch(/--xleth-flat-text-muted:\s*var\(--theme-text-subtle\)/);
  });
});

describe('Default theme sits on the ramp (legacy surfaces)', () => {
  const t = (defaultTheme as { tokens: Record<string, string> }).tokens;

  it('maps the legacy base tokens onto g0 / g1 / ink', () => {
    expect(t['--theme-bg-primary']).toBe(G.g0);
    expect(t['--theme-bg-inset']).toBe(G.g0);
    expect(t['--theme-bg-surface']).toBe(G.g1);
    expect(t['--theme-text']).toBe(INK);
    expect(t['--theme-border-subtle']).toBe('var(--theme-ui-g4)');
  });

  it('every derived surface and text token is an exact grey (no blue cast left in the shell)', () => {
    for (const name of [
      '--theme-bg-primary', '--theme-bg-secondary', '--theme-bg-tertiary', '--theme-bg-surface',
      '--theme-bg-hover', '--theme-bg-active', '--theme-bg-elevated', '--theme-bg-inset',
      '--theme-text',
      '--theme-ui-g0', '--theme-ui-g1', '--theme-ui-g2', '--theme-ui-g3', '--theme-ui-g4',
    ]) {
      const hex = values[name];
      expect(hex, name).toMatch(/^#[0-9A-Fa-f]{6}$/);
      const [, r, g, b] = /^#(..)(..)(..)$/.exec(hex)!;
      expect(r === g && g === b, `${name} = ${hex} is not neutral`).toBe(true);
    }
  });

  it('leaves accent and danger untouched', () => {
    expect(ACCENT).toBe('#33CED6');
    expect(DANGER).toBe('#FF4757');
  });
});

describe('semantic + signal colours', () => {
  it('registers the new tokens in the catalog under the ui-* subsystems', () => {
    const subsystems = new Set(SUBSYSTEMS.map((s) => s.key));
    for (const k of ['ui-neutral', 'ui-semantic', 'ui-signal']) expect(subsystems.has(k), k).toBe(true);
    for (const n of ['g0', 'g1', 'g2', 'g3', 'g4', 'boundary', 'ink', 'ink-2', 'ink-3']) {
      expect(TOKENS_BY_NAME[`--theme-ui-${n}`]?.subsystem, n).toBe('ui-neutral');
    }
    for (const n of ['value', 'select', 'clip', 'on-bg', 'on-fg', 'rec', 'rec-text', 'solo']) {
      expect(TOKENS_BY_NAME[`--theme-ui-${n}`]?.subsystem, n).toBe('ui-semantic');
    }
  });

  it('semantic aliases follow their sources', () => {
    expect(values['--theme-ui-value']).toBe('var(--theme-accent)');
    expect(values['--theme-ui-select']).toBe('var(--theme-accent)');
    expect(values['--theme-ui-clip']).toBe('var(--theme-danger)');
    expect(values['--theme-ui-on-bg']).toBe('var(--theme-ui-ink)');
    expect(values['--theme-ui-on-fg']).toBe('var(--theme-ui-g1)');
  });

  it('signal hues are >= 30 deg (OKLCH) from the accent, every state hue and each other', () => {
    const state = { value: ACCENT, rec: REC, solo: SOLO, danger: DANGER };
    const signals = ['audio', 'events', 'parameter', 'video'].map((n) => [n, values[`--theme-ui-signal-${n}`]] as const);
    for (const [n, hex] of signals) {
      const h = hexToOklch(hex).h;
      for (const [sn, sh] of Object.entries(state)) {
        expect(hueDistance(h, hexToOklch(sh).h), `${n} vs ${sn}`).toBeGreaterThanOrEqual(30);
      }
    }
    for (let a = 0; a < signals.length; a++) {
      for (let b = a + 1; b < signals.length; b++) {
        expect(hueDistance(hexToOklch(signals[a][1]).h, hexToOklch(signals[b][1]).h), `${signals[a][0]} vs ${signals[b][0]}`).toBeGreaterThanOrEqual(30);
      }
    }
  });
});

describe('identity palette (--theme-track-palette-1..16, DESIGN.md 3.4)', () => {
  const palette = Array.from({ length: 16 }, (_, i) => values[`--theme-track-palette-${i + 1}`]);
  const stateHues = { value: hexToOklch(ACCENT).h, rec: hexToOklch(REC).h, solo: hexToOklch(SOLO).h, danger: hexToOklch(DANGER).h };

  it('has 16 distinct #RRGGBB entries', () => {
    expect(palette).toHaveLength(16);
    palette.forEach((hex) => expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/));
    expect(new Set(palette.map((h) => h.toUpperCase())).size).toBe(16);
  });

  it('is mirrored by TRACK_PALETTE_FALLBACK', () => {
    expect([...TRACK_PALETTE_FALLBACK].map((h: string) => h.toUpperCase())).toEqual(palette.map((h) => h.toUpperCase()));
  });

  palette.forEach((hex, i) => {
    it(`slot ${i + 1} (${hex}): no hue within 20 deg of value, rec, solo or danger`, () => {
      const h = hexToOklch(hex).h;
      for (const [name, sh] of Object.entries(stateHues)) {
        expect(hueDistance(h, sh), `${hex} vs ${name}`).toBeGreaterThanOrEqual(20);
      }
    });

    it(`slot ${i + 1} (${hex}): automatic label (ink or g1) reaches 4.5:1`, () => {
      expect(pickLabelInk(hex, INK, G.g1).ratio).toBeGreaterThanOrEqual(4.5);
    });

    it(`slot ${i + 1} (${hex}): sane OKLCH lightness and chroma`, () => {
      const { l, c } = hexToOklch(hex);
      expect(l).toBeGreaterThanOrEqual(0.55);
      expect(l).toBeLessThanOrEqual(0.85);
      expect(c).toBeGreaterThanOrEqual(0.05);
      expect(c).toBeLessThanOrEqual(0.18);
    });
  });

  it('only the six audited slots differ from the pre-Phase-0 palette (index-based tracks must not be recoloured otherwise)', () => {
    const BEFORE = ['#58B2CE', '#77BE87', '#DD925D', '#8A6FE0', '#D56DA3', '#DEB963', '#6186CF', '#4AB7A9', '#DF6666', '#97BB65', '#A974DE', '#4CA9D3', '#D3AA41', '#8496BA', '#6DCAA5', '#DB6A7B'];
    const changed = palette.map((h, i) => (h.toUpperCase() !== BEFORE[i] ? i + 1 : 0)).filter(Boolean);
    expect(changed).toEqual([4, 6, 8, 9, 13, 16]);
  });
});

describe('tokens.css (DESIGN.md)', () => {
  it('colour fallbacks equal the resolved Default theme', () => {
    const fallbackHex = /^var\((--theme-ui-[\w-]+),\s*(#[0-9A-Fa-f]{6})\)$/;
    let checked = 0;
    for (const [uiName, raw] of Object.entries(cssDecls)) {
      const m = fallbackHex.exec(raw);
      if (!m) continue;
      const resolved = values[m[1]];
      // Alias tokens resolve to a var(); compare against what that var() ends up as.
      const concrete = resolved.startsWith('var(') ? values[/var\((--[\w-]+)\)/.exec(resolved)![1]] : resolved;
      const target = concrete.startsWith('var(') ? values[/var\((--[\w-]+)\)/.exec(concrete)![1]] : concrete;
      expect(m[2].toUpperCase(), `${uiName} fallback vs ${m[1]}`).toBe(target.toUpperCase());
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(17);
  });

  it('every theme-driven alias reads the matching catalog token', () => {
    for (const [name, raw] of Object.entries(cssDecls)) {
      const m = /^var\((--theme-ui-[\w-]+)/.exec(raw);
      if (!m) continue;
      expect(TOKENS_BY_NAME[m[1]], `${name} -> ${m[1]} is not in the catalog`).toBeDefined();
    }
  });

  it('nests everything in @layer tokens', () => {
    expect(tokensCss.replace(/\/\*[\s\S]*?\*\//g, '').trim()).toMatch(/^@layer tokens\s*\{/);
  });

  it('defines the fixed contract values', () => {
    expect(cssDecls).toMatchObject({
      '--type-10': '10px', '--type-11': '11px', '--type-12': '12px', '--type-13': '13px', '--type-16': '16px',
      '--weight-regular': '400', '--weight-medium': '500', '--weight-semibold': '600',
      '--space-1': '4px', '--space-2': '8px', '--space-3': '12px', '--space-4': '16px', '--space-5': '24px',
      '--ctl-h-sm': '24px', '--ctl-h-md': '28px', '--ctl-h-lg': '32px',
      '--panel-header-h': '28px', '--row-h': '24px', '--row-h-compact': '20px', '--hit-min': '24px',
      '--ui-radius-0': '0', '--ui-radius-1': '2px', '--ui-radius-2': '4px',
      '--ui-shadow-float': '4px 5px 0 rgba(0, 0, 0, 0.5)',
      '--ui-mute-opacity': '0.45',
    });
  });

  it('keeps interactive rows and every control at or above the 24px hit area', () => {
    const px = (n: string) => parseFloat(cssDecls[n]);
    expect(px('--hit-min')).toBeGreaterThanOrEqual(24);
    for (const n of ['--ctl-h-sm', '--ctl-h-md', '--ctl-h-lg', '--row-h']) expect(px(n), n).toBeGreaterThanOrEqual(24);
  });
});
