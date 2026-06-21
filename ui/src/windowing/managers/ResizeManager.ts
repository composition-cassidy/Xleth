import { usePanelRegistry } from '../registry/PanelRegistry';
import type { PanelId } from '../registry/panelCatalog';
import { createEdgeResizeMachine } from './EdgeResizeMachine';
import { getRegisteredWorkAreaRect } from './DragManager';

export const MIN_PANEL_WIDTH = 280;
export const MIN_PANEL_HEIGHT = 120;
export const MIN_MIXER_PANEL_HEIGHT = 260;

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
  minHeight: number;
}

function clampPreviewToWorkArea(preview: ResizePreview, requestedMinHeight: number): ResizePreview {
  const rect = getRegisteredWorkAreaRect();
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) {
    return preview;
  }

  let { x, y, width, height } = preview;
  const panelMinWidth = Math.min(MIN_PANEL_WIDTH, rect.width);
  const panelMinHeight = Math.min(requestedMinHeight, rect.height);

  if (x < 0) {
    width = Math.max(panelMinWidth, width + x);
    x = 0;
  }
  if (y < 0) {
    height = Math.max(panelMinHeight, height + y);
    y = 0;
  }
  if (x + width > rect.width) {
    width = Math.max(panelMinWidth, rect.width - x);
    if (x + width > rect.width) x = Math.max(0, rect.width - width);
  }
  if (y + height > rect.height) {
    height = Math.max(panelMinHeight, rect.height - y);
    if (y + height > rect.height) y = Math.max(0, rect.height - height);
  }

  return { x, y, width, height };
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
      height = Math.max(start.minHeight, start.height + dy);
    }

    if (start.edge.includes('n')) {
      height = Math.max(start.minHeight, start.height - dy);
      y = start.y + (start.height - height);
    }

    return clampPreviewToWorkArea({ x, y, width, height }, start.minHeight);
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
  const minHeight = panelId === 'mixer' ? MIN_MIXER_PANEL_HEIGHT : MIN_PANEL_HEIGHT;
  machine.begin(panelId, mouseX, mouseY, { edge, x, y, width, height, minHeight });
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
