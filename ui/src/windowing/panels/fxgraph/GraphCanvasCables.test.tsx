/**
 * @vitest-environment jsdom
 *
 * FX Graph canvas, round 2 step 18.1: the grid follows the view, a cable's buttons show only
 * for the cable under the pointer or the selected one, the legend lists the signal types in
 * use, and the minimap's mapping puts the view where it was clicked.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GraphStatePreview, { type GraphStateDocument } from './GraphStatePreview';
import SignalLegend from './SignalLegend';
import { minimapMapping, viewportForMinimapPoint } from './GraphMinimap';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const graph: GraphStateDocument = {
  schemaVersion: 1,
  trackId: '7',
  nodes: [
    { id: 'input', type: 'trackInput', position: { x: 0, y: 0 }, data: {} },
    { id: 'output', type: 'trackOutput', position: { x: 300, y: 0 }, data: {} },
  ],
  edges: [
    {
      id: 'e1', type: 'audio', sourceNodeId: 'input', sourcePort: 'audio', targetNodeId: 'output', targetPort: 'audio',
    },
  ],
  viewport: { x: 10, y: 20, zoom: 2 },
};

let activeRoot: Root | null = null;
let activeContainer: HTMLDivElement | null = null;

afterEach(async () => {
  if (activeRoot) {
    const root = activeRoot;
    await act(async () => { root.unmount(); });
  }
  activeContainer?.remove();
  activeRoot = null;
  activeContainer = null;
});

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoot = root;
  activeContainer = container;
  await act(async () => {
    root.render(
      <GraphStatePreview
        graphState={graph}
        notice={null}
        onViewportChange={vi.fn()}
        onDisconnectEdge={vi.fn()}
      />,
    );
  });
  return container;
}

describe('FX Graph canvas grid', () => {
  it('carries the view as custom properties, one minor cell scaled by zoom', async () => {
    const container = await mount();
    const viewport = container.querySelector<HTMLElement>('.xleth-graph-state-preview__viewport')!;
    expect(viewport.style.getPropertyValue('--grid-x')).toBe('10px');
    expect(viewport.style.getPropertyValue('--grid-y')).toBe('20px');
    expect(viewport.style.getPropertyValue('--grid-step')).toBe('48px');
    expect(viewport.getAttribute('data-grid-minor')).toBeNull();
  });
});

describe('FX Graph cable buttons', () => {
  it('are inactive at rest, active for the hovered cable, and for a picked cable until the canvas is clicked', async () => {
    const container = await mount();
    const button = () => container.querySelector<HTMLButtonElement>('button[data-edge-id="e1"]')!;
    const hit = container.querySelector<SVGPathElement>('[data-edge-hit-for="e1"]')!;

    expect(button().getAttribute('data-active')).toBeNull();

    await act(async () => { hit.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })); });
    expect(button().getAttribute('data-active')).toBe('true');

    await act(async () => { hit.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); });
    expect(container.querySelector('path[data-selected="true"]')?.getAttribute('data-edge-id')).toBe('e1');

    const viewport = container.querySelector('.xleth-graph-state-preview__viewport')!;
    await act(async () => { viewport.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); });
    expect(container.querySelector('path[data-selected="true"]')).toBeNull();
  });

  it('keep their disconnect call', async () => {
    const onDisconnectEdge = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    activeRoot = root;
    activeContainer = container;
    await act(async () => {
      root.render(<GraphStatePreview graphState={graph} notice={null} onDisconnectEdge={onDisconnectEdge} />);
    });
    const button = container.querySelector<HTMLButtonElement>('button[data-edge-id="e1"]')!;
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onDisconnectEdge).toHaveBeenCalledWith('e1');
  });
});

describe('FX Graph signal legend', () => {
  it('lists the three cable types the graph carries', () => {
    const html = renderToStaticMarkup(<SignalLegend />);
    expect(html).toContain('Audio');
    expect(html).toContain('Parameter');
    expect(html).toContain('Sidechain key');
    expect(html).not.toContain('Video');
  });
});

describe('FX Graph minimap mapping', () => {
  const nodes = [
    { id: 'a', x: 0, y: 0, width: 100, height: 50 },
    { id: 'b', x: 1000, y: 600, width: 100, height: 50 },
  ];
  const viewport = { x: 0, y: 0, zoom: 1 };
  const viewSize = { width: 400, height: 300 };

  it('fits every node and the visible window inside the frame', () => {
    const m = minimapMapping(nodes, viewport, viewSize);
    const right = m.left + (1100 - m.minX) * m.scale;
    const bottom = m.top + (650 - m.minY) * m.scale;
    expect(right).toBeLessThanOrEqual(176 + 0.001);
    expect(bottom).toBeLessThanOrEqual(112 + 0.001);
    expect(m.left + (0 - m.minX) * m.scale).toBeGreaterThanOrEqual(0);
  });

  it('centres the window on the clicked point, keeping zoom', () => {
    const m = minimapMapping(nodes, viewport, viewSize);
    const point = { x: m.left + (1050 - m.minX) * m.scale, y: m.top + (625 - m.minY) * m.scale };
    const next = viewportForMinimapPoint(m, point, { zoom: 1 }, viewSize);
    // World point (1050, 625) sits at the middle of the 400x300 window.
    expect(next.x).toBe(Math.round(200 - 1050));
    expect(next.y).toBe(Math.round(150 - 625));
    expect(next.zoom).toBe(1);
  });
});
