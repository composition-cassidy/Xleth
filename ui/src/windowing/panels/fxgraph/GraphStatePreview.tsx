import React from 'react';
import { createPortal } from 'react-dom';
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
  readParameterMappingKind,
  canSpliceGraphNodeIntoEdge,
} from '../../../fxgraph/graphState.js';
import {
  clampGraphZoom,
  fitGraphViewport,
  zoomViewportAroundScreenPoint,
} from '../../../fxgraph/graphViewport.js';
import { resolveEffectVendorTag } from '../../../components/mixer/effectCatalog.js';
import type { VstPluginMeta } from './ChainAsGraphPreview';
import {
  EnvelopeNodeBody,
  readEnvelopeNodeData,
  type EnvelopeNodeData,
  type EnvelopeNodePatch,
} from './EnvelopeEditor';
import {
  LfoNodeBody,
  readLfoNodeData,
  type LfoNodeData,
  type LfoNodePatch,
} from './LfoEditor';

// FXG.4-g — Bezier mapping editor types.
type BezierPoint = { x: number; y: number };
// EVC-R4 — a parameter edge's mapping is one of two closed shapes, discriminated by `kind`
// (see GRAPH_PARAMETER_MAPPING_MODULATION in graphState.js). The editor renders a different
// output section for each: an absolute Min/Max output range for a Macro edge, and a
// Base + signed Depth pair for an Envelope edge.
interface ParsedMapping {
  kind: 'range' | 'modulation';
  enabled: boolean;
  sourceMin: number;
  sourceMax: number;
  targetMin: number;
  targetMax: number;
  base: number;
  depth: number;
  curve: { type: 'linear' } | { type: 'bezier'; points: BezierPoint[] };
}

function clampUnit(v: number) { return Math.min(1, Math.max(0, v)); }
function clampSignedUnit(v: number) { return Math.min(1, Math.max(-1, v)); }

