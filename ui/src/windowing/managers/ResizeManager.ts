import { usePanelRegistry } from '../registry/PanelRegistry';
import type { PanelId } from '../registry/panelCatalog';
import { createEdgeResizeMachine } from './EdgeResizeMachine';

export const MIN_PANEL_WIDTH = 280;
export const MIN_PANEL_HEIGHT = 120;

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface ResizePreview {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ResizeStartBounds {
  edge: ResizeEdge;
  x: number;
  y: number;
  width: number;
  height: number;
}

const machine = createEdgeResizeMachine<PanelId, ResizeStartBounds, ResizePreview>({
  name: 'floating-panel-resize',
  arePreviewsEqual: (a, b) => (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  ),
  computePreview: (start, dx, dy) => {
    let x = start.x;
    let y = start.y;
    let width = start.width;
    let height = start.height;

    if (start.edge.includes('e')) {
      width = Math.max(MIN_PANEL_WIDTH, start.width + dx);
    }

    if (start.edge.includes('w')) {
      width = Math.max(MIN_PANEL_WIDTH, start.width - dx);
      x = start.x + (start.width - width);
    }

    if (start.edge.includes('s')) {
      height = Math.max(MIN_PANEL_HEIGHT, start.height + dy);
    }

    if (start.edge.includes('n')) {
      height = Math.max(MIN_PANEL_HEIGHT, start.height - dy);
      y = start.y + (start.height - height);
    }

    return { x, y, width, height };
  },
  commit: (panelId, preview) => {
    usePanelRegistry.getState().resizeFloatingPanel(
      panelId,
      preview.x,
      preview.y,
      preview.width,
      preview.height,
    );
  },
});

export function beginResize(
  panelId: PanelId,
  edge: ResizeEdge,
  mouseX: number,
  mouseY: number,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  machine.begin(panelId, mouseX, mouseY, { edge, x, y, width, height });
}

export function updateResize(mouseX: number, mouseY: number): void {
  machine.update(mouseX, mouseY);
}

export function endResize(): void {
  machine.end();
}

export function cancelResize(): void {
  machine.cancel();
}

export function isResizing(): boolean {
  return machine.isActive();
}

export function cancelResizeIfActive(): boolean {
  return machine.cancelIfActive();
}

export function subscribeResize(listener: () => void): () => void {
  return machine.subscribe(listener);
}

export function useResizePreview(panelId: PanelId): ResizePreview | null {
  return machine.usePreview(panelId);
}
