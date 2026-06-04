import React from 'react';
import type { CSSProperties } from 'react';
import { useSyncExternalStore } from 'react';
import { getDragState, subscribeDrag } from '../managers/DragManager';
import { usePanelRegistry, type DockRegion } from '../registry/PanelRegistry';

function getSnapTarget(): DockRegion | null {
  const state = getDragState();
  return state.state === 'dragging' ? state.currentSnapTarget : null;
}

function ghostStyleFor(side: DockRegion, size: number): CSSProperties {
  const px = `${size}px`;
  switch (side) {
    case 'left':
      return { left: 0, top: 0, height: '100%', width: px };
    case 'right':
      return { right: 0, top: 0, height: '100%', width: px };
    case 'top':
      return { top: 0, left: 0, width: '100%', height: px };
    case 'bottom':
    default:
      return { bottom: 0, left: 0, width: '100%', height: px };
  }
}

export function SnapGhost() {
  const snapTarget = useSyncExternalStore(subscribeDrag, getSnapTarget, getSnapTarget);
  const reactiveSize = usePanelRegistry((state) => (
    snapTarget !== null ? state.dockRegionSizes[snapTarget] : 0
  ));

  if (!snapTarget) return null;

  return (
    <div
      className="xleth-snap-ghost"
      data-snap-target={snapTarget}
      style={{
        position: 'absolute',
        pointerEvents: 'none',
        background: 'color-mix(in srgb, var(--theme-accent) 18%, transparent)',
        border: '2px solid var(--theme-accent)',
        boxSizing: 'border-box',
        ...ghostStyleFor(snapTarget, reactiveSize),
      } as CSSProperties}
    />
  );
}

export default SnapGhost;
