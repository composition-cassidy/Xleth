import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import GraphStatePreview, {
  CONNECT_SNAP_RADIUS_PX,
  GraphParameterContextMenu,
  GraphStatePreviewNode,
  ParameterEdgeMappingEditor,
  buildGraphStatePreviewModel,
  computeNodeDragPosition,
  connectHighlightedParameterDropTarget,
  connectHighlightedSidechainDropTarget,
  distanceToAudioCableCurve,
  filterExposeParameterDescriptors,
  findAudioCableAtPoint,
  findNearestPortWithinRadius,
  resolveAudioDropTargetFromElement,
  resolveParameterDropTargetFromElement,
  resolveSidechainDropTargetFromElement,
  type GraphStateDocument,
  type GraphStateEdge,
  type GraphStateNode,
} from './GraphStatePreview';
import { buildExposeParameterMenuGroups } from './graphParameterUtils';
import { createDefaultBezierCurve, GRAPH_PARAMETER_CURVE_BEZIER, GRAPH_PARAMETER_CURVE_LINEAR, normalizeEnvelopeNodeData } from '../../../fxgraph/graphState.js';
import { fitGraphViewport } from '../../../fxgraph/graphViewport.js';
import {
  EnvelopeAdvancedControls,
  EnvelopeAhdsrGraph,
  EnvelopeNumberField,
  EnvelopeEditor,
  EnvelopeNodeBody,
  EnvelopeRangeControl,
  buildEnvelopeGraphModel,
  buildEnvelopePreviewPoints,
  describeEnvelopeAhdsr,
  formatEnvelopeParameterCount,
  IncludeSlideNotesControl,
  mapEnvelopeGraphDragToPatch,
  readEnvelopeNodeData,
} from './EnvelopeEditor';
import {
  LfoNodeBody,
  formatLfoParameterCount,
  readLfoNodeData,
} from './LfoEditor';

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
    // Edit/Remove now live in the right-click context menu, not always-visible
    // node-body buttons.
    expect(html).not.toContain('aria-label="Remove Energy"');
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

  // --- FXG.3-b / node-menu-c1 Edit is a context-menu item, not a node-body button ---

  it('never renders a node-body Edit button, regardless of onEditNode or node state', () => {
    const withEditor = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectNode('limiter', 'Limiter', 0, { x: 260, y: 0 }),
          effectNode('ph', 'Effect Node', 1, { x: 260, y: 160 }, { pluginId: 'placeholder' }),
          effectNode('rv', 'Reverb', 2, { x: 260, y: 320 }, { missing: true }),
          outputNode({ x: 520, y: 0 }),
        ], [])}
        onEditNode={vi.fn()}
      />,
    );
    const readOnly = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode(),
          effectNode('limiter', 'Limiter', 0, { x: 260, y: 0 }),
          outputNode({ x: 520, y: 0 }),
        ], [])}
      />,
    );

    expect(withEditor).not.toContain('xleth-graph-state-preview__node-edit');
    expect(withEditor).not.toContain('aria-label="Edit Limiter"');
    expect(readOnly).not.toContain('xleth-graph-state-preview__node-edit');
  });

  // Edit's enabled/disabled state now lives in GraphParameterContextMenu, wired
  // to the node's right-click (handleNodeContextMenu / handleContextEdit).
  it('enables the context-menu Edit item on real effect nodes, disables it for placeholder/missing effect nodes', () => {
    const [realNode, placeholderNode, missingNode] = buildGraphStatePreviewModel(graphState([
      inputNode(),
      effectNode('limiter', 'Limiter', 0, { x: 260, y: 0 }),
      effectNode('ph', 'Effect Node', 1, { x: 260, y: 160 }, { pluginId: 'placeholder' }),
      effectNode('rv', 'Reverb', 2, { x: 260, y: 320 }, { missing: true }),
      outputNode({ x: 520, y: 0 }),
    ], [])).nodes.filter((node) => node.type === 'effect');

    const realHtml = renderToStaticMarkup(
      <GraphParameterContextMenu node={realNode} x={0} y={0} canEdit canRemove />,
    );
    const placeholderHtml = renderToStaticMarkup(
      <GraphParameterContextMenu node={placeholderNode} x={0} y={0} canEdit canRemove />,
    );
    const missingHtml = renderToStaticMarkup(
      <GraphParameterContextMenu node={missingNode} x={0} y={0} canEdit canRemove />,
    );

    expect(realHtml).toContain('role="menuitem"');
    expect(realHtml).toContain('>Edit<');
    expect(realHtml).not.toMatch(/disabled[^>]*>\s*Edit/);
    expect(placeholderHtml).toMatch(/disabled[^>]*>\s*Edit/);
    expect(missingHtml).toMatch(/disabled[^>]*>\s*Edit/);
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

  it('curates the Xleth EQ exposure menu to normal editable bands with friendly labels, scaling to however many bands are present', () => {
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
    // Band 3 only has a freq param in this fixture, but it must still surface —
    // the menu is not allowed to cap out at a fixed band count.
    expect(html).toContain('Band 3');
    expect(html).toContain('Frequency');
    expect(html).toContain('Gain');
    expect(html).toContain('Q');
    expect(html).toContain('Type');
    expect(html).toContain('Enabled');
    expect(countText(html, 'role="menuitemcheckbox"')).toBe(16);
    expect(html).not.toContain('B0 Spec Sens');
    expect(html).not.toContain('B0 Dyn Attack');
    expect(html).not.toContain('Linear Phase');
  });

  // The engine's EQ param layout always registers all kMaxBands=16 bands'
  // worth of APVTS params regardless of how many are actually in use, so
  // these fixtures build the full 16-band set and rely on `bandCount` (the
  // instance's real, active band count) to say how many should surface.
  function allEqBandParameters() {
    const params: { parameterId: string; parameterIndex: number; name: string; automatable: true; readOnly: false }[] = [];
    for (let band = 0; band < 16; band += 1) {
      for (const [i, suffix] of ['freq', 'gain', 'q', 'type', 'enabled'].entries()) {
        params.push({
          parameterId: `b${band}_${suffix}`,
          parameterIndex: band * 5 + i,
          name: `B${band} ${suffix}`,
          automatable: true,
          readOnly: false,
        });
      }
    }
    return params;
  }

  it('exposes every active band the EQ reports, not just the first few', () => {
    const node = buildGraphStatePreviewModel(graphState([
      inputNode(),
      effectNode('eq', 'Parametric EQ', 0, { x: 260, y: 0 }, { pluginId: 'xletheq' }),
      outputNode({ x: 520, y: 0 }),
    ], [])).nodes.find((candidate) => candidate.id === 'eq')!;
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
          parameters: allEqBandParameters(),
          bandCount: 6,
        }}
        canEdit
        canRemove
      />,
    );

    for (const band of [0, 1, 2, 3, 4, 5]) {
      expect(html).toContain(`Band ${band}`);
    }
    expect(countText(html, 'role="menuitemcheckbox"')).toBe(6 * 5);
  });

  it('does not offer dormant bands beyond the EQ instance\'s active band count', () => {
    const node = buildGraphStatePreviewModel(graphState([
      inputNode(),
      effectNode('eq', 'Parametric EQ', 0, { x: 260, y: 0 }, { pluginId: 'xletheq' }),
      outputNode({ x: 520, y: 0 }),
    ], [])).nodes.find((candidate) => candidate.id === 'eq')!;
    // Mirrors the reported bug: a 1-band EQ instance where the engine still
    // reports all 16 band slots' params. Only Band 0 should be offered.
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
          parameters: allEqBandParameters(),
          bandCount: 1,
        }}
        canEdit
        canRemove
      />,
    );

    expect(html).toContain('Band 0');
    expect(html).not.toContain('Band 1');
    expect(html).not.toContain('Band 15');
    expect(countText(html, 'role="menuitemcheckbox"')).toBe(5);
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

  it('never renders a node-body Remove button on any node, including protected Track Input/Output', () => {
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

    // Remove now lives in the right-click context menu, never as a node-body button.
    expect(html).not.toContain('aria-label="Remove Limiter"');
    expect(html).not.toContain('aria-label="Remove Track Input"');
    expect(html).not.toContain('aria-label="Remove Track Output"');
  });

  it('opens the context menu for effect/macro/envelope/lfo nodes but never for Track Input/Output or Sidechain Input', () => {
    const model = buildGraphStatePreviewModel(graphState([
      inputNode(),
      effectNode('limiter', 'Limiter', 0, { x: 260, y: 0 }),
      macroNode('macro-a', 'Macro 1', 0.5, { x: 260, y: 120 }),
      outputNode({ x: 520, y: 0 }),
    ], []));
    const onNodeContextMenu = vi.fn();
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent<HTMLDivElement>;

    for (const id of ['limiter', 'macro-a']) {
      const node = model.nodes.find((candidate) => candidate.id === id)!;
      const element = GraphStatePreviewNode({ node, dragging: false, connectEnabled: false, connectActive: false, onNodeContextMenu });
      expect(element.props.onContextMenu).toBeDefined();
    }
    for (const id of ['input', 'output']) {
      const node = model.nodes.find((candidate) => candidate.id === id)!;
      const element = GraphStatePreviewNode({ node, dragging: false, connectEnabled: false, connectActive: false, onNodeContextMenu });
      expect(element.props.onContextMenu).toBeUndefined();
    }
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
// Node right-click context menu (replaces the old node-body Edit/Remove
// buttons) + double-click-to-edit.
// ---------------------------------------------------------------------------

describe('GraphStatePreview node context menu', () => {
  it('renders a plain Remove-only menu for envelope and lfo nodes (no Edit, no Expose Parameter)', () => {
    const envNode = buildGraphStatePreviewModel(envelopeGraph())
      .nodes.find((candidate) => candidate.id === 'env-a')!;
    const lfoNode = buildGraphStatePreviewModel(lfoGraph())
      .nodes.find((candidate) => candidate.id === 'lfo-a')!;

    const envHtml = renderToStaticMarkup(
      <GraphParameterContextMenu node={envNode} x={0} y={0} canEdit canRemove onRemove={vi.fn()} />,
    );
    const lfoHtml = renderToStaticMarkup(
      <GraphParameterContextMenu node={lfoNode} x={0} y={0} canEdit canRemove onRemove={vi.fn()} />,
    );

    for (const html of [envHtml, lfoHtml]) {
      expect(html).toContain('>Remove<');
      expect(html).not.toContain('>Edit<');
      expect(html).not.toContain('Expose Parameter');
    }
  });

  it('double-click wires to onEdit for an editable effect node, and stays wired off for others', () => {
    const model = buildGraphStatePreviewModel(graphState([
      inputNode(),
      effectNode('limiter', 'Limiter', 0, { x: 260, y: 0 }),
      effectNode('ph', 'Placeholder', 1, { x: 260, y: 160 }, { pluginId: 'placeholder' }),
      macroNode('macro-a', 'Macro 1', 0.5, { x: 260, y: 320 }),
      outputNode({ x: 520, y: 0 }),
    ], []));
    const onEdit = vi.fn();

    const editableEffect = GraphStatePreviewNode({
      node: model.nodes.find((n) => n.id === 'limiter')!,
      dragging: false,
      connectEnabled: false,
      connectActive: false,
      onEdit,
    });
    expect(editableEffect.props.onDoubleClick).toBeDefined();
    editableEffect.props.onDoubleClick({ stopPropagation: vi.fn() });
    expect(onEdit).toHaveBeenCalledWith('limiter');

    const placeholderEffect = GraphStatePreviewNode({
      node: model.nodes.find((n) => n.id === 'ph')!,
      dragging: false,
      connectEnabled: false,
      connectActive: false,
      onEdit,
    });
    expect(placeholderEffect.props.onDoubleClick).toBeUndefined();

    const macro = GraphStatePreviewNode({
      node: model.nodes.find((n) => n.id === 'macro-a')!,
      dragging: false,
      connectEnabled: false,
      connectActive: false,
      onEdit,
    });
    expect(macro.props.onDoubleClick).toBeUndefined();
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

// EVC.3 — Envelope Controller node UI (renderer-only, inert).
function findElementByAriaLabel(element: React.ReactElement, label: string): React.ReactElement | null {
  const children = React.Children.toArray(element.props.children);
  for (const child of children) {
    if (!React.isValidElement(child)) continue;
    if (child.props['aria-label'] === label) return child;
    const nested = findElementByAriaLabel(child, label);
    if (nested) return nested;
  }
  return null;
}

function envelopeNode(
  id = 'env-a',
  data: Record<string, unknown> = {},
  position = { x: 260, y: 0 },
): GraphStateNode {
  return { id, type: 'envelope', position, data };
}

function envelopeGraph(data: Record<string, unknown> = {}): GraphStateDocument {
  return graphState(
    [inputNode(), envelopeNode('env-a', data), outputNode({ x: 560, y: 0 })],
    [],
  );
}

function renderEnvelopeNodeMarkup(
  overrides: Partial<Parameters<typeof GraphStatePreviewNode>[0]> = {},
) {
  const node = buildGraphStatePreviewModel(envelopeGraph())
    .nodes.find((candidate) => candidate.id === 'env-a')!;
  return renderToStaticMarkup(
    GraphStatePreviewNode({
      node,
      dragging: false,
      connectEnabled: true,
      connectParameterEnabled: true,
      connectActive: false,
      canRemove: true,
      canEdit: true,
      ...overrides,
    }),
  );
}

describe('GraphStatePreview envelope nodes (EVC-R1)', () => {
  it('renders an envelope node with label and modulator identity', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview graphState={envelopeGraph({ label: 'Pluck Env' })} onUpdateEnvelope={vi.fn()} />,
    );
    expect(html).toContain('data-node-type="envelope"');
    expect(html).toContain('xleth-graph-state-preview__node--envelope');
    expect(html).toContain('Pluck Env');
    expect(html).toContain('Envelope Modulator');
    // The retired per-voice identity is gone.
    expect(html).not.toContain('Per-Voice Envelope');
  });

  it('renders the AHDSR summary with no trigger-source or retrigger pills (EVC-R2-r3)', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={envelopeGraph({ attackMs: 10, holdMs: 0, decayMs: 120, sustain: 0.7, releaseMs: 200 })}
        onUpdateEnvelope={vi.fn()}
      />,
    );
    expect(html).toContain('AHDSR');
    expect(html).toContain('A 10 ms');
    expect(html).toContain('S 70%');
    expect(html).toContain('0 params');
    // EVC-R2-r3 — the Notes/Clips/Notes+Clips source pill and the Restart/Legato pill are gone.
    expect(html).not.toContain('Notes + Clips');
    expect(html).not.toContain('Restart');
    expect(html).not.toContain('Legato');
    // Retired per-voice labels must not appear.
    expect(html).not.toContain('Voice Gain');
    expect(html).not.toContain('Poly');
    expect(html).not.toContain('Legato (mono)');
  });

  it('surfaces a Slide pill only when includeSlideNotes is enabled', () => {
    const off = renderToStaticMarkup(
      <GraphStatePreview graphState={envelopeGraph({ includeSlideNotes: false })} onUpdateEnvelope={vi.fn()} />,
    );
    const on = renderToStaticMarkup(
      <GraphStatePreview graphState={envelopeGraph({ includeSlideNotes: true })} onUpdateEnvelope={vi.fn()} />,
    );
    expect(off).not.toContain('>Slide<');
    expect(on).toContain('>Slide<');
  });

  it('summarizes outgoing envelope parameter connections compactly', () => {
    const source = graphState(
      [
        inputNode(),
        envelopeNode('env-a', {}, { x: 120, y: 140 }),
        effectNode('fx-a', 'Filter', 0, { x: 360, y: 0 }, {
          exposedParameterPorts: [
            { parameterId: 'cutoff', parameterIndexFallback: 0, nameSnapshot: 'Cutoff', labelSnapshot: null, parameterIdIsFallback: false, automatable: true, readOnly: false },
            { parameterId: 'resonance', parameterIndexFallback: 1, nameSnapshot: 'Resonance', labelSnapshot: null, parameterIdIsFallback: false, automatable: true, readOnly: false },
          ],
        }),
        outputNode({ x: 620, y: 0 }),
      ],
      [
        { id: 'pe-a', sourceNodeId: 'env-a', sourcePort: 'controlOut', targetNodeId: 'fx-a', targetPort: 'gpp:fx-a:cutoff', type: 'parameter', targetParameter: { parameterId: 'cutoff' } },
        { id: 'pe-b', sourceNodeId: 'env-a', sourcePort: 'controlOut', targetNodeId: 'fx-a', targetPort: 'gpp:fx-a:resonance', type: 'parameter', targetParameter: { parameterId: 'resonance' } },
      ],
    );
    const html = renderToStaticMarkup(<GraphStatePreview graphState={source} onUpdateEnvelope={vi.fn()} />);
    expect(html).toContain('2 params');
    expect(formatEnvelopeParameterCount(1)).toBe('1 param');
  });

  it('renders the compact AHDSR graph by default', () => {
    const html = renderEnvelopeNodeMarkup({ onEnvelopeUpdate: vi.fn() });
    expect(html).toContain('xleth-graph-state-preview__envelope-preview-curve');
    expect(html).toContain('points=');
    expect(html).toContain('Envelope AHDSR graph');
  });

  it('exposes a controlOut handle but no audio handles and no parameter input ports', () => {
    const html = renderEnvelopeNodeMarkup({ onEnvelopeUpdate: vi.fn() });
    // Envelope is a control source: it has a controlOut, not an audio in handle.
    expect(html).not.toContain('xleth-graph-state-preview__handle--in');
    expect(html).toContain('xleth-graph-state-preview__handle--control-out');
    expect(html).toContain('data-control-output="true"');
    expect(html).toContain('data-control-port-id="envelope:env-a:controlOut"');
    expect(html).toContain('data-control-port-type="envelope-output"');
    // It still has no exposed parameter INPUT ports of its own.
    expect(html).not.toContain('data-parameter-port-type');
  });

  it('makes the controlOut a parameter-link drag source only when envelope linking is enabled', () => {
    const envNode = buildGraphStatePreviewModel(envelopeGraph())
      .nodes.find((candidate) => candidate.id === 'env-a')!;
    const linkable = renderToStaticMarkup(GraphStatePreviewNode({
      node: envNode,
      dragging: false,
      connectEnabled: false,
      connectParameterEnabled: false,
      connectEnvelopeParameterEnabled: true,
      connectActive: false,
      canRemove: false,
      canEdit: false,
      onConnectPointerDown: vi.fn(),
    }));
    expect(linkable).toContain('data-connect-source="true"');
    expect(linkable).toContain('data-connect-source-kind="envelope"');
    expect(linkable).toContain('xleth-graph-state-preview__handle--connect-parameter-source');

    const staticHtml = renderToStaticMarkup(GraphStatePreviewNode({
      node: envNode,
      dragging: false,
      connectEnabled: false,
      connectParameterEnabled: false,
      connectEnvelopeParameterEnabled: false,
      connectActive: false,
      canRemove: false,
      canEdit: false,
    }));
    expect(staticHtml).toContain('data-control-output="true"');
    expect(staticHtml).not.toContain('data-connect-source-kind="envelope"');
    expect(staticHtml).not.toContain('xleth-graph-state-preview__handle--connect-parameter-source');
  });

  it('routes an envelope controlOut pointer-down through the connect handler', () => {
    const envNode = buildGraphStatePreviewModel(envelopeGraph())
      .nodes.find((candidate) => candidate.id === 'env-a')!;
    const onConnectPointerDown = vi.fn();
    const element = GraphStatePreviewNode({
      node: envNode,
      dragging: false,
      connectEnabled: false,
      connectParameterEnabled: false,
      connectEnvelopeParameterEnabled: true,
      connectActive: false,
      canRemove: false,
      canEdit: false,
      onConnectPointerDown,
    });
    const handle = findElementByClass(element, 'xleth-graph-state-preview__handle--connect-parameter-source')!;
    expect(handle).toBeTruthy();
    expect(handle.props['data-connect-source-kind']).toBe('envelope');
    expect(handle.props['data-control-port-id']).toBe('envelope:env-a:controlOut');
    handle.props.onPointerDown({ button: 0 });
    expect(onConnectPointerDown).toHaveBeenCalledWith({ button: 0 }, envNode);
  });

  it('stays draggable like other editable nodes, with Remove reachable via the context menu', () => {
    const onNodeContextMenu = vi.fn();
    const html = renderEnvelopeNodeMarkup({
      onEnvelopeUpdate: vi.fn(),
      onNodeContextMenu,
      onPointerDown: vi.fn(),
    });
    // No node-body Remove button — the context menu carries it instead.
    expect(html).not.toContain('aria-label="Remove Envelope"');
    expect(html).toContain('xleth-graph-state-preview__node--draggable');

    const node = buildGraphStatePreviewModel(envelopeGraph())
      .nodes.find((candidate) => candidate.id === 'env-a')!;
    const element = GraphStatePreviewNode({
      node,
      dragging: false,
      connectEnabled: true,
      connectActive: false,
      onNodeContextMenu,
    });
    expect(element.props.onContextMenu).toBeDefined();
  });

  it('defaults to compact layout and keeps the long editor collapsed', () => {
    const editableHtml = renderEnvelopeNodeMarkup({ onEnvelopeUpdate: vi.fn() });
    const readOnlyHtml = renderEnvelopeNodeMarkup({ onEnvelopeUpdate: undefined });
    expect(editableHtml).toContain('Envelope compact summary');
    expect(editableHtml).toContain('Edit Envelope envelope');
    expect(editableHtml).not.toContain('xleth-graph-state-preview__envelope-editor');
    expect(editableHtml).not.toContain('aria-label="Attack ms"');
    expect(readOnlyHtml).toContain('xleth-graph-state-preview__envelope-preview-curve');
    expect(readOnlyHtml).toContain('Envelope compact summary');
    expect(readOnlyHtml).not.toContain('Edit Envelope envelope');
    expect(readOnlyHtml).not.toContain('xleth-graph-state-preview__envelope-editor');
    expect(readOnlyHtml).not.toContain('aria-label="Attack ms"');
  });

  it('expanded edit mode shows DAW-style controls and editable graph handles', () => {
    const html = renderToStaticMarkup(
      <EnvelopeNodeBody
        nodeId="env-a"
        data={readEnvelopeNodeData({})}
        onChange={vi.fn()}
        defaultExpanded
      />,
    );
    expect(html).toContain('xleth-graph-state-preview__envelope-editor');
    expect(html).toContain('Editable AHDSR envelope graph');
    expect(html).toContain('Attack handle');
    expect(html).toContain('Sustain handle');
    expect(html).toContain('Release handle');
    expect(html).toContain('aria-label="Attack ms slider"');
    expect(html).toContain('aria-label="Sustain level slider"');
    // EVC-R4 — the node-level Amount master scale was removed: modulation depth is now a
    // per-connection control on the Envelope -> Parameter edge, so there is no second
    // "how much" slider on the node.
    expect(html).not.toContain('aria-label="Amount slider"');
    expect(html).not.toContain('>Amount<');
  });

  it('read-only/no-callback mode does not expose editing controls even if expanded is requested', () => {
    const html = renderToStaticMarkup(
      <EnvelopeNodeBody
        nodeId="env-a"
        data={readEnvelopeNodeData({})}
        onChange={null}
        defaultExpanded
      />,
    );
    expect(html).toContain('Envelope AHDSR graph');
    expect(html).not.toContain('Editable AHDSR envelope graph');
    expect(html).not.toContain('xleth-graph-state-preview__envelope-editor');
    expect(html).not.toContain('Attack handle');
    expect(html).not.toContain('Edit Envelope envelope');
  });

  it('renders Add Envelope only when its action is provided', () => {
    const source = graphState([inputNode(), outputNode()], []);
    const editableHtml = renderToStaticMarkup(
      <GraphStatePreview graphState={source} onAddEnvelopeNode={vi.fn()} />,
    );
    const readOnlyHtml = renderToStaticMarkup(<GraphStatePreview graphState={source} />);
    expect(editableHtml).toContain('Add Envelope');
    expect(readOnlyHtml).not.toContain('Add Envelope');
  });

  it('commits an Attack edit through the envelope update callback', () => {
    const onChange = vi.fn();
    const element = EnvelopeNumberField({
      label: 'Attack',
      fieldKey: 'attackMs',
      value: 10,
      min: 0,
      step: 1,
      ariaLabel: 'Attack ms',
      onChange,
    });
    const input = findElementByClass(element, 'xleth-graph-state-preview__envelope-input')!;
    input.props.onBlur({ currentTarget: { value: '25' } });
    expect(onChange).toHaveBeenCalledWith({ attackMs: 25 });
  });

  it('slider controls commit attack, hold, decay, sustain, and release on release, not per tick', () => {
    const cases = [
      ['Attack', 'attackMs', 10, 250, 'Attack ms slider'],
      ['Hold', 'holdMs', 0, 125, 'Hold ms slider'],
      ['Decay', 'decayMs', 120, 300, 'Decay ms slider'],
      ['Sustain', 'sustain', 0.7, 0.4, 'Sustain level slider'],
      ['Release', 'releaseMs', 200, 450, 'Release ms slider'],
    ] as const;
    for (const [label, fieldKey, value, next, ariaLabel] of cases) {
      const onChange = vi.fn();
      const element = EnvelopeRangeControl({
        label,
        fieldKey,
        value,
        min: fieldKey.endsWith('Ms') ? 0 : 0,
        max: fieldKey.endsWith('Ms') ? undefined : 1,
        step: fieldKey.endsWith('Ms') ? 1 : 0.01,
        rangeMin: 0,
        rangeMax: fieldKey.endsWith('Ms') ? 5000 : 1,
        displayValue: String(value),
        ariaLabel: ariaLabel.replace(' slider', ''),
        onChange,
      });
      const slider = findElementByAriaLabel(element, ariaLabel)!;
      // The slider is uncontrolled — no onChange fires per tick, so nothing is
      // committed until the gesture ends (pointerup / blur / keyup).
      expect(slider.props.onChange).toBeUndefined();
      slider.props.onPointerUp({ currentTarget: { value: String(next) } });
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith({ [fieldKey]: next });
    }
  });

  it('keeps above-range millisecond values in the numeric field while capping the slider view', () => {
    const onChange = vi.fn();
    const element = EnvelopeRangeControl({
      label: 'Attack',
      fieldKey: 'attackMs',
      value: 9000,
      min: 0,
      step: 1,
      rangeMin: 0,
      rangeMax: 5000,
      displayValue: '9000 ms',
      ariaLabel: 'Attack ms',
      onChange,
    });
    const slider = findElementByAriaLabel(element, 'Attack ms slider')!;
    const input = findElementByAriaLabel(element, 'Attack ms')!;
    expect(slider.props.defaultValue).toBe(5000);
    expect(input.props.defaultValue).toBe(9000);
  });

  it('uses an uncontrolled input and skips committing non-numeric text', () => {
    // The input is uncontrolled (defaultValue), so React never resets the field
    // mid-type — typing "1." is never destroyed. On blur, only a genuinely
    // non-numeric value (NaN) is skipped so the node data is never corrupted.
    const onChange = vi.fn();
    const element = EnvelopeNumberField({
      label: 'Decay',
      fieldKey: 'decayMs',
      value: 120,
      ariaLabel: 'Decay ms',
      onChange,
    });
    const input = findElementByClass(element, 'xleth-graph-state-preview__envelope-input')!;
    expect(input.props.defaultValue).toBe(120);
    expect(input.props.value).toBeUndefined();
    input.props.onBlur({ currentTarget: { value: 'abc' } });
    input.props.onBlur({ currentTarget: { value: '-' } });
    expect(onChange).not.toHaveBeenCalled();
    input.props.onBlur({ currentTarget: { value: '15.5' } });
    expect(onChange).toHaveBeenCalledWith({ decayMs: 15.5 });
  });

  it('clamps Sustain through the shared normalization path', () => {
    // The editor commits raw values; clamping happens in normalizeEnvelopeNodeData,
    // the same helper the store update action uses.
    expect(normalizeEnvelopeNodeData({ sustain: 1.8 }).sustain).toBe(1);
    expect(normalizeEnvelopeNodeData({ sustain: -0.4 }).sustain).toBe(0);
    // EVC-R4 — `amount` is retired and dropped by the closed schema rather than clamped.
    expect(normalizeEnvelopeNodeData({ amount: 5 })).not.toHaveProperty('amount');
  });

  it('EVC-R2-r3 — the Trigger Source and Retrigger Mode selectors no longer render', () => {
    const html = renderToStaticMarkup(
      <EnvelopeEditor nodeId="env-a" data={readEnvelopeNodeData({})} onChange={vi.fn()} />,
    );
    expect(html).not.toContain('Trigger Source');
    expect(html).not.toContain('aria-label="Trigger source"');
    expect(html).not.toContain('Retrigger Mode');
    expect(html).not.toContain('aria-label="Retrigger mode"');
    // The Notes/Clips/Notes+Clips and Restart/Legato options are gone with the selects.
    expect(html).not.toContain('Notes + Clips');
    expect(html).not.toContain('>Legato<');
  });

  it('no longer renders the retired per-voice editor fields', () => {
    const html = renderToStaticMarkup(
      <EnvelopeEditor nodeId="env-a" data={readEnvelopeNodeData({})} onChange={vi.fn()} />,
    );
    expect(html).not.toContain('Voice mode');
    expect(html).not.toContain('Max voices');
    expect(html).not.toContain('Mono legato');
    expect(html).not.toContain('Mono glide ms');
  });

  it('renders an Include slide notes checkbox in the expanded editor', () => {
    const html = renderToStaticMarkup(
      <EnvelopeEditor nodeId="env-a" data={readEnvelopeNodeData({})} onChange={vi.fn()} />,
    );
    expect(html).toContain('Include slide notes');
    expect(html).toContain('aria-label="Include slide notes"');
    expect(html).toContain('type="checkbox"');
  });

  it('Include slide notes checkbox updates envelope data through the callback', () => {
    const onChange = vi.fn();
    const element = IncludeSlideNotesControl({
      data: readEnvelopeNodeData({ includeSlideNotes: false }),
      onChange,
    });
    const checkbox = findElementByAriaLabel(element, 'Include slide notes')!;
    expect(checkbox.props.checked).toBe(false);
    checkbox.props.onChange({ currentTarget: { checked: true } });
    expect(onChange).toHaveBeenCalledWith({ includeSlideNotes: true });
  });

  it('reflects an enabled includeSlideNotes as a checked box', () => {
    const element = IncludeSlideNotesControl({
      data: readEnvelopeNodeData({ includeSlideNotes: true }),
      onChange: vi.fn(),
    });
    const checkbox = findElementByAriaLabel(element, 'Include slide notes')!;
    expect(checkbox.props.checked).toBe(true);
  });

  it('read-only mode (no onChange) does not expose the Include slide notes checkbox', () => {
    const html = renderToStaticMarkup(
      <EnvelopeNodeBody nodeId="env-a" data={readEnvelopeNodeData({ includeSlideNotes: true })} onChange={null} defaultExpanded />,
    );
    expect(html).not.toContain('aria-label="Include slide notes"');
    expect(html).not.toContain('xleth-graph-state-preview__envelope-editor');
  });

  it('advanced disclosure hides and shows tension controls', () => {
    const collapsed = renderToStaticMarkup(
      <EnvelopeEditor nodeId="env-a" data={readEnvelopeNodeData({})} onChange={vi.fn()} />,
    );
    const expanded = renderToStaticMarkup(
      <EnvelopeEditor nodeId="env-a" data={readEnvelopeNodeData({})} onChange={vi.fn()} defaultAdvancedOpen />,
    );
    expect(collapsed).toContain('Toggle envelope advanced controls');
    expect(collapsed).not.toContain('Attack tension slider');
    expect(expanded).toContain('Envelope advanced controls');
    expect(expanded).toContain('Attack tension slider');
    expect(expanded).toContain('Decay tension slider');
    expect(expanded).toContain('Release tension slider');
  });

  it('builds illustrative A/H/D/S/R preview points with rise, plateaus, and fall', () => {
    const data = readEnvelopeNodeData({ attackMs: 10, holdMs: 5, decayMs: 40, sustain: 0.5, releaseMs: 30 });
    const points = buildEnvelopePreviewPoints(data, 100, 50);
    expect(points).toHaveLength(6);
    // Starts at bottom, rises to the top after attack, holds, decays to sustain.
    expect(points[0].y).toBe(50);
    expect(points[1].y).toBe(0);
    expect(points[2].y).toBe(0);
    expect(points[3].y).toBe(25);
    expect(points[4].y).toBe(25);
    // Ends back at the baseline after release.
    expect(points[5].y).toBe(50);
    // Monotonic non-decreasing in x across the whole curve.
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].x).toBeGreaterThanOrEqual(points[i - 1].x);
    }
  });

  it('builds AHDSR graph points for zero durations', () => {
    const data = readEnvelopeNodeData({ attackMs: 0, holdMs: 0, decayMs: 0, sustain: 0.25, releaseMs: 0 });
    const model = buildEnvelopeGraphModel(data, 100, 50);
    expect(model.points).toHaveLength(6);
    expect(model.handles.map((handle) => handle.handle)).toEqual(['attack', 'hold', 'decay', 'sustain', 'release']);
    for (const point of model.points) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });

  it('builds AHDSR graph points for long durations without mutating input', () => {
    const data = readEnvelopeNodeData({ attackMs: 8000, holdMs: 3000, decayMs: 7000, sustain: 0.2, releaseMs: 9000 });
    const before = JSON.stringify(data);
    const model = buildEnvelopeGraphModel(data, 196, 54);
    expect(model.totalMs).toBeGreaterThan(0);
    // The release point sits short of the right edge (headroom is reserved past
    // it) so a drag can grow releaseMs, not just shrink it — it must never be
    // pinned to the width, which would make growth impossible.
    expect(model.points[5].x).toBeLessThan(196);
    expect(model.points[5].x).toBeGreaterThan(0);
    expect(JSON.stringify(data)).toBe(before);
  });

  it('maps graph handle drags to clamped AHDSR patches', () => {
    const data = readEnvelopeNodeData({ attackMs: 10, holdMs: 5, decayMs: 40, sustain: 0.5, releaseMs: 30 });
    expect(mapEnvelopeGraphDragToPatch(data, 'attack', { x: 50, y: 0 }, 100, 50).attackMs).toBeGreaterThan(0);
    expect(mapEnvelopeGraphDragToPatch(data, 'release', { x: 0, y: 50 }, 100, 50)).toEqual({ releaseMs: 0 });
    expect(mapEnvelopeGraphDragToPatch(data, 'sustain', { x: 0, y: -20 }, 100, 50)).toEqual({ sustain: 1 });
    expect(mapEnvelopeGraphDragToPatch(data, 'sustain', { x: 0, y: 80 }, 100, 50)).toEqual({ sustain: 0 });
  });

  it('renders editable AHDSR graph handles as explicit affordances', () => {
    const html = renderToStaticMarkup(
      <EnvelopeAhdsrGraph data={readEnvelopeNodeData({})} editable onChange={vi.fn()} />,
    );
    expect(html).toContain('Editable AHDSR envelope graph');
    expect(html).toContain('Attack handle');
    expect(html).toContain('Hold handle');
    expect(html).toContain('Decay handle');
    expect(html).toContain('Sustain handle');
    expect(html).toContain('Release handle');
  });

  it('summarizes AHDSR purely from node data', () => {
    const summary = describeEnvelopeAhdsr(readEnvelopeNodeData({ attackMs: 5, decayMs: 60, sustain: 0.4 }));
    expect(summary).toContain('A 5 ms');
    expect(summary).toContain('D 60 ms');
    expect(summary).toContain('S 40%');
  });

  it('still renders effect and macro nodes alongside envelope nodes', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState(
          [
            inputNode(),
            effectNode('comp', 'Compressor', 0, { x: 240, y: 0 }),
            macroNode('macro-a', 'Drive', 0.5, { x: 240, y: 160 }),
            envelopeNode('env-a', { label: 'Voice Env' }, { x: 240, y: 320 }),
            outputNode({ x: 560, y: 0 }),
          ],
          [],
        )}
        onUpdateEnvelope={vi.fn()}
        onUpdateMacroValue={vi.fn()}
      />,
    );
    expect(html).toContain('data-node-type="effect"');
    expect(html).toContain('data-node-type="macro"');
    expect(html).toContain('data-node-type="envelope"');
    expect(html).toContain('Compressor');
    expect(html).toContain('Drive');
    expect(html).toContain('Voice Env');
  });
});

