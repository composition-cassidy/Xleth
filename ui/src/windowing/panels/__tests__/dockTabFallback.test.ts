// Round 3 (ui/DESIGN.md 14, 15): the Piano Roll and Sampler tabs never open onto an empty
// dock while the project has something they could show.
import { beforeEach, describe, expect, it } from 'vitest';
import { fallbackPatternId, fallbackSamplerRegionId } from '../dockTabFallback';
import usePianoRollStore from '../../../stores/usePianoRollStore.js';

const patterns = {
  7: { id: 7, regionId: 41 },
  3: { id: 3, regionId: 40 },
  12: { id: 12, regionId: -1 },
};

describe('fallbackPatternId', () => {
  it('is the pattern last open in the Piano Roll while it still exists', () => {
    expect(fallbackPatternId(patterns, 7)).toBe(7);
    expect(fallbackPatternId(patterns, 12)).toBe(12);
  });

  it('is the first pattern (lowest id) when there is no last one, or it was deleted', () => {
    expect(fallbackPatternId(patterns, null)).toBe(3);
    expect(fallbackPatternId(patterns, undefined)).toBe(3);
    expect(fallbackPatternId(patterns, 99)).toBe(3);
  });

  it('is null only when the project has no patterns', () => {
    expect(fallbackPatternId({}, 7)).toBeNull();
    expect(fallbackPatternId(null, 7)).toBeNull();
    expect(fallbackPatternId({ a: null, b: { id: -1 } }, null)).toBeNull();
  });
});

describe('fallbackSamplerRegionId', () => {
  it('whoever opened the panel for a region wins', () => {
    expect(fallbackSamplerRegionId(55, patterns, 7, 3)).toBe(55);
    expect(fallbackSamplerRegionId(0, patterns, 7, 3)).toBe(0);
  });

  it('with nothing handed over it follows the open pattern, then the last one, then the first that plays a sample', () => {
    expect(fallbackSamplerRegionId(null, patterns, 7, 3)).toBe(41);
    expect(fallbackSamplerRegionId(undefined, patterns, null, 7)).toBe(41);
    expect(fallbackSamplerRegionId(null, patterns, null, null)).toBe(40);
    // The open pattern plays no sample (regionId -1): fall through to the last, then the first.
    expect(fallbackSamplerRegionId(null, patterns, 12, 7)).toBe(41);
    expect(fallbackSamplerRegionId(null, patterns, 12, null)).toBe(40);
  });

  it('ignores a region id that is not a non-negative integer', () => {
    expect(fallbackSamplerRegionId('41', patterns, 3, null)).toBe(40);
    expect(fallbackSamplerRegionId(-1, patterns, 3, null)).toBe(40);
    expect(fallbackSamplerRegionId(1.5, patterns, 3, null)).toBe(40);
  });

  it('is null only when no pattern plays a sample', () => {
    expect(fallbackSamplerRegionId(null, {}, null, null)).toBeNull();
    expect(fallbackSamplerRegionId(null, { 12: { id: 12, regionId: -1 } }, 12, 12)).toBeNull();
  });
});

describe('usePianoRollStore remembers the last pattern that was open', () => {
  beforeEach(() => usePianoRollStore.setState({ patternId: null, lastPatternId: null }));

  it('opening a pattern records it; closing (null) keeps the record', () => {
    usePianoRollStore.getState().setPatternId(7);
    expect(usePianoRollStore.getState()).toMatchObject({ patternId: 7, lastPatternId: 7 });
    usePianoRollStore.getState().setPatternId(3);
    expect(usePianoRollStore.getState().lastPatternId).toBe(3);
    // PianoRollPanel's close handler sets the id to null: the Piano Roll is closed, and stays
    // closed, but its tab will have something to show when it is opened again.
    usePianoRollStore.getState().setPatternId(null);
    expect(usePianoRollStore.getState()).toMatchObject({ patternId: null, lastPatternId: 3 });
    expect(fallbackPatternId(patterns, usePianoRollStore.getState().lastPatternId)).toBe(3);
  });
});