function parseMappingFromEdge(raw: unknown): ParsedMapping {
  const m = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const rawCurve = m.curve !== null && typeof m.curve === 'object' && !Array.isArray(m.curve)
    ? (m.curve as Record<string, unknown>)
    : {};

  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clampUnit(v) : fallback;
  const signedNum = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? clampSignedUnit(v) : fallback;

  let curve: ParsedMapping['curve'];
  if (rawCurve.type === GRAPH_PARAMETER_CURVE_BEZIER && Array.isArray(rawCurve.points) && rawCurve.points.length === 4) {
    curve = { type: 'bezier', points: rawCurve.points as BezierPoint[] };
  } else {
    curve = { type: 'linear' };
  }

  return {
    kind: readParameterMappingKind(m) as ParsedMapping['kind'],
    enabled: m.enabled !== false,
    sourceMin: num(m.sourceMin, 0),
    sourceMax: num(m.sourceMax, 1),
    targetMin: num(m.targetMin, 0),
    targetMax: num(m.targetMax, 1),
    base: num(m.base, 0),
    depth: signedNum(m.depth, 1),
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

type PreviewNodeKind = 'trackInput' | 'trackOutput' | 'effect' | 'macro' | 'envelope' | 'lfo' | 'sidechainInput' | 'unknown';
type PreviewEdgeKind = 'audio' | 'parameter' | 'sidechain' | 'unknown';

// FXG-SC.6B — eligible sidechain source track (mirrors mixerStore.getEligibleSidechainSources).
export interface SidechainSourceOption {
  sourceTrackId: number;
  name: string;
}

interface PositionedNode {
  id: string;
  type: PreviewNodeKind;
  label: string;
  secondaryText: string | null;
  badges: string[];
  // Effect nodes only: the persisted bypass flag, which drives both the node's
  // power toggle and its "Bypassed" badge.
  bypassed: boolean;
  effectInstanceId: string | null;
  pluginId: string | null;
  parameterPorts: GraphExposedParameterPort[];
  macroValue: number | null;
  // EVC.3 — normalized envelope definition, present only on envelope nodes.
  envelope: EnvelopeNodeData | null;
  // EVC-R3 — compact envelope summary count of outgoing parameter links.
  envelopeParameterEdgeCount: number;
  // Normalized LFO definition, present only on lfo nodes. Mirrors envelope.
  lfo: LfoNodeData | null;
  // Compact LFO summary count of outgoing parameter links.
  lfoParameterEdgeCount: number;
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
  // Splice hit-testing needs the raw endpoints (audio edges only) rather than
  // re-deriving them from `path`. sourceNodeId/targetNodeId let a hit-tested
  // edge be excluded when it's already connected to the node being dragged.
  sourceNodeId?: string;
  targetNodeId?: string;
  sourceX?: number;
  sourceY?: number;
  targetX?: number;
  targetY?: number;
}

interface PreviewModel {
  empty: boolean;
  nodes: PositionedNode[];
  edges: PositionedEdge[];
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
  onAddEffectNode?: (position?: { x: number; y: number }) => void;
  onAddMacroNode?: (position?: { x: number; y: number }) => void;
  // EVC.3 — envelope node add/edit affordances (graph mode only).
  onAddEnvelopeNode?: (position?: { x: number; y: number }) => void;
  onUpdateEnvelope?: (nodeId: string, patch: EnvelopeNodePatch) => void;
  // LFO node add/edit affordances (graph mode only). Mirrors envelope.
  onAddLfoNode?: (position?: { x: number; y: number }) => void;
  onUpdateLfo?: (nodeId: string, patch: LfoNodePatch) => void;
  // FXG-SC.6B — Sidechain Input node add + source selection + key linking.
  onAddSidechainInput?: (position?: { x: number; y: number }) => void;
  onSetSidechainInputSource?: (nodeId: string, sourceTrackId: number | null) => void;
  onConnectSidechain?: (sidechainInputNodeId: string, targetNodeId: string) => void;
  sidechainSources?: SidechainSourceOption[];
  // Scanned plugin metadata — only consulted to resolve a third-party effect
  // node's author tag. Stock effects resolve theirs from the effect catalog.
  vstPlugins?: VstPluginMeta[];
  onRemoveNode?: (nodeId: string) => void;
  // Effect-node bypass toggle (node power button + context-menu item). Absent in
  // read-only preview, where bypass renders as a badge only.
  onSetNodeBypass?: (nodeId: string, bypassed: boolean) => void;
  onConnectNodes?: (sourceNodeId: string, targetNodeId: string) => void;
  // Drag-drop splice: dropping a dragged node onto an audio cable removes it
  // and reconnects it inline between the cable's endpoints, in one undo step.
  onSpliceNodeIntoEdge?: (nodeId: string, edgeId: string, position: { x: number; y: number }) => void;
  onConnectMacroToParameter?: (macroNodeId: string, targetNodeId: string, parameterId: string) => void;
  // EVC-R1 — link an Envelope controlOut to an exposed parameter input port.
  onConnectEnvelopeToParameter?: (envelopeNodeId: string, targetNodeId: string, parameterId: string) => void;
  // Link an LFO controlOut to an exposed parameter input port. Mirrors envelope.
  onConnectLfoToParameter?: (lfoNodeId: string, targetNodeId: string, parameterId: string) => void;
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
  // FXG.4-g — per-link Bezier mapping editor
  onUpdateParameterEdgeMapping?: (edgeId: string, mappingPatch: unknown) => void;
  // FXG.4-h — parent-attached macro automation lane actions (macro nodes only)
  onShowMacroAutomationLane?: (macroNodeId: string) => void;
  onHideMacroAutomationLane?: (macroNodeId: string) => void;
  onCreateMacroAutomationClip?: (macroNodeId: string) => void;
}

// Stable identity so the default never re-triggers memoized consumers.
const EMPTY_VST_PLUGINS: VstPluginMeta[] = [];

const NODE_WIDTH = 148;
const NODE_HEIGHT = 74;
// EVC-R3 — envelope nodes are compact by default. The expanded editor can grow
// visually, but this estimate keeps normal graph layouts dense.
const ENVELOPE_NODE_WIDTH = 236;
const ENVELOPE_NODE_CONTENT_HEIGHT = 112;
// LFO nodes are compact by default like Envelope. The expanded editor (shape
// graph + preset row + rate controls) can grow visually, but this estimate
// keeps normal graph layouts dense.
const LFO_NODE_WIDTH = 236;
const LFO_NODE_CONTENT_HEIGHT = 132;
const PARAMETER_PORT_ROW_HEIGHT = 18;
const PARAMETER_PORT_SECTION_TOP = 8;
const PARAMETER_PORT_SECTION_BOTTOM = 10;
const PARAMETER_PORT_SECTION_HEADER = 12;
const PARAMETER_PORT_SECTION_ROW_GAP = 4;
const PREVIEW_PADDING_X = 24;
const PREVIEW_PADDING_Y = 24;
const FALLBACK_NODE_SPACING_X = 204;
const FALLBACK_NODE_Y = 0;
const DEFAULT_VIEWPORT: GraphStateViewport = Object.freeze({ x: 0, y: 0, zoom: 1 });
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
    type === 'lfo' ||
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

// Mirrors graphState.isSidechainCapableEffectNode: runtime sidechain capability
// gates the sidechainIn port, and missing capability fails closed.
function readSidechainCapability(data: Record<string, unknown> | undefined) {
  const value = data?.sidechain;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const capability = value as Record<string, unknown>;
  if (typeof capability.supported !== 'boolean') return null;
  return {
    supported: capability.supported,
    channels: Number.isInteger(capability.channels) ? capability.channels as number : 0,
    enabled: capability.enabled === true,
  };
}

function isSidechainCapableEffectData(data: Record<string, unknown> | undefined) {
  if (readBoolean(data, 'missing') || readBoolean(data, 'crashed')) return false;
  if (!readString(data, 'effectInstanceId')) return false;
  return readSidechainCapability(data)?.supported === true;
}

interface ResolvedNodeText {
  label: string;
  secondaryText: string | null;
  badges: string[];
  bypassed: boolean;
  effectInstanceId: string | null;
  pluginId: string | null;
  parameterPorts: GraphExposedParameterPort[];
  macroValue: number | null;
  envelope: EnvelopeNodeData | null;
  lfo: LfoNodeData | null;
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
    badges: [],
    bypassed: false,
    effectInstanceId: null,
    pluginId: null,
    parameterPorts: [],
    macroValue: null,
    envelope: null,
    lfo: null,
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
    const effectInstanceId = readString(data, 'effectInstanceId');
    const missing = readBoolean(data, 'missing');
    const bypassed = readBoolean(data, 'bypass');
    const badges: string[] = [];

    if (bypassed) badges.push('Bypassed');
    if (missing) badges.push('Missing');
    if (readBoolean(data, 'crashed')) badges.push('Crashed');

    return {
      ...base,
      label: displayName,
      // An effect module's identity line is its display name plus the author tag
      // rendered in the node's footer (XLETH for stock, the plugin's own vendor
      // for a scanned VST). The raw pluginId used to be echoed here as secondary
      // text, which read as the name printed twice on every stock effect
      // ("Compressor" over "compressor") and as an opaque identifier string on
      // third-party plugins. It carries nothing the vendor tag doesn't.
      secondaryText: null,
      badges,
      bypassed,
      effectInstanceId,
      pluginId,
      parameterPorts: readExposedParameterPorts(data),
      // Placeholder / data-only / missing nodes have no engine processor to open.
      editable: pluginId.length > 0 && pluginId !== 'placeholder' && !missing,
      // Engine-capable effects expose a sidechainIn key target port.
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

  if (type === 'lfo') {
    // A free-running breakpoint control source (like Envelope/Macro): no
    // effectInstanceId, no plugin metadata, no parameter input ports, no macro
    // value — but it does expose a single `controlOut` port that links to
    // exposed effect parameters. The normalized data drives the summary/
    // preview and the compact editor.
    const lfo = readLfoNodeData(data);
    return {
      ...base,
      label: lfo.label,
      secondaryText: 'LFO Modulator',
      lfo,
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
    lfoParameterEdgeCount: 0,
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
  if (text.lfo) {
    return NODE_HEIGHT + LFO_NODE_CONTENT_HEIGHT;
  }
  return nodeHeightForPorts(text.parameterPorts.length)
    + (text.macroValue == null ? 0 : 38)
    + (text.sidechainTarget ? SIDECHAIN_PORT_SECTION_HEIGHT : 0)
    + (text.isSidechainInput ? SIDECHAIN_SOURCE_SELECTOR_HEIGHT : 0);
}

function nodeWidthForType(type: PreviewNodeKind) {
  if (type === 'envelope') return ENVELOPE_NODE_WIDTH;
  if (type === 'lfo') return LFO_NODE_WIDTH;
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
      lfoParameterEdgeCount: 0,
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

function countLfoParameterEdges(edges: GraphStateEdge[], nodes: PositionedNode[]) {
  const lfoNodeIds = new Set(
    nodes.filter((node) => node.type === 'lfo').map((node) => node.id),
  );
  const counts = new Map<string, number>();
  for (const edge of edges) {
    if (edge.type !== 'parameter') continue;
    if (edge.sourcePort !== 'controlOut') continue;
    if (!lfoNodeIds.has(edge.sourceNodeId)) continue;
    counts.set(edge.sourceNodeId, (counts.get(edge.sourceNodeId) ?? 0) + 1);
  }
  return counts;
}

function applyLfoParameterEdgeCounts(nodes: PositionedNode[], edges: GraphStateEdge[]) {
  const counts = countLfoParameterEdges(edges, nodes);
  return nodes.map((node) => node.type === 'lfo'
    ? { ...node, lfoParameterEdgeCount: counts.get(node.id) ?? 0 }
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

// FXG-connect-reach — the audio "in" side anchor, mirroring edgeEndpoints'
// targetX logic (trackInput is the one node type whose audio-relevant edge
// sits on its right instead of its left, but it's never an audio drop target
// itself, so this only ever resolves to the plain left-edge case in practice).
function nodeInPoint(node: PositionedNode) {
  return {
    x: node.type === 'trackInput' ? node.x + node.width : node.x,
    y: node.y + node.height / 2,
  };
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

// Splice-drop cable hit-testing. There's no existing geometric hit-test to
// build on (the edge midpoint "×" button is just a DOM element positioned at
// the linear midpoint, not a curve sample) — these sample the same cubic
// bezier `makeCurvePath` draws and measure distance to the sampled polyline.
const SPLICE_HIT_DISTANCE_PX = 18;
const SPLICE_CURVE_SAMPLES = 16;

function cubicBezierPointAt(
  t: number,
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * x0 + b * x1 + c * x2 + d * x3,
    y: a * y0 + b * y1 + c * y2 + d * y3,
  };
}

function distanceToSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Distance from `point` to the same cubic bezier makeCurvePath renders for
// an audio cable (control points at the horizontal midpoint, per makeCurvePath).
export function distanceToAudioCableCurve(
  point: { x: number; y: number },
  sourceX: number, sourceY: number,
  targetX: number, targetY: number,
  samples = SPLICE_CURVE_SAMPLES,
) {
  const midpointX = sourceX + (targetX - sourceX) / 2;
  let prevX = sourceX;
  let prevY = sourceY;
  let minDistance = Infinity;
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const { x, y } = cubicBezierPointAt(t, sourceX, sourceY, midpointX, sourceY, midpointX, targetY, targetX, targetY);
    const distance = distanceToSegment(point.x, point.y, prevX, prevY, x, y);
    if (distance < minDistance) minDistance = distance;
    prevX = x;
    prevY = y;
  }
  return minDistance;
}

// Finds the nearest audio cable within SPLICE_HIT_DISTANCE_PX of `point`
// (preview/graph-space coordinates, same space as PositionedNode.x/y).
// `excludeNodeId` drops any cable already terminating at the dragged node —
// dropping a node back onto its own cable is a no-op move, not a splice.
export function findAudioCableAtPoint(
  edges: PositionedEdge[],
  point: { x: number; y: number },
  options: { excludeNodeId?: string | null; maxDistance?: number } = {},
): PositionedEdge | null {
  const maxDistance = options.maxDistance ?? SPLICE_HIT_DISTANCE_PX;
  let best: PositionedEdge | null = null;
  let bestDistance = Infinity;
  for (const edge of edges) {
    if (edge.type !== 'audio') continue;
    if (edge.sourceX == null || edge.sourceY == null || edge.targetX == null || edge.targetY == null) continue;
    if (
      options.excludeNodeId != null &&
      (edge.sourceNodeId === options.excludeNodeId || edge.targetNodeId === options.excludeNodeId)
    ) continue;

    const distance = distanceToAudioCableCurve(point, edge.sourceX, edge.sourceY, edge.targetX, edge.targetY);
    if (distance <= maxDistance && distance < bestDistance) {
      bestDistance = distance;
      best = edge;
    }
  }
  return best;
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

// FXG-connect-reach — an audio drop lands on any node that renders the
// audio-input handle (trackOutput/effect; see the `.handle--in` render gate).
// Landing inside a node that lacks it (macro/envelope/lfo/sidechainInput/
// trackInput, or a parameter/sidechain port row within an otherwise-eligible
// effect node) is not a valid audio target.
export function resolveAudioDropTargetFromElement(
  element: Element | null,
  sourceNodeId?: string | null,
): string | null {
  if (!element || typeof element.closest !== 'function') return null;
  const nodeElement = element.closest('[data-node-id]');
  const nodeId = nodeElement?.getAttribute('data-node-id') ?? null;
  if (!nodeId || nodeId === sourceNodeId) return null;
  const hasAudioInput = typeof nodeElement?.querySelector === 'function'
    && nodeElement.querySelector('[data-audio-port-type="audio-input"]') != null;
  if (!hasAudioInput) return null;
  return nodeId;
}

// FXG-connect-reach — releasing (or hovering) a cable near, but not exactly
// on, a compatible port should still connect: this is what makes precise
// dot-hunting unnecessary at low zoom. Distances are measured in *screen*
// space (getBoundingClientRect, which reflects the canvas's CSS zoom
// transform), so a fixed radius behaves the same at any zoom level.
export const CONNECT_SNAP_RADIUS_PX = 24;

function elementCenter(element: Element): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export function findNearestPortWithinRadius(
  candidates: Element[],
  point: { x: number; y: number },
  radius: number = CONNECT_SNAP_RADIUS_PX,
): Element | null {
  let best: Element | null = null;
  let bestDistance = radius;
  for (const candidate of candidates) {
    if (typeof candidate.getBoundingClientRect !== 'function') continue;
    const center = elementCenter(candidate);
    const distance = Math.hypot(center.x - point.x, center.y - point.y);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

// FXG-connect-reach — every element matching `selector` under `root`, minus
// any whose owning node is the connect source itself (never a valid target
// for any connect kind: audio self-loops, and a control/sidechain source
// never renders the port kinds it drags to in the first place).
function queryCompatiblePorts(
  root: ParentNode | null | undefined,
  selector: string,
  sourceNodeId: string | null,
): Element[] {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  return Array.from(root.querySelectorAll(selector)).filter((candidate) => {
    const nodeId = candidate.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null;
    return nodeId != null && nodeId !== sourceNodeId;
  });
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
      ...(type === 'audio'
        ? { sourceNodeId: source.id, targetNodeId: target.id, sourceX, sourceY, targetX, targetY }
        : null),
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
  const nodes = applyLfoParameterEdgeCounts(
    applyEnvelopeParameterEdgeCounts(
      normalizePositionedNodes(sourceNodes, options),
      sourceEdges,
    ),
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

// Free placement: a dragged node's next graph-space position is the drag's
// starting position plus the screen-space pointer delta converted to
// graph-space via the current zoom. No clamping, no grid snapping — nodes can
// land anywhere, including negative coordinates.
export function computeNodeDragPosition(
  drag: { startGraphX: number; startGraphY: number; startClientX: number; startClientY: number },
  clientX: number,
  clientY: number,
  zoom: number,
): { x: number; y: number } {
  return {
    x: drag.startGraphX + (clientX - drag.startClientX) / zoom,
    y: drag.startGraphY + (clientY - drag.startClientY) / zoom,
  };
}

// Track Input / Track Output are routing terminals, not modules you configure,
// so they drop the card treatment entirely and render as a jack glyph: a block
// arrow with a return loop, pointing into the chain for the input and out of it
// for the output. Traced from ui/in.svg and ui/out.svg. Everything paints in
// `currentColor` so the glyph inherits the node's themed text color, and the
// in/out word rides inside the arrowhead in the app's own font (text-anchor
// middle keeps it centered whatever font the theme resolves to).
function TrackIoGlyph({ direction }: { direction: 'in' | 'out' }) {
  const isIn = direction === 'in';
  // The source artwork's own viewBox (0 0 W 476ish) is NOT centered on the
  // glyph's content — the return-loop swirl leaves ~94 units of dead space
  // above the arrow and almost none below, so the visual center of the icon
  // sits at ~59% of the box height, not 50%. Centering that box in the node
  // (as flex alignment does) would leave the cable's actual attachment point
  // — the arrow's tip, a fixed y=274.42 in both source files — sitting above
  // the connection dot instead of on it. Cropping the viewBox to 406 units
  // tall, symmetric around y=274.42, re-centers the tip without touching a
  // single path/polygon coordinate (a viewBox crop is a pure pan, not a
  // rescale, when only one axis's range changes).
  return (
    <svg
      className="xleth-graph-state-preview__io-glyph"
      viewBox={isIn ? '0 71.42 424.82 406' : '0 71.42 443.5 406'}
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <polygon
        fill="currentColor"
        points={isIn
          ? '0 230.22 202.33 221.56 195.04 117.2 391.44 274.42 207.8 440.29 207.8 340.04 0 323.18 0 230.22'
          : '52.06 230.22 254.38 221.56 247.09 117.2 443.5 274.42 259.85 440.29 259.85 340.04 52.06 323.18 52.06 230.22'}
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeMiterlimit={10}
        strokeWidth={18}
        d={isIn
          ? 'M195.72,94.07c120.75-15.18,221.83,82.66,220.08,188.94-1.65,100.28-94.59,191.35-208.74,183.63'
          : 'M229.1,93.02C108.36,77.84,7.27,175.68,9.02,281.95c1.65,100.28,94.59,191.35,208.74,183.63'}
      />
      <text
        className="xleth-graph-state-preview__io-glyph-text"
        x={isIn ? 272 : 305}
        y={311.07}
        textAnchor="middle"
        fontSize={133.01}
      >
        {direction}
      </text>
    </svg>
  );
}

// The standard power mark (a broken ring around a vertical stem), painted in
// currentColor so the button's own themed state drives it.
function PowerGlyph() {
  return (
    <svg
      className="xleth-graph-state-preview__power-glyph"
      viewBox="0 0 16 16"
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.8}
        d="M5.1 4.4a4.6 4.6 0 1 0 5.8 0"
      />
      <line
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth={1.8}
        x1={8}
        y1={2.2}
        x2={8}
        y2={7.6}
      />
    </svg>
  );
}

export function GraphStatePreviewNode({
  node,
  dragging,
  connectEnabled,
  connectParameterEnabled = false,
  connectEnvelopeParameterEnabled = false,
  connectLfoParameterEnabled = false,
  connectSidechainEnabled = false,
  connectActive,
  hoveredParameterPortId = null,
  hoveredSidechainPort = false,
  hoveredAudioTarget = false,
  connectGuidance = null,
  sidechainSources = [],
  vstPlugins = [],
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onConnectPointerDown,
  onConnectPointerMove,
  onConnectPointerUp,
  onConnectPointerCancel,
  onNodeContextMenu,
  onEdit,
  onToggleBypass,
  onMacroValueCommit,
  onMacroRenameCommit,
  onEnvelopeUpdate,
  onLfoUpdate,
  onSetSidechainSource,
}: {
  node: PositionedNode;
  dragging: boolean;
  connectEnabled: boolean;
  connectParameterEnabled?: boolean;
  connectEnvelopeParameterEnabled?: boolean;
  // Enables the LFO node's controlOut handle as a parameter-link drag source.
  connectLfoParameterEnabled?: boolean;
  // FXG-SC.6B — enables the Sidechain Input node's sidechainOut handle as a drag source.
  connectSidechainEnabled?: boolean;
  connectActive: boolean;
  hoveredParameterPortId?: string | null;
  // FXG-SC.6B — true when a sidechain drag is hovering this effect node's sidechainIn port.
  hoveredSidechainPort?: boolean;
  // FXG-connect-reach — true when an audio drag's snap target (exact hit, or
  // nearest compatible node within the snap radius) is this node.
  hoveredAudioTarget?: boolean;
  // FXG-connect-reach — drag guidance: 'valid' glows the node as a legal drop
  // target for the in-flight connect kind, 'invalid' dims it. null outside a drag.
  connectGuidance?: 'valid' | 'invalid' | null;
  // FXG-SC.6B — eligible source tracks for the Sidechain Input source selector.
  sidechainSources?: SidechainSourceOption[];
  // Scanned plugin metadata, used only to resolve a third-party effect's author
  // for the node footer tag. Stock effects never consult it.
  vstPlugins?: VstPluginMeta[];
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>, node: PositionedNode) => void;
  onPointerMove?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onConnectPointerDown?: (event: React.PointerEvent<HTMLSpanElement>, node: PositionedNode) => void;
  onConnectPointerMove?: (event: React.PointerEvent<HTMLSpanElement>) => void;
  onConnectPointerUp?: (event: React.PointerEvent<HTMLSpanElement>) => void;
  onConnectPointerCancel?: (event: React.PointerEvent<HTMLSpanElement>) => void;
  // Right-click on a node opens its context menu (Edit/Remove and, for
  // effect/macro nodes, the richer parameter-exposure/automation menu).
  onNodeContextMenu?: (event: React.MouseEvent<HTMLDivElement>, node: PositionedNode) => void;
  // Also wired to double-click on editable effect nodes — the same action as
  // the context menu's Edit item.
  onEdit?: (nodeId: string) => void;
  // Effect nodes only — flips the effect's bypass. Absent in read-only preview,
  // which renders the state as a badge with no toggle.
  onToggleBypass?: (nodeId: string, bypassed: boolean) => void;
  onMacroValueCommit?: (nodeId: string, value: number) => void;
  onMacroRenameCommit?: (nodeId: string, label: string) => void;
  // EVC.3 — envelope node edit callback. When absent, the envelope renders read-only.
  onEnvelopeUpdate?: (nodeId: string, patch: EnvelopeNodePatch) => void;
  // LFO node edit callback. When absent, the LFO renders read-only. Mirrors envelope.
  onLfoUpdate?: (nodeId: string, patch: LfoNodePatch) => void;
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
  // An LFO node is a control-source definition like Macro/Envelope: no audio
  // handles, no parameter input ports, but it does expose a single
  // `controlOut` port that drags to an exposed parameter port.
  const isLfo = node.type === 'lfo';
  // A control source emits a `controlOut` that links to exposed effect parameters.
  const isControlSource = isMacro || isEnvelope || isLfo;
  const controlSourceKind = isMacro ? 'macro' : isEnvelope ? 'envelope' : isLfo ? 'lfo' : null;
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
    ((isMacro && connectParameterEnabled) ||
      (isEnvelope && connectEnvelopeParameterEnabled) ||
      (isLfo && connectLfoParameterEnabled));
  const interactiveOut = interactiveAudioOut || interactiveControlOut;
  // FXG-SC.6B — the Sidechain Input node's sidechainOut is interactive when sidechain
  // linking is enabled. It is its own connect-source kind, separate from audio/control.
  const interactiveSidechainOut =
    isSidechainInput && connectSidechainEnabled && !node.virtual && typeof onConnectPointerDown === 'function';
  // Edit/Remove live in the right-click context menu (GraphParameterContextMenu),
  // not as always-visible node-body buttons. Double-click mirrors the context
  // menu's Edit action for editable effect nodes only — other node types have
  // no external editor to open.
  const canOpenContextMenu =
    (node.type === 'effect' || node.type === 'macro' || node.type === 'envelope' || node.type === 'lfo') &&
    !node.virtual &&
    typeof onNodeContextMenu === 'function';
  const canDoubleClickEdit =
    node.type === 'effect' && node.editable && !node.virtual && typeof onEdit === 'function';
  const isTrackIo = node.type === 'trackInput' || node.type === 'trackOutput';
  // The author tag in an effect node's footer: 'XLETH' for a stock effect, the
  // scanned plugin's own vendor for a third party, nothing when neither resolves.
  const vendorTag = node.type === 'effect'
    ? resolveEffectVendorTag(node.pluginId, vstPlugins)
    : null;
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
        hoveredAudioTarget ? 'xleth-graph-state-preview__node--audio-drop-target' : '',
        connectGuidance === 'valid' ? 'xleth-graph-state-preview__node--connect-valid-target' : '',
        connectGuidance === 'invalid' ? 'xleth-graph-state-preview__node--connect-invalid-target' : '',
      ].filter(Boolean).join(' ')}
      data-node-id={node.id}
      data-node-type={node.type}
      data-bypassed={node.type === 'effect' && node.bypassed ? 'true' : undefined}
      data-parameter-drop-node={hoveredParameterPortId ? 'true' : undefined}
      data-audio-drop-node={hoveredAudioTarget ? 'true' : undefined}
      data-connect-guidance={connectGuidance ?? undefined}
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
      onDoubleClick={canDoubleClickEdit ? (event) => { event.stopPropagation(); onEdit?.(node.id); } : undefined}
    >
      {node.type !== 'trackInput' && node.type !== 'macro' && !isEnvelope && !isLfo && !isSidechainInput && (
        <span
          className="xleth-graph-state-preview__handle xleth-graph-state-preview__handle--in"
          data-audio-port-type="audio-input"
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
      {/* Effect power toggle. Bypass is otherwise a one-way trip in graph mode: a
          chain converted with bypassed effects renders a "Bypassed" badge with no
          affordance to clear it. Mirrors the Mixer Chain module's bypass button. */}
      {node.type === 'effect' && !node.virtual && typeof onToggleBypass === 'function' && (
        <button
          className={[
            'xleth-graph-state-preview__node-power',
            node.bypassed ? 'xleth-graph-state-preview__node-power--bypassed' : '',
          ].filter(Boolean).join(' ')}
          type="button"
          aria-pressed={node.bypassed}
          aria-label={node.bypassed ? `Enable ${node.label}` : `Bypass ${node.label}`}
          title={node.bypassed ? 'Enable' : 'Bypass'}
          // The node body is a drag handle and a double-click editor target; neither
          // should fire when the toggle is what was hit.
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onToggleBypass(node.id, !node.bypassed);
          }}
        >
          <PowerGlyph />
        </button>
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
        <>
          {isTrackIo && <TrackIoGlyph direction={node.type === 'trackInput' ? 'in' : 'out'} />}
          {/* The glyph already reads "in"/"out", so on a terminal the title is
              kept for assistive tech and visually clipped rather than removed. */}
          <span
            className={[
              'xleth-graph-state-preview__node-title',
              isTrackIo ? 'xleth-graph-state-preview__node-title--io' : '',
            ].filter(Boolean).join(' ')}
          >
            {node.label}
          </span>
        </>
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
      {/* The effect's author, sitting at the foot of the name block: 'XLETH' on a
          stock effect, the plugin's own vendor on a third party. It takes the row
          the echoed pluginId used to occupy, so the node's height is unchanged. */}
      {vendorTag && (
        <span className="xleth-graph-state-preview__node-vendor" title={vendorTag}>
          {vendorTag}
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
      {isLfo && node.lfo && (
        <LfoNodeBody
          nodeId={node.id}
          data={node.lfo}
          parameterCount={node.lfoParameterEdgeCount}
          onChange={
            typeof onLfoUpdate === 'function'
              ? (patch) => onLfoUpdate(node.id, patch)
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
      {/* Sidechain key target port. Distinct from audio
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
  const isModulation = mapping.kind === 'modulation';
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

      {/* EVC-R4 — the output section depends on the mapping kind. A modulation edge
          (Envelope) edits Base + signed Depth; a range edge (Macro) keeps the absolute
          Min/Max output range. There is deliberately no second, unlabelled scale on the
          Envelope node any more: Depth is the only one. */}
      {isModulation ? (
        <div className="xleth-graph-state-preview__mapping-editor-section">
          <div className="xleth-graph-state-preview__mapping-editor-section-title">Modulation</div>
          <div className="xleth-graph-state-preview__mapping-editor-hint">
            Value = Base + Depth × envelope. Base is the parameter&apos;s own setting; the
            envelope only offsets it.
          </div>
          <div className="xleth-graph-state-preview__mapping-editor-range-row xleth-graph-state-preview__mapping-editor-range-row--modulation">
            <span className="xleth-graph-state-preview__mapping-editor-range-label">Base</span>
            <input
              className="xleth-graph-state-preview__mapping-editor-range-slider"
              type="range" min="0" max="1" step="0.01" defaultValue={mapping.base}
              aria-label="Modulation base"
              onPointerUp={(e) => onUpdate(edgeId, { base: parseFloat((e.target as HTMLInputElement).value) })}
            />
            <input
              className="xleth-graph-state-preview__mapping-editor-range-num"
              type="number" min="0" max="1" step="0.01" defaultValue={mapping.base}
              aria-label="Modulation base value"
              onBlur={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onUpdate(edgeId, { base: clampUnit(v) }); }}
            />
          </div>
          <div className="xleth-graph-state-preview__mapping-editor-range-row xleth-graph-state-preview__mapping-editor-range-row--modulation">
            <span className="xleth-graph-state-preview__mapping-editor-range-label">Depth</span>
            <input
              className="xleth-graph-state-preview__mapping-editor-range-slider"
              type="range" min="-1" max="1" step="0.01" defaultValue={mapping.depth}
              aria-label="Modulation depth"
              onPointerUp={(e) => onUpdate(edgeId, { depth: parseFloat((e.target as HTMLInputElement).value) })}
            />
            <input
              className="xleth-graph-state-preview__mapping-editor-range-num"
              type="number" min="-1" max="1" step="0.01" defaultValue={mapping.depth}
              aria-label="Modulation depth value"
              onBlur={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onUpdate(edgeId, { depth: clampSignedUnit(v) }); }}
            />
          </div>
        </div>
      ) : (
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
      )}

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

      {/* Resulting parameter value at three source positions. For a modulation edge the 0%
          row IS the base value, which is the clearest possible statement of "idle = base". */}
      <div
        className="xleth-graph-state-preview__mapping-editor-preview"
        aria-label={isModulation ? 'Modulation preview' : 'Mapping preview'}
      >
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
  onToggleBypass,
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
  // Effect nodes only — the menu's mirror of the node's power toggle.
  onToggleBypass?: () => void;
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

  // Envelope/LFO nodes are inert control-source definitions edited inline in
  // the node body (EnvelopeNodeBody/LfoNodeBody) — the context menu offers
  // only Remove; there is no external editor to open (no Edit item, mirroring
  // the node body's former showEdit gate which excluded these types).
  if (node.type === 'envelope' || node.type === 'lfo') {
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
      </div>
    );
  }

  const parameters = result?.ok ? result.parameters ?? [] : [];
  const parameterGroups = buildExposeParameterMenuGroups(parameters, {
    pluginId: node.pluginId,
    effectKind: result?.effectKind,
    pluginFormat: result?.pluginFormat,
    resultPluginId: result?.pluginId,
    bandCount: result?.bandCount,
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
        role="menuitemcheckbox"
        aria-checked={node.bypassed}
        disabled={!onToggleBypass}
        onClick={onToggleBypass}
      >
        {node.bypassed ? 'Enable' : 'Bypass'}
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
                      // Marks the exposure rows apart from the menu's other
                      // checkable items (the effect's bypass toggle).
                      data-menu-item="parameter"
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

// Canvas empty-space "Add Plugin / Add Modulator" menu.
//
// Deliberately built on this panel's OWN menu shell
// (`xleth-graph-state-preview__context-menu`, same as GraphParameterContextMenu)
// rather than the generic `.context-menu` used by TrackContextMenu elsewhere in
// the app. The FX Graph panel renders inside window layers that set
// `pointer-events: none` (see .xleth-floating-window-layer in windowing.css);
// this panel's menu class is the one that explicitly restores
// `pointer-events: auto`, so a generic menu portaled here renders but never
// receives clicks. Modulators are a grouped section, not a hover submenu —
// nothing to hover-target and no second positioning system to maintain.
export interface GraphCanvasAddMenuAction {
  key: string;
  label: string;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
}

export function GraphCanvasAddMenu({
  x,
  y,
  pluginAction = null,
  modulatorActions = [],
}: {
  x: number;
  y: number;
  pluginAction?: GraphCanvasAddMenuAction | null;
  modulatorActions?: GraphCanvasAddMenuAction[];
}) {
  return (
    <div
      className="xleth-graph-state-preview__context-menu xleth-graph-state-preview__add-menu"
      role="menu"
      aria-label="Add graph node"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {pluginAction && (
        <button
          className="xleth-graph-state-preview__context-item"
          type="button"
          role="menuitem"
          disabled={pluginAction.disabled}
          title={pluginAction.title}
          onClick={pluginAction.onSelect}
        >
          {pluginAction.label}
        </button>
      )}
      {modulatorActions.length > 0 && (
        <div className="xleth-graph-state-preview__context-section">
          <div className="xleth-graph-state-preview__context-section-title">
            Add Modulator
          </div>
          {modulatorActions.map((action) => (
            <button
              className="xleth-graph-state-preview__context-item"
              type="button"
              role="menuitem"
              key={action.key}
              disabled={action.disabled}
              title={action.title}
              onClick={action.onSelect}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
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
  onAddLfoNode,
  onUpdateLfo,
  onAddSidechainInput,
  onSetSidechainInputSource,
  onConnectSidechain,
  sidechainSources = [],
  vstPlugins = EMPTY_VST_PLUGINS,
  onRemoveNode,
  onSetNodeBypass,
  onConnectNodes,
  onSpliceNodeIntoEdge,
  onConnectMacroToParameter,
  onConnectEnvelopeToParameter,
  onConnectLfoToParameter,
  onDisconnectEdge,
  onEditNode,
  onUpdateMacroValue,
  onRenameMacroNode,
  trackId = null,
  fetchGraphEffectParameters,
  onToggleParameterPort,
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
    width: number;
    height: number;
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
    sourceKind: 'audio' | 'macro' | 'envelope' | 'lfo' | 'sidechain';
  } | null>(null);
  const hoveredParameterTargetRef = React.useRef<ParameterDropTarget | null>(null);
  // FXG-SC.6B — sidechain drag hover target (effect sidechainIn port).
  const hoveredSidechainTargetRef = React.useRef<SidechainDropTarget | null>(null);
  // FXG-connect-reach — audio drag hover target (a node id, since an audio
  // drop's target is the node body rather than a specific port).
  const hoveredAudioTargetRef = React.useRef<string | null>(null);
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
  const [hoveredAudioTarget, setHoveredAudioTarget] = React.useState<string | null>(null);
  const [contextMenu, setContextMenu] = React.useState<{
    node: PositionedNode;
    x: number;
    y: number;
  } | null>(null);
  // Canvas empty-space right-click menu: "Add Plugin" / "Add Modulator", spawned
  // at the click's graph position.
  const [addMenu, setAddMenu] = React.useState<{
    x: number;
    y: number;
    graphPosition: { x: number; y: number };
  } | null>(null);
  // The viewport at the moment either menu opened — panning/zooming away from it
  // closes the menu (its screen anchor and graph-space spawn point are stale).
  const menuOpenViewportRef = React.useRef<GraphStateViewport | null>(null);
  const [parameterResult, setParameterResult] = React.useState<GraphParameterResult | null>(null);
  const [parameterLoading, setParameterLoading] = React.useState(false);
  const [parameterSearch, setParameterSearch] = React.useState('');
  const [mappingEditorState, setMappingEditorState] = React.useState<{
    edgeId: string;
    x: number;
    y: number;
  } | null>(null);
  // Splice-drop: the audio cable currently under the dragged node's center,
  // highlighted as a drop target. Computed against `staticPreviewModel` below
  // (the dragged node's own edges are excluded from candidates, so its
  // in-flight preview position never affects which cable is under test).
  const [spliceTargetEdgeId, setSpliceTargetEdgeId] = React.useState<string | null>(null);
  const model = React.useMemo(
    () => buildGraphStatePreviewModel(
      graphState,
      dragPreviewPosition
        ? { nodePositionOverrides: { [dragPreviewPosition.nodeId]: dragPreviewPosition } }
        : undefined,
    ),
    [dragPreviewPosition, graphState],
  );
  // Undragged edge geometry, used only for splice hit-testing — deliberately
  // NOT recomputed from dragPreviewPosition (see spliceTargetEdgeId comment).
  const staticPreviewModel = React.useMemo(
    () => buildGraphStatePreviewModel(graphState),
    [graphState],
  );
  const viewport = React.useMemo(
    () => normalizeViewport(graphState?.viewport),
    [graphState?.viewport],
  );

  const canvasStyle: React.CSSProperties = {
    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
  };
  const hasHeader = notice != null || model.empty;
  const canDragNodes = typeof onNodePositionChange === 'function' || typeof onSpliceNodeIntoEdge === 'function';
  const canEditViewport = typeof onViewportChange === 'function';
  const canAddNode = typeof onAddEffectNode === 'function';
  const canAddMacro = typeof onAddMacroNode === 'function';
  const canAddEnvelope = typeof onAddEnvelopeNode === 'function';
  const canEditEnvelope = typeof onUpdateEnvelope === 'function';
  const canAddLfo = typeof onAddLfoNode === 'function';
  const canEditLfo = typeof onUpdateLfo === 'function';
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
  const canConnectLfoParameters = typeof onConnectLfoToParameter === 'function';
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
  // The right-click node menu carries Edit/Remove (formerly always-visible node-body
  // buttons) plus, for effect/macro nodes, the parameter-exposure/automation extras —
  // so it must open whenever any of those affordances is wired, not only the extras.
  const canOpenNodeMenu = canExposeParameters || canMacroAutomation || canRemoveNode || canEditNode;
  // Canvas empty-space right-click: "Add Plugin" / "Add Modulator" menu.
  const canAddAnything =
    canAddNode || canAddMacro || canAddEnvelope || canAddLfo || canAddSidechainInput;

  const closeContextMenu = React.useCallback(() => {
    setContextMenu(null);
    setParameterResult(null);
    setParameterLoading(false);
    setParameterSearch('');
  }, []);

  const closeAddMenu = React.useCallback(() => {
    setAddMenu(null);
  }, []);

  // Every add-menu item does the same two things: close the menu, then run its
  // add action at the right-click's graph position.
  const runAddMenuAction = React.useCallback((
    add?: (position?: { x: number; y: number }) => void,
  ) => {
    const position = addMenu?.graphPosition;
    closeAddMenu();
    add?.(position);
  }, [addMenu?.graphPosition, closeAddMenu]);

  // Outside-click / Escape close for the add menu. Mirrors the node context
  // menu's effect below; the shared `__context-menu` class is what marks a
  // click as "inside a menu".
  React.useEffect(() => {
    if (!addMenu) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        typeof Element !== 'undefined' &&
        target instanceof Element &&
        target.closest('.xleth-graph-state-preview__context-menu')
      ) {
        return;
      }
      closeAddMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAddMenu();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [addMenu, closeAddMenu]);

  // Pan/zoom invalidates a menu's screen anchor (and the add menu's graph-space
  // spawn point), so either menu closes as soon as the viewport it opened under
  // moves.
  React.useEffect(() => {
    if (!contextMenu && !addMenu) return;
    const openedViewport = menuOpenViewportRef.current;
    if (
      openedViewport &&
      (openedViewport.x !== viewport.x || openedViewport.y !== viewport.y || openedViewport.zoom !== viewport.zoom)
    ) {
      closeContextMenu();
      closeAddMenu();
    }
  }, [viewport, contextMenu, addMenu, closeContextMenu, closeAddMenu]);

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
    // automation menu; envelope/lfo nodes open a plain Edit/Remove menu. Other node
    // types (Track I/O, Sidechain Input) have no menu.
    const isEffect = node.type === 'effect';
    const isMacro = node.type === 'macro';
    const isEnvelope = node.type === 'envelope';
    const isLfo = node.type === 'lfo';
    if ((!isEffect && !isMacro && !isEnvelope && !isLfo) || node.virtual) return;
    event.preventDefault();
    event.stopPropagation();
    closeAddMenu();
    menuOpenViewportRef.current = viewport;
    setContextMenu({
      node,
      x: event.clientX,
      y: event.clientY,
    });
  }, [closeAddMenu, viewport]);

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

  const handleContextToggleBypass = React.useCallback(() => {
    const node = contextMenu?.node;
    closeContextMenu();
    if (node?.type === 'effect') onSetNodeBypass?.(node.id, !node.bypassed);
  }, [closeContextMenu, contextMenu?.node, onSetNodeBypass]);

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
    const targetEdgeId = spliceTargetEdgeId;
    setSpliceTargetEdgeId(null);

    if (!commitPosition) return;
    if (drag.currentGraphX === drag.startGraphX && drag.currentGraphY === drag.startGraphY) return;

    const position = { x: drag.currentGraphX, y: drag.currentGraphY };
    // A highlighted splice target wins over a plain move. Ports being
    // occupied/incompatible clears spliceTargetEdgeId during drag (see
    // handleNodePointerMove), so that case already falls through to a plain
    // move here rather than needing a separate fallback branch.
    if (targetEdgeId && onSpliceNodeIntoEdge) {
      onSpliceNodeIntoEdge(drag.nodeId, targetEdgeId, position);
      return;
    }
    if (onNodePositionChange) {
      onNodePositionChange(drag.nodeId, position);
    }
  }, [onNodePositionChange, onSpliceNodeIntoEdge, spliceTargetEdgeId]);

  const cancelDrag = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    finishDrag(event, false);
  }, [finishDrag]);

  // Escape cancels an in-flight drag exactly like pointercancel: clearing
  // dragRef makes the eventual pointerup a no-op (finishDrag's guard clause
  // returns immediately when drag.pointerId no longer matches/exists), so the
  // node snaps back and the graph is left untouched.
  React.useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || !dragRef.current) return;
      dragRef.current = null;
      setDraggingNodeId(null);
      setDragPreviewPosition(null);
      setSpliceTargetEdgeId(null);
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

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
      width: node.width,
      height: node.height,
    };
    setDraggingNodeId(node.id);
  }, [canDragNodes]);

  const handleNodePointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!onNodePositionChange && !onSpliceNodeIntoEdge) return;

    event.preventDefault();
    const next = computeNodeDragPosition(drag, event.clientX, event.clientY, viewport.zoom);
    drag.currentGraphX = next.x;
    drag.currentGraphY = next.y;
    setDragPreviewPosition({
      nodeId: drag.nodeId,
      x: next.x,
      y: next.y,
    });

    if (onSpliceNodeIntoEdge) {
      const center = {
        x: next.x + PREVIEW_PADDING_X + drag.width / 2,
        y: next.y + PREVIEW_PADDING_Y + drag.height / 2,
      };
      const candidate = findAudioCableAtPoint(staticPreviewModel.edges, center, {
        excludeNodeId: drag.nodeId,
      });
      if (candidate && canSpliceGraphNodeIntoEdge(graphState, { edgeId: candidate.id, nodeId: drag.nodeId }).ok) {
        setSpliceTargetEdgeId(candidate.id);
      } else {
        setSpliceTargetEdgeId(null);
      }
    }
  }, [graphState, onNodePositionChange, onSpliceNodeIntoEdge, staticPreviewModel, viewport.zoom]);

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

  // FXG.3-l — fit the view once per track-open instead of restoring whatever zoom
  // was last persisted, so a graph never loads at an arbitrary stored zoom (e.g.
  // 74%). Guarded by trackId (not model/viewport) so this fires exactly once when
  // the workspace opens or the selected track changes, and never fights a
  // subsequent manual pan/zoom or re-fires on every node add/edit.
  const fitOnOpenTrackRef = React.useRef<number | string | null | undefined>(undefined);
  React.useEffect(() => {
    if (!canEditViewport || model.empty) return;
    if (fitOnOpenTrackRef.current === trackId) return;
    fitOnOpenTrackRef.current = trackId;
    const frame = requestAnimationFrame(() => handleFitView());
    return () => cancelAnimationFrame(frame);
  }, [canEditViewport, model.empty, trackId, handleFitView]);

  const toCanvasPoint = React.useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: (clientX - rect.left) / viewport.zoom, y: (clientY - rect.top) / viewport.zoom };
  }, [viewport.zoom]);

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

  // Right-click on empty canvas space (not a node — those open their own menu
  // via handleNodeContextMenu) opens the "Add Plugin" / "Add Modulator" menu at
  // the click's graph position. toCanvasPoint already returns the canvas's own
  // unscaled coordinate space (i.e. node.x/node.y), so subtracting the preview
  // padding yields the same graph position a dropped node would persist.
  const handleCanvasContextMenu = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!canAddAnything) return;
    const target = event.target;
    if (
      typeof Element !== 'undefined' &&
      target instanceof Element &&
      target.closest('.xleth-graph-state-preview__node')
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const point = toCanvasPoint(event.clientX, event.clientY);
    const graphPosition = point
      ? { x: point.x - PREVIEW_PADDING_X, y: point.y - PREVIEW_PADDING_Y }
      : { x: 0, y: 0 };
    closeContextMenu();
    menuOpenViewportRef.current = viewport;
    setAddMenu({ x: event.clientX, y: event.clientY, graphPosition });
  }, [canAddAnything, toCanvasPoint, closeContextMenu, viewport]);

  // Double-click on empty canvas space (same "not a node" guard as the
  // right-click add menu above) frames the whole graph — the toolbar's old
  // Fit View button, now reachable without a dedicated control.
  const handleCanvasDoubleClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!canEditViewport) return;
    const target = event.target;
    if (
      typeof Element !== 'undefined' &&
      target instanceof Element &&
      target.closest('.xleth-graph-state-preview__node')
    ) {
      return;
    }
    handleFitView();
  }, [canEditViewport, handleFitView]);

  const resetConnect = React.useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    if (connectRef.current?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      connectRef.current = null;
      hoveredParameterTargetRef.current = null;
      hoveredSidechainTargetRef.current = null;
      hoveredAudioTargetRef.current = null;
      setConnectingFromNodeId(null);
      setConnectPoint(null);
      setHoveredParameterTarget(null);
      setHoveredSidechainTarget(null);
      setHoveredAudioTarget(null);
    }
  }, []);

  const updateHoveredParameterTarget = React.useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    const connect = connectRef.current;
    // Parameter-drop highlighting applies to every control source (macro/envelope/lfo).
    const isControlSource = connect?.sourceKind === 'macro' || connect?.sourceKind === 'envelope' || connect?.sourceKind === 'lfo';
    if (!connect || connect.pointerId !== event.pointerId || !isControlSource) return;

    const point = { x: event.clientX, y: event.clientY };
    const dropElement = typeof document !== 'undefined'
      ? document.elementFromPoint(point.x, point.y)
      : null;
    let nextTarget = resolveParameterDropTargetFromElement(dropElement, connect.sourceNodeId);
    if (!nextTarget) {
      const candidates = queryCompatiblePorts(
        canvasRef.current,
        '[data-parameter-port-type="parameter-input"][data-parameter-port-id]',
        connect.sourceNodeId,
      );
      nextTarget = resolveParameterDropTargetFromElement(
        findNearestPortWithinRadius(candidates, point),
        connect.sourceNodeId,
      );
    }
    const previous = hoveredParameterTargetRef.current;
    if (previous?.portId === nextTarget?.portId) return;
    hoveredParameterTargetRef.current = nextTarget;
    setHoveredParameterTarget(nextTarget);
  }, []);

  // FXG-SC.6B — highlight the compressor sidechainIn port under a sidechain drag.
  const updateHoveredSidechainTarget = React.useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    const connect = connectRef.current;
    if (!connect || connect.pointerId !== event.pointerId || connect.sourceKind !== 'sidechain') return;

    const point = { x: event.clientX, y: event.clientY };
    const dropElement = typeof document !== 'undefined'
      ? document.elementFromPoint(point.x, point.y)
      : null;
    let nextTarget = resolveSidechainDropTargetFromElement(dropElement, connect.sourceNodeId);
    if (!nextTarget) {
      const candidates = queryCompatiblePorts(
        canvasRef.current,
        '[data-sidechain-port-type="sidechain-input"][data-sidechain-port-id]',
        connect.sourceNodeId,
      );
      nextTarget = resolveSidechainDropTargetFromElement(
        findNearestPortWithinRadius(candidates, point),
        connect.sourceNodeId,
      );
    }
    const previous = hoveredSidechainTargetRef.current;
    if (previous?.portId === nextTarget?.portId) return;
    hoveredSidechainTargetRef.current = nextTarget;
    setHoveredSidechainTarget(nextTarget);
  }, []);

  // FXG-connect-reach — highlight the node an audio drag would land on: an
  // exact hit first, then the nearest compatible node within the snap radius.
  const updateHoveredAudioTarget = React.useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    const connect = connectRef.current;
    if (!connect || connect.pointerId !== event.pointerId || connect.sourceKind !== 'audio') return;

    const point = { x: event.clientX, y: event.clientY };
    const dropElement = typeof document !== 'undefined'
      ? document.elementFromPoint(point.x, point.y)
      : null;
    let nextTarget = resolveAudioDropTargetFromElement(dropElement, connect.sourceNodeId);
    if (!nextTarget) {
      const candidates = queryCompatiblePorts(
        canvasRef.current,
        '[data-audio-port-type="audio-input"]',
        connect.sourceNodeId,
      );
      nextTarget = resolveAudioDropTargetFromElement(
        findNearestPortWithinRadius(candidates, point),
        connect.sourceNodeId,
      );
    }
    const previous = hoveredAudioTargetRef.current;
    if (previous === nextTarget) return;
    hoveredAudioTargetRef.current = nextTarget;
    setHoveredAudioTarget(nextTarget);
  }, []);

  const handleConnectPointerDown = React.useCallback((
    event: React.PointerEvent<HTMLSpanElement>,
    node: PositionedNode,
  ) => {
    const isMacro = node.type === 'macro';
    const isEnvelope = node.type === 'envelope';
    const isLfo = node.type === 'lfo';
    const isSidechainInput = node.type === 'sidechainInput';
    const allowed = isMacro
      ? canConnectParameters
      : isEnvelope
        ? canConnectEnvelopeParameters
        : isLfo
          ? canConnectLfoParameters
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
      sourceKind: isMacro ? 'macro' : isEnvelope ? 'envelope' : isLfo ? 'lfo' : isSidechainInput ? 'sidechain' : 'audio',
    };
    hoveredParameterTargetRef.current = null;
    hoveredSidechainTargetRef.current = null;
    hoveredAudioTargetRef.current = null;
    setConnectingFromNodeId(node.id);
    setConnectPoint(toCanvasPoint(event.clientX, event.clientY));
    setHoveredParameterTarget(null);
    setHoveredSidechainTarget(null);
    setHoveredAudioTarget(null);
  }, [canConnect, canConnectParameters, canConnectEnvelopeParameters, canConnectLfoParameters, canConnectSidechain, toCanvasPoint]);

  const handleConnectPointerMove = React.useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    const connect = connectRef.current;
    if (!connect || connect.pointerId !== event.pointerId) return;

    event.preventDefault();
    setConnectPoint(toCanvasPoint(event.clientX, event.clientY));
    updateHoveredParameterTarget(event);
    updateHoveredSidechainTarget(event);
    updateHoveredAudioTarget(event);
  }, [toCanvasPoint, updateHoveredParameterTarget, updateHoveredSidechainTarget, updateHoveredAudioTarget]);

  const handleConnectPointerUp = React.useCallback((event: React.PointerEvent<HTMLSpanElement>) => {
    const connect = connectRef.current;
    if (!connect || connect.pointerId !== event.pointerId) return;

    event.preventDefault();
    const sourceNodeId = connect.sourceNodeId;

    // Control-source controlOut (macro/envelope/lfo) → exposed parameter input
    // port creates a parameter edge. The drop must land on the highlighted
    // parameter port; node bodies and audio handles no-op.
    if (connect.sourceKind === 'macro' || connect.sourceKind === 'envelope' || connect.sourceKind === 'lfo') {
      const target = hoveredParameterTargetRef.current;
      const onConnect = connect.sourceKind === 'macro'
        ? onConnectMacroToParameter
        : connect.sourceKind === 'envelope'
          ? onConnectEnvelopeToParameter
          : onConnectLfoToParameter;

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

    // Audio out → a node that renders the audio-input handle creates an audio
    // edge. The drop must land on (or, within the snap radius, near) the
    // highlighted target; parameter/sidechain port rows and incompatible node
    // types (macro/envelope/lfo/sidechainInput/trackInput) never resolve here
    // since resolveAudioDropTargetFromElement gates on the audio-input handle.
    const targetNodeId = hoveredAudioTargetRef.current;

    resetConnect(event);

    if (onConnectNodes && targetNodeId && targetNodeId !== sourceNodeId) {
      onConnectNodes(sourceNodeId, targetNodeId);
    }
  }, [onConnectMacroToParameter, onConnectEnvelopeToParameter, onConnectLfoToParameter, onConnectSidechain, onConnectNodes, resetConnect]);

  const connectingNode = connectingFromNodeId
    ? model.nodes.find((node) => node.id === connectingFromNodeId)
    : undefined;
  const hoveredParameterNode = hoveredParameterTarget
    ? model.nodes.find((node) => node.id === hoveredParameterTarget.nodeId)
    : undefined;
  const hoveredSidechainNode = hoveredSidechainTarget
    ? model.nodes.find((node) => node.id === hoveredSidechainTarget.nodeId)
    : undefined;
  const hoveredAudioNode = hoveredAudioTarget
    ? model.nodes.find((node) => node.id === hoveredAudioTarget)
    : undefined;
  const displayedConnectPoint = hoveredParameterNode
    ? parameterPortAnchor(hoveredParameterNode, hoveredParameterTarget?.parameterId ?? null)
    : hoveredSidechainNode
      ? sidechainPortAnchor(hoveredSidechainNode)
      : hoveredAudioNode
        ? nodeInPoint(hoveredAudioNode)
        : connectPoint;
  // FXG-connect-reach — the active connect kind's compatibility rule, used to
  // glow every legal drop target and dim the rest for the duration of the drag.
  const connectSourceKind = connectingFromNodeId ? connectRef.current?.sourceKind ?? null : null;
  const isValidConnectTargetNode = React.useCallback((node: PositionedNode): boolean => {
    if (node.virtual) return false;
    if (connectSourceKind === 'audio') return node.type === 'trackOutput' || node.type === 'effect';
    if (connectSourceKind === 'macro' || connectSourceKind === 'envelope' || connectSourceKind === 'lfo') {
      return node.parameterPorts.length > 0;
    }
    if (connectSourceKind === 'sidechain') return node.type === 'effect' && node.sidechainTarget;
    return false;
  }, [connectSourceKind]);
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
      {hasHeader && (
        <div className="xleth-graph-state-preview__chrome">
          <div className="xleth-graph-state-preview__header">
            {notice != null && (
              <p className="xleth-graph-state-preview__notice">{notice}</p>
            )}
            {model.empty && (
              <p className="xleth-graph-state-preview__empty-title">Empty FX Graph</p>
            )}
          </div>
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
        onContextMenu={canAddAnything ? handleCanvasContextMenu : undefined}
        onDoubleClick={canEditViewport ? handleCanvasDoubleClick : undefined}
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
              role="img"
              aria-label="Static graph cables"
            >
              {model.edges.map((edge) => (
                <path
                  className={[
                    'xleth-graph-state-preview__edge',
                    `xleth-graph-state-preview__edge--${edge.type}`,
                    edge.id === spliceTargetEdgeId ? 'xleth-graph-state-preview__edge--splice-target' : '',
                  ].filter(Boolean).join(' ')}
                  data-edge-id={edge.id}
                  data-edge-type={edge.type}
                  data-splice-target={edge.id === spliceTargetEdgeId ? 'true' : undefined}
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
                  connectLfoParameterEnabled={canConnectLfoParameters}
                  connectSidechainEnabled={canConnectSidechain}
                  connectActive={connectingFromNodeId === node.id}
                  hoveredParameterPortId={hoveredParameterTarget?.nodeId === node.id ? hoveredParameterTarget.portId : null}
                  hoveredSidechainPort={hoveredSidechainTarget?.nodeId === node.id}
                  hoveredAudioTarget={hoveredAudioTarget === node.id}
                  connectGuidance={
                    connectSourceKind && node.id !== connectingFromNodeId
                      ? (isValidConnectTargetNode(node) ? 'valid' : 'invalid')
                      : null
                  }
                  sidechainSources={sidechainSources}
                  vstPlugins={vstPlugins}
                  onPointerDown={canDragNodes ? handleNodePointerDown : undefined}
                  onPointerMove={canDragNodes ? handleNodePointerMove : undefined}
                  onPointerUp={canDragNodes ? finishDrag : undefined}
                  onPointerCancel={canDragNodes ? cancelDrag : undefined}
                  onConnectPointerDown={canConnect || canConnectParameters || canConnectEnvelopeParameters || canConnectLfoParameters || canConnectSidechain ? handleConnectPointerDown : undefined}
                  onConnectPointerMove={canConnect || canConnectParameters || canConnectEnvelopeParameters || canConnectLfoParameters || canConnectSidechain ? handleConnectPointerMove : undefined}
                  onConnectPointerUp={canConnect || canConnectParameters || canConnectEnvelopeParameters || canConnectLfoParameters || canConnectSidechain ? handleConnectPointerUp : undefined}
                  onConnectPointerCancel={canConnect || canConnectParameters || canConnectEnvelopeParameters || canConnectLfoParameters || canConnectSidechain ? resetConnect : undefined}
                  onNodeContextMenu={canOpenNodeMenu ? handleNodeContextMenu : undefined}
                  onEdit={canEditNode ? onEditNode : undefined}
                  onToggleBypass={onSetNodeBypass}
                  onMacroValueCommit={onUpdateMacroValue}
                  onMacroRenameCommit={onRenameMacroNode}
                  onEnvelopeUpdate={canEditEnvelope ? onUpdateEnvelope : undefined}
                  onLfoUpdate={canEditLfo ? onUpdateLfo : undefined}
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
          {contextMenu && typeof document !== 'undefined' && createPortal(
            // Portaled to document.body: a floating panel's frame is positioned via
            // CSS `transform` (see PanelFrame.tsx), which makes it the containing
            // block for any `position: fixed` descendant. Left inline, this menu's
            // clientX/clientY-based coordinates would resolve against the panel's
            // own box instead of the viewport, landing off-target (or off-screen)
            // whenever the FX Graph panel isn't maximized. Mirrors the fix already
            // applied to EffectEditorHost (see AppShell.tsx).
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
              onToggleBypass={onSetNodeBypass ? handleContextToggleBypass : undefined}
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
            />,
            document.body,
          )}
          {addMenu && typeof document !== 'undefined' && createPortal(
            // Same containing-block trap as the node context menu above — portal
            // past the floating panel's transformed frame so the menu's
            // clientX/clientY coordinates resolve against the viewport.
            <GraphCanvasAddMenu
              x={addMenu.x}
              y={addMenu.y}
              pluginAction={canAddNode ? {
                key: 'plugin',
                label: 'Add Plugin',
                onSelect: () => runAddMenuAction(onAddEffectNode),
              } : null}
              modulatorActions={[
                ...(canAddMacro ? [{
                  key: 'macro',
                  label: 'Macro',
                  onSelect: () => runAddMenuAction(onAddMacroNode),
                }] : []),
                ...(canAddEnvelope ? [{
                  key: 'envelope',
                  label: 'Envelope',
                  onSelect: () => runAddMenuAction(onAddEnvelopeNode),
                }] : []),
                ...(canAddLfo ? [{
                  key: 'lfo',
                  label: 'LFO',
                  onSelect: () => runAddMenuAction(onAddLfoNode),
                }] : []),
                ...(canAddSidechainInput ? [{
                  key: 'sidechainInput',
                  label: 'Sidechain Input',
                  disabled: hasSidechainInputNode,
                  title: hasSidechainInputNode
                    ? 'This graph already has a Sidechain Input node'
                    : 'Add a Sidechain Input node',
                  onSelect: () => runAddMenuAction(onAddSidechainInput),
                }] : []),
              ]}
            />,
            document.body,
          )}
          {mappingEditorState && canEditMappings && typeof document !== 'undefined' && (() => {
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
            // Same containing-block trap as the context menu above — portal past
            // the floating panel's transformed frame so fixed positioning resolves
            // against the viewport regardless of panel mode.
            return createPortal(
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
              />,
              document.body,
            );
          })()}
        </div>
      </div>
    </section>
  );
}