// LFO Modulator node UI (renderer-only, inert) — literal mirror of the envelope
// node fixtures above.
function lfoNode(
  id = 'lfo-a',
  data: Record<string, unknown> = {},
  position = { x: 260, y: 0 },
): GraphStateNode {
  return { id, type: 'lfo', position, data };
}

function lfoGraph(data: Record<string, unknown> = {}): GraphStateDocument {
  return graphState(
    [inputNode(), lfoNode('lfo-a', data), outputNode({ x: 560, y: 0 })],
    [],
  );
}

function renderLfoNodeMarkup(
  overrides: Partial<Parameters<typeof GraphStatePreviewNode>[0]> = {},
) {
  const node = buildGraphStatePreviewModel(lfoGraph())
    .nodes.find((candidate) => candidate.id === 'lfo-a')!;
  return renderToStaticMarkup(
    GraphStatePreviewNode({
      node,
      dragging: false,
      connectEnabled: true,
      connectParameterEnabled: true,
      connectActive: false,
      canRemove: true,
      canEdit: true,
      ...overrides,
    }),
  );
}

describe('GraphStatePreview lfo nodes', () => {
  it('renders an lfo node with label and modulator identity', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview graphState={lfoGraph({ label: 'Tremolo' })} onUpdateLfo={vi.fn()} />,
    );
    expect(html).toContain('data-node-type="lfo"');
    expect(html).toContain('xleth-graph-state-preview__node--lfo');
    expect(html).toContain('Tremolo');
    expect(html).toContain('LFO Modulator');
  });

  it('renders the rate/params summary', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={lfoGraph({ rateMode: 'free', rateMs: 80 })}
        onUpdateLfo={vi.fn()}
      />,
    );
    expect(html).toContain('Free 80 ms');
    expect(html).toContain('0 params');
  });

  it('renders the sync rate summary using the division label', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={lfoGraph({ rateMode: 'sync', syncDivision: 8 })}
        onUpdateLfo={vi.fn()}
      />,
    );
    expect(html).toContain('Sync 1/8');
  });

  it('summarizes outgoing lfo parameter connections compactly (edge-count badge)', () => {
    const source = graphState(
      [
        inputNode(),
        lfoNode('lfo-a', {}, { x: 120, y: 140 }),
        effectNode('fx-a', 'Filter', 0, { x: 360, y: 0 }, {
          exposedParameterPorts: [
            { parameterId: 'cutoff', parameterIndexFallback: 0, nameSnapshot: 'Cutoff', labelSnapshot: null, parameterIdIsFallback: false, automatable: true, readOnly: false },
            { parameterId: 'resonance', parameterIndexFallback: 1, nameSnapshot: 'Resonance', labelSnapshot: null, parameterIdIsFallback: false, automatable: true, readOnly: false },
          ],
        }),
        outputNode({ x: 620, y: 0 }),
      ],
      [
        { id: 'pe-a', sourceNodeId: 'lfo-a', sourcePort: 'controlOut', targetNodeId: 'fx-a', targetPort: 'gpp:fx-a:cutoff', type: 'parameter', targetParameter: { parameterId: 'cutoff' } },
        { id: 'pe-b', sourceNodeId: 'lfo-a', sourcePort: 'controlOut', targetNodeId: 'fx-a', targetPort: 'gpp:fx-a:resonance', type: 'parameter', targetParameter: { parameterId: 'resonance' } },
      ],
    );
    const html = renderToStaticMarkup(<GraphStatePreview graphState={source} onUpdateLfo={vi.fn()} />);
    expect(html).toContain('2 params');
    expect(formatLfoParameterCount(1)).toBe('1 param');
  });

  it('renders the compact waveform graph by default', () => {
    const html = renderLfoNodeMarkup({ onLfoUpdate: vi.fn() });
    expect(html).toContain('xleth-graph-state-preview__lfo-shape');
    expect(html).toContain('LFO waveform graph');
  });

  it('exposes a controlOut handle but no audio handles and no parameter input ports', () => {
    const html = renderLfoNodeMarkup({ onLfoUpdate: vi.fn() });
    // LFO is a control source: it has a controlOut, not an audio in handle.
    expect(html).not.toContain('xleth-graph-state-preview__handle--in');
    expect(html).toContain('xleth-graph-state-preview__handle--control-out');
    expect(html).toContain('data-control-output="true"');
    expect(html).toContain('data-control-port-id="lfo:lfo-a:controlOut"');
    expect(html).toContain('data-control-port-type="lfo-output"');
    // It still has no exposed parameter INPUT ports of its own.
    expect(html).not.toContain('data-parameter-port-type');
  });

  it('makes the controlOut a parameter-link drag source only when lfo linking is enabled', () => {
    const lfoNodeModel = buildGraphStatePreviewModel(lfoGraph())
      .nodes.find((candidate) => candidate.id === 'lfo-a')!;
    const linkable = renderToStaticMarkup(GraphStatePreviewNode({
      node: lfoNodeModel,
      dragging: false,
      connectEnabled: false,
      connectParameterEnabled: false,
      connectLfoParameterEnabled: true,
      connectActive: false,
      canRemove: false,
      canEdit: false,
      onConnectPointerDown: vi.fn(),
    }));
    expect(linkable).toContain('data-connect-source="true"');
    expect(linkable).toContain('data-connect-source-kind="lfo"');
    expect(linkable).toContain('xleth-graph-state-preview__handle--connect-parameter-source');

    const staticHtml = renderToStaticMarkup(GraphStatePreviewNode({
      node: lfoNodeModel,
      dragging: false,
      connectEnabled: false,
      connectParameterEnabled: false,
      connectLfoParameterEnabled: false,
      connectActive: false,
      canRemove: false,
      canEdit: false,
    }));
    expect(staticHtml).toContain('data-control-output="true"');
    expect(staticHtml).not.toContain('data-connect-source-kind="lfo"');
    expect(staticHtml).not.toContain('xleth-graph-state-preview__handle--connect-parameter-source');
  });

  it('routes an lfo controlOut pointer-down through the connect handler', () => {
    const lfoNodeModel = buildGraphStatePreviewModel(lfoGraph())
      .nodes.find((candidate) => candidate.id === 'lfo-a')!;
    const onConnectPointerDown = vi.fn();
    const element = GraphStatePreviewNode({
      node: lfoNodeModel,
      dragging: false,
      connectEnabled: false,
      connectParameterEnabled: false,
      connectLfoParameterEnabled: true,
      connectActive: false,
      canRemove: false,
      canEdit: false,
      onConnectPointerDown,
    });
    const handle = findElementByClass(element, 'xleth-graph-state-preview__handle--connect-parameter-source')!;
    expect(handle).toBeTruthy();
    expect(handle.props['data-connect-source-kind']).toBe('lfo');
    expect(handle.props['data-control-port-id']).toBe('lfo:lfo-a:controlOut');
    handle.props.onPointerDown({ button: 0 });
    expect(onConnectPointerDown).toHaveBeenCalledWith({ button: 0 }, lfoNodeModel);
  });

  // Regression lock: an LFO node must stay reachable for deletion — now via the
  // right-click context menu (canOpenContextMenu must include node.type === 'lfo')
  // rather than a node-body Remove button.
  it('stays draggable, with Remove reachable via the context menu (regression lock)', () => {
    const onNodeContextMenu = vi.fn();
    const html = renderLfoNodeMarkup({
      onLfoUpdate: vi.fn(),
      onNodeContextMenu,
      onPointerDown: vi.fn(),
    });
    expect(html).not.toContain('aria-label="Remove LFO"');
    expect(html).toContain('xleth-graph-state-preview__node--draggable');

    const node = buildGraphStatePreviewModel(lfoGraph())
      .nodes.find((candidate) => candidate.id === 'lfo-a')!;
    const element = GraphStatePreviewNode({
      node,
      dragging: false,
      connectEnabled: true,
      connectActive: false,
      onNodeContextMenu,
    });
    expect(element.props.onContextMenu).toBeDefined();
  });

  it('never renders a stray audio input handle on an lfo node', () => {
    // Regression lock for the inbound-handle-suppression fix: LFO nodes must not
    // render the generic audio "in" handle other non-trackInput/non-macro nodes get.
    const html = renderLfoNodeMarkup({ onLfoUpdate: vi.fn() });
    expect(html).not.toContain('xleth-graph-state-preview__handle--in');
  });

  it('defaults to compact layout and keeps the long editor collapsed', () => {
    const editableHtml = renderLfoNodeMarkup({ onLfoUpdate: vi.fn() });
    const readOnlyHtml = renderLfoNodeMarkup({ onLfoUpdate: undefined });
    expect(editableHtml).toContain('LFO compact summary');
    expect(editableHtml).toContain('Edit LFO LFO');
    expect(editableHtml).not.toContain('xleth-graph-state-preview__lfo-editor');
    expect(readOnlyHtml).toContain('xleth-graph-state-preview__lfo-shape');
    expect(readOnlyHtml).toContain('LFO compact summary');
    expect(readOnlyHtml).not.toContain('Edit LFO LFO');
    expect(readOnlyHtml).not.toContain('xleth-graph-state-preview__lfo-editor');
  });

  it('edit toggle: expanded edit mode shows the shape graph, presets, and rate controls', () => {
    const html = renderToStaticMarkup(
      <LfoNodeBody
        nodeId="lfo-a"
        data={readLfoNodeData({})}
        onChange={vi.fn()}
        defaultExpanded
      />,
    );
    expect(html).toContain('xleth-graph-state-preview__lfo-editor');
    expect(html).toContain('Editable LFO waveform graph');
    expect(html).toContain('LFO waveform presets');
    expect(html).toContain('LFO rate mode');
    expect(html).toContain('>Sine<');
    expect(html).toContain('>Triangle<');
    expect(html).toContain('>Square<');
  });

  it('read-only/no-callback mode does not expose editing controls even if expanded is requested', () => {
    const html = renderToStaticMarkup(
      <LfoNodeBody
        nodeId="lfo-a"
        data={readLfoNodeData({})}
        onChange={null}
        defaultExpanded
      />,
    );
    expect(html).toContain('LFO waveform graph');
    expect(html).not.toContain('Editable LFO waveform graph');
    expect(html).not.toContain('xleth-graph-state-preview__lfo-editor');
    expect(html).not.toContain('Edit LFO LFO');
  });

  it('renders Add LFO only when its action is provided', () => {
    const source = graphState([inputNode(), outputNode()], []);
    const editableHtml = renderToStaticMarkup(
      <GraphStatePreview graphState={source} onAddLfoNode={vi.fn()} />,
    );
    const readOnlyHtml = renderToStaticMarkup(<GraphStatePreview graphState={source} />);
    expect(editableHtml).toContain('Add LFO');
    expect(readOnlyHtml).not.toContain('Add LFO');
  });

  it('still renders effect, macro, and envelope nodes alongside lfo nodes', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState(
          [
            inputNode(),
            effectNode('comp', 'Compressor', 0, { x: 240, y: 0 }),
            macroNode('macro-a', 'Drive', 0.5, { x: 240, y: 160 }),
            envelopeNode('env-a', { label: 'Voice Env' }, { x: 240, y: 320 }),
            lfoNode('lfo-a', { label: 'Wobble' }, { x: 240, y: 480 }),
            outputNode({ x: 560, y: 0 }),
          ],
          [],
        )}
        onUpdateEnvelope={vi.fn()}
        onUpdateLfo={vi.fn()}
        onUpdateMacroValue={vi.fn()}
      />,
    );
    expect(html).toContain('data-node-type="effect"');
    expect(html).toContain('data-node-type="macro"');
    expect(html).toContain('data-node-type="envelope"');
    expect(html).toContain('data-node-type="lfo"');
    expect(html).toContain('Compressor');
    expect(html).toContain('Drive');
    expect(html).toContain('Voice Env');
    expect(html).toContain('Wobble');
  });
});

