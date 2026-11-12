import React, { useRef } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { armPanelDrag, useIsTabDropTarget } from '../managers/DragManager';
import { PANEL_CATALOG, panelTypeColorVar, type PanelId } from '../registry/panelCatalog';
import { usePanelRegistry, type DockArea } from '../registry/PanelRegistry';
import { iconComponent } from '../../ui-kit/icons';

const IcX = iconComponent('x');
import './windowing.css';

export interface PanelTabStripProps {
  region: DockArea;
  tabIds: readonly PanelId[];
  activeId: PanelId;
}

interface PanelTabProps {
  id: PanelId;
  active: boolean;
  onActivate: (id: PanelId) => void;
  onClose: (id: PanelId) => void;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

function PanelTab({ id, active, onActivate, onClose, onPointerDown, onKeyDown }: PanelTabProps) {
  const entry = PANEL_CATALOG[id];
  const Icon = entry.icon;
  const isDropTarget = useIsTabDropTarget(id);

  return (
    <div
      className={[
        'xleth-panel-tab',
        active ? 'is-active' : '',
        isDropTarget ? 'is-drop-target' : '',
      ].filter(Boolean).join(' ')}
      data-tab-id={id}
      // Dropping a dragged panel anywhere on the strip joins this slot.
      data-tab-drop-target={id}
      role="tab"
      aria-selected={active}
      aria-controls={`xleth-panel-body-${id}`}
      tabIndex={active ? 0 : -1}
      style={{ '--xleth-windowing-panel-color': panelTypeColorVar(id) } as CSSProperties}
      onPointerDown={onPointerDown}
      onClick={() => onActivate(id)}
      onKeyDown={onKeyDown}
    >
      <Icon aria-hidden="true" className="xleth-panel-tab-icon" />
      <span className="xleth-panel-tab-label">{entry.title}</span>
      <button
        type="button"
        className="xleth-panel-tab-close"
        aria-label={`Close ${entry.title}`}
        title={`Close ${entry.title}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onClose(id);
        }}
      >
        <IcX aria-hidden="true" />
      </button>
    </div>
  );
}

export function PanelTabStrip({ region, tabIds, activeId }: PanelTabStripProps) {
  const activateTab = usePanelRegistry((state) => state.activateTab);
  const closePanel = usePanelRegistry((state) => state.closePanel);
  const stripRef = useRef<HTMLDivElement>(null);

  // Dragging a tab pulls that panel out of the slot — but only after the
  // pointer actually travels, so a click still just selects the tab.
  const startTabDrag = (id: PanelId) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const panel = usePanelRegistry.getState().panels[id];
    armPanelDrag(id, event.clientX, event.clientY, panel.floating.x, panel.floating.y, {
      target: event.currentTarget,
      pointerId: event.pointerId,
    });
  };

  // Roving tabindex: only the active tab is in the tab order, and the arrow
  // keys move between tabs, per the ARIA tabs pattern.
  const onTabKeyDown = (index: number) => (event: KeyboardEvent<HTMLDivElement>) => {
    const horizontal = region === 'top' || region === 'bottom';
    const nextKey = horizontal ? 'ArrowRight' : 'ArrowDown';
    const prevKey = horizontal ? 'ArrowLeft' : 'ArrowUp';
    let nextIndex: number | null = null;
    if (event.key === nextKey) nextIndex = (index + 1) % tabIds.length;
    else if (event.key === prevKey) nextIndex = (index - 1 + tabIds.length) % tabIds.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabIds.length - 1;
    else return;

    event.preventDefault();
    const nextId = tabIds[nextIndex];
    activateTab(nextId);
    stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${nextId}"]`)?.focus();
  };

  return (
    <div
      ref={stripRef}
      className={`xleth-panel-tabstrip xleth-panel-tabstrip--${region}`}
      data-testid="xleth-panel-tabstrip"
      role="tablist"
      aria-label="Docked panels"
      aria-orientation="horizontal"
    >
      {tabIds.map((id, index) => (
        <PanelTab
          key={id}
          id={id}
          active={id === activeId}
          onActivate={activateTab}
          onClose={closePanel}
          onPointerDown={startTabDrag(id)}
          onKeyDown={onTabKeyDown(index)}
        />
      ))}
    </div>
  );
}

export default PanelTabStrip;
