import { describe, expect, it } from 'vitest';
import { snapDockSplitterPosition } from '../managers/dockedPanelSnapping';

describe('dock splitter snapping', () => {
  it('snaps to targets within the threshold', () => {
    expect(snapDockSplitterPosition({
      rawPosition: 104,
      targets: [100, 200],
      threshold: 8,
    })).toEqual({ position: 100, snapped: true, target: 100 });
  });

  it('does not snap to distant targets', () => {
    expect(snapDockSplitterPosition({
      rawPosition: 113,
      targets: [100],
      threshold: 8,
    })).toEqual({ position: 113, snapped: false, target: null });
  });

  it('chooses the nearest target', () => {
    expect(snapDockSplitterPosition({
      rawPosition: 147,
      targets: [140, 150],
      threshold: 8,
    })).toEqual({ position: 150, snapped: true, target: 150 });
  });

  it('breaks equal-distance ties toward the lower coordinate', () => {
    expect(snapDockSplitterPosition({
      rawPosition: 145,
      targets: [150, 140],
      threshold: 8,
    })).toEqual({ position: 140, snapped: true, target: 140 });
  });

  it('can be disabled for modifier-key precision drags', () => {
    expect(snapDockSplitterPosition({
      rawPosition: 104,
      targets: [100],
      threshold: 8,
      disabled: true,
    })).toEqual({ position: 104, snapped: false, target: null });
  });
});
