import React from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import {
  beginDockedPanelResize,
  useDockedPanelResizePreview,
  type DockedPanelResizeAxis,
} from '../managers/DockedPanelResizeManager';
import { getRegisteredWorkAreaRect } from '../managers/DragManager';
import { useDockRegionResizePreview } from '../managers/DockRegionResizeManager';
import { PANEL_CATALOG, PANEL_IDS, type PanelId } from '../registry/panelCatalog';
import { usePanelRegistry, type DockRegion as DockRegionSide, type PanelStateMap } from '../registry/PanelRegistry';
import { DockRegionResizer } from './DockRegionResizer';
import { PanelFrame } from './PanelFrame';

export interface DockRegionProps {
  side: DockRegionSide;
  renderPanel?: (id: PanelId) => ReactNode;
  excludePanelIds?: readonly PanelId[];
}

const EMPTY_PANEL_IDS: readonly PanelId[] = Object.freeze([]);

function DockTestBody({ label }: { label: string }) {
  return (
    <div className="xleth-windowing-test-panel">
      <div className="xleth-windowing-test-panel__header">{label}</div>
    </div>
  );
}

function dockedPanelKey(side: DockRegionSide, excludePanelIds: readonly PanelId[], panels: PanelStateMap): string {
  const excluded = new Set(excludePanelIds);
  return PANEL_IDS
    .filter((id) => (
      !excluded.has(id)
      && !panels[id].hidden
      && panels[id].mode === 'docked'
      && panels[id].docked.region === side
    ))
    .sort((a, b) => panels[a].docked.orderInRegion - panels[b].docked.orderInRegion)
    .map((id) => `${id}:${panels[id].docked.sizeInRegion}`)
    .join('|');
}

interface DockedPanelEntry {
  id: PanelId;
  size: number;
}

function parseDockedPanelKey(key: string): DockedPanelEntry[] {
  if (key === '') return [];
  return key.split('|').map((entry) => {
    const [id, size] = entry.split(':');
    return { id: id as PanelId, size: Number(size) };
  });
}

function axisForRegion(side: DockRegionSide): DockedPanelResizeAxis {
  return side === 'top' || side === 'bottom' ? 'horizontal' : 'vertical';
}

function localAxisCoordinate(rect: DOMRect, regionRect: DOMRect, axis: DockedPanelResizeAxis, edge: 'start' | 'end'): number {
  if (axis === 'horizontal') {
    return (edge === 'start' ? rect.left : rect.right) - regionRect.left;
  }
  return (edge === 'start' ? rect.top : rect.bottom) - regionRect.top;
}

function collectSnapTargets(
  regionElement: HTMLElement,
  axis: DockedPanelResizeAxis,
  startSplitterPosition: number,
): number[] {
  const regionRect = regionElement.getBoundingClientRect();
  const targets: number[] = [];
  const addTarget = (value: number) => {
    if (!Number.isFinite(value)) return;
    if (Math.abs(value - startSplitterPosition) <= 1) return;
    targets.push(Math.round(value));
  };
  const addRect = (rect: DOMRect) => {
    addTarget(localAxisCoordinate(rect, regionRect, axis, 'start'));
    addTarget(localAxisCoordinate(rect, regionRect, axis, 'end'));
  };

  const workArea = getRegisteredWorkAreaRect();
  if (axis === 'horizontal') {
    addTarget(workArea.left - regionRect.left);
    addTarget(workArea.right - regionRect.left);
  } else {
    addTarget(workArea.top - regionRect.top);
    addTarget(workArea.bottom - regionRect.top);
  }

  const root = regionElement.ownerDocument;
  root.querySelectorAll<HTMLElement>('.xleth-docked-panel-slot, .xleth-floating-window-layer > .xleth-panel-frame')
    .forEach((element) => addRect(element.getBoundingClientRect()));

  return Array.from(new Set(targets));
}

interface DockedPanelSplitterProps {
  region: DockRegionSide;
  beforeId: PanelId;
  afterId: PanelId;
  active: boolean;
}

