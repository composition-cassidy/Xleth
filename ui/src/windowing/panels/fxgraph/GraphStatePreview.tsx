import React from 'react';
import {
  buildExposeParameterMenuGroups,
  describeParamFailure,
  isWritableParameter,
  type GraphEffectParameterDescriptor,
  type GraphParameterResult,
} from './graphParameterUtils';

export interface GraphStateNodePosition {
  x?: unknown;
  y?: unknown;
}

export interface GraphStateNode {
  id: string;
  type: string;
  position?: GraphStateNodePosition;
  data?: Record<string, unknown>;
}

export interface GraphExposedParameterPort {
  parameterId: string;
  parameterIndexFallback: number | null;
  nameSnapshot: string;
  labelSnapshot: string | null;
  parameterIdIsFallback: boolean;
  automatable: boolean | null;
  readOnly: boolean | null;
}

export interface GraphStateEdge {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
  type: string;
  _preservedType?: string;
  // FXG.4-e/f — parameter edges carry the target identity + per-link mapping.
  targetParameter?: { parameterId?: string } | null;
  mapping?: unknown;
}

export interface GraphStateDocument {
  schemaVersion: number;
  trackId: string;
  nodes: GraphStateNode[];
  edges: GraphStateEdge[];
  viewport?: {
    x?: number;
    y?: number;
    zoom?: number;
  };
}

export interface GraphStateViewport {
  x: number;
  y: number;
  zoom?: number;
}

type PreviewNodeKind = 'trackInput' | 'trackOutput' | 'effect' | 'macro' | 'unknown';
type PreviewEdgeKind = 'audio' | 'parameter' | 'unknown';

interface PositionedNode {
  id: string;
  type: PreviewNodeKind;
  label: string;
  secondaryText: string | null;
  metaText: string | null;
  badges: string[];
  effectInstanceId: string | null;
  pluginId: string | null;
  parameterPorts: GraphExposedParameterPort[];
  macroValue: number | null;
  // True only for effect nodes backed by a real (non-placeholder, non-missing)
  // plugin — the heuristic that enables the Edit button. The actual engine-node
  // resolution still happens asynchronously in the panel's edit handler.
  editable: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  graphX: number;
  graphY: number;
  virtual?: boolean;
}

interface PositionedEdge {
  id: string;
  type: PreviewEdgeKind;
  label: string;
  path: string;
  midX: number;
  midY: number;
}

interface PreviewModel {
  empty: boolean;
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  width: number;
  height: number;
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
  };
}

interface PreviewModelOptions {
  warn?: (...args: unknown[]) => void;
  nodePositionOverrides?: Record<string, { x: number; y: number }> | Map<string, { x: number; y: number }>;
}

interface GraphStatePreviewProps {
  graphState?: GraphStateDocument | null;
  notice?: string | null;
  onNodePositionChange?: (nodeId: string, position: { x: number; y: number }) => void;
  onViewportChange?: (viewport: GraphStateViewport) => void;
  onAddEffectNode?: () => void;
  onAddMacroNode?: () => void;
  onRemoveNode?: (nodeId: string) => void;
  onConnectNodes?: (sourceNodeId: string, targetNodeId: string) => void;
  onConnectMacroToParameter?: (macroNodeId: string, targetNodeId: string, parameterId: string) => void;
  onDisconnectEdge?: (edgeId: string) => void;
  onEditNode?: (nodeId: string) => void;
  onUpdateMacroValue?: (nodeId: string, value: number) => void;
  onRenameMacroNode?: (nodeId: string, label: string) => void;
  trackId?: number | string | null;
  fetchGraphEffectParameters?: (
    trackId: number | string,
    effectInstanceId: string,
    options?: { graphNodeId?: string },
  ) => Promise<GraphParameterResult> | GraphParameterResult;
  onToggleParameterPort?: (
    nodeId: string,
    parameter: GraphEffectParameterDescriptor,
  ) => Promise<unknown> | unknown;
  canUndoGraphEdit?: boolean;
  canRedoGraphEdit?: boolean;
  onUndoGraphEdit?: () => void;
  onRedoGraphEdit?: () => void;
}

const NODE_WIDTH = 148;
const NODE_HEIGHT = 74;
const PARAMETER_PORT_ROW_HEIGHT = 18;
const PREVIEW_PADDING_X = 24;
const PREVIEW_PADDING_Y = 24;
const HANDLE_OUTSET = 8;
const FALLBACK_NODE_SPACING_X = 204;
const FALLBACK_NODE_Y = 0;
const MIN_CANVAS_WIDTH = 460;
const MIN_CANVAS_HEIGHT = 240;
const DEFAULT_VIEWPORT: GraphStateViewport = Object.freeze({ x: 0, y: 0, zoom: 1 });

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(data: Record<string, unknown> | undefined, key: string) {
  const value = data?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : '';
}

function readBoolean(data: Record<string, unknown> | undefined, key: string) {
  return data?.[key] === true;
}