// ---------------------------------------------------------------------------
// FXG-VP.1 — Viewport Zoom and Pan
// ---------------------------------------------------------------------------

// EVC-R4 — the mapping editor is kind-aware: an Envelope edge's modulation mapping gets a
// Base + signed Depth pair, a Macro edge's range mapping keeps the absolute Min/Max output
// range, and the two never appear together (that was the "two unlabelled controls doing the
// same thing" problem).
describe('EVC-R4 ParameterEdgeMappingEditor — modulation vs range', () => {
  const makeModulationEdge = (mapping?: Record<string, unknown>) =>
    makeParameterEdge({
      kind: 'modulation',
      enabled: true,
      base: 0.4,
      depth: 0.5,
      sourceMin: 0,
      sourceMax: 1,
      curve: { type: 'linear' },
      ...mapping,
    });

  const render = (edge: GraphStateEdge, onUpdate = vi.fn()) =>
    renderToStaticMarkup(
      <ParameterEdgeMappingEditor
        edgeId="p-edge"
        edge={edge}
        sourceLabel="Filter Env"
        targetLabel="Filter / Cutoff"
        x={0}
        y={0}
        onUpdate={onUpdate}
        onClose={vi.fn()}
      />,
    );

  it('renders Base and Depth controls for a modulation edge, and no target range', () => {
    const html = render(makeModulationEdge());
    expect(html).toContain('aria-label="Modulation base"');
    expect(html).toContain('aria-label="Modulation depth"');
    expect(html).toContain('>Base<');
    expect(html).toContain('>Depth<');
    expect(html).not.toContain('aria-label="Target min"');
    expect(html).not.toContain('aria-label="Target max"');
    expect(html).not.toContain('Output Range');
  });

  it('renders the target range for a range (Macro) edge, and no base/depth', () => {
    const html = render(makeParameterEdge());
    expect(html).toContain('aria-label="Target min"');
    expect(html).toContain('aria-label="Target max"');
    expect(html).toContain('Output Range');
    expect(html).not.toContain('aria-label="Modulation base"');
    expect(html).not.toContain('aria-label="Modulation depth"');
  });

  it('gives the Depth slider a BIPOLAR -1..1 range so inversion is reachable', () => {
    const html = render(makeModulationEdge({ depth: -0.5 }));
    expect(html).toMatch(/aria-label="Modulation depth"[^>]*/);
    // The depth slider/number inputs are the only ones with min="-1".
    expect(html).toContain('min="-1"');
    // Base stays unipolar.
    expect(html).toMatch(/type="range" min="0" max="1"[^>]*aria-label="Modulation base"/);
  });

  it('explains the model in the editor instead of leaving two bare scales', () => {
    expect(render(makeModulationEdge())).toContain('mapping-editor-hint');
    expect(render(makeParameterEdge())).not.toContain('mapping-editor-hint');
  });

  it("the preview's 0% row is the base value — idle means base, visibly", () => {
    // base 0.4, depth 0.5 -> 40% / 65% / 90%.
    const html = render(makeModulationEdge());
    expect(html).toContain('40%');
    expect(html).toContain('65%');
    expect(html).toContain('90%');
  });

  it('shows a negative depth sweeping downward from base', () => {
    // base 0.8, depth -0.6 -> 80% / 50% / 20%.
    const html = render(makeModulationEdge({ base: 0.8, depth: -0.6 }));
    expect(html).toContain('80%');
    expect(html).toContain('50%');
    expect(html).toContain('20%');
  });

  // Regression lock: the plan's design decision #4 validation found
  // ParameterEdgeMappingEditor is fully generic over mapping.kind === 'modulation'
  // and never inspects the edge's source node type — so an LFO-sourced edge (which
  // also carries a modulation mapping, per connectLfoToParameter) must render
  // identically to an Envelope-sourced one, with no code changes needed. This test
  // exercises that path directly with an LFO source to lock the finding in.
  it('renders identically for an LFO-sourced edge — the editor never inspects source node type', () => {
    const lfoSourcedEdge = {
      ...makeParameterEdge({
        kind: 'modulation',
        enabled: true,
        base: 0.8,
        depth: -0.6,
        sourceMin: 0,
        sourceMax: 1,
        curve: { type: 'linear' },
      }),
      sourceNodeId: 'lfo-a',
      sourcePort: 'controlOut',
    };
    const html = renderToStaticMarkup(
      <ParameterEdgeMappingEditor
        edgeId="p-edge"
        edge={lfoSourcedEdge}
        sourceLabel="Wobble LFO"
        targetLabel="Filter / Cutoff"
        x={0}
        y={0}
        onUpdate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain('Wobble LFO');
    expect(html).toContain('aria-label="Modulation base"');
    expect(html).toContain('aria-label="Modulation depth"');
    expect(html).toContain('>Base<');
    expect(html).toContain('>Depth<');
    expect(html).not.toContain('aria-label="Target min"');
    expect(html).not.toContain('aria-label="Target max"');
    expect(html).not.toContain('Output Range');
    // Same base/depth-anchored preview math as the envelope case (80% / 50% / 20%).
    expect(html).toContain('80%');
    expect(html).toContain('50%');
    expect(html).toContain('20%');
  });

  // The editor's commit contract (patch shape, clamping, kind preservation) is proven at the
  // graphState layer by the EVC-R4 updateParameterEdgeMapping tests: this component renders
  // uncontrolled inputs and forwards { base } / { depth } patches to that helper. Interaction
  // is not simulated here because this suite runs in a node environment with
  // renderToStaticMarkup (no DOM, and the editor holds hooks), matching the FXG.4-g tests
  // above.
});

describe('FXG-VP.1 viewport zoom and pan', () => {
  // ── Zoom controls rendering ────────────────────────────────────────────────

  it('renders zoom controls when onViewportChange is provided', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([inputNode(), outputNode()], [])}
        onViewportChange={vi.fn()}
      />,
    );
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-label="Zoom out"');
    expect(html).toContain('Fit View');
    expect(html).toContain('Reset View');
    expect(html).toContain('xleth-graph-state-preview__zoom-display');
  });

  it('does not render zoom controls when onViewportChange is absent', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([inputNode(), outputNode()], [])}
      />,
    );
    expect(html).not.toContain('aria-label="Zoom in"');
    expect(html).not.toContain('aria-label="Zoom out"');
    expect(html).not.toContain('xleth-graph-state-preview__zoom-display');
  });

  it('displays 100% for default zoom 1', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([inputNode(), outputNode()], [])}
        onViewportChange={vi.fn()}
      />,
    );
    expect(html).toContain('>100%<');
  });

  it('displays the current zoom percentage from graphState.viewport.zoom', () => {
    const gs: GraphStateDocument = {
      schemaVersion: 1,
      trackId: '7',
      nodes: [inputNode(), outputNode()],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1.5 },
    };
    const html = renderToStaticMarkup(
      <GraphStatePreview graphState={gs} onViewportChange={vi.fn()} />,
    );
    expect(html).toContain('>150%<');
  });

  it('rounds fractional zoom to a whole percent', () => {
    const gs: GraphStateDocument = {
      schemaVersion: 1,
      trackId: '7',
      nodes: [inputNode(), outputNode()],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 0.753 },
    };
    const html = renderToStaticMarkup(
      <GraphStatePreview graphState={gs} onViewportChange={vi.fn()} />,
    );
    expect(html).toContain('>75%<');
  });

  // ── Canvas transform ───────────────────────────────────────────────────────

  it('applies scale(1) to canvas transform at default zoom', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([inputNode(), outputNode()], [])}
        onViewportChange={vi.fn()}
      />,
    );
    expect(html).toContain('scale(1)');
  });

  it('applies the viewport zoom to the canvas CSS transform', () => {
    const gs: GraphStateDocument = {
      schemaVersion: 1,
      trackId: '7',
      nodes: [inputNode(), outputNode()],
      edges: [],
      viewport: { x: 10, y: -5, zoom: 0.75 },
    };
    const html = renderToStaticMarkup(
      <GraphStatePreview graphState={gs} onViewportChange={vi.fn()} />,
    );
    expect(html).toContain('scale(0.75)');
    expect(html).toContain('translate(10px');
  });

  it('applies zoom 2 to canvas transform', () => {
    const gs: GraphStateDocument = {
      schemaVersion: 1,
      trackId: '7',
      nodes: [inputNode(), outputNode()],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 2 },
    };
    const html = renderToStaticMarkup(
      <GraphStatePreview graphState={gs} onViewportChange={vi.fn()} />,
    );
    expect(html).toContain('scale(2)');
  });

  // ── Workspace active marker ────────────────────────────────────────────────

  it('marks the section as workspace-active when viewport editing is enabled', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([inputNode(), outputNode()], [])}
        onViewportChange={vi.fn()}
      />,
    );
    expect(html).toContain('data-workspace-active="true"');
  });

  it('does not mark section as workspace-active in read-only mode', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([inputNode(), outputNode()], [])}
      />,
    );
    expect(html).not.toContain('data-workspace-active="true"');
  });

  // ── Pannable state ─────────────────────────────────────────────────────────

  it('marks the viewport as pannable when viewport editing is enabled', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([inputNode(), outputNode()], [])}
        onViewportChange={vi.fn()}
      />,
    );
    expect(html).toContain('data-pannable="true"');
  });

  it('does not mark the viewport as pannable in read-only mode', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([inputNode(), outputNode()], [])}
      />,
    );
    expect(html).not.toContain('data-pannable');
  });

  // ── Read-only mode safety ──────────────────────────────────────────────────

  it('read-only mode renders without crashing when zoom is applied in graphState', () => {
    const gs: GraphStateDocument = {
      schemaVersion: 1,
      trackId: '7',
      nodes: [inputNode(), outputNode()],
      edges: [],
      viewport: { x: -30, y: 20, zoom: 1.8 },
    };
    expect(() => renderToStaticMarkup(<GraphStatePreview graphState={gs} />)).not.toThrow();
  });

  it('read-only with zoom still renders audio cables', () => {
    const gs: GraphStateDocument = {
      schemaVersion: 1,
      trackId: '7',
      nodes: [inputNode(), effectNode('lim', 'Limiter', 0, { x: 260, y: 0 }), outputNode({ x: 520, y: 0 })],
      edges: [audioEdge('e1', 'input', 'lim'), audioEdge('e2', 'lim', 'output')],
      viewport: { x: 0, y: 0, zoom: 0.5 },
    };
    const html = renderToStaticMarkup(<GraphStatePreview graphState={gs} />);
    expect(html).toContain('xleth-graph-state-preview__edge--audio');
    expect(html).toContain('scale(0.5)');
  });

  // ── Node drag delta under zoom ─────────────────────────────────────────────

  it('computeNodeDragPosition converts screen-space delta to graph-space via zoom', () => {
    const drag = { startGraphX: 100, startGraphY: 50, startClientX: 400, startClientY: 300 };
    // At zoom 0.5: 100px screen → 200 graph units
    expect(computeNodeDragPosition(drag, 500, 300, 0.5)).toEqual({ x: 300, y: 50 });
    // At zoom 2.0: 100px screen → 50 graph units
    expect(computeNodeDragPosition(drag, 500, 300, 2.0)).toEqual({ x: 150, y: 50 });
    // At zoom 1.0: 1:1
    expect(computeNodeDragPosition(drag, 550, 350, 1.0)).toEqual({ x: 250, y: 100 });
  });

  // ── Splice-drop cable hit-testing ──────────────────────────────────────────

  describe('splice-drop cable hit-testing', () => {
    // input -> a -> output, all at graph y=0, so both cables are flat
    // horizontal lines in preview space (easy to reason about distances).
    function twoCableGraph(): GraphStateDocument {
      return graphState(
        [inputNode(), effectNode('a', 'A', 0, { x: 260, y: 0 }), outputNode({ x: 520, y: 0 })],
        [audioEdge('e1', 'input', 'a'), audioEdge('e2', 'a', 'output')],
      );
    }

    it('distanceToAudioCableCurve is ~0 on the cable and grows off it', () => {
      const distanceOnLine = distanceToAudioCableCurve({ x: 228, y: 61 }, 172, 61, 284, 61);
      expect(distanceOnLine).toBeCloseTo(0, 5);

      const distanceOff = distanceToAudioCableCurve({ x: 228, y: 91 }, 172, 61, 284, 61);
      expect(distanceOff).toBeCloseTo(30, 5);

      const distanceFar = distanceToAudioCableCurve({ x: 5000, y: 5000 }, 172, 61, 284, 61);
      expect(distanceFar).toBeGreaterThan(1000);
    });

    it('finds the nearest audio cable under a point within the hit radius', () => {
      const model = buildGraphStatePreviewModel(twoCableGraph());

      const onE1 = findAudioCableAtPoint(model.edges, { x: 228, y: 61 });
      expect(onE1?.id).toBe('e1');

      const onE2 = findAudioCableAtPoint(model.edges, { x: 488, y: 61 });
      expect(onE2?.id).toBe('e2');

      const onNeither = findAudioCableAtPoint(model.edges, { x: 5000, y: 5000 });
      expect(onNeither).toBeNull();
    });

    it('respects maxDistance and does not hit-test beyond it', () => {
      const model = buildGraphStatePreviewModel(twoCableGraph());
      // 40px off the cable: found at a generous radius, missed at a tight one.
      const nearMiss = { x: 228, y: 101 };
      expect(findAudioCableAtPoint(model.edges, nearMiss, { maxDistance: 50 })?.id).toBe('e1');
      expect(findAudioCableAtPoint(model.edges, nearMiss, { maxDistance: 5 })).toBeNull();
    });

    it('excludes cables already connected to the dragged node (self-splice guard)', () => {
      const model = buildGraphStatePreviewModel(twoCableGraph());
      // Both e1 and e2 terminate at 'a' — dragging 'a' itself must never
      // resolve a splice target on either of its own cables.
      expect(findAudioCableAtPoint(model.edges, { x: 228, y: 61 }, { excludeNodeId: 'a' })).toBeNull();
      expect(findAudioCableAtPoint(model.edges, { x: 488, y: 61 }, { excludeNodeId: 'a' })).toBeNull();
      // A third node dragged over either cable is unaffected.
      expect(findAudioCableAtPoint(model.edges, { x: 228, y: 61 }, { excludeNodeId: 'other' })?.id).toBe('e1');
    });

    it('ignores non-audio edges', () => {
      const gs: GraphStateDocument = {
        schemaVersion: 1,
        trackId: '7',
        nodes: [
          inputNode(),
          effectNode('a', 'A', 0, { x: 260, y: 0 }, { exposedParameterPorts: [{
            parameterId: 'mix', parameterIndexFallback: 0, nameSnapshot: 'Mix', labelSnapshot: null,
            parameterIdIsFallback: false, automatable: true, readOnly: false,
          }] }),
          { id: 'macro-a', type: 'macro', position: { x: 260, y: 150 }, data: { label: 'Macro 1', normalizedValue: 0.5 } },
        ],
        edges: [{
          id: 'p-1', sourceNodeId: 'macro-a', sourcePort: 'controlOut', targetNodeId: 'a', targetPort: 'param:mix', type: 'parameter',
        }],
      };
      const model = buildGraphStatePreviewModel(gs);
      const parameterEdge = model.edges.find((e) => e.id === 'p-1')!;
      expect(findAudioCableAtPoint(model.edges, { x: parameterEdge.midX, y: parameterEdge.midY })).toBeNull();
    });
  });

  // ── Zoom controls alongside existing toolbar buttons ──────────────────────

  it('keeps Undo, Redo, Add buttons coexisting with zoom controls', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([inputNode(), outputNode()], [])}
        onViewportChange={vi.fn()}
        onAddEffectNode={vi.fn()}
        canUndoGraphEdit={false}
        canRedoGraphEdit={false}
        onUndoGraphEdit={vi.fn()}
        onRedoGraphEdit={vi.fn()}
      />,
    );
    expect(html).toContain('Undo');
    expect(html).toContain('Redo');
    expect(html).toContain('Add Effect Node');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('Fit View');
  });

  // ── Existing "renders view controls" test regression ──────────────────────

  it('view controls include Fit View and Reset View as before', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([inputNode(), outputNode()], [])}
        onViewportChange={vi.fn()}
      />,
    );
    expect(html).toContain('Fit View');
    expect(html).toContain('Reset View');
  });
});

