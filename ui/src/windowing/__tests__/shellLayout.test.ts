import { describe, expect, it } from 'vitest';
import {
  ARRANGEMENT_CHROME_H,
  ARRANGEMENT_MIN_H,
  ARRANGEMENT_PREFERRED_H,
  TRACK_ROW_H,
  autoDockHeight,
  computeShellLayout,
  type ShellLayoutInput,
} from '../layout/shellLayout';
import { isRegionHiddenByShell, resetShellLayoutStore, useShellLayoutStore } from '../layout/shellLayoutStore';

const base: ShellLayoutInput = {
  columnH: 1022,
  dockOpen: true,
  dockStored: 304,
  dockUserSized: false,
  topStored: 340,
  topUserSized: false,
  topPresent: true,
};

const rows = (arrangementH: number) => Math.floor((arrangementH - ARRANGEMENT_CHROME_H) / TRACK_ROW_H);

describe('autoDockHeight', () => {
  it('is clamp(320, 40% of the column, 520)', () => {
    expect(autoDockHeight(1022)).toBe(409);
    expect(autoDockHeight(710)).toBe(320);
    expect(autoDockHeight(2000)).toBe(520);
  });
});

describe('computeShellLayout', () => {
  it('1920x1080 (column 1022), dock open: dock 409, top 242, arrangement 371 (8 rows)', () => {
    const l = computeShellLayout(base);
    expect(l).toEqual({ dockH: 409, topMode: 'full', topH: 242, arrangementH: 371 });
    expect(rows(l.arrangementH)).toBe(8);
  });

  it('1366x768 (column 710), dock open: top folds to a 28px strip, arrangement 362 (7 rows)', () => {
    const l = computeShellLayout({ ...base, columnH: 710 });
    expect(l).toEqual({ dockH: 320, topMode: 'strip', topH: 28, arrangementH: 362 });
    expect(rows(l.arrangementH)).toBe(7);
  });

  it('dock collapsed keeps the stored top row at 1080 and trims it at 768', () => {
    expect(computeShellLayout({ ...base, dockOpen: false })).toEqual({
      dockH: 29, topMode: 'full', topH: 340, arrangementH: 653,
    });
    expect(computeShellLayout({ ...base, dockOpen: false, columnH: 710 })).toEqual({
      dockH: 29, topMode: 'full', topH: 310, arrangementH: 371,
    });
  });

  it('never squeezes the top row under 200 or the arrangement under 4 rows', () => {
    for (let h = 400; h <= 1600; h += 7) {
      for (const dockOpen of [true, false]) {
        const l = computeShellLayout({ ...base, columnH: h, dockOpen });
        expect(l.dockH + l.topH + l.arrangementH).toBe(h);
        if (l.topMode === 'full') expect(l.topH).toBeGreaterThanOrEqual(200);
        expect(l.arrangementH).toBeGreaterThanOrEqual(Math.min(ARRANGEMENT_MIN_H, h - 160 - 28));
      }
    }
  });

  it('honours a user-sized dock, and caps it so the arrangement keeps 4 rows', () => {
    const fits = computeShellLayout({ ...base, dockStored: 520, dockUserSized: true });
    expect(fits).toMatchObject({ dockH: 520, topMode: 'full', topH: 200 });
    const big = computeShellLayout({ ...base, dockStored: 600, dockUserSized: true });
    expect(big.dockH).toBe(600);
    expect(big.topMode).toBe('strip');
    const huge = computeShellLayout({ ...base, columnH: 710, dockStored: 600, dockUserSized: true });
    expect(huge.arrangementH).toBe(ARRANGEMENT_MIN_H);
  });

  it('a user-resized top row may take space down to the 4-row minimum', () => {
    const l = computeShellLayout({ ...base, topStored: 600, topUserSized: true });
    expect(l.topMode).toBe('full');
    expect(l.arrangementH).toBe(ARRANGEMENT_MIN_H);
  });

  it('has no top row when the region holds nothing', () => {
    const l = computeShellLayout({ ...base, topPresent: false });
    expect(l).toMatchObject({ topMode: 'none', topH: 0, dockH: 409, arrangementH: 613 });
  });

  // Compose (the default preset): no top row, so the arrangement has the column minus the dock.
  it('Compose: 14 rows at 1920x1080, 13 in a 1032px window, 8 at 1366x768, dock open', () => {
    const compose = { ...base, topPresent: false };
    expect(rows(computeShellLayout(compose).arrangementH)).toBe(14);
    expect(rows(computeShellLayout({ ...compose, columnH: 974 }).arrangementH)).toBe(13);
    const small = computeShellLayout({ ...compose, columnH: 710 });
    expect(small).toMatchObject({ topMode: 'none', dockH: 320, arrangementH: 390 });
    expect(rows(small.arrangementH)).toBe(8);
  });

  it('the arrangement chrome is the toolbar, the ruler, the cue lane and a border', () => {
    expect(ARRANGEMENT_CHROME_H).toBe(32 + 26 + 24 + 1);
    expect(ARRANGEMENT_MIN_H).toBe(83 + 4 * 36);
    expect(ARRANGEMENT_PREFERRED_H).toBe(83 + 8 * 36);
  });
});

describe('folded top row', () => {
  it('hides the top region from its panels until it is peeked open', () => {
    resetShellLayoutStore();
    expect(isRegionHiddenByShell(useShellLayoutStore.getState(), 'top')).toBe(false);
    useShellLayoutStore.getState().setTopMode('strip');
    expect(isRegionHiddenByShell(useShellLayoutStore.getState(), 'top')).toBe(true);
    useShellLayoutStore.getState().setPeek(true);
    expect(isRegionHiddenByShell(useShellLayoutStore.getState(), 'top')).toBe(false);
    expect(isRegionHiddenByShell(useShellLayoutStore.getState(), 'center')).toBe(false);
    // The peek only means something while folded.
    useShellLayoutStore.getState().setTopMode('full');
    expect(useShellLayoutStore.getState().peek).toBe(false);
  });
});
