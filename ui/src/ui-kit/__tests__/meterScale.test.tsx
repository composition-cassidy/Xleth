/**
 * @vitest-environment jsdom
 */
// The Meter's scale modes and the standalone MeterScale (ui/DESIGN.md 10): a row of meters
// prints its dB numerals once, so a meter with bare ticks and the scale beside the row must
// agree on which marks a given height shows, and on where they sit.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Meter, { DEFAULT_SCALE_DB, MeterScale, meterWidth, visibleScaleMarks } from '../Meter';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const noFeed = () => () => {};

describe('visibleScaleMarks', () => {
  it('keeps every mark that is at least 12px from the one before it, and puts 0 dB at the top', () => {
    const tall = visibleScaleMarks(DEFAULT_SCALE_DB, -60, 0, 240);
    expect(tall.map((m) => m.db)).toEqual([0, -6, -12, -24, -36, -48, -60]);
    expect(tall[0].y).toBe(0);
    expect(tall[tall.length - 1].y).toBe(240);

    // 110px: -6 would sit 11px under 0, so it is dropped; everything else stays.
    expect(visibleScaleMarks(DEFAULT_SCALE_DB, -60, 0, 110).map((m) => m.db)).toEqual([0, -12, -24, -36, -48, -60]);
  });

  it('is one rule: two meters of the same height always show the same marks at the same y', () => {
    for (const h of [48, 64, 89, 118, 171, 282]) {
      expect(visibleScaleMarks(DEFAULT_SCALE_DB, -60, 0, h)).toEqual(visibleScaleMarks(DEFAULT_SCALE_DB, -60, 0, h));
      const ys = visibleScaleMarks(DEFAULT_SCALE_DB, -60, 0, h).map((m) => m.y);
      for (let i = 1; i < ys.length; i += 1) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(12);
    }
  });

  it('skips values outside the range, and reads downward for a gain-reduction meter', () => {
    expect(visibleScaleMarks([6, 0, -30, -90], -60, 0, 200).map((m) => m.db)).toEqual([0, -30]);
    const down = visibleScaleMarks([0, 10, 20], 0, 20, 100, true);
    expect(down.map((m) => m.y)).toEqual([0, 50, 100]);
  });
});

describe('Meter scale modes', () => {
  it('a ticks-only meter is narrower than a labelled one', () => {
    expect(meterWidth(2, true, 'labels')).toBe(15 + 22);
    expect(meterWidth(2, true, 'ticks')).toBe(15 + 5);
    expect(meterWidth(2, false)).toBe(15);
    // The default is unchanged for every existing caller.
    expect(meterWidth(2, true)).toBe(meterWidth(2, true, 'labels'));
  });

  it('draws the clip latch as an outlined button by default', async () => {
    await act(async () => { root.render(<Meter label="Track 1" subscribe={noFeed} />); });
    const latch = container.querySelector('button');
    expect(latch?.getAttribute('aria-label')).toBe('Track 1: no clipping');
    expect(container.querySelector('[data-clip-space]')).toBeNull();
  });

  it('clipLatch="latched" draws nothing until the meter clips, then the same clickable latch', async () => {
    let push: (levels: number | readonly number[]) => void = () => {};
    // One frame at a time: the meter's loop re-requests a frame until it settles.
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
    const runFrame = () => act(async () => { frames.shift()?.(performance.now()); });
    await act(async () => {
      root.render(<Meter label="Track 1" clipLatch="latched" subscribe={(p) => { push = p; return () => {}; }} />);
    });
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[data-clip-space]')).not.toBeNull();

    await act(async () => { push([3]); });
    await runFrame();
    const latch = container.querySelector('button');
    expect(latch?.getAttribute('aria-label')).toBe('Track 1: clipped. Click to clear');
    expect(latch?.getAttribute('data-clipped')).toBe('true');

    await act(async () => { latch?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('button')).toBeNull();
    raf.mockRestore();
  });
});

describe('MeterScale', () => {
  it('is a labelled image with a meter\'s own box: the latch space, then a canvas', async () => {
    await act(async () => { root.render(<MeterScale />); });
    const scale = container.firstElementChild as HTMLElement;
    expect(scale.getAttribute('role')).toBe('img');
    expect(scale.getAttribute('aria-label')).toBe('Level scale, 0 to −60 dB');
    expect(scale.children).toHaveLength(2);
    expect(scale.children[0].getAttribute('aria-hidden')).toBe('true');
    expect(scale.children[1].tagName).toBe('CANVAS');
    // It carries no level: nothing to subscribe to, no button.
    expect(scale.querySelector('button')).toBeNull();
  });
});
