import React from 'react';
import { PANEL_CATALOG, PANEL_IDS, type PanelId } from '../registry/panelCatalog';
import { usePanelRegistry, type DockRegion as DockRegionSide } from '../registry/PanelRegistry';
import { PanelFrame } from './PanelFrame';

export interface DockRegionProps {
  side: DockRegionSide;
}

function DockTestBody({ label }: { label: string }) {
  return (
    <div className="xleth-windowing-test-panel">
      <div className="xleth-windowing-test-panel__header">{label}</div>
    </div>
  );
}

export function DockRegion({ side }: DockRegionProps) {
  const reactivePanels = usePanelRegistry((state) => state.panels);
  const panels = typeof window === 'undefined'
    ? usePanelRegistry.getState().panels
    : reactivePanels;

  const docked = PANEL_IDS
    .filter((id) => !panels[id].hidden && panels[id].mode === 'docked' && panels[id].docked.region === side)
    .sort((a, b) => panels[a].docked.orderInRegion - panels[b].docked.orderInRegion);

  if (docked.length === 0) return null;

  return (
    <div
      className={`xleth-dock-region xleth-dock-region--${side}`}
      data-region={side}
    >
      {docked.map((id: PanelId) => (
        <PanelFrame key={id} id={id}>
          <DockTestBody label={PANEL_CATALOG[id].title} />
        </PanelFrame>
      ))}
    </div>
  );
}

export default DockRegion;
