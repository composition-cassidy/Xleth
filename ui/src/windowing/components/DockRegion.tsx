import React from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useDockRegionResizePreview } from '../managers/DockRegionResizeManager';
import { PANEL_CATALOG, PANEL_IDS, type PanelId } from '../registry/panelCatalog';
import { usePanelRegistry, type DockRegion as DockRegionSide } from '../registry/PanelRegistry';
import { DockRegionResizer } from './DockRegionResizer';
import { PanelFrame } from './PanelFrame';

export interface DockRegionProps {
  side: DockRegionSide;
  renderPanel?: (id: PanelId) => ReactNode;
}

function DockTestBody({ label }: { label: string }) {
  return (
    <div className="xleth-windowing-test-panel">
      <div className="xleth-windowing-test-panel__header">{label}</div>
    </div>
  );
}

export function DockRegion({ side, renderPanel }: DockRegionProps) {
  const reactivePanels = usePanelRegistry((state) => state.panels);
  const reactiveSize = usePanelRegistry((state) => state.dockRegionSizes[side]);
  const isSSR = typeof window === 'undefined';
  const panels = isSSR ? usePanelRegistry.getState().panels : reactivePanels;
  const committedSize = isSSR ? usePanelRegistry.getState().dockRegionSizes[side] : reactiveSize;
  const preview = useDockRegionResizePreview(side);
  const effectiveSize = preview?.size ?? committedSize;

  const docked = PANEL_IDS
    .filter((id) => !panels[id].hidden && panels[id].mode === 'docked' && panels[id].docked.region === side)
    .sort((a, b) => panels[a].docked.orderInRegion - panels[b].docked.orderInRegion);

  if (docked.length === 0) return null;

  const sizeStyle: CSSProperties = (side === 'left' || side === 'right')
    ? { width: `${effectiveSize}px` }
    : { height: `${effectiveSize}px` };

  return (
    <div
      className={`xleth-dock-region xleth-dock-region--${side}`}
      data-region={side}
      style={sizeStyle}
    >
      {docked.map((id: PanelId) => (
        renderPanel ? (
          <React.Fragment key={id}>{renderPanel(id)}</React.Fragment>
        ) : (
          <PanelFrame key={id} id={id}>
            <DockTestBody label={PANEL_CATALOG[id].title} />
          </PanelFrame>
        )
      ))}
      <DockRegionResizer region={side} currentSize={committedSize} />
    </div>
  );
}

export default DockRegion;
