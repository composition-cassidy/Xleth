import React from 'react';
import {
  buildExposeParameterMenuGroups,
  describeParamFailure,
  isWritableParameter,
  type GraphEffectParameterDescriptor,
  type GraphParameterResult,
} from './graphParameterUtils';
import {
  evaluateParameterMapping,
  createDefaultBezierCurve,
  GRAPH_PARAMETER_CURVE_BEZIER,
} from '../../../fxgraph/graphState.js';
import {
  clampGraphZoom,
  fitGraphViewport,
  zoomViewportAroundScreenPoint,
} from '../../../fxgraph/graphViewport.js';
import {
  EnvelopeNodeBody,
  readEnvelopeNodeData,
  type EnvelopeNodeData,
  type EnvelopeNodePatch,
} from './EnvelopeEditor';

// FXG.4-g — Bezier mapping editor types.
type BezierPoint = { x: number; y: number };
interface ParsedMapping {
  enabled: boolean;
  sourceMin: number;
  sourceMax: number;
  targetMin: number;
  targetMax: number;
  curve: { type: 'linear' } | { type: 'bezier'; points: BezierPoint[] };
}

function clampUnit(v: number) { return Math.min(1, Math.max(0, v)); }

function parseMappingFromEdge(raw: unknown): ParsedMapping {
  const m = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const rawCurve = m.curve !== null && typeof m.curve === 'object' && !Array.isArray(m.curve)
    ? (m.curve as Record<string, unknown>)
    : {};

  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clampUnit(v) : fallback;

  let curve: ParsedMapping['curve'];
  if (rawCurve.type === GRAPH_PARAMETER_CURVE_BEZIER && Array.isArray(rawCurve.points) && rawCurve.points.length === 4) {
    curve = { type: 'bezier', points: rawCurve.points as BezierPoint[] };
  } else {
    curve = { type: 'linear' };
  }

  return {
    enabled: m.enabled !== false,
    sourceMin: num(m.sourceMin, 0),
    sourceMax: num(m.sourceMax, 1),
    targetMin: num(m.targetMin, 0),
    targetMax: num(m.targetMax, 1),
    curve,
  };
}

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

export interface GraphMacroAutomationClip {
  clipId: string;
  startTick: number;
  lengthTicks: number;
  loopEnabled: boolean;
  points: { tick: number; value: number; curve?: string }[];
  name?: string;
  colorToken?: string;
}

export interface GraphMacroAutomationLane {
  laneId: string;
  macroNodeId: string;
  target: string;
  visible: boolean;
  clips: GraphMacroAutomationClip[];
  targetUnavailable?: boolean;
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
  // FXG.4-h — parent-attached macro automation lanes (one per macro node).
  macroAutomationLanes?: GraphMacroAutomationLane[];
}

export interface GraphStateViewport {
  x: number;
  y: number;
  zoom?: number;
}

type PreviewNodeKind = 'trackInput' | 'trackOutput' | 'effect' | 'macro' | 'envelope' | 'sidechainInput' | 'unknown';
type PreviewEdgeKind = 'audio' | 'parameter' | 'sidechain' | 'unknown';

// FXG-SC.6B — eligible sidechain source track (mirrors mixerStore.getEligibleSidechainSources).
export interface SidechainSourceOption {
  sourceTrackId: number;
  name: string;
}

// v1 sidechain-capable target plugin ids (renderer-static capability gate). Only the
// stock compressor declares an external sidechain bus engine-side.
const SIDECHAIN_SUPPORTED_TARGET_PLUGIN_IDS = ['compressor'];

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
  // EVC.3 — normalized envelope definition, present only on envelope nodes.
  envelope: EnvelopeNodeData | null;
  // EVC-R3 — compact envelope summary count of outgoing parameter links.
  envelopeParameterEdgeCount: number;
  // FXG-SC.6B — true only for effect nodes that can receive a sidechain key (stock
  // compressor, non-missing/crashed, with an effectInstanceId). Drives the sidechainIn port.
  sidechainTarget: boolean;
  // FXG-SC.6B — the Sidechain Input node's selected source track id (null when none).
  sidechainSourceTrackId: number | null;
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

export interface ParameterDropTarget {
  nodeId: string;
  parameterId: string;
  portId: string;
}

interface GraphStatePreviewProps {
  graphState?: GraphStateDocument | null;
  notice?: string | null;
  onNodePositionChange?: (nodeId: string, position: { x: number; y: number }) => void;
  onViewportChange?: (viewport: GraphStateViewport) => void;
  onAddEffectNode?: () => void;
  onAddMacroNode?: () => void;
  // EVC.3 — envelope node add/edit affordances (graph mode only).
  onAddEnvelopeNode?: () => void;
  onUpdateEnvelope?: (nodeId: string, patch: EnvelopeNodePatch) => void;
  // FXG-SC.6B — Sidechain Input node add + source selection + key linking.
  onAddSidechainInput?: () => void;
  onSetSidechainInputSource?: (nodeId: string, sourceTrackId: number | null) => void;
  onConnectSidechain?: (sidechainInputNodeId: string, targetNodeId: string) => void;
  sidechainSources?: SidechainSourceOption[];
  onRemoveNode?: (nodeId: string) => void;
  onConnectNodes?: (sourceNodeId: string, targetNodeId: string) => void;
  onConnectMacroToParameter?: (macroNodeId: string, targetNodeId: string, parameterId: string) => void;
  // EVC-R1 — link an Envelope controlOut to an exposed parameter input port.
  onConnectEnvelopeToParameter?: (envelopeNodeId: string, targetNodeId: string, parameterId: string) => void;
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
  // FXG.4-g — per-link Bezier mapping editor
  onUpdateParameterEdgeMapping?: (edgeId: string, mappingPatch: unknown) => void;
  // FXG.4-h — parent-attached macro automation lane actions (macro nodes only)
  onShowMacroAutomationLane?: (macroNodeId: string) => void;
  onHideMacroAutomationLane?: (macroNodeId: string) => void;
  onCreateMacroAutomationClip?: (macroNodeId: string) => void;
}

