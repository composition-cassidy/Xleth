import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ActiveDragState,
  beginDrag,
  cancelDrag,
  endDrag,
  getDragState,
  registerWorkAreaRect,
  subscribeDrag,
  updateDrag,
  useDragOffset,
} from '../managers/DragManager';
import {
  createInitialPanelStates,
  usePanelRegistry,
} from '../registry/PanelRegistry';

const originalMoveFloatingPanel = usePanelRegistry.getState().moveFloatingPanel;
const originalDockPanel = usePanelRegistry.getState().dockPanel;

function resetRegistry() {
  cancelDrag();
  registerWorkAreaRect({ left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity });
  usePanelRegistry.setState({
    panels: createInitialPanelStates(),
    moveFloatingPanel: originalMoveFloatingPanel,
    dockPanel: originalDockPanel,
  });
  vi.useRealTimers();
}

describe('DragManager', () => {
  beforeEach(resetRegistry);

  it('transitions idle to dragging and back to idle', () => {
    expect(getDragState().state).toBe('idle');

    beginDrag('timeline', 10, 12, 100, 140);
    expect(getDragState()).toMatchObject({
      state: 'dragging',
      panelId: 'timeline',
      startMouseX: 10,
      startMouseY: 12,
      startPanelX: 100,
      startPanelY: 140,
      currentMouseX: 10,
      currentMouseY: 12,
    });

    updateDrag(24, 42);
    expect(getDragState()).toMatchObject({
      state: 'dragging',
      currentMouseX: 24,
      currentMouseY: 42,
    });

    endDrag();
    expect(getDragState().state).toBe('idle');
  });

  it('commits the final position exactly once on endDrag', () => {
    const start = usePanelRegistry.getState().panels.timeline.floating;
    const calls: Array<[number, number]> = [];

    usePanelRegistry.setState({
      moveFloatingPanel: (id, x, y) => {
        calls.push([x, y]);
        originalMoveFloatingPanel(id, x, y);
      },
    });

    beginDrag('timeline', 20, 40, start.x, start.y);
    updateDrag(95, 24);
    updateDrag(120, 88);
    endDrag();

    expect(calls).toEqual([[start.x + 100, start.y + 48]]);
    expect(usePanelRegistry.getState().panels.timeline.floating).toMatchObject({
      x: start.x + 100,
      y: start.y + 48,
    });
  });

  it('cancels without committing to the registry', () => {
    const start = usePanelRegistry.getState().panels.timeline.floating;
    let calls = 0;

    usePanelRegistry.setState({
      moveFloatingPanel: (id, x, y) => {
        calls += 1;
        originalMoveFloatingPanel(id, x, y);
      },
    });

    beginDrag('timeline', 0, 0, start.x, start.y);
    updateDrag(50, 70);
    cancelDrag();

    expect(calls).toBe(0);
    expect(usePanelRegistry.getState().panels.timeline.floating).toMatchObject({
      x: start.x,
      y: start.y,
    });
  });

  it('returns a stable drag offset snapshot between updates', () => {
    const snapshots: Array<{ dx: number; dy: number } | null> = [];

    function Probe() {
      snapshots.push(useDragOffset('timeline'));
      return React.createElement('span');
    }

    beginDrag('timeline', 10, 20, 100, 120);
    updateDrag(42, 66);

    renderToStaticMarkup(React.createElement(Probe));
    renderToStaticMarkup(React.createElement(Probe));

    expect(snapshots[0]).toEqual({ dx: 32, dy: 46 });
    expect(snapshots[0]).toBe(snapshots[1]);
  });

  it('does not notify a listener after unsubscribe', () => {
    let calls = 0;
    const unsubscribe = subscribeDrag(() => {
      calls += 1;
    });

    beginDrag('timeline', 0, 0, 0, 0);
    expect(calls).toBe(1);

    unsubscribe();
    updateDrag(10, 10);
    cancelDrag();

    expect(calls).toBe(1);
  });

  it('sets snap target when mouse is within 40px of work-area edge', () => {
    registerWorkAreaRect({ left: 0, top: 0, right: 1200, bottom: 800 });
    beginDrag('timeline', 200, 400, 100, 100);

    updateDrag(30, 400);
    expect((getDragState() as ActiveDragState).currentSnapTarget).toBe('left');

    updateDrag(600, 400);
    expect((getDragState() as ActiveDragState).currentSnapTarget).toBeNull();
  });

  it('docks panel when snap target holds for >= 150ms', () => {
    vi.useFakeTimers();
    registerWorkAreaRect({ left: 0, top: 0, right: 1200, bottom: 800 });

    const moveCalls: Array<[number, number]> = [];
    const dockCalls: Array<string> = [];
    usePanelRegistry.setState({
      moveFloatingPanel: (id, x, y) => {
        moveCalls.push([x, y]);
        originalMoveFloatingPanel(id, x, y);
      },
      dockPanel: (id, region) => {
        dockCalls.push(region);
        originalDockPanel(id, region);
      },
    });

    beginDrag('timeline', 200, 400, 100, 100);
    updateDrag(20, 400);
    vi.advanceTimersByTime(150);
    endDrag();

    expect(dockCalls).toEqual(['left']);
    expect(moveCalls).toHaveLength(0);

    vi.useRealTimers();
  });

  it('moves panel when snap target dwell is < 150ms', () => {
    vi.useFakeTimers();
    registerWorkAreaRect({ left: 0, top: 0, right: 1200, bottom: 800 });

    const moveCalls: Array<[number, number]> = [];
    const dockCalls: Array<string> = [];
    usePanelRegistry.setState({
      moveFloatingPanel: (id, x, y) => {
        moveCalls.push([x, y]);
        originalMoveFloatingPanel(id, x, y);
      },
      dockPanel: (id, region) => {
        dockCalls.push(region);
        originalDockPanel(id, region);
      },
    });

    const start = usePanelRegistry.getState().panels.timeline.floating;
    beginDrag('timeline', 200, 400, start.x, start.y);
    updateDrag(20, 400);
    vi.advanceTimersByTime(50);
    endDrag();

    expect(moveCalls).toHaveLength(1);
    expect(dockCalls).toHaveLength(0);

    vi.useRealTimers();
  });
});