describe('FXG.5 unbounded free node placement', () => {
  // ── No clamp, no snap on the drag path ─────────────────────────────────────

  it('computeNodeDragPosition allows negative graph-space coordinates (no origin wall)', () => {
    const drag = { startGraphX: 20, startGraphY: 20, startClientX: 500, startClientY: 500 };
    // Drag far up-left past the old (0,0) clamp.
    const result = computeNodeDragPosition(drag, 100, 80, 1);
    expect(result).toEqual({ x: -380, y: -400 });
    expect(result.x).toBeLessThan(0);
    expect(result.y).toBeLessThan(0);
  });

  it('computeNodeDragPosition never snaps to a grid — fractional positions survive exactly', () => {
    const drag = { startGraphX: 0, startGraphY: 0, startClientX: 0, startClientY: 0 };
    // 37px at zoom 1 is not a multiple of the old 22-unit snap grid.
    const result = computeNodeDragPosition(drag, 37, -51, 1);
    expect(result).toEqual({ x: 37, y: -51 });
  });

  // ── Model bounds and rendered positions honor negative coordinates ─────────

  it('buildGraphStatePreviewModel bounds reflect true negative minX/minY (not clamped to 0)', () => {
    const model = buildGraphStatePreviewModel(graphState([
      inputNode({ x: -400, y: -300 }),
      outputNode({ x: 200, y: 0 }),
    ], []));

    expect(model.bounds.minX).toBeLessThan(0);
    expect(model.bounds.minY).toBeLessThan(0);
    const input = model.nodes.find((node) => node.id === 'input');
    expect(input?.graphX).toBe(-400);
    expect(input?.graphY).toBe(-300);
    expect(input?.x).toBeLessThan(0);
    expect(input?.y).toBeLessThan(0);
  });

  it('renders a node at negative graph coordinates with a negative left/top style', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode({ x: -500, y: -260 }),
          outputNode({ x: 100, y: 0 }),
        ], [])}
      />,
    );
    expect(html).toMatch(/left:-4\d\d(\.\d+)?px/);
    expect(html).toMatch(/top:-2\d\d(\.\d+)?px/);
  });

  // ── The canvas layer is an unbounded transform anchor, not a sized box ─────

  it('the canvas transform layer carries no width/height — only pan/zoom transform', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([
          inputNode({ x: -900, y: -700 }),
          outputNode({ x: 900, y: 700 }),
        ], [])}
        onViewportChange={vi.fn()}
      />,
    );
    const canvasMatch = html.match(/xleth-graph-state-preview__canvas"[^>]*style="([^"]*)"/);
    expect(canvasMatch).not.toBeNull();
    const canvasStyle = canvasMatch?.[1] ?? '';
    expect(canvasStyle).toContain('transform:');
    expect(canvasStyle).not.toMatch(/width:/);
    expect(canvasStyle).not.toMatch(/height:/);
  });

  // ── Fit View frames negative-coordinate graphs correctly ───────────────────

  it('fitGraphViewport centers a graph that spans negative and positive coordinates', () => {
    const model = buildGraphStatePreviewModel(graphState([
      inputNode({ x: -600, y: -400 }),
      outputNode({ x: 600, y: 400 }),
    ], []));

    const result = fitGraphViewport(model.nodes, { width: 800, height: 600 });
    expect(Number.isFinite(result.x)).toBe(true);
    expect(Number.isFinite(result.y)).toBe(true);
    expect(Number.isFinite(result.zoom)).toBe(true);
    expect(result.zoom).toBeGreaterThan(0);

    // The node bounds' midpoint (graph-space) must land at the container's
    // center once the fitted viewport transform is applied.
    const midGraphX = (model.bounds.minX + model.bounds.maxX) / 2;
    const midGraphY = (model.bounds.minY + model.bounds.maxY) / 2;
    const screenX = midGraphX * result.zoom + result.x;
    const screenY = midGraphY * result.zoom + result.y;
    expect(screenX).toBeCloseTo(400, 0);
    expect(screenY).toBeCloseTo(300, 0);
  });

  it('fitGraphViewport handles a graph entirely in negative coordinates', () => {
    const model = buildGraphStatePreviewModel(graphState([
      inputNode({ x: -800, y: -600 }),
      outputNode({ x: -400, y: -600 }),
    ], []));

    expect(model.bounds.maxX).toBeLessThan(0);
    expect(model.bounds.maxY).toBeLessThan(0);
    const result = fitGraphViewport(model.nodes, { width: 800, height: 600 });
    expect(Number.isFinite(result.x)).toBe(true);
    expect(Number.isFinite(result.y)).toBe(true);
    expect(result.zoom).toBeGreaterThan(0);
  });
});

