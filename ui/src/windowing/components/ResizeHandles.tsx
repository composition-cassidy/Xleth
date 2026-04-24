import React from 'react';
import type { MouseEvent } from 'react';
import { beginResize, type ResizeEdge } from '../managers/ResizeManager';
import { usePanelRegistry } from '../registry/PanelRegistry';
import type { PanelId } from '../registry/panelCatalog';
import './windowing.css';

export interface ResizeHandlesProps {
  id: PanelId;
}

const RESIZE_EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export function ResizeHandles({ id }: ResizeHandlesProps) {
  const panel = usePanelRegistry((state) => state.panels[id]);

  if (panel.mode === 'maximized') return null;

  const handleMouseDown = (edge: ResizeEdge) => (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    beginResize(
      id,
      edge,
      event.clientX,
      event.clientY,
      panel.floating.x,
      panel.floating.y,
      panel.floating.width,
      panel.floating.height,
    );
  };

  return (
    <>
      {RESIZE_EDGES.map((edge) => (
        <div
          key={edge}
          className={`xleth-resize-handle xleth-resize-handle-${edge}`}
          data-testid={`xleth-resize-handle-${edge}`}
          data-resize-edge={edge}
          onMouseDown={handleMouseDown(edge)}
          aria-hidden="true"
        />
      ))}
    </>
  );
}

export default ResizeHandles;
