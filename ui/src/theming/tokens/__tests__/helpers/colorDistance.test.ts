// Self-tests for the ΔE2000 helper. Kept adjacent to the helper so any
// breakage in the inline color math is caught before it silently loosens
// the pinning tests in derivation.test.ts.

import { describe, it, expect } from 'vitest';
import { deltaE, deltaE2000, rgbToLab, parseColor, composeOver } from './colorDistance';

describe('colorDistance helper', () => {
  it('identical colors have ΔE = 0', () => {
    expect(deltaE('#33CED6', '#33CED6')).toBeCloseTo(0, 6);
  });

  it('white vs black is approximately 100', () => {
    // ΔE2000 for pure white vs pure black is ~100 (Lab L=100 vs L=0 with a=b=0).
    const d = deltaE('#FFFFFF', '#000000');
    expect(d).toBeGreaterThan(99);
    expect(d).toBeLessThan(101);
  });

  it('published Sharma reference pair (#1) — ΔE2000 ≈ 2.0425', () => {
    // Sharma/Wu/Dalal Table 1 row 1: Lab1=(50, 2.6772, -79.7751),
    // Lab2=(50, 0, -82.7485); expected ΔE2000 = 2.0425.
    const d = deltaE2000(
      { L: 50, a: 2.6772, b: -79.7751 },
      { L: 50, a: 0,      b: -82.7485 },
    );
    expect(d).toBeCloseTo(2.0425, 3);
  });

  it('parses #rgb, #rrggbb, #rrggbbaa, rgba()', () => {
    expect(parseColor('#fff').r).toBe(255);
    expect(parseColor('#E8E8ED').g).toBe(232);
    expect(parseColor('#E8E8ED80').a).toBeCloseTo(0.502, 2);
    const rgba = parseColor('rgba(51, 206, 214, 0.15)');
    expect(rgba.r).toBe(51);
    expect(rgba.a).toBeCloseTo(0.15, 4);
  });

  it('composes rgba over an opaque background', () => {
    // accent @15% over bg-primary — the focus-ring case.
    const fg = parseColor('rgba(51, 206, 214, 0.15)');
    const bg = parseColor('#0A0A0F');
    const out = composeOver(fg, bg);
    // 0.15 * 51 + 0.85 * 10  = 7.65 + 8.5  = 16.15
    expect(out.r).toBeCloseTo(16.15, 2);
    expect(out.a).toBe(1);
  });

  it('round-trips sRGB → Lab sensibly', () => {
    // D65 reference white (#FFFFFF) maps to Lab L=100, a≈0, b≈0.
    const lab = rgbToLab({ r: 255, g: 255, b: 255, a: 1 });
    expect(lab.L).toBeCloseTo(100, 1);
    expect(Math.abs(lab.a)).toBeLessThan(0.01);
    expect(Math.abs(lab.b)).toBeLessThan(0.01);
  });
});