const NODE_WIDTH = 148;
const NODE_HEIGHT = 74;
// EVC-R3 — envelope nodes are compact by default. The expanded editor can grow
// visually, but this estimate keeps normal graph layouts dense.
const ENVELOPE_NODE_WIDTH = 236;
const ENVELOPE_NODE_CONTENT_HEIGHT = 112;
const PARAMETER_PORT_ROW_HEIGHT = 18;
const PARAMETER_PORT_SECTION_TOP = 8;
const PARAMETER_PORT_SECTION_BOTTOM = 10;
const PARAMETER_PORT_SECTION_HEADER = 12;
const PARAMETER_PORT_SECTION_ROW_GAP = 4;
const PREVIEW_PADDING_X = 24;
const PREVIEW_PADDING_Y = 24;
const HANDLE_OUTSET = 8;
const FALLBACK_NODE_SPACING_X = 204;
const FALLBACK_NODE_Y = 0;
const MIN_CANVAS_WIDTH = 460;
const MIN_CANVAS_HEIGHT = 240;
const DEFAULT_VIEWPORT: GraphStateViewport = Object.freeze({ x: 0, y: 0, zoom: 1 });
const ZOOM_BUTTON_STEP = 1.1;
// Continuous zoom sensitivity: Math.exp(-deltaY * k).
// k=0.001 → ~10% per standard 100px wheel notch; trackpad frames are tiny so feel smooth.
const WHEEL_ZOOM_SENSITIVITY = 0.001;

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
  if (
    type === 'trackInput' ||
    type === 'trackOutput' ||
    type === 'effect' ||
    type === 'macro' ||
    type === 'envelope' ||
    type === 'sidechainInput'
  ) {
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

// FXG-SC.6B — renderer-static sidechain capability check for an effect node. Mirrors
// graphState.isSidechainCapableEffectNode: a real (non-missing/crashed) effect with an
// effectInstanceId whose pluginId is sidechain-capable (stock compressor in v1).
function isSidechainCapableEffectData(data: Record<string, unknown> | undefined) {
  if (readBoolean(data, 'missing') || readBoolean(data, 'crashed')) return false;
  if (!readString(data, 'effectInstanceId')) return false;
  return SIDECHAIN_SUPPORTED_TARGET_PLUGIN_IDS.includes(readString(data, 'pluginId'));
}

interface ResolvedNodeText {
  label: string;
  secondaryText: string | null;
  metaText: string | null;
  badges: string[];
  effectInstanceId: string | null;
  pluginId: string | null;
  parameterPorts: GraphExposedParameterPort[];
  macroValue: number | null;
  envelope: EnvelopeNodeData | null;
  editable: boolean;
  sidechainTarget: boolean;
  sidechainSourceTrackId: number | null;
  isSidechainInput: boolean;
}

function resolveNodeText(node: GraphStateNode): ResolvedNodeText {
  const type = resolvePreviewNodeType(node.type);
  const data = node.data;
  const base: ResolvedNodeText = {
    label: '',
    secondaryText: null,
    metaText: null,
    badges: [],
    effectInstanceId: null,
    pluginId: null,
    parameterPorts: [],
    macroValue: null,
    envelope: null,
    editable: false,
    sidechainTarget: false,
    sidechainSourceTrackId: null,
    isSidechainInput: false,
  };

  if (type === 'trackInput') {
    return { ...base, label: 'Track Input' };
  }

  if (type === 'trackOutput') {
    return { ...base, label: 'Track Output' };
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
      ...base,
      label: displayName,
      secondaryText: pluginId && pluginId !== displayName ? pluginId : null,
      metaText: sourceSlot == null ? null : `Chain slot ${sourceSlot + 1}`,
      badges,
      effectInstanceId,
      pluginId,
      parameterPorts: readExposedParameterPorts(data),
      // Placeholder / data-only / missing nodes have no engine processor to open.
      editable: pluginId.length > 0 && pluginId !== 'placeholder' && !missing,
      // FXG-SC.6B — stock compressor effects expose a sidechainIn key target port.
      sidechainTarget: isSidechainCapableEffectData(data),
    };
  }

  if (type === 'macro') {
    return {
      ...base,
      label: readString(data, 'label') || readString(data, 'name') || 'Macro',
      secondaryText: 'Control source',
      macroValue: readNormalizedValue(data, 'normalizedValue'),
    };
  }

  if (type === 'envelope') {
    // EVC-R1 — render the persisted envelope definition. The node is a triggered
    // parameter-modulation control source (like Macro): no effectInstanceId, no
    // plugin metadata, no parameter input ports, no macro value — but it does expose
    // a single `controlOut` port that links to exposed effect parameters. The
    // normalized data drives the summary/preview and the compact editor.
    const envelope = readEnvelopeNodeData(data);
    return {
      ...base,
      label: envelope.label,
      secondaryText: 'Envelope Modulator',
      envelope,
    };
  }

  if (type === 'sidechainInput') {
    // FXG-SC.6B — the Sidechain Input node: a protected, non-audible key source with a
    // selected source track. Its only port is a `sidechainOut` output handle. The
    // secondary text reflects whether a source is chosen (resolved to a live name in
    // the panel via sidechainSources; here we only know the persisted id).
    const rawSource = data?.sourceTrackId;
    const sourceTrackId = typeof rawSource === 'number' && Number.isFinite(rawSource) ? rawSource : null;
    const label = readString(data, 'label') || 'Sidechain Input';
    return {
      ...base,
      label,
      secondaryText: sourceTrackId == null ? 'No source' : `Keyed by track ${sourceTrackId}`,
      sidechainSourceTrackId: sourceTrackId,
      isSidechainInput: true,
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
    ...base,
    label: displayName,
    secondaryText: preservedType
      ? `Unsupported node type: ${preservedType}`
      : 'Unsupported node type',
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
    y: FALLBACK_NODE_Y,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    graphX: x - PREVIEW_PADDING_X,
    graphY: FALLBACK_NODE_Y,
    envelopeParameterEdgeCount: 0,
    virtual: true,
  };
}

function parameterPortSectionHeight(portCount: number) {
  if (portCount <= 0) return 0;
  return PARAMETER_PORT_SECTION_TOP
    + PARAMETER_PORT_SECTION_HEADER
    + (portCount * PARAMETER_PORT_ROW_HEIGHT)
    + Math.max(0, portCount - 1) * PARAMETER_PORT_SECTION_ROW_GAP
    + PARAMETER_PORT_SECTION_BOTTOM;
}

function nodeHeightForPorts(portCount: number) {
  return NODE_HEIGHT + parameterPortSectionHeight(portCount);
}

// FXG-SC.6B — extra body height for the sidechain affordances.
const SIDECHAIN_PORT_SECTION_HEIGHT = 30;
const SIDECHAIN_SOURCE_SELECTOR_HEIGHT = 48;

function nodeHeightForText(text: ReturnType<typeof resolveNodeText>) {
  if (text.envelope) {
    return NODE_HEIGHT + ENVELOPE_NODE_CONTENT_HEIGHT;
  }
  return nodeHeightForPorts(text.parameterPorts.length)
    + (text.macroValue == null ? 0 : 38)
    + (text.sidechainTarget ? SIDECHAIN_PORT_SECTION_HEIGHT : 0)
    + (text.isSidechainInput ? SIDECHAIN_SOURCE_SELECTOR_HEIGHT : 0);
}

function nodeWidthForType(type: PreviewNodeKind) {
  if (type === 'envelope') return ENVELOPE_NODE_WIDTH;
  if (type === 'sidechainInput') return ENVELOPE_NODE_WIDTH;
  return NODE_WIDTH;
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
    const previewType = resolvePreviewNodeType(node.type);
    return {
      id: node.id,
      type: previewType,
      ...text,
      x: position.x + PREVIEW_PADDING_X,
      y: position.y + PREVIEW_PADDING_Y,
      width: nodeWidthForType(previewType),
      height: nodeHeightForText(text),
      graphX: position.x,
      graphY: position.y,
      envelopeParameterEdgeCount: 0,
    };
  });
}

function countEnvelopeParameterEdges(edges: GraphStateEdge[], nodes: PositionedNode[]) {
  const envelopeNodeIds = new Set(
    nodes.filter((node) => node.type === 'envelope').map((node) => node.id),
  );
  const counts = new Map<string, number>();
  for (const edge of edges) {
    if (edge.type !== 'parameter') continue;
    if (edge.sourcePort !== 'controlOut') continue;
    if (!envelopeNodeIds.has(edge.sourceNodeId)) continue;
    counts.set(edge.sourceNodeId, (counts.get(edge.sourceNodeId) ?? 0) + 1);
  }
  return counts;
}

