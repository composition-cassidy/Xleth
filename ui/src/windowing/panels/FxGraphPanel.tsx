import React from 'react';
import { PanelFrame } from '../components/PanelFrame';

export interface FxGraphPanelContentProps {
  trackLabel?: string;
  fxMode?: 'chain' | 'graph';
}

export function FxGraphPanelContent({
  trackLabel,
  fxMode = 'chain',
}: FxGraphPanelContentProps) {
  const hasTrack = Boolean(trackLabel);
  const mixerChainActive = fxMode !== 'graph';

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
          {mixerChainActive ? 'Mixer Chain remains active' : 'FX Graph owns this track'}
        </div>
      </header>

      <div className="xleth-fx-graph-panel__surface" aria-label="FX Graph workspace placeholder">
        <div className="xleth-fx-graph-panel__surface-inner">
          <div className="xleth-fx-graph-panel__surface-title">
            Routing editor coming in a later phase
          </div>
          <p className="xleth-fx-graph-panel__surface-copy">
            This workspace is available for FX Graph status, but graph routing is not active or editable yet.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function FxGraphPanel() {
  return (
    <PanelFrame id="fxGraph">
      <FxGraphPanelContent />
    </PanelFrame>
  );
}
