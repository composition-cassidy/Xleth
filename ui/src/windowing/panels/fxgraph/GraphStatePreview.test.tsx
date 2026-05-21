import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import GraphStatePreview, {
  buildGraphStatePreviewModel,
  type GraphStateDocument,
  type GraphStateEdge,
  type GraphStateNode,
} from './GraphStatePreview';

function inputNode(position = { x: 0, y: 0 }): GraphStateNode {
  return { id: 'input', type: 'trackInput', position, data: {} };
}

function outputNode(position = { x: 260, y: 0 }): GraphStateNode {
  return { id: 'output', type: 'trackOutput', position, data: {} };
}

function effectNode(
  id: string,
  displayName: string,
  sourceChainSlotIndex: number,
  position = { x: 260, y: 0 },
  data: Record<string, unknown> = {},
): GraphStateNode {
  return {
    id,
    type: 'effect',
    position,
    data: {
      effectInstanceId: `${id}-instance`,
      pluginId: `${id}.plugin`,
      displayName,
      bypass: false,
      missing: false,
      crashed: false,
      sourceChainSlotIndex,
      ...data,
    },
  };
}

function audioEdge(id: string, sourceNodeId: string, targetNodeId: string): GraphStateEdge {
  return {
    id,
    sourceNodeId,
    sourcePort: sourceNodeId === 'input' ? 'audio' : 'audioOut',
    targetNodeId,
    targetPort: targetNodeId === 'output' ? 'audio' : 'audioIn',
    type: 'audio',
  };
}

