import {
  MIN_DOCK_REGION_SIZES,
  usePanelRegistry,
  type DockRegion,
} from '../registry/PanelRegistry';
import { createEdgeResizeMachine } from './EdgeResizeMachine';

export type DockRegionResizeAxis = 'horizontal' | 'vertical';

export interface DockRegionResizePreview {
  size: number;
}

interface DockRegionResizeStartBounds {
  region: DockRegion;
  axis: DockRegionResizeAxis;
  startSize: number;
}

const machine = createEdgeResizeMachine<DockRegion, DockRegionResizeStartBounds, DockRegionResizePreview>({
  name: 'dock-region-resize',
  arePreviewsEqual: (a, b) => a.size === b.size,
  computePreview: (start, dx, dy) => {
    const min = MIN_DOCK_REGION_SIZES[start.region];
    let next = start.startSize;
    if (start.region === 'left') next = start.startSize + dx;
    else if (start.region === 'right') next = start.startSize - dx;
    else if (start.region === 'top') next = start.startSize + dy;
    else if (start.region === 'bottom') next = start.startSize - dy;
    return { size: Math.max(min, next) };
  },
  commit: (region, preview) => {
    usePanelRegistry.getState().setDockRegionSize(region, preview.size);
  },
});

export function beginDockRegionResize(
  region: DockRegion,
  axis: DockRegionResizeAxis,
  mouseX: number,
  mouseY: number,
  startSize: number,
): void {
  machine.begin(region, mouseX, mouseY, { region, axis, startSize });
}

export function updateDockRegionResize(mouseX: number, mouseY: number): void {
  machine.update(mouseX, mouseY);
}

export function endDockRegionResize(): void {
  machine.end();
}

export function cancelDockRegionResize(): void {
  machine.cancel();
}

export function isDockRegionResizing(): boolean {
  return machine.isActive();
}

export function cancelDockRegionResizeIfActive(): boolean {
  return machine.cancelIfActive();
}

export function subscribeDockRegionResize(listener: () => void): () => void {
  return machine.subscribe(listener);
}

export function useDockRegionResizePreview(region: DockRegion): DockRegionResizePreview | null {
  return machine.usePreview(region);
}
