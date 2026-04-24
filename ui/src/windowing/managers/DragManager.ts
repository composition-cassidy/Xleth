import { useSyncExternalStore } from 'react';
import { usePanelRegistry } from '../registry/PanelRegistry';
import type { PanelId } from '../registry/panelCatalog';

export type DragLifecycleState = 'idle' | 'dragging';

export interface IdleDragState {
  state: 'idle';
  panelId: null;
  startMouseX: number;
  startMouseY: number;
  startPanelX: number;
  startPanelY: number;
  currentMouseX: number;
  currentMouseY: number;
}

export interface ActiveDragState {
  state: 'dragging';
  panelId: PanelId;
  startMouseX: number;
  startMouseY: number;
  startPanelX: number;
  startPanelY: number;
  currentMouseX: number;
  currentMouseY: number;
}

export type DragState = IdleDragState | ActiveDragState;

export interface DragOffset {
  dx: number;
  dy: number;
}

interface CachedDragOffset {
  dx: number;
  dy: number;
  value: DragOffset;
}

const idleDragState: IdleDragState = {
  state: 'idle',
  panelId: null,
  startMouseX: 0,
  startMouseY: 0,
  startPanelX: 0,
  startPanelY: 0,
  currentMouseX: 0,
  currentMouseY: 0,
};

let dragState: DragState = idleDragState;
const listeners = new Set<() => void>();
const offsetCache = new Map<PanelId, CachedDragOffset>();
let windowListenersBound = false;

function emitDragChange(): void {
  for (const listener of [...listeners]) listener();
}

function resetOffsetCache(): void {
  offsetCache.clear();
}

function onWindowMouseMove(event: MouseEvent): void {
  updateDrag(event.clientX, event.clientY);
}

function onWindowMouseUp(): void {
  endDrag();
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

function getDragOffsetSnapshot(panelId: PanelId): DragOffset | null {
  if (dragState.state !== 'dragging' || dragState.panelId !== panelId) return null;

  const dx = dragState.currentMouseX - dragState.startMouseX;
  const dy = dragState.currentMouseY - dragState.startMouseY;
  const cached = offsetCache.get(panelId);
  if (cached && cached.dx === dx && cached.dy === dy) return cached.value;

  const value = { dx, dy };
  offsetCache.set(panelId, { dx, dy, value });
  return value;
}

export function beginDrag(
  panelId: PanelId,
  mouseX: number,
  mouseY: number,
  panelX: number,
  panelY: number,
): void {
  unbindWindowListeners();
  dragState = {
    state: 'dragging',
    panelId,
    startMouseX: mouseX,
    startMouseY: mouseY,
    startPanelX: panelX,
    startPanelY: panelY,
    currentMouseX: mouseX,
    currentMouseY: mouseY,
  };
  resetOffsetCache();
  bindWindowListeners();
  emitDragChange();
}

export function updateDrag(mouseX: number, mouseY: number): void {
  if (dragState.state !== 'dragging') return;
  dragState = {
    ...dragState,
    currentMouseX: mouseX,
    currentMouseY: mouseY,
  };
  resetOffsetCache();
  emitDragChange();
}

export function endDrag(): void {
  if (dragState.state !== 'dragging') return;

  const activeDrag = dragState;
  const finalX = activeDrag.startPanelX + (activeDrag.currentMouseX - activeDrag.startMouseX);
  const finalY = activeDrag.startPanelY + (activeDrag.currentMouseY - activeDrag.startMouseY);

  unbindWindowListeners();
  dragState = idleDragState;
  resetOffsetCache();
  usePanelRegistry.getState().moveFloatingPanel(activeDrag.panelId, finalX, finalY);
  emitDragChange();
}

export function cancelDrag(): void {
  if (dragState.state !== 'dragging') return;
  unbindWindowListeners();
  dragState = idleDragState;
  resetOffsetCache();
  emitDragChange();
}

export function getDragState(): DragState {
  return dragState;
}

export function subscribeDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDragOffset(panelId: PanelId): DragOffset | null {
  return useSyncExternalStore(
    subscribeDrag,
    () => getDragOffsetSnapshot(panelId),
    () => getDragOffsetSnapshot(panelId),
  );
}
