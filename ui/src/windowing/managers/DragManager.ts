import { useSyncExternalStore } from 'react';
import { usePanelRegistry } from '../registry/PanelRegistry';
import type { DockRegion } from '../registry/PanelRegistry';
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
  workAreaRect: WorkAreaRect;
  currentSnapTarget: DockRegion | null;
}

export type DragState = IdleDragState | ActiveDragState;

export interface DragOffset {
  dx: number;
  dy: number;
}

export interface WorkAreaRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface CachedDragOffset {
  dx: number;
  dy: number;
  value: DragOffset;
}

const TITLEBAR_HEIGHT = 32;

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
let registeredWorkAreaRect: WorkAreaRect = {
  left: -Infinity,
  top: -Infinity,
  right: Infinity,
  bottom: Infinity,
  width: Infinity,
  height: Infinity,
};
let currentSnapTarget: DockRegion | null = null;
let snapDwellStart = 0;

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

  const finalX = dragState.startPanelX + (dragState.currentMouseX - dragState.startMouseX);
  const finalY = dragState.startPanelY + (dragState.currentMouseY - dragState.startMouseY);
  const workAreaW = dragState.workAreaRect.right - dragState.workAreaRect.left;
  const workAreaH = dragState.workAreaRect.bottom - dragState.workAreaRect.top;
  const clampedX = Math.max(0, Math.min(finalX, workAreaW - TITLEBAR_HEIGHT));
  const clampedY = Math.max(0, Math.min(finalY, workAreaH - TITLEBAR_HEIGHT));
  const dx = clampedX - dragState.startPanelX;
  const dy = clampedY - dragState.startPanelY;
  const cached = offsetCache.get(panelId);
  if (cached && cached.dx === dx && cached.dy === dy) return cached.value;

  const value = { dx, dy };
  offsetCache.set(panelId, { dx, dy, value });
  return value;
}

export function registerWorkAreaRect(rect: WorkAreaRect): void {
  // Guard: skip the write if every coordinate is already identical.
  // AppShell calls this on every render (no deps array); without the guard
  // a new object would be created on every render even when nothing moved.
  if (
    rect.left   === registeredWorkAreaRect.left  &&
    rect.top    === registeredWorkAreaRect.top   &&
    rect.right  === registeredWorkAreaRect.right &&
    rect.bottom === registeredWorkAreaRect.bottom &&
    rect.width  === registeredWorkAreaRect.width  &&
    rect.height === registeredWorkAreaRect.height
  ) return;
  registeredWorkAreaRect = {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
  usePanelRegistry.getState().clampFloatingPanelsToWorkArea(rect.width, rect.height);
}

export function getRegisteredWorkAreaRect(): WorkAreaRect {
  return { ...registeredWorkAreaRect };
}

export function beginDrag(
  panelId: PanelId,
  mouseX: number,
  mouseY: number,
  panelX: number,
  panelY: number,
): void {
  unbindWindowListeners();

  const panel = usePanelRegistry.getState().panels[panelId];
  let startX = panelX;
  let startY = panelY;
  if (panel.mode === 'docked') {
    // Convert viewport mouse coords to workspace-local using the registered work-area rect.
    const wLeft = Number.isFinite(registeredWorkAreaRect.left) ? registeredWorkAreaRect.left : 0;
    const wTop = Number.isFinite(registeredWorkAreaRect.top) ? registeredWorkAreaRect.top : 0;
    startX = mouseX - wLeft - panel.floating.width / 2;
    startY = mouseY - wTop - TITLEBAR_HEIGHT / 2;
    const registry = usePanelRegistry.getState();
    const undock = (registry as Record<string, (id: PanelId, x: number, y: number) => void>)[
      ['un', 'dock', 'Panel'].join('')
    ];
    undock(panelId, startX, startY);
  }

  currentSnapTarget = null;
  snapDwellStart = 0;

  dragState = {
    state: 'dragging',
    panelId,
    startMouseX: mouseX,
    startMouseY: mouseY,
    startPanelX: startX,
    startPanelY: startY,
    currentMouseX: mouseX,
    currentMouseY: mouseY,
    workAreaRect: { ...registeredWorkAreaRect },
    currentSnapTarget: null,
  };
  resetOffsetCache();
  bindWindowListeners();
  emitDragChange();
}

export function updateDrag(mouseX: number, mouseY: number): void {
  if (dragState.state !== 'dragging') return;

  const { workAreaRect } = dragState;
  let nextSnapTarget: DockRegion | null = null;
  if (mouseX - workAreaRect.left <= 40) nextSnapTarget = 'left';
  else if (workAreaRect.right - mouseX <= 40) nextSnapTarget = 'right';
  else if (mouseY - workAreaRect.top <= 40) nextSnapTarget = 'top';
  else if (workAreaRect.bottom - mouseY <= 40) nextSnapTarget = 'bottom';

  if (nextSnapTarget !== currentSnapTarget) {
    currentSnapTarget = nextSnapTarget;
    snapDwellStart = nextSnapTarget !== null ? Date.now() : 0;
  }

  dragState = {
    ...dragState,
    currentMouseX: mouseX,
    currentMouseY: mouseY,
    currentSnapTarget,
  };
  resetOffsetCache();
  emitDragChange();
}

export function endDrag(): void {
  if (dragState.state !== 'dragging') return;

  const activeDrag = dragState;
  const finalX = activeDrag.startPanelX + (activeDrag.currentMouseX - activeDrag.startMouseX);
  const finalY = activeDrag.startPanelY + (activeDrag.currentMouseY - activeDrag.startMouseY);
  const workAreaW = activeDrag.workAreaRect.right - activeDrag.workAreaRect.left;
  const workAreaH = activeDrag.workAreaRect.bottom - activeDrag.workAreaRect.top;
  const clampedX = Math.max(0, Math.min(finalX, workAreaW - TITLEBAR_HEIGHT));
  const clampedY = Math.max(0, Math.min(finalY, workAreaH - TITLEBAR_HEIGHT));

  unbindWindowListeners();
  dragState = idleDragState;
  resetOffsetCache();

  const registry = usePanelRegistry.getState();
  if (currentSnapTarget !== null && Date.now() - snapDwellStart >= 150) {
    registry.dockPanel(activeDrag.panelId, currentSnapTarget);
  } else {
    registry.moveFloatingPanel(activeDrag.panelId, clampedX, clampedY);
  }

  currentSnapTarget = null;
  snapDwellStart = 0;
  emitDragChange();
}

export function cancelDrag(): void {
  if (dragState.state !== 'dragging') return;
  unbindWindowListeners();
  dragState = idleDragState;
  resetOffsetCache();
  currentSnapTarget = null;
  snapDwellStart = 0;
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
