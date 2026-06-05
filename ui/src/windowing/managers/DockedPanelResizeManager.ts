import {
  MIN_DOCKED_PANEL_MAIN_SIZES,
  usePanelRegistry,
  type DockRegion,
} from '../registry/PanelRegistry';
import type { PanelId } from '../registry/panelCatalog';
import { createEdgeResizeMachine, type ResizePointerMeta } from './EdgeResizeMachine';
import { snapDockSplitterPosition } from './dockedPanelSnapping';

export type DockedPanelResizeAxis = 'horizontal' | 'vertical';

export interface DockedPanelResizePreview {
  beforeId: PanelId;
  afterId: PanelId;
  beforeSize: number;
  afterSize: number;
  snapped: boolean;
  snapTarget: number | null;
}

export interface DockedPanelResizeStartBounds {
  region: DockRegion;
  axis: DockedPanelResizeAxis;
  beforeId: PanelId;
  afterId: PanelId;
  beforeSize: number;
  afterSize: number;
  startSplitterPosition: number;
  snapTargets: readonly number[];
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function clampPairSizes(start: DockedPanelResizeStartBounds, splitterPosition: number) {
  const beforeMin = MIN_DOCKED_PANEL_MAIN_SIZES[start.beforeId];
  const afterMin = MIN_DOCKED_PANEL_MAIN_SIZES[start.afterId];
  const total = Math.max(beforeMin + afterMin, start.beforeSize + start.afterSize);
  const delta = splitterPosition - start.startSplitterPosition;
  const beforeSize = clamp(start.beforeSize + delta, beforeMin, total - afterMin);
  return {
    beforeSize: Math.round(beforeSize),
    afterSize: Math.round(total - beforeSize),
  };
}

function validSnapTargets(start: DockedPanelResizeStartBounds): number[] {
  const beforeMin = MIN_DOCKED_PANEL_MAIN_SIZES[start.beforeId];
  const afterMin = MIN_DOCKED_PANEL_MAIN_SIZES[start.afterId];
  const minPosition = start.startSplitterPosition - start.beforeSize + beforeMin;
  const maxPosition = start.startSplitterPosition + start.afterSize - afterMin;
  return start.snapTargets.filter((target) => target >= minPosition && target <= maxPosition);
}

const machine = createEdgeResizeMachine<DockRegion, DockedPanelResizeStartBounds, DockedPanelResizePreview>({
  name: 'docked-panel-resize',
  arePreviewsEqual: (a, b) => (
    a.beforeId === b.beforeId
    && a.afterId === b.afterId
    && a.beforeSize === b.beforeSize
    && a.afterSize === b.afterSize
    && a.snapped === b.snapped
    && a.snapTarget === b.snapTarget
  ),
  computePreview: (start, dx, dy, meta: ResizePointerMeta) => {
    const delta = start.axis === 'horizontal' ? dx : dy;
    const rawPosition = start.startSplitterPosition + delta;
    const snap = snapDockSplitterPosition({
      rawPosition,
      targets: validSnapTargets(start),
      disabled: meta.altKey,
    });
    const sizes = clampPairSizes(start, snap.position);

    return {
      beforeId: start.beforeId,
      afterId: start.afterId,
      beforeSize: sizes.beforeSize,
      afterSize: sizes.afterSize,
      snapped: snap.snapped,
      snapTarget: snap.target,
    };
  },
  commit: (region, preview) => {
    usePanelRegistry.getState().resizeDockedPanelPair(
      region,
      preview.beforeId,
      preview.beforeSize,
      preview.afterId,
      preview.afterSize,
    );
  },
});

export function beginDockedPanelResize(
  mouseX: number,
  mouseY: number,
  start: DockedPanelResizeStartBounds,
  meta?: Partial<ResizePointerMeta>,
): void {
  machine.begin(start.region, mouseX, mouseY, start, meta);
}

export function updateDockedPanelResize(
  mouseX: number,
  mouseY: number,
  meta?: Partial<ResizePointerMeta>,
): void {
  machine.update(mouseX, mouseY, meta);
}

export function endDockedPanelResize(): void {
  machine.end();
}

export function cancelDockedPanelResize(): void {
  machine.cancel();
}

export function isDockedPanelResizing(): boolean {
  return machine.isActive();
}

export function cancelDockedPanelResizeIfActive(): boolean {
  return machine.cancelIfActive();
}

export function subscribeDockedPanelResize(listener: () => void): () => void {
  return machine.subscribe(listener);
}

export function useDockedPanelResizePreview(region: DockRegion): DockedPanelResizePreview | null {
  return machine.usePreview(region);
}
