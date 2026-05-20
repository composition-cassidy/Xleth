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

const USE_GRAPH_MODE_TITLE = 'Use FX Graph Mode for this track?';
const USE_GRAPH_MODE_MESSAGE =
  'The Mixer Chain will be locked for this track. Graph editing will be enabled in a later phase.';

export interface FxGraphPanelContentProps {
  trackId?: number | 'master' | null;
  trackLabel?: string;
  fxMode?: 'chain' | 'graph';
  chain?: ChainEffect[];
  vstPlugins?: VstPluginMeta[];
  onRequestGraphMode?: () => void;
}

interface ActivateFxGraphModeOptions {
  trackId: number | 'master' | null | undefined;
  currentFxMode?: 'chain' | 'graph';
  setFxMode: (key: string, mode: 'chain' | 'graph') => void;
  persistFxMode?: (trackId: number, mode: 'chain' | 'graph') => Promise<unknown> | unknown;
  warn?: (...args: unknown[]) => void;
}

export async function activateFxGraphMode({
  trackId,
  currentFxMode = 'chain',
  setFxMode,
  persistFxMode = (globalThis.window as any)?.xleth?.timeline?.setTrackFxMode,
  warn = console.warn,
}: ActivateFxGraphModeOptions) {
  if (typeof trackId !== 'number' || currentFxMode === 'graph') return false;

  const key = String(trackId);
  setFxMode(key, 'graph');

  try {
    if (typeof persistFxMode !== 'function') throw new Error('timeline.setTrackFxMode unavailable');
    const ok = await persistFxMode?.(trackId, 'graph');
    if (ok === false) throw new Error('timeline.setTrackFxMode returned false');
    return true;
  } catch (e) {
    setFxMode(key, currentFxMode);
    warn?.('[FxGraphPanel] setTrackFxMode failed:', e instanceof Error ? e.message : e);
    return false;
  }
}

export function FxGraphPanelContent({
  trackId = null,
  trackLabel,
  fxMode = 'chain',
  chain = [],
  vstPlugins = [],
  onRequestGraphMode,
}: FxGraphPanelContentProps) {
  const hasTrack = Boolean(trackLabel);
  const isMaster = trackId === 'master';
  const graphModeActive = hasTrack && fxMode === 'graph';
  const canUseGraphMode = hasTrack && !isMaster && fxMode === 'chain';
  const showChainPreview = hasTrack && !isMaster && fxMode === 'chain';
  const statusText = graphModeActive
    ? 'FX Graph owns this track'
    : 'Mixer Chain remains active';

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
                Use Graph Mode
              </button>
              <p className="xleth-fx-graph-panel__mode-copy">
                This will lock Mixer Chain editing for this track.
              </p>
            </div>
          )}

          {showChainPreview && (
            <ChainAsGraphPreview chain={chain} vstPlugins={vstPlugins} />
          )}

          {graphModeActive && (
            <div className="xleth-fx-graph-panel__mode-active" role="status">
              <div className="xleth-fx-graph-panel__mode-active-title">
                FX Graph Mode Active
              </div>
              <p className="xleth-fx-graph-panel__mode-copy">
                Mixer Chain editing is locked for this track.
              </p>
              <p className="xleth-fx-graph-panel__mode-copy">
                Editable graph routing is coming in a later phase.
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
  const reactiveChain = useEffectChainStore((state) => (
    selectedStoreKey == null ? [] : state.chains[selectedStoreKey] ?? []
  ));
  const selectedChain = effectChainState && selectedStoreKey != null
    ? effectChainState.chains[selectedStoreKey] ?? []
    : reactiveChain;
  const setFxMode = useEffectChainStore((state) => state.setFxMode);
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

  const handleConfirmGraphMode = useCallback(async () => {
    setConfirmOpen(false);
    await activateFxGraphMode({
      trackId: selectedTrack?.id,
      currentFxMode: fxMode,
      setFxMode,
    });
  }, [fxMode, selectedTrack?.id, setFxMode]);

  const handleCancelGraphMode = useCallback(() => {
    setConfirmOpen(false);
  }, []);

  return (
    <PanelFrame id="fxGraph">
      <FxGraphPanelContent
        trackId={selectedTrack?.id ?? null}
        trackLabel={selectedTrackLabel}
        fxMode={fxMode}
        chain={selectedChain}
        vstPlugins={vstPlugins}
        onRequestGraphMode={() => setConfirmOpen(true)}
      />
      {confirmOpen && (
        <ConfirmConvertDialog
          title={USE_GRAPH_MODE_TITLE}
          message={USE_GRAPH_MODE_MESSAGE}
          confirmLabel="Use Graph Mode"
          cancelLabel="Cancel"
          danger={false}
          onConfirm={handleConfirmGraphMode}
          onCancel={handleCancelGraphMode}
        />
      )}
    </PanelFrame>
  );
}
