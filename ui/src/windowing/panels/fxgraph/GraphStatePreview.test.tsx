import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import GraphStatePreview, {
  GraphParameterContextMenu,
  GraphStatePreviewNode,
  buildGraphStatePreviewModel,
  filterExposeParameterDescriptors,
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

function countText(html: string, text: string) {
  return html.split(text).length - 1;
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
    expect(countText(html, 'Persisted graphState. Linear routing is enabled for supported paths.')).toBe(1);
    expect(html).not.toContain('data-editable');
  });

  it('renders Track Input, three effects, and Track Output in graphState order when saved positions are present', () => {
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
    expect(countAttribute(html, 'data-node-type="trackOutput"')).toBe(1);
    expect(html).toContain('data-preview-scroll-stage="true"');
  });

  it('renders saved node spacing in workspace coordinates without mutating graphState', () => {
    const sourceGraphState = graphState([
      inputNode({ x: 100, y: 20 }),
      effectNode('compressor', 'Compressor', 0, { x: 360, y: 20 }),
      outputNode({ x: 760, y: 20 }),
    ], [
      audioEdge('edge-1', 'input', 'compressor'),
      audioEdge('edge-2', 'compressor', 'output'),
    ]);
    const before = JSON.stringify(sourceGraphState);
    const model = buildGraphStatePreviewModel(sourceGraphState);

    const input = model.nodes.find((node) => node.id === 'input');
    const compressor = model.nodes.find((node) => node.id === 'compressor');
    const output = model.nodes.find((node) => node.id === 'output');

    expect(input).toBeDefined();
    expect(compressor).toBeDefined();
    expect(output).toBeDefined();
    expect((compressor?.x ?? 0) - (input?.x ?? 0)).toBeCloseTo(260);
    expect((output?.x ?? 0) - (compressor?.x ?? 0)).toBeCloseTo(400);
    expect(JSON.stringify(sourceGraphState)).toBe(before);
  });

  it('applies transient node position overrides without mutating graphState', () => {
    const sourceGraphState = graphState([
      inputNode({ x: 0, y: 0 }),
      effectNode('limiter', 'Limiter', 0, { x: 260, y: 0 }),
      outputNode({ x: 520, y: 0 }),
    ], [
      audioEdge('edge-1', 'input', 'limiter'),
      audioEdge('edge-2', 'limiter', 'output'),
    ]);
    const before = JSON.stringify(sourceGraphState);

    const normal = buildGraphStatePreviewModel(sourceGraphState);
    const preview = buildGraphStatePreviewModel(sourceGraphState, {
      nodePositionOverrides: { limiter: { x: 380, y: 120 } },
    });

    expect(JSON.stringify(sourceGraphState)).toBe(before);
    expect(preview.nodes.find((node) => node.id === 'limiter')?.graphX).toBe(380);
    expect(preview.nodes.find((node) => node.id === 'limiter')?.graphY).toBe(120);
    expect(preview.edges.find((edge) => edge.id === 'edge-1')?.path)
      .not.toBe(normal.edges.find((edge) => edge.id === 'edge-1')?.path);
    expect(preview.edges.find((edge) => edge.id === 'edge-2')?.path)
      .not.toBe(normal.edges.find((edge) => edge.id === 'edge-2')?.path);
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

  it('renders exposed parameter ports as compact effect-node input targets', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectNode('delay', 'Delay', 0, { x: 260, y: 0 }, {
            exposedParameterPorts: [
              {
                parameterId: 'feedback',
                parameterIndex: 3,
                nameSnapshot: 'Feedback',
                labelSnapshot: '%',
                parameterIdIsFallback: false,
                automatable: true,
                readOnly: false,
              },
            ],
          }),
          outputNode({ x: 520, y: 0 }),
        ], [])}
      />,
    );

    expect(html).toContain('xleth-graph-state-preview__parameter-port');
    expect(html).toContain('data-parameter-port-id="feedback"');
    expect(html).toContain('Feedback');
    expect(html).toContain('Delay parameter inputs');
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
    expect(html).toContain('data-preview-scroll-stage="true"');
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

  it('remains a non-interactive static preview without editing affordances', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectNode('limiter', 'Limiter', 0, { x: 260, y: 0 }),
          outputNode({ x: 520, y: 0 }),
        ], [
          audioEdge('edge-1', 'input', 'limiter'),
          audioEdge('edge-2', 'limiter', 'output'),
        ])}
      />,
    );

    expect(html).toContain('data-read-only="true"');
    expect(html).not.toContain('draggable');
    expect(html).not.toContain('contenteditable');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('data-editable');
    expect(html).not.toMatch(/on(Mouse|Click|ContextMenu|Key|Drag)/);
  });

  it('renders view controls only when viewport editing is enabled', () => {
    const editableHtml = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectNode('limiter', 'Limiter', 0, { x: 260, y: 0 }),
          outputNode({ x: 520, y: 0 }),
        ], [])}
        onViewportChange={vi.fn()}
      />,
    );
    const dormantHtml = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          outputNode(),
        ], [])}
      />,
    );

    expect(editableHtml).toContain('Fit View');
    expect(editableHtml).toContain('Reset View');
    expect(editableHtml).toContain('data-workspace-active="true"');
    expect(dormantHtml).not.toContain('Fit View');
    expect(dormantHtml).not.toContain('Reset View');
  });

  it('renders Undo and Redo controls only when graph history callbacks are provided', () => {
    const sourceGraphState = graphState([
      inputNode(),
      outputNode(),
    ], []);
    const historyHtml = renderToStaticMarkup(
      <GraphStatePreview
        graphState={sourceGraphState}
        canUndoGraphEdit={false}
        canRedoGraphEdit
        onUndoGraphEdit={vi.fn()}
        onRedoGraphEdit={vi.fn()}
      />,
    );
    const dormantHtml = renderToStaticMarkup(<GraphStatePreview graphState={sourceGraphState} />);

    expect(historyHtml).toContain('aria-label="Undo graph edit"');
    expect(historyHtml).toContain('aria-label="Redo graph edit"');
    expect(historyHtml).toContain('Undo');
    expect(historyHtml).toContain('Redo');
    expect(countText(historyHtml, 'disabled')).toBe(1);
    expect(dormantHtml).not.toContain('Undo graph edit');
    expect(dormantHtml).not.toContain('Redo graph edit');
  });

  // --- FXG.3-b Edit button ---

  it('renders an enabled Edit button on real effect nodes when onEditNode is provided', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectNode('limiter', 'Limiter', 0, { x: 260, y: 0 }),
          outputNode({ x: 520, y: 0 }),
        ], [])}
        onEditNode={vi.fn()}
      />,
    );

    expect(html).toContain('xleth-graph-state-preview__node-edit');
    expect(html).toContain('aria-label="Edit Limiter"');
    expect(html).toContain('data-active="true"');
    // The only buttons present are Edit buttons; a real effect node's is enabled.
    expect(html).not.toContain('disabled');
  });

  it('does not render an Edit button on Track Input or Track Output', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectNode('limiter', 'Limiter', 0, { x: 260, y: 0 }),
          outputNode({ x: 520, y: 0 }),
        ], [])}
        onEditNode={vi.fn()}
      />,
    );

    expect(html).not.toContain('Edit Track Input');
    expect(html).not.toContain('Edit Track Output');
  });

  it('disables the Edit button for placeholder/data-only effect nodes', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectNode('ph', 'Effect Node', 0, { x: 260, y: 0 }, { pluginId: 'placeholder' }),
          outputNode({ x: 520, y: 0 }),
        ], [])}
        onEditNode={vi.fn()}
      />,
    );

    expect(html).toContain('xleth-graph-state-preview__node-edit');
    expect(html).toContain('disabled');
    expect(html).toContain('is not active yet');
  });

  it('disables the Edit button for missing effect nodes', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectNode('rv', 'Reverb', 0, { x: 260, y: 0 }, { missing: true }),
          outputNode({ x: 520, y: 0 }),
        ], [])}
        onEditNode={vi.fn()}
      />,
    );

    expect(html).toContain('xleth-graph-state-preview__node-edit');
    expect(html).toContain('disabled');
  });

  it('renders no Edit button in read-only mode (onEditNode omitted)', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectNode('limiter', 'Limiter', 0, { x: 260, y: 0 }),
          outputNode({ x: 520, y: 0 }),
        ], [])}
      />,
    );

    expect(html).not.toContain('xleth-graph-state-preview__node-edit');
  });

  // --- FXG.4-b parameter port exposure menu ---

  it('wires right-click context opening for effect nodes only', () => {
    const model = buildGraphStatePreviewModel(graphState([
      inputNode(),
      effectNode('limiter', 'Limiter', 0, { x: 260, y: 0 }),
      outputNode({ x: 520, y: 0 }),
    ], []));
    const effect = model.nodes.find((node) => node.id === 'limiter');
    const input = model.nodes.find((node) => node.id === 'input');
    const onNodeContextMenu = vi.fn();
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as React.MouseEvent<HTMLDivElement>;

    const effectElement = GraphStatePreviewNode({
      node: effect!,
      dragging: false,
      connectEnabled: false,
      connectActive: false,
      canRemove: true,
      canEdit: true,
      onNodeContextMenu,
    });
    effectElement.props.onContextMenu(event);
    expect(onNodeContextMenu).toHaveBeenCalledWith(event, effect);

    const inputElement = GraphStatePreviewNode({
      node: input!,
      dragging: false,
      connectEnabled: false,
      connectActive: false,
      canRemove: true,
      canEdit: true,
      onNodeContextMenu,
    });
    expect(inputElement.props.onContextMenu).toBeUndefined();
  });

  it('renders loading, error, empty, and searchable parameter exposure menu states', () => {
    const node = buildGraphStatePreviewModel(graphState([
      inputNode(),
      effectNode('delay', 'Delay', 0, { x: 260, y: 0 }, {
        exposedParameterPorts: [
          {
            parameterId: 'feedback',
            parameterIndex: 1,
            nameSnapshot: 'Feedback',
            labelSnapshot: null,
            parameterIdIsFallback: false,
            automatable: true,
            readOnly: false,
          },
        ],
      }),
      outputNode({ x: 520, y: 0 }),
    ], [])).nodes.find((candidate) => candidate.id === 'delay')!;

    const loadingHtml = renderToStaticMarkup(
      <GraphParameterContextMenu
        node={node}
        x={12}
        y={24}
        loading
        canEdit
        canRemove
      />,
    );
    const errorHtml = renderToStaticMarkup(
      <GraphParameterContextMenu
        node={node}
        x={12}
        y={24}
        result={{ ok: false, reason: 'plugin_missing' }}
        canEdit
        canRemove
      />,
    );
    const emptyHtml = renderToStaticMarkup(
      <GraphParameterContextMenu
        node={node}
        x={12}
        y={24}
        result={{ ok: true, parameters: [] }}
        canEdit
        canRemove
      />,
    );
    const listHtml = renderToStaticMarkup(
      <GraphParameterContextMenu
        node={node}
        x={12}
        y={24}
        search="feed"
        result={{
          ok: true,
          parameters: [
            { parameterId: 'feedback', parameterIndex: 1, name: 'Feedback', automatable: true, readOnly: false },
            { parameterId: 'mix', parameterIndex: 2, name: 'Mix', automatable: true, readOnly: false },
            { parameterId: 'meter', parameterIndex: 3, name: 'Meter', automatable: false, readOnly: true },
          ],
        }}
        canEdit
        canRemove
      />,
    );

    expect(loadingHtml).toContain('Loading parameters...');
    expect(errorHtml).toContain('This plugin is unavailable. Parameters cannot be read.');
    expect(emptyHtml).toContain('This effect exposes no parameters.');
    expect(listHtml).toContain('Expose Parameter');
    expect(listHtml).toContain('Search parameters');
    expect(listHtml).toContain('Feedback');
    expect(listHtml).not.toContain('Mix');
    expect(listHtml).toContain('aria-checked="true"');
    expect(filterExposeParameterDescriptors([
      { parameterId: 'feedback', parameterIndex: 1, name: 'Feedback' },
      { parameterId: 'mix', parameterIndex: 2, name: 'Mix' },
    ], 'mix')).toEqual([
      { parameterId: 'mix', parameterIndex: 2, name: 'Mix' },
    ]);
  });

  it('marks read-only parameters disabled in the exposure menu', () => {
    const node = buildGraphStatePreviewModel(graphState([
      inputNode(),
      effectNode('meter', 'Meter', 0, { x: 260, y: 0 }),
      outputNode({ x: 520, y: 0 }),
    ], [])).nodes.find((candidate) => candidate.id === 'meter')!;
    const html = renderToStaticMarkup(
      <GraphParameterContextMenu
        node={node}
        x={12}
        y={24}
        result={{
          ok: true,
          parameters: [
            { parameterId: 'meter', parameterIndex: 3, name: 'Meter', automatable: false, readOnly: true },
          ],
        }}
        canEdit
        canRemove
      />,
    );

    expect(html).toContain('Meter');
    expect(html).toContain('Read-only');
    expect(html).toContain('disabled');
  });

  // --- FXG.3-l workspace polish guards ---

  it('never renders a Remove control on protected Track Input or Track Output nodes', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectNode('limiter', 'Limiter', 0, { x: 260, y: 0 }),
          outputNode({ x: 520, y: 0 }),
        ], [])}
        onRemoveNode={vi.fn()}
        onEditNode={vi.fn()}
      />,
    );

    // The effect node is removable...
    expect(html).toContain('aria-label="Remove Limiter"');
    // ...but the protected routing endpoints never expose a remove affordance.
    expect(html).not.toContain('aria-label="Remove Track Input"');
    expect(html).not.toContain('aria-label="Remove Track Output"');
  });

  it('keeps an accessible edge-delete button in the DOM when disconnect is enabled', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          outputNode(),
        ], [
          audioEdge('input-output', 'input', 'output'),
        ])}
        onDisconnectEdge={vi.fn()}
      />,
    );

    // Edge delete is hidden until hover/focus via CSS, but the control must stay
    // in the DOM and remain a labelled, keyboard-reachable button.
    expect(html).toContain('xleth-graph-state-preview__disconnect');
    expect(html).toContain('aria-label="Disconnect Audio cable: Track Input to Track Output"');
  });
});
