import { describe, expect, it } from 'vitest';
import scale from './ui-scale.js';

const { clampZoomFactor, factorFromStoredPercent, ZOOM_STEP } = scale;

describe('ui scale maths', () => {
  it('clamps to 100 %-200 %', () => {
    expect(clampZoomFactor(0.5)).toBe(1);
    expect(clampZoomFactor(3)).toBe(2);
    expect(clampZoomFactor(1.5)).toBe(1.5);
  });

  it('snaps to the 10 % grid', () => {
    expect(clampZoomFactor(1.04)).toBe(1);
    expect(clampZoomFactor(1.26)).toBe(1.3);
  });

  it('ten nudges from 100 % land on exactly 200 %, with no float drift on the way', () => {
    let f = 1;
    const seen = [];
    for (let i = 0; i < 12; i += 1) { f = clampZoomFactor(f + ZOOM_STEP); seen.push(f); }
    expect(seen.slice(0, 10)).toEqual([1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2]);
    expect(seen[11]).toBe(2);
  });

  it('non-numbers are 100 %', () => {
    for (const bad of [NaN, undefined, null, 'x', Infinity]) expect(clampZoomFactor(bad)).toBe(1);
  });

  it('restores a stored percent, old or missing values included', () => {
    expect(factorFromStoredPercent(150)).toBe(1.5);
    expect(factorFromStoredPercent(undefined)).toBe(1);
    expect(factorFromStoredPercent(50)).toBe(1);
    expect(factorFromStoredPercent(999)).toBe(2);
  });
});
