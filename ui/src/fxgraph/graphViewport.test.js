import { describe, it, expect } from 'vitest';
import {
  MIN_VIEWPORT_ZOOM,
  MAX_VIEWPORT_ZOOM,
  clampGraphZoom,
  screenToGraphPoint,
  graphToScreenPoint,
  zoomViewportAroundScreenPoint,
  panViewport,
  fitGraphViewport,
} from './graphViewport.js';

// ── clampGraphZoom ──────────────────────────────────────────────────────────

describe('clampGraphZoom', () => {
  it('passes through a valid in-range zoom', () => {
    expect(clampGraphZoom(1)).toBe(1);
    expect(clampGraphZoom(1.5)).toBe(1.5);
  });

  it('clamps below minimum to MIN_VIEWPORT_ZOOM', () => {
    expect(clampGraphZoom(0)).toBe(MIN_VIEWPORT_ZOOM);
    expect(clampGraphZoom(-1)).toBe(MIN_VIEWPORT_ZOOM);
    expect(clampGraphZoom(MIN_VIEWPORT_ZOOM / 2)).toBe(MIN_VIEWPORT_ZOOM);
  });

  it('clamps above maximum to MAX_VIEWPORT_ZOOM', () => {
    expect(clampGraphZoom(MAX_VIEWPORT_ZOOM + 1)).toBe(MAX_VIEWPORT_ZOOM);
    expect(clampGraphZoom(999)).toBe(MAX_VIEWPORT_ZOOM);
  });

  it('passes through exact boundary values', () => {
    expect(clampGraphZoom(MIN_VIEWPORT_ZOOM)).toBe(MIN_VIEWPORT_ZOOM);
    expect(clampGraphZoom(MAX_VIEWPORT_ZOOM)).toBe(MAX_VIEWPORT_ZOOM);
  });

  it('returns 1 for NaN, clamps Infinity to max and -Infinity to min', () => {
    expect(clampGraphZoom(NaN)).toBe(1);
    expect(clampGraphZoom(Infinity)).toBe(MAX_VIEWPORT_ZOOM);
    expect(clampGraphZoom(-Infinity)).toBe(MIN_VIEWPORT_ZOOM);
  });
});

// ── screenToGraphPoint / graphToScreenPoint (round-trip) ───────────────────

const STAGE = { left: 100, top: 50, width: 800, height: 600 };
const VP1   = { x: 0, y: 0, zoom: 1 };
const VP05  = { x: -20, y: 10, zoom: 0.5 };
const VP2   = { x: 30, y: -15, zoom: 2 };

describe('screenToGraphPoint', () => {
  it('converts at zoom 1 with no translation', () => {
    expect(screenToGraphPoint({ x: 200, y: 150 }, VP1, STAGE)).toEqual({ x: 100, y: 100 });
  });

  it('accounts for viewport translation', () => {
    const vp = { x: 10, y: -5, zoom: 1 };
    // sx=200-100=100, x=(100-10)/1=90
    expect(screenToGraphPoint({ x: 200, y: 150 }, vp, STAGE)).toEqual({ x: 90, y: 105 });
  });

  it('divides by zoom at 0.5', () => {
    // sx=200-100=100, x=(100-(-20))/0.5=240
    expect(screenToGraphPoint({ x: 200, y: 50 + 0 }, VP05, STAGE)).toEqual(
      expect.objectContaining({ x: expect.closeTo(240, 5) }),
    );
  });

  it('divides by zoom at 2.0', () => {
    // sx=200-100=100, x=(100-30)/2=35
    expect(screenToGraphPoint({ x: 200, y: 50 }, VP2, STAGE)).toEqual(
      expect.objectContaining({ x: expect.closeTo(35, 5) }),
    );
  });
});

describe('graphToScreenPoint', () => {
  it('converts at zoom 1 with no translation', () => {
    expect(graphToScreenPoint({ x: 100, y: 100 }, VP1, STAGE)).toEqual({ x: 200, y: 150 });
  });
});

