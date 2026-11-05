import { useSyncExternalStore } from 'react';
import { PANEL_TITLEBAR_HEIGHT, usePanelRegistry } from '../registry/PanelRegistry';
import type { DockRegion } from '../registry/PanelRegistry';
import { PANEL_CATALOG, isPanelId, type PanelId } from '../registry/panelCatalog';
import { beginPointerGesture, type PointerGestureSource } from './pointerGesture';

export type DragLifecycleState = 'idle' | 'dragging';

/**
 * Where the panel would land if the pointer were released now.
 * - `region`: a new slot at the edge of that dock region.
 * - `tab`:    joins the tab strip of an already-docked panel.
 * - `null`:   stays floating at the dragged position.
 */
export type DropTarget =
  | { kind: 'region'; region: DockRegion }
  | { kind: 'tab'; panelId: PanelId };

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
  currentDropTarget: DropTarget | null;
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

const TITLEBAR_HEIGHT = PANEL_TITLEBAR_HEIGHT;
const EDGE_SNAP_BAND = 40;
const SNAP_DWELL_MS = 150;
/** Pointer travel before a press on a drag handle becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

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
let detachGesture: (() => void) | null = null;
let registeredWorkAreaRect: WorkAreaRect = {
  left: -Infinity,
  top: -Infinity,
  right: Infinity,
  bottom: Infinity,
  width: Infinity,
  height: Infinity,
};
let currentDropTarget: DropTarget | null = null;
let snapDwellStart = 0;

function emitDragChange(): void {
  for (const listener of [...listeners]) listener();
}

function resetOffsetCache(): void {
  offsetCache.clear();
}

function unbindWindowListeners(): void {
  detachGesture?.();
  detachGesture = null;
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
  // Guard: skip the write if every coordinate is already identical, so a
  // re-measure that found nothing does not churn the registry.
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

/**
 * A docked panel under the pointer whose tab strip would accept the drag.
 *
 * Hit-tested against the live DOM rather than computed from stored geometry:
 * the dock regions are flex layouts whose on-screen extents only the browser
 * knows. The dragged frame carries `pointer-events: none` for the duration of
 * the drag (see .xleth-panel-frame.is-dragging), so it cannot shadow the
 * element underneath it.
 */
function findTabDropTarget(clientX: number, clientY: number, draggedId: PanelId): PanelId | null {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null;

  // Walk the whole hit stack and skip anything inside the panel being dragged.
  // The `is-dragging` class takes the dragged frame out of hit-testing, but only
  // after React commits — the first move after the drag starts would otherwise
  // hit-test against the dragged panel itself and find no drop zone. Skipping it
  // here makes the answer independent of render timing.
  const stack = typeof document.elementsFromPoint === 'function'
    ? document.elementsFromPoint(clientX, clientY)
    : [document.elementFromPoint(clientX, clientY)].filter(Boolean) as Element[];

  const draggedFrameSelector = `.xleth-panel-frame[data-panel-id="${draggedId}"]`;
  const element = stack.find((candidate) => !candidate.closest?.(draggedFrameSelector));
  if (!element) return null;

  const dropZone = element.closest?.('[data-tab-drop-target]');
  if (!dropZone) return null;

  const targetId = dropZone.getAttribute('data-tab-drop-target');
  if (!isPanelId(targetId) || targetId === draggedId) return null;
  // A drawer is not a window and has no tab strip to join.
  if (PANEL_CATALOG[targetId].presentation !== 'window') return null;

  const target = usePanelRegistry.getState().panels[targetId];
  if (target.hidden || target.mode !== 'docked') return null;
  return targetId;
}

