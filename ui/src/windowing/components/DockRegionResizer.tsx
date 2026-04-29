import React, { useSyncExternalStore } from 'react';
import type { MouseEvent } from 'react';
import {
  beginDockRegionResize,
  isDockRegionResizing,
  subscribeDockRegionResize,
  useDockRegionResizePreview,
} from '../managers/DockRegionResizeManager';
import type { DockRegion as DockRegionSide } from '../registry/PanelRegistry';
import './windowing.css';

export interface DockRegionResizerProps {
  region: DockRegionSide;
  currentSize: number;
}

export function DockRegionResizer({ region, currentSize }: DockRegionResizerProps) {
  const axis = (region === 'left' || region === 'right') ? 'horizontal' : 'vertical';
  const preview = useDockRegionResizePreview(region);
  const active = useSyncExternalStore(
    subscribeDockRegionResize,
    () => preview !== null && isDockRegionResizing(),
    () => false,
  );

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    beginDockRegionResize(region, axis, event.clientX, event.clientY, currentSize);
  };

  return (
    <div
      className={`xleth-dock-region-resizer xleth-dock-region-resizer--${region}`}
      data-testid={`xleth-dock-region-resizer-${region}`}
      data-region={region}
      data-active={active ? 'true' : 'false'}
      onMouseDown={handleMouseDown}
      aria-hidden="true"
    />
  );
}

export default DockRegionResizer;
