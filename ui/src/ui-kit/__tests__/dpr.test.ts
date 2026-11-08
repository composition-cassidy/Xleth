/**
 * @vitest-environment jsdom
 */
// The UI scale is window zoom, which changes devicePixelRatio. Every canvas must
// re-size its backing store (cssSize * DPR) and redraw when that happens.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { backingSize, getDpr, subscribeDpr } from '../dpr';
import { bumpThemeEpoch } from '../../theming/useThemeEpoch.js';

describe('dpr signal', () => {
  type Listener = () => void;
  let listeners: Listener[];
  let dpr: number;

  beforeEach(() => {
    listeners = [];
    dpr = 1;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => dpr });
    window.matchMedia = vi.fn(() => ({
      matches: true,
      addEventListener: (_: string, fn: Listener) => { listeners.push(fn); },
      removeEventListener: (_: string, fn: Listener) => { listeners = listeners.filter((l) => l !== fn); },
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('sizes a backing store by CSS size x DPR (never zero)', () => {
    expect(backingSize(100, 1.5)).toBe(150);
    expect(backingSize(0, 2)).toBe(1);
    dpr = 1.875;
    expect(getDpr()).toBe(1.875);
    expect(backingSize(40)).toBe(75);
  });

  it('notifies subscribers when the ratio leaves its value, then re-arms for the new one', () => {
    const seen: number[] = [];
    const off = subscribeDpr((d) => seen.push(d));
    expect(listeners).toHaveLength(1);
    dpr = 1.5;
    listeners.forEach((l) => l());
    expect(seen).toEqual([1.5]);
    // Re-armed against the new ratio: still exactly one live media-query listener.
    expect(listeners).toHaveLength(1);
    dpr = 2;
    listeners.forEach((l) => l());
    expect(seen).toEqual([1.5, 2]);
    off();
    expect(listeners).toHaveLength(0);
  });

  it('ignores a media-query wake-up that did not change the ratio', () => {
    const seen: number[] = [];
    const off = subscribeDpr((d) => seen.push(d));
    listeners.forEach((l) => l());
    expect(seen).toEqual([]);
    off();
  });

  it('exposes the theme epoch bump used by the canvases that already key on it', () => {
    expect(typeof bumpThemeEpoch).toBe('function');
  });
});

// A canvas that reads devicePixelRatio but is never told it changed stays blurry after a
// zoom. This audit makes every such file name how it is told: the shared epoch hook, the
// DPR subscription, or a per-frame size check (rAF loops that re-read the ratio each frame).
describe('every canvas that reads devicePixelRatio is told when it changes', () => {
  const SRC = path.resolve(__dirname, '..', '..');

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '__tests__'].includes(e.name)) continue;
        walk(p, out);
      } else if (/\.(jsx?|tsx?)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
    }
    return out;
  }

  // rAF / per-frame loops: the size is recomputed from the live ratio on every frame.
  const PER_FRAME = new Set([
    'components/devices/OverdoneCrossoverCanvas.jsx',
    'components/mixer/ApexAnalysis.jsx',
    'plugin-ui/runtime/components/CompressorCurveNode.jsx',
    'plugin-ui/runtime/components/DistortionCurveNode.jsx',
    'plugin-ui/runtime/components/OverdoneCrossoverNode.jsx',
    'plugin-ui/runtime/visualizers/DynamicsVisualizerCanvas.jsx',
  ]);
  // Not canvases that live across a zoom: the helper itself, a one-shot capture, the signal module.
  const EXEMPT = new Set([
    'components/mixer/mixerCanvasTheme.js',
    'ui-kit/dpr.ts',
  ]);

  const readers = walk(SRC)
    .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
    .filter((rel) => !rel.startsWith('backdrop/'))
    .filter((rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').includes('devicePixelRatio'));

  it('finds the canvases', () => {
    expect(readers.length).toBeGreaterThan(30);
  });

  for (const rel of readers) {
    it(`${rel}`, () => {
      if (EXEMPT.has(rel)) return;
      const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
      if (PER_FRAME.has(rel)) {
        expect(src, 'a per-frame canvas must re-read the ratio inside its draw loop').toMatch(/requestAnimationFrame/);
        return;
      }
      expect(src).toMatch(/useThemeEpoch|subscribeDpr|useDprEpoch/);
    });
  }
});
