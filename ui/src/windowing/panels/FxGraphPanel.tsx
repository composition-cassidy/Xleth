import React, { useCallback, useEffect, useState } from 'react';
import useEffectChainStore, { resolveFxMode } from '../../stores/effectChainStore.js';
import useMixerStore from '../../stores/mixerStore.js';
import useTimelineFocusStore from '../../stores/timelineFocusStore.js';
import useVstStore from '../../stores/vstStore.js';
import ConfirmConvertDialog from '../../components/timeline/ConfirmConvertDialog.jsx';
import { PanelFrame } from '../components/PanelFrame';
import ChainAsGraphPreview, {
  type ChainEffect,
  type VstPluginMeta,
} from './fxgraph/ChainAsGraphPreview';
import GraphStatePreview, {
  type GraphStateDocument,
} from './fxgraph/GraphStatePreview';

const USE_GRAPH_MODE_TITLE = 'Use FX Graph Mode for this track?';
const USE_GRAPH_MODE_MESSAGE =
  'This converts the current Mixer Chain into a read-only FX Graph snapshot and locks Mixer Chain editing for this track.';
const REPLACE_GRAPH_MODE_MESSAGE =
  'This creates/replaces graphState from the current Mixer Chain and locks Mixer Chain editing for this track.';

export interface FxGraphPanelContentProps {
  trackId?: number | 'master' | null;
  trackLabel?: string;
  fxMode?: 'chain' | 'graph';
  graphStateStatus?: 'valid' | 'missing' | 'invalid' | 'future';
  graphState?: GraphStateDocument | null;
  chain?: ChainEffect[];
  vstPlugins?: VstPluginMeta[];
  onRequestGraphMode?: () => void;
  conversionError?: string | null;
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
  chain = [],
  vstPlugins = [],
  onRequestGraphMode,
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
    : 'This preview is persisted graphState. Editing comes in a later phase.';

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
                This preview is persisted graphState. Editing comes in a later phase.
              </p>
            </div>
          )}

          {showPersistedPreview && (
            <GraphStatePreview graphState={graphState} notice={previewNotice} />
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
  const [conversionError, setConversionError] = useState<string | null>(null);
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
  const reactiveChain = useEffectChainStore((state) => (
    selectedStoreKey == null ? [] : state.chains[selectedStoreKey] ?? []
  ));
  const selectedChain = effectChainState && selectedStoreKey != null
    ? effectChainState.chains[selectedStoreKey] ?? []
    : reactiveChain;
  const convertChainToGraphMode = useEffectChainStore((state) => state.convertChainToGraphMode);
  const fetchChain = useEffectChainStore((state) => state.fetchChain);
  const reactiveVstPlugins = useVstStore((state) => state.plugins);
  const vstState = renderingWithoutDom ? useVstStore.getState() : null;
  const vstPlugins = vstState ? vstState.plugins : reactiveVstPlugins;
  const selectedTrackLabel = selectedTrack
    ? selectedTrack.name || `Track ${selectedTrack.id}`
    : undefined;

  useEffect(() => {
    if (selectedStoreKey == null) return;
    fetchChain(selectedStoreKey);
  }, [fetchChain, selectedStoreKey]);

  useEffect(() => {
    setConversionError(null);
  }, [selectedStoreKey]);

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
    </PanelFrame>
  );
}