function readInteger(data: Record<string, unknown> | undefined, key: string) {
  const value = data?.[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function readNormalizedValue(data: Record<string, unknown> | undefined, key: string) {
  const value = data?.[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

function readExposedParameterPorts(data: Record<string, unknown> | undefined): GraphExposedParameterPort[] {
  const rawPorts = data?.exposedParameterPorts;
  if (!Array.isArray(rawPorts)) return [];
  const seen = new Set<string>();
  const ports: GraphExposedParameterPort[] = [];
  for (const rawPort of rawPorts) {
    if (rawPort == null || typeof rawPort !== 'object' || Array.isArray(rawPort)) continue;
    const port = rawPort as Record<string, unknown>;
    const parameterId = typeof port.parameterId === 'string' ? port.parameterId.trim() : '';
    if (!parameterId || seen.has(parameterId)) continue;
    seen.add(parameterId);
    const nameSnapshot = typeof port.nameSnapshot === 'string' && port.nameSnapshot.trim().length > 0
      ? port.nameSnapshot.trim()
      : parameterId;
    const labelSnapshot = typeof port.labelSnapshot === 'string' && port.labelSnapshot.trim().length > 0
      ? port.labelSnapshot.trim()
      : null;
    // Read parameterIndexFallback first (FXG.4-c), fall back to parameterIndex (FXG.4-b).
    const rawIndex = port.parameterIndexFallback ?? port.parameterIndex;
    ports.push({
      parameterId,
      parameterIndexFallback: Number.isInteger(rawIndex) && (rawIndex as number) >= 0
        ? rawIndex as number
        : null,
      nameSnapshot,
      labelSnapshot,
      parameterIdIsFallback: port.parameterIdIsFallback === true,
      automatable: typeof port.automatable === 'boolean' ? port.automatable : null,
      readOnly: typeof port.readOnly === 'boolean' ? port.readOnly : null,
    });
  }
  return ports;
}

function resolvePreviewNodeType(type: string): PreviewNodeKind {
  if (type === 'trackInput' || type === 'trackOutput' || type === 'effect' || type === 'macro') {
    return type;
  }
  return 'unknown';
}

function fallbackNodeRank(node: GraphStateNode) {
  if (node.type === 'trackInput') return 0;
  if (node.type === 'trackOutput') return 2;
  return 1;
}

function fallbackNodeOrder(nodes: GraphStateNode[]) {
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const rankDelta = fallbackNodeRank(a.node) - fallbackNodeRank(b.node);
      if (rankDelta !== 0) return rankDelta;

      const aSlot = readInteger(a.node.data, 'sourceChainSlotIndex');
      const bSlot = readInteger(b.node.data, 'sourceChainSlotIndex');
      if (aSlot != null && bSlot != null && aSlot !== bSlot) return aSlot - bSlot;
      if (aSlot != null && bSlot == null) return -1;
      if (aSlot == null && bSlot != null) return 1;

      return a.index - b.index;
    })
    .map((entry) => entry.node);
}

function hasValidPosition(node: GraphStateNode) {
  return isFiniteNumber(node.position?.x) && isFiniteNumber(node.position?.y);
}

function readPositionOverride(
  overrides: PreviewModelOptions['nodePositionOverrides'] | undefined,
  nodeId: string,
) {
  const override = overrides instanceof Map ? overrides.get(nodeId) : overrides?.[nodeId];
  if (!override || !isFiniteNumber(override.x) || !isFiniteNumber(override.y)) return null;
  return { x: override.x, y: override.y };
}

function resolveNodeText(node: GraphStateNode) {
  const type = resolvePreviewNodeType(node.type);
  const data = node.data;

  if (type === 'trackInput') {
    return {
      label: 'Track Input',
      secondaryText: null,
      metaText: null,
      badges: [] as string[],
      effectInstanceId: null,
      pluginId: null,
      parameterPorts: [] as GraphExposedParameterPort[],
      macroValue: null,
      editable: false,
    };
  }

  if (type === 'trackOutput') {
    return {
      label: 'Track Output',
      secondaryText: null,
      metaText: null,
      badges: [] as string[],
      effectInstanceId: null,
      pluginId: null,
      parameterPorts: [] as GraphExposedParameterPort[],
      macroValue: null,
      editable: false,
    };
  }

  if (type === 'effect') {
    const displayName = readString(data, 'displayName') || 'Effect';
    const pluginId = readString(data, 'pluginId');
    const sourceSlot = readInteger(data, 'sourceChainSlotIndex');
    const effectInstanceId = readString(data, 'effectInstanceId');
    const missing = readBoolean(data, 'missing');
    const badges: string[] = [];

    if (readBoolean(data, 'bypass')) badges.push('Bypassed');
    if (missing) badges.push('Missing');
    if (readBoolean(data, 'crashed')) badges.push('Crashed');

    return {
      label: displayName,
      secondaryText: pluginId && pluginId !== displayName ? pluginId : null,
      metaText: sourceSlot == null ? null : `Chain slot ${sourceSlot + 1}`,
      badges,
      effectInstanceId,
      pluginId,
      parameterPorts: readExposedParameterPorts(data),
      macroValue: null,
      // Placeholder / data-only / missing nodes have no engine processor to open.
      editable: pluginId.length > 0 && pluginId !== 'placeholder' && !missing,
    };
  }

  if (type === 'macro') {
    return {
      label: readString(data, 'label') || readString(data, 'name') || 'Macro',
      secondaryText: 'Control source',
      metaText: null,
      badges: [] as string[],
      effectInstanceId: null,
      pluginId: null,
      parameterPorts: [] as GraphExposedParameterPort[],
      macroValue: readNormalizedValue(data, 'normalizedValue'),
      editable: false,
    };
  }

  const preservedData = isPlainObject(data?._preservedData)
    ? data?._preservedData
    : undefined;
  const preservedType = readString(data, '_preservedType') || node.type;
  const displayName = readString(preservedData, 'displayName') ||
    readString(preservedData, 'name') ||
    'Unknown Node';

  return {
    label: displayName,
    secondaryText: preservedType
      ? `Unsupported node type: ${preservedType}`
      : 'Unsupported node type',
    metaText: null,
    badges: ['Unknown'],
    effectInstanceId: null,
    pluginId: null,
    parameterPorts: [] as GraphExposedParameterPort[],
    macroValue: null,
    editable: false,
  };
}

function makeVirtualAnchorNode(
  id: string,
  type: 'trackInput' | 'trackOutput',
  x: number,
): PositionedNode {
  const text = resolveNodeText({ id, type });
  return {
    id,
    type,
    ...text,
    x,
    y: FALLBACK_NODE_Y,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    graphX: x - PREVIEW_PADDING_X,
    graphY: FALLBACK_NODE_Y,
    virtual: true,
  };
}

function nodeHeightForPorts(portCount: number) {
  return NODE_HEIGHT + Math.max(0, portCount) * PARAMETER_PORT_ROW_HEIGHT;
}

function nodeHeightForText(text: ReturnType<typeof resolveNodeText>) {
  return nodeHeightForPorts(text.parameterPorts.length) + (text.macroValue == null ? 0 : 38);
}

function normalizePositionedNodes(nodes: GraphStateNode[], options: PreviewModelOptions = {}) {
  if (nodes.length === 0) {
    return [
      makeVirtualAnchorNode('preview-empty-track-input', 'trackInput', PREVIEW_PADDING_X),
      makeVirtualAnchorNode(
        'preview-empty-track-output',
        'trackOutput',
        PREVIEW_PADDING_X + FALLBACK_NODE_SPACING_X,
      ),
    ];
  }

  const allNodesHavePositions = nodes.every(hasValidPosition);
  const layoutNodes = allNodesHavePositions ? nodes : fallbackNodeOrder(nodes);
  const rawPositions = layoutNodes.map((node, index) => {
    const override = readPositionOverride(options.nodePositionOverrides, node.id);
    if (override) {
      return {
        id: node.id,
        x: override.x,
        y: override.y,
      };
    }

    if (allNodesHavePositions && hasValidPosition(node)) {
      return {
        id: node.id,
        x: node.position.x as number,
        y: node.position.y as number,
      };
    }

    return {
      id: node.id,
      x: index * FALLBACK_NODE_SPACING_X,
      y: FALLBACK_NODE_Y,
    };
  });

  const positionById = new Map(rawPositions.map((position) => [position.id, position]));

  return layoutNodes.map((node) => {
    const position = positionById.get(node.id) ?? { x: 0, y: 0 };
    const text = resolveNodeText(node);
    return {
      id: node.id,
      type: resolvePreviewNodeType(node.type),
      ...text,
      x: position.x + PREVIEW_PADDING_X,
      y: position.y + PREVIEW_PADDING_Y,
      width: NODE_WIDTH,
      height: nodeHeightForText(text),
      graphX: position.x,
      graphY: position.y,
    };
  });
}

function edgeEndpoints(source: PositionedNode, target: PositionedNode) {
  return {
    sourceX: source.type === 'trackOutput' ? source.x : source.x + source.width,
    sourceY: source.y + source.height / 2,
    targetX: target.type === 'trackInput' ? target.x + target.width : target.x,
    targetY: target.y + target.height / 2,
  };
}

function nodeOutPoint(node: PositionedNode) {
  return { x: node.x + node.width, y: node.y + node.height / 2 };
}

function makeCurvePath(sourceX: number, sourceY: number, targetX: number, targetY: number) {
  const midpointX = sourceX + (targetX - sourceX) / 2;
  return [
    `M ${sourceX} ${sourceY}`,
    `C ${midpointX} ${sourceY}, ${midpointX} ${targetY}, ${targetX} ${targetY}`,
  ].join(' ');
}

function makeEdgePath(source: PositionedNode, target: PositionedNode) {
  const { sourceX, sourceY, targetX, targetY } = edgeEndpoints(source, target);
  return makeCurvePath(sourceX, sourceY, targetX, targetY);
}

// FXG.4-e/f — parameter edges land on a specific exposed parameter input port. The
// ports render in a stack at the bottom of the target node, so the anchor is
// approximated from the node's bottom edge using the port row height. Falls back to
// the node's left-middle when the parameter is not (or no longer) exposed.
function parameterPortAnchor(node: PositionedNode, parameterId: string | null) {
  const ports = node.parameterPorts;
  const count = ports.length;
  const index = parameterId ? ports.findIndex((port) => port.parameterId === parameterId) : -1;
  if (count === 0 || index < 0) {
    return { x: node.x, y: node.y + node.height / 2 };
  }
  const bottomPadding = 10;
  const portsBottom = node.y + node.height - bottomPadding;
  const y = portsBottom - (count - index - 0.5) * PARAMETER_PORT_ROW_HEIGHT;
  return { x: node.x, y };
}

function readEdgeParameterId(edge: GraphStateEdge, targetNodeId: string): string | null {
  const fromTarget = edge.targetParameter?.parameterId;
  if (typeof fromTarget === 'string' && fromTarget.length > 0) return fromTarget;
  const port = edge.targetPort;
  const prefix = `gpp:${targetNodeId}:`;
  if (typeof port === 'string' && port.startsWith(prefix)) {
    const id = port.slice(prefix.length);
    return id.length > 0 ? id : null;
  }
  return null;
}

function normalizePositionedEdges(
  edges: GraphStateEdge[],
  nodes: PositionedNode[],
  options: PreviewModelOptions,
) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const warn = options.warn ?? console.warn;
  const positionedEdges: PositionedEdge[] = [];

  for (const edge of edges) {
    const source = nodeById.get(edge.sourceNodeId);
    const target = nodeById.get(edge.targetNodeId);

    if (!source || !target) {
      warn?.('[FXG] graphState preview skipped edge with missing node reference', {
        edgeId: edge.id,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
      });
      continue;
    }

    if (edge.type === 'parameter') {
      const parameterId = readEdgeParameterId(edge, target.id);
      const start = nodeOutPoint(source);
      const end = parameterPortAnchor(target, parameterId);
      positionedEdges.push({
        id: edge.id,
        type: 'parameter',
        label: parameterId
          ? `Macro link: ${source.label} to ${target.label} ${parameterId}`
          : `Macro link: ${source.label} to ${target.label}`,
        path: makeCurvePath(start.x, start.y, end.x, end.y),
        midX: (start.x + end.x) / 2,
        midY: (start.y + end.y) / 2,
      });
      continue;
    }

    const type: PreviewEdgeKind = edge.type === 'audio' ? 'audio' : 'unknown';
    const preservedType = edge._preservedType || edge.type;
    const { sourceX, sourceY, targetX, targetY } = edgeEndpoints(source, target);
    positionedEdges.push({
      id: edge.id,
      type,
      label: type === 'audio'
        ? `Audio cable: ${source.label} to ${target.label}`
        : `Unsupported edge: ${preservedType}`,
      path: makeEdgePath(source, target),
      midX: (sourceX + targetX) / 2,
      midY: (sourceY + targetY) / 2,
    });
  }

  return positionedEdges;
}

export function buildGraphStatePreviewModel(
  graphState?: GraphStateDocument | null,
  options: PreviewModelOptions = {},
): PreviewModel {
  const sourceNodes = Array.isArray(graphState?.nodes) ? graphState.nodes : [];
  const sourceEdges = Array.isArray(graphState?.edges) ? graphState.edges : [];
  const nodes = normalizePositionedNodes(sourceNodes, options);
  const edges = sourceNodes.length === 0
    ? []
    : normalizePositionedEdges(sourceEdges, nodes, options);
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  const bounds = {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };

  return {
    empty: sourceNodes.length === 0 && sourceEdges.length === 0,
    nodes,
    edges,
    width: Math.ceil(Math.max(maxX + PREVIEW_PADDING_X + HANDLE_OUTSET, MIN_CANVAS_WIDTH)),
    height: Math.ceil(Math.max(maxY + PREVIEW_PADDING_Y, MIN_CANVAS_HEIGHT)),
    bounds,
  };
}

function normalizeViewport(viewport?: GraphStateDocument['viewport'] | null): GraphStateViewport {
  return {
    x: isFiniteNumber(viewport?.x) ? viewport.x : DEFAULT_VIEWPORT.x,
    y: isFiniteNumber(viewport?.y) ? viewport.y : DEFAULT_VIEWPORT.y,
    zoom: isFiniteNumber(viewport?.zoom) && viewport.zoom > 0 ? viewport.zoom : DEFAULT_VIEWPORT.zoom,
  };
}

function roundViewport(value: number) {
  return Math.round(value * 100) / 100;
}

export function GraphStatePreviewNode({
  node,
  dragging,
  connectEnabled,
  connectParameterEnabled = false,
  connectActive,
  canRemove,
  canEdit,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onConnectPointerDown,
  onConnectPointerMove,
  onConnectPointerUp,
  onConnectPointerCancel,
  onNodeContextMenu,
  onRemove,
  onEdit,
  onMacroValueCommit,
  onMacroRenameCommit,
}: {
  node: PositionedNode;
  dragging: boolean;
  connectEnabled: boolean;
  connectParameterEnabled?: boolean;
  connectActive: boolean;
  canRemove: boolean;
  canEdit: boolean;
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>, node: PositionedNode) => void;
  onPointerMove?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onConnectPointerDown?: (event: React.PointerEvent<HTMLSpanElement>, node: PositionedNode) => void;
  onConnectPointerMove?: (event: React.PointerEvent<HTMLSpanElement>) => void;
  onConnectPointerUp?: (event: React.PointerEvent<HTMLSpanElement>) => void;
  onConnectPointerCancel?: (event: React.PointerEvent<HTMLSpanElement>) => void;
  onNodeContextMenu?: (event: React.MouseEvent<HTMLDivElement>, node: PositionedNode) => void;
  onRemove?: (nodeId: string) => void;
  onEdit?: (nodeId: string) => void;
  onMacroValueCommit?: (nodeId: string, value: number) => void;
  onMacroRenameCommit?: (nodeId: string, label: string) => void;
}) {
  const classType = node.type === 'trackInput'
    ? 'track-input'
    : node.type === 'trackOutput'
      ? 'track-output'
      : node.type;
  const isMacro = node.type === 'macro';
  const style: React.CSSProperties = {
    left: node.x,
    top: node.y,
    width: node.width,
    minHeight: node.height,
  };
  // Audio sources (effect/trackInput) drag from the out handle to create audio
  // edges. Macro controlOut drags to an exposed parameter port to create a
  // parameter edge — a separate, gated affordance.
  const interactiveAudioOut =
    connectEnabled && !isMacro && !node.virtual && typeof onConnectPointerDown === 'function';
  const interactiveMacroOut =
    connectParameterEnabled && isMacro && !node.virtual && typeof onConnectPointerDown === 'function';
  const interactiveOut = interactiveAudioOut || interactiveMacroOut;
  const showRemove =
    canRemove && (node.type === 'effect' || node.type === 'macro') && !node.virtual && typeof onRemove === 'function';
  // Edit appears on every real effect node; placeholder/data-only nodes show a
  // disabled "not active yet" state so the affordance is discoverable but inert.
  const showEdit =
    canEdit && node.type === 'effect' && !node.virtual && typeof onEdit === 'function';
  const canOpenContextMenu =
    node.type === 'effect' && !node.virtual && typeof onNodeContextMenu === 'function';
  const macroPercent = node.macroValue == null ? null : Math.round(node.macroValue * 100);
  const commitMacroValue = (event: React.SyntheticEvent<HTMLInputElement>) => {
    const nextValue = Number(event.currentTarget.value);
    if (Number.isFinite(nextValue)) onMacroValueCommit?.(node.id, nextValue);
  };
  const commitMacroLabel = (event: React.SyntheticEvent<HTMLInputElement>) => {
    onMacroRenameCommit?.(node.id, event.currentTarget.value);
  };

  return (
    <div
      className={[
        'xleth-graph-state-preview__node',
        `xleth-graph-state-preview__node--${classType}`,
        onPointerDown ? 'xleth-graph-state-preview__node--draggable' : '',
        dragging ? 'xleth-graph-state-preview__node--dragging' : '',
        connectActive ? 'xleth-graph-state-preview__node--connect-source' : '',
      ].filter(Boolean).join(' ')}
      data-node-id={node.id}
      data-node-type={node.type}
      data-preview-virtual={node.virtual ? 'true' : undefined}
      role="listitem"
      aria-label={node.label}
      aria-grabbed={onPointerDown ? dragging : undefined}
      style={style}
      onPointerDown={onPointerDown ? (event) => onPointerDown(event, node) : undefined}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={canOpenContextMenu ? (event) => onNodeContextMenu?.(event, node) : undefined}
    >
      {node.type !== 'trackInput' && node.type !== 'macro' && (
        <span
          className="xleth-graph-state-preview__handle xleth-graph-state-preview__handle--in"
          aria-hidden="true"
        />
      )}
      {node.type !== 'trackOutput' && (
        interactiveOut ? (
          <span
            className={[
              'xleth-graph-state-preview__handle',
              'xleth-graph-state-preview__handle--out',
              'xleth-graph-state-preview__handle--connect-source',
              isMacro ? 'xleth-graph-state-preview__handle--control-out' : '',
              isMacro ? 'xleth-graph-state-preview__handle--connect-parameter-source' : '',
            ].filter(Boolean).join(' ')}
            data-connect-source="true"
            data-connect-source-kind={isMacro ? 'macro' : 'audio'}
            data-control-output={isMacro ? 'true' : undefined}
            data-control-port-id={isMacro ? `macro:${node.id}:controlOut` : undefined}
            data-control-port-type={isMacro ? 'macro-output' : undefined}
            aria-label={isMacro
              ? `Link ${node.label} to a parameter port`
              : `Start a connection from ${node.label}`}
            onPointerDown={(event) => onConnectPointerDown?.(event, node)}
            onPointerMove={onConnectPointerMove}
            onPointerUp={onConnectPointerUp}
            onPointerCancel={onConnectPointerCancel}
          />
        ) : (
          <span
            className={[
              'xleth-graph-state-preview__handle',
              'xleth-graph-state-preview__handle--out',
              isMacro ? 'xleth-graph-state-preview__handle--control-out' : '',
            ].filter(Boolean).join(' ')}
            data-control-output={isMacro ? 'true' : undefined}
            data-control-port-id={isMacro ? `macro:${node.id}:controlOut` : undefined}
            data-control-port-type={isMacro ? 'macro-output' : undefined}
            aria-hidden="true"
          />
        )
      )}
      {node.type === 'macro' && typeof onMacroRenameCommit === 'function' ? (
        <input
          className="xleth-graph-state-preview__macro-label"
          type="text"
          aria-label={`Rename ${node.label}`}
          defaultValue={node.label}
          onPointerDown={(event) => event.stopPropagation()}
          onBlur={commitMacroLabel}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              event.currentTarget.value = node.label;
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <span className="xleth-graph-state-preview__node-title">{node.label}</span>
      )}
      {node.secondaryText && (
        <span className="xleth-graph-state-preview__node-secondary">{node.secondaryText}</span>
      )}
      {node.type === 'macro' && node.macroValue != null && (
        <span className="xleth-graph-state-preview__macro-control">
          <span className="xleth-graph-state-preview__macro-value">
            {macroPercent}%
          </span>
          <input
            className="xleth-graph-state-preview__macro-slider"
            type="range"
            min="0"
            max="1"
            step="0.01"
            defaultValue={node.macroValue}
            aria-label={`${node.label} macro value`}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={commitMacroValue}
            onBlur={commitMacroValue}
            onKeyUp={(event) => {
              if (
                event.key === 'Enter' ||
                event.key.startsWith('Arrow') ||
                event.key === 'Home' ||
                event.key === 'End'
              ) {
                commitMacroValue(event);
              }
            }}
          />
        </span>
      )}
      {node.metaText && (
        <span className="xleth-graph-state-preview__node-meta">{node.metaText}</span>
      )}
      {node.badges.length > 0 && (
        <span className="xleth-graph-state-preview__badges">
          {node.badges.map((badge) => (
            <span className="xleth-graph-state-preview__badge" key={badge}>
              {badge}
            </span>
          ))}
        </span>
      )}
      {node.parameterPorts.length > 0 && (
        <span className="xleth-graph-state-preview__parameter-ports" role="list" aria-label={`${node.label} parameter inputs`}>
          {node.parameterPorts.map((port) => (
            <span
              className="xleth-graph-state-preview__parameter-port"
              role="listitem"
              key={port.parameterId}
              title={port.nameSnapshot}
              data-parameter-port-id={`gpp:${node.id}:${port.parameterId}`}
              data-parameter-id={port.parameterId}
              data-parameter-port-type="parameter-input"
            >
              <span className="xleth-graph-state-preview__parameter-port-dot" aria-hidden="true" />
              <span className="xleth-graph-state-preview__parameter-port-label">
                {port.nameSnapshot}
              </span>
            </span>
          ))}
        </span>
      )}
      {(showEdit || showRemove) && (
        <span className="xleth-graph-state-preview__node-actions">
          {showEdit && (
            <button
              className="xleth-graph-state-preview__node-edit"
              type="button"
              disabled={!node.editable}
              data-active={node.editable ? 'true' : undefined}
              aria-label={node.editable ? `Edit ${node.label}` : `${node.label} is not active yet`}
              title={node.editable ? 'Open effect editor' : 'Effect is not active yet'}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                if (node.editable) onEdit?.(node.id);
              }}
            >
              Edit
            </button>
          )}
          {showRemove && (
            <button
              className="xleth-graph-state-preview__node-remove"
              type="button"
              aria-label={`Remove ${node.label}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onRemove?.(node.id);
              }}
            >
              Remove
            </button>
          )}
        </span>
      )}
    </div>
  );
}

export function filterExposeParameterDescriptors(
  parameters: GraphEffectParameterDescriptor[],
  search: string,
) {
  const needle = search.trim().toLowerCase();
  if (!needle) return parameters;
  return parameters.filter((parameter) => {
    const label = parameter.name || parameter.parameterId;
    return `${label} ${parameter.parameterId}`.toLowerCase().includes(needle);
  });
}

export function GraphParameterContextMenu({
  node,
  x,
  y,
  loading = false,
  result = null,
  search = '',
  canEdit,
  canRemove,
  onSearchChange,
  onToggleParameter,
  onEdit,
  onRemove,
}: {
  node: PositionedNode;
  x: number;
  y: number;
  loading?: boolean;
  result?: GraphParameterResult | null;
  search?: string;
  canEdit: boolean;
  canRemove: boolean;
  onSearchChange?: (value: string) => void;
  onToggleParameter?: (parameter: GraphEffectParameterDescriptor) => void;
  onEdit?: () => void;
  onRemove?: () => void;
}) {
  const parameters = result?.ok ? result.parameters ?? [] : [];
  const parameterGroups = buildExposeParameterMenuGroups(parameters, {
    pluginId: node.pluginId,
    effectKind: result?.effectKind,
    pluginFormat: result?.pluginFormat,
    resultPluginId: result?.pluginId,
  }, search);
  const visibleParameterCount = parameterGroups.reduce(
    (count, group) => count + group.parameters.length,
    0,
  );
  const exposedIds = new Set(node.parameterPorts.map((port) => port.parameterId));
  const showSearch = visibleParameterCount > 0 || search.length > 0;

  return (
    <div
      className="xleth-graph-state-preview__context-menu"
      role="menu"
      aria-label={`${node.label} node menu`}
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="xleth-graph-state-preview__context-title">{node.label}</div>
      <button
        className="xleth-graph-state-preview__context-item"
        type="button"
        role="menuitem"
        disabled={!canEdit || !node.editable}
        onClick={onEdit}
      >
        Edit
      </button>
      <button
        className="xleth-graph-state-preview__context-item"
        type="button"
        role="menuitem"
        disabled={!canRemove}
        onClick={onRemove}
      >
        Remove
      </button>

      <div className="xleth-graph-state-preview__context-section">
        <div className="xleth-graph-state-preview__context-section-title">
          Expose Parameter
        </div>
        {showSearch && (
          <input
            className="xleth-graph-state-preview__parameter-search"
            type="search"
            aria-label="Search parameters"
            placeholder="Search parameters"
            value={search}
            onChange={(event) => onSearchChange?.(event.target.value)}
          />
        )}
        {loading && (
          <div className="xleth-graph-state-preview__context-empty" role="status">
            Loading parameters...
          </div>
        )}
        {!loading && result?.ok === false && (
          <div className="xleth-graph-state-preview__context-empty" role="alert">
            {describeParamFailure(result.reason)}
          </div>
        )}
        {!loading && result?.ok && visibleParameterCount === 0 && search.length === 0 && (
          <div className="xleth-graph-state-preview__context-empty">
            This effect exposes no parameters.
          </div>
        )}
        {!loading && result?.ok && visibleParameterCount === 0 && search.length > 0 && (
          <div className="xleth-graph-state-preview__context-empty">
            No parameters match.
          </div>
        )}
        {!loading && result?.ok && visibleParameterCount > 0 && (
          <div className="xleth-graph-state-preview__parameter-list" role="group" aria-label="Exposed Parameters">
            {parameterGroups.map((group) => (
              <div
                className="xleth-graph-state-preview__parameter-group"
                role="group"
                aria-label={group.groupLabel ?? 'Parameters'}
                key={group.groupLabel ?? 'parameters'}
              >
                {group.groupLabel && (
                  <div className="xleth-graph-state-preview__parameter-group-title">
                    {group.groupLabel}
                  </div>
                )}
                {group.parameters.map((item) => {
                  const parameter = item.parameter;
                  const writable = isWritableParameter(parameter);
                  const exposed = exposedIds.has(parameter.parameterId);
                  return (
                    <button
                      className={`xleth-graph-state-preview__parameter-item${exposed ? ' xleth-graph-state-preview__parameter-item--exposed' : ''}`}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={exposed}
                      disabled={!writable}
                      key={parameter.parameterId}
                      title={parameter.name || item.label}
                      onClick={() => onToggleParameter?.(parameter)}
                    >
                      <span className="xleth-graph-state-preview__parameter-check" aria-hidden="true">
                        {exposed ? 'On' : ''}
                      </span>
                      <span className="xleth-graph-state-preview__parameter-name">
                        {item.label}
                      </span>
                      {!writable && (
                        <span className="xleth-graph-state-preview__parameter-state">
                          Read-only
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function GraphStatePreview({
  graphState = null,
  notice = 'Persisted graphState. Linear routing is enabled for supported paths.',
  onNodePositionChange,
  onViewportChange,
  onAddEffectNode,
  onAddMacroNode,
  onRemoveNode,
  onConnectNodes,
  onConnectMacroToParameter,
  onDisconnectEdge,
  onEditNode,
  onUpdateMacroValue,
  onRenameMacroNode,
  trackId = null,
  fetchGraphEffectParameters,
  onToggleParameterPort,
  canUndoGraphEdit = false,
  canRedoGraphEdit = false,
  onUndoGraphEdit,
  onRedoGraphEdit,
}: GraphStatePreviewProps) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLDivElement | null>(null);
  const dragRef = React.useRef<{
    pointerId: number;
    nodeId: string;
    startClientX: number;
    startClientY: number;
    startGraphX: number;
    startGraphY: number;
    currentGraphX: number;
    currentGraphY: number;
  } | null>(null);
  const panRef = React.useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startViewportX: number;
    startViewportY: number;
  } | null>(null);
  const connectRef = React.useRef<{
    pointerId: number;
    sourceNodeId: string;
    sourceKind: 'audio' | 'macro';
  } | null>(null);
  const [draggingNodeId, setDraggingNodeId] = React.useState<string | null>(null);
  const [dragPreviewPosition, setDragPreviewPosition] = React.useState<{
    nodeId: string;
    x: number;
    y: number;
  } | null>(null);
  const [panning, setPanning] = React.useState(false);
  const [connectingFromNodeId, setConnectingFromNodeId] = React.useState<string | null>(null);
  const [connectPoint, setConnectPoint] = React.useState<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = React.useState<{
    node: PositionedNode;
    x: number;
    y: number;
  } | null>(null);
  const [parameterResult, setParameterResult] = React.useState<GraphParameterResult | null>(null);
  const [parameterLoading, setParameterLoading] = React.useState(false);
  const [parameterSearch, setParameterSearch] = React.useState('');
  const model = React.useMemo(
    () => buildGraphStatePreviewModel(
      graphState,
      dragPreviewPosition
        ? { nodePositionOverrides: { [dragPreviewPosition.nodeId]: dragPreviewPosition } }
        : undefined,
    ),
    [dragPreviewPosition, graphState],
  );
  const viewport = React.useMemo(
    () => normalizeViewport(graphState?.viewport),
    [graphState?.viewport],
  );

  const canvasStyle: React.CSSProperties = {
    width: model.width,
    height: model.height,
    transform: `translate(${viewport.x}px, ${viewport.y}px)`,
  };
  const hasHeader = notice != null || model.empty;
  const canDragNodes = typeof onNodePositionChange === 'function';
  const canEditViewport = typeof onViewportChange === 'function';
  const canAddNode = typeof onAddEffectNode === 'function';
  const canAddMacro = typeof onAddMacroNode === 'function';
  const canRemoveNode = typeof onRemoveNode === 'function';
  const canEditNode = typeof onEditNode === 'function';
  const canConnect = typeof onConnectNodes === 'function';
  const canConnectParameters = typeof onConnectMacroToParameter === 'function';
  const canDisconnect = typeof onDisconnectEdge === 'function';
  const canExposeParameters =
    trackId != null &&
    typeof fetchGraphEffectParameters === 'function' &&
    typeof onToggleParameterPort === 'function';
  const canUseGraphHistory =
    typeof onUndoGraphEdit === 'function' || typeof onRedoGraphEdit === 'function';
  const showToolbar = canEditViewport || canAddNode || canAddMacro || canUseGraphHistory;

  const closeContextMenu = React.useCallback(() => {
    setContextMenu(null);
    setParameterResult(null);
    setParameterLoading(false);
    setParameterSearch('');
  }, []);

  React.useEffect(() => {
    if (!contextMenu) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        typeof Element !== 'undefined' &&
        target instanceof Element &&
        target.closest('.xleth-graph-state-preview__context-menu')
      ) {
        return;
      }
      closeContextMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeContextMenu();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeContextMenu, contextMenu]);

  React.useEffect(() => {
    if (!contextMenu || !canExposeParameters || !fetchGraphEffectParameters || trackId == null) {
      return undefined;
    }
    const effectInstanceId = contextMenu.node.effectInstanceId;
    if (!effectInstanceId) {
      setParameterResult({ ok: false, reason: 'missing_effect_instance_id' });
      return undefined;
    }

    let cancelled = false;
    setParameterLoading(true);
    setParameterResult(null);
    setParameterSearch('');
    Promise.resolve(fetchGraphEffectParameters(trackId, effectInstanceId, {
      graphNodeId: contextMenu.node.id,
    })).then((result) => {
      if (cancelled) return;
      setParameterResult(result);
    }).catch(() => {
      if (cancelled) return;
      setParameterResult({ ok: false, reason: 'engine_error' });
    }).finally(() => {
      if (!cancelled) setParameterLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [canExposeParameters, contextMenu, fetchGraphEffectParameters, trackId]);

  const handleNodeContextMenu = React.useCallback((
    event: React.MouseEvent<HTMLDivElement>,
    node: PositionedNode,
  ) => {
    if (node.type !== 'effect' || node.virtual) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      node,
      x: event.clientX,
      y: event.clientY,
    });
  }, []);

  const handleContextEdit = React.useCallback(() => {
    const node = contextMenu?.node;
    closeContextMenu();
    if (node?.editable) onEditNode?.(node.id);
  }, [closeContextMenu, contextMenu?.node, onEditNode]);

  const handleContextRemove = React.useCallback(() => {
    const node = contextMenu?.node;
    closeContextMenu();
    if (node) onRemoveNode?.(node.id);
  }, [closeContextMenu, contextMenu?.node, onRemoveNode]);

  const handleToggleParameter = React.useCallback((parameter: GraphEffectParameterDescriptor) => {
    const node = contextMenu?.node;
    closeContextMenu();
    if (!node) return;
    void Promise.resolve(onToggleParameterPort?.(node.id, parameter));
  }, [closeContextMenu, contextMenu?.node, onToggleParameterPort]);

  const finishDrag = React.useCallback((
    event: React.PointerEvent<HTMLDivElement>,
    commitPosition = true,
  ) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
    setDraggingNodeId(null);
    setDragPreviewPosition(null);

    if (
      commitPosition &&
      onNodePositionChange &&
      (drag.currentGraphX !== drag.startGraphX || drag.currentGraphY !== drag.startGraphY)
    ) {
      onNodePositionChange(drag.nodeId, {
        x: drag.currentGraphX,
        y: drag.currentGraphY,
      });
    }
  }, [onNodePositionChange]);

  const cancelDrag = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    finishDrag(event, false);
  }, [finishDrag]);

  const handleNodePointerDown = React.useCallback((
    event: React.PointerEvent<HTMLDivElement>,
    node: PositionedNode,
  ) => {
    if (!canDragNodes || node.virtual || event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      nodeId: node.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startGraphX: node.graphX,
      startGraphY: node.graphY,
      currentGraphX: node.graphX,
      currentGraphY: node.graphY,
    };
    setDraggingNodeId(node.id);
  }, [canDragNodes]);

  const handleNodePointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !onNodePositionChange) return;

    event.preventDefault();
    const nextX = Math.max(0, drag.startGraphX + (event.clientX - drag.startClientX));
    const nextY = Math.max(0, drag.startGraphY + (event.clientY - drag.startClientY));
    const roundedX = Math.round(nextX * 100) / 100;
    const roundedY = Math.round(nextY * 100) / 100;
    drag.currentGraphX = roundedX;
    drag.currentGraphY = roundedY;
    setDragPreviewPosition({
      nodeId: drag.nodeId,
      x: roundedX,
      y: roundedY,
    });
  }, [onNodePositionChange]);

  const finishPan = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      panRef.current = null;
      setPanning(false);
    }
  }, []);

  const handleViewportPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!canEditViewport || event.button !== 0) return;
    const target = event.target;
    if (
      typeof Element !== 'undefined' &&
      target instanceof Element &&
      target.closest('.xleth-graph-state-preview__node')
    ) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    panRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startViewportX: viewport.x,
      startViewportY: viewport.y,
    };
    setPanning(true);
  }, [canEditViewport, viewport.x, viewport.y]);

  const handleViewportPointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId || !onViewportChange) return;

    event.preventDefault();
    onViewportChange({
      x: roundViewport(pan.startViewportX + event.clientX - pan.startClientX),
      y: roundViewport(pan.startViewportY + event.clientY - pan.startClientY),
      zoom: viewport.zoom,
    });
  }, [onViewportChange, viewport.zoom]);

  const handleFitView = React.useCallback(() => {
    if (!onViewportChange) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;

    onViewportChange({
      x: roundViewport((rect.width - model.bounds.width) / 2 - model.bounds.minX),
      y: roundViewport((rect.height - model.bounds.height) / 2 - model.bounds.minY),
      zoom: viewport.zoom,
    });
  }, [model.bounds.height, model.bounds.minX, model.bounds.minY, model.bounds.width, onViewportChange, viewport.zoom]);

  const handleResetView = React.useCallback(() => {
    onViewportChange?.({
      x: DEFAULT_VIEWPORT.x,
      y: DEFAULT_VIEWPORT.y,
      zoom: viewport.zoom,
    });
  }, [onViewportChange, viewport.zoom]);

  const toCanvasPoint = React.useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  const resetConnect = React.useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    if (connectRef.current?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      connectRef.current = null;
      setConnectingFromNodeId(null);
      setConnectPoint(null);
    }
  }, []);

  const handleConnectPointerDown = React.useCallback((
    event: React.PointerEvent<HTMLSpanElement>,
    node: PositionedNode,
  ) => {
    const isMacro = node.type === 'macro';
    const allowed = isMacro ? canConnectParameters : canConnect;
    if (!allowed || node.virtual || event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    connectRef.current = {
      pointerId: event.pointerId,
      sourceNodeId: node.id,
      sourceKind: isMacro ? 'macro' : 'audio',
    };
    setConnectingFromNodeId(node.id);
    setConnectPoint(toCanvasPoint(event.clientX, event.clientY));
  }, [canConnect, canConnectParameters, toCanvasPoint]);

  const handleConnectPointerMove = React.useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    const connect = connectRef.current;
    if (!connect || connect.pointerId !== event.pointerId) return;

    event.preventDefault();
    setConnectPoint(toCanvasPoint(event.clientX, event.clientY));
  }, [toCanvasPoint]);

  const handleConnectPointerUp = React.useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    const connect = connectRef.current;
    if (!connect || connect.pointerId !== event.pointerId) return;

    event.preventDefault();
    const sourceNodeId = connect.sourceNodeId;
    const dropElement = typeof document !== 'undefined'
      ? document.elementFromPoint(event.clientX, event.clientY)
      : null;

    // Macro controlOut → exposed parameter input port creates a parameter edge.
    // The drop must land on a parameter port; node bodies and audio handles no-op.
    if (connect.sourceKind === 'macro') {
      let targetNodeId: string | null = null;
      let parameterId: string | null = null;
      if (dropElement instanceof Element) {
        const portElement = dropElement.closest('[data-parameter-port-id]');
        if (portElement) {
          parameterId = portElement.getAttribute('data-parameter-id');
          const nodeElement = portElement.closest('[data-node-id]');
          targetNodeId = nodeElement?.getAttribute('data-node-id') ?? null;
        }
      }

      resetConnect(event);

      if (onConnectMacroToParameter && targetNodeId && parameterId && targetNodeId !== sourceNodeId) {
        onConnectMacroToParameter(sourceNodeId, targetNodeId, parameterId);
      }
      return;
    }

    // Audio out → node body creates an audio edge (unchanged behavior).
    const targetNode = dropElement instanceof Element
      ? dropElement.closest('[data-node-id]')
      : null;
    const targetNodeId = targetNode?.getAttribute('data-node-id') ?? null;

    resetConnect(event);

    if (onConnectNodes && targetNodeId && targetNodeId !== sourceNodeId) {
      onConnectNodes(sourceNodeId, targetNodeId);
    }
  }, [onConnectMacroToParameter, onConnectNodes, resetConnect]);

  const connectingNode = connectingFromNodeId
    ? model.nodes.find((node) => node.id === connectingFromNodeId)
    : undefined;
  const connectLinePath = connectingNode && connectPoint
    ? (() => {
        const start = nodeOutPoint(connectingNode);
        const midpointX = start.x + (connectPoint.x - start.x) / 2;
        return [
          `M ${start.x} ${start.y}`,
          `C ${midpointX} ${start.y}, ${midpointX} ${connectPoint.y}, ${connectPoint.x} ${connectPoint.y}`,
        ].join(' ');
      })()
    : null;

  return (
    <section
      className="xleth-graph-state-preview"
      aria-label={canEditViewport ? 'Persisted FX graph workspace' : 'Read-only persisted FX graph preview'}
      data-read-only="true"
      data-draggable-nodes={canDragNodes ? 'true' : undefined}
      data-workspace-active={canEditViewport ? 'true' : undefined}
    >
      {(hasHeader || showToolbar) && (
        <div className="xleth-graph-state-preview__chrome">
          {hasHeader && (
            <div className="xleth-graph-state-preview__header">
              {notice != null && (
                <p className="xleth-graph-state-preview__notice">{notice}</p>
              )}
              {model.empty && (
                <p className="xleth-graph-state-preview__empty-title">Empty FX Graph</p>
              )}
            </div>
          )}
          {showToolbar && (
            <div className="xleth-graph-state-preview__toolbar" aria-label="Graph workspace controls">
              {canUseGraphHistory && (
                <>
                  <button
                    className="xleth-graph-state-preview__view-button"
                    type="button"
                    disabled={!canUndoGraphEdit}
                    aria-label="Undo graph edit"
                    title="Undo graph edit"
                    onClick={onUndoGraphEdit}
                  >
                    Undo
                  </button>
                  <button
                    className="xleth-graph-state-preview__view-button"
                    type="button"
                    disabled={!canRedoGraphEdit}
                    aria-label="Redo graph edit"
                    title="Redo graph edit"
                    onClick={onRedoGraphEdit}
                  >
                    Redo
                  </button>
                </>
              )}
              {canAddNode && (
                <button
                  className="xleth-graph-state-preview__action-button"
                  type="button"
                  onClick={onAddEffectNode}
                >
                  Add Effect Node
                </button>
              )}
              {canAddMacro && (
                <button
                  className="xleth-graph-state-preview__action-button xleth-graph-state-preview__action-button--macro"
                  type="button"
                  onClick={onAddMacroNode}
                >
                  Add Macro
                </button>
              )}
              {canEditViewport && (
                <>
                  <button
                    className="xleth-graph-state-preview__view-button"
                    type="button"
                    onClick={handleFitView}
                  >
                    Fit View
                  </button>
                  <button
                    className="xleth-graph-state-preview__view-button"
                    type="button"
                    onClick={handleResetView}
                  >
                    Reset View
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      <div
        className="xleth-graph-state-preview__viewport"
        ref={viewportRef}
        data-pannable={canEditViewport ? 'true' : undefined}
        data-panning={panning ? 'true' : undefined}
        onPointerDown={canEditViewport ? handleViewportPointerDown : undefined}
        onPointerMove={canEditViewport ? handleViewportPointerMove : undefined}
        onPointerUp={canEditViewport ? finishPan : undefined}
        onPointerCancel={canEditViewport ? finishPan : undefined}
      >
        <div className="xleth-graph-state-preview__stage" data-preview-scroll-stage="true">
          <div
            className="xleth-graph-state-preview__canvas"
            ref={canvasRef}
            style={canvasStyle}
            data-node-dragging={draggingNodeId != null ? 'true' : undefined}
            data-connecting={connectingFromNodeId != null ? 'true' : undefined}
          >
            <svg
              className="xleth-graph-state-preview__edges"
              width={model.width}
              height={model.height}
              viewBox={`0 0 ${model.width} ${model.height}`}
              role="img"
              aria-label="Static graph cables"
            >
              {model.edges.map((edge) => (
                <path
                  className={`xleth-graph-state-preview__edge xleth-graph-state-preview__edge--${edge.type}`}
                  data-edge-id={edge.id}
                  data-edge-type={edge.type}
                  key={edge.id}
                  d={edge.path}
                  aria-label={edge.label}
                />
              ))}
              {connectLinePath && (
                <path
                  className="xleth-graph-state-preview__edge xleth-graph-state-preview__edge--connecting"
                  d={connectLinePath}
                  aria-hidden="true"
                />
              )}
            </svg>
            <div className="xleth-graph-state-preview__nodes" role="list">
              {model.nodes.map((node) => (
                <GraphStatePreviewNode
                  key={node.id}
                  node={node}
                  dragging={draggingNodeId === node.id}
                  connectEnabled={canConnect}
                  connectParameterEnabled={canConnectParameters}
                  connectActive={connectingFromNodeId === node.id}
                  canRemove={canRemoveNode}
                  canEdit={canEditNode}
                  onPointerDown={canDragNodes ? handleNodePointerDown : undefined}
                  onPointerMove={canDragNodes ? handleNodePointerMove : undefined}
                  onPointerUp={canDragNodes ? finishDrag : undefined}
                  onPointerCancel={canDragNodes ? cancelDrag : undefined}
                  onConnectPointerDown={canConnect || canConnectParameters ? handleConnectPointerDown : undefined}
                  onConnectPointerMove={canConnect || canConnectParameters ? handleConnectPointerMove : undefined}
                  onConnectPointerUp={canConnect || canConnectParameters ? handleConnectPointerUp : undefined}
                  onConnectPointerCancel={canConnect || canConnectParameters ? resetConnect : undefined}
                  onNodeContextMenu={canExposeParameters ? handleNodeContextMenu : undefined}
                  onRemove={canRemoveNode ? onRemoveNode : undefined}
                  onEdit={canEditNode ? onEditNode : undefined}
                  onMacroValueCommit={onUpdateMacroValue}
                  onMacroRenameCommit={onRenameMacroNode}
                />
              ))}
            </div>
            {canDisconnect && (
              <div className="xleth-graph-state-preview__overlay" aria-label="Graph cable controls">
                {model.edges
                  .filter((edge) => edge.type === 'audio' || edge.type === 'parameter')
                  .map((edge) => (
                    <button
                      key={edge.id}
                      className={`xleth-graph-state-preview__disconnect xleth-graph-state-preview__disconnect--${edge.type}`}
                      type="button"
                      style={{ left: edge.midX, top: edge.midY }}
                      data-edge-id={edge.id}
                      data-edge-type={edge.type}
                      aria-label={`Disconnect ${edge.label}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDisconnectEdge?.(edge.id);
                      }}
                    >
                      {'×'}
                    </button>
                  ))}
              </div>
            )}
          </div>
          {contextMenu && (
            <GraphParameterContextMenu
              node={contextMenu.node}
              x={contextMenu.x}
              y={contextMenu.y}
              loading={parameterLoading}
              result={parameterResult}
              search={parameterSearch}
              canEdit={canEditNode}
              canRemove={canRemoveNode}
              onSearchChange={setParameterSearch}
              onToggleParameter={canExposeParameters ? handleToggleParameter : undefined}
              onEdit={handleContextEdit}
              onRemove={handleContextRemove}
            />
          )}
        </div>
      </div>
    </section>
  );
}
