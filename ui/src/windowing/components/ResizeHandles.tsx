import React from 'react';
import type { PointerEvent } from 'react';
import { beginResize, type ResizeEdge } from '../managers/ResizeManager';
import { usePanelRegistry } from '../registry/PanelRegistry';
import type { PanelId } from '../registry/panelCatalog';
import './windowing.css';

export interface ResizeHandlesProps {
  id: PanelId;
}

const RESIZE_EDGES: ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export function ResizeHandles({ id }: ResizeHandlesProps) {
  const mode = usePanelRegistry((state) => state.panels[id].mode);
  const floatingX = usePanelRegistry((state) => state.panels[id].floating.x);
  const floatingY = usePanelRegistry((state) => state.panels[id].floating.y);
  const floatingWidth = usePanelRegistry((state) => state.panels[id].floating.width);
  const floatingHeight = usePanelRegistry((state) => state.panels[id].floating.height);

  if (mode === 'maximized') return null;

  const handlePointerDown = (edge: ResizeEdge) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    beginResize(
      id,
      edge,
      event.clientX,
      event.clientY,
      floatingX,
      floatingY,
      floatingWidth,
      floatingHeight,
      { target: event.currentTarget, pointerId: event.pointerId },
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
          onPointerDown={handlePointerDown(edge)}
          aria-hidden="true"
        />
      ))}
    </>
  );
}

export default ResizeHandles;
