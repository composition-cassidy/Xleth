import { useSyncExternalStore } from 'react';
import { usePanelRegistry } from '../registry/PanelRegistry';
import type { PanelId } from '../registry/panelCatalog';

export const MIN_PANEL_WIDTH = 280;
export const MIN_PANEL_HEIGHT = 120;

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface ResizePreview {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ResizeCoordinates {
  startMouseX: number;
  startMouseY: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  currentMouseX: number;
  currentMouseY: number;
}

export type ResizeState =
  | ({ state: 'idle'; panelId: null; edge: null } & ResizeCoordinates)
  | ({ state: 'resizing'; panelId: PanelId; edge: ResizeEdge } & ResizeCoordinates);

const idleResizeState: ResizeState = {
  state: 'idle',
  panelId: null,
  edge: null,
  startMouseX: 0,
  startMouseY: 0,
  startX: 0,
  startY: 0,
  startWidth: 0,
  startHeight: 0,
  currentMouseX: 0,
  currentMouseY: 0,
};

let resizeState: ResizeState = idleResizeState;
const listeners = new Set<() => void>();
const previewCache = new Map<PanelId, ResizePreview & { value: ResizePreview }>();
let windowListenersBound = false;

function emitResizeChange(): void {
  for (const listener of [...listeners]) listener();
}

function resetPreviewCache(): void {
  previewCache.clear();
}

function onWindowMouseMove(event: MouseEvent): void {
  updateResize(event.clientX, event.clientY);
}

function onWindowMouseUp(): void {
  endResize();
}

function bindWindowListeners(): void {
  if (windowListenersBound || typeof window === 'undefined') return;
  window.addEventListener('mousemove', onWindowMouseMove);
  window.addEventListener('mouseup', onWindowMouseUp);
  windowListenersBound = true;
}

function unbindWindowListeners(): void {
  if (!windowListenersBound || typeof window === 'undefined') return;
  window.removeEventListener('mousemove', onWindowMouseMove);
  window.removeEventListener('mouseup', onWindowMouseUp);
  windowListenersBound = false;
}

function computeResizePreview(activeResize: Extract<ResizeState, { state: 'resizing' }>): ResizePreview {
  const dx = activeResize.currentMouseX - activeResize.startMouseX;
  const dy = activeResize.currentMouseY - activeResize.startMouseY;
  let x = activeResize.startX;
  let y = activeResize.startY;
  let width = activeResize.startWidth;
  let height = activeResize.startHeight;

  if (activeResize.edge.includes('e')) {
    width = Math.max(MIN_PANEL_WIDTH, activeResize.startWidth + dx);
  }

  if (activeResize.edge.includes('w')) {
    width = Math.max(MIN_PANEL_WIDTH, activeResize.startWidth - dx);
    x = activeResize.startX + (activeResize.startWidth - width);
  }

  if (activeResize.edge.includes('s')) {
    height = Math.max(MIN_PANEL_HEIGHT, activeResize.startHeight + dy);
  }

  if (activeResize.edge.includes('n')) {
    height = Math.max(MIN_PANEL_HEIGHT, activeResize.startHeight - dy);
    y = activeResize.startY + (activeResize.startHeight - height);
  }

  return { x, y, width, height };
}

function getResizePreviewSnapshot(panelId: PanelId): ResizePreview | null {
  if (resizeState.state !== 'resizing' || resizeState.panelId !== panelId) return null;

  const next = computeResizePreview(resizeState);
  const cached = previewCache.get(panelId);
  if (
    cached
    && cached.x === next.x
    && cached.y === next.y
    && cached.width === next.width
    && cached.height === next.height
  ) {
    return cached.value;
  }

  previewCache.set(panelId, { ...next, value: next });
  return next;
}

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
  unbindWindowListeners();
  resizeState = {
    state: 'resizing',
    panelId,
    edge,
    startMouseX: mouseX,
    startMouseY: mouseY,
    startX: x,
    startY: y,
    startWidth: width,
    startHeight: height,
    currentMouseX: mouseX,
    currentMouseY: mouseY,
  };
  resetPreviewCache();
  bindWindowListeners();
  emitResizeChange();
}

export function updateResize(mouseX: number, mouseY: number): void {
  if (resizeState.state !== 'resizing') return;
  resizeState = {
    ...resizeState,
    currentMouseX: mouseX,
    currentMouseY: mouseY,
  };
  resetPreviewCache();
  emitResizeChange();
}

export function endResize(): void {
  if (resizeState.state !== 'resizing') return;

  const activeResize = resizeState;
  const finalBounds = computeResizePreview(activeResize);

  unbindWindowListeners();
  resizeState = idleResizeState;
  resetPreviewCache();
  usePanelRegistry.getState().resizeFloatingPanel(
    activeResize.panelId,
    finalBounds.x,
    finalBounds.y,
    finalBounds.width,
    finalBounds.height,
  );
  emitResizeChange();
}

export function cancelResize(): void {
  if (resizeState.state !== 'resizing') return;
  unbindWindowListeners();
  resizeState = idleResizeState;
  resetPreviewCache();
  emitResizeChange();
}

export function subscribeResize(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useResizePreview(panelId: PanelId): ResizePreview | null {
  return useSyncExternalStore(
    subscribeResize,
    () => getResizePreviewSnapshot(panelId),
    () => getResizePreviewSnapshot(panelId),
  );
}