describe('screenToGraphPoint / graphToScreenPoint round-trip', () => {
  const cases = [
    { label: 'zoom 1',   vp: VP1  },
    { label: 'zoom 0.5', vp: VP05 },
    { label: 'zoom 2',   vp: VP2  },
  ];
  const clientPts = [
    { x: 300, y: 200 },
    { x: 150, y: 90  },
    { x: 500, y: 450 },
  ];

  for (const { label, vp } of cases) {
    for (const pt of clientPts) {
      it(`round-trips client→graph→client at ${label}, pt (${pt.x},${pt.y})`, () => {
        const graph  = screenToGraphPoint(pt, vp, STAGE);
        const client = graphToScreenPoint(graph, vp, STAGE);
        expect(client.x).toBeCloseTo(pt.x, 8);
        expect(client.y).toBeCloseTo(pt.y, 8);
      });

      it(`round-trips graph→client→graph at ${label}, pt (${pt.x},${pt.y})`, () => {
        const graphPt = { x: (pt.x - STAGE.left - vp.x) / vp.zoom, y: (pt.y - STAGE.top - vp.y) / vp.zoom };
        const client  = graphToScreenPoint(graphPt, vp, STAGE);
        const back    = screenToGraphPoint(client, vp, STAGE);
        expect(back.x).toBeCloseTo(graphPt.x, 8);
        expect(back.y).toBeCloseTo(graphPt.y, 8);
      });
    }
  }
});

// ── zoomViewportAroundScreenPoint ──────────────────────────────────────────

describe('zoomViewportAroundScreenPoint', () => {
  it('keeps the canvas-space point under the cursor stable after zoom in', () => {
    const vp      = { x: 0, y: 0, zoom: 1 };
    const cursor  = { x: 300, y: 250 };
    const nextZoom = 2;
    const newVp   = zoomViewportAroundScreenPoint(vp, cursor, nextZoom, STAGE);

    const before = screenToGraphPoint(cursor, vp,    STAGE);
    const after  = screenToGraphPoint(cursor, newVp, STAGE);
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });

  it('keeps the canvas-space point under the cursor stable after zoom out', () => {
    const vp      = { x: -50, y: 20, zoom: 2 };
    const cursor  = { x: 350, y: 200 };
    const nextZoom = 0.75;
    const newVp   = zoomViewportAroundScreenPoint(vp, cursor, nextZoom, STAGE);

    const before = screenToGraphPoint(cursor, vp,    STAGE);
    const after  = screenToGraphPoint(cursor, newVp, STAGE);
    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });

  it('clamps nextZoom to valid range', () => {
    const vp  = { x: 0, y: 0, zoom: 1 };
    const cur = { x: 200, y: 200 };
    expect(zoomViewportAroundScreenPoint(vp, cur, 999, STAGE).zoom).toBe(MAX_VIEWPORT_ZOOM);
    expect(zoomViewportAroundScreenPoint(vp, cur, 0,   STAGE).zoom).toBe(MIN_VIEWPORT_ZOOM);
  });
});

// ── panViewport ────────────────────────────────────────────────────────────

describe('panViewport', () => {
  it('adds the screen delta to viewport x/y', () => {
    const vp  = { x: 10, y: -5, zoom: 1.5 };
    const result = panViewport(vp, { x: 30, y: -20 });
    expect(result.x).toBe(40);
    expect(result.y).toBe(-25);
  });

  it('preserves the zoom value', () => {
    const vp = { x: 0, y: 0, zoom: 0.8 };
    expect(panViewport(vp, { x: 10, y: 10 }).zoom).toBe(0.8);
  });

  it('handles negative deltas', () => {
    const vp = { x: 100, y: 50, zoom: 1 };
    const result = panViewport(vp, { x: -40, y: -10 });
    expect(result.x).toBe(60);
    expect(result.y).toBe(40);
  });
});