function DockedPanelSplitter({
  region,
  beforeId,
  afterId,
  active,
}: DockedPanelSplitterProps) {
  const axis = axisForRegion(region);

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const regionElement = event.currentTarget.closest<HTMLElement>('.xleth-dock-region');
    const beforeSlot = regionElement?.querySelector<HTMLElement>(`[data-docked-slot-id="${beforeId}"]`);
    const afterSlot = regionElement?.querySelector<HTMLElement>(`[data-docked-slot-id="${afterId}"]`);
    if (!regionElement || !beforeSlot || !afterSlot) return;

    event.preventDefault();
    const regionRect = regionElement.getBoundingClientRect();
    const beforeRect = beforeSlot.getBoundingClientRect();
    const afterRect = afterSlot.getBoundingClientRect();
    // Measure the live rendered extent of each slot so the drag tracks the cursor
    // 1:1 and clamps against real geometry. The last docked slot flex-grows to
    // fill the region, so its stored sizeInRegion does not reflect its on-screen
    // size — only the measured rect does.
    const measuredBefore = Math.round(axis === 'horizontal' ? beforeRect.width : beforeRect.height);
    const measuredAfter = Math.round(axis === 'horizontal' ? afterRect.width : afterRect.height);
    const startSplitterPosition = axis === 'horizontal'
      ? beforeRect.right - regionRect.left
      : beforeRect.bottom - regionRect.top;

    beginDockedPanelResize(
      event.clientX,
      event.clientY,
      {
        region,
        axis,
        beforeId,
        afterId,
        beforeSize: measuredBefore,
        afterSize: measuredAfter,
        startSplitterPosition,
        snapTargets: collectSnapTargets(regionElement, axis, startSplitterPosition),
      },
      {
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      },
    );
  };

  return (
    <div
      className={`xleth-dock-splitter xleth-dock-splitter--${axis}`}
      data-testid={`xleth-dock-splitter-${beforeId}-${afterId}`}
      data-before-panel-id={beforeId}
      data-after-panel-id={afterId}
      data-active={active ? 'true' : 'false'}
      onMouseDown={handleMouseDown}
      aria-hidden="true"
    />
  );
}

export function DockRegion({ side, renderPanel, excludePanelIds = EMPTY_PANEL_IDS }: DockRegionProps) {
  const reactiveDockedPanelKey = usePanelRegistry((state) => dockedPanelKey(side, excludePanelIds, state.panels));
  const reactiveSize = usePanelRegistry((state) => state.dockRegionSizes[side]);
  const isSSR = typeof window === 'undefined';
  const dockedKey = isSSR ? dockedPanelKey(side, excludePanelIds, usePanelRegistry.getState().panels) : reactiveDockedPanelKey;
  const committedSize = isSSR ? usePanelRegistry.getState().dockRegionSizes[side] : reactiveSize;
  const preview = useDockRegionResizePreview(side);
  const splitterPreview = useDockedPanelResizePreview(side);
  const effectiveSize = preview?.size ?? committedSize;
  const docked = parseDockedPanelKey(dockedKey);

  if (docked.length === 0) return null;

  const sizeStyle: CSSProperties = (side === 'left' || side === 'right')
    ? { width: `${effectiveSize}px` }
    : { height: `${effectiveSize}px` };

  return (
    <div
      className={`xleth-dock-region xleth-dock-region--${side}`}
      data-region={side}
      style={sizeStyle}
    >
      {docked.map((entry, index) => {
        const liveSize = splitterPreview?.beforeId === entry.id
          ? splitterPreview.beforeSize
          : splitterPreview?.afterId === entry.id
            ? splitterPreview.afterSize
            : entry.size;
        const next = docked[index + 1];
        const isLast = next === undefined;
        const slotClassName = isLast
          ? 'xleth-docked-panel-slot xleth-docked-panel-slot--fill'
          : 'xleth-docked-panel-slot';

        return (
          <React.Fragment key={entry.id}>
            <div
              className={slotClassName}
              data-docked-slot-id={entry.id}
              style={{ '--xleth-docked-panel-size': `${liveSize}px` } as CSSProperties}
            >
              {renderPanel ? (
                renderPanel(entry.id)
              ) : (
                <PanelFrame id={entry.id}>
                  <DockTestBody label={PANEL_CATALOG[entry.id].title} />
                </PanelFrame>
              )}
            </div>
            {next ? (
              <DockedPanelSplitter
                region={side}
                beforeId={entry.id}
                afterId={next.id}
                active={splitterPreview?.beforeId === entry.id && splitterPreview.afterId === next.id}
              />
            ) : null}
          </React.Fragment>
        )
      })}
      <DockRegionResizer region={side} currentSize={committedSize} />
    </div>
  );
}

export default DockRegion;
