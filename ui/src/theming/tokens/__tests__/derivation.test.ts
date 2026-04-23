// Derivation pinning tests. Per Phase 0 Track B formula tuning, each
// §3.2 derived token must land within ΔE2000 ≤ 1.0 of its hand-picked
// anchor in the Xleth Default palette. Threshold is tight enough that
// any accidental formula regression fails the suite immediately.
//
// Tests that changed shape from the pre-tune suite:
//   - The old "_internal.lighten increases L by delta" assertion drifted
//     on 8-bit round-trip (0.098% error). Replaced with a ΔE-based check
//     that's stable across hex quantization.
//   - Old hue-rotation checks for --theme-warning / --theme-success are
//     gone — those tokens left the derivation pipeline (class C,
//     explicit in catalog).

import { describe, it, expect } from 'vitest';
import { deriveTheme, _internal } from '../derivation';
import { BASE_DEFAULTS } from '../base';
import { deltaE, parseColor, composeOver, rgbToLab, deltaE2000 } from './helpers/colorDistance';

// ──────────────────────────────────────────────────────────────────────────
// Anchors — the hand-picked values in ui/src/styles/theme.css that the
// shipped Xleth Default palette must reproduce byte-identically.
// ──────────────────────────────────────────────────────────────────────────

const ANCHORS: Record<string, string> = {
  '--theme-bg-secondary':     '#111118',
  '--theme-bg-elevated':      '#222230',
  '--theme-border-subtle':    '#2A2A38',
  '--theme-text-muted':       '#8888A0',
  '--theme-text-subtle':      '#555566',
  '--theme-text-placeholder': '#555566',
  '--theme-accent-hover':     '#2BB8BF',
  '--theme-focus-ring':       'rgba(51, 206, 214, 0.15)',
};

const DE_THRESHOLD = 1.0;

// Hex equality is case-insensitive — rgbToHex emits lowercase; theme.css
// anchors are uppercase. Both render identical in every browser.
const eqHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Compose-over background for the single remaining rgba() token. The rest
// of the tuned pipeline emits solid hex, so bg-compose isn't needed there.
const BG_PRIMARY = BASE_DEFAULTS['--theme-bg-primary'];