function resolveDropTarget(
  clientX: number,
  clientY: number,
  draggedId: PanelId,
  workAreaRect: WorkAreaRect,
): DropTarget | null {
  // Tab targets win over edge bands. A dock region lives AT an edge, so its own
  // panels always sit inside the edge band — without this precedence you could
  // never drop a panel into the tab strip of an already-docked one.
  const tabTargetId = findTabDropTarget(clientX, clientY, draggedId);
  if (tabTargetId) return { kind: 'tab', panelId: tabTargetId };

  if (clientX - workAreaRect.left <= EDGE_SNAP_BAND) return { kind: 'region', region: 'left' };
  if (workAreaRect.right - clientX <= EDGE_SNAP_BAND) return { kind: 'region', region: 'right' };
  if (clientY - workAreaRect.top <= EDGE_SNAP_BAND) return { kind: 'region', region: 'top' };
  if (workAreaRect.bottom - clientY <= EDGE_SNAP_BAND) return { kind: 'region', region: 'bottom' };
  return null;
}

function dropTargetsEqual(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind === 'region' && b.kind === 'region') return a.region === b.region;
  if (a.kind === 'tab' && b.kind === 'tab') return a.panelId === b.panelId;
  return false;
}

/**
 * Arm a drag without starting one, and promote it only once the pointer has
 * actually travelled.
 *
 * Dragging a docked panel undocks it, so with no threshold a plain CLICK on a
 * dock tab or a docked titlebar tore the panel out of its slot before the click
 * handler ever ran — you could not select a tab without undocking it. The
 * threshold lives here rather than in beginDrag() because beginDrag is the
 * imperative "start dragging now" entry point, while this is an input-gesture
 * concern that belongs with the pointer plumbing.
 *
 * Capture is deliberately split across the two phases:
 *
 * - Before the threshold, NOTHING is captured. Capturing at pointerdown
 *   retargets the subsequent click, which would break click-to-select on a tab.
 *   Window listeners are enough while the pointer is still inside the window.
 *
 * - After promotion, the capture goes on the WORK AREA, never on the handle
 *   that was grabbed. Promotion undocks the panel, which re-parents it out of
 *   its dock region and into the floating layer; React unmounts the titlebar or
 *   tab that was pressed. A capture living on that node dies with it and takes
 *   every later pointer event — pointerup included — with it, stranding the
 *   drag with the snap ghost painted over the workspace until the window loses
 *   focus. The work area is mounted for the whole drag, so it cannot vanish
 *   mid-gesture.
 *
 * Detaching phase one releases no capture, so it cannot fire the
 * `lostpointercapture` that phase two would read as "the drag is over".
 */
function stableCaptureSource(source?: PointerGestureSource | null): PointerGestureSource | null {
  const element = source?.target ?? null;
  const pointerId = source?.pointerId ?? null;
  if (!element || pointerId === null) return null;
  const surface = element.closest?.('.xleth-app-workarea')
    ?? element.ownerDocument?.body
    ?? null;
  return surface ? { target: surface, pointerId } : null;
}

export function armPanelDrag(
  panelId: PanelId,
  mouseX: number,
  mouseY: number,
  panelX: number,
  panelY: number,
  source?: PointerGestureSource | null,
): void {
  let promoted = false;
  // target: null => listen, but do not capture. See the note above.
  const detach = beginPointerGesture({ target: null, pointerId: source?.pointerId ?? null }, {
    onMove: (x, y) => {
      if (promoted) return;
      if (Math.hypot(x - mouseX, y - mouseY) < DRAG_THRESHOLD_PX) return;
      promoted = true;
      detach();
      beginDrag(panelId, x, y, panelX, panelY, stableCaptureSource(source));
      // The move that crossed the threshold is still a move: run it through the
      // drag so the drop target is resolved from the very first frame.
      updateDrag(x, y);
    },
    // Released without travelling: that was a click. Leave the panel alone.
    onEnd: () => detach(),
    onCancel: () => detach(),
  });
}

/**
 * Enter the dragging state. Does not touch the pointer — the caller either owns
 * the gesture already (armPanelDrag) or attaches one itself (beginDrag).
 */
