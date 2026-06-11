import React, { useCallback, useEffect, useRef, useState } from 'react';
import useEffectChainStore, { resolveFxMode } from '../../stores/effectChainStore.js';
import useMixerStore from '../../stores/mixerStore.js';
import useTimelineFocusStore from '../../stores/timelineFocusStore.js';
import useVstStore from '../../stores/vstStore.js';
import ConfirmConvertDialog from '../../components/timeline/ConfirmConvertDialog.jsx';
import { openEffectEditorByEngineNode } from '../../components/mixer/effectEditorOpeners.js';
import { PanelFrame } from '../components/PanelFrame';
import ChainAsGraphPreview, {
  type ChainEffect,
  type VstPluginMeta,
} from './fxgraph/ChainAsGraphPreview';
import GraphStatePreview, {
  type GraphStateDocument,
  type GraphStateViewport,
} from './fxgraph/GraphStatePreview';
import FxGraphEffectPicker, {
  type FxEffectPickerSelection,
} from './fxgraph/FxGraphEffectPicker';
import type {
  GraphEffectParameterDescriptor,
  GraphParameterResult,
} from './fxgraph/graphParameterUtils';
import { register as registerKeyboardBinding } from '../managers/KeyboardManager';

const USE_GRAPH_MODE_TITLE = 'Use FX Graph Mode for this track?';
const USE_GRAPH_MODE_MESSAGE =
  'This converts the current Mixer Chain into a read-only FX Graph snapshot and locks Mixer Chain editing for this track.';
const REPLACE_GRAPH_MODE_MESSAGE =
  'This creates/replaces graphState from the current Mixer Chain and locks Mixer Chain editing for this track.';
const EMPTY_CHAIN: ChainEffect[] = [];
const EMPTY_VST_PLUGINS: VstPluginMeta[] = [];
const EMPTY_GRAPH_ENGINE_NODE_IDS: Record<string, number> = {};
const FX_GRAPH_HISTORY_KEY_COMBOS = [
  'Ctrl+z',
  'Ctrl+Z',
  'Ctrl+y',
  'Ctrl+Y',
  'Ctrl+Shift+z',
  'Ctrl+Shift+Z',
];

const GRAPH_MUTATION_MESSAGES: Record<string, string> = {
  protected_node: 'Track Input and Track Output cannot be removed.',
  missing_node: 'That node no longer exists.',
  missing_edge: 'That cable no longer exists.',
  missing_source_node: 'The connection source no longer exists.',
  missing_target_node: 'The connection target no longer exists.',
  self_connection: 'A node cannot connect to itself.',
  duplicate_edge: 'That connection already exists.',
  cycle_detected: 'That connection would create a feedback loop.',
  invalid_source_type: 'Track Output cannot be a connection source.',
  invalid_target_type: 'Track Input cannot be a connection target.',
  unknown_node_type: 'Unsupported nodes cannot be connected.',
  invalid_graph_state: 'Graph edit could not be saved.',
  invalid_node_draft: 'Could not create that effect node.',
  invalid_connection_draft: 'Could not create that connection.',
  invalid_parameter_port: 'Could not expose that parameter.',
  invalid_macro_value: 'Macro value must be between 0 and 1.',
  // FXG.4-e/f Macro -> Parameter link validation
  invalid_parameter_target: 'That parameter cannot be linked.',
  missing_effect_instance: 'Effect is not active yet.',
  parameter_not_exposed: 'Expose that parameter on the effect first.',
  parameter_read_only: 'Read-only parameter cannot be driven.',
  master_track: 'Master track stays in Mixer Chain mode.',
  no_track: 'Select a mixer track first.',
  not_graph_mode: 'Switch this track to FX Graph mode first.',
  missing_graph_state: 'No graph data exists for this track yet.',
  // FXG.3-e graph-owned engine failures — rolled back, graph left usable.
  engine_unavailable: 'Audio engine is unavailable. The graph is unchanged.',
  engine_instantiation_failed: 'Could not create that effect. The graph is unchanged.',
  engine_removal_failed: 'Could not remove that effect cleanly. The graph is unchanged.',
  nothing_to_undo: 'Nothing to undo for this graph.',
  nothing_to_redo: 'Nothing to redo for this graph.',
  // FXG-SC.6B FX Graph Sidechain Input
  sidechain_input_exists: 'This graph already has a Sidechain Input node.',
  select_source_first: 'Select a source track first.',
  unsupported_sidechain_target: 'This effect has no sidechain input.',
  invalid_sidechain_source: 'That track cannot be a sidechain source.',
  invalid_sidechain_target: 'That node cannot receive a sidechain key.',
  duplicate_sidechain_edge: 'That sidechain link already exists.',
};

const GRAPH_RUNTIME_MESSAGES: Record<string, string> = {
  effect_not_active: 'Effect is not active yet.',
  missing_effect_mapping: 'Effect is not active yet.',
  missing_effect_instance_id: 'Effect is not active yet.',
  cycle_detected: 'Graph has a feedback loop. Output muted.',
  engine_unavailable: 'Graph routing sync failed. Rebuild the audio engine.',
  engine_sync_failed: 'Graph routing sync failed. Rebuild the audio engine.',
  apply_failed: 'Graph routing sync failed.',
  no_linear_path: 'Graph routing sync failed.',
};

export function describeGraphMutationResult(
  result: { ok?: boolean; reason?: string } | null | undefined,
): string | null {
  if (result && result.ok) return null;
  const reason = result?.reason;
  if (reason && GRAPH_MUTATION_MESSAGES[reason]) return GRAPH_MUTATION_MESSAGES[reason];
  return 'Graph edit was rejected.';
}

