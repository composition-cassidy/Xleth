import { beforeEach, describe, expect, it } from 'vitest';
import {
  registerWorkAreaRect,
} from '../managers/DragManager';
import {
  beginResize,
  cancelResize,
  endResize,
  MIN_PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
  type ResizeEdge,
  updateResize,
} from '../managers/ResizeManager';
import {
  createInitialPanelStates,
  usePanelRegistry,
  type FloatingPanelState,
} from '../registry/PanelRegistry';

const originalResizeFloatingPanel = usePanelRegistry.getState().resizeFloatingPanel;
const START_BOUNDS: FloatingPanelState = { x: 100, y: 80, width: 320, height: 200 };

interface ResizeCase {
  edge: ResizeEdge;
  dx: number;
  dy: number;
  expected: FloatingPanelState;
}

function setTimelineBounds(bounds: FloatingPanelState) {
  const panels = createInitialPanelStates();
  panels.timeline.hidden = false;
  panels.timeline.mode = 'floating';
  panels.timeline.floating = { ...bounds };
  usePanelRegistry.setState({
    panels,
    resizeFloatingPanel: originalResizeFloatingPanel,
  });
}

function runResize(edge: ResizeEdge, dx: number, dy: number) {
  beginResize(
    'timeline',
    edge,
    0,
    0,
    START_BOUNDS.x,
    START_BOUNDS.y,
    START_BOUNDS.width,
    START_BOUNDS.height,
  );
  updateResize(dx, dy);
  endResize();
}

describe('ResizeManager', () => {
  beforeEach(() => {
    cancelResize();
    registerWorkAreaRect({ left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity, width: Infinity, height: Infinity });
    setTimelineBounds(START_BOUNDS);
  });

  it.each<ResizeCase>([
    {
      edge: 'e',
      dx: -1000,
      dy: 0,
      expected: { x: 100, y: 80, width: MIN_PANEL_WIDTH, height: 200 },
    },
    {
      edge: 'w',
      dx: 1000,
      dy: 0,
      expected: { x: 140, y: 80, width: MIN_PANEL_WIDTH, height: 200 },
    },
    {
      edge: 's',
      dx: 0,
      dy: -1000,
      expected: { x: 100, y: 80, width: 320, height: MIN_PANEL_HEIGHT },
    },
    {
      edge: 'n',
      dx: 0,
      dy: 1000,
      expected: { x: 100, y: 160, width: 320, height: MIN_PANEL_HEIGHT },
    },
    {
      edge: 'ne',
      dx: -1000,
      dy: 1000,
      expected: { x: 100, y: 160, width: MIN_PANEL_WIDTH, height: MIN_PANEL_HEIGHT },
    },
    {
      edge: 'nw',
      dx: 1000,
      dy: 1000,
      expected: { x: 140, y: 160, width: MIN_PANEL_WIDTH, height: MIN_PANEL_HEIGHT },
    },
    {
      edge: 'se',
      dx: -1000,
      dy: -1000,
      expected: { x: 100, y: 80, width: MIN_PANEL_WIDTH, height: MIN_PANEL_HEIGHT },
    },
    {
      edge: 'sw',
      dx: 1000,
      dy: -1000,
      expected: { x: 140, y: 80, width: MIN_PANEL_WIDTH, height: MIN_PANEL_HEIGHT },
    },
  ])('clamps the $edge resize handle correctly', ({ edge, dx, dy, expected }) => {
    const calls: ResizeCase['expected'][] = [];

    usePanelRegistry.setState({
      resizeFloatingPanel: (id, x, y, width, height) => {
        calls.push({ x, y, width, height });
        originalResizeFloatingPanel(id, x, y, width, height);
      },
    });

    runResize(edge, dx, dy);

    expect(calls).toEqual([expected]);
    expect(usePanelRegistry.getState().panels.timeline.floating).toEqual(expected);
  });

  it('moves west and north edges by the clamped width and height delta', () => {
    runResize('nw', 1000, 1000);

    expect(usePanelRegistry.getState().panels.timeline.floating).toEqual({
      x: START_BOUNDS.x + (START_BOUNDS.width - MIN_PANEL_WIDTH),
      y: START_BOUNDS.y + (START_BOUNDS.height - MIN_PANEL_HEIGHT),
      width: MIN_PANEL_WIDTH,
      height: MIN_PANEL_HEIGHT,
    });
  });

  it('commits resize to the registry only once on endResize', () => {
    let calls = 0;

    usePanelRegistry.setState({
      resizeFloatingPanel: (id, x, y, width, height) => {
        calls += 1;
        originalResizeFloatingPanel(id, x, y, width, height);
      },
    });

    beginResize('timeline', 'se', 0, 0, 100, 80, 320, 200);
    updateResize(10, 20);
    updateResize(30, 40);

    expect(calls).toBe(0);

    endResize();
    expect(calls).toBe(1);
    expect(usePanelRegistry.getState().panels.timeline.floating).toEqual({
      x: 100,
      y: 80,
      width: 350,
      height: 240,
    });
  });
});