// FXG-SC.6B — FX Graph Sidechain Input node UI.
function sidechainInputNode(
  id = 'sc',
  data: Record<string, unknown> = { label: 'Sidechain Input', sourceTrackId: 3 },
  position = { x: 0, y: 200 },
): GraphStateNode {
  return { id, type: 'sidechainInput', position, data };
}

function compressorNode(id = 'fx-comp', position = { x: 260, y: 0 }): GraphStateNode {
  return effectNode(id, 'Compressor', 0, position, {
    pluginId: 'compressor',
    effectInstanceId: `${id}-inst`,
    sidechain: { supported: true, channels: 2, enabled: false },
  });
}

function sidechainGraph(
  scData: Record<string, unknown> = { label: 'Sidechain Input', sourceTrackId: 3 },
  extraEdges: GraphStateEdge[] = [],
): GraphStateDocument {
  return graphState(
    [inputNode(), compressorNode(), outputNode({ x: 560, y: 0 }), sidechainInputNode('sc', scData)],
    [audioEdge('e-in', 'input', 'fx-comp'), audioEdge('e-out', 'fx-comp', 'output'), ...extraEdges],
  );
}

const SIDECHAIN_SOURCES = [
  { sourceTrackId: 3, name: 'Kick' },
  { sourceTrackId: 4, name: 'Snare' },
];