describe('derivation pinning — every §3.2 derived token within ΔE ≤ 1.0 of anchor', () => {
  const d = deriveTheme(BASE_DEFAULTS);

  it('bg-secondary — bg-primary + (dL=3.14, dS=-2.93)', () => {
    const de = deltaE(d['--theme-bg-secondary'], ANCHORS['--theme-bg-secondary']);
    expect(eqHex(d['--theme-bg-secondary'], '#111118')).toBe(true);
    expect(de).toBeLessThanOrEqual(DE_THRESHOLD);
  });

  it('bg-elevated — bg-surface + (dL=3.92, dS=0.94)', () => {
    const de = deltaE(d['--theme-bg-elevated'], ANCHORS['--theme-bg-elevated']);
    expect(eqHex(d['--theme-bg-elevated'], '#222230')).toBe(true);
    expect(de).toBeLessThanOrEqual(DE_THRESHOLD);
  });

  it('border-subtle — text + (dL=-72.75, dS=+2.09)', () => {
    const de = deltaE(d['--theme-border-subtle'], ANCHORS['--theme-border-subtle']);
    expect(eqHex(d['--theme-border-subtle'], '#2A2A38')).toBe(true);
    expect(de).toBeLessThanOrEqual(DE_THRESHOLD);
  });

  it('text-muted — text + (dL=-33.92, dS=-0.98)', () => {
    const de = deltaE(d['--theme-text-muted'], ANCHORS['--theme-text-muted']);
    expect(eqHex(d['--theme-text-muted'], '#8888A0')).toBe(true);
    expect(de).toBeLessThanOrEqual(DE_THRESHOLD);
  });

  it('text-subtle — text + (dL=-55.29, dS=-3.10)', () => {
    const de = deltaE(d['--theme-text-subtle'], ANCHORS['--theme-text-subtle']);
    expect(eqHex(d['--theme-text-subtle'], '#555566')).toBe(true);
    expect(de).toBeLessThanOrEqual(DE_THRESHOLD);
  });

  it('text-placeholder — shares text-subtle formula (both resolve to #555566)', () => {
    expect(d['--theme-text-placeholder']).toBe(d['--theme-text-subtle']);
    const de = deltaE(d['--theme-text-placeholder'], ANCHORS['--theme-text-placeholder']);
    expect(de).toBeLessThanOrEqual(DE_THRESHOLD);
  });

  it('accent-hover — accent + (dL=-6.08, dS=-3.28) — darker, intentionally', () => {
    const de = deltaE(d['--theme-accent-hover'], ANCHORS['--theme-accent-hover']);
    expect(eqHex(d['--theme-accent-hover'], '#2BB8BF')).toBe(true);
    expect(de).toBeLessThanOrEqual(DE_THRESHOLD);
  });

  it('focus-ring — accent @15% alpha (exact)', () => {
    expect(d['--theme-focus-ring']).toBe('rgba(51, 206, 214, 0.15)');
    // Composite against bg-primary and measure vs the composited anchor.
    const composed = composeOver(parseColor(d['--theme-focus-ring']), parseColor(BG_PRIMARY));
    const anchor = composeOver(parseColor(ANCHORS['--theme-focus-ring']), parseColor(BG_PRIMARY));
    const de = deltaE2000(rgbToLab(composed), rgbToLab(anchor));
    expect(de).toBeLessThanOrEqual(DE_THRESHOLD);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Class C — warning / success left the derivation pipeline (explicit in
// catalog). Guard against accidental re-introduction.
// ──────────────────────────────────────────────────────────────────────────

describe('class-C tokens are NOT emitted by deriveTheme', () => {
  it('--theme-warning is not in derived output', () => {
    expect(deriveTheme(BASE_DEFAULTS)['--theme-warning']).toBeUndefined();
  });
  it('--theme-success is not in derived output', () => {
    expect(deriveTheme(BASE_DEFAULTS)['--theme-success']).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Internal helper behavior
// ──────────────────────────────────────────────────────────────────────────

describe('_internal.shift / lighten', () => {
  it('shift with dL=5 on #1A1A24 produces the correct lighter color', () => {
    // #1A1A24 is H=240° S=16.13% L=12.16%. Adding 5% L → L=17.16% → #252533.
    // This hex was computed independently (not through hslToHex) to avoid
    // asserting a color against itself. The ΔE ≤ 1.0 threshold also guards
    // against a future formula change that passes hslToHex round-trip but
    // drifts perceptually.
    const after = _internal.shift('#1A1A24', { dL: 5 });
    expect(eqHex(after, '#252533')).toBe(true);
    expect(deltaE(after, '#252533')).toBeLessThanOrEqual(DE_THRESHOLD);
  });

  it('lighten is an alias for shift({ dL })', () => {
    expect(_internal.lighten('#1A1A24', 5)).toBe(_internal.shift('#1A1A24', { dL: 5 }));
  });

  it('shift clamps L at 100', () => {
    const hsl = _internal.hexToHsl(_internal.shift('#FFFFFF', { dL: 20 }));
    expect(hsl.l).toBeCloseTo(100, 1);
  });

  it('shift clamps L at 0 (black input, large negative dL)', () => {
    const hsl = _internal.hexToHsl(_internal.shift('#000000', { dL: -20 }));
    expect(hsl.l).toBeCloseTo(0, 1);
  });

  it('shift with positive dS on white (S=0) produces correct in-range saturation', () => {
    // S=0 + 2.091 = 2.091; nothing to clamp, confirms no arithmetic wrap.
    // (Mirrors the border-subtle formula applied to a pure-white text base.)
    const out = _internal.shift('#FFFFFF', { dL: -72.745, dS: 2.091 });
    const hsl = _internal.hexToHsl(out);
    expect(hsl.s).toBeCloseTo(2.091, 0);  // 8-bit roundtrip allows ~±0.1; precision:0 (±0.5) covers it
    expect(hsl.l).toBeCloseTo(27.255, 1);
  });

  it('shift clamps S at 0 when dS underflows', () => {
    const out = _internal.shift('#FFFFFF', { dS: -5 });
    const hsl = _internal.hexToHsl(out);
    expect(hsl.s).toBe(0);
  });

  it('shift clamps S at 100 (high-saturation input, dS overflow)', () => {
    // #FF0000 has S=100; adding +5 must clamp back to 100, not produce S=105.
    // Relevant: border-subtle applies dS=+2.091 — a user theme with text=#FF3300
    // (S=100) would silently corrupt Simple mode without this clamp.
    const hsl = _internal.hexToHsl(_internal.shift('#FF0000', { dS: +5 }));
    expect(hsl.s).toBeCloseTo(100, 1);
  });
});

describe('rotateHue', () => {
  it('rotates by the requested degrees', () => {
    const hsl0 = _internal.hexToHsl('#33CED6');
    const hsl1 = _internal.hexToHsl(_internal.rotateHue('#33CED6', 60));
    const diff = ((hsl1.h - hsl0.h) % 360 + 360) % 360;
    expect(diff).toBeCloseTo(60, 0);
  });
  it('accepts negative rotations', () => {
    const hsl0 = _internal.hexToHsl('#33CED6');
    const hsl1 = _internal.hexToHsl(_internal.rotateHue('#33CED6', -120));
    const diff = ((hsl0.h - hsl1.h) % 360 + 360) % 360;
    expect(diff).toBeCloseTo(120, 0);
  });
});

describe('withAlpha', () => {
  it('emits canonical rgba()', () => {
    expect(_internal.withAlpha('#33CED6', 0.15)).toBe('rgba(51, 206, 214, 0.15)');
    expect(_internal.withAlpha('#E8E8ED', 0.25)).toBe('rgba(232, 232, 237, 0.25)');
    expect(_internal.withAlpha('#000000', 1)).toBe('rgba(0, 0, 0, 1)');
    expect(_internal.withAlpha('#FFFFFF', 0)).toBe('rgba(255, 255, 255, 0)');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// deriveTheme structural contracts
// ──────────────────────────────────────────────────────────────────────────

describe('deriveTheme — structural contracts', () => {
  it('produces every §3.2 formula token (warning/success excluded — class C)', () => {
    const d = deriveTheme(BASE_DEFAULTS);
    const expected = [
      '--theme-bg-secondary','--theme-bg-tertiary','--theme-bg-hover','--theme-bg-active','--theme-bg-elevated',
      '--theme-text-muted','--theme-text-subtle','--theme-text-placeholder','--theme-text-inverse',
      '--theme-border-subtle','--theme-border-strong','--theme-border-focus',
      '--theme-info',
      '--theme-accent-hover','--theme-accent-active','--theme-focus-ring',
      '--theme-panel-mixer','--theme-panel-timeline','--theme-panel-pianoroll',
      '--theme-panel-preview','--theme-panel-grid','--theme-panel-node',
    ];
    for (const k of expected) expect(d[k]).toBeTruthy();
    expect(Object.keys(d).length).toBe(expected.length);
  });

  it('omits tokens in derivationDetached', () => {
    const d = deriveTheme(BASE_DEFAULTS, ['--theme-accent-hover', '--theme-panel-mixer']);
    expect(d['--theme-accent-hover']).toBeUndefined();
    expect(d['--theme-panel-mixer']).toBeUndefined();
    expect(d['--theme-bg-secondary']).toBeTruthy();
  });

  it('is pure — same input, same output', () => {
    const a = deriveTheme(BASE_DEFAULTS);
    const b = deriveTheme(BASE_DEFAULTS);
    expect(a).toEqual(b);
  });

  it('--theme-info === --theme-accent', () => {
    const d = deriveTheme(BASE_DEFAULTS);
    expect(d['--theme-info']).toBe(BASE_DEFAULTS['--theme-accent']);
  });

  it('--theme-text-inverse === --theme-bg-primary', () => {
    const d = deriveTheme(BASE_DEFAULTS);
    expect(d['--theme-text-inverse']).toBe(BASE_DEFAULTS['--theme-bg-primary']);
  });
});
