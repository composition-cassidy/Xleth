import React from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useDragOffset } from '../managers/DragManager';
import { useResizePreview } from '../managers/ResizeManager';
import { panelTypeColorVar, type PanelId } from '../registry/panelCatalog';
import { usePanelRegistry, type PanelState } from '../registry/PanelRegistry';
import { ResizeHandles } from './ResizeHandles';
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
  const reactivePanel = usePanelRegistry((state) => state.panels[id]);
  const panel = typeof window === 'undefined'
    ? usePanelRegistry.getState().panels[id]
    : reactivePanel;
  const focusPanel = usePanelRegistry((state) => state.focusPanel);
  const dragOffset = useDragOffset(id);
  const resizePreview = useResizePreview(id);
  const renderPath = getPanelFrameRenderPath(panel);

  if (renderPath === 'hidden') return null;
  if (renderPath === 'docked') {
    return (
      <section
        className="xleth-panel-frame is-docked"
        data-panel-id={id}
        data-panel-mode="docked"
        style={{ '--xleth-windowing-panel-color': panelTypeColorVar(id) } as CSSProperties}
        onMouseDown={() => focusPanel(id)}
      >
        <Titlebar id={id} focused={panel.focused} />
        <div className="xleth-panel-body">{children}</div>
      </section>
    );
  }

  const baseFrameStyle = {
    '--xleth-windowing-panel-color': panelTypeColorVar(id),
    zIndex: panel.zIndex,
  } as CSSProperties;

  const floatingBounds = resizePreview ?? {
    ...panel.floating,
    x: panel.floating.x + (dragOffset?.dx ?? 0),
    y: panel.floating.y + (dragOffset?.dy ?? 0),
  };

  const frameStyle = renderPath === 'maximized' ? baseFrameStyle : {
    ...baseFrameStyle,
    transform: `translate3d(${floatingBounds.x}px, ${floatingBounds.y}px, 0)`,
    width: `${floatingBounds.width}px`,
    height: `${floatingBounds.height}px`,
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
      {renderPath === 'floating' ? <ResizeHandles id={id} /> : null}
    </section>
  );
}

export default PanelFrame;
