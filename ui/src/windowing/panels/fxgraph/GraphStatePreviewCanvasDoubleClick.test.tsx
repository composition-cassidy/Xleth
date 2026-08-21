/**
 * @vitest-environment jsdom
 *
 * Double-click on empty canvas frames the whole graph — the replacement for
 * the toolbar's old "Fit View" button (removed along with the rest of the
 * toolbar row). Uses a real DOM mount, not renderToStaticMarkup, because
 * handleFitView reads viewportRef.current.getBoundingClientRect(), which only
 * resolves once the component is actually mounted. The geometry itself
 * (centering, zoom-to-fit) is unit-tested directly against fitGraphViewport in
 * GraphStatePreview.test.tsx ("Fit View frames negative-coordinate graphs
 * correctly") — this file only proves the double-click is wired to it.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GraphStatePreview, { type GraphStateDocument } from './GraphStatePreview';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function graphState(): GraphStateDocument {
  return {
    schemaVersion: 1,
    trackId: '7',
    nodes: [
      { id: 'input', type: 'trackInput', position: { x: 0, y: 0 }, data: {} },
      { id: 'output', type: 'trackOutput', position: { x: 260, y: 0 }, data: {} },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

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

async function mountPreview(props: Record<string, unknown>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoot = root;
  activeContainer = container;
  await act(async () => {
    root.render(<GraphStatePreview graphState={graphState()} {...props} />);
  });
  return container;
}

async function doubleClick(target: Element, at = { clientX: 300, clientY: 200 }) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, ...at }));
  });
}

describe('FX Graph canvas double-click to fit view', () => {
  it('double-clicking empty canvas calls onViewportChange', async () => {
    const onViewportChange = vi.fn();
    const container = await mountPreview({ onViewportChange });
    const viewport = container.querySelector('.xleth-graph-state-preview__viewport')!;

    await doubleClick(viewport);

    expect(onViewportChange).toHaveBeenCalledTimes(1);
    const [next] = onViewportChange.mock.calls[0];
    expect(Number.isFinite(next.x)).toBe(true);
    expect(Number.isFinite(next.y)).toBe(true);
    expect(Number.isFinite(next.zoom)).toBe(true);
  });

  it('does not fire when double-clicking a node — the node owns its own double-click', async () => {
    const onViewportChange = vi.fn();
    const container = await mountPreview({ onViewportChange });
    const node = container.querySelector('[data-node-id="input"]')!;

    await doubleClick(node, { clientX: 40, clientY: 40 });

    expect(onViewportChange).not.toHaveBeenCalled();
  });

  it('does nothing when onViewportChange is not wired (read-only preview)', async () => {
    const container = await mountPreview({});
    const viewport = container.querySelector('.xleth-graph-state-preview__viewport')!;

    await expect(doubleClick(viewport)).resolves.not.toThrow();
  });
});
