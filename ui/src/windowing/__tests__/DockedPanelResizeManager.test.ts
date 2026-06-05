import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginDockedPanelResize,
  cancelDockedPanelResize,
  cancelDockedPanelResizeIfActive,
  endDockedPanelResize,
  isDockedPanelResizing,
  updateDockedPanelResize,
} from '../managers/DockedPanelResizeManager';
import {
  createInitialPanelStates,
  MIN_DOCKED_PANEL_MAIN_SIZES,
  usePanelRegistry,
} from '../registry/PanelRegistry';

const originalResizeDockedPanelPair = usePanelRegistry.getState().resizeDockedPanelPair;

function resetRegistry() {
  cancelDockedPanelResize();
  const panels = createInitialPanelStates();
  panels.timeline.hidden = false;
  panels.timeline.mode = 'docked';
  panels.timeline.docked = { region: 'bottom', orderInRegion: 0, sizeInRegion: 300 };
  panels.mixer.hidden = false;
  panels.mixer.mode = 'docked';
  panels.mixer.docked = { region: 'bottom', orderInRegion: 1, sizeInRegion: 300 };
  usePanelRegistry.setState({
    panels,
    resizeDockedPanelPair: originalResizeDockedPanelPair,
  });
}

function beginBottomResize() {
  beginDockedPanelResize(0, 0, {
    region: 'bottom',
    axis: 'horizontal',
    beforeId: 'timeline',
    afterId: 'mixer',
    beforeSize: 300,
    afterSize: 300,
    startSplitterPosition: 300,
    snapTargets: [340],
  });
}

describe('DockedPanelResizeManager', () => {
  beforeEach(resetRegistry);

  it('resizes adjacent docked panel sizes while preserving their total', () => {
    beginBottomResize();
    updateDockedPanelResize(50, 0);
    endDockedPanelResize();

    const panels = usePanelRegistry.getState().panels;
    expect(panels.timeline.docked.sizeInRegion).toBe(350);
    expect(panels.mixer.docked.sizeInRegion).toBe(250);
  });

  it('clamps adjacent panels at centralized docked minimums', () => {
    beginBottomResize();
    updateDockedPanelResize(-1000, 0);
    endDockedPanelResize();

    const panels = usePanelRegistry.getState().panels;
    expect(panels.timeline.docked.sizeInRegion).toBe(MIN_DOCKED_PANEL_MAIN_SIZES.timeline);
    expect(panels.mixer.docked.sizeInRegion).toBe(600 - MIN_DOCKED_PANEL_MAIN_SIZES.timeline);
  });

  it('snaps splitter movement to nearby targets', () => {
    beginBottomResize();
    updateDockedPanelResize(38, 0);
    endDockedPanelResize();

    const panels = usePanelRegistry.getState().panels;
    expect(panels.timeline.docked.sizeInRegion).toBe(340);
    expect(panels.mixer.docked.sizeInRegion).toBe(260);
  });

  it('Alt bypasses snapping during the drag', () => {
    beginBottomResize();
    updateDockedPanelResize(38, 0, { altKey: true });
    endDockedPanelResize();

    const panels = usePanelRegistry.getState().panels;
    expect(panels.timeline.docked.sizeInRegion).toBe(338);
    expect(panels.mixer.docked.sizeInRegion).toBe(262);
  });

  it('does not commit on cancel', () => {
    beginBottomResize();
    updateDockedPanelResize(50, 0);
    cancelDockedPanelResize();

    const panels = usePanelRegistry.getState().panels;
    expect(panels.timeline.docked.sizeInRegion).toBe(300);
    expect(panels.mixer.docked.sizeInRegion).toBe(300);
    expect(isDockedPanelResizing()).toBe(false);
  });

  it('commits to the registry exactly once on end', () => {
    const calls: Array<[number, number]> = [];
    usePanelRegistry.setState({
      resizeDockedPanelPair: (region, beforeId, beforeSize, afterId, afterSize) => {
        calls.push([beforeSize, afterSize]);
        originalResizeDockedPanelPair(region, beforeId, beforeSize, afterId, afterSize);
      },
    });

    beginBottomResize();
    updateDockedPanelResize(20, 0);
    updateDockedPanelResize(50, 0);
    expect(calls).toHaveLength(0);

    endDockedPanelResize();
    expect(calls).toEqual([[350, 250]]);
  });

  it('cancelDockedPanelResizeIfActive returns true only while active', () => {
    expect(cancelDockedPanelResizeIfActive()).toBe(false);
    beginBottomResize();
    expect(cancelDockedPanelResizeIfActive()).toBe(true);
    expect(isDockedPanelResizing()).toBe(false);
  });
});
