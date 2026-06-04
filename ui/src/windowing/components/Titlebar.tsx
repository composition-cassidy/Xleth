import React from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import { Maximize2, Minus, Square, X } from 'lucide-react';
import { beginDrag } from '../managers/DragManager';
import { PANEL_CATALOG, panelTypeColorVar, type PanelId } from '../registry/panelCatalog';
import { usePanelRegistry } from '../registry/PanelRegistry';
import './windowing.css';

export interface TitlebarProps {
  id: PanelId;
  focused: boolean;
}

export function isTitlebarControlTarget(target: EventTarget | null): boolean {
  return typeof HTMLElement !== 'undefined'
    && target instanceof HTMLElement
    && Boolean(target.closest('button'));
}

export function Titlebar({ id, focused }: TitlebarProps) {
  const entry = PANEL_CATALOG[id];
  const Icon = entry.icon;
  const reactiveMode = usePanelRegistry((state) => state.panels[id].mode);
  const reactiveFloatingX = usePanelRegistry((state) => state.panels[id].floating.x);
  const reactiveFloatingY = usePanelRegistry((state) => state.panels[id].floating.y);
  const ssrPanel = typeof window === 'undefined'
    ? usePanelRegistry.getState().panels[id]
    : null;
  const mode = ssrPanel ? ssrPanel.mode : reactiveMode;
  const floatingX = ssrPanel ? ssrPanel.floating.x : reactiveFloatingX;
  const floatingY = ssrPanel ? ssrPanel.floating.y : reactiveFloatingY;
  const closePanel = usePanelRegistry((state) => state.closePanel);
  const maximizePanel = usePanelRegistry((state) => state.maximizePanel);
  const restorePanel = usePanelRegistry((state) => state.restorePanel);

  const stopControlMouseDown = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const hidePanel = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    closePanel(id);
  };

  const toggleMaximize = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (mode === 'maximized') restorePanel(id);
    else maximizePanel(id);
  };

  const startTitlebarDrag = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || mode === 'maximized') return;
    event.preventDefault();
    beginDrag(id, event.clientX, event.clientY, floatingX, floatingY);
  };

  const toggleTitlebarMaximize = (event: MouseEvent<HTMLDivElement>) => {
    if (isTitlebarControlTarget(event.target)) return;
    if (mode === 'maximized') restorePanel(id);
    else if (mode === 'floating') maximizePanel(id);
  };

  return (
    <div
      className="xleth-windowing-titlebar"
      data-panel-id={id}
      data-focused={focused}
      style={{ '--xleth-windowing-panel-color': panelTypeColorVar(id) } as CSSProperties}
      onMouseDown={startTitlebarDrag}
      onDoubleClick={toggleTitlebarMaximize}
    >
      <span className="xleth-windowing-accent-bar" aria-hidden="true" />
      <span
        className="xleth-windowing-focus-underline"
        data-testid={`xleth-windowing-underline-${id}`}
        data-focused={focused}
        aria-hidden="true"
      />
      <Icon className="xleth-windowing-panel-icon" aria-hidden="true" strokeWidth={2} />
      <span className="xleth-windowing-panel-name">{entry.title}</span>
      <span className="xleth-windowing-drag-zone" aria-hidden="true" />
      <div className="xleth-windowing-controls" aria-label={`${entry.title} panel controls`}>
        <button
          type="button"
          className="xleth-windowing-control-button"
          aria-label={`Minimize ${entry.title}`}
          title={`Minimize ${entry.title}`}
          onMouseDown={stopControlMouseDown}
          onClick={hidePanel}
        >
          <Minus aria-hidden="true" strokeWidth={2} />
        </button>
        <button
          type="button"
          className="xleth-windowing-control-button"
          aria-label={mode === 'maximized' ? `Restore ${entry.title}` : `Maximize ${entry.title}`}
          title={mode === 'maximized' ? `Restore ${entry.title}` : `Maximize ${entry.title}`}
          onMouseDown={stopControlMouseDown}
          onClick={toggleMaximize}
        >
          {mode === 'maximized'
            ? <Square aria-hidden="true" strokeWidth={2} />
            : <Maximize2 aria-hidden="true" strokeWidth={2} />}
        </button>
        <button
          type="button"
          className="xleth-windowing-control-button"
          aria-label={`Close ${entry.title}`}
          title={`Close ${entry.title}`}
          onMouseDown={stopControlMouseDown}
          onClick={hidePanel}
        >
          <X aria-hidden="true" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

export default Titlebar;
