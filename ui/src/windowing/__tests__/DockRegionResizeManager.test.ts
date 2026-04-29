import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginDockRegionResize,
  cancelDockRegionResize,
  cancelDockRegionResizeIfActive,
  endDockRegionResize,
  isDockRegionResizing,
  updateDockRegionResize,
} from '../managers/DockRegionResizeManager';
import {
  createInitialDockRegionSizes,
  createInitialPanelStates,
  MIN_DOCK_REGION_SIZES,
  usePanelRegistry,
  type DockRegion,
} from '../registry/PanelRegistry';

const originalSetDockRegionSize = usePanelRegistry.getState().setDockRegionSize;

function resetRegistry() {
  usePanelRegistry.setState({
    panels: createInitialPanelStates(),
    dockRegionSizes: createInitialDockRegionSizes(),
    setDockRegionSize: originalSetDockRegionSize,
  });
}

describe('DockRegionResizeManager', () => {
  beforeEach(() => {
    cancelDockRegionResize();
    resetRegistry();
  });

  it.each<{ region: DockRegion; dx: number; dy: number; startSize: number; expected: number }>([
    { region: 'left', dx: 100, dy: 0, startSize: 280, expected: 380 },
    { region: 'right', dx: -100, dy: 0, startSize: 280, expected: 380 },
    { region: 'top', dx: 0, dy: 80, startSize: 240, expected: 320 },
    { region: 'bottom', dx: 0, dy: -80, startSize: 240, expected: 320 },
  ])('resizes the $region region by the correct delta', ({ region, dx, dy, startSize, expected }) => {
    const axis = (region === 'left' || region === 'right') ? 'horizontal' : 'vertical';
    beginDockRegionResize(region, axis, 0, 0, startSize);
    updateDockRegionResize(dx, dy);
    endDockRegionResize();
    expect(usePanelRegistry.getState().dockRegionSizes[region]).toBe(expected);
  });

  it.each<{ region: DockRegion; dx: number; dy: number; min: number }>([
    { region: 'left', dx: -10000, dy: 0, min: MIN_DOCK_REGION_SIZES.left },
    { region: 'right', dx: 10000, dy: 0, min: MIN_DOCK_REGION_SIZES.right },
    { region: 'top', dx: 0, dy: -10000, min: MIN_DOCK_REGION_SIZES.top },
    { region: 'bottom', dx: 0, dy: 10000, min: MIN_DOCK_REGION_SIZES.bottom },
  ])('clamps $region at the per-region minimum', ({ region, dx, dy, min }) => {
    const axis = (region === 'left' || region === 'right') ? 'horizontal' : 'vertical';
    beginDockRegionResize(region, axis, 0, 0, 280);
    updateDockRegionResize(dx, dy);
    endDockRegionResize();
    expect(usePanelRegistry.getState().dockRegionSizes[region]).toBe(min);
  });

  it('commits to the registry exactly once on end', () => {
    const calls: Array<[DockRegion, number]> = [];
    usePanelRegistry.setState({
      setDockRegionSize: (region, size) => {
        calls.push([region, size]);
        originalSetDockRegionSize(region, size);
      },
    });

    beginDockRegionResize('left', 'horizontal', 0, 0, 280);
    updateDockRegionResize(50, 0);
    updateDockRegionResize(100, 0);
    expect(calls).toHaveLength(0);

    endDockRegionResize();
    expect(calls).toEqual([['left', 380]]);
  });

  it('does not commit on cancel', () => {
    const calls: Array<[DockRegion, number]> = [];
    usePanelRegistry.setState({
      setDockRegionSize: (region, size) => {
        calls.push([region, size]);
      },
    });

    beginDockRegionResize('bottom', 'vertical', 0, 0, 240);
    updateDockRegionResize(0, -50);
    cancelDockRegionResize();
    expect(calls).toHaveLength(0);
    expect(isDockRegionResizing()).toBe(false);
  });

  it('cancelDockRegionResizeIfActive returns true when active', () => {
    expect(cancelDockRegionResizeIfActive()).toBe(false);
    beginDockRegionResize('left', 'horizontal', 0, 0, 280);
    expect(cancelDockRegionResizeIfActive()).toBe(true);
    expect(isDockRegionResizing()).toBe(false);
  });
});
