import React from 'react';

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

export interface GraphStateEdge {
  id: string;
  sourceNodeId: string;
  sourcePort: string;
  targetNodeId: string;
  targetPort: string;
  type: string;
  _preservedType?: string;
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

type PreviewNodeKind = 'trackInput' | 'trackOutput' | 'effect' | 'unknown';
type PreviewEdgeKind = 'audio' | 'unknown';

interface PositionedNode {
  id: string;
  type: PreviewNodeKind;
  label: string;
  secondaryText: string | null;
  metaText: string | null;
  badges: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  virtual?: boolean;
}

interface PositionedEdge {
  id: string;
  type: PreviewEdgeKind;
  label: string;
  path: string;
}

interface PreviewModel {
  empty: boolean;
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  width: number;
  height: number;
}

interface PreviewModelOptions {
  warn?: (...args: unknown[]) => void;
}

interface GraphStatePreviewProps {
  graphState?: GraphStateDocument | null;
  notice?: string;
}

const NODE_WIDTH = 172;
const NODE_HEIGHT = 86;
const PREVIEW_PADDING = 32;
const FALLBACK_NODE_SPACING_X = 260;
const FALLBACK_NODE_Y = 16;
const MIN_CANVAS_WIDTH = 520;
const MIN_CANVAS_HEIGHT = 190;

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

function resolvePreviewNodeType(type: string): PreviewNodeKind {
  if (type === 'trackInput' || type === 'trackOutput' || type === 'effect') {
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

function resolveNodeText(node: GraphStateNode) {
  const type = resolvePreviewNodeType(node.type);
  const data = node.data;

  if (type === 'trackInput') {
    return {
      label: 'Track Input',
      secondaryText: null,
      metaText: null,
      badges: [] as string[],
    };
  }

  if (type === 'trackOutput') {
    return {
      label: 'Track Output',
      secondaryText: null,
      metaText: null,
      badges: [] as string[],
    };
  }

  if (type === 'effect') {
    const displayName = readString(data, 'displayName') || 'Effect';
    const pluginId = readString(data, 'pluginId');
    const sourceSlot = readInteger(data, 'sourceChainSlotIndex');
    const badges: string[] = [];

    if (readBoolean(data, 'bypass')) badges.push('Bypassed');
    if (readBoolean(data, 'missing')) badges.push('Missing');
    if (readBoolean(data, 'crashed')) badges.push('Crashed');

    return {
      label: displayName,
      secondaryText: pluginId && pluginId !== displayName ? pluginId : null,
      metaText: sourceSlot == null ? null : `Chain slot ${sourceSlot + 1}`,
      badges,
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
    y: PREVIEW_PADDING + FALLBACK_NODE_Y,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    virtual: true,
  };
}

function normalizePositionedNodes(nodes: GraphStateNode[]) {
  if (nodes.length === 0) {
    return [
      makeVirtualAnchorNode('preview-empty-track-input', 'trackInput', PREVIEW_PADDING),
      makeVirtualAnchorNode(
        'preview-empty-track-output',
        'trackOutput',
        PREVIEW_PADDING + FALLBACK_NODE_SPACING_X,
      ),
    ];
  }

  const allNodesHavePositions = nodes.every(hasValidPosition);
  const layoutNodes = allNodesHavePositions ? nodes : fallbackNodeOrder(nodes);
  const rawPositions = layoutNodes.map((node, index) => {
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

  const minX = Math.min(...rawPositions.map((position) => position.x));
  const minY = Math.min(...rawPositions.map((position) => position.y));
  const positionById = new Map(rawPositions.map((position) => [position.id, position]));

  return layoutNodes.map((node) => {
    const position = positionById.get(node.id) ?? { x: 0, y: 0 };
    const text = resolveNodeText(node);
    return {
      id: node.id,
      type: resolvePreviewNodeType(node.type),
      ...text,
      x: position.x - minX + PREVIEW_PADDING,
      y: position.y - minY + PREVIEW_PADDING,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });
}

function makeEdgePath(source: PositionedNode, target: PositionedNode) {
  const sourceX = source.type === 'trackOutput' ? source.x : source.x + source.width;
  const sourceY = source.y + source.height / 2;
  const targetX = target.type === 'trackInput' ? target.x + target.width : target.x;
  const targetY = target.y + target.height / 2;
  const midpointX = sourceX + (targetX - sourceX) / 2;

  return [
    `M ${sourceX} ${sourceY}`,
    `C ${midpointX} ${sourceY}, ${midpointX} ${targetY}, ${targetX} ${targetY}`,
  ].join(' ');
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

    const type: PreviewEdgeKind = edge.type === 'audio' ? 'audio' : 'unknown';
    const preservedType = edge._preservedType || edge.type;
    positionedEdges.push({
      id: edge.id,
      type,
      label: type === 'audio'
        ? `Audio cable: ${source.label} to ${target.label}`
        : `Unsupported edge: ${preservedType}`,
      path: makeEdgePath(source, target),
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
  const nodes = normalizePositionedNodes(sourceNodes);
  const edges = sourceNodes.length === 0
    ? []
    : normalizePositionedEdges(sourceEdges, nodes, options);
  const maxX = Math.max(...nodes.map((node) => node.x + node.width), MIN_CANVAS_WIDTH - PREVIEW_PADDING);
  const maxY = Math.max(...nodes.map((node) => node.y + node.height), MIN_CANVAS_HEIGHT - PREVIEW_PADDING);

  return {
    empty: sourceNodes.length === 0 && sourceEdges.length === 0,
    nodes,
    edges,
    width: Math.ceil(maxX + PREVIEW_PADDING),
    height: Math.ceil(maxY + PREVIEW_PADDING),
  };
}

function GraphStatePreviewNode({ node }: { node: PositionedNode }) {
  const classType = node.type === 'trackInput'
    ? 'track-input'
    : node.type === 'trackOutput'
      ? 'track-output'
      : node.type;
  const style: React.CSSProperties = {
    left: node.x,
    top: node.y,
  };

  return (
    <div
      className={`xleth-graph-state-preview__node xleth-graph-state-preview__node--${classType}`}
      data-node-id={node.id}
      data-node-type={node.type}
      data-preview-virtual={node.virtual ? 'true' : undefined}
      role="listitem"
      aria-label={node.label}
      style={style}
    >
      {node.type !== 'trackInput' && (
        <span
          className="xleth-graph-state-preview__handle xleth-graph-state-preview__handle--in"
          aria-hidden="true"
        />
      )}
      {node.type !== 'trackOutput' && (
        <span
          className="xleth-graph-state-preview__handle xleth-graph-state-preview__handle--out"
          aria-hidden="true"
        />
      )}
      <span className="xleth-graph-state-preview__node-title">{node.label}</span>
      {node.secondaryText && (
        <span className="xleth-graph-state-preview__node-secondary">{node.secondaryText}</span>
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
    </div>
  );
}

export default function GraphStatePreview({
  graphState = null,
  notice = 'This preview is persisted graphState. Editing comes in a later phase.',
}: GraphStatePreviewProps) {
  const model = React.useMemo(
    () => buildGraphStatePreviewModel(graphState),
    [graphState],
  );

  const canvasStyle: React.CSSProperties = {
    width: model.width,
    height: model.height,
  };

  return (
    <section
      className="xleth-graph-state-preview"
      aria-label="Read-only persisted FX graph preview"
      data-read-only="true"
    >
      <div className="xleth-graph-state-preview__header">
        <p className="xleth-graph-state-preview__notice">{notice}</p>
        {model.empty && (
          <p className="xleth-graph-state-preview__empty-title">Empty FX Graph</p>
        )}
      </div>
      <div className="xleth-graph-state-preview__viewport">
        <div className="xleth-graph-state-preview__canvas" style={canvasStyle}>
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
          </svg>
          <div className="xleth-graph-state-preview__nodes" role="list">
            {model.nodes.map((node) => (
              <GraphStatePreviewNode key={node.id} node={node} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