function applyEnvelopeParameterEdgeCounts(nodes: PositionedNode[], edges: GraphStateEdge[]) {
  const counts = countEnvelopeParameterEdges(edges, nodes);
  return nodes.map((node) => node.type === 'envelope'
    ? { ...node, envelopeParameterEdgeCount: counts.get(node.id) ?? 0 }
    : node);
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

// FXG.4-e/f — parameter edges land on a specific exposed parameter input port.
// The ports render in a dedicated lane below the audio path, so the anchor matches
// the lane row instead of the node's audio input handle.
function parameterPortAnchor(node: PositionedNode, parameterId: string | null) {
  const ports = node.parameterPorts;
  const count = ports.length;
  const index = parameterId ? ports.findIndex((port) => port.parameterId === parameterId) : -1;
  if (count === 0 || index < 0) {
    return { x: node.x, y: node.y + node.height / 2 };
  }
  const sectionTop = node.y + NODE_HEIGHT + PARAMETER_PORT_SECTION_TOP;
  const rowsTop = sectionTop + PARAMETER_PORT_SECTION_HEADER;
  const y = rowsTop
    + index * (PARAMETER_PORT_ROW_HEIGHT + PARAMETER_PORT_SECTION_ROW_GAP)
    + PARAMETER_PORT_ROW_HEIGHT / 2;
  return { x: node.x, y };
}

// FXG-SC.6B — the sidechainIn port renders near the bottom of an effect node. The key
// cable lands on the node's left edge at that row.
function sidechainPortAnchor(node: PositionedNode) {
  return { x: node.x, y: node.y + node.height - PARAMETER_PORT_ROW_HEIGHT };
}

export function resolveParameterDropTargetFromElement(
  element: Element | null,
  sourceNodeId?: string | null,
): ParameterDropTarget | null {
  if (!element || typeof element.closest !== 'function') return null;
  const portElement = element.closest('[data-parameter-port-type="parameter-input"][data-parameter-port-id]');
  if (!portElement) return null;
  const parameterId = portElement.getAttribute('data-parameter-id');
  const portId = portElement.getAttribute('data-parameter-port-id');
  const nodeElement = portElement.closest('[data-node-id]');
  const nodeId = nodeElement?.getAttribute('data-node-id') ?? null;
  if (!nodeId || !parameterId || !portId || nodeId === sourceNodeId) return null;
  return { nodeId, parameterId, portId };
}

export function connectHighlightedParameterDropTarget(
  sourceNodeId: string,
  target: ParameterDropTarget | null,
  onConnect?: (macroNodeId: string, targetNodeId: string, parameterId: string) => void,
) {
  if (!target || !onConnect) return false;
  onConnect(sourceNodeId, target.nodeId, target.parameterId);
  return true;
}

// FXG-SC.6B — a sidechain drop lands on an effect node's sidechainIn port.
export interface SidechainDropTarget {
  nodeId: string;
  portId: string;
}

export function resolveSidechainDropTargetFromElement(
  element: Element | null,
  sourceNodeId?: string | null,
): SidechainDropTarget | null {
  if (!element || typeof element.closest !== 'function') return null;
  const portElement = element.closest('[data-sidechain-port-type="sidechain-input"][data-sidechain-port-id]');
  if (!portElement) return null;
  const portId = portElement.getAttribute('data-sidechain-port-id');
  const nodeElement = portElement.closest('[data-node-id]');
  const nodeId = nodeElement?.getAttribute('data-node-id') ?? null;
  if (!nodeId || !portId || nodeId === sourceNodeId) return null;
  return { nodeId, portId };
}

export function connectHighlightedSidechainDropTarget(
  sourceNodeId: string,
  target: SidechainDropTarget | null,
  onConnect?: (sidechainInputNodeId: string, targetNodeId: string) => void,
) {
  if (!target || !onConnect) return false;
  onConnect(sourceNodeId, target.nodeId);
  return true;
}

function isElementLike(element: Element | null): element is Element {
  return !!element && typeof element.closest === 'function';
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

    // FXG-SC.6B — sidechain key cable: Sidechain Input sidechainOut → effect sidechainIn.
    if (edge.type === 'sidechain') {
      const start = nodeOutPoint(source);
      const end = sidechainPortAnchor(target);
      positionedEdges.push({
        id: edge.id,
        type: 'sidechain',
        label: `Sidechain key: ${source.label} to ${target.label}`,
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
  const nodes = applyEnvelopeParameterEdgeCounts(
    normalizePositionedNodes(sourceNodes, options),
    sourceEdges,
  );
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
  connectEnvelopeParameterEnabled = false,
  connectSidechainEnabled = false,
  connectActive,
  hoveredParameterPortId = null,
  hoveredSidechainPort = false,
  sidechainSources = [],
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
  onEnvelopeUpdate,
  onSetSidechainSource,
}: {
  node: PositionedNode;
  dragging: boolean;
  connectEnabled: boolean;
  connectParameterEnabled?: boolean;
  connectEnvelopeParameterEnabled?: boolean;
  // FXG-SC.6B — enables the Sidechain Input node's sidechainOut handle as a drag source.
  connectSidechainEnabled?: boolean;
  connectActive: boolean;
  hoveredParameterPortId?: string | null;
  // FXG-SC.6B — true when a sidechain drag is hovering this effect node's sidechainIn port.
  hoveredSidechainPort?: boolean;
  // FXG-SC.6B — eligible source tracks for the Sidechain Input source selector.
  sidechainSources?: SidechainSourceOption[];
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
  // EVC.3 — envelope node edit callback. When absent, the envelope renders read-only.
  onEnvelopeUpdate?: (nodeId: string, patch: EnvelopeNodePatch) => void;
  // FXG-SC.6B — Sidechain Input source selector callback.
  onSetSidechainSource?: (nodeId: string, sourceTrackId: number | null) => void;
}) {
  const classType = node.type === 'trackInput'
    ? 'track-input'
    : node.type === 'trackOutput'
      ? 'track-output'
      : node.type === 'sidechainInput'
        ? 'sidechain-input'
        : node.type;
  const isMacro = node.type === 'macro';
  // FXG-SC.6B — the Sidechain Input node: a protected key source with one sidechainOut
  // handle and a source selector. No audio in-handle, no edit/remove, not in Mixer Chain.
  const isSidechainInput = node.type === 'sidechainInput';
  // EVC-R1 — envelope nodes are control-source definitions like macro nodes. They
  // expose NO audio handles and NO parameter input ports, but DO expose a single
  // `controlOut` port that drags to an exposed parameter port (parameter edge).
  const isEnvelope = node.type === 'envelope';
  // A control source emits a `controlOut` that links to exposed effect parameters.
  const isControlSource = isMacro || isEnvelope;
  const controlSourceKind = isMacro ? 'macro' : isEnvelope ? 'envelope' : null;
  const style: React.CSSProperties = {
    left: node.x,
    top: node.y,
    width: node.width,
    minHeight: node.height,
  };
  // Audio sources (effect/trackInput) drag from the out handle to create audio
  // edges. A control source (macro/envelope) drags its controlOut to an exposed
  // parameter port to create a parameter edge — a separate, gated affordance.
  const interactiveAudioOut =
    connectEnabled && !isControlSource && !node.virtual && typeof onConnectPointerDown === 'function';
  const interactiveControlOut =
    !node.virtual && typeof onConnectPointerDown === 'function' &&
    ((isMacro && connectParameterEnabled) || (isEnvelope && connectEnvelopeParameterEnabled));
  const interactiveOut = interactiveAudioOut || interactiveControlOut;
  // FXG-SC.6B — the Sidechain Input node's sidechainOut is interactive when sidechain
  // linking is enabled. It is its own connect-source kind, separate from audio/control.
  const interactiveSidechainOut =
    isSidechainInput && connectSidechainEnabled && !node.virtual && typeof onConnectPointerDown === 'function';
  const showRemove =
    canRemove &&
    (node.type === 'effect' || node.type === 'macro' || node.type === 'envelope') &&
    !node.virtual &&
    typeof onRemove === 'function';
  // Edit appears on every real effect node; placeholder/data-only nodes show a
  // disabled "not active yet" state so the affordance is discoverable but inert.
  const showEdit =
    canEdit && node.type === 'effect' && !node.virtual && typeof onEdit === 'function';
  const canOpenContextMenu =
    (node.type === 'effect' || node.type === 'macro') && !node.virtual && typeof onNodeContextMenu === 'function';
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
        hoveredParameterPortId ? 'xleth-graph-state-preview__node--parameter-drop-target' : '',
      ].filter(Boolean).join(' ')}
      data-node-id={node.id}
      data-node-type={node.type}
      data-parameter-drop-node={hoveredParameterPortId ? 'true' : undefined}
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
      {node.type !== 'trackInput' && node.type !== 'macro' && !isEnvelope && !isSidechainInput && (
        <span
          className="xleth-graph-state-preview__handle xleth-graph-state-preview__handle--in"
          aria-hidden="true"
        />
      )}
      {node.type !== 'trackOutput' && !isSidechainInput && (
        interactiveOut ? (
          <span
            className={[
              'xleth-graph-state-preview__handle',
              'xleth-graph-state-preview__handle--out',
              'xleth-graph-state-preview__handle--connect-source',
              isControlSource ? 'xleth-graph-state-preview__handle--control-out' : '',
              isControlSource ? 'xleth-graph-state-preview__handle--connect-parameter-source' : '',
            ].filter(Boolean).join(' ')}
            data-connect-source="true"
            data-connect-source-kind={controlSourceKind ?? 'audio'}
            data-control-output={isControlSource ? 'true' : undefined}
            data-control-port-id={isControlSource ? `${controlSourceKind}:${node.id}:controlOut` : undefined}
            data-control-port-type={isControlSource ? `${controlSourceKind}-output` : undefined}
            aria-label={isControlSource
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
              isControlSource ? 'xleth-graph-state-preview__handle--control-out' : '',
            ].filter(Boolean).join(' ')}
            data-control-output={isControlSource ? 'true' : undefined}
            data-control-port-id={isControlSource ? `${controlSourceKind}:${node.id}:controlOut` : undefined}
            data-control-port-type={isControlSource ? `${controlSourceKind}-output` : undefined}
            aria-hidden="true"
          />
        )
      )}
      {/* FXG-SC.6B — the Sidechain Input node's single sidechainOut handle. It is a
          distinct connect source (sourceKind 'sidechain'); it drags only to a
          compressor's sidechainIn port. No audio in-handle exists on this node. */}
      {isSidechainInput && (
        interactiveSidechainOut ? (
          <span
            className={[
              'xleth-graph-state-preview__handle',
              'xleth-graph-state-preview__handle--out',
              'xleth-graph-state-preview__handle--connect-source',
              'xleth-graph-state-preview__handle--sidechain-out',
            ].join(' ')}
            data-connect-source="true"
            data-connect-source-kind="sidechain"
            data-sidechain-output="true"
            data-sidechain-port-id={`sidechain:${node.id}:sidechainOut`}
            data-sidechain-port-type="sidechain-output"
            aria-label={`Link ${node.label} key to a compressor sidechain input`}
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
              'xleth-graph-state-preview__handle--sidechain-out',
            ].join(' ')}
            data-sidechain-output="true"
            data-sidechain-port-id={`sidechain:${node.id}:sidechainOut`}
            data-sidechain-port-type="sidechain-output"
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
      {/* FXG-SC.6D — sidechainInput secondary text uses a resolved track name from
          sidechainSources (available in the component) rather than the raw id from the
          model (which only knows the persisted number). Other node types render their
          model-computed secondaryText unchanged. */}
      {(isSidechainInput
        ? (() => {
            const sid = node.sidechainSourceTrackId;
            if (sid == null) return 'No source';
            const found = sidechainSources.find((s) => s.sourceTrackId === sid);
            return found ? `Keyed by: ${found.name}` : 'Source missing';
          })()
        : node.secondaryText) && (
        <span className="xleth-graph-state-preview__node-secondary">
          {isSidechainInput
            ? (() => {
                const sid = node.sidechainSourceTrackId;
                if (sid == null) return 'No source';
                const found = sidechainSources.find((s) => s.sourceTrackId === sid);
                return found ? `Keyed by: ${found.name}` : 'Source missing';
              })()
            : node.secondaryText}
        </span>
      )}
      {/* FXG-SC.6B — Sidechain Input source selector. Lists "No source" plus eligible
          live tracks. A persisted-but-missing source id is shown as an extra stale
          option so the saved intent stays visible. Selecting commits the source. */}
      {isSidechainInput && (
        <span className="xleth-graph-state-preview__sidechain-source">
          <span className="xleth-graph-state-preview__sidechain-source-label" id={`sidechain-source-label-${node.id}`}>
            Source
          </span>
          {typeof onSetSidechainSource === 'function' ? (
            <select
              className="xleth-graph-state-preview__sidechain-source-select"
              aria-labelledby={`sidechain-source-label-${node.id}`}
              aria-label={`${node.label} source track`}
              value={node.sidechainSourceTrackId == null ? '' : String(node.sidechainSourceTrackId)}
              data-sidechain-source-track={node.sidechainSourceTrackId == null ? '' : String(node.sidechainSourceTrackId)}
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => {
                const raw = event.currentTarget.value;
                onSetSidechainSource(node.id, raw === '' ? null : Number(raw));
              }}
            >
              <option value="">No source</option>
              {node.sidechainSourceTrackId != null &&
                !sidechainSources.some((s) => s.sourceTrackId === node.sidechainSourceTrackId) && (
                  <option value={String(node.sidechainSourceTrackId)}>
                    {`Track ${node.sidechainSourceTrackId} (missing)`}
                  </option>
                )}
              {sidechainSources.map((source) => (
                <option key={source.sourceTrackId} value={String(source.sourceTrackId)}>
                  {source.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="xleth-graph-state-preview__sidechain-source-static">
              {/* FXG-SC.6D — resolve track name from sidechainSources; fall back to
                  "Track N (missing)" for a stale saved source id. */}
              {node.sidechainSourceTrackId == null
                ? 'No source'
                : sidechainSources.find((s) => s.sourceTrackId === node.sidechainSourceTrackId)?.name
                  ?? `Track ${node.sidechainSourceTrackId} (missing)`}
            </span>
          )}
        </span>
      )}
      {isEnvelope && node.envelope && (
        <EnvelopeNodeBody
          nodeId={node.id}
          data={node.envelope}
          parameterCount={node.envelopeParameterEdgeCount}
          onChange={
            typeof onEnvelopeUpdate === 'function'
              ? (patch) => onEnvelopeUpdate(node.id, patch)
              : null
          }
        />
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
        <span className="xleth-graph-state-preview__parameter-section">
          <span className="xleth-graph-state-preview__parameter-section-label">
            Parameters
          </span>
          <span className="xleth-graph-state-preview__parameter-ports" role="list" aria-label={`${node.label} parameter inputs`}>
            {node.parameterPorts.map((port) => {
              const portId = `gpp:${node.id}:${port.parameterId}`;
              const hovered = hoveredParameterPortId === portId;
              return (
                <span
                  className={[
                    'xleth-graph-state-preview__parameter-port',
                    hovered ? 'xleth-graph-state-preview__parameter-port--hovered' : '',
                  ].filter(Boolean).join(' ')}
                  role="listitem"
                  key={port.parameterId}
                  title={port.nameSnapshot}
                  aria-label={`${node.label} parameter input: ${port.nameSnapshot}`}
                  data-parameter-port-id={portId}
                  data-parameter-id={port.parameterId}
                  data-parameter-port-type="parameter-input"
                  data-drop-target-hovered={hovered ? 'true' : undefined}
                >
                  <span className="xleth-graph-state-preview__parameter-port-dot" aria-hidden="true" />
                  <span className="xleth-graph-state-preview__parameter-port-label">
                    {port.nameSnapshot}
                  </span>
                </span>
              );
            })}
          </span>
        </span>
      )}
      {/* FXG-SC.6B — compressor-only sidechain key target port. Distinct from audio
          and parameter ports; only accepts a sidechainInput.sidechainOut drop. */}
      {node.type === 'effect' && node.sidechainTarget && (
        <span className="xleth-graph-state-preview__sidechain-section">
          <span
            className={[
              'xleth-graph-state-preview__sidechain-port',
              hoveredSidechainPort ? 'xleth-graph-state-preview__sidechain-port--hovered' : '',
            ].filter(Boolean).join(' ')}
            role="listitem"
            title="Sidechain key input"
            aria-label={`${node.label} sidechain key input`}
            data-sidechain-port-id={`scp:${node.id}:sidechainIn`}
            data-sidechain-port-type="sidechain-input"
            data-drop-target-hovered={hoveredSidechainPort ? 'true' : undefined}
          >
            <span className="xleth-graph-state-preview__sidechain-port-dot" aria-hidden="true" />
            <span className="xleth-graph-state-preview__sidechain-port-label">Sidechain</span>
          </span>
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

// FXG.4-g — bezier SVG canvas dimensions.
const BEZ_W = 220;
const BEZ_H = 110;

export function ParameterEdgeMappingEditor({
  edgeId,
  edge,
  sourceLabel,
  targetLabel,
  x,
  y,
  onUpdate,
  onClose,
}: {
  edgeId: string;
  edge: GraphStateEdge;
  sourceLabel: string;
  targetLabel: string;
  x: number;
  y: number;
  onUpdate: (edgeId: string, patch: unknown) => void;
  onClose: () => void;
}) {
  const mapping = parseMappingFromEdge(edge.mapping);
  const isBezier = mapping.curve.type === 'bezier';
  const bezierPoints = isBezier
    ? (mapping.curve as { type: 'bezier'; points: BezierPoint[] }).points
    : null;

  // Draft bezier points updated live during drag; committed on pointer up.
  const [draftPoints, setDraftPoints] = React.useState<BezierPoint[] | null>(null);
  const draggingRef = React.useRef<{ pointerId: number; which: 1 | 2 } | null>(null);
  const svgRef = React.useRef<SVGSVGElement | null>(null);

  // Points used for SVG rendering: draft during drag, committed otherwise.
  const displayPoints = draftPoints ?? bezierPoints;

  // Bezier SVG coordinate helpers (flip y: value 0 = bottom, 1 = top).
  const toSvgX = (vx: number) => vx * BEZ_W;
  const toSvgY = (vy: number) => (1 - vy) * BEZ_H;
  const toValX = (sx: number) => clampUnit(sx / BEZ_W);
  const toValY = (sy: number) => clampUnit(1 - sy / BEZ_H);

  const cp1 = displayPoints?.[1] ?? { x: 0.4, y: 0 };
  const cp2 = displayPoints?.[2] ?? { x: 0.6, y: 1 };
  const p0 = `0 ${BEZ_H}`;
  const p3 = `${BEZ_W} 0`;
  const cp1svgX = toSvgX(cp1.x); const cp1svgY = toSvgY(cp1.y);
  const cp2svgX = toSvgX(cp2.x); const cp2svgY = toSvgY(cp2.y);
  const bezierPathD = isBezier && displayPoints
    ? `M ${p0} C ${cp1svgX} ${cp1svgY}, ${cp2svgX} ${cp2svgY}, ${p3}`
    : `M ${p0} L ${p3}`;

  const preview0 = evaluateParameterMapping(edge.mapping, 0);
  const preview50 = evaluateParameterMapping(edge.mapping, 0.5);
  const preview100 = evaluateParameterMapping(edge.mapping, 1);
  const fmtPct = (v: number | null) => v == null ? '—' : `${Math.round(v * 100)}%`;

  const handleStartDrag = (which: 1 | 2) => (event: React.PointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = { pointerId: event.pointerId, which };
    setDraftPoints(displayPoints ? [...displayPoints] : null);
  };

  const handleDragMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = draggingRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const svgX = event.clientX - rect.left;
    const svgY = event.clientY - rect.top;
    const vx = toValX(svgX);
    const vy = toValY(svgY);
    setDraftPoints((prev) => {
      const pts = prev ? [...prev] : [{ x: 0, y: 0 }, { x: 0.4, y: 0 }, { x: 0.6, y: 1 }, { x: 1, y: 1 }];
      const next = pts.map((p) => ({ ...p }));
      next[drag.which] = { x: vx, y: vy };
      return next;
    });
  };

  const handleDragEnd = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = draggingRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const pts = draftPoints;
    draggingRef.current = null;
    setDraftPoints(null);
    if (pts) {
      onUpdate(edgeId, { curve: { type: 'bezier', points: pts } });
    }
  };

  return (
    <div
      className="xleth-graph-state-preview__mapping-editor"
      role="dialog"
      aria-label={`Edit mapping: ${sourceLabel} to ${targetLabel}`}
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      data-mapping-editor-id={edgeId}
    >
      <div className="xleth-graph-state-preview__mapping-editor-header">
        <span className="xleth-graph-state-preview__mapping-editor-title" title={`${sourceLabel} → ${targetLabel}`}>
          {sourceLabel} <span aria-hidden="true">→</span> {targetLabel}
        </span>
        <button
          className="xleth-graph-state-preview__mapping-editor-close"
          type="button"
          aria-label="Close mapping editor"
          onClick={onClose}
        >×</button>
      </div>

      <label className="xleth-graph-state-preview__mapping-editor-enabled">
        <input
          type="checkbox"
          defaultChecked={mapping.enabled}
          onChange={(e) => onUpdate(edgeId, { enabled: e.target.checked })}
        />
        Enabled
      </label>

      <div className="xleth-graph-state-preview__mapping-editor-section">
        <div className="xleth-graph-state-preview__mapping-editor-section-title">Output Range</div>
        <div className="xleth-graph-state-preview__mapping-editor-range-row">
          <span className="xleth-graph-state-preview__mapping-editor-range-label">Min</span>
          <input
            className="xleth-graph-state-preview__mapping-editor-range-slider"
            type="range" min="0" max="1" step="0.01" defaultValue={mapping.targetMin}
            aria-label="Target min"
            onPointerUp={(e) => onUpdate(edgeId, { targetMin: parseFloat((e.target as HTMLInputElement).value) })}
          />
          <input
            className="xleth-graph-state-preview__mapping-editor-range-num"
            type="number" min="0" max="1" step="0.01" defaultValue={mapping.targetMin}
            aria-label="Target min value"
            onBlur={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onUpdate(edgeId, { targetMin: clampUnit(v) }); }}
          />
        </div>
        <div className="xleth-graph-state-preview__mapping-editor-range-row">
          <span className="xleth-graph-state-preview__mapping-editor-range-label">Max</span>
          <input
            className="xleth-graph-state-preview__mapping-editor-range-slider"
            type="range" min="0" max="1" step="0.01" defaultValue={mapping.targetMax}
            aria-label="Target max"
            onPointerUp={(e) => onUpdate(edgeId, { targetMax: parseFloat((e.target as HTMLInputElement).value) })}
          />
          <input
            className="xleth-graph-state-preview__mapping-editor-range-num"
            type="number" min="0" max="1" step="0.01" defaultValue={mapping.targetMax}
            aria-label="Target max value"
            onBlur={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onUpdate(edgeId, { targetMax: clampUnit(v) }); }}
          />
        </div>
      </div>

      <div className="xleth-graph-state-preview__mapping-editor-section">
        <div className="xleth-graph-state-preview__mapping-editor-section-title">Curve</div>
        <div className="xleth-graph-state-preview__mapping-editor-curve-tabs" role="group" aria-label="Curve type">
          <button
            className={`xleth-graph-state-preview__mapping-editor-curve-tab${!isBezier ? ' xleth-graph-state-preview__mapping-editor-curve-tab--active' : ''}`}
            type="button"
            aria-pressed={!isBezier}
            onClick={() => onUpdate(edgeId, { curve: { type: 'linear' } })}
          >Linear</button>
          <button
            className={`xleth-graph-state-preview__mapping-editor-curve-tab${isBezier ? ' xleth-graph-state-preview__mapping-editor-curve-tab--active' : ''}`}
            type="button"
            aria-pressed={isBezier}
            onClick={() => { if (!isBezier) onUpdate(edgeId, { curve: createDefaultBezierCurve() }); }}
          >Bezier</button>
        </div>

        <svg
          ref={svgRef}
          className="xleth-graph-state-preview__mapping-editor-bezier-svg"
          width={BEZ_W}
          height={BEZ_H}
          aria-label="Curve editor"
          role="img"
          onPointerMove={isBezier ? handleDragMove : undefined}
          onPointerUp={isBezier ? handleDragEnd : undefined}
          onPointerCancel={isBezier ? handleDragEnd : undefined}
        >
          {/* Grid */}
          <line x1={BEZ_W * 0.25} y1="0" x2={BEZ_W * 0.25} y2={BEZ_H} className="xleth-graph-state-preview__mapping-editor-bezier-grid" />
          <line x1={BEZ_W * 0.5}  y1="0" x2={BEZ_W * 0.5}  y2={BEZ_H} className="xleth-graph-state-preview__mapping-editor-bezier-grid" />
          <line x1={BEZ_W * 0.75} y1="0" x2={BEZ_W * 0.75} y2={BEZ_H} className="xleth-graph-state-preview__mapping-editor-bezier-grid" />
          <line x1="0" y1={BEZ_H * 0.25} x2={BEZ_W} y2={BEZ_H * 0.25} className="xleth-graph-state-preview__mapping-editor-bezier-grid" />
          <line x1="0" y1={BEZ_H * 0.5}  x2={BEZ_W} y2={BEZ_H * 0.5}  className="xleth-graph-state-preview__mapping-editor-bezier-grid" />
          <line x1="0" y1={BEZ_H * 0.75} x2={BEZ_W} y2={BEZ_H * 0.75} className="xleth-graph-state-preview__mapping-editor-bezier-grid" />
          {/* Curve path */}
          <path d={bezierPathD} className="xleth-graph-state-preview__mapping-editor-bezier-path" />
          {/* Control handles (bezier only) */}
          {isBezier && displayPoints && (
            <>
              <line x1="0" y1={BEZ_H} x2={cp1svgX} y2={cp1svgY} className="xleth-graph-state-preview__mapping-editor-bezier-handle-line" />
              <line x1={BEZ_W} y1="0" x2={cp2svgX} y2={cp2svgY} className="xleth-graph-state-preview__mapping-editor-bezier-handle-line" />
              <circle
                cx={cp1svgX} cy={cp1svgY} r={6}
                className="xleth-graph-state-preview__mapping-editor-bezier-cp"
                aria-label="Control point 1 (drag to shape curve)"
                style={{ cursor: 'grab' }}
                onPointerDown={handleStartDrag(1)}
              />
              <circle
                cx={cp2svgX} cy={cp2svgY} r={6}
                className="xleth-graph-state-preview__mapping-editor-bezier-cp"
                aria-label="Control point 2 (drag to shape curve)"
                style={{ cursor: 'grab' }}
                onPointerDown={handleStartDrag(2)}
              />
            </>
          )}
          {/* Fixed endpoint markers */}
          <circle cx="0" cy={BEZ_H} r={3} className="xleth-graph-state-preview__mapping-editor-bezier-endpoint" />
          <circle cx={BEZ_W} cy="0" r={3} className="xleth-graph-state-preview__mapping-editor-bezier-endpoint" />
        </svg>
      </div>

      <div className="xleth-graph-state-preview__mapping-editor-preview" aria-label="Mapping preview">
        <span className="xleth-graph-state-preview__mapping-editor-preview-item">
          <span className="xleth-graph-state-preview__mapping-editor-preview-label">0%:</span>
          {fmtPct(preview0.value)}
        </span>
        <span className="xleth-graph-state-preview__mapping-editor-preview-item">
          <span className="xleth-graph-state-preview__mapping-editor-preview-label">50%:</span>
          {fmtPct(preview50.value)}
        </span>
        <span className="xleth-graph-state-preview__mapping-editor-preview-item">
          <span className="xleth-graph-state-preview__mapping-editor-preview-label">100%:</span>
          {fmtPct(preview100.value)}
        </span>
      </div>
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
  macroAutomation = null,
  onShowAutomationLane,
  onHideAutomationLane,
  onCreateAutomationClip,
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
  // FXG.4-h — macro automation lane state + actions (macro nodes only)
  macroAutomation?: { exists: boolean; visible: boolean; clipCount: number } | null;
  onShowAutomationLane?: () => void;
  onHideAutomationLane?: () => void;
  onCreateAutomationClip?: () => void;
}) {
  // FXG.4-h — Macro nodes get an Automation menu instead of the effect parameter
  // exposure menu. The lane is parent-attached (lives in this track's graphState);
  // these actions show/hide it and create automation clips bound to this macro.
  if (node.type === 'macro') {
    const laneVisible = macroAutomation?.exists ? macroAutomation.visible : false;
    return (
      <div
        className="xleth-graph-state-preview__context-menu"
        role="menu"
        aria-label={`${node.label} node menu`}
        style={{ left: x, top: y }}
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      >
        <div className="xleth-graph-state-preview__context-title">{node.label}</div>
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
            Automation
          </div>
          <button
            className="xleth-graph-state-preview__context-item"
            type="button"
            role="menuitemcheckbox"
            aria-checked={laneVisible}
            disabled={!onShowAutomationLane && !onHideAutomationLane}
            onClick={laneVisible ? onHideAutomationLane : onShowAutomationLane}
          >
            <span className="xleth-graph-state-preview__parameter-check" aria-hidden="true">
              {laneVisible ? 'On' : ''}
            </span>
            <span className="xleth-graph-state-preview__parameter-name">
              {laneVisible ? 'Hide Automation Lane' : 'Show Automation Lane'}
            </span>
          </button>
          <button
            className="xleth-graph-state-preview__context-item"
            type="button"
            role="menuitem"
            disabled={!onCreateAutomationClip}
            onClick={onCreateAutomationClip}
          >
            Create Automation Clip
          </button>
          {macroAutomation?.exists && (
            <div className="xleth-graph-state-preview__context-empty">
              {macroAutomation.clipCount === 1
                ? '1 automation clip'
                : `${macroAutomation.clipCount} automation clips`}
            </div>
          )}
        </div>
      </div>
    );
  }

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
  onAddEnvelopeNode,
  onUpdateEnvelope,
  onAddSidechainInput,
  onSetSidechainInputSource,
  onConnectSidechain,
  sidechainSources = [],
  onRemoveNode,
  onConnectNodes,
  onConnectMacroToParameter,
  onConnectEnvelopeToParameter,
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
  onUpdateParameterEdgeMapping,
  onShowMacroAutomationLane,
  onHideMacroAutomationLane,
  onCreateMacroAutomationClip,
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
    sourceKind: 'audio' | 'macro' | 'envelope' | 'sidechain';
  } | null>(null);
  const hoveredParameterTargetRef = React.useRef<ParameterDropTarget | null>(null);
  // FXG-SC.6B — sidechain drag hover target (effect sidechainIn port).
  const hoveredSidechainTargetRef = React.useRef<SidechainDropTarget | null>(null);
  const spaceDownRef = React.useRef(false);

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.code === 'Space') spaceDownRef.current = true; };
    const onKeyUp   = (e: KeyboardEvent) => { if (e.code === 'Space') spaceDownRef.current = false; };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup',   onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup',   onKeyUp);
    };
  }, []);

  const [draggingNodeId, setDraggingNodeId] = React.useState<string | null>(null);
  const [dragPreviewPosition, setDragPreviewPosition] = React.useState<{
    nodeId: string;
    x: number;
    y: number;
  } | null>(null);
  const [panning, setPanning] = React.useState(false);
  const [connectingFromNodeId, setConnectingFromNodeId] = React.useState<string | null>(null);
  const [connectPoint, setConnectPoint] = React.useState<{ x: number; y: number } | null>(null);
  const [hoveredParameterTarget, setHoveredParameterTarget] = React.useState<ParameterDropTarget | null>(null);
  const [hoveredSidechainTarget, setHoveredSidechainTarget] = React.useState<SidechainDropTarget | null>(null);
  const [contextMenu, setContextMenu] = React.useState<{
    node: PositionedNode;
    x: number;
    y: number;
  } | null>(null);
  const [parameterResult, setParameterResult] = React.useState<GraphParameterResult | null>(null);
  const [parameterLoading, setParameterLoading] = React.useState(false);
  const [parameterSearch, setParameterSearch] = React.useState('');
  const [mappingEditorState, setMappingEditorState] = React.useState<{
    edgeId: string;
    x: number;
    y: number;
  } | null>(null);
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
    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
  };
  const hasHeader = notice != null || model.empty;
  const canDragNodes = typeof onNodePositionChange === 'function';
  const canEditViewport = typeof onViewportChange === 'function';
  const canAddNode = typeof onAddEffectNode === 'function';
  const canAddMacro = typeof onAddMacroNode === 'function';
  const canAddEnvelope = typeof onAddEnvelopeNode === 'function';
  const canEditEnvelope = typeof onUpdateEnvelope === 'function';
  // FXG-SC.6B — sidechain affordances are graph-mode only (wired by the panel).
  const canAddSidechainInput = typeof onAddSidechainInput === 'function';
  const canSetSidechainSource = typeof onSetSidechainInputSource === 'function';
  const canConnectSidechain = typeof onConnectSidechain === 'function';
  const hasSidechainInputNode = Array.isArray(graphState?.nodes)
    && graphState.nodes.some((node) => node.type === 'sidechainInput');
  const canRemoveNode = typeof onRemoveNode === 'function';
  const canEditNode = typeof onEditNode === 'function';
  const canConnect = typeof onConnectNodes === 'function';
  const canConnectParameters = typeof onConnectMacroToParameter === 'function';
  const canConnectEnvelopeParameters = typeof onConnectEnvelopeToParameter === 'function';
  const canDisconnect = typeof onDisconnectEdge === 'function';
  const canEditMappings = typeof onUpdateParameterEdgeMapping === 'function';
  const canExposeParameters =
    trackId != null &&
    typeof fetchGraphEffectParameters === 'function' &&
    typeof onToggleParameterPort === 'function';
  // FXG.4-h — macro automation context-menu actions are available when the panel
  // wires any of the lane callbacks (graph mode only).
  const canMacroAutomation =
    typeof onShowMacroAutomationLane === 'function' ||
    typeof onHideMacroAutomationLane === 'function' ||
    typeof onCreateMacroAutomationClip === 'function';
  const canUseGraphHistory =
    typeof onUndoGraphEdit === 'function' || typeof onRedoGraphEdit === 'function';
  const showToolbar =
    canEditViewport || canAddNode || canAddMacro || canAddEnvelope || canAddSidechainInput || canUseGraphHistory;

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
    if (!mappingEditorState) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        typeof Element !== 'undefined' &&
        target instanceof Element &&
        target.closest('.xleth-graph-state-preview__mapping-editor')
      ) {
        return;
      }
      setMappingEditorState(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMappingEditorState(null);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [mappingEditorState]);

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
    // FXG.4-h — effect nodes open the parameter-exposure menu; macro nodes open the
    // automation menu. Other node types (Track I/O) have no menu.
    const isEffect = node.type === 'effect';
    const isMacro = node.type === 'macro';
    if ((!isEffect && !isMacro) || node.virtual) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      node,
      x: event.clientX,
      y: event.clientY,
    });
  }, []);

  const handleShowAutomationLane = React.useCallback(() => {
    const node = contextMenu?.node;
    closeContextMenu();
    if (node) onShowMacroAutomationLane?.(node.id);
  }, [closeContextMenu, contextMenu?.node, onShowMacroAutomationLane]);

  const handleHideAutomationLane = React.useCallback(() => {
    const node = contextMenu?.node;
    closeContextMenu();
    if (node) onHideMacroAutomationLane?.(node.id);
  }, [closeContextMenu, contextMenu?.node, onHideMacroAutomationLane]);

  const handleCreateAutomationClip = React.useCallback(() => {
    const node = contextMenu?.node;
    closeContextMenu();
    if (node) onCreateMacroAutomationClip?.(node.id);
  }, [closeContextMenu, contextMenu?.node, onCreateMacroAutomationClip]);

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
    // When Space is held the viewport pan handler takes over; let the event bubble.
    if (spaceDownRef.current) return;

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
    const nextX = Math.max(0, drag.startGraphX + (event.clientX - drag.startClientX) / viewport.zoom);
    const nextY = Math.max(0, drag.startGraphY + (event.clientY - drag.startClientY) / viewport.zoom);
    const roundedX = Math.round(nextX * 100) / 100;
    const roundedY = Math.round(nextY * 100) / 100;
    drag.currentGraphX = roundedX;
    drag.currentGraphY = roundedY;
    setDragPreviewPosition({
      nodeId: drag.nodeId,
      x: roundedX,
      y: roundedY,
    });
  }, [onNodePositionChange, viewport.zoom]);

  const finishPan = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      panRef.current = null;
      setPanning(false);
    }
  }, []);

  const handleViewportPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!canEditViewport) return;
    const isMiddle = event.button === 1;
    const isLeft   = event.button === 0;
    if (!isLeft && !isMiddle) return;

    // Left-click without Space: skip if pointer is over a node (node drag takes over).
    // Middle-click or Space+left always pans regardless of target.
    if (isLeft && !spaceDownRef.current) {
      const target = event.target;
      if (
        typeof Element !== 'undefined' &&
        target instanceof Element &&
        target.closest('.xleth-graph-state-preview__node')
      ) {
        return;
      }
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
    const result = fitGraphViewport(model.nodes, { width: rect.width, height: rect.height });
    onViewportChange({
      x: roundViewport(result.x),
      y: roundViewport(result.y),
      zoom: result.zoom,
    });
  }, [model.nodes, onViewportChange]);

  const handleResetView = React.useCallback(() => {
    onViewportChange?.({
      x: DEFAULT_VIEWPORT.x,
      y: DEFAULT_VIEWPORT.y,
      zoom: DEFAULT_VIEWPORT.zoom,
    });
  }, [onViewportChange]);

  const toCanvasPoint = React.useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: (clientX - rect.left) / viewport.zoom, y: (clientY - rect.top) / viewport.zoom };
  }, [viewport.zoom]);

  const handleZoomIn = React.useCallback(() => {
    if (!onViewportChange) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const nextZoom = clampGraphZoom(viewport.zoom * ZOOM_BUTTON_STEP);
    const next = zoomViewportAroundScreenPoint(viewport, center, nextZoom, rect);
    onViewportChange({ x: roundViewport(next.x), y: roundViewport(next.y), zoom: next.zoom });
  }, [onViewportChange, viewport]);

  const handleZoomOut = React.useCallback(() => {
    if (!onViewportChange) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const nextZoom = clampGraphZoom(viewport.zoom / ZOOM_BUTTON_STEP);
    const next = zoomViewportAroundScreenPoint(viewport, center, nextZoom, rect);
    onViewportChange({ x: roundViewport(next.x), y: roundViewport(next.y), zoom: next.zoom });
  }, [onViewportChange, viewport]);

  const handleZoomReset = React.useCallback(() => {
    if (!onViewportChange) return;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const next = zoomViewportAroundScreenPoint(viewport, center, 1, rect);
    onViewportChange({ x: roundViewport(next.x), y: roundViewport(next.y), zoom: 1 });
  }, [onViewportChange, viewport]);

  const handleWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!canEditViewport || !onViewportChange) return;
    event.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
    const nextZoom = clampGraphZoom(viewport.zoom * factor);
    const cursor = { x: event.clientX, y: event.clientY };
    const next = zoomViewportAroundScreenPoint(viewport, cursor, nextZoom, rect);
    onViewportChange({ x: roundViewport(next.x), y: roundViewport(next.y), zoom: next.zoom });
  }, [canEditViewport, onViewportChange, viewport]);

  const resetConnect = React.useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    if (connectRef.current?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      connectRef.current = null;
      hoveredParameterTargetRef.current = null;
      hoveredSidechainTargetRef.current = null;
      setConnectingFromNodeId(null);
      setConnectPoint(null);
      setHoveredParameterTarget(null);
      setHoveredSidechainTarget(null);
    }
  }, []);

  const updateHoveredParameterTarget = React.useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    const connect = connectRef.current;
    // Parameter-drop highlighting applies to both control sources (macro/envelope).
    const isControlSource = connect?.sourceKind === 'macro' || connect?.sourceKind === 'envelope';
    if (!connect || connect.pointerId !== event.pointerId || !isControlSource) return;

    const dropElement = typeof document !== 'undefined'
      ? document.elementFromPoint(event.clientX, event.clientY)
      : null;
    const nextTarget = resolveParameterDropTargetFromElement(dropElement, connect.sourceNodeId);
    const previous = hoveredParameterTargetRef.current;
    if (previous?.portId === nextTarget?.portId) return;
    hoveredParameterTargetRef.current = nextTarget;
    setHoveredParameterTarget(nextTarget);
  }, []);

  // FXG-SC.6B — highlight the compressor sidechainIn port under a sidechain drag.
  const updateHoveredSidechainTarget = React.useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    const connect = connectRef.current;
    if (!connect || connect.pointerId !== event.pointerId || connect.sourceKind !== 'sidechain') return;

    const dropElement = typeof document !== 'undefined'
      ? document.elementFromPoint(event.clientX, event.clientY)
      : null;
    const nextTarget = resolveSidechainDropTargetFromElement(dropElement, connect.sourceNodeId);
    const previous = hoveredSidechainTargetRef.current;
    if (previous?.portId === nextTarget?.portId) return;
    hoveredSidechainTargetRef.current = nextTarget;
    setHoveredSidechainTarget(nextTarget);
  }, []);

  const handleConnectPointerDown = React.useCallback((
    event: React.PointerEvent<HTMLSpanElement>,
    node: PositionedNode,
  ) => {
    const isMacro = node.type === 'macro';
    const isEnvelope = node.type === 'envelope';
    const isSidechainInput = node.type === 'sidechainInput';
    const allowed = isMacro
      ? canConnectParameters
      : isEnvelope
        ? canConnectEnvelopeParameters
        : isSidechainInput
          ? canConnectSidechain
          : canConnect;
    if (!allowed || node.virtual || event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    connectRef.current = {
      pointerId: event.pointerId,
      sourceNodeId: node.id,
      sourceKind: isMacro ? 'macro' : isEnvelope ? 'envelope' : isSidechainInput ? 'sidechain' : 'audio',
    };
    hoveredParameterTargetRef.current = null;
    hoveredSidechainTargetRef.current = null;
    setConnectingFromNodeId(node.id);
    setConnectPoint(toCanvasPoint(event.clientX, event.clientY));
    setHoveredParameterTarget(null);
    setHoveredSidechainTarget(null);
  }, [canConnect, canConnectParameters, canConnectEnvelopeParameters, canConnectSidechain, toCanvasPoint]);

  const handleConnectPointerMove = React.useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    const connect = connectRef.current;
    if (!connect || connect.pointerId !== event.pointerId) return;

    event.preventDefault();
    setConnectPoint(toCanvasPoint(event.clientX, event.clientY));
    updateHoveredParameterTarget(event);
    updateHoveredSidechainTarget(event);
  }, [toCanvasPoint, updateHoveredParameterTarget, updateHoveredSidechainTarget]);

  const handleConnectPointerUp = React.useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    const connect = connectRef.current;
    if (!connect || connect.pointerId !== event.pointerId) return;

    event.preventDefault();
    const sourceNodeId = connect.sourceNodeId;
    const dropElement = typeof document !== 'undefined'
      ? document.elementFromPoint(event.clientX, event.clientY)
      : null;

    // Control-source controlOut (macro/envelope) → exposed parameter input port
    // creates a parameter edge. The drop must land on the highlighted parameter
    // port; node bodies and audio handles no-op.
    if (connect.sourceKind === 'macro' || connect.sourceKind === 'envelope') {
      const target = hoveredParameterTargetRef.current;
      const onConnect = connect.sourceKind === 'macro'
        ? onConnectMacroToParameter
        : onConnectEnvelopeToParameter;

      resetConnect(event);

      connectHighlightedParameterDropTarget(sourceNodeId, target, onConnect);
      return;
    }

    // FXG-SC.6B — Sidechain Input sidechainOut → compressor sidechainIn creates a
    // sidechain edge. The drop must land on the highlighted sidechain port; anything
    // else (node body, audio handle, parameter port) no-ops via the null target.
    if (connect.sourceKind === 'sidechain') {
      const target = hoveredSidechainTargetRef.current;
      resetConnect(event);
      connectHighlightedSidechainDropTarget(sourceNodeId, target, onConnectSidechain);
      return;
    }

    // Audio out → node body creates an audio edge. Parameter ports are not valid
    // audio targets, even though they sit inside effect nodes.
    const parameterDropTarget = resolveParameterDropTargetFromElement(dropElement, sourceNodeId);
    const targetNode = isElementLike(dropElement)
      ? dropElement.closest('[data-node-id]')
      : null;
    const targetNodeId = targetNode?.getAttribute('data-node-id') ?? null;

    resetConnect(event);

    if (!parameterDropTarget && onConnectNodes && targetNodeId && targetNodeId !== sourceNodeId) {
      onConnectNodes(sourceNodeId, targetNodeId);
    }
  }, [onConnectMacroToParameter, onConnectEnvelopeToParameter, onConnectSidechain, onConnectNodes, resetConnect]);

  const connectingNode = connectingFromNodeId
    ? model.nodes.find((node) => node.id === connectingFromNodeId)
    : undefined;
  const hoveredParameterNode = hoveredParameterTarget
    ? model.nodes.find((node) => node.id === hoveredParameterTarget.nodeId)
    : undefined;
  const hoveredSidechainNode = hoveredSidechainTarget
    ? model.nodes.find((node) => node.id === hoveredSidechainTarget.nodeId)
    : undefined;
  const displayedConnectPoint = hoveredParameterNode
    ? parameterPortAnchor(hoveredParameterNode, hoveredParameterTarget?.parameterId ?? null)
    : hoveredSidechainNode
      ? sidechainPortAnchor(hoveredSidechainNode)
      : connectPoint;
  const connectLinePath = connectingNode && displayedConnectPoint
    ? (() => {
        const start = nodeOutPoint(connectingNode);
        const midpointX = start.x + (displayedConnectPoint.x - start.x) / 2;
        return [
          `M ${start.x} ${start.y}`,
          `C ${midpointX} ${start.y}, ${midpointX} ${displayedConnectPoint.y}, ${displayedConnectPoint.x} ${displayedConnectPoint.y}`,
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
              {canAddEnvelope && (
                <button
                  className="xleth-graph-state-preview__action-button xleth-graph-state-preview__action-button--envelope"
                  type="button"
                  onClick={onAddEnvelopeNode}
                >
                  Add Envelope
                </button>
              )}
              {canAddSidechainInput && (
                <button
                  className="xleth-graph-state-preview__action-button xleth-graph-state-preview__action-button--sidechain"
                  type="button"
                  disabled={hasSidechainInputNode}
                  title={hasSidechainInputNode
                    ? 'This graph already has a Sidechain Input node'
                    : 'Add a Sidechain Input node'}
                  onClick={onAddSidechainInput}
                >
                  Add Sidechain Input
                </button>
              )}
              {canEditViewport && (
                <>
                  <button
                    className="xleth-graph-state-preview__view-button"
                    type="button"
                    onClick={handleZoomOut}
                    aria-label="Zoom out"
                  >
                    {'−'}
                  </button>
                  <button
                    className="xleth-graph-state-preview__zoom-display"
                    type="button"
                    onClick={handleZoomReset}
                    title="Reset zoom to 100%"
                  >
                    {`${Math.round(viewport.zoom * 100)}%`}
                  </button>
                  <button
                    className="xleth-graph-state-preview__view-button"
                    type="button"
                    onClick={handleZoomIn}
                    aria-label="Zoom in"
                  >
                    {'+'}
                  </button>
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
        onWheel={canEditViewport ? handleWheel : undefined}
      >
        <div className="xleth-graph-state-preview__stage" data-preview-scroll-stage="true">
          <div
            className="xleth-graph-state-preview__canvas"
            ref={canvasRef}
            style={canvasStyle}
            data-node-dragging={draggingNodeId != null ? 'true' : undefined}
            data-connecting={connectingFromNodeId != null ? 'true' : undefined}
            data-connecting-kind={connectRef.current?.sourceKind ?? undefined}
            data-parameter-drop-target={hoveredParameterTarget?.portId ?? undefined}
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
                  connectEnvelopeParameterEnabled={canConnectEnvelopeParameters}
                  connectSidechainEnabled={canConnectSidechain}
                  connectActive={connectingFromNodeId === node.id}
                  hoveredParameterPortId={hoveredParameterTarget?.nodeId === node.id ? hoveredParameterTarget.portId : null}
                  hoveredSidechainPort={hoveredSidechainTarget?.nodeId === node.id}
                  sidechainSources={sidechainSources}
                  canRemove={canRemoveNode}
                  canEdit={canEditNode}
                  onPointerDown={canDragNodes ? handleNodePointerDown : undefined}
                  onPointerMove={canDragNodes ? handleNodePointerMove : undefined}
                  onPointerUp={canDragNodes ? finishDrag : undefined}
                  onPointerCancel={canDragNodes ? cancelDrag : undefined}
                  onConnectPointerDown={canConnect || canConnectParameters || canConnectEnvelopeParameters || canConnectSidechain ? handleConnectPointerDown : undefined}
                  onConnectPointerMove={canConnect || canConnectParameters || canConnectEnvelopeParameters || canConnectSidechain ? handleConnectPointerMove : undefined}
                  onConnectPointerUp={canConnect || canConnectParameters || canConnectEnvelopeParameters || canConnectSidechain ? handleConnectPointerUp : undefined}
                  onConnectPointerCancel={canConnect || canConnectParameters || canConnectEnvelopeParameters || canConnectSidechain ? resetConnect : undefined}
                  onNodeContextMenu={(canExposeParameters || canMacroAutomation) ? handleNodeContextMenu : undefined}
                  onRemove={canRemoveNode ? onRemoveNode : undefined}
                  onEdit={canEditNode ? onEditNode : undefined}
                  onMacroValueCommit={onUpdateMacroValue}
                  onMacroRenameCommit={onRenameMacroNode}
                  onEnvelopeUpdate={canEditEnvelope ? onUpdateEnvelope : undefined}
                  onSetSidechainSource={canSetSidechainSource ? onSetSidechainInputSource : undefined}
                />
              ))}
            </div>
            {(canDisconnect || canEditMappings) && (
              <div className="xleth-graph-state-preview__overlay" aria-label="Graph cable controls">
                {model.edges
                  .filter((edge) => edge.type === 'audio' || edge.type === 'parameter' || edge.type === 'sidechain')
                  .map((edge) => (
                    <React.Fragment key={edge.id}>
                      {canDisconnect && (
                        <button
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
                      )}
                      {edge.type === 'parameter' && canEditMappings && (
                        <button
                          className={[
                            'xleth-graph-state-preview__disconnect',
                            'xleth-graph-state-preview__disconnect--parameter',
                            'xleth-graph-state-preview__edge-edit',
                            mappingEditorState?.edgeId === edge.id
                              ? 'xleth-graph-state-preview__edge-edit--open'
                              : '',
                          ].filter(Boolean).join(' ')}
                          type="button"
                          style={{ left: edge.midX - 22, top: edge.midY }}
                          data-edge-id={edge.id}
                          data-edge-type={edge.type}
                          aria-label={`Edit mapping for ${edge.label}`}
                          aria-pressed={mappingEditorState?.edgeId === edge.id}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            setMappingEditorState((prev) =>
                              prev?.edgeId === edge.id
                                ? null
                                : { edgeId: edge.id, x: event.clientX + 12, y: event.clientY - 20 },
                            );
                          }}
                        >
                          {'~'}
                        </button>
                      )}
                    </React.Fragment>
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
              macroAutomation={(() => {
                if (contextMenu.node.type !== 'macro') return null;
                const lane = Array.isArray(graphState?.macroAutomationLanes)
                  ? graphState.macroAutomationLanes.find((l) => l.macroNodeId === contextMenu.node.id)
                  : undefined;
                return {
                  exists: !!lane,
                  visible: lane ? lane.visible !== false : false,
                  clipCount: lane ? lane.clips.length : 0,
                };
              })()}
              onShowAutomationLane={onShowMacroAutomationLane ? handleShowAutomationLane : undefined}
              onHideAutomationLane={onHideMacroAutomationLane ? handleHideAutomationLane : undefined}
              onCreateAutomationClip={onCreateMacroAutomationClip ? handleCreateAutomationClip : undefined}
            />
          )}
          {mappingEditorState && canEditMappings && (() => {
            const meEdge = graphState?.edges?.find((e) => e.id === mappingEditorState.edgeId);
            if (!meEdge || meEdge.type !== 'parameter') return null;
            const sourceNode = model.nodes.find((n) => n.id === meEdge.sourceNodeId);
            const targetNode = model.nodes.find((n) => n.id === meEdge.targetNodeId);
            const srcLabel = sourceNode?.label ?? 'Macro';
            const paramId =
              (meEdge.targetParameter as Record<string, unknown> | null | undefined)?.nameSnapshot as string
              ?? (meEdge.targetParameter as Record<string, unknown> | null | undefined)?.parameterId as string
              ?? 'Parameter';
            const tgtLabel = targetNode ? `${targetNode.label} / ${paramId}` : paramId;
            return (
              <ParameterEdgeMappingEditor
                edgeId={mappingEditorState.edgeId}
                edge={meEdge}
                sourceLabel={srcLabel}
                targetLabel={tgtLabel}
                x={mappingEditorState.x}
                y={mappingEditorState.y}
                onUpdate={(edgeId, patch) => {
                  void Promise.resolve(onUpdateParameterEdgeMapping?.(edgeId, patch));
                }}
                onClose={() => setMappingEditorState(null)}
              />
            );
          })()}
        </div>
      </div>
    </section>
  );
}
