/**
 * @vitest-environment jsdom
 *
 * FX Graph nodes, round 2 step 18.2: every node is a title bar (glyph, name, activator) over a
 * labelled port row; every port sits on one row so a cable lands on its mark whatever the node's
 * height; the effect shows its device's own name; a picked node is the selection.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GraphStatePreview, {
  buildGraphStatePreviewModel,
  type GraphStateDocument,
} from './GraphStatePreview';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function doc(nodes: GraphStateDocument['nodes'], edges: GraphStateDocument['edges'] = []): GraphStateDocument {
  return {
    schemaVersion: 1,
    trackId: '7',
    nodes: [
      { id: 'input', type: 'trackInput', position: { x: 0, y: 0 }, data: {} },
      { id: 'output', type: 'trackOutput', position: { x: 700, y: 0 }, data: {} },
      ...nodes,
    ],
    edges,
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

const effect = (pluginId: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  id: 'fx',
  type: 'effect',
  position: { x: 300, y: 0 },
  data: { effectInstanceId: 'fx-1', pluginId, displayName, bypass: false, ...extra },
});

describe('FX Graph node model', () => {
  it('makes the terminals a title bar and a port row tall', () => {
    const model = buildGraphStatePreviewModel(doc([]));
    expect(model.nodes.find((n) => n.id === 'input')!.height).toBe(48);
    expect(model.nodes.find((n) => n.id === 'output')!.height).toBe(48);
  });

  it('starts and ends every cable on the port row, 37px below the node top, whatever the height', () => {
    const graph = doc(
      [
        { id: 'macro', type: 'macro', position: { x: 300, y: 100 }, data: { label: 'Macro 1', normalizedValue: 0.5 } },
        {
          id: 'fx',
          type: 'effect',
          position: { x: 500, y: 100 },
          data: {
            effectInstanceId: 'fx-1',
            pluginId: 'compressor',
            displayName: 'Compressor',
            bypass: false,
            exposedParameterPorts: [
              { parameterId: 'a', nameSnapshot: 'A' },
              { parameterId: 'b', nameSnapshot: 'B' },
              { parameterId: 'c', nameSnapshot: 'C' },
            ],
          },
        },
      ],
      [{
        id: 'e1', type: 'audio', sourceNodeId: 'input', sourcePort: 'audio', targetNodeId: 'fx', targetPort: 'audioIn',
      }],
    );
    const model = buildGraphStatePreviewModel(graph);
    const input = model.nodes.find((n) => n.id === 'input')!;
    const fx = model.nodes.find((n) => n.id === 'fx')!;
    expect(fx.height).toBeGreaterThan(120);
    const edge = model.edges.find((e) => e.id === 'e1')!;
    expect(edge.sourceY).toBe(input.y + 37);
    expect(edge.targetY).toBe(fx.y + 37);
  });
});

describe('FX Graph node markup', () => {
  it('shows the device name from the one device map, and the node kind for the others', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview graphState={doc([effect('xletheq', 'Xleth EQ')])} />,
    );
    expect(html).toContain('Parametric EQ');
    expect(html).not.toContain('>Xleth EQ<');
  });

  it('draws a glyph from the Xleth family in every title bar, and labels the ports', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={doc([
          effect('compressor', 'Compressor'),
          { id: 'm', type: 'macro', position: { x: 300, y: 200 }, data: { label: 'Macro 1', normalizedValue: 0.5 } },
          { id: 'l', type: 'lfo', position: { x: 500, y: 200 }, data: { label: 'LFO' } },
          { id: 'ev', type: 'envelope', position: { x: 700, y: 200 }, data: { label: 'Envelope' } },
          { id: 's', type: 'sidechainInput', position: { x: 100, y: 200 }, data: { label: 'Sidechain Input', sourceTrackId: null } },
        ])}
      />,
    );
    for (const glyph of ['nodeInput', 'nodeOutput', 'nodeEffect', 'nodeMacro', 'nodeLfo', 'nodeEnvelope', 'nodeSidechain']) {
      expect(html, glyph).toContain(`data-node-glyph="${glyph}"`);
    }
    for (const label of ['Audio in', 'Audio out', 'Parameter out', 'Key out']) {
      expect(html, label).toContain(label);
    }
  });

  it('gives each port its signal and a shape: audio a disc, parameter a diamond, key a ring', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={doc([
          { id: 'm', type: 'macro', position: { x: 300, y: 200 }, data: { label: 'Macro 1', normalizedValue: 0.5 } },
          effect('compressor', 'Compressor'),
        ])}
        onConnectNodes={vi.fn()}
      />,
    );
    expect(html).toContain('data-signal="audio"');
    expect(html).toContain('data-signal="parameter"');
  });

  it('marks a bypassed effect three ways: activator off, Off after the name, body dimmed', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview graphState={doc([effect('compressor', 'Compressor', { bypass: true })])} onSetNodeBypass={() => {}} />,
    );
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('>Off<');
    expect(html).toContain('data-bypassed="true"');
  });
});

describe('FX Graph node selection', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  afterEach(async () => {
    if (root) { const r = root; await act(async () => { r.unmount(); }); }
    container?.remove();
    root = null;
    container = null;
  });

  it('outlines the picked node, and clears it on a click in the canvas', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <GraphStatePreview
          graphState={doc([effect('compressor', 'Compressor')])}
          notice={null}
          onViewportChange={vi.fn()}
          onNodePositionChange={vi.fn()}
        />,
      );
    });
    const node = container.querySelector<HTMLElement>('[data-node-id="fx"]')!;
    expect(node.getAttribute('data-selected')).toBeNull();
    await act(async () => { node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); });
    expect(container.querySelector('[data-node-id="fx"]')!.getAttribute('data-selected')).toBe('true');
    const viewport = container.querySelector('.xleth-graph-state-preview__viewport')!;
    await act(async () => { viewport.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); });
    expect(container.querySelector('[data-node-id="fx"]')!.getAttribute('data-selected')).toBeNull();
  });
});
