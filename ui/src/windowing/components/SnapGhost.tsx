import React from 'react';
import type { CSSProperties } from 'react';
import { useSyncExternalStore } from 'react';
import { getDragState, subscribeDrag } from '../managers/DragManager';
import type { DockRegion } from '../registry/PanelRegistry';

function getSnapTarget(): DockRegion | null {
  const state = getDragState();
  return state.state === 'dragging' ? state.currentSnapTarget : null;
}

const GHOST_STYLE: Record<NonNullable<DockRegion>, CSSProperties> = {
  left: { left: 0, top: 0, height: '100%', width: '320px' },
  right: { right: 0, top: 0, height: '100%', width: '320px' },
  top: { top: 0, left: 0, width: '100%', height: '280px' },
  bottom: { bottom: 0, left: 0, width: '100%', height: '280px' },
};

export function SnapGhost() {
  const snapTarget = useSyncExternalStore(subscribeDrag, getSnapTarget, getSnapTarget);

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
        zIndex: 9999,
        ...GHOST_STYLE[snapTarget],
      } as CSSProperties}
    />
  );
}

export default SnapGhost;
