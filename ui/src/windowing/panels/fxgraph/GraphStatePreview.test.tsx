import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import GraphStatePreview, {
  GraphParameterContextMenu,
  GraphStatePreviewNode,
  ParameterEdgeMappingEditor,
  buildGraphStatePreviewModel,
  connectHighlightedParameterDropTarget,
  filterExposeParameterDescriptors,
  resolveParameterDropTargetFromElement,
  type GraphStateDocument,
  type GraphStateEdge,
  type GraphStateNode,
} from './GraphStatePreview';
import { buildExposeParameterMenuGroups } from './graphParameterUtils';
import { createDefaultBezierCurve, GRAPH_PARAMETER_CURVE_BEZIER, GRAPH_PARAMETER_CURVE_LINEAR } from '../../../fxgraph/graphState.js';

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

function macroNode(
  id = 'macro-a',
  label = 'Macro 1',
  normalizedValue = 0.42,
  position = { x: 260, y: 120 },
): GraphStateNode {
  return {
    id,
    type: 'macro',
    position,
    data: { label, normalizedValue },
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

function findElementByClass(element: React.ReactElement, className: string): React.ReactElement | null {
  const children = React.Children.toArray(element.props.children);
  for (const child of children) {
    if (!React.isValidElement(child)) continue;
    const childClass = String(child.props.className ?? '');
    if (childClass.includes(className)) return child;
    const nested = findElementByClass(child, className);
    if (nested) return nested;
  }
  return null;
}

function makeClosestElement(
  attributes: Record<string, string | null>,
  closestBySelector: Record<string, unknown> = {},
) {
  return {
    getAttribute: (name: string) => attributes[name] ?? null,
    closest: (selector: string) => closestBySelector[selector] ?? null,
  };
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

  it('renders exposed parameter ports in a distinct parameter lane beside the audio input', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectNode('delay', 'Delay', 0, { x: 260, y: 0 }, {
            exposedParameterPorts: [
              {
                parameterId: 'feedback',
                parameterIndexFallback: 3,
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

    expect(html).toContain('xleth-graph-state-preview__handle--in');
    expect(html).toContain('xleth-graph-state-preview__parameter-section');
    expect(html).toContain('Parameters');
    expect(html).toContain('xleth-graph-state-preview__parameter-port');
    // Stable compound port id: gpp:{graphNodeId}:{parameterId}
    expect(html).toContain('data-parameter-port-id="gpp:delay:feedback"');
    expect(html).toContain('data-parameter-port-type="parameter-input"');
    expect(html).toContain('Feedback');
    expect(html).toContain('Delay parameter inputs');
  });

  it('renders macro nodes with value controls and a distinct control output port', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          macroNode('macro-a', 'Energy', 0.37),
          outputNode({ x: 520, y: 0 }),
        ], [])}
        onUpdateMacroValue={vi.fn()}
        onRenameMacroNode={vi.fn()}
        onRemoveNode={vi.fn()}
      />,
    );

    expect(html).toContain('data-node-type="macro"');
    expect(html).toContain('xleth-graph-state-preview__node--macro');
    expect(html).toContain('Energy');
    expect(html).toContain('37%');
    expect(html).toContain('type="range"');
    expect(html).toContain('data-control-output="true"');
    expect(html).toContain('data-control-port-id="macro:macro-a:controlOut"');
    expect(html).toContain('data-control-port-type="macro-output"');
    expect(html).toContain('aria-label="Remove Energy"');
    expect(html).not.toContain('Edit Energy');
    expect(html).not.toContain('Energy parameter inputs');
    expect(html).not.toContain('data-connect-source="true"');
  });

  it('commits macro value and rename edits from the node controls', () => {
    const node = buildGraphStatePreviewModel(graphState([
      inputNode(),
      macroNode('macro-a', 'Macro 1', 0.25),
      outputNode({ x: 520, y: 0 }),
    ], [])).nodes.find((candidate) => candidate.id === 'macro-a')!;
    const onMacroValueCommit = vi.fn();
    const onMacroRenameCommit = vi.fn();
    const element = GraphStatePreviewNode({
      node,
      dragging: false,
      connectEnabled: true,
      connectActive: false,
      canRemove: true,
      canEdit: true,
      onMacroValueCommit,
      onMacroRenameCommit,
    });

    const slider = findElementByClass(element, 'xleth-graph-state-preview__macro-slider')!;
    slider.props.onPointerUp({ currentTarget: { value: '0.75' } });
    const label = findElementByClass(element, 'xleth-graph-state-preview__macro-label')!;
    label.props.onBlur({ currentTarget: { value: 'Drive' } });

    expect(onMacroValueCommit).toHaveBeenCalledWith('macro-a', 0.75);
    expect(onMacroRenameCommit).toHaveBeenCalledWith('macro-a', 'Drive');
    expect(element.props.onContextMenu).toBeUndefined();
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

  it('renders Add Macro only when its action is provided', () => {
    const sourceGraphState = graphState([
      inputNode(),
      outputNode(),
    ], []);
    const editableHtml = renderToStaticMarkup(
      <GraphStatePreview
        graphState={sourceGraphState}
        onAddEffectNode={vi.fn()}
        onAddMacroNode={vi.fn()}
      />,
    );
    const readOnlyHtml = renderToStaticMarkup(<GraphStatePreview graphState={sourceGraphState} />);

    expect(editableHtml).toContain('Add Effect Node');
    expect(editableHtml).toContain('Add Macro');
    expect(readOnlyHtml).not.toContain('Add Macro');
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

  it('curates the Xleth EQ exposure menu to three normal editable bands with friendly labels', () => {
    const node = buildGraphStatePreviewModel(graphState([
      inputNode(),
      effectNode('eq', 'Parametric EQ', 0, { x: 260, y: 0 }, { pluginId: 'xletheq' }),
      outputNode({ x: 520, y: 0 }),
    ], [])).nodes.find((candidate) => candidate.id === 'eq')!;
    const parameters = [
      { parameterId: 'b0_freq', parameterIndex: 0, name: 'B0 Freq', automatable: true, readOnly: false },
      { parameterId: 'b0_gain', parameterIndex: 1, name: 'B0 Gain', automatable: true, readOnly: false },
      { parameterId: 'b0_q', parameterIndex: 2, name: 'B0 Q', automatable: true, readOnly: false },
      { parameterId: 'b0_type', parameterIndex: 3, name: 'B0 Type', automatable: true, readOnly: false },
      { parameterId: 'b0_enabled', parameterIndex: 4, name: 'B0 Enabled', automatable: true, readOnly: false },
      { parameterId: 'b0_spec_sens', parameterIndex: 5, name: 'B0 Spec Sens', automatable: true, readOnly: false },
      { parameterId: 'b0_dyn_attack', parameterIndex: 6, name: 'B0 Dyn Attack', automatable: true, readOnly: false },
      { parameterId: 'b1_freq', parameterIndex: 7, name: 'B1 Freq', automatable: true, readOnly: false },
      { parameterId: 'b1_gain', parameterIndex: 8, name: 'B1 Gain', automatable: true, readOnly: false },
      { parameterId: 'b1_q', parameterIndex: 9, name: 'B1 Q', automatable: true, readOnly: false },
      { parameterId: 'b1_type', parameterIndex: 10, name: 'B1 Type', automatable: true, readOnly: false },
      { parameterId: 'b1_enabled', parameterIndex: 11, name: 'B1 Enabled', automatable: true, readOnly: false },
      { parameterId: 'b2_freq', parameterIndex: 12, name: 'B2 Freq', automatable: true, readOnly: false },
      { parameterId: 'b2_gain', parameterIndex: 13, name: 'B2 Gain', automatable: true, readOnly: false },
      { parameterId: 'b2_q', parameterIndex: 14, name: 'B2 Q', automatable: true, readOnly: false },
      { parameterId: 'b2_type', parameterIndex: 15, name: 'B2 Type', automatable: true, readOnly: false },
      { parameterId: 'b2_enabled', parameterIndex: 16, name: 'B2 Enabled', automatable: true, readOnly: false },
      { parameterId: 'b3_freq', parameterIndex: 17, name: 'B3 Freq', automatable: true, readOnly: false },
      { parameterId: 'linphase', parameterIndex: 18, name: 'Linear Phase', automatable: true, readOnly: false },
    ];
    const html = renderToStaticMarkup(
      <GraphParameterContextMenu
        node={node}
        x={12}
        y={24}
        result={{
          ok: true,
          effectKind: 'stock',
          pluginFormat: 'stock',
          pluginId: 'xletheq',
          parameters,
        }}
        canEdit
        canRemove
      />,
    );

    expect(html).toContain('Band 0');
    expect(html).toContain('Band 1');
    expect(html).toContain('Band 2');
    expect(html).toContain('Frequency');
    expect(html).toContain('Gain');
    expect(html).toContain('Q');
    expect(html).toContain('Type');
    expect(html).toContain('Enabled');
    expect(countText(html, 'role="menuitemcheckbox"')).toBe(15);
    expect(html).not.toContain('B0 Spec Sens');
    expect(html).not.toContain('B0 Dyn Attack');
    expect(html).not.toContain('B3 Freq');
    expect(html).not.toContain('Linear Phase');
  });

  it('keeps curated EQ menu items bound to their original parameter descriptors', () => {
    const b0Freq = {
      parameterId: 'b0_freq',
      parameterIndex: 42,
      parameterIdIsFallback: false,
      name: 'B0 Freq',
      unit: 'Hz',
      automatable: true,
      readOnly: false,
    };
    const groups = buildExposeParameterMenuGroups([
      b0Freq,
      { parameterId: 'b0_spec_sens', parameterIndex: 43, name: 'B0 Spec Sens' },
    ], {
      pluginId: 'xletheq',
      effectKind: 'stock',
      pluginFormat: 'stock',
      resultPluginId: 'xletheq',
    });

    expect(groups).toEqual([
      {
        groupLabel: 'Band 0',
        parameters: [{ parameter: b0Freq, label: 'Frequency' }],
      },
    ]);
    expect(groups[0].parameters[0].parameter).toBe(b0Freq);
  });

  it('does not apply the EQ whitelist to plugins or non-EQ stock effects', () => {
    const parameters = [
      { parameterId: 'b0_spec_sens', parameterIndex: 0, name: 'B0 Spec Sens' },
      { parameterId: 'vendor_attack', parameterIndex: 1, name: 'Vendor Attack' },
    ];

    expect(buildExposeParameterMenuGroups(parameters, {
      pluginId: 'xletheq',
      effectKind: 'plugin',
      pluginFormat: 'vst3',
      resultPluginId: 'xletheq',
    })[0].parameters.map((item) => item.parameter.parameterId)).toEqual([
      'b0_spec_sens',
      'vendor_attack',
    ]);
    expect(buildExposeParameterMenuGroups(parameters, {
      pluginId: 'delay',
      effectKind: 'stock',
      pluginFormat: 'stock',
      resultPluginId: 'delay',
    })[0].parameters.map((item) => item.parameter.parameterId)).toEqual([
      'b0_spec_sens',
      'vendor_attack',
    ]);
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

  // ── FXG.4-e/f Macro -> Parameter links ────────────────────────────────────

  function effectWithPort(id = 'delay', parameterId = 'feedback'): GraphStateNode {
    return effectNode(id, 'Delay', 0, { x: 260, y: 0 }, {
      exposedParameterPorts: [
        {
          parameterId,
          parameterIndexFallback: 0,
          nameSnapshot: 'Feedback',
          labelSnapshot: null,
          parameterIdIsFallback: false,
          automatable: true,
          readOnly: false,
        },
      ],
    });
  }

  function effectWithPorts(): GraphStateNode {
    return effectNode('eq', 'EQ', 0, { x: 260, y: 0 }, {
      exposedParameterPorts: [
        {
          parameterId: 'b0_q',
          parameterIndexFallback: 2,
          nameSnapshot: 'B0 Q',
          labelSnapshot: null,
          parameterIdIsFallback: false,
          automatable: true,
          readOnly: false,
        },
        {
          parameterId: 'b2_q',
          parameterIndexFallback: 14,
          nameSnapshot: 'B2 Q',
          labelSnapshot: null,
          parameterIdIsFallback: false,
          automatable: true,
          readOnly: false,
        },
      ],
    });
  }

  function parameterEdge(
    id: string,
    macroNodeId: string,
    targetNodeId: string,
    parameterId: string,
  ): GraphStateEdge {
    return {
      id,
      sourceNodeId: macroNodeId,
      sourcePort: 'controlOut',
      targetNodeId,
      targetPort: `gpp:${targetNodeId}:${parameterId}`,
      type: 'parameter',
      targetParameter: { parameterId },
    };
  }

  it('builds a parameter edge in the preview model with its own curved path', () => {
    const model = buildGraphStatePreviewModel(graphState([
      inputNode(),
      effectWithPort('delay', 'feedback'),
      macroNode('macro-a', 'Energy', 0.5, { x: 80, y: 220 }),
      outputNode({ x: 520, y: 0 }),
    ], [
      parameterEdge('p-1', 'macro-a', 'delay', 'feedback'),
    ]));

    const edge = model.edges.find((candidate) => candidate.id === 'p-1');
    expect(edge?.type).toBe('parameter');
    expect(edge?.path.startsWith('M ')).toBe(true);
    expect(edge?.label).toContain('feedback');
  });

  it('renders parameter edges visually distinct and exposes a parameter id on each port', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectWithPort('delay', 'feedback'),
          macroNode('macro-a', 'Energy', 0.5, { x: 80, y: 220 }),
          outputNode({ x: 520, y: 0 }),
        ], [
          parameterEdge('p-1', 'macro-a', 'delay', 'feedback'),
        ])}
        onDisconnectEdge={vi.fn()}
      />,
    );

    expect(html).toContain('data-edge-type="parameter"');
    expect(html).toContain('xleth-graph-state-preview__edge--parameter');
    expect(html).toContain('data-parameter-id="feedback"');
    // The parameter edge gets its own delete affordance.
    expect(html).toContain('xleth-graph-state-preview__disconnect--parameter');
  });

  it('makes the Macro controlOut a parameter-link drag source when linking is enabled', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectWithPort('delay', 'feedback'),
          macroNode('macro-a', 'Energy', 0.4, { x: 80, y: 220 }),
          outputNode({ x: 520, y: 0 }),
        ], [])}
        onConnectMacroToParameter={vi.fn()}
      />,
    );

    expect(html).toContain('data-connect-source="true"');
    expect(html).toContain('data-connect-source-kind="macro"');
    // The control-out identity is preserved on the interactive handle.
    expect(html).toContain('data-control-output="true"');
    expect(html).toContain('xleth-graph-state-preview__handle--connect-parameter-source');
  });

  it('leaves the Macro controlOut static when parameter linking is not enabled', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          macroNode('macro-a', 'Energy', 0.4, { x: 80, y: 220 }),
          outputNode({ x: 520, y: 0 }),
        ], [])}
      />,
    );

    expect(html).toContain('data-control-output="true"');
    expect(html).not.toContain('data-connect-source-kind="macro"');
    expect(html).not.toContain('xleth-graph-state-preview__handle--connect-parameter-source');
  });

  it('routes a Macro controlOut handle pointer-down through the connect handler', () => {
    const macro = buildGraphStatePreviewModel(graphState([
      macroNode('macro-a', 'Energy', 0.4),
    ], [])).nodes.find((candidate) => candidate.id === 'macro-a')!;
    const onConnectPointerDown = vi.fn();
    const element = GraphStatePreviewNode({
      node: macro,
      dragging: false,
      connectEnabled: false,
      connectParameterEnabled: true,
      connectActive: false,
      canRemove: false,
      canEdit: false,
      onConnectPointerDown,
    });

    const handle = findElementByClass(element, 'xleth-graph-state-preview__handle--connect-parameter-source')!;
    expect(handle).toBeTruthy();
    expect(handle.props['data-connect-source-kind']).toBe('macro');
    expect(handle.props['data-control-port-id']).toBe('macro:macro-a:controlOut');

    handle.props.onPointerDown({ button: 0 });
    expect(onConnectPointerDown).toHaveBeenCalledWith({ button: 0 }, macro);
  });

  it('highlights the exact hovered parameter input target', () => {
    const eq = buildGraphStatePreviewModel(graphState([
      effectWithPorts(),
    ], [])).nodes.find((candidate) => candidate.id === 'eq')!;

    const b2Html = renderToStaticMarkup(
      <GraphStatePreviewNode
        node={eq}
        dragging={false}
        connectEnabled={false}
        connectParameterEnabled
        connectActive={false}
        hoveredParameterPortId="gpp:eq:b2_q"
        canRemove={false}
        canEdit={false}
      />,
    );

    expect(b2Html).toContain('data-parameter-port-id="gpp:eq:b2_q"');
    expect(b2Html).toContain('data-drop-target-hovered="true"');
    expect(countAttribute(b2Html, 'data-drop-target-hovered="true"')).toBe(1);
    expect(b2Html).toContain('aria-label="EQ parameter input: B2 Q"');

    const b0Html = renderToStaticMarkup(
      <GraphStatePreviewNode
        node={eq}
        dragging={false}
        connectEnabled={false}
        connectParameterEnabled
        connectActive={false}
        hoveredParameterPortId="gpp:eq:b0_q"
        canRemove={false}
        canEdit={false}
      />,
    );

    expect(b0Html).toContain('data-parameter-port-id="gpp:eq:b0_q"');
    expect(countAttribute(b0Html, 'data-drop-target-hovered="true"')).toBe(1);
  });

  it('clears the parameter target highlight when no valid parameter is hovered', () => {
    const eq = buildGraphStatePreviewModel(graphState([
      effectWithPorts(),
    ], [])).nodes.find((candidate) => candidate.id === 'eq')!;

    const html = renderToStaticMarkup(
      <GraphStatePreviewNode
        node={eq}
        dragging={false}
        connectEnabled={false}
        connectParameterEnabled
        connectActive={false}
        hoveredParameterPortId={null}
        canRemove={false}
        canEdit={false}
      />,
    );

    expect(html).toContain('data-parameter-port-id="gpp:eq:b2_q"');
    expect(html).not.toContain('data-drop-target-hovered="true"');
  });

  it('resolves parameter drop targets from the exact hovered port metadata', () => {
    const nodeElement = makeClosestElement({ 'data-node-id': 'eq' });
    const portElement = makeClosestElement({
      'data-parameter-id': 'b2_q',
      'data-parameter-port-id': 'gpp:eq:b2_q',
    }, {
      '[data-node-id]': nodeElement,
    });
    const labelElement = makeClosestElement({}, {
      '[data-parameter-port-type="parameter-input"][data-parameter-port-id]': portElement,
    });

    expect(resolveParameterDropTargetFromElement(labelElement as Element, 'macro-a')).toEqual({
      nodeId: 'eq',
      parameterId: 'b2_q',
      portId: 'gpp:eq:b2_q',
    });
  });

  it('rejects invalid parameter drops before creating a parameter edge', () => {
    const onConnect = vi.fn();
    const audioHandle = makeClosestElement({}, {
      '[data-parameter-port-type="parameter-input"][data-parameter-port-id]': null,
    });

    const target = resolveParameterDropTargetFromElement(audioHandle as Element, 'macro-a');

    expect(target).toBeNull();
    expect(connectHighlightedParameterDropTarget('macro-a', target, onConnect)).toBe(false);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('connects macro release through the highlighted parameter target metadata', () => {
    const onConnect = vi.fn();
    const target = {
      nodeId: 'eq',
      parameterId: 'b2_q',
      portId: 'gpp:eq:b2_q',
    };

    expect(connectHighlightedParameterDropTarget('macro-a', target, onConnect)).toBe(true);
    expect(onConnect).toHaveBeenCalledWith('macro-a', 'eq', 'b2_q');
  });
});