describe('GraphStatePreview sidechain input (FXG-SC.6B)', () => {
  it('renders the Sidechain Input node with its label and source selector', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={sidechainGraph()}
        onSetSidechainInputSource={vi.fn()}
        sidechainSources={SIDECHAIN_SOURCES}
      />,
    );
    expect(html).toContain('data-node-type="sidechainInput"');
    expect(html).toContain('xleth-graph-state-preview__node--sidechain-input');
    expect(html).toContain('Sidechain Input');
    expect(html).toContain('xleth-graph-state-preview__sidechain-source-select');
    // Eligible source names appear as options; the selected source (3) is the value.
    expect(html).toContain('Kick');
    expect(html).toContain('Snare');
  });

  it('renders the sidechainOut output handle on the Sidechain Input node', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview graphState={sidechainGraph()} onConnectSidechain={vi.fn()} />,
    );
    expect(html).toContain('data-sidechain-output="true"');
    expect(html).toContain('data-sidechain-port-id="sidechain:sc:sidechainOut"');
    expect(html).toContain('data-connect-source-kind="sidechain"');
  });

  it('renders the sidechainIn port for capability-supported stock and VST effect nodes', () => {
    const compressorHtml = renderToStaticMarkup(
      <GraphStatePreview graphState={sidechainGraph()} onConnectSidechain={vi.fn()} />,
    );
    expect(compressorHtml).toContain('data-sidechain-port-type="sidechain-input"');
    expect(compressorHtml).toContain('data-sidechain-port-id="scp:fx-comp:sidechainIn"');

    const vstGraph = graphState(
      [
        inputNode(),
        effectNode('fx-vst', 'FabFilter Pro-C 2', 0, { x: 260, y: 0 }, {
          pluginId: 'fabfilter.pro-c-2',
          sidechain: { supported: true, channels: 2, enabled: false },
        }),
        outputNode({ x: 560, y: 0 }),
        sidechainInputNode(),
      ],
      [audioEdge('e-in', 'input', 'fx-vst'), audioEdge('e-out', 'fx-vst', 'output')],
    );
    const vstHtml = renderToStaticMarkup(
      <GraphStatePreview graphState={vstGraph} onConnectSidechain={vi.fn()} />,
    );
    expect(vstHtml).toContain('data-sidechain-port-type="sidechain-input"');
    expect(vstHtml).toContain('data-sidechain-port-id="scp:fx-vst:sidechainIn"');
  });

  it('does not render sidechainIn for unsupported VST effect nodes', () => {
    const vstGraph = graphState(
      [
        inputNode(),
        effectNode('fx-vst', 'Unsupported VST', 0, { x: 260, y: 0 }, {
          pluginId: 'unsupported.vst',
          sidechain: { supported: false, channels: 0, enabled: false },
        }),
        outputNode({ x: 560, y: 0 }),
        sidechainInputNode(),
      ],
      [audioEdge('e-in', 'input', 'fx-vst'), audioEdge('e-out', 'fx-vst', 'output')],
    );
    const html = renderToStaticMarkup(
      <GraphStatePreview graphState={vstGraph} onConnectSidechain={vi.fn()} />,
    );
    expect(html).not.toContain('data-sidechain-port-type="sidechain-input"');
  });

  it('does not render an active sidechainIn port on a missing/crashed compressor', () => {
    const broken = graphState(
      [
        inputNode(),
        effectNode('fx-comp', 'Compressor', 0, { x: 260, y: 0 }, { pluginId: 'compressor', missing: true }),
        outputNode({ x: 560, y: 0 }),
        sidechainInputNode(),
      ],
      [audioEdge('e-in', 'input', 'fx-comp'), audioEdge('e-out', 'fx-comp', 'output')],
    );
    const html = renderToStaticMarkup(<GraphStatePreview graphState={broken} onConnectSidechain={vi.fn()} />);
    expect(html).not.toContain('data-sidechain-port-type="sidechain-input"');
  });

  it('renders the Add Sidechain Input toolbar button and disables it when one exists', () => {
    const without = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([inputNode(), compressorNode(), outputNode({ x: 560, y: 0 })], [])}
        onAddSidechainInput={vi.fn()}
      />,
    );
    expect(without).toContain('Add Sidechain Input');
    expect(without).not.toContain('disabled');

    const withNode = renderToStaticMarkup(
      <GraphStatePreview graphState={sidechainGraph()} onAddSidechainInput={vi.fn()} />,
    );
    expect(withNode).toContain('Add Sidechain Input');
    expect(withNode).toContain('disabled');
  });

  it('has no remove button on the protected Sidechain Input node', () => {
    const node = buildGraphStatePreviewModel(sidechainGraph())
      .nodes.find((candidate) => candidate.id === 'sc')!;
    const html = renderToStaticMarkup(
      GraphStatePreviewNode({
        node,
        dragging: false,
        connectEnabled: true,
        connectSidechainEnabled: true,
        connectActive: false,
        canRemove: true,
        canEdit: true,
        onRemove: vi.fn(),
        onConnectPointerDown: vi.fn(),
      }),
    );
    expect(html).not.toContain('aria-label="Remove Sidechain Input"');
    // And no audio in-handle.
    expect(html).not.toContain('xleth-graph-state-preview__handle--in');
  });

  it('invokes the source callback when the selector changes', () => {
    const onSetSidechainSource = vi.fn();
    const node = buildGraphStatePreviewModel(sidechainGraph())
      .nodes.find((candidate) => candidate.id === 'sc')!;
    const element = GraphStatePreviewNode({
      node,
      dragging: false,
      connectEnabled: true,
      connectSidechainEnabled: true,
      connectActive: false,
      canRemove: false,
      canEdit: false,
      sidechainSources: SIDECHAIN_SOURCES,
      onSetSidechainSource,
    });
    const select = findElementByAriaLabel(element, 'Sidechain Input source track');
    expect(select).not.toBeNull();
    select!.props.onChange({ currentTarget: { value: '4' } });
    expect(onSetSidechainSource).toHaveBeenCalledWith('sc', 4);
    select!.props.onChange({ currentTarget: { value: '' } });
    expect(onSetSidechainSource).toHaveBeenCalledWith('sc', null);
  });

  it('resolves and connects a valid sidechain drop target', () => {
    const onConnect = vi.fn();
    const portEl = {
      getAttribute: (name: string) => (name === 'data-sidechain-port-id' ? 'scp:fx-comp:sidechainIn' : null),
      closest: (sel: string) =>
        sel === '[data-node-id]'
          ? { getAttribute: (n: string) => (n === 'data-node-id' ? 'fx-comp' : null) }
          : null,
    };
    const dropEl = {
      closest: (sel: string) =>
        sel.includes('sidechain-port-type') ? portEl : null,
    } as unknown as Element;

    const target = resolveSidechainDropTargetFromElement(dropEl, 'sc');
    expect(target).toEqual({ nodeId: 'fx-comp', portId: 'scp:fx-comp:sidechainIn' });
    expect(connectHighlightedSidechainDropTarget('sc', target, onConnect)).toBe(true);
    expect(onConnect).toHaveBeenCalledWith('sc', 'fx-comp');
  });

  it('does not connect when the sidechain drop misses a sidechain port', () => {
    const onConnect = vi.fn();
    const dropEl = { closest: () => null } as unknown as Element;
    const target = resolveSidechainDropTargetFromElement(dropEl, 'sc');
    expect(target).toBeNull();
    expect(connectHighlightedSidechainDropTarget('sc', target, onConnect)).toBe(false);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('renders a sidechain cable for a persisted sidechain edge', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={sidechainGraph({ label: 'Sidechain Input', sourceTrackId: 3 }, [
          { id: 'sce-1', sourceNodeId: 'sc', sourcePort: 'sidechainOut', targetNodeId: 'fx-comp', targetPort: 'sidechainIn', type: 'sidechain' },
        ])}
        onConnectSidechain={vi.fn()}
        onDisconnectEdge={vi.fn()}
      />,
    );
    expect(html).toContain('data-edge-type="sidechain"');
    expect(html).toContain('xleth-graph-state-preview__edge--sidechain');
  });

  it('shows a stale source option when the saved source is no longer eligible', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={sidechainGraph({ label: 'Sidechain Input', sourceTrackId: 99 })}
        onSetSidechainInputSource={vi.fn()}
        sidechainSources={SIDECHAIN_SOURCES}
      />,
    );
    expect(html).toContain('Track 99 (missing)');
  });

  // FXG-SC.6D — secondary text resolves to track name, not raw id.
  it('shows "Keyed by: <name>" in secondary text when source is in sidechainSources', () => {
    const node = buildGraphStatePreviewModel(
      sidechainGraph({ label: 'Sidechain Input', sourceTrackId: 3 }),
    ).nodes.find((n) => n.id === 'sc')!;
    const html = renderToStaticMarkup(
      GraphStatePreviewNode({
        node,
        dragging: false,
        connectEnabled: false,
        connectActive: false,
        canRemove: false,
        canEdit: false,
        sidechainSources: SIDECHAIN_SOURCES,
      }),
    );
    expect(html).toContain('Keyed by: Kick');
    expect(html).not.toContain('Keyed by track 3');
  });

  it('shows "Source missing" in secondary text when saved source is not in sidechainSources', () => {
    const node = buildGraphStatePreviewModel(
      sidechainGraph({ label: 'Sidechain Input', sourceTrackId: 99 }),
    ).nodes.find((n) => n.id === 'sc')!;
    const html = renderToStaticMarkup(
      GraphStatePreviewNode({
        node,
        dragging: false,
        connectEnabled: false,
        connectActive: false,
        canRemove: false,
        canEdit: false,
        sidechainSources: SIDECHAIN_SOURCES,
      }),
    );
    expect(html).toContain('Source missing');
  });

  it('shows "No source" in secondary text when sourceTrackId is null', () => {
    const node = buildGraphStatePreviewModel(
      sidechainGraph({ label: 'Sidechain Input', sourceTrackId: null }),
    ).nodes.find((n) => n.id === 'sc')!;
    const html = renderToStaticMarkup(
      GraphStatePreviewNode({
        node,
        dragging: false,
        connectEnabled: false,
        connectActive: false,
        canRemove: false,
        canEdit: false,
        sidechainSources: SIDECHAIN_SOURCES,
      }),
    );
    // "No source" appears both in secondary text and in the selector — check at least once.
    expect(html).toContain('No source');
  });

  it('shows resolved track name in the static source span (read-only mode)', () => {
    const node = buildGraphStatePreviewModel(
      sidechainGraph({ label: 'Sidechain Input', sourceTrackId: 3 }),
    ).nodes.find((n) => n.id === 'sc')!;
    const html = renderToStaticMarkup(
      GraphStatePreviewNode({
        node,
        dragging: false,
        connectEnabled: false,
        connectActive: false,
        canRemove: false,
        canEdit: false,
        sidechainSources: SIDECHAIN_SOURCES,
        // onSetSidechainSource is intentionally absent → static span renders.
      }),
    );
    // Should show the track name, not raw 'Track 3'.
    expect(html).toContain('Kick');
    expect(html).not.toContain('>Track 3<');
  });

  it('shows "Track N (missing)" in the static span when the source is stale', () => {
    const node = buildGraphStatePreviewModel(
      sidechainGraph({ label: 'Sidechain Input', sourceTrackId: 99 }),
    ).nodes.find((n) => n.id === 'sc')!;
    const html = renderToStaticMarkup(
      GraphStatePreviewNode({
        node,
        dragging: false,
        connectEnabled: false,
        connectActive: false,
        canRemove: false,
        canEdit: false,
        sidechainSources: SIDECHAIN_SOURCES,
      }),
    );
    expect(html).toContain('Track 99 (missing)');
  });
});