function startDrag(
  panelId: PanelId,
  mouseX: number,
  mouseY: number,
  panelX: number,
  panelY: number,
): void {
  const registry = usePanelRegistry.getState();
  const panel = registry.panels[panelId];
  let startX = panelX;
  let startY = panelY;
  if (panel.mode === 'docked') {
    // Convert viewport mouse coords to workspace-local using the registered work-area rect.
    const wLeft = Number.isFinite(registeredWorkAreaRect.left) ? registeredWorkAreaRect.left : 0;
    const wTop = Number.isFinite(registeredWorkAreaRect.top) ? registeredWorkAreaRect.top : 0;
    startX = mouseX - wLeft - panel.floating.width / 2;
    startY = mouseY - wTop - TITLEBAR_HEIGHT / 2;
    registry.undockPanel(panelId, startX, startY);
  }

  currentDropTarget = null;
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
    currentDropTarget: null,
  };
  resetOffsetCache();
  emitDragChange();
}

export function beginDrag(
  panelId: PanelId,
  mouseX: number,
  mouseY: number,
  panelX: number,
  panelY: number,
  source?: PointerGestureSource | null,
): void {
  unbindWindowListeners();
  // startDrag already published the new state; attaching listeners changes
  // nothing observable, so there is exactly one notification per drag start.
  startDrag(panelId, mouseX, mouseY, panelX, panelY);
  detachGesture = beginPointerGesture(source, {
    onMove: (x, y) => updateDrag(x, y),
    onEnd: endDrag,
    onCancel: cancelDrag,
  });
}

export function updateDrag(mouseX: number, mouseY: number): void {
  if (dragState.state !== 'dragging') return;

  const { workAreaRect, panelId } = dragState;
  const nextDropTarget = resolveDropTarget(mouseX, mouseY, panelId, workAreaRect);

  if (!dropTargetsEqual(nextDropTarget, currentDropTarget)) {
    currentDropTarget = nextDropTarget;
    snapDwellStart = nextDropTarget !== null ? Date.now() : 0;
  }

  dragState = {
    ...dragState,
    currentMouseX: mouseX,
    currentMouseY: mouseY,
    currentSnapTarget: currentDropTarget?.kind === 'region' ? currentDropTarget.region : null,
    currentDropTarget,
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
  const dropTarget = currentDropTarget;
  const dwell = Date.now() - snapDwellStart;
  dragState = idleDragState;
  resetOffsetCache();

  const registry = usePanelRegistry.getState();
  if (dropTarget?.kind === 'tab') {
    // A tab strip is an explicit target, not a proximity guess — no dwell.
    registry.dockPanelAsTab(activeDrag.panelId, dropTarget.panelId);
  } else if (dropTarget?.kind === 'region' && dwell >= SNAP_DWELL_MS) {
    registry.dockPanel(activeDrag.panelId, dropTarget.region);
  } else {
    registry.moveFloatingPanel(activeDrag.panelId, clampedX, clampedY);
  }

  currentDropTarget = null;
  snapDwellStart = 0;
  emitDragChange();
}

export function cancelDrag(): void {
  if (dragState.state !== 'dragging') return;
  unbindWindowListeners();
  dragState = idleDragState;
  resetOffsetCache();
  currentDropTarget = null;
  snapDwellStart = 0;
  emitDragChange();
}

export function getDragState(): DragState {
  return dragState;
}

export function getDragDropTarget(): DropTarget | null {
  return dragState.state === 'dragging' ? dragState.currentDropTarget : null;
}

export function isDraggingPanel(panelId: PanelId): boolean {
  return dragState.state === 'dragging' && dragState.panelId === panelId;
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

/** The panel whose tab strip would receive the drop, for drop-target styling. */
export function getTabDropTargetId(): PanelId | null {
  const target = getDragDropTarget();
  return target?.kind === 'tab' ? target.panelId : null;
}

export function useIsTabDropTarget(panelId: PanelId): boolean {
  return useSyncExternalStore(
    subscribeDrag,
    () => getTabDropTargetId() === panelId,
    () => false,
  );
}

export function useIsDragging(panelId: PanelId): boolean {
  return useSyncExternalStore(
    subscribeDrag,
    () => isDraggingPanel(panelId),
    () => false,
  );
}