// ---------------------------------------------------------------------------
// FXG.4-g — Bezier Mapping Editor UI
// ---------------------------------------------------------------------------

function makeParameterEdge(mapping?: unknown): GraphStateEdge {
  return {
    id: 'p-edge',
    sourceNodeId: 'macro-1',
    sourcePort: 'controlOut',
    targetNodeId: 'eq-1',
    targetPort: 'gpp:eq-1:mix',
    type: 'parameter',
    targetParameter: { parameterId: 'mix', nameSnapshot: 'Mix' } as Record<string, unknown>,
    mapping: mapping ?? { enabled: true, sourceMin: 0, sourceMax: 1, targetMin: 0, targetMax: 1, curve: { type: 'linear' } },
  };
}

describe('FXG.4-g ParameterEdgeMappingEditor', () => {
  it('renders source and target labels', () => {
    const html = renderToStaticMarkup(
      <ParameterEdgeMappingEditor
        edgeId="p-edge"
        edge={makeParameterEdge()}
        sourceLabel="Macro 1"
        targetLabel="EQ / Mix"
        x={100}
        y={100}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain('Macro 1');
    expect(html).toContain('EQ / Mix');
  });

  it('renders enabled checkbox checked for an enabled mapping', () => {
    const html = renderToStaticMarkup(
      <ParameterEdgeMappingEditor
        edgeId="p-edge"
        edge={makeParameterEdge({ enabled: true })}
        sourceLabel="M1"
        targetLabel="EQ"
        x={0}
        y={0}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain('checked');
  });

  it('renders Linear and Bezier curve tab buttons', () => {
    const html = renderToStaticMarkup(
      <ParameterEdgeMappingEditor
        edgeId="p-edge"
        edge={makeParameterEdge()}
        sourceLabel="M1"
        targetLabel="EQ"
        x={0}
        y={0}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain('Linear');
    expect(html).toContain('Bezier');
  });

  it('marks Linear tab active for a linear mapping', () => {
    const html = renderToStaticMarkup(
      <ParameterEdgeMappingEditor
        edgeId="p-edge"
        edge={makeParameterEdge({ curve: { type: GRAPH_PARAMETER_CURVE_LINEAR } })}
        sourceLabel="M1"
        targetLabel="EQ"
        x={0}
        y={0}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain('curve-tab--active');
    expect(html).toMatch(/curve-tab--active[^>]*>Linear/);
  });

  it('marks Bezier tab active for a bezier mapping', () => {
    const html = renderToStaticMarkup(
      <ParameterEdgeMappingEditor
        edgeId="p-edge"
        edge={makeParameterEdge({ curve: createDefaultBezierCurve() })}
        sourceLabel="M1"
        targetLabel="EQ"
        x={0}
        y={0}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toMatch(/curve-tab--active[^>]*>Bezier/);
  });

  it('renders the bezier SVG with control point circles for a bezier mapping', () => {
    const html = renderToStaticMarkup(
      <ParameterEdgeMappingEditor
        edgeId="p-edge"
        edge={makeParameterEdge({ curve: createDefaultBezierCurve() })}
        sourceLabel="M1"
        targetLabel="EQ"
        x={0}
        y={0}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain('mapping-editor-bezier-svg');
    expect(html).toContain('mapping-editor-bezier-cp');
  });

  it('does not render bezier control point circles for a linear mapping', () => {
    const html = renderToStaticMarkup(
      <ParameterEdgeMappingEditor
        edgeId="p-edge"
        edge={makeParameterEdge({ curve: { type: GRAPH_PARAMETER_CURVE_LINEAR } })}
        sourceLabel="M1"
        targetLabel="EQ"
        x={0}
        y={0}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).not.toContain('mapping-editor-bezier-cp');
  });

  it('renders preview values section', () => {
    const html = renderToStaticMarkup(
      <ParameterEdgeMappingEditor
        edgeId="p-edge"
        edge={makeParameterEdge()}
        sourceLabel="M1"
        targetLabel="EQ"
        x={0}
        y={0}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain('mapping-editor-preview');
    expect(html).toContain('0%:');
    expect(html).toContain('50%:');
    expect(html).toContain('100%:');
  });

  it('renders a close button', () => {
    const html = renderToStaticMarkup(
      <ParameterEdgeMappingEditor
        edgeId="p-edge"
        edge={makeParameterEdge()}
        sourceLabel="M1"
        targetLabel="EQ"
        x={0}
        y={0}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain('mapping-editor-close');
  });

  it('does not render for audio edges (mapping editor only shown for parameter edges)', () => {
    // The edit-mapping affordance does not appear for audio edges even when
    // onUpdateParameterEdgeMapping is provided — only parameter edges get it.
    const audioEdgeDocument: GraphStateDocument = {
      schemaVersion: 1,
      trackId: '7',
      nodes: [
        inputNode(),
        effectNode('eq', 'EQ', 0, { x: 260, y: 0 }),
        outputNode({ x: 520, y: 0 }),
      ],
      edges: [
        { id: 'a-1', sourceNodeId: 'input', sourcePort: 'audio', targetNodeId: 'eq', targetPort: 'audioIn', type: 'audio' },
        { id: 'a-2', sourceNodeId: 'eq', sourcePort: 'audioOut', targetNodeId: 'output', targetPort: 'audio', type: 'audio' },
      ],
    };
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={audioEdgeDocument}
        onDisconnectEdge={vi.fn()}
        onUpdateParameterEdgeMapping={vi.fn()}
        notice={null}
      />,
    );
    expect(html).not.toContain('mapping-editor-bezier-svg');
    expect(html).not.toContain('edge-edit');
  });
});

describe('FXG.4-g GraphStatePreview mapping editor integration', () => {
  function makeMacroParameterGraph(): GraphStateDocument {
    return {
      schemaVersion: 1,
      trackId: '7',
      nodes: [
        inputNode(),
        {
          id: 'eq-1',
          type: 'effect',
          position: { x: 200, y: 0 },
          data: {
            effectInstanceId: 'inst-1',
            pluginId: 'stock:eq',
            displayName: 'EQ',
            bypass: false,
            missing: false,
            crashed: false,
            sourceChainSlotIndex: null,
            exposedParameterPorts: [
              { parameterId: 'mix', parameterIndexFallback: 0, nameSnapshot: 'Mix', labelSnapshot: null, parameterIdIsFallback: false, automatable: true, readOnly: false },
            ],
          },
        },
        { id: 'macro-1', type: 'macro', position: { x: 100, y: 100 }, data: { label: 'Macro 1', normalizedValue: 0.5 } },
        outputNode({ x: 400, y: 0 }),
      ],
      edges: [
        { id: 'a1', sourceNodeId: 'input', sourcePort: 'audio', targetNodeId: 'eq-1', targetPort: 'audioIn', type: 'audio' },
        { id: 'a2', sourceNodeId: 'eq-1', sourcePort: 'audioOut', targetNodeId: 'output', targetPort: 'audio', type: 'audio' },
        {
          id: 'p1',
          sourceNodeId: 'macro-1',
          sourcePort: 'controlOut',
          targetNodeId: 'eq-1',
          targetPort: 'gpp:eq-1:mix',
          type: 'parameter',
          targetParameter: { kind: 'graph-parameter', graphNodeId: 'eq-1', effectInstanceId: 'inst-1', parameterId: 'mix', nameSnapshot: 'Mix', parameterIndexFallback: 0, parameterIdIsFallback: false },
          mapping: { enabled: true, sourceMin: 0, sourceMax: 1, targetMin: 0, targetMax: 1, curve: { type: 'linear' } },
        },
      ],
    };
  }

  it('renders an edit mapping button for parameter edges when onUpdateParameterEdgeMapping is provided', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={makeMacroParameterGraph()}
        onDisconnectEdge={vi.fn()}
        onUpdateParameterEdgeMapping={vi.fn()}
        notice={null}
      />,
    );
    expect(html).toContain('edge-edit');
  });

  it('does not render an edit mapping button when onUpdateParameterEdgeMapping is absent', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={makeMacroParameterGraph()}
        onDisconnectEdge={vi.fn()}
        notice={null}
      />,
    );
    expect(html).not.toContain('edge-edit');
  });

  it('edit mapping button is accessible with proper aria-label', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={makeMacroParameterGraph()}
        onDisconnectEdge={vi.fn()}
        onUpdateParameterEdgeMapping={vi.fn()}
        notice={null}
      />,
    );
    expect(html).toContain('aria-label="Edit mapping for');
  });
});