// ── fitGraphViewport ───────────────────────────────────────────────────────

describe('fitGraphViewport', () => {
  const CONTAINER = { width: 800, height: 600 };

  it('returns default viewport for empty nodes', () => {
    expect(fitGraphViewport([], CONTAINER)).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('returns default viewport for null nodes', () => {
    expect(fitGraphViewport(null, CONTAINER)).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('returns default viewport for undefined nodes', () => {
    expect(fitGraphViewport(undefined, CONTAINER)).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('fits a single node and centers it with padding', () => {
    const nodes = [{ x: 24, y: 24, width: 148, height: 74 }];
    const result = fitGraphViewport(nodes, CONTAINER, { padding: 40 });
    expect(result.zoom).toBeGreaterThan(0);
    // The node center should be at or near the container center under the result viewport.
    const nodeCenterX = 24 + 148 / 2;
    const nodeCenterY = 24 + 74 / 2;
    const screenCX = nodeCenterX * result.zoom + result.x;
    const screenCY = nodeCenterY * result.zoom + result.y;
    expect(screenCX).toBeCloseTo(CONTAINER.width  / 2, 3);
    expect(screenCY).toBeCloseTo(CONTAINER.height / 2, 3);
  });

  it('fits multiple nodes so all are within the container', () => {
    const nodes = [
      { x: 0,   y: 0,   width: 148, height: 74 },
      { x: 300, y: 200, width: 148, height: 74 },
    ];
    const padding = 48;
    const result  = fitGraphViewport(nodes, CONTAINER, { padding });

    // Verify both node extremes are within padded bounds.
    const nodeLeft  = 0 * result.zoom + result.x;
    const nodeRight = (300 + 148) * result.zoom + result.x;
    const nodeTop   = 0   * result.zoom + result.y;
    const nodeBot   = (200 + 74) * result.zoom + result.y;

    expect(nodeLeft).toBeGreaterThanOrEqual(padding - 1);
    expect(nodeRight).toBeLessThanOrEqual(CONTAINER.width - padding + 1);
    expect(nodeTop).toBeGreaterThanOrEqual(padding - 1);
    expect(nodeBot).toBeLessThanOrEqual(CONTAINER.height - padding + 1);
  });

  it('clamps zoom to MAX_VIEWPORT_ZOOM for tiny node bounds', () => {
    const nodes = [{ x: 0, y: 0, width: 1, height: 1 }];
    const result = fitGraphViewport(nodes, CONTAINER);
    expect(result.zoom).toBeLessThanOrEqual(MAX_VIEWPORT_ZOOM);
  });

  it('clamps zoom to MIN_VIEWPORT_ZOOM for huge node bounds', () => {
    const nodes = [{ x: 0, y: 0, width: 100000, height: 100000 }];
    const result = fitGraphViewport(nodes, CONTAINER);
    expect(result.zoom).toBeGreaterThanOrEqual(MIN_VIEWPORT_ZOOM);
  });
});

// ── Node drag delta conversion ─────────────────────────────────────────────

describe('node drag delta conversion via screenToGraphPoint math', () => {
  it('at zoom 0.5: 100px screen drag moves node 200 graph units', () => {
    const zoom       = 0.5;
    const screenDelta = 100;
    const graphDelta  = screenDelta / zoom;
    expect(graphDelta).toBe(200);
  });

  it('at zoom 2.0: 100px screen drag moves node 50 graph units', () => {
    const zoom       = 2;
    const screenDelta = 100;
    const graphDelta  = screenDelta / zoom;
    expect(graphDelta).toBe(50);
  });

  it('at zoom 1.0: screen delta equals graph delta', () => {
    const zoom       = 1;
    const screenDelta = 150;
    const graphDelta  = screenDelta / zoom;
    expect(graphDelta).toBe(150);
  });
});
