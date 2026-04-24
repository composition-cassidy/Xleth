import React from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { panelTypeColorVar, type PanelId } from '../registry/panelCatalog';
import { usePanelRegistry, type PanelState } from '../registry/PanelRegistry';
import { Titlebar } from './Titlebar';
import './windowing.css';

export interface PanelFrameProps {
  id: PanelId;
  children: ReactNode;
}

export type PanelFrameRenderPath = 'hidden' | 'docked' | 'maximized' | 'floating';

export function getPanelFrameRenderPath(panel: PanelState | null | undefined): PanelFrameRenderPath {
  if (!panel || panel.hidden) return 'hidden';
  return panel.mode;
}

export function PanelFrame({ id, children }: PanelFrameProps) {
  const panel = usePanelRegistry((state) => state.panels[id]);
  const focusPanel = usePanelRegistry((state) => state.focusPanel);
  const renderPath = getPanelFrameRenderPath(panel);

  if (renderPath === 'hidden') return null;
  if (renderPath === 'docked') return null;
  if (renderPath === 'maximized') return null;

  const frameStyle = {
    '--xleth-windowing-panel-color': panelTypeColorVar(id),
    transform: `translate3d(${panel.floating.x}px, ${panel.floating.y}px, 0)`,
    width: `${panel.floating.width}px`,
    height: `${panel.floating.height}px`,
    zIndex: panel.zIndex,
  } as CSSProperties;

  return (
    <section
      className={`xleth-panel-frame${panel.focused ? ' is-focused' : ''}`}
      data-panel-id={id}
      data-panel-mode={panel.mode}
      data-focused={panel.focused}
      style={frameStyle}
      onMouseDown={() => focusPanel(id)}
    >
      <Titlebar id={id} focused={panel.focused} />
      <div className="xleth-panel-body">{children}</div>
    </section>
  );
}

export default PanelFrame;