// FXG-connect-reach — port hit areas usable at any zoom: proximity snap on
// connect-drag move/drop (with mandatory compatibility filtering), and
// highlight/dim drag guidance. This test file's vitest environment is plain
// Node (no DOM/jsdom — see vitest.config.ts), so the connect-drag pointer
// handlers themselves aren't exercised end-to-end here (they weren't
// before this change either — see the elementFromPoint-stubbing tests above,
// which cover only the pure resolve*FromElement helpers). These tests take
// the same approach: fake Element-shaped objects exercising the pure,
// exported geometry/compatibility functions the pointer handlers call.
describe('FXG-connect-reach — proximity snap', () => {
  function fakeRectElement(
    cx: number,
    cy: number,
    attributes: Record<string, string | null> = {},
    closestBySelector: Record<string, unknown> = {},
    querySelectorBySelector: Record<string, unknown> = {},
    // Selectors this element should resolve to *itself* for, mirroring how
    // real DOM .closest() matches the starting element when it satisfies the
    // selector (a port row's own compound [data-...-port-type][data-...-id]
    // selector matches the row itself, not just an ancestor).
    selfMatchSelectors: string[] = [],
  ) {
    const el: Record<string, unknown> = {
      getAttribute: (name: string) => attributes[name] ?? null,
      querySelector: (selector: string) => querySelectorBySelector[selector] ?? null,
      getBoundingClientRect: () => ({
        left: cx - 4, top: cy - 4, right: cx + 4, bottom: cy + 4,
        width: 8, height: 8, x: cx - 4, y: cy - 4, toJSON() {},
      }),
    };
    el.closest = (selector: string) =>
      selfMatchSelectors.includes(selector) ? el : (closestBySelector[selector] ?? null);
    return el as unknown as Element;
  }

  function fakeParameterPort(nodeId: string, parameterId: string, cx: number, cy: number) {
    return fakeRectElement(cx, cy, {
      'data-parameter-id': parameterId,
      'data-parameter-port-id': `gpp:${nodeId}:${parameterId}`,
    }, {
      '[data-node-id]': { getAttribute: (n: string) => (n === 'data-node-id' ? nodeId : null) },
    }, {}, ['[data-parameter-port-type="parameter-input"][data-parameter-port-id]']);
  }

  function fakeSidechainPort(nodeId: string, cx: number, cy: number) {
    return fakeRectElement(cx, cy, {
      'data-sidechain-port-id': `scp:${nodeId}:sidechainIn`,
    }, {
      '[data-node-id]': { getAttribute: (n: string) => (n === 'data-node-id' ? nodeId : null) },
    }, {}, ['[data-sidechain-port-type="sidechain-input"][data-sidechain-port-id]']);
  }

  // The real audio-input candidate collected by queryCompatiblePorts IS the
  // `[data-audio-port-type="audio-input"]` handle; resolveAudioDropTargetFromElement
  // walks up to its owning node via closest, then re-queries that node for the
  // same marker (present iff the node type renders `.handle--in` at all).
  function fakeAudioCandidate(nodeId: string, hasAudioInput: boolean, cx: number, cy: number) {
    return fakeRectElement(cx, cy, {}, {
      '[data-node-id]': {
        getAttribute: (n: string) => (n === 'data-node-id' ? nodeId : null),
        querySelector: (sel: string) =>
          (hasAudioInput && sel === '[data-audio-port-type="audio-input"]' ? {} : null),
      },
    });
  }

  it('exposes the documented snap radius', () => {
    expect(CONNECT_SNAP_RADIUS_PX).toBe(24);
  });

  it('findNearestPortWithinRadius returns null when nothing is in range', () => {
    expect(findNearestPortWithinRadius([], { x: 0, y: 0 })).toBeNull();
    expect(findNearestPortWithinRadius([fakeRectElement(1000, 1000)], { x: 0, y: 0 })).toBeNull();
  });

  it('findNearestPortWithinRadius picks the geometrically closer of two in-range candidates', () => {
    const farther = fakeRectElement(10, 0);
    const closer = fakeRectElement(4, 0);
    expect(findNearestPortWithinRadius([farther, closer], { x: 0, y: 0 })).toBe(closer);
    // Order in the candidate list must not matter.
    expect(findNearestPortWithinRadius([closer, farther], { x: 0, y: 0 })).toBe(closer);
  });

  it('findNearestPortWithinRadius respects a custom radius', () => {
    const port = fakeRectElement(20, 0);
    expect(findNearestPortWithinRadius([port], { x: 0, y: 0 }, 10)).toBeNull();
    expect(findNearestPortWithinRadius([port], { x: 0, y: 0 }, 30)).toBe(port);
  });

  it('snaps a macro drop to a compatible parameter port within the radius', () => {
    const target = fakeParameterPort('eq', 'mix', 10, 10);
    const nearest = findNearestPortWithinRadius([target], { x: 0, y: 0 });
    expect(resolveParameterDropTargetFromElement(nearest, 'macro-a')).toEqual({
      nodeId: 'eq',
      parameterId: 'mix',
      portId: 'gpp:eq:mix',
    });
  });

  it('does not connect a parameter drop left outside the snap radius', () => {
    const target = fakeParameterPort('eq', 'mix', 100, 100);
    const nearest = findNearestPortWithinRadius([target], { x: 0, y: 0 });
    expect(nearest).toBeNull();
    expect(resolveParameterDropTargetFromElement(nearest, 'macro-a')).toBeNull();
  });

  it('never snaps a parameter drop onto its own source node, even if geometrically nearest', () => {
    const selfPort = fakeParameterPort('macro-a', 'mix', 5, 5);
    const otherPort = fakeParameterPort('eq', 'mix', 50, 50);
    const nearest = findNearestPortWithinRadius([selfPort, otherPort], { x: 0, y: 0 });
    expect(nearest).toBe(selfPort);
    expect(resolveParameterDropTargetFromElement(nearest, 'macro-a')).toBeNull();
  });

  it('snaps a sidechain drop to the compressor sidechainIn port within the radius', () => {
    const target = fakeSidechainPort('fx-comp', 12, -12);
    const nearest = findNearestPortWithinRadius([target], { x: 0, y: 0 });
    expect(resolveSidechainDropTargetFromElement(nearest, 'sc')).toEqual({
      nodeId: 'fx-comp',
      portId: 'scp:fx-comp:sidechainIn',
    });
  });

  it('does not connect a sidechain drop left outside the snap radius', () => {
    const target = fakeSidechainPort('fx-comp', 500, 500);
    const nearest = findNearestPortWithinRadius([target], { x: 0, y: 0 });
    expect(nearest).toBeNull();
    expect(resolveSidechainDropTargetFromElement(nearest, 'sc')).toBeNull();
  });

  it('snaps an audio drop to a compatible node within the radius', () => {
    const target = fakeAudioCandidate('fx-comp', true, 15, 0);
    const nearest = findNearestPortWithinRadius([target], { x: 0, y: 0 });
    expect(resolveAudioDropTargetFromElement(nearest, 'input')).toBe('fx-comp');
  });

  it('rejects an audio drop snapped to the nearest node when that node has no audio-input handle', () => {
    // A macro node (no audio in-handle) sits closer to the pointer than any
    // real audio target would — compatibility filtering must still reject it.
    const incompatible = fakeAudioCandidate('macro-a', false, 5, 0);
    const nearest = findNearestPortWithinRadius([incompatible], { x: 0, y: 0 });
    expect(nearest).toBe(incompatible);
    expect(resolveAudioDropTargetFromElement(nearest, 'input')).toBeNull();
  });

  it('rejects an audio self-drop even within the snap radius', () => {
    const selfNode = fakeAudioCandidate('fx-comp', true, 2, 0);
    const nearest = findNearestPortWithinRadius([selfNode], { x: 0, y: 0 });
    expect(resolveAudioDropTargetFromElement(nearest, 'fx-comp')).toBeNull();
  });
});

