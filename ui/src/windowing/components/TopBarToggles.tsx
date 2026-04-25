import React from 'react';
import { usePanelRegistry } from '../registry/PanelRegistry';
import {
  PANEL_CATALOG_ORDER,
  panelTypeColorVar,
} from '../registry/panelCatalog';

export function TopBarToggles() {
  const panels = usePanelRegistry((state) => state.panels);

  return (
    <div className="xleth-top-bar-toggles">
      {PANEL_CATALOG_ORDER
        .filter((entry) => entry.id !== 'sampleSelector')
        .map((entry) => {
          const { id } = entry;
          return (
            <button
              key={id}
              className="xleth-top-bar-toggle-btn"
              data-active={String(!panels[id].hidden)}
              data-focused={String(panels[id].focused)}
              style={{ '--xleth-windowing-panel-color': panelTypeColorVar(id) } as React.CSSProperties}
              onClick={() => usePanelRegistry.getState().togglePanel(id)}
              title={`${entry.title} (${entry.fKey})`}
              aria-pressed={!panels[id].hidden}
            >
              <entry.icon />
            </button>
          );
        })}
    </div>
  );
}

export default TopBarToggles;