export function describeGraphRuntimeStatus(
  status: { ok?: boolean; reason?: string; mode?: string } | null | undefined,
): string {
  if (status?.ok === true) {
    if (status.reason === 'graph_output_disconnected' || status.mode === 'disconnected') {
      return 'Graph output is disconnected.';
    }
    if (status.reason === 'parallel_graph_routing_active' || status.mode === 'parallel') {
      return 'Parallel graph routing active.';
    }
    return 'Graph routing active.';
  }
  const reason = status?.reason;
  if (reason && GRAPH_RUNTIME_MESSAGES[reason]) return GRAPH_RUNTIME_MESSAGES[reason];
  if (status) return 'Graph routing sync failed.';
  return 'Graph routing is enabled for connected paths.';
}

export interface FxGraphPanelContentProps {
  trackId?: number | 'master' | null;
  trackLabel?: string;
  fxMode?: 'chain' | 'graph';
  graphStateStatus?: 'valid' | 'missing' | 'invalid' | 'future';
  graphState?: GraphStateDocument | null;
  chain?: ChainEffect[];
  vstPlugins?: VstPluginMeta[];
  onRequestGraphMode?: () => void;
  onGraphNodePositionChange?: (nodeId: string, position: { x: number; y: number }) => void;
  onGraphViewportChange?: (viewport: GraphStateViewport) => void;
  onAddGraphEffectNode?: () => void;
  onAddGraphMacroNode?: () => void;
  // EVC.3 — envelope node add/edit (graph mode only).
  onAddGraphEnvelopeNode?: () => void;
  onUpdateGraphEnvelope?: (nodeId: string, patch: Record<string, unknown>) => void;
  // FXG-SC.6B — Sidechain Input node add + source selection + key linking (graph mode only).
  onAddGraphSidechainInput?: () => void;
  onSetGraphSidechainInputSource?: (nodeId: string, sourceTrackId: number | null) => void;
  onConnectGraphSidechain?: (sidechainInputNodeId: string, targetNodeId: string) => void;
  sidechainSources?: { sourceTrackId: number; name: string }[];
  onRemoveGraphNode?: (nodeId: string) => void;
  onConnectGraphNodes?: (sourceNodeId: string, targetNodeId: string) => void;
  onConnectGraphMacroToParameter?: (macroNodeId: string, targetNodeId: string, parameterId: string) => void;
  onConnectGraphEnvelopeToParameter?: (envelopeNodeId: string, targetNodeId: string, parameterId: string) => void;
  onDisconnectGraphEdge?: (edgeId: string) => void;
  onEditGraphNode?: (nodeId: string) => void;
  onUpdateGraphMacroValue?: (nodeId: string, value: number) => void;
  onRenameGraphMacroNode?: (nodeId: string, label: string) => void;
  onToggleParameterPort?: (nodeId: string, parameter: GraphEffectParameterDescriptor) => void;
  fetchGraphEffectParameters?: (
    trackId: number | string,
    effectInstanceId: string,
    options?: { graphNodeId?: string },
  ) => Promise<GraphParameterResult> | GraphParameterResult;
  canUndoGraphEdit?: boolean;
  canRedoGraphEdit?: boolean;
  onUndoGraphEdit?: () => void;
  onRedoGraphEdit?: () => void;
  onUpdateParameterEdgeMapping?: (edgeId: string, mappingPatch: unknown) => void;
  onShowMacroAutomationLane?: (macroNodeId: string) => void;
  onHideMacroAutomationLane?: (macroNodeId: string) => void;
  onCreateMacroAutomationClip?: (macroNodeId: string) => void;
  graphRuntimeStatus?: { ok?: boolean; reason?: string; mode?: string } | null;
  graphActionNotice?: string | null;
  conversionError?: string | null;
}

export function selectFxGraphPanelChain(
  chains: Record<string, ChainEffect[] | undefined>,
  selectedStoreKey: string | null,
) {
  return selectedStoreKey == null ? EMPTY_CHAIN : chains[selectedStoreKey] ?? EMPTY_CHAIN;
}

interface ActivateFxGraphModeOptions {
  trackId: number | 'master' | null | undefined;
  currentFxMode?: 'chain' | 'graph';
  convertChainToGraphMode?: (
    trackId: number,
    options?: { warn?: (...args: unknown[]) => void },
  ) => Promise<boolean | { ok?: boolean; reason?: string }> | boolean | { ok?: boolean; reason?: string };
  warn?: (...args: unknown[]) => void;
}

export async function activateFxGraphMode({
  trackId,
  currentFxMode = 'chain',
  convertChainToGraphMode = useEffectChainStore.getState().convertChainToGraphMode,
  warn = console.warn,
}: ActivateFxGraphModeOptions) {
  if (typeof trackId !== 'number' || currentFxMode === 'graph') return false;

  try {
    if (typeof convertChainToGraphMode !== 'function') {
      throw new Error('effectChainStore.convertChainToGraphMode unavailable');
    }
    const result = await convertChainToGraphMode(trackId, { warn });
    return result === true || Boolean(result && typeof result === 'object' && result.ok === true);
  } catch (e) {
    warn?.('[FXG] chain-to-graph conversion failed:', e instanceof Error ? e.message : e);
    return false;
  }
}