describe('FXG-connect-reach — drag guidance and hit-area wiring', () => {
  function fxCompNode() {
    return buildGraphStatePreviewModel(
      graphState([inputNode(), compressorNode(), outputNode({ x: 560, y: 0 })], []),
    ).nodes.find((candidate) => candidate.id === 'fx-comp')!;
  }

  it('marks the audio in-handle with a stable data attribute for hit-testing', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreview
        graphState={graphState([inputNode(), compressorNode(), outputNode({ x: 560, y: 0 })], [])}
      />,
    );
    expect(html).toContain('data-audio-port-type="audio-input"');
  });

  it('glows a node marked as a valid connect target', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreviewNode
        node={fxCompNode()}
        dragging={false}
        connectEnabled={false}
        connectActive={false}
        connectGuidance="valid"
        canRemove={false}
        canEdit={false}
      />,
    );
    expect(html).toContain('data-connect-guidance="valid"');
    expect(html).toContain('xleth-graph-state-preview__node--connect-valid-target');
    expect(html).not.toContain('xleth-graph-state-preview__node--connect-invalid-target');
  });

  it('dims a node marked as an invalid connect target', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreviewNode
        node={fxCompNode()}
        dragging={false}
        connectEnabled={false}
        connectActive={false}
        connectGuidance="invalid"
        canRemove={false}
        canEdit={false}
      />,
    );
    expect(html).toContain('data-connect-guidance="invalid"');
    expect(html).toContain('xleth-graph-state-preview__node--connect-invalid-target');
    expect(html).not.toContain('xleth-graph-state-preview__node--connect-valid-target');
  });

  it('clears guidance classes outside a connect drag', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreviewNode
        node={fxCompNode()}
        dragging={false}
        connectEnabled={false}
        connectActive={false}
        canRemove={false}
        canEdit={false}
      />,
    );
    expect(html).not.toContain('data-connect-guidance=');
    expect(html).not.toContain('xleth-graph-state-preview__node--connect-valid-target');
    expect(html).not.toContain('xleth-graph-state-preview__node--connect-invalid-target');
  });

  it('highlights the exact hovered audio drop target', () => {
    const html = renderToStaticMarkup(
      <GraphStatePreviewNode
        node={fxCompNode()}
        dragging={false}
        connectEnabled
        connectActive={false}
        hoveredAudioTarget
        canRemove={false}
        canEdit={false}
      />,
    );
    expect(html).toContain('data-audio-drop-node="true"');
    expect(html).toContain('xleth-graph-state-preview__node--audio-drop-target');
  });
});