function graphState(
  nodes: GraphStateNode[],
  edges: GraphStateEdge[],
): GraphStateDocument {
  return {
    schemaVersion: 1,
    trackId: '7',
    nodes,
    edges,
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function countAttribute(html: string, attribute: string) {
  return (html.match(new RegExp(attribute, 'g')) ?? []).length;
}

describe('GraphStatePreview', () => {
  it('renders valid Track Input to Track Output graphState with one static audio cable', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          outputNode(),
        ], [
          audioEdge('input-output', 'input', 'output'),
        ])}
      />,
    );

    expect(html).toContain('Read-only persisted FX graph preview');
    expect(html).toContain('Track Input');
    expect(html).toContain('Track Output');
    expect(countAttribute(html, 'data-edge-type="audio"')).toBe(1);
    expect(html).toContain('data-read-only="true"');
    expect(html).not.toContain('data-editable');
  });

  it('renders three effects in graphState order when saved positions are present', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode({ x: 40, y: 20 }),
          effectNode('eq', 'Xleth EQ', 0, { x: 300, y: 20 }),
          effectNode('delay', 'Delay', 1, { x: 560, y: 20 }),
          effectNode('reverb', 'Reverb', 2, { x: 820, y: 20 }),
          outputNode({ x: 1080, y: 20 }),
        ], [
          audioEdge('edge-1', 'input', 'eq'),
          audioEdge('edge-2', 'eq', 'delay'),
          audioEdge('edge-3', 'delay', 'reverb'),
          audioEdge('edge-4', 'reverb', 'output'),
        ])}
      />,
    );

    expect(html.indexOf('Track Input')).toBeLessThan(html.indexOf('Xleth EQ'));
    expect(html.indexOf('Xleth EQ')).toBeLessThan(html.indexOf('Delay'));
    expect(html.indexOf('Delay')).toBeLessThan(html.indexOf('Reverb'));
    expect(html.indexOf('Reverb')).toBeLessThan(html.indexOf('Track Output'));
    expect(countAttribute(html, 'data-edge-type="audio"')).toBe(4);
  });

  it('preserves saved node spacing in the preview model', () => {
    const model = buildGraphStatePreviewModel(graphState([
      inputNode({ x: 100, y: 20 }),
      effectNode('compressor', 'Compressor', 0, { x: 360, y: 20 }),
      outputNode({ x: 760, y: 20 }),
    ], [
      audioEdge('edge-1', 'input', 'compressor'),
      audioEdge('edge-2', 'compressor', 'output'),
    ]));

    const input = model.nodes.find((node) => node.id === 'input');
    const compressor = model.nodes.find((node) => node.id === 'compressor');
    const output = model.nodes.find((node) => node.id === 'output');

    expect(input).toBeDefined();
    expect(compressor).toBeDefined();
    expect(output).toBeDefined();
    expect((compressor?.x ?? 0) - (input?.x ?? 0)).toBe(260);
    expect((output?.x ?? 0) - (compressor?.x ?? 0)).toBe(400);
  });

  it('renders a bypass indicator for bypassed effects', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectNode('delay', 'Delay', 0, { x: 260, y: 0 }, { bypass: true }),
          outputNode({ x: 520, y: 0 }),
        ], [])}
      />,
    );

    expect(html).toContain('Delay');
    expect(html).toContain('Bypassed');
  });

  it('renders a missing indicator for missing effects', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectNode('missing', 'Missing Verb', 0, { x: 260, y: 0 }, { missing: true }),
          outputNode({ x: 520, y: 0 }),
        ], [])}
      />,
    );

    expect(html).toContain('Missing Verb');
    expect(html).toContain('Missing');
  });

  it('renders a crashed indicator for crashed effects', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectNode('crashed', 'Crashy Delay', 0, { x: 260, y: 0 }, { crashed: true }),
          outputNode({ x: 520, y: 0 }),
        ], [])}
      />,
    );

    expect(html).toContain('Crashy Delay');
    expect(html).toContain('Crashed');
  });

  it('renders unknown nodes with an unsupported indicator without crashing', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          {
            id: 'mystery',
            type: 'unknown',
            position: { x: 260, y: 0 },
            data: { _preservedType: 'sidechainMagic', _preservedData: {} },
          },
          outputNode({ x: 520, y: 0 }),
        ], [])}
      />,
    );

    expect(html).toContain('Unknown Node');
    expect(html).toContain('Unsupported node type: sidechainMagic');
    expect(html).toContain('Unknown');
  });

  it('renders unknown edges as unsupported cables, not active editable audio cables', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          outputNode(),
        ], [
          {
            ...audioEdge('future-edge', 'input', 'output'),
            type: 'unknown',
            _preservedType: 'cv',
          },
        ])}
      />,
    );

    expect(countAttribute(html, 'data-edge-type="unknown"')).toBe(1);
    expect(countAttribute(html, 'data-edge-type="audio"')).toBe(0);
    expect(html).toContain('Unsupported edge: cv');
    expect(html).not.toContain('data-editable');
  });

  it('renders an empty graphState placeholder without mutating the source document', () => {
    const emptyGraphState = graphState([], []);
    const before = JSON.stringify(emptyGraphState);
    const html = renderToStaticMarkup(<GraphStatePreview graphState={emptyGraphState} />);

    expect(html).toContain('Empty FX Graph');
    expect(html).toContain('Track Input');
    expect(html).toContain('Track Output');
    expect(countAttribute(html, 'data-edge-type=')).toBe(0);
    expect(JSON.stringify(emptyGraphState)).toBe(before);
  });

  it('falls back to a stable horizontal layout when positions are missing or invalid', () => {
    const model = buildGraphStatePreviewModel(graphState([
      { ...inputNode(), position: { x: 'bad', y: 0 } },
      { ...effectNode('compressor', 'Compressor', 0), position: undefined },
      { ...outputNode(), position: { x: Number.NaN, y: 3 } },
    ], []));

    expect(model.nodes.map((node) => node.label)).toEqual([
      'Track Input',
      'Compressor',
      'Track Output',
    ]);
    expect(model.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    expect(model.nodes[0].x).toBeLessThan(model.nodes[1].x);
    expect(model.nodes[1].x).toBeLessThan(model.nodes[2].x);
  });

  it('ignores edges with missing node references and logs a warning', () => {
    const warn = vi.fn();
    const model = buildGraphStatePreviewModel(graphState([
      inputNode(),
      outputNode(),
    ], [
      audioEdge('dangling', 'input', 'missing'),
    ]), { warn });

    expect(model.edges).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('graphState preview skipped edge'),
      expect.objectContaining({ edgeId: 'dangling' }),
    );
  });
});