export function FxGraphPanelContent({
  trackId = null,
  trackLabel,
  fxMode = 'chain',
  graphStateStatus,
  graphState = null,
  chain = EMPTY_CHAIN,
  vstPlugins = EMPTY_VST_PLUGINS,
  onRequestGraphMode,
  onGraphNodePositionChange,
  onGraphViewportChange,
  onAddGraphEffectNode,
  onAddGraphMacroNode,
  onAddGraphEnvelopeNode,
  onUpdateGraphEnvelope,
  onAddGraphSidechainInput,
  onSetGraphSidechainInputSource,
  onConnectGraphSidechain,
  sidechainSources = [],
  onRemoveGraphNode,
  onConnectGraphNodes,
  onConnectGraphMacroToParameter,
  onConnectGraphEnvelopeToParameter,
  onDisconnectGraphEdge,
  onEditGraphNode,
  onUpdateGraphMacroValue,
  onRenameGraphMacroNode,
  onToggleParameterPort,
  fetchGraphEffectParameters,
  canUndoGraphEdit = false,
  canRedoGraphEdit = false,
  onUndoGraphEdit,
  onRedoGraphEdit,
  onUpdateParameterEdgeMapping,
  onShowMacroAutomationLane,
  onHideMacroAutomationLane,
  onCreateMacroAutomationClip,
  graphRuntimeStatus = null,
  graphActionNotice = null,
  conversionError = null,
}: FxGraphPanelContentProps) {
  const hasTrack = Boolean(trackLabel);
  const isMaster = trackId === 'master';
  const graphModeActive = hasTrack && !isMaster && fxMode === 'graph';
  const effectiveGraphStateStatus = graphStateStatus ?? (graphState ? 'valid' : 'missing');
  const hasValidGraphState = graphState != null && effectiveGraphStateStatus === 'valid';
  const dormantGraphState = hasTrack && !isMaster && fxMode === 'chain' && hasValidGraphState;
  const storedGraphStatePresent =
    graphState != null ||
    graphStateStatus === 'valid' ||
    graphStateStatus === 'invalid' ||
    graphStateStatus === 'future';
  const canUseGraphMode = hasTrack && !isMaster && fxMode === 'chain';
  const showChainPreview =
    hasTrack && !isMaster && fxMode === 'chain' && !storedGraphStatePresent;
  const showPersistedPreview = hasTrack && !isMaster && hasValidGraphState;
  const showMissingGraphState =
    hasTrack && !isMaster && graphModeActive && (
      effectiveGraphStateStatus === 'missing' ||
      (graphStateStatus === 'valid' && graphState == null)
    );
  const showInvalidGraphState =
    hasTrack && !isMaster && effectiveGraphStateStatus === 'invalid';
  const showFutureGraphState =
    hasTrack && !isMaster && effectiveGraphStateStatus === 'future';
  const statusText = graphModeActive
    ? 'FX Graph owns this track'
    : dormantGraphState
      ? 'Dormant FX Graph saved'
    : 'Mixer Chain remains active';
  const conversionCopy = storedGraphStatePresent
    ? 'Mixer Chain owns routing. Confirming conversion will create/replace graphState from the current Mixer Chain.'
    : 'This creates a read-only graphState snapshot from the current Mixer Chain.';
  const previewNotice = dormantGraphState
    ? 'Dormant graphState. Mixer Chain currently owns routing.'
    : describeGraphRuntimeStatus(graphRuntimeStatus);

  return (
    <div className="xleth-fx-graph-panel" role="region" aria-label="FX Graph Workspace">
      <header className="xleth-fx-graph-panel__header">
        <div>
          <div className="xleth-fx-graph-panel__eyebrow">FX Graph Workspace</div>
          <h2 className="xleth-fx-graph-panel__title">
            {hasTrack ? trackLabel : 'No track selected'}
          </h2>
        </div>
        <div className="xleth-fx-graph-panel__status">
          {statusText}
        </div>
      </header>

      <div className="xleth-fx-graph-panel__surface" aria-label="FX Graph workspace">
        <div className="xleth-fx-graph-panel__surface-inner">
          {canUseGraphMode && (
            <div className="xleth-fx-graph-panel__mode-action">
              <button
                className="xleth-fx-graph-panel__mode-button"
                type="button"
                onClick={onRequestGraphMode}
              >
                Convert Chain to FX Graph
              </button>
              <p className="xleth-fx-graph-panel__mode-copy">
                {conversionCopy}
              </p>
              {conversionError && (
                <p className="xleth-fx-graph-panel__mode-copy" role="alert">
                  {conversionError}
                </p>
              )}
            </div>
          )}

          {showChainPreview && (
            <ChainAsGraphPreview chain={chain} vstPlugins={vstPlugins} />
          )}

          {showPersistedPreview && graphModeActive && (
            <div className="xleth-fx-graph-panel__mode-active" role="status">
              <div className="xleth-fx-graph-panel__mode-active-title">
                FX Graph Mode Active
              </div>
              <p className="xleth-fx-graph-panel__mode-copy">
                {describeGraphRuntimeStatus(graphRuntimeStatus)}
              </p>
              {graphActionNotice && (
                <p className="xleth-fx-graph-panel__mode-copy" role="alert">
                  {graphActionNotice}
                </p>
              )}
            </div>
          )}

          {showPersistedPreview && (
            <GraphStatePreview
              graphState={graphState}
              notice={graphModeActive ? null : previewNotice}
              onNodePositionChange={graphModeActive ? onGraphNodePositionChange : undefined}
              onViewportChange={graphModeActive ? onGraphViewportChange : undefined}
              onAddEffectNode={graphModeActive ? onAddGraphEffectNode : undefined}
              onAddMacroNode={graphModeActive ? onAddGraphMacroNode : undefined}
              onAddEnvelopeNode={graphModeActive ? onAddGraphEnvelopeNode : undefined}
              onUpdateEnvelope={graphModeActive ? onUpdateGraphEnvelope : undefined}
              onAddSidechainInput={graphModeActive ? onAddGraphSidechainInput : undefined}
              onSetSidechainInputSource={graphModeActive ? onSetGraphSidechainInputSource : undefined}
              onConnectSidechain={graphModeActive ? onConnectGraphSidechain : undefined}
              sidechainSources={graphModeActive ? sidechainSources : undefined}
              onRemoveNode={graphModeActive ? onRemoveGraphNode : undefined}
              onConnectNodes={graphModeActive ? onConnectGraphNodes : undefined}
              onConnectMacroToParameter={graphModeActive ? onConnectGraphMacroToParameter : undefined}
              onConnectEnvelopeToParameter={graphModeActive ? onConnectGraphEnvelopeToParameter : undefined}
              onDisconnectEdge={graphModeActive ? onDisconnectGraphEdge : undefined}
              onEditNode={graphModeActive ? onEditGraphNode : undefined}
              onUpdateMacroValue={graphModeActive ? onUpdateGraphMacroValue : undefined}
              onRenameMacroNode={graphModeActive ? onRenameGraphMacroNode : undefined}
              trackId={graphModeActive ? trackId : null}
              fetchGraphEffectParameters={graphModeActive ? fetchGraphEffectParameters : undefined}
              onToggleParameterPort={graphModeActive ? onToggleParameterPort : undefined}
              canUndoGraphEdit={graphModeActive && canUndoGraphEdit}
              canRedoGraphEdit={graphModeActive && canRedoGraphEdit}
              onUndoGraphEdit={graphModeActive ? onUndoGraphEdit : undefined}
              onRedoGraphEdit={graphModeActive ? onRedoGraphEdit : undefined}
              onUpdateParameterEdgeMapping={graphModeActive ? onUpdateParameterEdgeMapping : undefined}
              onShowMacroAutomationLane={graphModeActive ? onShowMacroAutomationLane : undefined}
              onHideMacroAutomationLane={graphModeActive ? onHideMacroAutomationLane : undefined}
              onCreateMacroAutomationClip={graphModeActive ? onCreateMacroAutomationClip : undefined}
            />
          )}

          {showMissingGraphState && (
            <div className="xleth-fx-graph-panel__mode-active" role="status">
              <div className="xleth-fx-graph-panel__mode-active-title">
                FX Graph Mode Active, but no graph data exists for this track.
              </div>
              <p className="xleth-fx-graph-panel__mode-copy">
                This can happen with legacy projects.
              </p>
            </div>
          )}

          {showInvalidGraphState && (
            <div className="xleth-fx-graph-panel__mode-active" role="alert">
              <div className="xleth-fx-graph-panel__mode-active-title">
                Graph routing data is invalid and could not be loaded.
              </div>
              {graphModeActive && (
                <p className="xleth-fx-graph-panel__mode-copy">
                  Mixer Chain editing remains locked.
                </p>
              )}
            </div>
          )}

          {showFutureGraphState && (
            <div className="xleth-fx-graph-panel__mode-active" role="status">
              <div className="xleth-fx-graph-panel__mode-active-title">
                This graphState version is not supported by this build.
              </div>
              <p className="xleth-fx-graph-panel__mode-copy">
                The saved routing data is preserved but is not rendered as an active graph.
              </p>
            </div>
          )}

          {isMaster && (
            <p className="xleth-fx-graph-panel__mode-copy">
              Master track FX stay in Mixer Chain mode in this phase.
            </p>
          )}

          {!hasTrack && (
            <>
              <div className="xleth-fx-graph-panel__surface-title">
                Select a mixer track to preview its chain
              </div>
              <p className="xleth-fx-graph-panel__surface-copy">
                FX Graph status and read-only chain previews appear here for normal mixer tracks.
              </p>
            </>
          )}

          {isMaster && (
            <>
              <div className="xleth-fx-graph-panel__surface-title">
                Master track stays chain-only
              </div>
              <p className="xleth-fx-graph-panel__surface-copy">
                Master FX remain owned by the Mixer Chain in this phase.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function FxGraphPanel() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [conversionError, setConversionError] = useState<string | null>(null);
  const [graphActionNotice, setGraphActionNotice] = useState<string | null>(null);
  const renderingWithoutDom = typeof document === 'undefined';
  const reactiveFocusedTrackId = useTimelineFocusStore((state) => state.focusedTrackId);
  const focusState = renderingWithoutDom ? useTimelineFocusStore.getState() : null;
  const focusedTrackId = focusState?.focusedTrackId ?? reactiveFocusedTrackId;
  const reactiveSelectedTrack = useMixerStore((state) => (
    focusedTrackId == null ? null : state.tracks[focusedTrackId] ?? null
  ));
  const mixerState = renderingWithoutDom ? useMixerStore.getState() : null;
  const selectedTrack = mixerState && focusedTrackId != null
    ? mixerState.tracks[focusedTrackId] ?? null
    : reactiveSelectedTrack;
  const reactiveFxMode = useEffectChainStore((state) => (
    selectedTrack?.id == null ? 'chain' : resolveFxMode(state.fxModes, String(selectedTrack.id))
  ));
  const effectChainState = renderingWithoutDom ? useEffectChainStore.getState() : null;
  const fxMode = effectChainState && selectedTrack?.id != null
    ? resolveFxMode(effectChainState.fxModes, String(selectedTrack.id))
    : reactiveFxMode;
  const selectedStoreKey = selectedTrack?.id == null ? null : String(selectedTrack.id);
  const reactiveGraphStateStatus = useEffectChainStore((state) => (
    selectedStoreKey == null ? undefined : state.graphStateStatuses[selectedStoreKey]?.status
  ));
  const graphStateStatus = effectChainState && selectedStoreKey != null
    ? effectChainState.graphStateStatuses[selectedStoreKey]?.status
    : reactiveGraphStateStatus;
  const reactiveGraphState = useEffectChainStore((state) => (
    selectedStoreKey == null ? null : state.graphStates[selectedStoreKey] ?? null
  ));
  const graphState = effectChainState && selectedStoreKey != null
    ? effectChainState.graphStates[selectedStoreKey] ?? null
    : reactiveGraphState;
  const reactiveGraphEngineNodeIds = useEffectChainStore((state) => (
    selectedStoreKey == null
      ? EMPTY_GRAPH_ENGINE_NODE_IDS
      : state.graphEngineNodeIds[selectedStoreKey] ?? EMPTY_GRAPH_ENGINE_NODE_IDS
  ));
  const graphEngineNodeIds = effectChainState && selectedStoreKey != null
    ? effectChainState.graphEngineNodeIds[selectedStoreKey] ?? EMPTY_GRAPH_ENGINE_NODE_IDS
    : reactiveGraphEngineNodeIds;
  const reactiveGraphRuntimeStatus = useEffectChainStore((state) => (
    selectedStoreKey == null ? null : state.graphRuntimeStatuses[selectedStoreKey] ?? null
  ));
  const graphRuntimeStatus = effectChainState && selectedStoreKey != null
    ? effectChainState.graphRuntimeStatuses[selectedStoreKey] ?? null
    : reactiveGraphRuntimeStatus;
  const reactiveCanUndoGraphEdit = useEffectChainStore((state) => (
    selectedStoreKey == null
      ? false
      : (state.graphHistories?.[selectedStoreKey]?.undoStack?.length ?? 0) > 0
  ));
  const reactiveCanRedoGraphEdit = useEffectChainStore((state) => (
    selectedStoreKey == null
      ? false
      : (state.graphHistories?.[selectedStoreKey]?.redoStack?.length ?? 0) > 0
  ));
  const canUndoGraphEdit = fxMode === 'graph' && (
    effectChainState && selectedStoreKey != null
      ? (effectChainState.graphHistories?.[selectedStoreKey]?.undoStack?.length ?? 0) > 0
      : reactiveCanUndoGraphEdit
  );
  const canRedoGraphEdit = fxMode === 'graph' && (
    effectChainState && selectedStoreKey != null
      ? (effectChainState.graphHistories?.[selectedStoreKey]?.redoStack?.length ?? 0) > 0
      : reactiveCanRedoGraphEdit
  );
  const reactiveChain = useEffectChainStore((state) => (
    selectFxGraphPanelChain(state.chains, selectedStoreKey)
  ));
  const selectedChain = effectChainState
    ? selectFxGraphPanelChain(effectChainState.chains, selectedStoreKey)
    : reactiveChain;
  const convertChainToGraphMode = useEffectChainStore((state) => state.convertChainToGraphMode);
  const setGraphStateNodePosition = useEffectChainStore((state) => state.setGraphStateNodePosition);
  const setGraphStateViewport = useEffectChainStore((state) => state.setGraphStateViewport);
  const addGraphEffectNodeForTrack = useEffectChainStore((state) => state.addGraphEffectNodeForTrack);
  const addGraphMacroNodeForTrack = useEffectChainStore((state) => state.addGraphMacroNodeForTrack);
  const addGraphEnvelopeNodeForTrack = useEffectChainStore((state) => state.addGraphEnvelopeNodeForTrack);
  const updateGraphEnvelopeNodeDataForTrack = useEffectChainStore((state) => state.updateGraphEnvelopeNodeDataForTrack);
  // FXG-SC.6B — Sidechain Input store actions.
  const addSidechainInputNodeForTrack = useEffectChainStore((state) => state.addSidechainInputNodeForTrack);
  const setSidechainInputSourceForTrack = useEffectChainStore((state) => state.setSidechainInputSourceForTrack);
  const connectSidechainForTrack = useEffectChainStore((state) => state.connectSidechainForTrack);
  const disconnectSidechainEdgeForTrack = useEffectChainStore((state) => state.disconnectSidechainEdgeForTrack);
  const removeGraphNodeForTrack = useEffectChainStore((state) => state.removeGraphNodeForTrack);
  const connectGraphNodesForTrack = useEffectChainStore((state) => state.connectGraphNodesForTrack);
  const connectMacroToParameterForTrack = useEffectChainStore((state) => state.connectMacroToParameterForTrack);
  const connectEnvelopeToParameterForTrack = useEffectChainStore((state) => state.connectEnvelopeToParameterForTrack);
  const disconnectGraphEdgeForTrack = useEffectChainStore((state) => state.disconnectGraphEdgeForTrack);
  const updateGraphMacroValueForTrack = useEffectChainStore((state) => state.updateGraphMacroValueForTrack);
  const renameGraphMacroNodeForTrack = useEffectChainStore((state) => state.renameGraphMacroNodeForTrack);
  const showMacroAutomationLaneForTrack = useEffectChainStore((state) => state.showMacroAutomationLaneForTrack);
  const hideMacroAutomationLaneForTrack = useEffectChainStore((state) => state.hideMacroAutomationLaneForTrack);
  const createMacroAutomationClipForTrack = useEffectChainStore((state) => state.createMacroAutomationClipForTrack);
  const toggleGraphNodeParameterPortForTrack = useEffectChainStore((state) => state.toggleGraphNodeParameterPortForTrack);
  const updateGraphParameterEdgeMappingForTrack = useEffectChainStore((state) => state.updateGraphParameterEdgeMappingForTrack);
  const fetchGraphEffectParameters = useEffectChainStore((state) => state.fetchGraphEffectParameters);
  const undoGraphEditForTrack = useEffectChainStore((state) => state.undoGraphEditForTrack);
  const redoGraphEditForTrack = useEffectChainStore((state) => state.redoGraphEditForTrack);
  const fetchChain = useEffectChainStore((state) => state.fetchChain);
  const reactiveVstPlugins = useVstStore((state) => state.plugins);
  const vstState = renderingWithoutDom ? useVstStore.getState() : null;
  const vstPlugins = vstState ? vstState.plugins : reactiveVstPlugins;
  // FXG-SC.6B — eligible sidechain source tracks for the selected graph track. The
  // mixerStore selector already excludes self, visual-only/non-audio tracks, and
  // output+sidechain cycles. Subscribing to tracks keeps the list reactive.
  const getEligibleSidechainSources = useMixerStore((state) => state.getEligibleSidechainSources);
  const mixerTracks = useMixerStore((state) => state.tracks);
  const sidechainSources = React.useMemo(
    () => (selectedTrack?.id == null ? [] : getEligibleSidechainSources(selectedTrack.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mixerTracks drives recompute
    [getEligibleSidechainSources, selectedTrack?.id, mixerTracks],
  );
  const selectedTrackLabel = selectedTrack
    ? selectedTrack.name || `Track ${selectedTrack.id}`
    : undefined;
  const fxGraphHistoryKeyHandlerRef = useRef<((event: KeyboardEvent) => void) | null>(null);

  useEffect(() => {
    if (selectedStoreKey == null) return;
    fetchChain(selectedStoreKey);
  }, [fetchChain, selectedStoreKey]);

  useEffect(() => {
    setConversionError(null);
    setGraphActionNotice(null);
    setPickerOpen(false);
  }, [selectedStoreKey]);

  // Close the picker if this track stops being graph-owned underneath us.
  useEffect(() => {
    if (fxMode !== 'graph') setPickerOpen(false);
  }, [fxMode]);

  const handleConfirmGraphMode = useCallback(async () => {
    setConfirmOpen(false);
    const ok = await activateFxGraphMode({
      trackId: selectedTrack?.id,
      currentFxMode: fxMode,
      convertChainToGraphMode,
    });
    setConversionError(ok ? null : 'Conversion failed. Mixer Chain remains active.');
  }, [convertChainToGraphMode, fxMode, selectedTrack?.id]);

  const handleCancelGraphMode = useCallback(() => {
    setConfirmOpen(false);
  }, []);

  const handleGraphNodePositionChange = useCallback((
    nodeId: string,
    position: { x: number; y: number },
  ) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    void setGraphStateNodePosition(selectedTrack.id, nodeId, position);
  }, [fxMode, selectedTrack?.id, setGraphStateNodePosition]);

  const handleGraphViewportChange = useCallback((viewport: GraphStateViewport) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    void setGraphStateViewport(selectedTrack.id, viewport);
  }, [fxMode, selectedTrack?.id, setGraphStateViewport]);

  // FXG.3-e — the Add Effect Node button no longer drops a placeholder. It opens
  // the picker, which lists the same stock + scanned-VST catalog the Mixer Chain
  // exposes. Selecting an effect creates a real graph-owned effect node.
  const handleOpenAddEffectPicker = useCallback(() => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    setGraphActionNotice(null);
    setPickerOpen(true);
  }, [fxMode, selectedTrack?.id]);

  const handleCancelAddEffectPicker = useCallback(() => {
    setPickerOpen(false);
  }, []);

  const handleSelectGraphEffect = useCallback(async (selection: FxEffectPickerSelection) => {
    setPickerOpen(false);
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    // Real pluginId + displayName → graph-owned node + graph-owned engine
    // processor + session effectInstanceId→engineNodeId mapping. The store
    // instantiates the engine processor first and rolls back the graphState
    // commit on failure, so a failed add never corrupts the graph or chains.
    const result = await addGraphEffectNodeForTrack(selectedTrack.id, {
      pluginId: selection.pluginId,
      displayName: selection.displayName,
    });
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [addGraphEffectNodeForTrack, fxMode, selectedTrack?.id]);

  const handleAddGraphMacroNode = useCallback(async () => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const result = await addGraphMacroNodeForTrack(selectedTrack.id);
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [addGraphMacroNodeForTrack, fxMode, selectedTrack?.id]);

  // EVC.3 — add an inert per-voice Envelope node. Graph-mode gated; the EVC.2 store
  // action persists graphState, records undo, and performs NO audio runtime sync.
  const handleAddGraphEnvelopeNode = useCallback(async () => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const result = await addGraphEnvelopeNodeForTrack(selectedTrack.id);
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [addGraphEnvelopeNodeForTrack, fxMode, selectedTrack?.id]);

  // EVC.3 — patch an envelope node's inert data. The store action clamps/repairs the
  // patch through normalizeEnvelopeNodeData; it never touches effectChains or audio.
  const handleUpdateGraphEnvelope = useCallback(async (
    nodeId: string,
    patch: Record<string, unknown>,
  ) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const result = await updateGraphEnvelopeNodeDataForTrack(selectedTrack.id, nodeId, patch);
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [fxMode, selectedTrack?.id, updateGraphEnvelopeNodeDataForTrack]);

  // FXG-SC.6B — add the protected Sidechain Input node. Graph-mode gated; the store
  // action persists graphState, records undo, and performs NO audio runtime sync, NO
  // native route, and NO sc_external write. Pre-fills the source with the first
  // eligible track so a fresh node is immediately usable when one exists.
  const handleAddGraphSidechainInput = useCallback(async () => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const result = await addSidechainInputNodeForTrack(selectedTrack.id, {
      sourceTrackId: sidechainSources[0]?.sourceTrackId ?? null,
    });
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [addSidechainInputNodeForTrack, fxMode, selectedTrack?.id, sidechainSources]);

  // FXG-SC.6B — set the Sidechain Input node's source track. Eligibility is enforced
  // both here (via eligibleSourceTrackIds) and structurally in the store/graphState.
  const handleSetGraphSidechainInputSource = useCallback(async (
    nodeId: string,
    sourceTrackId: number | null,
  ) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const result = await setSidechainInputSourceForTrack(selectedTrack.id, nodeId, sourceTrackId, {
      eligibleSourceTrackIds: sidechainSources.map((s) => s.sourceTrackId),
    });
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [fxMode, selectedTrack?.id, setSidechainInputSourceForTrack, sidechainSources]);

  // FXG-SC.6B — create a sidechain key link from the Sidechain Input node to a stock
  // compressor's sidechainIn. Runtime-inert in 6B (no route/native ducking yet).
  const handleConnectGraphSidechain = useCallback(async (
    sidechainInputNodeId: string,
    targetNodeId: string,
  ) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const result = await connectSidechainForTrack(selectedTrack.id, sidechainInputNodeId, targetNodeId);
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [connectSidechainForTrack, fxMode, selectedTrack?.id]);

  const handleRemoveGraphNode = useCallback(async (nodeId: string) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const result = await removeGraphNodeForTrack(selectedTrack.id, nodeId);
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [fxMode, removeGraphNodeForTrack, selectedTrack?.id]);

  const handleUpdateGraphMacroValue = useCallback(async (nodeId: string, value: number) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const result = await updateGraphMacroValueForTrack(selectedTrack.id, nodeId, value);
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [fxMode, selectedTrack?.id, updateGraphMacroValueForTrack]);

  const handleRenameGraphMacroNode = useCallback(async (nodeId: string, label: string) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const result = await renameGraphMacroNodeForTrack(selectedTrack.id, nodeId, label);
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [fxMode, renameGraphMacroNodeForTrack, selectedTrack?.id]);

  // FXG.4-h — parent-attached macro automation lane actions from the macro node menu.
  const handleShowMacroAutomationLane = useCallback(async (macroNodeId: string) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const result = await showMacroAutomationLaneForTrack(selectedTrack.id, macroNodeId);
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [fxMode, selectedTrack?.id, showMacroAutomationLaneForTrack]);

  const handleHideMacroAutomationLane = useCallback(async (macroNodeId: string) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const result = await hideMacroAutomationLaneForTrack(selectedTrack.id, macroNodeId);
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [fxMode, hideMacroAutomationLaneForTrack, selectedTrack?.id]);

  const handleCreateMacroAutomationClip = useCallback(async (macroNodeId: string) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    // Place the new clip after the last clip already on this macro's lane so the
    // default action never overlaps (same-lane overlap is rejected in v1). One bar
    // long at PPQ 960 (4 beats = 3840 ticks).
    const lane = graphState?.macroAutomationLanes?.find((l) => l.macroNodeId === macroNodeId);
    const startTick = lane && lane.clips.length > 0
      ? Math.max(...lane.clips.map((c) => c.startTick + c.lengthTicks))
      : 0;
    const result = await createMacroAutomationClipForTrack(
      selectedTrack.id,
      macroNodeId,
      { startTick, lengthTicks: 3840 },
    );
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [createMacroAutomationClipForTrack, fxMode, graphState?.macroAutomationLanes, selectedTrack?.id]);

  const handleUpdateParameterEdgeMapping = useCallback(async (edgeId: string, mappingPatch: unknown) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    void updateGraphParameterEdgeMappingForTrack(selectedTrack.id, edgeId, mappingPatch);
  }, [fxMode, selectedTrack?.id, updateGraphParameterEdgeMappingForTrack]);

  const handleConnectGraphNodes = useCallback(async (sourceNodeId: string, targetNodeId: string) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const result = await connectGraphNodesForTrack(selectedTrack.id, { sourceNodeId, targetNodeId });
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [connectGraphNodesForTrack, fxMode, selectedTrack?.id]);

  const handleConnectGraphMacroToParameter = useCallback(async (
    macroNodeId: string,
    targetNodeId: string,
    parameterId: string,
  ) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const result = await connectMacroToParameterForTrack(selectedTrack.id, {
      sourceNodeId: macroNodeId,
      targetNodeId,
      parameterId,
    });
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [connectMacroToParameterForTrack, fxMode, selectedTrack?.id]);

  // EVC-R1 — link an Envelope controlOut to an exposed effect parameter. Mirrors the
  // macro handler; runtime-inert (the store action records the edge but never drives
  // the parameter — triggered ADSR runtime is EVC-R2).
  const handleConnectGraphEnvelopeToParameter = useCallback(async (
    envelopeNodeId: string,
    targetNodeId: string,
    parameterId: string,
  ) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const result = await connectEnvelopeToParameterForTrack(selectedTrack.id, {
      sourceNodeId: envelopeNodeId,
      targetNodeId,
      parameterId,
    });
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [connectEnvelopeToParameterForTrack, fxMode, selectedTrack?.id]);

  const handleDisconnectGraphEdge = useCallback(async (edgeId: string) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    // FXG-SC.6B — sidechain edges use a dedicated disconnect action so they never run
    // through the audio/parameter disconnect path. Resolve the edge type from graphState.
    const edge = graphState?.edges?.find((candidate) => candidate.id === edgeId);
    const result = edge?.type === 'sidechain'
      ? await disconnectSidechainEdgeForTrack(selectedTrack.id, edgeId)
      : await disconnectGraphEdgeForTrack(selectedTrack.id, edgeId);
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [disconnectGraphEdgeForTrack, disconnectSidechainEdgeForTrack, fxMode, graphState, selectedTrack?.id]);

  const runGraphHistoryAction = useCallback(async (kind: 'undo' | 'redo') => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const action = kind === 'undo' ? undoGraphEditForTrack : redoGraphEditForTrack;
    const result = await action(selectedTrack.id);
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [fxMode, redoGraphEditForTrack, selectedTrack?.id, undoGraphEditForTrack]);

  const handleUndoGraphEdit = useCallback(() => {
    void runGraphHistoryAction('undo');
  }, [runGraphHistoryAction]);

  const handleRedoGraphEdit = useCallback(() => {
    void runGraphHistoryAction('redo');
  }, [runGraphHistoryAction]);

  fxGraphHistoryKeyHandlerRef.current = (event: KeyboardEvent) => {
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const key = String(event.key || '').toLowerCase();
    const wantsUndo = key === 'z' && !event.shiftKey;
    const wantsRedo = key === 'y' || (key === 'z' && event.shiftKey);
    if (!wantsUndo && !wantsRedo) return;

    event.preventDefault();
    event.stopPropagation();
    void runGraphHistoryAction(wantsUndo ? 'undo' : 'redo');
  };

  useEffect(() => {
    const dispatchGraphHistoryShortcut = (event: KeyboardEvent) => {
      fxGraphHistoryKeyHandlerRef.current?.(event);
      return event.defaultPrevented ? 'handled' : undefined;
    };
    const unsubscribers = FX_GRAPH_HISTORY_KEY_COMBOS.map((combo) => (
      registerKeyboardBinding({
        scope: 'panel:fxGraph',
        combo,
        handler: dispatchGraphHistoryShortcut,
      })
    ));
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  // Resolve a graphState topology node.id → effectInstanceId → engine nodeId,
  // then open the SAME stock/plugin editor path Mixer Chain uses. The graph
  // node.id is never passed to an editor store — only the engine nodeId is.
  const handleEditGraphNode = useCallback(async (nodeId: string) => {
    setGraphActionNotice(null);
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const trackId = selectedTrack.id;

    const node = graphState?.nodes?.find((candidate) => candidate.id === nodeId);
    if (!node || node.type !== 'effect') {
      setGraphActionNotice('That node can no longer be edited.');
      return;
    }

    const data = (node.data ?? {}) as { effectInstanceId?: unknown; pluginId?: unknown };
    const effectInstanceId = typeof data.effectInstanceId === 'string' ? data.effectInstanceId : '';
    const pluginId = typeof data.pluginId === 'string' ? data.pluginId : '';

    if (!effectInstanceId) {
      setGraphActionNotice('This effect has no instance id yet.');
      return;
    }
    if (!pluginId || pluginId === 'placeholder') {
      setGraphActionNotice('Effect is not active yet.');
      return;
    }

    const audio = (window as typeof window & { xleth?: { audio?: any } }).xleth?.audio;

    let engineNodeId: number | null = Number.isInteger(graphEngineNodeIds?.[effectInstanceId])
      && graphEngineNodeIds[effectInstanceId] >= 0
      ? graphEngineNodeIds[effectInstanceId]
      : null;
    try {
      if (engineNodeId == null) {
        const resolved = await audio?.getGraphEffectEngineNodeId?.(trackId, effectInstanceId);
        engineNodeId = Number.isInteger(resolved) && resolved >= 0 ? resolved : null;
      }
    } catch {
      engineNodeId = null;
    }
    if (engineNodeId == null) {
      setGraphActionNotice('Effect is not active yet.');
      return;
    }

    const result = openEffectEditorByEngineNode({
      pluginId,
      engineNodeId,
      storeKey: String(trackId),
      audio,
    });
    if (!result.ok) {
      setGraphActionNotice(
        result.reason === 'editor_unavailable'
          ? 'No editor is available for this effect.'
          : 'Could not open the effect editor.',
      );
    }
  }, [fxMode, graphEngineNodeIds, graphState, selectedTrack?.id]);

  const handleToggleParameterPort = useCallback(async (
    nodeId: string,
    parameter: GraphEffectParameterDescriptor,
  ) => {
    setGraphActionNotice(null);
    if (selectedTrack?.id == null || fxMode !== 'graph') return;
    const result = await toggleGraphNodeParameterPortForTrack(selectedTrack.id, nodeId, parameter);
    setGraphActionNotice(describeGraphMutationResult(result));
  }, [fxMode, selectedTrack?.id, toggleGraphNodeParameterPortForTrack]);

  const confirmGraphModeMessage =
    graphStateStatus === 'valid' || graphStateStatus === 'invalid' || graphStateStatus === 'future'
      ? REPLACE_GRAPH_MODE_MESSAGE
      : USE_GRAPH_MODE_MESSAGE;

  return (
    <PanelFrame id="fxGraph">
      <FxGraphPanelContent
        trackId={selectedTrack?.id ?? null}
        trackLabel={selectedTrackLabel}
        fxMode={fxMode}
        graphStateStatus={graphStateStatus}
        graphState={graphState}
        chain={selectedChain}
        vstPlugins={vstPlugins}
        onRequestGraphMode={() => setConfirmOpen(true)}
        onGraphNodePositionChange={handleGraphNodePositionChange}
        onGraphViewportChange={handleGraphViewportChange}
        onAddGraphEffectNode={handleOpenAddEffectPicker}
        onAddGraphMacroNode={handleAddGraphMacroNode}
        onAddGraphEnvelopeNode={handleAddGraphEnvelopeNode}
        onUpdateGraphEnvelope={handleUpdateGraphEnvelope}
        onAddGraphSidechainInput={handleAddGraphSidechainInput}
        onSetGraphSidechainInputSource={handleSetGraphSidechainInputSource}
        onConnectGraphSidechain={handleConnectGraphSidechain}
        sidechainSources={sidechainSources}
        onRemoveGraphNode={handleRemoveGraphNode}
        onConnectGraphNodes={handleConnectGraphNodes}
        onConnectGraphMacroToParameter={handleConnectGraphMacroToParameter}
        onConnectGraphEnvelopeToParameter={handleConnectGraphEnvelopeToParameter}
        onDisconnectGraphEdge={handleDisconnectGraphEdge}
        onEditGraphNode={handleEditGraphNode}
        onUpdateGraphMacroValue={handleUpdateGraphMacroValue}
        onRenameGraphMacroNode={handleRenameGraphMacroNode}
        onToggleParameterPort={handleToggleParameterPort}
        fetchGraphEffectParameters={fetchGraphEffectParameters}
        canUndoGraphEdit={canUndoGraphEdit}
        canRedoGraphEdit={canRedoGraphEdit}
        onUndoGraphEdit={handleUndoGraphEdit}
        onRedoGraphEdit={handleRedoGraphEdit}
        onUpdateParameterEdgeMapping={handleUpdateParameterEdgeMapping}
        onShowMacroAutomationLane={handleShowMacroAutomationLane}
        onHideMacroAutomationLane={handleHideMacroAutomationLane}
        onCreateMacroAutomationClip={handleCreateMacroAutomationClip}
        graphRuntimeStatus={graphRuntimeStatus}
        graphActionNotice={graphActionNotice}
        conversionError={conversionError}
      />
      {confirmOpen && (
        <ConfirmConvertDialog
          title={USE_GRAPH_MODE_TITLE}
          message={confirmGraphModeMessage}
          confirmLabel="Convert Chain to FX Graph"
          cancelLabel="Cancel"
          danger={false}
          onConfirm={handleConfirmGraphMode}
          onCancel={handleCancelGraphMode}
        />
      )}
      {pickerOpen && fxMode === 'graph' && selectedTrack?.id != null && (
        <FxGraphEffectPicker
          vstPlugins={vstPlugins}
          onSelect={handleSelectGraphEffect}
          onCancel={handleCancelAddEffectPicker}
        />
      )}
    </PanelFrame>
  );
}
