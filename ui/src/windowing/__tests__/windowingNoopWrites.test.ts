/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useSnapStore from '../../stores/snapStore.js';
import useTimelineDisplayStore from '../../stores/timelineDisplayStore.js';
import useTimelineFocusStore from '../../stores/timelineFocusStore.js';
import useUIStore from '../../stores/uiStore.js';
import {
  beginDrag,
  cancelDrag,
  getDragState,
  registerWorkAreaRect,
} from '../managers/DragManager';
import { createInitialPanelStates, usePanelRegistry } from '../registry/PanelRegistry';

function countRegistryNotifications(run: () => void): number {
  let notifications = 0;
  const unsubscribe = usePanelRegistry.subscribe(() => {
    notifications += 1;
  });
  run();
  unsubscribe();
  return notifications;
}

describe('windowing no-op writes', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'xleth', {
      configurable: true,
      value: {
        settings: {
          get: vi.fn(async () => null),
          set: vi.fn(async () => undefined),
        },
      },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    usePanelRegistry.setState({ panels: createInitialPanelStates() });
    useTimelineFocusStore.setState({ focusedTrackId: null });
    useUIStore.setState({ timelineTrackHeaderWidth: 200 });
    useSnapStore.setState({ snapGranularity: '1/16' });
    cancelDrag();
    registerWorkAreaRect({ left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not notify registry subscribers for identical panel operations', () => {
    const registry = usePanelRegistry.getState();
    registry.openPanel('timeline');

    expect(countRegistryNotifications(() => registry.focusPanel('timeline'))).toBe(0);
    expect(countRegistryNotifications(() => registry.moveFloatingPanel(
      'timeline',
      usePanelRegistry.getState().panels.timeline.floating.x,
      usePanelRegistry.getState().panels.timeline.floating.y,
    ))).toBe(0);
    expect(countRegistryNotifications(() => registry.resizeFloatingPanel(
      'timeline',
      usePanelRegistry.getState().panels.timeline.floating.x,
      usePanelRegistry.getState().panels.timeline.floating.y,
      usePanelRegistry.getState().panels.timeline.floating.width,
      usePanelRegistry.getState().panels.timeline.floating.height,
    ))).toBe(0);

    registry.dockPanel('timeline', 'bottom');
    expect(countRegistryNotifications(() => registry.dockPanel('timeline', 'bottom'))).toBe(0);

    registry.closePanel('mixer');
    expect(countRegistryNotifications(() => registry.closePanel('mixer'))).toBe(0);
  });

  it('returns previous state for identical timeline store writes', () => {
    const focusBefore = useTimelineFocusStore.getState();
    useTimelineFocusStore.getState().setFocusedTrackId(null);
    expect(useTimelineFocusStore.getState()).toBe(focusBefore);

    const uiBefore = useUIStore.getState();
    useUIStore.getState().setTimelineTrackHeaderWidth(200);
    expect(useUIStore.getState()).toBe(uiBefore);

    const snapBefore = useSnapStore.getState();
    useSnapStore.getState().setSnapGranularity('1/16');
    expect(useSnapStore.getState()).toBe(snapBefore);

    const displayBefore = useTimelineDisplayStore.getState();
    useTimelineDisplayStore.getState().setTimelineDisplaySetting('timelineClipBodyMode', 'plain');
    expect(useTimelineDisplayStore.getState()).toBe(displayBefore);
  });

  it('keeps repeated workspace rect updates numeric and stable for drag snapshots', () => {
    const rect = { left: 100, top: 64, right: 900, bottom: 700 };
    registerWorkAreaRect(rect);
    registerWorkAreaRect({ ...rect });

    beginDrag('timeline', 500, 400, 100, 100);
    const dragState = getDragState();
    expect(dragState.state).toBe('dragging');
    if (dragState.state === 'dragging') {
      expect(dragState.workAreaRect).toEqual(rect);
      expect(dragState.workAreaRect).not.toBe(rect);
    }
    cancelDrag();
  });
});
